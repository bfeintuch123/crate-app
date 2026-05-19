const { app, BrowserWindow, Tray, ipcMain, dialog, shell, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const chokidar = require('chokidar');
const { v4: uuidv4 } = require('uuid');
const { execSync, exec, execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const crypto = require('crypto');
const os = require('os');
const { readPsd } = require('ag-psd');
const fetch = require('node-fetch');
const {
  NODE_TYPES,
  EDGE_TYPES,
  OBSERVER_KINDS,
  CONFIDENCE_BANDS,
  createNodeId,
  createDedupeKey,
  createObservationRecord,
  ensureProjectProvenance,
  appendObservation,
} = require('./provenance');

async function getXattrLastUsedMs(filePath) {
  try {
    const { stdout } = await execFileAsync("/usr/bin/xattr", ["-px", "com.apple.lastuseddate#PS", filePath], {
      timeout: 1000, encoding: 'utf8'
    });
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

async function getMdlsLastUsedMs(filePath) {
  try {
    const { stdout } = await execFileAsync("/usr/bin/mdls", ["-name", "kMDItemLastUsedDate", "-raw", filePath], {
      timeout: 2000, encoding: 'utf8'
    });
    const rawValue = stdout.trim();
    if (!rawValue || rawValue === '(null)') return null;
    const parsedTime = new Date(rawValue).getTime();
    return Number.isNaN(parsedTime) ? null : parsedTime;
  } catch (e) {
    return null;
  }
}

function normalizeTrackedFilePath(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') return '';

  const resolvedPath = path.resolve(filePath.trim()).replace(/\/+$/, '');

  // Canonicalize to the real on-disk path when possible so later scans can't
  // re-add the same file through an alternate alias (case, symlink, iCloud path, etc.).
  try {
    return fs.realpathSync.native(resolvedPath).replace(/\/+$/, '').toLowerCase();
  } catch (e) {
    return resolvedPath.toLowerCase();
  }
}

function getFigmaAssetDedupKey(record) {
  if (!record) return null;

  const figmaFileKey = typeof record.figmaFileKey === 'string' && record.figmaFileKey.trim()
    ? record.figmaFileKey.trim()
    : (typeof record.fileKey === 'string' && record.fileKey.trim()
      ? record.fileKey.trim()
      : '');

  let assetKey = null;
  if (typeof record.figmaAssetKey === 'string' && record.figmaAssetKey.trim()) {
    assetKey = record.figmaAssetKey.trim();
  } else if (typeof record.imageRef === 'string' && record.imageRef.trim()) {
    assetKey = record.imageRef.trim();
  } else if (typeof record.nodeId === 'string' && record.nodeId.trim()) {
    assetKey = record.nodeId.trim();
  } else if (typeof record.url === 'string' && record.url.trim()) {
    try {
      const parsed = new URL(record.url.trim());
      parsed.search = '';
      assetKey = parsed.toString();
    } catch (e) {
      assetKey = record.url.trim().split('?')[0];
    }
  }

  if (!assetKey) return null;
  return figmaFileKey ? `${figmaFileKey}:${assetKey}` : assetKey;
}

// L1: Cache stat results to avoid redundant fs.statSync calls across invocations.
// The cache is short-lived (cleared each call) — just prevents re-stat of the same
// path within a single dedup pass.
function deduplicateFiles(files) {

  // Pass 1: normalized path dedup (catches case/trailing-slash/relative variants)
  const seenPaths = new Set();
  const pathDeduped = files.filter(f => {
    const norm = getTrackedFileDedupKey(f);
    if (seenPaths.has(norm)) return false;
    seenPaths.add(norm);
    return true;
  });

  // Pass 2 (v1.3.37): basename + file size dedup — ONLY for embedded-media sources.
  // v1.3.38: Scoped to source === 'embedded-media' only. Previously applied to all
  // files, which caused lsof-tracked and linked-asset files with the same basename
  // and size (legitimately different project assets) to be incorrectly merged.
  const seenNameSize = new Set();
  const statCache = new Map(); // L1: cache stat results within this call
  const embeddedDeduped = pathDeduped.filter(f => {
    if (f.source !== 'embedded-media') return true; // skip dedup for non-embedded files
    let size = -1;
    const cached = statCache.get(f.path);
    if (cached !== undefined) {
      size = cached;
    } else {
      try { size = fs.statSync(f.path).size; } catch (e) {}
      statCache.set(f.path, size);
    }
    if (size < 0) return true; // can't stat → keep
    const key = `${path.basename(f.path).toLowerCase()}:${size}`;
    if (seenNameSize.has(key)) return false;
    seenNameSize.add(key);
    return true;
  });

  // Pass 3: Figma asset identity dedup — protects startup scans from adding the
  // same cloud asset more than once under different local filenames.
  const seenFigmaAssets = new Set();
  return embeddedDeduped.filter(f => {
    if (f.source !== 'figma-auto') return true;
    const figmaKey = getFigmaAssetDedupKey(f);
    if (!figmaKey) return true;
    if (seenFigmaAssets.has(figmaKey)) return false;
    seenFigmaAssets.add(figmaKey);
    return true;
  });
}

const FIGMA_SCOPE_CURRENT_PAGE = 'current-page';
const FIGMA_SCOPE_ENTIRE_FILE = 'entire-file';
const VALID_FIGMA_SCOPE_MODES = new Set([FIGMA_SCOPE_CURRENT_PAGE, FIGMA_SCOPE_ENTIRE_FILE]);

function getProjectFigmaScopeMode(project) {
  const sessionMode = project && project.figmaSession && project.figmaSession.scopeMode;
  if (VALID_FIGMA_SCOPE_MODES.has(sessionMode)) return sessionMode;

  const projectMode = project && project.figmaScopeMode;
  if (VALID_FIGMA_SCOPE_MODES.has(projectMode)) return projectMode;

  return FIGMA_SCOPE_ENTIRE_FILE;
}

function normalizeTrackedFigmaFiles(rawTrackedFiles) {
  const { FigmaParser } = require('./parsers/figma');

  return (Array.isArray(rawTrackedFiles) ? rawTrackedFiles : [])
    .map((entry) => {
      if (typeof entry === 'string') {
        const trimmed = entry.trim();
        if (!trimmed) return null;
        const parsedKey = FigmaParser.extractFileKey(trimmed);
        return {
          key: parsedKey || trimmed,
          url: parsedKey ? trimmed : null,
        };
      }

      if (!entry || typeof entry !== 'object') return null;
      const key = typeof entry.key === 'string' ? entry.key.trim() : '';
      if (!key) return null;
      const url = typeof entry.url === 'string' && entry.url.trim() ? entry.url.trim() : null;
      return { key, url };
    })
    .filter(Boolean);
}

function projectHasFigmaTrackedFiles(project) {
  if (!project || !Array.isArray(project.figmaTrackedFiles)) return false;
  return project.figmaTrackedFiles.some((entry) => {
    if (typeof entry === 'string') return !!entry.trim();
    return !!(entry && typeof entry.key === 'string' && entry.key.trim());
  });
}

function rebuildFigmaSessionWarnings(session) {
  if (!session || typeof session !== 'object') return [];

  const warnings = [];
  const seen = new Set();
  const pushWarning = (warning) => {
    if (typeof warning !== 'string') return;
    const trimmed = warning.trim();
    if (!trimmed || seen.has(trimmed)) return;
    warnings.push(trimmed);
    seen.add(trimmed);
  };

  for (const warning of session.sessionWarnings || []) {
    pushWarning(warning);
  }
  for (const trackedFile of session.trackedFiles || []) {
    pushWarning(trackedFile && trackedFile.warning);
  }

  return warnings;
}

function buildFigmaSessionSnapshot(project, _settings = {}) {
  const { FigmaParser } = require('./parsers/figma');

  const scopeMode = VALID_FIGMA_SCOPE_MODES.has(project && project.figmaScopeMode)
    ? project.figmaScopeMode
    : FIGMA_SCOPE_ENTIRE_FILE;
  const trackedFiles = normalizeTrackedFigmaFiles((project && project.figmaTrackedFiles) || []);
  const sessionWarnings = [];

  const snapshot = {
    scopeMode,
    startedAt: project.watchStartedAt || Date.now(),
    teamIds: [],
    trackedFiles: trackedFiles.map((trackedFile) => {
      const parsedScope = trackedFile.url
        ? FigmaParser.parseScopeFromTrackedUrl(trackedFile.url)
        : { requestedPageId: null, requestedNodeId: null };

      let lockStatus = scopeMode === FIGMA_SCOPE_CURRENT_PAGE ? 'pending' : 'entire-file';
      let warning = null;
      let lockedPageId = null;

      if (scopeMode === FIGMA_SCOPE_CURRENT_PAGE) {
        if (!trackedFile.url) {
          lockStatus = 'unresolved';
          warning = `Current Page Only could not be locked for Figma file ${trackedFile.key} because this session does not have a page-linked URL snapshot. No Figma assets will be captured for this file in this session.`;
        } else if (!parsedScope.requestedPageId && !parsedScope.requestedNodeId) {
          lockStatus = 'unresolved';
          warning = `Current Page Only could not be locked from the tracked Figma URL for file ${trackedFile.key}. No Figma assets will be captured for this file in this session.`;
        } else if (parsedScope.requestedPageId) {
          lockStatus = 'locked';
          lockedPageId = parsedScope.requestedPageId;
        }
      }

      return {
        key: trackedFile.key,
        url: trackedFile.url,
        requestedPageId: parsedScope.requestedPageId || null,
        requestedNodeId: parsedScope.requestedNodeId || null,
        lockStatus,
        lockedPageId,
        lockedPageName: null,
        scopeMode,
        warning,
      };
    }),
    sessionWarnings,
  };

  snapshot.warnings = rebuildFigmaSessionWarnings(snapshot);
  return snapshot;
}

function ensureProjectFigmaSession(projectId) {
  const project = getProjects().find(p => p.id === projectId);
  if (!project) return null;

  const existingSession = project.figmaSession;
  const currentScopeMode = getProjectFigmaScopeMode(project);
  if (
    existingSession &&
    existingSession.startedAt === project.watchStartedAt &&
    existingSession.scopeMode === currentScopeMode
  ) {
    return existingSession;
  }

  const settings = store.get('settings') || {};
  return mutateProject(projectId, (proj) => {
    proj.figmaSession = buildFigmaSessionSnapshot(proj, settings);
    return proj.figmaSession;
  });
}

function mergeFigmaScopeEntriesIntoSession(projectId, scopeEntries = []) {
  if (!Array.isArray(scopeEntries) || scopeEntries.length === 0) return null;

  return mutateProject(projectId, (project) => {
    if (!project.figmaSession || !Array.isArray(project.figmaSession.trackedFiles)) return null;

    const scopeByKey = new Map(
      scopeEntries
        .filter(entry => entry && typeof entry.fileKey === 'string' && entry.fileKey.trim())
        .map(entry => [entry.fileKey.trim(), entry])
    );

    let changed = false;
    for (const trackedFile of project.figmaSession.trackedFiles) {
      const nextScope = scopeByKey.get(trackedFile.key);
      if (!nextScope) continue;

      const nextLockStatus = typeof nextScope.lockStatus === 'string' ? nextScope.lockStatus : trackedFile.lockStatus;
      const nextLockedPageId = nextScope.lockedPageId != null ? nextScope.lockedPageId : trackedFile.lockedPageId;
      const nextLockedPageName = nextScope.lockedPageName != null ? nextScope.lockedPageName : trackedFile.lockedPageName;
      const nextWarning = nextScope.warning != null ? nextScope.warning : trackedFile.warning;

      if (trackedFile.lockStatus !== nextLockStatus) {
        trackedFile.lockStatus = nextLockStatus;
        changed = true;
      }
      if (trackedFile.lockedPageId !== nextLockedPageId) {
        trackedFile.lockedPageId = nextLockedPageId;
        changed = true;
      }
      if (trackedFile.lockedPageName !== nextLockedPageName) {
        trackedFile.lockedPageName = nextLockedPageName;
        changed = true;
      }
      if (trackedFile.warning !== nextWarning) {
        trackedFile.warning = nextWarning;
        changed = true;
      }
    }

    const nextWarnings = rebuildFigmaSessionWarnings(project.figmaSession);
    const previousWarnings = Array.isArray(project.figmaSession.warnings) ? project.figmaSession.warnings : [];
    if (JSON.stringify(previousWarnings) !== JSON.stringify(nextWarnings)) {
      project.figmaSession.warnings = nextWarnings;
      changed = true;
    }

    return changed ? { figmaSession: project.figmaSession } : null;
  });
}

function shouldIncludeFigmaAssetForPackaging(file, project) {
  if (!file || file.source !== 'figma-auto') return true;

  if (getProjectFigmaScopeMode(project) !== FIGMA_SCOPE_CURRENT_PAGE) {
    return true;
  }

  const session = project && project.figmaSession;
  if (!session || !Array.isArray(session.trackedFiles)) {
    return false;
  }

  const trackedFile = session.trackedFiles.find(entry => entry.key === file.figmaFileKey);
  if (!trackedFile || trackedFile.lockStatus !== 'locked' || !trackedFile.lockedPageId) {
    return false;
  }

  return file.figmaPageId === trackedFile.lockedPageId;
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

// Design-relevant file extensions — the full set used by lsof polling and scan-on-open.
// v2.2.6: chokidar 'add'/'change' handlers now only act on PRIMARY_DESIGN_EXTENSIONS.
// Image/media/font/pdf files are captured exclusively by lsof polling, which is reliable.
const DESIGN_FILE_EXTENSIONS = new Set([
  // Native design app formats
  '.psd', '.ai', '.indd', '.idml', '.sketch', '.fig', '.xd',
  '.afdesign', '.afphoto', '.afpub',
  // .procreate removed — no parser exists (zip archive with proprietary binary)
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

// Primary design source files — the ONLY extensions captured by chokidar 'add'/'change'.
// All other file types (images, video, audio, pdf, svg, fonts) are captured exclusively
// by lsof polling, which correctly detects when a design app actually opens them.
const PRIMARY_DESIGN_EXTENSIONS = new Set([
  '.ai', '.psd', '.indd', '.idml', '.fig', '.sketch', '.xd',
  '.afdesign', '.afphoto', '.afpub', '.key', '.pptx', '.pxd',
]);

// Package-time confirmation window for source docs that were only observed via lsof.
// We keep downstream/derived assets intact and only require extra proof for plain
// source files that could have been admitted because another supported app was open.
const PACKAGE_LSOF_SOURCE_CONFIRMATION_GRACE_MS = 5000;

// v2.3.2: Image/media extensions captured by chokidar ONLY when a design app is running.
// Restores Photoshop drag-and-embed capture (macOS records no lsof/mtime for embedded images)
// while avoiding false positives from Finder thumbnail generation.
const CHOKIDAR_IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.tif', '.tiff', '.heic',
  '.svg', '.eps', '.pdf', '.mp4', '.mov', '.m4v',
]);

// v2.5.3: Apps whose lsof entries should NOT capture image files.
// Preview, Quick Look, and Finder open screenshots/PSDs for thumbnails — not real design work.
const LSOF_SKIP_APPS = ['Preview', 'QuickLookUIService', 'QuickLookSatellite', 'Finder', 'mdworker', 'mds', 'mds_stores', 'com.apple.quicklook'];

// v2.5.3: Image extensions subject to stricter lsof filtering (app + directory check).
// Design source files (.psd, .ai, .key, .pptx, etc.) are NOT filtered — only common images.
const LSOF_IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.tif', '.tiff', '.heic',
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
    const result = execFileSync("/usr/bin/mdls", ["-name", "kMDItemCreatorApplicationIdentifier", "-raw", filePath], {
      timeout: 2000, encoding: 'utf8'
    }).trim();
    if (!result || result === '(null)') return null;
    return result || null;
  } catch (e) {
    return null;
  }
}

function isObservedPrimarySourceFile(file) {
  if (!file || file.embedded) return false;
  const ext = (file.ext || path.extname(file.path || '')).toLowerCase();
  return file.source === 'lsof' && PRIMARY_DESIGN_EXTENSIONS.has(ext);
}

async function getSourceFileSessionEvidence(filePath) {
  const evidence = {
    mtimeMs: 0,
    birthtimeMs: 0,
    lastUsedMs: 0,
  };

  try {
    const stat = await fs.promises.stat(filePath);
    evidence.mtimeMs = stat.mtimeMs || 0;
    evidence.birthtimeMs = stat.birthtimeMs || 0;
  } catch (e) {
    // File may have been deleted between capture and package time.
  }

  evidence.lastUsedMs = await getMdlsLastUsedMs(filePath) || await getXattrLastUsedMs(filePath) || 0;
  return evidence;
}

async function shouldKeepObservedSourceFileForPackaging(file, project) {
  const watchStart = project.watchStartedAt || project.createdAt || 0;
  if (!watchStart || !file || !file.path) return true;

  const evidence = await getSourceFileSessionEvidence(file.path);
  const savedDuringSession = evidence.mtimeMs >= watchStart || evidence.birthtimeMs >= watchStart;
  if (savedDuringSession) return true;

  const firstObservedAt = typeof file.addedAt === 'number' ? file.addedAt : 0;
  const confirmationThreshold = firstObservedAt > (watchStart + PACKAGE_LSOF_SOURCE_CONFIRMATION_GRACE_MS)
    ? watchStart
    : (watchStart + PACKAGE_LSOF_SOURCE_CONFIRMATION_GRACE_MS);

  // Plain lsof hits are the contamination path: require a post-startup last-used signal
  // before we package a primary source doc that was only "seen open".
  return evidence.lastUsedMs >= confirmationThreshold;
}

async function selectProjectFilesForPackaging(project) {
  const dedupedFiles = deduplicateFiles(project.files || []);
  const packageFiles = [];

  for (const file of dedupedFiles) {
    if (getProjectFigmaScopeMode(project) === FIGMA_SCOPE_CURRENT_PAGE && file.ext === '.fig') {
      console.log(`[crate][package] skipped .fig file for current-page Figma session: ${file.path}`);
      continue;
    }

    if (!shouldIncludeFigmaAssetForPackaging(file, project)) {
      console.log(
        `[crate][package] filtered out-of-scope Figma asset: ${file.path} ` +
        `(fileKey=${file.figmaFileKey || 'unknown'} pageId=${file.figmaPageId || 'unknown'})`
      );
      continue;
    }

    if (!isObservedPrimarySourceFile(file)) {
      packageFiles.push(file);
      continue;
    }

    if (await shouldKeepObservedSourceFileForPackaging(file, project)) {
      packageFiles.push(file);
      continue;
    }

    console.log(
      `[crate][package] filtered stale observed source file: ${file.path} ` +
      `(source=${file.source || 'unknown'} ext=${file.ext || path.extname(file.path || '').toLowerCase()})`
    );
  }

  return deduplicateFiles(packageFiles);
}

// projectType: optional — if provided, Check 1 is scoped to that type's app list.
// Extension fallback (Check 2) always applies regardless of type.
// Renderer-callable utility — may be invoked via IPC from the renderer process
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

// Async Check-1-only variant: verifies the file was created/last-used by a known
// design app (via mdls). Does NOT fall back to extension matching — used by the
// chokidar 'add' handler to reject files that merely have a design extension but
// were never touched by a design app (e.g. browser downloads).
// Renderer-callable utility — may be invoked via IPC from the renderer process
async function isCreatedByDesignApp(filePath, projectType = null) {
  try {
    const { stdout } = await execFileAsync("/usr/bin/mdls", ["-name", "kMDItemCreatorApplicationIdentifier", "-raw", filePath], {
      timeout: 2000, encoding: 'utf8'
    });
    const creatorApp = stdout.trim();
    if (!creatorApp || creatorApp === '(null)') return false;
    const relevantApps = (projectType && PROJECT_TYPE_APPS[projectType])
      ? PROJECT_TYPE_APPS[projectType]
      : DESIGN_APP_BUNDLE_IDS;
    return relevantApps.has(creatorApp);
  } catch (e) {
    return false;
  }
}

// v2.2.5: Real-time check — is a design app currently holding this file open?
// Uses lsof to get PIDs with the file open, then cross-references with ps
// to identify design app processes (avoids lsof COMMAND truncation issues).
// Renderer-callable utility — may be invoked via IPC from the renderer process
async function isFileOpenByDesignApp(filePath) {
  try {
    const { stdout: lsofOut } = await execFileAsync('/usr/sbin/lsof', ['-F', 'p', filePath], {
      timeout: 3000, encoding: 'utf8'
    });
    if (!lsofOut || !lsofOut.trim()) return false;
    const filePids = new Set();
    for (const line of lsofOut.trim().split('\n')) {
      if (line.startsWith('p')) filePids.add(parseInt(line.substring(1)));
    }
    if (filePids.size === 0) return false;
    const { stdout: psOut } = await execFileAsync('/bin/ps', ['ax', '-o', 'pid=', '-o', 'command='], {
      timeout: 5000, encoding: 'utf8'
    });
    if (!psOut) return false;
    const allKeywords = Object.values(DESIGN_APP_PROCESS_NAMES).flat();
    for (const line of psOut.trim().split('\n')) {
      const m = line.trim().match(/^\s*(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = parseInt(m[1]);
      if (!filePids.has(pid)) continue;
      if (allKeywords.some(kw => m[2].includes(kw))) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

// Inactivity threshold — configurable constant
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_PARSE_FILE_SIZE = 300 * 1024 * 1024; // 300MB — guard against OOM on huge PSD/AI files
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
      notifications: true
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

  // v2.7.0 (Phase 2): Figma link moved per-project. Drop deprecated global
  // settings.figmaTrackedFiles and settings.figmaTeamIds — users re-link
  // through the per-project Edit Figma Link UI.
  if (settings.figmaTrackedFiles !== undefined) {
    store.delete('settings.figmaTrackedFiles');
  }
  if (settings.figmaTeamIds !== undefined) {
    store.delete('settings.figmaTeamIds');
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

// v2.4.2: Validated accessor — always returns an array even if store is corrupted/missing
function getProjects() {
  const val = store.get('projects', []);
  return Array.isArray(val) ? val : [];
}

function safelyEnsureProjectProvenance(project) {
  try {
    ensureProjectProvenance(project);
  } catch (e) {
    console.warn('[crate][provenance] initialization skipped:', e.message);
  }
}

function getProjectProvenanceSessionId(project, provenance) {
  if (provenance && typeof provenance.sessionId === 'string' && provenance.sessionId.trim()) {
    return provenance.sessionId.trim();
  }

  const sessionId = createNodeId(NODE_TYPES.SESSION, {
    projectId: project.id || null,
    watchStartedAt: project.watchStartedAt || null,
    createdAt: project.createdAt || null,
  });
  if (provenance) provenance.sessionId = sessionId;
  return sessionId;
}

function recordSessionObservedFile(project, fileEntry, observer = {}) {
  try {
    if (!project || !fileEntry || typeof fileEntry.path !== 'string' || !fileEntry.path.trim()) return;
    const provenance = ensureProjectProvenance(project);
    if (!provenance) return;

    const normalizedPath = normalizeTrackedFilePath(fileEntry.path);
    if (!normalizedPath) return;

    const sessionId = getProjectProvenanceSessionId(project, provenance);
    const fileNodeId = createNodeId(NODE_TYPES.FILE, { normalizedPath });
    const method = typeof observer.method === 'string' && observer.method.trim()
      ? observer.method.trim()
      : 'unknown';
    const observerKind = typeof observer.kind === 'string' && observer.kind.trim()
      ? observer.kind.trim()
      : 'unknown';
    const confidence = observerKind === OBSERVER_KINDS.MANUAL_USER_ACTION
      ? CONFIDENCE_BANDS.CONFIRMED
      : CONFIDENCE_BANDS.CANDIDATE;

    provenance.nodes[sessionId] = {
      ...(provenance.nodes[sessionId] || {}),
      id: sessionId,
      type: NODE_TYPES.SESSION,
      projectId: project.id || null,
      startedAt: project.watchStartedAt || project.createdAt || null,
      status: project.status || null,
    };
    provenance.nodes[fileNodeId] = {
      ...(provenance.nodes[fileNodeId] || {}),
      id: fileNodeId,
      type: NODE_TYPES.FILE,
      path: fileEntry.path,
      normalizedPath,
      name: fileEntry.name || path.basename(fileEntry.path),
      ext: fileEntry.ext || path.extname(fileEntry.path).toLowerCase(),
      source: fileEntry.source || null,
    };

    const observedAt = fileEntry.addedAt || Date.now();
    const observation = createObservationRecord({
      projectId: project.id || null,
      sessionId,
      observedAt,
      observer: {
        ...observer,
        kind: observerKind,
        method,
      },
      kind: EDGE_TYPES.SESSION_OBSERVED_FILE,
      subjectNodeId: sessionId,
      objectNodeId: fileNodeId,
      relationType: EDGE_TYPES.SESSION_OBSERVED_FILE,
      confidence,
      dedupeKey: createDedupeKey(
        project.id || 'unknown_project',
        sessionId,
        method,
        EDGE_TYPES.SESSION_OBSERVED_FILE,
        normalizedPath
      ),
      payload: {
        source: fileEntry.source || null,
      },
    });
    appendObservation(provenance, observation);
  } catch (e) {
    console.warn('[crate][provenance] session_observed_file skipped:', e.message);
  }
}

function recordPendingFileDecision(project, fileEntry, decision) {
  try {
    if (!project || !fileEntry || typeof fileEntry.path !== 'string' || !fileEntry.path.trim()) return;

    if (decision === 'accepted') {
      recordSessionObservedFile(project, fileEntry, {
        kind: OBSERVER_KINDS.MANUAL_USER_ACTION,
        method: 'projects:accept-pending',
      });
      return;
    }

    if (decision !== 'rejected') return;

    const provenance = ensureProjectProvenance(project);
    if (!provenance) return;

    const normalizedPath = normalizeTrackedFilePath(fileEntry.path);
    if (!normalizedPath) return;

    const sessionId = getProjectProvenanceSessionId(project, provenance);
    const fileNodeId = createNodeId(NODE_TYPES.FILE, { normalizedPath });
    const method = 'projects:reject-pending';
    const relationType = 'pending_file_rejected';

    provenance.nodes[sessionId] = {
      ...(provenance.nodes[sessionId] || {}),
      id: sessionId,
      type: NODE_TYPES.SESSION,
      projectId: project.id || null,
      startedAt: project.watchStartedAt || project.createdAt || null,
      status: project.status || null,
    };
    provenance.nodes[fileNodeId] = {
      ...(provenance.nodes[fileNodeId] || {}),
      id: fileNodeId,
      type: NODE_TYPES.FILE,
      path: fileEntry.path,
      normalizedPath,
      name: fileEntry.name || path.basename(fileEntry.path),
      ext: fileEntry.ext || path.extname(fileEntry.path).toLowerCase(),
      source: fileEntry.source || null,
    };

    const observation = createObservationRecord({
      projectId: project.id || null,
      sessionId,
      observedAt: Date.now(),
      observer: {
        kind: OBSERVER_KINDS.MANUAL_USER_ACTION,
        method,
      },
      kind: relationType,
      subjectNodeId: sessionId,
      objectNodeId: fileNodeId,
      relationType,
      confidence: CONFIDENCE_BANDS.WEAK,
      dedupeKey: createDedupeKey(
        project.id || 'unknown_project',
        sessionId,
        method,
        relationType,
        normalizedPath
      ),
      payload: {
        decision: 'rejected',
        source: fileEntry.source || null,
      },
    });
    appendObservation(provenance, observation);
  } catch (e) {
    console.warn('[crate][provenance] pending decision skipped:', e.message);
  }
}

// FIX 1 (C1): Atomic store helper — prevents read-mutate-write race conditions
function mutateProject(projectId, fn) {
  const projects = getProjects();
  const project = projects.find(p => p.id === projectId);
  if (!project) return null;
  const result = fn(project, projects);
  if (!Array.isArray(project.files)) {
    project.files = [];
  } else {
    project.files = deduplicateFiles(project.files);
  }
  safelyEnsureProjectProvenance(project);
  store.set('projects', projects);
  return result;
}

// FIX 2 (C2): Track in-flight pre-package scans
const scanInFlight = new Set();

// C1: In-flight lock for confirmPackage / projects:package
let packageInFlight = false;

let tray = null;
let trayWindow = null;
const watchers = new Map(); // projectId -> chokidar watcher
const lastFileActivity = new Map(); // projectId -> timestamp
const inactivityNotified = new Set(); // projectIds already notified

function sendToRenderer(channel, data) {
  if (trayWindow && !trayWindow.isDestroyed()) {
    trayWindow.webContents.send(channel, data);
  }
}

function cleanName(s) {
  const cleaned = s.replace(/[^a-zA-Z0-9 ._\-()]/g, '').replace(/\s+/g, ' ').trim();
  return cleaned || 'Untitled';
}

function sanitizeEmbeddedPsdAssetName(rawName, fallbackName = 'embedded-asset') {
  const fallback = `${fallbackName}`.replace(/[^a-zA-Z0-9 ._\-()]/g, '').trim() || 'embedded-asset';
  const normalized = `${rawName || ''}`.replace(/\\/g, '/');
  let name = path.basename(normalized).replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').replace(/\s+/g, ' ').trim();
  name = name.replace(/^\.+/, '');
  if (!name) name = fallback;
  if (name.length > 160) {
    const ext = path.extname(name);
    const base = path.basename(name, ext).slice(0, Math.max(1, 160 - ext.length));
    name = `${base}${ext}`;
  }
  return name;
}

function reserveUniqueName(name, usedNames) {
  const safeName = sanitizeEmbeddedPsdAssetName(name);
  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext);
  let candidate = safeName;
  let counter = 1;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${base}_${counter}${ext}`;
    counter++;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function getEmbeddedPsdDedupKey(file) {
  const parent = normalizeTrackedFilePath(file.parentPsd || file.path || '');
  const index = Number.isInteger(file.embeddedIndex) ? file.embeddedIndex : '';
  const originalName = typeof file.embeddedOriginalName === 'string' ? file.embeddedOriginalName : '';
  const safeName = sanitizeEmbeddedPsdAssetName(file.name || originalName);
  return `embedded-psd:${parent}:${index}:${originalName || safeName}`;
}

function getTrackedFileDedupKey(file) {
  if (file && file.embedded && file.source === 'scan-on-save-embedded') {
    return getEmbeddedPsdDedupKey(file);
  }
  return normalizeTrackedFilePath(file.path);
}

// --- lsof Polling (Tier 1 linked-asset capture) ---

const lsofPollers = new Map();   // projectId -> setInterval id
const lsofInProgress = new Set(); // projectIds currently mid-poll (prevent overlap)
// v2.4.2: per-project, keyed by projectId. Intentional ~3s staleness (lsof poll interval)
// — acceptable trade-off to avoid calling ps on every file event.
const designAppRunningCache = new Map();

// --- Figma Auto-Tracking ---
const figmaPollers = new Map();    // projectId -> setInterval id
const figmaPollerStarting = new Set(); // guard: projectIds with initial poll in progress
const figmaInProgress = new Set(); // projectIds currently mid-poll
const figmaManualScanInFlight = new Set(); // projectIds currently running a manual Scan Now
const figmaScanTimestamps = new Map(); // projectId -> last scan timestamp (ms)
const FIGMA_POLL_INTERVAL_MS = 60000; // 60 seconds
// Keep a narrow overlap between incremental polls so a just-added image ref can't
// fall behind a hard since-cutoff while Figma's file metadata/tree finishes updating.
const FIGMA_INCREMENTAL_OVERLAP_MS = FIGMA_POLL_INTERVAL_MS * 2; // 2 minutes
const FIGMA_ASSETS_DIR = path.join(os.homedir(), '.crate', 'figma-assets');

// --- Photoshop + InDesign Polling (v2.3.0) ---
const psPollers = new Map();          // projectId -> setInterval id
const psPollerStarting = new Set();   // guard: projectIds with initial poll in progress
const psInProgress = new Set();       // projectIds currently mid-poll
const PS_POLL_INTERVAL_MS = 3000;     // 3 seconds

// --- PSD binary parser debounce (v2.3.6) ---
const psdParseDebounce = new Map();   // psdFilePath -> lastParsedTimestamp

// v2.5.0: Scan-on-save debounce timers for PSD files (2-second debounce)
const scanOnSaveTimers = new Map();   // psdFilePath -> setTimeout id

// v2.5.3: Scan-on-save debounce timers for presentation files (2-second debounce)
const scanOnSavePresentationTimers = new Map(); // key -> setTimeout id

// --- Real-time kMDItemLastUsedDate Polling (v2.3.3) ---
const lastUsedPollers = new Map();    // projectId -> intervalId
const LAST_USED_POLL_MS = 10000;      // 10 seconds

// Get PIDs of running design apps relevant to a project type.
// Uses `ps ax -o pid= -o command=` which gives full app paths (not truncated like lsof COMMAND).
function getRunningDesignAppPids(projectType, callback) {
  const keywords = DESIGN_APP_PROCESS_NAMES[projectType]
    // Fallback: all known keywords if type not recognized
    || Object.values(DESIGN_APP_PROCESS_NAMES).flat();

  exec('/bin/ps ax -o pid= -o command= 2>/dev/null', { timeout: 5000 }, (err, stdout) => {
    if (err && !stdout) { callback([], new Map()); return; }
    const pids = [];
    const pidToCmd = new Map(); // v2.5.3: PID → command string for lsof image filtering
    for (const line of stdout.trim().split('\n')) {
      const m = line.trim().match(/^\s*(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = parseInt(m[1]);
      const cmd = m[2];
      if (keywords.some(kw => cmd.includes(kw))) {
        pids.push(pid);
        pidToCmd.set(pid, cmd);
      }
    }
    callback(pids, pidToCmd);
  });
}

// Poll lsof for a single watching project. Runs every LSOF_POLL_MS.
// Finds files that design apps have open (reads + writes) in watched dirs → Tier 1 auto-capture.
function pollLsofForProject(projectId) {
  if (lsofInProgress.has(projectId)) return; // skip if already running for this project

  const currentProjects = getProjects();
  const project = currentProjects.find(p => p.id === projectId);
  if (!project || project.status !== 'watching') return;

  lsofInProgress.add(projectId);

  getRunningDesignAppPids(project.type, (pids, pidToCmd) => {
    designAppRunningCache.set(projectId, pids.length > 0); // v2.4.2: per-project
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
    // v2.2.2: Include PID in lsof output for scan-on-open re-open detection.
    const cmd = `/usr/sbin/lsof -F ptn -p ${pidArg} 2>/dev/null`;

    exec(cmd, { timeout: 12000 }, (err, stdout) => {
      lsofInProgress.delete(projectId);
      if (!stdout) return;

      const parsedLines = stdout.trim().split('\n');

      // v2.2.2: Build a map of filePath -> Set<pid> from this poll cycle
      // for scan-on-open re-open detection.
      const currentPollFiles = new Map(); // filePath -> Set<pid>
      let currentPid = null;
      let currentType = null;

      // First pass: collect all design files and their PIDs
      for (const line of parsedLines) {
        if (line.length === 0) continue;
        const tag = line[0];
        const value = line.slice(1);

        if (tag === 'p') {
          currentPid = parseInt(value);
          currentType = null;
          continue;
        }
        if (tag === 'f') { currentType = null; continue; }
        if (tag === 't') { currentType = value; continue; }
        if (tag !== 'n') continue;
        if (currentType !== 'REG') { currentType = null; continue; }

        const filePath = value;
        currentType = null;

        const ext = path.extname(filePath).toLowerCase();
        if (SCAN_ON_OPEN_EXTENSIONS.has(ext) && currentPid) {
          if (!currentPollFiles.has(filePath)) currentPollFiles.set(filePath, new Set());
          currentPollFiles.get(filePath).add(currentPid);
        }
      }

      // v2.2.2: Detect first-open and re-open for scan-on-open
      if (!scannedDesignFiles.has(projectId)) scannedDesignFiles.set(projectId, new Set());
      if (!designFilePids.has(projectId)) designFilePids.set(projectId, new Map());
      const scanned = scannedDesignFiles.get(projectId);
      const prevPids = designFilePids.get(projectId);

      const filesToScan = [];
      for (const [filePath, pids] of currentPollFiles) {
        const wasScanned = scanned.has(filePath);
        const prevFilePids = prevPids.get(filePath);

        if (!wasScanned) {
          // First time seeing this design file open → scan it
          filesToScan.push(filePath);
          scanned.add(filePath);
        } else if (prevFilePids && prevFilePids.size === 0 && pids.size > 0) {
          // File was closed (no PIDs last cycle) and re-opened → re-scan
          filesToScan.push(filePath);
        }
      }

      // Update PID tracking: mark files no longer open as having empty PID set
      for (const [filePath, prevPidSet] of prevPids) {
        if (!currentPollFiles.has(filePath)) {
          // v2.2.3: Scan-on-close — re-scan file that just closed to catch final-save assets
          if (prevPidSet.size > 0) {
            runScanOnOpen(projectId, filePath).catch(() => {});
          }
          prevPids.set(filePath, new Set()); // closed
        }
      }
      for (const [filePath, pids] of currentPollFiles) {
        prevPids.set(filePath, pids);
      }

      // Fire-and-forget: run scan-on-open for newly detected design files
      for (const filePath of filesToScan) {
        runScanOnOpen(projectId, filePath).catch(() => {});
      }

      // Second pass: standard lsof file capture (same as before, minus mtime filter)
      currentPid = null;
      currentType = null;

      const result = mutateProject(projectId, (proj) => {
        if (proj.status !== 'watching') return { changed: false };

        const existingPaths = new Set(proj.files.map(f => f.path));
        const pendingPaths = new Set((proj.pendingFiles || []).map(f => f.path));

        // v2.5.3: Directory scoping — derive project root from existing files to prevent
        // cross-project contamination when multiple projects are open in the same design app
        // (e.g. Photoshop with two projects open: lsof sees ALL files from BOTH).
        // Prefer non-lsof sources (scan-on-save, scan-on-open, etc.) as anchors since they're
        // explicitly tied to this project. Fall back to lsof-sourced files if that's all we have.
        const nonLsofFiles = proj.files.filter(f => f.source && f.source !== 'lsof');
        const anchorFiles = nonLsofFiles.length > 0 ? nonLsofFiles : proj.files;
        // Compute shortest common ancestor of ALL anchor files (not just the first).
        // This prevents locking onto a deep subdirectory if the first anchor happened to be
        // nested (e.g. /Project/assets/icons/logo.png → root should be /Project/, not /icons/).
        // projectRoot = null when project has no files yet — scoping is skipped entirely.
        let projectRoot = null;
        if (anchorFiles.length > 0) {
          const anchorDirs = anchorFiles.map(f => path.dirname(f.path).split('/'));
          const firstParts = anchorDirs[0];
          let commonDepth = firstParts.length;
          for (let i = 1; i < anchorDirs.length; i++) {
            const parts = anchorDirs[i];
            let j = 0;
            while (j < commonDepth && j < parts.length && parts[j] === firstParts[j]) j++;
            commonDepth = j;
          }
          projectRoot = firstParts.slice(0, commonDepth).join('/') || '/';
        }

        let changed = false;

        for (const line of parsedLines) {
          if (line.length === 0) continue;
          const tag = line[0];
          const value = line.slice(1);

          if (tag === 'p') {
            currentPid = parseInt(value);
            currentType = null;
            continue;
          }
          if (tag === 'f') {
            currentType = null;
            continue;
          }

          if (tag === 't') {
            currentType = value;
            continue;
          }

          if (tag !== 'n') continue;
          if (currentType !== 'REG') {
            currentType = null;
            continue;
          }

          const filePath = value;
          currentType = null;

          if (!filePath.startsWith(home + '/')) continue;
          if (filePath.startsWith(home + '/Library/')) {
            if (path.extname(filePath).toLowerCase() !== '.fig') continue;
          }
          if (filePath.includes('/.')) continue;
          if (filePath.includes('.app/Contents/')) continue;

          const RESTRICTED_LSOF_TYPES = new Set(['presentation']);
          if (RESTRICTED_LSOF_TYPES.has(proj.type)) {
            const isInWatchedDir = filePath.startsWith(home + '/Desktop/') ||
                                   filePath.startsWith(home + '/Documents/') ||
                                   filePath.startsWith(home + '/Downloads/');
            if (!isInWatchedDir) continue;
          }

          // v2.5.5: Never capture presentation source files (.pptx, .key, etc.) via lsof.
          // When PowerPoint or Keynote has multiple presentations open, lsof sees all of them.
          // These source files are not linked assets — their embedded content is extracted via
          // scan-on-save instead. Capturing a second open presentation is always a false positive.
          const PRESENTATION_SOURCE_EXTS = new Set(['.pptx', '.pptm', '.ppt', '.key', '.keynote']);
          if (PRESENTATION_SOURCE_EXTS.has(path.extname(filePath).toLowerCase())) continue;

          // v2.5.3: Directory scoping — reject lsof hits outside project root.
          // v2.6.4: Also exempt files in Desktop/Documents/Downloads — these are the user's
          // intentional workspace dirs (same ones chokidar watches). Scoping was dropping images
          // dragged from ~/Downloads into Figma because ~/Downloads is outside the project root.
          const extForScope = path.extname(filePath).toLowerCase();
          const isInAllowedDirForScope = filePath.startsWith(home + '/Desktop/') ||
                                          filePath.startsWith(home + '/Documents/') ||
                                          filePath.startsWith(home + '/Downloads/');
          if (projectRoot !== null && !isInAllowedDirForScope && !filePath.startsWith(projectRoot + '/')) continue;

          if (existingPaths.has(filePath)) continue;
          if (pendingPaths.has(filePath)) continue;

          if (path.basename(filePath).startsWith('~$')) continue;

          const ext = path.extname(filePath).toLowerCase();
          if (!DESIGN_FILE_EXTENSIONS.has(ext)) continue;

          // New project guard: when no file anchors exist yet, only allow primary
          // design source files to seed the project. This prevents stale open image
          // handles (e.g. old Figma cache assets) from populating a brand-new project.
          if (projectRoot === null && !PRIMARY_DESIGN_EXTENSIONS.has(ext)) continue;

          // v2.5.3: Stricter filtering for image files captured via lsof.
          // Preview, Quick Look, Finder, and Spotlight open images for thumbnails —
          // these are NOT real design-app usage. Only capture images if:
          //   (a) the file is in ~/Desktop, ~/Documents, or ~/Downloads
          //   (b) AND the process is NOT a known thumbnail/preview app
          if (LSOF_IMAGE_EXTENSIONS.has(ext)) {
            const isInAllowedDir = filePath.startsWith(home + '/Desktop/') ||
                                   filePath.startsWith(home + '/Documents/') ||
                                   filePath.startsWith(home + '/Downloads/');
            if (!isInAllowedDir) continue;

            // v2.5.4: Skip macOS screenshots — always named "Screenshot..." or "Screen Shot..."
            // Design apps (e.g. Keynote) can briefly open screenshots during thumbnail/paste
            // operations, causing false captures. Screenshots are never intentional project assets.
            const basename = path.basename(filePath);
            if (/^Screen.?Shot/i.test(basename)) continue;

            const cmd = currentPid ? pidToCmd.get(currentPid) || '' : '';
            if (LSOF_SKIP_APPS.some(app => cmd.includes(app))) {
              continue;
            }
          }

          // v2.2.2: Removed presentation mtime filter — old files on disk placed
          // mid-session should be captured when opened by a design app.

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
        }
        return { changed, files: proj.files };
      });

      if (result && result.changed && trayWindow && !trayWindow.isDestroyed()) {
        trayWindow.webContents.send('files:updated', { projectId, files: result.files });
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

// --- Figma Auto-Tracking Functions ---

/**
 * Ensure Figma assets directory exists.
 */
function ensureFigmaAssetsDir() {
  if (!fs.existsSync(FIGMA_ASSETS_DIR)) {
    fs.mkdirSync(FIGMA_ASSETS_DIR, { recursive: true });
  }
  return FIGMA_ASSETS_DIR;
}

/**
 * Download a Figma asset from CDN URL to local disk.
 * @returns {Promise<string|null>} Local file path or null on failure
 */
async function downloadFigmaAsset(url, fileName, projectId, format = 'png') {
  try {
    const response = await fetch(url, { timeout: 30000 });
    if (!response.ok) return null;

    const buffer = await response.buffer();
    if (buffer.length === 0) return null;

    // Create project-specific subdir
    const projectDir = path.join(FIGMA_ASSETS_DIR, projectId);
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    // v2.4.2: Use actual format from Figma API if available, fall back to png
    const ext = format || 'png';
    const safeName = fileName.replace(/[^a-zA-Z0-9_\-.]/g, '_').substring(0, 100);
    const localPath = path.join(projectDir, `${safeName}.${ext}`);

    // Skip if already exists with same size
    if (fs.existsSync(localPath)) {
      const existingSize = fs.statSync(localPath).size;
      if (existingSize === buffer.length) return localPath;
    }

    fs.writeFileSync(localPath, buffer);
    console.log(`[crate][figma] downloaded asset: ${path.basename(localPath)}`);
    return localPath;
  } catch (e) {
    console.error('[crate][figma] downloadFigmaAsset error:', e.message);
    return null;
  }
}

/**
 * Download Figma scan assets and insert them into project state.
 * @returns {Promise<number>} count of inserted assets
 */
async function ingestFigmaAssetsIntoProject(projectId, project, assets, contextLabel = 'scan') {
  if (!assets || assets.length === 0) return 0;

  ensureFigmaAssetsDir();
  const existingPaths = new Set((project.files || []).map(f => normalizeTrackedFilePath(f.path)));
  const existingFigmaAssetKeys = new Set((project.files || []).map(getFigmaAssetDedupKey).filter(Boolean));
  let addedCount = 0;

  for (const asset of assets) {
    const figmaAssetKey = getFigmaAssetDedupKey({
      figmaFileKey: asset.figmaFileKey,
      figmaAssetKey: asset.imageRef || asset.nodeId || asset.url,
      imageRef: asset.imageRef,
      nodeId: asset.nodeId,
      url: asset.url
    });
    if (figmaAssetKey && existingFigmaAssetKeys.has(figmaAssetKey)) {
      console.log(
        `[crate][figma] asset duplicate skip (${contextLabel}): fileKey=${asset.figmaFileKey || 'unknown'} ` +
        `assetKey=${figmaAssetKey} reason=existing_asset_key`
      );
      continue;
    }

    const fileName = `${asset.figmaFileName}_${asset.name}`;
    const assetFormat = asset.format || 'png';
    const localPath = await downloadFigmaAsset(asset.url, fileName, projectId, assetFormat);

    if (!localPath) {
      console.log(
        `[crate][figma] asset skip (${contextLabel}): fileKey=${asset.figmaFileKey || 'unknown'} ` +
        `name=${asset.name || 'unknown'} reason=download_failed`
      );
      continue;
    }
    const normalizedLocalPath = normalizeTrackedFilePath(localPath);
    if (existingPaths.has(normalizedLocalPath)) {
      console.log(
        `[crate][figma] asset duplicate skip (${contextLabel}): fileKey=${asset.figmaFileKey || 'unknown'} ` +
        `localPath=${localPath} reason=existing_path`
      );
      continue;
    }

    const result = mutateProject(projectId, (proj) => {
      const projectPaths = new Set(proj.files.map(f => normalizeTrackedFilePath(f.path)));
      if (projectPaths.has(normalizedLocalPath)) return null;
      if (figmaAssetKey) {
        const projectFigmaKeys = new Set(proj.files.map(getFigmaAssetDedupKey).filter(Boolean));
        if (projectFigmaKeys.has(figmaAssetKey)) return null;
      }
      const fileRecord = {
        path: localPath,
        name: path.basename(localPath),
        ext: `.${assetFormat}`,
        addedAt: Date.now(),
        source: 'figma-auto',
        figmaFileKey: asset.figmaFileKey,
        figmaFileName: asset.figmaFileName,
        figmaPageId: asset.figmaPageId || null,
        figmaPageName: asset.figmaPageName || null,
        figmaScopeMode: asset.figmaScopeMode || null,
        figmaAssetKey
      };
      proj.files.push(fileRecord);
      proj.files = deduplicateFiles(proj.files);
      console.log(
        `[crate][figma] asset inserted (${contextLabel}): fileKey=${asset.figmaFileKey || 'unknown'} ` +
        `name=${fileRecord.name} localPath=${localPath}`
      );
      return { files: proj.files };
    });

    if (result) {
      const projectHasLocalPath = (project.files || []).some(f => normalizeTrackedFilePath(f.path) === normalizedLocalPath);
      const projectHasFigmaKey = figmaAssetKey && (project.files || []).some(f => getFigmaAssetDedupKey(f) === figmaAssetKey);
      if (!projectHasLocalPath && !projectHasFigmaKey) {
        project.files.push({
          path: localPath,
          name: path.basename(localPath),
          ext: `.${assetFormat}`,
          addedAt: Date.now(),
          source: 'figma-auto',
          figmaFileKey: asset.figmaFileKey,
          figmaFileName: asset.figmaFileName,
          figmaPageId: asset.figmaPageId || null,
          figmaPageName: asset.figmaPageName || null,
          figmaScopeMode: asset.figmaScopeMode || null,
          figmaAssetKey
        });
        project.files = deduplicateFiles(project.files);
      }
      addedCount++;
      existingPaths.add(normalizedLocalPath);
      if (figmaAssetKey) existingFigmaAssetKeys.add(figmaAssetKey);
    } else {
      console.log(
        `[crate][figma] asset duplicate skip (${contextLabel}): fileKey=${asset.figmaFileKey || 'unknown'} ` +
        `${figmaAssetKey ? `assetKey=${figmaAssetKey} ` : ''}localPath=${localPath} reason=already_in_project`
      );
    }
  }

  return addedCount;
}

/**
 * Poll Figma API for recent files and extract assets.
 * Runs on watch session start and every 60 seconds.
 */
async function pollFigmaForProject(projectId, isInitialScan = false) {
  if (figmaInProgress.has(projectId)) return { skipped: true, reason: 'in-progress' }; // Prevent overlapping polls

  const currentProjects = getProjects();
  const project = currentProjects.find(p => p.id === projectId);
  if (!project || project.status !== 'watching') return { skipped: true, reason: 'not-watching' };
  const scanStartedAt = Date.now();

  // Check if Figma is connected
  const { FigmaParser } = require('./parsers/figma');
  const parser = new FigmaParser();
  const token = await parser.getStoredToken();
  if (!token) {
    stopFigmaPolling(projectId);
    return { skipped: true, reason: 'not-connected' }; // Figma not connected
  }

  figmaInProgress.add(projectId);

  try {
    const ensuredSession = ensureProjectFigmaSession(projectId);
    const latestProject = getProjects().find(p => p.id === projectId) || project;
    const figmaSession = latestProject.figmaSession || ensuredSession || null;
    const rawTrackedFiles = (figmaSession && Array.isArray(figmaSession.trackedFiles)) ? figmaSession.trackedFiles : [];
    const teamIds = (figmaSession && Array.isArray(figmaSession.teamIds)) ? figmaSession.teamIds : [];
    const fileKeys = rawTrackedFiles.map(entry => entry.key);
    const normalizedTrackedFileKeys = Array.from(new Set(
      fileKeys.filter(key => typeof key === 'string' && key.trim())
    ));

    // Determine time window for scanning
    const lastScanMs = figmaScanTimestamps.get(projectId) || project.watchStartedAt || scanStartedAt;
    const watchStartMs = project.watchStartedAt || 0;
    const sinceMs = isInitialScan
      ? scanStartedAt - (30 * 24 * 60 * 60 * 1000) // Initial: last 30 days
      : Math.max(watchStartMs, lastScanMs - FIGMA_INCREMENTAL_OVERLAP_MS);

    console.log(`[crate][figma] Scanning Figma files for project ${projectId} (since ${new Date(sinceMs).toISOString()})`);
    console.log(
      `[crate][figma] scan config (${isInitialScan ? 'live-initial' : 'live-incremental'}): ` +
      `rawTrackedFiles=${JSON.stringify(rawTrackedFiles)} ` +
      `trackedFileKeys=${JSON.stringify(normalizedTrackedFileKeys)} ` +
      `teamIds=${JSON.stringify(teamIds)} ` +
      `sinceMs=${sinceMs} lastScanMs=${lastScanMs} watchStart=${project.watchStartedAt || null} ` +
      `scanStartedAt=${scanStartedAt} overlapMs=${isInitialScan ? 0 : FIGMA_INCREMENTAL_OVERLAP_MS}`
    );

    // Run auto-track scan
    const scanResult = await parser.autoTrackScan({
      sinceMs,
      maxAgeDays: isInitialScan ? 30 : 7,
      maxFiles: isInitialScan ? 20 : 10,
      teamIds,
      fileKeys,
      scopeEntries: rawTrackedFiles
    });

    const scopeStateResult = mergeFigmaScopeEntriesIntoSession(projectId, scanResult.scopeEntries || []);
    const activeProject = getProjects().find(p => p.id === projectId) || latestProject;
    const activeWarnings = (((activeProject || {}).figmaSession || {}).warnings) || [];

    if (scanResult.errors.length > 0) {
      console.warn('[crate][figma] Scan errors:', scanResult.errors);
      // Detect token expiry / auth failures — stop polling instead of retrying every 60s
      const authError = scanResult.errors.find(e => {
        const msg = typeof e === 'string' ? e : (e && e.message) || '';
        const type = (e && e.type) || '';
        return type === 'auth' || msg.includes('401') || msg.includes('403') ||
               msg.toLowerCase().includes('unauthorized') || msg.toLowerCase().includes('forbidden') ||
               msg.toLowerCase().includes('token invalid');
      });
      if (authError) {
        console.error('[crate][figma] Token appears expired or revoked — stopping Figma polling for project', projectId);
        stopFigmaPolling(projectId);
        // Notify renderer about auth failure
        sendToRenderer('figma:auth-error', { projectId, error: 'Figma token expired or invalid — reconnect in Settings' });
        return { projectId, error: 'Figma token expired or invalid — reconnect in Settings' };
      }
    }

    if (scanResult.assets.length === 0) {
      // Notify renderer even when no assets found
      const scanErrors = scanResult.errors.map(e => typeof e === 'string' ? e : (e && e.message) || JSON.stringify(e));
      const sessionWarning = activeWarnings[0] || (scanResult.warnings && scanResult.warnings[0]) || null;
      if (scanResult.files.length === 0 && (teamIds.length > 0 || fileKeys.length > 0)) {
        sendToRenderer('figma:scan-complete', {
          projectId, filesFound: 0, assetsFound: 0, addedCount: 0,
          errors: scanErrors, timestamp: Date.now(),
          warning: sessionWarning || 'No recent Figma files found. Make sure your file was modified recently.'
        });
      } else {
        sendToRenderer('figma:scan-complete', {
          projectId, filesFound: scanResult.files.length, assetsFound: 0, addedCount: 0,
          errors: scanErrors, timestamp: Date.now(),
          warning: sessionWarning
        });
      }
      if (scopeStateResult) {
        sendToRenderer('project:updated', { projectId });
      }
      figmaScanTimestamps.set(projectId, scanStartedAt);
      return {
        projectId,
        filesFound: scanResult.files.length,
        assetsFound: 0,
        addedCount: 0,
        errors: scanErrors,
        warning: sessionWarning
      };
    }

    console.log(`[crate][figma] Found ${scanResult.files.length} files, ${scanResult.assets.length} assets`);

    // Download assets and add to project
    const scopedAssets = scanResult.assets.map((asset) => ({
      ...asset,
      figmaScopeMode: (figmaSession && figmaSession.scopeMode) || FIGMA_SCOPE_ENTIRE_FILE
    }));
    const addedCount = await ingestFigmaAssetsIntoProject(projectId, project, scopedAssets, 'poll');

    if (addedCount > 0) {
      // Update activity timestamp
      lastFileActivity.set(projectId, Date.now());
      inactivityNotified.delete(projectId);

      // Notify renderer
      const updatedProject = getProjects().find(p => p.id === projectId);
      if (updatedProject) {
        sendToRenderer('files:updated', { projectId, files: updatedProject.files });
      }

      console.log(`[crate][figma] Added ${addedCount} Figma assets to project ${projectId}`);
    }
    if (scopeStateResult) {
      sendToRenderer('project:updated', { projectId });
    }

    const errors = scanResult.errors.map(e => typeof e === 'string' ? e : (e && e.message) || JSON.stringify(e));
    const warning = activeWarnings[0] || (scanResult.warnings && scanResult.warnings[0]) || null;
    sendToRenderer('figma:scan-complete', {
      projectId,
      filesFound: scanResult.files.length,
      assetsFound: scanResult.assets.length,
      addedCount,
      errors,
      timestamp: Date.now(),
      warning
    });

    figmaScanTimestamps.set(projectId, scanStartedAt);
    return {
      projectId,
      filesFound: scanResult.files.length,
      assetsFound: scanResult.assets.length,
      addedCount,
      errors,
      warning
    };
  } catch (e) {
    console.error('[crate][figma] pollFigmaForProject error:', e.message);
    sendToRenderer('figma:scan-error', { projectId, error: e.message });
    // Detect token expiry / auth failures at the network level
    const msg = (e.message || '').toLowerCase();
    if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('token invalid') || msg.includes('invalid figma')) {
      console.error('[crate][figma] Token appears expired or revoked — stopping Figma polling for project', projectId);
      stopFigmaPolling(projectId);
      sendToRenderer('figma:auth-error', { projectId, error: 'Figma token expired or invalid — reconnect in Settings' });
    }
    return { projectId, error: e.message };
  } finally {
    figmaInProgress.delete(projectId);
  }
}

/**
 * Start Figma polling for a project.
 */
async function startFigmaPolling(projectId) {
  const project = getProjects().find(p => p.id === projectId);
  if (!project || project.status !== 'watching' || !projectHasFigmaTrackedFiles(project)) {
    stopFigmaPolling(projectId);
    return;
  }

  // Guard: prevent duplicate pollers if called while initial poll is in progress
  if (figmaPollers.has(projectId) || figmaPollerStarting.has(projectId)) return;
  figmaPollerStarting.add(projectId);

  let initialResult;
  try {
    // Run initial scan immediately
    initialResult = await pollFigmaForProject(projectId, true);
  } finally {
    figmaPollerStarting.delete(projectId);
  }

  if (initialResult && initialResult.reason === 'not-connected') {
    return;
  }

  // Guard again after async: another caller may have set up a poller while we awaited
  if (figmaPollers.has(projectId)) return;

  const latestProject = getProjects().find(p => p.id === projectId);
  if (!latestProject || latestProject.status !== 'watching' || !projectHasFigmaTrackedFiles(latestProject)) {
    return;
  }

  // Start 60-second polling interval
  const intervalId = setInterval(() => {
    pollFigmaForProject(projectId, false);
  }, FIGMA_POLL_INTERVAL_MS);

  figmaPollers.set(projectId, intervalId);
}

/**
 * Stop Figma polling for a project.
 */
function stopFigmaPolling(projectId) {
  const intervalId = figmaPollers.get(projectId);
  if (intervalId) {
    clearInterval(intervalId);
    figmaPollers.delete(projectId);
  }
  figmaPollerStarting.delete(projectId);
  figmaInProgress.delete(projectId);
  figmaManualScanInFlight.delete(projectId);
  figmaScanTimestamps.delete(projectId);
}

// --- Photoshop + InDesign Polling (v2.3.0) ---

// v2.3.4: Photoshop JS DOM script — 'do javascript' exposes embedded smart object
// source paths via layer.smartObject.fileReference, which AppleScript cannot reach.
const PS_DOJAVASCRIPT = `(function() {
  var paths = [];
  try {
    for (var d = 0; d < app.documents.length; d++) {
      var doc = app.documents[d];
      collectLayers(doc.layers, paths);
    }
  } catch(e) {}
  function collectLayers(layers, paths) {
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      try {
        if (layer.kind === LayerKind.SMARTOBJECT) {
          try {
            var ref = layer.smartObject.fileReference;
            if (ref && ref !== '') paths.push(ref);
          } catch(e) {}
        }
      } catch(e) {}
      try {
        if (layer.layers && layer.layers.length > 0) {
          collectLayers(layer.layers, paths);
        }
      } catch(e) {}
    }
  }
  return paths.join('\\n');
})();`;

function psDoJavascriptAS(jsFilePath) {
  return `tell application "Adobe Photoshop"
  try
    set jsFile to POSIX file "${jsFilePath}" as alias
    set result to do javascript jsFile
    return result
  on error
    return ""
  end try
end tell`;
}

const INDD_APPLESCRIPT = `tell application "Adobe InDesign"
  try
    set pathList to {}
    repeat with aDoc in every document
      repeat with aLink in every link of aDoc
        try
          set fp to file path of aLink
          if fp is not missing value then
            set end of pathList to POSIX path of (fp as alias)
          end if
        end try
      end repeat
    end repeat
    set AppleScript's text item delimiters to linefeed
    return pathList as text
  on error
    return ""
  end try
end tell`;

/**
 * Poll Photoshop and InDesign for open smart objects / linked assets (embedded + linked).
 * Fires every 3 seconds; skips silently if neither app is running.
 */
async function pollPsForProject(projectId) {
  if (psInProgress.has(projectId)) return;

  const currentProjects = getProjects();
  const project = currentProjects.find(p => p.id === projectId);
  if (!project || project.status !== 'watching') return;

  psInProgress.add(projectId);

  try {
    const discoveredPaths = [];

    // --- Photoshop ---
    const { stdout: psCheck } = await execAsync(
      "/bin/ps ax -o command= 2>/dev/null | grep -i 'Adobe Photoshop' | grep -v grep",
      { timeout: 3000, encoding: 'utf8' }
    ).catch(() => ({ stdout: '' }));

    if (psCheck.trim()) {
      const jsPath = path.join(os.tmpdir(), `crate-ps-poll-${projectId}.js`);
      const asPath = path.join(os.tmpdir(), `crate-ps-poll-${projectId}.applescript`);
      try {
        await fs.promises.writeFile(jsPath, PS_DOJAVASCRIPT, 'utf8');
        await fs.promises.writeFile(asPath, psDoJavascriptAS(jsPath), 'utf8');
        const { stdout: psOut } = await execAsync(
          `/usr/bin/osascript "${asPath}"`,
          { timeout: 10000, encoding: 'utf8' }
        );
        for (const p of psOut.split('\n').filter(Boolean)) {
          discoveredPaths.push({ filePath: p, source: 'ps-poll' });
        }
      } catch (e) {
        // Photoshop may be busy or script timed out — skip silently
      } finally {
        try { fs.unlinkSync(jsPath); } catch (_) {}
        try { fs.unlinkSync(asPath); } catch (_) {}
      }
    }

    // --- InDesign ---
    const { stdout: inddCheck } = await execAsync(
      "/bin/ps ax -o command= 2>/dev/null | grep -i 'Adobe InDesign' | grep -v grep",
      { timeout: 3000, encoding: 'utf8' }
    ).catch(() => ({ stdout: '' }));

    if (inddCheck.trim()) {
      const scriptPath = path.join(os.tmpdir(), `crate-indd-poll-${projectId}.applescript`);
      try {
        await fs.promises.writeFile(scriptPath, INDD_APPLESCRIPT, 'utf8');
        const { stdout: inddOut } = await execAsync(
          `/usr/bin/osascript "${scriptPath}"`,
          { timeout: 10000, encoding: 'utf8' }
        );
        for (const line of inddOut.split('\n')) {
          const p = line.trim();
          if (p) discoveredPaths.push({ filePath: p, source: 'indd-poll' });
        }
      } catch (e) {
        // InDesign may be busy or script timed out — skip silently
      } finally {
        try { fs.unlinkSync(scriptPath); } catch (_) {}
      }
    }

    if (discoveredPaths.length === 0) return;

    // Deduplicate against existing project files
    const existingPaths = new Set(project.files.map(f => f.path));
    const newFiles = [];

    for (const { filePath, source } of discoveredPaths) {
      if (existingPaths.has(filePath)) continue;
      const ext = path.extname(filePath).toLowerCase();
      if (!DESIGN_FILE_EXTENSIONS.has(ext)) continue;
      try {
        fs.accessSync(filePath, fs.constants.R_OK);
      } catch (_) {
        continue; // File doesn't exist or not readable
      }
      newFiles.push({ filePath, source, ext });
      existingPaths.add(filePath); // prevent dupes within this batch
    }

    if (newFiles.length === 0) return;

    let addedCount = 0;
    for (const { filePath, source, ext } of newFiles) {
      const result = mutateProject(projectId, (proj) => {
        if (proj.files.some(f => f.path === filePath)) return null;
        proj.files.push({
          path: filePath,
          name: path.basename(filePath),
          ext,
          addedAt: Date.now(),
          source,
        });
        proj.files = deduplicateFiles(proj.files);
        return { files: proj.files };
      });
      if (result) addedCount++;
    }

    if (addedCount > 0) {
      lastFileActivity.set(projectId, Date.now());
      inactivityNotified.delete(projectId);

      const updatedProject = getProjects().find(p => p.id === projectId);
      if (updatedProject) {
        sendToRenderer('files:updated', { projectId, files: updatedProject.files });
      }
      console.log(`[crate][ps-poll] Added ${addedCount} linked assets to project ${projectId}`);
    }
  } catch (e) {
    console.error('[crate][ps-poll] pollPsForProject error:', e.message);
  } finally {
    psInProgress.delete(projectId);
  }
}

/**
 * Start Photoshop + InDesign polling for a project.
 */
async function startPsPolling(projectId) {
  if (psPollers.has(projectId) || psPollerStarting.has(projectId)) return;
  psPollerStarting.add(projectId);

  try {
    await pollPsForProject(projectId);
  } finally {
    psPollerStarting.delete(projectId);
  }

  if (psPollers.has(projectId)) return;

  const intervalId = setInterval(() => {
    pollPsForProject(projectId);
  }, PS_POLL_INTERVAL_MS);

  psPollers.set(projectId, intervalId);
}

/**
 * Stop Photoshop + InDesign polling for a project.
 */
function stopPsPolling(projectId) {
  const intervalId = psPollers.get(projectId);
  if (intervalId) {
    clearInterval(intervalId);
    psPollers.delete(projectId);
  }
  psPollerStarting.delete(projectId);
  psInProgress.delete(projectId);
}

// --- Real-time kMDItemLastUsedDate Polling (v2.3.3) ---
// When a user drags a pre-existing image into a design app, macOS updates
// kMDItemLastUsedDate on that file but lsof misses it (<1 sec open).
// This poller runs every 10s during active watch sessions to catch those files.

async function pollLastUsedForProject(projectId) {
  try {
  const projects = getProjects();
  const project = projects.find(p => p.id === projectId);
  if (!project || project.status !== 'watching') return;
  if (!designAppRunningCache.get(projectId)) return; // only run when a design app is open

  const homedir = os.homedir();
  const scanDirs = [
    path.join(homedir, 'Desktop'),
    path.join(homedir, 'Documents'),
    path.join(homedir, 'Downloads'),
  ];
  // v2.4.8: never fall back to createdAt (days old) — if watchStartedAt missing, skip cycle
  const watchStart = project.watchStartedAt;
  if (!watchStart) return;
  const existingPaths = new Set(project.files.map(f => f.path));
  const newFiles = [];

  // v2.4.2: Single mdfind query instead of per-file mdls spawning.
  // Asks Spotlight for all files with kMDItemLastUsedDate >= watchStart in one shot.
  const watchStartDate = new Date(watchStart);
  const mdfindTimestamp = `$time.iso(${watchStartDate.toISOString()})`;
  const onlyinArgs = scanDirs.filter(d => fs.existsSync(d)).flatMap(d => ['-onlyin', d]);
  if (onlyinArgs.length === 0) return;

  try {
    const { stdout: mdfindOut } = await execFileAsync('/usr/bin/mdfind', [
      ...onlyinArgs,
      `kMDItemLastUsedDate >= ${mdfindTimestamp}`
    ], { timeout: 15000, encoding: 'utf8' });

    for (const line of mdfindOut.split('\n')) {
      const fullPath = line.trim();
      if (!fullPath) continue;
      const name = path.basename(fullPath);
      if (name.startsWith('.') || name.startsWith('~') || name.startsWith('._')) continue;
      // v2.5.5: Skip macOS screenshots — they appear in kMDItemLastUsedDate because WhatsApp,
      // Telegram, or any app that displays the file updates the last-used timestamp. Screenshots
      // are never intentional project assets.
      if (/^Screen.?Shot/i.test(name)) continue;
      const ext = path.extname(name).toLowerCase();
      // v2.5.8: lastUsed poller only captures PRIMARY design source files.
      // Per the original design intent (see DESIGN_FILE_EXTENSIONS comment): fonts,
      // PDFs, and presentation source files are NOT captured here — they come from lsof
      // or scan-on-save. Using DESIGN_FILE_EXTENSIONS was too broad and caused false captures
      // from Chrome downloads, messaging apps, and any app that touches a file in Desktop/Downloads.
      // v2.6.4: Also allow LSOF_IMAGE_EXTENSIONS — the mdfind -onlyin already restricts
      // location to Desktop/Documents/Downloads, so images are safe here.
      if (!PRIMARY_DESIGN_EXTENSIONS.has(ext) && !LSOF_IMAGE_EXTENSIONS.has(ext)) continue;
      // v2.5.9: Presentation source files (.pptx, .key, etc.) are in PRIMARY_DESIGN_EXTENSIONS
      // but must still be excluded — their content is extracted via scan-on-save, not polling.
      const PRESENTATION_SOURCE_EXTS_LU = new Set(['.pptx', '.pptm', '.ppt', '.key', '.keynote']);
      if (PRESENTATION_SOURCE_EXTS_LU.has(ext)) continue;
      if (existingPaths.has(fullPath)) continue;
      newFiles.push({ path: fullPath, name, ext, addedAt: Date.now(), source: 'lastused-poll' });
      existingPaths.add(fullPath);
    }
  } catch (e) {
    // mdfind failed — skip this poll cycle
  }

  if (newFiles.length === 0) return;

  const result = mutateProject(projectId, (proj) => {
    if (proj.status !== 'watching') return null;
    const existingSet = new Set(proj.files.map(f => f.path));
    let added = 0;
    for (const f of newFiles) {
      if (existingSet.has(f.path)) continue;
      proj.files.push(f);
      existingSet.add(f.path);
      added++;
    }
    if (added === 0) return null;
    proj.files = deduplicateFiles(proj.files);
    return { files: proj.files };
  });

  if (result && trayWindow && !trayWindow.isDestroyed()) {
    trayWindow.webContents.send('files:updated', { projectId, files: result.files });
  }
  } catch (e) {
    console.error('[crate][lastused-poll] pollLastUsedForProject error:', e.message);
  }
}

function startLastUsedPolling(projectId) {
  if (lastUsedPollers.has(projectId)) return;
  setTimeout(() => pollLastUsedForProject(projectId), 10000); // v2.4.8: 10s delay — ensures watchStartedAt is written before first poll
  const intervalId = setInterval(() => pollLastUsedForProject(projectId), LAST_USED_POLL_MS);
  lastUsedPollers.set(projectId, intervalId);
}

function stopLastUsedPolling(projectId) {
  const intervalId = lastUsedPollers.get(projectId);
  if (intervalId !== undefined) { clearInterval(intervalId); lastUsedPollers.delete(projectId); }
}

// --- Scan-on-Open: per-format asset extractors ---
// v2.2.2: When a design file is first detected open by lsof (or re-opened after close),
// parse it for linked/embedded asset paths and merge them into the project.

// Track which design files have been scanned this session (per project).
// Key: projectId, Value: Set of filePaths already scanned.
const scannedDesignFiles = new Map(); // projectId -> Set<filePath>

// Track PIDs holding design files so we can detect close→re-open.
// Key: projectId, Value: Map<filePath, Set<pid>>
const designFilePids = new Map(); // projectId -> Map<filePath, Set<pid>>

// Extensions that support scan-on-open asset extraction
const SCAN_ON_OPEN_EXTENSIONS = new Set([
  '.ai', '.psd', '.indd', '.idml', '.sketch',
  '.afdesign', '.afphoto', '.afpub',
  '.key', '.pptx', '.ppt', '.pxd',
  '.fig', '.pdf', '.xd',
]);

/**
 * Extract linked/embedded asset paths from a design file.
 * Routes to per-format extractors. Returns array of absolute file paths.
 * All I/O is async — never blocks the main process.
 */
async function extractLinkedAssets(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  try {
    switch (ext) {
      case '.ai':
      case '.pdf':
      case '.xd':
        return await extractLinkedAssetsRegex(filePath);
      case '.psd':
        return await extractLinkedAssetsPhotoshop(filePath);
      case '.indd':
      case '.idml':
        return await extractLinkedAssetsInDesign(filePath);
      case '.sketch':
        return await extractLinkedAssetsSketch(filePath);
      case '.afdesign':
      case '.afphoto':
      case '.afpub':
        return await extractLinkedAssetsAffinity(filePath);
      case '.key':
      case '.pptx':
      case '.ppt':
        return await extractLinkedAssetsZipMedia(filePath);
      case '.pxd':
        return await extractLinkedAssetsPxd(filePath);
      case '.fig':
        return await extractLinkedAssetsRegex(filePath);
      default:
        return [];
    }
  } catch (e) {
    console.error(`[crate] scan-on-open: extractLinkedAssets error for ${path.basename(filePath)}:`, e.message);
    return [];
  }
}

/**
 * Regex-based extractor: reads binary file as UTF-8 and greps for absolute paths.
 * Works for .ai, .psd, .pdf, .xd, .fig, .indd (binary InDesign).
 */
async function extractLinkedAssetsRegex(filePath) {
  const LINKED_ASSET_REGEX = /(?:\/Users\/|\/Volumes\/)[^\x00-\x1f\x22\x27]+?\.(jpg|jpeg|png|gif|webp|svg|pdf|eps|ai|psd|tiff|tif|afdesign|afphoto|afpub|indd|idml|sketch|fig|heic|ttf|otf|woff|woff2|mp4|mov|avi|webm)/gi;
  const results = [];
  try {
    // Guard: skip files larger than MAX_PARSE_FILE_SIZE to prevent OOM
    const stat = await fs.promises.stat(filePath);
    if (stat.size > MAX_PARSE_FILE_SIZE) {
      console.warn(`[crate] extractLinkedAssetsRegex: skipping ${path.basename(filePath)} (${Math.round(stat.size / 1024 / 1024)}MB exceeds ${MAX_PARSE_FILE_SIZE / 1024 / 1024}MB limit)`);
      return results;
    }
    const buf = await fs.promises.readFile(filePath);
    const content = buf.toString('utf8');
    let match;
    while ((match = LINKED_ASSET_REGEX.exec(content)) !== null) {
      const linkedPath = match[0];
      if (linkedPath === filePath) continue; // skip self-reference
      results.push(linkedPath);
    }
  } catch (e) {
    // read error — return empty
  }
  return results;
}

/**
 * v2.2.7: Photoshop AppleScript extractor.
 * Photoshop EMBEDS images on placement — lsof misses the brief file read,
 * and regex fails because paths live in binary smart-object sections.
 * AppleScript bypasses this by querying Photoshop directly for smart object
 * file paths and placed items.
 * Falls back to extractLinkedAssetsRegex() if Photoshop is not running or
 * AppleScript returns nothing.
 */
async function extractLinkedAssetsPhotoshop(filePath) {
  try {
    // Check if Photoshop is running
    const { stdout: psCheck } = await execAsync(
      "/bin/ps ax -o command= 2>/dev/null | grep -i 'Adobe Photoshop' | grep -v grep",
      { timeout: 3000, encoding: 'utf8' }
    ).catch(() => ({ stdout: '' }));

    if (psCheck.trim()) {
      // v2.3.4: do javascript — exposes embedded smart object paths
      const jsPath = path.join(os.tmpdir(), 'crate-ps-scan.js');
      const asPath = path.join(os.tmpdir(), 'crate-ps-scan.applescript');

      await fs.promises.writeFile(jsPath, PS_DOJAVASCRIPT, 'utf8');
      await fs.promises.writeFile(asPath, psDoJavascriptAS(jsPath), 'utf8');
      try {
        const { stdout: psPaths } = await execAsync(
          `/usr/bin/osascript "${asPath}"`,
          { timeout: 10000, encoding: 'utf8' }
        ).catch(() => ({ stdout: '' }));

        if (psPaths.trim()) {
          const results = [];
          for (const p of psPaths.split('\n').filter(Boolean)) {
            if (p === filePath) continue;
            if (fs.existsSync(p)) results.push(p);
          }
          if (results.length > 0) {
            await fs.promises.unlink(jsPath).catch(() => {});
            await fs.promises.unlink(asPath).catch(() => {});
            return results;
          }
        }
      } finally {
        await fs.promises.unlink(jsPath).catch(() => {});
        await fs.promises.unlink(asPath).catch(() => {});
      }
    }
  } catch (e) {
    // do javascript failed — fall through to regex
  }
  return extractLinkedAssetsRegex(filePath);
}

/**
 * v2.3.6: PSD binary parser using ag-psd.
 * Extracts linked file paths from layers (layer.linkedFile.fullPath) and
 * embedded smart object data from psd.linkedFiles (written to temp dir).
 * Complements the AppleScript/do-javascript approach — works even when
 * Photoshop is not running.
 */
async function extractPsdAssets(psdFilePath, projectId) {
  try {
    // Guard: skip files larger than MAX_PARSE_FILE_SIZE to prevent OOM
    const stat = await fs.promises.stat(psdFilePath);
    if (stat.size > MAX_PARSE_FILE_SIZE) {
      console.warn(`[crate][psd-parser] Skipping ${path.basename(psdFilePath)} (${Math.round(stat.size / 1024 / 1024)}MB exceeds ${MAX_PARSE_FILE_SIZE / 1024 / 1024}MB limit)`);
      return [];
    }
    const buf = await fs.promises.readFile(psdFilePath);
    const psd = readPsd(buf, { skipLayerImageData: true, skipCompositeImageData: true });
    const discoveredPaths = [];

    // Walk layers for linkedFile.fullPath
    function walkLayers(layers) {
      if (!layers) return;
      for (const layer of layers) {
        if (layer.linkedFile && layer.linkedFile.fullPath) {
          const fp = layer.linkedFile.fullPath;
          if (fs.existsSync(fp)) {
            discoveredPaths.push({ filePath: fp, source: 'psd-linked' });
          }
        }
        if (layer.children) walkLayers(layer.children);
      }
    }
    walkLayers(psd.children);

    // Extract embedded files from psd.linkedFiles
    if (psd.linkedFiles && psd.linkedFiles.length > 0) {
      const extractDir = path.join(os.tmpdir(), 'crate-psd-extract-' + projectId);
      await fs.promises.mkdir(extractDir, { recursive: true });
      const usedEmbeddedNames = new Set();
      for (const lf of psd.linkedFiles) {
        if (!lf.data) continue;
        const safeName = reserveUniqueName(lf.name, usedEmbeddedNames);
        const extractPath = path.join(extractDir, safeName);
        await fs.promises.writeFile(extractPath, Buffer.from(lf.data));
        discoveredPaths.push({
          filePath: extractPath,
          source: 'psd-embedded',
          embeddedOriginalName: lf.name || '',
        });
      }
    }

    return discoveredPaths;
  } catch (e) {
    console.error('[crate][psd-parser] Error parsing PSD:', e.message);
    return [];
  }
}

/**
 * v2.2.7: InDesign AppleScript extractor.
 * InDesign has excellent scripting support — query all links of each open document.
 * Falls back to extractLinkedAssetsRegex() for .indd or extractLinkedAssetsIdml()
 * for .idml if InDesign is not running or AppleScript returns nothing.
 */
async function extractLinkedAssetsInDesign(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  try {
    // Check if InDesign is running
    const { stdout: psCheck } = await execAsync(
      "/bin/ps ax -o command= 2>/dev/null | grep -i 'Adobe InDesign' | grep -v grep",
      { timeout: 3000, encoding: 'utf8' }
    ).catch(() => ({ stdout: '' }));

    if (psCheck.trim()) {
      const scriptPath = path.join(os.tmpdir(), 'crate-indd-query.applescript');
      const appleScript = `tell application "Adobe InDesign"
  try
    set pathList to {}
    repeat with aDoc in every document
      repeat with aLink in every link of aDoc
        try
          set filePath to POSIX path of (file path of aLink as alias)
          set end of pathList to filePath
        end try
      end repeat
    end repeat
    set AppleScript's text item delimiters to linefeed
    return pathList as text
  on error
    return ""
  end try
end tell`;

      await fs.promises.writeFile(scriptPath, appleScript, 'utf8');
      try {
        const { stdout: inddPaths } = await execAsync(
          `/usr/bin/osascript "${scriptPath}"`,
          { timeout: 10000, encoding: 'utf8' }
        ).catch(() => ({ stdout: '' }));

        if (inddPaths.trim()) {
          const results = [];
          for (const line of inddPaths.trim().split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (trimmed === filePath) continue;
            if (fs.existsSync(trimmed)) results.push(trimmed);
          }
          if (results.length > 0) {
            await fs.promises.unlink(scriptPath).catch(() => {});
            return results;
          }
        }
      } finally {
        await fs.promises.unlink(scriptPath).catch(() => {});
      }
    }
  } catch (e) {
    // AppleScript failed — fall through to file-based extractor
  }
  // Fallback: .idml → zip-based XML parser, .indd → binary regex
  if (ext === '.idml') return extractLinkedAssetsIdml(filePath);
  return extractLinkedAssetsRegex(filePath);
}

/**
 * IDML extractor: .idml is a zip; unzip and parse XML for <Link> elements.
 */
async function extractLinkedAssetsIdml(filePath) {
  const results = [];
  try {
    // List zip contents and find Spreads/*.xml or Resources/*.xml
    const { stdout: listing } = await execFileAsync('/usr/bin/unzip', ['-l', filePath], {
      timeout: 10000, encoding: 'utf8'
    });
    const xmlEntries = [];
    for (const line of listing.split('\n')) {
      const m = line.match(/^\s+\d+\s+\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}\s+(.+)$/);
      if (!m) continue;
      const entry = m[1].trim();
      // Grab all XML files — links can be in Spreads, Stories, or designmap
      if (entry.endsWith('.xml')) xmlEntries.push(entry);
    }

    for (const entry of xmlEntries) {
      try {
        const { stdout: data } = await execFileAsync('/usr/bin/unzip', ['-p', filePath, entry], {
          timeout: 8000, encoding: 'utf8'
        });
        // Look for LinkResourceURI attributes
        const uriRegex = /LinkResourceURI="file:([^"]+)"/gi;
        let match;
        while ((match = uriRegex.exec(data)) !== null) {
          let uri = match[1];
          // Decode URI-encoded paths
          try { uri = decodeURIComponent(uri); } catch (e) {}
          // Normalize: remove leading slashes from file: scheme
          if (uri.startsWith('//')) uri = uri.slice(1);
          if (uri.startsWith('/Users/') || uri.startsWith('/Volumes/')) {
            results.push(uri);
          }
        }
        // Also try the regex approach for any raw absolute paths
        const LINKED_ASSET_REGEX = /(?:\/Users\/|\/Volumes\/)[^\x00-\x1f\x22\x27<>]+?\.(jpg|jpeg|png|gif|webp|svg|pdf|eps|ai|psd|tiff|tif|heic|ttf|otf|woff|woff2|mp4|mov|avi|webm)/gi;
        while ((match = LINKED_ASSET_REGEX.exec(data)) !== null) {
          results.push(match[0]);
        }
      } catch (e) {
        // extraction error for this entry — continue
      }
    }
  } catch (e) {
    // fallback: try regex on the raw zip
    return await extractLinkedAssetsRegex(filePath);
  }
  return [...new Set(results)];
}

/**
 * Sketch extractor: .sketch is a zip; parse document.json and pages for image refs.
 */
async function extractLinkedAssetsSketch(filePath) {
  const results = [];
  try {
    // List zip contents
    const { stdout: listing } = await execFileAsync('/usr/bin/unzip', ['-l', filePath], {
      timeout: 10000, encoding: 'utf8'
    });
    const jsonEntries = [];
    for (const line of listing.split('\n')) {
      const m = line.match(/^\s+\d+\s+\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}\s+(.+)$/);
      if (!m) continue;
      const entry = m[1].trim();
      if (entry.endsWith('.json')) jsonEntries.push(entry);
    }

    for (const entry of jsonEntries) {
      try {
        const { stdout: data } = await execFileAsync('/usr/bin/unzip', ['-p', filePath, entry], {
          timeout: 8000, encoding: 'utf8'
        });
        // Scan for absolute file paths in JSON
        const LINKED_ASSET_REGEX = /(?:\/Users\/|\/Volumes\/)[^\x00-\x1f\x22\x27]+?\.(jpg|jpeg|png|gif|webp|svg|pdf|eps|ai|psd|tiff|tif|heic|ttf|otf|woff|woff2|mp4|mov|avi|webm)/gi;
        let match;
        while ((match = LINKED_ASSET_REGEX.exec(data)) !== null) {
          results.push(match[0]);
        }
      } catch (e) {
        // extraction error — continue
      }
    }
  } catch (e) {
    // fallback: try regex on the raw zip
    return await extractLinkedAssetsRegex(filePath);
  }
  return [...new Set(results)];
}

/**
 * Affinity extractor: .afdesign/.afphoto/.afpub are zip-based.
 * Parse internal files for linked asset references.
 */
async function extractLinkedAssetsAffinity(filePath) {
  const results = [];
  try {
    // List zip contents
    const { stdout: listing } = await execFileAsync('/usr/bin/unzip', ['-l', filePath], {
      timeout: 10000, encoding: 'utf8'
    });
    const entries = [];
    for (const line of listing.split('\n')) {
      const m = line.match(/^\s+\d+\s+\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}\s+(.+)$/);
      if (!m) continue;
      const entry = m[1].trim();
      if (entry.endsWith('/')) continue;
      // Check text-parseable entries (XML, JSON, plist, or smaller binary files)
      const entryExt = path.extname(entry).toLowerCase();
      if (['.xml', '.json', '.plist', '.dat'].includes(entryExt) || entry === 'metadata') {
        entries.push(entry);
      }
    }

    for (const entry of entries) {
      try {
        const { stdout: data } = await execFileAsync('/usr/bin/unzip', ['-p', filePath, entry], {
          timeout: 8000, encoding: 'utf8'
        });
        const LINKED_ASSET_REGEX = /(?:\/Users\/|\/Volumes\/)[^\x00-\x1f\x22\x27]+?\.(jpg|jpeg|png|gif|webp|svg|pdf|eps|ai|psd|tiff|tif|heic|ttf|otf|woff|woff2|mp4|mov|avi|webm)/gi;
        let match;
        while ((match = LINKED_ASSET_REGEX.exec(data)) !== null) {
          results.push(match[0]);
        }
      } catch (e) {
        // continue
      }
    }

    // Also try regex on the raw binary (Affinity often stores paths in binary blobs)
    const rawResults = await extractLinkedAssetsRegex(filePath);
    results.push(...rawResults);
  } catch (e) {
    return await extractLinkedAssetsRegex(filePath);
  }
  return [...new Set(results)];
}

/**
 * Zip media extractor for .key/.pptx/.ppt: lists embedded media files
 * and returns their paths after extracting to a temp location.
 * Unlike the package-time extractEmbeddedMedia, this returns references
 * to the presentation file itself (the design file IS the asset container).
 * For scan-on-open, we just add the presentation file — embedded media
 * extraction happens at package time via extractEmbeddedMedia().
 *
 * However, we also scan the zip for any absolute path references to
 * externally linked files (rare but possible in Keynote).
 */
async function extractLinkedAssetsZipMedia(filePath) {
  const results = [];
  try {
    const buf = await fs.promises.readFile(filePath);
    const content = buf.toString('utf8');
    const LINKED_ASSET_REGEX = /(?:\/Users\/|\/Volumes\/)[^\x00-\x1f\x22\x27]+?\.(jpg|jpeg|png|gif|webp|svg|pdf|eps|ai|psd|tiff|tif|heic|ttf|otf|woff|woff2|mp4|mov|avi|webm)/gi;
    let match;
    while ((match = LINKED_ASSET_REGEX.exec(content)) !== null) {
      if (match[0] === filePath) continue;
      results.push(match[0]);
    }
  } catch (e) {
    // read error
  }
  return results;
}

/**
 * Pixelmator Pro extractor: .pxd is a zip-based package.
 * Parse for linked asset references.
 */
async function extractLinkedAssetsPxd(filePath) {
  // .pxd is zip-based — try both structured and regex approaches
  const results = [];
  try {
    const { stdout: listing } = await execFileAsync('/usr/bin/unzip', ['-l', filePath], {
      timeout: 10000, encoding: 'utf8'
    });
    const entries = [];
    for (const line of listing.split('\n')) {
      const m = line.match(/^\s+\d+\s+\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}\s+(.+)$/);
      if (!m) continue;
      const entry = m[1].trim();
      if (entry.endsWith('/')) continue;
      const entryExt = path.extname(entry).toLowerCase();
      if (['.xml', '.json', '.plist'].includes(entryExt) || entry === 'metadata.info') {
        entries.push(entry);
      }
    }

    for (const entry of entries) {
      try {
        const { stdout: data } = await execFileAsync('/usr/bin/unzip', ['-p', filePath, entry], {
          timeout: 8000, encoding: 'utf8'
        });
        const LINKED_ASSET_REGEX = /(?:\/Users\/|\/Volumes\/)[^\x00-\x1f\x22\x27]+?\.(jpg|jpeg|png|gif|webp|svg|pdf|eps|ai|psd|tiff|tif|heic|ttf|otf|woff|woff2|mp4|mov|avi|webm)/gi;
        let match;
        while ((match = LINKED_ASSET_REGEX.exec(data)) !== null) {
          results.push(match[0]);
        }
      } catch (e) {
        // continue
      }
    }
  } catch (e) {
    // fallback
  }
  // Also try raw binary regex
  const rawResults = await extractLinkedAssetsRegex(filePath);
  results.push(...rawResults);
  return [...new Set(results)];
}

/**
 * Run scan-on-open for a design file: extract linked assets and merge into project.
 * Fire-and-forget — called outside mutateProject, then uses mutateProject for store writes.
 */
async function runScanOnOpen(projectId, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!SCAN_ON_OPEN_EXTENSIONS.has(ext)) return;

  console.log(`[crate] scan-on-open: scanning ${path.basename(filePath)}`);
  const linkedPaths = await extractLinkedAssets(filePath);

  // Filter to existing files on disk with design-relevant extensions
  const validPaths = [];
  for (const p of linkedPaths) {
    if (!p.startsWith('/Users/')) continue;
    const pExt = path.extname(p).toLowerCase();
    if (!DESIGN_FILE_EXTENSIONS.has(pExt)) continue;
    try {
      await fs.promises.access(p, fs.constants.F_OK);
      validPaths.push(p);
    } catch (e) {
      // file doesn't exist — skip
    }
  }

  if (validPaths.length === 0) {
    console.log(`[crate] scan-on-open: found 0 linked assets in ${path.basename(filePath)}`);
    return;
  }

  console.log(`[crate] scan-on-open: found ${validPaths.length} linked assets in ${path.basename(filePath)}`);

  const result = mutateProject(projectId, (proj) => {
    if (proj.status !== 'watching') return null;
    // v2.4.0: normalize paths before comparing to prevent duplicates
    const existingPaths = new Set(proj.files.map(f => path.resolve(f.path).toLowerCase()));
    let changed = false;

    for (const linkedPath of validPaths) {
      if (existingPaths.has(path.resolve(linkedPath).toLowerCase())) continue;

      proj.files.push({
        path: linkedPath,
        name: path.basename(linkedPath),
        ext: path.extname(linkedPath).toLowerCase(),
        addedAt: Date.now(),
        source: 'scan-on-open',
      });
      existingPaths.add(path.resolve(linkedPath).toLowerCase());
      changed = true;
    }

    if (changed) {
      proj.files = deduplicateFiles(proj.files);
    }
    return changed ? { files: proj.files } : null;
  });

  if (result) {
    lastFileActivity.set(projectId, Date.now());
    inactivityNotified.delete(projectId);
    sendToRenderer('files:updated', { projectId, files: result.files });
  }

  // v2.3.6: PSD binary parse — extract embedded smart object assets via ag-psd.
  // Runs in addition to the AppleScript/do-javascript path above.
  // Debounce: skip if same PSD was parsed less than 5 seconds ago.
  if (ext === '.psd') {
    const lastParsed = psdParseDebounce.get(filePath) || 0;
    if (Date.now() - lastParsed < 5000) return;
    psdParseDebounce.set(filePath, Date.now()); // set BEFORE parse to prevent concurrent duplicates
    const psdAssets = await extractPsdAssets(filePath, projectId);
    if (psdAssets.length > 0) {
      const psdResult = mutateProject(projectId, (proj) => {
        if (proj.status !== 'watching') return null;
        // v2.4.0: normalize paths before comparing to prevent duplicates
        const existingPaths = new Set(proj.files.map(f => path.resolve(f.path).toLowerCase()));
        let changed = false;
        for (const asset of psdAssets) {
          if (existingPaths.has(path.resolve(asset.filePath).toLowerCase())) continue;
          proj.files.push({
            path: asset.filePath,
            name: path.basename(asset.filePath),
            ext: path.extname(asset.filePath).toLowerCase(),
            addedAt: Date.now(),
            source: asset.source,
          });
          existingPaths.add(path.resolve(asset.filePath).toLowerCase());
          changed = true;
        }
        if (changed) proj.files = deduplicateFiles(proj.files);
        return changed ? { files: proj.files } : null;
      });
      if (psdResult) {
        lastFileActivity.set(projectId, Date.now());
        inactivityNotified.delete(projectId);
        sendToRenderer('files:updated', { projectId, files: psdResult.files });
      }
    }
  }
}

/**
 * v2.5.0: Scan-on-save for PSD files — COMPLETELY ISOLATED from existing capture pipeline.
 * When a .psd is saved, runs ag-psd async to extract file references and adds them
 * to project.files mid-session. Debounced: waits 2s after last save before running.
 * For linked smart objects: adds file path to project.files (source: 'scan-on-save-linked').
 * For embedded smart objects: marks as embedded (source: 'scan-on-save-embedded', embedded: true).
 * Never breaks the session — all errors caught silently.
 */
function scheduleScanOnSave(projectId, psdFilePath) {
  const key = `${projectId}:${psdFilePath}`;
  if (scanOnSaveTimers.has(key)) {
    clearTimeout(scanOnSaveTimers.get(key));
  }
  scanOnSaveTimers.set(key, setTimeout(() => {
    scanOnSaveTimers.delete(key);
    runScanOnSave(projectId, psdFilePath).catch(() => {});
  }, 2000));
}

async function runScanOnSave(projectId, psdFilePath) {
  try {
    const stat = await fs.promises.stat(psdFilePath);
    if (stat.size > MAX_PARSE_FILE_SIZE) return;

    const buf = await fs.promises.readFile(psdFilePath);
    const psd = readPsd(buf, { skipLayerImageData: true, skipCompositeImageData: true });

    const newEntries = [];

    // Walk layers for linked smart objects (linkedFile.fullPath)
    function walkLayers(layers) {
      if (!layers) return;
      for (const layer of layers) {
        if (layer.linkedFile && layer.linkedFile.fullPath) {
          const fp = layer.linkedFile.fullPath;
          if (fs.existsSync(fp)) {
            newEntries.push({
              path: fp,
              name: path.basename(fp),
              ext: path.extname(fp).toLowerCase(),
              addedAt: Date.now(),
              source: 'scan-on-save-linked',
            });
          }
        }
        if (layer.children) walkLayers(layer.children);
      }
    }
    walkLayers(psd.children);

    // Mark embedded smart objects (extracted at package time as normal)
    if (psd.linkedFiles && psd.linkedFiles.length > 0) {
      const usedEmbeddedNames = new Set();
      for (const [embeddedIndex, lf] of psd.linkedFiles.entries()) {
        if (!lf.data) continue;
        const safeName = reserveUniqueName(lf.name, usedEmbeddedNames);
        newEntries.push({
          path: psdFilePath, // parent PSD — physical extraction happens at package time
          name: safeName,
          ext: path.extname(safeName).toLowerCase(),
          addedAt: Date.now(),
          source: 'scan-on-save-embedded',
          embedded: true,
          parentPsd: psdFilePath,
          embeddedOriginalName: lf.name || '',
          embeddedIndex,
          fileId: uuidv4(), // C2: unique key so embedded entries can be individually removed
        });
      }
    }

    if (newEntries.length === 0) return;

    const result = mutateProject(projectId, (proj) => {
      if (proj.status !== 'watching') return null;
      const existingPaths = new Set(proj.files.map(f =>
        f.embedded && f.source === 'scan-on-save-embedded'
          ? getEmbeddedPsdDedupKey(f)
          : path.resolve(f.path).toLowerCase()
      ));
      let changed = false;

      for (const entry of newEntries) {
        const key = entry.embedded
          ? getEmbeddedPsdDedupKey(entry)
          : path.resolve(entry.path).toLowerCase();
        if (existingPaths.has(key)) continue;
        proj.files.push(entry);
        existingPaths.add(key);
        changed = true;
      }

      if (changed) {
        proj.files = deduplicateFiles(proj.files);
      }
      return changed ? { files: proj.files } : null;
    });

    if (result) {
      lastFileActivity.set(projectId, Date.now());
      inactivityNotified.delete(projectId);
      sendToRenderer('files:updated', { projectId, files: result.files });
    }
  } catch (e) {
    // L2: Log so failures are debuggable — never break the session
    console.log('[scan-on-save] ag-psd parse failed:', e.message);
  }
}

/**
 * v2.5.3: Scan-on-save for presentation files (.pptx, .key, .ppt).
 * When a presentation is saved (Cmd+S), extract embedded media immediately
 * to a temp dir and add to project.files mid-session. Debounced 2s like PSD.
 */
function scheduleScanOnSavePresentation(projectId, filePath) {
  const key = `${projectId}:${filePath}`;
  if (scanOnSavePresentationTimers.has(key)) {
    clearTimeout(scanOnSavePresentationTimers.get(key));
  }
  scanOnSavePresentationTimers.set(key, setTimeout(() => {
    scanOnSavePresentationTimers.delete(key);
    runScanOnSavePresentation(projectId, filePath).catch(() => {});
  }, 2000));
}

async function runScanOnSavePresentation(projectId, presentationPath) {
  try {
    const ext = path.extname(presentationPath).toLowerCase();
    const base = path.basename(presentationPath, ext);

    // Ensure temp dir exists: ~/.crate/presentation-assets/{projectId}/
    const tempDir = path.join(os.homedir(), '.crate', 'presentation-assets', projectId);
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Build dedup sets from existing project files
    const currentProjects = getProjects();
    const project = currentProjects.find(p => p.id === projectId);
    if (!project || project.status !== 'watching') return;
    const projectFiles = project.files || [];

    // Name-based dedup for .key files
    const alreadyCapturedBases = new Set();
    for (const f of projectFiles) {
      const n = path.basename(f.name, path.extname(f.name)).toLowerCase().replace(/\s+/g, ' ').trim();
      alreadyCapturedBases.add(n);
      // v2.6.1: scan-on-save prefixes filenames with "{PresentationName} — ".
      // On subsequent saves, Keynote dedup checks the raw embedded name (e.g. "image-001")
      // which never matches the prefixed form ("mykeynote — image-001"). Strip the prefix
      // so existing files are recognised and not re-extracted.
      if (f.source === 'scan-on-save-presentation') {
        const separatorIdx = n.indexOf(' — ');
        if (separatorIdx !== -1) alreadyCapturedBases.add(n.slice(separatorIdx + 3).trim());
      }
    }

    // Content-based dedup for .pptx files
    const contentFingerprints = new Set();
    const capturedSizes = new Set();
    if (ext === '.pptx' || ext === '.ppt') {
      for (const f of projectFiles) {
        try {
          const buf = fs.readFileSync(f.path);
          const size = buf.length;
          capturedSizes.add(size);
          const hash = crypto.createHash('md5').update(buf).digest('hex');
          contentFingerprints.add(`${size}:${hash}`);
        } catch (e) { /* file may no longer exist */ }
      }
    }

    // List zip contents
    const { stdout: listing } = await execFileAsync('/usr/bin/unzip', ['-l', presentationPath], {
      timeout: 10000, encoding: 'utf8'
    });

    const newEntries = [];

    for (const line of listing.split('\n')) {
      const m = line.match(/^\s+(\d+)\s+(\d{2}-\d{2}-\d{4})\s+(\d{2}:\d{2})\s+(.+)$/);
      if (!m) continue;

      const fileSize = parseInt(m[1], 10);
      const zipPath = m[4].trim();

      if (zipPath.endsWith('/')) continue;
      if (zipPath.includes('__MACOSX')) continue;
      if (path.basename(zipPath).startsWith('.')) continue;

      const fileExt = path.extname(zipPath).toLowerCase();
      if (!EMBEDDED_MEDIA_EXTENSIONS.has(fileExt)) continue;

      // Scope to known media folders
      const inMediaFolder =
        (ext === '.pptx' || ext === '.ppt') ? zipPath.startsWith('ppt/media/') :
        (ext === '.key')                     ? zipPath.startsWith('Data/')       :
        false;
      if (!inMediaFolder) continue;

      if (fileSize < 500) continue;

      // Keynote-specific junk filtering (same as extractEmbeddedMedia)
      if (ext === '.key') {
        const entryName = path.basename(zipPath);

        if (/^st-[0-9a-f-]+\.jpe?g$/i.test(entryName)) continue;
        if (/^(mt|bg|tx)-[0-9a-f-]+\.jpe?g$/i.test(entryName)) continue;
        if (/-small(-\d{3,6})?\.[a-z]+$/i.test(entryName)) continue;

        // Cross-reference dedup: strip Keynote's numeric suffix
        const cleanedName = entryName
          .replace(/-\d{3,6}(\.[a-z]+)$/i, '$1')
          .replace(/-small(\.[a-z]+)$/i, '$1');
        const baseName = path.basename(cleanedName, path.extname(cleanedName))
          .toLowerCase().replace(/\s+/g, ' ').trim();
        if (alreadyCapturedBases.has(baseName)) continue;
      }

      try {
        const { stdout: data } = await execFileAsync('/usr/bin/unzip', ['-p', presentationPath, zipPath], {
          timeout: 10000, maxBuffer: 50 * 1024 * 1024,
          encoding: 'buffer'
        });

        // Content-based dedup for .pptx
        if ((ext === '.pptx' || ext === '.ppt') && contentFingerprints.size > 0) {
          const extractedSize = data.length;
          if (capturedSizes.has(extractedSize)) {
            const extractedHash = crypto.createHash('md5').update(data).digest('hex');
            if (contentFingerprints.has(`${extractedSize}:${extractedHash}`)) continue;
          }
        }

        // Recover original filename (strip Keynote's trailing -NNNN suffix)
        let outputName = path.basename(zipPath);
        if (ext === '.key') {
          outputName = outputName.replace(/-\d{3,6}(\.[a-z]+)$/i, '$1');
        }
        outputName = `${base} — ${outputName}`;

        // Write to temp dir, handle collisions
        let destPath = path.join(tempDir, outputName);
        let counter = 1;
        while (fs.existsSync(destPath)) {
          const e = path.extname(outputName);
          const b = path.basename(outputName, e);
          destPath = path.join(tempDir, `${b}_${counter}${e}`);
          counter++;
        }

        fs.writeFileSync(destPath, data);
        console.log(`[crate] scan-on-save-presentation: extracted ${outputName}`);

        newEntries.push({
          path: destPath,
          name: path.basename(destPath),
          ext: path.extname(destPath).toLowerCase(),
          addedAt: Date.now(),
          source: 'scan-on-save-presentation',
        });
      } catch (e) {
        console.error(`[crate] scan-on-save-presentation: failed to extract ${zipPath}:`, e.message);
      }
    }

    if (newEntries.length === 0) return;

    const result = mutateProject(projectId, (proj) => {
      if (proj.status !== 'watching') return null;
      const existingPaths = new Set(proj.files.map(f => path.resolve(f.path).toLowerCase()));
      let changed = false;

      for (const entry of newEntries) {
        const normPath = path.resolve(entry.path).toLowerCase();
        if (existingPaths.has(normPath)) continue;
        proj.files.push(entry);
        existingPaths.add(normPath);
        changed = true;
      }

      if (changed) proj.files = deduplicateFiles(proj.files);
      return changed ? { files: proj.files } : null;
    });

    if (result) {
      lastFileActivity.set(projectId, Date.now());
      inactivityNotified.delete(projectId);
      sendToRenderer('files:updated', { projectId, files: result.files });
    }
  } catch (e) {
    console.log('[scan-on-save-presentation] extraction failed:', e.message);
  }
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

async function startWatching(projectId) {
  const settings = store.get('settings') || {};
  // FIX 1: Use mutateProject for initial watchStartedAt write
  const projectSnapshot = mutateProject(projectId, (project) => {
    project.watchStartedAt = Date.now();
    project.figmaSession = buildFigmaSessionSnapshot(project, settings);
    return {
      type: project.type,
      files: project.files,
      createdAt: project.createdAt,
      watchStartedAt: project.watchStartedAt,
      figmaTrackedFiles: project.figmaTrackedFiles,
      figmaSession: project.figmaSession
    };
  });
  if (!projectSnapshot) return;

  // FIX 4 (H1): Converted from execSync to async — no longer blocks main process
  // v1.3.38: One-time lsof snapshot to capture files already open in design apps
  // BEFORE the polling loop begins.
  try {
    const keywords = DESIGN_APP_PROCESS_NAMES[projectSnapshot.type]
      || Object.values(DESIGN_APP_PROCESS_NAMES).flat();
    const { stdout: psOut } = await execFileAsync('/bin/ps', ['ax', '-o', 'pid=', '-o', 'command='], {
      timeout: 5000, encoding: 'utf8'
    });
    const pids = [];
    for (const line of psOut.trim().split('\n')) {
      const m = line.trim().match(/^\s*(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = parseInt(m[1]);
      const cmd = m[2];
      if (keywords.some(kw => cmd.includes(kw))) pids.push(pid);
    }

    if (pids.length > 0) {
      const home = os.homedir();
      const validPids = pids.filter(p => Number.isInteger(p) && p > 0);
      if (validPids.length > 0) {
        const { stdout: lsofOut } = await execFileAsync('/usr/sbin/lsof', ['-F', 'tn', '-p', validPids.join(',')], {
          timeout: 12000, encoding: 'utf8'
        });

        // FIX 1: Use mutateProject to atomically apply snapshot results
        // v2.2.2: Collect design files for scan-on-open
        const snapshotDesignFiles = [];

        mutateProject(projectId, (project) => {
          const existingPaths = new Set(project.files.map(f => f.path));
          let snapshotChanged = false;
          let currentType = null;
          const LINKABLE_EXTS_SNAPSHOT = new Set(['.ai', '.indd', '.idml', '.psd', '.pdf', '.afdesign', '.afpub', '.afphoto']);
          const linkableForParse = [];

          for (const line of lsofOut.trim().split('\n')) {
            if (line.length === 0) continue;
            const tag = line[0];
            const value = line.slice(1);

            if (tag === 'p' || tag === 'f') { currentType = null; continue; }
            if (tag === 't') { currentType = value; continue; }
            if (tag !== 'n') continue;
            if (currentType !== 'REG') { currentType = null; continue; }

            const filePath = value;
            currentType = null;

            if (!filePath.startsWith(home + '/')) continue;
            if (filePath.startsWith(home + '/Library/')) {
              if (path.extname(filePath).toLowerCase() !== '.fig') continue;
            }
            if (filePath.includes('/.')) continue;
            if (filePath.includes('.app/Contents/')) continue;

            const RESTRICTED_LSOF_TYPES = new Set(['presentation']);
            if (RESTRICTED_LSOF_TYPES.has(project.type)) {
              const isInWatchedDir = filePath.startsWith(home + '/Desktop/') ||
                                     filePath.startsWith(home + '/Documents/') ||
                                     filePath.startsWith(home + '/Downloads/');
              if (!isInWatchedDir) continue;
            }

            if (path.basename(filePath).startsWith('~$')) continue;

            // v2.5.5: Never capture presentation source files via lsof snapshot.
            // Same rule as the ongoing poller — .pptx/.key files are source files,
            // not linked assets. Their content is extracted via scan-on-save.
            const PRESENTATION_SOURCE_EXTS_SNAP = new Set(['.pptx', '.pptm', '.ppt', '.key', '.keynote']);
            if (PRESENTATION_SOURCE_EXTS_SNAP.has(path.extname(filePath).toLowerCase())) continue;

            // v2.5.5: Skip macOS screenshots at snapshot time — same filter as ongoing poller.
            if (/^Screen.?Shot/i.test(path.basename(filePath))) continue;

            const ext = path.extname(filePath).toLowerCase();
            if (!DESIGN_FILE_EXTENSIONS.has(ext)) continue;

            // New project guard: for an empty project, the initial snapshot should
            // only seed with primary source files (.fig/.psd/.ai/etc.), not old
            // image/font/pdf handles that an app may still have open.
            if (project.files.length === 0 && !PRIMARY_DESIGN_EXTENSIONS.has(ext)) continue;

            // v2.3.9: Mark for scan-on-open BEFORE existingPaths check —
            // pre-session files already in project still need asset extraction.
            if (SCAN_ON_OPEN_EXTENSIONS.has(ext)) {
              snapshotDesignFiles.push(filePath);
            }

            if (existingPaths.has(filePath)) continue;

            const fileEntry = {
              path: filePath,
              name: path.basename(filePath),
              ext,
              addedAt: Date.now(),
              source: 'lsof',
            };

            project.files.push(fileEntry);
            existingPaths.add(filePath);
            snapshotChanged = true;

            if (LINKABLE_EXTS_SNAPSHOT.has(ext)) {
              linkableForParse.push(fileEntry);
            }
          }

          // Parse linked assets from any linkable design files found in the snapshot
          if (linkableForParse.length > 0) {
            const LINKED_ASSET_REGEX_SNAPSHOT = /(?:\/Users\/|\/Volumes\/)[^\x00-\x1f\x22\x27]+\.(jpg|jpeg|png|gif|webp|svg|pdf|eps|ai|psd|tiff|tif|afdesign|afphoto|afpub|indd|idml|sketch|fig|heic|ttf|otf|woff|woff2|mp4|mov|avi|webm)/gi;
            for (const designFile of linkableForParse) {
              try {
                if (!fs.existsSync(designFile.path)) continue;
                const buf = fs.readFileSync(designFile.path);
                const content = buf.toString('utf8');
                let match;
                LINKED_ASSET_REGEX_SNAPSHOT.lastIndex = 0;
                while ((match = LINKED_ASSET_REGEX_SNAPSHOT.exec(content)) !== null) {
                  const linkedPath = match[0];
                  if (existingPaths.has(linkedPath)) continue;
                  if (!fs.existsSync(linkedPath)) continue;

                  project.files.push({
                    path: linkedPath,
                    name: path.basename(linkedPath),
                    ext: path.extname(linkedPath).toLowerCase(),
                    addedAt: Date.now(),
                    source: 'linked-asset',
                  });
                  existingPaths.add(linkedPath);
                  snapshotChanged = true;
                }
              } catch (e) {
                // read error — continue with others
              }
            }
          }

          if (snapshotChanged) {
            project.files = deduplicateFiles(project.files);
          }
        });

        // v2.2.2: Fire-and-forget scan-on-open for design files found in initial snapshot.
        // Initialize scannedDesignFiles for this project and mark these as scanned.
        if (snapshotDesignFiles.length > 0) {
          if (!scannedDesignFiles.has(projectId)) scannedDesignFiles.set(projectId, new Set());
          const scanned = scannedDesignFiles.get(projectId);
          for (const fp of snapshotDesignFiles) {
            scanned.add(fp);
            runScanOnOpen(projectId, fp).catch(() => {});
          }
        }
      }
    }
  } catch (e) {
    console.error('[crate] initial lsof snapshot error:', e.message);
  }

  // Stop existing watcher if any
  stopWatching(projectId);

  const homedir = os.homedir();
  const watchPaths = [
    path.join(homedir, 'Desktop'),
    path.join(homedir, 'Documents'),
    path.join(homedir, 'Downloads')
  ];

  // v2.6.3: Watch iCloud Drive synced Desktop & Documents folders.
  // When iCloud Drive "Desktop & Documents" sync is enabled, files land in
  // ~/Library/Mobile Documents/com~apple~CloudDocs/Desktop (and Documents)
  // instead of ~/Desktop, so chokidar must watch both locations.
  const iCloudBase = path.join(homedir, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  for (const folder of ['Desktop', 'Documents']) {
    const iCloudFolder = path.join(iCloudBase, folder);
    if (fs.existsSync(iCloudFolder)) {
      watchPaths.push(iCloudFolder);
    }
  }

  // v1.3.27: Watch Figma's local file storage for .fig files.
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

  // FIX 1: chokidar add handler uses mutateProject
  watcher.on('add', async (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    const name = path.basename(filePath);
    if (name.startsWith('.') || name.startsWith('._') || name === 'Thumbs.db') return;
    if (name.startsWith('~$')) return;
    // v2.2.5: Skip temp/backup files from all design apps (Illustrator ~, Photoshop .tmp, etc.)
    if (name.includes('~') || name.endsWith('.tmp')) return;

    // Small delay to let macOS write file metadata
    await new Promise(resolve => setTimeout(resolve, 500));

    // v2.2.6: Only capture PRIMARY design source files via chokidar 'add'.
    // Image/media/font/pdf files are NOT captured here — they produce false positives
    // because Finder and design app browsers briefly open images for thumbnails.
    // lsof polling is the reliable mechanism for capturing those files.
    if (PRIMARY_DESIGN_EXTENSIONS.has(ext)) {
      const fileEntry = { path: filePath, name, ext, addedAt: Date.now() };
      // v2.4.0: normalize path comparison to prevent duplicates
      const normFilePath = path.resolve(filePath).toLowerCase();
      const result = mutateProject(projectId, (proj) => {
        if (proj.status !== 'watching') return null;
        if (proj.files.some(f => path.resolve(f.path).toLowerCase() === normFilePath)) return null;
        proj.files.push(fileEntry);
        recordSessionObservedFile(proj, fileEntry, {
          kind: OBSERVER_KINDS.CHOKIDAR,
          method: 'add',
        });
        proj.files = deduplicateFiles(proj.files);
        return { files: proj.files };
      });

      if (result) {
        lastFileActivity.set(projectId, Date.now());
        inactivityNotified.delete(projectId);
        if (trayWindow && !trayWindow.isDestroyed()) {
          trayWindow.webContents.send('files:updated', { projectId, files: result.files });
        }
      }
    }

    // v2.4.9: CHOKIDAR_IMAGE_EXTENSIONS block permanently removed.
    // Images are NEVER captured by chokidar — produces false positives (browser downloads).
    // Image capture paths: lsof poller, scan-on-open, lastUsed poller, ag-psd/extractEmbeddedMedia at package time.
    // See LEARNINGS.md: "Chokidar must NEVER capture image files."
  });

  // FIX 1: chokidar change handler uses mutateProject
  // v2.2.2: Also triggers scan-on-open when a design file is modified
  watcher.on('change', async (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    const name = path.basename(filePath);
    if (name.startsWith('.') || name === 'Thumbs.db') return;
    if (name.startsWith('~$')) return;

    await new Promise(resolve => setTimeout(resolve, 500));

    // v2.2.6: Only re-scan PRIMARY design source files on change.
    // Same rationale as the 'add' handler — image/media changes are noise here.
    if (PRIMARY_DESIGN_EXTENSIONS.has(ext)) {
      const fileEntry = { path: filePath, name, ext, addedAt: Date.now() };
      // v2.4.0: normalize path comparison to prevent duplicates
      const normFilePath = path.resolve(filePath).toLowerCase();
      const result = mutateProject(projectId, (proj) => {
        if (proj.status !== 'watching') return null;
        if (proj.files.some(f => path.resolve(f.path).toLowerCase() === normFilePath)) return null;
        proj.files.push(fileEntry);
        recordSessionObservedFile(proj, fileEntry, {
          kind: OBSERVER_KINDS.CHOKIDAR,
          method: 'change',
        });
        proj.files = deduplicateFiles(proj.files);
        return { files: proj.files };
      });

      if (result) {
        lastFileActivity.set(projectId, Date.now());
        inactivityNotified.delete(projectId);
        if (trayWindow && !trayWindow.isDestroyed()) {
          trayWindow.webContents.send('files:updated', { projectId, files: result.files });
        }
      }

      // v2.2.2: When a design file changes, re-scan for linked assets
      // (designer may have added new links). Fire-and-forget.
      // C3: Skip runScanOnOpen for .psd — scheduleScanOnSave handles it with debounce
      // to avoid double ag-psd parse on every .psd save event.
      if (SCAN_ON_OPEN_EXTENSIONS.has(ext) && ext !== '.psd') {
        runScanOnOpen(projectId, filePath).catch(() => {});
      }

      // v2.5.0: Scan-on-save for PSD files — debounced, completely isolated pipeline.
      if (ext === '.psd') {
        scheduleScanOnSave(projectId, filePath);
      }

      // v2.5.3: Scan-on-save for presentation files — extract embedded media live.
      if (ext === '.pptx' || ext === '.ppt' || ext === '.key') {
        scheduleScanOnSavePresentation(projectId, filePath);
      }
    }

    // v2.4.9: CHOKIDAR_IMAGE_EXTENSIONS block permanently removed from 'change' handler too.
  });

  watchers.set(projectId, watcher);
  startLsofPolling(projectId); // begin lsof polling for linked assets
  if (projectHasFigmaTrackedFiles(projectSnapshot)) {
    startFigmaPolling(projectId); // begin Figma auto-tracking (if token is configured)
  }
  startPsPolling(projectId);    // begin Photoshop + InDesign polling (v2.3.0)
  startLastUsedPolling(projectId); // begin real-time kMDItemLastUsedDate polling (v2.3.3)
}

function stopWatching(projectId) {
  const watcher = watchers.get(projectId);
  if (watcher) {
    watcher.close();
    watchers.delete(projectId);
  }
  stopLsofPolling(projectId);
  stopFigmaPolling(projectId);
  stopPsPolling(projectId);
  stopLastUsedPolling(projectId); // v2.3.3
  lastFileActivity.delete(projectId);
  inactivityNotified.delete(projectId);
  designAppRunningCache.delete(projectId); // v2.4.2: clean up per-project cache
  // v2.2.2: Clean up scan-on-open state
  scannedDesignFiles.delete(projectId);
  designFilePids.delete(projectId);
  // v2.5.0: Clean up scan-on-save timers for this project
  for (const [key, timerId] of scanOnSaveTimers) {
    if (key.startsWith(projectId + ':')) {
      clearTimeout(timerId);
      scanOnSaveTimers.delete(key);
    }
  }
  // v2.5.3: Clean up presentation scan-on-save timers
  for (const [key, timerId] of scanOnSavePresentationTimers) {
    if (key.startsWith(projectId + ':')) {
      clearTimeout(timerId);
      scanOnSavePresentationTimers.delete(key);
    }
  }
}

// --- Inactivity Checker ---

let inactivityCheckerInterval = null; // C4: stored so it can be cleared on quit

function startInactivityChecker() {
  inactivityCheckerInterval = setInterval(() => {
    const projects = getProjects();
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

        // v2.4.2: Fallback — if tray window not visible, show native Notification
        if (!trayWindow || trayWindow.isDestroyed() || !trayWindow.isVisible()) {
          inactivityNotified.add(project.id);
          if (Notification.isSupported()) {
            const notif = new Notification({
              title: 'Crate — Still working?',
              body: `No new design files for "${project.name}" in 10 minutes. Click to open Crate.`,
              silent: false,
            });
            notif.on('click', () => {
              lastFileActivity.set(project.id, Date.now());
              inactivityNotified.delete(project.id);
              if (trayWindow && !trayWindow.isDestroyed()) {
                trayWindow.show();
              }
            });
            notif.show();
          }
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
            // Pause the project — FIX 1: use mutateProject
            mutateProject(project.id, (proj) => {
              proj.status = 'paused';
            });
            stopWatching(project.id);
            if (trayWindow && !trayWindow.isDestroyed()) {
              trayWindow.webContents.send('project:updated', { projectId: project.id });
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
  return getProjects();
});

ipcMain.handle('projects:create', async (event, name, projectType = 'branding', figmaScopeMode = FIGMA_SCOPE_CURRENT_PAGE, figmaUrl = null) => {
  const projects = getProjects();

  // Enforce project cap
  if (projects.length >= MAX_PROJECTS) {
    return { error: 'max_projects_reached' };
  }

  const cleanedName = (name || '').trim() || 'Untitled Project';

  let figmaTrackedFiles = [];
  if (typeof figmaUrl === 'string' && figmaUrl.trim()) {
    const { FigmaParser } = require('./parsers/figma');
    const trimmedUrl = figmaUrl.trim();
    const fileKey = FigmaParser.extractFileKey(trimmedUrl);
    if (!fileKey) {
      return { error: 'invalid_figma_url' };
    }
    figmaTrackedFiles = [{ key: fileKey, url: trimmedUrl }];
  }

  const newProject = {
    id: uuidv4(),
    name: cleanedName,
    type: projectType,
    figmaScopeMode: VALID_FIGMA_SCOPE_MODES.has(figmaScopeMode) ? figmaScopeMode : FIGMA_SCOPE_CURRENT_PAGE,
    figmaTrackedFiles,
    status: 'watching',
    files: [],
    pendingFiles: [], // Tier 2 candidates awaiting user review
    createdAt: Date.now(),
    packagedAt: null,
    outputPath: null
  };
  safelyEnsureProjectProvenance(newProject);
  projects.push(newProject);
  store.set('projects', projects);
  await startWatching(newProject.id);
  return newProject;
});

// Phase 2: per-project Figma link.
// payload: { url: string|null, scopeMode: 'current-page'|'entire-file' }
// Empty/null url clears the project's Figma link.
ipcMain.handle('projects:set-figma-link', async (event, projectId, payload = {}) => {
  const project = getProjects().find(p => p.id === projectId);
  if (!project) return { success: false, error: 'project_not_found' };

  const rawUrl = typeof payload.url === 'string' ? payload.url.trim() : '';
  const scopeMode = VALID_FIGMA_SCOPE_MODES.has(payload.scopeMode)
    ? payload.scopeMode
    : FIGMA_SCOPE_CURRENT_PAGE;

  let figmaTrackedFiles = [];
  if (rawUrl) {
    const { FigmaParser } = require('./parsers/figma');
    const fileKey = FigmaParser.extractFileKey(rawUrl);
    if (!fileKey) {
      return { success: false, error: 'invalid_figma_url' };
    }
    figmaTrackedFiles = [{ key: fileKey, url: rawUrl }];
  }

  const settings = store.get('settings') || {};
  const updated = mutateProject(projectId, (proj) => {
    proj.figmaTrackedFiles = figmaTrackedFiles;
    proj.figmaScopeMode = scopeMode;
    proj.figmaSession = buildFigmaSessionSnapshot(proj, settings);
    return proj;
  });

  if (updated && trayWindow && !trayWindow.isDestroyed()) {
    trayWindow.webContents.send('project:updated', { projectId });
  }

  if (updated && updated.status === 'watching') {
    if (projectHasFigmaTrackedFiles(updated)) {
      startFigmaPolling(projectId);
    } else {
      stopFigmaPolling(projectId);
    }
  }

  return { success: true, project: updated };
});

ipcMain.handle('projects:start-watching', async (event, id) => {
  const project = mutateProject(id, (proj) => {
    proj.status = 'watching';
  });
  if (project) {
    await startWatching(id);
  }
  return project;
});

ipcMain.handle('projects:pause', (event, id) => {
  const project = mutateProject(id, (proj) => {
    proj.status = 'paused';
  });
  if (project) {
    stopWatching(id);
  }
  return project;
});

ipcMain.handle('projects:get-files', (event, id) => {
  const projects = getProjects();
  const project = projects.find(p => p.id === id);
  return project ? project.files : [];
});

ipcMain.handle('projects:remove-file', (event, projectId, fileIdOrPath) => {
  const result = mutateProject(projectId, (project) => {
    // C2: Use fileId for removal when available (embedded files share the parent PSD path).
    // Fall back to path match for non-embedded files.
    project.files = project.files.filter(f => {
      if (f.fileId && f.fileId === fileIdOrPath) return false;
      if (!f.fileId && f.path === fileIdOrPath) return false;
      return true;
    });
    return project.files;
  });
  return result || [];
});

// --- Tier 2: Accept / reject pending files ---

ipcMain.handle('projects:accept-pending', (event, projectId, filePath) => {
  const result = mutateProject(projectId, (project) => {
    const idx = (project.pendingFiles || []).findIndex(f => f.path === filePath);
    if (idx === -1) return null;

    const [file] = project.pendingFiles.splice(idx, 1);

    if (!project.files.some(f => f.path === filePath)) {
      project.files.push(file);
      recordPendingFileDecision(project, file, 'accepted');
      project.files = deduplicateFiles(project.files);
      lastFileActivity.set(projectId, Date.now());
      inactivityNotified.delete(projectId);
    }

    return { files: project.files, pendingFiles: project.pendingFiles };
  });

  if (!result) return null;

  if (trayWindow && !trayWindow.isDestroyed()) {
    trayWindow.webContents.send('files:updated', { projectId, files: result.files });
    trayWindow.webContents.send('files:pending', { projectId, pendingFiles: result.pendingFiles });
  }

  return result;
});

ipcMain.handle('projects:reject-pending', (event, projectId, filePath) => {
  const result = mutateProject(projectId, (project) => {
    const file = (project.pendingFiles || []).find(f => f.path === filePath);
    project.pendingFiles = (project.pendingFiles || []).filter(f => f.path !== filePath);
    if (file) {
      recordPendingFileDecision(project, file, 'rejected');
    }
    return { pendingFiles: project.pendingFiles };
  });

  if (!result) return null;

  if (trayWindow && !trayWindow.isDestroyed()) {
    trayWindow.webContents.send('files:pending', { projectId, pendingFiles: result.pendingFiles });
  }

  return result.pendingFiles;
});

ipcMain.handle('projects:add-files', async (event, projectId) => {
  // M6: Filter to supported design + image file types
  const supportedExts = [...PRIMARY_DESIGN_EXTENSIONS, ...DESIGN_FILE_EXTENSIONS]
    .map(e => e.slice(1)); // strip leading dot
  const dialogResult = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    title: 'Add Files to Project',
    filters: [
      { name: 'Design & Image Files', extensions: [...new Set(supportedExts)] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  // Re-show tray window after native dialog closes (window hides on blur)
  showTrayWindow();

  if (dialogResult.canceled) return null;

  const filePaths = dialogResult.filePaths;
  const result = mutateProject(projectId, (project) => {
    for (const filePath of filePaths) {
      if (!project.files.some(f => f.path === filePath)) {
        const fileEntry = {
          path: filePath,
          name: path.basename(filePath),
          ext: path.extname(filePath).toLowerCase(),
          addedAt: Date.now(),
          source: 'manual-browse', // M1
        };
        project.files.push(fileEntry);
        recordSessionObservedFile(project, fileEntry, {
          kind: OBSERVER_KINDS.MANUAL_USER_ACTION,
          method: 'projects:add-files',
        });
      }
    }
    project.files = deduplicateFiles(project.files);
    return project.files;
  });

  return result;
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
  // FIX 2 (C2): Track scan in-flight so package handler can wait
  scanInFlight.add(projectId);
  try {
  const projects = getProjects();
  const project = projects.find(p => p.id === projectId);
  if (!project) return null;

  let newCount = 0;

  // v1.3.20: Targeted .fig scan for branding projects at package time.
  // v1.3.33: Entire scan block wrapped in 8-second timeout guard so the
  // backend never blocks the renderer for longer than that.
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

          if (!project.pendingFiles) project.pendingFiles = [];
          project.pendingFiles.push({
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
            const { stdout: mdlsRaw } = await execFileAsync("/usr/bin/mdls", ["-name", "kMDItemLastUsedDate", "-raw", fullPath], {
              timeout: 2000, encoding: 'utf8'
            });
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

          if (!project.pendingFiles) project.pendingFiles = [];
          project.pendingFiles.push({
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

  // v2.4.2: 30s aggregate timeout wrapping all AppleScript + ag-psd queries
  await Promise.race([
    (async () => {
  // v1.3.39 / v2.2.7: AppleScript query to Illustrator for linked files.
  // The regex approach fails on modern .ai files because PDF 1.6 compresses object
  // streams (FlateDecode), making linked paths unreadable from raw bytes.
  // AppleScript bypasses this entirely by asking Illustrator directly.
  // v2.2.7: Write AppleScript to temp file instead of inline osascript -e.
  try {
    const { stdout: aiPsCheck } = await execAsync(
      "/bin/ps ax -o command= 2>/dev/null | grep -i 'Adobe Illustrator' | grep -v grep",
      { timeout: 3000, encoding: 'utf8' }
    ).catch(() => ({ stdout: '' }));

    if (aiPsCheck.trim()) {
      const aiScriptPath = path.join(os.tmpdir(), `crate-ai-scan-${projectId}.applescript`);
      const aiAppleScript = `tell application "Adobe Illustrator"
  try
    set pathList to {}
    repeat with aDoc in documents
      repeat with pItem in every placed item of aDoc
        try
          if linked of pItem is true then
            set filePath to POSIX path of (file of pItem as alias)
            set end of pathList to filePath
          end if
        end try
      end repeat
    end repeat
    set AppleScript's text item delimiters to linefeed
    return pathList as text
  on error errMsg
    return ""
  end try
end tell`;

      await fs.promises.writeFile(aiScriptPath, aiAppleScript, 'utf8');
      try {
        const { stdout: aiPaths } = await execAsync(
          `/usr/bin/osascript "${aiScriptPath}"`,
          { timeout: 10000, encoding: 'utf8' }
        ).catch(() => ({ stdout: '' }));

        if (aiPaths.trim()) {
          const existingPaths = new Set(project.files.map(f => f.path));
          for (const linkedPath of aiPaths.trim().split('\n')) {
            const trimmed = linkedPath.trim();
            if (!trimmed) continue;
            if (existingPaths.has(trimmed)) continue;
            if (!fs.existsSync(trimmed)) continue;
            const ext = path.extname(trimmed).toLowerCase();
            if (!DESIGN_FILE_EXTENSIONS.has(ext)) continue;

            project.files.push({
              path: trimmed,
              name: path.basename(trimmed),
              ext,
              addedAt: Date.now(),
              source: 'ai-linked',
            });
            existingPaths.add(trimmed);
            newCount++;
          }
        }
      } finally {
        await fs.promises.unlink(aiScriptPath).catch(() => {});
      }
    }
  } catch (e) {
    // AppleScript failed or Illustrator not responding — fall through to regex
  }

  // v2.3.4: do javascript query to Photoshop for smart object / placed item paths.
  // Photoshop embeds images on placement — lsof misses the brief file read,
  // and regex fails because paths live in binary smart-object sections.
  // do javascript exposes embedded smart object paths via layer.smartObject.fileReference.
  try {
    const { stdout: psPsCheck } = await execAsync(
      "/bin/ps ax -o command= 2>/dev/null | grep -i 'Adobe Photoshop' | grep -v grep",
      { timeout: 3000, encoding: 'utf8' }
    ).catch(() => ({ stdout: '' }));

    if (psPsCheck.trim()) {
      const psJsPath = path.join(os.tmpdir(), `crate-ps-scan-${projectId}.js`);
      const psAsPath = path.join(os.tmpdir(), `crate-ps-scan-${projectId}.applescript`);

      await fs.promises.writeFile(psJsPath, PS_DOJAVASCRIPT, 'utf8');
      await fs.promises.writeFile(psAsPath, psDoJavascriptAS(psJsPath), 'utf8');
      try {
        const { stdout: psPaths } = await execAsync(
          `/usr/bin/osascript "${psAsPath}"`,
          { timeout: 10000, encoding: 'utf8' }
        ).catch(() => ({ stdout: '' }));

        if (psPaths.trim()) {
          const existingPaths = new Set(project.files.map(f => f.path));
          for (const trimmed of psPaths.split('\n').filter(Boolean)) {
            if (existingPaths.has(trimmed)) continue;
            if (!fs.existsSync(trimmed)) continue;
            const ext = path.extname(trimmed).toLowerCase();
            if (!DESIGN_FILE_EXTENSIONS.has(ext)) continue;

            project.files.push({
              path: trimmed,
              name: path.basename(trimmed),
              ext,
              addedAt: Date.now(),
              source: 'psd-linked',
            });
            existingPaths.add(trimmed);
            newCount++;
          }
        }
      } finally {
        await fs.promises.unlink(psJsPath).catch(() => {});
        await fs.promises.unlink(psAsPath).catch(() => {});
      }
    }
  } catch (e) {
    // do javascript failed or Photoshop not responding — fall through to regex
  }

  // v2.3.6: ag-psd binary parse — extract embedded smart objects from all .psd files.
  // Works even when Photoshop is not running.
  try {
    const psdFiles = project.files.filter(f => f.ext === '.psd');
    for (const psdFile of psdFiles) {
      if (!fs.existsSync(psdFile.path)) continue;
      const psdAssets = await extractPsdAssets(psdFile.path, projectId);
      for (const asset of psdAssets) {
        if (existingPaths.has(asset.filePath)) continue;
        project.files.push({
          path: asset.filePath,
          name: path.basename(asset.filePath),
          ext: path.extname(asset.filePath).toLowerCase(),
          addedAt: Date.now(),
          source: asset.source,
        });
        existingPaths.add(asset.filePath);
        newCount++;
      }
    }
  } catch (e) {
    // ag-psd parse failed — non-fatal
  }

  // v2.2.7: AppleScript query to InDesign for linked files.
  // InDesign has excellent scripting support — query all links of each document.
  try {
    const { stdout: inddPsCheck } = await execAsync(
      "/bin/ps ax -o command= 2>/dev/null | grep -i 'Adobe InDesign' | grep -v grep",
      { timeout: 3000, encoding: 'utf8' }
    ).catch(() => ({ stdout: '' }));

    if (inddPsCheck.trim()) {
      const inddScriptPath = path.join(os.tmpdir(), `crate-indd-scan-${projectId}.applescript`);
      const inddAppleScript = `tell application "Adobe InDesign"
  try
    set pathList to {}
    repeat with aDoc in every document
      repeat with aLink in every link of aDoc
        try
          set filePath to POSIX path of (file path of aLink as alias)
          set end of pathList to filePath
        end try
      end repeat
    end repeat
    set AppleScript's text item delimiters to linefeed
    return pathList as text
  on error
    return ""
  end try
end tell`;

      await fs.promises.writeFile(inddScriptPath, inddAppleScript, 'utf8');
      try {
        const { stdout: inddPaths } = await execAsync(
          `/usr/bin/osascript "${inddScriptPath}"`,
          { timeout: 10000, encoding: 'utf8' }
        ).catch(() => ({ stdout: '' }));

        if (inddPaths.trim()) {
          const existingPaths = new Set(project.files.map(f => f.path));
          for (const linkedPath of inddPaths.trim().split('\n')) {
            const trimmed = linkedPath.trim();
            if (!trimmed) continue;
            if (existingPaths.has(trimmed)) continue;
            if (!fs.existsSync(trimmed)) continue;
            const ext = path.extname(trimmed).toLowerCase();
            if (!DESIGN_FILE_EXTENSIONS.has(ext)) continue;

            project.files.push({
              path: trimmed,
              name: path.basename(trimmed),
              ext,
              addedAt: Date.now(),
              source: 'indd-linked',
            });
            existingPaths.add(trimmed);
            newCount++;
          }
        }
      } finally {
        await fs.promises.unlink(inddScriptPath).catch(() => {});
      }
    }
  } catch (e) {
    // AppleScript failed or InDesign not responding — fall through to regex
  }
    })(),
    new Promise(resolve => setTimeout(resolve, 30000))
  ]);

  // v1.3.24: Extract linked file paths from design files in the project.
  // Adobe/Affinity apps store absolute paths of linked/placed files as text
  // strings inside their binary formats. Reading the file as UTF-8 and
  // scanning for /Users/.../<ext> paths reliably finds all linked assets.
  // v1.3.36: Extended from .ai-only to full Adobe suite + Affinity.
  // Pattern: if we parse the file format to extract links, those links are
  // always relevant — never filter by date.
  const LINKED_ASSET_REGEX = /(?:\/Users\/|\/Volumes\/)[^\x00-\x1f\x22\x27]+\.(jpg|jpeg|png|gif|webp|svg|pdf|eps|ai|psd|tiff|tif|afdesign|afphoto|afpub|indd|idml|sketch|fig|heic|ttf|otf|woff|woff2|mp4|mov|avi|webm)/gi;
  const LINKABLE_EXTENSIONS = new Set(['.ai', '.indd', '.idml', '.psd', '.pdf', '.afdesign', '.afpub', '.afphoto']);
  const linkableFiles = project.files.filter(f => LINKABLE_EXTENSIONS.has(f.ext));
  if (linkableFiles.length > 0) {
    const linkExisting = new Set(project.files.map(f => f.path));

    for (const designFile of linkableFiles) {
      try {
        if (!fs.existsSync(designFile.path)) continue;
        const buf = await fs.promises.readFile(designFile.path);
        const content = buf.toString('utf8');
        let match;
        LINKED_ASSET_REGEX.lastIndex = 0;
        while ((match = LINKED_ASSET_REGEX.exec(content)) !== null) {
          const linkedPath = match[0];
          if (linkExisting.has(linkedPath)) continue;
          if (!fs.existsSync(linkedPath)) continue;

          project.files.push({
            path: linkedPath,
            name: path.basename(linkedPath),
            ext: path.extname(linkedPath).toLowerCase(),
            addedAt: Date.now(),
            source: 'linked-asset',
          });
          linkExisting.add(linkedPath);
          newCount++;
        }
      } catch (e) {
        // read error for this design file — continue with others
      }
    }
  }

  if (newCount > 0) {
    project.files = deduplicateFiles(project.files);
  }

  // v2.2.3: Pre-package double-check — re-extract linked assets from all scannable
  // design files in the project to catch anything missed during the session.
  try {
    const existingPathsCheck = new Set(project.files.map(f => f.path));
    let doubleCheckCount = 0;
    for (const file of project.files.slice()) {
      if (!SCAN_ON_OPEN_EXTENSIONS.has(file.ext)) continue;
      try {
        if (!fs.existsSync(file.path)) continue;
        const linkedPaths = await extractLinkedAssets(file.path);
        for (const lp of linkedPaths) {
          if (existingPathsCheck.has(lp)) continue;
          if (!lp.startsWith('/Users/')) continue;
          const lpExt = path.extname(lp).toLowerCase();
          if (!DESIGN_FILE_EXTENSIONS.has(lpExt)) continue;
          if (!fs.existsSync(lp)) continue;
          project.files.push({
            path: lp,
            name: path.basename(lp),
            ext: lpExt,
            addedAt: Date.now(),
            source: 'pre-package-doublecheck',
          });
          existingPathsCheck.add(lp);
          doubleCheckCount++;
        }
      } catch (e) {
        // extract error for this file — continue with others
      }
    }
    if (doubleCheckCount > 0) {
      project.files = deduplicateFiles(project.files);
      newCount += doubleCheckCount;
    }
  } catch (e) {
    // double-check pass failed — non-fatal
  }

  // Atomic merge: write scan results to store without overwriting concurrent poller changes.
  // The stale `projects` array was read at the start of this handler — pollers may have
  // added files via mutateProject during the scan. Using mutateProject here re-reads the
  // latest store state and merges in only the new files this scan discovered.
  if (newCount > 0) {
    const scanFiles = project.files;
    const scanPending = project.pendingFiles || [];
    const merged = mutateProject(projectId, (proj) => {
      const existingPaths = new Set(proj.files.map(f => f.path));
      for (const f of scanFiles) {
        if (!existingPaths.has(f.path)) {
          proj.files.push(f);
          existingPaths.add(f.path);
        }
      }
      if (scanPending.length > 0) {
        if (!proj.pendingFiles) proj.pendingFiles = [];
        const existPendingPaths = new Set(proj.pendingFiles.map(f => f.path));
        for (const f of scanPending) {
          if (!existPendingPaths.has(f.path) && !existingPaths.has(f.path)) {
            proj.pendingFiles.push(f);
          }
        }
      }
      proj.files = deduplicateFiles(proj.files);
      return { files: proj.files };
    });
    if (merged) project.files = merged.files;
  }

  // Figma authoritative recovery pass for package-time scan.
  // Keeps local lsof/.fig heuristics as-is and supplements with cloud originals.
  try {
    const ensuredSession = ensureProjectFigmaSession(projectId);
    const latestProject = getProjects().find(p => p.id === projectId) || project;
    const figmaSession = latestProject.figmaSession || ensuredSession || null;
    const rawTrackedFiles = (figmaSession && Array.isArray(figmaSession.trackedFiles)) ? figmaSession.trackedFiles : [];
    const teamIds = (figmaSession && Array.isArray(figmaSession.teamIds)) ? figmaSession.teamIds : [];
    const fileKeys = rawTrackedFiles.map(entry => entry.key);
    const normalizedTrackedFileKeys = Array.from(new Set(
      fileKeys.filter(key => typeof key === 'string' && key.trim())
    ));

    if (teamIds.length > 0 || fileKeys.length > 0) {
      const { FigmaParser } = require('./parsers/figma');
      const parser = new FigmaParser();
      console.log(
        `[crate][figma] scan config (pre-package): ` +
        `rawTrackedFiles=${JSON.stringify(rawTrackedFiles)} ` +
        `trackedFileKeys=${JSON.stringify(normalizedTrackedFileKeys)} ` +
        `teamIds=${JSON.stringify(teamIds)} ` +
        `sinceMs=${watchStart} lastScanMs=null watchStart=${watchStart}`
      );
      const figmaScanResult = await parser.autoTrackScan({
        sinceMs: watchStart,
        maxAgeDays: 30,
        maxFiles: 20,
        teamIds,
        fileKeys,
        scopeEntries: rawTrackedFiles
      });

      mergeFigmaScopeEntriesIntoSession(projectId, figmaScanResult.scopeEntries || []);

      if (figmaScanResult.errors && figmaScanResult.errors.length > 0) {
        console.warn('[crate][figma] pre-package scan errors:', figmaScanResult.errors);
      }

      if (figmaScanResult.assets && figmaScanResult.assets.length > 0) {
        const scopedAssets = figmaScanResult.assets.map((asset) => ({
          ...asset,
          figmaScopeMode: (figmaSession && figmaSession.scopeMode) || FIGMA_SCOPE_ENTIRE_FILE
        }));
        const figmaAdded = await ingestFigmaAssetsIntoProject(projectId, project, scopedAssets, 'pre-package');
        newCount += figmaAdded;
      }
    }
  } catch (e) {
    console.warn('[crate][figma] pre-package recovery failed:', e.message);
  }

  project.files = deduplicateFiles(project.files);

  return { files: project.files, newCount };
  } finally {
    // FIX 2 (C2): Always clear scan-in-flight flag
    scanInFlight.delete(projectId);
  }
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
// v1.3.9–v1.3.35: Date-based filtering was used here to distinguish user images
// from theme assets. REMOVED in v1.3.36: pre-existing assets embedded in the
// project file before the Watch session must be captured. Keynote junk filters
// (st-/mt-/bg-/tx-UUID, -small thumbnails) handle theme assets without date gating.

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

async function extractEmbeddedMedia(presentationPath, destFolder, projectFiles) {
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
      // v2.5.9: scan-on-save-presentation prefixes filenames with "{PresentationName} — ".
      // At package time the Keynote dedup checks the raw embedded name (e.g. "image-001"),
      // which never matches the prefixed version ("mypresentation — image-001"). Strip the
      // prefix so both forms are in the set and dedup works correctly.
      if (f.source === 'scan-on-save-presentation') {
        const separatorIdx = n.indexOf(' — ');
        if (separatorIdx !== -1) alreadyCapturedBases.add(n.slice(separatorIdx + 3).trim());
      }
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

  try {
    // List the zip contents — format: "  length  MM-DD-YYYY HH:MM  filename"
    const { stdout: listing } = await execFileAsync("/usr/bin/unzip", ["-l", presentationPath], {
      timeout: 10000, encoding: 'utf8'
    });

    for (const line of listing.split('\n')) {
      // Match: length, date (MM-DD-YYYY), time (HH:MM), filename
      const m = line.match(/^\s+(\d+)\s+(\d{2}-\d{2}-\d{4})\s+(\d{2}:\d{2})\s+(.+)$/);
      if (!m) continue;

      const fileSize = parseInt(m[1], 10);
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

      // v1.3.36: Date filter removed — pre-existing embedded assets are always
      // relevant. Keynote junk is handled by the st-/mt-/bg-/tx-UUID and -small
      // filters below. PowerPoint's ppt/media/ only contains used images.

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

function resolveUniquePackagePath(destFolder, fileName) {
  const destPath = path.join(destFolder, fileName);
  let finalPath = destPath;
  let counter = 1;
  while (fs.existsSync(finalPath)) {
    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);
    finalPath = path.join(destFolder, `${base}_${counter}${ext}`);
    counter++;
  }
  return finalPath;
}

function isScanOnSaveEmbeddedPsdFile(file) {
  return !!(file && file.embedded && file.source === 'scan-on-save-embedded');
}

function findEmbeddedPsdLinkedFile(file, linkedFiles) {
  if (!Array.isArray(linkedFiles)) return null;

  const hasData = (linkedFile) => linkedFile && linkedFile.data !== undefined && linkedFile.data !== null;
  const expectedOriginalName = typeof file.embeddedOriginalName === 'string' ? file.embeddedOriginalName : '';
  const expectedSafeName = sanitizeEmbeddedPsdAssetName(file.name || expectedOriginalName);
  const matchesFile = (linkedFile) => {
    if (!linkedFile) return false;
    if (expectedOriginalName && linkedFile.name === expectedOriginalName) return true;
    return sanitizeEmbeddedPsdAssetName(linkedFile.name) === expectedSafeName;
  };

  if (Number.isInteger(file.embeddedIndex)) {
    const linkedFile = linkedFiles[file.embeddedIndex];
    return hasData(linkedFile) && matchesFile(linkedFile) ? linkedFile : null;
  }

  const matches = linkedFiles.filter(linkedFile => hasData(linkedFile) && matchesFile(linkedFile));
  return matches.length === 1 ? matches[0] : null;
}

async function writeEmbeddedPsdAssetToPackage(file, finalPath) {
  const parentPsd = file.parentPsd || file.path;
  if (!parentPsd || !fs.existsSync(parentPsd)) {
    throw new Error('Parent PSD not found');
  }

  const stat = await fs.promises.stat(parentPsd);
  if (stat.size > MAX_PARSE_FILE_SIZE) {
    throw new Error('Parent PSD exceeds parse size limit');
  }

  const buf = await fs.promises.readFile(parentPsd);
  const psd = readPsd(buf, { skipLayerImageData: true, skipCompositeImageData: true });
  const linkedFile = findEmbeddedPsdLinkedFile(file, psd.linkedFiles || []);
  if (!linkedFile) {
    throw new Error('Embedded PSD asset not found');
  }

  await fs.promises.writeFile(finalPath, Buffer.from(linkedFile.data));
}

ipcMain.handle('projects:package', async (event, id, outputPath) => {
  // C1: Prevent double-click / concurrent packaging
  if (packageInFlight) return { error: 'package_in_flight' };
  packageInFlight = true;

  try {
  // FIX 2 (C2): Wait for in-flight pre-scan to complete before packaging
  if (scanInFlight.has(id)) {
    const scanWaitStart = Date.now();
    while (scanInFlight.has(id) && Date.now() - scanWaitStart < 10000) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  checkAndResetUsage();
  const usage = store.get('usage');

  // Check freemium limit
  if (usage.packagesThisMonth >= 10) {
    const daysLeft = Math.ceil((new Date(usage.resetDate) - new Date()) / (1000 * 60 * 60 * 24));
    return { error: 'limit_reached', daysLeft };
  }

  const projects = getProjects();
  const project = projects.find(p => p.id === id);
  if (!project) return { error: 'not_found' };
  const packageFiles = await selectProjectFilesForPackaging(project);

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

    for (const file of packageFiles) {
      try {
        if (isScanOnSaveEmbeddedPsdFile(file)) {
          const safeName = sanitizeEmbeddedPsdAssetName(file.name || file.embeddedOriginalName);
          const finalPath = resolveUniquePackagePath(destFolder, safeName);
          await writeEmbeddedPsdAssetToPackage(file, finalPath);
          copiedCount++;
          continue;
        }

        if (fs.existsSync(file.path)) {
          const finalPath = resolveUniquePackagePath(destFolder, file.name);
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

    // v1.3.37: When Keynote/PowerPoint re-saves, both old and new versions may
    // be tracked. Group by base filename and only extract from the newest (by mtime)
    // to avoid double-counting embedded media.
    const presentationsByName = new Map();
    for (const file of packageFiles) {
      const fileExt = path.extname(file.name).toLowerCase();
      if (ZIP_BASED_FORMATS.has(fileExt) && fs.existsSync(file.path)) {
        // M3: Use full normalized path as dedup key, not just basename,
        // so files with the same name in different directories aren't merged.
        const dedupKey = path.resolve(file.path).toLowerCase();
        let mtime = 0;
        try { mtime = fs.statSync(file.path).mtimeMs; } catch (e) {}
        const existing = presentationsByName.get(dedupKey);
        if (!existing || mtime > existing.mtime) {
          presentationsByName.set(dedupKey, { file, mtime });
        }
      }
    }

    for (const { file } of presentationsByName.values()) {
      try {
        const embeddedFiles = await extractEmbeddedMedia(file.path, destFolder, packageFiles);
        embeddedCount += embeddedFiles.length;
      } catch (embedErr) {
        // M7: Report embedded extraction errors so user sees 'X files packaged, Y errors'
        errors.push(`Embedded media extraction failed for ${file.name}: ${embedErr.message}`);
      }
    }

    // Auto-stop watcher — SECURITY REQUIREMENT
    stopWatching(id);

    // FIX 1: Use mutateProject to atomically update project status
    mutateProject(id, (proj) => {
      proj.status = 'packaged';
      proj.packagedAt = Date.now();
      proj.outputPath = destFolder;
    });

    // Increment usage
    usage.packagesThisMonth++;
    store.set('usage', usage);

    // Send notification if enabled
    if (settings.notifications && Notification.isSupported()) {
      new Notification({
        title: 'Project Packaged!',
        body: `${project.name} \u2014 ${copiedCount + embeddedCount} files gathered.`
      }).show();
    }

    // Re-show tray window so user sees the success confirmation
    showTrayWindow();

    return {
      success: true,
      copiedCount,
      embeddedCount,
      totalFiles: packageFiles.length,
      folderPath: destFolder,
      errors
    };
  } catch (err) {
    showTrayWindow();
    return { error: err.message };
  }
  } finally {
    packageInFlight = false;
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
  const result = mutateProject(id, (project, projects) => {
    const idx = projects.indexOf(project);
    if (idx !== -1) projects.splice(idx, 1);
    return projects;
  });
  // If project wasn't found, return current state
  return result || getProjects();
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
  for (const [, intervalId] of figmaPollers) {
    clearInterval(intervalId);
  }
  figmaPollers.clear();
  figmaPollerStarting.clear();
  figmaInProgress.clear();
  figmaManualScanInFlight.clear();
  figmaScanTimestamps.clear();
  // Clean up PS/InDesign pollers (v2.3.0)
  for (const [, intervalId] of psPollers) {
    clearInterval(intervalId);
  }
  psPollers.clear();
  psPollerStarting.clear();
  psInProgress.clear();
  // Clean up lastUsed pollers (v2.3.3)
  for (const [, intervalId] of lastUsedPollers) {
    clearInterval(intervalId);
  }
  lastUsedPollers.clear();
  lastFileActivity.clear();
  inactivityNotified.clear();
  designAppRunningCache.clear(); // v2.4.2
  // v2.2.2: Clean up scan-on-open state
  scannedDesignFiles.clear();
  designFilePids.clear();

  store.set('projects', []);
  return [];
});

// --- V2 Quick Package ---

ipcMain.handle('v2:browse-file', async () => {
  const { SUPPORTED_EXTENSIONS } = require('./parsers/index.js');
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    title: 'Select Master Design File',
    filters: [
      { name: 'Design Files', extensions: SUPPORTED_EXTENSIONS.map(e => e.slice(1)) }
    ]
  });
  showTrayWindow();
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('v2:package-file', async (event, filePath) => {
  const { packageMasterFile } = require('./parsers/index.js');

  // v2.5.0: Quick Package defaults to Desktop — no second confirmation dialog.
  // Previously showed an output directory picker, which combined with the browse file
  // picker created a double-prompt regression.
  const outputDir = path.join(os.homedir(), 'Desktop');

  // Generate folder name based on master file
  const baseName = path.basename(filePath, path.extname(filePath));
  const dateStr = new Date().toISOString().split('T')[0];
  const folderName = `${baseName}_${dateStr}`;
  const destFolder = path.join(outputDir, folderName);

  try {
    const result = await packageMasterFile(filePath, destFolder);
    return {
      success: true,
      masterFile: result.masterFile,
      assetsFound: result.assetsFound,
      assetsCopied: result.assetsCopied,
      assetsMissing: result.assetsMissing,
      outputDir: destFolder,
      files: result.files
    };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('v2:supported-extensions', () => {
  const { SUPPORTED_EXTENSIONS } = require('./parsers/index.js');
  return SUPPORTED_EXTENSIONS;
});

// --- Figma Integration ---

ipcMain.handle('figma:status', async () => {
  const { FigmaParser } = require('./parsers/figma');
  const parser = new FigmaParser();
  const token = await parser.getStoredToken();

  // Get auto-tracking stats
  const projects = getProjects();
  const activePollers = [];
  let totalFigmaAssets = 0;

  for (const project of projects) {
    if (figmaPollers.has(project.id)) {
      activePollers.push(project.id);
    }
    // Count Figma-sourced files across all projects
    const figmaFiles = (project.files || []).filter(f => f.source === 'figma-auto');
    totalFigmaAssets += figmaFiles.length;
  }

  return {
    connected: !!token,
    autoTracking: activePollers.length > 0,
    activeProjectCount: activePollers.length,
    totalFigmaAssets
  };
});

ipcMain.handle('figma:connect', async (event, token) => {
  const { FigmaParser } = require('./parsers/figma');
  const parser = new FigmaParser();

  // Store token first, then verify on first poll (verifyToken reads from storage)
  const stored = await parser.storeToken(token);

  if (stored) {
    // Start Figma polling for any currently watching projects
    const projects = getProjects();
    for (const project of projects) {
      if (project.status === 'watching' && projectHasFigmaTrackedFiles(project) && !figmaPollers.has(project.id)) {
        startFigmaPolling(project.id);
      }
    }
  }

  return { success: stored };
});

ipcMain.handle('figma:disconnect', async () => {
  const { FigmaParser } = require('./parsers/figma');
  const parser = new FigmaParser();
  const deleted = await parser.deleteToken();

  // Stop all Figma polling
  for (const [projectId, intervalId] of figmaPollers) {
    clearInterval(intervalId);
  }
  figmaPollers.clear();
  figmaPollerStarting.clear();
  figmaInProgress.clear();
  figmaManualScanInFlight.clear();
  figmaScanTimestamps.clear();

  return { success: deleted };
});

// Trigger a manual Figma scan for a specific project
ipcMain.handle('figma:scan-project', async (event, projectId) => {
  const { FigmaParser } = require('./parsers/figma');
  const parser = new FigmaParser();
  const token = await parser.getStoredToken();

  if (!token) {
    return { success: false, error: 'Figma not connected' };
  }

  const project = getProjects().find(p => p.id === projectId);
  if (!project) {
    return { success: false, error: 'Project not found' };
  }

  try {
    await pollFigmaForProject(projectId, true);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Get Figma assets count for a specific project
ipcMain.handle('figma:project-assets', async (event, projectId) => {
  const project = getProjects().find(p => p.id === projectId);
  if (!project) {
    return { count: 0, assets: [] };
  }

  const figmaAssets = (project.files || []).filter(f => f.source === 'figma-auto');
  return {
    count: figmaAssets.length,
    assets: figmaAssets.map(f => ({
      path: f.path,
      name: f.name,
      figmaFileName: f.figmaFileName,
      figmaFileKey: f.figmaFileKey
    }))
  };
});

ipcMain.handle('figma:scan-now', async (event) => {
  // Phase 2: only scan watching projects that have a per-project Figma link.
  const projects = getProjects().filter(p =>
    p.status === 'watching' &&
    projectHasFigmaTrackedFiles(p)
  );
  if (projects.length === 0) {
    return { triggered: 0, skipped: 0, totalAddedCount: 0 };
  }

  const scannableProjects = projects.filter(project => !figmaManualScanInFlight.has(project.id));
  const skipped = projects.length - scannableProjects.length;

  if (scannableProjects.length === 0) {
    return { triggered: 0, skipped, totalAddedCount: 0, inFlight: true };
  }

  scannableProjects.forEach(project => {
    figmaManualScanInFlight.add(project.id);
    sendToRenderer('figma:scan-started', {
      projectId: project.id,
      source: 'manual',
      timestamp: Date.now()
    });
  });

  const scanResults = await Promise.all(
    scannableProjects.map(async (project) => {
      try {
        return await pollFigmaForProject(project.id, false);
      } finally {
        figmaManualScanInFlight.delete(project.id);
      }
    })
  );

  const totalAddedCount = scanResults.reduce((sum, result) => sum + (result?.addedCount || 0), 0);

  return { triggered: scannableProjects.length, skipped, totalAddedCount };
});

ipcMain.handle('settings:get', () => {
  return store.get('settings');
});

ipcMain.handle('settings:update', (event, key, value) => {
  // FIX 7 (M1): Whitelist allowed setting keys to prevent arbitrary store writes
  const ALLOWED_SETTINGS = new Set(["namingTemplate", "notifications"]);
  if (!ALLOWED_SETTINGS.has(key)) return store.get('settings');
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
  const project = mutateProject(projectId, (proj) => {
    proj.status = 'paused';
  });
  if (project) {
    stopWatching(projectId);
  }
  return project;
});

// --- App Lifecycle ---

app.whenReady().then(async () => {
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

  // Resume watching for any active projects (FIX 4: await async startWatching)
  const projects = getProjects();
  for (const project of projects) {
    if (project.status === 'watching') {
      await startWatching(project.id);
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
  // Clean up Figma pollers
  for (const [, intervalId] of figmaPollers) {
    clearInterval(intervalId);
  }
  figmaPollers.clear();
  figmaPollerStarting.clear();
  figmaInProgress.clear();
  figmaScanTimestamps.clear();
  // Clean up PS/InDesign pollers (v2.3.0)
  for (const [, intervalId] of psPollers) {
    clearInterval(intervalId);
  }
  psPollers.clear();
  psPollerStarting.clear();
  psInProgress.clear();
  // Clean up lastUsed pollers (v2.3.3)
  for (const [, intervalId] of lastUsedPollers) {
    clearInterval(intervalId);
  }
  lastUsedPollers.clear();
  // v2.2.2: Clean up scan-on-open state
  scannedDesignFiles.clear();
  designFilePids.clear();
  // C4: Clean up inactivity checker
  if (inactivityCheckerInterval) {
    clearInterval(inactivityCheckerInterval);
    inactivityCheckerInterval = null;
  }
  // v2.5.0: Clean up scan-on-save timers
  for (const [, timerId] of scanOnSaveTimers) {
    clearTimeout(timerId);
  }
  scanOnSaveTimers.clear();
  for (const [, timerId] of scanOnSavePresentationTimers) {
    clearTimeout(timerId);
  }
  scanOnSavePresentationTimers.clear();
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
