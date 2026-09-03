const { contextBridge, ipcRenderer, webUtils } = require('electron');

try {
  if (typeof ipcRenderer.send === 'function') ipcRenderer.send('startup:preload-entered');
} catch (_) {}

function packageDroppedFile(file) {
  let filePath = '';
  try {
    filePath = webUtils.getPathForFile(file);
  } catch (_) {
    return Promise.resolve({ error: 'file_unavailable' });
  }
  if (typeof filePath !== 'string' || !filePath) {
    return Promise.resolve({ error: 'file_unavailable' });
  }
  return ipcRenderer.invoke('v2:package-file', filePath);
}

contextBridge.exposeInMainWorld('crate', {
  // Projects
  getProjects: () => ipcRenderer.invoke('projects:get-all'),
  createProject: (name, type, figmaScopeMode, figmaUrl) => ipcRenderer.invoke('projects:create', name, type, figmaScopeMode, figmaUrl),
  setProjectFigmaLink: (projectId, payload) => ipcRenderer.invoke('projects:set-figma-link', projectId, payload),
  startWatching: (id) => ipcRenderer.invoke('projects:start-watching', id),
  pauseProject: (id) => ipcRenderer.invoke('projects:pause', id),
  getFiles: (id) => ipcRenderer.invoke('projects:get-files', id),
  getAssetWorkspace: (projectId) => ipcRenderer.invoke('projects:get-asset-workspace', projectId),
  getFileVisual: (projectId, visualIdentity, visualRevision) => ipcRenderer.invoke('projects:get-file-visual', projectId, visualIdentity, visualRevision),
  setExistingAssetsDecision: (projectId, decision) => ipcRenderer.invoke('projects:set-existing-assets-decision', projectId, decision),
  removeFile: (projectId, filePath) => ipcRenderer.invoke('projects:remove-file', projectId, filePath),
  addFiles: (projectId) => ipcRenderer.invoke('projects:add-files', projectId),
  cancelAddFiles: (projectId) => ipcRenderer.invoke('projects:cancel-add-files', projectId),
  preparePackageReview: (id, outputPath) => outputPath === undefined
    ? ipcRenderer.invoke('projects:prepare-package-review', id)
    : ipcRenderer.invoke('projects:prepare-package-review', id, outputPath),
  packageProject: (id, outputPath, reviewToken) => ipcRenderer.invoke('projects:package', id, outputPath, reviewToken),
  selectOutputFolder: () => ipcRenderer.invoke('projects:select-output'),
  deleteProject: (id) => ipcRenderer.invoke('projects:delete', id),
  deleteAllProjects: () => ipcRenderer.invoke('projects:delete-all'),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSetting: (key, value) => ipcRenderer.invoke('settings:update', key, value),

  // Usage
  getUsage: () => ipcRenderer.invoke('usage:get'),

  // Shell
  openFolder: (path) => ipcRenderer.invoke('shell:open-folder', path),

  // Inactivity responses
  keepWatching: (projectId) => ipcRenderer.invoke('inactivity:keep-watching', projectId),
  inactivityPause: (projectId) => ipcRenderer.invoke('inactivity:pause', projectId),

  // Pre-package session scan — finds files accessed since project started
  preScanSession: (projectId) => ipcRenderer.invoke('projects:pre-package-scan', projectId),

  // Tier 2 pending file decisions (reserved for future use)
  acceptPending: (projectId, filePath) => ipcRenderer.invoke('projects:accept-pending', projectId, filePath),
  rejectPending: (projectId, filePath) => ipcRenderer.invoke('projects:reject-pending', projectId, filePath),

  // V2 Quick Package
  v2BrowseFile: () => ipcRenderer.invoke('v2:browse-file'),
  v2PackageFile: (filePath) => ipcRenderer.invoke('v2:package-file', filePath),
  v2PackageDroppedFile: packageDroppedFile,

  // Figma Integration (Auto-Tracking)
  getFigmaStatus: () => ipcRenderer.invoke('figma:status'),
  connectFigma: (token) => ipcRenderer.invoke('figma:connect', token),
  disconnectFigma: () => ipcRenderer.invoke('figma:disconnect'),
  scanFigmaProject: (projectId) => ipcRenderer.invoke('figma:scan-project', projectId),
  getFigmaProjectAssets: (projectId) => ipcRenderer.invoke('figma:project-assets', projectId),
  figmaScanNow: () => ipcRenderer.invoke('figma:scan-now'),

  // Fixed startup diagnostics; each signal accepts no arguments and fails open.
  reportRendererScriptEntered: () => {
    try { ipcRenderer.send('startup:renderer-script-entered'); } catch (_) {}
  },
  reportRendererInitEntered: () => {
    try { ipcRenderer.send('startup:renderer-init-entered'); } catch (_) {}
  },
  reportRendererStartupDataComplete: () => {
    try { ipcRenderer.send('startup:renderer-startup-data-complete'); } catch (_) {}
  },
  reportRendererStartupDataFailed: () => {
    try { ipcRenderer.send('startup:renderer-startup-data-failed'); } catch (_) {}
  },
  reportRendererFirstRenderComplete: () => {
    try { ipcRenderer.send('startup:renderer-first-render-complete'); } catch (_) {}
  },
  reportRendererFirstFrame: () => {
    try { ipcRenderer.send('startup:renderer-first-frame'); } catch (_) {}
  },

  // Events from main
  onFilesUpdated: (callback) => {
    ipcRenderer.on('files:updated', (event, data) => callback(data));
  },
  onProjectUpdated: (callback) => {
    ipcRenderer.on('project:updated', (event, data) => callback(data));
  },
  onPackageTrigger: (callback) => {
    ipcRenderer.on('package:trigger', (event, data) => callback(data));
  },
  onPendingFilesUpdated: (callback) => {
    ipcRenderer.on('files:pending', (event, data) => callback(data));
  },
  onFigmaAuthError: (callback) => {
    ipcRenderer.on('figma:auth-error', (event, data) => callback(data));
  },
  onFigmaScanStarted: (callback) => {
    ipcRenderer.on('figma:scan-started', (event, data) => callback(data));
  },
  onFigmaScanComplete: (callback) => {
    ipcRenderer.on('figma:scan-complete', (event, data) => callback(data));
  },
  onFigmaScanError: (callback) => {
    ipcRenderer.on('figma:scan-error', (event, data) => callback(data));
  },
});

try {
  if (typeof ipcRenderer.send === 'function') ipcRenderer.send('startup:preload-bridge-exposed');
} catch (_) {}
