// Phase 2 — Figma Link Per-Project tests.
// Loads main.js with stubbed Electron / electron-store / chokidar / ag-psd /
// node-fetch / crypto so we can exercise the IPC handlers in isolation. The
// real Figma URL/scope parsing helpers are reused.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { createAutomaticPackageReviewCaller } = require('./package-review-ipc-helper');
const { promisify: nodePromisify } = require('util');
const {
  EDGE_TYPES,
  NODE_TYPES,
  PROVENANCE_SCHEMA_VERSION,
} = require('../provenance');
const { FIGMA_NETWORK_LIMITS } = require('../parsers/figma-network');

// Track timers created by main.js so each test can prove it exits cleanly.
const originalSetInterval = global.setInterval;
const originalClearInterval = global.clearInterval;
const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;
const originalHomedir = os.homedir;
const LOCAL_STORE_PROBE_MODE = process.env.CRATE_LOCAL_STORE_PROBE || '';
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-figma-provenance-test-home-'));
const TEST_USER_DATA = path.join(TEST_HOME, 'user-data');
const TEST_STORE_PATH = path.join(TEST_USER_DATA, 'config.json');
const STARTUP_ORPHAN_CACHE_ID = '00000000-0000-4000-8000-000000000001';
const STARTUP_ACTIVE_CACHE_ID = '00000000-0000-4000-8000-000000000002';
const STARTUP_QUARANTINE_SHAPED_ACTIVE_ID = '.crate-cleanup-777-1234567890123-abcdef123456';
const STARTUP_HARDLINK_TARGET_PATH = path.join(TEST_HOME, 'startup-hardlink-target.bin');
const TEST_CACHE_QUARANTINE_PATTERN = /^\.crate-cleanup-\d+-\d+-[0-9a-f]{12}$/i;
const activeIntervals = new Set();
const activeTimeouts = new Set();

let localStoreProbeTargetPath = null;
let localStoreProbeExpectedContent = null;
let localStoreProbeExpectedMode = null;
let originalFchmodSync = null;

if (LOCAL_STORE_PROBE_MODE === 'config-symlink') {
  fs.mkdirSync(TEST_USER_DATA, { recursive: true, mode: 0o700 });
  localStoreProbeTargetPath = path.join(TEST_HOME, 'outside-config.json');
  localStoreProbeExpectedContent = '{"sentinel":"config-target"}';
  fs.writeFileSync(localStoreProbeTargetPath, localStoreProbeExpectedContent, { mode: 0o600 });
  localStoreProbeExpectedMode = fs.statSync(localStoreProbeTargetPath).mode & 0o777;
  fs.symlinkSync(localStoreProbeTargetPath, TEST_STORE_PATH);
} else if (LOCAL_STORE_PROBE_MODE === 'config-hardlink') {
  fs.mkdirSync(TEST_USER_DATA, { recursive: true, mode: 0o700 });
  localStoreProbeTargetPath = path.join(TEST_HOME, 'outside-hardlinked-config.json');
  localStoreProbeExpectedContent = '{"sentinel":"hardlink-target"}';
  fs.writeFileSync(localStoreProbeTargetPath, localStoreProbeExpectedContent, { mode: 0o644 });
  fs.chmodSync(localStoreProbeTargetPath, 0o644);
  localStoreProbeExpectedMode = fs.statSync(localStoreProbeTargetPath).mode & 0o777;
  fs.linkSync(localStoreProbeTargetPath, TEST_STORE_PATH);
} else if (LOCAL_STORE_PROBE_MODE === 'userdata-symlink') {
  const outsideUserData = path.join(TEST_HOME, 'outside-user-data');
  fs.mkdirSync(outsideUserData, { recursive: true, mode: 0o700 });
  localStoreProbeTargetPath = path.join(outsideUserData, 'config.json');
  localStoreProbeExpectedContent = '{"sentinel":"userdata-target"}';
  fs.writeFileSync(localStoreProbeTargetPath, localStoreProbeExpectedContent, { mode: 0o600 });
  localStoreProbeExpectedMode = fs.statSync(localStoreProbeTargetPath).mode & 0o777;
  fs.symlinkSync(outsideUserData, TEST_USER_DATA);
} else if (LOCAL_STORE_PROBE_MODE === 'permission-failure') {
  fs.mkdirSync(TEST_USER_DATA, { recursive: true, mode: 0o700 });
  fs.writeFileSync(TEST_STORE_PATH, '{}', { mode: 0o600 });
  originalFchmodSync = fs.fchmodSync;
  fs.fchmodSync = () => {
    const error = new Error('permission denied');
    error.code = 'EACCES';
    throw error;
  };
} else {
  fs.writeFileSync(STARTUP_HARDLINK_TARGET_PATH, 'startup hardlink target', { mode: 0o644 });
  fs.chmodSync(STARTUP_HARDLINK_TARGET_PATH, 0o644);
  for (const category of ['figma-assets', 'presentation-assets']) {
    const orphanDir = path.join(TEST_HOME, '.crate', category, STARTUP_ORPHAN_CACHE_ID);
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.join(orphanDir, 'stale-cache.bin'), 'stale cache');
  }
}
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
const electronAppHandlers = new Map();
const rendererMessages = [];
const storageErrorMessages = [];
let appQuitRequested = false;
const trustedRendererMainFrame = {
  url: pathToFileURL(path.resolve(__dirname, '..', 'renderer', 'index.html')).href,
};
const existingRendererWindow = {
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
    send(channel, data) {
      rendererMessages.push({ channel, data });
    },
    on(channel, fn) { this.handlers.set(channel, fn); },
    once(channel, fn) { this.handlers.set(channel, fn); },
    setWindowOpenHandler(fn) { this.windowOpenHandler = fn; },
  },
};

class BrowserWindowStub {
  static getAllWindows() {
    return [existingRendererWindow];
  }

  static fromWebContents(webContents) {
    return webContents === existingRendererWindow.webContents ? existingRendererWindow : null;
  }

  constructor() { return existingRendererWindow; }
  on() {}
  loadFile() {}
  setPosition() {}
  show() {}
  focus() {}
  isDestroyed() { return true; }
  webContents = { send: () => {} };
}

const electronStub = {
  app: {
    requestSingleInstanceLock: () => true,
    quit: () => { appQuitRequested = true; },
    whenReady: () => ({ then: (fn) => { fn(); } }),
    on(eventName, handler) { electronAppHandlers.set(eventName, handler); },
    isReady: () => true,
    show: () => {},
    focus: () => {},
    getPath: () => TEST_USER_DATA,
    dock: { setMenu: () => {} },
  },
  BrowserWindow: BrowserWindowStub,
  Tray: class { constructor() {} on() {} setToolTip() {} isDestroyed() { return true; } destroy() {} },
  ipcMain: {
    handle(channel, fn) { ipcHandlers.set(channel, fn); },
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true }),
    showSaveDialog: async () => ({ canceled: true }),
    showErrorBox: (title, message) => { storageErrorMessages.push({ title, message }); },
  },
  shell: { openPath: () => {} },
  nativeImage: { createFromPath: () => ({ resize: () => ({}) }), createEmpty: () => ({}) },
  Notification: class { static isSupported() { return false; } constructor() {} show() {} },
  Menu: { buildFromTemplate: () => ({}) },
};
setStub('electron', () => electronStub);

// In-memory electron-store double.
const fakeStoreSetHistory = [];
let fakeStoreInstance = null;
let fakeStoreOptions = null;
let fakeStoreConstructed = false;
let armProjectsReadFailureAfterSet = false;
let remainingProjectsReadFailures = 0;
let initializedStoreFileMode = null;
let initializedUserDataMode = null;
let cleanupSentinelCounter = 0;
class FakeStore {
  constructor(opts = {}) {
    fakeStoreConstructed = true;
    fakeStoreOptions = opts;
    this.path = LOCAL_STORE_PROBE_MODE === 'store-path-mismatch'
      ? path.join(TEST_HOME, 'unexpected-config.json')
      : TEST_STORE_PATH;
    fs.mkdirSync(TEST_USER_DATA, { recursive: true });
    fs.writeFileSync(this.path, '{}', { mode: 0o666 });
    fs.chmodSync(this.path, 0o666);
    this.data = JSON.parse(JSON.stringify(opts.defaults || {}));
    if (LOCAL_STORE_PROBE_MODE === 'malformed-settings') {
      this.data.settings = null;
    }
    if (LOCAL_STORE_PROBE_MODE === 'multiple-watching-projects') {
      this.data.projects = [
        {
          id: 'startup-older-watching',
          name: 'Older Watching',
          type: 'branding',
          status: 'watching',
          createdAt: 100,
          watchStartedAt: 1000,
          files: [{ id: 'older-file', path: '/synthetic/older.ai', name: 'older.ai', ext: '.ai' }],
          pendingFiles: [{ id: 'older-pending', path: '/synthetic/review.ai', name: 'review.ai', ext: '.ai' }],
          figmaTrackedFiles: [{ key: 'OLDERFIGMA', scopeMode: 'current-page' }],
        },
        {
          id: 'startup-newer-watching',
          name: 'Newer Watching',
          type: 'branding',
          status: 'watching',
          createdAt: 200,
          watchStartedAt: 2000,
          files: [{ id: 'newer-file', path: '/synthetic/newer.ai', name: 'newer.ai', ext: '.ai' }],
          pendingFiles: [],
          figmaTrackedFiles: [],
        },
        {
          id: 'startup-paused',
          name: 'Already Paused',
          type: 'branding',
          status: 'paused',
          createdAt: 300,
          watchStartedAt: 3000,
          files: [{ id: 'paused-file', path: '/synthetic/paused.ai', name: 'paused.ai', ext: '.ai' }],
          pendingFiles: [],
          figmaTrackedFiles: [],
        },
      ];
    }
    fakeStoreInstance = this;
  }
  get(key, fallback) {
    if (key === 'projects' && remainingProjectsReadFailures > 0) {
      remainingProjectsReadFailures--;
      throw new Error('simulated config read failure');
    }
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
      fakeStoreSetHistory.push({ key: null, value: JSON.parse(JSON.stringify(key)) });
      return;
    }
    const parts = key.split('.');
    let cur = this.data;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
    if (key === 'projects' && armProjectsReadFailureAfterSet) {
      armProjectsReadFailureAfterSet = false;
      remainingProjectsReadFailures = 1;
    }
    fakeStoreSetHistory.push({ key, value: JSON.parse(JSON.stringify(value)) });
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
let nextFigmaTokenVerification = { valid: true };
let nextFigmaStoreResult = true;
let nextFigmaScanResult = null;
let nextFigmaScanError = null;
let lastFigmaScanOptions = null;
let figmaScanInvocationCount = 0;
let figmaScanDelayMs = 0;
class TestFigmaParser extends RealFigmaParser {
  async getStoredToken() {
    return storedFigmaToken;
  }

  async storeToken(token) {
    if (!token || typeof token !== 'string') return false;
    if (!nextFigmaStoreResult) return false;
    storedFigmaToken = token;
    return true;
  }

  async verifyTokenCandidate() {
    return { ...nextFigmaTokenVerification };
  }

  async deleteToken() {
    const hadToken = !!storedFigmaToken;
    storedFigmaToken = null;
    return hadToken;
  }

  async autoTrackScan(options = {}) {
    figmaScanInvocationCount += 1;
    lastFigmaScanOptions = JSON.parse(JSON.stringify(options));
    if (nextFigmaScanError) throw nextFigmaScanError;
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

// Deterministic UUIDs while preserving the rest of Node crypto.
let uuidCounter = 0;
setStub('crypto', () => ({
  ...crypto,
  randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`,
}));

// canvas/keytar are pulled by parsers but absent from node_modules. The figma
// parser already wraps them in try/catch, so leave them un-stubbed.

// ---------- Load main.js with stubs in place ----------
const mainPath = path.resolve(__dirname, '..', 'main.js');
let mainLoadError = null;
try {
  require(mainPath);
} catch (error) {
  mainLoadError = error;
}

if (!LOCAL_STORE_PROBE_MODE && !mainLoadError && fakeStoreInstance) {
  for (const activeId of [STARTUP_ACTIVE_CACHE_ID, STARTUP_QUARANTINE_SHAPED_ACTIVE_ID]) {
    fakeStoreInstance.data.projects.push({ id: activeId });
    for (const category of ['figma-assets', 'presentation-assets']) {
      const projectDir = path.join(TEST_HOME, '.crate', category, activeId);
      fs.mkdirSync(projectDir, { recursive: true, mode: 0o755 });
      fs.chmodSync(projectDir, 0o755);
      const cacheFile = path.join(projectDir, 'active-cache.bin');
      fs.writeFileSync(cacheFile, 'active cache', { mode: 0o644 });
      fs.chmodSync(cacheFile, 0o644);
      if (activeId === STARTUP_ACTIVE_CACHE_ID && category === 'figma-assets' && process.platform !== 'win32') {
        fs.linkSync(STARTUP_HARDLINK_TARGET_PATH, path.join(projectDir, 'hardlinked-cache.bin'));
        fs.symlinkSync(STARTUP_HARDLINK_TARGET_PATH, path.join(projectDir, 'symlinked-cache.bin'));
      }
    }
  }
}

if (LOCAL_STORE_PROBE_MODE) {
  if (originalFchmodSync) fs.fchmodSync = originalFchmodSync;
  const targetUntouched = localStoreProbeTargetPath
    ? fs.readFileSync(localStoreProbeTargetPath, 'utf8') === localStoreProbeExpectedContent
    : true;
  const targetModeUnchanged = localStoreProbeTargetPath && localStoreProbeExpectedMode !== null
    ? (fs.statSync(localStoreProbeTargetPath).mode & 0o777) === localStoreProbeExpectedMode
    : true;
  process.stdout.write(`CRATE_LOCAL_STORE_PROBE_RESULT=${JSON.stringify({
    startupRejected: !!mainLoadError,
    storeConstructed: fakeStoreConstructed,
    storageErrorShown: storageErrorMessages.length === 1,
    appQuitRequested,
    errorText: storageErrorMessages.map(item => `${item.title} ${item.message}`).join(' '),
    targetUntouched,
    targetModeUnchanged,
    projects: LOCAL_STORE_PROBE_MODE === 'multiple-watching-projects'
      ? fakeStoreInstance.data.projects
      : undefined,
  })}\n`);
  clearTrackedTimers();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  process.exit(0);
}

if (mainLoadError) throw mainLoadError;
initializedStoreFileMode = fs.statSync(TEST_STORE_PATH).mode & 0o777;
initializedUserDataMode = fs.statSync(TEST_USER_DATA).mode & 0o777;

// ---------- Helpers ----------
function getStore() {
  // main.js calls `new Store({ defaults: {...} })` once at import time.
  // We don't have a direct handle, so route through the IPC handlers.
  return null;
}

function runLocalStoreStartupProbe(mode) {
  const result = spawnSync(process.execPath, [__filename], {
    env: { ...process.env, CRATE_LOCAL_STORE_PROBE: mode },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const marker = String(result.stdout || '')
    .split('\n')
    .find(line => line.startsWith('CRATE_LOCAL_STORE_PROBE_RESULT='));
  assert.ok(marker, `missing local-store probe result for ${mode}`);
  return JSON.parse(marker.slice('CRATE_LOCAL_STORE_PROBE_RESULT='.length));
}

async function callIpcRaw(channel, ...args) {
  const fn = ipcHandlers.get(channel);
  if (!fn) throw new Error(`No IPC handler registered for ${channel}`);
  return fn({ sender: existingRendererWindow.webContents, senderFrame: trustedRendererMainFrame }, ...args);
}

const callIpc = createAutomaticPackageReviewCaller(callIpcRaw);

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
  armProjectsReadFailureAfterSet = false;
  remainingProjectsReadFailures = 0;
  storedFigmaToken = null;
  nextFigmaTokenVerification = { valid: true };
  nextFigmaStoreResult = true;
  nextFigmaScanResult = null;
  nextFigmaScanError = null;
  lastFigmaScanOptions = null;
  figmaScanInvocationCount = 0;
  figmaScanDelayMs = 0;
  rendererMessages.length = 0;
  fetchHandler = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await callIpc('settings:update', 'includeDiagnosticReport', false);
  await callIpc('projects:delete-all');
  removeUnsafeTestCacheEntries();
  await waitForCacheCleanupSettled();
  clearTrackedTimers();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  fs.mkdirSync(TEST_HOME, { recursive: true });
  fakeStoreSetHistory.length = 0;
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

function setGatedFigmaDownloadResponse(body = 'figma asset bytes') {
  let startedResolve;
  let releaseResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const released = new Promise(resolve => { releaseResolve = resolve; });
  fetchHandler = async () => {
    if (startedResolve) {
      startedResolve();
      startedResolve = null;
    }
    await released;
    return {
      ok: true,
      status: 200,
      buffer: async () => Buffer.from(body),
      json: async () => ({}),
    };
  };
  return {
    started,
    release() {
      if (!releaseResolve) return;
      releaseResolve();
      releaseResolve = null;
    },
  };
}

function modeOf(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}

function projectCacheDir(category, projectId) {
  return path.join(TEST_HOME, '.crate', category, projectId);
}

function seedProjectCache(category, projectId, filename = 'cache.bin') {
  const cacheDir = projectCacheDir(category, projectId);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, filename), 'cache data');
  return cacheDir;
}

async function waitForPathMissing(targetPath, message) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (!fs.existsSync(targetPath)) return;
    await new Promise(resolve => originalSetTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(targetPath), false, message);
}

async function waitForCondition(predicate, message, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => originalSetTimeout(resolve, 10));
  }
  assert.equal(predicate(), true, message);
}

function removeUnsafeTestCacheEntries() {
  const crateDir = path.join(TEST_HOME, '.crate');
  const paths = [crateDir, ...['figma-assets', 'presentation-assets'].map(category => path.join(crateDir, category))];
  for (const targetPath of paths) {
    try {
      const stat = fs.lstatSync(targetPath);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        fs.rmSync(targetPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
}

async function drainProjectCacheCleanupQueue() {
  removeUnsafeTestCacheEntries();
  if (!Array.isArray(fakeStoreInstance.data.projects)) fakeStoreInstance.data.projects = [];
  const sentinelId = `00000000-0000-4000-8001-${String(++cleanupSentinelCounter).padStart(12, '0')}`;
  fakeStoreInstance.data.projects.push({ id: sentinelId });
  for (const category of ['figma-assets', 'presentation-assets']) {
    seedProjectCache(category, sentinelId, 'cleanup-sentinel.bin');
  }
  await callIpc('projects:delete', sentinelId);
  for (const category of ['figma-assets', 'presentation-assets']) {
    await waitForPathMissing(
      projectCacheDir(category, sentinelId),
      `${category} cleanup sentinel should drain the serialized cleanup queue`
    );
  }
  await new Promise(resolve => setImmediate(resolve));
}

async function waitForPathMode(targetPath, expectedMode, message) {
  await waitForCondition(
    () => fs.existsSync(targetPath) && modeOf(targetPath) === expectedMode,
    message
  );
}

async function waitForCacheCleanupSettled() {
  await drainProjectCacheCleanupQueue();
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
      primaryKey: 'FIG22',
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

test('local config is owner-only and startup hardens active caches while removing only orphans', async () => {
  assert.equal(fakeStoreOptions.configFileMode, 0o600);
  assert.equal(initializedStoreFileMode, 0o600);
  assert.equal(initializedUserDataMode, 0o700);

  for (const category of ['figma-assets', 'presentation-assets']) {
    await waitForPathMissing(
      projectCacheDir(category, STARTUP_ORPHAN_CACHE_ID),
      `${category} startup orphan should be removed`
    );
    for (const activeId of [STARTUP_ACTIVE_CACHE_ID, STARTUP_QUARANTINE_SHAPED_ACTIVE_ID]) {
      const activeDir = projectCacheDir(category, activeId);
      const activeFile = path.join(activeDir, 'active-cache.bin');
      await waitForPathMode(activeDir, 0o700, `${category} active cache directory should be owner-only`);
      await waitForPathMode(activeFile, 0o600, `${category} active cache file should be owner-only`);
      assert.equal(fs.existsSync(activeDir), true, `${category} active cache should be retained`);
    }
  }
  if (process.platform !== 'win32') {
    assert.equal(fs.readFileSync(STARTUP_HARDLINK_TARGET_PATH, 'utf8'), 'startup hardlink target');
    assert.equal(modeOf(STARTUP_HARDLINK_TARGET_PATH), 0o644, 'startup hard-link target mode must remain unchanged');
    assert.equal(
      fs.existsSync(path.join(projectCacheDir('figma-assets', STARTUP_ACTIVE_CACHE_ID), 'hardlinked-cache.bin')),
      false,
      'startup hardening should unlink an unsafe cache hard link without touching its target'
    );
    assert.equal(
      fs.existsSync(path.join(projectCacheDir('figma-assets', STARTUP_ACTIVE_CACHE_ID), 'symlinked-cache.bin')),
      false,
      'startup hardening should unlink an unsafe cache symlink without touching its target'
    );
  }
});

test('local config preflight shows a privacy-safe native error before store access', () => {
  for (const mode of ['config-symlink', 'config-hardlink', 'userdata-symlink', 'permission-failure']) {
    const result = runLocalStoreStartupProbe(mode);
    assert.equal(result.startupRejected, false, `${mode} should use the native startup-error path`);
    assert.equal(result.storeConstructed, false, `${mode} should stop before electron-store reads config`);
    assert.equal(result.storageErrorShown, true, `${mode} should show a native storage error`);
    assert.equal(result.appQuitRequested, true, `${mode} should quit cleanly after the error`);
    assert.equal(result.targetUntouched, true, `${mode} should not alter an unrelated target`);
    assert.equal(result.targetModeUnchanged, true, `${mode} should not chmod an unrelated target`);
    assert.equal(result.errorText.includes(TEST_HOME), false, `${mode} should not expose local paths`);
  }
});

test('local config rejects an unexpected electron-store path with the same native error', () => {
  for (const mode of ['store-path-mismatch', 'malformed-settings']) {
    const result = runLocalStoreStartupProbe(mode);
    assert.equal(result.startupRejected, false, `${mode} should use the native startup-error path`);
    assert.equal(result.storeConstructed, true, `${mode} should be rejected after store construction`);
    assert.equal(result.storageErrorShown, true, `${mode} should show a native storage error`);
    assert.equal(result.appQuitRequested, true, `${mode} should quit cleanly after the error`);
    assert.equal(result.errorText.includes(TEST_HOME), false, `${mode} should not expose local paths`);
  }
});

test('startup keeps only the most recently active Watching project without deleting project state', () => {
  const result = runLocalStoreStartupProbe('multiple-watching-projects');
  assert.equal(result.storageErrorShown, false);
  assert.equal(result.appQuitRequested, false);
  assert.equal(result.projects.filter(project => project.status === 'watching').length, 1);

  const older = result.projects.find(project => project.id === 'startup-older-watching');
  const newer = result.projects.find(project => project.id === 'startup-newer-watching');
  const paused = result.projects.find(project => project.id === 'startup-paused');

  assert.equal(older.status, 'paused');
  assert.deepEqual(older.files.map(file => file.id), ['older-file']);
  assert.deepEqual(older.pendingFiles.map(file => file.id), ['older-pending']);
  assert.deepEqual(older.figmaTrackedFiles.map(file => file.key), ['OLDERFIGMA']);
  assert.equal(newer.status, 'watching');
  assert.equal(newer.watchStartedAt, 2000);
  assert.deepEqual(newer.files.map(file => file.id), ['newer-file']);
  assert.equal(paused.status, 'paused');
  assert.deepEqual(paused.files.map(file => file.id), ['paused-file']);
});

test('deleting one project removes only its caches while preserving active and unrelated cache directories', async () => {
  const deletedProject = await callIpc('projects:create', 'Delete cache project');
  const activeProject = await callIpc('projects:create', 'Keep cache project');
  const orphanId = '00000000-0000-4000-8000-000000999999';
  const unrecognizedCacheId = 'not-a-crate-project-cache';
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-cache-outside-'));
  const outsideFile = path.join(outsideDir, 'keep.txt');
  fs.writeFileSync(outsideFile, 'keep');

  try {
    for (const category of ['figma-assets', 'presentation-assets']) {
      seedProjectCache(category, deletedProject.id);
      seedProjectCache(category, activeProject.id);
      seedProjectCache(category, orphanId);
      seedProjectCache(category, unrecognizedCacheId);
    }
    fs.symlinkSync(outsideDir, path.join(projectCacheDir('figma-assets', deletedProject.id), 'outside-link'));

    await callIpc('projects:delete', deletedProject.id);

    for (const category of ['figma-assets', 'presentation-assets']) {
      await waitForPathMissing(
        projectCacheDir(category, deletedProject.id),
        `${category} deleted-project cache should be removed`
      );
      assert.equal(fs.existsSync(projectCacheDir(category, activeProject.id)), true);
      assert.equal(fs.existsSync(projectCacheDir(category, orphanId)), true);
      assert.equal(fs.existsSync(projectCacheDir(category, unrecognizedCacheId)), true);
    }
    assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'keep');

    await callIpc('projects:delete-all');
    for (const category of ['figma-assets', 'presentation-assets']) {
      await waitForPathMissing(
        projectCacheDir(category, orphanId),
        `${category} startup/delete-all orphan sweep should remove stale project caches`
      );
    }
  } finally {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('deferred project cache cleanup rechecks current projects immediately before quarantine', async () => {
  const project = await callIpc('projects:create', 'Reused project cache id');
  const restoredProject = JSON.parse(JSON.stringify(project));
  const cacheDir = seedProjectCache('figma-assets', project.id);
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-cache-batch-outside-'));
  const outsideFile = path.join(outsideDir, 'keep.txt');
  fs.writeFileSync(outsideFile, 'keep', { mode: 0o644 });
  if (process.platform !== 'win32') {
    for (let index = 0; index < 50; index++) {
      fs.symlinkSync(outsideFile, path.join(cacheDir, `unsafe-${index}.bin`));
    }
  }
  const cacheRealPath = fs.realpathSync.native(cacheDir);
  const originalRename = fs.promises.rename;
  const originalSetImmediateForTest = global.setImmediate;
  let cleanupYieldCount = 0;
  let releaseRename;
  const renameGate = new Promise(resolve => { releaseRename = resolve; });
  let renameFinishedResolve;
  const renameFinished = new Promise(resolve => { renameFinishedResolve = resolve; });

  fs.promises.rename = async (sourcePath, destinationPath) => {
    const result = await originalRename.call(fs.promises, sourcePath, destinationPath);
    if (sourcePath === cacheRealPath && renameFinishedResolve) {
      renameFinishedResolve();
      renameFinishedResolve = null;
      await renameGate;
    }
    return result;
  };

  try {
    await callIpc('projects:delete', project.id);
    await renameFinished;
    fakeStoreInstance.data.projects.push(restoredProject);
    global.setImmediate = (fn, ...args) => {
      cleanupYieldCount += 1;
      return originalSetImmediateForTest(fn, ...args);
    };
    releaseRename();
    await waitForPathMode(cacheDir, 0o700, 'reactivated cache should be restored and hardened');
    if (process.platform !== 'win32') {
      await waitForCondition(
        () => cleanupYieldCount >= 2,
        'unsafe cache entries should still yield in bounded batches'
      );
    }

    assert.equal(fs.existsSync(cacheDir), true);
    const activeProjectIds = new Set((await callIpc('projects:get-all')).map(item => item.id));
    assert.equal(activeProjectIds.has(project.id), true);
    assert.equal(
      fs.readdirSync(path.dirname(cacheDir)).some(
        name => TEST_CACHE_QUARANTINE_PATTERN.test(name) && !activeProjectIds.has(name)
      ),
      false,
      'reactivated cache should not remain quarantined'
    );
    if (process.platform !== 'win32') {
      assert.ok(cleanupYieldCount >= 2, 'unsafe cache entries should still yield in bounded batches');
      assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'keep');
      assert.equal(modeOf(outsideFile), 0o644);
    }
  } finally {
    releaseRename();
    global.setImmediate = originalSetImmediateForTest;
    fs.promises.rename = originalRename;
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('project cache cleanup fails closed when stored project state cannot be read', async () => {
  const project = await callIpc('projects:create', 'Unreadable project state cache');
  const cacheDir = seedProjectCache('figma-assets', project.id);

  armProjectsReadFailureAfterSet = true;
  await callIpc('projects:delete', project.id);
  await waitForCondition(
    () => remainingProjectsReadFailures === 0,
    'cleanup should attempt the guarded project-state read'
  );
  assert.equal(fs.existsSync(cacheDir), true, 'cleanup should not guess when project state is unreadable');

  await callIpc('projects:delete-all');
  await waitForPathMissing(cacheDir, 'a later safe cleanup should remove the retained Crate cache');
});

test('project cache cleanup retries transient quarantine and removal failures', async () => {
  const project = await callIpc('projects:create', 'Retry project cache cleanup');
  const cacheDir = seedProjectCache('figma-assets', project.id);
  const cacheRealPath = fs.realpathSync.native(cacheDir);
  const originalRename = fs.promises.rename;
  const originalRm = fs.promises.rm;
  let renameAttempts = 0;
  let removalAttempts = 0;

  fs.promises.rename = async (sourcePath, destinationPath) => {
    if (sourcePath === cacheRealPath && renameAttempts++ === 0) {
      const error = new Error('cache busy');
      error.code = 'EBUSY';
      throw error;
    }
    return originalRename.call(fs.promises, sourcePath, destinationPath);
  };
  fs.promises.rm = async (targetPath, options) => {
    if (path.basename(targetPath).startsWith('.crate-cleanup-') && removalAttempts++ === 0) {
      const error = new Error('cache busy');
      error.code = 'EBUSY';
      throw error;
    }
    return originalRm.call(fs.promises, targetPath, options);
  };

  try {
    await callIpc('projects:delete', project.id);
    await waitForCondition(
      () => renameAttempts >= 2 && removalAttempts >= 2,
      'cache cleanup should retry transient quarantine and removal failures'
    );
    await waitForCacheCleanupSettled();
    assert.equal(fs.existsSync(cacheDir), false);
    assert.ok(renameAttempts >= 2, `quarantine should retry after a transient rename failure (attempts=${renameAttempts})`);
    assert.ok(removalAttempts >= 2, `removal should retry after a transient filesystem failure (attempts=${removalAttempts})`);
  } finally {
    fs.promises.rename = originalRename;
    fs.promises.rm = originalRm;
  }
});

test('project deletion returns before cache cleanup and removes project state immediately', async () => {
  const project = await callIpc('projects:create', 'Nonblocking cache cleanup');
  const cacheDir = seedProjectCache('figma-assets', project.id);
  const cacheRealPath = fs.realpathSync.native(cacheDir);
  const originalRename = fs.promises.rename;
  let releaseRename;
  const renameGate = new Promise(resolve => { releaseRename = resolve; });
  let renameStartedResolve;
  const renameStarted = new Promise(resolve => { renameStartedResolve = resolve; });

  fs.promises.rename = async (sourcePath, destinationPath) => {
    if (sourcePath === cacheRealPath && renameStartedResolve) {
      renameStartedResolve();
      renameStartedResolve = null;
      await renameGate;
    }
    return originalRename.call(fs.promises, sourcePath, destinationPath);
  };

  try {
    const deletedProjects = await Promise.race([
      callIpc('projects:delete', project.id),
      new Promise((_, reject) => originalSetTimeout(() => reject(new Error('delete handler blocked on cache cleanup')), 100)),
    ]);
    assert.equal(deletedProjects.some(item => item.id === project.id), false);
    assert.equal((await callIpc('projects:get-all')).some(item => item.id === project.id), false);
    assert.equal(fs.existsSync(cacheDir), true);

    await renameStarted;
    releaseRename();
    await waitForPathMissing(cacheDir, 'background cleanup should remove the deleted-project cache');
  } finally {
    releaseRename();
    fs.promises.rename = originalRename;
  }
});

test('permanent cache removal failure is reported and retained for a later retry', async () => {
  const project = await callIpc('projects:create', 'Deferred cache retry');
  const cacheDir = seedProjectCache('figma-assets', project.id);
  const categoryDir = path.dirname(cacheDir);
  const originalRm = fs.promises.rm;
  let removalAttempts = 0;

  fs.promises.rm = async (targetPath, options) => {
    if (path.basename(targetPath).startsWith('.crate-cleanup-')) {
      removalAttempts += 1;
      const error = new Error('cache busy');
      error.code = 'EBUSY';
      throw error;
    }
    return originalRm.call(fs.promises, targetPath, options);
  };

  try {
    const captured = await captureConsole(async () => {
      await callIpc('projects:delete', project.id);
      await waitForCondition(
        () => removalAttempts >= 4,
        'cache removal should exhaust its bounded retries'
      );
      await new Promise(resolve => setImmediate(resolve));
    });

    assert.match(captured.output, /deferred cache cleanup could not complete/);
    assert.equal(fs.existsSync(cacheDir), false);
    const quarantineName = fs.readdirSync(categoryDir).find(name => TEST_CACHE_QUARANTINE_PATTERN.test(name));
    assert.ok(quarantineName, 'failed cleanup should retain a private quarantine for the next retry');
  } finally {
    fs.promises.rm = originalRm;
  }

  await callIpc('projects:delete-all');
  await waitForCacheCleanupSettled();
});

test('project cache cleanup refuses a symlinked cache category without touching its target', async () => {
  const project = await callIpc('projects:create', 'Symlink cache project');
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-cache-root-outside-'));
  const outsideProjectDir = path.join(outsideDir, project.id);
  const outsideFile = path.join(outsideProjectDir, 'keep.txt');

  try {
    fs.mkdirSync(outsideProjectDir, { recursive: true });
    fs.writeFileSync(outsideFile, 'keep');
    fs.mkdirSync(path.join(TEST_HOME, '.crate'), { recursive: true });
    fs.symlinkSync(outsideDir, path.join(TEST_HOME, '.crate', 'figma-assets'));
    const presentationDir = seedProjectCache('presentation-assets', project.id);

    await callIpc('projects:delete', project.id);

    await waitForPathMissing(presentationDir, 'safe presentation cache should be removed');
    assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'keep');
    assert.equal(fs.lstatSync(path.join(TEST_HOME, '.crate', 'figma-assets')).isSymbolicLink(), true);
  } finally {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('deleting a project during an in-flight Figma download removes the late cache write', async () => {
  const project = await createLinkedFigmaProject('Delete in-flight Figma cache');
  const downloadGate = setGatedFigmaDownloadResponse('late figma cache');
  nextFigmaScanResult = figmaScanResult([{
    url: 'https://cdn.figma.example/late.png?token=SHOULD_NOT_APPEAR_TOKEN',
    nodeId: 'node-late',
    imageRef: 'img-late',
    name: 'Late Asset',
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
  await downloadGate.started;
  await callIpc('projects:delete', project.id);
  downloadGate.release();
  await scanPromise;

  await waitForPathMissing(
    projectCacheDir('figma-assets', project.id),
    'late Figma cache should be removed after the deleted project scan settles'
  );
  assert.equal((await callIpc('projects:get-all')).some(item => item.id === project.id), false);
});

test('a delayed Figma download from an old A activation cannot mutate or cache after A to B to A', async () => {
  const first = await createLinkedFigmaProject('Delayed Figma Activation A');
  const cacheDir = projectCacheDir('figma-assets', first.id);
  const cacheEntriesBefore = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).sort() : [];
  const downloadGate = setGatedFigmaDownloadResponse('stale activation figma cache');
  nextFigmaScanResult = figmaScanResult([{
    url: 'https://cdn.figma.example/stale-activation.png?token=SHOULD_NOT_APPEAR_TOKEN',
    nodeId: 'node-stale-activation',
    imageRef: 'img-stale-activation',
    name: 'Stale Activation Asset',
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

  const staleScan = callIpc('figma:scan-project', first.id);
  await downloadGate.started;

  storedFigmaToken = null;
  const second = await callIpc('projects:create', 'Delayed Figma Activation B');
  await callIpc('projects:start-watching', first.id);
  downloadGate.release();
  await staleScan;
  await new Promise(resolve => originalSetTimeout(resolve, 30));

  const projects = await callIpc('projects:get-all');
  const firstFresh = projects.find(project => project.id === first.id);
  const secondFresh = projects.find(project => project.id === second.id);
  assert.equal(firstFresh.status, 'watching');
  assert.equal(secondFresh.status, 'paused');
  assert.equal(firstFresh.files.some(file => file.source === 'figma-auto'), false);
  assert.equal(secondFresh.files.some(file => file.source === 'figma-auto'), false);
  assert.equal(
    getProvenanceNodes(firstFresh, NODE_TYPES.FILE)
      .some(node => node.name === 'Brand_Cloud_Stale_Activation_Asset.png'),
    false
  );
  assert.deepEqual(
    fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).sort() : [],
    cacheEntriesBefore
  );
});

test('delete-all during an in-flight Figma download removes the late cache write', async () => {
  const project = await createLinkedFigmaProject('Delete all in-flight Figma cache');
  const downloadGate = setGatedFigmaDownloadResponse('late delete-all figma cache');
  nextFigmaScanResult = figmaScanResult([{
    url: 'https://cdn.figma.example/delete-all-late.png?token=SHOULD_NOT_APPEAR_TOKEN',
    nodeId: 'node-delete-all-late',
    imageRef: 'img-delete-all-late',
    name: 'Late Delete All Asset',
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
  await downloadGate.started;
  await callIpc('projects:delete-all');
  downloadGate.release();
  await scanPromise;

  await waitForPathMissing(
    projectCacheDir('figma-assets', project.id),
    'late delete-all Figma cache should be removed after the scan settles'
  );
  assert.deepEqual(await callIpc('projects:get-all'), []);
});

test('deleting a project during pre-package Figma recovery removes the late cache write', async () => {
  const project = await createLinkedFigmaProject('Delete pre-package Figma cache');
  const downloadGate = setGatedFigmaDownloadResponse('late pre-package figma cache');
  nextFigmaScanResult = figmaScanResult([{
    url: 'https://cdn.figma.example/pre-package-late.png?token=SHOULD_NOT_APPEAR_TOKEN',
    nodeId: 'node-pre-package-late',
    imageRef: 'img-pre-package-late',
    name: 'Late Pre Package Asset',
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

  const scanPromise = callIpc('projects:pre-package-scan', project.id);
  await downloadGate.started;
  await callIpc('projects:delete', project.id);
  downloadGate.release();
  await scanPromise;

  await waitForPathMissing(
    projectCacheDir('figma-assets', project.id),
    'late pre-package Figma cache should be removed after the deleted project scan settles'
  );
  assert.equal((await callIpc('projects:get-all')).some(item => item.id === project.id), false);
});

test('delete-all removes valid Crate project caches but skips cleanup when project state is corrupt', async () => {
  const firstProject = await callIpc('projects:create', 'Delete all cache one');
  const secondProject = await callIpc('projects:create', 'Delete all cache two');
  for (const category of ['figma-assets', 'presentation-assets']) {
    seedProjectCache(category, firstProject.id);
    seedProjectCache(category, secondProject.id);
  }

  await callIpc('projects:delete-all');
  for (const category of ['figma-assets', 'presentation-assets']) {
    await waitForPathMissing(projectCacheDir(category, firstProject.id));
    await waitForPathMissing(projectCacheDir(category, secondProject.id));
  }
  await drainProjectCacheCleanupQueue();

  const corruptStateCacheId = '00000000-0000-4000-8000-000000777777';
  const corruptStateCache = seedProjectCache('figma-assets', corruptStateCacheId);
  fakeStoreInstance.data.projects = { invalid: true };
  await callIpc('projects:delete-all');
  assert.equal(fs.existsSync(corruptStateCache), true);

  await callIpc('projects:delete-all');
  await waitForPathMissing(corruptStateCache, 'a later valid orphan sweep should remove the retained cache');
});

test('projects:create keeps only a minimal per-project Figma locator', async () => {
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
  assert.equal(project.figmaTrackedFiles[0].url, undefined);
  assert.equal(project.figmaTrackedFiles[0].requestedPageId, '1:1');
  assert.equal(project.figmaTrackedFiles[0].requestedNodeId, null);
  assert.equal(project.figmaScopeMode, 'current-page');
  assert.equal(project.provenance.schemaVersion, PROVENANCE_SCHEMA_VERSION);
  assert.deepEqual(project.provenance.observations, []);

  // Snapshot is built on startWatching — confirm the tracked file shows up there too.
  const fresh = (await callIpc('projects:get-all')).find(p => p.id === project.id);
  assert.ok(fresh.figmaSession, 'figmaSession should be populated');
  assert.equal(fresh.provenance.schemaVersion, PROVENANCE_SCHEMA_VERSION);
  assert.equal(fresh.figmaSession.trackedFiles.length, 1);
  assert.equal(fresh.figmaSession.trackedFiles[0].key, 'ABC123');
  assert.equal(fresh.figmaSession.trackedFiles[0].url, undefined);
  assert.equal(fresh.figmaSession.trackedFiles[0].requestedPageId, '1:1');
  assert.equal(JSON.stringify(fresh).includes(url), false);
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

test('starting or resuming a project atomically pauses the previous watcher and preserves both projects', async () => {
  const first = await callIpc(
    'projects:create',
    'Single Watch First',
    'branding',
    'current-page',
    'https://www.figma.com/file/FIG22/Brand-Cloud?page-id=1%3A1'
  );
  const firstStored = fakeStoreInstance.data.projects.find(project => project.id === first.id);
  firstStored.files = [{ id: 'first-file', path: '/synthetic/first.ai', name: 'first.ai', ext: '.ai' }];
  firstStored.pendingFiles = [{ id: 'first-pending', path: '/synthetic/review.ai', name: 'review.ai', ext: '.ai' }];

  const second = await callIpc('projects:create', 'Single Watch Second');
  let projects = await callIpc('projects:get-all');
  let firstFresh = projects.find(project => project.id === first.id);
  let secondFresh = projects.find(project => project.id === second.id);

  assert.equal(projects.filter(project => project.status === 'watching').length, 1);
  assert.equal(firstFresh.status, 'paused');
  assert.equal(secondFresh.status, 'watching');
  assert.deepEqual(firstFresh.files.map(file => file.id), ['first-file']);
  assert.deepEqual(firstFresh.pendingFiles.map(file => file.id), ['first-pending']);
  assert.equal(firstFresh.figmaTrackedFiles[0].key, 'FIG22');

  secondFresh.files = [{ id: 'second-file', path: '/synthetic/second.ai', name: 'second.ai', ext: '.ai' }];
  await callIpc('projects:start-watching', first.id);
  projects = await callIpc('projects:get-all');
  firstFresh = projects.find(project => project.id === first.id);
  secondFresh = projects.find(project => project.id === second.id);

  assert.equal(projects.filter(project => project.status === 'watching').length, 1);
  assert.equal(firstFresh.status, 'watching');
  assert.equal(secondFresh.status, 'paused');
  assert.deepEqual(secondFresh.files.map(file => file.id), ['second-file']);
  assert.equal(firstFresh.figmaTrackedFiles[0].key, 'FIG22');
});

test('projects:set-figma-link preserves the link when replacement URL is empty', async () => {
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

  const preserved = await callIpc('projects:set-figma-link', project.id, {
    action: 'preserve',
    url: '',
    scopeMode: 'entire-file'
  });
  assert.equal(preserved.success, true);

  const fresh = (await callIpc('projects:get-all')).find(p => p.id === project.id);
  assert.equal(fresh.figmaTrackedFiles.length, 1);
  assert.equal(fresh.figmaTrackedFiles[0].key, 'CLEARME');
  assert.equal(fresh.figmaTrackedFiles[0].url, undefined);
  assert.equal(fresh.figmaScopeMode, 'entire-file');
  assert.equal(fresh.figmaSession.trackedFiles.length, 1);
  assert.equal(fresh.figmaSession.trackedFiles[0].lockStatus, 'entire-file');
  assert.equal(await getActiveFigmaPollerCount(), activePollersBefore);
});

test('projects:set-figma-link removes the link only through an explicit action', async () => {
  const activePollersBefore = await getActiveFigmaPollerCount();
  const project = await callIpc(
    'projects:create',
    'Phase2-remove-link',
    'branding',
    'current-page',
    'https://www.figma.com/file/REMOVEME/My-File?page-id=1%3A1'
  );

  const removed = await callIpc('projects:set-figma-link', project.id, {
    action: 'remove',
    scopeMode: 'current-page'
  });
  assert.equal(removed.success, true);

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
    action: 'replace',
    url: newUrl,
    scopeMode: 'current-page'
  });
  assert.equal(result.success, true);

  const fresh = (await callIpc('projects:get-all')).find(p => p.id === project.id);
  assert.equal(fresh.figmaTrackedFiles.length, 1);
  assert.equal(fresh.figmaTrackedFiles[0].key, 'REBUILD9');
  assert.equal(fresh.figmaTrackedFiles[0].url, undefined);
  assert.equal(fresh.figmaTrackedFiles[0].requestedPageId, '2:2');
  assert.equal(fresh.figmaScopeMode, 'current-page');
  assert.ok(fresh.figmaSession, 'figmaSession should exist');
  assert.equal(fresh.figmaSession.trackedFiles.length, 1);
  assert.equal(fresh.figmaSession.trackedFiles[0].key, 'REBUILD9');
  assert.equal(fresh.figmaSession.trackedFiles[0].url, undefined);
  // Phase 1 page-lock behavior must still be applied to the per-project URL.
  assert.equal(fresh.figmaSession.trackedFiles[0].lockStatus, 'locked');
  assert.equal(fresh.figmaSession.trackedFiles[0].lockedPageId, '2:2');
  assert.equal(await getActiveFigmaPollerCount(), activePollersBefore);
});

test('legacy persisted Figma URLs migrate without reconnecting or losing page scope', async () => {
  const project = await callIpc(
    'projects:create',
    'Legacy Figma URL Migration',
    'branding',
    'current-page',
    null
  );
  const legacyUrl = 'https://www.figma.com/design/LEGACY22/Private-Project?page-id=7%3A9';
  const legacy = (await callIpc('projects:get-all')).find(item => item.id === project.id);
  legacy.figmaTrackedFiles = [{ key: 'LEGACY22', url: legacyUrl }];
  legacy.figmaSession = {
    scopeMode: 'current-page',
    startedAt: legacy.watchStartedAt,
    teamIds: ['LEGACY_PRIVATE_TEAM'],
    trackedFiles: [{
      key: 'LEGACY22',
      url: legacyUrl,
      scopeMode: 'current-page',
      lockStatus: 'locked',
      lockedPageId: '7:9',
      lockedPageName: 'Private Page',
    }],
    warnings: [],
  };

  const fresh = (await callIpc('projects:get-all')).find(item => item.id === project.id);
  assert.equal(fresh.figmaTrackedFiles.length, 1);
  assert.equal(fresh.figmaTrackedFiles[0].key, 'LEGACY22');
  assert.equal(fresh.figmaTrackedFiles[0].requestedPageId, '7:9');
  assert.equal(fresh.figmaTrackedFiles[0].url, undefined);
  assert.equal(fresh.figmaSession.trackedFiles[0].requestedPageId, '7:9');
  assert.equal(fresh.figmaSession.trackedFiles[0].lockStatus, 'locked');
  assert.equal(fresh.figmaSession.trackedFiles[0].lockedPageId, '7:9');
  assert.equal(fresh.figmaSession.trackedFiles[0].lockedPageName, 'Private Page');
  assert.equal(fresh.figmaSession.trackedFiles[0].url, undefined);
  assert.deepEqual(fresh.figmaSession.teamIds, []);
  assert.equal(JSON.stringify(fresh).includes(legacyUrl), false);
  assert.equal(JSON.stringify(fresh).includes('LEGACY_PRIVATE_TEAM'), false);
});

test('legacy session-only locator migration preserves the connection and valid URL scope', async () => {
  const project = await callIpc(
    'projects:create',
    'Legacy Session-Only Figma Migration',
    'branding',
    'current-page',
    null
  );
  const legacyUrl = 'https://www.figma.com/design/SESSION44/Private-Project?page-id=8%3A4';
  const legacy = (await callIpc('projects:get-all')).find(item => item.id === project.id);
  legacy.figmaTrackedFiles = [];
  legacy.figmaSession = {
    scopeMode: 'current-page',
    startedAt: legacy.watchStartedAt,
    teamIds: [],
    trackedFiles: [{
      key: 'SESSION44',
      url: legacyUrl,
      requestedPageId: '   ',
      scopeMode: 'current-page',
      lockStatus: 'locked',
      lockedPageId: '8:4',
      lockedPageName: 'Private Page',
    }],
    warnings: [],
  };

  const fresh = (await callIpc('projects:get-all')).find(item => item.id === project.id);
  assert.equal(fresh.figmaTrackedFiles.length, 1);
  assert.equal(fresh.figmaTrackedFiles[0].key, 'SESSION44');
  assert.equal(fresh.figmaTrackedFiles[0].requestedPageId, '8:4');
  assert.equal(fresh.figmaSession.trackedFiles[0].requestedPageId, '8:4');
  assert.equal(fresh.figmaSession.trackedFiles[0].lockedPageName, 'Private Page');
  assert.equal(JSON.stringify(fresh).includes(legacyUrl), false);
});

test('legacy migration keeps page and node scope as one atomic locator tuple', async () => {
  const project = await callIpc(
    'projects:create',
    'Legacy Atomic Figma Scope Migration',
    'branding',
    'current-page',
    null
  );
  const legacy = (await callIpc('projects:get-all')).find(item => item.id === project.id);
  legacy.figmaTrackedFiles = [{ key: 'ATOMIC44', requestedNodeId: '2:1' }];
  legacy.figmaSession = {
    scopeMode: 'current-page',
    startedAt: legacy.watchStartedAt,
    teamIds: [],
    trackedFiles: [{
      key: 'ATOMIC44',
      requestedPageId: '7:9',
      scopeMode: 'current-page',
      lockStatus: 'locked',
      lockedPageId: '7:9',
      lockedPageName: 'Stale Legacy Page',
    }],
    warnings: [],
  };

  const fresh = (await callIpc('projects:get-all')).find(item => item.id === project.id);
  assert.equal(fresh.figmaTrackedFiles[0].requestedPageId, null);
  assert.equal(fresh.figmaTrackedFiles[0].requestedNodeId, '2:1');
  assert.equal(fresh.figmaSession.trackedFiles[0].requestedPageId, null);
  assert.equal(fresh.figmaSession.trackedFiles[0].requestedNodeId, '2:1');
  assert.equal(fresh.figmaSession.trackedFiles[0].lockStatus, 'pending');
  assert.equal(fresh.figmaSession.trackedFiles[0].lockedPageId, null);
  assert.equal(JSON.stringify(fresh).includes('Stale Legacy Page'), false);
});

test('legacy migration rebuilds unmatched Current Page Only session entries fail closed', async () => {
  const project = await callIpc(
    'projects:create',
    'Legacy Unmatched Session Migration',
    'branding',
    'current-page',
    null
  );
  const legacy = (await callIpc('projects:get-all')).find(item => item.id === project.id);
  legacy.figmaTrackedFiles = [{ key: 'SAFELOCATOR' }];
  legacy.figmaSession = {
    scopeMode: 'current-page',
    startedAt: legacy.watchStartedAt,
    teamIds: [],
    trackedFiles: [{
      key: 'DIFFERENTKEY',
      scopeMode: 'entire-file',
      lockStatus: 'entire-file',
    }],
    warnings: [],
  };

  const fresh = (await callIpc('projects:get-all')).find(item => item.id === project.id);
  assert.equal(fresh.figmaSession.scopeMode, 'current-page');
  assert.equal(fresh.figmaSession.trackedFiles.length, 1);
  assert.equal(fresh.figmaSession.trackedFiles[0].key, 'SAFELOCATOR');
  assert.equal(fresh.figmaSession.trackedFiles[0].scopeMode, 'current-page');
  assert.equal(fresh.figmaSession.trackedFiles[0].lockStatus, 'unresolved');
  assert.equal(fresh.figmaSession.trackedFiles[0].statusReason, 'figma-current-page-no-page-or-node-param');
  assert.match(fresh.figmaSession.trackedFiles[0].warning, /No Figma assets will be captured/i);
  assert.equal(JSON.stringify(fresh).includes('DIFFERENTKEY'), false);
});

test('legacy migration drops malformed keys and untrusted scope identifiers', async () => {
  const project = await callIpc(
    'projects:create',
    'Legacy Malformed Locator Migration',
    'branding',
    'current-page',
    null
  );
  const legacy = (await callIpc('projects:get-all')).find(item => item.id === project.id);
  const opaqueValue = 'OPAQUE_LEGACY_SCOPE_VALUE';
  const privatePath = '/uSeRs/synthetic/Private\r\nProject/file.fig';
  legacy.figmaTrackedFiles = [
    `https://attacker.example/${opaqueValue}`,
    { key: `Authorization:Bearer-${opaqueValue}` },
    { key: 'VALIDLOCATOR', requestedPageId: `https://attacker.example/?token=${opaqueValue}` },
  ];
  legacy.figmaSession = {
    scopeMode: 'current-page',
    startedAt: legacy.watchStartedAt,
    teamIds: [],
    sessionWarnings: [
      `Authorization: Bearer ${opaqueValue}`,
      `Could not read ${privatePath} while scanning project.`,
    ],
    trackedFiles: [{
      key: 'VALIDLOCATOR',
      requestedPageId: `Bearer ${opaqueValue}`,
      scopeMode: 'current-page',
      lockStatus: 'locked',
      lockedPageId: `https://attacker.example/${opaqueValue}`,
    }],
    warnings: [],
  };

  const fresh = (await callIpc('projects:get-all')).find(item => item.id === project.id);
  assert.equal(fresh.figmaTrackedFiles.length, 1);
  assert.equal(fresh.figmaTrackedFiles[0].key, 'VALIDLOCATOR');
  assert.equal(fresh.figmaTrackedFiles[0].requestedPageId, null);
  assert.equal(fresh.figmaSession.trackedFiles.length, 1);
  assert.equal(fresh.figmaSession.trackedFiles[0].scopeMode, 'current-page');
  assert.equal(fresh.figmaSession.trackedFiles[0].lockStatus, 'unresolved');
  assert.deepEqual(fresh.figmaSession.sessionWarnings, [
    '[redacted-credential]',
    'Could not read [redacted-path]',
  ]);
  assert.equal(JSON.stringify(fresh).includes(opaqueValue), false);
  assert.equal(JSON.stringify(fresh).includes('attacker.example'), false);
  assert.equal(JSON.stringify(fresh).includes(privatePath), false);
  assert.equal(JSON.stringify(fresh).includes('Project/file.fig'), false);

  const persistedProjectsWrite = [...fakeStoreSetHistory]
    .reverse()
    .find(entry => entry.key === 'projects');
  assert.ok(persistedProjectsWrite, 'migration should persist the sanitized projects payload');
  const persistedProject = JSON.parse(JSON.stringify(persistedProjectsWrite.value))
    .find(item => item.id === project.id);
  assert.ok(persistedProject);
  assert.deepEqual(persistedProject.figmaSession.sessionWarnings, [
    '[redacted-credential]',
    'Could not read [redacted-path]',
  ]);
  assert.equal(JSON.stringify(persistedProject).includes(privatePath), false);
  assert.equal(JSON.stringify(persistedProject).includes('Project/file.fig'), false);

  const migratedAgain = (await callIpc('projects:get-all')).find(item => item.id === project.id);
  assert.deepEqual(migratedAgain.figmaSession.sessionWarnings, [
    '[redacted-credential]',
    'Could not read [redacted-path]',
  ]);
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

  nextFigmaScanResult = figmaScanResult([], [{
    fileKey: primaryKey,
    primaryKey,
    fileName: 'Petra Logo',
    scopeMode: 'current-page',
    lockStatus: 'unresolved',
    lockedPageId: null,
    lockedPageName: null,
      warning: 'Primary candidate could not be read.',
      fileFetchStatus: 'failed',
      fileFetchFailureReason: 'not-found',
      assetFetchStatus: 'not-attempted',
  }, {
    fileKey: fallbackKey,
    primaryKey,
    fileName: 'Petra Logo',
    scopeMode: 'current-page',
    lockStatus: 'locked',
    lockedPageId: '1:1',
    lockedPageName: 'Page One',
    warning: null,
    fileFetchStatus: 'success',
    fileFetchFailureReason: null,
    assetFetchStatus: 'success',
  }]);
  nextFigmaScanResult.errors = ['Primary candidate metadata was unavailable.'];
  const prePackage = await callIpc('projects:pre-package-scan', project.id);
  assert.equal(prePackage.error, undefined);

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

test('figma:connect keeps the working token when a replacement is invalid', async () => {
  storedFigmaToken = 'WORKING_TOKEN_VALUE';
  nextFigmaTokenVerification = { valid: false, reason: 'invalid-token' };

  const connected = await callIpc('figma:connect', 'INVALID_REPLACEMENT_VALUE');

  assert.deepEqual(connected, { success: false, error: 'invalid_token' });
  assert.equal(storedFigmaToken, 'WORKING_TOKEN_VALUE');
});

test('figma:connect keeps the working token when secure storage is unavailable', async () => {
  storedFigmaToken = 'WORKING_TOKEN_VALUE';
  nextFigmaTokenVerification = { valid: true };
  nextFigmaStoreResult = false;

  const connected = await callIpc('figma:connect', 'VALID_REPLACEMENT_VALUE');

  assert.deepEqual(connected, { success: false, error: 'secure_storage_unavailable' });
  assert.equal(storedFigmaToken, 'WORKING_TOKEN_VALUE');
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

test('oversized Figma asset is rejected before cache or provenance mutation', async () => {
  const project = await createLinkedFigmaProject('Figma Oversized Asset');
  let bodyRead = false;
  fetchHandler = async () => ({
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-length'
          ? String(FIGMA_NETWORK_LIMITS.assetResponseBytes + 1)
          : null;
      },
    },
    buffer: async () => {
      bodyRead = true;
      return Buffer.from('must not be read');
    },
  });
  nextFigmaScanResult = figmaScanResult([{
    url: 'https://cdn.figma.example/oversized.png?token=SHOULD_NOT_APPEAR_TOKEN',
    nodeId: 'node-oversized',
    imageRef: 'img-oversized',
    name: 'Oversized',
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
  assert.equal(bodyRead, false);
  assert.equal(fresh.files.length, 0);
  assert.equal(getProvenanceNodes(fresh, NODE_TYPES.CLOUD_DOCUMENT).length, 0);
  assert.equal(getProvenanceNodes(fresh, NODE_TYPES.EMBEDDED_RESOURCE).length, 0);
  assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE).length, 0);
  assert.equal(output.includes('SHOULD_NOT_APPEAR_TOKEN'), false);
  assert.equal(output.includes('cdn.figma.example'), false);
});

test('pre-package Figma download failure blocks output until a clean retry succeeds', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-figma-download-block-'));
  try {
    const project = await createLinkedFigmaProject('Figma Download Block');
    const asset = {
      url: 'https://cdn.figma.example/oversized.png?token=SHOULD_NOT_APPEAR_TOKEN',
      nodeId: 'node-oversized',
      imageRef: 'img-oversized',
      name: 'Oversized',
      format: 'png',
      figmaFileKey: 'FIG22',
      figmaFileName: 'Brand Cloud',
      figmaPageId: '1:1',
      figmaPageName: 'Page One',
    };
    const successfulScopeEntries = [{
      fileKey: 'FIG22',
      primaryKey: 'FIG22',
      fileName: 'Brand Cloud',
      scopeMode: 'current-page',
      lockStatus: 'locked',
      lockedPageId: '1:1',
      lockedPageName: 'Page One',
      warning: null,
      fileFetchStatus: 'success',
      fileFetchFailureReason: null,
      assetFetchStatus: 'success',
    }];
    nextFigmaScanResult = figmaScanResult([asset], successfulScopeEntries);
    fetchHandler = async () => ({
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return String(name).toLowerCase() === 'content-length'
            ? String(FIGMA_NETWORK_LIMITS.assetResponseBytes + 1)
            : null;
        },
      },
      buffer: async () => Buffer.from('must not be read'),
    });

    const scan = await callIpc('projects:pre-package-scan', project.id);
    assert.match(scan.error, /could not securely retrieve all Figma assets/i);

    const outputDir = path.join(tmpRoot, 'blocked-output');
    const blocked = await callIpc('projects:package', project.id, outputDir);
    assert.match(blocked.error, /could not securely retrieve all Figma assets/i);
    assert.equal(fs.existsSync(outputDir), false);

    nextFigmaScanResult = figmaRateLimitedScanResult();
    const rateLimitedRetry = await callIpc('projects:pre-package-scan', project.id);
    assert.match(rateLimitedRetry.error, /could not securely retrieve all Figma assets/i);
    const stillBlocked = await callIpc('projects:package', project.id, outputDir);
    assert.match(stillBlocked.error, /could not securely retrieve all Figma assets/i);
    assert.equal(fs.existsSync(outputDir), false);

    nextFigmaScanResult = figmaScanResult([], [{
      ...successfulScopeEntries[0],
      assetFetchStatus: 'failed',
    }]);
    nextFigmaScanResult.errors = ['Figma asset recovery failed.'];
    const assetRecoveryRetry = await callIpc('projects:pre-package-scan', project.id);
    assert.match(assetRecoveryRetry.error, /could not securely retrieve all Figma assets/i);
    const assetRecoveryBlocked = await callIpc('projects:package', project.id, outputDir);
    assert.match(assetRecoveryBlocked.error, /could not securely retrieve all Figma assets/i);
    assert.equal(fs.existsSync(outputDir), false);

    nextFigmaScanResult = figmaScanResult([asset], successfulScopeEntries);
    setFigmaDownloadResponse('recovered asset');
    const retryScan = await callIpc('projects:pre-package-scan', project.id);
    assert.equal(retryScan.error, undefined);

    const packaged = await callIpc('projects:package', project.id, outputDir);
    assert.equal(packaged.success, true);
    assert.equal(packaged.copiedCount, 1);
    assert.equal(
      fs.readFileSync(path.join(packageFolder(outputDir, 'Figma Download Block'), 'Brand_Cloud_Oversized.png'), 'utf8'),
      'recovered asset'
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('pre-package recovery requires one successful candidate for every tracked Figma link', async () => {
  const project = await createLinkedFigmaProject('Figma Multi-Link Recovery');
  const projects = fakeStoreInstance.get('projects');
  const storedProject = projects.find(item => item.id === project.id);
  const secondLocator = JSON.parse(JSON.stringify(storedProject.figmaTrackedFiles[0]));
  secondLocator.key = 'FIG33';
  secondLocator.candidateKeys = ['FIG33'];
  secondLocator.candidateKeyDetails = [{ key: 'FIG33', source: 'direct-route' }];
  secondLocator.requestedPageId = '2:2';
  secondLocator.requestedNodeId = null;
  storedProject.figmaTrackedFiles.push(secondLocator);
  storedProject.figmaSession = null;
  fakeStoreInstance.set('projects', projects);

  const successfulScope = (fileKey, pageId) => ({
    fileKey,
    primaryKey: fileKey,
    fileName: `Tracked ${fileKey}`,
    scopeMode: 'current-page',
    lockStatus: 'locked',
    lockedPageId: pageId,
    lockedPageName: `Page ${pageId}`,
    warning: null,
    fileFetchStatus: 'success',
    fileFetchFailureReason: null,
    assetFetchStatus: 'success',
  });

  nextFigmaScanResult = figmaScanResult([], [successfulScope('FIG22', '1:1')]);
  const incompleteScan = await callIpc('projects:pre-package-scan', project.id);
  assert.match(incompleteScan.error, /could not securely retrieve all Figma assets/i);

  nextFigmaScanResult = figmaScanResult([], [
    successfulScope('FIG22', '1:1'),
    successfulScope('FIG33', '2:2'),
  ]);
  const completeScan = await callIpc('projects:pre-package-scan', project.id);
  assert.equal(completeScan.error, undefined);
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

test('Figma asset caching fails closed when owner-only permissions cannot be verified', async () => {
  if (process.platform === 'win32') return;

  const project = await createLinkedFigmaProject('Figma Cache Permission Failure');
  setFigmaDownloadResponse('permission failure figma bytes');
  nextFigmaScanResult = figmaScanResult([{
    url: 'https://cdn.figma.example/permission-failure.png?token=SHOULD_NOT_APPEAR_TOKEN',
    nodeId: 'node-permission-failure',
    imageRef: 'img-permission-failure',
    name: 'Permission Failure',
    format: 'png',
    figmaFileKey: 'FIG22',
    figmaFileName: 'Brand Cloud',
    figmaPageId: '1:1',
    figmaPageName: 'Page One',
  }]);

  const originalFchmod = fs.fchmodSync;
  fs.fchmodSync = (fd, mode) => {
    if (fs.fstatSync(fd).isFile() && mode === 0o600) {
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    }
    return originalFchmod.call(fs, fd, mode);
  };
  try {
    const { output } = await captureConsole(() => callIpc('figma:scan-project', project.id));
    const fresh = (await callIpc('projects:get-all')).find(item => item.id === project.id);
    assert.equal(fresh.files.some(file => file.source === 'figma-auto'), false);
    const cacheDir = projectCacheDir('figma-assets', project.id);
    assert.deepEqual(fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : [], [], 'failed cache write must leave no asset bytes');
    assert.equal(output.includes(TEST_HOME), false);
    assert.equal(output.includes('SHOULD_NOT_APPEAR_TOKEN'), false);
  } finally {
    fs.fchmodSync = originalFchmod;
  }
});

test('active Figma scan finalizer does not traverse project cache categories', async () => {
  const project = await createLinkedFigmaProject('Active Figma Finalizer');
  nextFigmaScanResult = figmaScanResult([]);
  const originalOpendir = fs.promises.opendir;
  const categoryPaths = new Set(
    ['figma-assets', 'presentation-assets'].map(category => path.resolve(TEST_HOME, '.crate', category))
  );
  let categoryTraversals = 0;
  fs.promises.opendir = async (targetPath, ...args) => {
    if (categoryPaths.has(path.resolve(targetPath))) categoryTraversals += 1;
    return originalOpendir.call(fs.promises, targetPath, ...args);
  };
  try {
    assert.equal((await callIpc('figma:scan-project', project.id)).success, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(categoryTraversals, 0, 'an active-project finalizer should not schedule a cache sweep');
  } finally {
    fs.promises.opendir = originalOpendir;
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
  fs.unlinkSync(projectDir);
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
  const compoundCookieValue = 'opaqueRefreshValue123';
  const jsonCookieValue = 'opaqueJsonValue456';
  const jsonAuthorizationValue = 'opaqueAuthValue789';
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
    `scan failed ${sensitiveFigmaUrl} ${sensitiveCdnUrl} Authorization: Bearer OPAQUE_CREDENTIAL_VALUE cookie=SHOULD_NOT_APPEAR_COOKIE /Users/designer/private/log-asset.png`,
    '{"Authorization":"Bearer OPAQUE_JSON_CREDENTIAL","cookie":"OPAQUE_JSON_COOKIE"}',
    `Cookie: sid=one; refresh=${compoundCookieValue}; region=us-east`,
    `{"cookie":"${jsonCookieValue}","Authorization":"Bearer ${jsonAuthorizationValue}"}`,
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
  assert.match(output, /"keyPresent":true/);
  assert.match(output, /fileKeyPresent=true/);
  assert.match(output, /localName=Brand_Cloud_Log_Privacy_Asset\.png/);
  assert.match(output, /\[redacted-url\]/);
  assert.doesNotMatch(output, /FIGLOG/);
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
    'OPAQUE_CREDENTIAL_VALUE',
    'OPAQUE_JSON_CREDENTIAL',
    'OPAQUE_JSON_COOKIE',
    compoundCookieValue,
    jsonCookieValue,
    jsonAuthorizationValue,
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

test('Figma scan failures are sanitized before renderer IPC', async () => {
  const sensitiveUrl = 'https://api.figma.com/v1/files/PRIVATEFILE?token=SHOULD_NOT_REACH_RENDERER';
  const opaqueCredential = 'OPAQUE_RENDERER_ACCESS_VALUE';
  const privatePath = '/users/designer/private/client/file.fig';
  const temporaryPath = '/TMP/crate-private/client/file.fig';
  const privateTemporaryPath = '/PRIVATE/TMP/crate-private/client/file.fig';
  const spacedPrivateTemporaryPath = '/private/TmP/neutral client/file.fig';
  const project = await callIpc(
    'projects:create',
    'Figma Renderer Error Privacy',
    'branding',
    'current-page',
    'https://www.figma.com/file/RENDER44/Renderer-Privacy?page-id=1%3A1'
  );
  storedFigmaToken = 'test-token';
  nextFigmaScanError = new Error(
    `request failed ${sensitiveUrl} {"accessToken":"${opaqueCredential}"} ${privatePath} ${temporaryPath} ${privateTemporaryPath} ${spacedPrivateTemporaryPath} while scanning project.`
  );

  const activate = electronAppHandlers.get('activate');
  assert.equal(typeof activate, 'function');
  activate();
  rendererMessages.length = 0;

  const scan = await callIpc('figma:scan-project', project.id);
  assert.equal(scan.success, true);
  const scanError = rendererMessages.find(message => message.channel === 'figma:scan-error');
  assert.ok(scanError, 'renderer should receive a sanitized scan-error event');

  const rendererText = JSON.stringify(scanError.data);
  assert.match(rendererText, /redacted/);
  assert.equal(rendererText.includes(sensitiveUrl), false);
  assert.equal(rendererText.includes('api.figma.com'), false);
  assert.equal(rendererText.includes(opaqueCredential), false);
  assert.equal(rendererText.includes('accessToken'), false);
  assert.equal(rendererText.includes(privatePath), false);
  assert.equal(rendererText.includes(temporaryPath), false);
  assert.equal(rendererText.includes(privateTemporaryPath), false);
  assert.equal(rendererText.includes(spacedPrivateTemporaryPath), false);
  assert.equal(rendererText.includes('neutral client/file.fig'), false);
  assert.equal(rendererText.includes('client/file.fig'), false);
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
    assert.equal(manifest.nodes.filter(node => node.type === NODE_TYPES.EMBEDDED_RESOURCE).length, 1);
    assert.equal(manifest.nodes.every(node => Object.keys(node).sort().join(',') === 'id,type'), true);

    const manifestText = JSON.stringify(manifest);
    assert.equal(manifestText.includes('FIG22'), false);
    assert.doesNotMatch(manifestText, /(?:^|[^0-9])1:1(?:[^0-9]|$)/);
    assert.equal(manifestText.includes('img-in-scope'), false);
    assert.equal(manifestText.includes('img-out-of-scope'), false);
    assert.equal(manifestText.includes('Out Of Scope'), false);
    assert.equal(manifestText.includes('SHOULD_NOT_APPEAR_TOKEN'), false);
    assert.equal(manifestText.includes('cdn.figma.example'), false);
    assert.equal(manifestText.includes('/usr/sbin/lsof'), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
