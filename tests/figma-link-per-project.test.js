// Phase 2 — Figma Link Per-Project tests.
// Loads main.js with stubbed Electron / electron-store / chokidar / ag-psd /
// node-fetch / uuid so we can exercise the IPC handlers in isolation. The
// real parsers/figma.js is left untouched.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

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

// node-fetch — never called in these tests.
setStub('node-fetch', () => async () => ({ ok: false, status: 500, json: async () => ({}) }));

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

async function resetProjects() {
  const projects = await callIpc('projects:get-all');
  for (const project of [...projects]) {
    await callIpc('projects:delete', project.id);
  }
}

// projects:delete is registered? Let's just reach into the store via a custom
// channel: we don't have one, so fall back to manipulating handlers directly.
// Easier: skip cross-test cleanup and let each test rely on uuids being unique.

// ---------- Tests ----------

test('projects:create with a Figma URL stores per-project tracked file', async () => {
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

  // Snapshot is built on startWatching — confirm the tracked file shows up there too.
  const fresh = (await callIpc('projects:get-all')).find(p => p.id === project.id);
  assert.ok(fresh.figmaSession, 'figmaSession should be populated');
  assert.equal(fresh.figmaSession.trackedFiles.length, 1);
  assert.equal(fresh.figmaSession.trackedFiles[0].key, 'ABC123');
});

test('projects:create without a Figma URL leaves figmaTrackedFiles empty', async () => {
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
  const project = await callIpc(
    'projects:create',
    'Phase2-clear-link',
    'branding',
    'current-page',
    'https://www.figma.com/file/CLEARME/My-File'
  );
  assert.equal(project.figmaTrackedFiles.length, 1);

  const cleared = await callIpc('projects:set-figma-link', project.id, { url: '', scopeMode: 'current-page' });
  assert.equal(cleared.success, true);

  const fresh = (await callIpc('projects:get-all')).find(p => p.id === project.id);
  assert.deepEqual(fresh.figmaTrackedFiles, []);
  assert.equal(fresh.figmaSession.trackedFiles.length, 0);
});

test('projects:set-figma-link rebuilds figmaSession from the new url', async () => {
  const project = await callIpc(
    'projects:create',
    'Phase2-rebuild-session',
    'branding',
    'current-page',
    null
  );
  assert.equal(project.figmaTrackedFiles.length, 0);

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
