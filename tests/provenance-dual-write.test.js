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
  PROVENANCE_SCHEMA_VERSION,
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

function isOsascriptInvocation({ kind, command, args }, scriptName) {
  return kind === 'execFile' &&
    command === '/usr/bin/osascript' &&
    Array.isArray(args) &&
    args.length === 1 &&
    path.basename(args[0]) === scriptName;
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

function setPresentationUnzipFixture(mediaEntries, archiveName = 'deck.pptx') {
  const byInternalPath = new Map(mediaEntries.map(entry => [entry.internalPath, entry]));
  setChildProcessHandler(({ kind, command, args }) => {
    if (kind !== 'execFile' || command !== '/usr/bin/unzip') return { stdout: '', stderr: '' };
    if (args[0] === '-l') {
      const lines = mediaEntries.map(entry => {
        const size = entry.data.length;
        return `      ${size}  05-26-2026 12:34   ${entry.internalPath}`;
      });
      return { stdout: [`Archive: ${archiveName}`, ...lines, ''].join('\n'), stderr: '' };
    }
    if (args[0] === '-p') {
      const entry = byInternalPath.get(args[2]);
      return { stdout: entry ? entry.data : Buffer.alloc(0), stderr: '' };
    }
    return { stdout: '', stderr: '' };
  });
}

function setPowerPointUnzipFixture(mediaEntries) {
  setPresentationUnzipFixture(mediaEntries, 'deck.pptx');
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
  nextOpenDialogResult = { canceled: true };
  currentPsdFixture = { children: [], linkedFiles: [] };
  if (storeInstance) storeInstance.set('projects', []);
  if (storeInstance) storeInstance.set('settings.includeDiagnosticReport', false);
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

test('PowerPoint scan-on-save extraction records media provenance without ledger metadata leak', async () => {
  const tmpRoot = makeTempDir();
  try {
    const project = await createProject('PowerPoint Scan Save Provenance');
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
      data: Buffer.from('JPEG_BINARY_SHOULD_NOT_LEAK'.repeat(40)),
    }]);

    await emitWatcher('change', pptxPath);
    let fresh = await waitForProject(
      project.id,
      item => item.files.some(file => file.source === 'scan-on-save-presentation'),
      5000
    );
    const extracted = fresh.files.find(file => file.source === 'scan-on-save-presentation');
    assert.ok(extracted);
    assert.deepEqual(Object.keys(extracted).sort(), ['addedAt', 'ext', 'name', 'path', 'source']);
    assert.equal(extracted.name, 'Deck — image1.jpeg');
    assert.equal(fs.readFileSync(extracted.path, 'utf8'), 'JPEG_BINARY_SHOULD_NOT_LEAK'.repeat(40));
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
    assert.equal(manifest.schemaVersion, PROVENANCE_SCHEMA_VERSION);
    assert.equal(manifest.package.copiedCount, 1);
    assert.equal(manifest.package.embeddedCount, 2);
    assert.equal(manifest.package.totalFiles, 1);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 1);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE).length, 2);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 2);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE).length, 2);
    const manifestText = JSON.stringify(manifest);
    assert.equal(manifestText.includes('ppt/media/image1.jpeg'), true);
    assert.equal(manifestText.includes('Deck — image1.jpeg'), true);
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
    const project = await createProject('Keynote Scan Save Provenance');
    const keynotePath = path.join(tmpRoot, 'Deck.key');
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
      data: Buffer.from('KEYNOTE_JPEG_BINARY_SHOULD_NOT_LEAK'.repeat(40)),
    }]);

    await emitWatcher('change', keynotePath);
    let fresh = await waitForProject(
      project.id,
      item => item.files.some(file => file.source === 'scan-on-save-presentation'),
      5000
    );
    const extracted = fresh.files.find(file => file.source === 'scan-on-save-presentation');
    assert.ok(extracted);
    assert.deepEqual(Object.keys(extracted).sort(), ['addedAt', 'ext', 'name', 'path', 'source']);
    assert.equal(extracted.name, 'Deck — photo.jpeg');
    assert.equal(fs.readFileSync(extracted.path, 'utf8'), 'KEYNOTE_JPEG_BINARY_SHOULD_NOT_LEAK'.repeat(40));
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
    assert.equal(manifest.schemaVersion, PROVENANCE_SCHEMA_VERSION);
    assert.equal(manifest.package.copiedCount, 1);
    assert.equal(manifest.package.embeddedCount, 2);
    assert.equal(manifest.package.totalFiles, 1);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.PACKAGE_INCLUDES_FILE).length, 1);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE).length, 2);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE).length, 2);
    assert.equal(manifest.edges.filter(edge => edge.relationType === EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE).length, 2);
    const manifestText = JSON.stringify(manifest);
    assert.equal(manifestText.includes('Data/photo-1234.jpeg'), true);
    assert.equal(manifestText.includes('Deck — photo.jpeg'), true);
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

test('ps-poll accepted insertion records one session observation', async () => {
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
    const fresh = await waitForProject(project.id, item => item.files.length === 1);
    assert.equal(fresh.files[0].path, filePath);
    assert.equal(fresh.files[0].source, 'ps-poll');

    const observations = getSessionObservedByMethod(fresh, 'ps-poll');
    assert.equal(observations.length, 1);
    assert.equal(observations[0].kind, EDGE_TYPES.SESSION_OBSERVED_FILE);
    assert.equal(observations[0].observer.kind, OBSERVER_KINDS.APP_SCRIPT);
    assert.equal(observations[0].confidence.band, CONFIDENCE_BANDS.CANDIDATE);
    assert.deepEqual(observations[0].payload, {
      source: 'ps-poll',
      method: 'ps-poll',
      channel: 'live-app-poll',
    });
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
  } finally {
    fs.promises.writeFile = originalWriteFile;
    fs.rmSync(sentinelDir, { recursive: true, force: true });
  }
});

test('indd-poll accepted insertion records one session observation', async () => {
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
  const fresh = await waitForProject(project.id, item => item.files.length === 1);
  assert.equal(fresh.files[0].path, filePath);
  assert.equal(fresh.files[0].source, 'indd-poll');

  const observations = getSessionObservedByMethod(fresh, 'indd-poll');
  assert.equal(observations.length, 1);
  assert.equal(observations[0].kind, EDGE_TYPES.SESSION_OBSERVED_FILE);
  assert.equal(observations[0].observer.kind, OBSERVER_KINDS.APP_SCRIPT);
  assert.equal(observations[0].confidence.band, CONFIDENCE_BANDS.CANDIDATE);
  assert.deepEqual(observations[0].payload, {
    source: 'indd-poll',
    method: 'indd-poll',
    channel: 'live-app-poll',
  });
  assert.deepEqual(fresh.provenance.edges, {});
  assert.equal(getProvenanceObservations(fresh, EDGE_TYPES.APP_OPENED_FILE).length, 0);
  assert.equal(JSON.stringify(fresh.provenance).includes('SHOULD_NOT_APPEAR_PROCESS_ARG'), false);
  for (const dir of osascriptDirs) {
    assert.equal(fs.existsSync(dir), false);
  }
});

test('repeated ps-poll insertion does not duplicate session observations', async () => {
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
  let fresh = await waitForProject(project.id, item => item.files.length === 1);
  assert.equal(getSessionObservedByMethod(fresh, 'ps-poll').length, 1);

  await new Promise(resolve => originalSetTimeout(resolve, 3300));
  fresh = await getProject(project.id);
  assert.equal(fresh.files.filter(file => file.path === filePath).length, 1);
  assert.equal(getSessionObservedByMethod(fresh, 'ps-poll').length, 1);
});

test('ps-poll provenance failure does not block ledger insertion', async () => {
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

  const fresh = await waitForProject(project.id, item => item.files.length === 1, 5000);
  assert.equal(fresh.files[0].path, filePath);
  assert.equal(fresh.files[0].source, 'ps-poll');
});

test('lastused-poll accepted insertion records one deduped candidate session observation', async () => {
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
    item => item.files.some(file => file.source === 'lastused-poll'),
    12000
  );
  assert.equal(fresh.files.filter(file => file.path === filePath).length, 1);

  let observations = getSessionObservedByMethod(fresh, 'lastused-poll');
  assert.equal(observations.length, 1);
  assert.equal(observations[0].observer.kind, OBSERVER_KINDS.SPOTLIGHT_LAST_USED);
  assert.equal(observations[0].confidence.band, CONFIDENCE_BANDS.CANDIDATE);
  assert.deepEqual(observations[0].payload, {
    source: 'lastused-poll',
    method: 'lastused-poll',
    channel: 'live-lastused-poll',
  });
  assertNoRelationshipEdges(fresh);
  assertProvenanceTextExcludes(fresh, [
    'SHOULD_NOT_APPEAR_PROCESS_ARG',
    '/usr/bin/mdfind',
    'stdout',
  ]);

  await new Promise(resolve => originalSetTimeout(resolve, 10500));
  fresh = await getProject(project.id);
  observations = getSessionObservedByMethod(fresh, 'lastused-poll');
  assert.equal(fresh.files.filter(file => file.path === filePath).length, 1);
  assert.equal(observations.length, 1);
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

    setChildProcessHandler(({ kind, command }) => {
      if (kind === 'exec' && command.startsWith('/bin/ps ax')) {
        return { stdout: '222 /Applications/Adobe Illustrator.app/Contents/MacOS/Adobe Illustrator --secret SHOULD_NOT_APPEAR_PROCESS_ARG\n' };
      }
      if (kind === 'exec' && command.startsWith('/usr/sbin/lsof')) {
        return { stdout: `p222\nf12\ntREG\nn${sourcePath}\n` };
      }
      return { stdout: '' };
    });

    const project = await createProject('Scan open linked provenance');
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
      'SHOULD_NOT_APPEAR_PROCESS_ARG',
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

    setChildProcessHandler(({ kind, command }) => {
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

test('initial snapshot linked-asset regex accepted insertion records candidate session observation only', async () => {
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
    const fresh = await waitForProject(
      project.id,
      item => item.files.some(file => file.path === linkedPath && file.source === 'linked-asset'),
      5000
    );

    const observations = getSessionObservedByMethod(fresh, 'initial-snapshot-linked-regex');
    assert.equal(observations.length, 1);
    assert.equal(observations[0].observer.kind, OBSERVER_KINDS.PARSER);
    assert.equal(observations[0].confidence.band, CONFIDENCE_BANDS.CANDIDATE);
    assert.deepEqual(observations[0].payload, {
      source: 'linked-asset',
      method: 'initial-snapshot-linked-regex',
      channel: 'initial-lsof-snapshot',
    });
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

test('pre-package lsof package scan insertion records one deduped session observation', async () => {
  resetTestHomeWorkspace();
  const project = await createProject('Prepackage lsof provenance');
  const figPath = path.join(TEST_HOME, 'Desktop', 'package-open.fig');
  fs.writeFileSync(figPath, 'fig bytes');

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
  assert.equal(scan.newCount, 1);

  let fresh = await getProject(project.id);
  assert.equal(fresh.files.length, 1);
  assert.equal(fresh.files[0].source, 'lsof-package-scan');

  const observations = getSessionObservedByMethod(fresh, 'lsof-package-scan');
  assert.equal(observations.length, 1);
  assert.equal(observations[0].observer.kind, OBSERVER_KINDS.PACKAGE_RECOVERY);
  assert.equal(Object.prototype.hasOwnProperty.call(observations[0].observer, 'payload'), false);
  assert.equal(observations[0].confidence.band, CONFIDENCE_BANDS.CANDIDATE);
  assert.deepEqual(observations[0].payload, {
    source: 'lsof-package-scan',
    method: 'lsof-package-scan',
    channel: 'pre-package-scan',
    recoveryType: 'package-time-recovery',
  });
  assert.equal(getProvenanceNodes(fresh, NODE_TYPES.APP_PROCESS).length, 0);
  assert.deepEqual(fresh.provenance.edges, {});

  await callIpc('projects:pre-package-scan', project.id);
  fresh = await getProject(project.id);
  assert.equal(fresh.files.length, 1);
  assert.equal(getSessionObservedByMethod(fresh, 'lsof-package-scan').length, 1);
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
  assert.equal(scan.newCount, 1);

  const fresh = await getProject(project.id);
  assert.equal(fresh.files.length, 1);
  assert.equal(fresh.files[0].path, targetPath);
  assert.equal(getSessionObservedByMethod(fresh, 'lsof-package-scan').length, 0);
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
      if (kind === 'exec' && command.includes("grep -i 'Adobe Illustrator'")) {
        return { stdout: '/Applications/Adobe Illustrator.app/Contents/MacOS/Adobe Illustrator\n' };
      }
      if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-scan.applescript')) {
        assertPrivateTempScriptPath(args[0]);
        assert.equal(commandText.includes('tell application'), false);
        return { stdout: `${scriptLinkedPath}\n` };
      }
      return { stdout: '' };
    });

    const scan = await callIpc('projects:pre-package-scan', project.id);
    assert.equal(scan.newCount, 3);

    let fresh = await getProject(project.id);
    assert.equal(fresh.files.some(file => file.source === 'ai-linked'), true);
    assert.equal(fresh.files.some(file => file.source === 'psd-embedded'), true);
    assert.equal(fresh.files.some(file => file.source === 'linked-asset'), true);

    for (const method of ['ai-linked', 'psd-embedded', 'linked-asset']) {
      const observations = getSessionObservedByMethod(fresh, method);
      assert.equal(observations.length, 1);
      assert.equal(observations[0].observer.kind, OBSERVER_KINDS.PACKAGE_RECOVERY);
      assert.equal(Object.prototype.hasOwnProperty.call(observations[0].observer, 'payload'), false);
      assert.equal(observations[0].confidence.band, CONFIDENCE_BANDS.CANDIDATE);
      assert.equal(observations[0].payload.method, method);
      assert.equal(observations[0].payload.channel, 'pre-package-scan');
    }

    const packageResult = await callIpc('projects:package', project.id, outputDir);
    assertPackageResultShape(packageResult);
    assert.equal(packageResult.success, true);
    assert.equal(packageResult.totalFiles, fresh.files.length);
    assert.equal(packageResult.copiedCount, fresh.files.length);
    assert.equal(packageResult.embeddedCount, 0);
    assert.deepEqual(packageResult.errors, []);

    fresh = await getProject(project.id);
    for (const method of ['ai-linked', 'psd-embedded', 'linked-asset']) {
      assert.equal(getSessionObservedByMethod(fresh, method).length, 1);
    }
  } finally {
    fs.rmSync(path.join(os.tmpdir(), `crate-psd-extract-${project ? project.id : ''}`), { recursive: true, force: true });
    fs.rmSync(repoTempRoot, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('pre-package recovery provenance failure does not block recovered file insertion', async () => {
  resetTestHomeWorkspace();
  const project = await createProject('Prepackage provenance failure');
  const figPath = path.join(TEST_HOME, 'Desktop', 'failure-open.fig');
  fs.writeFileSync(figPath, 'fig bytes');
  const storedProject = await getProject(project.id);
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
  assert.equal(scan.newCount, 1);

  const fresh = await getProject(project.id);
  assert.equal(fresh.files.length, 1);
  assert.equal(fresh.files[0].source, 'lsof-package-scan');
});

test('pre-package pending candidates do not create captured-file observations until accepted', async () => {
  resetTestHomeWorkspace();
  const project = await createProject('Prepackage pending provenance');
  const figPath = path.join(TEST_HOME, 'Desktop', 'pending-candidate.fig');
  fs.writeFileSync(figPath, 'fig bytes');

  const scan = await callIpc('projects:pre-package-scan', project.id);
  assert.equal(scan.newCount, 1);

  const fresh = await getProject(project.id);
  assert.deepEqual(fresh.files, []);
  assert.equal(fresh.pendingFiles.length, 1);
  assert.equal(fresh.pendingFiles[0].source, 'fig-scan');
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
