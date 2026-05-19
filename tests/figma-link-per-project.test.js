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

  async autoTrackScan() {
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
  return status.activeProjectCount || 0;
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
  fetchHandler = async () => ({ ok: false, status: 500, json: async () => ({}) });
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

function figmaScanResult(assets, scopeEntries = []) {
  return {
    files: [{ key: 'FIG22', name: 'Brand Cloud', isTracked: true }],
    assets,
    errors: [],
    warnings: [],
    scopeEntries,
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

function packageFolder(outputDir, projectName) {
  const dateStr = new Date().toISOString().split('T')[0];
  return path.join(outputDir, `${projectName}_${dateStr}`);
}

function readManifest(outputDir, projectName) {
  return JSON.parse(fs.readFileSync(path.join(packageFolder(outputDir, projectName), 'crate-provenance.json'), 'utf8'));
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

  // settings:update is whitelisted to namingTemplate / notifications, so we
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

    const result = await callIpc('projects:package', project.id, outputDir);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.embeddedCount, 0);
    assert.equal(result.totalFiles, 1);
    assert.deepEqual(result.errors, []);

    const manifest = readManifest(outputDir, 'Figma Manifest Scope');
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
