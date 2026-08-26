'use strict';

const { contextBridge } = require('electron');
const {
  SYNTHETIC_FIGMA_SOURCE,
  createUiSmoothnessFixture,
} = require('./ui-smoothness-fixture');

const SYNTHETIC_PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlX8x8AAAAASUVORK5CYII=';
const listeners = new Map();

function readNumberArgument(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find(argument => argument.startsWith(prefix));
  if (!value) return fallback;
  const parsed = Number(value.slice(prefix.length));
  return Number.isFinite(parsed) ? parsed : fallback;
}

let fixture = createUiSmoothnessFixture({
  assetCount: readNumberArgument('crate-smoothness-assets', 30),
  pendingCount: readNumberArgument('crate-smoothness-pending', 0),
  excludedCount: readNumberArgument('crate-smoothness-excluded', 0),
});
let nextSyntheticAsset = fixture.expected.assetCount + 1;
let latencies = {
  read: Math.max(0, readNumberArgument('crate-smoothness-read-latency', 8)),
  action: Math.max(0, readNumberArgument('crate-smoothness-action-latency', 120)),
  visual: Math.max(0, readNumberArgument('crate-smoothness-visual-latency', 2)),
};
let metrics = createMetrics();

function createMetrics() {
  return {
    getProjects: 0,
    getSettings: 0,
    getUsage: 0,
    getAssetWorkspace: 0,
    getFileVisual: 0,
    getFigmaStatus: 0,
    calls: {},
    actions: {},
    events: {},
    emittedEvents: 0,
    visualIdentities: [],
    timeline: [],
  };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function delay(milliseconds) {
  if (!milliseconds) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function record(bucket, name, detail = null) {
  metrics[bucket][name] = (metrics[bucket][name] || 0) + 1;
  if (Object.prototype.hasOwnProperty.call(metrics, name) && typeof metrics[name] === 'number') {
    metrics[name] += 1;
  }
  metrics.timeline.push({
    sequence: metrics.timeline.length + 1,
    bucket,
    name,
    detail: detail === null ? null : clone(detail),
  });
}

async function recordRead(name, value, latency = latencies.read) {
  record('calls', name);
  await delay(latency);
  return clone(typeof value === 'function' ? value() : value);
}

async function recordAction(name, action = () => ({ success: true })) {
  record('actions', name);
  await delay(latencies.action);
  return clone(action());
}

function registerListener(channel, callback) {
  if (typeof callback !== 'function') return;
  const callbacks = listeners.get(channel) || [];
  callbacks.push(callback);
  listeners.set(channel, callbacks);
}

function emit(channel, payload) {
  metrics.emittedEvents += 1;
  metrics.events[channel] = (metrics.events[channel] || 0) + 1;
  metrics.timeline.push({
    sequence: metrics.timeline.length + 1,
    bucket: 'events',
    name: channel,
    detail: clone(payload),
  });
  for (const callback of listeners.get(channel) || []) callback(clone(payload));
}

function replaceProject(project) {
  fixture.project = clone(project);
  fixture.projects = fixture.projects.map(item => item.id === project.id ? clone(project) : item);
  fixture.workspace.projectId = project.id;
  fixture.workspace.files = clone(project.files || []);
  fixture.workspace.pendingFiles = clone(project.pendingFiles || []);
}

function updateProject(mutator) {
  const project = clone(fixture.project);
  mutator(project);
  replaceProject(project);
  return project;
}

function findAssetIndex(visualIdentity) {
  return fixture.project.files.findIndex(file => file.visualIdentity === visualIdentity);
}

function toggleAssetExclusion(visualIdentity) {
  const index = findAssetIndex(visualIdentity);
  if (index < 0) return false;
  updateProject(project => {
    const file = project.files[index];
    file.excluded = file.excluded !== true;
    const keys = new Set(project.excludedAssetKeys || []);
    if (file.excluded) keys.add(visualIdentity);
    else keys.delete(visualIdentity);
    project.excludedAssetKeys = [...keys];
  });
  return true;
}

function createSyntheticAddedAsset(index) {
  const padded = String(index).padStart(4, '0');
  return {
    name: `Synthetic_Smoothness_Asset_${padded}.png`,
    ext: '.png',
    appFamily: 'figma',
    sourceName: SYNTHETIC_FIGMA_SOURCE,
    assetOrigin: 'added',
    projectRole: 'asset',
    protectedSource: false,
    linked: false,
    embedded: false,
    excluded: false,
    visualIdentity: `synthetic-smoothness-visual-${String(index + 100).padStart(4, '0')}`,
    visualRevision: `synthetic-smoothness-revision-${String(index + 100).padStart(4, '0')}`,
  };
}

function appendSyntheticAsset({ emitUpdate = true } = {}) {
  const asset = createSyntheticAddedAsset(nextSyntheticAsset);
  nextSyntheticAsset += 1;
  updateProject(project => {
    project.files.push(clone(asset));
  });
  fixture.expected.assetCount += 1;
  fixture.expected.addedAssets += 1;
  fixture.expected.totalWorkspaceFiles += 1;
  if (emitUpdate) emit('files:updated', { projectId: fixture.project.id, reason: 'synthetic-add' });
  return clone(asset);
}

function reviseSyntheticAsset(assetIndex = 1, { emitUpdate = true } = {}) {
  const assets = fixture.project.files.filter(file => file.projectRole === 'asset');
  const selected = assets[Math.max(0, Math.min(assets.length - 1, Number(assetIndex) - 1))];
  if (!selected) return null;
  updateProject(project => {
    const file = project.files.find(item => item.visualIdentity === selected.visualIdentity);
    if (!file) return;
    file.visualRevision = `${file.visualRevision}-changed`;
    file.name = file.name.replace(/(\.[^.]+)$/u, ' Updated$1');
  });
  if (emitUpdate) emit('files:updated', { projectId: fixture.project.id, reason: 'synthetic-revision' });
  return fixture.project.files.find(file => file.visualIdentity === selected.visualIdentity) || null;
}

function removeSyntheticAsset(assetIndex = 1, { emitUpdate = true } = {}) {
  const assets = fixture.project.files.filter(file => file.projectRole === 'asset');
  const selected = assets[Math.max(0, Math.min(assets.length - 1, Number(assetIndex) - 1))];
  if (!selected) return null;
  updateProject(project => {
    project.files = project.files.filter(file => file.visualIdentity !== selected.visualIdentity);
    project.excludedAssetKeys = (project.excludedAssetKeys || [])
      .filter(key => key !== selected.visualIdentity);
  });
  fixture.expected.assetCount = Math.max(0, fixture.expected.assetCount - 1);
  if (selected.assetOrigin === 'existing') fixture.expected.existingAssets = Math.max(0, fixture.expected.existingAssets - 1);
  else fixture.expected.addedAssets = Math.max(0, fixture.expected.addedAssets - 1);
  fixture.expected.totalWorkspaceFiles = Math.max(
    fixture.expected.physicalSourceFiles,
    fixture.expected.totalWorkspaceFiles - 1,
  );
  if (emitUpdate) emit('files:updated', { projectId: fixture.project.id, reason: 'synthetic-remove' });
  return clone(selected);
}

function resetFixture(options = {}) {
  fixture = createUiSmoothnessFixture(options);
  nextSyntheticAsset = fixture.expected.assetCount + 1;
  metrics = createMetrics();
  return clone(fixture.expected);
}

contextBridge.exposeInMainWorld('crate', {
  getProjects: () => recordRead('getProjects', () => fixture.projects),
  createProject: () => recordAction('createProject', () => ({ error: 'smoothness_fixture_read_only' })),
  setProjectFigmaLink: (_projectId, payload) => recordAction('setProjectFigmaLink', () => {
    updateProject(project => {
      if (payload?.action === 'remove') project.figmaTrackedFiles = [];
      else if (!project.figmaTrackedFiles?.length) project.figmaTrackedFiles = [{ displayName: SYNTHETIC_FIGMA_SOURCE }];
      if (payload?.scopeMode) project.figmaScopeMode = payload.scopeMode;
    });
    return { success: true };
  }),
  startWatching: projectId => recordAction('startWatching', () => {
    if (projectId === fixture.project.id) updateProject(project => { project.status = 'watching'; });
    return { success: true };
  }),
  pauseProject: projectId => recordAction('pauseProject', () => {
    if (projectId === fixture.project.id) updateProject(project => { project.status = 'paused'; });
    return { success: true };
  }),
  getFiles: () => recordRead('getFiles', () => fixture.project.files),
  getAssetWorkspace: projectId => recordRead(
    'getAssetWorkspace',
    () => projectId === fixture.project.id ? fixture.workspace : null,
  ),
  getFileVisual: async (_projectId, visualIdentity) => {
    record('calls', 'getFileVisual', { visualIdentity });
    if (typeof visualIdentity === 'string') metrics.visualIdentities.push(visualIdentity);
    await delay(latencies.visual);
    return { kind: 'thumbnail', dataUrl: SYNTHETIC_PIXEL };
  },
  setExistingAssetsDecision: (_projectId, decision) => recordAction('setExistingAssetsDecision', () => {
    updateProject(project => {
      project.assetBaseline = { status: 'included' };
      const keys = new Set(project.excludedAssetKeys || []);
      for (const file of project.files) {
        if (file.projectRole === 'source' || file.assetOrigin !== 'existing') continue;
        file.excluded = decision === 'skip';
        if (file.excluded) keys.add(file.visualIdentity);
        else keys.delete(file.visualIdentity);
      }
      project.excludedAssetKeys = [...keys];
    });
    return { success: true };
  }),
  removeFile: (_projectId, visualIdentity) => recordAction('removeFile', () => ({
    success: toggleAssetExclusion(visualIdentity),
  })),
  addFiles: () => recordAction('addFiles', () => []),
  preparePackageReview: () => recordAction('preparePackageReview', () => {
    const excluded = new Set(fixture.project.excludedAssetKeys || []);
    const files = fixture.workspace.files.filter(file => (
      file.excluded !== true && !excluded.has(file.visualIdentity)
    ));
    return {
      projectId: fixture.project.id,
      token: 'synthetic-review-reference',
      materializable: true,
      files: clone(files),
      folderName: 'Synthetic_Smoothness_Package',
      planSummary: { outputLayoutMode: fixture.settings.packageOutputLayoutMode || 'flat' },
    };
  }),
  packageProject: () => recordAction('packageProject', () => ({
    success: true,
    outputDir: 'Synthetic package output',
    totalFiles: fixture.workspace.files.length,
  })),
  selectOutputFolder: () => recordAction('selectOutputFolder', () => null),
  deleteProject: () => recordAction('deleteProject', () => ({ success: true })),
  deleteAllProjects: () => recordAction('deleteAllProjects', () => ({ success: true })),
  getSettings: () => recordRead('getSettings', () => fixture.settings),
  updateSetting: (key, value) => recordAction('updateSetting', () => {
    fixture.settings[key] = value;
    return fixture.settings;
  }),
  getUsage: () => recordRead('getUsage', () => fixture.usage),
  openFolder: () => recordAction('openFolder', () => ''),
  keepWatching: () => recordAction('keepWatching', () => ({ success: true })),
  inactivityPause: () => recordAction('inactivityPause', () => ({ success: true })),
  preScanSession: () => recordAction('preScanSession', () => ({ success: true, filesFound: 0 })),
  acceptPending: (_projectId, visualIdentity) => recordAction('acceptPending', () => {
    updateProject(project => {
      const index = project.pendingFiles.findIndex(file => file.visualIdentity === visualIdentity);
      if (index < 0) return;
      const [file] = project.pendingFiles.splice(index, 1);
      file.captureState = 'ready';
      project.files.push(file);
    });
    return { success: true };
  }),
  rejectPending: (_projectId, visualIdentity) => recordAction('rejectPending', () => {
    updateProject(project => {
      project.pendingFiles = project.pendingFiles.filter(file => file.visualIdentity !== visualIdentity);
    });
    return { success: true };
  }),
  v2BrowseFile: () => recordAction('v2BrowseFile', () => null),
  v2PackageFile: () => recordAction('v2PackageFile', () => ({ error: 'smoothness_fixture_read_only' })),
  v2PackageDroppedFile: () => recordAction('v2PackageDroppedFile', () => ({ error: 'smoothness_fixture_read_only' })),
  getFigmaStatus: () => recordRead('getFigmaStatus', () => fixture.figmaStatus),
  connectFigma: () => recordAction('connectFigma', () => ({ success: true })),
  disconnectFigma: () => recordAction('disconnectFigma', () => ({ success: true })),
  scanFigmaProject: () => recordAction('scanFigmaProject', () => ({ triggered: 0 })),
  getFigmaProjectAssets: () => recordRead('getFigmaProjectAssets', []),
  figmaScanNow: () => recordAction('figmaScanNow', () => ({ triggered: 0, skipped: 0, inFlight: false })),
  reportRendererScriptEntered: () => {},
  reportRendererInitEntered: () => {},
  reportRendererStartupDataComplete: () => {},
  reportRendererStartupDataFailed: () => {},
  reportRendererFirstRenderComplete: () => {},
  reportRendererFirstFrame: () => {},
  onFilesUpdated: callback => registerListener('files:updated', callback),
  onProjectUpdated: callback => registerListener('project:updated', callback),
  onPackageTrigger: callback => registerListener('package:trigger', callback),
  onPendingFilesUpdated: callback => registerListener('files:pending', callback),
  onFigmaAuthError: callback => registerListener('figma:auth-error', callback),
  onFigmaScanStarted: callback => registerListener('figma:scan-started', callback),
  onFigmaScanComplete: callback => registerListener('figma:scan-complete', callback),
  onFigmaScanError: callback => registerListener('figma:scan-error', callback),
});

contextBridge.exposeInMainWorld('crateSmoothnessHarness', {
  getExpected: () => clone(fixture.expected),
  getFixtureSnapshot: () => clone(fixture),
  getMetrics: () => clone(metrics),
  resetMetrics: () => {
    metrics = createMetrics();
    return clone(metrics);
  },
  resetFixture,
  setLatencies: next => {
    latencies = {
      read: Math.max(0, Number(next?.read) || 0),
      action: Math.max(0, Number(next?.action) || 0),
      visual: Math.max(0, Number(next?.visual) || 0),
    };
    return clone(latencies);
  },
  appendSyntheticAsset,
  reviseSyntheticAsset,
  removeSyntheticAsset,
  toggleAssetExclusion,
  emitFilesUpdated: reason => emit('files:updated', {
    projectId: fixture.project.id,
    reason: reason || 'synthetic-update',
  }),
  emitProjectUpdated: reason => emit('project:updated', {
    projectId: fixture.project.id,
    reason: reason || 'synthetic-project-update',
  }),
  emitPendingFilesUpdated: reason => emit('files:pending', {
    projectId: fixture.project.id,
    reason: reason || 'synthetic-pending-update',
  }),
  emitFileBurst: count => {
    const safeCount = Math.max(0, Math.min(100, Number(count) || 0));
    for (let index = 0; index < safeCount; index += 1) {
      emit('files:updated', {
        projectId: fixture.project.id,
        reason: `synthetic-burst-${index + 1}`,
      });
    }
    return safeCount;
  },
});
