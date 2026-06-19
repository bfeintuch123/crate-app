// Phase 2 — Figma Link Per-Project tests.
// Loads main.js with stubbed Electron / electron-store / chokidar / ag-psd /
// node-fetch / uuid so we can exercise the IPC handlers in isolation. The
// real Figma URL/scope parsing helpers are reused.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify: nodePromisify } = require('util');
const {
  EDGE_TYPES,
  NODE_TYPES,
  PROVENANCE_SCHEMA_VERSION,
} = require('../provenance');

// Track timers created by main.js so each test can prove it exits cleanly.
const originalSetInterval = global.setInterval;
const originalClearInterval = global.clearInterval;
const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;
const originalHomedir = os.homedir;
const TEST_HOME = path.join(os.tmpdir(), 'crate-figma-provenance-test-home');
const activeIntervals = new Set();
const activeTimeouts = new Set();

fs.rmSync(TEST_HOME, { recursive: true, force: true });
fs.mkdirSync(TEST_HOME, { recursive: true });
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

function clearTrackedTimers() {
  for (const timer of [...activeIntervals]) {
    global.clearInterval(timer);
  }
  for (const timer of [...activeTimeouts]) {
    global.clearTimeout(timer);
  }
}

// ---------- Module stub plumbing ----------
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
    const factory = STUBS.get(request);
    return factory();
  }
  return originalLoad.call(this, request, parent, ...rest);
};

// ---------- IPC + Store + Electron stubs ----------
const ipcHandlers = new Map();
const electronStub = {
  app: {
    requestSingleInstanceLock: () => true,
    quit: () => {},
    whenReady: () => ({ then: () => {} }),
    on: () => {},
    getPath: () => path.join(__dirname, '..', '.test-userdata'),
    dock: { setMenu: () => {} },
  },
  BrowserWindow: class { constructor() {} on() {} loadFile() {} setPosition() {} show() {} focus() {} isDestroyed() { return true; } webContents = { send: () => {} } },
  Tray: class { constructor() {} on() {} setToolTip() {} isDestroyed() { return true; } destroy() {} },
  ipcMain: {
    handle(channel, fn) { ipcHandlers.set(channel, fn); },
  },
  dialog: { showOpenDialog: async () => ({ canceled: true }), showSaveDialog: async () => ({ canceled: true }) },
  shell: { openPath: () => {} },
  nativeImage: { createFromPath: () => ({ resize: () => ({}) }), createEmpty: () => ({}) },
  Notification: class { static isSupported() { return false; } constructor() {} show() {} },
  Menu: { buildFromTemplate: () => ({}) },
};
setStub('electron', () => electronStub);

// In-memory electron-store double.
class FakeStore {
  constructor(opts = {}) { this.data = JSON.parse(JSON.stringify(opts.defaults || {})); }
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
    if (typeof key === 'object') { Object.assign(this.data, key); return; }
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

// chokidar — never actually watch.
setStub('chokidar', () => ({ watch: () => ({ on: () => {}, close: () => {}, add: () => {}, unwatch: () => {} }) }));

// ag-psd — not exercised in these tests.
setStub('ag-psd', () => ({ readPsd: () => ({}) }));

// child_process — watcher probes are outside this test's scope.
function createChildProcessStub() {
  return {
    on: () => {},
    kill: () => {},
    stdout: { on: () => {} },
    stderr: { on: () => {} },
  };
}

function getCallback(args) {
  return args.find(arg => typeof arg === 'function');
}

function execStub(...args) {
  const callback = getCallback(args);
  if (callback) queueMicrotask(() => callback(null, '', ''));
  return createChildProcessStub();
}
execStub[nodePromisify.custom] = async () => ({ stdout: '', stderr: '' });

function execFileStub(...args) {
  const callback = getCallback(args);
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

let fetchHandler = async () => ({ ok: false, status: 500, json: async () => ({}) });
setStub('node-fetch', () => (...args) => fetchHandler(...args));

// Figma parser — keep the real URL/scope parsing helpers, but make auth and
// polling deterministic instead of depending on the developer machine.
const { FigmaParser: RealFigmaParser } = require('../parsers/figma');
let storedFigmaToken = null;
let nextFigmaScanResult = null;
let lastFigmaScanOptions = null;
let figmaScanInvocationCount = 0;
let figmaScanDelayMs = 0;
class TestFigmaParser extends RealFigmaParser {
  async getStoredToken() {
    return storedFigmaToken;
  }

  async storeToken(token) {
    if (!token || typeof token !== 'string') return false;
    storedFigmaToken = token;
    return true;
  }

  async deleteToken() {
    const hadToken = !!storedFigmaToken;
    storedFigmaToken = null;
    return hadToken;
  }

  async autoTrackScan(options = {}) {
    figmaScanInvocationCount += 1;
    lastFigmaScanOptions = JSON.parse(JSON.stringify(options));
    if (figmaScanDelayMs > 0) {
      await new Promise(resolve => originalSetTimeout(resolve, figmaScanDelayMs));
    }
    return JSON.parse(JSON.stringify(nextFigmaScanResult || {
      files: [],
      assets: [],
      errors: [],
      warnings: [],
      scopeEntries: [],
    }));
  }
}
setStub('./parsers/figma', () => ({ FigmaParser: TestFigmaParser }));

// Deterministic uuid.
let uuidCounter = 0;
setStub('uuid', () => ({ v4: () => `test-uuid-${++uuidCounter}` }));

// canvas/keytar are pulled by parsers but absent from node_modules. The figma
// parser already wraps them in try/catch, so leave them un-stubbed.

// ---------- Load main.js with stubs in place ----------
const mainPath = path.resolve(__dirname, '..', 'main.js');
require(mainPath);

// ---------- Helpers ----------
function getStore() {
  // main.js calls `new Store({ defaults: {...} })` once at import time.
  // We don't have a direct handle, so route through the IPC handlers.
  return null;
}

async function callIpc(channel, ...args) {
  const fn = ipcHandlers.get(channel);
  if (!fn) throw new Error(`No IPC handler registered for ${channel}`);
  // mimic the shape Electron passes (event, ...args)
  return fn({}, ...args);
}

async function getActiveFigmaPollerCount() {
  const status = await callIpc('figma:status');
  return status.activePollerCount || 0;
}

async function waitForActiveFigmaPollerCount(expected) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const actual = await getActiveFigmaPollerCount();
    if (actual === expected) return;
    await new Promise(resolve => originalSetTimeout(resolve, 10));
  }
  assert.equal(await getActiveFigmaPollerCount(), expected);
}

async function resetProjects() {
  const projects = await callIpc('projects:get-all');
  for (const project of [...projects]) {
    await callIpc('projects:delete', project.id);
  }
}

async function cleanupProjectsAndTimers() {
  storedFigmaToken = null;
  nextFigmaScanResult = null;
  lastFigmaScanOptions = null;
  figmaScanInvocationCount = 0;
  figmaScanDelayMs = 0;
  fetchHandler = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await callIpc('settings:update', 'includeDiagnosticReport', false);
  await callIpc('projects:delete-all');
  clearTrackedTimers();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  fs.mkdirSync(TEST_HOME, { recursive: true });
}

test.afterEach(cleanupProjectsAndTimers);
test.after(() => {
  clearTrackedTimers();
  global.setInterval = originalSetInterval;
  global.clearInterval = originalClearInterval;
  global.setTimeout = originalSetTimeout;
  global.clearTimeout = originalClearTimeout;
  os.homedir = originalHomedir;
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

async function waitForProject(projectId, predicate, message) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const project = (await callIpc('projects:get-all')).find(p => p.id === projectId);
    if (project && predicate(project)) return project;
    await new Promise(resolve => originalSetTimeout(resolve, 10));
  }
  const project = (await callIpc('projects:get-all')).find(p => p.id === projectId);
  assert.ok(project && predicate(project), message);
  return project;
}

function getProvenanceEdges(project, relationType) {
  return Object.values((project.provenance && project.provenance.edges) || {})
    .filter(edge => edge && edge.relationType === relationType);
}

function getProvenanceNodes(project, type) {
  return Object.values((project.provenance && project.provenance.nodes) || {})
    .filter(node => node && node.type === type);
}

function setFigmaDownloadResponse(body = 'figma asset bytes') {
  fetchHandler = async () => ({
    ok: true,
    status: 200,
    buffer: async () => Buffer.from(body),
    json: async () => ({}),
  });
}

function setDelayedFigmaDownloadResponse(body = 'figma asset bytes', delayMs = 50) {
  let startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  fetchHandler = async () => {
    if (startedResolve) {
      startedResolve();
      startedResolve = null;
    }
    return new Promise(resolve => {
      originalSetTimeout(() => resolve({
        ok: true,
        status: 200,
        buffer: async () => Buffer.from(body),
        json: async () => ({}),
      }), delayMs);
    });
  };
  return started;
}

function modeOf(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}

function figmaScanResult(assets, scopeEntries = []) {
  return {
    files: [{ key: 'FIG22', name: 'Brand Cloud', isTracked: true }],
    assets,
    errors: [],
    warnings: [],
    scopeEntries,
  };
}

function figmaRateLimitedScanResult() {
  return {
    files: [{ key: 'FIG22', name: 'Brand Cloud', isTracked: true }],
    assets: [],
    errors: [],
    warnings: [],
    scopeEntries: [{
      fileKey: 'FIG22',
      fileName: 'Brand Cloud',
      scopeMode: 'current-page',
      lockStatus: 'unresolved',
      lockedPageId: null,
      lockedPageName: null,
      statusReason: 'figma-current-page-file-fetch-failed',
      warning: 'Current Page Only could not read the tracked Figma file. No Figma assets will be captured for this file in this session.',
      fileFetchStatus: 'failed',
      fileFetchFailureReason: 'rate-limited',
    }],
    candidateDiagnostics: {
      candidateCount: 1,
      candidateStrategyCounts: { primary: 1 },
      candidateSourceCounts: { 'direct-route': 1 },
      parsedScopeCounts: { withPageOrNode: 1, withoutPageOrNode: 0 },
      metadataStatusCounts: { failed: 1 },
      metadataFailureReasonCounts: { 'rate-limited': 1 },
      fileFetchStatusCounts: { failed: 1 },
      fileFetchFailureReasonCounts: { 'rate-limited': 1 },
      lockStatusCounts: { unresolved: 1 },
      statusReasonCounts: { 'figma-current-page-file-fetch-failed': 1 },
      assetResultCounts: { withAssets: 0, withoutAssets: 1 },
    },
  };
}

async function createLinkedFigmaProject(name = 'Figma Provenance') {
  const project = await callIpc(
    'projects:create',
    name,
    'branding',
    'current-page',
    'https://www.figma.com/file/FIG22/Brand-Cloud?page-id=1%3A1'
  );
  await new Promise(resolve => originalSetTimeout(resolve, 20));
  storedFigmaToken = 'test-token';
  return project;
}

async function rebuildFigmaSessionViaScan(projectId) {
  storedFigmaToken = 'test-token';
  nextFigmaScanResult = figmaScanResult([], []);
  const scan = await callIpc('figma:scan-project', projectId);
  assert.equal(scan.success, true);
  return (await callIpc('projects:get-all')).find(p => p.id === projectId);
}

async function addFigmaAutoFileToProject(projectId, filePath, overrides = {}) {
  const project = (await callIpc('projects:get-all')).find(p => p.id === projectId);
  assert.ok(project, 'project should exist');
  const file = {
    id: `figma-auto-${project.files.length + 1}`,
    path: filePath,
    name: path.basename(filePath),
    ext: path.extname(filePath).toLowerCase(),
    addedAt: Date.now(),
    source: 'figma-auto',
    figmaFileKey: 'FIG22',
    figmaFileName: 'Brand Cloud',
    figmaPageId: '1:1',
    figmaPageName: 'Page One',
    figmaScopeMode: 'current-page',
    ...overrides,
  };
  project.files.push(file);
  return file;
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

async function captureConsole(fn) {
  const messages = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const capture = (...args) => messages.push(args.map(arg => String(arg)).join(' '));
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  try {
    return {
      result: await fn(),
      output: messages.join('\n'),
    };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

// ---------- Tests ----------

test('projects:create with a Figma URL stores per-project tracked file', async () => {
  const activePollersBefore = await getActiveFigmaPollerCount();
  const url = 'https://www.figma.com/file/ABC123/My-File?page-id=1%3A1';
  const project = await callIpc(
    'projects:create',
    'Phase2-create-with-url',
    'branding',
    'current-page',
    url
  );

  assert.ok(project && project.id, 'project should be created');
  assert.ok(Array.isArray(project.figmaTrackedFiles), 'figmaTrackedFiles should be an array');
  assert.equal(project.figmaTrackedFiles.length, 1);
  assert.equal(project.figmaTrackedFiles[0].key, 'ABC123');
  assert.equal(project.figmaTrackedFiles[0].url, url);
  assert.equal(project.figmaScopeMode, 'current-page');
  assert.equal(project.provenance.schemaVersion, PROVENANCE_SCHEMA_VERSION);
  assert.deepEqual(project.provenance.observations, []);

  // Snapshot is built on startWatching — confirm the tracked file shows up there too.
  const fresh = (await callIpc('projects:get-all')).find(p => p.id === project.id);
  assert.ok(fresh.figmaSession, 'figmaSession should be populated');
  assert.equal(fresh.provenance.schemaVersion, PROVENANCE_SCHEMA_VERSION);
  assert.equal(fresh.figmaSession.trackedFiles.length, 1);
  assert.equal(fresh.figmaSession.trackedFiles[0].key, 'ABC123');
  assert.equal(await getActiveFigmaPollerCount(), activePollersBefore);
});

test('projects:create without a Figma URL leaves figmaTrackedFiles empty', async () => {
  const activePollersBefore = await getActiveFigmaPollerCount();
  const project = await callIpc(
    'projects:create',
    'Phase2-create-without-url',
    'branding',
    'current-page',
    null
  );

  assert.ok(project && project.id, 'project should be created');
  assert.deepEqual(project.figmaTrackedFiles, []);

  const fresh = (await callIpc('projects:get-all')).find(p => p.id === project.id);
  assert.equal(fresh.figmaSession.trackedFiles.length, 0);
  assert.equal(await getActiveFigmaPollerCount(), activePollersBefore);
});

test('projects:create rejects an invalid Figma URL', async () => {
  const result = await callIpc(
    'projects:create',
    'Phase2-create-invalid-url',
    'branding',
    'current-page',
    'not-a-figma-url'
  );

  assert.deepEqual(result, { error: 'invalid_figma_url' });

  // Project must NOT have been created.
  const projects = await callIpc('projects:get-all');
  assert.ok(!projects.some(p => p.name === 'Phase2-create-invalid-url'));
});

test('projects:set-figma-link clears the link when url is empty', async () => {
  const activePollersBefore = await getActiveFigmaPollerCount();
  const project = await callIpc(
    'projects:create',
    'Phase2-clear-link',
    'branding',
    'current-page',
    'https://www.figma.com/file/CLEARME/My-File'
  );
  assert.equal(project.figmaTrackedFiles.length, 1);
  assert.equal(await getActiveFigmaPollerCount(), activePollersBefore);

  const cleared = await callIpc('projects:set-figma-link', project.id, { url: '', scopeMode: 'current-page' });
  assert.equal(cleared.success, true);

  const fresh = (await callIpc('projects:get-all')).find(p => p.id === project.id);
  assert.deepEqual(fresh.figmaTrackedFiles, []);
  assert.equal(fresh.figmaSession.trackedFiles.length, 0);
  assert.equal(await getActiveFigmaPollerCount(), activePollersBefore);
});

test('projects:set-figma-link rebuilds figmaSession from the new url', async () => {
  const activePollersBefore = await getActiveFigmaPollerCount();
  const project = await callIpc(
    'projects:create',
    'Phase2-rebuild-session',
    'branding',
    'current-page',
    null
  );
  assert.equal(project.figmaTrackedFiles.length, 0);
  assert.equal(await getActiveFigmaPollerCount(), activePollersBefore);

  const newUrl = 'https://www.figma.com/file/REBUILD9/Rebuilt-File?page-id=2%3A2';
  const result = await callIpc('projects:set-figma-link', project.id, {
    url: newUrl,
    scopeMode: 'current-page'
  });
  assert.equal(result.success, true);

  const fresh = (await callIpc('projects:get-all')).find(p => p.id === project.id);
  assert.equal(fresh.figmaTrackedFiles.length, 1);
  assert.equal(fresh.figmaTrackedFiles[0].key, 'REBUILD9');
  assert.equal(fresh.figmaScopeMode, 'current-page');
  assert.ok(fresh.figmaSession, 'figmaSession should exist');
  assert.equal(fresh.figmaSession.trackedFiles.length, 1);
  assert.equal(fresh.figmaSession.trackedFiles[0].key, 'REBUILD9');
  // Phase 1 page-lock behavior must still be applied to the per-project URL.
  assert.equal(fresh.figmaSession.trackedFiles[0].lockStatus, 'locked');
  assert.equal(fresh.figmaSession.trackedFiles[0].lockedPageId, '2:2');
  assert.equal(await getActiveFigmaPollerCount(), activePollersBefore);
});

test('projects:set-figma-link starts a scan for a watching project with a connected token', async () => {
  const activePollersBefore = await getActiveFigmaPollerCount();
  const modernFileKey = 'FIG_22-Test';
  storedFigmaToken = 'test-token';
  setFigmaDownloadResponse('linked current page asset');
  nextFigmaScanResult = figmaScanResult([{
    url: 'https://cdn.figma.example/current-page.png?token=SHOULD_NOT_APPEAR_TOKEN',
    nodeId: 'node-current-page',
    imageRef: 'img-current-page',
    name: 'Current Page Asset',
    format: 'png',
    figmaFileKey: modernFileKey,
    figmaFileName: 'Brand Cloud',
    figmaPageId: '1:1',
    figmaPageName: 'Page One',
  }], [{
    fileKey: modernFileKey,
    fileName: 'Brand Cloud',
    scopeMode: 'current-page',
    lockStatus: 'locked',
    lockedPageId: '1:1',
    lockedPageName: 'Page One',
    warning: null,
  }]);
  nextFigmaScanResult.files[0].key = modernFileKey;

  const project = await callIpc(
    'projects:create',
    'Phase2-link-while-watching-scan',
    'branding',
    'current-page',
    null
  );
  assert.equal(await getActiveFigmaPollerCount(), activePollersBefore);

  const result = await callIpc('projects:set-figma-link', project.id, {
    url: 'https://www.figma.com/design/FIG_22-Test/Brand-Cloud#node-id=2-1',
    scopeMode: 'current-page'
  });
  assert.equal(result.success, true);

  const fresh = await waitForProject(project.id, item => item.files.length === 1, 'Figma asset should be staged after adding a link while watching');
  assert.deepEqual(lastFigmaScanOptions.fileKeys, [modernFileKey]);
  assert.equal(lastFigmaScanOptions.scopeEntries.length, 1);
  assert.equal(lastFigmaScanOptions.scopeEntries[0].requestedPageId, null);
  assert.equal(lastFigmaScanOptions.scopeEntries[0].requestedNodeId, '2:1');
  assert.equal(lastFigmaScanOptions.scopeEntries[0].scopeMode, 'current-page');
  assert.equal(fresh.figmaSession.trackedFiles[0].lockStatus, 'locked');
  assert.equal(fresh.figmaSession.trackedFiles[0].lockedPageName, 'Page One');
  assert.equal(fresh.files[0].source, 'figma-auto');
  assert.equal(fresh.files[0].figmaFileKey, modernFileKey);
  assert.equal(fresh.files[0].figmaPageId, '1:1');
  assert.equal(fs.readFileSync(fresh.files[0].path, 'utf8'), 'linked current page asset');
  assert.equal(JSON.stringify(fresh).includes('SHOULD_NOT_APPEAR_TOKEN'), false);
  await waitForActiveFigmaPollerCount(activePollersBefore + 1);
});

test('Figma link candidate fallback can lock and stage assets without widening scope', async () => {
  const activePollersBefore = await getActiveFigmaPollerCount();
  const primaryKey = 'BadPrimaryKey';
  const fallbackKey = 'ProtoCandidateKey';
  storedFigmaToken = 'test-token';
  setFigmaDownloadResponse('fallback current page asset');
  nextFigmaScanResult = figmaScanResult([{
    url: 'https://cdn.figma.example/fallback-current-page.png?token=SHOULD_NOT_APPEAR_TOKEN',
    nodeId: 'node-current-page',
    imageRef: 'img-current-page',
    name: 'Fallback Current Page Asset',
    format: 'png',
    figmaFileKey: fallbackKey,
    figmaFileName: 'Petra Logo',
    figmaPageId: '1:1',
    figmaPageName: 'Page One',
  }], [{
    fileKey: fallbackKey,
    fileName: 'Petra Logo',
    scopeMode: 'current-page',
    lockStatus: 'locked',
    lockedPageId: '1:1',
    lockedPageName: 'Page One',
    warning: null,
  }]);
  nextFigmaScanResult.files[0].key = fallbackKey;

  const project = await callIpc(
    'projects:create',
    'Phase2-link-candidate-fallback',
    'branding',
    'current-page',
    null
  );
  assert.equal(await getActiveFigmaPollerCount(), activePollersBefore);

  const result = await callIpc('projects:set-figma-link', project.id, {
    url: `https://www.figma.com/proto/${fallbackKey}/Petra-Logo?node-id=2-1&file-key=${primaryKey}`,
    scopeMode: 'current-page'
  });
  assert.equal(result.success, true);

  const fresh = await waitForProject(project.id, item => item.files.length === 1, 'Figma fallback asset should be staged');
  assert.deepEqual(lastFigmaScanOptions.fileKeys, [primaryKey, fallbackKey]);
  assert.equal(lastFigmaScanOptions.scopeEntries.length, 2);
  assert.deepEqual(lastFigmaScanOptions.scopeEntries.map(entry => entry.key), [primaryKey, fallbackKey]);
  assert.deepEqual(lastFigmaScanOptions.scopeEntries.map(entry => entry.candidateSource), ['canonical-param', 'prototype-route']);
  assert.equal(fresh.figmaSession.trackedFiles[0].key, primaryKey);
  assert.deepEqual(fresh.figmaSession.trackedFiles[0].candidateKeys, [primaryKey, fallbackKey]);
  assert.deepEqual(fresh.figmaSession.trackedFiles[0].candidateKeyDetails, [
    { key: primaryKey, source: 'canonical-param' },
    { key: fallbackKey, source: 'prototype-route' },
  ]);
  assert.equal(fresh.figmaSession.trackedFiles[0].resolvedKey, fallbackKey);
  assert.equal(fresh.figmaSession.trackedFiles[0].lockStatus, 'locked');
  assert.equal(fresh.figmaSession.trackedFiles[0].lockedPageName, 'Page One');
  assert.equal(fresh.files[0].source, 'figma-auto');
  assert.equal(fresh.files[0].figmaFileKey, fallbackKey);
  assert.equal(fresh.files[0].figmaPageId, '1:1');
  await waitForActiveFigmaPollerCount(activePollersBefore + 1);

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-figma-fallback-package-'));
  try {
    const packageResult = await callIpc('projects:package', project.id, outputDir);
    assert.equal(packageResult.success, true);
    assert.equal(packageResult.copiedCount, 1);
    assert.equal(fs.existsSync(path.join(packageFolder(outputDir, 'Phase2-link-candidate-fallback'), fresh.files[0].name)), true);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  assert.equal(JSON.stringify(fresh).includes('SHOULD_NOT_APPEAR_TOKEN'), false);
});

test('figma:connect starts polling for linked watching projects', async () => {
  const activePollersBefore = await getActiveFigmaPollerCount();
  const project = await callIpc(
    'projects:create',
    'Phase2-connect-starts-polling',
    'branding',
    'current-page',
    'https://www.figma.com/file/CONNECT9/Connect-File?page-id=3%3A3'
  );

  assert.ok(project && project.id, 'project should be created');
  assert.equal(await getActiveFigmaPollerCount(), activePollersBefore);

  const connected = await callIpc('figma:connect', 'test-token');
  assert.equal(connected.success, true);
  await waitForActiveFigmaPollerCount(activePollersBefore + 1);

  const disconnected = await callIpc('figma:disconnect');
  assert.equal(disconnected.success, true);
  assert.equal(await getActiveFigmaPollerCount(), activePollersBefore);
});

test('figma:status counts linked watching projects separately from active pollers', async () => {
  const project = await callIpc(
    'projects:create',
    'Phase2-status-linked-project-count',
    'branding',
    'current-page',
    'https://www.figma.com/design/FIG22/Brand-Cloud?page-id=1%3A1'
  );

  let status = await callIpc('figma:status');
  assert.equal(status.connected, false);
  assert.equal(status.activeProjectCount, 1);
  assert.equal(status.activePollerCount, 0);

  figmaScanDelayMs = 80;
  nextFigmaScanResult = figmaScanResult([], []);
  const connectPromise = callIpc('figma:connect', 'test-token');

  await waitForActiveFigmaPollerCount(1);
  status = await callIpc('figma:status');
  assert.equal(status.connected, true);
  assert.equal(status.autoTracking, true);
  assert.equal(status.activeProjectCount, 1);
  assert.equal(status.activePollerCount, 1);

  const connected = await connectPromise;
  assert.equal(connected.success, true);
  await waitForActiveFigmaPollerCount(1);
  const fresh = (await callIpc('projects:get-all')).find(item => item.id === project.id);
  assert.equal(fresh.figmaTrackedFiles.length, 1);
});

test('Figma rate-limit diagnostics enter cooldown and surface a safe project warning', async () => {
  const project = await createLinkedFigmaProject('Figma Rate Limit Cooldown');
  nextFigmaScanResult = figmaRateLimitedScanResult();

  const firstScan = await callIpc('figma:scan-project', project.id);
  assert.equal(firstScan.success, true);
  assert.equal(figmaScanInvocationCount, 1);

  const rateLimitedProject = (await callIpc('projects:get-all')).find(item => item.id === project.id);
  const tracked = rateLimitedProject.figmaSession.trackedFiles[0];
  assert.equal(tracked.lockStatus, 'unresolved');
  assert.equal(tracked.statusReason, 'figma-current-page-rate-limited');
  assert.match(tracked.warning, /rate limiting/i);
  assert.equal(tracked.warning.includes('figma.com'), false);
  assert.equal(tracked.warning.includes('token'), false);
  assert.equal(rateLimitedProject.files.length, 0);

  setFigmaDownloadResponse('should not download during cooldown');
  nextFigmaScanResult = figmaScanResult([{
    url: 'https://cdn.figma.example/rate-limit-follow-up.png?token=SHOULD_NOT_APPEAR_TOKEN',
    nodeId: 'node-rate-follow-up',
    imageRef: 'img-rate-follow-up',
    name: 'Rate Limit Follow Up',
    format: 'png',
    figmaFileKey: 'FIG22',
    figmaFileName: 'Brand Cloud',
    figmaPageId: '1:1',
    figmaPageName: 'Page One',
  }], [{
    fileKey: 'FIG22',
    fileName: 'Brand Cloud',
    scopeMode: 'current-page',
    lockStatus: 'locked',
    lockedPageId: '1:1',
    lockedPageName: 'Page One',
    warning: null,
  }]);

  const secondScan = await callIpc('figma:scan-project', project.id);
  assert.equal(secondScan.success, true);
  assert.equal(figmaScanInvocationCount, 1, 'cooldown should prevent an immediate second API scan');
  const afterCooldownSkip = (await callIpc('projects:get-all')).find(item => item.id === project.id);
  assert.equal(afterCooldownSkip.files.length, 0);
});

test('figmaSession snapshot reads tracked files from the project, not settings', async () => {
  // Even if (legacy) settings.figmaTrackedFiles is somehow non-empty,
  // a fresh project with no per-project link must still produce an empty session.
  const project = await callIpc(
    'projects:create',
    'Phase2-snapshot-source-of-truth',
    'branding',
    'current-page',
    null
  );

  // settings:update is whitelisted, so we
  // can't poison settings.figmaTrackedFiles via IPC. That's the point: even if
  // the legacy global tracking still existed in storage, the snapshot ignores it.
  const fresh = (await callIpc('projects:get-all')).find(p => p.id === project.id);
  assert.deepEqual(fresh.figmaTrackedFiles, []);
  assert.equal(fresh.figmaSession.trackedFiles.length, 0);

  // Settings whitelist enforces the clean break: figmaTrackedFiles is no
  // longer an allowed setting key.
  const settingsBefore = await callIpc('settings:get');
  assert.equal(settingsBefore.figmaTrackedFiles, undefined);
  await callIpc('settings:update', 'figmaTrackedFiles', [{ key: 'INJECT', url: 'x' }]);
  const settingsAfter = await callIpc('settings:get');
  assert.equal(settingsAfter.figmaTrackedFiles, undefined);
});

test('legacy Figma project without figmaScopeMode defaults its session to Current Page Only', async () => {
  const project = await callIpc(
    'projects:create',
    'Legacy Missing Figma Scope',
    'branding',
    'current-page',
    'https://www.figma.com/file/FIG22/Brand-Cloud?page-id=1%3A1'
  );

  const legacy = (await callIpc('projects:get-all')).find(p => p.id === project.id);
  delete legacy.figmaScopeMode;
  delete legacy.figmaSession;

  const fresh = await rebuildFigmaSessionViaScan(project.id);
  assert.equal(fresh.figmaScopeMode, undefined);
  assert.equal(fresh.figmaSession.scopeMode, 'current-page');
  assert.equal(fresh.figmaSession.trackedFiles.length, 1);
  assert.equal(fresh.figmaSession.trackedFiles[0].scopeMode, 'current-page');
  assert.equal(fresh.figmaSession.trackedFiles[0].lockStatus, 'locked');
  assert.equal(fresh.figmaSession.trackedFiles[0].lockedPageId, '1:1');
});

test('legacy Figma project with invalid figmaScopeMode defaults its session to Current Page Only', async () => {
  const project = await callIpc(
    'projects:create',
    'Legacy Invalid Figma Scope',
    'branding',
    'current-page',
    'https://www.figma.com/file/FIG22/Brand-Cloud?page-id=1%3A1'
  );

  const legacy = (await callIpc('projects:get-all')).find(p => p.id === project.id);
  legacy.figmaScopeMode = 'legacy-entire-file';
  legacy.figmaSession = {
    scopeMode: 'entire-file',
    startedAt: legacy.watchStartedAt,
    teamIds: [],
    trackedFiles: [{
      key: 'FIG22',
      url: 'https://www.figma.com/file/FIG22/Brand-Cloud?page-id=1%3A1',
      scopeMode: 'entire-file',
      lockStatus: 'entire-file',
      lockedPageId: null,
      lockedPageName: null,
    }],
    warnings: [],
  };

  const fresh = await rebuildFigmaSessionViaScan(project.id);
  assert.equal(fresh.figmaScopeMode, 'legacy-entire-file');
  assert.equal(fresh.figmaSession.scopeMode, 'current-page');
  assert.equal(fresh.figmaSession.trackedFiles.length, 1);
  assert.equal(fresh.figmaSession.trackedFiles[0].scopeMode, 'current-page');
  assert.equal(fresh.figmaSession.trackedFiles[0].lockStatus, 'locked');
  assert.equal(fresh.figmaSession.trackedFiles[0].lockedPageId, '1:1');
});

test('Current Page Only without a page-linked URL fails closed at package time', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-figma-no-page-'));
  try {
    const project = await callIpc(
      'projects:create',
      'Figma No Page Lock',
      'branding',
      'current-page',
      'https://www.figma.com/file/FIG22/Brand-Cloud'
    );
    const assetPath = path.join(tmpRoot, 'out-of-scope.png');
    fs.writeFileSync(assetPath, 'out of scope asset');
    await addFigmaAutoFileToProject(project.id, assetPath, {
      figmaPageId: '2:2',
      figmaPageName: 'Other Page',
    });

    const fresh = (await callIpc('projects:get-all')).find(p => p.id === project.id);
    assert.equal(fresh.figmaSession.scopeMode, 'current-page');
    assert.equal(fresh.figmaSession.trackedFiles[0].lockStatus, 'unresolved');
    assert.equal(fresh.figmaSession.trackedFiles[0].statusReason, 'figma-current-page-no-page-or-node-param');
    assert.match(fresh.figmaSession.trackedFiles[0].warning, /could not find a page or node/i);
    assert.match(fresh.figmaSession.warnings[0], /No Figma assets will be captured/i);

    const outputDir = path.join(tmpRoot, 'out');
    const result = await callIpc('projects:package', project.id, outputDir);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 0);
    assert.equal(result.embeddedCount, 0);
    assert.equal(result.totalFiles, 0);
    assert.deepEqual(result.errors, []);
    assert.equal(fs.existsSync(path.join(packageFolder(outputDir, 'Figma No Page Lock'), 'out-of-scope.png')), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('explicit Entire File still packages Figma assets from any page', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-figma-entire-'));
  try {
    const project = await callIpc(
      'projects:create',
      'Figma Explicit Entire',
      'branding',
      'entire-file',
      'https://www.figma.com/file/FIG22/Brand-Cloud'
    );
    const assetPath = path.join(tmpRoot, 'entire-file-asset.png');
    fs.writeFileSync(assetPath, 'entire file asset');
    await addFigmaAutoFileToProject(project.id, assetPath, {
      figmaPageId: '2:2',
      figmaPageName: 'Other Page',
      figmaScopeMode: 'entire-file',
    });

    const fresh = (await callIpc('projects:get-all')).find(p => p.id === project.id);
    assert.equal(fresh.figmaScopeMode, 'entire-file');
    assert.equal(fresh.figmaSession.scopeMode, 'entire-file');

    const outputDir = path.join(tmpRoot, 'out');
    const result = await callIpc('projects:package', project.id, outputDir);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.embeddedCount, 0);
    assert.equal(result.totalFiles, 1);
    assert.deepEqual(result.errors, []);
    assert.equal(fs.readFileSync(path.join(packageFolder(outputDir, 'Figma Explicit Entire'), 'entire-file-asset.png'), 'utf8'), 'entire file asset');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('explicit Current Page Only packages only locked-page Figma assets', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-figma-current-'));
  try {
    const project = await callIpc(
      'projects:create',
      'Figma Explicit Current',
      'branding',
      'current-page',
      'https://www.figma.com/file/FIG22/Brand-Cloud?page-id=1%3A1'
    );
    const inScopePath = path.join(tmpRoot, 'in-scope.png');
    const outOfScopePath = path.join(tmpRoot, 'out-of-scope.png');
    fs.writeFileSync(inScopePath, 'in scope asset');
    fs.writeFileSync(outOfScopePath, 'out of scope asset');
    await addFigmaAutoFileToProject(project.id, inScopePath, {
      figmaPageId: '1:1',
      figmaPageName: 'Page One',
    });
    await addFigmaAutoFileToProject(project.id, outOfScopePath, {
      figmaPageId: '2:2',
      figmaPageName: 'Page Two',
    });

    const outputDir = path.join(tmpRoot, 'out');
    const result = await callIpc('projects:package', project.id, outputDir);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.embeddedCount, 0);
    assert.equal(result.totalFiles, 1);
    assert.deepEqual(result.errors, []);

    const packagedFolder = packageFolder(outputDir, 'Figma Explicit Current');
    assert.equal(fs.readFileSync(path.join(packagedFolder, 'in-scope.png'), 'utf8'), 'in scope asset');
    assert.equal(fs.existsSync(path.join(packagedFolder, 'out-of-scope.png')), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('parser-shaped Figma assets retain fileKey for Current Page Only packaging', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-figma-parser-key-'));
  try {
    const project = await createLinkedFigmaProject('Figma Parser FileKey Package');
    setFigmaDownloadResponse('parser file key asset');
    nextFigmaScanResult = figmaScanResult([{
      url: 'https://cdn.figma.example/parser-key.png?token=SHOULD_NOT_APPEAR_TOKEN',
      nodeId: 'node-parser-key',
      imageRef: 'img-parser-key',
      name: 'Parser Key Asset',
      format: 'png',
      fileKey: 'FIG22',
      figmaFileName: 'Brand Cloud',
      figmaPageId: '1:1',
      figmaPageName: 'Page One',
    }], [{
      fileKey: 'FIG22',
      fileName: 'Brand Cloud',
      scopeMode: 'current-page',
      lockStatus: 'locked',
      lockedPageId: '1:1',
      lockedPageName: 'Page One',
      warning: null,
    }]);

    assert.equal((await callIpc('figma:scan-project', project.id)).success, true);
    const scanned = await waitForProject(project.id, item => item.files.length === 1, 'Figma asset should enter the ledger');
    assert.equal(scanned.files[0].figmaFileKey, 'FIG22');
    assert.equal(scanned.files[0].figmaAssetKey, 'FIG22:img-parser-key');

    const outputDir = path.join(tmpRoot, 'out');
    const result = await callIpc('projects:package', project.id, outputDir);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.totalFiles, 1);
    assert.deepEqual(result.errors, []);

    const packagedFolder = packageFolder(outputDir, 'Figma Parser FileKey Package');
    assert.equal(fs.readFileSync(path.join(packagedFolder, 'Brand_Cloud_Parser_Key_Asset.png'), 'utf8'), 'parser file key asset');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('package waits for in-flight Figma scan downloads before selecting package files', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-figma-package-wait-'));
  try {
    const project = await createLinkedFigmaProject('Figma Package Waits For Scan');
    const downloadStarted = setDelayedFigmaDownloadResponse('delayed figma asset', 60);
    nextFigmaScanResult = figmaScanResult([{
      url: 'https://cdn.figma.example/delayed.png?token=SHOULD_NOT_APPEAR_TOKEN',
      nodeId: 'node-delayed',
      imageRef: 'img-delayed',
      name: 'Delayed Asset',
      format: 'png',
      figmaFileKey: 'FIG22',
      figmaFileName: 'Brand Cloud',
      figmaPageId: '1:1',
      figmaPageName: 'Page One',
    }], [{
      fileKey: 'FIG22',
      fileName: 'Brand Cloud',
      scopeMode: 'current-page',
      lockStatus: 'locked',
      lockedPageId: '1:1',
      lockedPageName: 'Page One',
      warning: null,
    }]);

    const scanPromise = callIpc('figma:scan-project', project.id);
    await downloadStarted;

    const outputDir = path.join(tmpRoot, 'out');
    const result = await callIpc('projects:package', project.id, outputDir);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.totalFiles, 1);
    assert.deepEqual(result.errors, []);

    const scan = await scanPromise;
    assert.equal(scan.success, true);
    const packagedFolder = packageFolder(outputDir, 'Figma Package Waits For Scan');
    assert.equal(fs.readFileSync(path.join(packagedFolder, 'Brand_Cloud_Delayed_Asset.png'), 'utf8'), 'delayed figma asset');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Figma asset scan records cloud resource materialization provenance after ledger add', async () => {
  const project = await createLinkedFigmaProject('Figma Provenance Materialized');
  setFigmaDownloadResponse('hero image bytes');
  nextFigmaScanResult = figmaScanResult([{
    url: 'https://cdn.figma.example/signed/SHOULD_NOT_APPEAR_URL?token=SHOULD_NOT_APPEAR_TOKEN',
    nodeId: 'node-hero',
    imageRef: 'img-hero',
    name: 'Hero Image',
    format: 'png',
    figmaFileKey: 'FIG22',
    figmaFileName: 'Brand Cloud',
    figmaPageId: '1:1',
    figmaPageName: 'Page One',
  }], [{
    fileKey: 'FIG22',
    fileName: 'Brand Cloud',
    scopeMode: 'current-page',
    lockStatus: 'locked',
    lockedPageId: '1:1',
    lockedPageName: 'Page One',
    warning: null,
  }]);

  const scan = await callIpc('figma:scan-project', project.id);
  assert.equal(scan.success, true);

  const fresh = await waitForProject(project.id, item => item.files.length === 1, 'Figma asset should be added');
  const file = fresh.files[0];
  assert.equal(file.source, 'figma-auto');
  assert.equal(file.figmaFileKey, 'FIG22');
  assert.equal(file.figmaFileName, 'Brand Cloud');
  assert.equal(file.figmaPageId, '1:1');
  assert.equal(file.figmaPageName, 'Page One');
  assert.equal(file.figmaScopeMode, 'current-page');
  assert.equal(file.figmaAssetKey, 'FIG22:img-hero');
  assert.equal(fs.readFileSync(file.path, 'utf8'), 'hero image bytes');

  const cloudNodes = getProvenanceNodes(fresh, NODE_TYPES.CLOUD_DOCUMENT);
  const resourceNodes = getProvenanceNodes(fresh, NODE_TYPES.EMBEDDED_RESOURCE);
  const materializedEdges = getProvenanceEdges(fresh, EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE);
  assert.equal(cloudNodes.length, 1);
  assert.equal(resourceNodes.length, 1);
  assert.equal(materializedEdges.length, 1);
  assert.equal(cloudNodes[0].provider, 'figma');
  assert.equal(cloudNodes[0].fileKey, 'FIG22');
  assert.equal(cloudNodes[0].pageId, '1:1');
  assert.equal(resourceNodes[0].provider, 'figma');
  assert.equal(resourceNodes[0].resourceKey, 'img-hero');
  assert.equal(resourceNodes[0].cloudDocumentNodeId, cloudNodes[0].id);
  assert.equal(materializedEdges[0].subjectNodeId, resourceNodes[0].id);
  assert.equal(materializedEdges[0].confidence.band, 'confirmed');

  const provenanceText = JSON.stringify(fresh.provenance);
  assert.equal(provenanceText.includes('SHOULD_NOT_APPEAR_URL'), false);
  assert.equal(provenanceText.includes('SHOULD_NOT_APPEAR_TOKEN'), false);
});

test('Figma asset cache directories and downloaded files are owner-only where supported', async () => {
  const crateDir = path.join(TEST_HOME, '.crate');
  const assetsDir = path.join(crateDir, 'figma-assets');
  fs.mkdirSync(assetsDir, { recursive: true, mode: 0o755 });
  if (process.platform !== 'win32') {
    fs.chmodSync(crateDir, 0o755);
    fs.chmodSync(assetsDir, 0o755);
  }

  const project = await createLinkedFigmaProject('Figma Private Asset Cache');
  const assetBytes = 'private figma cache bytes';
  setFigmaDownloadResponse(assetBytes);
  nextFigmaScanResult = figmaScanResult([{
    url: 'https://cdn.figma.example/private-cache.png?token=SHOULD_NOT_APPEAR_TOKEN',
    nodeId: 'node-private-cache',
    imageRef: 'img-private-cache',
    name: 'Private Cache',
    format: 'png',
    figmaFileKey: 'FIG22',
    figmaFileName: 'Brand Cloud',
    figmaPageId: '1:1',
    figmaPageName: 'Page One',
  }]);

  const { output } = await captureConsole(async () => {
    assert.equal((await callIpc('figma:scan-project', project.id)).success, true);
    await waitForProject(project.id, item => item.files.length === 1, 'Figma asset should be cached');
  });

  const fresh = (await callIpc('projects:get-all')).find(item => item.id === project.id);
  const file = fresh.files[0];
  const projectDir = path.dirname(file.path);

  assert.equal(fs.readFileSync(file.path, 'utf8'), assetBytes);
  if (process.platform !== 'win32') {
    assert.equal(modeOf(crateDir), 0o700);
    assert.equal(modeOf(assetsDir), 0o700);
    assert.equal(modeOf(projectDir), 0o700);
    assert.equal(modeOf(file.path), 0o600);
  }

  for (const forbidden of [assetBytes, file.path, projectDir, assetsDir, crateDir]) {
    assert.equal(output.includes(forbidden), false, `log output should not include ${forbidden}`);
  }
});

test('Figma asset cache rejects symlinked cache root without leaking target path', async () => {
  if (process.platform === 'win32') return;

  const crateDir = path.join(TEST_HOME, '.crate');
  const symlinkTarget = path.join(TEST_HOME, 'SHOULD_NOT_APPEAR_FIGMA_ROOT_TARGET');
  fs.mkdirSync(symlinkTarget, { recursive: true });
  fs.symlinkSync(symlinkTarget, crateDir, 'dir');

  const project = await createLinkedFigmaProject('Figma Symlink Root Cache');
  setFigmaDownloadResponse('figma symlink root bytes');
  nextFigmaScanResult = figmaScanResult([{
    url: 'https://cdn.figma.example/symlink-root.png?token=SHOULD_NOT_APPEAR_TOKEN',
    nodeId: 'node-symlink-root',
    imageRef: 'img-symlink-root',
    name: 'Symlink Root',
    format: 'png',
    figmaFileKey: 'FIG22',
    figmaFileName: 'Brand Cloud',
    figmaPageId: '1:1',
    figmaPageName: 'Page One',
  }]);

  const { output } = await captureConsole(async () => {
    assert.equal((await callIpc('figma:scan-project', project.id)).success, true);
  });

  const fresh = (await callIpc('projects:get-all')).find(item => item.id === project.id);
  assert.equal(fresh.files.length, 0);
  assert.deepEqual(fs.readdirSync(symlinkTarget), []);
  assert.equal(output.includes(symlinkTarget), false);
  assert.equal(output.includes('SHOULD_NOT_APPEAR_FIGMA_ROOT_TARGET'), false);
});

test('Figma asset cache rejects symlinked category directory without leaking target path', async () => {
  if (process.platform === 'win32') return;

  const crateDir = path.join(TEST_HOME, '.crate');
  const assetsDir = path.join(crateDir, 'figma-assets');
  const symlinkTarget = path.join(TEST_HOME, 'SHOULD_NOT_APPEAR_FIGMA_CATEGORY_TARGET');
  fs.mkdirSync(crateDir, { recursive: true });
  fs.mkdirSync(symlinkTarget, { recursive: true });
  fs.symlinkSync(symlinkTarget, assetsDir, 'dir');

  const project = await createLinkedFigmaProject('Figma Symlink Category Cache');
  setFigmaDownloadResponse('figma symlink category bytes');
  nextFigmaScanResult = figmaScanResult([{
    url: 'https://cdn.figma.example/symlink-category.png?token=SHOULD_NOT_APPEAR_TOKEN',
    nodeId: 'node-symlink-category',
    imageRef: 'img-symlink-category',
    name: 'Symlink Category',
    format: 'png',
    figmaFileKey: 'FIG22',
    figmaFileName: 'Brand Cloud',
    figmaPageId: '1:1',
    figmaPageName: 'Page One',
  }]);

  const { output } = await captureConsole(async () => {
    assert.equal((await callIpc('figma:scan-project', project.id)).success, true);
  });

  const fresh = (await callIpc('projects:get-all')).find(item => item.id === project.id);
  assert.equal(fresh.files.length, 0);
  assert.deepEqual(fs.readdirSync(symlinkTarget), []);
  assert.equal(output.includes(symlinkTarget), false);
  assert.equal(output.includes('SHOULD_NOT_APPEAR_FIGMA_CATEGORY_TARGET'), false);
});

test('Figma asset cache rejects symlinked project directory without leaking target path', async () => {
  if (process.platform === 'win32') return;

  const project = await createLinkedFigmaProject('Figma Symlink Project Cache');
  const assetsDir = path.join(TEST_HOME, '.crate', 'figma-assets');
  const projectDir = path.join(assetsDir, project.id);
  const symlinkTarget = path.join(TEST_HOME, 'SHOULD_NOT_APPEAR_FIGMA_PROJECT_TARGET');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(symlinkTarget, { recursive: true });
  fs.symlinkSync(symlinkTarget, projectDir, 'dir');

  setFigmaDownloadResponse('figma symlink project bytes');
  nextFigmaScanResult = figmaScanResult([{
    url: 'https://cdn.figma.example/symlink-project.png?token=SHOULD_NOT_APPEAR_TOKEN',
    nodeId: 'node-symlink-project',
    imageRef: 'img-symlink-project',
    name: 'Symlink Project',
    format: 'png',
    figmaFileKey: 'FIG22',
    figmaFileName: 'Brand Cloud',
    figmaPageId: '1:1',
    figmaPageName: 'Page One',
  }]);

  const { output } = await captureConsole(async () => {
    assert.equal((await callIpc('figma:scan-project', project.id)).success, true);
  });

  const fresh = (await callIpc('projects:get-all')).find(item => item.id === project.id);
  assert.equal(fresh.files.length, 0);
  assert.deepEqual(fs.readdirSync(symlinkTarget), []);
  assert.equal(output.includes(symlinkTarget), false);
  assert.equal(output.includes('SHOULD_NOT_APPEAR_FIGMA_PROJECT_TARGET'), false);
});

test('Figma asset format extensions are allowlisted and stay inside the cache directory', async () => {
  const project = await createLinkedFigmaProject('Figma Format Sanitization');
  setFigmaDownloadResponse('format asset bytes');
  nextFigmaScanResult = figmaScanResult([
    {
      url: 'https://cdn.figma.example/safe.webp',
      nodeId: 'node-safe-format',
      imageRef: 'img-safe-format',
      name: 'Safe Format',
      format: 'webp',
      figmaFileKey: 'FIG22',
      figmaFileName: 'Brand Cloud',
      figmaPageId: '1:1',
      figmaPageName: 'Page One',
    },
    {
      url: 'https://cdn.figma.example/unsafe.png',
      nodeId: 'node-unsafe-format',
      imageRef: 'img-unsafe-format',
      name: 'Unsafe Format',
      format: '../../outside',
      figmaFileKey: 'FIG22',
      figmaFileName: 'Brand Cloud',
      figmaPageId: '1:1',
      figmaPageName: 'Page One',
    },
  ]);

  assert.equal((await callIpc('figma:scan-project', project.id)).success, true);
  const fresh = await waitForProject(project.id, item => item.files.length === 2, 'Both Figma assets should be cached');
  const projectDir = path.join(TEST_HOME, '.crate', 'figma-assets', project.id);
  const safeFile = fresh.files.find(file => file.name === 'Brand_Cloud_Safe_Format.webp');
  const unsafeFile = fresh.files.find(file => file.name === 'Brand_Cloud_Unsafe_Format.png');

  assert.ok(safeFile, 'safe webp asset should keep its extension');
  assert.equal(safeFile.ext, '.webp');
  assert.ok(unsafeFile, 'unsafe extension should fall back to png');
  assert.equal(unsafeFile.ext, '.png');
  assert.equal(path.dirname(unsafeFile.path), projectDir);
  const relativeUnsafePath = path.relative(projectDir, unsafeFile.path);
  assert.equal(relativeUnsafePath.startsWith('..'), false);
  assert.equal(path.isAbsolute(relativeUnsafePath), false);
  assert.equal(fs.existsSync(path.join(TEST_HOME, '.crate', 'outside')), false);
});

test('main-process Figma logs redact tracked URLs, signed URLs, and local asset paths', async () => {
  const sensitiveFigmaUrl = 'https://www.figma.com/file/FIGLOG/Secret-File?page-id=1%3A1&token=SHOULD_NOT_APPEAR_TOKEN&Authorization=Bearer%20SHOULD_NOT_APPEAR_AUTH&cookie=session%3DSHOULD_NOT_APPEAR_COOKIE';
  const sensitiveCdnUrl = 'https://cdn.figma.example/signed/SHOULD_NOT_APPEAR_URL?token=SHOULD_NOT_APPEAR_TOKEN&Authorization=Bearer%20SHOULD_NOT_APPEAR_AUTH&cookie=session%3DSHOULD_NOT_APPEAR_COOKIE';
  const project = await callIpc(
    'projects:create',
    'Figma Main Log Privacy',
    'branding',
    'current-page',
    sensitiveFigmaUrl
  );
  storedFigmaToken = 'test-token';
  const assetBytes = 'log privacy asset bytes';
  setFigmaDownloadResponse(assetBytes);
  nextFigmaScanResult = figmaScanResult([{
    url: sensitiveCdnUrl,
    nodeId: 'node-log-privacy',
    imageRef: 'img-log-privacy',
    name: 'Log Privacy Asset',
    format: 'png',
    figmaFileKey: 'FIGLOG',
    figmaFileName: 'Brand Cloud',
    figmaPageId: '1:1',
    figmaPageName: 'Page One',
  }], [{
    fileKey: 'FIGLOG',
    fileName: 'Brand Cloud',
    scopeMode: 'current-page',
    lockStatus: 'locked',
    lockedPageId: '1:1',
    lockedPageName: 'Page One',
    warning: null,
  }]);
  nextFigmaScanResult.errors = [
    `scan failed ${sensitiveFigmaUrl} ${sensitiveCdnUrl} Authorization=Bearer SHOULD_NOT_APPEAR_AUTH cookie=SHOULD_NOT_APPEAR_COOKIE /Users/designer/private/log-asset.png`,
  ];

  const { output } = await captureConsole(async () => {
    const scan = await callIpc('figma:scan-project', project.id);
    assert.equal(scan.success, true);
    await waitForProject(project.id, item => item.files.length === 1, 'Figma asset should be added for log privacy test');

    nextFigmaScanResult = figmaScanResult([], []);
    nextFigmaScanResult.errors = [
      `pre-package failed ${sensitiveFigmaUrl} ${sensitiveCdnUrl} Bearer SHOULD_NOT_APPEAR_AUTH cookie=SHOULD_NOT_APPEAR_COOKIE`,
    ];
    const prePackage = await callIpc('projects:pre-package-scan', project.id);
    assert.ok(prePackage && Array.isArray(prePackage.files));
  });

  const fresh = (await callIpc('projects:get-all')).find(item => item.id === project.id);
  const localAssetPath = fresh.files[0].path;

  assert.match(output, /scan config \(live-initial\)/);
  assert.match(output, /scan config \(pre-package\)/);
  assert.match(output, /trackedFileCount=1/);
  assert.match(output, /"hasUrl":true/);
  assert.match(output, /fileKey=FIGLOG/);
  assert.match(output, /localName=Brand_Cloud_Log_Privacy_Asset\.png/);
  assert.match(output, /\[redacted-url\]/);
  assert.doesNotMatch(
    output,
    /(?:page-id|pageId|page_id|node-id|nodeId|node_id|lockedPageId|requestedPageId|figmaPageId)[^\n]{0,120}1:1/,
    'log output should not include raw Figma scope IDs in page or node contexts'
  );

  for (const forbidden of [
    sensitiveFigmaUrl,
    sensitiveCdnUrl,
    'figma.com',
    'cdn.figma.example',
    'rawTrackedFiles',
    'Secret-File',
    'page-id',
    '1%3A1',
    '"1:1"',
    'SHOULD_NOT_APPEAR',
    'Authorization',
    'Bearer',
    'cookie',
    storedFigmaToken,
    assetBytes,
    localAssetPath,
    path.dirname(localAssetPath),
    TEST_HOME,
    '/Users/designer/private/log-asset.png',
  ]) {
    assert.equal(output.includes(forbidden), false, `log output should not include ${forbidden}`);
  }
});

test('Duplicate Figma asset scans do not duplicate files or provenance edges', async () => {
  const project = await createLinkedFigmaProject('Figma Provenance Duplicate');
  setFigmaDownloadResponse('duplicate image bytes');
  nextFigmaScanResult = figmaScanResult([{
    url: 'https://cdn.figma.example/duplicate.png',
    nodeId: 'node-duplicate',
    imageRef: 'img-duplicate',
    name: 'Duplicate Image',
    format: 'png',
    figmaFileKey: 'FIG22',
    figmaFileName: 'Brand Cloud',
    figmaPageId: '1:1',
    figmaPageName: 'Page One',
  }]);

  assert.equal((await callIpc('figma:scan-project', project.id)).success, true);
  assert.equal((await callIpc('figma:scan-project', project.id)).success, true);

  const fresh = await waitForProject(project.id, item => item.files.length === 1, 'Duplicate scan should keep one file');
  assert.equal(fresh.files.length, 1);
  assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE).length, 1);
});

test('Figma download failure or duplicate skip does not create materialization provenance', async () => {
  const project = await createLinkedFigmaProject('Figma Provenance Download Failure');
  nextFigmaScanResult = figmaScanResult([{
    url: 'https://cdn.figma.example/fail.png',
    nodeId: 'node-fail',
    imageRef: 'img-fail',
    name: 'Fail Image',
    format: 'png',
    figmaFileKey: 'FIG22',
    figmaFileName: 'Brand Cloud',
    figmaPageId: '1:1',
    figmaPageName: 'Page One',
  }]);

  assert.equal((await callIpc('figma:scan-project', project.id)).success, true);

  const fresh = (await callIpc('projects:get-all')).find(item => item.id === project.id);
  assert.equal(fresh.files.length, 0);
  assert.equal(getProvenanceNodes(fresh, NODE_TYPES.CLOUD_DOCUMENT).length, 0);
  assert.equal(getProvenanceNodes(fresh, NODE_TYPES.EMBEDDED_RESOURCE).length, 0);
  assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE).length, 0);
});

test('Figma provenance failure does not block asset capture', async () => {
  const project = await createLinkedFigmaProject('Figma Provenance Failure');
  const freshBefore = (await callIpc('projects:get-all')).find(item => item.id === project.id);
  freshBefore.provenance.nodes = new Proxy({}, {
    set() {
      throw new Error('forced Figma provenance failure');
    },
  });
  setFigmaDownloadResponse('capture survives provenance failure');
  nextFigmaScanResult = figmaScanResult([{
    url: 'https://cdn.figma.example/failure.png',
    nodeId: 'node-failure',
    imageRef: 'img-failure',
    name: 'Failure Image',
    format: 'png',
    figmaFileKey: 'FIG22',
    figmaFileName: 'Brand Cloud',
    figmaPageId: '1:1',
    figmaPageName: 'Page One',
  }]);

  assert.equal((await callIpc('figma:scan-project', project.id)).success, true);

  const fresh = await waitForProject(project.id, item => item.files.length === 1, 'Figma asset capture should survive provenance failure');
  assert.equal(fresh.files[0].source, 'figma-auto');
  assert.equal(fs.readFileSync(fresh.files[0].path, 'utf8'), 'capture survives provenance failure');
});

test('Package manifest includes Figma graph only for packaged scoped assets', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-figma-manifest-'));
  try {
    const project = await createLinkedFigmaProject('Figma Manifest Scope');
    const outputDir = path.join(tmpRoot, 'out');
    setFigmaDownloadResponse('manifest asset bytes');
    nextFigmaScanResult = figmaScanResult([
      {
        url: 'https://cdn.figma.example/in-scope.png?token=SHOULD_NOT_APPEAR_TOKEN',
        nodeId: 'node-in-scope',
        imageRef: 'img-in-scope',
        name: 'In Scope',
        format: 'png',
        figmaFileKey: 'FIG22',
        figmaFileName: 'Brand Cloud',
        figmaPageId: '1:1',
        figmaPageName: 'Page One',
      },
      {
        url: 'https://cdn.figma.example/out-of-scope.png?token=SHOULD_NOT_APPEAR_TOKEN',
        nodeId: 'node-out-of-scope',
        imageRef: 'img-out-of-scope',
        name: 'Out Of Scope',
        format: 'png',
        figmaFileKey: 'FIG22',
        figmaFileName: 'Brand Cloud',
        figmaPageId: '2:2',
        figmaPageName: 'Page Two',
      },
    ], [{
      fileKey: 'FIG22',
      fileName: 'Brand Cloud',
      scopeMode: 'current-page',
      lockStatus: 'locked',
      lockedPageId: '1:1',
      lockedPageName: 'Page One',
      warning: null,
    }]);

    assert.equal((await callIpc('figma:scan-project', project.id)).success, true);
    const scanned = await waitForProject(project.id, item => item.files.length === 2, 'Both Figma assets should enter the ledger');
    assert.equal(scanned.files.filter(file => file.source === 'figma-auto').length, 2);

    await callIpc('settings:update', 'includeDiagnosticReport', true);
    const result = await callIpc('projects:package', project.id, outputDir);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.embeddedCount, 0);
    assert.equal(result.totalFiles, 1);
    assert.deepEqual(result.errors, []);

    const manifest = readManifest(outputDir, 'Figma Manifest Scope');
    assert.equal(fs.existsSync(rootManifestPath(outputDir, 'Figma Manifest Scope')), false);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 1);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE).length, 1);
    assert.equal(manifest.nodes.filter(node => node.type === NODE_TYPES.CLOUD_DOCUMENT).length, 1);
    assert.equal(manifest.nodes.filter(node => node.type === NODE_TYPES.EMBEDDED_RESOURCE && node.provider === 'figma').length, 1);

    const manifestText = JSON.stringify(manifest);
    assert.equal(manifestText.includes('img-in-scope'), true);
    assert.equal(manifestText.includes('img-out-of-scope'), false);
    assert.equal(manifestText.includes('Out Of Scope'), false);
    assert.equal(manifestText.includes('SHOULD_NOT_APPEAR_TOKEN'), false);
    assert.equal(manifestText.includes('cdn.figma.example'), false);
    assert.equal(manifestText.includes('/usr/sbin/lsof'), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
