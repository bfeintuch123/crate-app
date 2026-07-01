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
const { fileURLToPath } = require('url');
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

  // Pass 3: presentation scan-on-save collision dedup. PowerPoint can emit more
  // than one save/change pulse while Crate is still materializing the same
  // archive media, which leaves cache files like "Deck — image1.jpg" and
  // "Deck — image1_1.jpg". Keep one copy only when the normalized generated
  // media name and content fingerprint match.
  const seenPresentationMedia = new Set();
  const presentationDeduped = embeddedDeduped.filter(f => {
    if (f.source !== 'scan-on-save-presentation') return true;
    const fileName = path.basename(f.name || f.path || '');
    const ext = path.extname(fileName).toLowerCase();
    const base = path.basename(fileName, ext).replace(/_\d+$/i, '').toLowerCase();
    if (!base || !ext) return true;
    try {
      const buf = fs.readFileSync(f.path);
      const hash = crypto.createHash('md5').update(buf).digest('hex');
      const key = `${base}:${ext}:${buf.length}:${hash}`;
      if (seenPresentationMedia.has(key)) return false;
      seenPresentationMedia.add(key);
      return true;
    } catch (e) {
      return true;
    }
  });

  // Pass 4: Figma asset identity dedup — protects startup scans from adding the
  // same cloud asset more than once under different local filenames.
  const seenFigmaAssets = new Set();
  return presentationDeduped.filter(f => {
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
  UPDATE_PENDING: 'update_pending',
  IGNORE_EXCLUDED: 'ignore_excluded',
  IGNORE_DUPLICATE: 'ignore_duplicate',
  KEEP_EXISTING: 'keep_existing',
});

const LIVE_CAPTURE_STATES = Object.freeze({
  OBSERVED: 'observed',
  PENDING: 'pending',
  NEEDS_SAVE: 'needs-save',
  PACKAGE_READY: 'package-ready',
  IGNORED: 'ignored',
});

const LIVE_APP_OBSERVER_METHODS = Object.freeze({
  ILLUSTRATOR_ACTIVE_SESSION: 'illustrator-active-session',
  PHOTOSHOP_LIVE_SCRIPT: 'photoshop-live-script',
  INDESIGN_LIVE_APPLESCRIPT: 'indesign-live-applescript',
});

const LIVE_APP_EVIDENCE_STRENGTHS = Object.freeze({
  STRUCTURED_APP_DOCUMENT: 'structured-app-document',
  STRUCTURED_APP_LINK: 'structured-app-link',
  OPEN_MASTER: 'open-master',
  BROAD_APP_SIGNAL: 'broad-app-signal',
  SAVED_FILE_EVENT: 'saved-file-event',
  PARSER_CONFIRMED: 'parser-confirmed',
  PROJECT_SCOPED_CLOUD: 'project-scoped-cloud',
});

const MAX_LIVE_EVIDENCE_CANDIDATES = 500;
const MAX_LIVE_EVIDENCE_OBSERVATIONS_PER_CANDIDATE = 8;
const MAX_LIVE_APP_STATUS_BREADCRUMBS_PER_APP = 20;

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
  'app-opened',
]);

const WEAK_BROAD_OBSERVER_SOURCES = new Set([
  'lsof',
  'lastused-poll',
  'lastused-scan',
  'lsof-package-scan',
]);

const WEAK_BROAD_OBSERVER_REASONS = new Set([
  'lastused-broad-observer',
  'initial-lsof-snapshot',
  'stale-prewatch-opened',
  'pre-package-lsof-scan',
  'pre-package-lastused-scan',
  'pre-package-app-script-broad-observer',
]);

const EXPLICIT_USER_CAPTURE_SOURCES = new Set([
  'manual',
  'manual-browse',
]);

const STRONG_SESSION_LIVE_CAPTURE_REASONS = new Set([
  'chokidar-add',
  'chokidar-change',
  'figma-project-tracked-cloud',
]);

const SAVED_OR_CONFIRMED_CAPTURE_SOURCES = new Set([
  'scan-on-open',
  'psd-linked',
  'psd-embedded',
  'linked-asset',
  'scan-on-save-linked',
  'scan-on-save-embedded',
  'scan-on-save-psd',
  'scan-on-save-presentation',
  'pre-package-doublecheck',
  'figma-auto',
]);

const SAVED_OR_CONFIRMED_CAPTURE_REASONS = new Set([
  'scan-on-open-source-relationship',
  'scan-on-open-psd-parser',
  'scan-on-save-psd-parser',
  'scan-on-save-presentation',
  'pre-package-parser-regex',
  'pre-package-psd-parser',
  'figma-project-tracked-cloud',
]);

const LIVE_CAPTURE_STATE_RANK = Object.freeze({
  [LIVE_CAPTURE_STATES.IGNORED]: 0,
  [LIVE_CAPTURE_STATES.PENDING]: 1,
  [LIVE_CAPTURE_STATES.OBSERVED]: 2,
  [LIVE_CAPTURE_STATES.NEEDS_SAVE]: 3,
  [LIVE_CAPTURE_STATES.PACKAGE_READY]: 4,
});

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

function getFileCaptureSource(file) {
  if (!file || typeof file !== 'object') return null;
  return sanitizeLiveEvidenceText(file.source || (file.captureEvidence && file.captureEvidence.source));
}

function getFileCaptureReason(file) {
  if (!file || typeof file !== 'object') return null;
  return normalizeLiveCaptureReason(
    file.captureReason ||
    (file.captureEvidence && (file.captureEvidence.reason || file.captureEvidence.captureReason)) ||
    getFileCaptureSource(file) ||
    'unknown'
  );
}

function isWeakBroadObserverSource(source) {
  return !!(source && WEAK_BROAD_OBSERVER_SOURCES.has(source));
}

function isWeakBroadObserverReason(reason) {
  return !!(reason && WEAK_BROAD_OBSERVER_REASONS.has(reason));
}

function isWeakBroadObserverEvidence(evidence = {}) {
  const source = sanitizeLiveEvidenceText(evidence.source) || null;
  const policyReason = normalizeLiveCaptureReason(evidence.policyReason || evidence.displayReason || evidence.reason || source || 'unknown');
  return isWeakBroadObserverSource(source) || isWeakBroadObserverReason(policyReason);
}

function isWeakBroadObserverFile(file) {
  const source = getFileCaptureSource(file);
  const reason = getFileCaptureReason(file);
  if (isWeakBroadObserverSource(source) || isWeakBroadObserverReason(reason)) return true;
  const captureEvidence = file && file.captureEvidence;
  return !!(
    captureEvidence &&
    captureEvidence.evidenceStrength === LIVE_APP_EVIDENCE_STRENGTHS.BROAD_APP_SIGNAL &&
    (isWeakBroadObserverSource(captureEvidence.observerMethod) || isWeakBroadObserverReason(captureEvidence.reason))
  );
}

function hasAcceptedPendingProvenance(project, filePath) {
  const normalizedPath = normalizeTrackedFilePath(filePath);
  if (!project || !normalizedPath || !project.provenance || !Array.isArray(project.provenance.observations)) return false;
  const fileNodeId = createNodeId(NODE_TYPES.FILE, { normalizedPath });
  return project.provenance.observations.some(observation => (
    observation &&
    observation.objectNodeId === fileNodeId &&
    observation.observer &&
    observation.observer.method === 'projects:accept-pending' &&
    observation.observer.kind === OBSERVER_KINDS.MANUAL_USER_ACTION
  ));
}

function isAcceptedPendingCapturedFile(project, file) {
  return !!(file && file.acceptedPending === true) || hasAcceptedPendingProvenance(project, file && file.path);
}

function isExplicitUserCapturedFile(file) {
  return EXPLICIT_USER_CAPTURE_SOURCES.has(getFileCaptureSource(file));
}

function isSavedOrConfirmedProjectFile(file) {
  const source = getFileCaptureSource(file);
  const reason = getFileCaptureReason(file);
  const captureEvidence = file && file.captureEvidence;
  return !!(
    SAVED_OR_CONFIRMED_CAPTURE_SOURCES.has(source) ||
    SAVED_OR_CONFIRMED_CAPTURE_REASONS.has(reason) ||
    (captureEvidence && (
      captureEvidence.savedEvidence === true ||
      captureEvidence.parserConfirmed === true ||
      captureEvidence.filesystemSaved === true ||
      captureEvidence.projectScopedCloud === true
    ))
  );
}

function isCurrentSessionSavedSource(project, file) {
  if (!project || !file || typeof file.path !== 'string') return false;
  if (getFileCaptureSource(file)) return false;
  const ext = (file.ext || path.extname(file.path || '') || '').toLowerCase();
  if (!PRIMARY_DESIGN_EXTENSIONS.has(ext)) return false;
  const watchStart = project.watchStartedAt || project.createdAt || 0;
  const addedAt = typeof file.addedAt === 'number' ? file.addedAt : 0;
  return !!(watchStart && addedAt >= watchStart);
}

function isTrustedSessionProjectFile(project, file) {
  if (!file || typeof file.path !== 'string' || !file.path.trim()) return false;
  if (isAutoCaptureExcludedPath(file.path)) return false;
  if (isExplicitUserCapturedFile(file)) return true;
  if (isAcceptedPendingCapturedFile(project, file)) return true;
  if (isSavedOrConfirmedProjectFile(file)) return true;
  if (isCurrentSessionSavedSource(project, file)) return true;
  const captureEvidence = file.captureEvidence || {};
  return captureEvidence.evidenceStrength === LIVE_APP_EVIDENCE_STRENGTHS.STRUCTURED_APP_DOCUMENT &&
    PRIMARY_DESIGN_EXTENSIONS.has((file.ext || path.extname(file.path || '') || '').toLowerCase());
}

function isBroadRootSessionDir(dirPath) {
  if (typeof dirPath !== 'string' || !dirPath.trim()) return false;
  const home = os.homedir();
  const roots = [
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    path.join(home, 'Downloads'),
    path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Desktop'),
    path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Documents'),
    path.join(home, 'Library', 'Application Support', 'Figma'),
  ].map(root => path.resolve(root));
  const resolvedDir = path.resolve(dirPath);
  return roots.some(root => resolvedDir === root);
}

function getPrimaryDesignAppFamilyForExt(ext) {
  const normalizedExt = String(ext || '').toLowerCase();
  if (['.ai', '.eps', '.svg'].includes(normalizedExt)) return 'illustrator';
  if (['.psd', '.psb', '.pxd'].includes(normalizedExt)) return 'photoshop';
  if (['.indd', '.idml'].includes(normalizedExt)) return 'indesign';
  if (normalizedExt === '.fig') return 'figma';
  if (normalizedExt === '.sketch') return 'sketch';
  if (normalizedExt === '.xd') return 'adobe-xd';
  if (['.afdesign', '.afphoto', '.afpub'].includes(normalizedExt)) return 'affinity';
  if (normalizedExt === '.key') return 'keynote';
  if (['.pptx', '.ppt'].includes(normalizedExt)) return 'powerpoint';
  return null;
}

function buildProjectSessionScope(project) {
  const scope = {
    anchorPaths: new Set(),
    anchorDirs: [],
    sourceNameCounts: new Map(),
    primaryAppFamilies: new Set(),
  };
  const files = [
    ...((project && Array.isArray(project.files)) ? project.files : []),
    ...((project && Array.isArray(project.pendingFiles)) ? project.pendingFiles : []),
  ];

  for (const file of files) {
    if (!isTrustedSessionProjectFile(project, file)) continue;
    const normalizedPath = normalizeTrackedFilePath(file.path);
    if (!normalizedPath) continue;
    scope.anchorPaths.add(normalizedPath);

    const ext = (file.ext || path.extname(file.path || '') || '').toLowerCase();
    const isSourceLike = PRIMARY_DESIGN_EXTENSIONS.has(ext) || isExplicitUserCapturedFile(file);
    const fileName = path.basename(file.path).toLowerCase();
    scope.sourceNameCounts.set(fileName, (scope.sourceNameCounts.get(fileName) || 0) + 1);
    if (PRIMARY_DESIGN_EXTENSIONS.has(ext)) {
      const appFamily = getPrimaryDesignAppFamilyForExt(ext);
      if (appFamily) scope.primaryAppFamilies.add(appFamily);
    }
    if (isSourceLike) {
      const dir = path.dirname(file.path);
      if (!isBroadRootSessionDir(dir)) scope.anchorDirs.push(dir);
    }
  }

  return scope;
}

function isRelationshipSourceSessionTrusted(project, sourcePath) {
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) return false;
  const normalizedSourcePath = normalizeTrackedFilePath(sourcePath);
  if (!normalizedSourcePath) return false;
  const files = [
    ...((project && Array.isArray(project.files)) ? project.files : []),
    ...((project && Array.isArray(project.pendingFiles)) ? project.pendingFiles : []),
  ];
  return files.some(file => (
    normalizeTrackedFilePath(file && file.path) === normalizedSourcePath &&
    isTrustedSessionProjectFile(project, file)
  ));
}

function isWeakBroadEvidenceSessionRelated(project, fileEntry, evidence = {}) {
  if (!project || !fileEntry || typeof fileEntry.path !== 'string') return false;
  if (evidence.explicitUserAdd || evidence.acceptedPending || isSavedOrConfirmedLiveEvidence(evidence)) return true;
  if (evidence.relationshipSourcePath && isRelationshipSourceSessionTrusted(project, evidence.relationshipSourcePath)) return true;
  if (evidence.sourceDocumentPath && isRelationshipSourceSessionTrusted(project, evidence.sourceDocumentPath)) return true;

  const normalizedPath = normalizeTrackedFilePath(fileEntry.path);
  const scope = buildProjectSessionScope(project);
  if (normalizedPath && scope.anchorPaths.has(normalizedPath)) return true;

  if (evidence.sourceDocumentName) {
    const sourceName = String(evidence.sourceDocumentName).toLowerCase();
    if (scope.sourceNameCounts.get(sourceName) === 1) return true;
  }

  const candidateExt = (fileEntry.ext || path.extname(fileEntry.path || '') || '').toLowerCase();
  const candidateFamily = getPrimaryDesignAppFamilyForExt(candidateExt);
  if (
    PRIMARY_DESIGN_EXTENSIONS.has(candidateExt) &&
    candidateFamily &&
    scope.primaryAppFamilies.size > 0 &&
    !scope.primaryAppFamilies.has(candidateFamily)
  ) {
    return false;
  }

  return scope.anchorDirs.some(anchorDir => isPathInsideOrEqual(anchorDir, fileEntry.path));
}

function isBroadObserverOnlyAcceptedFile(project, file) {
  if (!isWeakBroadObserverFile(file)) return false;
  if (isExplicitUserCapturedFile(file)) return false;
  if (isAcceptedPendingCapturedFile(project, file)) return false;
  if (isSavedOrConfirmedProjectFile(file)) return false;
  if (isCurrentSessionSavedSource(project, file)) return false;
  return true;
}

function shouldKeepPendingFileForSession(project, file) {
  if (!file || typeof file.path !== 'string' || !file.path.trim()) return false;
  if (isAutoCaptureExcludedPath(file.path)) return false;
  if (!isWeakBroadObserverFile(file)) return true;
  return isWeakBroadEvidenceSessionRelated(project, file, {
    source: getFileCaptureSource(file),
    policyReason: getFileCaptureReason(file),
    evidenceStrength: LIVE_APP_EVIDENCE_STRENGTHS.BROAD_APP_SIGNAL,
    broadObserver: true,
  });
}

function demoteBroadObserverFileForReview(file) {
  const source = getFileCaptureSource(file) || 'broad-observer';
  const captureState = LIVE_CAPTURE_STATES.PENDING;
  const reason = 'broad-observer-needs-review';
  return {
    ...file,
    captureState,
    captureReason: reason,
    captureEvidence: {
      schemaVersion: 1,
      source,
      reason,
      state: captureState,
      evidenceStrength: LIVE_APP_EVIDENCE_STRENGTHS.BROAD_APP_SIGNAL,
      captureRecommendation: captureState,
      needsSave: false,
      designerReason: getDesignerReasonForLiveEvidence({ captureState }),
    },
  };
}

function cleanupBroadObserverProjectState(project) {
  if (!project || !Array.isArray(project.files)) return false;
  let changed = false;
  const keptFiles = [];
  const demotedPending = [];

  for (const file of project.files) {
    if (!isBroadObserverOnlyAcceptedFile(project, file)) {
      keptFiles.push(file);
      continue;
    }

    changed = true;
    if (isWeakBroadEvidenceSessionRelated(project, file, {
      source: getFileCaptureSource(file),
      policyReason: getFileCaptureReason(file),
      evidenceStrength: LIVE_APP_EVIDENCE_STRENGTHS.BROAD_APP_SIGNAL,
      broadObserver: true,
    })) {
      demotedPending.push(demoteBroadObserverFileForReview(file));
    }
  }

  if (changed) {
    project.files = keptFiles;
    if (!Array.isArray(project.pendingFiles)) project.pendingFiles = [];
    project.pendingFiles.push(...demotedPending);
  }
  return changed;
}

function normalizeAutoCaptureProjectState(project) {
  if (!project || typeof project !== 'object') return false;
  let changed = false;

  if (!Array.isArray(project.files)) {
    project.files = [];
    changed = true;
  } else {
    const beforeLength = project.files.length;
    if (pruneExcludedAutoCapturedFiles(project)) changed = true;
    if (cleanupBroadObserverProjectState(project)) changed = true;
    project.files = deduplicateFiles(project.files);
    if (project.files.length !== beforeLength) changed = true;
  }

  if (!Array.isArray(project.pendingFiles)) {
    project.pendingFiles = [];
    changed = true;
  } else {
    const beforeLength = project.pendingFiles.length;
    const acceptedKeys = getTrackedFileKeySet(project.files);
    const seenPendingKeys = new Set();
    const seenWeakBroadPendingNames = new Set();
    project.pendingFiles = project.pendingFiles.filter(file => {
      const key = getTrackedFileDedupKey(file);
      if (!key || acceptedKeys.has(key) || seenPendingKeys.has(key)) return false;
      if (!shouldKeepPendingFileForSession(project, file)) return false;
      if (isWeakBroadObserverFile(file)) {
        const nameKey = `${getFileCaptureSource(file) || 'broad'}:${path.basename(file.path || file.name || '').toLowerCase()}`;
        if (seenWeakBroadPendingNames.has(nameKey)) return false;
        seenWeakBroadPendingNames.add(nameKey);
      }
      seenPendingKeys.add(key);
      return true;
    });
    if (project.pendingFiles.length !== beforeLength) changed = true;
  }

  pruneLiveEvidenceLedger(project);
  return changed;
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

function normalizeLiveCaptureReason(reason, fallback = 'observed-during-session') {
  const safe = String(reason || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return safe || fallback;
}

function normalizeLiveCaptureState(captureState, fallback = LIVE_CAPTURE_STATES.PENDING) {
  return Object.values(LIVE_CAPTURE_STATES).includes(captureState)
    ? captureState
    : fallback;
}

function getLiveCaptureStateRank(captureState) {
  return LIVE_CAPTURE_STATE_RANK[captureState] || 0;
}

function getLiveEvidenceKeyHash(evidenceKey) {
  if (typeof evidenceKey !== 'string' || !evidenceKey.trim()) return null;
  return crypto.createHash('sha256').update(evidenceKey).digest('hex').slice(0, 24);
}

function sanitizeLiveEvidenceText(value) {
  if (typeof value !== 'string') return null;
  const safe = value.trim();
  return safe ? safe.slice(0, 120) : null;
}

function getLiveAppDisplayName(appFamily) {
  const normalized = normalizeLiveCaptureReason(appFamily, 'app');
  const displayNames = {
    illustrator: 'Illustrator',
    photoshop: 'Photoshop',
    indesign: 'InDesign',
    figma: 'Figma',
    powerpoint: 'PowerPoint',
    keynote: 'Keynote',
  };
  return displayNames[normalized] || normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function getDesignerReasonForLiveEvidence({ appFamily, evidenceStrength, captureState } = {}) {
  const appName = appFamily ? getLiveAppDisplayName(appFamily) : 'the active app';
  if (captureState === LIVE_CAPTURE_STATES.NEEDS_SAVE) {
    if (evidenceStrength === LIVE_APP_EVIDENCE_STRENGTHS.STRUCTURED_APP_LINK) {
      return `Linked asset observed in ${appName}. Save to make package-ready.`;
    }
    return `Observed in ${appName}. Save to make package-ready.`;
  }
  if (captureState === LIVE_CAPTURE_STATES.OBSERVED) {
    return `Opened during this session in ${appName}.`;
  }
  if (captureState === LIVE_CAPTURE_STATES.PACKAGE_READY) {
    return 'Ready to package after saved-file evidence.';
  }
  if (captureState === LIVE_CAPTURE_STATES.IGNORED) {
    return 'Ignored because it is outside this package session.';
  }
  return 'Waiting for review.';
}

// Apps and filesystem watchers provide facts. This policy layer derives the
// capture decision; future AI review can consume the compact summaries here
// without ever seeing raw lsof/ps/mdls/AppleScript/JXA output.
function createLiveAppEvidence(input = {}) {
  const filePath = typeof input.filePath === 'string' ? input.filePath.trim() : '';
  if (!filePath || !path.isAbsolute(filePath)) return null;

  const appFamily = normalizeLiveCaptureReason(input.appFamily, 'app');
  const sourceDocumentPath = typeof input.sourceDocumentPath === 'string' && path.isAbsolute(input.sourceDocumentPath)
    ? input.sourceDocumentPath
    : null;
  const relationshipSourcePath = typeof input.relationshipSourcePath === 'string' && path.isAbsolute(input.relationshipSourcePath)
    ? input.relationshipSourcePath
    : null;
  const sourceDocumentName = sanitizeLiveEvidenceText(input.sourceDocumentName)
    || (relationshipSourcePath ? path.basename(relationshipSourcePath) : null)
    || (sourceDocumentPath ? path.basename(sourceDocumentPath) : null);

  const evidence = {
    appFamily,
    source: sanitizeLiveEvidenceText(input.source) || 'app-opened',
    observerMethod: sanitizeLiveEvidenceText(input.observerMethod) || 'live-app',
    observedAt: new Date().toISOString(),
    projectId: sanitizeLiveEvidenceText(input.projectId) || null,
    filePath,
    sourceDocumentName,
    sourceDocumentPath,
    relationshipSourcePath,
    documentModified: typeof input.documentModified === 'boolean' ? input.documentModified : null,
    evidenceStrength: sanitizeLiveEvidenceText(input.evidenceStrength) || LIVE_APP_EVIDENCE_STRENGTHS.BROAD_APP_SIGNAL,
    evidenceReason: normalizeLiveCaptureReason(input.evidenceReason || input.captureReason, 'app-live-evidence'),
    requiresSave: input.requiresSave === true || input.documentModified === true,
    savedEvidence: input.savedEvidence === true || input.filesystemSaved === true,
    filesystemSaved: input.filesystemSaved === true,
    parserConfirmed: input.parserConfirmed === true,
    allowDirect: input.allowDirect === true,
    forcePending: input.forcePending === true ? true : (input.forcePending === false ? false : null),
  };

  if (input.captureRecommendation || input.captureHint) {
    evidence.captureHint = normalizeLiveCaptureState(input.captureHint || input.captureRecommendation, LIVE_CAPTURE_STATES.PENDING);
  }
  return evidence;
}

function getSafeLiveAppUnavailableReason(error) {
  const directReason = normalizeLiveCaptureReason(error && error.message, '');
  if (
    directReason === 'automation-permission-denied' ||
    directReason === 'automation-not-authorized' ||
    directReason === 'missing-usage-description' ||
    directReason === 'illustrator-query-timeout' ||
    directReason === 'no-documents'
  ) {
    return directReason === 'automation-not-authorized' ? 'automation-permission-denied' : directReason;
  }

  const rawText = [
    error && error.code,
    error && error.message,
    error && error.stderr,
    error && error.stdout,
  ].filter(Boolean).join(' ').toLowerCase();

  if (!rawText) return 'illustrator-query-failed';
  if (rawText.includes('nsappleeventsusagedescription') || rawText.includes('usage description')) {
    return 'missing-usage-description';
  }
  if (
    rawText.includes('-1712') ||
    rawText.includes('timed out') ||
    rawText.includes('timeout')
  ) {
    return 'illustrator-query-timeout';
  }
  if (
    rawText.includes('file path of pitem') ||
    (rawText.includes('placed item') && rawText.includes('file path'))
  ) {
    return 'illustrator-placed-item-path-query-failed';
  }
  if (
    rawText.includes('-1743') ||
    rawText.includes('not authorized') ||
    rawText.includes('not authorised') ||
    rawText.includes('not permitted') ||
    rawText.includes('operation not permitted') ||
    rawText.includes('apple event') ||
    rawText.includes('appleevent') ||
    rawText.includes('automation') ||
    rawText.includes('tcc') ||
    rawText.includes('privacy')
  ) {
    return 'automation-permission-denied';
  }
  return 'illustrator-query-failed';
}

function getLiveAppUnavailableGuidance(reason) {
  if (reason === 'automation-permission-denied') {
    return ' Open System Settings > Privacy & Security > Automation and allow Crate to control Adobe Illustrator.';
  }
  if (reason === 'missing-usage-description') {
    return ' Crate needs an Apple Events usage description in the app bundle before macOS can authorize Automation.';
  }
  return '';
}

function logLiveAppEvidenceUnavailable(appLabel, error) {
  const reason = getSafeLiveAppUnavailableReason(error);
  const guidance = getLiveAppUnavailableGuidance(reason);
  console.warn(`[crate][live-app] ${appLabel} evidence unavailable. script-success=false reason=${reason}. Check Automation permissions if this persists.${guidance}`);
}

function logLiveAppDiagnostic(projectId, key, message, intervalMs = LIVE_APP_DIAGNOSTIC_LOG_INTERVAL_MS) {
  const safeKey = `${projectId || 'unknown'}:${sanitizeLiveEvidenceText(key) || 'event'}`;
  const now = Date.now();
  const lastLoggedAt = liveAppDiagnosticLogTimestamps.get(safeKey) || 0;
  if (now - lastLoggedAt < intervalMs) return;
  liveAppDiagnosticLogTimestamps.set(safeKey, now);
  console.log(`[crate][live-app] ${redactFigmaLogText(message)}`);
}

const SAFE_LIVE_APP_STATUS_ERROR_CATEGORIES = new Set([
  'app-not-running',
  'project-not-watching',
  'script-not-attempted',
  'script-success',
  'script-timeout',
  'automation-permission-denied',
  'missing-usage-description',
  'empty-output',
  'parse-empty',
  'no-documents',
  'unknown-script-error',
  'illustrator-query-failed',
  'illustrator-query-timeout',
  'illustrator-document-query-failed',
  'illustrator-placed-items-query-failed',
  'illustrator-placed-item-file-query-failed',
  'illustrator-placed-item-file-of-query-failed',
  'illustrator-placed-item-file-path-object-query-failed',
  'illustrator-placed-item-file-path-text-query-failed',
  'illustrator-placed-item-file-path-alias-query-failed',
  'illustrator-placed-item-file-fallback-used',
  'illustrator-placed-item-file-fallback-failed',
  'illustrator-placed-item-path-fallback-used',
  'illustrator-placed-item-file-path-text-fallback-used',
  'illustrator-placed-item-file-path-alias-fallback-used',
  'illustrator-placed-item-path-query-failed',
]);

function normalizeLiveAppStatusErrorCategory(value, fallback = null) {
  const normalized = normalizeLiveAppStatusCode(value, '');
  if (!normalized) return fallback;
  if (normalized === 'automation-not-authorized') return 'automation-permission-denied';
  if (normalized === 'illustrator-query-timeout') return 'script-timeout';
  if (SAFE_LIVE_APP_STATUS_ERROR_CATEGORIES.has(normalized)) return normalized;
  return fallback;
}

function sanitizeLiveAppStatusCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count < 0) return 0;
  return Math.min(Math.floor(count), 100000);
}

function sanitizeLiveAppStatusCounts(counts) {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return {};
  const sanitized = {};
  for (const [rawReason, rawCount] of Object.entries(counts)) {
    const reason = normalizeLiveCaptureReason(rawReason, '');
    if (!reason) continue;
    sanitized[reason] = sanitizeLiveAppStatusCount(rawCount);
  }
  return sanitized;
}

function countLiveAppStatusReasons(reasons) {
  const counts = {};
  for (const reason of Array.isArray(reasons) ? reasons : []) {
    const normalized = normalizeLiveAppStatusCode(reason, '');
    if (!normalized) continue;
    counts[normalized] = (counts[normalized] || 0) + 1;
  }
  return counts;
}

function mergeLiveAppStatusCounts(...countSets) {
  const merged = {};
  for (const counts of countSets) {
    const sanitized = sanitizeLiveAppStatusCounts(counts);
    for (const [reason, count] of Object.entries(sanitized)) {
      merged[reason] = (merged[reason] || 0) + count;
    }
  }
  return merged;
}

function setLiveAppStatusBoolean(entry, key, value) {
  if (typeof value === 'boolean') entry[key] = value;
}

function buildLiveAppStatusBreadcrumb(appFamily, input = {}) {
  const entry = {
    appFamily: normalizeLiveCaptureReason(appFamily, 'live-app'),
    observedAt: new Date().toISOString(),
  };
  for (const key of [
    'pollInstalled',
    'pollFired',
    'projectWatching',
    'appRunning',
    'scriptAttempted',
    'scriptSuccess',
  ]) {
    setLiveAppStatusBoolean(entry, key, input[key]);
  }
  for (const key of ['docsCount', 'linksCount', 'placedItemsCount', 'normalizedCount', 'stagedCount']) {
    if (input[key] !== undefined) entry[key] = sanitizeLiveAppStatusCount(input[key]);
  }
  const skipReasonCounts = sanitizeLiveAppStatusCounts(input.skipReasonCounts);
  if (Object.keys(skipReasonCounts).length > 0) entry.skipReasonCounts = skipReasonCounts;
  const statusReasonCounts = sanitizeLiveAppStatusCounts(input.statusReasonCounts);
  if (Object.keys(statusReasonCounts).length > 0) entry.statusReasonCounts = statusReasonCounts;
  const errorCategory = normalizeLiveAppStatusErrorCategory(input.errorCategory, null);
  if (errorCategory) entry.errorCategory = errorCategory;
  return entry;
}

function recordLiveAppStatusBreadcrumb(projectId, appFamily, input = {}) {
  const safeAppFamily = normalizeLiveCaptureReason(appFamily, 'live-app');
  const entry = buildLiveAppStatusBreadcrumb(safeAppFamily, input);
  mutateProject(projectId, (project) => {
    if (!project || typeof project !== 'object') return null;
    if (!project.liveAppEvidenceStatus || typeof project.liveAppEvidenceStatus !== 'object' || Array.isArray(project.liveAppEvidenceStatus)) {
      project.liveAppEvidenceStatus = {
        schemaVersion: 1,
        entryLimit: MAX_LIVE_APP_STATUS_BREADCRUMBS_PER_APP,
        apps: {},
      };
    }
    if (!project.liveAppEvidenceStatus.apps || typeof project.liveAppEvidenceStatus.apps !== 'object' || Array.isArray(project.liveAppEvidenceStatus.apps)) {
      project.liveAppEvidenceStatus.apps = {};
    }
    const appStatus = project.liveAppEvidenceStatus.apps[safeAppFamily] || {
      entries: [],
    };
    appStatus.entries = [...(Array.isArray(appStatus.entries) ? appStatus.entries : []), entry]
      .slice(-MAX_LIVE_APP_STATUS_BREADCRUMBS_PER_APP);
    appStatus.latest = entry;
    appStatus.lastUpdatedAt = entry.observedAt;
    project.liveAppEvidenceStatus.apps[safeAppFamily] = appStatus;
    project.liveAppEvidenceStatus.schemaVersion = 1;
    project.liveAppEvidenceStatus.entryLimit = MAX_LIVE_APP_STATUS_BREADCRUMBS_PER_APP;
    return { liveAppEvidenceStatus: project.liveAppEvidenceStatus };
  });
  return entry;
}

function incrementLiveAppSkipCount(skipCounts, reason) {
  if (!skipCounts || typeof skipCounts !== 'object') return;
  const safeReason = normalizeLiveCaptureReason(reason, 'skipped');
  skipCounts[safeReason] = (skipCounts[safeReason] || 0) + 1;
}

function formatLiveAppSkipCounts(skipCounts) {
  return Object.entries(skipCounts || {})
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, count]) => `${reason}:${count}`)
    .join(',');
}

function getLiveCaptureAppFamily(fileEntry, observation = {}) {
  if (typeof observation.appFamily === 'string' && observation.appFamily.trim()) {
    return normalizeLiveCaptureReason(observation.appFamily, 'app');
  }

  const ext = (fileEntry && (fileEntry.ext || path.extname(fileEntry.path || '')) || '').toLowerCase();
  const source = fileEntry && fileEntry.source;
  if (source === 'ai-linked') return 'illustrator';
  if (source === 'ps-poll' || source === 'psd-linked' || source === 'psd-embedded') return 'photoshop';
  if (source === 'indd-poll' || source === 'indd-linked') return 'indesign';
  if (source === 'figma-auto' || source === 'fig-scan' || (ext === '.fig' && source === 'lsof-package-scan')) return 'figma';
  if (ext === '.pptx' || ext === '.ppt' || ext === '.pptm') return 'powerpoint';
  if (ext === '.key' || ext === '.keynote') return 'keynote';
  return null;
}

function deriveLiveEvidenceStrength(fileEntry, evidence) {
  if (evidence && typeof evidence.evidenceStrength === 'string' && evidence.evidenceStrength.trim()) {
    return evidence.evidenceStrength;
  }
  const source = fileEntry && fileEntry.source;
  if (source === 'figma-auto') return LIVE_APP_EVIDENCE_STRENGTHS.PROJECT_SCOPED_CLOUD;
  if (SAVED_OR_CONFIRMED_CAPTURE_SOURCES.has(source)) return LIVE_APP_EVIDENCE_STRENGTHS.PARSER_CONFIRMED;
  if (source === 'app-opened') return LIVE_APP_EVIDENCE_STRENGTHS.STRUCTURED_APP_DOCUMENT;
  if (['ai-linked', 'ps-poll', 'indd-poll', 'indd-linked'].includes(source)) {
    return LIVE_APP_EVIDENCE_STRENGTHS.STRUCTURED_APP_LINK;
  }
  if (source === 'lsof' || source === 'lastused-poll' || source === 'lastused-scan' || source === 'lsof-package-scan') {
    return LIVE_APP_EVIDENCE_STRENGTHS.BROAD_APP_SIGNAL;
  }
  return LIVE_APP_EVIDENCE_STRENGTHS.BROAD_APP_SIGNAL;
}

function normalizeLiveEvidence(project, fileEntry, observation = {}, normalizedPath = '') {
  const liveEvidence = observation.liveEvidence && typeof observation.liveEvidence === 'object'
    ? observation.liveEvidence
    : {};
  const source = sanitizeLiveEvidenceText(liveEvidence.source || fileEntry.source) || 'unknown';
  const policyReason = normalizeLiveCaptureReason(
    observation.reason || liveEvidence.evidenceReason || liveEvidence.captureReason || source,
    'observed-during-session'
  );
  const displayReason = normalizeLiveCaptureReason(
    observation.captureReason || liveEvidence.captureReason || policyReason,
    policyReason
  );
  const relationshipSourcePath = typeof observation.relationshipSourcePath === 'string' && path.isAbsolute(observation.relationshipSourcePath)
    ? observation.relationshipSourcePath
    : (typeof liveEvidence.relationshipSourcePath === 'string' && path.isAbsolute(liveEvidence.relationshipSourcePath)
      ? liveEvidence.relationshipSourcePath
      : null);
  const sourceDocumentPath = typeof liveEvidence.sourceDocumentPath === 'string' && path.isAbsolute(liveEvidence.sourceDocumentPath)
    ? liveEvidence.sourceDocumentPath
    : relationshipSourcePath;
  const appFamily = sanitizeLiveEvidenceText(liveEvidence.appFamily)
    || getLiveCaptureAppFamily(fileEntry, observation)
    || null;
  const evidence = {
    schemaVersion: 1,
    projectId: project && project.id ? String(project.id) : null,
    watchStartedAt: project && (project.watchStartedAt || project.createdAt) || null,
    observedAt: sanitizeLiveEvidenceText(liveEvidence.observedAt) || new Date().toISOString(),
    candidateName: fileEntry && fileEntry.path ? path.basename(fileEntry.path) : null,
    candidateExt: (fileEntry && (fileEntry.ext || path.extname(fileEntry.path || '')) || '').toLowerCase(),
    source,
    observerMethod: sanitizeLiveEvidenceText(liveEvidence.observerMethod || observation.observerMethod || source) || source,
    appFamily,
    sourceDocumentName: sanitizeLiveEvidenceText(liveEvidence.sourceDocumentName)
      || (sourceDocumentPath ? path.basename(sourceDocumentPath) : null),
    sourceDocumentPath,
    relationshipSourcePath,
    policyReason,
    displayReason,
    documentModified: typeof liveEvidence.documentModified === 'boolean'
      ? liveEvidence.documentModified
      : (typeof observation.documentModified === 'boolean' ? observation.documentModified : null),
    forcePending: observation.forcePending === true,
    allowDirect: observation.allowDirect === true,
    explicitUserAdd: observation.explicitUserAdd === true,
    acceptedPending: observation.acceptedPending === true,
    captureHint: normalizeLiveCaptureState(liveEvidence.captureHint || observation.captureState, null),
  };

  evidence.evidenceStrength = deriveLiveEvidenceStrength(fileEntry, liveEvidence);
  evidence.broadObserver = evidence.forcePending || BROAD_LIVE_CAPTURE_SOURCES.has(source);
  evidence.weakBroadObserver = isWeakBroadObserverEvidence(evidence);
  evidence.parserConfirmed = observation.parserConfirmed === true
    || liveEvidence.parserConfirmed === true
    || SAVED_OR_CONFIRMED_CAPTURE_SOURCES.has(source)
    || SAVED_OR_CONFIRMED_CAPTURE_REASONS.has(policyReason);
  evidence.filesystemSaved = observation.filesystemSaved === true
    || liveEvidence.filesystemSaved === true
    || (evidence.allowDirect && STRONG_SESSION_LIVE_CAPTURE_REASONS.has(policyReason));
  evidence.projectScopedCloud = source === 'figma-auto' && policyReason === 'figma-project-tracked-cloud';
  evidence.savedEvidence = observation.savedEvidence === true
    || liveEvidence.savedEvidence === true
    || evidence.parserConfirmed
    || evidence.filesystemSaved
    || evidence.projectScopedCloud;
  evidence.relationshipAccepted = relationshipSourcePath
    ? isAcceptedProjectFilePath(project, relationshipSourcePath)
    : false;
  evidence.requiresSave = liveEvidence.requiresSave === true
    || observation.requiresSave === true
    || evidence.documentModified === true
    || (
      !!relationshipSourcePath &&
      !evidence.savedEvidence
    );
  evidence.evidenceKey = normalizedPath || normalizeTrackedFilePath(fileEntry && fileEntry.path);
  evidence.evidenceKeyHash = getLiveEvidenceKeyHash(evidence.evidenceKey);
  evidence.sessionRelated = !evidence.weakBroadObserver || isWeakBroadEvidenceSessionRelated(project, fileEntry, evidence);
  return evidence;
}

function isSavedOrConfirmedLiveEvidence(evidence) {
  return !!(evidence && (
    evidence.explicitUserAdd ||
    evidence.acceptedPending ||
    evidence.savedEvidence ||
    evidence.parserConfirmed ||
    evidence.filesystemSaved ||
    evidence.projectScopedCloud
  ));
}

function shouldDirectAddLiveEvidence(project, fileEntry, evidence) {
  if (!evidence) return false;
  if (evidence.explicitUserAdd || evidence.acceptedPending) return true;
  if (evidence.forcePending || (evidence.broadObserver && !isSavedOrConfirmedLiveEvidence(evidence))) return false;
  if (
    evidence.evidenceStrength === LIVE_APP_EVIDENCE_STRENGTHS.STRUCTURED_APP_DOCUMENT &&
    isSavedOrConfirmedLiveEvidence(evidence) &&
    evidence.documentModified !== true
  ) {
    return true;
  }
  if (evidence.allowDirect && STRONG_SESSION_LIVE_CAPTURE_REASONS.has(evidence.policyReason)) return true;
  if (evidence.relationshipSourcePath) {
    return evidence.relationshipAccepted && isSavedOrConfirmedLiveEvidence(evidence) && evidence.documentModified !== true;
  }
  return false;
}

function decideLiveCaptureState(project, fileEntry, evidence, directEligible) {
  if (directEligible) return LIVE_CAPTURE_STATES.PACKAGE_READY;
  if (!evidence) return LIVE_CAPTURE_STATES.PENDING;
  if (evidence.documentModified === true || evidence.requiresSave === true) {
    return LIVE_CAPTURE_STATES.NEEDS_SAVE;
  }
  if (evidence.source === 'app-opened' || evidence.evidenceStrength === LIVE_APP_EVIDENCE_STRENGTHS.OPEN_MASTER) {
    return LIVE_CAPTURE_STATES.OBSERVED;
  }
  if (evidence.source === 'lsof' && PRIMARY_DESIGN_EXTENSIONS.has(evidence.candidateExt) && evidence.policyReason !== 'initial-lsof-snapshot') {
    return LIVE_CAPTURE_STATES.OBSERVED;
  }
  if (isSavedOrConfirmedLiveEvidence(evidence) && !evidence.broadObserver) {
    return LIVE_CAPTURE_STATES.PACKAGE_READY;
  }
  return LIVE_CAPTURE_STATES.PENDING;
}

function getLiveCaptureReasonFromDecision(evidence, captureState) {
  if (!evidence) return 'observed-during-session';
  if (captureState === LIVE_CAPTURE_STATES.PACKAGE_READY) {
    if (evidence.parserConfirmed) return evidence.policyReason || 'parser-confirmed-relationship';
    if (evidence.filesystemSaved) return evidence.policyReason || 'saved-file-observed';
    return evidence.policyReason || 'package-ready';
  }
  if (captureState === LIVE_CAPTURE_STATES.NEEDS_SAVE) {
    if (evidence.documentModified === true && evidence.evidenceStrength === LIVE_APP_EVIDENCE_STRENGTHS.STRUCTURED_APP_DOCUMENT) {
      return 'unsaved-source-needs-save';
    }
    if (evidence.relationshipSourcePath || evidence.evidenceStrength === LIVE_APP_EVIDENCE_STRENGTHS.STRUCTURED_APP_LINK) {
      return 'linked-asset-observed';
    }
    return evidence.displayReason || 'needs-save';
  }
  if (captureState === LIVE_CAPTURE_STATES.OBSERVED) {
    if (evidence.policyReason === 'opened-after-watch' || evidence.source === 'lsof' || evidence.source === 'app-opened') {
      return 'opened-after-watch';
    }
    return evidence.displayReason || 'observed-during-session';
  }
  return evidence.displayReason || evidence.policyReason || 'observed-during-session';
}

function getPrivacySafeLiveEvidenceSummary(evidence, captureState, reason) {
  if (!evidence || typeof evidence !== 'object') return null;
  const keepCandidateIdentity = captureState !== LIVE_CAPTURE_STATES.IGNORED;
  const summary = {
    schemaVersion: 1,
    evidenceKey: evidence.evidenceKeyHash || null,
    candidateExt: evidence.candidateExt || null,
    source: evidence.source || null,
    observerMethod: evidence.observerMethod || null,
    evidenceStrength: evidence.evidenceStrength || LIVE_APP_EVIDENCE_STRENGTHS.BROAD_APP_SIGNAL,
    captureRecommendation: captureState,
    reason,
    needsSave: captureState === LIVE_CAPTURE_STATES.NEEDS_SAVE,
    designerReason: getDesignerReasonForLiveEvidence({
      appFamily: evidence.appFamily,
      evidenceStrength: evidence.evidenceStrength,
      captureState,
    }),
    observedAt: evidence.observedAt || null,
  };
  if (keepCandidateIdentity && evidence.candidateName) summary.candidateName = evidence.candidateName;
  if (evidence.appFamily) summary.appFamily = evidence.appFamily;
  if (keepCandidateIdentity && evidence.sourceDocumentName) {
    summary.sourceDocumentName = evidence.sourceDocumentName;
    summary.sourceName = evidence.sourceDocumentName;
  }
  if (evidence.relationshipSourcePath) summary.relationship = 'source-linked';
  if (typeof evidence.documentModified === 'boolean') summary.documentModified = evidence.documentModified;
  if (evidence.savedEvidence) summary.savedEvidence = true;
  if (evidence.parserConfirmed) summary.parserConfirmed = true;
  if (evidence.filesystemSaved) summary.filesystemSaved = true;
  if (evidence.projectScopedCloud) summary.projectScopedCloud = true;
  if (evidence.captureHint && evidence.captureHint !== captureState) summary.ignoredCaptureHint = evidence.captureHint;
  if (evidence.weakBroadObserver && captureState === LIVE_CAPTURE_STATES.IGNORED) summary.quarantined = true;
  return summary;
}

function getLiveEvidenceProtectedKeys(project, extraKey = null) {
  const keys = new Set();
  if (typeof extraKey === 'string' && extraKey.trim()) keys.add(extraKey);
  for (const file of [
    ...((project && Array.isArray(project.files)) ? project.files : []),
    ...((project && Array.isArray(project.pendingFiles)) ? project.pendingFiles : []),
  ]) {
    const normalizedPath = normalizeTrackedFilePath(file && file.path);
    const key = getLiveEvidenceKeyHash(normalizedPath);
    if (key) keys.add(key);
  }
  return keys;
}

function getLiveEvidenceUpdatedAtMs(entry) {
  const candidates = [
    entry && entry.updatedAt,
    entry && entry.latest && entry.latest.observedAt,
    entry && entry.firstObservedAt,
  ];
  for (const value of candidates) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

function getLiveEvidencePrunePriority(entry, key, protectedKeys) {
  const state = normalizeLiveCaptureState(
    entry && (entry.strongestState || (entry.latest && entry.latest.captureRecommendation)),
    LIVE_CAPTURE_STATES.IGNORED
  );
  if (protectedKeys.has(key) || (entry && protectedKeys.has(entry.evidenceKey))) {
    return 100 + getLiveCaptureStateRank(state);
  }
  if (state === LIVE_CAPTURE_STATES.IGNORED) return 0;
  if (
    state === LIVE_CAPTURE_STATES.OBSERVED &&
    entry &&
    entry.latest &&
    entry.latest.evidenceStrength === LIVE_APP_EVIDENCE_STRENGTHS.BROAD_APP_SIGNAL
  ) {
    return 1;
  }
  if (state === LIVE_CAPTURE_STATES.OBSERVED) return 2;
  return 10 + getLiveCaptureStateRank(state);
}

function minimizeIgnoredLiveEvidenceLedgerEntry(entry) {
  if (!entry || typeof entry !== 'object' || !entry.latest || typeof entry.latest !== 'object') return;
  const state = normalizeLiveCaptureState(
    entry.strongestState || entry.latest.captureRecommendation,
    LIVE_CAPTURE_STATES.IGNORED
  );
  if (state !== LIVE_CAPTURE_STATES.IGNORED) return;
  delete entry.latest.candidateName;
  delete entry.latest.sourceDocumentName;
  delete entry.latest.sourceName;
}

function pruneLiveEvidenceLedger(project, extraProtectedKey = null) {
  if (!project || !project.liveEvidenceLedger || typeof project.liveEvidenceLedger !== 'object') return;
  if (Array.isArray(project.liveEvidenceLedger)) return;
  const ledger = project.liveEvidenceLedger;
  if (!ledger.candidates || typeof ledger.candidates !== 'object' || Array.isArray(ledger.candidates)) {
    ledger.candidates = {};
    ledger.schemaVersion = 1;
    return;
  }

  const entries = Object.entries(ledger.candidates);
  for (const [, entry] of entries) {
    minimizeIgnoredLiveEvidenceLedgerEntry(entry);
  }
  if (entries.length <= MAX_LIVE_EVIDENCE_CANDIDATES) {
    ledger.candidateLimit = MAX_LIVE_EVIDENCE_CANDIDATES;
    return;
  }

  const protectedKeys = getLiveEvidenceProtectedKeys(project, extraProtectedKey);
  const evictable = entries
    .map(([key, entry]) => ({
      key,
      entry,
      priority: getLiveEvidencePrunePriority(entry, key, protectedKeys),
      updatedAtMs: getLiveEvidenceUpdatedAtMs(entry),
    }))
    .sort((a, b) => (
      a.priority - b.priority ||
      a.updatedAtMs - b.updatedAtMs ||
      a.key.localeCompare(b.key)
    ));

  const removeCount = entries.length - MAX_LIVE_EVIDENCE_CANDIDATES;
  for (const item of evictable.slice(0, removeCount)) {
    delete ledger.candidates[item.key];
  }
  ledger.schemaVersion = 1;
  ledger.candidateLimit = MAX_LIVE_EVIDENCE_CANDIDATES;
  ledger.prunedAt = new Date().toISOString();
}

function getLiveEvidenceLedger(project) {
  if (!project || typeof project !== 'object') return null;
  if (!project.liveEvidenceLedger || typeof project.liveEvidenceLedger !== 'object' || Array.isArray(project.liveEvidenceLedger)) {
    project.liveEvidenceLedger = {
      schemaVersion: 1,
      candidates: {},
    };
  }
  if (!project.liveEvidenceLedger.candidates || typeof project.liveEvidenceLedger.candidates !== 'object') {
    project.liveEvidenceLedger.candidates = {};
  }
  project.liveEvidenceLedger.candidateLimit = MAX_LIVE_EVIDENCE_CANDIDATES;
  return project.liveEvidenceLedger;
}

function recordLiveEvidence(project, fileEntry, classification) {
  if (!classification || !classification.evidence || !classification.evidenceSummary) return;
  const ledger = getLiveEvidenceLedger(project);
  if (!ledger) return;
  const summary = classification.evidenceSummary;
  const key = summary.evidenceKey || classification.evidence.evidenceKeyHash;
  if (!key) return;
  const existing = ledger.candidates[key] || {
    evidenceKey: key,
    firstObservedAt: summary.observedAt || new Date().toISOString(),
    strongestState: LIVE_CAPTURE_STATES.IGNORED,
    observations: [],
  };
  const currentRank = getLiveCaptureStateRank(existing.strongestState);
  const nextRank = getLiveCaptureStateRank(summary.captureRecommendation);
  existing.strongestState = nextRank >= currentRank ? summary.captureRecommendation : existing.strongestState;
  existing.latest = summary;
  existing.updatedAt = summary.observedAt || new Date().toISOString();
  const observerRecord = {
    observerMethod: summary.observerMethod || null,
    evidenceStrength: summary.evidenceStrength || null,
    captureState: summary.captureRecommendation,
    reason: summary.reason,
    observedAt: summary.observedAt || null,
  };
  const observerKey = JSON.stringify(observerRecord);
  const seen = new Set((existing.observations || []).map(item => JSON.stringify(item)));
  if (!seen.has(observerKey)) {
    existing.observations = [...(existing.observations || []), observerRecord]
      .slice(-MAX_LIVE_EVIDENCE_OBSERVATIONS_PER_CANDIDATE);
  }
  ledger.candidates[key] = existing;
  ledger.updatedAt = existing.updatedAt;
  pruneLiveEvidenceLedger(project, key);
}

function shouldUpdatePendingCandidate(existingFile, classification) {
  if (!existingFile || !classification) return false;
  const existingState = normalizeLiveCaptureState(existingFile.captureState, LIVE_CAPTURE_STATES.PENDING);
  const nextState = normalizeLiveCaptureState(classification.captureState, LIVE_CAPTURE_STATES.PENDING);
  if (getLiveCaptureStateRank(nextState) > getLiveCaptureStateRank(existingState)) return true;
  const existingMethod = existingFile.captureEvidence && existingFile.captureEvidence.observerMethod;
  const nextMethod = classification.evidenceSummary && classification.evidenceSummary.observerMethod;
  return !!(nextMethod && nextMethod !== existingMethod && getLiveCaptureStateRank(nextState) === getLiveCaptureStateRank(existingState));
}

function decorateLiveObservedFile(fileEntry, classification, observation = {}) {
  const captureState = normalizeLiveCaptureState(classification.captureState, LIVE_CAPTURE_STATES.PENDING);
  const reason = normalizeLiveCaptureReason(classification.captureReason || classification.reason);
  const appFamily = classification.evidence && classification.evidence.appFamily
    ? classification.evidence.appFamily
    : getLiveCaptureAppFamily(fileEntry, observation);
  const sourceName = typeof observation.relationshipSourcePath === 'string' && observation.relationshipSourcePath.trim()
    ? path.basename(observation.relationshipSourcePath)
    : null;

  const captureEvidence = {
    reason,
    state: captureState,
    source: fileEntry.source || null,
    needsSave: captureState === LIVE_CAPTURE_STATES.NEEDS_SAVE,
  };
  if (appFamily) captureEvidence.appFamily = appFamily;
  if (sourceName) captureEvidence.sourceName = sourceName;
  if (observation.relationshipSourcePath) captureEvidence.relationship = 'source-linked';
  if (classification.evidenceSummary) {
    Object.assign(captureEvidence, classification.evidenceSummary);
  }

  return {
    ...fileEntry,
    captureState,
    captureReason: reason,
    captureEvidence,
  };
}

function stripLiveCaptureMetadata(fileEntry) {
  if (!fileEntry || typeof fileEntry !== 'object') return fileEntry;
  const {
    captureState,
    captureReason,
    captureEvidence,
    ...cleanFileEntry
  } = fileEntry;
  return cleanFileEntry;
}

function classifyLiveObservedFile(project, fileEntry, observation = {}) {
  const normalizedPath = normalizeTrackedFilePath(fileEntry && fileEntry.path);
  if (!project || !fileEntry || !normalizedPath) {
    const evidence = normalizeLiveEvidence(project, fileEntry || {}, observation, normalizedPath);
    const reason = 'invalid-path';
    return {
      decision: LIVE_CAPTURE_DECISIONS.IGNORE_EXCLUDED,
      reason,
      captureReason: reason,
      captureState: LIVE_CAPTURE_STATES.IGNORED,
      normalizedPath,
      evidence,
      evidenceSummary: getPrivacySafeLiveEvidenceSummary(evidence, LIVE_CAPTURE_STATES.IGNORED, reason),
    };
  }

  const evidence = normalizeLiveEvidence(project, fileEntry, observation, normalizedPath);
  if (isAutoCaptureExcludedPath(fileEntry.path)) {
    const reason = 'crate-output-path';
    return {
      decision: LIVE_CAPTURE_DECISIONS.IGNORE_EXCLUDED,
      reason,
      captureReason: reason,
      captureState: LIVE_CAPTURE_STATES.IGNORED,
      normalizedPath,
      evidence,
      evidenceSummary: getPrivacySafeLiveEvidenceSummary(evidence, LIVE_CAPTURE_STATES.IGNORED, reason),
    };
  }

  const candidateKey = getTrackedFileDedupKey(fileEntry);
  const acceptedKeys = getTrackedFileKeySet(project.files);
  const pendingKeys = getTrackedFileKeySet(project.pendingFiles);

  if (
    evidence.weakBroadObserver &&
    evidence.sessionRelated !== true &&
    !acceptedKeys.has(candidateKey) &&
    !pendingKeys.has(candidateKey)
  ) {
    const reason = 'broad-observer-outside-session';
    return {
      decision: LIVE_CAPTURE_DECISIONS.IGNORE_EXCLUDED,
      reason,
      captureReason: reason,
      captureState: LIVE_CAPTURE_STATES.IGNORED,
      normalizedPath,
      evidence,
      evidenceSummary: getPrivacySafeLiveEvidenceSummary(evidence, LIVE_CAPTURE_STATES.IGNORED, reason),
    };
  }

  const directEligible = shouldDirectAddLiveEvidence(project, fileEntry, evidence);
  const captureState = decideLiveCaptureState(project, fileEntry, evidence, directEligible);
  const reason = getLiveCaptureReasonFromDecision(evidence, captureState);
  const evidenceSummary = getPrivacySafeLiveEvidenceSummary(evidence, captureState, reason);

  if (acceptedKeys.has(candidateKey)) {
    const acceptedCaptureState = captureState === LIVE_CAPTURE_STATES.NEEDS_SAVE
      ? LIVE_CAPTURE_STATES.NEEDS_SAVE
      : LIVE_CAPTURE_STATES.PACKAGE_READY;
    const acceptedReason = acceptedCaptureState === LIVE_CAPTURE_STATES.NEEDS_SAVE
      ? reason
      : 'already-accepted';
    return {
      decision: LIVE_CAPTURE_DECISIONS.KEEP_EXISTING,
      reason: acceptedReason,
      captureReason: acceptedReason,
      captureState: acceptedCaptureState,
      normalizedPath,
      evidence,
      evidenceSummary: getPrivacySafeLiveEvidenceSummary(evidence, acceptedCaptureState, acceptedReason),
    };
  }

  if (pendingKeys.has(candidateKey)) {
    if (directEligible) {
      return {
        decision: LIVE_CAPTURE_DECISIONS.DIRECT_ADD,
        reason,
        captureReason: reason,
        captureState: LIVE_CAPTURE_STATES.PACKAGE_READY,
        normalizedPath,
        evidence,
        evidenceSummary,
      };
    }
    const pendingFile = (project.pendingFiles || []).find(file => getTrackedFileDedupKey(file) === candidateKey);
    return {
      decision: shouldUpdatePendingCandidate(pendingFile, { captureState, evidenceSummary })
        ? LIVE_CAPTURE_DECISIONS.UPDATE_PENDING
        : LIVE_CAPTURE_DECISIONS.KEEP_EXISTING,
      reason: 'already-pending',
      captureReason: reason,
      captureState,
      normalizedPath,
      evidence,
      evidenceSummary,
    };
  }

  return {
    decision: directEligible ? LIVE_CAPTURE_DECISIONS.DIRECT_ADD : LIVE_CAPTURE_DECISIONS.PENDING_CANDIDATE,
    reason,
    captureReason: reason,
    captureState,
    normalizedPath,
    evidence,
    evidenceSummary,
  };
}

function stageLiveObservedFile(project, fileEntry, observation = {}) {
  const classification = classifyLiveObservedFile(project, fileEntry, observation);
  const normalizedPath = classification.normalizedPath;
  recordLiveEvidence(project, fileEntry, classification);

  if (classification.decision === LIVE_CAPTURE_DECISIONS.DIRECT_ADD) {
    const stagedFile = stripLiveCaptureMetadata(fileEntry);
    if (!Array.isArray(project.pendingFiles)) project.pendingFiles = [];
    const candidateKey = getTrackedFileDedupKey(stagedFile);
    project.pendingFiles = project.pendingFiles.filter(file => (
      getTrackedFileDedupKey(file) !== candidateKey &&
      normalizeTrackedFilePath(file && file.path) !== normalizedPath
    ));
    project.files.push(stagedFile);
    project.files = deduplicateFiles(project.files);
    return { ...classification, changed: true, file: stagedFile };
  }

  if (classification.decision === LIVE_CAPTURE_DECISIONS.UPDATE_PENDING) {
    if (!Array.isArray(project.pendingFiles)) project.pendingFiles = [];
    const candidateKey = getTrackedFileDedupKey(fileEntry);
    const idx = project.pendingFiles.findIndex(file => (
      getTrackedFileDedupKey(file) === candidateKey ||
      normalizeTrackedFilePath(file && file.path) === normalizedPath
    ));
    if (idx === -1) return { ...classification, changed: false, file: fileEntry };
    const nextFile = decorateLiveObservedFile({
      ...project.pendingFiles[idx],
      source: fileEntry.source || project.pendingFiles[idx].source,
      ext: fileEntry.ext || project.pendingFiles[idx].ext,
      name: fileEntry.name || project.pendingFiles[idx].name,
    }, classification, observation);
    project.pendingFiles[idx] = nextFile;
    return { ...classification, changed: true, file: nextFile };
  }

  if (classification.decision === LIVE_CAPTURE_DECISIONS.PENDING_CANDIDATE) {
    const stagedFile = decorateLiveObservedFile(fileEntry, classification, observation);
    if (!Array.isArray(project.pendingFiles)) project.pendingFiles = [];
    project.pendingFiles.push(stagedFile);
    return { ...classification, changed: true, file: stagedFile };
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

  const normalizeCandidateKeyDetails = (primaryKey, url = null, rawCandidateKeys = [], rawCandidateDetails = []) => {
    const details = [];
    const seen = new Set();
    const pushKey = (value, source = 'unknown') => {
      if (typeof value !== 'string' || !value.trim()) return;
      const trimmed = value.trim();
      if (seen.has(trimmed)) return;
      seen.add(trimmed);
      details.push({
        key: trimmed,
        source: formatFigmaLogScalar(source, 'unknown')
      });
    };

    const urlCandidateDetails = url ? FigmaParser._figmaFileKeyCandidateDetails(url) : [];
    const urlSourceByKey = new Map(urlCandidateDetails.map(candidate => [candidate.key, candidate.source]));
    pushKey(primaryKey, urlSourceByKey.get(primaryKey) || 'primary');
    if (url) {
      for (const candidate of urlCandidateDetails) {
        pushKey(candidate.key, candidate.source);
      }
    }
    for (const candidate of Array.isArray(rawCandidateKeys) ? rawCandidateKeys : []) {
      pushKey(candidate, urlSourceByKey.get(candidate) || 'stored-candidate');
    }
    for (const candidate of Array.isArray(rawCandidateDetails) ? rawCandidateDetails : []) {
      if (!candidate || typeof candidate !== 'object') continue;
      pushKey(candidate.key, candidate.source || urlSourceByKey.get(candidate.key) || 'stored-candidate');
    }
    return details;
  };

  return (Array.isArray(rawTrackedFiles) ? rawTrackedFiles : [])
    .map((entry) => {
      if (typeof entry === 'string') {
        const trimmed = entry.trim();
        if (!trimmed) return null;
        const parsedKey = FigmaParser.extractFileKey(trimmed);
        const candidateKeyDetails = normalizeCandidateKeyDetails(parsedKey || trimmed, parsedKey ? trimmed : null);
        const candidateKeys = candidateKeyDetails.map(candidate => candidate.key);
        return {
          key: parsedKey || trimmed,
          url: parsedKey ? trimmed : null,
          candidateKeys,
          candidateKeyDetails,
        };
      }

      if (!entry || typeof entry !== 'object') return null;
      const key = typeof entry.key === 'string' ? entry.key.trim() : '';
      if (!key) return null;
      const url = typeof entry.url === 'string' && entry.url.trim() ? entry.url.trim() : null;
      const candidateKeyDetails = normalizeCandidateKeyDetails(key, url, entry.candidateKeys, entry.candidateKeyDetails);
      const candidateKeys = candidateKeyDetails.map(candidate => candidate.key);
      return { key, url, candidateKeys, candidateKeyDetails };
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
      let statusReason = null;

      if (scopeMode === FIGMA_SCOPE_CURRENT_PAGE) {
        if (!trackedFile.url) {
          lockStatus = 'unresolved';
          statusReason = 'figma-current-page-no-url-snapshot';
          warning = 'Current Page Only could not be locked because this session does not have a page-linked Figma URL snapshot. No Figma assets will be captured for this file in this session.';
        } else if (!parsedScope.requestedPageId && !parsedScope.requestedNodeId) {
          lockStatus = 'unresolved';
          statusReason = 'figma-current-page-no-page-or-node-param';
          warning = 'Current Page Only could not find a page or node in the tracked Figma URL. No Figma assets will be captured for this file in this session.';
        } else if (parsedScope.requestedPageId) {
          lockStatus = 'locked';
          lockedPageId = parsedScope.requestedPageId;
        } else if (parsedScope.requestedNodeId) {
          statusReason = 'figma-current-page-node-param-parsed';
        }
      }

      return {
        key: trackedFile.key,
        url: trackedFile.url,
        candidateKeys: trackedFile.candidateKeys,
        candidateKeyDetails: trackedFile.candidateKeyDetails,
        requestedPageId: parsedScope.requestedPageId || null,
        requestedNodeId: parsedScope.requestedNodeId || null,
        lockStatus,
        lockedPageId,
        lockedPageName: null,
        scopeMode,
        statusReason,
        warning,
      };
    }),
    sessionWarnings,
  };

  snapshot.warnings = rebuildFigmaSessionWarnings(snapshot);
  return snapshot;
}

function figmaTrackedFileKeys(trackedFile) {
  return figmaTrackedFileKeyDetails(trackedFile).map(candidate => candidate.key);
}

function figmaTrackedFileKeyDetails(trackedFile) {
  const keys = [];
  const seen = new Set();
  const pushKey = (value, source = 'unknown') => {
    if (typeof value !== 'string' || !value.trim()) return;
    const trimmed = value.trim();
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    keys.push({
      key: trimmed,
      source: formatFigmaLogScalar(source, 'unknown')
    });
  };
  const sourceByKey = new Map(
    (Array.isArray(trackedFile && trackedFile.candidateKeyDetails) ? trackedFile.candidateKeyDetails : [])
      .filter(candidate => candidate && typeof candidate.key === 'string' && candidate.key.trim())
      .map(candidate => [candidate.key.trim(), formatFigmaLogScalar(candidate.source, 'unknown')])
  );
  pushKey(trackedFile && trackedFile.key, sourceByKey.get(trackedFile && trackedFile.key) || 'primary');
  for (const candidate of Array.isArray(trackedFile && trackedFile.candidateKeys) ? trackedFile.candidateKeys : []) {
    pushKey(candidate, sourceByKey.get(candidate) || 'stored-candidate');
  }
  for (const candidate of Array.isArray(trackedFile && trackedFile.candidateKeyDetails) ? trackedFile.candidateKeyDetails : []) {
    if (!candidate || typeof candidate !== 'object') continue;
    pushKey(candidate.key, candidate.source);
  }
  if (typeof (trackedFile && trackedFile.resolvedKey) === 'string') {
    pushKey(trackedFile.resolvedKey, sourceByKey.get(trackedFile.resolvedKey) || 'resolved');
  }
  return keys;
}

function figmaTrackedFileMatchesKey(trackedFile, fileKey) {
  if (typeof fileKey !== 'string' || !fileKey.trim()) return false;
  return figmaTrackedFileKeys(trackedFile).includes(fileKey.trim());
}

function expandFigmaTrackedFilesForScan(rawTrackedFiles) {
  const expanded = [];
  const seen = new Set();
  for (const trackedFile of Array.isArray(rawTrackedFiles) ? rawTrackedFiles : []) {
    const candidateDetails = figmaTrackedFileKeyDetails(trackedFile);
    const candidateKeys = candidateDetails.map(candidate => candidate.key);
    for (const candidate of candidateDetails) {
      const key = candidate.key;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      expanded.push({
        ...trackedFile,
        key,
        primaryKey: trackedFile.key,
        candidateKeys,
        candidateSource: candidate.source,
        isCandidateFallback: key !== trackedFile.key,
      });
    }
  }
  return expanded;
}

function figmaScopeRank(scope) {
  if (!scope || typeof scope !== 'object') return 0;
  if (scope.lockStatus === 'locked') return 4;
  if (scope.lockStatus === 'entire-file') return 3;
  if (scope.lockStatus === 'pending') return 2;
  if (scope.lockStatus === 'unresolved') return 1;
  return 0;
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
      const candidateScopes = figmaTrackedFileKeys(trackedFile)
        .map(key => scopeByKey.get(key))
        .filter(Boolean);
      const nextScope = candidateScopes.sort((a, b) => figmaScopeRank(b) - figmaScopeRank(a))[0];
      if (!nextScope) continue;

      const nextLockStatus = typeof nextScope.lockStatus === 'string' ? nextScope.lockStatus : trackedFile.lockStatus;
      const nextLockedPageId = nextScope.lockedPageId != null ? nextScope.lockedPageId : trackedFile.lockedPageId;
      const nextLockedPageName = nextScope.lockedPageName != null ? nextScope.lockedPageName : trackedFile.lockedPageName;
      const nextStatusReason = nextScope.statusReason != null ? nextScope.statusReason : trackedFile.statusReason;
      const nextWarning = nextScope.warning != null ? nextScope.warning : trackedFile.warning;
      const nextResolvedKey = typeof nextScope.fileKey === 'string' && nextScope.fileKey.trim()
        ? nextScope.fileKey.trim()
        : trackedFile.resolvedKey;

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
      if (trackedFile.statusReason !== nextStatusReason) {
        trackedFile.statusReason = nextStatusReason;
        changed = true;
      }
      if (trackedFile.warning !== nextWarning) {
        trackedFile.warning = nextWarning;
        changed = true;
      }
      if (trackedFile.resolvedKey !== nextResolvedKey) {
        trackedFile.resolvedKey = nextResolvedKey;
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

  const trackedFile = session.trackedFiles.find(entry => figmaTrackedFileMatchesKey(entry, file.figmaFileKey));
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
    .replace(/\b\d+:\d+\b/g, '[redacted-figma-scope-id]')
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
    candidateCount: figmaTrackedFileKeys(entry).length,
    candidateSourceCounts: figmaTrackedFileKeyDetails(entry).reduce((acc, candidate) => {
      const source = formatFigmaLogScalar(candidate && candidate.source, 'unknown');
      acc[source] = (acc[source] || 0) + 1;
      return acc;
    }, {}),
    hasRequestedScope: !!(entry && (entry.requestedPageId || entry.requestedNodeId)),
    hasLockedPage: !!(entry && entry.lockedPageId),
    statusReason: formatFigmaLogScalar(entry && entry.statusReason, 'none'),
    hasWarning: !!(entry && entry.warning),
  }));
}

function summarizeFigmaErrorsForLog(errors) {
  return (Array.isArray(errors) ? errors : [errors])
    .filter(error => error !== undefined && error !== null)
    .map(error => redactFigmaLogText(error));
}

function summarizeFigmaCandidateDiagnosticsForLog(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object') return null;
  const safeCounts = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.entries(value).reduce((acc, [key, count]) => {
      const safeKey = formatFigmaLogScalar(key, 'unknown');
      acc[safeKey] = Number.isFinite(count) ? count : 0;
      return acc;
    }, {});
  };
  return {
    candidateCount: Number.isFinite(diagnostics.candidateCount) ? diagnostics.candidateCount : 0,
    candidateStrategyCounts: safeCounts(diagnostics.candidateStrategyCounts),
    candidateSourceCounts: safeCounts(diagnostics.candidateSourceCounts),
    parsedScopeCounts: {
      withPageOrNode: Number.isFinite(diagnostics.parsedScopeCounts && diagnostics.parsedScopeCounts.withPageOrNode)
        ? diagnostics.parsedScopeCounts.withPageOrNode
        : 0,
      withoutPageOrNode: Number.isFinite(diagnostics.parsedScopeCounts && diagnostics.parsedScopeCounts.withoutPageOrNode)
        ? diagnostics.parsedScopeCounts.withoutPageOrNode
        : 0
    },
    metadataStatusCounts: safeCounts(diagnostics.metadataStatusCounts),
    metadataFailureReasonCounts: safeCounts(diagnostics.metadataFailureReasonCounts),
    fileFetchStatusCounts: safeCounts(diagnostics.fileFetchStatusCounts),
    fileFetchFailureReasonCounts: safeCounts(diagnostics.fileFetchFailureReasonCounts),
    lockStatusCounts: safeCounts(diagnostics.lockStatusCounts),
    statusReasonCounts: safeCounts(diagnostics.statusReasonCounts),
    assetResultCounts: {
      withAssets: Number.isFinite(diagnostics.assetResultCounts && diagnostics.assetResultCounts.withAssets)
        ? diagnostics.assetResultCounts.withAssets
        : 0,
      withoutAssets: Number.isFinite(diagnostics.assetResultCounts && diagnostics.assetResultCounts.withoutAssets)
        ? diagnostics.assetResultCounts.withoutAssets
        : 0
    }
  };
}

function hasFigmaRateLimitDiagnostic(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object') return false;
  const metadataReasons = diagnostics.metadataFailureReasonCounts || {};
  const fileFetchReasons = diagnostics.fileFetchFailureReasonCounts || {};
  return Number(metadataReasons['rate-limited'] || 0) > 0 ||
    Number(fileFetchReasons['rate-limited'] || 0) > 0;
}

function figmaRateLimitWarning() {
  return 'Figma is temporarily rate limiting this scan. Crate will retry after a cooldown; no Figma assets will be captured for this file in this session until Figma allows the request.';
}

function setFigmaRateLimitBackoff(projectId) {
  const retryAt = Date.now() + FIGMA_RATE_LIMIT_BACKOFF_MS;
  figmaRateLimitBackoffs.set(projectId, retryAt);
  return retryAt;
}

function clearFigmaRateLimitBackoff(projectId) {
  figmaRateLimitBackoffs.delete(projectId);
}

function getFigmaTrackingProjects() {
  return getProjects().filter(project =>
    project &&
    project.status === 'watching' &&
    projectHasFigmaTrackedFiles(project)
  );
}

function getActiveFigmaPollerProjectCount() {
  const activeProjectIds = new Set([
    ...figmaPollers.keys(),
    ...figmaPollerStarting,
    ...figmaInProgress,
    ...figmaManualScanInFlight,
  ]);
  return activeProjectIds.size;
}

function updateFigmaSessionRateLimitWarning(projectId) {
  return mutateProject(projectId, (project) => {
    if (!project.figmaSession || !Array.isArray(project.figmaSession.trackedFiles)) return null;
    let changed = false;
    const warning = figmaRateLimitWarning();
    for (const trackedFile of project.figmaSession.trackedFiles) {
      if (trackedFile.lockStatus !== 'unresolved') {
        trackedFile.lockStatus = 'unresolved';
        changed = true;
      }
      if (trackedFile.statusReason !== 'figma-current-page-rate-limited') {
        trackedFile.statusReason = 'figma-current-page-rate-limited';
        changed = true;
      }
      if (trackedFile.warning !== warning) {
        trackedFile.warning = warning;
        changed = true;
      }
    }
    if (!changed) return null;
    project.figmaSession.warnings = rebuildFigmaSessionWarnings(project.figmaSession);
    return { figmaSession: project.figmaSession };
  });
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

function isPackagePrimarySourceMaster(file) {
  if (!file || file.embedded || typeof file.path !== 'string') return false;
  const ext = (file.ext || path.extname(file.path || '') || '').toLowerCase();
  return PRIMARY_DESIGN_EXTENSIONS.has(ext);
}

function getPackageSourceMasterCollisionKey(file) {
  if (!isPackagePrimarySourceMaster(file)) return null;
  const displayName = getPackageFileDisplayName(file);
  return typeof displayName === 'string' && displayName.trim()
    ? displayName.trim().toLowerCase()
    : null;
}

function getPackageSourceMasterStat(file) {
  try {
    const stat = fs.statSync(file.path);
    return {
      mtimeMs: stat.mtimeMs || 0,
      birthtimeMs: stat.birthtimeMs || 0,
    };
  } catch (_) {
    return { mtimeMs: 0, birthtimeMs: 0 };
  }
}

function getPackageSourceMasterDedupePriority(project, file) {
  let priority = 0;
  const source = getFileCaptureSource(file);
  const evidence = file && file.captureEvidence;

  if (isAcceptedPendingCapturedFile(project, file)) priority += 80;
  if (isSavedOrConfirmedProjectFile(file)) priority += 70;
  if (isCurrentSessionSavedSource(project, file)) priority += 60;
  if (evidence && evidence.evidenceStrength === LIVE_APP_EVIDENCE_STRENGTHS.STRUCTURED_APP_DOCUMENT) {
    priority += 55;
  }
  if (source === 'lsof') priority += 20;
  if (isWeakBroadObserverFile(file)) priority -= 25;
  if (file && typeof file.path === 'string' && isAutoCaptureExcludedPath(file.path)) priority -= 100;

  return priority;
}

function comparePackageSourceMasterDedupeCandidates(left, right) {
  if (left.priority !== right.priority) return right.priority - left.priority;
  if (left.stat.mtimeMs !== right.stat.mtimeMs) return right.stat.mtimeMs - left.stat.mtimeMs;
  if (left.stat.birthtimeMs !== right.stat.birthtimeMs) return right.stat.birthtimeMs - left.stat.birthtimeMs;
  if (left.addedAt !== right.addedAt) return right.addedAt - left.addedAt;
  return left.index - right.index;
}

function deduplicatePackageSourceMastersForOutput(project, packageFiles) {
  const byOutputName = new Map();

  packageFiles.forEach((file, index) => {
    const key = getPackageSourceMasterCollisionKey(file);
    if (!key) return;
    if (!byOutputName.has(key)) byOutputName.set(key, []);
    byOutputName.get(key).push({ file, index });
  });

  const droppedIndexes = new Set();

  for (const entries of byOutputName.values()) {
    if (entries.length < 2) continue;

    const explicitEntries = entries.filter(entry => isExplicitUserCapturedFile(entry.file));
    if (explicitEntries.length === entries.length) continue;

    const keepIndexes = new Set();
    if (explicitEntries.length > 0) {
      for (const entry of explicitEntries) keepIndexes.add(entry.index);
    } else {
      const [bestEntry] = entries.map(entry => ({
        ...entry,
        stat: getPackageSourceMasterStat(entry.file),
        addedAt: typeof entry.file.addedAt === 'number' ? entry.file.addedAt : 0,
        priority: getPackageSourceMasterDedupePriority(project, entry.file),
      })).sort(comparePackageSourceMasterDedupeCandidates);
      keepIndexes.add(bestEntry.index);
    }

    for (const entry of entries) {
      if (keepIndexes.has(entry.index)) continue;
      droppedIndexes.add(entry.index);
      console.log(
        `[crate][package] filtered duplicate auto-captured source master: ` +
        `localName=${formatFigmaLocalNameForLog(entry.file.path)} ` +
        `source=${formatFigmaLogScalar(getFileCaptureSource(entry.file) || 'unknown')} ` +
        `ext=${formatFigmaLogScalar((entry.file.ext || path.extname(entry.file.path || '') || '').toLowerCase(), 'unknown')}`
      );
    }
  }

  if (droppedIndexes.size === 0) return packageFiles;
  return packageFiles.filter((_, index) => !droppedIndexes.has(index));
}

async function selectProjectFilesForPackaging(project) {
  const dedupedFiles = deduplicateFiles(project.files || []);
  const packageFiles = [];

  for (const file of dedupedFiles) {
    if (isBroadObserverOnlyAcceptedFile(project, file)) {
      console.log(
        `[crate][package] filtered broad observer-only file pending review: ` +
        `localName=${formatFigmaLocalNameForLog(file.path)}`
      );
      continue;
    }

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

  return deduplicateFiles(deduplicatePackageSourceMastersForOutput(project, packageFiles));
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

function getPackageLimitResult() {
  checkAndResetUsage();
  const usage = store.get('usage');
  if (usage.packagesThisMonth >= 10) {
    const daysLeft = Math.ceil((new Date(usage.resetDate) - new Date()) / (1000 * 60 * 60 * 24));
    return { error: 'limit_reached', daysLeft };
  }
  return null;
}

function incrementPackageUsage() {
  const usage = store.get('usage');
  usage.packagesThisMonth++;
  store.set('usage', usage);
  return usage;
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
  normalizeAutoCaptureProjectState(project);
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
let mainWindowShowFallback = null;
const mainWindowStartupRetryTimers = new Set();
const watchers = new Map(); // projectId -> chokidar watcher
const lastFileActivity = new Map(); // projectId -> timestamp
const inactivityNotified = new Set(); // projectIds already notified

const MAIN_WINDOW_SHOW_FALLBACK_MS = 1500;
const MAIN_WINDOW_STARTUP_RETRY_DELAYS_MS = [500, 1500, 5000, 10000];
const MAIN_WINDOW_HIDDEN_RECREATE_AFTER = 3;
let mainWindowHiddenShowAttempts = 0;

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
const figmaRateLimitBackoffs = new Map(); // projectId -> retry-after timestamp (ms)
const FIGMA_POLL_INTERVAL_MS = 60000; // 60 seconds
const FIGMA_RATE_LIMIT_BACKOFF_MS = 10 * 60 * 1000; // 10 minutes
const PACKAGE_SCAN_WAIT_TIMEOUT_MS = 30000;
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

// --- Live app evidence refresh (Illustrator, Photoshop, InDesign) ---
const psPollers = new Map();          // projectId -> setInterval id
const psPollerStarting = new Set();   // guard: projectIds with initial poll in progress
const psInProgress = new Set();       // projectIds currently mid-poll
const liveAppDiagnosticLogTimestamps = new Map();
const LIVE_APP_REFRESH_INTERVAL_MS = 3000; // 3 seconds
const LIVE_APP_INITIAL_REFRESH_DELAY_MS = 500;
const LIVE_APP_DIAGNOSTIC_LOG_INTERVAL_MS = 30000;
const PS_POLL_INTERVAL_MS = LIVE_APP_REFRESH_INTERVAL_MS; // historical alias

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

          // Presentation source files are broad lsof evidence, not package-ready proof.
          // Let them reach the central policy as pending/observed candidates so an
          // after-watch open can be visible without reintroducing direct-add contamination.

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

          const processIdentity = currentPid
            ? getDesignAppProcessIdentity(pidToCmd.get(currentPid) || '')
            : null;
          const isPrimarySource = PRIMARY_DESIGN_EXTENSIONS.has(ext);
          const fileEntry = buildAutoCaptureFileEntry(filePath, 'lsof', { ext });
          const staged = stageLiveObservedFile(proj, fileEntry, {
            forcePending: true,
            reason: isPrimarySource ? 'opened-after-watch' : 'app-file-observed',
            captureReason: isPrimarySource ? 'opened-after-watch' : 'app-file-observed',
            captureState: isPrimarySource ? LIVE_CAPTURE_STATES.OBSERVED : LIVE_CAPTURE_STATES.PENDING,
            appFamily: processIdentity && processIdentity.appFamily,
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
    const figmaFileKey = typeof asset.figmaFileKey === 'string' && asset.figmaFileKey.trim()
      ? asset.figmaFileKey.trim()
      : (typeof asset.fileKey === 'string' && asset.fileKey.trim() ? asset.fileKey.trim() : null);
    const figmaAssetKey = getFigmaAssetDedupKey({
      figmaFileKey,
      fileKey: asset.fileKey,
      figmaAssetKey: asset.imageRef || asset.nodeId || asset.url,
      imageRef: asset.imageRef,
      nodeId: asset.nodeId,
      url: asset.url
    });
    if (figmaAssetKey && existingFigmaAssetKeys.has(figmaAssetKey)) {
      console.log(
        `[crate][figma] asset duplicate skip (${contextLabel}): fileKey=${formatFigmaLogScalar(figmaFileKey)} ` +
        `assetKeyPresent=true reason=existing_asset_key`
      );
      continue;
    }

    const fileName = `${asset.figmaFileName}_${asset.name}`;
    const assetFormat = sanitizeFigmaAssetFormat(asset.format);
    const localPath = await downloadFigmaAsset(asset.url, fileName, projectId, assetFormat);

    if (!localPath) {
      console.log(
        `[crate][figma] asset skip (${contextLabel}): fileKey=${formatFigmaLogScalar(figmaFileKey)} ` +
        `name=${formatFigmaLogScalar(asset.name)} reason=download_failed`
      );
      continue;
    }
    const normalizedLocalPath = normalizeTrackedFilePath(localPath);
    if (existingPaths.has(normalizedLocalPath)) {
      console.log(
        `[crate][figma] asset duplicate skip (${contextLabel}): fileKey=${formatFigmaLogScalar(figmaFileKey)} ` +
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
        figmaFileKey,
        figmaFileName: asset.figmaFileName,
        figmaPageId: asset.figmaPageId || null,
        figmaPageName: asset.figmaPageName || null,
        figmaScopeMode: asset.figmaScopeMode || null,
        figmaAssetKey
      };
      const staged = stageLiveObservedFile(proj, fileRecord, {
        allowDirect: true,
        reason: 'figma-project-tracked-cloud',
      });
      if (!staged.changed || staged.decision !== LIVE_CAPTURE_DECISIONS.DIRECT_ADD) return null;
      console.log(
        `[crate][figma] asset inserted (${contextLabel}): fileKey=${formatFigmaLogScalar(figmaFileKey)} ` +
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
        `[crate][figma] asset duplicate skip (${contextLabel}): fileKey=${formatFigmaLogScalar(figmaFileKey)} ` +
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
  const rateLimitRetryAt = figmaRateLimitBackoffs.get(projectId) || 0;
  if (rateLimitRetryAt > scanStartedAt) {
    const warning = figmaRateLimitWarning();
    sendToRenderer('figma:scan-complete', {
      projectId,
      filesFound: 0,
      assetsFound: 0,
      addedCount: 0,
      errors: [],
      timestamp: Date.now(),
      warning,
      retryAfterMs: rateLimitRetryAt - scanStartedAt
    });
    return { skipped: true, reason: 'rate-limited-backoff', retryAfterMs: rateLimitRetryAt - scanStartedAt, warning };
  }

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
    const scanTrackedFiles = expandFigmaTrackedFilesForScan(rawTrackedFiles);
    const teamIds = (figmaSession && Array.isArray(figmaSession.teamIds)) ? figmaSession.teamIds : [];
    const fileKeys = scanTrackedFiles.map(entry => entry.key);
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
      scopeEntries: scanTrackedFiles
    });

    const scopeStateResult = mergeFigmaScopeEntriesIntoSession(projectId, scanResult.scopeEntries || []);
    const activeProject = getProjects().find(p => p.id === projectId) || latestProject;
    let activeWarnings = (((activeProject || {}).figmaSession || {}).warnings) || [];
    const candidateDiagnostics = summarizeFigmaCandidateDiagnosticsForLog(scanResult.candidateDiagnostics);
    if (candidateDiagnostics) {
      console.log(`[crate][figma] candidate diagnostics: ${JSON.stringify(candidateDiagnostics)}`);
    }
    const isRateLimited = hasFigmaRateLimitDiagnostic(candidateDiagnostics);
    if (isRateLimited) {
      setFigmaRateLimitBackoff(projectId);
      const rateLimitScopeUpdate = updateFigmaSessionRateLimitWarning(projectId);
      if (rateLimitScopeUpdate) {
        sendToRenderer('project:updated', { projectId });
      }
      const refreshedProject = getProjects().find(p => p.id === projectId) || activeProject;
      activeWarnings = (((refreshedProject || {}).figmaSession || {}).warnings) || activeWarnings;
    } else {
      clearFigmaRateLimitBackoff(projectId);
    }

    if (scanResult.errors.length > 0) {
      console.warn('[crate][figma] Scan errors:', summarizeFigmaErrorsForLog(scanResult.errors));
      // Detect token expiry / auth failures — stop polling instead of retrying every 60s
      const hasInvalidTokenDiagnostic = !!(
        candidateDiagnostics &&
        (
          Number(candidateDiagnostics.metadataFailureReasonCounts && candidateDiagnostics.metadataFailureReasonCounts['invalid-token']) > 0 ||
          Number(candidateDiagnostics.fileFetchFailureReasonCounts && candidateDiagnostics.fileFetchFailureReasonCounts['invalid-token']) > 0
        )
      );
      const authError = scanResult.errors.find(e => {
        const msg = typeof e === 'string' ? e : (e && e.message) || '';
        const type = (e && e.type) || '';
        const lower = msg.toLowerCase();
        return type === 'auth' || msg.includes('401') ||
               lower.includes('unauthorized') ||
               lower.includes('token invalid') ||
               lower.includes('invalid figma api token') ||
               lower.includes('personal access token');
      });
      if (authError || hasInvalidTokenDiagnostic) {
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
          warning: sessionWarning || 'No recent Figma files found. Make sure your file was modified recently.',
          candidateDiagnostics
        });
      } else {
        sendToRenderer('figma:scan-complete', {
          projectId, filesFound: scanResult.files.length, assetsFound: 0, addedCount: 0,
          errors: scanErrors, timestamp: Date.now(),
          warning: sessionWarning,
          candidateDiagnostics
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
        warning: sessionWarning,
        candidateDiagnostics
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

    const errors = addedCount > 0 ? [] : scanResult.errors.map(e => typeof e === 'string' ? e : (e && e.message) || JSON.stringify(e));
    const warning = activeWarnings[0] || (addedCount > 0 ? null : ((scanResult.warnings && scanResult.warnings[0]) || null));
    sendToRenderer('figma:scan-complete', {
      projectId,
      filesFound: scanResult.files.length,
      assetsFound: scanResult.assets.length,
      addedCount,
      errors,
      timestamp: Date.now(),
      warning,
      candidateDiagnostics
    });

    figmaScanTimestamps.set(projectId, scanStartedAt);
    return {
      projectId,
      filesFound: scanResult.files.length,
      assetsFound: scanResult.assets.length,
      addedCount,
      errors,
      warning,
      candidateDiagnostics
    };
  } catch (e) {
    console.error('[crate][figma] pollFigmaForProject error:', redactFigmaLogText(e.message));
    sendToRenderer('figma:scan-error', { projectId, error: e.message });
    // Detect token expiry / auth failures at the network level
    const msg = (e.message || '').toLowerCase();
    if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('token invalid') || msg.includes('invalid figma api token') || msg.includes('personal access token')) {
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
  figmaRateLimitBackoffs.delete(projectId);
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

const AI_PLACED_ITEM_FALLBACK_JAVASCRIPT = `(function() {
  var rows = [];
  function clean(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[\\r\\n\\t]/g, ' ').replace(/\\s+/g, ' ').trim();
  }
  function filePath(fileRef) {
    try {
      if (!fileRef) return '';
      if (fileRef.fsName) return clean(fileRef.fsName);
      if (fileRef.absoluteURI) return clean(fileRef.absoluteURI);
      return clean(fileRef);
    } catch (e) {
      return '';
    }
  }
  function pushStatus(code) {
    rows.push(['STATUS', code].join('\\t'));
  }
  function pushLink(docName, linkedPath, modified, current) {
    if (!linkedPath) return;
    rows.push(['LINK', '', clean(docName), linkedPath, modified ? 'true' : 'false', current ? 'true' : 'false'].join('\\t'));
  }
  try {
    var activeDoc = null;
    try { activeDoc = app.activeDocument; } catch (e) {}
    for (var d = 0; d < app.documents.length; d++) {
      var doc = app.documents[d];
      var docName = '';
      var docModified = false;
      var docCurrent = false;
      try { docName = clean(doc.name); } catch (e) {}
      try { docModified = !!doc.modified; } catch (e) {}
      try { docCurrent = activeDoc && doc === activeDoc; } catch (e) {}
      try {
        var placedItems = doc.placedItems;
        for (var i = 0; i < placedItems.length; i++) {
          try {
            var placedFile = placedItems[i].file;
            var linkedPath = filePath(placedFile);
            if (linkedPath) {
              pushLink(docName, linkedPath, docModified, docCurrent);
            } else {
              pushStatus('illustrator-placed-item-file-query-failed');
            }
          } catch (e) {
            pushStatus('illustrator-placed-item-file-query-failed');
          }
        }
      } catch (e) {
        pushStatus('illustrator-placed-items-query-failed');
      }
    }
  } catch (e) {
    pushStatus('illustrator-placed-items-query-failed');
  }
  return rows.join('\\n');
})();`;

const AI_PLACED_ITEM_FALLBACK_APPLESCRIPT_LITERAL = JSON.stringify(AI_PLACED_ITEM_FALLBACK_JAVASCRIPT);

const AI_ACTIVE_SESSION_APPLESCRIPT = `on crateLiveEvidencePath(candidateValue)
  try
    if candidateValue is missing value then return ""
  end try
  try
    return POSIX path of (candidateValue as alias)
  end try
  try
    return POSIX path of (candidateValue as file)
  end try
  try
    return POSIX path of candidateValue
  end try
  try
    set candidateText to candidateValue as text
    if candidateText starts with "/" then return candidateText
    if candidateText starts with "file:" then return candidateText
    if candidateText contains ":" then
      try
        return POSIX path of (candidateText as alias)
      end try
      try
        return POSIX path of (candidateText as file)
      end try
      return candidateText
    end if
  end try
  return ""
end crateLiveEvidencePath

on crateIllustratorPlacedItemFallbackRows()
  try
    tell application "Adobe Illustrator"
      return do javascript ${AI_PLACED_ITEM_FALLBACK_APPLESCRIPT_LITERAL}
    end tell
  on error
    return ""
  end try
end crateIllustratorPlacedItemFallbackRows

on crateLiveEvidencePlacedItemPath(pItem)
  set linkedPath to ""
  set usedPathFallback to "false"
  set usedPathTextFallback to "false"
  set usedPathAliasFallback to "false"
  set fileQueryFailed to "false"
  set pathQueryFailed to "false"
  set pathTextQueryFailed to "false"
  set pathAliasQueryFailed to "false"
  tell application "Adobe Illustrator"
    try
      set linkedPath to my crateLiveEvidencePath(file of pItem)
    on error
      set fileQueryFailed to "true"
    end try
    if linkedPath is "" then
      try
        set linkedPath to my crateLiveEvidencePath(file path of pItem)
        if linkedPath is not "" then set usedPathFallback to "true"
      on error
        set pathQueryFailed to "true"
      end try
    end if
    if linkedPath is "" then
      try
        set linkedPath to my crateLiveEvidencePath((file path of pItem) as text)
        if linkedPath is not "" then set usedPathTextFallback to "true"
      on error
        set pathTextQueryFailed to "true"
      end try
    end if
    if linkedPath is "" then
      try
        set linkedPath to POSIX path of ((file path of pItem) as alias)
        if linkedPath is not "" then set usedPathAliasFallback to "true"
      on error
        set pathAliasQueryFailed to "true"
      end try
    end if
  end tell
  return linkedPath & tab & usedPathFallback & tab & usedPathTextFallback & tab & usedPathAliasFallback & tab & fileQueryFailed & tab & pathQueryFailed & tab & pathTextQueryFailed & tab & pathAliasQueryFailed
end crateLiveEvidencePlacedItemPath

tell application "Adobe Illustrator"
  try
    set outputLines to {}
    set placedItemCount to 0
    set placedItemFileFailures to 0
    try
      set documentCount to count of documents
    on error errMsg number errNum
      set safeReason to "illustrator-document-query-failed"
      if errNum is -1743 then set safeReason to "automation-permission-denied"
      if errNum is -1712 then set safeReason to "illustrator-query-timeout"
      return "ERROR" & tab & safeReason
    end try
    if documentCount is 0 then
      set end of outputLines to "STATUS" & tab & "no-documents"
    else
      set currentDocPath to ""
      try
        set currentDocPath to my crateLiveEvidencePath(file path of current document)
      end try
      try
        repeat with aDoc in every document
          try
            set docPath to ""
            set docName to ""
            set docModified to "unknown"
            set docCurrent to "false"
            try
              set docName to name of aDoc as text
            end try
            try
              set docPath to my crateLiveEvidencePath(file path of aDoc)
            end try
            try
              if modified of aDoc is true then
                set docModified to "true"
              else
                set docModified to "false"
              end if
            end try
            try
              if aDoc is current document then set docCurrent to "true"
            end try
            if docCurrent is "false" and docPath is not "" and currentDocPath is not "" and docPath is currentDocPath then set docCurrent to "true"
            set end of outputLines to "DOC" & tab & docPath & tab & docName & tab & docModified & tab & docCurrent
            try
              repeat with pItem in every placed item of aDoc
                set placedItemCount to placedItemCount + 1
                set linkedPath to ""
                set usedPathFallback to "false"
                set usedPathTextFallback to "false"
                set usedPathAliasFallback to "false"
                set fileQueryFailed to "false"
                set pathQueryFailed to "false"
                set pathTextQueryFailed to "false"
                set pathAliasQueryFailed to "false"
                try
                  set pathResult to my crateLiveEvidencePlacedItemPath(pItem)
                  set AppleScript's text item delimiters to tab
                  set pathResultItems to text items of pathResult
                  if (count of pathResultItems) >= 1 then set linkedPath to item 1 of pathResultItems
                  if (count of pathResultItems) >= 2 then set usedPathFallback to item 2 of pathResultItems
                  if (count of pathResultItems) >= 3 then set usedPathTextFallback to item 3 of pathResultItems
                  if (count of pathResultItems) >= 4 then set usedPathAliasFallback to item 4 of pathResultItems
                  if (count of pathResultItems) >= 5 then set fileQueryFailed to item 5 of pathResultItems
                  if (count of pathResultItems) >= 6 then set pathQueryFailed to item 6 of pathResultItems
                  if (count of pathResultItems) >= 7 then set pathTextQueryFailed to item 7 of pathResultItems
                  if (count of pathResultItems) >= 8 then set pathAliasQueryFailed to item 8 of pathResultItems
                on error
                  set placedItemFileFailures to placedItemFileFailures + 1
                  set end of outputLines to "STATUS" & tab & "illustrator-placed-item-file-query-failed"
                end try
                if fileQueryFailed is "true" then
                  set end of outputLines to "STATUS" & tab & "illustrator-placed-item-file-query-failed"
                  set end of outputLines to "STATUS" & tab & "illustrator-placed-item-file-of-query-failed"
                end if
                if pathQueryFailed is "true" then
                  set end of outputLines to "STATUS" & tab & "illustrator-placed-item-path-query-failed"
                  set end of outputLines to "STATUS" & tab & "illustrator-placed-item-file-path-object-query-failed"
                end if
                if pathTextQueryFailed is "true" then
                  set end of outputLines to "STATUS" & tab & "illustrator-placed-item-path-query-failed"
                  set end of outputLines to "STATUS" & tab & "illustrator-placed-item-file-path-text-query-failed"
                end if
                if pathAliasQueryFailed is "true" then
                  set end of outputLines to "STATUS" & tab & "illustrator-placed-item-path-query-failed"
                  set end of outputLines to "STATUS" & tab & "illustrator-placed-item-file-path-alias-query-failed"
                end if
                if usedPathFallback is "true" then set end of outputLines to "STATUS" & tab & "illustrator-placed-item-path-fallback-used"
                if usedPathTextFallback is "true" then set end of outputLines to "STATUS" & tab & "illustrator-placed-item-file-path-text-fallback-used"
                if usedPathAliasFallback is "true" then set end of outputLines to "STATUS" & tab & "illustrator-placed-item-file-path-alias-fallback-used"
                if linkedPath is not "" then
                  set end of outputLines to "LINK" & tab & docPath & tab & docName & tab & linkedPath & tab & docModified & tab & docCurrent
                else if fileQueryFailed is "true" or pathQueryFailed is "true" or pathTextQueryFailed is "true" or pathAliasQueryFailed is "true" then
                  set placedItemFileFailures to placedItemFileFailures + 1
                end if
              end repeat
            on error
              set end of outputLines to "STATUS" & tab & "illustrator-placed-items-query-failed"
            end try
          on error
            set end of outputLines to "STATUS" & tab & "illustrator-document-query-failed"
          end try
        end repeat
      on error
        set end of outputLines to "ERROR" & tab & "illustrator-document-query-failed"
      end try
      set end of outputLines to "PLACED" & tab & placedItemCount
      if placedItemFileFailures > 0 then
        set fallbackRows to my crateIllustratorPlacedItemFallbackRows()
        if fallbackRows is not "" then
          set end of outputLines to "STATUS" & tab & "illustrator-placed-item-file-fallback-used"
          set AppleScript's text item delimiters to linefeed
          set fallbackLines to text items of fallbackRows
          repeat with fallbackLine in fallbackLines
            set fallbackText to fallbackLine as text
            if fallbackText is not "" then set end of outputLines to fallbackText
          end repeat
        else
          set end of outputLines to "STATUS" & tab & "illustrator-placed-item-file-fallback-failed"
        end if
      end if
    end if
    set AppleScript's text item delimiters to linefeed
    return outputLines as text
  on error errMsg number errNum
    set safeReason to "illustrator-query-failed"
    if errNum is -1743 then set safeReason to "automation-permission-denied"
    if errNum is -1712 then set safeReason to "illustrator-query-timeout"
    return "ERROR" & tab & safeReason
  end try
end tell`;

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

const SAFE_LIVE_APP_STATUS_CODES = new Set([
  'app-not-running',
  'project-not-watching',
  'script-not-attempted',
  'script-success',
  'script-timeout',
  'automation-permission-denied',
  'automation-not-authorized',
  'missing-usage-description',
  'empty-output',
  'parse-empty',
  'unknown-script-error',
  'illustrator-query-failed',
  'illustrator-query-timeout',
  'illustrator-document-query-failed',
  'illustrator-placed-items-query-failed',
  'illustrator-placed-item-file-query-failed',
  'illustrator-placed-item-file-of-query-failed',
  'illustrator-placed-item-file-path-object-query-failed',
  'illustrator-placed-item-file-path-text-query-failed',
  'illustrator-placed-item-file-path-alias-query-failed',
  'illustrator-placed-item-file-fallback-used',
  'illustrator-placed-item-file-fallback-failed',
  'illustrator-placed-item-path-fallback-used',
  'illustrator-placed-item-file-path-text-fallback-used',
  'illustrator-placed-item-file-path-alias-fallback-used',
  'illustrator-placed-item-path-query-failed',
  'no-documents',
]);

function normalizeLiveAppStatusCode(value, fallback = 'illustrator-query-failed') {
  const code = sanitizeLiveEvidenceText(value);
  if (!code) return fallback;
  if (code === 'automation-not-authorized') return 'automation-permission-denied';
  return SAFE_LIVE_APP_STATUS_CODES.has(code) ? code : fallback;
}

function normalizeIllustratorHfsPath(rawPath) {
  const trimmed = typeof rawPath === 'string' ? rawPath.trim().replace(/:+$/, '') : '';
  if (!trimmed || !trimmed.includes(':')) {
    return { path: null, reason: 'not-hfs-path' };
  }
  if (trimmed.includes('/') || trimmed.startsWith(':')) {
    return { path: null, reason: 'ambiguous-hfs-path' };
  }

  const parts = trimmed.split(':');
  if (parts.length < 2 || parts.some(part => !part || part === '.' || part === '..' || part.includes('\0'))) {
    return { path: null, reason: 'ambiguous-hfs-path' };
  }

  const volumeName = parts[0];
  const rest = parts.slice(1);
  const startupCandidate = path.join('/', ...rest);
  if (path.isAbsolute(startupCandidate) && fs.existsSync(startupCandidate)) {
    return { path: startupCandidate, reason: null };
  }

  const volumesCandidate = path.join('/Volumes', volumeName, ...rest);
  if (path.isAbsolute(volumesCandidate) && fs.existsSync(volumesCandidate)) {
    return { path: volumesCandidate, reason: null };
  }

  return { path: null, reason: 'unresolved-hfs-path' };
}

function normalizeIllustratorEvidencePath(rawPath) {
  const value = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (!value) return { path: null, reason: 'empty-path' };
  if (value.includes('\0') || value.length > 4096) return { path: null, reason: 'invalid-path' };

  if (path.isAbsolute(value)) {
    return { path: path.normalize(value).replace(/\/+$/, '') || '/', reason: null };
  }

  if (/^file:/i.test(value)) {
    try {
      const filePath = fileURLToPath(value);
      if (filePath && path.isAbsolute(filePath) && !filePath.includes('\0')) {
        return { path: path.normalize(filePath).replace(/\/+$/, '') || '/', reason: null };
      }
    } catch (_) {}
    return { path: null, reason: 'invalid-file-url' };
  }

  if (value.includes(':')) {
    return normalizeIllustratorHfsPath(value);
  }

  return { path: null, reason: 'relative-path' };
}

function recordIllustratorPathNormalization(diagnostics, kind, result) {
  if (!diagnostics || typeof diagnostics !== 'object') return;
  if (kind === 'doc') diagnostics.docRowsSeen = (diagnostics.docRowsSeen || 0) + 1;
  if (kind === 'link') diagnostics.linkRowsSeen = (diagnostics.linkRowsSeen || 0) + 1;
  if (result && result.path) {
    diagnostics.normalizedPaths = (diagnostics.normalizedPaths || 0) + 1;
    return;
  }
  const reason = result && result.reason ? result.reason : 'invalid-path';
  if (!diagnostics.pathSkipped || typeof diagnostics.pathSkipped !== 'object') diagnostics.pathSkipped = {};
  incrementLiveAppSkipCount(diagnostics.pathSkipped, `${kind}-${reason}`);
}

function parseIllustratorActiveSessionOutput(output) {
  const documents = [];
  const links = [];
  const statuses = [];
  const errors = [];
  const diagnostics = {
    docRowsSeen: 0,
    linkRowsSeen: 0,
    placedItemsCount: 0,
    normalizedPaths: 0,
    pathSkipped: {},
  };
  for (const rawLine of String(output || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split('\t');
    const kind = parts[0];
    if (kind === 'STATUS' && parts.length >= 2) {
      statuses.push(normalizeLiveAppStatusCode(parts[1], 'illustrator-query-failed'));
      continue;
    }
    if (kind === 'ERROR' && parts.length >= 2) {
      errors.push(normalizeLiveAppStatusCode(parts[1], 'illustrator-query-failed'));
      continue;
    }
    if (kind === 'PLACED' && parts.length >= 2) {
      diagnostics.placedItemsCount = sanitizeLiveAppStatusCount(parts[1]);
      continue;
    }
    if (kind === 'DOC' && parts.length >= 3) {
      const hasDocumentName = parts.length >= 4;
      const documentPath = normalizeIllustratorEvidencePath(parts[1]);
      recordIllustratorPathNormalization(diagnostics, 'doc', documentPath);
      const documentName = hasDocumentName ? sanitizeLiveEvidenceText(parts[2]) : null;
      const modifiedValue = hasDocumentName ? parts[3] : parts[2];
      const currentValue = hasDocumentName && parts.length >= 5 ? parts[4] : null;
      if (!documentPath.path && !documentName) continue;
      documents.push({
        documentPath: documentPath.path,
        documentName: documentName || (documentPath.path ? path.basename(documentPath.path) : null),
        modified: modifiedValue === 'true',
        current: currentValue === 'true',
      });
      continue;
    }
    if (kind === 'LINK' && parts.length >= 4) {
      const hasDocumentName = parts.length >= 5;
      const documentPath = normalizeIllustratorEvidencePath(parts[1]);
      const documentName = hasDocumentName ? sanitizeLiveEvidenceText(parts[2]) : null;
      const linkedPath = normalizeIllustratorEvidencePath(hasDocumentName ? parts[3] : parts[2]);
      recordIllustratorPathNormalization(diagnostics, 'link', linkedPath);
      const modifiedValue = hasDocumentName ? parts[4] : parts[3];
      const currentValue = hasDocumentName && parts.length >= 6 ? parts[5] : null;
      if (!linkedPath.path) continue;
      links.push({
        documentPath: documentPath.path,
        documentName: documentName || (documentPath.path ? path.basename(documentPath.path) : null),
        linkedPath: linkedPath.path,
        modified: modifiedValue === 'true',
        current: currentValue === 'true',
      });
    }
  }
  return { documents, links, statuses, errors, diagnostics };
}

const ILLUSTRATOR_SOURCE_EXTENSIONS = new Set(['.ai', '.eps', '.pdf', '.svg']);

function normalizeIllustratorDocumentName(value) {
  const safe = sanitizeLiveEvidenceText(value);
  return safe ? safe.toLowerCase() : null;
}

function isIllustratorSourceCandidate(file) {
  if (!file || typeof file !== 'object') return false;
  const ext = (file.ext || path.extname(file.path || file.name || '') || '').toLowerCase();
  if (ILLUSTRATOR_SOURCE_EXTENSIONS.has(ext)) return true;
  const appFamily = file.captureEvidence && file.captureEvidence.appFamily;
  return normalizeLiveCaptureReason(appFamily, '') === 'illustrator';
}

function buildIllustratorSessionScope(project, activeState) {
  const trackedPaths = new Set();
  const trackedNames = new Set();
  const documents = (activeState && Array.isArray(activeState.documents)) ? activeState.documents : [];
  const documentNameCounts = new Map();
  let hasAnyTrustedPrimarySource = false;

  for (const doc of documents) {
    const normalizedName = normalizeIllustratorDocumentName(doc && doc.documentName);
    if (!normalizedName) continue;
    documentNameCounts.set(normalizedName, (documentNameCounts.get(normalizedName) || 0) + 1);
  }

  for (const file of [
    ...((project && Array.isArray(project.files)) ? project.files : []),
    ...((project && Array.isArray(project.pendingFiles)) ? project.pendingFiles : []),
  ]) {
    const ext = (file && (file.ext || path.extname(file.path || file.name || '')) || '').toLowerCase();
    if (PRIMARY_DESIGN_EXTENSIONS.has(ext) && isTrustedSessionProjectFile(project, file)) {
      hasAnyTrustedPrimarySource = true;
    }
    if (!isIllustratorSourceCandidate(file)) continue;
    const normalizedPath = normalizeTrackedFilePath(file && file.path);
    if (normalizedPath) trackedPaths.add(normalizedPath);
    const fileName = sanitizeLiveEvidenceText(file && (file.name || (file.path ? path.basename(file.path) : '')));
    const normalizedName = normalizeIllustratorDocumentName(fileName);
    if (normalizedName) trackedNames.add(normalizedName);
  }

  return {
    documents,
    trackedPaths,
    trackedNames,
    documentNameCounts,
    hasAnyTrustedPrimarySource,
    hasTrackedSource: trackedPaths.size > 0 || trackedNames.size > 0,
  };
}

function classifyIllustratorDocumentSessionRelevance(doc, scope) {
  const normalizedPath = normalizeTrackedFilePath(doc && doc.documentPath);
  const normalizedName = normalizeIllustratorDocumentName(doc && doc.documentName);
  const duplicateNameCount = normalizedName ? (scope.documentNameCounts.get(normalizedName) || 0) : 0;

  if (normalizedPath && scope.trackedPaths.has(normalizedPath)) {
    return { relevant: true, reason: 'tracked-document-path' };
  }
  if (normalizedName && scope.trackedNames.has(normalizedName)) {
    if (duplicateNameCount <= 1 || doc.current === true) {
      return { relevant: true, reason: 'tracked-document-name' };
    }
    return { relevant: false, reason: 'ambiguous-document-name' };
  }
  if (!scope.hasTrackedSource && !scope.hasAnyTrustedPrimarySource && doc && doc.current === true) {
    return { relevant: true, reason: 'current-document' };
  }
  if (!scope.hasTrackedSource && !scope.hasAnyTrustedPrimarySource && scope.documents.length === 1) {
    return { relevant: true, reason: 'single-open-document' };
  }
  if (!normalizedPath && normalizedName && duplicateNameCount > 1 && doc && doc.current !== true) {
    return { relevant: false, reason: 'ambiguous-document-name' };
  }
  return { relevant: false, reason: 'unrelated-document' };
}

function createIllustratorLiveEvidenceRecords(projectId, activeState, project = null, diagnostics = null) {
  const evidenceRecords = [];
  const scope = buildIllustratorSessionScope(project, activeState);
  for (const doc of (activeState && activeState.documents) || []) {
    const relevance = classifyIllustratorDocumentSessionRelevance(doc, scope);
    if (!relevance.relevant) {
      incrementLiveAppSkipCount(diagnostics && diagnostics.skipped, relevance.reason);
      continue;
    }
    if (!doc.documentPath) continue;
    evidenceRecords.push(createLiveAppEvidence({
      projectId,
      filePath: doc.documentPath,
      source: 'app-opened',
      appFamily: 'illustrator',
      observerMethod: LIVE_APP_OBSERVER_METHODS.ILLUSTRATOR_ACTIVE_SESSION,
      sourceDocumentPath: doc.documentPath,
      sourceDocumentName: doc.documentName || path.basename(doc.documentPath),
      documentModified: doc.modified,
      evidenceStrength: LIVE_APP_EVIDENCE_STRENGTHS.STRUCTURED_APP_DOCUMENT,
      requiresSave: doc.modified,
    }));
  }
  for (const link of (activeState && activeState.links) || []) {
    const relevance = classifyIllustratorDocumentSessionRelevance(link, scope);
    if (!relevance.relevant) {
      incrementLiveAppSkipCount(diagnostics && diagnostics.skipped, relevance.reason);
      continue;
    }
    const evidence = createLiveAppEvidence({
      projectId,
      filePath: link.linkedPath,
      source: 'ai-linked',
      appFamily: 'illustrator',
      observerMethod: LIVE_APP_OBSERVER_METHODS.ILLUSTRATOR_ACTIVE_SESSION,
      sourceDocumentPath: link.documentPath,
      sourceDocumentName: link.documentName || (link.documentPath ? path.basename(link.documentPath) : null),
      relationshipSourcePath: link.documentPath,
      documentModified: link.modified,
      evidenceStrength: LIVE_APP_EVIDENCE_STRENGTHS.STRUCTURED_APP_LINK,
      requiresSave: true,
    });
    if (!evidence) {
      incrementLiveAppSkipCount(diagnostics && diagnostics.skipped, 'invalid-evidence');
      continue;
    }
    evidenceRecords.push(evidence);
  }
  return evidenceRecords.filter(Boolean);
}

async function isIllustratorRunningForLiveEvidence() {
  const pgrep = await execFileAsync('/usr/bin/pgrep', ['-x', 'Adobe Illustrator'], {
    timeout: 3000,
    encoding: 'utf8',
  }).catch(() => ({ stdout: '' }));
  if (pgrep.stdout && pgrep.stdout.trim()) return true;

  const ps = await execFileAsync('/bin/ps', ['ax', '-o', 'comm='], {
    timeout: 3000,
    encoding: 'utf8',
  }).catch(() => ({ stdout: '' }));
  if (String(ps.stdout || '')
    .split('\n')
    .some(line => {
      const commandPath = line.trim();
      if (!commandPath) return false;
      const commandName = path.basename(commandPath).toLowerCase();
      if (commandName === 'adobe illustrator' || commandName === 'illustrator') return true;
      return /\/(?:adobe )?illustrator(?: \d{4})?\.app\/contents\/macos\/(?:adobe )?illustrator$/i.test(commandPath);
    })) {
    return true;
  }

  const psCommand = await execFileAsync('/bin/ps', ['axww', '-o', 'command='], {
    timeout: 3000,
    encoding: 'utf8',
  }).catch(() => ({ stdout: '' }));
  return String(psCommand.stdout || '')
    .split('\n')
    .some(line => {
      const commandText = line.trim();
      if (!commandText) return false;
      if (/^Adobe Illustrator(?:\s|$)/i.test(commandText)) return true;
      return /\/(?:adobe )?illustrator(?: \d{4})?\.app\/contents\/macos\/(?:adobe )?illustrator(?:\s|$)/i.test(commandText);
    });
}

function createLinkedAssetLiveEvidenceRecord({
  projectId,
  filePath,
  source,
  appFamily,
  observerMethod,
}) {
  return createLiveAppEvidence({
    projectId,
    filePath,
    source,
    appFamily,
    observerMethod,
    evidenceStrength: LIVE_APP_EVIDENCE_STRENGTHS.STRUCTURED_APP_LINK,
    requiresSave: true,
  });
}

function collectLiveAppEvidenceCandidates(liveEvidenceRecords = []) {
  const candidates = [];
  const batchPaths = new Set();
  const skipped = {};

  for (const evidence of Array.isArray(liveEvidenceRecords) ? liveEvidenceRecords : []) {
    if (!evidence || typeof evidence.filePath !== 'string' || !path.isAbsolute(evidence.filePath)) {
      incrementLiveAppSkipCount(skipped, 'invalid-path');
      continue;
    }
    const normalizedFilePath = normalizeTrackedFilePath(evidence.filePath);
    if (!normalizedFilePath) {
      incrementLiveAppSkipCount(skipped, 'invalid-path');
      continue;
    }
    if (batchPaths.has(normalizedFilePath)) {
      incrementLiveAppSkipCount(skipped, 'duplicate-batch-path');
      continue;
    }
    const ext = path.extname(evidence.filePath).toLowerCase();
    if (!DESIGN_FILE_EXTENSIONS.has(ext)) {
      incrementLiveAppSkipCount(skipped, 'unsupported-extension');
      continue;
    }
    try {
      fs.accessSync(evidence.filePath, fs.constants.R_OK);
    } catch (_) {
      incrementLiveAppSkipCount(skipped, 'unreadable-file');
      continue;
    }
    candidates.push({ evidence, ext, normalizedFilePath });
    batchPaths.add(normalizedFilePath);
  }

  return { candidates, skipped };
}

function getLiveAppEvidenceCandidates(liveEvidenceRecords = []) {
  return collectLiveAppEvidenceCandidates(liveEvidenceRecords).candidates;
}

function applyLiveAppEvidenceRefresh(projectId, liveEvidenceRecords = []) {
  const { candidates, skipped } = collectLiveAppEvidenceCandidates(liveEvidenceRecords);
  const skipSummary = formatLiveAppSkipCounts(skipped);
  if (skipSummary) {
    logLiveAppDiagnostic(projectId, 'candidate-skips', `candidate skip counts for project ${projectId}: ${skipSummary}`);
  }
  if (candidates.length === 0) return { changed: false, stagedCount: 0, skipped };

  const result = mutateProject(projectId, (proj) => {
    if (proj.status !== 'watching') return null;
    let changed = false;
    let stagedCount = 0;
    const stagedStates = new Map();
    const stagedByApp = new Map();

    for (const { evidence, ext } of candidates) {
      const fileEntry = buildAutoCaptureFileEntry(evidence.filePath, evidence.source, { ext });
      const shouldForcePending = evidence.forcePending === true || (
        evidence.forcePending !== false &&
        !(evidence.savedEvidence === true && evidence.documentModified !== true)
      );
      const staged = stageLiveObservedFile(proj, fileEntry, {
        forcePending: shouldForcePending,
        allowDirect: evidence.allowDirect === true,
        savedEvidence: evidence.savedEvidence === true,
        filesystemSaved: evidence.filesystemSaved === true,
        parserConfirmed: evidence.parserConfirmed === true,
        reason: evidence.evidenceReason || 'app-script-broad-observer',
        relationshipSourcePath: evidence.relationshipSourcePath,
        liveEvidence: evidence,
      });
      if (!staged.changed) continue;
      stagedCount++;
      changed = true;
      stagedStates.set(staged.captureState, (stagedStates.get(staged.captureState) || 0) + 1);
      const stagedAppFamily = normalizeLiveCaptureReason(evidence.appFamily, 'live-app');
      stagedByApp.set(stagedAppFamily, (stagedByApp.get(stagedAppFamily) || 0) + 1);
      if (staged.decision === LIVE_CAPTURE_DECISIONS.DIRECT_ADD) {
        const storedFile = proj.files.find(f => f.path === fileEntry.path && f.source === fileEntry.source);
        if (storedFile) {
          recordSessionObservedFile(proj, storedFile, {
            kind: OBSERVER_KINDS.APP_SCRIPT,
            method: evidence.source,
            payload: {
              method: evidence.source,
              channel: 'live-app-refresh',
            },
          });
        }
      }
    }

    return {
      changed,
      stagedCount,
      stagedStates: Array.from(stagedStates.entries()),
      stagedByApp: Array.from(stagedByApp.entries()),
      files: proj.files,
      pendingFiles: proj.pendingFiles || [],
    };
  });

  if (!result || result.stagedCount === 0) {
    return { changed: false, stagedCount: 0, skipped };
  }

  lastFileActivity.set(projectId, Date.now());
  inactivityNotified.delete(projectId);

  const updatedProject = getProjects().find(p => p.id === projectId);
  if (updatedProject) {
    sendToRenderer('files:updated', { projectId, files: updatedProject.files });
    sendToRenderer('files:pending', { projectId, pendingFiles: updatedProject.pendingFiles || [] });
  }

  return result;
}

const INDD_APPLESCRIPT = `tell application "Adobe InDesign"
  try
    set rowList to {}
    repeat with aDoc in every document
      set docName to ""
      set docPathText to ""
      set docModified to false
      set docCurrent to false
      try
        set docName to name of aDoc
      end try
      try
        set docModified to modified of aDoc
      end try
      try
        set docCurrent to (aDoc is active document)
      end try
      try
        set docPathValue to file path of aDoc
        if docPathValue is not missing value then
          set docPathText to POSIX path of (docPathValue as alias)
          if docPathText ends with "/" then set docPathText to docPathText & docName
        end if
      end try
      set end of rowList to "DOC" & tab & docPathText & tab & docName & tab & (docModified as text) & tab & (docCurrent as text)
      repeat with aLink in every link of aDoc
        try
          set fp to file path of aLink
          if fp is not missing value then
            set linkPathText to POSIX path of (fp as alias)
            set end of rowList to "LINK" & tab & docPathText & tab & docName & tab & linkPathText & tab & (docModified as text) & tab & (docCurrent as text)
          end if
        end try
      end repeat
    end repeat
    set AppleScript's text item delimiters to linefeed
    return rowList as text
  on error
    return ""
  end try
end tell`;

function parseInDesignActiveSessionOutput(output) {
  const documents = [];
  const links = [];
  const diagnostics = {
    docRowsSeen: 0,
    linkRowsSeen: 0,
    normalizedPaths: 0,
    pathSkipped: {},
  };

  for (const rawLine of String(output || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split('\t');
    const kind = parts[0];

    if (kind === 'DOC' && parts.length >= 3) {
      const documentPath = normalizeIllustratorEvidencePath(parts[1]);
      recordIllustratorPathNormalization(diagnostics, 'doc', documentPath);
      const documentName = sanitizeLiveEvidenceText(parts[2]) || (documentPath.path ? path.basename(documentPath.path) : null);
      if (!documentPath.path && !documentName) continue;
      documents.push({
        documentPath: documentPath.path,
        documentName,
        modified: parts[3] === 'true',
        current: parts[4] === 'true',
      });
      continue;
    }

    if (kind === 'LINK' && parts.length >= 4) {
      const documentPath = normalizeIllustratorEvidencePath(parts[1]);
      const linkedPath = normalizeIllustratorEvidencePath(parts[3]);
      recordIllustratorPathNormalization(diagnostics, 'link', linkedPath);
      if (!linkedPath.path) continue;
      links.push({
        documentPath: documentPath.path,
        documentName: sanitizeLiveEvidenceText(parts[2]) || (documentPath.path ? path.basename(documentPath.path) : null),
        linkedPath: linkedPath.path,
        modified: parts[4] === 'true',
        current: parts[5] === 'true',
      });
      continue;
    }

    const legacyPath = normalizeIllustratorEvidencePath(line);
    recordIllustratorPathNormalization(diagnostics, 'link', legacyPath);
    if (legacyPath.path) {
      links.push({
        documentPath: null,
        documentName: null,
        linkedPath: legacyPath.path,
        modified: true,
        current: false,
      });
    }
  }

  return { documents, links, diagnostics };
}

function normalizeInDesignDocumentName(value) {
  const safe = sanitizeLiveEvidenceText(value);
  return safe ? safe.toLowerCase() : null;
}

function isInDesignSourceCandidate(file) {
  if (!file || typeof file !== 'object') return false;
  const ext = (file.ext || path.extname(file.path || file.name || '') || '').toLowerCase();
  if (ext === '.indd' || ext === '.idml') return true;
  const appFamily = file.captureEvidence && file.captureEvidence.appFamily;
  return normalizeLiveCaptureReason(appFamily, '') === 'indesign';
}

function buildInDesignSessionScope(project, activeState) {
  const documents = (activeState && Array.isArray(activeState.documents)) ? activeState.documents : [];
  const trackedPaths = new Set();
  const trackedNames = new Set();
  const documentNameCounts = new Map();
  let hasAnyTrustedPrimarySource = false;

  for (const doc of documents) {
    const normalizedName = normalizeInDesignDocumentName(doc && doc.documentName);
    if (!normalizedName) continue;
    documentNameCounts.set(normalizedName, (documentNameCounts.get(normalizedName) || 0) + 1);
  }

  for (const file of [
    ...((project && Array.isArray(project.files)) ? project.files : []),
    ...((project && Array.isArray(project.pendingFiles)) ? project.pendingFiles : []),
  ]) {
    const ext = (file && (file.ext || path.extname(file.path || file.name || '')) || '').toLowerCase();
    if (PRIMARY_DESIGN_EXTENSIONS.has(ext) && isTrustedSessionProjectFile(project, file)) {
      hasAnyTrustedPrimarySource = true;
    }
    if (!isInDesignSourceCandidate(file)) continue;
    const normalizedPath = normalizeTrackedFilePath(file && file.path);
    if (normalizedPath) trackedPaths.add(normalizedPath);
    const fileName = sanitizeLiveEvidenceText(file && (file.name || (file.path ? path.basename(file.path) : '')));
    const normalizedName = normalizeInDesignDocumentName(fileName);
    if (normalizedName) trackedNames.add(normalizedName);
  }

  return {
    documents,
    trackedPaths,
    trackedNames,
    documentNameCounts,
    hasAnyTrustedPrimarySource,
    hasTrackedSource: trackedPaths.size > 0 || trackedNames.size > 0,
  };
}

function classifyInDesignDocumentSessionRelevance(doc, scope) {
  const normalizedPath = normalizeTrackedFilePath(doc && doc.documentPath);
  const normalizedName = normalizeInDesignDocumentName(doc && doc.documentName);
  const duplicateNameCount = normalizedName ? (scope.documentNameCounts.get(normalizedName) || 0) : 0;

  if (normalizedPath && scope.trackedPaths.has(normalizedPath)) {
    return { relevant: true, reason: 'tracked-document-path' };
  }
  if (normalizedName && scope.trackedNames.has(normalizedName)) {
    if (duplicateNameCount <= 1 || doc.current === true) {
      return { relevant: true, reason: 'tracked-document-name' };
    }
    return { relevant: false, reason: 'ambiguous-document-name' };
  }
  if (!scope.hasTrackedSource && !scope.hasAnyTrustedPrimarySource && doc && doc.current === true) {
    return { relevant: true, reason: 'current-document' };
  }
  if (!scope.hasTrackedSource && !scope.hasAnyTrustedPrimarySource && scope.documents.length === 1) {
    return { relevant: true, reason: 'single-open-document' };
  }
  if (!normalizedPath && normalizedName && duplicateNameCount > 1 && doc && doc.current !== true) {
    return { relevant: false, reason: 'ambiguous-document-name' };
  }
  return { relevant: false, reason: 'unrelated-document' };
}

function createInDesignLiveEvidenceRecords(projectId, activeState, project = null, diagnostics = null) {
  const evidenceRecords = [];
  const scope = buildInDesignSessionScope(project, activeState);

  for (const doc of (activeState && activeState.documents) || []) {
    const relevance = classifyInDesignDocumentSessionRelevance(doc, scope);
    if (!relevance.relevant) {
      incrementLiveAppSkipCount(diagnostics && diagnostics.skipped, relevance.reason);
      continue;
    }
    if (!doc.documentPath) continue;
    const saved = doc.modified !== true;
    evidenceRecords.push(createLiveAppEvidence({
      projectId,
      filePath: doc.documentPath,
      source: 'app-opened',
      appFamily: 'indesign',
      observerMethod: LIVE_APP_OBSERVER_METHODS.INDESIGN_LIVE_APPLESCRIPT,
      sourceDocumentPath: doc.documentPath,
      sourceDocumentName: doc.documentName || path.basename(doc.documentPath),
      documentModified: doc.modified,
      evidenceStrength: LIVE_APP_EVIDENCE_STRENGTHS.STRUCTURED_APP_DOCUMENT,
      requiresSave: !saved,
      savedEvidence: saved,
      filesystemSaved: saved,
      allowDirect: saved,
      forcePending: !saved,
      evidenceReason: saved ? 'indesign-saved-document' : 'app-live-evidence',
    }));
  }

  for (const link of (activeState && activeState.links) || []) {
    const relevance = (!link.documentPath && scope.documents.length === 0)
      ? { relevant: true, reason: 'legacy-link-output' }
      : classifyInDesignDocumentSessionRelevance(link, scope);
    if (!relevance.relevant) {
      incrementLiveAppSkipCount(diagnostics && diagnostics.skipped, relevance.reason);
      continue;
    }
    const saved = link.modified !== true && !!link.documentPath;
    const evidence = createLiveAppEvidence({
      projectId,
      filePath: link.linkedPath,
      source: 'indd-poll',
      appFamily: 'indesign',
      observerMethod: LIVE_APP_OBSERVER_METHODS.INDESIGN_LIVE_APPLESCRIPT,
      sourceDocumentPath: link.documentPath,
      sourceDocumentName: link.documentName || (link.documentPath ? path.basename(link.documentPath) : null),
      relationshipSourcePath: link.documentPath,
      documentModified: link.modified,
      evidenceStrength: LIVE_APP_EVIDENCE_STRENGTHS.STRUCTURED_APP_LINK,
      requiresSave: !saved,
      savedEvidence: saved,
      filesystemSaved: saved,
      allowDirect: saved,
      forcePending: !saved,
      evidenceReason: saved ? 'indesign-saved-link' : 'app-live-evidence',
    });
    if (!evidence) {
      incrementLiveAppSkipCount(diagnostics && diagnostics.skipped, 'invalid-evidence');
      continue;
    }
    evidenceRecords.push(evidence);
  }

  return evidenceRecords.filter(Boolean);
}

/**
 * Poll Photoshop and InDesign for open smart objects / linked assets (embedded + linked).
 * Fires every 3 seconds; skips silently if neither app is running.
 */
async function pollPsForProject(projectId) {
  if (psInProgress.has(projectId)) return;

  const currentProjects = getProjects();
  const project = currentProjects.find(p => p.id === projectId);
  if (!project) return;
  if (project.status !== 'watching') {
    for (const appFamily of ['illustrator', 'photoshop', 'indesign']) {
      recordLiveAppStatusBreadcrumb(projectId, appFamily, {
        pollFired: true,
        projectWatching: false,
        scriptAttempted: false,
        scriptSuccess: false,
        errorCategory: 'project-not-watching',
      });
    }
    return;
  }

  psInProgress.add(projectId);
  logLiveAppDiagnostic(projectId, 'poll-fired', `live app evidence refresh fired for project ${projectId}`);

  try {
    const liveEvidenceRecords = [];
    const polledApps = [];

    // --- Illustrator ---
    const illustratorRunning = await isIllustratorRunningForLiveEvidence();
    logLiveAppDiagnostic(projectId, 'illustrator-running', `Illustrator running=${illustratorRunning ? 'true' : 'false'} for project ${projectId}`);
    recordLiveAppStatusBreadcrumb(projectId, 'illustrator', {
      pollFired: true,
      projectWatching: true,
      appRunning: illustratorRunning,
      scriptAttempted: false,
      scriptSuccess: false,
      stagedCount: 0,
      errorCategory: illustratorRunning ? 'script-not-attempted' : 'app-not-running',
    });
    if (illustratorRunning) {
      polledApps.push('illustrator');
      try {
        recordLiveAppStatusBreadcrumb(projectId, 'illustrator', {
          pollFired: true,
          projectWatching: true,
          appRunning: true,
          scriptAttempted: true,
        });
        const { stdout: aiOut } = await runOsascriptInPrivateTemp(
          () => ({ 'crate-ai-active-session.applescript': AI_ACTIVE_SESSION_APPLESCRIPT }),
          'crate-ai-active-session.applescript',
          { timeout: 10000, encoding: 'utf8' }
        );
        const aiOutputText = String(aiOut || '');
        const aiOutputEmpty = !aiOutputText.trim();
        if (!String(aiOut || '').trim()) {
          logLiveAppDiagnostic(projectId, 'illustrator-empty-output', `Illustrator returned no structured live evidence for project ${projectId}; check Automation permissions if this persists`);
        }
        const activeState = parseIllustratorActiveSessionOutput(aiOut);
        for (const safeReason of activeState.errors || []) {
          logLiveAppEvidenceUnavailable('Illustrator', new Error(safeReason));
        }
        const illustratorDiagnostics = { skipped: {} };
        const illustratorRecords = createIllustratorLiveEvidenceRecords(projectId, activeState, project, illustratorDiagnostics);
        const illustratorSkipSummary = formatLiveAppSkipCounts(illustratorDiagnostics.skipped);
        const statusSummary = [...(activeState.statuses || []), ...(activeState.errors || [])]
          .filter(Boolean)
          .join(',');
        const pathSkipSummary = formatLiveAppSkipCounts(activeState.diagnostics && activeState.diagnostics.pathSkipped);
        const pathSummary = activeState.diagnostics
          ? ` linkRows=${activeState.diagnostics.linkRowsSeen || 0} normalizedPaths=${activeState.diagnostics.normalizedPaths || 0}${pathSkipSummary ? ` pathSkipped=${pathSkipSummary}` : ''}`
          : '';
        const safeStatusReasons = [...(activeState.statuses || []), ...(activeState.errors || [])]
          .filter(Boolean);
        const scriptErrorCategory = aiOutputEmpty
          ? 'empty-output'
          : normalizeLiveAppStatusErrorCategory(safeStatusReasons[0], null);
        const scriptSuccess = !aiOutputEmpty && (!activeState.errors || activeState.errors.length === 0);
        recordLiveAppStatusBreadcrumb(projectId, 'illustrator', {
          pollFired: true,
          projectWatching: true,
          appRunning: true,
          scriptAttempted: true,
          scriptSuccess,
          docsCount: activeState.documents.length,
          linksCount: activeState.links.length,
          placedItemsCount: activeState.diagnostics && activeState.diagnostics.placedItemsCount,
          normalizedCount: activeState.diagnostics && activeState.diagnostics.normalizedPaths,
          stagedCount: 0,
          skipReasonCounts: mergeLiveAppStatusCounts(
            activeState.diagnostics && activeState.diagnostics.pathSkipped,
            illustratorDiagnostics.skipped
          ),
          statusReasonCounts: countLiveAppStatusReasons(safeStatusReasons),
          errorCategory: scriptErrorCategory || (scriptSuccess ? 'script-success' : 'unknown-script-error'),
        });
        logLiveAppDiagnostic(
          projectId,
          'illustrator-summary',
          `Illustrator live evidence summary for project ${projectId}: script-success=${scriptSuccess ? 'true' : 'false'} docs=${activeState.documents.length} links=${activeState.links.length} records=${illustratorRecords.length}${pathSummary}${statusSummary ? ` status=${statusSummary}` : ''}${illustratorSkipSummary ? ` skipped=${illustratorSkipSummary}` : ''}`
        );
        liveEvidenceRecords.push(...illustratorRecords);
      } catch (e) {
        logLiveAppEvidenceUnavailable('Illustrator', e);
        recordLiveAppStatusBreadcrumb(projectId, 'illustrator', {
          pollFired: true,
          projectWatching: true,
          appRunning: true,
          scriptAttempted: true,
          scriptSuccess: false,
          stagedCount: 0,
          errorCategory: getSafeLiveAppUnavailableReason(e),
        });
      }
    }

    // --- Photoshop ---
    const { stdout: psCheck } = await execAsync(
      "/bin/ps ax -o command= 2>/dev/null | grep -i 'Adobe Photoshop' | grep -v grep",
      { timeout: 3000, encoding: 'utf8' }
    ).catch(() => ({ stdout: '' }));

    const photoshopRunning = Boolean(psCheck.trim());
    recordLiveAppStatusBreadcrumb(projectId, 'photoshop', {
      pollFired: true,
      projectWatching: true,
      appRunning: photoshopRunning,
      scriptAttempted: false,
      scriptSuccess: false,
      stagedCount: 0,
      errorCategory: photoshopRunning ? 'script-not-attempted' : 'app-not-running',
    });

    if (photoshopRunning) {
      polledApps.push('photoshop');
      try {
        recordLiveAppStatusBreadcrumb(projectId, 'photoshop', {
          pollFired: true,
          projectWatching: true,
          appRunning: true,
          scriptAttempted: true,
        });
        const { stdout: psOut } = await runOsascriptInPrivateTemp(
          ({ resolveScriptPath }) => ({
            'crate-ps-poll.js': PS_DOJAVASCRIPT,
            'crate-ps-poll.applescript': psDoJavascriptAS(resolveScriptPath('crate-ps-poll.js')),
          }),
          'crate-ps-poll.applescript',
          { timeout: 10000, encoding: 'utf8' }
        );
        const psLines = psOut.split('\n').filter(Boolean);
        recordLiveAppStatusBreadcrumb(projectId, 'photoshop', {
          pollFired: true,
          projectWatching: true,
          appRunning: true,
          scriptAttempted: true,
          scriptSuccess: true,
          linksCount: psLines.length,
          normalizedCount: psLines.length,
          stagedCount: 0,
          errorCategory: psLines.length > 0 ? 'script-success' : 'parse-empty',
        });
        for (const p of psLines) {
          const evidence = createLinkedAssetLiveEvidenceRecord({
            projectId,
            filePath: p,
            source: 'ps-poll',
            appFamily: 'photoshop',
            observerMethod: LIVE_APP_OBSERVER_METHODS.PHOTOSHOP_LIVE_SCRIPT,
          });
          if (evidence) liveEvidenceRecords.push(evidence);
        }
      } catch (e) {
        logLiveAppEvidenceUnavailable('Photoshop', e);
        recordLiveAppStatusBreadcrumb(projectId, 'photoshop', {
          pollFired: true,
          projectWatching: true,
          appRunning: true,
          scriptAttempted: true,
          scriptSuccess: false,
          stagedCount: 0,
          errorCategory: getSafeLiveAppUnavailableReason(e),
        });
      }
    }

    // --- InDesign ---
    const { stdout: inddCheck } = await execAsync(
      "/bin/ps ax -o command= 2>/dev/null | grep -i 'Adobe InDesign' | grep -v grep",
      { timeout: 3000, encoding: 'utf8' }
    ).catch(() => ({ stdout: '' }));

    const indesignRunning = Boolean(inddCheck.trim());
    recordLiveAppStatusBreadcrumb(projectId, 'indesign', {
      pollFired: true,
      projectWatching: true,
      appRunning: indesignRunning,
      scriptAttempted: false,
      scriptSuccess: false,
      stagedCount: 0,
      errorCategory: indesignRunning ? 'script-not-attempted' : 'app-not-running',
    });

    if (indesignRunning) {
      polledApps.push('indesign');
      try {
        recordLiveAppStatusBreadcrumb(projectId, 'indesign', {
          pollFired: true,
          projectWatching: true,
          appRunning: true,
          scriptAttempted: true,
        });
        const { stdout: inddOut } = await runOsascriptInPrivateTemp(
          () => ({ 'crate-indd-poll.applescript': INDD_APPLESCRIPT }),
          'crate-indd-poll.applescript',
          { timeout: 10000, encoding: 'utf8' }
        );
        const inddActiveState = parseInDesignActiveSessionOutput(inddOut);
        const inddDiagnostics = { skipped: {} };
        const inddRecords = createInDesignLiveEvidenceRecords(projectId, inddActiveState, project, inddDiagnostics);
        recordLiveAppStatusBreadcrumb(projectId, 'indesign', {
          pollFired: true,
          projectWatching: true,
          appRunning: true,
          scriptAttempted: true,
          scriptSuccess: true,
          docsCount: inddActiveState.documents.length,
          linksCount: inddActiveState.links.length,
          normalizedCount: inddActiveState.diagnostics && inddActiveState.diagnostics.normalizedPaths,
          stagedCount: 0,
          skipReasonCounts: mergeLiveAppStatusCounts(
            inddActiveState.diagnostics && inddActiveState.diagnostics.pathSkipped,
            inddDiagnostics.skipped
          ),
          errorCategory: inddRecords.length > 0 ? 'script-success' : 'parse-empty',
        });
        liveEvidenceRecords.push(...inddRecords);
      } catch (e) {
        logLiveAppEvidenceUnavailable('InDesign', e);
        recordLiveAppStatusBreadcrumb(projectId, 'indesign', {
          pollFired: true,
          projectWatching: true,
          appRunning: true,
          scriptAttempted: true,
          scriptSuccess: false,
          stagedCount: 0,
          errorCategory: getSafeLiveAppUnavailableReason(e),
        });
      }
    }

    if (polledApps.length > 0 && liveEvidenceRecords.length > 0) {
      console.log(`[crate][live-app] Polled active app evidence for project ${projectId}: ${polledApps.join(', ')} (${liveEvidenceRecords.length} records)`);
    }

    if (liveEvidenceRecords.length === 0) return;

    const refreshResult = applyLiveAppEvidenceRefresh(projectId, liveEvidenceRecords);
    for (const [appFamily, stagedCount] of refreshResult.stagedByApp || []) {
      recordLiveAppStatusBreadcrumb(projectId, appFamily, {
        pollFired: true,
        projectWatching: true,
        scriptAttempted: true,
        scriptSuccess: true,
        stagedCount,
        errorCategory: stagedCount > 0 ? 'script-success' : 'parse-empty',
      });
    }
    if (refreshResult.stagedCount > 0) {
      const stateSummary = Array.from(refreshResult.stagedStates || [])
        .map(([state, count]) => `${state}:${count}`)
        .join(',');
      console.log(`[crate][live-app] Staged ${refreshResult.stagedCount} active-session evidence candidates for project ${projectId}${stateSummary ? ` (${stateSummary})` : ''}`);
    }
  } catch (e) {
    console.error('[crate][live-app] pollPsForProject error:', redactFigmaLogText(e && e.message));
  } finally {
    psInProgress.delete(projectId);
  }
}

/**
 * Start live app evidence refresh for a project.
 */
function startPsPolling(projectId) {
  if (psPollers.has(projectId) || psPollerStarting.has(projectId)) return;
  psPollerStarting.add(projectId);
  logLiveAppDiagnostic(projectId, 'poll-installed', `live app evidence refresh installed for project ${projectId}`, 0);
  for (const appFamily of ['illustrator', 'photoshop', 'indesign']) {
    recordLiveAppStatusBreadcrumb(projectId, appFamily, {
      pollInstalled: true,
      projectWatching: true,
      scriptAttempted: false,
      errorCategory: 'script-not-attempted',
    });
  }

  const intervalId = setInterval(() => {
    return pollPsForProject(projectId);
  }, PS_POLL_INTERVAL_MS);
  psPollers.set(projectId, intervalId);

  setTimeout(() => {
    pollPsForProject(projectId).finally(() => {
      psPollerStarting.delete(projectId);
    });
  }, LIVE_APP_INITIAL_REFRESH_DELAY_MS);
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
  for (const key of [...liveAppDiagnosticLogTimestamps.keys()]) {
    if (key.startsWith(`${projectId}:`)) liveAppDiagnosticLogTimestamps.delete(key);
  }
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

    // Name-based dedup for .key files. Do not add prior scan-on-save media to
    // this base-name set: Keynote commonly saves multiple distinct pasted
    // images as pasted-image-NNNN.jpeg, and stripping the suffix collapses them
    // all to the same display base. Exact duplicate scan media is handled by
    // content fingerprints below.
    const alreadyCapturedBases = new Set();
    for (const f of projectFiles) {
      if (f && f.source === 'scan-on-save-presentation') {
        hardenPresentationCacheFileIfPresent(f.path, tempDir);
        continue;
      }
      const n = path.basename(f.name, path.extname(f.name)).toLowerCase().replace(/\s+/g, ' ').trim();
      alreadyCapturedBases.add(n);
    }

    // Content-based dedup for presentation media. PowerPoint renames images
    // generically, and Keynote may give multiple distinct pasted images the same
    // cleaned display base. Content identity is the safe cross-save dedupe key.
    const contentFingerprints = new Set();
    const capturedSizes = new Set();
    if (ext === '.pptx' || ext === '.ppt' || ext === '.key') {
      for (const f of projectFiles) {
        const candidateExt = path.extname(f && (f.path || f.name) || '').toLowerCase();
        if (!EMBEDDED_MEDIA_EXTENSIONS.has(candidateExt)) continue;
        try {
          const buf = fs.readFileSync(f.path);
          const size = buf.length;
          capturedSizes.add(size);
          const hash = crypto.createHash('md5').update(buf).digest('hex');
          contentFingerprints.add(`${size}:${hash}`);
        } catch (e) { /* file may no longer exist */ }
      }
    }
    const extractedPresentationFingerprints = new Set(contentFingerprints);

    const cacheHasMatchingPresentationMedia = (fingerprint) => {
      if (!fingerprint) return false;
      try {
        for (const entryName of fs.readdirSync(tempDir)) {
          const candidatePath = path.join(tempDir, entryName);
          const stat = fs.statSync(candidatePath);
          if (!stat.isFile()) continue;
          const buf = fs.readFileSync(candidatePath);
          const hash = crypto.createHash('md5').update(buf).digest('hex');
          if (`${buf.length}:${hash}` === fingerprint) return true;
        }
      } catch (e) {
        return false;
      }
      return false;
    };

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
        let extractedFingerprint = null;

        // Content-based dedup for presentation media.
        if (ext === '.pptx' || ext === '.ppt' || ext === '.key') {
          const extractedSize = data.length;
          const extractedHash = crypto.createHash('md5').update(data).digest('hex');
          extractedFingerprint = `${extractedSize}:${extractedHash}`;
          if (extractedPresentationFingerprints.has(extractedFingerprint)) continue;
          if (cacheHasMatchingPresentationMedia(extractedFingerprint)) continue;
          extractedPresentationFingerprints.add(extractedFingerprint);
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
          if (ext === '.pptx' || ext === '.ppt' || ext === '.key') {
            try {
              const existingBuf = fs.readFileSync(destPath);
              const existingHash = crypto.createHash('md5').update(existingBuf).digest('hex');
              if (`${existingBuf.length}:${existingHash}` === extractedFingerprint) {
                destPath = null;
                break;
              }
            } catch (e) {
              // Fall through to collision suffixing if the existing cache file
              // cannot be inspected.
            }
          }
          const e = path.extname(outputName);
          const b = path.basename(outputName, e);
          destPath = path.join(tempDir, `${b}_${counter}${e}`);
          counter++;
        }
        if (!destPath) continue;

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

function clearMainWindowShowFallback() {
  if (mainWindowShowFallback) {
    clearTimeout(mainWindowShowFallback);
    mainWindowShowFallback = null;
  }
}

function clearMainWindowStartupRetries() {
  for (const timerId of mainWindowStartupRetryTimers) {
    clearTimeout(timerId);
  }
  mainWindowStartupRetryTimers.clear();
}

function scheduleMainWindowStartupRetries() {
  clearMainWindowStartupRetries();
  for (const delay of MAIN_WINDOW_STARTUP_RETRY_DELAYS_MS) {
    const timerId = setTimeout(() => {
      mainWindowStartupRetryTimers.delete(timerId);
      showMainWindow({ reason: `startup-retry-${delay}` });
    }, delay);
    if (timerId && typeof timerId.unref === 'function') {
      timerId.unref();
    }
    mainWindowStartupRetryTimers.add(timerId);
  }
}

function getLiveBrowserWindows() {
  if (typeof BrowserWindow.getAllWindows !== 'function') return null;
  return BrowserWindow.getAllWindows()
    .filter((win) => win && typeof win.isDestroyed === 'function' && !win.isDestroyed());
}

function adoptExistingMainWindow() {
  const liveWindows = getLiveBrowserWindows();
  if (trayWindow && !trayWindow.isDestroyed()) {
    if (!liveWindows || liveWindows.includes(trayWindow)) return trayWindow;
    console.warn('[main-window] cached window missing from live window list; recreating');
    trayWindow = null;
  }
  if (!liveWindows) return null;
  const existingWindow = liveWindows
    .find((win) => win && typeof win.isDestroyed === 'function' && !win.isDestroyed());
  if (existingWindow) {
    trayWindow = existingWindow;
  }
  return trayWindow;
}

function recreateMainWindow(reason = 'hidden-window') {
  const previousWindow = trayWindow;
  if (previousWindow && typeof previousWindow.isDestroyed === 'function' && !previousWindow.isDestroyed()) {
    try {
      previousWindow.destroy();
    } catch (e) {
      console.error('[main-window] failed to destroy hidden window:', redactFigmaLogText(e && e.message));
    }
  }
  trayWindow = null;
  mainWindowHiddenShowAttempts = 0;
  const nextWindow = createMainWindow();
  if (nextWindow && !nextWindow.isDestroyed()) {
    showMainWindow({ reason, allowHiddenRecreate: false });
  }
  return nextWindow;
}

function verifyMainWindowVisible(reason = 'show') {
  if (!trayWindow || trayWindow.isDestroyed()) return false;
  if (typeof trayWindow.isVisible !== 'function' || trayWindow.isVisible()) {
    mainWindowHiddenShowAttempts = 0;
    return true;
  }

  mainWindowHiddenShowAttempts += 1;
  console.warn('[main-window] window remained hidden after show:', redactFigmaLogText(`${reason} attempt=${mainWindowHiddenShowAttempts}`));
  if (mainWindowHiddenShowAttempts >= MAIN_WINDOW_HIDDEN_RECREATE_AFTER) {
    recreateMainWindow('recreate-hidden-window');
  }
  return false;
}

function createMainWindow() {
  adoptExistingMainWindow();
  if (trayWindow && !trayWindow.isDestroyed()) return trayWindow;

  trayWindow = new BrowserWindow({
    width: 960,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    show: true,
    focusable: true,
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

  const rendererEntry = path.join(__dirname, 'renderer', 'index.html');

  const revealLoadedMainWindow = () => {
    clearMainWindowShowFallback();
    showMainWindow({ reason: 'renderer-ready' });
  };

  if (typeof trayWindow.once === 'function') {
    trayWindow.once('ready-to-show', revealLoadedMainWindow);
  }

  if (trayWindow.webContents && typeof trayWindow.webContents.once === 'function') {
    trayWindow.webContents.once('did-finish-load', revealLoadedMainWindow);
  }

  if (trayWindow.webContents && typeof trayWindow.webContents.on === 'function') {
    trayWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      console.error('[main-window] renderer failed to load:', redactFigmaLogText(`${errorCode || ''} ${errorDescription || ''}`));
      showMainWindow({ reason: 'renderer-failed-load' });
    });
    trayWindow.webContents.on('render-process-gone', (_event, details = {}) => {
      console.error('[main-window] renderer process exited:', redactFigmaLogText(details.reason || 'unknown'));
      showMainWindow({ reason: 'renderer-process-gone' });
    });
  }

  const loadResult = trayWindow.loadFile(rendererEntry);
  if (loadResult && typeof loadResult.catch === 'function') {
    loadResult.catch((error) => {
      console.error('[main-window] renderer load failed:', redactFigmaLogText(error && error.message));
      showMainWindow({ reason: 'renderer-load-failed' });
    });
  }

  clearMainWindowShowFallback();
  mainWindowShowFallback = setTimeout(() => {
    mainWindowShowFallback = null;
    showMainWindow({ reason: 'show-fallback' });
  }, MAIN_WINDOW_SHOW_FALLBACK_MS);
  if (mainWindowShowFallback && typeof mainWindowShowFallback.unref === 'function') {
    mainWindowShowFallback.unref();
  }

  const createdWindow = trayWindow;
  trayWindow.on('closed', () => {
    if (trayWindow !== createdWindow) return;
    clearMainWindowShowFallback();
    clearMainWindowStartupRetries();
    mainWindowHiddenShowAttempts = 0;
    trayWindow = null;
  });

  return trayWindow;
}

function toggleTrayWindow() {
  showMainWindow({ reason: 'tray-click' });
}

function showMainWindow(options = {}) {
  const {
    reason = 'show',
    allowHiddenRecreate = true,
  } = options || {};
  if (typeof app.isReady === 'function' && !app.isReady()) return;

  adoptExistingMainWindow();
  if (!trayWindow || trayWindow.isDestroyed()) {
    createMainWindow();
  }
  if (!trayWindow || trayWindow.isDestroyed()) return;

  if (typeof app.show === 'function') {
    app.show();
  }
  if (typeof trayWindow.isMinimized === 'function' && trayWindow.isMinimized()) {
    trayWindow.restore();
  }
  if (typeof trayWindow.setIgnoreMouseEvents === 'function') {
    trayWindow.setIgnoreMouseEvents(false);
  }
  if (typeof trayWindow.setFocusable === 'function') {
    trayWindow.setFocusable(true);
  }
  trayWindow.show();
  if (typeof trayWindow.moveTop === 'function') {
    trayWindow.moveTop();
  }
  if (typeof app.focus === 'function') {
    app.focus({ steal: true });
  }
  trayWindow.focus();

  if (allowHiddenRecreate) {
    verifyMainWindowVisible(reason);
  }
}

// Backward-compatible name for package/dialog flows that reveal the app UI.
function showTrayWindow() {
  showMainWindow();
}

function isMainWindowForegroundVisible() {
  if (!trayWindow || typeof trayWindow.isDestroyed !== 'function' || trayWindow.isDestroyed()) {
    return false;
  }
  if (typeof trayWindow.isVisible === 'function' && !trayWindow.isVisible()) {
    return false;
  }
  if (typeof app.isActive === 'function') {
    return app.isActive();
  }
  return true;
}

function showPackageCompleteNotification(projectName, fileCount) {
  if (!Notification.isSupported()) return false;
  try {
    const notification = new Notification({
      title: 'Project Packaged!',
      body: `${projectName} \u2014 ${fileCount} files gathered.`
    });
    activeNativeNotifications.add(notification);
    const cleanup = () => {
      activeNativeNotifications.delete(notification);
    };
    notification.on('close', cleanup);
    notification.on('failed', (_event, error) => {
      cleanup();
      const message = error && error.message ? error.message : String(error || 'unknown');
      console.warn('[notifications] package-complete notification failed:', redactFigmaLogText(message));
      showMainWindow({ reason: 'package-notification-failed' });
    });
    notification.on('click', () => {
      showMainWindow({ reason: 'package-notification-click' });
    });
    notification.show();
    return true;
  } catch (error) {
    console.warn('[notifications] package-complete notification failed:', redactFigmaLogText(error && error.message));
    return false;
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

            const processIdentity = currentPid
              ? getDesignAppProcessIdentity(pidToCmd.get(currentPid) || '')
              : null;
            const fileEntry = buildAutoCaptureFileEntry(filePath, 'lsof', { ext });
            const staged = stageLiveObservedFile(project, fileEntry, {
              forcePending: true,
              reason: 'initial-lsof-snapshot',
              captureReason: 'stale-prewatch-opened',
              captureState: LIVE_CAPTURE_STATES.PENDING,
              appFamily: processIdentity && processIdentity.appFamily,
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
  startPsPolling(projectId);    // begin live app evidence refresh
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
const activeNativeNotifications = new Set();

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
  const projects = getProjects();
  let changed = false;
  for (const project of projects) {
    if (normalizeAutoCaptureProjectState(project)) changed = true;
  }
  if (changed) store.set('projects', projects);
  return projects;
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
  let acceptedSourceForScan = null;
  const result = mutateProject(projectId, (project) => {
    const idx = (project.pendingFiles || []).findIndex(f => f.path === filePath);
    if (idx === -1) return null;

    const [file] = project.pendingFiles.splice(idx, 1);
    const acceptedKey = getTrackedFileDedupKey(file);
    const acceptedPaths = getTrackedFileKeySet(project.files);

    if (!acceptedPaths.has(acceptedKey)) {
      const acceptedFile = {
        ...stripLiveCaptureMetadata(file),
        acceptedPending: true,
      };
      project.files.push(acceptedFile);
      recordPendingFileDecision(project, acceptedFile, 'accepted');
      project.files = deduplicateFiles(project.files);
      lastFileActivity.set(projectId, Date.now());
      inactivityNotified.delete(projectId);
      acceptedSourceForScan = acceptedFile;
    }

    return { files: project.files, pendingFiles: project.pendingFiles };
  });

  if (!result) return null;

  if (trayWindow && !trayWindow.isDestroyed()) {
    trayWindow.webContents.send('files:updated', { projectId, files: result.files });
    trayWindow.webContents.send('files:pending', { projectId, pendingFiles: result.pendingFiles });
  }

  if (
    acceptedSourceForScan &&
    SCAN_ON_OPEN_EXTENSIONS.has((acceptedSourceForScan.ext || path.extname(acceptedSourceForScan.path || '')).toLowerCase())
  ) {
    runScanOnOpen(projectId, acceptedSourceForScan.path).catch(() => {});
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
    const scanTrackedFiles = expandFigmaTrackedFilesForScan(rawTrackedFiles);
    const teamIds = (figmaSession && Array.isArray(figmaSession.teamIds)) ? figmaSession.teamIds : [];
    const fileKeys = scanTrackedFiles.map(entry => entry.key);
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
        scopeEntries: scanTrackedFiles
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
  // ("shopping (6).jpeg") is a lower-quality duplicate — skip it. Prior
  // scan-on-save media is intentionally excluded from this name set because
  // Keynote can save multiple distinct pasted images as pasted-image-NNNN.jpeg;
  // exact duplicates are handled by content fingerprints below.
  const alreadyCapturedBases = new Set();
  if (projectFiles) {
    for (const f of projectFiles) {
      if (f && f.source === 'scan-on-save-presentation') continue;
      const n = path.basename(f.name, path.extname(f.name)).toLowerCase().replace(/\s+/g, ' ').trim();
      alreadyCapturedBases.add(n);
    }
  }

  // v1.3.18: Content-based dedup for presentation media.
  // PowerPoint renames all embedded images generically (image1.png, image2.png),
  // and Keynote can collapse distinct pasted images to the same cleaned display
  // base. Build a Set of size:md5 fingerprints from already-captured media, then
  // check each extracted entry against it. Same size + same hash = same file.
  const contentFingerprints = new Set();
  const capturedSizes = new Set();
  if ((ext === '.pptx' || ext === '.ppt' || ext === '.key') && projectFiles) {
    for (const f of projectFiles) {
      const candidateExt = path.extname(f && (f.path || f.name) || '').toLowerCase();
      if (!EMBEDDED_MEDIA_EXTENSIONS.has(candidateExt)) continue;
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
  const extractedPresentationFingerprints = new Set(contentFingerprints);

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
        let extractedFingerprint = null;

        // v1.3.18: Content-based dedup for presentation media — skip if
        // identical to a captured file.
        if (ext === '.pptx' || ext === '.ppt' || ext === '.key') {
          const extractedSize = data.length;
          const extractedHash = crypto.createHash('md5').update(data).digest('hex');
          extractedFingerprint = `${extractedSize}:${extractedHash}`;
          if (extractedPresentationFingerprints.has(extractedFingerprint)) {
            if (capturedSizes.has(extractedSize)) {
              console.log(`[crate] skipped duplicate (content match): ${path.basename(zipPath)} (${extractedSize} bytes, md5:${extractedHash})`);
            }
            continue;
          }
          extractedPresentationFingerprints.add(extractedFingerprint);
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

function hasInFlightPackageInputScan(projectId) {
  return scanInFlight.has(projectId) ||
    figmaInProgress.has(projectId) ||
    figmaManualScanInFlight.has(projectId);
}

async function waitForPackageInputScans(projectId, timeoutMs = PACKAGE_SCAN_WAIT_TIMEOUT_MS) {
  const scanWaitStart = Date.now();
  while (hasInFlightPackageInputScan(projectId) && Date.now() - scanWaitStart < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
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
  // Wait for in-flight pre-package and Figma scans to finish before selecting
  // package files. Large Figma pages can still be downloading when the user
  // clicks Package, and selecting too early yields a zero-file package.
  await waitForPackageInputScans(id);

  // Check freemium limit
  const limitResult = getPackageLimitResult();
  if (limitResult) return limitResult;

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

    incrementPackageUsage();

    const packageWindowWasForeground = isMainWindowForegroundVisible();
    const packageNotificationShown = settings.notifications
      ? showPackageCompleteNotification(project.name, copiedCount + embeddedCount)
      : false;

    // If Crate was backgrounded, leave focus alone so macOS can surface the native
    // notification. The renderer still shows Package Complete when the user returns.
    if (packageWindowWasForeground || !packageNotificationShown) {
      showTrayWindow();
    }

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
  if (result.canceled) {
    // Restore the app after canceling the picker so the user can continue editing.
    showTrayWindow();
    return null;
  }
  // Do not force foreground after a successful destination selection. Packaging may
  // continue in the background so macOS can deliver the package-complete banner.
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
  figmaRateLimitBackoffs.clear();
  // Clean up PS/InDesign pollers (v2.3.0)
  for (const [, intervalId] of psPollers) {
    clearInterval(intervalId);
  }
  psPollers.clear();
  psPollerStarting.clear();
  psInProgress.clear();
  liveAppDiagnosticLogTimestamps.clear();
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

  const limitResult = getPackageLimitResult();
  if (limitResult) return limitResult;

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
    incrementPackageUsage();
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
  const trackingProjects = getFigmaTrackingProjects();
  let totalFigmaAssets = 0;

  for (const project of projects) {
    // Count Figma-sourced files across all projects
    const figmaFiles = (project.files || []).filter(f => f.source === 'figma-auto');
    totalFigmaAssets += figmaFiles.length;
  }

  return {
    connected: !!token,
    autoTracking: !!token && trackingProjects.length > 0,
    activeProjectCount: trackingProjects.length,
    activePollerCount: getActiveFigmaPollerProjectCount(),
    totalFigmaAssets
  };
});

ipcMain.handle('figma:connect', async (event, token) => {
  const { FigmaParser } = require('./parsers/figma');
  const parser = new FigmaParser();

  // Store token first, then verify on first poll (verifyToken reads from storage)
  const stored = await parser.storeToken(token);

  if (stored) {
    figmaRateLimitBackoffs.clear();
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
  figmaRateLimitBackoffs.clear();

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
  try {
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

    scheduleMainWindowStartupRetries();
    createMainWindow();
    showMainWindow({ reason: 'startup' });
    createTray();

    // Resume watching for any active projects without letting watcher recovery block the UI.
    const projects = getProjects();
    for (const project of projects) {
      if (project.status === 'watching') {
        try {
          await startWatching(project.id);
        } catch (e) {
          console.error('[startup] failed to resume project watch:', redactFigmaLogText(e && e.message));
        }
      }
    }
  } catch (e) {
    console.error('[startup] app initialization failed:', redactFigmaLogText(e && e.message));
    scheduleMainWindowStartupRetries();
    try {
      showMainWindow({ reason: 'startup-error' });
    } catch (showError) {
      console.error('[startup] failed to show main window:', redactFigmaLogText(showError && showError.message));
    }
  } finally {
    // Start inactivity checker after the main UI has had a chance to show.
    startInactivityChecker();
  }
});

app.on('activate', () => {
  showMainWindow({ reason: 'activate' });
});

app.on('did-become-active', () => {
  showMainWindow({ reason: 'did-become-active' });
});

app.on('second-instance', () => {
  showMainWindow({ reason: 'second-instance' });
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
  liveAppDiagnosticLogTimestamps.clear();
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
  activeNativeNotifications.clear();
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
