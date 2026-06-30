const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const os = require('os');
const path = require('path');

test('main window uses normal macOS app lifecycle', async () => {
  const originalResolve = Module._resolveFilename;
  const originalLoad = Module._load;
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalConsoleError = console.error;
  const stubs = new Map();
  const appHandlers = new Map();
  const ipcHandlers = new Map();
  const windows = [];
  const trays = [];
  const intervals = new Set();
  const timeouts = new Set();
  const errorLogs = [];
  let appReady = false;
  let readyCallback = null;
  let appFocusCount = 0;
  let appShowCount = 0;

  function setStub(name, factory) {
    stubs.set(name, factory);
  }

  Module._resolveFilename = function patchedResolve(request, parent, ...rest) {
    if (stubs.has(request)) return `\0stub:${request}`;
    return originalResolve.call(this, request, parent, ...rest);
  };

  Module._load = function patchedLoad(request, parent, ...rest) {
    if (stubs.has(request)) return stubs.get(request)();
    return originalLoad.call(this, request, parent, ...rest);
  };

  global.setInterval = function trackedSetInterval(fn, delay, ...args) {
    const interval = { fn, delay, args };
    intervals.add(interval);
    return interval;
  };

  global.clearInterval = function trackedClearInterval(interval) {
    intervals.delete(interval);
  };

  global.setTimeout = function trackedSetTimeout(fn, delay, ...args) {
    const timeout = {
      fn,
      delay,
      args,
      unref() { this.unrefed = true; },
    };
    timeouts.add(timeout);
    return timeout;
  };

  global.clearTimeout = function trackedClearTimeout(timeout) {
    timeouts.delete(timeout);
  };

  console.error = (...args) => {
    errorLogs.push(args.join(' '));
  };

  class TestBrowserWindow {
    constructor(options) {
      this.options = options;
      this.handlers = new Map();
      this.webContents = {
        handlers: new Map(),
        send: () => {},
        on(channel, fn) { this.handlers.set(channel, fn); },
        once(channel, fn) { this.handlers.set(channel, fn); },
      };
      this.destroyed = false;
      this.minimized = false;
      this.showCount = 0;
      this.focusCount = 0;
      this.restoreCount = 0;
      this.moveTopCount = 0;
      this.focusable = options.focusable !== false;
      this.ignoreMouseEvents = false;
      windows.push(this);
    }

    static getAllWindows() {
      return windows.filter(win => !win.destroyed);
    }

    loadFile(filePath) {
      this.loadedFile = filePath;
      return Promise.resolve();
    }
    on(channel, fn) { this.handlers.set(channel, fn); }
    once(channel, fn) { this.handlers.set(channel, fn); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.showCount > 0 && !this.destroyed; }
    isMinimized() { return this.minimized; }
    restore() {
      this.minimized = false;
      this.restoreCount += 1;
    }
    show() { this.showCount += 1; }
    focus() { this.focusCount += 1; }
    moveTop() { this.moveTopCount += 1; }
    setFocusable(value) { this.focusable = value; }
    setIgnoreMouseEvents(value) { this.ignoreMouseEvents = value; }
    destroy() { this.destroyed = true; }
  }

  class TestTray {
    constructor() {
      this.handlers = new Map();
      trays.push(this);
    }

    setToolTip(value) { this.tooltip = value; }
    on(channel, fn) { this.handlers.set(channel, fn); }
    isDestroyed() { return false; }
    destroy() { this.destroyed = true; }
  }

  class FakeStore {
    constructor(opts = {}) {
      this.data = JSON.parse(JSON.stringify(opts.defaults || {}));
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
      const parts = key.split('.');
      let cur = this.data;
      for (let i = 0; i < parts.length - 1; i += 1) {
        if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = value;
    }
  }

  setStub('electron', () => ({
    app: {
      requestSingleInstanceLock: () => true,
      quit: () => {},
      whenReady: () => ({
        then(fn) {
          readyCallback = fn;
        }
      }),
      on(channel, fn) { appHandlers.set(channel, fn); },
      isReady: () => appReady,
      show: () => { appShowCount += 1; },
      focus: () => { appFocusCount += 1; },
      getPath: () => path.join(os.tmpdir(), 'crate-main-window-test-userdata'),
      dock: { setMenu: () => {} },
    },
    BrowserWindow: TestBrowserWindow,
    Tray: TestTray,
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
    Notification: class { static isSupported() { return false; } },
    Menu: { buildFromTemplate: () => ({}) },
  }));
  setStub('electron-store', () => FakeStore);
  setStub('chokidar', () => ({ watch: () => ({ on: () => {}, close: () => {}, add: () => {}, unwatch: () => {} }) }));
  setStub('node-fetch', () => async () => ({ ok: false, status: 500, json: async () => ({}) }));

  try {
    require('../main');

    assert.equal(typeof readyCallback, 'function');
    appReady = true;
    await readyCallback();

    assert.equal(windows.length, 1);
    const win = windows[0];
    assert.equal(win.options.width, 960);
    assert.equal(win.options.height, 760);
    assert.equal(win.options.minWidth, 720);
    assert.equal(win.options.minHeight, 560);
    assert.equal(win.options.show, true);
    assert.equal(win.options.focusable, true);
    assert.equal(win.options.frame, true);
    assert.equal(win.options.resizable, true);
    assert.equal(win.options.movable, true);
    assert.equal(win.options.minimizable, true);
    assert.equal(win.options.maximizable, true);
    assert.equal(win.options.closable, true);
    assert.equal(win.options.alwaysOnTop, false);
    assert.equal(win.options.skipTaskbar, false);
    assert.equal(win.options.transparent, false);
    assert.equal(win.options.backgroundColor, '#ffffff');
    assert.ok(win.loadedFile.endsWith(path.join('renderer', 'index.html')));
    assert.equal(typeof win.handlers.get('ready-to-show'), 'function');
    assert.equal(typeof win.webContents.handlers.get('did-finish-load'), 'function');
    assert.equal(typeof win.webContents.handlers.get('did-fail-load'), 'function');
    assert.equal(typeof win.webContents.handlers.get('render-process-gone'), 'function');
    assert.equal(win.showCount, 1);
    assert.equal(win.focusCount, 1);
    assert.equal(win.moveTopCount, 1);
    assert.equal(win.focusable, true);
    assert.equal(win.ignoreMouseEvents, false);
    assert.equal(appShowCount, 1);
    assert.equal(appFocusCount, 1);
    assert.equal(trays.length, 1);
    assert.deepEqual(
      [...timeouts].map(timeout => timeout.delay).sort((a, b) => a - b),
      [500, 1500, 1500, 5000, 10000]
    );
    assert.ok([...timeouts].every(timeout => timeout.unrefed === true));

    win.webContents.handlers.get('did-fail-load')({}, -6, 'ERR_FILE_NOT_FOUND');
    assert.equal(win.showCount, 2);
    assert.equal(win.focusCount, 2);
    assert.equal(appShowCount, 2);
    assert.equal(appFocusCount, 2);
    assert.ok(errorLogs.some((line) => line.includes('[main-window] renderer failed to load')));

    trays[0].handlers.get('click')();
    assert.equal(win.showCount, 3);
    assert.equal(win.focusCount, 3);

    win.minimized = true;
    appHandlers.get('activate')();
    assert.equal(win.restoreCount, 1);
    assert.equal(win.showCount, 4);
    assert.equal(win.focusCount, 4);

    appHandlers.get('did-become-active')();
    assert.equal(win.showCount, 5);
    assert.equal(win.focusCount, 5);

    win.destroyed = true;
    win.handlers.get('closed')();
    let preventedWindowCloseQuit = false;
    appHandlers.get('window-all-closed')({
      preventDefault() { preventedWindowCloseQuit = true; }
    });
    assert.equal(preventedWindowCloseQuit, true);
    appHandlers.get('second-instance')();
    assert.equal(windows.length, 2);
    assert.equal(windows[1].showCount, 1);
    assert.equal(windows[1].focusCount, 1);
  } finally {
    Module._resolveFilename = originalResolve;
    Module._load = originalLoad;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    console.error = originalConsoleError;
    intervals.clear();
    timeouts.clear();
  }
});
