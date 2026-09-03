const {
  app,
  BrowserWindow,
  Tray,
  ipcMain,
  dialog,
  shell,
  nativeImage,
  Notification,
  utilityProcess,
} = require('electron');
const path = require('path');
const fs = require('fs');
const {
  DESKTOP_WINDOW_MINIMUM,
  createStartupPhaseJournal,
  getWatchRecoveryPhase,
} = require('./startup-phase-journal');
const startupPhaseJournal = createStartupPhaseJournal({
  getLogDirectory: () => app.getPath('logs'),
});
startupPhaseJournal.mark('main-module-entered');
process.on('uncaughtExceptionMonitor', () => {
  startupPhaseJournal.mark('uncaught-exception');
});
const Store = require('electron-store');
const chokidar = require('chokidar');
const { execSync, exec, execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const { StringDecoder } = require('string_decoder');
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const crypto = require('crypto');
const os = require('os');
const { fileURLToPath, pathToFileURL } = require('url');
const { readPsd } = require('ag-psd');
const fetch = require('node-fetch');
const {
  NODE_TYPES,
  EDGE_TYPES,
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
  PACKAGE_OUTPUT_LAYOUT_MODES,
  sanitizePackageFileName,
  truncatePackageComponent,
  createPackageNameAllocator,
  getPackageOutputRelativePath,
  normalizePackageOutputLayoutMode,
  ensureSafePackageDirectory,
  resolveUniquePackagePath: resolveSafeUniquePackagePath,
  resolveExactPackagePath,
  assertSafeCopySource,
  writeFileIntoPackageExact,
} = require('./parsers/package-safety');
const { summarizeDiagnosticPackageErrors } = require('./diagnostic-summary');
const { createAddFilesAttempt } = require('./parsers/add-files-operation');
const { redactUrlAndCredentialText, redactPrivatePathText } = require('./parsers/figma-redaction');

async function runCancellableExecFile(command, args, options = {}) {
  const attempt = options.addFilesAttempt;
  const execOptions = { ...options };
  delete execOptions.addFilesAttempt;
  delete execOptions.isCurrent;
  if (!attempt) return execFileAsync(command, args, execOptions);
  if (!attempt.isCurrent()) throw new Error('add_files_parser_cancelled');
  const controller = new AbortController();
  const removeCancelListener = attempt.onCancel(() => controller.abort());
  try {
    return await execFileAsync(command, args, { ...execOptions, signal: controller.signal });
  } finally {
    removeCancelListener();
  }
}

async function runCancellableExec(command, options = {}) {
  const attempt = options.addFilesAttempt;
  const execOptions = { ...options };
  delete execOptions.addFilesAttempt;
  delete execOptions.isCurrent;
  if (!attempt) return execAsync(command, execOptions);
  if (!attempt.isCurrent()) throw new Error('add_files_parser_cancelled');
  const controller = new AbortController();
  const removeCancelListener = attempt.onCancel(() => controller.abort());
  try {
    return await execAsync(command, { ...execOptions, signal: controller.signal });
  } finally {
    removeCancelListener();
  }
}

async function readFileWithAddFilesCancellation(filePath, attempt, knownSize = null) {
  if (!attempt) return fs.promises.readFile(filePath);
  if (!attempt.isCurrent()) throw new Error('add_files_parser_cancelled');
  let rejectCancellation;
  const cancellation = new Promise((resolve, reject) => {
    rejectCancellation = reject;
  });
  const readOptions = Number.isSafeInteger(knownSize) && knownSize <= 8 * 1024 * 1024
    ? undefined
    : (() => {
      const controller = new AbortController();
      return { controller, signal: controller.signal };
    })();
  const removeCancelListener = attempt.onCancel(reason => {
    readOptions?.controller.abort();
    rejectCancellation(new Error(`add_files_parser_cancelled:${reason || 'cancelled'}`));
  });
  try {
    return await Promise.race([
      readOptions ? fs.promises.readFile(filePath, { signal: readOptions.signal }) : fs.promises.readFile(filePath),
      cancellation,
    ]);
  } finally {
    removeCancelListener();
  }
}

async function accessWithAddFilesCancellation(filePath, mode, attempt) {
  if (!attempt) return fs.promises.access(filePath, mode);
  if (!attempt.isCurrent()) throw new Error('add_files_parser_cancelled');
  let rejectCancellation;
  const cancellation = new Promise((resolve, reject) => {
    rejectCancellation = reject;
  });
  const removeCancelListener = attempt.onCancel(reason => {
    rejectCancellation(new Error(`add_files_parser_cancelled:${reason || 'cancelled'}`));
  });
  try {
    return await Promise.race([
      fs.promises.access(filePath, mode),
      cancellation,
    ]);
  } finally {
    removeCancelListener();
  }
}

function isAddFilesParserCurrent(options = {}) {
  return typeof options.isCurrent !== 'function' || options.isCurrent();
}
const {
  FIGMA_NETWORK_LIMITS,
  createByteBudget,
  fetchBufferWithLimits,
} = require('./parsers/figma-network');
startupPhaseJournal.mark('dependencies-loaded');

const PROVENANCE_MANIFEST_FILENAME = 'crate-provenance.json';
const DIAGNOSTICS_FOLDER_NAME = 'Crate Diagnostics';
const DIAGNOSTIC_MANIFEST_SCHEMA_VERSION = 2;
const TEMP_SCRIPT_DIR_PREFIX = 'crate-script-';
const TEMP_SCRIPT_DIR_MODE = 0o700;
const TEMP_SCRIPT_FILE_MODE = 0o600;
const OWNER_ONLY_DIR_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const PACKAGE_TRANSACTION_WORKER_PATH = path.join(__dirname, 'parsers', 'package-transaction-worker.js');
const ADD_FILES_PSD_WORKER_PATH = path.join(__dirname, 'parsers', 'add-files-psd-worker.js');
const PACKAGE_TRANSACTION_CHUNK_BYTES = 1024 * 1024;
const PACKAGE_TRANSACTION_IDLE_TIMEOUT_MS = 30_000;
const ADD_FILES_OPERATION_TIMEOUT_MS = 30_000;
let addFilesOperationTimeoutMs = ADD_FILES_OPERATION_TIMEOUT_MS;
const activeAddFilesOperations = new Map();
const pendingNativeAddFilesPickers = new Set();
const ADD_FILES_OPERATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const CACHE_CLEANUP_BATCH_SIZE = 25;
const CACHE_CLEANUP_RETRY_DELAYS_MS = [25, 100, 250];
const CRATE_PROJECT_CACHE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CRATE_CACHE_QUARANTINE_PATTERN = /^\.crate-cleanup-\d+-\d+-[0-9a-f]{12}$/i;
const DEFAULT_NAMING_TEMPLATE = '{Project}_{Date}';
const DEFAULT_PACKAGE_FOLDER_NAME = 'Untitled';
const FREE_PACKAGE_LIMIT = 10;
const CLOSED_BETA_PACKAGE_LIMIT = 25;
const MAX_PACKAGE_FOLDER_NAME_LENGTH = 180;
const MAX_PACKAGE_PLAN_PATH_ALLOCATION_ATTEMPTS = 100000;
const UNSAFE_PACKAGE_FOLDER_CHARS = /[\x00-\x1f\x7f<>:"|?*\\/]/g;
const RENDERER_ENTRY_PATH = path.join(__dirname, 'renderer', 'index.html');
const RENDERER_ENTRY_URL = pathToFileURL(RENDERER_ENTRY_PATH).href;
const mainWindowIdentities = new WeakSet();
const firstOccurrenceStartupPhases = new Set();
const RENDERER_STARTUP_DATA_OUTCOME_PHASES = new Set([
  'renderer-startup-data-complete',
  'renderer-startup-data-failed',
]);
const STARTUP_DIAGNOSTIC_PHASE_BY_CHANNEL = Object.freeze({
  'startup:renderer-script-entered': 'renderer-script-entered',
  'startup:renderer-init-entered': 'renderer-init-entered',
  'startup:renderer-startup-data-complete': 'renderer-startup-data-complete',
  'startup:renderer-startup-data-failed': 'renderer-startup-data-failed',
  'startup:renderer-first-render-complete': 'renderer-first-render-complete',
  'startup:renderer-first-frame': 'renderer-first-frame',
  'startup:preload-entered': 'preload-entered',
  'startup:preload-bridge-exposed': 'preload-bridge-exposed',
});

function markFirstOccurrenceStartupPhase(phase) {
  if (
    RENDERER_STARTUP_DATA_OUTCOME_PHASES.has(phase) &&
    [...RENDERER_STARTUP_DATA_OUTCOME_PHASES].some(candidate => (
      candidate !== phase && firstOccurrenceStartupPhases.has(candidate)
    ))
  ) return false;
  if (firstOccurrenceStartupPhases.has(phase)) return false;
  firstOccurrenceStartupPhases.add(phase);
  return startupPhaseJournal.mark(phase);
}

function isTrustedRendererUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'file:') return false;
    parsed.hash = '';
    return parsed.href === RENDERER_ENTRY_URL;
  } catch (_) {
    return false;
  }
}

function assertTrustedRendererIpc(event) {
  const sender = event && event.sender;
  const senderFrame = event && event.senderFrame;
  const mainFrame = sender && sender.mainFrame;
  const senderWindow = sender && typeof BrowserWindow.fromWebContents === 'function'
    ? BrowserWindow.fromWebContents(sender)
    : null;
  const mainWindow = trayWindow;
  const liveWindows = getLiveBrowserWindows();
  if (
    !senderWindow ||
    !mainWindow ||
    typeof mainWindow.isDestroyed !== 'function' ||
    mainWindow.isDestroyed() ||
    !mainWindowIdentities.has(mainWindow) ||
    (liveWindows && !liveWindows.includes(mainWindow)) ||
    senderWindow !== mainWindow ||
    sender !== mainWindow.webContents ||
    !senderFrame ||
    !mainFrame ||
    senderFrame !== mainFrame ||
    !isTrustedRendererUrl(senderFrame.url)
  ) {
    throw new Error('Crate blocked an untrusted renderer request.');
  }
}

function registerTrustedIpcHandler(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedRendererIpc(event);
    return handler(event, ...args);
  });
}

function registerStartupDiagnosticIpc() {
  if (!ipcMain || typeof ipcMain.on !== 'function') return;
  for (const [channel, phase] of Object.entries(STARTUP_DIAGNOSTIC_PHASE_BY_CHANNEL)) {
    ipcMain.on(channel, (event, ...args) => {
      if (args.length !== 0) return;
      try {
        assertTrustedRendererIpc(event);
      } catch (_) {
        return;
      }
      markFirstOccurrenceStartupPhase(phase);
    });
  }
}

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
  name = truncatePackageComponent(name, MAX_PACKAGE_FOLDER_NAME_LENGTH).trim();
  return name || fallback;
}

function sanitizeNamingTemplate(rawTemplate) {
  return sanitizePackageFolderName(rawTemplate, DEFAULT_NAMING_TEMPLATE);
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

    return await runCancellableExecFile('/usr/bin/osascript', [entryScriptPath], options);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

const LAST_USED_XATTR_NAME = 'com.apple.lastuseddate#PS';
const LAST_USED_XATTR_BATCH_SIZE = 256;
const LAST_USED_XATTR_CONCURRENCY = 4;
const LAST_USED_XATTR_TIMEOUT_MS = 2000;
const LAST_USED_SPOTLIGHT_TIMEOUT_MS = 4000;

function decodeNativeLastUsedTimespec(hexValue) {
  const hexStr = typeof hexValue === 'string' ? hexValue.replace(/\s+/g, '') : '';
  if (hexStr.length !== 32 || !/^[0-9a-f]+$/i.test(hexStr)) return null;
  const bytes = Buffer.from(hexStr, 'hex');
  // com.apple.lastuseddate#PS stores a native little-endian timespec:
  // signed Unix seconds followed by signed nanoseconds.
  const seconds = bytes.readBigInt64LE(0);
  const nanoseconds = bytes.readBigInt64LE(8);
  const MAX_JAVASCRIPT_DATE_SECONDS = 8640000000000n;
  if (
    seconds <= 0n ||
    seconds > MAX_JAVASCRIPT_DATE_SECONDS ||
    (seconds === MAX_JAVASCRIPT_DATE_SECONDS && nanoseconds > 0n) ||
    nanoseconds < 0n ||
    nanoseconds >= 1000000000n
  ) return null;
  const secondsNumber = Number(seconds);
  if (!Number.isSafeInteger(secondsNumber)) return null;
  const lastUsedMs = secondsNumber * 1000 + Number(nanoseconds) / 1000000;
  return Number.isFinite(lastUsedMs) && lastUsedMs <= 8640000000000000 ? lastUsedMs : null;
}

async function getXattrLastUsedMs(filePath) {
  try {
    const { stdout } = await execFileAsync('/usr/bin/xattr', ['-px', LAST_USED_XATTR_NAME, filePath], {
      timeout: 1000, encoding: 'utf8'
    });
    return decodeNativeLastUsedTimespec(stdout);
  } catch (e) {
    return null;
  }
}

function getErrorOutput(error, field) {
  const value = error && error[field];
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return typeof value === 'string' ? value : '';
}

function isAbnormalMetadataCommandError(error) {
  return !error || error.killed || error.signal || error.code === 'ETIMEDOUT';
}

function parseBulkLastUsedXattrs(stdout, filePaths) {
  const paths = Array.isArray(filePaths) ? filePaths : [];
  const output = Buffer.isBuffer(stdout)
    ? stdout.toString('utf8')
    : (typeof stdout === 'string' ? stdout : '');
  const values = new Map();
  if (!output) return values;

  const outputLines = output.split('\n');
  const pathHeaders = new Map(paths.map(filePath => [`${filePath}:`, filePath]));
  const hasKnownHeader = outputLines.some(line => pathHeaders.has(line.trimEnd()));
  const hasHeaderShapedLine = outputLines.some(line => line.trimEnd().endsWith(':'));
  if (paths.length === 1 && !hasKnownHeader && !hasHeaderShapedLine) {
    values.set(paths[0], decodeNativeLastUsedTimespec(output));
    return values;
  }

  const seenHeaders = new Set();
  let currentPath = null;
  let valueLines = [];
  const flush = () => {
    if (currentPath === null) return;
    values.set(currentPath, decodeNativeLastUsedTimespec(valueLines.join('')));
    currentPath = null;
    valueLines = [];
  };

  for (const line of outputLines) {
    const headerPath = pathHeaders.get(line.trimEnd());
    if (headerPath) {
      flush();
      if (seenHeaders.has(headerPath)) throw new Error('duplicate xattr path header');
      seenHeaders.add(headerPath);
      currentPath = headerPath;
      continue;
    }
    if (currentPath === null) {
      if (line === '') continue;
      throw new Error('malformed xattr output');
    }
    if (line.trimEnd().endsWith(':')) throw new Error('unknown xattr path header');
    valueLines.push(line);
  }
  flush();
  return values;
}

function parseMissingXattrPaths(stderr, filePaths) {
  const paths = new Set(filePaths);
  const missing = new Set();
  const prefix = 'xattr: ';
  const suffix = `: No such xattr: ${LAST_USED_XATTR_NAME}`;
  const lines = stderr.split('\n').filter(line => line !== '');
  if (lines.length === 0) throw new Error('missing xattr error framing');
  for (const line of lines) {
    if (!line.startsWith(prefix) || !line.endsWith(suffix)) {
      throw new Error('abnormal xattr error framing');
    }
    const filePath = line.slice(prefix.length, -suffix.length);
    if (!paths.has(filePath) || missing.has(filePath)) {
      throw new Error('ambiguous xattr error framing');
    }
    missing.add(filePath);
  }
  return missing;
}

async function getBulkXattrLastUsedMs(filePaths) {
  let stdout = '';
  let missingPaths = new Set();
  try {
    const result = await execFileAsync('/usr/bin/xattr', [
      '-pvx', LAST_USED_XATTR_NAME, ...filePaths,
    ], {
      timeout: LAST_USED_XATTR_TIMEOUT_MS,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    if (isAbnormalMetadataCommandError(error)) throw error;
    missingPaths = parseMissingXattrPaths(getErrorOutput(error, 'stderr'), filePaths);
    stdout = getErrorOutput(error, 'stdout');
  }

  const values = parseBulkLastUsedXattrs(stdout, filePaths);
  for (const filePath of missingPaths) {
    if (values.has(filePath)) throw new Error('conflicting xattr result');
    values.set(filePath, null);
  }
  if (values.size !== filePaths.length || filePaths.some(filePath => !values.has(filePath))) {
    throw new Error('incomplete xattr result');
  }
  return values;
}

async function getStrictSingleXattrLastUsedMs(filePath) {
  try {
    const { stdout } = await execFileAsync('/usr/bin/xattr', ['-px', LAST_USED_XATTR_NAME, filePath], {
      timeout: LAST_USED_XATTR_TIMEOUT_MS,
      encoding: 'utf8',
    });
    return decodeNativeLastUsedTimespec(stdout);
  } catch (error) {
    if (isAbnormalMetadataCommandError(error)) throw error;
    const stderr = getErrorOutput(error, 'stderr');
    if (!stderr.trimEnd().endsWith(`: No such xattr: ${LAST_USED_XATTR_NAME}`)) throw error;
    return null;
  }
}

async function collectBulkXattrLastUsedMs(candidates, operationCurrent) {
  const jobs = [];
  let safeBatch = [];
  const flushSafeBatch = () => {
    if (safeBatch.length > 0) jobs.push({ paths: safeBatch, single: false });
    safeBatch = [];
  };
  for (const candidate of candidates) {
    if (/[\r\n\0]/.test(candidate.fullPath)) {
      flushSafeBatch();
      jobs.push({ paths: [candidate.fullPath], single: true });
      continue;
    }
    safeBatch.push(candidate.fullPath);
    if (safeBatch.length === LAST_USED_XATTR_BATCH_SIZE) flushSafeBatch();
  }
  flushSafeBatch();

  const values = new Map();
  const failures = [];
  let nextJob = 0;
  const worker = async () => {
    while (typeof operationCurrent !== 'function' || operationCurrent()) {
      const jobIndex = nextJob++;
      if (jobIndex >= jobs.length) return;
      const job = jobs[jobIndex];
      try {
        if (job.single) {
          values.set(job.paths[0], await getStrictSingleXattrLastUsedMs(job.paths[0]));
        } else {
          const batchValues = await getBulkXattrLastUsedMs(job.paths);
          for (const [filePath, lastUsedMs] of batchValues) values.set(filePath, lastUsedMs);
        }
      } catch (error) {
        failures.push(error);
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(LAST_USED_XATTR_CONCURRENCY, jobs.length) },
    () => worker()
  ));
  if (failures.length > 0 || values.size !== candidates.length) {
    throw new Error('incomplete xattr acquisition');
  }
  return values;
}

function parseNulDelimitedSpotlightPaths(stdout, rootPath) {
  const output = Buffer.isBuffer(stdout)
    ? stdout
    : Buffer.from(typeof stdout === 'string' ? stdout : '', 'utf8');
  if (output.length === 0) return [];
  if (output[output.length - 1] !== 0) throw new Error('malformed Spotlight output');

  const paths = [];
  let start = 0;
  for (let index = 0; index < output.length; index++) {
    if (output[index] !== 0) continue;
    if (index === start) throw new Error('malformed Spotlight output');
    let filePath;
    try {
      filePath = new TextDecoder('utf-8', { fatal: true }).decode(output.subarray(start, index));
    } catch (_) {
      throw new Error('invalid Spotlight path encoding');
    }
    const relative = path.relative(rootPath, filePath);
    if (
      /[\r\n\0]/.test(filePath) ||
      !path.isAbsolute(filePath) ||
      path.resolve(filePath) !== filePath ||
      path.isAbsolute(relative) ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`)
    ) throw new Error('Spotlight path outside requested root');
    paths.push(filePath);
    start = index + 1;
  }
  return paths;
}

function getRequiredSpotlightRoots(scanDirs) {
  const roots = [];
  const identities = new Set();
  for (const scanDir of scanDirs) {
    if (!fs.existsSync(scanDir)) continue;
    const stat = fs.statSync(scanDir);
    if (!stat.isDirectory()) throw new Error('invalid Spotlight root');
    const identity = normalizeTrackedFilePath(scanDir);
    if (!identity || identities.has(identity)) throw new Error('duplicate Spotlight root');
    identities.add(identity);
    roots.push({
      path: path.resolve(scanDir),
      device: stat.dev,
      inode: stat.ino,
    });
  }
  return roots;
}

function spotlightRootIsUnchanged(root) {
  try {
    const stat = fs.statSync(root.path);
    return stat.isDirectory() && stat.dev === root.device && stat.ino === root.inode;
  } catch (_) {
    return false;
  }
}

function matchSpotlightPathsToCandidateIndexes(spotlightPaths, candidates) {
  const candidateIndexByRoute = new Map();
  for (let index = 0; index < candidates.length; index++) {
    const route = candidates[index] && candidates[index].fullPath;
    if (
      typeof route !== 'string' ||
      route.includes('\0') ||
      !path.isAbsolute(route) ||
      path.resolve(route) !== route
    ) throw new Error('invalid metadata candidate route');
    candidateIndexByRoute.set(route, candidateIndexByRoute.has(route) ? null : index);
  }

  const matchedIndexes = new Set();
  const orderedPaths = [...spotlightPaths].sort(
    (left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
  );
  for (const spotlightPath of orderedPaths) {
    const candidateIndex = candidateIndexByRoute.get(spotlightPath);
    if (Number.isInteger(candidateIndex)) matchedIndexes.add(candidateIndex);
  }
  return matchedIndexes;
}

async function getBulkSpotlightRecentCandidateIndexes(roots, watchStart, candidates, operationCurrent) {
  const timestamp = `$time.iso(${new Date(watchStart).toISOString()})`;
  const queryResults = await Promise.allSettled(roots.map(async root => {
    if (typeof operationCurrent === 'function' && !operationCurrent()) {
      throw new Error('Spotlight query cancelled');
    }
    const { stdout } = await execFileAsync('/usr/bin/mdfind', [
      '-0', '-onlyin', root.path, `kMDItemLastUsedDate >= ${timestamp}`,
    ], {
      timeout: LAST_USED_SPOTLIGHT_TIMEOUT_MS,
      encoding: 'buffer',
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseNulDelimitedSpotlightPaths(stdout, root.path);
  }));
  if (
    queryResults.some(result => result.status === 'rejected') ||
    roots.some(root => !spotlightRootIsUnchanged(root)) ||
    (typeof operationCurrent === 'function' && !operationCurrent())
  ) throw new Error('incomplete Spotlight root query');

  return matchSpotlightPathsToCandidateIndexes(
    queryResults.flatMap(result => result.value),
    candidates
  );
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
  if (typeof record.figmaAssetDedupKey === 'string' && record.figmaAssetDedupKey.trim()) {
    return record.figmaAssetDedupKey.trim();
  }
  if (typeof record.figmaAssetIdentity === 'string' && record.figmaAssetIdentity.trim()) {
    assetKey = record.figmaAssetIdentity.trim();
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
  } else if (typeof record.figmaAssetKey === 'string' && record.figmaAssetKey.trim()) {
    assetKey = record.figmaAssetKey.trim();
    // Older records stored the composite key in figmaAssetKey.  Read that
    // representation compatibly, while all new records store the raw asset
    // component separately from the composite dedup key.
    const legacyPrefix = `${figmaFileKey}:`;
    if (figmaFileKey && assetKey.startsWith(legacyPrefix)) assetKey = assetKey.slice(legacyPrefix.length);
  }

  // Node IDs and CDN URLs are only unique within a Figma file.  Without the
  // authoritative file key, fail closed instead of collapsing unrelated
  // keyless records or allowing a same-name path overwrite downstream.
  if (!figmaFileKey || !assetKey) return null;
  return `${figmaFileKey}:${assetKey}`;
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

function hasExplicitUserAuthority(file) {
  const authority = file && file.explicitUserAuthority;
  return !!(
    authority &&
    authority.granted === true &&
    EXPLICIT_USER_CAPTURE_SOURCES.has(sanitizeLiveEvidenceText(authority.source))
  );
}

function grantExplicitUserAuthority(file, {
  source = 'manual-browse',
  method = 'projects:add-files',
  grantedAt = Date.now(),
} = {}) {
  if (!file || typeof file !== 'object' || !EXPLICIT_USER_CAPTURE_SOURCES.has(source)) return file;
  const existing = isRecord(file.explicitUserAuthority) ? file.explicitUserAuthority : {};
  file.explicitUserAuthority = {
    granted: true,
    source,
    method: sanitizeLiveEvidenceText(method) || 'unknown',
    grantedAt: Number.isFinite(existing.grantedAt) ? existing.grantedAt : grantedAt,
  };
  file.assetOrigin = 'added';
  delete file.assetBaselineSourcePath;
  return file;
}

function isExplicitUserCapturedFile(file) {
  return EXPLICIT_USER_CAPTURE_SOURCES.has(getFileCaptureSource(file)) || hasExplicitUserAuthority(file);
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
  const ext = (file.ext || path.extname(file.path || '') || '').toLowerCase();
  if (getFileCaptureSource(file) === 'chokidar-add' && PRIMARY_DESIGN_EXTENSIONS.has(ext)) {
    return hasTrustedCurrentSessionFilesystemEvidence(project, file.path);
  }
  if (getFileCaptureSource(file)) return false;
  if (!PRIMARY_DESIGN_EXTENSIONS.has(ext)) return false;
  const watchStart = project.watchStartedAt || project.createdAt || 0;
  const addedAt = typeof file.addedAt === 'number' ? file.addedAt : 0;
  return !!(watchStart && addedAt >= watchStart);
}

function startWatchSession(project) {
  if (!project || typeof project !== 'object') return null;
  project.watchSessionId = crypto.randomUUID();
  return project.watchSessionId;
}

function isCurrentWatchSessionPendingFile(project, file) {
  if (!project || !file || (project.status !== 'watching' && project.status !== 'paused')) return true;
  if (isExplicitUserCapturedFile(file) || isAcceptedPendingCapturedFile(project, file)) return true;

  const sessionId = typeof project.watchSessionId === 'string' ? project.watchSessionId.trim() : '';
  const fileSessionId = typeof file.captureSessionId === 'string' ? file.captureSessionId.trim() : '';
  if (sessionId && fileSessionId) {
    return fileSessionId === sessionId;
  }

  const watchStart = Number.isFinite(project.watchStartedAt)
    ? project.watchStartedAt
    : Date.parse(project.watchStartedAt);
  const addedAt = typeof file.addedAt === 'number' ? file.addedAt : Date.parse(file.addedAt);
  return !Number.isFinite(watchStart) || !Number.isFinite(addedAt) || addedAt >= watchStart;
}

function hasPersistedWatcherObservation(project, filePath) {
  const normalizedPath = normalizeTrackedFilePath(filePath);
  if (!project || !normalizedPath || !project.provenance || !Array.isArray(project.provenance.observations)) return false;
  const fileNodeId = createNodeId(NODE_TYPES.FILE, { normalizedPath });
  return project.provenance.observations.some(observation => (
    observation &&
    observation.relationType === EDGE_TYPES.SESSION_OBSERVED_FILE &&
    observation.objectNodeId === fileNodeId &&
    observation.observer &&
    observation.observer.kind === OBSERVER_KINDS.CHOKIDAR &&
    (observation.observer.method === 'add' || observation.observer.method === 'change')
  ));
}

function isPersistedAcceptedWatcherSource(project, file) {
  if (!project || !file || !Array.isArray(project.files)) return false;
  const normalizedPath = normalizeTrackedFilePath(file.path);
  const ext = (file.ext || path.extname(file.path || '') || '').toLowerCase();
  if (!normalizedPath || !PRIMARY_DESIGN_EXTENSIONS.has(ext) || !ILLUSTRATOR_SOURCE_EXTENSIONS.has(ext)) return false;
  if (!project.files.some(acceptedFile => normalizeTrackedFilePath(acceptedFile && acceptedFile.path) === normalizedPath)) return false;
  return hasPersistedWatcherObservation(project, normalizedPath) || (Array.isArray(project.provenance?.observations) && project.provenance.observations.some(observation => (
    observation &&
    observation.relationType === EDGE_TYPES.SESSION_OBSERVED_FILE &&
    observation.objectNodeId === createNodeId(NODE_TYPES.FILE, { normalizedPath }) &&
    observation.observer &&
    observation.observer.kind === OBSERVER_KINDS.APP_SCRIPT &&
    observation.observer.method === 'app-opened' &&
    observation.payload &&
    observation.payload.appFamily === 'illustrator'
  )));
}

function isTrustedSessionProjectFile(project, file) {
  if (!file || typeof file.path !== 'string' || !file.path.trim()) return false;
  if (isAutoCaptureExcludedPath(file.path)) return false;
  if (isExplicitUserCapturedFile(file)) return true;
  if (isAcceptedPendingCapturedFile(project, file)) return true;
  if (isSavedOrConfirmedProjectFile(file)) return true;
  if (isPersistedAcceptedWatcherSource(project, file)) return true;
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

function clearPersistedCurrentSessionFilesystemEvidence(project) {
  if (!project || typeof project !== 'object') return false;
  let changed = false;
  for (const collection of [project.files, project.pendingFiles]) {
    if (!Array.isArray(collection)) continue;
    for (const file of collection) {
      if (file && Object.prototype.hasOwnProperty.call(file, 'currentSessionFilesystemEvidence')) {
        delete file.currentSessionFilesystemEvidence;
        changed = true;
      }
    }
  }
  return changed;
}

function normalizeAutoCaptureProjectState(project) {
  if (!project || typeof project !== 'object') return false;
  let changed = clearPersistedCurrentSessionFilesystemEvidence(project);

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

function sanitizeRendererSourceName(value) {
  const safe = sanitizeLiveEvidenceText(value);
  if (!safe || /[\\/]/.test(safe) || /^[a-z][a-z0-9+.-]*:/i.test(safe)) return null;
  return safe;
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

function areLiveAppStatusBreadcrumbsEquivalent(previous, next) {
  if (!previous || !next) return false;
  const previousSemantic = { ...previous };
  const nextSemantic = { ...next };
  delete previousSemantic.observedAt;
  delete nextSemantic.observedAt;
  return JSON.stringify(previousSemantic) === JSON.stringify(nextSemantic);
}

function recordLiveAppStatusBreadcrumb(projectId, appFamily, input = {}) {
  const safeAppFamily = normalizeLiveCaptureReason(appFamily, 'live-app');
  const entry = buildLiveAppStatusBreadcrumb(safeAppFamily, input);
  mutateProject(projectId, (project) => {
    if (!project || typeof project !== 'object') return null;
    const currentStatus = project.liveAppEvidenceStatus;
    const currentApps = currentStatus && typeof currentStatus === 'object' && !Array.isArray(currentStatus) &&
      currentStatus.apps && typeof currentStatus.apps === 'object' && !Array.isArray(currentStatus.apps)
      ? currentStatus.apps
      : {};
    const currentAppStatus = currentApps[safeAppFamily];
    const currentEntries = currentAppStatus && Array.isArray(currentAppStatus.entries)
      ? currentAppStatus.entries
      : [];
    const currentLatest = currentAppStatus && currentAppStatus.latest
      ? currentAppStatus.latest
      : currentEntries[currentEntries.length - 1];
    if (areLiveAppStatusBreadcrumbsEquivalent(currentLatest, entry)) {
      return { changed: false };
    }

    if (!currentStatus || typeof currentStatus !== 'object' || Array.isArray(currentStatus)) {
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
    return { changed: true, liveAppEvidenceStatus: project.liveAppEvidenceStatus };
  }, { persistIfChanged: true, trustResultChanged: true });
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
  if (!classification || !classification.evidence || !classification.evidenceSummary) return false;
  const previousLedger = project && project.liveEvidenceLedger;
  const previousCandidateLimit = previousLedger && previousLedger.candidateLimit;
  const ledger = getLiveEvidenceLedger(project);
  if (!ledger) return false;
  const ledgerShapeChanged = previousCandidateLimit !== ledger.candidateLimit;
  const summary = classification.evidenceSummary;
  const key = summary.evidenceKey || classification.evidence.evidenceKeyHash;
  if (!key) return false;
  const existing = ledger.candidates[key] || {
    evidenceKey: key,
    firstObservedAt: summary.observedAt || new Date().toISOString(),
    strongestState: LIVE_CAPTURE_STATES.IGNORED,
    observations: [],
  };
  // Repeated lsof/live-app observations carry a fresh timestamp but no new
  // evidence. Avoid rewriting the ledger for that semantic no-op; a changed
  // capture state, source, or relationship still falls through and persists.
  if (existing.latest) {
    const comparable = (value) => {
      const copy = { ...value };
      delete copy.observedAt;
      return JSON.stringify(copy);
    };
    if (comparable(existing.latest) === comparable(summary)) return ledgerShapeChanged;
  }
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
  return true;
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

  const captureSessionId = typeof observation.captureSessionId === 'string'
    ? observation.captureSessionId.trim()
    : '';
  if (captureSessionId) captureEvidence.captureSessionId = captureSessionId;

  return {
    ...fileEntry,
    captureState,
    captureReason: reason,
    captureEvidence,
    ...(captureSessionId ? {
      captureSessionId,
      captureSessionObserved: observation.captureSessionObserved !== false,
    } : {}),
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

function getAcceptedPendingAppFamily(fileEntry) {
  const appFamily = getExactAppFamilyMarker(fileEntry?.acceptedPendingAppFamily)
    || getExplicitCaptureAppFamily(fileEntry);
  return appFamily && appFamily !== 'generic' ? appFamily : null;
}

function createAcceptedPendingFile(fileEntry) {
  const acceptedFile = {
    ...stripLiveCaptureMetadata(fileEntry),
    acceptedPending: true,
  };
  const appFamily = getAcceptedPendingAppFamily(fileEntry);
  if (appFamily) acceptedFile.acceptedPendingAppFamily = appFamily;
  return acceptedFile;
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
  const excludedByGeneratedOutput = observation.projectCollection
    ? isAutoCaptureExcludedPath(fileEntry.path, observation.projectCollection)
    : isAutoCaptureExcludedPath(fileEntry.path);
  if (excludedByGeneratedOutput) {
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

  if (isAssetReviewFileExcluded(project, fileEntry)) {
    const reason = 'user-excluded-asset';
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
  observation = {
    ...observation,
    appFamily: getLiveCaptureAppFamily(fileEntry, observation) || 'generic',
    captureSessionId: observation.captureSessionId || project?.watchSessionId || null,
  };
  if (!isIllustratorScopedFileAllowed(project, fileEntry, observation)) return { decision: LIVE_CAPTURE_DECISIONS.IGNORE_EXCLUDED, changed: false, file: fileEntry, reason: 'illustrator-activation-scope', captureReason: 'illustrator-activation-scope', captureState: LIVE_CAPTURE_STATES.IGNORED, normalizedPath: normalizeTrackedFilePath(fileEntry && fileEntry.path) };
  const classification = classifyLiveObservedFile(project, fileEntry, observation);
  const normalizedPath = classification.normalizedPath;
  const evidenceChanged = recordLiveEvidence(project, fileEntry, classification);

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
    return { ...classification, changed: true, evidenceChanged, file: stagedFile };
  }

  if (classification.decision === LIVE_CAPTURE_DECISIONS.UPDATE_PENDING) {
    if (!Array.isArray(project.pendingFiles)) project.pendingFiles = [];
    const candidateKey = getTrackedFileDedupKey(fileEntry);
    const idx = project.pendingFiles.findIndex(file => (
      getTrackedFileDedupKey(file) === candidateKey ||
      normalizeTrackedFilePath(file && file.path) === normalizedPath
    ));
    if (idx === -1) return { ...classification, changed: false, evidenceChanged, file: fileEntry };
    const nextFile = decorateLiveObservedFile({
      ...project.pendingFiles[idx],
      source: fileEntry.source || project.pendingFiles[idx].source,
      ext: fileEntry.ext || project.pendingFiles[idx].ext,
      name: fileEntry.name || project.pendingFiles[idx].name,
    }, classification, observation);
    project.pendingFiles[idx] = nextFile;
    return { ...classification, changed: true, evidenceChanged, file: nextFile };
  }

  if (
    classification.decision === LIVE_CAPTURE_DECISIONS.KEEP_EXISTING &&
    observation.captureSessionId &&
    observation.captureSessionObserved !== false
  ) {
    const candidateKey = getTrackedFileDedupKey(fileEntry);
    const idx = (project.pendingFiles || []).findIndex(file => (
      getTrackedFileDedupKey(file) === candidateKey ||
      normalizeTrackedFilePath(file && file.path) === normalizedPath
    ));
    const existingFile = idx === -1 ? null : project.pendingFiles[idx];
    if (existingFile && (
      existingFile.captureSessionId !== observation.captureSessionId ||
      existingFile.captureSessionObserved === false
    )) {
      project.pendingFiles[idx] = {
        ...existingFile,
        captureSessionId: observation.captureSessionId,
        captureSessionObserved: observation.captureSessionObserved !== false,
      };
      return { ...classification, changed: true, evidenceChanged, file: project.pendingFiles[idx] };
    }
  }

  if (classification.decision === LIVE_CAPTURE_DECISIONS.PENDING_CANDIDATE) {
    const stagedFile = decorateLiveObservedFile(fileEntry, classification, observation);
    if (!Array.isArray(project.pendingFiles)) project.pendingFiles = [];
    project.pendingFiles.push(stagedFile);
    return { ...classification, changed: true, evidenceChanged, file: stagedFile };
  }

  return { ...classification, changed: false, evidenceChanged, file: fileEntry };
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
const FIGMA_MAX_RATE_LIMIT_BACKOFF_MS = 31 * 24 * 60 * 60 * 1000;
const FIGMA_LINK_PREFLIGHT_TIMEOUT_MS = 12_000;
const FIGMA_CONNECTION_STATUS_REASON = 'figma-connection-invalid';
const FIGMA_CONNECTION_WARNING = 'Figma is not connected. Reconnect in Settings. No Figma assets will be captured until the connection is restored.';
const FIGMA_FAILURE_CATEGORIES = new Set([
  'connection',
  'rate-limited',
  'file-access',
  'scope',
  'unknown',
  'informational',
]);
const FIGMA_SCOPE_FAILURE_STATUS_REASONS = new Set([
  'figma-current-page-no-page-or-node-param',
  'figma-current-page-requested-page-not-found',
  'figma-current-page-requested-node-not-found',
  'figma-current-page-prototype-link-file-fetch-failed',
]);
const VALID_FIGMA_SCOPE_MODES = new Set([FIGMA_SCOPE_CURRENT_PAGE, FIGMA_SCOPE_ENTIRE_FILE]);
const figmaLinkValidationInFlight = new Map();
const figmaLinkValidationOccupancy = new Map();

function getProjectFigmaScopeMode(project) {
  const projectMode = project && project.figmaScopeMode;
  if (VALID_FIGMA_SCOPE_MODES.has(projectMode)) return projectMode;

  return FIGMA_SCOPE_CURRENT_PAGE;
}

function normalizeStoredFigmaScopeId(value) {
  const { FigmaParser } = require('./parsers/figma');
  const normalized = FigmaParser.normalizeNodeId(value);
  if (!normalized || normalized.length > 120) return null;
  return /^\d+:\d+(?::\d+)*$/.test(normalized) ? normalized : null;
}

function normalizeFigmaFailureCategory(value) {
  return FIGMA_FAILURE_CATEGORIES.has(value) ? value : null;
}

function getFigmaFailureCategory(scope = {}) {
  if (!scope || typeof scope !== 'object') return null;
  const statusReason = typeof scope.statusReason === 'string' ? scope.statusReason : '';
  const fileFetchFailureReason = typeof scope.fileFetchFailureReason === 'string'
    ? scope.fileFetchFailureReason
    : '';

  if (
    statusReason === FIGMA_CONNECTION_STATUS_REASON ||
    fileFetchFailureReason === 'not-connected' ||
    fileFetchFailureReason === 'invalid-token'
  ) return 'connection';
  if (
    statusReason === 'figma-current-page-rate-limited' ||
    fileFetchFailureReason === 'rate-limited'
  ) return 'rate-limited';
  if (statusReason === 'figma-current-page-zero-image-refs') return 'informational';
  if (FIGMA_SCOPE_FAILURE_STATUS_REASONS.has(statusReason)) return 'scope';
  if (
    fileFetchFailureReason === 'access-denied' ||
    fileFetchFailureReason === 'file-not-found'
  ) return 'file-access';
  if (statusReason === 'figma-current-page-file-fetch-failed' || fileFetchFailureReason) return 'unknown';
  return null;
}

function sanitizeStoredFigmaSessionText(value, maxLength) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return redactFigmaLogText(value.trim()).slice(0, maxLength);
}

function normalizeFigmaRateLimitRetryAt(value) {
  const now = Date.now();
  if (!Number.isSafeInteger(value) || value <= now) return null;
  return value <= now + FIGMA_MAX_RATE_LIMIT_BACKOFF_MS ? value : null;
}

function normalizeTrackedFigmaFiles(rawTrackedFiles) {
  const { FigmaParser } = require('./parsers/figma');

  const normalizeCandidateKeyDetails = (primaryKey, url = null, rawCandidateKeys = [], rawCandidateDetails = []) => {
    const details = [];
    const seen = new Set();
    const pushKey = (value, source = 'unknown') => {
      if (typeof value !== 'string' || !value.trim()) return;
      const normalized = FigmaParser._normalizeFigmaFileKey(value);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      details.push({
        key: normalized,
        source: formatFigmaLogScalar(source, 'unknown')
      });
    };

    const urlCandidateDetails = url ? FigmaParser._figmaFileKeyCandidateDetails(url) : [];
    const urlSourceByKey = new Map(urlCandidateDetails.map(candidate => [candidate.key, candidate.source]));
    const storedSourceByKey = new Map(
      (Array.isArray(rawCandidateDetails) ? rawCandidateDetails : [])
        .filter(candidate => candidate && typeof candidate.key === 'string' && candidate.key.trim())
        .map(candidate => [candidate.key.trim(), candidate.source || 'stored-candidate'])
    );
    pushKey(primaryKey, urlSourceByKey.get(primaryKey) || storedSourceByKey.get(primaryKey) || 'primary');
    if (url) {
      for (const candidate of urlCandidateDetails) {
        pushKey(candidate.key, candidate.source);
      }
    }
    for (const candidate of Array.isArray(rawCandidateKeys) ? rawCandidateKeys : []) {
      pushKey(candidate, urlSourceByKey.get(candidate) || storedSourceByKey.get(candidate) || 'stored-candidate');
    }
    for (const candidate of Array.isArray(rawCandidateDetails) ? rawCandidateDetails : []) {
      if (!candidate || typeof candidate !== 'object') continue;
      pushKey(candidate.key, candidate.source || urlSourceByKey.get(candidate.key) || 'stored-candidate');
    }
    return details;
  };

  return (Array.isArray(rawTrackedFiles) ? rawTrackedFiles : [])
    .map((entry) => {
      let key = '';
      let url = null;
      let rawCandidateKeys = [];
      let rawCandidateDetails = [];
      let storedRequestedPageId = null;
      let storedRequestedNodeId = null;

      if (typeof entry === 'string') {
        const trimmed = entry.trim();
        if (!trimmed) return null;
        const parsedKey = FigmaParser.extractFileKey(trimmed);
        key = parsedKey || FigmaParser._normalizeFigmaFileKey(trimmed) || '';
        url = parsedKey ? trimmed : null;
      } else {
        if (!entry || typeof entry !== 'object') return null;
        url = typeof entry.url === 'string' && entry.url.trim() ? entry.url.trim() : null;
        const parsedKey = url ? FigmaParser.extractFileKey(url) : null;
        key = parsedKey || FigmaParser._normalizeFigmaFileKey(entry.key) || '';
        if (!parsedKey) url = null;
        rawCandidateKeys = entry.candidateKeys;
        rawCandidateDetails = entry.candidateKeyDetails;
        storedRequestedPageId = entry.requestedPageId;
        storedRequestedNodeId = entry.requestedNodeId;
      }

      if (!key) return null;
      const parsedScope = url
        ? FigmaParser.parseScopeFromTrackedUrl(url)
        : { requestedPageId: null, requestedNodeId: null };
      const requestedPageId = normalizeStoredFigmaScopeId(storedRequestedPageId)
        || normalizeStoredFigmaScopeId(parsedScope.requestedPageId);
      const requestedNodeId = normalizeStoredFigmaScopeId(storedRequestedNodeId)
        || normalizeStoredFigmaScopeId(parsedScope.requestedNodeId);
      const candidateKeyDetails = normalizeCandidateKeyDetails(key, url, rawCandidateKeys, rawCandidateDetails);
      const candidateKeys = candidateKeyDetails.map(candidate => candidate.key);
      return {
        key,
        candidateKeys,
        candidateKeyDetails,
        requestedPageId,
        requestedNodeId,
      };
    })
    .filter(Boolean);
}

function createTrackedFigmaLocator(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  const { FigmaParser } = require('./parsers/figma');
  const trimmedUrl = rawUrl.trim();
  const fileKey = FigmaParser.extractFileKey(trimmedUrl);
  if (!fileKey) return null;
  return normalizeTrackedFigmaFiles([{ key: fileKey, url: trimmedUrl }])[0] || null;
}

function figmaLinkPreflightErrorForReason(reason) {
  if (reason === 'not-connected') return 'figma_not_connected';
  if (reason === 'invalid-token') return 'figma_invalid_token';
  if (reason === 'rate-limited') return 'figma_rate_limited';
  if (reason === 'access-denied' || reason === 'file-not-found') return 'figma_file_unavailable';
  if (
    reason === 'figma-current-page-no-page-or-node-param' ||
    reason === 'figma-current-page-requested-page-not-found' ||
    reason === 'figma-current-page-requested-node-not-found'
  ) {
    return 'figma_scope_unresolved';
  }
  return 'figma_verification_failed';
}

async function preflightTrackedFigmaLocator(locator, scopeMode) {
  if (!locator) return { success: false, error: 'invalid_figma_url' };
  const effectiveScopeMode = VALID_FIGMA_SCOPE_MODES.has(scopeMode)
    ? scopeMode
    : FIGMA_SCOPE_CURRENT_PAGE;
  if (
    effectiveScopeMode === FIGMA_SCOPE_CURRENT_PAGE &&
    !locator.requestedPageId &&
    !locator.requestedNodeId
  ) {
    return { success: false, error: 'figma_scope_unresolved' };
  }

  const { FigmaParser } = require('./parsers/figma');
  const {
    finalizeFigmaNetworkOperationTracking,
    trackFigmaNetworkOperation,
  } = require('./parsers/figma-network');
  const parser = new FigmaParser();
  let finalError = 'figma_verification_failed';
  const deadlineAt = Date.now() + FIGMA_LINK_PREFLIGHT_TIMEOUT_MS;

  for (const candidate of figmaTrackedFileKeyDetails(locator)) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) return { success: false, error: 'figma_verification_failed' };
    const validationKey = JSON.stringify([
      candidate.key,
      effectiveScopeMode,
      locator.requestedPageId || null,
      locator.requestedNodeId || null,
    ]);
    if (
      figmaLinkValidationInFlight.has(validationKey) ||
      figmaLinkValidationOccupancy.has(validationKey)
    ) {
      return { success: false, error: 'figma_verification_failed' };
    }
    const controller = new AbortController();
    const underlyingSettlement = trackFigmaNetworkOperation(controller.signal);
    const occupancy = {
      underlyingSettled: false,
      validationSettled: false,
    };
    const clearOccupancyIfSettled = () => {
      if (
        occupancy.underlyingSettled &&
        occupancy.validationSettled &&
        figmaLinkValidationOccupancy.get(validationKey) === occupancy
      ) {
        figmaLinkValidationOccupancy.delete(validationKey);
      }
    };
    underlyingSettlement.then(() => {
      occupancy.underlyingSettled = true;
      clearOccupancyIfSettled();
    });
    let timeoutId = null;
    const timeoutResult = { valid: false, reason: 'timeout' };
    let validationPromise = Promise.resolve().then(() => parser.validateTrackedFileScope(
      candidate.key,
      {
        key: candidate.key,
        scopeMode: effectiveScopeMode,
        requestedPageId: locator.requestedPageId || null,
        requestedNodeId: locator.requestedNodeId || null,
      },
      { signal: controller.signal }
    )).catch(() => ({ valid: false, reason: 'request-failed' }));
    validationPromise = validationPromise.finally(() => {
      finalizeFigmaNetworkOperationTracking(controller.signal);
      occupancy.validationSettled = true;
      clearOccupancyIfSettled();
      if (figmaLinkValidationInFlight.get(validationKey) === validationPromise) {
        figmaLinkValidationInFlight.delete(validationKey);
      }
    });
    figmaLinkValidationOccupancy.set(validationKey, occupancy);
    figmaLinkValidationInFlight.set(validationKey, validationPromise);
    let validation = null;
    try {
      validation = await Promise.race([
        validationPromise,
        new Promise(resolve => {
          timeoutId = setTimeout(() => resolve(timeoutResult), remainingMs);
        }),
      ]);
    } catch (_) {
      validation = { valid: false, reason: 'request-failed' };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
    if (Date.now() >= deadlineAt || validation === timeoutResult) {
      controller.abort();
      if (figmaLinkValidationInFlight.get(validationKey) === validationPromise) {
        figmaLinkValidationInFlight.delete(validationKey);
      }
      return { success: false, error: 'figma_verification_failed' };
    }
    if (validation && validation.valid) {
      return {
        success: true,
        resolvedKey: candidate.key,
        scope: validation.scope || null,
      };
    }

    const error = figmaLinkPreflightErrorForReason(validation && validation.reason);
    if (error === 'figma_not_connected' || error === 'figma_invalid_token' || error === 'figma_rate_limited') {
      return { success: false, error };
    }
    if (error === 'figma_scope_unresolved') finalError = error;
    else if (error === 'figma_file_unavailable' && finalError === 'figma_verification_failed') finalError = error;
  }

  return { success: false, error: finalError };
}

async function preflightProjectFigmaConnection(project) {
  const trackedFiles = normalizeTrackedFigmaFiles((project && project.figmaTrackedFiles) || []);
  const scopeMode = getProjectFigmaScopeMode(project);
  const preflights = [];
  for (const trackedFile of trackedFiles) {
    const preflight = await preflightTrackedFigmaLocator(trackedFile, scopeMode);
    if (!preflight.success) return { success: false, error: preflight.error };
    preflights.push(preflight);
  }
  return { success: true, preflights };
}

function figmaLocatorMatches(left, right) {
  const leftKeys = new Set(figmaTrackedFileKeys(left));
  return figmaTrackedFileKeys(right).some(key => leftKeys.has(key));
}

function mergeFigmaLocators(primary, fallback) {
  const normalized = normalizeTrackedFigmaFiles([primary, fallback].filter(Boolean));
  if (normalized.length === 0) return null;

  const first = normalized[0];
  const candidateKeyDetails = [];
  const seen = new Set();
  for (const locator of normalized) {
    for (const candidate of locator.candidateKeyDetails || []) {
      if (!candidate || typeof candidate.key !== 'string' || seen.has(candidate.key)) continue;
      seen.add(candidate.key);
      candidateKeyDetails.push(candidate);
    }
  }

  const fallbackLocator = normalized[1] || null;
  const primaryHasRequestedScope = !!(first.requestedPageId || first.requestedNodeId);
  const fallbackHasRequestedScope = !!(
    fallbackLocator &&
    (fallbackLocator.requestedPageId || fallbackLocator.requestedNodeId)
  );
  const selectedScopeLocator = primaryHasRequestedScope
    ? first
    : (fallbackHasRequestedScope ? fallbackLocator : first);

  return {
    key: first.key,
    candidateKeys: candidateKeyDetails.map(candidate => candidate.key),
    candidateKeyDetails,
    requestedPageId: selectedScopeLocator.requestedPageId || null,
    requestedNodeId: selectedScopeLocator.requestedNodeId || null,
  };
}

function migrateProjectFigmaLinkPrivacy(project) {
  if (!project || typeof project !== 'object') return false;
  const { FigmaParser } = require('./parsers/figma');

  const before = JSON.stringify({
    figmaTrackedFiles: project.figmaTrackedFiles,
    figmaSession: project.figmaSession,
  });
  const session = project.figmaSession && typeof project.figmaSession === 'object'
    ? project.figmaSession
    : null;
  const rawSessionTrackedFiles = session && Array.isArray(session.trackedFiles)
    ? session.trackedFiles
    : [];
  const normalizedSessionEntries = rawSessionTrackedFiles
    .map(rawEntry => ({
      rawEntry,
      locator: normalizeTrackedFigmaFiles([rawEntry])[0] || null,
    }))
    .filter(entry => entry.locator);
  const normalizedSessionLocators = normalizedSessionEntries.map(entry => entry.locator);
  const normalizedProjectLocators = normalizeTrackedFigmaFiles(project.figmaTrackedFiles || []);
  const migrationLocators = normalizedProjectLocators.length > 0
    ? normalizedProjectLocators
    : normalizedSessionLocators;
  const mergedProjectLocators = migrationLocators.map(locator => {
    const sessionLocator = normalizedSessionLocators.find(candidate => figmaLocatorMatches(locator, candidate));
    return mergeFigmaLocators(locator, sessionLocator);
  }).filter(Boolean);

  project.figmaTrackedFiles = mergedProjectLocators;

  if (session) {
    const persistedRateLimitRetryAt = normalizeFigmaRateLimitRetryAt(session.rateLimitRetryAt);
    const rebuiltSession = buildFigmaSessionSnapshot(project);
    session.scopeMode = rebuiltSession.scopeMode;
    session.teamIds = rebuiltSession.teamIds;
    session.trackedFiles = rebuiltSession.trackedFiles.map((rebuiltEntry, index) => {
      const locator = mergedProjectLocators[index];
      const source = normalizedSessionEntries.find(entry => figmaLocatorMatches(locator, entry.locator));
      const rawSessionEntry = source && source.rawEntry && typeof source.rawEntry === 'object'
        ? source.rawEntry
        : null;
      const sourceScopeMatchesLocator = !!(
        source &&
        source.locator &&
        source.locator.requestedPageId === locator.requestedPageId &&
        source.locator.requestedNodeId === locator.requestedNodeId
      );
      if (
        !rawSessionEntry ||
        rawSessionEntry.scopeMode !== rebuiltSession.scopeMode ||
        !sourceScopeMatchesLocator
      ) {
        return rebuiltEntry;
      }

      const allowedKeys = new Set(figmaTrackedFileKeys(locator));
      const normalizedResolvedKey = FigmaParser._normalizeFigmaFileKey(rawSessionEntry.resolvedKey);
      const resolvedKey = normalizedResolvedKey && allowedKeys.has(normalizedResolvedKey)
        ? normalizedResolvedKey
        : null;
      if (rebuiltSession.scopeMode === FIGMA_SCOPE_ENTIRE_FILE) {
        if (rawSessionEntry.lockStatus !== 'entire-file') return rebuiltEntry;
        return {
          ...rebuiltEntry,
          ...(resolvedKey ? { resolvedKey } : {}),
          scopeMode: FIGMA_SCOPE_ENTIRE_FILE,
          lockStatus: 'entire-file',
        };
      }

      const lockStatus = rawSessionEntry.lockStatus;
      if (!new Set(['locked', 'pending', 'unresolved']).has(lockStatus)) {
        return rebuiltEntry;
      }

      let lockedPageId = null;
      if (lockStatus === 'locked') {
        lockedPageId = normalizeStoredFigmaScopeId(rawSessionEntry.lockedPageId);
        if (!lockedPageId) return rebuiltEntry;
        if (rebuiltEntry.requestedPageId && lockedPageId !== rebuiltEntry.requestedPageId) {
          return rebuiltEntry;
        }
      }

      return {
        ...rebuiltEntry,
        ...(resolvedKey ? { resolvedKey } : {}),
        lockStatus,
        lockedPageId,
        lockedPageName: lockStatus === 'locked'
          ? sanitizeStoredFigmaSessionText(rawSessionEntry.lockedPageName, 200)
          : null,
        statusReason: sanitizeStoredFigmaSessionText(rawSessionEntry.statusReason, 160)
          || rebuiltEntry.statusReason,
        failureCategory: normalizeFigmaFailureCategory(rawSessionEntry.failureCategory)
          || getFigmaFailureCategory({
            statusReason: rawSessionEntry.statusReason || rebuiltEntry.statusReason,
            fileFetchFailureReason: rawSessionEntry.fileFetchFailureReason,
          })
          || rebuiltEntry.failureCategory
          || null,
        warning: sanitizeStoredFigmaSessionText(rawSessionEntry.warning, 500)
          || rebuiltEntry.warning,
        scopeMode: FIGMA_SCOPE_CURRENT_PAGE,
      };
    });
    session.sessionWarnings = (Array.isArray(session.sessionWarnings) ? session.sessionWarnings : [])
      .map(warning => sanitizeStoredFigmaSessionText(warning, 500))
      .filter(Boolean);
    if (persistedRateLimitRetryAt) session.rateLimitRetryAt = persistedRateLimitRetryAt;
    else delete session.rateLimitRetryAt;
    session.warnings = rebuildFigmaSessionWarnings(session);
  }

  const after = JSON.stringify({
    figmaTrackedFiles: project.figmaTrackedFiles,
    figmaSession: project.figmaSession,
  });
  return before !== after;
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

function markProjectFigmaConnectionUnavailable(projectId) {
  ensureProjectFigmaSession(projectId);
  return mutateProject(projectId, (project) => {
    const session = project.figmaSession;
    if (!session || !Array.isArray(session.trackedFiles)) return null;
    let changed = false;
    if (!Array.isArray(session.sessionWarnings)) session.sessionWarnings = [];
    if (!session.sessionWarnings.includes(FIGMA_CONNECTION_WARNING)) {
      session.sessionWarnings.push(FIGMA_CONNECTION_WARNING);
      changed = true;
    }
    for (const trackedFile of session.trackedFiles) {
      if (trackedFile.scopeMode === FIGMA_SCOPE_CURRENT_PAGE && trackedFile.lockStatus !== 'unresolved') {
        trackedFile.lockStatus = 'unresolved';
        trackedFile.lockedPageId = null;
        trackedFile.lockedPageName = null;
        changed = true;
      }
      if (trackedFile.statusReason !== FIGMA_CONNECTION_STATUS_REASON) {
        trackedFile.statusReason = FIGMA_CONNECTION_STATUS_REASON;
        changed = true;
      }
      if (trackedFile.failureCategory !== 'connection') {
        trackedFile.failureCategory = 'connection';
        changed = true;
      }
      if (trackedFile.warning !== FIGMA_CONNECTION_WARNING) {
        trackedFile.warning = FIGMA_CONNECTION_WARNING;
        changed = true;
      }
    }
    const warnings = rebuildFigmaSessionWarnings(session);
    if (JSON.stringify(session.warnings || []) !== JSON.stringify(warnings)) {
      session.warnings = warnings;
      changed = true;
    }
    return changed ? { changed: true, figmaSession: session } : null;
  }, { persistIfChanged: true, trustResultChanged: true });
}

function clearProjectFigmaConnectionUnavailable(projectId, verifiedPreflights = []) {
  return mutateProject(projectId, (project) => {
    const session = project.figmaSession;
    if (!session || !Array.isArray(session.trackedFiles)) return null;
    const rebuilt = buildFigmaSessionSnapshot(project);
    let changed = false;
    const nextSessionWarnings = (session.sessionWarnings || []).filter(warning => warning !== FIGMA_CONNECTION_WARNING);
    if (JSON.stringify(session.sessionWarnings || []) !== JSON.stringify(nextSessionWarnings)) {
      session.sessionWarnings = nextSessionWarnings;
      changed = true;
    }
    for (let index = 0; index < session.trackedFiles.length; index++) {
      const trackedFile = session.trackedFiles[index];
      if (
        trackedFile.statusReason !== FIGMA_CONNECTION_STATUS_REASON &&
        trackedFile.warning !== FIGMA_CONNECTION_WARNING
      ) continue;
      const rebuiltReplacement = rebuilt.trackedFiles[index];
      const verified = verifiedPreflights[index] || null;
      if (!rebuiltReplacement || !verified || !verified.scope) continue;
      const replacement = {
        ...rebuiltReplacement,
        ...(verified.resolvedKey ? { resolvedKey: verified.resolvedKey } : {}),
        lockStatus: verified.scope.lockStatus,
        lockedPageId: verified.scope.lockedPageId,
        lockedPageName: verified.scope.lockedPageName,
        statusReason: verified.scope.statusReason,
        failureCategory: getFigmaFailureCategory(verified.scope),
        warning: null,
      };
      for (const field of ['resolvedKey', 'lockStatus', 'lockedPageId', 'lockedPageName', 'statusReason', 'failureCategory', 'warning']) {
        if (trackedFile[field] === replacement[field]) continue;
        trackedFile[field] = replacement[field];
        changed = true;
      }
    }
    const warnings = rebuildFigmaSessionWarnings(session);
    if (JSON.stringify(session.warnings || []) !== JSON.stringify(warnings)) {
      session.warnings = warnings;
      changed = true;
    }
    return changed ? { changed: true, figmaSession: session } : null;
  }, { persistIfChanged: true, trustResultChanged: true });
}

function buildFigmaSessionSnapshot(project, _settings = {}) {
  const scopeMode = getProjectFigmaScopeMode(project);
  const trackedFiles = normalizeTrackedFigmaFiles((project && project.figmaTrackedFiles) || []);
  const rateLimitRetryAt = normalizeFigmaRateLimitRetryAt(
    project && project.figmaSession && project.figmaSession.rateLimitRetryAt
  );
  const sessionWarnings = [];

  const snapshot = {
    scopeMode,
    startedAt: project.watchStartedAt || Date.now(),
    teamIds: [],
    trackedFiles: trackedFiles.map((trackedFile) => {
      const requestedPageId = trackedFile.requestedPageId || null;
      const requestedNodeId = trackedFile.requestedNodeId || null;

      let lockStatus = scopeMode === FIGMA_SCOPE_CURRENT_PAGE ? 'pending' : 'entire-file';
      let warning = null;
      let lockedPageId = null;
      let statusReason = null;
      let failureCategory = null;

      if (scopeMode === FIGMA_SCOPE_CURRENT_PAGE) {
        if (!requestedPageId && !requestedNodeId) {
          lockStatus = 'unresolved';
          statusReason = 'figma-current-page-no-page-or-node-param';
          failureCategory = 'scope';
          warning = 'Current Page Only could not find a page or node in the linked Figma location. No Figma assets will be captured for this file in this session.';
        } else if (requestedPageId) {
          lockStatus = 'locked';
          lockedPageId = requestedPageId;
        } else if (requestedNodeId) {
          statusReason = 'figma-current-page-node-param-parsed';
        }
      }

      return {
        key: trackedFile.key,
        candidateKeys: trackedFile.candidateKeys,
        candidateKeyDetails: trackedFile.candidateKeyDetails,
        requestedPageId,
        requestedNodeId,
        lockStatus,
        lockedPageId,
        lockedPageName: null,
        scopeMode,
        statusReason,
        failureCategory,
        warning,
      };
    }),
    sessionWarnings,
  };

  if (rateLimitRetryAt) {
    const warning = figmaRateLimitWarning();
    snapshot.rateLimitRetryAt = rateLimitRetryAt;
    for (const trackedFile of snapshot.trackedFiles) {
      trackedFile.lockStatus = 'unresolved';
      trackedFile.statusReason = 'figma-current-page-rate-limited';
      trackedFile.failureCategory = 'rate-limited';
      trackedFile.warning = warning;
    }
  }

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
      const nextStatusReason = Object.prototype.hasOwnProperty.call(nextScope, 'statusReason')
        ? nextScope.statusReason
        : trackedFile.statusReason;
      const nextFailureCategory = normalizeFigmaFailureCategory(nextScope.failureCategory)
        || getFigmaFailureCategory(nextScope)
        || null;
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
      if (trackedFile.failureCategory !== nextFailureCategory) {
        trackedFile.failureCategory = nextFailureCategory;
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

    return changed ? { changed: true, figmaSession: project.figmaSession } : null;
  }, { persistIfChanged: true, trustResultChanged: true });
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
  '.afdesign', '.afphoto', '.afpub', '.key', '.pptx', '.ppt', '.pxd',
]);

const ASSET_REVIEW_SCHEMA_VERSION = 1;
const ASSET_BASELINE_STATUSES = new Set([
  'awaiting-first-scan',
  'decision-required',
  'included',
  'skipped',
  'empty',
  'legacy-included',
  'invalid',
]);
const ASSET_BASELINE_DECISIONS = new Set(['include', 'skip']);
const ASSET_ORIGINS = new Set(['existing', 'added']);
const PROJECT_FILE_ROLES = new Set(['source', 'asset']);
const ASSET_BASELINE_SOURCE_RECOVERY_KEY_PATTERN = /^[a-f0-9]{64}$/;
const ASSET_BASELINE_SOURCE_RECOVERY_SCHEMA_VERSION = 1;
const DEPENDENCY_CAPTURE_SOURCES = new Set([
  'ai-linked',
  'indd-poll',
  'indd-linked',
  'ps-poll',
  'psd-linked',
  'psd-embedded',
  'scan-on-open',
  'scan-on-save-linked',
  'scan-on-save-embedded',
  'scan-on-save-presentation',
  'embedded-media',
  'figma-auto',
]);

function createAssetBaselineState(status = 'awaiting-first-scan', project = null) {
  const legacy = status === 'legacy-included';
  const establishedAt = legacy
    ? (Number.isFinite(project && project.watchStartedAt)
      ? project.watchStartedAt
      : (Number.isFinite(project && project.createdAt) ? project.createdAt : null))
    : null;
  return {
    schemaVersion: ASSET_REVIEW_SCHEMA_VERSION,
    status,
    decision: legacy ? 'include' : null,
    establishedAt,
  };
}

function normalizePresentationMediaOccurrences(value) {
  const occurrences = [];
  const seen = new Set();
  for (const occurrence of Array.isArray(value) ? value : []) {
    if (
      !occurrence ||
      typeof occurrence.resourceKey !== 'string' ||
      !occurrence.resourceKey ||
      !isPackageContentFingerprint(occurrence.contentFingerprint)
    ) continue;
    const key = `${occurrence.resourceKey}:${occurrence.contentFingerprint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    occurrences.push({
      resourceKey: occurrence.resourceKey,
      contentFingerprint: occurrence.contentFingerprint,
    });
  }
  return occurrences.sort((left, right) => (
    left.resourceKey.localeCompare(right.resourceKey) ||
    left.contentFingerprint.localeCompare(right.contentFingerprint)
  ));
}

function inferProjectFileRole(file) {
  if (!file || typeof file !== 'object') return 'asset';
  const source = getFileCaptureSource(file);
  const evidence = file.captureEvidence && typeof file.captureEvidence === 'object'
    ? file.captureEvidence
    : {};
  if (
    DEPENDENCY_CAPTURE_SOURCES.has(source) ||
    typeof evidence.relationshipSourcePath === 'string' ||
    typeof evidence.sourceDocumentPath === 'string'
  ) {
    return 'asset';
  }
  const ext = (file.ext || path.extname(file.path || '') || '').toLowerCase();
  return PRIMARY_DESIGN_EXTENSIONS.has(ext) ? 'source' : 'asset';
}

function isProjectAssetBaselineSource(file) {
  if (!file || typeof file !== 'object') return false;
  const ext = (file.ext || path.extname(file.path || '') || '').toLowerCase();
  if (!SCAN_ON_OPEN_EXTENSIONS.has(ext)) return false;
  const source = getFileCaptureSource(file);
  const evidence = file.captureEvidence && typeof file.captureEvidence === 'object'
    ? file.captureEvidence
    : {};
  if (isExplicitUserCapturedFile(file) || file.acceptedPending === true) return true;
  if (
    DEPENDENCY_CAPTURE_SOURCES.has(source) ||
    typeof evidence.relationshipSourcePath === 'string' ||
    typeof evidence.sourceDocumentPath === 'string'
  ) {
    return false;
  }
  return inferProjectFileRole(file) === 'source';
}

function getAssetBaselineSourceRecoveryRouteKey(project, file) {
  const sourceKey = getTrackedFileDedupKey(file);
  if (!project || typeof project.id !== 'string' || !project.id || !sourceKey) return null;
  return crypto.createHash('sha256')
    .update('asset-baseline-source-route')
    .update('\0')
    .update(project.id)
    .update('\0')
    .update(sourceKey)
    .digest('hex');
}

function getAssetBaselineSourcePhysicalIdentityHash(project, stat) {
  if (!project || typeof project.id !== 'string' || !project.id || !stat) return null;
  const kind = stat.isFile() ? 'file' : (stat.isDirectory() ? 'directory' : null);
  if (!kind || typeof stat.dev !== 'bigint' || typeof stat.ino !== 'bigint') return null;
  const birthtimeNs = typeof stat.birthtimeNs === 'bigint'
    ? stat.birthtimeNs
    : BigInt(Math.max(0, Math.trunc(Number(stat.birthtimeMs || 0) * 1000000)));
  return crypto.createHash('sha256')
    .update('asset-baseline-source-physical-identity')
    .update('\0')
    .update(project.id)
    .update('\0')
    .update(kind)
    .update('\0')
    .update(String(stat.dev))
    .update('\0')
    .update(String(stat.ino))
    .update('\0')
    .update(String(birthtimeNs))
    .digest('hex');
}

function sameAssetBaselineSourcePhysicalIdentity(left, right) {
  if (!left || !right) return false;
  const leftKind = left.isFile() ? 'file' : (left.isDirectory() ? 'directory' : null);
  const rightKind = right.isFile() ? 'file' : (right.isDirectory() ? 'directory' : null);
  const leftBirthtime = typeof left.birthtimeNs === 'bigint'
    ? left.birthtimeNs
    : BigInt(Math.max(0, Math.trunc(Number(left.birthtimeMs || 0) * 1000000)));
  const rightBirthtime = typeof right.birthtimeNs === 'bigint'
    ? right.birthtimeNs
    : BigInt(Math.max(0, Math.trunc(Number(right.birthtimeMs || 0) * 1000000)));
  return !!(
    leftKind && leftKind === rightKind &&
    left.dev === right.dev && left.ino === right.ino && leftBirthtime === rightBirthtime
  );
}

async function getAssetBaselineSourceRecoveryRecord(project, file) {
  const sourceKeyHash = getAssetBaselineSourceRecoveryRouteKey(project, file);
  if (!sourceKeyHash || typeof file?.path !== 'string' || !path.isAbsolute(file.path)) return null;
  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
  let handle = null;
  try {
    handle = await fs.promises.open(file.path, fs.constants.O_RDONLY | noFollow);
    const openedStat = await handle.stat({ bigint: true });
    const pathStat = await fs.promises.lstat(file.path, { bigint: true });
    if (pathStat.isSymbolicLink() || !sameAssetBaselineSourcePhysicalIdentity(openedStat, pathStat)) return null;
    const physicalIdentityHash = getAssetBaselineSourcePhysicalIdentityHash(project, openedStat);
    if (!physicalIdentityHash) return null;
    return {
      schemaVersion: ASSET_BASELINE_SOURCE_RECOVERY_SCHEMA_VERSION,
      sourceKeyHash,
      physicalIdentityHash,
    };
  } catch (_) {
    return null;
  } finally {
    if (handle) {
      try { await handle.close(); } catch (_) {}
    }
  }
}

function normalizeFailedRequiredAssetBaselineSources(project, baseline) {
  if (!baseline || baseline.status !== 'awaiting-first-scan') return [];
  const validSourceKeys = new Set(
    (project.files || [])
      .filter(isProjectAssetBaselineSource)
      .map(file => getAssetBaselineSourceRecoveryRouteKey(project, file))
      .filter(Boolean)
  );
  const normalized = [];
  const seen = new Set();
  for (const record of Array.isArray(baseline.failedRequiredSources)
    ? baseline.failedRequiredSources
    : []) {
    if (
      !record || typeof record !== 'object' ||
      record.schemaVersion !== ASSET_BASELINE_SOURCE_RECOVERY_SCHEMA_VERSION ||
      !ASSET_BASELINE_SOURCE_RECOVERY_KEY_PATTERN.test(record.sourceKeyHash || '') ||
      !ASSET_BASELINE_SOURCE_RECOVERY_KEY_PATTERN.test(record.physicalIdentityHash || '') ||
      !validSourceKeys.has(record.sourceKeyHash) ||
      seen.has(record.sourceKeyHash)
    ) continue;
    seen.add(record.sourceKeyHash);
    normalized.push({
      schemaVersion: ASSET_BASELINE_SOURCE_RECOVERY_SCHEMA_VERSION,
      sourceKeyHash: record.sourceKeyHash,
      physicalIdentityHash: record.physicalIdentityHash,
    });
  }
  return normalized.sort((left, right) => left.sourceKeyHash.localeCompare(right.sourceKeyHash));
}

function inferAssetOrigin(project, file, baseline) {
  const baselineStatus = baseline && baseline.status;
  if (baselineStatus === 'legacy-included') return 'existing';
  if (isExplicitUserCapturedFile(file)) return 'added';
  if (baselineStatus === 'awaiting-first-scan') return null;
  const captureSource = getFileCaptureSource(file);
  const captureEvidence = file && file.captureEvidence && typeof file.captureEvidence === 'object'
    ? file.captureEvidence
    : {};
  if (
    captureSource === 'ps-poll' &&
    typeof file.assetBaselineSourcePath !== 'string' &&
    typeof captureEvidence.relationshipSourcePath !== 'string' &&
    typeof captureEvidence.sourceDocumentPath !== 'string'
  ) {
    return 'added';
  }
  const isDependency = DEPENDENCY_CAPTURE_SOURCES.has(captureSource) ||
    typeof captureEvidence.relationshipSourcePath === 'string' ||
    typeof captureEvidence.sourceDocumentPath === 'string';
  if (inferProjectFileRole(file) !== 'asset' || !isDependency) return 'added';
  const baselineEstablishedAt = Number.isFinite(baseline && baseline.establishedAt)
    ? baseline.establishedAt
    : null;
  if (baselineEstablishedAt !== null && Number.isFinite(file && file.addedAt)) {
    return file.addedAt <= baselineEstablishedAt ? 'existing' : 'added';
  }
  const sessionStart = Number.isFinite(project && project.watchStartedAt)
    ? project.watchStartedAt
    : (Number.isFinite(project && project.createdAt) ? project.createdAt : null);
  if (sessionStart !== null && Number.isFinite(file && file.addedAt) && file.addedAt >= sessionStart) {
    return 'added';
  }
  return 'existing';
}

function normalizeProjectAssetReviewState(project) {
  if (!project || typeof project !== 'object') return false;
  let changed = false;
  const hasPersistedBaseline = Object.prototype.hasOwnProperty.call(project, 'assetBaseline');
  const baseline = project.assetBaseline && typeof project.assetBaseline === 'object'
    ? project.assetBaseline
    : null;
  const expectedDecision = baseline && baseline.status === 'included'
    ? 'include'
    : (baseline && baseline.status === 'skipped'
      ? 'skip'
      : (baseline && baseline.status === 'legacy-included' ? 'include' : null));
  const validPersistedBaseline = !!(
    baseline &&
    baseline.schemaVersion === ASSET_REVIEW_SCHEMA_VERSION &&
    ASSET_BASELINE_STATUSES.has(baseline.status) &&
    (baseline.decision ?? null) === expectedDecision
  );
  const status = !hasPersistedBaseline
    ? 'legacy-included'
    : (validPersistedBaseline ? baseline.status : 'invalid');
  const normalizedBaseline = createAssetBaselineState(status, project);
  if (baseline && status !== 'invalid') {
    normalizedBaseline.decision = ASSET_BASELINE_DECISIONS.has(baseline.decision)
      ? baseline.decision
      : normalizedBaseline.decision;
    normalizedBaseline.establishedAt = Number.isFinite(baseline.establishedAt)
      ? baseline.establishedAt
      : normalizedBaseline.establishedAt;
    const presentationMediaOccurrences = normalizePresentationMediaOccurrences(
      baseline.presentationMediaOccurrences
    );
    if (presentationMediaOccurrences.length > 0) {
      normalizedBaseline.presentationMediaOccurrences = presentationMediaOccurrences;
    }
    const failedRequiredSources = normalizeFailedRequiredAssetBaselineSources(project, baseline);
    if (failedRequiredSources.length > 0) {
      normalizedBaseline.failedRequiredSources = failedRequiredSources;
    }
  }
  if (JSON.stringify(project.assetBaseline) !== JSON.stringify(normalizedBaseline)) {
    project.assetBaseline = normalizedBaseline;
    changed = true;
  }

  const sourceFileKeys = new Set(
    (project.files || [])
      .filter(isProjectAssetBaselineSource)
      .map(getAssetReviewExclusionKey)
      .filter(Boolean)
  );
  const normalizedExcludedKeys = [];
  const seenExcludedKeys = new Set();
  for (const key of Array.isArray(project.excludedAssetKeys) ? project.excludedAssetKeys : []) {
    if (
      typeof key !== 'string' ||
      key.length === 0 ||
      sourceFileKeys.has(key) ||
      seenExcludedKeys.has(key)
    ) continue;
    seenExcludedKeys.add(key);
    normalizedExcludedKeys.push(key);
  }
  if (JSON.stringify(project.excludedAssetKeys) !== JSON.stringify(normalizedExcludedKeys)) {
    project.excludedAssetKeys = normalizedExcludedKeys;
    changed = true;
  }

  for (const collection of [project.files, project.pendingFiles]) {
    if (!Array.isArray(collection)) continue;
    for (const file of collection) {
      if (!file || typeof file !== 'object') continue;
      if (!ASSET_ORIGINS.has(file.assetOrigin)) {
        const assetOrigin = inferAssetOrigin(project, file, normalizedBaseline);
        if (ASSET_ORIGINS.has(assetOrigin)) {
          file.assetOrigin = assetOrigin;
          changed = true;
        }
      }
      if (!PROJECT_FILE_ROLES.has(file.projectRole)) {
        file.projectRole = inferProjectFileRole(file);
        changed = true;
      }
    }
  }
  return changed;
}

function getAssetReviewExclusionKey(file) {
  if (!file || typeof file !== 'object') return null;
  if (isScanOnSaveEmbeddedPsdFile(file)) return getEmbeddedPsdDedupKey(file);
  if (typeof file.fileId === 'string' && file.fileId) return file.fileId;
  return typeof file.path === 'string' && file.path ? file.path : null;
}

const FILE_VISUAL_PIXEL_SIZE = 192;
const FILE_VISUAL_MAX_PNG_BYTES = 256 * 1024;
const FILE_VISUAL_MAX_RASTER_SOURCE_BYTES = 16 * 1024 * 1024;
const FILE_VISUAL_MAX_RASTER_HEADER_BYTES = 256 * 1024;
const FILE_VISUAL_MAX_RASTER_DIMENSION = 6000;
const FILE_VISUAL_MAX_RASTER_PIXELS = 12 * 1000 * 1000;
const FILE_VISUAL_MAX_RASTER_QUEUE = 8;
const FILE_VISUAL_SNAPSHOT_PREFIX = 'crate-file-visual-';
const FILE_VISUAL_SNAPSHOT_COPY_CHUNK_BYTES = 64 * 1024;
const FILE_VISUAL_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const FILE_VISUAL_REVISION_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const FILE_VISUAL_TYPE_ICON_CACHE_CAPACITY = 64;
const FILE_VISUAL_SAFE_RASTER_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp']);
const fileVisualIdentitySecret = crypto.randomBytes(32);
const fileVisualTypeIconCache = new Map();
const fileVisualTypeIconPending = new Map();
const fileVisualProjectCache = new Map();
const fileVisualProjectCacheEpochs = new Map();
let fileVisualProjectCacheGeneration = 0;
let fileVisualRasterWorkTail = Promise.resolve();
let fileVisualRasterWorkPending = 0;

function getFileVisualProjectCacheEpoch(projectId) {
  if (typeof projectId !== 'string' || !projectId) return 0;
  return fileVisualProjectCacheEpochs.get(projectId) || 0;
}

function clearFileVisualProjectCache(projectId = null) {
  // The epoch also invalidates workspace builders that are between their
  // asynchronous filesystem reads and cache publication. Array/object
  // identity checks alone cannot detect an in-place project mutation.
  if (typeof projectId === 'string' && projectId) {
    fileVisualProjectCacheEpochs.set(projectId, getFileVisualProjectCacheEpoch(projectId) + 1);
    fileVisualProjectCache.delete(projectId);
    return;
  }
  fileVisualProjectCacheGeneration += 1;
  fileVisualProjectCache.clear();
}

function getCurrentFileVisualProjectCache(projectId, project) {
  const cache = fileVisualProjectCache.get(projectId);
  if (
    !cache ||
    cache.epoch !== getFileVisualProjectCacheEpoch(projectId) ||
    cache.generation !== fileVisualProjectCacheGeneration ||
    cache.project !== project ||
    cache.files !== project?.files ||
    cache.pendingFiles !== project?.pendingFiles ||
    cache.illustratorScope !== getIllustratorActivationScope(projectId)
  ) return null;
  return cache;
}

function createProjectFileVisualIdentity(projectId, file) {
  const authoritativeKey = getAssetReviewExclusionKey(file);
  if (typeof projectId !== 'string' || !projectId || typeof authoritativeKey !== 'string' || !authoritativeKey) {
    return null;
  }
  return crypto.createHmac('sha256', fileVisualIdentitySecret)
    .update(projectId)
    .update('\0')
    .update(authoritativeKey)
    .digest('base64url');
}

function createFigmaSourceIdentity(projectId, figmaFileKey) {
  if (typeof projectId !== 'string' || !projectId || typeof figmaFileKey !== 'string' || !figmaFileKey.trim()) {
    return null;
  }
  return crypto.createHmac('sha256', fileVisualIdentitySecret)
    .update('figma-source\0')
    .update(projectId)
    .update('\0')
    .update(figmaFileKey.trim())
    .digest('base64url');
}

function createProjectFileVisualRevisionFromStat(projectId, file, stat = null) {
  const authoritativeKey = getAssetReviewExclusionKey(file);
  if (typeof projectId !== 'string' || !projectId || typeof authoritativeKey !== 'string' || !authoritativeKey) {
    return null;
  }
  const ext = (file?.ext || path.extname(file?.path || file?.name || '') || '').toLowerCase();
  const revisionParts = [
    projectId,
    authoritativeKey,
    ext,
    String(file?.addedAt ?? ''),
    String(file?.assetOrigin ?? ''),
    String(file?.projectRole ?? ''),
  ];
  if (FILE_VISUAL_SAFE_RASTER_EXTENSIONS.has(ext)) {
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) revisionParts.push('unavailable');
    else revisionParts.push(
      String(stat.dev),
      String(stat.ino),
      String(stat.size),
      String(stat.mtimeNs),
      String(stat.ctimeNs)
    );
  }
  return crypto.createHmac('sha256', fileVisualIdentitySecret)
    .update(revisionParts.join('\0'))
    .digest('base64url');
}

async function createProjectFileVisualRevision(projectId, file) {
  const ext = (file?.ext || path.extname(file?.path || file?.name || '') || '').toLowerCase();
  if (
    !FILE_VISUAL_SAFE_RASTER_EXTENSIONS.has(ext) ||
    typeof file?.path !== 'string' ||
    !path.isAbsolute(file.path)
  ) return createProjectFileVisualRevisionFromStat(projectId, file);
  try {
    const stat = await fs.promises.lstat(file.path, { bigint: true });
    return createProjectFileVisualRevisionFromStat(projectId, file, stat);
  } catch (_) {
    return createProjectFileVisualRevisionFromStat(projectId, file);
  }
}

async function createRendererFilePresentation(project, file) {
  const ext = (file?.ext || path.extname(file?.path || file?.name || '') || '').toLowerCase();
  const captureEvidence = file?.captureEvidence && typeof file.captureEvidence === 'object'
    ? file.captureEvidence
    : {};
  const evidenceKey = typeof file?.path === 'string' && file.path
    ? getLiveEvidenceKeyHash(normalizeTrackedFilePath(file.path))
    : null;
  const ledgerEvidence = evidenceKey && project?.liveEvidenceLedger?.candidates?.[evidenceKey]?.latest;
  const scopedAppFamily = getScopedFileAppFamily(project, file);
  const appFamily = (scopedAppFamily && scopedAppFamily !== 'generic' ? scopedAppFamily : null)
    || getPrimaryDesignAppFamilyForExt(ext)
    || scopedAppFamily
    || null;
  const sourceDocumentName = captureEvidence.sourceName || captureEvidence.sourceDocumentName ||
    ledgerEvidence?.sourceName || ledgerEvidence?.sourceDocumentName || (
    typeof captureEvidence.sourceDocumentPath === 'string' && captureEvidence.sourceDocumentPath
      ? path.basename(captureEvidence.sourceDocumentPath)
      : null
  );
  const sourceName = sanitizeRendererSourceName(sourceDocumentName || file?.figmaFileName) || null;
  const figmaFileKey = typeof file?.figmaFileKey === 'string' && file.figmaFileKey.trim()
    ? file.figmaFileKey.trim()
    : (typeof file?.fileKey === 'string' && file.fileKey.trim() ? file.fileKey.trim() : null);
  const figmaSourceIdentity = appFamily === 'figma'
    ? createFigmaSourceIdentity(project.id, figmaFileKey)
    : null;
  return {
    name: typeof file?.name === 'string' && file.name ? file.name : 'Untitled file',
    ext,
    embedded: file?.embedded === true,
    linked: DEPENDENCY_CAPTURE_SOURCES.has(getFileCaptureSource(file)),
    appFamily,
    sourceName,
    ...(figmaSourceIdentity ? { figmaSourceIdentity } : {}),
    assetOrigin: ASSET_ORIGINS.has(file?.assetOrigin) ? file.assetOrigin : null,
    projectRole: PROJECT_FILE_ROLES.has(file?.projectRole) ? file.projectRole : inferProjectFileRole(file),
    protectedSource: isProjectAssetBaselineSource(file),
    sourceRecoveryAllowed: await isFailedRequiredAssetBaselineSource(project, file),
    excluded: isAssetReviewFileExcluded(project, file),
    visualIdentity: createProjectFileVisualIdentity(project.id, file),
    visualRevision: await createProjectFileVisualRevision(project.id, file),
  };
}

async function getProjectAssetWorkspace(projectId, retryCount = 0) {
  if (typeof projectId !== 'string' || !projectId || projectId.length > 128) return null;
  const project = getProjects().find(item => item && item.id === projectId);
  const scopedProject = project && getIllustratorScopedProjectView(project);
  if (!project || !scopedProject) return null;
  const projectFiles = project.files;
  const projectPendingFiles = project.pendingFiles;
  const illustratorScope = getIllustratorActivationScope(projectId);
  const cacheEpoch = getFileVisualProjectCacheEpoch(projectId);
  const cacheGeneration = fileVisualProjectCacheGeneration;
  const files = await Promise.all((scopedProject.files || []).map(async (file, sourceIndex) => ({
    ...(await createRendererFilePresentation(project, file)),
    sourceIndex,
  })));
  const pendingFiles = await Promise.all((scopedProject.pendingFiles || []).map(async (file, sourceIndex) => ({
    ...(await createRendererFilePresentation(project, file)),
    sourceIndex,
  })));
  const visualRecords = new Map();
  for (const [index, file] of (scopedProject.files || []).entries()) {
    const presentation = files[index];
    if (presentation?.visualIdentity) visualRecords.set(presentation.visualIdentity, {
      file,
      visualRevision: presentation.visualRevision,
    });
  }
  for (const [index, file] of (scopedProject.pendingFiles || []).entries()) {
    const presentation = pendingFiles[index];
    if (presentation?.visualIdentity) visualRecords.set(presentation.visualIdentity, {
      file,
      visualRevision: presentation.visualRevision,
    });
  }
  // Mutations clear the cache. This post-await freshness check prevents an
  // in-flight workspace build from publishing or returning stale records
  // after a concurrent project update. Retry once so the renderer receives a
  // current snapshot; repeated churn fails closed instead of returning stale data.
  const workspaceIsFresh = (
    getFileVisualProjectCacheEpoch(projectId) === cacheEpoch &&
    fileVisualProjectCacheGeneration === cacheGeneration &&
    project.files === projectFiles &&
    project.pendingFiles === projectPendingFiles &&
    getIllustratorActivationScope(projectId) === illustratorScope
  );
  if (!workspaceIsFresh) {
    return retryCount < 2 ? getProjectAssetWorkspace(projectId, retryCount + 1) : null;
  }
  if (workspaceIsFresh) {
    fileVisualProjectCache.set(projectId, {
      epoch: cacheEpoch,
      generation: cacheGeneration,
      project,
      files: projectFiles,
      pendingFiles: projectPendingFiles,
      illustratorScope,
      visualRecords,
    });
  }
  const trackedFigmaFiles = (project.figmaTrackedFiles || []).map(trackedFile => {
    const figmaFileKey = typeof trackedFile?.key === 'string' && trackedFile.key.trim()
      ? trackedFile.key.trim()
      : null;
    const displayName = sanitizeRendererSourceName(trackedFile?.displayName || trackedFile?.name) || 'Figma file';
    const figmaSourceIdentity = createFigmaSourceIdentity(project.id, figmaFileKey);
    return {
      displayName,
      ...(figmaSourceIdentity ? { figmaSourceIdentity } : {}),
    };
  });
  return {
    projectId,
    files,
    pendingFiles,
    trackedFigmaFiles,
  };
}

function encodeBoundedFileVisual(image) {
  if (!image || typeof image.isEmpty !== 'function' || image.isEmpty()) return null;
  try {
    let boundedImage = image;
    if (typeof image.getSize === 'function' && typeof image.resize === 'function') {
      const size = image.getSize();
      const width = Math.max(1, Number(size && size.width) || 1);
      const height = Math.max(1, Number(size && size.height) || 1);
      const scale = Math.min(1, FILE_VISUAL_PIXEL_SIZE / width, FILE_VISUAL_PIXEL_SIZE / height);
      boundedImage = image.resize({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        quality: 'best',
      });
    }
    if (!boundedImage || typeof boundedImage.toPNG !== 'function') return null;
    const png = boundedImage.toPNG();
    if (!Buffer.isBuffer(png) || png.length === 0 || png.length > FILE_VISUAL_MAX_PNG_BYTES) return null;
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch (_) {
    return null;
  }
}

function resolveProjectOwnedFileVisualRecord(projectId, visualIdentity, projectOverride = null) {
  if (
    typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 128 ||
    typeof visualIdentity !== 'string' || !FILE_VISUAL_ID_PATTERN.test(visualIdentity)
  ) return null;
  const project = projectOverride || getProjects().find(item => item && item.id === projectId);
  const cached = getCurrentFileVisualProjectCache(projectId, project);
  if (cached) return cached.visualRecords.get(visualIdentity)?.file || null;
  const scopedProject = project && getIllustratorScopedProjectView(project);
  if (!scopedProject) return null;
  return [...(scopedProject.files || []), ...(scopedProject.pendingFiles || [])].find(file => (
    createProjectFileVisualIdentity(projectId, file) === visualIdentity
  )) || null;
}

function matchesProjectFileIdentity(projectId, file, identity) {
  if (!file || typeof identity !== 'string' || !identity) return false;
  if (createProjectFileVisualIdentity(projectId, file) === identity) return true;
  if (typeof file.fileId === 'string' && file.fileId === identity) return true;
  return !file.fileId && file.path === identity;
}

function getSafeRasterDimensions(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  let width = 0;
  let height = 0;
  if (
    buffer.length >= 24 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    buffer.toString('ascii', 12, 16) === 'IHDR'
  ) {
    width = buffer.readUInt32BE(16);
    height = buffer.readUInt32BE(20);
  } else if (buffer.length >= 10 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) {
    width = buffer.readUInt16LE(6);
    height = buffer.readUInt16LE(8);
  } else if (buffer.length >= 26 && buffer.toString('ascii', 0, 2) === 'BM') {
    width = Math.abs(buffer.readInt32LE(18));
    height = Math.abs(buffer.readInt32LE(22));
  } else if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (offset + 3 < buffer.length) {
      while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
      if (offset >= buffer.length) break;
      const marker = buffer[offset++];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 1 >= buffer.length) break;
      const segmentLength = buffer.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
      if (sofMarkers.has(marker) && segmentLength >= 7) {
        height = buffer.readUInt16BE(offset + 3);
        width = buffer.readUInt16BE(offset + 5);
        break;
      }
      offset += segmentLength;
    }
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return null;
  if (width > FILE_VISUAL_MAX_RASTER_DIMENSION || height > FILE_VISUAL_MAX_RASTER_DIMENSION) return null;
  if ((width * height) > FILE_VISUAL_MAX_RASTER_PIXELS) return null;
  return { width, height };
}

function sameOpenFileStat(before, after) {
  return !!(
    before && after &&
    before.isFile() && after.isFile() &&
    before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
  );
}

async function openPreflightedRasterSource(sourcePath) {
  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
  let handle = null;
  try {
    handle = await fs.promises.open(sourcePath, fs.constants.O_RDONLY | noFollow);
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() || before.nlink !== 1n || before.size <= 0n ||
      before.size > BigInt(FILE_VISUAL_MAX_RASTER_SOURCE_BYTES)
    ) return null;
    const buffer = Buffer.allocUnsafe(Math.min(Number(before.size), FILE_VISUAL_MAX_RASTER_HEADER_BYTES));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead <= 0) return null;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameOpenFileStat(before, after)) return null;
    const pathStat = await fs.promises.lstat(sourcePath, { bigint: true });
    if (pathStat.isSymbolicLink() || !sameOpenFileStat(after, pathStat)) return null;
    if (!getSafeRasterDimensions(buffer)) return null;
    const result = { handle, sourceStat: after };
    handle = null;
    return result;
  } catch (_) {
    return null;
  } finally {
    if (handle) {
      try { await handle.close(); } catch (_) {}
    }
  }
}

async function capturePrivateFileVisualDirectory(tempDir) {
  const resolvedPath = path.resolve(tempDir);
  const requestedStat = await fs.promises.lstat(resolvedPath, { bigint: true });
  const realPath = await fs.promises.realpath(resolvedPath);
  const stat = await fs.promises.lstat(realPath, { bigint: true });
  if (
    requestedStat.isSymbolicLink() || !requestedStat.isDirectory() ||
    stat.isSymbolicLink() || !stat.isDirectory() ||
    requestedStat.dev !== stat.dev || requestedStat.ino !== stat.ino ||
    (Number(stat.mode) & 0o077) !== 0
  ) throw new Error('unsafe_file_visual_snapshot_directory');
  return { path: realPath, realPath, dev: stat.dev, ino: stat.ino };
}

async function assertPrivateFileVisualDirectory(identity) {
  if (!identity) throw new Error('unsafe_file_visual_snapshot_directory');
  const current = await capturePrivateFileVisualDirectory(identity.path);
  if (
    current.realPath !== identity.realPath ||
    current.dev !== identity.dev || current.ino !== identity.ino
  ) throw new Error('unsafe_file_visual_snapshot_directory');
}

async function cleanupEmptyPrivateFileVisualDirectory(tempDir, expectedStat) {
  if (typeof tempDir !== 'string' || !tempDir || !expectedStat) return;
  try {
    const resolvedPath = path.resolve(tempDir);
    if (
      path.dirname(resolvedPath) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolvedPath).startsWith(FILE_VISUAL_SNAPSHOT_PREFIX)
    ) return;
    const stat = await fs.promises.lstat(resolvedPath, { bigint: true });
    if (
      stat.isSymbolicLink() || !stat.isDirectory() ||
      (Number(stat.mode) & 0o077) !== 0 ||
      stat.dev !== expectedStat.dev || stat.ino !== expectedStat.ino
    ) return;
    await fs.promises.rmdir(resolvedPath);
  } catch (_) {}
}

async function cleanupPrivateFileVisualSnapshot(snapshot) {
  if (!snapshot) return;
  if (snapshot.handle) {
    try { await snapshot.handle.truncate(0); } catch (_) {}
    try { await snapshot.handle.sync(); } catch (_) {}
    try { await snapshot.handle.close(); } catch (_) {}
    snapshot.handle = null;
  }
  try {
    const stat = await fs.promises.lstat(snapshot.path, { bigint: true });
    if (
      snapshot.stat && !stat.isSymbolicLink() && stat.isFile() && stat.nlink === 1n &&
      stat.dev === snapshot.stat.dev && stat.ino === snapshot.stat.ino
    ) await fs.promises.unlink(snapshot.path);
  } catch (_) {}
  try {
    await assertPrivateFileVisualDirectory(snapshot.directory);
    await fs.promises.rmdir(snapshot.directory.path);
  } catch (_) {}
}

async function createPrivateFileVisualSnapshot(source, ext) {
  let snapshot = null;
  let createdTempDir = null;
  let createdTempStat = null;
  try {
    createdTempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), FILE_VISUAL_SNAPSHOT_PREFIX));
    createdTempStat = await fs.promises.lstat(createdTempDir, { bigint: true });
    await fs.promises.chmod(createdTempDir, OWNER_ONLY_DIR_MODE);
    const directory = await capturePrivateFileVisualDirectory(createdTempDir);
    const safeExt = FILE_VISUAL_SAFE_RASTER_EXTENSIONS.has(ext) ? ext : '.img';
    const snapshotPath = path.join(directory.path, `source${safeExt}`);
    snapshot = { path: snapshotPath, handle: null, stat: null, directory };
    const flags = fs.constants.O_WRONLY
      | fs.constants.O_CREAT
      | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0);
    const handle = await fs.promises.open(snapshotPath, flags, OWNER_ONLY_FILE_MODE);
    snapshot.handle = handle;
    snapshot.stat = await handle.stat({ bigint: true });
    await assertPrivateFileVisualDirectory(directory);
    const pathStat = await fs.promises.lstat(snapshotPath, { bigint: true });
    if (
      pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.nlink !== 1n ||
      pathStat.dev !== snapshot.stat.dev || pathStat.ino !== snapshot.stat.ino ||
      path.dirname(await fs.promises.realpath(snapshotPath)) !== directory.realPath
    ) throw new Error('unsafe_file_visual_snapshot');
    await handle.chmod(OWNER_ONLY_FILE_MODE);

    const chunk = Buffer.allocUnsafe(FILE_VISUAL_SNAPSHOT_COPY_CHUNK_BYTES);
    let offset = 0;
    const sourceSize = Number(source.sourceStat.size);
    while (offset < sourceSize) {
      const requested = Math.min(chunk.length, sourceSize - offset);
      const { bytesRead } = await source.handle.read(chunk, 0, requested, offset);
      if (bytesRead <= 0) throw new Error('incomplete_file_visual_snapshot');
      let written = 0;
      while (written < bytesRead) {
        const result = await handle.write(chunk, written, bytesRead - written, offset + written);
        if (result.bytesWritten <= 0) throw new Error('incomplete_file_visual_snapshot');
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    await handle.sync();
    const finalSourceStat = await source.handle.stat({ bigint: true });
    if (!sameOpenFileStat(source.sourceStat, finalSourceStat)) {
      throw new Error('changed_file_visual_source');
    }
    const finalSnapshotStat = await handle.stat({ bigint: true });
    const finalPathStat = await fs.promises.lstat(snapshotPath, { bigint: true });
    await assertPrivateFileVisualDirectory(directory);
    if (
      !finalSnapshotStat.isFile() || finalSnapshotStat.nlink !== 1n ||
      finalSnapshotStat.size !== source.sourceStat.size ||
      finalPathStat.isSymbolicLink() ||
      finalPathStat.dev !== finalSnapshotStat.dev || finalPathStat.ino !== finalSnapshotStat.ino
    ) throw new Error('changed_file_visual_snapshot');
    snapshot.stat = finalSnapshotStat;
    return snapshot;
  } catch (_) {
    await cleanupPrivateFileVisualSnapshot(snapshot);
    if (!snapshot) await cleanupEmptyPrivateFileVisualDirectory(createdTempDir, createdTempStat);
    return null;
  }
}

function rememberFileVisualTypeIcon(ext, dataUrl) {
  fileVisualTypeIconCache.delete(ext);
  fileVisualTypeIconCache.set(ext, dataUrl);
  while (fileVisualTypeIconCache.size > FILE_VISUAL_TYPE_ICON_CACHE_CAPACITY) {
    const oldest = fileVisualTypeIconCache.keys().next().value;
    if (oldest === undefined) break;
    fileVisualTypeIconCache.delete(oldest);
  }
}

function getFileVisualTypeIconHint(ext) {
  if (!/^\.[a-z0-9]{1,12}$/.test(ext)) return null;
  try {
    const rootPath = path.parse(process.execPath || path.sep).root || path.sep;
    const rootRealPath = safeRealpath(rootPath, 'file-type-icon-root');
    const rootStat = fs.lstatSync(rootRealPath);
    if (
      rootRealPath !== rootPath || rootStat.isSymbolicLink() || !rootStat.isDirectory() ||
      (Number(rootStat.mode) & 0o022) !== 0
    ) return null;
    return {
      hintPath: path.join(rootRealPath, `.crate-file-type${ext}`),
      rootRealPath,
      rootIdentity: { dev: rootStat.dev, ino: rootStat.ino },
    };
  } catch (_) {
    return null;
  }
}

function verifyFileVisualTypeIconHint(hint) {
  if (!hint || typeof hint !== 'object') return false;
  try {
    try {
      fs.lstatSync(hint.hintPath);
      return false;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') return false;
    }
    const rootStat = fs.lstatSync(hint.rootRealPath);
    return !rootStat.isSymbolicLink() && rootStat.isDirectory()
      && rootStat.dev === hint.rootIdentity.dev
      && rootStat.ino === hint.rootIdentity.ino
      && (Number(rootStat.mode) & 0o022) === 0
      && safeRealpath(hint.rootRealPath, 'file-type-icon-root') === hint.rootRealPath
      && path.dirname(hint.hintPath) === hint.rootRealPath;
  } catch (_) {
    return false;
  }
}

async function getBoundedFileTypeIcon(ext) {
  if (!/^\.[a-z0-9]{1,12}$/.test(ext) || typeof app.getFileIcon !== 'function') return null;
  if (fileVisualTypeIconCache.has(ext)) {
    const cached = fileVisualTypeIconCache.get(ext);
    rememberFileVisualTypeIcon(ext, cached);
    return cached;
  }
  if (fileVisualTypeIconPending.has(ext)) return fileVisualTypeIconPending.get(ext);
  const pending = (async () => {
    try {
      const hint = getFileVisualTypeIconHint(ext);
      if (!hint || !verifyFileVisualTypeIconHint(hint)) return null;
      const icon = await app.getFileIcon(hint.hintPath, { size: 'normal' });
      if (!verifyFileVisualTypeIconHint(hint)) return null;
      const dataUrl = encodeBoundedFileVisual(icon);
      if (!dataUrl) return null;
      rememberFileVisualTypeIcon(ext, dataUrl);
      return dataUrl;
    } catch (_) {
      return null;
    } finally {
      fileVisualTypeIconPending.delete(ext);
    }
  })();
  fileVisualTypeIconPending.set(ext, pending);
  return pending;
}

function runSerializedFileVisualRasterWork(task) {
  if (typeof task !== 'function' || fileVisualRasterWorkPending >= FILE_VISUAL_MAX_RASTER_QUEUE) {
    return Promise.resolve(null);
  }
  fileVisualRasterWorkPending += 1;
  const result = fileVisualRasterWorkTail.then(task, task);
  fileVisualRasterWorkTail = result.then(() => undefined, () => undefined);
  return result.finally(() => {
    fileVisualRasterWorkPending = Math.max(0, fileVisualRasterWorkPending - 1);
  });
}

function getBoundedRasterThumbnail(projectId, file, visualRevision) {
  return runSerializedFileVisualRasterWork(async () => {
    const source = await openPreflightedRasterSource(file.path);
    if (!source) return null;
    let snapshot = null;
    try {
      if (createProjectFileVisualRevisionFromStat(projectId, file, source.sourceStat) !== visualRevision) {
        return { stale: true };
      }
      const ext = (file.ext || path.extname(file.path || '')).toLowerCase();
      snapshot = await createPrivateFileVisualSnapshot(source, ext);
      if (!snapshot) return null;
      const thumbnail = await nativeImage.createThumbnailFromPath(snapshot.path, {
        width: FILE_VISUAL_PIXEL_SIZE,
        height: FILE_VISUAL_PIXEL_SIZE,
      });
      const descriptorStat = await source.handle.stat({ bigint: true });
      const snapshotStat = await snapshot.handle.stat({ bigint: true });
      const snapshotPathStat = await fs.promises.lstat(snapshot.path, { bigint: true });
      await assertPrivateFileVisualDirectory(snapshot.directory);
      if (
        !sameOpenFileStat(source.sourceStat, descriptorStat) ||
        snapshotPathStat.isSymbolicLink() ||
        !sameOpenFileStat(snapshot.stat, snapshotStat) ||
        !sameOpenFileStat(snapshotStat, snapshotPathStat)
      ) return null;
      return encodeBoundedFileVisual(thumbnail);
    } catch (_) {
      return null;
    } finally {
      await cleanupPrivateFileVisualSnapshot(snapshot);
      try { await source.handle.close(); } catch (_) {}
    }
  });
}

function getProjectOwnedFileVisualRequestError({
  projectId,
  visualIdentity,
  visualRevision,
  requestEpoch,
  requestProject,
  requestFile,
}) {
  const storedProjects = typeof projectId === 'string' ? store.get('projects', []) : [];
  const currentProject = Array.isArray(storedProjects)
    ? storedProjects.find(item => item && item.id === projectId)
    : null;
  if (!currentProject) return { error: 'not_found' };
  const currentFile = resolveProjectOwnedFileVisualRecord(projectId, visualIdentity, currentProject);
  if (!currentFile) return { error: 'not_found' };
  if (
    getFileVisualProjectCacheEpoch(projectId) !== requestEpoch ||
    currentProject !== requestProject ||
    currentFile !== requestFile ||
    createProjectFileVisualIdentity(projectId, currentFile) !== visualIdentity
  ) return { error: 'stale_visual' };

  const currentCache = getCurrentFileVisualProjectCache(projectId, currentProject);
  const currentRecord = currentCache?.visualRecords.get(visualIdentity);
  if (currentRecord && (
    currentRecord.file !== currentFile ||
    currentRecord.visualRevision !== visualRevision
  )) return { error: 'stale_visual' };
  return null;
}

async function getProjectOwnedFileVisual(projectId, visualIdentity, visualRevision) {
  const project = typeof projectId === 'string' ? getProjects().find(item => item && item.id === projectId) : null;
  const cached = getCurrentFileVisualProjectCache(projectId, project);
  const cachedRecord = cached?.visualRecords.get(visualIdentity) || null;
  const file = resolveProjectOwnedFileVisualRecord(projectId, visualIdentity, project);
  if (!file) return { error: 'not_found' };
  const requestEpoch = getFileVisualProjectCacheEpoch(projectId);
  if (
    typeof visualRevision !== 'string' || !FILE_VISUAL_REVISION_PATTERN.test(visualRevision) ||
    (cachedRecord
      ? cachedRecord.visualRevision !== visualRevision
      : await createProjectFileVisualRevision(projectId, file) !== visualRevision)
  ) return { error: 'stale_visual' };
  const request = {
    projectId,
    visualIdentity,
    visualRevision,
    requestEpoch,
    requestProject: project,
    requestFile: file,
  };
  const initialRequestError = getProjectOwnedFileVisualRequestError(request);
  if (initialRequestError) return initialRequestError;
  const ext = (file.ext || path.extname(file.path || '')).toLowerCase();
  if (
    FILE_VISUAL_SAFE_RASTER_EXTENSIONS.has(ext) &&
    typeof file.path === 'string' && path.isAbsolute(file.path) &&
    typeof nativeImage.createThumbnailFromPath === 'function'
  ) {
    const dataUrl = await getBoundedRasterThumbnail(projectId, file, visualRevision);
    const rasterRequestError = getProjectOwnedFileVisualRequestError(request);
    if (rasterRequestError) return rasterRequestError;
    if (dataUrl?.stale) return { error: 'stale_visual' };
    if (dataUrl) return { kind: 'thumbnail', dataUrl };
  }
  const iconDataUrl = await getBoundedFileTypeIcon(ext);
  const iconRequestError = getProjectOwnedFileVisualRequestError(request);
  if (iconRequestError) return iconRequestError;
  if (iconDataUrl) return { kind: 'icon', dataUrl: iconDataUrl };
  return { kind: 'fallback' };
}

function getExistingAssetReviewFiles(project) {
  if (!project || typeof project !== 'object') return [];
  return [...(project.files || []), ...(project.pendingFiles || [])].filter(file => (
    file && file.assetOrigin === 'existing' && !isProjectAssetBaselineSource(file)
  ));
}

function isAssetReviewFileExcluded(project, file) {
  const key = getAssetReviewExclusionKey(file);
  return !!(key && new Set(project && project.excludedAssetKeys || []).has(key));
}

function getProjectAssetBaselineSourceKeys(project, startedAt) {
  const sourceKeys = new Set();
  for (const file of project && project.files || []) {
    if (!isProjectAssetBaselineSource(file)) continue;
    if (Number.isFinite(file.addedAt) && file.addedAt > startedAt) continue;
    const key = normalizeTrackedFilePath(file.path);
    if (key) sourceKeys.add(key);
  }
  return sourceKeys;
}

function getProjectAssetBaselineSourcePaths(project) {
  const pathsByKey = new Map();
  for (const file of project && project.files || []) {
    if (!isProjectAssetBaselineSource(file) || typeof file.path !== 'string' || !file.path) continue;
    const key = getTrackedFileDedupKey(file);
    if (key && !pathsByKey.has(key)) pathsByKey.set(key, file.path);
  }
  return [...pathsByKey.values()];
}

function beginProjectAssetBaselineScan(
  projectId,
  sourcePath,
  activationToken = null,
  { allowPaused = false, operation = null, project: capturedProject = null } = {}
) {
  const project = capturedProject || getProjects().find(item => item.id === projectId);
  if (!project || (project.status !== 'watching' && !(allowPaused && project.status === 'paused'))) return null;
  if (activationToken !== null) {
    const operationCurrent = operation && typeof operation.currentFast === 'function'
      ? operation.currentFast()
      : operation && typeof operation.current === 'function'
        ? operation.current()
        : isActiveWatchingProject(projectId, activationToken);
    if (!operationCurrent) return null;
  }
  if (!project.assetBaseline || project.assetBaseline.status !== 'awaiting-first-scan') return null;
  if (!isAcceptedProjectFilePath(project, sourcePath)) return null;
  const sourceKey = normalizeTrackedFilePath(sourcePath);
  const acceptedSource = (project.files || []).find(file => normalizeTrackedFilePath(file && file.path) === sourceKey);
  if (!sourceKey || !isProjectAssetBaselineSource(acceptedSource)) return null;

  let state = assetBaselineScans.get(projectId);
  if (!state) {
    const startedAt = Date.now();
    state = {
      startedAt,
      requiredSourceKeys: getProjectAssetBaselineSourceKeys(project, startedAt),
      completedSourceKeys: new Set(),
      inFlightBySource: new Map(),
      activeScans: new Set(),
      queuedSourceKeys: new Set(),
      queuedScansByOperation: new Map(),
      presentationMediaOccurrencesBySource: new Map(),
    };
    assetBaselineScans.set(projectId, state);
  } else {
    state.queuedSourceKeys ||= new Set();
    state.queuedScansByOperation ||= new Map();
    state.requiredSourceKeys.add(sourceKey);
    if (operation && state.queuedScansByOperation.has(operation)) {
      const queued = state.queuedScansByOperation.get(operation);
      queued.delete(sourceKey);
      if (queued.size === 0) state.queuedScansByOperation.delete(operation);
    }
    const stillQueued = [...state.queuedScansByOperation.values()].some(queued => queued.has(sourceKey));
    if (!stillQueued) state.queuedSourceKeys.delete(sourceKey);
  }

  state.inFlightBySource.set(sourceKey, (state.inFlightBySource.get(sourceKey) || 0) + 1);
  const scan = {
    projectId,
    sourceKey,
    startedAt: state.startedAt,
    activationToken,
    allowPaused,
    operation,
  };
  state.activeScans ||= new Set();
  state.activeScans.add(scan);
  return scan;
}

async function completeProjectAssetBaselineScan(scan, dependable) {
  if (!scan) return;
  const state = assetBaselineScans.get(scan.projectId);
  if (!state) return;

  const wasActive = state.activeScans?.delete(scan) !== false;
  const attemptIsCurrent = () => !scan.cancelled && (!scan.operation || (
    typeof scan.operation.currentFast === 'function'
      ? scan.operation.currentFast()
      : scan.operation.current()
  ));
  const authoritativeAttemptIsCurrent = () => !scan.cancelled && (!scan.operation || scan.operation.current());

  const remaining = Math.max(0, (state.inFlightBySource.get(scan.sourceKey) || 0) - 1);
  if (wasActive) {
    if (remaining > 0) state.inFlightBySource.set(scan.sourceKey, remaining);
    else state.inFlightBySource.delete(scan.sourceKey);
  }
  // A timed-out or superseded Add Files attempt may settle after the IPC
  // response. It can release its own in-flight slot, but it must not establish
  // or rewrite the shared baseline from a late result.
  if (!attemptIsCurrent()) return;
  // A duplicate observer can start more than one scan for the same source.
  // One dependable completion is sufficient; a later failed duplicate must not
  // erase that proof and make the result depend on completion order.
  if (dependable) state.completedSourceKeys.add(scan.sourceKey);

  if (state.inFlightBySource.size > 0 || state.queuedSourceKeys?.size > 0) return;
  const complete = [...state.requiredSourceKeys].every(key => state.completedSourceKeys.has(key));
  if (!complete) {
    const failedSourceKeys = new Set(
      [...state.requiredSourceKeys].filter(key => !state.completedSourceKeys.has(key))
    );
    const currentProject = getProjects().find(project => project.id === scan.projectId);
    const recoveryRecords = currentProject
      ? (await Promise.all(
          (currentProject.files || [])
            .filter(file => (
              isProjectAssetBaselineSource(file) &&
              failedSourceKeys.has(normalizeTrackedFilePath(file.path))
            ))
            .map(file => getAssetBaselineSourceRecoveryRecord(currentProject, file))
        )).filter(Boolean).sort((left, right) => left.sourceKeyHash.localeCompare(right.sourceKeyHash))
      : [];
    if (!authoritativeAttemptIsCurrent()) return;
    const persisted = mutateProject(scan.projectId, project => {
      if (project.assetBaseline?.status !== 'awaiting-first-scan' || !attemptIsCurrent()) return false;
      const validRouteKeys = new Set(
        (project.files || [])
          .filter(isProjectAssetBaselineSource)
          .map(file => getAssetBaselineSourceRecoveryRouteKey(project, file))
          .filter(Boolean)
      );
      const applicableRecords = recoveryRecords.filter(record => validRouteKeys.has(record.sourceKeyHash));
      const previous = Array.isArray(project.assetBaseline.failedRequiredSources)
        ? project.assetBaseline.failedRequiredSources
        : [];
      if (JSON.stringify(previous) === JSON.stringify(applicableRecords)) return false;
      if (applicableRecords.length > 0) project.assetBaseline.failedRequiredSources = applicableRecords;
      else delete project.assetBaseline.failedRequiredSources;
      return true;
    });
    if (persisted && attemptIsCurrent()) sendToRenderer('project:updated', { projectId: scan.projectId });
    return;
  }

  if (!authoritativeAttemptIsCurrent()) return;
  const result = establishProjectAssetBaseline(
    scan.projectId,
    null,
    scan.activationToken,
    state.startedAt,
    { allowPaused: scan.allowPaused }
  );
  const current = getProjects().find(item => item.id === scan.projectId);
  if (result || !current || !current.assetBaseline || current.assetBaseline.status !== 'awaiting-first-scan') {
    assetBaselineScans.delete(scan.projectId);
  }
}

function cancelProjectAssetBaselineScanOperation(projectId, operation, sourcePaths = []) {
  const state = assetBaselineScans.get(projectId);
  if (!state) return;
  for (const scan of [...(state.activeScans || [])]) {
    if (scan.operation !== operation) continue;
    scan.cancelled = true;
    state.activeScans.delete(scan);
    const remaining = Math.max(0, (state.inFlightBySource.get(scan.sourceKey) || 0) - 1);
    if (remaining > 0) state.inFlightBySource.set(scan.sourceKey, remaining);
    else state.inFlightBySource.delete(scan.sourceKey);
  }
  const ownedQueue = state.queuedScansByOperation?.get(operation);
  for (const sourceKey of ownedQueue || []) {
    if (![...state.queuedScansByOperation.entries()]
      .some(([owner, queued]) => owner !== operation && queued.has(sourceKey))) {
      state.queuedSourceKeys?.delete(sourceKey);
    }
  }
  if (ownedQueue) state.queuedScansByOperation.delete(operation);
}

const MANUAL_ADD_SCAN_CONCURRENCY = 4;
const ADD_FILES_PARSE_MEMORY_BUDGET_BYTES = 128 * 1024 * 1024;
const ADD_FILES_PARSE_MEMORY_MIN_RESERVATION_BYTES = 1024 * 1024;
const ADD_FILES_PSD_PARSE_MEMORY_MULTIPLIER = 4;
const MANUAL_ADD_FILES_ADMISSION_BATCH_SIZE = 512;

function createAddFilesParseMemoryBudget(maxBytes = ADD_FILES_PARSE_MEMORY_BUDGET_BYTES) {
  let reservedBytes = 0;
  return {
    async acquire(sourceBytes, operation, { parser = 'default' } = {}) {
      const isCurrent = typeof operation.currentFast === 'function'
        ? () => operation.currentFast()
        : () => operation.current();
      const multiplier = parser === 'psd' ? ADD_FILES_PSD_PARSE_MEMORY_MULTIPLIER : 2;
      const estimatedParseBytes = Number.isSafeInteger(sourceBytes)
        ? Math.min(Number.MAX_SAFE_INTEGER, sourceBytes * multiplier)
        : 0;
      const reservationBytes = Math.max(
        ADD_FILES_PARSE_MEMORY_MIN_RESERVATION_BYTES,
        estimatedParseBytes
      );
      if (reservationBytes > maxBytes) {
        return { error: 'asset_baseline_source_too_large' };
      }
      while (reservedBytes > 0 && reservedBytes + reservationBytes > maxBytes) {
        if (!isCurrent()) return null;
        await new Promise(resolve => setImmediate(resolve));
      }
      if (!isCurrent()) return null;
      reservedBytes += reservationBytes;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          reservedBytes = Math.max(0, reservedBytes - reservationBytes);
        },
      };
    },
  };
}

const sharedAddFilesParseMemoryBudget = createAddFilesParseMemoryBudget();

function ensureProjectAssetBaselineScanState(projectId, sourcePaths = []) {
  const project = getProjects().find(item => item.id === projectId);
  if (!project || project.assetBaseline?.status !== 'awaiting-first-scan') return null;

  let state = assetBaselineScans.get(projectId);
  if (!state) {
    const startedAt = Date.now();
    state = {
      startedAt,
      requiredSourceKeys: getProjectAssetBaselineSourceKeys(project, startedAt),
      completedSourceKeys: new Set(),
      inFlightBySource: new Map(),
      activeScans: new Set(),
      queuedSourceKeys: new Set(),
      queuedScansByOperation: new Map(),
      presentationMediaOccurrencesBySource: new Map(),
    };
    assetBaselineScans.set(projectId, state);
  }
  state.queuedSourceKeys ||= new Set();
  state.queuedScansByOperation ||= new Map();

  for (const sourcePath of sourcePaths) {
    const sourceKey = normalizeTrackedFilePath(sourcePath);
    if (sourceKey) state.requiredSourceKeys.add(sourceKey);
  }
  return state;
}

function reserveProjectAssetBaselineScanQueue(projectId, sourcePaths, operation = null) {
  const uniquePaths = [...new Map(
    (Array.isArray(sourcePaths) ? sourcePaths : [])
      .map(sourcePath => [normalizeTrackedFilePath(sourcePath), sourcePath])
      .filter(([sourceKey, sourcePath]) => sourceKey && typeof sourcePath === 'string' && sourcePath)
  ).values()];
  const state = ensureProjectAssetBaselineScanState(projectId, uniquePaths);
  if (state) {
    const ownedQueue = operation
      ? (state.queuedScansByOperation.get(operation) || new Set())
      : null;
    for (const sourcePath of uniquePaths) {
      const sourceKey = normalizeTrackedFilePath(sourcePath);
      if (!sourceKey) continue;
      state.queuedSourceKeys.add(sourceKey);
      ownedQueue?.add(sourceKey);
    }
    if (ownedQueue && ownedQueue.size > 0) state.queuedScansByOperation.set(operation, ownedQueue);
  }
  return uniquePaths;
}

function cancelProjectAssetBaselineScanQueue(projectId, sourcePaths) {
  const state = assetBaselineScans.get(projectId);
  if (!state) return;
  for (const sourcePath of Array.isArray(sourcePaths) ? sourcePaths : []) {
    const sourceKey = normalizeTrackedFilePath(sourcePath);
    if (!sourceKey || !state.queuedSourceKeys?.has(sourceKey)) continue;
    state.queuedSourceKeys.delete(sourceKey);
    state.requiredSourceKeys.delete(sourceKey);
  }
  if (state.inFlightBySource.size === 0 && state.requiredSourceKeys.size === 0) {
    assetBaselineScans.delete(projectId);
  }
}

async function runBoundedScanOnOpenQueue(projectId, sourcePaths, activationToken, operation, options = {}) {
  const queuedPaths = reserveProjectAssetBaselineScanQueue(projectId, sourcePaths, operation);
  // All workers in this one fenced queue start from the same project object.
  // It is used only for read-only admission checks; authoritative operation
  // checks still guard every mutation and final baseline write.
  const queueProject = options.project || getProjects().find(project => project.id === projectId) || null;
  const scanOptions = options.project ? options : { ...options, project: queueProject };
  const parseMemoryBudget = options.parseMemoryBudget || sharedAddFilesParseMemoryBudget;
  const outcomes = new Array(queuedPaths.length);
  let nextIndex = 0;

  const runNext = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= queuedPaths.length) return;
      const sourcePath = queuedPaths[index];
      if (!operation.current()) {
        outcomes[index] = { path: sourcePath, success: false, error: 'stale_project_operation' };
        continue;
      }
      try {
        let reservationStat = null;
        try {
          reservationStat = await fs.promises.stat(sourcePath);
        } catch (_) {
          // Let runScanOnOpen establish and complete the baseline record for
          // a missing source; the scan-level failure must remain observable.
        }
        if (!reservationStat) {
          const result = await runScanOnOpen(projectId, sourcePath, activationToken, operation, scanOptions);
          if (!operation.current()) {
            outcomes[index] = { path: sourcePath, success: false, error: 'stale_project_operation' };
          } else if (result && result.success === false) {
            outcomes[index] = { path: sourcePath, success: false, error: result.error || 'scan_on_open_failed' };
          } else {
            outcomes[index] = { path: sourcePath, success: true };
          }
          continue;
        }
        if (!operation.current()) {
          outcomes[index] = { path: sourcePath, success: false, error: 'stale_project_operation' };
          continue;
        }
        const reservation = await parseMemoryBudget.acquire(
          reservationStat.size,
          operation,
          { parser: path.extname(sourcePath).toLowerCase() === '.psd' ? 'psd' : 'default' }
        );
        if (!reservation) {
          outcomes[index] = { path: sourcePath, success: false, error: 'stale_project_operation' };
          continue;
        }
        if (reservation.error) {
          // Do not parse an input that cannot fit the reservation budget.
          // Convert the queued item into an ordinary failed baseline scan so
          // its queue ownership is released and recovery remains observable.
          const failedScan = beginProjectAssetBaselineScan(projectId, sourcePath, activationToken, {
            allowPaused: scanOptions.allowPausedBaseline === true,
            operation,
            project: queueProject,
          });
          if (failedScan) await completeProjectAssetBaselineScan(failedScan, false);
          outcomes[index] = { path: sourcePath, success: false, error: reservation.error };
          continue;
        }
        let result;
        try {
          result = await runScanOnOpen(projectId, sourcePath, activationToken, operation, {
            ...scanOptions,
            reservationStat,
          });
        } finally {
          reservation.release();
        }
        if (!operation.current()) {
          outcomes[index] = { path: sourcePath, success: false, error: 'stale_project_operation' };
        } else if (result && result.success === false) {
          outcomes[index] = { path: sourcePath, success: false, error: result.error || 'scan_on_open_failed' };
        } else {
          outcomes[index] = { path: sourcePath, success: true };
        }
      } catch (_) {
        outcomes[index] = { path: sourcePath, success: false, error: 'scan_on_open_failed' };
      }
    }
  };

  const workerCount = Math.min(MANUAL_ADD_SCAN_CONCURRENCY, queuedPaths.length);
  const scanWork = Promise.all(Array.from({ length: workerCount }, () => runNext()));
  const settledScanWork = scanWork.catch(() => {});
  const attempt = options.addFilesAttempt;
  if (attempt) {
    const outcome = await Promise.race([
      scanWork.then(() => ({ timedOut: false })),
      attempt.timeoutPromise,
    ]);
    if (outcome.timedOut) {
      attempt.cancel(outcome.reason || 'timeout');
      cancelProjectAssetBaselineScanOperation(projectId, operation, queuedPaths);
      for (let index = 0; index < queuedPaths.length; index++) {
        if (!outcomes[index]) {
          outcomes[index] = { path: queuedPaths[index], success: false, error: 'add_files_timeout' };
        }
      }
      return { cancelled: true, timedOut: true, outcomes, settled: settledScanWork };
    }
  } else {
    await scanWork;
  }
  if (!operation.current()) {
    cancelProjectAssetBaselineScanOperation(projectId, operation, queuedPaths);
    const timedOut = attempt?.state === 'timed-out' || attempt?.reason === 'timeout';
    return { cancelled: true, timedOut, outcomes, settled: settledScanWork };
  }
  return { cancelled: false, outcomes, settled: settledScanWork };
}

function reconcileProjectAssetBaselineScanSources(projectId, { allowPaused = true } = {}) {
  const state = assetBaselineScans.get(projectId);
  const project = getProjects().find(item => item.id === projectId);
  if (!project || project.assetBaseline?.status !== 'awaiting-first-scan') return;
  if (!state) {
    if (normalizeFailedRequiredAssetBaselineSources(project, project.assetBaseline).length > 0) return;
    establishProjectAssetBaseline(projectId, null, null, Date.now(), { allowPaused });
    return;
  }
  const acceptedKeys = new Set(getProjectAssetBaselineSourcePaths(project).map(normalizeTrackedFilePath).filter(Boolean));
  for (const key of [...state.requiredSourceKeys]) {
    if (acceptedKeys.has(key)) continue;
    state.requiredSourceKeys.delete(key);
    state.completedSourceKeys.delete(key);
    state.inFlightBySource.delete(key);
    state.presentationMediaOccurrencesBySource?.delete(key);
  }
  if (state.inFlightBySource.size > 0) return;
  if (![...state.requiredSourceKeys].every(key => state.completedSourceKeys.has(key))) return;
  const result = establishProjectAssetBaseline(projectId, null, null, state.startedAt, { allowPaused });
  const current = getProjects().find(item => item.id === projectId);
  if (result || !current || current.assetBaseline?.status !== 'awaiting-first-scan') {
    assetBaselineScans.delete(projectId);
  }
}

async function isFailedRequiredAssetBaselineSource(project, file) {
  if (!project || !file || project.assetBaseline?.status !== 'awaiting-first-scan') return false;
  const state = assetBaselineScans.get(project.id);
  const sourceKey = normalizeTrackedFilePath(file.path);
  if (state && !(
      sourceKey &&
      state.requiredSourceKeys.has(sourceKey) &&
      !state.completedSourceKeys.has(sourceKey) &&
      !state.inFlightBySource.has(sourceKey)
  )) return false;

  // Live scan state identifies which source failed, but path identity alone is
  // not removal authority. Require the same persisted physical-identity proof
  // used after restart so a replacement at the failed path cannot inherit it.
  const sourceKeyHash = getAssetBaselineSourceRecoveryRouteKey(project, file);
  const record = sourceKeyHash && normalizeFailedRequiredAssetBaselineSources(project, project.assetBaseline)
    .find(candidate => candidate.sourceKeyHash === sourceKeyHash);
  if (!record) return false;
  const currentRecord = await getAssetBaselineSourceRecoveryRecord(project, file);
  return !!(
    currentRecord &&
    currentRecord.sourceKeyHash === record.sourceKeyHash &&
    currentRecord.physicalIdentityHash === record.physicalIdentityHash
  );
}

function hasInFlightAssetBaselineScan(projectId) {
  const state = assetBaselineScans.get(projectId);
  return !!(state && state.inFlightBySource.size > 0);
}

function projectHasUnresolvedLocalAssetBaseline(project) {
  return !!(
    project &&
    project.assetBaseline &&
    (project.assetBaseline.status === 'invalid' || (
      project.assetBaseline.status === 'awaiting-first-scan' &&
      getProjectAssetBaselineSourceKeys(project, Date.now()).size > 0
    ))
  );
}

function establishProjectAssetBaseline(
  projectId,
  sourcePath,
  activationToken = null,
  scanStartedAt = Date.now(),
  { allowPaused = false } = {}
) {
  const baselineScanState = assetBaselineScans.get(projectId);
  const presentationMediaOccurrences = normalizePresentationMediaOccurrences(
    baselineScanState
      ? [...(baselineScanState.presentationMediaOccurrencesBySource || new Map()).values()].flat()
      : []
  );
  const result = mutateProject(projectId, (project) => {
    if (project.status !== 'watching' && !(allowPaused && project.status === 'paused')) return null;
    if (activationToken !== null && !isActiveWatchingProject(projectId, activationToken)) return null;
    if (!project.assetBaseline || project.assetBaseline.status !== 'awaiting-first-scan') return null;
    if (sourcePath && !isAcceptedProjectFilePath(project, sourcePath)) return null;

    const establishedAt = Number.isFinite(scanStartedAt) ? scanStartedAt : Date.now();
    const baseline = {
      schemaVersion: ASSET_REVIEW_SCHEMA_VERSION,
      status: 'empty',
      decision: null,
      establishedAt,
    };
    if (presentationMediaOccurrences.length > 0) {
      baseline.presentationMediaOccurrences = presentationMediaOccurrences;
    }
    project.assetBaseline = baseline;

    for (const collection of [project.files, project.pendingFiles]) {
      if (!Array.isArray(collection)) continue;
      for (const file of collection) {
        if (!file || typeof file !== 'object') continue;
        if (!PROJECT_FILE_ROLES.has(file.projectRole)) {
          file.projectRole = inferProjectFileRole(file);
        }
        if (!ASSET_ORIGINS.has(file.assetOrigin)) {
          const origin = inferAssetOrigin(project, file, baseline);
          if (ASSET_ORIGINS.has(origin)) file.assetOrigin = origin;
        }
      }
    }

    const existingAssets = getExistingAssetReviewFiles(project);
    project.assetBaseline.status = existingAssets.length > 0 ? 'decision-required' : 'empty';
    return {
      changed: true,
      status: project.assetBaseline.status,
      existingAssetCount: existingAssets.length,
    };
  });

  if (result && result.changed) {
    invalidatePackageReviewForProject(projectId);
    sendToRenderer('project:updated', { projectId });
  }
  return result;
}

function setProjectExistingAssetsDecision(projectId, decision) {
  if (!ASSET_BASELINE_DECISIONS.has(decision)) {
    return { success: false, error: 'invalid_asset_baseline_decision' };
  }

  const result = mutateProject(projectId, (project) => {
    const baseline = project.assetBaseline;
    if (!baseline || !['decision-required', 'included', 'skipped', 'legacy-included'].includes(baseline.status)) {
      return { success: false, error: 'asset_baseline_decision_unavailable' };
    }

    const existingAssets = getExistingAssetReviewFiles(project);
    const existingAssetKeys = new Set(
      existingAssets
        .map(getAssetReviewExclusionKey)
        .filter(Boolean)
    );
    const excludedKeys = new Set(project.excludedAssetKeys || []);
    for (const key of existingAssetKeys) {
      if (decision === 'skip') excludedKeys.add(key);
      else excludedKeys.delete(key);
    }

    if (decision === 'include') {
      const existingPendingKeys = new Set(
        (project.pendingFiles || [])
          .filter(file => file && file.assetOrigin === 'existing' && !isProjectAssetBaselineSource(file))
          .map(getTrackedFileDedupKey)
          .filter(Boolean)
      );
      const acceptedKeys = getTrackedFileKeySet(project.files);
      const remainingPending = [];
      for (const file of project.pendingFiles || []) {
        const dedupKey = getTrackedFileDedupKey(file);
        if (!dedupKey || !existingPendingKeys.has(dedupKey)) {
          remainingPending.push(file);
          continue;
        }
        if (!acceptedKeys.has(dedupKey)) {
          const acceptedFile = {
            ...createAcceptedPendingFile(file),
          };
          project.files.push(acceptedFile);
          acceptedKeys.add(dedupKey);
          recordSessionObservedFile(project, acceptedFile, {
            kind: OBSERVER_KINDS.MANUAL_USER_ACTION,
            method: 'projects:set-existing-assets-decision',
            payload: { decision: 'include' },
          });
        }
      }
      project.pendingFiles = remainingPending;
      project.files = deduplicateFiles(project.files);
    }

    project.excludedAssetKeys = [...excludedKeys];
    project.assetBaseline = {
      ...baseline,
      status: decision === 'include' ? 'included' : 'skipped',
      decision,
    };
    return { success: true };
  });

  if (!result || !result.success) return result || { success: false, error: 'project_not_found' };
  invalidatePackageReviewForProject(projectId);
  sendToRenderer('project:updated', { projectId });
  const project = getProjects().find(item => item.id === projectId);
  return { success: true, project: getIllustratorScopedProjectView(project) };
}

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

const DESIGN_APP_PROCESS_KEYWORDS = Object.freeze(
  DESIGN_APP_PROCESS_IDENTITIES.map(identity => identity.keyword)
);

const PRESENTATION_PROCESS_APP_FAMILIES = new Set(['powerpoint', 'keynote']);

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

function isAllowedLsofPathForApp(filePath, commandText, home) {
  const appIdentity = getDesignAppProcessIdentity(commandText);
  if (!appIdentity || !PRESENTATION_PROCESS_APP_FAMILIES.has(appIdentity.appFamily)) return true;
  return filePath.startsWith(home + '/Desktop/') ||
    filePath.startsWith(home + '/Documents/') ||
    filePath.startsWith(home + '/Downloads/');
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

  return redactPrivatePathText(
    redactUrlAndCredentialText(text)
      .replace(/\b\d+:\d+\b/g, '[redacted-figma-scope-id]')
  );
}

function sanitizeFigmaRendererIssue(value, fallback = 'Figma scan could not finish. Try again.') {
  const safeText = redactFigmaLogText(value)
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  return safeText || fallback;
}

function sanitizeFigmaRendererIssues(values) {
  return (Array.isArray(values) ? values : [])
    .map(value => sanitizeFigmaRendererIssue(value, null))
    .filter(Boolean);
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
    keyPresent: !!(entry && typeof entry.key === 'string' && entry.key.trim()),
    scopeMode: formatFigmaLogScalar(entry && entry.scopeMode),
    lockStatus: formatFigmaLogScalar(entry && entry.lockStatus),
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

function hasFigmaAuthError(errors) {
  return (Array.isArray(errors) ? errors : [errors]).some(error => {
    const type = error && typeof error === 'object' ? error.type : '';
    const message = typeof error === 'string' ? error : ((error && error.message) || '');
    const lower = String(message).toLowerCase();
    return type === 'auth' || lower.includes('401') || lower.includes('unauthorized') ||
      lower.includes('token invalid') || lower.includes('invalid figma api token') ||
      lower.includes('personal access token');
  });
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
    },
    retryAfterMs: normalizeFigmaRateLimitDuration(diagnostics.retryAfterMs)
  };
}

function hasFigmaRateLimitDiagnostic(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object') return false;
  const metadataReasons = diagnostics.metadataFailureReasonCounts || {};
  const fileFetchReasons = diagnostics.fileFetchFailureReasonCounts || {};
  return Number(metadataReasons['rate-limited'] || 0) > 0 ||
    Number(fileFetchReasons['rate-limited'] || 0) > 0;
}

function hasFigmaInvalidTokenDiagnostic(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object') return false;
  const metadataReasons = diagnostics.metadataFailureReasonCounts || {};
  const fileFetchReasons = diagnostics.fileFetchFailureReasonCounts || {};
  return Number(metadataReasons['invalid-token'] || 0) > 0 ||
    Number(fileFetchReasons['invalid-token'] || 0) > 0;
}

function figmaRateLimitWarning() {
  return 'Figma is temporarily rate limiting this scan. Crate will retry after a cooldown; no Figma assets will be captured for this file in this session until Figma allows the request.';
}

function normalizeFigmaRateLimitDuration(value) {
  return Number.isSafeInteger(value) && value > 0
    ? Math.min(value, FIGMA_MAX_RATE_LIMIT_BACKOFF_MS)
    : null;
}

function getFigmaScanRetryAfterMs(scanResult) {
  if (!scanResult || typeof scanResult !== 'object') return null;
  const candidates = [
    scanResult.retryAfterMs,
    scanResult.candidateDiagnostics && scanResult.candidateDiagnostics.retryAfterMs,
    ...(Array.isArray(scanResult.scopeEntries)
      ? scanResult.scopeEntries.map(entry => entry && entry.retryAfterMs)
      : [])
  ].map(normalizeFigmaRateLimitDuration).filter(Boolean);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function setFigmaRateLimitBackoff(projectId, retryAfterMs = null) {
  const duration = normalizeFigmaRateLimitDuration(retryAfterMs) || FIGMA_RATE_LIMIT_BACKOFF_MS;
  const retryAt = Date.now() + duration;
  figmaRateLimitBackoffs.set(projectId, retryAt);
  return retryAt;
}

function clearFigmaRateLimitBackoff(projectId) {
  figmaRateLimitBackoffs.delete(projectId);
}

function getFigmaRateLimitRetryAt(projectId, project = null) {
  const inMemory = normalizeFigmaRateLimitRetryAt(figmaRateLimitBackoffs.get(projectId));
  const persisted = normalizeFigmaRateLimitRetryAt(
    project && project.figmaSession && project.figmaSession.rateLimitRetryAt
  );
  const retryAt = Math.max(inMemory || 0, persisted || 0);
  if (retryAt > Date.now()) {
    figmaRateLimitBackoffs.set(projectId, retryAt);
    return retryAt;
  }
  figmaRateLimitBackoffs.delete(projectId);
  return 0;
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

function updateFigmaSessionRateLimitWarning(projectId, retryAt) {
  return mutateProject(projectId, (project) => {
    if (!project.figmaSession || !Array.isArray(project.figmaSession.trackedFiles)) return null;
    let changed = false;
    const warning = figmaRateLimitWarning();
    const safeRetryAt = normalizeFigmaRateLimitRetryAt(retryAt);
    if (project.figmaSession.rateLimitRetryAt !== safeRetryAt) {
      project.figmaSession.rateLimitRetryAt = safeRetryAt;
      changed = true;
    }
    for (const trackedFile of project.figmaSession.trackedFiles) {
      if (trackedFile.lockStatus !== 'unresolved') {
        trackedFile.lockStatus = 'unresolved';
        changed = true;
      }
      if (trackedFile.statusReason !== 'figma-current-page-rate-limited') {
        trackedFile.statusReason = 'figma-current-page-rate-limited';
        changed = true;
      }
      if (trackedFile.failureCategory !== 'rate-limited') {
        trackedFile.failureCategory = 'rate-limited';
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

function clearFigmaRateLimitState(projectId) {
  clearFigmaRateLimitBackoff(projectId);
  return mutateProject(projectId, (project) => {
    const session = project.figmaSession;
    if (!session || !Array.isArray(session.trackedFiles)) return null;
    let changed = false;
    if (session.rateLimitRetryAt != null) {
      delete session.rateLimitRetryAt;
      changed = true;
    }
    const warning = figmaRateLimitWarning();
    for (const trackedFile of session.trackedFiles) {
      if (trackedFile.statusReason === 'figma-current-page-rate-limited') {
        trackedFile.statusReason = null;
        changed = true;
      }
      if (trackedFile.warning === warning) {
        trackedFile.warning = null;
        changed = true;
      }
      if (normalizeFigmaFailureCategory(trackedFile.failureCategory) === 'rate-limited') {
        trackedFile.failureCategory = null;
        changed = true;
      }
    }
    const nextWarnings = rebuildFigmaSessionWarnings(session);
    if (JSON.stringify(session.warnings || []) !== JSON.stringify(nextWarnings)) {
      session.warnings = nextWarnings;
      changed = true;
    }
    return changed ? { figmaSession: session } : null;
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
  const dedupedFiles = deduplicateFiles(getIllustratorScopedProjectView(project).files || []);
  const packageFiles = [];

  for (const file of dedupedFiles) {
    if (isAssetReviewFileExcluded(project, file)) {
      continue;
    }

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
        `fileKeyPresent=${!!(file.figmaFileKey && String(file.figmaFileKey).trim())} hasPageId=${!!file.figmaPageId}`
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

// projectType remains accepted for compatibility with persisted and older callers,
// but app recognition is automatic and never narrows a multi-app project.
// Renderer-callable utility — may be invoked via IPC from the renderer process
function isDesignAppFile(filePath, projectType = null) {
  const ext = path.extname(filePath).toLowerCase();

  // Check 1: Was this file created/modified by a known design app?
  const creatorApp = getFileCreatorApp(filePath);
  if (creatorApp) {
    if (DESIGN_APP_BUNDLE_IDS.has(creatorApp)) return true;
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
    return DESIGN_APP_BUNDLE_IDS.has(creatorApp);
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
    const allKeywords = DESIGN_APP_PROCESS_KEYWORDS;
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
const INACTIVITY_TIMEOUT_MS = 180 * 60 * 1000; // 3 hours
const MAX_PARSE_FILE_SIZE = 300 * 1024 * 1024; // 300MB — guard against OOM on huge PSD/AI files
const MAX_PROJECTS = 7;

// Single instance lock
startupPhaseJournal.mark('single-instance-lock-start');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  startupPhaseJournal.mark('single-instance-lock-denied');
  startupPhaseJournal.close();
  app.quit();
} else {
  startupPhaseJournal.mark('single-instance-lock-acquired');
}

let localStorePaths = null;
let localStoreStartupError = null;
let store = null;
startupPhaseJournal.mark('store-preflight-start');
try {
  localStorePaths = preflightLocalStorePaths(app.getPath('userData'));
  startupPhaseJournal.mark('store-path-preflight-complete');
  const candidateStore = new Store({
    cwd: localStorePaths.userDataRealPath,
    configFileMode: OWNER_ONLY_FILE_MODE,
    defaults: {
      projects: [],
      settings: {
        namingTemplate: DEFAULT_NAMING_TEMPLATE,
        notifications: true,
        includeDiagnosticReport: false,
        showPackageDetails: true,
        packageOutputLayoutMode: PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION
      },
      usage: {
        packagesThisMonth: 0,
        resetDate: getNextMonthReset()
      }
    }
  });
  startupPhaseJournal.mark('store-constructor-complete');
  if (
    typeof candidateStore.path !== 'string' ||
    fs.realpathSync.native(candidateStore.path) !== fs.realpathSync.native(localStorePaths.configPath) ||
    !hardenLocalStorePermissions(candidateStore.path, localStorePaths.userDataRealPath)
  ) {
    throw new Error('Crate could not secure local settings storage.');
  }
  startupPhaseJournal.mark('store-path-security-complete');
  validateLocalStoreShape(candidateStore);
  startupPhaseJournal.mark('store-shape-validation-complete');
  store = candidateStore;
  migrateSettings();
  startupPhaseJournal.mark('store-migrations-complete');
  startupPhaseJournal.mark('store-preflight-complete');
} catch (_) {
  store = null;
  localStoreStartupError = new Error('Crate could not secure local settings storage.');
  startupPhaseJournal.mark('store-preflight-failed');
}

// One-time migration: update old naming template format to new one
function validateLocalStoreShape(candidateStore) {
  const projects = candidateStore.get('projects', null);
  const settings = candidateStore.get('settings', null);
  const usage = candidateStore.get('usage', null);
  if (
    !Array.isArray(projects) ||
    !settings ||
    typeof settings !== 'object' ||
    Array.isArray(settings) ||
    !usage ||
    typeof usage !== 'object' ||
    Array.isArray(usage)
  ) {
    throw new Error('Crate could not validate local settings storage.');
  }
}

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
  migratePackageOutputLayoutMode(settings);

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

function getPackageOutputLayoutModeFromSettings(settings) {
  if (
    settings &&
    Object.prototype.hasOwnProperty.call(settings, 'packageOutputLayoutMode')
  ) {
    return normalizePackageOutputLayoutMode(settings.packageOutputLayoutMode);
  }
  return PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION;
}

function migratePackageOutputLayoutMode(settings = store.get('settings') || {}) {
  const hasStoredPreference = Object.prototype.hasOwnProperty.call(
    settings,
    'packageOutputLayoutMode'
  );
  const packageOutputLayoutMode = getPackageOutputLayoutModeFromSettings(settings);
  if (
    !hasStoredPreference ||
    packageOutputLayoutMode !== settings.packageOutputLayoutMode
  ) {
    store.set('settings.packageOutputLayoutMode', packageOutputLayoutMode);
  }
  return packageOutputLayoutMode;
}

function configureFigmaCredentialStorage() {
  try {
    const { safeStorage } = require('electron');
    const { FigmaParser } = require('./parsers/figma');
    const { FigmaCredentialStore } = require('./parsers/figma-credential-store');
    FigmaParser.configureCredentialStore(new FigmaCredentialStore({
      safeStorage,
      userDataPath: app.getPath('userData'),
      legacyTokenPath: path.join(os.homedir(), '.crate', 'figma-token'),
    }));
    return true;
  } catch (_) {
    console.warn('[crate][figma] secure credential storage could not be initialized');
    return false;
  }
}

function migrateFigmaCredentialStorageInBackground() {
  queueMicrotask(async () => {
    try {
      const { FigmaParser } = require('./parsers/figma');
      await new FigmaParser().getStoredToken();
    } catch (_) {
      console.warn('[crate][figma] secure credential migration deferred');
    }
  });
}

function formatLocalDateForUsage(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getNextMonthReset(now = new Date()) {
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return formatLocalDateForUsage(next);
}

function getResetAwareUsageSnapshot(usage, now = new Date()) {
  if (formatLocalDateForUsage(now) < usage.resetDate) return { ...usage };
  return {
    ...usage,
    packagesThisMonth: 0,
    resetDate: getNextMonthReset(now),
  };
}

function checkAndResetUsage() {
  const usage = store.get('usage');
  const nextUsage = getResetAwareUsageSnapshot(usage);
  if (
    nextUsage.packagesThisMonth !== usage.packagesThisMonth ||
    nextUsage.resetDate !== usage.resetDate
  ) {
    store.set('usage', nextUsage);
  }
}

function getPackageEntitlement() {
  const version = getCrateVersion() || '';
  const isClosedBeta = /-beta(?:\.|$)/i.test(version);
  return isClosedBeta
    ? {
        packageLimit: CLOSED_BETA_PACKAGE_LIMIT,
        planId: 'closed-beta',
        planName: 'Closed beta',
      }
    : {
        packageLimit: FREE_PACKAGE_LIMIT,
        planId: 'free',
        planName: 'Free',
      };
}

function getUsageSnapshot() {
  checkAndResetUsage();
  return {
    ...store.get('usage'),
    ...getPackageEntitlement(),
  };
}

function getPackageLimitResult() {
  const usage = getUsageSnapshot();
  if (usage.packagesThisMonth >= usage.packageLimit) {
    const daysLeft = Math.ceil((new Date(usage.resetDate) - new Date()) / (1000 * 60 * 60 * 24));
    return {
      error: 'limit_reached',
      daysLeft,
      packageLimit: usage.packageLimit,
    };
  }
  return null;
}

function incrementPackageUsage() {
  checkAndResetUsage();
  const usage = store.get('usage');
  usage.packagesThisMonth++;
  store.set('usage', usage);
  return usage;
}

// v2.4.2: Validated accessor — always returns an array even if store is corrupted/missing
function getProjects() {
  const val = store.get('projects', []);
  if (!Array.isArray(val)) return [];

  let changed = false;
  for (const project of val) {
    if (migrateProjectFigmaLinkPrivacy(project)) changed = true;
    if (clearPersistedCurrentSessionFilesystemEvidence(project)) changed = true;
    if (normalizeProjectAssetReviewState(project)) changed = true;
  }
  if (changed) {
    clearFileVisualProjectCache();
    store.set('projects', val);
  }
  return val;
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

function recordSessionObservedFile(project, fileEntry, observer = {}, append = appendObservation) {
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
    append(provenance, observation);
  } catch (e) {
    console.warn('[crate][provenance] session_observed_file skipped:', e.message);
  }
}

function recordSessionObservedFiles(project, fileEntries, observer = {}) {
  if (!project || !Array.isArray(fileEntries) || fileEntries.length === 0) return;
  const provenance = ensureProjectProvenance(project);
  if (!provenance) return;
  const observedKeys = new Set(
    (provenance.observations || [])
      .map(observation => observation && observation.dedupeKey)
      .filter(Boolean)
  );
  const appendBatch = (target, observation) => {
    if (!observation || observedKeys.has(observation.dedupeKey)) return;
    target.observations.push(observation);
    observedKeys.add(observation.dedupeKey);
  };
  for (const fileEntry of fileEntries) {
    recordSessionObservedFile(project, fileEntry, observer, appendBatch);
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
    const normalizedPath = normalizeTrackedFilePath(fileEntry.path);
    if (!normalizedPath) return;

    const exclusionKey = getAssetReviewExclusionKey(fileEntry);
    if (exclusionKey) {
      const excludedKeys = new Set(project.excludedAssetKeys || []);
      excludedKeys.add(exclusionKey);
      project.excludedAssetKeys = [...excludedKeys];
    }

    const provenance = ensureProjectProvenance(project);
    if (!provenance) return;

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
  return ext === '.pptx';
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

function recordPackageProvenance(projectId, packageInfo, events = [], targetProject = null) {
  try {
    if (!Array.isArray(events) || events.length === 0) return;
    const apply = project => {
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
        const eventSource = event.resource?.source || event.file?.source || null, payload = { outputPath: event.outputPath || null, source: eventSource, appFamily: event.file ? getScopedFileAppFamily(project, event.file) : getScopedRecordAppFamily(eventSource) };
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
    }; targetProject ? apply(targetProject) : mutateProject(projectId, apply);
  } catch (e) {
    console.warn('[crate][provenance] package provenance skipped:', e.message);
  }
}

function clonePackageCompletionValue(value, seen = new Map()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Buffer.isBuffer(value)) return Buffer.from(value);

  const clone = Array.isArray(value) ? [] : {};
  seen.set(value, clone);
  for (const key of Object.keys(value)) {
    clone[key] = clonePackageCompletionValue(value[key], seen);
  }
  return clone;
}

function persistPackageCompletion(projectId, {
  destFolder,
  packagedAt,
  packageInfo,
  packageEvents,
  presentationExtractionEvents,
}) {
  const currentProjects = store.get('projects', []);
  if (!Array.isArray(currentProjects)) throw new Error('package_state_invalid');

  const nextProjects = clonePackageCompletionValue(currentProjects);
  const nextProject = nextProjects.find(project => project && project.id === projectId);
  if (!nextProject) throw new Error('not_found');

  recordPresentationMediaExtractionProvenanceForProject(
    nextProject,
    presentationExtractionEvents
  );
  recordPackageProvenance(projectId, packageInfo, packageEvents, nextProject);
  nextProject.status = 'packaged';
  nextProject.packagedAt = packagedAt;
  nextProject.outputPath = destFolder;
  normalizeAutoCaptureProjectState(nextProject);
  normalizeProjectAssetReviewState(nextProject);
  safelyEnsureProjectProvenance(nextProject);

  const currentUsage = store.get('usage');
  if (
    !currentUsage ||
    !Number.isSafeInteger(currentUsage.packagesThisMonth) ||
    currentUsage.packagesThisMonth < 0 ||
    typeof currentUsage.resetDate !== 'string'
  ) throw new Error('package_state_invalid');
  const nextUsage = getResetAwareUsageSnapshot(currentUsage);
  nextUsage.packagesThisMonth++;

  const resolvedOutput = path.resolve(destFolder);
  const currentOutputPaths = store.get('quickPackageOutputPaths', []);
  const nextOutputPaths = Array.isArray(currentOutputPaths)
    ? currentOutputPaths.slice()
    : [];
  if (!nextOutputPaths.some(existing => (
    typeof existing === 'string' && path.resolve(existing) === resolvedOutput
  ))) {
    nextOutputPaths.push(resolvedOutput);
  }

  store.set({
    projects: nextProjects,
    usage: nextUsage,
    quickPackageOutputPaths: nextOutputPaths.slice(-50),
  });

  // Preserve existing in-process references after the durable state commit.
  const currentProject = currentProjects.find(project => project && project.id === projectId);
  if (currentProject) {
    const completedProject = clonePackageCompletionValue(nextProject);
    for (const key of Object.keys(currentProject)) delete currentProject[key];
    Object.assign(currentProject, completedProject);
  }
  return nextProject;
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

function normalizeDiagnosticCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function minimizePackageManifestGraph(graph, warnings) {
  const allowedNodeTypes = new Set(Object.values(NODE_TYPES));
  const allowedRelationTypes = new Set(Object.values(EDGE_TYPES));
  const allowedEvidenceKinds = new Set(Object.values(OBSERVER_KINDS));
  const allowedConfidenceBands = new Set(Object.values(CONFIDENCE_BANDS));
  const rawNodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
  const rawEvidence = Array.isArray(graph && graph.evidence) ? graph.evidence : [];
  const rawEdges = Array.isArray(graph && graph.edges) ? graph.edges : [];
  const nodeIdMap = new Map();
  const evidenceIdMap = new Map();
  const reportPrefix = crypto.randomBytes(8).toString('hex');
  let omittedRecord = false;

  const nodes = rawNodes.map((node, index) => {
    const id = `node_${reportPrefix}_${index + 1}`;
    if (node && typeof node.id === 'string') nodeIdMap.set(node.id, id);
    return {
      id,
      type: allowedNodeTypes.has(node && node.type) ? node.type : 'other',
    };
  });

  const evidence = rawEvidence.map((record, index) => {
    const id = `evidence_${reportPrefix}_${index + 1}`;
    if (record && typeof record.id === 'string') evidenceIdMap.set(record.id, id);
    return {
      id,
      kind: allowedEvidenceKinds.has(record && record.kind) ? record.kind : 'other',
    };
  });

  const edges = [];
  for (const edge of rawEdges) {
    const subjectNodeId = nodeIdMap.get(edge && edge.subjectNodeId);
    const objectNodeId = nodeIdMap.get(edge && edge.objectNodeId);
    if (!subjectNodeId || !objectNodeId || !allowedRelationTypes.has(edge && edge.relationType)) {
      omittedRecord = true;
      continue;
    }
    const evidenceIds = (Array.isArray(edge.evidenceIds) ? edge.evidenceIds : [])
      .map(evidenceId => evidenceIdMap.get(evidenceId))
      .filter(Boolean);
    edges.push({
      id: `edge_${reportPrefix}_${edges.length + 1}`,
      relationType: edge.relationType,
      subjectNodeId,
      objectNodeId,
      evidenceIds,
      confidenceBand: allowedConfidenceBands.has(edge.confidence && edge.confidence.band)
        ? edge.confidence.band
        : CONFIDENCE_BANDS.WEAK,
    });
  }

  if (omittedRecord) {
    warnings.push('Malformed or unrecognized diagnostic graph records were omitted.');
  }

  return { nodes, edges, evidence };
}

function buildPackageProvenanceManifest(project, packageInfo, packageResult) {
  const provenance = isRecord(project && project.provenance) ? project.provenance : null;
  const warnings = [
    'Minimized package-relevant diagnostics only; this is not a full project graph.',
    'Project identity, filenames, paths, timestamps, payloads, and persistent identifiers are intentionally omitted.',
  ];
  if (!provenance) {
    warnings.push('Project provenance sidecar was missing or invalid when this manifest was written.');
  }

  const packageNodeId = createNodeId(NODE_TYPES.PACKAGE, {
    projectId: project && project.id ? project.id : null,
    path: packageInfo.destFolder,
    createdAt: packageInfo.createdAt,
  });
  const graph = minimizePackageManifestGraph(
    collectPackageManifestGraph(provenance, packageNodeId, warnings),
    warnings
  );
  const errors = Array.isArray(packageResult.errors) ? packageResult.errors : [];

  return {
    schemaVersion: DIAGNOSTIC_MANIFEST_SCHEMA_VERSION,
    scope: 'minimized_package_relevant',
    generatedBy: {
      app: 'Crate',
      version: getCrateVersion(),
    },
    privacy: {
      mode: 'minimized',
      identifiers: 'report-local',
      content: 'metadata-only',
    },
    package: {
      copiedCount: normalizeDiagnosticCount(packageResult.copiedCount),
      embeddedCount: normalizeDiagnosticCount(packageResult.embeddedCount),
      totalFiles: normalizeDiagnosticCount(packageResult.totalFiles),
      errorCount: normalizeDiagnosticCount(errors.length),
      errorCategories: summarizeDiagnosticPackageErrors(errors),
    },
    nodes: graph.nodes,
    edges: graph.edges,
    evidence: graph.evidence,
    warnings,
  };
}

function isDiagnosticManifestDestinationSafe(destFolder, relativePath = path.join(DIAGNOSTICS_FOLDER_NAME, PROVENANCE_MANIFEST_FILENAME)) { const filePath = path.join(destFolder, relativePath), directoryPath = path.dirname(filePath), lstat = target => { try { return fs.lstatSync(target); } catch (error) { if (error && error.code === 'ENOENT') return null; throw error; } }, directory = lstat(directoryPath); if (directory && (directory.isSymbolicLink() || !directory.isDirectory())) return false; const file = directory && lstat(filePath); return !file || (!file.isSymbolicLink() && file.isFile()); } async function writePackageProvenanceManifest(projectId, packageInfo, packageResult, targetProject = null, fatal = false, writeDestFolder = null, relativePath = path.join(DIAGNOSTICS_FOLDER_NAME, PROVENANCE_MANIFEST_FILENAME), materializeFile = null) {
  try {
    const destination = writeDestFolder || packageInfo.destFolder;
    if (!isDiagnosticManifestDestinationSafe(destination, relativePath)) throw new Error('Unsafe diagnostic manifest destination'); const project = targetProject || getProjects().find(p => p.id === projectId) || null;
    const manifest = buildPackageProvenanceManifest(project, packageInfo, packageResult);
    const data = `${JSON.stringify(manifest, null, 2)}\n`;
    if (typeof materializeFile === 'function') await materializeFile(relativePath, data);
    else {
      writeFileIntoPackageExact(
        destination,
        relativePath,
        data,
        {
          preserveRelativePath: true,
          fallbackName: PROVENANCE_MANIFEST_FILENAME,
          overwrite: true,
        }
      );
    }
  } catch (e) {
    if (fatal) throw Object.assign(new Error('diagnostic_manifest_write_failed'), { code: 'diagnostic_manifest_write_failed' });
    const message = e && typeof e.message === 'string' ? e.message : '';
    const safeMessage = /^(Invalid package output folder|Package output |Package destination )/.test(message)
      ? message
      : 'Diagnostic manifest could not be written safely';
    console.warn('[crate][provenance] manifest write skipped:', safeMessage);
  }
}

// FIX 1 (C1): Atomic store helper — prevents read-mutate-write race conditions
function mutateProject(projectId, fn, { persistIfChanged = false, trustResultChanged = false, rollbackOnNull = false } = {}) {
  const projects = getProjects();
  const project = projects.find(p => p.id === projectId);
  if (!project) return null;
  if (typeof clearFileVisualProjectCache === 'function') clearFileVisualProjectCache(projectId);
  // Background observers can legitimately return changed:false after running
  // their classification/provenance logic. The lsof and live-app observers
  // opt into the result-based fast path, and explicitly report evidenceChanged
  // for a real ledger mutation; all other callers retain the historical write
  // boundary. A generic structural fallback remains available for any future
  // caller that cannot prove this contract.
  let before = null;
  if (rollbackOnNull || (persistIfChanged && !trustResultChanged)) {
    try { before = JSON.stringify(project); } catch (_) { before = null; }
  }
  const result = fn(project, projects);
  if (rollbackOnNull && result === null && before !== null) {
    try {
      const restored = JSON.parse(before);
      for (const key of Object.keys(project)) delete project[key];
      Object.assign(project, restored);
    } catch (_) {}
  }
  const resultChanged = !!(result && result.changed === true);
  if (!persistIfChanged || !trustResultChanged || resultChanged) {
    normalizeAutoCaptureProjectState(project);
    normalizeProjectAssetReviewState(project);
    safelyEnsureProjectProvenance(project);
  }
  let shouldPersist = !persistIfChanged;
  if (persistIfChanged && trustResultChanged) {
    shouldPersist = resultChanged;
  } else if (persistIfChanged) {
    try { shouldPersist = before === null || JSON.stringify(project) !== before; } catch (_) { shouldPersist = true; }
  }
  if (shouldPersist) {
    store.set('projects', projects);
  }
  return result;
}

// FIX 2 (C2): Track in-flight pre-package scans
const scanInFlight = new Set();
const assetBaselineScans = new Map();
const packageScanSettlements = new Map();
const incompletePackageScans = new Set();
const packageScanDiagnosticState = new Map();
const PACKAGE_REVIEW_DIAGNOSTIC_PHASES = new Set([
  'pre-package-discovery',
  'pre-package-app-scan',
  'pre-package-scan-in-flight',
  'background-watch-drain',
  'package-input-scan-wait',
  'prepare-package-review',
]);
const FIGMA_PACKAGE_TRANSFER_ERROR = 'Crate could not securely retrieve all Figma assets. No package was written. Try again.';
const figmaPackageTransferBlocks = new Map();
function restoreFigmaPackageTransferBlock(projectId, previousBlock) {
  if (previousBlock === undefined) figmaPackageTransferBlocks.delete(projectId);
  else figmaPackageTransferBlocks.set(projectId, previousBlock);
}

function safePackageReviewDiagnosticInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isValidFigmaCurrentPagePackageScope(trackedFile, scopeEntry) {
  if (!trackedFile || !scopeEntry) return false;
  if (scopeEntry.scopeMode !== FIGMA_SCOPE_CURRENT_PAGE) return false;
  if (scopeEntry.fileFetchStatus !== 'success' || scopeEntry.assetFetchStatus === 'failed') return false;
  if (scopeEntry.lockStatus !== 'locked') return false;

  const resolvedPageId = normalizeStoredFigmaScopeId(scopeEntry.lockedPageId);
  if (!resolvedPageId) return false;

  // Node-scoped links resolve to their enclosing page; the persisted
  // lockedPageId is the validated identity that package-time scope can compare.
  const explicitPageIds = [trackedFile.requestedPageId, trackedFile.lockedPageId]
    .map(normalizeStoredFigmaScopeId)
    .filter(Boolean);
  return explicitPageIds.every(pageId => pageId === resolvedPageId);
}

function createPackageReviewDiagnosticEvidence(details = {}) {
  const diagnostics = {};
  if (PACKAGE_REVIEW_DIAGNOSTIC_PHASES.has(details.failurePhase)) {
    diagnostics.failurePhase = details.failurePhase;
  }
  for (const field of ['phaseElapsedMs', 'candidateCount', 'xattrResolvedCount', 'metadataFallbackCount']) {
    const value = safePackageReviewDiagnosticInteger(details[field]);
    if (value !== null) diagnostics[field] = value;
  }
  return diagnostics;
}

function createPackageReviewErrorResult(projectId, errorCode, details = {}, includeStoredScanDetails = true) {
  const scanDetails = includeStoredScanDetails
    ? packageScanDiagnosticState.get(projectId) || {}
    : {};
  return {
    error: errorCode,
    diagnostics: createPackageReviewDiagnosticEvidence({ ...scanDetails, ...details }),
  };
}

function didFigmaPrePackageScanSucceed(scanResult, rawTrackedFiles) {
  const errors = Array.isArray(scanResult && scanResult.errors) ? scanResult.errors : [];
  const scopeEntries = Array.isArray(scanResult && scanResult.scopeEntries) ? scanResult.scopeEntries : [];
  const trackedFiles = Array.isArray(rawTrackedFiles) ? rawTrackedFiles : [];

  if (
    (scanResult && scanResult.rateLimited === true) ||
    getFigmaScanRetryAfterMs(scanResult) !== null ||
    hasFigmaRateLimitDiagnostic(scanResult && scanResult.candidateDiagnostics)
  ) return false;

  if (trackedFiles.length === 0) return errors.length === 0;

  return trackedFiles.every((trackedFile) => {
    const primaryKey = typeof trackedFile.key === 'string' ? trackedFile.key.trim() : '';
    const candidateKeys = new Set(figmaTrackedFileKeys(trackedFile));
    return scopeEntries.some((entry) => {
      if (!entry || entry.fileFetchStatus !== 'success' || entry.assetFetchStatus === 'failed') return false;
      const entryPrimaryKey = typeof entry.primaryKey === 'string' ? entry.primaryKey.trim() : '';
      const matchesTrackedFile = entryPrimaryKey && primaryKey
        ? entryPrimaryKey === primaryKey
        : typeof entry.fileKey === 'string' && candidateKeys.has(entry.fileKey.trim());
      if (!matchesTrackedFile) return false;
      if (trackedFile.scopeMode === FIGMA_SCOPE_CURRENT_PAGE) {
        return isValidFigmaCurrentPagePackageScope(trackedFile, entry);
      }
      return true;
    });
  });
}

// Main-process single-flight guards for mutating package and project creation requests.
let packageInFlight = false;
let projectCreationInFlight = null;
const PACKAGE_REVIEW_TOKEN_TTL_MS = 15 * 60 * 1000;
const CONSUMED_PACKAGE_REVIEW_TOKEN_CAPACITY = 256;
const PACKAGE_REVIEW_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const packageReviewSnapshots = new Map();
const currentPackageReviewTokenByProject = new Map();
const consumedPackageReviewTokens = new Map();

let tray = null;
// Historical name retained for existing renderer send paths; this is now the main app window.
let trayWindow = null;
registerStartupDiagnosticIpc();
app.on('web-contents-created', (_event, webContents) => {
  markFirstOccurrenceStartupPhase('web-contents-created');
  if (webContents && typeof webContents.on === 'function') {
    webContents.on('preload-error', () => {
      markFirstOccurrenceStartupPhase('preload-error');
    });
  }
});
app.on('child-process-gone', () => {
  markFirstOccurrenceStartupPhase('child-process-gone');
});
let mainWindowShowFallback = null;
const mainWindowStartupRetryTimers = new Set();
const watchers = new Map(); // projectId -> chokidar watcher
const watcherCoordinators = new Map(); // projectId -> one non-lsof heavy background observer at a time
const watcherStartupTimers = new Map(); // projectId:kind -> delayed initial observer timer
const watcherDeferredOperations = new Map(); // projectId -> bounded deferred operation entries
const watcherDeferredTimers = new Map(); // projectId -> bounded backoff wakeup
const lastFileActivity = new Map(); // projectId -> timestamp
const inactivityNotified = new Set(); // projectIds already notified
const watchingActivationTokens = new Map(); // projectId -> current watch-session token
const illustratorActivationScopes = new Map(); // projectId -> transient Illustrator activation scope
let watchingActivationSequence = 0;

const BACKGROUND_WATCHER_BUDGET_MS = 2500;
const BACKGROUND_WATCHER_DRAIN_TIMEOUT_MS = 15000;
const CHOKIDAR_ADD_STAT_TIMEOUT_MS = 1000;
const MAX_DEFERRED_WATCHER_OPERATIONS_PER_PROJECT = 64;
const MAX_CURRENT_SESSION_FILESYSTEM_EVIDENCE_PER_PROJECT = 512;
const currentSessionFilesystemEvidenceByProject = new Map();

function currentSessionFilesystemEvidenceKey(projectId, filePath) {
  const normalizedPath = normalizeTrackedFilePath(filePath);
  if (!projectId || !normalizedPath) return null;
  return `${projectId}:${normalizedPath}`;
}

function markCurrentSessionFilesystemEvidence(projectId, filePath, activationToken) {
  const key = currentSessionFilesystemEvidenceKey(projectId, filePath);
  if (!key || activationToken === null || activationToken === undefined) return;
  let entries = currentSessionFilesystemEvidenceByProject.get(projectId);
  if (!entries) {
    entries = new Map();
    currentSessionFilesystemEvidenceByProject.set(projectId, entries);
  }
  entries.delete(key);
  entries.set(key, activationToken);
  while (entries.size > MAX_CURRENT_SESSION_FILESYSTEM_EVIDENCE_PER_PROJECT) {
    entries.delete(entries.keys().next().value);
  }
}

function clearCurrentSessionFilesystemEvidence(projectId) {
  currentSessionFilesystemEvidenceByProject.delete(projectId);
}

function hasTrustedCurrentSessionFilesystemEvidence(project, filePath) {
  const projectId = project && project.id;
  const key = currentSessionFilesystemEvidenceKey(projectId, filePath);
  if (!key || !project || project.status !== 'watching') return false;
  const entries = currentSessionFilesystemEvidenceByProject.get(projectId);
  return !!entries && entries.get(key) === watchingActivationTokens.get(projectId);
}

/**
 * Coordinates the expensive background observers for one watching project.
 *
 * The coordinator retains a bounded FIFO of pending operations. Periodic
 * observers still coalesce by kind, while chokidar admissions use normalized
 * file identity so different files cannot overwrite each other.
 */
function createWatcherCoordinator({
  now = () => Date.now(),
  maxBackoffMs = 30000,
  maxDeferredOperationsPerProject = 64,
} = {}) {
  const projects = new Map();
  const queueLimit = Number.isInteger(maxDeferredOperationsPerProject) && maxDeferredOperationsPerProject >= 0
    ? maxDeferredOperationsPerProject
    : 64;

  function stateFor(projectId) {
    let state = projects.get(projectId);
    if (!state) {
      state = {
        generation: 0,
        running: false,
        runningKind: null,
        packageScanDepth: 0,
        cancelled: false,
        backoffUntil: 0,
        consecutiveOverdue: 0,
        pendingOperations: [],
        lastDeferredKind: null,
        counters: {
          started: 0,
          completed: 0,
          skippedOverlap: 0,
          skippedPackageScan: 0,
          skippedBackoff: 0,
          deferred: 0,
          coalesced: 0,
          invalidated: 0,
          queueFull: 0,
          overdue: 0,
        },
        idleWaiters: [],
      };
      projects.set(projectId, state);
    }
    return state;
  }

  function beginPackageScan(projectId) {
    const state = stateFor(projectId);
    state.packageScanDepth += 1;
    state.generation += 1;
    state.backoffUntil = 0;
    state.counters.invalidated += state.pendingOperations.length;
    state.pendingOperations = [];
    return { projectId, generation: state.generation };
  }

  function endPackageScan(projectId) {
    const state = stateFor(projectId);
    state.packageScanDepth = Math.max(0, state.packageScanDepth - 1);
    state.generation += 1;
    state.backoffUntil = 0;
  }

  function activate(projectId) {
    const state = stateFor(projectId);
    state.cancelled = false;
    state.generation += 1;
    state.backoffUntil = 0;
    state.consecutiveOverdue = 0;
    return state.generation;
  }

  function cancel(projectId) {
    const state = stateFor(projectId);
    state.cancelled = true;
    state.generation += 1;
    state.backoffUntil = 0;
    state.packageScanDepth = 0;
    state.counters.invalidated += state.pendingOperations.length;
    state.pendingOperations = [];
  }

  function deferOperation(projectId, kind, operationKey = kind) {
    const state = stateFor(projectId);
    if (state.cancelled || state.packageScanDepth > 0) return { accepted: false, reason: 'paused' };
    const key = typeof operationKey === 'string' && operationKey ? operationKey : kind;
    if (
      (state.running && state.runningKind === kind && state.runningKey === key) ||
      state.pendingOperations.some(operation => operation.kind === kind && operation.key === key)
    ) {
      state.counters.coalesced += 1;
      return { accepted: true, coalesced: true };
    }
    if (state.pendingOperations.length >= queueLimit) {
      state.counters.queueFull += 1;
      state.counters.invalidated += 1;
      return { accepted: false, reason: 'queue-full', invalidated: true };
    }
    state.pendingOperations.push({ kind, key });
    state.counters.deferred += 1;
    return { accepted: true, queued: true };
  }

  function defer(projectId, kind, operationKey = kind) {
    return deferOperation(projectId, kind, operationKey).accepted;
  }

  function takeDeferredOperation(projectId) {
    const state = stateFor(projectId);
    if (
      state.cancelled ||
      state.packageScanDepth > 0 ||
      state.running ||
      state.backoffUntil > now()
    ) return null;
    if (state.pendingOperations.length === 0) return null;
    let index = 0;
    if (state.lastDeferredKind !== null) {
      const fairIndex = state.pendingOperations.findIndex(operation => operation.kind !== state.lastDeferredKind);
      if (fairIndex >= 0) index = fairIndex;
    }
    const [operation] = state.pendingOperations.splice(index, 1);
    state.lastDeferredKind = operation.kind;
    return operation;
  }

  function takeDeferred(projectId) {
    const operation = takeDeferredOperation(projectId);
    return operation ? operation.kind : null;
  }

  function invalidateDeferred(projectId) {
    const state = stateFor(projectId);
    const count = state.pendingOperations.length;
    state.pendingOperations = [];
    state.counters.invalidated += count;
    return count;
  }

  function isCurrent(projectId, generation) {
    const state = stateFor(projectId);
    return !state.cancelled && state.generation === generation && state.packageScanDepth === 0;
  }

  function tryStart(projectId, kind, operationKey = kind) {
    const state = stateFor(projectId);
    const timestamp = now();
    if (state.cancelled || state.packageScanDepth > 0) {
      state.counters.skippedPackageScan += 1;
      return null;
    }
    if (state.running) {
      state.counters.skippedOverlap += 1;
      return null;
    }
    if (state.backoffUntil > timestamp) {
      state.counters.skippedBackoff += 1;
      return null;
    }
    state.running = true;
    state.runningKind = kind;
    state.runningKey = typeof operationKey === 'string' && operationKey ? operationKey : kind;
    state.counters.started += 1;
    return { kind, generation: state.generation, startedAt: timestamp };
  }

  function finish(projectId, ticket, { overdue = false } = {}) {
    const state = stateFor(projectId);
    if (!ticket || !state.running || state.runningKind !== ticket.kind) return;
    state.running = false;
    state.runningKind = null;
    state.runningKey = null;
    state.counters.completed += 1;
    if (overdue) {
      state.counters.overdue += 1;
      state.consecutiveOverdue += 1;
      const backoff = Math.min(maxBackoffMs, Math.max(1000, 1000 * (2 ** Math.min(5, state.consecutiveOverdue - 1))));
      state.backoffUntil = now() + backoff;
    } else {
      state.consecutiveOverdue = 0;
      state.backoffUntil = 0;
    }
    const waiters = state.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  function waitForIdle(projectId) {
    const state = stateFor(projectId);
    if (!state.running) return Promise.resolve();
    return new Promise(resolve => state.idleWaiters.push(resolve));
  }

  function snapshot(projectId) {
    const state = stateFor(projectId);
    return {
      generation: state.generation,
      running: state.running,
      runningKind: state.runningKind,
      runningKey: state.runningKey,
      cancelled: state.cancelled,
      packageScanActive: state.packageScanDepth > 0,
      backoffUntil: state.backoffUntil,
      pendingKinds: state.pendingOperations.map(operation => operation.kind),
      pendingOperations: state.pendingOperations.map(operation => ({ ...operation })),
      counters: { ...state.counters },
    };
  }

  return {
    beginPackageScan,
    endPackageScan,
    activate,
    cancel,
    defer,
    takeDeferred,
    invalidateDeferred,
    isCurrent,
    tryStart,
    finish,
    waitForIdle,
    snapshot,
  };
}

function getWatcherCoordinator(projectId) {
  let coordinator = watcherCoordinators.get(projectId);
  if (!coordinator) {
    coordinator = createWatcherCoordinator({
      maxDeferredOperationsPerProject: MAX_DEFERRED_WATCHER_OPERATIONS_PER_PROJECT,
    });
    watcherCoordinators.set(projectId, coordinator);
  }
  return coordinator;
}

function activateWatcherCoordinator(projectId) {
  clearDeferredWatcherOperations(projectId, 'activation');
  clearCurrentSessionFilesystemEvidence(projectId);
  return getWatcherCoordinator(projectId).activate(projectId);
}

async function pauseWatcherCoordinatorForPackage(projectId) {
  const coordinator = getWatcherCoordinator(projectId);
  clearDeferredWatcherOperations(projectId, 'package-scan');
  coordinator.beginPackageScan(projectId);
  let timeoutId = null;
  const drained = await Promise.race([
    Promise.all([
      coordinator.waitForIdle(projectId),
      waitForLsofIdle(projectId),
    ]).then(() => true),
    new Promise(resolve => {
      timeoutId = setTimeout(() => resolve(false), BACKGROUND_WATCHER_DRAIN_TIMEOUT_MS);
    }),
  ]);
  if (timeoutId) clearTimeout(timeoutId);
  return drained;
}

function resumeWatcherCoordinatorAfterPackage(projectId) {
  getWatcherCoordinator(projectId).endPackageScan(projectId);
}

function cancelWatcherCoordinator(projectId) {
  const coordinator = watcherCoordinators.get(projectId);
  if (coordinator) coordinator.cancel(projectId);
  clearDeferredWatcherOperations(projectId, 'cancel');
  clearCurrentSessionFilesystemEvidence(projectId);
  for (const [key, timerId] of watcherStartupTimers) {
    if (key.startsWith(`${projectId}:`)) {
      clearTimeout(timerId);
      watcherStartupTimers.delete(key);
    }
  }
}

function clearDeferredWatcherOperations(projectId, reason = 'lifecycle') {
  const deferred = watcherDeferredOperations.get(projectId);
  watcherDeferredOperations.delete(projectId);
  const timerId = watcherDeferredTimers.get(projectId);
  if (timerId) clearTimeout(timerId);
  watcherDeferredTimers.delete(projectId);
  const invalidation = { skipped: true, reason: 'coordinator-invalidated', invalidationReason: reason };
  for (const operation of deferred || []) {
    for (const settle of operation.waiters || []) settle(invalidation);
  }
  const coordinator = watcherCoordinators.get(projectId);
  if (coordinator) coordinator.invalidateDeferred(projectId, reason);
}

function deferWatcherOperation(projectId, kind, work, operationKey = kind, settle = null) {
  const coordinator = getWatcherCoordinator(projectId);
  const before = coordinator.snapshot(projectId);
  const accepted = coordinator.defer(projectId, kind, operationKey);
  const after = coordinator.snapshot(projectId);
  const deferredResult = {
    accepted,
    coalesced: accepted && after.counters.coalesced > before.counters.coalesced,
    queued: accepted && after.counters.deferred > before.counters.deferred,
    reason: accepted ? undefined : (
      after.counters.queueFull > before.counters.queueFull ? 'queue-full' : 'paused'
    ),
    invalidated: !accepted && after.counters.queueFull > before.counters.queueFull,
  };
  if (!deferredResult.accepted) return deferredResult;
  let deferred = watcherDeferredOperations.get(projectId);
  if (deferredResult.coalesced) {
    const existing = deferred && deferred.find(item => (
      item.kind === kind && item.operationKey === operationKey
    ));
    if (existing && kind !== 'chokidar-add') existing.work = work;
    if (existing && typeof settle === 'function') existing.waiters.push(settle);
    else if (typeof settle === 'function') settle({ skipped: true, reason: 'coordinator-coalesced' });
    return deferredResult;
  }
  if (!deferred) {
    deferred = [];
    watcherDeferredOperations.set(projectId, deferred);
  }
  deferred.push({ kind, operationKey, work, waiters: typeof settle === 'function' ? [settle] : [] });
  return deferredResult;
}

function scheduleDeferredWatcherOperation(projectId) {
  if (watcherDeferredTimers.has(projectId)) return;
  const coordinator = getWatcherCoordinator(projectId);
  const snapshot = coordinator.snapshot(projectId);
  if (snapshot.cancelled || snapshot.packageScanActive || snapshot.running || snapshot.pendingOperations.length === 0) return;
  const delayMs = Math.max(0, snapshot.backoffUntil - Date.now());
  const timerId = setTimeout(() => {
    watcherDeferredTimers.delete(projectId);
    const pendingBefore = coordinator.snapshot(projectId).pendingOperations;
    const operationKind = coordinator.takeDeferred(projectId);
    if (!operationKind) {
      scheduleDeferredWatcherOperation(projectId);
      return;
    }
    const pendingAfter = coordinator.snapshot(projectId).pendingOperations;
    const operation = pendingBefore.find(candidate => (
      candidate.kind === operationKind &&
      !pendingAfter.some(remaining => remaining.kind === candidate.kind && remaining.key === candidate.key)
    ));
    if (!operation) {
      scheduleDeferredWatcherOperation(projectId);
      return;
    }
    const deferred = watcherDeferredOperations.get(projectId);
    const workIndex = deferred
      ? deferred.findIndex(item => item.kind === operation.kind && item.operationKey === operation.key)
      : -1;
    const operationEntry = workIndex >= 0 ? deferred[workIndex] : null;
    const work = operationEntry && operationEntry.work;
    if (deferred) {
      if (workIndex >= 0) deferred.splice(workIndex, 1);
      if (deferred.length === 0) watcherDeferredOperations.delete(projectId);
    }
    if (typeof work === 'function') {
      Promise.resolve(runBackgroundWatcherOperation(projectId, operation.kind, work, {
        fromDeferred: true,
        operationKey: operation.key,
      })).then(result => {
        for (const settle of operationEntry.waiters || []) settle(result);
      }, () => {
        for (const settle of operationEntry.waiters || []) settle({ skipped: true, reason: 'operation-error' });
      });
    } else if (operationEntry) {
      for (const settle of operationEntry.waiters || []) settle({ skipped: true, reason: 'coordinator-invalidated' });
    } else {
      scheduleDeferredWatcherOperation(projectId);
    }
  }, delayMs);
  if (typeof timerId.unref === 'function') timerId.unref();
  watcherDeferredTimers.set(projectId, timerId);
}

function scheduleWatcherStartupTimer(projectId, kind, delayMs, callback) {
  const key = `${projectId}:${kind}`;
  const previous = watcherStartupTimers.get(key);
  if (previous) clearTimeout(previous);
  const timerId = setTimeout(() => {
    watcherStartupTimers.delete(key);
    callback();
  }, delayMs);
  watcherStartupTimers.set(key, timerId);
}

async function runBackgroundWatcherOperation(projectId, kind, work, {
  fromDeferred = false,
  operationKey = kind,
  awaitDeferred = false,
} = {}) {
  const coordinator = getWatcherCoordinator(projectId);
  const initialSnapshot = coordinator.snapshot(projectId);
  if (!fromDeferred && initialSnapshot.pendingOperations.length > 0) {
    let settle;
    const completion = new Promise(resolve => { settle = resolve; });
    const deferredResult = deferWatcherOperation(projectId, kind, work, operationKey, settle);
    if (deferredResult.accepted && deferredResult.queued) scheduleDeferredWatcherOperation(projectId);
    if (deferredResult.accepted && awaitDeferred) return completion;
    return {
      skipped: true,
      reason: deferredResult.coalesced ? 'coordinator-coalesced' : (
        deferredResult.reason === 'queue-full' ? 'coordinator-queue-full' : 'coordinator-deferred'
      ),
    };
  }
  const ticket = coordinator.tryStart(projectId, kind, operationKey);
  if (!ticket) {
    const snapshot = coordinator.snapshot(projectId);
    if (!snapshot.cancelled && !snapshot.packageScanActive) {
      let settle;
      const completion = new Promise(resolve => { settle = resolve; });
      const deferredResult = deferWatcherOperation(projectId, kind, work, operationKey, settle);
      if (deferredResult.accepted && deferredResult.queued) scheduleDeferredWatcherOperation(projectId);
      if (deferredResult.accepted && awaitDeferred) return completion;
      return {
        skipped: true,
        reason: deferredResult.coalesced ? 'coordinator-coalesced' : (
          deferredResult.reason === 'queue-full' ? 'coordinator-queue-full' : 'coordinator-deferred'
        ),
      };
    }
    return { skipped: true, reason: 'coordinator-paused' };
  }
  let result;
  try {
    result = await work(ticket.generation);
  } catch {
    console.error(`[crate][watcher] ${kind} operation failed: operation-error`);
    result = { skipped: true, reason: 'operation-error' };
  } finally {
    const elapsedMs = Date.now() - ticket.startedAt;
    coordinator.finish(projectId, ticket, { overdue: elapsedMs > BACKGROUND_WATCHER_BUDGET_MS });
    if (elapsedMs > BACKGROUND_WATCHER_BUDGET_MS) {
      console.warn(`[crate][watcher] ${kind} exceeded its background budget; next cycle deferred`);
    }
    scheduleDeferredWatcherOperation(projectId);
  }
  return result;
}

const MAIN_WINDOW_SHOW_FALLBACK_MS = 1500;
const MAIN_WINDOW_STARTUP_RETRY_DELAYS_MS = [500, 1500, 5000, 10000];
const MAIN_WINDOW_HIDDEN_RECREATE_AFTER = 3;
const PACKAGE_FOREGROUND_SUPPRESSION_MS = 10 * 60 * 1000;
const PACKAGE_NOTIFICATION_SHOW_DELAY_MS = 750;
let mainWindowHiddenShowAttempts = 0;
let mainWindowVisibleSinceStartup = false;
let packageForegroundSuppressionUntil = 0;
let mainWindowInitialDiagnosticsScheduled = false;

function suppressPackageAutoForeground() {
  packageForegroundSuppressionUntil = Math.max(
    packageForegroundSuppressionUntil,
    Date.now() + PACKAGE_FOREGROUND_SUPPRESSION_MS
  );
}

function clearPackageAutoForegroundSuppression() {
  packageForegroundSuppressionUntil = 0;
}

function isPackageAutoForegroundSuppressed() {
  return Date.now() < packageForegroundSuppressionUntil;
}

function sendToRenderer(channel, data) { if (trayWindow && !trayWindow.isDestroyed()) trayWindow.webContents.send(channel, data); }

function sendProjectFileStateToRenderer(projectId, activationToken = null) { const current = () => isBoundWatchingActivationCurrent(projectId, activationToken), project = current() && getProjects().find(item => item && item.id === projectId); if (!project || !current()) return; const { files = [], pendingFiles = [] } = getIllustratorScopedProjectView(project); sendToRenderer('files:updated', { projectId, files }); if (current()) sendToRenderer('files:pending', { projectId, pendingFiles }); }

function projectWatchActivityTime(project) {
  for (const value of [project && project.watchStartedAt, project && project.createdAt]) {
    const timestamp = typeof value === 'number' ? value : Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function mostRecentWatchingProject(projects) {
  let selected = null;
  let selectedIndex = -1;
  let selectedTime = -1;
  for (let index = 0; index < projects.length; index++) {
    const project = projects[index];
    if (!project || project.status !== 'watching') continue;
    const activityTime = projectWatchActivityTime(project);
    if (activityTime > selectedTime || (activityTime === selectedTime && index > selectedIndex)) {
      selected = project;
      selectedIndex = index;
      selectedTime = activityTime;
    }
  }
  return selected;
}

function repairPersistedWatchingProjects() {
  const projects = getProjects();
  const watchingProjects = projects.filter(project => project && project.status === 'watching');
  if (watchingProjects.length <= 1) {
    return watchingProjects[0] || null;
  }

  const retainedProject = mostRecentWatchingProject(projects);
  for (const project of watchingProjects) {
    if (project.id !== retainedProject.id) project.status = 'paused';
  }
  clearFileVisualProjectCache();
  store.set('projects', projects);
  console.warn(
    `[startup] repaired ${watchingProjects.length} Watching projects; retained the most recent project`
  );
  return retainedProject;
}

function isActiveWatchingProject(projectId, activationToken = null) {
  if (activationToken !== null && watchingActivationTokens.get(projectId) !== activationToken) {
    return false;
  }
  const watchingProjects = getProjects().filter(project => project && project.status === 'watching');
  return watchingProjects.length === 1 && watchingProjects[0].id === projectId;
}

function getActiveWatchingActivationToken(projectId) {
  const activationToken = watchingActivationTokens.get(projectId);
  if (activationToken === undefined || !isActiveWatchingProject(projectId, activationToken)) {
    return null;
  }
  return activationToken;
}

function isBoundWatchingActivationCurrent(projectId, activationToken) {
  return activationToken === null || isActiveWatchingProject(projectId, activationToken);
}

function captureProjectOperation(projectId) {
  const project = getProjects().find(item => item && item.id === projectId);
  if (!project) return null;
  const status = project.status;
  const generation = watchingActivationSequence;
  const activationToken = status === 'watching' ? watchingActivationTokens.get(projectId) ?? null : null;
  let scopeRevision = illustratorActivationScopes.get(projectId)?.revision;
  let open = true;
  const baseCurrent = () => {
    const latest = getProjects().find(item => item && item.id === projectId);
    const currentToken = latest?.status === 'watching' ? watchingActivationTokens.get(projectId) ?? null : null;
    return !!latest && latest.status === status && open && watchingActivationSequence === generation && currentToken === activationToken;
  };
  const fastCurrent = () => (
    activationToken === null
      ? baseCurrent()
      : (
        open &&
        watchingActivationSequence === generation &&
        watchingActivationTokens.get(projectId) === activationToken &&
        illustratorActivationScopes.get(projectId)?.revision === scopeRevision
      )
  );
  return {
    activationToken,
    close() { open = false; },
    current() { return baseCurrent() && (activationToken === null || illustratorActivationScopes.get(projectId)?.revision === scopeRevision); },
    currentFast() { return fastCurrent(); },
    adoptScope(scope) {
      if (activationToken === null) return baseCurrent();
      if (!baseCurrent() || illustratorActivationScopes.get(projectId) !== scope || ![scopeRevision, scopeRevision + 1].includes(scope?.revision)) return false;
      scopeRevision = scope.revision;
      return true;
    },
  };
}

function activateSingleWatchingProject(projectId, settings, { preserveWatchStartedAt = false } = {}) {
  const projects = getProjects();
  const project = projects.find(item => item.id === projectId);
  if (!project) return null;

  const pausedProjectIds = [];
  for (const otherProject of projects) {
    if (otherProject.id === projectId || otherProject.status !== 'watching') continue;
    otherProject.status = 'paused';
    pausedProjectIds.push(otherProject.id);
  }

  project.status = 'watching';
  if (!preserveWatchStartedAt || !project.watchStartedAt) {
    project.watchStartedAt = Date.now();
  }
  startWatchSession(project);
  project.figmaSession = buildFigmaSessionSnapshot(project, settings);
  normalizeAutoCaptureProjectState(project);
  safelyEnsureProjectProvenance(project);
  clearFileVisualProjectCache();
  store.set('projects', projects);

  for (const pausedProjectId of pausedProjectIds) {
    stopWatching(pausedProjectId);
  }

  const activationToken = ++watchingActivationSequence;
  watchingActivationTokens.clear();
  watchingActivationTokens.set(projectId, activationToken);
  // Invalidate any prior observer set before the replacement performs its
  // initial snapshot. Existing interval handles are stopped below by
  // startWatching, while this gate makes their ticks harmless in the gap.
  cancelWatcherCoordinator(projectId);
  illustratorActivationScopes.set(projectId, { activationToken, revision: 0, status: 'initializing', baselineDocumentPaths: new Set(), admittedDocumentPaths: new Set(), allowedLinkedPaths: new Set(), excludedLinkedPaths: new Set() });

  return {
    activationToken,
    pausedProjectIds,
    projectSnapshot: {
      id: project.id,
      type: project.type,
      files: project.files,
      createdAt: project.createdAt,
      watchStartedAt: project.watchStartedAt,
      figmaTrackedFiles: project.figmaTrackedFiles,
      figmaSession: project.figmaSession,
    },
  };
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
const lsofIdleWaiters = new Map(); // projectId -> package-drain waiters

function waitForLsofIdle(projectId) {
  if (!lsofInProgress.has(projectId)) return Promise.resolve();
  return new Promise(resolve => {
    let waiters = lsofIdleWaiters.get(projectId);
    if (!waiters) {
      waiters = [];
      lsofIdleWaiters.set(projectId, waiters);
    }
    waiters.push(resolve);
  });
}

function finishLsofPoll(projectId, onComplete) {
  lsofInProgress.delete(projectId);
  const waiters = lsofIdleWaiters.get(projectId) || [];
  lsofIdleWaiters.delete(projectId);
  for (const resolve of waiters) resolve();
  onComplete();
}
// v2.4.2: per-project, keyed by projectId. Bounded by the lsof poll interval.
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
const PRE_PACKAGE_DISCOVERY_TIMEOUT_MS = 8000;
const PRE_PACKAGE_APP_SCAN_TIMEOUT_MS = 30000;
// Keep a narrow overlap between incremental polls so a just-added image ref can't
// fall behind a hard since-cutoff while Figma's file metadata/tree finishes updating.
const FIGMA_INCREMENTAL_OVERLAP_MS = FIGMA_POLL_INTERVAL_MS * 2; // 2 minutes
const FIGMA_ASSETS_DIR = path.join(os.homedir(), '.crate', 'figma-assets');
const FIGMA_ASSET_DIR_MODE = OWNER_ONLY_DIR_MODE;
const FIGMA_ASSET_FILE_MODE = OWNER_ONLY_FILE_MODE;
const PRESENTATION_ASSETS_DIR = path.join(os.homedir(), '.crate', 'presentation-assets');
const PRESENTATION_ASSET_DIR_MODE = OWNER_ONLY_DIR_MODE;
const PRESENTATION_ASSET_FILE_MODE = OWNER_ONLY_FILE_MODE;
const LOCAL_PROJECT_CACHE_CATEGORIES = Object.freeze(['figma-assets', 'presentation-assets']);
const SAFE_FIGMA_ASSET_FORMATS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'tif', 'tiff', 'heic',
  'svg', 'pdf', 'bmp', 'avif',
]);

// --- Live app evidence refresh (Illustrator, Photoshop, InDesign) ---
const psPollers = new Map();          // projectId -> setInterval id
const psPollerStarting = new Set();   // guard: projectIds with initial poll in progress
const psInProgress = new Set();       // projectIds currently mid-poll
const liveAppDiagnosticLogTimestamps = new Map();
const LIVE_APP_REFRESH_INTERVAL_MS = 10000; // 10 seconds; avoid sustained main-process polling pressure
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

// Get PIDs of all running supported design apps so one project can span apps.
// Uses `ps ax -o pid= -o command=` which gives full app paths (not truncated like lsof COMMAND).
function getRunningDesignAppPids(callback) {
  exec('/bin/ps ax -o pid= -o command= 2>/dev/null', { timeout: 5000 }, (err, stdout) => {
    if (err && !stdout) { callback([], new Map()); return; }
    const pids = [];
    const pidToCmd = new Map(); // v2.5.3: PID → command string for lsof image filtering
    for (const line of stdout.trim().split('\n')) {
      const m = line.trim().match(/^\s*(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = parseInt(m[1]);
      const cmd = m[2];
      if (DESIGN_APP_PROCESS_KEYWORDS.some(kw => cmd.includes(kw))) {
        pids.push(pid);
        pidToCmd.set(pid, cmd);
      }
    }
    callback(pids, pidToCmd);
  });
}

// Poll lsof for a single watching project. Runs every LSOF_POLL_MS.
// Finds files that design apps have open (reads + writes) in watched dirs → Tier 1 auto-capture.
function pollLsofForProjectCore(projectId, activationToken = null, onComplete = () => {}, watcherGeneration = null) {
  if (lsofInProgress.has(projectId)) { onComplete(); return; } // skip if already running for this project

  const project = getProjects().find(p => p.id === projectId);
  if (!project || !isActiveWatchingProject(projectId, activationToken)) { onComplete(); return; }

  lsofInProgress.add(projectId);

  getRunningDesignAppPids((pids, pidToCmd) => {
    if (!getFreshActiveWatchingProject(projectId, activationToken)) {
      finishLsofPoll(projectId, onComplete);
      return;
    }
    if (watcherGeneration !== null && !getWatcherCoordinator(projectId).isCurrent(projectId, watcherGeneration)) {
      finishLsofPoll(projectId, onComplete);
      return;
    }
    designAppRunningCache.set(projectId, pids.length > 0); // v2.4.2: per-project
    if (pids.length === 0) {
      finishLsofPoll(projectId, onComplete);
      return;
    }

    const home = os.homedir();

    // Filter to valid numeric PIDs only, then join
    const validPids = pids.filter(p => Number.isInteger(p) && p > 0);
    if (validPids.length === 0) { finishLsofPoll(projectId, onComplete); return; }
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

    exec(cmd, { timeout: 12000 }, async (err, stdout) => {
      const parserScans = [];
      try {
      const latestProject = getFreshActiveWatchingProject(projectId, activationToken);
      if (
        !stdout ||
        !latestProject ||
        (watcherGeneration !== null && !getWatcherCoordinator(projectId).isCurrent(projectId, watcherGeneration))
      ) return;

      const parsedLines = stdout.trim().split('\n');
      let illustratorScopeProjectFilePaths = null;

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
        if (!SCAN_ON_OPEN_EXTENSIONS.has(ext)) continue;
        const processIdentity = currentPid ? getDesignAppProcessIdentity(pidToCmd.get(currentPid) || '') : null;
        if (processIdentity && processIdentity.appFamily === 'illustrator' && !illustratorScopeProjectFilePaths) {
          illustratorScopeProjectFilePaths = createIllustratorProjectFilePathSnapshot(latestProject.files || []);
        }
        if (!isIllustratorScopedFileAllowed(latestProject, buildAutoCaptureFileEntry(filePath, 'lsof', { ext }),
          { appFamily: processIdentity && processIdentity.appFamily, projectFilePaths: illustratorScopeProjectFilePaths })) continue;
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
          if (prevPidSet.size > 0 && isActiveWatchingProject(projectId, activationToken)) {
            parserScans.push(runScanOnOpen(projectId, filePath, activationToken).catch(() => null));
          }
          prevPids.set(filePath, new Set()); // closed
        }
      }
      for (const [filePath, pids] of currentPollFiles) {
        prevPids.set(filePath, pids);
      }

      // Keep child parser work inside this coordinated lsof operation. Package
      // preparation must not claim a drained watcher while these mutations are
      // still in flight.
      for (const filePath of filesToScan) {
        if (!isActiveWatchingProject(projectId, activationToken)) break;
        parserScans.push(runScanOnOpen(projectId, filePath, activationToken).catch(() => null));
      }

      if (watcherGeneration !== null && !getWatcherCoordinator(projectId).isCurrent(projectId, watcherGeneration)) {
        return;
      }

      // Second pass: standard lsof file capture (same as before, minus mtime filter)
      currentPid = null;
      currentType = null;

      const result = mutateProject(projectId, (proj, projectsAtMutation) => {
        if (!isActiveWatchingProject(projectId, activationToken)) return { changed: false };

        const phaseProjectFiles = proj.files || [];
        const phaseProjectFilePaths = createIllustratorProjectFilePathSnapshot(phaseProjectFiles);
        const existingPaths = new Set(phaseProjectFilePaths.paths.filter(Boolean));
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

          const processCommand = currentPid ? pidToCmd.get(currentPid) || '' : '';
          if (!isAllowedLsofPathForApp(filePath, processCommand, home)) continue;

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
            ? getDesignAppProcessIdentity(processCommand)
            : null;
          const isPrimarySource = PRIMARY_DESIGN_EXTENSIONS.has(ext);
          const fileEntry = buildAutoCaptureFileEntry(filePath, 'lsof', { ext });
          const staged = stageLiveObservedFile(proj, fileEntry, {
            forcePending: true,
            reason: isPrimarySource ? 'opened-after-watch' : 'app-file-observed',
            captureReason: isPrimarySource ? 'opened-after-watch' : 'app-file-observed',
            captureState: isPrimarySource ? LIVE_CAPTURE_STATES.OBSERVED : LIVE_CAPTURE_STATES.PENDING,
            appFamily: processIdentity ? processIdentity.appFamily : 'generic',
            projectFilePaths: phaseProjectFilePaths,
            // Resolve generated outputs from the same fresh collection being
            // mutated. An output selected while lsof was running must be
            // excluded from this poll.
            projectCollection: projectsAtMutation,
          });
          if (staged.evidenceChanged) changed = true;
          if (!staged.changed) continue;
          if (staged.decision === LIVE_CAPTURE_DECISIONS.DIRECT_ADD) {
            recordLsofAcceptedFileProvenance(proj, fileEntry, {
              method: 'poll',
              pid: currentPid,
              command: processCommand,
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
      }, { persistIfChanged: true, trustResultChanged: true });

      if (result && result.changed) sendProjectFileStateToRenderer(projectId, activationToken);
      } catch {
        console.error('[crate][watcher] lsof poll failed: operation-error');
      } finally {
        if (parserScans.length > 0) await Promise.allSettled(parserScans);
        finishLsofPoll(projectId, onComplete);
      }
    });
  });
}

function pollLsofForProject(projectId, activationToken = null) {
  const coordinator = getWatcherCoordinator(projectId);
  const snapshot = coordinator.snapshot(projectId);
  if (snapshot.cancelled || snapshot.packageScanActive) {
    return Promise.resolve({ skipped: true, reason: 'coordinator-paused' });
  }
  // Lsof is the capture-critical sampling lane. It keeps the established
  // three-second opportunity even when a slower background observer is busy,
  // while its own in-progress guard prevents overlap or interval backlog.
  return new Promise(resolve => {
    pollLsofForProjectCore(projectId, activationToken, resolve, snapshot.generation);
  });
}

const LSOF_POLL_MS = 3000; // Preserve short-lived file detection; lsof's own guard prevents overlap and backlog.

function startLsofPolling(projectId, activationToken = null) {
  stopLsofPolling(projectId); // clear any existing interval first
  // Run once immediately, then on the regular interval
  scheduleWatcherStartupTimer(projectId, 'lsof', 500, () => pollLsofForProject(projectId, activationToken));
  const intervalId = setInterval(() => pollLsofForProject(projectId, activationToken), LSOF_POLL_MS);
  lsofPollers.set(projectId, intervalId);
}

function stopLsofPolling(projectId) {
  const intervalId = lsofPollers.get(projectId);
  if (intervalId !== undefined) {
    clearInterval(intervalId);
    lsofPollers.delete(projectId);
  }
}

// --- Figma Auto-Tracking Functions ---

/**
 * Ensure Figma assets directory exists.
 */
function hardenOwnerOnlyPermissions(targetPath, mode) {
  if (process.platform === 'win32') return true;
  try {
    fs.chmodSync(targetPath, mode);
    return (fs.statSync(targetPath).mode & 0o777) === mode;
  } catch (_) {
    return false;
  }
}

function hardenOwnerOnlyDirectory(dirPath, mode = OWNER_ONLY_DIR_MODE) {
  if (process.platform === 'win32') return true;
  let fd = null;
  try {
    const flags = fs.constants.O_RDONLY
      | (fs.constants.O_DIRECTORY || 0)
      | (fs.constants.O_NOFOLLOW || 0);
    fd = fs.openSync(dirPath, flags);
    if (!fs.fstatSync(fd).isDirectory()) return false;
    fs.fchmodSync(fd, mode);
    return (fs.fstatSync(fd).mode & 0o777) === mode;
  } catch (_) {
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function preflightLocalStorePaths(userDataPath) {
  try {
    if (typeof userDataPath !== 'string' || !userDataPath || !path.isAbsolute(userDataPath)) {
      throw new Error('invalid user data path');
    }

    let userDataStat;
    try {
      userDataStat = fs.lstatSync(userDataPath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
      fs.mkdirSync(userDataPath, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
      userDataStat = fs.lstatSync(userDataPath);
    }
    if (userDataStat.isSymbolicLink() || !userDataStat.isDirectory()) {
      throw new Error('unsafe user data path');
    }

    const userDataRealPath = fs.realpathSync.native(userDataPath);
    if (!hardenOwnerOnlyDirectory(userDataRealPath)) {
      throw new Error('user data hardening failed');
    }

    const configPath = path.join(userDataRealPath, 'config.json');
    try {
      const configStat = fs.lstatSync(configPath);
      if (configStat.isSymbolicLink() || !configStat.isFile()) {
        throw new Error('unsafe config path');
      }
      const configRealPath = fs.realpathSync.native(configPath);
      if (path.dirname(configRealPath) !== userDataRealPath || !hardenOwnerOnlyFile(configRealPath)) {
        throw new Error('config hardening failed');
      }
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }

    return { userDataRealPath, configPath };
  } catch (_) {
    throw new Error('Crate could not secure local settings storage.');
  }
}

function hardenLocalStorePermissions(storePath, userDataPath) {
  if (process.platform === 'win32') return true;
  if (typeof storePath !== 'string' || !storePath || typeof userDataPath !== 'string' || !userDataPath) {
    return false;
  }

  try {
    const userDataStat = fs.lstatSync(userDataPath);
    const storeStat = fs.lstatSync(storePath);
    if (userDataStat.isSymbolicLink() || !userDataStat.isDirectory()) return false;
    if (storeStat.isSymbolicLink() || !storeStat.isFile()) return false;

    const userDataRealPath = fs.realpathSync.native(userDataPath);
    const storeRealPath = fs.realpathSync.native(storePath);
    if (path.dirname(storeRealPath) !== userDataRealPath) return false;

    return hardenOwnerOnlyDirectory(userDataRealPath) && hardenOwnerOnlyFile(storeRealPath);
  } catch (_) {
    return false;
  }
}

function ensureOwnerOnlyDirectory(dirPath, mode = OWNER_ONLY_DIR_MODE) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode });
  }
  if (!hardenOwnerOnlyDirectory(dirPath, mode)) {
    throw new Error('Crate could not secure local storage.');
  }
  return dirPath;
}

function hardenOwnerOnlyFile(filePath, mode = OWNER_ONLY_FILE_MODE) {
  if (process.platform === 'win32') return true;
  let fd = null;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    fd = fs.openSync(filePath, flags);
    const initialStat = fs.fstatSync(fd);
    if (!initialStat.isFile() || initialStat.nlink !== 1) return false;
    fs.fchmodSync(fd, mode);
    const finalStat = fs.fstatSync(fd);
    return finalStat.isFile()
      && finalStat.nlink === 1
      && finalStat.dev === initialStat.dev
      && finalStat.ino === initialStat.ino
      && (finalStat.mode & 0o777) === mode;
  } catch (_) {
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function writeOwnerOnlyFileSync(filePath, data, options = {}, mode = OWNER_ONLY_FILE_MODE) {
  fs.writeFileSync(filePath, data, { ...options, mode });
  if (!hardenOwnerOnlyFile(filePath, mode)) {
    throw new Error('Crate could not secure local storage.');
  }
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

  if (!hardenOwnerOnlyDirectory(dirPath, mode)) {
    throw cacheSafetyError(label, 'permissions');
  }
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
  if (projectId == null) {
    return { crateDir, categoryDir, projectDir: null, crateRealPath, categoryRealPath, projectRealPath: null };
  }

  const safeProjectId = ensureSafeCacheSegment(projectId, 'cache-project');
  const projectDir = path.join(categoryDir, safeProjectId);
  const projectRealPath = ensureSafeCacheDirectory(projectDir, `${safeCategory}-project`, mode, categoryRealPath);
  return { crateDir, categoryDir, projectDir, crateRealPath, categoryRealPath, projectRealPath };
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

function safeStoredProjectCacheIds() {
  let projects;
  try {
    projects = store && store.get('projects', null);
  } catch (_) {
    return null;
  }
  if (!Array.isArray(projects)) return null;

  const ids = new Set();
  for (const project of projects) {
    if (!project || typeof project.id !== 'string') return null;
    try {
      ids.add(ensureSafeCacheSegment(project.id, 'cache-project'));
    } catch (_) {
      return null;
    }
  }
  return ids;
}

function normalizeProjectCacheIds(projectIds) {
  const ids = new Set();
  try {
    for (const projectId of projectIds || []) {
      ids.add(ensureSafeCacheSegment(projectId, 'cache-project'));
    }
  } catch (_) {
    return null;
  }
  return ids;
}

function existingSafeCacheCategory(category) {
  let safeCategory;
  try {
    safeCategory = ensureSafeCacheSegment(category, 'cache-category');
  } catch (_) {
    return { exists: true, categoryRealPath: null };
  }

  const crateDir = path.join(os.homedir(), '.crate');
  const categoryDir = path.join(crateDir, safeCategory);
  try {
    const crateStat = fs.lstatSync(crateDir);
    if (crateStat.isSymbolicLink() || !crateStat.isDirectory()) {
      return { exists: true, categoryRealPath: null };
    }

    let categoryStat;
    try {
      categoryStat = fs.lstatSync(categoryDir);
    } catch (error) {
      if (error && error.code === 'ENOENT') return { exists: false, categoryRealPath: null };
      return { exists: true, categoryRealPath: null };
    }
    if (categoryStat.isSymbolicLink() || !categoryStat.isDirectory()) {
      return { exists: true, categoryRealPath: null };
    }

    const crateRealPath = fs.realpathSync.native(crateDir);
    const categoryRealPath = fs.realpathSync.native(categoryDir);
    if (!isPathInsideDirectory(crateRealPath, categoryRealPath)) {
      return { exists: true, categoryRealPath: null };
    }
    if (!hardenOwnerOnlyDirectory(crateRealPath) || !hardenOwnerOnlyDirectory(categoryRealPath)) {
      return { exists: true, categoryRealPath: null };
    }
    return { exists: true, categoryRealPath };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false, categoryRealPath: null };
    return { exists: true, categoryRealPath: null };
  }
}

function isCrateProjectCacheName(entryName) {
  return typeof entryName === 'string' && CRATE_PROJECT_CACHE_ID_PATTERN.test(entryName);
}

function isCrateCacheQuarantineName(entryName) {
  return typeof entryName === 'string' && CRATE_CACHE_QUARANTINE_PATTERN.test(entryName);
}

function waitForCacheCleanupRetry(attempt) {
  const delay = CACHE_CLEANUP_RETRY_DELAYS_MS[Math.min(attempt, CACHE_CLEANUP_RETRY_DELAYS_MS.length - 1)];
  return new Promise(resolve => setTimeout(resolve, delay));
}

function yieldCacheCleanupTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

async function removeQuarantinedProjectCache(categoryRealPath, cleanupName) {
  if (!isCrateCacheQuarantineName(cleanupName)) return false;
  const cleanupPath = path.join(categoryRealPath, cleanupName);

  for (let attempt = 0; attempt <= CACHE_CLEANUP_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const cleanupStat = await fs.promises.lstat(cleanupPath);
      if (cleanupStat.isSymbolicLink() || !cleanupStat.isDirectory()) return false;
      const cleanupRealPath = await fs.promises.realpath(cleanupPath);
      if (!isPathInsideDirectory(categoryRealPath, cleanupRealPath)) return false;
      await fs.promises.rm(cleanupPath, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (error && error.code === 'ENOENT') return true;
      if (attempt >= CACHE_CLEANUP_RETRY_DELAYS_MS.length) break;
      await waitForCacheCleanupRetry(attempt);
    }
  }

  return false;
}

async function hardenActiveProjectCache(categoryRealPath, projectId) {
  let safeProjectId;
  try {
    safeProjectId = ensureSafeCacheSegment(projectId, 'cache-project');
  } catch (_) {
    return false;
  }

  const projectDir = path.join(categoryRealPath, safeProjectId);
  let projectRealPath;
  try {
    const projectStat = await fs.promises.lstat(projectDir);
    if (projectStat.isSymbolicLink() || !projectStat.isDirectory()) return false;
    projectRealPath = await fs.promises.realpath(projectDir);
    if (!isPathInsideDirectory(categoryRealPath, projectRealPath)) return false;
    if (!hardenOwnerOnlyDirectory(projectRealPath)) return false;
  } catch (error) {
    if (error && error.code === 'ENOENT') return true;
    return false;
  }

  let entries;
  try {
    entries = await fs.promises.opendir(projectRealPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return true;
    return false;
  }

  let allSucceeded = true;
  let processed = 0;
  try {
    for await (const entry of entries) {
      const entryPath = path.join(projectRealPath, entry.name);
      try {
        const entryStat = await fs.promises.lstat(entryPath);
        if (entryStat.isSymbolicLink() || (entryStat.isFile() && entryStat.nlink !== 1)) {
          try {
            await fs.promises.unlink(entryPath);
          } catch (error) {
            if (!error || error.code !== 'ENOENT') allSucceeded = false;
          }
        } else if (!entryStat.isFile()) {
          allSucceeded = false;
        } else {
          const entryRealPath = await fs.promises.realpath(entryPath);
          if (!isPathInsideDirectory(projectRealPath, entryRealPath) || !hardenOwnerOnlyFile(entryRealPath)) {
            allSucceeded = false;
          }
        }
      } catch (error) {
        if (!error || error.code !== 'ENOENT') allSucceeded = false;
      }

      processed += 1;
      if (processed % CACHE_CLEANUP_BATCH_SIZE === 0) {
        await yieldCacheCleanupTurn();
      }
    }
  } catch (_) {
    allSucceeded = false;
  }
  return allSucceeded;
}

async function quarantineAndRemoveProjectCache(categoryRealPath, projectId) {
  let safeProjectId;
  try {
    safeProjectId = ensureSafeCacheSegment(projectId, 'cache-project');
  } catch (_) {
    return false;
  }

  const projectDir = path.join(categoryRealPath, safeProjectId);
  for (let attempt = 0; attempt <= CACHE_CLEANUP_RETRY_DELAYS_MS.length; attempt++) {
    const currentActiveIds = safeStoredProjectCacheIds();
    if (currentActiveIds === null) return false;
    if (currentActiveIds.has(safeProjectId)) return true;

    try {
      const projectStat = await fs.promises.lstat(projectDir);
      if (projectStat.isSymbolicLink() || !projectStat.isDirectory()) return false;
      const projectRealPath = await fs.promises.realpath(projectDir);
      if (!isPathInsideDirectory(categoryRealPath, projectRealPath)) return false;

      const latestActiveIds = safeStoredProjectCacheIds();
      if (latestActiveIds === null) return false;
      if (latestActiveIds.has(safeProjectId)) {
        return hardenActiveProjectCache(categoryRealPath, safeProjectId);
      }

      const cleanupName = `.crate-cleanup-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
      const cleanupPath = path.join(categoryRealPath, cleanupName);
      await fs.promises.rename(projectDir, cleanupPath);

      const postQuarantineActiveIds = safeStoredProjectCacheIds();
      if (postQuarantineActiveIds === null) return false;
      if (postQuarantineActiveIds.has(safeProjectId)) {
        try {
          const currentProjectStat = await fs.promises.lstat(projectDir);
          if (currentProjectStat.isSymbolicLink() || !currentProjectStat.isDirectory()) return false;
          const currentSafe = await hardenActiveProjectCache(categoryRealPath, safeProjectId);
          const staleRemoved = await removeQuarantinedProjectCache(categoryRealPath, cleanupName);
          return currentSafe && staleRemoved;
        } catch (error) {
          if (!error || error.code !== 'ENOENT') return false;
        }

        try {
          await fs.promises.rename(cleanupPath, projectDir);
        } catch (_) {
          return false;
        }
        return hardenActiveProjectCache(categoryRealPath, safeProjectId);
      }
      return removeQuarantinedProjectCache(categoryRealPath, cleanupName);
    } catch (error) {
      if (error && error.code === 'ENOENT') return true;
      if (attempt >= CACHE_CLEANUP_RETRY_DELAYS_MS.length) break;
      await waitForCacheCleanupRetry(attempt);
    }
  }

  return false;
}

async function processProjectCacheCandidate(categoryRealPath, candidate) {
  const currentActiveIds = safeStoredProjectCacheIds();
  if (currentActiveIds === null) return false;
  if (currentActiveIds.has(candidate.name)) {
    return hardenActiveProjectCache(categoryRealPath, candidate.name);
  }
  if (candidate.quarantined) {
    return removeQuarantinedProjectCache(categoryRealPath, candidate.name);
  }
  return quarantineAndRemoveProjectCache(categoryRealPath, candidate.name);
}

async function processProjectCacheBatch(categoryRealPath, batch) {
  let allSucceeded = true;
  for (const candidate of batch) {
    if (!await processProjectCacheCandidate(categoryRealPath, candidate)) {
      allSucceeded = false;
    }
  }
  return allSucceeded;
}

async function runProjectCacheCleanup(requestedIds, removeOrphans) {
  const activeIds = safeStoredProjectCacheIds();
  if (activeIds === null) return false;

  let allSucceeded = true;

  for (const category of LOCAL_PROJECT_CACHE_CATEGORIES) {
    const cache = existingSafeCacheCategory(category);
    if (!cache.exists) continue;
    if (!cache.categoryRealPath) {
      allSucceeded = false;
      continue;
    }

    const requested = [...requestedIds].map(name => ({ name, quarantined: false }));
    for (let offset = 0; offset < requested.length; offset += CACHE_CLEANUP_BATCH_SIZE) {
      const batch = requested.slice(offset, offset + CACHE_CLEANUP_BATCH_SIZE);
      if (!await processProjectCacheBatch(cache.categoryRealPath, batch)) {
        allSucceeded = false;
      }
      if (offset + CACHE_CLEANUP_BATCH_SIZE < requested.length) {
        await yieldCacheCleanupTurn();
      }
    }

    if (!removeOrphans) continue;

    let directory;
    try {
      directory = await fs.promises.opendir(cache.categoryRealPath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') allSucceeded = false;
      continue;
    }

    let batch = [];
    try {
      for await (const entry of directory) {
        let candidate = null;
        if (activeIds.has(entry.name)) {
          candidate = { name: entry.name, quarantined: false };
        } else if (isCrateCacheQuarantineName(entry.name)) {
          candidate = { name: entry.name, quarantined: true };
        } else if (isCrateProjectCacheName(entry.name)) {
          candidate = { name: entry.name, quarantined: false };
        }
        if (!candidate) continue;

        batch.push(candidate);
        if (batch.length < CACHE_CLEANUP_BATCH_SIZE) continue;
        if (!await processProjectCacheBatch(cache.categoryRealPath, batch)) {
          allSucceeded = false;
        }
        batch = [];
        await yieldCacheCleanupTurn();
      }
      if (batch.length > 0 && !await processProjectCacheBatch(cache.categoryRealPath, batch)) {
        allSucceeded = false;
      }
    } catch (_) {
      allSucceeded = false;
    }
  }
  return allSucceeded;
}

let projectCacheCleanupQueue = Promise.resolve();

function scheduleProjectCacheCleanup({ projectIds = [], removeOrphans = false } = {}) {
  const requestedIds = normalizeProjectCacheIds(projectIds);
  if (!requestedIds) {
    console.warn('[crate][cache] deferred cache cleanup could not complete');
    return Promise.resolve(false);
  }

  const cleanupTask = projectCacheCleanupQueue
    .catch(() => {})
    .then(() => runProjectCacheCleanup(requestedIds, removeOrphans))
    .then((succeeded) => {
      if (!succeeded) {
        console.warn('[crate][cache] deferred cache cleanup could not complete');
      }
      return succeeded;
    }, () => {
      console.warn('[crate][cache] deferred cache cleanup could not complete');
      return false;
    });
  projectCacheCleanupQueue = cleanupTask.then(() => undefined, () => undefined);
  return cleanupTask;
}

function scheduleDeletedProjectCacheCleanup(projectId) {
  const projectIds = normalizeProjectCacheIds([projectId]);
  if (!projectIds) return Promise.resolve(false);
  const activeIds = safeStoredProjectCacheIds();
  if (activeIds === null) return Promise.resolve(false);
  if (activeIds.has(projectId)) return Promise.resolve(true);
  return scheduleProjectCacheCleanup({ projectIds });
}

function safeCacheTempPath(filePath) {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  return path.join(dir, `.${base}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp${ext}`);
}

function isDirectCacheChild(cacheDir, filePath) {
  if (typeof cacheDir !== 'string' || typeof filePath !== 'string') return false;
  const resolvedCacheDir = path.resolve(cacheDir);
  const resolvedFilePath = path.resolve(filePath);
  return resolvedFilePath !== resolvedCacheDir && path.dirname(resolvedFilePath) === resolvedCacheDir;
}

function captureOwnedDirectCacheFile(filePath, cacheDir, label = 'cache-file') {
  if (!isDirectCacheChild(cacheDir, filePath)) throw cacheSafetyError(label, 'outside_root');
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw cacheSafetyError(label, 'unsafe');
  }
  return { filePath, cacheDir, dev: stat.dev, ino: stat.ino };
}

function removeOwnedDirectCacheFiles(records) {
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || record.cleanupComplete === true) continue;
    try {
      if (!isDirectCacheChild(record.cacheDir, record.filePath)) {
        record.cleanupComplete = true;
        continue;
      }
      const stat = fs.lstatSync(record.filePath);
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.dev !== record.dev ||
        stat.ino !== record.ino
      ) {
        record.cleanupComplete = true;
        continue;
      }
      fs.unlinkSync(record.filePath);
      record.cleanupComplete = true;
    } catch (error) {
      if (error && error.code === 'ENOENT') record.cleanupComplete = true;
    }
  }
}

function captureCacheDirectoryIdentity(cacheDir, label = 'cache-directory') {
  if (typeof cacheDir !== 'string' || !cacheDir) throw cacheSafetyError(label, 'invalid');
  const cachePath = path.resolve(cacheDir);
  let fd = null;
  try {
    const initialPathStat = fs.lstatSync(cachePath);
    if (initialPathStat.isSymbolicLink() || !initialPathStat.isDirectory()) {
      throw cacheSafetyError(label, 'unsafe');
    }
    const realPath = safeRealpath(cachePath, label);
    const flags = fs.constants.O_RDONLY
      | (fs.constants.O_DIRECTORY || 0)
      | (fs.constants.O_NOFOLLOW || 0);
    fd = fs.openSync(cachePath, flags);
    const openedStat = fs.fstatSync(fd);
    const finalPathStat = fs.lstatSync(cachePath);
    const finalRealPath = safeRealpath(cachePath, label);
    if (!openedStat.isDirectory()
      || finalPathStat.isSymbolicLink()
      || !finalPathStat.isDirectory()
      || initialPathStat.dev !== openedStat.dev
      || initialPathStat.ino !== openedStat.ino
      || finalPathStat.dev !== openedStat.dev
      || finalPathStat.ino !== openedStat.ino
      || finalRealPath !== realPath) {
      throw cacheSafetyError(label, 'changed');
    }
    return {
      path: cachePath,
      realPath,
      dev: openedStat.dev,
      ino: openedStat.ino,
    };
  } catch (error) {
    if (error && error.message && error.message.startsWith('Unsafe cache path:')) throw error;
    throw cacheSafetyError(label, 'unavailable');
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function assertCacheDirectoryIdentity(identity, label = 'cache-directory') {
  const current = captureCacheDirectoryIdentity(identity && identity.path, label);
  if (!identity
    || current.realPath !== identity.realPath
    || current.dev !== identity.dev
    || current.ino !== identity.ino) {
    throw cacheSafetyError(label, 'changed');
  }
}

function assertCacheFileDescriptorIdentity(fd, filePath, directoryIdentity, label) {
  const openedStat = fs.fstatSync(fd);
  if (!openedStat.isFile() || openedStat.nlink !== 1) {
    throw cacheSafetyError(label, 'not_file');
  }

  assertCacheDirectoryIdentity(directoryIdentity, `${label}-directory`);
  const pathStat = fs.lstatSync(filePath);
  const realFilePath = safeRealpath(filePath, label);
  if (pathStat.isSymbolicLink()
    || !pathStat.isFile()
    || pathStat.nlink !== 1
    || pathStat.dev !== openedStat.dev
    || pathStat.ino !== openedStat.ino
    || path.dirname(realFilePath) !== directoryIdentity.realPath) {
    throw cacheSafetyError(label, 'changed');
  }
  assertCacheDirectoryIdentity(directoryIdentity, `${label}-directory`);
  return openedStat;
}

function openVerifiedCacheFileSync(filePath, cacheDir, label, flags = fs.constants.O_RDONLY) {
  if (!isDirectCacheChild(cacheDir, filePath)) throw cacheSafetyError(label, 'outside_root');
  const directoryIdentity = captureCacheDirectoryIdentity(cacheDir, `${label}-directory`);
  let fd = null;
  try {
    fd = fs.openSync(filePath, flags | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw cacheSafetyError(label, 'unavailable');
  }

  try {
    const stat = assertCacheFileDescriptorIdentity(fd, filePath, directoryIdentity, label);
    return { fd, stat, directoryIdentity };
  } catch (error) {
    try { fs.closeSync(fd); } catch (_) {}
    throw error;
  }
}

function getVerifiedCacheFileStatSync(filePath, cacheDir, label) {
  const handle = openVerifiedCacheFileSync(filePath, cacheDir, label);
  if (!handle) return null;
  try {
    return handle.stat;
  } finally {
    try { fs.closeSync(handle.fd); } catch (_) {}
  }
}

function hardenOwnerOnlyCacheFileSync(filePath, cacheDir, label, mode = OWNER_ONLY_FILE_MODE) {
  const handle = openVerifiedCacheFileSync(filePath, cacheDir, label);
  if (!handle) return false;
  try {
    fs.fchmodSync(handle.fd, mode);
    const finalStat = assertCacheFileDescriptorIdentity(
      handle.fd,
      filePath,
      handle.directoryIdentity,
      label
    );
    return (finalStat.mode & 0o777) === mode;
  } catch (error) {
    if (error && error.message && error.message.startsWith('Unsafe cache path:')) throw error;
    throw cacheSafetyError(label, 'permissions');
  } finally {
    try { fs.closeSync(handle.fd); } catch (_) {}
  }
}

function writeOwnerOnlyCacheFileSync(filePath, data, cacheDir, mode = OWNER_ONLY_FILE_MODE, options = {}) {
  if (!isDirectCacheChild(cacheDir, filePath)) throw cacheSafetyError('cache-file', 'outside_root');
  const existing = getVerifiedCacheFileStatSync(filePath, cacheDir, 'cache-file');
  if (existing && !options.replace) throw cacheSafetyError('cache-file', 'exists');

  const tempPath = options.replace ? safeCacheTempPath(filePath) : filePath;
  const directoryIdentity = captureCacheDirectoryIdentity(cacheDir, 'cache-file-directory');
  let createdByThisWrite = false;
  let installedAtFinalPath = false;
  let writtenIdentity = null;
  let fd = null;
  try {
    const flags = fs.constants.O_WRONLY
      | fs.constants.O_CREAT
      | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0);
    fd = fs.openSync(tempPath, flags, mode);
    createdByThisWrite = true;
    writtenIdentity = fs.fstatSync(fd);
    assertCacheFileDescriptorIdentity(fd, tempPath, directoryIdentity, 'cache-file');
    fs.fchmodSync(fd, mode);
    if ((assertCacheFileDescriptorIdentity(fd, tempPath, directoryIdentity, 'cache-file').mode & 0o777) !== mode) {
      throw cacheSafetyError('cache-file', 'permissions');
    }
    fs.writeFileSync(fd, data);
    if (options.replace) {
      getVerifiedCacheFileStatSync(filePath, cacheDir, 'cache-file');
      assertCacheDirectoryIdentity(directoryIdentity, 'cache-file-directory');
      fs.renameSync(tempPath, filePath);
      installedAtFinalPath = true;
      assertCacheFileDescriptorIdentity(fd, filePath, directoryIdentity, 'cache-file');
    }
  } catch (e) {
    if (createdByThisWrite && writtenIdentity) {
      const cleanupPath = installedAtFinalPath ? filePath : tempPath;
      try {
        const cleanupStat = fs.lstatSync(cleanupPath);
        if (!cleanupStat.isSymbolicLink()
          && cleanupStat.isFile()
          && cleanupStat.nlink === 1
          && cleanupStat.dev === writtenIdentity.dev
          && cleanupStat.ino === writtenIdentity.ino) {
          fs.unlinkSync(cleanupPath);
        }
      } catch (_) {}
    }
    if (e && e.message && e.message.startsWith('Unsafe cache path:')) throw e;
    throw cacheSafetyError('cache-file', 'write_failed');
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function hardenPresentationCacheFileIfPresent(filePath, cacheDir) {
  return hardenOwnerOnlyCacheFileSync(
    filePath,
    cacheDir,
    'presentation-cache-file',
    PRESENTATION_ASSET_FILE_MODE
  );
}

function tryHardenPresentationCacheFile(filePath, cacheDir) {
  try {
    return hardenPresentationCacheFileIfPresent(filePath, cacheDir);
  } catch (_) {
    return false;
  }
}

function readOwnerOnlyCacheFileSync(filePath, cacheDir, label, mode = OWNER_ONLY_FILE_MODE) {
  const handle = openVerifiedCacheFileSync(filePath, cacheDir, label);
  if (!handle) throw cacheSafetyError(label, 'unavailable');
  try {
    fs.fchmodSync(handle.fd, mode);
    const finalStat = assertCacheFileDescriptorIdentity(
      handle.fd,
      filePath,
      handle.directoryIdentity,
      label
    );
    if ((finalStat.mode & 0o777) !== mode) {
      throw cacheSafetyError(label, 'permissions');
    }
    return fs.readFileSync(handle.fd);
  } catch (error) {
    if (error && error.message && error.message.startsWith('Unsafe cache path:')) throw error;
    throw cacheSafetyError(label, 'unavailable');
  } finally {
    try { fs.closeSync(handle.fd); } catch (_) {}
  }
}

function sanitizeFigmaAssetFormat(format) {
  if (typeof format !== 'string') return 'png';
  const trimmed = format.trim().toLowerCase();
  if (!trimmed || trimmed.includes('\0')) return 'png';
  if (!/^\.?[a-z0-9]+$/.test(trimmed)) return 'png';

  const extension = trimmed.replace(/^\./, '');
  return SAFE_FIGMA_ASSET_FORMATS.has(extension) ? extension : 'png';
}

function createFigmaAssetCacheFileName(fileName, identityKey) {
  const safeName = String(fileName || 'figma-asset').replace(/[^a-zA-Z0-9_\-.]/g, '_');
  if (safeName.length <= 100 || typeof identityKey !== 'string' || !identityKey.trim()) {
    return safeName.substring(0, 100);
  }

  // Keep the identity-bearing digest before any user-controlled Figma file
  // name. Long display names must not truncate the only collision-resistant
  // portion of the cache path.
  const identityDigest = crypto.createHash('sha256').update(identityKey.trim()).digest('hex').slice(0, 16);
  const displayBudget = Math.max(1, 100 - identityDigest.length - 2);
  return `${identityDigest}__${safeName.substring(0, displayBudget)}`;
}

/**
 * Download a Figma asset from CDN URL to local disk.
 * @returns {Promise<string|null>} Local file path or null on failure
 */
async function downloadFigmaAsset(
  url,
  fileName,
  projectId,
  format = 'png',
  assetBudget = null,
  activationToken = null,
  operationGuard = null,
  identityKey = null
) {
  const isCurrent = () => isBoundWatchingActivationCurrent(projectId, activationToken) && (!operationGuard || operationGuard());
  try {
    const { response, buffer } = await fetchBufferWithLimits({
      fetchImpl: fetch,
      url,
      timeoutMs: FIGMA_NETWORK_LIMITS.requestTimeoutMs,
      maxBytes: FIGMA_NETWORK_LIMITS.assetResponseBytes,
      budget: assetBudget || createByteBudget(
        FIGMA_NETWORK_LIMITS.assetOperationBytes,
        FIGMA_NETWORK_LIMITS.assetOperationTimeoutMs
      ),
      maxRedirects: FIGMA_NETWORK_LIMITS.assetRedirects,
    });
    if (!response.ok) return null;

    if (buffer.length === 0) return null;
    if (!isCurrent()) return null;

    const projectDir = ensureFigmaProjectAssetsDir(projectId);

    // v2.4.2: Use actual format from Figma API if available, fall back to png
    const ext = sanitizeFigmaAssetFormat(format);
    const safeName = createFigmaAssetCacheFileName(fileName, identityKey);
    const localPath = path.join(projectDir, `${safeName}.${ext}`);

    // Skip if already exists with same size
    const existingStat = getVerifiedCacheFileStatSync(localPath, projectDir, 'figma-cache-file');
    if (existingStat) {
      const existingSize = existingStat.size;
      if (existingSize === buffer.length) {
        if (!isCurrent()) return null;
        if (!hardenOwnerOnlyCacheFileSync(
          localPath,
          projectDir,
          'figma-cache-file',
          FIGMA_ASSET_FILE_MODE
        )) {
          throw cacheSafetyError('figma-cache-file', 'permissions');
        }
        return localPath;
      }
    }

    if (!isCurrent()) return null;
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
async function ingestFigmaAssetsIntoProject(
  projectId,
  project,
  assets,
  contextLabel = 'scan',
  activationToken = null,
  operationGuard = null
) {
  const isCurrent = () => isBoundWatchingActivationCurrent(projectId, activationToken) && (!operationGuard || operationGuard());
  if (!assets || assets.length === 0) return 0;
  if (!isCurrent()) return 0;

  const existingPaths = new Set((project.files || []).map(f => normalizeTrackedFilePath(f.path)));
  const existingFigmaAssetKeys = new Set((project.files || []).map(getFigmaAssetDedupKey).filter(Boolean));
  const assetBudget = createByteBudget(
    FIGMA_NETWORK_LIMITS.assetOperationBytes,
    FIGMA_NETWORK_LIMITS.assetOperationTimeoutMs
  );
  let addedCount = 0;

  for (const asset of assets) {
    if (!isCurrent()) return addedCount;
    const figmaFileKey = typeof asset.figmaFileKey === 'string' && asset.figmaFileKey.trim()
      ? asset.figmaFileKey.trim()
      : (typeof asset.fileKey === 'string' && asset.fileKey.trim() ? asset.fileKey.trim() : null);
    const figmaAssetIdentity = typeof asset.imageRef === 'string' && asset.imageRef.trim()
      ? asset.imageRef.trim()
      : (typeof asset.nodeId === 'string' && asset.nodeId.trim()
        ? asset.nodeId.trim()
        : (typeof asset.url === 'string' && asset.url.trim() ? asset.url.trim().split('?')[0] : null));
    const figmaAssetDedupKey = getFigmaAssetDedupKey({
      figmaFileKey,
      fileKey: asset.fileKey,
      figmaAssetIdentity,
      imageRef: asset.imageRef,
      nodeId: asset.nodeId,
      url: asset.url
    });
    if (!figmaFileKey || !figmaAssetIdentity || !figmaAssetDedupKey) {
      console.log(
        `[crate][figma] asset skip (${contextLabel}): fileKeyPresent=${!!figmaFileKey} ` +
        `assetKeyPresent=${!!figmaAssetIdentity} reason=identity_unavailable`
      );
      continue;
    }
    if (existingFigmaAssetKeys.has(figmaAssetDedupKey)) {
      console.log(
        `[crate][figma] asset duplicate skip (${contextLabel}): fileKeyPresent=${!!figmaFileKey} ` +
        `assetKeyPresent=true reason=existing_asset_key`
      );
      continue;
    }

    const fileName = `${asset.figmaFileName}_${asset.name}`;
    const assetFormat = sanitizeFigmaAssetFormat(asset.format);
    const localPath = await downloadFigmaAsset(
      asset.url,
      fileName,
      projectId,
      assetFormat,
      assetBudget,
      activationToken,
      operationGuard,
      figmaAssetDedupKey
    );

    if (!isCurrent()) return addedCount;
    if (!localPath) {
      console.log(
        `[crate][figma] asset skip (${contextLabel}): fileKeyPresent=${!!figmaFileKey} ` +
        `name=${formatFigmaLogScalar(asset.name)} reason=download_failed`
      );
      if (contextLabel === 'pre-package') {
        const error = new Error(FIGMA_PACKAGE_TRANSFER_ERROR);
        error._crateFigmaPackageTransferBlocked = true;
        throw error;
      }
      continue;
    }
    const normalizedLocalPath = normalizeTrackedFilePath(localPath);
    if (existingPaths.has(normalizedLocalPath)) {
      console.log(
        `[crate][figma] asset duplicate skip (${contextLabel}): fileKeyPresent=${!!figmaFileKey} ` +
        `localName=${formatFigmaLocalNameForLog(localPath)} reason=existing_path`
      );
      continue;
    }

    const result = mutateProject(projectId, (proj) => {
      if (!isCurrent()) return null;
      const projectPaths = new Set(proj.files.map(f => normalizeTrackedFilePath(f.path)));
      if (projectPaths.has(normalizedLocalPath)) return null;
      if (figmaAssetDedupKey) {
        const projectFigmaKeys = new Set(proj.files.map(getFigmaAssetDedupKey).filter(Boolean));
        if (projectFigmaKeys.has(figmaAssetDedupKey)) return null;
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
        figmaAssetIdentity,
        figmaAssetKey: figmaAssetIdentity,
        figmaAssetDedupKey,
      };
      const staged = stageLiveObservedFile(proj, fileRecord, {
        allowDirect: true,
        appFamily: 'figma',
        reason: 'figma-project-tracked-cloud',
      });
      if (!staged.changed || staged.decision !== LIVE_CAPTURE_DECISIONS.DIRECT_ADD) return null;
      console.log(
        `[crate][figma] asset inserted (${contextLabel}): fileKeyPresent=${!!figmaFileKey} ` +
        `name=${formatFigmaLocalNameForLog(fileRecord.name)} localName=${formatFigmaLocalNameForLog(localPath)}`
      );
      return { files: proj.files, fileRecord };
    });

    if (result) {
      if (!isCurrent()) return addedCount;
      const projectHasLocalPath = (project.files || []).some(f => normalizeTrackedFilePath(f.path) === normalizedLocalPath);
      const projectHasFigmaKey = figmaAssetDedupKey && (project.files || []).some(f => getFigmaAssetDedupKey(f) === figmaAssetDedupKey);
      if (!projectHasLocalPath && !projectHasFigmaKey) {
        project.files.push({ ...result.fileRecord });
        project.files = deduplicateFiles(project.files);
        clearFileVisualProjectCache(projectId);
      }
      mutateProject(projectId, (proj) => {
        if (!isCurrent()) return null;
        const storedFile = (proj.files || []).find(file => (
          normalizeTrackedFilePath(file.path) === normalizedLocalPath &&
          (!figmaAssetDedupKey || getFigmaAssetDedupKey(file) === figmaAssetDedupKey)
        )) || result.fileRecord;
        recordFigmaAssetProvenance(proj, storedFile, asset, contextLabel);
        return null;
      });
      addedCount++;
      existingPaths.add(normalizedLocalPath);
      if (figmaAssetDedupKey) existingFigmaAssetKeys.add(figmaAssetDedupKey);
    } else {
      console.log(
        `[crate][figma] asset duplicate skip (${contextLabel}): fileKeyPresent=${!!figmaFileKey} ` +
        `assetKeyPresent=${!!figmaAssetIdentity} localName=${formatFigmaLocalNameForLog(localPath)} reason=already_in_project`
      );
    }
  }

  return addedCount;
}

/**
 * Poll Figma API for recent files and extract assets.
 * Runs on watch session start and every 60 seconds.
 */
async function pollFigmaForProjectCore(projectId, isInitialScan = false, activationToken = null, watcherGeneration = null) {
  if (figmaInProgress.has(projectId)) return { skipped: true, reason: 'in-progress' }; // Prevent overlapping polls

  const currentProjects = getProjects();
  const project = currentProjects.find(p => p.id === projectId);
  if (!project || !isActiveWatchingProject(projectId, activationToken)) {
    return { skipped: true, reason: 'not-watching' };
  }
  const scanStartedAt = Date.now();
  const rateLimitRetryAt = getFigmaRateLimitRetryAt(projectId, project);
  if (rateLimitRetryAt > scanStartedAt) {
    const warning = figmaRateLimitWarning();
    updateFigmaSessionRateLimitWarning(projectId, rateLimitRetryAt);
    sendToRenderer('figma:scan-complete', {
      projectId,
      filesFound: 0,
      assetsFound: 0,
      addedCount: 0,
      errors: [],
      timestamp: Date.now(),
      warning,
      retryAt: rateLimitRetryAt,
      retryAfterMs: rateLimitRetryAt - scanStartedAt
    });
    return {
      skipped: true,
      rateLimited: true,
      reason: 'rate-limited-backoff',
      retryAt: rateLimitRetryAt,
      retryAfterMs: rateLimitRetryAt - scanStartedAt,
      warning
    };
  }

  // Check if Figma is connected
  const { FigmaParser } = require('./parsers/figma');
  const parser = new FigmaParser();
  const token = await parser.getStoredToken();
  if (!isActiveWatchingProject(projectId, activationToken)) {
    return { skipped: true, reason: 'watch-session-superseded' };
  }
  if (!token) {
    stopFigmaPolling(projectId);
    const warningUpdate = markProjectFigmaConnectionUnavailable(projectId);
    if (warningUpdate) sendToRenderer('project:updated', { projectId });
    sendToRenderer('figma:auth-error', { projectId, error: 'Figma is not connected — reconnect in Settings' });
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
    const safeTrackedFileSummaries = summarizeTrackedFigmaFilesForLog(rawTrackedFiles);
    const trackedCandidateCount = new Set(
      fileKeys.filter(key => typeof key === 'string' && key.trim())
    ).size;

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
      `trackedCandidateCount=${trackedCandidateCount} ` +
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
    if (!isActiveWatchingProject(projectId, activationToken)) {
      return { skipped: true, reason: 'watch-session-superseded' };
    }

    if (watcherGeneration !== null && !getWatcherCoordinator(projectId).isCurrent(projectId, watcherGeneration)) {
      return { skipped: true, reason: 'watch-session-superseded' };
    }
    const scopeStateResult = mergeFigmaScopeEntriesIntoSession(projectId, scanResult.scopeEntries || []);
    const activeProject = getProjects().find(p => p.id === projectId) || latestProject;
    let activeWarnings = (((activeProject || {}).figmaSession || {}).warnings) || [];
    const candidateDiagnostics = summarizeFigmaCandidateDiagnosticsForLog(scanResult.candidateDiagnostics);
    if (candidateDiagnostics) {
      console.log(`[crate][figma] candidate diagnostics: ${JSON.stringify(candidateDiagnostics)}`);
    }
    const retryAfterMs = getFigmaScanRetryAfterMs(scanResult);
    const isRateLimited = scanResult.rateLimited === true ||
      hasFigmaRateLimitDiagnostic(candidateDiagnostics) ||
      retryAfterMs !== null;
    let rateLimitRetryAt = 0;
    if (isRateLimited) {
      scanResult.assets = [];
      rateLimitRetryAt = setFigmaRateLimitBackoff(projectId, retryAfterMs);
      const rateLimitScopeUpdate = updateFigmaSessionRateLimitWarning(projectId, rateLimitRetryAt);
      if (rateLimitScopeUpdate) {
        sendToRenderer('project:updated', { projectId });
      }
      const refreshedProject = getProjects().find(p => p.id === projectId) || activeProject;
      activeWarnings = (((refreshedProject || {}).figmaSession || {}).warnings) || activeWarnings;
    } else {
      const clearedRateLimit = clearFigmaRateLimitState(projectId);
      if (clearedRateLimit) sendToRenderer('project:updated', { projectId });
    }

    if (scanResult.errors.length > 0) {
      console.warn('[crate][figma] Scan errors:', summarizeFigmaErrorsForLog(scanResult.errors));
      // Detect token expiry / auth failures — stop polling instead of retrying every 60s
      const hasInvalidTokenDiagnostic = hasFigmaInvalidTokenDiagnostic(candidateDiagnostics);
      if (hasFigmaAuthError(scanResult.errors) || hasInvalidTokenDiagnostic) {
        console.error('[crate][figma] Token appears expired or revoked — stopping Figma polling for project', projectId);
        stopFigmaPolling(projectId);
        const warningUpdate = markProjectFigmaConnectionUnavailable(projectId);
        if (warningUpdate) sendToRenderer('project:updated', { projectId });
        // Notify renderer about auth failure
        sendToRenderer('figma:auth-error', { projectId, error: 'Figma token expired or invalid — reconnect in Settings' });
        return {
          skipped: true,
          reason: 'auth-failed',
          projectId,
          error: 'Figma token expired or invalid — reconnect in Settings'
        };
      }
    }

    if (scanResult.assets.length === 0) {
      // Notify renderer even when no assets found
      const scanErrors = sanitizeFigmaRendererIssues(scanResult.errors);
      const sessionWarning = sanitizeFigmaRendererIssue(
        activeWarnings[0] || (scanResult.warnings && scanResult.warnings[0]),
        null
      );
      if (scanResult.files.length === 0 && (teamIds.length > 0 || fileKeys.length > 0)) {
        sendToRenderer('figma:scan-complete', {
          projectId, filesFound: 0, assetsFound: 0, addedCount: 0,
          ...(isRateLimited ? { rateLimited: true } : {}),
          errors: scanErrors, timestamp: Date.now(),
          warning: sessionWarning || 'No recent Figma files found. Make sure your file was modified recently.',
          candidateDiagnostics,
          ...(rateLimitRetryAt ? { retryAt: rateLimitRetryAt, retryAfterMs: rateLimitRetryAt - Date.now() } : {})
        });
      } else {
        sendToRenderer('figma:scan-complete', {
          projectId, filesFound: scanResult.files.length, assetsFound: 0, addedCount: 0,
          ...(isRateLimited ? { rateLimited: true } : {}),
          errors: scanErrors, timestamp: Date.now(),
          warning: sessionWarning,
          candidateDiagnostics,
          ...(rateLimitRetryAt ? { retryAt: rateLimitRetryAt, retryAfterMs: rateLimitRetryAt - Date.now() } : {})
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
        candidateDiagnostics,
        ...(isRateLimited ? { rateLimited: true } : {}),
        ...(rateLimitRetryAt ? { retryAt: rateLimitRetryAt, retryAfterMs: rateLimitRetryAt - Date.now() } : {})
      };
    }

    console.log(`[crate][figma] Found ${scanResult.files.length} files, ${scanResult.assets.length} assets`);

    // Download assets and add to project
    const scopedAssets = scanResult.assets.map((asset) => ({
      ...asset,
      figmaScopeMode: getProjectFigmaScopeMode(latestProject)
    }));
    const addedCount = await ingestFigmaAssetsIntoProject(
      projectId,
      project,
      scopedAssets,
      'poll',
      activationToken
    );
    if (
      !isActiveWatchingProject(projectId, activationToken) ||
      (watcherGeneration !== null && !getWatcherCoordinator(projectId).isCurrent(projectId, watcherGeneration))
    ) {
      return { skipped: true, reason: 'watch-session-superseded' };
    }

    if (addedCount > 0) {
      // Update activity timestamp
      lastFileActivity.set(projectId, Date.now());
      inactivityNotified.delete(projectId);

      // Notify renderer
      sendProjectFileStateToRenderer(projectId, activationToken);

      console.log(`[crate][figma] Added ${addedCount} Figma assets to project ${projectId}`);
    }
    if (scopeStateResult) {
      sendToRenderer('project:updated', { projectId });
    }

    const errors = addedCount > 0 ? [] : sanitizeFigmaRendererIssues(scanResult.errors);
    const warning = sanitizeFigmaRendererIssue(
      activeWarnings[0] || (addedCount > 0 ? null : (scanResult.warnings && scanResult.warnings[0])),
      null
    );
    sendToRenderer('figma:scan-complete', {
      projectId,
      filesFound: scanResult.files.length,
      assetsFound: scanResult.assets.length,
      addedCount,
      errors,
      timestamp: Date.now(),
      warning,
      candidateDiagnostics,
      ...(rateLimitRetryAt ? { retryAt: rateLimitRetryAt, retryAfterMs: rateLimitRetryAt - Date.now() } : {})
    });

    figmaScanTimestamps.set(projectId, scanStartedAt);
    return {
      projectId,
      filesFound: scanResult.files.length,
      assetsFound: scanResult.assets.length,
      addedCount,
      errors,
      warning,
      candidateDiagnostics,
      ...(rateLimitRetryAt ? { retryAt: rateLimitRetryAt, retryAfterMs: rateLimitRetryAt - Date.now() } : {})
    };
  } catch (e) {
    if (activationToken !== null && !isActiveWatchingProject(projectId, activationToken)) {
      return { skipped: true, reason: 'watch-session-superseded' };
    }
    const safeError = sanitizeFigmaRendererIssue(e);
    console.error('[crate][figma] pollFigmaForProject error:', safeError);
    sendToRenderer('figma:scan-error', { projectId, error: safeError });
    // Detect token expiry / auth failures at the network level
    const msg = (e.message || '').toLowerCase();
    if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('token invalid') || msg.includes('invalid figma api token') || msg.includes('personal access token')) {
      console.error('[crate][figma] Token appears expired or revoked — stopping Figma polling for project', projectId);
      stopFigmaPolling(projectId);
      const warningUpdate = markProjectFigmaConnectionUnavailable(projectId);
      if (warningUpdate) sendToRenderer('project:updated', { projectId });
      sendToRenderer('figma:auth-error', { projectId, error: 'Figma token expired or invalid — reconnect in Settings' });
      return { skipped: true, reason: 'auth-failed', projectId, error: safeError };
    }
    return { projectId, error: safeError };
  } finally {
    if (activationToken === null || watchingActivationTokens.get(projectId) === activationToken) {
      figmaInProgress.delete(projectId);
    }
    scheduleDeletedProjectCacheCleanup(projectId);
  }
}

async function pollFigmaForProject(projectId, isInitialScan = false, activationToken = null) {
  return runBackgroundWatcherOperation(projectId, 'figma', (watcherGeneration) => (
    pollFigmaForProjectCore(projectId, isInitialScan, activationToken, watcherGeneration)
  ));
}

/**
 * Start Figma polling for a project.
 */
async function startFigmaPolling(projectId, activationToken = null) {
  const project = getProjects().find(p => p.id === projectId);
  if (!project || !isActiveWatchingProject(projectId, activationToken) || !projectHasFigmaTrackedFiles(project)) {
    stopFigmaPolling(projectId);
    return;
  }

  // Guard: prevent duplicate pollers if called while initial poll is in progress
  if (figmaPollers.has(projectId) || figmaPollerStarting.has(projectId)) return;
  figmaPollerStarting.add(projectId);

  let initialResult;
  try {
    // Preserve the one-time startup scan. Only recurring background ticks are
    // coalesced by the watcher coordinator.
    initialResult = await pollFigmaForProjectCore(projectId, true, activationToken, null);
  } finally {
    if (activationToken === null || watchingActivationTokens.get(projectId) === activationToken) {
      figmaPollerStarting.delete(projectId);
    }
  }

  if (initialResult && (initialResult.reason === 'not-connected' || initialResult.reason === 'auth-failed')) {
    return;
  }

  // Guard again after async: another caller may have set up a poller while we awaited
  if (figmaPollers.has(projectId)) return;

  const latestProject = getProjects().find(p => p.id === projectId);
  if (
    !latestProject ||
    !isActiveWatchingProject(projectId, activationToken) ||
    !projectHasFigmaTrackedFiles(latestProject)
  ) {
    return;
  }

  // Start 60-second polling interval
  const intervalId = setInterval(() => {
    pollFigmaForProject(projectId, false, activationToken);
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
    set end of outputLines to "COMPLETE" & tab & documentCount & tab & placedItemCount
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
  const diagnostics = { docRowsSeen: 0, linkRowsSeen: 0, documentCount: null,
    placedItemsCount: null, terminalSeen: false, malformedRows: 0,
    normalizedPaths: 0, pathSkipped: {} };
  for (const rawLine of String(output || '').split('\n')) {
    if (!rawLine) continue;
    const parts = rawLine.split('\t');
    const kind = parts[0];
    if (diagnostics.terminalSeen) { diagnostics.malformedRows++; continue; }
    if (kind === 'STATUS' && parts.length === 2) {
      statuses.push(normalizeLiveAppStatusCode(parts[1], 'illustrator-query-failed'));
      continue;
    }
    if (kind === 'ERROR' && parts.length === 2) {
      errors.push(normalizeLiveAppStatusCode(parts[1], 'illustrator-query-failed'));
      continue;
    }
    if (kind === 'COMPLETE') {
      const canonicalCount = value => /^(0|[1-9]\d*)$/.test(value) ? Number(value) : null;
      const documentCount = canonicalCount(parts[1]), placedItemsCount = canonicalCount(parts[2]);
      diagnostics.terminalSeen = true; const valid = parts.length === 3 && Number.isSafeInteger(documentCount) &&
        Number.isSafeInteger(placedItemsCount);
      if (valid) Object.assign(diagnostics, { documentCount, placedItemsCount });
      else diagnostics.malformedRows++; continue;
    }
    if (kind === 'DOC' && parts.length === 5 && (parts[3] === 'true' || parts[3] === 'false') && (parts[4] === 'true' || parts[4] === 'false')) {
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
        modified: modifiedValue === 'true', current: currentValue === 'true',
      });
      continue;
    }
    if (kind === 'LINK' && parts.length === 6 && (parts[4] === 'true' || parts[4] === 'false') && (parts[5] === 'true' || parts[5] === 'false')) {
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
        linkedPath: linkedPath.path, modified: modifiedValue === 'true',
        current: currentValue === 'true',
      });
      continue;
    }
    diagnostics.malformedRows++;
  }
  return { documents, links, statuses, errors, diagnostics };
}

const ILLUSTRATOR_SOURCE_EXTENSIONS = new Set(['.ai', '.eps', '.pdf', '.svg']);
const ILLUSTRATOR_SCOPE_SET_KEYS = ['baselineDocumentPaths', 'admittedDocumentPaths', 'allowedLinkedPaths', 'excludedLinkedPaths'], CAPTURE_SOURCE_APP_FAMILY = new Map([['ai-linked', 'illustrator'], ['ps-poll', 'photoshop'], ['psd-linked', 'photoshop'], ['psd-embedded', 'photoshop'], ['scan-on-save-linked', 'photoshop'], ['scan-on-save-embedded', 'photoshop'], ['indd-poll', 'indesign'], ['indd-linked', 'indesign'], ['figma-auto', 'figma'], ['fig-scan', 'figma'], ['scan-on-save-presentation', 'presentation'], ['lastused-scan', 'generic'], ['manual-browse', 'generic'], ['lsof', 'generic']]);
const EXACT_APP_FAMILY_MARKERS = new Map([['illustrator', 'illustrator'], ['photoshop', 'photoshop'], ['indesign', 'indesign'], ['figma', 'figma'], ['presentation', 'presentation'], ['powerpoint', 'presentation'], ['keynote', 'presentation'], ['generic', 'generic'], ...CAPTURE_SOURCE_APP_FAMILY]);
function getExactAppFamilyMarker(value) { const normalized = normalizeLiveCaptureReason(value, ''); return EXACT_APP_FAMILY_MARKERS.get(normalized) || null; }
function getScopedCaptureSourceAppFamily(value) { const normalized = normalizeLiveCaptureReason(value, ''); if (!normalized) return null; if (CAPTURE_SOURCE_APP_FAMILY.has(normalized)) return CAPTURE_SOURCE_APP_FAMILY.get(normalized); if (normalized === 'illustrator' || normalized.startsWith('ai-') || normalized.includes('illustrator')) return 'illustrator'; if (normalized === 'photoshop' || normalized.startsWith('psd-') || normalized.startsWith('ps-') || normalized.includes('photoshop')) return 'photoshop'; if (normalized === 'indesign' || normalized.startsWith('indd-') || normalized.includes('indesign')) return 'indesign'; if (normalized === 'figma' || normalized.startsWith('fig-') || normalized.includes('figma')) return 'figma'; if (normalized.includes('powerpoint') || normalized.includes('keynote') || normalized.includes('presentation')) return 'presentation'; if (normalized === 'generic' || normalized.startsWith('lastused-') || normalized === 'manual-browse' || normalized === 'lsof') return 'generic'; return null; }
function normalizeIllustratorDocumentName(value) { const safe = sanitizeLiveEvidenceText(value); return safe ? safe.toLowerCase() : null; } function getExplicitCaptureAppFamily(fileEntry, observation = {}) { const capture = fileEntry && fileEntry.captureEvidence, evidence = observation.liveEvidence || {}; for (const value of [observation.appFamily, evidence.appFamily, capture && capture.appFamily]) { const family = getExactAppFamilyMarker(value); if (family) return family; } return getScopedCaptureSourceAppFamily(fileEntry && fileEntry.source); }
function getScopedFileAppFamily(project, fileEntry, observation = {}) { const explicit = getExplicitCaptureAppFamily(fileEntry, observation); if (explicit || !project || !fileEntry) return explicit; const key = getLiveEvidenceKeyHash(normalizeTrackedFilePath(fileEntry.path)), latest = key && project.liveEvidenceLedger?.candidates?.[key]?.latest; return getExplicitCaptureAppFamily(latest, latest || {}); } function isIllustratorSourceCandidate(file) { const family = getExplicitCaptureAppFamily(file); return family === 'illustrator' || ((!family || family === 'generic') && isExplicitUserCapturedFile(file) && ILLUSTRATOR_SOURCE_EXTENSIONS.has((file && (file.ext || path.extname(file.path || file.name || '')) || '').toLowerCase())); }
function getIllustratorActivationScope(projectId, activationToken = null) { const scope = illustratorActivationScopes.get(projectId); return !scope || (activationToken !== null && scope.activationToken !== activationToken) ? null : scope; } function getFreshActiveWatchingProject(projectId, activationToken) { return isActiveWatchingProject(projectId, activationToken) ? getProjects().find(project => project && project.id === projectId) || null : null; }
function isAcceptedIllustratorProjectFile(project, file) { const ext = (file?.ext || path.extname(file?.path || '') || '').toLowerCase(); const acceptedPendingIllustratorSource = file?.acceptedPending === true && file.projectRole !== 'asset' && ILLUSTRATOR_SOURCE_EXTENSIONS.has(ext) && (getAcceptedPendingAppFamily(file) === 'illustrator' || getScopedFileAppFamily(project, file) === 'illustrator') && isProjectAssetBaselineSource(file); return !!file && (isIllustratorSourceCandidate(file) || acceptedPendingIllustratorSource || isPersistedAcceptedWatcherSource(project, file)) && isTrustedSessionProjectFile(project, file); } function sameIllustratorActivationScope(a, b) { return a.status === b.status && ILLUSTRATOR_SCOPE_SET_KEYS.every(key => { const left = [...a[key]].sort(), right = [...b[key]].sort(); return left.length === right.length && left.every((value, index) => value === right[index]); }); } function reviseIllustratorActivationScope(projectId, scope, update) { if (!scope || illustratorActivationScopes.get(projectId) !== scope) return null; const next = { ...scope, ...Object.fromEntries(ILLUSTRATOR_SCOPE_SET_KEYS.map(key => [key, new Set(scope[key])])) }; update(next); if (illustratorActivationScopes.get(projectId) !== scope) return null; if (sameIllustratorActivationScope(scope, next)) return scope; next.revision = scope.revision + 1; illustratorActivationScopes.set(projectId, next); return next; }
const ILLUSTRATOR_DIRECT_PATH_FALLBACK_FAILURES = new Set(['illustrator-placed-item-file-query-failed', 'illustrator-placed-item-file-of-query-failed']);
const ILLUSTRATOR_DIRECT_PATH_FALLBACK_RECOVERY_STATUSES = new Set([
  ...ILLUSTRATOR_DIRECT_PATH_FALLBACK_FAILURES,
  'illustrator-placed-item-path-fallback-used',
]);
function isIllustratorDirectPathFallbackRecovery(statuses = []) {
  return [...ILLUSTRATOR_DIRECT_PATH_FALLBACK_FAILURES].every(status => statuses.includes(status))
    && statuses.includes('illustrator-placed-item-path-fallback-used')
    && statuses.every(status => ILLUSTRATOR_DIRECT_PATH_FALLBACK_RECOVERY_STATUSES.has(status));
}
function getIllustratorStatusFailureReason(statuses = []) {
  if (statuses.includes('illustrator-placed-item-file-fallback-failed')) return 'illustrator-placed-item-file-fallback-failed';
  const queryFailures = statuses.filter(status => status.endsWith('-query-failed'));
  if (!queryFailures.length) return null;
  return isIllustratorDirectPathFallbackRecovery(statuses) ? null : queryFailures[0];
}
function getIllustratorSnapshotFailureReason(queryResult) { if (!queryResult || queryResult.stale) return 'stale-activation'; if (queryResult.running === false) return null; if (queryResult.errorCategory) return queryResult.errorCategory; if (queryResult.outputEmpty) return 'empty-output'; const activeState = queryResult.activeState; if (!activeState || activeState.errors?.length) return 'illustrator-query-failed'; const { documents = [], links = [], diagnostics = {}, statuses = [] } = activeState; if (documents.some(doc => !normalizeTrackedFilePath(doc && doc.documentPath))) return 'pathless-document'; if (links.some(link => !normalizeTrackedFilePath(link?.documentPath) || !normalizeTrackedFilePath(link?.linkedPath))) return 'pathless-link'; if (!diagnostics.terminalSeen) return 'missing-terminal'; if (diagnostics.malformedRows) return 'malformed-snapshot'; if (diagnostics.documentCount !== diagnostics.docRowsSeen || diagnostics.docRowsSeen !== documents.length) return 'document-count-mismatch'; if (diagnostics.placedItemsCount !== diagnostics.linkRowsSeen || diagnostics.linkRowsSeen !== links.length) return 'placed-item-count-mismatch'; return getIllustratorStatusFailureReason(statuses) || (documents.length === 0 && !statuses.includes('no-documents') ? 'partial-document-snapshot' : null); }
function updateIllustratorActivationScope(projectId, activationToken, queryResult, isActivation = false) {
  let scope = getIllustratorActivationScope(projectId, activationToken); const project = getFreshActiveWatchingProject(projectId, activationToken); if (!scope || !project) return null; if (getIllustratorSnapshotFailureReason(queryResult)) { scope = reviseIllustratorActivationScope(projectId, scope, next => { next.status = 'failed-closed'; const active = queryResult?.activeState || {}; for (const doc of active.documents || []) next.baselineDocumentPaths.add(normalizeTrackedFilePath(doc.documentPath)); for (const link of active.links || []) next.excludedLinkedPaths.add(normalizeTrackedFilePath(link.linkedPath)); next.baselineDocumentPaths.delete(null); next.excludedLinkedPaths.delete(null); }); return { scope, project, ready: false }; } if (scope.status === 'failed-closed' && !isActivation) return { scope, project, ready: false }; const active = queryResult.activeState || {}, recovery = scope.status === 'recovering-explicit', acceptedPaths = new Set((project.files || []).filter(file => isAcceptedIllustratorProjectFile(project, file)).map(file => normalizeTrackedFilePath(file.path)).filter(Boolean));
  scope = reviseIllustratorActivationScope(projectId, scope, next => {
    if (isActivation) for (const key of ILLUSTRATOR_SCOPE_SET_KEYS) next[key].clear(); for (const acceptedPath of acceptedPaths) { next.admittedDocumentPaths.add(acceptedPath); next.baselineDocumentPaths.delete(acceptedPath); } for (const doc of active.documents || []) { const documentPath = normalizeTrackedFilePath(doc.documentPath); if (!documentPath) continue; const admitted = acceptedPaths.has(documentPath) || (!isActivation && scope.status === 'ready' && !scope.baselineDocumentPaths.has(documentPath)); if (admitted) next.admittedDocumentPaths.add(documentPath); else if (isActivation || recovery) next.baselineDocumentPaths.add(documentPath); } for (const link of active.links || []) { const documentPath = normalizeTrackedFilePath(link.documentPath), linkedPath = normalizeTrackedFilePath(link.linkedPath); if (documentPath && linkedPath) (next.admittedDocumentPaths.has(documentPath) ? next.allowedLinkedPaths : next.excludedLinkedPaths).add(linkedPath); } next.status = 'ready'; }); return scope ? { scope, project, ready: true } : null; }
function getIllustratorRelationshipSourcePath(fileEntry, observation = {}) { const evidence = observation.liveEvidence || {}; return normalizeTrackedFilePath(observation.relationshipSourcePath || evidence.relationshipSourcePath || evidence.sourceDocumentPath || fileEntry?.sourceDocumentPath); }
function createIllustratorProjectFilePathSnapshot(projectFiles) { const files = Array.isArray(projectFiles) ? projectFiles : []; return { entries: files.map(file => ({ file, rawPath: file && file.path })), paths: files.map(file => normalizeTrackedFilePath(file && file.path)) }; }
function isIllustratorScopedFileAllowed(project, fileEntry, observation = {}) { if (!project || !fileEntry) return true; if (isExplicitUserCapturedFile(fileEntry)) return true; const projectFiles = Array.isArray(project.files) ? project.files : []; const projectFilePathSnapshot = observation.projectFilePaths && !Array.isArray(observation.projectFilePaths) ? observation.projectFilePaths : null; const projectFilePaths = projectFilePathSnapshot && Array.isArray(projectFilePathSnapshot.entries) && Array.isArray(projectFilePathSnapshot.paths) && projectFilePathSnapshot.entries.length === projectFiles.length && projectFilePathSnapshot.paths.length === projectFiles.length && projectFilePathSnapshot.entries.every((entry, index) => entry && entry.file === projectFiles[index] && entry.rawPath === (projectFiles[index] && projectFiles[index].path)) ? projectFilePathSnapshot.paths : null; const projectFilePathAt = index => projectFilePaths ? projectFilePaths[index] : normalizeTrackedFilePath(projectFiles[index] && projectFiles[index].path); const hasPersistedBaselineSource = typeof fileEntry.assetBaselineSourcePath === 'string'; if (observation.explicitBaselineRelationship === true || hasPersistedBaselineSource) { const sourcePath = normalizeTrackedFilePath(fileEntry.assetBaselineSourcePath) || getIllustratorRelationshipSourcePath(fileEntry, observation); const acceptedSource = projectFiles.find((file, index) => projectFilePathAt(index) === sourcePath); return !!acceptedSource && isProjectAssetBaselineSource(acceptedSource); } if (getScopedFileAppFamily(project, fileEntry, observation) !== 'illustrator') return true; const normalizedPath = normalizeTrackedFilePath(fileEntry.path), scope = getIllustratorActivationScope(project.id);
  if (isExplicitUserCapturedFile(fileEntry) || isAcceptedPendingCapturedFile(project, fileEntry) || projectFiles.some((file, index) => projectFilePathAt(index) === normalizedPath && isAcceptedIllustratorProjectFile(project, file))) return true; if (!scope || !normalizedPath) return false; if (scope.allowedLinkedPaths.has(normalizedPath) || scope.admittedDocumentPaths.has(normalizedPath)) return true; if (scope.status !== 'ready' || scope.excludedLinkedPaths.has(normalizedPath) || scope.baselineDocumentPaths.has(normalizedPath)) return false; const sourcePath = getIllustratorRelationshipSourcePath(fileEntry, observation); return sourcePath ? scope.admittedDocumentPaths.has(sourcePath) : (!isWeakBroadObserverFile(fileEntry) && ILLUSTRATOR_SOURCE_EXTENSIONS.has(path.extname(fileEntry.path || '').toLowerCase())); }
function getScopedRecordAppFamily(value) { const normalized = normalizeLiveCaptureReason(value, ''); if (!normalized) return null; if (CAPTURE_SOURCE_APP_FAMILY.has(normalized)) return CAPTURE_SOURCE_APP_FAMILY.get(normalized); if (normalized === 'illustrator' || normalized.startsWith('ai-') || normalized.includes('illustrator')) return 'illustrator'; if (normalized === 'photoshop' || normalized.startsWith('psd-') || normalized.startsWith('ps-') || normalized.includes('photoshop')) return 'photoshop'; if (normalized === 'indesign' || normalized.startsWith('indd-') || normalized.includes('indesign')) return 'indesign'; if (normalized === 'figma' || normalized.startsWith('fig-') || normalized.includes('figma')) return 'figma'; if (normalized.includes('powerpoint') || normalized.includes('keynote') || normalized.includes('presentation')) return 'presentation'; if (normalized === 'generic' || normalized.startsWith('lastused-') || normalized === 'manual-browse' || normalized === 'lsof') return 'generic'; return null; } function getScopedRecordFamilies(record) { const values = [record?.appFamily, record?.source, record?.explicitUserAuthority?.source, record?.captureEvidence?.appFamily, record?.captureEvidence?.source, record?.captureEvidence?.observerMethod, record?.latest?.appFamily, record?.latest?.source, record?.latest?.observerMethod, record?.observer?.appFamily, record?.observer?.method, record?.payload?.appFamily, record?.payload?.source, record?.payload?.authoritySource, record?.payload?.observer?.method]; return new Set(values.map(getScopedRecordAppFamily).filter(Boolean)); }
const SCOPED_PRIMARY_PATH_FIELDS = ['path', 'filePath', 'localPath', 'normalizedPath']; function isScopedRecord(value) { return isRecord(value) && ['id', 'fileId', 'evidenceKey', 'path', 'source', 'appFamily', 'captureEvidence', 'latest', 'observer', 'relationType', 'subjectNodeId', 'objectNodeId', 'type'].some(key => Object.prototype.hasOwnProperty.call(value, key)); } function scopedRecordIdentities(entry) { const item = entry.item, ids = [item.id, item.fileId, item.evidenceKey]; if (!Array.isArray(entry.parent) && typeof entry.key === 'string' && !['captureEvidence', 'latest', 'observer', 'payload', 'metadata'].includes(entry.key)) ids.push(entry.key); return ids.filter(value => typeof value === 'string'); } function scopedRecordPrimaryPath(record, key, nodePaths, ledgerPaths) { const values = [...SCOPED_PRIMARY_PATH_FIELDS.map(field => record?.[field]), ...SCOPED_PRIMARY_PATH_FIELDS.map(field => record?.latest?.[field]), ...SCOPED_PRIMARY_PATH_FIELDS.map(field => record?.payload?.[field])]; for (const value of values) { const normalized = typeof value === 'string' && (path.isAbsolute(value) || /normalizedPath/.test(key || '')) ? normalizeTrackedFilePath(value) : null; if (normalized) return normalized; } return ledgerPaths.get(key) || nodePaths.get(record?.objectNodeId) || (typeof key === 'string' && path.isAbsolute(key) ? normalizeTrackedFilePath(key) : null); }
function scopedRecordReferencesHidden(value, info, hiddenPaths, hiddenIds, nodePaths) { const ancestors = new Set(); let visited = 0; const visit = (item, key = '') => { if (++visited > 50000) return true; if (typeof item === 'string') { if (hiddenIds.has(item)) return true; const nodePath = /NodeId$/i.test(key) ? nodePaths.get(item) : null, normalized = (path.isAbsolute(item) || /paths?$/i.test(key)) ? normalizeTrackedFilePath(item) : null, deniedPath = nodePath || (normalized && hiddenPaths.has(normalized) ? normalized : null); return !!deniedPath && !(info.authorized && info.primaryPath === deniedPath); } if (!Array.isArray(item) && !isRecord(item)) return false; if (ancestors.has(item)) return true; ancestors.add(item); try { for (const childKey of Object.keys(item)) if (visit(item[childKey], childKey)) return true; return false; } catch (_) { return true; } finally { ancestors.delete(item); } }; return visit(value); }
function getIllustratorScopedProjectView(project) { if (!project) return project; const scope = getIllustratorActivationScope(project.id), hiddenPaths = new Set(scope ? [...scope.baselineDocumentPaths, ...scope.excludedLinkedPaths] : []), hiddenPendingPaths = new Set(), stalePendingFiles = new Set(), scopeAllowedPaths = new Set(); for (const file of [...(project.files || []), ...(project.pendingFiles || [])]) { const filePath = normalizeTrackedFilePath(file?.path); if ((project.pendingFiles || []).includes(file) && !isCurrentWatchSessionPendingFile(project, file)) { hiddenPaths.add(filePath); hiddenPendingPaths.add(filePath); stalePendingFiles.add(file); } else if (!isIllustratorScopedFileAllowed(project, file)) hiddenPaths.add(filePath); else if (hiddenPaths.has(filePath) && !hiddenPendingPaths.has(filePath) && getScopedFileAppFamily(project, file) === 'illustrator') scopeAllowedPaths.add(filePath); } hiddenPaths.delete(null); if (!hiddenPaths.size) return project;
  const nodePaths = new Map(), ledgerPaths = new Map(); for (const hiddenPath of hiddenPaths) { nodePaths.set(createNodeId(NODE_TYPES.FILE, { normalizedPath: hiddenPath }), hiddenPath); const ledgerId = getLiveEvidenceKeyHash(hiddenPath); if (ledgerId) ledgerPaths.set(ledgerId, hiddenPath); } for (const [id, node] of Object.entries(project.provenance?.nodes || {})) { const nodePath = normalizeTrackedFilePath(node?.path || node?.normalizedPath); if (hiddenPaths.has(nodePath)) { nodePaths.set(id, nodePath); if (typeof node?.id === 'string') nodePaths.set(node.id, nodePath); } }
  const hiddenEntries = new WeakMap(), records = [], infos = [], infoByObject = new WeakMap(), markHidden = (parent, key) => { if (!parent) return false; let keys = hiddenEntries.get(parent); if (!keys) hiddenEntries.set(parent, keys = new Set()); const fresh = !keys.has(key); keys.add(key); return fresh; }, isHidden = (parent, key) => !!hiddenEntries.get(parent)?.has(key); let collected = 0; const collect = (value, parent, key, ancestors) => { if (!Array.isArray(value) && !isRecord(value)) return; if (++collected > 50000 || ancestors.has(value)) { markHidden(parent, key); return; } if (isScopedRecord(value)) records.push({ item: value, parent, key }); ancestors.add(value); try { for (const [childKey, child] of Object.entries(value)) { if (path.isAbsolute(childKey) && hiddenPaths.has(normalizeTrackedFilePath(childKey))) markHidden(value, childKey); else collect(child, value, childKey, ancestors); } } catch (_) { markHidden(parent, key); } finally { ancestors.delete(value); } }; for (const [key, value] of Object.entries(project)) collect(value, project, key, new Set());
  for (const entry of records) { const families = getScopedRecordFamilies(entry.item); if ((project.files || []).includes(entry.item) || (project.pendingFiles || []).includes(entry.item)) { const family = getScopedFileAppFamily(project, entry.item); if (family) families.add(family); } const info = { families, primaryPath: scopedRecordPrimaryPath(entry.item, entry.key, nodePaths, ledgerPaths), authorized: false, entry }; infos.push(info); infoByObject.set(entry.item, info); } const allowedPaths = new Set(scopeAllowedPaths); for (const info of infos) if (!stalePendingFiles.has(info.entry.item) && hiddenPaths.has(info.primaryPath) && !info.families.has('illustrator') && (info.families.size || isExplicitUserCapturedFile(info.entry.item))) allowedPaths.add(info.primaryPath); for (const info of infos) info.authorized = !stalePendingFiles.has(info.entry.item) && allowedPaths.has(info.primaryPath) && ((scopeAllowedPaths.has(info.primaryPath) && info.families.size === 1 && info.families.has('illustrator')) || (!info.families.has('illustrator') && info.families.size > 0) || isExplicitUserCapturedFile(info.entry.item) || (info.entry.item.type === NODE_TYPES.FILE && info.families.size === 0));
  const hiddenIds = new Set(); let changed = true; while (changed) { changed = false; for (const info of infos) { const { entry } = info; if (isHidden(entry.parent, entry.key)) continue; const identities = scopedRecordIdentities(entry), keyHidden = typeof entry.key === 'string' && (hiddenIds.has(entry.key) || (path.isAbsolute(entry.key) && hiddenPaths.has(normalizeTrackedFilePath(entry.key)))), deniedPrimary = hiddenPaths.has(info.primaryPath) && !info.authorized; if (!keyHidden && !deniedPrimary && !identities.some(id => hiddenIds.has(id)) && !scopedRecordReferencesHidden(entry.item, info, hiddenPaths, hiddenIds, nodePaths)) continue; changed = markHidden(entry.parent, entry.key) || changed; for (const id of [...identities, ...(entry.item.evidenceIds || [])]) if (typeof id === 'string' && !hiddenIds.has(id)) { hiddenIds.add(id); changed = true; } } }
  const OMIT = Symbol('scoped-omit'); let filteredCount = 0; const filter = (value, parent = null, key = '', ancestors = new Set(), owner = null) => { if (parent && (isHidden(parent, key) || hiddenIds.has(key) || (path.isAbsolute(key) && hiddenPaths.has(normalizeTrackedFilePath(key))))) return OMIT; if (typeof value === 'string') { if (hiddenIds.has(value)) return OMIT; const nodePath = /NodeId$/i.test(key) ? nodePaths.get(value) : null, normalized = (path.isAbsolute(value) || /paths?$/i.test(key)) ? normalizeTrackedFilePath(value) : null, deniedPath = nodePath || (normalized && hiddenPaths.has(normalized) ? normalized : null); return deniedPath && !(owner?.authorized && owner.primaryPath === deniedPath) ? OMIT : value; } if (!Array.isArray(value) && !isRecord(value)) return value; if (++filteredCount > 50000 || ancestors.has(value)) return OMIT; const nextOwner = infoByObject.get(value) || owner, output = Array.isArray(value) ? [] : {}; ancestors.add(value); try { for (const [childKey, child] of Object.entries(value)) { const filtered = filter(child, value, childKey, ancestors, nextOwner); if (filtered !== OMIT) Array.isArray(output) ? output.push(filtered) : output[childKey] = filtered; } return output; } catch (_) { return OMIT; } finally { ancestors.delete(value); } }; const view = filter(project); return view === OMIT ? null : view; }
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
  const activationScope = getIllustratorActivationScope(projectId);
  const relevanceFor = entry => activationScope ? (activationScope.admittedDocumentPaths.has(normalizeTrackedFilePath(entry && entry.documentPath)) ? { relevant: true, reason: 'activation-admitted-document' } : { relevant: false, reason: 'activation-excluded-document' }) : classifyIllustratorDocumentSessionRelevance(entry, scope);
  for (const doc of (activeState && activeState.documents) || []) {
    const relevance = relevanceFor(doc);
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
      appFamily: 'illustrator',
      observerMethod: LIVE_APP_OBSERVER_METHODS.ILLUSTRATOR_ACTIVE_SESSION,
      sourceDocumentPath: doc.documentPath,
      sourceDocumentName: doc.documentName || path.basename(doc.documentPath),
      documentModified: doc.modified,
      evidenceStrength: LIVE_APP_EVIDENCE_STRENGTHS.STRUCTURED_APP_DOCUMENT,
      requiresSave: !saved,
      savedEvidence: saved,
      filesystemSaved: saved,
      allowDirect: saved,
      forcePending: !saved,
      evidenceReason: saved ? 'illustrator-saved-document' : 'app-live-evidence',
    }));
  }
  for (const link of (activeState && activeState.links) || []) {
    const relevance = relevanceFor(link);
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

async function isIllustratorRunningForLiveEvidence(projectId = null, activationToken = null) {
  const stillCurrent = () => projectId === null || !!getFreshActiveWatchingProject(projectId, activationToken);
  const pgrep = await execFileAsync('/usr/bin/pgrep', ['-x', 'Adobe Illustrator'], {
    timeout: 3000,
    encoding: 'utf8',
  }).catch(() => ({ stdout: '' }));
  if (!stillCurrent()) return null;
  if (pgrep.stdout && pgrep.stdout.trim()) return true;

  const ps = await execFileAsync('/bin/ps', ['ax', '-o', 'comm='], {
    timeout: 3000,
    encoding: 'utf8',
  }).catch(() => ({ stdout: '', failed: true }));
  if (!stillCurrent()) return null;
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
  }).catch(() => ({ stdout: '', failed: true }));
  if (!stillCurrent()) return null;
  if (ps.failed && psCommand.failed) return 'failed';
  return String(psCommand.stdout || '')
    .split('\n')
    .some(line => {
      const commandText = line.trim();
      if (!commandText) return false;
      if (/^Adobe Illustrator(?:\s|$)/i.test(commandText)) return true;
      return /\/(?:adobe )?illustrator(?: \d{4})?\.app\/contents\/macos\/(?:adobe )?illustrator(?:\s|$)/i.test(commandText);
    });
}

async function queryIllustratorActiveState(projectId, activationToken) {
  const running = await isIllustratorRunningForLiveEvidence(projectId, activationToken); if (running === null || !getFreshActiveWatchingProject(projectId, activationToken)) return { stale: true };
  if (running === 'failed') return { running: true, errorCategory: 'illustrator-query-failed', activeState: parseIllustratorActiveSessionOutput('') };
  if (!running) return { running: false, activeState: parseIllustratorActiveSessionOutput('STATUS\tno-documents\nCOMPLETE\t0\t0') };
  try { const { stdout } = await runOsascriptInPrivateTemp(() => ({ 'crate-ai-active-session.applescript': AI_ACTIVE_SESSION_APPLESCRIPT }), 'crate-ai-active-session.applescript', { timeout: 10000, encoding: 'utf8' });
    if (!getFreshActiveWatchingProject(projectId, activationToken)) return { stale: true }; return { running: true, outputEmpty: !String(stdout || '').trim(), activeState: parseIllustratorActiveSessionOutput(stdout) }; }
  catch (error) { if (!getFreshActiveWatchingProject(projectId, activationToken)) return { stale: true }; logLiveAppEvidenceUnavailable('Illustrator', error); return { running: true, errorCategory: getSafeLiveAppUnavailableReason(error), activeState: parseIllustratorActiveSessionOutput('') }; }
}
async function initializeIllustratorActivationScope(projectId, activationToken) {
  const queryResult = await queryIllustratorActiveState(projectId, activationToken); if (queryResult.stale || !getFreshActiveWatchingProject(projectId, activationToken)) return null;
  const updated = updateIllustratorActivationScope(projectId, activationToken, queryResult, true); if (!updated || !updated.ready) return updated;
  applyLiveAppEvidenceRefresh(projectId, createIllustratorLiveEvidenceRecords(projectId, queryResult.activeState, updated.project), activationToken); return updated;
}
function admitIllustratorSourcesForProject(projectId, filePaths) {
  const activationToken = getActiveWatchingActivationToken(projectId), scope = getIllustratorActivationScope(projectId, activationToken); if (!scope || !getFreshActiveWatchingProject(projectId, activationToken)) return;
  const revised = reviseIllustratorActivationScope(projectId, scope, next => {
    if (next.status === 'failed-closed') next.status = 'recovering-explicit'; for (const documentPath of (filePaths || []).map(normalizeTrackedFilePath).filter(Boolean)) { next.admittedDocumentPaths.add(documentPath); next.baselineDocumentPaths.delete(documentPath); }
  });
  if (revised && revised.status === 'ready') pollPsForProjectCore(projectId, activationToken, null);
  return revised;
}
function admitIllustratorRelationshipPathsForProject(projectId, sourcePath, linkedPaths) {
  const activationToken = getActiveWatchingActivationToken(projectId);
  const scope = getIllustratorActivationScope(projectId, activationToken);
  const project = getFreshActiveWatchingProject(projectId, activationToken);
  const normalizedSourcePath = normalizeTrackedFilePath(sourcePath);
  if (!scope || !project || !normalizedSourcePath) return scope;
  const sourceAccepted = (project.files || []).some(file => (
    normalizeTrackedFilePath(file && file.path) === normalizedSourcePath &&
    (
      isAcceptedIllustratorProjectFile(project, file) ||
      (ILLUSTRATOR_SOURCE_EXTENSIONS.has((file.ext || path.extname(file.path || '')).toLowerCase()) &&
        (isAcceptedPendingCapturedFile(project, file) ||
          (scope.status === 'ready' && isCurrentSessionSavedSource(project, file))))
    )
  ));
  if (!scope.admittedDocumentPaths.has(normalizedSourcePath) && !sourceAccepted) return scope;
  return reviseIllustratorActivationScope(projectId, scope, next => {
    next.admittedDocumentPaths.add(normalizedSourcePath);
    next.baselineDocumentPaths.delete(normalizedSourcePath);
    for (const linkedPath of (linkedPaths || []).map(normalizeTrackedFilePath).filter(Boolean)) {
      next.allowedLinkedPaths.add(linkedPath);
      next.excludedLinkedPaths.delete(linkedPath);
    }
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

function applyLiveAppEvidenceRefresh(projectId, liveEvidenceRecords = [], activationToken = null) {
  if (!isBoundWatchingActivationCurrent(projectId, activationToken)) {
    return { changed: false, stagedCount: 0, skipped: {} };
  }
  const { candidates, skipped } = collectLiveAppEvidenceCandidates(liveEvidenceRecords);
  const skipSummary = formatLiveAppSkipCounts(skipped);
  if (skipSummary) {
    logLiveAppDiagnostic(projectId, 'candidate-skips', `candidate skip counts for project ${projectId}: ${skipSummary}`);
  }
  if (candidates.length === 0) return { changed: false, stagedCount: 0, skipped };

  const result = mutateProject(projectId, (proj) => {
    if (proj.status !== 'watching' || !isBoundWatchingActivationCurrent(projectId, activationToken)) return null;
    let changed = false;
    let evidenceChanged = false;
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
        appFamily: evidence.appFamily,
        savedEvidence: evidence.savedEvidence === true,
        filesystemSaved: evidence.filesystemSaved === true,
        parserConfirmed: evidence.parserConfirmed === true,
        reason: evidence.evidenceReason || 'app-script-broad-observer',
        relationshipSourcePath: evidence.relationshipSourcePath,
        liveEvidence: evidence,
      });
      if (staged.evidenceChanged) {
        evidenceChanged = true;
        changed = true;
      }
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
              appFamily: evidence.appFamily,
            },
          });
        }
      }
    }

    return {
      changed,
      evidenceChanged,
      stagedCount,
      stagedStates: Array.from(stagedStates.entries()),
      stagedByApp: Array.from(stagedByApp.entries()),
      files: proj.files,
      pendingFiles: proj.pendingFiles || [],
    };
  }, { persistIfChanged: true, trustResultChanged: true });

  if (!result || (result.stagedCount === 0 && result.evidenceChanged !== true)) {
    return { changed: false, stagedCount: 0, skipped };
  }

  if (result.stagedCount > 0) {
    lastFileActivity.set(projectId, Date.now());
    inactivityNotified.delete(projectId);
  }

  if (result.stagedCount > 0) sendProjectFileStateToRenderer(projectId, activationToken);

  return result;
}

const INDD_APPLESCRIPT = `tell application "Adobe InDesign"
  set rowList to {}
  try
    set documentCount to 0
    set expectedLinkCount to 0
    set emittedLinkCount to 0
    set queryErrorCount to 0
    repeat with aDoc in every document
      set documentCount to documentCount + 1
      set docName to ""
      set docPathText to ""
      set docModified to false
      set docCurrent to false
      set documentLinkCount to 0
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
      try
        set documentLinkCount to count of every link of aDoc
      on error
        set queryErrorCount to queryErrorCount + 1
      end try
      set expectedLinkCount to expectedLinkCount + documentLinkCount
      set end of rowList to "DOC" & tab & docPathText & tab & docName & tab & (docModified as text) & tab & (docCurrent as text) & tab & (documentLinkCount as text)
      repeat with aLink in every link of aDoc
        try
          set fp to file path of aLink
          if fp is not missing value then
            set linkPathText to POSIX path of (fp as alias)
            set end of rowList to "LINK" & tab & docPathText & tab & docName & tab & linkPathText & tab & (docModified as text) & tab & (docCurrent as text)
            set emittedLinkCount to emittedLinkCount + 1
          else
            set queryErrorCount to queryErrorCount + 1
          end if
        on error
          set queryErrorCount to queryErrorCount + 1
        end try
      end repeat
    end repeat
  on error
    set rowList to {"ERROR" & tab & "query-failed"}
    set documentCount to 0
    set expectedLinkCount to 0
    set emittedLinkCount to 0
    set queryErrorCount to 1
  end try
  set end of rowList to "END" & tab & (documentCount as text) & tab & (expectedLinkCount as text) & tab & (emittedLinkCount as text) & tab & (queryErrorCount as text)
  set AppleScript's text item delimiters to linefeed
  return rowList as text
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

async function parseDependableInDesignBaselineSnapshot(output, selectedSourcePath, options = {}) {
  const rows = String(output || '').split('\n').map(line => line.trim()).filter(Boolean);
  const documents = new Map();
  const linkCountsByDocument = new Map();
  let terminal = null;

  const parseCount = value => (/^\d+$/.test(value || '') ? Number(value) : null);
  const isBooleanText = value => value === 'true' || value === 'false';

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    if (!isAddFilesParserCurrent(options)) throw new Error('asset_baseline_indesign_snapshot_cancelled');
    if (rowIndex > 0 && rowIndex % 256 === 0) await new Promise(resolve => setImmediate(resolve));
    const line = rows[rowIndex];
    if (terminal) throw new Error('asset_baseline_indesign_snapshot_incomplete');
    const parts = line.split('\t');
    if (parts[0] === 'DOC') {
      const documentPath = normalizeTrackedFilePath(parts[1]);
      const expectedLinks = parseCount(parts[5]);
      if (
        parts.length !== 6 ||
        !documentPath ||
        !isBooleanText(parts[3]) ||
        !isBooleanText(parts[4]) ||
        expectedLinks === null ||
        documents.has(documentPath)
      ) {
        throw new Error('asset_baseline_indesign_snapshot_incomplete');
      }
      documents.set(documentPath, expectedLinks);
      continue;
    }
    if (parts[0] === 'LINK') {
      const documentPath = normalizeTrackedFilePath(parts[1]);
      if (
        parts.length !== 6 ||
        !documentPath ||
        !normalizeTrackedFilePath(parts[3]) ||
        !isBooleanText(parts[4]) ||
        !isBooleanText(parts[5])
      ) {
        throw new Error('asset_baseline_indesign_snapshot_incomplete');
      }
      linkCountsByDocument.set(documentPath, (linkCountsByDocument.get(documentPath) || 0) + 1);
      continue;
    }
    if (parts[0] === 'END') {
      if (parts.length !== 5 || terminal) {
        throw new Error('asset_baseline_indesign_snapshot_incomplete');
      }
      const counts = parts.slice(1).map(parseCount);
      if (counts.some(value => value === null)) {
        throw new Error('asset_baseline_indesign_snapshot_incomplete');
      }
      terminal = {
        documentCount: counts[0],
        expectedLinkCount: counts[1],
        emittedLinkCount: counts[2],
        queryErrorCount: counts[3],
      };
      continue;
    }
    throw new Error('asset_baseline_indesign_snapshot_incomplete');
  }

  const expectedLinkCount = [...documents.values()].reduce((total, count) => total + count, 0);
  const emittedLinkCount = [...linkCountsByDocument.values()].reduce((total, count) => total + count, 0);
  const complete = terminal &&
    terminal.queryErrorCount === 0 &&
    terminal.documentCount === documents.size &&
    terminal.expectedLinkCount === expectedLinkCount &&
    terminal.emittedLinkCount === emittedLinkCount &&
    expectedLinkCount === emittedLinkCount &&
    [...documents].every(([documentPath, expectedLinks]) => (
      (linkCountsByDocument.get(documentPath) || 0) === expectedLinks
    )) &&
    documents.has(selectedSourcePath) &&
    [...linkCountsByDocument.keys()].every(documentPath => documents.has(documentPath));
  if (!complete) throw new Error('asset_baseline_indesign_snapshot_incomplete');

  return parseInDesignActiveSessionOutput(output);
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
 * Fires every 10 seconds; skips silently if no supported local app is running.
 */
async function pollPsForProjectCore(projectId, activationToken = null, watcherGeneration = null) {
  if (psInProgress.has(projectId)) return;

  const currentProjects = getProjects();
  const project = currentProjects.find(p => p.id === projectId);
  if (!project) return;
  if (!isActiveWatchingProject(projectId, activationToken)) {
    if (activationToken !== null) return;
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
    const illustratorQuery = await queryIllustratorActiveState(projectId, activationToken);
    if (illustratorQuery.stale || !getFreshActiveWatchingProject(projectId, activationToken)) return;
    const illustratorRunning = illustratorQuery.running;
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
        const aiOutputEmpty = illustratorQuery.outputEmpty === true;
        if (aiOutputEmpty) {
          logLiveAppDiagnostic(projectId, 'illustrator-empty-output', `Illustrator returned no structured live evidence for project ${projectId}; check Automation permissions if this persists`);
        }
        const activeState = illustratorQuery.activeState;
        for (const safeReason of activeState.errors || []) {
          logLiveAppEvidenceUnavailable('Illustrator', new Error(safeReason));
        }
        const illustratorDiagnostics = { skipped: {} };
        const scopeResult = updateIllustratorActivationScope(projectId, activationToken, illustratorQuery, false);
        const illustratorRecords = scopeResult && scopeResult.ready
          ? createIllustratorLiveEvidenceRecords(projectId, activeState, scopeResult.project, illustratorDiagnostics)
          : [];
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
        const scriptSuccess = !!(scopeResult && scopeResult.ready);
        const scriptStatusCategory = illustratorQuery.errorCategory || (aiOutputEmpty
          ? 'empty-output'
          : normalizeLiveAppStatusErrorCategory(safeStatusReasons[0], null));
        const scriptErrorCategory = scriptSuccess && isIllustratorDirectPathFallbackRecovery(safeStatusReasons)
          ? null
          : scriptStatusCategory;
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
    if (!getFreshActiveWatchingProject(projectId, activationToken)) return;

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
        if (!getFreshActiveWatchingProject(projectId, activationToken)) return;
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
        if (!getFreshActiveWatchingProject(projectId, activationToken)) return;
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
    if (!getFreshActiveWatchingProject(projectId, activationToken)) return;

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
        if (!getFreshActiveWatchingProject(projectId, activationToken)) return;
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
        if (!getFreshActiveWatchingProject(projectId, activationToken)) return;
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

    if (
      liveEvidenceRecords.length === 0 ||
      !isActiveWatchingProject(projectId, activationToken) ||
      (watcherGeneration !== null && !getWatcherCoordinator(projectId).isCurrent(projectId, watcherGeneration))
    ) return;

    const refreshResult = applyLiveAppEvidenceRefresh(projectId, liveEvidenceRecords, activationToken);
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
    if (activationToken !== null && !getFreshActiveWatchingProject(projectId, activationToken)) return;
    console.error('[crate][live-app] pollPsForProject error:', redactFigmaLogText(e && e.message));
  } finally {
    if (activationToken === null || watchingActivationTokens.get(projectId) === activationToken) psInProgress.delete(projectId);
  }
}

async function pollPsForProject(projectId, activationToken = null) {
  return runBackgroundWatcherOperation(projectId, 'live-app', (watcherGeneration) => (
    pollPsForProjectCore(projectId, activationToken, watcherGeneration)
  ));
}

/**
 * Start live app evidence refresh for a project.
 */
function startPsPolling(projectId, activationToken = null) {
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
    return pollPsForProject(projectId, activationToken);
  }, PS_POLL_INTERVAL_MS);
  psPollers.set(projectId, intervalId);

  scheduleWatcherStartupTimer(projectId, 'live-app', LIVE_APP_INITIAL_REFRESH_DELAY_MS, () => {
    pollPsForProject(projectId, activationToken).finally(() => {
      psPollerStarting.delete(projectId);
    });
  });
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

async function pollLastUsedForProjectCore(projectId, activationToken = null, watcherGeneration = null) {
  try {
  const projects = getProjects();
  const project = projects.find(p => p.id === projectId);
  if (!project || !isActiveWatchingProject(projectId, activationToken)) return;
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

  if (
    newFiles.length === 0 ||
    !isActiveWatchingProject(projectId, activationToken) ||
    (watcherGeneration !== null && !getWatcherCoordinator(projectId).isCurrent(projectId, watcherGeneration))
  ) return;

  const result = mutateProject(projectId, (proj) => {
    if (!isActiveWatchingProject(projectId, activationToken)) return null;
    const acceptedFiles = [];
    let added = 0;
    for (const f of newFiles) {
      const staged = stageLiveObservedFile(proj, f, {
        forcePending: true,
        appFamily: 'generic',
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
    return { changed: true, files: proj.files, pendingFiles: proj.pendingFiles || [] };
  }, { persistIfChanged: true, trustResultChanged: true });

  if (result) sendProjectFileStateToRenderer(projectId, activationToken);
  } catch (e) {
    console.error('[crate][lastused-poll] pollLastUsedForProject error:', e.message);
  }
}

async function pollLastUsedForProject(projectId, activationToken = null) {
  return runBackgroundWatcherOperation(projectId, 'last-used', (watcherGeneration) => (
    pollLastUsedForProjectCore(projectId, activationToken, watcherGeneration)
  ));
}

function startLastUsedPolling(projectId, activationToken = null) {
  if (lastUsedPollers.has(projectId)) return;
  scheduleWatcherStartupTimer(projectId, 'last-used', 10000, () => pollLastUsedForProject(projectId, activationToken)); // v2.4.8: 10s delay — ensures watchStartedAt is written before first poll
  const intervalId = setInterval(() => pollLastUsedForProject(projectId, activationToken), LAST_USED_POLL_MS);
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

const STRICT_ZIP_ASSET_BASELINE_EXTENSIONS = new Set([
  '.idml', '.sketch', '.afdesign', '.afphoto', '.afpub',
  '.key', '.pptx', '.pxd', '.xd',
]);

function runAddFilesPsdWorker(filePath, attempt) {
  if (!utilityProcess || typeof utilityProcess.fork !== 'function') {
    return Promise.reject(new Error('asset_baseline_psd_worker_unavailable'));
  }
  return new Promise((resolve, reject) => {
    let child = null;
    let settled = false;
    let removeCancelListener = () => {};
    const stop = () => {
      try { child?.kill(); } catch (_) {}
    };
    const finish = (error, result = null) => {
      if (settled) return;
      settled = true;
      removeCancelListener();
      stop();
      if (error) reject(error);
      else resolve(result);
    };
    try {
      child = utilityProcess.fork(ADD_FILES_PSD_WORKER_PATH, [], {
        cwd: path.dirname(ADD_FILES_PSD_WORKER_PATH),
        env: {},
        execArgv: [],
        stdio: 'ignore',
        serviceName: 'Crate Add Files PSD Scan',
        allowLoadingUnsignedLibraries: false,
        disclaim: false,
      });
      child.once('error', error => finish(error));
      child.once('exit', code => {
        if (!settled && code !== 0) finish(new Error('asset_baseline_psd_worker_exited'));
      });
      child.on('message', message => {
        if (!message || typeof message !== 'object') return finish(new Error('asset_baseline_psd_worker_invalid_result'));
        if (message.type === 'error') return finish(new Error(message.error || 'asset_baseline_psd_worker_failed'));
        if (message.type !== 'result' || !message.result || !Array.isArray(message.result.entries)) {
          return finish(new Error('asset_baseline_psd_worker_invalid_result'));
        }
        finish(null, message.result);
      });
      removeCancelListener = attempt?.onCancel?.(() => finish(new Error('asset_baseline_psd_worker_cancelled'))) || (() => {});
      child.postMessage({ type: 'parse', filePath });
    } catch (error) {
      finish(error);
    }
  });
}

function getAddFilesSourceIdentity(stat) {
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    dev: stat.dev,
    ino: stat.ino,
  };
}

function getAddFilesSourceDigest(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function getAddFilesCurrentSourceDigest(filePath, attempt) {
  if (attempt && typeof attempt.isCurrent === 'function' && !attempt.isCurrent()) {
    throw new Error('add_files_parser_cancelled');
  }
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    let settled = false;
    let removeCancelListener = () => {};
    const settle = (error, digest) => {
      if (settled) return;
      settled = true;
      removeCancelListener();
      if (error) reject(error);
      else resolve(digest);
    };
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', error => settle(error));
    stream.on('end', () => settle(null, hash.digest('hex')));
    if (attempt && typeof attempt.onCancel === 'function') {
      removeCancelListener = attempt.onCancel(reason => {
        stream.destroy();
        settle(new Error(`add_files_parser_cancelled:${reason || 'cancelled'}`));
      });
    }
  });
}

function isAddFilesSourceIdentityCurrent(stat, identity) {
  return !!stat && !!identity &&
    stat.size === identity.size &&
    stat.mtimeMs === identity.mtimeMs &&
    stat.dev === identity.dev &&
    stat.ino === identity.ino;
}

async function assertDependableAssetBaselineSource(filePath, options = {}) {
  const stat = await fs.promises.stat(filePath);
  if (!isAddFilesParserCurrent(options)) throw new Error('add_files_parser_cancelled');
  if (!stat.isFile()) throw new Error('asset_baseline_source_not_file');
  if (stat.size > MAX_PARSE_FILE_SIZE) throw new Error('asset_baseline_source_too_large');
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.ai' || ext === '.pdf') {
    const sourceBuffer = await readFileWithAddFilesCancellation(filePath, options.addFilesAttempt, stat.size);
    if (!isAddFilesParserCurrent(options)) throw new Error('add_files_parser_cancelled');
    const afterReadStat = await fs.promises.stat(filePath);
    if (!isAddFilesSourceIdentityCurrent(afterReadStat, getAddFilesSourceIdentity(stat))) {
      throw new Error('asset_baseline_source_changed');
    }
    const headerText = sourceBuffer.subarray(0, Math.min(sourceBuffer.length, 1024)).toString('latin1');
    const trailerText = sourceBuffer.subarray(Math.max(0, sourceBuffer.length - 2048)).toString('latin1');
    const pdfHeaderPattern = /(?:^|[\r\n])%PDF-(?:1\.[0-7]|2\.0)(?:\r\n|\r|\n)/;
    const postscriptHeaderPattern = /(?:^|[\r\n])%!PS-Adobe-(?:2\.0|3\.0)(?:\r\n|\r|\n)/;
    const validHeader = ext === '.pdf'
      ? pdfHeaderPattern.test(headerText)
      : (pdfHeaderPattern.test(headerText) || postscriptHeaderPattern.test(headerText));
    const validTrailer = /(?:^|[\r\n])%%EOF[\t\f ]*(?:[\x00\t\f\r\n ]*)$/.test(trailerText);
    if (!validHeader || !validTrailer) {
      throw new Error('asset_baseline_source_invalid_structure');
    }
    return {
      kind: 'source-buffer',
      buffer: sourceBuffer,
      sourceIdentity: getAddFilesSourceIdentity(stat),
      sourceDigest: getAddFilesSourceDigest(sourceBuffer),
    };
  }

  const handle = await fs.promises.open(filePath, 'r');
  try {
    await handle.stat();
  } finally {
    await handle.close();
  }

  if (ext === '.psd') {
    if (options.addFilesAttempt) {
      const beforeWorkerIdentity = getAddFilesSourceIdentity(stat);
      const workerResult = await runAddFilesPsdWorker(filePath, options.addFilesAttempt);
      const afterWorkerStat = await fs.promises.stat(filePath);
      if (!isAddFilesSourceIdentityCurrent(afterWorkerStat, beforeWorkerIdentity)) {
        throw new Error('asset_baseline_source_changed');
      }
      return {
        kind: 'psd-worker-result',
        result: workerResult,
        sourceIdentity: beforeWorkerIdentity,
        sourceDigest: workerResult.sourceDigest,
      };
    }
    const buffer = await fs.promises.readFile(filePath);
    readPsd(buffer, { skipLayerImageData: true, skipCompositeImageData: true });
  } else if (STRICT_ZIP_ASSET_BASELINE_EXTENSIONS.has(ext)) {
    await runCancellableExecFile('/usr/bin/unzip', ['-tqq', filePath], {
      timeout: 10000,
      encoding: 'utf8',
      ...options,
    });
    if (!isAddFilesParserCurrent(options)) throw new Error('add_files_parser_cancelled');
  }
  const sourceDigest = await getAddFilesCurrentSourceDigest(filePath, options.addFilesAttempt);
  if (!isAddFilesParserCurrent(options)) throw new Error('add_files_parser_cancelled');
  return {
    kind: 'validated-source',
    sourceIdentity: getAddFilesSourceIdentity(stat),
    sourceDigest,
  };
}

/**
 * Extract linked/embedded asset paths from a design file.
 * Routes to per-format extractors. Returns array of absolute file paths.
 * All I/O is async — never blocks the main process.
 */
async function extractLinkedAssets(filePath, options = {}) {
  const strict = options.strict === true;
  const extractorOptions = {
    strict,
    sourceBuffer: options.sourceBuffer,
    validatedPsdResult: options.validatedPsdResult,
    quiet: options.quiet,
    isCurrent: options.isCurrent,
    addFilesAttempt: options.addFilesAttempt,
  };
  const ext = path.extname(filePath).toLowerCase();
  try {
    switch (ext) {
      case '.ai':
      case '.pdf':
      case '.xd':
        return await extractLinkedAssetsRegex(filePath, extractorOptions);
      case '.psd':
        return await extractLinkedAssetsPhotoshop(filePath, extractorOptions);
      case '.indd':
      case '.idml':
        return await extractLinkedAssetsInDesign(filePath, extractorOptions);
      case '.sketch':
        return await extractLinkedAssetsSketch(filePath, extractorOptions);
      case '.afdesign':
      case '.afphoto':
      case '.afpub':
        return await extractLinkedAssetsAffinity(filePath, extractorOptions);
      case '.key':
      case '.pptx':
        return await extractLinkedAssetsZipMedia(filePath, extractorOptions);
      case '.ppt':
        return await extractLinkedAssetsRegex(filePath, extractorOptions);
      case '.pxd':
        return await extractLinkedAssetsPxd(filePath, extractorOptions);
      case '.fig':
        return await extractLinkedAssetsRegex(filePath, extractorOptions);
      default:
        return [];
    }
  } catch (e) {
    if (!options.quiet) console.error(`[crate] scan-on-open: extractLinkedAssets error for ${path.basename(filePath)}:`, e.message);
    if (strict) throw e;
    return [];
  }
}

/**
 * Regex-based extractor: reads binary file as UTF-8 and greps for absolute paths.
 * Works for .ai, .psd, .pdf, .xd, .fig, .indd (binary InDesign).
 */
async function extractLinkedAssetsRegex(filePath, options = {}) {
  const strict = options.strict === true;
  const LINKED_ASSET_REGEX = /(?:\/Users\/|\/Volumes\/)[^\x00-\x1f\x22\x27]+?\.(jpg|jpeg|png|gif|webp|svg|pdf|eps|ai|psd|tiff|tif|afdesign|afphoto|afpub|indd|idml|sketch|fig|heic|ttf|otf|woff|woff2|mp4|mov|avi|webm)/gi;
    const results = [];
    const seenResults = new Set();
  try {
    const suppliedBuffer = Buffer.isBuffer(options.sourceBuffer) ? options.sourceBuffer : null;
    if (!suppliedBuffer) {
      // Guard: skip files larger than MAX_PARSE_FILE_SIZE to prevent OOM.
      const stat = await fs.promises.stat(filePath);
      if (stat.size > MAX_PARSE_FILE_SIZE) {
        if (strict) throw new Error('asset_baseline_source_too_large');
        console.warn(`[crate] extractLinkedAssetsRegex: skipping ${path.basename(filePath)} (${Math.round(stat.size / 1024 / 1024)}MB exceeds ${MAX_PARSE_FILE_SIZE / 1024 / 1024}MB limit)`);
        return results;
      }
    }
    const buf = suppliedBuffer || await readFileWithAddFilesCancellation(filePath, options.addFilesAttempt);
    const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true;
    const chunkBytes = 1024 * 1024;
    const carryBytes = 32 * 1024;
    const yieldBytes = 1024 * 1024;
    let bytesSinceYield = 0;
    const decoder = new StringDecoder('utf8');
    let carry = '';
    for (let offset = 0; offset < buf.length; offset += chunkBytes) {
      if (!isCurrent()) return [];
      const content = carry + decoder.write(buf.subarray(offset, offset + chunkBytes));
      LINKED_ASSET_REGEX.lastIndex = 0;
      let match;
      while ((match = LINKED_ASSET_REGEX.exec(content)) !== null) {
        const linkedPath = match[0];
        if (linkedPath !== filePath) {
          const resultKey = normalizeTrackedFilePath(linkedPath) || linkedPath;
          if (!seenResults.has(resultKey)) {
            seenResults.add(resultKey);
            results.push(linkedPath);
          }
        }
      }
      carry = content.slice(-carryBytes);
      bytesSinceYield += Math.min(chunkBytes, buf.length - offset);
      if (bytesSinceYield >= yieldBytes) {
        bytesSinceYield = 0;
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    decoder.end();
    if (!isCurrent()) return [];
  } catch (e) {
    if (strict) throw e;
  }
  return results;
}

async function collectRegexMatchesCooperatively(content, regex, options = {}) {
  const matches = [];
  const text = String(content || '');
  const isCurrent = () => isAddFilesParserCurrent(options);
  const chunkChars = 1024 * 1024;
  const carryChars = 32 * 1024;
  const yieldChars = 1024 * 1024;
  let carry = '';
  let charsSinceYield = 0;
  for (let offset = 0; offset < text.length; offset += chunkChars) {
    if (!isCurrent()) return null;
    const chunk = carry + text.slice(offset, offset + chunkChars);
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(chunk)) !== null) matches.push(match);
    carry = chunk.slice(-carryChars);
    charsSinceYield += Math.min(chunkChars, text.length - offset);
    if (charsSinceYield >= yieldChars) {
      charsSinceYield = 0;
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  return isCurrent() ? matches : null;
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
async function extractLinkedAssetsPhotoshop(filePath, options = {}) {
  // A dependable first scan must be scoped to this PSD. The live Photoshop
  // script reports links from every open document, so baseline discovery
  // delegates to the file-scoped ag-psd pass below instead.
  if (options.strict === true) return [];

  try {
    // Check if Photoshop is running
    const { stdout: psCheck } = await runCancellableExec(
      "/bin/ps ax -o command= 2>/dev/null | grep -i 'Adobe Photoshop' | grep -v grep",
      { timeout: 3000, encoding: 'utf8', addFilesAttempt: options.addFilesAttempt }
    ).catch(() => ({ stdout: '' }));

    if (psCheck.trim()) {
      // v2.3.4: do javascript — exposes embedded smart object paths
      const { stdout: psPaths } = await runOsascriptInPrivateTemp(
        ({ resolveScriptPath }) => ({
          'crate-ps-scan.js': PS_DOJAVASCRIPT,
          'crate-ps-scan.applescript': psDoJavascriptAS(resolveScriptPath('crate-ps-scan.js')),
        }),
        'crate-ps-scan.applescript',
        { timeout: 10000, encoding: 'utf8', addFilesAttempt: options.addFilesAttempt }
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
  return extractLinkedAssetsRegex(filePath, options);
}

/**
 * v2.3.6: PSD binary parser using ag-psd.
 * Extracts linked file paths from layers (layer.linkedFile.fullPath) and
 * embedded smart object data from psd.linkedFiles (written to temp dir).
 * Complements the AppleScript/do-javascript approach — works even when
 * Photoshop is not running.
 */
async function extractPsdAssets(psdFilePath, projectId, isCurrent = () => true, options = {}) { const invocationFiles = []; let keepInvocationFiles = false; let invocationFilesReleased = false;
  const releaseInvocationFiles = () => {
    if (invocationFilesReleased) return;
    invocationFilesReleased = true;
    for (const staged of invocationFiles) for (const cleanupPath of [staged.stagedPath, ...(staged.committed ? [staged.extractPath] : [])]) {
      try {
        const stat = fs.lstatSync(cleanupPath);
        const owned = !staged.identity || (stat.dev === staged.identity.dev && stat.ino === staged.identity.ino);
        if (isDirectCacheChild(staged.extractDir, cleanupPath) && owned && !stat.isSymbolicLink() && stat.isFile()) fs.unlinkSync(cleanupPath);
      } catch (_) {}
    }
  };
  try {
    // Guard: skip files larger than MAX_PARSE_FILE_SIZE to prevent OOM
    const stat = await fs.promises.stat(psdFilePath);
    if (!isCurrent()) return [];
    if (stat.size > MAX_PARSE_FILE_SIZE) {
      if (options.strict === true) throw new Error('asset_baseline_source_too_large');
      if (!options.quiet) console.warn(`[crate][psd-parser] Skipping ${path.basename(psdFilePath)} (${Math.round(stat.size / 1024 / 1024)}MB exceeds ${MAX_PARSE_FILE_SIZE / 1024 / 1024}MB limit)`);
      return [];
    }
    let psd = null;
    let workerResult = null;
    let sourceDigest = null;
    if (options.addFilesAttempt) {
      const validatedIdentity = options.validatedPsdSourceIdentity;
      if (options.validatedPsdResult && validatedIdentity && (
        stat.size !== validatedIdentity.size ||
        stat.mtimeMs !== validatedIdentity.mtimeMs ||
        stat.dev !== validatedIdentity.dev ||
        stat.ino !== validatedIdentity.ino
      )) {
        if (options.strict === true) throw new Error('asset_baseline_source_changed');
        return [];
      }
      workerResult = options.validatedPsdResult || await runAddFilesPsdWorker(psdFilePath, options.addFilesAttempt);
      sourceDigest = workerResult.sourceDigest || await getAddFilesCurrentSourceDigest(psdFilePath, options.addFilesAttempt);
    } else {
      const buf = await fs.promises.readFile(psdFilePath);
      if (!isCurrent()) return [];
      sourceDigest = getAddFilesSourceDigest(buf);
      psd = readPsd(buf, { skipLayerImageData: true, skipCompositeImageData: true });
    }
    if (!isCurrent()) return [];
    const discoveredPaths = [];

    // Walk layers for linkedFile.fullPath
    if (workerResult) {
      for (const entry of workerResult.entries) {
        if (!isCurrent()) return [];
        await new Promise(resolve => setImmediate(resolve));
        if (!isCurrent()) return [];
        if (typeof entry.filePath === 'string' && fs.existsSync(entry.filePath)) {
          discoveredPaths.push({ filePath: entry.filePath, source: 'psd-linked' });
        }
      }
    } else {
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
    }

    // Extract embedded files from psd.linkedFiles
    const linkedFiles = workerResult
      ? workerResult.embedded
      : (psd.linkedFiles || []);
    if (linkedFiles.length > 0) {
      const extractDir = path.join(os.tmpdir(), 'crate-psd-extract-' + projectId);
      if (!isCurrent()) return [];
      ensureSafeCacheDirectory(
        extractDir,
        'psd-extract-directory',
        OWNER_ONLY_DIR_MODE,
        safeRealpath(os.tmpdir(), 'psd-extract-parent')
      );
      if (!isCurrent()) return [];
      const usedEmbeddedNames = new Set((await fs.promises.readdir(extractDir)).map(name => name.toLowerCase())); for (const [embeddedIndex, lf] of linkedFiles.entries()) {
        if (!isCurrent()) return [];
        await new Promise(resolve => setImmediate(resolve));
        if (!lf.data) continue;
        const safeName = reserveUniqueName(lf.name, usedEmbeddedNames);
        const extractPath = path.join(extractDir, safeName);
        const embeddedData = typeof lf.data === 'string' ? Buffer.from(lf.data, 'base64') : Buffer.from(lf.data);
        const stagedPath = safeCacheTempPath(extractPath), staged = { stagedPath, extractPath, extractDir, embeddedOriginalName: lf.name || '', embeddedIndex, identity: null, committed: false }; invocationFiles.push(staged); await fs.promises.writeFile(stagedPath, embeddedData, { flag: 'wx', mode: OWNER_ONLY_FILE_MODE }); const stagedStat = fs.lstatSync(stagedPath); if (!isDirectCacheChild(extractDir, stagedPath) || stagedStat.isSymbolicLink() || !stagedStat.isFile() || stagedStat.nlink !== 1) throw cacheSafetyError('psd-extract-file', 'unsafe'); staged.identity = { dev: stagedStat.dev, ino: stagedStat.ino };
      }
      if (!isCurrent()) return [];
      for (const staged of invocationFiles) {
        if (!isCurrent()) return [];
        await new Promise(resolve => setImmediate(resolve));
        let linked = false;
        for (let attempt = 0; attempt < 100 && !linked; attempt++) {
          try {
            fs.linkSync(staged.stagedPath, staged.extractPath);
            linked = true;
          } catch (error) {
            if (!error || error.code !== 'EEXIST') throw error;
            const currentNames = new Set((fs.readdirSync(staged.extractDir) || []).map(name => name.toLowerCase()));
            for (const name of usedEmbeddedNames) currentNames.add(name);
            const nextName = reserveUniqueName(staged.embeddedOriginalName, currentNames);
            usedEmbeddedNames.add(nextName.toLowerCase());
            staged.extractPath = path.join(staged.extractDir, nextName);
          }
        }
        if (!linked) throw cacheSafetyError('psd-extract-file', 'name-exhausted');
        staged.committed = true;
        fs.unlinkSync(staged.stagedPath);
        const finalStat = fs.lstatSync(staged.extractPath);
        if (finalStat.isSymbolicLink() || !finalStat.isFile() || finalStat.dev !== staged.identity.dev || finalStat.ino !== staged.identity.ino) throw cacheSafetyError('psd-extract-file', 'changed');
        discoveredPaths.push({
          filePath: staged.extractPath,
          source: 'psd-embedded',
          embeddedOriginalName: staged.embeddedOriginalName,
          embeddedIndex: staged.embeddedIndex,
          sourceDigest,
        });
      }
    }

    if (!isCurrent()) return [];
    keepInvocationFiles = true;
    Object.defineProperty(discoveredPaths, 'release', { value: releaseInvocationFiles });
    return discoveredPaths;
  } catch (e) {
    if (!isCurrent()) return [];
    if (!options.quiet) console.error('[crate][psd-parser] Error parsing PSD:', e.message);
    if (options.strict === true) throw e;
    return [];
  } finally { if (!keepInvocationFiles) releaseInvocationFiles(); }
}

/**
 * v2.2.7: InDesign AppleScript extractor.
 * InDesign has excellent scripting support — query all links of each open document.
 * Falls back to extractLinkedAssetsRegex() for .indd or extractLinkedAssetsIdml()
 * for .idml if InDesign is not running or AppleScript returns nothing.
 */
async function extractLinkedAssetsInDesign(filePath, options = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const strict = options.strict === true;
  if (ext === '.idml') return extractLinkedAssetsIdml(filePath, options);

  try {
    // Check if InDesign is running
    const { stdout: psCheck } = await runCancellableExec(
      "/bin/ps ax -o command= 2>/dev/null | grep -i 'Adobe InDesign' | grep -v grep",
      { timeout: 3000, encoding: 'utf8', ...options }
    );

    if (!psCheck.trim()) {
      if (strict) throw new Error('asset_baseline_indesign_unavailable');
      return extractLinkedAssetsRegex(filePath, options);
    }

    const { stdout: inddPaths } = await runOsascriptInPrivateTemp(
      () => ({ 'crate-indd-query.applescript': INDD_APPLESCRIPT }),
      'crate-indd-query.applescript',
      { timeout: 10000, encoding: 'utf8', ...options }
    );
    const selectedSourcePath = normalizeTrackedFilePath(filePath);
    const activeState = strict
      ? await parseDependableInDesignBaselineSnapshot(inddPaths, selectedSourcePath, options)
      : parseInDesignActiveSessionOutput(inddPaths);

    const results = activeState.links
      .filter(link => normalizeTrackedFilePath(link.documentPath) === selectedSourcePath)
      .map(link => link.linkedPath)
      .filter(linkedPath => linkedPath !== filePath && fs.existsSync(linkedPath));
    if (strict || results.length > 0) return [...new Set(results)];
  } catch (e) {
    if (strict) throw e;
  }
  // Non-baseline live scans retain the legacy binary fallback.
  return extractLinkedAssetsRegex(filePath, options);
}

/**
 * IDML extractor: .idml is a zip; unzip and parse XML for <Link> elements.
 */
async function extractLinkedAssetsIdml(filePath, options = {}) {
  const results = [];
  try {
    // List zip contents and find Spreads/*.xml or Resources/*.xml
    const { stdout: listing } = await runCancellableExecFile('/usr/bin/unzip', ['-l', filePath], {
      timeout: 10000, encoding: 'utf8', ...options,
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
      if (!isAddFilesParserCurrent(options)) return [];
      try {
        const { stdout: data } = await runCancellableExecFile('/usr/bin/unzip', ['-p', filePath, entry], {
          timeout: 8000, encoding: 'utf8', ...options,
        });
        // Look for LinkResourceURI attributes
        const uriRegex = /LinkResourceURI="file:([^"]+)"/gi;
        const uriMatches = await collectRegexMatchesCooperatively(data, uriRegex, options);
        if (uriMatches === null) return [];
        for (const match of uriMatches) {
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
        const rawMatches = await collectRegexMatchesCooperatively(data, LINKED_ASSET_REGEX, options);
        if (rawMatches === null) return [];
        for (const match of rawMatches) {
          results.push(match[0]);
        }
      } catch (e) {
        if (options.strict === true) throw e;
      }
    }
  } catch (e) {
    if (options.strict === true) throw e;
    // fallback: try regex on the raw zip
    return await extractLinkedAssetsRegex(filePath, options);
  }
  return [...new Set(results)];
}

/**
 * Sketch extractor: .sketch is a zip; parse document.json and pages for image refs.
 */
async function extractLinkedAssetsSketch(filePath, options = {}) {
  const results = [];
  try {
    // List zip contents
    const { stdout: listing } = await runCancellableExecFile('/usr/bin/unzip', ['-l', filePath], {
      timeout: 10000, encoding: 'utf8', ...options,
    });
    const jsonEntries = [];
    for (const line of listing.split('\n')) {
      const m = line.match(/^\s+\d+\s+\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}\s+(.+)$/);
      if (!m) continue;
      const entry = m[1].trim();
      if (entry.endsWith('.json')) jsonEntries.push(entry);
    }

    for (const entry of jsonEntries) {
      if (!isAddFilesParserCurrent(options)) return [];
      try {
        const { stdout: data } = await runCancellableExecFile('/usr/bin/unzip', ['-p', filePath, entry], {
          timeout: 8000, encoding: 'utf8', ...options,
        });
        // Scan for absolute file paths in JSON
        const LINKED_ASSET_REGEX = /(?:\/Users\/|\/Volumes\/)[^\x00-\x1f\x22\x27]+?\.(jpg|jpeg|png|gif|webp|svg|pdf|eps|ai|psd|tiff|tif|heic|ttf|otf|woff|woff2|mp4|mov|avi|webm)/gi;
        const matches = await collectRegexMatchesCooperatively(data, LINKED_ASSET_REGEX, options);
        if (matches === null) return [];
        for (const match of matches) {
          results.push(match[0]);
        }
      } catch (e) {
        if (options.strict === true) throw e;
      }
    }
  } catch (e) {
    if (options.strict === true) throw e;
    // fallback: try regex on the raw zip
    return await extractLinkedAssetsRegex(filePath, options);
  }
  return [...new Set(results)];
}

/**
 * Affinity extractor: .afdesign/.afphoto/.afpub are zip-based.
 * Parse internal files for linked asset references.
 */
async function extractLinkedAssetsAffinity(filePath, options = {}) {
  const results = [];
  try {
    // List zip contents
    const { stdout: listing } = await runCancellableExecFile('/usr/bin/unzip', ['-l', filePath], {
      timeout: 10000, encoding: 'utf8', ...options,
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
      if (!isAddFilesParserCurrent(options)) return [];
      try {
        const { stdout: data } = await runCancellableExecFile('/usr/bin/unzip', ['-p', filePath, entry], {
          timeout: 8000, encoding: 'utf8', ...options,
        });
        const LINKED_ASSET_REGEX = /(?:\/Users\/|\/Volumes\/)[^\x00-\x1f\x22\x27]+?\.(jpg|jpeg|png|gif|webp|svg|pdf|eps|ai|psd|tiff|tif|heic|ttf|otf|woff|woff2|mp4|mov|avi|webm)/gi;
        const matches = await collectRegexMatchesCooperatively(data, LINKED_ASSET_REGEX, options);
        if (matches === null) return [];
        for (const match of matches) {
          results.push(match[0]);
        }
      } catch (e) {
        if (options.strict === true) throw e;
      }
    }

    // Also try regex on the raw binary (Affinity often stores paths in binary blobs)
    const rawResults = await extractLinkedAssetsRegex(filePath, options);
    results.push(...rawResults);
  } catch (e) {
    if (options.strict === true) throw e;
    return await extractLinkedAssetsRegex(filePath, options);
  }
  return [...new Set(results)];
}

/**
 * Zip media extractor for .key/.pptx: lists embedded media files
 * and returns their paths after extracting to a temp location.
 * Unlike the package-time extractEmbeddedMedia, this returns references
 * to the presentation file itself (the design file IS the asset container).
 * For scan-on-open, we just add the presentation file — embedded media
 * extraction happens at package time via extractEmbeddedMedia().
 *
 * However, we also scan the zip for any absolute path references to
 * externally linked files (rare but possible in Keynote).
 */
async function extractLinkedAssetsZipMedia(filePath, options = {}) {
  try {
    const buf = await readFileWithAddFilesCancellation(filePath, options.addFilesAttempt);
    return extractLinkedAssetsRegex(filePath, { ...options, sourceBuffer: buf });
  } catch (e) {
    if (options.strict === true) throw e;
  }
  return [];
}

/**
 * Pixelmator Pro extractor: .pxd is a zip-based package.
 * Parse for linked asset references.
 */
async function extractLinkedAssetsPxd(filePath, options = {}) {
  // .pxd is zip-based — try both structured and regex approaches
  const results = [];
  try {
    const { stdout: listing } = await runCancellableExecFile('/usr/bin/unzip', ['-l', filePath], {
      timeout: 10000, encoding: 'utf8', ...options,
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
      if (!isAddFilesParserCurrent(options)) return [];
      try {
        const { stdout: data } = await runCancellableExecFile('/usr/bin/unzip', ['-p', filePath, entry], {
          timeout: 8000, encoding: 'utf8', ...options,
        });
        const LINKED_ASSET_REGEX = /(?:\/Users\/|\/Volumes\/)[^\x00-\x1f\x22\x27]+?\.(jpg|jpeg|png|gif|webp|svg|pdf|eps|ai|psd|tiff|tif|heic|ttf|otf|woff|woff2|mp4|mov|avi|webm)/gi;
        const matches = await collectRegexMatchesCooperatively(data, LINKED_ASSET_REGEX, options);
        if (matches === null) return [];
        for (const match of matches) {
          results.push(match[0]);
        }
      } catch (e) {
        if (options.strict === true) throw e;
      }
    }
  } catch (e) {
    if (options.strict === true) throw e;
  }
  // Also try raw binary regex
  const rawResults = await extractLinkedAssetsRegex(filePath, options);
  results.push(...rawResults);
  return [...new Set(results)];
}

function markExistingBaselineAssetMetadata(project, fileEntry) {
  const candidateKey = getTrackedFileDedupKey(fileEntry);
  if (!candidateKey) return false;
  const baselineSourceKeys = assetBaselineScans.get(project.id)?.requiredSourceKeys || new Set();
  let changed = false;
  for (const collection of [project.files, project.pendingFiles]) {
    const storedFile = (collection || []).find(file => getTrackedFileDedupKey(file) === candidateKey);
    if (!storedFile) continue;
    if (baselineSourceKeys.has(normalizeTrackedFilePath(storedFile.path))) continue;
    if (isExplicitUserCapturedFile(storedFile)) continue;
    if (storedFile.assetOrigin !== 'existing') {
      storedFile.assetOrigin = 'existing';
      changed = true;
    }
    if (storedFile.projectRole !== 'asset') {
      storedFile.projectRole = 'asset';
      changed = true;
    }
    if (
      typeof fileEntry.assetBaselineSourcePath === 'string' &&
      storedFile.assetBaselineSourcePath !== fileEntry.assetBaselineSourcePath
    ) {
      storedFile.assetBaselineSourcePath = fileEntry.assetBaselineSourcePath;
      changed = true;
    }
    if (
      isPackageContentFingerprint(fileEntry.presentationContentFingerprint) &&
      storedFile.presentationContentFingerprint !== fileEntry.presentationContentFingerprint
    ) {
      storedFile.presentationContentFingerprint = fileEntry.presentationContentFingerprint;
      changed = true;
    }
  }
  return changed;
}

async function captureExistingPresentationMediaBaseline(
  projectId,
  presentationPath,
  baselineScan,
  isCurrent,
  options = {}
) {
  const ext = path.extname(presentationPath).toLowerCase();
  if (!baselineScan || (ext !== '.pptx' && ext !== '.key')) return;
  const project = getProjects().find(item => item.id === projectId);
  if (!project || !isCurrent() || !isAcceptedProjectFilePath(project, presentationPath)) return;

  const tempDir = ensurePresentationAssetsDir(projectId);
  const extractionRecords = [];
  const discoveredOccurrences = [];
  const invocationFiles = [];
  let keepInvocationFiles = false;
  try {
    const extractedPaths = await extractEmbeddedMedia(presentationPath, tempDir, project.files || [], {
      source: 'scan-on-save-presentation',
      logicalPresentationPath: presentationPath,
      failClosed: true,
      rollbackOnFailure: true,
      onCandidate: candidate => {
        const resource = getPresentationMediaResourceIdentity(presentationPath, candidate.internalPath);
        if (!resource || !isPackageContentFingerprint(candidate.contentFingerprint)) return;
        discoveredOccurrences.push({
          resourceKey: resource.resourceKey,
          contentFingerprint: candidate.contentFingerprint,
        });
      },
      onMaterialized: materialized => invocationFiles.push(materialized),
      onExtracted: extraction => extractionRecords.push(extraction),
      isCurrent,
      addFilesAttempt: options.addFilesAttempt,
      quiet: options.quiet,
    });
    if (!isCurrent()) return;

    const scanState = assetBaselineScans.get(projectId);
    if (scanState && scanState.startedAt === baselineScan.startedAt) {
      scanState.presentationMediaOccurrencesBySource ||= new Map();
      scanState.presentationMediaOccurrencesBySource.set(
        baselineScan.sourceKey,
        normalizePresentationMediaOccurrences(discoveredOccurrences)
      );
    }

    const internalPathByMaterializedPath = new Map(extractionRecords.map(extraction => [
      normalizeTrackedFilePath(extraction.materializedPath),
      extraction.internalPath,
    ]));
    for (const extractedPath of extractedPaths) {
      if (!isCurrent()) return;
      await new Promise(resolve => setImmediate(resolve));
      if (!isCurrent()) return;
      if (!tryHardenPresentationCacheFile(extractedPath, tempDir)) {
        throw new Error('presentation_baseline_cache_unavailable');
      }
    }

    const extractedMediaInputs = [];
    for (const extractedPath of extractedPaths) {
      if (!isCurrent()) return;
      await new Promise(resolve => setImmediate(resolve));
      if (!isCurrent()) return;
      const content = readOwnerOnlyCacheFileSync(
        extractedPath,
        tempDir,
        'presentation-cache-file',
        PRESENTATION_ASSET_FILE_MODE
      );
      extractedMediaInputs.push({
        extractedPath,
        contentFingerprint: getPackageContentFingerprint(content),
      });
    }

    if (options.sourceIdentity && !isAddFilesSourceIdentityCurrent(
      await fs.promises.stat(presentationPath),
      options.sourceIdentity
    )) throw new Error('asset_baseline_source_changed');

    const result = mutateProject(projectId, (proj) => {
      if (
        (proj.status !== 'watching' && !(baselineScan.allowPaused && proj.status === 'paused')) ||
        !isCurrent() ||
        !isAcceptedProjectFilePath(proj, presentationPath)
      ) return null;

      let changed = false;
      const acceptedFiles = [];
      for (const { extractedPath, contentFingerprint } of extractedMediaInputs) {
        if (!isCurrent()) return null;
        const fileEntry = buildAutoCaptureFileEntry(extractedPath, 'scan-on-save-presentation', {
          assetOrigin: 'existing',
          projectRole: 'asset',
          assetBaselineSourcePath: presentationPath,
          presentationContentFingerprint: contentFingerprint,
        });
        const baselineMetadataChanged = markExistingBaselineAssetMetadata(proj, fileEntry);
        const staged = stageLiveObservedFile(proj, fileEntry, {
          relationshipSourcePath: presentationPath,
          appFamily: getPrimaryDesignAppFamilyForExt(ext) || 'generic',
          reason: 'scan-on-save-presentation',
          explicitBaselineRelationship: true,
        });
        if (!staged.changed && !baselineMetadataChanged) continue;
        if (staged.decision === LIVE_CAPTURE_DECISIONS.DIRECT_ADD) acceptedFiles.push(fileEntry);
        changed = true;
      }

      if (!changed) return null;
      proj.files = deduplicateFiles(proj.files);
      for (const fileEntry of acceptedFiles) {
        const internalPath = internalPathByMaterializedPath.get(normalizeTrackedFilePath(fileEntry.path));
        if (!internalPath) continue;
        recordPowerPointMediaExtractionProvenanceForProject(proj, [{
          presentationPath,
          internalPath,
          materializedPath: fileEntry.path,
          source: fileEntry.source,
          observedAt: fileEntry.addedAt,
        }]);
      }
      return { files: proj.files, pendingFiles: proj.pendingFiles || [] };
    });

    keepInvocationFiles = !!result;
    if (result && isCurrent()) sendProjectFileStateToRenderer(projectId, baselineScan.activationToken);
  } finally {
    if (!keepInvocationFiles) removeOwnedDirectCacheFiles(invocationFiles);
  }
}

/**
 * Run scan-on-open for a design file: extract linked assets and merge into project.
 * Fire-and-forget — called outside mutateProject, then uses mutateProject for store writes.
 */
async function runScanOnOpen(projectId, filePath, activationToken = null, operation = null, options = {}) {
  const operationCurrent = operation && typeof operation.currentFast === 'function'
    ? () => operation.currentFast()
    : operation && typeof operation.current === 'function'
      ? () => operation.current()
      : null;
  const isCurrent = operation
    ? operationCurrent
    : () => isBoundWatchingActivationCurrent(projectId, activationToken);
  const ext = path.extname(filePath).toLowerCase();
  if (!SCAN_ON_OPEN_EXTENSIONS.has(ext)) return;
  const currentProject = options.project || getProjects().find(p => p.id === projectId);
  if (!currentProject || !isCurrent() || !isAcceptedProjectFilePath(currentProject, filePath)) return;

  const baselineScan = options.establishBaseline === false
    ? null
    : beginProjectAssetBaselineScan(projectId, filePath, activationToken, {
      allowPaused: options.allowPausedBaseline === true,
      operation,
      project: currentProject,
    });
  let dependableScanCompleted = false;
  try {

  if (!options.quiet) console.log(`[crate] scan-on-open: scanning ${path.basename(filePath)}`);
  const validatedSource = baselineScan
    ? await assertDependableAssetBaselineSource(filePath, {
      isCurrent,
      addFilesAttempt: options.addFilesAttempt,
    })
    : null;
  const linkedPaths = await extractLinkedAssets(filePath, {
    strict: !!baselineScan,
    sourceBuffer: validatedSource?.kind === 'source-buffer' ? validatedSource.buffer : undefined,
    validatedPsdResult: validatedSource?.kind === 'psd-worker-result' ? validatedSource.result : undefined,
    quiet: options.quiet,
    isCurrent,
    addFilesAttempt: options.addFilesAttempt,
  });
  if (!isCurrent()) return;
  const validatedIdentity = validatedSource?.sourceIdentity;
  const validatedSourceDigest = validatedSource?.sourceDigest;
  const recheckValidatedIdentity = async () => {
    if (!baselineScan || !validatedIdentity) return true;
    try {
      if (validatedSourceDigest) {
        return await getAddFilesCurrentSourceDigest(filePath, options.addFilesAttempt) === validatedSourceDigest;
      }
      return isAddFilesSourceIdentityCurrent(
        await fs.promises.stat(filePath),
        validatedIdentity
      );
    } catch (_) {
      return false;
    }
  };
  if (!await recheckValidatedIdentity()) throw new Error('asset_baseline_source_changed');
  // Filter to existing files on disk with design-relevant extensions
  const validPaths = [];
  for (const p of linkedPaths) {
    if (!p.startsWith('/Users/')) continue;
    const pExt = path.extname(p).toLowerCase();
    if (!DESIGN_FILE_EXTENSIONS.has(pExt)) continue;
    try {
      await accessWithAddFilesCancellation(p, fs.constants.F_OK, options.addFilesAttempt);
      if (!isCurrent()) return;
      validPaths.push(p);
    } catch (e) {
      // file doesn't exist — skip
    }
  }

  if (!isCurrent()) return;
  if (validPaths.length > 0 && !await recheckValidatedIdentity()) {
    throw new Error('asset_baseline_source_changed');
  }
  if (validPaths.length > 0 && operation && !operation.current()) return;
  if (validPaths.length === 0) {
    if (!options.quiet) console.log(`[crate] scan-on-open: found 0 linked assets in ${path.basename(filePath)}`);
  } else {
    if (!options.quiet) console.log(`[crate] scan-on-open: found ${validPaths.length} linked assets in ${path.basename(filePath)}`);

    const revisedScope = admitIllustratorRelationshipPathsForProject(projectId, filePath, validPaths);
    if (operation && revisedScope && !operation.adoptScope(revisedScope)) return;
    if (!isCurrent()) return;

    const result = mutateProject(projectId, (proj) => {
      if (
        (proj.status !== 'watching' && !(baselineScan?.allowPaused && proj.status === 'paused')) ||
        !isCurrent() ||
        !isAcceptedProjectFilePath(proj, filePath)
      ) return null;
      // v2.4.0: normalize paths before comparing to prevent duplicates
      const acceptedFiles = [];
      let changed = false;

      for (const linkedPath of validPaths) {
        const fileEntry = buildAutoCaptureFileEntry(linkedPath, 'scan-on-open');
        let baselineMetadataChanged = false;
        if (baselineScan) {
          fileEntry.assetOrigin = 'existing';
          fileEntry.projectRole = 'asset';
          if (baselineScan.allowPaused) fileEntry.assetBaselineSourcePath = filePath;
          baselineMetadataChanged = markExistingBaselineAssetMetadata(proj, fileEntry);
        }
        const staged = stageLiveObservedFile(proj, fileEntry, {
          relationshipSourcePath: filePath,
          appFamily: getPrimaryDesignAppFamilyForExt(ext) || 'generic',
          reason: 'scan-on-open-source-relationship',
          explicitBaselineRelationship: baselineScan?.allowPaused === true,
        });
        if (!staged.changed && !baselineMetadataChanged) continue;
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
    }, { rollbackOnNull: true });

    if (result && isCurrent()) {
      lastFileActivity.set(projectId, Date.now());
      inactivityNotified.delete(projectId);
      sendProjectFileStateToRenderer(projectId, activationToken);
    }
  }

  // v2.3.6: PSD binary parse — extract embedded smart object assets via ag-psd.
  // Runs in addition to the AppleScript/do-javascript path above.
  // Debounce: skip if same PSD was parsed less than 5 seconds ago.
  if (ext === '.psd') {
    const lastParsed = psdParseDebounce.get(filePath) || 0;
    if (!baselineScan && Date.now() - lastParsed < 5000) return;
    if (!isCurrent()) return;
    psdParseDebounce.set(filePath, Date.now()); // set BEFORE parse to prevent concurrent duplicates
    let psdAssets = await extractPsdAssets(filePath, projectId, isCurrent, {
      strict: !!baselineScan,
      addFilesAttempt: options.addFilesAttempt,
      validatedPsdResult: validatedSource?.kind === 'psd-worker-result' ? validatedSource.result : undefined,
      validatedPsdSourceIdentity: validatedSource?.kind === 'psd-worker-result' ? validatedSource.sourceIdentity : undefined,
      quiet: options.quiet,
    });
    if (!isCurrent()) { psdAssets.release?.(); return; }
    if (!baselineScan) {
      const currentPsdProject = getProjects().find(project => project.id === projectId);
      const embeddedSourceDigest = psdAssets.find(asset => asset.source === 'psd-embedded')?.sourceDigest;
      const hasExistingPsdEmbeddedAsset = currentPsdProject && [
        ...(currentPsdProject.files || []),
        ...(currentPsdProject.pendingFiles || []),
      ].some(file => (
        file && file.source === 'psd-embedded' &&
        normalizeTrackedFilePath(file.parentPsd || '') === normalizeTrackedFilePath(filePath) &&
        (!file.sourceDigest || !embeddedSourceDigest || file.sourceDigest === embeddedSourceDigest)
      ));
      if (hasExistingPsdEmbeddedAsset) {
        const retainedAssets = psdAssets.filter(asset => asset.source !== 'psd-embedded');
        if (retainedAssets.length !== psdAssets.length) psdAssets.release?.();
        psdAssets = retainedAssets;
      }
    }
    if (psdAssets.length > 0) {
      if (!await recheckValidatedIdentity()) { psdAssets.release?.(); throw new Error('asset_baseline_source_changed'); }
      if (operation && !operation.current()) { psdAssets.release?.(); return; }
      const psdResult = mutateProject(projectId, (proj) => {
        if (
          (proj.status !== 'watching' && !(baselineScan?.allowPaused && proj.status === 'paused')) ||
          !isCurrent() ||
          !isAcceptedProjectFilePath(proj, filePath)
        ) return null;
        // v2.4.0: normalize paths before comparing to prevent duplicates
        const acceptedFiles = [];
        let changed = false;
        for (const asset of psdAssets) {
          const fileEntry = buildAutoCaptureFileEntry(asset.filePath, asset.source, {
            parentPsd: filePath,
            embeddedOriginalName: asset.embeddedOriginalName || null,
            embeddedIndex: Number.isInteger(asset.embeddedIndex) ? asset.embeddedIndex : null,
            sourceDigest: asset.sourceDigest || null,
          });
          let baselineMetadataChanged = false;
          if (baselineScan) {
            fileEntry.assetOrigin = 'existing';
            fileEntry.projectRole = 'asset';
            if (baselineScan.allowPaused) fileEntry.assetBaselineSourcePath = filePath;
            baselineMetadataChanged = markExistingBaselineAssetMetadata(proj, fileEntry);
          }
          const staged = stageLiveObservedFile(proj, fileEntry, {
            relationshipSourcePath: filePath,
            appFamily: 'photoshop',
            reason: 'scan-on-open-psd-parser',
          });
          if (!staged.changed && !baselineMetadataChanged) continue;
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
      }, { rollbackOnNull: true });
      if (!psdResult) psdAssets.release?.();
      if (psdResult && isCurrent()) {
        lastFileActivity.set(projectId, Date.now());
        inactivityNotified.delete(projectId);
        sendProjectFileStateToRenderer(projectId, activationToken);
      }
    }
  }
  if (baselineScan && (ext === '.pptx' || ext === '.key')) {
    await captureExistingPresentationMediaBaseline(projectId, filePath, baselineScan, isCurrent, {
      ...options,
      sourceIdentity: validatedIdentity,
    });
  }
  if (!await recheckValidatedIdentity()) throw new Error('asset_baseline_source_changed');
  dependableScanCompleted = true;
  return { success: true };
  } catch (error) {
    if (!options.quiet) console.error('[crate] scan-on-open: controlled failure:', baselineScan ? 'asset-baseline-scan-failed' : 'scan-on-open-failed');
    return {
      success: false,
      error: baselineScan ? 'asset_baseline_scan_incomplete' : 'scan_on_open_failed',
    };
  } finally {
    await completeProjectAssetBaselineScan(baselineScan, dependableScanCompleted && isCurrent());
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
function scheduleScanOnSave(projectId, psdFilePath, activationToken = null) {
  if (!isBoundWatchingActivationCurrent(projectId, activationToken)) return;
  const key = `${projectId}:${psdFilePath}`;
  if (scanOnSaveTimers.has(key)) {
    clearTimeout(scanOnSaveTimers.get(key));
  }
  const timerId = setTimeout(() => {
    if (scanOnSaveTimers.get(key) === timerId) {
      scanOnSaveTimers.delete(key);
    }
    runScanOnSave(projectId, psdFilePath, activationToken).catch(() => {});
  }, 2000);
  scanOnSaveTimers.set(key, timerId);
}

async function runScanOnSave(projectId, psdFilePath, activationToken = null) {
  try {
    if (!isBoundWatchingActivationCurrent(projectId, activationToken)) return;
    const currentProject = getProjects().find(p => p.id === projectId);
    if (!currentProject || !isAcceptedProjectFilePath(currentProject, psdFilePath)) return;

    const stat = await fs.promises.stat(psdFilePath);
    if (!isBoundWatchingActivationCurrent(projectId, activationToken)) return;
    if (stat.size > MAX_PARSE_FILE_SIZE) return;

    const buf = await fs.promises.readFile(psdFilePath);
    if (!isBoundWatchingActivationCurrent(projectId, activationToken)) return;
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
          fileId: crypto.randomUUID(), // C2: unique key so embedded entries can be individually removed
        });
      }
    }

    if (!isBoundWatchingActivationCurrent(projectId, activationToken)) return;

    const result = mutateProject(projectId, (proj) => {
      if (!isBoundWatchingActivationCurrent(projectId, activationToken)) return null;
      const currentEmbeddedKeys = new Set(
        newEntries
          .filter(entry => entry.source === 'scan-on-save-embedded')
          .map(getEmbeddedPsdDedupKey)
      );
      const isStaleEmbeddedEntry = entry => (
        isScanOnSaveEmbeddedPsdFile(entry) &&
        normalizeTrackedFilePath(entry.parentPsd || entry.path) === normalizeTrackedFilePath(psdFilePath) &&
        !currentEmbeddedKeys.has(getEmbeddedPsdDedupKey(entry))
      );
      const filesBefore = proj.files.length;
      const pendingBefore = (proj.pendingFiles || []).length;
      proj.files = proj.files.filter(entry => !isStaleEmbeddedEntry(entry));
      proj.pendingFiles = (proj.pendingFiles || []).filter(entry => !isStaleEmbeddedEntry(entry));
      let changed = proj.files.length !== filesBefore || proj.pendingFiles.length !== pendingBefore;

      for (const entry of newEntries) {
        const staged = stageLiveObservedFile(proj, entry, {
          relationshipSourcePath: psdFilePath, appFamily: 'photoshop',
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
      if (!isBoundWatchingActivationCurrent(projectId, activationToken)) return;
      lastFileActivity.set(projectId, Date.now());
      inactivityNotified.delete(projectId);
      sendProjectFileStateToRenderer(projectId, activationToken);
    }
  } catch (e) {
    // L2: Log so failures are debuggable — never break the session
    console.log('[scan-on-save] ag-psd parse failed:', e.message);
  }
}

/**
 * v2.5.3: Scan-on-save for ZIP presentation files (.pptx, .key).
 * When a presentation is saved (Cmd+S), extract embedded media immediately
 * to a temp dir and add to project.files mid-session. Debounced 2s like PSD.
 */
function scheduleScanOnSavePresentation(projectId, filePath, activationToken = null) {
  if (!isBoundWatchingActivationCurrent(projectId, activationToken)) return;
  const key = `${projectId}:${filePath}`;
  if (scanOnSavePresentationTimers.has(key)) {
    clearTimeout(scanOnSavePresentationTimers.get(key));
  }
  const timerId = setTimeout(() => {
    if (scanOnSavePresentationTimers.get(key) === timerId) {
      scanOnSavePresentationTimers.delete(key);
    }
    runScanOnSavePresentation(projectId, filePath, activationToken).catch(() => {});
  }, 2000);
  scanOnSavePresentationTimers.set(key, timerId);
}

async function runScanOnSavePresentation(projectId, presentationPath, activationToken = null) {
  try {
    if (!isBoundWatchingActivationCurrent(projectId, activationToken)) return;
    const ext = path.extname(presentationPath).toLowerCase();
    if (ext !== '.pptx' && ext !== '.key') return;
    const base = path.basename(presentationPath, ext);
    const currentProject = getProjects().find(p => p.id === projectId);
    if (!currentProject || !isAcceptedProjectFilePath(currentProject, presentationPath)) return;

    // Ensure temp dir exists: ~/.crate/presentation-assets/{projectId}/
    const tempDir = ensurePresentationAssetsDir(projectId);

    // Build dedup sets from existing project files
    const currentProjects = getProjects();
    const project = currentProjects.find(p => p.id === projectId);
    if (!project || !isBoundWatchingActivationCurrent(projectId, activationToken)) return;
    const projectFiles = project.files || [];

    // Name-based dedup for .key files. Do not add prior scan-on-save media to
    // this base-name set: Keynote commonly saves multiple distinct pasted
    // images as pasted-image-NNNN.jpeg, and stripping the suffix collapses them
    // all to the same display base. Exact duplicate scan media is handled by
    // content fingerprints below.
    const alreadyCapturedBases = new Set();
    const safePresentationCachePaths = new Set();
    for (const f of projectFiles) {
      if (f && f.source === 'scan-on-save-presentation') {
        if (tryHardenPresentationCacheFile(f.path, tempDir) && typeof f.path === 'string') {
          safePresentationCachePaths.add(path.resolve(f.path));
        }
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
    if (ext === '.pptx' || ext === '.key') {
      for (const f of projectFiles) {
        const candidateExt = path.extname(f && (f.path || f.name) || '').toLowerCase();
        if (!EMBEDDED_MEDIA_EXTENSIONS.has(candidateExt)) continue;
        try {
          const fromPresentationCache = f && f.source === 'scan-on-save-presentation';
          if (fromPresentationCache
            && (typeof f.path !== 'string' || !safePresentationCachePaths.has(path.resolve(f.path)))) {
            continue;
          }
          const buf = fromPresentationCache
            ? readOwnerOnlyCacheFileSync(
              f.path,
              tempDir,
              'presentation-cache-file',
              PRESENTATION_ASSET_FILE_MODE
            )
            : fs.readFileSync(f.path);
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
          try {
            const buf = readOwnerOnlyCacheFileSync(
              candidatePath,
              tempDir,
              'presentation-cache-file',
              PRESENTATION_ASSET_FILE_MODE
            );
            const hash = crypto.createHash('md5').update(buf).digest('hex');
            if (`${buf.length}:${hash}` === fingerprint) return true;
          } catch (_) {
            // Unsafe or unavailable cache entries are never followed.
          }
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
    if (!isBoundWatchingActivationCurrent(projectId, activationToken)) return;

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
        (ext === '.pptx')                    ? zipPath.startsWith('ppt/media/') :
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
        if (!isBoundWatchingActivationCurrent(projectId, activationToken)) return;
        const { stdout: data } = await execFileAsync('/usr/bin/unzip', ['-p', presentationPath, zipPath], {
          timeout: 10000, maxBuffer: 50 * 1024 * 1024,
          encoding: 'buffer'
        });
        if (!isBoundWatchingActivationCurrent(projectId, activationToken)) return;
        let extractedFingerprint = null;

        // Content-based dedup for presentation media.
        if (ext === '.pptx' || ext === '.key') {
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
          if (ext === '.pptx' || ext === '.key') {
            try {
              const existingBuf = readOwnerOnlyCacheFileSync(
                destPath,
                tempDir,
                'presentation-cache-file',
                PRESENTATION_ASSET_FILE_MODE
              );
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

        if (!isBoundWatchingActivationCurrent(projectId, activationToken)) return;
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
    if (!isBoundWatchingActivationCurrent(projectId, activationToken)) return;

    const result = mutateProject(projectId, (proj) => {
      if (!isBoundWatchingActivationCurrent(projectId, activationToken)) return null;
      let changed = false;

      for (const entry of newEntries) {
        const { internalPath, presentationPath: sourcePresentationPath, ...fileEntry } = entry;
        const staged = stageLiveObservedFile(proj, fileEntry, {
          relationshipSourcePath: sourcePresentationPath,
          appFamily: getPrimaryDesignAppFamilyForExt(path.extname(sourcePresentationPath)) || 'generic',
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
      if (!isBoundWatchingActivationCurrent(projectId, activationToken)) return;
      lastFileActivity.set(projectId, Date.now());
      inactivityNotified.delete(projectId);
      sendProjectFileStateToRenderer(projectId, activationToken);
    }
  } catch (e) {
    console.log('[scan-on-save-presentation] extraction failed:', redactFigmaLogText(e.message));
  } finally {
    scheduleDeletedProjectCacheCleanup(projectId);
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
  if (trayWindow && !trayWindow.isDestroyed() && mainWindowIdentities.has(trayWindow)) {
    if (!liveWindows || liveWindows.includes(trayWindow)) return trayWindow;
    console.warn('[main-window] cached window missing from live window list; recreating');
    trayWindow = null;
  }
  if (!liveWindows) return null;
  const existingWindow = liveWindows
    .find((win) => (
      win &&
      typeof win.isDestroyed === 'function' &&
      !win.isDestroyed() &&
      mainWindowIdentities.has(win)
    ));
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
    startupPhaseJournal.mark('main-window-visible');
    mainWindowHiddenShowAttempts = 0;
    mainWindowVisibleSinceStartup = true;
    clearMainWindowStartupRetries();
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

  startupPhaseJournal.mark('main-window-create-start');
  const nextWindow = new BrowserWindow({
    // Keep the native constructor authoritative. The startup helper remains a
    // safety net for every created window, but it must not be the only guard
    // against compact navigation becoming reachable in the packaged app.
    width: DESKTOP_WINDOW_MINIMUM.width,
    height: DESKTOP_WINDOW_MINIMUM.height,
    minWidth: DESKTOP_WINDOW_MINIMUM.width,
    minHeight: DESKTOP_WINDOW_MINIMUM.height,
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
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    }
  });
  startupPhaseJournal.mark('main-window-constructed');
  mainWindowIdentities.add(nextWindow);
  trayWindow = nextWindow;

  if (typeof nextWindow.on === 'function') {
    nextWindow.on('show', () => {
      markFirstOccurrenceStartupPhase('main-window-show-event');
    });
    nextWindow.on('focus', () => {
      markFirstOccurrenceStartupPhase('main-window-focus-event');
    });
  }

  const revealLoadedMainWindow = () => {
    clearMainWindowShowFallback();
    showMainWindow({ reason: 'renderer-ready' });
  };

  if (typeof trayWindow.once === 'function') {
    trayWindow.once('ready-to-show', () => {
      startupPhaseJournal.mark('main-window-ready-to-show');
      revealLoadedMainWindow();
    });
  }

  if (trayWindow.webContents && typeof trayWindow.webContents.once === 'function') {
    trayWindow.webContents.once('dom-ready', () => {
      startupPhaseJournal.mark('renderer-dom-ready');
    });
    trayWindow.webContents.once('did-finish-load', () => {
      startupPhaseJournal.mark('renderer-load-finished');
      revealLoadedMainWindow();
    });
  }

  if (trayWindow.webContents && typeof trayWindow.webContents.on === 'function') {
    let rendererWasUnresponsive = false;
    trayWindow.webContents.on('unresponsive', () => {
      if (rendererWasUnresponsive) return;
      rendererWasUnresponsive = true;
      markFirstOccurrenceStartupPhase('main-window-unresponsive');
    });
    trayWindow.webContents.on('responsive', () => {
      if (!rendererWasUnresponsive) return;
      markFirstOccurrenceStartupPhase('main-window-responsive');
    });
    const blockUntrustedNavigation = (event, targetUrl) => {
      const requestedUrl = event && typeof event.url === 'string' ? event.url : targetUrl;
      if (!isTrustedRendererUrl(requestedUrl) && event && typeof event.preventDefault === 'function') {
        event.preventDefault();
      }
    };
    trayWindow.webContents.on('will-navigate', blockUntrustedNavigation);
    trayWindow.webContents.on('will-redirect', blockUntrustedNavigation);
    trayWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      startupPhaseJournal.mark('renderer-load-failed');
      console.error('[main-window] renderer failed to load:', redactFigmaLogText(`${errorCode || ''} ${errorDescription || ''}`));
      showMainWindow({ reason: 'renderer-failed-load' });
    });
    trayWindow.webContents.on('render-process-gone', (_event, details = {}) => {
      startupPhaseJournal.mark('renderer-process-gone');
      console.error('[main-window] renderer process exited:', redactFigmaLogText(details.reason || 'unknown'));
      showMainWindow({ reason: 'renderer-process-gone' });
    });
  }

  if (trayWindow.webContents && typeof trayWindow.webContents.setWindowOpenHandler === 'function') {
    trayWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  }

  startupPhaseJournal.mark('renderer-load-start');
  const loadResult = trayWindow.loadFile(RENDERER_ENTRY_PATH);
  if (!mainWindowInitialDiagnosticsScheduled) {
    mainWindowInitialDiagnosticsScheduled = true;
    setImmediate(() => {
      markFirstOccurrenceStartupPhase('main-event-loop-immediate-after-window');
    });
    const eventLoopTimer = setTimeout(() => {
      markFirstOccurrenceStartupPhase('main-event-loop-timer-after-window');
    }, 100);
    if (eventLoopTimer && typeof eventLoopTimer.unref === 'function') {
      eventLoopTimer.unref();
    }
  }
  if (loadResult && typeof loadResult.catch === 'function') {
    loadResult.catch((error) => {
      startupPhaseJournal.mark('renderer-load-failed');
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
    mainWindowIdentities.delete(createdWindow);
    clearMainWindowShowFallback();
    if (mainWindowVisibleSinceStartup) {
      clearMainWindowStartupRetries();
    } else {
      scheduleMainWindowStartupRetries();
    }
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
  startupPhaseJournal.mark('main-window-show-requested');
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

function getNotificationIconPath() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  return fs.existsSync(iconPath) ? iconPath : null;
}

function showPackageCompleteNotification(projectName, fileCount, options = {}) {
  if (!Notification.isSupported()) return false;
  const { deferShow = false } = options || {};
  try {
    const notificationOptions = {
      title: 'Project Packaged!',
      body: `${projectName} \u2014 ${fileCount} files gathered.`,
      silent: false,
    };
    const iconPath = getNotificationIconPath();
    if (iconPath) {
      notificationOptions.icon = iconPath;
    }
    const notification = new Notification(notificationOptions);
    let showTimer = null;
    activeNativeNotifications.add(notification);
    const cleanup = () => {
      if (showTimer) {
        clearTimeout(showTimer);
        showTimer = null;
      }
      activeNativeNotifications.delete(notification);
    };
    const showNotification = () => {
      showTimer = null;
      try {
        notification.show();
      } catch (error) {
        cleanup();
        console.warn('[notifications] package-complete notification failed:', redactFigmaLogText(error && error.message));
        if (!isPackageAutoForegroundSuppressed()) {
          showMainWindow({ reason: 'package-notification-failed' });
        }
      }
    };
    notification.on('close', cleanup);
    notification.on('failed', (_event, error) => {
      cleanup();
      const message = error && error.message ? error.message : String(error || 'unknown');
      console.warn('[notifications] package-complete notification failed:', redactFigmaLogText(message));
      if (!isPackageAutoForegroundSuppressed()) {
        showMainWindow({ reason: 'package-notification-failed' });
      }
    });
    notification.on('click', () => {
      clearPackageAutoForegroundSuppression();
      showMainWindow({ reason: 'package-notification-click' });
    });
    if (deferShow) {
      showTimer = setTimeout(showNotification, PACKAGE_NOTIFICATION_SHOW_DELAY_MS);
      if (showTimer && typeof showTimer.unref === 'function') {
        showTimer.unref();
      }
    } else {
      showNotification();
    }
    return true;
  } catch (error) {
    console.warn('[notifications] package-complete notification failed:', redactFigmaLogText(error && error.message));
    return false;
  }
}

function createTray() {
  startupPhaseJournal.mark('tray-create-start');
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
  startupPhaseJournal.mark('tray-created');
}

// --- File Watching ---

async function isUnacceptedGenericChangeInCurrentWatchSession(project, filePath, suppliedStats = null) {
  if (!project || isAcceptedProjectFilePath(project, filePath)) return !!project;

  let stats = suppliedStats;
  if (!stats || !Number.isFinite(stats.mtimeMs) || !Number.isFinite(stats.birthtimeMs)) {
    try {
      stats = await fs.promises.stat(filePath);
    } catch (_error) {
      return null;
    }
  }

  const watchStartedAt = typeof project.watchStartedAt === 'number'
    ? project.watchStartedAt
    : Date.parse(project.watchStartedAt);
  if (
    !Number.isFinite(watchStartedAt) ||
    !Number.isFinite(stats.mtimeMs) ||
    !Number.isFinite(stats.birthtimeMs)
  ) {
    return null;
  }

  return stats.mtimeMs >= watchStartedAt || stats.birthtimeMs >= watchStartedAt;
}

async function getBoundedChokidarAddStats(filePath, isCurrent) {
  if (typeof isCurrent !== 'function' || !isCurrent()) return null;
  let timeoutId = null;
  const statPromise = Promise.resolve()
    .then(() => fs.promises.stat(filePath))
    .catch(() => null);
  let stats = null;
  try {
    stats = await Promise.race([
      statPromise,
      new Promise(resolve => {
        timeoutId = setTimeout(() => resolve(null), CHOKIDAR_ADD_STAT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
  if (typeof isCurrent !== 'function' || !isCurrent()) return null;
  if (!stats || !Number.isFinite(stats.mtimeMs) || !Number.isFinite(stats.birthtimeMs)) return null;
  return stats;
}

async function startWatching(projectId, { preserveWatchStartedAt = false } = {}) {
  const settings = store.get('settings') || {};
  const activation = activateSingleWatchingProject(projectId, settings, { preserveWatchStartedAt });
  if (!activation) return null;
  const { activationToken, projectSnapshot } = activation;
  await initializeIllustratorActivationScope(projectId, activationToken);
  if (!getFreshActiveWatchingProject(projectId, activationToken)) return null;

  // Replace any prior watcher before the initial lsof snapshot, then account
  // for that snapshot and its parser children in the same drainable lane as
  // recurring background observations.
  stopWatching(projectId, { invalidateActivation: false });
  if (!isActiveWatchingProject(projectId, activationToken)) return null;
  activateWatcherCoordinator(projectId);

  await runBackgroundWatcherOperation(projectId, 'lsof', async (watcherGeneration) => {
  const initialSnapshotParserScans = [];
  const capturedInitialOperation = captureProjectOperation(projectId);
  if (!capturedInitialOperation) return null;
  const coordinatorCurrent = () => (
    getWatcherCoordinator(projectId).isCurrent(projectId, watcherGeneration)
  );
  const initialWatcherOperation = {
    current: () => capturedInitialOperation.current() && coordinatorCurrent(),
    adoptScope(scope) {
      if (!coordinatorCurrent()) return false;
      return capturedInitialOperation.adoptScope(scope) && coordinatorCurrent();
    },
  };

  // FIX 4 (H1): Converted from execSync to async — no longer blocks main process
  // v1.3.38: One-time lsof snapshot to capture files already open in design apps
  // BEFORE the polling loop begins.
  try {
    const { stdout: psOut } = await execFileAsync('/bin/ps', ['ax', '-o', 'pid=', '-o', 'command='], {
      timeout: 5000, encoding: 'utf8'
    });
    if (!getFreshActiveWatchingProject(projectId, activationToken) || !initialWatcherOperation.current()) return null;
    const pids = [];
    const pidToCmd = new Map();
    for (const line of psOut.trim().split('\n')) {
      const m = line.trim().match(/^\s*(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = parseInt(m[1]);
      const cmd = m[2];
      if (DESIGN_APP_PROCESS_KEYWORDS.some(kw => cmd.includes(kw))) {
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
        if (!getFreshActiveWatchingProject(projectId, activationToken) || !initialWatcherOperation.current()) return null;

        // FIX 1: Use mutateProject to atomically apply snapshot results
        // v2.2.2: Collect design files for scan-on-open
        const snapshotDesignFiles = [];

        if (!isActiveWatchingProject(projectId, activationToken) || !initialWatcherOperation.current()) return null;
        const snapshotResult = mutateProject(projectId, (project) => {
          if (!isActiveWatchingProject(projectId, activationToken) || !initialWatcherOperation.current()) return null;
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

            const processCommand = currentPid ? pidToCmd.get(currentPid) || '' : '';
            if (!isAllowedLsofPathForApp(filePath, processCommand, home)) continue;

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
              ? getDesignAppProcessIdentity(processCommand)
              : null;
            const fileEntry = buildAutoCaptureFileEntry(filePath, 'lsof', { ext });
            const staged = stageLiveObservedFile(project, fileEntry, {
              forcePending: true,
              reason: 'initial-lsof-snapshot',
              captureReason: 'stale-prewatch-opened',
              captureState: LIVE_CAPTURE_STATES.PENDING,
              appFamily: processIdentity ? processIdentity.appFamily : 'generic',
            });
            if (!staged.changed) continue;
            if (staged.decision === LIVE_CAPTURE_DECISIONS.DIRECT_ADD) {
              recordLsofAcceptedFileProvenance(project, fileEntry, {
                method: 'initial-snapshot',
                pid: currentPid,
                command: processCommand,
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
                    appFamily: getExplicitCaptureAppFamily(designFile) || 'generic',
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
        if (snapshotResult) sendProjectFileStateToRenderer(projectId, activationToken);

        // Keep initial scan-on-open work inside the coordinated snapshot so
        // package preparation cannot observe an idle watcher prematurely.
        // Initialize scannedDesignFiles for this project and mark these as scanned.
        if (
          snapshotDesignFiles.length > 0 &&
          isActiveWatchingProject(projectId, activationToken) &&
          initialWatcherOperation.current()
        ) {
          if (!scannedDesignFiles.has(projectId)) scannedDesignFiles.set(projectId, new Set());
          const scanned = scannedDesignFiles.get(projectId);
          for (const fp of snapshotDesignFiles) {
            scanned.add(fp);
            initialSnapshotParserScans.push(
              runScanOnOpen(projectId, fp, activationToken, initialWatcherOperation).catch(() => null)
            );
          }
        }
      }
    }
  } catch (e) {
    console.error('[crate] initial lsof snapshot error:', e.message);
  } finally {
    if (initialSnapshotParserScans.length > 0) {
      await Promise.allSettled(initialSnapshotParserScans);
    }
    capturedInitialOperation.close();
  }
  });

  if (!isActiveWatchingProject(projectId, activationToken)) return null;

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
    if (!isActiveWatchingProject(projectId, activationToken)) return;
    const ext = path.extname(filePath).toLowerCase();
    const name = path.basename(filePath);
    if (name.startsWith('.') || name.startsWith('._') || name === 'Thumbs.db') return;
    if (name.startsWith('~$')) return;
    // v2.2.5: Skip temp/backup files from all design apps (Illustrator ~, Photoshop .tmp, etc.)
    if (name.includes('~') || name.endsWith('.tmp')) return;

    // v2.2.6: Only capture PRIMARY design source files via chokidar 'add'.
    // Image/media/font/pdf files are NOT captured here — they produce false positives
    // because Finder and design app browsers briefly open images for thumbnails.
    // lsof polling is the reliable mechanism for capturing those files.
    if (PRIMARY_DESIGN_EXTENSIONS.has(ext)) {
      await runBackgroundWatcherOperation(projectId, 'chokidar-add', async (watcherGeneration) => {
        const coordinatorCurrent = () => (
          getWatcherCoordinator(projectId).isCurrent(projectId, watcherGeneration)
        );
        const capturedOperation = captureProjectOperation(projectId);
        if (!capturedOperation) return null;
        const operationCurrent = () => (
          capturedOperation.current() &&
          coordinatorCurrent() &&
          isActiveWatchingProject(projectId, activationToken)
        );
        const operation = {
          current: operationCurrent,
          adoptScope(scope) {
            if (!coordinatorCurrent()) return false;
            return capturedOperation.adoptScope(scope) && coordinatorCurrent();
          },
        };
        if (!operationCurrent()) return null;

        // Small delay to let macOS write file metadata. Keep this inside the
        // coordinator ticket so package drain cannot pass while admission is
        // still unresolved.
        await new Promise(resolve => setTimeout(resolve, 500));
        if (!operationCurrent()) return null;

        const currentProject = getFreshActiveWatchingProject(projectId, activationToken);
        if (!currentProject || !operationCurrent()) return null;
        const stats = await getBoundedChokidarAddStats(filePath, operationCurrent);
        if (!stats || !operationCurrent()) return null;
        const addBelongsToCurrentSession = await isUnacceptedGenericChangeInCurrentWatchSession(
          currentProject,
          filePath,
          stats
        );
        // Fail closed when bounded filesystem evidence is unavailable. Accepted
        // files still return true from the helper so reopen/rescan behavior is
        // preserved without treating the add event as new authority.
        if (addBelongsToCurrentSession === null || !operationCurrent()) return null;

        const fileEntry = {
          path: filePath,
          name,
          ext,
          addedAt: Date.now(),
          source: 'chokidar-add',
        };
        if (!operationCurrent()) return null;
        const result = mutateProject(projectId, (proj) => {
          if (!operationCurrent()) return null;
          const staged = stageLiveObservedFile(proj, fileEntry, {
            allowDirect: addBelongsToCurrentSession === true,
            forcePending: addBelongsToCurrentSession !== true,
            appFamily: 'generic',
            reason: 'chokidar-add',
            captureReason: 'chokidar-add',
            observerMethod: 'chokidar-add',
            liveEvidence: {
              source: 'chokidar-add',
              observerMethod: 'chokidar-add',
            },
            captureSessionObserved: addBelongsToCurrentSession === true,
          });
          if (!staged.changed) return null;
          if (staged.decision === LIVE_CAPTURE_DECISIONS.DIRECT_ADD) {
            markCurrentSessionFilesystemEvidence(projectId, filePath, activationToken);
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
          if (!operationCurrent()) return null;
          sendProjectFileStateToRenderer(projectId, activationToken);
        }

        if (!operationCurrent()) return null;
        const updatedProject = getFreshActiveWatchingProject(projectId, activationToken);
        if (
          !updatedProject ||
          !operationCurrent() ||
          !isAcceptedProjectFilePath(updatedProject, filePath) ||
          !SCAN_ON_OPEN_EXTENSIONS.has(ext)
        ) return result;

        if (!operationCurrent()) return null;
        await runScanOnOpen(projectId, filePath, activationToken, operation);
        if (!operationCurrent()) return null;
        return result;
      }, {
        operationKey: normalizeTrackedFilePath(filePath),
        awaitDeferred: true,
      });
    }

    // v2.4.9: CHOKIDAR_IMAGE_EXTENSIONS block permanently removed.
    // Images are NEVER captured by chokidar — produces false positives (browser downloads).
    // Image capture paths: lsof poller, scan-on-open, lastUsed poller, ag-psd/extractEmbeddedMedia at package time.
    // See LEARNINGS.md: "Chokidar must NEVER capture image files."
  });

  // FIX 1: chokidar change handler uses mutateProject
  // v2.2.2: Also triggers scan-on-open when a design file is modified
  watcher.on('change', async (filePath, suppliedStats = null) => {
    if (!isActiveWatchingProject(projectId, activationToken)) return;
    const ext = path.extname(filePath).toLowerCase();
    const name = path.basename(filePath);
    if (name.startsWith('.') || name === 'Thumbs.db') return;
    if (name.startsWith('~$')) return;

    await new Promise(resolve => setTimeout(resolve, 500));
    if (!isActiveWatchingProject(projectId, activationToken)) return;

    // v2.2.6: Only re-scan PRIMARY design source files on change.
    // Same rationale as the 'add' handler — image/media changes are noise here.
    if (PRIMARY_DESIGN_EXTENSIONS.has(ext)) {
      const currentProject = getFreshActiveWatchingProject(projectId, activationToken);
      if (!currentProject) return;
      const changeBelongsToCurrentSession = await isUnacceptedGenericChangeInCurrentWatchSession(
        currentProject,
        filePath,
        suppliedStats
      );
      if (!changeBelongsToCurrentSession) {
        const latestProject = getFreshActiveWatchingProject(projectId, activationToken);
        if (!latestProject || !isAcceptedProjectFilePath(latestProject, filePath)) return;
      }
      if (!isActiveWatchingProject(projectId, activationToken)) return;

      const fileEntry = { path: filePath, name, ext, addedAt: Date.now() };
      const result = mutateProject(projectId, (proj) => {
        if (!isActiveWatchingProject(projectId, activationToken)) return null;
        const staged = stageLiveObservedFile(proj, fileEntry, {
          allowDirect: true,
          appFamily: 'generic',
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
        sendProjectFileStateToRenderer(projectId, activationToken);
      }

      const updatedProject = getProjects().find(p => p.id === projectId);
      const sourceIsAccepted = isAcceptedProjectFilePath(updatedProject, filePath);

      // v2.2.2: When a design file changes, re-scan for linked assets
      // (designer may have added new links). Fire-and-forget.
      // C3: Skip runScanOnOpen for .psd — scheduleScanOnSave handles it with debounce
      // to avoid double ag-psd parse on every .psd save event.
      if (sourceIsAccepted && SCAN_ON_OPEN_EXTENSIONS.has(ext) && ext !== '.psd') {
        runScanOnOpen(projectId, filePath, activationToken).catch(() => {});
      }

      // v2.5.0: Scan-on-save for PSD files — debounced, completely isolated pipeline.
      if (sourceIsAccepted && ext === '.psd') {
        scheduleScanOnSave(projectId, filePath, activationToken);
      }

      // v2.5.3: Scan-on-save for presentation files — extract embedded media live.
      if (sourceIsAccepted && (ext === '.pptx' || ext === '.key')) {
        scheduleScanOnSavePresentation(projectId, filePath, activationToken);
      }
    }

    // v2.4.9: CHOKIDAR_IMAGE_EXTENSIONS block permanently removed from 'change' handler too.
  });

  watchers.set(projectId, watcher);
  startLsofPolling(projectId, activationToken); // begin lsof polling for linked assets
  if (projectHasFigmaTrackedFiles(projectSnapshot)) {
    startFigmaPolling(projectId, activationToken); // begin Figma auto-tracking (if token is configured)
  }
  startPsPolling(projectId, activationToken);    // begin live app evidence refresh
  startLastUsedPolling(projectId, activationToken); // begin real-time kMDItemLastUsedDate polling (v2.3.3)
  return getIllustratorScopedProjectView(getProjects().find(project => project.id === projectId) || null);
}

function stopWatching(projectId, { invalidateActivation = true } = {}) {
  if (invalidateActivation) watchingActivationTokens.delete(projectId);
  cancelWatcherCoordinator(projectId);
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
  if (invalidateActivation) assetBaselineScans.delete(projectId);
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
              body: `No new design files for "${project.name}" in 3 hours. Click to open Crate.`,
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
          detail: `Crate hasn't detected any new design files in 3 hours. Would you like to keep watching or pause?`,
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

registerTrustedIpcHandler('projects:get-all', () => {
  const projects = getProjects();
  let changed = false;
  for (const project of projects) {
    if (normalizeAutoCaptureProjectState(project)) changed = true;
  }
  if (changed) {
    clearFileVisualProjectCache();
    store.set('projects', projects);
  }
  return projects.map(getIllustratorScopedProjectView);
});

registerTrustedIpcHandler('projects:create', async (event, name, projectType = 'automatic', figmaScopeMode = FIGMA_SCOPE_CURRENT_PAGE, figmaUrl = null) => {
  if (projectCreationInFlight) return { error: 'project_creation_in_flight' };

  const creation = (async () => {
    const projects = getProjects();

    // Enforce project cap
    if (projects.length >= MAX_PROJECTS) {
      return { error: 'max_projects_reached' };
    }

    const cleanedName = (name || '').trim() || 'Untitled Project';

    const scopeMode = VALID_FIGMA_SCOPE_MODES.has(figmaScopeMode)
      ? figmaScopeMode
      : FIGMA_SCOPE_CURRENT_PAGE;
    let figmaTrackedFiles = [];
    if (typeof figmaUrl === 'string' && figmaUrl.trim()) {
      const locator = createTrackedFigmaLocator(figmaUrl);
      if (!locator) {
        return { error: 'invalid_figma_url' };
      }
      const preflight = await preflightTrackedFigmaLocator(locator, scopeMode);
      if (!preflight.success) return { error: preflight.error };
      figmaTrackedFiles = [locator];
    }

    const newProject = {
      id: crypto.randomUUID(),
      name: cleanedName,
      type: projectType,
      figmaScopeMode: scopeMode,
      figmaTrackedFiles,
      status: 'paused',
      files: [],
      pendingFiles: [], // Tier 2 candidates awaiting user review
      assetBaseline: createAssetBaselineState(),
      excludedAssetKeys: [],
      createdAt: Date.now(),
      packagedAt: null,
      outputPath: null
    };
    safelyEnsureProjectProvenance(newProject);
    projects.push(newProject);
    clearFileVisualProjectCache();
    store.set('projects', projects);
    return await startWatching(newProject.id);
  })();

  projectCreationInFlight = creation;
  try {
    return await creation;
  } finally {
    if (projectCreationInFlight === creation) projectCreationInFlight = null;
  }
});

// Phase 2: per-project Figma link.
// payload: { action: 'preserve'|'replace'|'remove', url?: string, scopeMode }
// A blank replacement preserves the current link; removal must be explicit.
registerTrustedIpcHandler('projects:set-figma-link', async (event, projectId, payload = {}) => {
  const project = getProjects().find(p => p.id === projectId);
  if (!project) return { success: false, error: 'project_not_found' };

  const rawUrl = typeof payload.url === 'string' ? payload.url.trim() : '';
  const scopeMode = VALID_FIGMA_SCOPE_MODES.has(payload.scopeMode)
    ? payload.scopeMode
    : getProjectFigmaScopeMode(project);
  const action = payload.action === 'remove'
    ? 'remove'
    : (payload.action === 'replace' || rawUrl ? 'replace' : 'preserve');

  let figmaTrackedFiles = normalizeTrackedFigmaFiles(project.figmaTrackedFiles || []);
  if (action === 'remove') {
    figmaTrackedFiles = [];
  } else if (action === 'replace') {
    const locator = createTrackedFigmaLocator(rawUrl);
    if (!locator) {
      return { success: false, error: 'invalid_figma_url' };
    }
    figmaTrackedFiles = [locator];
  }

  if (action !== 'remove' && figmaTrackedFiles.length > 0) {
    const preflight = await preflightTrackedFigmaLocator(figmaTrackedFiles[0], scopeMode);
    if (!preflight.success) return { success: false, error: preflight.error };
  }

  const settings = store.get('settings') || {};
  const updated = mutateProject(projectId, (proj) => {
    proj.figmaTrackedFiles = figmaTrackedFiles;
    proj.figmaScopeMode = scopeMode;
    proj.figmaSession = buildFigmaSessionSnapshot(proj, settings);
    return proj;
  });
  figmaPackageTransferBlocks.delete(projectId);

  if (updated && trayWindow && !trayWindow.isDestroyed()) {
    trayWindow.webContents.send('project:updated', { projectId });
  }

  if (updated && updated.status === 'watching') {
    if (projectHasFigmaTrackedFiles(updated)) {
      const activationToken = getActiveWatchingActivationToken(projectId);
      if (activationToken !== null) startFigmaPolling(projectId, activationToken);
    } else {
      stopFigmaPolling(projectId);
    }
  }

  return { success: true, project: getIllustratorScopedProjectView(updated) };
});

registerTrustedIpcHandler('projects:start-watching', async (event, id) => {
  return await startWatching(id);
});

registerTrustedIpcHandler('projects:pause', (event, id) => {
  const project = mutateProject(id, (proj) => {
    proj.status = 'paused';
    return proj;
  });
  if (project) {
    stopWatching(id);
  }
  return getIllustratorScopedProjectView(getProjects().find(item => item.id === id) || null);
});

registerTrustedIpcHandler('projects:get-files', (event, id) => {
  const projects = getProjects();
  const project = projects.find(p => p.id === id);
  return project ? getIllustratorScopedProjectView(project).files : [];
});

registerTrustedIpcHandler('projects:get-asset-workspace', async (event, projectId) => {
  return await getProjectAssetWorkspace(projectId);
});

registerTrustedIpcHandler('projects:get-file-visual', async (event, projectId, visualIdentity, visualRevision) => {
  return await getProjectOwnedFileVisual(projectId, visualIdentity, visualRevision);
});

registerTrustedIpcHandler('projects:set-existing-assets-decision', (event, projectId, decision) => {
  return setProjectExistingAssetsDecision(projectId, decision);
});

registerTrustedIpcHandler('projects:remove-file', async (event, projectId, fileIdOrPath) => {
  const currentProject = getProjects().find(project => project.id === projectId);
  const currentFile = currentProject && currentProject.files.find(file => (
    matchesProjectFileIdentity(currentProject.id, file, fileIdOrPath)
  ));
  const failedSourceRemovalAllowed = !!(
    currentProject && currentFile && isProjectAssetBaselineSource(currentFile) &&
    await isFailedRequiredAssetBaselineSource(currentProject, currentFile)
  );
  let removed = false;
  let changed = false;
  const result = mutateProject(projectId, (project) => {
    // C2: Use fileId for removal when available (embedded files share the parent PSD path).
    // Fall back to path match for non-embedded files.
    const removedFile = project.files.find(file => (
      matchesProjectFileIdentity(project.id, file, fileIdOrPath)
    ));
    if (
      removedFile &&
      isProjectAssetBaselineSource(removedFile) &&
      !failedSourceRemovalAllowed
    ) {
      return project.files;
    }
    if (removedFile && inferProjectFileRole(removedFile) === 'asset') {
      const exclusionKey = getAssetReviewExclusionKey(removedFile);
      if (exclusionKey) {
        const priorExclusions = new Set(project.excludedAssetKeys || []);
        if (priorExclusions.has(exclusionKey)) {
          priorExclusions.delete(exclusionKey);
        } else {
          priorExclusions.add(exclusionKey);
        }
        project.excludedAssetKeys = [...priorExclusions];
        changed = true;
      }
      return project.files;
    }
    project.files = project.files.filter(file => (
      !matchesProjectFileIdentity(project.id, file, fileIdOrPath)
    ));
    removed = !!removedFile;
    changed = removed;
    return project.files;
  });
  if (result && changed) {
    if (removed) reconcileProjectAssetBaselineScanSources(projectId);
    invalidatePackageReviewForProject(projectId);
    sendToRenderer('project:updated', { projectId });
  }
  const project = getProjects().find(item => item.id === projectId);
  return project ? getIllustratorScopedProjectView(project).files : [];
});

// --- Tier 2: Accept / reject pending files ---

registerTrustedIpcHandler('projects:accept-pending', async (event, projectId, filePath) => {
  const operation = captureProjectOperation(projectId); if (!operation) return null;
  let acceptedSourceForScan = null;
  try {
    const result = mutateProject(projectId, (project) => {
      if (!operation.current()) return null;
      const idx = (project.pendingFiles || []).findIndex(f => (
        f.path === filePath || createProjectFileVisualIdentity(project.id, f) === filePath
      ));
    if (idx === -1) return null;
    if (!isIllustratorScopedFileAllowed(project, project.pendingFiles[idx])) return null;

    const [file] = project.pendingFiles.splice(idx, 1);
    const acceptedKey = getTrackedFileDedupKey(file);
    const acceptedPaths = getTrackedFileKeySet(project.files);

    if (!acceptedPaths.has(acceptedKey)) {
      const acceptedFile = {
        ...createAcceptedPendingFile(file),
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

    if (!result || !operation.current()) return null;

    sendProjectFileStateToRenderer(projectId, operation.activationToken);

    if (acceptedSourceForScan && SCAN_ON_OPEN_EXTENSIONS.has((acceptedSourceForScan.ext || path.extname(acceptedSourceForScan.path || '')).toLowerCase())) {
      const scanProject = getProjects().find(item => item.id === projectId);
      const baselineSources = scanProject?.assetBaseline?.status === 'awaiting-first-scan'
        ? getProjectAssetBaselineSourcePaths(scanProject)
        : [acceptedSourceForScan.path];
      const revisedScope = admitIllustratorSourcesForProject(projectId, baselineSources);
      if ((revisedScope && !operation.adoptScope(revisedScope)) || !operation.current()) return null;
      const scanReport = await runBoundedScanOnOpenQueue(
        projectId,
        baselineSources,
        operation.activationToken,
        operation,
        { allowPausedBaseline: true }
      );
      if (scanReport.cancelled) return null;
      if (!operation.current()) return null;
    }

    const view = getIllustratorScopedProjectView(getProjects().find(item => item.id === projectId));
    return operation.current() && view ? { files: view.files, pendingFiles: view.pendingFiles } : null;
  } finally { operation.close(); }
});

registerTrustedIpcHandler('projects:reject-pending', (event, projectId, filePath) => {
  const result = mutateProject(projectId, (project) => {
    const file = (project.pendingFiles || []).find(f => (
      f.path === filePath || createProjectFileVisualIdentity(project.id, f) === filePath
    ));
    project.pendingFiles = (project.pendingFiles || []).filter(f => f !== file);
    if (file) {
      recordPendingFileDecision(project, file, 'rejected');
    }
    return { pendingFiles: project.pendingFiles };
  });

  if (!result) return null;

  sendProjectFileStateToRenderer(projectId);

  const project = getProjects().find(item => item.id === projectId);
  return project ? getIllustratorScopedProjectView(project).pendingFiles : [];
});

registerTrustedIpcHandler('projects:cancel-add-files', (event, projectId, operationId) => {
  const operations = activeAddFilesOperations.get(projectId);
  if (!operations || operations.size === 0) return false;
  if (typeof operationId !== 'string' || !ADD_FILES_OPERATION_ID_PATTERN.test(operationId)) return false;
  const operation = operations.get(operationId) || [...operations.values()]
    .find(candidate => candidate.clientOperationId === operationId);
  return operation ? operation.cancel() : false;
});

registerTrustedIpcHandler('projects:add-files', async (event, projectId, requestedOperationId) => {
  const baseOperation = captureProjectOperation(projectId);
  if (!baseOperation) return null;
  const clientOperationId = typeof requestedOperationId === 'string' && ADD_FILES_OPERATION_ID_PATTERN.test(requestedOperationId)
    ? requestedOperationId
    : null;
  const operationId = crypto.randomUUID();
  let addFilesAttempt = null;
  let operation = baseOperation;
  let backgroundScanWork = Promise.resolve();
  let pickerPending = false;
  let pickerSettledPromise = Promise.resolve();
  const operationController = {
    clientOperationId,
    get pickerPending() { return pickerPending; },
    cancel() {
      baseOperation.close();
      return addFilesAttempt?.cancel('renderer-timeout') !== false;
    },
    waitForSettled() {
      return Promise.all([backgroundScanWork, pickerSettledPromise]);
    },
  };
  const projectOperations = activeAddFilesOperations.get(projectId) || new Map();
  if (pendingNativeAddFilesPickers.has(projectId) || projectOperations.size > 0) {
    baseOperation.close();
    return { success: false, error: 'add_files_operation_in_progress' };
  }
  if (projectOperations.has(operationId) || (
    clientOperationId && [...projectOperations.values()].some(operation => operation.clientOperationId === clientOperationId)
  )) {
    baseOperation.close();
    return { success: false, error: 'add_files_operation_conflict' };
  }
  projectOperations.set(operationId, operationController);
  activeAddFilesOperations.set(projectId, projectOperations);
  addFilesAttempt = createAddFilesAttempt({ timeoutMs: addFilesOperationTimeoutMs });
  operation = {
    activationToken: baseOperation.activationToken,
    close: () => baseOperation.close(),
    current: () => baseOperation.current() && addFilesAttempt.isCurrent(),
    adoptScope: scope => baseOperation.adoptScope(scope) && addFilesAttempt.isCurrent(),
  };
  try {
    // M6: Filter to supported design + image file types.
    const supportedExts = [...PRIMARY_DESIGN_EXTENSIONS, ...DESIGN_FILE_EXTENSIONS]
      .map(e => e.slice(1)); // strip leading dot
    const dialogPromise = dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      title: 'Add Files to Project',
      filters: [
        { name: 'Design & Image Files', extensions: [...new Set(supportedExts)] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    pickerPending = true;
    pendingNativeAddFilesPickers.add(projectId);
    pickerSettledPromise = dialogPromise.then(
      () => { pickerPending = false; pendingNativeAddFilesPickers.delete(projectId); },
      () => { pickerPending = false; pendingNativeAddFilesPickers.delete(projectId); }
    );
    const dialogOutcome = await Promise.race([
      dialogPromise.then(dialogResult => ({ dialogResult })),
      addFilesAttempt.timeoutPromise.then(deadline => ({ deadline })),
    ]);
    if (dialogOutcome.deadline) {
      if (dialogOutcome.deadline.timedOut) {
        addFilesAttempt.cancel('timeout');
        void dialogPromise.catch(() => {});
        return {
          success: false,
          error: 'add_files_timeout',
          timeoutMs: addFilesOperationTimeoutMs,
          selectedCount: 0,
          admittedCount: 0,
          completedCount: 0,
          failedCount: 0,
          scanResults: [],
          files: getIllustratorScopedProjectView(getProjects().find(project => project.id === projectId))?.files || [],
        };
      }
      void dialogPromise.catch(() => {});
      return null;
    }
    const dialogResult = dialogOutcome.dialogResult;
    if (dialogResult.canceled) return null;
    if (!operation.current()) {
      if (addFilesAttempt.state === 'timed-out' || addFilesAttempt.reason === 'timeout') {
        return {
          success: false,
          error: 'add_files_timeout',
          timeoutMs: addFilesOperationTimeoutMs,
          selectedCount: 0,
          admittedCount: 0,
          completedCount: 0,
          failedCount: 0,
          scanResults: [],
          files: getIllustratorScopedProjectView(getProjects().find(project => project.id === projectId))?.files || [],
        };
      }
      return null;
    }
    // Show the app window only for a still-current picker result. A native
    // dialog may resolve after timeout and must not foreground the app late.
    showTrayWindow();

    const filePaths = [...new Map(
      dialogResult.filePaths
        .map(filePath => [normalizeTrackedFilePath(filePath), filePath])
        .filter(([normalizedPath, filePath]) => normalizedPath && typeof filePath === 'string' && filePath)
    ).values()];
    let result = null;
    for (let offset = 0; offset < filePaths.length; offset += MANUAL_ADD_FILES_ADMISSION_BATCH_SIZE) {
      if (!operation.current()) break;
      const batch = filePaths.slice(offset, offset + MANUAL_ADD_FILES_ADMISSION_BATCH_SIZE);
      const batchResult = mutateProject(projectId, (project) => {
        if (!operation.current()) return null;
        const acceptedByKey = new Map();
        const excludedKeys = new Set(project.excludedAssetKeys || []);
        for (const file of project.files || []) {
          const key = getTrackedFileDedupKey(file);
          if (key && !acceptedByKey.has(key)) acceptedByKey.set(key, file);
        }
        const manuallyObservedFiles = [];
        for (const filePath of batch) {
          if (!operation.current()) return null;
          const fileEntry = {
            path: filePath,
            name: path.basename(filePath),
            ext: path.extname(filePath).toLowerCase(),
            addedAt: Date.now(),
            source: 'manual-browse', // M1
          };
          const key = getTrackedFileDedupKey(fileEntry);
          const existingFile = acceptedByKey.get(key);
          const authorizedFile = existingFile ? grantExplicitUserAuthority(existingFile) : fileEntry;
          const pendingFile = (project.pendingFiles || []).find(file => getTrackedFileDedupKey(file) === key);
          if (!existingFile) {
            project.files.push(authorizedFile);
            acceptedByKey.set(key, authorizedFile);
          }
          project.pendingFiles = (project.pendingFiles || []).filter(file => getTrackedFileDedupKey(file) !== key);
          for (const exclusionKey of [
            getAssetReviewExclusionKey(existingFile),
            getAssetReviewExclusionKey(pendingFile),
            getAssetReviewExclusionKey(authorizedFile),
            filePath,
          ]) {
            if (exclusionKey) excludedKeys.delete(exclusionKey);
          }
          manuallyObservedFiles.push(authorizedFile);
        }
        recordSessionObservedFiles(project, manuallyObservedFiles, {
          kind: OBSERVER_KINDS.MANUAL_USER_ACTION,
          method: 'projects:add-files',
          payload: { authoritySource: 'manual-browse' },
        });
        project.files = deduplicateFiles(project.files);
        project.excludedAssetKeys = [...excludedKeys];
        return project.files;
      }, { rollbackOnNull: true });
      if (batchResult) result = batchResult;
      if (!operation.current()) break;
      if (offset + batch.length < filePaths.length) await new Promise(resolve => setImmediate(resolve));
    }

    if (!result || !operation.current()) {
      if (addFilesAttempt.state === 'timed-out' || addFilesAttempt.reason === 'timeout') {
        const admittedKeys = new Set((result || []).map(getTrackedFileDedupKey).filter(Boolean));
        return {
          success: false,
          error: 'add_files_timeout',
          timeoutMs: addFilesOperationTimeoutMs,
          selectedCount: filePaths.length,
          // Admission is synchronous. If it completed before the deadline
          // fence was observed, report the persisted admission accurately;
          // scanning has not started at this boundary.
          admittedCount: filePaths.filter(filePath => admittedKeys.has(normalizeTrackedFilePath(filePath))).length,
          completedCount: 0,
          failedCount: 0,
          scanResults: [],
          files: getIllustratorScopedProjectView(getProjects().find(project => project.id === projectId))?.files || [],
        };
      }
      return null;
    }
    const revisedScope = admitIllustratorSourcesForProject(projectId, filePaths);
    if ((revisedScope && !operation.adoptScope(revisedScope)) || !operation.current()) return null;
    sendProjectFileStateToRenderer(projectId, operation.activationToken);

    const updatedProject = getProjects().find(project => project.id === projectId);
    if (updatedProject?.assetBaseline?.status === 'awaiting-first-scan') {
      const baselineSources = getProjectAssetBaselineSourcePaths(updatedProject);
      const scanReport = await runBoundedScanOnOpenQueue(
        projectId,
        baselineSources,
        operation.activationToken,
        operation,
        { allowPausedBaseline: true, addFilesAttempt, quiet: true }
      );
      backgroundScanWork = scanReport.settled || Promise.resolve();
      if (scanReport.timedOut) {
        const view = getIllustratorScopedProjectView(getProjects().find(project => project.id === projectId));
        const admittedKeys = new Set((result || []).map(getTrackedFileDedupKey).filter(Boolean));
        return {
          success: false,
          error: 'add_files_timeout',
          timeoutMs: addFilesOperationTimeoutMs,
          selectedCount: filePaths.length,
          admittedCount: filePaths.filter(filePath => admittedKeys.has(normalizeTrackedFilePath(filePath))).length,
          completedCount: scanReport.outcomes.filter(outcome => outcome?.success).length,
          failedCount: scanReport.outcomes.filter(outcome => outcome && !outcome.success).length,
          scanResults: scanReport.outcomes,
          files: view ? view.files : [],
        };
      }
      if (scanReport.cancelled || !operation.current()) return null;
      const failedScans = scanReport.outcomes.filter(outcome => outcome && !outcome.success);
      if (failedScans.length > 0) {
        const view = getIllustratorScopedProjectView(getProjects().find(project => project.id === projectId));
        const admittedKeys = new Set((result || []).map(getTrackedFileDedupKey).filter(Boolean));
        return {
          success: false,
          error: 'add_files_partial_scan_failure',
          selectedCount: filePaths.length,
          admittedCount: filePaths.filter(filePath => admittedKeys.has(normalizeTrackedFilePath(filePath))).length,
          completedCount: scanReport.outcomes.length - failedScans.length,
          failedCount: failedScans.length,
          scanResults: scanReport.outcomes,
          files: view ? view.files : [],
        };
      }
    }
    return getIllustratorScopedProjectView(getProjects().find(project => project.id === projectId)).files;
  } finally {
    operation.close();
    if (addFilesAttempt?.isCurrent()) addFilesAttempt.cancel('cancelled');
    // Release targeted-cancellation ownership as soon as the IPC operation
    // ends. Any parser work still settling is already cancelled/fenced and
    // must not delay the user-visible result or retain the operation map.
    const releaseOperation = () => {
      if (projectOperations.get(operationId) === operationController) projectOperations.delete(operationId);
      if (projectOperations.size === 0) activeAddFilesOperations.delete(projectId);
    };
    // Native picker cancellation is not portable. Release the logical slot
    // immediately after timeout/cancellation so a late dialog cannot block a
    // retry forever; operation.current() fences the late selection.
    releaseOperation();
    Promise.resolve(backgroundScanWork)
      .catch(() => {})
      .finally(() => addFilesAttempt?.dispose());
  }
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
async function runPackageScanPhase(operation, timeoutMs, work, onTimeout = null) {
  let timeoutId = null;
  const workResult = Promise.resolve().then(work).then(
    () => ({ status: 'complete' }),
    error => ({ status: 'error', error })
  );
  const timeoutResult = new Promise(resolve => {
    timeoutId = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
  });
  const result = await Promise.race([workResult, timeoutResult]);
  if (timeoutId) clearTimeout(timeoutId);
  if (result.status === 'error') throw result.error;
  if (result.status === 'timeout') {
    operation.close();
    if (typeof onTimeout === 'function') onTimeout(workResult);
    return false;
  }
  return true;
}

registerTrustedIpcHandler('projects:pre-package-scan', async (event, projectId) => {
  if (scanInFlight.has(projectId)) {
    return createPackageReviewErrorResult(projectId, 'package_scan_incomplete', {
      failurePhase: 'pre-package-scan-in-flight',
      phaseElapsedMs: 0,
    }, false);
  }
  const operation = captureProjectOperation(projectId); if (!operation) return null;
  const operationCurrent = operation.current;
  const stagePrePackageFile = (project, file, observation) => {
    if (!operationCurrent()) return null;
    const staged = stageLiveObservedFile(project, file, observation);
    if (staged?.changed) clearFileVisualProjectCache(projectId);
    return staged;
  };
  // FIX 2 (C2): Track scan in-flight so package handler can wait
  scanInFlight.add(projectId);
  incompletePackageScans.delete(projectId);
  packageScanDiagnosticState.delete(projectId);
  const previousFigmaPackageBlock = figmaPackageTransferBlocks.get(projectId);
  try {
  const watcherDrainStartedAt = Date.now();
  const watcherDrained = await pauseWatcherCoordinatorForPackage(projectId);
  if (!watcherDrained) {
    const drainDiagnostic = {
      failurePhase: 'background-watch-drain',
      phaseElapsedMs: Math.max(0, Date.now() - watcherDrainStartedAt),
      candidateCount: 0,
      xattrResolvedCount: 0,
      metadataFallbackCount: 0,
    };
    incompletePackageScans.add(projectId);
    packageScanDiagnosticState.set(projectId, drainDiagnostic);
    invalidatePackageReviewForProject(projectId);
    return createPackageReviewErrorResult(projectId, 'package_scan_incomplete', drainDiagnostic);
  }
  const projects = getProjects();
  let project = projects.find(p => p.id === projectId);
  if (!project || !operationCurrent()) return null;
  figmaPackageTransferBlocks.delete(projectId);
  let figmaPackageError = null;

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
  const scanMetrics = {
    candidateCount: 0,
    xattrResolvedCount: 0,
    metadataFallbackCount: 0,
  };
  let metadataDiscoveryFailed = false;
  let psdRecoveryIncomplete = false;

  const discoveryStartedAt = Date.now();
  const discoveryComplete = await runPackageScanPhase(operation, PRE_PACKAGE_DISCOVERY_TIMEOUT_MS, async () => {
  // v1.3.29: Live lsof pass at package time — captures .fig files currently open in Figma,
  // bypassing Spotlight indexing delay. Runs once synchronously before the scan loops.
  try {
    const figmaPids = [];
    const { stdout: psOut } = await execAsync("/bin/ps ax -o pid= -o command= 2>/dev/null", { timeout: 5000, encoding: "utf8" });
    if (!operationCurrent()) return;
    for (const line of psOut.trim().split("\n")) {
      const m = line.trim().match(/^\s*(\d+)\s+(.+)$/);
      if (m && m[2].includes("Figma")) figmaPids.push(m[1]);
    }
    if (figmaPids.length > 0) {
      const { stdout: lsofOut } = await execAsync(
        `/usr/sbin/lsof -F n -p ${figmaPids.join(",")} 2>/dev/null`,
        { timeout: 10000, encoding: "utf8" }
      );
      if (!operationCurrent()) return;
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
        const staged = stagePrePackageFile(project, fileEntry, {
          forcePending: true,
          appFamily: 'figma',
          reason: 'pre-package-lsof-scan',
        });
        if (!staged || !staged.changed) continue;
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
          const staged = stagePrePackageFile(project, fileEntry, {
            forcePending: true,
            appFamily: 'figma',
            reason: 'pre-package-fig-scan',
          });
          if (!staged || !staged.changed) continue;
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
  const lastUsedCandidates = [];
  const collectLastUsedCandidates = async (folder, depth) => {
    let entries;
    try { entries = await fs.promises.readdir(folder, { withFileTypes: true }); }
    catch (e) { return; }
    if (!operationCurrent()) return;
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
      const entry = entries[entryIndex];
      const fullPath = path.join(folder, entry.name);
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory() && depth < 3) {
        await collectLastUsedCandidates(fullPath, depth + 1);
        if (!operationCurrent()) return;
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!DESIGN_FILE_EXTENSIONS.has(ext) || isAutoCaptureExcludedPath(fullPath)) continue;
      const normalizedFullPath = normalizeTrackedFilePath(fullPath);
      if (existingPaths.has(normalizedFullPath) || pendingPaths.has(normalizedFullPath)) continue;
      lastUsedCandidates.push({ fullPath, name: entry.name, ext, normalizedFullPath });
      scanMetrics.candidateCount++;
      if (lastUsedCandidates.length % 256 === 0) {
        await new Promise(resolve => setImmediate(resolve));
        if (!operationCurrent()) return;
      }
    }
  };

  for (const dir of scanDirs) {
    if (fs.existsSync(dir)) await collectLastUsedCandidates(dir, 0);
    if (!operationCurrent()) return;
  }

  const recentLastUsedCandidates = new Array(lastUsedCandidates.length).fill(false);
  let xattrTimes;
  let spotlightRecentCandidateIndexes;
  try {
    const requiredSpotlightRoots = getRequiredSpotlightRoots(scanDirs);
    const metadataResults = await Promise.allSettled([
      collectBulkXattrLastUsedMs(lastUsedCandidates, operationCurrent),
      getBulkSpotlightRecentCandidateIndexes(
        requiredSpotlightRoots,
        watchStart,
        lastUsedCandidates,
        operationCurrent
      ),
    ]);
    if (!operationCurrent()) return;
    if (metadataResults.some(result => result.status === 'rejected')) {
      metadataDiscoveryFailed = true;
      return;
    }
    xattrTimes = metadataResults[0].value;
    spotlightRecentCandidateIndexes = metadataResults[1].value;
    if (lastUsedCandidates.some(candidate => {
      try { return !fs.statSync(candidate.fullPath).isFile(); }
      catch (_) { return true; }
    })) {
      metadataDiscoveryFailed = true;
      return;
    }
  } catch (_) {
    metadataDiscoveryFailed = true;
    return;
  }

  for (let candidateIndex = 0; candidateIndex < lastUsedCandidates.length; candidateIndex++) {
    const candidate = lastUsedCandidates[candidateIndex];
    const xattrTime = xattrTimes.get(candidate.fullPath);
    if (xattrTime !== null) scanMetrics.xattrResolvedCount++;
    if (xattrTime === null || xattrTime < watchStart) scanMetrics.metadataFallbackCount++;
    recentLastUsedCandidates[candidateIndex] =
      (xattrTime !== null && xattrTime >= watchStart) ||
      spotlightRecentCandidateIndexes.has(candidateIndex);
  }

  for (let candidateIndex = 0; candidateIndex < lastUsedCandidates.length; candidateIndex++) {
    if (!recentLastUsedCandidates[candidateIndex]) continue;
    const candidate = lastUsedCandidates[candidateIndex];
    const fileEntry = buildAutoCaptureFileEntry(candidate.fullPath, 'lastused-scan', {
      name: candidate.name,
      ext: candidate.ext,
    });
    const staged = stagePrePackageFile(project, fileEntry, {
      forcePending: true,
      appFamily: 'generic',
      reason: 'pre-package-lastused-scan',
    });
    if (!staged || !staged.changed) continue;
    if (staged.decision === LIVE_CAPTURE_DECISIONS.DIRECT_ADD) {
      existingPaths.add(candidate.normalizedFullPath);
    } else if (staged.decision === LIVE_CAPTURE_DECISIONS.PENDING_CANDIDATE) {
      pendingPaths.add(candidate.normalizedFullPath);
    }
    newCount++;
  }
  }, settlement => packageScanSettlements.set(projectId, settlement));
  const discoveryElapsedMs = Math.max(0, Date.now() - discoveryStartedAt);
  if (!discoveryComplete) {
    incompletePackageScans.add(projectId);
    packageScanDiagnosticState.set(projectId, {
      ...scanMetrics,
      failurePhase: 'pre-package-discovery',
      phaseElapsedMs: discoveryElapsedMs,
    });
    return createPackageReviewErrorResult(projectId, 'package_scan_incomplete');
  }
  if (!operationCurrent()) return null;
  if (metadataDiscoveryFailed) {
    restoreFigmaPackageTransferBlock(projectId, previousFigmaPackageBlock);
    incompletePackageScans.add(projectId);
    packageScanDiagnosticState.set(projectId, {
      ...scanMetrics,
      failurePhase: 'pre-package-discovery',
      phaseElapsedMs: discoveryElapsedMs,
    });
    return createPackageReviewErrorResult(projectId, 'package_scan_incomplete');
  }

  // v2.4.2: 30s aggregate timeout wrapping all AppleScript + ag-psd queries
  const appScanStartedAt = Date.now();
  const appScanComplete = await runPackageScanPhase(operation, PRE_PACKAGE_APP_SCAN_TIMEOUT_MS, async () => {
  const illustratorActivationToken = getActiveWatchingActivationToken(projectId);
  if (illustratorActivationToken !== null) {
    const illustratorQuery = await queryIllustratorActiveState(projectId, illustratorActivationToken); if (!operationCurrent()) return;
    if (!illustratorQuery.stale && getFreshActiveWatchingProject(projectId, illustratorActivationToken)) {
      const scopeResult = updateIllustratorActivationScope(projectId, illustratorActivationToken, illustratorQuery, false); if (!scopeResult || !operation.adoptScope(scopeResult.scope) || !operationCurrent()) return;
      if (scopeResult && scopeResult.ready) {
        const records = createIllustratorLiveEvidenceRecords(projectId, illustratorQuery.activeState, scopeResult.project, { skipped: {} }), refreshed = applyLiveAppEvidenceRefresh(projectId, records, illustratorActivationToken); newCount += refreshed.stagedCount || 0;
        project = getFreshActiveWatchingProject(projectId, illustratorActivationToken) || project;
        for (const file of project.files || []) existingPaths.add(normalizeTrackedFilePath(file.path));
        for (const file of project.pendingFiles || []) pendingPaths.add(normalizeTrackedFilePath(file.path));
      }
    }
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
    if (!operationCurrent()) return;

    if (psPsCheck.trim()) {
      const { stdout: psPaths } = await runOsascriptInPrivateTemp(
        ({ resolveScriptPath }) => ({
          'crate-ps-scan.js': PS_DOJAVASCRIPT,
          'crate-ps-scan.applescript': psDoJavascriptAS(resolveScriptPath('crate-ps-scan.js')),
        }),
        'crate-ps-scan.applescript',
        { timeout: 10000, encoding: 'utf8' }
      ).catch(() => ({ stdout: '' }));
      if (!operationCurrent()) return;

      if (psPaths.trim()) {
        for (const trimmed of psPaths.split('\n').filter(Boolean)) {
          if (isAutoCaptureExcludedPath(trimmed)) continue;
          const normalizedTrimmed = normalizeTrackedFilePath(trimmed);
          if (existingPaths.has(normalizedTrimmed) || pendingPaths.has(normalizedTrimmed)) continue;
          if (!fs.existsSync(trimmed)) continue;
          const ext = path.extname(trimmed).toLowerCase();
          if (!DESIGN_FILE_EXTENSIONS.has(ext)) continue;

          const fileEntry = buildAutoCaptureFileEntry(trimmed, 'psd-linked', { ext });
          const staged = stagePrePackageFile(project, fileEntry, {
            forcePending: true,
            appFamily: 'photoshop',
            reason: 'pre-package-app-script-broad-observer',
          });
          if (!staged || !staged.changed) continue;
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
      const embeddedRecords = project.files.filter(file => file && file.source === 'psd-embedded');
      // A legacy embedded record without the source digest and stable embedded
      // identity cannot be proven to belong to the current PSD contents. Do
      // not package it silently; require an explicit recovery pass instead.
      if (embeddedRecords.some(file => (
        !normalizeTrackedFilePath(file.parentPsd || '') ||
        typeof file.sourceDigest !== 'string' ||
        !/^\w{64}$/.test(file.sourceDigest) ||
        !Number.isInteger(file.embeddedIndex) ||
        typeof file.embeddedOriginalName !== 'string' ||
        !file.embeddedOriginalName.trim()
      ))) {
        psdRecoveryIncomplete = true;
        return;
      }
      const relatedEmbeddedRecords = embeddedRecords.filter(file => (
        normalizeTrackedFilePath(file.parentPsd || '') === normalizeTrackedFilePath(psdFile.path)
      ));
      if (relatedEmbeddedRecords.length > 0) {
        let currentSourceDigest;
        try {
          const beforeDigestStat = await fs.promises.stat(psdFile.path);
          currentSourceDigest = await getAddFilesCurrentSourceDigest(psdFile.path, {
            isCurrent: operationCurrent,
          });
          const afterDigestStat = await fs.promises.stat(psdFile.path);
          if (!isAddFilesSourceIdentityCurrent(afterDigestStat, getAddFilesSourceIdentity(beforeDigestStat))) {
            psdRecoveryIncomplete = true;
            return;
          }
        } catch (_) {
          psdRecoveryIncomplete = true;
          return;
        }
        if (relatedEmbeddedRecords.some(file => file.sourceDigest !== currentSourceDigest)) {
          // Existing cache bytes are tied to an older PSD. Fail closed so the
          // stale embedded assets cannot remain packageable after a source edit.
          psdRecoveryIncomplete = true;
          return;
        }
        continue;
      }
      const psdAssets = await extractPsdAssets(psdFile.path, projectId, operationCurrent);
      if (!operationCurrent()) { psdAssets.release?.(); return; }
      for (const asset of psdAssets) {
        const normalizedAssetPath = normalizeTrackedFilePath(asset.filePath);
        if (existingPaths.has(normalizedAssetPath) || pendingPaths.has(normalizedAssetPath)) continue;
        const fileEntry = buildAutoCaptureFileEntry(asset.filePath, asset.source, {
          parentPsd: psdFile.path,
          embeddedOriginalName: asset.embeddedOriginalName || null,
          embeddedIndex: Number.isInteger(asset.embeddedIndex) ? asset.embeddedIndex : null,
          sourceDigest: asset.sourceDigest || null,
        });
        const staged = stagePrePackageFile(project, fileEntry, {
          relationshipSourcePath: psdFile.path,
          appFamily: 'photoshop',
          reason: 'pre-package-psd-parser',
        });
        if (!staged || !staged.changed) continue;
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
    if (!operationCurrent()) return;

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
      if (!operationCurrent()) return;

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
          const staged = stagePrePackageFile(project, fileEntry, {
            forcePending: true,
            appFamily: 'indesign',
            reason: 'pre-package-app-script-broad-observer',
          });
          if (!staged || !staged.changed) continue;
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
  }, settlement => packageScanSettlements.set(projectId, settlement));
  const appScanElapsedMs = Math.max(0, Date.now() - appScanStartedAt);
  if (!appScanComplete) {
    incompletePackageScans.add(projectId);
    packageScanDiagnosticState.set(projectId, {
      ...scanMetrics,
      failurePhase: 'pre-package-app-scan',
      phaseElapsedMs: appScanElapsedMs,
    });
    return createPackageReviewErrorResult(projectId, 'package_scan_incomplete');
  }
  if (psdRecoveryIncomplete) {
    const recoveryDiagnostic = {
      ...scanMetrics,
      failurePhase: 'pre-package-app-scan',
      phaseElapsedMs: appScanElapsedMs,
    };
    incompletePackageScans.add(projectId);
    packageScanDiagnosticState.set(projectId, recoveryDiagnostic);
    invalidatePackageReviewForProject(projectId);
    return createPackageReviewErrorResult(projectId, 'package_scan_incomplete', recoveryDiagnostic);
  }
  if (!operationCurrent()) return null;

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
        if (!operationCurrent()) return null;
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
          const staged = stagePrePackageFile(project, fileEntry, {
            relationshipSourcePath: designFile.path,
            appFamily: getExplicitCaptureAppFamily(designFile) || 'generic',
            reason: 'pre-package-linked-regex',
          });
          if (!staged || !staged.changed) continue;
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
    clearFileVisualProjectCache(projectId);
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
        if (!operationCurrent()) return null;
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
          const staged = stagePrePackageFile(project, fileEntry, {
            relationshipSourcePath: file.path,
            appFamily: getExplicitCaptureAppFamily(file) || 'generic',
            reason: 'pre-package-doublecheck',
          });
          if (!staged || !staged.changed) continue;
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
      clearFileVisualProjectCache(projectId);
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
    if (!operationCurrent()) return null;
    const scanFiles = project.files;
    const scanPending = project.pendingFiles || [];
    const merged = mutateProject(projectId, (proj) => {
      if (!operationCurrent()) return null;
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
    if (!operationCurrent()) return null;
    if (merged) {
      project.files = merged.files;
      clearFileVisualProjectCache(projectId);
    }
  }

  // Figma authoritative recovery pass for package-time scan.
  // Keeps local lsof/.fig heuristics as-is and supplements with cloud originals.
  try {
    if (!operationCurrent()) return null;
    const ensuredSession = ensureProjectFigmaSession(projectId);
    const latestProject = getProjects().find(p => p.id === projectId) || project;
    const figmaSession = latestProject.figmaSession || ensuredSession || null;
    const rawTrackedFiles = (figmaSession && Array.isArray(figmaSession.trackedFiles)) ? figmaSession.trackedFiles : [];
    const scanTrackedFiles = expandFigmaTrackedFilesForScan(rawTrackedFiles);
    const teamIds = (figmaSession && Array.isArray(figmaSession.teamIds)) ? figmaSession.teamIds : [];
    const fileKeys = scanTrackedFiles.map(entry => entry.key);
    const trackedCandidateCount = new Set(
      fileKeys.filter(key => typeof key === 'string' && key.trim())
    ).size;
    const safeTrackedFileSummaries = summarizeTrackedFigmaFilesForLog(rawTrackedFiles);

    if (teamIds.length > 0 || fileKeys.length > 0) {
      if (!operationCurrent()) return null;
      figmaPackageTransferBlocks.set(projectId, FIGMA_PACKAGE_TRANSFER_ERROR);
      const activeRetryAt = getFigmaRateLimitRetryAt(projectId, latestProject);
      if (activeRetryAt > Date.now()) {
        updateFigmaSessionRateLimitWarning(projectId, activeRetryAt);
        figmaPackageError = FIGMA_PACKAGE_TRANSFER_ERROR;
        sendToRenderer('project:updated', { projectId });
      } else {
        const { FigmaParser } = require('./parsers/figma');
        const parser = new FigmaParser();
        console.log(
          `[crate][figma] scan config (pre-package): ` +
          `trackedFileCount=${safeTrackedFileSummaries.length} ` +
          `trackedFiles=${JSON.stringify(safeTrackedFileSummaries)} ` +
          `trackedCandidateCount=${trackedCandidateCount} ` +
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
        if (!operationCurrent()) return null;

        mergeFigmaScopeEntriesIntoSession(projectId, figmaScanResult.scopeEntries || []);
        const candidateDiagnostics = summarizeFigmaCandidateDiagnosticsForLog(figmaScanResult.candidateDiagnostics);
        const retryAfterMs = getFigmaScanRetryAfterMs(figmaScanResult);
        const isRateLimited = figmaScanResult.rateLimited === true ||
          hasFigmaRateLimitDiagnostic(candidateDiagnostics) ||
          retryAfterMs !== null;

        if (figmaScanResult.errors && figmaScanResult.errors.length > 0) {
          console.warn('[crate][figma] pre-package scan errors:', summarizeFigmaErrorsForLog(figmaScanResult.errors));
        }

        if (
          hasFigmaAuthError(figmaScanResult.errors) ||
          hasFigmaInvalidTokenDiagnostic(candidateDiagnostics)
        ) {
          const warningUpdate = markProjectFigmaConnectionUnavailable(projectId);
          if (warningUpdate) sendToRenderer('project:updated', { projectId });
          sendToRenderer('figma:auth-error', { projectId, error: 'Figma token expired or invalid — reconnect in Settings' });
        }

        if (isRateLimited) {
          const retryAt = setFigmaRateLimitBackoff(projectId, retryAfterMs);
          updateFigmaSessionRateLimitWarning(projectId, retryAt);
          sendToRenderer('project:updated', { projectId });
        }

        if (!isRateLimited && figmaScanResult.assets && figmaScanResult.assets.length > 0) {
          const scopedAssets = figmaScanResult.assets.map((asset) => ({
            ...asset,
            figmaScopeMode: getProjectFigmaScopeMode(latestProject)
          }));
          const figmaAdded = await ingestFigmaAssetsIntoProject(
            projectId, project, scopedAssets, 'pre-package', operation.activationToken, operationCurrent
          );
          if (!operationCurrent()) return null;
          newCount += figmaAdded;
        }
        if (!operationCurrent()) return null;
        if (didFigmaPrePackageScanSucceed(figmaScanResult, rawTrackedFiles)) {
          figmaPackageTransferBlocks.delete(projectId);
          const clearedRateLimit = clearFigmaRateLimitState(projectId);
          if (clearedRateLimit) sendToRenderer('project:updated', { projectId });
        } else {
          figmaPackageError = FIGMA_PACKAGE_TRANSFER_ERROR;
          figmaPackageTransferBlocks.set(projectId, figmaPackageError);
        }
      }
    }
  } catch (e) {
    if (!operationCurrent()) return null;
    console.warn('[crate][figma] pre-package recovery failed:', redactFigmaLogText(e.message));
    if (figmaPackageTransferBlocks.has(projectId)) {
      figmaPackageError = FIGMA_PACKAGE_TRANSFER_ERROR;
      figmaPackageTransferBlocks.set(projectId, figmaPackageError);
    }
  }

  if (!operationCurrent()) return null;
  project.files = deduplicateFiles(project.files);
  clearFileVisualProjectCache(projectId);
  const finalProject = getProjects().find(item => item.id === projectId);
  incompletePackageScans.delete(projectId);
  packageScanDiagnosticState.set(projectId, {
    ...scanMetrics,
    phaseElapsedMs: discoveryElapsedMs + appScanElapsedMs,
  });
  return {
    files: getIllustratorScopedProjectView(finalProject).files,
    newCount,
    ...(figmaPackageError ? { error: figmaPackageError } : {}),
  };
  } finally {
    resumeWatcherCoordinatorAfterPackage(projectId);
    if (!operation.current()) restoreFigmaPackageTransferBlock(projectId, previousFigmaPackageBlock);
    operation.close();
    const settlement = packageScanSettlements.get(projectId);
    if (settlement) {
      settlement.finally(() => {
        if (packageScanSettlements.get(projectId) !== settlement) return;
        packageScanSettlements.delete(projectId);
        scanInFlight.delete(projectId);
      });
    } else {
      scanInFlight.delete(projectId);
    }
    scheduleDeletedProjectCacheCleanup(projectId);
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

async function extractEmbeddedArchiveEntryData(presentationPath, zipPath, ext, listedZipPaths, options = {}) {
  try {
    const { stdout: data } = await runCancellableExecFile('/usr/bin/unzip', ['-p', presentationPath, zipPath], {
      timeout: 10000, maxBuffer: 50 * 1024 * 1024,
      encoding: 'buffer',
      ...options,
    });
    return { data, outputTail: ext === '.key' ? getKeynoteArchiveEntryOutputTail(zipPath) : null };
  } catch (exactError) {
    if (ext !== '.key') throw exactError;
    if (!isAddFilesParserCurrent(options)) throw exactError;

    const fallback = getUniqueKeynoteWildcardFallback(zipPath, listedZipPaths);
    if (!fallback) throw exactError;

    const { stdout: data } = await runCancellableExecFile('/usr/bin/unzip', ['-p', presentationPath, fallback.wildcardPath], {
      timeout: 10000, maxBuffer: 50 * 1024 * 1024,
      encoding: 'buffer',
      ...options,
    });
    return { data, outputTail: getKeynoteArchiveEntryOutputTail(zipPath, fallback.tail) || fallback.tail };
  }
}

function getPackageContentFingerprint(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return `${buffer.length}:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

function isPackageContentFingerprint(value) {
  return typeof value === 'string' && /^\d+:[0-9a-f]{64}$/.test(value);
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
  const logicalPresentationPath = options.logicalPresentationPath || presentationPath;
  const ext = path.extname(logicalPresentationPath).toLowerCase();
  const base = path.basename(logicalPresentationPath, ext);
  const extracted = [];
  const invocationFiles = [];
  let extractionCompleted = false;
  let expectedOutputIndex = 0;
  if (ext !== '.pptx' && ext !== '.key') return extracted;

  // v1.3.10: Build a set of base names already captured by chokidar/lsof.
  // Normalise: lowercase, strip extension, collapse whitespace.
  // If chokidar already captured "shopping (6).webp", the embedded copy
  // ("shopping (6).jpeg") is a lower-quality duplicate — skip it. Prior
  // scan-on-save media is intentionally excluded from this name set because
  // Keynote can save multiple distinct pasted images as pasted-image-NNNN.jpeg;
  // exact duplicates are handled by content fingerprints below.
  const alreadyCapturedBases = new Set(
    Array.isArray(options.dedupNameBases)
      ? options.dedupNameBases.filter(value => typeof value === 'string')
      : []
  );
  if (!Array.isArray(options.dedupNameBases) && projectFiles) {
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
  // check each extracted entry against it. Same size + same SHA-256 = same file.
  const contentFingerprints = new Set(
    Array.isArray(options.dedupFingerprints)
      ? options.dedupFingerprints.filter(isPackageContentFingerprint)
      : []
  );
  const capturedSizes = new Set();
  for (const fingerprint of contentFingerprints) {
    capturedSizes.add(Number(fingerprint.slice(0, fingerprint.indexOf(':'))));
  }
  if (!Array.isArray(options.dedupFingerprints) && (ext === '.pptx' || ext === '.key') && projectFiles) {
    for (const f of projectFiles) {
      const candidateExt = path.extname(f && (f.path || f.name) || '').toLowerCase();
      if (!EMBEDDED_MEDIA_EXTENSIONS.has(candidateExt)) continue;
      try {
        const buf = await readFileWithAddFilesCancellation(f.path, options.addFilesAttempt);
        capturedSizes.add(buf.length);
        contentFingerprints.add(getPackageContentFingerprint(buf));
      } catch (e) {
        // file may no longer exist on disk — skip
      }
    }
  }
  const extractedPresentationFingerprints = new Set(contentFingerprints);

  try {
    // List the zip contents — format: "  length  MM-DD-YYYY HH:MM  filename"
    const { stdout: listing } = await runCancellableExecFile("/usr/bin/unzip", ["-l", presentationPath], {
      timeout: 10000, encoding: 'utf8', ...options,
    });

    const listingLines = listing.split('\n');
    const listedZipPaths = listingLines
      .map(line => {
        const m = line.match(/^\s+(\d+)\s+(\d{2}-\d{2}-\d{4})\s+(\d{2}:\d{2})\s+(.+)$/);
        return m ? m[4].trim() : null;
      })
      .filter(Boolean);

    for (const line of listingLines) {
      if (!isAddFilesParserCurrent(options)) throw new Error('add_files_parser_cancelled');
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
        (ext === '.pptx')                    ? zipPath.startsWith('ppt/media/') :
        (ext === '.key')                     ? zipPath.startsWith('Data/')       :
        false;
      if (!inMediaFolder) continue;

      // v1.3.36: Date filter removed — pre-existing embedded assets are always
      // relevant. Keynote junk is handled by the st-/mt-/bg-/tx-UUID and -small
      // filters below. PowerPoint's ppt/media/ only contains used images.

      // Skip tiny files — likely blank placeholders (e.g. blankMoviePosterImage)
      if (fileSize < 500) {
        if (!options.quiet) console.log(`[crate] skipped tiny embedded file: ${path.basename(zipPath)} (${fileSize} bytes)`);
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
          if (!options.quiet) console.log(`[crate] skipped Keynote slide thumbnail: ${entryName}`);
          continue;
        }

        // v1.3.15+: Keynote internal theme/template assets.
        // mt- = media/theme images (template backgrounds, textures, UI elements)
        // bg- = background images baked into the theme
        // tx- = texture assets used by theme styles
        // All follow the same {prefix}-{UUID}.jpg naming pattern as st- thumbnails.
        // These are NOT user content — they ship with the Keynote theme/template.
        if (/^(mt|bg|tx)-[0-9a-f-]+\.jpe?g$/i.test(entryName)) {
          if (!options.quiet) console.log(`[crate] skipped Keynote theme/template asset: ${entryName}`);
          continue;
        }

        // Internal thumbnail/small variants of user images.
        // Keynote creates e.g. "shopping (6)-small-9073.jpeg" for every inserted image.
        // The optional -NNNN is Keynote's numeric suffix appended to all embedded files.
        if (/-small(-\d{3,6})?\.[a-z]+$/i.test(entryName)) {
          if (!options.quiet) console.log(`[crate] skipped Keynote thumbnail variant: ${entryName}`);
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
          if (!options.quiet) console.log(`[crate] skipped duplicate (already captured): ${entryName} → matches "${baseName}"`);
          continue;
        }
      }

      try {
        if (!isAddFilesParserCurrent(options)) throw new Error('add_files_parser_cancelled');
        const { data, outputTail } = await extractEmbeddedArchiveEntryData(
          presentationPath,
          zipPath,
          ext,
          listedZipPaths,
          options
        );
        let extractedFingerprint = null;

        // v1.3.18: Content-based dedup for presentation media — skip if
        // identical to a captured file.
        if (ext === '.pptx' || ext === '.key') {
          const extractedSize = data.length;
          extractedFingerprint = getPackageContentFingerprint(data);
          if (typeof options.onCandidate === 'function') {
            options.onCandidate({
              presentationPath: logicalPresentationPath,
              internalPath: zipPath,
              contentFingerprint: extractedFingerprint,
            });
          }
          const resource = getPresentationMediaResourceIdentity(logicalPresentationPath, zipPath);
          const suppressedOccurrence = resource && (options.suppressedOccurrences || []).some(occurrence => (
            occurrence &&
            occurrence.resourceKey === resource.resourceKey &&
            occurrence.contentFingerprint === extractedFingerprint
          ));
          if (suppressedOccurrence) continue;
          if (extractedPresentationFingerprints.has(extractedFingerprint)) {
            if (capturedSizes.has(extractedSize)) {
              if (!options.quiet) console.log(`[crate] skipped duplicate (content match): ${path.basename(zipPath)} (${extractedSize} bytes)`);
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

        const usesPackagePlan = options.planOnly || Array.isArray(options.expectedOutputs);
        const reservedOutputName = usesPackagePlan ? options.reserveOutputName(outputName) : null;
        const descriptor = usesPackagePlan ? {
          internalPath: zipPath,
          outputName: reservedOutputName,
          relativePath: typeof options.getOutputRelativePath === 'function'
            ? options.getOutputRelativePath(reservedOutputName)
            : reservedOutputName,
          size: data.length,
          sha256: crypto.createHash('sha256').update(data).digest('hex'),
          contentFingerprint: extractedFingerprint,
        } : null;
        if (descriptor && Array.isArray(options.expectedOutputs)) {
          const expectedOutput = options.expectedOutputs[expectedOutputIndex++];
          if (!expectedOutput || JSON.stringify(descriptor) !== JSON.stringify(expectedOutput)) {
            throw new PackageReviewChangedError();
          }
        }
        if (descriptor && typeof options.onPlanned === 'function') options.onPlanned(descriptor);
        if (options.planOnly) continue;

        if (!isAddFilesParserCurrent(options)) throw new Error('add_files_parser_cancelled');

        if (typeof options.onBeforeMaterialize === 'function') options.onBeforeMaterialize();
        const destPath = descriptor
          ? (typeof options.resolveOutputPath === 'function'
              ? options.resolveOutputPath(descriptor.relativePath)
              : resolveExactPackagePath(destFolder, descriptor.relativePath, {
                  fallbackName: 'file',
                  preserveRelativePath: true,
                }))
          : resolveUniquePackagePath(destFolder, outputName);
        if (
          descriptor &&
          typeof options.resolveOutputPath !== 'function' &&
          path.relative(destFolder, destPath).split(path.sep).join('/') !== descriptor.relativePath
        ) throw new PackageReviewChangedError();
        if (typeof options.onBeforeWrite === 'function') options.onBeforeWrite(destPath);
        if (typeof options.materializeBuffer === 'function') {
          await options.materializeBuffer(destPath, data, OWNER_ONLY_FILE_MODE);
        } else {
          await fs.promises.writeFile(destPath, data, { flag: 'wx' });
        }
        if (typeof options.onAfterWrite === 'function') options.onAfterWrite(destPath);
        if (options.rollbackOnFailure || typeof options.onMaterialized === 'function') {
          const materialized = captureOwnedDirectCacheFile(destPath, destFolder, 'presentation-cache-file');
          if (options.rollbackOnFailure) invocationFiles.push(materialized);
          if (typeof options.onMaterialized === 'function') options.onMaterialized(materialized);
        }
        extracted.push(destPath);
        if (typeof options.onExtracted === 'function') {
          try {
            options.onExtracted({
              presentationPath: logicalPresentationPath,
              internalPath: zipPath,
              materializedPath: destPath,
              source: options.source || 'package-extraction',
              observedAt: Date.now(),
            });
          } catch (provenanceErr) {
            console.warn('[crate][provenance] presentation media extraction callback skipped:', provenanceErr.message);
          }
        }
        if (!options.quiet) console.log(`[crate] extracted embedded media: ${outputName} (date: ${m[2]})`);
      } catch (e) {
        if (e instanceof PackageTransactionInvariantError || e instanceof PackageReviewChangedError) throw e;
        if (options.failClosed) throw new PackageReviewChangedError();
        const message = formatEmbeddedMediaExtractionFailure(logicalPresentationPath, zipPath);
        console.error(`[crate] ${message}`);
        if (typeof options.onExtractionError === 'function') {
          try {
            options.onExtractionError({
              presentationPath: logicalPresentationPath,
              internalPath: zipPath,
              message,
            });
          } catch (callbackErr) {
            console.warn('[crate] embedded media extraction error callback skipped');
          }
        }
      }
    }
    if (Array.isArray(options.expectedOutputs) && expectedOutputIndex !== options.expectedOutputs.length) {
      throw new PackageReviewChangedError();
    }
    extractionCompleted = true;
  } catch (e) {
    if (e instanceof PackageTransactionInvariantError || e instanceof PackageReviewChangedError) throw e;
    if (options.failClosed) throw new PackageReviewChangedError();
    const message = formatEmbeddedMediaInspectionFailure(logicalPresentationPath);
    console.error(`[crate] ${message}`);
    if (typeof options.onInspectionError === 'function') {
      try {
        options.onInspectionError({
          presentationPath: logicalPresentationPath,
          message,
        });
      } catch (callbackErr) {
        console.warn('[crate] embedded media inspection error callback skipped');
      }
    }
  } finally {
    if (options.rollbackOnFailure && !extractionCompleted) {
      removeOwnedDirectCacheFiles(invocationFiles);
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

function isScanOnSaveEmbeddedPsdFile(file) {
  return !!(file && file.embedded && file.source === 'scan-on-save-embedded');
}

function findEmbeddedPsdLinkedFileMatch(file, linkedFiles) {
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
    return hasData(linkedFile) && matchesFile(linkedFile)
      ? { linkedFile, embeddedIndex: file.embeddedIndex }
      : null;
  }

  const matches = linkedFiles
    .map((linkedFile, embeddedIndex) => ({ linkedFile, embeddedIndex }))
    .filter(match => hasData(match.linkedFile) && matchesFile(match.linkedFile));
  return matches.length === 1 ? matches[0] : null;
}

function hasInFlightPackageInputScan(projectId) {
  return scanInFlight.has(projectId) ||
    hasInFlightAssetBaselineScan(projectId) ||
    figmaInProgress.has(projectId) ||
    figmaManualScanInFlight.has(projectId);
}

async function waitForPackageInputScans(projectId, timeoutMs = PACKAGE_SCAN_WAIT_TIMEOUT_MS) {
  const scanWaitStart = Date.now();
  while (hasInFlightPackageInputScan(projectId) && Date.now() - scanWaitStart < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return !hasInFlightPackageInputScan(projectId);
}

function packageReviewStatValue(value) {
  return typeof value === 'bigint' ? value.toString() : String(value ?? 0);
}

function serializePackageReviewStat(stat) {
  return {
    dev: packageReviewStatValue(stat.dev),
    ino: packageReviewStatValue(stat.ino),
    mode: packageReviewStatValue(stat.mode),
    nlink: packageReviewStatValue(stat.nlink),
    size: packageReviewStatValue(stat.size),
    mtimeNs: packageReviewStatValue(stat.mtimeNs),
    ctimeNs: packageReviewStatValue(stat.ctimeNs),
  };
}

function serializePackageReviewIdentityStat(stat) {
  return {
    dev: packageReviewStatValue(stat.dev),
    ino: packageReviewStatValue(stat.ino),
    mode: packageReviewStatValue(stat.mode),
  };
}

function getPackageReviewParentFingerprint(sourcePath) {
  const parentPath = path.dirname(path.resolve(sourcePath));
  const linkStat = fs.lstatSync(parentPath, { bigint: true });
  const targetStat = fs.statSync(parentPath, { bigint: true });
  if (!targetStat.isDirectory()) throw new Error('package_source_parent_unavailable');
  return {
    normalizedPath: parentPath.normalize('NFC').toLowerCase(),
    realPath: normalizeTrackedFilePath(parentPath),
    link: serializePackageReviewIdentityStat(linkStat),
    target: serializePackageReviewIdentityStat(targetStat),
  };
}

function getPackageReviewSourceFingerprint(sourcePath) {
  const normalizedPath = normalizeTrackedFilePath(sourcePath);
  if (!normalizedPath) return { state: 'virtual' };

  try {
    const parent = getPackageReviewParentFingerprint(sourcePath);
    const linkStat = fs.lstatSync(sourcePath, { bigint: true });
    if (linkStat.isSymbolicLink()) {
      return { state: 'symlink', normalizedPath, parent, link: serializePackageReviewStat(linkStat) };
    }
    if (!linkStat.isFile()) {
      return { state: 'unavailable', normalizedPath, parent, link: serializePackageReviewStat(linkStat) };
    }
    const sourceStat = fs.statSync(sourcePath, { bigint: true });
    return {
      state: 'present',
      normalizedPath,
      parent,
      link: serializePackageReviewStat(linkStat),
      source: serializePackageReviewStat(sourceStat),
    };
  } catch (error) {
    return { state: error?.code === 'ENOENT' ? 'missing' : 'unavailable', normalizedPath };
  }
}

function getPackageReviewManifestEntry(file) {
  const embeddedPsd = isScanOnSaveEmbeddedPsdFile(file);
  const sourcePath = embeddedPsd ? (file.parentPsd || file.path) : file && file.path;
  const displayName = getPackageFileDisplayName(file);
  const ext = (file && (file.ext || path.extname(displayName || sourcePath || '')) || '').toLowerCase();
  const identity = embeddedPsd
    ? {
        kind: 'embedded-psd',
        parentPath: normalizeTrackedFilePath(sourcePath),
        embeddedIndex: Number.isInteger(file.embeddedIndex) ? file.embeddedIndex : null,
        embeddedOriginalName: typeof file.embeddedOriginalName === 'string' ? file.embeddedOriginalName : '',
        outputName: displayName,
      }
    : (typeof sourcePath === 'string' && sourcePath.trim()
      ? { kind: 'file', normalizedPath: normalizeTrackedFilePath(sourcePath) }
      : {
          kind: 'virtual',
          source: getFileCaptureSource(file) || 'unknown',
          fileId: typeof file?.fileId === 'string' ? file.fileId : '',
          outputName: displayName,
        });

  return {
    identity,
    sourceFingerprint: getPackageReviewSourceFingerprint(sourcePath),
    displayName,
    ext,
    embedded: embeddedPsd,
  };
}

function readStablePsdForPackageReview(sourcePath, expectedFingerprint) {
  const beforeFingerprint = getPackageReviewSourceFingerprint(sourcePath);
  if (!packageReviewFingerprintsMatch(expectedFingerprint, beforeFingerprint)) {
    throw new PackageReviewChangedError();
  }

  let descriptor;
  let fd = null;
  try {
    fd = fs.openSync(sourcePath, 'r');
    const beforeStat = fs.fstatSync(fd, { bigint: true });
    if (
      !beforeStat.isFile() ||
      beforeStat.size > BigInt(MAX_PARSE_FILE_SIZE) ||
      !packageReviewFingerprintsMatch(expectedFingerprint.source, serializePackageReviewStat(beforeStat))
    ) {
      throw new PackageReviewChangedError();
    }
    const buffer = fs.readFileSync(fd);
    const afterStat = fs.fstatSync(fd, { bigint: true });
    if (!packageReviewFingerprintsMatch(expectedFingerprint.source, serializePackageReviewStat(afterStat))) {
      throw new PackageReviewChangedError();
    }
    descriptor = readPsd(buffer, { skipLayerImageData: true, skipCompositeImageData: true });
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }

  if (!packageReviewFingerprintsMatch(expectedFingerprint, getPackageReviewSourceFingerprint(sourcePath))) {
    throw new PackageReviewChangedError();
  }
  return descriptor;
}

function getStablePackageReviewSourceContentFingerprint(sourcePath, expectedFingerprint) {
  const beforeFingerprint = getPackageReviewSourceFingerprint(sourcePath);
  if (!packageReviewFingerprintsMatch(expectedFingerprint, beforeFingerprint)) {
    throw new PackageReviewChangedError();
  }

  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
  let fd = null;
  try {
    fd = fs.openSync(sourcePath, fs.constants.O_RDONLY | noFollow);
    const beforeStat = fs.fstatSync(fd, { bigint: true });
    if (
      !beforeStat.isFile() ||
      !packageReviewFingerprintsMatch(expectedFingerprint.source, serializePackageReviewStat(beforeStat))
    ) {
      throw new PackageReviewChangedError();
    }

    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }

    const afterStat = fs.fstatSync(fd, { bigint: true });
    if (!packageReviewFingerprintsMatch(expectedFingerprint.source, serializePackageReviewStat(afterStat))) {
      throw new PackageReviewChangedError();
    }
    return `${size}:${hash.digest('hex')}`;
  } finally {
    if (fd !== null) fs.closeSync(fd);
    if (!packageReviewFingerprintsMatch(expectedFingerprint, getPackageReviewSourceFingerprint(sourcePath))) {
      throw new PackageReviewChangedError();
    }
  }
}

function getEmbeddedPsdResourceFingerprint(match) {
  const data = Buffer.from(match.linkedFile.data);
  return {
    embeddedIndex: match.embeddedIndex,
    nameSha256: crypto.createHash('sha256').update(String(match.linkedFile.name || '')).digest('hex'),
    size: data.length,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    contentFingerprint: getPackageContentFingerprint(data),
  };
}

function bindEmbeddedPsdPackageReviewResources(files, entries) {
  const parsedBySource = new Map();
  entries.forEach((entry, entryIndex) => {
    if (!entry.embedded || entry.sourceFingerprint.state !== 'present') return;
    const file = files[entryIndex];
    const sourcePath = file && (file.parentPsd || file.path);
    if (!sourcePath) return;

    const cacheKey = JSON.stringify({
      normalizedPath: entry.sourceFingerprint.normalizedPath,
      source: entry.sourceFingerprint.source,
    });
    let parsed = parsedBySource.get(cacheKey);
    if (!parsed) {
      try {
        parsed = { psd: readStablePsdForPackageReview(sourcePath, entry.sourceFingerprint) };
      } catch (_) {
        parsed = { psd: null };
      }
      parsedBySource.set(cacheKey, parsed);
    }
    if (!parsed.psd) return;

    const match = findEmbeddedPsdLinkedFileMatch(file, parsed.psd.linkedFiles || []);
    if (!match) return;
    entry.embeddedResource = getEmbeddedPsdResourceFingerprint(match);
  });
}

const PACKAGE_PRESENTATION_EXTENSIONS = new Set(['.key', '.pptx']);

function getSkippedExistingPresentationMediaSuppression(project) {
  const fingerprints = new Set();
  const nameBases = new Set();
  const occurrences = normalizePresentationMediaOccurrences(
    project && project.assetBaseline && project.assetBaseline.presentationMediaOccurrences
  );
  if (!project || project.assetBaseline?.decision !== 'skip') {
    return { fingerprints: [], nameBases: [], occurrences: [] };
  }

  for (const file of project.files || []) {
    if (
      !file ||
      file.assetOrigin !== 'existing' ||
      file.projectRole !== 'asset' ||
      !isAssetReviewFileExcluded(project, file)
    ) continue;
    const ext = path.extname(file.path || file.name || '').toLowerCase();
    if (!EMBEDDED_MEDIA_EXTENSIONS.has(ext)) continue;

    if (file.source === 'scan-on-save-presentation') {
      continue;
    } else if (isPackageContentFingerprint(file.presentationContentFingerprint)) {
      fingerprints.add(file.presentationContentFingerprint);
    } else if (typeof file.path === 'string') {
      const sourceFingerprint = getPackageReviewSourceFingerprint(file.path);
      if (sourceFingerprint.state === 'present') {
        fingerprints.add(getStablePackageReviewSourceContentFingerprint(file.path, sourceFingerprint));
      }
    }

    if (file.source !== 'scan-on-save-presentation') {
      const displayName = file.name || path.basename(file.path || '');
      const base = path.basename(displayName, path.extname(displayName))
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
      if (base) nameBases.add(base);
    }
  }

  return {
    fingerprints: [...fingerprints].sort(),
    nameBases: [...nameBases].sort(),
    occurrences,
  };
}

function getPackageReviewEntryStatus(entry) {
  if (entry.sourceFingerprint.state !== 'present') {
    return entry.sourceFingerprint.state === 'virtual' ? 'unmaterializable' : entry.sourceFingerprint.state;
  }
  if (entry.identity.kind === 'file') return 'ready';
  if (entry.identity.kind === 'embedded-psd' && !entry.embeddedResource) return 'unavailable';
  if (
    entry.identity.kind === 'embedded-psd' &&
    entry.embeddedResource &&
    entry.identity.parentPath &&
    ((Number.isInteger(entry.identity.embeddedIndex) && entry.identity.embeddedIndex >= 0) ||
      entry.identity.embeddedOriginalName || entry.identity.outputName)
  ) return 'ready';
  return 'unmaterializable';
}

function packagePlanRelativePathCollisionKey(relativePath) {
  return `${relativePath || ''}`
    .normalize('NFC')
    .toUpperCase()
    .toLowerCase()
    .normalize('NFC');
}

function createAuthoritativePackageOutputAllocator(layoutMode) {
  const normalizedLayoutMode = normalizePackageOutputLayoutMode(layoutMode);
  const allocateName = createPackageNameAllocator();
  const relativePathByOutputName = new Map();
  const usedRelativePathKeys = new Set();

  const reserveNameOnly = rawName => allocateName(rawName);
  const reserveOutputName = rawName => {
    for (let attempt = 0; attempt < MAX_PACKAGE_PLAN_PATH_ALLOCATION_ATTEMPTS; attempt++) {
      const outputName = allocateName(rawName);
      const relativePath = getPackageOutputRelativePath(outputName, normalizedLayoutMode);
      const relativePathKey = packagePlanRelativePathCollisionKey(relativePath);
      if (usedRelativePathKeys.has(relativePathKey)) continue;
      usedRelativePathKeys.add(relativePathKey);
      relativePathByOutputName.set(outputName, relativePath);
      return outputName;
    }
    throw new PackageReviewChangedError();
  };

  return {
    reserveNameOnly,
    reserveOutputName,
    getOutputRelativePath(outputName) {
      const relativePath = relativePathByOutputName.get(outputName);
      if (!relativePath) throw new PackageReviewChangedError();
      return relativePath;
    },
  };
}

async function buildAuthoritativePackagePlan(
  files,
  entries,
  packageSettings,
  destinationFolderName,
  presentationSuppression = { fingerprints: [], nameBases: [], occurrences: [] }
) {
  const layoutMode = normalizePackageOutputLayoutMode(packageSettings.outputLayoutMode);
  const outputAllocator = createAuthoritativePackageOutputAllocator(layoutMode);
  const allocateOutputName = outputAllocator.reserveOutputName;
  const getOutputRelativePath = outputAllocator.getOutputRelativePath;
  const reviewedSourceInputs = [];
  const deterministicDerivedOutputs = [];
  const outputNamesByEntryIndex = [];
  const diagnosticsMetadata = packageSettings.includeDiagnosticReport ? {
    materialization: 'crate-provenance-v2',
    schemaVersion: DIAGNOSTIC_MANIFEST_SCHEMA_VERSION,
    relativePath: path.posix.join(outputAllocator.reserveNameOnly(DIAGNOSTICS_FOLDER_NAME), PROVENANCE_MANIFEST_FILENAME),
  } : null;
  entries.forEach((entry, entryIndex) => {
    const outputName = allocateOutputName(entry.displayName);
    outputNamesByEntryIndex[entryIndex] = outputName;
    if (entry.embedded) {
      deterministicDerivedOutputs.push({
        sourceEntryIndex: entryIndex,
        materialization: 'psd-embedded-resource',
        expectedOutputs: [{
          outputName,
          relativePath: getOutputRelativePath(outputName),
          resourceFingerprint: entry.embeddedResource,
        }],
      });
    } else {
      reviewedSourceInputs.push({
        entryIndex,
        materialization: 'source-copy',
        expectedOutputName: outputName,
        relativePath: getOutputRelativePath(outputName),
      });
    }
  });

  const presentationEntryIndexes = [];
  const seenPresentationSources = new Set();
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const entry = entries[entryIndex];
    if (entry.embedded || !PACKAGE_PRESENTATION_EXTENSIONS.has(entry.ext)) continue;
    const sourceIdentity = JSON.stringify(entry.identity);
    if (seenPresentationSources.has(sourceIdentity)) continue;
    seenPresentationSources.add(sourceIdentity);
    presentationEntryIndexes.push(entryIndex);
  }

  const presentationDedupFingerprints = new Set(
    (presentationSuppression.fingerprints || []).filter(isPackageContentFingerprint)
  );
  const dedupFingerprintBySource = new Map();
  if (presentationEntryIndexes.length > 0) {
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
      const outputName = outputNamesByEntryIndex[entryIndex];
      if (!EMBEDDED_MEDIA_EXTENSIONS.has(path.extname(outputName || '').toLowerCase())) continue;

      const entry = entries[entryIndex];
      let contentFingerprint = entry.embeddedResource?.contentFingerprint || null;
      if (!entry.embedded) {
        const cacheKey = JSON.stringify(entry.sourceFingerprint);
        contentFingerprint = dedupFingerprintBySource.get(cacheKey) || null;
        if (!contentFingerprint) {
          contentFingerprint = getStablePackageReviewSourceContentFingerprint(
            files[entryIndex].path,
            entry.sourceFingerprint
          );
          dedupFingerprintBySource.set(cacheKey, contentFingerprint);
        }
      }
      if (!isPackageContentFingerprint(contentFingerprint)) throw new PackageReviewChangedError();
      presentationDedupFingerprints.add(contentFingerprint);
    }
  }

  const dedupNameBases = [...new Set([
    ...(presentationSuppression.nameBases || []),
    ...entries
    .map((entry, entryIndex) => {
      if (files[entryIndex]?.source === 'scan-on-save-presentation') return null;
      const displayName = entry.displayName || '';
      return path.basename(displayName, path.extname(displayName)).toLowerCase().replace(/\s+/g, ' ').trim();
    })
    .filter(Boolean),
  ])].sort();

  for (const entryIndex of presentationEntryIndexes) {
    const expectedOutputs = [];
    const dedupFingerprints = [...presentationDedupFingerprints].sort();
    const suppressedOccurrences = normalizePresentationMediaOccurrences(
      presentationSuppression.occurrences
    );
    await extractEmbeddedMedia(files[entryIndex].path, null, files, {
      planOnly: true,
      failClosed: true,
      dedupFingerprints,
      dedupNameBases,
      suppressedOccurrences,
      reserveOutputName: allocateOutputName,
      getOutputRelativePath,
      onPlanned: output => expectedOutputs.push(output),
    });
    for (const output of expectedOutputs) {
      if (!isPackageContentFingerprint(output.contentFingerprint)) throw new PackageReviewChangedError();
      presentationDedupFingerprints.add(output.contentFingerprint);
    }
    deterministicDerivedOutputs.push({
      sourceEntryIndex: entryIndex,
      materialization: 'presentation-media',
      dedupFingerprints,
      dedupNameBases,
      suppressedOccurrences,
      expectedOutputs,
    });
  }
  return {
    schemaVersion: 2,
    collisionPolicy: 'stable-macos-nfc-casefold-v1',
    layoutMode,
    packageSettings,
    destinationFolderName,
    reviewedSourceInputs,
    deterministicDerivedOutputs,
    diagnosticsMetadata,
  };
}

function getRelevantPackageReviewSettings() {
  const settings = store.get('settings') || {};
  return {
    includeDiagnosticReport: settings.includeDiagnosticReport === true,
    namingTemplate: sanitizeNamingTemplate(settings.namingTemplate),
    outputLayoutMode: getPackageOutputLayoutModeFromSettings(settings),
  };
}

function getReviewedPackageFolderName(project, packageSettings, now = new Date()) {
  const dateStr = now.toISOString().split('T')[0];
  return sanitizePackageFolderName(
    packageSettings.namingTemplate
      .replace('{Project}', cleanName(project.name))
      .replace('{Date}', dateStr)
  );
}

function getPackageSelectionInputSignature(project) {
  if (!project) return null;
  const scopedProject = getIllustratorScopedProjectView(project);
  if (!scopedProject) return null;
  const illustratorScope = getIllustratorActivationScope(project.id);
  const acceptedPendingNodeIds = (project.provenance?.observations || [])
    .filter(observation => observation?.observer?.method === 'projects:accept-pending')
    .map(observation => observation.objectNodeId)
    .filter(value => typeof value === 'string')
    .sort();
  const input = {
    files: Array.isArray(scopedProject.files) ? scopedProject.files : [],
    assetBaseline: project.assetBaseline || null,
    excludedAssetKeys: Array.isArray(project.excludedAssetKeys) ? project.excludedAssetKeys : [],
    watchStartedAt: project.watchStartedAt || null,
    createdAt: project.createdAt || null,
    figmaScopeMode: getProjectFigmaScopeMode(project),
    figmaSession: project.figmaSession || null,
    acceptedPendingNodeIds,
    illustratorScope: illustratorScope ? {
      revision: illustratorScope.revision,
      status: illustratorScope.status,
      baselineDocumentPaths: [...illustratorScope.baselineDocumentPaths].sort(),
      admittedDocumentPaths: [...illustratorScope.admittedDocumentPaths].sort(),
      allowedLinkedPaths: [...illustratorScope.allowedLinkedPaths].sort(),
      excludedLinkedPaths: [...illustratorScope.excludedLinkedPaths].sort(),
    } : null,
  };
  try {
    return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
  } catch (_) {
    return null;
  }
}

async function buildCanonicalPackageReviewManifest(projectId) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const project = getProjects().find(item => item && item.id === projectId);
    if (!project) return { error: 'not_found' };
    if (projectHasUnresolvedLocalAssetBaseline(project)) {
      return { error: 'asset_baseline_scan_incomplete' };
    }
    if (project.assetBaseline && project.assetBaseline.status === 'decision-required') {
      return { error: 'asset_baseline_decision_required' };
    }
    const inputSignature = getPackageSelectionInputSignature(project);
    const packageSettings = getRelevantPackageReviewSettings();
    const packageSettingsKey = JSON.stringify(packageSettings);
    if (!inputSignature) return { error: 'package_review_unavailable' };

    const files = await selectProjectFilesForPackaging(project);
    const currentProject = getProjects().find(item => item && item.id === projectId);
    if (!currentProject) return { error: 'not_found' };
    if (inputSignature !== getPackageSelectionInputSignature(currentProject)) continue;
    if (packageSettingsKey !== JSON.stringify(getRelevantPackageReviewSettings())) continue;

    const entries = files.map(getPackageReviewManifestEntry);
    bindEmbeddedPsdPackageReviewResources(files, entries);
    const entryStatuses = entries.map(getPackageReviewEntryStatus);
    if (entryStatuses.some(status => status !== 'ready')) {
      return {
        project: currentProject,
        files,
        entries,
        entryStatuses,
        materializable: false,
      };
    }
    let plan;
    try {
      plan = await buildAuthoritativePackagePlan(
        files,
        entries,
        packageSettings,
        getReviewedPackageFolderName(currentProject, packageSettings),
        getSkippedExistingPresentationMediaSuppression(currentProject)
      );
    } catch (error) {
      if (error instanceof PackageReviewChangedError) {
        return {
          project: currentProject,
          files,
          entries,
          entryStatuses: entries.map(entry => PACKAGE_PRESENTATION_EXTENSIONS.has(entry.ext) ? 'unavailable' : 'ready'),
          materializable: false,
        };
      }
      throw error;
    }
    const finalProject = getProjects().find(item => item && item.id === projectId);
    if (!finalProject || inputSignature !== getPackageSelectionInputSignature(finalProject)) continue;
    if (packageSettingsKey !== JSON.stringify(getRelevantPackageReviewSettings())) continue;
    const finalEntries = files.map(getPackageReviewManifestEntry);
    bindEmbeddedPsdPackageReviewResources(files, finalEntries);
    if (!packageReviewFingerprintsMatch(entries, finalEntries)) continue;
    const manifestKey = crypto.createHash('sha256').update(JSON.stringify({ entries, plan })).digest('hex');
    return {
      project: finalProject,
      files,
      entries,
      plan,
      manifestKey,
      materializable: true,
    };
  }
  return { error: 'package_review_unstable' };
}

function cleanExpiredPackageReviewTokens(now = Date.now()) {
  for (const [token, snapshot] of packageReviewSnapshots) {
    if (snapshot.expiresAt > now) continue;
    packageReviewSnapshots.delete(token);
    if (currentPackageReviewTokenByProject.get(snapshot.projectId) === token) {
      currentPackageReviewTokenByProject.delete(snapshot.projectId);
    }
  }
  for (const [token, expiresAt] of consumedPackageReviewTokens) {
    if (expiresAt <= now) consumedPackageReviewTokens.delete(token);
  }
}

function hasConsumedPackageReviewToken(token, now = Date.now()) {
  const expiresAt = consumedPackageReviewTokens.get(token);
  if (expiresAt === undefined) return false;
  if (expiresAt <= now) {
    consumedPackageReviewTokens.delete(token);
    return false;
  }
  consumedPackageReviewTokens.delete(token);
  consumedPackageReviewTokens.set(token, expiresAt);
  return true;
}

function rememberConsumedPackageReviewToken(token, expiresAt) {
  consumedPackageReviewTokens.delete(token);
  while (consumedPackageReviewTokens.size >= CONSUMED_PACKAGE_REVIEW_TOKEN_CAPACITY) {
    const leastRecentlyUsed = consumedPackageReviewTokens.keys().next().value;
    if (leastRecentlyUsed === undefined) break;
    consumedPackageReviewTokens.delete(leastRecentlyUsed);
  }
  consumedPackageReviewTokens.set(token, expiresAt);
}

function invalidatePackageReviewForProject(projectId) {
  const token = currentPackageReviewTokenByProject.get(projectId);
  if (token) packageReviewSnapshots.delete(token);
  currentPackageReviewTokenByProject.delete(projectId);
}

function invalidateAllPackageReviews() {
  packageReviewSnapshots.clear();
  currentPackageReviewTokenByProject.clear();
}

function getPackageReviewEntryFolder(plan, entryIndex) {
  const reviewedSource = plan.reviewedSourceInputs.find(item => item.entryIndex === entryIndex);
  let relativePath = reviewedSource?.relativePath || null;
  if (!relativePath) {
    const derivedOutput = plan.deterministicDerivedOutputs
      .find(item => item.sourceEntryIndex === entryIndex && item.materialization === 'psd-embedded-resource')
      ?.expectedOutputs?.[0];
    relativePath = derivedOutput?.relativePath || null;
  }
  if (!relativePath) return null;
  if (plan.layoutMode === PACKAGE_OUTPUT_LAYOUT_MODES.FLAT) return 'Package root';
  const directory = path.posix.dirname(relativePath);
  return directory && directory !== '.' ? directory : 'Package root';
}

async function issuePackageReviewSnapshot(projectId, manifest, destinationBinding = null) {
  if (!manifest.materializable || !manifest.plan || !manifest.manifestKey) {
    throw new Error('Cannot issue an unmaterializable package review');
  }
  cleanExpiredPackageReviewTokens();
  invalidatePackageReviewForProject(projectId);
  const token = crypto.randomUUID();
  const snapshot = {
    projectId,
    manifestKey: manifest.manifestKey,
    expiresAt: Date.now() + PACKAGE_REVIEW_TOKEN_TTL_MS,
    ...(destinationBinding ? { destinationBinding } : {}),
  };
  packageReviewSnapshots.set(token, snapshot);
  currentPackageReviewTokenByProject.set(projectId, token);
  const presentations = await Promise.all(
    manifest.files.map(file => createRendererFilePresentation(manifest.project, file))
  );
  return {
    token,
    projectId,
    files: manifest.entries.map((entry, index) => ({
      ...presentations[index],
      name: entry.displayName,
      ext: entry.ext,
      embedded: entry.embedded,
      packageFolder: getPackageReviewEntryFolder(manifest.plan, index),
      status: 'ready',
    })),
    totalFiles: manifest.entries.length,
    materializable: true,
    folderName: destinationBinding?.folderName || manifest.plan.destinationFolderName,
    planSummary: {
      reviewedSourceInputCount: manifest.plan.reviewedSourceInputs.length,
      visibleDerivedDesignCount: manifest.plan.deterministicDerivedOutputs.filter(item => item.materialization === 'psd-embedded-resource').length,
      derivedDesignGeneratorCount: manifest.plan.deterministicDerivedOutputs.filter(item => item.materialization === 'presentation-media').length,
      diagnosticsMetadataIncluded: !!manifest.plan.diagnosticsMetadata,
      outputLayoutMode: manifest.plan.layoutMode,
    },
  };
}

async function createUnavailablePackageReview(projectId, manifest) {
  invalidatePackageReviewForProject(projectId);
  const presentations = await Promise.all(
    manifest.files.map(file => createRendererFilePresentation(manifest.project, file))
  );
  return {
    projectId,
    files: manifest.entries.map((entry, index) => ({
      ...presentations[index],
      name: entry.displayName,
      ext: entry.ext,
      embedded: entry.embedded,
      status: manifest.entryStatuses[index] || 'unavailable',
    })),
    totalFiles: manifest.entries.length,
    materializable: false,
    message: 'Some files are unavailable. Resolve them before packaging.',
  };
}

async function createPackageReviewResponse(projectId, manifest, destinationBinding = null) {
  return manifest.materializable
    ? await issuePackageReviewSnapshot(projectId, manifest, destinationBinding)
    : await createUnavailablePackageReview(projectId, manifest);
}

function consumePackageReviewSnapshot(projectId, token) {
  const now = Date.now();
  cleanExpiredPackageReviewTokens(now);
  if (typeof token !== 'string' || token.length > 64 || !PACKAGE_REVIEW_TOKEN_PATTERN.test(token)) {
    return { error: token ? 'package_review_invalid' : 'package_review_required' };
  }
  if (hasConsumedPackageReviewToken(token, now)) return { error: 'package_review_replayed' };

  const snapshot = packageReviewSnapshots.get(token);
  if (!snapshot || currentPackageReviewTokenByProject.get(snapshot.projectId) !== token) {
    return { error: 'package_review_stale' };
  }
  if (snapshot.projectId !== projectId) return { error: 'package_review_project_mismatch' };

  packageReviewSnapshots.delete(token);
  currentPackageReviewTokenByProject.delete(projectId);
  rememberConsumedPackageReviewToken(token, now + PACKAGE_REVIEW_TOKEN_TTL_MS);
  return { snapshot };
}

async function refreshedPackageReviewChangedResult(projectId) {
  const manifest = await buildCanonicalPackageReviewManifest(projectId);
  return {
    error: 'package_review_changed',
    ...(manifest.error ? {} : { review: await createPackageReviewResponse(projectId, manifest) }),
  };
}

registerTrustedIpcHandler('projects:prepare-package-review', async (event, projectId, outputPath) => {
  if (packageInFlight) return { error: 'package_in_flight' };
  const scanWaitStartedAt = Date.now();
  if (!await waitForPackageInputScans(projectId)) {
    return createPackageReviewErrorResult(projectId, 'package_scan_in_flight', {
      failurePhase: 'package-input-scan-wait',
      phaseElapsedMs: Math.max(0, Date.now() - scanWaitStartedAt),
    });
  }
  if (incompletePackageScans.has(projectId)) {
    return createPackageReviewErrorResult(projectId, 'package_scan_incomplete');
  }
  if (packageInFlight) return { error: 'package_in_flight' };
  const reviewStartedAt = Date.now();
  const manifest = await buildCanonicalPackageReviewManifest(projectId);
  if (manifest.error) {
    return createPackageReviewErrorResult(projectId, manifest.error, {
      failurePhase: 'prepare-package-review',
      phaseElapsedMs: Math.max(0, Date.now() - reviewStartedAt),
    });
  }
  if (packageInFlight) return { error: 'package_in_flight' };
  if (outputPath !== undefined && manifest.materializable) {
    if (typeof outputPath !== 'string' || !outputPath) return { error: 'package_output_changed' };
    try {
      const destination = inspectPrivatePackageDestination(outputPath, manifest.plan.destinationFolderName);
      return await createPackageReviewResponse(projectId, manifest, getPrivatePackageDestinationBinding(destination));
    } catch (_) {
      return { error: 'package_output_changed' };
    }
  }
  return await createPackageReviewResponse(projectId, manifest);
});

class PackageReviewChangedError extends Error {
  constructor() {
    super('package_review_changed');
    this.name = 'PackageReviewChangedError';
    this.code = 'package_review_changed';
  }
}

function packageReviewFingerprintsMatch(expected, actual) {
  return !!expected && !!actual && JSON.stringify(expected) === JSON.stringify(actual);
}

function assertReviewedPackageSource(sourcePath, expectedFingerprint) {
  let actualFingerprint;
  try {
    assertSafeCopySource(sourcePath);
    actualFingerprint = getPackageReviewSourceFingerprint(sourcePath);
  } catch (_) {
    throw new PackageReviewChangedError();
  }
  if (
    expectedFingerprint?.state !== 'present' ||
    actualFingerprint.state !== 'present' ||
    !packageReviewFingerprintsMatch(expectedFingerprint, actualFingerprint)
  ) {
    throw new PackageReviewChangedError();
  }
  return actualFingerprint;
}

async function withStableReviewedPackageSource(reviewedSource, readSource) {
  assertReviewedPackageSourceHandle(reviewedSource);
  const sourceStat = fs.fstatSync(reviewedSource.handle.fd, { bigint: true });
  const result = await readSource(reviewedSource.handle, sourceStat);
  assertReviewedPackageSourceHandle(reviewedSource);
  return result;
}

function assertReviewedPackageSourceHandle(reviewedSource) {
  assertReviewedPackageSource(reviewedSource.sourcePath, reviewedSource.expectedFingerprint);
  let handleStat;
  try {
    handleStat = fs.fstatSync(reviewedSource.handle.fd, { bigint: true });
  } catch (_) {
    throw new PackageReviewChangedError();
  }
  if (
    !handleStat.isFile() ||
    !packageReviewFingerprintsMatch(
      reviewedSource.expectedFingerprint.source,
      serializePackageReviewStat(handleStat)
    )
  ) {
    throw new PackageReviewChangedError();
  }
}

function getReviewedPackageSourcePath(file, entry) {
  return entry && entry.embedded ? file && (file.parentPsd || file.path) : file && file.path;
}

async function openReviewedPackageSources(files, entries) {
  const byEntryIndex = new Map();
  const byNormalizedPath = new Map();
  const sources = [];
  try {
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
      const entry = entries[entryIndex];
      const sourcePath = getReviewedPackageSourcePath(files[entryIndex], entry);
      if (!entry || entry.sourceFingerprint?.state !== 'present' || !sourcePath) {
        throw new PackageReviewChangedError();
      }
      const key = entry.sourceFingerprint.normalizedPath;
      let reviewedSource = byNormalizedPath.get(key);
      if (reviewedSource) {
        if (!packageReviewFingerprintsMatch(reviewedSource.expectedFingerprint, entry.sourceFingerprint)) {
          throw new PackageReviewChangedError();
        }
      } else {
        assertReviewedPackageSource(sourcePath, entry.sourceFingerprint);
        let handle;
        try {
          handle = await fs.promises.open(sourcePath, 'r');
        } catch (_) {
          throw new PackageReviewChangedError();
        }
        reviewedSource = { sourcePath, expectedFingerprint: entry.sourceFingerprint, handle };
        sources.push(reviewedSource);
        byNormalizedPath.set(key, reviewedSource);
        assertReviewedPackageSourceHandle(reviewedSource);
      }
      byEntryIndex.set(entryIndex, reviewedSource);
    }
  } catch (error) {
    await Promise.all(sources.map(source => source.handle.close().catch(() => {})));
    throw error;
  }
  return {
    get(entryIndex) {
      const source = byEntryIndex.get(entryIndex);
      if (!source) throw new PackageReviewChangedError();
      return source;
    },
    assertCurrent() {
      for (const source of sources) assertReviewedPackageSourceHandle(source);
    },
    async close() {
      await Promise.all(sources.map(source => source.handle.close().catch(() => {})));
    },
  };
}

async function copyReviewedPackageSource(
  reviewedSource,
  finalPath,
  verifyWrite,
  materializeSource = null,
  rememberDestination = null
) {
  return withStableReviewedPackageSource(reviewedSource, async (sourceHandle, sourceStat) => {
    verifyWrite(finalPath);
    const destinationMode = Number(sourceStat.mode & 0o777n) || OWNER_ONLY_FILE_MODE;
    if (typeof materializeSource === 'function') {
      await materializeSource(finalPath, sourceHandle.fd, sourceStat.size, destinationMode);
      verifyWrite(finalPath);
      return;
    }
    const destinationHandle = await fs.promises.open(finalPath, 'wx', destinationMode);
    try {
      if (typeof rememberDestination === 'function') {
        rememberDestination(finalPath, await destinationHandle.stat({ bigint: true }));
      }
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      while (true) {
        const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        let written = 0;
        while (written < bytesRead) {
          const result = await destinationHandle.write(buffer, written, bytesRead - written);
          written += result.bytesWritten;
        }
        position += bytesRead;
      }
    } finally {
      await destinationHandle.close().catch(() => {});
    }
    verifyWrite(finalPath);
  });
}

async function readReviewedPackageSourceBuffer(sourceHandle, size) {
  const length = Number(size);
  if (!Number.isSafeInteger(length) || length < 0) throw new PackageReviewChangedError();
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await sourceHandle.read(buffer, offset, length - offset, offset);
    if (bytesRead === 0) throw new PackageReviewChangedError();
    offset += bytesRead;
  }
  return buffer;
}

async function writeEmbeddedPsdAssetToPackage(
  file,
  reviewedSource,
  expectedResource,
  finalPath,
  verifyWrite,
  materializeBuffer = null,
  rememberDestination = null
) {
  const buf = await withStableReviewedPackageSource(reviewedSource, async (sourceHandle, stat) => {
    if (stat.size > BigInt(MAX_PARSE_FILE_SIZE)) throw new PackageReviewChangedError();
    return readReviewedPackageSourceBuffer(sourceHandle, stat.size);
  });
  const psd = readPsd(buf, { skipLayerImageData: true, skipCompositeImageData: true });
  const match = findEmbeddedPsdLinkedFileMatch(file, psd.linkedFiles || []);
  if (!match || !packageReviewFingerprintsMatch(expectedResource, getEmbeddedPsdResourceFingerprint(match))) {
    throw new PackageReviewChangedError();
  }

  verifyWrite(finalPath);
  const data = Buffer.from(match.linkedFile.data);
  if (typeof materializeBuffer === 'function') {
    await materializeBuffer(finalPath, data, OWNER_ONLY_FILE_MODE);
  } else {
    const destinationHandle = await fs.promises.open(finalPath, 'wx', OWNER_ONLY_FILE_MODE);
    try {
      if (typeof rememberDestination === 'function') {
        rememberDestination(finalPath, await destinationHandle.stat({ bigint: true }));
      }
      await destinationHandle.writeFile(data);
    } finally {
      await destinationHandle.close().catch(() => {});
    }
  }
  verifyWrite(finalPath);
}

function lstatPackagePath(targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function inspectPrivatePackageDestination(outputPath, rawFolderName) {
  const outputRoot = ensureSafePackageDirectory(outputPath);
  const outputParent = path.dirname(outputRoot);
  const outputParentReal = realpathSync(outputParent);
  const outputParentStat = fs.lstatSync(outputParent, { bigint: true });
  const outputRootReal = realpathSync(outputRoot);
  const outputRootStat = fs.lstatSync(outputRoot, { bigint: true });
  const baseName = sanitizePackageFolderName(rawFolderName);
  let folderName = baseName;
  for (let counter = 1; lstatPackagePath(path.join(outputRoot, folderName)); counter++) {
    const suffix = `_${counter}`;
    const maxBaseLength = Math.max(1, MAX_PACKAGE_FOLDER_NAME_LENGTH - suffix.length);
    const maxBaseBytes = 255 - Buffer.byteLength(suffix, 'utf8');
    const candidateBase = truncatePackageComponent(baseName, maxBaseLength, maxBaseBytes).trimEnd();
    if (!candidateBase) throw new Error('package_output_invalid');
    folderName = `${candidateBase}${suffix}`;
  }
  const destFolder = path.join(outputRoot, folderName);
  if (!isPathInsideDirectory(outputRoot, destFolder) || path.dirname(destFolder) !== outputRoot) {
    throw new Error('package_output_invalid');
  }
  return {
    outputParent,
    outputParentReal,
    outputParentStat,
    outputRoot,
    outputRootReal,
    outputRootStat,
    folderName,
    destFolder,
  };
}

function getPrivatePackageDestinationBinding(destination) {
  return {
    outputRoot: destination.outputRoot,
    outputRootReal: destination.outputRootReal,
    outputRootIdentity: serializePackageReviewIdentityStat(destination.outputRootStat),
    folderName: destination.folderName,
  };
}

function privatePackageDestinationBindingMatches(binding, destination) {
  return packageReviewFingerprintsMatch(binding, getPrivatePackageDestinationBinding(destination));
}

async function createPackageDestinationReviewChangedResult(projectId, manifest, destination) {
  return {
    error: 'package_review_changed',
    reason: 'package_destination_changed',
    review: await createPackageReviewResponse(projectId, manifest, getPrivatePackageDestinationBinding(destination)),
  };
}

async function refreshedPackageDestinationReviewChangedResult(projectId, outputPath) {
  const manifest = await buildCanonicalPackageReviewManifest(projectId);
  if (manifest.error) return { error: manifest.error };
  try {
    const destination = inspectPrivatePackageDestination(outputPath, manifest.plan.destinationFolderName);
    return await createPackageDestinationReviewChangedResult(projectId, manifest, destination);
  } catch (_) {
    return { error: 'package_output_changed' };
  }
}

function createPrivatePackageStagingFolder(stagingParent) {
  const stagingFolder = fs.mkdtempSync(path.join(stagingParent, '.crate-package-staging-'));
  try {
    fs.chmodSync(stagingFolder, OWNER_ONLY_DIR_MODE);
    const stagingStat = fs.lstatSync(stagingFolder, { bigint: true });
    if (
      stagingStat.isSymbolicLink() ||
      !stagingStat.isDirectory() ||
      (stagingStat.mode & 0o777n) !== BigInt(OWNER_ONLY_DIR_MODE) ||
      path.dirname(stagingFolder) !== stagingParent
    ) {
      throw new PackageTransactionInvariantError();
    }
    return { stagingFolder, stagingStat };
  } catch (error) {
    try { fs.rmdirSync(stagingFolder); } catch (_) {}
    throw error;
  }
}

function createPrivatePackageDestination(inspectedDestination) {
  const canStageBesideOutputRoot =
    inspectedDestination.outputParent !== inspectedDestination.outputRoot &&
    inspectedDestination.outputParentStat.dev === inspectedDestination.outputRootStat.dev;
  const stagingParent = canStageBesideOutputRoot
    ? inspectedDestination.outputParent
    : inspectedDestination.outputRoot;
  // A nested output root can be renamed while packaging. Keep staging beside it
  // so cleanup retains a stable path. Only a filesystem/mount root stages inside
  // itself, because its parent is on a different device (or is the same path).
  const staged = createPrivatePackageStagingFolder(stagingParent);
  const { stagingFolder, stagingStat } = staged;
  try {
    if (stagingStat.dev !== inspectedDestination.outputRootStat.dev) {
      throw new PackageTransactionInvariantError();
    }
    const stagingParentIsOutputRoot = stagingParent === inspectedDestination.outputRoot;
    const stagingAnchorParent = path.dirname(stagingParent);
    const destination = {
      ...inspectedDestination,
      stagingParent,
      stagingParentReal: stagingParentIsOutputRoot
        ? inspectedDestination.outputRootReal
        : inspectedDestination.outputParentReal,
      stagingParentStat: stagingParentIsOutputRoot
        ? inspectedDestination.outputRootStat
        : inspectedDestination.outputParentStat,
      stagingAnchorParent,
      stagingAnchorParentReal: realpathSync(stagingAnchorParent),
      stagingAnchorParentStat: fs.lstatSync(stagingAnchorParent, { bigint: true }),
      stagingFolder,
      stagingStat,
    };
    assertPrivatePackageDestinationCurrent(destination);
    return destination;
  } catch (error) {
    try { fs.rmdirSync(stagingFolder); } catch (_) {}
    throw error;
  }
}

function serializePrivateStagedPackageStat(stat) {
  return {
    dev: packageReviewStatValue(stat.dev),
    ino: packageReviewStatValue(stat.ino),
    mode: packageReviewStatValue(stat.mode),
    nlink: packageReviewStatValue(stat.nlink),
    size: packageReviewStatValue(stat.size),
    mtimeNs: packageReviewStatValue(stat.mtimeNs),
    ctimeNs: packageReviewStatValue(stat.ctimeNs),
  };
}

function buildExpectedPrivateStagedPackageTree(intendedFiles) {
  const expected = new Map([['', 'directory']]);
  for (const relativePath of intendedFiles) {
    const normalized = path.normalize(relativePath);
    if (
      !normalized ||
      normalized === '.' ||
      normalized.startsWith(`..${path.sep}`) ||
      path.isAbsolute(normalized)
    ) {
      throw new PackageReviewChangedError();
    }

    let parent = path.dirname(normalized);
    while (parent && parent !== '.') {
      if (expected.get(parent) === 'file') throw new PackageReviewChangedError();
      expected.set(parent, 'directory');
      parent = path.dirname(parent);
    }
    if (expected.has(normalized)) throw new PackageReviewChangedError();
    expected.set(normalized, 'file');
  }
  return expected;
}

function inspectPrivateStagedPackageFile(filePath, hardenMode) {
  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
  const nonBlock = Number.isInteger(fs.constants.O_NONBLOCK) ? fs.constants.O_NONBLOCK : 0;
  let fd = null;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow | nonBlock);
    let beforeStat = fs.fstatSync(fd, { bigint: true });
    if (
      !beforeStat.isFile() ||
      beforeStat.nlink !== 1n
    ) {
      throw new PackageReviewChangedError();
    }
    if (hardenMode) fs.fchmodSync(fd, OWNER_ONLY_FILE_MODE);
    beforeStat = fs.fstatSync(fd, { bigint: true });
    if ((beforeStat.mode & 0o7777n) !== BigInt(OWNER_ONLY_FILE_MODE)) {
      throw new PackageReviewChangedError();
    }

    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }

    const afterStat = fs.fstatSync(fd, { bigint: true });
    const pathStat = fs.lstatSync(filePath, { bigint: true });
    const stableStat = serializePrivateStagedPackageStat(beforeStat);
    if (
      !afterStat.isFile() ||
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      !packageReviewFingerprintsMatch(stableStat, serializePrivateStagedPackageStat(afterStat)) ||
      !packageReviewFingerprintsMatch(stableStat, serializePrivateStagedPackageStat(pathStat))
    ) {
      throw new PackageReviewChangedError();
    }
    return { stat: stableStat, sha256: hash.digest('hex') };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function inspectPrivateStagedPackageTree(stagingFolder, expected, hardenModes) {
  const entries = [];
  const seen = new Set();

  const visit = (absolutePath, relativePath) => {
    const expectedType = expected.get(relativePath);
    if (!expectedType || seen.has(relativePath)) throw new PackageReviewChangedError();
    seen.add(relativePath);

    let stat = fs.lstatSync(absolutePath, { bigint: true });
    if (stat.isSymbolicLink()) throw new PackageReviewChangedError();
    const actualType = stat.isDirectory() ? 'directory' : (stat.isFile() ? 'file' : 'special');
    if (actualType !== expectedType) throw new PackageReviewChangedError();

    if (actualType === 'file') {
      const file = inspectPrivateStagedPackageFile(absolutePath, hardenModes);
      entries.push({ relativePath, type: 'file', ...file });
      return;
    }

    const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
    const directoryOnly = Number.isInteger(fs.constants.O_DIRECTORY) ? fs.constants.O_DIRECTORY : 0;
    const nonBlock = Number.isInteger(fs.constants.O_NONBLOCK) ? fs.constants.O_NONBLOCK : 0;
    let directoryFd = null;
    try {
      directoryFd = fs.openSync(absolutePath, fs.constants.O_RDONLY | noFollow | directoryOnly | nonBlock);
      let openStat = fs.fstatSync(directoryFd, { bigint: true });
      if (!openStat.isDirectory() || openStat.dev !== stat.dev || openStat.ino !== stat.ino) {
        throw new PackageReviewChangedError();
      }
      if (hardenModes) fs.fchmodSync(directoryFd, OWNER_ONLY_DIR_MODE);
      openStat = fs.fstatSync(directoryFd, { bigint: true });
      if ((openStat.mode & 0o7777n) !== BigInt(OWNER_ONLY_DIR_MODE)) {
        throw new PackageReviewChangedError();
      }
      const stableStat = serializePrivateStagedPackageStat(openStat);
      const pathStat = fs.lstatSync(absolutePath, { bigint: true });
      if (
        pathStat.isSymbolicLink() ||
        !pathStat.isDirectory() ||
        !packageReviewFingerprintsMatch(stableStat, serializePrivateStagedPackageStat(pathStat))
      ) {
        throw new PackageReviewChangedError();
      }

      const childNames = fs.readdirSync(absolutePath).sort();
      if (!packageReviewFingerprintsMatch(stableStat, serializePrivateStagedPackageStat(fs.lstatSync(absolutePath, { bigint: true })))) {
        throw new PackageReviewChangedError();
      }
      for (const childName of childNames) {
        const childRelativePath = relativePath ? path.join(relativePath, childName) : childName;
        visit(path.join(absolutePath, childName), childRelativePath);
      }

      const afterOpenStat = fs.fstatSync(directoryFd, { bigint: true });
      const afterPathStat = fs.lstatSync(absolutePath, { bigint: true });
      if (
        afterPathStat.isSymbolicLink() ||
        !afterPathStat.isDirectory() ||
        !packageReviewFingerprintsMatch(stableStat, serializePrivateStagedPackageStat(afterOpenStat)) ||
        !packageReviewFingerprintsMatch(stableStat, serializePrivateStagedPackageStat(afterPathStat))
      ) {
        throw new PackageReviewChangedError();
      }
      entries.push({ relativePath, type: 'directory', stat: stableStat });
    } finally {
      if (directoryFd !== null) fs.closeSync(directoryFd);
    }
  };

  visit(stagingFolder, '');
  if (seen.size !== expected.size || [...expected.keys()].some(relativePath => !seen.has(relativePath))) {
    throw new PackageReviewChangedError();
  }
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function capturePrivateStagedPackageTree(stagingFolder, intendedFiles) {
  const expected = buildExpectedPrivateStagedPackageTree(intendedFiles);
  return inspectPrivateStagedPackageTree(stagingFolder, expected, true);
}

function assertPrivateStagedPackageTree(stagingFolder, snapshot, options = {}) {
  if (!Array.isArray(snapshot)) throw new PackageReviewChangedError();
  const expected = new Map(snapshot.map(entry => [entry.relativePath, entry.type]));
  if (expected.size !== snapshot.length) throw new PackageReviewChangedError();
  const actual = inspectPrivateStagedPackageTree(stagingFolder, expected, false);
  if (options.allowRootRename === true) {
    const snapshotRoot = snapshot.find(entry => entry.relativePath === '' && entry.type === 'directory');
    const actualRoot = actual.find(entry => entry.relativePath === '' && entry.type === 'directory');
    if (snapshotRoot && actualRoot) {
      actualRoot.stat.ctimeNs = snapshotRoot.stat.ctimeNs;
    }
  }
  if (!packageReviewFingerprintsMatch(snapshot, actual)) throw new PackageReviewChangedError();
}

function getPackageTransactionIdentity(identity) {
  return { dev: `${identity.dev}`, ino: `${identity.ino}` };
}

function capturePackageTransactionAncestry(candidatePath, identity) {
  const ancestry = [];
  const requestedPath = path.resolve(candidatePath);
  const requestedStat = fs.lstatSync(requestedPath, { bigint: true });
  if (
    requestedStat.isSymbolicLink() ||
    !requestedStat.isDirectory() ||
    requestedStat.dev !== identity.dev ||
    requestedStat.ino !== identity.ino
  ) {
    throw new PackageTransactionInvariantError();
  }
  let currentPath = realpathSync(requestedPath);
  let first = true;
  while (true) {
    const stat = fs.lstatSync(currentPath, { bigint: true });
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      (first && (stat.dev !== identity.dev || stat.ino !== identity.ino))
    ) {
      throw new PackageTransactionInvariantError();
    }
    ancestry.push(getPackageTransactionIdentity(stat));
    first = false;
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) break;
    currentPath = parentPath;
  }
  return ancestry;
}

function serializePackageTransactionOwnedOutputs(ownedOutputs) {
  return [...(ownedOutputs || new Map()).entries()].map(([leafName, ownedIdentity]) => ({
    leafName,
    identity: getPackageTransactionIdentity(ownedIdentity),
  }));
}

function createPackageTransactionWorkerSession(group) {
  if (!utilityProcess || typeof utilityProcess.fork !== 'function') {
    return Promise.reject(new PackageTransactionInvariantError());
  }
  return new Promise((resolve, reject) => {
    let child;
    let spawned = false;
    let initialized = false;
    let dead = false;
    let closing = false;
    let activeOperation = null;
    let session = null;
    let idleTimer = null;
    let ancestries;
    try {
      ancestries = Array.isArray(group.ancestries) && group.ancestries.length > 0
        ? group.ancestries
        : [capturePackageTransactionAncestry(group.path, group.identity)];
    } catch (_) {
      reject(new PackageTransactionInvariantError());
      return;
    }

    const clearIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    };
    const armIdleTimer = () => {
      clearIdleTimer();
      idleTimer = setTimeout(() => fail(), PACKAGE_TRANSACTION_IDLE_TIMEOUT_MS);
    };
    const stopChild = () => {
      try { child?.kill(); } catch (_) {}
    };
    const fail = () => {
      if (dead) return;
      dead = true;
      clearIdleTimer();
      const operation = activeOperation;
      activeOperation = null;
      stopChild();
      const error = new PackageTransactionInvariantError();
      if (!initialized) reject(error);
      if (operation) operation.reject(error);
    };
    const finishOperation = (message, terminal = false) => {
      const operation = activeOperation;
      if (!operation) return fail();
      activeOperation = null;
      clearIdleTimer();
      if (terminal) closing = true;
      operation.resolve(message);
    };
    const sendNextChunk = () => {
      try {
        const operation = activeOperation;
        if (!operation || operation.type !== 'write') return fail();
        if (BigInt(operation.sourceOffset) === operation.sourceLength) {
          child.postMessage({ type: 'end', sequence: operation.sequence });
          armIdleTimer();
          return;
        }
        const remaining = operation.sourceLength - BigInt(operation.sourceOffset);
        const chunkLength = Number(remaining > BigInt(PACKAGE_TRANSACTION_CHUNK_BYTES)
          ? BigInt(PACKAGE_TRANSACTION_CHUNK_BYTES)
          : remaining);
        let chunk;
        if (operation.dataInput) {
          chunk = Buffer.from(operation.inputData.subarray(
            operation.sourceOffset,
            operation.sourceOffset + chunkLength
          ));
        } else {
          chunk = Buffer.allocUnsafe(chunkLength);
          const bytesRead = fs.readSync(
            operation.source.fd,
            chunk,
            0,
            chunkLength,
            operation.sourceOffset
          );
          if (bytesRead !== chunkLength) {
            fail();
            return;
          }
        }
        child.postMessage({ type: 'chunk', sequence: operation.sequence, data: chunk });
        operation.sourceOffset += chunkLength;
        armIdleTimer();
      } catch (_) {
        fail();
      }
    };

    try {
      child = utilityProcess.fork(PACKAGE_TRANSACTION_WORKER_PATH, [], {
        cwd: group.path,
        env: {},
        execArgv: [],
        stdio: 'ignore',
        serviceName: 'Crate Package Transaction',
        allowLoadingUnsignedLibraries: false,
        disclaim: false,
      });
    } catch (_) {
      fail();
      return;
    }
    child.once('error', fail);
    child.once('exit', () => {
      if (!dead && !closing) fail();
      dead = true;
      clearIdleTimer();
    });
    child.on('message', message => {
      if (dead || !spawned || !message || typeof message !== 'object') return fail();
      if (!initialized && message.type === 'session-ready') {
        if (!session) return fail();
        initialized = true;
        clearIdleTimer();
        resolve(session);
        return;
      }
      const operation = activeOperation;
      if (!initialized || !operation) return fail();
      if (
        operation.type === 'write' &&
        message.type === 'opened' &&
        !operation.outputIdentity &&
        message.outputIdentity &&
        /^\d+$/u.test(message.outputIdentity.dev) &&
        /^\d+$/u.test(message.outputIdentity.ino)
      ) {
        const outputIdentity = {
          dev: BigInt(message.outputIdentity.dev),
          ino: BigInt(message.outputIdentity.ino),
        };
        operation.outputIdentity = message.outputIdentity;
        group.ownedOutputs.set(operation.leafName, outputIdentity);
        child.postMessage({ type: 'ownership-ack', outputIdentity: operation.outputIdentity });
        armIdleTimer();
        return;
      }
      if (
        operation.type === 'write' &&
        message.type === 'ready' &&
        operation.outputIdentity &&
        operation.sequence === 0 &&
        operation.sourceOffset === 0
      ) {
        sendNextChunk();
        return;
      }
      if (
        operation.type === 'write' &&
        message.type === 'ack' &&
        Number.isSafeInteger(message.sequence) &&
        message.sequence === operation.sequence
      ) {
        operation.sequence++;
        sendNextChunk();
        return;
      }
      if (
        message.type === 'complete' &&
        typeof message.bytesWritten === 'string' &&
        message.bytesWritten === `${operation.sourceLength}`
      ) {
        if (
          operation.type === 'write' &&
          (!message.outputIdentity ||
            !/^\d+$/u.test(message.outputIdentity.dev) ||
            !/^\d+$/u.test(message.outputIdentity.ino) ||
            !operation.outputIdentity ||
            message.outputIdentity.dev !== operation.outputIdentity.dev ||
            message.outputIdentity.ino !== operation.outputIdentity.ino)
        ) return fail();
        finishOperation(message, operation.type === 'cleanup');
        return;
      }
      if (operation.type === 'release' && message.type === 'released') {
        finishOperation(message, true);
        return;
      }
      fail();
    });
    child.once('spawn', () => {
      if (dead) return;
      spawned = true;
      child.postMessage({
        type: 'init-session',
        identity: getPackageTransactionIdentity(group.identity),
        ancestries,
        ownedOutputs: serializePackageTransactionOwnedOutputs(group.ownedOutputs),
      });
      armIdleTimer();
    });
    armIdleTimer();

    const beginOperation = (type, message, source = null) => new Promise((operationResolve, operationReject) => {
      if (dead || closing || !initialized || activeOperation) {
        operationReject(new PackageTransactionInvariantError());
        return;
      }
      try {
        const dataInput = type === 'write' && Object.prototype.hasOwnProperty.call(source, 'data');
        const inputData = dataInput
          ? (Buffer.isBuffer(source.data) ? source.data : Buffer.from(source.data))
          : null;
        const sourceLength = type === 'write'
          ? (dataInput ? BigInt(inputData.length) : BigInt(source.size))
          : 0n;
        activeOperation = {
          type,
          leafName: type === 'write' ? message.leafName : null,
          source,
          dataInput,
          inputData,
          sourceLength,
          sourceOffset: 0,
          sequence: 0,
          outputIdentity: null,
          resolve: operationResolve,
          reject: operationReject,
        };
        child.postMessage({ ...message, expectedLength: type === 'write' ? `${sourceLength}` : undefined });
        armIdleTimer();
      } catch (_) {
        if (activeOperation) fail();
        else operationReject(new PackageTransactionInvariantError());
      }
    });
    session = {
      isDead: () => dead || closing,
      write: (leafName, source) => beginOperation('write', { type: 'write-start', leafName }, source),
      cleanup: () => beginOperation('cleanup', { type: 'cleanup' }),
      release: () => beginOperation('release', { type: 'release' }),
      dispose: stopChild,
    };
  });
}

async function getPackageTransactionWorkerSession(group) {
  if (group.transactionSession && !group.transactionSession.isDead()) return group.transactionSession;
  if (!group.transactionSessionPromise) {
    group.transactionSessionPromise = createPackageTransactionWorkerSession(group)
      .then(session => {
        group.transactionSession = session;
        return session;
      })
      .finally(() => {
        group.transactionSessionPromise = null;
      });
  }
  return await group.transactionSessionPromise;
}

async function runPackageTransactionWorker(group, operation, source = null) {
  const session = await getPackageTransactionWorkerSession(group);
  if (operation === 'cleanup') return await session.cleanup();
  if (operation === 'release') return await session.release();
  const leafName = path.basename(group.filePath || '');
  if (
    operation !== 'write' ||
    !source ||
    !leafName ||
    leafName === '.' ||
    leafName === '..' ||
    leafName.includes('/') ||
    leafName.includes('\0')
  ) throw new PackageTransactionInvariantError();
  return await session.write(leafName, source);
}

async function runDescriptorBoundPackageWriter(group, filePath, source) {
  const leafName = path.basename(filePath || '');
  if (
    !source ||
    !leafName ||
    leafName === '.' ||
    leafName === '..' ||
    leafName.includes('/') ||
    leafName.includes('\0')
  ) throw new PackageTransactionInvariantError();
  const session = await getPackageTransactionWorkerSession(group);
  return await session.write(leafName, source);
}

async function removePrivateStagedPackageTree(
  stagingFolder,
  identity,
  ancestries = null,
  ownedOutputs = null,
  liveGroup = null
) {
  try {
    const workerGroup = liveGroup || { identity, ownedOutputs };
    workerGroup.path = stagingFolder;
    if (!workerGroup.ancestries) workerGroup.ancestries = ancestries;
    await runPackageTransactionWorker(workerGroup, 'cleanup');
    return removeEmptyPrivatePackageDirectory(stagingFolder, identity);
  } catch (_) {
    return false;
  }
}

function privatePackageDirectoryMatches(candidatePath, identity) {
  try {
    const stat = fs.lstatSync(candidatePath, { bigint: true });
    return !stat.isSymbolicLink() &&
      stat.isDirectory() &&
      typeof identity?.dev === 'bigint' &&
      typeof identity?.ino === 'bigint' &&
      stat.dev === identity.dev &&
      stat.ino === identity.ino;
  } catch (_) {
    return false;
  }
}

function removeEmptyPrivatePackageDirectory(candidatePath, identity) {
  const noFollow = fs.constants.O_NOFOLLOW;
  const directoryOnly = fs.constants.O_DIRECTORY;
  const nonBlock = Number.isInteger(fs.constants.O_NONBLOCK) ? fs.constants.O_NONBLOCK : 0;
  if (!Number.isInteger(noFollow) || !Number.isInteger(directoryOnly)) return false;
  let fd = null;
  try {
    fd = fs.openSync(candidatePath, fs.constants.O_RDONLY | noFollow | directoryOnly | nonBlock);
    const opened = fs.fstatSync(fd, { bigint: true });
    if (
      !opened.isDirectory() ||
      opened.dev !== identity.dev ||
      opened.ino !== identity.ino ||
      fs.readdirSync(candidatePath).length !== 0
    ) return false;
    const current = fs.lstatSync(candidatePath, { bigint: true });
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    ) return false;
    fs.rmdirSync(candidatePath);
    return !lstatPackagePath(candidatePath);
  } catch (_) {
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function hardenPrivatePackageDirectory(candidatePath, identity) {
  const noFollow = fs.constants.O_NOFOLLOW;
  const directoryOnly = fs.constants.O_DIRECTORY;
  const nonBlock = Number.isInteger(fs.constants.O_NONBLOCK) ? fs.constants.O_NONBLOCK : 0;
  if (!Number.isInteger(noFollow) || !Number.isInteger(directoryOnly)) {
    throw new PackageTransactionInvariantError();
  }
  let fd = null;
  try {
    fd = fs.openSync(candidatePath, fs.constants.O_RDONLY | noFollow | directoryOnly | nonBlock);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isDirectory() || before.dev !== identity.dev || before.ino !== identity.ino) {
      throw new PackageTransactionInvariantError();
    }
    fs.fchmodSync(fd, OWNER_ONLY_DIR_MODE);
    const after = fs.fstatSync(fd, { bigint: true });
    const pathStat = fs.lstatSync(candidatePath, { bigint: true });
    if (
      !after.isDirectory() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      (after.mode & 0o777n) !== BigInt(OWNER_ONLY_DIR_MODE) ||
      pathStat.isSymbolicLink() ||
      !pathStat.isDirectory() ||
      pathStat.dev !== before.dev ||
      pathStat.ino !== before.ino ||
      (pathStat.mode & 0o777n) !== BigInt(OWNER_ONLY_DIR_MODE)
    ) {
      throw new PackageTransactionInvariantError();
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

class PackageTransactionInvariantError extends Error {
  constructor() {
    super('package_output_changed');
    this.name = 'PackageTransactionInvariantError';
    this.code = 'package_output_changed';
  }
}

class PackageDestinationOccupiedError extends PackageTransactionInvariantError {
  constructor() {
    super();
    this.name = 'PackageDestinationOccupiedError';
  }
}

class PackageCleanupError extends PackageTransactionInvariantError {
  constructor() {
    super();
    this.name = 'PackageCleanupError';
    this.message = 'package_cleanup_failed';
    this.code = 'package_cleanup_failed';
  }
}

function assertPrivatePackageDestinationCurrent(destination) {
  try {
    const currentParent = fs.lstatSync(destination.outputParent, { bigint: true });
    const currentRoot = fs.lstatSync(destination.outputRoot, { bigint: true });
    const currentStagingParent = fs.lstatSync(destination.stagingParent, { bigint: true });
    const currentStaging = fs.lstatSync(destination.stagingFolder, { bigint: true });
    if (
      currentParent.isSymbolicLink() ||
      !currentParent.isDirectory() ||
      currentParent.dev !== destination.outputParentStat.dev ||
      currentParent.ino !== destination.outputParentStat.ino ||
      realpathSync(destination.outputParent) !== destination.outputParentReal ||
      currentRoot.isSymbolicLink() ||
      !currentRoot.isDirectory() ||
      currentRoot.dev !== destination.outputRootStat.dev ||
      currentRoot.ino !== destination.outputRootStat.ino ||
      realpathSync(destination.outputRoot) !== destination.outputRootReal ||
      currentStagingParent.isSymbolicLink() ||
      !currentStagingParent.isDirectory() ||
      currentStagingParent.dev !== destination.stagingParentStat.dev ||
      currentStagingParent.ino !== destination.stagingParentStat.ino ||
      realpathSync(destination.stagingParent) !== destination.stagingParentReal ||
      currentStaging.isSymbolicLink() ||
      !currentStaging.isDirectory() ||
      currentStaging.dev !== destination.stagingStat.dev ||
      currentStaging.ino !== destination.stagingStat.ino ||
      currentStaging.dev !== currentRoot.dev ||
      path.dirname(destination.stagingFolder) !== destination.stagingParent ||
      path.dirname(destination.destFolder) !== destination.outputRoot
    ) {
      throw new PackageTransactionInvariantError();
    }
    if (lstatPackagePath(destination.destFolder)) throw new PackageDestinationOccupiedError();
  } catch (error) {
    if (error instanceof PackageTransactionInvariantError) throw error;
    throw new PackageTransactionInvariantError();
  }
}

function locatePrivatePackageStagingParent(destination) {
  if (privatePackageDirectoryMatches(destination.stagingParent, destination.stagingParentStat)) {
    return destination.stagingParent;
  }
  if (!privatePackageDirectoryMatches(destination.stagingAnchorParent, destination.stagingAnchorParentStat)) return null;
  try {
    if (realpathSync(destination.stagingAnchorParent) !== destination.stagingAnchorParentReal) return null;
    for (const childName of fs.readdirSync(destination.stagingAnchorParent)) {
      const candidate = path.join(destination.stagingAnchorParent, childName);
      if (privatePackageDirectoryMatches(candidate, destination.stagingParentStat)) return candidate;
    }
  } catch (_) {}
  return null;
}

function locatePrivatePackageStaging(destination) {
  for (const candidate of [destination.stagingFolder, destination.destFolder]) {
    if (privatePackageDirectoryMatches(candidate, destination.stagingStat)) return candidate;
  }

  const stagingParent = locatePrivatePackageStagingParent(destination);
  if (!stagingParent) return null;
  try {
    for (const childName of fs.readdirSync(stagingParent)) {
      const candidate = path.join(stagingParent, childName);
      if (privatePackageDirectoryMatches(candidate, destination.stagingStat)) return candidate;
    }
  } catch (_) {}
  return null;
}

async function cleanupPrivatePackageDestination(destination) {
  const stagingFolder = locatePrivatePackageStaging(destination);
  if (!stagingFolder) return false;
  return await removePrivateStagedPackageTree(stagingFolder, destination.stagingStat) &&
    !locatePrivatePackageStaging(destination);
}

function publishPrivatePackageDestination(destination, stagedTreeSnapshot) {
  assertPrivatePackageDestinationCurrent(destination);
  assertPrivateStagedPackageTree(destination.stagingFolder, stagedTreeSnapshot);
  assertPrivatePackageDestinationCurrent(destination);
  try {
    fs.renameSync(destination.stagingFolder, destination.destFolder);
  } catch (error) {
    if (['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw new PackageDestinationOccupiedError();
    throw new PackageTransactionInvariantError();
  }
  try {
    const finalStat = fs.lstatSync(destination.destFolder, { bigint: true });
    const currentParent = fs.lstatSync(destination.outputParent, { bigint: true });
    const currentRoot = fs.lstatSync(destination.outputRoot, { bigint: true });
    if (
      finalStat.isSymbolicLink() ||
      !finalStat.isDirectory() ||
      finalStat.dev !== destination.stagingStat.dev ||
      finalStat.ino !== destination.stagingStat.ino ||
      (finalStat.mode & 0o777n) !== BigInt(OWNER_ONLY_DIR_MODE) ||
      lstatPackagePath(destination.stagingFolder) ||
      currentParent.isSymbolicLink() ||
      !currentParent.isDirectory() ||
      currentParent.dev !== destination.outputParentStat.dev ||
      currentParent.ino !== destination.outputParentStat.ino ||
      realpathSync(destination.outputParent) !== destination.outputParentReal ||
      currentRoot.isSymbolicLink() ||
      !currentRoot.isDirectory() ||
      currentRoot.dev !== destination.outputRootStat.dev ||
      currentRoot.ino !== destination.outputRootStat.ino ||
      realpathSync(destination.outputRoot) !== destination.outputRootReal ||
      path.dirname(realpathSync(destination.destFolder)) !== destination.outputRootReal ||
      path.dirname(destination.destFolder) !== destination.outputRoot
    ) throw new PackageTransactionInvariantError();
    assertPrivateStagedPackageTree(destination.destFolder, stagedTreeSnapshot, { allowRootRename: true });
  } catch (error) {
    try {
      if (
        privatePackageDirectoryMatches(destination.destFolder, destination.stagingStat) &&
        !lstatPackagePath(destination.stagingFolder)
      ) {
        fs.renameSync(destination.destFolder, destination.stagingFolder);
      }
    } catch (_) {}
    if (error instanceof PackageTransactionInvariantError) throw error;
    if (error instanceof PackageReviewChangedError) throw error;
    throw new PackageTransactionInvariantError();
  }
}

function createPackageWriteTransaction(destFolder) {
  const root = path.resolve(destFolder);
  let publishedRoot = null;
  const parent = path.dirname(root);
  const parentReal = realpathSync(parent);
  const parentIdentity = fs.lstatSync(parent, { bigint: true });
  const anchorParent = path.dirname(parent);
  const anchorParentReal = realpathSync(anchorParent);
  const anchorParentIdentity = fs.lstatSync(anchorParent, { bigint: true });
  const identity = fs.lstatSync(root, { bigint: true });
  const rootAncestry = capturePackageTransactionAncestry(root, identity);
  const intended = new Set();
  const logicalByPhysicalPath = new Map();
  const groups = new Map();
  const legacyGroups = new Map();
  const rootGroup = {
    folderName: null,
    path: root,
    identity,
    ancestries: [rootAncestry],
    ownedOutputs: new Map(),
    transactionSession: null,
    transactionSessionPromise: null,
    finalized: true,
    renameAttempted: false,
    knownPaths: new Set([root]),
  };
  const isOriginal = candidate => {
    try {
      const stat = fs.lstatSync(candidate, { bigint: true });
      return !stat.isSymbolicLink() && stat.isDirectory() && stat.dev === identity.dev && stat.ino === identity.ino;
    } catch (_) {
      return false;
    }
  };
  const locate = () => {
    if (isOriginal(root)) return root;
    if (publishedRoot && isOriginal(publishedRoot)) return publishedRoot;
    let locatedParent = null;
    try {
      const stat = fs.lstatSync(parent, { bigint: true });
      if (
        !stat.isSymbolicLink() &&
        stat.isDirectory() &&
        stat.dev === parentIdentity.dev &&
        stat.ino === parentIdentity.ino &&
        realpathSync(parent) === parentReal
      ) locatedParent = parent;
    } catch (_) {}
    if (!locatedParent) {
      try {
        const anchorStat = fs.lstatSync(anchorParent, { bigint: true });
        if (
          !anchorStat.isSymbolicLink() &&
          anchorStat.isDirectory() &&
          anchorStat.dev === anchorParentIdentity.dev &&
          anchorStat.ino === anchorParentIdentity.ino &&
          realpathSync(anchorParent) === anchorParentReal
        ) {
          for (const name of fs.readdirSync(anchorParent)) {
            const candidate = path.join(anchorParent, name);
            if (privatePackageDirectoryMatches(candidate, parentIdentity)) {
              locatedParent = candidate;
              break;
            }
          }
        }
      } catch (_) {}
    }
    if (locatedParent) {
      try {
        for (const name of fs.readdirSync(locatedParent)) {
          const candidate = path.join(locatedParent, name);
          if (isOriginal(candidate)) return candidate;
        }
      } catch (_) {}
    }
    return null;
  };
  const assertRoot = () => {
    if (!isOriginal(root)) throw new PackageTransactionInvariantError();
  };
  const normalizeRelativePath = rawRelativePath => {
    const relative = path.normalize(`${rawRelativePath || ''}`.split('/').join(path.sep));
    const parts = relative.split(path.sep);
    if (
      !relative ||
      relative === '.' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      parts.length > 2 ||
      parts.some(part => !part || part === '.' || part === '..')
    ) {
      throw new PackageTransactionInvariantError();
    }
    return relative;
  };
  const groupMatches = group => privatePackageDirectoryMatches(group.path, group.identity);
  const locateGroup = group => {
    for (const candidate of group.knownPaths) {
      if (privatePackageDirectoryMatches(candidate, group.identity)) return candidate;
    }
    const locatedRoot = locate();
    for (const searchRoot of new Set([parent, root, locatedRoot].filter(Boolean))) {
      try {
        if (searchRoot === parent) {
          const parentStat = fs.lstatSync(parent, { bigint: true });
          if (parentStat.isSymbolicLink() || !parentStat.isDirectory() || realpathSync(parent) !== parentReal) continue;
        } else if (!isOriginal(searchRoot)) {
          continue;
        }
        for (const childName of fs.readdirSync(searchRoot)) {
          const candidate = path.join(searchRoot, childName);
          if (privatePackageDirectoryMatches(candidate, group.identity)) return candidate;
        }
      } catch (_) {
        continue;
      }
    }
    return null;
  };
  const getOrCreateGroup = folderName => {
    const existing = groups.get(folderName);
    if (existing) return existing;
    assertRoot();
    const groupPath = fs.mkdtempSync(path.join(parent, '.crate-package-group-'));
    let group = null;
    try {
      const groupIdentity = fs.lstatSync(groupPath, { bigint: true });
      group = {
        folderName,
        path: groupPath,
        identity: groupIdentity,
        ancestries: [
          capturePackageTransactionAncestry(groupPath, groupIdentity),
          [getPackageTransactionIdentity(groupIdentity), ...rootAncestry],
        ],
        ownedOutputs: new Map(),
        transactionSession: null,
        transactionSessionPromise: null,
        finalized: false,
        renameAttempted: false,
        knownPaths: new Set([groupPath]),
      };
      groups.set(folderName, group);
      hardenPrivatePackageDirectory(groupPath, groupIdentity);
      const verifiedIdentity = fs.lstatSync(groupPath, { bigint: true });
      if (
        verifiedIdentity.isSymbolicLink() ||
        !verifiedIdentity.isDirectory() ||
        verifiedIdentity.dev !== groupIdentity.dev ||
        verifiedIdentity.ino !== groupIdentity.ino ||
        verifiedIdentity.dev !== identity.dev ||
        (verifiedIdentity.mode & 0o777n) !== BigInt(OWNER_ONLY_DIR_MODE) ||
        path.dirname(groupPath) !== parent
      ) throw new PackageTransactionInvariantError();
      return group;
    } catch (error) {
      if (!group) throw new PackageCleanupError();
      throw error;
    }
  };
  const assertPhysicalDestination = filePath => {
    assertRoot();
    const physicalPath = path.resolve(filePath);
    const relative = logicalByPhysicalPath.get(physicalPath);
    if (!relative) throw new PackageTransactionInvariantError();
    const parts = relative.split(path.sep);
    if (parts.length === 1) {
      if (path.dirname(physicalPath) !== root) throw new PackageTransactionInvariantError();
    } else {
      const group = groups.get(parts[0]);
      if (group) {
        if (group.finalized || !groupMatches(group) || path.dirname(physicalPath) !== group.path) {
          throw new PackageTransactionInvariantError();
        }
      } else {
        const legacyGroup = legacyGroups.get(parts[0]);
        if (
          !legacyGroup ||
          !groupMatches(legacyGroup) ||
          path.dirname(physicalPath) !== legacyGroup.path
        ) throw new PackageTransactionInvariantError();
      }
    }
    const existing = lstatPackagePath(physicalPath);
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new PackageTransactionInvariantError();
    return relative;
  };
  const getDescriptorBoundGroup = filePath => {
    const relative = assertPhysicalDestination(filePath);
    const parts = relative.split(path.sep);
    return parts.length === 2 ? groups.get(parts[0]) : null;
  };
  const knownGroupPathsAreUnoccupied = group => {
    for (const candidate of group.knownPaths) {
      const stat = lstatPackagePath(candidate);
      if (!stat || privatePackageDirectoryMatches(candidate, group.identity)) continue;
      return false;
    }
    return true;
  };
  const finalizeGroups = () => {
    assertRoot();
    for (const group of [...groups.values()].sort((left, right) => left.folderName.localeCompare(right.folderName))) {
      if (group.finalized) continue;
      if (!groupMatches(group)) throw new PackageTransactionInvariantError();
      const finalGroupPath = path.join(root, group.folderName);
      group.renameAttempted = true;
      group.knownPaths.add(finalGroupPath);
      if (lstatPackagePath(finalGroupPath)) throw new PackageTransactionInvariantError();
      try {
        fs.renameSync(group.path, finalGroupPath);
      } catch (_) {
        throw new PackageTransactionInvariantError();
      }
      if (!privatePackageDirectoryMatches(finalGroupPath, group.identity) || path.dirname(finalGroupPath) !== root) {
        throw new PackageTransactionInvariantError();
      }
      group.path = finalGroupPath;
      group.finalized = true;
    }
  };
  const cleanupAuxiliary = async () => {
    let clean = true;
    for (const group of [...groups.values(), ...legacyGroups.values()]) {
      const located = locateGroup(group) || [...group.knownPaths].find(candidate => {
        try {
          const stat = fs.statSync(candidate, { bigint: true });
          return stat.isDirectory() && stat.dev === group.identity.dev && stat.ino === group.identity.ino;
        } catch (_) {
          return false;
        }
      });
      if (
        !located ||
        !await removePrivateStagedPackageTree(
          located,
          group.identity,
          group.ancestries,
          group.ownedOutputs,
          group
        ) ||
        locateGroup(group)
      ) clean = false;
      if (!knownGroupPathsAreUnoccupied(group)) clean = false;
    }
    return clean;
  };

  return {
    assertRoot,
    prepare(relativePath) {
      assertRoot();
      const relative = normalizeRelativePath(relativePath);
      if (intended.has(relative)) throw new PackageReviewChangedError();
      const parts = relative.split(path.sep);
      const physicalPath = parts.length === 1
        ? path.join(root, parts[0])
        : path.join(getOrCreateGroup(parts[0]).path, parts[1]);
      intended.add(relative);
      logicalByPhysicalPath.set(path.resolve(physicalPath), relative);
      return physicalPath;
    },
    prepareLegacyNested(relativePath) {
      assertRoot();
      const relative = normalizeRelativePath(relativePath);
      if (intended.has(relative)) throw new PackageReviewChangedError();
      const physicalPath = resolveExactPackagePath(root, relative, {
        fallbackName: 'file',
        preserveRelativePath: true,
      });
      const parts = relative.split(path.sep);
      if (parts.length === 2 && !legacyGroups.has(parts[0])) {
        const directoryPath = path.dirname(physicalPath);
        const directoryIdentity = fs.lstatSync(directoryPath, { bigint: true });
        legacyGroups.set(parts[0], {
          folderName: parts[0],
          path: directoryPath,
          identity: directoryIdentity,
          ancestries: [capturePackageTransactionAncestry(directoryPath, directoryIdentity)],
          ownedOutputs: new Map(),
          transactionSession: null,
          transactionSessionPromise: null,
          finalized: true,
          renameAttempted: false,
          knownPaths: new Set([directoryPath]),
        });
      }
      intended.add(relative);
      logicalByPhysicalPath.set(path.resolve(physicalPath), relative);
      return physicalPath;
    },
    verify(filePath) {
      assertPhysicalDestination(filePath);
    },
    isDescriptorBound(filePath) {
      return !!getDescriptorBoundGroup(filePath);
    },
    async materializeSource(filePath, sourceFd, sourceSize, mode) {
      const group = getDescriptorBoundGroup(filePath);
      if (!group) throw new PackageTransactionInvariantError();
      const result = await runDescriptorBoundPackageWriter(group, filePath, { fd: sourceFd, size: sourceSize, mode });
      group.ownedOutputs.set(path.basename(filePath), {
        dev: BigInt(result.outputIdentity.dev),
        ino: BigInt(result.outputIdentity.ino),
      });
      assertPhysicalDestination(filePath);
    },
    async materializeBuffer(filePath, data, mode = OWNER_ONLY_FILE_MODE) {
      const group = getDescriptorBoundGroup(filePath);
      if (!group) throw new PackageTransactionInvariantError();
      const result = await runDescriptorBoundPackageWriter(group, filePath, { data, mode });
      group.ownedOutputs.set(path.basename(filePath), {
        dev: BigInt(result.outputIdentity.dev),
        ino: BigInt(result.outputIdentity.ino),
      });
      assertPhysicalDestination(filePath);
    },
    rememberOwned(filePath, knownIdentity = null) {
      const relative = assertPhysicalDestination(filePath);
      const parts = relative.split(path.sep);
      const group = parts.length === 1 ? rootGroup : legacyGroups.get(parts[0]);
      if (!group) return;
      const stat = knownIdentity || fs.lstatSync(filePath, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isFile()) throw new PackageTransactionInvariantError();
      group.ownedOutputs.set(path.basename(filePath), { dev: stat.dev, ino: stat.ino });
    },
    async materializeDirectBuffer(filePath, data, mode = OWNER_ONLY_FILE_MODE) {
      assertPhysicalDestination(filePath);
      const destinationHandle = await fs.promises.open(filePath, 'wx', mode);
      try {
        this.rememberOwned(filePath, await destinationHandle.stat({ bigint: true }));
        await destinationHandle.writeFile(data);
      } finally {
        await destinationHandle.close().catch(() => {});
      }
      assertPhysicalDestination(filePath);
    },
    relativeFor(filePath) {
      return assertPhysicalDestination(filePath);
    },
    captureTree() {
      finalizeGroups();
      assertRoot();
      return capturePrivateStagedPackageTree(root, intended);
    },
    adoptPublishedRoot(publishedPath) {
      const nextRoot = path.resolve(publishedPath);
      const nextRootAncestry = capturePackageTransactionAncestry(nextRoot, identity);
      const relocatedGroups = [];
      for (const group of [...groups.values(), ...legacyGroups.values()]) {
        const nextGroupPath = path.join(nextRoot, group.folderName);
        if (!privatePackageDirectoryMatches(nextGroupPath, group.identity)) {
          throw new PackageTransactionInvariantError();
        }
        relocatedGroups.push({
          group,
          path: nextGroupPath,
          ancestry: capturePackageTransactionAncestry(nextGroupPath, group.identity),
        });
      }

      for (const group of [rootGroup, ...groups.values(), ...legacyGroups.values()]) {
        try { group.transactionSession?.dispose(); } catch (_) {}
        group.transactionSession = null;
        group.transactionSessionPromise = null;
      }
      publishedRoot = nextRoot;
      rootGroup.path = nextRoot;
      rootGroup.knownPaths.add(nextRoot);
      rootGroup.ancestries.push(nextRootAncestry);
      for (const relocated of relocatedGroups) {
        relocated.group.path = relocated.path;
        relocated.group.knownPaths.add(relocated.path);
        relocated.group.ancestries.push(relocated.ancestry);
      }
    },
    dispose() {
      for (const group of [rootGroup, ...groups.values(), ...legacyGroups.values()]) {
        try { group.transactionSession?.dispose(); } catch (_) {}
        group.transactionSession = null;
        group.transactionSessionPromise = null;
      }
    },
    cleanupAuxiliary,
    async cleanup() {
      const auxiliaryClean = await cleanupAuxiliary();
      const located = locate();
      if (!located) return false;
      rootGroup.path = located;
      const rootClean = await removePrivateStagedPackageTree(
        located,
        identity,
        [rootAncestry],
        rootGroup.ownedOutputs,
        rootGroup
      ) && !locate();
      return auxiliaryClean && rootClean;
    },
  };
}

registerTrustedIpcHandler('projects:package', async (event, id, outputPath, reviewToken) => {
  // C1: Prevent double-click / concurrent packaging
  if (packageInFlight) return { error: 'package_in_flight' };
  packageInFlight = true;

  let packageActivation = null, packageWrites = null, packageDestination = null, packagePublished = false;
  let reviewedPackageSources = null;
  const cleanupStaging = async () => {
    if (packagePublished) return false;
    if (packageDestination) {
      if (packageWrites) return await packageWrites.cleanup();
      return await cleanupPrivatePackageDestination(packageDestination);
    }
    if (packageWrites) return await packageWrites.cleanup();
    return true;
  };
  const failPackage = async error => ({
    error: await cleanupStaging() ? (error?.code || error?.message || error) : 'package_cleanup_failed'
  });
  try {
  const reviewResult = consumePackageReviewSnapshot(id, reviewToken);
  if (reviewResult.error) return { error: reviewResult.error };
  packageActivation = captureProjectOperation(id); if (!packageActivation) return { error: 'not_found' };
  const isPackageActivationCurrent = () => packageActivation.current(true);
  // Wait for in-flight pre-package and Figma scans to finish before selecting
  // package files. Large Figma pages can still be downloading when the user
  // clicks Package, and selecting too early yields a zero-file package.
  const scanWaitStartedAt = Date.now();
  if (!await waitForPackageInputScans(id)) {
    return createPackageReviewErrorResult(id, 'package_scan_in_flight', {
      failurePhase: 'package-input-scan-wait',
      phaseElapsedMs: Math.max(0, Date.now() - scanWaitStartedAt),
    });
  }
  if (incompletePackageScans.has(id)) {
    return createPackageReviewErrorResult(id, 'package_scan_incomplete');
  }
  if (!isPackageActivationCurrent()) return { error: 'stale_activation' };

  const figmaPackageError = figmaPackageTransferBlocks.get(id);
  if (figmaPackageError) return { error: figmaPackageError };

  // Check freemium limit
  const limitResult = getPackageLimitResult();
  if (limitResult) return limitResult;

  const manifest = await buildCanonicalPackageReviewManifest(id);
  if (manifest.error) return { error: manifest.error };
  if (!manifest.materializable) {
    return { error: 'package_review_changed', review: await createUnavailablePackageReview(id, manifest) };
  }
  if (!isPackageActivationCurrent()) return { error: 'stale_activation' };
  if (manifest.manifestKey !== reviewResult.snapshot.manifestKey) {
    return {
      error: 'package_review_changed',
      review: await createPackageReviewResponse(id, manifest),
    };
  }
  let inspectedDestination = inspectPrivatePackageDestination(
    outputPath,
    manifest.plan.destinationFolderName
  );
  const reviewedDestination = reviewResult.snapshot.destinationBinding || null;
  if (
    reviewedDestination
      ? !privatePackageDestinationBindingMatches(reviewedDestination, inspectedDestination)
      : inspectedDestination.folderName !== manifest.plan.destinationFolderName
  ) {
    return await createPackageDestinationReviewChangedResult(id, manifest, inspectedDestination);
  }
  const project = manifest.project;
  const packageFiles = manifest.files;
  try {
    reviewedPackageSources = await openReviewedPackageSources(packageFiles, manifest.entries);
  } catch (error) {
    if (error instanceof PackageReviewChangedError) {
      return refreshedPackageReviewChangedResult(id);
    }
    throw error;
  }
  if (!isPackageActivationCurrent()) throw new PackageReviewChangedError();

  const currentDestination = inspectPrivatePackageDestination(
    outputPath,
    manifest.plan.destinationFolderName
  );
  if (!privatePackageDestinationBindingMatches(
    getPrivatePackageDestinationBinding(inspectedDestination),
    currentDestination
  )) {
    return await createPackageDestinationReviewChangedResult(id, manifest, currentDestination);
  }
  inspectedDestination = currentDestination;

  // Non-output settings are read separately; the destination name is bound to review.
  const settings = store.get('settings');

  try {
    packageDestination = createPrivatePackageDestination(inspectedDestination);
    const stagingFolder = packageDestination.stagingFolder;
    const destFolder = packageDestination.destFolder;
    let copiedCount = 0;
    const errors = [];
    const packageProvenanceEvents = [];
    const stagedSourceByFile = new Map();
    const layoutMode = normalizePackageOutputLayoutMode(manifest.plan.layoutMode);
    const outputAllocator = createAuthoritativePackageOutputAllocator(layoutMode);
    const allocateOutputName = outputAllocator.reserveOutputName;
    const getOutputRelativePath = outputAllocator.getOutputRelativePath;
    const toPublishedPath = stagedPath => path.join(destFolder, packageWrites.relativeFor(stagedPath));
    const packageProvenanceInfo = {
      destFolder,
      createdAt: Date.now(),
    };
    packageWrites = createPackageWriteTransaction(stagingFolder);
    const abortStalePackage = async () => isPackageActivationCurrent()
      ? null
      : await failPackage('stale_activation');
    if (
      layoutMode !== manifest.plan.layoutMode ||
      layoutMode !== manifest.plan.packageSettings?.outputLayoutMode
    ) throw new PackageReviewChangedError();
    if (manifest.plan.diagnosticsMetadata) {
      const diagnosticsDirectory = path.posix.dirname(manifest.plan.diagnosticsMetadata.relativePath);
      if (
        manifest.plan.diagnosticsMetadata.materialization !== 'crate-provenance-v2' ||
        path.posix.basename(manifest.plan.diagnosticsMetadata.relativePath) !== PROVENANCE_MANIFEST_FILENAME ||
        outputAllocator.reserveNameOnly(DIAGNOSTICS_FOLDER_NAME) !== diagnosticsDirectory
      ) throw new PackageReviewChangedError();
    }
    const plannedDesignOutputs = [
      ...manifest.plan.reviewedSourceInputs.map(item => ({
        entryIndex: item.entryIndex,
        materialization: item.materialization,
        outputName: item.expectedOutputName,
        relativePath: item.relativePath,
      })),
      ...manifest.plan.deterministicDerivedOutputs
        .filter(item => item.materialization === 'psd-embedded-resource')
        .map(item => ({
          entryIndex: item.sourceEntryIndex,
          materialization: item.materialization,
          outputName: item.expectedOutputs[0]?.outputName,
          relativePath: item.expectedOutputs[0]?.relativePath,
          resourceFingerprint: item.expectedOutputs[0]?.resourceFingerprint,
        })),
    ].sort((left, right) => left.entryIndex - right.entryIndex);

    for (const plannedOutput of plannedDesignOutputs) {
      const file = packageFiles[plannedOutput.entryIndex];
      const manifestEntry = manifest.entries[plannedOutput.entryIndex];
      if (!file || !manifestEntry) throw new PackageReviewChangedError();
      const staleResult = await abortStalePackage(); if (staleResult) return staleResult;
      const packageFileName = getPackageFileDisplayName(file);
      const plannedRawName = plannedOutput.materialization === 'psd-embedded-resource'
        ? sanitizeEmbeddedPsdAssetName(file.name || file.embeddedOriginalName)
        : packageFileName;
      const allocatedOutputName = allocateOutputName(plannedRawName);
      if (
        allocatedOutputName !== plannedOutput.outputName ||
        getOutputRelativePath(allocatedOutputName) !== plannedOutput.relativePath
      ) throw new PackageReviewChangedError();
      try {
        if (plannedOutput.materialization === 'psd-embedded-resource') {
          if (!isScanOnSaveEmbeddedPsdFile(file)) throw new PackageReviewChangedError();
          const finalPath = packageWrites.prepare(plannedOutput.relativePath);
          if (!packageReviewFingerprintsMatch(manifestEntry.embeddedResource, plannedOutput.resourceFingerprint)) {
            throw new PackageReviewChangedError();
          }
          await writeEmbeddedPsdAssetToPackage(
            file,
            reviewedPackageSources.get(plannedOutput.entryIndex),
            plannedOutput.resourceFingerprint,
            finalPath,
            packageWrites.verify,
            packageWrites.isDescriptorBound(finalPath) ? packageWrites.materializeBuffer : null,
            packageWrites.rememberOwned
          );
          stagedSourceByFile.set(file, finalPath);
          const staleResult = await abortStalePackage(); if (staleResult) return staleResult;
          packageProvenanceEvents.push({
            relationType: EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE,
            file,
            outputPath: toPublishedPath(finalPath),
          });
          copiedCount++;
          continue;
        }

        if (plannedOutput.materialization !== 'source-copy') throw new PackageReviewChangedError();
        if (!file.path) throw new PackageReviewChangedError();
        const finalPath = packageWrites.prepare(plannedOutput.relativePath);
        await copyReviewedPackageSource(
          reviewedPackageSources.get(plannedOutput.entryIndex),
          finalPath,
          packageWrites.verify,
          packageWrites.isDescriptorBound(finalPath) ? packageWrites.materializeSource : null,
          packageWrites.rememberOwned
        );
        stagedSourceByFile.set(file, finalPath);
        packageProvenanceEvents.push({
          relationType: EDGE_TYPES.PACKAGE_INCLUDES_FILE,
          file,
          outputPath: toPublishedPath(finalPath),
        });
        copiedCount++;
      } catch (err) {
        if (err instanceof PackageReviewChangedError) throw err;
        if (err instanceof PackageTransactionInvariantError) return await failPackage(err);
        return await failPackage('package_write_failed');
      }
    }

    // Extract embedded media from zip-based design files (.key, .pptx)
    // These formats embed images internally as zip entries — lsof can't catch
    // the sub-100ms reads when assets are dragged in, so we pull them at package time.
    let embeddedCount = 0;
    const presentationExtractionEvents = [];
    for (const generator of manifest.plan.deterministicDerivedOutputs.filter(item => item.materialization === 'presentation-media')) {
      const file = packageFiles[generator.sourceEntryIndex];
      const stagedPath = stagedSourceByFile.get(file);
      if (!file || !stagedPath) throw new PackageReviewChangedError();
      const extractionFailures = [];
      try {
        const embeddedFiles = await extractEmbeddedMedia(stagedPath, stagingFolder, null, {
          source: 'package-extraction',
          logicalPresentationPath: file.path,
          failClosed: true,
          dedupFingerprints: generator.dedupFingerprints,
          dedupNameBases: generator.dedupNameBases,
          suppressedOccurrences: generator.suppressedOccurrences,
          reserveOutputName: allocateOutputName,
          getOutputRelativePath,
          expectedOutputs: generator.expectedOutputs,
          resolveOutputPath: relativePath => packageWrites.prepare(relativePath),
          onBeforeMaterialize: packageWrites.assertRoot,
          onBeforeWrite: packageWrites.verify,
          onAfterWrite: filePath => {
            packageWrites.verify(filePath);
            packageWrites.rememberOwned(filePath);
          },
          materializeBuffer: (filePath, data, mode) => (
            packageWrites.isDescriptorBound(filePath)
              ? packageWrites.materializeBuffer(filePath, data, mode)
              : packageWrites.materializeDirectBuffer(filePath, data, mode)
          ),
          onExtracted: (extraction) => {
            const resource = getPresentationMediaResourceIdentity(extraction.presentationPath, extraction.internalPath);
            if (!resource) return;
            const publishedExtraction = {
              ...extraction,
              materializedPath: toPublishedPath(extraction.materializedPath),
            };
            presentationExtractionEvents.push(publishedExtraction);
            packageProvenanceEvents.push({
              relationType: EDGE_TYPES.PACKAGE_EXTRACTS_RESOURCE,
              resource: {
                resourceKey: resource.resourceKey,
                internalPath: resource.internalPath,
                name: resource.name,
                ext: resource.ext,
                presentationPath: extraction.presentationPath,
                materializedPath: publishedExtraction.materializedPath,
                source: extraction.source,
              },
              outputPath: publishedExtraction.materializedPath,
            });
          },
          onExtractionError: (failure) => {
            extractionFailures.push(failure || true);
          },
          onInspectionError: (failure) => {
            extractionFailures.push(failure || true);
          },
        });
        if (extractionFailures.length > 0) throw new PackageReviewChangedError();
        const staleResult = await abortStalePackage(); if (staleResult) return staleResult;
        embeddedCount += embeddedFiles.length;
      } catch (embedErr) {
        if (embedErr instanceof PackageReviewChangedError) throw embedErr;
        if (embedErr instanceof PackageTransactionInvariantError) return await failPackage(embedErr);
        return await failPackage('package_write_failed');
      }
    }

    const staleResult = await abortStalePackage(); if (staleResult) return staleResult;
    if (manifest.plan.diagnosticsMetadata) {
      let manifestProject; try { manifestProject = structuredClone(project); recordPresentationMediaExtractionProvenanceForProject(manifestProject, presentationExtractionEvents); recordPackageProvenance(id, packageProvenanceInfo, packageProvenanceEvents, manifestProject); } catch (_) { manifestProject = project; }
      const organizedDiagnostics = manifest.plan.layoutMode === PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION;
      let legacyDiagnosticPath = null;
      if (!organizedDiagnostics) {
        legacyDiagnosticPath = packageWrites.prepareLegacyNested(manifest.plan.diagnosticsMetadata.relativePath);
      }
      await writePackageProvenanceManifest(id, packageProvenanceInfo, {
        copiedCount,
        embeddedCount,
        totalFiles: packageFiles.length,
        errors,
      }, manifestProject, true, stagingFolder, manifest.plan.diagnosticsMetadata.relativePath, (relativePath, data) => {
        const diagnosticPath = organizedDiagnostics
          ? packageWrites.prepare(relativePath)
          : legacyDiagnosticPath;
        packageWrites.verify(diagnosticPath);
        return organizedDiagnostics
          ? packageWrites.materializeBuffer(diagnosticPath, data, OWNER_ONLY_FILE_MODE)
          : packageWrites.materializeDirectBuffer(diagnosticPath, data, OWNER_ONLY_FILE_MODE);
      });
    }
    const stagedTreeSnapshot = packageWrites.captureTree();
    const finalManifest = await buildCanonicalPackageReviewManifest(id);
    if (
      finalManifest.error ||
      !finalManifest.materializable ||
      finalManifest.manifestKey !== reviewResult.snapshot.manifestKey ||
      !packageReviewFingerprintsMatch(finalManifest.plan, manifest.plan)
    ) {
      throw new PackageReviewChangedError();
    }
    if (!isPackageActivationCurrent()) throw new PackageReviewChangedError();
    reviewedPackageSources.assertCurrent();
    packageWrites.assertRoot();
    publishPrivatePackageDestination(packageDestination, stagedTreeSnapshot);
    packageWrites.adoptPublishedRoot(packageDestination.destFolder);

    persistPackageCompletion(id, {
      destFolder,
      packagedAt: Date.now(),
      packageInfo: packageProvenanceInfo,
      packageEvents: packageProvenanceEvents,
      presentationExtractionEvents,
    });
    packagePublished = true;
    packageWrites.dispose();
    packageWrites = null;

    // Auto-stop watcher — SECURITY REQUIREMENT
    stopWatching(id);

    const preferBackgroundNotification = settings.notifications === true && isPackageAutoForegroundSuppressed();
    const packageWindowWasForeground = preferBackgroundNotification ? false : isMainWindowForegroundVisible();
    const packageNotificationShown = settings.notifications
      ? showPackageCompleteNotification(project.name, copiedCount + embeddedCount, {
        deferShow: preferBackgroundNotification,
      })
      : false;

    // If Crate was backgrounded, leave focus alone so macOS can surface the native
    // notification. The renderer still shows Package Complete when the user returns.
    if (packageWindowWasForeground || !packageNotificationShown) {
      clearPackageAutoForegroundSuppression();
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
    if (err instanceof PackageDestinationOccupiedError) {
      if (!await cleanupStaging()) return { error: 'package_cleanup_failed' };
      return refreshedPackageDestinationReviewChangedResult(id, outputPath);
    }
    if (err instanceof PackageReviewChangedError) {
      if (!await cleanupStaging()) return { error: 'package_cleanup_failed' };
      return refreshedPackageReviewChangedResult(id);
    }
    if (!packagePublished) return await failPackage(err);
    clearPackageAutoForegroundSuppression();
    showTrayWindow();
    return { error: err?.code || 'package_failed' };
  }
  } finally {
    if (reviewedPackageSources) await reviewedPackageSources.close();
    if (packageActivation) packageActivation.close();
    packageInFlight = false;
  }
});

registerTrustedIpcHandler('projects:select-output', async () => {
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
  suppressPackageAutoForeground();
  return result.filePaths[0];
});

registerTrustedIpcHandler('projects:delete', (event, id) => {
  invalidatePackageReviewForProject(id);
  incompletePackageScans.delete(id);
  packageScanDiagnosticState.delete(id);
  stopWatching(id);
  illustratorActivationScopes.delete(id);
  figmaPackageTransferBlocks.delete(id);
  let removed = false;
  const result = mutateProject(id, (project, projects) => {
    const idx = projects.indexOf(project);
    if (idx !== -1) {
      projects.splice(idx, 1);
      removed = true;
    }
    return projects;
  });
  if (removed) {
    scheduleProjectCacheCleanup({
      projectIds: [id],
      removeOrphans: false,
    });
  }
  // If project wasn't found, return current state
  return (result || getProjects()).map(getIllustratorScopedProjectView);
});

registerTrustedIpcHandler('projects:delete-all', () => {
  packageReviewSnapshots.clear();
  currentPackageReviewTokenByProject.clear();
  consumedPackageReviewTokens.clear();
  incompletePackageScans.clear();
  packageScanDiagnosticState.clear();
  for (const projectId of watcherCoordinators.keys()) cancelWatcherCoordinator(projectId);
  const projectCacheIds = safeStoredProjectCacheIds();
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
  figmaPackageTransferBlocks.clear();
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
  watchingActivationTokens.clear();
  illustratorActivationScopes.clear();
  designAppRunningCache.clear(); // v2.4.2
  // v2.2.2: Clean up scan-on-open state
  scannedDesignFiles.clear();
  designFilePids.clear();
  assetBaselineScans.clear();

  clearFileVisualProjectCache();
  store.set('projects', []);
  if (projectCacheIds !== null) {
    scheduleProjectCacheCleanup({
      projectIds: projectCacheIds,
      removeOrphans: true,
    });
  }
  return [];
});

// --- V2 Quick Package ---

registerTrustedIpcHandler('v2:browse-file', async () => {
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

registerTrustedIpcHandler('v2:package-file', async (event, filePath) => {
  const { packageMasterFile } = require('./parsers/index.js');

  if (packageInFlight) return { error: 'package_in_flight' };
  packageInFlight = true;

  try {
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
  } finally {
    packageInFlight = false;
  }
});

registerTrustedIpcHandler('v2:supported-extensions', () => {
  const { SUPPORTED_EXTENSIONS } = require('./parsers/index.js');
  return SUPPORTED_EXTENSIONS;
});

// --- Figma Integration ---

registerTrustedIpcHandler('figma:status', async () => {
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

registerTrustedIpcHandler('figma:connect', async (event, token) => {
  const { FigmaParser } = require('./parsers/figma');
  const parser = new FigmaParser();

  const verification = await parser.verifyTokenCandidate(token);
  if (!verification.valid) {
    const error = verification.reason === 'invalid-token' || verification.reason === 'access-denied'
      ? 'invalid_token'
      : (verification.reason === 'rate-limited' ? 'rate_limited' : 'verification_failed');
    return { success: false, error };
  }

  const stored = await parser.storeToken(token);

  if (!stored) {
    return { success: false, error: 'secure_storage_unavailable' };
  }

  figmaRateLimitBackoffs.clear();
  // Start Figma polling for any currently watching projects
  const projects = getProjects();
  for (const project of projects) {
    if (!projectHasFigmaTrackedFiles(project)) continue;
    const preflight = await preflightProjectFigmaConnection(project);
    if (!preflight.success) {
      const warningUpdate = markProjectFigmaConnectionUnavailable(project.id);
      if (warningUpdate) sendToRenderer('project:updated', { projectId: project.id });
      stopFigmaPolling(project.id);
      continue;
    }
    const warningCleared = clearProjectFigmaConnectionUnavailable(project.id, preflight.preflights);
    if (warningCleared) sendToRenderer('project:updated', { projectId: project.id });
    if (project.status === 'watching' && projectHasFigmaTrackedFiles(project) && !figmaPollers.has(project.id)) {
      const activationToken = getActiveWatchingActivationToken(project.id);
      if (activationToken !== null) startFigmaPolling(project.id, activationToken);
    }
  }

  return { success: true };
});

registerTrustedIpcHandler('figma:disconnect', async () => {
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

  for (const project of getProjects()) {
    if (!projectHasFigmaTrackedFiles(project)) continue;
    const warningUpdate = markProjectFigmaConnectionUnavailable(project.id);
    if (warningUpdate) sendToRenderer('project:updated', { projectId: project.id });
  }

  return { success: deleted };
});

// Trigger a manual Figma scan for a specific project
registerTrustedIpcHandler('figma:scan-project', async (event, projectId) => {
  const activationToken = getActiveWatchingActivationToken(projectId);
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
  if (activationToken === null) {
    return { success: false, error: 'Project is not watching' };
  }

  try {
    const result = await pollFigmaForProjectCore(projectId, true, activationToken, null);
    if (result && result.rateLimited === true) {
      return {
        success: false,
        rateLimited: true,
        error: result.warning || figmaRateLimitWarning(),
        ...(result.retryAt ? { retryAt: result.retryAt } : {}),
        ...(result.retryAfterMs ? { retryAfterMs: result.retryAfterMs } : {})
      };
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: sanitizeFigmaRendererIssue(e) };
  }
});

// Get Figma assets count for a specific project
registerTrustedIpcHandler('figma:project-assets', async (event, projectId) => {
  const project = getIllustratorScopedProjectView(getProjects().find(p => p.id === projectId));
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

registerTrustedIpcHandler('figma:scan-now', async (event) => {
  // Phase 2: only scan watching projects that have a per-project Figma link.
  const projects = getProjects().filter(p =>
    p.status === 'watching' &&
    projectHasFigmaTrackedFiles(p)
  );
  if (projects.length === 0) {
    return { triggered: 0, skipped: 0, totalAddedCount: 0 };
  }

  const scannableProjects = projects
    .map(project => ({
      project,
      activationToken: getActiveWatchingActivationToken(project.id),
    }))
    .filter(({ project, activationToken }) => (
      activationToken !== null && !figmaManualScanInFlight.has(project.id)
    ));
  const skipped = projects.length - scannableProjects.length;

  if (scannableProjects.length === 0) {
    return { triggered: 0, skipped, totalAddedCount: 0, inFlight: true };
  }

  scannableProjects.forEach(({ project }) => {
    figmaManualScanInFlight.add(project.id);
    sendToRenderer('figma:scan-started', {
      projectId: project.id,
      source: 'manual',
      timestamp: Date.now()
    });
  });

  const scanResults = await Promise.all(
    scannableProjects.map(async ({ project, activationToken }) => {
      try {
        return await pollFigmaForProjectCore(project.id, false, activationToken, null);
      } finally {
        if (watchingActivationTokens.get(project.id) === activationToken) {
          figmaManualScanInFlight.delete(project.id);
        }
      }
    })
  );

  const totalAddedCount = scanResults.reduce((sum, result) => sum + (result?.addedCount || 0), 0);
  const rateLimitedCount = scanResults.filter(result => result && result.rateLimited === true).length;

  return {
    success: rateLimitedCount === 0,
    triggered: scannableProjects.length,
    skipped,
    totalAddedCount,
    rateLimitedCount,
    ...(rateLimitedCount > 0 ? { error: figmaRateLimitWarning() } : {})
  };
});

registerTrustedIpcHandler('settings:get', () => {
  return store.get('settings');
});

registerTrustedIpcHandler('settings:update', (event, key, value) => {
  // FIX 7 (M1): Whitelist allowed setting keys to prevent arbitrary store writes
  const ALLOWED_SETTINGS = new Set(["namingTemplate", "notifications", "includeDiagnosticReport", "showPackageDetails", "packageOutputLayoutMode"]);
  if (!ALLOWED_SETTINGS.has(key)) return store.get('settings');
  if (key === 'namingTemplate') {
    store.set(`settings.${key}`, sanitizeNamingTemplate(value));
    return store.get('settings');
  }
  if (key === 'packageOutputLayoutMode') {
    const previousMode = getPackageOutputLayoutModeFromSettings(store.get('settings') || {});
    const nextMode = normalizePackageOutputLayoutMode(value);
    store.set(`settings.${key}`, nextMode);
    if (previousMode !== nextMode) invalidateAllPackageReviews();
    return store.get('settings');
  }
  store.set(`settings.${key}`, value);
  return store.get('settings');
});

registerTrustedIpcHandler('usage:get', () => {
  return getUsageSnapshot();
});

registerTrustedIpcHandler('shell:open-folder', (event, folderPath) => {
  shell.openPath(folderPath);
});

// Inactivity responses
registerTrustedIpcHandler('inactivity:keep-watching', (event, projectId) => {
  lastFileActivity.set(projectId, Date.now());
  inactivityNotified.delete(projectId);
});

registerTrustedIpcHandler('inactivity:pause', (event, projectId) => {
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
  startupPhaseJournal.mark('ready-handler-entered');
  if (localStoreStartupError) {
    startupPhaseJournal.mark('startup-error');
    dialog.showErrorBox(
      'Crate could not open',
      'Crate could not secure its local settings. No project data was opened. Please quit and reopen Crate. If this continues, contact support.'
    );
    app.quit();
    return;
  }

  try {
    startupPhaseJournal.mark(
      configureFigmaCredentialStorage()
        ? 'figma-credential-storage-configured'
        : 'figma-credential-storage-failed'
    );

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
    migrateFigmaCredentialStorageInBackground();

    const activeProjectCacheIds = safeStoredProjectCacheIds();
    if (activeProjectCacheIds !== null) {
      scheduleProjectCacheCleanup({
        removeOrphans: true,
      });
    }

    // Repair legacy state before watcher recovery so only one project can consume
    // the global creative-app observation streams.
    startupPhaseJournal.mark('watch-recovery-start');
    const activeProject = repairPersistedWatchingProjects();
    startupPhaseJournal.mark('watch-state-repair-complete');
    let watchRecoveryPhase = 'watch-recovery-complete';
    if (activeProject) {
      try {
        startupPhaseJournal.mark('watch-resume-start');
        const recoveredProject = await startWatching(activeProject.id, { preserveWatchStartedAt: true });
        watchRecoveryPhase = getWatchRecoveryPhase(recoveredProject);
      } catch (e) {
        watchRecoveryPhase = 'watch-recovery-failed';
        console.error('[startup] failed to resume project watch:', redactFigmaLogText(e && e.message));
      }
    }
    startupPhaseJournal.mark(watchRecoveryPhase);
    startupPhaseJournal.mark('ready-handler-complete');
  } catch (e) {
    startupPhaseJournal.mark('startup-error');
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
  if (isPackageAutoForegroundSuppressed()) return;
  showMainWindow({ reason: 'did-become-active' });
});

app.on('second-instance', () => {
  markFirstOccurrenceStartupPhase('second-instance-received');
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
  startupPhaseJournal.mark('before-quit');
  startupPhaseJournal.close();
  isQuitting = true;
  mainWindowVisibleSinceStartup = true;
  for (const projectId of watcherCoordinators.keys()) cancelWatcherCoordinator(projectId);
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
