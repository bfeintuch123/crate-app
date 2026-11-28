const test = require('node:test');
const assert = require('./bounded-assert');
const Module = require('module');
const crypto = require('crypto');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { CALLBACK } = require('../account-config');

// The Package Review destination chooser is a sheet on the window that asked
// for it. These tests load main.js against synthetic Electron fakes: windows
// are real event emitters, and the folder chooser and the inactivity prompt
// stay pending until a test settles them.

const SYNTHETIC_IDENTITY = { id: 'synthetic-destination-user' };
const PROJECT_ID = '00000000-0000-4000-8000-0000000000d1';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush(turns = 5) {
  for (let i = 0; i < turns; i += 1) await new Promise(resolve => setImmediate(resolve));
}

async function startMain() {
  const originalResolve = Module._resolveFilename;
  const originalLoad = Module._load;
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  const originalConsoleLog = console.log;
  const stubs = new Map();
  const appHandlers = new Map();
  const ipcHandlers = new Map();
  const windows = [];
  const intervals = new Set();
  const timeouts = new Set();
  const openCalls = [];
  const messageCalls = [];
  const notifications = [];
  const setClosableCalls = [];
  const lookupScript = [];
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-destination-sheet-'));
  const isolatedLogs = path.join(isolatedHome, 'logs');
  let isolatedUserData = path.join(isolatedHome, 'normal-crate-user-data');
  fs.mkdirSync(isolatedLogs, { recursive: true });
  let appReady = false;
  let readyCallback = null;
  let account = null;
  let storeInstance = null;
  const ctx = {
    appShowCount: 0,
    notificationSupported: false,
    messageBoxThrowsSync: false,
  };

  const { AccountSession: RealAccountSession } = require('../account-session');
  stubs.set('./account-config', () => ({ ...require('../account-config'), loadAccountConfig: () => ({
    provider: 'https://project.supabase.co', origin: 'https://accounts.example.test',
    clientId: 'synthetic-client', publicKey: 'sb_publishable_synthetic_test_key_123',
    issuer: 'https://project.supabase.co/auth/v1', callback: CALLBACK,
    redirectUri: 'https://accounts.example.test/auth/desktop/callback',
  }) }));
  stubs.set('./account-session', () => ({ AccountSession: class extends RealAccountSession {
    constructor(options) { super(options); account = this; }
  } }));

  Module._resolveFilename = function patchedResolve(request, parent, ...rest) {
    if (stubs.has(request)) return `\0stub:${request}`;
    return originalResolve.call(this, request, parent, ...rest);
  };
  Module._load = function patchedLoad(request, parent, ...rest) {
    if (stubs.has(request)) return stubs.get(request)();
    return originalLoad.call(this, request, parent, ...rest);
  };
  global.setInterval = function trackedSetInterval(fn, delay, ...args) {
    const interval = { fn, delay, args, unref() {} };
    intervals.add(interval);
    return interval;
  };
  global.clearInterval = function trackedClearInterval(interval) { intervals.delete(interval); };
  global.setTimeout = function trackedSetTimeout(fn, delay, ...args) {
    const timeout = { fn, delay, args, unref() {} };
    timeouts.add(timeout);
    return timeout;
  };
  global.clearTimeout = function trackedClearTimeout(timeout) { timeouts.delete(timeout); };
  console.error = () => {};
  console.warn = () => {};
  console.log = () => {};

  class FakeWebContents extends EventEmitter {
    constructor() {
      super();
      this.sent = [];
    }
    send(channel, data) { this.sent.push({ channel, data }); }
    setWindowOpenHandler(fn) { this.windowOpenHandler = fn; }
  }

  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new FakeWebContents();
      this.destroyed = false;
      this.detached = false;
      this.forceHidden = false;
      this.showCount = 0;
      this.focusCount = 0;
      windows.push(this);
      appHandlers.get('web-contents-created')?.({}, this.webContents);
    }
    static getAllWindows() { return windows.filter(win => !win.destroyed && !win.detached); }
    static fromWebContents(webContents) {
      if (lookupScript.length) return lookupScript.shift();
      return windows.find(win => win.webContents === webContents && !win.destroyed && !win.detached) || null;
    }
    loadFile(filePath) {
      this.loadedFile = filePath;
      this.webContents.mainFrame = { url: pathToFileURL(filePath).href };
      return Promise.resolve();
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.showCount > 0 && !this.destroyed && !this.forceHidden; }
    isMinimized() { return false; }
    restore() {}
    show() { this.showCount += 1; this.emit('show'); }
    focus() { this.focusCount += 1; this.emit('focus'); }
    moveTop() {}
    setFocusable() {}
    setIgnoreMouseEvents() {}
    setClosable(value) { setClosableCalls.push({ win: this, value }); }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('closed');
    }
  }

  class FakeNotification extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      notifications.push(this);
    }
    static isSupported() { return ctx.notificationSupported; }
    show() { this.shown = true; }
    close() { this.closed = true; this.emit('close'); }
  }

  class FakeStore {
    constructor(opts = {}) {
      this.path = path.join(isolatedUserData, 'config.json');
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      fs.writeFileSync(this.path, '{}', { mode: 0o600 });
      this.data = JSON.parse(JSON.stringify(opts.defaults || {}));
      storeInstance = this;
    }
    get(key, fallback) {
      if (!key) return this.data;
      let cur = this.data;
      for (const part of key.split('.')) {
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

  stubs.set('electron', () => ({
    app: {
      requestSingleInstanceLock: () => true,
      quit: () => {},
      whenReady: () => ({ then(fn) { readyCallback = fn; } }),
      on(channel, fn) { appHandlers.set(channel, fn); },
      isReady: () => appReady,
      show: () => { ctx.appShowCount += 1; },
      focus: () => {},
      getPath: name => name === 'logs' ? isolatedLogs : name === 'appData' ? isolatedHome : isolatedUserData,
      setPath: (name, value) => { if (name === 'userData') isolatedUserData = value; },
      dock: { setMenu: () => {} },
    },
    BrowserWindow: FakeWindow,
    Tray: class { setToolTip() {} on() {} isDestroyed() { return false; } destroy() {} },
    ipcMain: { handle(channel, fn) { ipcHandlers.set(channel, fn); }, on() {} },
    dialog: {
      showOpenDialog: (...args) => {
        const call = { args, ...deferred() };
        openCalls.push(call);
        return call.promise;
      },
      showSaveDialog: async () => ({ canceled: true }),
      showMessageBox: (...args) => {
        if (ctx.messageBoxThrowsSync) throw new Error('synthetic message box failure');
        const call = { args, ...deferred() };
        const options = args[1] || args[0];
        // Electron closes an aborted message box with its cancel response.
        options?.signal?.addEventListener('abort', () => call.resolve({ response: options.cancelId ?? 0 }));
        messageCalls.push(call);
        return call.promise;
      },
      showErrorBox: () => {},
    },
    shell: { openPath: () => {} },
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }), createEmpty: () => ({}) },
    Notification: FakeNotification,
    Menu: { buildFromTemplate: template => ({ template }), setApplicationMenu: () => {} },
  }));
  stubs.set('electron-store', () => FakeStore);
  stubs.set('os', () => ({ ...os, homedir: () => isolatedHome }));
  stubs.set('crypto', () => ({ ...crypto, randomUUID: () => '00000000-0000-4000-8000-000000000001' }));
  stubs.set('ag-psd', () => ({ readPsd: () => ({}) }));
  stubs.set('chokidar', () => ({ watch: () => ({ on: () => {}, close: () => {}, add: () => {}, unwatch: () => {} }) }));
  stubs.set('node-fetch', () => async () => ({ ok: false, status: 500, json: async () => ({}) }));

  function signIn() {
    account.record = { identity: SYNTHETIC_IDENTITY };
    account.accessToken = 'synthetic';
    account.accessExpiresAt = Date.now() + 60 * 60 * 1000;
    account.publish('signed_in', '', SYNTHETIC_IDENTITY);
  }

  const restore = () => {
    delete require.cache[require.resolve('../main')];
    Module._resolveFilename = originalResolve;
    Module._load = originalLoad;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
    console.log = originalConsoleLog;
    intervals.clear();
    timeouts.clear();
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  };

  try {
    delete require.cache[require.resolve('../main')];
    require('../main');
    appReady = true;
    await readyCallback();
    signIn();
  } catch (error) {
    restore();
    throw error;
  }

  Object.assign(ctx, {
    windows,
    appHandlers,
    openCalls,
    messageCalls,
    notifications,
    setClosableCalls,
    lookupScript,
    isolatedHome,
    restore,
    signIn,
    eventFor(win) {
      return { sender: win.webContents, senderFrame: win.webContents.mainFrame };
    },
    selectOutput(win = ctx.win) {
      return ipcHandlers.get('projects:select-output')(ctx.eventFor(win));
    },
    activate() { appHandlers.get('did-become-active')(); },
    beforeQuit() { appHandlers.get('before-quit')(); },
    changeAccountGeneration() {
      account.invalidate();
      account.publish('signed_in', '', SYNTHETIC_IDENTITY);
    },
    inactivityTick() {
      const checks = [...intervals].filter(interval => String(interval.fn).includes('INACTIVITY_TIMEOUT_MS'));
      assert.equal(checks.length, 1, 'one inactivity checker');
      return checks[0].fn();
    },
    seedDueWatchingProject() {
      const old = Date.now() - 4 * 60 * 60 * 1000;
      const sourcePath = path.join(isolatedHome, 'Synthetic Reminder.ai');
      fs.writeFileSync(sourcePath, 'synthetic reminder bytes');
      storeInstance.set('projects', [{
        id: PROJECT_ID,
        name: 'Synthetic Reminder',
        type: 'branding',
        status: 'watching',
        files: [{ path: sourcePath, name: 'Synthetic Reminder.ai', ext: '.ai', addedAt: old, source: 'manual-browse' }],
        pendingFiles: [],
        excludedAssetKeys: [],
        createdAt: old,
        packagedAt: null,
        outputPath: null,
      }]);
    },
  });
  // Object.assign would copy these getters' values once, so define them live.
  Object.defineProperties(ctx, {
    account: { get: () => account },
    store: { get: () => storeInstance },
    win: { get: () => windows.find(win => !win.destroyed && !win.detached) || null },
  });
  return ctx;
}

async function withMain(fn) {
  const ctx = await startMain();
  try {
    await fn(ctx);
  } finally {
    ctx.restore();
  }
}

function chosenFolder(ctx, name = 'Synthetic Output') {
  const folder = path.join(ctx.isolatedHome, name);
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

function snapshotShows(ctx) {
  return {
    winShows: ctx.windows.map(win => win.showCount),
    appShows: ctx.appShowCount,
    windowCount: ctx.windows.length,
  };
}

// A did-become-active step shows the window unless a destination choice
// suppressed automatic foregrounding.
function assertForegroundNotSuppressed(ctx, message) {
  const before = ctx.appShowCount;
  ctx.activate();
  assert.equal(ctx.appShowCount, before + 1, message);
}

function assertForegroundSuppressed(ctx, message) {
  const before = ctx.appShowCount;
  ctx.activate();
  assert.equal(ctx.appShowCount, before, message);
}

test('destination chooser opens as a sheet on the requesting window', async () => {
  await withMain(async (ctx) => {
    const win = ctx.win;
    const pending = ctx.selectOutput(win);
    assert.equal(ctx.openCalls.length, 1);
    const { args } = ctx.openCalls[0];
    assert.equal(args.length, 2, 'the requesting window is passed as the parent');
    assert.ok(args[0] === win, 'the parent is the requesting window');
    assert.deepEqual(args[1], {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose Package Destination',
      defaultPath: path.join(ctx.isolatedHome, 'Desktop'),
    });
    ctx.openCalls[0].resolve({ canceled: true, filePaths: [] });
    assert.equal(await pending, null);
  });
});

test('destination chooser opens nothing when the requesting window is missing or destroyed', async () => {
  await withMain(async (ctx) => {
    const win = ctx.win;
    const before = snapshotShows(ctx);
    // The trusted-sender check sees the main window; the chooser's own lookup does not.
    ctx.lookupScript.push(win, null);
    const missing = ctx.selectOutput(win);
    ctx.lookupScript.length = 0;
    ctx.lookupScript.push(win, { isDestroyed: () => true });
    const destroyed = ctx.selectOutput(win);
    ctx.lookupScript.length = 0;
    assert.equal(ctx.openCalls.length, 0, 'no chooser opens without a live owner');
    assert.equal(await missing, null);
    assert.equal(await destroyed, null);
    assert.deepEqual(snapshotShows(ctx), before);
  });
});

test('second destination request while one is pending returns null and opens nothing', async () => {
  await withMain(async (ctx) => {
    const folder = chosenFolder(ctx);
    const first = ctx.selectOutput();
    const before = snapshotShows(ctx);
    const second = ctx.selectOutput();
    assert.equal(ctx.openCalls.length, 1, 'the second request opens no chooser');
    assert.equal(await second, null);
    assert.deepEqual(snapshotShows(ctx), before, 'the refused request shows nothing');
    assertForegroundNotSuppressed(ctx, 'the refused request does not suppress foregrounding');
    ctx.openCalls[0].resolve({ canceled: false, filePaths: [folder] });
    assert.equal(await first, folder);
    const third = ctx.selectOutput();
    assert.equal(ctx.openCalls.length, 2, 'a request after the first settles opens the chooser');
    ctx.openCalls[1].resolve({ canceled: true, filePaths: [] });
    assert.equal(await third, null);
  });
});

test('destination result after the window closes or the app quits is treated as cancel', async (t) => {
  const signals = {
    'close (prevented)': (ctx, win) => win.emit('close', { preventDefault() {} }),
    'closed': (ctx, win) => win.emit('closed'),
    'destroy()': (ctx, win) => win.destroy(),
    'destroyed without closed': (ctx, win) => { win.destroyed = true; },
    'replaced owner without closed': (ctx, win) => { win.detached = true; ctx.activate(); },
  };
  for (const [name, signal] of Object.entries(signals)) {
    for (const canceled of [false, true]) {
      await t.test(`${name}, dialog reports ${canceled ? 'cancel' : 'a folder'}`, async () => {
        await withMain(async (ctx) => {
          const folder = chosenFolder(ctx);
          const win = ctx.win;
          const pending = ctx.selectOutput(win);
          signal(ctx, win);
          const before = snapshotShows(ctx);
          ctx.openCalls[0].resolve(canceled ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [folder] });
          assert.equal(await pending, null);
          assert.deepEqual(snapshotShows(ctx), before, 'no show and no window creation');
          assertForegroundNotSuppressed(ctx, 'a stale result does not suppress foregrounding');
          if (name === 'close (prevented)') {
            const next = ctx.selectOutput(win);
            assert.equal(ctx.openCalls.length, 2, 'the chooser opens again after a prevented close');
            ctx.openCalls[1].resolve({ canceled: true, filePaths: [] });
            assert.equal(await next, null);
          }
        });
      });
    }
  }
  // Quit shuts the account session down, so the trusted IPC wrapper rejects
  // any late result with its sign-in error, as it does today. What remains
  // observable here is that the chooser raises and creates nothing.
  for (const canceled of [false, true]) {
    await t.test(`before-quit, dialog reports ${canceled ? 'cancel' : 'a folder'}`, async () => {
      await withMain(async (ctx) => {
        const folder = chosenFolder(ctx);
        const pending = ctx.selectOutput();
        ctx.beforeQuit();
        const before = snapshotShows(ctx);
        ctx.openCalls[0].resolve(canceled ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [folder] });
        await assert.rejects(pending, /Sign in to Crate/);
        assert.deepEqual(snapshotShows(ctx), before, 'no show and no window creation after quit begins');
      });
    });
  }
});

test('destination request after quit has begun opens nothing', async () => {
  await withMain(async (ctx) => {
    ctx.beforeQuit();
    // Rebuild a trusted, signed-in main window after quit began, so the
    // request reaches the chooser handler itself.
    ctx.signIn();
    ctx.activate();
    const win = ctx.win;
    assert.ok(win, 'a live main window exists');
    const pending = ctx.selectOutput(win);
    assert.equal(ctx.openCalls.length, 0, 'no chooser opens once quit has begun');
    assert.equal(await pending, null);
  });
});

test('real destination choice returns the folder and keeps the app in the background', async () => {
  await withMain(async (ctx) => {
    const folder = chosenFolder(ctx);
    const win = ctx.win;
    const listeners = { close: win.listenerCount('close'), closed: win.listenerCount('closed') };
    for (let i = 0; i < 5; i += 1) {
      const pending = ctx.selectOutput(win);
      ctx.openCalls[i].resolve({ canceled: true, filePaths: [] });
      assert.equal(await pending, null);
    }
    const before = snapshotShows(ctx);
    const pending = ctx.selectOutput(win);
    ctx.openCalls[5].resolve({ canceled: false, filePaths: [folder] });
    assert.equal(await pending, folder);
    assert.equal(snapshotShows(ctx).appShows, before.appShows, 'a choice does not raise the window');
    assertForegroundSuppressed(ctx, 'a choice suppresses automatic foregrounding');
    assert.deepEqual(
      { close: win.listenerCount('close'), closed: win.listenerCount('closed') },
      listeners,
      'requests add no window listeners'
    );
  });
});

test('real destination cancel returns null and raises the window', async () => {
  await withMain(async (ctx) => {
    const win = ctx.win;
    const before = win.showCount;
    const pending = ctx.selectOutput(win);
    ctx.openCalls[0].resolve({ canceled: true, filePaths: [] });
    assert.equal(await pending, null);
    assert.equal(win.showCount, before + 1);
    assert.equal(ctx.windows.length, 1);
    const next = ctx.selectOutput(win);
    assert.equal(ctx.openCalls.length, 2, 'the chooser opens again after a cancel');
    ctx.openCalls[1].resolve({ canceled: true, filePaths: [] });
    assert.equal(await next, null);
  });
});

test('malformed destination results return null with no side effects', async (t) => {
  const results = {
    'no folder': { canceled: false, filePaths: [] },
    'two folders': { canceled: false, filePaths: ['/synthetic/one', '/synthetic/two'] },
    'empty path': { canceled: false, filePaths: [''] },
    'non-string path': { canceled: false, filePaths: [42] },
    'missing paths': { canceled: false },
    'null result': null,
    'undefined result': undefined,
    'non-object result': 'synthetic',
  };
  for (const [name, result] of Object.entries(results)) {
    await t.test(name, async () => {
      await withMain(async (ctx) => {
        const pending = ctx.selectOutput();
        const before = snapshotShows(ctx);
        ctx.openCalls[0].resolve(result);
        assert.equal(await pending, null);
        assert.deepEqual(snapshotShows(ctx), before);
        assertForegroundNotSuppressed(ctx, 'a malformed result does not suppress foregrounding');
        const next = ctx.selectOutput();
        assert.equal(ctx.openCalls.length, 2, 'the chooser opens again');
        ctx.openCalls[1].resolve({ canceled: true, filePaths: [] });
        assert.equal(await next, null);
      });
    });
  }
});

test('destination chooser rejection rethrows while live and is cancel once stale', async () => {
  await withMain(async (ctx) => {
    const win = ctx.win;
    const live = ctx.selectOutput(win);
    const before = snapshotShows(ctx);
    ctx.openCalls[0].reject(new Error('synthetic chooser failure'));
    await assert.rejects(live, /synthetic chooser failure/);
    assert.deepEqual(snapshotShows(ctx), before);
    const next = ctx.selectOutput(win);
    assert.equal(ctx.openCalls.length, 2, 'the chooser opens again after a rejection');
    win.emit('close', { preventDefault() {} });
    ctx.openCalls[1].reject(new Error('synthetic chooser failure'));
    assert.equal(await next, null, 'a rejection after an abandon signal is a cancel');
    assert.deepEqual(snapshotShows(ctx), before);
  });
});

test('inactivity prompt waits while a destination sheet is attached', async () => {
  await withMain(async (ctx) => {
    ctx.seedDueWatchingProject();
    const win = ctx.win;
    assert.equal(win.isVisible(), true);
    const pending = ctx.selectOutput(win);
    ctx.inactivityTick();
    assert.equal(ctx.messageCalls.length, 0, 'no prompt while the destination sheet is attached');
    ctx.openCalls[0].resolve({ canceled: true, filePaths: [] });
    assert.equal(await pending, null);
    ctx.inactivityTick();
    assert.equal(ctx.messageCalls.length, 1, 'the next tick shows the prompt: the project was not marked');
    assert.ok(ctx.messageCalls[0].args[0] === win);
    ctx.messageCalls[0].resolve({ response: 0 });
    await flush();
  });
});

test('hidden-window inactivity notification also waits while a destination sheet is attached', async () => {
  await withMain(async (ctx) => {
    ctx.seedDueWatchingProject();
    ctx.notificationSupported = true;
    const win = ctx.win;
    const pending = ctx.selectOutput(win);
    win.forceHidden = true;
    ctx.inactivityTick();
    assert.equal(ctx.notifications.length, 0, 'no notification while the destination sheet is attached');
    assert.equal(ctx.messageCalls.length, 0);
    ctx.openCalls[0].resolve({ canceled: true, filePaths: [] });
    assert.equal(await pending, null);
    ctx.inactivityTick();
    assert.equal(ctx.notifications.length, 1, 'the next tick notifies: the project was not marked');
  });
});

test('destination request returns null while an inactivity prompt is attached', async (t) => {
  const endings = {
    'prompt answered': async (ctx) => { ctx.messageCalls[0].resolve({ response: 0 }); },
    'prompt rejected': async (ctx) => { ctx.messageCalls[0].reject(new Error('synthetic prompt failure')); },
    'prompt aborted': async (ctx) => {
      // An account change aborts open prompts. Pause the project first so the
      // change does not restart watching, whose pollers would outlive the test.
      ctx.store.get('projects')[0].status = 'paused';
      ctx.changeAccountGeneration();
    },
  };
  for (const [name, end] of Object.entries(endings)) {
    await t.test(name, async () => {
      await withMain(async (ctx) => {
        ctx.seedDueWatchingProject();
        const win = ctx.win;
        ctx.inactivityTick();
        assert.equal(ctx.messageCalls.length, 1);
        const before = snapshotShows(ctx);
        const refused = ctx.selectOutput(win);
        assert.equal(ctx.openCalls.length, 0, 'no chooser opens over the prompt');
        assert.equal(await refused, null);
        assert.deepEqual(snapshotShows(ctx), before);
        await end(ctx);
        await flush();
        const next = ctx.selectOutput(win);
        assert.equal(ctx.openCalls.length, 1, 'the chooser opens once the prompt has ended');
        ctx.openCalls[0].resolve({ canceled: true, filePaths: [] });
        assert.equal(await next, null);
      });
    });
  }
  await t.test('prompt threw synchronously', async () => {
    await withMain(async (ctx) => {
      ctx.seedDueWatchingProject();
      ctx.messageBoxThrowsSync = true;
      assert.throws(() => ctx.inactivityTick(), /synthetic message box failure/);
      ctx.messageBoxThrowsSync = false;
      const next = ctx.selectOutput();
      assert.equal(ctx.openCalls.length, 1, 'a prompt that never opened does not block the chooser');
      ctx.openCalls[0].resolve({ canceled: true, filePaths: [] });
      assert.equal(await next, null);
    });
  });
});

test('visibility recovery leaves a window with an attached destination sheet in place', async () => {
  await withMain(async (ctx) => {
    const win = ctx.win;
    const pending = ctx.selectOutput(win);
    win.forceHidden = true;
    for (let i = 0; i < 4; i += 1) ctx.activate();
    assert.equal(win.destroyed, false, 'the owner is not destroyed while its sheet is attached');
    assert.equal(ctx.windows.length, 1, 'no window is created while the sheet is attached');
    // Cancel raises the window while the chooser is still held, so that show
    // does not count as a hidden attempt either.
    ctx.openCalls[0].resolve({ canceled: true, filePaths: [] });
    assert.equal(await pending, null);
    assert.equal(ctx.windows.length, 1);
    ctx.activate();
    ctx.activate();
    assert.equal(win.destroyed, false, 'two hidden attempts after the sheet do not re-create');
    ctx.activate();
    assert.equal(win.destroyed, true, 'recovery works again after the sheet ends');
    assert.equal(ctx.windows.length, 2);
  });
});

test('hidden attempts counted before a destination sheet do not reach re-creation while it is attached', async () => {
  await withMain(async (ctx) => {
    const win = ctx.win;
    win.forceHidden = true;
    ctx.activate();
    ctx.activate();
    assert.equal(win.destroyed, false, 'two hidden attempts');
    const pending = ctx.selectOutput(win);
    ctx.activate();
    assert.equal(win.destroyed, false, 'a third hidden attempt while attached does not re-create');
    assert.equal(ctx.windows.length, 1);
    ctx.openCalls[0].resolve({ canceled: true, filePaths: [] });
    assert.equal(await pending, null);
    assert.equal(win.destroyed, false, 'cancel raises the window without counting a hidden attempt');
    ctx.activate();
    assert.equal(win.destroyed, true, 'the next hidden activation after the sheet re-creates');
  });
});

test('closing the window during a choice frees the chooser for the next window', async () => {
  await withMain(async (ctx) => {
    const folder = chosenFolder(ctx);
    const oldWin = ctx.win;
    const oldPending = ctx.selectOutput(oldWin);
    oldWin.destroy();
    ctx.activate();
    const newWin = ctx.win;
    assert.ok(newWin && newWin !== oldWin, 'activation opens a new main window');
    const newPending = ctx.selectOutput(newWin);
    assert.equal(ctx.openCalls.length, 2, 'the new window can open its chooser');
    assert.ok(ctx.openCalls[1].args[0] === newWin);
    ctx.openCalls[0].resolve({ canceled: false, filePaths: [folder] });
    assert.equal(await oldPending, null, 'the closed window\'s late result is dropped');
    const refused = ctx.selectOutput(newWin);
    assert.equal(ctx.openCalls.length, 2, 'the late result did not free the new chooser');
    assert.equal(await refused, null);
    ctx.openCalls[1].resolve({ canceled: false, filePaths: [folder] });
    assert.equal(await newPending, folder);
    assert.deepEqual(ctx.setClosableCalls, [], 'no window is made unclosable');
  });
});

test('account change during a choice does not choose, raise or suppress', async (t) => {
  for (const canceled of [false, true]) {
    await t.test(canceled ? 'dialog reports cancel' : 'dialog reports a folder', async () => {
      await withMain(async (ctx) => {
        const folder = chosenFolder(ctx);
        const pending = ctx.selectOutput();
        ctx.changeAccountGeneration();
        const before = snapshotShows(ctx);
        ctx.openCalls[0].resolve(canceled ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [folder] });
        await assert.rejects(pending, /Sign in to Crate/);
        assert.deepEqual(snapshotShows(ctx), before, 'no show');
        assertForegroundNotSuppressed(ctx, 'a result after an account change does not suppress foregrounding');
      });
    });
  }
});
