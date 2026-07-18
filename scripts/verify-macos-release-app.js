'use strict';

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const packageJson = require('../package.json');
const afterPack = require('./patch-helper-info-plists');
const {
  RUNTIME_PARSER_FILES,
  resolveAsarPath,
  verifyPackagedAppContents,
} = require('./verify-app-contents');
const {
  APPROVED_CANVAS_PREBUILD_FILES,
  collectApprovedCanvasPrebuildDigests,
} = require('./install-approved-canvas-prebuild');

const EXPECTED_FUSES = Object.freeze({
  RunAsNode: false,
  EnableCookieEncryption: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  LoadBrowserProcessSpecificV8Snapshot: false,
  GrantFileProtocolExtraPrivileges: true,
});

const PUBLIC_APP_ID = 'com.crate.app';
const PUBLIC_TEAM_ID = 'YY7WDMUFWJ';
const EXPECTED_ARCHITECTURE = 'arm64';
const SAFE_GIT_ARGUMENT_PREFIX = Object.freeze([
  '--no-optional-locks',
  '--no-replace-objects',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
]);
const ELECTRON_FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii');
const EXPECTED_ELECTRON_ARCHIVE_ROOT_ENTRIES = Object.freeze([
  'Electron.app',
  'LICENSE',
  'LICENSES.chromium.html',
  'version',
]);
const APPROVED_UNIVERSAL_MACHO = Object.freeze({
  'Resources/app.asar.unpacked/node_modules/fsevents/fsevents.node': Object.freeze([
    'arm64',
    'x86_64',
  ]),
});
const APPROVED_CANVAS_PREBUILD_ENTRIES = Object.freeze([
  ...APPROVED_CANVAS_PREBUILD_FILES,
]);

const EXPECTED_RUNTIME_ENTITLEMENTS = Object.freeze([
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation',
]);

const EXPECTED_MAIN_ENTITLEMENTS = Object.freeze([
  ...EXPECTED_RUNTIME_ENTITLEMENTS,
  'com.apple.security.automation.apple-events',
].sort());

const EXPECTED_HELPER_ENTITLEMENTS = Object.freeze([...EXPECTED_RUNTIME_ENTITLEMENTS].sort());

const EXPECTED_PRIVACY_USAGE_KEYS = Object.freeze(['NSAppleEventsUsageDescription']);
const EXPECTED_MAIN_INFO_KEYS = Object.freeze([
  'CFBundleDisplayName',
  'CFBundleExecutable',
  'CFBundleIconFile',
  'CFBundleIdentifier',
  'CFBundleInfoDictionaryVersion',
  'CFBundleName',
  'CFBundlePackageType',
  'CFBundleShortVersionString',
  'CFBundleVersion',
  'DTCompiler',
  'DTSDKBuild',
  'DTSDKName',
  'DTXcode',
  'DTXcodeBuild',
  'ElectronAsarIntegrity',
  'LSApplicationCategoryType',
  'LSEnvironment',
  'LSMinimumSystemVersion',
  'NSAppTransportSecurity',
  'NSAppleEventsUsageDescription',
  'NSHighResolutionCapable',
  'NSHumanReadableCopyright',
  'NSMainNibFile',
  'NSPrefersDisplaySafeAreaCompatibilityMode',
  'NSPrincipalClass',
  'NSQuitAlwaysKeepsWindows',
  'NSRequiresAquaSystemAppearance',
  'NSSupportsAutomaticGraphicsSwitching',
].sort());
const EXPECTED_HELPER_INFO_KEYS = Object.freeze([
  'CFBundleDisplayName',
  'CFBundleExecutable',
  'CFBundleIdentifier',
  'CFBundleName',
  'CFBundlePackageType',
  'CFBundleVersion',
  'DTCompiler',
  'DTSDKBuild',
  'DTSDKName',
  'DTXcode',
  'DTXcodeBuild',
  'LSEnvironment',
  'LSUIElement',
  'NSAppleEventsUsageDescription',
  'NSSupportsAutomaticGraphicsSwitching',
].sort());
const BUILD_METADATA_KEYS = Object.freeze([
  'DTCompiler',
  'DTSDKBuild',
  'DTSDKName',
  'DTXcode',
  'DTXcodeBuild',
]);

const EXPECTED_HELPER_COUNT = 4;
const EXPECTED_FUSE_VERSION = '1';
const EXPECTED_FUSE_INDICES = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7]);
const FUSE_INDEX_BY_NAME = Object.freeze({
  RunAsNode: 0,
  EnableCookieEncryption: 1,
  EnableNodeOptionsEnvironmentVariable: 2,
  EnableNodeCliInspectArguments: 3,
  EnableEmbeddedAsarIntegrityValidation: 4,
  OnlyLoadAppFromAsar: 5,
  LoadBrowserProcessSpecificV8Snapshot: 6,
  GrantFileProtocolExtraPrivileges: 7,
});
const EXPECTED_NESTED_BUNDLE_NAMES = Object.freeze([
  'Electron Framework.framework',
  'Mantle.framework',
  'ReactiveObjC.framework',
  'Squirrel.framework',
]);
const EXPECTED_NESTED_BUNDLE_IDENTIFIERS = Object.freeze({
  'Electron Framework.framework': 'com.github.Electron.framework',
  'Mantle.framework': 'org.mantle.Mantle',
  'ReactiveObjC.framework': 'com.electron.reactive',
  'Squirrel.framework': 'com.github.Squirrel',
});
const EXPECTED_ASAR_INTEGRITY_PATH = 'Resources/app.asar';
const EXPECTED_APP_UPDATE_METADATA = Buffer.from(
  'owner: bfeintuch123\n' +
  'repo: crate-app\n' +
  'provider: github\n' +
  'updaterCacheDirName: crate-app-updater\n',
  'utf8'
);
const SOURCE_BOUND_ENTRIES = Object.freeze([
  'main.js',
  'preload.js',
  'provenance.js',
  'diagnostic-summary.js',
  'renderer/app.js',
  'renderer/index.html',
  'renderer/styles.css',
  'assets/tray-icon.png',
  ...RUNTIME_PARSER_FILES.map(fileName => `parsers/${fileName}`),
]);
const EXTERNAL_SOURCE_BOUND_ENTRIES = Object.freeze([
  Object.freeze({
    artifact: 'Contents/Resources/icon.icns',
    source: 'assets/icon.icns',
  }),
]);
const SOURCE_BOUND_ENTRY_COUNT = SOURCE_BOUND_ENTRIES.length +
  EXTERNAL_SOURCE_BOUND_ENTRIES.length;
const EXPECTED_PACKAGED_MANIFEST_KEYS = Object.freeze([
  'dependencies',
  'description',
  'main',
  'name',
  'productName',
  'version',
]);
const NESTED_CODE_BUNDLE_SUFFIXES = Object.freeze([
  '.app',
  '.appex',
  '.framework',
  '.plugin',
  '.xpc',
]);
const DEPENDENCY_EXCLUDED_NAMES = new Set([
  '.DS_Store',
  '.circleci',
  '.eslintrc',
  '.flowconfig',
  '.git',
  '.gitattributes',
  '.github',
  '.gitignore',
  '.gitkeep',
  '.hg',
  '.husky',
  '.idea',
  '.jshintrc',
  '.npmignore',
  '.nyc_output',
  '.svn',
  '.vs',
  '.yarn-integrity',
  '.yarn-metadata.json',
  'CHANGELOG.md',
  'CVS',
  'ChangeLog',
  'Changelog',
  'Changelog.md',
  'RCS',
  'SCCS',
  '__pycache__',
  'appveyor.yml',
  'binding.gyp',
  'bun.lock',
  'bun.lockb',
  'changelog.md',
  'circle.yml',
  'electron-builder.env',
  'node_gyp_bins',
  'node_modules',
  'npm-debug.log',
  'package-lock.json',
  'pnpm-lock.yaml',
  'thumbs.db',
  '.travis.yml',
  'yarn-error.log',
  'yarn.lock',
]);
const DEPENDENCY_TOP_LEVEL_EXCLUDED_NAMES = new Set([
  '.bin',
  '.coveralls.yml',
  'README',
  'README.md',
  'Readme',
  'Readme.md',
  '__tests__',
  'example',
  'examples',
  'karma.conf.js',
  'powered-test',
  'readme',
  'readme.markdown',
  'readme.md',
  'test',
  'tests',
]);
const DEPENDENCY_EXCLUDED_SUFFIXES = Object.freeze([
  '.a',
  '.cc',
  '.csproj',
  '.d.ts',
  '.forge-meta',
  '.hprof',
  '.iml',
  '.mk',
  '.o',
  '.obj',
  '.orig',
  '.pdb',
  '.pyc',
  '.pyo',
  '.rbc',
  '.sln',
  '.suo',
  '.swp',
  '.xproj',
]);
const DEPENDENCY_MANIFEST_REMOVED_KEYS = new Set([
  'ava',
  'bugs',
  'build',
  'bundleDependencies',
  'contributors',
  'dist',
  'eslintConfig',
  'gitHead',
  'jspm',
  'keywords',
  'nyc',
  'scripts',
  'tags',
  'xo',
]);

function createVerificationError(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  error.isVerificationError = true;
  return error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactTrueKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const actualKeys = Object.keys(value).sort();
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    actualKeys.every(key => value[key] === true);
}

function hasStrictTransportPolicy(infoPlist) {
  const policy = infoPlist && infoPlist.NSAppTransportSecurity;
  return isPlainObject(policy) &&
    Object.keys(policy).length === 1 &&
    policy.NSAllowsArbitraryLoads === false;
}

function privacyUsageKeys(infoPlist) {
  return Object.keys(isPlainObject(infoPlist) ? infoPlist : {})
    .filter(key => /^NS.+UsageDescription$/u.test(key))
    .sort();
}

function hasExactValues(actual, expected) {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function hasExactObjectKeys(value, expectedKeys) {
  return isPlainObject(value) && hasExactValues(Object.keys(value).sort(), expectedKeys);
}

function buildMetadata(infoPlist) {
  return Object.fromEntries(BUILD_METADATA_KEYS.map(key => [key, infoPlist && infoPlist[key]]));
}

function hasRequiredBuildMetadata(infoPlist) {
  return infoPlist.DTCompiler === 'com.apple.compilers.llvm.clang.1_0' &&
    /^[A-Z0-9]+$/u.test(String(infoPlist.DTSDKBuild || '')) &&
    /^macosx\d+(?:\.\d+)*$/u.test(String(infoPlist.DTSDKName || '')) &&
    /^\d+$/u.test(String(infoPlist.DTXcode || '')) &&
    /^[A-Z0-9]+$/u.test(String(infoPlist.DTXcodeBuild || ''));
}

function hasApprovedMainInfoPlist(infoPlist, options = {}) {
  const executableName = options.expectedExecutableName;
  const appId = options.expectedAppId;
  const version = options.expectedVersion;
  const escapedExecutable = String(executableName || '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return hasExactObjectKeys(infoPlist, EXPECTED_MAIN_INFO_KEYS) &&
    hasRequiredBuildMetadata(infoPlist) &&
    infoPlist.CFBundleDisplayName === executableName &&
    infoPlist.CFBundleExecutable === executableName &&
    infoPlist.CFBundleName === executableName &&
    infoPlist.CFBundleIdentifier === appId &&
    infoPlist.CFBundleInfoDictionaryVersion === '6.0' &&
    infoPlist.CFBundlePackageType === 'APPL' &&
    infoPlist.CFBundleShortVersionString === version &&
    infoPlist.CFBundleVersion === version &&
    infoPlist.CFBundleIconFile === 'icon.icns' &&
    infoPlist.LSApplicationCategoryType === packageJson.build.mac.category &&
    infoPlist.LSMinimumSystemVersion === '12.0' &&
    infoPlist.NSMainNibFile === 'MainMenu' &&
    infoPlist.NSPrincipalClass === 'AtomApplication' &&
    infoPlist.NSHighResolutionCapable === true &&
    infoPlist.NSPrefersDisplaySafeAreaCompatibilityMode === false &&
    infoPlist.NSQuitAlwaysKeepsWindows === false &&
    infoPlist.NSRequiresAquaSystemAppearance === false &&
    infoPlist.NSSupportsAutomaticGraphicsSwitching === true &&
    isDeepStrictEqual(infoPlist.LSEnvironment, { MallocNanoZone: '0' }) &&
    new RegExp(`^Copyright \\u00a9 \\d{4} ${escapedExecutable}$`, 'u')
      .test(String(infoPlist.NSHumanReadableCopyright || ''));
}

function expectedHelperIdentifier(helperName, appId) {
  const roleMatch = String(helperName || '').match(/ Helper(?: \((GPU|Plugin|Renderer)\))?\.app$/u);
  if (!roleMatch) return null;
  return `${appId}.helper${roleMatch[1] ? `.${roleMatch[1]}` : ''}`;
}

function hasApprovedHelperInfoPlist(infoPlist, helperName, options = {}) {
  const executableName = options.expectedExecutableName;
  const appId = options.expectedAppId;
  const version = options.expectedVersion;
  const helperExecutable = helperName.slice(0, -'.app'.length);
  const roleMatch = helperName.match(/ Helper(?: \((GPU|Plugin|Renderer)\))?\.app$/u);
  const helperRoleName = roleMatch && roleMatch[1] ? ` (${roleMatch[1]})` : '';
  return helperName.startsWith(`${executableName} Helper`) &&
    hasExactObjectKeys(infoPlist, EXPECTED_HELPER_INFO_KEYS) &&
    hasRequiredBuildMetadata(infoPlist) &&
    isDeepStrictEqual(buildMetadata(infoPlist), options.expectedBuildMetadata) &&
    infoPlist.CFBundleDisplayName === helperExecutable &&
    infoPlist.CFBundleExecutable === helperExecutable &&
    infoPlist.CFBundleIdentifier === expectedHelperIdentifier(helperName, appId) &&
    infoPlist.CFBundleName === `Electron Helper${helperRoleName}` &&
    infoPlist.CFBundlePackageType === 'APPL' &&
    infoPlist.CFBundleVersion === version &&
    infoPlist.LSUIElement === true &&
    infoPlist.NSAppleEventsUsageDescription === afterPack.APPLE_EVENTS_USAGE_DESCRIPTION &&
    infoPlist.NSSupportsAutomaticGraphicsSwitching === true &&
    isDeepStrictEqual(infoPlist.LSEnvironment, { MallocNanoZone: '0' });
}

function hasApprovedNestedSignature(signature, expectedIdentifier, expectedTeamId) {
  return isPlainObject(signature) &&
    signature.valid === true &&
    signature.identifier === expectedIdentifier &&
    signature.teamIdentifier === expectedTeamId &&
    /^[a-f0-9]{64}$/u.test(String(signature.codeDirectoryHash || '')) &&
    Array.isArray(signature.authorities) &&
    signature.authorities.some(authority => /^Developer ID Application:/u.test(authority)) &&
    signature.hardenedRuntime === true &&
    signature.timestamped === true;
}

function hasValidAsarIntegrity(infoPlist) {
  const integrity = infoPlist && infoPlist.ElectronAsarIntegrity;
  if (!isPlainObject(integrity) || Object.keys(integrity).length !== 1) return false;
  const appAsar = integrity[EXPECTED_ASAR_INTEGRITY_PATH];
  return isPlainObject(appAsar) &&
    Object.keys(appAsar).sort().join(',') === 'algorithm,hash' &&
    appAsar.algorithm === 'SHA256' &&
    typeof appAsar.hash === 'string' &&
    /^[a-f0-9]{64}$/u.test(appAsar.hash);
}

function asarIntegrityMatches(infoPlist, actualHash) {
  if (!hasValidAsarIntegrity(infoPlist) || !/^[a-f0-9]{64}$/u.test(String(actualHash || ''))) {
    return false;
  }
  return infoPlist.ElectronAsarIntegrity[EXPECTED_ASAR_INTEGRITY_PATH].hash === actualHash;
}

function isSafeExecutableName(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    path.basename(value) === value;
}

function parseCodeSignatureMetadata(output) {
  const metadata = {
    identifier: null,
    teamIdentifier: null,
    codeDirectoryHash: null,
    authorities: [],
    hardenedRuntime: false,
    timestamped: false,
  };

  for (const line of String(output || '').split(/\r?\n/u)) {
    if (line.startsWith('Identifier=')) metadata.identifier = line.slice('Identifier='.length).trim();
    if (line.startsWith('TeamIdentifier=')) {
      metadata.teamIdentifier = line.slice('TeamIdentifier='.length).trim();
    }
    if (line.startsWith('CDHashFull=')) {
      metadata.codeDirectoryHash = line.slice('CDHashFull='.length).trim().toLowerCase();
    }
    const candidateHash = line.match(/^CandidateCDHashFull\s+[^=]+=([a-f0-9]{64})$/iu);
    if (candidateHash) metadata.codeDirectoryHash = candidateHash[1].toLowerCase();
    if (line.startsWith('Authority=')) metadata.authorities.push(line.slice('Authority='.length).trim());
    if (line.startsWith('Timestamp=')) {
      const timestamp = line.slice('Timestamp='.length).trim();
      metadata.timestamped = !/^(?:none|null)$/iu.test(timestamp) &&
        Number.isFinite(Date.parse(timestamp.replace(' at ', ' ')));
    }
    if (/^CodeDirectory\b.*\bruntime\b/u.test(line)) metadata.hardenedRuntime = true;
  }

  return metadata;
}

function inspectFuseWire(wire) {
  const indices = Object.keys(wire || {})
    .filter(key => /^\d+$/u.test(key))
    .map(Number)
    .sort((left, right) => left - right);
  return {
    version: String(wire && wire.version !== undefined ? wire.version : ''),
    indices,
    states: normalizeFuseWire(wire),
  };
}

function normalizeFuseWire(wire) {
  const normalized = {};
  for (const name of Object.keys(EXPECTED_FUSES)) {
    const index = FUSE_INDEX_BY_NAME[name];
    const value = wire && wire[index];
    if (value === true || value === 1 || value === 49 || value === '1') {
      normalized[name] = true;
    } else if (value === false || value === 0 || value === 48 || value === '0') {
      normalized[name] = false;
    } else {
      normalized[name] = null;
    }
  }
  return normalized;
}

function collectPolicyFailures(evidence, options = {}) {
  const failures = [];
  const expectedAppId = options.expectedAppId;
  const expectedTeamId = options.expectedTeamId;
  const expectedExecutableName = options.expectedExecutableName || packageJson.productName;
  const signature = evidence.signature || {};
  const infoPlist = evidence.infoPlist || {};
  const notarization = evidence.notarization || {};

  if (evidence.artifactStable !== true) {
    failures.push('Signed app changed during verification.');
  }
  if (signature.valid !== true) failures.push('Code signature verification failed.');
  if (signature.identifier !== expectedAppId) {
    failures.push('Signed bundle identifier does not match the approved app identifier.');
  }
  if (signature.teamIdentifier !== expectedTeamId) {
    failures.push('Signing team does not match the approved Crate team.');
  }
  if (!Array.isArray(signature.authorities) ||
      !signature.authorities.some(authority => /^Developer ID Application:/u.test(authority))) {
    failures.push('Developer ID Application signature is missing.');
  }
  if (signature.hardenedRuntime !== true) {
    failures.push('Hardened runtime is not enabled in the final signature.');
  }
  if (signature.timestamped !== true) failures.push('Secure signing timestamp is missing.');
  if (!/^[a-f0-9]{64}$/u.test(String(signature.codeDirectoryHash || ''))) {
    failures.push('Signed code fingerprint is missing or invalid.');
  }

  const architecture = evidence.architecture || {};
  if (architecture.valid !== true || architecture.expected !== EXPECTED_ARCHITECTURE ||
      !hasExactValues(architecture.main, [EXPECTED_ARCHITECTURE]) ||
      !Number.isInteger(architecture.machOBinaryCount) || architecture.machOBinaryCount < 1) {
    failures.push('Packaged executable architectures do not match the approved arm64 target.');
  }

  if (infoPlist.CFBundleIdentifier !== expectedAppId) {
    failures.push('Final bundle metadata does not match the approved app identifier.');
  }
  const expectedVersion = options.expectedVersion || packageJson.version;
  if (!hasApprovedMainInfoPlist(infoPlist, {
    expectedAppId,
    expectedExecutableName,
    expectedVersion,
  })) {
    failures.push('Main app metadata contains unapproved keys or values.');
  }
  if (!isSafeExecutableName(infoPlist.CFBundleExecutable)) {
    failures.push('Bundle executable metadata is missing or invalid.');
  } else if (infoPlist.CFBundleExecutable !== expectedExecutableName) {
    failures.push('Bundle executable name does not match the approved product configuration.');
  }
  if (infoPlist.NSAppleEventsUsageDescription !== afterPack.APPLE_EVENTS_USAGE_DESCRIPTION) {
    failures.push('Apple Events purpose text is missing or changed.');
  }
  if (!hasStrictTransportPolicy(infoPlist)) {
    failures.push('App Transport Security is not the approved strict policy.');
  }
  if (!hasExactValues(privacyUsageKeys(infoPlist), EXPECTED_PRIVACY_USAGE_KEYS)) {
    failures.push('Privacy permission declarations do not match the approved policy.');
  }
  if (!hasValidAsarIntegrity(infoPlist)) {
    failures.push('Embedded ASAR integrity metadata is missing or invalid.');
  } else if (!asarIntegrityMatches(infoPlist, evidence.asarIntegrityHash)) {
    failures.push('Embedded ASAR integrity metadata does not match the packaged archive.');
  }
  if (infoPlist.CFBundleShortVersionString !== expectedVersion) {
    failures.push('Final app version does not match source release metadata.');
  }
  if (infoPlist.CFBundleVersion !== expectedVersion) {
    failures.push('Final app build version does not match source release metadata.');
  }

  if (evidence.fuseVersion !== EXPECTED_FUSE_VERSION ||
      !Array.isArray(evidence.fuseIndices) ||
      evidence.fuseIndices.length !== EXPECTED_FUSE_INDICES.length ||
      !evidence.fuseIndices.every((index, position) => index === EXPECTED_FUSE_INDICES[position])) {
    failures.push('Electron fuse wire version or shape changed.');
  }
  for (const [name, expected] of Object.entries(EXPECTED_FUSES)) {
    if (!evidence.fuses || evidence.fuses[name] !== expected) {
      failures.push(`Electron fuse policy changed: ${name}.`);
    }
  }
  if (evidence.fuses && Object.keys(evidence.fuses).some(name => !Object.hasOwn(EXPECTED_FUSES, name))) {
    failures.push('Electron fuse policy contains unreviewed entries.');
  }

  if (!hasExactTrueKeys(evidence.mainEntitlements, EXPECTED_MAIN_ENTITLEMENTS)) {
    failures.push('Main app entitlements do not match the approved policy.');
  }

  const helpers = Array.isArray(evidence.helpers) ? evidence.helpers : [];
  const executableName = expectedExecutableName;
  const expectedHelperNames = isSafeExecutableName(executableName)
    ? [
      `${executableName} Helper.app`,
      `${executableName} Helper (GPU).app`,
      `${executableName} Helper (Plugin).app`,
      `${executableName} Helper (Renderer).app`,
    ].sort()
    : [];
  const helperNames = helpers.map(helper => helper && helper.name).sort();
  if (helpers.length !== EXPECTED_HELPER_COUNT ||
      helperNames.length !== expectedHelperNames.length ||
      !helperNames.every((name, index) => name === expectedHelperNames[index])) {
    failures.push('Expected Electron helper app set is incomplete.');
  }
  if (helpers.some(helper => (
    !hasExactTrueKeys(helper && helper.entitlements, EXPECTED_HELPER_ENTITLEMENTS) ||
    !hasApprovedHelperInfoPlist(helper && helper.infoPlist, helper && helper.name, {
      expectedBuildMetadata: buildMetadata(infoPlist),
      expectedAppId,
      expectedExecutableName,
      expectedVersion,
    }) ||
    helper.usageDescription !== afterPack.APPLE_EVENTS_USAGE_DESCRIPTION ||
    !hasExactValues(helper && helper.privacyUsageKeys, EXPECTED_PRIVACY_USAGE_KEYS)
  ))) {
    failures.push('Helper app metadata or entitlements do not match the approved policy.');
  }
  const expectedHelperIdentifiers = new Map([
    [`${executableName} Helper.app`, `${expectedAppId}.helper`],
    [`${executableName} Helper (GPU).app`, `${expectedAppId}.helper.GPU`],
    [`${executableName} Helper (Plugin).app`, `${expectedAppId}.helper.Plugin`],
    [`${executableName} Helper (Renderer).app`, `${expectedAppId}.helper.Renderer`],
  ]);
  if (helpers.some(helper => !hasApprovedNestedSignature(
    helper && helper.signature,
    expectedHelperIdentifiers.get(helper && helper.name),
    expectedTeamId
  ))) {
    failures.push('Helper app signature policy changed.');
  }

  const nestedBundles = Array.isArray(evidence.nestedBundles) ? evidence.nestedBundles : [];
  const nestedBundleNames = nestedBundles.map(bundle => bundle && bundle.name).sort();
  if (nestedBundleNames.length !== EXPECTED_NESTED_BUNDLE_NAMES.length ||
      !nestedBundleNames.every((name, index) => name === EXPECTED_NESTED_BUNDLE_NAMES[index]) ||
      nestedBundles.some(bundle => !isPlainObject(bundle && bundle.entitlements) ||
        Object.keys(bundle.entitlements).length !== 0)) {
    failures.push('Nested code bundle policy changed.');
  }
  if (nestedBundles.some(bundle => !hasApprovedNestedSignature(
    bundle && bundle.signature,
    EXPECTED_NESTED_BUNDLE_IDENTIFIERS[bundle && bundle.name],
    expectedTeamId
  ))) {
    failures.push('Nested code-signature policy changed.');
  }

  const packagedContents = evidence.packagedContents || {};
  if (!Number.isInteger(packagedContents.asarEntryCount) || packagedContents.asarEntryCount <= 0 ||
      !Number.isInteger(packagedContents.unpackedEntryCount) || packagedContents.unpackedEntryCount < 0) {
    failures.push('Packaged-content verification did not produce valid proof.');
  }
  if (!evidence.bundleLayout || evidence.bundleLayout.valid !== true) {
    failures.push('Final app bundle layout contains unapproved content.');
  }
  const electronRuntime = evidence.electronRuntime || {};
  if (electronRuntime.valid !== true || electronRuntime.archiveVerified !== true ||
      electronRuntime.payloadMatches !== true ||
      !/^\d+\.\d+\.\d+$/u.test(String(electronRuntime.lockedVersion || ''))) {
    failures.push('Packaged Electron runtime does not match the authenticated locked distribution.');
  }
  const sourceBinding = evidence.sourceBinding || {};
  if (sourceBinding.matches !== true ||
      sourceBinding.manifestMatches !== true ||
      !/^[a-f0-9]{40}$/u.test(String(sourceBinding.revision || '')) ||
      sourceBinding.entryCount !== SOURCE_BOUND_ENTRY_COUNT) {
    failures.push('Packaged first-party files do not match the current source revision.');
  }
  if (sourceBinding.dependencyLockMatches !== true) {
    failures.push(
      'Packaged dependency payload does not match the reconstructed production dependency tree.'
    );
  }

  if (notarization.required === true) {
    if (sourceBinding.releaseSourceClean !== true) {
      failures.push('Public release source tree is not clean.');
    }
    if (!/^[a-f0-9]{40}$/u.test(String(options.expectedRevision || '')) ||
        sourceBinding.revision !== options.expectedRevision) {
      failures.push('Artifact source revision does not match the approved release commit.');
    }
    if (notarization.gatekeeperAccepted !== true) {
      failures.push('Gatekeeper did not accept the release app.');
    }
    if (notarization.stapleValid !== true) {
      failures.push('Notarization staple validation failed.');
    }
  }

  return failures;
}

function buildPrivacySafeProof(evidence, failures, options = {}) {
  const notarization = evidence.notarization || {};
  const signature = evidence.signature || {};
  const infoPlist = evidence.infoPlist || {};
  const helperCount = Array.isArray(evidence.helpers) ? evidence.helpers.length : 0;
  const nestedBundleCount = Array.isArray(evidence.nestedBundles) ? evidence.nestedBundles.length : 0;
  const packagedContents = evidence.packagedContents || {};
  const sourceBinding = evidence.sourceBinding || {};
  const electronRuntime = evidence.electronRuntime || {};
  const passed = Array.isArray(failures) && failures.length === 0;
  const expectedAppId = options.expectedAppId || PUBLIC_APP_ID;
  const expectedTeamId = options.expectedTeamId || PUBLIC_TEAM_ID;
  const expectedVersion = options.expectedVersion || packageJson.version;
  const bundleIdentifier = infoPlist.CFBundleIdentifier === expectedAppId &&
    signature.identifier === expectedAppId
    ? expectedAppId
    : null;
  const teamIdentifier = signature.teamIdentifier === expectedTeamId ? expectedTeamId : null;
  const version = infoPlist.CFBundleShortVersionString === expectedVersion
    ? expectedVersion
    : null;
  const buildVersion = infoPlist.CFBundleVersion === expectedVersion ? expectedVersion : null;
  const codeDirectoryHash = /^[a-f0-9]{64}$/u.test(String(signature.codeDirectoryHash || ''))
    ? signature.codeDirectoryHash
    : null;
  const sourceRevision = /^[a-f0-9]{40}$/u.test(String(sourceBinding.revision || ''))
    ? sourceBinding.revision
    : null;

  return {
    schemaVersion: 1,
    policy: 'crate-macos-release-v1',
    releaseReady: passed && notarization.required === true,
    artifact: {
      kind: 'macos-app',
      productName: packageJson.productName,
      bundleIdentifier,
      teamIdentifier,
      version,
      buildVersion,
      codeDirectoryHash,
      sourceRevision,
    },
    checks: {
      signedArtifactPolicy: passed ? 'pass' : 'fail',
      architecture: evidence.architecture && evidence.architecture.valid === true
        ? 'pass'
        : 'fail',
      packageManifest: sourceBinding.manifestMatches === true ? 'pass' : 'fail',
      dependencyLock: sourceBinding.dependencyLockMatches === true ? 'pass' : 'fail',
      electronRuntime: electronRuntime.valid === true ? 'pass' : 'fail',
      sourceRevision: notarization.required === true
        ? (sourceBinding.releaseSourceClean === true &&
          sourceBinding.revision === options.expectedRevision ? 'pass' : 'fail')
        : 'not-required',
      notarization: notarization.required === true
        ? (notarization.gatekeeperAccepted === true && notarization.stapleValid === true ? 'pass' : 'fail')
        : 'not-required',
    },
    counts: {
      helperApps: helperCount,
      nestedCodeBundles: helperCount + nestedBundleCount,
      asarEntries: Number.isInteger(packagedContents.asarEntryCount)
        ? packagedContents.asarEntryCount
        : 0,
      unpackedEntries: Number.isInteger(packagedContents.unpackedEntryCount)
        ? packagedContents.unpackedEntryCount
        : 0,
      machOBinaries: Number.isInteger(evidence.architecture && evidence.architecture.machOBinaryCount)
        ? evidence.architecture.machOBinaryCount
        : 0,
    },
  };
}

function evaluateReleaseEvidence(evidence, options = {}) {
  const failures = collectPolicyFailures(evidence, options);
  return {
    ok: failures.length === 0,
    failures,
    proof: buildPrivacySafeProof(evidence, failures, options),
  };
}

function runCommand(command, args, options = {}) {
  const environment = {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    HOME: process.env.HOME || '/var/empty',
    LANG: 'C',
    LC_ALL: 'C',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
  };
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: environment,
    input: options.input,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: options.cwd,
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function gitCommand(commandRunner, args, options = {}) {
  return commandRunner('/usr/bin/git', [...SAFE_GIT_ARGUMENT_PREFIX, ...args], options);
}

function gitObjectOverridesAbsent(sourceRoot, commandRunner) {
  const replacements = gitCommand(commandRunner, ['replace', '-l'], { cwd: sourceRoot });
  const graftPathResult = gitCommand(
    commandRunner,
    ['rev-parse', '--git-path', 'info/grafts'],
    { cwd: sourceRoot }
  );
  if (!replacements.ok || String(replacements.stdout || '').trim() || !graftPathResult.ok) {
    return false;
  }
  const reportedPath = String(graftPathResult.stdout || '').trim();
  if (!reportedPath) return false;
  const graftPath = path.isAbsolute(reportedPath)
    ? reportedPath
    : path.resolve(sourceRoot, reportedPath);
  try {
    const metadata = fs.lstatSync(graftPath);
    return !metadata.isSymbolicLink() && metadata.isFile() && metadata.size === 0;
  } catch (error) {
    return error && error.code === 'ENOENT';
  }
}

function sourceCheckoutMatchesRevision(sourceRoot, expectedRevision, commandRunner) {
  if (!/^[a-f0-9]{40}$/u.test(String(expectedRevision || ''))) return false;
  const revision = gitCommand(
    commandRunner,
    ['rev-parse', '--verify', 'HEAD^{commit}'],
    { cwd: sourceRoot }
  );
  const status = gitCommand(commandRunner, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ], { cwd: sourceRoot });
  return revision.ok && String(revision.stdout || '').trim().toLowerCase() === expectedRevision &&
    status.ok && String(status.stdout || '').trim() === '' &&
    gitObjectOverridesAbsent(sourceRoot, commandRunner);
}

function verifierSourceMatchesExpectedRevision(expectedRevision, commandRunner = runCommand) {
  if (!/^[a-f0-9]{40}$/u.test(String(expectedRevision || ''))) return false;
  let verifierRoot;
  try {
    const requestedRoot = path.resolve(__dirname, '..');
    const metadata = fs.lstatSync(requestedRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) return false;
    verifierRoot = fs.realpathSync(requestedRoot);
  } catch (error) {
    return false;
  }
  const topLevel = gitCommand(commandRunner, ['rev-parse', '--show-toplevel'], {
    cwd: verifierRoot,
  });
  let canonicalTopLevel = '';
  try {
    canonicalTopLevel = topLevel.ok
      ? fs.realpathSync(String(topLevel.stdout || '').trim())
      : '';
  } catch (error) {
    canonicalTopLevel = '';
  }
  return canonicalTopLevel === verifierRoot &&
    sourceCheckoutMatchesRevision(verifierRoot, expectedRevision, commandRunner) &&
    sourceCheckoutMatchesRevision(verifierRoot, expectedRevision, commandRunner);
}

function parseJsonPlist(plistPath, commandRunner = runCommand) {
  const result = commandRunner('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath]);
  if (!result.ok) throw createVerificationError('Unable to read required app metadata.');
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw createVerificationError('Required app metadata is not valid.');
  }
}

function parseEntitlements(plistText, commandRunner = runCommand) {
  if (!String(plistText || '').trim()) return {};
  const result = commandRunner('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
    input: plistText,
  });
  if (!result.ok) throw createVerificationError('Unable to read signed entitlements.');
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw createVerificationError('Signed entitlements are not valid.');
  }
}

function readSignedEntitlements(bundlePath, commandRunner = runCommand) {
  const result = commandRunner('/usr/bin/codesign', ['-d', '--entitlements', ':-', bundlePath]);
  if (!result.ok) throw createVerificationError('Unable to read signed entitlements.');
  const combined = `${result.stdout}\n${result.stderr}`;
  const plistStart = combined.indexOf('<?xml');
  const plistEnd = combined.lastIndexOf('</plist>');
  if (plistStart === -1 || plistEnd === -1) return {};
  return parseEntitlements(
    combined.slice(plistStart, plistEnd + '</plist>'.length),
    commandRunner
  );
}

function appleDeveloperIdRequirement(identifier, teamIdentifier) {
  if (!/^[A-Za-z0-9.-]+$/u.test(String(identifier || '')) ||
      !/^[A-Z0-9]{10}$/u.test(String(teamIdentifier || ''))) {
    return null;
  }
  return 'anchor apple generic and ' +
    'certificate leaf[field.1.2.840.113635.100.6.1.13] exists and ' +
    `certificate leaf[subject.OU] = "${teamIdentifier}" and identifier "${identifier}"`;
}

function verifyAppleDeveloperIdSignature(
  bundlePath,
  expectedIdentifier,
  expectedTeamIdentifier,
  commandRunner = runCommand
) {
  const requirement = appleDeveloperIdRequirement(expectedIdentifier, expectedTeamIdentifier);
  if (!requirement) return false;
  return commandRunner('/usr/bin/codesign', [
    '--verify',
    '--strict',
    '--verbose=4',
    `-R=${requirement}`,
    bundlePath,
  ]).ok;
}

function readNestedSignature(
  bundlePath,
  expectedIdentifier,
  expectedTeamIdentifier,
  commandRunner = runCommand
) {
  const verification = commandRunner('/usr/bin/codesign', [
    '--verify',
    '--strict',
    '--verbose=4',
    bundlePath,
  ]);
  const details = commandRunner('/usr/bin/codesign', ['-dv', '--verbose=4', bundlePath]);
  if (!details.ok) throw createVerificationError('Unable to read nested code-signature metadata.');
  return {
    valid: verification.ok && verifyAppleDeveloperIdSignature(
      bundlePath,
      expectedIdentifier,
      expectedTeamIdentifier,
      commandRunner
    ),
    ...parseCodeSignatureMetadata(`${details.stdout}\n${details.stderr}`),
  };
}

function isNestedCodeBundleName(name) {
  return NESTED_CODE_BUNDLE_SUFFIXES.some(suffix => name.endsWith(suffix));
}

function findNestedCodeBundles(appPath) {
  const contentsPath = path.join(appPath, 'Contents');
  const bundles = [];
  const pending = [contentsPath];

  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const stats = fs.lstatSync(entryPath);
      if (stats.isSymbolicLink()) {
        if (isNestedCodeBundleName(entry.name)) {
          throw createVerificationError('Nested signed-code bundle layout is invalid.');
        }
        continue;
      }
      if (!stats.isDirectory()) continue;
      if (isNestedCodeBundleName(entry.name)) bundles.push({ name: entry.name, path: entryPath });
      pending.push(entryPath);
    }
  }

  return bundles.sort((left, right) => left.name.localeCompare(right.name));
}

function hasExactTypedEntries(directoryPath, expectedTypes) {
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  const expectedNames = Object.keys(expectedTypes).sort();
  if (!hasExactValues(entries.map(entry => entry.name).sort(), expectedNames)) return false;
  return entries.every(entry => {
    const metadata = fs.lstatSync(path.join(directoryPath, entry.name));
    if (metadata.isSymbolicLink()) return false;
    return expectedTypes[entry.name] === 'directory'
      ? metadata.isDirectory()
      : metadata.isFile();
  });
}

function inspectBundleLayout(appPath, executableName) {
  try {
    const appMetadata = fs.lstatSync(appPath);
    if (appMetadata.isSymbolicLink() || !appMetadata.isDirectory()) return { valid: false };
    const canonicalAppPath = fs.realpathSync(appPath);
    const contentsPath = path.join(appPath, 'Contents');
    const contentsMetadata = fs.lstatSync(contentsPath);
    if (contentsMetadata.isSymbolicLink() || !contentsMetadata.isDirectory() ||
        fs.realpathSync(contentsPath) !== path.join(canonicalAppPath, 'Contents')) {
      return { valid: false };
    }
    if (!hasExactTypedEntries(contentsPath, {
      CodeResources: 'file',
      Frameworks: 'directory',
      'Info.plist': 'file',
      MacOS: 'directory',
      PkgInfo: 'file',
      Resources: 'directory',
      _CodeSignature: 'directory',
    })) return { valid: false };
    if (!hasExactTypedEntries(path.join(contentsPath, 'MacOS'), {
      [executableName]: 'file',
    })) {
      return { valid: false };
    }
    const frameworkTypes = Object.fromEntries([
      `${executableName} Helper.app`,
      `${executableName} Helper (GPU).app`,
      `${executableName} Helper (Plugin).app`,
      `${executableName} Helper (Renderer).app`,
      ...EXPECTED_NESTED_BUNDLE_NAMES,
    ].map(name => [name, 'directory']));
    if (!hasExactTypedEntries(path.join(contentsPath, 'Frameworks'), frameworkTypes)) {
      return { valid: false };
    }
    if (!hasExactTypedEntries(path.join(contentsPath, '_CodeSignature'), {
      CodeResources: 'file',
    })) {
      return { valid: false };
    }
    const packageInfo = readStableRegularFile(path.join(contentsPath, 'PkgInfo'));
    if (!packageInfo || !packageInfo.equals(Buffer.from('APPL????', 'ascii'))) {
      return { valid: false };
    }

    const resourcesPath = path.join(contentsPath, 'Resources');
    const resourceEntries = fs.readdirSync(resourcesPath, { withFileTypes: true });
    const requiredResources = new Set([
      'app-update.yml',
      'app.asar',
      'app.asar.unpacked',
      'icon.icns',
    ]);
    for (const entry of resourceEntries) {
      const entryPath = path.join(resourcesPath, entry.name);
      const metadata = fs.lstatSync(entryPath);
      if (metadata.isSymbolicLink()) return { valid: false };
      if (requiredResources.has(entry.name)) {
        const expectedType = entry.name === 'app.asar.unpacked' ? 'directory' : 'file';
        if ((expectedType === 'directory' && !metadata.isDirectory()) ||
            (expectedType === 'file' && !metadata.isFile())) {
          return { valid: false };
        }
        if (entry.name === 'app-update.yml') {
          const metadataBytes = readStableRegularFile(entryPath);
          if (!metadataBytes || !metadataBytes.equals(EXPECTED_APP_UPDATE_METADATA)) {
            return { valid: false };
          }
        }
        requiredResources.delete(entry.name);
        continue;
      }
      if (!/^[A-Za-z0-9_]+\.lproj$/u.test(entry.name) || !metadata.isDirectory() ||
          fs.readdirSync(entryPath).length !== 0) {
        return { valid: false };
      }
    }
    return { valid: requiredResources.size === 0 };
  } catch (error) {
    return { valid: false };
  }
}

function readMachOArchitectures(filePath, commandRunner = runCommand) {
  const result = commandRunner('/usr/bin/lipo', ['-archs', filePath]);
  if (!result.ok) return [];
  return String(result.stdout || '').trim().split(/\s+/u).filter(Boolean).sort();
}

function inspectAppArchitectures(appPath, executablePath, commandRunner = runCommand) {
  const contentsPath = path.join(appPath, 'Contents');
  let canonicalContentsPath;
  let mainPath;
  try {
    canonicalContentsPath = fs.realpathSync(contentsPath);
    mainPath = fs.realpathSync(executablePath);
  } catch (error) {
    return { valid: false, expected: EXPECTED_ARCHITECTURE, main: [], machOBinaryCount: 0 };
  }
  const pending = [canonicalContentsPath];
  const visitedDirectories = new Set();
  const visitedFiles = new Set();
  let main = [];
  let machOBinaryCount = 0;
  let valid = true;

  try {
    while (pending.length > 0 && valid) {
      const current = pending.pop();
      if (visitedDirectories.has(current)) continue;
      visitedDirectories.add(current);
      for (const name of fs.readdirSync(current).sort()) {
        const absolutePath = path.join(current, name);
        const metadata = fs.lstatSync(absolutePath);
        const canonicalPath = fs.realpathSync(absolutePath);
        if (canonicalPath !== canonicalContentsPath &&
            !canonicalPath.startsWith(`${canonicalContentsPath}${path.sep}`)) {
          valid = false;
          break;
        }
        const targetMetadata = metadata.isSymbolicLink() ? fs.statSync(absolutePath) : metadata;
        if (targetMetadata.isDirectory()) {
          pending.push(canonicalPath);
          continue;
        }
        if (!targetMetadata.isFile()) {
          valid = false;
          break;
        }
        if (visitedFiles.has(canonicalPath)) continue;
        visitedFiles.add(canonicalPath);
        const fileType = commandRunner('/usr/bin/file', ['-b', canonicalPath]);
        if (!fileType.ok) {
          valid = false;
          break;
        }
        if (!/^Mach-O\b/u.test(String(fileType.stdout || '').trim())) continue;
        const architectures = readMachOArchitectures(canonicalPath, commandRunner);
        const relativePath = path.relative(canonicalContentsPath, canonicalPath).split(path.sep).join('/');
        const expectedArchitectures = APPROVED_UNIVERSAL_MACHO[relativePath] || [
          EXPECTED_ARCHITECTURE,
        ];
        machOBinaryCount += 1;
        if (canonicalPath === mainPath) main = architectures;
        if (!hasExactValues(architectures, expectedArchitectures)) {
          valid = false;
          break;
        }
      }
    }
  } catch (error) {
    valid = false;
  }

  return {
    valid: valid && machOBinaryCount > 0 && hasExactValues(main, [EXPECTED_ARCHITECTURE]),
    expected: EXPECTED_ARCHITECTURE,
    main,
    machOBinaryCount,
  };
}

function hashBuffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseSha512Integrity(value) {
  const match = String(value || '').match(/^sha512-([A-Za-z0-9+/]+={0,2})$/u);
  if (!match) return null;
  const digest = Buffer.from(match[1], 'base64');
  if (digest.length !== 64 || digest.toString('base64') !== match[1]) return null;
  return digest;
}

function npmCacheContentPath(integrity, cacheRoot = process.env.npm_config_cache ||
    path.join(os.homedir(), '.npm')) {
  const digest = parseSha512Integrity(integrity);
  if (!digest) return null;
  const hex = digest.toString('hex');
  return path.join(
    cacheRoot,
    '_cacache',
    'content-v2',
    'sha512',
    hex.slice(0, 2),
    hex.slice(2, 4),
    hex.slice(4)
  );
}

function dependencyNameFromLockPath(lockPath) {
  const segments = String(lockPath || '').split('/').filter(Boolean);
  const nodeModulesIndex = segments.lastIndexOf('node_modules');
  if (nodeModulesIndex === -1 || nodeModulesIndex === segments.length - 1) return null;
  const first = segments[nodeModulesIndex + 1];
  if (first.startsWith('@')) {
    const second = segments[nodeModulesIndex + 2];
    return second ? `${first}/${second}` : null;
  }
  return first;
}

function isDependencyManifestEntry(entry) {
  const segments = String(entry || '').split('/').filter(Boolean);
  const nodeModulesIndex = segments.lastIndexOf('node_modules');
  if (nodeModulesIndex === -1) return false;
  const tail = segments.slice(nodeModulesIndex + 1);
  return (tail.length === 2 && tail[1] === 'package.json') ||
    (tail.length === 3 && tail[0].startsWith('@') && tail[2] === 'package.json');
}

function dependencyLockPathFromManifestEntry(entry) {
  const normalized = String(entry || '').replace(/^\/+|\/+$/gu, '');
  if (!isDependencyManifestEntry(normalized)) return null;
  return normalized.slice(0, -'/package.json'.length);
}

function normalizeArchiveEntry(entry) {
  const normalized = String(entry || '').replace(/^\/+|\/+$/gu, '');
  if (!normalized || normalized.includes('\\') || normalized.includes('\0')) return null;
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

function normalizeDependencyLockPath(lockPath) {
  const normalized = normalizeArchiveEntry(lockPath);
  if (!normalized || normalized !== lockPath || !normalized.startsWith('node_modules/')) {
    return null;
  }
  const segments = normalized.split('/');
  let index = 0;
  while (index < segments.length) {
    if (segments[index] !== 'node_modules') return null;
    index += 1;
    if (index >= segments.length) return null;
    if (segments[index].startsWith('@')) {
      if (index + 1 >= segments.length) return null;
      index += 2;
    } else {
      index += 1;
    }
  }
  return normalized;
}

function packageConstraintMatches(constraints, currentValue) {
  if (constraints === undefined) return true;
  if (!Array.isArray(constraints) || constraints.length === 0 ||
      constraints.some(value => typeof value !== 'string' ||
        !/^!?[A-Za-z0-9._-]+$/u.test(value)) ||
      new Set(constraints).size !== constraints.length) {
    return false;
  }
  const positive = constraints.filter(value => !value.startsWith('!'));
  if (constraints.includes(`!${currentValue}`)) return false;
  return positive.length === 0 || positive.includes(currentValue);
}

function packagePlatformMatches(metadata, platform, arch) {
  return isPlainObject(metadata) &&
    packageConstraintMatches(metadata.os, platform) &&
    packageConstraintMatches(metadata.cpu, arch);
}

function dependencySection(value, name) {
  if (value[name] === undefined) return {};
  if (!isPlainObject(value[name]) ||
      Object.values(value[name]).some(spec => typeof spec !== 'string')) {
    return null;
  }
  return value[name];
}

function dependencyTopologyMatchesManifest(manifest, lockMetadata) {
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const declared = dependencySection(manifest, section);
    const locked = dependencySection(lockMetadata, section);
    if (declared === null || locked === null || !isDeepStrictEqual(declared, locked)) return false;
  }
  const declaredPeerMetadata = manifest.peerDependenciesMeta === undefined
    ? {}
    : manifest.peerDependenciesMeta;
  const lockedPeerMetadata = lockMetadata.peerDependenciesMeta === undefined
    ? {}
    : lockMetadata.peerDependenciesMeta;
  return isPlainObject(declaredPeerMetadata) && isPlainObject(lockedPeerMetadata) &&
    Object.values(declaredPeerMetadata).every(isPlainObject) &&
    Object.values(lockedPeerMetadata).every(isPlainObject) &&
    isDeepStrictEqual(declaredPeerMetadata, lockedPeerMetadata);
}

function rootLockMatchesSourceManifest(sourceManifest, sourceLockfile) {
  if (!isPlainObject(sourceManifest) || !isPlainObject(sourceLockfile) ||
      sourceLockfile.lockfileVersion !== 3 || !isPlainObject(sourceLockfile.packages) ||
      !isPlainObject(sourceLockfile.packages[''])) {
    return false;
  }
  const root = sourceLockfile.packages[''];
  if (root.name !== sourceManifest.name || root.version !== sourceManifest.version) return false;
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const manifestValues = dependencySection(sourceManifest, section);
    const lockValues = dependencySection(root, section);
    if (manifestValues === null || lockValues === null ||
        !isDeepStrictEqual(manifestValues, lockValues)) {
      return false;
    }
  }
  return true;
}

function parseStrictVersion(value) {
  const match = String(value || '').match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
  if (!match) return null;
  const components = match.slice(1).map(Number);
  return components.every(Number.isSafeInteger) ? components : null;
}

function declaredVersionIncludes(spec, version) {
  const actual = parseStrictVersion(version);
  if (!actual) return false;
  const partial = String(spec || '').match(/^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/u);
  if (partial) {
    const components = partial.slice(1).filter(value => value !== undefined).map(Number);
    return components.every(Number.isSafeInteger) && actual[0] === components[0] &&
      (components[1] === undefined || actual[1] === components[1]);
  }
  const match = String(spec || '').match(
    /^(\^|~|=)?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u
  );
  if (!match) return false;
  const base = parseStrictVersion(match[2]);
  if (!base) return false;
  const comparison = actual[0] !== base[0]
    ? actual[0] - base[0]
    : (actual[1] !== base[1] ? actual[1] - base[1] : actual[2] - base[2]);
  if (comparison < 0) return false;
  if (!match[1] || match[1] === '=') return comparison === 0;
  if (match[1] === '~') return actual[0] === base[0] && actual[1] === base[1];
  if (base[0] > 0) return actual[0] === base[0];
  if (base[1] > 0) return actual[0] === 0 && actual[1] === base[1];
  return actual[0] === 0 && actual[1] === 0 && actual[2] === base[2];
}

function normalizeDependencyName(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0')) return null;
  if (/^[A-Za-z0-9._-]+$/u.test(name)) return name;
  return /^@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(name) ? name : null;
}

function parentDependencyLockPath(lockPath) {
  const segments = String(lockPath || '').split('/');
  const index = segments.lastIndexOf('node_modules');
  return index > 0 ? segments.slice(0, index).join('/') : '';
}

function resolveDependencyLockPath(lockfile, parentLockPath, dependencyName) {
  const normalizedName = normalizeDependencyName(dependencyName);
  if (!normalizedName) return null;
  let parent = parentLockPath;
  while (true) {
    const candidate = parent
      ? `${parent}/node_modules/${normalizedName}`
      : `node_modules/${normalizedName}`;
    if (Object.hasOwn(lockfile.packages, candidate)) return candidate;
    if (!parent) return null;
    parent = parentDependencyLockPath(parent);
  }
}

function collectReachableLockPaths(sourceManifest, sourceLockfile, rootRequests, options = {}) {
  const paths = new Set();
  if (!rootLockMatchesSourceManifest(sourceManifest, sourceLockfile)) {
    return { valid: false, paths };
  }
  const platform = options.platform || 'darwin';
  const arch = options.arch || 'arm64';
  const allowDev = options.allowDev === true;
  if (!Array.isArray(rootRequests) || rootRequests.some(request => (
    !isPlainObject(request) || normalizeDependencyName(request.name) !== request.name ||
    typeof request.spec !== 'string' || request.parent !== '' ||
    typeof request.optional !== 'boolean'
  ))) {
    return { valid: false, paths };
  }
  const queue = rootRequests.map(request => ({ ...request }));

  while (queue.length > 0) {
    const request = queue.shift();
    if (!isPlainObject(request) || normalizeDependencyName(request.name) !== request.name ||
        typeof request.spec !== 'string' || typeof request.parent !== 'string' ||
        typeof request.optional !== 'boolean') {
      return { valid: false, paths: new Set() };
    }
    const lockPath = resolveDependencyLockPath(sourceLockfile, request.parent, request.name);
    if (!lockPath) {
      if (request.optional) continue;
      return { valid: false, paths: new Set() };
    }
    const metadata = sourceLockfile.packages[lockPath];
    if (!isPlainObject(metadata) || (!allowDev && metadata.dev === true)) {
      return { valid: false, paths: new Set() };
    }
    if (options.verifyVersions !== false &&
        !declaredVersionIncludes(request.spec, metadata.version)) {
      return { valid: false, paths: new Set() };
    }
    if (!packagePlatformMatches(metadata, platform, arch)) {
      if (request.optional) continue;
      return { valid: false, paths: new Set() };
    }
    if (paths.has(lockPath)) continue;
    paths.add(lockPath);

    const required = dependencySection(metadata, 'dependencies');
    const optional = dependencySection(metadata, 'optionalDependencies');
    const peers = dependencySection(metadata, 'peerDependencies');
    const peerMetadata = metadata.peerDependenciesMeta === undefined
      ? {}
      : metadata.peerDependenciesMeta;
    if (required === null || optional === null || peers === null || !isPlainObject(peerMetadata)) {
      return { valid: false, paths: new Set() };
    }
    for (const name of Object.keys(required).sort()) {
      queue.push({ name, spec: required[name], optional: false, parent: lockPath });
    }
    for (const name of Object.keys(optional).sort()) {
      queue.push({ name, spec: optional[name], optional: true, parent: lockPath });
    }
    for (const name of Object.keys(peers).sort()) {
      const optionalPeer = isPlainObject(peerMetadata[name]) && peerMetadata[name].optional === true;
      queue.push({ name, spec: peers[name], optional: optionalPeer, parent: lockPath });
    }
  }

  return { valid: true, paths };
}

function collectReachableProductionLockPaths(sourceManifest, sourceLockfile, options = {}) {
  const rootDependencies = dependencySection(sourceManifest, 'dependencies');
  const rootOptionalDependencies = dependencySection(sourceManifest, 'optionalDependencies');
  if (rootDependencies === null || rootOptionalDependencies === null) {
    return { valid: false, paths: new Set() };
  }
  const rootRequests = [
    ...Object.entries(rootDependencies).sort(([left], [right]) => left.localeCompare(right))
      .map(([name, spec]) => ({ name, spec, optional: false, parent: '' })),
    ...Object.entries(rootOptionalDependencies).sort(([left], [right]) => left.localeCompare(right))
      .map(([name, spec]) => ({ name, spec, optional: true, parent: '' })),
  ];
  const reachable = collectReachableLockPaths(
    sourceManifest,
    sourceLockfile,
    rootRequests,
    options
  );
  if (!reachable.valid) return reachable;

  const platform = options.platform || 'darwin';
  const arch = options.arch || 'arm64';
  const eligible = Object.entries(sourceLockfile.packages)
    .filter(([lockPath, metadata]) => lockPath && lockPath.includes('node_modules') &&
      isPlainObject(metadata) && metadata.dev !== true &&
      packagePlatformMatches(metadata, platform, arch))
    .map(([lockPath]) => lockPath)
    .sort();
  return {
    valid: isDeepStrictEqual([...reachable.paths].sort(), eligible),
    paths: reachable.paths,
  };
}

function collectReachableVerifierToolLockPaths(sourceManifest, sourceLockfile, options = {}) {
  const invalid = () => ({ valid: false, paths: new Set() });
  const devDependencies = dependencySection(sourceManifest, 'devDependencies');
  if (devDependencies === null || typeof devDependencies['electron-builder'] !== 'string') {
    return invalid();
  }
  const builderLockPath = resolveDependencyLockPath(
    sourceLockfile,
    '',
    'electron-builder'
  );
  const builderMetadata = builderLockPath && sourceLockfile.packages[builderLockPath];
  if (!builderLockPath || !isPlainObject(builderMetadata) ||
      !declaredVersionIncludes(devDependencies['electron-builder'], builderMetadata.version)) {
    return invalid();
  }
  const builderReachable = collectReachableLockPaths(sourceManifest, sourceLockfile, [{
    name: 'electron-builder',
    optional: false,
    parent: '',
    spec: devDependencies['electron-builder'],
  }], {
    ...options,
    allowDev: true,
    verifyVersions: false,
  });
  if (!builderReachable.valid) return invalid();

  const requiredTools = ['@electron/asar', '@electron/fuses'];
  const rootRequests = [];
  for (const name of requiredTools) {
    const lockPath = resolveDependencyLockPath(sourceLockfile, '', name);
    const metadata = lockPath && sourceLockfile.packages[lockPath];
    if (!lockPath || !builderReachable.paths.has(lockPath) || !isPlainObject(metadata) ||
        typeof metadata.version !== 'string') {
      return invalid();
    }
    rootRequests.push({
      name,
      optional: false,
      parent: '',
      spec: metadata.version,
    });
  }
  return collectReachableLockPaths(sourceManifest, sourceLockfile, rootRequests, {
    ...options,
    allowDev: true,
    verifyVersions: true,
  });
}

function canonicalDependencyPackageRoot(sourceRoot, nodeModulesRoot, lockPath) {
  let current = sourceRoot;
  try {
    for (const segment of lockPath.split('/')) {
      current = path.join(current, segment);
      const metadata = fs.lstatSync(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) return null;
    }
    const canonical = fs.realpathSync(current);
    return canonical.startsWith(`${nodeModulesRoot}${path.sep}`) ? canonical : null;
  } catch (error) {
    return null;
  }
}

function hasApprovedDependencyPackagingConfig(sourceManifest) {
  const build = isPlainObject(sourceManifest && sourceManifest.build) ? sourceManifest.build : {};
  if (build.disableDefaultIgnoredFiles !== undefined ||
      build.onNodeModuleFile !== undefined ||
      build.removePackageScripts === false ||
      build.includePdb === true) {
    return false;
  }
  const patterns = Array.isArray(build.files) ? build.files : [];
  return patterns.every(pattern => !JSON.stringify(pattern).includes('node_modules'));
}

function dependencyPathIsExcluded(relativePath, packageName) {
  const segments = String(relativePath || '').split('/').filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    const name = segments[index];
    const parentPath = segments.slice(0, index).join('/');
    if (DEPENDENCY_EXCLUDED_NAMES.has(name) || name.startsWith('._') ||
        DEPENDENCY_EXCLUDED_SUFFIXES.some(suffix => name.endsWith(suffix)) ||
        /^electron-builder\.(?:json5?|ya?ml|toml|ts)$/u.test(name)) {
      return true;
    }
    if (index === 0 && DEPENDENCY_TOP_LEVEL_EXCLUDED_NAMES.has(name)) {
      return true;
    }
    if (index === 0 && packageName === 'libui-node' &&
        (name === 'build' || name === 'docs' || name === 'src')) {
      return true;
    }
    if (parentPath.endsWith('build') &&
        (name === 'gyp-mac-tool' || name === 'Makefile' || name.endsWith('.mk') ||
          name.endsWith('.gypi') || name.endsWith('.Makefile'))) {
      return true;
    }
    if (parentPath.endsWith('Release') && (name === '.deps' || name === 'obj.target')) {
      return true;
    }
    if (packageName === 'canvas' && parentPath.endsWith('build/Release') &&
        name === '.forge-meta') {
      return true;
    }
    if (index === 0 && name === 'src' &&
        (packageName === 'keytar' || packageName === 'keytar-prebuild')) {
      return true;
    }
    if (index === 0 && packageName === 'lzma-native' &&
        (name === 'build' || name === 'deps')) {
      return true;
    }
  }
  return false;
}

function readStableRegularFile(filePath) {
  let descriptor = null;
  try {
    const pathMetadata = fs.lstatSync(filePath);
    if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()) return null;
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.dev !== pathMetadata.dev || before.ino !== pathMetadata.ino) {
      return null;
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs || bytes.length !== before.size) {
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
        // The caller fails closed when the authenticated read cannot complete.
      }
    }
  }
}

function directoryIdentity(directoryPath) {
  try {
    const metadata = fs.lstatSync(directoryPath);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) return null;
    return {
      dev: metadata.dev,
      ino: metadata.ino,
      realpath: fs.realpathSync(directoryPath),
    };
  } catch (error) {
    return null;
  }
}

function directoryIdentityMatches(directoryPath, expected) {
  const actual = directoryIdentity(directoryPath);
  return Boolean(actual && expected && actual.dev === expected.dev && actual.ino === expected.ino &&
    actual.realpath === expected.realpath);
}

function stableRegularFileDigest(filePath) {
  let descriptor = null;
  try {
    const pathMetadata = fs.lstatSync(filePath);
    if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()) return null;
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.dev !== pathMetadata.dev || before.ino !== pathMetadata.ino) {
      return null;
    }
    const digest = crypto.createHash('sha256');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    while (true) {
      const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      digest.update(chunk.subarray(0, count));
      total += count;
    }
    const after = fs.fstatSync(descriptor);
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs || total !== before.size) {
      return null;
    }
    return {
      digest: digest.digest('hex'),
      mode: before.mode & 0o7777,
      size: before.size,
    };
  } catch (error) {
    return null;
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch (error) {
        // The caller fails closed when the stable read cannot finish.
      }
    }
  }
}

function fingerprintAppTree(appPath) {
  const fingerprint = crypto.createHash('sha256');
  const pending = [{ absolutePath: appPath, relativePath: '' }];
  let entryCount = 0;
  let totalBytes = 0;
  try {
    while (pending.length > 0) {
      const current = pending.pop();
      const names = fs.readdirSync(current.absolutePath).sort().reverse();
      for (const name of names) {
        entryCount += 1;
        if (entryCount > 100000) return null;
        const absolutePath = path.join(current.absolutePath, name);
        const relativePath = current.relativePath ? `${current.relativePath}/${name}` : name;
        const metadata = fs.lstatSync(absolutePath);
        if (metadata.isDirectory()) {
          fingerprint.update(`D\0${relativePath}\0${metadata.mode & 0o7777}\0`);
          pending.push({ absolutePath, relativePath });
          continue;
        }
        if (metadata.isSymbolicLink()) {
          fingerprint.update(`L\0${relativePath}\0${fs.readlinkSync(absolutePath)}\0`);
          continue;
        }
        if (!metadata.isFile()) return null;
        const evidence = stableRegularFileDigest(absolutePath);
        if (!evidence) return null;
        totalBytes += evidence.size;
        if (totalBytes > 4 * 1024 * 1024 * 1024) return null;
        fingerprint.update(
          `F\0${relativePath}\0${evidence.mode}\0${evidence.size}\0${evidence.digest}\0`
        );
      }
    }
    return fingerprint.digest('hex');
  } catch (error) {
    return null;
  }
}

function createPrivateAppSnapshot(appPath, options = {}) {
  const sourcePath = path.resolve(appPath);
  const copyRunner = options.copyRunner || runCommand;
  const temporaryParent = path.resolve(options.temporaryParent || process.env.TMPDIR || os.tmpdir());
  let temporaryRoot = null;
  try {
    const sourceMetadata = fs.lstatSync(sourcePath);
    const parentMetadata = fs.lstatSync(temporaryParent);
    if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isDirectory() ||
        !sourcePath.endsWith('.app') || parentMetadata.isSymbolicLink() ||
        !parentMetadata.isDirectory()) {
      throw new Error('invalid');
    }
    const canonicalSourcePath = fs.realpathSync(sourcePath);
    const sourceIdentity = directoryIdentity(canonicalSourcePath);
    const sourceFingerprint = fingerprintAppTree(canonicalSourcePath);
    if (!sourceIdentity || !sourceFingerprint) throw new Error('invalid');
    temporaryRoot = fs.mkdtempSync(
      path.join(fs.realpathSync(temporaryParent), '.crate-signed-app-proof-')
    );
    fs.chmodSync(temporaryRoot, 0o700);
    const rootIdentity = directoryIdentity(temporaryRoot);
    if (!rootIdentity) throw new Error('invalid');
    const snapshotPath = path.join(temporaryRoot, path.basename(sourcePath));
    const copied = copyRunner('/usr/bin/ditto', [
      '--rsrc',
      '--extattr',
      '--acl',
      canonicalSourcePath,
      snapshotPath,
    ]);
    const initialFingerprint = copied.ok ? fingerprintAppTree(snapshotPath) : null;
    if (!initialFingerprint || initialFingerprint !== sourceFingerprint ||
        !directoryIdentityMatches(canonicalSourcePath, sourceIdentity) ||
        fingerprintAppTree(canonicalSourcePath) !== sourceFingerprint) {
      throw new Error('invalid');
    }
    return {
      appPath: snapshotPath,
      cleanup() {
        try {
          if (!directoryIdentityMatches(temporaryRoot, rootIdentity)) return false;
          const quarantineRoot = path.join(
            path.dirname(temporaryRoot),
            `.crate-signed-app-cleanup-${crypto.randomUUID()}`
          );
          fs.renameSync(temporaryRoot, quarantineRoot);
          if (!directoryIdentityMatches(quarantineRoot, {
            ...rootIdentity,
            realpath: quarantineRoot,
          })) {
            return false;
          }
          fs.rmSync(quarantineRoot, { recursive: true, force: false });
          return !fs.existsSync(quarantineRoot);
        } catch (error) {
          return false;
        }
      },
      isStable() {
        return directoryIdentityMatches(canonicalSourcePath, sourceIdentity) &&
          fingerprintAppTree(canonicalSourcePath) === sourceFingerprint &&
          directoryIdentityMatches(temporaryRoot, rootIdentity) &&
          fingerprintAppTree(snapshotPath) === initialFingerprint;
      },
    };
  } catch (error) {
    if (temporaryRoot) {
      try {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        // The public verifier reports one fixed snapshot failure below.
      }
    }
    throw createVerificationError('Unable to create a stable app verification snapshot.', 2);
  }
}

function packageFileEvidence(bytes, relativePath, options = {}) {
  const evidence = {
    kind: 'sha256',
    rawDigest: hashBuffer(bytes),
  };
  const isPackageManifest = relativePath === 'package.json' ||
    relativePath.endsWith('/package.json');
  if (isPackageManifest || relativePath === 'checksums.json') {
    try {
      evidence.json = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      return null;
    }
  }
  if (!options.sealForPackaging) return evidence;
  if (isPackageManifest) {
    return {
      ...evidence,
      kind: 'manifest',
      value: cleanDependencyManifest(evidence.json),
    };
  }
  if (relativePath.endsWith('.node') || relativePath.endsWith('.dylib')) {
    if (typeof options.nativeFileMatcher === 'function') {
      return { ...evidence, kind: 'native-custom' };
    }
    const digest = canonicalNativeDigestFromBytes(bytes, options.commandRunner);
    return digest ? { ...evidence, kind: 'native', digest } : null;
  }
  return evidence;
}

function collectPackageFiles(packageRoot, packageName, options = {}) {
  const files = new Map();
  const pending = [{ absolutePath: packageRoot, relativePath: '' }];
  try {
    const rootMetadata = fs.lstatSync(packageRoot);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
      return { valid: false, files };
    }
    while (pending.length > 0) {
      const current = pending.pop();
      for (const name of fs.readdirSync(current.absolutePath).sort()) {
        const relativePath = current.relativePath ? `${current.relativePath}/${name}` : name;
        if (options.archiveInventory && !current.relativePath && name === 'node_modules') continue;
        if (!options.archiveInventory && dependencyPathIsExcluded(relativePath, packageName)) continue;
        const absolutePath = path.join(current.absolutePath, name);
        const metadata = fs.lstatSync(absolutePath);
        if (metadata.isSymbolicLink()) return { valid: false, files: new Map() };
        if (metadata.isDirectory()) {
          pending.push({ absolutePath, relativePath });
        } else if (metadata.isFile()) {
          const bytes = readStableRegularFile(absolutePath);
          const evidence = bytes && packageFileEvidence(bytes, relativePath, options);
          if (!evidence) return { valid: false, files: new Map() };
          files.set(relativePath, evidence);
        } else {
          return { valid: false, files: new Map() };
        }
      }
    }
  } catch (error) {
    return { valid: false, files: new Map() };
  }
  return { valid: files.has('package.json'), files };
}

function collectExpectedPackageFiles(packageRoot, packageName, options = {}) {
  return collectPackageFiles(packageRoot, packageName, {
    ...options,
    archiveInventory: false,
    sealForPackaging: options.sealForPackaging !== false,
  });
}

function collectArchivePackageFiles(packageRoot) {
  return collectPackageFiles(packageRoot, '', {
    archiveInventory: true,
    sealForPackaging: false,
  });
}

function archivePackageMatchesInstalled(archiveFiles, installedFiles, packageName) {
  const archiveEntries = [...archiveFiles.keys()].sort();
  const installedEntries = [...installedFiles.keys()].sort();
  for (const entry of archiveEntries) {
    if (!installedFiles.has(entry)) return false;
    if (archiveFiles.get(entry).rawDigest !== installedFiles.get(entry).rawDigest) {
      return false;
    }
  }
  const actualExtras = installedEntries.filter(entry => !archiveFiles.has(entry));
  const expectedExtras = packageName === 'canvas'
    ? [...APPROVED_CANVAS_PREBUILD_ENTRIES].sort()
    : [];
  return isDeepStrictEqual(actualExtras, expectedExtras);
}

function packageEvidenceMapsEqual(left, right) {
  const leftEntries = [...left.keys()].sort();
  const rightEntries = [...right.keys()].sort();
  return isDeepStrictEqual(leftEntries, rightEntries) && leftEntries.every(entry => (
    left.get(entry).rawDigest === right.get(entry).rawDigest
  ));
}

function authenticatedPackageStateMatches(packageRoot, authenticated) {
  if (!authenticated || !directoryIdentityMatches(packageRoot, authenticated.rootIdentity)) {
    return false;
  }
  const current = collectArchivePackageFiles(packageRoot);
  return current.valid && packageEvidenceMapsEqual(authenticated.authenticatedFiles, current.files);
}

function approvedCanvasPrebuildMatchesSnapshot(packageRoot, installedFiles, options) {
  if (typeof options.canvasPrebuildVerifier === 'function') {
    return options.canvasPrebuildVerifier(packageRoot, options.canvasPrebuild) === true;
  }
  if (typeof options.canvasPrebuild !== 'string') return false;
  const execFileSync = typeof options.commandRunner === 'function'
    ? (command, args) => {
      const result = options.commandRunner(command, args);
      if (!result || result.ok !== true) throw new Error('Canvas archive inspection failed.');
      return result.stdout;
    }
    : undefined;
  const approved = collectApprovedCanvasPrebuildDigests(options.canvasPrebuild, {
    ...(execFileSync ? { execFileSync } : {}),
  });
  if (!approved.valid) return false;
  return APPROVED_CANVAS_PREBUILD_ENTRIES.every(entry => (
    installedFiles.has(entry) && approved.files.get(entry) === installedFiles.get(entry).rawDigest
  ));
}

function authenticateInstalledPackageSnapshot(packageRoot, packageName, metadata, options = {}) {
  const invalid = () => ({
    authenticatedFiles: new Map(),
    files: new Map(),
    rootIdentity: null,
    valid: false,
  });
  const expectedDigest = parseSha512Integrity(metadata && metadata.integrity);
  if (!expectedDigest || typeof metadata.resolved !== 'string' ||
      !metadata.resolved.startsWith('https://registry.npmjs.org/')) {
    return invalid();
  }
  const rootIdentity = directoryIdentity(packageRoot);
  if (!rootIdentity) return invalid();
  const installedInventory = collectArchivePackageFiles(packageRoot);
  const expectedInventory = collectExpectedPackageFiles(packageRoot, packageName, options);
  if (!installedInventory.valid || !expectedInventory.valid ||
      !directoryIdentityMatches(packageRoot, rootIdentity) ||
      [...expectedInventory.files].some(([entry, evidence]) => (
        !installedInventory.files.has(entry) ||
        installedInventory.files.get(entry).rawDigest !== evidence.rawDigest
      ))) {
    return invalid();
  }
  const canvasMatches = () => packageName !== 'canvas' ||
    approvedCanvasPrebuildMatchesSnapshot(packageRoot, installedInventory.files, options);
  if (typeof options.archiveVerifier === 'function') {
    const valid = options.archiveVerifier({ metadata, packageName, packageRoot }) === true &&
      canvasMatches() && directoryIdentityMatches(packageRoot, rootIdentity);
    return valid ? {
      authenticatedFiles: installedInventory.files,
      files: expectedInventory.files,
      rootIdentity,
      valid: true,
    } : invalid();
  }

  const cachePath = npmCacheContentPath(metadata.integrity, options.npmCacheRoot);
  const archiveBytes = readStableRegularFile(cachePath);
  if (!archiveBytes) return invalid();
  const actualDigest = crypto.createHash('sha512').update(archiveBytes).digest();
  if (!crypto.timingSafeEqual(actualDigest, expectedDigest)) return invalid();

  const commandRunner = options.commandRunner || runCommand;
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-lock-archive-'));
  try {
    const privateArchivePath = path.join(temporaryRoot, 'authenticated-package.tgz');
    fs.writeFileSync(privateArchivePath, archiveBytes, { flag: 'wx', mode: 0o600 });
    const listing = commandRunner('/usr/bin/tar', ['-tzf', privateArchivePath]);
    const verboseListing = commandRunner('/usr/bin/tar', ['-tvzf', privateArchivePath]);
    if (!listing.ok || !verboseListing.ok) return invalid();
    const entries = String(listing.stdout || '').trim().split(/\r?\n/u).filter(Boolean);
    const verboseEntries = String(verboseListing.stdout || '').trim().split(/\r?\n/u).filter(Boolean);
    const normalizedEntries = entries.map(entry => {
      const withoutDirectoryMarker = entry.endsWith('/') ? entry.slice(0, -1) : entry;
      const normalized = normalizeArchiveEntry(withoutDirectoryMarker);
      return normalized && normalized === withoutDirectoryMarker &&
        (normalized === 'package' || normalized.startsWith('package/'))
        ? normalized
        : null;
    });
    if (entries.length === 0 || entries.length !== verboseEntries.length ||
        normalizedEntries.some(entry => entry === null) ||
        new Set(normalizedEntries).size !== normalizedEntries.length ||
        verboseEntries.some(line => line[0] !== '-' && line[0] !== 'd') ||
        entries.length !== new Set(entries).size) {
      return invalid();
    }

    const extraction = commandRunner('/usr/bin/tar', [
      '-xzf',
      privateArchivePath,
      '-C',
      temporaryRoot,
    ]);
    if (!extraction.ok) return invalid();
    const archiveRoot = path.join(temporaryRoot, 'package');
    const archiveInventory = collectArchivePackageFiles(archiveRoot);
    const archiveMatches = archiveInventory.valid &&
      archivePackageMatchesInstalled(
        archiveInventory.files,
        installedInventory.files,
        packageName
      );
    const valid = archiveMatches && canvasMatches() &&
      directoryIdentityMatches(packageRoot, rootIdentity);
    return valid ? {
      authenticatedFiles: installedInventory.files,
      files: expectedInventory.files,
      rootIdentity,
      valid: true,
    } : invalid();
  } catch (error) {
    return invalid();
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function installedPackageMatchesLockArchive(packageRoot, packageName, metadata, options = {}) {
  return authenticateInstalledPackageSnapshot(packageRoot, packageName, metadata, {
    ...options,
    sealForPackaging: false,
  }).valid;
}

function authenticateVerifierToolchain(sourceRoot, options = {}) {
  const invalid = () => ({
    packageCount: 0,
    recheck: () => false,
    tools: null,
    valid: false,
  });
  let canonicalSourceRoot;
  let canonicalNodeModulesRoot;
  let sourceRootIdentity;
  let nodeModulesIdentity;
  const sourceEvidence = new Map();
  let sourceManifest;
  let sourceLockfile;
  try {
    sourceRootIdentity = directoryIdentity(sourceRoot);
    if (!sourceRootIdentity) return invalid();
    canonicalSourceRoot = sourceRootIdentity.realpath;
    const nodeModulesRoot = path.join(canonicalSourceRoot, 'node_modules');
    nodeModulesIdentity = directoryIdentity(nodeModulesRoot);
    if (!nodeModulesIdentity) return invalid();
    canonicalNodeModulesRoot = nodeModulesIdentity.realpath;
    for (const relativePath of ['package.json', 'package-lock.json']) {
      const bytes = readStableRegularFile(path.join(canonicalSourceRoot, relativePath));
      if (!bytes) return invalid();
      sourceEvidence.set(relativePath, hashBuffer(bytes));
      const parsed = JSON.parse(bytes.toString('utf8'));
      if (!isPlainObject(parsed)) return invalid();
      if (relativePath === 'package.json') sourceManifest = parsed;
      else sourceLockfile = parsed;
    }
  } catch (error) {
    return invalid();
  }

  const reachable = collectReachableVerifierToolLockPaths(
    sourceManifest,
    sourceLockfile,
    options
  );
  if (!reachable.valid || reachable.paths.size === 0) return invalid();
  const packageRechecks = [];
  const packageRoots = new Map();
  for (const lockPath of [...reachable.paths].sort()) {
    const normalizedLockPath = normalizeDependencyLockPath(lockPath);
    const metadata = sourceLockfile.packages[lockPath];
    const packageName = dependencyNameFromLockPath(normalizedLockPath);
    if (!normalizedLockPath || !isPlainObject(metadata) || !packageName ||
        typeof metadata.version !== 'string' || !parseSha512Integrity(metadata.integrity)) {
      return invalid();
    }
    const packageRoot = canonicalDependencyPackageRoot(
      canonicalSourceRoot,
      canonicalNodeModulesRoot,
      normalizedLockPath
    );
    if (!packageRoot) return invalid();
    const authenticated = authenticateInstalledPackageSnapshot(
      packageRoot,
      packageName,
      metadata,
      {
        ...options,
        sealForPackaging: false,
      }
    );
    const manifest = authenticated.files.get('package.json')?.json;
    if (!authenticated.valid || !isPlainObject(manifest) ||
        manifest.name !== packageName || manifest.version !== metadata.version ||
        !dependencyTopologyMatchesManifest(manifest, metadata)) {
      return invalid();
    }
    packageRechecks.push(() => authenticatedPackageStateMatches(packageRoot, authenticated));
    packageRoots.set(normalizedLockPath, packageRoot);
  }

  const recheck = () => {
    if (!directoryIdentityMatches(canonicalSourceRoot, sourceRootIdentity) ||
        !directoryIdentityMatches(path.join(canonicalSourceRoot, 'node_modules'), nodeModulesIdentity)) {
      return false;
    }
    for (const [relativePath, digest] of sourceEvidence) {
      const bytes = readStableRegularFile(path.join(canonicalSourceRoot, relativePath));
      if (!bytes || hashBuffer(bytes) !== digest) return false;
    }
    return packageRechecks.every(check => check());
  };
  if (!recheck()) return invalid();
  if (typeof options.afterToolAuthentication === 'function') {
    options.afterToolAuthentication();
  }
  if (!recheck()) return invalid();

  try {
    const customLoaders = typeof options.loadAsar === 'function' &&
      typeof options.loadFuses === 'function';
    if (!customLoaders) {
      let verifierModuleRoot;
      try {
        verifierModuleRoot = fs.realpathSync(path.resolve(__dirname, '..'));
      } catch (error) {
        return invalid();
      }
      if (verifierModuleRoot !== canonicalSourceRoot ||
          Object.keys(require.cache).some(modulePath => (
            [...packageRoots.values()].some(packageRoot => (
              modulePath === packageRoot || modulePath.startsWith(`${packageRoot}${path.sep}`)
            ))
          ))) {
        return invalid();
      }
    }
    const loadTool = (name, customLoader) => {
      if (customLoaders) return customLoader();
      const lockPath = resolveDependencyLockPath(sourceLockfile, '', name);
      const packageRoot = packageRoots.get(lockPath);
      const entryPath = require.resolve(name, { paths: [canonicalSourceRoot] });
      const canonicalEntry = fs.realpathSync(entryPath);
      if (!packageRoot || !canonicalEntry.startsWith(`${packageRoot}${path.sep}`) ||
          require.cache[entryPath]) {
        throw new Error('invalid verifier tool');
      }
      return require(entryPath);
    };
    const asar = loadTool('@electron/asar', options.loadAsar);
    const fuses = loadTool('@electron/fuses', options.loadFuses);
    if (!asar || typeof asar.extractFile !== 'function' || typeof asar.getRawHeader !== 'function' ||
        !fuses || typeof fuses.getCurrentFuseWire !== 'function' || !recheck()) {
      return invalid();
    }
    return {
      packageCount: reachable.paths.size,
      recheck,
      tools: {
        asar,
        getFuseWire: executablePath => fuses.getCurrentFuseWire(executablePath),
      },
      valid: true,
    };
  } catch (error) {
    return invalid();
  }
}

function normalizeElectronRuntimeSegment(segment, executableName) {
  const suffixes = ['', ' (GPU)', ' (Plugin)', ' (Renderer)'];
  for (const suffix of suffixes) {
    if (segment === `${executableName} Helper${suffix}`) return `Electron Helper${suffix}`;
    if (segment === `${executableName} Helper${suffix}.app`) {
      return `Electron Helper${suffix}.app`;
    }
  }
  return segment;
}

function normalizeElectronRuntimePath(relativePath, executableName) {
  return relativePath.split('/').map(segment => (
    normalizeElectronRuntimeSegment(segment, executableName)
  )).join('/');
}

function electronRuntimePathIsExcluded(relativePath) {
  const segments = relativePath.split('/');
  if (segments.includes('_CodeSignature')) return true;
  return /^Electron Helper(?: \((?:GPU|Plugin|Renderer)\))?\.app\/Contents\/Info\.plist$/u
    .test(relativePath);
}

function collectElectronRuntimeTree(rootPath, executableName) {
  const entries = new Map();
  const pending = [{ absolutePath: rootPath, relativePath: '' }];
  try {
    const rootMetadata = fs.lstatSync(rootPath);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
      return { valid: false, entries };
    }
    while (pending.length > 0) {
      const current = pending.pop();
      for (const name of fs.readdirSync(current.absolutePath).sort()) {
        const relativePath = current.relativePath ? `${current.relativePath}/${name}` : name;
        const normalizedPath = normalizeElectronRuntimePath(relativePath, executableName);
        const absolutePath = path.join(current.absolutePath, name);
        const metadata = fs.lstatSync(absolutePath);
        if (electronRuntimePathIsExcluded(normalizedPath)) continue;
        if (entries.has(normalizedPath)) return { valid: false, entries: new Map() };
        if (metadata.isSymbolicLink()) {
          entries.set(normalizedPath, {
            type: 'link',
            target: normalizeElectronRuntimePath(fs.readlinkSync(absolutePath), executableName),
          });
        } else if (metadata.isDirectory()) {
          entries.set(normalizedPath, { type: 'directory' });
          pending.push({ absolutePath, relativePath });
        } else if (metadata.isFile()) {
          entries.set(normalizedPath, {
            absolutePath,
            mode: metadata.mode & 0o777,
            type: 'file',
          });
        } else {
          return { valid: false, entries: new Map() };
        }
      }
    }
  } catch (error) {
    return { valid: false, entries: new Map() };
  }
  return { valid: entries.size > 0, entries };
}

function normalizeElectronFuseBytes(filePath) {
  try {
    const bytes = fs.readFileSync(filePath);
    let offset = 0;
    let found = 0;
    while (offset < bytes.length) {
      const sentinelIndex = bytes.indexOf(ELECTRON_FUSE_SENTINEL, offset);
      if (sentinelIndex === -1) break;
      const wirePosition = sentinelIndex + ELECTRON_FUSE_SENTINEL.length;
      const wireVersion = bytes[wirePosition];
      const wireLength = bytes[wirePosition + 1];
      if (wireVersion !== Number(EXPECTED_FUSE_VERSION) ||
          wireLength !== EXPECTED_FUSE_INDICES.length ||
          wirePosition + 2 + wireLength > bytes.length) {
        return false;
      }
      bytes.fill(48, wirePosition + 2, wirePosition + 2 + wireLength);
      found += 1;
      offset = wirePosition + 2 + wireLength;
    }
    if (found !== 1) return false;
    fs.writeFileSync(filePath, bytes);
    return true;
  } catch (error) {
    return false;
  }
}

function canonicalElectronRuntimeFileMatches(
  packagedPath,
  sourcePath,
  normalizedPath,
  commandRunner = runCommand
) {
  const packagedType = commandRunner('/usr/bin/file', ['-b', packagedPath]);
  const sourceType = commandRunner('/usr/bin/file', ['-b', sourcePath]);
  if (!packagedType.ok || !sourceType.ok) return false;
  const packagedIsMachO = /^Mach-O\b/u.test(String(packagedType.stdout || '').trim());
  const sourceIsMachO = /^Mach-O\b/u.test(String(sourceType.stdout || '').trim());
  if (packagedIsMachO !== sourceIsMachO) return false;
  if (!packagedIsMachO) {
    return hashBuffer(fs.readFileSync(packagedPath)) === hashBuffer(fs.readFileSync(sourcePath));
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-electron-runtime-'));
  const packagedCopy = path.join(temporaryRoot, 'packaged');
  const sourceCopy = path.join(temporaryRoot, 'source');
  try {
    fs.copyFileSync(packagedPath, packagedCopy);
    fs.copyFileSync(sourcePath, sourceCopy);
    for (const filePath of [packagedCopy, sourceCopy]) {
      if (!commandRunner('/usr/bin/codesign', ['--remove-signature', filePath]).ok ||
          !commandRunner('/usr/bin/strip', ['-S', filePath]).ok) {
        return false;
      }
      if (normalizedPath ===
          'Electron Framework.framework/Versions/A/Electron Framework' &&
          !normalizeElectronFuseBytes(filePath)) {
        return false;
      }
    }
    return hashBuffer(fs.readFileSync(packagedCopy)) === hashBuffer(fs.readFileSync(sourceCopy));
  } catch (error) {
    return false;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function electronRuntimePayloadMatches(appPath, electronAppPath, executableName, options = {}) {
  try {
    const packagedMain = path.join(appPath, 'Contents', 'MacOS', executableName);
    const sourceMain = path.join(electronAppPath, 'Contents', 'MacOS', 'Electron');
    const packagedMainMode = fs.lstatSync(packagedMain).mode & 0o777;
    const sourceMainMode = fs.lstatSync(sourceMain).mode & 0o777;
    if ((packagedMainMode & 0o111) === 0 || packagedMainMode !== sourceMainMode) return false;
    const matcher = options.runtimeFileMatcher || ((packagedPath, sourcePath, relativePath) => (
      canonicalElectronRuntimeFileMatches(
        packagedPath,
        sourcePath,
        relativePath,
        options.commandRunner || runCommand
      )
    ));
    if (!matcher(packagedMain, sourceMain, 'Contents/MacOS/Electron')) return false;

    const packaged = collectElectronRuntimeTree(
      path.join(appPath, 'Contents', 'Frameworks'),
      executableName
    );
    const source = collectElectronRuntimeTree(
      path.join(electronAppPath, 'Contents', 'Frameworks'),
      'Electron'
    );
    if (!packaged.valid || !source.valid) return false;
    const packagedEntries = [...packaged.entries.keys()].sort();
    const sourceEntries = [...source.entries.keys()].sort();
    if (!isDeepStrictEqual(packagedEntries, sourceEntries)) return false;
    for (const entry of sourceEntries) {
      const packagedItem = packaged.entries.get(entry);
      const sourceItem = source.entries.get(entry);
      if (packagedItem.type !== sourceItem.type) return false;
      if (sourceItem.type === 'link' && packagedItem.target !== sourceItem.target) return false;
      if (sourceItem.type === 'file' && packagedItem.mode !== sourceItem.mode) return false;
      if (sourceItem.type === 'file' &&
          !matcher(packagedItem.absolutePath, sourceItem.absolutePath, entry)) {
        return false;
      }
    }
    return true;
  } catch (error) {
    return false;
  }
}

function invalidElectronRuntimeEvidence(lockedVersion = '') {
  return {
    valid: false,
    lockedVersion,
    archiveVerified: false,
    payloadMatches: false,
  };
}

function collectElectronRuntimeEvidence(
  appPath,
  sourceRoot,
  electronArchivePath,
  executableName,
  commandRunner = runCommand,
  options = {}
) {
  let lockedVersion = '';
  const invalid = () => invalidElectronRuntimeEvidence(lockedVersion);
  try {
    const sourceRevision = String(options.sourceRevision || '').toLowerCase();
    if (!isSafeExecutableName(executableName) || !electronArchivePath ||
        !/^[a-f0-9]{40}$/u.test(sourceRevision)) {
      return invalid();
    }
    if (!gitObjectOverridesAbsent(sourceRoot, commandRunner)) return invalid();
    const manifestResult = gitCommand(commandRunner, ['show', `${sourceRevision}:package.json`], {
      cwd: sourceRoot,
    });
    const lockfileResult = gitCommand(commandRunner, ['show', `${sourceRevision}:package-lock.json`], {
      cwd: sourceRoot,
    });
    if (!manifestResult.ok || !lockfileResult.ok) return invalid();
    const sourceManifest = JSON.parse(String(manifestResult.stdout || ''));
    const sourceLockfile = JSON.parse(String(lockfileResult.stdout || ''));
    const electronMetadata = sourceLockfile.packages &&
      sourceLockfile.packages['node_modules/electron'];
    lockedVersion = electronMetadata && electronMetadata.version;
    const declaredElectron = sourceManifest.devDependencies &&
      sourceManifest.devDependencies.electron;
    if (!rootLockMatchesSourceManifest(sourceManifest, sourceLockfile) ||
        !isPlainObject(electronMetadata) || electronMetadata.dev !== true ||
        typeof lockedVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(lockedVersion) ||
        typeof declaredElectron !== 'string' ||
        !declaredVersionIncludes(declaredElectron, lockedVersion)) {
      return invalid();
    }

    const electronPackageRoot = path.join(sourceRoot, 'node_modules', 'electron');
    const authenticatedElectron = authenticateInstalledPackageSnapshot(
      electronPackageRoot,
      'electron',
      electronMetadata,
      { ...options, sealForPackaging: false }
    );
    if (!authenticatedElectron.valid) {
      return invalid();
    }
    if (typeof options.afterElectronDependencyAuthentication === 'function') {
      options.afterElectronDependencyAuthentication();
    }
    const installedManifest = authenticatedElectron.authenticatedFiles.get('package.json')?.json;
    const checksums = authenticatedElectron.authenticatedFiles.get('checksums.json')?.json;
    const archiveName = `electron-v${lockedVersion}-darwin-arm64.zip`;
    const expectedChecksum = checksums && checksums[archiveName];
    if (!isPlainObject(installedManifest) || !isPlainObject(checksums) ||
        installedManifest.name !== 'electron' || installedManifest.version !== lockedVersion ||
        !/^[a-f0-9]{64}$/u.test(String(expectedChecksum || ''))) {
      return invalid();
    }

    const archiveBytes = readStableRegularFile(electronArchivePath);
    if (!archiveBytes || crypto.createHash('sha256').update(archiveBytes).digest('hex') !==
        expectedChecksum) {
      return invalid();
    }

    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-electron-archive-'));
    try {
      const privateRoot = path.join(temporaryRoot, 'authenticated');
      const extractedRoot = path.join(temporaryRoot, 'extracted');
      fs.mkdirSync(privateRoot, { mode: 0o700 });
      fs.mkdirSync(extractedRoot, { mode: 0o700 });
      const privateArchivePath = path.join(privateRoot, archiveName);
      fs.writeFileSync(privateArchivePath, archiveBytes, { flag: 'wx', mode: 0o600 });
      const extractor = options.extractElectronArchive || ((archivePath, outputPath) => (
        commandRunner('/usr/bin/ditto', ['-x', '-k', archivePath, outputPath]).ok
      ));
      if (!extractor(privateArchivePath, extractedRoot) ||
          !hasExactTypedEntries(extractedRoot, {
            'Electron.app': 'directory',
            LICENSE: 'file',
            'LICENSES.chromium.html': 'file',
            version: 'file',
          }) ||
          !hasExactValues(
            fs.readdirSync(extractedRoot).sort(),
            [...EXPECTED_ELECTRON_ARCHIVE_ROOT_ENTRIES].sort()
          ) ||
          fs.readFileSync(path.join(extractedRoot, 'version'), 'utf8').trim() !== lockedVersion) {
        return invalid();
      }
      const payloadMatches = electronRuntimePayloadMatches(
        appPath,
        path.join(extractedRoot, 'Electron.app'),
        executableName,
        {
          commandRunner,
          runtimeFileMatcher: options.runtimeFileMatcher,
        }
      );
      const dependencyStable = authenticatedPackageStateMatches(
        electronPackageRoot,
        authenticatedElectron
      );
      return {
        valid: payloadMatches && dependencyStable,
        lockedVersion,
        archiveVerified: true,
        payloadMatches: payloadMatches && dependencyStable,
      };
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  } catch (error) {
    return invalid();
  }
}

function cleanDependencyManifest(sourceManifest) {
  const clean = {};
  const dependencies = isPlainObject(sourceManifest.dependencies) ? sourceManifest.dependencies : {};
  const removeBabel = !Object.keys(dependencies).some(name => name.startsWith('babel'));
  for (const [key, value] of Object.entries(sourceManifest)) {
    if (key.startsWith('_') || DEPENDENCY_MANIFEST_REMOVED_KEYS.has(key) ||
        (removeBabel && key === 'babel')) {
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

function collectExpectedProductionPackages(sourceRoot, sourceManifest, options = {}) {
  const packages = new Map();
  const rechecks = [];
  if (!hasApprovedDependencyPackagingConfig(sourceManifest)) return { valid: false, packages };
  const lockfile = options.sourceLockfile;
  if (!isPlainObject(lockfile) || !isPlainObject(lockfile.packages)) {
    return { valid: false, packages };
  }

  const platform = options.platform || 'darwin';
  const arch = options.arch || 'arm64';
  const nodeModulesRoot = path.resolve(sourceRoot, 'node_modules');
  let canonicalNodeModulesRoot;
  try {
    const nodeModulesMetadata = fs.lstatSync(nodeModulesRoot);
    if (nodeModulesMetadata.isSymbolicLink() || !nodeModulesMetadata.isDirectory()) {
      return { valid: false, packages };
    }
    canonicalNodeModulesRoot = fs.realpathSync(nodeModulesRoot);
  } catch (error) {
    return { valid: false, packages };
  }
  const reachable = collectReachableProductionLockPaths(sourceManifest, lockfile, {
    arch,
    platform,
  });
  if (!reachable.valid) return { valid: false, packages };
  for (const lockPath of [...reachable.paths].sort()) {
    const metadata = lockfile.packages[lockPath];
    const normalizedLockPath = normalizeDependencyLockPath(lockPath);
    const name = dependencyNameFromLockPath(normalizedLockPath);
    const version = metadata.version;
    if (!normalizedLockPath || !name || typeof version !== 'string' ||
        !parseSha512Integrity(metadata.integrity)) {
      return { valid: false, packages: new Map() };
    }
    const packageRoot = canonicalDependencyPackageRoot(
      sourceRoot,
      canonicalNodeModulesRoot,
      normalizedLockPath
    );
    if (!packageRoot) {
      return { valid: false, packages: new Map() };
    }
    if (!fs.existsSync(packageRoot)) {
      return { valid: false, packages: new Map() };
    }
    const authenticated = authenticateInstalledPackageSnapshot(packageRoot, name, metadata, {
      ...options,
      sealForPackaging: true,
    });
    if (!authenticated.valid) {
      return { valid: false, packages: new Map() };
    }
    if (name === 'canvas' && !authenticated.files.has('build/Release/canvas.node')) {
      return { valid: false, packages: new Map() };
    }
    const manifest = authenticated.files.get('package.json')?.json;
    if (!isPlainObject(manifest) || manifest.name !== name || manifest.version !== version ||
        !dependencyTopologyMatchesManifest(manifest, metadata)) {
      return { valid: false, packages: new Map() };
    }
    packages.set(normalizedLockPath, {
      files: authenticated.files,
      name,
      root: normalizedLockPath,
      version,
    });
    rechecks.push(() => authenticatedPackageStateMatches(packageRoot, authenticated));
  }
  if (typeof options.onDependencyEvidenceSealed === 'function') {
    options.onDependencyEvidenceSealed(packages);
  }
  if (typeof options.afterDependencyAuthentication === 'function') {
    options.afterDependencyAuthentication();
  }
  return {
    valid: packages.size > 0,
    packages,
    recheck: () => rechecks.every(recheck => recheck()),
  };
}

function collectActualUnpackedFiles(asarPath) {
  const root = `${asarPath}.unpacked`;
  const files = new Set();
  if (!fs.existsSync(root)) return { valid: true, files };
  try {
    const rootMetadata = fs.lstatSync(root);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) return { valid: false, files };
    const pending = [root];
    while (pending.length > 0) {
      const current = pending.pop();
      for (const name of fs.readdirSync(current).sort()) {
        const absolutePath = path.join(current, name);
        const metadata = fs.lstatSync(absolutePath);
        if (metadata.isSymbolicLink()) return { valid: false, files: new Set() };
        if (metadata.isDirectory()) {
          pending.push(absolutePath);
          continue;
        }
        const relativePath = normalizeArchiveEntry(
          path.relative(root, absolutePath).split(path.sep).join('/')
        );
        if (!metadata.isFile() || !relativePath || !relativePath.startsWith('node_modules/')) {
          return { valid: false, files: new Set() };
        }
        files.add(relativePath);
      }
    }
  } catch (error) {
    return { valid: false, files: new Set() };
  }
  return { valid: true, files };
}

function collectPackagedDependencyFiles(asar, asarPath) {
  const files = new Map();
  const unpackedFiles = new Set();
  try {
    for (const entry of asar.listPackage(asarPath)) {
      const normalized = normalizeArchiveEntry(entry);
      if (!normalized) return { valid: false, files };
      if (normalized !== 'node_modules' && !normalized.startsWith('node_modules/')) continue;
      const metadata = asar.statFile(asarPath, normalized, false);
      if (metadata && metadata.link) return { valid: false, files: new Map() };
      if (metadata && metadata.files) continue;
      if (files.has(normalized)) return { valid: false, files: new Map() };
      files.set(normalized, Buffer.from(asar.extractFile(asarPath, normalized)));
      if (metadata && metadata.unpacked === true) unpackedFiles.add(normalized);
    }
  } catch (error) {
    return { valid: false, files: new Map() };
  }
  const actualUnpacked = collectActualUnpackedFiles(asarPath);
  if (!actualUnpacked.valid ||
      !isDeepStrictEqual([...actualUnpacked.files].sort(), [...unpackedFiles].sort())) {
    return { valid: false, files: new Map() };
  }
  return { valid: files.size > 0, files };
}

function canonicalNativeDigestFromBytes(bytes, commandRunner = runCommand) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-native-proof-'));
  const privatePath = path.join(temporaryRoot, 'native');
  try {
    fs.writeFileSync(privatePath, bytes, { flag: 'wx', mode: 0o600 });
    commandRunner('/usr/bin/codesign', ['--remove-signature', privatePath]);
    if (!commandRunner('/usr/bin/strip', ['-S', privatePath]).ok) return null;
    return hashBuffer(fs.readFileSync(privatePath));
  } catch (error) {
    return null;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function packagePayloadMatches(expectedPackage, actualFiles, options = {}) {
  const expectedEntries = [...expectedPackage.files.keys()].sort();
  const actualEntries = [...actualFiles.keys()].sort();
  if (!isDeepStrictEqual(expectedEntries, actualEntries)) return false;
  for (const entry of expectedEntries) {
    const packagedBytes = actualFiles.get(entry);
    const evidence = expectedPackage.files.get(entry);
    if (evidence.kind === 'manifest') {
      const packagedManifest = JSON.parse(packagedBytes.toString('utf8'));
      if (!isDeepStrictEqual(packagedManifest, evidence.value)) return false;
    } else if (evidence.kind === 'native-custom') {
      if (typeof options.nativeFileMatcher !== 'function' ||
          !options.nativeFileMatcher(packagedBytes, evidence)) return false;
    } else if (evidence.kind === 'native') {
      if (canonicalNativeDigestFromBytes(packagedBytes, options.commandRunner) !== evidence.digest) {
        return false;
      }
    } else if (hashBuffer(packagedBytes) !== evidence.rawDigest) {
      return false;
    }
  }
  return true;
}

function dependencyPackageInventoriesMatch(
  expectedPackages,
  actualPackages,
  sourceManifest,
  sourceLockfile,
  options = {}
) {
  if (!(expectedPackages instanceof Map) || !(actualPackages instanceof Map) ||
      expectedPackages.size === 0 || actualPackages.size === 0 ||
      actualPackages.size > expectedPackages.size || !isPlainObject(sourceManifest) ||
      !isPlainObject(sourceLockfile) || !isPlainObject(sourceLockfile.packages)) {
    return false;
  }
  const payloadMatches = (expectedPackage, actualPackage) => (
    expectedPackage.name === actualPackage.name &&
    expectedPackage.version === actualPackage.version &&
    packagePayloadMatches(expectedPackage, actualPackage.files, options)
  );
  const actualTree = {
    packages: Object.fromEntries([...actualPackages.keys()].map(root => [root, {}])),
  };
  const mappedExpected = new Map();
  const usedActual = new Set();
  const visited = new Set();
  const queue = [];
  const addRequests = (expectedParent, actualParent, metadata, includePeers) => {
    const required = dependencySection(metadata, 'dependencies');
    const optional = dependencySection(metadata, 'optionalDependencies');
    const peers = includePeers ? dependencySection(metadata, 'peerDependencies') : {};
    const peerMetadata = includePeers && metadata.peerDependenciesMeta !== undefined
      ? metadata.peerDependenciesMeta
      : {};
    if (required === null || optional === null || peers === null || !isPlainObject(peerMetadata)) {
      return false;
    }
    for (const name of Object.keys(required).sort()) {
      queue.push({ actualParent, expectedParent, name, optional: false });
    }
    for (const name of Object.keys(optional).sort()) {
      queue.push({ actualParent, expectedParent, name, optional: true });
    }
    for (const name of Object.keys(peers).sort()) {
      const optionalPeer = isPlainObject(peerMetadata[name]) &&
        peerMetadata[name].optional === true;
      queue.push({ actualParent, expectedParent, name, optional: optionalPeer });
    }
    return true;
  };
  if (!addRequests('', '', sourceManifest, false)) return false;

  // Electron Builder hoists identical production packages and emits one copy for
  // multiple lock paths. Follow the actual Node resolution graph and require
  // every parent edge to resolve to the authenticated version and bytes from the
  // lockfile. This permits safe hoisting without allowing topology swaps.
  while (queue.length > 0) {
    const request = queue.shift();
    const expectedRoot = resolveDependencyLockPath(
      sourceLockfile,
      request.expectedParent,
      request.name
    );
    if (!expectedRoot || !expectedPackages.has(expectedRoot)) {
      if (request.optional) continue;
      return false;
    }
    const actualRoot = resolveDependencyLockPath(
      actualTree,
      request.actualParent,
      request.name
    );
    const expectedPackage = expectedPackages.get(expectedRoot);
    const actualPackage = actualRoot && actualPackages.get(actualRoot);
    if (!actualPackage || !payloadMatches(expectedPackage, actualPackage)) return false;
    if (mappedExpected.has(expectedRoot) && mappedExpected.get(expectedRoot) !== actualRoot) {
      return false;
    }
    mappedExpected.set(expectedRoot, actualRoot);
    usedActual.add(actualRoot);
    const pair = `${expectedRoot}\0${actualRoot}`;
    if (visited.has(pair)) continue;
    visited.add(pair);
    const metadata = sourceLockfile.packages[expectedRoot];
    if (!isPlainObject(metadata) ||
        !addRequests(expectedRoot, actualRoot, metadata, true)) {
      return false;
    }
  }
  return mappedExpected.size === expectedPackages.size &&
    usedActual.size === actualPackages.size;
}

function dependencyInventoryMatchesLock(asar, asarPath, sourceRoot, sourceManifest, options = {}) {
  const expected = collectExpectedProductionPackages(sourceRoot, sourceManifest, options);
  const packaged = collectPackagedDependencyFiles(asar, asarPath);
  if (!expected.valid || !packaged.valid) return false;

  const actualPackages = new Map();
  const roots = [];
  for (const [entry, bytes] of packaged.files) {
    if (!isDependencyManifestEntry(entry)) continue;
    const root = dependencyLockPathFromManifestEntry(entry);
    const pathName = dependencyNameFromLockPath(root);
    const manifest = JSON.parse(bytes.toString('utf8'));
    if (!root || !pathName || manifest.name !== pathName || typeof manifest.version !== 'string') {
      return false;
    }
    if (actualPackages.has(root)) return false;
    const actualPackage = { files: new Map(), name: manifest.name, root, version: manifest.version };
    actualPackages.set(root, actualPackage);
    roots.push(actualPackage);
  }
  roots.sort((left, right) => right.root.length - left.root.length);
  for (const [entry, bytes] of packaged.files) {
    const owner = roots.find(candidate => entry === candidate.root || entry.startsWith(`${candidate.root}/`));
    if (!owner || entry === owner.root) return false;
    owner.files.set(entry.slice(owner.root.length + 1), bytes);
  }

  const payloadMatches = dependencyPackageInventoriesMatch(
    expected.packages,
    actualPackages,
    sourceManifest,
    options.sourceLockfile,
    options
  );
  return payloadMatches && expected.recheck();
}

function collectSourceBinding(appPath, commandRunner, options = {}) {
  let sourceRoot;
  try {
    sourceRoot = fs.realpathSync(options.sourceRoot || path.resolve(__dirname, '..'));
  } catch (error) {
    return {
      matches: false,
      manifestMatches: false,
      dependencyLockMatches: false,
      releaseSourceClean: false,
      revision: '',
      entryCount: SOURCE_BOUND_ENTRY_COUNT,
    };
  }
  const topLevelResult = gitCommand(commandRunner, ['rev-parse', '--show-toplevel'], {
    cwd: sourceRoot,
  });
  let sourceTopLevel = '';
  try {
    sourceTopLevel = topLevelResult.ok
      ? fs.realpathSync(String(topLevelResult.stdout || '').trim())
      : '';
  } catch (error) {
    sourceTopLevel = '';
  }
  const sourceRootIsGitTopLevel = sourceTopLevel === sourceRoot;
  const revisionResult = gitCommand(
    commandRunner,
    ['rev-parse', '--verify', 'HEAD^{commit}'],
    { cwd: sourceRoot }
  );
  const revision = revisionResult.ok ? revisionResult.stdout.trim().toLowerCase() : '';
  if (!/^[a-f0-9]{40}$/u.test(revision) || !sourceRootIsGitTopLevel ||
      !gitObjectOverridesAbsent(sourceRoot, commandRunner)) {
    return {
      matches: false,
      manifestMatches: false,
      dependencyLockMatches: false,
      releaseSourceClean: false,
      revision: '',
      entryCount: SOURCE_BOUND_ENTRY_COUNT,
    };
  }
  let asar = options.asar;
  if (!asar) {
    try {
      asar = require('@electron/asar');
    } catch (error) {
      throw createVerificationError('Unable to verify packaged source binding.');
    }
  }

  const asarPath = resolveAsarPath(appPath);
  let matches = true;
  let manifestMatches = false;
  let dependencyLockMatches = false;
  try {
    for (const entry of SOURCE_BOUND_ENTRIES) {
      const treeEntry = gitCommand(commandRunner, ['ls-tree', revision, '--', entry], {
        cwd: sourceRoot,
      });
      const packagedBytes = asar.extractFile(asarPath, entry);
      const packagedObject = gitCommand(commandRunner, ['hash-object', '--stdin'], {
        cwd: sourceRoot,
        input: packagedBytes,
      });
      const treeMatch = treeEntry.ok && String(treeEntry.stdout || '').trim().match(
        /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u
      );
      if (!treeMatch || treeMatch[3] !== entry || !packagedObject.ok ||
          String(packagedObject.stdout || '').trim().toLowerCase() !== treeMatch[2]) {
        matches = false;
      }
    }
    for (const entry of EXTERNAL_SOURCE_BOUND_ENTRIES) {
      const treeEntry = gitCommand(commandRunner, ['ls-tree', revision, '--', entry.source], {
        cwd: sourceRoot,
      });
      const packagedBytes = readStableRegularFile(path.join(
        appPath,
        ...entry.artifact.split('/')
      ));
      const packagedObject = packagedBytes && gitCommand(commandRunner, ['hash-object', '--stdin'], {
        cwd: sourceRoot,
        input: packagedBytes,
      });
      const treeMatch = treeEntry.ok && String(treeEntry.stdout || '').trim().match(
        /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u
      );
      if (!treeMatch || treeMatch[3] !== entry.source || !packagedObject ||
          !packagedObject.ok ||
          String(packagedObject.stdout || '').trim().toLowerCase() !== treeMatch[2]) {
        matches = false;
      }
    }

    const manifestResult = gitCommand(commandRunner, ['show', `${revision}:package.json`], {
      cwd: sourceRoot,
    });
    const lockfileResult = gitCommand(commandRunner, ['show', `${revision}:package-lock.json`], {
      cwd: sourceRoot,
    });
    if (!manifestResult.ok || !lockfileResult.ok) throw new Error('Source metadata is unavailable.');
    const sourceManifest = JSON.parse(String(manifestResult.stdout || ''));
    const sourceLockfile = JSON.parse(String(lockfileResult.stdout || ''));
    const packagedManifest = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'));
    const packagedKeys = Object.keys(packagedManifest).sort();
    manifestMatches = rootLockMatchesSourceManifest(sourceManifest, sourceLockfile) &&
      isDeepStrictEqual(packagedKeys, EXPECTED_PACKAGED_MANIFEST_KEYS) &&
      EXPECTED_PACKAGED_MANIFEST_KEYS.every(key => (
        isDeepStrictEqual(packagedManifest[key], sourceManifest[key])
      ));
    dependencyLockMatches = dependencyInventoryMatchesLock(
      asar,
      asarPath,
      sourceRoot,
      sourceManifest,
      {
        arch: options.arch,
        canvasPrebuild: options.canvasPrebuild,
        canvasPrebuildVerifier: options.canvasPrebuildVerifier,
        commandRunner: options.nativeCommandRunner || commandRunner,
        nativeFileMatcher: options.nativeFileMatcher,
        npmCacheRoot: options.npmCacheRoot,
        platform: options.platform,
        archiveVerifier: options.archiveVerifier,
        afterDependencyAuthentication: options.afterDependencyAuthentication,
        onDependencyEvidenceSealed: options.onDependencyEvidenceSealed,
        sourceLockfile,
      }
    );
  } catch (error) {
    matches = false;
    manifestMatches = false;
    dependencyLockMatches = false;
  }

  const releaseSourceClean = sourceRootIsGitTopLevel &&
    sourceCheckoutMatchesRevision(sourceRoot, revision, commandRunner);
  if (!releaseSourceClean) {
    matches = false;
    manifestMatches = false;
    dependencyLockMatches = false;
  }
  return {
    matches,
    manifestMatches,
    dependencyLockMatches,
    releaseSourceClean,
    revision,
    entryCount: SOURCE_BOUND_ENTRY_COUNT,
  };
}

function expectedTeamIdentifier() {
  const identity = packageJson.build && packageJson.build.mac && packageJson.build.mac.identity;
  const match = typeof identity === 'string' ? identity.match(/\(([A-Z0-9]{10})\)\s*$/u) : null;
  if (packageJson.build.appId !== PUBLIC_APP_ID || !match || match[1] !== PUBLIC_TEAM_ID) {
    throw createVerificationError('Canonical public signing identity is not configured.', 2);
  }
  return PUBLIC_TEAM_ID;
}

async function collectReleaseEvidenceFromSnapshot(appPath, options = {}) {
  if (process.platform !== 'darwin') {
    throw createVerificationError('The signed macOS app verifier must run on macOS.', 2);
  }

  const resolvedAppPath = path.resolve(appPath);
  let appStats;
  try {
    appStats = fs.lstatSync(resolvedAppPath);
  } catch (error) {
    throw createVerificationError('The app bundle input is missing or unreadable.', 2);
  }
  if (appStats.isSymbolicLink() || !appStats.isDirectory() || !resolvedAppPath.endsWith('.app')) {
    throw createVerificationError('The app bundle input is invalid.', 2);
  }
  const initialAppIdentity = directoryIdentity(resolvedAppPath);
  if (!initialAppIdentity) {
    throw createVerificationError('The app bundle input is invalid.', 2);
  }

  const commandRunner = options.commandRunner || runCommand;
  const requireNotarization = options.requireNotarization !== false;
  const expectedExecutableName = options.expectedExecutableName || packageJson.productName;
  const expectedAppId = options.expectedAppId || PUBLIC_APP_ID;
  const expectedTeamId = expectedTeamIdentifier();
  if (!isSafeExecutableName(expectedExecutableName)) {
    throw createVerificationError('The approved executable name is invalid.', 2);
  }
  const requestedSourceRoot = path.resolve(options.sourceRoot || path.resolve(__dirname, '..'));
  let sourceRoot = requestedSourceRoot;
  let sourceRootStats;
  try {
    sourceRootStats = fs.lstatSync(requestedSourceRoot);
    sourceRoot = fs.realpathSync(requestedSourceRoot);
  } catch (error) {
    throw createVerificationError('The release proof source root is missing or unreadable.', 2);
  }
  let verifierSourceRoot = '';
  try {
    verifierSourceRoot = fs.realpathSync(path.resolve(__dirname, '..'));
  } catch (error) {
    throw createVerificationError('The verifier source root is unavailable.', 2);
  }
  if (sourceRootStats.isSymbolicLink() || !sourceRootStats.isDirectory() ||
      (requireNotarization && sourceRoot === verifierSourceRoot)) {
    throw createVerificationError('The release proof source root is invalid.', 2);
  }
  const verifyVerifierSource = options.verifyVerifierSource || verifierSourceMatchesExpectedRevision;
  if (requireNotarization && !verifyVerifierSource(options.expectedRevision, commandRunner)) {
    throw createVerificationError(
      'The signed-app verifier is not running from the clean approved release commit.',
      2
    );
  }
  const infoPlistPath = path.join(resolvedAppPath, 'Contents', 'Info.plist');
  const infoPlist = parseJsonPlist(infoPlistPath, commandRunner);
  if (!isSafeExecutableName(infoPlist.CFBundleExecutable)) {
    throw createVerificationError('Bundle executable metadata is missing or invalid.');
  }
  const executablePath = path.join(resolvedAppPath, 'Contents', 'MacOS', infoPlist.CFBundleExecutable);
  let executableStats;
  try {
    executableStats = fs.lstatSync(executablePath);
  } catch (error) {
    throw createVerificationError('The signed app executable is missing.');
  }
  if (executableStats.isSymbolicLink() || !executableStats.isFile() ||
      (executableStats.mode & 0o111) === 0) {
    throw createVerificationError('The signed app executable is invalid.');
  }

  const signatureVerification = commandRunner('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=4',
    resolvedAppPath,
  ]);
  const signatureDetails = commandRunner('/usr/bin/codesign', [
    '-dv',
    '--verbose=4',
    resolvedAppPath,
  ]);
  if (!signatureDetails.ok) throw createVerificationError('Unable to read code-signature metadata.');
  const signature = {
    valid: signatureVerification.ok && verifyAppleDeveloperIdSignature(
      resolvedAppPath,
      expectedAppId,
      expectedTeamId,
      commandRunner
    ),
    ...parseCodeSignatureMetadata(`${signatureDetails.stdout}\n${signatureDetails.stderr}`),
  };

  const inspectArchitectures = options.inspectArchitectures || inspectAppArchitectures;
  const architecture = inspectArchitectures(resolvedAppPath, executablePath, commandRunner);

  const allNestedBundles = findNestedCodeBundles(resolvedAppPath);
  const bundleLayout = inspectBundleLayout(resolvedAppPath, infoPlist.CFBundleExecutable);
  const helperBundles = allNestedBundles.filter(bundle => bundle.name.endsWith('.app'));
  const helpers = helperBundles.map(helper => {
    const helperInfo = parseJsonPlist(path.join(helper.path, 'Contents', 'Info.plist'), commandRunner);
    return {
      name: helper.name,
      infoPlist: helperInfo,
      signature: readNestedSignature(
        helper.path,
        expectedHelperIdentifier(helper.name, expectedAppId),
        expectedTeamId,
        commandRunner
      ),
      entitlements: readSignedEntitlements(helper.path, commandRunner),
      usageDescription: helperInfo.NSAppleEventsUsageDescription,
      privacyUsageKeys: privacyUsageKeys(helperInfo),
    };
  });
  const nestedBundles = allNestedBundles
    .filter(bundle => !bundle.name.endsWith('.app'))
    .map(bundle => ({
      name: bundle.name,
      signature: readNestedSignature(
        bundle.path,
        EXPECTED_NESTED_BUNDLE_IDENTIFIERS[bundle.name],
        expectedTeamId,
        commandRunner
      ),
      entitlements: readSignedEntitlements(bundle.path, commandRunner),
    }));

  let packagedContents = null;
  try {
    const verifyContents = options.verifyPackagedContents || verifyPackagedAppContents;
    packagedContents = verifyContents(resolvedAppPath);
  } catch (error) {
    packagedContents = null;
  }

  const fuseReader = options.getFuseWire || (async executablePath => {
    const { getCurrentFuseWire } = require('@electron/fuses');
    return getCurrentFuseWire(executablePath);
  });
  let fuseWire;
  try {
    fuseWire = await fuseReader(executablePath);
  } catch (error) {
    throw createVerificationError('Unable to read the Electron fuse policy.');
  }
  const inspectedFuses = inspectFuseWire(fuseWire);
  let asar = options.asar;
  if (!asar) {
    try {
      asar = require('@electron/asar');
    } catch (error) {
      throw createVerificationError('Unable to verify packaged source binding.');
    }
  }
  const asarPath = resolveAsarPath(resolvedAppPath);
  let asarIntegrityHash;
  try {
    const rawHeader = asar.getRawHeader(asarPath);
    if (!rawHeader || typeof rawHeader.headerString !== 'string') {
      throw new Error('Invalid ASAR header.');
    }
    asarIntegrityHash = hashBuffer(Buffer.from(rawHeader.headerString, 'utf8'));
  } catch (error) {
    throw createVerificationError('Unable to verify the packaged ASAR integrity header.');
  }
  const sourceBinding = collectSourceBinding(resolvedAppPath, commandRunner, {
    asar,
    arch: options.arch,
    canvasPrebuild: options.canvasPrebuild,
    canvasPrebuildVerifier: options.canvasPrebuildVerifier,
    nativeFileMatcher: options.nativeFileMatcher,
    nativeCommandRunner: options.nativeCommandRunner,
    npmCacheRoot: options.npmCacheRoot,
    platform: options.platform,
    archiveVerifier: options.archiveVerifier,
    afterDependencyAuthentication: options.afterDependencyAuthentication,
    onDependencyEvidenceSealed: options.onDependencyEvidenceSealed,
    sourceRoot,
  });
  const verifyElectronRuntime = options.verifyElectronRuntime || collectElectronRuntimeEvidence;
  let electronRuntime = verifyElectronRuntime(
    resolvedAppPath,
    sourceRoot,
    options.electronArchive,
    infoPlist.CFBundleExecutable,
    commandRunner,
    {
      archiveVerifier: options.archiveVerifier,
      afterElectronDependencyAuthentication: options.afterElectronDependencyAuthentication,
      extractElectronArchive: options.extractElectronArchive,
      npmCacheRoot: options.npmCacheRoot,
      runtimeFileMatcher: options.runtimeFileMatcher,
      sourceRevision: sourceBinding.revision,
    }
  );
  if (!sourceCheckoutMatchesRevision(sourceRoot, sourceBinding.revision, commandRunner)) {
    sourceBinding.matches = false;
    sourceBinding.manifestMatches = false;
    sourceBinding.dependencyLockMatches = false;
    sourceBinding.releaseSourceClean = false;
    electronRuntime = {
      ...electronRuntime,
      valid: false,
      payloadMatches: false,
    };
  }

  const notarization = {
    required: requireNotarization,
    gatekeeperAccepted: null,
    stapleValid: null,
  };
  if (requireNotarization) {
    notarization.gatekeeperAccepted = commandRunner('/usr/sbin/spctl', [
      '--assess',
      '--type',
      'execute',
      '--verbose=4',
      resolvedAppPath,
    ]).ok;
    notarization.stapleValid = commandRunner('/usr/bin/xcrun', [
      'stapler',
      'validate',
      resolvedAppPath,
    ]).ok;
  }

  const mainEntitlements = readSignedEntitlements(resolvedAppPath, commandRunner);
  if (typeof options.beforeFinalArtifactRecheck === 'function') {
    await options.beforeFinalArtifactRecheck();
  }
  const artifactIdentityMatchedBeforeFinalChecks = directoryIdentityMatches(
    resolvedAppPath,
    initialAppIdentity
  );
  if (typeof options.beforeFinalArtifactIdentityConfirmation === 'function') {
    await options.beforeFinalArtifactIdentityConfirmation();
  }
  const finalSignatureVerification = commandRunner('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=4',
    resolvedAppPath,
  ]);
  const finalSignatureDetails = commandRunner('/usr/bin/codesign', [
    '-dv',
    '--verbose=4',
    resolvedAppPath,
  ]);
  const finalSignatureMetadata = finalSignatureDetails.ok
    ? parseCodeSignatureMetadata(`${finalSignatureDetails.stdout}\n${finalSignatureDetails.stderr}`)
    : null;
  const finalTrustAccepted = verifyAppleDeveloperIdSignature(
    resolvedAppPath,
    expectedAppId,
    expectedTeamId,
    commandRunner
  );
  if (requireNotarization) {
    notarization.gatekeeperAccepted = notarization.gatekeeperAccepted === true &&
      commandRunner('/usr/sbin/spctl', [
        '--assess',
        '--type',
        'execute',
        '--verbose=4',
        resolvedAppPath,
      ]).ok;
    notarization.stapleValid = notarization.stapleValid === true &&
      commandRunner('/usr/bin/xcrun', [
        'stapler',
        'validate',
        resolvedAppPath,
      ]).ok;
  }
  const initialSignatureMetadata = {
    identifier: signature.identifier,
    teamIdentifier: signature.teamIdentifier,
    codeDirectoryHash: signature.codeDirectoryHash,
    authorities: signature.authorities,
    hardenedRuntime: signature.hardenedRuntime,
    timestamped: signature.timestamped,
  };
  const artifactStable = artifactIdentityMatchedBeforeFinalChecks &&
    finalSignatureVerification.ok &&
    finalTrustAccepted &&
    finalSignatureMetadata !== null &&
    isDeepStrictEqual(finalSignatureMetadata, initialSignatureMetadata) &&
    directoryIdentityMatches(resolvedAppPath, initialAppIdentity);

  return {
    artifactPath: resolvedAppPath,
    artifactStable,
    signature,
    architecture,
    infoPlist,
    asarIntegrityHash,
    fuseVersion: inspectedFuses.version,
    fuseIndices: inspectedFuses.indices,
    fuses: inspectedFuses.states,
    mainEntitlements,
    helpers,
    nestedBundles,
    bundleLayout,
    packagedContents,
    sourceBinding,
    electronRuntime,
    notarization,
  };
}

async function collectReleaseEvidence(appPath, options = {}) {
  const createSnapshot = options.createAppSnapshot || createPrivateAppSnapshot;
  let snapshot;
  try {
    snapshot = createSnapshot(appPath, {
      copyRunner: options.snapshotCommandRunner,
      temporaryParent: options.snapshotTemporaryParent,
    });
  } catch (error) {
    if (error && error.isVerificationError === true) throw error;
    throw createVerificationError('Unable to create a stable app verification snapshot.', 2);
  }
  if (!snapshot || !snapshot.appPath || typeof snapshot.isStable !== 'function' ||
      typeof snapshot.cleanup !== 'function') {
    throw createVerificationError('Unable to create a stable app verification snapshot.', 2);
  }

  let evidence = null;
  let verificationError = null;
  try {
    evidence = await collectReleaseEvidenceFromSnapshot(snapshot.appPath, options);
    evidence.artifactPath = path.resolve(appPath);
    evidence.artifactStable = evidence.artifactStable === true && snapshot.isStable();
  } catch (error) {
    verificationError = error;
  }
  const cleanupComplete = snapshot.cleanup();
  if (!cleanupComplete) {
    throw createVerificationError('Unable to remove the app verification snapshot.', 2);
  }
  if (verificationError) throw verificationError;
  return evidence;
}

function parseCliArguments(argv) {
  const parsed = {
    appPath: null,
    canvasPrebuild: null,
    electronArchive: null,
    expectedAppId: null,
    expectedExecutableName: null,
    expectedRevision: null,
    json: false,
    requireNotarization: true,
    sourceRoot: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--allow-unnotarized') {
      parsed.requireNotarization = false;
      continue;
    }
    if (argument === '--json') {
      parsed.json = true;
      continue;
    }
    if (argument === '--expected-app-id') {
      const appId = argv[index + 1];
      if (!appId || !/^[A-Za-z0-9.-]+$/u.test(appId)) {
        throw createVerificationError('Expected app identifier is missing or invalid.', 2);
      }
      parsed.expectedAppId = appId;
      index += 1;
      continue;
    }
    if (argument === '--expected-executable-name') {
      const executableName = argv[index + 1];
      if (!isSafeExecutableName(executableName)) {
        throw createVerificationError('Expected executable name is missing or invalid.', 2);
      }
      parsed.expectedExecutableName = executableName;
      index += 1;
      continue;
    }
    if (argument === '--electron-archive') {
      const electronArchive = argv[index + 1];
      if (!electronArchive || !path.isAbsolute(electronArchive)) {
        throw createVerificationError('Electron proof archive must be an absolute path.', 2);
      }
      parsed.electronArchive = path.resolve(electronArchive);
      index += 1;
      continue;
    }
    if (argument === '--canvas-prebuild') {
      const canvasPrebuild = argv[index + 1];
      if (!canvasPrebuild || !path.isAbsolute(canvasPrebuild)) {
        throw createVerificationError('Canvas proof archive must be an absolute path.', 2);
      }
      parsed.canvasPrebuild = path.resolve(canvasPrebuild);
      index += 1;
      continue;
    }
    if (argument === '--expected-revision') {
      const revision = String(argv[index + 1] || '').toLowerCase();
      if (!/^[a-f0-9]{40}$/u.test(revision)) {
        throw createVerificationError('Expected release revision is missing or invalid.', 2);
      }
      parsed.expectedRevision = revision;
      index += 1;
      continue;
    }
    if (argument === '--source-root') {
      const sourceRoot = argv[index + 1];
      if (!sourceRoot || !path.isAbsolute(sourceRoot)) {
        throw createVerificationError('Release proof source root must be an absolute path.', 2);
      }
      parsed.sourceRoot = path.resolve(sourceRoot);
      index += 1;
      continue;
    }
    if (argument.startsWith('--')) throw createVerificationError('Unknown verifier option.', 2);
    if (parsed.appPath) throw createVerificationError('Only one app bundle may be verified at a time.', 2);
    parsed.appPath = argument;
  }

  if (!parsed.appPath) throw createVerificationError('An app bundle path is required.', 2);
  if (parsed.expectedAppId && parsed.requireNotarization) {
    throw createVerificationError(
      'Expected app identifier overrides are restricted to contained QA.',
      2
    );
  }
  if (parsed.expectedAppId && !parsed.expectedExecutableName) {
    throw createVerificationError(
      'Contained QA app identifier overrides require an explicit executable name.',
      2
    );
  }
  if (!parsed.expectedAppId && parsed.expectedExecutableName) {
    throw createVerificationError(
      'Executable name overrides are restricted to contained QA.',
      2
    );
  }
  if (!parsed.electronArchive) {
    throw createVerificationError('An authenticated Electron proof archive is required.', 2);
  }
  if (!parsed.canvasPrebuild) {
    throw createVerificationError('An authenticated Canvas proof archive is required.', 2);
  }
  if (parsed.requireNotarization && !parsed.expectedRevision) {
    throw createVerificationError('Public release verification requires an approved commit revision.', 2);
  }
  if (!parsed.sourceRoot) {
    throw createVerificationError('A release proof source root is required.', 2);
  }
  if (parsed.requireNotarization && parsed.sourceRoot === path.resolve(__dirname, '..')) {
    throw createVerificationError('Public release proof must use a separate source reconstruction.', 2);
  }
  return parsed;
}

function safeCliErrorMessage(error) {
  return error && error.isVerificationError === true
    ? error.message
    : 'Crate signed-app policy failed.';
}

async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const writeOutput = dependencies.writeOutput || (message => console.log(message));
  const writeError = dependencies.writeError || (message => console.error(message));
  let exitCode = 0;
  let result = null;
  try {
    const cli = (dependencies.parseArguments || parseCliArguments)(argv);
    const expectedAppId = cli.expectedAppId || PUBLIC_APP_ID;
    const expectedExecutableName = cli.expectedExecutableName || packageJson.productName;
    const evidence = await (dependencies.collectEvidence || collectReleaseEvidence)(cli.appPath, {
      asar: dependencies.asar,
      canvasPrebuild: cli.canvasPrebuild,
      electronArchive: cli.electronArchive,
      expectedAppId,
      expectedExecutableName,
      expectedRevision: cli.expectedRevision,
      getFuseWire: dependencies.getFuseWire,
      requireNotarization: cli.requireNotarization,
      sourceRoot: cli.sourceRoot || undefined,
    });
    result = (dependencies.evaluateEvidence || evaluateReleaseEvidence)(evidence, {
      expectedAppId,
      expectedExecutableName,
      expectedTeamId: (dependencies.teamIdentifier || expectedTeamIdentifier)(),
      expectedVersion: packageJson.version,
      expectedRevision: cli.expectedRevision,
    });

    if (cli.json) {
      writeOutput(JSON.stringify(result.proof, null, 2));
    } else if (result.ok) {
      const mode = cli.requireNotarization ? 'release-ready' : 'contained QA';
      writeOutput(`Crate signed-app policy passed (${mode}; ${result.proof.counts.helperApps} helpers).`);
    }

    if (!result.ok) {
      if (!cli.json) {
        writeError(['Crate signed-app policy failed.', ...result.failures.map(item => `- ${item}`)].join('\n'));
      }
      exitCode = 1;
    }
  } catch (error) {
    writeError(safeCliErrorMessage(error));
    exitCode = Number.isInteger(error && error.exitCode) ? error.exitCode : 1;
  }
  if (typeof dependencies.setExitCode === 'function') dependencies.setExitCode(exitCode);
  else if (exitCode !== 0) process.exitCode = exitCode;
  return { exitCode, result };
}

if (require.main === module) {
  console.error('Crate signed-app policy failed.');
  process.exitCode = 2;
}

module.exports = {
  APPROVED_CANVAS_PREBUILD_ENTRIES,
  EXPECTED_ARCHITECTURE,
  EXTERNAL_SOURCE_BOUND_ENTRIES,
  EXPECTED_FUSES,
  EXPECTED_FUSE_INDICES,
  EXPECTED_FUSE_VERSION,
  EXPECTED_HELPER_ENTITLEMENTS,
  EXPECTED_HELPER_INFO_KEYS,
  EXPECTED_MAIN_INFO_KEYS,
  EXPECTED_MAIN_ENTITLEMENTS,
  EXPECTED_NESTED_BUNDLE_NAMES,
  EXPECTED_PRIVACY_USAGE_KEYS,
  PUBLIC_APP_ID,
  PUBLIC_TEAM_ID,
  SAFE_GIT_ARGUMENT_PREFIX,
  SOURCE_BOUND_ENTRIES,
  authenticateVerifierToolchain,
  collectElectronRuntimeEvidence,
  collectReachableProductionLockPaths,
  collectReachableVerifierToolLockPaths,
  collectSourceBinding,
  collectReleaseEvidence,
  createPrivateAppSnapshot,
  dependencyPackageInventoriesMatch,
  evaluateReleaseEvidence,
  expectedTeamIdentifier,
  installedPackageMatchesLockArchive,
  packagePayloadMatches,
  rootLockMatchesSourceManifest,
  electronRuntimePayloadMatches,
  inspectFuseWire,
  inspectAppArchitectures,
  inspectBundleLayout,
  npmCacheContentPath,
  normalizeFuseWire,
  parseCliArguments,
  parseCodeSignatureMetadata,
  runCli,
  safeCliErrorMessage,
  verifierSourceMatchesExpectedRevision,
};
