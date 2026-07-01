const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { promisify: nodePromisify } = require('util');
const packageJson = require('../package.json');
const helperPlistPatch = require('../scripts/patch-helper-info-plists');

const {
  NODE_TYPES,
  EDGE_TYPES,
  OBSERVER_KINDS,
  CONFIDENCE_BANDS,
  PROVENANCE_SCHEMA_VERSION,
} = require('../provenance');

const originalSetInterval = global.setInterval;
const originalClearInterval = global.clearInterval;
const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;
const originalHomedir = os.homedir;
const TEST_HOME = path.join(os.tmpdir(), 'crate-provenance-dual-write-home');
const EXPECTED_LIVE_EVIDENCE_CANDIDATE_CAP = 500;
const activeIntervals = new Set();
const activeIntervalCallbacks = new Map();
const activeTimeouts = new Set();

fs.rmSync(TEST_HOME, { recursive: true, force: true });
fs.mkdirSync(path.join(TEST_HOME, 'Desktop'), { recursive: true });
fs.mkdirSync(path.join(TEST_HOME, 'Documents'), { recursive: true });
fs.mkdirSync(path.join(TEST_HOME, 'Downloads'), { recursive: true });
os.homedir = () => TEST_HOME;

global.setInterval = function trackedSetInterval(fn, delay, ...args) {
  const timer = originalSetInterval(fn, delay, ...args);
  activeIntervals.add(timer);
  activeIntervalCallbacks.set(timer, () => fn(...args));
  return timer;
};

global.clearInterval = function trackedClearInterval(timer) {
  activeIntervals.delete(timer);
  activeIntervalCallbacks.delete(timer);
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

function clearTrackedTimers() {
  for (const timer of [...activeIntervals]) {
    global.clearInterval(timer);
  }
  for (const timer of [...activeTimeouts]) {
    global.clearTimeout(timer);
  }
}

async function runTrackedIntervalCallbacks(iterations = 1) {
  for (let i = 0; i < iterations; i++) {
    const callbacks = [...activeIntervalCallbacks.values()];
    for (const callback of callbacks) {
      await Promise.resolve(callback());
    }
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
let nextOpenDialogResult = { canceled: true };
let testNotificationSupported = false;
let testAppActive = true;
let testBrowserWindowCreateCount = 0;
const testNotifications = [];

class TestBrowserWindow {
  constructor() {
    testBrowserWindowCreateCount += 1;
    this.webContents = { send: () => {} };
  }
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
  constructor(options = {}) {
    this.options = options;
    this.handlers = new Map();
    this.shown = false;
    testNotifications.push(this);
  }
  static isSupported() { return testNotificationSupported; }
  show() { this.shown = true; }
  on(channel, handler) { this.handlers.set(channel, handler); }
}

setStub('electron', () => ({
  app: {
    requestSingleInstanceLock: () => true,
    quit: () => {},
    whenReady: () => ({ then: () => {} }),
    on: () => {},
    isActive: () => testAppActive,
    getPath: () => path.join(os.tmpdir(), 'crate-provenance-dual-write-userdata'),
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
    showOpenDialog: async () => nextOpenDialogResult,
    showSaveDialog: async () => ({ canceled: true }),
    showMessageBox: async () => ({ response: 0 }),
  },
  shell: { openPath: () => {} },
  nativeImage: { createFromPath: () => ({ resize: () => ({}) }), createEmpty: () => ({}) },
  Notification: TestNotification,
  Menu: { buildFromTemplate: () => ({}) },
}));

let storeInstance = null;
class FakeStore {
  constructor(opts = {}) {
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

const watcherRecords = [];
setStub('chokidar', () => ({
  watch: () => {
    const handlers = {};
    const watcher = {
      on(eventName, handler) {
        handlers[eventName] = handler;
        return watcher;
      },
      close() {},
      add() {},
      unwatch() {},
    };
    watcherRecords.push({ handlers });
    return watcher;
  },
}));

setStub('node-fetch', () => async () => ({ ok: false, status: 500, json: async () => ({}) }));

let childProcessHandler = null;

function setChildProcessHandler(handler) {
  childProcessHandler = handler;
}

function commandText(command, args = []) {
  return [command, ...(Array.isArray(args) ? args : [])].join(' ');
}

function getChildProcessResult(kind, command, args = []) {
  if (!childProcessHandler) return { stdout: '', stderr: '' };
  return childProcessHandler({
    kind,
    command,
    args: Array.isArray(args) ? args : [],
    commandText: commandText(command, args),
  }) || { stdout: '', stderr: '' };
}

function isOsascriptInvocation({ kind, command, args }, scriptName) {
  return kind === 'execFile' &&
    command === '/usr/bin/osascript' &&
    Array.isArray(args) &&
    args.length === 1 &&
    path.basename(args[0]) === scriptName;
}

function isIllustratorPgrepCheck({ kind, command, args }) {
  return kind === 'execFile' &&
    command === '/usr/bin/pgrep' &&
    Array.isArray(args) &&
    args[0] === '-x' &&
    args[1] === 'Adobe Illustrator';
}

function isIllustratorPsCommCheck({ kind, command, args }) {
  return kind === 'execFile' &&
    command === '/bin/ps' &&
    Array.isArray(args) &&
    args.includes('comm=');
}

function isIllustratorPsCommandCheck({ kind, command, args }) {
  return kind === 'execFile' &&
    command === '/bin/ps' &&
    Array.isArray(args) &&
    args[0] === 'axww' &&
    args.includes('command=');
}

function countTextOccurrences(text, needle) {
  return String(text || '').split(needle).length - 1;
}

function assertIllustratorPlacedItemPathFallbackGuarded(scriptText) {
  assert.equal(scriptText.includes('on crateLiveEvidencePlacedItemPath(pItem)'), true);
  assert.equal(scriptText.includes('set pathResult to my crateLiveEvidencePlacedItemPath(pItem)'), true);
  assert.equal(scriptText.includes('set linkedPath to my crateLiveEvidencePath(file of pItem)'), true);
  assert.equal(scriptText.includes('set linkedPath to my crateLiveEvidencePath(file path of pItem)'), true);
  assert.equal(scriptText.includes('set linkedPath to my crateLiveEvidencePath((file path of pItem) as text)'), true);
  assert.equal(scriptText.includes('set linkedPath to POSIX path of ((file path of pItem) as alias)'), true);
  assert.equal(scriptText.includes('set pathQueryFailed to "true"'), true);
  assert.equal(scriptText.includes('set pathTextQueryFailed to "true"'), true);
  assert.equal(scriptText.includes('set pathAliasQueryFailed to "true"'), true);
  assert.equal(scriptText.includes('illustrator-placed-item-path-fallback-used'), true);
  assert.equal(scriptText.includes('illustrator-placed-item-file-path-text-fallback-used'), true);
  assert.equal(scriptText.includes('illustrator-placed-item-file-path-alias-fallback-used'), true);
  const helperStart = scriptText.indexOf('on crateLiveEvidencePlacedItemPath(pItem)');
  const helperEnd = scriptText.indexOf('end crateLiveEvidencePlacedItemPath', helperStart);
  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  const helperText = scriptText.slice(helperStart, helperEnd);
  const helperTellStart = helperText.indexOf('tell application "Adobe Illustrator"');
  const helperTellEnd = helperText.indexOf('end tell', helperTellStart);
  assert.notEqual(helperTellStart, -1);
  assert.notEqual(helperTellEnd, -1);
  assert.ok(helperTellStart < helperText.indexOf('file of pItem'));
  assert.ok(helperTellEnd > helperText.lastIndexOf('file path of pItem'));
  assert.equal(
    countTextOccurrences(scriptText, 'file path of pItem'),
    countTextOccurrences(helperText, 'file path of pItem')
  );
  assert.equal(countTextOccurrences(helperText, 'try') >= 4, true);
  assert.equal(countTextOccurrences(helperText, 'on error') >= 4, true);
}

function assertPrivateTempScriptPath(scriptPath) {
  const scriptDir = path.dirname(scriptPath);
  assert.equal(path.resolve(path.dirname(scriptDir)), path.resolve(os.tmpdir()));
  assert.equal(path.basename(scriptDir).startsWith('crate-script-'), true);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(scriptDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(scriptPath).mode & 0o777, 0o600);
  }
}

function toStartupHfsPath(posixPath) {
  return `Macintosh HD:${path.resolve(posixPath).replace(/^\/+/, '').split(path.sep).join(':')}`;
}

function createChildProcessStub() {
  return {
    on: () => {},
    kill: () => {},
    stdout: { on: () => {} },
    stderr: { on: () => {} },
  };
}

function execStub(...args) {
  const command = args[0];
  const callback = args.find(arg => typeof arg === 'function');
  const result = getChildProcessResult('exec', command, []);
  if (callback) {
    queueMicrotask(() => callback(result.error || null, result.stdout || '', result.stderr || ''));
  }
  return createChildProcessStub();
}
execStub[nodePromisify.custom] = async (command) => {
  const result = getChildProcessResult('exec', command, []);
  if (result.error) throw result.error;
  return { stdout: result.stdout || '', stderr: result.stderr || '' };
};

function execFileStub(...args) {
  const command = args[0];
  const fileArgs = Array.isArray(args[1]) ? args[1] : [];
  const callback = args.find(arg => typeof arg === 'function');
  const result = getChildProcessResult('execFile', command, fileArgs);
  if (callback) {
    queueMicrotask(() => callback(result.error || null, result.stdout || '', result.stderr || ''));
  }
  return createChildProcessStub();
}
execFileStub[nodePromisify.custom] = async (command, fileArgs = []) => {
  const result = getChildProcessResult('execFile', command, fileArgs);
  if (result.error) throw result.error;
  return { stdout: result.stdout || '', stderr: result.stderr || '' };
};

setStub('child_process', () => ({
  execSync: () => '',
  execFileSync: () => '',
  exec: execStub,
  execFile: execFileStub,
}));

let currentPsdFixture = { children: [], linkedFiles: [] };
setStub('ag-psd', () => ({ readPsd: () => currentPsdFixture }));
setStub('uuid', () => ({ v4: () => `dual-write-project-${watcherRecords.length + 1}` }));

require(path.resolve(__dirname, '..', 'main.js'));

async function callIpc(channel, ...args) {
  const handler = ipcHandlers.get(channel);
  if (!handler) throw new Error(`No IPC handler registered for ${channel}`);
  return handler({}, ...args);
}

async function createProject(name = 'Provenance Dual Write') {
  return callIpc('projects:create', name, 'branding', 'current-page', null);
}

async function getProject(projectId) {
  const projects = await callIpc('projects:get-all');
  return projects.find(project => project.id === projectId);
}

async function waitForProject(projectId, predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  let project = await getProject(projectId);
  while (!predicate(project)) {
    if (Date.now() - startedAt > timeoutMs) {
      assert.fail(`timed out waiting for project ${projectId}`);
    }
    await new Promise(resolve => originalSetTimeout(resolve, 25));
    project = await getProject(projectId);
  }
  return project;
}

async function waitForNotificationShown(index = 0, timeoutMs = 1500) {
  const startedAt = Date.now();
  while (!testNotifications[index] || !testNotifications[index].shown) {
    if (Date.now() - startedAt > timeoutMs) {
      assert.fail(`timed out waiting for notification ${index} to be shown`);
    }
    await new Promise(resolve => originalSetTimeout(resolve, 25));
  }
  return testNotifications[index];
}

function latestWatcherHandlers() {
  const record = watcherRecords[watcherRecords.length - 1];
  assert.ok(record, 'expected chokidar watcher to be created');
  return record.handlers;
}

async function emitWatcher(eventName, filePath) {
  const handler = latestWatcherHandlers()[eventName];
  assert.equal(typeof handler, 'function', `expected ${eventName} watcher handler`);
  await handler(filePath);
}

function manualDialogFor(filePaths) {
  nextOpenDialogResult = { canceled: false, filePaths };
}

function makePendingFile(filePath, source = 'lastused-scan') {
  return {
    path: filePath,
    name: path.basename(filePath),
    ext: path.extname(filePath).toLowerCase(),
    addedAt: Date.now(),
    source,
  };
}

async function setProjectFiles(projectId, { files = [], pendingFiles = [], liveEvidenceLedger } = {}) {
  const projects = await callIpc('projects:get-all');
  const project = projects.find(item => item.id === projectId);
  assert.ok(project, 'expected project to exist');
  project.files = files;
  project.pendingFiles = pendingFiles;
  if (arguments[1] && Object.prototype.hasOwnProperty.call(arguments[1], 'liveEvidenceLedger')) {
    project.liveEvidenceLedger = liveEvidenceLedger;
  }
  return project;
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crate-provenance-parser-'));
}

function presentationCachePaths(projectId) {
  const crateDir = path.join(TEST_HOME, '.crate');
  const assetsDir = path.join(crateDir, 'presentation-assets');
  const projectDir = path.join(assetsDir, projectId);
  return { crateDir, assetsDir, projectDir };
}

function resetPresentationCacheRoot() {
  fs.rmSync(path.join(TEST_HOME, '.crate'), { recursive: true, force: true });
}

function chmodIfSupported(filePath, mode) {
  if (process.platform !== 'win32') fs.chmodSync(filePath, mode);
}

function makePermissivePresentationCacheDirectories(projectId) {
  const paths = presentationCachePaths(projectId);
  for (const dirPath of [paths.crateDir, paths.assetsDir, paths.projectDir]) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o755 });
    chmodIfSupported(dirPath, 0o755);
  }
  return paths;
}

function assertOwnerOnlyMode(filePath, expectedMode) {
  if (process.platform === 'win32') return;
  assert.equal(fs.statSync(filePath).mode & 0o777, expectedMode);
}

function assertPresentationCacheDirectoryModes(projectId) {
  const paths = presentationCachePaths(projectId);
  assertOwnerOnlyMode(paths.crateDir, 0o700);
  assertOwnerOnlyMode(paths.assetsDir, 0o700);
  assertOwnerOnlyMode(paths.projectDir, 0o700);
}

function assertTextExcludes(text, forbiddenValues, label) {
  forbiddenValues.forEach((value, index) => {
    assert.equal(text.includes(value), false, `${label} should exclude forbidden value ${index}`);
  });
}

function normalizeLedgerPathForTest(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') return '';
  const resolvedPath = path.resolve(filePath.trim()).replace(/\/+$/, '');
  try {
    return fs.realpathSync.native(resolvedPath).replace(/\/+$/, '').toLowerCase();
  } catch (_) {
    return resolvedPath.toLowerCase();
  }
}

function liveEvidenceKeyForTest(filePath) {
  const normalizedPath = normalizeLedgerPathForTest(filePath);
  return crypto.createHash('sha256').update(normalizedPath).digest('hex').slice(0, 24);
}

function makeLiveEvidenceLedgerEntry(filePath, captureState, observedAtMs, overrides = {}) {
  const key = liveEvidenceKeyForTest(filePath);
  const observedAt = new Date(observedAtMs).toISOString();
  const latest = {
    schemaVersion: 1,
    evidenceKey: key,
    candidateName: path.basename(filePath),
    candidateExt: path.extname(filePath).toLowerCase(),
    source: 'lsof',
    observerMethod: 'lsof',
    evidenceStrength: 'broad-app-signal',
    captureRecommendation: captureState,
    reason: captureState === 'ignored' ? 'crate-output-path' : 'test-live-evidence',
    designerReason: 'Waiting for review.',
    observedAt,
    ...(overrides.latest || {}),
  };
  return [key, {
    evidenceKey: key,
    firstObservedAt: observedAt,
    strongestState: captureState,
    latest,
    updatedAt: observedAt,
    observations: [{
      observerMethod: latest.observerMethod,
      evidenceStrength: latest.evidenceStrength,
      captureState,
      reason: latest.reason,
      observedAt,
    }],
    ...overrides.entry,
  }];
}

async function captureConsoleDuring(fn) {
  const originals = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const output = [];
  for (const method of Object.keys(originals)) {
    console[method] = (...args) => {
      output.push(args.map(arg => arg instanceof Error ? arg.message : String(arg)).join(' '));
    };
  }
  try {
    const result = await fn();
    return { result, output: output.join('\n') };
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  }
}

function resetTestHomeWorkspace() {
  for (const folder of ['Desktop', 'Documents', 'Downloads']) {
    const folderPath = path.join(TEST_HOME, folder);
    fs.rmSync(folderPath, { recursive: true, force: true });
    fs.mkdirSync(folderPath, { recursive: true });
  }
}

function getProvenanceEdges(project, relationType) {
  return Object.values((project && project.provenance && project.provenance.edges) || {})
    .filter(edge => edge && edge.relationType === relationType);
}

function getProvenanceNodes(project, nodeType) {
  return Object.values((project && project.provenance && project.provenance.nodes) || {})
    .filter(node => node && node.type === nodeType);
}

function getProvenanceObservations(project, relationType) {
  return ((project && project.provenance && project.provenance.observations) || [])
    .filter(observation => observation && observation.relationType === relationType);
}

function getSessionObservedByMethod(project, method) {
  return getProvenanceObservations(project, EDGE_TYPES.SESSION_OBSERVED_FILE)
    .filter(observation => observation.observer && observation.observer.method === method);
}

function getLiveAppStatusEntries(project, appFamily = 'illustrator') {
  const appStatus = project &&
    project.liveAppEvidenceStatus &&
    project.liveAppEvidenceStatus.apps &&
    project.liveAppEvidenceStatus.apps[appFamily];
  return appStatus && Array.isArray(appStatus.entries) ? appStatus.entries : [];
}

function getLatestLiveAppStatus(project, appFamily = 'illustrator') {
  const entries = getLiveAppStatusEntries(project, appFamily);
  return entries[entries.length - 1] || null;
}

function assertNoRelationshipEdges(project) {
  assert.equal(getProvenanceEdges(project, EDGE_TYPES.CONTAINER_REFERENCES_FILE).length, 0);
  assert.equal(getProvenanceEdges(project, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 0);
  assert.equal(getProvenanceEdges(project, EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE).length, 0);
}

function assertProvenanceTextExcludes(project, forbiddenValues) {
  const provenanceText = JSON.stringify(project.provenance);
  for (const value of forbiddenValues) {
    assert.equal(provenanceText.includes(value), false, `provenance should not include ${value}`);
  }
}

function packageFolder(outputDir, projectName) {
  const dateStr = new Date().toISOString().split('T')[0];
  return path.join(outputDir, `${projectName}_${dateStr}`);
}

function quickPackageFolder(masterFilePath) {
  const dateStr = new Date().toISOString().split('T')[0];
  const baseName = path.basename(masterFilePath, path.extname(masterFilePath));
  return path.join(TEST_HOME, 'Desktop', `${baseName}_${dateStr}`);
}

function manifestPath(outputDir, projectName) {
  return path.join(packageFolder(outputDir, projectName), 'Crate Diagnostics', 'crate-provenance.json');
}

function rootManifestPath(outputDir, projectName) {
  return path.join(packageFolder(outputDir, projectName), 'crate-provenance.json');
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

test('mac build metadata declares Apple Events usage and preserves Automation entitlement', () => {
  assert.equal(packageJson.build.appId, 'com.crate.app');
  assert.equal(packageJson.build.afterPack, 'scripts/patch-helper-info-plists.js');
  assert.equal(packageJson.build.mac.entitlements, 'entitlements.plist');
  assert.equal(packageJson.build.mac.entitlementsInherit, 'entitlements.plist');
  const usageDescription = packageJson.build.mac.extendInfo
    && packageJson.build.mac.extendInfo.NSAppleEventsUsageDescription;
  assert.match(
    usageDescription,
    /Automation.*open design documents.*linked assets.*Adobe Illustrator/i
  );

  const entitlementsPath = path.resolve(__dirname, '..', 'entitlements.plist');
  const entitlements = fs.readFileSync(entitlementsPath, 'utf8');
  assert.match(entitlements, /com\.apple\.security\.automation\.apple-events/);
  assert.match(entitlements, /com\.apple\.security\.cs\.disable-library-validation/);
  assert.equal(entitlements.includes('com.apple.security.app-sandbox'), false);
});

test('helper Info.plist patch adds Apple Events usage before signing and is idempotent', () => {
  const tmpRoot = makeTempDir();
  try {
    const appOutDir = path.join(tmpRoot, 'mac-arm64');
    const appBundle = path.join(appOutDir, 'Crate.app');
    const helperInfoPlist = path.join(
      appBundle,
      'Contents',
      'Frameworks',
      'Crate Helper.app',
      'Contents',
      'Info.plist'
    );
    const rendererHelperInfoPlist = path.join(
      appBundle,
      'Contents',
      'Frameworks',
      'Crate Helper (Renderer).app',
      'Contents',
      'Info.plist'
    );
    const mainInfoPlist = path.join(appBundle, 'Contents', 'Info.plist');
    for (const plistPath of [helperInfoPlist, rendererHelperInfoPlist, mainInfoPlist]) {
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.writeFileSync(plistPath, [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<plist version="1.0">',
        '<dict>',
        '<key>CFBundleIdentifier</key>',
        '<string>com.crate.app.helper</string>',
        '</dict>',
        '</plist>',
        '',
      ].join('\n'));
    }

    const resolvedBundle = helperPlistPatch.resolveAppBundlePath({
      appOutDir,
      packager: { appInfo: { productFilename: 'Crate' } },
    });
    assert.equal(resolvedBundle, appBundle);

    const patched = helperPlistPatch.patchHelperInfoPlists(appBundle);
    assert.deepEqual(patched.sort(), [helperInfoPlist, rendererHelperInfoPlist].sort());
    const secondPatch = helperPlistPatch.patchHelperInfoPlists(appBundle);
    assert.deepEqual(secondPatch, []);

    const helperText = fs.readFileSync(helperInfoPlist, 'utf8');
    const rendererText = fs.readFileSync(rendererHelperInfoPlist, 'utf8');
    const mainText = fs.readFileSync(mainInfoPlist, 'utf8');
    assert.ok(helperText.includes('NSAppleEventsUsageDescription'));
    assert.ok(rendererText.includes('NSAppleEventsUsageDescription'));
    assert.ok(helperText.includes(helperPlistPatch.APPLE_EVENTS_USAGE_DESCRIPTION));
    assert.ok(rendererText.includes(helperPlistPatch.APPLE_EVENTS_USAGE_DESCRIPTION));
    assert.equal(mainText.includes('NSAppleEventsUsageDescription'), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

function setPresentationUnzipFixture(mediaEntries, archiveName = 'deck.pptx') {
  const byInternalPath = new Map(mediaEntries.map(entry => [entry.internalPath, entry]));
  const entryData = (entry) => Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '');
  const listedPath = (entry) => typeof entry.listedPath === 'string' ? entry.listedPath : entry.internalPath;
  const matchesZipPattern = (pattern, candidate) => {
    const wildcardIndex = pattern.indexOf('*');
    if (wildcardIndex === -1) return pattern === candidate;
    const prefix = pattern.slice(0, wildcardIndex);
    const suffix = pattern.slice(wildcardIndex + 1);
    return candidate.startsWith(prefix) && candidate.endsWith(suffix);
  };
  const entryMatches = (entryPath) => {
    if (byInternalPath.has(entryPath)) return [entryPath];
    if (!entryPath.includes('*')) return [];
    return [...byInternalPath.keys()].filter(candidate => matchesZipPattern(entryPath, candidate));
  };

  setChildProcessHandler(({ kind, command, args }) => {
    if (kind !== 'execFile' || command !== '/usr/bin/unzip') return { stdout: '', stderr: '' };
    if (args[0] === '-l') {
      const lines = mediaEntries.map(entry => {
        const size = entryData(entry).length;
        return `      ${size}  05-26-2026 12:34   ${listedPath(entry)}`;
      });
      return { stdout: [`Archive: ${archiveName}`, ...lines, ''].join('\n'), stderr: '' };
    }
    if (args[0] === '-p') {
      const matches = entryMatches(args[2]);
      if (matches.length === 0) throw new Error(`Missing fixture for ${args[2]}`);
      const buffers = matches.map(match => {
        const entry = byInternalPath.get(match);
        if (entry && entry.error) throw entry.error;
        return entryData(entry);
      });
      return { stdout: Buffer.concat(buffers), stderr: '' };
    }
    return { stdout: '', stderr: '' };
  });
}

function setPresentationUnzipListingFailure(error) {
  setChildProcessHandler(({ kind, command, args }) => {
    if (kind !== 'execFile' || command !== '/usr/bin/unzip') return { stdout: '', stderr: '' };
    if (args[0] === '-l') throw error;
    return { stdout: '', stderr: '' };
  });
}

function setPowerPointUnzipFixture(mediaEntries) {
  setPresentationUnzipFixture(mediaEntries, 'deck.pptx');
}

function setKeynoteUnzipFixture(mediaEntries) {
  setPresentationUnzipFixture(mediaEntries, 'deck.key');
}

function assertSessionObservedFile(project, observerKind, method, confidenceBand) {
  const observations = project.provenance.observations;
  assert.equal(observations.length, 1);
  const observation = observations[0];
  assert.equal(observation.kind, EDGE_TYPES.SESSION_OBSERVED_FILE);
  assert.equal(observation.relationType, EDGE_TYPES.SESSION_OBSERVED_FILE);
  assert.equal(observation.observer.kind, observerKind);
  assert.equal(observation.observer.method, method);
  assert.equal(observation.confidence.band, confidenceBand);
  assert.notEqual(observation.relationType, EDGE_TYPES.APP_OPENED_FILE);
  assert.deepEqual(project.provenance.edges, {});
  assert.ok(project.provenance.nodes[observation.subjectNodeId]);
  assert.ok(project.provenance.nodes[observation.objectNodeId]);
}

function assertPendingRejectedObservation(project) {
  const observations = project.provenance.observations;
  assert.equal(observations.length, 1);
  const observation = observations[0];
  assert.equal(observation.kind, 'pending_file_rejected');
  assert.equal(observation.relationType, 'pending_file_rejected');
  assert.equal(observation.observer.kind, OBSERVER_KINDS.MANUAL_USER_ACTION);
  assert.equal(observation.observer.method, 'projects:reject-pending');
  assert.equal(observation.confidence.band, CONFIDENCE_BANDS.WEAK);
  assert.deepEqual(observation.payload, {
    decision: 'rejected',
    source: 'lastused-scan',
  });
  assert.deepEqual(project.provenance.edges, {});
  assert.ok(project.provenance.nodes[observation.subjectNodeId]);
  assert.ok(project.provenance.nodes[observation.objectNodeId]);
}

function assertPsdParserEdge(project, relationType, objectType, source) {
  const edges = getProvenanceEdges(project, relationType);
  assert.equal(edges.length, 1);
  const edge = edges[0];
  assert.equal(edge.type, relationType);
  assert.equal(edge.confidence.band, CONFIDENCE_BANDS.CONFIRMED);
  assert.deepEqual(edge.evidenceIds, []);
  assert.equal(edge.payload.parser, 'ag-psd');
  assert.equal(edge.payload.method, 'scan-on-save');
  assert.deepEqual(edge.payload.observer, {
    kind: OBSERVER_KINDS.PARSER,
    parser: 'ag-psd',
    method: 'scan-on-save',
  });
  assert.equal(edge.payload.source, source);
  assert.equal(project.provenance.nodes[edge.subjectNodeId].type, NODE_TYPES.CONTAINER);
  assert.equal(project.provenance.nodes[edge.objectNodeId].type, objectType);
}

test.afterEach(async () => {
  childProcessHandler = null;
  nextOpenDialogResult = { canceled: true };
  currentPsdFixture = { children: [], linkedFiles: [] };
  if (storeInstance) storeInstance.set('projects', []);
  if (storeInstance) storeInstance.set('settings.includeDiagnosticReport', false);
  if (storeInstance) storeInstance.set('usage.packagesThisMonth', 0);
  testNotificationSupported = false;
  testAppActive = true;
  testBrowserWindowCreateCount = 0;
  testNotifications.length = 0;
  watcherRecords.length = 0;
  clearTrackedTimers();
});

test.after(() => {
  clearTrackedTimers();
  global.setInterval = originalSetInterval;
  global.clearInterval = originalClearInterval;
  global.setTimeout = originalSetTimeout;
  global.clearTimeout = originalClearTimeout;
  os.homedir = originalHomedir;
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

test('PowerPoint scan-on-save extraction records media provenance without ledger metadata leak', async () => {
  const tmpRoot = makeTempDir();
  try {
    resetPresentationCacheRoot();
    const project = await createProject('PowerPoint Scan Save Provenance');
    const pptxPath = path.join(tmpRoot, 'Deck.pptx');
    const mediaBytes = 'JPEG_BINARY_SHOULD_NOT_LEAK token=SHOULD_NOT_LEAK https://signed.example.test/private?sig=1 RAW_SCRIPT_OUTPUT '.repeat(10);
    const forbiddenValues = [
      'JPEG_BINARY_SHOULD_NOT_LEAK',
      'token=SHOULD_NOT_LEAK',
      'https://signed.example.test/private?sig=1',
      'RAW_SCRIPT_OUTPUT',
    ];
    fs.writeFileSync(pptxPath, Buffer.from('pptx container bytes'));
    await setProjectFiles(project.id, {
      files: [{
        path: pptxPath,
        name: 'Deck.pptx',
        ext: '.pptx',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    setPowerPointUnzipFixture([{
      internalPath: 'ppt/media/image1.jpeg',
      data: Buffer.from(mediaBytes),
    }]);

    const captured = await captureConsoleDuring(async () => {
      await emitWatcher('change', pptxPath);
      return waitForProject(
        project.id,
        item => item.files.some(file => file.source === 'scan-on-save-presentation'),
        5000
      );
    });
    let fresh = captured.result;
    const extracted = fresh.files.find(file => file.source === 'scan-on-save-presentation');
    assert.ok(extracted);
    assert.deepEqual(Object.keys(extracted).sort(), ['addedAt', 'ext', 'name', 'path', 'source']);
    assert.equal(extracted.name, 'Deck — image1.jpeg');
    assert.equal(fs.readFileSync(extracted.path, 'utf8'), mediaBytes);
    assertPresentationCacheDirectoryModes(project.id);
    assertOwnerOnlyMode(extracted.path, 0o600);
    assertTextExcludes(JSON.stringify(fresh), forbiddenValues, 'PowerPoint project state');
    assertTextExcludes(captured.output, forbiddenValues, 'PowerPoint scan-on-save logs');
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 1);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE).length, 1);

    await emitWatcher('change', pptxPath);
    await new Promise(resolve => originalSetTimeout(resolve, 2600));
    fresh = await getProject(project.id);
    assert.equal(fresh.files.filter(file => file.source === 'scan-on-save-presentation').length, 1);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('presentation scan-on-save hardens existing permissive cache directories and media files', async () => {
  const tmpRoot = makeTempDir();
  try {
    resetPresentationCacheRoot();
    const project = await createProject('Presentation Cache Hardening');
    const pptxPath = path.join(tmpRoot, 'Deck.pptx');
    const paths = makePermissivePresentationCacheDirectories(project.id);
    const stalePath = path.join(paths.projectDir, 'Deck — existing.jpeg');
    fs.writeFileSync(stalePath, 'existing permissive media bytes', { mode: 0o644 });
    chmodIfSupported(stalePath, 0o644);
    fs.writeFileSync(pptxPath, Buffer.from('pptx container bytes'));
    await setProjectFiles(project.id, {
      files: [
        {
          path: pptxPath,
          name: 'Deck.pptx',
          ext: '.pptx',
          addedAt: Date.now(),
          source: 'manual-browse',
        },
        {
          path: stalePath,
          name: 'Deck — existing.jpeg',
          ext: '.jpeg',
          addedAt: Date.now(),
          source: 'scan-on-save-presentation',
        },
      ],
    });
    setPowerPointUnzipFixture([{
      internalPath: 'ppt/media/image1.jpeg',
      data: Buffer.from('PERMISSIVE_CACHE_NEW_BYTES'.repeat(40)),
    }]);

    await emitWatcher('change', pptxPath);
    const fresh = await waitForProject(
      project.id,
      item => item.files.some(file => file.name === 'Deck — image1.jpeg'),
      5000
    );
    const extracted = fresh.files.find(file => file.name === 'Deck — image1.jpeg');
    assert.ok(extracted);
    assert.equal(fs.readFileSync(extracted.path, 'utf8'), 'PERMISSIVE_CACHE_NEW_BYTES'.repeat(40));
    assertPresentationCacheDirectoryModes(project.id);
    assertOwnerOnlyMode(stalePath, 0o600);
    assertOwnerOnlyMode(extracted.path, 0o600);
    assert.equal(fresh.files.some(file => file.path === stalePath), true);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 1);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE).length, 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('presentation scan-on-save rejects symlinked cache root without leaking target path', async () => {
  if (process.platform === 'win32') return;

  const tmpRoot = makeTempDir();
  try {
    resetPresentationCacheRoot();
    const project = await createProject('Presentation Symlink Root Cache');
    const pptxPath = path.join(tmpRoot, 'Deck.pptx');
    const paths = presentationCachePaths(project.id);
    const symlinkTarget = path.join(TEST_HOME, 'SHOULD_NOT_APPEAR_PRESENTATION_ROOT_TARGET');
    fs.mkdirSync(symlinkTarget, { recursive: true });
    fs.symlinkSync(symlinkTarget, paths.crateDir, 'dir');
    fs.writeFileSync(pptxPath, Buffer.from('pptx container bytes'));
    await setProjectFiles(project.id, {
      files: [{
        path: pptxPath,
        name: 'Deck.pptx',
        ext: '.pptx',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    setPowerPointUnzipFixture([{
      internalPath: 'ppt/media/image1.jpeg',
      data: Buffer.from('PRESENTATION_SYMLINK_ROOT_BYTES'.repeat(40)),
    }]);

    const captured = await captureConsoleDuring(async () => {
      await emitWatcher('change', pptxPath);
      await new Promise(resolve => originalSetTimeout(resolve, 2600));
      return getProject(project.id);
    });

    const fresh = captured.result;
    assert.equal(fresh.files.filter(file => file.source === 'scan-on-save-presentation').length, 0);
    assert.deepEqual(fs.readdirSync(symlinkTarget), []);
    assert.equal(captured.output.includes(symlinkTarget), false);
    assert.equal(captured.output.includes('SHOULD_NOT_APPEAR_PRESENTATION_ROOT_TARGET'), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    resetPresentationCacheRoot();
  }
});

test('presentation scan-on-save rejects symlinked category cache directory without leaking target path', async () => {
  if (process.platform === 'win32') return;

  const tmpRoot = makeTempDir();
  try {
    resetPresentationCacheRoot();
    const project = await createProject('Presentation Symlink Category Cache');
    const pptxPath = path.join(tmpRoot, 'Deck.pptx');
    const paths = presentationCachePaths(project.id);
    const symlinkTarget = path.join(TEST_HOME, 'SHOULD_NOT_APPEAR_PRESENTATION_CATEGORY_TARGET');
    fs.mkdirSync(paths.crateDir, { recursive: true });
    fs.mkdirSync(symlinkTarget, { recursive: true });
    fs.symlinkSync(symlinkTarget, paths.assetsDir, 'dir');
    fs.writeFileSync(pptxPath, Buffer.from('pptx container bytes'));
    await setProjectFiles(project.id, {
      files: [{
        path: pptxPath,
        name: 'Deck.pptx',
        ext: '.pptx',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    setPowerPointUnzipFixture([{
      internalPath: 'ppt/media/image1.jpeg',
      data: Buffer.from('PRESENTATION_SYMLINK_CATEGORY_BYTES'.repeat(40)),
    }]);

    const captured = await captureConsoleDuring(async () => {
      await emitWatcher('change', pptxPath);
      await new Promise(resolve => originalSetTimeout(resolve, 2600));
      return getProject(project.id);
    });

    const fresh = captured.result;
    assert.equal(fresh.files.filter(file => file.source === 'scan-on-save-presentation').length, 0);
    assert.deepEqual(fs.readdirSync(symlinkTarget), []);
    assert.equal(captured.output.includes(symlinkTarget), false);
    assert.equal(captured.output.includes('SHOULD_NOT_APPEAR_PRESENTATION_CATEGORY_TARGET'), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    resetPresentationCacheRoot();
  }
});

test('presentation scan-on-save rejects symlinked project cache directory without leaking target path', async () => {
  if (process.platform === 'win32') return;

  const tmpRoot = makeTempDir();
  try {
    resetPresentationCacheRoot();
    const project = await createProject('Presentation Symlink Project Cache');
    const pptxPath = path.join(tmpRoot, 'Deck.pptx');
    const paths = presentationCachePaths(project.id);
    const symlinkTarget = path.join(TEST_HOME, 'SHOULD_NOT_APPEAR_PRESENTATION_PROJECT_TARGET');
    fs.mkdirSync(paths.assetsDir, { recursive: true });
    fs.mkdirSync(symlinkTarget, { recursive: true });
    fs.symlinkSync(symlinkTarget, paths.projectDir, 'dir');
    fs.writeFileSync(pptxPath, Buffer.from('pptx container bytes'));
    await setProjectFiles(project.id, {
      files: [{
        path: pptxPath,
        name: 'Deck.pptx',
        ext: '.pptx',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    setPowerPointUnzipFixture([{
      internalPath: 'ppt/media/image1.jpeg',
      data: Buffer.from('PRESENTATION_SYMLINK_PROJECT_BYTES'.repeat(40)),
    }]);

    const captured = await captureConsoleDuring(async () => {
      await emitWatcher('change', pptxPath);
      await new Promise(resolve => originalSetTimeout(resolve, 2600));
      return getProject(project.id);
    });

    const fresh = captured.result;
    assert.equal(fresh.files.filter(file => file.source === 'scan-on-save-presentation').length, 0);
    assert.deepEqual(fs.readdirSync(symlinkTarget), []);
    assert.equal(captured.output.includes(symlinkTarget), false);
    assert.equal(captured.output.includes('SHOULD_NOT_APPEAR_PRESENTATION_PROJECT_TARGET'), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    resetPresentationCacheRoot();
  }
});

test('PowerPoint package extraction records deterministic media provenance and diagnostics graph', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('PowerPoint Media Provenance');
    const pptxPath = path.join(tmpRoot, 'Deck.pptx');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(pptxPath, Buffer.from('pptx container bytes'));
    setPowerPointUnzipFixture([
      {
        internalPath: 'ppt/media/image1.jpeg',
        data: Buffer.from('JPEG_BINARY_SHOULD_NOT_LEAK'.repeat(40)),
      },
      {
        internalPath: 'ppt/media/image2.png',
        data: Buffer.from('PNG_BINARY_SHOULD_NOT_LEAK'.repeat(40)),
      },
    ]);
    await setProjectFiles(project.id, {
      files: [{
        path: pptxPath,
        name: 'Deck.pptx',
        ext: '.pptx',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    await callIpc('settings:update', 'includeDiagnosticReport', true);

    const result = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.embeddedCount, 2);
    assert.equal(result.totalFiles, 1);
    assert.deepEqual(result.errors, []);

    const destFolder = packageFolder(outputDir, 'PowerPoint Media Provenance');
    assert.equal(fs.readFileSync(path.join(destFolder, 'Deck.pptx'), 'utf8'), 'pptx container bytes');
    assert.equal(fs.readFileSync(path.join(destFolder, 'Deck — image1.jpeg'), 'utf8'), 'JPEG_BINARY_SHOULD_NOT_LEAK'.repeat(40));
    assert.equal(fs.readFileSync(path.join(destFolder, 'Deck — image2.png'), 'utf8'), 'PNG_BINARY_SHOULD_NOT_LEAK'.repeat(40));

    let fresh = await getProject(project.id);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 1);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE).length, 2);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 2);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE).length, 2);

    const embeddedResources = getProvenanceNodes(fresh, NODE_TYPES.EMBEDDED_RESOURCE)
      .filter(node => node.sourceMetadata && String(node.sourceMetadata.internalPath || '').startsWith('ppt/media/'));
    assert.deepEqual(
      embeddedResources.map(node => node.sourceMetadata.internalPath).sort(),
      ['ppt/media/image1.jpeg', 'ppt/media/image2.png']
    );
    assert.equal(
      embeddedResources.every(node => String(node.resourceKey || '').startsWith('powerpoint-media:')),
      true
    );
    assert.equal(
      getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE)
        .every(edge => edge.confidence.band === CONFIDENCE_BANDS.CONFIRMED),
      true
    );
    assert.equal(
      getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE)
        .every(edge => edge.payload.observer.parser === 'powerpoint-zip-media'),
      true
    );
    assert.equal(
      getProvenanceEdges(fresh, EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE)
        .every(edge => edge.confidence.band === CONFIDENCE_BANDS.CONFIRMED),
      true
    );

    const manifest = readManifest(outputDir, 'PowerPoint Media Provenance');
    assert.equal(fs.existsSync(rootManifestPath(outputDir, 'PowerPoint Media Provenance')), false);
    assert.equal(manifest.schemaVersion, PROVENANCE_SCHEMA_VERSION);
    assert.equal(manifest.package.copiedCount, 1);
    assert.equal(manifest.package.embeddedCount, 2);
    assert.equal(manifest.package.totalFiles, 1);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 1);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE).length, 2);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 2);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE).length, 2);
    const manifestText = JSON.stringify(manifest);
    assert.equal(manifestText.includes('ppt/media/image1.jpeg'), true);
    assert.equal(manifestText.includes('Deck — image1.jpeg'), true);
    assert.equal(manifestText.includes('JPEG_BINARY_SHOULD_NOT_LEAK'), false);
    assert.equal(manifestText.includes('PNG_BINARY_SHOULD_NOT_LEAK'), false);

    const duplicateResult = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(duplicateResult);
    assert.equal(duplicateResult.copiedCount, 1);
    assert.equal(duplicateResult.embeddedCount, 2);
    assert.equal(duplicateResult.totalFiles, 1);
    fresh = await getProject(project.id);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 2);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Quick Package consumes package quota only after successful packaging', async () => {
  const tmpRoot = makeTempDir();
  try {
    const deckPath = path.join(tmpRoot, 'Quick Quota Deck.pptx');
    fs.writeFileSync(deckPath, Buffer.from('quick package pptx bytes'));
    setPowerPointUnzipFixture([{
      internalPath: 'ppt/media/image1.jpeg',
      data: Buffer.from('QUICK_PACKAGE_QUOTA_IMAGE_BYTES'.repeat(40)),
    }]);

    storeInstance.set('usage.packagesThisMonth', 2);
    const result = await callIpc('v2:package-file', deckPath);
    assert.equal(result.success, true);
    assert.equal(result.assetsFound, 1);
    assert.equal(result.assetsCopied, 1);
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 3);
    assert.equal(fs.existsSync(path.join(quickPackageFolder(deckPath), 'Quick Quota Deck.pptx')), true);
    assert.equal(fs.existsSync(path.join(quickPackageFolder(deckPath), 'Crate Diagnostics', 'crate-provenance.json')), false);
    assert.equal(fs.existsSync(path.join(quickPackageFolder(deckPath), 'crate-provenance.json')), false);

    const missingPath = path.join(tmpRoot, 'Missing Quick Quota Deck.pptx');
    const failedResult = await callIpc('v2:package-file', missingPath);
    assert.equal(failedResult.success, undefined);
    assert.match(failedResult.error, /Master file not found/);
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 3);
    assert.equal(fs.existsSync(quickPackageFolder(missingPath)), false);

    const limitPath = path.join(tmpRoot, 'Limit Quick Quota Deck.pptx');
    fs.writeFileSync(limitPath, Buffer.from('limit quick package pptx bytes'));
    storeInstance.set('usage.packagesThisMonth', 10);
    const limitResult = await callIpc('v2:package-file', limitPath);
    assert.equal(limitResult.error, 'limit_reached');
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 10);
    assert.equal(fs.existsSync(quickPackageFolder(limitPath)), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(path.join(TEST_HOME, 'Desktop', 'Quick Quota Deck_' + new Date().toISOString().split('T')[0]), { recursive: true, force: true });
    fs.rmSync(path.join(TEST_HOME, 'Desktop', 'Limit Quick Quota Deck_' + new Date().toISOString().split('T')[0]), { recursive: true, force: true });
  }
});

test('normal project package still consumes package quota after success', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Normal Package Quota');
    const sourcePath = path.join(tmpRoot, 'Logo.ai');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, Buffer.from('normal package source bytes'));
    await setProjectFiles(project.id, {
      files: [{
        path: sourcePath,
        name: 'Logo.ai',
        ext: '.ai',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });

    storeInstance.set('usage.packagesThisMonth', 4);
    const result = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 5);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('normal project package quota survives UTC rollover before local reset day', async () => {
  const tmpRoot = makeTempDir();
  const RealDate = global.Date;
  const fixedLocalRollover = new RealDate(2026, 5, 30, 23, 30, 0);
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(fixedLocalRollover.getTime());
      } else {
        super(...args);
      }
    }
    static now() { return fixedLocalRollover.getTime(); }
    static parse(value) { return RealDate.parse(value); }
    static UTC(...args) { return RealDate.UTC(...args); }
  }

  try {
    global.Date = FixedDate;
    const project = await createProject('Normal Package Local Rollover Quota');
    const sourcePath = path.join(tmpRoot, 'Logo.ai');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, Buffer.from('normal package local rollover bytes'));
    await setProjectFiles(project.id, {
      files: [{
        path: sourcePath,
        name: 'Logo.ai',
        ext: '.ai',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });

    storeInstance.set('usage', {
      packagesThisMonth: 2,
      resetDate: '2026-07-01',
    });
    const result = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 3);
    assert.equal(storeInstance.get('usage.resetDate'), '2026-07-01');
  } finally {
    global.Date = RealDate;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('background project package leaves app hidden when native notification is shown', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Background Package Notification');
    const sourcePath = path.join(tmpRoot, 'Logo.ai');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, Buffer.from('background package notification bytes'));
    await setProjectFiles(project.id, {
      files: [{
        path: sourcePath,
        name: 'Logo.ai',
        ext: '.ai',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });

    testNotificationSupported = true;
    testAppActive = false;
    testBrowserWindowCreateCount = 0;
    testNotifications.length = 0;
    await callIpc('settings:update', 'notifications', true);

    const result = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(testNotifications.length, 1);
    assert.equal(testNotifications[0].options.title, 'Project Packaged!');
    assert.equal(testNotifications[0].options.body, 'Background Package Notification — 1 files gathered.');
    assert.equal(testNotifications[0].options.silent, false);
    assert.equal(testNotifications[0].options.icon, path.resolve(__dirname, '..', 'assets', 'icon.png'));
    assert.equal(testNotifications[0].shown, true);
    assert.equal(typeof testNotifications[0].handlers.get('click'), 'function');
    assert.equal(typeof testNotifications[0].handlers.get('failed'), 'function');
    assert.equal(testBrowserWindowCreateCount, 0);
    testNotifications[0].handlers.get('failed')({}, new Error('blocked by macOS'));
    assert.equal(testBrowserWindowCreateCount, 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('background package after destination picker stays hidden despite stale active app state', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Destination Picker Background Package');
    const sourcePath = path.join(tmpRoot, 'Logo.ai');
    const outputDir = path.join(tmpRoot, 'package-output');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, Buffer.from('destination picker background package bytes'));
    await setProjectFiles(project.id, {
      files: [{
        path: sourcePath,
        name: 'Logo.ai',
        ext: '.ai',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });

    nextOpenDialogResult = {
      canceled: false,
      filePaths: [outputDir],
    };
    testNotificationSupported = true;
    testAppActive = true;
    testBrowserWindowCreateCount = 0;
    testNotifications.length = 0;
    await callIpc('settings:update', 'notifications', true);

    const selectedPath = await callIpc('projects:select-output');
    assert.equal(selectedPath, outputDir);

    const result = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(testNotifications.length, 1);
    assert.equal(testNotifications[0].shown, false);
    assert.equal(testNotifications[0].options.silent, false);
    assert.equal(testNotifications[0].options.icon, path.resolve(__dirname, '..', 'assets', 'icon.png'));
    assert.equal(testBrowserWindowCreateCount, 0);

    await waitForNotificationShown(0);
    assert.equal(testBrowserWindowCreateCount, 0);

    testNotifications[0].handlers.get('failed')({}, new Error('blocked by macOS'));
    assert.equal(testBrowserWindowCreateCount, 0);

    testNotifications[0].handlers.get('click')();
    assert.equal(testBrowserWindowCreateCount, 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('background project package reveals app when native notification is unavailable', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Background Package Fallback');
    const sourcePath = path.join(tmpRoot, 'Logo.ai');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, Buffer.from('background package fallback bytes'));
    await setProjectFiles(project.id, {
      files: [{
        path: sourcePath,
        name: 'Logo.ai',
        ext: '.ai',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });

    testNotificationSupported = false;
    testAppActive = false;
    testBrowserWindowCreateCount = 0;
    testNotifications.length = 0;
    await callIpc('settings:update', 'notifications', true);

    const result = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(testNotifications.length, 0);
    assert.equal(testBrowserWindowCreateCount, 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('package destination selection does not foreground Crate after confirmed output', async () => {
  const tmpRoot = makeTempDir();
  try {
    const outputDir = path.join(tmpRoot, 'package-output');
    fs.mkdirSync(outputDir);
    nextOpenDialogResult = {
      canceled: false,
      filePaths: [outputDir],
    };
    testBrowserWindowCreateCount = 0;

    const selectedPath = await callIpc('projects:select-output');

    assert.equal(selectedPath, outputDir);
    assert.equal(testBrowserWindowCreateCount, 0);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('PowerPoint packaging dedupes scan-on-save media collision copies', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('PowerPoint Duplicate Media Dedupe');
    const pptxPath = path.join(tmpRoot, 'Deck.pptx');
    const cachedOne = path.join(tmpRoot, 'Deck — image1.jpeg');
    const cachedDuplicate = path.join(tmpRoot, 'Deck — image1_1.jpeg');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);

    const mediaBytes = Buffer.from('PPT_DUPLICATE_SCAN_MEDIA_BYTES_SHOULD_NOT_LEAK'.repeat(40));
    fs.writeFileSync(pptxPath, Buffer.from('pptx container bytes'));
    fs.writeFileSync(cachedOne, mediaBytes);
    fs.writeFileSync(cachedDuplicate, mediaBytes);
    setPowerPointUnzipFixture([{
      internalPath: 'ppt/media/image1.jpeg',
      data: mediaBytes,
    }]);

    await setProjectFiles(project.id, {
      files: [
        {
          path: pptxPath,
          name: 'Deck.pptx',
          ext: '.pptx',
          addedAt: Date.now(),
          source: 'manual-browse',
        },
        {
          path: cachedOne,
          name: 'Deck — image1.jpeg',
          ext: '.jpeg',
          addedAt: Date.now(),
          source: 'scan-on-save-presentation',
        },
        {
          path: cachedDuplicate,
          name: 'Deck — image1_1.jpeg',
          ext: '.jpeg',
          addedAt: Date.now(),
          source: 'scan-on-save-presentation',
        },
      ],
    });

    const result = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 2);
    assert.equal(result.embeddedCount, 0);
    assert.equal(result.totalFiles, 2);
    assert.deepEqual(result.errors, []);

    const destFolder = packageFolder(outputDir, 'PowerPoint Duplicate Media Dedupe');
    assert.equal(fs.readFileSync(path.join(destFolder, 'Deck.pptx'), 'utf8'), 'pptx container bytes');
    assert.equal(fs.readFileSync(path.join(destFolder, 'Deck — image1.jpeg'), 'utf8'), mediaBytes.toString('utf8'));
    assert.equal(fs.existsSync(path.join(destFolder, 'Deck — image1_1.jpeg')), false);
    assert.equal(fs.existsSync(path.join(destFolder, 'Deck — image1_2.jpeg')), false);

    const fresh = await getProject(project.id);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 2);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE).length, 0);
    assertTextExcludes(JSON.stringify(fresh), [
      'PPT_DUPLICATE_SCAN_MEDIA_BYTES_SHOULD_NOT_LEAK',
    ], 'PowerPoint duplicate media project state');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('PowerPoint package extraction surfaces per-entry media failures without blocking successes', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('PowerPoint Partial Failure');
    const pptxPath = path.join(tmpRoot, 'Presentation1.pptx');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(pptxPath, Buffer.from('pptx container bytes'));
    setPowerPointUnzipFixture([
      {
        internalPath: 'ppt/media/image1.jpeg',
        data: Buffer.from('JPEG_BINARY_SHOULD_NOT_LEAK'.repeat(40)),
      },
      {
        internalPath: 'ppt/media/image2.png',
        data: Buffer.from('PNG_BINARY_SHOULD_NOT_LEAK'.repeat(40)),
        error: new Error(`unzip RAW_STDERR /private/tmp/crate-secret ${tmpRoot}`),
      },
    ]);
    await setProjectFiles(project.id, {
      files: [{
        path: pptxPath,
        name: 'Presentation1.pptx',
        ext: '.pptx',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    await callIpc('settings:update', 'includeDiagnosticReport', true);

    const result = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.embeddedCount, 1);
    assert.equal(result.totalFiles, 1);
    assert.deepEqual(result.errors, [
      'Could not extract embedded media image2.png from Presentation1.pptx.'
    ]);

    const errorText = JSON.stringify(result.errors);
    assert.equal(errorText.includes('RAW_STDERR'), false);
    assert.equal(errorText.includes('unzip'), false);
    assert.equal(errorText.includes('/private/tmp'), false);
    assert.equal(errorText.includes(tmpRoot), false);

    const destFolder = packageFolder(outputDir, 'PowerPoint Partial Failure');
    assert.equal(fs.readFileSync(path.join(destFolder, 'Presentation1.pptx'), 'utf8'), 'pptx container bytes');
    assert.equal(
      fs.readFileSync(path.join(destFolder, 'Presentation1 — image1.jpeg'), 'utf8'),
      'JPEG_BINARY_SHOULD_NOT_LEAK'.repeat(40)
    );
    assert.equal(fs.existsSync(path.join(destFolder, 'Presentation1 — image2.png')), false);

    const fresh = await getProject(project.id);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 1);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE).length, 1);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 1);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE).length, 1);

    const embeddedResources = getProvenanceNodes(fresh, NODE_TYPES.EMBEDDED_RESOURCE)
      .filter(node => node.sourceMetadata && String(node.sourceMetadata.internalPath || '').startsWith('ppt/media/'));
    assert.deepEqual(
      embeddedResources.map(node => node.sourceMetadata.internalPath),
      ['ppt/media/image1.jpeg']
    );
    const manifest = readManifest(outputDir, 'PowerPoint Partial Failure');
    assert.equal(manifest.package.embeddedCount, 1);
    assert.deepEqual(manifest.package.errors, [
      'Could not extract embedded media image2.png from Presentation1.pptx.'
    ]);
    assert.equal(JSON.stringify(manifest).includes('ppt/media/image2.png'), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('PowerPoint package extraction surfaces archive inspection failures without blocking deck copy', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('PowerPoint Inspection Failure');
    const pptxPath = path.join(tmpRoot, 'Presentation1.pptx');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(pptxPath, Buffer.from('not a zip archive'));
    setPresentationUnzipListingFailure(new Error(`unzip RAW_STDERR RAW_STDOUT /private/tmp/crate-secret ${tmpRoot}`));
    await setProjectFiles(project.id, {
      files: [{
        path: pptxPath,
        name: 'Presentation1.pptx',
        ext: '.pptx',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    await callIpc('settings:update', 'includeDiagnosticReport', true);

    const result = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.embeddedCount, 0);
    assert.equal(result.totalFiles, 1);
    assert.deepEqual(result.errors, [
      'Could not inspect embedded media in Presentation1.pptx.'
    ]);

    const errorText = JSON.stringify(result.errors);
    assert.equal(errorText.includes('RAW_STDERR'), false);
    assert.equal(errorText.includes('RAW_STDOUT'), false);
    assert.equal(errorText.includes('unzip'), false);
    assert.equal(errorText.includes('/private/tmp'), false);
    assert.equal(errorText.includes(tmpRoot), false);

    const destFolder = packageFolder(outputDir, 'PowerPoint Inspection Failure');
    assert.equal(fs.readFileSync(path.join(destFolder, 'Presentation1.pptx'), 'utf8'), 'not a zip archive');
    assert.equal(fs.existsSync(path.join(destFolder, 'Presentation1 — image1.jpeg')), false);

    const fresh = await getProject(project.id);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 1);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE).length, 0);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 0);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE).length, 0);

    const manifest = readManifest(outputDir, 'PowerPoint Inspection Failure');
    assert.equal(manifest.package.copiedCount, 1);
    assert.equal(manifest.package.embeddedCount, 0);
    assert.equal(manifest.package.totalFiles, 1);
    assert.deepEqual(manifest.package.errors, [
      'Could not inspect embedded media in Presentation1.pptx.'
    ]);
    const manifestErrorText = JSON.stringify(manifest.package.errors);
    assert.equal(manifestErrorText.includes('RAW_STDERR'), false);
    assert.equal(manifestErrorText.includes('RAW_STDOUT'), false);
    assert.equal(manifestErrorText.includes('/private/tmp'), false);
    assert.equal(manifestErrorText.includes(tmpRoot), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('PowerPoint provenance stays internal when diagnostic report is disabled', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('PowerPoint Diagnostics Off');
    const pptxPath = path.join(tmpRoot, 'Deck.pptx');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(pptxPath, Buffer.from('pptx container bytes'));
    setPowerPointUnzipFixture([{
      internalPath: 'ppt/media/image1.jpeg',
      data: Buffer.from('JPEG_BINARY_SHOULD_NOT_LEAK'.repeat(40)),
    }]);
    await setProjectFiles(project.id, {
      files: [{
        path: pptxPath,
        name: 'Deck.pptx',
        ext: '.pptx',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });

    const result = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.embeddedCount, 1);
    assert.equal(result.totalFiles, 1);
    assert.deepEqual(result.errors, []);
    assert.equal(fs.existsSync(rootManifestPath(outputDir, 'PowerPoint Diagnostics Off')), false);
    assert.equal(fs.existsSync(manifestPath(outputDir, 'PowerPoint Diagnostics Off')), false);

    const fresh = await getProject(project.id);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 1);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE).length, 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('PowerPoint provenance failure does not block package extraction success', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('PowerPoint Provenance Failure');
    const pptxPath = path.join(tmpRoot, 'Deck.pptx');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(pptxPath, Buffer.from('pptx container bytes'));
    setPowerPointUnzipFixture([{
      internalPath: 'ppt/media/image1.jpeg',
      data: Buffer.from('JPEG_BINARY_SHOULD_NOT_LEAK'.repeat(40)),
    }]);
    const projects = await callIpc('projects:get-all');
    const stored = projects.find(item => item.id === project.id);
    stored.files = [{
      path: pptxPath,
      name: 'Deck.pptx',
      ext: '.pptx',
      addedAt: Date.now(),
      source: 'manual-browse',
    }];
    stored.provenance = {
      schemaVersion: 1,
      sessionId: null,
      nodes: new Proxy({}, {
        set() {
          throw new Error('forced PowerPoint provenance failure');
        },
      }),
      edges: {},
      observations: [],
      evidence: {},
    };

    const result = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.embeddedCount, 1);
    assert.equal(result.totalFiles, 1);
    assert.deepEqual(result.errors, []);
    assert.equal(fs.readFileSync(path.join(packageFolder(outputDir, 'PowerPoint Provenance Failure'), 'Deck — image1.jpeg'), 'utf8'), 'JPEG_BINARY_SHOULD_NOT_LEAK'.repeat(40));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Keynote scan-on-save extraction records Data media provenance without ledger metadata leak', async () => {
  const tmpRoot = makeTempDir();
  try {
    resetPresentationCacheRoot();
    const project = await createProject('Keynote Scan Save Provenance');
    const keynotePath = path.join(tmpRoot, 'Deck.key');
    const mediaBytes = 'KEYNOTE_JPEG_BINARY_SHOULD_NOT_LEAK token=SHOULD_NOT_LEAK https://signed.example.test/keynote?sig=1 RAW_SCRIPT_OUTPUT '.repeat(10);
    const forbiddenValues = [
      'KEYNOTE_JPEG_BINARY_SHOULD_NOT_LEAK',
      'token=SHOULD_NOT_LEAK',
      'https://signed.example.test/keynote?sig=1',
      'RAW_SCRIPT_OUTPUT',
    ];
    makePermissivePresentationCacheDirectories(project.id);
    fs.writeFileSync(keynotePath, Buffer.from('keynote container bytes'));
    await setProjectFiles(project.id, {
      files: [{
        path: keynotePath,
        name: 'Deck.key',
        ext: '.key',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    setKeynoteUnzipFixture([{
      internalPath: 'Data/photo-1234.jpeg',
      data: Buffer.from(mediaBytes),
    }]);

    const captured = await captureConsoleDuring(async () => {
      await emitWatcher('change', keynotePath);
      return waitForProject(
        project.id,
        item => item.files.some(file => file.source === 'scan-on-save-presentation'),
        5000
      );
    });
    let fresh = captured.result;
    const extracted = fresh.files.find(file => file.source === 'scan-on-save-presentation');
    assert.ok(extracted);
    assert.deepEqual(Object.keys(extracted).sort(), ['addedAt', 'ext', 'name', 'path', 'source']);
    assert.equal(extracted.name, 'Deck — photo.jpeg');
    assert.equal(fs.readFileSync(extracted.path, 'utf8'), mediaBytes);
    assertPresentationCacheDirectoryModes(project.id);
    assertOwnerOnlyMode(extracted.path, 0o600);
    assertTextExcludes(JSON.stringify(fresh), forbiddenValues, 'Keynote project state');
    assertTextExcludes(captured.output, forbiddenValues, 'Keynote scan-on-save logs');
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 1);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE).length, 1);

    const embeddedResources = getProvenanceNodes(fresh, NODE_TYPES.EMBEDDED_RESOURCE)
      .filter(node => node.sourceMetadata && String(node.sourceMetadata.internalPath || '').startsWith('Data/'));
    assert.deepEqual(
      embeddedResources.map(node => node.sourceMetadata.internalPath),
      ['Data/photo-1234.jpeg']
    );
    assert.equal(embeddedResources[0].resourceKey.startsWith('keynote-media:'), true);
    const embedsEdge = getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE)[0];
    assert.equal(embedsEdge.confidence.band, CONFIDENCE_BANDS.CONFIRMED);
    assert.equal(embedsEdge.payload.observer.parser, 'keynote-zip-media');
    assert.equal(embedsEdge.payload.internalPath, 'Data/photo-1234.jpeg');
    const materializedEdge = getProvenanceEdges(fresh, EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE)[0];
    assert.equal(materializedEdge.confidence.band, CONFIDENCE_BANDS.CONFIRMED);
    assert.equal(materializedEdge.payload.observer.parser, 'keynote-zip-media');
    assert.equal(materializedEdge.payload.internalPath, 'Data/photo-1234.jpeg');

    await emitWatcher('change', keynotePath);
    await new Promise(resolve => originalSetTimeout(resolve, 2600));
    fresh = await getProject(project.id);
    assert.equal(fresh.files.filter(file => file.source === 'scan-on-save-presentation').length, 1);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Keynote scan-on-save captures distinct pasted images with same cleaned base after prior captures', async () => {
  const tmpRoot = makeTempDir();
  try {
    resetPresentationCacheRoot();
    const project = await createProject('Keynote Pasted Image Save Refresh');
    const keynotePath = path.join(tmpRoot, 'Deck.key');
    const paths = presentationCachePaths(project.id);
    fs.mkdirSync(paths.projectDir, { recursive: true, mode: 0o700 });

    const mediaBytes = (label) => Buffer.from(`${label}_KEYNOTE_MEDIA_BYTES_SHOULD_NOT_LEAK`.repeat(40));
    const existingOne = path.join(paths.projectDir, 'Deck — pasted-image.jpeg');
    const existingTwo = path.join(paths.projectDir, 'Deck — pasted-image_1.jpeg');
    fs.writeFileSync(keynotePath, Buffer.from('keynote container bytes'));
    fs.writeFileSync(existingOne, mediaBytes('EXISTING_ONE'));
    fs.writeFileSync(existingTwo, mediaBytes('EXISTING_TWO'));

    await setProjectFiles(project.id, {
      files: [
        {
          path: keynotePath,
          name: 'Deck.key',
          ext: '.key',
          addedAt: Date.now(),
          source: 'manual-browse',
        },
        {
          path: existingOne,
          name: 'Deck — pasted-image.jpeg',
          ext: '.jpeg',
          addedAt: Date.now(),
          source: 'scan-on-save-presentation',
        },
        {
          path: existingTwo,
          name: 'Deck — pasted-image_1.jpeg',
          ext: '.jpeg',
          addedAt: Date.now(),
          source: 'scan-on-save-presentation',
        },
      ],
    });
    setKeynoteUnzipFixture([
      { internalPath: 'Data/pasted-image-1001.jpeg', data: mediaBytes('EXISTING_ONE') },
      { internalPath: 'Data/pasted-image-1002.jpeg', data: mediaBytes('EXISTING_TWO') },
      { internalPath: 'Data/pasted-image-1003.jpeg', data: mediaBytes('NEW_ONE') },
      { internalPath: 'Data/pasted-image-1004.jpeg', data: mediaBytes('NEW_TWO') },
      { internalPath: 'Data/pasted-image-1005.jpeg', data: mediaBytes('NEW_THREE') },
    ]);

    const captured = await captureConsoleDuring(async () => {
      await emitWatcher('change', keynotePath);
      return waitForProject(
        project.id,
        item => item.files.filter(file => file.source === 'scan-on-save-presentation').length === 5,
        5000
      );
    });

    const fresh = captured.result;
    const extractedNames = fresh.files
      .filter(file => file.source === 'scan-on-save-presentation')
      .map(file => file.name)
      .sort();
    assert.deepEqual(extractedNames, [
      'Deck — pasted-image.jpeg',
      'Deck — pasted-image_1.jpeg',
      'Deck — pasted-image_2.jpeg',
      'Deck — pasted-image_3.jpeg',
      'Deck — pasted-image_4.jpeg',
    ]);
    assert.equal(
      fs.readFileSync(fresh.files.find(file => file.name === 'Deck — pasted-image_2.jpeg').path, 'utf8'),
      mediaBytes('NEW_ONE').toString('utf8')
    );
    assert.equal(
      fs.readFileSync(fresh.files.find(file => file.name === 'Deck — pasted-image_3.jpeg').path, 'utf8'),
      mediaBytes('NEW_TWO').toString('utf8')
    );
    assert.equal(
      fs.readFileSync(fresh.files.find(file => file.name === 'Deck — pasted-image_4.jpeg').path, 'utf8'),
      mediaBytes('NEW_THREE').toString('utf8')
    );
    assertTextExcludes(captured.output, [
      'EXISTING_ONE_KEYNOTE_MEDIA_BYTES_SHOULD_NOT_LEAK',
      'NEW_ONE_KEYNOTE_MEDIA_BYTES_SHOULD_NOT_LEAK',
    ], 'Keynote pasted image scan-on-save logs');
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 3);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE).length, 3);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Keynote package extraction records deterministic Data media provenance and diagnostics graph', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Keynote Media Provenance');
    const keynotePath = path.join(tmpRoot, 'Deck.key');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(keynotePath, Buffer.from('keynote container bytes'));
    setKeynoteUnzipFixture([
      {
        internalPath: 'Data/photo-1234.jpeg',
        data: Buffer.from('KEYNOTE_JPEG_BINARY_SHOULD_NOT_LEAK'.repeat(40)),
      },
      {
        internalPath: 'Data/clip-5678.mov',
        data: Buffer.from('KEYNOTE_MOV_BINARY_SHOULD_NOT_LEAK'.repeat(40)),
      },
    ]);
    await setProjectFiles(project.id, {
      files: [{
        path: keynotePath,
        name: 'Deck.key',
        ext: '.key',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    await callIpc('settings:update', 'includeDiagnosticReport', true);

    const result = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.embeddedCount, 2);
    assert.equal(result.totalFiles, 1);
    assert.deepEqual(result.errors, []);

    const destFolder = packageFolder(outputDir, 'Keynote Media Provenance');
    assert.equal(fs.readFileSync(path.join(destFolder, 'Deck.key'), 'utf8'), 'keynote container bytes');
    assert.equal(fs.readFileSync(path.join(destFolder, 'Deck — photo.jpeg'), 'utf8'), 'KEYNOTE_JPEG_BINARY_SHOULD_NOT_LEAK'.repeat(40));
    assert.equal(fs.readFileSync(path.join(destFolder, 'Deck — clip.mov'), 'utf8'), 'KEYNOTE_MOV_BINARY_SHOULD_NOT_LEAK'.repeat(40));

    let fresh = await getProject(project.id);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 1);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE).length, 2);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 2);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE).length, 2);

    const embeddedResources = getProvenanceNodes(fresh, NODE_TYPES.EMBEDDED_RESOURCE)
      .filter(node => node.sourceMetadata && String(node.sourceMetadata.internalPath || '').startsWith('Data/'));
    assert.deepEqual(
      embeddedResources.map(node => node.sourceMetadata.internalPath).sort(),
      ['Data/clip-5678.mov', 'Data/photo-1234.jpeg']
    );
    assert.equal(
      embeddedResources.every(node => String(node.resourceKey || '').startsWith('keynote-media:')),
      true
    );
    assert.equal(
      getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE)
        .every(edge => edge.confidence.band === CONFIDENCE_BANDS.CONFIRMED),
      true
    );
    assert.equal(
      getProvenanceEdges(fresh, EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE)
        .every(edge => edge.confidence.band === CONFIDENCE_BANDS.CONFIRMED),
      true
    );
    assert.equal(
      getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE)
        .every(edge => edge.payload.observer.parser === 'keynote-zip-media'),
      true
    );

    const manifest = readManifest(outputDir, 'Keynote Media Provenance');
    assert.equal(fs.existsSync(rootManifestPath(outputDir, 'Keynote Media Provenance')), false);
    assert.equal(manifest.schemaVersion, PROVENANCE_SCHEMA_VERSION);
    assert.equal(manifest.package.copiedCount, 1);
    assert.equal(manifest.package.embeddedCount, 2);
    assert.equal(manifest.package.totalFiles, 1);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 1);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE).length, 2);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 2);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE).length, 2);
    const manifestText = JSON.stringify(manifest);
    assert.equal(manifestText.includes('Data/photo-1234.jpeg'), true);
    assert.equal(manifestText.includes('Deck — photo.jpeg'), true);
    assert.equal(manifestText.includes('KEYNOTE_JPEG_BINARY_SHOULD_NOT_LEAK'), false);
    assert.equal(manifestText.includes('KEYNOTE_MOV_BINARY_SHOULD_NOT_LEAK'), false);

    const duplicateResult = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(duplicateResult);
    assert.equal(duplicateResult.copiedCount, 1);
    assert.equal(duplicateResult.embeddedCount, 2);
    assert.equal(duplicateResult.totalFiles, 1);
    fresh = await getProject(project.id);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 2);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Keynote package extraction recovers new pasted images when prior scan media shares the cleaned base', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Keynote Pasted Image Package Refresh');
    const keynotePath = path.join(tmpRoot, 'Deck.key');
    const existingOne = path.join(tmpRoot, 'Deck — pasted-image.jpeg');
    const existingTwo = path.join(tmpRoot, 'Deck — pasted-image_1.jpeg');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);

    const mediaBytes = (label) => Buffer.from(`${label}_KEYNOTE_PACKAGE_BYTES_SHOULD_NOT_LEAK`.repeat(40));
    fs.writeFileSync(keynotePath, Buffer.from('keynote container bytes'));
    fs.writeFileSync(existingOne, mediaBytes('EXISTING_ONE'));
    fs.writeFileSync(existingTwo, mediaBytes('EXISTING_TWO'));
    setKeynoteUnzipFixture([
      { internalPath: 'Data/pasted-image-1001.jpeg', data: mediaBytes('EXISTING_ONE') },
      { internalPath: 'Data/pasted-image-1002.jpeg', data: mediaBytes('EXISTING_TWO') },
      { internalPath: 'Data/pasted-image-1003.jpeg', data: mediaBytes('NEW_ONE') },
      { internalPath: 'Data/pasted-image-1004.jpeg', data: mediaBytes('NEW_TWO') },
      { internalPath: 'Data/pasted-image-1005.jpeg', data: mediaBytes('NEW_THREE') },
    ]);
    await setProjectFiles(project.id, {
      files: [
        {
          path: keynotePath,
          name: 'Deck.key',
          ext: '.key',
          addedAt: Date.now(),
          source: 'manual-browse',
        },
        {
          path: existingOne,
          name: 'Deck — pasted-image.jpeg',
          ext: '.jpeg',
          addedAt: Date.now(),
          source: 'scan-on-save-presentation',
        },
        {
          path: existingTwo,
          name: 'Deck — pasted-image_1.jpeg',
          ext: '.jpeg',
          addedAt: Date.now(),
          source: 'scan-on-save-presentation',
        },
      ],
    });

    const captured = await captureConsoleDuring(async () => callIpc('projects:package', project.id, outputDir));
    const result = captured.result;
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 3);
    assert.equal(result.embeddedCount, 3);
    assert.equal(result.totalFiles, 3);
    assert.deepEqual(result.errors, []);

    const destFolder = packageFolder(outputDir, 'Keynote Pasted Image Package Refresh');
    const packageEntries = fs.readdirSync(destFolder).sort();
    assert.deepEqual(packageEntries, [
      'Deck — pasted-image.jpeg',
      'Deck — pasted-image_1.jpeg',
      'Deck — pasted-image_2.jpeg',
      'Deck — pasted-image_3.jpeg',
      'Deck — pasted-image_4.jpeg',
      'Deck.key',
    ]);
    assert.equal(fs.readFileSync(path.join(destFolder, 'Deck — pasted-image.jpeg'), 'utf8'), mediaBytes('EXISTING_ONE').toString('utf8'));
    assert.equal(fs.readFileSync(path.join(destFolder, 'Deck — pasted-image_1.jpeg'), 'utf8'), mediaBytes('EXISTING_TWO').toString('utf8'));
    assert.equal(fs.readFileSync(path.join(destFolder, 'Deck — pasted-image_2.jpeg'), 'utf8'), mediaBytes('NEW_ONE').toString('utf8'));
    assert.equal(fs.readFileSync(path.join(destFolder, 'Deck — pasted-image_3.jpeg'), 'utf8'), mediaBytes('NEW_TWO').toString('utf8'));
    assert.equal(fs.readFileSync(path.join(destFolder, 'Deck — pasted-image_4.jpeg'), 'utf8'), mediaBytes('NEW_THREE').toString('utf8'));
    assertTextExcludes(captured.output, [
      'EXISTING_ONE_KEYNOTE_PACKAGE_BYTES_SHOULD_NOT_LEAK',
      'NEW_ONE_KEYNOTE_PACKAGE_BYTES_SHOULD_NOT_LEAK',
    ], 'Keynote pasted image package logs');

    const fresh = await getProject(project.id);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 3);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE).length, 3);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 3);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE).length, 3);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Keynote package extraction falls back to a unique safe tail for mojibake-listed Data media', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Keynote Mojibake Media');
    const keynotePath = path.join(tmpRoot, 'Keynote Deck.key');
    const outputDir = path.join(tmpRoot, 'out');
    const listedPath = 'Data/Presentation1-QA3-QuickPackage-Smoke \uFFFD\uFFFD\uFFFD image2-9089.png';
    fs.mkdirSync(outputDir);
    fs.writeFileSync(keynotePath, Buffer.from('keynote container bytes'));
    setKeynoteUnzipFixture([{
      internalPath: 'Data/Presentation1-QA3-QuickPackage-Smoke raw-bytes image2-9089.png',
      listedPath,
      data: Buffer.from('KEYNOTE_MOJIBAKE_BINARY_SHOULD_NOT_LEAK'.repeat(40)),
    }]);
    await setProjectFiles(project.id, {
      files: [{
        path: keynotePath,
        name: 'Keynote Deck.key',
        ext: '.key',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    await callIpc('settings:update', 'includeDiagnosticReport', true);

    const result = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.embeddedCount, 1);
    assert.equal(result.totalFiles, 1);
    assert.deepEqual(result.errors, []);

    const destFolder = packageFolder(outputDir, 'Keynote Mojibake Media');
    assert.equal(fs.readFileSync(path.join(destFolder, 'Keynote Deck.key'), 'utf8'), 'keynote container bytes');
    assert.equal(
      fs.readFileSync(path.join(destFolder, 'Keynote Deck — image2.png'), 'utf8'),
      'KEYNOTE_MOJIBAKE_BINARY_SHOULD_NOT_LEAK'.repeat(40)
    );

    const fresh = await getProject(project.id);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 1);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE).length, 1);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 1);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE).length, 1);

    const embeddedResources = getProvenanceNodes(fresh, NODE_TYPES.EMBEDDED_RESOURCE)
      .filter(node => node.sourceMetadata && String(node.sourceMetadata.internalPath || '').startsWith('Data/'));
    assert.deepEqual(
      embeddedResources.map(node => node.sourceMetadata.internalPath),
      [listedPath]
    );
    assert.equal(String(embeddedResources[0].resourceKey || '').startsWith('keynote-media:'), true);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE)[0].payload.internalPath, listedPath);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE)[0].payload.internalPath, listedPath);

    const manifest = readManifest(outputDir, 'Keynote Mojibake Media');
    assert.equal(manifest.package.embeddedCount, 1);
    assert.deepEqual(manifest.package.errors, []);
    const manifestText = JSON.stringify(manifest);
    assert.equal(manifestText.includes('Keynote Deck — image2.png'), true);
    assert.equal(manifestText.includes('KEYNOTE_MOJIBAKE_BINARY_SHOULD_NOT_LEAK'), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Keynote package extraction recovers mixed mojibake tails without collapsing output names', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Keynote Mixed Mojibake Media');
    const keynotePath = path.join(tmpRoot, 'Keynote Deck.key');
    const outputDir = path.join(tmpRoot, 'out');
    const exactPath = 'Data/Screenshot 2026-03-10 at 9.07-9090.png';
    const mixedListedPath = 'Data/Screenshot 2026-03-10 at 9.07.43\uFFFD\u01FBPM-9089.png';
    fs.mkdirSync(outputDir);
    fs.writeFileSync(keynotePath, Buffer.from('keynote container bytes'));
    setKeynoteUnzipFixture([
      {
        internalPath: exactPath,
        data: Buffer.from('KEYNOTE_EXACT_SCREENSHOT_BINARY_SHOULD_NOT_LEAK'.repeat(40)),
      },
      {
        internalPath: 'Data/Screenshot 2026-03-10 at 9.07.43 raw-bytes PM-9089.png',
        listedPath: mixedListedPath,
        data: Buffer.from('KEYNOTE_MIXED_MOJIBAKE_BINARY_SHOULD_NOT_LEAK'.repeat(40)),
      },
    ]);
    await setProjectFiles(project.id, {
      files: [{
        path: keynotePath,
        name: 'Keynote Deck.key',
        ext: '.key',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    await callIpc('settings:update', 'includeDiagnosticReport', true);

    const result = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.embeddedCount, 2);
    assert.equal(result.totalFiles, 1);
    assert.deepEqual(result.errors, []);

    const destFolder = packageFolder(outputDir, 'Keynote Mixed Mojibake Media');
    const packageEntries = fs.readdirSync(destFolder).sort();
    assert.equal(packageEntries.includes('Keynote Deck.key'), true);
    assert.equal(packageEntries.includes('Keynote Deck — Screenshot 2026-03-10 at 9.07.png'), true);
    assert.equal(packageEntries.includes('Keynote Deck — Screenshot 2026-03-10 at 9.07.43 PM.png'), true);
    assert.equal(packageEntries.includes('Keynote Deck — PM.png'), false);
    assert.equal(packageEntries.some(name => name.includes('\uFFFD') || name.includes('\u01FB')), false);
    assert.equal(
      fs.readFileSync(path.join(destFolder, 'Keynote Deck — Screenshot 2026-03-10 at 9.07.png'), 'utf8'),
      'KEYNOTE_EXACT_SCREENSHOT_BINARY_SHOULD_NOT_LEAK'.repeat(40)
    );
    assert.equal(
      fs.readFileSync(path.join(destFolder, 'Keynote Deck — Screenshot 2026-03-10 at 9.07.43 PM.png'), 'utf8'),
      'KEYNOTE_MIXED_MOJIBAKE_BINARY_SHOULD_NOT_LEAK'.repeat(40)
    );

    const fresh = await getProject(project.id);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 1);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE).length, 2);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 2);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE).length, 2);
    const embeddedResources = getProvenanceNodes(fresh, NODE_TYPES.EMBEDDED_RESOURCE)
      .filter(node => node.sourceMetadata && String(node.sourceMetadata.internalPath || '').startsWith('Data/'))
      .map(node => node.sourceMetadata.internalPath)
      .sort();
    assert.deepEqual(embeddedResources, [exactPath, mixedListedPath].sort());

    const manifest = readManifest(outputDir, 'Keynote Mixed Mojibake Media');
    assert.equal(manifest.package.embeddedCount, 2);
    assert.deepEqual(manifest.package.errors, []);
    const manifestText = JSON.stringify(manifest);
    assert.equal(manifestText.includes('Keynote Deck — Screenshot 2026-03-10 at 9.07.43 PM.png'), true);
    assert.equal(manifestText.includes('KEYNOTE_EXACT_SCREENSHOT_BINARY_SHOULD_NOT_LEAK'), false);
    assert.equal(manifestText.includes('KEYNOTE_MIXED_MOJIBAKE_BINARY_SHOULD_NOT_LEAK'), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Keynote package extraction fails closed for ambiguous mojibake wildcard tails', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Keynote Ambiguous Mojibake');
    const keynotePath = path.join(tmpRoot, 'Keynote Deck.key');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(keynotePath, Buffer.from('keynote container bytes'));
    setKeynoteUnzipFixture([
      {
        internalPath: 'Data/raw-entry-a PM-9089.png',
        listedPath: 'Data/Slide A \uFFFD\u01FBPM-9089.png',
        data: Buffer.from('KEYNOTE_AMBIGUOUS_A_BINARY_SHOULD_NOT_LEAK'.repeat(40)),
      },
      {
        internalPath: 'Data/raw-entry-b PM-9089.png',
        listedPath: 'Data/Slide B \uFFFD\u01FBPM-9089.png',
        data: Buffer.from('KEYNOTE_AMBIGUOUS_B_BINARY_SHOULD_NOT_LEAK'.repeat(40)),
      },
    ]);
    await setProjectFiles(project.id, {
      files: [{
        path: keynotePath,
        name: 'Keynote Deck.key',
        ext: '.key',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    await callIpc('settings:update', 'includeDiagnosticReport', true);

    const result = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.embeddedCount, 0);
    assert.equal(result.totalFiles, 1);
    assert.deepEqual(result.errors, [
      'Could not extract embedded media PM-9089.png from Keynote Deck.key.',
      'Could not extract embedded media PM-9089.png from Keynote Deck.key.',
    ]);

    const destFolder = packageFolder(outputDir, 'Keynote Ambiguous Mojibake');
    assert.equal(fs.readFileSync(path.join(destFolder, 'Keynote Deck.key'), 'utf8'), 'keynote container bytes');
    assert.equal(fs.existsSync(path.join(destFolder, 'Keynote Deck — PM.png')), false);

    const errorText = JSON.stringify(result.errors);
    assert.equal(errorText.includes('KEYNOTE_AMBIGUOUS_A_BINARY_SHOULD_NOT_LEAK'), false);
    assert.equal(errorText.includes('KEYNOTE_AMBIGUOUS_B_BINARY_SHOULD_NOT_LEAK'), false);
    assert.equal(errorText.includes('unzip'), false);
    assert.equal(errorText.includes('/private/tmp'), false);
    assert.equal(errorText.includes(tmpRoot), false);

    const fresh = await getProject(project.id);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 1);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE).length, 0);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 0);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE).length, 0);

    const manifest = readManifest(outputDir, 'Keynote Ambiguous Mojibake');
    assert.equal(manifest.package.embeddedCount, 0);
    assert.deepEqual(manifest.package.errors, result.errors);
    const manifestText = JSON.stringify(manifest);
    assert.equal(manifestText.includes('KEYNOTE_AMBIGUOUS_A_BINARY_SHOULD_NOT_LEAK'), false);
    assert.equal(manifestText.includes('KEYNOTE_AMBIGUOUS_B_BINARY_SHOULD_NOT_LEAK'), false);
    assert.equal(manifestText.includes('/private/tmp'), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Keynote package extraction surfaces per-entry media failures without blocking successes', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Keynote Partial Failure');
    const keynotePath = path.join(tmpRoot, 'Presentation1.key');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(keynotePath, Buffer.from('keynote container bytes'));
    setKeynoteUnzipFixture([
      {
        internalPath: 'Data/photo-1234.jpeg',
        data: Buffer.from('KEYNOTE_JPEG_BINARY_SHOULD_NOT_LEAK'.repeat(40)),
      },
      {
        internalPath: 'Data/clip-5678.mov',
        data: Buffer.from('KEYNOTE_MOV_BINARY_SHOULD_NOT_LEAK'.repeat(40)),
        error: new Error(`unzip RAW_STDERR /private/tmp/crate-secret ${tmpRoot}`),
      },
    ]);
    await setProjectFiles(project.id, {
      files: [{
        path: keynotePath,
        name: 'Presentation1.key',
        ext: '.key',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    await callIpc('settings:update', 'includeDiagnosticReport', true);

    const result = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.embeddedCount, 1);
    assert.equal(result.totalFiles, 1);
    assert.deepEqual(result.errors, [
      'Could not extract embedded media clip-5678.mov from Presentation1.key.'
    ]);

    const errorText = JSON.stringify(result.errors);
    assert.equal(errorText.includes('RAW_STDERR'), false);
    assert.equal(errorText.includes('unzip'), false);
    assert.equal(errorText.includes('/private/tmp'), false);
    assert.equal(errorText.includes(tmpRoot), false);

    const destFolder = packageFolder(outputDir, 'Keynote Partial Failure');
    assert.equal(fs.readFileSync(path.join(destFolder, 'Presentation1.key'), 'utf8'), 'keynote container bytes');
    assert.equal(
      fs.readFileSync(path.join(destFolder, 'Presentation1 — photo.jpeg'), 'utf8'),
      'KEYNOTE_JPEG_BINARY_SHOULD_NOT_LEAK'.repeat(40)
    );
    assert.equal(fs.existsSync(path.join(destFolder, 'Presentation1 — clip.mov')), false);

    const fresh = await getProject(project.id);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 1);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE).length, 1);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 1);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE).length, 1);

    const embeddedResources = getProvenanceNodes(fresh, NODE_TYPES.EMBEDDED_RESOURCE)
      .filter(node => node.sourceMetadata && String(node.sourceMetadata.internalPath || '').startsWith('Data/'));
    assert.deepEqual(
      embeddedResources.map(node => node.sourceMetadata.internalPath),
      ['Data/photo-1234.jpeg']
    );
    const manifest = readManifest(outputDir, 'Keynote Partial Failure');
    assert.equal(manifest.package.embeddedCount, 1);
    assert.deepEqual(manifest.package.errors, [
      'Could not extract embedded media clip-5678.mov from Presentation1.key.'
    ]);
    assert.equal(JSON.stringify(manifest).includes('Data/clip-5678.mov'), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Keynote package extraction surfaces archive inspection failures without blocking deck copy', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Keynote Inspection Failure');
    const keynotePath = path.join(tmpRoot, 'Presentation1.key');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(keynotePath, Buffer.from('not a zip archive'));
    setPresentationUnzipListingFailure(new Error(`unzip RAW_STDERR RAW_STDOUT /private/tmp/crate-secret ${tmpRoot}`));
    await setProjectFiles(project.id, {
      files: [{
        path: keynotePath,
        name: 'Presentation1.key',
        ext: '.key',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    await callIpc('settings:update', 'includeDiagnosticReport', true);

    const result = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.embeddedCount, 0);
    assert.equal(result.totalFiles, 1);
    assert.deepEqual(result.errors, [
      'Could not inspect embedded media in Presentation1.key.'
    ]);

    const errorText = JSON.stringify(result.errors);
    assert.equal(errorText.includes('RAW_STDERR'), false);
    assert.equal(errorText.includes('RAW_STDOUT'), false);
    assert.equal(errorText.includes('unzip'), false);
    assert.equal(errorText.includes('/private/tmp'), false);
    assert.equal(errorText.includes(tmpRoot), false);

    const destFolder = packageFolder(outputDir, 'Keynote Inspection Failure');
    assert.equal(fs.readFileSync(path.join(destFolder, 'Presentation1.key'), 'utf8'), 'not a zip archive');
    assert.equal(fs.existsSync(path.join(destFolder, 'Presentation1 — photo.jpeg')), false);

    const fresh = await getProject(project.id);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 1);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE).length, 0);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 0);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE).length, 0);

    const manifest = readManifest(outputDir, 'Keynote Inspection Failure');
    assert.equal(manifest.package.copiedCount, 1);
    assert.equal(manifest.package.embeddedCount, 0);
    assert.equal(manifest.package.totalFiles, 1);
    assert.deepEqual(manifest.package.errors, [
      'Could not inspect embedded media in Presentation1.key.'
    ]);
    const manifestErrorText = JSON.stringify(manifest.package.errors);
    assert.equal(manifestErrorText.includes('RAW_STDERR'), false);
    assert.equal(manifestErrorText.includes('RAW_STDOUT'), false);
    assert.equal(manifestErrorText.includes('/private/tmp'), false);
    assert.equal(manifestErrorText.includes(tmpRoot), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Keynote provenance stays internal when diagnostic report is disabled', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Keynote Diagnostics Off');
    const keynotePath = path.join(tmpRoot, 'Deck.key');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(keynotePath, Buffer.from('keynote container bytes'));
    setKeynoteUnzipFixture([{
      internalPath: 'Data/photo-1234.jpeg',
      data: Buffer.from('KEYNOTE_JPEG_BINARY_SHOULD_NOT_LEAK'.repeat(40)),
    }]);
    await setProjectFiles(project.id, {
      files: [{
        path: keynotePath,
        name: 'Deck.key',
        ext: '.key',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });

    const result = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.embeddedCount, 1);
    assert.equal(result.totalFiles, 1);
    assert.deepEqual(result.errors, []);
    assert.equal(fs.existsSync(rootManifestPath(outputDir, 'Keynote Diagnostics Off')), false);
    assert.equal(fs.existsSync(manifestPath(outputDir, 'Keynote Diagnostics Off')), false);

    const fresh = await getProject(project.id);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 1);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE).length, 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Keynote provenance failure does not block package extraction success', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Keynote Provenance Failure');
    const keynotePath = path.join(tmpRoot, 'Deck.key');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(keynotePath, Buffer.from('keynote container bytes'));
    setKeynoteUnzipFixture([{
      internalPath: 'Data/photo-1234.jpeg',
      data: Buffer.from('KEYNOTE_JPEG_BINARY_SHOULD_NOT_LEAK'.repeat(40)),
    }]);
    const projects = await callIpc('projects:get-all');
    const stored = projects.find(item => item.id === project.id);
    stored.files = [{
      path: keynotePath,
      name: 'Deck.key',
      ext: '.key',
      addedAt: Date.now(),
      source: 'manual-browse',
    }];
    stored.provenance = {
      schemaVersion: 1,
      sessionId: null,
      nodes: new Proxy({}, {
        set() {
          throw new Error('forced Keynote provenance failure');
        },
      }),
      edges: {},
      observations: [],
      evidence: {},
    };

    const result = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.embeddedCount, 1);
    assert.equal(result.totalFiles, 1);
    assert.deepEqual(result.errors, []);
    assert.equal(fs.readFileSync(path.join(packageFolder(outputDir, 'Keynote Provenance Failure'), 'Deck — photo.jpeg'), 'utf8'), 'KEYNOTE_JPEG_BINARY_SHOULD_NOT_LEAK'.repeat(40));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('manual add preserves file ledger entry and records one session observation', async () => {
  const project = await createProject('Manual provenance');
  const filePath = path.join(os.tmpdir(), 'brand-logo.ai');

  manualDialogFor([filePath]);
  const files = await callIpc('projects:add-files', project.id);

  assert.equal(files.length, 1);
  assert.deepEqual(Object.keys(files[0]).sort(), ['addedAt', 'ext', 'name', 'path', 'source']);
  assert.equal(files[0].path, filePath);
  assert.equal(files[0].name, 'brand-logo.ai');
  assert.equal(files[0].ext, '.ai');
  assert.equal(files[0].source, 'manual-browse');

  const fresh = await getProject(project.id);
  assertSessionObservedFile(
    fresh,
    OBSERVER_KINDS.MANUAL_USER_ACTION,
    'projects:add-files',
    CONFIDENCE_BANDS.CONFIRMED
  );
});

test('duplicate manual add does not duplicate session observations', async () => {
  const project = await createProject('Duplicate manual provenance');
  const filePath = path.join(os.tmpdir(), 'duplicate-logo.ai');

  manualDialogFor([filePath]);
  await callIpc('projects:add-files', project.id);
  manualDialogFor([filePath]);
  await callIpc('projects:add-files', project.id);

  const fresh = await getProject(project.id);
  assert.equal(fresh.files.length, 1);
  assert.equal(fresh.provenance.observations.length, 1);
});

test('accept pending preserves file ledger entry and records one confirmed session observation', async () => {
  const project = await createProject('Accept pending provenance');
  const filePath = path.join(os.tmpdir(), 'accepted-pending.ai');
  const pendingFile = makePendingFile(filePath);
  await setProjectFiles(project.id, { pendingFiles: [pendingFile] });

  const result = await callIpc('projects:accept-pending', project.id, filePath);

  assert.equal(result.files.length, 1);
  assert.deepEqual(result.files[0], { ...pendingFile, acceptedPending: true });
  assert.deepEqual(result.pendingFiles, []);

  const fresh = await getProject(project.id);
  assert.deepEqual(fresh.files, [{ ...pendingFile, acceptedPending: true }]);
  assert.deepEqual(fresh.pendingFiles, []);
  assertSessionObservedFile(
    fresh,
    OBSERVER_KINDS.MANUAL_USER_ACTION,
    'projects:accept-pending',
    CONFIDENCE_BANDS.CONFIRMED
  );
});

test('accept pending source triggers persisted scan-on-open linked asset discovery', async () => {
  resetTestHomeWorkspace();
  const repoTempRoot = path.join(path.resolve(__dirname, '..'), 'test-accept-pending-scan');
  if (!path.resolve(repoTempRoot).startsWith('/Users/')) return;

  try {
    fs.rmSync(repoTempRoot, { recursive: true, force: true });
    fs.mkdirSync(repoTempRoot, { recursive: true });
    const sourcePath = path.join(repoTempRoot, 'accepted-source.ai');
    const linkedPath = path.join(repoTempRoot, 'accepted-linked.png');
    fs.writeFileSync(linkedPath, 'linked bytes');
    fs.writeFileSync(sourcePath, `ai persisted link ${linkedPath}`);

    const project = await createProject('Accept pending scan provenance');
    await setProjectFiles(project.id, {
      pendingFiles: [
        makePendingFile(sourcePath, 'lsof'),
        {
          ...makePendingFile(linkedPath, 'ai-linked'),
          captureState: 'needs-save',
          captureReason: 'linked-asset-observed',
          captureEvidence: {
            appFamily: 'illustrator',
            observerMethod: 'illustrator-active-session',
            evidenceStrength: 'structured-app-link',
            captureRecommendation: 'needs-save',
            designerReason: 'Linked asset observed in Illustrator. Save to make package-ready.',
          },
        },
      ],
    });

    const result = await callIpc('projects:accept-pending', project.id, sourcePath);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].path, sourcePath);
    assert.equal(result.files[0].acceptedPending, true);
    assert.equal(Object.prototype.hasOwnProperty.call(result.files[0], 'captureState'), false);

    const fresh = await waitForProject(
      project.id,
      item => item.files.some(file => file.path === linkedPath && file.source === 'scan-on-open'),
      5000
    );
    assert.equal(fresh.pendingFiles.length, 0);
    assert.equal(fresh.files.some(file => file.path === sourcePath), true);
    const linkedFile = fresh.files.find(file => file.path === linkedPath);
    assert.equal(linkedFile.source, 'scan-on-open');
    assert.equal(Object.prototype.hasOwnProperty.call(linkedFile, 'captureState'), false);
    const linkedLedgerEntries = Object.values((fresh.liveEvidenceLedger && fresh.liveEvidenceLedger.candidates) || {})
      .filter(entry => entry.latest && entry.latest.candidateName === 'accepted-linked.png');
    assert.ok(linkedLedgerEntries.some(entry => entry.strongestState === 'package-ready'));
    const acceptObservations = getSessionObservedByMethod(fresh, 'projects:accept-pending');
    assert.equal(acceptObservations.length, 1);
    assert.equal(acceptObservations[0].observer.kind, OBSERVER_KINDS.MANUAL_USER_ACTION);
    assert.equal(acceptObservations[0].confidence.band, CONFIDENCE_BANDS.CONFIRMED);
    assert.equal(getSessionObservedByMethod(fresh, 'scan-on-open').length, 1);
  } finally {
    fs.rmSync(repoTempRoot, { recursive: true, force: true });
  }
});

test('duplicate or already-present pending accept does not duplicate observations', async () => {
  const project = await createProject('Duplicate pending accept provenance');
  const filePath = path.join(os.tmpdir(), 'duplicate-pending.ai');
  const pendingFile = makePendingFile(filePath);
  await setProjectFiles(project.id, { pendingFiles: [pendingFile] });

  await callIpc('projects:accept-pending', project.id, filePath);
  const duplicateResult = await callIpc('projects:accept-pending', project.id, filePath);

  assert.equal(duplicateResult, null);
  let fresh = await getProject(project.id);
  assert.equal(fresh.files.length, 1);
  assert.equal(fresh.provenance.observations.length, 1);

  const alreadyPresentProject = await createProject('Already-present pending accept provenance');
  const alreadyPresentPath = path.join(os.tmpdir(), 'already-present-pending.ai');
  const alreadyPresentFile = makePendingFile(alreadyPresentPath, 'manual-browse');
  await setProjectFiles(alreadyPresentProject.id, {
    files: [alreadyPresentFile],
    pendingFiles: [alreadyPresentFile],
  });

  const result = await callIpc('projects:accept-pending', alreadyPresentProject.id, alreadyPresentPath);

  assert.equal(result.files.length, 1);
  assert.deepEqual(result.pendingFiles, []);
  fresh = await getProject(alreadyPresentProject.id);
  assert.equal(fresh.files.length, 1);
  assert.deepEqual(fresh.pendingFiles, []);
  assert.deepEqual(fresh.provenance.observations, []);
});

test('reject pending removes pending file and records evidence-only rejection', async () => {
  const project = await createProject('Reject pending provenance');
  const filePath = path.join(os.tmpdir(), 'rejected-pending.ai');
  const pendingFile = makePendingFile(filePath);
  await setProjectFiles(project.id, { pendingFiles: [pendingFile] });

  const pendingFiles = await callIpc('projects:reject-pending', project.id, filePath);

  assert.deepEqual(pendingFiles, []);
  const fresh = await getProject(project.id);
  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.pendingFiles, []);
  assertPendingRejectedObservation(fresh);
});

test('duplicate or missing pending reject does not create observations', async () => {
  const project = await createProject('Duplicate pending reject provenance');
  const filePath = path.join(os.tmpdir(), 'duplicate-reject.ai');
  const pendingFile = makePendingFile(filePath);
  await setProjectFiles(project.id, { pendingFiles: [pendingFile] });

  await callIpc('projects:reject-pending', project.id, filePath);
  await callIpc('projects:reject-pending', project.id, filePath);

  let fresh = await getProject(project.id);
  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.pendingFiles, []);
  assert.equal(fresh.provenance.observations.length, 1);

  const missingProject = await createProject('Missing pending reject provenance');
  const missingResult = await callIpc(
    'projects:reject-pending',
    missingProject.id,
    path.join(os.tmpdir(), 'missing-pending.ai')
  );

  assert.deepEqual(missingResult, []);
  fresh = await getProject(missingProject.id);
  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.pendingFiles, []);
  assert.deepEqual(fresh.provenance.observations, []);
});

test('provenance recording failure does not block pending accept or reject', async () => {
  const acceptProject = await createProject('Pending accept provenance failure');
  const acceptPath = path.join(os.tmpdir(), 'accept-failure.ai');
  const acceptFile = makePendingFile(acceptPath);
  const storedAcceptProject = await setProjectFiles(acceptProject.id, { pendingFiles: [acceptFile] });
  storedAcceptProject.provenance.observations = [];
  storedAcceptProject.provenance.observations.find = () => {
    throw new Error('forced pending accept provenance failure');
  };

  const acceptResult = await callIpc('projects:accept-pending', acceptProject.id, acceptPath);

  assert.equal(acceptResult.files.length, 1);
  assert.deepEqual(acceptResult.pendingFiles, []);
  let fresh = await getProject(acceptProject.id);
  assert.equal(fresh.files.length, 1);
  assert.deepEqual(fresh.pendingFiles, []);

  const rejectProject = await createProject('Pending reject provenance failure');
  const rejectPath = path.join(os.tmpdir(), 'reject-failure.ai');
  const rejectFile = makePendingFile(rejectPath);
  const storedRejectProject = await setProjectFiles(rejectProject.id, { pendingFiles: [rejectFile] });
  storedRejectProject.provenance.observations = [];
  storedRejectProject.provenance.observations.find = () => {
    throw new Error('forced pending reject provenance failure');
  };

  const rejectResult = await callIpc('projects:reject-pending', rejectProject.id, rejectPath);

  assert.deepEqual(rejectResult, []);
  fresh = await getProject(rejectProject.id);
  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.pendingFiles, []);
});

test('provenance recording failure does not block manual file capture', async () => {
  const project = await createProject('Provenance failure manual add');
  const projects = await callIpc('projects:get-all');
  const storedProject = projects.find(item => item.id === project.id);
  storedProject.provenance.observations = [];
  storedProject.provenance.observations.find = () => {
    throw new Error('forced provenance failure');
  };

  const filePath = path.join(os.tmpdir(), 'failure-still-captures.ai');
  manualDialogFor([filePath]);
  const files = await callIpc('projects:add-files', project.id);

  assert.equal(files.length, 1);
  assert.equal(files[0].path, filePath);
  const fresh = await getProject(project.id);
  assert.equal(fresh.files.length, 1);
});

test('chokidar add records session observation only after primary design file add succeeds', async () => {
  const project = await createProject('Chokidar add provenance');
  const filePath = path.join(os.tmpdir(), 'layout.psd');

  await emitWatcher('add', filePath);
  await emitWatcher('add', filePath);

  const fresh = await getProject(project.id);
  assert.equal(fresh.files.length, 1);
  assert.equal(fresh.files[0].path, filePath);
  assert.equal(fresh.files[0].ext, '.psd');
  assertSessionObservedFile(
    fresh,
    OBSERVER_KINDS.CHOKIDAR,
    'add',
    CONFIDENCE_BANDS.CANDIDATE
  );
});

test('chokidar change records observation only for a previously unseen primary design file', async () => {
  const project = await createProject('Chokidar change provenance');
  const filePath = path.join(os.tmpdir(), 'identity.ai');

  await emitWatcher('change', filePath);
  await emitWatcher('change', filePath);

  const fresh = await getProject(project.id);
  assert.equal(fresh.files.length, 1);
  assert.equal(fresh.files[0].path, filePath);
  assert.equal(fresh.files[0].ext, '.ai');
  assertSessionObservedFile(
    fresh,
    OBSERVER_KINDS.CHOKIDAR,
    'change',
    CONFIDENCE_BANDS.CANDIDATE
  );
});

test('chokidar ignored, non-primary, and temp files do not record provenance', async () => {
  const project = await createProject('Ignored chokidar provenance');

  await emitWatcher('add', path.join(os.tmpdir(), 'preview.jpg'));
  await emitWatcher('add', path.join(os.tmpdir(), 'draft.tmp'));
  await emitWatcher('add', path.join(os.tmpdir(), '~$layout.psd'));
  await emitWatcher('change', path.join(os.tmpdir(), 'preview.png'));

  const fresh = await getProject(project.id);
  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.provenance.observations, []);
});

test('automatic live capture ignores old package output and diagnostics folders', async () => {
  const project = await createProject('Package output exclusion');
  const packageRootFile = path.join(
    TEST_HOME,
    'Desktop',
    'Crate-QA',
    'v2.8.0-qa.5-jenna',
    'package-outputs',
    'Jenna Baseline Existing Files QA_2026-06-07',
    'Pricing Tobias Joseph copy.indd'
  );
  const diagnosticsFile = path.join(
    TEST_HOME,
    'Desktop',
    'Jenna Baseline Existing Files QA_2026-06-07',
    'Crate Diagnostics',
    'diagnostics-source.ai'
  );
  const quickPackageFile = path.join(
    TEST_HOME,
    'Desktop',
    'Presentation1_2026-06-07',
    'Presentation1.ai'
  );

  for (const filePath of [packageRootFile, diagnosticsFile, quickPackageFile]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'excluded auto capture bytes');
    await emitWatcher('add', filePath);
    await emitWatcher('change', filePath);
  }

  const fresh = await getProject(project.id);
  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.pendingFiles, []);
  assert.deepEqual(fresh.provenance.observations, []);
  const ignoredEvidence = Object.values((fresh.liveEvidenceLedger && fresh.liveEvidenceLedger.candidates) || {})
    .filter(entry => entry.latest && entry.latest.captureRecommendation === 'ignored');
  assert.ok(ignoredEvidence.length >= 3);
  assert.ok(ignoredEvidence.every(entry => entry.latest.reason === 'crate-output-path'));
  assert.ok(ignoredEvidence.every(entry => !Object.prototype.hasOwnProperty.call(entry.latest, 'candidateName')));
  assert.ok(ignoredEvidence.every(entry => !Object.prototype.hasOwnProperty.call(entry.latest, 'sourceDocumentName')));
  assertTextExcludes(JSON.stringify(fresh.liveEvidenceLedger), [
    packageRootFile,
    diagnosticsFile,
    quickPackageFile,
    TEST_HOME,
    'raw',
    'stdout',
  ], 'ignored live evidence ledger');
});

test('live evidence ledger caps candidates and preserves active project evidence', async () => {
  setChildProcessHandler(() => ({ stdout: '' }));
  const project = await createProject('Ledger cap provenance');
  const acceptedPath = path.join(TEST_HOME, 'Desktop', 'ledger-accepted.ai');
  const pendingPath = path.join(TEST_HOME, 'Desktop', 'ledger-pending.ai');
  const triggerPath = path.join(TEST_HOME, 'Desktop', 'ledger-trigger.ai');
  const needsSavePath = path.join(TEST_HOME, 'Desktop', 'ledger-needs-save.ai');
  const packageReadyPath = path.join(TEST_HOME, 'Desktop', 'ledger-package-ready.ai');
  for (const filePath of [acceptedPath, pendingPath, triggerPath, needsSavePath, packageReadyPath]) {
    fs.writeFileSync(filePath, 'ledger bytes');
  }

  const candidates = {};
  const addCandidate = ([key, entry]) => {
    candidates[key] = entry;
    return key;
  };
  const baseMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const acceptedKey = addCandidate(makeLiveEvidenceLedgerEntry(acceptedPath, 'package-ready', baseMs, {
    latest: {
      source: 'scan-on-open',
      observerMethod: 'scan-on-open',
      evidenceStrength: 'parser-confirmed',
      savedEvidence: true,
      parserConfirmed: true,
    },
  }));
  const pendingKey = addCandidate(makeLiveEvidenceLedgerEntry(pendingPath, 'pending', baseMs + 1, {
    latest: {
      source: 'lsof',
      observerMethod: 'lsof',
      evidenceStrength: 'broad-app-signal',
    },
  }));
  const needsSaveKey = addCandidate(makeLiveEvidenceLedgerEntry(needsSavePath, 'needs-save', baseMs + 2, {
    latest: {
      source: 'ai-linked',
      observerMethod: 'illustrator-active-session',
      evidenceStrength: 'structured-app-link',
      needsSave: true,
    },
  }));
  const packageReadyKey = addCandidate(makeLiveEvidenceLedgerEntry(packageReadyPath, 'package-ready', baseMs + 3, {
    latest: {
      source: 'scan-on-open',
      observerMethod: 'scan-on-open',
      evidenceStrength: 'parser-confirmed',
      savedEvidence: true,
      parserConfirmed: true,
    },
  }));
  const ignoredKeys = [];
  for (let i = 0; i < EXPECTED_LIVE_EVIDENCE_CANDIDATE_CAP + 20; i++) {
    const ignoredPath = path.join(
      TEST_HOME,
      'Desktop',
      'package-outputs',
      `legacy-package-output-${String(i).padStart(3, '0')}.ai`
    );
    ignoredKeys.push(addCandidate(makeLiveEvidenceLedgerEntry(ignoredPath, 'ignored', baseMs + 10 + i, {
      latest: {
        source: 'lsof',
        observerMethod: 'lsof',
        evidenceStrength: 'broad-app-signal',
        sourceDocumentName: 'legacy-source.ai',
        sourceName: 'legacy-source.ai',
      },
    })));
  }

  await setProjectFiles(project.id, {
    files: [makePendingFile(acceptedPath, 'manual-browse')],
    pendingFiles: [
      makePendingFile(pendingPath, 'lsof'),
      makePendingFile(triggerPath, 'lsof'),
    ],
    liveEvidenceLedger: {
      schemaVersion: 1,
      candidates,
    },
  });

  const result = await callIpc('projects:reject-pending', project.id, triggerPath);
  assert.ok(result);
  const fresh = await getProject(project.id);
  const retainedCandidates = (fresh.liveEvidenceLedger && fresh.liveEvidenceLedger.candidates) || {};
  assert.equal(Object.keys(retainedCandidates).length, EXPECTED_LIVE_EVIDENCE_CANDIDATE_CAP);
  assert.equal(fresh.liveEvidenceLedger.candidateLimit, EXPECTED_LIVE_EVIDENCE_CANDIDATE_CAP);
  assert.ok(fresh.liveEvidenceLedger.prunedAt);
  assert.ok(retainedCandidates[acceptedKey], 'accepted project file ledger evidence should be preserved');
  assert.ok(retainedCandidates[pendingKey], 'pending project file ledger evidence should be preserved');
  assert.ok(retainedCandidates[needsSaveKey], 'needs-save ledger evidence should be preserved before ignored evidence');
  assert.ok(retainedCandidates[packageReadyKey], 'package-ready ledger evidence should be preserved before ignored evidence');
  assert.equal(Object.prototype.hasOwnProperty.call(retainedCandidates, ignoredKeys[0]), false);
  assert.equal(Object.prototype.hasOwnProperty.call(retainedCandidates, ignoredKeys[1]), false);

  const retainedIgnored = Object.values(retainedCandidates)
    .filter(entry => entry.latest && entry.latest.captureRecommendation === 'ignored');
  assert.ok(retainedIgnored.length < ignoredKeys.length);
  assert.ok(retainedIgnored.every(entry => !Object.prototype.hasOwnProperty.call(entry.latest, 'candidateName')));
  assert.ok(retainedIgnored.every(entry => !Object.prototype.hasOwnProperty.call(entry.latest, 'sourceDocumentName')));
  assert.ok(retainedIgnored.every(entry => !Object.prototype.hasOwnProperty.call(entry.latest, 'sourceName')));
  assertTextExcludes(JSON.stringify(fresh.liveEvidenceLedger), [
    acceptedPath,
    pendingPath,
    needsSavePath,
    packageReadyPath,
    TEST_HOME,
    'raw',
    'stdout',
    'stderr',
    'SHOULD_NOT_APPEAR_PROCESS_ARG',
    'tell application',
    'signed_url_token',
  ], 'pruned live evidence ledger');
});

test('live evidence ledger initializes safely when missing', async () => {
  setChildProcessHandler(() => ({ stdout: '' }));
  const project = await createProject('Missing ledger initialization');
  const storedProject = await getProject(project.id);
  delete storedProject.liveEvidenceLedger;
  const filePath = path.join(TEST_HOME, 'Desktop', 'missing-ledger.ai');
  fs.writeFileSync(filePath, 'missing ledger bytes');

  await emitWatcher('add', filePath);

  const fresh = await getProject(project.id);
  assert.ok(fresh.liveEvidenceLedger);
  assert.equal(fresh.liveEvidenceLedger.schemaVersion, 1);
  assert.equal(fresh.liveEvidenceLedger.candidateLimit, EXPECTED_LIVE_EVIDENCE_CANDIDATE_CAP);
  assert.ok(Object.keys(fresh.liveEvidenceLedger.candidates || {}).length >= 1);
  assert.ok(Object.keys(fresh.liveEvidenceLedger.candidates || {}).length <= EXPECTED_LIVE_EVIDENCE_CANDIDATE_CAP);
  assert.equal(fresh.files.some(file => file.path === filePath), true);
});

test('lsof package-output image observations are ignored, not accepted or pending', async () => {
  const currentSourcePath = path.join(TEST_HOME, 'Desktop', 'current-project.ai');
  const stalePackageImagePath = path.join(
    TEST_HOME,
    'Desktop',
    'Crate-QA',
    'package-outputs',
    'Jenna Baseline Existing Files QA_2026-06-07',
    'Presentation1 — image1_1.jpeg'
  );
  fs.mkdirSync(path.dirname(currentSourcePath), { recursive: true });
  fs.mkdirSync(path.dirname(stalePackageImagePath), { recursive: true });
  fs.writeFileSync(currentSourcePath, 'current source bytes');
  fs.writeFileSync(stalePackageImagePath, 'stale package image bytes');

  let pollReady = false;
  setChildProcessHandler(({ kind, command }) => {
    if (!pollReady) return { stdout: '' };
    if (kind === 'exec' && command.startsWith('/bin/ps ax')) {
      return { stdout: '222 /Applications/Adobe Illustrator.app/Contents/MacOS/Adobe Illustrator\n' };
    }
    if (kind === 'exec' && command.startsWith('/usr/sbin/lsof')) {
      return { stdout: `p222\nf20\ntREG\nn${stalePackageImagePath}\n` };
    }
    return { stdout: '' };
  });

  const project = await createProject('Lsof package output exclusion');
  await setProjectFiles(project.id, {
    files: [{
      path: currentSourcePath,
      name: 'current-project.ai',
      ext: '.ai',
      addedAt: Date.now(),
      source: 'manual-browse',
    }],
  });
  pollReady = true;
  await new Promise(resolve => originalSetTimeout(resolve, 800));

  const fresh = await getProject(project.id);
  assert.equal(fresh.files.some(file => file.path === stalePackageImagePath), false);
  assert.equal(fresh.pendingFiles.some(file => file.path === stalePackageImagePath), false);
  assert.equal(getProvenanceObservations(fresh, EDGE_TYPES.SESSION_OBSERVED_FILE).length, 0);
});

test('manual add remains allowed for excluded-looking package output paths', async () => {
  const project = await createProject('Manual package output add');
  const filePath = path.join(
    TEST_HOME,
    'Desktop',
    'Crate-QA',
    'package-outputs',
    'Manual Existing Files QA_2026-06-07',
    'explicit-source.ai'
  );
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'manual add bytes');

  manualDialogFor([filePath]);
  const files = await callIpc('projects:add-files', project.id);

  assert.equal(files.length, 1);
  assert.equal(files[0].path, filePath);
  assert.equal(files[0].source, 'manual-browse');
  const fresh = await getProject(project.id);
  assert.deepEqual(fresh.pendingFiles, []);
  assertSessionObservedFile(
    fresh,
    OBSERVER_KINDS.MANUAL_USER_ACTION,
    'projects:add-files',
    CONFIDENCE_BANDS.CONFIRMED
  );
});

test('initial lsof snapshot quarantines stale open files outside session scope', async () => {
  const filePath = path.join(TEST_HOME, 'Desktop', 'initial-logo.ai');
  setChildProcessHandler(({ kind, command }) => {
    if (kind === 'execFile' && command === '/bin/ps') {
      return {
        stdout: '123 /Applications/Adobe Photoshop.app/Contents/MacOS/Adobe Photoshop --token SHOULD_NOT_APPEAR_PROCESS_ARG\n',
      };
    }
    if (kind === 'execFile' && command === '/usr/sbin/lsof') {
      return { stdout: `p123\nf10\ntREG\nn${filePath}\n` };
    }
    return { stdout: '' };
  });

  const project = await createProject('Initial lsof provenance');
  const fresh = await getProject(project.id);

  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.pendingFiles, []);
  const ignoredEvidence = Object.values((fresh.liveEvidenceLedger && fresh.liveEvidenceLedger.candidates) || {})
    .filter(entry => entry.latest && entry.latest.reason === 'broad-observer-outside-session');
  assert.ok(ignoredEvidence.length >= 1);
  assert.ok(ignoredEvidence.every(entry => entry.latest.quarantined === true));
  assert.ok(ignoredEvidence.every(entry => !Object.prototype.hasOwnProperty.call(entry.latest, 'candidateName')));

  const appNodes = getProvenanceNodes(fresh, NODE_TYPES.APP);
  const processNodes = getProvenanceNodes(fresh, NODE_TYPES.APP_PROCESS);
  const sessionObservations = getProvenanceObservations(fresh, EDGE_TYPES.SESSION_OBSERVED_FILE);
  const appOpenedObservations = getProvenanceObservations(fresh, EDGE_TYPES.APP_OPENED_FILE);

  assert.equal(appNodes.length, 0);
  assert.equal(processNodes.length, 0);
  assert.equal(sessionObservations.length, 0);
  assert.equal(appOpenedObservations.length, 0);

  const provenanceText = JSON.stringify(fresh.provenance);
  assert.equal(provenanceText.includes('SHOULD_NOT_APPEAR_PROCESS_ARG'), false);
  assert.equal(provenanceText.includes('/Applications/Adobe Photoshop.app'), false);
  assert.equal(provenanceText.includes('raw'), false);
  assert.equal(provenanceText.includes('stdout'), false);
});

test('ongoing lsof poll quarantines broad observations outside session scope', async () => {
  const filePath = path.join(TEST_HOME, 'Desktop', 'poll-logo.ai');
  let pollReady = false;
  setChildProcessHandler(({ kind, command }) => {
    if (!pollReady) return { stdout: '' };
    if (kind === 'exec' && command.startsWith('/bin/ps ax')) {
      return {
        stdout: '456 /Applications/Figma.app/Contents/MacOS/Figma --secret SHOULD_NOT_APPEAR_PROCESS_ARG\n',
      };
    }
    if (kind === 'exec' && command.startsWith('/usr/sbin/lsof')) {
      return { stdout: `p456\nf11\ntREG\nn${filePath}\n` };
    }
    return { stdout: '' };
  });

  const project = await createProject('Poll lsof provenance');
  pollReady = true;

  const fresh = await waitForProject(
    project.id,
    item => Object.values((item.liveEvidenceLedger && item.liveEvidenceLedger.candidates) || {})
      .some(entry => entry.latest && entry.latest.reason === 'broad-observer-outside-session'),
    5000
  );
  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.pendingFiles, []);
  const ignoredEvidence = Object.values((fresh.liveEvidenceLedger && fresh.liveEvidenceLedger.candidates) || {})
    .filter(entry => entry.latest && entry.latest.reason === 'broad-observer-outside-session');
  assert.ok(ignoredEvidence.length >= 1);
  assert.ok(ignoredEvidence.every(entry => entry.latest.captureRecommendation === 'ignored'));
  assert.ok(ignoredEvidence.every(entry => !Object.prototype.hasOwnProperty.call(entry.latest, 'candidateName')));

  const appNodes = getProvenanceNodes(fresh, NODE_TYPES.APP);
  const processNodes = getProvenanceNodes(fresh, NODE_TYPES.APP_PROCESS);
  const appOpenedObservations = getProvenanceObservations(fresh, EDGE_TYPES.APP_OPENED_FILE);

  assert.equal(appNodes.length, 0);
  assert.equal(processNodes.length, 0);
  assert.equal(appOpenedObservations.length, 0);
  assert.equal(JSON.stringify(fresh.provenance).includes('SHOULD_NOT_APPEAR_PROCESS_ARG'), false);
});

test('PowerPoint lsof open-after-watch evidence stays quarantined until confirmed', async () => {
  const filePath = path.join(TEST_HOME, 'Desktop', 'open-after-watch.pptx');
  fs.writeFileSync(filePath, 'pptx bytes');
  let pollReady = false;
  setChildProcessHandler(({ kind, command }) => {
    if (!pollReady) return { stdout: '' };
    if (kind === 'exec' && command.startsWith('/bin/ps ax')) {
      return { stdout: '789 /Applications/Microsoft PowerPoint.app/Contents/MacOS/Microsoft PowerPoint --token SHOULD_NOT_APPEAR_PROCESS_ARG\n' };
    }
    if (kind === 'exec' && command.startsWith('/usr/sbin/lsof')) {
      return { stdout: `p789\nf12\ntREG\nn${filePath}\n` };
    }
    return { stdout: '' };
  });

  const project = await callIpc('projects:create', 'Presentation open provenance', 'presentation', 'current-page', null);
  pollReady = true;

  const fresh = await waitForProject(
    project.id,
    item => Object.values((item.liveEvidenceLedger && item.liveEvidenceLedger.candidates) || {})
      .some(entry => entry.latest && entry.latest.reason === 'broad-observer-outside-session'),
    5000
  );
  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.pendingFiles, []);
  assert.equal(Object.values((fresh.liveEvidenceLedger && fresh.liveEvidenceLedger.candidates) || {})
    .some(entry => entry.latest && entry.latest.captureRecommendation === 'ignored'), true);
  assert.equal(getProvenanceObservations(fresh, EDGE_TYPES.APP_OPENED_FILE).length, 0);
  assertProvenanceTextExcludes(fresh, [
    'SHOULD_NOT_APPEAR_PROCESS_ARG',
    '/Applications/Microsoft PowerPoint.app',
    'stdout',
  ]);
});

test('repeated lsof observations for the same pending file are deduped', async () => {
  const filePath = path.join(TEST_HOME, 'Desktop', 'dedupe-logo.ai');
  setChildProcessHandler(({ kind, command }) => {
    if (kind === 'execFile' && command === '/bin/ps') {
      return { stdout: '789 /Applications/Adobe Illustrator.app/Contents/MacOS/Adobe Illustrator --ignored SHOULD_NOT_APPEAR_PROCESS_ARG\n' };
    }
    if (kind === 'execFile' && command === '/usr/sbin/lsof') {
      return { stdout: `p789\nf12\ntREG\nn${filePath}\n` };
    }
    if (kind === 'exec' && command.startsWith('/bin/ps ax')) {
      return { stdout: '789 /Applications/Adobe Illustrator.app/Contents/MacOS/Adobe Illustrator --ignored SHOULD_NOT_APPEAR_PROCESS_ARG\n' };
    }
    if (kind === 'exec' && command.startsWith('/usr/sbin/lsof')) {
      return { stdout: `p789\nf12\ntREG\nn${filePath}\n` };
    }
    return { stdout: '' };
  });

  const project = await createProject('Dedupe lsof provenance');
  await new Promise(resolve => originalSetTimeout(resolve, 800));
  const fresh = await getProject(project.id);

  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.pendingFiles, []);
  assert.equal(Object.values((fresh.liveEvidenceLedger && fresh.liveEvidenceLedger.candidates) || {})
    .some(entry => entry.latest && entry.latest.reason === 'broad-observer-outside-session'), true);
  assert.equal(getProvenanceObservations(fresh, EDGE_TYPES.SESSION_OBSERVED_FILE).length, 0);
  assert.equal(getProvenanceObservations(fresh, EDGE_TYPES.APP_OPENED_FILE).length, 0);
  assert.equal(getProvenanceNodes(fresh, NODE_TYPES.APP_PROCESS).length, 0);
});

test('rejected lsof candidates do not record provenance', async () => {
  const filePath = path.join(TEST_HOME, 'Desktop', 'Screenshot 2026-05-20.png');
  setChildProcessHandler(({ kind, command }) => {
    if (kind === 'execFile' && command === '/bin/ps') {
      return { stdout: '321 /Applications/Adobe Photoshop.app/Contents/MacOS/Adobe Photoshop\n' };
    }
    if (kind === 'execFile' && command === '/usr/sbin/lsof') {
      return { stdout: `p321\nf13\ntREG\nn${filePath}\n` };
    }
    return { stdout: '' };
  });

  const project = await createProject('Rejected lsof provenance');
  const fresh = await getProject(project.id);

  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.provenance.observations, []);
  assert.equal(getProvenanceNodes(fresh, NODE_TYPES.APP).length, 0);
  assert.equal(getProvenanceNodes(fresh, NODE_TYPES.APP_PROCESS).length, 0);
});

test('lsof provenance failure does not block broad observer quarantine', async () => {
  const filePath = path.join(TEST_HOME, 'Desktop', 'failure-logo.ai');
  let pollReady = false;
  setChildProcessHandler(({ kind, command }) => {
    if (!pollReady) return { stdout: '' };
    if (kind === 'exec' && command.startsWith('/bin/ps ax')) {
      return { stdout: '654 /Applications/Sketch.app/Contents/MacOS/Sketch\n' };
    }
    if (kind === 'exec' && command.startsWith('/usr/sbin/lsof')) {
      return { stdout: `p654\nf14\ntREG\nn${filePath}\n` };
    }
    return { stdout: '' };
  });

  const project = await createProject('Lsof provenance failure');
  const storedProject = await getProject(project.id);
  storedProject.provenance.nodes = new Proxy({}, {
    set() {
      throw new Error('forced lsof provenance failure');
    },
  });
  pollReady = true;

  const fresh = await waitForProject(
    project.id,
    item => Object.values((item.liveEvidenceLedger && item.liveEvidenceLedger.candidates) || {})
      .some(entry => entry.latest && entry.latest.reason === 'broad-observer-outside-session'),
    5000
  );
  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.pendingFiles, []);
});

test('ps-poll broad discovery stages pending candidate without captured-file provenance', async () => {
  const filePath = path.join(TEST_HOME, 'Desktop', 'ps-poll-logo.ai');
  const unrelatedPath = path.join(TEST_HOME, 'Desktop', 'UNRELATED_FILE_LIST.ai');
  const originalWriteFile = fs.promises.writeFile;
  const privateScriptDirs = new Set();
  const scriptWrites = [];
  const osascriptInvocations = [];
  const sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-script-sentinel-'));
  fs.writeFileSync(filePath, 'ps linked bytes');

  fs.promises.writeFile = async function trackedWriteFile(target, data, options) {
    if (typeof target === 'string' && path.basename(path.dirname(target)).startsWith('crate-script-')) {
      privateScriptDirs.add(path.dirname(target));
      scriptWrites.push({ target, options });
    }
    return originalWriteFile.call(fs.promises, target, data, options);
  };

  try {
    setChildProcessHandler(({ kind, command, args, commandText }) => {
      if (kind === 'exec' && command.includes("grep -i 'Adobe Photoshop'")) {
        return {
          stdout: '123 /Applications/Adobe Photoshop.app/Contents/MacOS/Adobe Photoshop --token SHOULD_NOT_APPEAR_PROCESS_ARG\n',
        };
      }
      if (isOsascriptInvocation({ kind, command, args }, 'crate-ps-poll.applescript')) {
        osascriptInvocations.push({ command, args, commandText });
        privateScriptDirs.add(path.dirname(args[0]));
        assertPrivateTempScriptPath(args[0]);
        assertPrivateTempScriptPath(path.join(path.dirname(args[0]), 'crate-ps-poll.js'));
        assert.equal(commandText.includes('tell application'), false);
        assert.equal(commandText.includes('LayerKind.SMARTOBJECT'), false);
        return { stdout: `${filePath}\n${unrelatedPath}\n` };
      }
      return { stdout: '' };
    });

    const project = await createProject('PS poll provenance');
    const fresh = await waitForProject(project.id, item => item.pendingFiles.length === 1);
    assert.deepEqual(fresh.files, []);
    assert.equal(fresh.pendingFiles[0].path, filePath);
    assert.equal(fresh.pendingFiles[0].source, 'ps-poll');
    assert.equal(fresh.pendingFiles[0].captureState, 'needs-save');
    assert.equal(fresh.pendingFiles[0].captureReason, 'linked-asset-observed');
    assert.equal(fresh.pendingFiles[0].captureEvidence.appFamily, 'photoshop');
    assert.equal(fresh.pendingFiles[0].captureEvidence.observerMethod, 'photoshop-live-script');
    assert.equal(fresh.pendingFiles[0].captureEvidence.evidenceStrength, 'structured-app-link');
    assert.equal(fresh.pendingFiles[0].captureEvidence.captureRecommendation, 'needs-save');
    assert.equal(fresh.pendingFiles[0].captureEvidence.designerReason, 'Linked asset observed in Photoshop. Save to make package-ready.');

    const observations = getSessionObservedByMethod(fresh, 'ps-poll');
    assert.equal(observations.length, 0);
    assert.deepEqual(fresh.provenance.edges, {});
    assert.equal(getProvenanceObservations(fresh, EDGE_TYPES.APP_OPENED_FILE).length, 0);

    const writtenNames = new Set(scriptWrites.map(write => path.basename(write.target)));
    assert.equal(writtenNames.has('crate-ps-poll.js'), true);
    assert.equal(writtenNames.has('crate-ps-poll.applescript'), true);
    for (const write of scriptWrites) {
      assert.equal(write.options.flag, 'wx');
      assert.equal(write.options.mode, 0o600);
    }
    assert.ok(osascriptInvocations.length >= 1);
    for (const dir of privateScriptDirs) {
      assert.equal(fs.existsSync(dir), false);
    }
    assert.equal(fs.existsSync(sentinelDir), true);

    const provenanceText = JSON.stringify(fresh.provenance);
    assert.equal(provenanceText.includes('SHOULD_NOT_APPEAR_PROCESS_ARG'), false);
    assert.equal(provenanceText.includes('/Applications/Adobe Photoshop.app'), false);
    assert.equal(provenanceText.includes(unrelatedPath), false);
    assert.equal(provenanceText.includes('raw'), false);
    assert.equal(provenanceText.includes('stdout'), false);
    assertTextExcludes(JSON.stringify(fresh.pendingFiles[0].captureEvidence), [
      'SHOULD_NOT_APPEAR_PROCESS_ARG',
      '/Applications/Adobe Photoshop.app',
      unrelatedPath,
      'tell application',
      'LayerKind.SMARTOBJECT',
      'stdout',
      'raw',
    ], 'Photoshop live capture evidence');
  } finally {
    fs.promises.writeFile = originalWriteFile;
    fs.rmSync(sentinelDir, { recursive: true, force: true });
  }
});

test('indd-poll broad discovery stages pending candidate without captured-file provenance', async () => {
  const filePath = path.join(TEST_HOME, 'Desktop', 'indd-poll-image.png');
  fs.writeFileSync(filePath, 'indd linked bytes');

  const osascriptDirs = new Set();
  setChildProcessHandler(({ kind, command, args }) => {
    if (kind === 'exec' && command.includes("grep -i 'Adobe InDesign'")) {
      return {
        stdout: '456 /Applications/Adobe InDesign 2026/Adobe InDesign.app/Contents/MacOS/Adobe InDesign --secret SHOULD_NOT_APPEAR_PROCESS_ARG\n',
      };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-indd-poll.applescript')) {
      osascriptDirs.add(path.dirname(args[0]));
      assertPrivateTempScriptPath(args[0]);
      return { stdout: `${filePath}\n` };
    }
    return { stdout: '' };
  });

  const project = await createProject('INDD poll provenance');
  const fresh = await waitForProject(project.id, item => item.pendingFiles.length === 1);
  assert.deepEqual(fresh.files, []);
  assert.equal(fresh.pendingFiles[0].path, filePath);
  assert.equal(fresh.pendingFiles[0].source, 'indd-poll');
  assert.equal(fresh.pendingFiles[0].captureState, 'needs-save');
  assert.equal(fresh.pendingFiles[0].captureReason, 'linked-asset-observed');
  assert.equal(fresh.pendingFiles[0].captureEvidence.appFamily, 'indesign');
  assert.equal(fresh.pendingFiles[0].captureEvidence.observerMethod, 'indesign-live-applescript');
  assert.equal(fresh.pendingFiles[0].captureEvidence.evidenceStrength, 'structured-app-link');
  assert.equal(fresh.pendingFiles[0].captureEvidence.captureRecommendation, 'needs-save');
  assert.equal(fresh.pendingFiles[0].captureEvidence.designerReason, 'Linked asset observed in InDesign. Save to make package-ready.');

  const observations = getSessionObservedByMethod(fresh, 'indd-poll');
  assert.equal(observations.length, 0);
  assert.deepEqual(fresh.provenance.edges, {});
  assert.equal(getProvenanceObservations(fresh, EDGE_TYPES.APP_OPENED_FILE).length, 0);
  assert.equal(JSON.stringify(fresh.provenance).includes('SHOULD_NOT_APPEAR_PROCESS_ARG'), false);
  assertTextExcludes(JSON.stringify(fresh.pendingFiles[0].captureEvidence), [
    'SHOULD_NOT_APPEAR_PROCESS_ARG',
    '/Applications/Adobe InDesign',
    'tell application',
    filePath,
    'stdout',
    'raw',
  ], 'InDesign live capture evidence');
  for (const dir of osascriptDirs) {
    assert.equal(fs.existsSync(dir), false);
  }
});

test('Photoshop and InDesign live evidence refresh newly linked assets conservatively', async () => {
  resetTestHomeWorkspace();
  const existingPsPath = path.join(TEST_HOME, 'Desktop', 'existing-ps-link.png');
  const newPsPath = path.join(TEST_HOME, 'Desktop', 'new-ps-linked-smart-object.jpg');
  const existingInddPath = path.join(TEST_HOME, 'Desktop', 'existing-indd-link.png');
  const newInddPath = path.join(TEST_HOME, 'Desktop', 'new-indd-link.jpg');
  for (const filePath of [existingPsPath, newPsPath, existingInddPath, newInddPath]) {
    fs.writeFileSync(filePath, `${path.basename(filePath)} bytes`);
  }

  let includeNewLinks = false;
  setChildProcessHandler(({ kind, command, args }) => {
    if (kind === 'exec' && command.includes("grep -i 'Adobe Photoshop'")) {
      return { stdout: '123 /Applications/Adobe Photoshop.app/Contents/MacOS/Adobe Photoshop --token SHOULD_NOT_APPEAR_PROCESS_ARG\n' };
    }
    if (kind === 'exec' && command.includes("grep -i 'Adobe InDesign'")) {
      return { stdout: '456 /Applications/Adobe InDesign.app/Contents/MacOS/Adobe InDesign --secret SHOULD_NOT_APPEAR_PROCESS_ARG\n' };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ps-poll.applescript')) {
      return { stdout: `${existingPsPath}\n${includeNewLinks ? `${newPsPath}\n` : ''}` };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-indd-poll.applescript')) {
      return { stdout: `${existingInddPath}\n${includeNewLinks ? `${newInddPath}\n` : ''}` };
    }
    return { stdout: '' };
  });

  const project = await createProject('Adobe suite live refresh');
  await setProjectFiles(project.id, {
    files: [
      {
        path: existingPsPath,
        name: path.basename(existingPsPath),
        ext: '.png',
        addedAt: Date.now(),
        source: 'manual-browse',
      },
      {
        path: existingInddPath,
        name: path.basename(existingInddPath),
        ext: '.png',
        addedAt: Date.now(),
        source: 'manual-browse',
      },
    ],
  });

  await new Promise(resolve => originalSetTimeout(resolve, 900));
  let fresh = await getProject(project.id);
  assert.deepEqual(fresh.pendingFiles, []);

  includeNewLinks = true;
  fresh = await waitForProject(
    project.id,
    item => item.pendingFiles.some(file => file.path === newPsPath) &&
      item.pendingFiles.some(file => file.path === newInddPath),
    7000
  );

  const psCandidate = fresh.pendingFiles.find(file => file.path === newPsPath);
  const inddCandidate = fresh.pendingFiles.find(file => file.path === newInddPath);
  assert.ok(psCandidate);
  assert.ok(inddCandidate);
  assert.equal(psCandidate.source, 'ps-poll');
  assert.equal(psCandidate.captureState, 'needs-save');
  assert.equal(psCandidate.captureEvidence.appFamily, 'photoshop');
  assert.equal(psCandidate.captureEvidence.captureRecommendation, 'needs-save');
  assert.equal(inddCandidate.source, 'indd-poll');
  assert.equal(inddCandidate.captureState, 'needs-save');
  assert.equal(inddCandidate.captureEvidence.appFamily, 'indesign');
  assert.equal(inddCandidate.captureEvidence.captureRecommendation, 'needs-save');
  assert.equal(fresh.files.some(file => file.path === newPsPath), false);
  assert.equal(fresh.files.some(file => file.path === newInddPath), false);
  assert.deepEqual(getSessionObservedByMethod(fresh, 'ps-poll'), []);
  assert.deepEqual(getSessionObservedByMethod(fresh, 'indd-poll'), []);
  assertTextExcludes(JSON.stringify(fresh), [
    'SHOULD_NOT_APPEAR_PROCESS_ARG',
    '/Applications/Adobe Photoshop.app',
    '/Applications/Adobe InDesign.app',
    'stdout',
    'raw',
  ], 'Adobe suite live refresh state');
});

test('InDesign live save refresh stages saved open document and linked assets without reopen', async () => {
  resetTestHomeWorkspace();
  const qaRoot = path.join(TEST_HOME, 'Desktop', 'Crate-QA', 'v2.8.0-qa.38-jenna');
  const sourceDir = path.join(qaRoot, 'source-copies');
  const existingDir = path.join(qaRoot, 'linked-assets', 'indesign-manual-save');
  const downloadsDir = path.join(qaRoot, 'web-downloads', 'indesign-manual-save');
  const outputDir = path.join(qaRoot, 'package-outputs');
  const sourcePath = path.join(sourceDir, 'Crate InDesign Manual Save Timing QA qa38.indd');
  const existingOnePath = path.join(existingDir, 'qa38-indesign-manual-existing-01.jpg');
  const existingTwoPath = path.join(existingDir, 'qa38-indesign-manual-existing-02.jpg');
  const newOnePath = path.join(downloadsDir, 'qa38-indesign-manual-new-used-01.jpg');
  const newTwoPath = path.join(downloadsDir, 'qa38-indesign-manual-new-used-02.jpg');
  const newThreePath = path.join(downloadsDir, 'qa38-indesign-manual-new-used-03.jpg');
  const unusedOnePath = path.join(downloadsDir, 'qa38-indesign-manual-new-unused-04.jpg');
  const unusedTwoPath = path.join(downloadsDir, 'qa38-indesign-manual-new-unused-05.jpg');

  for (const dirPath of [sourceDir, existingDir, downloadsDir, outputDir]) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  for (const filePath of [
    sourcePath,
    existingOnePath,
    existingTwoPath,
    newOnePath,
    newTwoPath,
    newThreePath,
    unusedOnePath,
    unusedTwoPath,
  ]) {
    fs.writeFileSync(filePath, `${path.basename(filePath)} bytes`);
  }

  setChildProcessHandler(({ kind, command, args }) => {
    if (kind === 'exec' && command.includes("grep -i 'Adobe InDesign'")) {
      return {
        stdout: '456 /Applications/Adobe InDesign 2026/Adobe InDesign.app/Contents/MacOS/Adobe InDesign --secret SHOULD_NOT_APPEAR_PROCESS_ARG\n',
      };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-indd-poll.applescript')) {
      assertPrivateTempScriptPath(args[0]);
      return {
        stdout: [
          `DOC\t${sourcePath}\t${path.basename(sourcePath)}\tfalse\ttrue`,
          `LINK\t${sourcePath}\t${path.basename(sourcePath)}\t${existingOnePath}\tfalse\ttrue`,
          `LINK\t${sourcePath}\t${path.basename(sourcePath)}\t${existingTwoPath}\tfalse\ttrue`,
          `LINK\t${sourcePath}\t${path.basename(sourcePath)}\t${newOnePath}\tfalse\ttrue`,
          `LINK\t${sourcePath}\t${path.basename(sourcePath)}\t${newTwoPath}\tfalse\ttrue`,
          `LINK\t${sourcePath}\t${path.basename(sourcePath)}\t${newThreePath}\tfalse\ttrue`,
        ].join('\n') + '\n',
      };
    }
    return { stdout: '' };
  });

  const projectName = 'InDesign manual save refresh';
  const project = await createProject(projectName);
  const expectedPaths = [
    sourcePath,
    existingOnePath,
    existingTwoPath,
    newOnePath,
    newTwoPath,
    newThreePath,
  ];
  const fresh = await waitForProject(
    project.id,
    item => expectedPaths.every(filePath => item.files.some(file => file.path === filePath)),
    7000
  );

  assert.equal(fresh.pendingFiles.length, 0);
  assert.deepEqual(fresh.files.map(file => file.path).sort(), expectedPaths.sort());
  assert.equal(fresh.files.filter(file => file.path === sourcePath).length, 1);
  assert.equal(fresh.files.some(file => file.path === unusedOnePath), false);
  assert.equal(fresh.files.some(file => file.path === unusedTwoPath), false);
  assert.equal(getSessionObservedByMethod(fresh, 'indd-poll').length, 5);

  const statusEntries = getLiveAppStatusEntries(fresh, 'indesign');
  assert.ok(statusEntries.some(entry => (
    entry.appRunning === true &&
    entry.scriptAttempted === true &&
    entry.scriptSuccess === true &&
    entry.docsCount === 1 &&
    entry.linksCount === 5 &&
    entry.normalizedCount >= 6
  )));

  assertTextExcludes(JSON.stringify(fresh.liveEvidenceLedger || {}), [
    'DOC\t',
    'LINK\t',
    'SHOULD_NOT_APPEAR_PROCESS_ARG',
    '/Applications/Adobe InDesign',
    sourcePath,
    newOnePath,
    'stdout',
    'raw',
  ], 'InDesign save refresh live evidence ledger');

  const result = await callIpc('projects:package', project.id, outputDir);
  assertPackageResultShape(result);
  assert.equal(result.success, true);
  assert.equal(result.totalFiles, 6);
  assert.equal(result.copiedCount, 6);
  assert.deepEqual(result.errors, []);

  const destFolder = packageFolder(outputDir, projectName);
  const outputFileNames = fs.readdirSync(destFolder)
    .filter(fileName => fs.statSync(path.join(destFolder, fileName)).isFile())
    .sort();
  assert.deepEqual(outputFileNames, expectedPaths.map(filePath => path.basename(filePath)).sort());
  assert.equal(fs.existsSync(path.join(destFolder, path.basename(unusedOnePath))), false);
  assert.equal(fs.existsSync(path.join(destFolder, path.basename(unusedTwoPath))), false);
});

test('InDesign modified live document and links remain needs-save until saved', async () => {
  resetTestHomeWorkspace();
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'indesign-unsaved-live.indd');
  const linkedPath = path.join(TEST_HOME, 'Desktop', 'indesign-unsaved-linked.jpg');
  fs.writeFileSync(sourcePath, 'indd bytes');
  fs.writeFileSync(linkedPath, 'linked bytes');

  setChildProcessHandler(({ kind, command, args }) => {
    if (kind === 'exec' && command.includes("grep -i 'Adobe InDesign'")) {
      return {
        stdout: '456 /Applications/Adobe InDesign.app/Contents/MacOS/Adobe InDesign --secret SHOULD_NOT_APPEAR_PROCESS_ARG\n',
      };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-indd-poll.applescript')) {
      return {
        stdout: [
          `DOC\t${sourcePath}\t${path.basename(sourcePath)}\ttrue\ttrue`,
          `LINK\t${sourcePath}\t${path.basename(sourcePath)}\t${linkedPath}\ttrue\ttrue`,
        ].join('\n') + '\n',
      };
    }
    return { stdout: '' };
  });

  const project = await createProject('InDesign unsaved live session');
  const fresh = await waitForProject(project.id, item => item.pendingFiles.length === 2, 5000);
  const sourceCandidate = fresh.pendingFiles.find(file => file.path === sourcePath);
  const linkedCandidate = fresh.pendingFiles.find(file => file.path === linkedPath);

  assert.ok(sourceCandidate);
  assert.ok(linkedCandidate);
  assert.deepEqual(fresh.files, []);
  assert.equal(sourceCandidate.source, 'app-opened');
  assert.equal(sourceCandidate.captureState, 'needs-save');
  assert.equal(sourceCandidate.captureReason, 'unsaved-source-needs-save');
  assert.equal(sourceCandidate.captureEvidence.appFamily, 'indesign');
  assert.equal(sourceCandidate.captureEvidence.observerMethod, 'indesign-live-applescript');
  assert.equal(sourceCandidate.captureEvidence.documentModified, true);
  assert.equal(linkedCandidate.source, 'indd-poll');
  assert.equal(linkedCandidate.captureState, 'needs-save');
  assert.equal(linkedCandidate.captureReason, 'linked-asset-observed');
  assert.equal(linkedCandidate.captureEvidence.relationship, 'source-linked');
  assert.equal(linkedCandidate.captureEvidence.sourceDocumentName, path.basename(sourcePath));
  assert.equal(getSessionObservedByMethod(fresh, 'indd-poll').length, 0);
  assertTextExcludes(JSON.stringify(fresh.pendingFiles), [
    'SHOULD_NOT_APPEAR_PROCESS_ARG',
    '/Applications/Adobe InDesign.app',
    'DOC\t',
    'LINK\t',
    'stdout',
    'raw',
  ], 'InDesign unsaved live session pending files');
});

test('Illustrator live app evidence stages open source and linked asset as needs-save candidates', async () => {
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'live-illustrator.ai');
  const linkedPath = path.join(TEST_HOME, 'Desktop', 'IMG_5331.JPG');
  fs.writeFileSync(sourcePath, 'ai bytes');
  fs.writeFileSync(linkedPath, 'jpg bytes');
  setChildProcessHandler(({ kind, command, args, commandText }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) {
      return { stdout: '123\n' };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      assertPrivateTempScriptPath(args[0]);
      const scriptText = fs.readFileSync(args[0], 'utf8');
      assert.equal(commandText.includes('tell application'), false);
      assert.equal(scriptText.includes('repeat with aDoc in every document'), true);
      assert.equal(scriptText.includes('file path of current document'), true);
      assert.equal(scriptText.includes('file path of aDoc'), true);
      assert.equal(scriptText.includes('aDoc is current document'), true);
      assert.equal(scriptText.includes('file of pItem'), true);
      assertIllustratorPlacedItemPathFallbackGuarded(scriptText);
      assert.equal(scriptText.includes('full name of'), false);
      assert.equal(scriptText.includes('do javascript'), true);
      assert.equal(scriptText.includes('fsName'), true);
      assert.equal(scriptText.includes('fullName'), false);
      assert.equal(scriptText.includes('candidateText contains ":"'), true);
      assert.equal(scriptText.includes('linked of pItem'), false);
      return {
        stdout: [
          `DOC\t${sourcePath}\tlive-illustrator.ai\ttrue\ttrue`,
          'PLACED\t1',
          `LINK\t${sourcePath}\tlive-illustrator.ai\t${linkedPath}\ttrue\ttrue`,
        ].join('\n') + '\n',
      };
    }
    return { stdout: '' };
  });

  const project = await createProject('Illustrator active session provenance');
  const fresh = await waitForProject(project.id, item => item.pendingFiles.length === 2, 5000);
  const sourceCandidate = fresh.pendingFiles.find(file => file.path === sourcePath);
  const linkedCandidate = fresh.pendingFiles.find(file => file.path === linkedPath);

  assert.ok(sourceCandidate);
  assert.ok(linkedCandidate);
  assert.deepEqual(fresh.files, []);
  assert.equal(sourceCandidate.source, 'app-opened');
  assert.equal(sourceCandidate.captureState, 'needs-save');
  assert.equal(sourceCandidate.captureReason, 'unsaved-source-needs-save');
  assert.equal(sourceCandidate.captureEvidence.appFamily, 'illustrator');
  assert.equal(sourceCandidate.captureEvidence.observerMethod, 'illustrator-active-session');
  assert.equal(sourceCandidate.captureEvidence.evidenceStrength, 'structured-app-document');
  assert.equal(sourceCandidate.captureEvidence.captureRecommendation, 'needs-save');
  assert.equal(sourceCandidate.captureEvidence.documentModified, true);
  assert.equal(sourceCandidate.captureEvidence.designerReason, 'Observed in Illustrator. Save to make package-ready.');
  assert.equal(linkedCandidate.source, 'ai-linked');
  assert.equal(linkedCandidate.captureState, 'needs-save');
  assert.equal(linkedCandidate.captureReason, 'linked-asset-observed');
  assert.equal(linkedCandidate.captureEvidence.appFamily, 'illustrator');
  assert.equal(linkedCandidate.captureEvidence.observerMethod, 'illustrator-active-session');
  assert.equal(linkedCandidate.captureEvidence.evidenceStrength, 'structured-app-link');
  assert.equal(linkedCandidate.captureEvidence.captureRecommendation, 'needs-save');
  assert.equal(linkedCandidate.captureEvidence.documentModified, true);
  assert.equal(linkedCandidate.captureEvidence.designerReason, 'Linked asset observed in Illustrator. Save to make package-ready.');
  assert.equal(linkedCandidate.captureEvidence.sourceDocumentName, 'live-illustrator.ai');
  assert.equal(linkedCandidate.captureEvidence.sourceName, 'live-illustrator.ai');
  assert.equal(linkedCandidate.captureEvidence.relationship, 'source-linked');
  assert.equal(getSessionObservedByMethod(fresh, 'ai-linked').length, 0);
  assertProvenanceTextExcludes(fresh, [
    'SHOULD_NOT_APPEAR_PROCESS_ARG',
    '/Applications/Adobe Illustrator.app',
    'tell application',
    sourcePath,
    linkedPath,
    'stdout',
  ]);
  assertTextExcludes(JSON.stringify([sourceCandidate.captureEvidence, linkedCandidate.captureEvidence]), [
    'DOC\t',
    'LINK\t',
    'SHOULD_NOT_APPEAR_PROCESS_ARG',
    '/Applications/Adobe Illustrator.app',
    'tell application',
    sourcePath,
    linkedPath,
    'stdout',
    'raw',
  ], 'Illustrator live capture evidence');
  assert.equal(Object.prototype.hasOwnProperty.call(sourceCandidate.captureEvidence, 'ignoredCaptureHint'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(linkedCandidate.captureEvidence, 'ignoredCaptureHint'), false);
  const ledgerText = JSON.stringify(fresh.liveEvidenceLedger);
  assertTextExcludes(ledgerText, [
    'DOC\t',
    'LINK\t',
    'SHOULD_NOT_APPEAR_PROCESS_ARG',
    '/Applications/Adobe Illustrator.app',
    'tell application',
    sourcePath,
    linkedPath,
    'stdout',
    'raw',
  ], 'Illustrator live evidence ledger');
  const ledgerEntries = Object.values((fresh.liveEvidenceLedger && fresh.liveEvidenceLedger.candidates) || {});
  assert.equal(ledgerEntries.filter(entry => entry.strongestState === 'needs-save').length, 2);
  const statusEntries = getLiveAppStatusEntries(fresh, 'illustrator');
  assert.ok(statusEntries.some(entry => entry.pollInstalled === true));
  assert.ok(statusEntries.some(entry => entry.pollFired === true && entry.projectWatching === true));
  assert.ok(statusEntries.some(entry => (
    entry.appRunning === true &&
    entry.scriptAttempted === true &&
    entry.scriptSuccess === true &&
    entry.docsCount === 1 &&
    entry.linksCount === 1 &&
    entry.placedItemsCount === 1 &&
    entry.normalizedCount >= 2
  )));
  assert.ok(statusEntries.some(entry => entry.stagedCount === 2));
  assertTextExcludes(JSON.stringify(fresh.liveAppEvidenceStatus), [
    'DOC\t',
    'LINK\t',
    'SHOULD_NOT_APPEAR_PROCESS_ARG',
    '/Applications/Adobe Illustrator.app',
    'tell application',
    sourcePath,
    linkedPath,
    'stdout',
    'raw',
  ], 'Illustrator live app status breadcrumbs');
});

test('Illustrator live app fallback does not leak stale source into InDesign-anchored project', async () => {
  resetTestHomeWorkspace();
  const qa35Root = path.join(TEST_HOME, 'Desktop', 'Crate-QA', 'v2.8.0-qa.35-jenna');
  const sourceDir = path.join(qa35Root, 'source-copies');
  const downloadsDir = path.join(qa35Root, 'web-downloads', 'indesign-unused-exclusion');
  const outputDir = path.join(qa35Root, 'package-outputs');
  const indesignPath = path.join(sourceDir, 'Crate InDesign Downloaded Unused QA qa35.indd');
  const staleIllustratorPath = path.join(sourceDir, 'Bris Invitation-03 copy.ai');
  const usedOnePath = path.join(downloadsDir, 'qa35-used-web-01.jpg');
  const usedTwoPath = path.join(downloadsDir, 'qa35-used-web-02.jpg');
  const unusedPath = path.join(downloadsDir, 'qa35-unused-web-03.jpg');
  const staleIllustratorLinkedPath = path.join(qa35Root, 'test-photos', 'IMG_5331.JPG');

  for (const dirPath of [sourceDir, downloadsDir, outputDir, path.dirname(staleIllustratorLinkedPath)]) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  fs.writeFileSync(indesignPath, 'saved InDesign bytes');
  fs.writeFileSync(staleIllustratorPath, 'stale Illustrator bytes');
  fs.writeFileSync(usedOnePath, 'used image one');
  fs.writeFileSync(usedTwoPath, 'used image two');
  fs.writeFileSync(unusedPath, 'unused image should stay out');
  fs.writeFileSync(staleIllustratorLinkedPath, 'stale Illustrator linked image');

  const priorIllustratorProject = await createProject('Prior Illustrator lane before clear');
  await setProjectFiles(priorIllustratorProject.id, {
    pendingFiles: [{
      path: staleIllustratorPath,
      name: path.basename(staleIllustratorPath),
      ext: '.ai',
      addedAt: Date.now(),
      source: 'app-opened',
      captureState: 'needs-save',
      captureReason: 'unsaved-source-needs-save',
      captureEvidence: {
        source: 'app-opened',
        appFamily: 'illustrator',
        observerMethod: 'illustrator-active-session',
        evidenceStrength: 'structured-app-document',
        captureRecommendation: 'needs-save',
      },
    }],
    liveEvidenceLedger: {
      schemaVersion: 1,
      candidates: {
        [liveEvidenceKeyForTest(staleIllustratorPath)]: {
          evidenceKey: liveEvidenceKeyForTest(staleIllustratorPath),
          strongestState: 'needs-save',
          latest: {
            candidateName: path.basename(staleIllustratorPath),
            captureRecommendation: 'needs-save',
            reason: 'unsaved-source-needs-save',
          },
        },
      },
    },
  });
  await callIpc('projects:delete-all');
  assert.equal((await callIpc('projects:get-all')).length, 0);

  let illustratorScriptAttempts = 0;
  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) {
      return { stdout: '123\n' };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      illustratorScriptAttempts++;
      return {
        stdout: [
          `DOC\t${staleIllustratorPath}\tBris Invitation-03 copy.ai\ttrue\ttrue`,
          'PLACED\t1',
          `LINK\t${staleIllustratorPath}\tBris Invitation-03 copy.ai\t${staleIllustratorLinkedPath}\ttrue\ttrue`,
        ].join('\n') + '\n',
      };
    }
    return { stdout: '' };
  });

  const projectName = 'InDesign anchored stale Illustrator guard';
  const project = await createProject(projectName);
  const now = Date.now();
  await setProjectFiles(project.id, {
    files: [
      {
        path: indesignPath,
        name: path.basename(indesignPath),
        ext: '.indd',
        addedAt: now,
        source: 'scan-on-open',
        captureReason: 'scan-on-open-source-relationship',
        captureEvidence: {
          source: 'scan-on-open',
          parserConfirmed: true,
          filesystemSaved: true,
        },
      },
      {
        path: usedOnePath,
        name: path.basename(usedOnePath),
        ext: '.jpg',
        addedAt: now,
        source: 'indd-linked',
        captureReason: 'linked-asset-observed',
        captureEvidence: {
          source: 'indd-poll',
          appFamily: 'indesign',
          evidenceStrength: 'structured-app-link',
          captureRecommendation: 'package-ready',
          parserConfirmed: true,
        },
      },
      {
        path: usedTwoPath,
        name: path.basename(usedTwoPath),
        ext: '.jpg',
        addedAt: now,
        source: 'indd-linked',
        captureReason: 'linked-asset-observed',
        captureEvidence: {
          source: 'indd-poll',
          appFamily: 'indesign',
          evidenceStrength: 'structured-app-link',
          captureRecommendation: 'package-ready',
          parserConfirmed: true,
        },
      },
    ],
    pendingFiles: [],
  });

  await waitForProject(project.id, () => illustratorScriptAttempts > 0, 5000);
  let fresh = await getProject(project.id);
  assert.equal(fresh.files.some(file => file.path === staleIllustratorPath), false);
  assert.equal(fresh.pendingFiles.some(file => file.path === staleIllustratorPath), false);
  assert.equal(fresh.files.some(file => file.path === staleIllustratorLinkedPath), false);
  assert.equal(fresh.pendingFiles.some(file => file.path === staleIllustratorLinkedPath), false);
  assert.equal(fresh.files.some(file => file.path === indesignPath), true);
  assert.equal(fresh.files.some(file => file.path === usedOnePath), true);
  assert.equal(fresh.files.some(file => file.path === usedTwoPath), true);
  assert.equal(fresh.files.some(file => file.path === unusedPath), false);

  const result = await callIpc('projects:package', project.id, outputDir);
  assertPackageResultShape(result);
  assert.equal(result.success, true);
  assert.equal(result.totalFiles, 3);
  assert.equal(result.copiedCount, 3);
  assert.deepEqual(result.errors, []);

  const destFolder = packageFolder(outputDir, projectName);
  const outputFileNames = fs.readdirSync(destFolder)
    .filter(fileName => fs.statSync(path.join(destFolder, fileName)).isFile())
    .sort();
  assert.deepEqual(outputFileNames, [
    path.basename(indesignPath),
    path.basename(usedOnePath),
    path.basename(usedTwoPath),
  ].sort());
  assert.equal(fs.existsSync(path.join(destFolder, path.basename(staleIllustratorPath))), false);
  assert.equal(fs.existsSync(path.join(destFolder, path.basename(staleIllustratorLinkedPath))), false);
  assert.equal(fs.existsSync(path.join(destFolder, path.basename(unusedPath))), false);

  fresh = await getProject(project.id);
  assertProvenanceTextExcludes(fresh, [
    staleIllustratorPath,
    staleIllustratorLinkedPath,
    '/usr/bin/osascript',
    'stdout',
    'raw',
  ]);
});

test('pre-package broad scan does not surface stale Illustrator source in fresh InDesign project UI', async () => {
  resetTestHomeWorkspace();
  const qa36Root = path.join(TEST_HOME, 'Desktop', 'Crate-QA', 'v2.8.0-qa.36-jenna');
  const sourceDir = path.join(qa36Root, 'source-copies');
  const downloadsDir = path.join(qa36Root, 'web-downloads', 'indesign-unused-exclusion');
  const outputDir = path.join(qa36Root, 'package-outputs');
  const indesignPath = path.join(sourceDir, 'Crate InDesign Downloaded Unused QA qa36.indd');
  const staleIllustratorPath = path.join(sourceDir, 'Bris Invitation-03 copy.ai');
  const usedOnePath = path.join(downloadsDir, 'qa36-used-web-01.jpg');
  const usedTwoPath = path.join(downloadsDir, 'qa36-used-web-02.jpg');
  const unusedPath = path.join(downloadsDir, 'qa36-unused-web-03.jpg');

  for (const dirPath of [sourceDir, downloadsDir, outputDir]) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  fs.writeFileSync(indesignPath, 'saved InDesign bytes');
  fs.writeFileSync(staleIllustratorPath, 'stale Illustrator bytes');
  fs.writeFileSync(usedOnePath, 'used image one');
  fs.writeFileSync(usedTwoPath, 'used image two');
  fs.writeFileSync(unusedPath, 'unused image should stay out');

  setChildProcessHandler(({ kind, command, args }) => {
    if (kind === 'execFile' && command === '/usr/bin/mdls') {
      const filePath = Array.isArray(args) ? args[args.length - 1] : '';
      if (filePath === staleIllustratorPath) {
        return { stdout: `${new Date(Date.now() + 60000).toISOString()}\n` };
      }
      return { stdout: '(null)\n' };
    }
    return { stdout: '' };
  });

  const projectName = 'InDesign stale UI pending guard';
  const project = await createProject(projectName);
  const now = Date.now();
  await setProjectFiles(project.id, {
    files: [
      {
        path: indesignPath,
        name: path.basename(indesignPath),
        ext: '.indd',
        addedAt: now,
        source: 'scan-on-open',
        captureReason: 'scan-on-open-source-relationship',
        captureEvidence: {
          source: 'scan-on-open',
          parserConfirmed: true,
          filesystemSaved: true,
        },
      },
      {
        path: usedOnePath,
        name: path.basename(usedOnePath),
        ext: '.jpg',
        addedAt: now,
        source: 'indd-linked',
        captureReason: 'linked-asset-observed',
        captureEvidence: {
          source: 'indd-poll',
          appFamily: 'indesign',
          evidenceStrength: 'structured-app-link',
          captureRecommendation: 'package-ready',
          parserConfirmed: true,
        },
      },
      {
        path: usedTwoPath,
        name: path.basename(usedTwoPath),
        ext: '.jpg',
        addedAt: now,
        source: 'indd-linked',
        captureReason: 'linked-asset-observed',
        captureEvidence: {
          source: 'indd-poll',
          appFamily: 'indesign',
          evidenceStrength: 'structured-app-link',
          captureRecommendation: 'package-ready',
          parserConfirmed: true,
        },
      },
    ],
    pendingFiles: [],
  });

  const scan = await callIpc('projects:pre-package-scan', project.id);
  assert.equal(scan.newCount, 0);

  let fresh = await getProject(project.id);
  assert.equal(fresh.files.some(file => file.path === staleIllustratorPath), false);
  assert.equal(fresh.pendingFiles.some(file => file.path === staleIllustratorPath), false);
  assert.equal(fresh.files.some(file => file.path === indesignPath), true);
  assert.equal(fresh.files.some(file => file.path === usedOnePath), true);
  assert.equal(fresh.files.some(file => file.path === usedTwoPath), true);
  assert.equal(fresh.files.some(file => file.path === unusedPath), false);
  assert.equal(Object.values((fresh.liveEvidenceLedger && fresh.liveEvidenceLedger.candidates) || {})
    .some(entry => entry.latest && entry.latest.reason === 'broad-observer-outside-session'), true);

  const result = await callIpc('projects:package', project.id, outputDir);
  assertPackageResultShape(result);
  assert.equal(result.success, true);
  assert.equal(result.totalFiles, 3);
  assert.equal(result.copiedCount, 3);
  assert.deepEqual(result.errors, []);

  const destFolder = packageFolder(outputDir, projectName);
  const outputFileNames = fs.readdirSync(destFolder)
    .filter(fileName => fs.statSync(path.join(destFolder, fileName)).isFile())
    .sort();
  assert.deepEqual(outputFileNames, [
    path.basename(indesignPath),
    path.basename(usedOnePath),
    path.basename(usedTwoPath),
  ].sort());
  assert.equal(fs.existsSync(path.join(destFolder, path.basename(staleIllustratorPath))), false);
  assert.equal(fs.existsSync(path.join(destFolder, path.basename(unusedPath))), false);

  fresh = await getProject(project.id);
  assertProvenanceTextExcludes(fresh, [
    staleIllustratorPath,
    '/usr/bin/mdls',
    'stdout',
    'raw',
  ]);
});

test('Illustrator live app evidence stages valid rows when placed item reads report safe partial status', async () => {
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'live-illustrator-partial.ai');
  const linkedPath = path.join(TEST_HOME, 'Desktop', 'IMG_5331.JPG');
  fs.writeFileSync(sourcePath, 'ai bytes');
  fs.writeFileSync(linkedPath, 'jpg bytes');
  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) {
      return { stdout: '123\n' };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      const scriptText = fs.readFileSync(args[0], 'utf8');
      assert.equal(scriptText.includes('illustrator-document-query-failed'), true);
      assert.equal(scriptText.includes('illustrator-placed-items-query-failed'), true);
      assert.equal(scriptText.includes('illustrator-placed-item-file-query-failed'), true);
      assert.equal(scriptText.includes('illustrator-placed-item-file-fallback-used'), true);
      assert.equal(scriptText.includes('illustrator-placed-item-file-fallback-failed'), true);
      assert.equal(scriptText.includes('file path of current document'), true);
      assert.equal(scriptText.includes('file path of aDoc'), true);
      assertIllustratorPlacedItemPathFallbackGuarded(scriptText);
      assert.equal(scriptText.includes('full name of'), false);
      return {
        stdout: [
          `DOC\t${sourcePath}\tlive-illustrator-partial.ai\ttrue\ttrue`,
          'PLACED\t2',
          'STATUS\tillustrator-placed-item-file-query-failed',
          `LINK\t${sourcePath}\tlive-illustrator-partial.ai\t${linkedPath}\ttrue\ttrue`,
        ].join('\n') + '\n',
      };
    }
    return { stdout: '' };
  });

  const project = await createProject('Illustrator partial placed item status');
  const fresh = await waitForProject(project.id, item => item.pendingFiles.length === 2, 5000);
  const sourceCandidate = fresh.pendingFiles.find(file => file.path === sourcePath);
  const linkedCandidate = fresh.pendingFiles.find(file => file.path === linkedPath);

  assert.ok(sourceCandidate);
  assert.ok(linkedCandidate);
  assert.equal(linkedCandidate.source, 'ai-linked');
  assert.equal(linkedCandidate.captureState, 'needs-save');
  assert.equal(linkedCandidate.captureReason, 'linked-asset-observed');
  assert.equal(linkedCandidate.captureEvidence.observerMethod, 'illustrator-active-session');
  assert.equal(linkedCandidate.captureEvidence.documentModified, true);
  assert.equal(linkedCandidate.captureEvidence.sourceDocumentName, 'live-illustrator-partial.ai');
  const statusEntries = getLiveAppStatusEntries(fresh, 'illustrator');
  assert.ok(statusEntries.some(entry => (
    entry.scriptAttempted === true &&
    entry.scriptSuccess === true &&
    entry.docsCount === 1 &&
    entry.linksCount === 1 &&
    entry.placedItemsCount === 2 &&
    entry.errorCategory === 'illustrator-placed-item-file-query-failed'
  )));
  assert.ok(statusEntries.some(entry => entry.stagedCount === 2 && entry.errorCategory === 'script-success'));
  assertTextExcludes(JSON.stringify(fresh.liveAppEvidenceStatus), [
    sourcePath,
    linkedPath,
    'file path of pItem',
    'SHOULD_NOT_APPEAR',
    'stdout',
    'stderr',
    'raw',
  ], 'Illustrator partial status breadcrumbs');
});

test('Illustrator guarded placed item path fallback stages linked asset when file object query fails', async () => {
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'path-fallback-illustrator.ai');
  const linkedPath = path.join(TEST_HOME, 'Desktop', 'qa21-live-only-IMG_5331.JPG');
  fs.writeFileSync(sourcePath, 'ai bytes');
  fs.writeFileSync(linkedPath, 'jpg bytes');
  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) {
      return { stdout: '123\n' };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      const scriptText = fs.readFileSync(args[0], 'utf8');
      assertIllustratorPlacedItemPathFallbackGuarded(scriptText);
      assert.equal(scriptText.includes('do javascript'), true);
      assert.equal(scriptText.includes('fsName'), true);
      assert.equal(scriptText.includes('fullName'), false);
      return {
        stdout: [
          `DOC\t${sourcePath}\tpath-fallback-illustrator.ai\ttrue\ttrue`,
          'PLACED\t1',
          'STATUS\tillustrator-placed-item-file-query-failed',
          'STATUS\tillustrator-placed-item-path-fallback-used',
          `LINK\t${sourcePath}\tpath-fallback-illustrator.ai\t${linkedPath}\ttrue\ttrue`,
        ].join('\n') + '\n',
      };
    }
    return { stdout: '' };
  });

  const project = await createProject('Illustrator placed path fallback');
  const fresh = await waitForProject(project.id, item => item.pendingFiles.length === 2, 5000);
  const linkedCandidate = fresh.pendingFiles.find(file => file.path === linkedPath);

  assert.ok(linkedCandidate);
  assert.equal(linkedCandidate.source, 'ai-linked');
  assert.equal(linkedCandidate.captureState, 'needs-save');
  assert.equal(linkedCandidate.captureReason, 'linked-asset-observed');
  assert.equal(linkedCandidate.captureEvidence.observerMethod, 'illustrator-active-session');
  assert.equal(linkedCandidate.captureEvidence.documentModified, true);
  assert.equal(linkedCandidate.captureEvidence.sourceDocumentName, 'path-fallback-illustrator.ai');
  assert.equal(fresh.files.some(file => file.path === linkedPath), false);
  assert.equal(getSessionObservedByMethod(fresh, 'ai-linked').length, 0);

  const statusEntries = getLiveAppStatusEntries(fresh, 'illustrator');
  assert.ok(statusEntries.some(entry => (
    entry.scriptAttempted === true &&
    entry.scriptSuccess === true &&
    entry.docsCount === 1 &&
    entry.linksCount === 1 &&
    entry.placedItemsCount === 1 &&
    entry.errorCategory === 'illustrator-placed-item-file-query-failed' &&
    entry.statusReasonCounts &&
    entry.statusReasonCounts['illustrator-placed-item-file-query-failed'] === 1 &&
    entry.statusReasonCounts['illustrator-placed-item-path-fallback-used'] === 1
  )));
  assert.ok(statusEntries.some(entry => entry.stagedCount === 2 && entry.errorCategory === 'script-success'));

  assertTextExcludes(JSON.stringify(fresh.liveAppEvidenceStatus), [
    sourcePath,
    linkedPath,
    'DOC\t',
    'LINK\t',
    'file path of pItem',
    'SHOULD_NOT_APPEAR',
    'stdout',
    'stderr',
    'raw',
  ], 'Illustrator path fallback status breadcrumbs');
  assertTextExcludes(JSON.stringify(fresh.liveEvidenceLedger), [
    sourcePath,
    linkedPath,
    'DOC\t',
    'LINK\t',
    'file path of pItem',
    'SHOULD_NOT_APPEAR',
    'stdout',
    'stderr',
    'raw',
  ], 'Illustrator path fallback live evidence ledger');
});

test('Illustrator placed item path text coercion fallback stages linked asset when object reads fail', async () => {
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'path-text-fallback-illustrator.ai');
  const linkedPath = path.join(TEST_HOME, 'Desktop', 'qa22-live-only-IMG_5331.JPG');
  fs.writeFileSync(sourcePath, 'ai bytes');
  fs.writeFileSync(linkedPath, 'jpg bytes');
  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) {
      return { stdout: '123\n' };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      const scriptText = fs.readFileSync(args[0], 'utf8');
      assertIllustratorPlacedItemPathFallbackGuarded(scriptText);
      assert.equal(scriptText.includes('illustrator-placed-item-file-of-query-failed'), true);
      assert.equal(scriptText.includes('illustrator-placed-item-file-path-object-query-failed'), true);
      assert.equal(scriptText.includes('illustrator-placed-item-file-path-text-fallback-used'), true);
      assert.equal(scriptText.includes('illustrator-placed-item-file-path-alias-fallback-used'), true);
      assert.equal(scriptText.includes('full name of'), false);
      return {
        stdout: [
          `DOC\t${sourcePath}\tpath-text-fallback-illustrator.ai\ttrue\ttrue`,
          'PLACED\t3',
          'STATUS\tillustrator-placed-item-file-query-failed',
          'STATUS\tillustrator-placed-item-file-of-query-failed',
          'STATUS\tillustrator-placed-item-path-query-failed',
          'STATUS\tillustrator-placed-item-file-path-object-query-failed',
          'STATUS\tillustrator-placed-item-file-path-text-fallback-used',
          `LINK\t${sourcePath}\tpath-text-fallback-illustrator.ai\t${linkedPath}\ttrue\ttrue`,
        ].join('\n') + '\n',
      };
    }
    return { stdout: '' };
  });

  const project = await createProject('Illustrator placed path text fallback');
  const fresh = await waitForProject(project.id, item => item.pendingFiles.length === 2, 5000);
  const linkedCandidate = fresh.pendingFiles.find(file => file.path === linkedPath);

  assert.ok(linkedCandidate);
  assert.equal(linkedCandidate.source, 'ai-linked');
  assert.equal(linkedCandidate.captureState, 'needs-save');
  assert.equal(linkedCandidate.captureReason, 'linked-asset-observed');
  assert.equal(linkedCandidate.captureEvidence.observerMethod, 'illustrator-active-session');
  assert.equal(linkedCandidate.captureEvidence.documentModified, true);
  assert.equal(linkedCandidate.captureEvidence.sourceDocumentName, 'path-text-fallback-illustrator.ai');
  assert.equal(fresh.files.some(file => file.path === linkedPath), false);
  assert.equal(getSessionObservedByMethod(fresh, 'ai-linked').length, 0);

  const statusEntries = getLiveAppStatusEntries(fresh, 'illustrator');
  assert.ok(statusEntries.some(entry => (
    entry.scriptAttempted === true &&
    entry.scriptSuccess === true &&
    entry.docsCount === 1 &&
    entry.linksCount === 1 &&
    entry.placedItemsCount === 3 &&
    entry.errorCategory === 'illustrator-placed-item-file-query-failed' &&
    entry.statusReasonCounts &&
    entry.statusReasonCounts['illustrator-placed-item-file-query-failed'] === 1 &&
    entry.statusReasonCounts['illustrator-placed-item-file-of-query-failed'] === 1 &&
    entry.statusReasonCounts['illustrator-placed-item-path-query-failed'] === 1 &&
    entry.statusReasonCounts['illustrator-placed-item-file-path-object-query-failed'] === 1 &&
    entry.statusReasonCounts['illustrator-placed-item-file-path-text-fallback-used'] === 1
  )));
  assert.ok(statusEntries.some(entry => entry.stagedCount === 2 && entry.errorCategory === 'script-success'));

  assertTextExcludes(JSON.stringify(fresh.liveAppEvidenceStatus), [
    sourcePath,
    linkedPath,
    'DOC\t',
    'LINK\t',
    'file path of pItem',
    'SHOULD_NOT_APPEAR',
    'stdout',
    'stderr',
    'raw',
  ], 'Illustrator path text fallback status breadcrumbs');
  assertTextExcludes(JSON.stringify(fresh.liveEvidenceLedger), [
    sourcePath,
    linkedPath,
    'DOC\t',
    'LINK\t',
    'file path of pItem',
    'SHOULD_NOT_APPEAR',
    'stdout',
    'stderr',
    'raw',
  ], 'Illustrator path text fallback live evidence ledger');
});

test('Illustrator placed item file fallback stages live linked asset when AppleScript file query fails', async () => {
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'fallback-illustrator.ai');
  const linkedPath = path.join(TEST_HOME, 'Desktop', 'qa20-live-only-IMG_5331.JPG');
  fs.writeFileSync(sourcePath, 'ai bytes');
  fs.writeFileSync(linkedPath, 'jpg bytes');
  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) {
      return { stdout: '123\n' };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      const scriptText = fs.readFileSync(args[0], 'utf8');
      assert.equal(scriptText.includes('file of pItem'), true);
      assertIllustratorPlacedItemPathFallbackGuarded(scriptText);
      assert.equal(scriptText.includes('do javascript'), true);
      assert.equal(scriptText.includes('fsName'), true);
      assert.equal(scriptText.includes('fullName'), false);
      assert.equal(scriptText.includes('illustrator-placed-item-file-query-failed'), true);
      assert.equal(scriptText.includes('illustrator-placed-item-file-fallback-used'), true);
      return {
        stdout: [
          `DOC\t${sourcePath}\tfallback-illustrator.ai\ttrue\ttrue`,
          'PLACED\t1',
          'STATUS\tillustrator-placed-item-file-query-failed',
          'STATUS\tillustrator-placed-item-file-fallback-used',
          `LINK\t\tfallback-illustrator.ai\t${linkedPath}\ttrue\ttrue`,
        ].join('\n') + '\n',
      };
    }
    return { stdout: '' };
  });

  const project = await createProject('Illustrator placed file fallback');
  const fresh = await waitForProject(project.id, item => item.pendingFiles.length === 2, 5000);
  const linkedCandidate = fresh.pendingFiles.find(file => file.path === linkedPath);

  assert.ok(linkedCandidate);
  assert.equal(linkedCandidate.source, 'ai-linked');
  assert.equal(linkedCandidate.captureState, 'needs-save');
  assert.equal(linkedCandidate.captureReason, 'linked-asset-observed');
  assert.equal(linkedCandidate.captureEvidence.observerMethod, 'illustrator-active-session');
  assert.equal(linkedCandidate.captureEvidence.documentModified, true);
  assert.equal(linkedCandidate.captureEvidence.sourceDocumentName, 'fallback-illustrator.ai');
  assert.equal(getSessionObservedByMethod(fresh, 'ai-linked').length, 0);

  const statusEntries = getLiveAppStatusEntries(fresh, 'illustrator');
  assert.ok(statusEntries.some(entry => (
    entry.scriptAttempted === true &&
    entry.scriptSuccess === true &&
    entry.docsCount === 1 &&
    entry.linksCount === 1 &&
    entry.placedItemsCount === 1 &&
    entry.errorCategory === 'illustrator-placed-item-file-query-failed'
  )));
  assert.ok(statusEntries.some(entry => entry.stagedCount === 2 && entry.errorCategory === 'script-success'));

  assertTextExcludes(JSON.stringify(fresh.liveAppEvidenceStatus), [
    sourcePath,
    linkedPath,
    'DOC\t',
    'LINK\t',
    'file path of pItem',
    'SHOULD_NOT_APPEAR',
    'stdout',
    'stderr',
    'raw',
  ], 'Illustrator fallback status breadcrumbs');
  assertTextExcludes(JSON.stringify(fresh.liveEvidenceLedger), [
    sourcePath,
    linkedPath,
    'DOC\t',
    'LINK\t',
    'file path of pItem',
    'SHOULD_NOT_APPEAR',
    'stdout',
    'stderr',
    'raw',
  ], 'Illustrator fallback live evidence ledger');
});

test('live app breadcrumbs persist zero-file poll and app-not-running status safely', async () => {
  resetTestHomeWorkspace();
  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) {
      return { stdout: '' };
    }
    if (isIllustratorPsCommCheck({ kind, command, args })) {
      return { stdout: '' };
    }
    if (isIllustratorPsCommandCheck({ kind, command, args })) {
      return {
        stdout: '/Applications/Preview.app/Contents/MacOS/Preview /Users/private/SHOULD_NOT_APPEAR.ai\n',
      };
    }
    return { stdout: '' };
  });

  const project = await createProject('Zero file live app diagnostics');
  const fresh = await waitForProject(
    project.id,
    item => getLiveAppStatusEntries(item).some(entry => entry.errorCategory === 'app-not-running'),
    5000
  );

  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.pendingFiles, []);
  const statusEntries = getLiveAppStatusEntries(fresh, 'illustrator');
  assert.ok(statusEntries.some(entry => entry.pollInstalled === true));
  assert.ok(statusEntries.some(entry => entry.pollFired === true && entry.projectWatching === true));
  const latest = getLatestLiveAppStatus(fresh);
  assert.equal(latest.appRunning, false);
  assert.equal(latest.scriptAttempted, false);
  assert.equal(latest.scriptSuccess, false);
  assert.equal(latest.stagedCount, 0);
  assert.equal(latest.errorCategory, 'app-not-running');
  assertTextExcludes(JSON.stringify(fresh.liveAppEvidenceStatus), [
    '/Applications/Preview.app',
    '/Users/private',
    'SHOULD_NOT_APPEAR',
    'command=',
    'raw',
    'stdout',
  ], 'zero-file live app status breadcrumbs');
});

test('live app breadcrumbs are capped per app family across repeated watch starts', async () => {
  resetTestHomeWorkspace();
  setChildProcessHandler(() => ({ stdout: '' }));

  const project = await createProject('Capped live app diagnostics');
  await waitForProject(
    project.id,
    item => getLiveAppStatusEntries(item).some(entry => entry.pollInstalled === true),
    5000
  );

  await runTrackedIntervalCallbacks(25);

  const fresh = await getProject(project.id);
  const statusEntries = getLiveAppStatusEntries(fresh);
  assert.equal(statusEntries.length, 20);
  assert.equal(fresh.liveAppEvidenceStatus.entryLimit, 20);
  assert.ok(statusEntries.every(entry => entry.appFamily === 'illustrator'));
  assert.ok(statusEntries.every(entry => entry.pollFired === true));
  assert.ok(statusEntries.some(entry => entry.errorCategory === 'app-not-running'));
  assertTextExcludes(JSON.stringify(fresh.liveAppEvidenceStatus), [
    'raw',
    'stdout',
    'stderr',
    'command=',
  ], 'capped live app status breadcrumbs');
});

test('Illustrator running detection recognizes realistic command paths without retaining process output', async () => {
  resetTestHomeWorkspace();
  let osascriptInvocations = 0;
  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) {
      return { stdout: '' };
    }
    if (isIllustratorPsCommCheck({ kind, command, args })) {
      return { stdout: '' };
    }
    if (isIllustratorPsCommandCheck({ kind, command, args })) {
      return {
        stdout: '/Applications/Adobe Illustrator 2026/Adobe Illustrator.app/Contents/MacOS/Adobe Illustrator --private /Users/private/SHOULD_NOT_APPEAR.ai\n',
      };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      osascriptInvocations++;
      return { stdout: 'STATUS\tno-documents\n' };
    }
    return { stdout: '' };
  });

  const project = await createProject('Illustrator process command detection');
  const fresh = await waitForProject(
    project.id,
    item => getLiveAppStatusEntries(item).some(entry => entry.scriptAttempted === true),
    5000
  );

  assert.equal(osascriptInvocations >= 1, true);
  const statusEntries = getLiveAppStatusEntries(fresh);
  assert.ok(statusEntries.some(entry => entry.appRunning === true));
  assert.ok(statusEntries.some(entry => (
    entry.scriptAttempted === true &&
    entry.scriptSuccess === true &&
    entry.docsCount === 0 &&
    entry.linksCount === 0 &&
    entry.errorCategory === 'no-documents'
  )));
  assertTextExcludes(JSON.stringify(fresh.liveAppEvidenceStatus), [
    '/Applications/Adobe Illustrator',
    '/Users/private',
    'SHOULD_NOT_APPEAR',
    '--private',
    'command=',
    'raw',
    'stdout',
  ], 'Illustrator process detection status breadcrumbs');
});

test('Illustrator live evidence normalizes HFS placed asset paths before staging', async () => {
  resetTestHomeWorkspace();
  const qa14Root = path.join(TEST_HOME, 'Desktop', 'Crate-QA', 'v2.8.0-qa.14-jenna');
  const sourcePath = path.join(qa14Root, 'source-copies', 'Bris Invitation-03 CLEAN QA14.ai');
  const linkedPath = path.join(qa14Root, 'test-photos', 'IMG_5331_QA14_LIVE_ONLY.JPG');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.mkdirSync(path.dirname(linkedPath), { recursive: true });
  fs.writeFileSync(sourcePath, 'clean ai bytes');
  fs.writeFileSync(linkedPath, 'live-only jpg bytes');
  const hfsSourcePath = toStartupHfsPath(sourcePath);
  const hfsLinkedPath = toStartupHfsPath(linkedPath);

  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) {
      return { stdout: '123\n' };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      return {
        stdout: [
          `DOC\t${hfsSourcePath}\tBris Invitation-03 CLEAN QA14.ai\ttrue\ttrue`,
          `LINK\t${hfsSourcePath}\tBris Invitation-03 CLEAN QA14.ai\t${hfsLinkedPath}\ttrue\ttrue`,
        ].join('\n') + '\n',
      };
    }
    return { stdout: '' };
  });

  const { result: fresh, output } = await captureConsoleDuring(async () => {
    const project = await createProject('Illustrator HFS path normalization');
    return waitForProject(
      project.id,
      item => item.pendingFiles.some(file => file.path === linkedPath),
      5000
    );
  });

  const imgCandidate = fresh.pendingFiles.find(file => file.path === linkedPath);
  assert.ok(imgCandidate);
  assert.equal(imgCandidate.source, 'ai-linked');
  assert.equal(imgCandidate.captureState, 'needs-save');
  assert.equal(imgCandidate.captureReason, 'linked-asset-observed');
  assert.equal(imgCandidate.captureEvidence.captureRecommendation, 'needs-save');
  assert.equal(imgCandidate.captureEvidence.observerMethod, 'illustrator-active-session');
  assert.equal(imgCandidate.captureEvidence.sourceDocumentName, 'Bris Invitation-03 CLEAN QA14.ai');
  assert.equal(fresh.files.some(file => file.path === linkedPath), false);
  assert.ok(output.includes('normalizedPaths='));
  assertTextExcludes(JSON.stringify(fresh.liveEvidenceLedger), [
    hfsSourcePath,
    hfsLinkedPath,
    'DOC\t',
    'LINK\t',
    'stdout',
    'raw',
  ], 'Illustrator HFS live evidence ledger');
});

test('Illustrator live evidence normalizes file URL placed asset paths before staging', async () => {
  resetTestHomeWorkspace();
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'file-url-illustrator.ai');
  const linkedPath = path.join(TEST_HOME, 'Desktop', 'IMG_5331_QA14_FILE_URL.JPG');
  fs.writeFileSync(sourcePath, 'ai bytes');
  fs.writeFileSync(linkedPath, 'jpg bytes');
  const linkedFileUrl = pathToFileURL(linkedPath).href;

  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) {
      return { stdout: '123\n' };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      return {
        stdout: [
          `DOC\t${sourcePath}\tfile-url-illustrator.ai\ttrue\ttrue`,
          `LINK\t${sourcePath}\tfile-url-illustrator.ai\t${linkedFileUrl}\ttrue\ttrue`,
        ].join('\n') + '\n',
      };
    }
    return { stdout: '' };
  });

  const project = await createProject('Illustrator file URL path normalization');
  const fresh = await waitForProject(
    project.id,
    item => item.pendingFiles.some(file => file.path === linkedPath),
    5000
  );

  const imgCandidate = fresh.pendingFiles.find(file => file.path === linkedPath);
  assert.ok(imgCandidate);
  assert.equal(imgCandidate.captureState, 'needs-save');
  assert.equal(imgCandidate.captureEvidence.captureRecommendation, 'needs-save');
  assert.equal(fresh.files.some(file => file.path === linkedPath), false);
  assertTextExcludes(JSON.stringify(fresh.liveEvidenceLedger), [
    linkedFileUrl,
    'file://',
    'DOC\t',
    'LINK\t',
    'stdout',
    'raw',
  ], 'Illustrator file URL live evidence ledger');
});

test('Illustrator live evidence rejects ambiguous placed asset paths safely', async () => {
  resetTestHomeWorkspace();
  let osascriptInvocations = 0;
  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) {
      return { stdout: '123\n' };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      osascriptInvocations++;
      return {
        stdout: [
          'DOC\t\tBris Invitation-03 CLEAN QA14.ai\ttrue\ttrue',
          'LINK\t\tBris Invitation-03 CLEAN QA14.ai\tv2.8.0-qa.14-jenna:test-photos:IMG_5331_QA14_LIVE_ONLY.JPG\ttrue\ttrue',
          'LINK\t\tBris Invitation-03 CLEAN QA14.ai\trelative/IMG_5331_QA14_LIVE_ONLY.JPG\ttrue\ttrue',
        ].join('\n') + '\n',
      };
    }
    return { stdout: '' };
  });

  const { result: fresh, output } = await captureConsoleDuring(async () => {
    const project = await createProject('Illustrator invalid path normalization');
    await waitForProject(project.id, () => osascriptInvocations >= 1, 5000);
    await new Promise(resolve => originalSetTimeout(resolve, 50));
    return getProject(project.id);
  });

  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.pendingFiles, []);
  assert.ok(output.includes('pathSkipped='));
  assertTextExcludes(output, [
    'v2.8.0-qa.14-jenna:test-photos:IMG_5331_QA14_LIVE_ONLY.JPG',
    'relative/IMG_5331_QA14_LIVE_ONLY.JPG',
    'DOC\t',
    'LINK\t',
    'stdout',
    'raw',
  ], 'Illustrator invalid path diagnostics');
  assertTextExcludes(JSON.stringify(fresh.liveEvidenceLedger || {}), [
    'v2.8.0-qa.14-jenna:test-photos:IMG_5331_QA14_LIVE_ONLY.JPG',
    'relative/IMG_5331_QA14_LIVE_ONLY.JPG',
    'IMG_5331_QA14_LIVE_ONLY.JPG',
    'stdout',
    'raw',
  ], 'Illustrator invalid path ledger');
});

test('Illustrator live evidence refresh stages a newly placed linked asset with accepted files present', async () => {
  resetTestHomeWorkspace();
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'refresh-illustrator.ai');
  const unrelatedSourcePath = path.join(TEST_HOME, 'Desktop', 'unrelated-open.ai');
  const existingLinkedPath = path.join(TEST_HOME, 'Desktop', 'existing-linked.png');
  const newLinkedPath = path.join(TEST_HOME, 'Desktop', 'IMG_5331.JPG');
  const unrelatedLinkedPath = path.join(TEST_HOME, 'Desktop', 'unrelated-linked.jpg');
  const outputDir = path.join(TEST_HOME, 'Desktop', 'refresh-package-out');
  fs.writeFileSync(sourcePath, 'ai bytes');
  fs.writeFileSync(unrelatedSourcePath, 'unrelated ai bytes');
  fs.writeFileSync(existingLinkedPath, 'existing linked bytes');
  fs.writeFileSync(newLinkedPath, 'new linked bytes');
  fs.writeFileSync(unrelatedLinkedPath, 'unrelated linked bytes');
  fs.mkdirSync(outputDir, { recursive: true });

  let includeNewLink = false;
  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) {
      return { stdout: '123\n' };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      const lines = [
        `DOC\t${sourcePath}\trefresh-illustrator.ai\ttrue\tfalse`,
        `LINK\t${sourcePath}\trefresh-illustrator.ai\t${existingLinkedPath}\ttrue\tfalse`,
        `DOC\t${unrelatedSourcePath}\tunrelated-open.ai\ttrue\ttrue`,
        `LINK\t${unrelatedSourcePath}\tunrelated-open.ai\t${unrelatedLinkedPath}\ttrue\ttrue`,
      ];
      if (includeNewLink) lines.push(`LINK\t${sourcePath}\trefresh-illustrator.ai\t${newLinkedPath}\ttrue\tfalse`);
      return { stdout: `${lines.join('\n')}\n` };
    }
    return { stdout: '' };
  });

  const project = await createProject('Illustrator refresh active session');
  await setProjectFiles(project.id, {
    files: [
      {
        path: sourcePath,
        name: path.basename(sourcePath),
        ext: '.ai',
        addedAt: Date.now(),
        source: 'manual-browse',
      },
      {
        path: existingLinkedPath,
        name: path.basename(existingLinkedPath),
        ext: '.png',
        addedAt: Date.now(),
        source: 'scan-on-open',
      },
    ],
  });

  await new Promise(resolve => originalSetTimeout(resolve, 900));
  let fresh = await getProject(project.id);
  assert.equal(fresh.pendingFiles.some(file => file.path === newLinkedPath), false);
  assert.equal(fresh.pendingFiles.some(file => file.path === unrelatedLinkedPath), false);
  assert.equal(fresh.files.some(file => file.path === sourcePath), true);
  assert.equal(fresh.files.some(file => file.path === existingLinkedPath), true);

  includeNewLink = true;
  fresh = await waitForProject(
    project.id,
    item => item.pendingFiles.some(file => file.path === newLinkedPath),
    7000
  );

  const imgCandidate = fresh.pendingFiles.find(file => file.path === newLinkedPath);
  assert.ok(imgCandidate);
  assert.equal(imgCandidate.source, 'ai-linked');
  assert.equal(imgCandidate.captureState, 'needs-save');
  assert.equal(imgCandidate.captureReason, 'linked-asset-observed');
  assert.equal(imgCandidate.captureEvidence.captureRecommendation, 'needs-save');
  assert.equal(imgCandidate.captureEvidence.observerMethod, 'illustrator-active-session');
  assert.equal(imgCandidate.captureEvidence.documentModified, true);
  assert.equal(imgCandidate.captureEvidence.sourceDocumentName, 'refresh-illustrator.ai');
  assert.equal(imgCandidate.captureEvidence.relationship, 'source-linked');
  assert.equal(fresh.files.some(file => file.path === newLinkedPath), false);
  assert.equal(fresh.files.some(file => file.path === unrelatedLinkedPath), false);
  assert.equal(fresh.pendingFiles.some(file => file.path === unrelatedLinkedPath), false);

  const sourceLedger = Object.values((fresh.liveEvidenceLedger && fresh.liveEvidenceLedger.candidates) || {})
    .find(entry => entry.latest && entry.latest.candidateName === 'refresh-illustrator.ai');
  assert.ok(sourceLedger);
  assert.equal(sourceLedger.latest.captureRecommendation, 'needs-save');
  assert.equal(sourceLedger.latest.reason, 'unsaved-source-needs-save');

  const result = await callIpc('projects:package', project.id, outputDir);
  assertPackageResultShape(result);
  assert.equal(result.success, true);
  assert.equal(fs.existsSync(path.join(result.folderPath, path.basename(newLinkedPath))), false);
  fresh = await getProject(project.id);
  assert.equal(fresh.pendingFiles.some(file => file.path === newLinkedPath), true);
  assert.equal(fresh.files.some(file => file.path === newLinkedPath), false);
});

test('Illustrator refresh invokes fallback process check and stages pathless source-linked evidence', async () => {
  resetTestHomeWorkspace();
  const linkedPath = path.join(TEST_HOME, 'Desktop', 'IMG_5331.JPG');
  fs.writeFileSync(linkedPath, 'new linked bytes');
  let pgrepProcessChecks = 0;
  let psCommProcessChecks = 0;
  let osascriptInvocations = 0;

  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) {
      pgrepProcessChecks++;
      return { stdout: '' };
    }
    if (isIllustratorPsCommCheck({ kind, command, args })) {
      psCommProcessChecks++;
      return { stdout: '/Applications/Adobe Illustrator 2026/Adobe Illustrator.app/Contents/MacOS/Adobe Illustrator\n' };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      osascriptInvocations++;
      return {
        stdout: `DOC\t\tBris Invitation-03 copy.ai\ttrue\nLINK\t\tBris Invitation-03 copy.ai\t${linkedPath}\ttrue\n`,
      };
    }
    return { stdout: '' };
  });

  const project = await createProject('Illustrator pathless refresh');
  const fresh = await waitForProject(
    project.id,
    item => item.pendingFiles.some(file => file.path === linkedPath),
    5000
  );

  assert.ok(pgrepProcessChecks >= 1);
  assert.ok(psCommProcessChecks >= 1);
  assert.ok(osascriptInvocations >= 1);
  assert.deepEqual(fresh.files, []);
  assert.equal(fresh.pendingFiles.length, 1);
  const imgCandidate = fresh.pendingFiles[0];
  assert.equal(imgCandidate.path, linkedPath);
  assert.equal(imgCandidate.source, 'ai-linked');
  assert.equal(imgCandidate.captureState, 'needs-save');
  assert.equal(imgCandidate.captureReason, 'linked-asset-observed');
  assert.equal(imgCandidate.captureEvidence.captureRecommendation, 'needs-save');
  assert.equal(imgCandidate.captureEvidence.documentModified, true);
  assert.equal(imgCandidate.captureEvidence.sourceDocumentName, 'Bris Invitation-03 copy.ai');
  assert.equal(imgCandidate.captureEvidence.sourceName, 'Bris Invitation-03 copy.ai');
  assert.equal(Object.prototype.hasOwnProperty.call(imgCandidate.captureEvidence, 'relationship'), false);
  assert.equal(fresh.files.some(file => file.path === linkedPath), false);
  assertTextExcludes(JSON.stringify(fresh), [
    '/Applications/Adobe Illustrator 2026',
    'Contents/MacOS',
    'stdout',
    'raw',
  ], 'Illustrator process detection state');
});

test('Illustrator pathless duplicate document names stay conservative', async () => {
  resetTestHomeWorkspace();
  const linkedPath = path.join(TEST_HOME, 'Desktop', 'IMG_5331.JPG');
  const otherLinkedPath = path.join(TEST_HOME, 'Desktop', 'unrelated-duplicate.jpg');
  fs.writeFileSync(linkedPath, 'new linked bytes');
  fs.writeFileSync(otherLinkedPath, 'other linked bytes');
  let osascriptInvocations = 0;

  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) {
      return { stdout: '123\n' };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      osascriptInvocations++;
      return {
        stdout: [
          `DOC\t\tBris Invitation-03 copy.ai\ttrue\tfalse`,
          `LINK\t\tBris Invitation-03 copy.ai\t${linkedPath}\ttrue\tfalse`,
          `DOC\t\tBris Invitation-03 copy.ai\ttrue\tfalse`,
          `LINK\t\tBris Invitation-03 copy.ai\t${otherLinkedPath}\ttrue\tfalse`,
        ].join('\n') + '\n',
      };
    }
    return { stdout: '' };
  });

  const { result: fresh, output } = await captureConsoleDuring(async () => {
    const project = await createProject('Illustrator ambiguous pathless refresh');
    await waitForProject(project.id, () => osascriptInvocations >= 1, 5000);
    await new Promise(resolve => originalSetTimeout(resolve, 50));
    return getProject(project.id);
  });

  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.pendingFiles, []);
  assert.ok(output.includes('ambiguous-document-name'));
  assertTextExcludes(output, [
    linkedPath,
    otherLinkedPath,
    '/Applications/Adobe Illustrator',
    'DOC\t',
    'LINK\t',
    'stdout',
    'raw',
  ], 'Illustrator ambiguous pathless diagnostics');
});

test('Illustrator live evidence Automation failure logs safe guidance without staging raw output', async () => {
  resetTestHomeWorkspace();
  let osascriptInvocations = 0;
  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) {
      return { stdout: '123\n' };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      osascriptInvocations++;
      return {
        stdout: 'ERROR\tautomation-not-authorized\nERROR\t/Users/private/client/SHOULD_NOT_APPEAR.ai\n',
      };
    }
    return { stdout: '' };
  });

  const { result: fresh, output } = await captureConsoleDuring(async () => {
    const project = await createProject('Illustrator TCC failure');
    await waitForProject(project.id, () => osascriptInvocations >= 1, 5000);
    await new Promise(resolve => originalSetTimeout(resolve, 50));
    return getProject(project.id);
  });

  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.pendingFiles, []);
  assert.ok(output.includes('Illustrator evidence unavailable'));
  assert.ok(output.includes('Automation permissions'));
  assert.ok(output.includes('automation-permission-denied'));
  assertTextExcludes(output, [
    '/Users/private',
    'SHOULD_NOT_APPEAR',
    'DOC\t',
    'LINK\t',
    'stdout',
    'raw',
  ], 'Illustrator Automation failure log');
});

test('Illustrator live evidence thrown Automation errors log safe category without raw output', async () => {
  resetTestHomeWorkspace();
  let osascriptInvocations = 0;
  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) {
      return { stdout: '123\n' };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      osascriptInvocations++;
      const error = new Error(
        'Command failed: /usr/bin/osascript /private/var/folders/SHOULD_NOT_APPEAR/crate-ai-active-session.applescript'
      );
      error.stderr = 'Not authorized to send Apple events to Adobe Illustrator. /Users/private/client/SHOULD_NOT_APPEAR.ai';
      return { error };
    }
    return { stdout: '' };
  });

  const { result: fresh, output } = await captureConsoleDuring(async () => {
    const project = await createProject('Illustrator thrown TCC failure');
    await waitForProject(project.id, () => osascriptInvocations >= 1, 5000);
    await new Promise(resolve => originalSetTimeout(resolve, 50));
    return getProject(project.id);
  });

  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.pendingFiles, []);
  assert.ok(output.includes('Illustrator evidence unavailable'));
  assert.ok(output.includes('reason=automation-permission-denied'));
  assert.ok(output.includes('System Settings'));
  assertTextExcludes(output, [
    '/usr/bin/osascript',
    '/private/var',
    '/Users/private',
    'SHOULD_NOT_APPEAR',
    'crate-ai-active-session.applescript',
    'DOC\t',
    'LINK\t',
    'stdout',
    'stderr',
    'raw',
  ], 'Illustrator thrown Automation failure log');
});

test('Illustrator placed item path query failures record safe category without raw output', async () => {
  resetTestHomeWorkspace();
  let osascriptInvocations = 0;
  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) {
      return { stdout: '123\n' };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      osascriptInvocations++;
      const error = new Error(
        'Expected end of line but found identifier file path of pItem /Users/private/client/SHOULD_NOT_APPEAR.ai'
      );
      error.stderr = 'Could not read placed item file path for /Users/private/client/SHOULD_NOT_APPEAR.ai';
      return { error };
    }
    return { stdout: '' };
  });

  const { result: fresh, output } = await captureConsoleDuring(async () => {
    const project = await createProject('Illustrator placed path failure');
    await waitForProject(project.id, () => osascriptInvocations >= 1, 5000);
    await new Promise(resolve => originalSetTimeout(resolve, 50));
    return getProject(project.id);
  });

  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.pendingFiles, []);
  const statusEntries = getLiveAppStatusEntries(fresh);
  assert.ok(statusEntries.some(entry => (
    entry.scriptAttempted === true &&
    entry.scriptSuccess === false &&
    entry.stagedCount === 0 &&
    entry.errorCategory === 'illustrator-placed-item-path-query-failed'
  )));
  assertTextExcludes(JSON.stringify(fresh.liveAppEvidenceStatus), [
    '/Users/private',
    'SHOULD_NOT_APPEAR',
    'file path of pItem',
    'stdout',
    'stderr',
    'raw',
  ], 'Illustrator placed item path query failure status');
  assertTextExcludes(output, [
    '/Users/private',
    'SHOULD_NOT_APPEAR',
    'file path of pItem',
    'stdout',
    'stderr',
    'raw',
  ], 'Illustrator placed item path query failure log');
});

test('Illustrator live evidence missing usage description errors log safe category without raw output', async () => {
  resetTestHomeWorkspace();
  let osascriptInvocations = 0;
  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) {
      return { stdout: '123\n' };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      osascriptInvocations++;
      const error = new Error(
        'Missing NSAppleEventsUsageDescription while running /usr/bin/osascript /private/var/folders/SHOULD_NOT_APPEAR/script.applescript'
      );
      error.stderr = 'Automation usage description failure for /Users/private/client/SHOULD_NOT_APPEAR.ai';
      return { error };
    }
    return { stdout: '' };
  });

  const { result: fresh, output } = await captureConsoleDuring(async () => {
    const project = await createProject('Illustrator missing usage description failure');
    await waitForProject(project.id, () => osascriptInvocations >= 1, 5000);
    await new Promise(resolve => originalSetTimeout(resolve, 50));
    return getProject(project.id);
  });

  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.pendingFiles, []);
  assert.ok(output.includes('Illustrator evidence unavailable'));
  assert.ok(output.includes('script-success=false'));
  assert.ok(output.includes('reason=missing-usage-description'));
  assert.ok(output.includes('Apple Events usage description'));
  const statusEntries = getLiveAppStatusEntries(fresh);
  assert.ok(statusEntries.some(entry => (
    entry.scriptAttempted === true &&
    entry.scriptSuccess === false &&
    entry.stagedCount === 0 &&
    entry.errorCategory === 'missing-usage-description'
  )));
  assertTextExcludes(JSON.stringify(fresh.liveAppEvidenceStatus), [
    '/usr/bin/osascript',
    '/private/var',
    '/Users/private',
    'SHOULD_NOT_APPEAR',
    'script.applescript',
    'DOC\t',
    'LINK\t',
    'stdout',
    'stderr',
    'raw',
  ], 'Illustrator missing usage description status');
  assertTextExcludes(output, [
    '/usr/bin/osascript',
    '/private/var',
    '/Users/private',
    'SHOULD_NOT_APPEAR',
    'script.applescript',
    'DOC\t',
    'LINK\t',
    'stdout',
    'stderr',
    'raw',
  ], 'Illustrator missing usage description failure log');
});

test('strong Illustrator evidence updates an existing weak lsof pending candidate', async () => {
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'reconciled-live-illustrator.ai');
  fs.writeFileSync(sourcePath, 'ai bytes');
  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) {
      return { stdout: '123\n' };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      return { stdout: `DOC\t${sourcePath}\treconciled-live-illustrator.ai\ttrue\n` };
    }
    return { stdout: '' };
  });

  const project = await createProject('Illustrator evidence reconciliation');
  await setProjectFiles(project.id, {
    pendingFiles: [{
      path: sourcePath,
      name: path.basename(sourcePath),
      ext: '.ai',
      addedAt: Date.now(),
      source: 'lsof',
      captureState: 'observed',
      captureReason: 'opened-after-watch',
      captureEvidence: {
        observerMethod: 'lsof',
        evidenceStrength: 'broad-app-signal',
        captureRecommendation: 'observed',
      },
    }],
  });

  const fresh = await waitForProject(
    project.id,
    item => item.pendingFiles.some(file => file.path === sourcePath && file.captureState === 'needs-save'),
    5000
  );
  const candidate = fresh.pendingFiles.find(file => file.path === sourcePath);
  assert.equal(candidate.source, 'app-opened');
  assert.equal(candidate.captureReason, 'unsaved-source-needs-save');
  assert.equal(candidate.captureEvidence.observerMethod, 'illustrator-active-session');
  assert.equal(candidate.captureEvidence.evidenceStrength, 'structured-app-document');
  assert.equal(candidate.captureEvidence.captureRecommendation, 'needs-save');
  assert.equal(fresh.files.some(file => file.path === sourcePath), false);
  const ledgerEntries = Object.values((fresh.liveEvidenceLedger && fresh.liveEvidenceLedger.candidates) || {});
  assert.ok(ledgerEntries.some(entry => (
    entry.latest &&
    entry.latest.candidateName === 'reconciled-live-illustrator.ai' &&
    entry.strongestState === 'needs-save'
  )));
});

test('pending live app evidence is not packaged before acceptance or saved-file confirmation', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Pending Live Package Safety');
    const pendingPath = path.join(tmpRoot, 'live-unsaved-link.jpg');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(pendingPath, 'unsaved linked bytes');
    await setProjectFiles(project.id, {
      files: [],
      pendingFiles: [{
        path: pendingPath,
        name: path.basename(pendingPath),
        ext: '.jpg',
        addedAt: Date.now(),
        source: 'ai-linked',
        captureState: 'needs-save',
        captureReason: 'linked-asset-observed',
        captureEvidence: {
          appFamily: 'illustrator',
          observerMethod: 'illustrator-active-session',
          evidenceStrength: 'structured-app-link',
          captureRecommendation: 'needs-save',
          designerReason: 'Linked asset observed in Illustrator. Save to make package-ready.',
        },
      }],
    });

    const result = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 0);
    assert.equal(result.embeddedCount, 0);
    assert.equal(result.totalFiles, 0);
    assert.deepEqual(result.errors, []);
    if (fs.existsSync(result.folderPath)) {
      assert.equal(fs.existsSync(path.join(result.folderPath, path.basename(pendingPath))), false);
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('repeated ps-poll pending insertion does not duplicate candidates or observations', async () => {
  const filePath = path.join(TEST_HOME, 'Desktop', 'dedupe-ps-poll-logo.ai');
  fs.writeFileSync(filePath, 'ps linked bytes');

  setChildProcessHandler(({ kind, command, args }) => {
    if (kind === 'exec' && command.includes("grep -i 'Adobe Photoshop'")) {
      return { stdout: '789 /Applications/Adobe Photoshop.app/Contents/MacOS/Adobe Photoshop\n' };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ps-poll.applescript')) {
      return { stdout: `${filePath}\n` };
    }
    return { stdout: '' };
  });

  const project = await createProject('PS poll dedupe provenance');
  let fresh = await waitForProject(project.id, item => item.pendingFiles.length === 1);
  assert.equal(getSessionObservedByMethod(fresh, 'ps-poll').length, 0);

  await new Promise(resolve => originalSetTimeout(resolve, 3300));
  fresh = await getProject(project.id);
  assert.equal(fresh.files.filter(file => file.path === filePath).length, 0);
  assert.equal(fresh.pendingFiles.filter(file => file.path === filePath).length, 1);
  assert.equal(getSessionObservedByMethod(fresh, 'ps-poll').length, 0);
});

test('ps-poll provenance failure does not block pending candidate staging', async () => {
  const filePath = path.join(TEST_HOME, 'Desktop', 'failure-ps-poll-logo.ai');
  fs.writeFileSync(filePath, 'ps linked bytes');
  let pollReady = false;

  setChildProcessHandler(({ kind, command, args }) => {
    if (!pollReady) return { stdout: '' };
    if (kind === 'exec' && command.includes("grep -i 'Adobe Photoshop'")) {
      return { stdout: '987 /Applications/Adobe Photoshop.app/Contents/MacOS/Adobe Photoshop\n' };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ps-poll.applescript')) {
      return { stdout: `${filePath}\n` };
    }
    return { stdout: '' };
  });

  const project = await createProject('PS poll provenance failure');
  const storedProject = await getProject(project.id);
  storedProject.provenance.nodes = new Proxy({}, {
    set() {
      throw new Error('forced ps-poll provenance failure');
    },
  });
  pollReady = true;

  const fresh = await waitForProject(project.id, item => item.pendingFiles.length === 1, 5000);
  assert.deepEqual(fresh.files, []);
  assert.equal(fresh.pendingFiles[0].path, filePath);
  assert.equal(fresh.pendingFiles[0].source, 'ps-poll');
});

test('lastused-poll broad discovery outside session scope is quarantined', async () => {
  resetTestHomeWorkspace();
  const filePath = path.join(TEST_HOME, 'Desktop', 'lastused-logo.png');
  fs.writeFileSync(filePath, 'lastused bytes');

  setChildProcessHandler(({ kind, command }) => {
    if (kind === 'exec' && command.startsWith('/bin/ps ax')) {
      return { stdout: '111 /Applications/Figma.app/Contents/MacOS/Figma --token SHOULD_NOT_APPEAR_PROCESS_ARG\n' };
    }
    if (kind === 'exec' && command.startsWith('/usr/sbin/lsof')) {
      return { stdout: '' };
    }
    if (kind === 'execFile' && command === '/usr/bin/mdfind') {
      return { stdout: `${filePath}\n` };
    }
    return { stdout: '' };
  });

  const project = await createProject('Lastused poll provenance');
  let fresh = await waitForProject(
    project.id,
    item => Object.values((item.liveEvidenceLedger && item.liveEvidenceLedger.candidates) || {})
      .some(entry => entry.latest && entry.latest.reason === 'broad-observer-outside-session'),
    12000
  );
  assert.equal(fresh.files.filter(file => file.path === filePath).length, 0);
  assert.equal(fresh.pendingFiles.filter(file => file.path === filePath).length, 0);
  const ignoredEvidence = Object.values((fresh.liveEvidenceLedger && fresh.liveEvidenceLedger.candidates) || {})
    .filter(entry => entry.latest && entry.latest.reason === 'broad-observer-outside-session');
  assert.ok(ignoredEvidence.length >= 1);
  assert.ok(ignoredEvidence.every(entry => entry.latest.quarantined === true));
  assert.ok(ignoredEvidence.every(entry => !Object.prototype.hasOwnProperty.call(entry.latest, 'candidateName')));

  let observations = getSessionObservedByMethod(fresh, 'lastused-poll');
  assert.equal(observations.length, 0);
  assertNoRelationshipEdges(fresh);
  assertProvenanceTextExcludes(fresh, [
    'SHOULD_NOT_APPEAR_PROCESS_ARG',
    '/usr/bin/mdfind',
    'stdout',
  ]);

  await new Promise(resolve => originalSetTimeout(resolve, 10500));
  fresh = await getProject(project.id);
  observations = getSessionObservedByMethod(fresh, 'lastused-poll');
  assert.equal(fresh.files.filter(file => file.path === filePath).length, 0);
  assert.equal(fresh.pendingFiles.filter(file => file.path === filePath).length, 0);
  assert.equal(observations.length, 0);
});

test('session-related broad observer evidence stages pending review without direct-add', async () => {
  resetTestHomeWorkspace();
  const projectRoot = path.join(TEST_HOME, 'Desktop', 'Crate-QA', 'v2.8.0-qa.13-jenna', 'source-copies');
  const sourcePath = path.join(projectRoot, 'current-layout.ai');
  const broadPath = path.join(projectRoot, 'current-layout-reference.ai');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(sourcePath, 'source bytes');
  fs.writeFileSync(broadPath, 'broad bytes');
  let pollReady = false;
  setChildProcessHandler(({ kind, command }) => {
    if (!pollReady) return { stdout: '' };
    if (kind === 'exec' && command.startsWith('/bin/ps ax')) {
      return { stdout: '111 /Applications/Adobe Illustrator.app/Contents/MacOS/Adobe Illustrator --token SHOULD_NOT_APPEAR_PROCESS_ARG\n' };
    }
    if (kind === 'exec' && command.startsWith('/usr/sbin/lsof')) {
      return { stdout: `p111\nf14\ntREG\nn${broadPath}\n` };
    }
    return { stdout: '' };
  });

  const project = await createProject('Session-related broad observer');
  await setProjectFiles(project.id, {
    files: [{
      path: sourcePath,
      name: path.basename(sourcePath),
      ext: '.ai',
      addedAt: Date.now(),
      source: 'manual-browse',
    }],
  });
  pollReady = true;

  const fresh = await waitForProject(
    project.id,
    item => item.pendingFiles.some(file => file.path === broadPath),
    5000
  );
  const candidate = fresh.pendingFiles.find(file => file.path === broadPath);
  assert.ok(candidate);
  assert.equal(candidate.source, 'lsof');
  assert.equal(candidate.captureState, 'observed');
  assert.equal(fresh.files.some(file => file.path === broadPath), false);
  assert.deepEqual(getSessionObservedByMethod(fresh, 'lsof'), []);
  assertProvenanceTextExcludes(fresh, [
    'SHOULD_NOT_APPEAR_PROCESS_ARG',
    '/Applications/Adobe Illustrator.app',
    'stdout',
  ]);
});

test('legacy broad-only accepted files are cleaned while trusted evidence is preserved', async () => {
  resetTestHomeWorkspace();
  const project = await createProject('Legacy broad cleanup');
  const stalePath = path.join(TEST_HOME, 'Downloads', 'old-client-logo.ai');
  const manualPath = path.join(TEST_HOME, 'Desktop', 'current-source.ai');
  const parserPath = path.join(TEST_HOME, 'Desktop', 'linked-logo.png');
  const figmaPath = path.join(TEST_HOME, 'Desktop', 'figma-cloud-asset.png');
  const acceptedBroadPath = path.join(TEST_HOME, 'Desktop', 'accepted-broad.ai');
  for (const filePath of [stalePath, manualPath, parserPath, figmaPath, acceptedBroadPath]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${path.basename(filePath)} bytes`);
  }

  await setProjectFiles(project.id, {
    files: [
      makePendingFile(stalePath, 'lastused-poll'),
      makePendingFile(manualPath, 'manual-browse'),
      makePendingFile(parserPath, 'scan-on-open'),
      {
        ...makePendingFile(figmaPath, 'figma-auto'),
        figmaFileKey: 'file123',
        figmaAssetKey: 'asset456',
      },
      {
        ...makePendingFile(acceptedBroadPath, 'lastused-poll'),
        acceptedPending: true,
      },
    ],
  });

  const fresh = await getProject(project.id);
  assert.equal(fresh.files.some(file => file.path === stalePath), false);
  assert.equal(fresh.pendingFiles.some(file => file.path === stalePath), false);
  assert.equal(fresh.files.some(file => file.path === manualPath), true);
  assert.equal(fresh.files.some(file => file.path === parserPath), true);
  assert.equal(fresh.files.some(file => file.path === figmaPath), true);
  assert.equal(fresh.files.some(file => file.path === acceptedBroadPath && file.acceptedPending === true), true);
});

test('stale broad pending rows from old QA roots are deduped and quarantined', async () => {
  resetTestHomeWorkspace();
  const project = await createProject('Broad pending dedupe cleanup');
  const qa11Path = path.join(TEST_HOME, 'Desktop', 'Crate-QA', 'v2.8.0-qa.11-jenna', 'source-copies', 'Bris Invitation-03 copy.ai');
  const qa12Path = path.join(TEST_HOME, 'Desktop', 'Crate-QA', 'v2.8.0-qa.12-jenna', 'source-copies', 'Bris Invitation-03 copy.ai');
  fs.mkdirSync(path.dirname(qa11Path), { recursive: true });
  fs.mkdirSync(path.dirname(qa12Path), { recursive: true });
  fs.writeFileSync(qa11Path, 'qa11 bytes');
  fs.writeFileSync(qa12Path, 'qa12 bytes');

  await setProjectFiles(project.id, {
    pendingFiles: [
      {
        ...makePendingFile(qa11Path, 'lastused-poll'),
        captureState: 'pending',
        captureReason: 'lastused-broad-observer',
      },
      {
        ...makePendingFile(qa12Path, 'lastused-poll'),
        captureState: 'pending',
        captureReason: 'lastused-broad-observer',
      },
      {
        ...makePendingFile(qa12Path, 'lastused-poll'),
        captureState: 'pending',
        captureReason: 'lastused-broad-observer',
      },
    ],
  });

  const fresh = await getProject(project.id);
  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.pendingFiles, []);
});

test('package-time guard skips broad-only accepted files but keeps parser-confirmed assets', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Broad Package Guard');
    const broadPath = path.join(tmpRoot, 'stale-broad.ai');
    const parserPath = path.join(tmpRoot, 'parser-confirmed.png');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(broadPath, 'broad bytes');
    fs.writeFileSync(parserPath, 'parser bytes');

    await setProjectFiles(project.id, {
      files: [
        makePendingFile(broadPath, 'lastused-poll'),
        makePendingFile(parserPath, 'scan-on-open'),
      ],
    });

    const result = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.totalFiles, 1);
    assert.equal(fs.existsSync(path.join(result.folderPath, path.basename(broadPath))), false);
    assert.equal(fs.existsSync(path.join(result.folderPath, path.basename(parserPath))), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('broad observer quarantine does not block clean Illustrator DOC/LINK live evidence', async () => {
  resetTestHomeWorkspace();
  const qa13Root = path.join(TEST_HOME, 'Desktop', 'Crate-QA', 'v2.8.0-qa.13-jenna');
  const sourcePath = path.join(qa13Root, 'source-copies', 'Bris Invitation-03 copy.ai');
  const linkedPath = path.join(qa13Root, 'test-photos', 'IMG_5331.JPG');
  const staleBroadPath = path.join(TEST_HOME, 'Desktop', 'Crate-QA', 'v2.8.0-qa.12-jenna', 'source-copies', 'Bris Invitation-03 copy.ai');
  for (const filePath of [sourcePath, linkedPath, staleBroadPath]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${path.basename(filePath)} bytes`);
  }

  setChildProcessHandler(({ kind, command, args }) => {
    if (kind === 'execFile' && command === '/bin/ps') {
      return { stdout: '444 /Applications/Adobe Illustrator.app/Contents/MacOS/Adobe Illustrator --secret SHOULD_NOT_APPEAR_PROCESS_ARG\n' };
    }
    if (kind === 'execFile' && command === '/usr/sbin/lsof') {
      return { stdout: `p444\nf14\ntREG\nn${staleBroadPath}\n` };
    }
    if (kind === 'exec' && command.startsWith('/bin/ps ax')) {
      return { stdout: '444 /Applications/Adobe Illustrator.app/Contents/MacOS/Adobe Illustrator --secret SHOULD_NOT_APPEAR_PROCESS_ARG\n' };
    }
    if (kind === 'exec' && command.startsWith('/usr/sbin/lsof')) {
      return { stdout: `p444\nf14\ntREG\nn${staleBroadPath}\n` };
    }
    if (isIllustratorPgrepCheck({ kind, command, args })) {
      return { stdout: '444\n' };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      return {
        stdout: [
          `DOC\t${sourcePath}\tBris Invitation-03 copy.ai\ttrue\tfalse`,
          `LINK\t${sourcePath}\tBris Invitation-03 copy.ai\t${linkedPath}\ttrue\tfalse`,
        ].join('\n') + '\n',
      };
    }
    return { stdout: '' };
  });

  const project = await createProject('Clean Illustrator quarantine regression');
  const fresh = await waitForProject(
    project.id,
    item => item.pendingFiles.some(file => file.path === linkedPath),
    5000
  );

  const imgCandidate = fresh.pendingFiles.find(file => file.path === linkedPath);
  assert.ok(imgCandidate);
  assert.equal(imgCandidate.source, 'ai-linked');
  assert.equal(imgCandidate.captureState, 'needs-save');
  assert.equal(imgCandidate.captureReason, 'linked-asset-observed');
  assert.equal(imgCandidate.captureEvidence.captureRecommendation, 'needs-save');
  assert.equal(imgCandidate.captureEvidence.observerMethod, 'illustrator-active-session');
  assert.equal(imgCandidate.captureEvidence.sourceDocumentName, 'Bris Invitation-03 copy.ai');
  assert.equal(fresh.files.some(file => file.path === linkedPath), false);
  assert.equal(fresh.files.some(file => file.path === staleBroadPath), false);
  assert.equal(fresh.pendingFiles.some(file => file.path === staleBroadPath), false);
  assert.equal(Object.values((fresh.liveEvidenceLedger && fresh.liveEvidenceLedger.candidates) || {})
    .some(entry => entry.latest && entry.latest.reason === 'broad-observer-outside-session'), true);
  assertTextExcludes(JSON.stringify(fresh.liveEvidenceLedger), [
    staleBroadPath,
    'SHOULD_NOT_APPEAR_PROCESS_ARG',
    '/Applications/Adobe Illustrator.app',
    'stdout',
    'raw',
  ], 'clean Illustrator quarantine regression ledger');
});

test('scan-on-open linked accepted insertion records one deduped candidate session observation', async () => {
  resetTestHomeWorkspace();
  const repoTempRoot = path.join(path.resolve(__dirname, '..'), 'test-scan-open-provenance');
  if (!path.resolve(repoTempRoot).startsWith('/Users/')) return;

  try {
    fs.rmSync(repoTempRoot, { recursive: true, force: true });
    fs.mkdirSync(repoTempRoot, { recursive: true });
    const sourcePath = path.join(repoTempRoot, 'layout.ai');
    const linkedPath = path.join(repoTempRoot, 'linked-logo.png');
    fs.writeFileSync(linkedPath, 'linked bytes');
    fs.writeFileSync(sourcePath, `RAW_REGEX_CONTENT_SHOULD_NOT_APPEAR ${linkedPath}`);

    const project = await createProject('Scan open linked provenance');
    await setProjectFiles(project.id, {
      files: [{
        path: sourcePath,
        name: 'layout.ai',
        ext: '.ai',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    await emitWatcher('change', sourcePath);
    let fresh = await waitForProject(
      project.id,
      item => item.files.some(file => file.path === linkedPath && file.source === 'scan-on-open'),
      5000
    );

    let observations = getSessionObservedByMethod(fresh, 'scan-on-open');
    assert.equal(observations.length, 1);
    assert.equal(observations[0].observer.kind, OBSERVER_KINDS.PARSER);
    assert.equal(observations[0].confidence.band, CONFIDENCE_BANDS.CANDIDATE);
    assert.deepEqual(observations[0].payload, {
      source: 'scan-on-open',
      method: 'scan-on-open',
      channel: 'live-scan-on-open',
    });
    assertNoRelationshipEdges(fresh);
    assertProvenanceTextExcludes(fresh, [
      'RAW_REGEX_CONTENT_SHOULD_NOT_APPEAR',
      '/usr/sbin/lsof',
      'stdout',
    ]);

    await emitWatcher('change', sourcePath);
    await new Promise(resolve => originalSetTimeout(resolve, 800));
    fresh = await getProject(project.id);
    observations = getSessionObservedByMethod(fresh, 'scan-on-open');
    assert.equal(fresh.files.filter(file => file.path === linkedPath).length, 1);
    assert.equal(observations.length, 1);
  } finally {
    fs.rmSync(repoTempRoot, { recursive: true, force: true });
  }
});

test('scan-on-open PSD parser accepted linked and embedded insertions record candidate session observations only', async () => {
  resetTestHomeWorkspace();
  const repoTempRoot = path.join(path.resolve(__dirname, '..'), 'test-scan-open-psd-provenance');
  if (!path.resolve(repoTempRoot).startsWith('/Users/')) return;

  try {
    fs.rmSync(repoTempRoot, { recursive: true, force: true });
    fs.mkdirSync(repoTempRoot, { recursive: true });
    const psdPath = path.join(repoTempRoot, 'source.psd');
    const triggerPath = path.join(repoTempRoot, 'trigger-logo.png');
    const linkedPath = path.join(repoTempRoot, 'linked-logo.ai');
    fs.writeFileSync(triggerPath, 'trigger bytes');
    fs.writeFileSync(psdPath, `PSD_RAW_CONTENT_SHOULD_NOT_APPEAR ${triggerPath}`);
    fs.writeFileSync(linkedPath, 'linked bytes');
    currentPsdFixture = {
      children: [{ linkedFile: { fullPath: linkedPath } }],
      linkedFiles: [{ name: 'embedded-logo.png', data: Buffer.from('EMBEDDED_RAW_CONTENT_SHOULD_NOT_APPEAR') }],
    };

    let pollReady = false;
    setChildProcessHandler(({ kind, command }) => {
      if (!pollReady) return { stdout: '' };
      if (kind === 'exec' && command.startsWith('/bin/ps ax')) {
        return { stdout: '333 /Applications/Adobe Photoshop.app/Contents/MacOS/Adobe Photoshop --token SHOULD_NOT_APPEAR_PROCESS_ARG\n' };
      }
      if (kind === 'exec' && command.startsWith('/usr/sbin/lsof')) {
        return { stdout: `p333\nf13\ntREG\nn${psdPath}\n` };
      }
      if (kind === 'exec' && command.includes("grep -i 'Adobe Photoshop'")) {
        return { stdout: '' };
      }
      return { stdout: '' };
    });

    const project = await createProject('Scan open PSD provenance');
    await setProjectFiles(project.id, {
      files: [{
        path: psdPath,
        name: 'source.psd',
        ext: '.psd',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    pollReady = true;
    const fresh = await waitForProject(
      project.id,
      item => item.files.some(file => file.source === 'psd-linked') &&
        item.files.some(file => file.source === 'psd-embedded'),
      5000
    );

    const observations = getSessionObservedByMethod(fresh, 'scan-on-open-psd-parser');
    assert.equal(observations.length, 2);
    assert.deepEqual(observations.map(observation => observation.payload.source).sort(), ['psd-embedded', 'psd-linked']);
    for (const observation of observations) {
      assert.equal(observation.observer.kind, OBSERVER_KINDS.PARSER);
      assert.equal(observation.confidence.band, CONFIDENCE_BANDS.CANDIDATE);
      assert.equal(observation.payload.method, 'scan-on-open-psd-parser');
      assert.equal(observation.payload.channel, 'live-scan-on-open');
      assert.equal(observation.payload.parser, 'ag-psd');
    }
    assertNoRelationshipEdges(fresh);
    assertProvenanceTextExcludes(fresh, [
      'PSD_RAW_CONTENT_SHOULD_NOT_APPEAR',
      'EMBEDDED_RAW_CONTENT_SHOULD_NOT_APPEAR',
      'SHOULD_NOT_APPEAR_PROCESS_ARG',
      '/usr/sbin/lsof',
      'stdout',
    ]);
  } finally {
    fs.rmSync(repoTempRoot, { recursive: true, force: true });
    fs.rmSync(path.join(os.tmpdir(), `crate-psd-extract-dual-write-project-${watcherRecords.length}`), { recursive: true, force: true });
  }
});

test('scan-on-open deduped-away linked candidate does not record session observation', async () => {
  resetTestHomeWorkspace();
  const repoTempRoot = path.join(path.resolve(__dirname, '..'), 'test-scan-open-dedupe-provenance');
  if (!path.resolve(repoTempRoot).startsWith('/Users/')) return;

  try {
    fs.rmSync(repoTempRoot, { recursive: true, force: true });
    fs.mkdirSync(repoTempRoot, { recursive: true });
    const project = await createProject('Scan open dedupe provenance');
    const sourcePath = path.join(repoTempRoot, 'layout.ai');
    const targetPath = path.join(repoTempRoot, 'canonical-logo.png');
    const aliasPath = path.join(repoTempRoot, 'alias-logo.png');
    fs.writeFileSync(sourcePath, `raw content ${aliasPath}`);
    fs.writeFileSync(targetPath, 'canonical bytes');
    fs.symlinkSync(targetPath, aliasPath);
    await setProjectFiles(project.id, {
      files: [
        {
          path: sourcePath,
          name: 'layout.ai',
          ext: '.ai',
          addedAt: Date.now(),
          source: 'manual-browse',
        },
        {
          path: targetPath,
          name: 'canonical-logo.png',
          ext: '.png',
          addedAt: Date.now(),
          source: 'manual-browse',
        },
      ],
    });

    await emitWatcher('change', sourcePath);
    await new Promise(resolve => originalSetTimeout(resolve, 800));

    const fresh = await getProject(project.id);
    assert.equal(fresh.files.some(file => file.path === aliasPath), false);
    assert.equal(getSessionObservedByMethod(fresh, 'scan-on-open').length, 0);
  } finally {
    fs.rmSync(repoTempRoot, { recursive: true, force: true });
  }
});

test('scan-on-open provenance failure does not block accepted ledger insertion', async () => {
  resetTestHomeWorkspace();
  const repoTempRoot = path.join(path.resolve(__dirname, '..'), 'test-scan-open-failure-provenance');
  if (!path.resolve(repoTempRoot).startsWith('/Users/')) return;

  try {
    fs.rmSync(repoTempRoot, { recursive: true, force: true });
    fs.mkdirSync(repoTempRoot, { recursive: true });
    const project = await createProject('Scan open provenance failure');
    const sourcePath = path.join(repoTempRoot, 'layout.ai');
    const linkedPath = path.join(repoTempRoot, 'linked-logo.png');
    fs.writeFileSync(linkedPath, 'linked bytes');
    fs.writeFileSync(sourcePath, `raw content ${linkedPath}`);
    const storedProject = await setProjectFiles(project.id, {
      files: [{
        path: sourcePath,
        name: 'layout.ai',
        ext: '.ai',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    storedProject.provenance.nodes = new Proxy({}, {
      set() {
        throw new Error('forced scan-on-open provenance failure');
      },
    });

    await emitWatcher('change', sourcePath);
    const fresh = await waitForProject(
      project.id,
      item => item.files.some(file => file.path === linkedPath && file.source === 'scan-on-open'),
      3000
    );
    assert.equal(getSessionObservedByMethod(fresh, 'scan-on-open').length, 0);
  } finally {
    fs.rmSync(repoTempRoot, { recursive: true, force: true });
  }
});

test('initial snapshot does not parse linked assets from stale pending source files', async () => {
  resetTestHomeWorkspace();
  const repoTempRoot = path.join(path.resolve(__dirname, '..'), 'test-initial-snapshot-regex-provenance');
  if (!path.resolve(repoTempRoot).startsWith('/Users/')) return;

  try {
    fs.rmSync(repoTempRoot, { recursive: true, force: true });
    fs.mkdirSync(repoTempRoot, { recursive: true });
    const sourcePath = path.join(TEST_HOME, 'Desktop', 'snapshot-layout.ai');
    const linkedPath = path.join(repoTempRoot, 'snapshot-linked.png');
    fs.writeFileSync(linkedPath, 'linked bytes');
    fs.writeFileSync(sourcePath, `SNAPSHOT_REGEX_CONTENT_SHOULD_NOT_APPEAR ${linkedPath}`);

    setChildProcessHandler(({ kind, command }) => {
      if (kind === 'execFile' && command === '/bin/ps') {
        return { stdout: '444 /Applications/Adobe Illustrator.app/Contents/MacOS/Adobe Illustrator --secret SHOULD_NOT_APPEAR_PROCESS_ARG\n' };
      }
      if (kind === 'execFile' && command === '/usr/sbin/lsof') {
        return { stdout: `p444\nf14\ntREG\nn${sourcePath}\n` };
      }
      return { stdout: '' };
    });

    const project = await createProject('Initial snapshot regex provenance');
    const fresh = await getProject(project.id);

    const observations = getSessionObservedByMethod(fresh, 'initial-snapshot-linked-regex');
    assert.deepEqual(fresh.files, []);
    assert.deepEqual(fresh.pendingFiles, []);
    assert.equal(fresh.files.some(file => file.path === linkedPath), false);
    assert.equal(Object.values((fresh.liveEvidenceLedger && fresh.liveEvidenceLedger.candidates) || {})
      .some(entry => entry.latest && entry.latest.reason === 'broad-observer-outside-session'), true);
    assert.equal(observations.length, 0);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_REFERENCES_FILE).length, 0);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 0);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE).length, 0);
    assertProvenanceTextExcludes(fresh, [
      'SNAPSHOT_REGEX_CONTENT_SHOULD_NOT_APPEAR',
      'SHOULD_NOT_APPEAR_PROCESS_ARG',
      '/usr/sbin/lsof',
      'stdout',
    ]);
  } finally {
    fs.rmSync(repoTempRoot, { recursive: true, force: true });
  }
});

test('pre-package lsof package scan quarantines broad candidates outside session scope', async () => {
  resetTestHomeWorkspace();
  const figPath = path.join(TEST_HOME, 'Desktop', 'package-open.fig');
  fs.writeFileSync(figPath, 'fig bytes');
  const project = await createProject('Prepackage lsof provenance');
  const storedProject = await getProject(project.id);
  storedProject.watchStartedAt = Date.now() + 10000;

  setChildProcessHandler(({ kind, command }) => {
    if (kind === 'exec' && command.startsWith('/bin/ps ax -o pid=')) {
      return { stdout: '246 /Applications/Figma.app/Contents/MacOS/Figma\n' };
    }
    if (kind === 'exec' && command.startsWith('/usr/sbin/lsof -F n -p 246')) {
      return { stdout: `n${figPath}\n` };
    }
    return { stdout: '' };
  });

  const scan = await callIpc('projects:pre-package-scan', project.id);
  assert.equal(scan.newCount, 0);

  let fresh = await getProject(project.id);
  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.pendingFiles, []);
  assert.equal(Object.values((fresh.liveEvidenceLedger && fresh.liveEvidenceLedger.candidates) || {})
    .some(entry => entry.latest && entry.latest.reason === 'broad-observer-outside-session'), true);

  const observations = getSessionObservedByMethod(fresh, 'lsof-package-scan');
  assert.equal(observations.length, 0);
  assert.equal(getProvenanceNodes(fresh, NODE_TYPES.APP_PROCESS).length, 0);
  assert.deepEqual(fresh.provenance.edges, {});

  await callIpc('projects:pre-package-scan', project.id);
  fresh = await getProject(project.id);
  assert.deepEqual(fresh.files, []);
  assert.equal(fresh.pendingFiles.filter(file => file.source === 'lsof-package-scan').length, 0);
  assert.equal(getSessionObservedByMethod(fresh, 'lsof-package-scan').length, 0);
});

test('pre-package deduped-away recovery candidate does not record session observation', async () => {
  resetTestHomeWorkspace();
  const project = await createProject('Prepackage deduped candidate');
  const targetPath = path.join(TEST_HOME, 'Desktop', 'canonical.fig');
  const aliasPath = path.join(TEST_HOME, 'Desktop', 'canonical-alias.fig');
  fs.writeFileSync(targetPath, 'fig bytes');
  fs.symlinkSync(targetPath, aliasPath);
  await setProjectFiles(project.id, {
    files: [{
      path: targetPath,
      name: 'canonical.fig',
      ext: '.fig',
      addedAt: Date.now(),
      source: 'manual-browse',
    }],
  });

  setChildProcessHandler(({ kind, command }) => {
    if (kind === 'exec' && command.startsWith('/bin/ps ax -o pid=')) {
      return { stdout: '468 /Applications/Figma.app/Contents/MacOS/Figma\n' };
    }
    if (kind === 'exec' && command.startsWith('/usr/sbin/lsof -F n -p 468')) {
      return { stdout: `n${aliasPath}\n` };
    }
    return { stdout: '' };
  });

  const scan = await callIpc('projects:pre-package-scan', project.id);
  assert.equal(scan.newCount, 0);

  const fresh = await getProject(project.id);
  assert.equal(fresh.files.length, 1);
  assert.equal(fresh.files[0].path, targetPath);
  assert.deepEqual(fresh.pendingFiles, []);
  assert.equal(getSessionObservedByMethod(fresh, 'lsof-package-scan').length, 0);
});

test('package dedupes auto-captured duplicate InDesign masters while preserving used links', async () => {
  resetTestHomeWorkspace();
  const projectName = 'InDesign Master Dedupe';
  const project = await createProject(projectName);
  const now = Date.now();
  const oldRoot = path.join(TEST_HOME, 'Desktop', 'Crate-QA', 'v2.8.0-qa.5-jenna', 'source-copies');
  const currentRoot = path.join(TEST_HOME, 'Desktop', 'Crate-QA', 'v2.8.0-qa.34-jenna', 'source-copies');
  const downloadsRoot = path.join(TEST_HOME, 'Desktop', 'Crate-QA', 'v2.8.0-qa.34-jenna', 'web-downloads');
  const outputDir = path.join(TEST_HOME, 'Desktop', 'Crate-QA', 'v2.8.0-qa.34-jenna', 'package-outputs');
  const masterName = 'Crate InDesign Downloaded Unused QA qa34.indd';
  const oldMasterPath = path.join(oldRoot, masterName);
  const currentMasterPath = path.join(currentRoot, masterName);
  const usedOnePath = path.join(downloadsRoot, 'qa34-used-web-01.jpg');
  const usedTwoPath = path.join(downloadsRoot, 'qa34-used-web-02.jpg');
  const unusedPath = path.join(downloadsRoot, 'qa34-unused-web-03.jpg');

  for (const dirPath of [oldRoot, currentRoot, downloadsRoot, outputDir]) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  fs.writeFileSync(oldMasterPath, 'old false-start InDesign bytes');
  fs.writeFileSync(currentMasterPath, 'current saved InDesign bytes with linked images');
  fs.writeFileSync(usedOnePath, 'used image one');
  fs.writeFileSync(usedTwoPath, 'used image two');
  fs.writeFileSync(unusedPath, 'unused image should stay out');
  const oldDate = new Date(now - 120000);
  const currentDate = new Date(now);
  fs.utimesSync(oldMasterPath, oldDate, oldDate);
  fs.utimesSync(currentMasterPath, currentDate, currentDate);

  const storedProject = await setProjectFiles(project.id, {
    files: [
      {
        path: oldMasterPath,
        name: masterName,
        ext: '.indd',
        addedAt: now - 60000,
        source: 'scan-on-open',
        captureReason: 'scan-on-open-source-relationship',
        captureEvidence: { source: 'scan-on-open', parserConfirmed: true },
      },
      {
        path: currentMasterPath,
        name: masterName,
        ext: '.indd',
        addedAt: now,
        source: 'scan-on-open',
        captureReason: 'scan-on-open-source-relationship',
        captureEvidence: { source: 'scan-on-open', parserConfirmed: true, filesystemSaved: true },
      },
      {
        path: usedOnePath,
        name: path.basename(usedOnePath),
        ext: '.jpg',
        addedAt: now,
        source: 'indd-linked',
        captureReason: 'indesign-linked-asset',
      },
      {
        path: usedTwoPath,
        name: path.basename(usedTwoPath),
        ext: '.jpg',
        addedAt: now,
        source: 'indd-linked',
        captureReason: 'indesign-linked-asset',
      },
    ],
  });
  storedProject.watchStartedAt = now - 30000;

  const result = await callIpc('projects:package', project.id, outputDir);
  assertPackageResultShape(result);
  assert.equal(result.success, true);
  assert.equal(result.totalFiles, 3);
  assert.equal(result.copiedCount, 3);
  assert.deepEqual(result.errors, []);

  const destFolder = packageFolder(outputDir, projectName);
  const outputFileNames = fs.readdirSync(destFolder)
    .filter(fileName => fs.statSync(path.join(destFolder, fileName)).isFile())
    .sort();
  assert.deepEqual(outputFileNames, [
    masterName,
    'qa34-used-web-01.jpg',
    'qa34-used-web-02.jpg',
  ].sort());
  assert.equal(fs.readFileSync(path.join(destFolder, masterName), 'utf8'), 'current saved InDesign bytes with linked images');
  assert.equal(fs.existsSync(path.join(destFolder, 'Crate InDesign Downloaded Unused QA qa34_1.indd')), false);
  assert.equal(fs.existsSync(path.join(destFolder, path.basename(unusedPath))), false);
});

test('package preserves explicitly added same-name source masters', async () => {
  resetTestHomeWorkspace();
  const projectName = 'Manual Same Name Sources';
  const project = await createProject(projectName);
  const firstRoot = path.join(TEST_HOME, 'Desktop', 'Client A');
  const secondRoot = path.join(TEST_HOME, 'Desktop', 'Client B');
  const outputDir = path.join(TEST_HOME, 'Desktop', 'manual-output');
  const masterName = 'Layout.indd';
  const firstPath = path.join(firstRoot, masterName);
  const secondPath = path.join(secondRoot, masterName);

  for (const dirPath of [firstRoot, secondRoot, outputDir]) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  fs.writeFileSync(firstPath, 'manual source one');
  fs.writeFileSync(secondPath, 'manual source two');

  await setProjectFiles(project.id, {
    files: [
      {
        path: firstPath,
        name: masterName,
        ext: '.indd',
        addedAt: Date.now(),
        source: 'manual-browse',
      },
      {
        path: secondPath,
        name: masterName,
        ext: '.indd',
        addedAt: Date.now(),
        source: 'manual-browse',
      },
    ],
  });

  const result = await callIpc('projects:package', project.id, outputDir);
  assertPackageResultShape(result);
  assert.equal(result.success, true);
  assert.equal(result.totalFiles, 2);
  assert.equal(result.copiedCount, 2);
  assert.deepEqual(result.errors, []);

  const destFolder = packageFolder(outputDir, projectName);
  assert.equal(fs.readFileSync(path.join(destFolder, 'Layout.indd'), 'utf8'), 'manual source one');
  assert.equal(fs.readFileSync(path.join(destFolder, 'Layout_1.indd'), 'utf8'), 'manual source two');
});

test('pre-package app-script parser and regex recovered additions record session observations without package count drift', async () => {
  resetTestHomeWorkspace();
  const repoTempRoot = path.join(path.resolve(__dirname, '..'), '.test-prepackage-provenance');
  if (!path.resolve(repoTempRoot).startsWith('/Users/')) return;
  const tmpRoot = makeTempDir();
  let project = null;

  try {
    fs.rmSync(repoTempRoot, { recursive: true, force: true });
    fs.mkdirSync(repoTempRoot, { recursive: true });
    const userPathRoot = fs.mkdtempSync(path.join(repoTempRoot, 'case-'));
    project = await createProject('Prepackage Recovery Provenance');
    const aiPath = path.join(userPathRoot, 'layout.ai');
    const psdPath = path.join(tmpRoot, 'source.psd');
    const scriptLinkedPath = path.join(tmpRoot, 'script-linked.png');
    const regexLinkedPath = path.join(userPathRoot, 'regex-linked.png');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);

    fs.writeFileSync(scriptLinkedPath, 'script linked bytes');
    fs.writeFileSync(regexLinkedPath, 'regex linked bytes');
    fs.writeFileSync(aiPath, `ai bytes ${regexLinkedPath}`);
    fs.writeFileSync(psdPath, 'psd bytes');
    currentPsdFixture = {
      children: [],
      linkedFiles: [{ name: 'parser-embedded.png', data: Buffer.from('parser embedded bytes') }],
    };
    await setProjectFiles(project.id, {
      files: [
        {
          path: aiPath,
          name: 'layout.ai',
          ext: '.ai',
          addedAt: Date.now(),
          source: 'manual-browse',
        },
        {
          path: psdPath,
          name: 'source.psd',
          ext: '.psd',
          addedAt: Date.now(),
          source: 'manual-browse',
        },
      ],
    });

    setChildProcessHandler(({ kind, command, args, commandText }) => {
      if (kind === 'exec' && command.includes("grep -i 'Adobe Illustrator'")) {
        return { stdout: '/Applications/Adobe Illustrator.app/Contents/MacOS/Adobe Illustrator\n' };
      }
      if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-scan.applescript')) {
        assertPrivateTempScriptPath(args[0]);
        assert.equal(commandText.includes('tell application'), false);
        return { stdout: `${scriptLinkedPath}\n` };
      }
      return { stdout: '' };
    });

    const scan = await callIpc('projects:pre-package-scan', project.id);
    assert.equal(scan.newCount, 3);

    let fresh = await getProject(project.id);
    assert.equal(fresh.files.some(file => file.source === 'ai-linked'), false);
    assert.equal(fresh.pendingFiles.some(file => file.source === 'ai-linked'), true);
    assert.equal(fresh.files.some(file => file.source === 'psd-embedded'), true);
    assert.equal(fresh.files.some(file => file.source === 'linked-asset'), true);

    for (const method of ['psd-embedded', 'linked-asset']) {
      const observations = getSessionObservedByMethod(fresh, method);
      assert.equal(observations.length, 1);
      assert.equal(observations[0].observer.kind, OBSERVER_KINDS.PACKAGE_RECOVERY);
      assert.equal(Object.prototype.hasOwnProperty.call(observations[0].observer, 'payload'), false);
      assert.equal(observations[0].confidence.band, CONFIDENCE_BANDS.CANDIDATE);
      assert.equal(observations[0].payload.method, method);
      assert.equal(observations[0].payload.channel, 'pre-package-scan');
    }
    assert.equal(getSessionObservedByMethod(fresh, 'ai-linked').length, 0);

    const packageResult = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(packageResult);
    assert.equal(packageResult.success, true);
    assert.equal(packageResult.totalFiles, fresh.files.length);
    assert.equal(packageResult.copiedCount, fresh.files.length);
    assert.equal(packageResult.embeddedCount, 0);
    assert.deepEqual(packageResult.errors, []);

    fresh = await getProject(project.id);
    for (const method of ['psd-embedded', 'linked-asset']) {
      assert.equal(getSessionObservedByMethod(fresh, method).length, 1);
    }
    assert.equal(getSessionObservedByMethod(fresh, 'ai-linked').length, 0);
  } finally {
    fs.rmSync(path.join(os.tmpdir(), `crate-psd-extract-${project ? project.id : ''}`), { recursive: true, force: true });
    fs.rmSync(repoTempRoot, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('pre-package recovery provenance failure does not block broad candidate quarantine', async () => {
  resetTestHomeWorkspace();
  const figPath = path.join(TEST_HOME, 'Desktop', 'failure-open.fig');
  fs.writeFileSync(figPath, 'fig bytes');
  const project = await createProject('Prepackage provenance failure');
  const storedProject = await getProject(project.id);
  storedProject.watchStartedAt = Date.now() + 10000;
  storedProject.provenance.nodes = new Proxy({}, {
    set() {
      throw new Error('forced pre-package provenance failure');
    },
  });

  setChildProcessHandler(({ kind, command }) => {
    if (kind === 'exec' && command.startsWith('/bin/ps ax -o pid=')) {
      return { stdout: '357 /Applications/Figma.app/Contents/MacOS/Figma\n' };
    }
    if (kind === 'exec' && command.startsWith('/usr/sbin/lsof -F n -p 357')) {
      return { stdout: `n${figPath}\n` };
    }
    return { stdout: '' };
  });

  const scan = await callIpc('projects:pre-package-scan', project.id);
  assert.equal(scan.newCount, 0);

  const fresh = await getProject(project.id);
  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.pendingFiles, []);
  assert.equal(Object.values((fresh.liveEvidenceLedger && fresh.liveEvidenceLedger.candidates) || {})
    .some(entry => entry.latest && entry.latest.reason === 'broad-observer-outside-session'), true);
});

test('pre-package pending candidates do not create captured-file observations until accepted', async () => {
  resetTestHomeWorkspace();
  const project = await createProject('Prepackage pending provenance');
  const storedProject = await getProject(project.id);
  storedProject.watchStartedAt = Date.now() - 10000;
  const figmaSupportDir = path.join(TEST_HOME, 'Library', 'Application Support', 'Figma');
  fs.mkdirSync(figmaSupportDir, { recursive: true });
  const figPath = path.join(figmaSupportDir, 'pending-candidate.fig');
  fs.writeFileSync(figPath, 'fig bytes');

  const scan = await callIpc('projects:pre-package-scan', project.id);
  assert.equal(scan.newCount, 1);

  const fresh = await getProject(project.id);
  assert.deepEqual(fresh.files, []);
  assert.equal(fresh.pendingFiles.length, 1);
  assert.equal(fresh.pendingFiles[0].source, 'fig-scan');
  assert.deepEqual(getProvenanceObservations(fresh, EDGE_TYPES.SESSION_OBSERVED_FILE), []);
});

test('pre-package local Figma recovery ignores generated package folders', async () => {
  resetTestHomeWorkspace();
  setChildProcessHandler(() => ({ stdout: '' }));
  const project = await createProject('Prepackage Figma package output exclusion');
  const figPath = path.join(
    TEST_HOME,
    'Desktop',
    'Presentation1_2026-06-07',
    'old-export.fig'
  );
  fs.mkdirSync(path.dirname(figPath), { recursive: true });
  fs.writeFileSync(figPath, 'old fig package output bytes');

  const scan = await callIpc('projects:pre-package-scan', project.id);
  assert.equal(scan.newCount, 0);

  const fresh = await getProject(project.id);
  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.pendingFiles, []);
  assert.deepEqual(getProvenanceObservations(fresh, EDGE_TYPES.SESSION_OBSERVED_FILE), []);
});

test('PSD scan-on-save linked asset preserves ledger entry and records one parser reference edge', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('PSD linked parser provenance');
    const psdPath = path.join(tmpRoot, 'source.psd');
    const linkedPath = path.join(tmpRoot, 'linked-logo.ai');
    fs.writeFileSync(psdPath, 'psd bytes');
    fs.writeFileSync(linkedPath, 'linked bytes');
    await setProjectFiles(project.id, {
      files: [{
        path: psdPath,
        name: 'source.psd',
        ext: '.psd',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    currentPsdFixture = {
      children: [{ linkedFile: { fullPath: linkedPath } }],
      linkedFiles: [],
    };

    await emitWatcher('change', psdPath);
    let fresh = await waitForProject(project.id, item => item.files.length === 2);

    const linkedEntry = fresh.files.find(file => file.path === linkedPath);
    assert.ok(linkedEntry);
    assert.equal(linkedEntry.name, 'linked-logo.ai');
    assert.equal(linkedEntry.ext, '.ai');
    assert.equal(linkedEntry.source, 'scan-on-save-linked');
    assertPsdParserEdge(
      fresh,
      EDGE_TYPES.CONTAINER_REFERENCES_FILE,
      NODE_TYPES.FILE,
      'scan-on-save-linked'
    );

    await emitWatcher('change', psdPath);
    await new Promise(resolve => originalSetTimeout(resolve, 2300));
    fresh = await getProject(project.id);
    assert.equal(fresh.files.filter(file => file.path === linkedPath).length, 1);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_REFERENCES_FILE).length, 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('PSD scan-on-save embedded asset preserves ledger entry and records one parser embed edge', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('PSD embedded parser provenance');
    const psdPath = path.join(tmpRoot, 'source.psd');
    fs.writeFileSync(psdPath, 'psd bytes');
    await setProjectFiles(project.id, {
      files: [{
        path: psdPath,
        name: 'source.psd',
        ext: '.psd',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    currentPsdFixture = {
      children: [],
      linkedFiles: [{ name: 'embedded-logo.png', data: Buffer.from('embedded bytes') }],
    };

    await emitWatcher('change', psdPath);
    let fresh = await waitForProject(
      project.id,
      item => item.files.some(file => file.source === 'scan-on-save-embedded')
    );

    const embeddedEntry = fresh.files.find(file => file.source === 'scan-on-save-embedded');
    assert.ok(embeddedEntry);
    assert.equal(embeddedEntry.path, psdPath);
    assert.equal(embeddedEntry.name, 'embedded-logo.png');
    assert.equal(embeddedEntry.ext, '.png');
    assert.equal(embeddedEntry.embedded, true);
    assert.equal(embeddedEntry.parentPsd, psdPath);
    assert.equal(embeddedEntry.embeddedOriginalName, 'embedded-logo.png');
    assert.equal(embeddedEntry.embeddedIndex, 0);
    assertPsdParserEdge(
      fresh,
      EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE,
      NODE_TYPES.EMBEDDED_RESOURCE,
      'scan-on-save-embedded'
    );

    await emitWatcher('change', psdPath);
    await new Promise(resolve => originalSetTimeout(resolve, 2300));
    fresh = await getProject(project.id);
    assert.equal(fresh.files.filter(file => file.source === 'scan-on-save-embedded').length, 1);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('PSD scan-on-save missing linked asset does not record parser relationship edge', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('PSD missing linked parser provenance');
    const psdPath = path.join(tmpRoot, 'source.psd');
    const missingLinkedPath = path.join(tmpRoot, 'missing-logo.ai');
    fs.writeFileSync(psdPath, 'psd bytes');
    await setProjectFiles(project.id, {
      files: [{
        path: psdPath,
        name: 'source.psd',
        ext: '.psd',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    currentPsdFixture = {
      children: [{ linkedFile: { fullPath: missingLinkedPath } }],
      linkedFiles: [],
    };

    await emitWatcher('change', psdPath);
    await new Promise(resolve => originalSetTimeout(resolve, 2300));

    const fresh = await getProject(project.id);
    assert.equal(fresh.files.length, 1);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_REFERENCES_FILE).length, 0);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 0);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('PSD parser provenance failure does not block scan-on-save capture', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('PSD parser provenance failure');
    const psdPath = path.join(tmpRoot, 'source.psd');
    const linkedPath = path.join(tmpRoot, 'linked-logo.ai');
    fs.writeFileSync(psdPath, 'psd bytes');
    fs.writeFileSync(linkedPath, 'linked bytes');
    const storedProject = await setProjectFiles(project.id, {
      files: [{
        path: psdPath,
        name: 'source.psd',
        ext: '.psd',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    storedProject.provenance.nodes = new Proxy({}, {
      set() {
        throw new Error('forced PSD parser provenance failure');
      },
    });
    currentPsdFixture = {
      children: [{ linkedFile: { fullPath: linkedPath } }],
      linkedFiles: [],
    };

    await emitWatcher('change', psdPath);
    const fresh = await waitForProject(project.id, item => item.files.length === 2);

    const linkedEntry = fresh.files.find(file => file.path === linkedPath);
    assert.ok(linkedEntry);
    assert.equal(linkedEntry.source, 'scan-on-save-linked');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
