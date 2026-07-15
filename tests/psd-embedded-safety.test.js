const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { promisify: nodePromisify } = require('util');
const {
  EDGE_TYPES,
  NODE_TYPES,
  PROVENANCE_SCHEMA_VERSION,
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
setStub('ag-psd', () => ({
  readPsd: () => currentPsdFixture,
}));

setStub('uuid', () => ({ v4: () => `test-id-${Math.random().toString(16).slice(2)}` }));

require(path.resolve(__dirname, '..', 'main.js'));

function callIpc(channel, ...args) {
  const handler = ipcHandlers.get(channel);
  if (!handler) throw new Error(`No IPC handler registered for ${channel}`);
  return handler({ sender: trustedRendererWindow.webContents, senderFrame: trustedRendererMainFrame }, ...args);
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
  clearTrackedTimeouts();
  clearTrackedIntervals();
  global.setTimeout = originalSetTimeout;
  global.clearTimeout = originalClearTimeout;
  global.setInterval = originalSetInterval;
  global.clearInterval = originalClearInterval;
  os.homedir = originalHomedir;
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
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

test('package provenance records copied files and skips missing files', async () => {
  const tmpRoot = makeTempDir();
  try {
    const sourcePath = path.join(tmpRoot, 'logo.ai');
    const missingPath = path.join(tmpRoot, 'missing.ai');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, Buffer.from('logo bytes'));
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
        },
        [containerFileNodeId]: {
          id: containerFileNodeId,
          type: NODE_TYPES.FILE,
          path: containerPath,
          name: 'brand.psd',
        },
        [containerNodeId]: {
          id: containerNodeId,
          type: NODE_TYPES.CONTAINER,
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
        },
      },
      observations: [],
      evidence: {
        ev_sensitive_parser_fixture: {
          id: 'ev_sensitive_parser_fixture',
          kind: 'parser_fixture',
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
    assert.equal(result.copiedCount, 1);
    assert.equal(result.embeddedCount, 0);
    assert.equal(result.totalFiles, 2);
    assert.deepEqual(result.errors, ['File not found: missing.ai']);

    const destFolder = packageFolder(outputDir, 'Package Provenance Copy');
    const copiedPath = path.join(destFolder, 'logo.ai');
    assert.equal(fs.readFileSync(copiedPath, 'utf8'), 'logo bytes');

    const project = getStoredProject('package-provenance-copy');
    const includeEdges = getProvenanceEdges(project, EDGE_TYPES.PACKAGE_INCLUDES_FILE);
    const extractEdges = getProvenanceEdges(project, EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE);
    assert.equal(includeEdges.length, 1);
    assert.equal(extractEdges.length, 0);
    assert.equal(includeEdges[0].payload.outputPath, copiedPath);
    assert.equal(includeEdges[0].payload.source, 'manual-browse');
    assert.equal(includeEdges[0].confidence.band, 'confirmed');
    assert.ok(project.provenance.nodes[includeEdges[0].subjectNodeId]);
    assert.ok(project.provenance.nodes[includeEdges[0].objectNodeId]);

    const manifest = readManifest(outputDir, 'Package Provenance Copy');
    assert.equal(fs.existsSync(rootManifestPath(outputDir, 'Package Provenance Copy')), false);
    assert.equal(manifest.schemaVersion, PROVENANCE_SCHEMA_VERSION);
    assert.equal(manifest.scope, 'partial_package_relevant');
    assert.equal(manifest.generatedBy.app, 'Crate');
    assert.equal(typeof manifest.generatedBy.version, 'string');
    assert.equal(manifest.project.id, 'package-provenance-copy');
    assert.equal(manifest.project.name, 'Package Provenance Copy');
    assert.equal(manifest.project.sessionId, project.provenance.sessionId);
    assert.equal(manifest.package.path, destFolder);
    assert.equal(manifest.package.copiedCount, 1);
    assert.equal(manifest.package.embeddedCount, 0);
    assert.equal(manifest.package.totalFiles, 2);
    assert.deepEqual(manifest.package.errors, ['File not found: missing.ai']);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 1);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE).length, 0);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.CONTAINER_REFERENCES_FILE).length, 1);
    assert.equal(manifest.evidence.length, 1);
    assert.equal(manifest.evidence[0].payload.token, '[redacted]');
    assert.equal(manifest.evidence[0].payload.command, '[redacted]');
    assert.equal(manifest.evidence[0].payload.rawFigmaApiResponse, '[redacted]');
    assert.equal(manifest.evidence[0].payload.note, 'Review [redacted-url] and [redacted-url]');
    assert.equal(manifest.evidence[0].payload.authNote, '[redacted-credential]');
    assert.match(manifest.evidence[0].payload.jsonAuthNote, /\[redacted-credential\]/);
    assert.equal(manifest.evidence[0].payload.authorization, '[redacted]');
    assert.equal(manifest.evidence[0].payload.cookie, '[redacted]');
    assert.equal(manifest.evidence[0].payload.password, '[redacted]');
    assert.equal(manifest.evidence[0].payload.credential, '[redacted]');
    assert.equal(manifest.edges.some(edge => JSON.stringify(edge).includes(missingPath)), false);
    assert.equal(manifest.warnings.some(warning => warning.includes('Partial package-relevant')), true);

    const manifestText = JSON.stringify(manifest);
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

test('package copy rejects symlink sources without copying target contents', async () => {
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

    const result = await callIpc('projects:package', 'package-copy-symlink', outputDir);

    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 0);
    assert.equal(result.embeddedCount, 0);
    assert.equal(result.totalFiles, 1);
    assert.deepEqual(result.errors, ['Failed to copy linked-secret.ai: Symlink source files are not copied']);

    const destFolder = packageFolder(outputDir, 'Package Copy Symlink');
    assert.equal(fs.existsSync(path.join(destFolder, 'linked-secret.ai')), false);
    const manifestText = JSON.stringify(readManifest(outputDir, 'Package Copy Symlink'));
    assert.equal(manifestText.includes(targetPath), false);
    assert.equal(manifestText.includes('secret target bytes'), false);
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
    assert.equal(manifest.project.sessionId, 'session_empty');
    assert.equal(manifest.package.copiedCount, 0);
    assert.equal(manifest.package.embeddedCount, 0);
    assert.equal(manifest.package.totalFiles, 0);
    assert.deepEqual(manifest.nodes, []);
    assert.deepEqual(manifest.edges, []);
    assert.deepEqual(manifest.evidence, []);
    assert.equal(manifest.warnings.includes('No package provenance edges were available for this package.'), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('manifest write failure does not block package success', async () => {
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
    assert.equal(fs.readFileSync(path.join(destFolder, 'logo.ai'), 'utf8'), 'logo bytes');
    assert.equal(fs.existsSync(rootManifestPath(outputDir, 'Manifest Write Failure')), false);
    assert.equal(fs.statSync(path.join(diagnosticsFolder, 'crate-provenance.json')).isDirectory(), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('diagnostic manifest skips symlinked diagnostics folder without escaping package root', async () => {
  const tmpRoot = makeTempDir();
  const originalWarn = console.warn;
  const warnings = [];
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

    console.warn = (...args) => {
      warnings.push(args.map(arg => String(arg)).join(' '));
    };
    const result = await callIpc('projects:package', 'manifest-symlink-safety', outputDir);

    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.embeddedCount, 0);
    assert.equal(result.totalFiles, 1);
    assert.deepEqual(result.errors, []);
    assert.equal(fs.readFileSync(path.join(destFolder, 'logo.ai'), 'utf8'), 'logo bytes');
    assert.equal(fs.existsSync(rootManifestPath(outputDir, 'Manifest Symlink Safety')), false);
    assert.equal(fs.existsSync(path.join(symlinkTarget, 'crate-provenance.json')), false);
    assert.equal(fs.lstatSync(diagnosticsFolder).isSymbolicLink(), true);
    assert.equal(JSON.stringify(result).includes(symlinkTarget), false);

    const warningText = warnings.join('\n');
    assert.match(warningText, /manifest write skipped/);
    assert.equal(warningText.includes(symlinkTarget), false);
    assert.equal(warningText.includes(tmpRoot), false);
  } finally {
    console.warn = originalWarn;
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
    assert.deepEqual(
      manifestExtractEdges.map(edge => path.basename(edge.payload.outputPath)).sort(),
      ['absolute-path-like.png', 'duplicate.png', 'duplicate_1.png', 'escape.png']
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
