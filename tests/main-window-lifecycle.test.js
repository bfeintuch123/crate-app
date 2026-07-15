const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

test('main window uses normal macOS app lifecycle', async () => {
  const originalResolve = Module._resolveFilename;
  const originalLoad = Module._load;
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  const stubs = new Map();
  const appHandlers = new Map();
  const ipcHandlers = new Map();
  const windows = [];
  const trays = [];
  const intervals = new Set();
  const timeouts = new Set();
  const errorLogs = [];
  const isolatedHome = path.join(os.tmpdir(), `crate-main-window-test-home-${process.pid}-${Date.now()}`);
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
  console.warn = () => {};

  class TestBrowserWindow {
    constructor(options) {
      this.options = options;
      this.handlers = new Map();
      this.webContents = {
        handlers: new Map(),
        send: () => {},
        on(channel, fn) { this.handlers.set(channel, fn); },
        once(channel, fn) { this.handlers.set(channel, fn); },
        setWindowOpenHandler(fn) { this.windowOpenHandler = fn; },
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
      return windows.filter(win => !win.destroyed && !win.detached);
    }

    static fromWebContents(webContents) {
      return windows.find(win => win.webContents === webContents && !win.destroyed && !win.detached) || null;
    }

    loadFile(filePath) {
      this.loadedFile = filePath;
      return Promise.resolve();
    }
    on(channel, fn) { this.handlers.set(channel, fn); }
    once(channel, fn) { this.handlers.set(channel, fn); }
    isDestroyed() { return this.destroyed; }
    isVisible() {
      return this.showCount > 0 && !this.destroyed && !this.forceHidden;
    }
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
      this.path = path.join(isolatedHome, 'user-data', 'config.json');
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      fs.writeFileSync(this.path, '{}', { mode: 0o600 });
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
      getPath: () => path.join(isolatedHome, 'user-data'),
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
      showErrorBox: () => {},
    },
    shell: { openPath: () => {} },
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }), createEmpty: () => ({}) },
    Notification: class { static isSupported() { return false; } },
    Menu: { buildFromTemplate: () => ({}) },
  }));
  setStub('electron-store', () => FakeStore);
  setStub('os', () => ({ ...os, homedir: () => isolatedHome }));
  setStub('uuid', () => ({ v4: () => '00000000-0000-4000-8000-000000000001' }));
  setStub('ag-psd', () => ({ readPsd: () => ({}) }));
  setStub('chokidar', () => ({ watch: () => ({ on: () => {}, close: () => {}, add: () => {}, unwatch: () => {} }) }));
  setStub('node-fetch', () => async () => ({ ok: false, status: 500, json: async () => ({}) }));

  const isolatedOrphanCache = path.join(
    isolatedHome,
    '.crate',
    'figma-assets',
    '00000000-0000-4000-8000-000000000099'
  );
  fs.mkdirSync(isolatedOrphanCache, { recursive: true });
  fs.writeFileSync(path.join(isolatedOrphanCache, 'stale.bin'), 'isolated stale cache');

  try {
    require('../main');

    assert.equal(typeof readyCallback, 'function');
    appReady = true;
    await readyCallback();

    const cleanupDeadline = Date.now() + 1000;
    while (fs.existsSync(isolatedOrphanCache) && Date.now() < cleanupDeadline) {
      await new Promise(resolve => originalSetTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(isolatedOrphanCache), false, 'startup cleanup must stay inside the isolated test home');

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
    assert.equal(win.options.webPreferences.nodeIntegration, false);
    assert.equal(win.options.webPreferences.contextIsolation, true);
    assert.equal(win.options.webPreferences.sandbox, true);
    assert.equal(win.options.webPreferences.webSecurity, true);
    assert.equal(win.options.webPreferences.allowRunningInsecureContent, false);
    assert.ok(win.loadedFile.endsWith(path.join('renderer', 'index.html')));
    assert.equal(typeof win.handlers.get('ready-to-show'), 'function');
    assert.equal(typeof win.webContents.handlers.get('did-finish-load'), 'function');
    assert.equal(typeof win.webContents.handlers.get('did-fail-load'), 'function');
    assert.equal(typeof win.webContents.handlers.get('render-process-gone'), 'function');
    assert.equal(typeof win.webContents.handlers.get('will-navigate'), 'function');
    assert.equal(typeof win.webContents.handlers.get('will-redirect'), 'function');
    assert.equal(typeof win.webContents.windowOpenHandler, 'function');

    const rendererUrl = pathToFileURL(win.loadedFile).href;
    const mainFrame = { url: rendererUrl };
    win.webContents.mainFrame = mainFrame;
    const trustedEvent = { sender: win.webContents, senderFrame: mainFrame };
    assert.deepEqual(ipcHandlers.get('projects:get-all')(trustedEvent), []);
    assert.equal(ipcHandlers.size, 30);
    assert.throws(
      () => ipcHandlers.get('projects:get-all')({}),
      /blocked an untrusted renderer request/
    );
    const childFrame = { url: rendererUrl };
    assert.throws(
      () => ipcHandlers.get('projects:get-all')({ sender: win.webContents, senderFrame: childFrame }),
      /blocked an untrusted renderer request/
    );
    const otherWebContents = { mainFrame };
    assert.throws(
      () => ipcHandlers.get('projects:get-all')({ sender: otherWebContents, senderFrame: mainFrame }),
      /blocked an untrusted renderer request/
    );
    const remoteMainFrame = { url: 'https://example.com/' };
    win.webContents.mainFrame = remoteMainFrame;
    for (const handler of ipcHandlers.values()) {
      assert.throws(
        () => handler({ sender: win.webContents, senderFrame: remoteMainFrame }),
        /blocked an untrusted renderer request/
      );
    }
    const queryMainFrame = { url: `${rendererUrl}?untrusted=1` };
    win.webContents.mainFrame = queryMainFrame;
    assert.throws(
      () => ipcHandlers.get('projects:get-all')({ sender: win.webContents, senderFrame: queryMainFrame }),
      /blocked an untrusted renderer request/
    );
    for (const bareQueryUrl of [`${rendererUrl}?`, `${rendererUrl}?#settings`]) {
      const bareQueryFrame = { url: bareQueryUrl };
      win.webContents.mainFrame = bareQueryFrame;
      assert.throws(
        () => ipcHandlers.get('projects:get-all')({ sender: win.webContents, senderFrame: bareQueryFrame }),
        /blocked an untrusted renderer request/
      );
    }
    win.webContents.mainFrame = mainFrame;

    const auxiliaryWindow = new TestBrowserWindow(win.options);
    const auxiliaryFrame = { url: rendererUrl };
    auxiliaryWindow.webContents.mainFrame = auxiliaryFrame;
    assert.throws(
      () => ipcHandlers.get('projects:get-all')({
        sender: auxiliaryWindow.webContents,
        senderFrame: auxiliaryFrame,
      }),
      /blocked an untrusted renderer request/
    );
    win.destroyed = true;
    assert.throws(
      () => ipcHandlers.get('projects:get-all')({
        sender: auxiliaryWindow.webContents,
        senderFrame: auxiliaryFrame,
      }),
      /blocked an untrusted renderer request/
    );
    win.destroyed = false;
    win.detached = true;
    assert.throws(
      () => ipcHandlers.get('projects:get-all')(trustedEvent),
      /blocked an untrusted renderer request/
    );
    win.detached = false;
    windows.pop();

    for (const allowedUrl of [rendererUrl, `${rendererUrl}#`, `${rendererUrl}#settings`]) {
      let prevented = false;
      win.webContents.handlers.get('will-navigate')({
        url: allowedUrl,
        preventDefault() { prevented = true; }
      });
      assert.equal(prevented, false, `expected navigation to remain allowed: ${allowedUrl}`);
    }

    const siblingRendererUrl = pathToFileURL(path.join(path.dirname(win.loadedFile), 'other.html')).href;
    for (const blockedUrl of [
      `${rendererUrl}?untrusted=1`,
      `${rendererUrl}?`,
      `${rendererUrl}?#settings`,
      `${rendererUrl}.untrusted`,
      siblingRendererUrl,
      'https://example.com/',
      'http://example.com/',
      'javascript:alert(1)',
      'data:text/html,untrusted',
      'about:blank',
      'not a url',
    ]) {
      let prevented = false;
      win.webContents.handlers.get('will-navigate')({
        url: blockedUrl,
        preventDefault() { prevented = true; }
      });
      assert.equal(prevented, true, `expected navigation to be blocked: ${blockedUrl}`);
    }

    let redirectPrevented = false;
    win.webContents.handlers.get('will-redirect')({
      url: 'file:///tmp/untrusted.html',
      preventDefault() { redirectPrevented = true; }
    });
    assert.equal(redirectPrevented, true);
    assert.deepEqual(win.webContents.windowOpenHandler({ url: 'https://example.com/' }), { action: 'deny' });
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
      [1500]
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

    win.forceHidden = true;
    appHandlers.get('did-become-active')();
    appHandlers.get('did-become-active')();
    appHandlers.get('did-become-active')();
    assert.equal(win.destroyed, true);
    assert.equal(windows.length, 2);
    assert.equal(windows[1].showCount, 1);
    assert.equal(windows[1].focusCount, 1);
    assert.equal(appShowCount, 9);
    assert.equal(appFocusCount, 9);

    const recreatedWin = windows[1];
    const recreatedRendererUrl = pathToFileURL(recreatedWin.loadedFile).href;
    const recreatedMainFrame = { url: recreatedRendererUrl };
    recreatedWin.webContents.mainFrame = recreatedMainFrame;
    assert.deepEqual(
      ipcHandlers.get('projects:get-all')({
        sender: recreatedWin.webContents,
        senderFrame: recreatedMainFrame,
      }),
      []
    );
    assert.throws(
      () => ipcHandlers.get('projects:get-all')(trustedEvent),
      /blocked an untrusted renderer request/
    );
    win.handlers.get('closed')();
    appHandlers.get('did-become-active')();
    assert.equal(windows.length, 2);
    assert.equal(recreatedWin.showCount, 2);
    assert.equal(recreatedWin.focusCount, 2);
    assert.equal(appShowCount, 10);
    assert.equal(appFocusCount, 10);

    recreatedWin.detached = true;
    appHandlers.get('did-become-active')();
    assert.equal(windows.length, 3);
    assert.equal(windows[2].showCount, 1);
    assert.equal(windows[2].focusCount, 1);
    assert.equal(appShowCount, 11);
    assert.equal(appFocusCount, 11);

    const liveRecreatedWin = windows[2];
    liveRecreatedWin.destroyed = true;
    liveRecreatedWin.handlers.get('closed')();
    assert.deepEqual(
      [...timeouts].map(timeout => timeout.delay).sort((a, b) => a - b),
      []
    );
    let preventedWindowCloseQuit = false;
    appHandlers.get('window-all-closed')({
      preventDefault() { preventedWindowCloseQuit = true; }
    });
    assert.equal(preventedWindowCloseQuit, true);
    appHandlers.get('second-instance')();
    assert.equal(windows.length, 4);
    assert.equal(windows[3].showCount, 1);
    assert.equal(windows[3].focusCount, 1);
  } finally {
    Module._resolveFilename = originalResolve;
    Module._load = originalLoad;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
    intervals.clear();
    timeouts.clear();
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
});

test('startup recovery recreates window if first launch window closes before becoming visible', async () => {
  const originalResolve = Module._resolveFilename;
  const originalLoad = Module._load;
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  const stubs = new Map();
  const appHandlers = new Map();
  const ipcHandlers = new Map();
  const windows = [];
  const timeouts = new Set();
  const isolatedHome = path.join(os.tmpdir(), `crate-main-window-hidden-startup-test-home-${process.pid}-${Date.now()}`);
  let appReady = false;
  let readyCallback = null;

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
    return { fn, delay, args, unref() {} };
  };

  global.clearInterval = function trackedClearInterval() {};

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

  console.error = () => {};
  console.warn = () => {};

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
      this.showCount = 0;
      this.focusCount = 0;
      this.forceHidden = windows.length === 0;
      windows.push(this);
    }

    static getAllWindows() {
      return windows.filter(win => !win.destroyed && !win.detached);
    }

    loadFile(filePath) {
      this.loadedFile = filePath;
      return Promise.resolve();
    }
    on(channel, fn) { this.handlers.set(channel, fn); }
    once(channel, fn) { this.handlers.set(channel, fn); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.showCount > 0 && !this.forceHidden && !this.destroyed; }
    isMinimized() { return false; }
    restore() {}
    show() { this.showCount += 1; }
    focus() { this.focusCount += 1; }
    moveTop() {}
    setFocusable() {}
    setIgnoreMouseEvents() {}
    destroy() { this.destroyed = true; }
  }

  class FakeStore {
    constructor(opts = {}) {
      this.path = path.join(isolatedHome, 'user-data', 'config.json');
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      fs.writeFileSync(this.path, '{}', { mode: 0o600 });
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
      show: () => {},
      focus: () => {},
      getPath: () => path.join(isolatedHome, 'user-data'),
      dock: { setMenu: () => {} },
    },
    BrowserWindow: TestBrowserWindow,
    Tray: class { setToolTip() {} on() {} isDestroyed() { return false; } destroy() {} },
    ipcMain: { handle(channel, fn) { ipcHandlers.set(channel, fn); } },
    dialog: {
      showOpenDialog: async () => ({ canceled: true }),
      showSaveDialog: async () => ({ canceled: true }),
      showMessageBox: async () => ({ response: 0 }),
      showErrorBox: () => {},
    },
    shell: { openPath: () => {} },
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }), createEmpty: () => ({}) },
    Notification: class { static isSupported() { return false; } },
    Menu: { buildFromTemplate: () => ({}) },
  }));
  setStub('electron-store', () => FakeStore);
  setStub('os', () => ({ ...os, homedir: () => isolatedHome }));
  setStub('uuid', () => ({ v4: () => '00000000-0000-4000-8000-000000000001' }));
  setStub('ag-psd', () => ({ readPsd: () => ({}) }));
  setStub('chokidar', () => ({ watch: () => ({ on: () => {}, close: () => {}, add: () => {}, unwatch: () => {} }) }));
  setStub('node-fetch', () => async () => ({ ok: false, status: 500, json: async () => ({}) }));

  const isolatedOrphanCache = path.join(
    isolatedHome,
    '.crate',
    'figma-assets',
    '00000000-0000-4000-8000-000000000099'
  );
  fs.mkdirSync(isolatedOrphanCache, { recursive: true });
  fs.writeFileSync(path.join(isolatedOrphanCache, 'stale.bin'), 'isolated stale cache');

  try {
    delete require.cache[require.resolve('../main')];
    require('../main');

    assert.equal(typeof readyCallback, 'function');
    appReady = true;
    await readyCallback();

    const cleanupDeadline = Date.now() + 1000;
    while (fs.existsSync(isolatedOrphanCache) && Date.now() < cleanupDeadline) {
      await new Promise(resolve => originalSetTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(isolatedOrphanCache), false, 'startup cleanup must stay inside the isolated test home');

    assert.equal(windows.length, 1);
    assert.equal(windows[0].isVisible(), false);
    assert.deepEqual(
      [...timeouts].map(timeout => timeout.delay).sort((a, b) => a - b),
      [500, 1500, 1500, 5000, 10000]
    );

    windows[0].destroyed = true;
    windows[0].handlers.get('closed')();
    assert.deepEqual(
      [...timeouts].map(timeout => timeout.delay).sort((a, b) => a - b),
      [500, 1500, 5000, 10000]
    );

    const retry = [...timeouts].find(timeout => timeout.delay === 500);
    timeouts.delete(retry);
    retry.fn();
    assert.equal(windows.length, 2);
    assert.equal(windows[1].isVisible(), true);
    assert.equal(windows[1].showCount, 1);
    assert.equal(windows[1].focusCount, 1);
    assert.deepEqual(
      [...timeouts].map(timeout => timeout.delay).sort((a, b) => a - b),
      [1500]
    );
  } finally {
    delete require.cache[require.resolve('../main')];
    Module._resolveFilename = originalResolve;
    Module._load = originalLoad;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
});
