const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn: realSpawn, spawnSync: realSpawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { promisify: nodePromisify } = require('util');
const MAIN_UNDER_TEST_ROOT = process.env.CRATE_MAIN_UNDER_TEST
  ? path.dirname(path.resolve(process.env.CRATE_MAIN_UNDER_TEST))
  : path.resolve(__dirname, '..');
const { createAutomaticPackageReviewCaller } = require('./package-review-ipc-helper');
const packageJson = require('../package.json');
const helperPlistPatch = require('../scripts/patch-helper-info-plists');
const {
  PACKAGE_OUTPUT_LAYOUT_MODES,
  packageCollisionKey,
} = require('../parsers/package-safety');

const {
  NODE_TYPES,
  EDGE_TYPES,
  OBSERVER_KINDS,
  CONFIDENCE_BANDS,
  createNodeId,
} = require('../provenance');

const originalSetInterval = global.setInterval;
const originalClearInterval = global.clearInterval;
const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;
const originalHomedir = os.homedir;
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-provenance-dual-write-home-'));
const EXPECTED_LIVE_EVIDENCE_CANDIDATE_CAP = 500;
const activeIntervals = new Set();
const activeIntervalCallbacks = new Map();
const activeIntervalDelays = new Map();
const activeTimeouts = new Set();
let cacheCleanupSentinelCounter = 0;

fs.mkdirSync(path.join(TEST_HOME, 'Desktop'), { recursive: true });
fs.mkdirSync(path.join(TEST_HOME, 'Documents'), { recursive: true });
fs.mkdirSync(path.join(TEST_HOME, 'Downloads'), { recursive: true });
os.homedir = () => TEST_HOME;

global.setInterval = function trackedSetInterval(fn, delay, ...args) {
  const timer = originalSetInterval(fn, delay, ...args);
  activeIntervals.add(timer);
  activeIntervalCallbacks.set(timer, () => fn(...args));
  activeIntervalDelays.set(timer, delay);
  return timer;
};

global.clearInterval = function trackedClearInterval(timer) {
  activeIntervals.delete(timer);
  activeIntervalCallbacks.delete(timer);
  activeIntervalDelays.delete(timer);
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

function createTestNativeImage(byteLength = 64, width = 96, height = 72) {
  const image = {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    resize: () => image,
    toPNG: () => Buffer.alloc(byteLength, 1),
  };
  return image;
}

function createSyntheticPngBytes(width = 32, height = 24, marker = 0x41) {
  const buffer = Buffer.alloc(32, marker);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

async function runTrackedIntervalCallbacks(iterations = 1) {
  for (let i = 0; i < iterations; i++) {
    const callbacks = [...activeIntervalCallbacks.values()];
    for (const callback of callbacks) {
      await Promise.resolve(callback());
    }
  }
}

async function runTrackedIntervalCallbacksForDelay(delay) {
  const callbacks = [...activeIntervalCallbacks.entries()]
    .filter(([timer]) => activeIntervalDelays.get(timer) === delay)
    .map(([, callback]) => callback);
  for (const callback of callbacks) {
    await Promise.resolve(callback());
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
let testMainWindowVisible = true;
let testAppVersion = packageJson.version;
let testNativeFileVisualImage = null;
let testNativeFileIconImage = null;
let testLastNativeImageBuffer = null;
let testLastNativeThumbnailPath = null;
let testLastNativeThumbnailSize = null;
let testLastNativeThumbnailBytes = null;
let testNativeThumbnailCalls = 0;
let testNativeCreateFromBufferCalls = 0;
let testBeforeNativeThumbnailResolve = null;
let testLastFileIconPath = null;
let testLastFileIconOptions = null;
let testBeforeFileIconResolve = null;
let testBrowserWindowCreateCount = 0;
let testMainWindowShowCount = 0;
const testNotifications = [];
const testMessageBoxes = [];
const testRendererEvents = [];
const trustedRendererMainFrame = {
  url: pathToFileURL(path.join(MAIN_UNDER_TEST_ROOT, 'renderer', 'index.html')).href,
};
const trustedRendererWindow = {
  handlers: new Map(),
  isDestroyed: () => false,
  isVisible: () => testMainWindowVisible,
  isMinimized: () => false,
  restore: () => {},
  show: () => { testMainWindowShowCount += 1; },
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
    send: (channel, data) => { testRendererEvents.push({ channel, data }); },
    on(channel, fn) { this.handlers.set(channel, fn); },
    once(channel, fn) { this.handlers.set(channel, fn); },
    setWindowOpenHandler(fn) { this.windowOpenHandler = fn; },
  },
};

class TestBrowserWindow {
  static fromWebContents(webContents) {
    return webContents === trustedRendererWindow.webContents ? trustedRendererWindow : null;
  }
  constructor() {
    testBrowserWindowCreateCount += 1;
    return trustedRendererWindow;
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

let utilityProcessHandler = null;

function setUtilityProcessHandler(handler) {
  utilityProcessHandler = handler;
}

function utilityProcessAncestryMatches(candidatePath, ancestry) {
  if (!Array.isArray(ancestry) || ancestry.length === 0) return false;
  let currentPath = fs.realpathSync(candidatePath);
  for (const identity of ancestry) {
    const stat = fs.statSync(currentPath, { bigint: true });
    if (stat.dev !== BigInt(identity.dev) || stat.ino !== BigInt(identity.ino)) return false;
    currentPath = path.dirname(currentPath);
  }
  return true;
}

function utilityProcessAncestriesMatch(candidatePath, ancestries) {
  return Array.isArray(ancestries) && ancestries.some(ancestry => (
    utilityProcessAncestryMatches(candidatePath, ancestry)
  ));
}

class TestUtilityProcess extends EventEmitter {
  constructor(modulePath, args, options) {
    super();
    this.modulePath = modulePath;
    this.args = args;
    this.options = options;
    this.outputFd = null;
    this.outputIdentity = null;
    this.outputLeafName = null;
    this.expectedLength = 0n;
    this.bytesWritten = 0n;
    this.sequence = 0;
    this.ancestries = null;
    this.ownedOutputs = [];
    this.identity = null;
    this.initialized = false;
    this.ownershipAcknowledged = false;
    this.killed = false;
    this.autoSpawn = true;
    this.suppressedMessages = new Set();
    this.suppressedResponses = new Set();
    if (utilityProcessHandler) {
      utilityProcessHandler({ phase: 'fork', modulePath, args, options, child: this });
    }
    queueMicrotask(() => {
      if (!this.killed && this.autoSpawn) this.emit('spawn');
    });
  }

  respond(message) {
    if (utilityProcessHandler) {
      utilityProcessHandler({
        phase: 'response',
        modulePath: this.modulePath,
        args: this.args,
        options: this.options,
        message,
        child: this,
      });
    }
    if (this.suppressedResponses.has(message.type)) return;
    queueMicrotask(() => this.emit('message', message));
  }

  fail() {
    if (this.killed) return;
    if (this.outputFd !== null) {
      try {
        const stat = fs.fstatSync(this.outputFd, { bigint: true });
        if (
          this.outputIdentity &&
          stat.isFile() &&
          stat.dev === this.outputIdentity.dev &&
          stat.ino === this.outputIdentity.ino
        ) {
          fs.ftruncateSync(this.outputFd, 0);
          fs.fsyncSync(this.outputFd);
        }
      } catch (_) {}
      try { fs.closeSync(this.outputFd); } catch (_) {}
      this.outputFd = null;
    }
    this.removeOwnedOutputs(this.outputIdentity && this.outputLeafName ? [{
      leafName: this.outputLeafName,
      identity: this.outputIdentity,
    }] : []);
    this.respond({ type: 'failed' });
  }

  removeOwnedOutputs(additionalRecords = []) {
    const workingPath = this.currentWorkingPath();
    const records = [
      ...additionalRecords,
      ...this.ownedOutputs.map(owned => ({
        leafName: owned.leafName,
        identity: { dev: BigInt(owned.identity.dev), ino: BigInt(owned.identity.ino) },
      })),
    ];
    const recordsByLeaf = new Map();
    for (const record of records) {
      const entries = recordsByLeaf.get(record.leafName) || [];
      entries.push(record.identity);
      recordsByLeaf.set(record.leafName, entries);
    }
    const sanitizeAndUnlink = (candidate, identity) => {
      const stat = fs.lstatSync(candidate, { bigint: true });
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        stat.dev !== identity.dev ||
        stat.ino !== identity.ino
      ) return false;
      const quarantineDirectory = fs.mkdtempSync(path.join(workingPath, '.crate-cleanup-'));
      fs.chmodSync(quarantineDirectory, 0o700);
      const quarantineDirectoryStat = fs.lstatSync(quarantineDirectory, { bigint: true });
      if (
        quarantineDirectoryStat.isSymbolicLink() ||
        !quarantineDirectoryStat.isDirectory() ||
        (quarantineDirectoryStat.mode & 0o777n) !== 0o700n
      ) return false;
      const quarantinePath = path.join(quarantineDirectory, 'owned-output');
      if (fs.existsSync(quarantinePath)) return false;
      fs.renameSync(candidate, quarantinePath);
      const currentQuarantineDirectory = fs.lstatSync(quarantineDirectory, { bigint: true });
      if (
        currentQuarantineDirectory.isSymbolicLink() ||
        !currentQuarantineDirectory.isDirectory() ||
        currentQuarantineDirectory.dev !== quarantineDirectoryStat.dev ||
        currentQuarantineDirectory.ino !== quarantineDirectoryStat.ino
      ) return false;
      const quarantined = fs.lstatSync(quarantinePath, { bigint: true });
      if (quarantined.dev !== identity.dev || quarantined.ino !== identity.ino) return false;
      const fd = fs.openSync(quarantinePath, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
      try {
        const opened = fs.fstatSync(fd, { bigint: true });
        if (opened.dev !== identity.dev || opened.ino !== identity.ino) return false;
        fs.ftruncateSync(fd, 0);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      const finalStat = fs.lstatSync(quarantinePath, { bigint: true });
      if (finalStat.dev !== identity.dev || finalStat.ino !== identity.ino) return false;
      fs.unlinkSync(quarantinePath);
      const finalQuarantineDirectory = fs.lstatSync(quarantineDirectory, { bigint: true });
      if (
        finalQuarantineDirectory.isSymbolicLink() ||
        !finalQuarantineDirectory.isDirectory() ||
        finalQuarantineDirectory.dev !== quarantineDirectoryStat.dev ||
        finalQuarantineDirectory.ino !== quarantineDirectoryStat.ino ||
        fs.readdirSync(quarantineDirectory).length !== 0
      ) return false;
      fs.rmdirSync(quarantineDirectory);
      return !fs.existsSync(quarantineDirectory);
    };
    const fallbackIdentities = new Map();
    for (const [leafName, identities] of recordsByLeaf) {
      let matched = false;
      for (const identity of identities) {
        try {
          if (sanitizeAndUnlink(path.join(workingPath, leafName), identity)) {
            matched = true;
            break;
          }
        } catch (_) {}
      }
      if (!matched && identities.length === 1) {
        const [identity] = identities;
        fallbackIdentities.set(`${identity.dev}\0${identity.ino}`, identity);
      }
    }
    let childNames = [];
    try { childNames = fs.readdirSync(workingPath); } catch (_) {}
    for (const childName of childNames) {
      try {
        const candidate = path.join(workingPath, childName);
        const stat = fs.lstatSync(candidate, { bigint: true });
        const identity = fallbackIdentities.get(`${stat.dev}\0${stat.ino}`);
        if (identity && sanitizeAndUnlink(candidate, identity)) {
          fallbackIdentities.delete(`${identity.dev}\0${identity.ino}`);
        }
      } catch (_) {}
    }
  }

  currentOutputMatches() {
    if (this.outputFd === null || !this.outputIdentity || !this.outputLeafName) return false;
    try {
      const descriptorStat = fs.fstatSync(this.outputFd, { bigint: true });
      const pathStat = fs.lstatSync(
        path.join(this.currentWorkingPath(), this.outputLeafName),
        { bigint: true }
      );
      return descriptorStat.isFile() &&
        pathStat.isFile() &&
        !pathStat.isSymbolicLink() &&
        descriptorStat.dev === this.outputIdentity.dev &&
        descriptorStat.ino === this.outputIdentity.ino &&
        pathStat.dev === this.outputIdentity.dev &&
        pathStat.ino === this.outputIdentity.ino &&
        descriptorStat.nlink === 1n &&
        pathStat.nlink === 1n &&
        (descriptorStat.mode & 0o777n) === 0o600n &&
        (pathStat.mode & 0o777n) === 0o600n;
    } catch (_) {
      return false;
    }
  }

  currentWorkingPath() {
    const matches = candidate => {
      try {
        const stat = fs.statSync(candidate, { bigint: true });
        return !this.identity ||
          (stat.dev === BigInt(this.identity.dev) && stat.ino === BigInt(this.identity.ino));
      } catch (_) {
        return false;
      }
    };
    if (matches(this.options.cwd)) return this.options.cwd;
    const parent = path.dirname(this.options.cwd);
    const anchorParent = path.dirname(parent);
    const candidates = [parent, anchorParent];
    try {
      for (const firstName of fs.readdirSync(anchorParent)) {
        const first = path.join(anchorParent, firstName);
        candidates.push(first);
        try {
          if (!fs.statSync(first).isDirectory()) continue;
          for (const secondName of fs.readdirSync(first)) {
            const second = path.join(first, secondName);
            candidates.push(second);
            try {
              if (!fs.statSync(second).isDirectory()) continue;
              for (const thirdName of fs.readdirSync(second)) candidates.push(path.join(second, thirdName));
            } catch (_) {}
          }
        } catch (_) {}
      }
    } catch (_) {}
    return candidates.find(matches) || this.options.cwd;
  }

  postMessage(message) {
    if (this.killed) return;
    try {
      if (utilityProcessHandler) {
        utilityProcessHandler({
          phase: 'message',
          modulePath: this.modulePath,
          args: this.args,
          options: this.options,
          message,
          child: this,
        });
      }
      if (this.suppressedMessages.has(message.type)) return;
      if (message.type === 'init-session') {
        this.ownedOutputs = message.ownedOutputs || [];
        this.identity = message.identity;
        this.ancestries = message.ancestries;
        const stat = fs.statSync(this.options.cwd, { bigint: true });
        if (
          stat.dev !== BigInt(message.identity.dev) ||
          stat.ino !== BigInt(message.identity.ino) ||
          !utilityProcessAncestriesMatch(this.options.cwd, message.ancestries)
        ) {
          this.fail();
          return;
        }
        this.initialized = true;
        this.respond({ type: 'session-ready' });
        return;
      }
      if (message.type === 'cleanup') {
        const workingPath = this.currentWorkingPath();
        const stat = fs.statSync(workingPath, { bigint: true });
        if (
          !this.initialized ||
          stat.dev !== BigInt(this.identity.dev) ||
          stat.ino !== BigInt(this.identity.ino) ||
          !utilityProcessAncestriesMatch(workingPath, this.ancestries)
        ) {
          this.fail();
          return;
        }
        this.removeOwnedOutputs();
        if (
          !utilityProcessAncestriesMatch(workingPath, this.ancestries) ||
          fs.readdirSync(workingPath).length !== 0
        ) return this.fail();
        this.respond({ type: 'complete', bytesWritten: '0' });
        return;
      }
      if (message.type === 'write-start') {
        const workingPath = this.currentWorkingPath();
        const stat = fs.statSync(workingPath, { bigint: true });
        if (
          !this.initialized ||
          stat.dev !== BigInt(this.identity.dev) ||
          stat.ino !== BigInt(this.identity.ino) ||
          !utilityProcessAncestriesMatch(workingPath, this.ancestries)
        ) {
          this.fail();
          return;
        }
        this.expectedLength = BigInt(message.expectedLength);
        this.outputLeafName = message.leafName;
        this.bytesWritten = 0n;
        this.sequence = 0;
        this.ownershipAcknowledged = false;
        const outputPath = path.join(workingPath, message.leafName);
        this.outputFd = fs.openSync(
          outputPath,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
          0o600
        );
        const opened = fs.fstatSync(this.outputFd, { bigint: true });
        this.outputIdentity = { dev: opened.dev, ino: opened.ino };
        fs.fchmodSync(this.outputFd, 0o600);
        this.respond({
          type: 'opened',
          outputIdentity: { dev: `${opened.dev}`, ino: `${opened.ino}` },
        });
        return;
      }
      if (message.type === 'ownership-ack') {
        if (
          !this.outputIdentity ||
          message.outputIdentity?.dev !== `${this.outputIdentity.dev}` ||
          message.outputIdentity?.ino !== `${this.outputIdentity.ino}` ||
          !utilityProcessAncestriesMatch(this.currentWorkingPath(), this.ancestries)
        ) return this.fail();
        this.ownershipAcknowledged = true;
        this.respond({ type: 'ready' });
        return;
      }
      if (message.type === 'chunk') {
        if (!this.ownershipAcknowledged || message.sequence !== this.sequence) return this.fail();
        if (!utilityProcessAncestriesMatch(this.currentWorkingPath(), this.ancestries)) return this.fail();
        if (!this.currentOutputMatches()) return this.fail();
        const chunk = Buffer.from(message.data);
        let offset = 0;
        while (offset < chunk.length) {
          offset += fs.writeSync(this.outputFd, chunk, offset, chunk.length - offset, null);
        }
        this.bytesWritten += BigInt(chunk.length);
        if (!this.currentOutputMatches()) return this.fail();
        this.respond({ type: 'ack', sequence: this.sequence++ });
        return;
      }
      if (message.type === 'end') {
        if (message.sequence !== this.sequence || this.bytesWritten !== this.expectedLength) {
          this.fail();
          return;
        }
        if (!utilityProcessAncestriesMatch(this.currentWorkingPath(), this.ancestries)) return this.fail();
        fs.fsyncSync(this.outputFd);
        fs.closeSync(this.outputFd);
        this.outputFd = null;
        this.ownedOutputs.push({
          leafName: this.outputLeafName,
          identity: {
            dev: `${this.outputIdentity.dev}`,
            ino: `${this.outputIdentity.ino}`,
          },
        });
        this.respond({
          type: 'complete',
          bytesWritten: `${this.bytesWritten}`,
          outputIdentity: {
            dev: `${this.outputIdentity.dev}`,
            ino: `${this.outputIdentity.ino}`,
          },
        });
        return;
      }
      if (message.type === 'release') {
        queueMicrotask(() => {
          this.respond({ type: 'released' });
          this.kill();
        });
        return;
      }
      this.fail();
    } catch (_) {
      this.fail();
    }
  }

  kill() {
    if (this.killed) return false;
    this.killed = true;
    if (this.outputFd !== null) {
      try { fs.closeSync(this.outputFd); } catch (_) {}
      this.outputFd = null;
    }
    queueMicrotask(() => this.emit('exit', 0));
    return true;
  }
}

setStub('electron', () => ({
  app: {
    requestSingleInstanceLock: () => true,
    quit: () => {},
    whenReady: () => ({ then: (fn) => { fn(); } }),
    on: () => {},
    isReady: () => true,
    show: () => {},
    focus: () => {},
    isActive: () => testAppActive,
    getVersion: () => testAppVersion,
    getPath: () => path.join(TEST_HOME, 'user-data'),
    getFileIcon: async (filePath, options) => {
      testLastFileIconPath = filePath;
      testLastFileIconOptions = options;
      if (typeof testBeforeFileIconResolve === 'function') await testBeforeFileIconResolve(filePath);
      return testNativeFileIconImage;
    },
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
    showMessageBox: async options => {
      testMessageBoxes.push(options);
      return { response: 0 };
    },
    showErrorBox: () => {},
  },
  shell: { openPath: () => {} },
  nativeImage: {
    createFromPath: () => testNativeFileVisualImage || ({ resize: () => ({}) }),
    createFromBuffer: buffer => {
      testNativeCreateFromBufferCalls += 1;
      testLastNativeImageBuffer = Buffer.from(buffer);
      return testNativeFileVisualImage || ({ resize: () => ({}) });
    },
    createThumbnailFromPath: async (filePath, size) => {
      testNativeThumbnailCalls += 1;
      testLastNativeThumbnailPath = filePath;
      testLastNativeThumbnailSize = size;
      try {
        testLastNativeThumbnailBytes = fs.readFileSync(filePath);
      } catch (_) {
        testLastNativeThumbnailBytes = null;
      }
      if (typeof testBeforeNativeThumbnailResolve === 'function') {
        await testBeforeNativeThumbnailResolve(filePath, size);
      }
      return testNativeFileVisualImage || ({ resize: () => ({}) });
    },
    createEmpty: () => ({}),
  },
  Notification: TestNotification,
  utilityProcess: {
    fork: (modulePath, args, options) => new TestUtilityProcess(modulePath, args, options),
  },
  Menu: { buildFromTemplate: () => ({}) },
}));

let storeInstance = null;
class FakeStore {
  constructor(opts = {}) {
    this.path = path.join(TEST_HOME, 'user-data', 'config.json');
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.writeFileSync(this.path, '{}', { mode: 0o600 });
    this.data = JSON.parse(JSON.stringify(opts.defaults || {}));
    this.projectSetCount = 0;
    this.measureProjectSerialization = false;
    this.projectSerializedBytes = 0;
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
    if (key === 'projects' || (key && typeof key === 'object' && Object.prototype.hasOwnProperty.call(key, 'projects'))) {
      this.projectSetCount += 1;
      if (this.measureProjectSerialization) {
        const projectsValue = typeof key === 'object' ? key.projects : value;
        this.projectSerializedBytes += Buffer.byteLength(JSON.stringify(projectsValue));
      }
    }
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
let watcherCloseCount = 0;
let testUuidCounter = 0;
setStub('chokidar', () => ({
  watch: () => {
    const handlers = {};
    const watcher = {
      on(eventName, handler) {
        handlers[eventName] = handler;
        return watcher;
      },
      close() { watcherCloseCount += 1; },
      add() {},
      unwatch() {},
    };
    watcherRecords.push({ handlers });
    return watcher;
  },
}));

let testFetchHandler = async () => ({ ok: false, status: 500, json: async () => ({}) });
setStub('node-fetch', () => (...args) => testFetchHandler(...args));

let childProcessHandler = null;

function setChildProcessHandler(handler) {
  childProcessHandler = handler;
}

function setIllustratorOpenedAfterActivationHandler(handler, activationQueries = 1) {
  let remainingActivationQueries = activationQueries;
  setChildProcessHandler(request => {
    if (
      remainingActivationQueries > 0 &&
      isOsascriptInvocation(request, 'crate-ai-active-session.applescript')
    ) {
      remainingActivationQueries--;
      return { stdout: 'STATUS\tno-documents\nCOMPLETE\t0\t0\n' };
    }
    return handler(request);
  });
}

function commandText(command, args = []) {
  return [command, ...(Array.isArray(args) ? args : [])].join(' ');
}

function getChildProcessResult(kind, command, args = [], options = {}) {
  const request = {
    kind,
    command,
    args: Array.isArray(args) ? args : [],
    options: options && typeof options === 'object' ? options : {},
    commandText: commandText(command, args),
  };
  const result = childProcessHandler ? (childProcessHandler(request) || { stdout: '', stderr: '' }) : { stdout: '', stderr: '' };
  if (
    kind === 'execFile' &&
    command === '/usr/bin/xattr' &&
    args[0] === '-pvx' &&
    !result.error &&
    result.stdout === ''
  ) return missingXattrError(args.slice(2));
  return result;
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
  const options = args.find(arg => arg && typeof arg === 'object' && !Array.isArray(arg)) || {};
  const callback = args.find(arg => typeof arg === 'function');
  const result = getChildProcessResult('execFile', command, fileArgs, options);
  if (callback) {
    queueMicrotask(() => callback(result.error || null, result.stdout || '', result.stderr || ''));
  }
  return createChildProcessStub();
}
execFileStub[nodePromisify.custom] = async (command, fileArgs = [], options = {}) => {
  const result = await Promise.resolve(getChildProcessResult('execFile', command, fileArgs, options));
  if (result.error) throw result.error;
  return { stdout: result.stdout || '', stderr: result.stderr || '' };
};

setStub('child_process', () => ({
  execSync: () => '',
  execFileSync: () => '',
  exec: execStub,
  execFile: execFileStub,
  spawn: realSpawn,
  spawnSync: realSpawnSync,
}));

let currentPsdFixture = { children: [], linkedFiles: [] };
setStub('ag-psd', () => ({
  readPsd: () => {
    if (currentPsdFixture instanceof Error) throw currentPsdFixture;
    if (typeof currentPsdFixture === 'function') return currentPsdFixture();
    return currentPsdFixture;
  },
}));
setStub('crypto', () => ({
  ...crypto,
  randomUUID: () => `00000000-0000-4000-8000-${String(++testUuidCounter).padStart(12, '0')}`,
}));

const mainModulePath = process.env.CRATE_MAIN_UNDER_TEST
  ? path.resolve(process.env.CRATE_MAIN_UNDER_TEST)
  : path.join(MAIN_UNDER_TEST_ROOT, 'main.js');
const originalJavaScriptLoader = Module._extensions['.js'];
Module._extensions['.js'] = function loadMainWithMetadataTestHooks(module, filename) {
  if (filename !== mainModulePath) return originalJavaScriptLoader(module, filename);
  const source = fs.readFileSync(filename, 'utf8');
  return module._compile(`${source}
module.exports.__crateMetadataTestHooks = {
  getFigmaPackageTransferBlock(projectId) {
    return {
      present: figmaPackageTransferBlocks.has(projectId),
      value: figmaPackageTransferBlocks.get(projectId),
    };
  },
  setFigmaPackageTransferBlock(projectId, value) {
    figmaPackageTransferBlocks.set(projectId, value);
  },
  matchSpotlightCandidateRoutes(spotlightPaths, candidates) {
    return [...matchSpotlightPathsToCandidateIndexes(spotlightPaths, candidates)]
      .map(index => candidates[index].fullPath);
  },
  removeOwnedDirectCacheFiles(records) {
    return removeOwnedDirectCacheFiles(records);
  },
  clearFileVisualTypeIconCache() {
    fileVisualTypeIconCache.clear();
  },
  clearFileVisualProjectCache() {
    clearFileVisualProjectCache();
  },
  getFileVisualRasterLimits() {
    return {
      sourceBytes: FILE_VISUAL_MAX_RASTER_SOURCE_BYTES,
      dimension: FILE_VISUAL_MAX_RASTER_DIMENSION,
      pixels: FILE_VISUAL_MAX_RASTER_PIXELS,
      queue: FILE_VISUAL_MAX_RASTER_QUEUE,
    };
  },
  runSerializedFileVisualRasterWork(task) {
    return runSerializedFileVisualRasterWork(task);
  },
  getFileVisualRasterWorkPending() {
    return fileVisualRasterWorkPending;
  },
  clearAssetBaselineScans() {
    assetBaselineScans.clear();
  },
  startInactivityChecker() {
    startInactivityChecker();
  },
  getActiveWatchingActivationToken(projectId) {
    return getActiveWatchingActivationToken(projectId);
  },
  pollLsofForProject(projectId, activationToken) {
    return pollLsofForProject(projectId, activationToken);
  },
  isLsofPollInProgress(projectId) {
    return lsofInProgress.has(projectId);
  },
  pollPsForProject(projectId, activationToken) {
    return pollPsForProject(projectId, activationToken);
  },
  recordLiveAppStatusBreadcrumb(projectId, appFamily, input) {
    return recordLiveAppStatusBreadcrumb(projectId, appFamily, input);
  },
  mergeFigmaScopeEntriesIntoSession(projectId, scopeEntries) {
    return mergeFigmaScopeEntriesIntoSession(projectId, scopeEntries);
  },
  getWatcherCoordinatorSnapshot(projectId) {
    return getWatcherCoordinator(projectId).snapshot(projectId);
  },
  pauseWatcherCoordinatorForPackage(projectId) {
    return pauseWatcherCoordinatorForPackage(projectId);
  },
  resumeWatcherCoordinatorAfterPackage(projectId) {
    resumeWatcherCoordinatorAfterPackage(projectId);
  },
  activateWatcherCoordinator(projectId) {
    return activateWatcherCoordinator(projectId);
  },
  runBackgroundWatcherOperation(projectId, kind, work) {
    return runBackgroundWatcherOperation(projectId, kind, work);
  },
  cancelWatcherCoordinator(projectId) {
    cancelWatcherCoordinator(projectId);
  },
  getPackageOutputLayoutModeFromSettings(settings) {
    return getPackageOutputLayoutModeFromSettings(settings);
  },
  migratePackageOutputLayoutMode(settings) {
    return migratePackageOutputLayoutMode(settings);
  },
  createRendererFilePresentation(project, file) {
    return createRendererFilePresentation(project, file);
  },
};
`, filename);
};
let metadataTestHooks;
try {
  ({ __crateMetadataTestHooks: metadataTestHooks } = require(mainModulePath));
} finally {
  Module._extensions['.js'] = originalJavaScriptLoader;
}

async function callIpcRaw(channel, ...args) {
  const handler = ipcHandlers.get(channel);
  if (!handler) throw new Error(`No IPC handler registered for ${channel}`);
  return handler({ sender: trustedRendererWindow.webContents, senderFrame: trustedRendererMainFrame }, ...args);
}

const callIpc = createAutomaticPackageReviewCaller(callIpcRaw);

async function createProject(name = 'Provenance Dual Write') {
  return callIpc('projects:create', name, 'branding', 'current-page', null);
}

async function createVerifiedFigmaProject(name, scopeMode, url) {
  const previousFigmaStub = STUBS.get('./parsers/figma');
  const { FigmaParser } = require('../parsers/figma');
  class VerifiedFigmaLinkParser extends FigmaParser {
    async validateTrackedFileScope(fileKey, scopeEntry = {}) {
      const lockedPageId = scopeEntry.requestedPageId || scopeEntry.requestedNodeId || null;
      return {
        valid: true,
        scope: {
          scopeMode: scopeEntry.scopeMode,
          lockStatus: scopeEntry.scopeMode === 'entire-file' ? 'entire-file' : 'locked',
          lockedPageId,
          lockedPageName: lockedPageId ? 'Verified test page' : null,
          statusReason: null,
        },
      };
    }

    async autoTrackScan(project = {}) {
      return {
        files: [],
        assets: [],
        errors: [],
        warnings: [],
        scopeEntries: (project.figmaTrackedFiles || []).map(file => ({
          fileKey: file.key,
          primaryKey: file.key,
          fileFetchStatus: 'success',
          assetFetchStatus: 'success',
          lockStatus: project.figmaScopeMode === 'entire-file' ? 'entire-file' : 'locked',
          lockedPageId: file.requestedPageId || file.requestedNodeId || null,
          lockedPageName: (file.requestedPageId || file.requestedNodeId) ? 'Verified test page' : null,
          statusReason: null,
        })),
      };
    }
  }
  setStub('./parsers/figma', () => ({ FigmaParser: VerifiedFigmaLinkParser }));
  try {
    return await callIpc('projects:create', name, 'branding', scopeMode, url);
  } finally {
    if (previousFigmaStub) STUBS.set('./parsers/figma', previousFigmaStub);
    else STUBS.delete('./parsers/figma');
  }
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

async function waitForCondition(predicate, message, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) assert.fail(message);
    await new Promise(resolve => originalSetTimeout(resolve, 25));
  }
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

async function emitWatcher(eventName, filePath, ...args) {
  const handler = latestWatcherHandlers()[eventName];
  assert.equal(typeof handler, 'function', `expected ${eventName} watcher handler`);
  await handler(filePath, ...args);
}

async function emitWatcherWithStats(eventName, filePath, stats) {
  const originalStat = fs.promises.stat;
  fs.promises.stat = async function statForTest(candidatePath, ...args) {
    if (path.resolve(candidatePath) === path.resolve(filePath)) return stats;
    return originalStat.call(fs.promises, candidatePath, ...args);
  };
  try {
    await emitWatcher(eventName, filePath);
  } finally {
    fs.promises.stat = originalStat;
  }
}

function manualDialogFor(filePaths) {
  nextOpenDialogResult = { canceled: false, filePaths };
}

function writeSyntheticAiFile(filePath, content = '') {
  fs.writeFileSync(filePath, `%PDF-1.7\n${content}\n%%EOF\n`);
}

function writeSyntheticPdfFile(filePath, content = '') {
  fs.writeFileSync(filePath, `%PDF-1.7\n${content}\n%%EOF\n`);
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

async function setProjectFiles(projectId, {
  files = [],
  pendingFiles = [],
  liveEvidenceLedger,
  preserveAwaitingAssetBaseline = false,
} = {}) {
  const project = storeInstance.data.projects.find(item => item.id === projectId);
  assert.ok(project, 'expected project to exist');
  project.files = files;
  project.pendingFiles = pendingFiles;
  if (!preserveAwaitingAssetBaseline && project.assetBaseline?.status === 'awaiting-first-scan') {
    project.assetBaseline = {
      schemaVersion: 1,
      status: 'empty',
      decision: null,
      establishedAt: project.createdAt,
    };
  }
  if (arguments[1] && Object.prototype.hasOwnProperty.call(arguments[1], 'liveEvidenceLedger')) {
    project.liveEvidenceLedger = liveEvidenceLedger;
  }
  return project;
}

async function measureProjectFileVisualRequests(requestFactory, timeoutMs = 10000) {
  const counts = { lstat: 0, realpath: 0 };
  const originalLstat = fs.promises.lstat;
  const originalRealpath = fs.promises.realpath;
  let timeoutId = null;
  fs.promises.lstat = async function measuredFileVisualLstat(...args) {
    counts.lstat++;
    return originalLstat.call(fs.promises, ...args);
  };
  fs.promises.realpath = async function measuredFileVisualRealpath(...args) {
    counts.realpath++;
    return originalRealpath.call(fs.promises, ...args);
  };
  const startedAt = Date.now();
  try {
    const requestResult = Promise.resolve().then(requestFactory);
    const timeoutResult = new Promise((resolve, reject) => {
      timeoutId = originalSetTimeout(() => reject(new Error(`file visual requests exceeded ${timeoutMs}ms`)), timeoutMs);
    });
    const responses = await Promise.race([requestResult, timeoutResult]);
    return { ...counts, elapsedMs: Date.now() - startedAt, responses };
  } finally {
    if (timeoutId) originalClearTimeout(timeoutId);
    fs.promises.lstat = originalLstat;
    fs.promises.realpath = originalRealpath;
  }
}

async function settleAssetBaselineForUnrelatedPackageTest(projectId) {
  const current = await getProject(projectId);
  if (current.assetBaseline?.status === 'decision-required') {
    const decision = await callIpcRaw('projects:set-existing-assets-decision', projectId, 'include');
    assert.equal(decision.success, true);
    return;
  }
  if (current.assetBaseline?.status !== 'awaiting-first-scan') return;
  const stored = storeInstance.data.projects.find(item => item.id === projectId);
  stored.assetBaseline = {
    schemaVersion: 1,
    status: 'empty',
    decision: null,
    establishedAt: stored.createdAt,
  };
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crate-provenance-parser-'));
}

function encodeLastUsedXattr(timestampMs) {
  const bytes = Buffer.alloc(16);
  const seconds = Math.floor(timestampMs / 1000);
  const nanoseconds = Math.floor((timestampMs - (seconds * 1000)) * 1000000);
  bytes.writeBigInt64LE(BigInt(seconds), 0);
  bytes.writeBigInt64LE(BigInt(nanoseconds), 8);
  return bytes.toString('hex');
}

function bulkXattrPaths(request) {
  return request.kind === 'execFile' &&
    request.command === '/usr/bin/xattr' &&
    request.args[0] === '-pvx'
    ? request.args.slice(2)
    : [];
}

function singleXattrPath(request) {
  return request.kind === 'execFile' &&
    request.command === '/usr/bin/xattr' &&
    request.args[0] === '-px'
    ? request.args[2]
    : null;
}

function formatBulkXattrOutput(filePaths, valueForPath) {
  return filePaths.map(filePath => {
    const value = valueForPath(filePath);
    if (typeof value !== 'string' || value === '') return '';
    return `${filePath}: \n${value.match(/.{1,2}/g).join(' ')} \n`;
  }).join('');
}

function missingXattrError(filePaths, stdout = '') {
  const stderr = filePaths.map(filePath => (
    `xattr: ${filePath}: No such xattr: com.apple.lastuseddate#PS`
  )).join('\n');
  return {
    error: Object.assign(new Error('xattr returned mixed results'), {
      code: 1,
      stdout,
      stderr: `${stderr}\n`,
    }),
  };
}

function isBulkSpotlightRequest(request) {
  return request.kind === 'execFile' &&
    request.command === '/usr/bin/mdfind' &&
    request.args[0] === '-0' &&
    request.args[1] === '-onlyin' &&
    typeof request.args[2] === 'string';
}

function bulkSpotlightRoot(request) {
  return isBulkSpotlightRequest(request) ? request.args[2] : null;
}

function formatBulkSpotlightOutput(filePaths) {
  const paths = Array.isArray(filePaths) ? filePaths : [];
  return paths.length === 0 ? Buffer.alloc(0) : Buffer.from(`${paths.join('\0')}\0`, 'utf8');
}

function formatBulkSpotlightOutputForRoot(request, filePaths) {
  const root = bulkSpotlightRoot(request);
  if (!root) return Buffer.alloc(0);
  return formatBulkSpotlightOutput((Array.isArray(filePaths) ? filePaths : []).filter(filePath => {
    const relative = path.relative(root, filePath);
    return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
  }));
}

function expectedBulkSpotlightRoots() {
  return [
    path.join(TEST_HOME, 'Desktop'),
    path.join(TEST_HOME, 'Documents'),
    path.join(TEST_HOME, 'Downloads'),
    path.join(TEST_HOME, 'Library', 'Application Support', 'Figma'),
  ].filter(root => fs.existsSync(root)).map(root => path.resolve(root));
}

function installBulkMetadataHandler({ xattrForPath = () => null, spotlightPaths = [] } = {}) {
  setChildProcessHandler(request => {
    const paths = bulkXattrPaths(request);
    if (paths.length) return { stdout: formatBulkXattrOutput(paths, xattrForPath) };
    if (isBulkSpotlightRequest(request)) {
      return { stdout: formatBulkSpotlightOutputForRoot(request, spotlightPaths) };
    }
    return { stdout: '' };
  });
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

test('package layout defaults to folders and migration preserves explicit choices', () => {
  assert.equal(
    storeInstance.get('settings.packageOutputLayoutMode'),
    PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION
  );

  storeInstance.delete('settings.packageOutputLayoutMode');
  assert.equal(
    metadataTestHooks.migratePackageOutputLayoutMode(),
    PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION
  );
  assert.equal(
    storeInstance.get('settings.packageOutputLayoutMode'),
    PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION
  );

  for (const [value, expected] of [
    [PACKAGE_OUTPUT_LAYOUT_MODES.FLAT, PACKAGE_OUTPUT_LAYOUT_MODES.FLAT],
    [PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION, PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION],
    ['corrupt-layout-value', PACKAGE_OUTPUT_LAYOUT_MODES.FLAT],
  ]) {
    storeInstance.set('settings.packageOutputLayoutMode', value);
    assert.equal(metadataTestHooks.migratePackageOutputLayoutMode(), expected);
    assert.equal(storeInstance.get('settings.packageOutputLayoutMode'), expected);
  }
});

test('completed presentation cleanup records cannot remove a later file at the same cache path', () => {
  const cacheDir = fs.mkdtempSync(path.join(originalHomedir(), 'crate-presentation-cleanup-record-test-'));
  try {
    const filePath = path.join(cacheDir, 'media.png');
    fs.writeFileSync(filePath, 'first invocation');
    const firstStat = fs.lstatSync(filePath);
    const record = {
      filePath,
      cacheDir,
      dev: firstStat.dev,
      ino: firstStat.ino,
    };

    metadataTestHooks.removeOwnedDirectCacheFiles([record]);
    assert.equal(record.cleanupComplete, true);
    assert.equal(fs.existsSync(filePath), false);

    fs.writeFileSync(filePath, 'later invocation');
    const laterStat = fs.lstatSync(filePath);
    record.dev = laterStat.dev;
    record.ino = laterStat.ino;
    metadataTestHooks.removeOwnedDirectCacheFiles([record]);

    assert.equal(fs.readFileSync(filePath, 'utf8'), 'later invocation');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

async function waitForPathMissing(targetPath, message, timeoutMs = 1500) {
  const startedAt = Date.now();
  while (fs.existsSync(targetPath)) {
    if (Date.now() - startedAt > timeoutMs) {
      assert.fail(message || `timed out waiting for ${path.basename(targetPath)} cleanup`);
    }
    await new Promise(resolve => originalSetTimeout(resolve, 20));
  }
}

async function waitForProjectCacheCleanup(projectIds, timeoutMs = 2500) {
  removeUnsafeTestCacheEntries();
  if (!Array.isArray(storeInstance.data.projects)) storeInstance.data.projects = [];
  const sentinelId = `00000000-0000-4000-8002-${String(++cacheCleanupSentinelCounter).padStart(12, '0')}`;
  storeInstance.data.projects.push({ id: sentinelId });
  for (const category of ['figma-assets', 'presentation-assets']) {
    const sentinelDir = path.join(TEST_HOME, '.crate', category, sentinelId);
    fs.mkdirSync(sentinelDir, { recursive: true });
    fs.writeFileSync(path.join(sentinelDir, 'cleanup-sentinel.bin'), 'cleanup sentinel');
  }
  await callIpc('projects:delete', sentinelId);
  await waitForPathMissing(
    path.join(TEST_HOME, '.crate', 'figma-assets', sentinelId),
    'Figma cleanup sentinel should drain the serialized cleanup queue',
    timeoutMs
  );
  await waitForPathMissing(
    path.join(TEST_HOME, '.crate', 'presentation-assets', sentinelId),
    'presentation cleanup sentinel should drain the serialized cleanup queue',
    timeoutMs
  );

  for (const projectId of projectIds) {
    await waitForPathMissing(
      presentationCachePaths(projectId).projectDir,
      `presentation cache cleanup should finish for ${projectId}`,
      timeoutMs
    );
    await waitForPathMissing(
      path.join(TEST_HOME, '.crate', 'figma-assets', projectId),
      `Figma cache cleanup should finish for ${projectId}`,
      timeoutMs
    );
  }
  const cleanupStartedAt = Date.now();
  while (true) {
    const hasQuarantine = ['figma-assets', 'presentation-assets'].some((category) => {
      const categoryDir = path.join(TEST_HOME, '.crate', category);
      try {
        return fs.readdirSync(categoryDir).some(name => /^\.crate-cleanup-/.test(name));
      } catch (_) {
        return false;
      }
    });
    if (!hasQuarantine) break;
    if (Date.now() - cleanupStartedAt > timeoutMs) {
      assert.fail('serialized cleanup queue should leave no pending quarantine');
    }
    await new Promise(resolve => originalSetTimeout(resolve, 20));
  }
  await new Promise(resolve => setImmediate(resolve));
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

function observeProjectCacheInspection(targetPath) {
  const originalLstatSync = fs.lstatSync;
  const resolvedCategory = path.resolve(path.dirname(targetPath));
  let observedResolve;
  const observed = new Promise(resolve => { observedResolve = resolve; });
  fs.lstatSync = function observedLstatSync(candidatePath, ...args) {
    if (observedResolve && path.resolve(candidatePath) === resolvedCategory) {
      observedResolve();
      observedResolve = null;
    }
    return originalLstatSync.call(fs, candidatePath, ...args);
  };
  return {
    observed,
    restore() {
      fs.lstatSync = originalLstatSync;
    },
  };
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

function seedScopedRendererCandidate(project, filePath, {
  appFamily = 'illustrator',
  source = 'ai-linked',
  includePending = true,
} = {}) {
  const fileNodeId = createNodeId(NODE_TYPES.FILE, {
    normalizedPath: normalizeLedgerPathForTest(filePath),
  });
  const sessionNodeId = Object.keys(project.provenance.nodes)
    .find(nodeId => project.provenance.nodes[nodeId].type === NODE_TYPES.SESSION);
  const file = {
    ...makePendingFile(filePath, source),
    captureEvidence: {
      appFamily,
      observerMethod: appFamily === 'illustrator' ? 'illustrator-active-session' : `${appFamily}-test`,
    },
  };
  if (includePending) project.pendingFiles.push(file);
  project.liveEvidenceLedger = project.liveEvidenceLedger || { schemaVersion: 1, candidates: {} };
  project.liveEvidenceLedger.candidates = project.liveEvidenceLedger.candidates || {};
  Object.assign(project.liveEvidenceLedger.candidates, Object.fromEntries([
    makeLiveEvidenceLedgerEntry(filePath, 'pending', Date.now(), {
      latest: {
        source,
        observerMethod: file.captureEvidence.observerMethod,
        appFamily,
      },
    }),
  ]));
  project.provenance.nodes[fileNodeId] = {
    id: fileNodeId,
    type: NODE_TYPES.FILE,
    path: filePath,
    normalizedPath: normalizeLedgerPathForTest(filePath),
  };
  const edgeId = `scoped-renderer-edge-${fileNodeId}`;
  project.provenance.edges[edgeId] = {
    id: edgeId,
    relationType: EDGE_TYPES.SESSION_OBSERVED_FILE,
    subjectNodeId: sessionNodeId,
    objectNodeId: fileNodeId,
  };
  project.provenance.observations.push({
    id: `scoped-renderer-observation-${fileNodeId}`,
    relationType: EDGE_TYPES.SESSION_OBSERVED_FILE,
    subjectNodeId: sessionNodeId,
    objectNodeId: fileNodeId,
    observer: {
      kind: OBSERVER_KINDS.APP_SCRIPT,
      method: file.captureEvidence.observerMethod,
    },
  });
  return { file, fileNodeId };
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

function getPrivateStagedPackageRoot(filePath, outputDir) {
  const outputRoot = path.resolve(outputDir);
  for (const stagingParent of [path.dirname(outputRoot), outputRoot]) {
    const relative = path.relative(stagingParent, path.resolve(filePath));
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    const [stagingName, ...rest] = relative.split(path.sep);
    if (!stagingName.startsWith('.crate-package-staging-') || !rest.length) continue;
    return path.join(stagingParent, stagingName);
  }
  return null;
}

function findPrivateStagedPackageRoot(outputDir) {
  const outputRoot = path.resolve(outputDir);
  for (const stagingParent of [path.dirname(outputRoot), outputRoot]) {
    if (!fs.existsSync(stagingParent)) continue;
    const match = fs.readdirSync(stagingParent)
      .filter(name => name.startsWith('.crate-package-staging-'))
      .map(name => path.join(stagingParent, name))
      .find(candidatePath => {
        const stat = fs.lstatSync(candidatePath);
        return !stat.isSymbolicLink() && stat.isDirectory();
      });
    if (match) return match;
  }
  return null;
}

function isExpectedStagedPackageWrite(filePath, outputDir, outputName) {
  return !!getPrivateStagedPackageRoot(filePath, outputDir) && path.basename(filePath) === outputName;
}

async function assertPackageActivationDriftFailsClosed(scenario, mutateActivation) {
  const tmpRoot = makeTempDir();
  const originalOpen = fs.promises.open;
  let releaseWrite = () => {};
  try {
    setChildProcessHandler(() => ({ stdout: '' }));
    const project = await createProject(`Package drift ${scenario}`);
    const parentPsd = path.join(tmpRoot, `${scenario}.psd`);
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(parentPsd, 'parent PSD bytes');
    currentPsdFixture = {
      children: [],
      linkedFiles: [{
        name: `${scenario}.png`,
        data: Buffer.from(`${scenario} embedded bytes`),
      }],
    };
    await setProjectFiles(project.id, {
      files: [
        {
          path: parentPsd,
          name: `${scenario}.png`,
          ext: '.png',
          addedAt: Date.now(),
          source: 'scan-on-save-embedded',
          embedded: true,
          parentPsd,
          embeddedOriginalName: `${scenario}.png`,
          embeddedIndex: 0,
          fileId: `${scenario}-embedded`,
        },
      ],
    });
    const storedProject = storeInstance.data.projects.find(item => item.id === project.id);
    const packagePath = packageFolder(outputDir, `Package drift ${scenario}`);
    let markWriteStarted;
    let deferred = true;
    const writeStarted = new Promise(resolve => { markWriteStarted = resolve; });
    const writeGate = new Promise(resolve => { releaseWrite = resolve; });
    fs.promises.open = async function deferredPackageWrite(filePath, flags, ...args) {
      const handle = await originalOpen.call(fs.promises, filePath, flags, ...args);
      if (
        deferred &&
        flags === 'wx' &&
        isExpectedStagedPackageWrite(filePath, outputDir, `${scenario}.png`)
      ) {
        const originalHandleWriteFile = handle.writeFile.bind(handle);
        handle.writeFile = async (...writeArgs) => {
          deferred = false;
          markWriteStarted();
          await writeGate;
          return originalHandleWriteFile(...writeArgs);
        };
      }
      return handle;
    };

    const packagePromise = callIpc('projects:package', project.id, outputDir);
    const firstResult = await Promise.race([
      writeStarted.then(() => null),
      packagePromise,
    ]);
    assert.equal(firstResult, null, `package completed before deferred write: ${JSON.stringify(firstResult)}`);
    await mutateActivation(project);
    testRendererEvents.length = 0;
    releaseWrite();
    const result = await packagePromise;

    assert.deepEqual(result, { error: 'stale_activation' });
    assert.equal(fs.existsSync(packagePath), false);
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 0);
    assert.equal(
      getProvenanceEdges(storedProject, EDGE_TYPES.PACKAGE_INCLUDES_FILE).length,
      0
    );
    assert.equal(
      getProvenanceEdges(storedProject, EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE).length,
      0
    );
    assert.notEqual(storedProject.status, 'packaged');
    assert.equal(storedProject.packagedAt == null, true);
    assert.equal(storedProject.outputPath == null, true);
    assert.equal(
      testRendererEvents.some(entry => entry.channel === 'project:updated'),
      false
    );
  } finally {
    releaseWrite();
    fs.promises.open = originalOpen;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function assertPackageScopePollBehavior(semanticChange) {
  const tmpRoot = makeTempDir();
  const originalOpen = fs.promises.open;
  let releaseWrite = () => {};
  try {
    setChildProcessHandler(() => ({ stdout: '' }));
    const label = semanticChange ? 'same-token scope drift' : 'unchanged poll';
    const project = await createProject(`Package ${label}`);
    const parentPsd = path.join(tmpRoot, 'scope-poll.psd');
    const changedSource = path.join(tmpRoot, 'scope-poll.ai');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(parentPsd, 'parent PSD bytes');
    fs.writeFileSync(changedSource, 'Illustrator bytes');
    currentPsdFixture = {
      children: [],
      linkedFiles: [{ name: 'scope-poll.png', data: Buffer.from('embedded bytes') }],
    };
    await setProjectFiles(project.id, {
      files: [{
        path: parentPsd,
        name: 'scope-poll.png',
        ext: '.png',
        addedAt: Date.now(),
        source: 'scan-on-save-embedded',
        embedded: true,
        parentPsd,
        embeddedOriginalName: 'scope-poll.png',
        embeddedIndex: 0,
        fileId: 'scope-poll-embedded',
      }],
    });
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    const packagePath = packageFolder(outputDir, `Package ${label}`);
    let markWriteStarted;
    let deferred = true;
    const writeStarted = new Promise(resolve => { markWriteStarted = resolve; });
    const writeGate = new Promise(resolve => { releaseWrite = resolve; });
    fs.promises.open = async function deferredScopeWrite(filePath, flags, ...args) {
      const handle = await originalOpen.call(fs.promises, filePath, flags, ...args);
      if (deferred && flags === 'wx' && isExpectedStagedPackageWrite(filePath, outputDir, 'scope-poll.png')) {
        const originalHandleWriteFile = handle.writeFile.bind(handle);
        handle.writeFile = async (...writeArgs) => {
          deferred = false;
          markWriteStarted();
          await writeGate;
          return originalHandleWriteFile(...writeArgs);
        };
      }
      return handle;
    };

    const packagePromise = callIpc('projects:package', project.id, outputDir);
    const firstResult = await Promise.race([
      writeStarted.then(() => null),
      packagePromise,
    ]);
    assert.equal(firstResult, null, `package completed before deferred write: ${JSON.stringify(firstResult)}`);
    setChildProcessHandler(({ kind, command, args }) => {
      if (isIllustratorPgrepCheck({ kind, command, args })) return { stdout: '753\n' };
      if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
        return {
          stdout: semanticChange
            ? `DOC\t${changedSource}\t${path.basename(changedSource)}\tfalse\ttrue\nCOMPLETE\t1\t0\n`
            : 'STATUS\tno-documents\nCOMPLETE\t0\t0\n',
        };
      }
      return { stdout: '' };
    });
    await runTrackedIntervalCallbacks();
    releaseWrite();
    const result = await packagePromise;

    if (semanticChange) {
      assert.deepEqual(result, { error: 'stale_activation' });
      assert.equal(fs.existsSync(packagePath), false);
      assert.equal(storeInstance.get('usage.packagesThisMonth'), 0);
      assert.equal(getProvenanceEdges(stored, EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE).length, 0);
      assert.notEqual(stored.status, 'packaged');
      return;
    }
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(fs.existsSync(path.join(packagePath, 'scope-poll.png')), true);
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 1);
    assert.equal(stored.status, 'packaged');
  } finally {
    fs.promises.open = originalOpen;
    releaseWrite();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function assertStalePsdExtractionLeavesNoInvocationFiles(scenario) {
  const tmpRoot = makeTempDir();
  const originalWriteFile = fs.promises.writeFile;
  let releaseLaterWrite = () => {};
  let extractDir = null;
  try {
    setChildProcessHandler(() => ({ stdout: '' }));
    const otherProject = scenario === 'B-A-B'
      ? await createProject('Stale PSD extraction A')
      : null;
    const project = await createProject(`Stale PSD extraction ${scenario}`);
    const psdPath = path.join(tmpRoot, `${scenario}.psd`);
    extractDir = path.join(os.tmpdir(), `crate-psd-extract-${project.id}`);
    fs.writeFileSync(psdPath, 'psd bytes');
    fs.rmSync(extractDir, { recursive: true, force: true });
    currentPsdFixture = {
      children: [],
      linkedFiles: [
        { name: 'earlier.png', data: Buffer.from('earlier invocation bytes') },
        { name: 'later.png', data: Buffer.from('later invocation bytes') },
      ],
    };
    await setProjectFiles(project.id, {
      files: [{
        path: psdPath,
        name: path.basename(psdPath),
        ext: '.psd',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    await getProject(project.id);
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    const persistedBefore = structuredClone({
      files: stored.files,
      pendingFiles: stored.pendingFiles,
      liveEvidenceLedger: stored.liveEvidenceLedger,
      provenance: stored.provenance,
    });
    let extractionWriteCount = 0;
    let markLaterWriteFinished;
    const laterWriteFinished = new Promise(resolve => { markLaterWriteFinished = resolve; });
    const laterWriteGate = new Promise(resolve => { releaseLaterWrite = resolve; });
    fs.promises.writeFile = async function deferAfterPsdExtractionWrite(filePath, ...args) {
      if (path.dirname(path.resolve(filePath)) === path.resolve(extractDir)) {
        extractionWriteCount++;
        await originalWriteFile.call(fs.promises, filePath, ...args);
        if (extractionWriteCount === 2) {
          markLaterWriteFinished();
          await laterWriteGate;
          return;
        }
      } else {
        return originalWriteFile.call(fs.promises, filePath, ...args);
      }
    };

    testRendererEvents.length = 0;
    const scanPromise = callIpc('projects:pre-package-scan', project.id);
    await laterWriteFinished;
    if (scenario === 'pause') await callIpc('projects:pause', project.id);
    if (scenario === 'delete') await callIpc('projects:delete', project.id);
    if (scenario === 'B-A-B') {
      await callIpc('projects:start-watching', otherProject.id);
      await callIpc('projects:start-watching', project.id);
    }
    testRendererEvents.length = 0;
    releaseLaterWrite();
    const result = await scanPromise;

    assert.equal(result, null);
    assert.deepEqual(fs.existsSync(extractDir) ? fs.readdirSync(extractDir) : [], []);
    assert.deepEqual({
      files: stored.files,
      pendingFiles: stored.pendingFiles,
      liveEvidenceLedger: stored.liveEvidenceLedger,
      provenance: stored.provenance,
    }, persistedBefore);
    assert.equal(JSON.stringify(testRendererEvents).includes(extractDir), false);
  } finally {
    fs.promises.writeFile = originalWriteFile;
    releaseLaterWrite();
    if (extractDir) fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function assertPackageRootReplacementFailsClosed(lane, replacement) {
  resetTestHomeWorkspace();
  const tmpRoot = makeTempDir();
  const originalOpen = fs.promises.open;
  let releaseWrite = () => {};
  try {
    setChildProcessHandler(() => ({ stdout: '' }));
    const projectName = `Package root ${lane} ${replacement}`;
    const project = await createProject(projectName);
    const outputDir = path.join(tmpRoot, 'out');
    const packagePath = packageFolder(outputDir, projectName);
    const movedRoot = path.join(tmpRoot, 'moved-output-root');
    const replacementRoot = path.join(tmpRoot, 'replacement-target');
    const regularPath = path.join(tmpRoot, 'already-copied.txt');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(regularPath, 'transaction-owned copy');
    const files = [{
      path: regularPath,
      name: path.basename(regularPath),
      ext: '.txt',
      addedAt: Date.now(),
      source: 'manual-browse',
    }];

    let markWriteStarted;
    const writeStarted = new Promise(resolve => { markWriteStarted = resolve; });
    const writeGate = new Promise(resolve => { releaseWrite = resolve; });
    if (lane === 'psd') {
      const parentPsd = path.join(tmpRoot, 'deferred.psd');
      fs.writeFileSync(parentPsd, 'PSD bytes');
      currentPsdFixture = {
        children: [],
        linkedFiles: [{ name: 'deferred.png', data: Buffer.from('embedded transaction bytes') }],
      };
      files.push({
        path: parentPsd,
        name: 'deferred.png',
        ext: '.png',
        addedAt: Date.now(),
        source: 'scan-on-save-embedded',
        embedded: true,
        parentPsd,
        embeddedOriginalName: 'deferred.png',
        embeddedIndex: 0,
        fileId: 'deferred-root-embedded',
      });
      let deferred = true;
      fs.promises.open = async function deferredPsdWrite(filePath, flags, ...args) {
        const handle = await originalOpen.call(fs.promises, filePath, flags, ...args);
        const stagingRoot = getPrivateStagedPackageRoot(filePath, outputDir);
        if (deferred && flags === 'wx' && stagingRoot && path.basename(filePath) === 'deferred.png') {
          const originalHandleWriteFile = handle.writeFile.bind(handle);
          handle.writeFile = async (...writeArgs) => {
            deferred = false;
            const result = await originalHandleWriteFile(...writeArgs);
            markWriteStarted(stagingRoot);
            await writeGate;
            return result;
          };
        }
        return handle;
      };
      setChildProcessHandler(() => ({ stdout: '' }));
    } else {
      const presentationPath = path.join(tmpRoot, 'Deck.pptx');
      fs.writeFileSync(presentationPath, 'presentation bytes');
      files.push({
        path: presentationPath,
        name: path.basename(presentationPath),
        ext: '.pptx',
        addedAt: Date.now(),
        source: 'manual-browse',
      });
      setChildProcessHandler(({ kind, command, args }) => {
        if (kind === 'execFile' && command === '/usr/bin/unzip' && args[0] === '-l') {
          return {
            stdout: [
              'Archive: Deck.pptx',
              '  Length      Date    Time    Name',
              '---------  ---------- -----   ----',
              '     2048  07-31-2026 12:00   ppt/media/image1.png',
              '---------                     -------',
            ].join('\n'),
          };
        }
        if (kind === 'execFile' && command === '/usr/bin/unzip' && args[0] === '-p') {
          const stagingRoot = getPrivateStagedPackageRoot(args[1], outputDir);
          if (stagingRoot) {
            markWriteStarted(stagingRoot);
            return writeGate.then(() => ({ stdout: Buffer.from('presentation transaction bytes') }));
          }
          return { stdout: Buffer.from('presentation transaction bytes') };
        }
        return { stdout: '' };
      });
    }
    await setProjectFiles(project.id, { files });
    const stored = storeInstance.data.projects.find(item => item.id === project.id);

    const packagePromise = callIpc('projects:package', project.id, outputDir);
    const boundary = await Promise.race([
      writeStarted.then(stagingRoot => ({ stagingRoot })),
      packagePromise.then(result => ({ result })),
    ]);
    assert.ok(boundary.stagingRoot, `package completed before deferred staging boundary: ${JSON.stringify(boundary.result)}`);
    const stagingRoot = boundary.stagingRoot;
    assert.equal(path.dirname(stagingRoot), path.dirname(outputDir));
    assertOwnerOnlyMode(stagingRoot, 0o700);
    fs.renameSync(outputDir, movedRoot);
    if (replacement === 'symlink') {
      fs.mkdirSync(replacementRoot);
      fs.symlinkSync(replacementRoot, outputDir, 'dir');
    } else {
      fs.mkdirSync(outputDir);
    }
    testRendererEvents.length = 0;
    releaseWrite();
    const result = await packagePromise;

    assert.deepEqual(result, { error: 'package_output_changed' });
    const movedPackagePath = path.join(movedRoot, path.basename(packagePath));
    const replacementPackagePath = path.join(replacementRoot, path.basename(packagePath));
    for (const root of [packagePath, movedPackagePath, replacementPackagePath, stagingRoot]) {
      for (const fileName of ['already-copied.txt', 'deferred.png', 'Deck.pptx', 'Deck — image1.png']) {
        assert.equal(fs.existsSync(path.join(root, fileName)), false, `${root}/${fileName} must be absent`);
      }
    }
    assert.equal(fs.readdirSync(movedRoot).some(name => name.startsWith('.crate-package-staging-')), false);
    assert.equal(fs.readdirSync(outputDir).some(name => name.startsWith('.crate-package-staging-')), false);
    assert.equal(fs.readdirSync(tmpRoot).some(name => name.startsWith('.crate-package-staging-')), false);
    if (fs.existsSync(replacementRoot)) {
      assert.equal(fs.readdirSync(replacementRoot).some(name => name.startsWith('.crate-package-staging-')), false);
    }
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 0);
    assert.equal(getProvenanceEdges(stored, EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 0);
    assert.equal(getProvenanceEdges(stored, EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE).length, 0);
    assert.notEqual(stored.status, 'packaged');
    assert.equal(stored.packagedAt == null, true);
    assert.equal(stored.outputPath == null, true);
    assert.equal(testRendererEvents.some(entry => entry.channel === 'project:updated'), false);
  } finally {
    fs.promises.open = originalOpen;
    releaseWrite();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function assertPrePackageAwaitRaceFailsClosed(awaitPoint, race) {
  resetTestHomeWorkspace();
  const originalReadFile = fs.promises.readFile;
  let releaseAwait = () => {};
  let restoreFigmaParser = null;
  try {
    setChildProcessHandler(() => ({ stdout: '' }));
    const project = await createProject(`Prepackage ${awaitPoint} ${race}`);
    const candidatePath = path.join(TEST_HOME, 'Desktop', `${awaitPoint}-${race}-candidate.png`);
    const sourceExtension = awaitPoint === 'psd-parser' ? '.psd' : '.ai';
    const sourcePath = path.join(TEST_HOME, 'Desktop', `${awaitPoint}-${race}-source${sourceExtension}`);
    const scopeDriftPath = path.join(TEST_HOME, 'Desktop', `.scope-drift-${awaitPoint}.ai`);
    fs.writeFileSync(candidatePath, `${awaitPoint} candidate bytes`);
    fs.writeFileSync(sourcePath, `${sourcePath}\n${candidatePath}\n`);
    fs.writeFileSync(scopeDriftPath, 'scope drift source bytes');
    if (awaitPoint === 'metadata') {
      fs.writeFileSync(
        path.join(TEST_HOME, 'Desktop', `${awaitPoint}-${race}-metadata.svg`),
        'metadata candidate bytes'
      );
    } else if (awaitPoint === 'psd-parser' || awaitPoint === 'linked-file') {
      await setProjectFiles(project.id, {
        files: [{
          path: sourcePath,
          name: path.basename(sourcePath),
          ext: sourceExtension,
          addedAt: Date.now(),
          source: 'manual-browse',
        }],
      });
    }
    if (awaitPoint === 'psd-parser') {
      currentPsdFixture = {
        children: [{ linkedFile: { fullPath: candidatePath } }],
        linkedFiles: [],
      };
    }

    let markAwaitStarted;
    const awaitStarted = new Promise(resolve => { markAwaitStarted = resolve; });
    const awaitGate = new Promise(resolve => { releaseAwait = resolve; });
    let gateUsed = false;
    const gateResult = async (result) => {
      if (!gateUsed) {
        gateUsed = true;
        markAwaitStarted();
        await awaitGate;
      }
      return result;
    };
    if (awaitPoint === 'figma') {
      const stored = storeInstance.data.projects.find(item => item.id === project.id);
      stored.figmaSession = {
        startedAt: stored.watchStartedAt,
        scopeMode: 'current-page',
        teamIds: [],
        warnings: [],
        trackedFiles: [{
          key: 'same-token-figma-file',
          lockStatus: 'locked',
          lockedPageId: '1:1',
          lockedPageName: 'Page 1',
        }],
      };
      const { FigmaParser } = require('../parsers/figma');
      class DeferredFigmaParser extends FigmaParser {
        async autoTrackScan() {
          return gateResult({
            assets: [],
            errors: [],
            scopeEntries: [{
              fileKey: 'same-token-figma-file',
              primaryKey: 'same-token-figma-file',
              fileFetchStatus: 'success',
              assetFetchStatus: 'success',
              lockStatus: 'locked',
              lockedPageId: '1:1',
              lockedPageName: 'Page 1',
            }],
          });
        }
      }
      setStub('./parsers/figma', () => ({ FigmaParser: DeferredFigmaParser }));
      restoreFigmaParser = () => STUBS.delete('./parsers/figma');
    }
    setChildProcessHandler(({ kind, command, args, options }) => {
      const request = { kind, command, args, options };
      if (isIllustratorPgrepCheck(request)) return { stdout: '' };
      const xattrPaths = bulkXattrPaths(request);
      if (xattrPaths.length) return missingXattrError(xattrPaths);
      if (awaitPoint === 'metadata' && isBulkSpotlightRequest(request)) {
        return gateResult({ stdout: formatBulkSpotlightOutputForRoot(request, [candidatePath]) });
      }
      if (kind === 'exec' && command.includes("grep -i 'Adobe Photoshop'")) {
        return { stdout: awaitPoint === 'photoshop' ? 'Adobe Photoshop\n' : '' };
      }
      if (
        awaitPoint === 'photoshop' &&
        isOsascriptInvocation({ kind, command, args }, 'crate-ps-scan.applescript')
      ) {
        return gateResult({ stdout: `${candidatePath}\n` });
      }
      if (kind === 'exec' && command.includes("grep -i 'Adobe InDesign'")) {
        return { stdout: awaitPoint === 'indesign' ? 'Adobe InDesign\n' : '' };
      }
      if (
        awaitPoint === 'indesign' &&
        isOsascriptInvocation({ kind, command, args }, 'crate-indd-scan.applescript')
      ) {
        return gateResult({ stdout: `${candidatePath}\n` });
      }
      return { stdout: '' };
    });
    if (awaitPoint === 'psd-parser' || awaitPoint === 'linked-file') {
      fs.promises.readFile = async function gatedPrePackageRead(filePath, ...args) {
        if (!gateUsed && path.resolve(filePath) === path.resolve(sourcePath)) {
          await gateResult(null);
        }
        return originalReadFile.call(fs.promises, filePath, ...args);
      };
    }

    const scanPromise = callIpc('projects:pre-package-scan', project.id);
    const firstResult = await Promise.race([awaitStarted.then(() => null), scanPromise]);
    assert.equal(firstResult, null, `${awaitPoint}/${race} scan completed before deferred await`);
    if (race === 'same-token') {
      manualDialogFor([scopeDriftPath]);
      await callIpc('projects:add-files', project.id);
    } else if (race === 'pause') {
      await callIpc('projects:pause', project.id);
    } else if (race === 'delete') {
      await callIpc('projects:delete', project.id);
    } else {
      const other = await createProject(`Prepackage ${awaitPoint} switch`);
      await callIpc('projects:start-watching', project.id);
      assert.equal((await getProject(other.id)).status, 'paused');
    }
    testRendererEvents.length = 0;
    releaseAwait();
    const result = await scanPromise;

    assert.equal(result, null, `${awaitPoint}/${race} must not return a stale scan payload`);
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    if (stored) {
      assert.equal(
        [...stored.files, ...(stored.pendingFiles || [])].some(file => file.path === candidatePath),
        false,
        `${awaitPoint}/${race} must not stage the stale candidate`
      );
      assert.equal(
        JSON.stringify(stored.provenance || {}).includes(candidatePath),
        false,
        `${awaitPoint}/${race} must not record stale provenance`
      );
    }
    assert.equal(
      testRendererEvents.some(entry => entry.data && entry.data.projectId === project.id),
      false,
      `${awaitPoint}/${race} must not emit stale renderer state`
    );
  } finally {
    fs.promises.readFile = originalReadFile;
    if (restoreFigmaParser) restoreFigmaParser();
    releaseAwait();
  }
}

async function assertAcceptPendingScanRaceFailsClosed(parserLane, race) {
  resetTestHomeWorkspace();
  const fixtureRoot = path.join(
    path.resolve(__dirname, '..'),
    `test-accept-${parserLane}-${race}`
  );
  const originalReadFile = fs.promises.readFile;
  const originalStat = fs.promises.stat;
  const originalAccess = fs.promises.access;
  let releaseParse = () => {};
  let psdExtractDir = null;
  try {
    fs.mkdirSync(fixtureRoot, { recursive: true });
    setChildProcessHandler(() => ({ stdout: '' }));
    const project = await createProject(`Accept ${parserLane} ${race}`);
    const sourceExt = parserLane === 'psd' ? '.psd' : '.indd';
    const sourcePath = path.join(fixtureRoot, `accepted-source${sourceExt}`);
    psdExtractDir = path.join(os.tmpdir(), `crate-psd-extract-${project.id}`);
    const bootstrapLinkedPath = `/Users/crate-test/${parserLane}-${race}-bootstrap.png`;
    const candidatePath = parserLane === 'psd'
      ? path.join(psdExtractDir, 'psd-candidate.png')
      : `/Users/crate-test/${parserLane}-${race}-candidate.png`;
    fs.writeFileSync(
      sourcePath,
      `linked reference ${parserLane === 'linked' ? candidatePath : bootstrapLinkedPath}`
    );
    if (parserLane === 'psd') {
      currentPsdFixture = {
        children: [],
        linkedFiles: [{ name: 'psd-candidate.png', data: Buffer.from('embedded candidate bytes') }],
      };
    }
    await setProjectFiles(project.id, {
      pendingFiles: [makePendingFile(sourcePath)],
    });

    let sourceStats = 0;
    let markParseStarted;
    const parseStarted = new Promise(resolve => { markParseStarted = resolve; });
    const parseGate = new Promise(resolve => { releaseParse = resolve; });
    fs.promises.readFile = async function deferredAcceptedSourceRead(filePath, ...args) {
      if (parserLane === 'linked' && path.resolve(filePath) === path.resolve(sourcePath)) {
        markParseStarted();
        await parseGate;
      }
      return originalReadFile.call(fs.promises, filePath, ...args);
    };
    fs.promises.stat = async function deferredAcceptedSourceStat(filePath, ...args) {
      if (parserLane === 'psd' && path.resolve(filePath) === path.resolve(sourcePath)) {
        sourceStats++;
        if (sourceStats === 2) {
          markParseStarted();
          await parseGate;
        }
      }
      return originalStat.call(fs.promises, filePath, ...args);
    };
    fs.promises.access = async function acceptedLinkedCandidateAccess(filePath, ...args) {
      if (filePath === candidatePath || filePath === bootstrapLinkedPath) return;
      return originalAccess.call(fs.promises, filePath, ...args);
    };

    const acceptPromise = callIpc('projects:accept-pending', project.id, sourcePath);
    await parseStarted;
    if (race === 'pause') {
      await callIpc('projects:pause', project.id);
    } else if (race === 'delete') {
      await callIpc('projects:delete', project.id);
    } else {
      await createProject(`Accept ${parserLane} switch`);
      await callIpc('projects:start-watching', project.id);
    }
    testRendererEvents.length = 0;
    releaseParse();
    const result = await acceptPromise;
    await new Promise(resolve => originalSetTimeout(resolve, 50));

    assert.equal(result, null, `${parserLane}/${race} must not return stale accepted state`);
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    if (stored) {
      assert.equal(
        [...stored.files, ...(stored.pendingFiles || [])].some(file => file.path === candidatePath),
        false,
        `${parserLane}/${race} must not stage parser output`
      );
      assert.equal(JSON.stringify(stored.provenance || {}).includes(candidatePath), false);
    }
    assert.equal(
      testRendererEvents.some(entry => entry.data && entry.data.projectId === project.id),
      false,
      `${parserLane}/${race} must not emit stale parser state`
    );
  } finally {
    fs.promises.readFile = originalReadFile;
    fs.promises.stat = originalStat;
    fs.promises.access = originalAccess;
    releaseParse();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    if (psdExtractDir) fs.rmSync(psdExtractDir, { recursive: true, force: true });
  }
}

test('mac build metadata declares Apple Events usage and preserves Automation entitlement', () => {
  assert.equal(packageJson.build.appId, 'com.crate.app');
  assert.equal(packageJson.build.afterPack, 'scripts/patch-helper-info-plists.js');
  assert.equal(packageJson.build.mac.entitlements, 'entitlements.plist');
  assert.equal(packageJson.build.mac.entitlementsInherit, 'entitlements.inherit.plist');
  const usageDescription = packageJson.build.mac.extendInfo
    && packageJson.build.mac.extendInfo.NSAppleEventsUsageDescription;
  assert.match(
    usageDescription,
    /Automation.*open design documents.*linked assets.*Adobe Illustrator/i
  );

  const entitlementsPath = path.resolve(__dirname, '..', 'entitlements.plist');
  const entitlements = fs.readFileSync(entitlementsPath, 'utf8');
  const inheritedEntitlementsPath = path.resolve(__dirname, '..', 'entitlements.inherit.plist');
  const inheritedEntitlements = fs.readFileSync(inheritedEntitlementsPath, 'utf8');
  assert.match(entitlements, /com\.apple\.security\.automation\.apple-events/);
  assert.match(entitlements, /com\.apple\.security\.cs\.disable-library-validation/);
  assert.equal(
    inheritedEntitlements.includes('com.apple.security.automation.apple-events'),
    false
  );
  assert.match(inheritedEntitlements, /com\.apple\.security\.cs\.disable-library-validation/);
  assert.equal(entitlements.includes('com.apple.security.app-sandbox'), false);
  assert.equal(inheritedEntitlements.includes('com.apple.security.app-sandbox'), false);
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

function setPresentationUnzipFixture(mediaEntries, archiveName = 'deck.pptx', options = {}) {
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
      const result = { stdout: Buffer.concat(buffers), stderr: '' };
      if (typeof options.onReadStart === 'function') options.onReadStart(args[2]);
      const readGate = typeof options.readGateForPath === 'function'
        ? options.readGateForPath(args[2])
        : options.readGate;
      return readGate ? Promise.resolve(readGate).then(() => result) : result;
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

function setPowerPointUnzipFixture(mediaEntries, options = {}) {
  setPresentationUnzipFixture(mediaEntries, 'deck.pptx', options);
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
  childProcessSpawnHandler = null;
  childProcessSpawnSyncHandler = null;
  testFetchHandler = async () => ({ ok: false, status: 500, json: async () => ({}) });
  nextOpenDialogResult = { canceled: true };
  currentPsdFixture = { children: [], linkedFiles: [] };
  if (storeInstance) {
    const projects = storeInstance.get('projects', []);
    const projectIds = Array.isArray(projects)
      ? projects.filter(project => project && typeof project.id === 'string').map(project => project.id)
      : [];
    await callIpc('projects:delete-all');
    removeUnsafeTestCacheEntries();
    await waitForProjectCacheCleanup(projectIds);
  }
  if (storeInstance) storeInstance.set('settings.includeDiagnosticReport', false);
  if (storeInstance) storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.FLAT);
  if (storeInstance) storeInstance.set('usage.packagesThisMonth', 0);
  if (storeInstance) storeInstance.measureProjectSerialization = false;
  if (storeInstance) storeInstance.projectSerializedBytes = 0;
  testNotificationSupported = false;
  testAppActive = true;
  testMainWindowVisible = true;
  testAppVersion = packageJson.version;
  testBrowserWindowCreateCount = 0;
  testMainWindowShowCount = 0;
  testNotifications.length = 0;
  testMessageBoxes.length = 0;
  watcherRecords.length = 0;
  watcherCloseCount = 0;
  testUuidCounter = 0;
  testNativeFileVisualImage = null;
  testNativeFileIconImage = null;
  testLastNativeImageBuffer = null;
  testLastNativeThumbnailPath = null;
  testLastNativeThumbnailSize = null;
  testLastNativeThumbnailBytes = null;
  testNativeThumbnailCalls = 0;
  testNativeCreateFromBufferCalls = 0;
  testBeforeNativeThumbnailResolve = null;
  testLastFileIconPath = null;
  testLastFileIconOptions = null;
  metadataTestHooks.clearFileVisualTypeIconCache();
  metadataTestHooks.clearFileVisualProjectCache();
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
    assert.deepEqual(Object.keys(extracted).sort(), ['addedAt', 'assetOrigin', 'ext', 'name', 'path', 'projectRole', 'source']);
    assert.equal(extracted.assetOrigin, 'added');
    assert.equal(extracted.projectRole, 'asset');
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

test('deleting a project during presentation extraction leaves no late project cache', async () => {
  const tmpRoot = makeTempDir();
  let releaseRead = () => {};
  let cacheInspection = null;
  try {
    resetPresentationCacheRoot();
    const project = await createProject('Delete During Presentation Extraction');
    const pptxPath = path.join(tmpRoot, 'Delete-During-Scan.pptx');
    fs.writeFileSync(pptxPath, Buffer.from('pptx container bytes'));
    await setProjectFiles(project.id, {
      files: [{
        path: pptxPath,
        name: 'Delete-During-Scan.pptx',
        ext: '.pptx',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });

    const readGate = new Promise(resolve => { releaseRead = resolve; });
    let markReadStarted;
    const readStarted = new Promise(resolve => { markReadStarted = resolve; });
    setPowerPointUnzipFixture([{
      internalPath: 'ppt/media/image1.jpeg',
      data: Buffer.from('LATE_PRESENTATION_MEDIA'.repeat(40)),
    }], {
      readGate,
      onReadStart: markReadStarted,
    });

    await emitWatcher('change', pptxPath);
    await readStarted;
    await callIpc('projects:delete', project.id);
    await waitForPathMissing(
      presentationCachePaths(project.id).projectDir,
      'initial deletion cleanup should remove the in-flight presentation cache'
    );
    cacheInspection = observeProjectCacheInspection(presentationCachePaths(project.id).projectDir);
    releaseRead();
    await cacheInspection.observed;
    await new Promise(resolve => setImmediate(resolve));
    await waitForPathMissing(
      presentationCachePaths(project.id).projectDir,
      'presentation finalizer should leave no late project cache'
    );

    assert.equal(fs.existsSync(presentationCachePaths(project.id).projectDir), false);
    assert.equal(await getProject(project.id), undefined);
  } finally {
    releaseRead();
    if (cacheInspection) cacheInspection.restore();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('a delayed presentation scan from an old A activation cannot cache or mutate after A to B to A', async () => {
  const tmpRoot = makeTempDir();
  let releaseRead = () => {};
  try {
    resetPresentationCacheRoot();
    const first = await createProject('Delayed Presentation Activation A');
    const firstWatcher = latestWatcherHandlers();
    const pptxPath = path.join(tmpRoot, 'Delayed-Activation.pptx');
    fs.writeFileSync(pptxPath, Buffer.from('pptx container bytes'));
    await setProjectFiles(first.id, {
      files: [{
        path: pptxPath,
        name: 'Delayed-Activation.pptx',
        ext: '.pptx',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });

    const readGate = new Promise(resolve => { releaseRead = resolve; });
    let markReadStarted;
    const readStarted = new Promise(resolve => { markReadStarted = resolve; });
    setPowerPointUnzipFixture([{
      internalPath: 'ppt/media/image1.jpeg',
      data: Buffer.from('STALE_PRESENTATION_MEDIA'.repeat(40)),
    }], {
      readGate,
      onReadStart: markReadStarted,
    });

    await firstWatcher.change(pptxPath);
    await readStarted;
    const second = await createProject('Delayed Presentation Activation B');
    await callIpc('projects:start-watching', first.id);
    releaseRead();
    await new Promise(resolve => originalSetTimeout(resolve, 100));

    const firstFresh = await getProject(first.id);
    const secondFresh = await getProject(second.id);
    assert.equal(firstFresh.status, 'watching');
    assert.equal(secondFresh.status, 'paused');
    assert.equal(firstFresh.files.filter(file => file.source === 'scan-on-save-presentation').length, 0);
    assert.equal(secondFresh.files.filter(file => file.source === 'scan-on-save-presentation').length, 0);
    assert.equal(getProvenanceEdges(firstFresh, EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 0);
    const cacheDir = presentationCachePaths(first.id).projectDir;
    assert.equal(fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).length : 0, 0);
  } finally {
    releaseRead();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('delete-all during presentation extraction leaves no late project cache', async () => {
  const tmpRoot = makeTempDir();
  let releaseRead = () => {};
  let cacheInspection = null;
  try {
    resetPresentationCacheRoot();
    const project = await createProject('Delete All During Presentation Extraction');
    const pptxPath = path.join(tmpRoot, 'Delete-All-During-Scan.pptx');
    fs.writeFileSync(pptxPath, Buffer.from('pptx container bytes'));
    await setProjectFiles(project.id, {
      files: [{
        path: pptxPath,
        name: 'Delete-All-During-Scan.pptx',
        ext: '.pptx',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });

    const readGate = new Promise(resolve => { releaseRead = resolve; });
    let markReadStarted;
    const readStarted = new Promise(resolve => { markReadStarted = resolve; });
    setPowerPointUnzipFixture([{
      internalPath: 'ppt/media/image1.jpeg',
      data: Buffer.from('LATE_DELETE_ALL_PRESENTATION_MEDIA'.repeat(40)),
    }], {
      readGate,
      onReadStart: markReadStarted,
    });

    await emitWatcher('change', pptxPath);
    await readStarted;
    await callIpc('projects:delete-all');
    await waitForPathMissing(
      presentationCachePaths(project.id).projectDir,
      'initial delete-all cleanup should remove the in-flight presentation cache'
    );
    cacheInspection = observeProjectCacheInspection(presentationCachePaths(project.id).projectDir);
    releaseRead();
    await cacheInspection.observed;
    await new Promise(resolve => setImmediate(resolve));
    await waitForPathMissing(
      presentationCachePaths(project.id).projectDir,
      'presentation finalizer should leave no late delete-all cache'
    );

    assert.equal(fs.existsSync(presentationCachePaths(project.id).projectDir), false);
    assert.equal(await getProject(project.id), undefined);
  } finally {
    releaseRead();
    if (cacheInspection) cacheInspection.restore();
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

test('presentation scan-on-save ignores stale cache metadata outside the current project cache', async () => {
  const tmpRoot = makeTempDir();
  try {
    resetPresentationCacheRoot();
    const project = await createProject('Presentation Stale Cache Metadata');
    const pptxPath = path.join(tmpRoot, 'Deck.pptx');
    const outsidePath = path.join(tmpRoot, 'SHOULD_NOT_APPEAR_STALE_PRESENTATION.jpeg');
    const mediaBytes = 'STALE_OUTSIDE_PRESENTATION_BYTES'.repeat(40);
    fs.writeFileSync(pptxPath, Buffer.from('pptx container bytes'));
    fs.writeFileSync(outsidePath, mediaBytes, { mode: 0o644 });
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
          path: outsidePath,
          name: 'Stale Presentation Cache.jpeg',
          ext: '.jpeg',
          addedAt: Date.now(),
          source: 'scan-on-save-presentation',
        },
      ],
    });
    setPowerPointUnzipFixture([{
      internalPath: 'ppt/media/image1.jpeg',
      data: Buffer.from(mediaBytes),
    }]);

    const captured = await captureConsoleDuring(async () => {
      await emitWatcher('change', pptxPath);
      return waitForProject(
        project.id,
        item => item.files.some(file => file.source === 'scan-on-save-presentation' && file.path !== outsidePath),
        5000
      );
    });
    const extracted = captured.result.files.find(
      file => file.source === 'scan-on-save-presentation' && file.path !== outsidePath
    );
    assert.ok(extracted, 'stale outside-root metadata must not suppress a new safe cache capture');
    assert.equal(fs.readFileSync(extracted.path, 'utf8'), mediaBytes);
    assert.equal(fs.readFileSync(outsidePath, 'utf8'), mediaBytes);
    assert.equal(captured.output.includes(outsidePath), false);
    assert.equal(captured.output.includes('SHOULD_NOT_APPEAR_STALE_PRESENTATION'), false);
    assert.equal(captured.output.includes(mediaBytes), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('presentation scan-on-save ignores a nested cache symlink without reading its target', async () => {
  if (process.platform === 'win32') return;

  const tmpRoot = makeTempDir();
  try {
    resetPresentationCacheRoot();
    const project = await createProject('Presentation Nested Cache Symlink');
    const pptxPath = path.join(tmpRoot, 'Deck.pptx');
    const paths = makePermissivePresentationCacheDirectories(project.id);
    const outsidePath = path.join(tmpRoot, 'SHOULD_NOT_APPEAR_NESTED_SYMLINK.jpeg');
    const symlinkPath = path.join(paths.projectDir, 'Deck — linked.jpeg');
    const mediaBytes = 'NESTED_SYMLINK_PRESENTATION_BYTES'.repeat(40);
    fs.writeFileSync(pptxPath, Buffer.from('pptx container bytes'));
    fs.writeFileSync(outsidePath, mediaBytes, { mode: 0o644 });
    fs.symlinkSync(outsidePath, symlinkPath);
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
          path: symlinkPath,
          name: path.basename(symlinkPath),
          ext: '.jpeg',
          addedAt: Date.now(),
          source: 'scan-on-save-presentation',
        },
      ],
    });
    setPowerPointUnzipFixture([{
      internalPath: 'ppt/media/image1.jpeg',
      data: Buffer.from(mediaBytes),
    }]);

    const captured = await captureConsoleDuring(async () => {
      await emitWatcher('change', pptxPath);
      return waitForProject(
        project.id,
        item => item.files.some(file => file.source === 'scan-on-save-presentation' && file.path !== symlinkPath),
        5000
      );
    });
    const extracted = captured.result.files.find(
      file => file.source === 'scan-on-save-presentation' && file.path !== symlinkPath
    );
    assert.ok(extracted, 'nested symlink target must not suppress a new safe cache capture');
    assert.equal(fs.readFileSync(extracted.path, 'utf8'), mediaBytes);
    assert.equal(fs.readFileSync(outsidePath, 'utf8'), mediaBytes);
    assert.equal(fs.lstatSync(symlinkPath).isSymbolicLink(), true);
    assert.equal(captured.output.includes(outsidePath), false);
    assert.equal(captured.output.includes('SHOULD_NOT_APPEAR_NESTED_SYMLINK'), false);
    assert.equal(captured.output.includes(mediaBytes), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('presentation scan-on-save ignores an intermediate cache directory symlink', async () => {
  if (process.platform === 'win32') return;

  const tmpRoot = makeTempDir();
  try {
    resetPresentationCacheRoot();
    const project = await createProject('Presentation Intermediate Cache Symlink');
    const pptxPath = path.join(tmpRoot, 'Deck.pptx');
    const paths = makePermissivePresentationCacheDirectories(project.id);
    const outsideDir = path.join(tmpRoot, 'outside-cache');
    const outsidePath = path.join(outsideDir, 'SHOULD_NOT_APPEAR_INTERMEDIATE_SYMLINK.jpeg');
    const nestedLink = path.join(paths.projectDir, 'nested-cache');
    const storedPath = path.join(nestedLink, path.basename(outsidePath));
    const mediaBytes = 'INTERMEDIATE_SYMLINK_PRESENTATION_BYTES'.repeat(40);
    fs.writeFileSync(pptxPath, Buffer.from('pptx container bytes'));
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(outsidePath, mediaBytes, { mode: 0o644 });
    fs.chmodSync(outsidePath, 0o644);
    fs.symlinkSync(outsideDir, nestedLink);
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
          path: storedPath,
          name: path.basename(storedPath),
          ext: '.jpeg',
          addedAt: Date.now(),
          source: 'scan-on-save-presentation',
        },
      ],
    });
    setPowerPointUnzipFixture([{
      internalPath: 'ppt/media/image1.jpeg',
      data: Buffer.from(mediaBytes),
    }]);

    const captured = await captureConsoleDuring(async () => {
      await emitWatcher('change', pptxPath);
      return waitForProject(
        project.id,
        item => item.files.some(file => file.source === 'scan-on-save-presentation' && file.path !== storedPath),
        5000
      );
    });
    const extracted = captured.result.files.find(
      file => file.source === 'scan-on-save-presentation' && file.path !== storedPath
    );
    assert.ok(extracted, 'intermediate symlink target must not suppress a new safe cache capture');
    assert.equal(fs.readFileSync(extracted.path, 'utf8'), mediaBytes);
    assert.equal(fs.readFileSync(outsidePath, 'utf8'), mediaBytes);
    assert.equal(fs.statSync(outsidePath).mode & 0o777, 0o644);
    assert.equal(fs.lstatSync(nestedLink).isSymbolicLink(), true);
    assert.equal(captured.output.includes(outsidePath), false);
    assert.equal(captured.output.includes('SHOULD_NOT_APPEAR_INTERMEDIATE_SYMLINK'), false);
    assert.equal(captured.output.includes(mediaBytes), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('presentation cache read rejects a project-directory swap before touching the outside file', async () => {
  if (process.platform === 'win32') return;

  const tmpRoot = makeTempDir();
  const originalOpenSync = fs.openSync;
  try {
    resetPresentationCacheRoot();
    const project = await createProject('Presentation Cache Read Directory Swap');
    const pptxPath = path.join(tmpRoot, 'Deck.pptx');
    const paths = makePermissivePresentationCacheDirectories(project.id);
    const parkedProjectDir = `${paths.projectDir}.parked`;
    const outsideDir = path.join(tmpRoot, 'outside-read-cache');
    const storedName = 'Deck — swapped.jpeg';
    const storedPath = path.join(paths.projectDir, storedName);
    const outsidePath = path.join(outsideDir, storedName);
    const mediaBytes = 'DIRECTORY_SWAP_READ_PRESENTATION_BYTES'.repeat(40);
    fs.writeFileSync(pptxPath, Buffer.from('pptx container bytes'));
    fs.writeFileSync(storedPath, Buffer.from('inside stale cache bytes'), { mode: 0o600 });
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(outsidePath, mediaBytes, { mode: 0o644 });
    fs.chmodSync(outsidePath, 0o644);
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
          path: storedPath,
          name: storedName,
          ext: '.jpeg',
          addedAt: Date.now(),
          source: 'scan-on-save-presentation',
        },
      ],
    });
    setPowerPointUnzipFixture([{
      internalPath: 'ppt/media/image1.jpeg',
      data: Buffer.from(mediaBytes),
    }]);

    let swapped = false;
    fs.openSync = (targetPath, flags, ...args) => {
      if (!swapped && targetPath === storedPath) {
        swapped = true;
        fs.renameSync(paths.projectDir, parkedProjectDir);
        fs.symlinkSync(outsideDir, paths.projectDir);
        const fd = originalOpenSync.call(fs, targetPath, flags, ...args);
        fs.unlinkSync(paths.projectDir);
        fs.renameSync(parkedProjectDir, paths.projectDir);
        return fd;
      }
      return originalOpenSync.call(fs, targetPath, flags, ...args);
    };

    const captured = await captureConsoleDuring(async () => {
      await emitWatcher('change', pptxPath);
      return waitForProject(
        project.id,
        item => item.files.some(file => file.source === 'scan-on-save-presentation' && file.path !== storedPath),
        5000
      );
    });
    const extracted = captured.result.files.find(
      file => file.source === 'scan-on-save-presentation' && file.path !== storedPath
    );
    assert.ok(swapped, 'test must replace the cache directory during the file open');
    assert.ok(extracted, 'directory swap must not suppress a fresh safe cache capture');
    assert.equal(fs.readFileSync(extracted.path, 'utf8'), mediaBytes);
    assert.equal(fs.readFileSync(outsidePath, 'utf8'), mediaBytes);
    assert.equal(fs.statSync(outsidePath).mode & 0o777, 0o644);
    assert.equal(captured.output.includes(outsidePath), false);
    assert.equal(captured.output.includes(mediaBytes), false);
  } finally {
    fs.openSync = originalOpenSync;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('presentation cache write rejects a project-directory swap before writing outside bytes', async () => {
  if (process.platform === 'win32') return;

  const tmpRoot = makeTempDir();
  const originalOpenSync = fs.openSync;
  let paths = null;
  let parkedProjectDir = null;
  try {
    resetPresentationCacheRoot();
    const project = await createProject('Presentation Cache Write Directory Swap');
    const pptxPath = path.join(tmpRoot, 'Deck.pptx');
    paths = makePermissivePresentationCacheDirectories(project.id);
    parkedProjectDir = `${paths.projectDir}.parked`;
    const outsideDir = path.join(tmpRoot, 'outside-write-cache');
    const expectedDestPath = path.join(paths.projectDir, 'Deck — image1.jpeg');
    const mediaBytes = 'DIRECTORY_SWAP_WRITE_PRESENTATION_BYTES'.repeat(40);
    fs.writeFileSync(pptxPath, Buffer.from('pptx container bytes'));
    fs.mkdirSync(outsideDir);
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

    let swapped = false;
    fs.openSync = (targetPath, flags, ...args) => {
      if (!swapped && targetPath === expectedDestPath && (flags & fs.constants.O_CREAT) !== 0) {
        swapped = true;
        fs.renameSync(paths.projectDir, parkedProjectDir);
        fs.symlinkSync(outsideDir, paths.projectDir);
      }
      return originalOpenSync.call(fs, targetPath, flags, ...args);
    };

    const captured = await captureConsoleDuring(async () => {
      await emitWatcher('change', pptxPath);
      await new Promise(resolve => originalSetTimeout(resolve, 2600));
      return getProject(project.id);
    });
    assert.ok(swapped, 'test must replace the cache directory during the file create');
    assert.equal(captured.result.files.some(file => file.source === 'scan-on-save-presentation'), false);
    assert.deepEqual(fs.readdirSync(outsideDir), []);
    assert.equal(captured.output.includes(outsideDir), false);
    assert.equal(captured.output.includes(mediaBytes), false);
  } finally {
    fs.openSync = originalOpenSync;
    if (paths && fs.existsSync(paths.projectDir)) {
      const stat = fs.lstatSync(paths.projectDir);
      if (stat.isSymbolicLink()) fs.unlinkSync(paths.projectDir);
    }
    if (parkedProjectDir && fs.existsSync(parkedProjectDir) && paths) {
      fs.renameSync(parkedProjectDir, paths.projectDir);
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('presentation cache write failure leaves no unsecured media bytes or project entry', async () => {
  if (process.platform === 'win32') return;

  const tmpRoot = makeTempDir();
  const originalFchmod = fs.fchmodSync;
  let filePermissionFailures = 0;
  try {
    resetPresentationCacheRoot();
    const project = await createProject('Presentation Cache Permission Failure');
    const pptxPath = path.join(tmpRoot, 'Deck.pptx');
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
      data: Buffer.from('UNSECURED_PRESENTATION_BYTES'.repeat(40)),
    }]);
    fs.fchmodSync = (fd, mode) => {
      if (fs.fstatSync(fd).isFile() && mode === 0o600) {
        filePermissionFailures += 1;
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      }
      return originalFchmod.call(fs, fd, mode);
    };

    const captured = await captureConsoleDuring(async () => {
      await emitWatcher('change', pptxPath);
      const deadline = Date.now() + 5000;
      while (filePermissionFailures === 0 && Date.now() < deadline) {
        await new Promise(resolve => originalSetTimeout(resolve, 10));
      }
      assert.ok(filePermissionFailures > 0, 'presentation write should reach the file permission check');
      await new Promise(resolve => setImmediate(resolve));
      return getProject(project.id);
    });
    const cacheDir = presentationCachePaths(project.id).projectDir;
    assert.equal(captured.result.files.some(file => file.source === 'scan-on-save-presentation'), false);
    assert.deepEqual(fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : [], [], 'failed write must remove unsecured bytes');
    assert.equal(captured.output.includes(TEST_HOME), false);
    assert.equal(captured.output.includes('UNSECURED_PRESENTATION_BYTES'), false);
  } finally {
    fs.fchmodSync = originalFchmod;
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
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.scope, 'minimized_package_relevant');
    assert.equal(manifest.package.copiedCount, 1);
    assert.equal(manifest.package.embeddedCount, 2);
    assert.equal(manifest.package.totalFiles, 1);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 1);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE).length, 2);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 2);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE).length, 2);
    const manifestText = JSON.stringify(manifest);
    assert.equal(manifestText.includes('ppt/media/image1.jpeg'), false);
    assert.equal(manifestText.includes('Deck — image1.jpeg'), false);
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

    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION);
    storeInstance.set('usage.packagesThisMonth', 2);
    const result = await callIpc('v2:package-file', deckPath);
    assert.equal(result.success, true);
    assert.equal(result.assetsFound, 1);
    assert.equal(result.assetsCopied, 1);
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 3);
    assert.equal(fs.existsSync(path.join(quickPackageFolder(deckPath), 'Quick Quota Deck.pptx')), true);
    assert.equal(fs.existsSync(path.join(quickPackageFolder(deckPath), 'PPTX')), false);
    assert.equal(fs.existsSync(path.join(quickPackageFolder(deckPath), 'JPEG')), false);
    assert.equal(fs.existsSync(path.join(quickPackageFolder(deckPath), 'Crate Diagnostics', 'crate-provenance.json')), false);
    assert.equal(fs.existsSync(path.join(quickPackageFolder(deckPath), 'crate-provenance.json')), false);

    const missingPath = path.join(tmpRoot, 'Missing Quick Quota Deck.pptx');
    const failedResult = await callIpc('v2:package-file', missingPath);
    assert.equal(failedResult.success, undefined);
    assert.match(failedResult.error, /Master file not found/);
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 3);
    assert.equal(fs.existsSync(quickPackageFolder(missingPath)), false);

    const continuedPath = path.join(tmpRoot, 'Continued Beta Quick Quota Deck.pptx');
    fs.writeFileSync(continuedPath, Buffer.from('continued beta quick package pptx bytes'));
    storeInstance.set('usage.packagesThisMonth', 10);
    const continuedResult = await callIpc('v2:package-file', continuedPath);
    assert.equal(continuedResult.success, true);
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 11);
    assert.equal(fs.existsSync(quickPackageFolder(continuedPath)), true);

    const limitPath = path.join(tmpRoot, 'Limit Quick Quota Deck.pptx');
    fs.writeFileSync(limitPath, Buffer.from('limit quick package pptx bytes'));
    storeInstance.set('usage.packagesThisMonth', 25);
    const limitResult = await callIpc('v2:package-file', limitPath);
    assert.equal(limitResult.error, 'limit_reached');
    assert.equal(limitResult.packageLimit, 25);
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 25);
    assert.equal(fs.existsSync(quickPackageFolder(limitPath)), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(path.join(TEST_HOME, 'Desktop', 'Quick Quota Deck_' + new Date().toISOString().split('T')[0]), { recursive: true, force: true });
    fs.rmSync(path.join(TEST_HOME, 'Desktop', 'Continued Beta Quick Quota Deck_' + new Date().toISOString().split('T')[0]), { recursive: true, force: true });
    fs.rmSync(path.join(TEST_HOME, 'Desktop', 'Limit Quick Quota Deck_' + new Date().toISOString().split('T')[0]), { recursive: true, force: true });
  }
});

test('concurrent Quick Package requests share one main-process package lock', async () => {
  const tmpRoot = makeTempDir();
  const firstPath = path.join(tmpRoot, 'First Concurrent Quick Package.pptx');
  const secondPath = path.join(tmpRoot, 'Second Concurrent Quick Package.pptx');
  fs.writeFileSync(firstPath, Buffer.from('first concurrent quick package bytes'));
  fs.writeFileSync(secondPath, Buffer.from('second concurrent quick package bytes'));

  try {
    storeInstance.set('usage.packagesThisMonth', 24);
    const firstPackage = callIpc('v2:package-file', firstPath);
    const blockedPackage = await callIpc('v2:package-file', secondPath);
    const firstResult = await firstPackage;

    assert.equal(firstResult.success, true);
    assert.equal(blockedPackage.error, 'package_in_flight');
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 25);
    assert.equal(fs.existsSync(quickPackageFolder(firstPath)), true);
    assert.equal(fs.existsSync(quickPackageFolder(secondPath)), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(quickPackageFolder(firstPath), { recursive: true, force: true });
    fs.rmSync(quickPackageFolder(secondPath), { recursive: true, force: true });
  }
});

test('normal and Quick Package share the same main-process package lock', async () => {
  const tmpRoot = makeTempDir();
  const quickPath = path.join(tmpRoot, 'Cross Flow Quick Package.pptx');
  const outputDir = path.join(tmpRoot, 'normal-output');
  fs.writeFileSync(quickPath, Buffer.from('cross-flow quick package bytes'));
  fs.mkdirSync(outputDir);

  try {
    const project = await createProject('Cross Flow Normal Package');
    const sourcePath = path.join(tmpRoot, 'Cross Flow Logo.ai');
    fs.writeFileSync(sourcePath, Buffer.from('cross-flow normal package bytes'));
    await setProjectFiles(project.id, {
      files: [{
        path: sourcePath,
        name: 'Cross Flow Logo.ai',
        ext: '.ai',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });

    storeInstance.set('usage.packagesThisMonth', 24);
    const quickPackage = callIpc('v2:package-file', quickPath);
    const blockedNormalPackage = await callIpc('projects:package', project.id, outputDir);
    const quickResult = await quickPackage;

    assert.equal(quickResult.success, true);
    assert.equal(blockedNormalPackage.error, 'package_in_flight');
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 25);
    assert.equal(fs.existsSync(quickPackageFolder(quickPath)), true);
    assert.deepEqual(fs.readdirSync(outputDir), []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(quickPackageFolder(quickPath), { recursive: true, force: true });
  }
});

test('successful packaging increments the active month after reset rollover', async () => {
  const tmpRoot = makeTempDir();
  const RealDate = global.Date;
  let currentTime = new RealDate(2026, 5, 30, 23, 59, 0).getTime();
  class MutableDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(currentTime);
      } else {
        super(...args);
      }
    }
    static now() { return currentTime; }
    static parse(value) { return RealDate.parse(value); }
    static UTC(...args) { return RealDate.UTC(...args); }
  }

  const deckPath = path.join(tmpRoot, 'Month Rollover Quick Package.pptx');
  fs.writeFileSync(deckPath, Buffer.from('month rollover quick package bytes'));

  try {
    global.Date = MutableDate;
    storeInstance.set('usage', {
      packagesThisMonth: 2,
      resetDate: '2026-07-01',
    });

    const packagePromise = callIpc('v2:package-file', deckPath);
    currentTime = new RealDate(2026, 6, 1, 0, 1, 0).getTime();
    const result = await packagePromise;

    assert.equal(result.success, true);
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 1);
    assert.equal(storeInstance.get('usage.resetDate'), '2026-08-01');
  } finally {
    global.Date = RealDate;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(
      path.join(TEST_HOME, 'Desktop', 'Month Rollover Quick Package_2026-06-30'),
      { recursive: true, force: true }
    );
  }
});

test('closed beta quota is 25 without mutating persisted usage state', async () => {
  testAppVersion = '3.0.0-beta.2';
  storeInstance.set('usage', {
    packagesThisMonth: 10,
    resetDate: '2099-01-01',
  });

  const usage = await callIpc('usage:get');

  assert.deepEqual(usage, {
    packagesThisMonth: 10,
    resetDate: '2099-01-01',
    packageLimit: 25,
    planId: 'closed-beta',
    planName: 'Closed beta',
  });
  assert.deepEqual(storeInstance.get('usage'), {
    packagesThisMonth: 10,
    resetDate: '2099-01-01',
  });
});

test('stable and internal QA builds retain the 10 package baseline', async () => {
  const tmpRoot = makeTempDir();
  try {
    storeInstance.set('usage', {
      packagesThisMonth: 10,
      resetDate: '2099-01-01',
    });

    for (const version of ['3.0.0', '3.0.0-qa.1']) {
      testAppVersion = version;
      const usage = await callIpc('usage:get');
      assert.equal(usage.packageLimit, 10);
      assert.equal(usage.planId, 'free');
      assert.equal(usage.planName, 'Free');

      const deckPath = path.join(tmpRoot, `Limit ${version}.pptx`);
      fs.writeFileSync(deckPath, Buffer.from(`limit ${version} bytes`));
      const result = await callIpc('v2:package-file', deckPath);
      assert.equal(result.error, 'limit_reached');
      assert.equal(result.packageLimit, 10);
      assert.equal(storeInstance.get('usage.packagesThisMonth'), 10);
      assert.equal(fs.existsSync(quickPackageFolder(deckPath)), false);
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
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

    storeInstance.set('usage.packagesThisMonth', 24);
    const result = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 25);

    const blockedOutputDir = path.join(tmpRoot, 'blocked-out');
    fs.mkdirSync(blockedOutputDir);
    const blockedResult = await callIpc('projects:package', project.id, blockedOutputDir);
    assert.equal(blockedResult.error, 'limit_reached');
    assert.equal(blockedResult.packageLimit, 25);
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 25);
    assert.deepEqual(fs.readdirSync(blockedOutputDir), []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('unchanged reviewed manifest packages exactly the reviewed files', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Reviewed Manifest Unchanged');
    const sourcePath = path.join(tmpRoot, 'Review_Project.ai');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, 'reviewed source bytes');
    await setProjectFiles(project.id, {
      files: [{
        path: sourcePath,
        name: 'Review_Project.ai',
        ext: '.ai',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });

    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.deepEqual(
      review.files.map(({ visualIdentity, visualRevision, ...file }) => file),
      [{
        name: 'Review_Project.ai',
        ext: '.ai',
        embedded: false,
        linked: false,
        appFamily: 'illustrator',
        sourceName: null,
        assetOrigin: 'added',
        projectRole: 'source',
        protectedSource: true,
        sourceRecoveryAllowed: false,
        excluded: false,
        status: 'ready',
        packageFolder: 'Package root',
      }]
    );
    assert.match(review.files[0].visualIdentity, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(JSON.stringify(review).includes(tmpRoot), false);

    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.totalFiles, 1);
    assertOwnerOnlyMode(result.folderPath, 0o700);
    assertOwnerOnlyMode(path.join(result.folderPath, 'Review_Project.ai'), 0o600);
    assert.equal(
      fs.readFileSync(path.join(packageFolder(outputDir, project.name), 'Review_Project.ai'), 'utf8'),
      'reviewed source bytes'
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('unmaterializable reviews expose safe status without tokens and recover after sources return', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Unavailable Package Review');
    const sourcePath = path.join(tmpRoot, 'Missing.ai');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    await setProjectFiles(project.id, { files: [{
      path: sourcePath, name: 'Missing.ai', ext: '.ai', addedAt: Date.now(), source: 'manual-browse',
    }] });

    const initiallyMissing = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.deepEqual(
      initiallyMissing.files.map(({ visualIdentity, visualRevision, ...file }) => file),
      [{
        name: 'Missing.ai',
        ext: '.ai',
        embedded: false,
        linked: false,
        appFamily: 'illustrator',
        sourceName: null,
        assetOrigin: 'added',
        projectRole: 'source',
        protectedSource: true,
        sourceRecoveryAllowed: false,
        excluded: false,
        status: 'missing',
      }]
    );
    assert.match(initiallyMissing.files[0].visualIdentity, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(initiallyMissing.materializable, false);
    assert.equal(initiallyMissing.token, undefined);
    assert.equal(JSON.stringify(initiallyMissing).includes(tmpRoot), false);

    fs.writeFileSync(sourcePath, 'recovered source');
    const recovered = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(recovered.materializable, true);
    assert.equal(typeof recovered.token, 'string');

    fs.unlinkSync(sourcePath);
    const disappeared = await callIpcRaw('projects:package', project.id, outputDir, recovered.token);
    assert.equal(disappeared.error, 'package_review_changed');
    assert.equal(disappeared.review.materializable, false);
    assert.equal(disappeared.review.token, undefined);
    assert.deepEqual(
      disappeared.review.files.map(({ visualIdentity, visualRevision, ...file }) => file),
      [{
        name: 'Missing.ai',
        ext: '.ai',
        embedded: false,
        linked: false,
        appFamily: 'illustrator',
        sourceName: null,
        assetOrigin: 'added',
        projectRole: 'source',
        protectedSource: true,
        sourceRecoveryAllowed: false,
        excluded: false,
        status: 'missing',
      }]
    );
    assert.match(disappeared.review.files[0].visualIdentity, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await callIpcRaw('projects:package', project.id, outputDir, disappeared.review.token)).error, 'package_review_required');
    assert.deepEqual(fs.readdirSync(outputDir), []);
    const stillMissing = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(stillMissing.materializable, false);
    assert.equal(stillMissing.token, undefined);

    fs.writeFileSync(sourcePath, 'recovered again');
    const fresh = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(fresh.materializable, true);
    assert.equal(typeof fresh.token, 'string');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('unsupported virtual entries are reviewable by safe name but cannot issue a token', async () => {
  const project = await createProject('Unsupported Virtual Review');
  await setProjectFiles(project.id, { files: [{
    name: 'Virtual.ai', ext: '.ai', addedAt: Date.now(), source: 'manual-browse',
  }] });

  const review = await callIpcRaw('projects:prepare-package-review', project.id);
  assert.deepEqual(review.files, [{
    name: 'Virtual.ai',
    ext: '.ai',
    embedded: false,
    linked: false,
    appFamily: 'illustrator',
    sourceName: null,
    assetOrigin: 'added',
    projectRole: 'source',
    protectedSource: true,
    sourceRecoveryAllowed: false,
    excluded: false,
    visualIdentity: null,
    visualRevision: null,
    status: 'unmaterializable',
  }]);
  assert.equal(review.materializable, false);
  assert.equal(review.token, undefined);
  await callIpcRaw('projects:delete', project.id);
});

test('authoritative plan binds reviewed sources, PSD and presentation derivatives, diagnostics, and collisions', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Authoritative Package Plan');
    const sourcePath = path.join(tmpRoot, 'reviewed-source.png');
    const deckPath = path.join(tmpRoot, 'Deck.pptx');
    const parentPsd = path.join(tmpRoot, 'Parent.psd');
    const unrelatedPath = path.join(tmpRoot, 'Unrelated.ai');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, Buffer.from('reviewed source bytes'));
    fs.writeFileSync(deckPath, Buffer.from('presentation container bytes'));
    fs.writeFileSync(parentPsd, Buffer.from('PSD container bytes'));
    fs.writeFileSync(unrelatedPath, Buffer.from('unrelated bytes'));
    currentPsdFixture = { children: [], linkedFiles: [{ name: 'Embedded.png', data: Buffer.from('PSD derived bytes') }] };
    setPowerPointUnzipFixture([{
      internalPath: 'ppt/media/image1.png',
      data: Buffer.from('PRESENTATION_DERIVED_BYTES'.repeat(40)),
    }]);
    await setProjectFiles(project.id, { files: [
      { path: sourcePath, name: 'Deck — image1.png', ext: '.png', addedAt: Date.now(), source: 'manual-browse' },
      { path: deckPath, name: 'Deck.pptx', ext: '.pptx', addedAt: Date.now(), source: 'manual-browse' },
      {
        path: parentPsd, parentPsd, name: 'Deck — image1.png', ext: '.png', source: 'scan-on-save-embedded',
        embedded: true, embeddedOriginalName: 'Embedded.png', embeddedIndex: 0, fileId: 'plan-psd-resource',
      },
    ] });

    await callIpc('settings:update', 'includeDiagnosticReport', false);
    const firstReview = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.deepEqual(firstReview.planSummary, {
      reviewedSourceInputCount: 2,
      visibleDerivedDesignCount: 1,
      derivedDesignGeneratorCount: 1,
      diagnosticsMetadataIncluded: false,
      outputLayoutMode: PACKAGE_OUTPUT_LAYOUT_MODES.FLAT,
    });
    assert.deepEqual(firstReview.files.map(file => file.packageFolder), [
      'Package root', 'Package root', 'Package root',
    ]);
    assert.equal(JSON.stringify(firstReview).includes(tmpRoot), false);
    assert.equal(JSON.stringify(firstReview).includes('Unrelated.ai'), false);

    await callIpc('settings:update', 'includeDiagnosticReport', true);
    const changed = await callIpcRaw('projects:package', project.id, outputDir, firstReview.token);
    assert.equal(changed.error, 'package_review_changed');
    assert.equal(changed.review.planSummary.diagnosticsMetadataIncluded, true);
    assert.deepEqual(fs.readdirSync(outputDir), []);

    const result = await callIpcRaw('projects:package', project.id, outputDir, changed.review.token);
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 3);
    assert.equal(result.embeddedCount, 1);
    assert.deepEqual(fs.readdirSync(result.folderPath).sort(), [
      'Crate Diagnostics', 'Deck — image1.png', 'Deck — image1_1.png', 'Deck — image1_2.png', 'Deck.pptx',
    ]);
    assertOwnerOnlyMode(result.folderPath, 0o700);
    assertOwnerOnlyMode(path.join(result.folderPath, 'Crate Diagnostics'), 0o700);
    assertOwnerOnlyMode(path.join(result.folderPath, 'Crate Diagnostics', 'crate-provenance.json'), 0o600);
    assert.equal(fs.readFileSync(path.join(result.folderPath, 'Deck — image1.png'), 'utf8'), 'reviewed source bytes');
    assert.equal(fs.readFileSync(path.join(result.folderPath, 'Deck — image1_1.png'), 'utf8'), 'PSD derived bytes');
    assert.equal(fs.readFileSync(path.join(result.folderPath, 'Deck — image1_2.png'), 'utf8'), 'PRESENTATION_DERIVED_BYTES'.repeat(40));
    assert.equal(fs.existsSync(path.join(result.folderPath, 'Unrelated.ai')), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('organized authoritative plan materializes every reviewed output at its bound extension path', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Organized Authoritative Plan');
    const sourcePath = path.join(tmpRoot, 'Brand-System.ai');
    const deckPath = path.join(tmpRoot, 'Launch-Deck.pptx');
    const pngPath = path.join(tmpRoot, 'source.png');
    const parentPsd = path.join(tmpRoot, 'Parent.psd');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, Buffer.from('organized source bytes'));
    fs.writeFileSync(deckPath, Buffer.from('organized presentation bytes'));
    fs.writeFileSync(pngPath, Buffer.from('organized reserved-name bytes'));
    fs.writeFileSync(parentPsd, Buffer.from('organized PSD bytes'));
    currentPsdFixture = {
      children: [],
      linkedFiles: [{ name: '_aux.png', data: Buffer.from('organized PSD resource bytes') }],
    };
    setPowerPointUnzipFixture([{
      internalPath: 'ppt/media/image1.jpg',
      data: Buffer.from('ORGANIZED_PRESENTATION_MEDIA'.repeat(40)),
    }]);
    await setProjectFiles(project.id, { files: [
      { path: sourcePath, name: 'Brand-System.ai', ext: '.ai', addedAt: Date.now(), source: 'manual-browse' },
      { path: deckPath, name: 'Launch-Deck.pptx', ext: '.pptx', addedAt: Date.now(), source: 'manual-browse' },
      { path: pngPath, name: 'aux.png', ext: '.png', addedAt: Date.now(), source: 'manual-browse' },
      {
        path: parentPsd,
        parentPsd,
        name: '_aux.png',
        ext: '.png',
        source: 'scan-on-save-embedded',
        embedded: true,
        embeddedOriginalName: '_aux.png',
        embeddedIndex: 0,
        fileId: 'organized-psd-resource',
      },
    ] });
    storeInstance.set('settings.includeDiagnosticReport', true);
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION);

    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(review.planSummary.outputLayoutMode, PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION);
    assert.deepEqual(
      review.files.map(file => [file.name, file.packageFolder]),
      [
        ['Brand-System.ai', 'AI'],
        ['Launch-Deck.pptx', 'PPTX'],
        ['aux.png', 'PNG'],
        ['_aux.png', 'PNG'],
      ]
    );
    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);

    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 4);
    assert.equal(result.embeddedCount, 1);
    assert.deepEqual(fs.readdirSync(result.folderPath).sort(), [
      'AI', 'Crate Diagnostics', 'JPG', 'PNG', 'PPTX',
    ]);
    assert.deepEqual(fs.readdirSync(path.join(result.folderPath, 'AI')), ['Brand-System.ai']);
    assert.deepEqual(fs.readdirSync(path.join(result.folderPath, 'PPTX')), ['Launch-Deck.pptx']);
    assert.deepEqual(fs.readdirSync(path.join(result.folderPath, 'PNG')).sort(), ['_aux.png', '_aux_1.png']);
    assert.deepEqual(fs.readdirSync(path.join(result.folderPath, 'JPG')), ['Launch-Deck — image1.jpg']);
    assert.equal(fs.readFileSync(path.join(result.folderPath, 'AI', 'Brand-System.ai'), 'utf8'), 'organized source bytes');
    assert.equal(fs.readFileSync(path.join(result.folderPath, 'PNG', '_aux.png'), 'utf8'), 'organized reserved-name bytes');
    assert.equal(fs.readFileSync(path.join(result.folderPath, 'PNG', '_aux_1.png'), 'utf8'), 'organized PSD resource bytes');
    assert.equal(
      fs.readFileSync(path.join(result.folderPath, 'JPG', 'Launch-Deck — image1.jpg'), 'utf8'),
      'ORGANIZED_PRESENTATION_MEDIA'.repeat(40)
    );
    assert.equal(
      fs.existsSync(path.join(result.folderPath, 'Crate Diagnostics', 'crate-provenance.json')),
      true
    );
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 1);

    const fresh = await getProject(project.id);
    const outputPaths = [
      ...getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_INCLUDES_FILE),
      ...getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE),
    ].map(edge => edge.payload.outputPath);
    assert.equal(outputPaths.some(outputPath => outputPath.endsWith(path.join('AI', 'Brand-System.ai'))), true);
    assert.equal(outputPaths.some(outputPath => outputPath.endsWith(path.join('PNG', '_aux.png'))), true);
    assert.equal(outputPaths.some(outputPath => outputPath.endsWith(path.join('PNG', '_aux_1.png'))), true);
    assert.equal(outputPaths.some(outputPath => outputPath.endsWith(path.join('JPG', 'Launch-Deck — image1.jpg'))), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('organized authoritative plan reallocates collisions introduced by portable leaf rewriting', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Organized Portable Collisions');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    const fixtures = [
      ['aux.png', 'reserved device bytes'],
      ['_aux.png', 'literal underscore bytes'],
      ['name.', 'trailing dot bytes'],
      ['name_', 'literal underscore name bytes'],
    ].map(([name, bytes]) => {
      const sourcePath = path.join(tmpRoot, name);
      fs.writeFileSync(sourcePath, bytes);
      return { path: sourcePath, name, ext: path.extname(name).toLowerCase(), addedAt: Date.now(), source: 'manual-browse' };
    });
    await setProjectFiles(project.id, { files: fixtures });
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION);

    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);

    assert.equal(result.success, true);
    assert.deepEqual(fs.readdirSync(path.join(result.folderPath, 'PNG')).sort(), ['_aux.png', '_aux_1.png']);
    assert.deepEqual(fs.readdirSync(path.join(result.folderPath, 'OTHER')).sort(), ['name_', 'name__1']);
    assert.equal(fs.readFileSync(path.join(result.folderPath, 'PNG', '_aux.png'), 'utf8'), 'reserved device bytes');
    assert.equal(fs.readFileSync(path.join(result.folderPath, 'PNG', '_aux_1.png'), 'utf8'), 'literal underscore bytes');
    assert.equal(fs.readFileSync(path.join(result.folderPath, 'OTHER', 'name_'), 'utf8'), 'trailing dot bytes');
    assert.equal(fs.readFileSync(path.join(result.folderPath, 'OTHER', 'name__1'), 'utf8'), 'literal underscore name bytes');
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 1);

    const fresh = await getProject(project.id);
    const outputPaths = getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_INCLUDES_FILE)
      .map(edge => edge.payload.outputPath);
    assert.equal(new Set(outputPaths.map(outputPath => outputPath.normalize('NFC').toLowerCase())).size, 4);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('organized descriptor writer keeps shell metacharacter filenames out of direct and descendant process arguments', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Organized Writer Quoting');
    const sourceName = "client'$(touch crate-writer-injected).png";
    const sourcePath = path.join(tmpRoot, sourceName);
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, 'quoted filename bytes');
    await setProjectFiles(project.id, { files: [{
      path: sourcePath,
      name: sourceName,
      ext: '.png',
      addedAt: Date.now(),
      source: 'manual-browse',
    }] });
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION);
    let writerObserved = false;
    setUtilityProcessHandler(({ phase, modulePath, args, options, message }) => {
      if (phase !== 'message' || message.type !== 'write-start') return;
      writerObserved = true;
      assert.equal(args.join(' ').includes(sourceName), false);
      assert.equal(modulePath.includes(sourceName), false);
      assert.equal(options.cwd.includes(sourceName), false);
      assert.deepEqual(options.env, {});
      assert.deepEqual(options.execArgv, []);
      assert.equal(options.allowLoadingUnsignedLibraries, false);
      assert.equal(options.disclaim, false);
    });

    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);

    assert.equal(result.success, true);
    assert.equal(writerObserved, true);
    assert.deepEqual(fs.readdirSync(path.join(result.folderPath, 'PNG')), [sourceName]);
    assert.equal(fs.readFileSync(path.join(result.folderPath, 'PNG', sourceName), 'utf8'), 'quoted filename bytes');
    assert.equal(fs.existsSync(path.join(result.folderPath, 'PNG', 'crate-writer-injected')), false);
    assert.equal(fs.statSync(path.join(result.folderPath, 'PNG', sourceName)).mode & 0o777, 0o600);
  } finally {
    setUtilityProcessHandler(null);
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.FLAT);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('organized high-count same-extension packaging uses one incremental utility session', async () => {
  const tmpRoot = makeTempDir();
  const fileCount = 512;
  try {
    const project = await createProject('Organized Bounded Utility Work');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    const files = Array.from({ length: fileCount }, (_, index) => {
      const name = `Reviewed-${`${index}`.padStart(4, '0')}.ai`;
      const sourcePath = path.join(tmpRoot, name);
      fs.writeFileSync(sourcePath, `private-${index}`);
      return {
        path: sourcePath,
        name,
        ext: '.ai',
        addedAt: Date.now(),
        source: 'manual-browse',
      };
    });
    await setProjectFiles(project.id, { files });
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION);
    let forkCount = 0;
    let initCount = 0;
    let writeCount = 0;
    let ownershipAckCount = 0;
    setUtilityProcessHandler(({ phase, message }) => {
      if (phase === 'fork') forkCount++;
      if (phase !== 'message') return;
      if (message.type === 'init-session') {
        initCount++;
        assert.deepEqual(message.ownedOutputs, []);
      }
      if (message.type === 'write-start') writeCount++;
      if (message.type === 'ownership-ack') ownershipAckCount++;
    });

    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);

    assert.equal(result.success, true);
    assert.equal(forkCount, 1);
    assert.equal(initCount, 1);
    assert.equal(writeCount, fileCount);
    assert.equal(ownershipAckCount, fileCount);
    assert.equal(fs.readdirSync(path.join(result.folderPath, 'AI')).length, fileCount);
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 1);
  } finally {
    setUtilityProcessHandler(null);
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.FLAT);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('organized utility process failures settle before spawn and across stalled protocol phases', async () => {
  const scenarios = [
    {
      label: 'no spawn',
      configure(child) { child.autoSpawn = false; },
    },
    {
      label: 'pre-spawn error',
      configure(child) {
        child.autoSpawn = false;
        queueMicrotask(() => child.emit('error', new Error('forced pre-spawn error')));
      },
    },
    {
      label: 'pre-spawn exit',
      configure(child) {
        child.autoSpawn = false;
        queueMicrotask(() => child.emit('exit', 1));
      },
    },
    {
      label: 'stalled acknowledgement',
      configure(child) { child.suppressedMessages.add('chunk'); },
    },
    {
      label: 'stalled completion',
      configure(child) { child.suppressedMessages.add('end'); },
    },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    const tmpRoot = makeTempDir();
    try {
      const project = await createProject(`Organized Utility ${scenario.label}`);
      const sourcePath = path.join(tmpRoot, `Reviewed-${index}.ai`);
      const outputDir = path.join(tmpRoot, 'out');
      fs.mkdirSync(outputDir);
      fs.writeFileSync(sourcePath, `${scenario.label} private bytes`);
      await setProjectFiles(project.id, { files: [{
        path: sourcePath,
        name: path.basename(sourcePath),
        ext: '.ai',
        addedAt: Date.now(),
        source: 'manual-browse',
      }] });
      storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION);
      const review = await callIpcRaw('projects:prepare-package-review', project.id);
      const stored = storeInstance.data.projects.find(item => item.id === project.id);
      const before = capturePackageSideEffects(stored);
      let faultInjected = false;
      setUtilityProcessHandler(({ phase, child }) => {
        if (phase !== 'fork' || faultInjected) return;
        faultInjected = true;
        scenario.configure(child);
      });
      const trackedTimeout = global.setTimeout;
      global.setTimeout = (fn, delay, ...args) => trackedTimeout(
        fn,
        delay === 30_000 ? 0 : delay,
        ...args
      );

      const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);

      assert.equal(faultInjected, true, scenario.label);
      assert.equal(result.error, 'package_output_changed', scenario.label);
      assertFailedPackageHasNoSideEffects(stored, outputDir, before);
    } finally {
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
      setUtilityProcessHandler(null);
      storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.FLAT);
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
});

test('organized cleanup retains exact ownership when a completed response is lost after directory movement', async () => {
  const tmpRoot = makeTempDir();
  const trackedTimeout = global.setTimeout;
  try {
    const project = await createProject('Organized Lost Completion Ownership');
    const outputDir = path.join(tmpRoot, 'out');
    const firstPath = path.join(tmpRoot, 'First.ai');
    const secondPath = path.join(tmpRoot, 'Second.ai');
    const outsideParent = path.join(tmpRoot, 'outside-parent');
    const movedGroup = path.join(outsideParent, 'moved-ai-group');
    fs.mkdirSync(outputDir);
    fs.mkdirSync(outsideParent);
    fs.writeFileSync(firstPath, 'first private source bytes');
    fs.writeFileSync(secondPath, 'second private source bytes');
    await setProjectFiles(project.id, { files: [
      { path: firstPath, name: 'First.ai', ext: '.ai', addedAt: Date.now(), source: 'manual-browse' },
      { path: secondPath, name: 'Second.ai', ext: '.ai', addedAt: Date.now(), source: 'manual-browse' },
    ] });
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION);
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    const before = capturePackageSideEffects(stored);
    let completionSuppressed = false;

    setUtilityProcessHandler(({ phase, message, options, child }) => {
      if (
        phase !== 'response' ||
        completionSuppressed ||
        message.type !== 'complete' ||
        child.outputLeafName !== 'Second.ai'
      ) return;
      const workingPath = child.currentWorkingPath();
      fs.renameSync(workingPath, movedGroup);
      fs.symlinkSync(movedGroup, options.cwd, 'dir');
      fs.writeFileSync(path.join(movedGroup, 'sentinel.txt'), 'unrelated sentinel');
      child.suppressedResponses.add('complete');
      completionSuppressed = true;
    });
    global.setTimeout = (fn, delay, ...args) => trackedTimeout(
      fn,
      delay === 30_000 ? 0 : delay,
      ...args
    );

    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);

    assert.equal(completionSuppressed, true);
    assert.equal(result.error, 'package_cleanup_failed');
    assertFailedPackageHasNoSideEffects(stored, outputDir, before);
    assert.deepEqual(fs.readdirSync(movedGroup), ['sentinel.txt']);
    assert.equal(fs.readFileSync(path.join(movedGroup, 'sentinel.txt'), 'utf8'), 'unrelated sentinel');
  } finally {
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
    setUtilityProcessHandler(null);
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.FLAT);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('organized parent rejects a completed identity that differs from acknowledged ownership', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Organized Completion Identity Mismatch');
    const outputDir = path.join(tmpRoot, 'out');
    const sourcePath = path.join(tmpRoot, 'Reviewed.ai');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, 'reviewed private source bytes');
    await setProjectFiles(project.id, { files: [{
      path: sourcePath,
      name: 'Reviewed.ai',
      ext: '.ai',
      addedAt: Date.now(),
      source: 'manual-browse',
    }] });
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION);
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    const before = capturePackageSideEffects(stored);
    let identityChanged = false;

    setUtilityProcessHandler(({ phase, message, child }) => {
      if (
        phase !== 'response' ||
        identityChanged ||
        message.type !== 'complete' ||
        child.outputLeafName !== 'Reviewed.ai'
      ) return;
      message.outputIdentity.ino = `${BigInt(message.outputIdentity.ino) + 1n}`;
      identityChanged = true;
    });

    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);

    assert.equal(identityChanged, true);
    assert.equal(result.error, 'package_output_changed');
    assertFailedPackageHasNoSideEffects(stored, outputDir, before);
    assert.deepEqual(fs.readdirSync(outputDir), []);
  } finally {
    setUtilityProcessHandler(null);
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.FLAT);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('organized package fails closed when an acknowledged output leaf is renamed before writing', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Organized Renamed Acknowledged Output');
    const outputDir = path.join(tmpRoot, 'out');
    const sourcePath = path.join(tmpRoot, 'Reviewed.ai');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, 'reviewed private source bytes');
    await setProjectFiles(project.id, { files: [{
      path: sourcePath, name: 'Reviewed.ai', ext: '.ai', addedAt: Date.now(), source: 'manual-browse',
    }] });
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION);
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    const before = capturePackageSideEffects(stored);
    let renamed = false;
    let sentinelPath = null;

    setUtilityProcessHandler(({ phase, message, child }) => {
      if (phase !== 'response' || renamed || message.type !== 'ready') return;
      const workingPath = child.currentWorkingPath();
      fs.renameSync(
        path.join(workingPath, 'Reviewed.ai'),
        path.join(workingPath, 'Renamed.ai')
      );
      sentinelPath = path.join(workingPath, 'sentinel.txt');
      fs.writeFileSync(sentinelPath, 'unrelated sentinel');
      renamed = true;
    });

    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);

    assert.equal(renamed, true);
    assert.equal(result.error, 'package_cleanup_failed');
    assertFailedPackageHasNoSideEffects(stored, outputDir, before);
    assert.equal(fs.existsSync(path.join(outputDir, review.folderName)), false);
    assert.ok(sentinelPath);
    assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'unrelated sentinel');
  } finally {
    setUtilityProcessHandler(null);
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.FLAT);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('organized package truncates an outside hard link inserted after the first chunk', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Organized Midstream Hard Link');
    const outputDir = path.join(tmpRoot, 'out');
    const outsideDir = path.join(tmpRoot, 'outside');
    const sourcePath = path.join(tmpRoot, 'Reviewed.ai');
    fs.mkdirSync(outputDir);
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, 'sentinel.txt'), 'unrelated sentinel');
    fs.writeFileSync(sourcePath, Buffer.alloc((1024 * 1024) + 64, 0x52));
    await setProjectFiles(project.id, { files: [{
      path: sourcePath, name: 'Reviewed.ai', ext: '.ai', addedAt: Date.now(), source: 'manual-browse',
    }] });
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION);
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    const before = capturePackageSideEffects(stored);
    const outsideLink = path.join(outsideDir, 'Captured.ai');
    let linked = false;

    setUtilityProcessHandler(({ phase, message, child }) => {
      if (
        phase !== 'response' ||
        linked ||
        message.type !== 'ack' ||
        message.sequence !== 0
      ) return;
      fs.linkSync(path.join(child.currentWorkingPath(), 'Reviewed.ai'), outsideLink);
      linked = true;
    });

    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);

    assert.equal(linked, true);
    assert.equal(result.error, 'package_output_changed');
    assertFailedPackageHasNoSideEffects(stored, outputDir, before);
    assert.equal(fs.readFileSync(outsideLink).length, 0);
    assert.equal(fs.readFileSync(path.join(outsideDir, 'sentinel.txt'), 'utf8'), 'unrelated sentinel');
  } finally {
    setUtilityProcessHandler(null);
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.FLAT);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

for (const movementPhase of ['before second initialization', 'during second chunk']) {
  test(`organized cleanup removes earlier same-extension bytes after movement ${movementPhase}`, async () => {
    const tmpRoot = makeTempDir();
    try {
      const project = await createProject(`Organized Ownership ${movementPhase}`);
      const outputDir = path.join(tmpRoot, 'out');
      const firstPath = path.join(tmpRoot, 'First.ai');
      const secondPath = path.join(tmpRoot, 'Second.ai');
      const outsideParent = path.join(tmpRoot, 'outside-parent');
      const movedGroup = path.join(outsideParent, 'moved-ai-group');
      fs.mkdirSync(outputDir);
      fs.mkdirSync(outsideParent);
      fs.writeFileSync(firstPath, 'first private source bytes');
      fs.writeFileSync(secondPath, 'second private source bytes');
      await setProjectFiles(project.id, { files: [
        { path: firstPath, name: 'First.ai', ext: '.ai', addedAt: Date.now(), source: 'manual-browse' },
        { path: secondPath, name: 'Second.ai', ext: '.ai', addedAt: Date.now(), source: 'manual-browse' },
      ] });
      storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION);
      const review = await callIpcRaw('projects:prepare-package-review', project.id);
      const stored = storeInstance.data.projects.find(item => item.id === project.id);
      const before = capturePackageSideEffects(stored);
      let movementInjected = false;

      setUtilityProcessHandler(({ phase, message, options, child }) => {
        if (phase !== 'message' || movementInjected) return;
        const secondInit = message.type === 'write-start' && message.leafName === 'Second.ai';
        const secondChunk = message.type === 'chunk' && child.outputLeafName === 'Second.ai';
        if (
          (movementPhase === 'before second initialization' && !secondInit) ||
          (movementPhase === 'during second chunk' && !secondChunk)
        ) return;
        if (secondInit) assert.deepEqual(child.ownedOutputs.map(item => item.leafName), ['First.ai']);
        fs.renameSync(options.cwd, movedGroup);
        fs.symlinkSync(movedGroup, options.cwd, 'dir');
        fs.writeFileSync(path.join(movedGroup, 'sentinel.txt'), 'unrelated sentinel');
        movementInjected = true;
      });

      const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);

      assert.equal(movementInjected, true);
      assert.equal(result.error, 'package_cleanup_failed');
      assertFailedPackageHasNoSideEffects(stored, outputDir, before);
      assert.deepEqual(fs.readdirSync(movedGroup), ['sentinel.txt']);
      assert.equal(fs.readFileSync(path.join(movedGroup, 'sentinel.txt'), 'utf8'), 'unrelated sentinel');
    } finally {
      setUtilityProcessHandler(null);
      storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.FLAT);
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
}

test('organized writer rejects an ancestor moved before immutable ancestry validation', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Organized Immutable Ancestry');
    const container = path.join(tmpRoot, 'container');
    const outsideParent = path.join(tmpRoot, 'outside-parent');
    const movedContainer = path.join(outsideParent, 'moved-container');
    const outputDir = path.join(container, 'out');
    const sourcePath = path.join(tmpRoot, 'Reviewed.ai');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(outsideParent);
    fs.writeFileSync(sourcePath, 'immutable ancestry private bytes');
    await setProjectFiles(project.id, { files: [{
      path: sourcePath,
      name: 'Reviewed.ai',
      ext: '.ai',
      addedAt: Date.now(),
      source: 'manual-browse',
    }] });
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION);
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    const before = capturePackageSideEffects(stored);
    let movementInjected = false;

    setUtilityProcessHandler(({ phase }) => {
      if (phase !== 'fork' || movementInjected) return;
      fs.renameSync(container, movedContainer);
      fs.symlinkSync(movedContainer, container, 'dir');
      fs.writeFileSync(path.join(movedContainer, 'sentinel.txt'), 'unrelated sentinel');
      movementInjected = true;
    });

    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);

    assert.equal(movementInjected, true);
    assert.equal(result.error, 'package_cleanup_failed');
    assert.equal(storeInstance.get('usage.packagesThisMonth', 0), before.packagesThisMonth || 0);
    assert.equal(stored.status, before.status);
    assert.equal(stored.packagedAt, before.packagedAt);
    assert.equal(stored.outputPath, before.outputPath);
    assert.equal(fs.readFileSync(path.join(movedContainer, 'sentinel.txt'), 'utf8'), 'unrelated sentinel');
    const remainingFiles = [];
    const visit = candidate => {
      for (const entry of fs.readdirSync(candidate, { withFileTypes: true })) {
        const entryPath = path.join(candidate, entry.name);
        if (entry.isDirectory()) visit(entryPath);
        else if (!entry.isSymbolicLink()) remainingFiles.push(entryPath);
      }
    };
    visit(movedContainer);
    assert.deepEqual(remainingFiles, [path.join(movedContainer, 'sentinel.txt')]);
  } finally {
    setUtilityProcessHandler(null);
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.FLAT);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('absent layout defaults to organized output while invalid layout remains flat', async () => {
  const tmpRoot = makeTempDir();
  try {
    const cases = [
      { label: 'Absent Layout', value: undefined },
      { label: 'Invalid Layout', value: 'organized-someday' },
    ];
    for (const [index, scenario] of cases.entries()) {
      const project = await createProject(scenario.label);
      const sourceName = `${scenario.label}.ai`;
      const sourcePath = path.join(tmpRoot, sourceName);
      const outputDir = path.join(tmpRoot, `out-${index}`);
      fs.mkdirSync(outputDir);
      fs.writeFileSync(sourcePath, `${scenario.label} bytes`);
      await setProjectFiles(project.id, { files: [{
        path: sourcePath,
        name: sourceName,
        ext: '.ai',
        addedAt: Date.now(),
        source: 'manual-browse',
      }] });
      if (scenario.value === undefined) storeInstance.delete('settings.packageOutputLayoutMode');
      else storeInstance.set('settings.packageOutputLayoutMode', scenario.value);

      const review = await callIpcRaw('projects:prepare-package-review', project.id);
      const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);

      assert.equal(result.success, true, scenario.label);
      if (scenario.value === undefined) {
        assert.deepEqual(fs.readdirSync(result.folderPath), ['AI'], scenario.label);
        assert.deepEqual(fs.readdirSync(path.join(result.folderPath, 'AI')), [sourceName], scenario.label);
      } else {
        assert.deepEqual(fs.readdirSync(result.folderPath), [sourceName], scenario.label);
        assert.equal(fs.existsSync(path.join(result.folderPath, 'AI')), false, scenario.label);
      }
      const outputPath = scenario.value === undefined
        ? path.join(result.folderPath, 'AI', sourceName)
        : path.join(result.folderPath, sourceName);
      assert.equal(fs.readFileSync(outputPath, 'utf8'), `${scenario.label} bytes`);
    }
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 2);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('organized package routes representative design, image, and document files without flat duplicates', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Representative Organized Package');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    const files = [
      ['synthetic-illustration.ai', 'AI'],
      ['synthetic-preview.png', 'PNG'],
      ['synthetic-document.pdf', 'PDF'],
    ];
    const trackedFiles = files.map(([name]) => {
      const filePath = path.join(tmpRoot, name);
      fs.writeFileSync(filePath, `${name} bytes`);
      return {
        path: filePath,
        name,
        ext: path.extname(name),
        addedAt: Date.now(),
        source: 'manual-browse',
      };
    });
    await setProjectFiles(project.id, { files: trackedFiles });
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION);

    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.deepEqual(
      review.files.map(file => [file.name, file.packageFolder]),
      [
        ['synthetic-illustration.ai', 'AI'],
        ['synthetic-preview.png', 'PNG'],
        ['synthetic-document.pdf', 'PDF'],
      ]
    );
    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);

    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 3);
    assert.deepEqual(fs.readdirSync(result.folderPath).sort(), ['AI', 'PDF', 'PNG']);
    for (const [name, folder] of files) {
      assert.deepEqual(fs.readdirSync(path.join(result.folderPath, folder)), [name]);
      assert.equal(fs.readFileSync(path.join(result.folderPath, folder, name), 'utf8'), `${name} bytes`);
      assert.equal(fs.existsSync(path.join(result.folderPath, name)), false);
    }
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('changing the package layout mode invalidates flat review authority before any output or quota use', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Layout Review Authority');
    const sourcePath = path.join(tmpRoot, 'Layout.ai');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, 'layout authority bytes');
    const stored = await setProjectFiles(project.id, { files: [{
      path: sourcePath,
      name: 'Layout.ai',
      ext: '.ai',
      addedAt: Date.now(),
      source: 'manual-browse',
    }] });
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.FLAT);
    const flatReview = await callIpcRaw('projects:prepare-package-review', project.id);
    const before = capturePackageSideEffects(stored);

    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION);
    const changed = await callIpcRaw('projects:package', project.id, outputDir, flatReview.token);

    assert.equal(changed.error, 'package_review_changed');
    assert.equal(typeof changed.review.token, 'string');
    assert.deepEqual(fs.readdirSync(outputDir), []);
    assert.deepEqual(capturePackageSideEffects(stored), before);

    const result = await callIpcRaw('projects:package', project.id, outputDir, changed.review.token);
    assert.equal(result.success, true);
    assert.equal(fs.readFileSync(path.join(result.folderPath, 'AI', 'Layout.ai'), 'utf8'), 'layout authority bytes');
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('settings layout toggle immediately invalidates the prior review token and issues authoritative folder labels', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Layout Settings Token');
    const sourcePath = path.join(tmpRoot, 'Layout.ai');
    const pngPath = path.join(tmpRoot, 'Layout.png');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, 'layout source bytes');
    fs.writeFileSync(pngPath, 'layout asset bytes');
    const stored = await setProjectFiles(project.id, { files: [
      { path: sourcePath, name: 'Layout.ai', ext: '.ai', addedAt: Date.now(), source: 'manual-browse' },
      { path: pngPath, name: 'Layout.png', ext: '.png', addedAt: Date.now(), source: 'manual-browse' },
    ] });
    await callIpc('settings:update', 'packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.FLAT);
    const flatReview = await callIpcRaw('projects:prepare-package-review', project.id);
    const before = capturePackageSideEffects(stored);

    const settings = await callIpc(
      'settings:update',
      'packageOutputLayoutMode',
      PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION
    );
    assert.equal(settings.packageOutputLayoutMode, PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION);

    const stale = await callIpcRaw('projects:package', project.id, outputDir, flatReview.token);
    assert.equal(stale.error, 'package_review_stale');
    assert.deepEqual(fs.readdirSync(outputDir), []);
    assert.deepEqual(capturePackageSideEffects(stored), before);

    const organizedReview = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(organizedReview.planSummary.outputLayoutMode, PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION);
    assert.deepEqual(
      organizedReview.files.map(file => [file.name, file.packageFolder]),
      [['Layout.ai', 'AI'], ['Layout.png', 'PNG']]
    );
  } finally {
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.FLAT);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('package plan resolves case, Unicode, and diagnostics collisions with one macOS-safe identity', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('macOS Collision Plan');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    const names = [
      'Logo.png',
      'logo.png',
      'Cafe\u0301.png',
      'Caf\u00e9.png',
      'crate diagnostics',
      '\u03A3.png',
      '\u03C2.png',
      `${'\u754C'.repeat(100)}.png`,
    ];
    const files = names.map((name, index) => {
      const sourceDir = path.join(tmpRoot, `source-${index}`);
      const sourcePath = path.join(sourceDir, `input-${index}`);
      fs.mkdirSync(sourceDir);
      fs.writeFileSync(sourcePath, `bytes-${index}`);
      return { path: sourcePath, name, ext: path.extname(name), addedAt: Date.now(), source: 'manual-browse' };
    });
    await setProjectFiles(project.id, { files });
    await callIpc('settings:update', 'includeDiagnosticReport', true);

    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);
    assert.equal(result.success, true);
    const outputNames = fs.readdirSync(result.folderPath).sort();
    const fixedOutputNames = [
      'Cafe\u0301.png',
      'Caf\u00e9_1.png',
      'Crate Diagnostics',
      'Logo.png',
      'crate diagnostics_1',
      'logo_1.png',
      '\u03A3.png',
      '\u03C2_1.png',
    ];
    fixedOutputNames.forEach(name => assert.equal(outputNames.includes(name), true, `${name} must be materialized`));
    ['Logo.png', 'logo_1.png', 'Cafe\u0301.png', 'Caf\u00e9_1.png', 'crate diagnostics_1', '\u03A3.png', '\u03C2_1.png']
      .forEach((name, index) => assert.equal(fs.readFileSync(path.join(result.folderPath, name), 'utf8'), `bytes-${index}`));
    const multibyteName = outputNames.find(name => name.startsWith('\u754C'));
    assert.ok(multibyteName);
    assert.equal(fs.readFileSync(path.join(result.folderPath, multibyteName), 'utf8'), 'bytes-7');
    assert.equal(outputNames.length, 9);
    assert.equal(new Set(outputNames.map(packageCollisionKey)).size, outputNames.length);
    for (const name of outputNames) {
      assert.ok(name.length <= 180);
      assert.ok(Buffer.byteLength(name, 'utf8') <= 255);
      assert.equal(name.includes('\uFFFD'), false);
      assert.equal(/[\uD800-\uDFFF]/u.test(name), false);
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('destination collisions refresh the reviewed folder name before publishing', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Bound Destination Collision');
    const sourcePath = path.join(tmpRoot, 'Bound.ai');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, 'bound destination bytes');
    const stored = await setProjectFiles(project.id, { files: [{
      path: sourcePath,
      name: 'Bound.ai',
      ext: '.ai',
      addedAt: Date.now(),
      source: 'manual-browse',
    }] });
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    fs.mkdirSync(path.join(outputDir, review.folderName));
    const before = capturePackageSideEffects(stored);
    testRendererEvents.length = 0;

    const refreshed = await callIpcRaw('projects:package', project.id, outputDir, review.token);

    assert.equal(refreshed.error, 'package_review_changed');
    assert.equal(refreshed.reason, 'package_destination_changed');
    assert.equal(refreshed.review.folderName, `${review.folderName}_1`);
    assert.equal(fs.existsSync(path.join(outputDir, refreshed.review.folderName)), false);
    assert.equal(fs.readdirSync(outputDir).some(name => name.startsWith('.crate-package-staging-')), false);
    assert.deepEqual(capturePackageSideEffects(stored), before);
    assert.equal(testRendererEvents.some(entry => entry.channel === 'project:updated'), false);

    const result = await callIpcRaw('projects:package', project.id, outputDir, refreshed.review.token);
    assert.equal(result.success, true);
    assert.equal(path.basename(result.folderPath), refreshed.review.folderName);
    assert.equal(fs.readFileSync(path.join(result.folderPath, 'Bound.ai'), 'utf8'), 'bound destination bytes');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('destination occupancy drift refreshes again with zero package side effects', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Bound Destination Drift');
    const sourcePath = path.join(tmpRoot, 'Drift.ai');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, 'destination drift bytes');
    const stored = await setProjectFiles(project.id, { files: [{
      path: sourcePath,
      name: 'Drift.ai',
      ext: '.ai',
      addedAt: Date.now(),
      source: 'manual-browse',
    }] });
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    fs.mkdirSync(path.join(outputDir, review.folderName));
    const firstRefresh = await callIpcRaw('projects:package', project.id, outputDir, review.token);
    assert.equal(firstRefresh.review.folderName, `${review.folderName}_1`);
    fs.mkdirSync(path.join(outputDir, firstRefresh.review.folderName));
    const before = capturePackageSideEffects(stored);
    testRendererEvents.length = 0;

    const secondRefresh = await callIpcRaw('projects:package', project.id, outputDir, firstRefresh.review.token);

    assert.equal(secondRefresh.error, 'package_review_changed');
    assert.equal(secondRefresh.reason, 'package_destination_changed');
    assert.equal(secondRefresh.review.folderName, `${review.folderName}_2`);
    assert.equal(fs.existsSync(path.join(outputDir, secondRefresh.review.folderName)), false);
    assert.equal(fs.readdirSync(outputDir).some(name => name.startsWith('.crate-package-staging-')), false);
    assert.deepEqual(capturePackageSideEffects(stored), before);
    assert.equal(testRendererEvents.some(entry => entry.channel === 'project:updated'), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('late destination occupancy refreshes once and the second confirmation publishes the bound folder', async () => {
  const tmpRoot = makeTempDir();
  const originalOpen = fs.promises.open;
  try {
    const project = await createProject('Late Destination Occupancy');
    const parentPsd = path.join(tmpRoot, 'Deferred.psd');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(parentPsd, 'reviewed PSD bytes');
    currentPsdFixture = {
      children: [],
      linkedFiles: [{ name: 'Deferred.png', data: Buffer.from('late destination bytes') }],
    };
    const stored = await setProjectFiles(project.id, { files: [{
      path: parentPsd,
      parentPsd,
      name: 'Deferred.png',
      ext: '.png',
      addedAt: Date.now(),
      source: 'scan-on-save-embedded',
      embedded: true,
      embeddedOriginalName: 'Deferred.png',
      embeddedIndex: 0,
      fileId: 'late-destination-occupancy',
    }] });
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    const before = capturePackageSideEffects(stored);

    let stagingRoot = null;
    let destinationOccupied = false;
    const occupiedFolder = path.join(outputDir, review.folderName);
    fs.promises.open = async function occupyDestinationAfterPsdWrite(candidatePath, flags, ...args) {
      const handle = await originalOpen.call(fs.promises, candidatePath, flags, ...args);
      if (
        flags === 'wx' &&
        !destinationOccupied &&
        isExpectedStagedPackageWrite(candidatePath, outputDir, 'Deferred.png')
      ) {
        const originalWriteFile = handle.writeFile.bind(handle);
        handle.writeFile = async (...writeArgs) => {
          const result = await originalWriteFile(...writeArgs);
          stagingRoot = findPrivateStagedPackageRoot(outputDir);
          fs.mkdirSync(occupiedFolder);
          destinationOccupied = true;
          return result;
        };
      }
      return handle;
    };

    testRendererEvents.length = 0;
    const refreshed = await callIpcRaw('projects:package', project.id, outputDir, review.token);

    assert.equal(destinationOccupied, true);
    assert.equal(refreshed.error, 'package_review_changed');
    assert.equal(refreshed.reason, 'package_destination_changed');
    assert.equal(refreshed.review.folderName, `${review.folderName}_1`);
    assert.equal(typeof refreshed.review.token, 'string');
    assert.equal(fs.existsSync(stagingRoot), false);
    assert.equal(fs.existsSync(path.join(outputDir, refreshed.review.folderName)), false);
    assert.deepEqual(fs.readdirSync(occupiedFolder), []);
    assert.equal(fs.readdirSync(tmpRoot).some(name => name.startsWith('.crate-package-staging-')), false);
    assert.deepEqual(capturePackageSideEffects(stored), before);
    assert.equal(testRendererEvents.some(entry => entry.channel === 'project:updated'), false);

    const packaged = await callIpcRaw('projects:package', project.id, outputDir, refreshed.review.token);
    assert.equal(packaged.success, true);
    assert.equal(path.basename(packaged.folderPath), refreshed.review.folderName);
    assert.equal(
      fs.readFileSync(path.join(packaged.folderPath, 'Deferred.png'), 'utf8'),
      'late destination bytes'
    );
  } finally {
    fs.promises.open = originalOpen;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Package Review allocates near-limit duplicate filenames through the 9-to-10 transition', async () => {
  const tmpRoot = makeTempDir();
  try {
    for (const extensionLength of [177, 178, 179]) {
      const project = await createProject(`Long Extension ${extensionLength}`);
      const outputDir = path.join(tmpRoot, `out-${extensionLength}`);
      const rawName = `${'p'.repeat(179)}.${'z'.repeat(extensionLength)}`;
      fs.mkdirSync(outputDir);
      const files = Array.from({ length: 11 }, (_, index) => {
        const sourcePath = path.join(tmpRoot, `source-${extensionLength}-${index}.bin`);
        fs.writeFileSync(sourcePath, `${extensionLength}-${index}`);
        return {
          path: sourcePath,
          name: rawName,
          ext: `.${'z'.repeat(extensionLength)}`,
          addedAt: Date.now(),
          source: 'manual-browse',
        };
      });
      await setProjectFiles(project.id, { files });

      const review = await callIpcRaw('projects:prepare-package-review', project.id);
      assert.equal(review.materializable, true);
      assert.equal(review.totalFiles, 11);
      const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);
      assert.equal(result.success, true);
      const outputNames = fs.readdirSync(result.folderPath);
      assert.equal(outputNames.length, 11);
      assert.equal(new Set(outputNames.map(packageCollisionKey)).size, 11);
      assert.ok(outputNames.every(name => name.length <= 180));
      assert.ok(outputNames.some(name => /_9\./.test(name)));
      assert.ok(outputNames.some(name => /_10\./.test(name)));
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('long destination folder collisions reserve suffix width through 9 to 10', async () => {
  const tmpRoot = makeTempDir();
  const candidateName = (base, counter) => {
    if (counter === 0) return base;
    const suffix = `_${counter}`;
    return `${base.slice(0, 180 - suffix.length).trimEnd()}${suffix}`;
  };
  try {
    storeInstance.set('settings.namingTemplate', '{Project}');
    for (const length of [178, 179, 180]) {
      const projectName = `${String(length)}${'x'.repeat(length - String(length).length)}`;
      const project = await createProject(projectName);
      const sourcePath = path.join(tmpRoot, `source-${length}.ai`);
      const outputDir = path.join(tmpRoot, `out-${length}`);
      fs.mkdirSync(outputDir);
      fs.writeFileSync(sourcePath, `source ${length}`);
      fs.mkdirSync(path.join(outputDir, projectName));
      await setProjectFiles(project.id, { files: [{
        path: sourcePath,
        name: path.basename(sourcePath),
        ext: '.ai',
        addedAt: Date.now(),
        source: 'manual-browse',
      }] });

      const review = await callIpcRaw('projects:prepare-package-review', project.id);
      const refreshed = await callIpcRaw('projects:package', project.id, outputDir, review.token);
      assert.equal(refreshed.reason, 'package_destination_changed');
      assert.equal(refreshed.review.folderName, candidateName(projectName, 1));
      const result = await callIpcRaw('projects:package', project.id, outputDir, refreshed.review.token);
      assert.equal(path.basename(result.folderPath), candidateName(projectName, 1));
      assert.ok(path.basename(result.folderPath).length <= 180);
    }

    const projectName = `ten${'y'.repeat(177)}`;
    const project = await createProject(projectName);
    const sourcePath = path.join(tmpRoot, 'source-ten.ai');
    const outputDir = path.join(tmpRoot, 'out-ten');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, 'source ten');
    const occupiedNames = Array.from({ length: 10 }, (_, counter) => candidateName(projectName, counter));
    for (const name of occupiedNames) fs.mkdirSync(path.join(outputDir, name));
    await setProjectFiles(project.id, { files: [{
      path: sourcePath,
      name: path.basename(sourcePath),
      ext: '.ai',
      addedAt: Date.now(),
      source: 'manual-browse',
    }] });

    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    const refreshed = await callIpcRaw('projects:package', project.id, outputDir, review.token);
    assert.equal(refreshed.reason, 'package_destination_changed');
    assert.equal(refreshed.review.folderName, candidateName(projectName, 10));
    const result = await callIpcRaw('projects:package', project.id, outputDir, refreshed.review.token);
    const allocatedName = path.basename(result.folderPath);
    assert.equal(allocatedName, candidateName(projectName, 10));
    assert.equal(new Set([...occupiedNames, allocatedName]).size, 11);
    assert.ok([...occupiedNames, allocatedName].every(name => name.length <= 180));
  } finally {
    storeInstance.set('settings.namingTemplate', '{Project}_{Date}');
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('legacy binary PowerPoint receives a review token and copies without ZIP inspection', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Legacy PowerPoint');
    const pptPath = path.join(tmpRoot, 'Legacy.ppt');
    const outputDir = path.join(tmpRoot, 'out');
    const legacyBytes = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.from('synthetic legacy PowerPoint compound document'),
    ]);
    fs.mkdirSync(outputDir);
    fs.writeFileSync(pptPath, legacyBytes);
    await setProjectFiles(project.id, { files: [{
      path: pptPath,
      name: 'Legacy.ppt',
      ext: '.ppt',
      addedAt: Date.now(),
      source: 'manual-browse',
    }] });
    let unzipCalls = 0;
    setChildProcessHandler(request => {
      if (request.command === '/usr/bin/unzip') unzipCalls++;
      return { stdout: '', stderr: '' };
    });

    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(review.materializable, true);
    assert.equal(typeof review.token, 'string');
    assert.deepEqual(review.files.map(file => file.name), ['Legacy.ppt']);
    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);

    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.embeddedCount, 0);
    assert.deepEqual(fs.readFileSync(path.join(result.folderPath, 'Legacy.ppt')), legacyBytes);
    assert.equal(unzipCalls, 0);
  } finally {
    setChildProcessHandler(null);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('presentation derivative plan mismatch refreshes before staging and the refreshed plan packages', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Presentation Plan Equality');
    const deckPath = path.join(tmpRoot, 'Deck.pptx');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(deckPath, Buffer.from('stable presentation container'));
    await setProjectFiles(project.id, { files: [{
      path: deckPath, name: 'Deck.pptx', ext: '.pptx', addedAt: Date.now(), source: 'manual-browse',
    }] });
    setPowerPointUnzipFixture([{
      internalPath: 'ppt/media/image1.png', data: Buffer.from('REVIEWED_MEDIA_BYTES'.repeat(40)),
    }]);
    const review = await callIpcRaw('projects:prepare-package-review', project.id);

    setPowerPointUnzipFixture([{
      internalPath: 'ppt/media/image1.png', data: Buffer.from('UPDATED_MEDIA_BYTES!'.repeat(40)),
    }]);
    const changed = await callIpcRaw('projects:package', project.id, outputDir, review.token);
    assert.equal(changed.error, 'package_review_changed');
    assert.deepEqual(fs.readdirSync(outputDir), []);

    const result = await callIpcRaw('projects:package', project.id, outputDir, changed.review.token);
    assert.equal(result.success, true);
    assert.equal(result.embeddedCount, 1);
    assert.equal(fs.readFileSync(path.join(result.folderPath, 'Deck — image1.png'), 'utf8'), 'UPDATED_MEDIA_BYTES!'.repeat(40));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('staged presentation materializer rejects output bytes that do not equal the reviewed plan', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Staged Presentation Plan Mismatch');
    const deckPath = path.join(tmpRoot, 'Deck.pptx');
    const outputDir = path.join(tmpRoot, 'out');
    const reviewedBytes = Buffer.from('REVIEWED_STAGED_MEDIA'.repeat(40));
    const changedBytes = Buffer.from('CHANGED__STAGED_MEDIA'.repeat(40));
    fs.mkdirSync(outputDir);
    fs.writeFileSync(deckPath, Buffer.from('stable presentation container'));
    let stagedMaterializationReached = false;
    let stagingRoot = null;
    await setProjectFiles(project.id, { files: [{
      path: deckPath, name: 'Deck.pptx', ext: '.pptx', addedAt: Date.now(), source: 'manual-browse',
    }] });
    setChildProcessHandler(({ kind, command, args }) => {
      if (kind !== 'execFile' || command !== '/usr/bin/unzip') return { stdout: '', stderr: '' };
      if (args[0] === '-l') {
        return { stdout: `      ${reviewedBytes.length}  05-26-2026 12:34   ppt/media/image1.png\n`, stderr: '' };
      }
      if (args[0] === '-p') {
        const candidateStagingRoot = getPrivateStagedPackageRoot(args[1], outputDir);
        const stagedContainer = !!candidateStagingRoot;
        if (stagedContainer) {
          stagingRoot = candidateStagingRoot;
          stagedMaterializationReached = true;
        }
        return { stdout: stagedContainer ? changedBytes : reviewedBytes, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const stored = await getProject(project.id);
    const before = capturePackageSideEffects(stored);
    const review = await callIpcRaw('projects:prepare-package-review', project.id);

    const changed = await callIpcRaw('projects:package', project.id, outputDir, review.token);
    assert.equal(stagedMaterializationReached, true);
    assert.equal(changed.error, 'package_review_changed');
    assertFailedPackageHasNoSideEffects(stored, outputDir, before);
    assertNoPrivatePackageStaging(outputDir, stagingRoot);
  } finally {
    setChildProcessHandler(null);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Figma cached source mutation invalidates its reviewed source plan before output', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createVerifiedFigmaProject(
      'Figma Cached Source Plan',
      'entire-file',
      'https://www.figma.com/file/SAFEFILEKEY/Cached-Source'
    );
    const cachedPath = path.join(tmpRoot, 'Figma-Cached.png');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(cachedPath, Buffer.from('cached-A'));
    await setProjectFiles(project.id, { files: [{
      path: cachedPath, name: 'Figma-Cached.png', ext: '.png', addedAt: Date.now(), source: 'figma-auto',
      figmaFileKey: 'safe-file-key', figmaPageId: '1:2',
    }] });
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    fs.writeFileSync(cachedPath, Buffer.from('cached-B'));

    const changed = await callIpcRaw('projects:package', project.id, outputDir, review.token);
    assert.equal(changed.error, 'package_review_changed');
    assert.deepEqual(fs.readdirSync(outputDir), []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Beta 2.6 reproduction invalidates an added file and refreshed review packages it only after a second confirmation', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Package Review Reproduction');
    const outputDir = path.join(tmpRoot, 'out');
    const sourcePaths = [
      path.join(tmpRoot, 'Review_Project.ai'),
      path.join(tmpRoot, 'Review_Initial.png'),
      path.join(tmpRoot, 'Review_Added_After_Review.png'),
    ];
    fs.mkdirSync(outputDir);
    sourcePaths.forEach((filePath, index) => fs.writeFileSync(filePath, `source-${index}`));
    const files = sourcePaths.slice(0, 2).map(filePath => ({
      path: filePath,
      name: path.basename(filePath),
      ext: path.extname(filePath).toLowerCase(),
      addedAt: Date.now(),
      source: 'manual-browse',
    }));
    await setProjectFiles(project.id, { files });

    const firstReview = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(firstReview.totalFiles, 2);
    const storedProject = storeInstance.data.projects.find(item => item.id === project.id);
    storedProject.files.push({
      path: sourcePaths[2],
      name: path.basename(sourcePaths[2]),
      ext: '.png',
      addedAt: Date.now(),
      source: 'manual-browse',
    });
    const before = {
      status: storedProject.status,
      outputPath: storedProject.outputPath,
      provenance: JSON.stringify(storedProject.provenance),
      quota: storeInstance.get('usage.packagesThisMonth'),
      watcherCloseCount,
    };

    const changed = await callIpcRaw('projects:package', project.id, outputDir, firstReview.token);
    assert.equal(changed.error, 'package_review_changed');
    assert.equal(changed.review.totalFiles, 3);
    assert.deepEqual(changed.review.files.map(file => file.name), sourcePaths.map(filePath => path.basename(filePath)));
    assert.deepEqual(fs.readdirSync(outputDir), []);
    assert.equal(storedProject.status, before.status);
    assert.equal(storedProject.outputPath, before.outputPath);
    assert.equal(JSON.stringify(storedProject.provenance), before.provenance);
    assert.equal(storeInstance.get('usage.packagesThisMonth'), before.quota);
    assert.equal(watcherCloseCount, before.watcherCloseCount);

    const packaged = await callIpcRaw('projects:package', project.id, outputDir, changed.review.token);
    assertPackageResultShape(packaged);
    assert.equal(packaged.success, true);
    assert.equal(packaged.totalFiles, 3);
    assert.deepEqual(
      fs.readdirSync(packageFolder(outputDir, project.name)).sort(),
      sourcePaths.map(filePath => path.basename(filePath)).sort()
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('removed and renamed reviewed files invalidate before package output', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Removed Renamed Review');
    const outputDir = path.join(tmpRoot, 'out');
    const firstPath = path.join(tmpRoot, 'First.ai');
    const secondPath = path.join(tmpRoot, 'Second.png');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(firstPath, 'first');
    fs.writeFileSync(secondPath, 'second');
    await setProjectFiles(project.id, {
      files: [firstPath, secondPath].map(filePath => ({
        path: filePath,
        name: path.basename(filePath),
        ext: path.extname(filePath).toLowerCase(),
        addedAt: Date.now(),
        source: 'manual-browse',
      })),
    });

    const removedReview = await callIpcRaw('projects:prepare-package-review', project.id);
    const storedProject = storeInstance.data.projects.find(item => item.id === project.id);
    storedProject.files.pop();
    const removed = await callIpcRaw('projects:package', project.id, outputDir, removedReview.token);
    assert.equal(removed.error, 'package_review_changed');
    assert.equal(removed.review.totalFiles, 1);
    assert.deepEqual(fs.readdirSync(outputDir), []);

    const renamedPath = path.join(tmpRoot, 'Renamed.ai');
    const renamedReview = removed.review;
    fs.renameSync(firstPath, renamedPath);
    storedProject.files[0].path = renamedPath;
    storedProject.files[0].name = path.basename(renamedPath);
    const renamed = await callIpcRaw('projects:package', project.id, outputDir, renamedReview.token);
    assert.equal(renamed.error, 'package_review_changed');
    assert.deepEqual(renamed.review.files.map(file => file.name), ['Renamed.ai']);
    assert.deepEqual(fs.readdirSync(outputDir), []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('same-path source modification invalidates the reviewed manifest', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Same Path Review');
    const sourcePath = path.join(tmpRoot, 'Same.ai');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, 'before');
    await setProjectFiles(project.id, {
      files: [{
        path: sourcePath,
        name: 'Same.ai',
        ext: '.ai',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });

    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    fs.writeFileSync(sourcePath, 'after-with-different-size');
    const changed = await callIpcRaw('projects:package', project.id, outputDir, review.token);
    assert.equal(changed.error, 'package_review_changed');
    assert.equal(changed.review.totalFiles, 1);
    assert.deepEqual(fs.readdirSync(outputDir), []);
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 0);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

async function packageWithSourceMutation({ project, sourcePath, outputDir, method = 'read', mutate }) {
  const originalOpen = fs.promises.open;
  let mutated = false;
  fs.promises.open = async function openWithMutation(candidatePath, flags, ...args) {
    const handle = await originalOpen.call(fs.promises, candidatePath, flags, ...args);
    if (flags !== 'r' || path.resolve(candidatePath) !== path.resolve(sourcePath)) return handle;
    const wrapped = {
      fd: handle.fd,
      stat: handle.stat.bind(handle),
      close: handle.close.bind(handle),
      read: handle.read.bind(handle),
      readFile: handle.readFile.bind(handle),
    };
    const originalRead = wrapped[method];
    wrapped[method] = async (...readArgs) => {
      const result = await originalRead(...readArgs);
      if (!mutated) {
        mutated = true;
        mutate();
      }
      return result;
    };
    return wrapped;
  };
  try {
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    return await callIpcRaw('projects:package', project.id, outputDir, review.token);
  } finally {
    fs.promises.open = originalOpen;
  }
}

function assertFailedPackageHasNoSideEffects(project, outputDir, before) {
  assert.deepEqual(fs.readdirSync(outputDir), []);
  assert.equal(project.status, before.status);
  assert.equal(project.packagedAt, before.packagedAt);
  assert.equal(project.outputPath, before.outputPath);
  assert.equal(JSON.stringify(project.provenance), before.provenance);
  assert.equal(storeInstance.get('usage.packagesThisMonth'), before.quota);
  assert.equal(watcherCloseCount, before.watcherCloseCount);
}

function assertUnavailablePackageReview(review, fileName) {
  assert.equal(review.materializable, false);
  assert.equal(review.token, undefined);
  assert.equal(review.files.length, 1);
  const file = review.files[0];
  const ext = path.extname(fileName).toLowerCase();
  assert.equal(file.name, fileName);
  assert.equal(file.ext, ext);
  assert.equal(file.embedded, false);
  assert.equal(file.linked, false);
  assert.equal(file.appFamily, ext === '.pptx' ? 'powerpoint' : 'keynote');
  assert.equal(file.sourceName, null);
  assert.equal(file.assetOrigin, 'added');
  assert.equal(file.projectRole, 'source');
  assert.equal(file.protectedSource, true);
  assert.equal(file.sourceRecoveryAllowed, false);
  assert.equal(file.excluded, false);
  assert.equal(file.status, 'unavailable');
  assert.match(file.visualIdentity, /^[A-Za-z0-9_-]{43}$/);
}

function capturePackageSideEffects(project) {
  return {
    status: project.status,
    packagedAt: project.packagedAt,
    outputPath: project.outputPath,
    provenance: JSON.stringify(project.provenance),
    quota: storeInstance.get('usage.packagesThisMonth'),
    watcherCloseCount,
  };
}

function assertNoPrivatePackageStaging(outputDir, stagingRoot) {
  assert.ok(stagingRoot, 'the staged-tree mutation hook must capture the private staging root');
  assert.equal(fs.existsSync(stagingRoot), false);
  assert.deepEqual(fs.readdirSync(outputDir), []);
  assert.deepEqual(
    fs.readdirSync(path.dirname(path.resolve(outputDir))).filter(name => name.startsWith('.crate-package-staging-')),
    []
  );
}

async function assertStagedTreeMutationFailsClosed(label, mutate, options = {}) {
  const tmpRoot = makeTempDir();
  const originalOpen = fs.promises.open;
  const originalReaddirSync = fs.readdirSync;
  let stagingRoot = null;
  let stagedFilePath = null;
  let stagedRootEnumerations = 0;
  let hookReached = false;
  try {
    const project = await createProject(`Staged tree ${label}`);
    const sourcePath = path.join(tmpRoot, 'Reviewed.ai');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, 'reviewed staged tree bytes');
    storeInstance.set('settings.includeDiagnosticReport', options.diagnostics === true);
    storeInstance.set(
      'settings.packageOutputLayoutMode',
      options.organized === true ? PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION : PACKAGE_OUTPUT_LAYOUT_MODES.FLAT
    );
    const stored = await setProjectFiles(project.id, { files: [{
      path: sourcePath,
      name: 'Reviewed.ai',
      ext: '.ai',
      addedAt: Date.now(),
      source: 'manual-browse',
    }] });
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    const before = capturePackageSideEffects(stored);

    setUtilityProcessHandler(({ phase, message }) => {
      if (phase !== 'message' || message.type !== 'write-start' || stagingRoot) return;
      stagingRoot = findPrivateStagedPackageRoot(outputDir);
      stagedFilePath = stagingRoot
        ? path.join(stagingRoot, ...(options.organized === true ? ['AI', 'Reviewed.ai'] : ['Reviewed.ai']))
        : null;
    });

    fs.promises.open = async function captureStagedDestination(candidatePath, flags, ...args) {
      const handle = await originalOpen.call(fs.promises, candidatePath, flags, ...args);
      if (flags === 'wx' && path.basename(candidatePath) === 'Reviewed.ai') {
        stagingRoot = getPrivateStagedPackageRoot(candidatePath, outputDir) || findPrivateStagedPackageRoot(outputDir);
        stagedFilePath = candidatePath;
      }
      return handle;
    };
    fs.readdirSync = function mutateBeforeFinalStagedEnumeration(candidatePath, ...args) {
      if (stagingRoot && path.resolve(candidatePath) === path.resolve(stagingRoot)) {
        stagedRootEnumerations++;
        if (stagedRootEnumerations === 2) {
          hookReached = true;
          mutate({ stagingRoot, stagedFilePath, tmpRoot });
        }
      }
      return originalReaddirSync.call(fs, candidatePath, ...args);
    };

    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);
    fs.promises.open = originalOpen;
    fs.readdirSync = originalReaddirSync;

    assert.equal(hookReached, true, `${label} must reach the final staged-tree verification boundary`);
    if (options.expectCleanupFailure === true) {
      assert.equal(result.error, 'package_cleanup_failed');
    } else {
      assert.equal(result.error, 'package_review_changed');
      assert.equal(result.review.materializable, true);
    }
    assertFailedPackageHasNoSideEffects(stored, outputDir, before);
    if (options.expectCleanupFailure === true) {
      assert.equal(fs.existsSync(stagingRoot), true, `${label} must preserve the unknown staged object`);
      assert.equal(fs.existsSync(path.join(outputDir, review.folderName)), false);
    } else {
      assertNoPrivatePackageStaging(outputDir, stagingRoot);
    }
  } finally {
    setUtilityProcessHandler(null);
    fs.promises.open = originalOpen;
    fs.readdirSync = originalReaddirSync;
    storeInstance.set('settings.includeDiagnosticReport', false);
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.FLAT);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

const STAGED_TREE_MUTATION_SCENARIOS = [
  {
    label: 'byte replacement',
    mutate: ({ stagedFilePath }) => {
      const stat = fs.statSync(stagedFilePath);
      fs.writeFileSync(stagedFilePath, 'changed! staged tree bytes');
      fs.utimesSync(stagedFilePath, stat.atime, stat.mtime);
    },
  },
  {
    label: 'file replacement',
    expectCleanupFailure: true,
    mutate: ({ stagedFilePath }) => {
      const bytes = fs.readFileSync(stagedFilePath);
      fs.unlinkSync(stagedFilePath);
      fs.writeFileSync(stagedFilePath, bytes, { mode: 0o600 });
    },
  },
  {
    label: 'symlink replacement',
    expectCleanupFailure: true,
    mutate: ({ stagedFilePath, tmpRoot }) => {
      const outsidePath = path.join(tmpRoot, 'outside-target');
      fs.writeFileSync(outsidePath, 'outside bytes');
      fs.unlinkSync(stagedFilePath);
      fs.symlinkSync(outsidePath, stagedFilePath);
    },
  },
  {
    label: 'extra child',
    expectCleanupFailure: true,
    mutate: ({ stagingRoot }) => {
      const extraDir = path.join(stagingRoot, 'unexpected');
      fs.mkdirSync(extraDir);
      fs.writeFileSync(path.join(extraDir, 'extra.bin'), 'unexpected staged bytes');
    },
  },
  {
    label: 'file permission change',
    mutate: ({ stagedFilePath }) => fs.chmodSync(stagedFilePath, 0o644),
  },
  {
    label: 'directory permission change',
    mutate: ({ stagingRoot }) => fs.chmodSync(stagingRoot, 0o755),
  },
  {
    label: 'missing child',
    mutate: ({ stagedFilePath }) => fs.unlinkSync(stagedFilePath),
  },
  {
    label: 'hard-linked child',
    expectCleanupFailure: true,
    mutate: ({ stagingRoot, stagedFilePath }) => fs.linkSync(stagedFilePath, path.join(stagingRoot, 'hard-link.bin')),
  },
];

for (const scenario of STAGED_TREE_MUTATION_SCENARIOS) {
  const cleanupExpectation = scenario.expectCleanupFailure === true
    ? 'without deleting the unknown object'
    : 'and removes all private staging';
  test(`final staged tree rejects ${scenario.label} ${cleanupExpectation}`, async () => {
    await assertStagedTreeMutationFailsClosed(scenario.label, scenario.mutate, scenario);
  });
}

test('organized nested staged tree rejects an extra child without deleting the unknown directory', async () => {
  await assertStagedTreeMutationFailsClosed('organized nested extra child', ({ stagingRoot }) => {
    const extraDir = path.join(stagingRoot, 'AI', 'unexpected');
    fs.mkdirSync(extraDir);
    fs.writeFileSync(path.join(extraDir, 'extra.bin'), 'unexpected nested staged bytes');
  }, { organized: true, expectCleanupFailure: true });
});

test('post-verification staged mutation rolls the exact package directory back before side effects', async () => {
  const tmpRoot = makeTempDir();
  const originalRenameSync = fs.renameSync;
  let mutationReached = false;
  let retainedStaging = null;
  try {
    const project = await createProject('Post Verification Publication Mutation');
    const sourcePath = path.join(tmpRoot, 'Reviewed.ai');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, 'reviewed publication bytes');
    const stored = await setProjectFiles(project.id, { files: [{
      path: sourcePath,
      name: 'Reviewed.ai',
      ext: '.ai',
      addedAt: Date.now(),
      source: 'manual-browse',
    }] });
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    const before = capturePackageSideEffects(stored);

    fs.renameSync = function mutateAfterVerification(source, destination, ...args) {
      if (
        !mutationReached &&
        path.basename(source).startsWith('.crate-package-staging-') &&
        path.dirname(destination) === outputDir
      ) {
        mutationReached = true;
        retainedStaging = source;
        fs.mkdirSync(path.join(source, 'unknown'));
        fs.writeFileSync(path.join(source, 'unknown', 'sentinel.bin'), 'unrelated publication bytes');
      }
      return originalRenameSync.call(fs, source, destination, ...args);
    };

    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);
    fs.renameSync = originalRenameSync;

    assert.equal(mutationReached, true);
    assert.equal(result.error, 'package_cleanup_failed');
    assertFailedPackageHasNoSideEffects(stored, outputDir, before);
    assert.equal(fs.existsSync(path.join(outputDir, review.folderName)), false);
    assert.equal(fs.existsSync(retainedStaging), true);
    assert.equal(
      fs.readFileSync(path.join(retainedStaging, 'unknown', 'sentinel.bin'), 'utf8'),
      'unrelated publication bytes'
    );
  } finally {
    fs.renameSync = originalRenameSync;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

const ORGANIZED_PHYSICAL_GROUP_SWAP_SCENARIOS = [
  {
    label: 'source copy',
    targetSpawn: 1,
    targetLeaf: 'Reviewed.ai',
    setup(tmpRoot) {
      const sourcePath = path.join(tmpRoot, 'Reviewed.ai');
      fs.writeFileSync(sourcePath, 'organized reviewed source bytes');
      return [{ path: sourcePath, name: 'Reviewed.ai', ext: '.ai', addedAt: Date.now(), source: 'manual-browse' }];
    },
  },
  {
    label: 'PSD embedded resource',
    targetSpawn: 1,
    targetLeaf: 'Embedded.png',
    setup(tmpRoot) {
      const parentPsd = path.join(tmpRoot, 'Parent.psd');
      fs.writeFileSync(parentPsd, 'organized parent PSD bytes');
      currentPsdFixture = {
        children: [],
        linkedFiles: [{ name: 'Embedded.png', data: Buffer.from('organized embedded PSD bytes') }],
      };
      return [{
        path: parentPsd,
        parentPsd,
        name: 'Embedded.png',
        ext: '.png',
        source: 'scan-on-save-embedded',
        embedded: true,
        embeddedOriginalName: 'Embedded.png',
        embeddedIndex: 0,
        fileId: 'organized-tamper-psd-resource',
      }];
    },
  },
  {
    label: 'presentation media',
    targetSpawn: 2,
    targetLeaf: 'Deck — image1.jpg',
    setup(tmpRoot) {
      const deckPath = path.join(tmpRoot, 'Deck.pptx');
      fs.writeFileSync(deckPath, 'organized presentation source bytes');
      setPowerPointUnzipFixture([{
        internalPath: 'ppt/media/image1.jpg',
        data: Buffer.from('ORGANIZED_TAMPER_PRESENTATION'.repeat(40)),
      }]);
      return [{ path: deckPath, name: 'Deck.pptx', ext: '.pptx', addedAt: Date.now(), source: 'manual-browse' }];
    },
  },
  {
    label: 'diagnostics manifest',
    targetSpawn: 2,
    targetLeaf: 'crate-provenance.json',
    includeDiagnosticReport: true,
    expectedError: 'diagnostic_manifest_write_failed',
    setup(tmpRoot) {
      const sourcePath = path.join(tmpRoot, 'Diagnostics.ai');
      fs.writeFileSync(sourcePath, 'organized diagnostics source bytes');
      return [{ path: sourcePath, name: 'Diagnostics.ai', ext: '.ai', addedAt: Date.now(), source: 'manual-browse' }];
    },
  },
];

for (const scenario of ORGANIZED_PHYSICAL_GROUP_SWAP_SCENARIOS) {
  test(`organized ${scenario.label} writer rejects physical group substitution without outside writes`, async () => {
    const tmpRoot = makeTempDir();
    try {
      const project = await createProject(`Organized ${scenario.label} Substitution`);
      const outputDir = path.join(tmpRoot, 'out');
      const outsidePath = path.join(tmpRoot, 'outside');
      fs.mkdirSync(outputDir);
      fs.mkdirSync(outsidePath);
      fs.writeFileSync(path.join(outsidePath, 'sentinel.txt'), `${scenario.label} sentinel`);
      await setProjectFiles(project.id, { files: scenario.setup(tmpRoot) });
      storeInstance.set('settings.includeDiagnosticReport', scenario.includeDiagnosticReport === true);
      storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION);
      const review = await callIpcRaw('projects:prepare-package-review', project.id);
      const stored = storeInstance.data.projects.find(item => item.id === project.id);
      const before = capturePackageSideEffects(stored);
      let packageWriterSpawnCount = 0;
      let substituted = false;

      setUtilityProcessHandler(({ phase, options, message }) => {
        if (phase !== 'message' || message.type !== 'write-start') return;
        packageWriterSpawnCount++;
        if (packageWriterSpawnCount !== scenario.targetSpawn) return;
        const movedGroup = `${options.cwd}-moved`;
        fs.renameSync(options.cwd, movedGroup);
        fs.symlinkSync(outsidePath, options.cwd, 'dir');
        substituted = true;
      });

      const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);

      assert.equal(substituted, true);
      assert.equal(result.error, 'package_cleanup_failed');
      assertFailedPackageHasNoSideEffects(stored, outputDir, before);
      assert.deepEqual(fs.readdirSync(outsidePath), ['sentinel.txt']);
      assert.equal(fs.readFileSync(path.join(outsidePath, 'sentinel.txt'), 'utf8'), `${scenario.label} sentinel`);
      assert.equal(
        fs.readdirSync(tmpRoot).some(name => name.startsWith('.crate-package-staging-') || name.startsWith('.crate-package-group-')),
        true,
        'cleanup must preserve private staging when a substituted group path remains'
      );
    } finally {
      setUtilityProcessHandler(null);
      storeInstance.set('settings.includeDiagnosticReport', false);
      storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.FLAT);
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
}

for (const scenario of ORGANIZED_PHYSICAL_GROUP_SWAP_SCENARIOS) {
  test(`organized ${scenario.label} writer rejects a FIFO leaf before copying private bytes`, async () => {
    const tmpRoot = makeTempDir();
    let fifoReadFd = null;
    try {
      const project = await createProject(`Organized ${scenario.label} FIFO`);
      const outputDir = path.join(tmpRoot, 'out');
      fs.mkdirSync(outputDir);
      await setProjectFiles(project.id, { files: scenario.setup(tmpRoot) });
      storeInstance.set('settings.includeDiagnosticReport', scenario.includeDiagnosticReport === true);
      storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION);
      const review = await callIpcRaw('projects:prepare-package-review', project.id);
      const stored = storeInstance.data.projects.find(item => item.id === project.id);
      const before = capturePackageSideEffects(stored);
      let packageWriterSpawnCount = 0;
      let fifoPath = null;

      setUtilityProcessHandler(({ phase, options, message }) => {
        if (phase !== 'message' || message.type !== 'write-start') return;
        packageWriterSpawnCount++;
        if (packageWriterSpawnCount !== scenario.targetSpawn) return;
        fifoPath = path.join(options.cwd, scenario.targetLeaf);
        const mkfifo = realSpawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
        assert.equal(mkfifo.status, 0, mkfifo.stderr || `${scenario.label} FIFO creation failed`);
        fifoReadFd = fs.openSync(fifoPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      });

      const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);

      assert.notEqual(fifoPath, null);
      assert.equal(result.error, 'package_cleanup_failed');
      assertFailedPackageHasNoSideEffects(stored, outputDir, before);
      const observed = Buffer.alloc(256);
      let bytesRead = 0;
      try {
        bytesRead = fs.readSync(fifoReadFd, observed, 0, observed.length, null);
      } catch (error) {
        assert.equal(error.code, 'EAGAIN');
      }
      assert.equal(bytesRead, 0, `${scenario.label} must not write private bytes to the substituted FIFO`);
      assert.equal(fs.existsSync(fifoPath), true);
      assert.equal(
        fs.readdirSync(tmpRoot).some(name => name.startsWith('.crate-package-staging-') || name.startsWith('.crate-package-group-')),
        true,
        'cleanup must retain private staging when an unowned special file prevents exact cleanup'
      );
    } finally {
      if (fifoReadFd !== null) fs.closeSync(fifoReadFd);
      setUtilityProcessHandler(null);
      storeInstance.set('settings.includeDiagnosticReport', false);
      storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.FLAT);
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
}

test('organized group rename substitution retains cleanup ownership until identity is proven', async () => {
  const tmpRoot = makeTempDir();
  const originalRenameSync = fs.renameSync;
  try {
    const project = await createProject('Organized Rename Substitution');
    const sourcePath = path.join(tmpRoot, 'Reviewed.ai');
    const outputDir = path.join(tmpRoot, 'out');
    const outsidePath = path.join(tmpRoot, 'outside');
    fs.mkdirSync(outputDir);
    fs.mkdirSync(outsidePath);
    fs.writeFileSync(sourcePath, 'organized rename source bytes');
    fs.writeFileSync(path.join(outsidePath, 'sentinel.txt'), 'rename sentinel');
    await setProjectFiles(project.id, { files: [{
      path: sourcePath, name: 'Reviewed.ai', ext: '.ai', addedAt: Date.now(), source: 'manual-browse',
    }] });
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION);
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    const before = capturePackageSideEffects(stored);
    let substituted = false;

    fs.renameSync = function substituteGroupDuringFinalize(source, destination) {
      if (!substituted && path.basename(source).startsWith('.crate-package-group-')) {
        const movedGroup = `${source}-moved`;
        originalRenameSync.call(fs, source, movedGroup);
        fs.symlinkSync(outsidePath, source, 'dir');
        substituted = true;
      }
      return originalRenameSync.call(fs, source, destination);
    };

    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);

    assert.equal(substituted, true);
    assert.equal(result.error, 'package_cleanup_failed');
    assertFailedPackageHasNoSideEffects(stored, outputDir, before);
    assert.deepEqual(fs.readdirSync(outsidePath), ['sentinel.txt']);
    assert.equal(fs.readFileSync(path.join(outsidePath, 'sentinel.txt'), 'utf8'), 'rename sentinel');
    assert.equal(
      fs.readdirSync(tmpRoot).some(name => name.startsWith('.crate-package-staging-') || name.startsWith('.crate-package-group-')),
      true,
      'cleanup must preserve the unowned replacement inside private staging'
    );
  } finally {
    fs.renameSync = originalRenameSync;
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.FLAT);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('organized finalized group movement preserves an unowned replacement while reclaiming owned files', async () => {
  const tmpRoot = makeTempDir();
  const originalLstatSync = fs.lstatSync;
  try {
    const project = await createProject('Organized Post Finalization Movement');
    const sourcePath = path.join(tmpRoot, 'Reviewed.ai');
    const outputDir = path.join(tmpRoot, 'out');
    const outsidePath = path.join(tmpRoot, 'outside');
    fs.mkdirSync(outputDir);
    fs.mkdirSync(outsidePath);
    fs.writeFileSync(sourcePath, 'organized post-finalization bytes');
    fs.writeFileSync(path.join(outsidePath, 'sentinel.txt'), 'post-finalization sentinel');
    await setProjectFiles(project.id, { files: [{
      path: sourcePath, name: 'Reviewed.ai', ext: '.ai', addedAt: Date.now(), source: 'manual-browse',
    }] });
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION);
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    const before = capturePackageSideEffects(stored);
    let movedGroupPath = null;

    fs.lstatSync = function moveFinalizedGroupAfterIdentityRead(candidatePath, ...args) {
      const stat = originalLstatSync.call(fs, candidatePath, ...args);
      if (
        !movedGroupPath &&
        path.basename(candidatePath) === 'AI' &&
        path.basename(path.dirname(candidatePath)).startsWith('.crate-package-staging-') &&
        !stat.isSymbolicLink() &&
        stat.isDirectory()
      ) {
        movedGroupPath = path.join(path.dirname(candidatePath), '.crate-package-group-retained');
        fs.renameSync(candidatePath, movedGroupPath);
        fs.symlinkSync(outsidePath, candidatePath, 'dir');
      }
      return stat;
    };

    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);

    assert.notEqual(movedGroupPath, null);
    assert.equal(result.error, 'package_cleanup_failed');
    assertFailedPackageHasNoSideEffects(stored, outputDir, before);
    assert.deepEqual(fs.readdirSync(outsidePath), ['sentinel.txt']);
    assert.equal(fs.readFileSync(path.join(outsidePath, 'sentinel.txt'), 'utf8'), 'post-finalization sentinel');
    assert.equal(fs.existsSync(movedGroupPath), false);
    const replacementPath = path.join(path.dirname(movedGroupPath), 'AI');
    assert.equal(fs.lstatSync(replacementPath).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(replacementPath, 'sentinel.txt'), 'utf8'), 'post-finalization sentinel');
    assert.equal(
      fs.readdirSync(tmpRoot).some(name => name.startsWith('.crate-package-staging-') || name.startsWith('.crate-package-group-')),
      true,
      'cleanup must retain private staging when an unowned replacement remains'
    );
  } finally {
    fs.lstatSync = originalLstatSync;
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.FLAT);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('final staging cleanup preserves a directory replacement introduced after worker cleanup', async () => {
  const tmpRoot = makeTempDir();
  const originalOpenSync = fs.openSync;
  const originalRenameSync = fs.renameSync;
  try {
    const project = await createProject('Final Staging Cleanup Replacement');
    const sourcePath = path.join(tmpRoot, 'Reviewed.ai');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, 'final cleanup replacement bytes');
    await setProjectFiles(project.id, { files: [{
      path: sourcePath, name: 'Reviewed.ai', ext: '.ai', addedAt: Date.now(), source: 'manual-browse',
    }] });
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION);
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    const before = capturePackageSideEffects(stored);
    let stagingRoot = null;
    let cleanupArmed = false;
    let retainedRoot = null;
    let replacementRoot = null;

    const captureWriter = utilityProcessHandler;
    setUtilityProcessHandler(request => {
      const { phase, message, options } = request;
      if (phase === 'message' && message.type === 'write-start' && !stagingRoot) {
        stagingRoot = findPrivateStagedPackageRoot(outputDir);
      }
      if (phase === 'message' && message.type === 'cleanup' && options.cwd === stagingRoot) {
        cleanupArmed = true;
      }
      captureWriter?.(request);
    });
    fs.renameSync = function blockPublication(source, destination, ...args) {
      if (
        stagingRoot &&
        path.resolve(source) === path.resolve(stagingRoot) &&
        path.dirname(destination) === outputDir
      ) {
        const error = new Error('synthetic publication failure');
        error.code = 'EACCES';
        throw error;
      }
      return originalRenameSync.call(fs, source, destination, ...args);
    };
    fs.openSync = function replaceRootAfterCleanupWorker(candidatePath, flags, ...args) {
      if (
        cleanupArmed &&
        !replacementRoot &&
        stagingRoot &&
        path.resolve(candidatePath) === path.resolve(stagingRoot) &&
        (flags & fs.constants.O_DIRECTORY) === fs.constants.O_DIRECTORY
      ) {
        const fd = originalOpenSync.call(fs, candidatePath, flags, ...args);
        retainedRoot = `${stagingRoot}-retained`;
        replacementRoot = stagingRoot;
        originalRenameSync.call(fs, stagingRoot, retainedRoot);
        fs.mkdirSync(replacementRoot, { mode: 0o700 });
        return fd;
      }
      return originalOpenSync.call(fs, candidatePath, flags, ...args);
    };

    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);

    assert.notEqual(stagingRoot, null);
    assert.equal(cleanupArmed, true);
    assert.notEqual(replacementRoot, null);
    assert.equal(result.error, 'package_cleanup_failed');
    assertFailedPackageHasNoSideEffects(stored, outputDir, before);
    assert.equal(fs.lstatSync(replacementRoot).isDirectory(), true);
    assert.equal(fs.lstatSync(retainedRoot).isDirectory(), true);
    assert.deepEqual(fs.readdirSync(replacementRoot), []);
    assert.deepEqual(fs.readdirSync(retainedRoot), []);
  } finally {
    fs.openSync = originalOpenSync;
    fs.renameSync = originalRenameSync;
    setUtilityProcessHandler(null);
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.FLAT);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

async function assertCleanupAncestorSubstitutionFailsClosed(target) {
  const tmpRoot = makeTempDir();
  const originalReaddirSync = fs.readdirSync;
  try {
    const project = await createProject(`Organized ${target} Cleanup Race`);
    const sourcePath = path.join(tmpRoot, 'Reviewed.ai');
    const outputDir = path.join(tmpRoot, 'out');
    const outsidePath = path.join(tmpRoot, 'outside');
    fs.mkdirSync(outputDir);
    fs.mkdirSync(outsidePath);
    fs.writeFileSync(sourcePath, `${target} cleanup source bytes`);
    fs.writeFileSync(path.join(outsidePath, 'sentinel.txt'), `${target} cleanup sentinel`);
    await setProjectFiles(project.id, { files: [{
      path: sourcePath, name: 'Reviewed.ai', ext: '.ai', addedAt: Date.now(), source: 'manual-browse',
    }] });
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION);
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    const before = capturePackageSideEffects(stored);
    let stagingRoot = null;
    let stagingEnumerations = 0;
    let failureInjected = false;
    let cleanupSubstituted = false;
    let movedPath = null;

    setUtilityProcessHandler(({ phase, message }) => {
      if (phase !== 'message' || message.type !== 'write-start' || stagingRoot) return;
      stagingRoot = findPrivateStagedPackageRoot(outputDir);
    });
    fs.readdirSync = function injectFailureAfterGroupFinalization(candidatePath, ...args) {
      if (stagingRoot && path.resolve(candidatePath) === path.resolve(stagingRoot)) {
        stagingEnumerations++;
        if (stagingEnumerations === 2) {
          fs.writeFileSync(path.join(stagingRoot, 'unexpected.bin'), 'force final verification failure');
          failureInjected = true;
        }
      }
      return originalReaddirSync.call(fs, candidatePath, ...args);
    };
    const captureWriter = utilityProcessHandler;
    setUtilityProcessHandler(request => {
      captureWriter(request);
      const { phase, message, options } = request;
      if (
        cleanupSubstituted ||
        phase !== 'message' ||
        message.type !== 'cleanup'
      ) return;
      const currentGroupPath = stagingRoot ? path.join(stagingRoot, 'AI') : null;
      const isGroupCleanup = !!currentGroupPath && fs.existsSync(currentGroupPath);
      const isRootCleanup = path.basename(options.cwd).startsWith('.crate-package-staging-');
      if ((target === 'group' && !isGroupCleanup) || (target === 'staging root' && !isRootCleanup)) return;
      const targetPath = target === 'group' ? currentGroupPath : options.cwd;
      movedPath = path.join(
        tmpRoot,
        target === 'group' ? '.crate-package-group-cleanup-race' : '.crate-package-staging-cleanup-race'
      );
      fs.renameSync(targetPath, movedPath);
      fs.symlinkSync(outsidePath, targetPath, 'dir');
      cleanupSubstituted = true;
    });

    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);

    assert.equal(failureInjected, true);
    assert.equal(cleanupSubstituted, true);
    assert.equal(result.error, 'package_cleanup_failed');
    assertFailedPackageHasNoSideEffects(stored, outputDir, before);
    assert.deepEqual(fs.readdirSync(outsidePath), ['sentinel.txt']);
    assert.equal(fs.readFileSync(path.join(outsidePath, 'sentinel.txt'), 'utf8'), `${target} cleanup sentinel`);
    assert.equal(fs.existsSync(movedPath), true);
  } finally {
    fs.readdirSync = originalReaddirSync;
    setUtilityProcessHandler(null);
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.FLAT);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

test('organized finalized-group cleanup refuses an ancestor substitution before recursive removal', async () => {
  await assertCleanupAncestorSubstitutionFailsClosed('group');
});

test('organized staging-root cleanup refuses an ancestor substitution before recursive removal', async () => {
  await assertCleanupAncestorSubstitutionFailsClosed('staging root');
});

test('organized group constructor cleanup refuses an unprovable ancestor substitution', async () => {
  const tmpRoot = makeTempDir();
  const originalOpenSync = fs.openSync;
  try {
    const project = await createProject('Organized Group Constructor Cleanup Race');
    const sourcePath = path.join(tmpRoot, 'Reviewed.ai');
    const outputDir = path.join(tmpRoot, 'out');
    const outsidePath = path.join(tmpRoot, 'outside');
    const retentionRoot = path.join(tmpRoot, 'retained');
    const retainedGroupPath = path.join(retentionRoot, '.crate-package-group-constructor-retained');
    fs.mkdirSync(outputDir);
    fs.mkdirSync(outsidePath);
    fs.chmodSync(outsidePath, 0o755);
    fs.mkdirSync(retentionRoot);
    fs.writeFileSync(sourcePath, 'constructor cleanup source bytes');
    fs.writeFileSync(path.join(outsidePath, 'sentinel.txt'), 'constructor cleanup sentinel');
    await setProjectFiles(project.id, { files: [{
      path: sourcePath, name: 'Reviewed.ai', ext: '.ai', addedAt: Date.now(), source: 'manual-browse',
    }] });
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION);
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    const before = capturePackageSideEffects(stored);
    let substituted = false;

    const outsideMode = fs.statSync(outsidePath).mode & 0o777;
    fs.openSync = function substituteGroupBeforeConstructorValidation(candidatePath, ...args) {
      if (!substituted && path.basename(candidatePath).startsWith('.crate-package-group-')) {
        fs.renameSync(candidatePath, retainedGroupPath);
        fs.symlinkSync(outsidePath, candidatePath, 'dir');
        substituted = true;
      }
      return originalOpenSync.call(fs, candidatePath, ...args);
    };

    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);

    assert.equal(substituted, true);
    assert.equal(result.error, 'package_cleanup_failed');
    assertFailedPackageHasNoSideEffects(stored, outputDir, before);
    assert.deepEqual(fs.readdirSync(outsidePath), ['sentinel.txt']);
    assert.equal(fs.readFileSync(path.join(outsidePath, 'sentinel.txt'), 'utf8'), 'constructor cleanup sentinel');
    assert.equal(fs.statSync(outsidePath).mode & 0o777, outsideMode);
    assert.equal(fs.existsSync(retainedGroupPath), true);
    assert.equal(
      fs.readdirSync(outputDir).some(name => name.startsWith('.crate-package-group-')),
      false
    );
  } finally {
    fs.openSync = originalOpenSync;
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.FLAT);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('organized directory ownership compares above-safe-integer inode identities exactly', async () => {
  const tmpRoot = makeTempDir();
  const originalLstatSync = fs.lstatSync;
  const firstIno = 9007199254740992n;
  const secondIno = 9007199254740993n;
  let bigintReads = 0;
  let numberReads = 0;
  let legacyNumberCreationSeen = false;
  const withIno = (stat, ino) => new Proxy(stat, {
    get(target, property) {
      if (property === 'ino') return ino;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    assert.notEqual(firstIno, secondIno);
    assert.equal(Number(firstIno), Number(secondIno));
    const project = await createProject('Organized Exact Directory Identity');
    const sourcePath = path.join(tmpRoot, 'Reviewed.ai');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, 'exact directory identity bytes');
    await setProjectFiles(project.id, { files: [{
      path: sourcePath, name: 'Reviewed.ai', ext: '.ai', addedAt: Date.now(), source: 'manual-browse',
    }] });
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION);
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    const before = capturePackageSideEffects(stored);

    fs.lstatSync = function substituteRoundedGroupIdentity(candidatePath, options, ...args) {
      const stat = originalLstatSync.call(fs, candidatePath, options, ...args);
      if (!path.basename(`${candidatePath}`).startsWith('.crate-package-group-')) return stat;
      if (options?.bigint === true) {
        if (legacyNumberCreationSeen) return stat;
        bigintReads++;
        return withIno(stat, bigintReads === 1 ? firstIno : secondIno);
      }
      if (!/getOrCreateGroup|privatePackageDirectoryMatches|isOriginal/.test(new Error().stack || '')) return stat;
      legacyNumberCreationSeen = true;
      numberReads++;
      return withIno(stat, Number(numberReads === 1 ? firstIno : secondIno));
    };

    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);

    assert.equal(numberReads, 0, 'package directory ownership must never use rounded Number identities');
    assert.equal(bigintReads >= 2, true);
    assert.equal(result.error, 'package_cleanup_failed');
    assertFailedPackageHasNoSideEffects(stored, outputDir, before);
  } finally {
    fs.lstatSync = originalLstatSync;
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.FLAT);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('final verification cleans staging when the selected root moves outside its original parent', async () => {
  const tmpRoot = makeTempDir();
  const originalPromisesOpen = fs.promises.open;
  const originalOpenSync = fs.openSync;
  const originalCloseSync = fs.closeSync;
  let stagingRoot = null;
  let stagingMode = null;
  let finalRootFd = null;
  let stagingRootOpenCount = 0;
  let hookReached = false;
  try {
    const project = await createProject('Final output root move');
    const sourcePath = path.join(tmpRoot, 'Reviewed.ai');
    const outputParent = path.join(tmpRoot, 'selected-parent');
    const outputDir = path.join(outputParent, 'out');
    const movedParent = path.join(tmpRoot, 'relocated-parent');
    const movedRoot = path.join(movedParent, 'moved-output-root');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(movedParent);
    fs.writeFileSync(sourcePath, 'final root move bytes');
    const stored = await setProjectFiles(project.id, { files: [{
      path: sourcePath,
      name: 'Reviewed.ai',
      ext: '.ai',
      addedAt: Date.now(),
      source: 'manual-browse',
    }] });
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    const before = capturePackageSideEffects(stored);

    fs.promises.open = async function captureStagedDestination(candidatePath, flags, ...args) {
      const handle = await originalPromisesOpen.call(fs.promises, candidatePath, flags, ...args);
      if (flags === 'wx' && isExpectedStagedPackageWrite(candidatePath, outputDir, 'Reviewed.ai')) {
        stagingRoot = getPrivateStagedPackageRoot(candidatePath, outputDir);
        stagingMode = fs.statSync(stagingRoot).mode & 0o777;
      }
      return handle;
    };
    fs.openSync = function captureFinalStagedRootFd(candidatePath, ...args) {
      const fd = originalOpenSync.call(fs, candidatePath, ...args);
      if (stagingRoot && typeof candidatePath === 'string' && path.resolve(candidatePath) === path.resolve(stagingRoot)) {
        stagingRootOpenCount++;
        if (stagingRootOpenCount === 2) finalRootFd = fd;
      }
      return fd;
    };
    fs.closeSync = function swapRootAfterFinalVerification(fd, ...args) {
      const result = originalCloseSync.call(fs, fd, ...args);
      if (!hookReached && fd === finalRootFd) {
        hookReached = true;
        fs.renameSync(outputDir, movedRoot);
        fs.mkdirSync(outputDir);
      }
      return result;
    };

    testRendererEvents.length = 0;
    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);
    fs.promises.open = originalPromisesOpen;
    fs.openSync = originalOpenSync;
    fs.closeSync = originalCloseSync;

    assert.equal(hookReached, true);
    assert.deepEqual(result, { error: 'package_output_changed' });
    assert.equal(path.dirname(stagingRoot), outputParent);
    assert.equal(stagingMode, 0o700);
    assert.equal(fs.existsSync(packageFolder(outputDir, project.name)), false);
    assert.equal(fs.existsSync(packageFolder(movedRoot, project.name)), false);
    assertNoPrivatePackageStaging(outputDir, stagingRoot);
    assert.equal(fs.readdirSync(movedRoot).some(name => name.startsWith('.crate-package-staging-')), false);
    assert.equal(fs.readdirSync(movedParent).some(name => name.startsWith('.crate-package-staging-')), false);
    assert.deepEqual(capturePackageSideEffects(stored), before);
    assert.equal(testRendererEvents.some(entry => entry.channel === 'project:updated'), false);
  } finally {
    fs.promises.open = originalPromisesOpen;
    fs.openSync = originalOpenSync;
    fs.closeSync = originalCloseSync;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('nested output roots fail closed instead of falling back to movable in-root staging', async () => {
  const tmpRoot = makeTempDir();
  const originalMkdtempSync = fs.mkdtempSync;
  let inRootFallbackAttempted = false;
  try {
    const project = await createProject('No movable staging fallback');
    const sourcePath = path.join(tmpRoot, 'Reviewed.ai');
    const outputParent = path.join(tmpRoot, 'selected-parent');
    const outputDir = path.join(outputParent, 'out');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(sourcePath, 'reviewed bytes');
    const stored = await setProjectFiles(project.id, { files: [{
      path: sourcePath,
      name: 'Reviewed.ai',
      ext: '.ai',
      addedAt: Date.now(),
      source: 'manual-browse',
    }] });
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    const before = capturePackageSideEffects(stored);

    fs.mkdtempSync = function rejectSiblingStaging(prefix, ...args) {
      const stagingParent = path.dirname(prefix);
      if (path.resolve(stagingParent) === path.resolve(outputParent)) {
        const error = new Error('sibling staging denied');
        error.code = 'EACCES';
        throw error;
      }
      if (path.resolve(stagingParent) === path.resolve(outputDir)) {
        inRootFallbackAttempted = true;
      }
      return originalMkdtempSync.call(fs, prefix, ...args);
    };

    testRendererEvents.length = 0;
    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);

    assert.deepEqual(result, { error: 'EACCES' });
    assert.equal(inRootFallbackAttempted, false);
    assert.deepEqual(fs.readdirSync(outputDir), []);
    assert.equal(fs.readdirSync(outputParent).some(name => name.startsWith('.crate-package-staging-')), false);
    assert.deepEqual(capturePackageSideEffects(stored), before);
    assert.equal(testRendererEvents.some(entry => entry.channel === 'project:updated'), false);
  } finally {
    fs.mkdtempSync = originalMkdtempSync;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('final verification locates and cleans staging after its parent is renamed', async () => {
  const tmpRoot = makeTempDir();
  const originalPromisesOpen = fs.promises.open;
  const originalOpenSync = fs.openSync;
  const originalCloseSync = fs.closeSync;
  let stagingRoot = null;
  let finalRootFd = null;
  let stagingRootOpenCount = 0;
  let hookReached = false;
  try {
    const project = await createProject('Final staging parent move');
    const sourcePath = path.join(tmpRoot, 'Reviewed.ai');
    const outputParent = path.join(tmpRoot, 'selected-parent');
    const outputDir = path.join(outputParent, 'out');
    const movedParent = path.join(tmpRoot, 'moved-selected-parent');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(sourcePath, 'staging parent move bytes');
    const stored = await setProjectFiles(project.id, { files: [{
      path: sourcePath,
      name: 'Reviewed.ai',
      ext: '.ai',
      addedAt: Date.now(),
      source: 'manual-browse',
    }] });
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    const before = capturePackageSideEffects(stored);

    fs.promises.open = async function captureStagedDestination(candidatePath, flags, ...args) {
      const handle = await originalPromisesOpen.call(fs.promises, candidatePath, flags, ...args);
      if (flags === 'wx' && isExpectedStagedPackageWrite(candidatePath, outputDir, 'Reviewed.ai')) {
        stagingRoot = getPrivateStagedPackageRoot(candidatePath, outputDir);
      }
      return handle;
    };
    fs.openSync = function captureFinalStagedRootFd(candidatePath, ...args) {
      const fd = originalOpenSync.call(fs, candidatePath, ...args);
      if (stagingRoot && typeof candidatePath === 'string' && path.resolve(candidatePath) === path.resolve(stagingRoot)) {
        stagingRootOpenCount++;
        if (stagingRootOpenCount === 2) finalRootFd = fd;
      }
      return fd;
    };
    fs.closeSync = function moveStagingParentAfterFinalVerification(fd, ...args) {
      const result = originalCloseSync.call(fs, fd, ...args);
      if (!hookReached && fd === finalRootFd) {
        hookReached = true;
        fs.renameSync(outputParent, movedParent);
        fs.mkdirSync(outputDir, { recursive: true });
      }
      return result;
    };

    testRendererEvents.length = 0;
    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);
    fs.promises.open = originalPromisesOpen;
    fs.openSync = originalOpenSync;
    fs.closeSync = originalCloseSync;

    assert.equal(hookReached, true);
    assert.deepEqual(result, { error: 'package_output_changed' });
    assert.equal(fs.existsSync(stagingRoot), false);
    assert.equal(fs.readdirSync(movedParent).some(name => name.startsWith('.crate-package-staging-')), false);
    assert.equal(fs.existsSync(packageFolder(outputDir, project.name)), false);
    assert.equal(fs.existsSync(packageFolder(path.join(movedParent, 'out'), project.name)), false);
    assert.deepEqual(capturePackageSideEffects(stored), before);
    assert.equal(testRendererEvents.some(entry => entry.channel === 'project:updated'), false);
  } finally {
    fs.promises.open = originalPromisesOpen;
    fs.openSync = originalOpenSync;
    fs.closeSync = originalCloseSync;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

async function assertLateStagingInputChangeRefreshes(scenario, mutate, verifyReview) {
  const tmpRoot = makeTempDir();
  const originalOpen = fs.promises.open;
  let releaseWrite = () => {};
  try {
    const project = await createProject(`Late staging ${scenario}`);
    const sourcePath = path.join(tmpRoot, 'Reviewed.ai');
    const addedPath = path.join(tmpRoot, 'Added.png');
    const parentPsd = path.join(tmpRoot, 'Deferred.psd');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, 'reviewed source bytes');
    fs.writeFileSync(addedPath, 'added source bytes');
    fs.writeFileSync(parentPsd, 'reviewed PSD bytes');
    currentPsdFixture = {
      children: [],
      linkedFiles: [{ name: 'Deferred.png', data: Buffer.from('deferred embedded bytes') }],
    };
    storeInstance.set('settings.includeDiagnosticReport', false);
    const stored = await setProjectFiles(project.id, { files: [
      { path: sourcePath, name: 'Reviewed.ai', ext: '.ai', addedAt: Date.now(), source: 'manual-browse' },
      {
        path: parentPsd,
        parentPsd,
        name: 'Deferred.png',
        ext: '.png',
        addedAt: Date.now(),
        source: 'scan-on-save-embedded',
        embedded: true,
        embeddedOriginalName: 'Deferred.png',
        embeddedIndex: 0,
        fileId: `late-${scenario}`,
      },
    ] });
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(typeof review.token, 'string');
    const before = capturePackageSideEffects(stored);

    let deferred = true;
    let markWriteStarted;
    const writeStarted = new Promise(resolve => { markWriteStarted = resolve; });
    const writeGate = new Promise(resolve => { releaseWrite = resolve; });
    fs.promises.open = async function deferredPsdWrite(filePath, flags, ...args) {
      const handle = await originalOpen.call(fs.promises, filePath, flags, ...args);
      if (deferred && flags === 'wx' && isExpectedStagedPackageWrite(filePath, outputDir, 'Deferred.png')) {
        const originalHandleWriteFile = handle.writeFile.bind(handle);
        handle.writeFile = async (...writeArgs) => {
          deferred = false;
          const result = await originalHandleWriteFile(...writeArgs);
          markWriteStarted();
          await writeGate;
          return result;
        };
      }
      return handle;
    };

    const packagePromise = callIpcRaw('projects:package', project.id, outputDir, review.token);
    await writeStarted;
    await mutate({ stored, sourcePath, addedPath });
    releaseWrite();
    const result = await packagePromise;

    assert.equal(result.error, 'package_review_changed');
    assert.ok(result.review);
    verifyReview(result.review);
    assertFailedPackageHasNoSideEffects(stored, outputDir, before);
    assert.equal(
      fs.readdirSync(tmpRoot).some(name => name.startsWith('.crate-package-staging-')),
      false
    );
  } finally {
    storeInstance.set('settings.includeDiagnosticReport', false);
    storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.FLAT);
    fs.promises.open = originalOpen;
    releaseWrite();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

test('membership mutation during slow staging refreshes review and leaves no output', async () => {
  await assertLateStagingInputChangeRefreshes(
    'membership',
    ({ stored, addedPath }) => {
      stored.files.push({
        path: addedPath,
        name: 'Added.png',
        ext: '.png',
        addedAt: Date.now(),
        source: 'manual-browse',
      });
    },
    review => {
      assert.equal(review.materializable, true);
      assert.equal(review.totalFiles, 3);
      assert.equal(typeof review.token, 'string');
    }
  );
});

test('diagnostics setting mutation during slow staging refreshes review and leaves no output', async () => {
  await assertLateStagingInputChangeRefreshes(
    'settings',
    () => storeInstance.set('settings.includeDiagnosticReport', true),
    review => {
      assert.equal(review.materializable, true);
      assert.equal(review.planSummary.diagnosticsMetadataIncluded, true);
      assert.equal(typeof review.token, 'string');
    }
  );
});

test('layout setting mutation during slow staging refreshes review and removes staging', async () => {
  await assertLateStagingInputChangeRefreshes(
    'layout-settings',
    () => storeInstance.set('settings.packageOutputLayoutMode', PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION),
    review => {
      assert.equal(review.materializable, true);
      assert.equal(typeof review.token, 'string');
    }
  );
});

test('reviewed source bytes changing after copy during slow staging refreshes review', async () => {
  await assertLateStagingInputChangeRefreshes(
    'source-bytes',
    ({ sourcePath }) => fs.writeFileSync(sourcePath, 'changed source bytes after staged copy'),
    review => {
      assert.equal(review.materializable, true);
      assert.equal(review.totalFiles, 2);
      assert.equal(typeof review.token, 'string');
    }
  );
});

test('source changing during open-handle copy removes staging and fails closed', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Source Copy Race');
    const sourcePath = path.join(tmpRoot, 'Race.ai');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, Buffer.alloc(2 * 1024 * 1024, 0x61));
    const stored = await setProjectFiles(project.id, { files: [{
      path: sourcePath, name: 'Race.ai', ext: '.ai', addedAt: Date.now(), source: 'manual-browse'
    }] });
    const before = capturePackageSideEffects(stored);
    const result = await packageWithSourceMutation({
      project, sourcePath, outputDir,
      mutate: () => fs.writeFileSync(sourcePath, Buffer.alloc(2 * 1024 * 1024, 0x62)),
    });
    assert.equal(result.error, 'package_review_changed');
    assert.equal(result.review.totalFiles, 1);
    assertFailedPackageHasNoSideEffects(stored, outputDir, before);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('reviewed file disappearing after an earlier staged copy removes all partial output', async () => {
  const tmpRoot = makeTempDir();
  const originalOpen = fs.promises.open;
  try {
    const project = await createProject('Missing During Copy');
    const firstPath = path.join(tmpRoot, 'First.ai');
    const missingPath = path.join(tmpRoot, 'Missing.png');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(firstPath, 'first reviewed bytes');
    fs.writeFileSync(missingPath, 'second reviewed bytes');
    const stored = await setProjectFiles(project.id, { files: [firstPath, missingPath].map(filePath => ({
      path: filePath, name: path.basename(filePath), ext: path.extname(filePath), addedAt: Date.now(), source: 'manual-browse'
    })) });
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    const before = capturePackageSideEffects(stored);
    let removed = false;
    fs.promises.open = async function removeBeforeSecondDestinationOpen(candidatePath, flags, ...args) {
      if (!removed && flags === 'wx' && isExpectedStagedPackageWrite(candidatePath, outputDir, 'Missing.png')) {
        removed = true;
        fs.unlinkSync(missingPath);
      }
      return originalOpen.call(fs.promises, candidatePath, flags, ...args);
    };
    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);
    assert.equal(result.error, 'package_review_changed');
    assertFailedPackageHasNoSideEffects(stored, outputDir, before);
  } finally {
    fs.promises.open = originalOpen;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('PSD parent mutation during reviewed handle read removes staging and fails closed', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('PSD Parent Race');
    const parentPsd = path.join(tmpRoot, 'Parent.psd');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(parentPsd, 'reviewed parent bytes');
    currentPsdFixture = { children: [], linkedFiles: [{ name: 'Embedded.png', data: Buffer.from('embedded') }] };
    const stored = await setProjectFiles(project.id, { files: [{
      path: parentPsd, parentPsd, name: 'Embedded.png', ext: '.png', source: 'scan-on-save-embedded',
      embedded: true, embeddedOriginalName: 'Embedded.png', embeddedIndex: 0, fileId: 'psd-race'
    }] });
    const before = capturePackageSideEffects(stored);
    const result = await packageWithSourceMutation({
      project, sourcePath: parentPsd, outputDir,
      mutate: () => fs.writeFileSync(parentPsd, 'changed! parent bytes'),
    });
    assert.equal(result.error, 'package_review_changed');
    assertFailedPackageHasNoSideEffects(stored, outputDir, before);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('presentation container mutation during reviewed copy removes staging and skips staged extraction', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Presentation Container Race');
    const deckPath = path.join(tmpRoot, 'Deck.pptx');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(deckPath, Buffer.alloc(2 * 1024 * 1024, 0x31));
    const stored = await setProjectFiles(project.id, { files: [{
      path: deckPath, name: 'Deck.pptx', ext: '.pptx', addedAt: Date.now(), source: 'manual-browse'
    }] });
    let stagedUnzipCalls = 0;
    setChildProcessHandler(request => {
      if (
        request.command === '/usr/bin/unzip' &&
        typeof request.args[1] === 'string' &&
        !!getPrivateStagedPackageRoot(request.args[1], outputDir)
      ) stagedUnzipCalls++;
      return { stdout: '' };
    });
    const before = capturePackageSideEffects(stored);
    const result = await packageWithSourceMutation({
      project, sourcePath: deckPath, outputDir,
      mutate: () => fs.writeFileSync(deckPath, Buffer.alloc(2 * 1024 * 1024, 0x32)),
    });
    assert.equal(result.error, 'package_review_changed');
    assert.equal(stagedUnzipCalls, 0);
    assertFailedPackageHasNoSideEffects(stored, outputDir, before);
  } finally {
    setChildProcessHandler(null);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('metadata failure restores the exact prior Figma transfer block without project side effects', async () => {
  resetTestHomeWorkspace();
  const candidatePath = path.join(TEST_HOME, 'Desktop', 'figma-block-metadata-failure.ai');
  fs.writeFileSync(candidatePath, 'candidate');
  const project = await createProject('Figma Block Metadata Failure');
  const priorBlock = 'seeded-prior-figma-transfer-block';
  metadataTestHooks.setFigmaPackageTransferBlock(project.id, priorBlock);
  const beforeBlock = metadataTestHooks.getFigmaPackageTransferBlock(project.id);
  const beforeProject = JSON.stringify(await getProject(project.id));
  const beforeQuota = storeInstance.get('usage.packagesThisMonth');
  const beforeWatcherCount = watcherRecords.length;
  const beforeWatcherCloseCount = watcherCloseCount;
  const beforeRendererEventCount = testRendererEvents.length;

  try {
    setChildProcessHandler(request => {
      if (bulkXattrPaths(request).length) {
        return { error: Object.assign(new Error('xattr failed'), { code: 'EIO', stderr: 'abnormal failure' }) };
      }
      if (isBulkSpotlightRequest(request)) return { stdout: Buffer.alloc(0) };
      return { stdout: '' };
    });

    const scan = await callIpcRaw('projects:pre-package-scan', project.id);
    assert.equal(scan.error, 'package_scan_incomplete');
    assert.equal(scan.diagnostics.failurePhase, 'pre-package-discovery');
    assert.deepEqual(metadataTestHooks.getFigmaPackageTransferBlock(project.id), beforeBlock);
    assert.equal(JSON.stringify(await getProject(project.id)), beforeProject);
    assert.equal(storeInstance.get('usage.packagesThisMonth'), beforeQuota);
    assert.equal(watcherRecords.length, beforeWatcherCount);
    assert.equal(watcherCloseCount, beforeWatcherCloseCount);
    assert.equal(testRendererEvents.length, beforeRendererEventCount);
  } finally {
    setChildProcessHandler(null);
    await callIpcRaw('projects:delete', project.id);
    fs.rmSync(candidatePath, { force: true });
  }
});

test('Spotlight alias routes cannot match an enumerated physical candidate', () => {
  const targetPath = path.join(TEST_HOME, 'Desktop', 'routes', 'target.ai');
  const aliasPath = path.join(TEST_HOME, 'Desktop', 'routes', 'target-alias.ai');
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, 'target');
  fs.symlinkSync(targetPath, aliasPath);
  try {
    assert.equal(fs.realpathSync(aliasPath), fs.realpathSync(targetPath));
    assert.deepEqual(
      metadataTestHooks.matchSpotlightCandidateRoutes([aliasPath], [{ fullPath: targetPath }]),
      []
    );
  } finally {
    fs.rmSync(aliasPath, { force: true });
    fs.rmSync(targetPath, { force: true });
  }
});

test('Spotlight case-colliding routes remain one-to-one', () => {
  const upperPath = path.join(TEST_HOME, 'Desktop', 'case-routes', 'Case.ai');
  const lowerPath = path.join(TEST_HOME, 'Desktop', 'case-routes', 'case.ai');
  const candidates = [{ fullPath: upperPath }, { fullPath: lowerPath }];
  assert.deepEqual(
    metadataTestHooks.matchSpotlightCandidateRoutes([lowerPath], candidates),
    [lowerPath]
  );
});

test('Spotlight Unicode-colliding routes remain one-to-one', () => {
  const asciiPath = path.join(TEST_HOME, 'Desktop', 'unicode-routes', 'K.ai');
  const kelvinPath = path.join(TEST_HOME, 'Desktop', 'unicode-routes', '\u212A.ai');
  const candidates = [{ fullPath: asciiPath }, { fullPath: kelvinPath }];
  assert.deepEqual(
    metadataTestHooks.matchSpotlightCandidateRoutes([kelvinPath], candidates),
    [kelvinPath]
  );
});

test('Spotlight route matching is order-independent and ignores ambiguous candidate records', () => {
  const alphaPath = path.join(TEST_HOME, 'Desktop', 'ordered-routes', 'alpha.ai');
  const betaPath = path.join(TEST_HOME, 'Desktop', 'ordered-routes', 'beta.ai');
  const candidates = [{ fullPath: betaPath }, { fullPath: alphaPath }];
  const forward = metadataTestHooks.matchSpotlightCandidateRoutes([alphaPath, betaPath], candidates);
  const reverse = metadataTestHooks.matchSpotlightCandidateRoutes([betaPath, alphaPath], candidates);
  assert.deepEqual(reverse, forward);
  assert.deepEqual(forward, [alphaPath, betaPath]);
  assert.deepEqual(
    metadataTestHooks.matchSpotlightCandidateRoutes(
      [alphaPath],
      [{ fullPath: alphaPath }, { fullPath: alphaPath }]
    ),
    []
  );
});

test('bounded metadata acquires 1668 candidates while background observers pause and resume', async () => {
  resetTestHomeWorkspace();
  const candidateRoot = path.join(TEST_HOME, 'Desktop', 'bulk-1668');
  fs.mkdirSync(candidateRoot, { recursive: true });
  for (let index = 0; index < 1668; index++) {
    fs.writeFileSync(path.join(candidateRoot, `candidate-${String(index).padStart(4, '0')}.ai`), 'fixture');
  }
  const project = await createProject('Bulk 1668');
  const before = JSON.stringify(await getProject(project.id));
  const staleXattr = encodeLastUsedXattr(Date.now() - 86400000);
  let xattrCalls = 0;
  let xattrCandidates = 0;
  let activeXattrCalls = 0;
  let maxActiveXattrCalls = 0;
  let spotlightCalls = 0;
  let mdlsCalls = 0;
  let releaseXattrCalls;
  let markXattrStarted;
  let xattrStarted = false;
  const xattrRelease = new Promise(resolve => {
    releaseXattrCalls = resolve;
  });
  const firstXattrStarted = new Promise(resolve => {
    markXattrStarted = resolve;
  });
  let scanPromise = null;
  let scanSettled = false;

  try {
    setChildProcessHandler(request => {
      const paths = bulkXattrPaths(request);
      if (paths.length) {
        xattrCalls++;
        xattrCandidates += paths.length;
        activeXattrCalls++;
        maxActiveXattrCalls = Math.max(maxActiveXattrCalls, activeXattrCalls);
        assert.ok(paths.length <= 256);
        assert.equal(request.options.timeout, 2000);
        if (!xattrStarted) {
          xattrStarted = true;
          markXattrStarted();
        }
        return xattrRelease.then(() => new Promise(resolve => setImmediate(() => {
          activeXattrCalls--;
          resolve({ stdout: formatBulkXattrOutput(paths, () => staleXattr) });
        })));
      }
      if (isBulkSpotlightRequest(request)) {
        spotlightCalls++;
        assert.equal(request.options.timeout, 4000);
        assert.equal(request.options.encoding, 'buffer');
        return { stdout: Buffer.alloc(0) };
      }
      if (request.kind === 'execFile' && request.command === '/usr/bin/mdls') mdlsCalls++;
      return { stdout: '' };
    });

    scanPromise = callIpcRaw('projects:pre-package-scan', project.id).finally(() => {
      scanSettled = true;
    });
    const xattrStartResult = await Promise.race([
      firstXattrStarted.then(() => 'xattr-started'),
      scanPromise.then(() => 'scan-settled')
    ]);
    assert.equal(xattrStartResult, 'xattr-started', 'metadata scan settled before xattr work started');
    await new Promise(resolve => originalSetTimeout(resolve, 750));
    const duringScan = await getProject(project.id);
    assert.equal(scanSettled, false);
    assert.deepEqual(
      duringScan.liveAppEvidenceStatus,
      JSON.parse(before).liveAppEvidenceStatus,
      'background observer state must remain unchanged while package discovery owns the coordinator'
    );
    releaseXattrCalls();
    const scan = await scanPromise;
    assert.equal(scan.error, undefined);
    assert.equal(xattrCalls, 7);
    assert.equal(xattrCandidates, 1668);
    assert.equal(maxActiveXattrCalls, 4);
    assert.equal(spotlightCalls, expectedBulkSpotlightRoots().length);
    assert.equal(mdlsCalls, 0);
    await runTrackedIntervalCallbacks(1);
    const afterResume = await waitForProject(
      project.id,
      item => ['illustrator', 'photoshop', 'indesign'].every(appFamily => (
        getLiveAppStatusEntries(item, appFamily).some(entry => (
          entry.pollFired === true &&
          entry.appRunning === false &&
          entry.errorCategory === 'app-not-running'
        ))
      )),
      5000
    );
    const after = await getProject(project.id);
    const { liveAppEvidenceStatus: beforeLiveStatus, ...beforeStableState } = JSON.parse(before);
    const { liveAppEvidenceStatus: afterLiveStatus, ...afterStableState } = after;
    assert.deepEqual(afterStableState, beforeStableState);
    assert.notDeepEqual(afterLiveStatus, beforeLiveStatus);
    for (const appFamily of ['illustrator', 'photoshop', 'indesign']) {
      assert.ok(getLiveAppStatusEntries(afterResume, appFamily).some(entry => (
        entry.pollFired === true &&
        entry.appRunning === false &&
        entry.errorCategory === 'app-not-running'
      )));
    }
  } finally {
    releaseXattrCalls();
    if (scanPromise) await scanPromise.catch(() => {});
    setChildProcessHandler(null);
    fs.rmSync(candidateRoot, { recursive: true, force: true });
  }
});

test('pre-package drain timeout latches incomplete while an lsof child parser remains active', async () => {
  resetTestHomeWorkspace();
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'coordinated-parser.ai');
  const outputRoot = makeTempDir();
  fs.writeFileSync(sourcePath, '%PDF-1.7\nsynthetic fixture\n%%EOF\n');
  let pollEnabled = false;
  let releaseSourceRead = () => {};
  let markSourceReadStarted = () => {};
  const sourceReadGate = new Promise(resolve => { releaseSourceRead = resolve; });
  const sourceReadStarted = new Promise(resolve => { markSourceReadStarted = resolve; });
  const realReadFile = fs.promises.readFile;
  const trackedSetTimeout = global.setTimeout;
  let pollPromise = null;

  try {
    setChildProcessHandler(({ kind, command }) => {
      if (kind === 'exec' && command.startsWith('/bin/ps ax')) {
        return { stdout: pollEnabled ? '222 /Applications/Figma.app/Contents/MacOS/Figma\n' : '' };
      }
      if (kind === 'exec' && command.startsWith('/usr/sbin/lsof')) {
        return { stdout: `p222\nf20\ntREG\nn${sourcePath}\n` };
      }
      return { stdout: '' };
    });

    const project = await createProject('Coordinated Parser Drain');
    await setProjectFiles(project.id, { files: [{
      path: sourcePath,
      name: path.basename(sourcePath),
      ext: '.ai',
      addedAt: Date.now(),
      source: 'manual-browse',
    }] });
    const initialReview = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(initialReview.materializable, true);

    fs.promises.readFile = async (...args) => {
      if (path.resolve(String(args[0])) === path.resolve(sourcePath)) {
        markSourceReadStarted();
        await sourceReadGate;
      }
      return realReadFile.apply(fs.promises, args);
    };
    pollEnabled = true;
    const activationToken = metadataTestHooks.getActiveWatchingActivationToken(project.id);
    pollPromise = metadataTestHooks.pollLsofForProject(project.id, activationToken);
    await sourceReadStarted;
    assert.equal(metadataTestHooks.isLsofPollInProgress(project.id), true);

    global.setTimeout = (fn, delay, ...args) => trackedSetTimeout(
      fn,
      delay === 15000 ? 0 : delay,
      ...args
    );
    const scan = await callIpcRaw('projects:pre-package-scan', project.id);
    assert.equal(scan.error, 'package_scan_incomplete');
    assert.equal(scan.diagnostics.failurePhase, 'background-watch-drain');
    assert.deepEqual(
      Object.keys(scan.diagnostics).sort(),
      ['candidateCount', 'failurePhase', 'metadataFallbackCount', 'phaseElapsedMs', 'xattrResolvedCount']
    );
    assert.equal((await callIpcRaw('projects:prepare-package-review', project.id)).error, 'package_scan_incomplete');
    assert.equal(
      (await callIpcRaw('projects:package', project.id, outputRoot, initialReview.token)).error,
      'package_review_stale'
    );

    releaseSourceRead();
    await pollPromise;
    pollPromise = null;
    assert.equal(metadataTestHooks.isLsofPollInProgress(project.id), false);
    await callIpcRaw('projects:delete', project.id);
  } finally {
    global.setTimeout = trackedSetTimeout;
    fs.promises.readFile = realReadFile;
    releaseSourceRead();
    if (pollPromise) await pollPromise;
    setChildProcessHandler(null);
    fs.rmSync(sourcePath, { force: true });
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('pre-package drain includes an initial lsof snapshot parser before recurring watchers start', async () => {
  resetTestHomeWorkspace();
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'initial-coordinated-parser.ai');
  const outputRoot = makeTempDir();
  fs.writeFileSync(sourcePath, '%PDF-1.7\nsynthetic initial snapshot fixture\n%%EOF\n');
  let snapshotEnabled = false;
  let releaseSourceRead = () => {};
  let markSourceReadStarted = () => {};
  const sourceReadGate = new Promise(resolve => { releaseSourceRead = resolve; });
  const sourceReadStarted = new Promise(resolve => { markSourceReadStarted = resolve; });
  const realReadFile = fs.promises.readFile;
  const trackedSetTimeout = global.setTimeout;
  let startPromise = null;

  try {
    const project = await createProject('Initial Coordinated Parser Drain');
    await callIpcRaw('projects:pause', project.id);
    await setProjectFiles(project.id, { files: [{
      path: sourcePath,
      name: path.basename(sourcePath),
      ext: '.ai',
      addedAt: Date.now(),
      source: 'manual-browse',
    }] });
    const initialReview = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(initialReview.materializable, true);

    setChildProcessHandler(({ kind, command, args }) => {
      if (
        snapshotEnabled &&
        kind === 'execFile' &&
        command === '/bin/ps' &&
        Array.isArray(args) &&
        args.join(' ') === 'ax -o pid= -o command='
      ) {
        return { stdout: '222 /Applications/Figma.app/Contents/MacOS/Figma\n' };
      }
      if (snapshotEnabled && kind === 'execFile' && command === '/usr/sbin/lsof') {
        return { stdout: `p222\nf20\ntREG\nn${sourcePath}\n` };
      }
      return { stdout: '' };
    });

    fs.promises.readFile = async (...args) => {
      if (path.resolve(String(args[0])) === path.resolve(sourcePath)) {
        markSourceReadStarted();
        await sourceReadGate;
      }
      return realReadFile.apply(fs.promises, args);
    };
    snapshotEnabled = true;
    startPromise = callIpcRaw('projects:start-watching', project.id);
    await sourceReadStarted;
    assert.equal(metadataTestHooks.getWatcherCoordinatorSnapshot(project.id).running, true);

    global.setTimeout = (fn, delay, ...args) => trackedSetTimeout(
      fn,
      delay === 15000 ? 0 : delay,
      ...args
    );
    const scan = await callIpcRaw('projects:pre-package-scan', project.id);
    assert.equal(scan.error, 'package_scan_incomplete');
    assert.equal(scan.diagnostics.failurePhase, 'background-watch-drain');
    assert.equal((await callIpcRaw('projects:prepare-package-review', project.id)).error, 'package_scan_incomplete');
    assert.equal(
      (await callIpcRaw('projects:package', project.id, outputRoot, initialReview.token)).error,
      'package_review_stale'
    );

    global.setTimeout = trackedSetTimeout;
    releaseSourceRead();
    await startPromise;
    startPromise = null;
    assert.equal(metadataTestHooks.getWatcherCoordinatorSnapshot(project.id).running, false);
    await callIpcRaw('projects:delete', project.id);
  } finally {
    global.setTimeout = trackedSetTimeout;
    fs.promises.readFile = realReadFile;
    releaseSourceRead();
    if (startPromise) await startPromise.catch(() => {});
    setChildProcessHandler(null);
    fs.rmSync(sourcePath, { force: true });
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('initial coordinated lsof parser adopts Illustrator scope and retains a valid linked asset', async () => {
  resetTestHomeWorkspace();
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'initial-linked-source.ai');
  const linkedPath = '/Users/CrateQA/initial-linked-asset.png';
  fs.writeFileSync(sourcePath, `%PDF-1.7\n${linkedPath}\n%%EOF\n`);
  const realAccess = fs.promises.access;

  try {
    const project = await createProject('Initial Linked Asset Contract');
    await callIpcRaw('projects:pause', project.id);
    await setProjectFiles(project.id, {
      files: [{
        path: sourcePath,
        name: path.basename(sourcePath),
        ext: '.ai',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
      preserveAwaitingAssetBaseline: true,
    });

    setChildProcessHandler(({ kind, command, args }) => {
      if (isIllustratorPgrepCheck({ kind, command, args })) return { stdout: '' };
      if (
        kind === 'execFile' &&
        command === '/bin/ps' &&
        Array.isArray(args) &&
        args.join(' ') === 'ax -o pid= -o command='
      ) {
        return { stdout: '222 /Applications/Adobe Illustrator 2026/Adobe Illustrator.app/Contents/MacOS/Adobe Illustrator\n' };
      }
      if (kind === 'execFile' && command === '/usr/sbin/lsof') {
        return { stdout: `p222\nf20\ntREG\nn${sourcePath}\n` };
      }
      return { stdout: '' };
    });
    fs.promises.access = async (...args) => {
      if (path.resolve(String(args[0])) === path.resolve(linkedPath)) return;
      return realAccess.apply(fs.promises, args);
    };

    const { output } = await captureConsoleDuring(() => (
      callIpcRaw('projects:start-watching', project.id)
    ));
    const fresh = await getProject(project.id);
    assert.equal(
      [...fresh.files, ...(fresh.pendingFiles || [])].some(file => (
        file.path === linkedPath && file.source === 'scan-on-open'
      )),
      true
    );
    assert.equal(fresh.assetBaseline.status, 'decision-required');
    assert.equal(Object.hasOwn(fresh.assetBaseline, 'failedRequiredSources'), false);
    assert.doesNotMatch(output, /scan-on-open: controlled failure/);
    await callIpcRaw('projects:delete', project.id);
  } finally {
    fs.promises.access = realAccess;
    setChildProcessHandler(null);
    fs.rmSync(sourcePath, { force: true });
  }
});

test('background watcher scheduler executes coalesced non-lsof observer kinds in bounded FIFO order', async () => {
  const projectId = 'synthetic-fair-watcher-scheduler';
  metadataTestHooks.activateWatcherCoordinator(projectId);
  const observed = [];
  let releaseLiveApp = () => {};
  const liveAppGate = new Promise(resolve => { releaseLiveApp = resolve; });

  try {
    const liveAppPromise = metadataTestHooks.runBackgroundWatcherOperation(projectId, 'live-app', async () => {
      observed.push('live-app');
      await liveAppGate;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(observed, ['live-app']);

    assert.equal(
      (await metadataTestHooks.runBackgroundWatcherOperation(projectId, 'figma', async () => {
        observed.push('figma-stale');
      })).reason,
      'coordinator-deferred'
    );
    await metadataTestHooks.runBackgroundWatcherOperation(projectId, 'last-used', async () => {
      observed.push('last-used');
    });
    await metadataTestHooks.runBackgroundWatcherOperation(projectId, 'figma', async () => {
      observed.push('figma');
    });

    assert.deepEqual(
      metadataTestHooks.getWatcherCoordinatorSnapshot(projectId).pendingKinds,
      ['figma', 'last-used']
    );
    releaseLiveApp();
    await liveAppPromise;
    await waitForCondition(
      () => observed.length === 3,
      'coalesced observer kinds did not receive bounded fair service'
    );
    assert.deepEqual(observed, ['live-app', 'figma', 'last-used']);
    assert.deepEqual(metadataTestHooks.getWatcherCoordinatorSnapshot(projectId).pendingKinds, []);
  } finally {
    releaseLiveApp();
    metadataTestHooks.cancelWatcherCoordinator(projectId);
  }
});

test('capture-critical lsof sampling is not deferred behind a slow live-app observer', async () => {
  resetTestHomeWorkspace();
  const projectDir = path.join(TEST_HOME, 'Desktop', 'lsof-contention-project');
  fs.mkdirSync(projectDir, { recursive: true });
  const sourcePath = path.join(projectDir, 'contention-source.fig');
  const shortLivedAssetPath = path.join(projectDir, 'contention-short-lived.png');
  fs.writeFileSync(sourcePath, 'synthetic source bytes');
  let pollEnabled = false;
  let releaseLiveApp = () => {};
  const liveAppGate = new Promise(resolve => { releaseLiveApp = resolve; });
  let liveAppPromise = null;

  try {
    setChildProcessHandler(({ kind, command }) => {
      if (kind === 'exec' && command.startsWith('/bin/ps ax')) {
        return {
          stdout: pollEnabled
            ? '222 /Applications/Figma.app/Contents/MacOS/Figma\n'
            : '',
        };
      }
      if (kind === 'exec' && command.startsWith('/usr/sbin/lsof')) {
        return {
          stdout: pollEnabled
            ? `p222\nf20\ntREG\nn${shortLivedAssetPath}\n`
            : '',
        };
      }
      return { stdout: '' };
    });

    const project = await createProject('Lsof contention capture');
    await setProjectFiles(project.id, { files: [{
      path: sourcePath,
      name: path.basename(sourcePath),
      ext: '.fig',
      addedAt: Date.now(),
      source: 'manual-browse',
    }] });
    fs.writeFileSync(shortLivedAssetPath, createSyntheticPngBytes());
    const observedAfterWatch = new Date(Date.now() + 1000);
    fs.utimesSync(shortLivedAssetPath, observedAfterWatch, observedAfterWatch);
    const activationToken = metadataTestHooks.getActiveWatchingActivationToken(project.id);
    liveAppPromise = metadataTestHooks.runBackgroundWatcherOperation(project.id, 'live-app', async () => {
      await liveAppGate;
    });
    await waitForCondition(
      () => metadataTestHooks.getWatcherCoordinatorSnapshot(project.id).runningKind === 'live-app',
      'live-app contention fixture did not occupy the background lane'
    );

    pollEnabled = true;
    await metadataTestHooks.pollLsofForProject(project.id, activationToken);
    const whileLiveAppBlocked = await getProject(project.id);
    assert.equal(
      [...whileLiveAppBlocked.files, ...whileLiveAppBlocked.pendingFiles]
        .some(file => file.path === shortLivedAssetPath),
      true,
      'the three-second lsof opportunity must remain available during live-app contention'
    );
    assert.equal(metadataTestHooks.getWatcherCoordinatorSnapshot(project.id).runningKind, 'live-app');

    releaseLiveApp();
    await liveAppPromise;
    liveAppPromise = null;
    await callIpcRaw('projects:delete', project.id);
  } finally {
    pollEnabled = false;
    releaseLiveApp();
    if (liveAppPromise) await liveAppPromise.catch(() => {});
    setChildProcessHandler(null);
    fs.rmSync(sourcePath, { force: true });
    fs.rmSync(shortLivedAssetPath, { force: true });
  }
});

test('xattr and Spotlight form a deterministic candidate-only union with newer Spotlight evidence', async () => {
  resetTestHomeWorkspace();
  const candidateRoot = path.join(TEST_HOME, 'Desktop', 'metadata-union');
  const xattrCandidate = path.join(candidateRoot, 'xattr.ai');
  const spotlightCandidate = path.join(candidateRoot, 'spotlight.psd');
  const staleCandidate = path.join(candidateRoot, 'stale.indd');
  const unenumeratedCandidate = path.join(candidateRoot, 'created-after-enumeration.ai');
  fs.mkdirSync(candidateRoot, { recursive: true });
  for (const filePath of [xattrCandidate, spotlightCandidate, staleCandidate]) {
    fs.writeFileSync(filePath, path.basename(filePath));
  }
  const project = await createProject('Deterministic Metadata Union');
  const storedProject = storeInstance.data.projects.find(item => item.id === project.id);
  storedProject.watchStartedAt = Date.now() - 1000;
  const recentXattr = encodeLastUsedXattr(storedProject.watchStartedAt + 500);
  const staleXattr = encodeLastUsedXattr(storedProject.watchStartedAt - 500);
  let createdUnenumerated = false;
  let mdlsCalls = 0;

  try {
    setChildProcessHandler(request => {
      const paths = bulkXattrPaths(request);
      if (paths.length) return {
        stdout: formatBulkXattrOutput(paths, filePath => filePath === xattrCandidate ? recentXattr : staleXattr),
      };
      if (isBulkSpotlightRequest(request)) {
        if (!createdUnenumerated) {
          fs.writeFileSync(unenumeratedCandidate, 'not in enumerated candidate universe');
          createdUnenumerated = true;
        }
        return {
          stdout: formatBulkSpotlightOutputForRoot(request, [
            unenumeratedCandidate,
            spotlightCandidate,
            xattrCandidate,
          ].reverse()),
        };
      }
      if (request.kind === 'execFile' && request.command === '/usr/bin/mdls') mdlsCalls++;
      return { stdout: '' };
    });

    const scan = await callIpcRaw('projects:pre-package-scan', project.id);
    assert.equal(scan.error, undefined);
    assert.equal(mdlsCalls, 0);
    const updated = await getProject(project.id);
    const evidenceKeys = Object.keys(updated.liveEvidenceLedger.candidates).sort();
    assert.deepEqual(evidenceKeys, [xattrCandidate, spotlightCandidate].map(liveEvidenceKeyForTest).sort());
    assert.equal(evidenceKeys.includes(liveEvidenceKeyForTest(staleCandidate)), false);
    assert.equal(evidenceKeys.includes(liveEvidenceKeyForTest(unenumeratedCandidate)), false);
  } finally {
    setChildProcessHandler(null);
    fs.rmSync(candidateRoot, { recursive: true, force: true });
  }
});

test('mixed native xattr failure retains partial stdout and treats missing attributes as absent', async () => {
  resetTestHomeWorkspace();
  const candidateRoot = path.join(TEST_HOME, 'Desktop', 'mixed-xattr');
  const recentCandidate = path.join(candidateRoot, 'recent.ai');
  const staleCandidate = path.join(candidateRoot, 'stale.psd');
  const missingCandidate = path.join(candidateRoot, 'missing.indd');
  fs.mkdirSync(candidateRoot, { recursive: true });
  for (const filePath of [recentCandidate, staleCandidate, missingCandidate]) fs.writeFileSync(filePath, 'fixture');
  const project = await createProject('Mixed Xattr Result');
  const storedProject = storeInstance.data.projects.find(item => item.id === project.id);
  storedProject.watchStartedAt = Date.now() - 1000;
  const recentXattr = encodeLastUsedXattr(storedProject.watchStartedAt + 500);
  const staleXattr = encodeLastUsedXattr(storedProject.watchStartedAt - 500);
  let mdlsCalls = 0;

  try {
    setChildProcessHandler(request => {
      const paths = bulkXattrPaths(request);
      if (paths.length) {
        const stdout = formatBulkXattrOutput(paths, filePath => {
          if (filePath === recentCandidate) return recentXattr;
          if (filePath === staleCandidate) return staleXattr;
          return null;
        });
        return missingXattrError([missingCandidate], stdout);
      }
      if (isBulkSpotlightRequest(request)) return { stdout: Buffer.alloc(0) };
      if (request.kind === 'execFile' && request.command === '/usr/bin/mdls') mdlsCalls++;
      return { stdout: '' };
    });

    const scan = await callIpcRaw('projects:pre-package-scan', project.id);
    assert.equal(scan.error, undefined);
    assert.equal(mdlsCalls, 0);
    const updated = await getProject(project.id);
    const evidenceKeys = Object.keys(updated.liveEvidenceLedger.candidates);
    assert.deepEqual(evidenceKeys, [liveEvidenceKeyForTest(recentCandidate)]);
  } finally {
    setChildProcessHandler(null);
    fs.rmSync(candidateRoot, { recursive: true, force: true });
  }
});

test('newline xattr candidates use structured single-file acquisition without batch framing ambiguity', async () => {
  resetTestHomeWorkspace();
  const candidateRoot = path.join(TEST_HOME, 'Desktop', 'unsafe-xattr-name');
  const safeCandidate = path.join(candidateRoot, 'safe.ai');
  const newlineCandidate = path.join(candidateRoot, 'line\nbreak.psd');
  fs.mkdirSync(candidateRoot, { recursive: true });
  fs.writeFileSync(safeCandidate, 'safe');
  fs.writeFileSync(newlineCandidate, 'newline');
  const project = await createProject('Unsafe Xattr Framing');
  const storedProject = storeInstance.data.projects.find(item => item.id === project.id);
  storedProject.watchStartedAt = Date.now() - 1000;
  const recentXattr = encodeLastUsedXattr(storedProject.watchStartedAt + 500);
  const staleXattr = encodeLastUsedXattr(storedProject.watchStartedAt - 500);
  let singleCalls = 0;

  try {
    setChildProcessHandler(request => {
      const paths = bulkXattrPaths(request);
      if (paths.length) {
        assert.equal(paths.includes(newlineCandidate), false);
        return { stdout: formatBulkXattrOutput(paths, () => staleXattr) };
      }
      if (singleXattrPath(request)) {
        singleCalls++;
        assert.equal(singleXattrPath(request), newlineCandidate);
        return { stdout: recentXattr };
      }
      if (isBulkSpotlightRequest(request)) return { stdout: Buffer.alloc(0) };
      return { stdout: '' };
    });

    const scan = await callIpcRaw('projects:pre-package-scan', project.id);
    assert.equal(scan.error, undefined);
    assert.equal(singleCalls, 1);
    const updated = await getProject(project.id);
    assert.ok(updated.liveEvidenceLedger.candidates[liveEvidenceKeyForTest(newlineCandidate)]);
    assert.equal(updated.liveEvidenceLedger.candidates[liveEvidenceKeyForTest(safeCandidate)], undefined);
  } finally {
    setChildProcessHandler(null);
    fs.rmSync(candidateRoot, { recursive: true, force: true });
  }
});

test('failed Spotlight root waits for every independently bounded required root to settle', async () => {
  resetTestHomeWorkspace();
  const candidatePath = path.join(TEST_HOME, 'Desktop', 'root-settlement.ai');
  fs.writeFileSync(candidatePath, 'candidate');
  const project = await createProject('Root Settlement');
  const before = JSON.stringify(await getProject(project.id));
  const roots = expectedBulkSpotlightRoots();
  let releaseDelayedRoot = () => {};
  const delayedRoot = new Promise(resolve => { releaseDelayedRoot = resolve; });
  const queriedRoots = [];
  let scanSettled = false;

  try {
    setChildProcessHandler(request => {
      const paths = bulkXattrPaths(request);
      if (paths.length) return missingXattrError(paths);
      if (isBulkSpotlightRequest(request)) {
        const root = bulkSpotlightRoot(request);
        queriedRoots.push(root);
        if (root === roots[0]) return { error: Object.assign(new Error('root failed'), { code: 'EIO' }) };
        if (root === roots[1]) return delayedRoot.then(() => ({ stdout: Buffer.alloc(0) }));
        return { stdout: Buffer.alloc(0) };
      }
      return { stdout: '' };
    });

    const scanPromise = callIpcRaw('projects:pre-package-scan', project.id).then(result => {
      scanSettled = true;
      return result;
    });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(scanSettled, false);
    releaseDelayedRoot();
    const scan = await scanPromise;
    assert.equal(scan.error, 'package_scan_incomplete');
    assert.deepEqual([...queriedRoots].sort(), [...roots].sort());
    assert.equal(JSON.stringify(await getProject(project.id)), before);
  } finally {
    releaseDelayedRoot();
    setChildProcessHandler(null);
    fs.rmSync(candidatePath, { force: true });
  }
});

test('malformed metadata, root failures, deletion, and abnormal xattr latch incomplete with base side effects', async () => {
  const scenarios = [
    ['root failure', request => isBulkSpotlightRequest(request)
      ? { error: Object.assign(new Error('root failed'), { code: 'EIO' }) }
      : null],
    ['root timeout', request => isBulkSpotlightRequest(request)
      ? { error: Object.assign(new Error('root timed out'), { code: 'ETIMEDOUT', killed: true }) }
      : null],
    ['missing final NUL', request => isBulkSpotlightRequest(request)
      ? { stdout: Buffer.from(path.join(bulkSpotlightRoot(request), 'candidate.ai'), 'utf8') }
      : null],
    ['empty NUL record', request => isBulkSpotlightRequest(request)
      ? { stdout: Buffer.from(`${path.join(bulkSpotlightRoot(request), 'candidate.ai')}\0\0`, 'utf8') }
      : null],
    ['invalid UTF-8', request => isBulkSpotlightRequest(request)
      ? { stdout: Buffer.from([0xff, 0x00]) }
      : null],
    ['line feed path', request => isBulkSpotlightRequest(request)
      ? { stdout: formatBulkSpotlightOutput([path.join(bulkSpotlightRoot(request), 'line\nbreak.ai')]) }
      : null],
    ['carriage return path', request => isBulkSpotlightRequest(request)
      ? { stdout: formatBulkSpotlightOutput([path.join(bulkSpotlightRoot(request), 'carriage\rreturn.ai')]) }
      : null],
    ['out of root', request => isBulkSpotlightRequest(request)
      ? { stdout: formatBulkSpotlightOutput([path.join(TEST_HOME, 'outside-root.ai')]) }
      : null],
    ['abnormal xattr failure', request => bulkXattrPaths(request).length
      ? { error: Object.assign(new Error('xattr failed'), { code: 'EIO', stderr: 'abnormal failure' }) }
      : null],
    ['malformed xattr framing', request => bulkXattrPaths(request).length
      ? { stdout: '/unexpected/path.ai:\n00\n' }
      : null],
  ];

  for (const [label, scenarioHandler] of scenarios) {
    resetTestHomeWorkspace();
    const fixtureRoot = path.join(TEST_HOME, 'Desktop', `failure-${label.replace(/\s+/g, '-')}`);
    const sourcePath = path.join(fixtureRoot, 'Review_Project.ai');
    const candidatePath = path.join(fixtureRoot, 'candidate.ai');
    const outputDir = path.join(TEST_HOME, 'Documents', `output-${label.replace(/\s+/g, '-')}`);
    fs.mkdirSync(fixtureRoot, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(sourcePath, 'source');
    fs.writeFileSync(candidatePath, 'candidate');
    const project = await createProject(`Failure ${label}`);
    const stored = await setProjectFiles(project.id, { files: [{
      path: sourcePath,
      name: path.basename(sourcePath),
      ext: '.ai',
      addedAt: Date.now(),
      source: 'manual-browse',
    }] });
    const initialReview = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(initialReview.materializable, true);
    const beforeState = JSON.stringify(await getProject(project.id));
    const before = capturePackageSideEffects(stored);

    try {
      setChildProcessHandler(request => {
        const scenarioResult = scenarioHandler(request);
        if (scenarioResult) return scenarioResult;
        const paths = bulkXattrPaths(request);
        if (paths.length) return { stdout: formatBulkXattrOutput(paths, () => encodeLastUsedXattr(Date.now() - 86400000)) };
        if (isBulkSpotlightRequest(request)) return { stdout: Buffer.alloc(0) };
        return { stdout: '' };
      });
      const scan = await callIpcRaw('projects:pre-package-scan', project.id);
      assert.equal(scan.error, 'package_scan_incomplete', label);
      assert.equal(scan.diagnostics.failurePhase, 'pre-package-discovery', label);
      assert.equal((await callIpcRaw('projects:prepare-package-review', project.id)).error, 'package_scan_incomplete', label);
      assert.equal(
        (await callIpcRaw('projects:package', project.id, outputDir, initialReview.token)).error,
        'package_scan_incomplete',
        label
      );
      assert.equal(JSON.stringify(await getProject(project.id)), beforeState, label);
      assertFailedPackageHasNoSideEffects(stored, outputDir, before);
    } finally {
      setChildProcessHandler(null);
      await callIpcRaw('projects:delete', project.id);
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }
});

test('duplicate required root, deleted root, and deleted candidate fail closed', async () => {
  const scenarios = ['duplicate root', 'deleted root', 'deleted candidate'];
  for (const label of scenarios) {
    resetTestHomeWorkspace();
    const desktopRoot = path.join(TEST_HOME, 'Desktop');
    const documentsRoot = path.join(TEST_HOME, 'Documents');
    const candidatePath = path.join(desktopRoot, `${label.replace(/\s+/g, '-')}.ai`);
    fs.writeFileSync(candidatePath, 'candidate');
    if (label === 'duplicate root') {
      fs.rmSync(documentsRoot, { recursive: true, force: true });
      fs.symlinkSync(desktopRoot, documentsRoot, 'dir');
    }
    const project = await createProject(`Metadata ${label}`);
    let mutationDone = false;

    try {
      setChildProcessHandler(request => {
        const paths = bulkXattrPaths(request);
        if (paths.length) return missingXattrError(paths);
        if (isBulkSpotlightRequest(request)) {
          if (!mutationDone && label === 'deleted root' && bulkSpotlightRoot(request) === desktopRoot) {
            fs.rmSync(desktopRoot, { recursive: true, force: true });
            mutationDone = true;
          } else if (!mutationDone && label === 'deleted candidate') {
            fs.rmSync(candidatePath, { force: true });
            mutationDone = true;
          }
          return { stdout: Buffer.alloc(0) };
        }
        return { stdout: '' };
      });
      const scan = await callIpcRaw('projects:pre-package-scan', project.id);
      assert.equal(scan.error, 'package_scan_incomplete', label);
      assert.equal(scan.diagnostics.failurePhase, 'pre-package-discovery', label);
    } finally {
      setChildProcessHandler(null);
      if (label === 'duplicate root') fs.rmSync(documentsRoot, { force: true });
      resetTestHomeWorkspace();
    }
  }
});

test('pre-package discovery timeout invalidates late work and reports fresh overlap evidence', async () => {
  resetTestHomeWorkspace();
  const project = await createProject('Stalled Pre-Package Scan');
  const candidatePath = path.join(TEST_HOME, 'Desktop', 'Late.ai');
  fs.writeFileSync(candidatePath, 'late candidate');
  const trackedSetTimeout = global.setTimeout;
  let releaseMdls;
  const mdlsGate = new Promise(resolve => { releaseMdls = resolve; });
  try {
    setChildProcessHandler(request => {
      const paths = bulkXattrPaths(request);
      if (paths.length) return missingXattrError(paths);
      if (isBulkSpotlightRequest(request)) return mdlsGate.then(() => ({ stdout: Buffer.alloc(0) }));
      return { stdout: '' };
    });
    global.setTimeout = (fn, delay, ...args) => trackedSetTimeout(fn, delay === 8000 ? 0 : delay, ...args);
    const scan = await callIpcRaw('projects:pre-package-scan', project.id);
    assert.equal(scan.error, 'package_scan_incomplete');
    assert.equal(scan.diagnostics.failurePhase, 'pre-package-discovery');
    for (const field of ['phaseElapsedMs', 'candidateCount', 'xattrResolvedCount', 'metadataFallbackCount']) {
      assert.ok(Number.isSafeInteger(scan.diagnostics[field]));
      assert.ok(scan.diagnostics[field] >= 0);
    }
    assert.equal(JSON.stringify(scan.diagnostics).includes(candidatePath), false);
    assert.equal(JSON.stringify(scan.diagnostics).includes(path.basename(candidatePath)), false);
    releaseMdls();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(review.error, 'package_scan_incomplete');
    assert.deepEqual(review.diagnostics, scan.diagnostics);
    assert.deepEqual((await getProject(project.id)).files, []);
    await callIpcRaw('projects:delete', project.id);
    const deletedReview = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(deletedReview.error, 'not_found');
    assert.equal(deletedReview.diagnostics.failurePhase, 'prepare-package-review');
    assert.ok(Number.isSafeInteger(deletedReview.diagnostics.phaseElapsedMs));
    for (const field of ['candidateCount', 'xattrResolvedCount', 'metadataFallbackCount']) {
      assert.equal(Object.prototype.hasOwnProperty.call(deletedReview.diagnostics, field), false);
    }
  } finally {
    global.setTimeout = trackedSetTimeout;
    releaseMdls();
    setChildProcessHandler(null);
    fs.rmSync(candidatePath, { force: true });
  }
});

test('final package confirmation reports privacy-safe evidence when an input scan is still in flight', async () => {
  resetTestHomeWorkspace();
  const tmpRoot = makeTempDir();
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'Confirmation.ai');
  const stalledCandidate = path.join(TEST_HOME, 'Documents', 'Pending.ai');
  const outputDir = path.join(tmpRoot, 'out');
  const originalDateNow = Date.now;
  let releaseMdls = () => {};
  let markMdlsStarted = () => {};
  try {
    fs.writeFileSync(sourcePath, 'reviewed source bytes');
    fs.writeFileSync(stalledCandidate, 'pending discovery bytes');
    fs.mkdirSync(outputDir);
    const project = await createProject('In-Flight Confirmation');
    const stored = await setProjectFiles(project.id, { files: [{
      path: sourcePath,
      name: path.basename(sourcePath),
      ext: '.ai',
      addedAt: Date.now(),
      source: 'manual-browse',
    }] });
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(review.materializable, true);
    const before = capturePackageSideEffects(stored);
    const mdlsGate = new Promise(resolve => { releaseMdls = resolve; });
    const mdlsStarted = new Promise(resolve => { markMdlsStarted = resolve; });
    setChildProcessHandler(request => {
      const paths = bulkXattrPaths(request);
      if (paths.length) return missingXattrError(paths);
      if (isBulkSpotlightRequest(request)) {
        markMdlsStarted();
        return mdlsGate.then(() => ({ stdout: Buffer.alloc(0) }));
      }
      return { stdout: '' };
    });

    const scanPromise = callIpcRaw('projects:pre-package-scan', project.id);
    await mdlsStarted;
    let now = originalDateNow();
    Date.now = () => {
      now += 31000;
      return now;
    };
    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);
    Date.now = originalDateNow;

    assert.equal(result.error, 'package_scan_in_flight');
    assert.equal(result.diagnostics.failurePhase, 'package-input-scan-wait');
    assert.ok(Number.isSafeInteger(result.diagnostics.phaseElapsedMs));
    assert.ok(result.diagnostics.phaseElapsedMs >= 0);
    assert.deepEqual(Object.keys(result.diagnostics).sort(), ['failurePhase', 'phaseElapsedMs']);
    assert.equal(JSON.stringify(result.diagnostics).includes(sourcePath), false);
    assert.equal(JSON.stringify(result.diagnostics).includes(path.basename(sourcePath)), false);
    assertFailedPackageHasNoSideEffects(stored, outputDir, before);

    releaseMdls();
    await scanPromise;
  } finally {
    Date.now = originalDateNow;
    releaseMdls();
    setChildProcessHandler(null);
    fs.rmSync(sourcePath, { force: true });
    fs.rmSync(stalledCandidate, { force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('a fresh pre-package retry replaces prior scan metrics', async () => {
  resetTestHomeWorkspace();
  const candidateRoot = path.join(TEST_HOME, 'Desktop', 'fresh-retry-fixtures');
  const retainedCandidate = path.join(candidateRoot, 'retained.ai');
  const removedCandidate = path.join(candidateRoot, 'removed.ai');
  fs.mkdirSync(candidateRoot, { recursive: true });
  fs.writeFileSync(retainedCandidate, 'retained candidate');
  fs.writeFileSync(removedCandidate, 'removed candidate');
  const project = await createProject('Fresh Pre-Package Retry');
  const staleXattr = encodeLastUsedXattr(Date.now() - (24 * 60 * 60 * 1000));
  const trackedSetTimeout = global.setTimeout;
  let releaseMdls = () => {};
  let markMdlsStarted = () => {};

  try {
    setChildProcessHandler(request => {
      const paths = bulkXattrPaths(request);
      if (paths.length) return { stdout: formatBulkXattrOutput(paths, () => staleXattr) };
      if (isBulkSpotlightRequest(request)) return { stdout: Buffer.alloc(0) };
      return { stdout: '' };
    });

    const completedScan = await callIpcRaw('projects:pre-package-scan', project.id);
    assert.equal(completedScan.error, undefined);
    fs.rmSync(removedCandidate, { force: true });

    const mdlsGate = new Promise(resolve => { releaseMdls = resolve; });
    const mdlsStarted = new Promise(resolve => { markMdlsStarted = resolve; });
    setChildProcessHandler(request => {
      const paths = bulkXattrPaths(request);
      if (paths.length) return missingXattrError(paths);
      if (isBulkSpotlightRequest(request)) {
        markMdlsStarted();
        return mdlsGate.then(() => ({ stdout: Buffer.alloc(0) }));
      }
      return { stdout: '' };
    });
    global.setTimeout = (fn, delay, ...args) => trackedSetTimeout(fn, delay === 8000 ? 50 : delay, ...args);

    const retryPromise = callIpcRaw('projects:pre-package-scan', project.id);
    await mdlsStarted;
    const overlappingRetry = await callIpcRaw('projects:pre-package-scan', project.id);
    assert.deepEqual(overlappingRetry, {
      error: 'package_scan_incomplete',
      diagnostics: {
        failurePhase: 'pre-package-scan-in-flight',
        phaseElapsedMs: 0,
      },
    });
    const retry = await retryPromise;
    assert.equal(retry.error, 'package_scan_incomplete');
    assert.deepEqual(retry.diagnostics, {
      failurePhase: 'pre-package-discovery',
      phaseElapsedMs: retry.diagnostics.phaseElapsedMs,
      candidateCount: 1,
      xattrResolvedCount: 0,
      metadataFallbackCount: 0,
    });
    assert.ok(Number.isSafeInteger(retry.diagnostics.phaseElapsedMs));
    releaseMdls();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    await callIpcRaw('projects:delete', project.id);
  } finally {
    global.setTimeout = trackedSetTimeout;
    releaseMdls();
    setChildProcessHandler(null);
    fs.rmSync(candidateRoot, { recursive: true, force: true });
  }
});

test('pre-package discovery timeout blocks an otherwise materializable project when a relevant candidate stalls', async () => {
  resetTestHomeWorkspace();
  const projectRoot = path.join(TEST_HOME, 'Desktop', 'Crate-QA', 'v2.7.1-jenna', 'source-copies');
  const sourcePath = path.join(projectRoot, 'Review_Project.ai');
  const linkedPath = path.join(projectRoot, 'Review_Initial.png');
  const unrelatedRoot = path.join(TEST_HOME, 'Desktop', 'Crate-QA', 'v2.7.1-jenna', 'historical-fixtures');
  const stalledCandidate = path.join(unrelatedRoot, 'relevant-open.ai');
  const outputDir = path.join(TEST_HOME, 'Desktop', 'package-output');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(unrelatedRoot, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(sourcePath, 'valid Illustrator source bytes');
  fs.writeFileSync(linkedPath, 'valid linked PNG bytes');

  const project = await createProject('Review Project');
  await setProjectFiles(project.id, {
    files: [sourcePath, linkedPath].map(filePath => ({
      path: filePath,
      name: path.basename(filePath),
      ext: path.extname(filePath).toLowerCase(),
      addedAt: Date.now(),
      source: 'scan-on-open',
    })),
  });
  const initialReview = await callIpcRaw('projects:prepare-package-review', project.id);
  assert.equal(initialReview.materializable, true);
  assert.equal(typeof initialReview.token, 'string');
  for (let index = 0; index < 64; index++) {
    fs.writeFileSync(path.join(unrelatedRoot, `historical-${index}.ai`), 'unrelated design fixture');
    fs.writeFileSync(path.join(unrelatedRoot, `historical-${index}.png`), 'unrelated image fixture');
  }
  fs.writeFileSync(stalledCandidate, 'relevant design fixture');
  const before = await getProject(project.id);
  const beforeState = JSON.stringify(before);
  const beforeQuota = storeInstance.get('usage.packagesThisMonth');
  const beforeWatcherCount = watcherRecords.length;
  const beforeWatcherCloseCount = watcherCloseCount;
  const recentXattr = encodeLastUsedXattr(Date.now() + 1000);
  const trackedSetTimeout = global.setTimeout;
  let mdlsCalls = 0;
  let spotlightCalls = 0;
  let releaseMdls;
  const mdlsGate = new Promise(resolve => { releaseMdls = resolve; });

  try {
    setChildProcessHandler(request => {
      const paths = bulkXattrPaths(request);
      if (paths.length) return { stdout: formatBulkXattrOutput(paths, candidatePath => (
        candidatePath === stalledCandidate ? encodeLastUsedXattr(Date.now() - 86400000) : recentXattr
      )) };
      if (isBulkSpotlightRequest(request)) {
        spotlightCalls++;
        return mdlsGate.then(() => ({ stdout: Buffer.alloc(0) }));
      }
      if (request.kind === 'execFile' && request.command === '/usr/bin/mdls') mdlsCalls++;
      return { stdout: '' };
    });
    global.setTimeout = (fn, delay, ...args) => trackedSetTimeout(fn, delay === 8000 ? 100 : delay, ...args);

    const scan = await callIpcRaw('projects:pre-package-scan', project.id);
    assert.equal(scan.error, 'package_scan_incomplete');
    assert.deepEqual(scan.diagnostics, {
      failurePhase: 'pre-package-discovery',
      phaseElapsedMs: scan.diagnostics.phaseElapsedMs,
      candidateCount: 129,
      xattrResolvedCount: 0,
      metadataFallbackCount: 0,
    });
    assert.ok(Number.isSafeInteger(scan.diagnostics.phaseElapsedMs));
    const safeDiagnosticText = JSON.stringify(scan.diagnostics);
    assert.equal(safeDiagnosticText.includes(projectRoot), false);
    assert.equal(safeDiagnosticText.includes('Review_Project.ai'), false);
    assert.equal(safeDiagnosticText.includes('relevant-open.ai'), false);
    assert.equal(spotlightCalls, expectedBulkSpotlightRoots().length);
    assert.equal(mdlsCalls, 0);
    releaseMdls();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(review.error, 'package_scan_incomplete');
    assert.deepEqual(review.diagnostics, scan.diagnostics);
    const packageResult = await callIpcRaw('projects:package', project.id, outputDir, initialReview.token);
    assert.equal(packageResult.error, 'package_scan_incomplete');
    assert.deepEqual(packageResult.diagnostics, scan.diagnostics);
    assert.equal(JSON.stringify(packageResult.diagnostics).includes(projectRoot), false);
    assert.equal(JSON.stringify(packageResult.diagnostics).includes('Review_Project.ai'), false);
    assert.equal(JSON.stringify(packageResult.diagnostics).includes('relevant-open.ai'), false);
    assert.equal(fs.readdirSync(outputDir).length, 0);
    assert.equal(storeInstance.get('usage.packagesThisMonth'), beforeQuota);
    assert.equal(watcherRecords.length, beforeWatcherCount);
    assert.equal(watcherCloseCount, beforeWatcherCloseCount);
    const after = await getProject(project.id);
    assert.equal(after.status, before.status);
    assert.equal(after.outputPath, before.outputPath);
    assert.equal(JSON.stringify(after.provenance), JSON.stringify(before.provenance));
    assert.equal(JSON.stringify(after), beforeState);
  } finally {
    global.setTimeout = trackedSetTimeout;
    releaseMdls();
    await new Promise(resolve => setImmediate(resolve));
    setChildProcessHandler(null);
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('bounded pre-package metadata checks use one batch and one query per existing required root', async () => {
  resetTestHomeWorkspace();
  const projectRoot = path.join(TEST_HOME, 'Desktop', 'Crate-QA', 'v2.7.1-jenna', 'source-copies');
  const sourcePath = path.join(projectRoot, 'Review_Project.ai');
  const linkedPath = path.join(projectRoot, 'Review_Initial.png');
  const unrelatedRoot = path.join(TEST_HOME, 'Desktop', 'Crate-QA', 'v2.7.1-jenna', 'historical-fixtures');
  const outputDir = path.join(TEST_HOME, 'Desktop', 'package-output');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(unrelatedRoot, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(sourcePath, 'valid Illustrator source bytes');
  fs.writeFileSync(linkedPath, 'valid linked PNG bytes');
  for (let index = 0; index < 64; index++) {
    fs.writeFileSync(path.join(unrelatedRoot, `historical-${index}.ai`), 'unrelated design fixture');
    fs.writeFileSync(path.join(unrelatedRoot, `historical-${index}.png`), 'unrelated image fixture');
  }

  const project = await createProject('Review Project Without Metadata Stall');
  await setProjectFiles(project.id, {
    files: [sourcePath, linkedPath].map(filePath => ({
      path: filePath,
      name: path.basename(filePath),
      ext: path.extname(filePath).toLowerCase(),
      addedAt: Date.now(),
      source: 'scan-on-open',
    })),
  });
  const before = await getProject(project.id);
  const beforeState = JSON.stringify(before);
  const beforeQuota = storeInstance.get('usage.packagesThisMonth');
  const beforeWatcherCount = watcherRecords.length;
  const beforeWatcherCloseCount = watcherCloseCount;
  const historicalXattr = encodeLastUsedXattr(Date.now() - (24 * 60 * 60 * 1000));
  let xattrCalls = 0;
  let spotlightCalls = 0;
  let mdlsCalls = 0;

  try {
    setChildProcessHandler(request => {
      const paths = bulkXattrPaths(request);
      if (paths.length) {
        xattrCalls++;
        assert.ok(paths.length <= 256);
        return { stdout: formatBulkXattrOutput(paths, () => historicalXattr) };
      }
      if (isBulkSpotlightRequest(request)) {
        spotlightCalls++;
        return { stdout: Buffer.alloc(0) };
      }
      if (request.kind === 'execFile' && request.command === '/usr/bin/mdls') mdlsCalls++;
      return { stdout: '' };
    });

    const scan = await callIpcRaw('projects:pre-package-scan', project.id);
    assert.equal(scan.error, undefined);
    assert.equal(xattrCalls, 1);
    assert.equal(spotlightCalls, expectedBulkSpotlightRoots().length);
    assert.equal(mdlsCalls, 0);
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(review.materializable, true);
    assert.equal(typeof review.token, 'string');
    assert.deepEqual(review.files.map(file => file.name), ['Review_Project.ai', 'Review_Initial.png']);
    assert.equal(fs.readdirSync(outputDir).length, 0);
    assert.equal(storeInstance.get('usage.packagesThisMonth'), beforeQuota);
    assert.equal(watcherRecords.length, beforeWatcherCount);
    assert.equal(watcherCloseCount, beforeWatcherCloseCount);
    assert.equal(JSON.stringify(await getProject(project.id)), beforeState);
  } finally {
    setChildProcessHandler(null);
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('signed native timespec boundaries reconcile against Spotlight without admitting candidates', async () => {
  resetTestHomeWorkspace();
  const candidateRoot = path.join(TEST_HOME, 'Desktop', 'invalid-xattr-fixtures');
  const farFutureTimespec = Buffer.alloc(16);
  farFutureTimespec.writeBigInt64LE(8640000000001n, 0);
  const maxSecondWithNanoseconds = Buffer.alloc(16);
  maxSecondWithNanoseconds.writeBigInt64LE(8640000000000n, 0);
  maxSecondWithNanoseconds.writeBigInt64LE(1n, 8);
  const candidateXattrs = new Map([
    [path.join(candidateRoot, 'malformed.ai'), 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'],
    [path.join(candidateRoot, 'negative-seconds.ai'), 'ffffffffffffffff0000000000000000'],
    [path.join(candidateRoot, 'zero-seconds.ai'), '00000000000000000000000000000000'],
    [path.join(candidateRoot, 'negative-nanoseconds.ai'), '00f1536500000000ffffffffffffffff'],
    [path.join(candidateRoot, 'invalid-nanoseconds.ai'), '00f153650000000000ca9a3b00000000'],
    [path.join(candidateRoot, 'max-second-with-nanoseconds.ai'), maxSecondWithNanoseconds.toString('hex')],
    [path.join(candidateRoot, 'out-of-range-seconds.ai'), farFutureTimespec.toString('hex')],
  ]);
  fs.mkdirSync(candidateRoot, { recursive: true });
  for (const candidatePath of candidateXattrs.keys()) fs.writeFileSync(candidatePath, 'unrelated design fixture');

  const project = await createProject('Invalid Xattr Review');
  const before = await getProject(project.id);
  let mdlsCalls = 0;

  try {
    setChildProcessHandler(request => {
      const paths = bulkXattrPaths(request);
      if (paths.length) return { stdout: formatBulkXattrOutput(paths, candidatePath => candidateXattrs.get(candidatePath)) };
      if (isBulkSpotlightRequest(request)) return { stdout: Buffer.alloc(0) };
      if (request.kind === 'execFile' && request.command === '/usr/bin/mdls') mdlsCalls++;
      return { stdout: '' };
    });

    const scan = await callIpcRaw('projects:pre-package-scan', project.id);
    assert.equal(scan.error, undefined);
    assert.equal(mdlsCalls, 0);
    assert.equal(JSON.stringify(await getProject(project.id)), JSON.stringify(before));
  } finally {
    setChildProcessHandler(null);
    fs.rmSync(candidateRoot, { recursive: true, force: true });
  }
});

test('pre-package discovery preserves a newer Spotlight signal when xattr is stale', async () => {
  resetTestHomeWorkspace();
  const candidatePath = path.join(TEST_HOME, 'Desktop', 'newer-spotlight.psd');
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(candidatePath, 'recent design source');
  const project = await createProject('Newer Spotlight Signal');
  const storedProject = storeInstance.data.projects.find(item => item.id === project.id);
  storedProject.watchStartedAt = Date.now() - 1000;
  let mdlsCalls = 0;

  try {
    setChildProcessHandler(request => {
      const paths = bulkXattrPaths(request);
      if (paths.length) return { stdout: formatBulkXattrOutput(paths, () => encodeLastUsedXattr(storedProject.watchStartedAt - 1000)) };
      if (isBulkSpotlightRequest(request)) {
        return { stdout: formatBulkSpotlightOutputForRoot(request, [candidatePath]) };
      }
      if (request.kind === 'execFile' && request.command === '/usr/bin/mdls') mdlsCalls++;
      return { stdout: '' };
    });

    const scan = await callIpcRaw('projects:pre-package-scan', project.id);
    assert.equal(scan.error, undefined);
    assert.equal(mdlsCalls, 0);
    const updated = await getProject(project.id);
    assert.equal(updated.files.length, 0);
    assert.equal(updated.pendingFiles.length, 0);
    assert.equal(
      updated.liveEvidenceLedger.candidates[liveEvidenceKeyForTest(candidatePath)].latest.reason,
      'broad-observer-outside-session'
    );
  } finally {
    setChildProcessHandler(null);
    fs.rmSync(candidatePath, { force: true });
  }
});

test('pre-package discovery accepts a real macOS little-endian signed timespec without mdls', async () => {
  resetTestHomeWorkspace();
  const candidatePath = path.join(TEST_HOME, 'Desktop', 'native-timespec.psd');
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(candidatePath, 'native timespec design source');
  const project = await createProject('Native Timespec Signal');
  const storedProject = storeInstance.data.projects.find(item => item.id === project.id);
  storedProject.watchStartedAt = Date.parse('2026-06-01T00:00:00Z');
  let mdlsCalls = 0;

  try {
    setChildProcessHandler(request => {
      const paths = bulkXattrPaths(request);
      if (paths.length) return { stdout: formatBulkXattrOutput(paths, () => '26a3346a0000000055ce821e00000000') };
      if (isBulkSpotlightRequest(request)) return { stdout: Buffer.alloc(0) };
      if (request.kind === 'execFile' && request.command === '/usr/bin/mdls') mdlsCalls++;
      return { stdout: '' };
    });

    const scan = await callIpcRaw('projects:pre-package-scan', project.id);
    assert.equal(scan.error, undefined);
    assert.equal(mdlsCalls, 0);
    const updated = await getProject(project.id);
    assert.equal(updated.files.length, 0);
    assert.equal(updated.pendingFiles.length, 0);
    assert.equal(
      updated.liveEvidenceLedger.candidates[liveEvidenceKeyForTest(candidatePath)].latest.reason,
      'broad-observer-outside-session'
    );
  } finally {
    setChildProcessHandler(null);
    fs.rmSync(candidatePath, { force: true });
  }
});

test('real macOS last-used timespec remains stale after its exact nanosecond boundary', async () => {
  resetTestHomeWorkspace();
  const candidatePath = path.join(TEST_HOME, 'Desktop', 'native-timespec-boundary.psd');
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(candidatePath, 'native timespec boundary source');
  const project = await createProject('Native Timespec Boundary');
  const storedProject = storeInstance.data.projects.find(item => item.id === project.id);
  storedProject.watchStartedAt = 1781834534512;
  let mdlsCalls = 0;

  try {
    setChildProcessHandler(request => {
      const paths = bulkXattrPaths(request);
      if (paths.length) return { stdout: formatBulkXattrOutput(paths, () => '26a3346a0000000055ce821e00000000') };
      if (isBulkSpotlightRequest(request)) return { stdout: Buffer.alloc(0) };
      if (request.kind === 'execFile' && request.command === '/usr/bin/mdls') mdlsCalls++;
      return { stdout: '' };
    });

    const scan = await callIpcRaw('projects:pre-package-scan', project.id);
    assert.equal(scan.error, undefined);
    assert.equal(mdlsCalls, 0);
    const updated = await getProject(project.id);
    assert.equal(updated.files.length, 0);
    assert.equal(updated.pendingFiles.length, 0);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        (updated.liveEvidenceLedger && updated.liveEvidenceLedger.candidates) || {},
        liveEvidenceKeyForTest(candidatePath)
      ),
      false
    );
  } finally {
    setChildProcessHandler(null);
    fs.rmSync(candidatePath, { force: true });
  }
});

test('package review tokens reject missing, malformed, stale, cross-project, and replayed confirmation', async () => {
  const tmpRoot = makeTempDir();
  try {
    const first = await createProject('Token First');
    const firstPath = path.join(tmpRoot, 'First.ai');
    fs.writeFileSync(firstPath, 'first token source');
    await setProjectFiles(first.id, {
      files: [{ path: firstPath, name: 'First.ai', ext: '.ai', addedAt: Date.now(), source: 'manual-browse' }],
    });
    const second = await createProject('Token Second');
    const secondPath = path.join(tmpRoot, 'Second.ai');
    fs.writeFileSync(secondPath, 'second token source');
    await setProjectFiles(second.id, {
      files: [{ path: secondPath, name: 'Second.ai', ext: '.ai', addedAt: Date.now(), source: 'manual-browse' }],
    });

    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    assert.equal((await callIpcRaw('projects:package', first.id, outputDir)).error, 'package_review_required');
    assert.equal((await callIpcRaw('projects:package', first.id, outputDir, 'not-a-token')).error, 'package_review_invalid');

    const crossProjectReview = await callIpcRaw('projects:prepare-package-review', first.id);
    assert.equal(
      (await callIpcRaw('projects:package', second.id, outputDir, crossProjectReview.token)).error,
      'package_review_project_mismatch'
    );

    const staleReview = await callIpcRaw('projects:prepare-package-review', first.id);
    const currentReview = await callIpcRaw('projects:prepare-package-review', first.id);
    assert.equal(
      (await callIpcRaw('projects:package', first.id, outputDir, staleReview.token)).error,
      'package_review_stale'
    );

    const success = await callIpcRaw('projects:package', first.id, outputDir, currentReview.token);
    assert.equal(success.success, true);
    const replayOutput = path.join(tmpRoot, 'replay-out');
    fs.mkdirSync(replayOutput);
    assert.equal(
      (await callIpcRaw('projects:package', first.id, replayOutput, currentReview.token)).error,
      'package_review_replayed'
    );
    assert.deepEqual(fs.readdirSync(replayOutput), []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('consumed package review tokens enforce fixed-capacity expiry and LRU replay semantics', async () => {
  const tmpRoot = makeTempDir();
  const originalDateNow = Date.now;
  let now = originalDateNow();
  try {
    Date.now = () => now;
    const project = await createProject('Bounded Consumed Tokens');
    const sourcePath = path.join(tmpRoot, 'Bounded.ai');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, 'bounded token source');
    await setProjectFiles(project.id, { files: [{
      path: sourcePath,
      name: 'Bounded.ai',
      ext: '.ai',
      addedAt: now,
      source: 'manual-browse',
    }] });
    storeInstance.set('usage.packagesThisMonth', 25);

    const consumedTokens = [];
    for (let index = 0; index < 256; index++) {
      const review = await callIpcRaw('projects:prepare-package-review', project.id);
      consumedTokens.push(review.token);
      assert.equal((await callIpcRaw('projects:package', project.id, outputDir, review.token)).error, 'limit_reached');
    }

    assert.equal(
      (await callIpcRaw('projects:package', project.id, outputDir, consumedTokens[0])).error,
      'package_review_replayed'
    );
    const overflowReview = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(
      (await callIpcRaw('projects:package', project.id, outputDir, overflowReview.token)).error,
      'limit_reached'
    );
    assert.equal(
      (await callIpcRaw('projects:package', project.id, outputDir, consumedTokens[1])).error,
      'package_review_stale'
    );
    assert.equal(
      (await callIpcRaw('projects:package', project.id, outputDir, consumedTokens[0])).error,
      'package_review_replayed'
    );

    now += 15 * 60 * 1000 + 1;
    assert.equal(
      (await callIpcRaw('projects:package', project.id, outputDir, consumedTokens[0])).error,
      'package_review_stale'
    );
    assert.deepEqual(fs.readdirSync(outputDir), []);
    assert.deepEqual(
      fs.readdirSync(tmpRoot).filter(name => name.startsWith('.crate-package-staging-')),
      []
    );
  } finally {
    Date.now = originalDateNow;
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

test('normal project package completion resets quota when packaging crosses the local month boundary', async () => {
  const tmpRoot = makeTempDir();
  const RealDate = global.Date;
  const originalRenameSync = fs.renameSync;
  let now = new RealDate(2026, 5, 30, 23, 59, 59).getTime();
  class MutableDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(now);
      } else {
        super(...args);
      }
    }
    static now() { return now; }
    static parse(value) { return RealDate.parse(value); }
    static UTC(...args) { return RealDate.UTC(...args); }
  }

  try {
    global.Date = MutableDate;
    setChildProcessHandler(() => ({ stdout: '' }));
    const project = await createProject('Normal Package Completion Rollover');
    const sourcePath = path.join(tmpRoot, 'Rollover.ai');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, Buffer.from('normal package completion rollover bytes'));
    await setProjectFiles(project.id, {
      files: [{
        path: sourcePath,
        name: 'Rollover.ai',
        ext: '.ai',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    storeInstance.set('usage', {
      packagesThisMonth: 2,
      resetDate: '2026-07-01',
    });

    let crossedBoundaryDuringPackage = false;
    fs.renameSync = function advanceClockAtPackagePublication(source, destination, ...args) {
      if (
        path.basename(source).startsWith('.crate-package-staging-') &&
        path.dirname(path.resolve(destination)) === path.resolve(outputDir)
      ) {
        crossedBoundaryDuringPackage = true;
        now = new RealDate(2026, 6, 1, 0, 0, 1).getTime();
      }
      return originalRenameSync.call(fs, source, destination, ...args);
    };

    const result = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(crossedBoundaryDuringPackage, true);
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 1);
    assert.equal(storeInstance.get('usage.resetDate'), '2026-08-01');
  } finally {
    fs.renameSync = originalRenameSync;
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
    testMainWindowShowCount = 0;
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
    assert.equal(testMainWindowShowCount, 0);
    testNotifications[0].handlers.get('failed')({}, new Error('blocked by macOS'));
    assert.equal(testBrowserWindowCreateCount, 0);
    assert.equal(testMainWindowShowCount, 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('visible inactivity reminder waits the full three hours before showing its dialog', async () => {
  const tmpRoot = makeTempDir();
  const originalDateNow = Date.now;
  let now = originalDateNow();
  try {
    Date.now = () => now;
    const project = await createProject('Three Hour Inactivity Reminder');
    const sourcePath = path.join(tmpRoot, 'Reminder.ai');
    fs.writeFileSync(sourcePath, Buffer.from('three hour reminder bytes'));
    await setProjectFiles(project.id, {
      files: [{
        path: sourcePath,
        name: 'Reminder.ai',
        ext: '.ai',
        addedAt: now,
        source: 'manual-browse',
      }],
    });

    metadataTestHooks.startInactivityChecker();
    testMainWindowVisible = true;
    testNotificationSupported = true;
    testMessageBoxes.length = 0;
    testNotifications.length = 0;
    now += 180 * 60 * 1000 - 1;
    await runTrackedIntervalCallbacks();
    assert.equal(testMessageBoxes.length + testNotifications.length, 0);

    now += 1;
    await runTrackedIntervalCallbacks();
    assert.equal(testMessageBoxes.length, 1);
    assert.equal(testNotifications.length, 0);
    assert.equal(testMessageBoxes[0].title, 'Crate — Still working?');
    assert.equal(testMessageBoxes[0].message, '⏸ Still working on "Three Hour Inactivity Reminder"?');
    assert.equal(
      testMessageBoxes[0].detail,
      "Crate hasn't detected any new design files in 3 hours. Would you like to keep watching or pause?"
    );
    assert.deepEqual(testMessageBoxes[0].buttons, ['Keep Watching', 'Pause', 'Package Now']);

    now += 180 * 60 * 1000 - 1;
    await runTrackedIntervalCallbacks();
    assert.equal(testMessageBoxes.length, 1);
    now += 1;
    await runTrackedIntervalCallbacks();
    assert.equal(testMessageBoxes.length, 2);
    assert.equal(testMessageBoxes[1].title, 'Crate — Still working?');
  } finally {
    Date.now = originalDateNow;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('hidden inactivity reminder waits the full three hours before showing its native notification', async () => {
  const tmpRoot = makeTempDir();
  const originalDateNow = Date.now;
  let now = originalDateNow();
  try {
    Date.now = () => now;
    const project = await createProject('Three Hour Background Reminder');
    const sourcePath = path.join(tmpRoot, 'Background-Reminder.ai');
    fs.writeFileSync(sourcePath, Buffer.from('three hour background reminder bytes'));
    await setProjectFiles(project.id, {
      files: [{
        path: sourcePath,
        name: 'Background-Reminder.ai',
        ext: '.ai',
        addedAt: now,
        source: 'manual-browse',
      }],
    });

    metadataTestHooks.startInactivityChecker();
    testMainWindowVisible = false;
    testNotificationSupported = true;
    testMainWindowShowCount = 0;
    testMessageBoxes.length = 0;
    testNotifications.length = 0;
    now += 180 * 60 * 1000 - 1;
    await runTrackedIntervalCallbacks();
    assert.equal(testMessageBoxes.length + testNotifications.length, 0);

    now += 1;
    await runTrackedIntervalCallbacks();
    assert.equal(testMessageBoxes.length, 0);
    assert.equal(testNotifications.length, 1);
    assert.equal(testNotifications[0].options.title, 'Crate — Still working?');
    assert.equal(
      testNotifications[0].options.body,
      'No new design files for "Three Hour Background Reminder" in 3 hours. Click to open Crate.'
    );
    assert.equal(testNotifications[0].options.silent, false);
    assert.equal(testNotifications[0].shown, true);
    assert.equal(typeof testNotifications[0].handlers.get('click'), 'function');

    testNotifications[0].handlers.get('click')();
    assert.equal(testMainWindowShowCount, 1);
    now += 180 * 60 * 1000 - 1;
    await runTrackedIntervalCallbacks();
    assert.equal(testNotifications.length, 1);
    now += 1;
    await runTrackedIntervalCallbacks();
    assert.equal(testNotifications.length, 2);
    assert.equal(testNotifications[1].options.title, 'Crate — Still working?');
    assert.equal(testNotifications[1].shown, true);
  } finally {
    Date.now = originalDateNow;
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
    testMainWindowShowCount = 0;
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
    assert.equal(testMainWindowShowCount, 0);

    await waitForNotificationShown(0);
    assert.equal(testBrowserWindowCreateCount, 0);
    assert.equal(testMainWindowShowCount, 0);

    testNotifications[0].handlers.get('failed')({}, new Error('blocked by macOS'));
    assert.equal(testBrowserWindowCreateCount, 0);
    assert.equal(testMainWindowShowCount, 0);

    testNotifications[0].handlers.get('click')();
    assert.equal(testBrowserWindowCreateCount, 0);
    assert.equal(testMainWindowShowCount, 1);
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
    testMainWindowShowCount = 0;
    testNotifications.length = 0;
    await callIpc('settings:update', 'notifications', true);

    const result = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(testNotifications.length, 0);
    assert.equal(testBrowserWindowCreateCount, 0);
    assert.equal(testMainWindowShowCount, 1);
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
    testMainWindowShowCount = 0;

    const selectedPath = await callIpc('projects:select-output');

    assert.equal(selectedPath, outputDir);
    assert.equal(testBrowserWindowCreateCount, 0);
    assert.equal(testMainWindowShowCount, 0);
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

test('review and staging share logical-byte dedup for PSD resources and display-extension mismatches', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Canonical Presentation Dedupe');
    const deckPath = path.join(tmpRoot, 'Deck.pptx');
    const physicalAssetPath = path.join(tmpRoot, 'Reference.assetbin');
    const parentPsd = path.join(tmpRoot, 'Parent.psd');
    const outputDir = path.join(tmpRoot, 'out');
    const sharedBytes = Buffer.from('CANONICAL_PRESENTATION_MEDIA_BYTES'.repeat(40));
    fs.mkdirSync(outputDir);
    fs.writeFileSync(deckPath, Buffer.from('stable presentation container'));
    fs.writeFileSync(physicalAssetPath, sharedBytes);
    fs.writeFileSync(parentPsd, Buffer.from('stable PSD container'));
    currentPsdFixture = {
      children: [],
      linkedFiles: [{ name: 'Embedded.png', data: sharedBytes }],
    };
    setPowerPointUnzipFixture([{
      internalPath: 'ppt/media/image1.png',
      data: sharedBytes,
    }]);
    await setProjectFiles(project.id, { files: [
      { path: deckPath, name: 'Deck.pptx', ext: '.pptx', addedAt: Date.now(), source: 'manual-browse' },
      {
        path: physicalAssetPath,
        name: 'Reference.png',
        ext: '.png',
        addedAt: Date.now(),
        source: 'manual-browse',
      },
      {
        path: parentPsd,
        parentPsd,
        name: 'Embedded.png',
        ext: '.png',
        source: 'scan-on-save-embedded',
        embedded: true,
        embeddedOriginalName: 'Embedded.png',
        embeddedIndex: 0,
        fileId: 'canonical-dedup-psd',
      },
    ] });

    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(review.materializable, true);
    assert.equal(typeof review.token, 'string');
    assert.deepEqual(review.files.map(file => file.name).sort(), ['Deck.pptx', 'Embedded.png', 'Reference.png']);

    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 3);
    assert.equal(result.embeddedCount, 0);
    assert.deepEqual(fs.readdirSync(result.folderPath).sort(), review.files.map(file => file.name).sort());
    assert.deepEqual(fs.readFileSync(path.join(result.folderPath, 'Reference.png')), sharedBytes);
    assert.deepEqual(fs.readFileSync(path.join(result.folderPath, 'Embedded.png')), sharedBytes);
    assert.equal(fs.existsSync(path.join(result.folderPath, 'Deck — image1.png')), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('PowerPoint extraction failure makes the reviewed derivative plan unavailable', async () => {
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
    const stored = await setProjectFiles(project.id, {
      files: [{
        path: pptxPath,
        name: 'Presentation1.pptx',
        ext: '.pptx',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    await callIpc('settings:update', 'includeDiagnosticReport', true);

    const before = capturePackageSideEffects(stored);
    const result = await callIpcRaw('projects:prepare-package-review', project.id);
    assertUnavailablePackageReview(result, 'Presentation1.pptx');
    assert.equal(JSON.stringify(result).includes(tmpRoot), false);
    assertFailedPackageHasNoSideEffects(stored, outputDir, before);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('PowerPoint archive inspection failure makes the reviewed derivative plan unavailable', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('PowerPoint Inspection Failure');
    const pptxPath = path.join(tmpRoot, 'Presentation1.pptx');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(pptxPath, Buffer.from('not a zip archive'));
    setPresentationUnzipListingFailure(new Error(`unzip RAW_STDERR RAW_STDOUT /private/tmp/crate-secret ${tmpRoot}`));
    const stored = await setProjectFiles(project.id, {
      files: [{
        path: pptxPath,
        name: 'Presentation1.pptx',
        ext: '.pptx',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    await callIpc('settings:update', 'includeDiagnosticReport', true);

    const before = capturePackageSideEffects(stored);
    const result = await callIpcRaw('projects:prepare-package-review', project.id);
    assertUnavailablePackageReview(result, 'Presentation1.pptx');
    assert.equal(JSON.stringify(result).includes(tmpRoot), false);
    assertFailedPackageHasNoSideEffects(stored, outputDir, before);
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

test('package completion persists provenance, status, output history, and quota in one store write', async () => {
  const tmpRoot = makeTempDir();
  const originalStoreSet = storeInstance.set;
  try {
    setChildProcessHandler(() => ({ stdout: '' }));
    const project = await createProject('Atomic package completion');
    const sourcePath = path.join(tmpRoot, 'atomic.ai');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, 'atomic package bytes');
    await setProjectFiles(project.id, {
      files: [{
        path: sourcePath,
        name: path.basename(sourcePath),
        ext: '.ai',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    const beforeOutputPaths = structuredClone(storeInstance.get('quickPackageOutputPaths', []));

    const completionWrites = [];
    storeInstance.set = function recordCompletionWrite(key, value) {
      if (
        key &&
        typeof key === 'object' &&
        Object.prototype.hasOwnProperty.call(key, 'projects') &&
        Object.prototype.hasOwnProperty.call(key, 'usage') &&
        Object.prototype.hasOwnProperty.call(key, 'quickPackageOutputPaths')
      ) completionWrites.push(structuredClone(key));
      return originalStoreSet.call(this, key, value);
    };

    const result = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    assert.equal(completionWrites.length, 1);

    const destFolder = packageFolder(outputDir, 'Atomic package completion');
    const completion = completionWrites[0];
    const completedProject = completion.projects.find(item => item.id === project.id);
    assert.equal(completedProject.status, 'packaged');
    assert.equal(typeof completedProject.packagedAt, 'number');
    assert.equal(completedProject.outputPath, destFolder);
    assert.equal(
      getProvenanceEdges(completedProject, EDGE_TYPES.PACKAGE_INCLUDES_FILE).length,
      1
    );
    assert.equal(completion.usage.packagesThisMonth, 1);
    assert.deepEqual(
      completion.quickPackageOutputPaths,
      [...beforeOutputPaths, destFolder].slice(-50)
    );

    const fresh = await getProject(project.id);
    assert.equal(fresh.status, 'packaged');
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 1);
    assert.deepEqual(
      storeInstance.get('quickPackageOutputPaths'),
      [...beforeOutputPaths, destFolder].slice(-50)
    );
    assert.equal(fs.readFileSync(path.join(destFolder, 'atomic.ai'), 'utf8'), 'atomic package bytes');
  } finally {
    storeInstance.set = originalStoreSet;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('package completion store failure removes published output and preserves all prior state', async () => {
  const tmpRoot = makeTempDir();
  const originalStoreSet = storeInstance.set;
  try {
    setChildProcessHandler(() => ({ stdout: '' }));
    for (const [label, layoutMode] of [
      ['flat', PACKAGE_OUTPUT_LAYOUT_MODES.FLAT],
      ['organized', PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION],
    ]) {
      storeInstance.set = originalStoreSet;
      storeInstance.set('settings.packageOutputLayoutMode', layoutMode);
      const projectName = `Atomic completion failure ${label}`;
      const project = await createProject(projectName);
      const sourcePath = path.join(tmpRoot, `${label}.ai`);
      const outputDir = path.join(tmpRoot, `out-${label}`);
      fs.mkdirSync(outputDir);
      fs.writeFileSync(sourcePath, `${label} completion failure bytes`);
      await setProjectFiles(project.id, {
        files: [{
          path: sourcePath,
          name: path.basename(sourcePath),
          ext: '.ai',
          addedAt: Date.now(),
          source: 'manual-browse',
        }],
      });
      const beforeProject = structuredClone(await getProject(project.id));
      const beforeUsage = structuredClone(storeInstance.get('usage'));
      const beforeOutputPaths = structuredClone(storeInstance.get('quickPackageOutputPaths', []));
      let completionWriteAttempts = 0;
      storeInstance.set = function failCompletionWrite(key, value) {
        if (
          key &&
          typeof key === 'object' &&
          Object.prototype.hasOwnProperty.call(key, 'projects') &&
          Object.prototype.hasOwnProperty.call(key, 'usage') &&
          Object.prototype.hasOwnProperty.call(key, 'quickPackageOutputPaths')
        ) {
          completionWriteAttempts++;
          throw new Error('forced package completion persistence failure');
        }
        return originalStoreSet.call(this, key, value);
      };
      testNotificationSupported = true;
      testNotifications.length = 0;

      const result = await callIpc('projects:package', project.id, outputDir);
      assert.deepEqual(result, { error: 'forced package completion persistence failure' });
      assert.equal(completionWriteAttempts, 1);
      assert.equal(fs.existsSync(packageFolder(outputDir, projectName)), false);
      assert.deepEqual(await getProject(project.id), beforeProject);
      assert.deepEqual(storeInstance.get('usage'), beforeUsage);
      assert.deepEqual(storeInstance.get('quickPackageOutputPaths', []), beforeOutputPaths);
      assert.equal(testNotifications.length, 0);
    }
  } finally {
    storeInstance.set = originalStoreSet;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('diagnostic manifest package transaction preserves normal modes and fails closed after a partial write', async () => {
  const tmpRoot = makeTempDir();
  const originalOpen = fs.promises.open;
  try {
    setChildProcessHandler(() => ({ stdout: '' }));
    const sourcePath = path.join(tmpRoot, 'diagnostic-source.ai');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, 'diagnostic source bytes');
    storeInstance.set('usage.packagesThisMonth', 0);

    const packageDiagnosticProject = async (projectName, includeDiagnosticReport) => {
      const project = await createProject(projectName);
      await setProjectFiles(project.id, {
        files: [{
          path: sourcePath,
          name: path.basename(sourcePath),
          ext: '.ai',
          addedAt: Date.now(),
          source: 'manual-browse',
        }],
      });
      await callIpc('settings:update', 'includeDiagnosticReport', includeDiagnosticReport);
      return {
        project,
        result: await callIpc('projects:package', project.id, outputDir),
      };
    };

    const disabled = await packageDiagnosticProject('Diagnostic transaction disabled', false);
    assertPackageResultShape(disabled.result);
    assert.equal(disabled.result.success, true);
    assert.equal(fs.existsSync(manifestPath(outputDir, 'Diagnostic transaction disabled')), false);
    assert.equal(
      fs.readFileSync(
        path.join(packageFolder(outputDir, 'Diagnostic transaction disabled'), path.basename(sourcePath)),
        'utf8'
      ),
      'diagnostic source bytes'
    );
    let fresh = await getProject(disabled.project.id);
    assert.equal(fresh.status, 'packaged');
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 1);
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 1);

    const enabled = await packageDiagnosticProject('Diagnostic transaction enabled', true);
    assertPackageResultShape(enabled.result);
    assert.equal(enabled.result.success, true);
    assert.equal(readManifest(outputDir, 'Diagnostic transaction enabled').schemaVersion, 2);
    fresh = await getProject(enabled.project.id);
    assert.equal(fresh.status, 'packaged');
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 1);
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 2);

    const failingName = 'Diagnostic transaction partial FD failure';
    const failingProject = await createProject(failingName);
    await setProjectFiles(failingProject.id, {
      files: [{
        path: sourcePath,
        name: path.basename(sourcePath),
        ext: '.ai',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    await callIpc('settings:update', 'includeDiagnosticReport', true);

    const failingManifestPath = manifestPath(outputDir, failingName);
    let injectedFailure = false;
    fs.promises.open = async function partialManifestWrite(filePath, flags, ...args) {
      const handle = await originalOpen.call(fs.promises, filePath, flags, ...args);
      if (
        typeof filePath === 'string' &&
        flags === 'wx' &&
        path.basename(filePath) === 'crate-provenance.json' &&
        path.basename(path.dirname(filePath)) === 'Crate Diagnostics'
      ) {
        const originalHandleWriteFile = handle.writeFile.bind(handle);
        handle.writeFile = async () => {
          if (!injectedFailure) {
            injectedFailure = true;
            await originalHandleWriteFile('{"schemaVersion":');
            throw new Error('forced diagnostic manifest partial write');
          }
        };
      }
      return handle;
    };

    testRendererEvents.length = 0;
    testNotifications.length = 0;
    let failureResult;
    try {
      failureResult = await callIpc('projects:package', failingProject.id, outputDir);
    } finally {
      fs.promises.open = originalOpen;
    }

    assert.equal(injectedFailure, true);
    assert.deepEqual(failureResult, { error: 'diagnostic_manifest_write_failed' });
    assert.equal(Object.prototype.hasOwnProperty.call(failureResult, 'success'), false);
    assert.equal(fs.existsSync(packageFolder(outputDir, failingName)), false);
    assert.equal(fs.existsSync(failingManifestPath), false);
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 2);
    fresh = await getProject(failingProject.id);
    assert.notEqual(fresh.status, 'packaged');
    assert.equal(fresh.packagedAt == null, true);
    assert.equal(fresh.outputPath == null, true);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 0);
    assert.equal(getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE).length, 0);
    assert.equal(testRendererEvents.some(entry => entry.channel === 'project:updated'), false);
    assert.equal(testNotifications.length, 0);
  } finally {
    fs.promises.open = originalOpen;
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

    await settleAssetBaselineForUnrelatedPackageTest(project.id);
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
    assert.deepEqual(Object.keys(extracted).sort(), ['addedAt', 'assetOrigin', 'ext', 'name', 'path', 'projectRole', 'source']);
    assert.equal(extracted.assetOrigin, 'added');
    assert.equal(extracted.projectRole, 'asset');
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
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.scope, 'minimized_package_relevant');
    assert.equal(manifest.package.copiedCount, 1);
    assert.equal(manifest.package.embeddedCount, 2);
    assert.equal(manifest.package.totalFiles, 1);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 1);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE).length, 2);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 2);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE).length, 2);
    const manifestText = JSON.stringify(manifest);
    assert.equal(manifestText.includes('Data/photo-1234.jpeg'), false);
    assert.equal(manifestText.includes('Deck — photo.jpeg'), false);
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
    assert.equal(manifest.package.errorCount, 0);
    assert.deepEqual(manifest.package.errorCategories, {});
    const manifestText = JSON.stringify(manifest);
    assert.equal(manifestText.includes('Keynote Deck — image2.png'), false);
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
    assert.equal(manifest.package.errorCount, 0);
    assert.deepEqual(manifest.package.errorCategories, {});
    const manifestText = JSON.stringify(manifest);
    assert.equal(manifestText.includes('Keynote Deck — Screenshot 2026-03-10 at 9.07.43 PM.png'), false);
    assert.equal(manifestText.includes('KEYNOTE_EXACT_SCREENSHOT_BINARY_SHOULD_NOT_LEAK'), false);
    assert.equal(manifestText.includes('KEYNOTE_MIXED_MOJIBAKE_BINARY_SHOULD_NOT_LEAK'), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Keynote ambiguous mojibake wildcard tails make the reviewed derivative plan unavailable', async () => {
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
    const stored = await setProjectFiles(project.id, {
      files: [{
        path: keynotePath,
        name: 'Keynote Deck.key',
        ext: '.key',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    await callIpc('settings:update', 'includeDiagnosticReport', true);

    const before = capturePackageSideEffects(stored);
    const result = await callIpcRaw('projects:prepare-package-review', project.id);
    assertUnavailablePackageReview(result, 'Keynote Deck.key');
    assert.equal(JSON.stringify(result).includes(tmpRoot), false);
    assertFailedPackageHasNoSideEffects(stored, outputDir, before);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Keynote extraction failure makes the reviewed derivative plan unavailable', async () => {
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
    const stored = await setProjectFiles(project.id, {
      files: [{
        path: keynotePath,
        name: 'Presentation1.key',
        ext: '.key',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    await callIpc('settings:update', 'includeDiagnosticReport', true);

    const before = capturePackageSideEffects(stored);
    const result = await callIpcRaw('projects:prepare-package-review', project.id);
    assertUnavailablePackageReview(result, 'Presentation1.key');
    assert.equal(JSON.stringify(result).includes(tmpRoot), false);
    assertFailedPackageHasNoSideEffects(stored, outputDir, before);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Keynote archive inspection failure makes the reviewed derivative plan unavailable', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('Keynote Inspection Failure');
    const keynotePath = path.join(tmpRoot, 'Presentation1.key');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(keynotePath, Buffer.from('not a zip archive'));
    setPresentationUnzipListingFailure(new Error(`unzip RAW_STDERR RAW_STDOUT /private/tmp/crate-secret ${tmpRoot}`));
    const stored = await setProjectFiles(project.id, {
      files: [{
        path: keynotePath,
        name: 'Presentation1.key',
        ext: '.key',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    await callIpc('settings:update', 'includeDiagnosticReport', true);

    const before = capturePackageSideEffects(stored);
    const result = await callIpcRaw('projects:prepare-package-review', project.id);
    assertUnavailablePackageReview(result, 'Presentation1.key');
    assert.equal(JSON.stringify(result).includes(tmpRoot), false);
    assertFailedPackageHasNoSideEffects(stored, outputDir, before);
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

    await settleAssetBaselineForUnrelatedPackageTest(project.id);
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

test('new projects start with an unresolved first-scan baseline and no exclusions', async () => {
  const project = await createProject('Asset review baseline');

  assert.deepEqual(project.assetBaseline, {
    schemaVersion: 1,
    status: 'awaiting-first-scan',
    decision: null,
    establishedAt: null,
  });
  assert.deepEqual(project.excludedAssetKeys, []);
});

test('automatic files remain origin-unresolved until the first dependable scan establishes a baseline', async () => {
  const project = await createProject('Unresolved first scan origin');
  const sourcePath = path.join(os.tmpdir(), 'First Scan Source.indd');
  const linkedPath = path.join(os.tmpdir(), 'First Scan Linked.ai');
  await setProjectFiles(project.id, {
    files: [{
      path: sourcePath,
      name: path.basename(sourcePath),
      ext: '.indd',
      addedAt: Date.now(),
      source: 'app-opened',
    }],
    pendingFiles: [{
      path: linkedPath,
      name: path.basename(linkedPath),
      ext: '.ai',
      addedAt: Date.now(),
      source: 'scan-on-open',
    }],
    preserveAwaitingAssetBaseline: true,
  });

  const fresh = await getProject(project.id);

  assert.equal(Object.hasOwn(fresh.files[0], 'assetOrigin'), false);
  assert.equal(Object.hasOwn(fresh.pendingFiles[0], 'assetOrigin'), false);
  assert.equal(fresh.files[0].projectRole, 'source');
  assert.equal(fresh.pendingFiles[0].projectRole, 'asset');
});

test('established first-scan boundary separates existing assets from files added while working', async () => {
  const project = await createProject('Established first scan boundary');
  const stored = storeInstance.data.projects.find(item => item.id === project.id);
  const establishedAt = stored.watchStartedAt + 1000;
  stored.assetBaseline = {
    schemaVersion: 1,
    status: 'decision-required',
    decision: null,
    establishedAt,
  };
  stored.files = [
    {
      path: path.join(os.tmpdir(), 'Existing Before Boundary.png'),
      name: 'Existing Before Boundary.png',
      ext: '.png',
      addedAt: establishedAt - 1,
      source: 'scan-on-open',
    },
    {
      path: path.join(os.tmpdir(), 'Existing At Boundary.png'),
      name: 'Existing At Boundary.png',
      ext: '.png',
      addedAt: establishedAt,
      source: 'scan-on-open',
    },
    {
      path: path.join(os.tmpdir(), 'Added After Boundary.png'),
      name: 'Added After Boundary.png',
      ext: '.png',
      addedAt: establishedAt + 1,
      source: 'scan-on-open',
    },
    {
      path: path.join(os.tmpdir(), 'Explicit Add Before Boundary.png'),
      name: 'Explicit Add Before Boundary.png',
      ext: '.png',
      addedAt: establishedAt - 1,
      source: 'manual-browse',
    },
  ];

  const fresh = await getProject(project.id);

  assert.deepEqual(
    fresh.files.map(file => [file.name, file.assetOrigin]),
    [
      ['Existing Before Boundary.png', 'existing'],
      ['Existing At Boundary.png', 'existing'],
      ['Added After Boundary.png', 'added'],
      ['Explicit Add Before Boundary.png', 'added'],
    ]
  );
});

test('first dependable source scan requires an existing-assets decision and binds package review to it', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-existing-assets-test-'));
  try {
    const sourcePath = path.join(fixtureRoot, 'Existing Project.ai');
    const linkedPath = path.join(fixtureRoot, 'Existing Linked.png');
    const outputDir = path.join(fixtureRoot, 'output');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(linkedPath, 'existing linked bytes');
    writeSyntheticAiFile(sourcePath, `synthetic illustrator link ${linkedPath}`);

    const project = await createProject('Existing assets decision');
    manualDialogFor([sourcePath]);
    await callIpc('projects:add-files', project.id);

    let fresh = await waitForProject(
      project.id,
      item => item.assetBaseline && item.assetBaseline.status === 'decision-required'
    );
    assert.equal(fresh.assetBaseline.status, 'decision-required');
    assert.equal(Number.isFinite(fresh.assetBaseline.establishedAt), true);
    assert.equal(fresh.assetBaseline.decision, null);
    const linkedFile = fresh.files.find(file => file.path === linkedPath);
    assert.ok(linkedFile);
    assert.equal(linkedFile.assetOrigin, 'existing');
    assert.equal(fresh.assetBaseline.establishedAt <= linkedFile.addedAt, true);
    assert.deepEqual(
      fresh.files.map(file => [file.name, file.assetOrigin, file.projectRole]),
      [
        ['Existing Project.ai', 'added', 'source'],
        ['Existing Linked.png', 'existing', 'asset'],
      ]
    );

    const blockedReview = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(blockedReview.error, 'asset_baseline_decision_required');

    const skipped = await callIpcRaw('projects:set-existing-assets-decision', project.id, 'skip');
    assert.equal(skipped.success, true);
    fresh = await getProject(project.id);
    assert.equal(fresh.assetBaseline.status, 'skipped');
    assert.equal(fresh.assetBaseline.decision, 'skip');
    assert.deepEqual(fresh.excludedAssetKeys, [linkedPath]);
    const skippedReview = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.deepEqual(skippedReview.files.map(file => file.name), ['Existing Project.ai']);

    const included = await callIpcRaw('projects:set-existing-assets-decision', project.id, 'include');
    assert.equal(included.success, true);
    fresh = await getProject(project.id);
    assert.equal(fresh.assetBaseline.status, 'included');
    assert.equal(fresh.assetBaseline.decision, 'include');
    assert.deepEqual(fresh.excludedAssetKeys, []);
    const includedReview = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.deepEqual(
      includedReview.files.map(file => file.name).sort(),
      ['Existing Linked.png', 'Existing Project.ai']
    );
    const reviewedSource = includedReview.files.find(file => file.name === 'Existing Project.ai');
    const reviewedLinked = includedReview.files.find(file => file.name === 'Existing Linked.png');
    assert.equal(reviewedSource.projectRole, 'source');
    assert.equal(reviewedSource.assetOrigin, 'added');
    assert.equal(reviewedSource.appFamily, 'illustrator');
    assert.equal(reviewedLinked.projectRole, 'asset');
    assert.equal(reviewedLinked.assetOrigin, 'existing');
    assert.equal(reviewedLinked.appFamily, 'illustrator');
    assert.equal(reviewedLinked.sourceName, 'Existing Project.ai');

    const workspace = await callIpcRaw('projects:get-asset-workspace', project.id);
    const sourcePresentation = workspace.files.find(file => file.name === 'Existing Project.ai');
    const linkedPresentation = workspace.files.find(file => file.name === 'Existing Linked.png');
    assert.equal(sourcePresentation.appFamily, 'illustrator');
    assert.equal(sourcePresentation.sourceName, null);
    assert.equal(linkedPresentation.appFamily, 'illustrator');
    assert.equal(linkedPresentation.sourceName, 'Existing Project.ai');
    assert.equal(Object.hasOwn(linkedPresentation, 'path'), false);
    const staleBeforeExclusion = await callIpcRaw('projects:prepare-package-review', project.id, outputDir);
    await callIpcRaw('projects:remove-file', project.id, linkedPresentation.visualIdentity);
    fresh = await getProject(project.id);
    assert.equal(fresh.files.some(file => file.path === linkedPath), true);
    assert.equal(fresh.excludedAssetKeys.includes(linkedPath), true);
    assert.equal(
      (await callIpcRaw('projects:package', project.id, outputDir, staleBeforeExclusion.token)).error,
      'package_review_stale'
    );
    assert.deepEqual(fs.readdirSync(outputDir), []);
    const excludedWorkspace = await callIpcRaw('projects:get-asset-workspace', project.id);
    assert.equal(excludedWorkspace.files.find(file => file.name === 'Existing Linked.png').excluded, true);
    const excludedReview = await callIpcRaw('projects:prepare-package-review', project.id, outputDir);
    assert.deepEqual(excludedReview.files.map(file => file.name), ['Existing Project.ai']);

    assert.equal((await callIpcRaw('projects:set-existing-assets-decision', project.id, 'include')).success, true);
    fresh = await getProject(project.id);
    assert.equal(fresh.files.some(file => file.path === linkedPath), true);
    assert.deepEqual(fresh.excludedAssetKeys, []);
    const restoredReview = await callIpcRaw('projects:prepare-package-review', project.id, outputDir);
    assert.deepEqual(
      restoredReview.files.map(file => file.name).sort(),
      ['Existing Linked.png', 'Existing Project.ai']
    );

    assert.equal((await callIpcRaw('projects:set-existing-assets-decision', project.id, 'skip')).success, true);
    fresh = await getProject(project.id);
    assert.equal(fresh.files.some(file => file.path === linkedPath), true);
    assert.equal(fresh.excludedAssetKeys.includes(linkedPath), true);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('renderer presentation exposes a privacy-safe Figma working-file name', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-figma-presentation-test-'));
  try {
    const assetPath = path.join(fixtureRoot, 'Petra_Logo_Asset.png');
    fs.writeFileSync(assetPath, 'synthetic figma asset');
    const presentation = await metadataTestHooks.createRendererFilePresentation(
      { id: 'figma-working-file-presentation', files: [], excludedAssetKeys: [] },
      {
        path: assetPath,
        name: 'Petra_Logo_Asset.png',
        ext: '.png',
        source: 'figma-auto',
        figmaFileName: 'Petra Logo',
        assetOrigin: 'added',
        projectRole: 'asset',
      }
    );

    assert.equal(presentation.appFamily, 'figma');
    assert.equal(presentation.sourceName, 'Petra Logo');
    assert.equal(Object.hasOwn(presentation, 'path'), false);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('renderer presentation rejects path-shaped and URL-shaped source metadata', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-source-name-privacy-test-'));
  try {
    const assetPath = path.join(fixtureRoot, 'Linked.png');
    fs.writeFileSync(assetPath, createSyntheticPngBytes());
    const presentation = await metadataTestHooks.createRendererFilePresentation(
      { id: 'source-name-privacy', files: [], excludedAssetKeys: [] },
      {
        path: assetPath,
        name: 'Linked.png',
        ext: '.png',
        source: 'ai-linked',
        captureEvidence: { sourceName: '/Users/private/Client/Working.ai' },
        assetOrigin: 'existing',
        projectRole: 'asset',
      }
    );

    assert.equal(presentation.sourceName, null);
    assert.equal(JSON.stringify(presentation).includes('/Users/private/'), false);

    const urlPresentation = await metadataTestHooks.createRendererFilePresentation(
      { id: 'source-name-url-privacy', files: [], excludedAssetKeys: [] },
      {
        path: assetPath,
        name: 'Linked.png',
        ext: '.png',
        source: 'ai-linked',
        captureEvidence: { sourceName: 'https://private.example/client/Working.ai' },
        assetOrigin: 'existing',
        projectRole: 'asset',
      }
    );
    assert.equal(urlPresentation.sourceName, null);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('migrated legacy-included projects support Include All and Skip All with authoritative output selection', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-legacy-assets-decision-test-'));
  try {
    const makeLegacyProject = async name => {
      const sourcePath = path.join(fixtureRoot, `${name}.ai`);
      const assetPath = path.join(fixtureRoot, `${name}.png`);
      const outputDir = path.join(fixtureRoot, `${name}-out`);
      writeSyntheticAiFile(sourcePath);
      fs.writeFileSync(assetPath, createSyntheticPngBytes());
      fs.mkdirSync(outputDir);
      const project = await createProject(name);
      const stored = storeInstance.data.projects.find(item => item.id === project.id);
      stored.assetBaseline = {
        schemaVersion: 1,
        status: 'legacy-included',
        decision: 'include',
        establishedAt: stored.watchStartedAt || stored.createdAt,
      };
      stored.files = [
        makePendingFile(sourcePath, 'manual-browse'),
        makePendingFile(assetPath, 'scan-on-open'),
      ];
      stored.pendingFiles = [];
      stored.excludedAssetKeys = [];
      return { project, sourcePath, assetPath, outputDir };
    };

    const skipped = await makeLegacyProject('Legacy Skip');
    const staleSkipReview = await callIpcRaw('projects:prepare-package-review', skipped.project.id, skipped.outputDir);
    assert.equal(staleSkipReview.materializable, true);
    assert.equal((await callIpcRaw('projects:set-existing-assets-decision', skipped.project.id, 'skip')).success, true);
    assert.equal(
      (await callIpcRaw('projects:package', skipped.project.id, skipped.outputDir, staleSkipReview.token)).error,
      'package_review_stale'
    );
    assert.deepEqual(fs.readdirSync(skipped.outputDir), []);
    const skipReview = await callIpcRaw('projects:prepare-package-review', skipped.project.id, skipped.outputDir);
    assert.deepEqual(skipReview.files.map(file => file.name), ['Legacy Skip.ai']);
    const skipResult = await callIpcRaw('projects:package', skipped.project.id, skipped.outputDir, skipReview.token);
    assert.equal(skipResult.success, true);
    assert.deepEqual(fs.readdirSync(skipResult.folderPath), ['Legacy Skip.ai']);

    const included = await makeLegacyProject('Legacy Include');
    const staleIncludeReview = await callIpcRaw('projects:prepare-package-review', included.project.id, included.outputDir);
    assert.equal((await callIpcRaw('projects:set-existing-assets-decision', included.project.id, 'include')).success, true);
    assert.equal(
      (await callIpcRaw('projects:package', included.project.id, included.outputDir, staleIncludeReview.token)).error,
      'package_review_stale'
    );
    const includeReview = await callIpcRaw('projects:prepare-package-review', included.project.id, included.outputDir);
    assert.deepEqual(
      includeReview.files.map(file => file.name).sort(),
      ['Legacy Include.ai', 'Legacy Include.png']
    );
    const includeResult = await callIpcRaw('projects:package', included.project.id, included.outputDir, includeReview.token);
    assert.equal(includeResult.success, true);
    assert.deepEqual(
      fs.readdirSync(includeResult.folderPath).sort(),
      ['Legacy Include.ai', 'Legacy Include.png']
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('Skip Existing excludes baseline PowerPoint media while later saved media remains packageable', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-presentation-baseline-skip-test-'));
  try {
    resetPresentationCacheRoot();
    const sourcePath = path.join(fixtureRoot, 'Existing Deck.pptx');
    const outputDir = path.join(fixtureRoot, 'out');
    const existingMedia = Buffer.from('EXISTING_POWERPOINT_MEDIA'.repeat(40));
    const addedMedia = Buffer.from('ADDED_POWERPOINT_MEDIA'.repeat(40));
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, 'synthetic PowerPoint container');
    setPowerPointUnzipFixture([{
      internalPath: 'ppt/media/image1.png',
      data: existingMedia,
    }]);

    const project = await createProject('Presentation baseline skip');
    manualDialogFor([sourcePath]);
    await callIpcRaw('projects:add-files', project.id);
    let fresh = await waitForProject(
      project.id,
      item => item.assetBaseline && item.assetBaseline.status === 'decision-required'
    );
    const baselineMedia = fresh.files.find(file => file.source === 'scan-on-save-presentation');
    assert.ok(baselineMedia);
    assert.equal(baselineMedia.assetOrigin, 'existing');
    assert.equal(baselineMedia.projectRole, 'asset');
    assert.equal(baselineMedia.assetBaselineSourcePath, sourcePath);
    assert.equal(typeof baselineMedia.presentationContentFingerprint, 'string');

    const skipped = await callIpcRaw('projects:set-existing-assets-decision', project.id, 'skip');
    assert.equal(skipped.success, true);
    let review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.deepEqual(review.files.map(file => file.name), ['Existing Deck.pptx']);

    setPowerPointUnzipFixture([
      { internalPath: 'ppt/media/image1.png', data: existingMedia },
      { internalPath: 'ppt/media/image2.png', data: addedMedia },
    ]);
    fs.writeFileSync(sourcePath, 'synthetic PowerPoint container after save');
    await emitWatcher('change', sourcePath);
    fresh = await waitForProject(
      project.id,
      item => item.files.some(file => (
        file.source === 'scan-on-save-presentation' &&
        file.assetOrigin === 'added'
      )),
      6000
    );
    const addedEntry = fresh.files.find(file => (
      file.source === 'scan-on-save-presentation' &&
      file.assetOrigin === 'added'
    ));
    assert.ok(addedEntry);
    assert.equal(fs.readFileSync(addedEntry.path, 'utf8'), addedMedia.toString('utf8'));

    review = await callIpcRaw('projects:prepare-package-review', project.id, outputDir);
    assert.deepEqual(
      review.files.map(file => file.name).sort(),
      ['Existing Deck — image2.png', 'Existing Deck.pptx']
    );

    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 2);
    assert.equal(result.embeddedCount, 0);
    assert.deepEqual(fs.readdirSync(result.folderPath).sort(), [
      'Existing Deck — image2.png',
      'Existing Deck.pptx',
    ]);
    assert.equal(fs.existsSync(path.join(result.folderPath, 'Existing Deck — image1.png')), false);
  } finally {
    setChildProcessHandler(null);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('Skip Existing suppresses only baseline PowerPoint occurrences when later media has identical bytes', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-presentation-baseline-occurrence-test-'));
  try {
    resetPresentationCacheRoot();
    const sourcePath = path.join(fixtureRoot, 'Occurrence Deck.pptx');
    const outputDir = path.join(fixtureRoot, 'out');
    const repeatedMedia = Buffer.from('REPEATED_POWERPOINT_MEDIA'.repeat(40));
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, 'synthetic PowerPoint container');
    setPowerPointUnzipFixture([{
      internalPath: 'ppt/media/image1.png',
      data: repeatedMedia,
    }]);

    const project = await createProject('Presentation occurrence skip');
    manualDialogFor([sourcePath]);
    await callIpcRaw('projects:add-files', project.id);
    let fresh = await waitForProject(
      project.id,
      item => item.assetBaseline && item.assetBaseline.status === 'decision-required'
    );
    assert.equal(fresh.assetBaseline.presentationMediaOccurrences.length, 1);

    const skipped = await callIpcRaw('projects:set-existing-assets-decision', project.id, 'skip');
    assert.equal(skipped.success, true);
    setPowerPointUnzipFixture([
      { internalPath: 'ppt/media/image1.png', data: repeatedMedia },
      { internalPath: 'ppt/media/image2.png', data: repeatedMedia },
    ]);
    fs.writeFileSync(sourcePath, 'synthetic PowerPoint container with repeated later media');

    const review = await callIpcRaw('projects:prepare-package-review', project.id, outputDir);
    assert.equal(review.materializable, true);
    assert.deepEqual(review.files.map(file => file.name), ['Occurrence Deck.pptx']);

    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.embeddedCount, 1);
    assert.deepEqual(fs.readdirSync(result.folderPath).sort(), [
      'Occurrence Deck — image2.png',
      'Occurrence Deck.pptx',
    ]);
    assert.equal(fs.existsSync(path.join(result.folderPath, 'Occurrence Deck — image1.png')), false);
  } finally {
    setChildProcessHandler(null);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('failed presentation baseline extraction rolls back files created by that invocation', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-presentation-baseline-rollback-test-'));
  try {
    resetPresentationCacheRoot();
    const sourcePath = path.join(fixtureRoot, 'Partial Baseline.pptx');
    fs.writeFileSync(sourcePath, 'synthetic PowerPoint container');
    setPowerPointUnzipFixture([
      {
        internalPath: 'ppt/media/image1.png',
        data: Buffer.from('FIRST_BASELINE_MEDIA'.repeat(40)),
      },
      {
        internalPath: 'ppt/media/image2.png',
        data: Buffer.from('SECOND_BASELINE_MEDIA'.repeat(40)),
        error: new Error('forced second-entry extraction failure'),
      },
    ]);

    const project = await createProject('Partial presentation baseline');
    manualDialogFor([sourcePath]);
    await callIpcRaw('projects:add-files', project.id);

    const fresh = await getProject(project.id);
    assert.equal(fresh.assetBaseline.status, 'awaiting-first-scan');
    assert.equal(fresh.files.some(file => file.source === 'scan-on-save-presentation'), false);
    const cacheDir = presentationCachePaths(project.id).projectDir;
    assert.deepEqual(fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : [], []);
  } finally {
    setChildProcessHandler(null);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('stale presentation baseline extraction rolls back files created before deactivation', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-presentation-baseline-stale-rollback-test-'));
  let releaseSecondRead = () => {};
  try {
    resetPresentationCacheRoot();
    const sourcePath = path.join(fixtureRoot, 'Stale Baseline.pptx');
    fs.writeFileSync(sourcePath, 'synthetic PowerPoint container');
    const secondReadGate = new Promise(resolve => { releaseSecondRead = resolve; });
    let markSecondReadStarted;
    const secondReadStarted = new Promise(resolve => { markSecondReadStarted = resolve; });
    setPowerPointUnzipFixture([
      {
        internalPath: 'ppt/media/image1.png',
        data: Buffer.from('FIRST_STALE_BASELINE_MEDIA'.repeat(40)),
      },
      {
        internalPath: 'ppt/media/image2.png',
        data: Buffer.from('SECOND_STALE_BASELINE_MEDIA'.repeat(40)),
      },
    ], {
      onReadStart: internalPath => {
        if (internalPath === 'ppt/media/image2.png') markSecondReadStarted();
      },
      readGateForPath: internalPath => (
        internalPath === 'ppt/media/image2.png' ? secondReadGate : null
      ),
    });

    const project = await createProject('Stale presentation baseline');
    manualDialogFor([sourcePath]);
    const addPromise = callIpcRaw('projects:add-files', project.id);
    await secondReadStarted;
    await callIpcRaw('projects:pause', project.id);
    releaseSecondRead();
    await addPromise;

    const fresh = await getProject(project.id);
    assert.equal(fresh.status, 'paused');
    assert.equal(fresh.files.some(file => file.source === 'scan-on-save-presentation'), false);
    const cacheDir = presentationCachePaths(project.id).projectDir;
    assert.deepEqual(fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : [], []);
  } finally {
    releaseSecondRead();
    setChildProcessHandler(null);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('Skip Existing excludes baseline Keynote media from review and physical output', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-keynote-baseline-skip-test-'));
  try {
    resetPresentationCacheRoot();
    const sourcePath = path.join(fixtureRoot, 'Existing Keynote.key');
    const outputDir = path.join(fixtureRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(sourcePath, 'synthetic Keynote container');
    setKeynoteUnzipFixture([{
      internalPath: 'Data/existing-photo-1234.jpeg',
      data: Buffer.from('EXISTING_KEYNOTE_MEDIA'.repeat(40)),
    }]);

    const project = await createProject('Keynote baseline skip');
    manualDialogFor([sourcePath]);
    await callIpcRaw('projects:add-files', project.id);
    const fresh = await waitForProject(
      project.id,
      item => item.assetBaseline && item.assetBaseline.status === 'decision-required'
    );
    const baselineMedia = fresh.files.find(file => file.source === 'scan-on-save-presentation');
    assert.ok(baselineMedia);
    assert.equal(baselineMedia.assetOrigin, 'existing');
    assert.equal(baselineMedia.assetBaselineSourcePath, sourcePath);

    const skipped = await callIpcRaw('projects:set-existing-assets-decision', project.id, 'skip');
    assert.equal(skipped.success, true);
    const review = await callIpcRaw('projects:prepare-package-review', project.id, outputDir);
    assert.deepEqual(review.files.map(file => file.name), ['Existing Keynote.key']);

    const result = await callIpcRaw('projects:package', project.id, outputDir, review.token);
    assert.equal(result.success, true);
    assert.equal(result.copiedCount, 1);
    assert.equal(result.embeddedCount, 0);
    assert.deepEqual(fs.readdirSync(result.folderPath), ['Existing Keynote.key']);
  } finally {
    setChildProcessHandler(null);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('first dependable scan of a blank source records an empty baseline without prompting', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-empty-baseline-test-'));
  try {
    const sourcePath = path.join(fixtureRoot, 'Blank Project.ai');
    writeSyntheticAiFile(sourcePath);

    const project = await createProject('Blank source baseline');
    manualDialogFor([sourcePath]);
    await callIpc('projects:add-files', project.id);

    const fresh = await waitForProject(
      project.id,
      item => item.assetBaseline && item.assetBaseline.status === 'empty'
    );
    assert.equal(fresh.assetBaseline.status, 'empty');
    assert.equal(fresh.assetBaseline.decision, null);
    assert.equal(Number.isFinite(fresh.assetBaseline.establishedAt), true);
    assert.deepEqual(fresh.files.map(file => [file.name, file.assetOrigin, file.projectRole]), [
      ['Blank Project.ai', 'added', 'source'],
    ]);

    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.deepEqual(review.files.map(file => file.name), ['Blank Project.ai']);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('Added While Working exclusions stay reviewable and restore through the same control or Explicit Add Files', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-added-assets-exclusion-test-'));
  try {
    const sourcePath = path.join(fixtureRoot, 'Working Project.ai');
    const addedAssetPath = path.join(fixtureRoot, 'Added While Working.png');
    const outputDir = path.join(fixtureRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(addedAssetPath, 'added while working bytes');
    writeSyntheticAiFile(sourcePath);

    const project = await createProject('Added While Working exclusion');
    manualDialogFor([sourcePath]);
    await callIpcRaw('projects:add-files', project.id);
    let fresh = await waitForProject(
      project.id,
      item => item.assetBaseline && item.assetBaseline.status === 'empty'
    );

    writeSyntheticAiFile(sourcePath, `synthetic Illustrator link ${addedAssetPath}`);
    await emitWatcher('change', sourcePath);
    fresh = await waitForProject(
      project.id,
      item => item.files.some(file => file.path === addedAssetPath)
    );
    const addedAsset = fresh.files.find(file => file.path === addedAssetPath);
    assert.equal(addedAsset.assetOrigin, 'added');
    assert.equal(addedAsset.projectRole, 'asset');
    assert.equal(fresh.pendingFiles.some(file => file.path === addedAssetPath), false);

    await callIpcRaw('projects:remove-file', project.id, addedAsset.fileId || addedAsset.path);
    fresh = await getProject(project.id);
    assert.equal(fresh.files.some(file => file.path === addedAssetPath), true);
    assert.equal(fresh.excludedAssetKeys.includes(addedAsset.fileId || addedAsset.path), true);
    let workspace = await callIpcRaw('projects:get-asset-workspace', project.id);
    assert.equal(workspace.files.find(file => file.name === 'Added While Working.png').excluded, true);

    await emitWatcher('change', sourcePath);
    fresh = await getProject(project.id);
    assert.equal(fresh.files.filter(file => file.path === addedAssetPath).length, 1);
    assert.equal(fresh.pendingFiles.some(file => file.path === addedAssetPath), false);
    const excludedReview = await callIpcRaw('projects:prepare-package-review', project.id, outputDir);
    assert.deepEqual(excludedReview.files.map(file => file.name), ['Working Project.ai']);

    await callIpcRaw('projects:remove-file', project.id, addedAsset.fileId || addedAsset.path);
    fresh = await getProject(project.id);
    assert.equal(fresh.excludedAssetKeys.includes(addedAsset.fileId || addedAsset.path), false);
    workspace = await callIpcRaw('projects:get-asset-workspace', project.id);
    assert.equal(workspace.files.find(file => file.name === 'Added While Working.png').excluded, false);
    const directlyRestoredReview = await callIpcRaw('projects:prepare-package-review', project.id, outputDir);
    assert.deepEqual(
      directlyRestoredReview.files.map(file => file.name).sort(),
      ['Added While Working.png', 'Working Project.ai']
    );

    await callIpcRaw('projects:remove-file', project.id, addedAsset.fileId || addedAsset.path);

    manualDialogFor([addedAssetPath]);
    await callIpcRaw('projects:add-files', project.id);
    fresh = await getProject(project.id);
    assert.equal(fresh.excludedAssetKeys.includes(addedAsset.fileId || addedAsset.path), false);
    assert.equal(fresh.files.filter(file => file.path === addedAssetPath).length, 1);
    const restoredReview = await callIpcRaw('projects:prepare-package-review', project.id, outputDir);
    assert.deepEqual(
      restoredReview.files.map(file => file.name).sort(),
      ['Added While Working.png', 'Working Project.ai']
    );

    const restoredAsset = fresh.files.find(file => file.path === addedAssetPath);
    await callIpcRaw('projects:remove-file', project.id, restoredAsset.fileId || restoredAsset.path);
    const finalReview = await callIpcRaw('projects:prepare-package-review', project.id, outputDir);
    assert.deepEqual(finalReview.files.map(file => file.name), ['Working Project.ai']);
    const packageResult = await callIpcRaw('projects:package', project.id, outputDir, finalReview.token);
    assert.equal(packageResult.success, true);
    assert.deepEqual(fs.readdirSync(packageResult.folderPath), ['Working Project.ai']);
    assert.equal(fs.existsSync(path.join(packageResult.folderPath, 'Added While Working.png')), false);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('project file visuals resolve only owned identities, bound output size, and keep source files protected', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-file-visual-test-'));
  try {
    const sourcePath = path.join(fixtureRoot, 'Visual Project.ai');
    const assetPath = path.join(fixtureRoot, 'Visual Asset.png');
    writeSyntheticAiFile(sourcePath);
    const rasterBytes = createSyntheticPngBytes(32, 24, 0x55);
    fs.writeFileSync(assetPath, rasterBytes);

    const project = await createProject('Project-owned file visuals');
    manualDialogFor([sourcePath, assetPath]);
    await callIpcRaw('projects:add-files', project.id);
    let fresh = await waitForProject(
      project.id,
      item => item.files.some(file => file.path === sourcePath) && item.files.some(file => file.path === assetPath)
    );

    const workspace = await callIpcRaw('projects:get-asset-workspace', project.id);
    const sourcePresentation = workspace.files.find(file => file.name === 'Visual Project.ai');
    const assetPresentation = workspace.files.find(file => file.name === 'Visual Asset.png');
    assert.equal(sourcePresentation.protectedSource, true);
    assert.equal(assetPresentation.protectedSource, false);
    assert.match(assetPresentation.visualIdentity, /^[A-Za-z0-9_-]{43}$/);
    assert.match(assetPresentation.visualRevision, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Object.hasOwn(assetPresentation, 'path'), false);

    const originalLstatSync = fs.lstatSync;
    let synchronousRasterRevisionStats = 0;
    try {
      fs.lstatSync = (targetPath, ...args) => {
        if (targetPath === assetPath) synchronousRasterRevisionStats += 1;
        return originalLstatSync(targetPath, ...args);
      };
      await callIpcRaw('projects:get-asset-workspace', project.id);
    } finally {
      fs.lstatSync = originalLstatSync;
    }
    assert.equal(synchronousRasterRevisionStats, 0);

    testNativeFileVisualImage = createTestNativeImage(64);
    testNativeFileIconImage = createTestNativeImage(64);
    const originalOpenSyncForThumbnail = fs.openSync;
    const originalReadSyncForThumbnail = fs.readSync;
    let synchronousSourceReads = 0;
    const synchronousSourceFds = new Set();
    let thumbnail;
    try {
      fs.openSync = (targetPath, ...args) => {
        const fd = originalOpenSyncForThumbnail(targetPath, ...args);
        if (targetPath === assetPath) {
          synchronousSourceReads += 1;
          synchronousSourceFds.add(fd);
        }
        return fd;
      };
      fs.readSync = (fd, ...args) => {
        if (synchronousSourceFds.has(fd)) synchronousSourceReads += 1;
        return originalReadSyncForThumbnail(fd, ...args);
      };
      thumbnail = await callIpcRaw(
        'projects:get-file-visual', project.id, assetPresentation.visualIdentity, assetPresentation.visualRevision
      );
    } finally {
      fs.openSync = originalOpenSyncForThumbnail;
      fs.readSync = originalReadSyncForThumbnail;
    }
    assert.equal(thumbnail.kind, 'thumbnail');
    assert.match(thumbnail.dataUrl, /^data:image\/png;base64,/);
    assert.ok(thumbnail.dataUrl.length < 360000);
    assert.equal(synchronousSourceReads, 0);
    assert.equal(testNativeCreateFromBufferCalls, 0);
    assert.notEqual(testLastNativeThumbnailPath, assetPath);
    assert.match(path.basename(path.dirname(testLastNativeThumbnailPath)), /^crate-file-visual-/);
    assert.deepEqual(testLastNativeThumbnailBytes, rasterBytes);
    assert.equal(fs.existsSync(testLastNativeThumbnailPath), false);
    assert.equal(fs.existsSync(path.dirname(testLastNativeThumbnailPath)), false);
    assert.deepEqual(testLastNativeThumbnailSize, { width: 192, height: 192 });

    metadataTestHooks.clearFileVisualTypeIconCache();
    const snapshotDirectoriesBeforeCaptureFailure = fs.readdirSync(os.tmpdir())
      .filter(name => name.startsWith('crate-file-visual-'))
      .sort();
    const originalRealpath = fs.promises.realpath;
    fs.promises.realpath = async function failSnapshotDirectoryCapture(targetPath, ...args) {
      if (path.basename(String(targetPath)).startsWith('crate-file-visual-')) {
        throw new Error('synthetic snapshot directory capture failure');
      }
      return originalRealpath.call(fs.promises, targetPath, ...args);
    };
    try {
      const captureFailure = await callIpcRaw(
        'projects:get-file-visual', project.id, assetPresentation.visualIdentity, assetPresentation.visualRevision
      );
      assert.equal(captureFailure.kind, 'icon');
    } finally {
      fs.promises.realpath = originalRealpath;
    }
    assert.deepEqual(
      fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('crate-file-visual-')).sort(),
      snapshotDirectoriesBeforeCaptureFailure
    );

    let releaseSlowThumbnail;
    let reportSlowThumbnailStarted;
    const slowThumbnailStarted = new Promise(resolve => { reportSlowThumbnailStarted = resolve; });
    const slowThumbnailGate = new Promise(resolve => { releaseSlowThumbnail = resolve; });
    let slowSnapshotPath = null;
    testBeforeNativeThumbnailResolve = async (snapshotPath) => {
      slowSnapshotPath = snapshotPath;
      reportSlowThumbnailStarted();
      await slowThumbnailGate;
    };
    const slowThumbnail = callIpcRaw(
      'projects:get-file-visual', project.id, assetPresentation.visualIdentity, assetPresentation.visualRevision
    );
    await slowThumbnailStarted;
    let unrelatedTurnCompleted = false;
    await new Promise(resolve => setImmediate(() => {
      unrelatedTurnCompleted = true;
      resolve();
    }));
    const unrelatedFiles = await callIpcRaw('projects:get-files', project.id);
    assert.equal(unrelatedTurnCompleted, true);
    assert.equal(unrelatedFiles.some(file => file.name === 'Visual Project.ai'), true);
    releaseSlowThumbnail();
    assert.equal((await slowThumbnail).kind, 'thumbnail');
    assert.equal(fs.existsSync(slowSnapshotPath), false);
    assert.equal(fs.existsSync(path.dirname(slowSnapshotPath)), false);
    testBeforeNativeThumbnailResolve = null;

    testNativeFileVisualImage = createTestNativeImage((256 * 1024) + 1);
    const icon = await callIpcRaw(
      'projects:get-file-visual', project.id, assetPresentation.visualIdentity, assetPresentation.visualRevision
    );
    assert.equal(icon.kind, 'icon');
    assert.match(icon.dataUrl, /^data:image\/png;base64,/);
    assert.notEqual(testLastFileIconPath, assetPath);
    assert.equal(testLastFileIconPath, path.join(path.parse(process.execPath).root, '.crate-file-type.png'));
    assert.deepEqual(testLastFileIconOptions, { size: 'normal' });

    metadataTestHooks.clearFileVisualTypeIconCache();
    const iconCategoryDir = path.join(TEST_HOME, '.crate', 'file-type-icons');
    const movedIconCategoryDir = `${iconCategoryDir}-verified`;
    const attackerIconCategoryDir = `${iconCategoryDir}-attacker`;
    fs.mkdirSync(iconCategoryDir, { recursive: true });
    fs.rmSync(movedIconCategoryDir, { recursive: true, force: true });
    fs.rmSync(attackerIconCategoryDir, { recursive: true, force: true });
    fs.renameSync(iconCategoryDir, movedIconCategoryDir);
    fs.mkdirSync(attackerIconCategoryDir);
    fs.symlinkSync(attackerIconCategoryDir, iconCategoryDir);
    testNativeFileVisualImage = createTestNativeImage((256 * 1024) + 1);
    const originalOpenSync = fs.openSync;
    let writeOpenAttempts = 0;
    try {
      fs.openSync = (targetPath, flags, ...args) => {
        if ((Number(flags) & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) !== 0) {
          writeOpenAttempts += 1;
        }
        return originalOpenSync(targetPath, flags, ...args);
      };
      const swappedIcon = await callIpcRaw(
        'projects:get-file-visual', project.id, assetPresentation.visualIdentity, assetPresentation.visualRevision
      );
      assert.equal(swappedIcon.kind, 'icon');
      assert.equal(writeOpenAttempts, 0);
      assert.deepEqual(fs.readdirSync(attackerIconCategoryDir), []);
      assert.equal(testLastFileIconPath, path.join(path.parse(process.execPath).root, '.crate-file-type.png'));
      assert.equal(fs.existsSync(testLastFileIconPath), false);
    } finally {
      fs.openSync = originalOpenSync;
      fs.rmSync(iconCategoryDir, { recursive: true, force: true });
      fs.renameSync(movedIconCategoryDir, iconCategoryDir);
      fs.rmSync(attackerIconCategoryDir, { recursive: true, force: true });
    }

    metadataTestHooks.clearFileVisualTypeIconCache();
    fs.writeFileSync(assetPath, createSyntheticPngBytes(9000, 1));
    testNativeFileVisualImage = createTestNativeImage(64);
    const thumbnailCallsBeforeOversizedDimensions = testNativeThumbnailCalls;
    const oversizedDimensions = await callIpcRaw(
      'projects:get-file-visual', project.id, assetPresentation.visualIdentity,
      (await callIpcRaw('projects:get-asset-workspace', project.id)).files.find(file => file.name === 'Visual Asset.png').visualRevision
    );
    assert.equal(oversizedDimensions.kind, 'icon');
    assert.equal(testNativeThumbnailCalls, thumbnailCallsBeforeOversizedDimensions);

    metadataTestHooks.clearFileVisualTypeIconCache();
    fs.writeFileSync(assetPath, createSyntheticPngBytes(4001, 3000));
    const thumbnailCallsBeforeOversizedPixels = testNativeThumbnailCalls;
    const oversizedPixels = await callIpcRaw(
      'projects:get-file-visual', project.id, assetPresentation.visualIdentity,
      (await callIpcRaw('projects:get-asset-workspace', project.id)).files.find(file => file.name === 'Visual Asset.png').visualRevision
    );
    assert.equal(oversizedPixels.kind, 'icon');
    assert.equal(testNativeThumbnailCalls, thumbnailCallsBeforeOversizedPixels);

    metadataTestHooks.clearFileVisualTypeIconCache();
    fs.writeFileSync(assetPath, rasterBytes);
    const originalDuringAbaPath = path.join(fixtureRoot, 'Visual Asset original.png');
    const replacementBytes = createSyntheticPngBytes(16, 16, 0x33);
    let abaSnapshotPath = null;
    testBeforeNativeThumbnailResolve = async (snapshotPath) => {
      abaSnapshotPath = snapshotPath;
      assert.deepEqual(fs.readFileSync(snapshotPath), rasterBytes);
      fs.renameSync(assetPath, originalDuringAbaPath);
      fs.writeFileSync(assetPath, replacementBytes);
      fs.unlinkSync(assetPath);
      fs.renameSync(originalDuringAbaPath, assetPath);
    };
    try {
      const swappedResult = await callIpcRaw(
        'projects:get-file-visual', project.id, assetPresentation.visualIdentity,
        (await callIpcRaw('projects:get-asset-workspace', project.id)).files.find(file => file.name === 'Visual Asset.png').visualRevision
      );
      assert.equal(swappedResult.kind, 'icon');
      assert.notEqual(testLastNativeThumbnailPath, assetPath);
      assert.deepEqual(testLastNativeThumbnailBytes, rasterBytes);
      assert.equal(fs.existsSync(abaSnapshotPath), false);
      assert.equal(fs.existsSync(path.dirname(abaSnapshotPath)), false);
    } finally {
      testBeforeNativeThumbnailResolve = null;
    }

    metadataTestHooks.clearFileVisualTypeIconCache();
    const beforeMidFlightMutation = await callIpcRaw('projects:get-asset-workspace', project.id);
    const midFlightPresentation = beforeMidFlightMutation.files.find(file => file.name === 'Visual Asset.png');
    let changedSnapshotPath = null;
    testBeforeNativeThumbnailResolve = async (snapshotPath) => {
      changedSnapshotPath = snapshotPath;
      fs.writeFileSync(assetPath, replacementBytes);
    };
    try {
      const changedResult = await callIpcRaw(
        'projects:get-file-visual', project.id,
        midFlightPresentation.visualIdentity, midFlightPresentation.visualRevision
      );
      assert.equal(changedResult.kind, 'icon');
      assert.equal(fs.existsSync(changedSnapshotPath), false);
      assert.equal(fs.existsSync(path.dirname(changedSnapshotPath)), false);
    } finally {
      testBeforeNativeThumbnailResolve = null;
      fs.writeFileSync(assetPath, rasterBytes);
    }

    metadataTestHooks.clearFileVisualTypeIconCache();
    const beforeDecodeFailure = await callIpcRaw('projects:get-asset-workspace', project.id);
    const failurePresentation = beforeDecodeFailure.files.find(file => file.name === 'Visual Asset.png');
    let failedSnapshotPath = null;
    testBeforeNativeThumbnailResolve = async (snapshotPath) => {
      failedSnapshotPath = snapshotPath;
      throw new Error('synthetic thumbnail failure');
    };
    try {
      const failedResult = await callIpcRaw(
        'projects:get-file-visual', project.id,
        failurePresentation.visualIdentity, failurePresentation.visualRevision
      );
      assert.equal(failedResult.kind, 'icon');
      assert.equal(fs.existsSync(failedSnapshotPath), false);
      assert.equal(fs.existsSync(path.dirname(failedSnapshotPath)), false);
    } finally {
      testBeforeNativeThumbnailResolve = null;
    }

    assert.deepEqual(
      await callIpcRaw('projects:get-file-visual', project.id, assetPath, assetPresentation.visualRevision),
      { error: 'not_found' }
    );
    assert.deepEqual(
      await callIpcRaw('projects:get-file-visual', 'another-project', assetPresentation.visualIdentity, assetPresentation.visualRevision),
      { error: 'not_found' }
    );
    assert.deepEqual(
      await callIpcRaw(
        'projects:get-file-visual', project.id, `${assetPresentation.visualIdentity}\0suffix`, assetPresentation.visualRevision
      ),
      { error: 'not_found' }
    );

    await callIpcRaw('projects:remove-file', project.id, sourcePresentation.visualIdentity);
    fresh = await getProject(project.id);
    assert.equal(fresh.files.some(file => file.path === sourcePath), true);
    assert.equal(fresh.excludedAssetKeys.includes(sourcePath), false);

    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    const reviewedSource = review.files.find(file => file.name === 'Visual Project.ai');
    const reviewedAsset = review.files.find(file => file.name === 'Visual Asset.png');
    assert.equal(reviewedSource.name, 'Visual Project.ai');
    assert.equal(reviewedAsset.name, 'Visual Asset.png');
  } finally {
    testNativeFileVisualImage = null;
    testNativeFileIconImage = null;
    testBeforeFileIconResolve = null;
    testBeforeNativeThumbnailResolve = null;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('raster thumbnail work uses a defensible byte and pixel bound with one bounded decode lane', async () => {
  assert.deepEqual(metadataTestHooks.getFileVisualRasterLimits(), {
    sourceBytes: 16 * 1024 * 1024,
    dimension: 6000,
    pixels: 12 * 1000 * 1000,
    queue: 8,
  });

  let releaseWork;
  const gate = new Promise(resolve => { releaseWork = resolve; });
  let active = 0;
  let maximumActive = 0;
  let started = 0;
  const work = () => metadataTestHooks.runSerializedFileVisualRasterWork(async () => {
    started += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await gate;
    active -= 1;
    return 'decoded';
  });

  const accepted = Array.from({ length: 8 }, work);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, 1);
  assert.equal(active, 1);
  assert.equal(metadataTestHooks.getFileVisualRasterWorkPending(), 8);
  assert.equal(await work(), null);
  assert.equal(metadataTestHooks.getFileVisualRasterWorkPending(), 8);

  releaseWork();
  assert.deepEqual(await Promise.all(accepted), Array(8).fill('decoded'));
  assert.equal(maximumActive, 1);
  assert.equal(active, 0);
  assert.equal(metadataTestHooks.getFileVisualRasterWorkPending(), 0);
});

test('Review Assets preview requests stay bounded for large projects and preserve project-owned safety', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-file-visual-stress-'));
  const assetCounts = [30, 263, 500];
  const measurements = [];
  try {
    testNativeFileVisualImage = createTestNativeImage(64);
    testNativeFileIconImage = createTestNativeImage(64);
    const project = await createProject('Review Assets visual stress');
    const otherProject = await createProject('Review Assets other project');
    const otherAssetPath = path.join(fixtureRoot, 'other-project.png');
    fs.writeFileSync(otherAssetPath, createSyntheticPngBytes(24, 24, 0x71));
    await setProjectFiles(otherProject.id, {
      files: [{
        ...makePendingFile(otherAssetPath, 'manual-browse'),
        assetOrigin: 'added',
        projectRole: 'asset',
      }],
    });
    const otherWorkspace = await callIpcRaw('projects:get-asset-workspace', otherProject.id);
    const otherPresentation = otherWorkspace.files[0];

    for (const assetCount of assetCounts) {
      const assetDir = path.join(fixtureRoot, String(assetCount));
      fs.mkdirSync(assetDir, { recursive: true });
      const files = [];
      for (let index = 0; index < assetCount; index++) {
        const assetPath = path.join(assetDir, `asset-${String(index).padStart(3, '0')}.png`);
        fs.writeFileSync(assetPath, createSyntheticPngBytes(32, 24, index & 0xff));
        files.push({
          ...makePendingFile(assetPath, 'manual-browse'),
          assetOrigin: 'added',
          projectRole: 'asset',
        });
      }
      const pendingPaths = [
        path.join(assetDir, 'pre-existing-illustrator-1.ai'),
        path.join(assetDir, 'pre-existing-illustrator-2.ai'),
      ];
      for (const pendingPath of pendingPaths) writeSyntheticAiFile(pendingPath);
      await setProjectFiles(project.id, {
        files,
        pendingFiles: pendingPaths.map(filePath => ({
          ...makePendingFile(filePath, 'illustrator-active-session'),
          assetOrigin: 'existing',
          projectRole: 'source',
        })),
      });
      metadataTestHooks.clearFileVisualProjectCache();

      const workspace = await callIpcRaw('projects:get-asset-workspace', project.id);
      assert.equal(workspace.files.length, assetCount);
      assert.deepEqual(workspace.pendingFiles.map(file => file.name), [
        'pre-existing-illustrator-1.ai',
        'pre-existing-illustrator-2.ai',
      ]);
      assert.equal(new Set(workspace.files.map(file => file.visualIdentity)).size, assetCount);
      assert.equal(workspace.files.every(file => !Object.hasOwn(file, 'path')), true);
      const requests = workspace.files.map(file => (
        ['projects:get-file-visual', project.id, file.visualIdentity, file.visualRevision]
      ));

      metadataTestHooks.clearFileVisualProjectCache();
      metadataTestHooks.clearFileVisualTypeIconCache();
      const legacyPath = await measureProjectFileVisualRequests(
        () => Promise.all(requests.map(request => callIpcRaw(...request)))
      );

      metadataTestHooks.clearFileVisualTypeIconCache();
      await callIpcRaw('projects:get-asset-workspace', project.id);
      const correctedPath = await measureProjectFileVisualRequests(
        () => Promise.all(requests.map(request => callIpcRaw(...request)))
      );
      measurements.push({
        assetCount,
        legacyPath: {
          elapsedMs: legacyPath.elapsedMs,
          lstat: legacyPath.lstat,
          realpath: legacyPath.realpath,
        },
        correctedPath: {
          elapsedMs: correctedPath.elapsedMs,
          lstat: correctedPath.lstat,
          realpath: correctedPath.realpath,
        },
      });

      for (const result of [legacyPath, correctedPath]) {
        assert.equal(result.responses.length, assetCount);
        assert.equal(result.responses.every(response => (
          response && ['thumbnail', 'icon'].includes(response.kind)
        )), true);
        assert.ok(result.elapsedMs < 10000);
      }
      assert.ok(
        correctedPath.lstat <= legacyPath.lstat - assetCount,
        `${assetCount} assets should not repeat project visual revision lstat work per preview request`
      );
      assert.ok(correctedPath.realpath <= legacyPath.realpath);

      assert.deepEqual(
        await callIpcRaw('projects:get-file-visual', otherProject.id, workspace.files[0].visualIdentity, workspace.files[0].visualRevision),
        { error: 'not_found' }
      );
      assert.deepEqual(
        await callIpcRaw('projects:get-file-visual', project.id, otherPresentation.visualIdentity, otherPresentation.visualRevision),
        { error: 'not_found' }
      );
      const stored = storeInstance.data.projects.find(item => item.id === project.id);
      assert.deepEqual(stored.pendingFiles.map(file => file.path), pendingPaths);
      assert.equal(stored.files.length, assetCount);
    }

    if (process.env.CRATE_FILE_VISUAL_STRESS_REPORT === '1') {
      process.stdout.write(`# file-visual-stress ${JSON.stringify(measurements)}\n`);
    }
  } finally {
    testNativeFileVisualImage = null;
    testNativeFileIconImage = null;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('Package Review gives duplicate same-name files distinct opaque visuals bound to exact manifest sources', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-duplicate-review-visual-test-'));
  try {
    const firstDir = path.join(fixtureRoot, 'one');
    const secondDir = path.join(fixtureRoot, 'two');
    fs.mkdirSync(firstDir);
    fs.mkdirSync(secondDir);
    const firstPath = path.join(firstDir, 'Shared.png');
    const secondPath = path.join(secondDir, 'Shared.png');
    const firstBytes = createSyntheticPngBytes(20, 20, 0x31);
    const secondBytes = createSyntheticPngBytes(24, 24, 0x32);
    fs.writeFileSync(firstPath, firstBytes);
    fs.writeFileSync(secondPath, secondBytes);
    const project = await createProject('Duplicate review visuals');
    await setProjectFiles(project.id, {
      files: [
        { ...makePendingFile(firstPath, 'manual-browse'), assetOrigin: 'added', projectRole: 'asset' },
        { ...makePendingFile(secondPath, 'manual-browse'), assetOrigin: 'added', projectRole: 'asset' },
      ],
    });

    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(review.files.length, 2);
    assert.equal(new Set(review.files.map(file => file.visualIdentity)).size, 2);
    for (const file of review.files) {
      assert.match(file.visualIdentity, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(Object.hasOwn(file, 'path'), false);
    }

    testNativeFileVisualImage = createTestNativeImage(64);
    await callIpcRaw(
      'projects:get-file-visual', project.id, review.files[0].visualIdentity, review.files[0].visualRevision
    );
    const firstResolvedPath = testLastNativeThumbnailPath;
    const firstResolvedBytes = testLastNativeThumbnailBytes;
    await callIpcRaw(
      'projects:get-file-visual', project.id, review.files[1].visualIdentity, review.files[1].visualRevision
    );
    const secondResolvedPath = testLastNativeThumbnailPath;
    const secondResolvedBytes = testLastNativeThumbnailBytes;
    assert.notEqual(firstResolvedPath, firstPath);
    assert.notEqual(secondResolvedPath, secondPath);
    assert.notEqual(firstResolvedPath, secondResolvedPath);
    assert.deepEqual(firstResolvedBytes, firstBytes);
    assert.deepEqual(secondResolvedBytes, secondBytes);
    assert.equal(fs.existsSync(firstResolvedPath), false);
    assert.equal(fs.existsSync(secondResolvedPath), false);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('Current Project and Package Review visual revisions change with source bytes and reject stale requests', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-visual-revision-test-'));
  try {
    const assetPath = path.join(fixtureRoot, 'Revision.png');
    const firstBytes = createSyntheticPngBytes(20, 20, 0x21);
    const secondBytes = createSyntheticPngBytes(20, 20, 0x22);
    fs.writeFileSync(assetPath, firstBytes);
    const project = await createProject('Visual revision');
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    stored.assetBaseline = {
      schemaVersion: 1,
      status: 'included',
      decision: 'include',
      establishedAt: stored.watchStartedAt || stored.createdAt,
    };
    stored.files = [{
      ...makePendingFile(assetPath, 'manual-browse'),
      assetOrigin: 'added',
      projectRole: 'asset',
    }];
    stored.pendingFiles = [];

    const firstWorkspace = await callIpcRaw('projects:get-asset-workspace', project.id);
    const firstPresentation = firstWorkspace.files[0];
    const firstReview = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(firstReview.files[0].visualRevision, firstPresentation.visualRevision);

    fs.writeFileSync(assetPath, secondBytes);
    const secondWorkspace = await callIpcRaw('projects:get-asset-workspace', project.id);
    const secondPresentation = secondWorkspace.files[0];
    assert.equal(secondPresentation.visualIdentity, firstPresentation.visualIdentity);
    assert.notEqual(secondPresentation.visualRevision, firstPresentation.visualRevision);
    assert.deepEqual(
      await callIpcRaw(
        'projects:get-file-visual', project.id, firstPresentation.visualIdentity, firstPresentation.visualRevision
      ),
      { error: 'stale_visual' }
    );

    testNativeFileVisualImage = createTestNativeImage(64);
    const refreshedVisual = await callIpcRaw(
      'projects:get-file-visual', project.id, secondPresentation.visualIdentity, secondPresentation.visualRevision
    );
    assert.equal(refreshedVisual.kind, 'thumbnail');
    assert.notEqual(testLastNativeThumbnailPath, assetPath);
    assert.deepEqual(testLastNativeThumbnailBytes, secondBytes);
    assert.equal(fs.existsSync(testLastNativeThumbnailPath), false);
    assert.equal(testNativeCreateFromBufferCalls, 0);
    const secondReview = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(secondReview.files[0].visualRevision, secondPresentation.visualRevision);
    assert.notEqual(secondReview.files[0].visualRevision, firstReview.files[0].visualRevision);
  } finally {
    testNativeFileVisualImage = null;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('an explicitly added PDF establishes a dependable baseline without changing general PDF roles', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-pdf-baseline-test-'));
  try {
    const sourcePath = path.join(fixtureRoot, 'Existing Reference.pdf');
    const linkedPath = path.join(fixtureRoot, 'Existing PDF Link.png');
    const linkedPdfPath = path.join(fixtureRoot, 'Supporting Reference.pdf');
    fs.writeFileSync(linkedPath, 'existing PDF dependency');
    writeSyntheticPdfFile(linkedPdfPath);
    fs.writeFileSync(sourcePath, `permitted leading bytes\n%PDF-1.7\nsynthetic PDF link ${linkedPath}\n%%EOF\n`);

    const project = await createProject('PDF baseline source');
    manualDialogFor([sourcePath]);
    await callIpc('projects:add-files', project.id);

    const fresh = await waitForProject(
      project.id,
      item => item.assetBaseline && item.assetBaseline.status === 'decision-required'
    );
    assert.equal(fresh.files.find(file => file.path === sourcePath).projectRole, 'asset');
    assert.equal(fresh.files.find(file => file.path === sourcePath).assetOrigin, 'added');
    assert.equal(fresh.files.find(file => file.path === linkedPath).assetOrigin, 'existing');
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    stored.files.push({
      ...makePendingFile(linkedPdfPath, 'scan-on-open'),
      assetOrigin: 'existing',
      projectRole: 'asset',
      captureEvidence: { sourceDocumentPath: sourcePath },
    });
    const workspace = await callIpcRaw('projects:get-asset-workspace', project.id);
    const pdfSource = workspace.files.find(file => file.name === 'Existing Reference.pdf');
    const linkedAsset = workspace.files.find(file => file.name === 'Existing PDF Link.png');
    const linkedPdf = workspace.files.find(file => file.name === 'Supporting Reference.pdf');
    assert.equal(pdfSource.projectRole, 'asset');
    assert.equal(pdfSource.protectedSource, true);
    assert.equal(linkedAsset.protectedSource, false);
    assert.equal(linkedPdf.projectRole, 'asset');
    assert.equal(linkedPdf.protectedSource, false);
    await callIpcRaw('projects:remove-file', project.id, linkedPdf.visualIdentity);
    let afterRemoval = await getProject(project.id);
    assert.equal(afterRemoval.files.some(file => file.path === linkedPdfPath), true);
    assert.equal(afterRemoval.excludedAssetKeys.includes(linkedPdfPath), true);
    await callIpcRaw('projects:remove-file', project.id, pdfSource.visualIdentity);
    afterRemoval = await getProject(project.id);
    assert.equal(afterRemoval.files.some(file => file.path === sourcePath), true);
    const blockedReview = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(blockedReview.error, 'asset_baseline_decision_required');
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('malformed AI and PDF sources remain accepted but cannot establish a dependable baseline', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-malformed-ai-pdf-baseline-test-'));
  try {
    const cases = [
      { name: 'Marker Substring.ai', content: 'junk %!PS-Adobe-invalid\n%%EOF\n' },
      { name: 'Embedded Exact Header.ai', content: 'junk-prefix %!PS-Adobe-3.0\nbody\n%%EOF\n' },
      { name: 'Invalid Version.pdf', content: '%PDF-invalid\n%%EOF\n' },
      { name: 'Embedded EOF.pdf', content: '%PDF-1.7\nbody-not-a-marker%%EOF\n' },
      { name: 'Trailing Junk.pdf', content: '%PDF-1.7\n%%EOF\nnot permitted trailing content' },
    ];
    for (const fixture of cases) {
      const sourcePath = path.join(fixtureRoot, fixture.name);
      fs.writeFileSync(sourcePath, fixture.content);
      const project = await createProject(`Malformed baseline ${fixture.name}`);
      manualDialogFor([sourcePath]);
      const files = await callIpcRaw('projects:add-files', project.id);
      assert.equal(files.some(file => file.path === sourcePath), true);
      const fresh = await getProject(project.id);
      assert.equal(fresh.assetBaseline.status, 'awaiting-first-scan');
      const review = await callIpcRaw('projects:prepare-package-review', project.id);
      assert.equal(review.error, 'asset_baseline_scan_incomplete');
      await callIpcRaw('projects:delete', project.id);
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('oversized AI and PDF sources remain accepted but cannot establish a dependable baseline', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-oversized-ai-pdf-baseline-test-'));
  try {
    for (const ext of ['.ai', '.pdf']) {
      const sourcePath = path.join(fixtureRoot, `Oversized Source${ext}`);
      writeSyntheticPdfFile(sourcePath);
      fs.truncateSync(sourcePath, 301 * 1024 * 1024);
      const project = await createProject(`Oversized baseline ${ext}`);
      manualDialogFor([sourcePath]);
      const files = await callIpcRaw('projects:add-files', project.id);
      assert.equal(files.some(file => file.path === sourcePath), true);
      const fresh = await getProject(project.id);
      assert.equal(fresh.assetBaseline.status, 'awaiting-first-scan');
      const review = await callIpcRaw('projects:prepare-package-review', project.id);
      assert.equal(review.error, 'asset_baseline_scan_incomplete');
      await callIpcRaw('projects:delete', project.id);
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('first-scan boundary keeps dependencies existing while concurrent unrelated activity is added', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-first-scan-boundary-test-'));
  const originalReadFile = fs.promises.readFile;
  let releaseRead;
  let markReadStarted;
  const readStarted = new Promise(resolve => { markReadStarted = resolve; });
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  try {
    const sourcePath = path.join(fixtureRoot, 'Boundary Project.ai');
    const linkedPath = path.join(fixtureRoot, 'Boundary Existing.png');
    const concurrentPath = path.join(fixtureRoot, 'Boundary Added.png');
    fs.writeFileSync(linkedPath, 'existing dependency bytes');
    fs.writeFileSync(concurrentPath, 'concurrent unrelated bytes');
    writeSyntheticAiFile(sourcePath, `synthetic illustrator link ${linkedPath}`);

    fs.promises.readFile = async function deferFirstSourceRead(filePath, ...args) {
      if (path.resolve(filePath) === path.resolve(sourcePath)) {
        markReadStarted();
        await readGate;
      }
      return originalReadFile.call(fs.promises, filePath, ...args);
    };

    const project = await createProject('First scan concurrency boundary');
    manualDialogFor([sourcePath]);
    const scanPromise = callIpcRaw('projects:add-files', project.id);
    await readStarted;
    await new Promise(resolve => originalSetTimeout(resolve, 5));
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    stored.files.push({
      path: concurrentPath,
      name: path.basename(concurrentPath),
      ext: '.png',
      addedAt: Date.now(),
      source: 'app-opened',
      projectRole: 'asset',
    });
    releaseRead();
    await scanPromise;

    const fresh = await waitForProject(
      project.id,
      item => item.assetBaseline && item.assetBaseline.status === 'decision-required'
    );
    assert.equal(fresh.files.find(file => file.path === linkedPath).assetOrigin, 'existing');
    assert.equal(fresh.files.find(file => file.path === concurrentPath).assetOrigin, 'added');
  } finally {
    fs.promises.readFile = originalReadFile;
    releaseRead();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('Package Review waits for the first dependable scan before requiring the existing-assets decision', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-first-scan-package-gate-test-'));
  const originalReadFile = fs.promises.readFile;
  let releaseRead;
  let markReadStarted;
  const readStarted = new Promise(resolve => { markReadStarted = resolve; });
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  try {
    const sourcePath = path.join(fixtureRoot, 'Gate Project.ai');
    const linkedPath = path.join(fixtureRoot, 'Gate Existing.png');
    fs.writeFileSync(linkedPath, 'existing gate dependency');
    writeSyntheticAiFile(sourcePath, `synthetic illustrator link ${linkedPath}`);

    fs.promises.readFile = async function deferSourceRead(filePath, ...args) {
      if (path.resolve(filePath) === path.resolve(sourcePath)) {
        markReadStarted();
        await readGate;
      }
      return originalReadFile.call(fs.promises, filePath, ...args);
    };

    const project = await createProject('First scan package gate');
    manualDialogFor([sourcePath]);
    const scanPromise = callIpcRaw('projects:add-files', project.id);
    await readStarted;
    let reviewSettled = false;
    const reviewPromise = callIpcRaw('projects:prepare-package-review', project.id).then(result => {
      reviewSettled = true;
      return result;
    });
    await new Promise(resolve => originalSetTimeout(resolve, 50));
    assert.equal(reviewSettled, false);

    releaseRead();
    await scanPromise;
    const review = await reviewPromise;
    assert.equal(review.error, 'asset_baseline_decision_required');
  } finally {
    fs.promises.readFile = originalReadFile;
    releaseRead();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('failed first source parsing keeps the baseline unresolved and Package Review unavailable', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-first-scan-failure-test-'));
  try {
    const sourcePath = path.join(fixtureRoot, 'Unreadable Project.ai');
    fs.mkdirSync(sourcePath);

    const project = await createProject('Failed first scan');
    manualDialogFor([sourcePath]);
    const result = await callIpcRaw('projects:add-files', project.id);
    assert.equal(result.some(file => file.path === sourcePath), true);
    await new Promise(resolve => originalSetTimeout(resolve, 50));

    const fresh = await getProject(project.id);
    assert.equal(fresh.assetBaseline.status, 'awaiting-first-scan');
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(review.error, 'asset_baseline_scan_incomplete');
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('failed-source recovery survives persisted reload for the same physical file and reconciles the baseline', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-remove-failed-baseline-source-test-'));
  try {
    const sourcePath = path.join(fixtureRoot, 'Failed Source.ai');
    fs.writeFileSync(sourcePath, 'malformed Illustrator bytes');
    const project = await createProject('Remove failed baseline source');
    manualDialogFor([sourcePath]);
    await callIpcRaw('projects:add-files', project.id);
    const failedProject = await getProject(project.id);
    assert.equal(failedProject.assetBaseline.status, 'awaiting-first-scan');
    assert.equal(failedProject.assetBaseline.failedRequiredSources.length, 1);
    assert.deepEqual(Object.keys(failedProject.assetBaseline.failedRequiredSources[0]).sort(), [
      'physicalIdentityHash',
      'schemaVersion',
      'sourceKeyHash',
    ]);
    assert.equal(failedProject.assetBaseline.failedRequiredSources[0].schemaVersion, 1);
    assert.match(failedProject.assetBaseline.failedRequiredSources[0].sourceKeyHash, /^[a-f0-9]{64}$/);
    assert.match(failedProject.assetBaseline.failedRequiredSources[0].physicalIdentityHash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(failedProject.assetBaseline).includes(sourcePath), false);

    // Simulate save/reload and a main-process restart: only persisted project state survives.
    storeInstance.set('projects', JSON.parse(JSON.stringify(storeInstance.get('projects', []))));
    metadataTestHooks.clearAssetBaselineScans();
    assert.equal((await getProject(project.id)).assetBaseline.failedRequiredSources.length, 1);

    const workspace = await callIpcRaw('projects:get-asset-workspace', project.id);
    const failedSource = workspace.files.find(file => file.name === 'Failed Source.ai');
    assert.equal(failedSource.protectedSource, true);
    assert.equal(failedSource.sourceRecoveryAllowed, true);
    await callIpcRaw('projects:remove-file', project.id, failedSource.visualIdentity);
    const fresh = await getProject(project.id);
    assert.equal(fresh.files.some(file => file.path === sourcePath), false);
    assert.deepEqual(fresh.excludedAssetKeys, []);
    assert.equal(fresh.assetBaseline.status, 'empty');
    assert.notEqual(
      (await callIpcRaw('projects:prepare-package-review', project.id)).error,
      'asset_baseline_scan_incomplete'
    );

    const healthySourcePath = path.join(fixtureRoot, 'Healthy Source.ai');
    writeSyntheticAiFile(healthySourcePath);
    const healthyProject = await createProject('Healthy protected baseline source');
    manualDialogFor([healthySourcePath]);
    await callIpcRaw('projects:add-files', healthyProject.id);
    const healthy = await waitForProject(
      healthyProject.id,
      item => item.assetBaseline && item.assetBaseline.status === 'empty'
    );
    assert.equal(healthy.files.some(file => file.path === healthySourcePath), true);
    const healthyWorkspace = await callIpcRaw('projects:get-asset-workspace', healthyProject.id);
    const healthySource = healthyWorkspace.files.find(file => file.name === 'Healthy Source.ai');
    assert.equal(healthySource.protectedSource, true);
    assert.equal(healthySource.sourceRecoveryAllowed, false);
    await callIpcRaw('projects:remove-file', healthyProject.id, healthySource.visualIdentity);
    assert.equal(
      (await getProject(healthyProject.id)).files.some(file => file.path === healthySourcePath),
      true
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('same-path physical replacement does not inherit failed-source removal eligibility', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-replaced-failed-source-test-'));
  try {
    const sourcePath = path.join(fixtureRoot, 'Replaced Failed Source.ai');
    const originalPath = path.join(fixtureRoot, 'Original Failed Source.ai');
    fs.writeFileSync(sourcePath, 'malformed Illustrator bytes');
    const project = await createProject('Reject replaced failed source recovery');
    manualDialogFor([sourcePath]);
    await callIpcRaw('projects:add-files', project.id);
    const failed = await getProject(project.id);
    assert.equal(failed.assetBaseline.failedRequiredSources.length, 1);

    // Keep the live failed-scan state populated: a replacement must not inherit
    // recovery authority merely because it occupies the failed source path.
    fs.renameSync(sourcePath, originalPath);
    fs.writeFileSync(sourcePath, 'different malformed Illustrator bytes');
    let workspace = await callIpcRaw('projects:get-asset-workspace', project.id);
    let source = workspace.files.find(file => file.name === 'Replaced Failed Source.ai');
    assert.equal(source.protectedSource, true);
    assert.equal(source.sourceRecoveryAllowed, false);
    await callIpcRaw('projects:remove-file', project.id, source.visualIdentity);
    assert.equal((await getProject(project.id)).files.some(file => file.path === sourcePath), true);

    fs.unlinkSync(sourcePath);
    fs.renameSync(originalPath, sourcePath);
    workspace = await callIpcRaw('projects:get-asset-workspace', project.id);
    source = workspace.files.find(file => file.name === 'Replaced Failed Source.ai');
    assert.equal(source.sourceRecoveryAllowed, true);

    // Repeat the replacement after a persisted reload/main-process restart.
    storeInstance.set('projects', JSON.parse(JSON.stringify(storeInstance.get('projects', []))));
    metadataTestHooks.clearAssetBaselineScans();
    fs.renameSync(sourcePath, originalPath);
    fs.writeFileSync(sourcePath, 'different malformed Illustrator bytes');

    workspace = await callIpcRaw('projects:get-asset-workspace', project.id);
    source = workspace.files.find(file => file.name === 'Replaced Failed Source.ai');
    assert.equal(source.protectedSource, true);
    assert.equal(source.sourceRecoveryAllowed, false);
    await callIpcRaw('projects:remove-file', project.id, source.visualIdentity);
    assert.equal((await getProject(project.id)).files.some(file => file.path === sourcePath), true);

    fs.unlinkSync(sourcePath);
    fs.renameSync(originalPath, sourcePath);
    storeInstance.set('projects', JSON.parse(JSON.stringify(storeInstance.get('projects', []))));
    metadataTestHooks.clearAssetBaselineScans();
    workspace = await callIpcRaw('projects:get-asset-workspace', project.id);
    source = workspace.files.find(file => file.name === 'Replaced Failed Source.ai');
    assert.equal(source.sourceRecoveryAllowed, true);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('successful first-scan retry clears persisted source recovery eligibility across restart', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-clear-failed-baseline-source-test-'));
  try {
    const sourcePath = path.join(fixtureRoot, 'Recovered Source.ai');
    fs.writeFileSync(sourcePath, 'malformed Illustrator bytes');
    const project = await createProject('Clear persisted failed source recovery');
    manualDialogFor([sourcePath]);
    await callIpcRaw('projects:add-files', project.id);
    assert.equal((await getProject(project.id)).assetBaseline.failedRequiredSources.length, 1);

    metadataTestHooks.clearAssetBaselineScans();
    writeSyntheticAiFile(sourcePath);
    manualDialogFor([sourcePath]);
    await callIpcRaw('projects:add-files', project.id);
    const settled = await waitForProject(
      project.id,
      item => item.assetBaseline && item.assetBaseline.status === 'empty'
    );
    assert.equal(Object.hasOwn(settled.assetBaseline, 'failedRequiredSources'), false);

    metadataTestHooks.clearAssetBaselineScans();
    const workspace = await callIpcRaw('projects:get-asset-workspace', project.id);
    const source = workspace.files.find(file => file.name === 'Recovered Source.ai');
    assert.equal(source.protectedSource, true);
    assert.equal(source.sourceRecoveryAllowed, false);
    await callIpcRaw('projects:remove-file', project.id, source.visualIdentity);
    assert.equal(
      (await getProject(project.id)).files.some(file => file.path === sourcePath),
      true
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('malformed and future failed-source recovery state never makes a source removable', async () => {
  const sourcePath = path.join(os.tmpdir(), 'Healthy persisted source.ai');
  try {
    writeSyntheticAiFile(sourcePath);
    for (const [name, baseline] of [
      ['malformed records', {
        schemaVersion: 1,
        status: 'awaiting-first-scan',
        decision: null,
        establishedAt: null,
        failedRequiredSources: [
          null,
          { schemaVersion: 1, sourceKeyHash: 'not-a-hash', physicalIdentityHash: 'b'.repeat(64) },
          { schemaVersion: 1, sourceKeyHash: 'a'.repeat(64), physicalIdentityHash: 'not-a-hash' },
        ],
      }],
      ['future schema', {
        schemaVersion: 2,
        status: 'awaiting-first-scan',
        decision: null,
        establishedAt: null,
        failedRequiredSources: [{
          schemaVersion: 2,
          sourceKeyHash: 'a'.repeat(64),
          physicalIdentityHash: 'b'.repeat(64),
        }],
      }],
    ]) {
      const project = await createProject(`Failed source state ${name}`);
      const stored = storeInstance.data.projects.find(item => item.id === project.id);
      stored.files = [{
        path: sourcePath,
        name: path.basename(sourcePath),
        ext: '.ai',
        addedAt: stored.createdAt,
        source: 'manual-browse',
        projectRole: 'source',
      }];
      stored.assetBaseline = baseline;
      metadataTestHooks.clearAssetBaselineScans();

      const fresh = await getProject(project.id);
      assert.equal(Object.hasOwn(fresh.assetBaseline, 'failedRequiredSources'), false, name);
      const workspace = await callIpcRaw('projects:get-asset-workspace', project.id);
      const source = workspace.files.find(file => file.name === path.basename(sourcePath));
      assert.equal(source.protectedSource, true, name);
      assert.equal(source.sourceRecoveryAllowed, false, name);
      await callIpcRaw('projects:remove-file', project.id, source.visualIdentity);
      assert.equal((await getProject(project.id)).files.length, 1, name);
    }
  } finally {
    fs.rmSync(sourcePath, { force: true });
  }
});

test('concurrent first source scans settle as one existing-assets cohort regardless of completion order', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-multi-source-baseline-test-'));
  const originalReadFile = fs.promises.readFile;
  const gates = new Map();
  try {
    const sourceA = path.join(fixtureRoot, 'Existing A.ai');
    const sourceB = path.join(fixtureRoot, 'Existing B.ai');
    const linkedA = path.join(fixtureRoot, 'Existing A.png');
    const linkedB = path.join(fixtureRoot, 'Existing B.png');
    fs.writeFileSync(linkedA, 'existing A dependency');
    fs.writeFileSync(linkedB, 'existing B dependency');
    writeSyntheticAiFile(sourceA, `synthetic illustrator links ${linkedA} and ${sourceB}`);
    writeSyntheticAiFile(sourceB, `synthetic illustrator link ${linkedB}`);

    for (const sourcePath of [sourceA, sourceB]) {
      let release;
      let started;
      const startedPromise = new Promise(resolve => { started = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      gates.set(path.resolve(sourcePath), { started, startedPromise, gate, release });
    }
    fs.promises.readFile = async function deferSourceReads(filePath, ...args) {
      const deferred = gates.get(path.resolve(filePath));
      if (deferred) {
        deferred.started();
        await deferred.gate;
      }
      return originalReadFile.call(fs.promises, filePath, ...args);
    };

    const project = await createProject('Concurrent first sources');
    manualDialogFor([sourceA, sourceB]);
    const scans = callIpcRaw('projects:add-files', project.id);
    await Promise.all([...gates.values()].map(item => item.startedPromise));
    gates.get(path.resolve(sourceB)).release();
    await new Promise(resolve => originalSetTimeout(resolve, 25));
    assert.equal((await getProject(project.id)).assetBaseline.status, 'awaiting-first-scan');
    gates.get(path.resolve(sourceA)).release();
    await scans;

    const fresh = await waitForProject(
      project.id,
      item => item.assetBaseline && item.assetBaseline.status === 'decision-required'
    );
    assert.equal(fresh.files.find(file => file.path === linkedA).assetOrigin, 'existing');
    assert.equal(fresh.files.find(file => file.path === linkedB).assetOrigin, 'existing');
    assert.equal(fresh.files.find(file => file.path === sourceA).projectRole, 'source');
    assert.equal(fresh.files.find(file => file.path === sourceB).projectRole, 'source');
  } finally {
    fs.promises.readFile = originalReadFile;
    for (const deferred of gates.values()) deferred.release();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('a source accepted during an active first scan joins the required baseline cohort', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-late-baseline-source-test-'));
  const originalReadFile = fs.promises.readFile;
  const gates = new Map();
  try {
    const sourceA = path.join(fixtureRoot, 'Initial Source.ai');
    const sourceB = path.join(fixtureRoot, 'Late Source.ai');
    const linkedA = path.join(fixtureRoot, 'Initial Existing.png');
    const linkedB = path.join(fixtureRoot, 'Late Existing.png');
    fs.writeFileSync(linkedA, 'initial dependency');
    fs.writeFileSync(linkedB, 'late dependency');
    writeSyntheticAiFile(sourceA, `initial link ${linkedA}`);
    writeSyntheticAiFile(sourceB, `late link ${linkedB}`);

    for (const sourcePath of [sourceA, sourceB]) {
      let release;
      let started;
      const startedPromise = new Promise(resolve => { started = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      gates.set(path.resolve(sourcePath), { release, started, startedPromise, gate });
    }
    fs.promises.readFile = async function deferLateSourceReads(filePath, ...args) {
      const deferred = gates.get(path.resolve(filePath));
      if (deferred) {
        deferred.started();
        await deferred.gate;
      }
      return originalReadFile.call(fs.promises, filePath, ...args);
    };

    const project = await createProject('Late accepted baseline source');
    manualDialogFor([sourceA]);
    const initialScan = callIpcRaw('projects:add-files', project.id);
    await gates.get(path.resolve(sourceA)).startedPromise;

    manualDialogFor([sourceB]);
    const lateScan = callIpcRaw('projects:add-files', project.id);
    await gates.get(path.resolve(sourceB)).startedPromise;

    gates.get(path.resolve(sourceA)).release();
    await new Promise(resolve => originalSetTimeout(resolve, 25));
    assert.equal((await getProject(project.id)).assetBaseline.status, 'awaiting-first-scan');

    gates.get(path.resolve(sourceB)).release();
    await Promise.all([initialScan, lateScan]);
    const fresh = await waitForProject(
      project.id,
      item => item.assetBaseline && item.assetBaseline.status === 'decision-required'
    );
    assert.equal(fresh.files.find(file => file.path === linkedA).assetOrigin, 'existing');
    assert.equal(fresh.files.find(file => file.path === linkedB).assetOrigin, 'existing');
  } finally {
    fs.promises.readFile = originalReadFile;
    for (const deferred of gates.values()) deferred.release();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('duplicate first scans of one source remain dependable when a later duplicate fails', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-duplicate-baseline-scan-test-'));
  const originalReadFile = fs.promises.readFile;
  const gates = [];
  try {
    const sourcePath = path.join(fixtureRoot, 'Duplicate Source.ai');
    const linkedPath = path.join(fixtureRoot, 'Duplicate Existing.png');
    fs.writeFileSync(linkedPath, 'existing dependency');
    writeSyntheticAiFile(sourcePath, `synthetic illustrator link ${linkedPath}`);

    fs.promises.readFile = async function deferDuplicateSourceReads(filePath, ...args) {
      if (path.resolve(filePath) !== path.resolve(sourcePath)) {
        return originalReadFile.call(fs.promises, filePath, ...args);
      }
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const entry = { release, gate, attempt: gates.length };
      gates.push(entry);
      await gate;
      if (entry.attempt === 1) throw new Error('forced duplicate scan failure');
      return originalReadFile.call(fs.promises, filePath, ...args);
    };

    const project = await createProject('Duplicate first source scans');
    manualDialogFor([sourcePath]);
    const firstScan = callIpcRaw('projects:add-files', project.id);
    await waitForCondition(() => gates.length === 1, 'expected manual source scan');
    const duplicateScan = emitWatcher('change', sourcePath);
    await waitForCondition(() => gates.length === 2, 'expected two duplicate source scans');
    gates[0].release();
    await new Promise(resolve => originalSetTimeout(resolve, 25));
    gates[1].release();
    await firstScan;
    await duplicateScan;

    const fresh = await waitForProject(
      project.id,
      item => item.assetBaseline && item.assetBaseline.status === 'decision-required'
    );
    assert.equal(fresh.files.find(file => file.path === linkedPath).assetOrigin, 'existing');
  } finally {
    fs.promises.readFile = originalReadFile;
    for (const gate of gates) gate.release();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('readable malformed PSD sources do not establish an empty dependable baseline', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-malformed-psd-baseline-test-'));
  const previousPsdFixture = currentPsdFixture;
  try {
    const sourcePath = path.join(fixtureRoot, 'Malformed Source.psd');
    fs.writeFileSync(sourcePath, 'readable but not a valid PSD');
    const project = await createProject('Malformed PSD baseline');
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    stored.pendingFiles = [{
      path: sourcePath,
      name: path.basename(sourcePath),
      ext: '.psd',
      addedAt: Date.now(),
      source: 'app-opened',
      captureState: 'observed',
      projectRole: 'source',
    }];
    currentPsdFixture = new Error('invalid PSD structure');

    const result = await callIpcRaw('projects:accept-pending', project.id, sourcePath);
    assert.equal(result.files.some(file => file.path === sourcePath), true);
    const fresh = await getProject(project.id);
    assert.equal(fresh.assetBaseline.status, 'awaiting-first-scan');
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(review.error, 'asset_baseline_scan_incomplete');
  } finally {
    currentPsdFixture = previousPsdFixture;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('readable malformed ZIP-based sources do not establish an empty dependable baseline', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-malformed-zip-baseline-test-'));
  let validationAttempts = 0;
  try {
    const sourcePath = path.join(fixtureRoot, 'Malformed Presentation.pptx');
    fs.writeFileSync(sourcePath, 'readable but not a valid ZIP presentation');
    setChildProcessHandler(({ kind, command, args }) => {
      if (kind === 'execFile' && command === '/usr/bin/unzip' && args[0] === '-tqq' && args[1] === sourcePath) {
        validationAttempts++;
        return { error: new Error('invalid ZIP structure') };
      }
      return { stdout: '', stderr: '' };
    });

    const project = await createProject('Malformed ZIP baseline');
    manualDialogFor([sourcePath]);
    const { result, output } = await captureConsoleDuring(() => callIpcRaw('projects:add-files', project.id));
    assert.equal(result.some(file => file.path === sourcePath), true);
    assert.equal(output.includes(sourcePath), false);
    assert.equal(output.includes('invalid ZIP structure'), false);
    assert.match(output, /asset-baseline-scan-failed/);
    await waitForCondition(() => validationAttempts > 0, 'expected strict ZIP validation');

    const fresh = await getProject(project.id);
    assert.equal(fresh.assetBaseline.status, 'awaiting-first-scan');
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(review.error, 'asset_baseline_scan_incomplete');
  } finally {
    setChildProcessHandler(null);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('post-preflight regex extraction failure keeps the baseline unresolved', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-regex-extraction-failure-test-'));
  const originalReadFile = fs.promises.readFile;
  let extractionAttempts = 0;
  try {
    const sourcePath = path.join(fixtureRoot, 'Transient Read Failure.ai');
    writeSyntheticAiFile(sourcePath, 'valid readable source before extraction');
    fs.promises.readFile = async function failSourceExtraction(filePath, ...args) {
      if (path.resolve(filePath) === path.resolve(sourcePath)) {
        extractionAttempts++;
        throw new Error('forced post-preflight source read failure');
      }
      return originalReadFile.call(fs.promises, filePath, ...args);
    };

    const project = await createProject('Regex extraction failure');
    manualDialogFor([sourcePath]);
    const result = await callIpcRaw('projects:add-files', project.id);
    assert.equal(result.some(file => file.path === sourcePath), true);
    await waitForCondition(() => extractionAttempts > 0, 'expected strict regex extraction attempt');
    const fresh = await getProject(project.id);
    assert.equal(fresh.assetBaseline.status, 'awaiting-first-scan');
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(review.error, 'asset_baseline_scan_incomplete');
  } finally {
    fs.promises.readFile = originalReadFile;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('Illustrator baseline validation and extraction use one immutable source snapshot', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-immutable-ai-baseline-test-'));
  const originalReadFile = fs.promises.readFile;
  let sourceReadCount = 0;
  try {
    const sourcePath = path.join(fixtureRoot, 'Immutable Snapshot.ai');
    const linkedPath = path.join(fixtureRoot, 'Immutable Snapshot.png');
    fs.writeFileSync(linkedPath, 'immutable snapshot dependency');
    writeSyntheticAiFile(sourcePath, `synthetic illustrator link ${linkedPath}`);

    fs.promises.readFile = async function mutateAfterSourceRead(filePath, ...args) {
      const result = await originalReadFile.call(fs.promises, filePath, ...args);
      if (path.resolve(filePath) === path.resolve(sourcePath)) {
        sourceReadCount++;
        if (sourceReadCount === 1) fs.writeFileSync(sourcePath, 'replacement bytes without dependable structure');
      }
      return result;
    };

    const project = await createProject('Immutable Illustrator baseline');
    manualDialogFor([sourcePath]);
    await callIpcRaw('projects:add-files', project.id);
    const fresh = await waitForProject(
      project.id,
      item => item.assetBaseline && item.assetBaseline.status === 'decision-required'
    );

    assert.equal(sourceReadCount, 1);
    assert.equal(fresh.files.some(file => file.path === linkedPath), true);
    assert.equal(fresh.files.find(file => file.path === linkedPath).assetOrigin, 'existing');
  } finally {
    fs.promises.readFile = originalReadFile;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('Photoshop baseline discovery is scoped to the selected PSD when another document is open', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-photoshop-scoped-baseline-test-'));
  const previousPsdFixture = currentPsdFixture;
  let photoshopScriptAttempts = 0;
  try {
    const sourcePath = path.join(fixtureRoot, 'Selected Source.psd');
    const selectedLinkedPath = path.join(fixtureRoot, 'Selected Existing.png');
    const unrelatedLinkedPath = path.join(fixtureRoot, 'Other Document.png');
    fs.writeFileSync(sourcePath, 'synthetic PSD bytes for stubbed parser');
    fs.writeFileSync(selectedLinkedPath, 'selected PSD dependency');
    fs.writeFileSync(unrelatedLinkedPath, 'unrelated open PSD dependency');
    currentPsdFixture = {
      children: [{ linkedFile: { fullPath: selectedLinkedPath } }],
      linkedFiles: [],
    };
    setChildProcessHandler(({ kind, command, args }) => {
      if (kind === 'exec' && command.includes("grep -i 'Adobe Photoshop'")) {
        return { stdout: 'Adobe Photoshop\n' };
      }
      if (isOsascriptInvocation({ kind, command, args }, 'crate-ps-scan.applescript')) {
        photoshopScriptAttempts++;
        return { stdout: `${unrelatedLinkedPath}\n` };
      }
      return { stdout: '' };
    });

    const project = await createProject('Scoped Photoshop baseline');
    manualDialogFor([sourcePath]);
    await callIpcRaw('projects:add-files', project.id);
    const fresh = await waitForProject(
      project.id,
      item => item.assetBaseline && item.assetBaseline.status === 'decision-required'
    );

    const selectedLinked = fresh.files.find(file => file.path === selectedLinkedPath);
    assert.ok(selectedLinked);
    assert.equal(selectedLinked.assetOrigin, 'existing');
    assert.equal(selectedLinked.source, 'psd-linked');
    assert.equal(fresh.files.some(file => file.path === unrelatedLinkedPath), false);
    assert.equal((fresh.pendingFiles || []).some(file => file.path === unrelatedLinkedPath), false);
    assert.equal(photoshopScriptAttempts, 0);
  } finally {
    currentPsdFixture = previousPsdFixture;
    setChildProcessHandler(null);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('pre-baseline Photoshop polling cannot promote another open document into Existing assets', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-photoshop-prebaseline-poll-test-'));
  const previousPsdFixture = currentPsdFixture;
  try {
    const sourcePath = path.join(fixtureRoot, 'Selected Source.psd');
    const selectedLinkedPath = path.join(fixtureRoot, 'Selected Existing.png');
    const unrelatedLinkedPath = path.join(fixtureRoot, 'Other Open Document.png');
    fs.writeFileSync(sourcePath, 'synthetic PSD bytes for stubbed parser');
    fs.writeFileSync(selectedLinkedPath, 'selected PSD dependency');
    fs.writeFileSync(unrelatedLinkedPath, 'unrelated open PSD dependency');
    currentPsdFixture = {
      children: [{ linkedFile: { fullPath: selectedLinkedPath } }],
      linkedFiles: [],
    };

    const project = await createProject('Pre-baseline Photoshop polling');
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    stored.pendingFiles = [{
      ...makePendingFile(unrelatedLinkedPath, 'ps-poll'),
      captureState: 'needs-save',
      captureReason: 'linked-asset-observed',
      captureEvidence: {
        appFamily: 'photoshop',
        observerMethod: 'photoshop-live-script',
        evidenceStrength: 'structured-app-link',
      },
    }];

    manualDialogFor([sourcePath]);
    await callIpcRaw('projects:add-files', project.id);
    let fresh = await waitForProject(
      project.id,
      item => item.assetBaseline && item.assetBaseline.status === 'decision-required'
    );

    assert.equal(fresh.files.find(file => file.path === selectedLinkedPath).assetOrigin, 'existing');
    assert.equal(fresh.pendingFiles.find(file => file.path === unrelatedLinkedPath).assetOrigin, 'added');
    assert.deepEqual(
      [...fresh.files, ...fresh.pendingFiles]
        .filter(file => file.assetOrigin === 'existing' && file.projectRole === 'asset')
        .map(file => file.path),
      [selectedLinkedPath]
    );

    const decision = await callIpcRaw('projects:set-existing-assets-decision', project.id, 'include');
    assert.equal(decision.success, true);
    fresh = await getProject(project.id);
    assert.equal(fresh.files.some(file => file.path === unrelatedLinkedPath), false);
    assert.equal(fresh.pendingFiles.some(file => file.path === unrelatedLinkedPath), true);
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(review.files.some(file => file.path === unrelatedLinkedPath), false);
  } finally {
    currentPsdFixture = previousPsdFixture;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('post-preflight PSD parser failure keeps the baseline unresolved', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-psd-extraction-failure-test-'));
  const previousPsdFixture = currentPsdFixture;
  let parseAttempts = 0;
  try {
    const sourcePath = path.join(fixtureRoot, 'Transient Parser Failure.psd');
    fs.writeFileSync(sourcePath, 'synthetic PSD bytes for stubbed parser');
    const project = await createProject('PSD extraction failure');
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    stored.pendingFiles = [{
      path: sourcePath,
      name: path.basename(sourcePath),
      ext: '.psd',
      addedAt: Date.now(),
      source: 'app-opened',
      captureState: 'observed',
      projectRole: 'source',
    }];
    currentPsdFixture = () => {
      parseAttempts++;
      if (parseAttempts === 1) return { children: [], linkedFiles: [] };
      throw new Error('forced post-preflight PSD parser failure');
    };

    const result = await callIpcRaw('projects:accept-pending', project.id, sourcePath);
    assert.equal(result.files.some(file => file.path === sourcePath), true);
    assert.equal(parseAttempts, 2);
    const fresh = await getProject(project.id);
    assert.equal(fresh.assetBaseline.status, 'awaiting-first-scan');
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(review.error, 'asset_baseline_scan_incomplete');
  } finally {
    currentPsdFixture = previousPsdFixture;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('post-preflight PSD size growth keeps the baseline unresolved', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-psd-size-growth-test-'));
  const previousPsdFixture = currentPsdFixture;
  const originalStat = fs.promises.stat;
  let sourceStatAttempts = 0;
  try {
    const sourcePath = path.join(fixtureRoot, 'Growing Source.psd');
    fs.writeFileSync(sourcePath, 'synthetic PSD bytes for size-growth test');
    const project = await createProject('PSD size growth');
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    stored.pendingFiles = [{
      path: sourcePath,
      name: path.basename(sourcePath),
      ext: '.psd',
      addedAt: Date.now(),
      source: 'app-opened',
      captureState: 'observed',
      projectRole: 'source',
    }];
    currentPsdFixture = { children: [], linkedFiles: [] };
    fs.promises.stat = async function growAfterPreflight(filePath, ...args) {
      const stat = await originalStat.call(fs.promises, filePath, ...args);
      if (path.resolve(filePath) !== path.resolve(sourcePath)) return stat;
      sourceStatAttempts++;
      if (sourceStatAttempts === 1) return stat;
      return new Proxy(stat, {
        get(target, property) {
          if (property === 'size') return 301 * 1024 * 1024;
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };

    const result = await callIpcRaw('projects:accept-pending', project.id, sourcePath);
    assert.equal(result.files.some(file => file.path === sourcePath), true);
    assert.equal(sourceStatAttempts, 2);
    const fresh = await getProject(project.id);
    assert.equal(fresh.assetBaseline.status, 'awaiting-first-scan');
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(review.error, 'asset_baseline_scan_incomplete');
  } finally {
    fs.promises.stat = originalStat;
    currentPsdFixture = previousPsdFixture;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('post-preflight presentation extraction failure keeps the baseline unresolved', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-presentation-extraction-failure-test-'));
  const originalReadFile = fs.promises.readFile;
  let validationAttempts = 0;
  let extractionAttempts = 0;
  try {
    const sourcePath = path.join(fixtureRoot, 'Transient Presentation Failure.pptx');
    fs.writeFileSync(sourcePath, 'synthetic ZIP bytes validated by the command stub');
    setChildProcessHandler(({ kind, command, args }) => {
      if (kind === 'execFile' && command === '/usr/bin/unzip' && args[0] === '-tqq' && args[1] === sourcePath) {
        validationAttempts++;
      }
      return { stdout: '', stderr: '' };
    });
    fs.promises.readFile = async function failPresentationExtraction(filePath, ...args) {
      if (path.resolve(filePath) === path.resolve(sourcePath)) {
        extractionAttempts++;
        throw new Error('forced post-preflight presentation read failure');
      }
      return originalReadFile.call(fs.promises, filePath, ...args);
    };

    const project = await createProject('Presentation extraction failure');
    manualDialogFor([sourcePath]);
    const result = await callIpcRaw('projects:add-files', project.id);
    assert.equal(result.some(file => file.path === sourcePath), true);
    await waitForCondition(() => extractionAttempts > 0, 'expected strict presentation extraction attempt');
    assert.equal(validationAttempts, 1);
    const fresh = await getProject(project.id);
    assert.equal(fresh.assetBaseline.status, 'awaiting-first-scan');
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(review.error, 'asset_baseline_scan_incomplete');
  } finally {
    fs.promises.readFile = originalReadFile;
    setChildProcessHandler(null);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('post-preflight structured ZIP extraction failures keep every baseline format unresolved', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-structured-zip-failure-test-'));
  const formats = [
    { ext: '.idml', entry: 'Resources/Links.xml' },
    { ext: '.sketch', entry: 'document.json' },
    { ext: '.afdesign', entry: 'metadata.dat' },
    { ext: '.pxd', entry: 'metadata.info' },
  ];
  try {
    for (const { ext, entry } of formats) {
      const sourcePath = path.join(fixtureRoot, `Structured Failure${ext}`);
      fs.writeFileSync(sourcePath, `synthetic ${ext} ZIP bytes`);
      let validationAttempts = 0;
      let extractionAttempts = 0;
      setChildProcessHandler(({ kind, command, args }) => {
        if (kind !== 'execFile' || command !== '/usr/bin/unzip' || args[1] !== sourcePath) {
          return { stdout: '', stderr: '' };
        }
        if (args[0] === '-tqq') {
          validationAttempts++;
          return { stdout: '', stderr: '' };
        }
        if (args[0] === '-l') {
          return { stdout: `       12  01-01-2026  00:00  ${entry}\n`, stderr: '' };
        }
        if (args[0] === '-p' && args[2] === entry) {
          extractionAttempts++;
          return { error: new Error(`forced ${ext} post-preflight extraction failure`) };
        }
        return { stdout: '', stderr: '' };
      });

      const project = await createProject(`Structured ZIP failure ${ext}`);
      manualDialogFor([sourcePath]);
      const result = await callIpcRaw('projects:add-files', project.id);
      assert.equal(result.some(file => file.path === sourcePath), true);
      assert.equal(validationAttempts, 1, `${ext} should pass one strict preflight`);
      assert.equal(extractionAttempts, 1, `${ext} should reach its structured extractor`);
      const fresh = await getProject(project.id);
      assert.equal(fresh.assetBaseline.status, 'awaiting-first-scan');
      const review = await callIpcRaw('projects:prepare-package-review', project.id);
      assert.equal(review.error, 'asset_baseline_scan_incomplete');
      await callIpcRaw('projects:delete', project.id);
    }
  } finally {
    setChildProcessHandler(null);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('first scan reclassifies an already accepted dependency into the Existing cohort', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-existing-reclassification-test-'));
  try {
    const sourcePath = path.join(fixtureRoot, 'Reclassification Source.ai');
    const linkedPath = path.join(fixtureRoot, 'Already Accepted.png');
    fs.writeFileSync(linkedPath, 'already accepted dependency');
    writeSyntheticAiFile(sourcePath, `synthetic illustrator link ${linkedPath}`);

    const project = await createProject('Existing dependency reclassification');
    manualDialogFor([sourcePath]);
    await callIpc('projects:add-files', project.id);
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    stored.files.push({
      path: linkedPath,
      name: path.basename(linkedPath),
      ext: '.png',
      addedAt: Date.now(),
      source: 'chokidar',
      assetOrigin: 'added',
      projectRole: 'asset',
    });

    await emitWatcher('change', sourcePath);
    const fresh = await waitForProject(
      project.id,
      item => item.assetBaseline && item.assetBaseline.status === 'decision-required'
    );
    const linkedFile = fresh.files.find(file => file.path === linkedPath);
    assert.equal(linkedFile.assetOrigin, 'existing');
    assert.equal(linkedFile.projectRole, 'asset');
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('first scan preserves a linked asset explicitly selected in the same Add Files action', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-explicit-baseline-asset-test-'));
  try {
    const sourcePath = path.join(fixtureRoot, 'Explicit Source.ai');
    const linkedPath = path.join(fixtureRoot, 'Explicit Linked.png');
    fs.writeFileSync(linkedPath, 'explicit linked dependency');
    writeSyntheticAiFile(sourcePath, `synthetic illustrator link ${linkedPath}`);

    const project = await createProject('Explicit baseline asset');
    manualDialogFor([sourcePath, linkedPath]);
    await callIpc('projects:add-files', project.id);

    const fresh = await waitForProject(
      project.id,
      item => item.assetBaseline && item.assetBaseline.status === 'empty'
    );
    const linkedFile = fresh.files.find(file => file.path === linkedPath);
    assert.equal(linkedFile.source, 'manual-browse');
    assert.equal(linkedFile.assetOrigin, 'added');
    assert.equal(linkedFile.projectRole, 'asset');
    assert.deepEqual(fresh.excludedAssetKeys, []);

    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.deepEqual(
      review.files.map(file => file.name).sort(),
      ['Explicit Linked.png', 'Explicit Source.ai']
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('explicitly re-adding a discovered source promotes it to Added and scans its dependencies', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-explicit-readd-source-test-'));
  try {
    const discoveredSourcePath = path.join(fixtureRoot, 'Discovered Source.ai');
    const nestedLinkedPath = path.join(fixtureRoot, 'Nested Linked.png');
    fs.writeFileSync(nestedLinkedPath, 'nested linked dependency');
    writeSyntheticAiFile(discoveredSourcePath, `synthetic illustrator link ${nestedLinkedPath}`);

    const project = await createProject('Explicitly re-added source');
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    stored.files.push({
      path: discoveredSourcePath,
      name: path.basename(discoveredSourcePath),
      ext: '.ai',
      addedAt: Date.now() - 1000,
      source: 'scan-on-open',
      assetOrigin: 'existing',
      projectRole: 'asset',
      captureEvidence: {
        relationshipSourcePath: path.join(fixtureRoot, 'Earlier Source.ai'),
      },
    });

    manualDialogFor([discoveredSourcePath]);
    await callIpc('projects:add-files', project.id);

    const fresh = await waitForProject(
      project.id,
      item => item.assetBaseline && item.assetBaseline.status === 'decision-required'
    );
    const readdedSource = fresh.files.find(file => file.path === discoveredSourcePath);
    const nestedLinked = fresh.files.find(file => file.path === nestedLinkedPath);
    assert.equal(readdedSource.explicitUserAuthority.granted, true);
    assert.equal(readdedSource.assetOrigin, 'added');
    assert.equal(nestedLinked.assetOrigin, 'existing');

    const skipped = await callIpcRaw('projects:set-existing-assets-decision', project.id, 'skip');
    assert.equal(skipped.success, true);
    const afterSkip = await getProject(project.id);
    assert.equal(afterSkip.excludedAssetKeys.includes(readdedSource.fileId || readdedSource.path), false);
    assert.equal(afterSkip.excludedAssetKeys.includes(nestedLinked.fileId || nestedLinked.path), true);
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.deepEqual(review.files.map(file => file.name), ['Discovered Source.ai']);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('InDesign first scan attributes links only from the selected source document', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-indesign-baseline-scope-test-'));
  try {
    const selectedSourcePath = path.join(fixtureRoot, 'Selected Source.indd');
    const selectedLinkedPath = path.join(fixtureRoot, 'Selected Linked.png');
    const unrelatedSourcePath = path.join(fixtureRoot, 'Unrelated Open.indd');
    const unrelatedLinkedPath = path.join(fixtureRoot, 'Unrelated Linked.png');
    for (const filePath of [selectedSourcePath, selectedLinkedPath, unrelatedSourcePath, unrelatedLinkedPath]) {
      fs.writeFileSync(filePath, `synthetic bytes for ${path.basename(filePath)}`);
    }

    setChildProcessHandler(({ kind, command, args }) => {
      if (kind === 'exec' && String(command).includes('Adobe InDesign')) {
        return { stdout: '/Applications/Adobe InDesign/Adobe InDesign', stderr: '' };
      }
      if (isOsascriptInvocation({ kind, command, args }, 'crate-indd-query.applescript')) {
        return {
          stdout: [
            `DOC\t${selectedSourcePath}\t${path.basename(selectedSourcePath)}\tfalse\ttrue\t1`,
            `LINK\t${selectedSourcePath}\t${path.basename(selectedSourcePath)}\t${selectedLinkedPath}\tfalse\ttrue`,
            `DOC\t${unrelatedSourcePath}\t${path.basename(unrelatedSourcePath)}\tfalse\tfalse\t1`,
            `LINK\t${unrelatedSourcePath}\t${path.basename(unrelatedSourcePath)}\t${unrelatedLinkedPath}\tfalse\tfalse`,
            'END\t2\t2\t2\t0',
          ].join('\n'),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    const project = await createProject('InDesign baseline source scope');
    manualDialogFor([selectedSourcePath]);
    await callIpc('projects:add-files', project.id);

    const fresh = await waitForProject(
      project.id,
      item => item.assetBaseline && item.assetBaseline.status === 'decision-required'
    );
    assert.equal(fresh.files.some(file => file.path === selectedLinkedPath), true);
    assert.equal(fresh.files.some(file => file.path === unrelatedSourcePath), false);
    assert.equal(fresh.files.some(file => file.path === unrelatedLinkedPath), false);
    assert.equal(fresh.pendingFiles.some(file => file.path === unrelatedLinkedPath), false);
  } finally {
    setChildProcessHandler(null);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('InDesign first scan fails closed for unavailable or incomplete structured snapshots', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-indesign-baseline-fail-closed-test-'));
  const sourcePath = path.join(fixtureRoot, 'Fail Closed Source.indd');
  fs.writeFileSync(sourcePath, 'synthetic InDesign bytes without dependable link metadata');
  const scenarios = [
    {
      name: 'app unavailable',
      handler: ({ kind, command }) => (
        kind === 'exec' && String(command).includes('Adobe InDesign')
          ? { stdout: '', stderr: '' }
          : { stdout: '', stderr: '' }
      ),
    },
    {
      name: 'query failure',
      handler: ({ kind, command, args }) => {
        if (kind === 'exec' && String(command).includes('Adobe InDesign')) {
          return { stdout: '/Applications/Adobe InDesign/Adobe InDesign', stderr: '' };
        }
        if (isOsascriptInvocation({ kind, command, args }, 'crate-indd-query.applescript')) {
          return { error: new Error('forced InDesign query failure') };
        }
        return { stdout: '', stderr: '' };
      },
    },
    {
      name: 'query timeout',
      handler: ({ kind, command, args }) => {
        if (kind === 'exec' && String(command).includes('Adobe InDesign')) {
          return { stdout: '/Applications/Adobe InDesign/Adobe InDesign', stderr: '' };
        }
        if (isOsascriptInvocation({ kind, command, args }, 'crate-indd-query.applescript')) {
          const error = new Error('forced InDesign query timeout');
          error.code = 'ETIMEDOUT';
          return { error };
        }
        return { stdout: '', stderr: '' };
      },
    },
    {
      name: 'empty query output',
      handler: ({ kind, command }) => (
        kind === 'exec' && String(command).includes('Adobe InDesign')
          ? { stdout: '/Applications/Adobe InDesign/Adobe InDesign', stderr: '' }
          : { stdout: '', stderr: '' }
      ),
    },
    {
      name: 'malformed query output',
      handler: ({ kind, command, args }) => {
        if (kind === 'exec' && String(command).includes('Adobe InDesign')) {
          return { stdout: '/Applications/Adobe InDesign/Adobe InDesign', stderr: '' };
        }
        if (isOsascriptInvocation({ kind, command, args }, 'crate-indd-query.applescript')) {
          return { stdout: `DOC\t${sourcePath}`, stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
    },
    {
      name: 'partial link query output',
      handler: ({ kind, command, args }) => {
        if (kind === 'exec' && String(command).includes('Adobe InDesign')) {
          return { stdout: '/Applications/Adobe InDesign/Adobe InDesign', stderr: '' };
        }
        if (isOsascriptInvocation({ kind, command, args }, 'crate-indd-query.applescript')) {
          return {
            stdout: [
              `DOC\t${sourcePath}\t${path.basename(sourcePath)}\tfalse\ttrue\t1`,
              'END\t1\t1\t0\t0',
            ].join('\n'),
            stderr: '',
          };
        }
        return { stdout: '', stderr: '' };
      },
    },
    {
      name: 'invalid boolean fields',
      handler: ({ kind, command, args }) => {
        if (kind === 'exec' && String(command).includes('Adobe InDesign')) {
          return { stdout: '/Applications/Adobe InDesign/Adobe InDesign', stderr: '' };
        }
        if (isOsascriptInvocation({ kind, command, args }, 'crate-indd-query.applescript')) {
          return {
            stdout: [
              `DOC\t${sourcePath}\t${path.basename(sourcePath)}\tFalse\ttrue\t0`,
              'END\t1\t0\t0\t0',
            ].join('\n'),
            stderr: '',
          };
        }
        return { stdout: '', stderr: '' };
      },
    },
  ];

  try {
    for (const scenario of scenarios) {
      setChildProcessHandler(scenario.handler);
      const project = await createProject(`InDesign fail closed: ${scenario.name}`);
      manualDialogFor([sourcePath]);
      const files = await callIpc('projects:add-files', project.id);
      assert.equal(files.some(file => file.path === sourcePath), true, scenario.name);
      const fresh = await getProject(project.id);
      assert.equal(fresh.assetBaseline.status, 'awaiting-first-scan', scenario.name);
      const review = await callIpcRaw('projects:prepare-package-review', project.id);
      assert.equal(review.error, 'asset_baseline_scan_incomplete', scenario.name);
      await callIpcRaw('projects:delete', project.id);
    }
  } finally {
    setChildProcessHandler(null);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('InDesign first scan accepts a well-formed selected document with no links', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-indesign-empty-baseline-test-'));
  try {
    const sourcePath = path.join(fixtureRoot, 'No Links Source.indd');
    fs.writeFileSync(sourcePath, 'synthetic InDesign bytes with a dependable empty snapshot');
    setChildProcessHandler(({ kind, command, args }) => {
      if (kind === 'exec' && String(command).includes('Adobe InDesign')) {
        return { stdout: '/Applications/Adobe InDesign/Adobe InDesign', stderr: '' };
      }
      if (isOsascriptInvocation({ kind, command, args }, 'crate-indd-query.applescript')) {
        return {
          stdout: [
            `DOC\t${sourcePath}\t${path.basename(sourcePath)}\tfalse\ttrue\t0`,
            'END\t1\t0\t0\t0',
          ].join('\n'),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    const project = await createProject('InDesign dependable empty baseline');
    manualDialogFor([sourcePath]);
    await callIpc('projects:add-files', project.id);
    const fresh = await getProject(project.id);
    assert.equal(fresh.assetBaseline.status, 'empty');
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.deepEqual(review.files.map(file => file.name), ['No Links Source.indd']);
  } finally {
    setChildProcessHandler(null);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('Include Existing promotes the displayed existing pending cohort into Package Review', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-include-existing-pending-test-'));
  try {
    const sourcePath = path.join(fixtureRoot, 'Include Source.ai');
    const pendingPath = path.join(fixtureRoot, 'Include Pending.png');
    fs.writeFileSync(sourcePath, 'synthetic source');
    fs.writeFileSync(pendingPath, 'synthetic pending dependency');
    const project = await createProject('Include existing pending cohort');
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    stored.files = [{
      path: sourcePath,
      name: path.basename(sourcePath),
      ext: '.ai',
      addedAt: Date.now(),
      source: 'manual-browse',
      assetOrigin: 'added',
      projectRole: 'source',
    }];
    stored.pendingFiles = [{
      path: pendingPath,
      name: path.basename(pendingPath),
      ext: '.png',
      addedAt: Date.now(),
      source: 'scan-on-open',
      assetOrigin: 'existing',
      projectRole: 'asset',
      captureState: 'observed',
    }];
    stored.assetBaseline = { schemaVersion: 1, status: 'decision-required', decision: null, establishedAt: Date.now() };

    const decision = await callIpcRaw('projects:set-existing-assets-decision', project.id, 'include');
    assert.equal(decision.success, true);
    const fresh = await getProject(project.id);
    assert.deepEqual(fresh.pendingFiles, []);
    assert.equal(fresh.files.some(file => file.path === pendingPath && file.acceptedPending === true), true);
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.deepEqual(review.files.map(file => file.name).sort(), ['Include Pending.png', 'Include Source.ai']);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('Explicit Add Files restores a file previously excluded by Skip Existing', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-restore-skipped-existing-test-'));
  try {
    const assetPath = path.join(fixtureRoot, 'Restore Existing.png');
    fs.writeFileSync(assetPath, 'restore skipped bytes');
    const project = await createProject('Restore skipped existing');
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    stored.files = [{
      path: assetPath,
      name: path.basename(assetPath),
      ext: '.png',
      addedAt: Date.now(),
      source: 'scan-on-open',
      assetOrigin: 'existing',
      projectRole: 'asset',
    }];
    stored.assetBaseline = { schemaVersion: 1, status: 'skipped', decision: 'skip', establishedAt: Date.now() };
    stored.excludedAssetKeys = [assetPath];

    manualDialogFor([assetPath]);
    await callIpc('projects:add-files', project.id);
    const fresh = await getProject(project.id);
    assert.deepEqual(fresh.excludedAssetKeys, []);
    assert.equal(fresh.files.length, 1);
    assert.equal(fresh.files[0].explicitUserAuthority.granted, true);
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.deepEqual(review.files.map(file => file.name), ['Restore Existing.png']);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('invalid or premature existing-assets decisions fail closed without changing project state', async () => {
  const project = await createProject('Unavailable existing-assets decision');
  const before = structuredClone(await getProject(project.id));

  assert.deepEqual(
    await callIpcRaw('projects:set-existing-assets-decision', project.id, 'include'),
    { success: false, error: 'asset_baseline_decision_unavailable' }
  );
  assert.deepEqual(
    await callIpcRaw('projects:set-existing-assets-decision', project.id, 'invalid'),
    { success: false, error: 'invalid_asset_baseline_decision' }
  );
  assert.deepEqual(await getProject(project.id), before);
});

test('capture routes distinguish linked primary-format assets from a locally saved Figma source', async () => {
  const project = await createProject('Capture route roles');
  const files = [
    makePendingFile(path.join(os.tmpdir(), 'Photoshop Linked.psd'), 'ps-poll'),
    makePendingFile(path.join(os.tmpdir(), 'InDesign Linked.ai'), 'indd-poll'),
    makePendingFile(path.join(os.tmpdir(), 'Local Figma Source.fig'), 'fig-scan'),
  ];
  await setProjectFiles(project.id, { files, preserveAwaitingAssetBaseline: true });

  const fresh = await getProject(project.id);

  assert.deepEqual(
    fresh.files.map(file => [file.source, file.projectRole]),
    [
      ['ps-poll', 'asset'],
      ['indd-poll', 'asset'],
      ['fig-scan', 'source'],
    ]
  );
  assert.equal(fresh.files.some(file => Object.hasOwn(file, 'assetOrigin')), false);
});

test('legacy projects preserve accepted files without prompting and retain exact exclusion identities', async () => {
  const project = await createProject('Legacy asset review migration');
  const stored = storeInstance.data.projects.find(item => item.id === project.id);
  const sourcePath = path.join(os.tmpdir(), 'Legacy Source.ai');
  const linkedPath = path.join(os.tmpdir(), 'Legacy Linked.png');
  delete stored.assetBaseline;
  stored.excludedAssetKeys = [sourcePath, linkedPath, `${linkedPath} `, linkedPath, '', null];
  stored.files = [{
    path: sourcePath,
    name: path.basename(sourcePath),
    ext: '.ai',
    addedAt: stored.createdAt,
    source: 'manual-browse',
  }];
  stored.pendingFiles = [{
    path: linkedPath,
    name: path.basename(linkedPath),
    ext: '.png',
    addedAt: stored.createdAt,
    source: 'psd-linked',
  }];

  const fresh = await getProject(project.id);

  assert.deepEqual(fresh.assetBaseline, {
    schemaVersion: 1,
    status: 'legacy-included',
    decision: 'include',
    establishedAt: stored.watchStartedAt,
  });
  assert.deepEqual(fresh.excludedAssetKeys, [linkedPath, `${linkedPath} `]);
  assert.equal(fresh.files[0].assetOrigin, 'existing');
  assert.equal(fresh.files[0].projectRole, 'source');
  assert.equal(fresh.pendingFiles[0].assetOrigin, 'existing');
  assert.equal(fresh.pendingFiles[0].projectRole, 'asset');
});

test('malformed or future asset baseline records fail closed instead of migrating as included', async () => {
  for (const [name, malformedBaseline] of [
    ['null value', null],
    ['string value', 'corrupt'],
    ['missing status', { schemaVersion: 1, decision: null }],
    ['future schema', { schemaVersion: 2, status: 'included', decision: 'include' }],
    ['invalid decision', { schemaVersion: 1, status: 'included', decision: null }],
  ]) {
    const project = await createProject(`Malformed baseline ${name}`);
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    stored.assetBaseline = malformedBaseline;

    const fresh = await getProject(project.id);
    assert.deepEqual(fresh.assetBaseline, {
      schemaVersion: 1,
      status: 'invalid',
      decision: null,
      establishedAt: null,
    });
    assert.equal(
      (await callIpcRaw('projects:prepare-package-review', project.id)).error,
      'asset_baseline_scan_incomplete'
    );
  }
});

test('manual add preserves file ledger entry and records one session observation', async () => {
  const project = await createProject('Manual provenance');
  const filePath = path.join(os.tmpdir(), 'brand-logo.ai');
  try {
    fs.writeFileSync(filePath, 'synthetic blank Illustrator source');
    manualDialogFor([filePath]);
    const files = await callIpc('projects:add-files', project.id);

    assert.equal(files.length, 1);
    assert.deepEqual(Object.keys(files[0]).sort(), ['addedAt', 'assetOrigin', 'ext', 'name', 'path', 'projectRole', 'source']);
    assert.equal(files[0].path, filePath);
    assert.equal(files[0].name, 'brand-logo.ai');
    assert.equal(files[0].ext, '.ai');
    assert.equal(files[0].source, 'manual-browse');
    assert.equal(files[0].assetOrigin, 'added');
    assert.equal(files[0].projectRole, 'source');

    const fresh = await getProject(project.id);
    assertSessionObservedFile(
      fresh,
      OBSERVER_KINDS.MANUAL_USER_ACTION,
      'projects:add-files',
      CONFIDENCE_BANDS.CONFIRMED
    );
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test('manual image add is classified as an added asset rather than a project source', async () => {
  const project = await createProject('Manual image asset');
  const filePath = path.join(os.tmpdir(), 'campaign-photo.png');

  manualDialogFor([filePath]);
  const files = await callIpc('projects:add-files', project.id);

  assert.equal(files.length, 1);
  assert.equal(files[0].assetOrigin, 'added');
  assert.equal(files[0].projectRole, 'asset');
});

test('duplicate manual add does not duplicate session observations', async () => {
  const project = await createProject('Duplicate manual provenance');
  const filePath = path.join(os.tmpdir(), 'duplicate-logo.ai');
  try {
    fs.writeFileSync(filePath, 'synthetic duplicate Illustrator source');
    manualDialogFor([filePath]);
    await callIpc('projects:add-files', project.id);
    manualDialogFor([filePath]);
    await callIpc('projects:add-files', project.id);

    const fresh = await getProject(project.id);
    assert.equal(fresh.files.length, 1);
    assert.equal(fresh.provenance.observations.length, 1);
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test('accept pending preserves file ledger entry and records one confirmed session observation', async () => {
  const project = await createProject('Accept pending provenance');
  const filePath = path.join(os.tmpdir(), 'accepted-pending.ai');
  const pendingFile = makePendingFile(filePath);
  await setProjectFiles(project.id, { pendingFiles: [pendingFile] });

  const result = await callIpc('projects:accept-pending', project.id, filePath);

  assert.equal(result.files.length, 1);
  assert.deepEqual(result.files[0], { ...pendingFile, acceptedPending: true, assetOrigin: 'added' });
  assert.deepEqual(result.pendingFiles, []);

  const fresh = await getProject(project.id);
  assert.deepEqual(fresh.files, [{ ...pendingFile, acceptedPending: true, assetOrigin: 'added' }]);
  assert.deepEqual(fresh.pendingFiles, []);
  assertSessionObservedFile(
    fresh,
    OBSERVER_KINDS.MANUAL_USER_ACTION,
    'projects:accept-pending',
    CONFIDENCE_BANDS.CONFIRMED
  );
});

test('accept pending preserves an existing dependency origin for the persistent asset panel', async () => {
  const project = await createProject('Accept existing dependency');
  const filePath = path.join(os.tmpdir(), 'existing-linked-asset.png');
  const pendingFile = {
    ...makePendingFile(filePath, 'psd-linked'),
    assetOrigin: 'existing',
    projectRole: 'asset',
  };
  await setProjectFiles(project.id, { pendingFiles: [pendingFile] });

  const result = await callIpc('projects:accept-pending', project.id, filePath);

  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].assetOrigin, 'existing');
  assert.equal(result.files[0].projectRole, 'asset');
  assert.deepEqual(result.pendingFiles, []);
});

test('accept pending source triggers persisted scan-on-open linked asset discovery', async () => {
  resetTestHomeWorkspace();
  const repoTempRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-accept-pending-scan-'));

  try {
    const sourcePath = path.join(repoTempRoot, 'accepted-source.ai');
    const linkedPath = path.join(repoTempRoot, 'accepted-linked.png');
    fs.writeFileSync(linkedPath, 'linked bytes');
    writeSyntheticAiFile(sourcePath, `ai persisted link ${linkedPath}`);

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
    assert.equal(result.files.length, 2);
    const acceptedSource = result.files.find(file => file.path === sourcePath);
    assert.equal(acceptedSource.acceptedPending, true);
    assert.equal(Object.prototype.hasOwnProperty.call(acceptedSource, 'captureState'), false);

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

test('accepting a pending PDF establishes its baseline and blocks review for its existing dependency', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-accept-pending-pdf-'));
  try {
    const sourcePath = path.join(fixtureRoot, 'Accepted Reference.pdf');
    const linkedPath = path.join(fixtureRoot, 'Accepted Reference.png');
    fs.writeFileSync(linkedPath, 'accepted PDF dependency');
    writeSyntheticPdfFile(sourcePath, `accepted PDF link ${linkedPath}`);

    const project = await createProject('Accepted pending PDF baseline');
    await setProjectFiles(project.id, {
      pendingFiles: [{
        ...makePendingFile(sourcePath, 'app-opened'),
        captureState: 'observed',
        projectRole: 'asset',
      }],
      preserveAwaitingAssetBaseline: true,
    });

    const result = await callIpcRaw('projects:accept-pending', project.id, sourcePath);
    assert.equal(result.files.some(file => file.path === sourcePath && file.acceptedPending === true), true);
    const fresh = await waitForProject(
      project.id,
      item => item.assetBaseline && item.assetBaseline.status === 'decision-required'
    );
    assert.equal(fresh.files.find(file => file.path === sourcePath).projectRole, 'asset');
    assert.equal(fresh.files.find(file => file.path === linkedPath).assetOrigin, 'existing');
    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(review.error, 'asset_baseline_decision_required');
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('Explicit Add restores a persisted baseline relationship after its original source is removed', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-explicit-baseline-restore-test-'));
  try {
    const missingSource = path.join(fixtureRoot, 'Removed Source.ai');
    const linkedPath = path.join(fixtureRoot, 'Restored Asset.png');
    fs.writeFileSync(linkedPath, 'restored dependency');
    const project = await createProject('Explicit relationship restore');
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    stored.files = [{
      path: linkedPath,
      name: path.basename(linkedPath),
      ext: '.png',
      addedAt: Date.now(),
      source: 'scan-on-open',
      assetOrigin: 'existing',
      projectRole: 'asset',
      assetBaselineSourcePath: missingSource,
      captureEvidence: { appFamily: 'illustrator' },
    }];
    stored.assetBaseline = { schemaVersion: 1, status: 'included', decision: 'include', establishedAt: Date.now() };
    assert.equal((await getProject(project.id)).files.some(file => file.path === linkedPath), false);

    manualDialogFor([linkedPath]);
    await callIpcRaw('projects:add-files', project.id);
    const restored = await getProject(project.id);
    assert.equal(restored.files.some(file => file.path === linkedPath), true);
    assert.equal(Object.hasOwn(restored.files.find(file => file.path === linkedPath), 'assetBaselineSourcePath'), false);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('explicit and accepted-pending sources settle their baselines while another project is Watching', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(originalHomedir(), 'crate-paused-baseline-source-'));
  try {
    const manualSource = path.join(fixtureRoot, 'Paused Manual.ai');
    const manualLinked = path.join(fixtureRoot, 'Paused Manual.png');
    const acceptedSource = path.join(fixtureRoot, 'Paused Accepted.pdf');
    const acceptedLinked = path.join(fixtureRoot, 'Paused Accepted.png');
    fs.writeFileSync(manualLinked, 'paused manual dependency');
    fs.writeFileSync(acceptedLinked, 'paused accepted dependency');
    writeSyntheticAiFile(manualSource, `paused manual link ${manualLinked}`);
    writeSyntheticPdfFile(acceptedSource, `paused accepted link ${acceptedLinked}`);

    const manualProject = await createProject('Paused manual baseline');
    await createProject('Sole Watching replacement');
    assert.equal((await getProject(manualProject.id)).status, 'paused');
    const manualStored = storeInstance.data.projects.find(item => item.id === manualProject.id);
    manualStored.files.push({
      path: manualLinked,
      name: path.basename(manualLinked),
      ext: '.png',
      addedAt: Date.now(),
      source: 'scan-on-open',
      assetOrigin: 'added',
      projectRole: 'asset',
    });

    manualDialogFor([manualSource]);
    await callIpcRaw('projects:add-files', manualProject.id);
    let fresh = await waitForProject(
      manualProject.id,
      item => item.assetBaseline && item.assetBaseline.status === 'decision-required'
    );
    assert.equal(fresh.status, 'paused');
    assert.equal(fresh.files.find(file => file.path === manualLinked).assetOrigin, 'existing');
    assert.equal(fresh.files.find(file => file.path === manualLinked).assetBaselineSourcePath, manualSource);
    assert.equal((await callIpcRaw('projects:prepare-package-review', manualProject.id)).error, 'asset_baseline_decision_required');

    const acceptedProject = await createProject('Paused accepted baseline');
    await createProject('New sole Watching replacement');
    const stored = storeInstance.data.projects.find(item => item.id === acceptedProject.id);
    stored.pendingFiles = [{
      ...makePendingFile(acceptedSource, 'app-opened'),
      captureState: 'observed',
      projectRole: 'asset',
    }];
    const result = await callIpcRaw('projects:accept-pending', acceptedProject.id, acceptedSource);
    assert.equal(result.files.some(file => file.path === acceptedSource), true);
    fresh = await waitForProject(
      acceptedProject.id,
      item => item.assetBaseline && item.assetBaseline.status === 'decision-required'
    );
    assert.equal(fresh.status, 'paused');
    assert.equal(fresh.files.find(file => file.path === acceptedLinked).assetOrigin, 'existing');
    assert.equal((await callIpcRaw('projects:prepare-package-review', acceptedProject.id)).error, 'asset_baseline_decision_required');

    const unrelatedProject = await createProject('Unrelated paused relationship');
    await createProject('Final sole Watching replacement');
    const unrelatedStored = storeInstance.data.projects.find(item => item.id === unrelatedProject.id);
    unrelatedStored.files = [{
      path: manualLinked,
      name: path.basename(manualLinked),
      ext: '.png',
      addedAt: Date.now(),
      source: 'scan-on-open',
      assetOrigin: 'existing',
      projectRole: 'asset',
      assetBaselineSourcePath: manualSource,
      captureEvidence: { appFamily: 'illustrator' },
    }];
    unrelatedStored.assetBaseline = { schemaVersion: 1, status: 'included', decision: 'include', establishedAt: Date.now() };
    assert.equal((await getProject(unrelatedProject.id)).files.some(file => file.path === manualLinked), false);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

for (const parserLane of ['linked', 'psd']) {
  for (const race of ['pause', 'delete', 'b-a-b']) {
    test(`accept-pending ${parserLane} parser rejects ${race} stale work`, async () => {
      await assertAcceptPendingScanRaceFailsClosed(parserLane, race);
    });
  }
}

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
  try {
    fs.writeFileSync(filePath, 'synthetic provenance-failure Illustrator source');
    manualDialogFor([filePath]);
    const files = await callIpc('projects:add-files', project.id);

    assert.equal(files.length, 1);
    assert.equal(files[0].path, filePath);
    const fresh = await getProject(project.id);
    assert.equal(fresh.files.length, 1);
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test('chokidar add records session observation only after primary design file add succeeds', async () => {
  const filePath = path.join(os.tmpdir(), 'layout.psd');
  fs.writeFileSync(filePath, 'older design file');
  const project = await createProject('Chokidar add provenance');
  const stored = storeInstance.data.projects.find(item => item.id === project.id);

  await emitWatcherWithStats('add', filePath, {
    mtimeMs: stored.watchStartedAt + 1,
    birthtimeMs: stored.watchStartedAt + 1,
  });
  await emitWatcherWithStats('add', filePath, {
    mtimeMs: stored.watchStartedAt + 1,
    birthtimeMs: stored.watchStartedAt + 1,
  });

  const fresh = await getProject(project.id);
  assert.equal(fresh.files.length, 1);
  assert.equal(fresh.files[0].path, filePath);
  assert.equal(fresh.files[0].ext, '.psd');
  assert.equal(fresh.files[0].source, 'chokidar-add');
  assertSessionObservedFile(
    fresh,
    OBSERVER_KINDS.CHOKIDAR,
    'add',
    CONFIDENCE_BANDS.CANDIDATE
  );
});

test('chokidar add stages a pre-existing primary design file for review', async () => {
  setChildProcessHandler(() => ({ stdout: '' }));
  const filePath = path.join(TEST_HOME, 'Desktop', 'Review_Project.ai');
  writeSyntheticAiFile(filePath, 'pre-existing primary source');
  const project = await createProject('Pre-existing chokidar add');
  const stored = storeInstance.data.projects.find(item => item.id === project.id);

  let sourceReadCount = 0;
  const originalReadFile = fs.promises.readFile;
  const originalReadFileSync = fs.readFileSync;
  fs.promises.readFile = async function countSourceReads(candidatePath, ...args) {
    if (path.resolve(candidatePath) === path.resolve(filePath)) sourceReadCount++;
    return originalReadFile.call(fs.promises, candidatePath, ...args);
  };
  fs.readFileSync = function countSourceReadsSync(candidatePath, ...args) {
    if (path.resolve(candidatePath) === path.resolve(filePath)) sourceReadCount++;
    return originalReadFileSync.call(fs, candidatePath, ...args);
  };
  try {
    await emitWatcherWithStats('add', filePath, {
      mtimeMs: stored.watchStartedAt - 10_000,
      birthtimeMs: stored.watchStartedAt - 20_000,
    });
  } finally {
    fs.promises.readFile = originalReadFile;
    fs.readFileSync = originalReadFileSync;
  }

  const fresh = await getProject(project.id);
  assert.equal(fresh.files.some(file => file.path === filePath), false);
  assert.equal(fresh.pendingFiles.filter(file => file.path === filePath).length, 1);
  const pending = fresh.pendingFiles.find(file => file.path === filePath);
  assert.equal(pending.captureState, 'pending');
  assert.equal(pending.captureReason, 'chokidar-add');
  assert.equal(pending.source, 'chokidar-add');
  assert.equal(pending.captureEvidence.source, 'chokidar-add');
  assert.equal(pending.captureEvidence.observerMethod, 'chokidar-add');
  assert.equal(pending.captureEvidence.evidenceStrength, 'broad-app-signal');
  assert.equal(sourceReadCount, 0);
  assert.equal(getProvenanceNodes(fresh, NODE_TYPES.APP).length, 0);
  assert.equal(getProvenanceNodes(fresh, NODE_TYPES.APP_PROCESS).length, 0);
  assert.equal(getSessionObservedByMethod(fresh, 'add').length, 0);
});

test('package drain waits for an unresolved chokidar add admission and blocks its late mutation', async () => {
  const filePath = path.join(TEST_HOME, 'Desktop', 'Drain_Race_Project.ai');
  writeSyntheticAiFile(filePath, 'package drain race');
  const project = await createProject('Chokidar package drain race');
  const stored = storeInstance.data.projects.find(item => item.id === project.id);
  let markStatStarted;
  let releaseStat;
  const statStarted = new Promise(resolve => { markStatStarted = resolve; });
  const statGate = new Promise(resolve => { releaseStat = resolve; });
  const originalStat = fs.promises.stat;
  fs.promises.stat = async function holdCandidateStat(candidatePath, ...args) {
    if (path.resolve(candidatePath) === path.resolve(filePath)) {
      markStatStarted();
      return statGate;
    }
    return originalStat.call(fs.promises, candidatePath, ...args);
  };
  let drainPromise;
  try {
    const addPromise = emitWatcher('add', filePath);
    await statStarted;
    let drainSettled = false;
    drainPromise = metadataTestHooks.pauseWatcherCoordinatorForPackage(project.id).then(result => {
      drainSettled = true;
      return result;
    });
    await new Promise(resolve => originalSetTimeout(resolve, 25));
    assert.equal(drainSettled, false);
    releaseStat({
      mtimeMs: stored.watchStartedAt + 1,
      birthtimeMs: stored.watchStartedAt + 1,
    });
    assert.equal(await drainPromise, true);
    await addPromise;
    const fresh = await getProject(project.id);
    assert.equal(fresh.files.some(file => file.path === filePath), false);
    assert.equal(fresh.pendingFiles.some(file => file.path === filePath), false);
  } finally {
    releaseStat({
      mtimeMs: stored.watchStartedAt + 1,
      birthtimeMs: stored.watchStartedAt + 1,
    });
    if (drainPromise) await drainPromise.catch(() => {});
    fs.promises.stat = originalStat;
    metadataTestHooks.resumeWatcherCoordinatorAfterPackage(project.id);
  }
});

test('different chokidar adds queued behind coordinator contention are both admitted', async () => {
  const firstPath = path.join(TEST_HOME, 'Desktop', 'Queued_First_Project.ai');
  const secondPath = path.join(TEST_HOME, 'Desktop', 'Queued_Second_Project.indd');
  writeSyntheticAiFile(firstPath, 'first queued source');
  fs.writeFileSync(secondPath, 'second queued source');
  const project = await createProject('Queued distinct chokidar adds');
  const stored = storeInstance.data.projects.find(item => item.id === project.id);
  let releaseFirstStat;
  let markFirstStatStarted;
  const firstStatStarted = new Promise(resolve => { markFirstStatStarted = resolve; });
  const firstStatGate = new Promise(resolve => { releaseFirstStat = resolve; });
  const originalStat = fs.promises.stat;
  fs.promises.stat = async function holdFirstCandidateStat(candidatePath, ...args) {
    if (path.resolve(candidatePath) === path.resolve(firstPath)) {
      markFirstStatStarted();
      return firstStatGate;
    }
    if ([firstPath, secondPath].some(filePath => path.resolve(filePath) === path.resolve(candidatePath))) {
      return {
        mtimeMs: stored.watchStartedAt + 1,
        birthtimeMs: stored.watchStartedAt + 1,
      };
    }
    return originalStat.call(fs.promises, candidatePath, ...args);
  };
  try {
    const firstAdd = emitWatcher('add', firstPath);
    await firstStatStarted;
    const secondAdd = emitWatcher('add', secondPath);
    releaseFirstStat({
      mtimeMs: stored.watchStartedAt + 1,
      birthtimeMs: stored.watchStartedAt + 1,
    });
    await Promise.all([firstAdd, secondAdd]);
  } finally {
    releaseFirstStat({
      mtimeMs: stored.watchStartedAt + 1,
      birthtimeMs: stored.watchStartedAt + 1,
    });
    fs.promises.stat = originalStat;
  }

  const fresh = await getProject(project.id);
  assert.equal(fresh.files.filter(file => file.path === firstPath).length, 1);
  assert.equal(fresh.files.filter(file => file.path === secondPath).length, 1);
  assert.equal(fresh.pendingFiles.some(file => [firstPath, secondPath].includes(file.path)), false);
  assert.equal(getSessionObservedByMethod(fresh, 'add').length, 2);
});

test('same-file duplicate chokidar adds coalesce without duplicate state or observations', async () => {
  const filePath = path.join(TEST_HOME, 'Desktop', 'Queued_Duplicate_Project.ai');
  writeSyntheticAiFile(filePath, 'same-file duplicate source');
  const project = await createProject('Queued duplicate chokidar add');
  const stored = storeInstance.data.projects.find(item => item.id === project.id);
  let releaseStat;
  let markStatStarted;
  const statStarted = new Promise(resolve => { markStatStarted = resolve; });
  const statGate = new Promise(resolve => { releaseStat = resolve; });
  const originalStat = fs.promises.stat;
  fs.promises.stat = async function holdDuplicateStat(candidatePath, ...args) {
    if (path.resolve(candidatePath) === path.resolve(filePath)) {
      markStatStarted();
      return statGate;
    }
    return originalStat.call(fs.promises, candidatePath, ...args);
  };
  try {
    const firstAdd = emitWatcher('add', filePath);
    await statStarted;
    const duplicateAdd = emitWatcher('add', filePath);
    releaseStat({
      mtimeMs: stored.watchStartedAt + 1,
      birthtimeMs: stored.watchStartedAt + 1,
    });
    await Promise.all([firstAdd, duplicateAdd]);
  } finally {
    releaseStat({
      mtimeMs: stored.watchStartedAt + 1,
      birthtimeMs: stored.watchStartedAt + 1,
    });
    fs.promises.stat = originalStat;
  }

  const fresh = await getProject(project.id);
  assert.equal(fresh.files.filter(file => file.path === filePath).length, 1);
  assert.equal(fresh.pendingFiles.filter(file => file.path === filePath).length, 0);
  assert.equal(getSessionObservedByMethod(fresh, 'add').length, 1);
  assert.equal(Object.values(fresh.liveEvidenceLedger.candidates || {})
    .filter(entry => entry.latest?.candidateName === path.basename(filePath)).length, 1);
});

test('package pause explicitly invalidates every deferred chokidar add and resume re-observes each path', async () => {
  const blockerPath = path.join(TEST_HOME, 'Desktop', 'Package_Blocker_Project.ai');
  const firstPath = path.join(TEST_HOME, 'Desktop', 'Package_Deferred_First_Project.ai');
  const secondPath = path.join(TEST_HOME, 'Desktop', 'Package_Deferred_Second_Project.ai');
  for (const filePath of [blockerPath, firstPath, secondPath]) writeSyntheticAiFile(filePath, 'package pause queue source');
  const project = await createProject('Package deferred chokidar adds');
  const stored = storeInstance.data.projects.find(item => item.id === project.id);
  let releaseBlockerStat;
  let markBlockerStatStarted;
  const blockerStatStarted = new Promise(resolve => { markBlockerStatStarted = resolve; });
  const blockerStatGate = new Promise(resolve => { releaseBlockerStat = resolve; });
  const originalStat = fs.promises.stat;
  fs.promises.stat = async function holdPackageBlockerStat(candidatePath, ...args) {
    if (path.resolve(candidatePath) === path.resolve(blockerPath)) {
      markBlockerStatStarted();
      return blockerStatGate;
    }
    if ([blockerPath, firstPath, secondPath].some(filePath => path.resolve(filePath) === path.resolve(candidatePath))) {
      return {
        mtimeMs: stored.watchStartedAt + 1,
        birthtimeMs: stored.watchStartedAt + 1,
      };
    }
    return originalStat.call(fs.promises, candidatePath, ...args);
  };
  let drainPromise;
  try {
    const blockerAdd = emitWatcher('add', blockerPath);
    await blockerStatStarted;
    const firstAdd = emitWatcher('add', firstPath);
    const secondAdd = emitWatcher('add', secondPath);
    drainPromise = metadataTestHooks.pauseWatcherCoordinatorForPackage(project.id);
    releaseBlockerStat({
      mtimeMs: stored.watchStartedAt + 1,
      birthtimeMs: stored.watchStartedAt + 1,
    });
    assert.equal(await drainPromise, true);
    await Promise.all([blockerAdd, firstAdd, secondAdd]);

    let fresh = await getProject(project.id);
    assert.equal(fresh.files.some(file => [blockerPath, firstPath, secondPath].includes(file.path)), false);
    assert.equal(fresh.pendingFiles.some(file => [blockerPath, firstPath, secondPath].includes(file.path)), false);
    const pausedSnapshot = metadataTestHooks.getWatcherCoordinatorSnapshot(project.id);
    assert.ok(pausedSnapshot.counters.invalidated >= 2);
    assert.deepEqual(pausedSnapshot.pendingKinds, []);

    metadataTestHooks.resumeWatcherCoordinatorAfterPackage(project.id);
    await Promise.all([
      emitWatcher('add', firstPath),
      emitWatcher('add', secondPath),
    ]);
    fresh = await getProject(project.id);
    assert.equal(fresh.files.filter(file => file.path === firstPath).length, 1);
    assert.equal(fresh.files.filter(file => file.path === secondPath).length, 1);
  } finally {
    releaseBlockerStat({
      mtimeMs: stored.watchStartedAt + 1,
      birthtimeMs: stored.watchStartedAt + 1,
    });
    if (drainPromise) await drainPromise.catch(() => {});
    fs.promises.stat = originalStat;
    metadataTestHooks.resumeWatcherCoordinatorAfterPackage(project.id);
  }
});

test('chokidar add stat timeout fails closed and cannot mutate after a late resolution', async () => {
  const filePath = path.join(TEST_HOME, 'Desktop', 'Timed_Out_Project.ai');
  writeSyntheticAiFile(filePath, 'bounded stat timeout');
  const project = await createProject('Chokidar stat timeout');
  let markStatStarted;
  let releaseStat;
  const statStarted = new Promise(resolve => { markStatStarted = resolve; });
  const statGate = new Promise(resolve => { releaseStat = resolve; });
  const originalStat = fs.promises.stat;
  fs.promises.stat = async function holdTimedOutStat(candidatePath, ...args) {
    if (path.resolve(candidatePath) === path.resolve(filePath)) {
      markStatStarted();
      return statGate;
    }
    return originalStat.call(fs.promises, candidatePath, ...args);
  };
  testRendererEvents.length = 0;
  try {
    const addPromise = emitWatcher('add', filePath);
    await statStarted;
    const settled = await Promise.race([
      addPromise.then(() => true),
      new Promise(resolve => originalSetTimeout(() => resolve(false), 1500)),
    ]);
    assert.equal(settled, true);
    let fresh = await getProject(project.id);
    assert.equal(fresh.files.some(file => file.path === filePath), false);
    assert.equal(fresh.pendingFiles.some(file => file.path === filePath), false);
    releaseStat({
      mtimeMs: project.watchStartedAt + 1,
      birthtimeMs: project.watchStartedAt + 1,
    });
    await new Promise(resolve => setImmediate(resolve));
    fresh = await getProject(project.id);
    assert.equal(fresh.files.some(file => file.path === filePath), false);
    assert.equal(fresh.pendingFiles.some(file => file.path === filePath), false);
    assert.equal(testRendererEvents.some(event => event.data?.projectId === project.id), false);
  } finally {
    releaseStat({
      mtimeMs: project.watchStartedAt + 1,
      birthtimeMs: project.watchStartedAt + 1,
    });
    fs.promises.stat = originalStat;
  }
});

test('a stale chokidar add cannot mutate or scan after watcher generation changes during delay or stat', async () => {
  const delayPath = path.join(TEST_HOME, 'Desktop', 'Stale_Delay_Project.ai');
  writeSyntheticAiFile(delayPath, 'stale during add delay');
  const project = await createProject('Chokidar generation during delay');
  testRendererEvents.length = 0;
  const delayedAdd = emitWatcher('add', delayPath);
  await new Promise(resolve => originalSetTimeout(resolve, 25));
  metadataTestHooks.activateWatcherCoordinator(project.id);
  await delayedAdd;
  let fresh = await getProject(project.id);
  assert.equal(fresh.files.some(file => file.path === delayPath), false);
  assert.equal(fresh.pendingFiles.some(file => file.path === delayPath), false);

  const statPath = path.join(TEST_HOME, 'Desktop', 'Stale_Stat_Project.ai');
  writeSyntheticAiFile(statPath, 'stale during add stat');
  let markStatStarted;
  let releaseStat;
  const statStarted = new Promise(resolve => { markStatStarted = resolve; });
  const statGate = new Promise(resolve => { releaseStat = resolve; });
  const originalStat = fs.promises.stat;
  fs.promises.stat = async function holdStaleStat(candidatePath, ...args) {
    if (path.resolve(candidatePath) === path.resolve(statPath)) {
      markStatStarted();
      return statGate;
    }
    return originalStat.call(fs.promises, candidatePath, ...args);
  };
  try {
    const statAdd = emitWatcher('add', statPath);
    await statStarted;
    metadataTestHooks.activateWatcherCoordinator(project.id);
    releaseStat({
      mtimeMs: project.watchStartedAt + 1,
      birthtimeMs: project.watchStartedAt + 1,
    });
    await statAdd;
    fresh = await getProject(project.id);
    assert.equal(fresh.files.some(file => file.path === statPath), false);
    assert.equal(fresh.pendingFiles.some(file => file.path === statPath), false);
    assert.equal(testRendererEvents.some(event => event.data?.projectId === project.id), false);
  } finally {
    releaseStat({
      mtimeMs: project.watchStartedAt + 1,
      birthtimeMs: project.watchStartedAt + 1,
    });
    fs.promises.stat = originalStat;
  }
});

test('validated current-session chokidar add anchors later relevant broad link evidence', async () => {
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'AnchorProject', 'Anchor_Project.ai');
  const linkedPath = path.join(TEST_HOME, 'Desktop', 'AnchorProject', 'Anchor_Link.ai');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  writeSyntheticAiFile(sourcePath, 'validated current-session anchor');
  fs.writeFileSync(linkedPath, 'related broad link');
  setChildProcessHandler(() => ({ stdout: '' }));
  const project = await createProject('Chokidar current-session anchor');
  const stored = storeInstance.data.projects.find(item => item.id === project.id);
  await emitWatcherWithStats('add', sourcePath, {
    mtimeMs: stored.watchStartedAt + 1,
    birthtimeMs: stored.watchStartedAt + 1,
  });
  let fresh = await getProject(project.id);
  const anchor = fresh.files.find(file => file.path === sourcePath);
  assert.equal(anchor.source, 'chokidar-add');
  assert.equal(Object.prototype.hasOwnProperty.call(anchor, 'currentSessionFilesystemEvidence'), false);

  setChildProcessHandler(({ kind, command }) => {
    if (kind === 'exec' && command.startsWith('/bin/ps ax -o pid= -o command=')) {
      return { stdout: '321 /Applications/Figma.app/Contents/MacOS/Figma\n' };
    }
    if (kind === 'exec' && command.startsWith('/usr/sbin/lsof -F ptn -p 321')) {
      return { stdout: `p321\nf12\ntREG\nn${linkedPath}\n` };
    }
    return { stdout: '' };
  });
  await new Promise(resolve => originalSetTimeout(resolve, 75));
  await metadataTestHooks.pollLsofForProject(
    project.id,
    metadataTestHooks.getActiveWatchingActivationToken(project.id)
  );

  fresh = await getProject(project.id);
  assert.equal(fresh.pendingFiles.some(file => file.path === linkedPath), true);
  assert.equal(Object.values(fresh.liveEvidenceLedger.candidates || {})
    .some(entry => entry.latest?.reason === 'broad-observer-outside-session'), false);
});

test('persisted current-session chokidar markers are cleared before they can anchor broad evidence', async () => {
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'ForgedMarkerProject', 'Forged_Marker_Project.ai');
  const linkedPath = path.join(TEST_HOME, 'Desktop', 'ForgedMarkerProject', 'Forged_Marker_Link.ai');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, 'forged persisted marker source');
  fs.writeFileSync(linkedPath, 'must remain unanchored');
  setChildProcessHandler(() => ({ stdout: '' }));
  const project = await createProject('Forged persisted chokidar marker');
  await setProjectFiles(project.id, {
    files: [{
      path: sourcePath,
      name: path.basename(sourcePath),
      ext: '.ai',
      addedAt: Date.now() - 60_000,
      source: 'chokidar-add',
      currentSessionFilesystemEvidence: true,
    }],
  });

  const normalized = await getProject(project.id);
  const persisted = normalized.files.find(file => file.path === sourcePath);
  assert.ok(persisted);
  assert.equal(Object.prototype.hasOwnProperty.call(persisted, 'currentSessionFilesystemEvidence'), false);

  setChildProcessHandler(({ kind, command }) => {
    if (kind === 'exec' && command.startsWith('/bin/ps ax -o pid= -o command=')) {
      return { stdout: '654 /Applications/Figma.app/Contents/MacOS/Figma\n' };
    }
    if (kind === 'exec' && command.startsWith('/usr/sbin/lsof -F ptn -p 654')) {
      return { stdout: `p654\nf13\ntREG\nn${linkedPath}\n` };
    }
    return { stdout: '' };
  });
  await metadataTestHooks.pollLsofForProject(
    project.id,
    metadataTestHooks.getActiveWatchingActivationToken(project.id)
  );

  const fresh = await getProject(project.id);
  assert.equal(fresh.pendingFiles.some(file => file.path === linkedPath), false);
  assert.ok(Object.values(fresh.liveEvidenceLedger.candidates || {})
    .some(entry => entry.latest?.reason === 'broad-observer-outside-session'));
});

test('a stale pending chokidar add candidate does not anchor later broad link evidence', async () => {
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'StalePendingProject', 'Stale_Pending_Project.ai');
  const linkedPath = path.join(TEST_HOME, 'Desktop', 'StalePendingProject', 'Stale_Pending_Link.ai');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  writeSyntheticAiFile(sourcePath, 'stale pending candidate');
  fs.writeFileSync(linkedPath, 'must remain unanchored');
  setChildProcessHandler(() => ({ stdout: '' }));
  const project = await createProject('Chokidar stale pending anchor');
  const stored = storeInstance.data.projects.find(item => item.id === project.id);
  await emitWatcherWithStats('add', sourcePath, {
    mtimeMs: stored.watchStartedAt - 10_000,
    birthtimeMs: stored.watchStartedAt - 20_000,
  });
  let fresh = await getProject(project.id);
  assert.equal(fresh.pendingFiles.some(file => file.path === sourcePath), true);
  assert.equal(fresh.pendingFiles.some(file => file.currentSessionFilesystemEvidence === true), false);

  setChildProcessHandler(({ kind, command }) => {
    if (kind === 'exec' && command.startsWith('/bin/ps ax -o pid= -o command=')) {
      return { stdout: '654 /Applications/Figma.app/Contents/MacOS/Figma\n' };
    }
    if (kind === 'exec' && command.startsWith('/usr/sbin/lsof -F ptn -p 654')) {
      return { stdout: `p654\nf13\ntREG\nn${linkedPath}\n` };
    }
    return { stdout: '' };
  });
  await new Promise(resolve => originalSetTimeout(resolve, 75));
  await metadataTestHooks.pollLsofForProject(
    project.id,
    metadataTestHooks.getActiveWatchingActivationToken(project.id)
  );

  fresh = await getProject(project.id);
  assert.equal(fresh.pendingFiles.some(file => file.path === linkedPath), false);
  assert.ok(Object.values(fresh.liveEvidenceLedger.candidates || {})
    .some(entry => entry.latest?.reason === 'broad-observer-outside-session'));
});

test('chokidar add keeps a moved or synchronized primary file pending when timestamps are preserved', async () => {
  const filePath = path.join(TEST_HOME, 'Documents', 'Synced', 'Review_Project.indd');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'synchronized old primary source');
  const project = await createProject('Preserved timestamp chokidar add');
  const stored = storeInstance.data.projects.find(item => item.id === project.id);

  await emitWatcherWithStats('add', filePath, {
    mtimeMs: stored.watchStartedAt - 1,
    birthtimeMs: stored.watchStartedAt - 1,
  });

  const fresh = await getProject(project.id);
  assert.equal(fresh.files.some(file => file.path === filePath), false);
  assert.deepEqual(fresh.pendingFiles.map(file => file.path), [filePath]);
  assert.equal(fresh.pendingFiles[0].source, 'chokidar-add');
});

test('chokidar add stat failure leaves an unaccepted primary source untouched', async () => {
  const filePath = path.join(TEST_HOME, 'Desktop', 'Unavailable_Project.ai');
  writeSyntheticAiFile(filePath, 'stat evidence unavailable');
  const project = await createProject('Chokidar add stat failure');
  const before = await getProject(project.id);
  const originalStat = fs.promises.stat;
  fs.promises.stat = async function failCandidateStat(candidatePath, ...args) {
    if (path.resolve(candidatePath) === path.resolve(filePath)) {
      throw new Error('forced candidate stat failure');
    }
    return originalStat.call(fs.promises, candidatePath, ...args);
  };
  try {
    await emitWatcher('add', filePath);
  } finally {
    fs.promises.stat = originalStat;
  }

  const after = await getProject(project.id);
  assert.deepEqual(after.files, before.files);
  assert.deepEqual(after.pendingFiles, before.pendingFiles);
  assert.deepEqual(after.liveEvidenceLedger, before.liveEvidenceLedger);
});

test('chokidar add automatically captures a current-session primary source and scans it', async () => {
  const filePath = path.join(TEST_HOME, 'Desktop', 'New_Project.ai');
  writeSyntheticAiFile(filePath, 'current-session primary source');
  const project = await createProject('Current-session chokidar add');
  const stored = storeInstance.data.projects.find(item => item.id === project.id);
  const captured = await captureConsoleDuring(() => emitWatcherWithStats('add', filePath, {
    mtimeMs: stored.watchStartedAt + 1,
    birthtimeMs: stored.watchStartedAt + 1,
  }));

  const fresh = await getProject(project.id);
  assert.equal(fresh.files.filter(file => file.path === filePath).length, 1);
  assert.deepEqual(fresh.pendingFiles, []);
  assert.equal(fresh.files[0].source, 'chokidar-add');
  assert.match(captured.output, /scan-on-open: scanning New_Project\.ai/);
});

test('chokidar add reopens an accepted primary source and permits a rescan', async () => {
  const filePath = path.join(TEST_HOME, 'Desktop', 'Accepted_Reopen.ai');
  writeSyntheticAiFile(filePath, 'accepted source reopened during session');
  const project = await createProject('Accepted chokidar reopen');
  await setProjectFiles(project.id, {
    files: [{
      path: filePath,
      name: path.basename(filePath),
      ext: '.ai',
      addedAt: Date.now() - 60_000,
      source: 'manual-browse',
    }],
  });
  let sourceReadCount = 0;
  const originalReadFile = fs.promises.readFile;
  const originalReadFileSync = fs.readFileSync;
  fs.promises.readFile = async function countSourceReads(candidatePath, ...args) {
    if (path.resolve(candidatePath) === path.resolve(filePath)) sourceReadCount++;
    return originalReadFile.call(fs.promises, candidatePath, ...args);
  };
  fs.readFileSync = function countSourceReadsSync(candidatePath, ...args) {
    if (path.resolve(candidatePath) === path.resolve(filePath)) sourceReadCount++;
    return originalReadFileSync.call(fs, candidatePath, ...args);
  };
  try {
    await emitWatcherWithStats('add', filePath, {
      mtimeMs: project.watchStartedAt - 20_000,
      birthtimeMs: project.watchStartedAt - 30_000,
    });
  } finally {
    fs.promises.readFile = originalReadFile;
    fs.readFileSync = originalReadFileSync;
  }

  const fresh = await getProject(project.id);
  assert.equal(fresh.files.filter(file => file.path === filePath).length, 1);
  assert.deepEqual(fresh.pendingFiles, []);
  assert.ok(sourceReadCount > 0, 'accepted reopen should retain scan-on-open');
});

test('accepting a pre-existing chokidar candidate moves it to files and enables parser work', async () => {
  const filePath = path.join(TEST_HOME, 'Desktop', 'Accepted_Old_Project.ai');
  writeSyntheticAiFile(filePath, 'old source accepted by the user');
  const project = await createProject('Accept old chokidar candidate');
  const stored = storeInstance.data.projects.find(item => item.id === project.id);
  await emitWatcherWithStats('add', filePath, {
    mtimeMs: stored.watchStartedAt - 10_000,
    birthtimeMs: stored.watchStartedAt - 20_000,
  });
  assert.equal((await getProject(project.id)).pendingFiles.length, 1);

  let sourceReadCount = 0;
  const originalReadFile = fs.promises.readFile;
  fs.promises.readFile = async function countSourceReads(candidatePath, ...args) {
    if (path.resolve(candidatePath) === path.resolve(filePath)) sourceReadCount++;
    return originalReadFile.call(fs.promises, candidatePath, ...args);
  };
  try {
    const result = await callIpc('projects:accept-pending', project.id, filePath);
    assert.equal(result.files.some(file => file.path === filePath && file.acceptedPending === true), true);
    assert.deepEqual(result.pendingFiles, []);
  } finally {
    fs.promises.readFile = originalReadFile;
  }

  const fresh = await getProject(project.id);
  assert.ok(sourceReadCount > 0, 'accepted primary source should enable scan-on-open');
  assert.equal(getSessionObservedByMethod(fresh, 'projects:accept-pending').length, 1);
});

test('rejecting a pre-existing chokidar candidate prevents reappearance and review inclusion', async () => {
  const filePath = path.join(TEST_HOME, 'Desktop', 'Rejected_Old_Project.ai');
  writeSyntheticAiFile(filePath, 'old source rejected by the user');
  const project = await createProject('Reject old chokidar candidate');
  const stored = storeInstance.data.projects.find(item => item.id === project.id);
  await emitWatcherWithStats('add', filePath, {
    mtimeMs: stored.watchStartedAt - 10_000,
    birthtimeMs: stored.watchStartedAt - 20_000,
  });
  await callIpc('projects:reject-pending', project.id, filePath);
  const afterReject = await getProject(project.id);
  assert.ok(afterReject.excludedAssetKeys.includes(filePath));
  await emitWatcherWithStats('add', filePath, {
    mtimeMs: stored.watchStartedAt - 10_000,
    birthtimeMs: stored.watchStartedAt - 20_000,
  });

  const fresh = await getProject(project.id);
  assert.equal(fresh.files.some(file => file.path === filePath), false);
  assert.equal(fresh.pendingFiles.some(file => file.path === filePath), false);
  const review = await callIpcRaw('projects:prepare-package-review', project.id);
  assert.equal(review.files.some(file => file.path === filePath || file.name === path.basename(filePath)), false);
});

test('pre-existing chokidar candidates remain pending across pause and resume without duplicate observers', async () => {
  const filePath = path.join(TEST_HOME, 'Desktop', 'Paused_Old_Project.ai');
  writeSyntheticAiFile(filePath, 'old source across pause and resume');
  const project = await createProject('Pause resume old chokidar candidate');
  const stored = storeInstance.data.projects.find(item => item.id === project.id);
  const staleStats = {
    mtimeMs: stored.watchStartedAt - 10_000,
    birthtimeMs: stored.watchStartedAt - 20_000,
  };
  await emitWatcherWithStats('add', filePath, staleStats);
  await callIpc('projects:pause', project.id);
  await callIpc('projects:start-watching', project.id);
  await emitWatcherWithStats('add', filePath, staleStats);

  const fresh = await getProject(project.id);
  assert.equal(fresh.files.some(file => file.path === filePath), false);
  assert.equal(fresh.pendingFiles.filter(file => file.path === filePath).length, 1);
  const ledgerEntry = Object.values(fresh.liveEvidenceLedger.candidates)
    .find(entry => entry.latest && entry.latest.candidateName === path.basename(filePath));
  assert.ok(ledgerEntry);
  assert.equal(ledgerEntry.observations.length, 1);
  assert.equal(ledgerEntry.latest.source, 'chokidar-add');
  assert.equal(ledgerEntry.latest.observerMethod, 'chokidar-add');
});

test('chokidar change records observation only for a previously unseen primary design file', async () => {
  const project = await createProject('Chokidar change provenance');
  const filePath = path.join(os.tmpdir(), 'identity.ai');
  fs.writeFileSync(filePath, 'current-session identity source');

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

test('current watcher rejects a stale prior-session change before any stateful work', async () => {
  resetTestHomeWorkspace();
  setChildProcessHandler(() => ({ stdout: '' }));
  const staleSource = path.join(TEST_HOME, 'Desktop', 'A_Project.ai');
  const staleLink = path.join(TEST_HOME, 'Desktop', 'A_Asset.png');
  fs.writeFileSync(staleSource, staleLink);
  fs.writeFileSync(staleLink, 'stale linked asset');

  const projectA = await createProject('Generic change session A');
  const watcherA = latestWatcherHandlers();
  const projectB = await createProject('Generic change session B');
  const watcherB = latestWatcherHandlers();
  const storedB = storeInstance.data.projects.find(item => item.id === projectB.id);
  const staleStats = {
    mtimeMs: storedB.watchStartedAt - 10000,
    birthtimeMs: storedB.watchStartedAt - 20000,
  };
  const stateBefore = structuredClone({
    files: storedB.files,
    pendingFiles: storedB.pendingFiles,
    liveEvidenceLedger: storedB.liveEvidenceLedger,
    provenance: storedB.provenance,
  });
  const originalStat = fs.promises.stat;
  const originalReadFile = fs.promises.readFile;
  let sourceStatCount = 0;
  let sourceReadCount = 0;
  fs.promises.stat = async function returnStaleSourceStats(filePath, ...args) {
    if (path.resolve(filePath) === path.resolve(staleSource)) {
      sourceStatCount++;
      return staleStats;
    }
    return originalStat.call(fs.promises, filePath, ...args);
  };
  fs.promises.readFile = async function countStaleSourceReads(filePath, ...args) {
    if (path.resolve(filePath) === path.resolve(staleSource)) sourceReadCount++;
    return originalReadFile.call(fs.promises, filePath, ...args);
  };

  try {
    testRendererEvents.length = 0;
    await watcherB.change(staleSource);
    await watcherA.change(staleSource);

    const freshA = await getProject(projectA.id);
    const freshB = await getProject(projectB.id);
    assert.equal(freshA.status, 'paused');
    assert.equal(freshB.status, 'watching');
    assert.deepEqual({
      files: storedB.files,
      pendingFiles: storedB.pendingFiles,
      liveEvidenceLedger: storedB.liveEvidenceLedger,
      provenance: storedB.provenance,
    }, stateBefore);
    assert.equal([...freshB.files, ...freshB.pendingFiles].some(file => file.path === staleSource), false);
    assert.equal([...freshB.files, ...freshB.pendingFiles].some(file => file.path === staleLink), false);
    assert.equal(sourceStatCount, 1);
    assert.equal(sourceReadCount, 0);
    assert.equal(testRendererEvents.some(event => event.data && event.data.projectId === projectB.id), false);
    assert.equal(testRendererEvents.some(event => event.data && event.data.projectId === projectA.id), false);
  } finally {
    fs.promises.stat = originalStat;
    fs.promises.readFile = originalReadFile;
  }
});

test('fresh generic change captures B source and discovers its linked asset', async () => {
  resetTestHomeWorkspace();
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'B_Project.ai');
  const linkedPath = '/Users/CrateQA/B_Asset.png';
  writeSyntheticAiFile(sourcePath, 'fresh source bytes');
  let illustratorRows = [];
  let illustratorQueryCount = 0;
  setChildProcessHandler(request => {
    if (isIllustratorPgrepCheck(request)) return { stdout: '321\n' };
    if (isOsascriptInvocation(request, 'crate-ai-active-session.applescript')) {
      illustratorQueryCount++;
      if (illustratorRows.length === 0) {
        return { stdout: 'STATUS\tno-documents\nCOMPLETE\t0\t0\n' };
      }
      return { stdout: `${illustratorRows.join('\n')}\nCOMPLETE\t1\t1\n` };
    }
    return { stdout: '' };
  });
  const originalAccess = fs.promises.access;
  const originalAccessSync = fs.accessSync;
  const originalReadFile = fs.promises.readFile;
  let sourceReadCount = 0;
  fs.promises.readFile = async function readSyntheticLinkedPath(filePath, ...args) {
    if (path.resolve(filePath) === path.resolve(sourcePath)) {
      sourceReadCount++;
      return Buffer.from(`%PDF-1.7\n${linkedPath}\n%%EOF\n`);
    }
    return originalReadFile.call(fs.promises, filePath, ...args);
  };
  fs.promises.access = async function accessSyntheticLinkedPath(filePath, ...args) {
    if (path.resolve(filePath) === path.resolve(linkedPath)) return;
    return originalAccess.call(fs.promises, filePath, ...args);
  };
  fs.accessSync = function accessSyntheticLinkedPathSync(filePath, ...args) {
    if (path.resolve(filePath) === path.resolve(linkedPath)) return;
    return originalAccessSync.call(fs, filePath, ...args);
  };

  try {
    const project = await createProject('Fresh generic change session');
    await waitForCondition(
      () => illustratorQueryCount >= 1,
      'timed out waiting for initial Illustrator activation scope'
    );
    illustratorRows = [
      `DOC\t${sourcePath}\tB_Project.ai\ttrue\ttrue`,
      `LINK\t${sourcePath}\tB_Project.ai\t${linkedPath}\ttrue\ttrue`,
    ];
    await runTrackedIntervalCallbacks();
    const stagedProject = await waitForProject(
      project.id,
      item => item.pendingFiles.some(file => file.path === sourcePath) &&
        item.pendingFiles.some(file => file.path === linkedPath),
      5000
    );

    const savedDuringSession = new Date(stagedProject.watchStartedAt + 1000);
    fs.utimesSync(sourcePath, savedDuringSession, savedDuringSession);
    await emitWatcher('change', sourcePath);
    let fresh = await waitForProject(
      project.id,
      item => item.files.some(file => file.path === linkedPath && file.source === 'scan-on-open'),
      5000
    );
    assert.equal(fresh.files.some(file => file.path === sourcePath), true);
    assert.equal(fresh.files.some(file => file.path === linkedPath && file.source === 'scan-on-open'), true);
    assert.equal([...fresh.files, ...fresh.pendingFiles].some(file => file.name === 'A_Project.ai'), false);
    assert.equal([...fresh.files, ...fresh.pendingFiles].some(file => file.name === 'A_Asset.png'), false);
    await waitForCondition(() => sourceReadCount > 0, 'timed out waiting for initial scan-on-open');

    const readCountBeforeRescan = sourceReadCount;
    const staleStats = {
      mtimeMs: fresh.watchStartedAt - 10000,
      birthtimeMs: fresh.watchStartedAt - 20000,
    };
    await emitWatcher('change', sourcePath, staleStats);
    await waitForCondition(
      () => sourceReadCount > readCountBeforeRescan,
      'timed out waiting for accepted-source rescan'
    );
    fresh = await getProject(project.id);
    assert.equal(fresh.files.filter(file => file.path === sourcePath).length, 1);
    assert.equal(fresh.files.filter(file => file.path === linkedPath).length, 1);
  } finally {
    fs.promises.access = originalAccess;
    fs.accessSync = originalAccessSync;
    fs.promises.readFile = originalReadFile;
  }
});

test('generic change rescans a file accepted through Add Files while stat is pending', async () => {
  resetTestHomeWorkspace();
  setChildProcessHandler(() => ({ stdout: '' }));
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'Accepted_During_Stat.ai');
  writeSyntheticAiFile(sourcePath, 'accepted during stat bytes');
  const project = await createProject('Generic change Add Files race');
  const stored = storeInstance.data.projects.find(item => item.id === project.id);
  const staleStats = {
    mtimeMs: stored.watchStartedAt - 10000,
    birthtimeMs: stored.watchStartedAt - 20000,
    size: fs.statSync(sourcePath).size,
    isFile: () => true,
  };

  const originalStat = fs.promises.stat;
  const originalReadFile = fs.promises.readFile;
  let releaseStat;
  let markStatStarted;
  let sourceReadCount = 0;
  const statStarted = new Promise(resolve => { markStatStarted = resolve; });
  const statGate = new Promise(resolve => { releaseStat = resolve; });
  fs.promises.stat = async function deferSourceStat(filePath, ...args) {
    if (path.resolve(filePath) === path.resolve(sourcePath)) {
      markStatStarted();
      return statGate;
    }
    return originalStat.call(fs.promises, filePath, ...args);
  };
  fs.promises.readFile = async function countSourceReads(filePath, ...args) {
    if (path.resolve(filePath) === path.resolve(sourcePath)) sourceReadCount++;
    return originalReadFile.call(fs.promises, filePath, ...args);
  };

  try {
    const changePromise = emitWatcher('change', sourcePath);
    await statStarted;

    manualDialogFor([sourcePath]);
    const manuallyAddedPromise = callIpcRaw('projects:add-files', project.id);
    releaseStat(staleStats);
    const manuallyAdded = await manuallyAddedPromise;
    assert.equal(manuallyAdded.filter(file => file.path === sourcePath).length, 1);
    await changePromise;
    await waitForCondition(
      () => sourceReadCount > 0,
      'timed out waiting for accepted-source rescan after deferred stat'
    );

    const fresh = await getProject(project.id);
    assert.equal(fresh.files.filter(file => file.path === sourcePath).length, 1);
    assert.equal(fresh.files.find(file => file.path === sourcePath).source, 'manual-browse');
    assert.equal(fresh.pendingFiles.some(file => file.path === sourcePath), false);
  } finally {
    fs.promises.stat = originalStat;
    fs.promises.readFile = originalReadFile;
  }
});

test('generic watcher enforces the exact Watching-session timestamp boundary', async () => {
  setChildProcessHandler(() => ({ stdout: '' }));
  const cases = [
    { label: 'old birth with fresh save', mtimeOffset: 1, birthtimeOffset: -10000, expected: true },
    { label: 'fresh replacement with old mtime', mtimeOffset: -10000, birthtimeOffset: 1, expected: true },
    { label: 'save at the exact boundary', mtimeOffset: 0, birthtimeOffset: -10000, expected: true },
    { label: 'both timestamps predate the boundary', mtimeOffset: -1, birthtimeOffset: -10000, expected: false },
  ];

  for (const scenario of cases) {
    const project = await createProject(`Generic change boundary: ${scenario.label}`);
    const filePath = path.join(TEST_HOME, 'Desktop', `${scenario.label.replaceAll(' ', '-')}.ai`);
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    await emitWatcher('change', filePath, {
      mtimeMs: stored.watchStartedAt + scenario.mtimeOffset,
      birthtimeMs: stored.watchStartedAt + scenario.birthtimeOffset,
    });

    const fresh = await getProject(project.id);
    assert.equal(
      fresh.files.some(file => file.path === filePath),
      scenario.expected,
      scenario.label
    );
  }
});

test('generic watcher stat failure for an unaccepted change leaves no state mutation', async () => {
  setChildProcessHandler(() => ({ stdout: '' }));
  const project = await createProject('Generic change stat failure');
  const missingPath = path.join(TEST_HOME, 'Desktop', 'missing-change.ai');
  const stored = storeInstance.data.projects.find(item => item.id === project.id);
  const stateBefore = structuredClone({
    files: stored.files,
    pendingFiles: stored.pendingFiles,
    liveEvidenceLedger: stored.liveEvidenceLedger,
    provenance: stored.provenance,
  });
  testRendererEvents.length = 0;

  await emitWatcher('change', missingPath);

  assert.deepEqual({
    files: stored.files,
    pendingFiles: stored.pendingFiles,
    liveEvidenceLedger: stored.liveEvidenceLedger,
    provenance: stored.provenance,
  }, stateBefore);
  assert.equal(testRendererEvents.some(event => event.data && event.data.projectId === project.id), false);
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
  assertTextExcludes(JSON.stringify(fresh.liveEvidenceLedger || {}), [
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
  assertTextExcludes(JSON.stringify(fresh.liveEvidenceLedger || {}), [
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

test('lsof excludes a package output selected after the poll starts', async () => {
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'fresh-output-source.fig');
  const outputRoot = path.join(TEST_HOME, 'Desktop', 'fresh-output-during-lsof');
  const outputAsset = path.join(outputRoot, 'candidate.png');
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(sourcePath, 'synthetic fig source');
  fs.writeFileSync(outputAsset, createSyntheticPngBytes());
  let projectId = null;
  let pollEnabled = false;

  try {
    setChildProcessHandler(({ kind, command }) => {
      if (kind === 'exec' && command.startsWith('/bin/ps ax')) {
        return { stdout: pollEnabled ? '222 /Applications/Figma.app/Contents/MacOS/Figma\n' : '' };
      }
      if (kind === 'exec' && command.startsWith('/usr/sbin/lsof')) {
        const storedProject = storeInstance.data.projects.find(project => project.id === projectId);
        assert.ok(storedProject);
        storedProject.outputPath = outputRoot;
        return { stdout: `p222\nf20\ntREG\nn${outputAsset}\n` };
      }
      return { stdout: '' };
    });

    const project = await createProject('Fresh lsof output exclusion');
    projectId = project.id;
    await setProjectFiles(project.id, { files: [{
      path: sourcePath,
      name: path.basename(sourcePath),
      ext: '.fig',
      addedAt: Date.now(),
      source: 'manual-browse',
    }] });
    pollEnabled = true;
    const activationToken = metadataTestHooks.getActiveWatchingActivationToken(project.id);
    await metadataTestHooks.pollLsofForProject(project.id, activationToken);

    const fresh = await getProject(project.id);
    assert.equal(fresh.outputPath, outputRoot);
    assert.equal(fresh.files.some(file => file.path === outputAsset), false);
    assert.equal(fresh.pendingFiles.some(file => file.path === outputAsset), false);
    await callIpcRaw('projects:delete', project.id);
  } finally {
    setChildProcessHandler(null);
    fs.rmSync(sourcePath, { force: true });
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
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

test('new projects default to automatic app detection across mixed supported apps', async () => {
  const lsofRequests = [];
  const supportedProcesses = [
    'Adobe Illustrator',
    'Adobe Photoshop',
    'Adobe InDesign',
    'Adobe XD',
    'Figma',
    'Sketch',
    'Affinity Designer',
    'Affinity Photo',
    'Affinity Publisher',
    'Pixelmator Pro',
    'Acrobat',
    'Keynote',
    'Microsoft PowerPoint',
    'Visual Studio Code',
  ];
  setChildProcessHandler(({ kind, command, args }) => {
    if (kind === 'execFile' && command === '/bin/ps' && args.includes('command=')) {
      return {
        stdout: supportedProcesses
          .map((processName, index) => `${index + 101} /Applications/${processName}.app/Contents/MacOS/${processName}`)
          .join('\n') + '\n',
      };
    }
    if (kind === 'execFile' && command === '/usr/sbin/lsof') {
      lsofRequests.push(args);
      return { stdout: '' };
    }
    return { stdout: '' };
  });

  const project = await callIpc('projects:create', 'Automatic Mixed App');
  const stored = await getProject(project.id);

  assert.equal(stored.type, 'automatic');
  const expectedPidList = supportedProcesses.map((_, index) => index + 101).join(',');
  assert.equal(lsofRequests.some(args => args.includes(expectedPidList)), true);
});

test('projects:create persists one project while a concurrent creation request is rejected', async () => {
  let releaseInitialProcessScan;
  const initialProcessScan = new Promise(resolve => { releaseInitialProcessScan = resolve; });
  let processScanStarted = false;
  setChildProcessHandler(({ kind, command, args }) => {
    if (kind === 'execFile' && command === '/bin/ps' && args.includes('command=')) {
      processScanStarted = true;
      return initialProcessScan;
    }
    return { stdout: '' };
  });

  const firstCreation = callIpcRaw(
    'projects:create',
    'Single Flight Project',
    'automatic',
    'current-page',
    null
  );
  while (!processScanStarted) await new Promise(resolve => setImmediate(resolve));

  const concurrentCreation = await callIpcRaw(
    'projects:create',
    'Single Flight Project',
    'automatic',
    'current-page',
    null
  );
  assert.deepEqual(concurrentCreation, { error: 'project_creation_in_flight' });

  releaseInitialProcessScan({ stdout: '', stderr: '' });
  const createdProject = await firstCreation;
  assert.ok(createdProject?.id);

  const projects = await callIpcRaw('projects:get-all');
  assert.equal(projects.filter(project => project.name === 'Single Flight Project').length, 1);

  const nextProject = await callIpcRaw(
    'projects:create',
    'Single Flight Follow-up',
    'automatic',
    'current-page',
    null
  );
  assert.ok(nextProject?.id);
  assert.notEqual(nextProject.id, createdProject.id);
});

test('initial mixed-app detection preserves presentation workspace restrictions per app', async () => {
  const sketchPath = path.join(TEST_HOME, 'Projects', 'Mixed', 'outside-workspace.sketch');
  const powerpointPath = path.join(TEST_HOME, 'Projects', 'Mixed', 'outside-workspace.pptx');
  fs.mkdirSync(path.dirname(sketchPath), { recursive: true });
  fs.writeFileSync(sketchPath, 'Sketch bytes');
  fs.writeFileSync(powerpointPath, 'PowerPoint bytes');

  setChildProcessHandler(({ kind, command }) => {
    if (kind === 'execFile' && command === '/bin/ps') {
      return {
        stdout:
          '301 /Applications/Sketch.app/Contents/MacOS/Sketch\n' +
          '302 /Applications/Microsoft PowerPoint.app/Contents/MacOS/Microsoft PowerPoint\n',
      };
    }
    if (kind === 'execFile' && command === '/usr/sbin/lsof') {
      return {
        stdout:
          `p301\nf10\ntREG\nn${sketchPath}\n` +
          `p302\nf11\ntREG\nn${powerpointPath}\n`,
      };
    }
    return { stdout: '' };
  });

  const project = await callIpc(
    'projects:create',
    'Initial mixed app path preservation',
    'automatic',
    'current-page',
    null
  );
  const fresh = await getProject(project.id);
  const candidates = Object.values(fresh.liveEvidenceLedger?.candidates || {});

  assert.equal(fresh.type, 'automatic');
  assert.deepEqual(candidates.map(entry => entry.latest?.appFamily).sort(), ['sketch']);
});

test('legacy presentation projects no longer narrow ongoing detection to presentation apps', async () => {
  let ongoingPollReady = false;
  const lsofCommands = [];
  setChildProcessHandler(({ kind, command }) => {
    if (ongoingPollReady && kind === 'exec' && command.startsWith('/bin/ps ax')) {
      return {
        stdout:
          '303 /Applications/Adobe Illustrator.app/Contents/MacOS/Adobe Illustrator\n' +
          '404 /Applications/Microsoft PowerPoint.app/Contents/MacOS/Microsoft PowerPoint\n',
      };
    }
    if (ongoingPollReady && kind === 'exec' && command.startsWith('/usr/sbin/lsof')) {
      lsofCommands.push(command);
      return { stdout: '' };
    }
    return { stdout: '' };
  });

  const project = await callIpc(
    'projects:create',
    'Legacy Presentation Mixed App',
    'presentation',
    'current-page',
    null
  );
  ongoingPollReady = true;
  await runTrackedIntervalCallbacks();
  await new Promise(resolve => originalSetTimeout(resolve, 20));

  const stored = await getProject(project.id);
  assert.equal(stored.type, 'presentation');
  assert.equal(lsofCommands.some(command => command.includes('-p 303,404')), true);
});

test('ongoing mixed-app detection preserves presentation workspace restrictions per app', async () => {
  const sketchPath = path.join(TEST_HOME, 'Projects', 'Mixed', 'ongoing-outside-workspace.sketch');
  const powerpointPath = path.join(TEST_HOME, 'Projects', 'Mixed', 'ongoing-outside-workspace.pptx');
  fs.mkdirSync(path.dirname(sketchPath), { recursive: true });
  fs.writeFileSync(sketchPath, 'Sketch bytes');
  fs.writeFileSync(powerpointPath, 'PowerPoint bytes');
  let pollReady = false;

  setChildProcessHandler(({ kind, command }) => {
    if (!pollReady) return { stdout: '' };
    if (kind === 'exec' && command.startsWith('/bin/ps ax')) {
      return {
        stdout:
          '401 /Applications/Sketch.app/Contents/MacOS/Sketch\n' +
          '402 /Applications/Microsoft PowerPoint.app/Contents/MacOS/Microsoft PowerPoint\n',
      };
    }
    if (kind === 'exec' && command.startsWith('/usr/sbin/lsof')) {
      return {
        stdout:
          `p401\nf10\ntREG\nn${sketchPath}\n` +
          `p402\nf11\ntREG\nn${powerpointPath}\n`,
      };
    }
    return { stdout: '' };
  });

  const project = await callIpc(
    'projects:create',
    'Ongoing mixed app path preservation',
    'automatic',
    'current-page',
    null
  );
  pollReady = true;
  const fresh = await waitForProject(
    project.id,
    item => Object.values(item.liveEvidenceLedger?.candidates || {})
      .some(entry => entry.latest?.appFamily === 'sketch'),
    5000
  );
  const candidates = Object.values(fresh.liveEvidenceLedger?.candidates || {});

  assert.equal(fresh.type, 'automatic');
  assert.deepEqual(candidates.map(entry => entry.latest?.appFamily).sort(), ['sketch']);
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

test('A/B short-lived lsof-only observation remains detectable within the legacy window', async () => {
  resetTestHomeWorkspace();
  const projectDir = path.join(TEST_HOME, 'Desktop', 'ab-short-window-project');
  fs.mkdirSync(projectDir, { recursive: true });
  const sourcePath = path.join(projectDir, 'ab-short-window.fig');
  const assetPath = path.join(projectDir, 'ab-short-window.png');
  fs.writeFileSync(sourcePath, 'synthetic figma source');
  setChildProcessHandler(() => ({ stdout: '' }));

  const project = await createProject('A/B short lsof observation');
  await setProjectFiles(project.id, { files: [{
    path: sourcePath,
    name: path.basename(sourcePath),
    ext: '.fig',
    addedAt: Date.now(),
    source: 'manual-browse',
  }] });
  fs.writeFileSync(assetPath, 'synthetic short-lived asset');
  const observedAfterWatch = new Date(Date.now() + 1000);
  fs.utimesSync(assetPath, observedAfterWatch, observedAfterWatch);

  let assetOpen = true;
  setChildProcessHandler(({ kind, command }) => {
    if (kind === 'exec' && command === '/bin/ps ax -o pid= -o command= 2>/dev/null') {
      return { stdout: '222 /Applications/Figma.app/Contents/MacOS/Figma\n' };
    }
    if (kind === 'exec' && command.startsWith('/usr/sbin/lsof -F ptn -p ')) {
      return {
        stdout: assetOpen
          ? `p222\nf20\ntREG\nn${assetPath}\n`
          : 'p222\n',
      };
    }
    return { stdout: '' };
  });

  // Model a handle that remains open through the legacy t=3s tick but closes
  // before the proposed t=10s tick. No filesystem or metadata fallback is
  // provided, so this isolates the existing lsof acquisition contract.
  await runTrackedIntervalCallbacksForDelay(3000);
  await new Promise(resolve => originalSetTimeout(resolve, 50));
  assetOpen = false;
  await runTrackedIntervalCallbacksForDelay(10000);
  await new Promise(resolve => originalSetTimeout(resolve, 50));

  const fresh = await getProject(project.id);
  const captured = [...fresh.files, ...fresh.pendingFiles]
    .some(file => path.resolve(file.path) === path.resolve(assetPath));
  const expectedCapture = process.env.CRATE_AB_EXPECT_SHORT_LSOF_CAPTURE !== 'false';
  console.log(`# AB_SHORT_LSOF_CAPTURE=${captured ? 'yes' : 'no'}`);
  assert.equal(captured, expectedCapture);
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

test('failed Illustrator activation blocks repeated lsof rows before the ledger', async () => {
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
    .some(entry => entry.latest && entry.latest.reason === 'broad-observer-outside-session'), false);
  assert.equal(getProvenanceObservations(fresh, EDGE_TYPES.SESSION_OBSERVED_FILE).length, 0);
  assert.equal(getProvenanceObservations(fresh, EDGE_TYPES.APP_OPENED_FILE).length, 0);
  assert.equal(getProvenanceNodes(fresh, NODE_TYPES.APP_PROCESS).length, 0);
});

test('failed Illustrator process snapshot does not claim generic chokidar source admission', async () => {
  const filePath = path.join(TEST_HOME, 'Desktop', 'process-query-failed.ai');
  fs.writeFileSync(filePath, 'Illustrator source bytes');
  setChildProcessHandler(request => {
    if (isIllustratorPgrepCheck(request)) return { stdout: '' };
    if (isIllustratorPsCommCheck(request) || isIllustratorPsCommandCheck(request)) {
      return { error: new Error('process query unavailable') };
    }
    return { stdout: '' };
  });

  const project = await createProject('Illustrator process query failure');
  testRendererEvents.length = 0;
  await emitWatcherWithStats('add', filePath, {
    mtimeMs: project.watchStartedAt + 1,
    birthtimeMs: project.watchStartedAt + 1,
  });
  const fresh = await getProject(project.id);

  assert.equal(fresh.files.some(file => file.path === filePath), true);
  assert.deepEqual(fresh.pendingFiles, []);
  assert.equal(JSON.stringify(fresh.liveEvidenceLedger || {}).includes(path.basename(filePath)), true);
  assert.equal(testRendererEvents.some(entry => entry.data && entry.data.projectId === project.id), true);
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
  await runTrackedIntervalCallbacks(1);
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

  await settleAssetBaselineForUnrelatedPackageTest(project.id);
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

test('a superseded filesystem watcher cannot attribute its event to the paused project', async () => {
  const first = await createProject('Single watcher A');
  const firstWatcher = watcherRecords[watcherRecords.length - 1];
  assert.equal(typeof firstWatcher.handlers.add, 'function');

  const second = await createProject('Single watcher B');
  const secondWatcher = watcherRecords[watcherRecords.length - 1];
  const observedPath = path.join(TEST_HOME, 'Desktop', 'single-watch-event.ai');
  fs.writeFileSync(observedPath, 'synthetic illustrator source');

  await firstWatcher.handlers.add(observedPath);
  let firstFresh = await getProject(first.id);
  let secondFresh = await getProject(second.id);
  assert.equal(firstFresh.status, 'paused');
  assert.equal(secondFresh.status, 'watching');
  assert.equal(firstFresh.files.some(file => file.path === observedPath), false);
  assert.equal(firstFresh.pendingFiles.some(file => file.path === observedPath), false);

  await secondWatcher.handlers.add(observedPath);
  secondFresh = await getProject(second.id);
  firstFresh = await getProject(first.id);
  assert.equal(secondFresh.files.some(file => file.path === observedPath), true);

  const secondObservation = secondFresh.provenance.observations.find(observation => (
    observation.observer &&
    observation.observer.kind === OBSERVER_KINDS.CHOKIDAR &&
    observation.observer.method === 'add'
  ));
  assert.ok(secondObservation);
  assert.equal(Object.prototype.hasOwnProperty.call(firstFresh.provenance.nodes, secondObservation.objectNodeId), false);
});

test('one Illustrator observation stream is staged only for the active Watching project', async () => {
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'B_Project.ai');
  const linkedPath = path.join(TEST_HOME, 'Desktop', 'B_Asset.png');
  fs.writeFileSync(sourcePath, 'synthetic illustrator source');
  fs.writeFileSync(linkedPath, 'synthetic linked asset');

  setIllustratorOpenedAfterActivationHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) {
      return { stdout: '123\n' };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      return {
        stdout: [
          `DOC\t${sourcePath}\tB_Project.ai\ttrue\ttrue`,
          `LINK\t${sourcePath}\tB_Project.ai\t${linkedPath}\ttrue\ttrue`,
          'COMPLETE\t1\t1',
        ].join('\n') + '\n',
      };
    }
    return { stdout: '' };
  }, 2);

  const first = await createProject('Illustrator attribution A');
  const second = await createProject('Illustrator attribution B');
  const secondFresh = await waitForProject(
    second.id,
    project => [sourcePath, linkedPath].every(filePath => (
      project.pendingFiles.some(file => file.path === filePath)
    )),
    5000
  );
  const firstFresh = await getProject(first.id);

  assert.equal(firstFresh.status, 'paused');
  assert.equal(secondFresh.status, 'watching');
  assert.equal(firstFresh.files.some(file => [sourcePath, linkedPath].includes(file.path)), false);
  assert.equal(firstFresh.pendingFiles.some(file => [sourcePath, linkedPath].includes(file.path)), false);

  const secondEvidenceKeys = Object.keys(secondFresh.liveEvidenceLedger.candidates || {});
  const firstEvidenceKeys = new Set(Object.keys((firstFresh.liveEvidenceLedger && firstFresh.liveEvidenceLedger.candidates) || {}));
  assert.equal(secondEvidenceKeys.length, 2);
  assert.equal(secondEvidenceKeys.some(key => firstEvidenceKeys.has(key)), false);
});

test('Illustrator live app evidence stages open source and linked asset as needs-save candidates', async () => {
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'live-illustrator.ai');
  const linkedPath = path.join(TEST_HOME, 'Desktop', 'IMG_5331.JPG');
  fs.writeFileSync(sourcePath, 'ai bytes');
  fs.writeFileSync(linkedPath, 'jpg bytes');
  setIllustratorOpenedAfterActivationHandler(({ kind, command, args, commandText }) => {
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
          `LINK\t${sourcePath}\tlive-illustrator.ai\t${linkedPath}\ttrue\ttrue`,
          'COMPLETE\t1\t1',
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
          `LINK\t${staleIllustratorPath}\tBris Invitation-03 copy.ai\t${staleIllustratorLinkedPath}\ttrue\ttrue`,
          'COMPLETE\t1\t1',
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

test('generic pre-package broad scan quarantines stale Illustrator-extension source in an InDesign project', async () => {
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

  setChildProcessHandler(({ kind, command, args, options }) => {
    const request = { kind, command, args, options };
    if (isBulkSpotlightRequest(request)) {
      return { stdout: formatBulkSpotlightOutputForRoot(request, [staleIllustratorPath]) };
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

test('Illustrator live app evidence rejects query-failed partial placed item output', async () => {
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'live-illustrator-partial.ai');
  const linkedPath = path.join(TEST_HOME, 'Desktop', 'IMG_5331.JPG');
  fs.writeFileSync(sourcePath, 'ai bytes');
  fs.writeFileSync(linkedPath, 'jpg bytes');
  setIllustratorOpenedAfterActivationHandler(({ kind, command, args }) => {
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
          'STATUS\tillustrator-placed-item-file-query-failed',
          `LINK\t${sourcePath}\tlive-illustrator-partial.ai\t${linkedPath}\ttrue\ttrue`,
          'COMPLETE\t1\t2',
        ].join('\n') + '\n',
      };
    }
    return { stdout: '' };
  });

  const project = await createProject('Illustrator partial placed item status');
  const fresh = await waitForProject(
    project.id,
    item => getLiveAppStatusEntries(item).some(entry => entry.scriptAttempted === true),
    5000
  );

  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.pendingFiles, []);
  assert.equal(getSessionObservedByMethod(fresh, 'ai-linked').length, 0);
  const statusEntries = getLiveAppStatusEntries(fresh, 'illustrator');
  assert.ok(statusEntries.some(entry => (
    entry.scriptAttempted === true &&
    entry.scriptSuccess === false &&
    entry.docsCount === 1 &&
    entry.linksCount === 1 &&
    entry.placedItemsCount === 2 &&
    entry.errorCategory === 'illustrator-placed-item-file-query-failed'
  )));
  assert.equal(statusEntries.some(entry => entry.stagedCount > 0), false);
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

async function assertIllustratorSnapshotOutputFailsClosed(label, buildOutput) {
  resetTestHomeWorkspace();
  const sourcePath = path.join(TEST_HOME, 'Desktop', `${label}.ai`);
  const linkedPath = path.join(TEST_HOME, 'Desktop', `${label}.png`);
  fs.writeFileSync(sourcePath, 'source bytes');
  fs.writeFileSync(linkedPath, 'linked bytes');
  let osascriptInvocations = 0;
  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) return { stdout: '123\n' };
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      osascriptInvocations++;
      return {
        stdout: buildOutput(sourcePath, linkedPath),
        rawIllustratorOutput: true,
      };
    }
    return { stdout: '' };
  });

  const project = await createProject(`Illustrator ${label}`);
  await waitForProject(project.id, () => osascriptInvocations >= 1, 5000);
  await runTrackedIntervalCallbacks();
  const fresh = await waitForProject(
    project.id,
    item => getLiveAppStatusEntries(item).some(entry => entry.scriptAttempted === true),
    5000
  );
  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.pendingFiles, []);
  assert.equal(getSessionObservedByMethod(fresh, 'ai-linked').length, 0);
  const statusEntries = getLiveAppStatusEntries(fresh);
  assert.equal(statusEntries.some(entry => entry.stagedCount > 0), false);
  assert.ok(statusEntries.some(entry => (
    entry.scriptAttempted === true && entry.scriptSuccess === false
  )));
  assert.equal(statusEntries.some(entry => (
    entry.scriptAttempted === true && entry.scriptSuccess === true
  )), false);
}

test('Illustrator activation rejects truncated structured output with zero foreign staging', async () => {
  await assertIllustratorSnapshotOutputFailsClosed('truncated-output', (sourcePath, linkedPath) => [
    `DOC\t${sourcePath}\ttruncated-output.ai\tfalse\ttrue`,
    `LINK\t${sourcePath}\ttruncated-output.ai\t${linkedPath}\tfalse\ttrue`,
    'COMPLETE\t1',
  ].join('\n') + '\n');
});

test('Illustrator activation rejects output without a terminal marker', async () => {
  await assertIllustratorSnapshotOutputFailsClosed('missing-terminal', (sourcePath, linkedPath) => [
    `DOC\t${sourcePath}\tmissing-terminal.ai\tfalse\ttrue`,
    `LINK\t${sourcePath}\tmissing-terminal.ai\t${linkedPath}\tfalse\ttrue`,
  ].join('\n') + '\n');
});

test('Illustrator activation rejects placed item count mismatch with zero foreign staging', async () => {
  await assertIllustratorSnapshotOutputFailsClosed('count-mismatch', (sourcePath, linkedPath) => [
    `DOC\t${sourcePath}\tcount-mismatch.ai\tfalse\ttrue`,
    `LINK\t${sourcePath}\tcount-mismatch.ai\t${linkedPath}\tfalse\ttrue`,
    'COMPLETE\t1\t2',
  ].join('\n') + '\n');
});

for (const [label, terminalRows] of [
  ['empty-count', ['STATUS\tno-documents', 'COMPLETE\t\t0']],
  ['whitespace-count', ['STATUS\tno-documents', 'COMPLETE\t \t0']],
  ['negative-count', ['STATUS\tno-documents', 'COMPLETE\t-1\t0']],
  ['signed-count', ['STATUS\tno-documents', 'COMPLETE\t+0\t0']],
  ['leading-zero-count', ['STATUS\tno-documents', 'COMPLETE\t00\t0']],
  ['decimal-count', ['STATUS\tno-documents', 'COMPLETE\t0.0\t0']],
  ['exponent-count', ['STATUS\tno-documents', 'COMPLETE\t0e0\t0']],
  ['hexadecimal-count', ['STATUS\tno-documents', 'COMPLETE\t0x0\t0']],
  ['overflow-count', ['STATUS\tno-documents', `COMPLETE\t${Number.MAX_SAFE_INTEGER + 1}\t0`]],
  ['trailing-whitespace', ['STATUS\tno-documents', 'COMPLETE\t0\t0 ']],
  ['legacy-placed-count', ['STATUS\tno-documents', 'PLACED\t0', 'COMPLETE\t0\t0']],
  ['duplicate-terminal', ['STATUS\tno-documents', 'COMPLETE\t0\t0', 'COMPLETE\t0\t0']],
  ['trailing-record', ['STATUS\tno-documents', 'COMPLETE\t0\t0', 'STATUS\tno-documents']],
]) {
  test(`Illustrator activation rejects ${label} terminal records with zero staging`, async () => {
    await assertIllustratorSnapshotOutputFailsClosed(
      `canonical-${label}`,
      () => `${terminalRows.join('\n')}\n`
    );
  });
}

for (const rowKind of ['DOC', 'LINK']) {
  for (const [label, booleanFields] of [
    ['banana', ['banana', 'true']],
    ['TRUE/FALSE', ['TRUE', 'FALSE']],
    ['0/1', ['0', '1']],
    ['empty', ['', 'true']],
    ['surrounding whitespace', [' true', 'false ']],
    ['missing fields', ['true']],
    ['extra fields', ['true', 'false', 'extra']],
  ]) {
    test(`Illustrator activation rejects ${label} ${rowKind} boolean fields with zero staging`, async () => {
      await assertIllustratorSnapshotOutputFailsClosed(
        `canonical-${rowKind.toLowerCase()}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
        (sourcePath, linkedPath) => {
          const validDoc = ['DOC', sourcePath, path.basename(sourcePath), 'false', 'true'];
          const validLink = ['LINK', sourcePath, path.basename(sourcePath), linkedPath, 'false', 'true'];
          const malformedPrefix = rowKind === 'DOC'
            ? ['DOC', sourcePath, path.basename(sourcePath)]
            : ['LINK', sourcePath, path.basename(sourcePath), linkedPath];
          return [
            (rowKind === 'DOC' ? [...malformedPrefix, ...booleanFields] : validDoc).join('\t'),
            (rowKind === 'LINK' ? [...malformedPrefix, ...booleanFields] : validLink).join('\t'),
            'COMPLETE\t1\t1',
          ].join('\n') + '\n';
        }
      );
    });
  }
}

test('Illustrator guarded path fallback stages complete linked evidence when file object query fails', async () => {
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'path-fallback-illustrator.ai');
  const linkedPath = path.join(TEST_HOME, 'Desktop', 'qa21-live-only-IMG_5331.JPG');
  fs.writeFileSync(sourcePath, 'ai bytes');
  fs.writeFileSync(linkedPath, 'jpg bytes');
  setIllustratorOpenedAfterActivationHandler(({ kind, command, args }) => {
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
          'STATUS\tillustrator-placed-item-file-query-failed',
          'STATUS\tillustrator-placed-item-file-of-query-failed',
          'STATUS\tillustrator-placed-item-path-fallback-used',
          `LINK\t${sourcePath}\tpath-fallback-illustrator.ai\t${linkedPath}\ttrue\ttrue`,
          'COMPLETE\t1\t1',
        ].join('\n') + '\n',
      };
    }
    return { stdout: '' };
  });

  const project = await createProject('Illustrator placed path fallback');
  const fresh = await waitForProject(project.id, item => item.pendingFiles.length === 2, 5000);
  assert.deepEqual(fresh.files, []);
  assert.equal(fresh.pendingFiles.some(file => file.path === sourcePath && file.source === 'app-opened'), true);
  assert.equal(fresh.pendingFiles.some(file => file.path === linkedPath && file.source === 'ai-linked'), true);
  assert.equal(getSessionObservedByMethod(fresh, 'ai-linked').length, 0);
  assert.equal(Object.values((fresh.liveEvidenceLedger && fresh.liveEvidenceLedger.candidates) || {})
    .filter(entry => entry.strongestState === 'needs-save').length, 2);

  const statusEntries = getLiveAppStatusEntries(fresh, 'illustrator');
  assert.ok(statusEntries.some(entry => (
    entry.scriptAttempted === true &&
    entry.scriptSuccess === true &&
    entry.docsCount === 1 &&
    entry.linksCount === 1 &&
    entry.placedItemsCount === 1 &&
    entry.errorCategory === 'script-success' &&
    entry.statusReasonCounts &&
    entry.statusReasonCounts['illustrator-placed-item-file-query-failed'] === 1 &&
    entry.statusReasonCounts['illustrator-placed-item-file-of-query-failed'] === 1 &&
    entry.statusReasonCounts['illustrator-placed-item-path-fallback-used'] === 1
  )));
  assert.equal(statusEntries.some(entry => entry.stagedCount === 2), true);

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
  assertTextExcludes(JSON.stringify(fresh.liveEvidenceLedger || {}), [
    'DOC\t',
    'LINK\t',
    'file path of pItem',
    'SHOULD_NOT_APPEAR',
    'stdout',
    'stderr',
    'raw',
  ], 'Illustrator path fallback live evidence ledger');
});

test('Illustrator mixed direct and JavaScript fallback statuses remain fail closed', async () => {
  await assertIllustratorSnapshotOutputFailsClosed('mixed-path-and-javascript-fallback', (sourcePath, linkedPath) => [
    `DOC\t${sourcePath}\tmixed-path-and-javascript-fallback.ai\ttrue\ttrue`,
    'STATUS\tillustrator-placed-item-file-query-failed',
    'STATUS\tillustrator-placed-item-file-of-query-failed',
    'STATUS\tillustrator-placed-item-path-fallback-used',
    'STATUS\tillustrator-placed-item-file-fallback-used',
    `LINK\t${sourcePath}\tmixed-path-and-javascript-fallback.ai\t${linkedPath}\ttrue\ttrue`,
    'COMPLETE\t1\t1',
  ].join('\n') + '\n');
});

test('Illustrator path text coercion fallback fails closed when object reads fail', async () => {
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'path-text-fallback-illustrator.ai');
  const linkedPath = path.join(TEST_HOME, 'Desktop', 'qa22-live-only-IMG_5331.JPG');
  fs.writeFileSync(sourcePath, 'ai bytes');
  fs.writeFileSync(linkedPath, 'jpg bytes');
  setIllustratorOpenedAfterActivationHandler(({ kind, command, args }) => {
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
          'STATUS\tillustrator-placed-item-file-query-failed',
          'STATUS\tillustrator-placed-item-file-of-query-failed',
          'STATUS\tillustrator-placed-item-path-query-failed',
          'STATUS\tillustrator-placed-item-file-path-object-query-failed',
          'STATUS\tillustrator-placed-item-file-path-text-fallback-used',
          `LINK\t${sourcePath}\tpath-text-fallback-illustrator.ai\t${linkedPath}\ttrue\ttrue`,
          'COMPLETE\t1\t3',
        ].join('\n') + '\n',
      };
    }
    return { stdout: '' };
  });

  const project = await createProject('Illustrator placed path text fallback');
  const fresh = await waitForProject(project.id, item => getLiveAppStatusEntries(item, 'illustrator')
    .some(entry => entry.scriptAttempted === true && entry.scriptSuccess === false), 5000);
  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.pendingFiles, []);
  assert.equal(getSessionObservedByMethod(fresh, 'ai-linked').length, 0);

  const statusEntries = getLiveAppStatusEntries(fresh, 'illustrator');
  assert.ok(statusEntries.some(entry => (
    entry.scriptAttempted === true &&
    entry.scriptSuccess === false &&
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
  assert.equal(statusEntries.some(entry => entry.stagedCount > 0), false);

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
  assertTextExcludes(JSON.stringify(fresh.liveEvidenceLedger || {}), [
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

test('Illustrator placed item fallback without a source path fails closed', async () => {
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'fallback-illustrator.ai');
  const linkedPath = path.join(TEST_HOME, 'Desktop', 'qa20-live-only-IMG_5331.JPG');
  fs.writeFileSync(sourcePath, 'ai bytes');
  fs.writeFileSync(linkedPath, 'jpg bytes');
  let osascriptInvocations = 0;
  setIllustratorOpenedAfterActivationHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) {
      return { stdout: '123\n' };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      osascriptInvocations++;
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
          'STATUS\tillustrator-placed-item-file-query-failed',
          'STATUS\tillustrator-placed-item-file-fallback-used',
          `LINK\t\tfallback-illustrator.ai\t${linkedPath}\ttrue\ttrue`,
          'COMPLETE\t1\t1',
        ].join('\n') + '\n',
      };
    }
    return { stdout: '' };
  });

  const project = await createProject('Illustrator placed file fallback');
  const fresh = await waitForProject(
    project.id,
    item => (
      osascriptInvocations >= 1 &&
      getLiveAppStatusEntries(item, 'illustrator').some(entry => (
        entry.scriptAttempted === true &&
        entry.scriptSuccess === false &&
        entry.errorCategory === 'illustrator-placed-item-file-query-failed'
      ))
    ),
    5000
  );
  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.pendingFiles, []);
  assert.equal(getSessionObservedByMethod(fresh, 'ai-linked').length, 0);

  const statusEntries = getLiveAppStatusEntries(fresh, 'illustrator');
  assert.ok(statusEntries.some(entry => (
    entry.scriptAttempted === true &&
    entry.scriptSuccess === false &&
    entry.docsCount === 1 &&
    entry.linksCount === 1 &&
    entry.placedItemsCount === 1 &&
    entry.errorCategory === 'illustrator-placed-item-file-query-failed'
  )));

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
  assertTextExcludes(JSON.stringify(fresh.liveEvidenceLedger || {}), [
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

test('unchanged large-project live app cycles do not rewrite the project store', async () => {
  resetTestHomeWorkspace();
  setChildProcessHandler(() => ({ stdout: '' }));

  const project = await createProject('Large no-op live app cycle');
  await setProjectFiles(project.id, {
    files: Array.from({ length: 267 }, (_, index) => ({
      path: path.join(TEST_HOME, 'Desktop', `large-no-op-${String(index).padStart(3, '0')}.png`),
      name: `large-no-op-${String(index).padStart(3, '0')}.png`,
      ext: '.png',
      addedAt: Date.now(),
      source: 'manual-browse',
    })),
  });
  const activationToken = metadataTestHooks.getActiveWatchingActivationToken(project.id);
  await metadataTestHooks.pollPsForProject(project.id, activationToken);

  storeInstance.measureProjectSerialization = true;
  storeInstance.projectSerializedBytes = 0;
  const beforeWrites = storeInstance.projectSetCount;
  const beforeProject = structuredClone(await getProject(project.id));
  const cycleCount = 25;
  const startedAt = performance.now();
  for (let index = 0; index < cycleCount; index++) {
    await metadataTestHooks.pollPsForProject(project.id, activationToken);
  }
  const elapsedMs = performance.now() - startedAt;
  const afterProject = await getProject(project.id);

  const projectWriteDelta = storeInstance.projectSetCount - beforeWrites;
  const expectedWriteDelta = Number(process.env.CRATE_AB_EXPECT_LIVE_APP_NOOP_WRITES || 0);
  console.log(`# AB_LIVE_APP_NOOP_PROJECT_WRITES=${projectWriteDelta}`);
  console.log(`# AB_LIVE_APP_NOOP_SERIALIZED_BYTES=${storeInstance.projectSerializedBytes}`);
  console.log(`# AB_LIVE_APP_NOOP_ELAPSED_MS=${elapsedMs.toFixed(3)}`);
  assert.equal(projectWriteDelta, expectedWriteDelta);
  if (expectedWriteDelta === 0) assert.deepEqual(afterProject, beforeProject);
  assert.equal(afterProject.files.length, 267);
});

test('unchanged recurring Figma scope reconciliation does not rewrite the project store', async () => {
  resetTestHomeWorkspace();
  setChildProcessHandler(() => ({ stdout: '' }));

  const project = await createVerifiedFigmaProject(
    'No-op Figma scope reconciliation',
    'current-page',
    'https://www.figma.com/file/no-op-scope-key/No-Op?page-id=1%3A1'
  );
  await callIpcRaw('projects:pause', project.id);
  const storedProject = storeInstance.data.projects.find(item => item.id === project.id);
  const trackedFile = storedProject.figmaSession.trackedFiles[0];
  const scopeEntries = [{
    fileKey: trackedFile.key,
    lockStatus: trackedFile.lockStatus,
    lockedPageId: trackedFile.lockedPageId,
    lockedPageName: trackedFile.lockedPageName,
    statusReason: trackedFile.statusReason,
    warning: trackedFile.warning,
  }];
  assert.ok(metadataTestHooks.mergeFigmaScopeEntriesIntoSession(project.id, scopeEntries));
  storeInstance.measureProjectSerialization = true;
  storeInstance.projectSerializedBytes = 0;
  const beforeWrites = storeInstance.projectSetCount;
  const cycleCount = 25;
  let result = null;
  const startedAt = performance.now();
  for (let index = 0; index < cycleCount; index++) {
    result = metadataTestHooks.mergeFigmaScopeEntriesIntoSession(project.id, scopeEntries);
  }
  const elapsedMs = performance.now() - startedAt;

  const projectWriteDelta = storeInstance.projectSetCount - beforeWrites;
  const expectedWriteDelta = Number(process.env.CRATE_AB_EXPECT_FIGMA_NOOP_WRITES || 0);
  console.log(`# AB_FIGMA_SCOPE_NOOP_PROJECT_WRITES=${projectWriteDelta}`);
  console.log(`# AB_FIGMA_SCOPE_NOOP_SERIALIZED_BYTES=${storeInstance.projectSerializedBytes}`);
  console.log(`# AB_FIGMA_SCOPE_NOOP_ELAPSED_MS=${elapsedMs.toFixed(3)}`);
  if (expectedWriteDelta === 0) assert.equal(result, null);
  assert.equal(projectWriteDelta, expectedWriteDelta);
});

test('repeated watcher intervals dedupe unchanged live app breadcrumbs without project writes', async () => {
  resetTestHomeWorkspace();
  setChildProcessHandler(() => ({ stdout: '' }));

  const project = await createProject('Deduped watcher lifecycle diagnostics');
  await waitForProject(
    project.id,
    item => getLiveAppStatusEntries(item).some(entry => entry.pollInstalled === true),
    5000
  );
  await runTrackedIntervalCallbacks(1);
  const afterFirstPoll = await getProject(project.id);
  const firstEntries = structuredClone(getLiveAppStatusEntries(afterFirstPoll));
  assert.ok(firstEntries.some(entry => entry.pollFired === true));
  assert.ok(firstEntries.some(entry => entry.errorCategory === 'app-not-running'));

  const beforeWrites = storeInstance.projectSetCount;
  await runTrackedIntervalCallbacks(25);
  const fresh = await getProject(project.id);
  assert.equal(storeInstance.projectSetCount - beforeWrites, 0);
  assert.deepEqual(getLiveAppStatusEntries(fresh), firstEntries);
  assert.equal(fresh.liveAppEvidenceStatus.entryLimit, 20);
});

test('live app breadcrumbs retain only the latest bounded status transitions per app family', async () => {
  resetTestHomeWorkspace();
  setChildProcessHandler(() => ({ stdout: '' }));

  const project = await createProject('Capped live app diagnostics');
  await waitForProject(
    project.id,
    item => getLiveAppStatusEntries(item).some(entry => entry.pollInstalled === true),
    5000
  );

  for (let index = 0; index < 25; index++) {
    metadataTestHooks.recordLiveAppStatusBreadcrumb(project.id, 'illustrator', {
      pollFired: true,
      projectWatching: true,
      appRunning: index % 2 === 0,
      scriptAttempted: false,
      scriptSuccess: false,
      stagedCount: 0,
      errorCategory: index % 2 === 0 ? 'script-not-attempted' : 'app-not-running',
    });
  }

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
  setIllustratorOpenedAfterActivationHandler(({ kind, command, args }) => {
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
      return { stdout: 'STATUS\tno-documents\nCOMPLETE\t0\t0\n' };
    }
    return { stdout: '' };
  });

  const project = await createProject('Illustrator process command detection');
  const fresh = await waitForProject(
    project.id,
    item => getLiveAppStatusEntries(item).some(entry => (
      entry.scriptAttempted === true &&
      entry.scriptSuccess === true &&
      entry.errorCategory === 'no-documents'
    )),
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

  setIllustratorOpenedAfterActivationHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) {
      return { stdout: '123\n' };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      return {
        stdout: [
          `DOC\t${hfsSourcePath}\tBris Invitation-03 CLEAN QA14.ai\ttrue\ttrue`,
          `LINK\t${hfsSourcePath}\tBris Invitation-03 CLEAN QA14.ai\t${hfsLinkedPath}\ttrue\ttrue`,
          'COMPLETE\t1\t1',
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

  setIllustratorOpenedAfterActivationHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) {
      return { stdout: '123\n' };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      return {
        stdout: [
          `DOC\t${sourcePath}\tfile-url-illustrator.ai\ttrue\ttrue`,
          `LINK\t${sourcePath}\tfile-url-illustrator.ai\t${linkedFileUrl}\ttrue\ttrue`,
          'COMPLETE\t1\t1',
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
          'COMPLETE\t1\t2',
        ].join('\n') + '\n',
      };
    }
    return { stdout: '' };
  });

  const { result: fresh, output } = await captureConsoleDuring(async () => {
    const project = await createProject('Illustrator invalid path normalization');
    await waitForProject(project.id, () => osascriptInvocations >= 1, 5000);
    await runTrackedIntervalCallbacks();
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
      lines.push(`COMPLETE\t2\t${includeNewLink ? 3 : 2}`);
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
  await runTrackedIntervalCallbacks(1);
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

test('Illustrator activation fails closed when the structured snapshot contains a pathless document', async () => {
  resetTestHomeWorkspace();
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'Bris Invitation-03 copy.ai');
  const linkedPath = path.join(TEST_HOME, 'Desktop', 'IMG_5331.JPG');
  const foreignSourcePath = path.join(TEST_HOME, 'Desktop', 'Foreign recovery.ai');
  const foreignLinkedPath = path.join(TEST_HOME, 'Desktop', 'Foreign recovery.png');
  fs.writeFileSync(sourcePath, 'source bytes');
  fs.writeFileSync(linkedPath, 'new linked bytes');
  fs.writeFileSync(foreignSourcePath, 'foreign source bytes');
  fs.writeFileSync(foreignLinkedPath, 'foreign linked bytes');
  let pgrepProcessChecks = 0;
  let psCommProcessChecks = 0;
  let osascriptInvocations = 0;
  let snapshotResolved = false;

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
        stdout: snapshotResolved
          ? `DOC\t${sourcePath}\tBris Invitation-03 copy.ai\ttrue\ttrue\n` +
            `LINK\t${sourcePath}\tBris Invitation-03 copy.ai\t${linkedPath}\ttrue\ttrue\n` +
            `DOC\t${foreignSourcePath}\tForeign recovery.ai\ttrue\ttrue\n` +
            `LINK\t${foreignSourcePath}\tForeign recovery.ai\t${foreignLinkedPath}\ttrue\ttrue\nCOMPLETE\t2\t2\n`
          : `DOC\t\tBris Invitation-03 copy.ai\ttrue\ttrue\nLINK\t\tBris Invitation-03 copy.ai\t${linkedPath}\ttrue\ttrue\nCOMPLETE\t1\t1\n`,
      };
    }
    return { stdout: '' };
  });

  const project = await createProject('Illustrator pathless refresh');
  await waitForProject(project.id, () => osascriptInvocations >= 1, 5000);
  await new Promise(resolve => originalSetTimeout(resolve, 50));
  let fresh = await getProject(project.id);

  assert.ok(pgrepProcessChecks >= 1);
  assert.ok(psCommProcessChecks >= 1);
  assert.ok(osascriptInvocations >= 1);
  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.pendingFiles, []);
  assert.equal(JSON.stringify(fresh.liveEvidenceLedger || {}).includes(path.basename(linkedPath)), false);
  assertTextExcludes(JSON.stringify(fresh), [
    '/Applications/Adobe Illustrator 2026',
    'Contents/MacOS',
    'stdout',
    'raw',
  ], 'Illustrator process detection state');

  snapshotResolved = true;
  manualDialogFor([sourcePath]);
  await callIpc('projects:add-files', project.id);
  fresh = await waitForProject(
    project.id,
    item => item.pendingFiles.some(file => file.path === linkedPath),
    5000
  );
  assert.equal(fresh.files.some(file => file.path === sourcePath && file.source === 'manual-browse'), true);
  assert.equal([...fresh.files, ...fresh.pendingFiles].some(file => (
    file.path === foreignSourcePath || file.path === foreignLinkedPath
  )), false);
});

test('Illustrator activation scope excludes baseline A and admits B1/B2 with shared-link inclusion', async () => {
  resetTestHomeWorkspace();
  const aSource = path.join(TEST_HOME, 'Desktop', 'A_Project.ai');
  const aLink = path.join(TEST_HOME, 'Desktop', 'A_Asset.png');
  const sharedLink = path.join(TEST_HOME, 'Desktop', 'Shared_Asset.png');
  const b1Source = path.join(TEST_HOME, 'Desktop', 'B1_Project.ai');
  const b1Link = path.join(TEST_HOME, 'Desktop', 'B1_Asset.png');
  const b2Source = path.join(TEST_HOME, 'Desktop', 'B2_Project.ai');
  const b2Link = path.join(TEST_HOME, 'Desktop', 'B2_Asset.png');
  const outputDir = path.join(TEST_HOME, 'Desktop', 'activation-scope-package');
  for (const filePath of [aSource, aLink, sharedLink, b1Source, b1Link, b2Source, b2Link]) {
    fs.writeFileSync(filePath, path.basename(filePath));
  }
  fs.mkdirSync(outputDir, { recursive: true });

  let rows = [
    `DOC\t${aSource}\tA_Project.ai\tfalse\ttrue`,
    `LINK\t${aSource}\tA_Project.ai\t${aLink}\tfalse\ttrue`,
    `LINK\t${aSource}\tA_Project.ai\t${sharedLink}\tfalse\ttrue`,
  ];
  let queryCount = 0;
  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) return { stdout: '321\n' };
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      queryCount++;
      return { stdout: `${rows.join('\n')}\n${rows.length === 3 ? 'COMPLETE\t1\t2' : 'COMPLETE\t3\t5'}\n` };
    }
    return { stdout: '' };
  });

  const project = await createProject('Illustrator activation scope B');
  await waitForProject(project.id, () => queryCount >= 1, 5000);
  await new Promise(resolve => originalSetTimeout(resolve, 50));
  let fresh = await getProject(project.id);
  assert.equal(fresh.files.some(file => file.path === aSource || file.path === aLink), false);
  assert.equal(fresh.pendingFiles.some(file => [aSource, aLink, sharedLink].includes(file.path)), false);
  assertProvenanceTextExcludes(fresh, [aSource, aLink, sharedLink]);
  assert.equal(JSON.stringify(fresh.liveEvidenceLedger || {}).includes('A_Project.ai'), false);

  rows = [
    ...rows,
    `DOC\t${b1Source}\tB1_Project.ai\tfalse\ttrue`,
    `LINK\t${b1Source}\tB1_Project.ai\t${b1Link}\tfalse\ttrue`,
    `LINK\t${b1Source}\tB1_Project.ai\t${sharedLink}\tfalse\ttrue`,
    `DOC\t${b2Source}\tB2_Project.ai\tfalse\tfalse`,
    `LINK\t${b2Source}\tB2_Project.ai\t${b2Link}\tfalse\tfalse`,
  ];
  await runTrackedIntervalCallbacks();
  fresh = await waitForProject(
    project.id,
    item => [b1Source, b1Link, sharedLink, b2Source, b2Link]
      .every(filePath => [...item.files, ...item.pendingFiles].some(file => file.path === filePath)),
    5000
  );
  assert.equal(fresh.pendingFiles.some(file => file.path === aSource || file.path === aLink), false);
  assert.equal(fresh.pendingFiles.some(file => file.path === sharedLink), true);

  manualDialogFor([b1Source, b2Source]);
  await callIpc('projects:add-files', project.id);
  fresh = await getProject(project.id);
  for (const linkedPath of [b1Link, sharedLink]) {
    if (fresh.pendingFiles.some(file => file.path === linkedPath)) {
      await callIpc('projects:accept-pending', project.id, linkedPath);
      fresh = await getProject(project.id);
    }
  }

  await callIpc('projects:pre-package-scan', project.id);
  await settleAssetBaselineForUnrelatedPackageTest(project.id);
  const packageResult = await callIpc('projects:package', project.id, outputDir);
  assertPackageResultShape(packageResult);
  assert.equal(packageResult.success, true);
  assert.equal(fs.existsSync(path.join(packageResult.folderPath, path.basename(aSource))), false);
  assert.equal(fs.existsSync(path.join(packageResult.folderPath, path.basename(aLink))), false);
  assert.equal(fs.existsSync(path.join(packageResult.folderPath, path.basename(b1Source))), true);
  assert.equal(fs.existsSync(path.join(packageResult.folderPath, path.basename(b2Source))), true);
});

test('unrelated app and generic assets survive ready and failed Illustrator scopes', async () => {
  for (const scopeState of ['ready', 'failed']) {
    resetTestHomeWorkspace();
    const prefix = `unrelated-${scopeState}`;
    const assetDir = path.join(TEST_HOME, 'Desktop', `${prefix}-assets`);
    fs.mkdirSync(assetDir, { recursive: true });
    const baselineSource = path.join(assetDir, `${prefix}-baseline.ai`);
    const baselineLink = path.join(assetDir, `${prefix}-baseline.png`);
    const trustedAiAnchor = path.join(assetDir, `${prefix}-trusted.ai`);
    const appPaths = [
      path.join(assetDir, `${prefix}.psd`),
      path.join(assetDir, `${prefix}.indd`),
      path.join(assetDir, `${prefix}.pptx`),
    ];
    const genericPaths = ['pdf', 'svg', 'eps', 'ai']
      .map(ext => path.join(assetDir, `${prefix}-generic.${ext}`));
    const outputDir = path.join(TEST_HOME, 'Desktop', `${prefix}-package`);
    for (const filePath of [baselineSource, baselineLink, trustedAiAnchor, ...appPaths, ...genericPaths]) {
      fs.writeFileSync(filePath, `${path.basename(filePath)} bytes`);
    }
    fs.mkdirSync(outputDir, { recursive: true });

    setChildProcessHandler(({ kind, command, args }) => {
      if (isIllustratorPgrepCheck({ kind, command, args })) return { stdout: '321\n' };
      if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
        if (scopeState === 'failed') return { stdout: 'ERROR\tillustrator-query-failed\nCOMPLETE\t0\t0\n' };
        return {
          stdout: [
            `DOC\t${baselineSource}\t${path.basename(baselineSource)}\tfalse\ttrue`,
            `LINK\t${baselineSource}\t${path.basename(baselineSource)}\t${baselineLink}\tfalse\ttrue`,
            'COMPLETE\t1\t1',
          ].join('\n') + '\n',
        };
      }
      if (kind === 'execFile' && command === '/bin/ps') return { stdout: '' };
      if (kind === 'exec' && command === '/bin/ps ax -o pid= -o command= 2>/dev/null') {
        return { stdout: '777 Figma\n' };
      }
      if (kind === 'exec' && command.startsWith('/usr/sbin/lsof -F ptn')) {
        return {
          stdout: genericPaths.map((filePath, index) => (
            `f${index + 1}\ntREG\nn${filePath}`
          )).join('\n') + '\n',
        };
      }
      return { stdout: '' };
    });

    const project = await createProject(`Unrelated ${scopeState} scope`);
    manualDialogFor([trustedAiAnchor]);
    await callIpc('projects:add-files', project.id);
    const currentSessionStats = {
      mtimeMs: project.watchStartedAt + 1,
      birthtimeMs: project.watchStartedAt + 1,
    };
    for (const filePath of appPaths) {
      await emitWatcherWithStats('add', filePath, currentSessionStats);
    }
    await runTrackedIntervalCallbacks();
    await new Promise(resolve => originalSetTimeout(resolve, 100));

    let fresh = await getProject(project.id);
    for (const filePath of appPaths) {
      assert.equal(fresh.files.some(file => file.path === filePath), true, `${scopeState}: ${path.extname(filePath)} source`);
    }
    for (const filePath of genericPaths) {
      assert.equal(
        fresh.pendingFiles.some(file => file.path === filePath),
        true,
        `${scopeState}: generic ${path.extname(filePath)} pending`
      );
      assert.ok(fresh.liveEvidenceLedger.candidates[liveEvidenceKeyForTest(filePath)]);
      await callIpc('projects:accept-pending', project.id, filePath);
    }
    const savedAt = new Date(Date.now() + 1000);
    for (const filePath of genericPaths) fs.utimesSync(filePath, savedAt, savedAt);

    fresh = await getProject(project.id);
    for (const filePath of [...appPaths, ...genericPaths]) {
      assert.equal(fresh.files.some(file => file.path === filePath), true);
    }
    assert.equal(
      getSessionObservedByMethod(fresh, 'projects:accept-pending').length,
      genericPaths.length
    );
    await settleAssetBaselineForUnrelatedPackageTest(project.id);

    const packageResult = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(packageResult);
    assert.equal(packageResult.success, true);
    for (const filePath of [...appPaths, ...genericPaths]) {
      assert.equal(
        fs.existsSync(path.join(packageResult.folderPath, path.basename(filePath))),
        true,
        `${scopeState}: package ${path.basename(filePath)}`
      );
    }
    fresh = await getProject(project.id);
    assert.equal(
      getProvenanceEdges(fresh, EDGE_TYPES.PACKAGE_INCLUDES_FILE).length,
      appPaths.length + genericPaths.length + 1
    );
    await callIpc('projects:delete-all');
  }
});

for (const scopeState of ['ready', 'failed']) {
  test(`explicit non-Illustrator families retain same-path state under a ${scopeState} scope`, async () => {
    resetTestHomeWorkspace();
    const sourcePath = path.join(TEST_HOME, 'Desktop', `${scopeState}-scope-source.ai`);
    const candidateDir = path.join(TEST_HOME, 'Desktop', `${scopeState}-same-path-files`);
    const anchorPath = path.join(candidateDir, `${scopeState}-manual-anchor.ai`);
    const candidates = [
      ['photoshop', 'psd-linked', '.psd'],
      ['indesign', 'indd-linked', '.indd'],
      ['powerpoint', 'app-opened', '.pptx'],
      ['figma', 'app-opened', '.png'],
      ['generic', 'lastused-scan', '.pdf'],
      ['generic', 'lastused-scan', '.svg'],
      ['generic', 'lastused-scan', '.eps'],
      ['generic', 'lastused-scan', '.ai'],
    ].map(([appFamily, source, ext], index) => ({
      appFamily,
      source,
      path: path.join(candidateDir, `${scopeState}-${appFamily}-${index}${ext}`),
    }));
    const outputDir = path.join(TEST_HOME, 'Desktop', `${scopeState}-same-path-package`);
    fs.mkdirSync(candidateDir, { recursive: true });
    fs.writeFileSync(sourcePath, 'Illustrator source bytes');
    fs.writeFileSync(anchorPath, 'manual anchor bytes');
    for (const candidate of candidates) fs.writeFileSync(candidate.path, `${candidate.appFamily} bytes`);
    fs.mkdirSync(outputDir, { recursive: true });
    setChildProcessHandler(({ kind, command, args }) => {
      if (isIllustratorPgrepCheck({ kind, command, args })) return { stdout: '321\n' };
      if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
        const rows = [
          ...(scopeState === 'failed' ? ['ERROR\tillustrator-query-failed'] : []),
          `DOC\t${sourcePath}\t${path.basename(sourcePath)}\tfalse\ttrue`,
          ...candidates.map(candidate => (
            `LINK\t${sourcePath}\t${path.basename(sourcePath)}\t${candidate.path}\tfalse\ttrue`
          )),
          `COMPLETE\t1\t${candidates.length}`,
        ];
        return { stdout: `${rows.join('\n')}\n` };
      }
      return { stdout: '' };
    });

    const project = await createProject(`Same path ${scopeState}`);
    manualDialogFor([anchorPath]);
    await callIpc('projects:add-files', project.id);
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    for (const candidate of candidates) {
      seedScopedRendererCandidate(stored, candidate.path, candidate);
      const evidenceId = `${scopeState}-${candidate.appFamily}-same-path-evidence`;
      stored.provenance.evidence[evidenceId] = {
        id: evidenceId,
        kind: OBSERVER_KINDS.APP_SCRIPT,
        source: candidate.source,
        appFamily: candidate.appFamily,
        observer: { method: `${candidate.appFamily}-test` },
        payload: { localPath: candidate.path },
      };
    }

    let view = await getProject(project.id);
    for (const candidate of candidates) {
      assert.equal(
        view.pendingFiles.some(file => file.path === candidate.path),
        true,
        `${candidate.appFamily} ${path.extname(candidate.path)} pending must remain visible`
      );
      assert.ok(view.liveEvidenceLedger.candidates[liveEvidenceKeyForTest(candidate.path)]);
      assert.equal(JSON.stringify(view.provenance).includes(candidate.path), true);
      assert.ok(view.provenance.evidence[`${scopeState}-${candidate.appFamily}-same-path-evidence`]);
      await callIpc('projects:accept-pending', project.id, candidate.path);
    }

    view = await getProject(project.id);
    for (const candidate of candidates) {
      assert.equal(view.files.some(file => file.path === candidate.path), true);
    }
    await settleAssetBaselineForUnrelatedPackageTest(project.id);
    await callIpc('projects:pause', project.id);
    const result = await callIpc('projects:package', project.id, outputDir);
    assert.equal(
      result && result.error,
      undefined,
      `${scopeState}: unexpected package error ${result && result.error}`
    );
    assertPackageResultShape(result);
    assert.equal(result.success, true);
    for (const candidate of candidates) {
      assert.equal(
        fs.existsSync(path.join(result.folderPath, path.basename(candidate.path))),
        true,
        `${candidate.appFamily} ${path.extname(candidate.path)} must be packaged`
      );
    }
    view = await getProject(project.id);
    assert.equal(
      getProvenanceEdges(view, EDGE_TYPES.PACKAGE_INCLUDES_FILE).length,
      candidates.length + 1
    );
  });
}

test('same denied paths preserve explicit non-Illustrator authority while hiding Illustrator records', async () => {
  resetTestHomeWorkspace();
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'same-path-baseline.ai');
  const authorities = [
    { appFamily: 'photoshop', source: 'psd-linked', path: path.join(TEST_HOME, 'Desktop', 'same-path-photoshop.png') },
    { appFamily: 'indesign', source: 'indd-linked', path: path.join(TEST_HOME, 'Desktop', 'same-path-indesign.jpg') },
  ];
  const outputDir = path.join(TEST_HOME, 'Desktop', 'same-path-authority-package');
  fs.writeFileSync(sourcePath, 'Illustrator baseline bytes');
  for (const authority of authorities) fs.writeFileSync(authority.path, `${authority.appFamily} authority bytes`);
  fs.mkdirSync(outputDir, { recursive: true });
  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) return { stdout: '753\n' };
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      return {
        stdout: [
          `DOC\t${sourcePath}\t${path.basename(sourcePath)}\tfalse\ttrue`,
          ...authorities.map(authority => (
            `LINK\t${sourcePath}\t${path.basename(sourcePath)}\t${authority.path}\tfalse\ttrue`
          )),
          `COMPLETE\t1\t${authorities.length}`,
        ].join('\n') + '\n',
      };
    }
    return { stdout: '' };
  });

  const project = await createProject('Per-record same-path authority');
  await callIpc('projects:pause', project.id);
  const stored = storeInstance.data.projects.find(item => item.id === project.id);
  stored.liveEvidenceLedger = stored.liveEvidenceLedger || { schemaVersion: 1, candidates: {} };
  stored.liveEvidenceLedger.candidateLimit = EXPECTED_LIVE_EVIDENCE_CANDIDATE_CAP;
  stored.liveEvidenceLedger.records = [];
  stored.illustratorSamePathRecords = [];
  const forbidden = [];
  for (const authority of authorities) {
    const { file, fileNodeId } = seedScopedRendererCandidate(stored, authority.path, {
      appFamily: authority.appFamily,
      source: authority.source,
      includePending: false,
    });
    stored.files.push(file);
    const authorityEvidenceId = `${authority.appFamily}-same-path-authority-evidence`;
    stored.provenance.evidence[authorityEvidenceId] = {
      id: authorityEvidenceId,
      source: authority.source,
      appFamily: authority.appFamily,
      observer: { method: `${authority.appFamily}-test` },
      payload: { localPath: authority.path },
    };
    const illustratorIds = {
      file: `illustrator-same-path-${authority.appFamily}-file`,
      ledger: `illustrator-same-path-${authority.appFamily}-ledger`,
      observation: `illustrator-same-path-${authority.appFamily}-observation`,
      edge: `illustrator-same-path-${authority.appFamily}-edge`,
      evidence: `illustrator-same-path-${authority.appFamily}-evidence`,
    };
    stored.illustratorSamePathRecords.push({
      ...makePendingFile(authority.path, 'ai-linked'),
      id: illustratorIds.file,
      captureEvidence: { appFamily: 'illustrator', observerMethod: 'illustrator-active-session' },
    });
    stored.liveEvidenceLedger.records.push({
      id: illustratorIds.ledger,
      source: 'ai-linked',
      appFamily: 'illustrator',
      latest: { source: 'ai-linked', appFamily: 'illustrator', localPath: authority.path },
      observer: { method: 'illustrator-active-session' },
    });
    stored.provenance.observations.push({
      id: illustratorIds.observation,
      source: 'ai-linked',
      appFamily: 'illustrator',
      relationType: EDGE_TYPES.SESSION_OBSERVED_FILE,
      objectNodeId: fileNodeId,
      observer: { kind: OBSERVER_KINDS.APP_SCRIPT, method: 'illustrator-active-session' },
      payload: { localPath: authority.path },
    });
    stored.provenance.edges[illustratorIds.edge] = {
      id: illustratorIds.edge,
      source: 'ai-linked',
      appFamily: 'illustrator',
      relationType: EDGE_TYPES.SESSION_OBSERVED_FILE,
      objectNodeId: fileNodeId,
      observer: { method: 'illustrator-active-session' },
    };
    stored.provenance.evidence[illustratorIds.evidence] = {
      id: illustratorIds.evidence,
      source: 'ai-linked',
      appFamily: 'illustrator',
      observer: { method: 'illustrator-active-session' },
      payload: { localPath: authority.path },
    };
    forbidden.push(...Object.values(illustratorIds));
  }
  forbidden.push('illustrator-active-session');
  await getProject(project.id);
  const persistedBeforeViews = structuredClone({
    files: stored.files,
    pendingFiles: stored.pendingFiles,
    liveEvidenceLedger: stored.liveEvidenceLedger,
    provenance: stored.provenance,
    illustratorSamePathRecords: stored.illustratorSamePathRecords,
  });

  testRendererEvents.length = 0;
  const responses = [];
  const record = (surface, payload) => responses.push([surface, JSON.stringify(payload) || '']);
  record('projects:get-all', await callIpc('projects:get-all'));
  record('projects:get-files', await callIpc('projects:get-files', project.id));
  record('figma:project-assets', await callIpc('figma:project-assets', project.id));
  const view = await getProject(project.id);
  for (const authority of authorities) {
    assert.equal(view.files.some(file => file.path === authority.path && file.captureEvidence.appFamily === authority.appFamily), true);
    assert.ok(view.liveEvidenceLedger.candidates[liveEvidenceKeyForTest(authority.path)]);
    assert.ok(view.provenance.evidence[`${authority.appFamily}-same-path-authority-evidence`]);
    assert.ok(view.provenance.nodes[createNodeId(NODE_TYPES.FILE, {
      normalizedPath: normalizeLedgerPathForTest(authority.path),
    })]);
  }
  assert.deepEqual(
    responses.filter(([, payload]) => forbidden.some(value => payload.includes(value))).map(([surface]) => surface),
    []
  );
  assert.equal(forbidden.some(value => JSON.stringify(testRendererEvents).includes(value)), false);
  assert.deepEqual({
    files: stored.files,
    pendingFiles: stored.pendingFiles,
    liveEvidenceLedger: stored.liveEvidenceLedger,
    provenance: stored.provenance,
    illustratorSamePathRecords: stored.illustratorSamePathRecords,
  }, persistedBeforeViews);
  record('projects:reject-pending', await callIpc('projects:reject-pending', project.id, 'not-present'));
  record('projects:pre-package-scan', await callIpc('projects:pre-package-scan', project.id));
  assert.deepEqual(
    responses.filter(([, payload]) => forbidden.some(value => payload.includes(value))).map(([surface]) => surface),
    []
  );
  assert.equal(forbidden.some(value => JSON.stringify(testRendererEvents).includes(value)), false);

  await callIpc('settings:update', 'includeDiagnosticReport', true);
  const packageResult = await callIpc('projects:package', project.id, outputDir);
  assertPackageResultShape(packageResult);
  assert.equal(packageResult.success, true);
  assert.equal(packageResult.totalFiles, authorities.length);
  for (const authority of authorities) {
    assert.equal(fs.existsSync(path.join(packageResult.folderPath, path.basename(authority.path))), true);
  }
  assert.equal(
    forbidden.some(value => JSON.stringify(readManifest(outputDir, 'Per-record same-path authority')).includes(value)),
    false
  );
});

test('Illustrator baseline document stays excluded until Add files admits its source and links', async () => {
  resetTestHomeWorkspace();
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'Baseline_B.ai');
  const linkedPath = path.join(TEST_HOME, 'Desktop', 'Baseline_B_Asset.png');
  fs.writeFileSync(sourcePath, 'baseline source bytes');
  fs.writeFileSync(linkedPath, 'baseline linked bytes');
  let queryCount = 0;

  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) return { stdout: '432\n' };
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      queryCount++;
      return {
        stdout: `DOC\t${sourcePath}\tBaseline_B.ai\tfalse\ttrue\n` +
          `LINK\t${sourcePath}\tBaseline_B.ai\t${linkedPath}\tfalse\ttrue\nCOMPLETE\t1\t1\n`,
      };
    }
    return { stdout: '' };
  });

  const project = await createProject('Illustrator baseline Add override');
  await waitForProject(project.id, () => queryCount >= 1, 5000);
  let fresh = await getProject(project.id);
  assert.equal([...fresh.files, ...fresh.pendingFiles].some(file => file.path === sourcePath), false);
  assert.equal([...fresh.files, ...fresh.pendingFiles].some(file => file.path === linkedPath), false);

  manualDialogFor([sourcePath]);
  await callIpc('projects:add-files', project.id);
  fresh = await waitForProject(
    project.id,
    item => item.files.some(file => file.path === sourcePath) &&
      item.pendingFiles.some(file => file.path === linkedPath),
    5000
  );
  assert.equal(fresh.files.some(file => file.path === sourcePath && file.source === 'manual-browse'), true);
  assert.equal(fresh.pendingFiles.some(file => file.path === linkedPath && file.source === 'ai-linked'), true);
});

test('current-session watcher save admits a baseline Illustrator source and its parser-confirmed linked asset', async () => {
  resetTestHomeWorkspace();
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'Review_Project.ai');
  const linkedPath = '/Users/CrateQA/Review_Initial.png';
  writeSyntheticAiFile(sourcePath, `Illustrator linked asset: ${linkedPath}`);
  let illustratorQueryCount = 0;
  let sourceReadCount = 0;
  let linkedAccessCount = 0;

  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) return { stdout: '432\n' };
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      illustratorQueryCount++;
      return {
        stdout: `DOC\t${sourcePath}\tReview_Project.ai\tfalse\ttrue\n` +
          `LINK\t${sourcePath}\tReview_Project.ai\t${linkedPath}\tfalse\ttrue\nCOMPLETE\t1\t1\n`,
      };
    }
    return { stdout: '' };
  });

  const originalAccess = fs.promises.access;
  const originalAccessSync = fs.accessSync;
  const originalReadFile = fs.promises.readFile;
  fs.promises.readFile = async function readReviewProject(filePath, ...args) {
    if (path.resolve(filePath) === path.resolve(sourcePath)) sourceReadCount++;
    return originalReadFile.call(fs.promises, filePath, ...args);
  };
  fs.promises.access = async function accessReviewLinkedAsset(filePath, ...args) {
    if (path.resolve(filePath) === path.resolve(linkedPath)) {
      linkedAccessCount++;
      return;
    }
    return originalAccess.call(fs.promises, filePath, ...args);
  };
  fs.accessSync = function accessReviewLinkedAssetSync(filePath, ...args) {
    if (path.resolve(filePath) === path.resolve(linkedPath)) return;
    return originalAccessSync.call(fs, filePath, ...args);
  };

  try {
    const project = await createProject('Illustrator baseline watcher save');
    assert.equal(illustratorQueryCount >= 1, true);
    let fresh = await getProject(project.id);
    assert.deepEqual(fresh.files, []);
    assert.deepEqual(fresh.pendingFiles, []);

    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    const saveMtimeMs = stored.watchStartedAt + 1000;
    fs.utimesSync(sourcePath, new Date(saveMtimeMs), new Date(saveMtimeMs));
    await emitWatcher('change', sourcePath, {
      mtimeMs: saveMtimeMs,
      birthtimeMs: stored.watchStartedAt - 1000,
    });

    fresh = await waitForProject(
      project.id,
      item => item.files.some(file => file.path === sourcePath) &&
        item.files.some(file => file.path === linkedPath && file.source === 'scan-on-open'),
      5000
    );
    assert.equal(sourceReadCount > 0, true);
    assert.equal(linkedAccessCount > 0, true);
    assert.deepEqual(fresh.pendingFiles, []);
    assert.deepEqual(fresh.files.map(file => file.path).sort(), [linkedPath, sourcePath].sort());
    assert.equal(fresh.files.filter(file => file.path === sourcePath).length, 1);
    assert.equal(fresh.files.filter(file => file.path === linkedPath).length, 1);
    assert.equal(getSessionObservedByMethod(fresh, 'projects:add-files').length, 0);
    assert.equal(getSessionObservedByMethod(fresh, 'scan-on-open').length, 1);
    const linkedLedgerEntries = Object.values((fresh.liveEvidenceLedger && fresh.liveEvidenceLedger.candidates) || {})
      .filter(entry => entry.latest && entry.latest.candidateName === 'Review_Initial.png');
    assert.ok(linkedLedgerEntries.some(entry => entry.strongestState === 'package-ready'));
  } finally {
    fs.promises.access = originalAccess;
    fs.accessSync = originalAccessSync;
    fs.promises.readFile = originalReadFile;
  }
});

for (const projectState of ['watching', 'paused']) {
  test(`Add files explicitly authorizes a hidden same-path Illustrator record for a ${projectState} project`, async () => {
    resetTestHomeWorkspace();
    const sourcePath = path.join(TEST_HOME, 'Desktop', `Hidden_Same_Path_${projectState}.ai`);
    const outputDir = path.join(TEST_HOME, 'Desktop', `hidden-same-path-${projectState}-package`);
    fs.writeFileSync(sourcePath, `${projectState} source bytes`);
    fs.mkdirSync(outputDir, { recursive: true });
    let queryCount = 0;

    setChildProcessHandler(({ kind, command, args }) => {
      if (isIllustratorPgrepCheck({ kind, command, args })) return { stdout: '876\n' };
      if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
        queryCount++;
        return {
          stdout: `DOC\t${sourcePath}\t${path.basename(sourcePath)}\tfalse\ttrue\nCOMPLETE\t1\t0\n`,
        };
      }
      return { stdout: '' };
    });

    const project = await createProject(`Hidden same path ${projectState}`);
    await waitForProject(project.id, () => queryCount >= 1, 5000);
    if (projectState === 'paused') await callIpc('projects:pause', project.id);

    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    const { file: discoveredFile } = seedScopedRendererCandidate(stored, sourcePath, {
      appFamily: 'illustrator',
      source: 'app-opened',
      includePending: false,
    });
    stored.files.push(discoveredFile);
    const originalObservationId = `scoped-renderer-observation-${createNodeId(NODE_TYPES.FILE, {
      normalizedPath: normalizeLedgerPathForTest(sourcePath),
    })}`;

    let view = await getProject(project.id);
    assert.equal(view.files.some(file => file.path === sourcePath), false);

    manualDialogFor([sourcePath]);
    await callIpc('projects:add-files', project.id);

    const persisted = storeInstance.data.projects.find(item => item.id === project.id);
    const authorizedRecords = persisted.files.filter(file => file.path === sourcePath);
    assert.equal(authorizedRecords.length, 1);
    assert.equal(authorizedRecords[0].source, 'app-opened');
    assert.equal(authorizedRecords[0].captureEvidence.appFamily, 'illustrator');
    assert.deepEqual(authorizedRecords[0].explicitUserAuthority, {
      granted: true,
      source: 'manual-browse',
      method: 'projects:add-files',
      grantedAt: authorizedRecords[0].explicitUserAuthority.grantedAt,
    });
    assert.equal(Number.isFinite(authorizedRecords[0].explicitUserAuthority.grantedAt), true);
    assert.ok(persisted.provenance.observations.some(observation => observation.id === originalObservationId));
    const manualObservations = getSessionObservedByMethod(persisted, 'projects:add-files')
      .filter(observation => observation.objectNodeId === createNodeId(NODE_TYPES.FILE, {
        normalizedPath: normalizeLedgerPathForTest(sourcePath),
      }));
    assert.equal(manualObservations.length, 1);
    assert.equal(manualObservations[0].observer.kind, OBSERVER_KINDS.MANUAL_USER_ACTION);
    assert.equal(manualObservations[0].payload.authoritySource, 'manual-browse');

    view = await getProject(project.id);
    assert.equal(view.files.some(file => file.path === sourcePath), true);
    assert.ok(view.liveEvidenceLedger.candidates[liveEvidenceKeyForTest(sourcePath)]);
    assert.ok(view.provenance.observations.some(observation => observation.id === originalObservationId));
    assert.equal(getSessionObservedByMethod(view, 'projects:add-files').length, 1);

    await settleAssetBaselineForUnrelatedPackageTest(project.id);
    const packageResult = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(packageResult);
    assert.equal(packageResult.success, true);
    assert.equal(fs.existsSync(path.join(packageResult.folderPath, path.basename(sourcePath))), true);
  });
}

test('Illustrator Add files during activation admits an old-project source and its links', async () => {
  resetTestHomeWorkspace();
  const oldSource = path.join(TEST_HOME, 'Desktop', 'Reusable_Old_Project.ai');
  const oldLink = path.join(TEST_HOME, 'Desktop', 'Reusable_Old_Asset.png');
  fs.writeFileSync(oldSource, 'old source bytes');
  fs.writeFileSync(oldLink, 'old linked bytes');

  setChildProcessHandler(() => ({ stdout: '' }));
  const oldProject = await createProject('Old Illustrator project');
  manualDialogFor([oldSource]);
  await callIpc('projects:add-files', oldProject.id);

  let releaseQuery;
  let markQueryStarted;
  const queryStarted = new Promise(resolve => { markQueryStarted = resolve; });
  const queryGate = new Promise(resolve => { releaseQuery = resolve; });
  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) return { stdout: '654\n' };
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      markQueryStarted();
      return queryGate.then(() => ({
        stdout: [
          `DOC\t${oldSource}\tReusable_Old_Project.ai\tfalse\ttrue`,
          `LINK\t${oldSource}\tReusable_Old_Project.ai\t${oldLink}\tfalse\ttrue`,
          'COMPLETE\t1\t1',
        ].join('\n') + '\n',
      }));
    }
    return { stdout: '' };
  });

  const createNewProject = createProject('New Illustrator project');
  await queryStarted;
  const newProjectId = storeInstance.data.projects[storeInstance.data.projects.length - 1].id;
  manualDialogFor([oldSource]);
  await callIpc('projects:add-files', newProjectId);
  releaseQuery();
  const newProject = await createNewProject;
  const fresh = await waitForProject(
    newProject.id,
    item => item.files.some(file => file.path === oldSource) &&
      item.pendingFiles.some(file => file.path === oldLink),
    5000
  );
  assert.equal(fresh.files.some(file => file.path === oldSource && file.source === 'manual-browse'), true);
  assert.equal(fresh.pendingFiles.some(file => file.path === oldLink && file.source === 'ai-linked'), true);
});

test('Add files on a paused project aborts after a B-to-A-to-B generation change', async () => {
  resetTestHomeWorkspace();
  const filePath = path.join(TEST_HOME, 'Desktop', 'stale-add-files.ai');
  fs.writeFileSync(filePath, 'stale add bytes');
  setChildProcessHandler(() => ({ stdout: '' }));
  const project = await createProject('Stale Add Files A');
  await callIpc('projects:pause', project.id);
  let releaseDialog;
  nextOpenDialogResult = new Promise(resolve => { releaseDialog = () => resolve({ canceled: false, filePaths: [filePath] }); });
  const addPromise = callIpc('projects:add-files', project.id);
  await createProject('Stale Add Files B');
  await callIpc('projects:start-watching', project.id);
  await callIpc('projects:pause', project.id);
  releaseDialog();
  assert.equal(await addPromise, null);
  const stored = storeInstance.data.projects.find(item => item.id === project.id);
  assert.equal(stored.files.some(file => file.path === filePath), false);
  assert.equal(JSON.stringify(stored.provenance).includes(filePath), false);
});

test('Illustrator restart keeps accepted B sources while excluding unrelated baseline documents', async () => {
  resetTestHomeWorkspace();
  const bSource = path.join(TEST_HOME, 'Desktop', 'Restart_B.ai');
  const bLink = path.join(TEST_HOME, 'Desktop', 'Restart_B_Asset.png');
  const unrelatedSource = path.join(TEST_HOME, 'Desktop', 'Restart_A.ai');
  const unrelatedLink = path.join(TEST_HOME, 'Desktop', 'Restart_A_Asset.png');
  for (const filePath of [bSource, bLink, unrelatedSource, unrelatedLink]) {
    fs.writeFileSync(filePath, path.basename(filePath));
  }

  setChildProcessHandler(() => ({ stdout: '' }));
  const project = await createProject('Illustrator restart scope');
  manualDialogFor([bSource]);
  await callIpc('projects:add-files', project.id);
  await callIpc('projects:pause', project.id);

  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) return { stdout: '987\n' };
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      return {
        stdout: [
          `DOC\t${bSource}\tRestart_B.ai\tfalse\ttrue`,
          `LINK\t${bSource}\tRestart_B.ai\t${bLink}\tfalse\ttrue`,
          `DOC\t${unrelatedSource}\tRestart_A.ai\tfalse\tfalse`,
          `LINK\t${unrelatedSource}\tRestart_A.ai\t${unrelatedLink}\tfalse\tfalse`,
          'COMPLETE\t2\t2',
        ].join('\n') + '\n',
      };
    }
    return { stdout: '' };
  });

  await callIpc('projects:start-watching', project.id);
  const fresh = await waitForProject(
    project.id,
    item => item.pendingFiles.some(file => file.path === bLink),
    5000
  );
  assert.equal(fresh.files.some(file => file.path === bSource), true);
  assert.equal(fresh.pendingFiles.some(file => file.path === bLink), true);
  assert.equal([...fresh.files, ...fresh.pendingFiles].some(file => file.path === unrelatedSource), false);
  assert.equal([...fresh.files, ...fresh.pendingFiles].some(file => file.path === unrelatedLink), false);
});

test('persisted foreign Illustrator pending and provenance rows are view-only filtered', async () => {
  resetTestHomeWorkspace();
  const foreignSource = path.join(TEST_HOME, 'Desktop', 'Persisted_A.ai');
  const foreignLink = path.join(TEST_HOME, 'Desktop', 'Persisted_A_Asset.png');
  const outputDir = path.join(TEST_HOME, 'Desktop', 'persisted-filter-package');
  fs.writeFileSync(foreignSource, 'foreign source bytes');
  fs.writeFileSync(foreignLink, 'foreign linked bytes');
  fs.mkdirSync(outputDir, { recursive: true });

  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) return { stdout: '753\n' };
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      return {
        stdout: [
          `DOC\t${foreignSource}\tPersisted_A.ai\tfalse\ttrue`,
          `LINK\t${foreignSource}\tPersisted_A.ai\t${foreignLink}\tfalse\ttrue`,
          'COMPLETE\t1\t1',
        ].join('\n') + '\n',
      };
    }
    return { stdout: '' };
  });

  const project = await createProject('Persisted foreign Illustrator filter');
  const stored = storeInstance.data.projects.find(item => item.id === project.id);
  const fileNodeId = createNodeId(NODE_TYPES.FILE, {
    normalizedPath: normalizeLedgerPathForTest(foreignLink),
  });
  stored.pendingFiles.push({
    ...makePendingFile(foreignLink, 'app-opened'),
    captureEvidence: {
      sourceDocumentName: 'Persisted_A.ai',
    },
  });
  stored.liveEvidenceLedger = {
    schemaVersion: 1,
    candidates: Object.fromEntries([
      makeLiveEvidenceLedgerEntry(foreignLink, 'pending', Date.now(), {
        latest: {
          source: 'ai-linked',
          observerMethod: 'illustrator-active-session',
          appFamily: 'illustrator',
          sourceDocumentName: 'Persisted_A.ai',
        },
      }),
    ]),
  };
  stored.provenance.nodes[fileNodeId] = {
    id: fileNodeId,
    type: NODE_TYPES.FILE,
    path: foreignLink,
  };
  stored.provenance.observations.push({
    id: 'persisted-foreign-observation',
    relationType: EDGE_TYPES.SESSION_OBSERVED_FILE,
    objectNodeId: fileNodeId,
    observer: { kind: OBSERVER_KINDS.APP_SCRIPT, method: 'ai-linked' },
  });

  const view = await getProject(project.id);
  assert.deepEqual(view.pendingFiles, []);
  assert.equal(JSON.stringify(view.liveEvidenceLedger || {}).includes('Persisted_A_Asset.png'), false);
  assert.equal(JSON.stringify(view.provenance || {}).includes(fileNodeId), false);
  assert.equal((await callIpc('projects:get-files', project.id)).some(file => file.path === foreignLink), false);
  assert.equal(stored.pendingFiles.some(file => file.path === foreignLink), true);
  assert.equal(JSON.stringify(stored.provenance).includes(fileNodeId), true);
  assert.equal(await callIpc('projects:accept-pending', project.id, foreignLink), null);
  assert.equal(stored.pendingFiles.some(file => file.path === foreignLink), true);

  const prePackage = await callIpc('projects:pre-package-scan', project.id);
  assert.equal(prePackage.files.some(file => file.path === foreignLink), false);
  const packageResult = await callIpc('projects:package', project.id, outputDir);
  assertPackageResultShape(packageResult);
  assert.equal(fs.existsSync(path.join(packageResult.folderPath, path.basename(foreignLink))), false);
  assert.equal(stored.pendingFiles.some(file => file.path === foreignLink), true);
});

test('true provenance-only activation baseline is filtered from project views and packaging without mutation', async () => {
  resetTestHomeWorkspace();
  const foreignSource = path.join(TEST_HOME, 'Desktop', 'Provenance_Only_A.ai');
  const evidenceOnlyPath = path.join(TEST_HOME, 'Desktop', 'Evidence_Only_A.ai');
  const outputDir = path.join(TEST_HOME, 'Desktop', 'provenance-only-package');
  fs.writeFileSync(foreignSource, 'foreign source bytes');
  fs.writeFileSync(evidenceOnlyPath, 'evidence-only source bytes');
  fs.mkdirSync(outputDir, { recursive: true });
  let queryCount = 0;
  let releaseQuery;
  let markQueryStarted;
  const queryStarted = new Promise(resolve => { markQueryStarted = resolve; });
  const queryGate = new Promise(resolve => { releaseQuery = resolve; });
  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) return { stdout: '753\n' };
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      queryCount++;
      markQueryStarted();
      return queryGate.then(() => ({
        stdout: [
          `DOC\t${foreignSource}\t${path.basename(foreignSource)}\tfalse\ttrue`,
          `DOC\t${evidenceOnlyPath}\t${path.basename(evidenceOnlyPath)}\tfalse\tfalse`,
          'COMPLETE\t2\t0',
        ].join('\n') + '\n',
      }));
    }
    return { stdout: '' };
  });

  const createPromise = createProject('Provenance-only Illustrator filter');
  await queryStarted;
  const stored = storeInstance.data.projects[storeInstance.data.projects.length - 1];
  const projectId = stored.id;
  const fileNodeId = createNodeId(NODE_TYPES.FILE, {
    normalizedPath: normalizeLedgerPathForTest(foreignSource),
  });
  const sessionNodeId = Object.keys(stored.provenance.nodes)
    .find(nodeId => stored.provenance.nodes[nodeId].type === NODE_TYPES.SESSION);
  stored.provenance.nodes[fileNodeId] = {
    id: fileNodeId,
    type: NODE_TYPES.FILE,
    path: foreignSource,
    normalizedPath: normalizeLedgerPathForTest(foreignSource),
  };
  stored.provenance.edges['provenance-only-foreign-edge'] = {
    id: 'provenance-only-foreign-edge',
    relationType: EDGE_TYPES.SESSION_OBSERVED_FILE,
    subjectNodeId: sessionNodeId,
    objectNodeId: fileNodeId,
  };
  stored.provenance.observations.push({
    id: 'provenance-only-foreign-observation',
    relationType: EDGE_TYPES.SESSION_OBSERVED_FILE,
    subjectNodeId: sessionNodeId,
    objectNodeId: fileNodeId,
    observer: { kind: OBSERVER_KINDS.APP_SCRIPT, method: 'ai-linked' },
  });
  stored.provenance.evidence['provenance-only-hidden-payload'] = {
    id: 'provenance-only-hidden-payload',
    kind: OBSERVER_KINDS.APP_SCRIPT,
    payload: {
      localPath: evidenceOnlyPath,
      nested: {
        sourcePath: evidenceOnlyPath,
        candidates: [{ filePath: evidenceOnlyPath }],
      },
    },
  };
  assert.deepEqual(stored.files, []);
  assert.deepEqual(stored.pendingFiles, []);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      (stored.liveEvidenceLedger && stored.liveEvidenceLedger.candidates) || {},
      liveEvidenceKeyForTest(foreignSource)
    ),
    false
  );
  const persistedProvenanceBytes = JSON.stringify(stored.provenance);
  const persistedProvenanceSnapshot = structuredClone(stored.provenance);

  testRendererEvents.length = 0;
  const responses = [];
  const record = (surface, payload) => responses.push([surface, JSON.stringify(payload) || '']);
  releaseQuery();
  record('projects:create', await createPromise);
  assert.ok(queryCount >= 1);
  record('projects:pause', await callIpc('projects:pause', projectId));
  record('projects:start-watching', await callIpc('projects:start-watching', projectId));
  record('projects:get-all', await callIpc('projects:get-all'));
  record('projects:get-files', await callIpc('projects:get-files', projectId));
  record('figma:project-assets', await callIpc('figma:project-assets', projectId));
  record(
    'projects:set-figma-link',
    await callIpc('projects:set-figma-link', projectId, { action: 'preserve' })
  );
  record('projects:remove-file', await callIpc('projects:remove-file', projectId, 'not-present'));
  record('projects:accept-pending', await callIpc('projects:accept-pending', projectId, foreignSource));
  record('projects:reject-pending', await callIpc('projects:reject-pending', projectId, foreignSource));
  const prePackage = await callIpc('projects:pre-package-scan', projectId);
  record('projects:pre-package-scan', prePackage);
  assert.deepEqual(prePackage.files, []);
  assert.equal(prePackage.newCount, 0);

  const packageResult = await callIpc('projects:package', projectId, outputDir);
  assertPackageResultShape(packageResult);
  record('projects:package', packageResult);
  assert.equal(packageResult.success, true);
  assert.equal(packageResult.totalFiles, 0);
  assert.equal(
    fs.readdirSync(packageResult.folderPath, { recursive: true })
      .some(entry => String(entry).includes(path.basename(foreignSource))),
    false
  );

  const disposable = await createProject('Filtered delete response');
  record('projects:delete', await callIpc('projects:delete', disposable.id));
  const forbidden = [
    foreignSource,
    evidenceOnlyPath,
    fileNodeId,
    'provenance-only-hidden-payload',
  ];
  const leakingSurfaces = responses
    .filter(([, payload]) => forbidden.some(value => payload.includes(value)))
    .map(([surface]) => surface);
  assert.deepEqual(leakingSurfaces, []);
  assert.equal(forbidden.some(value => JSON.stringify(testRendererEvents).includes(value)), false);
  assert.equal(JSON.stringify(stored.provenance), persistedProvenanceBytes);
  assert.deepEqual(stored.provenance, persistedProvenanceSnapshot);
});

test('nested hidden Illustrator references are filtered from every scoped record family without mutation', async () => {
  resetTestHomeWorkspace();
  const hiddenPath = path.join(TEST_HOME, 'Desktop', 'Nested_Hidden.ai');
  const authorityPath = path.join(TEST_HOME, 'Desktop', 'Nested_Authority.psd');
  const packageCandidate = path.join(TEST_HOME, 'Desktop', 'Nested_Package.png');
  const pendingCandidate = path.join(TEST_HOME, 'Desktop', 'Nested_Pending.png');
  const outputDir = path.join(TEST_HOME, 'Desktop', 'nested-hidden-package');
  for (const filePath of [hiddenPath, authorityPath, packageCandidate, pendingCandidate]) {
    fs.writeFileSync(filePath, `${path.basename(filePath)} bytes`);
  }
  fs.mkdirSync(outputDir, { recursive: true });
  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) return { stdout: '753\n' };
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      return {
        stdout: [
          `DOC\t${hiddenPath}\t${path.basename(hiddenPath)}\tfalse\ttrue`,
          `DOC\t${authorityPath}\t${path.basename(authorityPath)}\tfalse\tfalse`,
          'COMPLETE\t2\t0',
        ].join('\n') + '\n',
      };
    }
    return { stdout: '' };
  });

  const project = await createProject('Nested hidden Illustrator records');
  await callIpc('projects:pause', project.id);
  const stored = storeInstance.data.projects.find(item => item.id === project.id);
  const sessionNodeId = Object.keys(stored.provenance.nodes)
    .find(nodeId => stored.provenance.nodes[nodeId].type === NODE_TYPES.SESSION);
  const projectNodeId = Object.keys(stored.provenance.nodes)
    .find(nodeId => stored.provenance.nodes[nodeId].type === NODE_TYPES.PROJECT);
  stored.files.push(
    {
      ...makePendingFile(packageCandidate, 'manual-browse'),
      id: 'nested-hidden-file',
      metadata: { sourcePath: hiddenPath },
    },
    {
      ...makePendingFile(authorityPath, 'ps-poll'),
      id: 'nested-authority-file',
      captureEvidence: { appFamily: 'photoshop' },
      metadata: { sourcePath: authorityPath },
    }
  );
  stored.pendingFiles.push({
    ...makePendingFile(pendingCandidate, 'manual-browse'),
    id: 'nested-hidden-pending',
    metadata: { sourcePath: hiddenPath },
  });
  stored.liveEvidenceLedger = {
    schemaVersion: 1,
    candidateLimit: EXPECTED_LIVE_EVIDENCE_CANDIDATE_CAP,
    candidates: {
      'nested-hidden-candidate': {
        evidenceKey: 'nested-hidden-candidate',
        latest: { appFamily: 'photoshop', metadata: { sourcePath: hiddenPath } },
      },
      'nested-authority-candidate': {
        evidenceKey: 'nested-authority-candidate',
        latest: { appFamily: 'photoshop', source: 'psd-linked', localPath: authorityPath, metadata: { sourcePath: authorityPath } },
      },
    },
    records: [
      { id: 'nested-hidden-ledger-record', metadata: { sourcePath: hiddenPath } },
      { id: 'nested-authority-ledger-record', appFamily: 'photoshop', source: 'psd-linked', path: authorityPath, metadata: { sourcePath: authorityPath } },
    ],
  };
  stored.provenance.nodes['nested-hidden-node'] = {
    type: NODE_TYPES.APPLICATION,
    metadata: { sourcePath: hiddenPath },
  };
  stored.provenance.nodes['nested-authority-node'] = {
    id: 'nested-authority-node',
    type: NODE_TYPES.APPLICATION,
    appFamily: 'photoshop',
    source: 'psd-linked',
    path: authorityPath,
    metadata: { sourcePath: authorityPath },
  };
  stored.provenance.edges['nested-hidden-edge'] = {
    id: 'nested-hidden-edge',
    relationType: EDGE_TYPES.SESSION_OBSERVED_FILE,
    subjectNodeId: sessionNodeId,
    objectNodeId: projectNodeId,
    payload: { metadata: { sourcePath: hiddenPath } },
  };
  stored.provenance.edges['nested-hidden-node-edge'] = {
    id: 'nested-hidden-node-edge',
    relationType: EDGE_TYPES.SESSION_OBSERVED_FILE,
    subjectNodeId: sessionNodeId,
    objectNodeId: 'nested-hidden-node',
  };
  stored.provenance.observations.push({
    id: 'nested-hidden-observation',
    relationType: EDGE_TYPES.SESSION_OBSERVED_FILE,
    subjectNodeId: sessionNodeId,
    objectNodeId: projectNodeId,
    payload: { sourcePath: hiddenPath },
  });
  stored.provenance.evidence['nested-hidden-evidence'] = {
    id: 'nested-hidden-evidence',
    kind: OBSERVER_KINDS.APP_SCRIPT,
    payload: { metadata: { sourcePath: hiddenPath } },
  };
  stored.rendererRecords = [
    { id: 'nested-hidden-extra-record', metadata: { sourcePath: hiddenPath } },
    { id: 'nested-authority-extra-record', appFamily: 'photoshop', source: 'psd-linked', path: authorityPath, metadata: { sourcePath: authorityPath } },
  ];
  const cyclicDictionary = { safeCycleValue: 'cycle-safe-value' };
  cyclicDictionary.self = cyclicDictionary;
  stored.rendererDictionaries = {
    byPath: {
      [hiddenPath]: { id: 'nested-hidden-path-key-record', value: 'hidden-path-key-value' },
      'safe-relative-path-key': { id: 'nested-safe-path-key-record', value: 'safe-path-key-value' },
    },
    byId: {
      'nested-hidden-edge': { value: 'hidden-id-key-value' },
      'nested-safe-id-key': { value: 'safe-id-key-value' },
    },
    cyclicDictionary,
  };

  await getProject(project.id);
  const persistedBeforeViews = structuredClone({
    files: stored.files,
    pendingFiles: stored.pendingFiles,
    liveEvidenceLedger: stored.liveEvidenceLedger,
    provenance: stored.provenance,
    rendererRecords: stored.rendererRecords,
    rendererDictionaries: stored.rendererDictionaries,
  });
  testRendererEvents.length = 0;
  const responses = [];
  const record = (surface, payload) => responses.push([surface, JSON.stringify(payload) || '']);
  record('projects:get-all', await callIpc('projects:get-all'));
  record('projects:get-files', await callIpc('projects:get-files', project.id));
  record('figma:project-assets', await callIpc('figma:project-assets', project.id));
  assert.deepEqual({
    files: stored.files,
    pendingFiles: stored.pendingFiles,
    liveEvidenceLedger: stored.liveEvidenceLedger,
    provenance: stored.provenance,
    rendererRecords: stored.rendererRecords,
    rendererDictionaries: stored.rendererDictionaries,
  }, persistedBeforeViews);
  record(
    'projects:set-figma-link',
    await callIpc('projects:set-figma-link', project.id, { action: 'preserve' })
  );
  record('projects:remove-file', await callIpc('projects:remove-file', project.id, 'not-present'));
  record('projects:accept-pending', await callIpc('projects:accept-pending', project.id, 'not-present'));
  record('projects:reject-pending', await callIpc('projects:reject-pending', project.id, 'not-present'));
  const scan = await callIpc('projects:pre-package-scan', project.id);
  record('projects:pre-package-scan', scan);

  const forbidden = [
    hiddenPath,
    'nested-hidden-file',
    'nested-hidden-pending',
    'nested-hidden-candidate',
    'nested-hidden-ledger-record',
    'nested-hidden-node',
    'nested-hidden-edge',
    'nested-hidden-node-edge',
    'nested-hidden-observation',
    'nested-hidden-evidence',
    'nested-hidden-extra-record',
    'nested-hidden-path-key-record',
    'hidden-path-key-value',
    'hidden-id-key-value',
  ];
  const leakingSurfaces = responses
    .filter(([, payload]) => forbidden.some(value => payload.includes(value)))
    .map(([surface]) => surface);
  assert.deepEqual(leakingSurfaces, []);
  assert.equal(forbidden.some(value => JSON.stringify(testRendererEvents).includes(value)), false);
  assert.deepEqual({
    files: stored.files,
    pendingFiles: stored.pendingFiles,
    liveEvidenceLedger: stored.liveEvidenceLedger,
    provenance: stored.provenance,
    rendererRecords: stored.rendererRecords,
  }, {
    files: persistedBeforeViews.files,
    pendingFiles: persistedBeforeViews.pendingFiles,
    liveEvidenceLedger: persistedBeforeViews.liveEvidenceLedger,
    provenance: persistedBeforeViews.provenance,
    rendererRecords: persistedBeforeViews.rendererRecords,
  });

  const view = await getProject(project.id);
  assert.equal(view.files.some(file => file.id === 'nested-authority-file'), true);
  assert.equal(view.provenance.nodes['nested-authority-node'].metadata.sourcePath, authorityPath);
  assert.equal(view.liveEvidenceLedger.candidates['nested-authority-candidate'].latest.metadata.sourcePath, authorityPath);
  assert.equal(view.liveEvidenceLedger.records.some(record => record.id === 'nested-authority-ledger-record'), true);
  assert.equal(view.rendererRecords.some(record => record.id === 'nested-authority-extra-record'), true);
  assert.deepEqual(Object.keys(view.rendererDictionaries.byPath), ['safe-relative-path-key']);
  assert.deepEqual(Object.keys(view.rendererDictionaries.byId), ['nested-safe-id-key']);
  assert.deepEqual(view.rendererDictionaries.cyclicDictionary, { safeCycleValue: 'cycle-safe-value' });
  assert.deepEqual(scan.files.map(file => file.id), ['nested-authority-file']);

  await callIpc('settings:update', 'includeDiagnosticReport', true);
  const packageResult = await callIpc('projects:package', project.id, outputDir);
  assertPackageResultShape(packageResult);
  record('projects:package', packageResult);
  assert.equal(packageResult.totalFiles, 1);
  assert.equal(fs.existsSync(path.join(packageResult.folderPath, path.basename(packageCandidate))), false);
  assert.equal(fs.existsSync(path.join(packageResult.folderPath, path.basename(authorityPath))), true);
  assert.equal(forbidden.some(value => JSON.stringify(readManifest(outputDir, 'Nested hidden Illustrator records')).includes(value)), false);
  assert.deepEqual(
    responses.filter(([, payload]) => forbidden.some(value => payload.includes(value))).map(([surface]) => surface),
    []
  );
  assert.equal(forbidden.some(value => JSON.stringify(testRendererEvents).includes(value)), false);
  assert.deepEqual(stored.files, persistedBeforeViews.files);
  assert.deepEqual(stored.pendingFiles, persistedBeforeViews.pendingFiles);
  assert.deepEqual(stored.liveEvidenceLedger, persistedBeforeViews.liveEvidenceLedger);
  assert.deepEqual(stored.rendererRecords, persistedBeforeViews.rendererRecords);
});

test('every existing-project IPC file or project response uses the transient filtered view', async () => {
  resetTestHomeWorkspace();
  const foreignFile = path.join(TEST_HOME, 'Desktop', 'ipc-foreign-file.ai');
  const foreignPending = path.join(TEST_HOME, 'Desktop', 'ipc-foreign-pending.svg');
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'ipc-foreign-source.ai');
  const benignFile = path.join(TEST_HOME, 'Desktop', 'ipc-benign.psd');
  const benignPendingAccept = path.join(TEST_HOME, 'Desktop', 'ipc-benign-accept.png');
  const benignPendingReject = path.join(TEST_HOME, 'Desktop', 'ipc-benign-reject.png');
  for (const filePath of [
    foreignFile,
    foreignPending,
    sourcePath,
    benignFile,
    benignPendingAccept,
    benignPendingReject,
  ]) {
    fs.writeFileSync(filePath, `${path.basename(filePath)} bytes`);
  }
  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) return { stdout: '753\n' };
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      return {
        stdout: [
          `DOC\t${sourcePath}\t${path.basename(sourcePath)}\tfalse\ttrue`,
          `LINK\t${sourcePath}\t${path.basename(sourcePath)}\t${foreignFile}\tfalse\ttrue`,
          `LINK\t${sourcePath}\t${path.basename(sourcePath)}\t${foreignPending}\tfalse\ttrue`,
          'COMPLETE\t1\t2',
        ].join('\n') + '\n',
      };
    }
    return { stdout: '' };
  });
  const project = await createProject('IPC filtered surfaces');
  const stored = storeInstance.data.projects.find(item => item.id === project.id);
  const foreignStoredFile = seedScopedRendererCandidate(
    stored,
    foreignFile,
    { includePending: false }
  ).file;
  stored.files.push(foreignStoredFile);
  seedScopedRendererCandidate(stored, foreignPending);
  stored.pendingFiles.push(
    makePendingFile(benignPendingAccept),
    makePendingFile(benignPendingReject)
  );

  const responses = [];
  const record = (surface, payload) => responses.push([surface, JSON.stringify(payload) || '']);
  record('projects:get-all', await callIpc('projects:get-all'));
  record('projects:get-files', await callIpc('projects:get-files', project.id));
  record('figma:project-assets', await callIpc('figma:project-assets', project.id));
  record(
    'projects:set-figma-link',
    await callIpc('projects:set-figma-link', project.id, { action: 'preserve' })
  );
  record('projects:pause', await callIpc('projects:pause', project.id));
  record('projects:start-watching', await callIpc('projects:start-watching', project.id));
  record('projects:remove-file', await callIpc('projects:remove-file', project.id, 'not-present'));
  manualDialogFor([benignFile]);
  record('projects:add-files', await callIpc('projects:add-files', project.id));
  record(
    'projects:accept-pending',
    await callIpc('projects:accept-pending', project.id, benignPendingAccept)
  );
  record(
    'projects:reject-pending',
    await callIpc('projects:reject-pending', project.id, benignPendingReject)
  );
  record('projects:pre-package-scan', await callIpc('projects:pre-package-scan', project.id));
  record('inactivity:pause', await callIpc('inactivity:pause', project.id));

  const forbidden = [foreignFile, foreignPending, liveEvidenceKeyForTest(foreignPending)];
  const leakingSurfaces = responses
    .filter(([, payload]) => forbidden.some(value => payload.includes(value)))
    .map(([surface]) => surface);
  assert.deepEqual(leakingSurfaces, []);
  assert.equal(stored.files.some(file => file.path === foreignFile), true);
  assert.equal(stored.pendingFiles.some(file => file.path === foreignPending), true);
});

test('projects:create filters provenance-only foreign state added during activation', async () => {
  resetTestHomeWorkspace();
  const sourcePath = path.join(TEST_HOME, 'Desktop', 'ipc-create-source.ai');
  const foreignPath = path.join(TEST_HOME, 'Desktop', 'ipc-create-foreign.svg');
  fs.writeFileSync(sourcePath, 'source bytes');
  fs.writeFileSync(foreignPath, 'foreign bytes');
  let releaseQuery;
  let markQueryStarted;
  const queryStarted = new Promise(resolve => { markQueryStarted = resolve; });
  const queryGate = new Promise(resolve => { releaseQuery = resolve; });
  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) return { stdout: '753\n' };
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      markQueryStarted();
      return queryGate.then(() => ({
        stdout: [
          `DOC\t${sourcePath}\t${path.basename(sourcePath)}\tfalse\ttrue`,
          `LINK\t${sourcePath}\t${path.basename(sourcePath)}\t${foreignPath}\tfalse\ttrue`,
          'COMPLETE\t1\t1',
        ].join('\n') + '\n',
      }));
    }
    return { stdout: '' };
  });

  const createPromise = createProject('IPC create filtered');
  await queryStarted;
  const stored = storeInstance.data.projects[storeInstance.data.projects.length - 1];
  seedScopedRendererCandidate(stored, foreignPath, { includePending: false });
  releaseQuery();
  const response = await createPromise;
  assert.equal(JSON.stringify(response).includes(foreignPath), false);
  assert.equal(JSON.stringify(response).includes(liveEvidenceKeyForTest(foreignPath)), false);
  assert.equal(JSON.stringify(stored.provenance).includes(foreignPath), true);
});

test('paused linked Figma project preserves pre-package locked-page asset ingestion', async () => {
  resetTestHomeWorkspace();
  setChildProcessHandler(() => ({ stdout: '' }));
  const fileKey = 'paused-prepackage-figma';
  const project = await createVerifiedFigmaProject(
    'Paused Figma pre-package',
    'current-page',
    `https://www.figma.com/file/${fileKey}/Paused-File?page-id=1%3A1`
  );
  await callIpc('projects:pause', project.id);
  const stored = storeInstance.data.projects.find(item => item.id === project.id);
  stored.figmaSession = {
    startedAt: stored.watchStartedAt,
    scopeMode: 'current-page',
    teamIds: [],
    warnings: [],
    trackedFiles: [{
      key: fileKey,
      lockStatus: 'locked',
      lockedPageId: '1:1',
      lockedPageName: 'Page 1',
    }],
  };
  const asset = {
    url: 'https://cdn.figma.example/paused-prepackage.png',
    nodeId: 'paused-prepackage-node',
    imageRef: 'paused-prepackage-image',
    name: 'Paused Asset',
    format: 'png',
    figmaFileKey: fileKey,
    figmaFileName: 'Paused File',
    figmaPageId: '1:1',
    figmaPageName: 'Page 1',
  };
  const { FigmaParser } = require('../parsers/figma');
  class PausedPrePackageFigmaParser extends FigmaParser {
    async autoTrackScan() {
      return {
        files: [{ key: fileKey }],
        assets: [asset],
        errors: [],
        warnings: [],
        scopeEntries: [{
          fileKey,
          primaryKey: fileKey,
          fileFetchStatus: 'success',
          assetFetchStatus: 'success',
          lockStatus: 'locked',
          lockedPageId: '1:1',
          lockedPageName: 'Page 1',
        }],
      };
    }
  }
  setStub('./parsers/figma', () => ({ FigmaParser: PausedPrePackageFigmaParser }));
  testFetchHandler = async () => ({
    ok: true,
    status: 200,
    buffer: async () => Buffer.from('paused Figma asset bytes'),
    json: async () => ({}),
  });

  try {
    const scan = await callIpc('projects:pre-package-scan', project.id);
    assert.equal(scan.newCount, 1);
    assert.equal(scan.files.length, 1);
    assert.equal(scan.files[0].source, 'figma-auto');
    assert.equal(scan.files[0].figmaFileKey, fileKey);
    assert.equal(scan.files[0].figmaPageId, '1:1');
    assert.equal(fs.readFileSync(scan.files[0].path, 'utf8'), 'paused Figma asset bytes');
    assert.equal(stored.status, 'paused');
  } finally {
    STUBS.delete('./parsers/figma');
  }
});

test('package aborts without output when activation drifts B-to-A-to-B during a deferred write', async () => {
  await assertPackageActivationDriftFailsClosed('reactivation', async (projectA) => {
    const projectB = await createProject('Package drift reactivation B');
    await callIpc('projects:start-watching', projectA.id);
    await callIpc('projects:start-watching', projectB.id);
  });
});

test('package aborts without output when its activation is paused during a deferred write', async () => {
  await assertPackageActivationDriftFailsClosed('pause', async (project) => {
    await callIpc('projects:pause', project.id);
  });
});

test('package aborts without output when its project is deleted during a deferred write', async () => {
  await assertPackageActivationDriftFailsClosed('delete', async (project) => {
    await callIpc('projects:delete', project.id);
  });
});

test('package aborts when the same activation mutates its scope during an awaited write', async () => {
  await assertPackageScopePollBehavior(true);
});

test('unchanged Illustrator poll does not abort a long package', async () => {
  await assertPackageScopePollBehavior(false);
});

test('package removes partial writer output and leaves no success side effects', async () => {
  const tmpRoot = makeTempDir();
  const originalOpen = fs.promises.open;
  try {
    setChildProcessHandler(() => ({ stdout: '' }));
    const project = await createProject('Package partial rejection');
    const parentPsd = path.join(tmpRoot, 'partial.psd');
    const outputDir = path.join(tmpRoot, 'out');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(parentPsd, 'parent PSD bytes');
    currentPsdFixture = {
      children: [],
      linkedFiles: [{ name: 'partial.png', data: Buffer.from('complete embedded bytes') }],
    };
    await setProjectFiles(project.id, {
      files: [{
        path: parentPsd,
        name: 'partial.png',
        ext: '.png',
        addedAt: Date.now(),
        source: 'scan-on-save-embedded',
        embedded: true,
        parentPsd,
        embeddedOriginalName: 'partial.png',
        embeddedIndex: 0,
        fileId: 'partial-embedded',
      }],
    });
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    const packagePath = packageFolder(outputDir, 'Package partial rejection');
    let injectedFailure = false;
    fs.promises.open = async function partialThenReject(filePath, flags, ...args) {
      const handle = await originalOpen.call(fs.promises, filePath, flags, ...args);
      if (
        !injectedFailure &&
        flags === 'wx' &&
        isExpectedStagedPackageWrite(filePath, outputDir, 'partial.png')
      ) {
        const originalHandleWriteFile = handle.writeFile.bind(handle);
        handle.writeFile = async () => {
          injectedFailure = true;
          await originalHandleWriteFile(Buffer.from('partial bytes'));
          throw new Error('forced partial write rejection');
        };
      }
      return handle;
    };

    const result = await callIpc('projects:package', project.id, outputDir);
    assert.equal(result.success === true, false);
    assert.equal(fs.existsSync(packagePath), false);
    assert.equal(storeInstance.get('usage.packagesThisMonth'), 0);
    assert.equal(getProvenanceEdges(stored, EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 0);
    assert.equal(getProvenanceEdges(stored, EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE).length, 0);
    assert.notEqual(stored.status, 'packaged');
    assert.equal(stored.packagedAt == null, true);
    assert.equal(stored.outputPath == null, true);
  } finally {
    fs.promises.open = originalOpen;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('package cleans stable staging when the selected output root is renamed and replaced during PSD work', async () => {
  await assertPackageRootReplacementFailsClosed('psd', 'rename');
});

test('package cleans stable staging when the selected output root is replaced by a symlink during presentation work', async () => {
  await assertPackageRootReplacementFailsClosed('presentation', 'symlink');
});

test('stale Illustrator activation and old watcher callbacks cannot mutate or emit after project switches', async () => {
  resetTestHomeWorkspace();
  const staleSource = path.join(TEST_HOME, 'Desktop', 'Stale_A.ai');
  const staleLink = path.join(TEST_HOME, 'Desktop', 'Stale_A_Asset.png');
  const staleWatcherPath = path.join(TEST_HOME, 'Desktop', 'Stale_Watcher.ai');
  for (const filePath of [staleSource, staleLink, staleWatcherPath]) {
    fs.writeFileSync(filePath, path.basename(filePath));
  }

  const projectB = await createProject('Stale activation B');

  let queryCount = 0;
  let releaseFirstQuery;
  let markFirstQueryStarted;
  const firstQueryStarted = new Promise(resolve => { markFirstQueryStarted = resolve; });
  const firstQueryGate = new Promise(resolve => { releaseFirstQuery = resolve; });
  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) return { stdout: '852\n' };
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      queryCount++;
      if (queryCount === 1) {
        markFirstQueryStarted();
        return firstQueryGate.then(() => ({
          stdout: [
            `DOC\t${staleSource}\tStale_A.ai\tfalse\ttrue`,
            `LINK\t${staleSource}\tStale_A.ai\t${staleLink}\tfalse\ttrue`,
            'COMPLETE\t1\t1',
          ].join('\n') + '\n',
        }));
      }
      return { stdout: 'STATUS\tno-documents\nCOMPLETE\t0\t0\n' };
    }
    return { stdout: '' };
  });

  const createA = createProject('Stale activation A');
  await firstQueryStarted;
  const aId = storeInstance.data.projects[storeInstance.data.projects.length - 1].id;
  await callIpc('projects:start-watching', projectB.id);
  testRendererEvents.length = 0;
  releaseFirstQuery();
  await createA;
  await new Promise(resolve => originalSetTimeout(resolve, 50));
  const storedA = storeInstance.data.projects.find(item => item.id === aId);
  assert.equal([...storedA.files, ...storedA.pendingFiles].some(file => [staleSource, staleLink].includes(file.path)), false);
  assert.equal(testRendererEvents.some(entry => entry.data && entry.data.projectId === aId), false);

  await callIpc('projects:start-watching', aId);
  const oldAWatcher = latestWatcherHandlers();
  await callIpc('projects:start-watching', projectB.id);
  await callIpc('projects:delete', aId);
  testRendererEvents.length = 0;
  await oldAWatcher.add(staleWatcherPath);
  assert.equal(storeInstance.data.projects.some(item => item.id === aId), false);
  assert.equal((await getProject(projectB.id)).files.some(file => file.path === staleWatcherPath), false);
  assert.equal(testRendererEvents.some(entry => entry.data && entry.data.projectId === aId), false);

  const oldBWatcher = latestWatcherHandlers();
  await callIpc('projects:pause', projectB.id);
  testRendererEvents.length = 0;
  await oldBWatcher.change(staleWatcherPath);
  assert.equal((await getProject(projectB.id)).files.some(file => file.path === staleWatcherPath), false);
  assert.equal(testRendererEvents.some(entry => entry.data && entry.data.projectId === projectB.id), false);

  setChildProcessHandler(() => ({ stdout: '' }));
  const switchA = await createProject('Stale token switch A');
  let releaseStaleBQuery;
  let markStaleBQueryStarted;
  const staleBQueryStarted = new Promise(resolve => { markStaleBQueryStarted = resolve; });
  const staleBQueryGate = new Promise(resolve => { releaseStaleBQuery = resolve; });
  let bQueryCount = 0;
  setChildProcessHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) return { stdout: '963\n' };
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      bQueryCount++;
      if (bQueryCount === 1) {
        markStaleBQueryStarted();
        return staleBQueryGate.then(() => ({
          stdout: `DOC\t${staleSource}\tStale_A.ai\tfalse\ttrue\n` +
            `LINK\t${staleSource}\tStale_A.ai\t${staleLink}\tfalse\ttrue\nCOMPLETE\t1\t1\n`,
        }));
      }
      return { stdout: 'STATUS\tno-documents\nCOMPLETE\t0\t0\n' };
    }
    return { stdout: '' };
  });

  const staleBActivation = callIpc('projects:start-watching', projectB.id);
  await staleBQueryStarted;
  await callIpc('projects:start-watching', switchA.id);
  await callIpc('projects:start-watching', projectB.id);
  testRendererEvents.length = 0;
  releaseStaleBQuery();
  await staleBActivation;
  await new Promise(resolve => originalSetTimeout(resolve, 50));
  const storedB = storeInstance.data.projects.find(item => item.id === projectB.id);
  assert.equal([...storedB.files, ...storedB.pendingFiles].some(file => [staleSource, staleLink].includes(file.path)), false);
  assert.equal(testRendererEvents.some(entry => entry.data && entry.data.projectId === projectB.id), false);
});

test('stale Photoshop and InDesign awaits cannot mutate old-project diagnostics or renderer state', async () => {
  for (const appFamily of ['photoshop', 'indesign']) {
    resetTestHomeWorkspace();
    setChildProcessHandler(() => ({ stdout: '' }));
    const projectA = await createProject(`Stale ${appFamily} A`);

    let releaseScript;
    let markScriptStarted;
    const scriptStarted = new Promise(resolve => { markScriptStarted = resolve; });
    const scriptGate = new Promise(resolve => { releaseScript = resolve; });
    const scriptName = appFamily === 'photoshop'
      ? 'crate-ps-poll.applescript'
      : 'crate-indd-poll.applescript';
    setChildProcessHandler(({ kind, command, args }) => {
      if (isIllustratorPgrepCheck({ kind, command, args })) return { stdout: '' };
      if (isIllustratorPsCommCheck({ kind, command, args })) return { stdout: '' };
      if (isIllustratorPsCommandCheck({ kind, command, args })) return { stdout: '' };
      if (kind === 'exec' && command.includes("grep -i 'Adobe Photoshop'")) {
        return { stdout: appFamily === 'photoshop' ? 'Adobe Photoshop\n' : '' };
      }
      if (kind === 'exec' && command.includes("grep -i 'Adobe InDesign'")) {
        return { stdout: appFamily === 'indesign' ? 'Adobe InDesign\n' : '' };
      }
      if (isOsascriptInvocation({ kind, command, args }, scriptName)) {
        markScriptStarted();
        return scriptGate.then(() => ({ stdout: '' }));
      }
      return { stdout: '' };
    });

    const intervalRun = runTrackedIntervalCallbacks();
    await scriptStarted;
    const projectB = await createProject(`Stale ${appFamily} B`);
    const storedA = storeInstance.data.projects.find(item => item.id === projectA.id);
    const entriesBeforeRelease = getLiveAppStatusEntries(storedA, appFamily).length;
    testRendererEvents.length = 0;
    releaseScript();
    await intervalRun;
    await new Promise(resolve => originalSetTimeout(resolve, 600));

    assert.equal(getLiveAppStatusEntries(storedA, appFamily).length, entriesBeforeRelease);
    assert.equal(
      testRendererEvents.some(entry => entry.data && entry.data.projectId === projectA.id),
      false
    );
    assert.ok(await getProject(projectB.id));
    await callIpc('projects:delete-all');
  }
});

for (const awaitPoint of ['metadata', 'photoshop', 'psd-parser', 'indesign', 'linked-file', 'figma']) {
  for (const race of ['pause', 'delete', 'b-a-b']) {
    test(`pre-package ${awaitPoint} await aborts cleanly after ${race}`, async () => {
      await assertPrePackageAwaitRaceFailsClosed(awaitPoint, race);
    });
  }
}

for (const awaitPoint of ['metadata', 'photoshop', 'psd-parser', 'indesign', 'linked-file', 'figma']) {
  test(`pre-package ${awaitPoint} await aborts cleanly after same-token scope drift`, async () => {
    await assertPrePackageAwaitRaceFailsClosed(awaitPoint, 'same-token');
  });
}

test('Illustrator pathless duplicate document names fail closed', async () => {
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
          'COMPLETE\t2\t2',
        ].join('\n') + '\n',
      };
    }
    return { stdout: '' };
  });

  const { result: fresh, output } = await captureConsoleDuring(async () => {
    const project = await createProject('Illustrator ambiguous pathless refresh');
    await waitForProject(project.id, () => osascriptInvocations >= 1, 5000);
    await runTrackedIntervalCallbacks();
    await new Promise(resolve => originalSetTimeout(resolve, 50));
    return getProject(project.id);
  });

  assert.deepEqual(fresh.files, []);
  assert.deepEqual(fresh.pendingFiles, []);
  assert.ok(output.includes('script-success=false'));
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
    await runTrackedIntervalCallbacks();
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
    await runTrackedIntervalCallbacks();
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
    await runTrackedIntervalCallbacks();
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
    await runTrackedIntervalCallbacks();
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
  setIllustratorOpenedAfterActivationHandler(({ kind, command, args }) => {
    if (isIllustratorPgrepCheck({ kind, command, args })) {
      return { stdout: '123\n' };
    }
    if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
      return { stdout: `DOC\t${sourcePath}\treconciled-live-illustrator.ai\ttrue\ttrue\nCOMPLETE\t1\t0\n` };
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

test('session-related broad Illustrator evidence remains blocked without structured admission', async () => {
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

  await new Promise(resolve => originalSetTimeout(resolve, 800));
  const fresh = await getProject(project.id);
  assert.equal(fresh.files.some(file => file.path === broadPath), false);
  assert.equal(fresh.pendingFiles.some(file => file.path === broadPath), false);
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

  setIllustratorOpenedAfterActivationHandler(({ kind, command, args }) => {
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
          'COMPLETE\t1\t1',
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
    .some(entry => entry.latest && entry.latest.reason === 'broad-observer-outside-session'), false);
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

test('legacy .ppt watcher uses byte-regex linked discovery without ZIP extraction', async () => {
  const sharedUsersRoot = '/Users/Shared';
  assert.doesNotThrow(
    () => fs.accessSync(sharedUsersRoot, fs.constants.W_OK),
    'legacy .ppt watcher coverage requires writable /Users/Shared on the macOS test host'
  );
  const fixtureRoot = fs.mkdtempSync(path.join(sharedUsersRoot, 'crate-legacy-ppt-scan-'));
  let unzipCalls = 0;
  try {
    const project = await createProject('Legacy PPT linked discovery');
    const sourcePath = path.join(fixtureRoot, 'Legacy.ppt');
    const linkedPath = path.join(fixtureRoot, 'Legacy-linked.png');
    fs.writeFileSync(linkedPath, 'legacy linked bytes');
    fs.writeFileSync(sourcePath, Buffer.from(`LEGACY_PPT_BINARY\0${linkedPath}\0`, 'utf8'));
    await setProjectFiles(project.id, { files: [{
      path: sourcePath,
      name: 'Legacy.ppt',
      ext: '.ppt',
      addedAt: Date.now(),
      source: 'manual-browse',
    }] });
    setChildProcessHandler(({ kind, command }) => {
      if (kind === 'execFile' && command === '/usr/bin/unzip') unzipCalls++;
      return { stdout: '' };
    });

    await emitWatcher('change', sourcePath);
    const fresh = await waitForProject(
      project.id,
      item => item.files.some(file => file.path === linkedPath && file.source === 'scan-on-open'),
      5000
    );

    assert.equal(unzipCalls, 0);
    assert.equal(fresh.files.some(file => file.path === sourcePath), true);
    assert.equal(fresh.files.some(file => file.path === linkedPath && file.source === 'scan-on-open'), true);
    assert.equal(getSessionObservedByMethod(fresh, 'scan-on-open').length, 1);
  } finally {
    setChildProcessHandler(null);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
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
      .some(entry => entry.latest && entry.latest.reason === 'broad-observer-outside-session'), false);
    const storedProject = storeInstance.data.projects.find(item => item.id === project.id);
    assert.equal(Object.values((storedProject.liveEvidenceLedger && storedProject.liveEvidenceLedger.candidates) || {})
      .some(entry => entry.latest && entry.latest.reason === 'broad-observer-outside-session'), false);
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
      if (isIllustratorPgrepCheck({ kind, command, args })) {
        return { stdout: '777\n' };
      }
      if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
        assertPrivateTempScriptPath(args[0]);
        assert.equal(commandText.includes('tell application'), false);
        return {
          stdout: [
            `DOC\t${aiPath}\tlayout.ai\ttrue\tfalse`,
            `LINK\t${aiPath}\tlayout.ai\t${scriptLinkedPath}\ttrue\tfalse`,
            'COMPLETE\t1\t1',
          ].join('\n') + '\n',
        };
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

test('a delayed PSD scan from an old A activation cannot mutate after A to B to A', async () => {
  const tmpRoot = makeTempDir();
  const originalReadFile = fs.promises.readFile;
  let releaseRead = () => {};
  try {
    const first = await createProject('Delayed PSD Activation A');
    const firstWatcher = latestWatcherHandlers();
    const psdPath = path.join(tmpRoot, 'delayed-source.psd');
    const linkedPath = path.join(tmpRoot, 'delayed-linked.ai');
    fs.writeFileSync(psdPath, 'psd bytes');
    fs.writeFileSync(linkedPath, 'linked bytes');
    await setProjectFiles(first.id, {
      files: [{
        path: psdPath,
        name: 'delayed-source.psd',
        ext: '.psd',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    currentPsdFixture = {
      children: [{ linkedFile: { fullPath: linkedPath } }],
      linkedFiles: [],
    };

    const readGate = new Promise(resolve => { releaseRead = resolve; });
    let markReadStarted;
    const readStarted = new Promise(resolve => { markReadStarted = resolve; });
    fs.promises.readFile = async function gatedPsdRead(filePath, ...args) {
      if (path.resolve(filePath) === path.resolve(psdPath)) {
        markReadStarted();
        await readGate;
      }
      return originalReadFile.call(fs.promises, filePath, ...args);
    };

    await firstWatcher.change(psdPath);
    await readStarted;
    const second = await createProject('Delayed PSD Activation B');
    await callIpc('projects:start-watching', first.id);
    releaseRead();
    await new Promise(resolve => originalSetTimeout(resolve, 100));

    const firstFresh = await getProject(first.id);
    const secondFresh = await getProject(second.id);
    assert.equal(firstFresh.status, 'watching');
    assert.equal(secondFresh.status, 'paused');
    assert.equal(firstFresh.files.some(file => file.path === linkedPath), false);
    assert.equal(secondFresh.files.some(file => file.path === linkedPath), false);
    assert.equal(getProvenanceEdges(firstFresh, EDGE_TYPES.CONTAINER_REFERENCES_FILE).length, 0);
  } finally {
    fs.promises.readFile = originalReadFile;
    releaseRead();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

for (const staleScenario of ['pause', 'delete', 'B-A-B']) {
  test(`stale multi-asset PSD extraction cleans staged output after ${staleScenario}`, async () => {
    await assertStalePsdExtractionLeavesNoInvocationFiles(staleScenario);
  });
}

test('multi-asset PSD extraction error cleans earlier staged output and preserves unrelated files', async () => {
  const tmpRoot = makeTempDir();
  const originalWriteFile = fs.promises.writeFile;
  let extractDir = null;
  try {
    setChildProcessHandler(() => ({ stdout: '' }));
    const project = await createProject('PSD extraction later write error');
    const psdPath = path.join(tmpRoot, 'write-error.psd');
    extractDir = path.join(os.tmpdir(), `crate-psd-extract-${project.id}`);
    const sentinelPath = path.join(extractDir, 'pre-existing-unrelated.txt');
    fs.writeFileSync(psdPath, 'psd bytes');
    fs.mkdirSync(extractDir, { recursive: true });
    fs.writeFileSync(sentinelPath, 'unrelated bytes');
    currentPsdFixture = {
      children: [],
      linkedFiles: [
        { name: 'earlier.png', data: Buffer.from('earlier invocation bytes') },
        { name: 'later.png', data: Buffer.from('later invocation bytes') },
      ],
    };
    await setProjectFiles(project.id, {
      files: [{
        path: psdPath,
        name: path.basename(psdPath),
        ext: '.psd',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    await getProject(project.id);
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    const persistedBefore = structuredClone({
      files: stored.files,
      pendingFiles: stored.pendingFiles,
      liveEvidenceLedger: stored.liveEvidenceLedger,
      provenance: stored.provenance,
    });
    let extractionWriteCount = 0;
    fs.promises.writeFile = async function failAfterLaterPsdExtractionWrite(filePath, ...args) {
      if (path.dirname(path.resolve(filePath)) === path.resolve(extractDir)) {
        extractionWriteCount++;
        await originalWriteFile.call(fs.promises, filePath, ...args);
        if (extractionWriteCount === 2) throw new Error('forced later PSD extraction write error');
        return;
      }
      return originalWriteFile.call(fs.promises, filePath, ...args);
    };

    testRendererEvents.length = 0;
    const result = await callIpc('projects:pre-package-scan', project.id);

    assert.equal(result.newCount, 0);
    assert.deepEqual(fs.readdirSync(extractDir), [path.basename(sentinelPath)]);
    assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'unrelated bytes');
    assert.deepEqual({
      files: stored.files,
      pendingFiles: stored.pendingFiles,
      liveEvidenceLedger: stored.liveEvidenceLedger,
      provenance: stored.provenance,
    }, persistedBefore);
    assert.equal(JSON.stringify(testRendererEvents).includes(extractDir), false);
  } finally {
    fs.promises.writeFile = originalWriteFile;
    if (extractDir) fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('multi-asset PSD extraction partial commit error cleans final and staged output', async () => {
  const tmpRoot = makeTempDir();
  const originalUnlinkSync = fs.unlinkSync;
  let extractDir = null;
  try {
    setChildProcessHandler(() => ({ stdout: '' }));
    const project = await createProject('PSD extraction partial commit error');
    const psdPath = path.join(tmpRoot, 'partial-commit-error.psd');
    extractDir = path.join(os.tmpdir(), `crate-psd-extract-${project.id}`);
    const sentinelPath = path.join(extractDir, 'pre-existing-unrelated.txt');
    fs.writeFileSync(psdPath, 'psd bytes');
    fs.mkdirSync(extractDir, { recursive: true });
    fs.writeFileSync(sentinelPath, 'unrelated bytes');
    currentPsdFixture = {
      children: [],
      linkedFiles: [
        { name: 'earlier.png', data: Buffer.from('earlier invocation bytes') },
        { name: 'later.png', data: Buffer.from('later invocation bytes') },
      ],
    };
    await setProjectFiles(project.id, {
      files: [{
        path: psdPath,
        name: path.basename(psdPath),
        ext: '.psd',
        addedAt: Date.now(),
        source: 'manual-browse',
      }],
    });
    await getProject(project.id);
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    const persistedBefore = structuredClone({
      files: stored.files,
      pendingFiles: stored.pendingFiles,
      liveEvidenceLedger: stored.liveEvidenceLedger,
      provenance: stored.provenance,
    });
    let committedTempUnlinkCount = 0;
    let failedLaterCommitUnlink = false;
    fs.unlinkSync = function failLaterCommittedTempUnlink(filePath, ...args) {
      const isExtractionTemp = path.dirname(path.resolve(filePath)) === path.resolve(extractDir)
        && path.basename(filePath).startsWith('.')
        && path.basename(filePath).includes('.tmp');
      if (isExtractionTemp && !failedLaterCommitUnlink && ++committedTempUnlinkCount === 2) {
        failedLaterCommitUnlink = true;
        throw new Error('forced later PSD committed temp unlink error');
      }
      return originalUnlinkSync.call(fs, filePath, ...args);
    };

    testRendererEvents.length = 0;
    const result = await callIpc('projects:pre-package-scan', project.id);

    assert.equal(result.newCount, 0);
    assert.equal(failedLaterCommitUnlink, true);
    assert.deepEqual(fs.readdirSync(extractDir), [path.basename(sentinelPath)]);
    assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'unrelated bytes');
    assert.deepEqual({
      files: stored.files,
      pendingFiles: stored.pendingFiles,
      liveEvidenceLedger: stored.liveEvidenceLedger,
      provenance: stored.provenance,
    }, persistedBefore);
    assert.equal(JSON.stringify(testRendererEvents).includes(extractDir), false);
  } finally {
    fs.unlinkSync = originalUnlinkSync;
    if (extractDir) fs.rmSync(extractDir, { recursive: true, force: true });
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

    currentPsdFixture = { children: [], linkedFiles: [] };
    await emitWatcher('change', psdPath);
    fresh = await waitForProject(
      project.id,
      item => item.files.every(file => file.source !== 'scan-on-save-embedded')
    );
    assert.equal(fresh.files.some(file => file.source === 'scan-on-save-embedded'), false);

    currentPsdFixture = {
      children: [],
      linkedFiles: [{ name: 'embedded-logo.png', data: Buffer.from('recovered embedded bytes') }],
    };
    await emitWatcher('change', psdPath);
    fresh = await waitForProject(
      project.id,
      item => item.files.some(file => file.source === 'scan-on-save-embedded')
    );
    assert.equal(fresh.files.filter(file => file.source === 'scan-on-save-embedded').length, 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Added While Working embedded PSD exclusion survives regenerated file IDs on rescan', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('PSD embedded asset exclusion');
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
    assert.equal(embeddedEntry.assetOrigin, 'added');
    assert.equal(typeof embeddedEntry.fileId, 'string');

    await callIpcRaw('projects:remove-file', project.id, embeddedEntry.fileId);
    fresh = await getProject(project.id);
    assert.equal(fresh.files.filter(file => file.source === 'scan-on-save-embedded').length, 1);
    assert.equal(fresh.excludedAssetKeys.length, 1);
    assert.notEqual(fresh.excludedAssetKeys[0], embeddedEntry.fileId);
    let workspace = await callIpcRaw('projects:get-asset-workspace', project.id);
    assert.equal(workspace.files.find(file => file.name === 'embedded-logo.png').excluded, true);

    await emitWatcher('change', psdPath);
    await new Promise(resolve => originalSetTimeout(resolve, 2300));
    fresh = await getProject(project.id);
    assert.equal(fresh.files.filter(file => file.source === 'scan-on-save-embedded').length, 1);
    assert.equal(fresh.pendingFiles.some(file => file.source === 'scan-on-save-embedded'), false);
    workspace = await callIpcRaw('projects:get-asset-workspace', project.id);
    assert.equal(workspace.files.filter(file => file.name === 'embedded-logo.png').length, 1);
    assert.equal(workspace.files.find(file => file.name === 'embedded-logo.png').excluded, true);

    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.deepEqual(review.files.map(file => file.name), ['source.psd']);
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
