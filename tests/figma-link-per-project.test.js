// Phase 2 — Figma Link Per-Project tests.
// Loads main.js with stubbed Electron / electron-store / chokidar / ag-psd /
// node-fetch / uuid so we can exercise the IPC handlers in isolation. The
// real Figma URL/scope parsing helpers are reused.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const { promisify: nodePromisify } = require('util');
const { PROVENANCE_SCHEMA_VERSION } = require('../provenance');

// Track timers created by main.js so each test can prove it exits cleanly.
const originalSetInterval = global.setInterval;
const originalClearInterval = global.clearInterval;
const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;
const activeIntervals = new Set();
const activeTimeouts = new Set();

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
  Notification: class { constructor() {} show() {} },
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

// node-fetch — never called in these tests.
setStub('node-fetch', () => async () => ({ ok: false, status: 500, json: async () => ({}) }));

// Figma parser — keep the real URL/scope parsing helpers, but make auth and
// polling deterministic instead of depending on the developer machine.
const { FigmaParser: RealFigmaParser } = require('../parsers/figma');
let storedFigmaToken = null;
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
    return { files: [], assets: [], errors: [], warnings: [], scopeEntries: [] };
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
  await callIpc('projects:delete-all');
  clearTrackedTimers();
}

test.afterEach(cleanupProjectsAndTimers);
test.after(() => {
  clearTrackedTimers();
  global.setInterval = originalSetInterval;
  global.clearInterval = originalClearInterval;
  global.setTimeout = originalSetTimeout;
  global.clearTimeout = originalClearTimeout;
});

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
