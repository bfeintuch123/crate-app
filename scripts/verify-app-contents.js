'use strict';

const fs = require('fs');
const path = require('path');

const RUNTIME_PARSER_FILES = Object.freeze([
  'admission-budgets.js',
  'adobe-push-bridge.js',
  'aftereffects.js',
  'ai.js',
  'add-files-operation.js',
  'add-files-regex-worker.js',
  'add-files-psd-worker.js',
  'base.js',
  'figma-credential-store.js',
  'figma-network.js',
  'figma-redaction.js',
  'figma.js',
  'font-handoff.js',
  'font-release-catalog.js',
  'indesign.js',
  'index.js',
  'ipc-delta-bridge.js',
  'linked-asset-matcher.js',
  'native-helper.js',
  'native-watcher-bridge.js',
  'ooxml-links.js',
  'xml-path.js',
  'package-safety.js',
  'package-transaction-worker.js',
  'powerpoint.js',
  'premiere.js',
  'project-state-machine.js',
  'psd.js',
  'sqlite-store.js',
  'working-source-recovery-core.js',
  'working-source-witness.js',
  'zip-reader.js'
]);

const REQUIRED_ASAR_ENTRIES = Object.freeze([
  '/package.json',
  '/main.js',
  '/startup-phase-journal.js',
  '/runtime-identity.json',
  '/account-config.json',
  '/account-config.js',
  '/account-credential-store.js',
  '/account-provider.js',
  '/account-session.js',

  '/preload.js',
  '/provenance.js',
  '/diagnostic-summary.js',
  '/renderer/app.js',
  '/renderer/index.html',
  '/renderer/styles.css',
  '/assets/tray-icon.png',
  ...RUNTIME_PARSER_FILES.map(fileName => `/parsers/${fileName}`)
]);

const NATIVE_HELPER_RESOURCE_DIRECTORY = 'native';
const NATIVE_HELPER_FILE_NAME = 'crate-helper';
const NATIVE_HELPER_FILE_MODE = 0o755;
const MACHO_MAGIC_64 = 0xfeedfacf;
const MACHO_CPU_TYPE_ARM64 = 0x0100000c;
const MACHO_CPU_SUBTYPE_MASK = 0x00ffffff;
const MACHO_FILE_TYPE_EXECUTE = 2;
const MACHO_HEADER_64_SIZE = 32;

// Thin little-endian arm64 (CPU_SUBTYPE_ARM64_ALL) MH_EXECUTE only: fat, x86_64,
// arm64e, dylib, bundle and script inputs are all rejected.
function hasThinArm64ExecuteHeader(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= MACHO_HEADER_64_SIZE &&
    bytes.readUInt32LE(0) === MACHO_MAGIC_64 &&
    bytes.readUInt32LE(4) === MACHO_CPU_TYPE_ARM64 &&
    (bytes.readUInt32LE(8) & MACHO_CPU_SUBTYPE_MASK) === 0 &&
    bytes.readUInt32LE(12) === MACHO_FILE_TYPE_EXECUTE;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mode === right.mode && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function readStableNativeHelperBytes(filePath) {
  let descriptor = null;
  try {
    const before = fs.lstatSync(filePath);
    if (before.isSymbolicLink() || !before.isFile() ||
        (before.mode & 0o7777) !== NATIVE_HELPER_FILE_MODE) {
      return null;
    }
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || !sameFileIdentity(before, opened)) return null;
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    const current = fs.lstatSync(filePath);
    if (!after.isFile() || !sameFileIdentity(opened, after) || current.isSymbolicLink() ||
        !current.isFile() || !sameFileIdentity(after, current) || bytes.length !== opened.size) {
      return null;
    }
    return bytes;
  } catch (error) {
    return null;
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch (error) {
        // The caller fails closed when the stable read cannot complete.
      }
    }
  }
}

// `<Resources>/native` must be a real directory holding exactly one regular,
// mode-0755, thin arm64 executable named `crate-helper`.
function inspectNativeHelperResource(resourcesPath) {
  const invalid = { valid: false, bytes: null };
  try {
    const nativePath = path.join(resourcesPath, NATIVE_HELPER_RESOURCE_DIRECTORY);
    const nativeBefore = fs.lstatSync(nativePath);
    if (nativeBefore.isSymbolicLink() || !nativeBefore.isDirectory()) return invalid;
    const entries = fs.readdirSync(nativePath);
    if (entries.length !== 1 || entries[0] !== NATIVE_HELPER_FILE_NAME) return invalid;
    const bytes = readStableNativeHelperBytes(path.join(nativePath, NATIVE_HELPER_FILE_NAME));
    if (!bytes || !hasThinArm64ExecuteHeader(bytes)) return invalid;
    const nativeAfter = fs.lstatSync(nativePath);
    if (nativeAfter.isSymbolicLink() || !nativeAfter.isDirectory() ||
        nativeAfter.dev !== nativeBefore.dev || nativeAfter.ino !== nativeBefore.ino) {
      return invalid;
    }
    const entriesAfter = fs.readdirSync(nativePath);
    if (entriesAfter.length !== 1 || entriesAfter[0] !== NATIVE_HELPER_FILE_NAME) return invalid;
    return { valid: true, bytes };
  } catch (error) {
    return invalid;
  }
}

function normalizeEntry(entry) {
  if (typeof entry !== 'string' || !entry.trim()) return null;
  const slashPath = entry.replace(/\\/g, '/');
  const segments = slashPath.split('/').filter(Boolean);
  if (segments.includes('..')) return null;
  return `/${segments.join('/')}`;
}

function isSensitiveEntry(entry) {
  return entry.split('/').filter(Boolean).some(segment => (
    /^\.env(?:\.|$)/i.test(segment) ||
    /^\.(?:npmrc|yarnrc)$/i.test(segment) ||
    /\.(?:pem|key|p12|pfx)$/i.test(segment) ||
    /^(?:id_rsa|id_ed25519)$/i.test(segment)
  ));
}

function isAllowedAsarEntry(entry) {
  if (isSensitiveEntry(entry)) return false;
  if (
    entry === '/package.json' ||
    entry === '/main.js' ||
    entry === '/startup-phase-journal.js' ||
    entry === '/runtime-identity.json' ||
    entry === '/account-config.json' ||
    entry === '/account-config.js' ||
    entry === '/account-credential-store.js' ||
    entry === '/account-provider.js' ||
    entry === '/account-session.js' ||

    entry === '/preload.js' ||
    entry === '/provenance.js' ||
    entry === '/diagnostic-summary.js'
  ) {
    return true;
  }
  if (entry === '/assets' || entry === '/assets/tray-icon.png') return true;
  if (entry === '/renderer' || /^\/renderer\/(?:app\.js|index\.html|styles\.css)$/.test(entry)) return true;
  if (entry === '/parsers' || RUNTIME_PARSER_FILES.some(fileName => entry === `/parsers/${fileName}`)) return true;
  return entry === '/node_modules' || entry.startsWith('/node_modules/');
}

function inspectAsarEntries(entries) {
  const normalizedEntries = [];
  const invalidEntries = [];

  for (const entry of entries || []) {
    const normalized = normalizeEntry(entry);
    if (!normalized) {
      invalidEntries.push(String(entry));
      continue;
    }
    normalizedEntries.push(normalized);
  }

  const entrySet = new Set(normalizedEntries);
  return {
    invalidEntries,
    disallowedEntries: normalizedEntries.filter(entry => !isAllowedAsarEntry(entry)),
    missingEntries: REQUIRED_ASAR_ENTRIES.filter(entry => !entrySet.has(entry)),
    entryCount: normalizedEntries.length
  };
}

function listUnpackedEntries(rootDirectory) {
  if (!fs.existsSync(rootDirectory)) return [];
  const entries = [];
  const pending = [rootDirectory];

  while (pending.length > 0) {
    const current = pending.pop();
    for (const child of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, child.name);
      const relativePath = path.relative(rootDirectory, absolutePath).split(path.sep).join('/');
      entries.push(`/${relativePath}`);
      if (child.isDirectory()) pending.push(absolutePath);
    }
  }

  return entries.sort();
}

function inspectUnpackedEntries(entries) {
  const normalizedEntries = [];
  const invalidEntries = [];

  for (const entry of entries || []) {
    const normalized = normalizeEntry(entry);
    if (!normalized) {
      invalidEntries.push(String(entry));
      continue;
    }
    normalizedEntries.push(normalized);
  }

  return {
    invalidEntries,
    disallowedEntries: normalizedEntries.filter(entry => (
      isSensitiveEntry(entry) ||
      (entry !== '/node_modules' && !entry.startsWith('/node_modules/'))
    )),
    entryCount: normalizedEntries.length
  };
}

function resolveAsarPath(inputPath) {
  const resolvedInput = path.resolve(inputPath);
  if (resolvedInput.endsWith('.asar')) return resolvedInput;
  return path.join(resolvedInput, 'Contents', 'Resources', 'app.asar');
}

function formatFailure(label, entries) {
  if (!entries.length) return [];
  const preview = entries.slice(0, 20).map(entry => `  - ${entry}`);
  if (entries.length > preview.length) preview.push(`  - ...and ${entries.length - preview.length} more`);
  return [`${label} (${entries.length}):`, ...preview];
}

function createVerificationError(message, exitCode) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

function verifyPackagedAppContents(inputPath, options = {}) {
  const asarPath = resolveAsarPath(inputPath);
  if (!fs.existsSync(asarPath)) {
    throw createVerificationError(`Packaged app ASAR not found: ${asarPath}`, 2);
  }

  let asar = options.asar;
  if (!asar) {
    try {
      asar = require('@electron/asar');
    } catch (error) {
      throw createVerificationError(
        'Unable to load @electron/asar from the installed electron-builder toolchain.',
        2
      );
    }
  }

  const asarResult = inspectAsarEntries(asar.listPackage(asarPath));
  const unpackedEntries = options.unpackedEntries || listUnpackedEntries(`${asarPath}.unpacked`);
  const unpackedResult = inspectUnpackedEntries(unpackedEntries);
  const failures = [
    ...formatFailure('Invalid ASAR entries', asarResult.invalidEntries),
    ...formatFailure('Disallowed ASAR entries', asarResult.disallowedEntries),
    ...formatFailure('Missing runtime ASAR entries', asarResult.missingEntries),
    ...formatFailure('Invalid unpacked entries', unpackedResult.invalidEntries),
    ...formatFailure('Disallowed unpacked entries', unpackedResult.disallowedEntries)
  ];

  if (failures.length > 0) {
    throw createVerificationError(['Crate packaged-content policy failed.', ...failures].join('\n'), 1);
  }

  // A bare ASAR input has no bundle around it; only an app bundle carries the helper.
  if (!path.resolve(inputPath).endsWith('.asar') &&
      !inspectNativeHelperResource(path.join(path.resolve(inputPath), 'Contents', 'Resources')).valid) {
    throw createVerificationError('Bundled native helper is missing or not approved.', 1);
  }

  return {
    asarEntryCount: asarResult.entryCount,
    unpackedEntryCount: unpackedResult.entryCount
  };
}

function run(argv = process.argv.slice(2)) {
  const inputPath = argv[0] || path.join('dist', 'mac-arm64', 'Crate.app');
  try {
    const result = verifyPackagedAppContents(inputPath);
    console.log(`Crate packaged-content policy passed (${result.asarEntryCount} ASAR entries, ${result.unpackedEntryCount} unpacked entries).`);
  } catch (error) {
    console.error(error && error.message ? error.message : 'Crate packaged-content policy failed.');
    process.exitCode = Number.isInteger(error && error.exitCode) ? error.exitCode : 1;
  }
}

if (require.main === module) run();

module.exports = {
  NATIVE_HELPER_FILE_MODE,
  NATIVE_HELPER_FILE_NAME,
  NATIVE_HELPER_RESOURCE_DIRECTORY,
  REQUIRED_ASAR_ENTRIES,
  RUNTIME_PARSER_FILES,
  hasThinArm64ExecuteHeader,
  inspectAsarEntries,
  inspectNativeHelperResource,
  inspectUnpackedEntries,
  isAllowedAsarEntry,
  isSensitiveEntry,
  normalizeEntry,
  readStableNativeHelperBytes,
  resolveAsarPath,
  verifyPackagedAppContents
};
