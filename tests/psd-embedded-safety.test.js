const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { promisify: nodePromisify } = require('util');
const { createAutomaticPackageReviewCaller } = require('./package-review-ipc-helper');
const {
  EDGE_TYPES,
  NODE_TYPES,
  createNodeId,
} = require('../provenance');

const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;
const originalSetInterval = global.setInterval;
const originalClearInterval = global.clearInterval;
const originalHomedir = os.homedir;
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-psd-safety-home-'));
const TEST_USER_DATA = path.join(TEST_HOME, 'user-data');
const activeTimeouts = new Set();
const activeIntervals = new Set();

fs.mkdirSync(TEST_USER_DATA, { recursive: true, mode: 0o700 });
os.homedir = () => TEST_HOME;

global.setInterval = function trackedSetInterval(fn, delay, ...args) {
  const timer = originalSetInterval(fn, delay, ...args);
  activeIntervals.add(timer);
  return timer;
};

global.clearInterval = function trackedClearInterval(timer) {
  activeIntervals.delete(timer);
  return originalClearInterval(timer);
};

global.setTimeout = function trackedSetTimeout(fn, delay, ...args) {
  let timer;
  const wrapped = (...wrappedArgs) => {
    activeTimeouts.delete(timer);
    return fn(...wrappedArgs);
  };
  timer = originalSetTimeout(wrapped, delay, ...args);
  activeTimeouts.add(timer);
  return timer;
};

global.clearTimeout = function trackedClearTimeout(timer) {
  activeTimeouts.delete(timer);
  return originalClearTimeout(timer);
};

function clearTrackedTimeouts() {
  for (const timer of [...activeTimeouts]) {
    global.clearTimeout(timer);
  }
}

function clearTrackedIntervals() {
  for (const timer of [...activeIntervals]) {
    global.clearInterval(timer);
  }
}

const STUBS = new Map();

function setStub(name, factory) {
  STUBS.set(name, factory);
}

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function patchedResolve(request, parent, ...rest) {
  if (STUBS.has(request)) {
    return `\0stub:${request}`;
  }
  return originalResolve.call(this, request, parent, ...rest);
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, ...rest) {
  if (STUBS.has(request)) {
    return STUBS.get(request)();
  }
  return originalLoad.call(this, request, parent, ...rest);
};

const ipcHandlers = new Map();
const psdWorkerChildren = new Set();
function forkPsdWorkerForTest(modulePath) {
  const child = originalLoad.call(Module, 'node:child_process', module).fork(modulePath, [], {
    serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  child.postMessage = message => child.send(message);
  // Model Electron's exact backing for decoded Node advanced-IPC byte views;
  // parser/coordinator/admission code remains the production implementation.
  child.on('message', message => { if (message.bytes) message.bytes = new Uint8Array(message.bytes); });
  psdWorkerChildren.add(child);
  child.once('exit', () => psdWorkerChildren.delete(child));
  return child;
}
const trustedRendererMainFrame = {
  url: pathToFileURL(path.resolve(__dirname, '..', 'renderer', 'index.html')).href,
};
const trustedRendererWindow = {
  handlers: new Map(),
  isDestroyed: () => false,
  isVisible: () => true,
  isMinimized: () => false,
  restore: () => {},
  show: () => {},
  focus: () => {},
  moveTop: () => {},
  setFocusable: () => {},
  setIgnoreMouseEvents: () => {},
  on(channel, fn) { this.handlers.set(channel, fn); },
  once(channel, fn) { this.handlers.set(channel, fn); },
  loadFile: () => Promise.resolve(),
  webContents: {
    handlers: new Map(),
    mainFrame: trustedRendererMainFrame,
    send: () => {},
    on(channel, fn) { this.handlers.set(channel, fn); },
    once(channel, fn) { this.handlers.set(channel, fn); },
    setWindowOpenHandler(fn) { this.windowOpenHandler = fn; },
  },
};

class TestBrowserWindow {
  static fromWebContents(webContents) {
    return webContents === trustedRendererWindow.webContents ? trustedRendererWindow : null;
  }
  constructor() { return trustedRendererWindow; }
  loadFile() {}
  on() {}
  isDestroyed() { return true; }
  isVisible() { return false; }
  getBounds() { return { width: 360, height: 620 }; }
  setPosition() {}
  show() {}
  focus() {}
  hide() {}
  destroy() {}
}

class TestNotification {
  static isSupported() { return false; }
  show() {}
  on() {}
}

setStub('electron', () => ({
  app: {
    requestSingleInstanceLock: () => true,
    quit: () => {},
    whenReady: () => ({ then: (fn) => { fn(); } }),
    on: () => {},
    isReady: () => true,
    show: () => {},
    focus: () => {},
    getPath: () => TEST_USER_DATA,
    dock: { setMenu: () => {} },
  },
  BrowserWindow: TestBrowserWindow,
  utilityProcess: { fork: forkPsdWorkerForTest },
  Tray: class {
    setToolTip() {}
    on() {}
    getBounds() { return { x: 0, y: 0, width: 20, height: 20 }; }
    isDestroyed() { return true; }
    destroy() {}
  },
  ipcMain: {
    handle(channel, fn) { ipcHandlers.set(channel, fn); },
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true }),
    showSaveDialog: async () => ({ canceled: true }),
    showMessageBox: async () => ({ response: 0 }),
    showErrorBox: () => {},
  },
  shell: { openPath: () => {} },
  nativeImage: { createFromPath: () => ({ resize: () => ({}) }), createEmpty: () => ({}) },
  Notification: TestNotification,
  Menu: { buildFromTemplate: () => ({}) },
}));

let storeInstance = null;
class FakeStore {
  constructor(opts = {}) {
    this.path = path.join(TEST_USER_DATA, 'config.json');
    fs.writeFileSync(this.path, '{}', { mode: 0o600 });
    this.data = JSON.parse(JSON.stringify(opts.defaults || {}));
    if (process.env.CRATE_PSD_RESTART_SEED) {
      this.data = JSON.parse(fs.readFileSync(process.env.CRATE_PSD_RESTART_SEED, 'utf8'));
    }
    storeInstance = this;
  }
  get(key, fallback) {
    if (!key) return this.data;
    const parts = key.split('.');
    let cur = this.data;
    for (const part of parts) {
      if (cur && Object.prototype.hasOwnProperty.call(cur, part)) cur = cur[part];
      else return fallback;
    }
    return cur === undefined ? fallback : cur;
  }
  set(key, value) {
    if (typeof key === 'object') {
      Object.assign(this.data, key);
      return;
    }
    const parts = key.split('.');
    let cur = this.data;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }
  delete(key) {
    const parts = key.split('.');
    let cur = this.data;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) return;
      cur = cur[parts[i]];
    }
    delete cur[parts[parts.length - 1]];
  }
}
setStub('electron-store', () => FakeStore);

setStub('chokidar', () => ({ watch: () => ({ on: () => {}, close: () => {}, add: () => {}, unwatch: () => {} }) }));
setStub('node-fetch', () => async () => ({ ok: false, status: 500, json: async () => ({}) }));

function createChildProcessStub() {
  return {
    on: () => {},
    kill: () => {},
    stdout: { on: () => {} },
    stderr: { on: () => {} },
  };
}

function execStub(...args) {
  const callback = args.find(arg => typeof arg === 'function');
  if (callback) queueMicrotask(() => callback(null, '', ''));
  return createChildProcessStub();
}
execStub[nodePromisify.custom] = async () => ({ stdout: '', stderr: '' });

function execFileStub(...args) {
  const callback = args.find(arg => typeof arg === 'function');
  if (callback) queueMicrotask(() => callback(null, '', ''));
  return createChildProcessStub();
}
execFileStub[nodePromisify.custom] = async () => ({ stdout: '', stderr: '' });

setStub('child_process', () => ({
  execSync: () => '',
  execFileSync: () => '',
  exec: execStub,
  execFile: execFileStub,
}));

let currentPsdFixture = { children: [], linkedFiles: [] };
let psdParserReadCount = 0;
setStub('ag-psd', () => ({
  readPsd: (buffer, options) => {
    psdParserReadCount++;
    if (currentPsdFixture instanceof Error) throw currentPsdFixture;
    if (typeof currentPsdFixture === 'function') return currentPsdFixture(buffer, options);
    return currentPsdFixture;
  },
}));

let uuidCounter = 0;
setStub('crypto', () => ({
  ...crypto,
  randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`,
}));

// These PSD/package tests operate in an authenticated synthetic workspace.
const { AccountSession: RealAccountSession } = require('../account-session');
setStub('./account-session', () => ({ AccountSession: class extends RealAccountSession {
  async restore() {
    this.record = { identity: { id: 'test-account' } };
    this.accessToken = 'synthetic-access'; this.accessExpiresAt = Date.now() + 3600000;
    return this.publish('signed_in', '', { id: 'test-account' });
  }
} }));
// Expose the real ordinary observer entry point without altering production
// code, its debounce map, admission rules, source-selection state or leases.
const mainUnderTestPath = process.env.CRATE_MAIN_UNDER_TEST
  ? path.resolve(process.env.CRATE_MAIN_UNDER_TEST)
  : path.resolve(__dirname, '..', 'main.js');
const originalMainLoader = Module._extensions['.js'];
Module._extensions['.js'] = function loadMainForOrdinaryPsdCoverage(module, filename) {
  if (filename !== mainUnderTestPath) return originalMainLoader(module, filename);
  return module._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.__psdSafetyHooks = { runScanOnOpen, mutateProject, getAccountSession() { return accountSession; }, getCrypto() { return crypto; }, getPsdScanState() { return { operations: workingSourceScanOperations.size, leases: workingSourceScanLeases.size, pendingRepairs: typeof pendingPsdRepairs === "undefined" ? 0 : pendingPsdRepairs.size }; }, getPsdScanLease() { return [...workingSourceScanLeases.values()][0]; }, getPrePackageScanState(projectId) { return { inFlight: scanInFlight.has(projectId), settlement: packageScanSettlements.has(projectId) }; }, getPrePackageAppTimeout() { return PRE_PACKAGE_APP_SCAN_TIMEOUT_MS; }, interceptExtraction(wrapper) { const before = extractPsdAssets; extractPsdAssets = wrapper(before); return () => { extractPsdAssets = before; }; } };\n', filename);
};
let psdSafetyHooks;
try { psdSafetyHooks = require(mainUnderTestPath).__psdSafetyHooks; }
finally { Module._extensions['.js'] = originalMainLoader; }

test.beforeEach(() => {
  // These fixtures assert the legacy flat output contract explicitly.
  storeInstance.set('settings.packageOutputLayoutMode', 'flat');
});

function callIpcRaw(channel, ...args) {
  const handler = ipcHandlers.get(channel);
  if (!handler) throw new Error(`No IPC handler registered for ${channel}`);
  return handler({ sender: trustedRendererWindow.webContents, senderFrame: trustedRendererMainFrame }, ...args);
}

const callIpc = createAutomaticPackageReviewCaller(callIpcRaw);

function runPsdTestInFreshProcess(name, seedPath) {
  const env = { ...process.env, CRATE_PSD_RESTART_SEED: seedPath };
  // This is an independent CLI test run. Inheriting the parent's private
  // runner context makes Node silently skip the child's selected tests.
  delete env.NODE_TEST_CONTEXT;
  return require('node:child_process').spawnSync(process.execPath, [
    '--test', '--test-name-pattern=^' + name + '$', __filename,
  ], { env, encoding: 'utf8', timeout: 10000 });
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crate-psd-safety-'));
}

function makeProject(id, name, files) {
  const now = Date.now();
  return {
    id,
    name,
    type: 'branding',
    figmaScopeMode: 'entire-file',
    figmaTrackedFiles: [],
    status: 'watching',
    files,
    pendingFiles: [],
    createdAt: now,
    watchStartedAt: now,
    packagedAt: null,
    outputPath: null,
  };
}

function setProjects(projects) {
  storeInstance.set('projects', projects);
}

function getStoredProject(projectId) {
  return (storeInstance.get('projects', []) || []).find(project => project.id === projectId);
}

function getProvenanceEdges(project, relationType) {
  return Object.values((project && project.provenance && project.provenance.edges) || {})
    .filter(edge => edge && edge.relationType === relationType);
}

function fixtureLinkedFiles() {
  return [
    { name: '../escape.png', data: Buffer.from('embedded escape bytes') },
    { name: '/tmp/absolute-path-like.png', data: Buffer.from('embedded absolute bytes') },
    { name: 'duplicate.png', data: Buffer.from('embedded duplicate one') },
    { name: 'duplicate.png', data: Buffer.from('embedded duplicate two') },
  ];
}

function packageFolder(outputDir, projectName) {
  const dateStr = new Date().toISOString().split('T')[0];
  return path.join(outputDir, `${projectName}_${dateStr}`);
}

function rootManifestPath(outputDir, projectName) {
  return path.join(packageFolder(outputDir, projectName), 'crate-provenance.json');
}

function manifestPath(outputDir, projectName) {
  return path.join(packageFolder(outputDir, projectName), 'Crate Diagnostics', 'crate-provenance.json');
}

function readManifest(outputDir, projectName) {
  return JSON.parse(fs.readFileSync(manifestPath(outputDir, projectName), 'utf8'));
}

function assertPackageResultShape(result) {
  assert.deepEqual(Object.keys(result).sort(), [
    'copiedCount',
    'embeddedCount',
    'errors',
    'folderPath',
    'success',
    'totalFiles',
  ]);
}

function isPathInsideDirectory(rootDir, candidatePath) {
  const root = path.resolve(rootDir);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function listPathsRecursive(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const entries = [];
  for (const entry of fs.readdirSync(rootDir)) {
    const entryPath = path.join(rootDir, entry);
    entries.push(entryPath);
    if (fs.lstatSync(entryPath).isDirectory()) {
      entries.push(...listPathsRecursive(entryPath));
    }
  }
  return entries;
}

function assertPackageFolderContained(outputDir, folderPath) {
  assert.ok(isPathInsideDirectory(outputDir, folderPath), `${folderPath} escaped ${outputDir}`);
  assert.notEqual(path.resolve(folderPath), path.resolve(outputDir));
}

function assertNoPackageWritesOutsideOutput(tmpRoot, outputDir, allowedOutsideRoots) {
  for (const entryPath of listPathsRecursive(tmpRoot)) {
    if (isPathInsideDirectory(outputDir, entryPath)) continue;
    if (allowedOutsideRoots.some(root => isPathInsideDirectory(root, entryPath))) continue;
    assert.fail(`Unexpected package write outside outputPath: ${path.relative(tmpRoot, entryPath)}`);
  }
}

async function packageSingleFileFixture({ id, projectName, namingTemplate, sourceName = 'logo.ai' }) {
  const tmpRoot = makeTempDir();
  const sourceDir = path.join(tmpRoot, 'source');
  const outputDir = path.join(tmpRoot, 'out');
  const sourcePath = path.join(sourceDir, sourceName);
  try {
    fs.mkdirSync(sourceDir);
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, Buffer.from('logo bytes'));
    setProjects([makeProject(id, projectName, [{
      path: sourcePath,
      name: sourceName,
      ext: path.extname(sourceName),
      addedAt: Date.now(),
      source: 'manual-browse',
    }])]);
    await callIpc('settings:update', 'namingTemplate', namingTemplate === undefined ? '{Project}_{Date}' : namingTemplate);

    const result = await callIpc('projects:package', id, outputDir);

    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.embeddedCount, 0);
    assert.equal(result.totalFiles, 1);
    assert.deepEqual(result.errors, []);
    assertPackageFolderContained(outputDir, result.folderPath);
    assert.equal(fs.readFileSync(path.join(result.folderPath, sourceName), 'utf8'), 'logo bytes');
    assertNoPackageWritesOutsideOutput(tmpRoot, outputDir, [sourceDir]);
    return { result, tmpRoot, sourceDir, outputDir };
  } catch (error) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    throw error;
  }
}

test.afterEach(() => {
  currentPsdFixture = { children: [], linkedFiles: [] };
  if (storeInstance) storeInstance.set('projects', []);
  if (storeInstance) storeInstance.set('settings.includeDiagnosticReport', false);
  if (storeInstance) storeInstance.set('settings.namingTemplate', '{Project}_{Date}');
  if (storeInstance) storeInstance.set('usage.packagesThisMonth', 0);
  clearTrackedTimeouts();
  clearTrackedIntervals();
});

test.after(() => {
  for (const child of psdWorkerChildren) child.kill();
  clearTrackedTimeouts();
  clearTrackedIntervals();
  global.setTimeout = originalSetTimeout;
  global.clearTimeout = originalClearTimeout;
  global.setInterval = originalSetInterval;
  global.clearInterval = originalClearInterval;
  os.homedir = originalHomedir;
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

function makeEmbeddedPsdEntry(psdPath, name = 'Embedded.png') {
  return {
    path: psdPath,
    name,
    ext: path.extname(name).toLowerCase(),
    addedAt: Date.now(),
    source: 'scan-on-save-embedded',
    embedded: true,
    parentPsd: psdPath,
    embeddedOriginalName: name,
    embeddedIndex: 0,
    fileId: `embedded-${name}`,
  };
}

function expectedDormantWorkingSourceFacts(role) {
  return {
    sourceSelection: role === 'source' ? 'selected' : null,
    selectionReason: null,
    selectionRevision: role === 'source' ? 0 : null,
    includedAsDependency: false,
    included: true,
    effectiveRole: role,
    verificationStatus: 'unavailable',
    verificationRequired: false,
    requiredBy: [],
  };
}

test('corrupt or removed PSD resources withhold review tokens and recover safely', async () => {
  const tmpRoot = makeTempDir();
  try {
    const projectId = 'psd-review-readiness';
    const psdPath = path.join(tmpRoot, 'source.psd');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(psdPath, Buffer.from('synthetic parent PSD bytes'));
    setProjects([makeProject(projectId, 'PSD Review Readiness', [makeEmbeddedPsdEntry(psdPath)])]);

    currentPsdFixture = new Error('synthetic corrupt PSD');
    const corruptReview = await callIpcRaw('projects:prepare-package-review', projectId);
    assert.equal(corruptReview.materializable, false);
    assert.equal(corruptReview.token, undefined);
    assert.deepEqual(
      corruptReview.files.map(({ visualIdentity, visualRevision, ...file }) => file),
      [{
        name: 'Embedded.png',
        ext: '.png',
        embedded: true,
        linked: true,
        appFamily: 'photoshop',
        sourceName: null,
        assetOrigin: 'existing',
        projectRole: 'asset',
        ...expectedDormantWorkingSourceFacts('asset'),
        protectedSource: false,
        sourceRecoveryAllowed: false,
        excluded: false,
        status: 'unavailable',
      }]
    );
    assert.match(corruptReview.files[0].visualIdentity, /^[A-Za-z0-9_-]{43}$/);

    currentPsdFixture = { children: [], linkedFiles: [] };
    const missingReview = await callIpcRaw('projects:prepare-package-review', projectId);
    assert.equal(missingReview.materializable, false);
    assert.equal(missingReview.token, undefined);

    currentPsdFixture = {
      children: [],
      linkedFiles: [{ name: 'Embedded.png', data: Buffer.from('reviewed embedded bytes') }],
    };
    const recoveredReview = await callIpcRaw('projects:prepare-package-review', projectId);
    assert.equal(recoveredReview.materializable, true);
    assert.equal(typeof recoveredReview.token, 'string');

    currentPsdFixture = { children: [], linkedFiles: [] };
    const removed = await callIpcRaw('projects:package', projectId, outputDir, recoveredReview.token);
    assert.equal(removed.error, 'package_review_changed');
    assert.equal(removed.review.materializable, false);
    assert.equal(removed.review.token, undefined);
    assert.deepEqual(
      removed.review.files.map(({ visualIdentity, visualRevision, ...file }) => file),
      [{
        name: 'Embedded.png',
        ext: '.png',
        embedded: true,
        linked: true,
        appFamily: 'photoshop',
        sourceName: null,
        assetOrigin: 'existing',
        projectRole: 'asset',
        ...expectedDormantWorkingSourceFacts('asset'),
        protectedSource: false,
        sourceRecoveryAllowed: false,
        excluded: false,
        status: 'unavailable',
      }]
    );
    assert.match(removed.review.files[0].visualIdentity, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(fs.readdirSync(outputDir), []);

    currentPsdFixture = {
      children: [],
      linkedFiles: [{ name: 'Embedded.png', data: Buffer.from('recovered embedded bytes') }],
    };
    const secondRecovery = await callIpcRaw('projects:prepare-package-review', projectId);
    assert.equal(secondRecovery.materializable, true);
    assert.equal(typeof secondRecovery.token, 'string');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('post-review PSD resource replacement refreshes before publishing changed bytes', async () => {
  const tmpRoot = makeTempDir();
  try {
    const projectId = 'psd-resource-change';
    const psdPath = path.join(tmpRoot, 'source.psd');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(psdPath, Buffer.from('stable synthetic parent PSD bytes'));
    setProjects([makeProject(projectId, 'PSD Resource Change', [makeEmbeddedPsdEntry(psdPath)])]);
    currentPsdFixture = {
      children: [],
      linkedFiles: [{ name: 'Embedded.png', data: Buffer.from('reviewed resource bytes') }],
    };
    const review = await callIpcRaw('projects:prepare-package-review', projectId);

    currentPsdFixture = {
      children: [],
      linkedFiles: [{ name: 'Embedded.png', data: Buffer.from('replacement resource bytes') }],
    };
    const changed = await callIpcRaw('projects:package', projectId, outputDir, review.token);
    assert.equal(changed.error, 'package_review_changed');
    assert.equal(changed.review.materializable, true);
    assert.equal(typeof changed.review.token, 'string');
    assert.deepEqual(fs.readdirSync(outputDir), []);

    const result = await callIpcRaw('projects:package', projectId, outputDir, changed.review.token);
    assert.equal(result.success, true);
    assert.equal(
      fs.readFileSync(path.join(result.folderPath, 'Embedded.png'), 'utf8'),
      'replacement resource bytes'
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('default package omits diagnostic report files but keeps package provenance records', async () => {
  const tmpRoot = makeTempDir();
  try {
    const sourcePath = path.join(tmpRoot, 'logo.ai');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, Buffer.from('logo bytes'));

    setProjects([makeProject('diagnostic-default-off', 'Diagnostic Default Off', [{
      path: sourcePath,
      name: 'logo.ai',
      ext: '.ai',
      addedAt: Date.now(),
      source: 'manual-browse',
    }])]);

    const result = await callIpc('projects:package', 'diagnostic-default-off', outputDir);

    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.embeddedCount, 0);
    assert.equal(result.totalFiles, 1);
    assert.deepEqual(result.errors, []);
    assert.equal(fs.existsSync(rootManifestPath(outputDir, 'Diagnostic Default Off')), false);
    assert.equal(fs.existsSync(manifestPath(outputDir, 'Diagnostic Default Off')), false);

    const project = getStoredProject('diagnostic-default-off');
    assert.equal(getProvenanceEdges(project, EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('package provenance records copied files and redacts private diagnostics', async () => {
  const tmpRoot = makeTempDir();
  try {
    const sourcePath = path.join(tmpRoot, 'logo.ai');
    const missingPath = path.join(tmpRoot, 'missing.ai');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, Buffer.from('logo bytes'));
    fs.writeFileSync(missingPath, Buffer.from('secondary bytes'));
    const containerPath = path.join(tmpRoot, 'brand.psd');
    const normalizedSourcePath = fs.realpathSync.native(sourcePath).replace(/\/+$/, '').toLowerCase();
    const sourceNodeId = createNodeId(NODE_TYPES.FILE, { normalizedPath: normalizedSourcePath });
    const containerFileNodeId = createNodeId(NODE_TYPES.FILE, containerPath);
    const containerNodeId = createNodeId(NODE_TYPES.CONTAINER, { path: containerPath });

    const packageProject = makeProject('package-provenance-copy', 'Package Provenance Copy', [
      {
        path: sourcePath,
        name: 'logo.ai',
        ext: '.ai',
        addedAt: Date.now(),
        source: 'manual-browse',
      },
      {
        path: missingPath,
        name: 'missing.ai',
        ext: '.ai',
        addedAt: Date.now(),
        source: 'manual-browse',
      },
    ]);
    packageProject.provenance = {
      schemaVersion: 1,
      sessionId: null,
      nodes: {
        [sourceNodeId]: {
          id: sourceNodeId,
          type: NODE_TYPES.FILE,
          path: sourcePath,
          name: 'logo.ai',
          privateLabel: 'SHOULD_NOT_APPEAR_NODE_FIELD',
        },
        [containerFileNodeId]: {
          id: containerFileNodeId,
          type: NODE_TYPES.FILE,
          path: containerPath,
          name: 'brand.psd',
        },
        [containerNodeId]: {
          id: containerNodeId,
          type: 'SHOULD_NOT_APPEAR_NODE_TYPE',
          fileNodeId: containerFileNodeId,
          path: containerPath,
        },
      },
      edges: {
        edge_parser_sensitive_fixture: {
          id: 'edge_parser_sensitive_fixture',
          relationType: EDGE_TYPES.CONTAINER_REFERENCES_FILE,
          subjectNodeId: containerNodeId,
          objectNodeId: sourceNodeId,
          evidenceIds: ['ev_sensitive_parser_fixture'],
          payload: {
            command: ['/usr/sbin/lsof SHOULD_NOT_APPEAR_INCLUDED_COMMAND'],
          },
          privateLabel: 'SHOULD_NOT_APPEAR_EDGE_FIELD',
        },
        edge_malformed_sensitive_fixture: {
          id: 'edge_malformed_sensitive_fixture',
          relationType: EDGE_TYPES.CONTAINER_REFERENCES_FILE,
          subjectNodeId: 'SHOULD_NOT_APPEAR_MISSING_NODE_ID',
          objectNodeId: sourceNodeId,
          evidenceIds: [],
        },
      },
      observations: [],
      evidence: {
        ev_sensitive_parser_fixture: {
          id: 'ev_sensitive_parser_fixture',
          kind: 'SHOULD_NOT_APPEAR_EVIDENCE_KIND',
          observer: { kind: 'parser' },
          summary: 'safe parser fixture',
          payload: {
            token: 'SHOULD_NOT_APPEAR_INCLUDED_TOKEN',
            command: ['/usr/sbin/lsof SHOULD_NOT_APPEAR_INCLUDED_COMMAND'],
            rawFigmaApiResponse: { body: 'SHOULD_NOT_APPEAR_INCLUDED_FIGMA_API' },
            note: 'Review https://www.figma.com/design/SHOULD_NOT_APPEAR_FILE_KEY/Private-File?node-id=1-2 and figma://open?file-id=SHOULD_NOT_APPEAR_DESKTOP_KEY',
            authNote: 'Authorization: Bearer SHOULD_NOT_APPEAR_BEARER_VALUE',
            jsonAuthNote: '{"Authorization":"Bearer SHOULD_NOT_APPEAR_JSON_BEARER","cookie":"SHOULD_NOT_APPEAR_JSON_COOKIE"}',
            authorization: 'SHOULD_NOT_APPEAR_AUTHORIZATION_VALUE',
            cookie: 'SHOULD_NOT_APPEAR_COOKIE_VALUE',
            password: 'SHOULD_NOT_APPEAR_PASSWORD_VALUE',
            credential: 'SHOULD_NOT_APPEAR_CREDENTIAL_VALUE',
          },
        },
        ev_unrelated_raw: {
          id: 'ev_unrelated_raw',
          kind: 'lsof',
          observer: { kind: 'lsof' },
          summary: 'SHOULD_NOT_APPEAR_RAW_LSOF_OUTPUT',
          payload: {
            token: 'SHOULD_NOT_APPEAR_TOKEN',
            command: '/usr/sbin/lsof SHOULD_NOT_APPEAR_COMMAND',
            figmaApiResponse: 'SHOULD_NOT_APPEAR_FIGMA_API',
          },
        },
      },
    };
    setProjects([packageProject]);
    await callIpc('settings:update', 'includeDiagnosticReport', true);

    const result = await callIpc('projects:package', 'package-provenance-copy', outputDir);

    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 2);
    assert.equal(result.embeddedCount, 0);
    assert.equal(result.totalFiles, 2);
    assert.deepEqual(result.errors, []);

    const destFolder = packageFolder(outputDir, 'Package Provenance Copy');
    const copiedPath = path.join(destFolder, 'logo.ai');
    assert.equal(fs.readFileSync(copiedPath, 'utf8'), 'logo bytes');

    const project = getStoredProject('package-provenance-copy');
    const includeEdges = getProvenanceEdges(project, EDGE_TYPES.PACKAGE_INCLUDES_FILE);
    const extractEdges = getProvenanceEdges(project, EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE);
    assert.equal(includeEdges.length, 2);
    assert.equal(extractEdges.length, 0);
    assert.equal(includeEdges[0].payload.outputPath, copiedPath);
    assert.equal(includeEdges[0].payload.source, 'manual-browse');
    assert.equal(includeEdges[0].confidence.band, 'confirmed');
    assert.ok(project.provenance.nodes[includeEdges[0].subjectNodeId]);
    assert.ok(project.provenance.nodes[includeEdges[0].objectNodeId]);
    assert.equal(
      project.provenance.evidence.ev_sensitive_parser_fixture.payload.token,
      'SHOULD_NOT_APPEAR_INCLUDED_TOKEN'
    );
    assert.deepEqual(
      project.provenance.edges.edge_parser_sensitive_fixture.payload.command,
      ['/usr/sbin/lsof SHOULD_NOT_APPEAR_INCLUDED_COMMAND']
    );
    assert.equal(
      project.provenance.nodes[containerNodeId].type,
      'SHOULD_NOT_APPEAR_NODE_TYPE'
    );

    const manifest = readManifest(outputDir, 'Package Provenance Copy');
    assert.equal(fs.existsSync(rootManifestPath(outputDir, 'Package Provenance Copy')), false);
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.scope, 'minimized_package_relevant');
    assert.equal(
      Object.keys(manifest).sort().join(','),
      'edges,evidence,generatedBy,nodes,package,privacy,schemaVersion,scope,warnings'
    );
    assert.equal(manifest.generatedBy.app, 'Crate');
    assert.equal(typeof manifest.generatedBy.version, 'string');
    assert.equal(Object.keys(manifest.generatedBy).sort().join(','), 'app,version');
    assert.deepEqual(manifest.privacy, {
      mode: 'minimized',
      identifiers: 'report-local',
      content: 'metadata-only',
    });
    assert.equal('generatedAt' in manifest, false);
    assert.equal('project' in manifest, false);
    assert.equal(Object.keys(manifest.privacy).sort().join(','), 'content,identifiers,mode');
    assert.equal('path' in manifest.package, false);
    assert.equal('createdAt' in manifest.package, false);
    assert.equal(
      Object.keys(manifest.package).sort().join(','),
      'copiedCount,embeddedCount,errorCategories,errorCount,totalFiles'
    );
    assert.equal(manifest.package.copiedCount, 2);
    assert.equal(manifest.package.embeddedCount, 0);
    assert.equal(manifest.package.totalFiles, 2);
    assert.equal(manifest.package.errorCount, 0);
    assert.deepEqual(manifest.package.errorCategories, {});
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 2);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE).length, 0);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.CONTAINER_REFERENCES_FILE).length, 1);
    assert.equal(manifest.evidence.length, 1);
    assert.equal(manifest.evidence[0].kind, 'other');
    assert.equal(manifest.nodes.some(node => node.type === 'other'), true);
    assert.equal(
      manifest.edges.find(edge => edge.relationType === EDGE_TYPES.CONTAINER_REFERENCES_FILE).confidenceBand,
      'weak'
    );
    assert.equal(manifest.nodes.every(node => /^node_[a-f0-9]{16}_\d+$/.test(node.id)), true);
    assert.equal(manifest.edges.every(edge => /^edge_[a-f0-9]{16}_\d+$/.test(edge.id)), true);
    assert.equal(manifest.evidence.every(evidence => /^evidence_[a-f0-9]{16}_\d+$/.test(evidence.id)), true);
    assert.equal(manifest.nodes.every(node => Object.keys(node).sort().join(',') === 'id,type'), true);
    assert.equal(manifest.edges.every(edge => (
      Object.keys(edge).sort().join(',') === 'confidenceBand,evidenceIds,id,objectNodeId,relationType,subjectNodeId'
    )), true);
    assert.equal(manifest.evidence.every(evidence => Object.keys(evidence).sort().join(',') === 'id,kind'), true);
    assert.equal(manifest.warnings.some(warning => warning.includes('Minimized package-relevant')), true);
    assert.equal(
      manifest.warnings.includes('Malformed or unrecognized diagnostic graph records were omitted.'),
      true
    );

    const manifestText = JSON.stringify(manifest);
    assert.equal(manifestText.includes('package-provenance-copy'), false);
    assert.equal(manifestText.includes('Package Provenance Copy'), false);
    assert.equal(manifestText.includes(project.provenance.sessionId), false);
    assert.equal(manifestText.includes(destFolder), false);
    assert.equal(manifestText.includes(missingPath), false);
    assert.equal(manifestText.includes('missing.ai'), false);
    assert.equal(manifestText.includes('logo.ai'), false);
    assert.equal(manifestText.includes(sourceNodeId), false);
    assert.equal(manifestText.includes(containerFileNodeId), false);
    assert.equal(manifestText.includes(containerNodeId), false);
    assert.equal(manifestText.includes(includeEdges[0].id), false);
    assert.equal(manifestText.includes('ev_sensitive_parser_fixture'), false);
    assert.equal(manifestText.includes('edge_malformed_sensitive_fixture'), false);
    assert.equal(manifestText.includes('SHOULD_NOT_APPEAR_MISSING_NODE_ID'), false);
    assert.equal(manifestText.includes('SHOULD_NOT_APPEAR_NODE_TYPE'), false);
    assert.equal(manifestText.includes('SHOULD_NOT_APPEAR_NODE_FIELD'), false);
    assert.equal(manifestText.includes('SHOULD_NOT_APPEAR_EDGE_FIELD'), false);
    assert.equal(manifestText.includes('SHOULD_NOT_APPEAR_EVIDENCE_KIND'), false);
    assert.equal(manifestText.includes('SHOULD_NOT_APPEAR_INCLUDED_TOKEN'), false);
    assert.equal(manifestText.includes('SHOULD_NOT_APPEAR_INCLUDED_COMMAND'), false);
    assert.equal(manifestText.includes('SHOULD_NOT_APPEAR_INCLUDED_FIGMA_API'), false);
    assert.equal(manifestText.includes('SHOULD_NOT_APPEAR_RAW_LSOF_OUTPUT'), false);
    assert.equal(manifestText.includes('SHOULD_NOT_APPEAR_TOKEN'), false);
    assert.equal(manifestText.includes('SHOULD_NOT_APPEAR_COMMAND'), false);
    assert.equal(manifestText.includes('SHOULD_NOT_APPEAR_FIGMA_API'), false);
    assert.equal(manifestText.includes('SHOULD_NOT_APPEAR_JSON_BEARER'), false);
    assert.equal(manifestText.includes('SHOULD_NOT_APPEAR_JSON_COOKIE'), false);
    assert.equal(manifestText.includes('SHOULD_NOT_APPEAR_AUTHORIZATION_VALUE'), false);
    assert.equal(manifestText.includes('SHOULD_NOT_APPEAR_COOKIE_VALUE'), false);
    assert.equal(manifestText.includes('SHOULD_NOT_APPEAR_PASSWORD_VALUE'), false);
    assert.equal(manifestText.includes('SHOULD_NOT_APPEAR_CREDENTIAL_VALUE'), false);

    const secondOutputDir = path.join(tmpRoot, 'out-second');
    fs.mkdirSync(secondOutputDir);
    const secondResult = await callIpc('projects:package', 'package-provenance-copy', secondOutputDir);
    assert.equal(secondResult.success, true);
    const secondManifest = readManifest(secondOutputDir, 'Package Provenance Copy');
    assert.notDeepEqual(
      secondManifest.nodes.map(node => node.id),
      manifest.nodes.map(node => node.id)
    );
    assert.notDeepEqual(
      secondManifest.edges.map(edge => edge.id),
      manifest.edges.map(edge => edge.id)
    );
    assert.notDeepEqual(
      secondManifest.evidence.map(evidence => evidence.id),
      manifest.evidence.map(evidence => evidence.id)
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('package manifest excludes lsof app process evidence and raw process output', async () => {
  const tmpRoot = makeTempDir();
  try {
    const sourcePath = path.join(tmpRoot, 'logo.ai');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, Buffer.from('logo bytes'));

    const normalizedSourcePath = fs.realpathSync.native(sourcePath).replace(/\/+$/, '').toLowerCase();
    const sourceNodeId = createNodeId(NODE_TYPES.FILE, { normalizedPath: normalizedSourcePath });
    const appNodeId = createNodeId(NODE_TYPES.APP, {
      bundleId: 'com.figma.Desktop',
      name: 'Figma',
      appFamily: 'figma',
    });
    const appProcessNodeId = createNodeId(NODE_TYPES.APP_PROCESS, {
      sessionId: 'session_lsof_manifest',
      pid: 987,
      appNodeId,
    });

    const project = makeProject('lsof-manifest-exclusion', 'Lsof Manifest Exclusion', [{
      path: sourcePath,
      name: 'logo.ai',
      ext: '.ai',
      addedAt: Date.now(),
      source: 'manual-browse',
    }]);
    project.provenance = {
      schemaVersion: 1,
      sessionId: 'session_lsof_manifest',
      nodes: {
        [sourceNodeId]: {
          id: sourceNodeId,
          type: NODE_TYPES.FILE,
          path: sourcePath,
          name: 'logo.ai',
        },
        [appNodeId]: {
          id: appNodeId,
          type: NODE_TYPES.APP,
          bundleId: 'com.figma.Desktop',
          name: 'Figma',
          appFamily: 'figma',
        },
        [appProcessNodeId]: {
          id: appProcessNodeId,
          type: NODE_TYPES.APP_PROCESS,
          appNodeId,
          pid: 987,
          appName: 'Figma',
          appFamily: 'figma',
          observedFirstAt: Date.now(),
          observedLastAt: Date.now(),
          method: 'poll',
          source: 'lsof',
        },
      },
      edges: {
        edge_lsof_raw_fixture: {
          id: 'edge_lsof_raw_fixture',
          relationType: EDGE_TYPES.APP_OPENED_FILE,
          subjectNodeId: appProcessNodeId,
          objectNodeId: sourceNodeId,
          evidenceIds: ['ev_lsof_raw_fixture'],
          confidence: { score: 0.6, band: 'candidate', reasons: ['lsof fixture'] },
          payload: {
            command: '/usr/sbin/lsof SHOULD_NOT_APPEAR_COMMAND',
            rawLsofOutput: 'SHOULD_NOT_APPEAR_RAW_LSOF_OUTPUT',
            processArgs: ['SHOULD_NOT_APPEAR_PROCESS_ARG'],
          },
        },
      },
      observations: [{
        id: 'obs_lsof_raw_fixture',
        relationType: EDGE_TYPES.APP_OPENED_FILE,
        subjectNodeId: appProcessNodeId,
        objectNodeId: sourceNodeId,
        evidenceIds: ['ev_lsof_raw_fixture'],
        payload: {
          command: '/usr/sbin/lsof SHOULD_NOT_APPEAR_OBSERVATION_COMMAND',
          rawLsofOutput: 'SHOULD_NOT_APPEAR_OBSERVATION_RAW_LSOF',
          processArgs: ['SHOULD_NOT_APPEAR_OBSERVATION_PROCESS_ARG'],
        },
      }],
      evidence: {
        ev_lsof_raw_fixture: {
          id: 'ev_lsof_raw_fixture',
          kind: 'lsof',
          observer: { kind: 'lsof', method: 'poll' },
          summary: 'SHOULD_NOT_APPEAR_RAW_LSOF_SUMMARY',
          payload: {
            command: '/usr/sbin/lsof SHOULD_NOT_APPEAR_EVIDENCE_COMMAND',
            rawLsofOutput: 'SHOULD_NOT_APPEAR_EVIDENCE_RAW_LSOF',
            processArgs: ['SHOULD_NOT_APPEAR_EVIDENCE_PROCESS_ARG'],
          },
        },
      },
    };
    setProjects([project]);
    await callIpc('settings:update', 'includeDiagnosticReport', true);

    const result = await callIpc('projects:package', 'lsof-manifest-exclusion', outputDir);

    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    const manifest = readManifest(outputDir, 'Lsof Manifest Exclusion');
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 1);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.APP_OPENED_FILE).length, 0);
    assert.equal(manifest.nodes.filter(node => node.type === NODE_TYPES.APP_PROCESS).length, 0);
    assert.equal(manifest.nodes.filter(node => node.type === NODE_TYPES.APP).length, 0);
    assert.equal(manifest.evidence.filter(evidence => evidence.kind === 'lsof').length, 0);

    const manifestText = JSON.stringify(manifest);
    assert.equal(manifestText.includes('SHOULD_NOT_APPEAR_COMMAND'), false);
    assert.equal(manifestText.includes('SHOULD_NOT_APPEAR_RAW_LSOF'), false);
    assert.equal(manifestText.includes('SHOULD_NOT_APPEAR_PROCESS_ARG'), false);
    assert.equal(manifestText.includes('APP_OPENED_FILE'), false);
    assert.equal(manifestText.includes(EDGE_TYPES.APP_OPENED_FILE), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('package copy sanitizes corrupt destination names and stays inside package folder', async () => {
  const tmpRoot = makeTempDir();
  try {
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    const files = [
      { sourcePath: path.join(tmpRoot, 'source-safe.ai'), name: 'safe.ai', expectedName: 'safe.ai', bytes: 'safe bytes' },
      { sourcePath: path.join(tmpRoot, 'source-escape.ai'), name: '../escape.ai', expectedName: 'escape.ai', bytes: 'escape bytes' },
      { sourcePath: path.join(tmpRoot, 'source-absolute.ai'), name: '/tmp/absolute.ai', expectedName: 'absolute.ai', bytes: 'absolute bytes' },
      { sourcePath: path.join(tmpRoot, 'source-nested.ai'), name: 'nested/name.ai', expectedName: 'name.ai', bytes: 'nested bytes' },
      { sourcePath: path.join(tmpRoot, 'source-nul.ai'), name: 'nul\0name.ai', expectedName: 'nul_name.ai', bytes: 'nul bytes' },
    ];

    setProjects([makeProject('package-copy-containment', 'Package Copy Containment', files.map(file => {
      fs.writeFileSync(file.sourcePath, Buffer.from(file.bytes));
      return {
        path: file.sourcePath,
        name: file.name,
        ext: '.ai',
        addedAt: Date.now(),
        source: 'manual-browse',
      };
    }))]);

    const result = await callIpc('projects:package', 'package-copy-containment', outputDir);

    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, files.length);
    assert.equal(result.embeddedCount, 0);
    assert.equal(result.totalFiles, files.length);
    assert.deepEqual(result.errors, []);

    const destFolder = packageFolder(outputDir, 'Package Copy Containment');
    for (const file of files) {
      assert.equal(fs.readFileSync(path.join(destFolder, file.expectedName), 'utf8'), file.bytes);
    }
    assert.equal(fs.existsSync(path.join(outputDir, 'escape.ai')), false);
    assert.equal(fs.existsSync(path.join(destFolder, 'nested')), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('normal naming template still creates the expected package folder', async () => {
  const fixture = await packageSingleFileFixture({
    id: 'package-folder-normal-template',
    projectName: 'Normal Project',
    namingTemplate: '{Project}_{Date}',
  });
  try {
    const expectedFolder = packageFolder(fixture.outputDir, 'Normal Project');
    assert.equal(fixture.result.folderPath, expectedFolder);
    assert.equal(path.basename(fixture.result.folderPath), `Normal Project_${new Date().toISOString().split('T')[0]}`);
  } finally {
    fs.rmSync(fixture.tmpRoot, { recursive: true, force: true });
  }
});

test('naming template path traversal cannot escape selected output folder', async () => {
  const fixture = await packageSingleFileFixture({
    id: 'package-folder-template-traversal',
    projectName: 'QA',
    namingTemplate: '../evil',
  });
  try {
    assert.equal(fs.existsSync(path.join(fixture.tmpRoot, 'evil')), false);
  } finally {
    fs.rmSync(fixture.tmpRoot, { recursive: true, force: true });
  }
});

test('project name path traversal cannot escape selected output folder', async () => {
  const fixture = await packageSingleFileFixture({
    id: 'package-folder-project-traversal',
    projectName: '..',
    namingTemplate: '{Project}_{Date}',
  });
  try {
    assert.notEqual(path.basename(fixture.result.folderPath), '..');
    assert.equal(fs.existsSync(path.join(fixture.tmpRoot, 'logo.ai')), false);
  } finally {
    fs.rmSync(fixture.tmpRoot, { recursive: true, force: true });
  }
});

test('slash-containing naming template remains inside selected output folder', async () => {
  const fixture = await packageSingleFileFixture({
    id: 'package-folder-slash-template',
    projectName: 'QA',
    namingTemplate: 'nested/folder_{Project}',
  });
  try {
    assert.equal(path.basename(fixture.result.folderPath).includes('/'), false);
    assert.equal(path.basename(fixture.result.folderPath).includes('\\'), false);
    assert.equal(fs.existsSync(path.join(fixture.outputDir, 'nested')), false);
  } finally {
    fs.rmSync(fixture.tmpRoot, { recursive: true, force: true });
  }
});

test('absolute-path-like naming template remains inside selected output folder', async () => {
  const tmpRoot = makeTempDir();
  const sourceDir = path.join(tmpRoot, 'source');
  const outputDir = path.join(tmpRoot, 'out');
  const outsideTarget = path.join(tmpRoot, 'outside-absolute');
  const sourcePath = path.join(sourceDir, 'logo.ai');
  try {
    fs.mkdirSync(sourceDir);
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, Buffer.from('logo bytes'));
    setProjects([makeProject('package-folder-absolute-template', 'QA', [{
      path: sourcePath,
      name: 'logo.ai',
      ext: '.ai',
      addedAt: Date.now(),
      source: 'manual-browse',
    }])]);
    await callIpc('settings:update', 'namingTemplate', outsideTarget);

    const result = await callIpc('projects:package', 'package-folder-absolute-template', outputDir);

    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.embeddedCount, 0);
    assert.equal(result.totalFiles, 1);
    assert.deepEqual(result.errors, []);
    assertPackageFolderContained(outputDir, result.folderPath);
    assert.equal(fs.readFileSync(path.join(result.folderPath, 'logo.ai'), 'utf8'), 'logo bytes');
    assert.equal(fs.existsSync(outsideTarget), false);
    assertNoPackageWritesOutsideOutput(tmpRoot, outputDir, [sourceDir]);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('null-byte naming template and project name are handled safely', async () => {
  const fixture = await packageSingleFileFixture({
    id: 'package-folder-null-byte',
    projectName: 'Null\0Project',
    namingTemplate: 'bad\0template_{Project}',
  });
  try {
    assert.equal(fixture.result.folderPath.includes('\0'), false);
    assert.equal(path.basename(fixture.result.folderPath).includes('\0'), false);
  } finally {
    fs.rmSync(fixture.tmpRoot, { recursive: true, force: true });
  }
});

test('package copy rejects symlinked selected output directories without writing through them', async () => {
  const tmpRoot = makeTempDir();
  try {
    const sourcePath = path.join(tmpRoot, 'logo.ai');
    const realOutputDir = path.join(tmpRoot, 'real-out');
    const symlinkOutputDir = path.join(tmpRoot, 'out-link');
    fs.writeFileSync(sourcePath, Buffer.from('logo bytes'));
    fs.mkdirSync(realOutputDir);
    try {
      fs.symlinkSync(realOutputDir, symlinkOutputDir, 'dir');
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES') return;
      throw e;
    }

    setProjects([makeProject('package-copy-symlink-output', 'Package Copy Symlink Output', [{
      path: sourcePath,
      name: 'logo.ai',
      ext: '.ai',
      addedAt: Date.now(),
      source: 'manual-browse',
    }])]);

    await assert.rejects(
      () => callIpc('projects:package', 'package-copy-symlink-output', symlinkOutputDir),
      (error) => {
        assert.match(error.message, /Package output (?:parent )?folder is a symlink/);
        assert.equal(error.message.includes(realOutputDir), false);
        return true;
      }
    );
    assert.deepEqual(fs.readdirSync(realOutputDir), []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('package copy rejects symlinked selected output ancestors without writing through them', async () => {
  const tmpRoot = makeTempDir();
  try {
    const sourcePath = path.join(tmpRoot, 'logo.ai');
    const realOutputDir = path.join(tmpRoot, 'real-out');
    const symlinkOutputParent = path.join(tmpRoot, 'out-link');
    const nestedOutputDir = path.join(symlinkOutputParent, 'nested');
    fs.writeFileSync(sourcePath, Buffer.from('logo bytes'));
    fs.mkdirSync(realOutputDir);
    try {
      fs.symlinkSync(realOutputDir, symlinkOutputParent, 'dir');
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES') return;
      throw e;
    }

    setProjects([makeProject('package-copy-symlink-output-ancestor', 'Package Copy Symlink Output Ancestor', [{
      path: sourcePath,
      name: 'logo.ai',
      ext: '.ai',
      addedAt: Date.now(),
      source: 'manual-browse',
    }])]);

    await assert.rejects(
      () => callIpc('projects:package', 'package-copy-symlink-output-ancestor', nestedOutputDir),
      (error) => {
        assert.match(error.message, /Package output parent folder is a symlink/);
        assert.equal(error.message.includes(realOutputDir), false);
        return true;
      }
    );
    assert.deepEqual(fs.readdirSync(realOutputDir), []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('package copy fails closed on reviewed symlink sources without copying target contents', async () => {
  const tmpRoot = makeTempDir();
  try {
    const targetPath = path.join(tmpRoot, 'outside-secret.ai');
    const symlinkPath = path.join(tmpRoot, 'linked-secret.ai');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(targetPath, Buffer.from('secret target bytes'));
    try {
      fs.symlinkSync(targetPath, symlinkPath);
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES') return;
      throw e;
    }

    setProjects([makeProject('package-copy-symlink', 'Package Copy Symlink', [{
      path: symlinkPath,
      name: 'linked-secret.ai',
      ext: '.ai',
      addedAt: Date.now(),
      source: 'manual-browse',
    }])]);
    await callIpc('settings:update', 'includeDiagnosticReport', true);

    const result = await callIpcRaw('projects:prepare-package-review', 'package-copy-symlink');

    assert.equal(result.materializable, false);
    assert.equal(result.token, undefined);
    assert.deepEqual(
      result.files.map(({ visualIdentity, visualRevision, ...file }) => file),
      [{
        name: 'linked-secret.ai',
        ext: '.ai',
        embedded: false,
        linked: false,
        appFamily: 'illustrator',
        sourceName: null,
        currentWorkingSources: [],
        assetOrigin: 'existing',
        projectRole: 'source',
        ...expectedDormantWorkingSourceFacts('source'),
        protectedSource: true,
        sourceRecoveryAllowed: false,
        excluded: false,
        status: 'symlink',
      }]
    );
    assert.match(result.files[0].visualIdentity, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(fs.readdirSync(outputDir), []);
    const project = getStoredProject('package-copy-symlink');
    assert.equal(project.status, 'watching');
    assert.equal(getProvenanceEdges(project, EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 0);
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 0);
    assert.equal(JSON.stringify(result).includes(targetPath), false);
    assert.equal(JSON.stringify(result).includes('secret target bytes'), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('package provenance failure does not block package success', async () => {
  const tmpRoot = makeTempDir();
  try {
    const sourcePath = path.join(tmpRoot, 'logo.ai');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, Buffer.from('logo bytes'));

    const project = makeProject('package-provenance-failure', 'Package Provenance Failure', [{
      path: sourcePath,
      name: 'logo.ai',
      ext: '.ai',
      addedAt: Date.now(),
      source: 'manual-browse',
    }]);
    project.provenance = {
      schemaVersion: 1,
      sessionId: null,
      nodes: new Proxy({}, {
        set() {
          throw new Error('forced package provenance failure');
        },
      }),
      edges: {},
      observations: [],
      evidence: {},
    };
    setProjects([project]);
    await callIpc('settings:update', 'includeDiagnosticReport', true);

    const result = await callIpc('projects:package', 'package-provenance-failure', outputDir);

    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.embeddedCount, 0);
    assert.deepEqual(result.errors, []);
    const destFolder = packageFolder(outputDir, 'Package Provenance Failure');
    assert.equal(fs.readFileSync(path.join(destFolder, 'logo.ai'), 'utf8'), 'logo bytes');
    const manifest = readManifest(outputDir, 'Package Provenance Failure');
    assert.equal(manifest.edges.length, 0);
    assert.equal(manifest.warnings.includes('No package provenance edges were available for this package.'), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('empty provenance writes minimal package manifest with warnings', async () => {
  const tmpRoot = makeTempDir();
  try {
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);

    const project = makeProject('empty-provenance-manifest', 'Empty Provenance Manifest', []);
    project.provenance = {
      schemaVersion: 1,
      sessionId: 'session_empty',
      nodes: {},
      edges: {},
      observations: [],
      evidence: {},
    };
    setProjects([project]);
    await callIpc('settings:update', 'includeDiagnosticReport', true);

    const result = await callIpc('projects:package', 'empty-provenance-manifest', outputDir);

    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 0);
    assert.equal(result.embeddedCount, 0);
    assert.equal(result.totalFiles, 0);
    assert.deepEqual(result.errors, []);

    const manifest = readManifest(outputDir, 'Empty Provenance Manifest');
    assert.equal('project' in manifest, false);
    assert.equal(manifest.package.copiedCount, 0);
    assert.equal(manifest.package.embeddedCount, 0);
    assert.equal(manifest.package.totalFiles, 0);
    assert.equal(manifest.package.errorCount, 0);
    assert.deepEqual(manifest.package.errorCategories, {});
    assert.deepEqual(manifest.nodes, []);
    assert.deepEqual(manifest.edges, []);
    assert.deepEqual(manifest.evidence, []);
    assert.equal(manifest.warnings.includes('No package provenance edges were available for this package.'), true);
    assert.equal(JSON.stringify(manifest).includes('session_empty'), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('existing destination collision publishes diagnostics to a deterministic sibling', async () => {
  const tmpRoot = makeTempDir();
  try {
    const sourcePath = path.join(tmpRoot, 'logo.ai');
    const outputDir = path.join(tmpRoot, 'out');
    const destFolder = packageFolder(outputDir, 'Manifest Write Failure');
    const diagnosticsFolder = path.join(destFolder, 'Crate Diagnostics');
    fs.mkdirSync(destFolder, { recursive: true });
    fs.writeFileSync(sourcePath, Buffer.from('logo bytes'));
    fs.mkdirSync(diagnosticsFolder, { recursive: true });
    fs.mkdirSync(path.join(diagnosticsFolder, 'crate-provenance.json'));

    setProjects([
      makeProject('manifest-write-failure', 'Manifest Write Failure', [{
        path: sourcePath,
        name: 'logo.ai',
        ext: '.ai',
        addedAt: Date.now(),
        source: 'manual-browse',
      }]),
    ]);
    await callIpc('settings:update', 'includeDiagnosticReport', true);

    const result = await callIpc('projects:package', 'manifest-write-failure', outputDir);

    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.embeddedCount, 0);
    assert.deepEqual(result.errors, []);
    assert.notEqual(result.folderPath, destFolder);
    assert.match(path.basename(result.folderPath), /_1$/);
    assert.equal(fs.readFileSync(path.join(result.folderPath, 'logo.ai'), 'utf8'), 'logo bytes');
    assert.equal(fs.existsSync(path.join(result.folderPath, 'Crate Diagnostics', 'crate-provenance.json')), true);
    assert.equal(fs.existsSync(rootManifestPath(outputDir, 'Manifest Write Failure')), false);
    assert.equal(fs.statSync(path.join(diagnosticsFolder, 'crate-provenance.json')).isDirectory(), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('destination collision avoids a symlinked diagnostics folder without escaping package root', async () => {
  const tmpRoot = makeTempDir();
  try {
    const sourcePath = path.join(tmpRoot, 'logo.ai');
    const outputDir = path.join(tmpRoot, 'out');
    const destFolder = packageFolder(outputDir, 'Manifest Symlink Safety');
    const diagnosticsFolder = path.join(destFolder, 'Crate Diagnostics');
    const symlinkTarget = path.join(tmpRoot, 'outside-diagnostics');
    fs.mkdirSync(destFolder, { recursive: true });
    fs.mkdirSync(symlinkTarget, { recursive: true });
    fs.writeFileSync(sourcePath, Buffer.from('logo bytes'));
    fs.symlinkSync(symlinkTarget, diagnosticsFolder, 'dir');

    setProjects([
      makeProject('manifest-symlink-safety', 'Manifest Symlink Safety', [{
        path: sourcePath,
        name: 'logo.ai',
        ext: '.ai',
        addedAt: Date.now(),
        source: 'manual-browse',
      }]),
    ]);
    await callIpc('settings:update', 'includeDiagnosticReport', true);

    const result = await callIpc('projects:package', 'manifest-symlink-safety', outputDir);

    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.embeddedCount, 0);
    assert.equal(result.totalFiles, 1);
    assert.deepEqual(result.errors, []);
    assert.notEqual(result.folderPath, destFolder);
    assert.match(path.basename(result.folderPath), /_1$/);
    assert.equal(fs.readFileSync(path.join(result.folderPath, 'logo.ai'), 'utf8'), 'logo bytes');
    assert.equal(fs.existsSync(path.join(result.folderPath, 'Crate Diagnostics', 'crate-provenance.json')), true);
    assert.equal(fs.existsSync(rootManifestPath(outputDir, 'Manifest Symlink Safety')), false);
    assert.equal(fs.existsSync(path.join(symlinkTarget, 'crate-provenance.json')), false);
    assert.equal(fs.lstatSync(diagnosticsFolder).isSymbolicLink(), true);
    assert.equal(JSON.stringify(result).includes(symlinkTarget), false);

  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('pre-package PSD embedded extraction sanitizes unsafe names and preserves duplicate bytes', async () => {
  const tmpRoot = makeTempDir();
  try {
    const psdPath = path.join(tmpRoot, 'source.psd');
    fs.writeFileSync(psdPath, Buffer.from('parent psd bytes'));
    currentPsdFixture = { children: [], linkedFiles: fixtureLinkedFiles() };

    setProjects([
      makeProject('psd-prepackage-safety', 'PSD Prepackage Safety', [{
        path: psdPath,
        name: 'source.psd',
        ext: '.psd',
        addedAt: Date.now(),
        source: 'manual',
      }]),
    ]);

    const result = await callIpc('projects:pre-package-scan', 'psd-prepackage-safety');
    assert.equal(result.newCount, 4);

    const embeddedFiles = result.files.filter(file => file.source === 'psd-embedded');
    assert.deepEqual(
      embeddedFiles.map(file => path.basename(file.path)).sort(),
      ['absolute-path-like.png', 'duplicate.png', 'duplicate_1.png', 'escape.png']
    );

    const extractDir = path.resolve(path.join(os.tmpdir(), 'crate-psd-extract-psd-prepackage-safety'));
    for (const file of embeddedFiles) {
      const resolvedPath = path.resolve(file.path);
      assert.ok(resolvedPath.startsWith(extractDir + path.sep), `${resolvedPath} should stay in PSD extract dir`);
      assert.equal(path.basename(file.path).includes('..'), false);
    }

    const byName = new Map(embeddedFiles.map(file => [path.basename(file.path), file.path]));
    assert.equal(fs.readFileSync(byName.get('escape.png'), 'utf8'), 'embedded escape bytes');
    assert.equal(fs.readFileSync(byName.get('absolute-path-like.png'), 'utf8'), 'embedded absolute bytes');
    assert.equal(fs.readFileSync(byName.get('duplicate.png'), 'utf8'), 'embedded duplicate one');
    assert.equal(fs.readFileSync(byName.get('duplicate_1.png'), 'utf8'), 'embedded duplicate two');
  } finally {
    fs.rmSync(path.join(os.tmpdir(), 'crate-psd-extract-psd-prepackage-safety'), { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('repeated pre-package scans retain distinct embedded PSBs without accumulating exports', async () => {
  const tmpRoot = makeTempDir();
  const projectId = 'psd-repeat-prepackage';
  const extractDir = path.join(os.tmpdir(), 'crate-psd-extract-' + projectId);
  try {
    const psdPath = path.join(tmpRoot, 'mockup.psd');
    fs.writeFileSync(psdPath, 'unchanged saved mockup');
    currentPsdFixture = { children: [], linkedFiles: [
      { name: '[YOUR IMAGE HERE].psb', data: Buffer.from('first embedded object') },
      { name: '[YOUR IMAGE HERE].psb', data: Buffer.from('second embedded object') },
    ] };
    setProjects([makeProject(projectId, 'Repeated PSD Scan', [{
      path: psdPath, name: 'mockup.psd', ext: '.psd', source: 'manual', addedAt: Date.now(),
    }])]);
    const first = await callIpc('projects:pre-package-scan', projectId);
    assert.equal(first.newCount, 2);
    const firstRows = getStoredProject(projectId).files.filter(row => row.source === 'psd-embedded');
    assert.equal(firstRows.length, 2, 'same-name embedded objects remain distinct');
    const firstPaths = firstRows.map(row => row.path);
    // Model persistence across restart; reuse must not rely on an in-memory map.
    setProjects(JSON.parse(JSON.stringify(storeInstance.get('projects'))));
    for (let scan = 0; scan < 3; scan++) {
      const next = await callIpc('projects:pre-package-scan', projectId);
      assert.equal(next.newCount, 0, 'unchanged saved resources are already present');
      assert.deepEqual(getStoredProject(projectId).files.filter(row => row.source === 'psd-embedded').map(row => row.path), firstPaths);
      assert.deepEqual(fs.readdirSync(extractDir).sort(), firstPaths.map(file => path.basename(file)).sort());
    }
    assert.deepEqual(firstPaths.map(file => fs.readFileSync(file, 'utf8')), ['first embedded object', 'second embedded object']);
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('ordinary scan-on-open reruns the real extractor after five seconds and retains resource identity', async () => {
  const tmpRoot = makeTempDir(), projectId = 'psd-ordinary-repeat';
  const extractDir = path.join(os.tmpdir(), 'crate-psd-extract-' + projectId);
  const originalNow = Date.now;
  let now = originalNow(); Date.now = () => now;
  try {
    const source = path.join(tmpRoot, 'mockup.psd'); fs.writeFileSync(source, 'unchanged saved mockup');
    currentPsdFixture = { children: [], linkedFiles: [
      { name: 'Same Name.psb', data: Buffer.from('object one') },
      { name: 'Same Name.psb', data: Buffer.from('object two') },
    ] };
    setProjects([makeProject(projectId, 'Ordinary Repeated PSD', [{
      path: source, name: 'mockup.psd', ext: '.psd', source: 'manual', addedAt: now,
    }])]);
    const scan = () => psdSafetyHooks.runScanOnOpen(projectId, source);
    const before = psdParserReadCount;
    assert.deepEqual(await scan(), { success: true });
    assert.equal(psdParserReadCount, before + 1, 'real ordinary extractor parsed the PSD');
    const paths = getStoredProject(projectId).files.filter(row => row.source === 'psd-embedded').map(row => row.path);
    assert.equal(paths.length, 2);
    now += 4999;
    assert.deepEqual(await scan(), { success: true, skipped: 'ordinary-scan-debounced' });
    assert.equal(psdParserReadCount, before + 1, 'the production five-second guard remains active');
    now += 2;
    assert.deepEqual(await scan(), { success: true });
    assert.equal(psdParserReadCount, before + 2, 'crossing five seconds actually reparses');
    assert.deepEqual(getStoredProject(projectId).files.filter(row => row.source === 'psd-embedded').map(row => row.path), paths);
    assert.deepEqual(fs.readdirSync(extractDir).sort(), paths.map(file => path.basename(file)).sort());
    setProjects(JSON.parse(JSON.stringify(storeInstance.get('projects'))));
    now += 5001;
    assert.deepEqual(await scan(), { success: true });
    assert.equal(psdParserReadCount, before + 3);
    assert.deepEqual(getStoredProject(projectId).files.filter(row => row.source === 'psd-embedded').map(row => row.path), paths);
    assert.deepEqual(paths.map(file => fs.readFileSync(file, 'utf8')), ['object one', 'object two']);
  } finally {
    Date.now = originalNow;
    fs.rmSync(extractDir, { recursive: true, force: true }); fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('ordinary scan-on-open retains real parsed saved PSD resources across the debounce', async () => {
  const actual = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
  await withOrdinaryPsdFixture('actual-parser', async f => {
    const makeSavedPsd = first => actual.writePsdBuffer({ width: 1, height: 1, linkedFiles: [
      { id: '11111111-1111-4111-8111-111111111111', name: 'Actual.psb', data: Buffer.from(first) },
      { id: '22222222-2222-4222-8222-222222222222', name: 'Actual.psb', data: Buffer.from('second real embedded resource') },
    ] });
    fs.writeFileSync(f.source, makeSavedPsd('first real embedded resource'));
    currentPsdFixture = (buffer, options) => actual.readPsd(buffer, options);
    assert.deepEqual(await f.scan(), { success: true });
    const paths = f.rows().map(row => row.path); assert.equal(paths.length, 2);
    assert.deepEqual(paths.map(file => fs.readFileSync(file, 'utf8')), ['first real embedded resource', 'second real embedded resource']);
    const reads = psdParserReadCount;
    assert.deepEqual(await f.scan(), { success: true, skipped: 'ordinary-scan-debounced' });
    assert.equal(psdParserReadCount, reads);
    f.advance(); assert.deepEqual(await f.scan(), { success: true });
    assert.equal(psdParserReadCount, reads + 1);
    assert.deepEqual(f.rows().map(row => row.path), paths);
    fs.writeFileSync(f.source, makeSavedPsd('edited real embedded resource')); f.advance();
    assert.deepEqual(await f.scan(), { success: true });
    const changedPaths = f.rows().map(row => row.path); assert.equal(changedPaths.length, 4);
    assert.deepEqual(changedPaths.slice(2).map(file => fs.readFileSync(file, 'utf8')), ['edited real embedded resource', 'second real embedded resource']);
    f.persist(); f.advance(); await f.scan();
    assert.deepEqual(f.rows().map(row => row.path), changedPaths);
    assert.equal(fs.readdirSync(f.extractDir).length, 4);
  });
});

test('real worker admission followed by ordinary pre-package IPC retains root and layered resources', async () => {
  const actual = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
  const { createAddFilesScanLease } = require('../parsers/add-files-operation');
  await withOrdinaryPsdFixture('worker-prepackage-ipc', async f => {
    const external = path.join(f.tmpRoot, 'Linked.psb'); fs.writeFileSync(external, 'external linked PSB');
    const externalId = '11111111-1111-4111-8111-111111111111';
    fs.writeFileSync(f.source, actual.writePsdBuffer({ width: 1, height: 1, linkedFiles: [
      { id: externalId, name: 'Linked.psb', childDocumentID: '', linkedFile: {
        fileSize: 19, name: 'Linked.psb', fullPath: external, originalPath: external, relativePath: '',
      } },
      { id: '22222222-2222-4222-8222-222222222222', name: 'Object.psb', data: Buffer.from('root embedded bytes') },
    ], children: [{ name: 'layer carrier', linkedFiles: [
      { id: '33333333-3333-4333-8333-333333333333', name: 'Object.psb', data: Buffer.from('layer embedded bytes') },
    ] }] }));
    currentPsdFixture = (buffer, options) => actual.readPsd(buffer, options);
    const lease = createAddFilesScanLease({ timeoutMs: 10000 });
    try {
      assert.deepEqual(await psdSafetyHooks.runScanOnOpen(f.projectId, f.source, null, null, {
        addFilesAttempt: lease, addFilesScanLease: lease,
      }), { success: true });
    } finally { lease.dispose(); }
    const rows = f.rows(); assert.equal(rows.length, 2);
    assert.equal(rows.filter(row => row.psdResource.layerPath === null).length, 1);
    assert.equal(rows.filter(row => Array.isArray(row.psdResource.layerPath)).length, 1);
    const initialPaths = rows.map(row => row.path), initialNames = fs.readdirSync(f.extractDir).sort();
    assert.ok(f.current().files.some(row => row.path === external));
    for (let scan = 0; scan < 3; scan++) {
      const result = await callIpc('projects:pre-package-scan', f.projectId);
      assert.equal(result.newCount, 0);
      assert.deepEqual(f.rows().map(row => row.path), initialPaths);
      assert.deepEqual(fs.readdirSync(f.extractDir).sort(), initialNames);
    }
    const root = rows.find(row => row.psdResource.layerPath === null);
    fs.unlinkSync(root.path);
    assert.equal((await callIpc('projects:pre-package-scan', f.projectId)).newCount, 0);
    assert.deepEqual(f.rows().map(row => row.path), initialPaths, 'worker-root cache loss preserves admitted identity and locator');
    assert.deepEqual(fs.readdirSync(f.extractDir).sort(), initialNames);
    assert.deepEqual(initialPaths.map(file => fs.readFileSync(file, 'utf8')).sort(), ['layer embedded bytes', 'root embedded bytes']);
    assert.equal(psdWorkerChildren.size, 0);
  });
});

async function withOrdinaryPsdFixture(suffix, body) {
  const tmpRoot = makeTempDir(), projectId = 'psd-ordinary-' + suffix;
  const extractDir = path.join(os.tmpdir(), 'crate-psd-extract-' + projectId);
  const originalNow = Date.now;
  let now = originalNow(); Date.now = () => now;
  try {
    const source = path.join(tmpRoot, 'mockup.psd'); fs.writeFileSync(source, 'saved ordinary mockup');
    currentPsdFixture = { children: [], linkedFiles: [{ name: 'Object.psb', data: Buffer.from('original embedded bytes') }] };
    setProjects([makeProject(projectId, 'Ordinary PSD Admission', [{
      path: source, name: 'mockup.psd', ext: '.psd', source: 'manual', addedAt: now,
    }])]);
    const f = { tmpRoot, projectId, source, extractDir,
      advance() { now += 5001; },
      current: () => getStoredProject(projectId),
      rows: () => getStoredProject(projectId).files.filter(row => row.source === 'psd-embedded'),
      scan: (file = source) => psdSafetyHooks.runScanOnOpen(projectId, file),
      persist(project = getStoredProject(projectId)) { setProjects(JSON.parse(JSON.stringify([project]))); },
    };
    await body(f);
  } finally {
    Date.now = originalNow;
    fs.rmSync(extractDir, { recursive: true, force: true }); fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

test('ordinary scan-on-open preserves exclusion through restart, parser failure, retry and restore', async () => {
  await withOrdinaryPsdFixture('retry', async f => {
    assert.deepEqual(await f.scan(), { success: true });
    const row = f.rows()[0], fixture = currentPsdFixture;
    await callIpcRaw('projects:remove-file', f.projectId, row.fileId || row.path);
    assert.ok(f.current().excludedAssetKeys.includes(row.fileId || row.path));
    f.persist(); f.advance();
    assert.deepEqual(await f.scan(), { success: true });
    assert.deepEqual(f.rows().map(item => item.path), [row.path]);
    assert.ok(f.current().excludedAssetKeys.includes(row.fileId || row.path));
    currentPsdFixture = new Error('synthetic ordinary parser failure'); f.advance();
    await f.scan();
    assert.deepEqual(f.rows().map(item => item.path), [row.path]);
    assert.deepEqual(fs.readdirSync(f.extractDir), [path.basename(row.path)]);
    currentPsdFixture = fixture; f.advance();
    assert.deepEqual(await f.scan(), { success: true });
    assert.ok(f.current().excludedAssetKeys.includes(row.fileId || row.path));
    await callIpcRaw('projects:remove-file', f.projectId, row.fileId || row.path);
    f.advance(); assert.deepEqual(await f.scan(), { success: true });
    assert.equal(f.current().excludedAssetKeys.includes(row.fileId || row.path), false);
    assert.deepEqual(f.rows().map(item => item.path), [row.path]);
    assert.equal(fs.readFileSync(row.path, 'utf8'), 'original embedded bytes');
  });
});

test('ordinary scan-on-open fresh process reads persisted receipts and exclusion', async t => {
  if (process.env.CRATE_PSD_RESTART_SEED) {
    const project = storeInstance.get('projects')[0];
    const source = project.files.find(row => row.ext === '.psd').path;
    const rows = project.files.filter(row => row.source === 'psd-embedded');
    currentPsdFixture = { children: [], linkedFiles: [{ name: 'Object.psb', data: Buffer.from('original embedded bytes') }] };
    const before = psdParserReadCount;
    assert.deepEqual(await psdSafetyHooks.runScanOnOpen(project.id, source), { success: true });
    assert.equal(psdParserReadCount, before + 1, 'a new process has no old debounce or receipt cache');
    const current = getStoredProject(project.id);
    assert.deepEqual(current.files.filter(row => row.source === 'psd-embedded').map(row => row.path), rows.map(row => row.path));
    assert.deepEqual(current.excludedAssetKeys, project.excludedAssetKeys);
    assert.deepEqual(fs.readdirSync(path.dirname(rows[0].path)), [path.basename(rows[0].path)]);
    return;
  }
  await withOrdinaryPsdFixture('fresh-process', async f => {
    await f.scan(); const row = f.rows()[0];
    await callIpcRaw('projects:remove-file', f.projectId, row.fileId || row.path);
    const seedPath = path.join(f.tmpRoot, 'store-seed.json');
    fs.writeFileSync(seedPath, JSON.stringify(storeInstance.data), { mode: 0o600 });
    const result = runPsdTestInFreshProcess('ordinary scan-on-open fresh process reads persisted receipts and exclusion', seedPath);
    assert.equal(result.error, undefined); assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /# tests 1(?:\n|$)/, 'the selected child test actually ran');
    t.diagnostic(result.stdout);
    t.diagnostic('fresh child process: persisted receipt/exclusion assertions passed; no debounce map or receipt cache inherited');
    assert.equal(fs.readFileSync(row.path, 'utf8'), 'original embedded bytes');
  });
});

test('ordinary scan-on-open removes only newly owned declined exports', async () => {
  await withOrdinaryPsdFixture('declined', async f => {
    const excluded = path.join(f.tmpRoot, 'Excluded.png'); fs.writeFileSync(excluded, 'excluded ordinary image');
    const project = f.current(); project.files.push({ path: excluded, name: 'Excluded.png', ext: '.png',
      source: 'manual', addedAt: Date.now(), projectRole: 'asset' }); f.persist(project);
    await callIpcRaw('projects:remove-file', f.projectId, excluded);
    currentPsdFixture.linkedFiles = [{ name: 'Declined.png', data: Buffer.from('excluded ordinary image') }];
    fs.mkdirSync(f.extractDir, { recursive: true });
    const unrelated = path.join(f.extractDir, 'Unrelated.psb'); fs.writeFileSync(unrelated, 'preexisting bytes');
    for (let scan = 0; scan < 3; scan++) {
      f.advance(); assert.deepEqual(await f.scan(), { success: true });
      assert.equal(f.rows().length, 0);
      assert.deepEqual(fs.readdirSync(f.extractDir), ['Unrelated.psb']);
      assert.equal(fs.readFileSync(unrelated, 'utf8'), 'preexisting bytes');
      assert.equal(fs.readFileSync(excluded, 'utf8'), 'excluded ordinary image');
      assert.ok(f.current().excludedAssetKeys.includes(excluded));
    }
  });
});

test('ordinary scan-on-open keeps changed saved PSD bytes separate then stabilizes on retry', async () => {
  await withOrdinaryPsdFixture('saved-edit', async f => {
    await f.scan(); const original = f.rows()[0];
    fs.writeFileSync(f.source, 'changed saved ordinary mockup');
    currentPsdFixture.linkedFiles[0].data = Buffer.from('changed embedded bytes'); f.advance();
    assert.deepEqual(await f.scan(), { success: true });
    const paths = f.rows().map(row => row.path);
    assert.equal(paths.length, 2, 'legacy route preserves an earlier snapshot without guessing cross-save identity');
    assert.equal(paths[0], original.path); assert.notEqual(paths[0], paths[1]);
    assert.deepEqual(paths.map(file => fs.readFileSync(file, 'utf8')), ['original embedded bytes', 'changed embedded bytes']);
    f.persist(); f.advance(); await f.scan();
    assert.deepEqual(f.rows().map(row => row.path), paths);
    assert.equal(fs.readdirSync(f.extractDir).length, 2);
  });
});

test('ordinary scan-on-open preserves same-name identical indices, separate parents and legitimate PSBs', async () => {
  await withOrdinaryPsdFixture('distinct', async f => {
    const second = path.join(f.tmpRoot, 'second.psd'), linked = path.join(f.tmpRoot, 'Linked.psb');
    const selected = path.join(f.tmpRoot, 'Selected.psb');
    fs.copyFileSync(f.source, second); fs.writeFileSync(linked, 'linked PSB bytes'); fs.writeFileSync(selected, 'selected PSB bytes');
    const project = f.current(); project.files.push(
      { path: second, name: 'second.psd', ext: '.psd', source: 'manual', addedAt: Date.now() },
      { path: selected, name: 'Selected.psb', ext: '.psb', source: 'manual-browse', addedAt: Date.now() });
    f.persist(project);
    currentPsdFixture.children = [{ linkedFile: { fullPath: linked } }];
    currentPsdFixture.linkedFiles.push({ name: 'Object.psb', data: Buffer.from('original embedded bytes') });
    await f.scan(); await f.scan(second);
    const paths = f.rows().map(row => row.path); assert.equal(paths.length, 4);
    assert.equal(new Set(paths).size, 4, 'same bytes do not collapse distinct records or parents');
    for (const file of [linked, selected]) assert.equal(f.current().files.filter(row => row.path === file).length, 1);
    f.advance(); await f.scan(); await f.scan(second);
    assert.deepEqual(f.rows().map(row => row.path), paths); assert.equal(fs.readdirSync(f.extractDir).length, 4);
    assert.equal(fs.readFileSync(linked, 'utf8'), 'linked PSB bytes');
    assert.equal(fs.readFileSync(selected, 'utf8'), 'selected PSB bytes');
  });
});

for (const missing of [false, true]) {
  test(`ordinary scan-on-open handles receiptless legacy ${missing ? 'missing' : 'present'} output conservatively`, async () => {
    await withOrdinaryPsdFixture('legacy-' + missing, async f => {
      await f.scan(); const project = f.current(), row = f.rows()[0];
      delete row.psdExtractionReceipt; f.persist(project);
      if (missing) fs.unlinkSync(row.path);
      for (let scan = 0; scan < 4; scan++) { f.advance(); assert.deepEqual(await f.scan(), { success: true }); }
      const paths = f.rows().map(item => item.path);
      assert.equal(paths.length, 2, 'retain the unbound legacy row and one new bound snapshot');
      assert.equal(paths[0], row.path); assert.notEqual(paths[0], paths[1]);
      assert.deepEqual(paths.map(file => fs.readFileSync(file, 'utf8')), ['original embedded bytes', 'original embedded bytes']);
      assert.equal(fs.readdirSync(f.extractDir).length, 2);
    });
  });
}

async function makePsbRescanFixture(suffix) {
  const tmpRoot = makeTempDir(), projectId = 'psd-rescan-' + suffix;
  const extractDir = path.join(os.tmpdir(), 'crate-psd-extract-' + projectId);
  const psdPath = path.join(tmpRoot, 'mockup.psd');
  fs.writeFileSync(psdPath, 'saved mockup');
  currentPsdFixture = { children: [], linkedFiles: [
    { name: 'Smart Object.psb', data: Buffer.from('embedded object bytes') },
  ] };
  setProjects([makeProject(projectId, 'PSB Rescan', [{
    path: psdPath, name: 'mockup.psd', ext: '.psd', source: 'manual', addedAt: Date.now(),
  }])]);
  await callIpc('projects:pre-package-scan', projectId);
  return { tmpRoot, projectId, extractDir, psdPath,
    current: () => getStoredProject(projectId),
    scan: () => callIpc('projects:pre-package-scan', projectId),
    cleanup() { fs.rmSync(extractDir, { recursive: true, force: true }); fs.rmSync(tmpRoot, { recursive: true, force: true }); },
  };
}

test('pre-package rescan cleans declined embedded exports without bypassing content exclusion', async () => {
  const tmpRoot = makeTempDir(), projectId = 'psd-rescan-declined';
  const extractDir = path.join(os.tmpdir(), 'crate-psd-extract-' + projectId);
  try {
    const source = path.join(tmpRoot, 'mockup.psd'), excluded = path.join(tmpRoot, 'Excluded.png');
    fs.writeFileSync(source, 'saved mockup'); fs.writeFileSync(excluded, 'excluded image bytes');
    fs.mkdirSync(extractDir, { recursive: true });
    const unrelated = path.join(extractDir, 'Unrelated.psb'); fs.writeFileSync(unrelated, 'unrelated cache bytes');
    currentPsdFixture = { children: [], linkedFiles: [
      { name: 'Embedded.png', data: Buffer.from('excluded image bytes') },
    ] };
    setProjects([makeProject(projectId, 'Declined PSD Export', [
      { path: source, name: 'mockup.psd', ext: '.psd', source: 'manual', addedAt: Date.now() },
      { path: excluded, name: 'Excluded.png', ext: '.png', source: 'manual', addedAt: Date.now(), projectRole: 'asset' },
    ])]);
    await callIpcRaw('projects:remove-file', projectId, excluded);
    assert.ok(getStoredProject(projectId).excludedAssetKeys.includes(excluded));
    for (let scan = 0; scan < 3; scan++) {
      assert.equal((await callIpc('projects:pre-package-scan', projectId)).newCount, 0);
      assert.equal(getStoredProject(projectId).files.some(row => row.source === 'psd-embedded'), false);
      assert.deepEqual(fs.readdirSync(extractDir), ['Unrelated.psb'], 'clean only this invocation\'s declined outputs');
      assert.equal(fs.readFileSync(unrelated, 'utf8'), 'unrelated cache bytes');
      assert.equal(fs.readFileSync(excluded, 'utf8'), 'excluded image bytes');
    }
  } finally { fs.rmSync(extractDir, { recursive: true, force: true }); fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('pre-package rescan preserves exclude/restore identity and package bytes', async () => {
  const f = await makePsbRescanFixture('excluded');
  try {
    const row = f.current().files.find(row => row.source === 'psd-embedded');
    await callIpcRaw('projects:remove-file', f.projectId, row.fileId || row.path);
    assert.ok(f.current().excludedAssetKeys.includes(row.fileId || row.path));
    assert.equal((await f.scan()).newCount, 0);
    assert.equal(f.current().files.filter(item => item.source === 'psd-embedded').length, 1);
    assert.ok(f.current().excludedAssetKeys.includes(row.fileId || row.path));
    await callIpcRaw('projects:remove-file', f.projectId, row.fileId || row.path);
    assert.equal((await f.scan()).newCount, 0);
    assert.equal(f.current().excludedAssetKeys.includes(row.fileId || row.path), false);
    const out = path.join(f.tmpRoot, 'out'); fs.mkdirSync(out);
    const result = await callIpc('projects:package', f.projectId, out);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 2);
    assert.equal(fs.readFileSync(path.join(result.folderPath, row.name), 'utf8'), 'embedded object bytes');
  } finally { f.cleanup(); }
});

test('pre-package rescan recognizes existing worker resource receipts and pending membership', async () => {
  const f = await makePsbRescanFixture('worker');
  try {
    const project = f.current(), row = project.files.find(row => row.source === 'psd-embedded');
    // Model the production worker's already-persisted root-resource descriptor.
    row.psdResource = { ...row.psdExtractionReceipt, producerId: 'synthetic-root-id', current: true };
    delete row.psdExtractionReceipt;
    project.files = project.files.filter(item => item !== row);
    project.pendingFiles = [row]; setProjects([project]);
    assert.equal((await f.scan()).newCount, 0);
    assert.deepEqual(f.current().pendingFiles.map(item => item.path), [row.path]);
    assert.equal(fs.readdirSync(f.extractDir).length, 1);
  } finally { f.cleanup(); }
});

test('pre-package cleanup retains an owned export already referenced by a legacy row', async () => {
  const f = await makePsbRescanFixture('legacy-locator');
  try {
    const project = f.current(), row = project.files.find(row => row.source === 'psd-embedded');
    delete row.psdExtractionReceipt; setProjects([project]);
    fs.unlinkSync(row.path);
    assert.equal((await f.scan()).newCount, 0);
    assert.equal(fs.readFileSync(row.path, 'utf8'), 'embedded object bytes');
    assert.equal(f.current().files.filter(item => item.path === row.path).length, 1);
  } finally { f.cleanup(); }
});

for (const replacement of ['changed-bytes', 'oversized', 'symlink', 'hardlink']) {
  test(`pre-package rescan refuses ${replacement} output without minting another asset`, async () => {
    const f = await makePsbRescanFixture(replacement);
    try {
      const row = f.current().files.find(row => row.source === 'psd-embedded');
      const external = path.join(f.tmpRoot, 'external.psb'); fs.writeFileSync(external, 'external bytes');
      if (replacement === 'changed-bytes') fs.writeFileSync(row.path, Buffer.alloc(fs.statSync(row.path).size, 120));
      else if (replacement === 'oversized') fs.writeFileSync(row.path, Buffer.alloc(1024 * 1024, 120));
      else {
        fs.unlinkSync(row.path);
        if (replacement === 'symlink') fs.symlinkSync(external, row.path);
        if (replacement === 'hardlink') fs.linkSync(external, row.path);
      }
      assert.equal((await f.scan()).newCount, 0);
      assert.equal(f.current().files.filter(item => item.source === 'psd-embedded').length, 1);
      assert.equal(fs.readdirSync(f.extractDir).length, 1);
      assert.equal(fs.readFileSync(external, 'utf8'), 'external bytes');
      assert.ok(f.current().workingSourceRelationshipHolds?.some(hold =>
        hold.reason === 'psd-extraction-receipt-unverified' && hold.sourcePath === row.path));
      const review = await callIpcRaw('projects:prepare-package-review', f.projectId);
      assert.equal(review.materializable, false);
      assert.equal(review.token, undefined);
    } finally { f.cleanup(); }
  });
}

test('Opus review: invalid reused output blocks packaging until its bytes are repaired', async t => {
  const f = await makePsbRescanFixture('opus-invalid');
  try {
    const row = f.current().files.find(row => row.source === 'psd-embedded');
    const original = fs.readFileSync(row.path);
    const priorReview = await callIpcRaw('projects:prepare-package-review', f.projectId);
    assert.ok(priorReview.token);
    fs.writeFileSync(row.path, Buffer.alloc(original.length, 120));
    await f.scan();
    const out = path.join(f.tmpRoot, 'out'); fs.mkdirSync(out);
    const refused = await callIpc('projects:package', f.projectId, out);
    t.diagnostic('invalid cache package result: ' + JSON.stringify({ success: refused.success, copiedCount: refused.copiedCount }));
    assert.equal(refused.materializable, false, 'an unverified existing member must not become package input');
    assert.equal(refused.token, undefined);
    assert.equal((await callIpcRaw('projects:package', f.projectId, out, priorReview.token)).error, 'package_review_stale');
    assert.ok(f.current().workingSourceRelationshipHolds?.length, 'the refusal persists beyond the scan');
    setProjects(JSON.parse(JSON.stringify([f.current()])));
    assert.equal((await callIpc('projects:package', f.projectId, out)).materializable, false);
    fs.writeFileSync(row.path, original);
    await f.scan();
    assert.equal((await callIpc('projects:package', f.projectId, out)).success, true);
  } finally { f.cleanup(); }
});

for (const route of ['ordinary', 'pre-package']) for (const mode of ['invalid-bytes', 'ambiguous']) {
  test(`Opus review: ${route} ${mode} receipt retains discovery of unrelated PSD resources`, async () => {
    const f = await makePsbRescanFixture('opus-discovery-' + route + '-' + mode);
    try {
      const project = f.current(), row = project.files.find(row => row.source === 'psd-embedded');
      if (mode === 'invalid-bytes') fs.writeFileSync(row.path, Buffer.alloc(fs.statSync(row.path).size, 120));
      else {
        const duplicate = path.join(f.extractDir, 'Ambiguous-Object.psb'); fs.copyFileSync(row.path, duplicate);
        project.pendingFiles.push({ ...row, path: duplicate, name: path.basename(duplicate), fileId: 'separate-ambiguous-row' });
        setProjects([project]);
      }
      // Same saved bytes/receipt, but these records were not previously admitted.
      const linked = path.join(f.tmpRoot, 'Linked.psb'); fs.writeFileSync(linked, 'independent linked bytes');
      currentPsdFixture.children = [{ linkedFile: { fullPath: linked } }];
      currentPsdFixture.linkedFiles.push({ name: 'Independent.psb', data: Buffer.from('independent embedded bytes') });
      if (route === 'ordinary') await psdSafetyHooks.runScanOnOpen(f.projectId, f.psdPath);
      else await f.scan();
      const files = f.current().files;
      assert.ok(files.some(item => item.path === linked), 'linked discovery survives a bad embedded receipt');
      const independent = files.find(item => item.name === 'Independent.psb');
      assert.ok(independent, 'other embedded discovery survives a bad embedded receipt');
      assert.equal(fs.readFileSync(independent.path, 'utf8'), 'independent embedded bytes');
      assert.equal(files.filter(item => item.path === row.path).length, 1);
      assert.ok(f.current().workingSourceRelationshipHolds?.length);
    } finally { f.cleanup(); }
  });
}

for (const route of ['ordinary', 'pre-package']) {
  test(`Opus review: ${route} cleanup retains a normalized legacy member locator`, async () => {
    await withOrdinaryPsdFixture('opus-alias-' + route, async f => {
      await f.scan();
      const project = f.current(), row = f.rows()[0], output = row.path;
      delete row.psdExtractionReceipt;
      row.path = path.dirname(output) + path.sep + '.' + path.sep + path.basename(output);
      f.persist(project); fs.unlinkSync(output); f.advance();
      if (route === 'ordinary') await f.scan();
      else await callIpc('projects:pre-package-scan', f.projectId);
      assert.equal(fs.existsSync(output), true, 'normalized admission retained this regenerated member');
      assert.equal(fs.readFileSync(row.path, 'utf8'), 'original embedded bytes');
      assert.equal(f.rows().length, 1);
    });
  });
}

test('Opus review: ordinary cleanup retains a regenerated legacy member after its parent is removed before admission', async t => {
  await withOrdinaryPsdFixture('opus-parent-removed', async f => {
    await f.scan();
    const project = f.current(), row = f.rows()[0];
    delete row.psdExtractionReceipt; f.persist(project); fs.unlinkSync(row.path); f.advance();
    const originalUnlink = fs.unlinkSync;
    let interleaved = false;
    const mock = t.mock.method(fs, 'unlinkSync', function(file) {
      const result = originalUnlink.call(fs, file);
      if (!interleaved && path.dirname(file) === f.extractDir && file !== row.path && fs.existsSync(row.path)) {
        interleaved = true;
        const current = f.current();
        current.files = current.files.filter(item => item.path !== f.source);
        f.persist(current);
      }
      return result;
    });
    try { await f.scan(); } finally { mock.mock.restore(); }
    assert.equal(interleaved, true, 'parent removal ran after promotion and before the canonical admission');
    assert.equal(f.current().files.some(item => item.path === f.source), false);
    assert.equal(f.rows().length, 1, 'the independent existing asset member remains');
    assert.equal(fs.existsSync(row.path), true, 'cleanup must preserve its regenerated bytes');
    assert.equal(fs.readFileSync(row.path, 'utf8'), 'original embedded bytes');
  });
});

test('Opus review: an invalid member hold follows asset inclusion independently of its parent', async () => {
  const f = await makePsbRescanFixture('opus-hold-inclusion');
  try {
    const project = f.current(), row = project.files.find(row => row.source === 'psd-embedded');
    fs.writeFileSync(row.path, Buffer.alloc(fs.statSync(row.path).size, 120)); await f.scan();
    const current = f.current(); current.files = current.files.filter(item => item.path !== f.psdPath); setProjects([current]);
    let review = await callIpcRaw('projects:prepare-package-review', f.projectId);
    assert.equal(review.materializable, false, 'removing the parent does not clear an included asset refusal');
    await callIpcRaw('projects:remove-file', f.projectId, row.fileId || row.path);
    review = await callIpcRaw('projects:prepare-package-review', f.projectId);
    assert.equal(review.materializable, true, 'the hold is dormant while its exact asset is excluded');
    await callIpcRaw('projects:remove-file', f.projectId, row.fileId || row.path);
    review = await callIpcRaw('projects:prepare-package-review', f.projectId);
    assert.equal(review.materializable, false, 'restoring the unsafe asset restores the refusal');
  } finally { f.cleanup(); }
});

test('Opus review: ordinary cleanup retains a regenerated member in a paused project', async () => {
  await withOrdinaryPsdFixture('opus-paused', async f => {
    await f.scan(); const project = f.current(), row = f.rows()[0];
    delete row.psdExtractionReceipt; project.status = 'paused';
    f.persist(project); fs.unlinkSync(row.path); f.advance();
    await f.scan();
    assert.equal(f.current().status, 'paused');
    assert.equal(f.rows().length, 1);
    assert.equal(fs.readFileSync(row.path, 'utf8'), 'original embedded bytes');
  });
});

async function withMissingReceiptedPsd(suffix, body) {
  const actual = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
  await withOrdinaryPsdFixture('missing-receipt-' + suffix, async f => {
    fs.writeFileSync(f.source, actual.writePsdBuffer({ width: 1, height: 1, linkedFiles: [{
      id: '11111111-1111-4111-8111-111111111111', name: 'Object.psb', data: Buffer.from('original embedded bytes'),
    }] }));
    currentPsdFixture = (buffer, options) => actual.readPsd(buffer, options);
    await f.scan(); const row = f.rows()[0]; assert.ok(row.psdExtractionReceipt);
    fs.unlinkSync(row.path); f.advance();
    await body(f, row);
  });
}

for (const route of ['ordinary', 'pre-package']) for (const persistedHold of [false, true]) {
  test(`missing-cache recovery: ${route} restores an exact receipted locator with prior hold ${persistedHold}`, async () => {
    await withMissingReceiptedPsd(route + '-' + persistedHold, async (f, row) => {
      const identity = row.fileId || row.path;
      if (persistedHold) {
        const project = f.current(); project.workingSourceRelationshipHolds = [
          { reason: 'psd-extraction-receipt-unverified', sourcePath: row.path },
        ]; f.persist(project);
      }
      if (route === 'ordinary') await f.scan(); else await callIpc('projects:pre-package-scan', f.projectId);
      assert.equal(fs.existsSync(row.path), true, 'unchanged saved bytes can recover a unique missing cached member');
      assert.equal(fs.readFileSync(row.path, 'utf8'), 'original embedded bytes');
      assert.deepEqual(f.rows().map(item => item.fileId || item.path), [identity]);
      assert.deepEqual(f.rows().map(item => item.path), [row.path]);
      assert.deepEqual(fs.readdirSync(f.extractDir), [path.basename(row.path)]);
      const review = await callIpcRaw('projects:prepare-package-review', f.projectId);
      assert.equal(review.materializable, true); assert.ok(review.token);
      const out = path.join(f.tmpRoot, 'out'); fs.mkdirSync(out);
      const result = await callIpc('projects:package', f.projectId, out);
      assert.equal(result.success, true); assert.equal(result.copiedCount, 2);
      assert.equal(fs.readFileSync(path.join(result.folderPath, row.name), 'utf8'), 'original embedded bytes');
    });
  });
}

for (const occupant of ['regular', 'symlink', 'hardlink', 'directory']) {
  test(`missing-cache recovery: an intervening ${occupant} occupant is never overwritten or renamed around`, async t => {
    await withMissingReceiptedPsd('race-' + occupant, async (f, row) => {
      const external = path.join(f.tmpRoot, 'External.psb'); fs.writeFileSync(external, 'foreign bytes');
      const originalLink = fs.linkSync; let interleaved = false;
      const mock = t.mock.method(fs, 'linkSync', function(file, destination, ...args) {
        if (!interleaved && destination === row.path && path.dirname(file) === f.extractDir) {
          interleaved = true;
          if (occupant === 'regular') fs.writeFileSync(row.path, 'foreign bytes', { flag: 'wx' });
          if (occupant === 'symlink') fs.symlinkSync(external, row.path);
          if (occupant === 'hardlink') originalLink.call(fs, external, row.path);
          if (occupant === 'directory') fs.mkdirSync(row.path);
        }
        return originalLink.call(fs, file, destination, ...args);
      });
      try { await callIpc('projects:pre-package-scan', f.projectId); } finally { mock.mock.restore(); }
      assert.equal(interleaved, true, 'occupant arrived after the missing-path check and owned staging');
      assert.deepEqual(fs.readdirSync(f.extractDir), [path.basename(row.path)], 'no suffixed output or owned stage remains');
      assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].path, row.path);
      if (occupant === 'directory') assert.equal(fs.lstatSync(row.path).isDirectory(), true);
      else assert.equal(fs.readFileSync(row.path, 'utf8'), 'foreign bytes');
      if (occupant === 'symlink') assert.equal(fs.lstatSync(row.path).isSymbolicLink(), true);
      if (occupant === 'hardlink') assert.equal(fs.statSync(row.path).ino, fs.statSync(external).ino);
      assert.equal(fs.readFileSync(external, 'utf8'), 'foreign bytes');
      const review = await callIpcRaw('projects:prepare-package-review', f.projectId);
      assert.equal(review.materializable, false); assert.equal(review.token, undefined);
    });
  });
}

test('missing-cache recovery: serialized state reload and repair preserve exclusion until explicit Restore', async () => {
  await withMissingReceiptedPsd('excluded-restart', async (f, row) => {
    const key = row.fileId || row.path;
    await callIpcRaw('projects:remove-file', f.projectId, key);
    assert.ok(f.current().excludedAssetKeys.includes(key));
    f.persist();
    await callIpc('projects:pre-package-scan', f.projectId);
    assert.equal(fs.readFileSync(row.path, 'utf8'), 'original embedded bytes');
    assert.deepEqual(f.rows().map(item => item.fileId || item.path), [key]);
    assert.ok(f.current().excludedAssetKeys.includes(key));
    const out = path.join(f.tmpRoot, 'out'); fs.mkdirSync(out);
    const excluded = await callIpc('projects:package', f.projectId, out);
    assert.equal(excluded.success, true); assert.equal(excluded.copiedCount, 1);
    assert.equal(fs.existsSync(path.join(excluded.folderPath, row.name)), false);
    await callIpcRaw('projects:remove-file', f.projectId, key);
    assert.equal(f.current().excludedAssetKeys.includes(key), false);
    const restored = await callIpc('projects:package', f.projectId, out);
    assert.equal(restored.success, true); assert.equal(restored.copiedCount, 2);
    assert.equal(fs.readFileSync(path.join(restored.folderPath, row.name), 'utf8'), 'original embedded bytes');
  });
});

test('missing-cache recovery: fresh process restores a missing excluded member', async t => {
  const actual = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
  if (process.env.CRATE_PSD_RESTART_SEED) {
    const project = storeInstance.get('projects')[0];
    const source = project.files.find(row => row.ext === '.psd').path;
    const row = project.files.find(row => row.source === 'psd-embedded');
    const key = row.fileId || row.path;
    assert.equal(fs.existsSync(row.path), false);
    assert.ok(project.excludedAssetKeys.includes(key));
    currentPsdFixture = (buffer, options) => actual.readPsd(buffer, options);
    assert.deepEqual(await psdSafetyHooks.runScanOnOpen(project.id, source), { success: true });
    const current = getStoredProject(project.id);
    assert.deepEqual(current.files.filter(item => item.source === 'psd-embedded').map(item => item.fileId || item.path), [key]);
    assert.ok(current.excludedAssetKeys.includes(key));
    assert.equal(fs.readFileSync(row.path, 'utf8'), 'original embedded bytes');
    const out = path.join(path.dirname(source), 'child-out'); fs.mkdirSync(out);
    const excluded = await callIpc('projects:package', project.id, out);
    assert.equal(excluded.success, true); assert.equal(excluded.copiedCount, 1);
    assert.equal(fs.existsSync(path.join(excluded.folderPath, row.name)), false);
    await callIpcRaw('projects:remove-file', project.id, key);
    const restored = await callIpc('projects:package', project.id, out);
    assert.equal(restored.success, true); assert.equal(restored.copiedCount, 2);
    assert.equal(fs.readFileSync(path.join(restored.folderPath, row.name), 'utf8'), 'original embedded bytes');
    return;
  }
  await withMissingReceiptedPsd('fresh-process', async (f, row) => {
    await callIpcRaw('projects:remove-file', f.projectId, row.fileId || row.path);
    const seed = path.join(f.tmpRoot, 'missing-cache-store.json');
    fs.writeFileSync(seed, JSON.stringify(storeInstance.data), { mode: 0o600 });
    const result = runPsdTestInFreshProcess('missing-cache recovery: fresh process restores a missing excluded member', seed);
    assert.equal(result.error, undefined); assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /# tests 1(?:\n|$)/, 'the selected child recovery test actually ran');
    t.diagnostic(result.stdout);
    assert.equal(fs.readFileSync(row.path, 'utf8'), 'original embedded bytes');
    t.diagnostic('fresh process recovered the missing locator from serialized receipt/exclusion and preserved explicit Restore semantics');
  });
});

test('missing-cache recovery: changed source bytes refuse a staged repair without leaving an export', async t => {
  await withMissingReceiptedPsd('source-change', async (f, row) => {
    const originalLink = fs.linkSync; let interleaved = false;
    const mock = t.mock.method(fs, 'linkSync', function(file, destination, ...args) {
      if (!interleaved && destination === row.path && path.dirname(file) === f.extractDir) {
        interleaved = true; fs.writeFileSync(f.source, 'different saved source bytes during staging');
      }
      return originalLink.call(fs, file, destination, ...args);
    });
    try { await callIpc('projects:pre-package-scan', f.projectId); } finally { mock.mock.restore(); }
    assert.equal(interleaved, true);
    assert.equal(fs.existsSync(row.path), false); assert.deepEqual(fs.readdirSync(f.extractDir), []);
    assert.equal(f.rows().length, 1);
    assert.equal((await callIpcRaw('projects:prepare-package-review', f.projectId)).materializable, false);
  });
});

test('missing-cache recovery: ambiguous missing receipts do not authorize a guessed locator', async () => {
  await withMissingReceiptedPsd('ambiguous', async (f, row) => {
    const project = f.current();
    project.files.push({ ...row, path: path.join(f.extractDir, 'Other.psb'), name: 'Other.psb', fileId: 'ambiguous-missing-row' });
    f.persist(project);
    await callIpc('projects:pre-package-scan', f.projectId);
    assert.equal(f.rows().length, 2);
    assert.deepEqual(fs.readdirSync(f.extractDir), []);
    assert.equal((await callIpcRaw('projects:prepare-package-review', f.projectId)).materializable, false);
  });
});

test('missing-cache recovery: an in-place edit during repaired-output verification is preserved', async t => {
  await withMissingReceiptedPsd('in-place-edit', async (f, row) => {
    const originalOpen = fs.promises.open; let interleaved = false;
    const mock = t.mock.method(fs.promises, 'open', async function(file, ...args) {
      const handle = await originalOpen.call(fs.promises, file, ...args);
      if (file === row.path) {
        const originalRead = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
          const result = await originalRead(...readArgs);
          if (!interleaved) { interleaved = true; fs.writeFileSync(row.path, 'concurrent user changes'); }
          return result;
        };
      }
      return handle;
    });
    try { await callIpc('projects:pre-package-scan', f.projectId); } finally { mock.mock.restore(); }
    assert.equal(interleaved, true);
    assert.equal(fs.existsSync(row.path), true, 'cleanup loses authority when an existing-member repair is edited');
    assert.equal(fs.readFileSync(row.path, 'utf8'), 'concurrent user changes');
    assert.deepEqual(fs.readdirSync(f.extractDir), [path.basename(row.path)]);
    assert.equal(f.rows().length, 1);
    assert.equal((await callIpcRaw('projects:prepare-package-review', f.projectId)).materializable, false);
  });
});

test('missing-cache recovery: activation retirement cleans only its stage and a fresh paused scan can recover', async t => {
  await withMissingReceiptedPsd('pause-retry', async (f, row) => {
    const originalLink = fs.linkSync; let interleaved = false;
    const mock = t.mock.method(fs, 'linkSync', function(file, destination, ...args) {
      if (!interleaved && destination === row.path && path.dirname(file) === f.extractDir) {
        interleaved = true; const project = f.current(); project.status = 'paused'; f.persist(project);
      }
      return originalLink.call(fs, file, destination, ...args);
    });
    try { await f.scan(); } finally { mock.mock.restore(); }
    assert.equal(interleaved, true); assert.equal(f.current().status, 'paused');
    assert.equal(fs.existsSync(row.path), false); assert.deepEqual(fs.readdirSync(f.extractDir), []);
    f.advance(); await f.scan();
    assert.equal(f.current().status, 'paused'); assert.equal(f.rows().length, 1);
    assert.equal(fs.readFileSync(row.path, 'utf8'), 'original embedded bytes');
  });
});

test('Opus v4 risk: case-folded retention requires a member to read the owned inode', async t => {
  await withOrdinaryPsdFixture('case-folded-inode', async f => {
    await f.scan(); const project = f.current(), row = f.rows()[0], output = row.path;
    delete row.psdExtractionReceipt;
    row.path = path.join(path.dirname(output), path.basename(output).toUpperCase());
    f.persist(project); fs.unlinkSync(output); f.advance();
    const originalLink = fs.linkSync; let interleaved = false, aliases = false, foreignIdentity;
    const mock = t.mock.method(fs, 'linkSync', function(file, destination, ...args) {
      if (!interleaved && destination === output) {
        interleaved = true; fs.writeFileSync(row.path, 'concurrent independent bytes', { flag: 'wx' });
        aliases = fs.existsSync(output); foreignIdentity = fs.statSync(row.path);
      }
      return originalLink.call(fs, file, destination, ...args);
    });
    try { await f.scan(); } finally { mock.mock.restore(); }
    assert.equal(interleaved, true);
    assert.equal(fs.readFileSync(row.path, 'utf8'), 'concurrent independent bytes');
    assert.equal(fs.statSync(row.path).ino, foreignIdentity.ino);
    if (aliases) {
      assert.equal(f.rows().length, 2, 'a real case-insensitive collision uses the existing exclusive suffix retry');
      assert.equal(fs.readdirSync(f.extractDir).length, 2);
    } else {
      assert.deepEqual(f.rows().map(item => item.path), [row.path]);
      assert.deepEqual(fs.readdirSync(f.extractDir), [path.basename(row.path)], 'a different case-sensitive inode cannot retain an unreferenced export');
      assert.equal(fs.existsSync(output), false);
    }
  });
});

test('Opus v4 risk: a retired receiptless repair leaves the prior missing state and a fresh paused scan recovers', async t => {
  await withOrdinaryPsdFixture('retired-receiptless', async f => {
    await f.scan(); const project = f.current(), row = f.rows()[0];
    delete row.psdExtractionReceipt; f.persist(project); fs.unlinkSync(row.path); f.advance();
    const originalLink = fs.linkSync; let interleaved = false;
    const mock = t.mock.method(fs, 'linkSync', function(file, destination, ...args) {
      if (!interleaved && destination === row.path) {
        interleaved = true; const current = f.current(); current.status = 'paused'; f.persist(current);
      }
      return originalLink.call(fs, file, destination, ...args);
    });
    try { await f.scan(); } finally { mock.mock.restore(); }
    assert.equal(interleaved, true); assert.equal(f.current().status, 'paused');
    assert.equal(fs.existsSync(row.path), false, 'retirement cleans its new output; no preexisting bytes existed');
    assert.equal(f.rows().length, 1);
    f.advance(); await f.scan();
    assert.equal(fs.readFileSync(row.path, 'utf8'), 'original embedded bytes');
    assert.equal(f.current().status, 'paused'); assert.equal(f.rows().length, 1);
  });
});

test('Opus v4 risk: source changes during validation preserve the verified historical member and invalidate prior review', async t => {
  const actual = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
  await withMissingReceiptedPsd('source-change-reuse', async (f, row) => {
    fs.writeFileSync(row.path, 'original embedded bytes');
    const before = await callIpcRaw('projects:prepare-package-review', f.projectId); assert.ok(before.token);
    const project = f.current(); project.workingSourceRelationshipHolds = [
      { reason: 'psd-extraction-receipt-unverified', sourcePath: row.path },
    ]; f.persist(project);
    const changed = actual.writePsdBuffer({ width: 1, height: 1, linkedFiles: [{
      id: '11111111-1111-4111-8111-111111111111', name: 'Object.psb', data: Buffer.from('changed saved embedded bytes'),
    }] });
    const originalOpen = fs.promises.open; let interleaved = false;
    const mock = t.mock.method(fs.promises, 'open', async function(file, ...args) {
      const handle = await originalOpen.call(fs.promises, file, ...args);
      if (file === row.path) {
        const originalRead = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
          const result = await originalRead(...readArgs);
          if (!interleaved) { interleaved = true; fs.writeFileSync(f.source, changed); }
          return result;
        };
      }
      return handle;
    });
    try { await f.scan(); } finally { mock.mock.restore(); }
    assert.equal(interleaved, true);
    assert.equal(fs.readFileSync(row.path, 'utf8'), 'original embedded bytes');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(row.path)).digest('hex'), row.psdExtractionReceipt.outputDigest);
    assert.equal(f.current().workingSourceRelationshipHolds.length, 0, 'the member byte refusal clears only after its own exact bytes validate');
    const out = path.join(f.tmpRoot, 'out'); fs.mkdirSync(out);
    assert.equal((await callIpcRaw('projects:package', f.projectId, out, before.token)).error, 'package_review_stale');
    assert.deepEqual(fs.readdirSync(out), []);
  });
});

test('pre-package rescan keeps linked/user-selected PSBs and separate parent resources', async () => {
  const f = await makePsbRescanFixture('parents');
  try {
    const project = f.current(), original = project.files.find(row => row.source === 'psd-embedded');
    const linked = path.join(f.tmpRoot, 'Linked.psb'), selected = path.join(f.tmpRoot, 'Selected.psb');
    const second = path.join(f.tmpRoot, 'other-mockup.psd');
    fs.writeFileSync(linked, 'linked PSB'); fs.writeFileSync(selected, 'selected PSB');
    fs.copyFileSync(f.psdPath, second);
    project.files.push({ path: selected, name: 'Selected.psb', ext: '.psb', source: 'manual-browse', addedAt: Date.now() },
      { path: second, name: 'other-mockup.psd', ext: '.psd', source: 'manual', addedAt: Date.now() });
    setProjects([project]);
    currentPsdFixture.children = [{ linkedFile: { fullPath: linked } }];
    await f.scan();
    const rows = f.current().files.filter(row => row.source === 'psd-embedded');
    assert.equal(rows.length, 2, 'identical resources in different parents remain separate');
    assert.equal(rows[0].path, original.path);
    assert.notEqual(rows[1].path, original.path);
    assert.ok(f.current().files.some(row => row.path === linked));
    assert.ok(f.current().files.some(row => row.path === selected));
    assert.equal((await f.scan()).newCount, 0);
    assert.equal(fs.readdirSync(f.extractDir).length, 2);
  } finally { f.cleanup(); }
});

test('pre-package rescan does not borrow a receipt from another project', async () => {
  const f = await makePsbRescanFixture('isolation');
  const otherId = 'psd-rescan-other-project';
  const otherExtractDir = path.join(os.tmpdir(), 'crate-psd-extract-' + otherId);
  try {
    const original = f.current().files.find(row => row.source === 'psd-embedded');
    const other = makeProject(otherId, 'Other PSB Project', [{
      path: f.psdPath, name: 'mockup.psd', ext: '.psd', source: 'manual', addedAt: Date.now(),
    }]);
    setProjects([f.current(), other]);
    const result = await callIpc('projects:pre-package-scan', otherId);
    assert.equal(result.newCount, 1);
    const second = getStoredProject(otherId).files.find(row => row.source === 'psd-embedded');
    assert.notEqual(second.path, original.path);
    assert.equal(path.dirname(second.path), otherExtractDir);
    assert.equal(fs.readFileSync(original.path, 'utf8'), 'embedded object bytes');
  } finally { f.cleanup(); fs.rmSync(otherExtractDir, { recursive: true, force: true }); }
});

for (const sourceChange of ['save-as', 'rename', 'saved-edit']) {
  test(`pre-package rescan keeps ${sourceChange} distinct from the earlier saved resource`, async () => {
    const f = await makePsbRescanFixture(sourceChange);
    try {
      const project = f.current(), original = project.files.find(row => row.source === 'psd-embedded');
      const source = project.files.find(row => row.path === f.psdPath);
      if (sourceChange === 'saved-edit') {
        fs.writeFileSync(f.psdPath, 'new saved mockup');
        currentPsdFixture.linkedFiles[0].data = Buffer.from('edited embedded object');
      } else {
        const successor = path.join(f.tmpRoot, sourceChange + '.psd');
        if (sourceChange === 'rename') fs.renameSync(f.psdPath, successor);
        else fs.copyFileSync(f.psdPath, successor);
        source.path = successor; source.name = path.basename(successor);
        setProjects([project]);
      }
      assert.equal((await f.scan()).newCount, 1, 'new saved source/resource cannot borrow the old receipt');
      const rows = f.current().files.filter(row => row.source === 'psd-embedded');
      assert.equal(rows.length, 2);
      assert.equal(rows[0].path, original.path);
      assert.notEqual(rows[1].path, original.path);
      assert.equal((await f.scan()).newCount, 0, 'subsequent unchanged scan is stable');
      assert.equal(fs.readFileSync(original.path, 'utf8'), 'embedded object bytes');
      assert.equal(fs.readFileSync(rows[1].path, 'utf8'), sourceChange === 'saved-edit' ? 'edited embedded object' : 'embedded object bytes');
    } finally { f.cleanup(); }
  });
}

test('package writes scan-on-save PSD embedded asset bytes with safe unique names', async () => {
  const tmpRoot = makeTempDir();
  try {
    const psdPath = path.join(tmpRoot, 'source.psd');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(psdPath, Buffer.from('parent psd bytes'));
    currentPsdFixture = { children: [], linkedFiles: fixtureLinkedFiles() };

    const entries = fixtureLinkedFiles().map((linkedFile, embeddedIndex) => ({
      path: psdPath,
      name: linkedFile.name,
      ext: '.png',
      addedAt: Date.now(),
      source: 'scan-on-save-embedded',
      embedded: true,
      parentPsd: psdPath,
      embeddedOriginalName: linkedFile.name,
      embeddedIndex,
      fileId: `embedded-${embeddedIndex}`,
    }));

    setProjects([makeProject('psd-package-safety', 'PSD Package Safety', entries)]);
    await callIpc('settings:update', 'includeDiagnosticReport', true);

    const result = await callIpc('projects:package', 'psd-package-safety', outputDir);
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 4);
    assert.deepEqual(result.errors, []);

    const destFolder = packageFolder(outputDir, 'PSD Package Safety');
    assert.equal(fs.existsSync(path.join(outputDir, 'escape.png')), false);
    assert.equal(fs.readFileSync(path.join(destFolder, 'escape.png'), 'utf8'), 'embedded escape bytes');
    assert.equal(fs.readFileSync(path.join(destFolder, 'absolute-path-like.png'), 'utf8'), 'embedded absolute bytes');
    assert.equal(fs.readFileSync(path.join(destFolder, 'duplicate.png'), 'utf8'), 'embedded duplicate one');
    assert.equal(fs.readFileSync(path.join(destFolder, 'duplicate_1.png'), 'utf8'), 'embedded duplicate two');

    for (const fileName of ['escape.png', 'absolute-path-like.png', 'duplicate.png', 'duplicate_1.png']) {
      assert.notEqual(fs.readFileSync(path.join(destFolder, fileName), 'utf8'), 'parent psd bytes');
    }

    const project = getStoredProject('psd-package-safety');
    const includeEdges = getProvenanceEdges(project, EDGE_TYPES.PACKAGE_INCLUDES_FILE);
    const extractEdges = getProvenanceEdges(project, EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE);
    assert.equal(includeEdges.length, 0);
    assert.equal(extractEdges.length, 4);
    assert.equal(
      extractEdges.every(edge => edge.confidence.band === 'confirmed' && edge.payload.source === 'scan-on-save-embedded'),
      true
    );
    assert.deepEqual(
      extractEdges.map(edge => path.basename(edge.payload.outputPath)).sort(),
      ['absolute-path-like.png', 'duplicate.png', 'duplicate_1.png', 'escape.png']
    );
    for (const edge of extractEdges) {
      assert.equal(project.provenance.nodes[edge.objectNodeId].type, 'embeddedResource');
      assert.ok(project.provenance.nodes[edge.subjectNodeId]);
    }

    const manifest = readManifest(outputDir, 'PSD Package Safety');
    const manifestExtractEdges = manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 0);
    assert.equal(manifestExtractEdges.length, 4);
    assert.equal(manifestExtractEdges.every(edge => edge.confidenceBand === 'confirmed'), true);
    const manifestText = JSON.stringify(manifest);
    for (const fileName of ['absolute-path-like.png', 'duplicate.png', 'duplicate_1.png', 'escape.png']) {
      assert.equal(manifestText.includes(fileName), false);
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});


for (const route of ['ordinary', 'pre-package']) {
  test('Opus v5 review: post-return edited repair survives ' + route + ' retirement', async t => {
    await withMissingReceiptedPsd('probe-post-return-' + route, async (f, row) => {
      let interleaved = false;
      const undo = psdSafetyHooks.interceptExtraction(before => async (...args) => {
        const result = await before(...args);
        if (!interleaved && args[0] === f.source) {
          interleaved = true;
          assert.equal(fs.readFileSync(row.path, 'utf8'), 'original embedded bytes');
          fs.writeFileSync(row.path, 'USER EDIT AFTER EXTRACT RETURN');
          const project = f.current(); project.status = 'paused'; f.persist(project);
        }
        return result;
      });
      try {
        if (route === 'ordinary') await f.scan();
        else await callIpc('projects:pre-package-scan', f.projectId);
      } finally { undo(); }
      assert.equal(interleaved, true);
      t.diagnostic(JSON.stringify({ phase: 'after-post-return-retirement', route,
        fileExists: fs.existsSync(row.path), rows: f.rows().length }));
      assert.equal(fs.existsSync(row.path), true, 'caller cleanup must preserve post-return in-place edits');
      assert.equal(fs.readFileSync(row.path, 'utf8'), 'USER EDIT AFTER EXTRACT RETURN');
    });
  });
  test('Opus v5 review: metadata mutation during invalid-byte validation on ' + route, async t => {
    await withMissingReceiptedPsd('probe-metadata-' + route, async (f, row) => {
      fs.writeFileSync(row.path, 'original embedded bytes');
      const priorReview = await callIpcRaw('projects:prepare-package-review', f.projectId); assert.ok(priorReview.token);
      const bad = Buffer.alloc(Buffer.byteLength('original embedded bytes'), 120); fs.writeFileSync(row.path, bad);
      const originalOpen = fs.promises.open; let interleaved = false;
      const mock = t.mock.method(fs.promises, 'open', async function(file, ...args) {
        const handle = await originalOpen.call(fs.promises, file, ...args);
        if (file === row.path) {
          const originalRead = handle.read.bind(handle);
          handle.read = async (...readArgs) => {
            const result = await originalRead(...readArgs);
            if (!interleaved) {
              interleaved = true; const project = f.current();
              project.files.find(item => item.path === row.path).captureSessionId = 'benign-observer-update';
              f.persist(project);
            }
            return result;
          };
        }
        return handle;
      });
      try {
        if (route === 'ordinary') await f.scan();
        else await callIpc('projects:pre-package-scan', f.projectId);
      } finally { mock.mock.restore(); }
      assert.equal(interleaved, true);
      assert.deepEqual(f.current().workingSourceRelationshipHolds, [
        { reason: 'psd-extraction-receipt-unverified', sourcePath: row.path },
      ], 'a benign metadata update cannot discard the refusal for this same resource');
      assert.equal(f.current().files.find(item => item.path === row.path).captureSessionId, 'benign-observer-update');
      const review = await callIpcRaw('projects:prepare-package-review', f.projectId);
      assert.equal(review.materializable, false); assert.equal(review.token, undefined);
      const out = path.join(f.tmpRoot, 'out'); fs.mkdirSync(out);
      const result = await callIpcRaw('projects:package', f.projectId, out, priorReview.token);
      assert.notEqual(result.success, true); assert.ok(result.error);
      assert.deepEqual(fs.readdirSync(out), []);
      assert.deepEqual(fs.readFileSync(row.path), bad, 'a refusal never deletes user-modified bytes');
    });
  });
}
test('Opus v5 review: same-name new record occupies a later missing restore locator', async t => {
  const actual = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
  await withOrdinaryPsdFixture('probe-ordering-20261030', async f => {
    const excluded = path.join(f.tmpRoot, 'Excluded.png'); fs.writeFileSync(excluded, 'declined A bytes');
    const project = f.current(); project.files.push({ path: excluded, name: 'Excluded.png', ext: '.png',
      source: 'manual', addedAt: Date.now(), projectRole: 'asset' }); f.persist(project);
    await callIpcRaw('projects:remove-file', f.projectId, excluded);
    const saved = records => actual.writePsdBuffer({ width: 1, height: 1, linkedFiles: records });
    fs.writeFileSync(f.source, saved([
      { id: '11111111-1111-4111-8111-111111111111', name: 'Object.png', data: Buffer.from('declined A bytes') },
      { id: '22222222-2222-4222-8222-222222222222', name: 'Object.png', data: Buffer.from('accepted B bytes') },
    ]));
    currentPsdFixture = (buffer, options) => actual.readPsd(buffer, options);
    await f.scan(); const b = f.rows()[0];
    assert.equal(f.rows().length, 1); assert.equal(path.basename(b.path), 'Object_1.png');
    assert.equal(fs.readFileSync(b.path, 'utf8'), 'accepted B bytes');
    const second = path.join(f.tmpRoot, 'second.psd');
    fs.writeFileSync(second, saved([{ id: '33333333-3333-4333-8333-333333333333', name: 'Object.png', data: Buffer.from('independent C bytes') }]));
    const current = f.current(); current.files.push({ path: second, name: 'second.psd', ext: '.psd', source: 'manual', addedAt: Date.now() }); f.persist(current);
    await f.scan(second);
    assert.equal(fs.readFileSync(path.join(f.extractDir, 'Object.png'), 'utf8'), 'independent C bytes');
    fs.unlinkSync(b.path); f.advance();
    await callIpc('projects:pre-package-scan', f.projectId);
    const bytes = fs.readFileSync(b.path, 'utf8');
    t.diagnostic(JSON.stringify({ phase: 'same-name-ordering', storedName: path.basename(b.path), actualBytes: bytes,
      holds: (f.current().workingSourceRelationshipHolds || []).length }));
    assert.equal(bytes, 'accepted B bytes', 'planned missing-member locator must be reserved before unrelated same-name allocation');
    assert.equal(fs.readFileSync(path.join(f.extractDir, 'Object.png'), 'utf8'), 'independent C bytes');
    assert.equal(f.rows().length, 2, 'declined A stays excluded; distinct B and C remain');
    assert.equal((f.current().workingSourceRelationshipHolds || []).length, 0);
    const review = await callIpcRaw('projects:prepare-package-review', f.projectId); assert.equal(review.materializable, true);
  });
});
test('Opus v5 review: missing repaired member without a hold still refuses actual packaging', async () => {
  await withMissingReceiptedPsd('probe-missing-no-hold', async (f, row) => {
    fs.writeFileSync(row.path, 'original embedded bytes');
    const before = await callIpcRaw('projects:prepare-package-review', f.projectId); assert.ok(before.token);
    fs.unlinkSync(row.path);
    let interleaved = false;
    const undo = psdSafetyHooks.interceptExtraction(original => async (...args) => {
      const result = await original(...args);
      if (!interleaved && args[0] === f.source) { interleaved = true; const p = f.current(); p.status = 'paused'; f.persist(p); }
      return result;
    });
    try { await f.scan(); } finally { undo(); }
    assert.equal(interleaved, true); assert.equal(fs.existsSync(row.path), false);
    assert.equal((f.current().workingSourceRelationshipHolds || []).length, 0);
    const review = await callIpcRaw('projects:prepare-package-review', f.projectId);
    assert.equal(review.materializable, false); assert.equal(review.token, undefined);
    const out = path.join(f.tmpRoot, 'out'); fs.mkdirSync(out);
    const result = await callIpcRaw('projects:package', f.projectId, out, before.token);
    assert.notEqual(result.success, true); assert.ok(result.error);
    assert.deepEqual(fs.readdirSync(out), []);
  });
});

for (const changedIdentity of ['receipt', 'file-id', 'source-kind', 'removed-member']) {
  test(`Opus v5 review: invalid-byte hold never follows a changed ${changedIdentity}`, async t => {
    await withMissingReceiptedPsd('changed-binding-' + changedIdentity, async (f, row) => {
      fs.writeFileSync(row.path, Buffer.alloc(Buffer.byteLength('original embedded bytes'), 120));
      const originalOpen = fs.promises.open; let interleaved = false;
      const mock = t.mock.method(fs.promises, 'open', async function(file, ...args) {
        const handle = await originalOpen.call(fs.promises, file, ...args);
        if (file === row.path) {
          const read = handle.read.bind(handle);
          handle.read = async (...readArgs) => {
            const result = await read(...readArgs);
            if (!interleaved) {
              interleaved = true;
              const project = f.current(), canonical = project.files.find(item => item.path === row.path);
              if (changedIdentity === 'receipt') canonical.psdExtractionReceipt.sourceDigest = 'different-saved-source';
              if (changedIdentity === 'file-id') canonical.fileId = 'different-canonical-row';
              if (changedIdentity === 'source-kind') canonical.source = 'manual';
              if (changedIdentity === 'removed-member') project.files = project.files.filter(item => item.path !== row.path);
              f.persist(project);
            }
            return result;
          };
        }
        return handle;
      });
      try { await f.scan(); } finally { mock.mock.restore(); }
      assert.equal(interleaved, true);
      assert.equal((f.current().workingSourceRelationshipHolds || []).length, 0,
        'a stale receipt cannot publish a hold onto a different or removed canonical resource');
      assert.equal(fs.readFileSync(row.path).every(byte => byte === 120), true);
    });
  });
}


test('PR regression: rejecting the last held member atomically retires only its receipt hold', async t => {
  const actual = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
  await withOrdinaryPsdFixture('probe-orphan-20261030', async f => {
    const saved = (name, data) => actual.writePsdBuffer({ width: 1, height: 1, linkedFiles: [{
      id: '11111111-1111-4111-8111-111111111111', name, data: Buffer.from(data),
    }] });
    fs.writeFileSync(f.source, saved('Object.psb', 'original embedded bytes'));
    currentPsdFixture = (buffer, options) => actual.readPsd(buffer, options);
    await f.scan(); const initial = f.current(), first = f.rows()[0];
    const reusedPath = path.join(f.extractDir, 'Future.psb');
    fs.copyFileSync(first.path, reusedPath);
    // Models an already-persisted duplicate receipt, the documented race input.
    initial.pendingFiles.push({ ...first, path: reusedPath, name: 'Future.psb', fileId: 'duplicate-pending-probe' });
    f.persist(initial);
    await callIpc('projects:pre-package-scan', f.projectId);
    assert.equal(f.current().workingSourceRelationshipHolds.length, 2);
    const writes = [], originalSet = storeInstance.set.bind(storeInstance);
    const watch = t.mock.method(storeInstance, 'set', (key, value) => {
      if (key === 'projects') writes.push(JSON.parse(JSON.stringify(value)));
      return originalSet(key, value);
    });
    try { await callIpcRaw('projects:reject-pending', f.projectId, reusedPath); }
    finally { watch.mock.restore(); }
    assert.ok(writes.length);
    for (const state of writes) {
      const stored = state.find(project => project.id === f.projectId);
      if (!stored.pendingFiles.some(row => row.path === reusedPath)) {
        assert.equal(stored.workingSourceRelationshipHolds.some(hold => hold.sourcePath === reusedPath), false,
          'no persisted intermediate state may remove the member but retain its simple hold');
      }
    }
    assert.equal(fs.readFileSync(reusedPath, 'utf8'), 'original embedded bytes', 'retiring a hold never deletes cache bytes');
    assert.equal(f.current().pendingFiles.length, 0);
    await callIpc('projects:pre-package-scan', f.projectId);
    assert.deepEqual(f.current().workingSourceRelationshipHolds, []);
    assert.equal((await callIpcRaw('projects:prepare-package-review', f.projectId)).materializable, true);
    // Disposable cache loss and a genuine saved-PSD edit, not a receipt edit.
    fs.unlinkSync(reusedPath);
    fs.writeFileSync(f.source, saved('Future.psb', 'new legitimate resource bytes')); f.advance();
    const newScan = await callIpc('projects:pre-package-scan', f.projectId);
    const newRow = f.rows().find(row => row.path === reusedPath);
    assert.ok(newRow, 'the new saved resource was admitted through the actual pre-package route');
    assert.equal(fs.readFileSync(reusedPath, 'utf8'), 'new legitimate resource bytes');
    const firstReview = await callIpcRaw('projects:prepare-package-review', f.projectId);
    t.diagnostic(JSON.stringify({ phase: 'new-resource-first-review', newCount: newScan.newCount,
      materializable: firstReview.materializable, holds: f.current().workingSourceRelationshipHolds.length }));
    assert.equal(firstReview.materializable, true, 'the removed resource hold cannot reactivate on a legitimate new member');
    await callIpc('projects:pre-package-scan', f.projectId);
    const retried = await callIpcRaw('projects:prepare-package-review', f.projectId);
    assert.equal(retried.materializable, true, 'one current receipt-validated rescan clears the hold');
    t.diagnostic(JSON.stringify({ phase: 'after-one-extra-scan', materializable: retried.materializable,
      holds: f.current().workingSourceRelationshipHolds.length }));
  });
});

for (const survivor of ['accepted', 'pending', 'requiredEmbeddedOutputs', 'requiredReferences', 'malformed-verification']) {
  test(`PR regression: receipt hold survives last-row removal with ${survivor}`, async () => {
    await withMissingReceiptedPsd('hold-retention-' + survivor, async (f, row) => {
      fs.writeFileSync(row.path, 'original embedded bytes');
      const project = f.current(), pending = { ...row, fileId: 'held-pending' };
      project.files = project.files.filter(file => file.path !== row.path);
      project.pendingFiles = [pending];
      project.workingSourceRelationshipHolds = [{ reason: 'psd-extraction-receipt-unverified', sourcePath: row.path }];
      if (survivor === 'accepted') project.files.push({ ...row, fileId: 'independent-survivor' });
      if (survivor === 'pending') project.pendingFiles.push({ ...row, fileId: 'independent-survivor' });
      if (survivor.startsWith('required')) project.workingSourceVerification = {
        fixture: { [survivor]: [{ path: row.path }] },
      };
      if (survivor === 'malformed-verification') project.workingSourceVerification = { fixture: { requiredEmbeddedOutputs: null } };
      f.persist(project);
      psdSafetyHooks.mutateProject(f.projectId, current => {
        current.pendingFiles = current.pendingFiles.filter(file => file.fileId !== 'held-pending');
      });
      assert.deepEqual(f.current().workingSourceRelationshipHolds, project.workingSourceRelationshipHolds);
      assert.equal(fs.readFileSync(row.path, 'utf8'), 'original embedded bytes');
    });
  });
}

test('PR regression: removal preserves unknown holds and untouched historical orphan holds', async () => {
  await withMissingReceiptedPsd('hold-shapes', async (f, row) => {
    fs.writeFileSync(row.path, 'original embedded bytes');
    const project = f.current();
    const preserved = [
      { reason: 'psd-extraction-receipt-unverified', sourcePath: row.path, unknown: true },
      { reason: 'different-refusal', sourcePath: row.path },
      { reason: 'psd-extraction-receipt-unverified', sourcePath: path.join(f.extractDir, 'Historical.psb') },
    ];
    project.workingSourceRelationshipHolds = [
      { reason: 'psd-extraction-receipt-unverified', sourcePath: row.path }, ...preserved,
    ];
    f.persist(project);
    psdSafetyHooks.mutateProject(f.projectId, current => {
      current.files = current.files.filter(file => file.path !== row.path);
    });
    assert.deepEqual(f.current().workingSourceRelationshipHolds, preserved);
    assert.equal(fs.readFileSync(row.path, 'utf8'), 'original embedded bytes');
  });
});

for (const winner of ['ordinary', 'pre-package']) for (const editWinner of [false, true]) for (const aliasParent of [false, true]) {
  test(`PR regression: concurrent fresh PSD scans retain ${winner} winner with edited bytes ${editWinner} and parent alias ${aliasParent}`, async t => {
    await withOrdinaryPsdFixture('overlap-' + winner + '-' + editWinner + '-' + aliasParent, async f => {
      const scanSource = aliasParent ? path.join(f.tmpRoot, 'alias.psd') : f.source;
      if (aliasParent) fs.symlinkSync(f.source, scanSource);
      // Installed electron-store/conf deserializes each get from disk. Use
      // fresh project reads for this overlapping canonical-publication test;
      // the historical harness otherwise shares its in-memory object.
      const get = storeInstance.get.bind(storeInstance);
      const cloneReads = t.mock.method(storeInstance, 'get', (key, fallback) => {
        const value = get(key, fallback);
        return key === 'projects' ? JSON.parse(JSON.stringify(value)) : value;
      });
      let arrivals = 0, allArrived; const ready = new Promise(resolve => { allArrived = resolve; });
      const releases = {}, gates = Object.fromEntries(['ordinary', 'pre-package'].map(route => [route,
        new Promise(resolve => { releases[route] = resolve; })]));
      const undo = psdSafetyHooks.interceptExtraction(before => async (...args) => {
        const result = await before(...args);
        if (args[0] === f.source || args[0] === scanSource) {
          const route = args[3].onOrdinaryScanFailure ? 'ordinary' : 'pre-package';
          if (++arrivals === 2) allArrived();
          await gates[route];
        }
        return result;
      });
      const timeout = originalSetTimeout(() => { allArrived(); Object.values(releases).forEach(release => release()); }, 2000);
      const scans = { ordinary: f.scan(scanSource), 'pre-package': callIpc('projects:pre-package-scan', f.projectId) };
      try {
        await ready; assert.equal(arrivals, 2);
        releases[winner](); await scans[winner];
        const row = f.rows()[0]; assert.ok(row);
        if (editWinner) fs.writeFileSync(row.path, 'USER EDIT AFTER WINNING PUBLICATION');
        const loser = winner === 'ordinary' ? 'pre-package' : 'ordinary';
        releases[loser](); await scans[loser];
        assert.equal(f.rows().length, 1, 'canonical admission must refuse a second locator for this exact resource');
        assert.deepEqual(fs.readdirSync(f.extractDir), [row.name], 'only the owned unaccepted loser output is removed');
        assert.equal(fs.readFileSync(row.path, 'utf8'), editWinner ? 'USER EDIT AFTER WINNING PUBLICATION' : 'original embedded bytes');
        assert.equal(f.current().workingSourceRelationshipHolds.length, 1);
        assert.equal((await callIpcRaw('projects:prepare-package-review', f.projectId)).materializable, false);
        f.advance(); await f.scan();
        const review = await callIpcRaw('projects:prepare-package-review', f.projectId);
        assert.equal(review.materializable, !editWinner, 'only exact validation may release the conservative concurrency refusal');
        assert.equal(f.current().workingSourceRelationshipHolds.length, editWinner ? 1 : 0);
      } finally {
        originalClearTimeout(timeout); Object.values(releases).forEach(release => release());
        await Promise.allSettled(Object.values(scans)); undo(); cloneReads.mock.restore();
      }
    });
  });
}

for (const retirement of ['pause', 'account']) {
  test(`PR regression: ${retirement} during reservation planning retires before any output publication`, async t => {
    const actual = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
    await withOrdinaryPsdFixture('planning-retirement-' + retirement, async f => {
      fs.writeFileSync(f.source, actual.writePsdBuffer({ width: 1, height: 1, linkedFiles: [
        { id: '11111111-1111-4111-8111-111111111111', name: 'Object.psb', data: Buffer.from('first planning record') },
        { id: '22222222-2222-4222-8222-222222222222', name: 'Object.psb', data: Buffer.from('second planning record') },
      ] }));
      currentPsdFixture = (buffer, options) => actual.readPsd(buffer, options);
      const planningCrypto = psdSafetyHooks.getCrypto();
      const originalHash = planningCrypto.createHash; let retired = false, accountMock;
      const mock = t.mock.method(planningCrypto, 'createHash', function(...args) {
        const hash = originalHash.apply(planningCrypto, args), update = hash.update;
        hash.update = function(data, ...rest) {
          if (!retired && Buffer.from(data).toString() === 'first planning record') {
            retired = true;
            setImmediate(() => {
              if (retirement === 'pause') { const project = f.current(); project.status = 'paused'; f.persist(project); }
              else accountMock = t.mock.method(psdSafetyHooks.getAccountSession(), 'canUseWorkspace', () => false);
            });
          }
          return update.call(hash, data, ...rest);
        };
        return hash;
      });
      try { await f.scan(); } finally { mock.mock.restore(); accountMock?.mock.restore(); }
      assert.equal(retired, true);
      assert.equal(f.rows().length, 0); assert.deepEqual(fs.readdirSync(f.extractDir), []);
      assert.equal((f.current().workingSourceRelationshipHolds || []).length, 0);
      const project = f.current(); project.status = 'watching'; f.persist(project); f.advance();
      await f.scan();
      assert.equal(f.rows().length, 2, 'a fresh authorized retry preserves both same-name distinct resources');
    });
  });
}

test('PR regression: same-byte same-name resources in distinct physical parents remain distinct', async () => {
  await withOrdinaryPsdFixture('distinct-parent-identity', async f => {
    await f.scan();
    const second = path.join(f.tmpRoot, 'independent.psd');
    fs.writeFileSync(second, fs.readFileSync(f.source));
    const project = f.current(); project.files.push({ path: second, name: path.basename(second), ext: '.psd', source: 'manual', addedAt: Date.now() }); f.persist(project);
    await f.scan(second);
    assert.equal(f.rows().length, 2);
    assert.notEqual(f.rows()[0].path, f.rows()[1].path);
    assert.deepEqual(f.rows().map(row => fs.readFileSync(row.path, 'utf8')), ['original embedded bytes', 'original embedded bytes']);
    assert.equal((f.current().workingSourceRelationshipHolds || []).length, 0);
  });
});

for (const winner of ['ordinary', 'pre-package']) for (const aliasParent of [false, true]) {
  test(`PR regression: missing parent after ${winner} publication refuses a competing alias ${aliasParent}`, async t => {
    await withOrdinaryPsdFixture('retired-parent-' + winner + '-' + aliasParent, async f => {
      const saved = fs.readFileSync(f.source), scanSource = aliasParent ? path.join(f.tmpRoot, 'alias.psd') : f.source;
      if (aliasParent) fs.symlinkSync(f.source, scanSource);
      const get = storeInstance.get.bind(storeInstance);
      const copy = t.mock.method(storeInstance, 'get', (key, fallback) => {
        const value = get(key, fallback); return key === 'projects' ? JSON.parse(JSON.stringify(value)) : value;
      });
      let arrivals = 0, arrived; const ready = new Promise(resolve => { arrived = resolve; });
      const release = {}, gates = Object.fromEntries(['ordinary', 'pre-package'].map(route => [route,
        new Promise(resolve => { release[route] = resolve; })]));
      const undo = psdSafetyHooks.interceptExtraction(before => async (...args) => {
        const result = await before(...args);
        if (args[0] === f.source || args[0] === scanSource) {
          if (++arrivals === 2) arrived();
          await gates[args[3].onOrdinaryScanFailure ? 'ordinary' : 'pre-package'];
        }
        return result;
      });
      const timeout = originalSetTimeout(() => { arrived(); Object.values(release).forEach(fn => fn()); }, 2000);
      const scans = { ordinary: f.scan(scanSource), 'pre-package': callIpc('projects:pre-package-scan', f.projectId) };
      try {
        await ready; assert.equal(arrivals, 2);
        release[winner](); await scans[winner];
        const row = f.rows()[0]; assert.ok(row); fs.unlinkSync(f.source);
        const loser = winner === 'ordinary' ? 'pre-package' : 'ordinary'; release[loser](); await scans[loser];
        assert.equal(f.rows().length, 1, 'source disappearance cannot authorize a second output locator');
        assert.deepEqual(fs.readdirSync(f.extractDir), [row.name]);
        assert.equal(fs.readFileSync(row.path, 'utf8'), 'original embedded bytes');
        assert.equal((await callIpcRaw('projects:prepare-package-review', f.projectId)).materializable, false);
        fs.writeFileSync(f.source, saved); f.advance(); await f.scan();
        assert.equal(f.rows().length, 1);
        assert.equal((await callIpcRaw('projects:prepare-package-review', f.projectId)).materializable, true);
      } finally {
        originalClearTimeout(timeout); Object.values(release).forEach(fn => fn());
        await Promise.allSettled(Object.values(scans)); undo(); copy.mock.restore();
      }
    });
  });
}

// Adjudication-only cases: retain production algorithms, but model the store's
// JSON serialization boundary rather than lending its persisted object graph.
async function withAdjudicationClonedStore(t, body) {
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const get = storeInstance.get.bind(storeInstance), set = storeInstance.set.bind(storeInstance);
  const observer = { afterProjectWrite: () => {} };
  const read = t.mock.method(storeInstance, 'get', (...args) => clone(get(...args)));
  const write = t.mock.method(storeInstance, 'set', (key, value) => {
    const result = typeof key === 'object' ? set(clone(key)) : set(key, clone(value));
    if (key === 'projects') observer.afterProjectWrite(clone(get('projects', [])));
    return result;
  });
  try { await body(observer); }
  finally { write.mock.restore(); read.mock.restore(); }
}

async function drainAdjudicationPsdScans() {
  const deadline = process.hrtime.bigint() + 5_000_000_000n;
  while (psdSafetyHooks.getPsdScanState().operations) {
    assert.ok(process.hrtime.bigint() < deadline, 'real ordinary scan cleanup must settle');
    await new Promise(resolve => originalSetTimeout(resolve, 1));
  }
}

async function withTwoMissingHeldPsdRecords(suffix, body) {
  const actual = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
  await withOrdinaryPsdFixture('adjudication-' + suffix, async f => {
    const payloads = [Buffer.from('first legitimate resource bytes'), Buffer.from('second legitimate resource bytes')];
    fs.writeFileSync(f.source, actual.writePsdBuffer({ width: 1, height: 1, linkedFiles: [
      { id: '11111111-1111-4111-8111-111111111111', name: 'First.psb', data: payloads[0] },
      { id: '22222222-2222-4222-8222-222222222222', name: 'Second.psb', data: payloads[1] },
    ] }));
    currentPsdFixture = (buffer, options) => actual.readPsd(buffer, options);
    assert.deepEqual(await f.scan(), { success: true });
    const rows = f.rows().sort((a, b) => a.psdExtractionReceipt.linkedIndex - b.psdExtractionReceipt.linkedIndex);
    assert.equal(rows.length, 2);
    const originalName = f.current().name, detached = f.current();
    detached.name = 'unpersisted clone edit';
    assert.equal(f.current().name, originalName, 'get must not expose persisted aliases');
    for (const row of rows) fs.writeFileSync(row.path, 'tampered bytes');
    f.advance(); await f.scan(); await drainAdjudicationPsdScans();
    assert.deepEqual(f.current().workingSourceRelationshipHolds.map(hold => hold.sourcePath).sort(), rows.map(row => row.path).sort(),
      'both holds must be created by real failed receipt validation');
    for (const row of rows) fs.unlinkSync(row.path);
    f.advance();
    const state = phase => ({ phase, projectStatus: f.current().status,
      members: rows.map(row => ({ name: row.name, fileId: row.fileId || row.path,
        exists: fs.existsSync(row.path),
        held: (f.current().workingSourceRelationshipHolds || []).some(hold => hold.sourcePath === row.path),
        digest: fs.existsSync(row.path) ? crypto.createHash('sha256').update(fs.readFileSync(row.path)).digest('hex') : null })),
      cacheNames: fs.readdirSync(f.extractDir).sort(), scanState: psdSafetyHooks.getPsdScanState() });
    await body(f, rows, payloads, state);
  });
}

for (const route of ['ordinary', 'pre-package']) {
  for (const retirement of ['second-verification', 'post-return', ...(route === 'ordinary' ? ['timeout', 'lease-cancelled'] : [])]) {
    test(`adjudication: ${route} ${retirement} retains a hold when owned repair is discarded`, async t => {
      await withAdjudicationClonedStore(t, async storeObserver => {
        await withTwoMissingHeldPsdRecords(route + '-' + retirement, async (f, rows, payloads, state) => {
          const trace = [state('missing-with-two-persisted-holds')];
          let firstCleared = false, retired = false, lease;
          const pause = phase => {
            if (retired) return;
            retired = true; trace.push(state(phase + '-before-pause'));
            if (retirement === 'timeout' || retirement === 'lease-cancelled') {
              lease = psdSafetyHooks.getPsdScanLease(); assert.ok(lease); assert.equal(lease.cancel(retirement === 'timeout' ? 'timeout' : 'cancelled'), true);
            } else callIpcRaw('projects:pause', f.projectId);
            trace.push(state(phase + '-after-pause'));
          };
          storeObserver.afterProjectWrite = projects => {
            const project = projects.find(row => row.id === f.projectId);
            if (!firstCleared && project && !(project.workingSourceRelationshipHolds || []).some(hold => hold.sourcePath === rows[0].path)) {
              firstCleared = true; trace.push(state('first-hold-cleared'));
            }
          };
          const open = fs.promises.open;
          const opened = t.mock.method(fs.promises, 'open', async function(file, ...args) {
            const handle = await open.call(fs.promises, file, ...args);
            if (retirement !== 'post-return' && file === rows[1].path && !retired) {
              assert.equal(fs.existsSync(rows[0].path), true, 'first repair is verified before second verification waits');
              assert.equal(firstCleared, false, 'repair cannot clear its hold before caller acceptance');
              // Leave the filesystem await pending while a separate event-loop
              // turn delivers pause, rather than reentering a store write.
              await new Promise((resolve, reject) => originalSetTimeout(() => {
                try { pause(retirement + '-timer-event'); resolve(); } catch (error) { reject(error); }
              }, 0));
            }
            return handle;
          });
          const undo = psdSafetyHooks.interceptExtraction(before => async (...args) => {
            const result = await before(...args);
            if (retirement === 'post-return' && args[0] === f.source) pause('post-return');
            return result;
          });
          try {
            if (route === 'ordinary') await f.scan(); else await callIpcRaw('projects:pre-package-scan', f.projectId);
            trace.push(state('caller-return'));
            await drainAdjudicationPsdScans();
          } finally {
            storeObserver.afterProjectWrite = () => {};
            opened.mock.restore(); undo();
          }
          assert.equal(firstCleared, false); assert.equal(retired, true);
          trace.push(state('cleanup-settled'));
          const violation = !fs.existsSync(rows[0].path) && !(f.current().workingSourceRelationshipHolds || []).some(hold => hold.sourcePath === rows[0].path);
          assert.equal(fs.existsSync(rows[0].path), false, 'retiring cleanup removes its unchanged owned repair');
          const blocked = await callIpcRaw('projects:prepare-package-review', f.projectId);
          assert.equal(blocked.materializable, false, 'missing output still blocks packaging');
          const out = path.join(f.tmpRoot, 'after-retirement-out'); fs.mkdirSync(out);
          const refused = await callIpc('projects:package', f.projectId, out);
          assert.notEqual(refused?.success, true);
          assert.deepEqual(fs.readdirSync(out), [], 'no substituted or partial package is written');
          f.advance();
          if (route === 'ordinary') await f.scan(); else await callIpcRaw('projects:pre-package-scan', f.projectId);
          await drainAdjudicationPsdScans();
          trace.push(state('fresh-paused-retry'));
          assert.equal(f.rows().length, 2);
          for (const [index, row] of rows.entries()) assert.deepEqual(fs.readFileSync(row.path), payloads[index]);
          assert.deepEqual(f.current().workingSourceRelationshipHolds || [], []);
          const retained = rows.map(row => fs.statSync(row.path).ino);
          f.advance();
          if (route === 'ordinary') await f.scan(); else await callIpcRaw('projects:pre-package-scan', f.projectId);
          await drainAdjudicationPsdScans();
          assert.deepEqual(rows.map(row => fs.statSync(row.path).ino), retained, 'retry is idempotent and keeps admitted locators');
          assert.equal((await callIpcRaw('projects:prepare-package-review', f.projectId)).materializable, true);
          t.diagnostic(JSON.stringify({ route, retirement, violation, trace }));
          // Keep the same durable-refusal invariant after all cleanup,
          // package-refusal and retry observations have been collected.
          assert.equal(violation, false, 'a removed repaired member must not lose its prior durable refusal');
        });
      });
    });
  }

  test(`adjudication: ${route} accepts two repairs with cloned persisted reads and retries idempotently`, async t => {
    await withAdjudicationClonedStore(t, async () => {
      await withTwoMissingHeldPsdRecords('accepted-' + route, async (f, rows, payloads, state) => {
        if (route === 'ordinary') assert.deepEqual(await f.scan(), { success: true });
        else await callIpcRaw('projects:pre-package-scan', f.projectId);
        await drainAdjudicationPsdScans();
        const accepted = state('accepted');
        assert.equal(f.rows().length, 2); assert.deepEqual(f.current().workingSourceRelationshipHolds || [], []);
        for (const [index, row] of rows.entries()) assert.deepEqual(fs.readFileSync(row.path), payloads[index]);
        const identity = rows.map(row => fs.statSync(row.path).ino);
        f.advance();
        if (route === 'ordinary') await f.scan(); else await callIpcRaw('projects:pre-package-scan', f.projectId);
        await drainAdjudicationPsdScans();
        assert.deepEqual(rows.map(row => fs.statSync(row.path).ino), identity);
        assert.equal((await callIpcRaw('projects:prepare-package-review', f.projectId)).materializable, true);
        const out = path.join(f.tmpRoot, 'accepted-out'); fs.mkdirSync(out);
        const packed = await callIpc('projects:package', f.projectId, out);
        assert.equal(packed.success, true); assert.equal(packed.copiedCount, 3);
        for (const [index, row] of rows.entries()) assert.deepEqual(fs.readFileSync(path.join(packed.folderPath, row.name)), payloads[index]);
        t.diagnostic(JSON.stringify({ route, accepted, packagedCount: packed.copiedCount }));
      });
    });
  });
}

for (const route of ['ordinary', 'pre-package']) {
  for (const change of ['output-edit', 'source-edit', 'receipt-row', 'account']) {
    test(`repair acceptance: ${route} preserves refusal across ${change} after extraction`, async t => {
      await withAdjudicationClonedStore(t, async () => {
        await withTwoMissingHeldPsdRecords('acceptance-' + route + '-' + change, async (f, rows, payloads, state) => {
          let changed = false, foreignProject;
          const account = psdSafetyHooks.getAccountSession(), generation = account.generation;
          const undo = psdSafetyHooks.interceptExtraction(before => async (...args) => {
            const result = await before(...args);
            if (!changed && args[0] === f.source) {
              changed = true;
              assert.ok(state('before-change').members.every(row => row.exists && row.held),
                'all repairs still retain their holds before caller acceptance');
              if (change === 'output-edit') fs.writeFileSync(rows[0].path, 'USER EDIT AFTER EXTRACTION');
              if (change === 'source-edit') fs.writeFileSync(f.source, 'USER EDIT TO SAVED SOURCE');
              if (change === 'receipt-row') {
                const project = f.current();
                project.files.find(row => row.path === rows[0].path).captureSessionId = 'new-observation-session';
                f.persist(project);
              }
              if (change === 'account') {
                account.generation++;
                foreignProject = f.current(); foreignProject.name = 'Other synthetic account project';
                f.persist(foreignProject);
              }
            }
            return result;
          });
          try {
            if (route === 'ordinary') await f.scan();
            else if (change === 'account') await assert.rejects(callIpcRaw('projects:pre-package-scan', f.projectId), /Sign in to Crate/);
            else await callIpcRaw('projects:pre-package-scan', f.projectId);
            await drainAdjudicationPsdScans();
          } finally { undo(); account.generation = generation; }
          assert.equal(changed, true);
          const held = new Set((f.current().workingSourceRelationshipHolds || []).map(hold => hold.sourcePath));
          assert.ok(held.has(rows[0].path), 'changed evidence cannot release the exact prior hold');
          if (change === 'output-edit') assert.equal(fs.readFileSync(rows[0].path, 'utf8'), 'USER EDIT AFTER EXTRACTION');
          if (change === 'source-edit') {
            assert.equal(fs.readFileSync(f.source, 'utf8'), 'USER EDIT TO SAVED SOURCE');
            assert.ok(held.has(rows[1].path), 'changed parent bytes retain both refusals');
          }
          if (change === 'account') {
            assert.deepEqual(f.current(), foreignProject, 'retired account cannot clear or rewrite the new account project');
            assert.ok(rows.every(row => !fs.existsSync(row.path)), 'unchanged owned repairs are discarded on account retirement');
          } else assert.equal((await callIpcRaw('projects:prepare-package-review', f.projectId)).materializable, false);
          assert.equal(psdSafetyHooks.getPsdScanState().pendingRepairs, 0);
          t.diagnostic(JSON.stringify({ route, change, settled: state('settled') }));
        });
      });
    });
  }

  for (const timeoutOwner of route === 'ordinary' ? [false, true] : [false]) {
  test(`repair acceptance: ${route} concurrent reader cannot clear a retiring owner's holds (timeout: ${timeoutOwner})`, async t => {
    await withAdjudicationClonedStore(t, async () => {
      await withTwoMissingHeldPsdRecords('reader-' + route + '-' + timeoutOwner, async (f, rows, payloads, state) => {
        let reached, release;
        const ready = new Promise(resolve => { reached = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        let ownerArrived = false;
        const undo = psdSafetyHooks.interceptExtraction(before => async (...args) => {
          const result = await before(...args);
          if (!ownerArrived && args[0] === f.source) {
            ownerArrived = true; reached(); await gate;
          }
          return result;
        });
        const timeout = originalSetTimeout(() => { reached(); release(); }, 3000);
        const owner = route === 'ordinary' ? f.scan() : callIpcRaw('projects:pre-package-scan', f.projectId);
        try {
          await ready; assert.equal(ownerArrived, true);
          assert.equal(psdSafetyHooks.getPsdScanState().pendingRepairs, 2);
          if (timeoutOwner) {
            assert.equal(psdSafetyHooks.getPsdScanLease().cancel('timeout'), true);
            assert.deepEqual(await owner, { success: false, error: 'add_files_scan_timeout' });
            assert.equal(psdSafetyHooks.getPsdScanState().pendingRepairs, 2,
              'caller timeout returns while the extraction owner still awaits settlement');
          }
          f.advance();
          if (route === 'ordinary') await callIpcRaw('projects:pre-package-scan', f.projectId); else await f.scan();
          assert.ok(state('after-reader').members.every(row => row.exists && row.held),
            'a borrower cannot release holds while the repair owner may discard its outputs');
          if (!timeoutOwner) callIpcRaw('projects:pause', f.projectId);
          release(); await owner; await drainAdjudicationPsdScans();
          assert.ok(state('after-owner-retirement').members.every(row => !row.exists && row.held));
          assert.equal(psdSafetyHooks.getPsdScanState().pendingRepairs, 0);
          assert.equal((await callIpcRaw('projects:prepare-package-review', f.projectId)).materializable, false);
          f.advance(); await f.scan(); await drainAdjudicationPsdScans();
          for (const [index, row] of rows.entries()) assert.deepEqual(fs.readFileSync(row.path), payloads[index]);
          assert.deepEqual(f.current().workingSourceRelationshipHolds, []);
          assert.equal((await callIpcRaw('projects:prepare-package-review', f.projectId)).materializable, true);
        } finally { release(); await owner; undo(); originalClearTimeout(timeout); }
      });
    });
  });
  }
}

// Provider adjudication: execute the full production phase helper and route.
// Only dispatch the actual deadline callback and defer real asynchronous IO.
function prePackageBoundary() {
  let enter, release;
  const ready = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let entered = false;
  return { ready, release, get entered() { return entered; },
    async wait() { entered = true; enter(); await gate; }, signal: () => enter() };
}
async function drainPrePackageAdjudication(projectId) {
  const end = process.hrtime.bigint() + 5_000_000_000n;
  while (psdSafetyHooks.getPrePackageScanState(projectId).inFlight) {
    assert.ok(process.hrtime.bigint() < end, 'phase settlement must retire the in-flight marker');
    await new Promise(resolve => originalSetTimeout(resolve, 1));
  }
}

for (const boundaryKind of ['second-verification', 'post-return', 'second-stage-write', 'second-stage-open', 'edited-first', 'same-bytes-first']) {
  test(`pre-package phase adjudication: timeout at ${boundaryKind} cannot reopen hold/file split`, async t => {
    await withAdjudicationClonedStore(t, async () => {
      await withTwoMissingHeldPsdRecords('phase-' + boundaryKind, async (f, rows, payloads, state) => {
        const boundary = prePackageBoundary(), trace = [];
        let ownerStages, blocked = false, ownerSettled = false, deadline;
        const stageState = phase => ({ ...state(phase), packageScan: psdSafetyHooks.getPrePackageScanState(f.projectId),
          ownerSettled, stages: (ownerStages || []).map(stage => ({ name: path.basename(stage.extractPath),
            committed: stage.committed, accepted: stage.accepted === true,
            tempExists: fs.existsSync(stage.stagedPath), ownedIdentity: stage.identity,
            repairFinalIdentity: stage.repairFinalIdentity || null })) });
        const watch = originalSetTimeout(() => { boundary.signal(); boundary.release(); }, 5000);
        const timer = global.setTimeout;
        const capture = t.mock.method(global, 'setTimeout', function(fn, delay, ...args) {
          const handle = timer(fn, delay, ...args);
          if (delay === psdSafetyHooks.getPrePackageAppTimeout() && new Error().stack.includes('runPackageScanPhase')) {
            assert.equal(deadline, undefined, 'only the app-phase deadline is captured');
            deadline = { delay, fire: () => fn(...args) };
          }
          return handle;
        });
        const undo = psdSafetyHooks.interceptExtraction(before => async (...args) => {
          const options = args[3];
          if (args[0] === f.source && options.onOrdinaryPsdOutputs && !ownerStages) {
            const publish = options.onOrdinaryPsdOutputs;
            args[3] = { ...options, onOrdinaryPsdOutputs(outputs) { ownerStages = outputs; publish(outputs); } };
            const result = await before(...args);
            if (boundaryKind === 'post-return') await boundary.wait();
            return result;
          }
          return before(...args);
        });
        const open = fs.promises.open;
        const opened = t.mock.method(fs.promises, 'open', async function(file, ...args) {
          const handle = await open.call(fs.promises, file, ...args);
          const second = ownerStages?.find(stage => stage.extractPath === rows[1].path);
          if (!blocked && boundaryKind === 'second-stage-open' && file === second?.stagedPath) {
            blocked = true; await boundary.wait();
          } else if (!blocked && boundaryKind === 'second-stage-write' && file === second?.stagedPath) {
            blocked = true; const write = handle.writeFile.bind(handle);
            handle.writeFile = async (...writeArgs) => { await boundary.wait(); return write(...writeArgs); };
          } else if (!blocked && boundaryKind !== 'post-return' && boundaryKind !== 'second-stage-write' && file === rows[1].path) {
            blocked = true; await boundary.wait();
          }
          return handle;
        });
        const owner = callIpcRaw('projects:pre-package-scan', f.projectId);
        try {
          await boundary.ready;
          assert.equal(boundary.entered, true, 'the actual requested asynchronous boundary was reached');
          assert.equal(ownerStages.length, 2); assert.ok(deadline); assert.equal(deadline.delay, 30000);
          assert.equal(psdSafetyHooks.getPsdScanState().pendingRepairs, 2);
          assert.ok(stageState('before-timeout').members.every(member => member.held));
          if (boundaryKind === 'edited-first' || boundaryKind === 'same-bytes-first') {
            await new Promise(resolve => originalSetTimeout(resolve, 2));
            fs.writeFileSync(rows[0].path, boundaryKind === 'edited-first' ? Buffer.from('USER MODIFIED CACHE BYTES') : payloads[0]);
          }
          trace.push(stageState('before-timeout'));
          await new Promise(resolve => originalSetTimeout(() => { deadline.fire(); resolve(); }, 0));
          const timedOut = await owner;
          assert.equal(timedOut.error, 'package_scan_incomplete');
          capture.mock.restore();
          trace.push(stageState('caller-return-cleanup-complete'));
          assert.equal(ownerSettled, false);
          assert.deepEqual(psdSafetyHooks.getPrePackageScanState(f.projectId), { inFlight: true, settlement: true });
          assert.equal(psdSafetyHooks.getPsdScanState().pendingRepairs, 0,
            'the registry can be empty while the timed-out phase is still settling');
          assert.ok(ownerStages.every(stage => stage.committed === false && !stage.accepted),
            'caller cleanup retires every old owner before a borrower can run');
          assert.ok(stageState('after-cleanup').members.every(member => member.held), 'cleanup did not release prior refusal');
          if (boundaryKind === 'edited-first' || boundaryKind === 'same-bytes-first') {
            assert.equal(fs.existsSync(rows[0].path), true, 'changed final identity defeats deletion authority');
          } else assert.ok(rows.every(row => !fs.existsSync(row.path)), 'unchanged committed repairs are removed before caller returns');
          const competingPrePackage = await callIpcRaw('projects:pre-package-scan', f.projectId);
          assert.equal(competingPrePackage.error, 'package_scan_incomplete');
          assert.equal(competingPrePackage.diagnostics.failurePhase, 'pre-package-scan-in-flight');
          f.advance(); await f.scan(); await drainAdjudicationPsdScans();
          trace.push(stageState('ordinary-borrower-complete-before-old-settlement'));
          const validRows = boundaryKind === 'edited-first' ? [rows[1]] : rows;
          const beforeRelease = validRows.map(row => ({ dev: fs.statSync(row.path).dev, ino: fs.statSync(row.path).ino }));
          if (boundaryKind === 'edited-first') {
            assert.equal(fs.readFileSync(rows[0].path, 'utf8'), 'USER MODIFIED CACHE BYTES');
            assert.deepEqual(f.current().workingSourceRelationshipHolds.map(hold => hold.sourcePath), [rows[0].path]);
          } else assert.deepEqual(f.current().workingSourceRelationshipHolds, []);
          // The phase remains a real package input scan until its work settles.
          const review = callIpcRaw('projects:prepare-package-review', f.projectId);
          for (let tick = 0; tick < 7; tick++) f.advance();
          assert.equal((await review).error, 'package_scan_in_flight');
          boundary.release(); await drainPrePackageAdjudication(f.projectId); ownerSettled = true;
          trace.push(stageState('old-phase-settled'));
          assert.equal(psdSafetyHooks.getPsdScanState().pendingRepairs, 0);
          assert.deepEqual(validRows.map(row => ({ dev: fs.statSync(row.path).dev, ino: fs.statSync(row.path).ino })), beforeRelease,
            'late old cleanup cannot delete or replace a borrower-validated output');
          for (const row of validRows) assert.deepEqual(fs.readFileSync(row.path), payloads[rows.indexOf(row)]);
          if (boundaryKind === 'edited-first') {
            assert.equal(fs.readFileSync(rows[0].path, 'utf8'), 'USER MODIFIED CACHE BYTES');
            assert.ok(f.current().workingSourceRelationshipHolds.some(hold => hold.sourcePath === rows[0].path));
          }
          const out = path.join(f.tmpRoot, 'phase-timeout-out'); fs.mkdirSync(out);
          const refused = await callIpc('projects:package', f.projectId, out);
          assert.notEqual(refused?.success, true); assert.deepEqual(fs.readdirSync(out), [], 'incomplete phase cannot ship bytes');
          if (boundaryKind === 'edited-first') fs.writeFileSync(rows[0].path, payloads[0]);
          f.advance();
          const retried = await callIpcRaw('projects:pre-package-scan', f.projectId);
          assert.equal(retried?.error, undefined); assert.deepEqual(f.current().workingSourceRelationshipHolds, []);
          assert.deepEqual(fs.readdirSync(f.extractDir).sort(), rows.map(row => row.name).sort(), 'all old stage temporaries drain without duplicate outputs');
          const packaged = await callIpc('projects:package', f.projectId, out);
          assert.equal(packaged.success, true); assert.equal(packaged.copiedCount, 3);
          for (const [index, row] of rows.entries()) assert.deepEqual(fs.readFileSync(path.join(packaged.folderPath, row.name)), payloads[index]);
          trace.push(stageState('successful-retry'));
          t.diagnostic(JSON.stringify({ boundaryKind, trace }));
        } finally {
          boundary.release(); await owner.catch(() => {}); await drainPrePackageAdjudication(f.projectId);
          undo(); opened.mock.restore(); capture.mock.restore(); originalClearTimeout(watch);
        }
      });
    });
  });
}

for (const route of ['ordinary', 'pre-package']) {
  test(`pre-package phase adjudication: ${route} accepted output retains hold until source validates`, async t => {
    await withAdjudicationClonedStore(t, async () => {
      await withTwoMissingHeldPsdRecords('unverifiable-' + route, async (f, rows, payloads, state) => {
        const source = fs.readFileSync(f.source); let stages, changed = false;
        const undo = psdSafetyHooks.interceptExtraction(before => async (...args) => {
          const publish = args[3].onOrdinaryPsdOutputs;
          args[3] = { ...args[3], onOrdinaryPsdOutputs(outputs) { stages = outputs; publish(outputs); } };
          const result = await before(...args);
          if (!changed) { changed = true; fs.writeFileSync(f.source, 'SAVED SOURCE CHANGED BEFORE ACCEPTANCE'); }
          return result;
        });
        try {
          if (route === 'ordinary') await f.scan(); else await callIpcRaw('projects:pre-package-scan', f.projectId);
          await drainAdjudicationPsdScans();
        } finally { undo(); }
        assert.equal(changed, true); assert.equal(stages.length, 2);
        assert.ok(stages.every(stage => stage.accepted === true));
        assert.equal(psdSafetyHooks.getPsdScanState().pendingRepairs, 0);
        assert.ok(state('accepted-unverifiable').members.every(member => member.exists && member.held));
        assert.equal((await callIpcRaw('projects:prepare-package-review', f.projectId)).materializable, false);
        const inodes = rows.map(row => fs.statSync(row.path).ino);
        fs.writeFileSync(f.source, source); f.advance();
        await f.scan(); await drainAdjudicationPsdScans();
        assert.deepEqual(f.current().workingSourceRelationshipHolds, []);
        assert.deepEqual(rows.map(row => fs.statSync(row.path).ino), inodes);
        assert.equal((await callIpcRaw('projects:prepare-package-review', f.projectId)).materializable, true);
        t.diagnostic(JSON.stringify({ route, stagesAccepted: true, recovered: state('source-validated') }));
      });
    });
  });
}
