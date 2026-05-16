const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify: nodePromisify } = require('util');

const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;
const activeTimeouts = new Set();

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

class TestBrowserWindow {
  constructor() {
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
  static isSupported() { return false; }
  show() {}
  on() {}
}

setStub('electron', () => ({
  app: {
    requestSingleInstanceLock: () => true,
    quit: () => {},
    whenReady: () => ({ then: () => {} }),
    on: () => {},
    getPath: () => path.join(os.tmpdir(), 'crate-test-userdata'),
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
  return handler({}, ...args);
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

test.afterEach(() => {
  currentPsdFixture = { children: [], linkedFiles: [] };
  if (storeInstance) storeInstance.set('projects', []);
  clearTrackedTimeouts();
});

test.after(() => {
  clearTrackedTimeouts();
  global.setTimeout = originalSetTimeout;
  global.clearTimeout = originalClearTimeout;
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

    const result = await callIpc('projects:package', 'psd-package-safety', outputDir);
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
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
