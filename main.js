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
  PROVENANCE_SCHEMA_VERSION,
  OBSERVER_KINDS,
  CONFIDENCE_BANDS,
  createNodeId,
  createEdgeId,
  createDedupeKey,
  createConfidence,
  createObservationRecord,
  ensureProjectProvenance,
  appendObservation,
  upsertEvidence,
} = require('./provenance');
const {
  sanitizePackageFileName,
  ensureSafePackageDirectory,
  resolveUniquePackagePath: resolveSafeUniquePackagePath,
  copyFileIntoPackage,
  assertSafeCopySource,
  writeFileIntoPackageExact,
} = require('./parsers/package-safety');

const PROVENANCE_MANIFEST_FILENAME = 'crate-provenance.json';
const DIAGNOSTICS_FOLDER_NAME = 'Crate Diagnostics';
const TEMP_SCRIPT_DIR_PREFIX = 'crate-script-';
const TEMP_SCRIPT_DIR_MODE = 0o700;
const TEMP_SCRIPT_FILE_MODE = 0o600;
const OWNER_ONLY_DIR_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const DEFAULT_NAMING_TEMPLATE = '{Project}_{Date}';
const DEFAULT_PACKAGE_FOLDER_NAME = 'Untitled';
const MAX_PACKAGE_FOLDER_NAME_LENGTH = 180;
const UNSAFE_PACKAGE_FOLDER_CHARS = /[\x00-\x1f\x7f<>:"|?*\\/]/g;

function realpathSync(targetPath) {
  return (fs.realpathSync.native || fs.realpathSync)(targetPath);
}

function sanitizePackageFolderName(rawName, fallbackName = DEFAULT_PACKAGE_FOLDER_NAME) {
  let fallback = `${fallbackName || DEFAULT_PACKAGE_FOLDER_NAME}`
    .replace(UNSAFE_PACKAGE_FOLDER_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (!fallback || fallback === '.' || fallback === '..') fallback = DEFAULT_PACKAGE_FOLDER_NAME;

  let name = `${rawName || ''}`
    .replace(UNSAFE_PACKAGE_FOLDER_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim();

  if (name.startsWith('..')) name = name.replace(/^\.+/, '').trim();
  if (!name || name === '.' || name === '..') name = fallback;
  if (name.length > MAX_PACKAGE_FOLDER_NAME_LENGTH) {
    name = name.slice(0, MAX_PACKAGE_FOLDER_NAME_LENGTH).trim();
  }
  return name || fallback;
}

function sanitizeNamingTemplate(rawTemplate) {
  return sanitizePackageFolderName(rawTemplate, DEFAULT_NAMING_TEMPLATE);
}

function resolvePackageFolderInsideOutput(outputPath, rawFolderName) {
  if (!outputPath || typeof outputPath !== 'string' || outputPath.includes('\0')) {
    throw new Error('Invalid package output folder');
  }

  const outputRoot = path.resolve(outputPath);
  const safeFolderName = sanitizePackageFolderName(rawFolderName);
  const destFolder = path.resolve(outputRoot, safeFolderName);
  if (!isPathInsideDirectory(outputRoot, destFolder) || path.relative(outputRoot, destFolder) === '') {
    throw new Error('Package output folder escapes selected output folder');
  }

  const ensuredFolder = ensureSafePackageDirectory(destFolder);
  if (!isPathInsideDirectory(outputRoot, ensuredFolder)) {
    throw new Error('Package output folder escapes selected output folder');
  }

  const realOutputRoot = realpathSync(outputRoot);
  const realDestFolder = realpathSync(ensuredFolder);
  if (!isPathInsideDirectory(realOutputRoot, realDestFolder)) {
    throw new Error('Package output folder escapes selected output folder');
  }
  return ensuredFolder;
}

function safeTempScriptName(name) {
  if (typeof name !== 'string' || name.trim() === '' || name !== path.basename(name)) {
    throw new Error('Invalid temporary script name');
  }
  return name;
}

async function runOsascriptInPrivateTemp(buildScripts, entryScriptName, options = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_SCRIPT_DIR_PREFIX));
  const resolveScriptPath = (name) => path.join(tempDir, safeTempScriptName(name));

  try {
    try { fs.chmodSync(tempDir, TEMP_SCRIPT_DIR_MODE); } catch (_) {}

    const scripts = buildScripts({ tempDir, resolveScriptPath }) || {};
    for (const [name, contents] of Object.entries(scripts)) {
      const scriptPath = resolveScriptPath(name);
      await fs.promises.writeFile(scriptPath, contents, {
        encoding: 'utf8',
        flag: 'wx',
        mode: TEMP_SCRIPT_FILE_MODE,
      });
      try { fs.chmodSync(scriptPath, TEMP_SCRIPT_FILE_MODE); } catch (_) {}
    }

    const entryScriptPath = resolveScriptPath(entryScriptName);
    if (!Object.prototype.hasOwnProperty.call(scripts, safeTempScriptName(entryScriptName))) {
      throw new Error('Missing temporary entry script');
    }

    return await execFileAsync('/usr/bin/osascript', [entryScriptPath], options);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

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

const LIVE_CAPTURE_DECISIONS = Object.freeze({
  DIRECT_ADD: 'direct_add',
  PENDING_CANDIDATE: 'pending_candidate',
  IGNORE_EXCLUDED: 'ignore_excluded',
  IGNORE_DUPLICATE: 'ignore_duplicate',
});

const AUTO_CAPTURE_PACKAGE_OUTPUT_FOLDER_NAMES = new Set([
  'crate diagnostics',
  'package-outputs',
  'package output',
  'package outputs',
]);

const BROAD_LIVE_CAPTURE_SOURCES = new Set([
  'lsof',
  'ps-poll',
  'indd-poll',
  'lastused-poll',
  'lsof-package-scan',
  'ai-linked',
  'indd-linked',
]);

function getNormalizedPathSet(files) {
  return new Set((Array.isArray(files) ? files : [])
    .map(file => normalizeTrackedFilePath(file && file.path))
    .filter(Boolean));
}

function getTrackedFileKeySet(files) {
  return new Set((Array.isArray(files) ? files : [])
    .map(file => getTrackedFileDedupKey(file))
    .filter(Boolean));
}

function getAutoCapturePathSegments(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return [];
  return path.resolve(filePath.trim())
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean);
}

function isLikelyDatedPackageFolderName(folderName) {
  return /^[^/\\]+_\d{4}-\d{2}-\d{2}$/.test(String(folderName || ''));
}

function isPathInsideOrEqual(parentDir, filePath) {
  if (typeof parentDir !== 'string' || !parentDir.trim()) return false;
  if (typeof filePath !== 'string' || !filePath.trim()) return false;
  const parent = path.resolve(parentDir);
  const candidate = path.resolve(filePath);
  const relativePath = path.relative(parent, candidate);
  return relativePath === '' || (!!relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function getKnownPackageOutputPaths(projects = getProjects()) {
  const paths = [];
  for (const project of Array.isArray(projects) ? projects : []) {
    if (project && typeof project.outputPath === 'string' && project.outputPath.trim()) {
      paths.push(project.outputPath);
    }
  }
  const quickPackageOutputs = store && typeof store.get === 'function'
    ? store.get('quickPackageOutputPaths', [])
    : [];
  if (Array.isArray(quickPackageOutputs)) {
    for (const outputPath of quickPackageOutputs) {
      if (typeof outputPath === 'string' && outputPath.trim()) paths.push(outputPath);
    }
  }
  return Array.from(new Set(paths.map(outputPath => path.resolve(outputPath))));
}

function rememberGeneratedPackageOutputPath(outputPath) {
  if (typeof outputPath !== 'string' || !outputPath.trim()) return;
  try {
    const resolvedOutput = path.resolve(outputPath);
    const current = store.get('quickPackageOutputPaths', []);
    const next = Array.isArray(current) ? current.slice() : [];
    if (!next.some(existing => path.resolve(existing) === resolvedOutput)) {
      next.push(resolvedOutput);
      store.set('quickPackageOutputPaths', next.slice(-50));
    }
  } catch (_) {
    // Best effort. This only improves future auto-capture exclusions.
  }
}

function isAutoCaptureExcludedPath(filePath, projects = getProjects()) {
  if (typeof filePath !== 'string' || !filePath.trim()) return true;

  const segments = getAutoCapturePathSegments(filePath);
  const lowerSegments = segments.map(segment => segment.toLowerCase());
  const lowerBase = (segments[segments.length - 1] || '').toLowerCase();

  if (lowerBase === PROVENANCE_MANIFEST_FILENAME.toLowerCase()) return true;
  if (lowerSegments.some(segment => AUTO_CAPTURE_PACKAGE_OUTPUT_FOLDER_NAMES.has(segment))) return true;

  for (const outputPath of getKnownPackageOutputPaths(projects)) {
    if (isPathInsideOrEqual(outputPath, filePath)) return true;
  }

  // Automatic capture only: Crate's package folder format is "{Project}_{YYYY-MM-DD}".
  // Manual explicit add remains allowed even when a folder happens to match this shape.
  for (let i = 0; i < segments.length - 1; i++) {
    if (isLikelyDatedPackageFolderName(segments[i])) return true;
  }

  return false;
}

function isAcceptedProjectFilePath(project, filePath) {
  const normalizedPath = normalizeTrackedFilePath(filePath);
  if (!normalizedPath) return false;
  return getNormalizedPathSet(project && project.files).has(normalizedPath);
}

function buildAutoCaptureFileEntry(filePath, source, extra = {}) {
  return {
    path: filePath,
    name: path.basename(filePath),
    ext: path.extname(filePath).toLowerCase(),
    addedAt: Date.now(),
    source,
    ...extra,
  };
}

function classifyLiveObservedFile(project, fileEntry, observation = {}) {
  const normalizedPath = normalizeTrackedFilePath(fileEntry && fileEntry.path);
  if (!project || !fileEntry || !normalizedPath) {
    return { decision: LIVE_CAPTURE_DECISIONS.IGNORE_EXCLUDED, reason: 'invalid-path', normalizedPath };
  }

  if (isAutoCaptureExcludedPath(fileEntry.path)) {
    return { decision: LIVE_CAPTURE_DECISIONS.IGNORE_EXCLUDED, reason: 'crate-output-path', normalizedPath };
  }

  const candidateKey = getTrackedFileDedupKey(fileEntry);
  const acceptedKeys = getTrackedFileKeySet(project.files);
  if (acceptedKeys.has(candidateKey)) {
    return { decision: LIVE_CAPTURE_DECISIONS.IGNORE_DUPLICATE, reason: 'already-accepted', normalizedPath };
  }

  const pendingKeys = getTrackedFileKeySet(project.pendingFiles);
  if (pendingKeys.has(candidateKey)) {
    return { decision: LIVE_CAPTURE_DECISIONS.IGNORE_DUPLICATE, reason: 'already-pending', normalizedPath };
  }

  if (observation.forcePending === true || BROAD_LIVE_CAPTURE_SOURCES.has(fileEntry.source)) {
    return { decision: LIVE_CAPTURE_DECISIONS.PENDING_CANDIDATE, reason: observation.reason || 'broad-observer', normalizedPath };
  }

  if (observation.allowDirect === true) {
    return { decision: LIVE_CAPTURE_DECISIONS.DIRECT_ADD, reason: observation.reason || 'strong-session-observation', normalizedPath };
  }

  if (observation.relationshipSourcePath) {
    return isAcceptedProjectFilePath(project, observation.relationshipSourcePath)
      ? { decision: LIVE_CAPTURE_DECISIONS.DIRECT_ADD, reason: observation.reason || 'accepted-source-relationship', normalizedPath }
      : { decision: LIVE_CAPTURE_DECISIONS.PENDING_CANDIDATE, reason: observation.reason || 'unaccepted-source-relationship', normalizedPath };
  }

  return { decision: LIVE_CAPTURE_DECISIONS.PENDING_CANDIDATE, reason: observation.reason || 'unclassified-auto-observer', normalizedPath };
}

function stageLiveObservedFile(project, fileEntry, observation = {}) {
  const classification = classifyLiveObservedFile(project, fileEntry, observation);
  const normalizedPath = classification.normalizedPath;

  if (classification.decision === LIVE_CAPTURE_DECISIONS.DIRECT_ADD) {
    if (!Array.isArray(project.pendingFiles)) project.pendingFiles = [];
    const candidateKey = getTrackedFileDedupKey(fileEntry);
    project.pendingFiles = project.pendingFiles.filter(file => (
      getTrackedFileDedupKey(file) !== candidateKey &&
      normalizeTrackedFilePath(file && file.path) !== normalizedPath
    ));
    project.files.push(fileEntry);
    project.files = deduplicateFiles(project.files);
    return { ...classification, changed: true, file: fileEntry };
  }

  if (classification.decision === LIVE_CAPTURE_DECISIONS.PENDING_CANDIDATE) {
    if (!Array.isArray(project.pendingFiles)) project.pendingFiles = [];
    project.pendingFiles.push(fileEntry);
    return { ...classification, changed: true, file: fileEntry };
  }

  return { ...classification, changed: false, file: fileEntry };
}

function pruneExcludedAutoCapturedFiles(project) {
  if (!project || !Array.isArray(project.files)) return false;

  const before = project.files.length;
  project.files = project.files.filter(file => {
    if (!file || file.source === 'manual-browse' || file.source === 'manual') return true;
    return !isAutoCaptureExcludedPath(file.path);
  });
  return project.files.length !== before;
}

const FIGMA_SCOPE_CURRENT_PAGE = 'current-page';
const FIGMA_SCOPE_ENTIRE_FILE = 'entire-file';
const VALID_FIGMA_SCOPE_MODES = new Set([FIGMA_SCOPE_CURRENT_PAGE, FIGMA_SCOPE_ENTIRE_FILE]);

function getProjectFigmaScopeMode(project) {
  const projectMode = project && project.figmaScopeMode;
  if (VALID_FIGMA_SCOPE_MODES.has(projectMode)) return projectMode;

  return FIGMA_SCOPE_CURRENT_PAGE;
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

  const scopeMode = getProjectFigmaScopeMode(project);
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

const DESIGN_APP_PROCESS_IDENTITIES = Object.freeze([
  { keyword: 'Adobe Illustrator', name: 'Adobe Illustrator', appFamily: 'illustrator', bundleId: 'com.adobe.illustrator' },
  { keyword: 'Adobe Photoshop', name: 'Adobe Photoshop', appFamily: 'photoshop', bundleId: 'com.adobe.Photoshop' },
  { keyword: 'Adobe InDesign', name: 'Adobe InDesign', appFamily: 'indesign', bundleId: 'com.adobe.InDesign' },
  { keyword: 'Adobe XD', name: 'Adobe XD', appFamily: 'adobe-xd', bundleId: 'com.adobe.xd' },
  { keyword: 'Figma', name: 'Figma', appFamily: 'figma', bundleId: 'com.figma.Desktop' },
  { keyword: 'Sketch', name: 'Sketch', appFamily: 'sketch', bundleId: 'com.bohemiancoding.sketch3' },
  { keyword: 'Affinity Designer', name: 'Affinity Designer', appFamily: 'affinity-designer', bundleId: null },
  { keyword: 'Affinity Photo', name: 'Affinity Photo', appFamily: 'affinity-photo', bundleId: null },
  { keyword: 'Affinity Publisher', name: 'Affinity Publisher', appFamily: 'affinity-publisher', bundleId: null },
  { keyword: 'Pixelmator Pro', name: 'Pixelmator Pro', appFamily: 'pixelmator-pro', bundleId: 'com.pixelmator.pro' },
  { keyword: 'Acrobat', name: 'Adobe Acrobat', appFamily: 'acrobat', bundleId: null },
  { keyword: 'Keynote', name: 'Keynote', appFamily: 'keynote', bundleId: 'com.apple.iWork.Keynote' },
  { keyword: 'Microsoft PowerPoint', name: 'Microsoft PowerPoint', appFamily: 'powerpoint', bundleId: 'com.microsoft.Powerpoint' },
  { keyword: 'Visual Studio Code', name: 'Visual Studio Code', appFamily: 'vscode', bundleId: 'com.microsoft.VSCode' },
]);

function getDesignAppProcessIdentity(commandText) {
  if (typeof commandText !== 'string' || !commandText.trim()) return null;
  const match = DESIGN_APP_PROCESS_IDENTITIES.find(identity => commandText.includes(identity.keyword));
  if (!match) return null;
  return {
    name: match.name,
    appFamily: match.appFamily,
    bundleId: match.bundleId || null,
  };
}

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

function redactFigmaLogText(value) {
  let text = '';
  if (value instanceof Error) {
    text = value.message || '';
  } else if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch (e) {
      text = String(value);
    }
  }

  return text
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted-url]')
    .replace(/\bAuthorization\b\s*[:=]\s*[^,\s)]+/gi, 'Authorization=[redacted]')
    .replace(/\bBearer\s+[^\s,)]+/gi, 'Bearer [redacted]')
    .replace(/\bcookie\b\s*[:=]\s*[^,\s)]+/gi, 'cookie=[redacted]')
    .replace(/\btoken\b\s*[:=]\s*[^,\s)]+/gi, 'token=[redacted]')
    .replace(/[A-Za-z0-9._-]*(token|secret|authorization|bearer|cookie|auth)[A-Za-z0-9._-]*/gi, '[redacted-sensitive]')
    .replace(/(?:\/Users|\/Volumes|\/private\/var|\/var)\/[^\s"'<>]+/g, '[redacted-path]');
}

function formatFigmaLogScalar(value, fallback = 'unknown') {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const redacted = redactFigmaLogText(value.trim());
  if (redacted.includes('[redacted')) return fallback;
  const safe = redacted.replace(/[^\w:.-]/g, '_').slice(0, 120);
  return safe || fallback;
}

function formatFigmaLocalNameForLog(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return 'unknown';
  return redactFigmaLogText(path.basename(filePath.trim())) || 'unknown';
}

function summarizeTrackedFigmaFilesForLog(rawTrackedFiles) {
  return (Array.isArray(rawTrackedFiles) ? rawTrackedFiles : []).map((entry) => ({
    key: formatFigmaLogScalar(entry && entry.key),
    scopeMode: formatFigmaLogScalar(entry && entry.scopeMode),
    lockStatus: formatFigmaLogScalar(entry && entry.lockStatus),
    hasUrl: !!(entry && typeof entry.url === 'string' && entry.url.trim()),
    hasRequestedScope: !!(entry && (entry.requestedPageId || entry.requestedNodeId)),
    hasLockedPage: !!(entry && entry.lockedPageId),
    hasWarning: !!(entry && entry.warning),
  }));
}

function summarizeFigmaErrorsForLog(errors) {
  return (Array.isArray(errors) ? errors : [errors])
    .filter(error => error !== undefined && error !== null)
    .map(error => redactFigmaLogText(error));
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
      console.log(
        `[crate][package] skipped .fig file for current-page Figma session: ` +
        `localName=${formatFigmaLocalNameForLog(file.path)}`
      );
      continue;
    }

    if (!shouldIncludeFigmaAssetForPackaging(file, project)) {
      console.log(
        `[crate][package] filtered out-of-scope Figma asset: ` +
        `localName=${formatFigmaLocalNameForLog(file.path)} ` +
        `fileKey=${formatFigmaLogScalar(file.figmaFileKey)} hasPageId=${!!file.figmaPageId}`
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
      namingTemplate: DEFAULT_NAMING_TEMPLATE,
      notifications: true,
      includeDiagnosticReport: false,
      showPackageDetails: true
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
  let namingTemplate = settings.namingTemplate;
  if (settings.namingTemplate && settings.namingTemplate.includes('{Client}')) {
    namingTemplate = DEFAULT_NAMING_TEMPLATE;
    store.set('settings.namingTemplate', namingTemplate);
  }
  const safeNamingTemplate = sanitizeNamingTemplate(namingTemplate);
  if (safeNamingTemplate !== namingTemplate) {
    store.set('settings.namingTemplate', safeNamingTemplate);
  }
  if (settings.includeDiagnosticReport === undefined) {
    store.set('settings.includeDiagnosticReport', false);
  }
  if (settings.showPackageDetails === undefined) {
    store.set('settings.showPackageDetails', true);
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

function recordLsofAppOpenedFile(project, fileEntry, processContext = {}) {
  try {
    if (!project || !fileEntry || typeof fileEntry.path !== 'string' || !fileEntry.path.trim()) return;

    const pid = Number.parseInt(processContext.pid, 10);
    if (!Number.isInteger(pid) || pid <= 0) return;

    const appIdentity = getDesignAppProcessIdentity(processContext.command || '');
    if (!appIdentity) return;

    const provenance = ensureProjectProvenance(project);
    if (!provenance) return;

    const normalizedPath = normalizeTrackedFilePath(fileEntry.path);
    if (!normalizedPath) return;

    const method = typeof processContext.method === 'string' && processContext.method.trim()
      ? processContext.method.trim()
      : 'unknown';
    const observedAt = fileEntry.addedAt || Date.now();
    const sessionId = getProjectProvenanceSessionId(project, provenance);
    const appNodeId = createNodeId(NODE_TYPES.APP, {
      bundleId: appIdentity.bundleId,
      name: appIdentity.name,
      appFamily: appIdentity.appFamily,
    });
    const processNodeId = createNodeId(NODE_TYPES.APP_PROCESS, {
      sessionId,
      pid,
      appNodeId,
    });
    const fileNodeId = createNodeId(NODE_TYPES.FILE, { normalizedPath });

    provenance.nodes[appNodeId] = {
      ...(provenance.nodes[appNodeId] || {}),
      id: appNodeId,
      type: NODE_TYPES.APP,
      bundleId: appIdentity.bundleId,
      name: appIdentity.name,
      appFamily: appIdentity.appFamily,
    };

    const existingProcessNode = provenance.nodes[processNodeId] || {};
    const existingFirstAt = typeof existingProcessNode.observedFirstAt === 'number'
      ? existingProcessNode.observedFirstAt
      : observedAt;
    const existingLastAt = typeof existingProcessNode.observedLastAt === 'number'
      ? existingProcessNode.observedLastAt
      : observedAt;
    provenance.nodes[processNodeId] = {
      ...existingProcessNode,
      id: processNodeId,
      type: NODE_TYPES.APP_PROCESS,
      appNodeId,
      pid,
      appName: appIdentity.name,
      appFamily: appIdentity.appFamily,
      observedFirstAt: Math.min(existingFirstAt, observedAt),
      observedLastAt: Math.max(existingLastAt, observedAt),
      source: OBSERVER_KINDS.LSOF,
      method,
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

    const evidence = upsertEvidence(provenance, {
      kind: OBSERVER_KINDS.LSOF,
      observer: {
        kind: OBSERVER_KINDS.LSOF,
        method,
        pid,
        appName: appIdentity.name,
        appFamily: appIdentity.appFamily,
      },
      observedAt,
      identity: {
        projectId: project.id || null,
        sessionId,
        method,
        pid,
        normalizedPath,
      },
      summary: 'lsof observed a monitored app process with an accepted file path',
      payload: {
        source: fileEntry.source || null,
        method,
        pid,
        appName: appIdentity.name,
        appFamily: appIdentity.appFamily,
      },
    });

    const dedupeKey = createDedupeKey(
      project.id || 'unknown_project',
      sessionId,
      method,
      EDGE_TYPES.APP_OPENED_FILE,
      pid,
      normalizedPath
    );
    const observation = createObservationRecord({
      projectId: project.id || null,
      sessionId,
      observedAt,
      observer: {
        kind: OBSERVER_KINDS.LSOF,
        method,
        pid,
        appName: appIdentity.name,
        appFamily: appIdentity.appFamily,
      },
      kind: EDGE_TYPES.APP_OPENED_FILE,
      subjectNodeId: processNodeId,
      objectNodeId: fileNodeId,
      relationType: EDGE_TYPES.APP_OPENED_FILE,
      evidenceIds: evidence && evidence.id ? [evidence.id] : [],
      confidence: createConfidence(
        CONFIDENCE_BANDS.CANDIDATE,
        'lsof observed a monitored app process with an accepted file path'
      ),
      dedupeKey,
      payload: {
        source: fileEntry.source || null,
        method,
        pid,
        appName: appIdentity.name,
        appFamily: appIdentity.appFamily,
      },
    });
    appendObservation(provenance, observation);
  } catch (e) {
    console.warn('[crate][provenance] app_opened_file skipped:', e.message);
  }
}

function recordLsofAcceptedFileProvenance(project, fileEntry, processContext = {}) {
  recordSessionObservedFile(project, fileEntry, {
    kind: OBSERVER_KINDS.LSOF,
    method: typeof processContext.method === 'string' && processContext.method.trim()
      ? processContext.method.trim()
      : 'unknown',
  });
  recordLsofAppOpenedFile(project, fileEntry, processContext);
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
    const observerRecord = isRecord(observer) ? observer : {};
    const observerPayload = isRecord(observerRecord.payload) ? observerRecord.payload : null;
    const { payload: _ignoredObserverPayload, ...observerFields } = observerRecord;
    const method = typeof observerRecord.method === 'string' && observerRecord.method.trim()
      ? observerRecord.method.trim()
      : 'unknown';
    const observerKind = typeof observerRecord.kind === 'string' && observerRecord.kind.trim()
      ? observerRecord.kind.trim()
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
        ...observerFields,
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
        ...(observerPayload || {}),
      },
    });
    appendObservation(provenance, observation);
  } catch (e) {
    console.warn('[crate][provenance] session_observed_file skipped:', e.message);
  }
}

const PRE_PACKAGE_RECOVERY_PROVENANCE_SOURCES = new Set([
  'lsof-package-scan',
  'ai-linked',
  'psd-linked',
  'psd-embedded',
  'indd-linked',
  'linked-asset',
  'pre-package-doublecheck',
]);

function recordPrePackageRecoverySessionObservation(project, fileEntry) {
  const source = fileEntry && fileEntry.source;
  if (!PRE_PACKAGE_RECOVERY_PROVENANCE_SOURCES.has(source)) return;

  recordSessionObservedFile(project, fileEntry, {
    kind: OBSERVER_KINDS.PACKAGE_RECOVERY,
    method: source,
    payload: {
      method: source,
      channel: 'pre-package-scan',
      recoveryType: 'package-time-recovery',
    },
  });
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

function getSafeFigmaAssetKey(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  if (trimmed.includes('://')) return null;
  return trimmed;
}

function getFigmaResourceIdentity(asset = {}, fileEntry = {}) {
  const imageRef = typeof asset.imageRef === 'string' && asset.imageRef.trim()
    ? asset.imageRef.trim()
    : null;
  const nodeId = typeof asset.nodeId === 'string' && asset.nodeId.trim()
    ? asset.nodeId.trim()
    : null;
  const resourceKey = imageRef || nodeId;
  if (!resourceKey) return null;

  return {
    resourceKey,
    resourceKind: imageRef ? 'imageRef' : 'node',
    figmaAssetKey: getSafeFigmaAssetKey(fileEntry.figmaAssetKey || asset.figmaAssetKey || null),
  };
}

function recordFigmaAssetProvenance(project, fileEntry, asset = {}, contextLabel = 'scan') {
  try {
    if (!project || !fileEntry || typeof fileEntry.path !== 'string' || !fileEntry.path.trim()) return;
    const provenance = ensureProjectProvenance(project);
    if (!provenance) return;

    const normalizedPath = normalizeTrackedFilePath(fileEntry.path);
    if (!normalizedPath) return;

    const figmaFileKey = typeof fileEntry.figmaFileKey === 'string' && fileEntry.figmaFileKey.trim()
      ? fileEntry.figmaFileKey.trim()
      : (typeof asset.figmaFileKey === 'string' && asset.figmaFileKey.trim()
        ? asset.figmaFileKey.trim()
        : (typeof asset.fileKey === 'string' && asset.fileKey.trim() ? asset.fileKey.trim() : null));
    if (!figmaFileKey) return;

    const resource = getFigmaResourceIdentity(asset, fileEntry);
    if (!resource) return;

    const sessionId = getProjectProvenanceSessionId(project, provenance);
    const figmaFileName = fileEntry.figmaFileName || asset.figmaFileName || null;
    const figmaPageId = fileEntry.figmaPageId || asset.figmaPageId || null;
    const figmaPageName = fileEntry.figmaPageName || asset.figmaPageName || null;
    const figmaScopeMode = fileEntry.figmaScopeMode || asset.figmaScopeMode || null;
    const cloudDocumentNodeId = createNodeId(NODE_TYPES.CLOUD_DOCUMENT, {
      provider: 'figma',
      fileKey: figmaFileKey,
      pageId: figmaPageId,
      scopeMode: figmaScopeMode,
    });
    const resourceNodeId = createNodeId(NODE_TYPES.EMBEDDED_RESOURCE, {
      provider: 'figma',
      fileKey: figmaFileKey,
      resourceKey: resource.resourceKey,
    });
    const fileNodeId = createNodeId(NODE_TYPES.FILE, { normalizedPath });

    provenance.nodes[cloudDocumentNodeId] = {
      ...(provenance.nodes[cloudDocumentNodeId] || {}),
      id: cloudDocumentNodeId,
      type: NODE_TYPES.CLOUD_DOCUMENT,
      provider: 'figma',
      fileKey: figmaFileKey,
      name: figmaFileName,
      pageId: figmaPageId,
      pageName: figmaPageName,
      scopeMode: figmaScopeMode,
      lockStatus: null,
      projectId: project.id || null,
    };
    provenance.nodes[resourceNodeId] = {
      ...(provenance.nodes[resourceNodeId] || {}),
      id: resourceNodeId,
      type: NODE_TYPES.EMBEDDED_RESOURCE,
      provider: 'figma',
      resourceKey: resource.resourceKey,
      resourceKind: resource.resourceKind,
      figmaAssetKey: resource.figmaAssetKey,
      cloudDocumentNodeId,
      name: asset.name || fileEntry.name || null,
      ext: fileEntry.ext || path.extname(fileEntry.path).toLowerCase(),
      sourceMetadata: {
        source: fileEntry.source || null,
        figmaFileKey,
        figmaFileName,
        figmaPageId,
        figmaPageName,
        figmaScopeMode,
      },
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

    const evidence = upsertEvidence(provenance, {
      kind: OBSERVER_KINDS.FIGMA_API,
      observer: {
        kind: OBSERVER_KINDS.FIGMA_API,
        method: 'asset-download',
        context: contextLabel || 'scan',
      },
      observedAt: fileEntry.addedAt || Date.now(),
      identity: {
        projectId: project.id || null,
        figmaFileKey,
        resourceKey: resource.resourceKey,
        normalizedPath,
      },
      summary: 'Figma API asset was downloaded and added to the project file ledger',
      payload: {
        figmaFileKey,
        figmaFileName,
        figmaPageId,
        figmaPageName,
        figmaScopeMode,
        resourceKey: resource.resourceKey,
        resourceKind: resource.resourceKind,
        figmaAssetKey: resource.figmaAssetKey,
        localPath: fileEntry.path,
        context: contextLabel || 'scan',
      },
    });

    const dedupeKey = createDedupeKey(
      project.id || 'unknown_project',
      sessionId,
      figmaFileKey,
      resource.resourceKey,
      normalizedPath,
      EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE
    );
    const edgeId = createEdgeId(EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE, resourceNodeId, fileNodeId, dedupeKey);
    provenance.edges[edgeId] = {
      ...(provenance.edges[edgeId] || {}),
      id: edgeId,
      type: EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE,
      relationType: EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE,
      subjectNodeId: resourceNodeId,
      objectNodeId: fileNodeId,
      confidence: createConfidence(CONFIDENCE_BANDS.CONFIRMED, 'Figma API asset download succeeded and file ledger was updated'),
      evidenceIds: evidence && evidence.id ? [evidence.id] : [],
      dedupeKey,
      payload: {
        observer: {
          kind: OBSERVER_KINDS.FIGMA_API,
          method: 'asset-download',
          context: contextLabel || 'scan',
        },
        source: fileEntry.source || null,
        figmaFileKey,
        figmaFileName,
        figmaPageId,
        figmaPageName,
        figmaScopeMode,
        resourceKey: resource.resourceKey,
        resourceKind: resource.resourceKind,
        figmaAssetKey: resource.figmaAssetKey,
        localPath: fileEntry.path,
      },
    };
  } catch (e) {
    console.warn('[crate][provenance] Figma asset provenance skipped:', redactFigmaLogText(e.message));
  }
}

function upsertPsdParserContainerNode(provenance, project, psdFilePath) {
  const normalizedPath = normalizeTrackedFilePath(psdFilePath);
  if (!normalizedPath) return null;

  const fileNodeId = createNodeId(NODE_TYPES.FILE, { normalizedPath });
  const containerNodeId = createNodeId(NODE_TYPES.CONTAINER, { normalizedPath });

  provenance.nodes[fileNodeId] = {
    ...(provenance.nodes[fileNodeId] || {}),
    id: fileNodeId,
    type: NODE_TYPES.FILE,
    path: psdFilePath,
    normalizedPath,
    name: path.basename(psdFilePath),
    ext: path.extname(psdFilePath).toLowerCase(),
  };
  provenance.nodes[containerNodeId] = {
    ...(provenance.nodes[containerNodeId] || {}),
    id: containerNodeId,
    type: NODE_TYPES.CONTAINER,
    fileNodeId,
    path: psdFilePath,
    normalizedPath,
    format: path.extname(psdFilePath).toLowerCase().replace(/^\./, ''),
    appFamily: 'photoshop',
    containerKind: 'psd',
    projectId: project.id || null,
  };

  return { containerNodeId, normalizedPath };
}

function upsertPsdParserLinkedFileNode(provenance, fileEntry) {
  const normalizedPath = normalizeTrackedFilePath(fileEntry.path);
  if (!normalizedPath) return null;

  const fileNodeId = createNodeId(NODE_TYPES.FILE, { normalizedPath });
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
  return { fileNodeId, normalizedPath };
}

function upsertPsdParserEmbeddedResourceNode(provenance, psdFilePath, fileEntry) {
  const parentPsd = normalizeTrackedFilePath(fileEntry.parentPsd || psdFilePath || fileEntry.path);
  if (!parentPsd) return null;

  const resourceKey = createDedupeKey(
    'scan-on-save-psd',
    parentPsd,
    Number.isInteger(fileEntry.embeddedIndex) ? fileEntry.embeddedIndex : '',
    fileEntry.embeddedOriginalName || fileEntry.name || ''
  );
  const resourceNodeId = createNodeId(NODE_TYPES.EMBEDDED_RESOURCE, { resourceKey });
  provenance.nodes[resourceNodeId] = {
    ...(provenance.nodes[resourceNodeId] || {}),
    id: resourceNodeId,
    type: NODE_TYPES.EMBEDDED_RESOURCE,
    resourceKey,
    name: fileEntry.name || fileEntry.embeddedOriginalName || null,
    ext: fileEntry.ext || path.extname(fileEntry.name || '').toLowerCase(),
    sourceMetadata: {
      source: fileEntry.source || null,
      parentPsd: fileEntry.parentPsd || psdFilePath || fileEntry.path || null,
      embeddedIndex: Number.isInteger(fileEntry.embeddedIndex) ? fileEntry.embeddedIndex : null,
      embeddedOriginalName: fileEntry.embeddedOriginalName || null,
    },
  };
  return { resourceNodeId, resourceKey };
}

function recordPsdParserRelationship(project, psdFilePath, fileEntry) {
  try {
    if (!project || !psdFilePath || !fileEntry) return;
    const provenance = ensureProjectProvenance(project);
    if (!provenance) return;

    const parserMethod = 'scan-on-save';
    const parserName = 'ag-psd';
    const sessionId = getProjectProvenanceSessionId(project, provenance);
    const container = upsertPsdParserContainerNode(provenance, project, psdFilePath);
    if (!container) return;

    const relationType = fileEntry.source === 'scan-on-save-linked'
      ? EDGE_TYPES.CONTAINER_REFERENCES_FILE
      : (fileEntry.source === 'scan-on-save-embedded' && fileEntry.embedded
        ? EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE
        : null);
    if (!relationType) return;

    const object = relationType === EDGE_TYPES.CONTAINER_REFERENCES_FILE
      ? upsertPsdParserLinkedFileNode(provenance, fileEntry)
      : upsertPsdParserEmbeddedResourceNode(provenance, psdFilePath, fileEntry);
    if (!object) return;

    const objectNodeId = relationType === EDGE_TYPES.CONTAINER_REFERENCES_FILE
      ? object.fileNodeId
      : object.resourceNodeId;
    const objectIdentity = relationType === EDGE_TYPES.CONTAINER_REFERENCES_FILE
      ? object.normalizedPath
      : object.resourceKey;
    if (!objectNodeId || !objectIdentity) return;

    const dedupeKey = createDedupeKey(
      project.id || 'unknown_project',
      sessionId,
      parserName,
      parserMethod,
      relationType,
      container.normalizedPath,
      objectIdentity
    );
    const edgeId = createEdgeId(relationType, container.containerNodeId, objectNodeId, dedupeKey);
    provenance.edges[edgeId] = {
      ...(provenance.edges[edgeId] || {}),
      id: edgeId,
      type: relationType,
      relationType,
      subjectNodeId: container.containerNodeId,
      objectNodeId,
      confidence: createConfidence(CONFIDENCE_BANDS.CONFIRMED, 'PSD parser returned structured smart object metadata'),
      evidenceIds: [],
      dedupeKey,
      payload: {
        observer: {
          kind: OBSERVER_KINDS.PARSER,
          parser: parserName,
          method: parserMethod,
        },
        parser: parserName,
        method: parserMethod,
        source: fileEntry.source || null,
        containerPath: psdFilePath,
        embeddedIndex: Number.isInteger(fileEntry.embeddedIndex) ? fileEntry.embeddedIndex : null,
        embeddedOriginalName: fileEntry.embeddedOriginalName || null,
      },
    };
  } catch (e) {
    console.warn('[crate][provenance] PSD parser relationship skipped:', e.message);
  }
}

function isPowerPointPresentationPath(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  return ext === '.pptx' || ext === '.ppt';
}

function isKeynotePresentationPath(filePath) {
  return path.extname(filePath || '').toLowerCase() === '.key';
}

function getPresentationMediaFormatInfo(presentationPath, internalPath) {
  if (isPowerPointPresentationPath(presentationPath)) {
    if (typeof internalPath !== 'string' || !internalPath.startsWith('ppt/media/')) return null;
    return {
      appFamily: 'powerpoint',
      formatLabel: 'PowerPoint',
      mediaPrefix: 'ppt/media',
      parserName: 'powerpoint-zip-media',
      resourceKeyPrefix: 'powerpoint-media',
    };
  }

  if (isKeynotePresentationPath(presentationPath)) {
    if (typeof internalPath !== 'string' || !internalPath.startsWith('Data/')) return null;
    return {
      appFamily: 'keynote',
      formatLabel: 'Keynote',
      mediaPrefix: 'Data',
      parserName: 'keynote-zip-media',
      resourceKeyPrefix: 'keynote-media',
    };
  }

  return null;
}

function getPresentationMediaResourceIdentity(presentationPath, internalPath) {
  const formatInfo = getPresentationMediaFormatInfo(presentationPath, internalPath);
  if (!formatInfo) return null;

  const normalizedContainerPath = normalizeTrackedFilePath(presentationPath);
  if (!normalizedContainerPath) return null;

  const resourceKey = createDedupeKey(formatInfo.resourceKeyPrefix, normalizedContainerPath, internalPath);
  return {
    ...formatInfo,
    resourceKey,
    normalizedContainerPath,
    internalPath,
    name: path.basename(internalPath),
    ext: path.extname(internalPath).toLowerCase(),
  };
}

function getPowerPointMediaResourceIdentity(presentationPath, internalPath) {
  const resource = getPresentationMediaResourceIdentity(presentationPath, internalPath);
  return resource && resource.appFamily === 'powerpoint' ? resource : null;
}

function upsertPresentationContainerNode(provenance, project, presentationPath) {
  const normalizedPath = normalizeTrackedFilePath(presentationPath);
  if (!normalizedPath) return null;

  const ext = path.extname(presentationPath).toLowerCase();
  const fileNodeId = createNodeId(NODE_TYPES.FILE, { normalizedPath });
  const containerNodeId = createNodeId(NODE_TYPES.CONTAINER, { normalizedPath });
  provenance.nodes[fileNodeId] = {
    ...(provenance.nodes[fileNodeId] || {}),
    id: fileNodeId,
    type: NODE_TYPES.FILE,
    path: presentationPath,
    normalizedPath,
    name: path.basename(presentationPath),
    ext: path.extname(presentationPath).toLowerCase(),
  };
  provenance.nodes[containerNodeId] = {
    ...(provenance.nodes[containerNodeId] || {}),
    id: containerNodeId,
    type: NODE_TYPES.CONTAINER,
    fileNodeId,
    path: presentationPath,
    normalizedPath,
    format: ext.replace(/^\./, ''),
    appFamily: ext === '.key' ? 'keynote' : 'powerpoint',
    containerKind: 'presentation',
    projectId: project.id || null,
  };

  return { containerNodeId, normalizedPath };
}

function upsertPresentationEmbeddedResourceNode(provenance, extraction) {
  const resource = getPresentationMediaResourceIdentity(extraction.presentationPath, extraction.internalPath);
  if (!resource) return null;

  const resourceNodeId = createNodeId(NODE_TYPES.EMBEDDED_RESOURCE, { resourceKey: resource.resourceKey });
  provenance.nodes[resourceNodeId] = {
    ...(provenance.nodes[resourceNodeId] || {}),
    id: resourceNodeId,
    type: NODE_TYPES.EMBEDDED_RESOURCE,
    resourceKey: resource.resourceKey,
    name: resource.name,
    ext: resource.ext,
    sourceMetadata: {
      source: extraction.source || null,
      containerPath: extraction.presentationPath || null,
      internalPath: resource.internalPath,
      materializedFileName: extraction.materializedPath ? path.basename(extraction.materializedPath) : null,
    },
  };
  return { resourceNodeId, ...resource };
}

function upsertMaterializedPackageFileNode(provenance, filePath, source = null) {
  const normalizedPath = normalizeTrackedFilePath(filePath);
  if (!normalizedPath) return null;

  const fileNodeId = createNodeId(NODE_TYPES.FILE, { normalizedPath });
  provenance.nodes[fileNodeId] = {
    ...(provenance.nodes[fileNodeId] || {}),
    id: fileNodeId,
    type: NODE_TYPES.FILE,
    path: filePath,
    normalizedPath,
    name: path.basename(filePath),
    ext: path.extname(filePath).toLowerCase(),
    source,
  };
  return { fileNodeId, normalizedPath };
}

function recordPresentationMediaExtractionProvenanceForProject(project, extractionEvents = []) {
  try {
    if (!project || !Array.isArray(extractionEvents) || extractionEvents.length === 0) return;
    const provenance = ensureProjectProvenance(project);
    if (!provenance) return;

    const sessionId = getProjectProvenanceSessionId(project, provenance);
    for (const extraction of extractionEvents) {
      if (!extraction || !extraction.materializedPath) continue;

      const container = upsertPresentationContainerNode(provenance, project, extraction.presentationPath);
      const resource = upsertPresentationEmbeddedResourceNode(provenance, extraction);
      const materializedFile = upsertMaterializedPackageFileNode(
        provenance,
        extraction.materializedPath,
        extraction.source || null
      );
      if (!container || !resource || !materializedFile) continue;

      const method = extraction.source === 'scan-on-save-presentation'
        ? 'scan-on-save'
        : 'package-extraction';
      const evidenceSummary = resource.appFamily === 'powerpoint'
        ? 'PowerPoint embedded media was extracted and written to a package file'
        : 'Keynote embedded media was extracted and written to a file';
      const evidence = upsertEvidence(provenance, {
        kind: OBSERVER_KINDS.PARSER,
        observer: {
          kind: OBSERVER_KINDS.PARSER,
          parser: resource.parserName,
          method,
        },
        observedAt: extraction.observedAt || Date.now(),
        identity: {
          projectId: project.id || null,
          sessionId,
          containerPath: extraction.presentationPath,
          internalPath: resource.internalPath,
          materializedPath: extraction.materializedPath,
        },
        summary: evidenceSummary,
        payload: {
          source: extraction.source || null,
          containerPath: extraction.presentationPath,
          internalPath: resource.internalPath,
          materializedFileName: path.basename(extraction.materializedPath),
        },
      });
      const evidenceIds = evidence && evidence.id ? [evidence.id] : [];

      const embedsDedupeKey = createDedupeKey(
        project.id || 'unknown_project',
        sessionId,
        resource.parserName,
        EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE,
        container.normalizedPath,
        resource.internalPath
      );
      const embedsEdgeId = createEdgeId(
        EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE,
        container.containerNodeId,
        resource.resourceNodeId,
        embedsDedupeKey
      );
      provenance.edges[embedsEdgeId] = {
        ...(provenance.edges[embedsEdgeId] || {}),
        id: embedsEdgeId,
        type: EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE,
        relationType: EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE,
        subjectNodeId: container.containerNodeId,
        objectNodeId: resource.resourceNodeId,
        confidence: createConfidence(CONFIDENCE_BANDS.CONFIRMED, `${resource.formatLabel} archive listed the media resource under ${resource.mediaPrefix}`),
        evidenceIds,
        dedupeKey: embedsDedupeKey,
        payload: {
          observer: {
            kind: OBSERVER_KINDS.PARSER,
            parser: resource.parserName,
            method,
          },
          source: extraction.source || null,
          containerPath: extraction.presentationPath,
          internalPath: resource.internalPath,
        },
      };

      const materializedDedupeKey = createDedupeKey(
        project.id || 'unknown_project',
        sessionId,
        resource.parserName,
        EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE,
        resource.resourceKey,
        materializedFile.normalizedPath
      );
      const materializedEdgeId = createEdgeId(
        EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE,
        resource.resourceNodeId,
        materializedFile.fileNodeId,
        materializedDedupeKey
      );
      provenance.edges[materializedEdgeId] = {
        ...(provenance.edges[materializedEdgeId] || {}),
        id: materializedEdgeId,
        type: EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE,
        relationType: EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE,
        subjectNodeId: resource.resourceNodeId,
        objectNodeId: materializedFile.fileNodeId,
        confidence: createConfidence(CONFIDENCE_BANDS.CONFIRMED, `${resource.formatLabel} media resource was written to disk`),
        evidenceIds,
        dedupeKey: materializedDedupeKey,
        payload: {
          observer: {
            kind: OBSERVER_KINDS.PARSER,
            parser: resource.parserName,
            method,
          },
          source: extraction.source || null,
          internalPath: resource.internalPath,
          materializedFileName: path.basename(extraction.materializedPath),
        },
      };
    }
  } catch (e) {
    console.warn('[crate][provenance] presentation media provenance skipped:', e.message);
  }
}

function recordPowerPointMediaExtractionProvenanceForProject(project, extractionEvents = []) {
  recordPresentationMediaExtractionProvenanceForProject(project, extractionEvents);
}

function recordPresentationMediaExtractionProvenance(projectId, extractionEvents = []) {
  try {
    if (!Array.isArray(extractionEvents) || extractionEvents.length === 0) return;
    mutateProject(projectId, (project) => {
      recordPresentationMediaExtractionProvenanceForProject(project, extractionEvents);
      return null;
    });
  } catch (e) {
    console.warn('[crate][provenance] presentation media provenance skipped:', e.message);
  }
}

function recordPowerPointMediaExtractionProvenance(projectId, extractionEvents = []) {
  recordPresentationMediaExtractionProvenance(projectId, extractionEvents);
}

function upsertPackageNode(provenance, project, packageInfo) {
  const packageNodeId = createNodeId(NODE_TYPES.PACKAGE, {
    projectId: project.id || null,
    path: packageInfo.destFolder,
    createdAt: packageInfo.createdAt,
  });
  provenance.nodes[packageNodeId] = {
    ...(provenance.nodes[packageNodeId] || {}),
    id: packageNodeId,
    type: NODE_TYPES.PACKAGE,
    projectId: project.id || null,
    sessionId: getProjectProvenanceSessionId(project, provenance),
    path: packageInfo.destFolder,
    createdAt: packageInfo.createdAt,
  };
  return packageNodeId;
}

function upsertPackageSourceFileNode(provenance, fileEntry) {
  const normalizedPath = normalizeTrackedFilePath(fileEntry.path);
  if (!normalizedPath) return null;
  const fileNodeId = createNodeId(NODE_TYPES.FILE, { normalizedPath });
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
  return fileNodeId;
}

function upsertPackageEmbeddedResourceNode(provenance, fileEntry) {
  const parentPsd = normalizeTrackedFilePath(fileEntry.parentPsd || fileEntry.path);
  const resourceKey = createDedupeKey(
    'scan-on-save-psd',
    parentPsd,
    Number.isInteger(fileEntry.embeddedIndex) ? fileEntry.embeddedIndex : '',
    fileEntry.embeddedOriginalName || fileEntry.name || ''
  );
  const resourceNodeId = createNodeId(NODE_TYPES.EMBEDDED_RESOURCE, { resourceKey });
  provenance.nodes[resourceNodeId] = {
    ...(provenance.nodes[resourceNodeId] || {}),
    id: resourceNodeId,
    type: NODE_TYPES.EMBEDDED_RESOURCE,
    resourceKey,
    name: fileEntry.name || fileEntry.embeddedOriginalName || null,
    ext: fileEntry.ext || path.extname(fileEntry.name || '').toLowerCase(),
    sourceMetadata: {
      source: fileEntry.source || null,
      parentPsd: fileEntry.parentPsd || fileEntry.path || null,
      embeddedIndex: Number.isInteger(fileEntry.embeddedIndex) ? fileEntry.embeddedIndex : null,
      embeddedOriginalName: fileEntry.embeddedOriginalName || null,
    },
  };
  return resourceNodeId;
}

function upsertPackagePresentationResourceNode(provenance, resource = {}) {
  if (typeof resource.resourceKey !== 'string' || !resource.resourceKey.trim()) return null;

  const resourceNodeId = createNodeId(NODE_TYPES.EMBEDDED_RESOURCE, { resourceKey: resource.resourceKey });
  provenance.nodes[resourceNodeId] = {
    ...(provenance.nodes[resourceNodeId] || {}),
    id: resourceNodeId,
    type: NODE_TYPES.EMBEDDED_RESOURCE,
    resourceKey: resource.resourceKey,
    name: resource.name || (resource.internalPath ? path.basename(resource.internalPath) : null),
    ext: resource.ext || path.extname(resource.internalPath || '').toLowerCase(),
    sourceMetadata: {
      source: resource.source || null,
      containerPath: resource.presentationPath || null,
      internalPath: resource.internalPath || null,
      materializedFileName: resource.materializedPath ? path.basename(resource.materializedPath) : null,
    },
  };
  return resourceNodeId;
}

function recordPackageProvenance(projectId, packageInfo, events = []) {
  try {
    if (!Array.isArray(events) || events.length === 0) return;
    mutateProject(projectId, (project) => {
      const provenance = ensureProjectProvenance(project);
      if (!provenance) return null;
      const packageNodeId = upsertPackageNode(provenance, project, packageInfo);

      for (const event of events) {
        const relationType = event && event.relationType;
        if (relationType !== EDGE_TYPES.PACKAGE_INCLUDES_FILE && relationType !== EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE) {
          continue;
        }

        const objectNodeId = relationType === EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE
          ? (event.resource
            ? upsertPackagePresentationResourceNode(provenance, event.resource)
            : upsertPackageEmbeddedResourceNode(provenance, event.file))
          : upsertPackageSourceFileNode(provenance, event.file);
        if (!objectNodeId) continue;

        const dedupeKey = createDedupeKey(
          project.id || 'unknown_project',
          packageNodeId,
          relationType,
          event.outputPath || '',
          event.resource && event.resource.resourceKey
            ? event.resource.resourceKey
            : (event.file && (event.file.fileId || event.file.path || event.file.name))
        );
        const edgeId = createEdgeId(relationType, packageNodeId, objectNodeId, dedupeKey);
        const payload = {
          outputPath: event.outputPath || null,
          source: event.resource && event.resource.source
            ? event.resource.source
            : (event.file && event.file.source ? event.file.source : null),
        };
        if (event.resource && event.resource.internalPath) {
          payload.internalPath = event.resource.internalPath;
        }

        provenance.edges[edgeId] = {
          ...(provenance.edges[edgeId] || {}),
          id: edgeId,
          type: relationType,
          relationType,
          subjectNodeId: packageNodeId,
          objectNodeId,
          confidence: createConfidence(CONFIDENCE_BANDS.CONFIRMED, 'package operation succeeded'),
          evidenceIds: [],
          dedupeKey,
          payload,
        };
      }
      return null;
    });
  } catch (e) {
    console.warn('[crate][provenance] package provenance skipped:', e.message);
  }
}

function getCrateVersion() {
  try {
    if (app && typeof app.getVersion === 'function') return app.getVersion();
  } catch (e) {}

  try {
    const packageJson = require('./package.json');
    return typeof packageJson.version === 'string' ? packageJson.version : null;
  } catch (e) {
    return null;
  }
}

function normalizeManifestPathString(value) {
  if (typeof value !== 'string' || value.length === 0) return value;

  const homeDir = os.homedir().replace(/\/+$/, '');
  if (!homeDir) return value;

  const normalizedValue = value.replace(/\\/g, '/');
  const normalizedHome = homeDir.replace(/\\/g, '/');
  const lowerValue = normalizedValue.toLowerCase();
  const lowerHome = normalizedHome.toLowerCase();

  if (lowerValue === lowerHome) return '~';
  if (lowerValue.startsWith(`${lowerHome}/`)) {
    return `~/${normalizedValue.slice(normalizedHome.length + 1)}`;
  }

  return normalizedValue
    .split(normalizedHome)
    .join('~')
    .split(lowerHome)
    .join('~');
}

function isSensitiveManifestKey(key = '') {
  const lowerKey = key.toLowerCase();
  return (
    lowerKey.includes('token') ||
    lowerKey.includes('secret') ||
    lowerKey.includes('apikey') ||
    lowerKey.includes('api_key') ||
    lowerKey.includes('command') ||
    lowerKey.includes('raw') ||
    lowerKey.includes('stdout') ||
    lowerKey.includes('stderr') ||
    lowerKey.includes('apiresponse') ||
    lowerKey.includes('api_response')
  );
}

function sanitizeManifestValue(value, key = '') {
  if (isSensitiveManifestKey(key)) {
    return '[redacted]';
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizeManifestValue(item));
  }

  if (value && typeof value === 'object') {
    const sanitized = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      sanitized[childKey] = sanitizeManifestValue(childValue, childKey);
    }
    return sanitized;
  }

  if (typeof value !== 'string') return value;

  return normalizeManifestPathString(value);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sortedManifestRecords(recordsById) {
  return Object.values(recordsById)
    .filter(isRecord)
    .sort((a, b) => `${a.id || ''}`.localeCompare(`${b.id || ''}`));
}

function collectPackageManifestGraph(provenance, packageNodeId, warnings) {
  const nodes = isRecord(provenance && provenance.nodes) ? provenance.nodes : {};
  const edges = isRecord(provenance && provenance.edges) ? provenance.edges : {};
  const evidence = isRecord(provenance && provenance.evidence) ? provenance.evidence : {};
  const includedEdges = {};
  const includedNodes = {};
  const includedEvidence = {};
  const packagedObjectNodeIds = new Set();

  if (nodes[packageNodeId]) {
    includedNodes[packageNodeId] = nodes[packageNodeId];
  }

  for (const edge of Object.values(edges)) {
    if (!edge || edge.subjectNodeId !== packageNodeId) continue;
    if (
      edge.relationType !== EDGE_TYPES.PACKAGE_INCLUDES_FILE &&
      edge.relationType !== EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE
    ) {
      continue;
    }
    includedEdges[edge.id] = edge;
    if (edge.objectNodeId) packagedObjectNodeIds.add(edge.objectNodeId);
  }

  for (const edge of Object.values(edges)) {
    if (!edge || includedEdges[edge.id]) continue;
    if (
      edge.relationType !== EDGE_TYPES.CONTAINER_REFERENCES_FILE &&
      edge.relationType !== EDGE_TYPES.CONTAINER_EMBEDS_RESOURCE
    ) {
      continue;
    }
    if (!packagedObjectNodeIds.has(edge.objectNodeId)) continue;
    includedEdges[edge.id] = edge;
  }

  for (const edge of Object.values(edges)) {
    if (!edge || includedEdges[edge.id]) continue;
    if (edge.relationType !== EDGE_TYPES.RESOURCE_MATERIALIZED_AS_FILE) continue;
    if (!packagedObjectNodeIds.has(edge.objectNodeId) && !packagedObjectNodeIds.has(edge.subjectNodeId)) continue;
    includedEdges[edge.id] = edge;
  }

  for (const edge of Object.values(includedEdges)) {
    if (edge.subjectNodeId && nodes[edge.subjectNodeId]) includedNodes[edge.subjectNodeId] = nodes[edge.subjectNodeId];
    if (edge.objectNodeId && nodes[edge.objectNodeId]) includedNodes[edge.objectNodeId] = nodes[edge.objectNodeId];
    for (const evidenceId of Array.isArray(edge.evidenceIds) ? edge.evidenceIds : []) {
      if (evidence[evidenceId]) includedEvidence[evidenceId] = evidence[evidenceId];
    }
  }

  for (const node of Object.values(includedNodes)) {
    if (node && node.type === NODE_TYPES.CONTAINER && node.fileNodeId && nodes[node.fileNodeId]) {
      includedNodes[node.fileNodeId] = nodes[node.fileNodeId];
    }
    if (node && node.type === NODE_TYPES.EMBEDDED_RESOURCE && node.cloudDocumentNodeId && nodes[node.cloudDocumentNodeId]) {
      includedNodes[node.cloudDocumentNodeId] = nodes[node.cloudDocumentNodeId];
    }
  }

  if (Object.keys(includedEdges).length === 0) {
    warnings.push('No package provenance edges were available for this package.');
  }

  return {
    nodes: sortedManifestRecords(includedNodes),
    edges: sortedManifestRecords(includedEdges),
    evidence: sortedManifestRecords(includedEvidence),
  };
}

function buildPackageProvenanceManifest(project, packageInfo, packageResult) {
  const provenance = isRecord(project && project.provenance) ? project.provenance : null;
  const warnings = [
    'Partial package-relevant provenance manifest only; this is not a full project graph.',
    'Non-package graph records and raw capture observations are intentionally omitted.',
  ];
  if (!provenance) {
    warnings.push('Project provenance sidecar was missing or invalid when this manifest was written.');
  }

  const packageNodeId = createNodeId(NODE_TYPES.PACKAGE, {
    projectId: project && project.id ? project.id : null,
    path: packageInfo.destFolder,
    createdAt: packageInfo.createdAt,
  });
  const graph = collectPackageManifestGraph(provenance, packageNodeId, warnings);
  const createdAt = Number.isFinite(packageInfo.createdAt)
    ? new Date(packageInfo.createdAt).toISOString()
    : null;

  return sanitizeManifestValue({
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    scope: 'partial_package_relevant',
    generatedAt: new Date().toISOString(),
    generatedBy: {
      app: 'Crate',
      version: getCrateVersion(),
    },
    project: {
      id: project && project.id ? project.id : null,
      name: project && project.name ? project.name : null,
      sessionId: provenance && typeof provenance.sessionId === 'string' ? provenance.sessionId : null,
    },
    package: {
      path: packageInfo.destFolder,
      createdAt,
      copiedCount: packageResult.copiedCount,
      embeddedCount: packageResult.embeddedCount,
      totalFiles: packageResult.totalFiles,
      errors: Array.isArray(packageResult.errors) ? packageResult.errors : [],
    },
    nodes: graph.nodes,
    edges: graph.edges,
    evidence: graph.evidence,
    warnings,
  });
}

function writePackageProvenanceManifest(projectId, packageInfo, packageResult) {
  try {
    const project = getProjects().find(p => p.id === projectId) || null;
    const manifest = buildPackageProvenanceManifest(project, packageInfo, packageResult);
    writeFileIntoPackageExact(
      packageInfo.destFolder,
      path.join(DIAGNOSTICS_FOLDER_NAME, PROVENANCE_MANIFEST_FILENAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
      {
        preserveRelativePath: true,
        fallbackName: PROVENANCE_MANIFEST_FILENAME,
        overwrite: true,
      }
    );
  } catch (e) {
    const message = e && typeof e.message === 'string' ? e.message : '';
    const safeMessage = /^(Invalid package output folder|Package output |Package destination )/.test(message)
      ? message
      : 'Diagnostic manifest could not be written safely';
    console.warn('[crate][provenance] manifest write skipped:', safeMessage);
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
    pruneExcludedAutoCapturedFiles(project);
    project.files = deduplicateFiles(project.files);
  }
  if (!Array.isArray(project.pendingFiles)) {
    project.pendingFiles = [];
  } else {
    const acceptedKeys = getTrackedFileKeySet(project.files);
    const seenPendingKeys = new Set();
    project.pendingFiles = project.pendingFiles.filter(file => {
      const key = getTrackedFileDedupKey(file);
      if (!key || acceptedKeys.has(key) || seenPendingKeys.has(key)) return false;
      if (isAutoCaptureExcludedPath(file && file.path)) return false;
      seenPendingKeys.add(key);
      return true;
    });
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
// Historical name retained for existing renderer send paths; this is now the main app window.
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
  const cleaned = `${s || ''}`.replace(/[^a-zA-Z0-9 ._\-()]/g, '').replace(/\s+/g, ' ').trim();
  if (cleaned === '.' || cleaned === '..') return DEFAULT_PACKAGE_FOLDER_NAME;
  return cleaned || DEFAULT_PACKAGE_FOLDER_NAME;
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
const FIGMA_ASSET_DIR_MODE = OWNER_ONLY_DIR_MODE;
const FIGMA_ASSET_FILE_MODE = OWNER_ONLY_FILE_MODE;
const PRESENTATION_ASSETS_DIR = path.join(os.homedir(), '.crate', 'presentation-assets');
const PRESENTATION_ASSET_DIR_MODE = OWNER_ONLY_DIR_MODE;
const PRESENTATION_ASSET_FILE_MODE = OWNER_ONLY_FILE_MODE;
const SAFE_FIGMA_ASSET_FORMATS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'tif', 'tiff', 'heic',
  'svg', 'pdf', 'bmp', 'avif',
]);

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

        const existingPaths = getNormalizedPathSet(proj.files);
        const pendingPaths = getNormalizedPathSet(proj.pendingFiles);

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

          const normalizedFilePath = normalizeTrackedFilePath(filePath);
          if (existingPaths.has(normalizedFilePath)) continue;
          if (pendingPaths.has(normalizedFilePath)) continue;

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

          const fileEntry = buildAutoCaptureFileEntry(filePath, 'lsof', { ext });
          const staged = stageLiveObservedFile(proj, fileEntry, {
            forcePending: true,
            reason: 'lsof-broad-observer',
          });
          if (!staged.changed) continue;
          if (staged.decision === LIVE_CAPTURE_DECISIONS.DIRECT_ADD) {
            recordLsofAcceptedFileProvenance(proj, fileEntry, {
              method: 'poll',
              pid: currentPid,
              command: currentPid ? pidToCmd.get(currentPid) || '' : '',
            });
            existingPaths.add(normalizedFilePath);
          } else if (staged.decision === LIVE_CAPTURE_DECISIONS.PENDING_CANDIDATE) {
            pendingPaths.add(normalizedFilePath);
          }
          lastFileActivity.set(projectId, Date.now());
          inactivityNotified.delete(projectId);
          changed = true;
        }

        if (changed) {
          proj.files = deduplicateFiles(proj.files);
        }
        return { changed, files: proj.files, pendingFiles: proj.pendingFiles || [] };
      });

      if (result && result.changed && trayWindow && !trayWindow.isDestroyed()) {
        trayWindow.webContents.send('files:updated', { projectId, files: result.files });
        trayWindow.webContents.send('files:pending', { projectId, pendingFiles: result.pendingFiles || [] });
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
function hardenOwnerOnlyPermissions(targetPath, mode) {
  if (process.platform === 'win32') return;
  try {
    fs.chmodSync(targetPath, mode);
  } catch (_) {
    // Best effort: chmod can be unsupported on unusual filesystems.
  }
}

function ensureOwnerOnlyDirectory(dirPath, mode = OWNER_ONLY_DIR_MODE) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode });
  }
  hardenOwnerOnlyPermissions(dirPath, mode);
  return dirPath;
}

function hardenOwnerOnlyFile(filePath, mode = OWNER_ONLY_FILE_MODE) {
  if (process.platform === 'win32') return;
  let fd = null;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    fd = fs.openSync(filePath, flags);
    if (!fs.fstatSync(fd).isFile()) return;
    fs.fchmodSync(fd, mode);
  } catch (_) {
    // Best effort: the file may have disappeared or the filesystem may not support fchmod.
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function writeOwnerOnlyFileSync(filePath, data, options = {}, mode = OWNER_ONLY_FILE_MODE) {
  fs.writeFileSync(filePath, data, { ...options, mode });
  hardenOwnerOnlyFile(filePath, mode);
}

function cacheSafetyError(label, detail) {
  const safeLabel = String(label || 'cache').replace(/[^a-z0-9_.:-]/gi, '_');
  const safeDetail = String(detail || 'unsafe').replace(/[^a-z0-9_.:-]/gi, '_');
  return new Error(`Unsafe cache path: ${safeLabel} ${safeDetail}`);
}

function safeRealpath(cachePath, label) {
  try {
    return fs.realpathSync.native(cachePath);
  } catch (_) {
    throw cacheSafetyError(label, 'unavailable');
  }
}

function ensureSafeCacheSegment(segment, label) {
  if (typeof segment !== 'string' || !segment || segment.includes('\0')) {
    throw cacheSafetyError(label, 'invalid');
  }
  if (segment === '.' || segment === '..' || path.basename(segment) !== segment) {
    throw cacheSafetyError(label, 'invalid');
  }
  return segment;
}

function ensureSafeCacheDirectory(dirPath, label, mode = OWNER_ONLY_DIR_MODE, parentRealPath = null) {
  let stat = null;
  try {
    stat = fs.lstatSync(dirPath);
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw cacheSafetyError(label, 'unavailable');
  }

  if (stat) {
    if (stat.isSymbolicLink()) throw cacheSafetyError(label, 'symlink');
    if (!stat.isDirectory()) throw cacheSafetyError(label, 'not_directory');
  } else {
    try {
      fs.mkdirSync(dirPath, { mode });
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw cacheSafetyError(label, 'unavailable');
    }
    try {
      stat = fs.lstatSync(dirPath);
    } catch (_) {
      throw cacheSafetyError(label, 'unavailable');
    }
    if (stat.isSymbolicLink()) throw cacheSafetyError(label, 'symlink');
    if (!stat.isDirectory()) throw cacheSafetyError(label, 'not_directory');
  }

  hardenOwnerOnlyPermissions(dirPath, mode);
  const realPath = safeRealpath(dirPath, label);
  if (parentRealPath && !isPathInsideDirectory(parentRealPath, realPath)) {
    throw cacheSafetyError(label, 'outside_root');
  }
  return realPath;
}

function ensureSafeLocalCacheDir(category, projectId = null, mode = OWNER_ONLY_DIR_MODE) {
  const safeCategory = ensureSafeCacheSegment(category, 'cache-category');
  const crateDir = path.join(os.homedir(), '.crate');
  const crateRealPath = ensureSafeCacheDirectory(crateDir, 'cache-root', mode);
  const categoryDir = path.join(crateDir, safeCategory);
  const categoryRealPath = ensureSafeCacheDirectory(categoryDir, safeCategory, mode, crateRealPath);
  if (projectId == null) return { crateDir, categoryDir, projectDir: null };

  const safeProjectId = ensureSafeCacheSegment(projectId, 'cache-project');
  const projectDir = path.join(categoryDir, safeProjectId);
  ensureSafeCacheDirectory(projectDir, `${safeCategory}-project`, mode, categoryRealPath);
  return { crateDir, categoryDir, projectDir };
}

function ensureFigmaAssetsDir() {
  ensureSafeLocalCacheDir('figma-assets', null, FIGMA_ASSET_DIR_MODE);
  return FIGMA_ASSETS_DIR;
}

function ensureFigmaProjectAssetsDir(projectId) {
  const paths = ensureSafeLocalCacheDir('figma-assets', projectId, FIGMA_ASSET_DIR_MODE);
  return paths.projectDir;
}

function ensurePresentationAssetsDir(projectId) {
  const paths = ensureSafeLocalCacheDir('presentation-assets', projectId, PRESENTATION_ASSET_DIR_MODE);
  return paths.projectDir;
}

function isPathInsideDirectory(parentDir, filePath) {
  if (typeof parentDir !== 'string' || typeof filePath !== 'string') return false;
  const relativePath = path.relative(path.resolve(parentDir), path.resolve(filePath));
  return relativePath === '' || (!!relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function ensureRegularCacheFile(filePath, label) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw cacheSafetyError(label, 'unavailable');
  }
  if (stat.isSymbolicLink()) throw cacheSafetyError(label, 'symlink');
  if (!stat.isFile()) throw cacheSafetyError(label, 'not_file');
  return stat;
}

function safeCacheTempPath(filePath) {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  return path.join(dir, `.${base}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp${ext}`);
}

function writeOwnerOnlyCacheFileSync(filePath, data, cacheDir, mode = OWNER_ONLY_FILE_MODE, options = {}) {
  if (!isPathInsideDirectory(cacheDir, filePath)) throw cacheSafetyError('cache-file', 'outside_root');
  const existing = ensureRegularCacheFile(filePath, 'cache-file');
  if (existing && !options.replace) throw cacheSafetyError('cache-file', 'exists');

  const tempPath = options.replace ? safeCacheTempPath(filePath) : filePath;
  try {
    fs.writeFileSync(tempPath, data, { flag: 'wx', mode });
    hardenOwnerOnlyFile(tempPath, mode);
    if (options.replace) {
      ensureRegularCacheFile(filePath, 'cache-file');
      fs.renameSync(tempPath, filePath);
      hardenOwnerOnlyFile(filePath, mode);
    }
  } catch (e) {
    if (tempPath !== filePath) {
      try { fs.unlinkSync(tempPath); } catch (_) {}
    }
    if (e && e.message && e.message.startsWith('Unsafe cache path:')) throw e;
    throw cacheSafetyError('cache-file', 'write_failed');
  }
}

function hardenPresentationCacheFileIfPresent(filePath, cacheDir) {
  if (!isPathInsideDirectory(cacheDir, filePath)) return;
  try {
    ensureRegularCacheFile(filePath, 'presentation-cache-file');
  } catch (_) {
    return;
  }
  hardenOwnerOnlyFile(filePath, PRESENTATION_ASSET_FILE_MODE);
}

function sanitizeFigmaAssetFormat(format) {
  if (typeof format !== 'string') return 'png';
  const trimmed = format.trim().toLowerCase();
  if (!trimmed || trimmed.includes('\0')) return 'png';
  if (!/^\.?[a-z0-9]+$/.test(trimmed)) return 'png';

  const extension = trimmed.replace(/^\./, '');
  return SAFE_FIGMA_ASSET_FORMATS.has(extension) ? extension : 'png';
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

    const projectDir = ensureFigmaProjectAssetsDir(projectId);

    // v2.4.2: Use actual format from Figma API if available, fall back to png
    const ext = sanitizeFigmaAssetFormat(format);
    const safeName = fileName.replace(/[^a-zA-Z0-9_\-.]/g, '_').substring(0, 100);
    const localPath = path.join(projectDir, `${safeName}.${ext}`);

    // Skip if already exists with same size
    const existingStat = ensureRegularCacheFile(localPath, 'figma-cache-file');
    if (existingStat) {
      const existingSize = existingStat.size;
      if (existingSize === buffer.length) {
        hardenOwnerOnlyFile(localPath, FIGMA_ASSET_FILE_MODE);
        return localPath;
      }
    }

    writeOwnerOnlyCacheFileSync(localPath, buffer, projectDir, FIGMA_ASSET_FILE_MODE, { replace: !!existingStat });
    console.log(`[crate][figma] downloaded asset: ${formatFigmaLocalNameForLog(localPath)}`);
    return localPath;
  } catch (e) {
    console.error('[crate][figma] downloadFigmaAsset error:', redactFigmaLogText(e.message));
    return null;
  }
}

/**
 * Download Figma scan assets and insert them into project state.
 * @returns {Promise<number>} count of inserted assets
 */
async function ingestFigmaAssetsIntoProject(projectId, project, assets, contextLabel = 'scan') {
  if (!assets || assets.length === 0) return 0;

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
        `[crate][figma] asset duplicate skip (${contextLabel}): fileKey=${formatFigmaLogScalar(asset.figmaFileKey)} ` +
        `assetKeyPresent=true reason=existing_asset_key`
      );
      continue;
    }

    const fileName = `${asset.figmaFileName}_${asset.name}`;
    const assetFormat = sanitizeFigmaAssetFormat(asset.format);
    const localPath = await downloadFigmaAsset(asset.url, fileName, projectId, assetFormat);

    if (!localPath) {
      console.log(
        `[crate][figma] asset skip (${contextLabel}): fileKey=${formatFigmaLogScalar(asset.figmaFileKey)} ` +
        `name=${formatFigmaLogScalar(asset.name)} reason=download_failed`
      );
      continue;
    }
    const normalizedLocalPath = normalizeTrackedFilePath(localPath);
    if (existingPaths.has(normalizedLocalPath)) {
      console.log(
        `[crate][figma] asset duplicate skip (${contextLabel}): fileKey=${formatFigmaLogScalar(asset.figmaFileKey)} ` +
        `localName=${formatFigmaLocalNameForLog(localPath)} reason=existing_path`
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
        `[crate][figma] asset inserted (${contextLabel}): fileKey=${formatFigmaLogScalar(asset.figmaFileKey)} ` +
        `name=${formatFigmaLocalNameForLog(fileRecord.name)} localName=${formatFigmaLocalNameForLog(localPath)}`
      );
      return { files: proj.files, fileRecord };
    });

    if (result) {
      const projectHasLocalPath = (project.files || []).some(f => normalizeTrackedFilePath(f.path) === normalizedLocalPath);
      const projectHasFigmaKey = figmaAssetKey && (project.files || []).some(f => getFigmaAssetDedupKey(f) === figmaAssetKey);
      if (!projectHasLocalPath && !projectHasFigmaKey) {
        project.files.push({ ...result.fileRecord });
        project.files = deduplicateFiles(project.files);
      }
      mutateProject(projectId, (proj) => {
        const storedFile = (proj.files || []).find(file => (
          normalizeTrackedFilePath(file.path) === normalizedLocalPath &&
          (!figmaAssetKey || getFigmaAssetDedupKey(file) === figmaAssetKey)
        )) || result.fileRecord;
        recordFigmaAssetProvenance(proj, storedFile, asset, contextLabel);
        return null;
      });
      addedCount++;
      existingPaths.add(normalizedLocalPath);
      if (figmaAssetKey) existingFigmaAssetKeys.add(figmaAssetKey);
    } else {
      console.log(
        `[crate][figma] asset duplicate skip (${contextLabel}): fileKey=${formatFigmaLogScalar(asset.figmaFileKey)} ` +
        `assetKeyPresent=${!!figmaAssetKey} localName=${formatFigmaLocalNameForLog(localPath)} reason=already_in_project`
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
    const safeTrackedFileSummaries = summarizeTrackedFigmaFilesForLog(rawTrackedFiles);
    const safeTrackedFileKeys = normalizedTrackedFileKeys.map(key => formatFigmaLogScalar(key));

    // Determine time window for scanning
    const lastScanMs = figmaScanTimestamps.get(projectId) || project.watchStartedAt || scanStartedAt;
    const watchStartMs = project.watchStartedAt || 0;
    const sinceMs = isInitialScan
      ? scanStartedAt - (30 * 24 * 60 * 60 * 1000) // Initial: last 30 days
      : Math.max(watchStartMs, lastScanMs - FIGMA_INCREMENTAL_OVERLAP_MS);

    console.log(`[crate][figma] Scanning Figma files for project ${projectId} (since ${new Date(sinceMs).toISOString()})`);
    console.log(
      `[crate][figma] scan config (${isInitialScan ? 'live-initial' : 'live-incremental'}): ` +
      `trackedFileCount=${safeTrackedFileSummaries.length} ` +
      `trackedFiles=${JSON.stringify(safeTrackedFileSummaries)} ` +
      `trackedFileKeys=${JSON.stringify(safeTrackedFileKeys)} ` +
      `teamCount=${teamIds.length} ` +
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
      console.warn('[crate][figma] Scan errors:', summarizeFigmaErrorsForLog(scanResult.errors));
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
      figmaScopeMode: getProjectFigmaScopeMode(latestProject)
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
    console.error('[crate][figma] pollFigmaForProject error:', redactFigmaLogText(e.message));
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
      try {
        const { stdout: psOut } = await runOsascriptInPrivateTemp(
          ({ resolveScriptPath }) => ({
            'crate-ps-poll.js': PS_DOJAVASCRIPT,
            'crate-ps-poll.applescript': psDoJavascriptAS(resolveScriptPath('crate-ps-poll.js')),
          }),
          'crate-ps-poll.applescript',
          { timeout: 10000, encoding: 'utf8' }
        );
        for (const p of psOut.split('\n').filter(Boolean)) {
          discoveredPaths.push({ filePath: p, source: 'ps-poll' });
        }
      } catch (e) {
        // Photoshop may be busy or script timed out — skip silently
      }
    }

    // --- InDesign ---
    const { stdout: inddCheck } = await execAsync(
      "/bin/ps ax -o command= 2>/dev/null | grep -i 'Adobe InDesign' | grep -v grep",
      { timeout: 3000, encoding: 'utf8' }
    ).catch(() => ({ stdout: '' }));

    if (inddCheck.trim()) {
      try {
        const { stdout: inddOut } = await runOsascriptInPrivateTemp(
          () => ({ 'crate-indd-poll.applescript': INDD_APPLESCRIPT }),
          'crate-indd-poll.applescript',
          { timeout: 10000, encoding: 'utf8' }
        );
        for (const line of inddOut.split('\n')) {
          const p = line.trim();
          if (p) discoveredPaths.push({ filePath: p, source: 'indd-poll' });
        }
      } catch (e) {
        // InDesign may be busy or script timed out — skip silently
      }
    }

    if (discoveredPaths.length === 0) return;

    // Deduplicate against accepted and pending project ledgers.
    const existingPaths = getNormalizedPathSet(project.files);
    const pendingPaths = getNormalizedPathSet(project.pendingFiles);
    const newFiles = [];

    for (const { filePath, source } of discoveredPaths) {
      const normalizedFilePath = normalizeTrackedFilePath(filePath);
      if (existingPaths.has(normalizedFilePath) || pendingPaths.has(normalizedFilePath)) continue;
      const ext = path.extname(filePath).toLowerCase();
      if (!DESIGN_FILE_EXTENSIONS.has(ext)) continue;
      try {
        fs.accessSync(filePath, fs.constants.R_OK);
      } catch (_) {
        continue; // File doesn't exist or not readable
      }
      newFiles.push({ filePath, source, ext });
      pendingPaths.add(normalizedFilePath); // prevent dupes within this batch
    }

    if (newFiles.length === 0) return;

    let addedCount = 0;
    for (const { filePath, source, ext } of newFiles) {
      const result = mutateProject(projectId, (proj) => {
        if (proj.status !== 'watching') return null;
        const fileEntry = buildAutoCaptureFileEntry(filePath, source, { ext });
        const staged = stageLiveObservedFile(proj, fileEntry, {
          forcePending: true,
          reason: 'app-script-broad-observer',
        });
        if (!staged.changed) return null;
        if (staged.decision === LIVE_CAPTURE_DECISIONS.DIRECT_ADD) {
          const storedFile = proj.files.find(f => f.path === fileEntry.path && f.source === fileEntry.source);
          if (storedFile) {
            recordSessionObservedFile(proj, storedFile, {
              kind: OBSERVER_KINDS.APP_SCRIPT,
              method: source,
              payload: {
                method: source,
                channel: 'live-app-poll',
              },
            });
          }
        }
        return { files: proj.files, pendingFiles: proj.pendingFiles || [] };
      });
      if (result) addedCount++;
    }

    if (addedCount > 0) {
      lastFileActivity.set(projectId, Date.now());
      inactivityNotified.delete(projectId);

      const updatedProject = getProjects().find(p => p.id === projectId);
      if (updatedProject) {
        sendToRenderer('files:updated', { projectId, files: updatedProject.files });
        sendToRenderer('files:pending', { projectId, pendingFiles: updatedProject.pendingFiles || [] });
      }
      console.log(`[crate][ps-poll] Staged ${addedCount} linked assets for project ${projectId}`);
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
  const existingPaths = getNormalizedPathSet(project.files);
  const pendingPaths = getNormalizedPathSet(project.pendingFiles);
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
      if (isAutoCaptureExcludedPath(fullPath)) continue;
      const normalizedFullPath = normalizeTrackedFilePath(fullPath);
      if (existingPaths.has(normalizedFullPath) || pendingPaths.has(normalizedFullPath)) continue;
      newFiles.push({ path: fullPath, name, ext, addedAt: Date.now(), source: 'lastused-poll' });
      pendingPaths.add(normalizedFullPath);
    }
  } catch (e) {
    // mdfind failed — skip this poll cycle
  }

  if (newFiles.length === 0) return;

  const result = mutateProject(projectId, (proj) => {
    if (proj.status !== 'watching') return null;
    const acceptedFiles = [];
    let added = 0;
    for (const f of newFiles) {
      const staged = stageLiveObservedFile(proj, f, {
        forcePending: true,
        reason: 'lastused-broad-observer',
      });
      if (!staged.changed) continue;
      if (staged.decision === LIVE_CAPTURE_DECISIONS.DIRECT_ADD) {
        acceptedFiles.push(f);
      }
      added++;
    }
    if (added === 0) return null;
    proj.files = deduplicateFiles(proj.files);
    for (const file of acceptedFiles) {
      const storedFile = proj.files.find(item => item.path === file.path && item.source === file.source);
      if (!storedFile) continue;
      recordSessionObservedFile(proj, storedFile, {
        kind: OBSERVER_KINDS.SPOTLIGHT_LAST_USED,
        method: 'lastused-poll',
        payload: {
          method: 'lastused-poll',
          channel: 'live-lastused-poll',
        },
      });
    }
    return { files: proj.files, pendingFiles: proj.pendingFiles || [] };
  });

  if (result && trayWindow && !trayWindow.isDestroyed()) {
    trayWindow.webContents.send('files:updated', { projectId, files: result.files });
    trayWindow.webContents.send('files:pending', { projectId, pendingFiles: result.pendingFiles || [] });
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
      const { stdout: psPaths } = await runOsascriptInPrivateTemp(
        ({ resolveScriptPath }) => ({
          'crate-ps-scan.js': PS_DOJAVASCRIPT,
          'crate-ps-scan.applescript': psDoJavascriptAS(resolveScriptPath('crate-ps-scan.js')),
        }),
        'crate-ps-scan.applescript',
        { timeout: 10000, encoding: 'utf8' }
      ).catch(() => ({ stdout: '' }));

      if (psPaths.trim()) {
        const results = [];
        for (const p of psPaths.split('\n').filter(Boolean)) {
          if (p === filePath) continue;
          if (fs.existsSync(p)) results.push(p);
        }
        if (results.length > 0) {
          return results;
        }
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

      const { stdout: inddPaths } = await runOsascriptInPrivateTemp(
        () => ({ 'crate-indd-query.applescript': appleScript }),
        'crate-indd-query.applescript',
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
          return results;
        }
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
  const currentProject = getProjects().find(p => p.id === projectId);
  if (!currentProject || !isAcceptedProjectFilePath(currentProject, filePath)) return;

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
    const acceptedFiles = [];
    let changed = false;

    for (const linkedPath of validPaths) {
      const fileEntry = buildAutoCaptureFileEntry(linkedPath, 'scan-on-open');
      const staged = stageLiveObservedFile(proj, fileEntry, {
        relationshipSourcePath: filePath,
        reason: 'scan-on-open-source-relationship',
      });
      if (!staged.changed) continue;
      if (staged.decision === LIVE_CAPTURE_DECISIONS.DIRECT_ADD) {
        acceptedFiles.push(fileEntry);
      }
      changed = true;
    }

    if (changed) {
      proj.files = deduplicateFiles(proj.files);
      for (const file of acceptedFiles) {
        const storedFile = proj.files.find(item => item.path === file.path && item.source === file.source);
        if (!storedFile) continue;
        recordSessionObservedFile(proj, storedFile, {
          kind: OBSERVER_KINDS.PARSER,
          method: 'scan-on-open',
          payload: {
            method: 'scan-on-open',
            channel: 'live-scan-on-open',
          },
        });
      }
    }
    return changed ? { files: proj.files, pendingFiles: proj.pendingFiles || [] } : null;
  });

  if (result) {
    lastFileActivity.set(projectId, Date.now());
    inactivityNotified.delete(projectId);
    sendToRenderer('files:updated', { projectId, files: result.files });
    sendToRenderer('files:pending', { projectId, pendingFiles: result.pendingFiles || [] });
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
        const acceptedFiles = [];
        let changed = false;
        for (const asset of psdAssets) {
          const fileEntry = buildAutoCaptureFileEntry(asset.filePath, asset.source);
          const staged = stageLiveObservedFile(proj, fileEntry, {
            relationshipSourcePath: filePath,
            reason: 'scan-on-open-psd-parser',
          });
          if (!staged.changed) continue;
          if (staged.decision === LIVE_CAPTURE_DECISIONS.DIRECT_ADD) {
            acceptedFiles.push(fileEntry);
          }
          changed = true;
        }
        if (changed) {
          proj.files = deduplicateFiles(proj.files);
          for (const file of acceptedFiles) {
            const storedFile = proj.files.find(item => item.path === file.path && item.source === file.source);
            if (!storedFile) continue;
            recordSessionObservedFile(proj, storedFile, {
              kind: OBSERVER_KINDS.PARSER,
              method: 'scan-on-open-psd-parser',
              payload: {
                method: 'scan-on-open-psd-parser',
                channel: 'live-scan-on-open',
                parser: 'ag-psd',
              },
            });
          }
        }
        return changed ? { files: proj.files, pendingFiles: proj.pendingFiles || [] } : null;
      });
      if (psdResult) {
        lastFileActivity.set(projectId, Date.now());
        inactivityNotified.delete(projectId);
        sendToRenderer('files:updated', { projectId, files: psdResult.files });
        sendToRenderer('files:pending', { projectId, pendingFiles: psdResult.pendingFiles || [] });
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
    const currentProject = getProjects().find(p => p.id === projectId);
    if (!currentProject || !isAcceptedProjectFilePath(currentProject, psdFilePath)) return;

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
      let changed = false;

      for (const entry of newEntries) {
        const staged = stageLiveObservedFile(proj, entry, {
          relationshipSourcePath: psdFilePath,
          reason: 'scan-on-save-psd',
        });
        if (!staged.changed) continue;
        if (staged.decision === LIVE_CAPTURE_DECISIONS.DIRECT_ADD) {
          recordPsdParserRelationship(proj, psdFilePath, entry);
        }
        changed = true;
      }

      if (changed) {
        proj.files = deduplicateFiles(proj.files);
      }
      return changed ? { files: proj.files, pendingFiles: proj.pendingFiles || [] } : null;
    });

    if (result) {
      lastFileActivity.set(projectId, Date.now());
      inactivityNotified.delete(projectId);
      sendToRenderer('files:updated', { projectId, files: result.files });
      sendToRenderer('files:pending', { projectId, pendingFiles: result.pendingFiles || [] });
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
    const currentProject = getProjects().find(p => p.id === projectId);
    if (!currentProject || !isAcceptedProjectFilePath(currentProject, presentationPath)) return;

    // Ensure temp dir exists: ~/.crate/presentation-assets/{projectId}/
    const tempDir = ensurePresentationAssetsDir(projectId);

    // Build dedup sets from existing project files
    const currentProjects = getProjects();
    const project = currentProjects.find(p => p.id === projectId);
    if (!project || project.status !== 'watching') return;
    const projectFiles = project.files || [];

    // Name-based dedup for .key files
    const alreadyCapturedBases = new Set();
    for (const f of projectFiles) {
      if (f && f.source === 'scan-on-save-presentation') {
        hardenPresentationCacheFileIfPresent(f.path, tempDir);
      }
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
          hardenPresentationCacheFileIfPresent(destPath, tempDir);
          const e = path.extname(outputName);
          const b = path.basename(outputName, e);
          destPath = path.join(tempDir, `${b}_${counter}${e}`);
          counter++;
        }

        writeOwnerOnlyCacheFileSync(destPath, data, tempDir, PRESENTATION_ASSET_FILE_MODE);
        console.log(`[crate] scan-on-save-presentation: extracted ${outputName}`);

        newEntries.push({
          path: destPath,
          name: path.basename(destPath),
          ext: path.extname(destPath).toLowerCase(),
          addedAt: Date.now(),
          source: 'scan-on-save-presentation',
          internalPath: zipPath,
          presentationPath,
        });
      } catch (e) {
        console.error(`[crate] scan-on-save-presentation: failed to extract ${zipPath}:`, redactFigmaLogText(e.message));
      }
    }

    if (newEntries.length === 0) return;

    const result = mutateProject(projectId, (proj) => {
      if (proj.status !== 'watching') return null;
      let changed = false;

      for (const entry of newEntries) {
        const { internalPath, presentationPath: sourcePresentationPath, ...fileEntry } = entry;
        const staged = stageLiveObservedFile(proj, fileEntry, {
          relationshipSourcePath: sourcePresentationPath,
          reason: 'scan-on-save-presentation',
        });
        if (!staged.changed) continue;
        if (staged.decision === LIVE_CAPTURE_DECISIONS.DIRECT_ADD) {
          recordPowerPointMediaExtractionProvenanceForProject(proj, [{
            presentationPath: sourcePresentationPath,
            internalPath,
            materializedPath: fileEntry.path,
            source: fileEntry.source,
            observedAt: fileEntry.addedAt,
          }]);
        }
        changed = true;
      }

      if (changed) proj.files = deduplicateFiles(proj.files);
      return changed ? { files: proj.files, pendingFiles: proj.pendingFiles || [] } : null;
    });

    if (result) {
      lastFileActivity.set(projectId, Date.now());
      inactivityNotified.delete(projectId);
      sendToRenderer('files:updated', { projectId, files: result.files });
      sendToRenderer('files:pending', { projectId, pendingFiles: result.pendingFiles || [] });
    }
  } catch (e) {
    console.log('[scan-on-save-presentation] extraction failed:', redactFigmaLogText(e.message));
  }
}

function createMainWindow() {
  if (trayWindow && !trayWindow.isDestroyed()) return trayWindow;

  trayWindow = new BrowserWindow({
    width: 960,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    show: true,
    title: 'Crate',
    frame: true,
    resizable: true,
    movable: true,
    minimizable: true,
    maximizable: true,
    closable: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    transparent: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  trayWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  trayWindow.on('closed', () => {
    trayWindow = null;
  });

  return trayWindow;
}

function toggleTrayWindow() {
  showMainWindow();
}

function showMainWindow() {
  if (typeof app.isReady === 'function' && !app.isReady()) return;

  if (!trayWindow || trayWindow.isDestroyed()) {
    createMainWindow();
  }
  if (!trayWindow || trayWindow.isDestroyed()) return;

  if (typeof trayWindow.isMinimized === 'function' && trayWindow.isMinimized()) {
    trayWindow.restore();
  }
  trayWindow.show();
  trayWindow.focus();
}

// Backward-compatible name for package/dialog flows that reveal the app UI.
function showTrayWindow() {
  showMainWindow();
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
    const pidToCmd = new Map();
    for (const line of psOut.trim().split('\n')) {
      const m = line.trim().match(/^\s*(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = parseInt(m[1]);
      const cmd = m[2];
      if (keywords.some(kw => cmd.includes(kw))) {
        pids.push(pid);
        pidToCmd.set(pid, cmd);
      }
    }

    if (pids.length > 0) {
      const home = os.homedir();
      const validPids = pids.filter(p => Number.isInteger(p) && p > 0);
      if (validPids.length > 0) {
        const { stdout: lsofOut } = await execFileAsync('/usr/sbin/lsof', ['-F', 'ptn', '-p', validPids.join(',')], {
          timeout: 12000, encoding: 'utf8'
        });

        // FIX 1: Use mutateProject to atomically apply snapshot results
        // v2.2.2: Collect design files for scan-on-open
        const snapshotDesignFiles = [];

        const snapshotResult = mutateProject(projectId, (project) => {
          const existingPaths = getNormalizedPathSet(project.files);
          const pendingPaths = getNormalizedPathSet(project.pendingFiles);
          let snapshotChanged = false;
          let currentPid = null;
          let currentType = null;
          const LINKABLE_EXTS_SNAPSHOT = new Set(['.ai', '.indd', '.idml', '.psd', '.pdf', '.afdesign', '.afpub', '.afphoto']);
          const linkableForParse = [];

          for (const line of lsofOut.trim().split('\n')) {
            if (line.length === 0) continue;
            const tag = line[0];
            const value = line.slice(1);

            if (tag === 'p') { currentPid = parseInt(value); currentType = null; continue; }
            if (tag === 'f') { currentType = null; continue; }
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

            const normalizedFilePath = normalizeTrackedFilePath(filePath);
            const sourceAcceptedBefore = existingPaths.has(normalizedFilePath);

            // v2.3.9: Mark for scan-on-open BEFORE existingPaths check —
            // pre-session files already in project still need asset extraction.
            if (sourceAcceptedBefore && SCAN_ON_OPEN_EXTENSIONS.has(ext)) {
              snapshotDesignFiles.push(filePath);
            }

            if (sourceAcceptedBefore) {
              if (LINKABLE_EXTS_SNAPSHOT.has(ext)) {
                linkableForParse.push({
                  path: filePath,
                  name: path.basename(filePath),
                  ext,
                  source: 'lsof',
                });
              }
              continue;
            }
            if (pendingPaths.has(normalizedFilePath)) continue;

            const fileEntry = buildAutoCaptureFileEntry(filePath, 'lsof', { ext });
            const staged = stageLiveObservedFile(project, fileEntry, {
              forcePending: true,
              reason: 'initial-lsof-snapshot',
            });
            if (!staged.changed) continue;
            if (staged.decision === LIVE_CAPTURE_DECISIONS.DIRECT_ADD) {
              recordLsofAcceptedFileProvenance(project, fileEntry, {
                method: 'initial-snapshot',
                pid: currentPid,
                command: currentPid ? pidToCmd.get(currentPid) || '' : '',
              });
              existingPaths.add(normalizedFilePath);
              if (SCAN_ON_OPEN_EXTENSIONS.has(ext)) {
                snapshotDesignFiles.push(filePath);
              }
              if (LINKABLE_EXTS_SNAPSHOT.has(ext)) {
                linkableForParse.push(fileEntry);
              }
            } else if (staged.decision === LIVE_CAPTURE_DECISIONS.PENDING_CANDIDATE) {
              pendingPaths.add(normalizedFilePath);
            }
            snapshotChanged = true;
          }

          // Parse linked assets from any linkable design files found in the snapshot
          if (linkableForParse.length > 0) {
            const LINKED_ASSET_REGEX_SNAPSHOT = /(?:\/Users\/|\/Volumes\/)[^\x00-\x1f\x22\x27]+\.(jpg|jpeg|png|gif|webp|svg|pdf|eps|ai|psd|tiff|tif|afdesign|afphoto|afpub|indd|idml|sketch|fig|heic|ttf|otf|woff|woff2|mp4|mov|avi|webm)/gi;
            const linkedRegexFiles = [];
            for (const designFile of linkableForParse) {
              try {
                if (!fs.existsSync(designFile.path)) continue;
                const buf = fs.readFileSync(designFile.path);
                const content = buf.toString('utf8');
                let match;
                LINKED_ASSET_REGEX_SNAPSHOT.lastIndex = 0;
                while ((match = LINKED_ASSET_REGEX_SNAPSHOT.exec(content)) !== null) {
                  const linkedPath = match[0];
                  const normalizedLinkedPath = normalizeTrackedFilePath(linkedPath);
                  if (existingPaths.has(normalizedLinkedPath) || pendingPaths.has(normalizedLinkedPath)) continue;
                  if (!fs.existsSync(linkedPath)) continue;

                  const fileEntry = buildAutoCaptureFileEntry(linkedPath, 'linked-asset');
                  const staged = stageLiveObservedFile(project, fileEntry, {
                    relationshipSourcePath: designFile.path,
                    reason: 'initial-snapshot-linked-regex',
                  });
                  if (!staged.changed) continue;
                  if (staged.decision === LIVE_CAPTURE_DECISIONS.DIRECT_ADD) {
                    linkedRegexFiles.push(fileEntry);
                    existingPaths.add(normalizedLinkedPath);
                  } else if (staged.decision === LIVE_CAPTURE_DECISIONS.PENDING_CANDIDATE) {
                    pendingPaths.add(normalizedLinkedPath);
                  }
                  snapshotChanged = true;
                }
              } catch (e) {
                // read error — continue with others
              }
            }
            if (linkedRegexFiles.length > 0) {
              project.files = deduplicateFiles(project.files);
              for (const file of linkedRegexFiles) {
                const storedFile = project.files.find(item => item.path === file.path && item.source === file.source);
                if (!storedFile) continue;
                recordSessionObservedFile(project, storedFile, {
                  kind: OBSERVER_KINDS.PARSER,
                  method: 'initial-snapshot-linked-regex',
                  payload: {
                    method: 'initial-snapshot-linked-regex',
                    channel: 'initial-lsof-snapshot',
                  },
                });
              }
            }
          }

          if (snapshotChanged) {
            project.files = deduplicateFiles(project.files);
          }
          return snapshotChanged ? { files: project.files, pendingFiles: project.pendingFiles || [] } : null;
        });
        if (snapshotResult) {
          sendToRenderer('files:updated', { projectId, files: snapshotResult.files });
          sendToRenderer('files:pending', { projectId, pendingFiles: snapshotResult.pendingFiles || [] });
        }

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
      const result = mutateProject(projectId, (proj) => {
        if (proj.status !== 'watching') return null;
        const staged = stageLiveObservedFile(proj, fileEntry, {
          allowDirect: true,
          reason: 'chokidar-add',
        });
        if (!staged.changed) return null;
        if (staged.decision === LIVE_CAPTURE_DECISIONS.DIRECT_ADD) {
          recordSessionObservedFile(proj, fileEntry, {
            kind: OBSERVER_KINDS.CHOKIDAR,
            method: 'add',
          });
        }
        return { files: proj.files, pendingFiles: proj.pendingFiles || [] };
      });

      if (result) {
        lastFileActivity.set(projectId, Date.now());
        inactivityNotified.delete(projectId);
        if (trayWindow && !trayWindow.isDestroyed()) {
          trayWindow.webContents.send('files:updated', { projectId, files: result.files });
          trayWindow.webContents.send('files:pending', { projectId, pendingFiles: result.pendingFiles || [] });
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
      const result = mutateProject(projectId, (proj) => {
        if (proj.status !== 'watching') return null;
        const staged = stageLiveObservedFile(proj, fileEntry, {
          allowDirect: true,
          reason: 'chokidar-change',
        });
        if (!staged.changed) return null;
        if (staged.decision === LIVE_CAPTURE_DECISIONS.DIRECT_ADD) {
          recordSessionObservedFile(proj, fileEntry, {
            kind: OBSERVER_KINDS.CHOKIDAR,
            method: 'change',
          });
        }
        return { files: proj.files, pendingFiles: proj.pendingFiles || [] };
      });

      if (result) {
        lastFileActivity.set(projectId, Date.now());
        inactivityNotified.delete(projectId);
        if (trayWindow && !trayWindow.isDestroyed()) {
          trayWindow.webContents.send('files:updated', { projectId, files: result.files });
          trayWindow.webContents.send('files:pending', { projectId, pendingFiles: result.pendingFiles || [] });
        }
      }

      const updatedProject = getProjects().find(p => p.id === projectId);
      const sourceIsAccepted = isAcceptedProjectFilePath(updatedProject, filePath);

      // v2.2.2: When a design file changes, re-scan for linked assets
      // (designer may have added new links). Fire-and-forget.
      // C3: Skip runScanOnOpen for .psd — scheduleScanOnSave handles it with debounce
      // to avoid double ag-psd parse on every .psd save event.
      if (sourceIsAccepted && SCAN_ON_OPEN_EXTENSIONS.has(ext) && ext !== '.psd') {
        runScanOnOpen(projectId, filePath).catch(() => {});
      }

      // v2.5.0: Scan-on-save for PSD files — debounced, completely isolated pipeline.
      if (sourceIsAccepted && ext === '.psd') {
        scheduleScanOnSave(projectId, filePath);
      }

      // v2.5.3: Scan-on-save for presentation files — extract embedded media live.
      if (sourceIsAccepted && (ext === '.pptx' || ext === '.ppt' || ext === '.key')) {
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

        // v2.4.2: Fallback — if the app window is not visible, show native Notification
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
              showMainWindow();
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
    const acceptedKey = getTrackedFileDedupKey(file);
    const acceptedPaths = getTrackedFileKeySet(project.files);

    if (!acceptedPaths.has(acceptedKey)) {
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
  // Show the app window after native dialog closes.
  showTrayWindow();

  if (dialogResult.canceled) return null;

  const filePaths = dialogResult.filePaths;
  const result = mutateProject(projectId, (project) => {
    const acceptedKeys = getTrackedFileKeySet(project.files);
    for (const filePath of filePaths) {
      const fileEntry = {
        path: filePath,
        name: path.basename(filePath),
        ext: path.extname(filePath).toLowerCase(),
        addedAt: Date.now(),
        source: 'manual-browse', // M1
      };
      const key = getTrackedFileDedupKey(fileEntry);
      if (acceptedKeys.has(key)) continue;
      project.files.push(fileEntry);
      acceptedKeys.add(key);
      recordSessionObservedFile(project, fileEntry, {
        kind: OBSERVER_KINDS.MANUAL_USER_ACTION,
        method: 'projects:add-files',
      });
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
  const preScanExistingKeys = getTrackedFileKeySet(project.files);
  const existingPaths = getNormalizedPathSet(project.files);
  const pendingPaths = getNormalizedPathSet(project.pendingFiles);

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
        if (isAutoCaptureExcludedPath(filePath)) continue;
        const normalizedFilePath = normalizeTrackedFilePath(filePath);
        if (existingPaths.has(normalizedFilePath) || pendingPaths.has(normalizedFilePath)) continue;
        if (!fs.existsSync(filePath)) continue;
        const fileEntry = buildAutoCaptureFileEntry(filePath, 'lsof-package-scan', {
          ext: '.fig',
        });
        const staged = stageLiveObservedFile(project, fileEntry, {
          forcePending: true,
          reason: 'pre-package-lsof-scan',
        });
        if (!staged.changed) continue;
        if (staged.decision === LIVE_CAPTURE_DECISIONS.DIRECT_ADD) {
          existingPaths.add(normalizedFilePath);
        } else if (staged.decision === LIVE_CAPTURE_DECISIONS.PENDING_CANDIDATE) {
          pendingPaths.add(normalizedFilePath);
        }
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
          if (isAutoCaptureExcludedPath(fullPath)) continue;
          const normalizedFullPath = normalizeTrackedFilePath(fullPath);
          if (existingPaths.has(normalizedFullPath) || pendingPaths.has(normalizedFullPath)) continue;

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

          const fileEntry = buildAutoCaptureFileEntry(fullPath, 'fig-scan', {
            name: entry.name,
            ext: '.fig',
          });
          const staged = stageLiveObservedFile(project, fileEntry, {
            forcePending: true,
            reason: 'pre-package-fig-scan',
          });
          if (!staged.changed) continue;
          if (staged.decision === LIVE_CAPTURE_DECISIONS.DIRECT_ADD) {
            existingPaths.add(normalizedFullPath);
          } else if (staged.decision === LIVE_CAPTURE_DECISIONS.PENDING_CANDIDATE) {
            pendingPaths.add(normalizedFullPath);
          }
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
          if (isAutoCaptureExcludedPath(fullPath)) continue;
          const normalizedFullPath = normalizeTrackedFilePath(fullPath);
          if (existingPaths.has(normalizedFullPath) || pendingPaths.has(normalizedFullPath)) continue;

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

          const fileEntry = buildAutoCaptureFileEntry(fullPath, 'lastused-scan', {
            name: entry.name,
            ext,
          });
          const staged = stageLiveObservedFile(project, fileEntry, {
            forcePending: true,
            reason: 'pre-package-lastused-scan',
          });
          if (!staged.changed) continue;
          if (staged.decision === LIVE_CAPTURE_DECISIONS.DIRECT_ADD) {
            existingPaths.add(normalizedFullPath);
          } else if (staged.decision === LIVE_CAPTURE_DECISIONS.PENDING_CANDIDATE) {
            pendingPaths.add(normalizedFullPath);
          }
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

      const { stdout: aiPaths } = await runOsascriptInPrivateTemp(
        () => ({ 'crate-ai-scan.applescript': aiAppleScript }),
        'crate-ai-scan.applescript',
        { timeout: 10000, encoding: 'utf8' }
      ).catch(() => ({ stdout: '' }));

      if (aiPaths.trim()) {
        for (const linkedPath of aiPaths.trim().split('\n')) {
          const trimmed = linkedPath.trim();
          if (!trimmed) continue;
          if (isAutoCaptureExcludedPath(trimmed)) continue;
          const normalizedTrimmed = normalizeTrackedFilePath(trimmed);
          if (existingPaths.has(normalizedTrimmed) || pendingPaths.has(normalizedTrimmed)) continue;
          if (!fs.existsSync(trimmed)) continue;
          const ext = path.extname(trimmed).toLowerCase();
          if (!DESIGN_FILE_EXTENSIONS.has(ext)) continue;

          const fileEntry = buildAutoCaptureFileEntry(trimmed, 'ai-linked', { ext });
          const staged = stageLiveObservedFile(project, fileEntry, {
            forcePending: true,
            reason: 'pre-package-app-script-broad-observer',
          });
          if (!staged.changed) continue;
          if (staged.decision === LIVE_CAPTURE_DECISIONS.DIRECT_ADD) {
            existingPaths.add(normalizedTrimmed);
          } else if (staged.decision === LIVE_CAPTURE_DECISIONS.PENDING_CANDIDATE) {
            pendingPaths.add(normalizedTrimmed);
          }
          newCount++;
        }
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
      const { stdout: psPaths } = await runOsascriptInPrivateTemp(
        ({ resolveScriptPath }) => ({
          'crate-ps-scan.js': PS_DOJAVASCRIPT,
          'crate-ps-scan.applescript': psDoJavascriptAS(resolveScriptPath('crate-ps-scan.js')),
        }),
        'crate-ps-scan.applescript',
        { timeout: 10000, encoding: 'utf8' }
      ).catch(() => ({ stdout: '' }));

      if (psPaths.trim()) {
        for (const trimmed of psPaths.split('\n').filter(Boolean)) {
          if (isAutoCaptureExcludedPath(trimmed)) continue;
          const normalizedTrimmed = normalizeTrackedFilePath(trimmed);
          if (existingPaths.has(normalizedTrimmed) || pendingPaths.has(normalizedTrimmed)) continue;
          if (!fs.existsSync(trimmed)) continue;
          const ext = path.extname(trimmed).toLowerCase();
          if (!DESIGN_FILE_EXTENSIONS.has(ext)) continue;

          const fileEntry = buildAutoCaptureFileEntry(trimmed, 'psd-linked', { ext });
          const staged = stageLiveObservedFile(project, fileEntry, {
            forcePending: true,
            reason: 'pre-package-app-script-broad-observer',
          });
          if (!staged.changed) continue;
          if (staged.decision === LIVE_CAPTURE_DECISIONS.DIRECT_ADD) {
            existingPaths.add(normalizedTrimmed);
          } else if (staged.decision === LIVE_CAPTURE_DECISIONS.PENDING_CANDIDATE) {
            pendingPaths.add(normalizedTrimmed);
          }
          newCount++;
        }
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
        const normalizedAssetPath = normalizeTrackedFilePath(asset.filePath);
        if (existingPaths.has(normalizedAssetPath) || pendingPaths.has(normalizedAssetPath)) continue;
        const fileEntry = buildAutoCaptureFileEntry(asset.filePath, asset.source);
        const staged = stageLiveObservedFile(project, fileEntry, {
          relationshipSourcePath: psdFile.path,
          reason: 'pre-package-psd-parser',
        });
        if (!staged.changed) continue;
        if (staged.decision === LIVE_CAPTURE_DECISIONS.DIRECT_ADD) {
          existingPaths.add(normalizedAssetPath);
        } else if (staged.decision === LIVE_CAPTURE_DECISIONS.PENDING_CANDIDATE) {
          pendingPaths.add(normalizedAssetPath);
        }
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

      const { stdout: inddPaths } = await runOsascriptInPrivateTemp(
        () => ({ 'crate-indd-scan.applescript': inddAppleScript }),
        'crate-indd-scan.applescript',
        { timeout: 10000, encoding: 'utf8' }
      ).catch(() => ({ stdout: '' }));

      if (inddPaths.trim()) {
        for (const linkedPath of inddPaths.trim().split('\n')) {
          const trimmed = linkedPath.trim();
          if (!trimmed) continue;
          if (isAutoCaptureExcludedPath(trimmed)) continue;
          const normalizedTrimmed = normalizeTrackedFilePath(trimmed);
          if (existingPaths.has(normalizedTrimmed) || pendingPaths.has(normalizedTrimmed)) continue;
          if (!fs.existsSync(trimmed)) continue;
          const ext = path.extname(trimmed).toLowerCase();
          if (!DESIGN_FILE_EXTENSIONS.has(ext)) continue;

          const fileEntry = buildAutoCaptureFileEntry(trimmed, 'indd-linked', { ext });
          const staged = stageLiveObservedFile(project, fileEntry, {
            forcePending: true,
            reason: 'pre-package-app-script-broad-observer',
          });
          if (!staged.changed) continue;
          if (staged.decision === LIVE_CAPTURE_DECISIONS.DIRECT_ADD) {
            existingPaths.add(normalizedTrimmed);
          } else if (staged.decision === LIVE_CAPTURE_DECISIONS.PENDING_CANDIDATE) {
            pendingPaths.add(normalizedTrimmed);
          }
          newCount++;
        }
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
    const linkExisting = getNormalizedPathSet(project.files);

    for (const designFile of linkableFiles) {
      try {
        if (!fs.existsSync(designFile.path)) continue;
        const buf = await fs.promises.readFile(designFile.path);
        const content = buf.toString('utf8');
        let match;
        LINKED_ASSET_REGEX.lastIndex = 0;
        while ((match = LINKED_ASSET_REGEX.exec(content)) !== null) {
          const linkedPath = match[0];
          if (isAutoCaptureExcludedPath(linkedPath)) continue;
          const normalizedLinkedPath = normalizeTrackedFilePath(linkedPath);
          if (linkExisting.has(normalizedLinkedPath) || pendingPaths.has(normalizedLinkedPath)) continue;
          if (!fs.existsSync(linkedPath)) continue;

          const fileEntry = buildAutoCaptureFileEntry(linkedPath, 'linked-asset');
          const staged = stageLiveObservedFile(project, fileEntry, {
            relationshipSourcePath: designFile.path,
            reason: 'pre-package-linked-regex',
          });
          if (!staged.changed) continue;
          if (staged.decision === LIVE_CAPTURE_DECISIONS.DIRECT_ADD) {
            linkExisting.add(normalizedLinkedPath);
            existingPaths.add(normalizedLinkedPath);
          } else if (staged.decision === LIVE_CAPTURE_DECISIONS.PENDING_CANDIDATE) {
            pendingPaths.add(normalizedLinkedPath);
          }
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
    const existingPathsCheck = getNormalizedPathSet(project.files);
    let doubleCheckCount = 0;
    for (const file of project.files.slice()) {
      if (!SCAN_ON_OPEN_EXTENSIONS.has(file.ext)) continue;
      try {
        if (!fs.existsSync(file.path)) continue;
        const linkedPaths = await extractLinkedAssets(file.path);
        for (const lp of linkedPaths) {
          if (isAutoCaptureExcludedPath(lp)) continue;
          const normalizedLinkedPath = normalizeTrackedFilePath(lp);
          if (existingPathsCheck.has(normalizedLinkedPath) || pendingPaths.has(normalizedLinkedPath)) continue;
          if (!lp.startsWith('/Users/')) continue;
          const lpExt = path.extname(lp).toLowerCase();
          if (!DESIGN_FILE_EXTENSIONS.has(lpExt)) continue;
          if (!fs.existsSync(lp)) continue;
          const fileEntry = buildAutoCaptureFileEntry(lp, 'pre-package-doublecheck', {
            ext: lpExt,
          });
          const staged = stageLiveObservedFile(project, fileEntry, {
            relationshipSourcePath: file.path,
            reason: 'pre-package-doublecheck',
          });
          if (!staged.changed) continue;
          if (staged.decision === LIVE_CAPTURE_DECISIONS.DIRECT_ADD) {
            existingPathsCheck.add(normalizedLinkedPath);
            existingPaths.add(normalizedLinkedPath);
          } else if (staged.decision === LIVE_CAPTURE_DECISIONS.PENDING_CANDIDATE) {
            pendingPaths.add(normalizedLinkedPath);
          }
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
      const existingKeys = getTrackedFileKeySet(proj.files);
      const recoveredFilesForProvenance = [];
      for (const f of scanFiles) {
        const key = getTrackedFileDedupKey(f);
        if (preScanExistingKeys.has(key)) continue;

        if (!existingKeys.has(key)) {
          proj.files.push(f);
          existingKeys.add(key);
          recoveredFilesForProvenance.push(f);
          continue;
        }

        const storedFile = proj.files.find(file => file.path === f.path && file.source === f.source);
        if (storedFile) {
          recoveredFilesForProvenance.push(storedFile);
        }
      }
      if (scanPending.length > 0) {
        if (!proj.pendingFiles) proj.pendingFiles = [];
        const existPendingKeys = getTrackedFileKeySet(proj.pendingFiles);
        for (const f of scanPending) {
          const key = getTrackedFileDedupKey(f);
          if (!existPendingKeys.has(key) && !existingKeys.has(key)) {
            proj.pendingFiles.push(f);
            existPendingKeys.add(key);
          }
        }
      }
      proj.files = deduplicateFiles(proj.files);
      for (const file of recoveredFilesForProvenance) {
        const storedFile = proj.files.find(f => f.path === file.path && f.source === file.source);
        if (!storedFile) continue;
        recordPrePackageRecoverySessionObservation(proj, storedFile);
      }
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
    const safeTrackedFileSummaries = summarizeTrackedFigmaFilesForLog(rawTrackedFiles);
    const safeTrackedFileKeys = normalizedTrackedFileKeys.map(key => formatFigmaLogScalar(key));

    if (teamIds.length > 0 || fileKeys.length > 0) {
      const { FigmaParser } = require('./parsers/figma');
      const parser = new FigmaParser();
      console.log(
        `[crate][figma] scan config (pre-package): ` +
        `trackedFileCount=${safeTrackedFileSummaries.length} ` +
        `trackedFiles=${JSON.stringify(safeTrackedFileSummaries)} ` +
        `trackedFileKeys=${JSON.stringify(safeTrackedFileKeys)} ` +
        `teamCount=${teamIds.length} ` +
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
        console.warn('[crate][figma] pre-package scan errors:', summarizeFigmaErrorsForLog(figmaScanResult.errors));
      }

      if (figmaScanResult.assets && figmaScanResult.assets.length > 0) {
        const scopedAssets = figmaScanResult.assets.map((asset) => ({
          ...asset,
          figmaScopeMode: getProjectFigmaScopeMode(latestProject)
        }));
        const figmaAdded = await ingestFigmaAssetsIntoProject(projectId, project, scopedAssets, 'pre-package');
        newCount += figmaAdded;
      }
    }
  } catch (e) {
    console.warn('[crate][figma] pre-package recovery failed:', redactFigmaLogText(e.message));
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

function safeEmbeddedMediaDisplayName(rawName, fallbackName) {
  return sanitizePackageFileName(path.basename(String(rawName || fallbackName || 'file')), fallbackName || 'file');
}

function formatEmbeddedMediaExtractionFailure(presentationPath, internalPath) {
  const mediaName = safeEmbeddedMediaDisplayName(getKeynoteArchiveEntryTail(internalPath) || internalPath, 'embedded media');
  const presentationName = safeEmbeddedMediaDisplayName(presentationPath, 'presentation');
  return `Could not extract embedded media ${mediaName} from ${presentationName}.`;
}

function formatEmbeddedMediaInspectionFailure(presentationPath) {
  const presentationName = safeEmbeddedMediaDisplayName(presentationPath, 'presentation');
  return `Could not inspect embedded media in ${presentationName}.`;
}

const KEYNOTE_SAFE_WILDCARD_TAIL = /^[A-Za-z0-9][A-Za-z0-9._ ()-]*\.[A-Za-z0-9]{2,5}$/;
const KEYNOTE_SAFE_WILDCARD_CHAR = /^[A-Za-z0-9._ ()-]$/;

function stripKeynoteNumericSuffix(name) {
  return String(name || '').replace(/-\d{3,6}(\.[a-z0-9]{2,5})$/i, '$1');
}

function hasEmbeddedMediaExtension(name) {
  return EMBEDDED_MEDIA_EXTENSIONS.has(path.extname(String(name || '')).toLowerCase());
}

function isSafeKeynoteWildcardTail(candidate) {
  if (!candidate || candidate.includes('/') || candidate.includes('\\')) return false;
  if (/[\x00-\x1f\x7f*?\[\]{}]/.test(candidate)) return false;
  if (!KEYNOTE_SAFE_WILDCARD_TAIL.test(candidate)) return false;
  return hasEmbeddedMediaExtension(candidate);
}

function isUsefulKeynoteOutputTail(tail) {
  const stripped = stripKeynoteNumericSuffix(tail);
  const stem = path.basename(stripped, path.extname(stripped)).trim();
  return stem.length >= 3;
}

function getKeynoteArchiveEntryTail(zipPath) {
  if (typeof zipPath !== 'string' || !zipPath.startsWith('Data/')) return null;

  const entryName = path.basename(zipPath).trim();
  if (!entryName) return null;
  if (!hasEmbeddedMediaExtension(entryName)) return null;

  let suffixStart = entryName.length;
  while (suffixStart > 0 && KEYNOTE_SAFE_WILDCARD_CHAR.test(entryName[suffixStart - 1])) {
    suffixStart -= 1;
  }

  const candidate = entryName.slice(suffixStart).trim();
  return isSafeKeynoteWildcardTail(candidate) ? candidate : null;
}

function getKeynoteArchiveEntryOutputTail(zipPath, wildcardTail = null) {
  if (typeof zipPath !== 'string' || !zipPath.startsWith('Data/')) return null;

  const entryName = path.basename(zipPath).trim();
  if (!entryName) return wildcardTail;

  const tail = wildcardTail || getKeynoteArchiveEntryTail(zipPath);
  if (tail && isUsefulKeynoteOutputTail(tail)) return tail;

  const displayName = entryName
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/[\x00-\x1f\x7f*?\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const safeDisplayName = safeEmbeddedMediaDisplayName(displayName, tail || 'embedded media');
  if (hasEmbeddedMediaExtension(safeDisplayName)) return safeDisplayName;
  return tail;
}

function getUniqueKeynoteWildcardFallback(zipPath, listedZipPaths) {
  const tail = getKeynoteArchiveEntryTail(zipPath);
  if (!tail) return null;

  const matches = (listedZipPaths || [])
    .filter(listedPath => typeof listedPath === 'string')
    .filter(listedPath => listedPath.startsWith('Data/'))
    .filter(listedPath => EMBEDDED_MEDIA_EXTENSIONS.has(path.extname(listedPath).toLowerCase()))
    .filter(listedPath => path.basename(listedPath).trim().endsWith(tail));
  if (matches.length !== 1) return null;

  return {
    tail,
    wildcardPath: `Data/*${tail}`,
  };
}

async function extractEmbeddedArchiveEntryData(presentationPath, zipPath, ext, listedZipPaths) {
  try {
    const { stdout: data } = await execFileAsync('/usr/bin/unzip', ['-p', presentationPath, zipPath], {
      timeout: 10000, maxBuffer: 50 * 1024 * 1024,
      encoding: 'buffer'
    });
    return { data, outputTail: ext === '.key' ? getKeynoteArchiveEntryOutputTail(zipPath) : null };
  } catch (exactError) {
    if (ext !== '.key') throw exactError;

    const fallback = getUniqueKeynoteWildcardFallback(zipPath, listedZipPaths);
    if (!fallback) throw exactError;

    const { stdout: data } = await execFileAsync('/usr/bin/unzip', ['-p', presentationPath, fallback.wildcardPath], {
      timeout: 10000, maxBuffer: 50 * 1024 * 1024,
      encoding: 'buffer'
    });
    return { data, outputTail: getKeynoteArchiveEntryOutputTail(zipPath, fallback.tail) || fallback.tail };
  }
}

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

async function extractEmbeddedMedia(presentationPath, destFolder, projectFiles, options = {}) {
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

    const listingLines = listing.split('\n');
    const listedZipPaths = listingLines
      .map(line => {
        const m = line.match(/^\s+(\d+)\s+(\d{2}-\d{2}-\d{4})\s+(\d{2}:\d{2})\s+(.+)$/);
        return m ? m[4].trim() : null;
      })
      .filter(Boolean);

    for (const line of listingLines) {
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
        const { data, outputTail } = await extractEmbeddedArchiveEntryData(presentationPath, zipPath, ext, listedZipPaths);

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
        let outputName = outputTail || path.basename(zipPath);
        if (ext === '.key') {
          outputName = outputName.replace(/-\d{3,6}(\.[a-z]+)$/i, '$1');
        }

        // Prefix with presentation name to avoid collisions with other files
        outputName = `${base} — ${outputName}`;

        const destPath = resolveUniquePackagePath(destFolder, outputName);
        fs.writeFileSync(destPath, data, { flag: 'wx' });
        extracted.push(destPath);
        if (typeof options.onExtracted === 'function') {
          try {
            options.onExtracted({
              presentationPath,
              internalPath: zipPath,
              materializedPath: destPath,
              source: options.source || 'package-extraction',
              observedAt: Date.now(),
            });
          } catch (provenanceErr) {
            console.warn('[crate][provenance] presentation media extraction callback skipped:', provenanceErr.message);
          }
        }
        console.log(`[crate] extracted embedded media: ${outputName} (date: ${m[2]})`);
      } catch (e) {
        const message = formatEmbeddedMediaExtractionFailure(presentationPath, zipPath);
        console.error(`[crate] ${message}`);
        if (typeof options.onExtractionError === 'function') {
          try {
            options.onExtractionError({
              presentationPath,
              internalPath: zipPath,
              message,
            });
          } catch (callbackErr) {
            console.warn('[crate] embedded media extraction error callback skipped');
          }
        }
      }
    }
  } catch (e) {
    const message = formatEmbeddedMediaInspectionFailure(presentationPath);
    console.error(`[crate] ${message}`);
    if (typeof options.onInspectionError === 'function') {
      try {
        options.onInspectionError({
          presentationPath,
          message,
        });
      } catch (callbackErr) {
        console.warn('[crate] embedded media inspection error callback skipped');
      }
    }
  }

  return extracted;
}

function resolveUniquePackagePath(destFolder, fileName) {
  return resolveSafeUniquePackagePath(destFolder, fileName, {
    fallbackName: 'file'
  });
}

function getPackageFileDisplayName(file) {
  const fallbackName = file && typeof file.path === 'string' ? path.basename(file.path) : 'file';
  return sanitizePackageFileName(file && file.name, fallbackName || 'file');
}

function packageSourceExists(sourcePath) {
  try {
    return typeof sourcePath === 'string' && !sourcePath.includes('\0') && fs.existsSync(sourcePath);
  } catch (e) {
    return false;
  }
}

function isSafePackageSourceFile(sourcePath) {
  try {
    assertSafeCopySource(sourcePath);
    return true;
  } catch (e) {
    return false;
  }
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
  if (!parentPsd || !packageSourceExists(parentPsd)) {
    throw new Error('Parent PSD not found');
  }
  assertSafeCopySource(parentPsd);

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

  await fs.promises.writeFile(finalPath, Buffer.from(linkedFile.data), { flag: 'wx' });
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
  const template = sanitizeNamingTemplate(settings.namingTemplate);
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];

  // Use the full project name as-is — no client/project splitting.
  // {Project} = the full name the user typed, cleaned for filesystem use.
  const folderName = template
    .replace('{Project}', cleanName(project.name))
    .replace('{Date}', dateStr);

  const destFolder = resolvePackageFolderInsideOutput(outputPath, folderName);

  try {
    let copiedCount = 0;
    const errors = [];
    const packageProvenanceEvents = [];
    const packageProvenanceInfo = {
      destFolder,
      createdAt: Date.now(),
    };

    for (const file of packageFiles) {
      const packageFileName = getPackageFileDisplayName(file);
      try {
        if (isScanOnSaveEmbeddedPsdFile(file)) {
          const safeName = sanitizeEmbeddedPsdAssetName(file.name || file.embeddedOriginalName);
          const finalPath = resolveUniquePackagePath(destFolder, safeName);
          await writeEmbeddedPsdAssetToPackage(file, finalPath);
          packageProvenanceEvents.push({
            relationType: EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE,
            file,
            outputPath: finalPath,
          });
          copiedCount++;
          continue;
        }

        if (packageSourceExists(file.path)) {
          const finalPath = copyFileIntoPackage(file.path, destFolder, packageFileName, {
            fallbackName: packageFileName
          });
          packageProvenanceEvents.push({
            relationType: EDGE_TYPES.PACKAGE_INCLUDES_FILE,
            file,
            outputPath: finalPath,
          });
          copiedCount++;
        } else {
          errors.push(`File not found: ${packageFileName}`);
        }
      } catch (err) {
        errors.push(`Failed to copy ${packageFileName}: ${err.message}`);
      }
    }

    // Extract embedded media from zip-based design files (.key, .pptx)
    // These formats embed images internally as zip entries — lsof can't catch
    // the sub-100ms reads when assets are dragged in, so we pull them at package time.
    let embeddedCount = 0;
    const presentationExtractionEvents = [];
    const ZIP_BASED_FORMATS = new Set(['.key', '.pptx', '.ppt']);

    // v1.3.37: When Keynote/PowerPoint re-saves, both old and new versions may
    // be tracked. Group by base filename and only extract from the newest (by mtime)
    // to avoid double-counting embedded media.
    const presentationsByName = new Map();
    for (const file of packageFiles) {
      const fileExt = path.extname(getPackageFileDisplayName(file)).toLowerCase();
      if (ZIP_BASED_FORMATS.has(fileExt) && isSafePackageSourceFile(file.path)) {
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
        const embeddedFiles = await extractEmbeddedMedia(file.path, destFolder, packageFiles, {
          source: 'package-extraction',
          onExtracted: (extraction) => {
            const resource = getPresentationMediaResourceIdentity(extraction.presentationPath, extraction.internalPath);
            if (!resource) return;
            presentationExtractionEvents.push(extraction);
            packageProvenanceEvents.push({
              relationType: EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE,
              resource: {
                resourceKey: resource.resourceKey,
                internalPath: resource.internalPath,
                name: resource.name,
                ext: resource.ext,
                presentationPath: extraction.presentationPath,
                materializedPath: extraction.materializedPath,
                source: extraction.source,
              },
              outputPath: extraction.materializedPath,
            });
          },
          onExtractionError: (failure) => {
            if (failure && failure.message) errors.push(failure.message);
          },
          onInspectionError: (failure) => {
            if (failure && failure.message) errors.push(failure.message);
          },
        });
        embeddedCount += embeddedFiles.length;
      } catch (embedErr) {
        // M7: Report embedded extraction errors so user sees 'X files packaged, Y errors'
        errors.push(`Could not inspect embedded media in ${getPackageFileDisplayName(file)}.`);
      }
    }

    recordPresentationMediaExtractionProvenance(id, presentationExtractionEvents);
    recordPackageProvenance(id, packageProvenanceInfo, packageProvenanceEvents);
    if (settings.includeDiagnosticReport === true) {
      writePackageProvenanceManifest(id, packageProvenanceInfo, {
        copiedCount,
        embeddedCount,
        totalFiles: packageFiles.length,
        errors,
      });
    }

    // Auto-stop watcher — SECURITY REQUIREMENT
    stopWatching(id);

    // FIX 1: Use mutateProject to atomically update project status
    mutateProject(id, (proj) => {
      proj.status = 'packaged';
      proj.packagedAt = Date.now();
      proj.outputPath = destFolder;
    });
    rememberGeneratedPackageOutputPath(destFolder);

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

    // Show the app window so user sees the success confirmation.
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
  // Show the app window after native dialog closes.
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
    rememberGeneratedPackageOutputPath(destFolder);
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
  const ALLOWED_SETTINGS = new Set(["namingTemplate", "notifications", "includeDiagnosticReport", "showPackageDetails"]);
  if (!ALLOWED_SETTINGS.has(key)) return store.get('settings');
  if (key === 'namingTemplate') {
    store.set(`settings.${key}`, sanitizeNamingTemplate(value));
    return store.get('settings');
  }
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

  createMainWindow();
  createTray();
  showMainWindow();

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

app.on('activate', () => {
  showMainWindow();
});

app.on('second-instance', () => {
  showMainWindow();
});

// Track intentional quit so we don't block Dock right-click → Quit
let isQuitting = false;

app.on('window-all-closed', (e) => {
  // Only prevent quit if it wasn't deliberately triggered (e.g. user closed
  // the app window). Dock "Quit" and app.quit() set isQuitting=true
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
  // Explicitly destroy tray + window so quit isn't blocked by live windows.
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }
  if (trayWindow && !trayWindow.isDestroyed()) {
    trayWindow.destroy();
    trayWindow = null;
  }
});
