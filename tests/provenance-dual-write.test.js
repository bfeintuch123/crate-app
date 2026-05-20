const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify: nodePromisify } = require('util');

const {
  NODE_TYPES,
  EDGE_TYPES,
  OBSERVER_KINDS,
  CONFIDENCE_BANDS,
} = require('../provenance');

const originalSetInterval = global.setInterval;
const originalClearInterval = global.clearInterval;
const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;
const originalHomedir = os.homedir;
const TEST_HOME = path.join(os.tmpdir(), 'crate-provenance-dual-write-home');
const activeIntervals = new Set();
const activeTimeouts = new Set();

fs.rmSync(TEST_HOME, { recursive: true, force: true });
fs.mkdirSync(path.join(TEST_HOME, 'Desktop'), { recursive: true });
fs.mkdirSync(path.join(TEST_HOME, 'Documents'), { recursive: true });
fs.mkdirSync(path.join(TEST_HOME, 'Downloads'), { recursive: true });
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
    getPath: () => path.join(os.tmpdir(), 'crate-provenance-dual-write-userdata'),
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

const watcherRecords = [];
setStub('chokidar', () => ({
  watch: () => {
    const handlers = {};
    const watcher = {
      on(eventName, handler) {
        handlers[eventName] = handler;
        return watcher;
      },
      close() {},
      add() {},
      unwatch() {},
    };
    watcherRecords.push({ handlers });
    return watcher;
  },
}));

setStub('node-fetch', () => async () => ({ ok: false, status: 500, json: async () => ({}) }));

let childProcessHandler = null;

function setChildProcessHandler(handler) {
  childProcessHandler = handler;
}

function commandText(command, args = []) {
  return [command, ...(Array.isArray(args) ? args : [])].join(' ');
}

function getChildProcessResult(kind, command, args = []) {
  if (!childProcessHandler) return { stdout: '', stderr: '' };
  return childProcessHandler({
    kind,
    command,
    args: Array.isArray(args) ? args : [],
    commandText: commandText(command, args),
  }) || { stdout: '', stderr: '' };
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
  const callback = args.find(arg => typeof arg === 'function');
  const result = getChildProcessResult('execFile', command, fileArgs);
  if (callback) {
    queueMicrotask(() => callback(result.error || null, result.stdout || '', result.stderr || ''));
  }
  return createChildProcessStub();
}
execFileStub[nodePromisify.custom] = async (command, fileArgs = []) => {
  const result = getChildProcessResult('execFile', command, fileArgs);
  if (result.error) throw result.error;
  return { stdout: result.stdout || '', stderr: result.stderr || '' };
};

setStub('child_process', () => ({
  execSync: () => '',
  execFileSync: () => '',
  exec: execStub,
  execFile: execFileStub,
}));

let currentPsdFixture = { children: [], linkedFiles: [] };
setStub('ag-psd', () => ({ readPsd: () => currentPsdFixture }));
setStub('uuid', () => ({ v4: () => `dual-write-project-${watcherRecords.length + 1}` }));

require(path.resolve(__dirname, '..', 'main.js'));

async function callIpc(channel, ...args) {
  const handler = ipcHandlers.get(channel);
  if (!handler) throw new Error(`No IPC handler registered for ${channel}`);
  return handler({}, ...args);
}

async function createProject(name = 'Provenance Dual Write') {
  return callIpc('projects:create', name, 'branding', 'current-page', null);
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

function latestWatcherHandlers() {
  const record = watcherRecords[watcherRecords.length - 1];
  assert.ok(record, 'expected chokidar watcher to be created');
  return record.handlers;
}

async function emitWatcher(eventName, filePath) {
  const handler = latestWatcherHandlers()[eventName];
  assert.equal(typeof handler, 'function', `expected ${eventName} watcher handler`);
  await handler(filePath);
}

function manualDialogFor(filePaths) {
  nextOpenDialogResult = { canceled: false, filePaths };
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

async function setProjectFiles(projectId, { files = [], pendingFiles = [] } = {}) {
  const projects = await callIpc('projects:get-all');
  const project = projects.find(item => item.id === projectId);
  assert.ok(project, 'expected project to exist');
  project.files = files;
  project.pendingFiles = pendingFiles;
  return project;
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crate-provenance-parser-'));
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
  nextOpenDialogResult = { canceled: true };
  currentPsdFixture = { children: [], linkedFiles: [] };
  if (storeInstance) storeInstance.set('projects', []);
  watcherRecords.length = 0;
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

test('manual add preserves file ledger entry and records one session observation', async () => {
  const project = await createProject('Manual provenance');
  const filePath = path.join(os.tmpdir(), 'brand-logo.ai');

  manualDialogFor([filePath]);
  const files = await callIpc('projects:add-files', project.id);

  assert.equal(files.length, 1);
  assert.deepEqual(Object.keys(files[0]).sort(), ['addedAt', 'ext', 'name', 'path', 'source']);
  assert.equal(files[0].path, filePath);
  assert.equal(files[0].name, 'brand-logo.ai');
  assert.equal(files[0].ext, '.ai');
  assert.equal(files[0].source, 'manual-browse');

  const fresh = await getProject(project.id);
  assertSessionObservedFile(
    fresh,
    OBSERVER_KINDS.MANUAL_USER_ACTION,
    'projects:add-files',
    CONFIDENCE_BANDS.CONFIRMED
  );
});

test('duplicate manual add does not duplicate session observations', async () => {
  const project = await createProject('Duplicate manual provenance');
  const filePath = path.join(os.tmpdir(), 'duplicate-logo.ai');

  manualDialogFor([filePath]);
  await callIpc('projects:add-files', project.id);
  manualDialogFor([filePath]);
  await callIpc('projects:add-files', project.id);

  const fresh = await getProject(project.id);
  assert.equal(fresh.files.length, 1);
  assert.equal(fresh.provenance.observations.length, 1);
});

test('accept pending preserves file ledger entry and records one confirmed session observation', async () => {
  const project = await createProject('Accept pending provenance');
  const filePath = path.join(os.tmpdir(), 'accepted-pending.ai');
  const pendingFile = makePendingFile(filePath);
  await setProjectFiles(project.id, { pendingFiles: [pendingFile] });

  const result = await callIpc('projects:accept-pending', project.id, filePath);

  assert.equal(result.files.length, 1);
  assert.deepEqual(result.files[0], pendingFile);
  assert.deepEqual(result.pendingFiles, []);

  const fresh = await getProject(project.id);
  assert.deepEqual(fresh.files, [pendingFile]);
  assert.deepEqual(fresh.pendingFiles, []);
  assertSessionObservedFile(
    fresh,
    OBSERVER_KINDS.MANUAL_USER_ACTION,
    'projects:accept-pending',
    CONFIDENCE_BANDS.CONFIRMED
  );
});

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
  const alreadyPresentFile = makePendingFile(alreadyPresentPath);
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
  manualDialogFor([filePath]);
  const files = await callIpc('projects:add-files', project.id);

  assert.equal(files.length, 1);
  assert.equal(files[0].path, filePath);
  const fresh = await getProject(project.id);
  assert.equal(fresh.files.length, 1);
});

test('chokidar add records session observation only after primary design file add succeeds', async () => {
  const project = await createProject('Chokidar add provenance');
  const filePath = path.join(os.tmpdir(), 'layout.psd');

  await emitWatcher('add', filePath);
  await emitWatcher('add', filePath);

  const fresh = await getProject(project.id);
  assert.equal(fresh.files.length, 1);
  assert.equal(fresh.files[0].path, filePath);
  assert.equal(fresh.files[0].ext, '.psd');
  assertSessionObservedFile(
    fresh,
    OBSERVER_KINDS.CHOKIDAR,
    'add',
    CONFIDENCE_BANDS.CANDIDATE
  );
});

test('chokidar change records observation only for a previously unseen primary design file', async () => {
  const project = await createProject('Chokidar change provenance');
  const filePath = path.join(os.tmpdir(), 'identity.ai');

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

test('initial lsof snapshot records sanitized app process provenance for accepted lsof file', async () => {
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

  assert.equal(fresh.files.length, 1);
  assert.equal(fresh.files[0].path, filePath);
  assert.equal(fresh.files[0].source, 'lsof');

  const appNodes = getProvenanceNodes(fresh, NODE_TYPES.APP);
  const processNodes = getProvenanceNodes(fresh, NODE_TYPES.APP_PROCESS);
  const sessionObservations = getProvenanceObservations(fresh, EDGE_TYPES.SESSION_OBSERVED_FILE);
  const appOpenedObservations = getProvenanceObservations(fresh, EDGE_TYPES.APP_OPENED_FILE);

  assert.equal(appNodes.length, 1);
  assert.equal(appNodes[0].name, 'Adobe Photoshop');
  assert.equal(appNodes[0].appFamily, 'photoshop');
  assert.equal(processNodes.length, 1);
  assert.equal(processNodes[0].pid, 123);
  assert.equal(processNodes[0].appName, 'Adobe Photoshop');
  assert.equal(processNodes[0].appFamily, 'photoshop');
  assert.equal(processNodes[0].method, 'initial-snapshot');
  assert.equal(sessionObservations.length, 1);
  assert.equal(sessionObservations[0].observer.kind, OBSERVER_KINDS.LSOF);
  assert.equal(sessionObservations[0].observer.method, 'initial-snapshot');
  assert.equal(appOpenedObservations.length, 1);
  assert.equal(appOpenedObservations[0].subjectNodeId, processNodes[0].id);
  assert.equal(appOpenedObservations[0].observer.kind, OBSERVER_KINDS.LSOF);
  assert.equal(appOpenedObservations[0].observer.method, 'initial-snapshot');
  assert.equal(appOpenedObservations[0].confidence.band, CONFIDENCE_BANDS.CANDIDATE);

  const provenanceText = JSON.stringify(fresh.provenance);
  assert.equal(provenanceText.includes('SHOULD_NOT_APPEAR_PROCESS_ARG'), false);
  assert.equal(provenanceText.includes('/Applications/Adobe Photoshop.app'), false);
  assert.equal(provenanceText.includes('raw'), false);
  assert.equal(provenanceText.includes('stdout'), false);
});

test('ongoing lsof poll records sanitized app process provenance for newly accepted lsof file', async () => {
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

  const fresh = await waitForProject(project.id, item => item.files.length === 1);
  assert.equal(fresh.files[0].path, filePath);
  assert.equal(fresh.files[0].source, 'lsof');

  const appNodes = getProvenanceNodes(fresh, NODE_TYPES.APP);
  const processNodes = getProvenanceNodes(fresh, NODE_TYPES.APP_PROCESS);
  const appOpenedObservations = getProvenanceObservations(fresh, EDGE_TYPES.APP_OPENED_FILE);

  assert.equal(appNodes.length, 1);
  assert.equal(appNodes[0].name, 'Figma');
  assert.equal(appNodes[0].appFamily, 'figma');
  assert.equal(processNodes.length, 1);
  assert.equal(processNodes[0].pid, 456);
  assert.equal(processNodes[0].method, 'poll');
  assert.equal(appOpenedObservations.length, 1);
  assert.equal(appOpenedObservations[0].observer.method, 'poll');
  assert.equal(appOpenedObservations[0].confidence.band, CONFIDENCE_BANDS.CANDIDATE);
  assert.equal(JSON.stringify(fresh.provenance).includes('SHOULD_NOT_APPEAR_PROCESS_ARG'), false);
});

test('repeated lsof observations for the same accepted file are deduped', async () => {
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

  assert.equal(fresh.files.length, 1);
  assert.equal(getProvenanceObservations(fresh, EDGE_TYPES.SESSION_OBSERVED_FILE).length, 1);
  assert.equal(getProvenanceObservations(fresh, EDGE_TYPES.APP_OPENED_FILE).length, 1);
  assert.equal(getProvenanceNodes(fresh, NODE_TYPES.APP_PROCESS).length, 1);
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

test('lsof provenance failure does not block ledger capture', async () => {
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

  const fresh = await waitForProject(project.id, item => item.files.length === 1);
  assert.equal(fresh.files[0].path, filePath);
  assert.equal(fresh.files[0].source, 'lsof');
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
