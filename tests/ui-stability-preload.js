'use strict';

const { contextBridge } = require('electron');
const { createUiStabilityFixture } = require('./ui-stability-fixture');

const SYNTHETIC_PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlX8x8AAAAASUVORK5CYII=';
const listeners = new Map();
let fixture = createUiStabilityFixture();
let nextSyntheticAsset = 264;
let metrics = createMetrics();

function createMetrics() {
  return {
    getProjects: 0,
    getSettings: 0,
    getUsage: 0,
    getAssetWorkspace: 0,
    getFileVisual: 0,
    emittedEvents: 0,
    visualIdentities: [],
  };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function registerListener(channel, callback) {
  if (typeof callback !== 'function') return;
  const callbacks = listeners.get(channel) || [];
  callbacks.push(callback);
  listeners.set(channel, callbacks);
}

function emit(channel, payload) {
  metrics.emittedEvents += 1;
  for (const callback of listeners.get(channel) || []) {
    callback(clone(payload));
  }
}

function createSyntheticAddedAsset(index) {
  const padded = String(index).padStart(4, '0');
  return {
    name: `Synthetic_Figma_Asset_${padded}.png`,
    ext: '.png',
    appFamily: 'figma',
    sourceName: 'Synthetic Figma Board',
    assetOrigin: 'added',
    projectRole: 'asset',
    protectedSource: false,
    linked: false,
    embedded: false,
    excluded: false,
    visualIdentity: `synthetic-visual-${String(index + 100).padStart(4, '0')}`,
    visualRevision: `synthetic-revision-${String(index + 100).padStart(4, '0')}`,
  };
}

function appendSyntheticAsset() {
  const asset = createSyntheticAddedAsset(nextSyntheticAsset);
  nextSyntheticAsset += 1;
  fixture.project.files.push(clone(asset));
  fixture.workspace.files.push(clone(asset));
  fixture.expected.addedAssets += 1;
  fixture.expected.totalAssets += 1;
  fixture.expected.totalWorkspaceFiles += 1;
  emit('files:updated', { projectId: fixture.project.id, reason: 'synthetic-add' });
  return clone(asset);
}

function resetFixture() {
  fixture = createUiStabilityFixture();
  nextSyntheticAsset = 264;
  metrics = createMetrics();
  return clone(fixture.expected);
}

contextBridge.exposeInMainWorld('crate', {
  getProjects: async () => {
    metrics.getProjects += 1;
    return [clone(fixture.project)];
  },
  createProject: async () => ({ error: 'ui_stability_fixture_read_only' }),
  setProjectFigmaLink: async () => ({ success: true }),
  startWatching: async () => ({ success: true }),
  pauseProject: async () => ({ success: true }),
  getFiles: async () => clone(fixture.project.files),
  getAssetWorkspace: async projectId => {
    metrics.getAssetWorkspace += 1;
    return projectId === fixture.project.id ? clone(fixture.workspace) : null;
  },
  getFileVisual: async (_projectId, visualIdentity) => {
    metrics.getFileVisual += 1;
    if (typeof visualIdentity === 'string') metrics.visualIdentities.push(visualIdentity);
    return { kind: 'thumbnail', dataUrl: SYNTHETIC_PIXEL };
  },
  setExistingAssetsDecision: async () => ({ success: true }),
  removeFile: async () => ({ success: true }),
  addFiles: async () => [],
  preparePackageReview: async () => ({ error: 'ui_stability_fixture_read_only' }),
  packageProject: async () => ({ error: 'ui_stability_fixture_read_only' }),
  selectOutputFolder: async () => null,
  deleteProject: async () => ({ success: true }),
  deleteAllProjects: async () => ({ success: true }),
  getSettings: async () => {
    metrics.getSettings += 1;
    return clone(fixture.settings);
  },
  updateSetting: async (key, value) => {
    fixture.settings[key] = value;
    return clone(fixture.settings);
  },
  getUsage: async () => {
    metrics.getUsage += 1;
    return clone(fixture.usage);
  },
  openFolder: async () => '',
  keepWatching: async () => ({ success: true }),
  inactivityPause: async () => ({ success: true }),
  preScanSession: async () => ({ success: true, filesFound: 0 }),
  acceptPending: async () => ({ success: true }),
  rejectPending: async () => ({ success: true }),
  v2BrowseFile: async () => null,
  v2PackageFile: async () => ({ error: 'ui_stability_fixture_read_only' }),
  v2PackageDroppedFile: async () => ({ error: 'ui_stability_fixture_read_only' }),
  getFigmaStatus: async () => ({
    connected: true,
    activeProjectCount: 1,
    totalFigmaAssets: fixture.expected.totalAssets,
  }),
  connectFigma: async () => ({ success: true }),
  disconnectFigma: async () => ({ success: true }),
  scanFigmaProject: async () => ({ triggered: 0 }),
  getFigmaProjectAssets: async () => [],
  figmaScanNow: async () => ({ triggered: 0, skipped: 0, inFlight: false }),
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

contextBridge.exposeInMainWorld('crateUiHarness', {
  getExpected: () => clone(fixture.expected),
  getMetrics: () => clone(metrics),
  resetMetrics: () => {
    metrics = createMetrics();
    return clone(metrics);
  },
  resetFixture,
  appendSyntheticAsset,
  emitFilesUpdated: () => emit('files:updated', {
    projectId: fixture.project.id,
    reason: 'synthetic-update',
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
