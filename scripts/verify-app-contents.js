'use strict';

const fs = require('fs');
const path = require('path');

const RUNTIME_PARSER_FILES = Object.freeze([
  'admission-budgets.js',
  'aftereffects.js',
  'ai.js',
  'base.js',
  'figma-credential-store.js',
  'figma-network.js',
  'figma-redaction.js',
  'figma.js',
  'indesign.js',
  'index.js',
  'package-safety.js',
  'powerpoint.js',
  'premiere.js',
  'psd.js'
]);

const REQUIRED_ASAR_ENTRIES = Object.freeze([
  '/package.json',
  '/main.js',
  '/preload.js',
  '/provenance.js',
  '/diagnostic-summary.js',
  '/renderer/app.js',
  '/renderer/index.html',
  '/renderer/styles.css',
  '/assets/tray-icon.png',
  ...RUNTIME_PARSER_FILES.map(fileName => `/parsers/${fileName}`)
]);

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
  REQUIRED_ASAR_ENTRIES,
  RUNTIME_PARSER_FILES,
  inspectAsarEntries,
  inspectUnpackedEntries,
  isAllowedAsarEntry,
  isSensitiveEntry,
  normalizeEntry,
  resolveAsarPath,
  verifyPackagedAppContents
};
