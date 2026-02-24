const { app, BrowserWindow, Tray, ipcMain, dialog, shell, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const chokidar = require('chokidar');
const { v4: uuidv4 } = require('uuid');
const { execSync, exec, execFile } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const crypto = require('crypto');
const os = require('os');

async function getXattrLastUsedMs(filePath) {
  try {
    const { stdout } = await execAsync(
      '/usr/bin/xattr -px "com.apple.lastuseddate#PS" ' + JSON.stringify(filePath) + ' 2>/dev/null',
      { timeout: 1000, encoding: 'utf8' }
    );
    const hexStr = stdout.trim();
    if (!hexStr) return null;
    const bytes = Buffer.from(hexStr.replace(/\s+/g, ''), 'hex');
    if (bytes.length < 8) return null;
    // CFAbsoluteTime: little-endian double, seconds since Jan 1, 2001
    const cfTime = bytes.readDoubleLE(0);
    if (cfTime <= 0) return null;
    const MAC_EPOCH_OFFSET_MS = 978307200000;
    return cfTime * 1000 + MAC_EPOCH_OFFSET_MS;
  } catch (e) {
    return null;
  }
}

function deduplicateFiles(files) {
  const seen = new Set();
  return files.filter(f => {
    if (seen.has(f.path)) return false;
    seen.add(f.path);
    return true;
  });
}

// Design app bundle IDs for two-tier file tracking
const DESIGN_APP_BUNDLE_IDS = new Set([
  'com.figma.Desktop',
  'com.adobe.Photoshop',
  'com.adobe.illustrator',
  'com.adobe.InDesign',
  'com.adobe.acrobat.pro',
  'com.adobe.reader',
  'com.adobe.Acrobat.Pro',
  'com.bohemiancoding.sketch3',
  'com.affinity.designer2',
  'com.affinity.designer',
  'com.affinity.photo2',
  'com.affinity.photo',
  'com.affinity.publisher2',
  'com.microsoft.Powerpoint',
  'com.microsoft.Excel',
  'com.microsoft.Word',
  'com.apple.iWork.Keynote',
  'com.apple.iWork.Pages',
  'com.apple.iWork.Numbers',
  'com.adobe.xd',
  'com.pixelmator.pro',
  'com.apple.Preview'
]);

// Design-relevant file extensions — captured by chokidar when they land in watched dirs.
// v1.3.5: Added common image formats. Designers downloading assets while a session is
// active are almost certainly downloading them for the project. The session-active window
// provides sufficient context — no need for app-creator checks on these formats.
const DESIGN_FILE_EXTENSIONS = new Set([
  // Native design app formats
  '.psd', '.ai', '.indd', '.idml', '.sketch', '.fig', '.xd',
  '.afdesign', '.afphoto', '.afpub',
  '.procreate',
  // Vector / structured graphics
  '.svg', '.eps',
  // Common image formats — captured during active watch sessions
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.tif', '.tiff', '.heic',
  // Presentation design formats — Keynote, PowerPoint
  '.key', '.pptx', '.ppt',
  // Font files
  '.ttf', '.otf', '.woff', '.woff2',
  // Documents
  '.pdf',
]);

// Project type → relevant bundle IDs (for isDesignAppFile type-aware filtering)
const PROJECT_TYPE_APPS = {
  branding: new Set([
    'com.figma.Desktop', 'com.adobe.Photoshop', 'com.adobe.illustrator',
    'com.adobe.InDesign', 'com.bohemiancoding.sketch3',
    'com.affinity.designer', 'com.affinity.designer2',
    'com.affinity.photo', 'com.affinity.photo2',
    'com.affinity.publisher2', 'com.pixelmator.pro',
  ]),
  print: new Set([
    'com.adobe.InDesign', 'com.adobe.illustrator', 'com.adobe.Photoshop',
    'com.adobe.acrobat.pro', 'com.adobe.Acrobat.Pro', 'com.adobe.reader',
    'com.affinity.publisher2',
  ]),
  presentation: new Set([
    'com.microsoft.Powerpoint', 'com.apple.iWork.Keynote',
  ]),
  web: new Set([
    'com.figma.Desktop', 'com.bohemiancoding.sketch3',
    'com.affinity.designer', 'com.affinity.designer2',
    'com.adobe.xd',
    'com.microsoft.VSCode',
  ]),
};

// Process name keywords used to find design app PIDs via `ps` (for lsof polling)
const DESIGN_APP_PROCESS_NAMES = {
  branding: ['Adobe Illustrator', 'Adobe Photoshop', 'Adobe InDesign', 'Figma', 'Sketch', 'Affinity Designer', 'Affinity Photo', 'Affinity Publisher', 'Pixelmator Pro'],
  print:    ['Adobe InDesign', 'Adobe Illustrator', 'Adobe Photoshop', 'Acrobat', 'Affinity Publisher'],
  presentation: ['Keynote', 'Microsoft PowerPoint'],
  web:      ['Figma', 'Sketch', 'Adobe XD', 'Affinity Designer', 'Visual Studio Code'],
};

function getFileCreatorApp(filePath) {
  try {
    const result = execSync(
      `mdls -name kMDItemCreatorApplicationIdentifier -raw "${filePath}"`,
      { timeout: 2000, encoding: 'utf8' }
    ).trim();
    if (!result || result === '(null)') return null;
    return result || null;
  } catch (e) {
    return null;
  }
}

// projectType: optional — if provided, Check 1 is scoped to that type's app list.
// Extension fallback (Check 2) always applies regardless of type.
function isDesignAppFile(filePath, projectType = null) {
  const ext = path.extname(filePath).toLowerCase();

  // Check 1: Was this file created/modified by a known design app?
  const creatorApp = getFileCreatorApp(filePath);
  if (creatorApp) {
    // Use type-specific app list if available, otherwise accept any design app
    const relevantApps = (projectType && PROJECT_TYPE_APPS[projectType])
      ? PROJECT_TYPE_APPS[projectType]
      : DESIGN_APP_BUNDLE_IDS;
    if (relevantApps.has(creatorApp)) return true;
  }

  // Check 2: Fallback — unambiguous design format extension.
  // Applies regardless of project type (e.g. a .psd is always design-relevant).
  if (DESIGN_FILE_EXTENSIONS.has(ext)) return true;

  return false;
}

// Inactivity threshold — configurable constant
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_PROJECTS = 7;

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

const store = new Store({
  defaults: {
    projects: [],
    settings: {
      namingTemplate: '{Project}_{Date}',
      notifications: false
    },
    usage: {
      packagesThisMonth: 0,
      resetDate: getNextMonthReset()
    }
  }
});

// One-time migration: update old naming template format to new one
function migrateSettings() {
  const settings = store.get('settings');
  if (settings.namingTemplate && settings.namingTemplate.includes('{Client}')) {
    store.set('settings.namingTemplate', '{Project}_{Date}');
  }
}
migrateSettings();

function getNextMonthReset() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return next.toISOString().split('T')[0];
}

function checkAndResetUsage() {
  const usage = store.get('usage');
  const now = new Date().toISOString().split('T')[0];
  if (now >= usage.resetDate) {
    store.set('usage', {
      packagesThisMonth: 0,
      resetDate: getNextMonthReset()
    });
  }
}

let tray = null;
let trayWindow = null;
const watchers = new Map(); // projectId -> chokidar watcher
const lastFileActivity = new Map(); // projectId -> timestamp
const inactivityNotified = new Set(); // projectIds already notified

function cleanName(s) {
  const cleaned = s.replace(/[^a-zA-Z0-9 ._\-()]/g, '').replace(/\s+/g, ' ').trim();
  return cleaned || 'Untitled';
}

// --- lsof Polling (Tier 1 linked-asset capture) ---

const lsofPollers = new Map();   // projectId -> setInterval id
const lsofInProgress = new Set(); // projectIds currently mid-poll (prevent overlap)

// Get PIDs of running design apps relevant to a project type.
// Uses `ps ax -o pid= -o command=` which gives full app paths (not truncated like lsof COMMAND).
function getRunningDesignAppPids(projectType, callback) {
  const keywords = DESIGN_APP_PROCESS_NAMES[projectType]
    // Fallback: all known keywords if type not recognized
    || Object.values(DESIGN_APP_PROCESS_NAMES).flat();

  exec('/bin/ps ax -o pid= -o command= 2>/dev/null', { timeout: 5000 }, (err, stdout) => {
    if (err && !stdout) { callback([]); return; }
    const pids = [];
    for (const line of stdout.trim().split('\n')) {
      const m = line.trim().match(/^\s*(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = parseInt(m[1]);
      const cmd = m[2];
      if (keywords.some(kw => cmd.includes(kw))) {
        pids.push(pid);
      }
    }
    callback(pids);
  });
}

// Poll lsof for a single watching project. Runs every LSOF_POLL_MS.
// Finds files that design apps have open (reads + writes) in watched dirs → Tier 1 auto-capture.
function pollLsofForProject(projectId) {
  if (lsofInProgress.has(projectId)) return; // skip if already running for this project

  const currentProjects = store.get('projects');
  const project = currentProjects.find(p => p.id === projectId);
  if (!project || project.status !== 'watching') return;

  lsofInProgress.add(projectId);

  getRunningDesignAppPids(project.type, (pids) => {
    if (pids.length === 0) {
      lsofInProgress.delete(projectId);
      return;
    }

    const home = os.homedir();

    // Filter to valid numeric PIDs only, then join
    const validPids = pids.filter(p => Number.isInteger(p) && p > 0);
    if (validPids.length === 0) { lsofInProgress.delete(projectId); return; }
    const pidArg = validPids.join(',');
    // v1.3.20: Use lsof -F (machine-readable) output instead of columnar format.
    // The old columnar parser split lines on whitespace, which broke for any app
    // whose COMMAND field contains a space (e.g. "Adobe Illustrator" → "Adobe Ill"
    // split into two tokens, shifting all column indices). With -F, each field is
    // on its own line with a single-character tag prefix — no column alignment issues.
    //   p = PID, f = FD, t = file type, n = file name/path
    // We only need 't' (type) and 'n' (name) to filter and capture files.
    const cmd = `/usr/sbin/lsof -F tn -p ${pidArg} 2>/dev/null`;

    exec(cmd, { timeout: 12000 }, (err, stdout) => {
      lsofInProgress.delete(projectId);
      if (!stdout) return;

      const freshProjects = store.get('projects');
      const proj = freshProjects.find(p => p.id === projectId);
      if (!proj || proj.status !== 'watching') return;

      const existingPaths = new Set(proj.files.map(f => f.path));
      const pendingPaths = new Set((proj.pendingFiles || []).map(f => f.path));

      let changed = false;
      const lines = stdout.trim().split('\n');

      // -F output: each file descriptor produces a 't' line (type) then 'n' line (name).
      // Walk the lines and pair each tTYPE with the nPATH that follows it.
      let currentType = null;

      for (const line of lines) {
        if (line.length === 0) continue;
        const tag = line[0];
        const value = line.slice(1);

        if (tag === 'p' || tag === 'f') {
          // New PID or new FD — reset state
          currentType = null;
          continue;
        }

        if (tag === 't') {
          currentType = value;  // e.g. "REG", "DIR", "CHR"
          continue;
        }

        if (tag !== 'n') continue;              // only process name lines
        if (currentType !== 'REG') {            // regular files only
          currentType = null;
          continue;
        }

        const filePath = value;
        currentType = null;                     // consumed — reset for next FD

        if (!filePath.startsWith(home + '/')) continue;      // must be in user home dir
        // v1.3.27: Allow .fig files through ~/Library/ — Figma stores local files in
        // ~/Library/Application Support/Figma/ and lsof needs to capture them.
        if (filePath.startsWith(home + '/Library/')) {
          if (path.extname(filePath).toLowerCase() !== '.fig') continue; // skip app data/caches
        }
        if (filePath.includes('/.')) continue;               // skip hidden folders
        if (filePath.includes('.app/Contents/')) continue;   // skip app bundles

        // v1.3.5: scope lsof by project type.
        // Presentation apps (Keynote/PowerPoint) EMBED images — they open tons of cached
        // thumbnails and internal temp files across ~/. Restrict to watched dirs only.
        // Design apps (InDesign/Illustrator/Photoshop/Figma) LINK images — they keep the
        // actual file open, so full ~/ scope is correct and valuable for these.
        const RESTRICTED_LSOF_TYPES = new Set(['presentation']);
        if (RESTRICTED_LSOF_TYPES.has(proj.type)) {
          const isInWatchedDir = filePath.startsWith(home + '/Desktop/') ||
                                 filePath.startsWith(home + '/Documents/') ||
                                 filePath.startsWith(home + '/Downloads/');
          if (!isInWatchedDir) continue;
        }

        if (existingPaths.has(filePath)) continue;           // already tracked
        if (pendingPaths.has(filePath)) continue;            // already pending

        // v1.3.16: Skip Microsoft Office lock/temp files (e.g. '~$Presentation.pptx')
        if (path.basename(filePath).startsWith('~$')) continue;

        // Filter to design-relevant extensions only.
        const ext = path.extname(filePath).toLowerCase();
        if (!DESIGN_FILE_EXTENSIONS.has(ext)) continue;

        // v1.3.16: Skip lsof-captured files not modified during this watch session.
        // Presentation apps (Keynote + PowerPoint) are polled together, so if Keynote
        // happens to be open with a .key file while the user is working in PowerPoint,
        // lsof will see both. Filter by mtime: only include files modified after the
        // watch session started. A stale file from another app will have an older mtime.
        // v1.3.19: Gate to presentation pill only. Branding/Print/Web apps (Illustrator,
        // InDesign, etc.) LINK images — lsof correctly sees them as open handles, so an
        // old mtime is expected and should not cause the file to be rejected.
        if (proj.type === 'presentation') {
          try {
            const stat = fs.statSync(filePath);
            const watchStart = proj.watchStartedAt || proj.createdAt;
            if (stat.mtimeMs < watchStart) continue;
          } catch (e) {
            continue; // can't stat → skip
          }
        }

        // Tier 1: confirmed open by a design app with a relevant extension — auto-add
        const fileEntry = {
          path: filePath,
          name: path.basename(filePath),
          ext,
          addedAt: Date.now(),
          source: 'lsof',
        };

        proj.files.push(fileEntry);
        existingPaths.add(filePath);
        lastFileActivity.set(projectId, Date.now());
        inactivityNotified.delete(projectId);
        changed = true;
      }

      if (changed) {
        proj.files = deduplicateFiles(proj.files);
        store.set('projects', freshProjects);
        if (trayWindow && !trayWindow.isDestroyed()) {
          trayWindow.webContents.send('files:updated', { projectId, files: proj.files });
        }
      }
    });
  });
}

const LSOF_POLL_MS = 3000; // v1.3.27: reduced from 2s to 3s — still fast enough for capture, less system load

function startLsofPolling(projectId) {
  stopLsofPolling(projectId); // clear any existing interval first
  // Run once immediately, then on the regular interval
  setTimeout(() => pollLsofForProject(projectId), 500);
  const intervalId = setInterval(() => pollLsofForProject(projectId), LSOF_POLL_MS);
  lsofPollers.set(projectId, intervalId);
}

function stopLsofPolling(projectId) {
  const intervalId = lsofPollers.get(projectId);
  if (intervalId !== undefined) {
    clearInterval(intervalId);
    lsofPollers.delete(projectId);
  }
  lsofInProgress.delete(projectId);
}

function createTrayWindow() {
  trayWindow = new BrowserWindow({
    width: 360,
    height: 620,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  trayWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  trayWindow.on('blur', () => {
    if (trayWindow && trayWindow.isVisible()) {
      trayWindow.hide();
    }
  });
}

function toggleTrayWindow() {
  if (!trayWindow) return;

  if (trayWindow.isVisible()) {
    trayWindow.hide();
    return;
  }

  const trayBounds = tray.getBounds();
  const windowBounds = trayWindow.getBounds();

  const x = Math.round(trayBounds.x + trayBounds.width / 2 - windowBounds.width / 2);
  const y = Math.round(trayBounds.y + trayBounds.height);

  trayWindow.setPosition(x, y, false);
  trayWindow.show();
  trayWindow.focus();
}

// Re-show the tray window (e.g. after a native dialog steals focus and triggers blur→hide)
function showTrayWindow() {
  if (!trayWindow || trayWindow.isDestroyed()) return;
  if (!trayWindow.isVisible()) {
    if (tray) {
      const trayBounds = tray.getBounds();
      const windowBounds = trayWindow.getBounds();
      const x = Math.round(trayBounds.x + trayBounds.width / 2 - windowBounds.width / 2);
      const y = Math.round(trayBounds.y + trayBounds.height);
      trayWindow.setPosition(x, y, false);
    }
    trayWindow.show();
    trayWindow.focus();
  }
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  let trayIcon;
  if (fs.existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath);
    trayIcon = trayIcon.resize({ width: 18, height: 18 });
    // DO NOT set as template — we want the actual colored icon
  } else {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('Crate \u2014 Project File Packager');
  tray.on('click', toggleTrayWindow);
}

// --- File Watching ---

function startWatching(projectId) {
  const projects = store.get('projects');
  const project = projects.find(p => p.id === projectId);
  if (!project) return;

  // Record when this watch session started — used by the atime scan at package time
  // (not createdAt, which could be days/weeks old for recurring projects)
  project.watchStartedAt = Date.now();
  store.set('projects', projects);

  // Stop existing watcher if any
  stopWatching(projectId);

  const homedir = os.homedir();
  const watchPaths = [
    path.join(homedir, 'Desktop'),
    path.join(homedir, 'Documents'),
    path.join(homedir, 'Downloads')
  ];

  // v1.3.27: Watch Figma's local file storage for .fig files.
  // Figma Desktop saves local files to ~/Library/Application Support/Figma/
  // which is outside the standard watched dirs. The extension check in the
  // add/change handlers already filters to design extensions only.
  const figmaDir = path.join(homedir, 'Library', 'Application Support', 'Figma');
  if (fs.existsSync(figmaDir)) {
    watchPaths.push(figmaDir);
  }

  const watcher = chokidar.watch(watchPaths, {
    ignored: [
      /(^|[\/\\])\./,        // dotfiles
      /node_modules/,
      /\.DS_Store$/
    ],
    persistent: true,
    ignoreInitial: true,
    depth: 3
  });

  // Initialize activity timestamp
  lastFileActivity.set(projectId, Date.now());
  inactivityNotified.delete(projectId);

  watcher.on('add', async (filePath) => {
    const currentProjects = store.get('projects');
    const proj = currentProjects.find(p => p.id === projectId);
    if (!proj || proj.status !== 'watching') return;
    if (proj.files.some(f => f.path === filePath)) return;

    const ext = path.extname(filePath).toLowerCase();
    const name = path.basename(filePath);
    if (name.startsWith('.') || name === 'Thumbs.db') return;
    // v1.3.16: Skip Microsoft Office lock/temp files (e.g. '~$Presentation.pptx')
    if (name.startsWith('~$')) return;

    // Small delay to let macOS write file metadata
    await new Promise(resolve => setTimeout(resolve, 500));

    const fileEntry = { path: filePath, name, ext, addedAt: Date.now() };

    if (DESIGN_FILE_EXTENSIONS.has(ext)) {
      // TIER 1: Confirmed design-app file — auto-capture silently
      proj.files.push(fileEntry);
      proj.files = deduplicateFiles(proj.files);
      store.set('projects', currentProjects);
      lastFileActivity.set(projectId, Date.now());
      inactivityNotified.delete(projectId);

      if (trayWindow && !trayWindow.isDestroyed()) {
        trayWindow.webContents.send('files:updated', { projectId, files: proj.files });
      }
    }
  });

  watcher.on('change', async (filePath) => {
    const currentProjects = store.get('projects');
    const proj = currentProjects.find(p => p.id === projectId);
    if (!proj || proj.status !== 'watching') return;
    if (proj.files.some(f => f.path === filePath)) return;

    const ext = path.extname(filePath).toLowerCase();
    const name = path.basename(filePath);
    if (name.startsWith('.') || name === 'Thumbs.db') return;
    // v1.3.16: Skip Microsoft Office lock/temp files (e.g. '~$Presentation.pptx')
    if (name.startsWith('~$')) return;

    await new Promise(resolve => setTimeout(resolve, 500));

    const fileEntry = { path: filePath, name, ext, addedAt: Date.now() };

    if (DESIGN_FILE_EXTENSIONS.has(ext)) {
      // TIER 1: Confirmed design-app file — auto-capture silently
      proj.files.push(fileEntry);
      proj.files = deduplicateFiles(proj.files);
      store.set('projects', currentProjects);
      lastFileActivity.set(projectId, Date.now());
      inactivityNotified.delete(projectId);

      if (trayWindow && !trayWindow.isDestroyed()) {
        trayWindow.webContents.send('files:updated', { projectId, files: proj.files });
      }
    }
  });

  watchers.set(projectId, watcher);
  startLsofPolling(projectId); // begin lsof polling for linked assets
}

function stopWatching(projectId) {
  const watcher = watchers.get(projectId);
  if (watcher) {
    watcher.close();
    watchers.delete(projectId);
  }
  stopLsofPolling(projectId);
  lastFileActivity.delete(projectId);
  inactivityNotified.delete(projectId);
}

// --- Inactivity Checker ---

function startInactivityChecker() {
  setInterval(() => {
    const projects = store.get('projects');
    const settings = store.get('settings');

    for (const project of projects) {
      if (project.status !== 'watching') continue;

      const lastActivity = lastFileActivity.get(project.id) || project.createdAt;
      const now = Date.now();

      if (now - lastActivity >= INACTIVITY_TIMEOUT_MS && !inactivityNotified.has(project.id)) {
        // Guard: skip projects with no captured files
        if (project.files.length === 0) {
          lastFileActivity.set(project.id, Date.now());
          continue;
        }

        // Guard: skip if tray window not visible
        if (!trayWindow || trayWindow.isDestroyed() || !trayWindow.isVisible()) {
          continue;
        }

        inactivityNotified.add(project.id);

        // Center-screen dialog alert (not corner notification)
        dialog.showMessageBox({
          type: 'question',
          title: 'Crate — Still working?',
          message: `⏸ Still working on "${project.name}"?`,
          detail: `Crate hasn't detected any new design files in 10 minutes. Would you like to keep watching or pause?`,
          buttons: ['Keep Watching', 'Pause', 'Package Now'],
          defaultId: 0,
          cancelId: 0
        }).then(({ response }) => {
          if (response === 0) {
            // Keep Watching — reset timer
            lastFileActivity.set(project.id, Date.now());
            inactivityNotified.delete(project.id);
          } else if (response === 1) {
            // Pause the project
            const projects = store.get('projects');
            const proj = projects.find(p => p.id === project.id);
            if (proj) {
              proj.status = 'paused';
              store.set('projects', projects);
              stopWatching(project.id);
              if (trayWindow && !trayWindow.isDestroyed()) {
                trayWindow.webContents.send('project:updated', { projectId: project.id });
              }
            }
          } else if (response === 2) {
            // Package Now
            if (trayWindow && !trayWindow.isDestroyed()) {
              trayWindow.webContents.send('package:trigger', { projectId: project.id });
            }
          }
        });
      }
    }
  }, 60 * 1000); // Check every minute
}

// --- IPC Handlers ---

ipcMain.handle('projects:get-all', () => {
  return store.get('projects');
});

ipcMain.handle('projects:create', (event, name, projectType = 'branding') => {
  const projects = store.get('projects');

  // Enforce project cap
  if (projects.length >= MAX_PROJECTS) {
    return { error: 'max_projects_reached' };
  }

  const cleanedName = (name || '').trim() || 'Untitled Project';

  const newProject = {
    id: uuidv4(),
    name: cleanedName,
    type: projectType,
    status: 'watching',
    files: [],
    pendingFiles: [], // Tier 2 candidates awaiting user review
    createdAt: Date.now(),
    packagedAt: null,
    outputPath: null
  };
  projects.push(newProject);
  store.set('projects', projects);
  startWatching(newProject.id);
  return newProject;
});

ipcMain.handle('projects:start-watching', (event, id) => {
  const projects = store.get('projects');
  const project = projects.find(p => p.id === id);
  if (project) {
    project.status = 'watching';
    store.set('projects', projects);
    startWatching(id);
  }
  return project;
});

ipcMain.handle('projects:pause', (event, id) => {
  const projects = store.get('projects');
  const project = projects.find(p => p.id === id);
  if (project) {
    project.status = 'paused';
    store.set('projects', projects);
    stopWatching(id);
  }
  return project;
});

ipcMain.handle('projects:get-files', (event, id) => {
  const projects = store.get('projects');
  const project = projects.find(p => p.id === id);
  return project ? project.files : [];
});

ipcMain.handle('projects:remove-file', (event, projectId, filePath) => {
  const projects = store.get('projects');
  const project = projects.find(p => p.id === projectId);
  if (project) {
    project.files = project.files.filter(f => f.path !== filePath);
    store.set('projects', projects);
  }
  return project ? project.files : [];
});

// --- Tier 2: Accept / reject pending files ---

ipcMain.handle('projects:accept-pending', (event, projectId, filePath) => {
  const projects = store.get('projects');
  const project = projects.find(p => p.id === projectId);
  if (!project) return null;

  const idx = (project.pendingFiles || []).findIndex(f => f.path === filePath);
  if (idx === -1) return null;

  const [file] = project.pendingFiles.splice(idx, 1);

  // Add to confirmed files if not already there
  if (!project.files.some(f => f.path === filePath)) {
    project.files.push(file);
    lastFileActivity.set(projectId, Date.now());
    inactivityNotified.delete(projectId);
  }

  store.set('projects', projects);

  if (trayWindow && !trayWindow.isDestroyed()) {
    trayWindow.webContents.send('files:updated', { projectId, files: project.files });
    trayWindow.webContents.send('files:pending', { projectId, pendingFiles: project.pendingFiles });
  }

  return { files: project.files, pendingFiles: project.pendingFiles };
});

ipcMain.handle('projects:reject-pending', (event, projectId, filePath) => {
  const projects = store.get('projects');
  const project = projects.find(p => p.id === projectId);
  if (!project) return null;

  project.pendingFiles = (project.pendingFiles || []).filter(f => f.path !== filePath);
  store.set('projects', projects);

  if (trayWindow && !trayWindow.isDestroyed()) {
    trayWindow.webContents.send('files:pending', { projectId, pendingFiles: project.pendingFiles });
  }

  return project.pendingFiles;
});

ipcMain.handle('projects:add-files', async (event, projectId) => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    title: 'Add Files to Project'
  });
  // Re-show tray window after native dialog closes (window hides on blur)
  showTrayWindow();

  if (result.canceled) return null;

  const projects = store.get('projects');
  const project = projects.find(p => p.id === projectId);
  if (!project) return null;

  for (const filePath of result.filePaths) {
    if (!project.files.some(f => f.path === filePath)) {
      project.files.push({
        path: filePath,
        name: path.basename(filePath),
        ext: path.extname(filePath).toLowerCase(),
        addedAt: Date.now()
      });
    }
  }

  store.set('projects', projects);
  return project.files;
});

// --- Session file scan (Spotlight-based, runs at package time) ---
// v1.3.5: mdfind session scan REMOVED.
// The old mdfind + kMDItemLastUsedDate approach scanned the entire home directory for
// any file accessed during the session — but it couldn't distinguish which app opened
// the file, causing massive over-capture (browser cache images, Finder previews, etc.).
// With image formats now in DESIGN_FILE_EXTENSIONS, chokidar captures downloads directly.
// lsof catches files opened by design apps. extractEmbeddedMedia() handles .pptx/.key
// embedded images at package time. All three capture methods are app/context-aware —
// mdfind was the only one that wasn't, so it's gone.

// Called when user clicks Package — merges session-accessed files into project
// BEFORE the confirmation modal is shown, so the user sees the full file list.
// v1.3.5: pre-package-scan no longer runs mdfind session scan.
// Files are captured in real-time by chokidar (downloads) and lsof (linked assets).
// Embedded media from .pptx/.key is extracted separately by extractEmbeddedMedia().
//
// v1.3.20: Targeted .fig scan for Branding pill. Figma Desktop is cloud-first —
// it uploads .fig files and works from the cloud, so lsof often won't see a local
// file handle. Scan Desktop/Documents/Downloads for .fig files modified during the
// session (mtime >= watchStartedAt) to catch locally-saved Figma files.
// For .fig files saved BEFORE the session, users should use "+ Add files".
ipcMain.handle('projects:pre-package-scan', async (event, projectId) => {
  const projects = store.get('projects');
  const project = projects.find(p => p.id === projectId);
  if (!project) return null;

  let newCount = 0;

  // v1.3.20: Targeted .fig scan for branding projects at package time.
  // v1.3.33: Entire scan block wrapped in 8-second timeout guard so the
  // backend never blocks the renderer for longer than that.
  if (project.type === 'branding') {
    const homedir = os.homedir();
    const scanDirs = [
      path.join(homedir, 'Desktop'),
      path.join(homedir, 'Documents'),
      path.join(homedir, 'Downloads'),
      // v1.3.27: Figma Desktop stores local files in ~/Library/Application Support/Figma/
      path.join(homedir, 'Library', 'Application Support', 'Figma'),
    ];
    const watchStart = project.watchStartedAt || project.createdAt;
    const existingPaths = new Set(project.files.map(f => f.path));

    await Promise.race([
      (async () => {
    // v1.3.29: Live lsof pass at package time — captures .fig files currently open in Figma,
    // bypassing Spotlight indexing delay. Runs once synchronously before the scan loops.
    try {
      const figmaPids = [];
      const { stdout: psOut } = await execAsync("/bin/ps ax -o pid= -o command= 2>/dev/null", { timeout: 5000, encoding: "utf8" });
      for (const line of psOut.trim().split("\n")) {
        const m = line.trim().match(/^\s*(\d+)\s+(.+)$/);
        if (m && m[2].includes("Figma")) figmaPids.push(m[1]);
      }
      if (figmaPids.length > 0) {
        const { stdout: lsofOut } = await execAsync(
          `/usr/sbin/lsof -F n -p ${figmaPids.join(",")} 2>/dev/null`,
          { timeout: 10000, encoding: "utf8" }
        );
        for (const line of lsofOut.trim().split("\n")) {
          if (!line.startsWith("n")) continue;
          const filePath = line.slice(1);
          if (!filePath.endsWith(".fig")) continue;
          // Only capture .fig files within known scan dirs — prevents false positives
          // if Figma has unrelated project files open simultaneously.
          if (!scanDirs.some(dir => filePath.startsWith(dir + "/"))) continue;
          if (existingPaths.has(filePath)) continue;
          if (!fs.existsSync(filePath)) continue;
          project.files.push({
            path: filePath,
            name: path.basename(filePath),
            ext: ".fig",
            addedAt: Date.now(),
            source: "lsof-package-scan",
          });
          existingPaths.add(filePath);
          newCount++;
        }
      }
    } catch (e) {
      // lsof pass failed — continue with other scan methods
    }

    for (const dir of scanDirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        // Scan at depth 0 (direct children) and depth 1 (one subfolder deep)
        const scanFolder = (folder, depth) => {
          let entries;
          try { entries = fs.readdirSync(folder, { withFileTypes: true }); }
          catch (e) { return; }

          for (const entry of entries) {
            const fullPath = path.join(folder, entry.name);
            if (entry.name.startsWith('.')) continue; // skip dotfiles/folders

            if (entry.isDirectory() && depth < 3) {
              scanFolder(fullPath, depth + 1);
              continue;
            }

            if (!entry.isFile()) continue;
            if (path.extname(entry.name).toLowerCase() !== '.fig') continue;
            if (existingPaths.has(fullPath)) continue;

            // Only include .fig files created or modified during this watch session.
            // v1.3.26: Also check birthtimeMs — Figma Desktop is cloud-first and
            // may preserve the original mtime from the cloud version when saving a
            // local copy. macOS sets birthtimeMs to the actual disk-creation time,
            // so a file saved locally during the session will have a recent birthtime
            // even if its mtime predates the session.
            try {
              const stat = fs.statSync(fullPath);
              if (stat.mtimeMs < watchStart && stat.birthtimeMs < watchStart) continue;
            } catch (e) {
              continue;
            }

            project.files.push({
              path: fullPath,
              name: entry.name,
              ext: '.fig',
              addedAt: Date.now(),
              source: 'fig-scan',
            });
            existingPaths.add(fullPath);
            newCount++;
          }
        };
        scanFolder(dir, 0);
      } catch (e) {
        // scan error for this dir — continue with others
      }
    }

    // v1.3.25: kMDItemLastUsedDate scan for branding projects.
    // Walk Desktop/Documents/Downloads (depth 3) and check Spotlight's
    // kMDItemLastUsedDate for design files opened during this session.
    // This catches files opened in design apps that chokidar/lsof missed
    // (e.g. files already on disk that were opened but not modified).
    // v1.3.26: Also covers .fig files — the mtime-based scan above only
    // catches .fig files modified/created during the session, but a
    // pre-existing .fig file opened (imported) in Figma only updates
    // kMDItemLastUsedDate, not mtime. Removing the .fig skip lets this
    // scan catch those imports. Dedup via existingPaths prevents doubles.
    for (const dir of scanDirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        const scanFolderLastUsed = async (folder, depth) => {
          let entries;
          try { entries = fs.readdirSync(folder, { withFileTypes: true }); }
          catch (e) { return; }

          for (const entry of entries) {
            const fullPath = path.join(folder, entry.name);
            if (entry.name.startsWith('.')) continue;

            if (entry.isDirectory() && depth < 3) {
              await scanFolderLastUsed(fullPath, depth + 1);
              continue;
            }

            if (!entry.isFile()) continue;
            const ext = path.extname(entry.name).toLowerCase();
            if (!DESIGN_FILE_EXTENSIONS.has(ext)) continue;
            if (existingPaths.has(fullPath)) continue;

            try {
              const { stdout: mdlsRaw } = await execAsync(
                `/usr/bin/mdls -name kMDItemLastUsedDate -raw "${fullPath}"`,
                { timeout: 2000, encoding: 'utf8' }
              );
              const mdlsOut = mdlsRaw.trim();
              if (!mdlsOut || mdlsOut === '(null)') continue;

              const lastUsedTime = new Date(mdlsOut).getTime();
              if (isNaN(lastUsedTime) || lastUsedTime < watchStart) {
                // Fallback: check xattr directly — no Spotlight delay
                const xattrTime = await getXattrLastUsedMs(fullPath);
                if (!xattrTime || xattrTime < watchStart) continue;
              }
            } catch (e) {
              continue;
            }

            project.files.push({
              path: fullPath,
              name: entry.name,
              ext,
              addedAt: Date.now(),
              source: 'lastused-scan',
            });
            existingPaths.add(fullPath);
            newCount++;
          }
        };
        await scanFolderLastUsed(dir, 0);
      } catch (e) {
        // scan error — continue with others
      }
    }
      })(),
      new Promise(resolve => setTimeout(resolve, 8000))
    ]);

  }

  // v1.3.24: Extract linked file paths from .ai files in the project (spaces in filenames now supported).
  // Illustrator stores absolute paths of linked/placed files as text strings
  // inside .ai files (which are PDF-based). Reading the .ai binary as UTF-8
  // and scanning for /Users/.../<ext> paths reliably finds all linked assets.
  // This replaces the v1.3.22 Spotlight scan which was too broad — it picked up
  // ALL design files accessed on the machine, not just ones linked in the project.
  const AI_LINK_REGEX = /\/Users\/[^\x00-\x1f\x22\x27]+\.(jpg|jpeg|png|gif|webp|svg|pdf|eps|ai|psd|tiff|tif|afdesign|afphoto|indd|idml|sketch|fig)/gi;
  const aiFiles = project.files.filter(f => f.ext === '.ai');
  if (aiFiles.length > 0) {
    const aiLinkExisting = new Set(project.files.map(f => f.path));

    for (const aiFile of aiFiles) {
      try {
        if (!fs.existsSync(aiFile.path)) continue;
        const buf = fs.readFileSync(aiFile.path);
        const content = buf.toString('utf8');
        let match;
        AI_LINK_REGEX.lastIndex = 0;
        while ((match = AI_LINK_REGEX.exec(content)) !== null) {
          const linkedPath = match[0];
          if (aiLinkExisting.has(linkedPath)) continue;
          if (!fs.existsSync(linkedPath)) continue;

          project.files.push({
            path: linkedPath,
            name: path.basename(linkedPath),
            ext: path.extname(linkedPath).toLowerCase(),
            addedAt: Date.now(),
            source: 'ai-link',
          });
          aiLinkExisting.add(linkedPath);
          newCount++;
        }
      } catch (e) {
        // read error for this .ai file — continue with others
      }
    }
  }

  if (newCount > 0) {
    project.files = deduplicateFiles(project.files);
    store.set('projects', projects);
  }

  return { files: project.files, newCount };
});

// --- Embedded media extraction for zip-based design files ---
// Keynote (.key), PowerPoint (.pptx), and Sketch (.sketch) are zip archives
// that embed images internally. lsof can't catch the sub-100ms reads when
// images are dragged in, and no macOS metadata is updated for those reads.
// Solution: unzip at package time and extract the images directly.
//
// .key structure: images are in Data/ (flat zip format)
// .pptx structure: images are in ppt/media/ (OpenXML zip format)
// .sketch structure: images are in images/ (bitmap assets by SHA1 hash)
//
// v1.3.9: Date-based filtering. Template/theme images inside the zip have OLD
// dates (from when the template was created, e.g. 2023). User-inserted images
// are stamped with the CURRENT date by Keynote/PowerPoint. We parse unzip -l
// output, compare each entry's date against the watch session start, and only
// extract files dated on or after that day. This works for both .key and .pptx.

const EMBEDDED_MEDIA_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.tif', '.tiff', '.heic',
  '.svg', '.pdf', '.eps', '.mp4', '.mov',
]);

// Parse a zip entry date from `unzip -l` output (macOS format: MM-DD-YYYY HH:MM)
// Returns a Date object or null if parsing fails.
function parseZipEntryDate(dateStr, timeStr) {
  const parts = dateStr.split('-');
  if (parts.length !== 3) return null;
  const [mm, dd, yyyy] = parts;
  const year = parseInt(yyyy, 10);
  const month = parseInt(mm, 10) - 1; // 0-indexed
  const day = parseInt(dd, 10);
  if (isNaN(year) || isNaN(month) || isNaN(day)) return null;

  let hours = 0, minutes = 0;
  if (timeStr) {
    const tp = timeStr.split(':');
    hours = parseInt(tp[0], 10) || 0;
    minutes = parseInt(tp[1], 10) || 0;
  }

  return new Date(year, month, day, hours, minutes);
}

async function extractEmbeddedMedia(presentationPath, destFolder, watchStartedAt, projectFiles) {
  const ext = path.extname(presentationPath).toLowerCase();
  const base = path.basename(presentationPath, ext);
  const extracted = [];

  // v1.3.10: Build a set of base names already captured by chokidar/lsof.
  // Normalise: lowercase, strip extension, collapse whitespace.
  // If chokidar already captured "shopping (6).webp", the embedded copy
  // ("shopping (6).jpeg") is a lower-quality duplicate — skip it.
  const alreadyCapturedBases = new Set();
  if (projectFiles) {
    for (const f of projectFiles) {
      const n = path.basename(f.name, path.extname(f.name)).toLowerCase().replace(/\s+/g, ' ').trim();
      alreadyCapturedBases.add(n);
    }
  }

  // v1.3.18: Content-based dedup for .pptx files.
  // PowerPoint renames all embedded images generically (image1.png, image2.png),
  // so name-based dedup can't match them against originals captured by chokidar.
  // Build a Set of size:md5 fingerprints from already-captured files, then check
  // each extracted pptx entry against it. Same size + same hash = same file, skip it.
  const contentFingerprints = new Set();
  const capturedSizes = new Set();
  if ((ext === '.pptx' || ext === '.ppt') && projectFiles) {
    for (const f of projectFiles) {
      try {
        const buf = fs.readFileSync(f.path);
        const size = buf.length;
        capturedSizes.add(size);
        const hash = crypto.createHash('md5').update(buf).digest('hex');
        contentFingerprints.add(`${size}:${hash}`);
      } catch (e) {
        // file may no longer exist on disk — skip
      }
    }
  }

  // Compute the cutoff: start of the day when watching began.
  // Template/theme images have dates from years ago (e.g. 2023); user-inserted
  // images are stamped with the current date by Keynote/PowerPoint. Comparing at
  // day granularity gives a generous window for same-session inserts.
  const watchDate = new Date(watchStartedAt);
  const cutoffDate = new Date(watchDate.getFullYear(), watchDate.getMonth(), watchDate.getDate());

  try {
    // List the zip contents — format: "  length  MM-DD-YYYY HH:MM  filename"
    const { stdout: listing } = await execAsync(`unzip -l "${presentationPath}" 2>/dev/null`, {
      timeout: 10000, encoding: 'utf8'
    });

    for (const line of listing.split('\n')) {
      // Match: length, date (MM-DD-YYYY), time (HH:MM), filename
      const m = line.match(/^\s+(\d+)\s+(\d{2}-\d{2}-\d{4})\s+(\d{2}:\d{2})\s+(.+)$/);
      if (!m) continue;

      const fileSize = parseInt(m[1], 10);
      const entryDate = parseZipEntryDate(m[2], m[3]);
      const zipPath = m[4].trim();

      if (zipPath.endsWith('/')) continue;              // directory entries
      if (zipPath.includes('__MACOSX')) continue;       // macOS metadata cruft
      if (path.basename(zipPath).startsWith('.')) continue;

      const fileExt = path.extname(zipPath).toLowerCase();
      if (!EMBEDDED_MEDIA_EXTENSIONS.has(fileExt)) continue;

      // Scope to known media folders for each format
      const inMediaFolder =
        (ext === '.pptx' || ext === '.ppt') ? zipPath.startsWith('ppt/media/') :
        (ext === '.key')                     ? zipPath.startsWith('Data/')       :
        false;
      if (!inMediaFolder) continue;

      // Date filter: skip entries older than the watch session start date.
      // Only applied for Keynote (.key) — Keynote re-stamps embedded images with
      // today's date, so old dates reliably indicate theme/template assets.
      // PowerPoint (.pptx/.ppt) preserves the original file's modification date
      // inside the zip, so the date filter would incorrectly reject valid images.
      // PowerPoint's ppt/media/ folder only contains actually-used images (no
      // theme junk), so skipping the date filter is safe.
      if (ext === '.key') {
        if (!entryDate || entryDate < cutoffDate) {
          console.log(`[crate] skipped old embedded media: ${path.basename(zipPath)} (date: ${m[2]})`);
          continue;
        }
      }

      // Skip tiny files — likely blank placeholders (e.g. blankMoviePosterImage)
      if (fileSize < 500) {
        console.log(`[crate] skipped tiny embedded file: ${path.basename(zipPath)} (${fileSize} bytes)`);
        continue;
      }

      // v1.3.10: Keynote-specific junk filtering.
      // Keynote embeds internal files that pass the date filter because they get
      // today's date — but they are NOT user-inserted assets.
      if (ext === '.key') {
        const entryName = path.basename(zipPath);

        // Slide thumbnail/preview images.
        // Keynote generates composite slide screenshots named "st-{UUID}.jpg".
        // These are internal slide previews, not user content.
        if (/^st-[0-9a-f-]+\.jpe?g$/i.test(entryName)) {
          console.log(`[crate] skipped Keynote slide thumbnail: ${entryName}`);
          continue;
        }

        // v1.3.15+: Keynote internal theme/template assets.
        // mt- = media/theme images (template backgrounds, textures, UI elements)
        // bg- = background images baked into the theme
        // tx- = texture assets used by theme styles
        // All follow the same {prefix}-{UUID}.jpg naming pattern as st- thumbnails.
        // These are NOT user content — they ship with the Keynote theme/template.
        if (/^(mt|bg|tx)-[0-9a-f-]+\.jpe?g$/i.test(entryName)) {
          console.log(`[crate] skipped Keynote theme/template asset: ${entryName}`);
          continue;
        }

        // Internal thumbnail/small variants of user images.
        // Keynote creates e.g. "shopping (6)-small-9073.jpeg" for every inserted image.
        // The optional -NNNN is Keynote's numeric suffix appended to all embedded files.
        if (/-small(-\d{3,6})?\.[a-z]+$/i.test(entryName)) {
          console.log(`[crate] skipped Keynote thumbnail variant: ${entryName}`);
          continue;
        }

        // v1.3.11: Removed "download (N)" filename filter that was here.
        // It blocked legitimate user files — browsers name downloads "download (3).jpeg"
        // etc., and those are real user assets dragged into Keynote. The remaining
        // filters (date, -small, st-UUID, size, cross-reference dedup) are sufficient
        // to handle Keynote internal junk without false positives.

        // Cross-reference: if chokidar/lsof already captured the original file,
        // skip the embedded (lower-quality) duplicate from inside the .key.
        // Compare base names after stripping Keynote's "-NNNN" numeric suffix
        // and any "-small" variant suffix so thumbnails match their originals.
        // v1.3.17: .key only — PowerPoint names images generically (image1.png,
        // image2.png) so name-based dedup won't work for .pptx.
        const cleanedName = entryName
          .replace(/-\d{3,6}(\.[a-z]+)$/i, '$1')
          .replace(/-small(\.[a-z]+)$/i, '$1');
        const baseName = path.basename(cleanedName, path.extname(cleanedName))
          .toLowerCase().replace(/\s+/g, ' ').trim();
        if (alreadyCapturedBases.has(baseName)) {
          console.log(`[crate] skipped duplicate (already captured): ${entryName} → matches "${baseName}"`);
          continue;
        }
      }

      try {
        // unzip -p pipes file contents to stdout
        const { stdout: data } = await execFileAsync('/usr/bin/unzip', ['-p', presentationPath, zipPath], {
          timeout: 10000, maxBuffer: 50 * 1024 * 1024, // 50MB per file
          encoding: 'buffer'
        });

        // v1.3.18: Content-based dedup for .pptx — skip if identical to a captured file.
        if ((ext === '.pptx' || ext === '.ppt') && contentFingerprints.size > 0) {
          const extractedSize = data.length;
          if (capturedSizes.has(extractedSize)) {
            const extractedHash = crypto.createHash('md5').update(data).digest('hex');
            if (contentFingerprints.has(`${extractedSize}:${extractedHash}`)) {
              console.log(`[crate] skipped duplicate (content match): ${path.basename(zipPath)} (${extractedSize} bytes, md5:${extractedHash})`);
              continue;
            }
          }
        }

        // Recover the original filename: strip Keynote's trailing "-NNNN" suffix
        // e.g. "shopping (5)-9073.jpeg" → "shopping (5).jpeg"
        let outputName = path.basename(zipPath);
        if (ext === '.key') {
          outputName = outputName.replace(/-\d{3,6}(\.[a-z]+)$/i, '$1');
        }

        // Prefix with presentation name to avoid collisions with other files
        outputName = `${base} — ${outputName}`;

        // Handle duplicate filenames using existing counter pattern
        let destPath = path.join(destFolder, outputName);
        let counter = 1;
        while (fs.existsSync(destPath)) {
          const e = path.extname(outputName);
          const b = path.basename(outputName, e);
          destPath = path.join(destFolder, `${b}_${counter}${e}`);
          counter++;
        }

        fs.writeFileSync(destPath, data);
        extracted.push(destPath);
        console.log(`[crate] extracted embedded media: ${outputName} (date: ${m[2]})`);
      } catch (e) {
        console.error(`[crate] failed to read ${zipPath}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[crate] extractEmbeddedMedia error for', presentationPath, ':', e.message);
  }

  return extracted;
}

ipcMain.handle('projects:package', async (event, id, outputPath) => {
  checkAndResetUsage();
  const usage = store.get('usage');

  // Check freemium limit
  if (usage.packagesThisMonth >= 10) {
    const daysLeft = Math.ceil((new Date(usage.resetDate) - new Date()) / (1000 * 60 * 60 * 24));
    return { error: 'limit_reached', daysLeft };
  }

  const projects = store.get('projects');
  const project = projects.find(p => p.id === id);
  if (!project) return { error: 'not_found' };

  // Build folder name from naming template
  const settings = store.get('settings');
  const template = settings.namingTemplate;
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];

  // Use the full project name as-is — no client/project splitting.
  // {Project} = the full name the user typed, cleaned for filesystem use.
  const folderName = template
    .replace('{Project}', cleanName(project.name))
    .replace('{Date}', dateStr);

  const destFolder = path.join(outputPath, folderName);

  try {
    if (!fs.existsSync(destFolder)) {
      fs.mkdirSync(destFolder, { recursive: true });
    }

    let copiedCount = 0;
    const errors = [];

    for (const file of project.files) {
      try {
        if (fs.existsSync(file.path)) {
          const destPath = path.join(destFolder, file.name);
          // Handle duplicate filenames
          let finalPath = destPath;
          let counter = 1;
          while (fs.existsSync(finalPath)) {
            const ext = path.extname(file.name);
            const base = path.basename(file.name, ext);
            finalPath = path.join(destFolder, `${base}_${counter}${ext}`);
            counter++;
          }
          fs.copyFileSync(file.path, finalPath);
          copiedCount++;
        } else {
          errors.push(`File not found: ${file.name}`);
        }
      } catch (err) {
        errors.push(`Failed to copy ${file.name}: ${err.message}`);
      }
    }

    // Extract embedded media from zip-based design files (.key, .pptx)
    // These formats embed images internally as zip entries — lsof can't catch
    // the sub-100ms reads when assets are dragged in, so we pull them at package time.
    let embeddedCount = 0;
    const ZIP_BASED_FORMATS = new Set(['.key', '.pptx', '.ppt']);
    for (const file of project.files) {
      const fileExt = path.extname(file.name).toLowerCase();
      if (ZIP_BASED_FORMATS.has(fileExt) && fs.existsSync(file.path)) {
        const embeddedFiles = await extractEmbeddedMedia(file.path, destFolder, project.watchStartedAt || project.createdAt, project.files);
        embeddedCount += embeddedFiles.length;
      }
    }

    // Auto-stop watcher — SECURITY REQUIREMENT
    stopWatching(id);

    // Update project status to packaged
    project.status = 'packaged';
    project.packagedAt = Date.now();
    project.outputPath = destFolder;
    store.set('projects', projects);

    // Increment usage
    usage.packagesThisMonth++;
    store.set('usage', usage);

    // Send notification if enabled
    if (settings.notifications && Notification.isSupported()) {
      new Notification({
        title: 'Project Packaged!',
        body: `${project.name} \u2014 ${copiedCount} files gathered.`
      }).show();
    }

    // Re-show tray window so user sees the success confirmation
    showTrayWindow();

    return {
      success: true,
      copiedCount,
      embeddedCount,
      totalFiles: project.files.length,
      folderPath: destFolder,
      errors
    };
  } catch (err) {
    showTrayWindow();
    return { error: err.message };
  }
});

ipcMain.handle('projects:select-output', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose Package Destination',
    defaultPath: path.join(os.homedir(), 'Desktop')
  });
  // Re-show tray window after native dialog closes (window hides on blur)
  showTrayWindow();
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('projects:delete', (event, id) => {
  stopWatching(id);
  const projects = store.get('projects');
  const filtered = projects.filter(p => p.id !== id);
  store.set('projects', filtered);
  return filtered;
});

ipcMain.handle('projects:delete-all', () => {
  // Stop all active watchers and lsof pollers
  for (const [id, watcher] of watchers) {
    watcher.close();
  }
  watchers.clear();
  for (const [id, intervalId] of lsofPollers) {
    clearInterval(intervalId);
  }
  lsofPollers.clear();
  lsofInProgress.clear();
  lastFileActivity.clear();
  inactivityNotified.clear();

  store.set('projects', []);
  return [];
});

ipcMain.handle('settings:get', () => {
  return store.get('settings');
});

ipcMain.handle('settings:update', (event, key, value) => {
  store.set(`settings.${key}`, value);
  return store.get('settings');
});

ipcMain.handle('usage:get', () => {
  checkAndResetUsage();
  return store.get('usage');
});

ipcMain.handle('shell:open-folder', (event, folderPath) => {
  shell.openPath(folderPath);
});

// Inactivity responses
ipcMain.handle('inactivity:keep-watching', (event, projectId) => {
  lastFileActivity.set(projectId, Date.now());
  inactivityNotified.delete(projectId);
});

ipcMain.handle('inactivity:pause', (event, projectId) => {
  const projects = store.get('projects');
  const project = projects.find(p => p.id === projectId);
  if (project) {
    project.status = 'paused';
    store.set('projects', projects);
    stopWatching(projectId);
  }
  return project;
});

// --- App Lifecycle ---

app.whenReady().then(() => {
  // Show in Dock so users can right-click → Quit
  // NOTE: Do NOT manually set dock icon — let Electron use the .icns from the packager
  // which macOS renders with proper squircle mask (no white corners)
  if (app.dock) {
    // Add right-click Dock menu
    app.dock.setMenu(require('electron').Menu.buildFromTemplate([
      {
        label: 'Quit Crate',
        click: () => app.quit()
      }
    ]));
  }

  createTrayWindow();
  createTray();

  // Resume watching for any active projects
  const projects = store.get('projects');
  for (const project of projects) {
    if (project.status === 'watching') {
      startWatching(project.id);
    }
  }

  // Start inactivity checker
  startInactivityChecker();
});

// Track intentional quit so we don't block Dock right-click → Quit
let isQuitting = false;

app.on('window-all-closed', (e) => {
  // Only prevent quit if it wasn't deliberately triggered (e.g. user closed
  // the tray window by accident). Dock "Quit" and app.quit() set isQuitting=true
  // via before-quit, so those flow through cleanly.
  if (!isQuitting) {
    e.preventDefault();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  // Clean up all watchers
  for (const [id, watcher] of watchers) {
    watcher.close();
  }
  watchers.clear();
  // Clean up lsof pollers
  for (const [id, intervalId] of lsofPollers) {
    clearInterval(intervalId);
  }
  lsofPollers.clear();
  // Explicitly destroy tray + window so quit isn't blocked by hidden windows
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }
  if (trayWindow && !trayWindow.isDestroyed()) {
    trayWindow.destroy();
    trayWindow = null;
  }
});
