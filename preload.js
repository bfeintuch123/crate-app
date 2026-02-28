const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('crate', {
  // Projects
  getProjects: () => ipcRenderer.invoke('projects:get-all'),
  createProject: (name, type) => ipcRenderer.invoke('projects:create', name, type),
  startWatching: (id) => ipcRenderer.invoke('projects:start-watching', id),
  pauseProject: (id) => ipcRenderer.invoke('projects:pause', id),
  getFiles: (id) => ipcRenderer.invoke('projects:get-files', id),
  removeFile: (projectId, filePath) => ipcRenderer.invoke('projects:remove-file', projectId, filePath),
  addFiles: (projectId) => ipcRenderer.invoke('projects:add-files', projectId),
  packageProject: (id, outputPath) => ipcRenderer.invoke('projects:package', id, outputPath),
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
  v2GetSupportedExtensions: () => ipcRenderer.invoke('v2:supported-extensions'),

  // Figma Integration (Auto-Tracking)
  getFigmaStatus: () => ipcRenderer.invoke('figma:status'),
  connectFigma: (token) => ipcRenderer.invoke('figma:connect', token),
  disconnectFigma: () => ipcRenderer.invoke('figma:disconnect'),
  scanFigmaProject: (projectId) => ipcRenderer.invoke('figma:scan-project', projectId),
  getFigmaProjectAssets: (projectId) => ipcRenderer.invoke('figma:project-assets', projectId),

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
});
