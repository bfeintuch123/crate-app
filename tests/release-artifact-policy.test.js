'use strict';

const assert = require('./bounded-assert');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const debug = require('debug');

const {
  APPROVED_CANVAS_PREBUILD,
} = require('../scripts/install-approved-canvas-prebuild');

const afterPack = require('../scripts/patch-helper-info-plists');
const {
  NOTARYTOOL_KEYCHAIN_PROFILE,
  notarizing,
} = require('../scripts/notarize');
const packageJson = require('../package.json');
const {
  APPROVED_CANVAS_PREBUILD_ENTRIES,
  EXTERNAL_SOURCE_BOUND_ENTRIES,
  EXPECTED_ARCHITECTURE,
  EXPECTED_FUSES,
  EXPECTED_HELPER_ENTITLEMENTS,
  EXPECTED_HELPER_INFO_KEYS,
  EXPECTED_MAIN_INFO_KEYS,
  EXPECTED_MAIN_ENTITLEMENTS,
  EXPECTED_NATIVE_HELPER_REQUIREMENT,
  EXPECTED_PRIVACY_USAGE_KEYS,
  NATIVE_HELPER_IDENTIFIER,
  NATIVE_HELPER_SOURCE_DIR,
  NATIVE_HELPER_SOURCE_FILES,
  NATIVE_HELPER_SWIFTC_ARGS,
  PUBLIC_APP_ID,
  PUBLIC_TEAM_ID,
  SAFE_GIT_ARGUMENT_PREFIX,
  SOURCE_BOUND_ENTRIES,
  authenticateVerifierToolchain,
  canonicalNativeDigestFromBytes,
  collectElectronRuntimeEvidence,
  collectNativeHelperEvidence,
  compileNativeHelper,
  collectReachableProductionLockPaths,
  collectReachableVerifierToolLockPaths,
  collectReleaseEvidence,
  collectSourceBinding,
  createPrivateAppSnapshot,
  dependencyPackageInventoriesMatch,
  electronRuntimePayloadMatches,
  evaluateReleaseEvidence,
  expectedTeamIdentifier,
  installedPackageMatchesLockArchive,
  inspectAppArchitectures,
  inspectBundleLayout,
  nativeHelperDeveloperIdRequirement,
  npmCacheContentPath,
  parseCliArguments,
  parseCodeSignatureMetadata,
  packagePayloadMatches,
  packagedManifestMatchesSource,
  runCli,
  safeCliErrorMessage,
  trimRemovedSignaturePadding,
  verifyAsarFileIntegrity,
  verifierSourceMatchesExpectedRevision,
} = require('../scripts/verify-macos-release-app');
const {
  AUTHENTICATED_SOURCE_FILES,
  runBootstrap,
  sourceFilesMatchRevision,
} = require('../scripts/run-macos-release-proof');
const { verifyPackagedAppContents } = require('../scripts/verify-app-contents');

const ROOT = path.join(__dirname, '..');
const SAFE_INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
const REVIEWED_FUSES = Object.freeze({
  RunAsNode: false,
  EnableCookieEncryption: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  LoadBrowserProcessSpecificV8Snapshot: false,
  GrantFileProtocolExtraPrivileges: true,
  WasmTrapHandlers: true,
});
const REVIEWED_MAIN_ENTITLEMENTS = Object.freeze([
  'com.apple.security.automation.apple-events',
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation',
]);
const REVIEWED_HELPER_ENTITLEMENTS = Object.freeze([
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation',
]);
const REVIEWED_PRIVACY_USAGE_KEYS = Object.freeze(['NSAppleEventsUsageDescription']);
const REVIEWED_MAIN_INFO_KEYS = Object.freeze([
  'CFBundleDisplayName',
  'CFBundleExecutable',
  'CFBundleIconFile',
  'CFBundleIdentifier',
  'CFBundleInfoDictionaryVersion',
  'CFBundleName',
  'CFBundlePackageType',
  'CFBundleShortVersionString',
  'CFBundleURLTypes',
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
const REVIEWED_HELPER_INFO_KEYS = Object.freeze([
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
const REVIEWED_SOURCE_BOUND_ENTRIES = Object.freeze([
  'main.js',
  'startup-phase-journal.js',
  'runtime-identity.json',
  'account-config.json',
  'account-config.js',
  'account-credential-store.js',
  'account-provider.js',
  'account-session.js',
  'preload.js',
  'provenance.js',
  'diagnostic-summary.js',
  'renderer/app.js',
  'renderer/index.html',
  'renderer/styles.css',
  'assets/tray-icon.png',
  'parsers/admission-budgets.js',
  'parsers/adobe-push-bridge.js',
  'parsers/aftereffects.js',
  'parsers/ai.js',
  'parsers/add-files-operation.js',
  'parsers/add-files-regex-worker.js',
  'parsers/add-files-psd-worker.js',
  'parsers/base.js',
  'parsers/figma-credential-store.js',
  'parsers/figma-network.js',
  'parsers/figma-redaction.js',
  'parsers/figma.js',
  'parsers/font-handoff.js',
  'parsers/font-release-catalog.js',
  'parsers/indesign.js',
  'parsers/index.js',
  'parsers/ipc-delta-bridge.js',
  'parsers/linked-asset-matcher.js',
  'parsers/native-helper.js',
  'parsers/native-watcher-bridge.js',
  'parsers/ooxml-links.js',
  'parsers/xml-path.js',
  'parsers/package-safety.js',
  'parsers/package-transaction-worker.js',
  'parsers/powerpoint.js',
  'parsers/premiere.js',
  'parsers/project-state-machine.js',
  'parsers/psd.js',
  'parsers/sqlite-store.js',
  'parsers/working-source-recovery-core.js',
  'parsers/working-source-witness.js',
  'parsers/zip-reader.js',
]);
const REVIEWED_EXTERNAL_SOURCE_BOUND_ENTRIES = Object.freeze([
  Object.freeze({
    artifact: 'Contents/Resources/icon.icns',
    source: 'assets/icon.icns',
  }),
]);
const REVIEWED_CANVAS_PREBUILD_OUTPUTS = Object.freeze([
  'build/Release/canvas.node',
  'build/Release/libX11.6.dylib',
  'build/Release/libXau.6.dylib',
  'build/Release/libXdmcp.6.dylib',
  'build/Release/libXext.6.dylib',
  'build/Release/libXrender.1.dylib',
  'build/Release/libcairo-gobject.2.dylib',
  'build/Release/libcairo.2.dylib',
  'build/Release/libfontconfig.1.dylib',
  'build/Release/libfreetype.6.dylib',
  'build/Release/libfribidi.0.dylib',
  'build/Release/libgdk_pixbuf-2.0.0.dylib',
  'build/Release/libgif.7.2.0.dylib',
  'build/Release/libgio-2.0.0.dylib',
  'build/Release/libglib-2.0.0.dylib',
  'build/Release/libgmodule-2.0.0.dylib',
  'build/Release/libgobject-2.0.0.dylib',
  'build/Release/libgraphite2.3.2.1.dylib',
  'build/Release/libharfbuzz.0.dylib',
  'build/Release/libintl.8.dylib',
  'build/Release/libjpeg.8.3.2.dylib',
  'build/Release/libpango-1.0.0.dylib',
  'build/Release/libpangocairo-1.0.0.dylib',
  'build/Release/libpangoft2-1.0.0.dylib',
  'build/Release/libpcre2-8.0.dylib',
  'build/Release/libpixman-1.0.dylib',
  'build/Release/libpng16.16.dylib',
  'build/Release/librsvg-2.2.dylib',
  'build/Release/libxcb-render.0.0.0.dylib',
  'build/Release/libxcb-shm.0.0.0.dylib',
  'build/Release/libxcb.1.1.0.dylib',
]);
const REVIEWED_CANVAS_PREBUILD_METADATA = Object.freeze([
  'build/Makefile',
  'build/binding.Makefile',
  'build/canvas.target.mk',
  'build/config.gypi',
  'build/gyp-mac-tool',
]);

function workflowRunsByStepName(workflow) {
  const runs = new Map();
  let currentStepName = null;
  for (const line of String(workflow).split(/\r?\n/u)) {
    const nameMatch = line.match(/^\s*-\s+name:\s+(.+?)\s*$/u);
    if (nameMatch) {
      currentStepName = nameMatch[1];
      continue;
    }
    const runMatch = line.match(/^\s+run:\s+([^|>].*?)\s*$/u);
    if (!runMatch || !currentStepName) continue;
    const existing = runs.get(currentStepName) || [];
    existing.push(runMatch[1]);
    runs.set(currentStepName, existing);
  }
  return runs;
}

function workflowStepBlock(workflow, stepName) {
  const lines = String(workflow).split(/\r?\n/u);
  const start = lines.findIndex(line => line.match(/^\s*-\s+name:\s+(.+?)\s*$/u)?.[1] === stepName);
  if (start === -1) return '';
  const indent = lines[start].match(/^(\s*)/u)[1].length;
  let end = start + 1;
  while (end < lines.length) {
    const match = lines[end].match(/^(\s*)-\s+name:/u);
    if (match && match[1].length === indent) break;
    end += 1;
  }
  return lines.slice(start, end).join('\n');
}

function gitBlobOid(value) {
  const bytes = Buffer.from(value || '');
  return crypto.createHash('sha1')
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

function normalizeFixtureGitArgs(originalArgs) {
  return originalArgs.slice(0, SAFE_GIT_ARGUMENT_PREFIX.length)
    .every((value, index) => value === SAFE_GIT_ARGUMENT_PREFIX[index])
    ? originalArgs.slice(SAFE_GIT_ARGUMENT_PREFIX.length)
    : originalArgs;
}

function createFixtureGitRunner(sourceRoot, revision = 'b'.repeat(40), options = {}) {
  const canonicalRoot = fs.realpathSync(sourceRoot);
  return (_command, originalArgs, commandOptions = {}) => {
    const args = normalizeFixtureGitArgs(originalArgs);
    if (args[0] === 'replace' && args[1] === '-l') {
      return { ok: true, stdout: options.replacements || '', stderr: '' };
    }
    if (args[0] === 'rev-parse' && args[1] === '--git-path' && args[2] === 'info/grafts') {
      return {
        ok: true,
        stdout: `${path.join(canonicalRoot, '.git', 'info', 'grafts')}\n`,
        stderr: '',
      };
    }
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { ok: true, stdout: `${options.topLevel || canonicalRoot}\n`, stderr: '' };
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD^{commit}') {
      return { ok: true, stdout: `${revision}\n`, stderr: '' };
    }
    if (args[0] === 'status') {
      return { ok: true, stdout: options.status || '', stderr: '' };
    }
    if (args[0] === 'ls-tree' && args[1] === '--name-only') {
      const directory = args[args.length - 1].replace(/\/$/u, '');
      const names = fs.readdirSync(path.join(canonicalRoot, ...directory.split('/')))
        .filter(name => !(options.omittedTreeNames || []).includes(name))
        .concat(options.extraTreeNames || [])
        .sort();
      return {
        ok: true,
        stdout: names.map(name => `${directory}/${name}\n`).join(''),
        stderr: '',
      };
    }
    if (args[0] === 'ls-tree') {
      const entry = args[args.length - 1];
      const committedBytes = options.committedBytes && options.committedBytes[entry];
      const bytes = committedBytes || fs.readFileSync(path.join(canonicalRoot, ...entry.split('/')));
      const mode = options.symlinkEntry === entry
        ? '120000'
        : options.executableEntry === entry ? '100755' : '100644';
      return {
        ok: true,
        stdout: `${mode} blob ${gitBlobOid(bytes)}\t${entry}\n`,
        stderr: '',
      };
    }
    if (args[0] === 'hash-object' && args[1] === '--stdin') {
      return { ok: true, stdout: `${gitBlobOid(commandOptions.input)}\n`, stderr: '' };
    }
    if (args[0] === 'show' && String(args[1] || '').startsWith(`${revision}:`)) {
      const entry = args[1].slice(`${revision}:`.length);
      return {
        ok: true,
        stdout: fs.readFileSync(path.join(canonicalRoot, ...entry.split('/')), 'utf8'),
        stderr: '',
      };
    }
    return { ok: false, stdout: '', stderr: '' };
  };
}

function createFakeAsar(files, headerString = 'fixture-asar-header') {
  const integrityFor = value => {
    const bytes = Buffer.from(value);
    const blockSize = 4 * 1024 * 1024;
    return {
      algorithm: 'SHA256',
      hash: crypto.createHash('sha256').update(bytes).digest('hex'),
      blockSize,
      blocks: [
        crypto.createHash('sha256').update(bytes).digest('hex'),
      ],
    };
  };
  return {
    extractFile(_asarPath, entry) {
      const normalized = String(entry).replace(/^\/+/, '');
      if (!files.has(normalized)) throw new Error('Fixture entry is missing.');
      return Buffer.from(files.get(normalized));
    },
    getRawHeader() {
      return { headerString };
    },
    listPackage() {
      return [...files.keys()].sort().map(entry => `/${entry}`);
    },
    statFile(_asarPath, entry) {
      const normalized = String(entry).replace(/^\/+/, '');
      if (!files.has(normalized)) throw new Error('Fixture entry is missing.');
      return {
        size: Buffer.byteLength(files.get(normalized)),
        integrity: integrityFor(files.get(normalized)),
      };
    },
  };
}

function createVerifierToolFixture() {
  const sourceRoot = fs.mkdtempSync('/tmp/crate-verifier-tools-');
  const packages = {
    'app-builder-lib': {
      dependencies: {
        '@electron/asar': '3.4.1',
        '@electron/fuses': '1.8.0',
      },
      version: '1.0.0',
    },
    '@electron/asar': {
      dependencies: { commander: '5.0.0' },
      version: '3.4.1',
    },
    '@electron/fuses': {
      dependencies: { chalk: '4.1.2' },
      version: '1.8.0',
    },
    chalk: { version: '4.1.2' },
    commander: { version: '5.0.0' },
    'electron-builder': {
      dependencies: { 'app-builder-lib': '1.0.0' },
      version: '26.8.1',
    },
  };
  const manifest = {
    name: 'verifier-fixture',
    version: '1.0.0',
    devDependencies: { 'electron-builder': '26.8.1' },
  };
  const lockfile = {
    lockfileVersion: 3,
    packages: {
      '': {
        name: manifest.name,
        version: manifest.version,
        devDependencies: manifest.devDependencies,
      },
    },
  };
  for (const [name, packageMetadata] of Object.entries(packages)) {
    const lockPath = `node_modules/${name}`;
    lockfile.packages[lockPath] = {
      ...packageMetadata,
      dev: true,
      integrity: SAFE_INTEGRITY,
      resolved: `https://registry.npmjs.org/${name}/-/${name.replace('/', '-')}-${packageMetadata.version}.tgz`,
    };
    if (name === 'electron-builder' || name === 'app-builder-lib') continue;
    const packageRoot = path.join(sourceRoot, ...lockPath.split('/'));
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
      ...(packageMetadata.dependencies ? { dependencies: packageMetadata.dependencies } : {}),
      name,
      version: packageMetadata.version,
    }));
    fs.writeFileSync(path.join(packageRoot, 'index.js'), `module.exports = ${JSON.stringify(name)};\n`);
  }
  fs.writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(sourceRoot, 'package-lock.json'), JSON.stringify(lockfile));
  return { lockfile, manifest, sourceRoot };
}

test('release policy allowlists match the independent reviewed snapshot', () => {
  assert.deepEqual(EXPECTED_FUSES, REVIEWED_FUSES);
  assert.deepEqual(EXPECTED_MAIN_ENTITLEMENTS, REVIEWED_MAIN_ENTITLEMENTS);
  assert.deepEqual(EXPECTED_HELPER_ENTITLEMENTS, REVIEWED_HELPER_ENTITLEMENTS);
  assert.deepEqual(EXPECTED_MAIN_INFO_KEYS, REVIEWED_MAIN_INFO_KEYS);
  assert.deepEqual(EXPECTED_HELPER_INFO_KEYS, REVIEWED_HELPER_INFO_KEYS);
  assert.deepEqual(EXPECTED_PRIVACY_USAGE_KEYS, REVIEWED_PRIVACY_USAGE_KEYS);
  assert.deepEqual(SOURCE_BOUND_ENTRIES, REVIEWED_SOURCE_BOUND_ENTRIES);
  assert.deepEqual(EXTERNAL_SOURCE_BOUND_ENTRIES, REVIEWED_EXTERNAL_SOURCE_BOUND_ENTRIES);
  assert.deepEqual(
    [...APPROVED_CANVAS_PREBUILD_ENTRIES].sort(),
    [...REVIEWED_CANVAS_PREBUILD_OUTPUTS, ...REVIEWED_CANVAS_PREBUILD_METADATA].sort()
  );
});

test('package transaction worker preserves the disabled RunAsNode boundary', () => {
  const mainSource = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const workerSource = fs.readFileSync(
    path.join(ROOT, 'parsers', 'package-transaction-worker.js'),
    'utf8'
  );

  assert.equal(packageJson.build.electronFuses.runAsNode, false);
  assert.equal(mainSource.includes('ELECTRON_RUN_AS_NODE'), false);
  assert.match(mainSource, /utilityProcess\.fork\(PACKAGE_TRANSACTION_WORKER_PATH/gu);
  assert.doesNotMatch(workerSource, /child_process|execFile|spawn|ELECTRON_RUN_AS_NODE/gu);
});

test('packaged manifest policy accepts exact source overrides', () => {
  const packagedManifest = {
    dependencies: packageJson.dependencies,
    description: packageJson.description,
    main: packageJson.main,
    name: packageJson.name,
    overrides: packageJson.overrides,
    productName: packageJson.productName,
    version: packageJson.version,
  };

  assert.equal(packagedManifestMatchesSource(packageJson, packagedManifest), true);
});

test('packaged manifest policy rejects override drift', () => {
  const packagedManifest = {
    dependencies: packageJson.dependencies,
    description: packageJson.description,
    main: packageJson.main,
    name: packageJson.name,
    overrides: {
      ...packageJson.overrides,
      minimatch: '0.0.0',
    },
    productName: packageJson.productName,
    version: packageJson.version,
  };

  assert.equal(packagedManifestMatchesSource(packageJson, packagedManifest), false);
});

function safeNestedSignature(identifier) {
  return {
    valid: true,
    identifier,
    teamIdentifier: 'YY7WDMUFWJ',
    codeDirectoryHash: 'd'.repeat(64),
    authorities: ['Developer ID Application: Private Signer Name (YY7WDMUFWJ)'],
    hardenedRuntime: true,
    timestamped: true,
  };
}

function safeBuildMetadata() {
  return {
    DTCompiler: 'com.apple.compilers.llvm.clang.1_0',
    DTSDKBuild: '24F74',
    DTSDKName: 'macosx15.5',
    DTXcode: '1640',
    DTXcodeBuild: '16F6',
  };
}

function safeMainInfo(version = packageJson.version, executableName = 'Crate', appId = PUBLIC_APP_ID) {
  return {
    ...safeBuildMetadata(),
    CFBundleDisplayName: executableName,
    CFBundleExecutable: executableName,
    CFBundleIconFile: 'icon.icns',
    CFBundleIdentifier: appId,
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleName: executableName,
    CFBundleURLTypes: [{ CFBundleURLName: 'Crate account sign-in', CFBundleTypeRole: 'Editor', CFBundleURLSchemes: ['com.get-crate.app'] }],
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
    ElectronAsarIntegrity: {
      'Resources/app.asar': {
        algorithm: 'SHA256',
        hash: 'a'.repeat(64),
      },
    },
    LSApplicationCategoryType: 'public.app-category.productivity',
    LSEnvironment: { MallocNanoZone: '0' },
    LSMinimumSystemVersion: '12.0',
    NSAppTransportSecurity: { NSAllowsArbitraryLoads: false },
    NSAppleEventsUsageDescription: afterPack.APPLE_EVENTS_USAGE_DESCRIPTION,
    NSHighResolutionCapable: true,
    NSHumanReadableCopyright: `Copyright \u00a9 2026 ${executableName}`,
    NSMainNibFile: 'MainMenu',
    NSPrefersDisplaySafeAreaCompatibilityMode: false,
    NSPrincipalClass: 'AtomApplication',
    NSQuitAlwaysKeepsWindows: false,
    NSRequiresAquaSystemAppearance: false,
    NSSupportsAutomaticGraphicsSwitching: true,
  };
}

function safeHelperInfo(name, version = packageJson.version, appId = PUBLIC_APP_ID) {
  const helperExecutable = name.slice(0, -'.app'.length);
  const suffix = name.match(/ Helper(?: \((GPU|Plugin|Renderer)\))?\.app$/u);
  const identifierSuffix = suffix && suffix[1] ? `.${suffix[1]}` : '';
  const helperRoleName = suffix && suffix[1] ? ` (${suffix[1]})` : '';
  return {
    ...safeBuildMetadata(),
    CFBundleDisplayName: helperExecutable,
    CFBundleExecutable: helperExecutable,
    CFBundleIdentifier: `${appId}.helper${identifierSuffix}`,
    CFBundleName: `Electron Helper${helperRoleName}`,
    CFBundlePackageType: 'APPL',
    CFBundleVersion: version,
    LSEnvironment: { MallocNanoZone: '0' },
    LSUIElement: true,
    NSAppleEventsUsageDescription: afterPack.APPLE_EVENTS_USAGE_DESCRIPTION,
    NSSupportsAutomaticGraphicsSwitching: true,
  };
}

function safeHelper(name, version = packageJson.version) {
  const suffix = name.match(/ Helper(?: \((GPU|Plugin|Renderer)\))?\.app$/u);
  const identifierSuffix = suffix && suffix[1] ? `.${suffix[1]}` : '';
  return {
    name,
    infoPlist: safeHelperInfo(name, version),
    signature: safeNestedSignature(`com.crate.app.helper${identifierSuffix}`),
    entitlements: Object.fromEntries(EXPECTED_HELPER_ENTITLEMENTS.map(key => [key, true])),
    usageDescription: afterPack.APPLE_EVENTS_USAGE_DESCRIPTION,
    privacyUsageKeys: [...EXPECTED_PRIVACY_USAGE_KEYS],
  };
}

function safeNestedBundle(name) {
  const identifiers = {
    'Electron Framework.framework': 'com.github.Electron.framework',
    'Mantle.framework': 'com.electron.mantle',
    'ReactiveObjC.framework': 'com.electron.reactive',
    'Squirrel.framework': 'com.github.Squirrel',
  };
  return {
    name,
    signature: safeNestedSignature(identifiers[name]),
    entitlements: {},
  };
}

// Synthetic header bytes only; never executed.
function syntheticNativeHelperBytes(marker = 'packaged') {
  const bytes = Buffer.alloc(96, 0);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(0, 8);
  bytes.writeUInt32LE(2, 12);
  Buffer.from(marker, 'utf8').copy(bytes, 32);
  return bytes;
}

function writeNativeHelperResource(resourcesPath, bytes = syntheticNativeHelperBytes(), mode = 0o755) {
  const helperPath = path.join(resourcesPath, 'native', 'crate-helper');
  fs.mkdirSync(path.dirname(helperPath), { recursive: true });
  fs.writeFileSync(helperPath, bytes);
  fs.chmodSync(helperPath, mode);
  return helperPath;
}

function safeNativeHelper() {
  return {
    resourceValid: true,
    signature: safeNestedSignature('crate-helper'),
    strictRequirementValid: true,
    entitlements: Object.fromEntries(EXPECTED_HELPER_ENTITLEMENTS.map(key => [key, true])),
    sourceBound: true,
  };
}

function safeEvidence(version = packageJson.version) {
  return {
    artifactPath: '/Users/example/private-builds/Crate.app',
    artifactStable: true,
    signature: {
      valid: true,
      identifier: 'com.crate.app',
      teamIdentifier: 'YY7WDMUFWJ',
      codeDirectoryHash: 'c'.repeat(64),
      authorities: [
        'Developer ID Application: Private Signer Name (YY7WDMUFWJ)',
        'Developer ID Certification Authority',
        'Apple Root CA',
      ],
      hardenedRuntime: true,
      timestamped: true,
    },
    architecture: {
      valid: true,
      expected: EXPECTED_ARCHITECTURE,
      main: [EXPECTED_ARCHITECTURE],
      machOBinaryCount: 12,
    },
    infoPlist: safeMainInfo(version),
    asarIntegrityHash: 'a'.repeat(64),
    asarFileIntegrity: {
      valid: true,
      checkedFileCount: 2862,
      failedFileCount: 0,
    },
    fuseVersion: '1',
    fuseIndices: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    fuses: { ...EXPECTED_FUSES },
    mainEntitlements: Object.fromEntries(EXPECTED_MAIN_ENTITLEMENTS.map(key => [key, true])),
    helpers: [
      safeHelper('Crate Helper.app', version),
      safeHelper('Crate Helper (GPU).app', version),
      safeHelper('Crate Helper (Plugin).app', version),
      safeHelper('Crate Helper (Renderer).app', version),
    ],
    nestedBundles: [
      safeNestedBundle('Electron Framework.framework'),
      safeNestedBundle('Mantle.framework'),
      safeNestedBundle('ReactiveObjC.framework'),
      safeNestedBundle('Squirrel.framework'),
    ],
    packagedContents: {
      asarEntryCount: 2862,
      unpackedEntryCount: 1767,
    },
    sourceBinding: {
      matches: true,
      manifestMatches: true,
      dependencyLockMatches: true,
      releaseSourceClean: true,
      revision: 'b'.repeat(40),
      entryCount: SOURCE_BOUND_ENTRIES.length + EXTERNAL_SOURCE_BOUND_ENTRIES.length,
    },
    nativeHelper: safeNativeHelper(),
    electronRuntime: {
      valid: true,
      lockedVersion: '42.9.0',
      archiveVerified: true,
      payloadMatches: true,
    },
    notarization: {
      required: true,
      gatekeeperAccepted: true,
      stapleValid: true,
    },
    bundleLayout: { valid: true },
  };
}

function releaseOptions() {
  return {
    expectedAppId: PUBLIC_APP_ID,
    expectedTeamId: PUBLIC_TEAM_ID,
    expectedRevision: 'b'.repeat(40),
  };
}

function signedMetadata(identifier, hashCharacter = 'c') {
  return [
    `Identifier=${identifier}`,
    'CodeDirectory v=20500 flags=0x10000(runtime)',
    'Authority=Developer ID Application: Private Signer Name (YY7WDMUFWJ)',
    `CDHashFull=${hashCharacter.repeat(64)}`,
    'Timestamp=Jul 15, 2026 at 8:05:27 PM',
    'TeamIdentifier=YY7WDMUFWJ',
  ].join('\n');
}

function passThroughAppSnapshot(appPath) {
  return {
    appPath,
    cleanup: () => true,
    isStable: () => true,
  };
}

test('signed release evidence passes only with the complete security policy', () => {
  const result = evaluateReleaseEvidence(safeEvidence(), releaseOptions());

  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.proof.schemaVersion, 1);
  assert.equal(result.proof.checks.notarization, 'pass');
  assert.equal(result.proof.checks.sourceRevision, 'pass');
  assert.equal(result.proof.counts.helperApps, 4);
  assert.equal(result.proof.counts.nestedCodeBundles, 8);
  assert.equal(result.proof.checks.architecture, 'pass');
  assert.equal(result.proof.checks.nativeHelper, 'pass');
  assert.equal(result.proof.counts.machOBinaries, 12);
});

test('release evidence fails closed on signature, identity, runtime, or notarization drift', () => {
  const evidence = safeEvidence();
  evidence.signature.valid = false;
  evidence.signature.identifier = 'com.example.other';
  evidence.signature.teamIdentifier = 'OTHERTEAM1';
  evidence.signature.authorities = ['Apple Development: Local Developer'];
  evidence.signature.hardenedRuntime = false;
  evidence.signature.timestamped = false;
  evidence.notarization.gatekeeperAccepted = false;
  evidence.notarization.stapleValid = false;

  const result = evaluateReleaseEvidence(evidence, releaseOptions());

  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, [
    'Code signature verification failed.',
    'Signed bundle identifier does not match the approved app identifier.',
    'Signing team does not match the approved Crate team.',
    'Developer ID Application signature is missing.',
    'Hardened runtime is not enabled in the final signature.',
    'Secure signing timestamp is missing.',
    'Gatekeeper did not accept the release app.',
    'Notarization staple validation failed.',
  ]);
});

test('release evidence rejects non-arm64 or incomplete architecture proof', () => {
  const evidence = safeEvidence();
  evidence.architecture.main = ['x86_64'];
  evidence.architecture.valid = false;

  const result = evaluateReleaseEvidence(evidence, releaseOptions());
  assert.equal(result.ok, false);
  assert.equal(
    result.failures.includes(
      'Packaged executable architectures do not match the approved arm64 target.'
    ),
    true
  );
  assert.equal(result.proof.checks.architecture, 'fail');
});

test('architecture inspection follows contained framework links and rejects escaping links', () => {
  const fixtureRoot = fs.mkdtempSync('/tmp/crate-architecture-links-');
  const appPath = path.join(fixtureRoot, 'Crate.app');
  const contentsPath = path.join(appPath, 'Contents');
  const executablePath = path.join(contentsPath, 'MacOS', 'Crate');
  const frameworkRoot = path.join(contentsPath, 'Frameworks', 'Example.framework');
  const versionRoot = path.join(frameworkRoot, 'Versions', 'A');
  try {
    fs.mkdirSync(path.dirname(executablePath), { recursive: true });
    fs.mkdirSync(versionRoot, { recursive: true });
    fs.writeFileSync(executablePath, 'main');
    fs.writeFileSync(path.join(versionRoot, 'Example'), 'framework');
    fs.symlinkSync('A', path.join(frameworkRoot, 'Versions', 'Current'));
    fs.symlinkSync('Versions/Current/Example', path.join(frameworkRoot, 'Example'));

    const commandRunner = (command, args) => {
      if (command === '/usr/bin/file') {
        return { ok: true, stdout: 'Mach-O 64-bit bundle arm64\n', stderr: '' };
      }
      if (command === '/usr/bin/lipo' && args[0] === '-archs') {
        return { ok: true, stdout: 'arm64\n', stderr: '' };
      }
      return { ok: false, stdout: '', stderr: '' };
    };

    const contained = inspectAppArchitectures(appPath, executablePath, commandRunner);
    assert.equal(contained.valid, true);
    assert.equal(contained.machOBinaryCount, 2);

    const outsidePath = path.join(fixtureRoot, 'outside-binary');
    fs.writeFileSync(outsidePath, 'outside');
    fs.symlinkSync(outsidePath, path.join(contentsPath, 'Frameworks', 'escape'));
    assert.equal(inspectAppArchitectures(appPath, executablePath, commandRunner).valid, false);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('bundle layout requires the configured executable and exact resource entry types', () => {
  const fixtureRoot = fs.mkdtempSync('/tmp/crate-release-layout-');
  const appPath = path.join(fixtureRoot, 'Crate.app');
  const contentsPath = path.join(appPath, 'Contents');
  try {
    for (const directory of [
      'Frameworks',
      'MacOS',
      'Resources/app.asar.unpacked',
      'Resources/en.lproj',
      '_CodeSignature',
    ]) {
      fs.mkdirSync(path.join(contentsPath, directory), { recursive: true });
    }
    for (const directory of [
      'Crate Helper.app',
      'Crate Helper (GPU).app',
      'Crate Helper (Plugin).app',
      'Crate Helper (Renderer).app',
      ...['Electron Framework.framework', 'Mantle.framework', 'ReactiveObjC.framework', 'Squirrel.framework'],
    ]) {
      fs.mkdirSync(path.join(contentsPath, 'Frameworks', directory));
    }
    for (const file of [
      'CodeResources',
      'Info.plist',
      'MacOS/Crate',
      'Resources/app-update.yml',
      'Resources/app.asar',
      'Resources/icon.icns',
      '_CodeSignature/CodeResources',
    ]) {
      fs.writeFileSync(path.join(contentsPath, file), 'fixture');
    }
    fs.writeFileSync(
      path.join(contentsPath, 'Resources', 'app-update.yml'),
      'owner: bfeintuch123\n' +
      'repo: crate-app\n' +
      'provider: github\n' +
      'updaterCacheDirName: crate-app-updater\n'
    );
    fs.writeFileSync(path.join(contentsPath, 'PkgInfo'), 'APPL????');
    writeNativeHelperResource(path.join(contentsPath, 'Resources'));
    assert.equal(inspectBundleLayout(appPath, 'Crate').valid, true);

    fs.rmSync(path.join(contentsPath, 'CodeResources'));
    assert.equal(inspectBundleLayout(appPath, 'Crate').valid, false);
    fs.mkdirSync(path.join(contentsPath, 'CodeResources'));
    assert.equal(inspectBundleLayout(appPath, 'Crate').valid, false);
    fs.rmSync(path.join(contentsPath, 'CodeResources'), { recursive: true });
    fs.symlinkSync('_CodeSignature/CodeResources', path.join(contentsPath, 'CodeResources'));
    assert.equal(inspectBundleLayout(appPath, 'Crate').valid, false);
    fs.unlinkSync(path.join(contentsPath, 'CodeResources'));
    fs.writeFileSync(path.join(contentsPath, 'CodeResources'), 'fixture');
    fs.writeFileSync(path.join(contentsPath, 'unexpected-ticket'), 'fixture');
    assert.equal(inspectBundleLayout(appPath, 'Crate').valid, false);
    fs.rmSync(path.join(contentsPath, 'unexpected-ticket'));

    const realContentsPath = path.join(appPath, 'Contents-authenticated');
    fs.renameSync(contentsPath, realContentsPath);
    fs.symlinkSync('Contents-authenticated', contentsPath);
    assert.equal(inspectBundleLayout(appPath, 'Crate').valid, false);
    fs.unlinkSync(contentsPath);
    fs.renameSync(realContentsPath, contentsPath);

    fs.rmSync(path.join(contentsPath, 'PkgInfo'));
    fs.mkdirSync(path.join(contentsPath, 'PkgInfo'));
    assert.equal(inspectBundleLayout(appPath, 'Crate').valid, false);
    fs.rmSync(path.join(contentsPath, 'PkgInfo'), { recursive: true });
    fs.writeFileSync(path.join(contentsPath, 'PkgInfo'), 'not-approved');
    assert.equal(inspectBundleLayout(appPath, 'Crate').valid, false);
    fs.writeFileSync(path.join(contentsPath, 'PkgInfo'), 'APPL????');

    fs.rmSync(path.join(contentsPath, 'Resources', 'icon.icns'));
    fs.mkdirSync(path.join(contentsPath, 'Resources', 'icon.icns'));
    assert.equal(inspectBundleLayout(appPath, 'Crate').valid, false);
    fs.rmSync(path.join(contentsPath, 'Resources', 'icon.icns'), { recursive: true });
    fs.writeFileSync(path.join(contentsPath, 'Resources', 'icon.icns'), 'fixture');

    const updateMetadataPath = path.join(contentsPath, 'Resources', 'app-update.yml');
    fs.writeFileSync(updateMetadataPath, 'owner: unapproved\n');
    assert.equal(inspectBundleLayout(appPath, 'Crate').valid, false);
    fs.rmSync(updateMetadataPath);
    assert.equal(inspectBundleLayout(appPath, 'Crate').valid, false);
    fs.mkdirSync(updateMetadataPath);
    assert.equal(inspectBundleLayout(appPath, 'Crate').valid, false);
    fs.rmSync(updateMetadataPath, { recursive: true });
    fs.symlinkSync('icon.icns', updateMetadataPath);
    assert.equal(inspectBundleLayout(appPath, 'Crate').valid, false);
    fs.unlinkSync(updateMetadataPath);
    fs.writeFileSync(
      updateMetadataPath,
      'owner: bfeintuch123\n' +
      'repo: crate-app\n' +
      'provider: github\n' +
      'updaterCacheDirName: crate-app-updater\n'
    );
    const unexpectedResourcePath = path.join(contentsPath, 'Resources', 'unexpected');
    fs.writeFileSync(unexpectedResourcePath, 'fixture');
    assert.equal(inspectBundleLayout(appPath, 'Crate').valid, false);
    fs.rmSync(unexpectedResourcePath);

    const nativePath = path.join(contentsPath, 'Resources', 'native');
    const helperPath = path.join(nativePath, 'crate-helper');
    const resetNative = () => {
      fs.rmSync(nativePath, { recursive: true, force: true });
      writeNativeHelperResource(path.join(contentsPath, 'Resources'));
      assert.equal(inspectBundleLayout(appPath, 'Crate').valid, true);
    };
    const fatHelper = syntheticNativeHelperBytes();
    fatHelper.writeUInt32BE(0xcafebabe, 0);
    const x86Helper = syntheticNativeHelperBytes();
    x86Helper.writeUInt32LE(0x01000007, 4);
    const arm64eHelper = syntheticNativeHelperBytes();
    arm64eHelper.writeUInt32LE(2, 8);
    const dylibHelper = syntheticNativeHelperBytes();
    dylibHelper.writeUInt32LE(6, 12);
    for (const [label, mutate] of [
      ['missing native', () => fs.rmSync(nativePath, { recursive: true })],
      ['missing helper', () => fs.rmSync(helperPath)],
      ['native file', () => {
        fs.rmSync(nativePath, { recursive: true });
        fs.writeFileSync(nativePath, syntheticNativeHelperBytes());
      }],
      ['extra sibling file', () => fs.writeFileSync(path.join(nativePath, 'extra'), 'fixture')],
      ['extra sibling directory', () => fs.mkdirSync(path.join(nativePath, 'extra'))],
      ['Finder metadata sibling', () => fs.writeFileSync(path.join(nativePath, '.DS_Store'), 'fixture')],
      ['symlinked native', () => {
        const realNative = path.join(fixtureRoot, 'real-native');
        fs.renameSync(nativePath, realNative);
        fs.symlinkSync(realNative, nativePath);
      }],
      ['symlinked helper', () => {
        const realHelper = path.join(fixtureRoot, 'real-helper');
        fs.renameSync(helperPath, realHelper);
        fs.symlinkSync(realHelper, helperPath);
      }],
      ['helper directory', () => {
        fs.rmSync(helperPath);
        fs.mkdirSync(helperPath);
      }],
      ['mode 0644', () => fs.chmodSync(helperPath, 0o644)],
      ['mode 04755', () => fs.chmodSync(helperPath, 0o4755)],
      ['x86_64 helper', () => fs.writeFileSync(helperPath, x86Helper)],
      ['fat helper', () => fs.writeFileSync(helperPath, fatHelper)],
      ['arm64e helper', () => fs.writeFileSync(helperPath, arm64eHelper)],
      ['dylib helper', () => fs.writeFileSync(helperPath, dylibHelper)],
      ['script helper', () => fs.writeFileSync(helperPath, '#!/bin/sh\nexit 0\n'.padEnd(64, ' '))],
      ['empty helper', () => fs.writeFileSync(helperPath, '')],
      ['31-byte helper', () => fs.writeFileSync(helperPath, syntheticNativeHelperBytes().subarray(0, 31))],
    ]) {
      mutate();
      assert.equal(inspectBundleLayout(appPath, 'Crate').valid, false, label);
      fs.rmSync(path.join(fixtureRoot, 'real-native'), { recursive: true, force: true });
      fs.rmSync(path.join(fixtureRoot, 'real-helper'), { force: true });
      resetNative();
    }

    assert.equal(inspectBundleLayout(appPath, 'Renamed').valid, false);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

const NATIVE_HELPER_FAILURES = Object.freeze({
  resource: 'Bundled native helper is missing or not approved.',
  signature: 'Bundled native helper signature policy changed.',
  entitlements: 'Bundled native helper entitlements do not match the approved policy.',
  source: 'Bundled native helper does not match the committed Swift sources.',
});

test('release evidence requires the source-bound Developer ID native helper', () => {
  const passing = evaluateReleaseEvidence(safeEvidence(), releaseOptions());
  assert.equal(passing.ok, true);
  assert.equal(passing.proof.checks.nativeHelper, 'pass');

  for (const [label, mutate, expected] of [
    ['resource rejected', helper => { helper.resourceValid = false; }, [NATIVE_HELPER_FAILURES.resource]],
    ['invalid signature', helper => { helper.signature.valid = false; }, [NATIVE_HELPER_FAILURES.signature]],
    ['wrong identifier', helper => { helper.signature.identifier = 'com.crate.app.helper'; }, [NATIVE_HELPER_FAILURES.signature]],
    ['wrong team', helper => { helper.signature.teamIdentifier = 'OTHERTEAM1'; }, [NATIVE_HELPER_FAILURES.signature]],
    ['missing Developer ID authority', helper => {
      helper.signature.authorities = ['Apple Development: Local Developer'];
    }, [NATIVE_HELPER_FAILURES.signature]],
    ['no hardened runtime', helper => { helper.signature.hardenedRuntime = false; }, [NATIVE_HELPER_FAILURES.signature]],
    ['no secure timestamp', helper => { helper.signature.timestamped = false; }, [NATIVE_HELPER_FAILURES.signature]],
    ['missing code fingerprint', helper => { delete helper.signature.codeDirectoryHash; }, [NATIVE_HELPER_FAILURES.signature]],
    ['missing signature', helper => { helper.signature = null; }, [NATIVE_HELPER_FAILURES.signature]],
    ['strict requirement rejected', helper => { helper.strictRequirementValid = false; }, [NATIVE_HELPER_FAILURES.signature]],
    ['strict requirement truthy non-boolean', helper => { helper.strictRequirementValid = 'true'; }, [NATIVE_HELPER_FAILURES.signature]],
    ['missing entitlement', helper => {
      delete helper.entitlements['com.apple.security.cs.allow-jit'];
    }, [NATIVE_HELPER_FAILURES.entitlements]],
    ['extra entitlement', helper => {
      helper.entitlements['com.apple.security.automation.apple-events'] = true;
    }, [NATIVE_HELPER_FAILURES.entitlements]],
    ['false entitlement value', helper => {
      helper.entitlements['com.apple.security.cs.allow-jit'] = false;
    }, [NATIVE_HELPER_FAILURES.entitlements]],
    ['missing entitlements', helper => { helper.entitlements = null; }, [NATIVE_HELPER_FAILURES.entitlements]],
    ['not source bound', helper => { helper.sourceBound = false; }, [NATIVE_HELPER_FAILURES.source]],
    ['source bound truthy non-boolean', helper => { helper.sourceBound = 1; }, [NATIVE_HELPER_FAILURES.source]],
  ]) {
    const evidence = safeEvidence();
    mutate(evidence.nativeHelper);
    const result = evaluateReleaseEvidence(evidence, releaseOptions());
    assert.equal(result.ok, false, label);
    assert.deepEqual(result.failures, expected, label);
    assert.equal(result.proof.checks.nativeHelper, 'fail', label);
    assert.equal(result.proof.releaseReady, false, label);
  }

  for (const [label, value] of [
    ['absent', undefined],
    ['null', null],
    ['string', 'valid'],
    ['array', [safeNativeHelper()]],
  ]) {
    const evidence = safeEvidence();
    if (value === undefined) delete evidence.nativeHelper;
    else evidence.nativeHelper = value;
    const result = evaluateReleaseEvidence(evidence, releaseOptions());
    assert.deepEqual(result.failures, [
      NATIVE_HELPER_FAILURES.resource,
      NATIVE_HELPER_FAILURES.signature,
      NATIVE_HELPER_FAILURES.entitlements,
      NATIVE_HELPER_FAILURES.source,
    ], label);
    assert.equal(result.proof.checks.nativeHelper, 'fail', label);
  }

  const hostile = safeEvidence();
  hostile.nativeHelper.signature.identifier = '/Users/private/native/crate-helper';
  const hostileProof = JSON.stringify(evaluateReleaseEvidence(hostile, releaseOptions()).proof);
  assert.equal(hostileProof.includes('/Users/private'), false);
  assert.equal(hostileProof.includes('Private Signer Name'), false);
});

test('native helper Developer ID requirement pins the identifier, Apple anchor, Developer ID intermediate, and team', () => {
  assert.equal(NATIVE_HELPER_IDENTIFIER, 'crate-helper');
  assert.equal(
    EXPECTED_NATIVE_HELPER_REQUIREMENT,
    'identifier "crate-helper" and anchor apple generic and ' +
      'certificate 1[field.1.2.840.113635.100.6.2.6] exists and ' +
      'certificate leaf[field.1.2.840.113635.100.6.1.13] exists and ' +
      'certificate leaf[subject.OU] = "YY7WDMUFWJ"'
  );
  assert.equal(nativeHelperDeveloperIdRequirement(PUBLIC_TEAM_ID), EXPECTED_NATIVE_HELPER_REQUIREMENT);
  assert.equal(
    nativeHelperDeveloperIdRequirement('ABCDE12345').endsWith('certificate leaf[subject.OU] = "ABCDE12345"'),
    true
  );
  for (const invalid of ['', 'yy7wdmufwj', 'TOO-SHORT', 'YY7WDMUFWJ" or true', null]) {
    assert.equal(nativeHelperDeveloperIdRequirement(invalid), null);
  }
});

function nativeHelperSourceFixture(fixtureRoot) {
  const sourceRoot = path.join(fixtureRoot, 'source');
  const sourceBytes = {};
  for (const name of NATIVE_HELPER_SOURCE_FILES) {
    const sourcePath = path.join(sourceRoot, ...NATIVE_HELPER_SOURCE_DIR.split('/'), name);
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    sourceBytes[name] = Buffer.from(`// synthetic Swift source ${name}\n`);
    fs.writeFileSync(sourcePath, sourceBytes[name]);
  }
  const appPath = path.join(fixtureRoot, 'Crate.app');
  const packagedBytes = syntheticNativeHelperBytes('packaged-helper');
  const helperPath = writeNativeHelperResource(
    path.join(appPath, 'Contents', 'Resources'),
    packagedBytes
  );
  return { appPath, helperPath, packagedBytes, sourceBytes, sourceRoot };
}

function nativeHelperCommandRunner(sourceRoot, gitOptions = {}, behavior = {}) {
  const gitRunner = createFixtureGitRunner(sourceRoot, 'b'.repeat(40), gitOptions);
  const calls = [];
  const runner = (command, args, options = {}) => {
    calls.push({ command, args: [...args] });
    if (command === '/usr/bin/git') return gitRunner(command, args, options);
    if (command === '/usr/bin/codesign' && args[0] === '-dv') {
      return { ok: true, stdout: '', stderr: signedMetadata(NATIVE_HELPER_IDENTIFIER, 'e') };
    }
    if (command === '/usr/bin/codesign' && args.includes('--entitlements')) {
      return {
        ok: true,
        stdout: '<?xml version="1.0"?><plist><dict><key>helper-entitlements</key><true/></dict></plist>',
        stderr: '',
      };
    }
    if (command === '/usr/bin/codesign' && behavior.rejectStrictRequirement &&
        args.includes(`-R=${EXPECTED_NATIVE_HELPER_REQUIREMENT}`)) {
      return { ok: false, stdout: '', stderr: '' };
    }
    if (command === '/usr/bin/codesign' || command === '/usr/bin/strip') {
      return { ok: true, stdout: '', stderr: '' };
    }
    if (command === '/usr/bin/plutil' && options.input) {
      return {
        ok: true,
        stdout: JSON.stringify(Object.fromEntries(EXPECTED_HELPER_ENTITLEMENTS.map(key => [key, true]))),
        stderr: '',
      };
    }
    return { ok: false, stdout: '', stderr: '' };
  };
  return { calls, runner };
}

test('native helper evidence binds packaged bytes to a rebuild of the exact committed Swift blobs', () => {
  const fixtureRoot = fs.mkdtempSync('/tmp/crate-native-evidence-');
  try {
    const fixture = nativeHelperSourceFixture(fixtureRoot);
    const canonicalSourceRoot = fs.realpathSync(fixture.sourceRoot);
    const revision = 'b'.repeat(40);
    const compilerCalls = [];
    const matchingCompiler = (sources, options) => {
      compilerCalls.push({ sources, options });
      return Buffer.from(fixture.packagedBytes);
    };
    const collect = (gitOptions = {}, options = {}, behavior = {}) => {
      const { calls, runner } = nativeHelperCommandRunner(canonicalSourceRoot, gitOptions, behavior);
      const evidence = collectNativeHelperEvidence(
        fixture.appPath,
        canonicalSourceRoot,
        options.revision === undefined ? revision : options.revision,
        runner,
        {
          expectedTeamId: PUBLIC_TEAM_ID,
          nativeHelperCompiler: Object.hasOwn(options, 'compiler') ? options.compiler : matchingCompiler,
        }
      );
      return { calls, evidence, runner };
    };

    const accepted = collect();
    assert.equal(accepted.evidence.resourceValid, true);
    assert.equal(accepted.evidence.strictRequirementValid, true);
    assert.equal(accepted.evidence.sourceBound, true);
    assert.equal(accepted.evidence.signature.valid, true);
    assert.equal(accepted.evidence.signature.identifier, NATIVE_HELPER_IDENTIFIER);
    assert.deepEqual(
      Object.keys(accepted.evidence.entitlements).sort(),
      [...EXPECTED_HELPER_ENTITLEMENTS]
    );
    const acceptedReport = evaluateReleaseEvidence(
      { ...safeEvidence(), nativeHelper: accepted.evidence },
      releaseOptions()
    );
    assert.deepEqual(acceptedReport.failures, []);
    assert.equal(compilerCalls.length, 1);
    assert.deepEqual(Object.keys(compilerCalls[0].sources), [...NATIVE_HELPER_SOURCE_FILES]);
    for (const name of NATIVE_HELPER_SOURCE_FILES) {
      assert.equal(compilerCalls[0].sources[name].equals(fixture.sourceBytes[name]), true);
    }
    assert.equal(compilerCalls[0].options.commandRunner, accepted.runner);
    assert.deepEqual(
      accepted.calls.filter(call => call.args.includes(`-R=${EXPECTED_NATIVE_HELPER_REQUIREMENT}`)),
      [{
        command: '/usr/bin/codesign',
        args: ['--verify', '--strict', '--verbose=4', `-R=${EXPECTED_NATIVE_HELPER_REQUIREMENT}`, fixture.helperPath],
      }]
    );
    const listingCall = accepted.calls.find(call => call.command === '/usr/bin/git' &&
      call.args.includes('--name-only'));
    assert.deepEqual(listingCall.args, [
      ...SAFE_GIT_ARGUMENT_PREFIX,
      'ls-tree',
      '--name-only',
      revision,
      '--',
      `${NATIVE_HELPER_SOURCE_DIR}/`,
    ]);

    const strictRejected = collect({}, {}, { rejectStrictRequirement: true });
    assert.equal(strictRejected.evidence.strictRequirementValid, false);
    assert.equal(strictRejected.evidence.sourceBound, true);

    compilerCalls.length = 0;
    const sourceEntry = `${NATIVE_HELPER_SOURCE_DIR}/main.swift`;
    for (const [label, gitOptions, options] of [
      ['changed source byte', {
        committedBytes: { [sourceEntry]: Buffer.from('// synthetic Swift source main.swifT\n') },
      }, {}],
      ['extra tree entry', { extraTreeNames: ['Extra.swift'] }, {}],
      ['missing tree entry', { omittedTreeNames: ['WatchOps.swift'] }, {}],
      ['symlink tree entry', { symlinkEntry: sourceEntry }, {}],
      ['executable tree entry', { executableEntry: sourceEntry }, {}],
      ['invalid revision', {}, { revision: '' }],
    ]) {
      const result = collect(gitOptions, options);
      assert.equal(result.evidence.resourceValid, true, label);
      assert.equal(result.evidence.sourceBound, false, label);
    }
    assert.equal(compilerCalls.length, 0);

    for (const [label, compiler] of [
      ['null compiler result', () => null],
      ['different rebuilt bytes', () => syntheticNativeHelperBytes('different-helper')],
      ['throwing compiler', () => { throw new Error('synthetic compiler failure'); }],
      ['non-buffer compiler result', () => 'packaged-helper'],
    ]) {
      assert.equal(collect({}, { compiler }).evidence.sourceBound, false, label);
    }

    const extraSourcePath = path.join(canonicalSourceRoot, NATIVE_HELPER_SOURCE_DIR, 'Extra.swift');
    fs.writeFileSync(extraSourcePath, '// synthetic extra source\n');
    assert.equal(collect().evidence.sourceBound, false);
    fs.rmSync(extraSourcePath);

    const sourceDirectory = path.join(canonicalSourceRoot, ...NATIVE_HELPER_SOURCE_DIR.split('/'));
    const realSourceDirectory = path.join(fixtureRoot, 'real-swift-sources');
    fs.renameSync(sourceDirectory, realSourceDirectory);
    fs.symlinkSync(realSourceDirectory, sourceDirectory);
    assert.equal(collect().evidence.sourceBound, false);
    fs.unlinkSync(sourceDirectory);
    fs.renameSync(realSourceDirectory, sourceDirectory);
    assert.equal(collect().evidence.sourceBound, true);

    fs.chmodSync(fixture.helperPath, 0o644);
    const rejectedResource = collect();
    assert.deepEqual(rejectedResource.evidence, {
      resourceValid: false,
      signature: null,
      strictRequirementValid: false,
      entitlements: null,
      sourceBound: false,
    });
    assert.equal(rejectedResource.calls.length, 0);

    const injected = { ...safeNativeHelper(), sourceBound: false };
    const injectedEvidence = collectNativeHelperEvidence(fixture.appPath, canonicalSourceRoot, revision, () => {
      throw new Error('injected evidence must not run commands');
    }, { nativeHelperEvidence: injected });
    assert.deepEqual(injectedEvidence, injected);
    assert.notEqual(injectedEvidence, injected);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('native helper compiler stages exact private sources and accepts only a thin arm64 executable', () => {
  const sources = Object.fromEntries(NATIVE_HELPER_SOURCE_FILES.map(name => [
    name,
    Buffer.from(`// synthetic compiler input ${name}\n`),
  ]));
  const observed = [];
  const runnerWriting = output => (command, args, options) => {
    const outputPath = args[args.length - 1];
    const temporaryRoot = path.dirname(path.dirname(outputPath));
    const sourcePaths = args.slice(NATIVE_HELPER_SWIFTC_ARGS.length, -2);
    observed.push({
      command,
      args: [...args],
      cwd: options && options.cwd,
      temporaryRoot,
      rootMode: fs.lstatSync(temporaryRoot).mode & 0o777,
      outputDirectoryMode: fs.lstatSync(path.dirname(outputPath)).mode & 0o777,
      sources: sourcePaths.map(sourcePath => ({
        name: path.basename(sourcePath),
        parent: path.dirname(sourcePath),
        mode: fs.lstatSync(sourcePath).mode & 0o777,
        bytes: fs.readFileSync(sourcePath),
      })),
    });
    if (output === null) return { ok: false, stdout: '', stderr: '' };
    fs.writeFileSync(outputPath, output);
    return { ok: true, stdout: '', stderr: '' };
  };

  const executable = syntheticNativeHelperBytes('compiled');
  const compiled = compileNativeHelper(sources, { commandRunner: runnerWriting(executable) });
  assert.equal(Buffer.isBuffer(compiled) && compiled.equals(executable), true);
  const [call] = observed;
  assert.equal(call.command, '/usr/bin/swiftc');
  assert.deepEqual(call.args.slice(0, NATIVE_HELPER_SWIFTC_ARGS.length), [...NATIVE_HELPER_SWIFTC_ARGS]);
  assert.deepEqual(call.args.slice(-2), ['-o', path.join(call.temporaryRoot, 'out', 'crate-helper')]);
  assert.equal(call.cwd, call.temporaryRoot);
  assert.equal(call.rootMode, 0o700);
  assert.equal(call.outputDirectoryMode, 0o700);
  assert.deepEqual(call.sources.map(source => source.name), [...NATIVE_HELPER_SOURCE_FILES]);
  for (const source of call.sources) {
    assert.equal(source.parent, call.temporaryRoot);
    assert.equal(source.mode, 0o600);
    assert.equal(source.bytes.equals(sources[source.name]), true);
  }
  assert.equal(fs.existsSync(call.temporaryRoot), false);

  const x86 = syntheticNativeHelperBytes('compiled');
  x86.writeUInt32LE(0x01000007, 4);
  for (const [label, output] of [
    ['failed compiler', null],
    ['x86_64 output', x86],
    ['short output', executable.subarray(0, 31)],
  ]) {
    observed.length = 0;
    assert.equal(compileNativeHelper(sources, { commandRunner: runnerWriting(output) }), null, label);
    assert.equal(observed.length, 1, label);
    assert.equal(fs.existsSync(observed[0].temporaryRoot), false, label);
  }

  const missing = { ...sources };
  delete missing['WatchOps.swift'];
  const extra = { ...sources, 'Extra.swift': Buffer.from('// extra\n') };
  const nonBuffer = { ...sources, 'main.swift': '// string source\n' };
  for (const [label, input] of [
    ['missing source', missing],
    ['extra source', extra],
    ['non-buffer source', nonBuffer],
    ['null input', null],
    ['array input', [...NATIVE_HELPER_SOURCE_FILES]],
  ]) {
    observed.length = 0;
    assert.equal(compileNativeHelper(input, { commandRunner: runnerWriting(executable) }), null, label);
    assert.equal(observed.length, 0, label);
  }
});

test('release evidence binds executable identity and Electron runtime to reviewed inputs', () => {
  const renamed = safeEvidence();
  renamed.infoPlist.CFBundleExecutable = 'Renamed Crate';
  assert.equal(
    evaluateReleaseEvidence(renamed, releaseOptions()).failures.includes(
      'Bundle executable name does not match the approved product configuration.'
    ),
    true
  );

  const substitutedRuntime = safeEvidence();
  substitutedRuntime.electronRuntime.payloadMatches = false;
  substitutedRuntime.electronRuntime.valid = false;
  assert.equal(
    evaluateReleaseEvidence(substitutedRuntime, releaseOptions()).failures.includes(
      'Packaged Electron runtime does not match the authenticated locked distribution.'
    ),
    true
  );
});

test('release evidence rejects permissive transport, permission, and ASAR metadata', () => {
  const evidence = safeEvidence();
  evidence.infoPlist.CFBundleIdentifier = 'com.example.other';
  evidence.infoPlist.NSAppleEventsUsageDescription = '';
  evidence.infoPlist.NSAppTransportSecurity = {
    NSAllowsArbitraryLoads: true,
    NSAllowsLocalNetworking: true,
  };
  evidence.infoPlist.NSCameraUsageDescription = 'Unexpected camera access';
  evidence.infoPlist.NSContactsUsageDescription = 'Unexpected contacts access';
  evidence.infoPlist.ElectronAsarIntegrity['Resources/app.asar'] = {
    algorithm: 'SHA1',
    hash: 'private-artifact-hash',
  };
  evidence.bundleLayout.valid = false;

  const result = evaluateReleaseEvidence(evidence, releaseOptions());

  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, [
    'Final bundle metadata does not match the approved app identifier.',
    'Main app metadata contains unapproved keys or values.',
    'Apple Events purpose text is missing or changed.',
    'App Transport Security is not the approved strict policy.',
    'Privacy permission declarations do not match the approved policy.',
    'Embedded ASAR integrity metadata is missing or invalid.',
    'Final app bundle layout contains unapproved content.',
  ]);
});

test('release evidence rejects unapproved main and helper launch metadata', () => {
  const mainHandler = safeEvidence();
  mainHandler.infoPlist.CFBundleURLTypes = [{ CFBundleURLSchemes: ['crate-unreviewed'] }];
  assert.equal(
    evaluateReleaseEvidence(mainHandler, releaseOptions()).failures.includes(
      'Main app metadata contains unapproved keys or values.'
    ),
    true
  );

  const helperEnvironment = safeEvidence();
  helperEnvironment.helpers[0].infoPlist.LSEnvironment = {
    DYLD_INSERT_LIBRARIES: '/tmp/unreviewed.dylib',
    MallocNanoZone: '0',
  };
  assert.equal(
    evaluateReleaseEvidence(helperEnvironment, releaseOptions()).failures.includes(
      'Helper app metadata or entitlements do not match the approved policy.'
    ),
    true
  );

  const invalidBuildMetadata = safeEvidence();
  invalidBuildMetadata.infoPlist.DTCompiler = 'unapproved.compiler';
  assert.equal(
    evaluateReleaseEvidence(invalidBuildMetadata, releaseOptions()).failures.includes(
      'Main app metadata contains unapproved keys or values.'
    ),
    true
  );

  const inconsistentHelperBuild = safeEvidence();
  inconsistentHelperBuild.helpers[0].infoPlist.DTXcodeBuild = 'DIFFERENT';
  assert.equal(
    evaluateReleaseEvidence(inconsistentHelperBuild, releaseOptions()).failures.includes(
      'Helper app metadata or entitlements do not match the approved policy.'
    ),
    true
  );
});

test('release evidence binds embedded ASAR integrity metadata to the actual archive header', () => {
  const evidence = safeEvidence();
  evidence.asarIntegrityHash = 'b'.repeat(64);

  const result = evaluateReleaseEvidence(evidence, releaseOptions());

  assert.equal(result.ok, false);
  assert.equal(
    result.failures.includes('Embedded ASAR integrity metadata does not match the packaged archive.'),
    true
  );
});

test('release evidence rejects ASAR file integrity metadata that does not match archived bytes', () => {
  const evidence = safeEvidence();
  evidence.asarFileIntegrity = {
    valid: false,
    checkedFileCount: 2862,
    failedFileCount: 1,
  };

  const result = evaluateReleaseEvidence(evidence, releaseOptions());

  assert.equal(result.ok, false);
  assert.equal(
    result.failures.includes('Packaged ASAR file integrity metadata does not match the archived files.'),
    true
  );
  assert.equal(result.proof.checks.asarFiles, 'fail');
});

test('ASAR file integrity verification detects transformed-byte hash drift', () => {
  const files = new Map([
    ['package.json', '{"name":"crate-app","version":"test"}'],
    ['main.js', 'module.exports = true;'],
  ]);
  const asar = createFakeAsar(files);
  assert.deepEqual(verifyAsarFileIntegrity(asar, '/tmp/app.asar'), {
    valid: true,
    checkedFileCount: 2,
    failedFileCount: 0,
  });

  const originalStatFile = asar.statFile;
  asar.statFile = (asarPath, entry) => {
    const metadata = originalStatFile(asarPath, entry);
    if (String(entry).replace(/^\/+/, '') === 'package.json') {
      metadata.integrity.hash = '0'.repeat(64);
      metadata.integrity.blocks = ['0'.repeat(64)];
    }
    return metadata;
  };

  assert.deepEqual(verifyAsarFileIntegrity(asar, '/tmp/app.asar'), {
    valid: false,
    checkedFileCount: 2,
    failedFileCount: 1,
  });
});

test('ASAR file integrity verification rejects packed and unpacked non-native tampering', () => {
  const original = Buffer.from('approved bytes');
  const tampered = Buffer.from('tampered bytes');
  const originalMetadata = createFakeAsar(
    new Map([['node_modules/fixture/payload.bin', original]])
  ).statFile('', 'node_modules/fixture/payload.bin');
  const createTamperedAsar = unpacked => ({
    extractFile() {
      return tampered;
    },
    listPackage() {
      return ['/node_modules/fixture/payload.bin'];
    },
    statFile() {
      return {
        ...originalMetadata,
        ...(unpacked ? { unpacked: true } : {}),
      };
    },
  });

  assert.deepEqual(verifyAsarFileIntegrity(createTamperedAsar(false), '/tmp/app.asar'), {
    valid: false,
    checkedFileCount: 1,
    failedFileCount: 1,
  });
  assert.deepEqual(verifyAsarFileIntegrity(createTamperedAsar(true), '/tmp/app.asar'), {
    valid: false,
    checkedFileCount: 1,
    failedFileCount: 1,
  });
});

test('ASAR file integrity permits signed unpacked Mach-O mutation only for the exact proven path', () => {
  const entry = 'node_modules/native/build/Release/addon.node';
  const original = Buffer.concat([
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
    Buffer.from('approved native bytes'),
  ]);
  const signed = Buffer.concat([original, Buffer.from('codesign mutation')]);
  const originalMetadata = createFakeAsar(new Map([[entry, original]])).statFile('', entry);
  const authenticatedNativeEvidence = new Map();
  const packageManifest = { name: 'native', version: '1.0.0' };
  const expectedPackages = new Map([['node_modules/native', {
    files: new Map([
      ['package.json', { kind: 'manifest', value: packageManifest }],
      ['build/Release/addon.node', {
        kind: 'native-custom',
        rawBytes: original,
        rawDigest: crypto.createHash('sha256').update(original).digest('hex'),
        rawSize: original.length,
      }],
    ]),
    name: 'native',
    root: 'node_modules/native',
    version: '1.0.0',
  }]]);
  const actualPackages = new Map([['node_modules/native', {
    files: new Map([
      ['package.json', Buffer.from(JSON.stringify(packageManifest))],
      ['build/Release/addon.node', signed],
    ]),
    name: 'native',
    root: 'node_modules/native',
    version: '1.0.0',
  }]]);
  assert.equal(dependencyPackageInventoriesMatch(
    expectedPackages,
    actualPackages,
    { dependencies: { native: '1.0.0' } },
    { packages: { 'node_modules/native': {} } },
    {
      authenticatedNativeEvidence,
      nativeIntegrityBlockSizes: new Map([[entry, originalMetadata.integrity.blockSize]]),
      nativeFileMatcher(packagedBytes, evidence) {
        return crypto.createHash('sha256')
          .update(packagedBytes.subarray(0, original.length))
          .digest('hex') === evidence.rawDigest;
      },
    }
  ), true);
  assert.deepEqual([...authenticatedNativeEvidence], [[entry, {
    size: originalMetadata.size,
    integrity: originalMetadata.integrity,
  }]]);
  const partialProofEvidence = new Map();
  assert.equal(dependencyPackageInventoriesMatch(
    expectedPackages,
    actualPackages,
    { dependencies: { missing: '1.0.0', native: '1.0.0' } },
    { packages: { 'node_modules/native': {} } },
    {
      authenticatedNativeEvidence: partialProofEvidence,
      nativeIntegrityBlockSizes: new Map([[entry, originalMetadata.integrity.blockSize]]),
      nativeFileMatcher: () => true,
    }
  ), false);
  assert.deepEqual([...partialProofEvidence], []);
  const asar = {
    extractFile() {
      return signed;
    },
    listPackage() {
      return [`/${entry}`];
    },
    statFile() {
      return {
        ...originalMetadata,
        unpacked: true,
      };
    },
  };

  assert.deepEqual(verifyAsarFileIntegrity(asar, '/tmp/app.asar', {
    authenticatedNativeEvidence,
  }), {
    valid: true,
    checkedFileCount: 1,
    failedFileCount: 0,
  });
  for (const authenticatedNativeEvidence of [
    new Map(),
    new Map([['node_modules/native/build/Release/other.node', {
      size: originalMetadata.size,
      integrity: originalMetadata.integrity,
    }]]),
  ]) {
    assert.deepEqual(verifyAsarFileIntegrity(asar, '/tmp/app.asar', {
      authenticatedNativeEvidence,
    }), {
      valid: false,
      checkedFileCount: 1,
      failedFileCount: 1,
    });
  }
});

test('authenticated signed Mach-O fails when ASAR pre-sign metadata is stale or corrupt', () => {
  const entry = 'node_modules/native/build/Release/addon.node';
  const original = Buffer.concat([
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
    Buffer.from('approved native bytes'),
  ]);
  const signed = Buffer.concat([original, Buffer.from('codesign mutation')]);
  const originalMetadata = createFakeAsar(new Map([[entry, original]])).statFile('', entry);
  const staleBytes = Buffer.from(original);
  staleBytes[staleBytes.length - 1] ^= 0xff;
  const staleMetadata = createFakeAsar(new Map([[entry, staleBytes]])).statFile('', entry);
  const authenticatedNativeEvidence = new Map([[entry, {
    size: originalMetadata.size,
    integrity: originalMetadata.integrity,
  }]]);
  const metadataVariants = [
    staleMetadata,
    {
      ...originalMetadata,
      size: originalMetadata.size + 1,
    },
    {
      ...originalMetadata,
      integrity: {
        ...originalMetadata.integrity,
        hash: '0'.repeat(64),
      },
    },
    {
      ...originalMetadata,
      integrity: {
        ...originalMetadata.integrity,
        blocks: ['0'.repeat(64)],
      },
    },
  ];

  for (const metadata of metadataVariants) {
    const asar = {
      extractFile() {
        return signed;
      },
      listPackage() {
        return [`/${entry}`];
      },
      statFile() {
        return {
          ...metadata,
          unpacked: true,
        };
      },
    };
    assert.deepEqual(verifyAsarFileIntegrity(asar, '/tmp/app.asar', {
      authenticatedNativeEvidence,
    }), {
      valid: false,
      checkedFileCount: 1,
      failedFileCount: 1,
    });
  }
});

test('ASAR native proof does not exempt extension-only non-Mach-O mutation', () => {
  const entry = 'node_modules/native/build/Release/addon.node';
  const original = Buffer.from('approved non-native bytes');
  const originalMetadata = createFakeAsar(new Map([[entry, original]])).statFile('', entry);
  const asar = {
    extractFile() {
      return Buffer.from('signed-looking but non-native mutation');
    },
    listPackage() {
      return [`/${entry}`];
    },
    statFile() {
      return {
        ...originalMetadata,
        unpacked: true,
      };
    },
  };

  assert.deepEqual(verifyAsarFileIntegrity(asar, '/tmp/app.asar', {
    authenticatedNativeEvidence: new Map([[entry, {
      size: originalMetadata.size,
      integrity: originalMetadata.integrity,
    }]]),
  }), {
    valid: false,
    checkedFileCount: 1,
    failedFileCount: 1,
  });
});

test('ASAR file integrity fails closed on malformed file metadata or schema', () => {
  const createAsar = metadata => ({
    extractFile() {
      return Buffer.from('fixture');
    },
    listPackage() {
      return ['/fixture'];
    },
    statFile() {
      return metadata;
    },
  });
  const validMetadata = createFakeAsar(
    new Map([['fixture', Buffer.from('fixture')]])
  ).statFile('', 'fixture');

  for (const metadata of [
    null,
    {
      ...validMetadata,
      integrity: {
        ...validMetadata.integrity,
        unreviewed: true,
      },
    },
  ]) {
    assert.deepEqual(verifyAsarFileIntegrity(createAsar(metadata), '/tmp/app.asar'), {
      valid: false,
      checkedFileCount: metadata === null ? 0 : 1,
      failedFileCount: 1,
    });
  }
});

test('release evidence supports a future approved version without hard-coded test metadata', () => {
  const version = '9.9.9-test';
  const result = evaluateReleaseEvidence(safeEvidence(version), {
    ...releaseOptions(),
    expectedVersion: version,
  });

  assert.equal(result.ok, true);
});

test('release evidence rejects every Electron fuse policy regression', () => {
  for (const [name, expected] of Object.entries(EXPECTED_FUSES)) {
    const evidence = safeEvidence();
    evidence.fuses[name] = !expected;
    const result = evaluateReleaseEvidence(evidence, releaseOptions());
    assert.equal(result.ok, false, name);
    assert.equal(result.failures.includes(`Electron fuse policy changed: ${name}.`), true, name);
  }

  const legacyWire = safeEvidence();
  legacyWire.fuseIndices.pop();
  assert.equal(
    evaluateReleaseEvidence(legacyWire, releaseOptions()).failures.includes(
      'Electron fuse wire version or shape changed.'
    ),
    true
  );

  const futureWire = safeEvidence();
  futureWire.fuseIndices.push(9);
  assert.equal(
    evaluateReleaseEvidence(futureWire, releaseOptions()).failures.includes(
      'Electron fuse wire version or shape changed.'
    ),
    true
  );

  const futureVersion = safeEvidence();
  futureVersion.fuseVersion = '2';
  assert.equal(
    evaluateReleaseEvidence(futureVersion, releaseOptions()).failures.includes(
      'Electron fuse wire version or shape changed.'
    ),
    true
  );
});

test('release evidence requires exact main and helper entitlements', () => {
  const missingMain = safeEvidence();
  delete missingMain.mainEntitlements['com.apple.security.automation.apple-events'];
  assert.equal(evaluateReleaseEvidence(missingMain, releaseOptions()).failures.includes('Main app entitlements do not match the approved policy.'), true);

  const extraMain = safeEvidence();
  extraMain.mainEntitlements['com.apple.security.network.server'] = true;
  assert.equal(evaluateReleaseEvidence(extraMain, releaseOptions()).failures.includes('Main app entitlements do not match the approved policy.'), true);

  const helperAutomation = safeEvidence();
  helperAutomation.helpers[0].entitlements['com.apple.security.automation.apple-events'] = true;
  assert.equal(evaluateReleaseEvidence(helperAutomation, releaseOptions()).failures.includes('Helper app metadata or entitlements do not match the approved policy.'), true);

  const helperPrivacyExpansion = safeEvidence();
  helperPrivacyExpansion.helpers[0].privacyUsageKeys.push('NSContactsUsageDescription');
  assert.equal(evaluateReleaseEvidence(helperPrivacyExpansion, releaseOptions()).failures.includes('Helper app metadata or entitlements do not match the approved policy.'), true);

  const foreignHelper = safeEvidence();
  foreignHelper.helpers[0].signature.teamIdentifier = 'OTHERTEAM1';
  assert.equal(evaluateReleaseEvidence(foreignHelper, releaseOptions()).failures.includes('Helper app signature policy changed.'), true);

  const missingHelper = safeEvidence();
  missingHelper.helpers.pop();
  assert.equal(evaluateReleaseEvidence(missingHelper, releaseOptions()).failures.includes('Expected Electron helper app set is incomplete.'), true);

  const duplicateHelperRole = safeEvidence();
  duplicateHelperRole.helpers[3].name = 'Another Product Helper (Renderer).app';
  assert.equal(evaluateReleaseEvidence(duplicateHelperRole, releaseOptions()).failures.includes('Expected Electron helper app set is incomplete.'), true);

  const nestedAuthority = safeEvidence();
  nestedAuthority.nestedBundles[0].entitlements['com.apple.security.automation.apple-events'] = true;
  assert.equal(evaluateReleaseEvidence(nestedAuthority, releaseOptions()).failures.includes('Nested code bundle policy changed.'), true);

  const foreignFramework = safeEvidence();
  foreignFramework.nestedBundles[0].signature.identifier = 'com.example.replacement';
  assert.equal(evaluateReleaseEvidence(foreignFramework, releaseOptions()).failures.includes('Nested code-signature policy changed.'), true);

  const legacyMantleIdentifier = safeEvidence();
  legacyMantleIdentifier.nestedBundles.find(bundle => (
    bundle.name === 'Mantle.framework'
  )).signature.identifier = 'org.mantle.Mantle';
  assert.equal(evaluateReleaseEvidence(legacyMantleIdentifier, releaseOptions()).failures.includes('Nested code-signature policy changed.'), true);

  const foreignMantleIdentifier = safeEvidence();
  foreignMantleIdentifier.nestedBundles.find(bundle => (
    bundle.name === 'Mantle.framework'
  )).signature.identifier = 'com.example.mantle';
  assert.equal(evaluateReleaseEvidence(foreignMantleIdentifier, releaseOptions()).failures.includes('Nested code-signature policy changed.'), true);

  const unknownNestedBundle = safeEvidence();
  unknownNestedBundle.nestedBundles.push(safeNestedBundle('Unexpected Login Item.app'));
  assert.equal(evaluateReleaseEvidence(unknownNestedBundle, releaseOptions()).failures.includes('Nested code bundle policy changed.'), true);
});

test('release evidence binds the proof to source, version, and signed code', () => {
  const evidence = safeEvidence();
  evidence.infoPlist.CFBundleShortVersionString = '2.9.0';
  evidence.infoPlist.CFBundleVersion = 'unexpected-build';
  evidence.signature.codeDirectoryHash = null;
  evidence.sourceBinding.matches = false;
  evidence.sourceBinding.manifestMatches = false;
  evidence.sourceBinding.dependencyLockMatches = false;
  evidence.sourceBinding.releaseSourceClean = false;
  evidence.sourceBinding.revision = 'not-a-commit';
  evidence.sourceBinding.entryCount = 0;

  const result = evaluateReleaseEvidence(evidence, releaseOptions());

  assert.equal(result.ok, false);
  assert.deepEqual(result.failures.filter(failure => (
    failure.includes('version') ||
    failure.includes('fingerprint') ||
    failure.includes('source')
  )), [
    'Signed code fingerprint is missing or invalid.',
    'Final app version does not match source release metadata.',
    'Final app build version does not match source release metadata.',
    'Packaged first-party files do not match the current source revision.',
    'Public release source tree is not clean.',
    'Artifact source revision does not match the approved release commit.',
  ]);
  assert.equal(
    result.failures.includes(
      'Packaged dependency payload does not match the reconstructed production dependency tree.'
    ),
    true
  );
  assert.equal(result.proof.checks.sourceRevision, 'fail');
});

test('production dependency closure validates root and transitive declared versions', () => {
  const manifest = {
    name: 'fixture',
    version: '1.0.0',
    dependencies: {
      direct: '^1.0.0',
      'major-only': '1',
    },
  };
  const lockfile = {
    lockfileVersion: 3,
    packages: {
      '': {
        name: manifest.name,
        version: manifest.version,
        dependencies: manifest.dependencies,
      },
      'node_modules/direct': {
        version: '1.4.0',
        dependencies: { transitive: '~2.1.0' },
      },
      'node_modules/major-only': { version: '1.9.0' },
      'node_modules/transitive': { version: '2.1.7' },
    },
  };

  assert.equal(collectReachableProductionLockPaths(manifest, lockfile).valid, true);

  const wrongDirect = structuredClone(lockfile);
  wrongDirect.packages['node_modules/direct'].version = '9.0.0';
  assert.equal(collectReachableProductionLockPaths(manifest, wrongDirect).valid, false);

  const wrongTransitive = structuredClone(lockfile);
  wrongTransitive.packages['node_modules/transitive'].version = '2.2.0';
  assert.equal(collectReachableProductionLockPaths(manifest, wrongTransitive).valid, false);

  const unsupportedRange = structuredClone(lockfile);
  unsupportedRange.packages[''].dependencies.direct = '*';
  const unsupportedManifest = structuredClone(manifest);
  unsupportedManifest.dependencies.direct = '*';
  assert.equal(
    collectReachableProductionLockPaths(unsupportedManifest, unsupportedRange).valid,
    false
  );

  for (const substitutedVersion of ['01.4.0', '1.04.0', '1.4.00']) {
    const leadingZero = structuredClone(lockfile);
    leadingZero.packages['node_modules/direct'].version = substitutedVersion;
    assert.equal(
      collectReachableProductionLockPaths(manifest, leadingZero).valid,
      false,
      substitutedVersion
    );
  }
  const leadingZeroSpec = structuredClone(manifest);
  const leadingZeroSpecLock = structuredClone(lockfile);
  leadingZeroSpec.dependencies.direct = '^01.0.0';
  leadingZeroSpecLock.packages[''].dependencies.direct = '^01.0.0';
  assert.equal(collectReachableProductionLockPaths(leadingZeroSpec, leadingZeroSpecLock).valid, false);

  const unsafeIntegerVersion = structuredClone(lockfile);
  unsafeIntegerVersion.packages['node_modules/direct'].version = '9007199254740992.0.0';
  assert.equal(collectReachableProductionLockPaths(manifest, unsafeIntegerVersion).valid, false);

  const unsafeIntegerSpec = structuredClone(manifest);
  const unsafeIntegerSpecLock = structuredClone(lockfile);
  unsafeIntegerSpec.dependencies.direct = '^9007199254740992.0.0';
  unsafeIntegerSpecLock.packages[''].dependencies.direct = '^9007199254740992.0.0';
  assert.equal(
    collectReachableProductionLockPaths(unsafeIntegerSpec, unsafeIntegerSpecLock).valid,
    false
  );

  for (const malformedConstraints of ['darwin', null, [7], ['darwin', 7], ['darwin', 'darwin']]) {
    const malformedPlatform = structuredClone(lockfile);
    malformedPlatform.packages['node_modules/direct'].os = malformedConstraints;
    assert.equal(
      collectReachableProductionLockPaths(manifest, malformedPlatform).valid,
      false,
      JSON.stringify(malformedConstraints)
    );
  }
});

test('verifier tool closure must be reachable from the reviewed release builder', () => {
  const fixture = createVerifierToolFixture();
  try {
    const reachable = collectReachableVerifierToolLockPaths(
      fixture.manifest,
      fixture.lockfile
    );
    assert.equal(reachable.valid, true);
    assert.deepEqual([...reachable.paths].sort(), [
      'node_modules/@electron/asar',
      'node_modules/@electron/fuses',
      'node_modules/chalk',
      'node_modules/commander',
    ]);

    const detached = structuredClone(fixture.lockfile);
    delete detached.packages['node_modules/app-builder-lib'].dependencies['@electron/fuses'];
    assert.equal(
      collectReachableVerifierToolLockPaths(fixture.manifest, detached).valid,
      false
    );

    const substitutedBuilder = structuredClone(fixture.lockfile);
    substitutedBuilder.packages['node_modules/electron-builder'].version = '99.0.0';
    assert.equal(
      collectReachableVerifierToolLockPaths(fixture.manifest, substitutedBuilder).valid,
      false
    );

    const malformedRequest = structuredClone(fixture.lockfile);
    malformedRequest.packages['node_modules/@electron/asar'].dependencies.commander = 5;
    assert.equal(
      collectReachableVerifierToolLockPaths(fixture.manifest, malformedRequest).valid,
      false
    );
  } finally {
    fs.rmSync(fixture.sourceRoot, { recursive: true, force: true });
  }
});

test('verifier tools load only after authenticated closure and fail closed on drift', async () => {
  const fixture = createVerifierToolFixture();
  const asar = createFakeAsar(new Map());
  const fuses = { async getCurrentFuseWire() { return new Uint8Array(); } };
  const loadOrder = [];
  try {
    const authenticated = authenticateVerifierToolchain(fixture.sourceRoot, {
      archiveVerifier: () => true,
      loadAsar() {
        loadOrder.push('asar');
        return asar;
      },
      loadFuses() {
        loadOrder.push('fuses');
        return fuses;
      },
    });
    assert.equal(authenticated.valid, true);
    assert.equal(authenticated.packageCount, 4);
    assert.deepEqual(loadOrder, ['asar', 'fuses']);
    assert.equal(authenticated.tools.asar, asar);
    assert.deepEqual(await authenticated.tools.getFuseWire('/tmp/Crate'), new Uint8Array());
    assert.equal(authenticated.recheck(), true);

    fs.writeFileSync(
      path.join(fixture.sourceRoot, 'node_modules', '@electron', 'asar', 'index.js'),
      'module.exports = "substituted";\n'
    );
    assert.equal(authenticated.recheck(), false);
  } finally {
    fs.rmSync(fixture.sourceRoot, { recursive: true, force: true });
  }

  const tampered = createVerifierToolFixture();
  let loaderCalled = false;
  try {
    const rejected = authenticateVerifierToolchain(tampered.sourceRoot, {
      afterToolAuthentication() {
        fs.writeFileSync(
          path.join(tampered.sourceRoot, 'node_modules', '@electron', 'fuses', 'index.js'),
          'module.exports = "changed before load";\n'
        );
      },
      archiveVerifier: () => true,
      loadAsar() {
        loaderCalled = true;
        return asar;
      },
      loadFuses() {
        loaderCalled = true;
        return fuses;
      },
    });
    assert.equal(rejected.valid, false);
    assert.equal(loaderCalled, false);
  } finally {
    fs.rmSync(tampered.sourceRoot, { recursive: true, force: true });
  }

  const incompleteLoaderFixture = createVerifierToolFixture();
  let incompleteLoaderCalled = false;
  try {
    const rejected = authenticateVerifierToolchain(incompleteLoaderFixture.sourceRoot, {
      archiveVerifier: () => true,
      loadAsar() {
        incompleteLoaderCalled = true;
        return asar;
      },
    });
    assert.equal(rejected.valid, false);
    assert.equal(incompleteLoaderCalled, false);
  } finally {
    fs.rmSync(incompleteLoaderFixture.sourceRoot, { recursive: true, force: true });
  }
});

test('source binding requires a canonical Git root and regular committed source blobs', () => {
  const sourceRoot = fs.mkdtempSync('/tmp/crate-release-source-binding-');
  const appPath = path.join(sourceRoot, 'Crate.app');
  try {
    for (const entry of SOURCE_BOUND_ENTRIES) {
      const sourcePath = path.join(sourceRoot, ...entry.split('/'));
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, `safe bytes for ${entry}`);
    }
    for (const entry of EXTERNAL_SOURCE_BOUND_ENTRIES) {
      const sourcePath = path.join(sourceRoot, ...entry.source.split('/'));
      const artifactPath = path.join(appPath, ...entry.artifact.split('/'));
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
      fs.writeFileSync(sourcePath, `safe bytes for ${entry.source}`);
      fs.writeFileSync(artifactPath, `safe bytes for ${entry.source}`);
    }
    const sourceManifest = {
      dependencies: { 'runtime-dep': '^1.0.0' },
      description: 'safe',
      devDependencies: { electron: '^42.9.0' },
      main: 'main.js',
      name: 'crate-app',
      overrides: packageJson.overrides,
      productName: 'Crate',
      version: packageJson.version,
    };
    const packagedManifest = {
      dependencies: sourceManifest.dependencies,
      description: sourceManifest.description,
      main: sourceManifest.main,
      name: sourceManifest.name,
      overrides: sourceManifest.overrides,
      productName: sourceManifest.productName,
      version: sourceManifest.version,
    };
    fs.writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify(sourceManifest));
    fs.writeFileSync(path.join(sourceRoot, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {
          name: sourceManifest.name,
          version: sourceManifest.version,
          dependencies: sourceManifest.dependencies,
          devDependencies: sourceManifest.devDependencies,
        },
        'node_modules/electron': {
          version: '42.9.0',
          dev: true,
          resolved: 'https://registry.npmjs.org/electron/-/electron-safe.tgz',
          integrity: SAFE_INTEGRITY,
        },
        'node_modules/runtime-dep': {
          version: '1.0.0',
          dependencies: { shared: '1.0.0', transitive: '^2.0.0' },
          resolved: 'https://registry.npmjs.org/runtime-dep/-/runtime-dep-safe.tgz',
          integrity: SAFE_INTEGRITY,
        },
        'node_modules/transitive': {
          version: '2.0.0',
          dependencies: { shared: '2.0.0' },
          resolved: 'https://registry.npmjs.org/transitive/-/transitive-safe.tgz',
          integrity: SAFE_INTEGRITY,
        },
        'node_modules/shared': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/shared/-/shared-1.0.0.tgz',
          integrity: SAFE_INTEGRITY,
        },
        'node_modules/transitive/node_modules/shared': {
          version: '2.0.0',
          resolved: 'https://registry.npmjs.org/shared/-/shared-2.0.0.tgz',
          integrity: SAFE_INTEGRITY,
        },
      },
    }));
    const dependencyManifest = JSON.stringify({
      dependencies: { shared: '1.0.0', transitive: '^2.0.0' },
      name: 'runtime-dep',
      version: '1.0.0',
      main: 'index.js',
    });
    const dependencyRoot = path.join(sourceRoot, 'node_modules', 'runtime-dep');
    fs.mkdirSync(dependencyRoot, { recursive: true });
    fs.writeFileSync(path.join(dependencyRoot, 'package.json'), dependencyManifest);
    fs.writeFileSync(path.join(dependencyRoot, 'index.js'), 'module.exports = "safe";');
    const nestedFixtureManifest = {
      main: 'index.js',
      name: 'runtime-dep-benchmark',
      scripts: { benchmark: 'node index.js' },
      keywords: ['benchmark'],
      version: '1.0.0',
    };
    fs.mkdirSync(path.join(dependencyRoot, 'benchmark'), { recursive: true });
    fs.writeFileSync(
      path.join(dependencyRoot, 'benchmark', 'package.json'),
      JSON.stringify(nestedFixtureManifest)
    );
    const transitiveManifest = JSON.stringify({
      dependencies: { shared: '2.0.0' },
      name: 'transitive',
      version: '2.0.0',
      main: 'index.js',
    });
    const transitiveRoot = path.join(sourceRoot, 'node_modules', 'transitive');
    fs.mkdirSync(transitiveRoot, { recursive: true });
    fs.writeFileSync(path.join(transitiveRoot, 'package.json'), transitiveManifest);
    fs.writeFileSync(path.join(transitiveRoot, 'index.js'), 'module.exports = "transitive";');
    const sharedRoot = path.join(sourceRoot, 'node_modules', 'shared');
    const nestedSharedRoot = path.join(transitiveRoot, 'node_modules', 'shared');
    const sharedV1Manifest = JSON.stringify({ name: 'shared', version: '1.0.0' });
    const sharedV2Manifest = JSON.stringify({ name: 'shared', version: '2.0.0' });
    fs.mkdirSync(sharedRoot, { recursive: true });
    fs.mkdirSync(nestedSharedRoot, { recursive: true });
    fs.writeFileSync(path.join(sharedRoot, 'package.json'), sharedV1Manifest);
    fs.writeFileSync(path.join(sharedRoot, 'index.js'), 'module.exports = "shared-v1";');
    fs.writeFileSync(path.join(nestedSharedRoot, 'package.json'), sharedV2Manifest);
    fs.writeFileSync(path.join(nestedSharedRoot, 'index.js'), 'module.exports = "shared-v2";');
    const asarFiles = new Map([
      ['package.json', JSON.stringify(packagedManifest)],
      ['node_modules/runtime-dep/package.json', dependencyManifest],
      ['node_modules/runtime-dep/index.js', 'module.exports = "safe";'],
      ['node_modules/runtime-dep/benchmark/package.json', JSON.stringify({
        main: nestedFixtureManifest.main,
        name: nestedFixtureManifest.name,
        version: nestedFixtureManifest.version,
      })],
      ['node_modules/transitive/package.json', transitiveManifest],
      ['node_modules/transitive/index.js', 'module.exports = "transitive";'],
      ['node_modules/shared/package.json', sharedV1Manifest],
      ['node_modules/shared/index.js', 'module.exports = "shared-v1";'],
      ['node_modules/transitive/node_modules/shared/package.json', sharedV2Manifest],
      ['node_modules/transitive/node_modules/shared/index.js', 'module.exports = "shared-v2";'],
    ]);
    for (const entry of SOURCE_BOUND_ENTRIES) {
      asarFiles.set(entry, fs.readFileSync(path.join(sourceRoot, ...entry.split('/'))));
    }
    const asar = createFakeAsar(asarFiles);
    const revision = 'b'.repeat(40);
    const cleanRunner = createFixtureGitRunner(sourceRoot, revision);
    const nonRegularRunner = createFixtureGitRunner(sourceRoot, revision, {
      symlinkEntry: SOURCE_BOUND_ENTRIES[0],
    });
    const dirtyReleaseRunner = createFixtureGitRunner(sourceRoot, revision, {
      status: ' M package.json\n',
    });
    const wrongRootRunner = createFixtureGitRunner(sourceRoot, revision, {
      topLevel: fs.realpathSync(path.dirname(sourceRoot)),
    });
    const replacementRunner = createFixtureGitRunner(sourceRoot, revision, {
      replacements: `${'c'.repeat(40)}\n`,
    });
    const unavailableRevisionCalls = [];
    const unavailableRevisionRunner = (command, args, commandOptions = {}) => {
      const normalized = normalizeFixtureGitArgs(args);
      unavailableRevisionCalls.push([...normalized]);
      if (normalized[0] === 'rev-parse' && normalized[1] === '--verify') {
        return { ok: false, stdout: '', stderr: '' };
      }
      return cleanRunner(command, args, commandOptions);
    };

    assert.deepEqual(collectSourceBinding(appPath, cleanRunner, {
      asar,
      archiveVerifier: () => true,
      sourceRoot,
    }), {
      matches: true,
      manifestMatches: true,
      dependencyLockMatches: true,
      releaseSourceClean: true,
      revision,
      entryCount: SOURCE_BOUND_ENTRIES.length + EXTERNAL_SOURCE_BOUND_ENTRIES.length,
    });

    const externalBinding = EXTERNAL_SOURCE_BOUND_ENTRIES[0];
    const externalArtifactPath = path.join(appPath, ...externalBinding.artifact.split('/'));
    fs.writeFileSync(externalArtifactPath, 'unapproved icon bytes');
    assert.equal(collectSourceBinding(appPath, cleanRunner, {
      asar,
      archiveVerifier: () => true,
      sourceRoot,
    }).matches, false);
    fs.writeFileSync(externalArtifactPath, `safe bytes for ${externalBinding.source}`);

    const journalDriftFiles = new Map(asarFiles);
    journalDriftFiles.set('startup-phase-journal.js', 'tampered packaged journal bytes');
    assert.equal(collectSourceBinding(appPath, cleanRunner, {
      asar: createFakeAsar(journalDriftFiles),
      archiveVerifier: () => true,
      sourceRoot,
    }).matches, false);

    let revisionReads = 0;
    const gitCalls = [];
    const rawGitCalls = [];
    const movingHeadRunner = (command, args, commandOptions = {}) => {
      rawGitCalls.push([...args]);
      const normalized = normalizeFixtureGitArgs(args);
      gitCalls.push([...normalized]);
      if (normalized[0] === 'rev-parse' && normalized[1] === '--verify' &&
          normalized[2] === 'HEAD^{commit}') {
        revisionReads += 1;
        return {
          ok: true,
          stdout: `${revisionReads === 1 ? revision : 'c'.repeat(40)}\n`,
          stderr: '',
        };
      }
      return cleanRunner(command, args, commandOptions);
    };
    const movingHead = collectSourceBinding(appPath, movingHeadRunner, {
      archiveVerifier: () => true,
      asar,
      sourceRoot,
    });
    assert.equal(movingHead.matches, false);
    assert.equal(movingHead.manifestMatches, false);
    assert.equal(movingHead.dependencyLockMatches, false);
    assert.equal(movingHead.releaseSourceClean, false);
    assert.equal(
      gitCalls.filter(args => args[0] === 'ls-tree').every(args => args[1] === revision),
      true
    );
    assert.equal(
      gitCalls.filter(args => args[0] === 'show').every(args => args[1].startsWith(`${revision}:`)),
      true
    );
    assert.equal(gitCalls.some(args => args[0] === 'show' && args[1].startsWith('HEAD:')), false);
    for (const args of rawGitCalls) {
      assert.deepEqual(
        args.slice(0, SAFE_GIT_ARGUMENT_PREFIX.length),
        [...SAFE_GIT_ARGUMENT_PREFIX]
      );
    }

    let sealedPackages = null;
    const substitutedAfterAuthentication = new Map(asarFiles);
    substitutedAfterAuthentication.set(
      'node_modules/runtime-dep/index.js',
      'module.exports = "attacker";'
    );
    const substitutedResult = collectSourceBinding(appPath, cleanRunner, {
      afterDependencyAuthentication() {
        fs.writeFileSync(path.join(dependencyRoot, 'index.js'), 'module.exports = "attacker";');
      },
      archiveVerifier: () => true,
      asar: createFakeAsar(substitutedAfterAuthentication),
      onDependencyEvidenceSealed(packages) {
        sealedPackages = packages;
      },
      sourceRoot,
    });
    assert.equal(substitutedResult.dependencyLockMatches, false);
    assert.equal(sealedPackages instanceof Map, true);
    for (const expectedPackage of sealedPackages.values()) {
      for (const evidence of expectedPackage.files.values()) {
        assert.equal(Buffer.isBuffer(evidence), false);
        assert.equal(Object.hasOwn(evidence, 'sourcePath'), false);
        assert.equal(JSON.stringify(evidence).includes(sourceRoot), false);
      }
    }
    fs.writeFileSync(path.join(dependencyRoot, 'index.js'), 'module.exports = "safe";');

    const externalDependency = path.join(sourceRoot, 'external-dependency.js');
    fs.writeFileSync(externalDependency, 'module.exports = "safe";');
    const symlinkAfterAuthentication = collectSourceBinding(appPath, cleanRunner, {
      afterDependencyAuthentication() {
        const target = path.join(dependencyRoot, 'index.js');
        fs.unlinkSync(target);
        fs.symlinkSync(externalDependency, target);
      },
      archiveVerifier: () => true,
      asar,
      sourceRoot,
    });
    assert.equal(symlinkAfterAuthentication.dependencyLockMatches, false);
    fs.unlinkSync(path.join(dependencyRoot, 'index.js'));
    fs.writeFileSync(path.join(dependencyRoot, 'index.js'), 'module.exports = "safe";');

    const authenticatedDependencyManifest = JSON.parse(dependencyManifest);
    fs.writeFileSync(path.join(dependencyRoot, 'package.json'), JSON.stringify({
      ...authenticatedDependencyManifest,
      dependencies: { shared: '1.0.0', transitive: '^9.0.0' },
    }));
    assert.equal(collectSourceBinding(appPath, cleanRunner, {
      asar,
      archiveVerifier: () => true,
      sourceRoot,
    }).dependencyLockMatches, false);
    fs.writeFileSync(path.join(dependencyRoot, 'package.json'), dependencyManifest);
    const manifestDriftFiles = new Map(asarFiles);
    manifestDriftFiles.set('package.json', JSON.stringify({
      ...packagedManifest,
      version: `${packagedManifest.version}-drift`,
    }));
    const manifestDriftAsar = createFakeAsar(manifestDriftFiles);
    assert.equal(collectSourceBinding(appPath, cleanRunner, {
      asar: manifestDriftAsar,
      archiveVerifier: () => true,
      sourceRoot,
    }).manifestMatches, false);
    assert.equal(collectSourceBinding(appPath, nonRegularRunner, {
      asar,
      archiveVerifier: () => true,
      sourceRoot,
    }).matches, false);
    assert.equal(collectSourceBinding(appPath, dirtyReleaseRunner, {
      asar,
      archiveVerifier: () => true,
      sourceRoot,
    }).releaseSourceClean, false);
    assert.equal(collectSourceBinding(appPath, wrongRootRunner, {
      asar,
      archiveVerifier: () => true,
      sourceRoot,
    }).matches, false);
    assert.equal(collectSourceBinding(appPath, replacementRunner, {
      asar,
      archiveVerifier: () => true,
      sourceRoot,
    }).matches, false);
    assert.equal(collectSourceBinding(appPath, unavailableRevisionRunner, {
      asar,
      archiveVerifier: () => true,
      sourceRoot,
    }).matches, false);
    assert.equal(unavailableRevisionCalls.some(args => args[0] === 'ls-tree'), false);
    assert.equal(unavailableRevisionCalls.some(args => args[0] === 'show'), false);
    const graftPath = path.join(sourceRoot, '.git', 'info', 'grafts');
    fs.mkdirSync(path.dirname(graftPath), { recursive: true });
    fs.writeFileSync(graftPath, `${revision} ${'c'.repeat(40)}\n`);
    assert.equal(collectSourceBinding(appPath, cleanRunner, {
      asar,
      archiveVerifier: () => true,
      sourceRoot,
    }).matches, false);
    fs.rmSync(path.join(sourceRoot, '.git'), { recursive: true, force: true });

    const renamedManifest = path.join(
      appPath,
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'node_modules',
      'renamed-runtime-dep',
      'package.json'
    );
    fs.mkdirSync(path.dirname(renamedManifest), { recursive: true });
    fs.writeFileSync(renamedManifest, dependencyManifest);
    assert.equal(collectSourceBinding(appPath, cleanRunner, {
      asar,
      archiveVerifier: () => true,
      sourceRoot,
    }).dependencyLockMatches, false);
    fs.rmSync(path.dirname(renamedManifest), { recursive: true, force: true });

    const nestedNodeModulesRoot = path.join(transitiveRoot, 'node_modules');
    const movedNestedNodeModulesRoot = path.join(transitiveRoot, 'node_modules-authenticated');
    fs.renameSync(nestedNodeModulesRoot, movedNestedNodeModulesRoot);
    fs.symlinkSync('node_modules-authenticated', nestedNodeModulesRoot);
    assert.equal(collectSourceBinding(appPath, cleanRunner, {
      asar,
      archiveVerifier: () => true,
      sourceRoot,
    }).dependencyLockMatches, false);
    fs.unlinkSync(nestedNodeModulesRoot);
    fs.renameSync(movedNestedNodeModulesRoot, nestedNodeModulesRoot);

    const conflictingManifest = path.join(
      appPath,
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'node_modules',
      'runtime-dep',
      'package.json'
    );
    fs.mkdirSync(path.dirname(conflictingManifest), { recursive: true });
    fs.writeFileSync(conflictingManifest, JSON.stringify({
      name: 'runtime-dep',
      version: 'substituted',
    }));
    assert.equal(collectSourceBinding(appPath, cleanRunner, {
      asar,
      archiveVerifier: () => true,
      sourceRoot,
    }).dependencyLockMatches, false);
    fs.rmSync(path.dirname(conflictingManifest), { recursive: true, force: true });

    const changedBodyFiles = new Map(asarFiles);
    changedBodyFiles.set('node_modules/runtime-dep/index.js', 'module.exports = "substituted";');
    assert.equal(collectSourceBinding(appPath, cleanRunner, {
      asar: createFakeAsar(changedBodyFiles),
      archiveVerifier: () => true,
      sourceRoot,
    }).dependencyLockMatches, false);

    const changedNestedManifestFiles = new Map(asarFiles);
    changedNestedManifestFiles.set(
      'node_modules/runtime-dep/benchmark/package.json',
      JSON.stringify({
        main: 'replacement.js',
        name: nestedFixtureManifest.name,
        version: nestedFixtureManifest.version,
      })
    );
    assert.equal(collectSourceBinding(appPath, cleanRunner, {
      asar: createFakeAsar(changedNestedManifestFiles),
      archiveVerifier: () => true,
      sourceRoot,
    }).dependencyLockMatches, false);

    const extraBodyFiles = new Map(asarFiles);
    extraBodyFiles.set('node_modules/runtime-dep/extra.js', 'unexpected');
    assert.equal(collectSourceBinding(appPath, cleanRunner, {
      asar: createFakeAsar(extraBodyFiles),
      archiveVerifier: () => true,
      sourceRoot,
    }).dependencyLockMatches, false);

    const missingBodyFiles = new Map(asarFiles);
    missingBodyFiles.delete('node_modules/runtime-dep/index.js');
    assert.equal(collectSourceBinding(appPath, cleanRunner, {
      asar: createFakeAsar(missingBodyFiles),
      archiveVerifier: () => true,
      sourceRoot,
    }).dependencyLockMatches, false);

    const missingTransitiveFiles = new Map(asarFiles);
    missingTransitiveFiles.delete('node_modules/transitive/package.json');
    missingTransitiveFiles.delete('node_modules/transitive/index.js');
    assert.equal(collectSourceBinding(appPath, cleanRunner, {
      asar: createFakeAsar(missingTransitiveFiles),
      archiveVerifier: () => true,
      sourceRoot,
    }).dependencyLockMatches, false);

    const swappedTopologyFiles = new Map(asarFiles);
    swappedTopologyFiles.set('node_modules/shared/package.json', sharedV2Manifest);
    swappedTopologyFiles.set('node_modules/shared/index.js', 'module.exports = "shared-v2";');
    swappedTopologyFiles.set(
      'node_modules/transitive/node_modules/shared/package.json',
      sharedV1Manifest
    );
    swappedTopologyFiles.set(
      'node_modules/transitive/node_modules/shared/index.js',
      'module.exports = "shared-v1";'
    );
    assert.equal(collectSourceBinding(appPath, cleanRunner, {
      asar: createFakeAsar(swappedTopologyFiles),
      archiveVerifier: () => true,
      sourceRoot,
    }).dependencyLockMatches, false);

    const changedExecutionMetadataFiles = new Map(asarFiles);
    changedExecutionMetadataFiles.set('node_modules/runtime-dep/package.json', JSON.stringify({
      name: 'runtime-dep',
      version: '9.0.0',
      main: 'replacement.js',
    }));
    assert.equal(collectSourceBinding(appPath, cleanRunner, {
      asar: createFakeAsar(changedExecutionMetadataFiles),
      archiveVerifier: () => true,
      sourceRoot,
    }).dependencyLockMatches, false);

    fs.writeFileSync(path.join(dependencyRoot, 'binding.node'), 'native-safe');
    const nativeFiles = new Map(asarFiles);
    nativeFiles.set('node_modules/runtime-dep/binding.node', 'native-substituted');
    assert.equal(collectSourceBinding(appPath, cleanRunner, {
      asar: createFakeAsar(nativeFiles),
      archiveVerifier: () => true,
      nativeFileMatcher(packagedBytes, evidence) {
        return crypto.createHash('sha256').update(packagedBytes).digest('hex') ===
          evidence.rawDigest;
      },
      sourceRoot,
    }).dependencyLockMatches, false);

    const lockfilePath = path.join(sourceRoot, 'package-lock.json');
    const validLockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
    const mismatchedRootLockfile = structuredClone(validLockfile);
    mismatchedRootLockfile.packages[''].dependencies['absent-runtime'] = '1.0.0';
    fs.writeFileSync(lockfilePath, JSON.stringify(mismatchedRootLockfile));
    const rootMismatch = collectSourceBinding(appPath, cleanRunner, {
      asar,
      archiveVerifier: () => true,
      sourceRoot,
    });
    assert.equal(rootMismatch.manifestMatches, false);
    assert.equal(rootMismatch.dependencyLockMatches, false);

    const invalidIntegrityLockfile = structuredClone(validLockfile);
    invalidIntegrityLockfile.packages['node_modules/runtime-dep'].integrity = 'sha512-safe';
    fs.writeFileSync(lockfilePath, JSON.stringify(invalidIntegrityLockfile));
    assert.equal(collectSourceBinding(appPath, cleanRunner, {
      asar,
      archiveVerifier: () => true,
      sourceRoot,
    }).dependencyLockMatches, false);

    const unsafeLockfile = structuredClone(validLockfile);
    unsafeLockfile.packages['node_modules/../../outside'] = {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/outside/-/outside-1.0.0.tgz',
      integrity: SAFE_INTEGRITY,
    };
    fs.writeFileSync(lockfilePath, JSON.stringify(unsafeLockfile));
    assert.equal(collectSourceBinding(appPath, cleanRunner, {
      asar,
      archiveVerifier: () => true,
      sourceRoot,
    }).dependencyLockMatches, false);

    const missingOptionalLockfile = structuredClone(validLockfile);
    missingOptionalLockfile.packages['node_modules/compatible-optional'] = {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/compatible-optional/-/compatible-optional-1.0.0.tgz',
      integrity: SAFE_INTEGRITY,
      optional: true,
      os: ['darwin'],
      cpu: ['arm64'],
    };
    fs.writeFileSync(lockfilePath, JSON.stringify(missingOptionalLockfile));
    assert.equal(collectSourceBinding(appPath, cleanRunner, {
      asar,
      archiveVerifier: () => true,
      sourceRoot,
    }).dependencyLockMatches, false);
    fs.writeFileSync(lockfilePath, JSON.stringify(validLockfile));

    fs.writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify({
      ...sourceManifest,
      build: { disableDefaultIgnoredFiles: true },
    }));
    assert.equal(collectSourceBinding(appPath, cleanRunner, {
      asar,
      archiveVerifier: () => true,
      sourceRoot,
    }).dependencyLockMatches, false);
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test('public proof requires the verifier checkout to be clean and revision-bound', () => {
  const revision = 'b'.repeat(40);
  const runner = options => {
    const fixtureRunner = createFixtureGitRunner(ROOT, options.revision || revision, options);
    return (command, args, commandOptions) => {
      const normalizedArgs = normalizeFixtureGitArgs(args);
      if (normalizedArgs[0] === 'rev-parse' && normalizedArgs[1] === '--git-path') {
        return {
          ok: true,
          stdout: `/tmp/crate-verifier-graft-${crypto.randomUUID()}/missing\n`,
          stderr: '',
        };
      }
      return fixtureRunner(command, args, commandOptions);
    };
  };

  assert.equal(verifierSourceMatchesExpectedRevision(revision, runner({})), true);
  assert.equal(verifierSourceMatchesExpectedRevision(revision, runner({ status: ' M verifier\n' })), false);
  assert.equal(verifierSourceMatchesExpectedRevision(revision, runner({ replacements: 'a'.repeat(40) })), false);
  assert.equal(verifierSourceMatchesExpectedRevision(revision, runner({ revision: 'c'.repeat(40) })), false);
  const stableRunner = runner({});
  let revisionReads = 0;
  const movingRevisionRunner = (command, args, commandOptions = {}) => {
    const normalizedArgs = normalizeFixtureGitArgs(args);
    if (normalizedArgs[0] === 'rev-parse' && normalizedArgs[1] === '--verify') {
      revisionReads += 1;
      return {
        ok: true,
        stdout: `${revisionReads === 1 ? revision : 'c'.repeat(40)}\n`,
        stderr: '',
      };
    }
    return stableRunner(command, args, commandOptions);
  };
  assert.equal(verifierSourceMatchesExpectedRevision(revision, movingRevisionRunner), false);
});

test('verifier Git subprocesses ignore ambient configuration and executable hooks', () => {
  const verifierSource = fs.readFileSync(
    path.join(ROOT, 'scripts', 'verify-macos-release-app.js'),
    'utf8'
  );
  assert.deepEqual(SAFE_GIT_ARGUMENT_PREFIX, [
    '--no-optional-locks',
    '--no-replace-objects',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.untrackedCache=false',
  ]);
  for (const assignment of [
    "GIT_CONFIG_GLOBAL: '/dev/null'",
    "GIT_CONFIG_NOSYSTEM: '1'",
    "GIT_CONFIG_SYSTEM: '/dev/null'",
    "GIT_NO_REPLACE_OBJECTS: '1'",
    "GIT_OPTIONAL_LOCKS: '0'",
  ]) {
    assert.equal(verifierSource.includes(assignment), true, assignment);
  }
  assert.doesNotMatch(verifierSource, /const environment = \{ \.\.\.process\.env \}/u);
  assert.match(verifierSource, /PATH: '\/usr\/bin:\/bin:\/usr\/sbin:\/sbin'/u);
});

test('installed dependency bytes are authenticated against the lockfile tarball', () => {
  const lockfile = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const lockPath = 'node_modules/yargs';
  const metadata = lockfile.packages[lockPath];
  const packageRoot = path.join(ROOT, lockPath);
  assert.equal(installedPackageMatchesLockArchive(packageRoot, 'yargs', metadata), true);

  const cacheRaceRoot = fs.mkdtempSync('/tmp/crate-lock-cache-race-');
  try {
    const sourceCachePath = npmCacheContentPath(metadata.integrity);
    const copiedCachePath = npmCacheContentPath(metadata.integrity, cacheRaceRoot);
    fs.mkdirSync(path.dirname(copiedCachePath), { recursive: true });
    fs.copyFileSync(sourceCachePath, copiedCachePath);
    let originalPathReplaced = false;
    const raceRunner = (command, args) => {
      const result = spawnSync(command, args, { encoding: 'utf8' });
      if (!originalPathReplaced && args[0] === '-tzf') {
        fs.writeFileSync(copiedCachePath, 'replaced-after-authentication');
        originalPathReplaced = true;
      }
      return {
        ok: result.status === 0,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
      };
    };
    assert.equal(installedPackageMatchesLockArchive(packageRoot, 'yargs', metadata, {
      commandRunner: raceRunner,
      npmCacheRoot: cacheRaceRoot,
    }), true);
    assert.equal(originalPathReplaced, true);
  } finally {
    fs.rmSync(cacheRaceRoot, { recursive: true, force: true });
  }

  const absoluteEntryRoot = fs.mkdtempSync('/tmp/crate-lock-absolute-entry-');
  try {
    const archiveBytes = Buffer.from('fixture archive');
    const integrity = `sha512-${crypto.createHash('sha512').update(archiveBytes).digest('base64')}`;
    const cachePath = npmCacheContentPath(integrity, absoluteEntryRoot);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, archiveBytes);
    const absoluteEntryRunner = (_command, args) => {
      if (args[0] === '-tzf') {
        return { ok: true, stdout: '/package/package.json\n', stderr: '' };
      }
      if (args[0] === '-tvzf') {
        return { ok: true, stdout: '-rw-r--r-- package/package.json\n', stderr: '' };
      }
      return { ok: false, stdout: '', stderr: '' };
    };
    assert.equal(installedPackageMatchesLockArchive(packageRoot, 'yargs', {
      integrity,
      resolved: 'https://registry.npmjs.org/yargs/-/yargs-fixture.tgz',
    }, {
      commandRunner: absoluteEntryRunner,
      npmCacheRoot: absoluteEntryRoot,
    }), false);

    const duplicateEntryRunner = (_command, args) => {
      if (args[0] === '-tzf') {
        return {
          ok: true,
          stdout: 'package/package.json\npackage/package.json\n',
          stderr: '',
        };
      }
      if (args[0] === '-tvzf') {
        return {
          ok: true,
          stdout: '-rw-r--r-- package/package.json\n-rw-r--r-- package/package.json\n',
          stderr: '',
        };
      }
      return { ok: false, stdout: '', stderr: '' };
    };
    assert.equal(installedPackageMatchesLockArchive(packageRoot, 'yargs', {
      integrity,
      resolved: 'https://registry.npmjs.org/yargs/-/yargs-fixture.tgz',
    }, {
      commandRunner: duplicateEntryRunner,
      npmCacheRoot: absoluteEntryRoot,
    }), false);
  } finally {
    fs.rmSync(absoluteEntryRoot, { recursive: true, force: true });
  }

  const fixtureRoot = fs.mkdtempSync('/tmp/crate-lock-archive-drift-');
  try {
    const copiedPackageRoot = path.join(fixtureRoot, 'yargs');
    fs.cpSync(packageRoot, copiedPackageRoot, { recursive: true });
    fs.appendFileSync(path.join(copiedPackageRoot, 'index.cjs'), '\n// substituted\n');
    assert.equal(
      installedPackageMatchesLockArchive(copiedPackageRoot, 'yargs', metadata),
      false
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }

  const canvasMetadata = lockfile.packages['node_modules/canvas'];
  const canvasRoot = path.join(ROOT, 'node_modules', 'canvas');
  const canvasFixtureRoot = fs.mkdtempSync('/tmp/crate-canvas-rebuild-proof-');
  try {
    const copiedCanvasRoot = path.join(canvasFixtureRoot, 'canvas');
    fs.cpSync(canvasRoot, copiedCanvasRoot, { recursive: true });
    fs.rmSync(path.join(copiedCanvasRoot, 'build'), { recursive: true, force: true });
    for (const entry of APPROVED_CANVAS_PREBUILD_ENTRIES) {
      const outputPath = path.join(copiedCanvasRoot, ...entry.split('/'));
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `reviewed rebuild output for ${entry}`);
    }
    assert.equal(
      installedPackageMatchesLockArchive(copiedCanvasRoot, 'canvas', canvasMetadata, {
        canvasPrebuild: '/tmp/authenticated-canvas-prebuild.tar.gz',
        canvasPrebuildVerifier: () => true,
      }),
      true
    );
    assert.equal(
      installedPackageMatchesLockArchive(copiedCanvasRoot, 'canvas', canvasMetadata),
      false
    );
    const requiredOutput = path.join(copiedCanvasRoot, 'build', 'Release', 'canvas.node');
    fs.rmSync(requiredOutput);
    assert.equal(
      installedPackageMatchesLockArchive(copiedCanvasRoot, 'canvas', canvasMetadata, {
        canvasPrebuild: '/tmp/authenticated-canvas-prebuild.tar.gz',
        canvasPrebuildVerifier: () => true,
      }),
      false
    );
    fs.writeFileSync(requiredOutput, 'reviewed rebuild output for canvas.node');
    fs.writeFileSync(path.join(copiedCanvasRoot, 'build', 'Release', 'unexpected.js'), 'unsafe');
    assert.equal(
      installedPackageMatchesLockArchive(copiedCanvasRoot, 'canvas', canvasMetadata, {
        canvasPrebuild: '/tmp/authenticated-canvas-prebuild.tar.gz',
        canvasPrebuildVerifier: () => true,
      }),
      false
    );
    fs.rmSync(path.join(copiedCanvasRoot, 'build', 'Release', 'unexpected.js'));
    fs.writeFileSync(path.join(copiedCanvasRoot, 'build', 'Release', 'unexpected.dylib'), 'unsafe');
    assert.equal(
      installedPackageMatchesLockArchive(copiedCanvasRoot, 'canvas', canvasMetadata),
      false
    );
    fs.rmSync(path.join(copiedCanvasRoot, 'build', 'Release', 'unexpected.dylib'));
    fs.appendFileSync(path.join(copiedCanvasRoot, 'index.js'), '\n// source drift\n');
    assert.equal(
      installedPackageMatchesLockArchive(copiedCanvasRoot, 'canvas', canvasMetadata),
      false
    );
  } finally {
    fs.rmSync(canvasFixtureRoot, { recursive: true, force: true });
  }
});

test('Electron runtime comparison normalizes the complete nine-state fuse wire', () => {
  const fixtureRoot = fs.mkdtempSync('/tmp/crate-electron-fuse-wire-');
  const packagedApp = path.join(fixtureRoot, 'Crate.app');
  const sourceApp = path.join(fixtureRoot, 'Electron.app');
  const frameworkPath = path.join(
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Versions',
    'A',
    'Electron Framework'
  );
  const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  const runtimeBytes = states => Buffer.concat([
    Buffer.from('mach-o-prefix'),
    sentinel,
    Buffer.from([1, states.length]),
    Buffer.from(states.map(value => value ? 49 : 48)),
    Buffer.from('mach-o-suffix'),
  ]);
  const commandRunner = (command, args) => {
    if (command === '/usr/bin/file') {
      return { ok: true, stdout: 'Mach-O 64-bit executable arm64', stderr: '' };
    }
    if (command === '/usr/bin/codesign' || command === '/usr/bin/strip') {
      return { ok: true, stdout: '', stderr: '' };
    }
    return { ok: false, stdout: '', stderr: '' };
  };

  try {
    for (const [appPath, executableName] of [
      [packagedApp, 'Crate'],
      [sourceApp, 'Electron'],
    ]) {
      const mainPath = path.join(appPath, 'Contents', 'MacOS', executableName);
      fs.mkdirSync(path.dirname(mainPath), { recursive: true });
      fs.writeFileSync(mainPath, 'identical-main-runtime');
      fs.chmodSync(mainPath, 0o755);
      fs.mkdirSync(path.dirname(path.join(appPath, frameworkPath)), { recursive: true });
    }

    fs.writeFileSync(
      path.join(packagedApp, frameworkPath),
      runtimeBytes([false, false, false, false, true, true, false, true, true])
    );
    fs.writeFileSync(
      path.join(sourceApp, frameworkPath),
      runtimeBytes([false, false, false, false, true, true, false, true, false])
    );
    assert.equal(electronRuntimePayloadMatches(
      packagedApp,
      sourceApp,
      'Crate',
      { commandRunner }
    ), true);

    fs.writeFileSync(
      path.join(packagedApp, frameworkPath),
      runtimeBytes([false, false, false, false, true, true, false, true])
    );
    assert.equal(electronRuntimePayloadMatches(
      packagedApp,
      sourceApp,
      'Crate',
      { commandRunner }
    ), false);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('Electron runtime proof binds the dev dependency archive and packaged payload', () => {
  const fixtureRoot = fs.mkdtempSync('/tmp/crate-electron-runtime-proof-');
  const sourceRoot = path.join(fixtureRoot, 'source');
  const appPath = path.join(fixtureRoot, 'Crate.app');
  const archivePath = path.join(fixtureRoot, 'electron.zip');
  const electronVersion = '42.9.0';
  const archiveBytes = Buffer.from('authenticated Electron archive');
  const archiveChecksum = crypto.createHash('sha256').update(archiveBytes).digest('hex');
  const packagedMain = path.join(appPath, 'Contents', 'MacOS', 'Crate');
  const packagedRuntime = path.join(
    appPath,
    'Contents',
    'Frameworks',
    'Runtime.framework',
    'runtime.dat'
  );
  try {
    fs.mkdirSync(path.dirname(packagedMain), { recursive: true });
    fs.mkdirSync(path.dirname(packagedRuntime), { recursive: true });
    fs.writeFileSync(packagedMain, 'runtime-main');
    fs.chmodSync(packagedMain, 0o755);
    fs.writeFileSync(packagedRuntime, 'runtime-framework');
    fs.writeFileSync(archivePath, archiveBytes);

    const sourceManifest = {
      devDependencies: { electron: `^${electronVersion}` },
      name: 'crate-app',
      version: packageJson.version,
    };
    const sourceLockfile = {
      lockfileVersion: 3,
      packages: {
        '': {
          name: sourceManifest.name,
          version: sourceManifest.version,
          devDependencies: sourceManifest.devDependencies,
        },
        'node_modules/electron': {
          version: electronVersion,
          dev: true,
          resolved: `https://registry.npmjs.org/electron/-/electron-${electronVersion}.tgz`,
          integrity: SAFE_INTEGRITY,
        },
      },
    };
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify(sourceManifest));
    fs.writeFileSync(path.join(sourceRoot, 'package-lock.json'), JSON.stringify(sourceLockfile));
    const electronPackageRoot = path.join(sourceRoot, 'node_modules', 'electron');
    fs.mkdirSync(electronPackageRoot, { recursive: true });
    fs.writeFileSync(path.join(electronPackageRoot, 'package.json'), JSON.stringify({
      name: 'electron',
      version: electronVersion,
    }));
    const archiveName = `electron-v${electronVersion}-darwin-arm64.zip`;
    fs.writeFileSync(path.join(electronPackageRoot, 'checksums.json'), JSON.stringify({
      [archiveName]: archiveChecksum,
    }));

    const commandRunner = createFixtureGitRunner(sourceRoot);
    let installedArchiveChecked = false;
    let extractionInputPath = null;
    let replaceOriginalDuringExtraction = false;
    let replaceChecksumsAfterAuthentication = false;
    const options = {
      afterElectronDependencyAuthentication() {
        if (replaceChecksumsAfterAuthentication) {
          fs.writeFileSync(path.join(electronPackageRoot, 'checksums.json'), JSON.stringify({
            [archiveName]: crypto.createHash('sha256').update('attacker archive').digest('hex'),
          }));
        }
      },
      archiveVerifier({ metadata, packageName, packageRoot }) {
        installedArchiveChecked = true;
        return packageName === 'electron' && packageRoot === electronPackageRoot &&
          metadata.dev === true;
      },
      extractElectronArchive(inputPath, outputPath) {
        extractionInputPath = inputPath;
        if (replaceOriginalDuringExtraction) {
          fs.writeFileSync(archivePath, 'path-replaced-after-authentication');
        }
        const electronApp = path.join(outputPath, 'Electron.app');
        const sourceMain = path.join(electronApp, 'Contents', 'MacOS', 'Electron');
        const sourceRuntime = path.join(
          electronApp,
          'Contents',
          'Frameworks',
          'Runtime.framework',
          'runtime.dat'
        );
        fs.mkdirSync(path.dirname(sourceMain), { recursive: true });
        fs.mkdirSync(path.dirname(sourceRuntime), { recursive: true });
        fs.writeFileSync(sourceMain, 'runtime-main');
        fs.chmodSync(sourceMain, 0o755);
        fs.writeFileSync(sourceRuntime, 'runtime-framework');
        fs.writeFileSync(path.join(outputPath, 'LICENSE'), 'license');
        fs.writeFileSync(path.join(outputPath, 'LICENSES.chromium.html'), 'licenses');
        fs.writeFileSync(path.join(outputPath, 'version'), electronVersion);
        return true;
      },
      runtimeFileMatcher(packagedPath, sourcePath) {
        return fs.readFileSync(packagedPath).equals(fs.readFileSync(sourcePath));
      },
      sourceRevision: 'b'.repeat(40),
    };

    assert.deepEqual(collectElectronRuntimeEvidence(
      appPath,
      sourceRoot,
      archivePath,
      'Crate',
      commandRunner,
      options
    ), {
      valid: true,
      lockedVersion: electronVersion,
      archiveVerified: true,
      payloadMatches: true,
    });
    assert.equal(installedArchiveChecked, true);
    assert.notEqual(extractionInputPath, archivePath);

    replaceChecksumsAfterAuthentication = true;
    fs.writeFileSync(archivePath, 'attacker archive');
    assert.equal(collectElectronRuntimeEvidence(
      appPath,
      sourceRoot,
      archivePath,
      'Crate',
      commandRunner,
      options
    ).archiveVerified, false);
    replaceChecksumsAfterAuthentication = false;
    fs.writeFileSync(path.join(electronPackageRoot, 'checksums.json'), JSON.stringify({
      [archiveName]: archiveChecksum,
    }));
    fs.writeFileSync(archivePath, archiveBytes);

    replaceOriginalDuringExtraction = true;
    assert.equal(collectElectronRuntimeEvidence(
      appPath,
      sourceRoot,
      archivePath,
      'Crate',
      commandRunner,
      options
    ).valid, true);
    replaceOriginalDuringExtraction = false;
    fs.writeFileSync(archivePath, archiveBytes);

    sourceManifest.devDependencies.electron = '^99.0.0';
    fs.writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify(sourceManifest));
    assert.equal(collectElectronRuntimeEvidence(
      appPath,
      sourceRoot,
      archivePath,
      'Crate',
      commandRunner,
      options
    ).valid, false);
    sourceManifest.devDependencies.electron = `^${electronVersion}`;
    fs.writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify(sourceManifest));

    fs.chmodSync(packagedRuntime, 0o755);
    assert.equal(collectElectronRuntimeEvidence(
      appPath,
      sourceRoot,
      archivePath,
      'Crate',
      commandRunner,
      options
    ).valid, false);
    fs.chmodSync(packagedRuntime, 0o644);

    fs.chmodSync(packagedMain, 0o644);
    assert.equal(collectElectronRuntimeEvidence(
      appPath,
      sourceRoot,
      archivePath,
      'Crate',
      commandRunner,
      options
    ).valid, false);
    fs.chmodSync(packagedMain, 0o755);

    fs.writeFileSync(packagedRuntime, 'substituted-runtime');
    assert.deepEqual(collectElectronRuntimeEvidence(
      appPath,
      sourceRoot,
      archivePath,
      'Crate',
      commandRunner,
      options
    ), {
      valid: false,
      lockedVersion: electronVersion,
      archiveVerified: true,
      payloadMatches: false,
    });
    fs.writeFileSync(packagedRuntime, 'runtime-framework');

    fs.appendFileSync(archivePath, 'substituted');
    assert.equal(collectElectronRuntimeEvidence(
      appPath,
      sourceRoot,
      archivePath,
      'Crate',
      commandRunner,
      options
    ).archiveVerified, false);
    fs.writeFileSync(archivePath, archiveBytes);

    sourceLockfile.packages['node_modules/electron'].dev = false;
    fs.writeFileSync(path.join(sourceRoot, 'package-lock.json'), JSON.stringify(sourceLockfile));
    assert.equal(collectElectronRuntimeEvidence(
      appPath,
      sourceRoot,
      archivePath,
      'Crate',
      commandRunner,
      options
    ).valid, false);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('Canvas prebuild exception is limited to the reviewed official archive inventory', () => {
  assert.equal(Object.isFrozen(APPROVED_CANVAS_PREBUILD_ENTRIES), true);
  assert.equal(APPROVED_CANVAS_PREBUILD_ENTRIES.includes('build/Release/canvas.node'), true);
  assert.equal(APPROVED_CANVAS_PREBUILD_ENTRIES.includes('build/Release/libcairo.2.dylib'), true);
  assert.equal(APPROVED_CANVAS_PREBUILD_ENTRIES.includes('build/Makefile'), true);
  assert.equal(APPROVED_CANVAS_PREBUILD_ENTRIES.includes('build/Release/.forge-meta'), false);
  for (const unsafeEntry of [
    'build/generated.o',
    'build/Release/postinstall.js',
    'build/Release/unexpected.dylib',
    'build/Debug/canvas.node',
  ]) {
    assert.equal(APPROVED_CANVAS_PREBUILD_ENTRIES.includes(unsafeEntry), false);
  }
});

test('packaged Canvas native output must match the authenticated prebuild', () => {
  const fixtureRoot = fs.mkdtempSync('/tmp/crate-canvas-native-match-');
  try {
    const sourcePath = path.join(fixtureRoot, 'canvas.node');
    fs.writeFileSync(sourcePath, 'authenticated-prebuild');
    const expectedPackage = {
      files: new Map([['build/Release/canvas.node', {
        kind: 'native-custom',
        rawDigest: crypto.createHash('sha256').update('authenticated-prebuild').digest('hex'),
      }]]),
    };
    const matching = new Map([
      ['build/Release/canvas.node', Buffer.from('authenticated-prebuild')],
    ]);
    const substituted = new Map([
      ['build/Release/canvas.node', Buffer.from('substituted-signed-code')],
    ]);
    const options = {
      nativeFileMatcher(packagedBytes, evidence) {
        return crypto.createHash('sha256').update(packagedBytes).digest('hex') ===
          evidence.rawDigest;
      },
    };
    assert.equal(packagePayloadMatches(expectedPackage, matching, options), true);
    assert.equal(packagePayloadMatches(expectedPackage, substituted, options), false);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('dependency proof accepts only byte-identical Electron Builder deduplication', () => {
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const expectedPackage = (name, root, body, dependencies = {}) => ({
    files: new Map([
      ['package.json', {
        kind: 'manifest',
        value: { dependencies, name, version: '1.0.0' },
      }],
      ['index.js', { kind: 'ordinary', rawDigest: digest(body) }],
    ]),
    name,
    root,
    version: '1.0.0',
  });
  const actualPackage = (name, root, body, dependencies = {}, version = '1.0.0') => ({
    files: new Map([
      ['package.json', Buffer.from(JSON.stringify({ dependencies, name, version }))],
      ['index.js', Buffer.from(body)],
    ]),
    name,
    root,
    version,
  });
  const sourceManifest = {
    dependencies: { first: '1.0.0', second: '1.0.0' },
  };
  const sourceLockfile = {
    packages: {
      'node_modules/first': { dependencies: { shared: '1.0.0' } },
      'node_modules/first/node_modules/shared': {},
      'node_modules/second': { dependencies: { shared: '1.0.0' } },
      'node_modules/second/node_modules/shared': {},
    },
  };
  const expected = new Map([
    ['node_modules/first', expectedPackage(
      'first',
      'node_modules/first',
      'first',
      { shared: '1.0.0' }
    )],
    ['node_modules/first/node_modules/shared', expectedPackage(
      'shared',
      'node_modules/first/node_modules/shared',
      'approved'
    )],
    ['node_modules/second', expectedPackage(
      'second',
      'node_modules/second',
      'second',
      { shared: '1.0.0' }
    )],
    ['node_modules/second/node_modules/shared', expectedPackage(
      'shared',
      'node_modules/second/node_modules/shared',
      'approved'
    )],
  ]);
  const hoisted = new Map([
    ['node_modules/first', actualPackage(
      'first',
      'node_modules/first',
      'first',
      { shared: '1.0.0' }
    )],
    ['node_modules/second', actualPackage(
      'second',
      'node_modules/second',
      'second',
      { shared: '1.0.0' }
    )],
    ['node_modules/shared', actualPackage('shared', 'node_modules/shared', 'approved')],
  ]);

  assert.equal(dependencyPackageInventoriesMatch(
    expected,
    hoisted,
    sourceManifest,
    sourceLockfile
  ), true);
  assert.equal(dependencyPackageInventoriesMatch(expected, new Map([
    ...hoisted,
    ['node_modules/shared', actualPackage('shared', 'node_modules/shared', 'substituted')],
  ]), sourceManifest, sourceLockfile), false);
  const wrongVersion = new Map(hoisted);
  wrongVersion.set(
    'node_modules/shared',
    actualPackage('shared', 'node_modules/shared', 'approved', {}, '2.0.0')
  );
  assert.equal(dependencyPackageInventoriesMatch(
    expected,
    wrongVersion,
    sourceManifest,
    sourceLockfile
  ), false);

  const conflictingExpected = new Map(expected);
  conflictingExpected.set(
    'node_modules/second/node_modules/shared',
    expectedPackage(
      'shared',
      'node_modules/second/node_modules/shared',
      'different-approved-copy'
    )
  );
  assert.equal(dependencyPackageInventoriesMatch(
    conflictingExpected,
    hoisted,
    sourceManifest,
    sourceLockfile
  ), false);
  const extraActual = new Map(hoisted);
  extraActual.set(
    'node_modules/unapproved/node_modules/shared',
    actualPackage('shared', 'node_modules/unapproved/node_modules/shared', 'approved')
  );
  assert.equal(dependencyPackageInventoriesMatch(
    expected,
    extraActual,
    sourceManifest,
    sourceLockfile
  ), false);
});

test('signed-app verification isolates a private snapshot and rejects source or snapshot drift', () => {
  const fixtureRoot = fs.mkdtempSync('/tmp/crate-private-app-snapshot-');
  const appPath = path.join(fixtureRoot, 'Crate.app');
  const payloadPath = path.join(appPath, 'Contents', 'Resources', 'payload');
  let snapshot = null;
  try {
    fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
    fs.writeFileSync(payloadPath, 'approved');
    snapshot = createPrivateAppSnapshot(appPath, { temporaryParent: fixtureRoot });
    const snapshotRoot = path.dirname(snapshot.appPath);
    const snapshotPayload = path.join(snapshot.appPath, 'Contents', 'Resources', 'payload');
    assert.notEqual(snapshot.appPath, appPath);
    assert.equal(fs.lstatSync(snapshotRoot).mode & 0o077, 0);
    assert.equal(fs.readFileSync(snapshotPayload, 'utf8'), 'approved');

    fs.writeFileSync(payloadPath, 'source changed after snapshot');
    assert.equal(fs.readFileSync(snapshotPayload, 'utf8'), 'approved');
    assert.equal(snapshot.isStable(), false);
    fs.writeFileSync(payloadPath, 'approved');
    assert.equal(snapshot.isStable(), true);

    fs.writeFileSync(snapshotPayload, 'snapshot changed');
    assert.equal(snapshot.isStable(), false);
    assert.equal(snapshot.cleanup(), true);
    assert.equal(fs.existsSync(snapshotRoot), false);
    snapshot = null;
  } finally {
    if (snapshot) snapshot.cleanup();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('release-proof bootstrap authenticates local sources and hides startup failures', async () => {
  const fixtureRoot = fs.mkdtempSync('/tmp/crate-release-bootstrap-');
  const revision = 'd'.repeat(40);
  const committedObjects = new Map();
  const graftPath = path.join(fixtureRoot, '.git', 'info', 'grafts');
  try {
    for (const relativePath of AUTHENTICATED_SOURCE_FILES) {
      const absolutePath = path.join(fixtureRoot, relativePath);
      const bytes = Buffer.from(`approved ${relativePath}\n`);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, bytes);
      committedObjects.set(
        relativePath,
        crypto.createHash('sha1')
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest('hex')
      );
    }
    const commandRunner = (command, args, options = {}) => {
      const gitArgs = args.slice(args.indexOf('core.untrackedCache=false') + 1);
      if (gitArgs[0] === 'rev-parse' && gitArgs[1] === '--show-toplevel') {
        return { ok: true, stdout: `${fixtureRoot}\n`, stderr: '' };
      }
      if (gitArgs[0] === 'rev-parse' && gitArgs[1] === '--verify') {
        return { ok: true, stdout: `${revision}\n`, stderr: '' };
      }
      if (gitArgs[0] === 'rev-parse' && gitArgs[1] === '--git-path') {
        return { ok: true, stdout: `${graftPath}\n`, stderr: '' };
      }
      if (gitArgs[0] === 'replace') return { ok: true, stdout: '', stderr: '' };
      if (gitArgs[0] === 'status') return { ok: true, stdout: '', stderr: '' };
      if (gitArgs[0] === 'ls-tree') {
        const relativePath = gitArgs.at(-1);
        return {
          ok: committedObjects.has(relativePath),
          stdout: committedObjects.has(relativePath)
            ? `100644 blob ${committedObjects.get(relativePath)}\t${relativePath}\n`
            : '',
          stderr: '',
        };
      }
      if (gitArgs[0] === 'hash-object') {
        const bytes = Buffer.from(options.input || '');
        return {
          ok: true,
          stdout: `${crypto.createHash('sha1')
            .update(`blob ${bytes.length}\0`)
            .update(bytes)
            .digest('hex')}\n`,
          stderr: '',
        };
      }
      return { ok: false, stdout: '', stderr: '' };
    };
    assert.equal(sourceFilesMatchRevision(fixtureRoot, revision, commandRunner), true);
    fs.mkdirSync(path.dirname(graftPath), { recursive: true });
    fs.writeFileSync(graftPath, `${revision} ${'e'.repeat(40)}\n`);
    assert.equal(sourceFilesMatchRevision(fixtureRoot, revision, commandRunner), false);
    fs.rmSync(path.join(fixtureRoot, '.git'), { recursive: true, force: true });
    fs.writeFileSync(
      path.join(fixtureRoot, 'scripts', 'verify-app-contents.js'),
      'substituted after commit\n'
    );
    assert.equal(sourceFilesMatchRevision(fixtureRoot, revision, commandRunner), false);

    const errors = [];
    const exitCodes = [];
    const result = await runBootstrap([
      '/private/Crate.app',
      '--expected-revision',
      revision,
    ], {
      commandRunner,
      loadVerifier() {
        throw new Error('/Users/example/private/verifier-module.js failed');
      },
      setExitCode: code => exitCodes.push(code),
      sourceRoot: fixtureRoot,
      verifySource: () => true,
      writeError: message => errors.push(message),
    });
    assert.deepEqual(result, { exitCode: 1, result: null });
    assert.deepEqual(errors, ['Crate signed-app policy failed.']);
    assert.deepEqual(exitCodes, [1]);
    assert.equal(errors.join('\n').includes('/Users/example'), false);

    const direct = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'verify-macos-release-app.js'),
      '/Users/example/private/Crate.app',
    ], { encoding: 'utf8' });
    assert.equal(direct.status, 2);
    assert.equal(direct.stdout, '');
    assert.equal(direct.stderr.trim(), 'Crate signed-app policy failed.');
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('release-proof bootstrap binds authenticated tools and rechecks after execution', async () => {
  const revision = 'e'.repeat(40);
  const asar = createFakeAsar(new Map());
  const getFuseWire = async () => new Uint8Array();
  const calls = [];
  let sourceChecks = 0;
  let toolRechecks = 0;
  const successOutputs = [];
  const verifier = {
    authenticateVerifierToolchain(sourceRoot, options) {
      calls.push({ options, sourceRoot, type: 'authenticate' });
      return {
        recheck() {
          toolRechecks += 1;
          return true;
        },
        tools: { asar, getFuseWire },
        valid: true,
      };
    },
    async runCli(argv, dependencies) {
      calls.push({ argv, dependencies, type: 'run' });
      dependencies.writeOutput('{"releaseReady":true}');
      return { exitCode: 0, result: { ok: true } };
    },
  };
  const result = await runBootstrap([
    '/private/Crate.app',
    '--expected-revision',
    revision,
  ], {
    loadVerifier: () => verifier,
    npmCacheRoot: '/private/npm-cache',
    sourceRoot: '/private/source',
    verifySource() {
      sourceChecks += 1;
      return true;
    },
    writeOutput: message => successOutputs.push(message),
  });
  assert.deepEqual(result, { exitCode: 0, result: { ok: true } });
  assert.equal(sourceChecks, 2);
  assert.equal(toolRechecks, 1);
  assert.equal(calls[0].options.npmCacheRoot, '/private/npm-cache');
  assert.equal(calls[1].dependencies.asar, asar);
  assert.equal(calls[1].dependencies.getFuseWire, getFuseWire);
  assert.deepEqual(successOutputs, ['{"releaseReady":true}']);

  let runCalled = false;
  const invalidErrors = [];
  const invalidExitCodes = [];
  const invalid = await runBootstrap([
    '/private/Crate.app',
    '--expected-revision',
    revision,
  ], {
    loadVerifier: () => ({
      authenticateVerifierToolchain: () => ({ valid: false }),
      runCli: async () => {
        runCalled = true;
        return { exitCode: 0, result: null };
      },
    }),
    setExitCode: code => invalidExitCodes.push(code),
    sourceRoot: '/private/source',
    verifySource: () => true,
    writeError: message => invalidErrors.push(message),
  });
  assert.deepEqual(invalid, { exitCode: 1, result: null });
  assert.equal(runCalled, false);
  assert.deepEqual(invalidErrors, ['Crate signed-app policy failed.']);
  assert.deepEqual(invalidExitCodes, [1]);

  const driftErrors = [];
  const driftExitCodes = [];
  const driftOutputs = [];
  const drift = await runBootstrap([
    '/private/Crate.app',
    '--expected-revision',
    revision,
  ], {
    loadVerifier: () => ({
      authenticateVerifierToolchain: () => ({
        recheck: () => false,
        tools: { asar, getFuseWire },
        valid: true,
      }),
      runCli: async (argv, runDependencies) => {
        runDependencies.writeOutput('{"releaseReady":true}');
        return { exitCode: 0, result: { ok: true } };
      },
    }),
    setExitCode: code => driftExitCodes.push(code),
    sourceRoot: '/private/source',
    verifySource: () => true,
    writeError: message => driftErrors.push(message),
    writeOutput: message => driftOutputs.push(message),
  });
  assert.deepEqual(drift, { exitCode: 1, result: null });
  assert.deepEqual(driftErrors, ['Crate signed-app policy failed.']);
  assert.deepEqual(driftExitCodes, [1]);
  assert.deepEqual(driftOutputs, []);
});

test('artifact collector exercises macOS metadata, signatures, fuses, and source binding', async () => {
  const fixtureRoot = fs.mkdtempSync('/tmp/crate-release-collector-');
  const appPath = path.join(fixtureRoot, 'Crate.app');
  const sourceRoot = path.join(fixtureRoot, 'source');
  const contentsPath = path.join(appPath, 'Contents');
  const executableName = 'Crate';
  try {
    for (const directory of [
      'Frameworks',
      'MacOS',
      'Resources/app.asar.unpacked',
      'Resources/en.lproj',
      '_CodeSignature',
    ]) {
      fs.mkdirSync(path.join(contentsPath, directory), { recursive: true });
    }
    for (const file of [
      'CodeResources',
      'Info.plist',
      'Resources/app-update.yml',
      'Resources/app.asar',
      'Resources/icon.icns',
      '_CodeSignature/CodeResources',
      `MacOS/${executableName}`,
    ]) {
      fs.writeFileSync(path.join(contentsPath, file), 'fixture');
    }
    fs.writeFileSync(
      path.join(contentsPath, 'Resources', 'app-update.yml'),
      'owner: bfeintuch123\n' +
      'repo: crate-app\n' +
      'provider: github\n' +
      'updaterCacheDirName: crate-app-updater\n'
    );
    fs.writeFileSync(path.join(contentsPath, 'PkgInfo'), 'APPL????');
    fs.chmodSync(path.join(contentsPath, 'MacOS', executableName), 0o755);
    const nativeHelperBytes = syntheticNativeHelperBytes('collector-helper');
    const nativeHelperPath = writeNativeHelperResource(
      path.join(contentsPath, 'Resources'),
      nativeHelperBytes
    );
    const helperNames = [
      'Crate Helper.app',
      'Crate Helper (GPU).app',
      'Crate Helper (Plugin).app',
      'Crate Helper (Renderer).app',
    ];
    for (const name of helperNames) {
      const helperContents = path.join(contentsPath, 'Frameworks', name, 'Contents');
      fs.mkdirSync(helperContents, { recursive: true });
      fs.writeFileSync(path.join(helperContents, 'Info.plist'), 'fixture');
    }
    for (const name of [
      'Electron Framework.framework',
      'Mantle.framework',
      'ReactiveObjC.framework',
      'Squirrel.framework',
    ]) {
      fs.mkdirSync(path.join(contentsPath, 'Frameworks', name), { recursive: true });
    }

    for (const entry of SOURCE_BOUND_ENTRIES) {
      const sourcePath = path.join(sourceRoot, ...entry.split('/'));
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, `safe bytes for ${entry}`);
    }
    for (const entry of EXTERNAL_SOURCE_BOUND_ENTRIES) {
      const sourcePath = path.join(sourceRoot, ...entry.source.split('/'));
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, 'fixture');
    }
    for (const name of NATIVE_HELPER_SOURCE_FILES) {
      const sourcePath = path.join(sourceRoot, ...NATIVE_HELPER_SOURCE_DIR.split('/'), name);
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, `// synthetic collector Swift source ${name}\n`);
    }
    const nativeHelperCompilations = [];
    const nativeHelperCompiler = sources => {
      nativeHelperCompilations.push(Object.keys(sources));
      return Buffer.from(nativeHelperBytes);
    };
    const sourceManifest = {
      dependencies: { 'runtime-dep': '^1.0.0' },
      description: 'safe',
      devDependencies: { electron: '^42.9.0' },
      main: 'main.js',
      name: 'crate-app',
      overrides: packageJson.overrides,
      productName: 'Crate',
      version: packageJson.version,
    };
    const packagedManifest = {
      dependencies: sourceManifest.dependencies,
      description: sourceManifest.description,
      main: sourceManifest.main,
      name: sourceManifest.name,
      overrides: sourceManifest.overrides,
      productName: sourceManifest.productName,
      version: sourceManifest.version,
    };
    fs.writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify(sourceManifest));
    fs.writeFileSync(path.join(sourceRoot, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {
          name: sourceManifest.name,
          version: sourceManifest.version,
          dependencies: sourceManifest.dependencies,
          devDependencies: sourceManifest.devDependencies,
        },
        'node_modules/electron': {
          version: '42.9.0',
          dev: true,
          resolved: 'https://registry.npmjs.org/electron/-/electron-safe.tgz',
          integrity: SAFE_INTEGRITY,
        },
        'node_modules/runtime-dep': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/runtime-dep/-/runtime-dep-safe.tgz',
          integrity: SAFE_INTEGRITY,
        },
      },
    }));
    const dependencyManifest = JSON.stringify({
      name: 'runtime-dep',
      version: '1.0.0',
      main: 'index.js',
    });
    const dependencyRoot = path.join(sourceRoot, 'node_modules', 'runtime-dep');
    fs.mkdirSync(dependencyRoot, { recursive: true });
    fs.writeFileSync(path.join(dependencyRoot, 'package.json'), dependencyManifest);
    fs.writeFileSync(path.join(dependencyRoot, 'index.js'), 'module.exports = "safe";');
    const asarFiles = new Map([
      ['package.json', JSON.stringify(packagedManifest)],
      ['node_modules/runtime-dep/package.json', dependencyManifest],
      ['node_modules/runtime-dep/index.js', 'module.exports = "safe";'],
    ]);
    for (const entry of SOURCE_BOUND_ENTRIES) {
      asarFiles.set(entry, fs.readFileSync(path.join(sourceRoot, ...entry.split('/'))));
    }
    const asarHeader = 'fixture-asar-header';
    const asar = createFakeAsar(asarFiles, asarHeader);
    const asarIntegrityHash = crypto.createHash('sha256').update(asarHeader).digest('hex');
    const mainInfo = safeMainInfo();
    mainInfo.ElectronAsarIntegrity['Resources/app.asar'].hash = asarIntegrityHash;
    const helperIdentifiers = {
      'Crate Helper.app': `${PUBLIC_APP_ID}.helper`,
      'Crate Helper (GPU).app': `${PUBLIC_APP_ID}.helper.GPU`,
      'Crate Helper (Plugin).app': `${PUBLIC_APP_ID}.helper.Plugin`,
      'Crate Helper (Renderer).app': `${PUBLIC_APP_ID}.helper.Renderer`,
      'Electron Framework.framework': 'com.github.Electron.framework',
      'Mantle.framework': 'com.electron.mantle',
      'ReactiveObjC.framework': 'com.electron.reactive',
      'Squirrel.framework': 'com.github.Squirrel',
      'crate-helper': NATIVE_HELPER_IDENTIFIER,
    };
    const gitRunner = createFixtureGitRunner(sourceRoot);
    const commandCalls = [];
    const commandRunner = (command, args, options = {}) => {
      commandCalls.push({ command, args: [...args] });
      const target = args[args.length - 1];
      if (command === '/usr/bin/git') {
        return gitRunner(command, args, options);
      }
      if (command === '/usr/bin/plutil') {
        if (options.input) {
          const entitlements = options.input.includes('main-entitlements')
            ? Object.fromEntries(EXPECTED_MAIN_ENTITLEMENTS.map(key => [key, true]))
            : options.input.includes('helper-entitlements')
              ? Object.fromEntries(EXPECTED_HELPER_ENTITLEMENTS.map(key => [key, true]))
              : {};
          return { ok: true, stdout: JSON.stringify(entitlements), stderr: '' };
        }
        const helperName = Object.keys(helperIdentifiers).find(name => (
          name.endsWith('.app') && String(target).includes(`${name}/Contents/Info.plist`)
        ));
        return {
          ok: true,
          stdout: JSON.stringify(helperName ? safeHelperInfo(helperName) : mainInfo),
          stderr: '',
        };
      }
      if (command === '/usr/bin/codesign' && args.includes('--entitlements')) {
        const marker = target === appPath ? 'main-entitlements' :
          target.endsWith('.app') || target === nativeHelperPath
            ? 'helper-entitlements'
            : 'framework-entitlements';
        return {
          ok: true,
          stdout: `<?xml version="1.0"?><plist><dict><key>${marker}</key><true/></dict></plist>`,
          stderr: '',
        };
      }
      if (command === '/usr/bin/codesign' && args[0] === '-dv') {
        const name = path.basename(target);
        const identifier = target === appPath ? PUBLIC_APP_ID : helperIdentifiers[name];
        return { ok: true, stdout: '', stderr: signedMetadata(identifier, 'd') };
      }
      if (command === '/usr/bin/codesign' || command === '/usr/sbin/spctl' ||
          command === '/usr/bin/xcrun' || command === '/usr/bin/strip') {
        return { ok: true, stdout: '', stderr: '' };
      }
      return { ok: false, stdout: '', stderr: '' };
    };
    const fuseWire = { version: 1 };
    for (const [index, value] of Object.values(EXPECTED_FUSES).entries()) {
      fuseWire[index] = value;
    }
    const electronRuntime = safeEvidence().electronRuntime;

    const evidence = await collectReleaseEvidence(appPath, {
      archiveVerifier: () => true,
      asar,
      commandRunner,
      createAppSnapshot: passThroughAppSnapshot,
      expectedExecutableName: executableName,
      getFuseWire: async () => fuseWire,
      nativeHelperCompiler,
      inspectArchitectures: () => ({
        valid: true,
        expected: EXPECTED_ARCHITECTURE,
        main: [EXPECTED_ARCHITECTURE],
        machOBinaryCount: 12,
      }),
      requireNotarization: true,
      sourceRoot,
      expectedRevision: 'b'.repeat(40),
      verifyVerifierSource: () => true,
      verifyElectronRuntime: () => electronRuntime,
      verifyPackagedContents: () => ({ asarEntryCount: 100, unpackedEntryCount: 10 }),
    });
    assert.equal(evidence.bundleLayout.valid, true);
    assert.equal(evidence.artifactStable, true);
    assert.equal(evidence.helpers.length, 4);
    assert.equal(evidence.nestedBundles.length, 4);
    assert.deepEqual(evidence.nativeHelper.signature, {
      valid: true,
      ...parseCodeSignatureMetadata(signedMetadata(NATIVE_HELPER_IDENTIFIER, 'd')),
    });
    assert.equal(evidence.nativeHelper.resourceValid, true);
    assert.equal(evidence.nativeHelper.strictRequirementValid, true);
    assert.equal(evidence.nativeHelper.sourceBound, true);
    assert.deepEqual(nativeHelperCompilations, [[...NATIVE_HELPER_SOURCE_FILES]]);
    assert.deepEqual(evaluateReleaseEvidence(evidence, releaseOptions()).failures, []);
    assert.equal(evaluateReleaseEvidence(evidence, releaseOptions()).ok, true);

    const recordedCommandCallCount = commandCalls.length;
    const disabledWasmWire = { ...fuseWire, 8: false };
    const disabledWasmEvidence = await collectReleaseEvidence(appPath, {
      archiveVerifier: () => true,
      asar,
      commandRunner,
      createAppSnapshot: passThroughAppSnapshot,
      expectedExecutableName: executableName,
      getFuseWire: async () => disabledWasmWire,
      nativeHelperCompiler,
      inspectArchitectures: () => ({
        valid: true,
        expected: EXPECTED_ARCHITECTURE,
        main: [EXPECTED_ARCHITECTURE],
        machOBinaryCount: 12,
      }),
      requireNotarization: true,
      sourceRoot,
      expectedRevision: 'b'.repeat(40),
      verifyVerifierSource: () => true,
      verifyElectronRuntime: () => electronRuntime,
      verifyPackagedContents: () => ({ asarEntryCount: 100, unpackedEntryCount: 10 }),
    });
    assert.equal(disabledWasmEvidence.fuses.WasmTrapHandlers, false);
    assert.equal(
      evaluateReleaseEvidence(disabledWasmEvidence, releaseOptions()).failures.includes(
        'Electron fuse policy changed: WasmTrapHandlers.'
      ),
      true
    );
    commandCalls.splice(recordedCommandCallCount);
    const trustRequirementCalls = commandCalls.filter(call => (
      call.command === '/usr/bin/codesign' &&
      call.args.some(argument => argument.startsWith('-R=anchor apple generic'))
    ));
    assert.equal(trustRequirementCalls.length, 11);
    assert.equal(trustRequirementCalls.every(call => call.args.some(argument => (
      argument.includes('field.1.2.840.113635.100.6.1.13') &&
      argument.includes(`subject.OU] = "${PUBLIC_TEAM_ID}"`)
    ))), true);
    assert.deepEqual(commandCalls.filter(call => (
      call.command === '/usr/bin/codesign' &&
      call.args.includes(`-R=${EXPECTED_NATIVE_HELPER_REQUIREMENT}`)
    )), [{
      command: '/usr/bin/codesign',
      args: ['--verify', '--strict', '--verbose=4', `-R=${EXPECTED_NATIVE_HELPER_REQUIREMENT}`, nativeHelperPath],
    }]);
    assert.deepEqual(commandCalls.filter(call => (
      call.command === '/usr/sbin/spctl' || call.command === '/usr/bin/xcrun'
    )), [
      {
        command: '/usr/sbin/spctl',
        args: ['--assess', '--type', 'execute', '--verbose=4', appPath],
      },
      {
        command: '/usr/bin/xcrun',
        args: ['stapler', 'validate', appPath],
      },
      {
        command: '/usr/sbin/spctl',
        args: ['--assess', '--type', 'execute', '--verbose=4', appPath],
      },
      {
        command: '/usr/bin/xcrun',
        args: ['stapler', 'validate', appPath],
      },
    ]);

    const failedSignatureEvidence = await collectReleaseEvidence(appPath, {
      archiveVerifier: () => true,
      asar,
      createAppSnapshot: passThroughAppSnapshot,
      commandRunner(command, args, options) {
        if (command === '/usr/bin/codesign' && args[0] === '--verify' && args.includes('--deep')) {
          return { ok: false, stdout: '', stderr: '' };
        }
        return commandRunner(command, args, options);
      },
      expectedExecutableName: executableName,
      getFuseWire: async () => fuseWire,
      inspectArchitectures: () => ({
        valid: true,
        expected: EXPECTED_ARCHITECTURE,
        main: [EXPECTED_ARCHITECTURE],
        machOBinaryCount: 12,
      }),
      requireNotarization: true,
      sourceRoot,
      expectedRevision: 'b'.repeat(40),
      verifyVerifierSource: () => true,
      verifyElectronRuntime: () => electronRuntime,
      verifyPackagedContents: () => ({ asarEntryCount: 100, unpackedEntryCount: 10 }),
    });
    assert.equal(
      evaluateReleaseEvidence(failedSignatureEvidence, releaseOptions()).failures.includes(
        'Code signature verification failed.'
      ),
      true
    );

    const failedTrustEvidence = await collectReleaseEvidence(appPath, {
      archiveVerifier: () => true,
      asar,
      createAppSnapshot: passThroughAppSnapshot,
      commandRunner(command, args, options) {
        if (command === '/usr/bin/codesign' &&
            args.some(argument => argument.startsWith('-R=anchor apple generic'))) {
          return { ok: false, stdout: '', stderr: '' };
        }
        return commandRunner(command, args, options);
      },
      expectedExecutableName: executableName,
      getFuseWire: async () => fuseWire,
      inspectArchitectures: () => ({
        valid: true,
        expected: EXPECTED_ARCHITECTURE,
        main: [EXPECTED_ARCHITECTURE],
        machOBinaryCount: 12,
      }),
      requireNotarization: true,
      sourceRoot,
      expectedRevision: 'b'.repeat(40),
      verifyVerifierSource: () => true,
      verifyElectronRuntime: () => electronRuntime,
      verifyPackagedContents: () => ({ asarEntryCount: 100, unpackedEntryCount: 10 }),
    });
    const failedTrust = evaluateReleaseEvidence(failedTrustEvidence, releaseOptions());
    assert.equal(failedTrust.failures.includes('Code signature verification failed.'), true);
    assert.equal(failedTrust.failures.includes('Helper app signature policy changed.'), true);
    assert.equal(failedTrust.failures.includes('Nested code-signature policy changed.'), true);
    assert.equal(failedTrust.failures.includes(NATIVE_HELPER_FAILURES.signature), true);

    const nativeOptions = {
      archiveVerifier: () => true,
      asar,
      commandRunner,
      createAppSnapshot: passThroughAppSnapshot,
      expectedExecutableName: executableName,
      getFuseWire: async () => fuseWire,
      inspectArchitectures: () => ({
        valid: true,
        expected: EXPECTED_ARCHITECTURE,
        main: [EXPECTED_ARCHITECTURE],
        machOBinaryCount: 12,
      }),
      nativeHelperCompiler,
      requireNotarization: true,
      sourceRoot,
      expectedRevision: 'b'.repeat(40),
      verifyVerifierSource: () => true,
      verifyElectronRuntime: () => electronRuntime,
      verifyPackagedContents: () => ({ asarEntryCount: 100, unpackedEntryCount: 10 }),
    };
    const rebuiltMismatch = await collectReleaseEvidence(appPath, {
      ...nativeOptions,
      nativeHelperCompiler: () => syntheticNativeHelperBytes('different-helper'),
    });
    assert.equal(rebuiltMismatch.nativeHelper.sourceBound, false);
    assert.deepEqual(
      evaluateReleaseEvidence(rebuiltMismatch, releaseOptions()).failures,
      [NATIVE_HELPER_FAILURES.source]
    );

    let checkoutDrifted = false;
    const driftedCheckout = await collectReleaseEvidence(appPath, {
      ...nativeOptions,
      commandRunner(command, args, options) {
        const gitArgs = normalizeFixtureGitArgs(args);
        if (checkoutDrifted && command === '/usr/bin/git' && gitArgs[0] === 'status') {
          return { ok: true, stdout: ` M ${NATIVE_HELPER_SOURCE_DIR}/main.swift\n`, stderr: '' };
        }
        return commandRunner(command, args, options);
      },
      nativeHelperCompiler(sources) {
        checkoutDrifted = true;
        return nativeHelperCompiler(sources);
      },
    });
    assert.equal(checkoutDrifted, true);
    assert.equal(driftedCheckout.nativeHelper.sourceBound, false);
    assert.equal(driftedCheckout.sourceBinding.releaseSourceClean, false);
    assert.equal(
      evaluateReleaseEvidence(driftedCheckout, releaseOptions()).failures.includes(
        NATIVE_HELPER_FAILURES.source
      ),
      true
    );

    fs.chmodSync(nativeHelperPath, 0o644);
    const rejectedHelper = await collectReleaseEvidence(appPath, nativeOptions);
    assert.equal(rejectedHelper.bundleLayout.valid, false);
    assert.equal(rejectedHelper.nativeHelper.resourceValid, false);
    assert.equal(
      evaluateReleaseEvidence(rejectedHelper, releaseOptions()).failures.includes(
        NATIVE_HELPER_FAILURES.resource
      ),
      true
    );
    fs.chmodSync(nativeHelperPath, 0o755);

    const originalAppPath = `${appPath}.original`;
    const replacedEvidence = await collectReleaseEvidence(appPath, {
      archiveVerifier: () => true,
      asar,
      commandRunner,
      createAppSnapshot: passThroughAppSnapshot,
      expectedExecutableName: executableName,
      getFuseWire: async () => fuseWire,
      inspectArchitectures: () => ({
        valid: true,
        expected: EXPECTED_ARCHITECTURE,
        main: [EXPECTED_ARCHITECTURE],
        machOBinaryCount: 12,
      }),
      requireNotarization: true,
      sourceRoot,
      expectedRevision: 'b'.repeat(40),
      verifyVerifierSource: () => true,
      verifyElectronRuntime: () => electronRuntime,
      verifyPackagedContents: () => ({ asarEntryCount: 100, unpackedEntryCount: 10 }),
      beforeFinalArtifactIdentityConfirmation() {
        fs.renameSync(appPath, originalAppPath);
        fs.mkdirSync(appPath);
      },
    });
    assert.equal(replacedEvidence.artifactStable, false);
    assert.equal(
      evaluateReleaseEvidence(replacedEvidence, releaseOptions()).failures.includes(
        'Signed app changed during verification.'
      ),
      true
    );
    fs.rmdirSync(appPath);
    fs.renameSync(originalAppPath, appPath);

    const tamperMarker = path.join(appPath, 'Contents', 'Resources', 'post-check-tamper');
    const tamperedEvidence = await collectReleaseEvidence(appPath, {
      archiveVerifier: () => true,
      asar,
      createAppSnapshot: passThroughAppSnapshot,
      commandRunner(command, args, options) {
        if (command === '/usr/bin/codesign' && args[0] === '--verify' &&
            args.includes('--deep') && fs.existsSync(tamperMarker)) {
          return { ok: false, stdout: '', stderr: '' };
        }
        return commandRunner(command, args, options);
      },
      expectedExecutableName: executableName,
      getFuseWire: async () => fuseWire,
      inspectArchitectures: () => ({
        valid: true,
        expected: EXPECTED_ARCHITECTURE,
        main: [EXPECTED_ARCHITECTURE],
        machOBinaryCount: 12,
      }),
      requireNotarization: true,
      sourceRoot,
      expectedRevision: 'b'.repeat(40),
      verifyVerifierSource: () => true,
      verifyElectronRuntime: () => electronRuntime,
      verifyPackagedContents: () => ({ asarEntryCount: 100, unpackedEntryCount: 10 }),
      beforeFinalArtifactIdentityConfirmation() {
        fs.writeFileSync(tamperMarker, 'changed after the initial artifact inspection');
      },
    });
    assert.equal(tamperedEvidence.artifactStable, false);
    assert.equal(
      evaluateReleaseEvidence(tamperedEvidence, releaseOptions()).failures.includes(
        'Signed app changed during verification.'
      ),
      true
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('contained QA mode is explicit and does not claim notarization proof', () => {
  const evidence = safeEvidence();
  evidence.notarization = {
    required: false,
    gatekeeperAccepted: null,
    stapleValid: null,
  };
  const result = evaluateReleaseEvidence(evidence, releaseOptions());

  assert.equal(result.ok, true);
  assert.equal(result.proof.checks.notarization, 'not-required');
  assert.equal(result.proof.checks.dependencyLock, 'pass');
  assert.equal(result.proof.releaseReady, false);

  evidence.sourceBinding.dependencyLockMatches = false;
  const dependencyFailure = evaluateReleaseEvidence(evidence, releaseOptions());
  assert.equal(dependencyFailure.ok, false);
  assert.equal(
    dependencyFailure.failures.includes(
      'Packaged dependency payload does not match the reconstructed production dependency tree.'
    ),
    true
  );
  assert.equal(dependencyFailure.proof.checks.dependencyLock, 'fail');
});

test('proof binds to safe code and source fingerprints without local metadata', () => {
  const proof = evaluateReleaseEvidence(safeEvidence(), releaseOptions()).proof;
  const serialized = JSON.stringify(proof);

  assert.equal(serialized.includes('/Users/example'), false);
  assert.equal(serialized.includes('Private Signer Name'), false);
  assert.equal(serialized.includes('a'.repeat(64)), false);
  assert.equal(serialized.includes('Timestamp'), false);
  assert.equal(serialized.includes('Crate.app'), false);
  assert.equal(proof.artifact.codeDirectoryHash, 'c'.repeat(64));
  assert.equal(proof.artifact.sourceRevision, 'b'.repeat(40));
  assert.deepEqual(Object.keys(proof.artifact).sort(), [
    'buildVersion',
    'bundleIdentifier',
    'codeDirectoryHash',
    'kind',
    'productName',
    'sourceRevision',
    'teamIdentifier',
    'version',
  ]);
});

test('failed JSON proof nulls hostile metadata instead of reflecting paths or controls', () => {
  const evidence = safeEvidence();
  const hostile = '/Users/private/Secret\nInjected';
  evidence.infoPlist.CFBundleIdentifier = hostile;
  evidence.infoPlist.CFBundleShortVersionString = hostile;
  evidence.infoPlist.CFBundleVersion = hostile;
  evidence.signature.identifier = hostile;
  evidence.signature.teamIdentifier = hostile;
  evidence.signature.codeDirectoryHash = hostile;
  evidence.sourceBinding.revision = hostile;
  const result = evaluateReleaseEvidence(evidence, releaseOptions());
  const serialized = JSON.stringify(result.proof);

  assert.equal(result.ok, false);
  assert.equal(serialized.includes('/Users/private'), false);
  assert.equal(serialized.includes('Injected'), false);
  assert.deepEqual(result.proof.artifact, {
    kind: 'macos-app',
    productName: packageJson.productName,
    bundleIdentifier: null,
    teamIdentifier: null,
    version: null,
    buildVersion: null,
    codeDirectoryHash: null,
    sourceRevision: null,
  });
});

test('unexpected verifier exceptions cannot expose local filesystem paths', () => {
  assert.equal(
    safeCliErrorMessage(new Error('/Users/example/private-build/Crate.app could not be read')),
    'Crate signed-app policy failed.'
  );
  const policyError = Object.assign(new Error('The app bundle input is invalid.'), {
    isVerificationError: true,
  });
  assert.equal(safeCliErrorMessage(policyError), 'The app bundle input is invalid.');
});

test('code-signature metadata parser captures only policy inputs', () => {
  const metadata = parseCodeSignatureMetadata([
    'Executable=/private/tmp/Crate.app/Contents/MacOS/Crate',
    'Identifier=com.crate.app',
    'CodeDirectory v=20500 flags=0x10000(runtime)',
    'Authority=Developer ID Application: Private Signer Name (YY7WDMUFWJ)',
    'Authority=Developer ID Certification Authority',
    `CDHashFull=${'c'.repeat(64)}`,
    'Timestamp=Jul 15, 2026 at 8:05:27 PM',
    'TeamIdentifier=YY7WDMUFWJ',
  ].join('\n'));

  assert.deepEqual(metadata, {
    identifier: 'com.crate.app',
    teamIdentifier: 'YY7WDMUFWJ',
    codeDirectoryHash: 'c'.repeat(64),
    authorities: [
      'Developer ID Application: Private Signer Name (YY7WDMUFWJ)',
      'Developer ID Certification Authority',
    ],
    hardenedRuntime: true,
    timestamped: true,
  });
  assert.equal(JSON.stringify(metadata).includes('/private/tmp'), false);

  for (const timestamp of ['', 'none', 'null', 'not-a-date']) {
    assert.equal(
      parseCodeSignatureMetadata(`Timestamp=${timestamp}`).timestamped,
      false,
      `Timestamp=${timestamp}`
    );
  }
});

test('CLI requires notarization by default and makes QA bypass explicit', () => {
  const revision = 'b'.repeat(40);
  const proofRoot = '/tmp/crate-release-proof-source';
  const canvasPrebuild = '/tmp/canvas-v3.2.1-napi-v7-darwin-arm64.tar.gz';
  const electronArchive = '/tmp/electron-v42.9.0-darwin-arm64.zip';
  assert.equal(require('../package.json').build.appId, PUBLIC_APP_ID);
  assert.equal(expectedTeamIdentifier(), PUBLIC_TEAM_ID);
  assert.throws(
    () => parseCliArguments([
      '/tmp/Crate.app',
      '--electron-archive',
      electronArchive,
      '--canvas-prebuild',
      canvasPrebuild,
      '--source-root',
      proofRoot,
    ]),
    /requires an approved commit revision/u
  );
  assert.deepEqual(parseCliArguments([
    '/tmp/Crate.app',
    '--electron-archive',
    electronArchive,
    '--canvas-prebuild',
    canvasPrebuild,
    '--expected-revision',
    revision,
    '--source-root',
    proofRoot,
  ]), {
    appPath: '/tmp/Crate.app',
    canvasPrebuild,
    electronArchive,
    expectedAppId: null,
    expectedExecutableName: null,
    expectedRevision: revision,
    json: false,
    requireNotarization: true,
    sourceRoot: proofRoot,
  });
  assert.deepEqual(parseCliArguments([
    '/tmp/Crate QA.app',
    '--allow-unnotarized',
    '--electron-archive',
    electronArchive,
    '--canvas-prebuild',
    canvasPrebuild,
    '--expected-app-id',
    'com.crate.app.qa',
    '--expected-executable-name',
    'Crate QA',
    '--source-root',
    proofRoot,
    '--json',
  ]), {
    appPath: '/tmp/Crate QA.app',
    canvasPrebuild,
    electronArchive,
    expectedAppId: 'com.crate.app.qa',
    expectedExecutableName: 'Crate QA',
    expectedRevision: null,
    json: true,
    requireNotarization: false,
    sourceRoot: proofRoot,
  });
  assert.throws(
    () => parseCliArguments([
      '/tmp/Other.app',
      '--electron-archive',
      electronArchive,
      '--canvas-prebuild',
      canvasPrebuild,
      '--expected-app-id',
      'com.example.other',
      '--expected-executable-name',
      'Other',
      '--source-root',
      proofRoot,
    ]),
    /restricted to contained QA/u
  );
  assert.throws(
    () => parseCliArguments([
      '/tmp/Crate.app',
      '--electron-archive',
      electronArchive,
      '--canvas-prebuild',
      canvasPrebuild,
      '--expected-revision',
      'not-a-commit',
      '--source-root',
      proofRoot,
    ]),
    /missing or invalid/u
  );
  assert.throws(
    () => parseCliArguments([
      '/tmp/Crate.app',
      '--electron-archive',
      electronArchive,
      '--canvas-prebuild',
      canvasPrebuild,
      '--expected-revision',
      revision,
    ]),
    /release proof source root is required/u
  );
  assert.throws(
    () => parseCliArguments([
      '/tmp/Crate.app',
      '--expected-revision',
      revision,
      '--source-root',
      proofRoot,
    ]),
    /authenticated Electron proof archive/u
  );
  assert.throws(
    () => parseCliArguments([
      '/tmp/Crate.app',
      '--electron-archive',
      'electron.zip',
      '--canvas-prebuild',
      canvasPrebuild,
      '--expected-revision',
      revision,
      '--source-root',
      proofRoot,
    ]),
    /must be an absolute path/u
  );
  assert.throws(
    () => parseCliArguments([
      '/tmp/Crate QA.app',
      '--allow-unnotarized',
      '--electron-archive',
      electronArchive,
      '--canvas-prebuild',
      canvasPrebuild,
      '--expected-app-id',
      'com.crate.app.qa',
      '--source-root',
      proofRoot,
    ]),
    /require an explicit executable name/u
  );
  assert.throws(
    () => parseCliArguments([
      '/tmp/Crate.app',
      '--electron-archive',
      electronArchive,
      '--canvas-prebuild',
      canvasPrebuild,
      '--expected-executable-name',
      'Renamed Crate',
      '--expected-revision',
      revision,
      '--source-root',
      proofRoot,
    ]),
    /restricted to contained QA/u
  );
  assert.throws(
    () => parseCliArguments([
      '/tmp/Crate.app',
      '--electron-archive',
      electronArchive,
      '--expected-revision',
      revision,
      '--source-root',
      proofRoot,
    ]),
    /authenticated Canvas proof archive/u
  );
});

test('CLI wiring propagates release mode, revision, proof output, and exit status', async () => {
  const revision = 'b'.repeat(40);
  const outputs = [];
  const errors = [];
  const exitCodes = [];
  const calls = [];
  const dependencies = {
    async collectEvidence(appPath, options) {
      calls.push({ appPath, collectOptions: options });
      return { marker: 'evidence' };
    },
    evaluateEvidence(evidence, options) {
      calls[calls.length - 1].evaluation = { evidence, options };
      return {
        ok: true,
        failures: [],
        proof: {
          releaseReady: options.expectedRevision === revision,
          counts: { helperApps: 4 },
        },
      };
    },
    setExitCode(code) {
      exitCodes.push(code);
    },
    teamIdentifier: () => PUBLIC_TEAM_ID,
    writeError: message => errors.push(message),
    writeOutput: message => outputs.push(message),
  };

  const releaseRun = await runCli([
    '/tmp/Crate.app',
    '--electron-archive',
    '/tmp/electron.zip',
    '--canvas-prebuild',
    '/tmp/canvas.tar.gz',
    '--expected-revision',
    revision,
    '--source-root',
    '/tmp/proof-root',
    '--json',
  ], dependencies);
  assert.equal(releaseRun.exitCode, 0);
  assert.equal(releaseRun.result.proof.releaseReady, true);
  assert.equal(calls[0].collectOptions.requireNotarization, true);
  assert.equal(calls[0].collectOptions.canvasPrebuild, '/tmp/canvas.tar.gz');
  assert.equal(calls[0].evaluation.options.expectedRevision, revision);
  assert.equal(JSON.parse(outputs[0]).releaseReady, true);

  const qaRun = await runCli([
    '/tmp/Crate QA.app',
    '--allow-unnotarized',
    '--electron-archive',
    '/tmp/electron.zip',
    '--canvas-prebuild',
    '/tmp/canvas.tar.gz',
    '--expected-app-id',
    'com.crate.app.qa',
    '--expected-executable-name',
    'Crate QA',
    '--source-root',
    '/tmp/proof-root',
  ], dependencies);
  assert.equal(qaRun.exitCode, 0);
  assert.equal(calls[1].collectOptions.requireNotarization, false);
  assert.equal(calls[1].evaluation.options.expectedRevision, null);
  assert.match(outputs[1], /contained QA/u);
  assert.deepEqual(exitCodes, [0, 0]);
  assert.deepEqual(errors, []);

  const failed = await runCli(['/tmp/invalid'], {
    ...dependencies,
    parseArguments() {
      throw Object.assign(new Error('Invalid release input.'), {
        exitCode: 2,
        isVerificationError: true,
      });
    },
  });
  assert.equal(failed.exitCode, 2);
  assert.equal(errors.at(-1), 'Invalid release input.');
  assert.equal(exitCodes.at(-1), 2);
});

test('CI source gate is least privilege, pinned, serial, and release inert', () => {
  const workflowPath = path.join(ROOT, '.github', 'workflows', 'security-gate.yml');
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  assert.match(workflow, /pull_request:\s*\n\s+branches:\s*\[v2\.4\.x\]/u);
  assert.match(workflow, /push:\s*\n\s+branches:\s*\[v2\.4\.x\]/u);
  assert.doesNotMatch(
    workflow,
    /workflow_dispatch|repository_dispatch|workflow_call|schedule:|pull_request_target/u
  );
  assert.match(workflow, /permissions:\n  contents: read\n\nconcurrency:/u);
  const checkoutBlock = workflowStepBlock(workflow, 'Check out source');
  assert.equal(checkoutBlock, [
    '      - name: Check out source',
    '        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2',
    '        with:',
    '          persist-credentials: true',
    '          fetch-depth: 0',
    '          submodules: false',
    '',
  ].join('\n'));
  assert.match(
    workflow,
    /submodules: false\n\n      - name: Scrub checkout credentials and map legacy gitlinks/u
  );
  assert.match(workflow, /fetch-depth: 0/u);
  assert.match(workflow, /actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683/u);
  assert.match(workflow, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/u);
  const actionReferences = [...workflow.matchAll(/^\s*uses:\s*[^\s@]+@([^\s#]+).*$/gmu)]
    .map(match => match[1]);
  assert.equal(actionReferences.length, 2);
  assert.equal(actionReferences.every(reference => /^[a-f0-9]{40}$/u.test(reference)), true);
  assert.match(workflow, /runs-on: macos-15/u);
  assert.match(workflow, /node-version: 22\.23\.1/u);
  assert.match(workflow, /^  source-security:\n    name: Source security and regression suite$/mu);
  // The job's time limit and the memory guard's deadline for the suite are set
  // together. The deadline stays at least two minutes inside the limit, which
  // covers the steps before the suite and the guard's own cleanup, so that a
  // suite that takes too long ends with the guard's report (exit 124) and not
  // with a cancelled job.
  assert.equal([...workflow.matchAll(/timeout-minutes:/gu)].length, 1);
  const jobTimeoutMinutes = Number(/^    timeout-minutes: (\d+)$/mu.exec(workflow)[1]);
  const suiteDeadlines = [...workflow.matchAll(/--deadline-seconds=(\d+)/gu)].map(match => Number(match[1]));
  assert.equal(jobTimeoutMinutes, 60);
  assert.deepEqual(suiteDeadlines, [3400]);
  assert.ok(jobTimeoutMinutes * 60 - suiteDeadlines[0] >= 120);
  assert.doesNotMatch(workflow, /^\s{4}(?:if|continue-on-error):/mu);
  assert.match(workflow, /NODE_OPTIONS: ''/u);
  assert.match(workflow, /NODE_PATH: ''/u);
  assert.match(workflow, /npm_config_cache: \$\{\{ runner\.temp \}\}\/crate-npm-cache/u);
  assert.equal(
    [...workflow.matchAll(/npm_config_cache: \$\{\{ runner\.temp \}\}\/crate-npm-cache/gu)].length,
    4
  );
  assert.equal(
    [...workflow.matchAll(/npm_config_globalconfig: \$\{\{ runner\.temp \}\}\/crate-global-npmrc/gu)].length,
    2
  );
  assert.equal(
    [...workflow.matchAll(/npm_config_userconfig: \$\{\{ runner\.temp \}\}\/crate-user-npmrc/gu)].length,
    2
  );
  assert.doesNotMatch(workflow, /^\s{6}npm_config_(?:globalconfig|userconfig):/mu);
  assert.match(workflow, /npm_config_ignore_scripts: 'true'/u);
  assert.match(workflow, /npm_config_registry: https:\/\/registry\.npmjs\.org\//u);
  assert.match(workflow, /npm_config_strict_ssl: 'true'/u);
  assert.doesNotMatch(workflow, /^\s+cache: npm$/mu);
  const stepNames = [...workflow.matchAll(/^\s{6}- name: (.+)$/gmu)]
    .map(match => match[1]);
  assert.deepEqual(stepNames, [
    'Check out source',
    'Scrub checkout credentials and map legacy gitlinks',
    'Reject pull-request whitespace errors',
    'Reject pushed whitespace errors',
    'Reject repository package-manager configuration',
    'Prepare isolated npm configuration',
    'Set up Node.js',
    'Install frozen dependencies',
    'Reject high-severity dependency findings',
    'Verify dependency lifecycle policy',
    'Check security verifier syntax',
    'Install authenticated fixed Chrome for Testing',
    'Authenticate installed release verifier toolchain',
    'Run complete serial source suite',
    'Verify fixed Chrome for Testing remained unchanged',
  ]);
  assert.doesNotMatch(workflow, /^\s{6}- (?!name:)/mu);
  assert.equal(
    workflow.indexOf('- name: Reject repository package-manager configuration') <
      workflow.indexOf('- name: Set up Node.js'),
    true
  );
  assert.equal(
    workflow.indexOf('- name: Scrub checkout credentials and map legacy gitlinks') <
      workflow.indexOf('- name: Reject repository package-manager configuration'),
    true
  );
  assert.equal(
    workflow.indexOf('- name: Reject repository package-manager configuration') <
      workflow.indexOf('- name: Prepare isolated npm configuration') &&
      workflow.indexOf('- name: Prepare isolated npm configuration') <
        workflow.indexOf('- name: Set up Node.js'),
    true
  );
  const checkoutScrubBlock = workflowStepBlock(
    workflow,
    'Scrub checkout credentials and map legacy gitlinks'
  );
  assert.equal(checkoutScrubBlock, [
    '      - name: Scrub checkout credentials and map legacy gitlinks',
    '        run: |',
    '          test ! -e .gitmodules && test ! -L .gitmodules',
    '          git config --file .gitmodules submodule.crate-web.path crate-web',
    '          git config --file .gitmodules submodule.crate-web.url ./crate-web',
    '          git config --file .gitmodules submodule.mission-control.path mission-control',
    '          git config --file .gitmodules submodule.mission-control.url ./mission-control',
    "          git config --local --get-regexp '^http\\..*\\.extraheader$' >/dev/null",
    '          git config --local --unset-all http.https://github.com/.extraheader',
    "          ! git config --local --name-only --get-regexp '^http\\..*\\.extraheader$' >/dev/null",
    '',
  ].join('\n'));
  const runs = workflowRunsByStepName(workflow);
  assert.deepEqual(
    runs.get('Reject repository package-manager configuration'),
    ['test ! -e .npmrc && test ! -L .npmrc && test ! -e npm-shrinkwrap.json && test ! -L npm-shrinkwrap.json']
  );
  const isolatedNpmConfigBlock = workflowStepBlock(workflow, 'Prepare isolated npm configuration');
  assert.equal(isolatedNpmConfigBlock, [
    '      - name: Prepare isolated npm configuration',
    '        run: |',
    '          /usr/bin/install -m 600 /dev/null "$RUNNER_TEMP/crate-user-npmrc"',
    '          /usr/bin/install -m 600 /dev/null "$RUNNER_TEMP/crate-global-npmrc"',
    '',
  ].join('\n'));
  assert.equal(workflowStepBlock(workflow, 'Reject repository package-manager configuration'), [
    '      - name: Reject repository package-manager configuration',
    '        run: test ! -e .npmrc && test ! -L .npmrc && test ! -e npm-shrinkwrap.json && test ! -L npm-shrinkwrap.json',
    '',
  ].join('\n'));
  assert.equal(workflowStepBlock(workflow, 'Set up Node.js'), [
    '      - name: Set up Node.js',
    '        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0',
    '        with:',
    '          node-version: 22.23.1',
    '',
  ].join('\n'));
  assert.deepEqual(
    runs.get('Install frozen dependencies'),
    ['npm ci --ignore-scripts --registry=https://registry.npmjs.org/']
  );
  assert.deepEqual(
    runs.get('Verify dependency lifecycle policy'),
    ['node scripts/verify-install-scripts.js']
  );
  assert.equal(workflowStepBlock(workflow, 'Verify dependency lifecycle policy'), [
    '      - name: Verify dependency lifecycle policy',
    '        run: node scripts/verify-install-scripts.js',
    '',
  ].join('\n'));
  assert.deepEqual(
    runs.get('Reject high-severity dependency findings'),
    ['node scripts/verify-dependency-audit.js']
  );
  assert.equal(
    workflow.indexOf('- name: Install frozen dependencies') <
      workflow.indexOf('- name: Reject high-severity dependency findings') &&
      workflow.indexOf('- name: Reject high-severity dependency findings') <
        workflow.indexOf('- name: Verify dependency lifecycle policy'),
    true
  );
  for (const stepName of [
    'Install frozen dependencies',
    'Reject high-severity dependency findings',
  ]) {
    const command = stepName === 'Install frozen dependencies'
      ? 'npm ci --ignore-scripts --registry=https://registry.npmjs.org/'
      : 'node scripts/verify-dependency-audit.js';
    assert.equal(workflowStepBlock(workflow, stepName), [
      `      - name: ${stepName}`,
      '        env:',
      '          npm_config_cache: ${{ runner.temp }}/crate-npm-cache',
      '          npm_config_globalconfig: ${{ runner.temp }}/crate-global-npmrc',
      '          npm_config_userconfig: ${{ runner.temp }}/crate-user-npmrc',
      `        run: ${command}`,
      '',
    ].join('\n'));
  }
  assert.deepEqual(
    runs.get('Run complete serial source suite'),
    ['node scripts/run-tests.js --deadline-seconds=3400 --test-concurrency=1 tests/*.test.js']
  );
  assert.equal(workflowStepBlock(workflow, 'Check security verifier syntax'), [
    '      - name: Check security verifier syntax',
    '        run: |',
    '          node --check main.js',
    '          node --check preload.js',
    '          node --check provenance.js',
    '          node --check diagnostic-summary.js',
    '          node --check renderer/app.js',
    '          node --check parsers/figma-credential-store.js',
    '          node --check parsers/figma-network.js',
    '          node --check parsers/figma-redaction.js',
    '          node --check parsers/figma.js',
    '          node --check parsers/package-safety.js',
    '          node --check parsers/package-transaction-worker.js',
    '          node --check scripts/ci-chrome.js',
    '          node --check scripts/install-approved-canvas-prebuild.js',
    '          node --check scripts/run-tests.js',
    '          node --check scripts/verify-app-contents.js',
    '          node --check scripts/verify-dependency-audit.js',
    '          node --check scripts/verify-install-scripts.js',
    '          node --check scripts/verify-macos-release-app.js',
    '          node --check scripts/run-macos-release-proof.js',
    '          node --check scripts/version-crate-site-assets.js',
    '          node scripts/version-crate-site-assets.js --check',
    '',
  ].join('\n'));
  assert.equal(workflowStepBlock(workflow, 'Install authenticated fixed Chrome for Testing'), [
    '      - name: Install authenticated fixed Chrome for Testing',
    '        run: node scripts/ci-chrome.js install "$RUNNER_TEMP/crate-ci-chrome"',
    '',
  ].join('\n'));
  assert.equal(workflowStepBlock(workflow, 'Authenticate installed release verifier toolchain'), [
    '      - name: Authenticate installed release verifier toolchain',
    '        env:',
    "          CRATE_VERIFY_LIVE_TOOLCHAIN: '1'",
    '          npm_config_cache: ${{ runner.temp }}/crate-npm-cache',
    '        run: node scripts/run-tests.js --test-concurrency=1 tests/release-toolchain-integration.test.js',
    '',
  ].join('\n'));
  assert.equal(workflowStepBlock(workflow, 'Run complete serial source suite'), [
    '      - name: Run complete serial source suite',
    '        env:',
    '          npm_config_cache: ${{ runner.temp }}/crate-npm-cache',
    "          CRATE_UI_TEST_BROWSER_PIN: '1'",
    '          CRATE_UI_TEST_BROWSER: ${{ runner.temp }}/crate-ci-chrome/payload/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '        run: node scripts/run-tests.js --deadline-seconds=3400 --test-concurrency=1 tests/*.test.js',
    '',
  ].join('\n'));
  assert.equal(workflowStepBlock(workflow, 'Verify fixed Chrome for Testing remained unchanged'), [
    '      - name: Verify fixed Chrome for Testing remained unchanged',
    '        if: always()',
    '        run: node scripts/ci-chrome.js verify "$RUNNER_TEMP/crate-ci-chrome"',
    '',
  ].join('\n'));
  assert.equal(
    workflow.indexOf('- name: Check security verifier syntax') <
      workflow.indexOf('- name: Install authenticated fixed Chrome for Testing') &&
      workflow.indexOf('- name: Install authenticated fixed Chrome for Testing') <
        workflow.indexOf('- name: Run complete serial source suite') &&
      workflow.indexOf('- name: Run complete serial source suite') <
        workflow.indexOf('- name: Verify fixed Chrome for Testing remained unchanged'),
    true
  );
  for (const stepName of [
    'Check out source',
    'Scrub checkout credentials and map legacy gitlinks',
    'Reject repository package-manager configuration',
    'Prepare isolated npm configuration',
    'Set up Node.js',
    'Install frozen dependencies',
    'Reject high-severity dependency findings',
    'Verify dependency lifecycle policy',
    'Check security verifier syntax',
    'Install authenticated fixed Chrome for Testing',
    'Authenticate installed release verifier toolchain',
    'Run complete serial source suite',
  ]) {
    const block = workflowStepBlock(workflow, stepName);
    assert.notEqual(block, '');
    assert.doesNotMatch(block, /^\s+(?:if|continue-on-error|shell):/mu, stepName);
  }
  const pullRequestWhitespaceBlock = workflowStepBlock(
    workflow,
    'Reject pull-request whitespace errors'
  );
  assert.equal(pullRequestWhitespaceBlock, [
    '      - name: Reject pull-request whitespace errors',
    "        if: github.event_name == 'pull_request'",
    '        run: git diff --check "${{ github.event.pull_request.base.sha }}...${{ github.event.pull_request.head.sha }}"',
    '',
  ].join('\n'));
  const pushedWhitespaceBlock = workflowStepBlock(workflow, 'Reject pushed whitespace errors');
  assert.equal(pushedWhitespaceBlock, [
    '      - name: Reject pushed whitespace errors',
    "        if: github.event_name == 'push'",
    '        run: git diff --check "${{ github.event.before }}..${{ github.sha }}"',
    '',
  ].join('\n'));
  for (const block of [pullRequestWhitespaceBlock, pushedWhitespaceBlock]) {
    assert.doesNotMatch(block, /^\s+(?:continue-on-error|shell):/mu);
  }
  assert.match(
    workflowStepBlock(workflow, 'Check security verifier syntax'),
    /node --check scripts\/install-approved-canvas-prebuild\.js/u
  );
  assert.match(
    workflowStepBlock(workflow, 'Check security verifier syntax'),
    /node --check scripts\/run-macos-release-proof\.js/u
  );
  assert.equal(
    workflow.indexOf('- name: Install frozen dependencies') <
      workflow.indexOf('- name: Authenticate installed release verifier toolchain') &&
      workflow.indexOf('- name: Authenticate installed release verifier toolchain') <
        workflow.indexOf('- name: Run complete serial source suite'),
    true
  );
  const spoofedWorkflow = workflow.replace(
    'run: npm ci --ignore-scripts --registry=https://registry.npmjs.org/',
    "run: echo 'npm ci --ignore-scripts --registry=https://registry.npmjs.org/'"
  );
  assert.notDeepEqual(
    workflowRunsByStepName(spoofedWorkflow).get('Install frozen dependencies'),
    ['npm ci --ignore-scripts']
  );
  const skippedWorkflow = workflow.replace(
    '- name: Install frozen dependencies\n',
    '- name: Install frozen dependencies\n        if: false\n'
  );
  assert.match(
    workflowStepBlock(skippedWorkflow, 'Install frozen dependencies'),
    /^\s+if: false$/mu
  );
  assert.match(
    workflow,
    /git diff --check "\$\{\{ github\.event\.pull_request\.base\.sha \}\}\.\.\.\$\{\{ github\.event\.pull_request\.head\.sha \}\}"/u
  );
  assert.match(
    workflow,
    /git diff --check "\$\{\{ github\.event\.before \}\}\.\.\$\{\{ github\.sha \}\}"/u
  );
  assert.doesNotMatch(workflow, /secrets\.|electron-builder|codesign|notary|stapler|wrangler|gh release/u);
  assert.doesNotMatch(workflow, /\bwrite(?:-all)?\b/u);

  const requiredCheckProducers = fs.readdirSync(path.join(ROOT, '.github', 'workflows'))
    .filter(fileName => /\.ya?ml$/u.test(fileName))
    .flatMap(fileName => {
      const source = fs.readFileSync(path.join(ROOT, '.github', 'workflows', fileName), 'utf8');
      return [...source.matchAll(/^\s+name: Source security and regression suite$/gmu)]
        .map(() => fileName);
    });
  assert.deepEqual(requiredCheckProducers, ['security-gate.yml']);
});

test('release gate requires the signed-app verifier for approved artifacts', () => {
  const releaseGate = fs.readFileSync(
    path.join(ROOT, '.codex', 'playbooks', 'crate-release-gate.md'),
    'utf8'
  );
  assert.match(
    releaseGate,
    /\(cd <isolated-verifier-source-root> && <sanitized-node-environment> "<canonical-node-executable>" scripts\/run-macos-release-proof\.js <path-to-app> --electron-archive <electron-arm64-archive> --canvas-prebuild <canvas-arm64-prebuild> --expected-revision <approved-release-commit> --source-root <isolated-proof-source-root> --json\)/u
  );
  assert.doesNotMatch(releaseGate, /scripts\/verify-macos-release-app\.js <path-to-app>/u);
  assert.match(releaseGate, /code-owner approval from a controlling principal different from the PR author/u);
  assert.match(releaseGate, /v2\.4\.x.*default branch/iu);
  assert.match(releaseGate, /refs\/tags\/v\*/u);
  assert.match(releaseGate, /creation-control ruleset/iu);
  assert.match(releaseGate, /separate no-bypass immutability ruleset/iu);
  assert.match(releaseGate, /immutable-releases.*enabled: true/iu);
  assert.match(releaseGate, /must not bypass/iu);
  assert.match(releaseGate, /clean checkout at the explicitly supplied release commit/iu);
  assert.match(releaseGate, /Before either third-party verifier module loads/iu);
  assert.match(releaseGate, /rechecks those package bytes and the committed verifier sources/iu);
  assert.match(releaseGate, /exact launch\/security metadata.*internally consistent main\/helper build metadata/iu);
  assert.match(releaseGate, /same-user process, agent, automation, or release authority/iu);
  assert.match(releaseGate, /second new empty directory/iu);
  assert.match(releaseGate, /Publishing must be the next bounded operation/iu);
  assert.match(releaseGate, /crate-release-notarytool/u);
});

test('tester beta keeps verified website distribution without public-stable governance', () => {
  const releasePlaybook = fs.readFileSync(
    path.join(ROOT, '.codex', 'playbooks', 'release-crate.md'),
    'utf8'
  );
  const releaseGate = fs.readFileSync(
    path.join(ROOT, '.codex', 'playbooks', 'crate-release-gate.md'),
    'utf8'
  );
  const instructions = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  const workstream = fs.readFileSync(
    path.join(ROOT, '.codex', 'state', 'current-workstream.md'),
    'utf8'
  );
  const testerFlow = releasePlaybook.slice(
    releasePlaybook.indexOf('## Tester Beta Flow'),
    releasePlaybook.indexOf('## Standard Flow')
  );
  const betaOrdering = releaseGate.slice(
    releaseGate.indexOf('Hard ordering rules:'),
    releaseGate.indexOf('## Must Never Do')
  );
  const commonGovernance = releasePlaybook.slice(
    releasePlaybook.indexOf('#### Common Evidence (Both Profiles)'),
    releasePlaybook.indexOf('#### Public Stable Extensions Only')
  );

  assert.match(testerFlow, /Bryant's explicit approval/iu);
  assert.match(testerFlow, /Source security and regression suite/u);
  assert.match(testerFlow, /signed\/notarized\/stapled app and containers/iu);
  assert.match(testerFlow, /releaseReady: true/u);
  assert.match(testerFlow, /--prerelease/u);
  assert.match(testerFlow, /complete remote set and bytes.*frozen manifest/iu);
  assert.match(testerFlow, /`crate-site\/index\.html`.*beta download button/iu);
  assert.match(testerFlow, /Cloudflare/iu);
  assert.match(testerFlow, /Install the published DMG on the Mac mini/iu);
  assert.match(testerFlow, /Independent code-owner approval.*are not tester-beta gates/iu);
  assert.match(testerFlow, /no-bypass `v\*` tag update\/deletion protection is active/iu);
  assert.match(testerFlow, /`immutable-releases` reports enabled/iu);
  assert.match(testerFlow, /published release to report immutable/iu);
  assert.match(testerFlow, /complete draft asset set again into a second new empty directory/iu);
  assert.match(testerFlow, /every filename, byte size, and SHA-256.*frozen manifest/iu);
  assert.match(testerFlow, /The next bounded operation must be.*release edit <tag> --draft=false/iu);
  assert.match(testerFlow, /version-only tester-beta release-prep PR/iu);
  assert.match(testerFlow, /After it merges, bind the exact `Source security and regression suite` success/iu);
  assert.match(testerFlow, /Common Artifact Integrity Protection that is available before the version-only release-prep PR/iu);
  assert.match(testerFlow, /manual controlling-principal attestation.*not tester-beta gates/iu);
  assert.doesNotMatch(testerFlow, /reviews\?per_page=100/iu);
  assert.match(commonGovernance, /immutable-releases/u);
  assert.match(commonGovernance, /Source security and regression suite/u);
  assert.doesNotMatch(commonGovernance, /pulls\/<release-pr-number>\/reviews/iu);
  assert.match(releaseGate, /Never report tester-beta evidence as satisfying public stable/iu);
  assert.match(releaseGate, /account-gated download backend.*public launch/iu);
  assert.match(betaOrdering, /No tester-beta site deploy until the published prerelease is immutable/iu);
  assert.match(betaOrdering, /No tester-beta build, tag, GitHub release, site deploy, or live verification/iu);
  assert.match(betaOrdering, /version-only release-prep merge SHA/iu);
  assert.doesNotMatch(betaOrdering, /No version or release mutation until/iu);
  assert.doesNotMatch(betaOrdering, /No tester-beta site deploy[^\n]*attested subjects/iu);
  assert.match(instructions, /tester beta.*existing GitHub release and `get-crate\.com` download flow/iu);
  assert.match(instructions, /Both profiles require source-CI provenance.*append-only `v\*` tag protection.*immutable-release enforcement.*immutable published release assets/iu);
  assert.match(instructions, /Account-gated downloads.*public stable launch, not.*tester-beta flow/iu);
  assert.match(workstream, /tester beta only when the common no-bypass tag update\/deletion and immutable-release artifact controls also pass/iu);
  assert.match(workstream, /public-stable branch review controls.*separately controlled tag-creation authority remain public-stable requirements/iu);
});

test('release flow reconstructs dependencies narrowly and proves the stapled app before tagging', () => {
  const releasePlaybook = fs.readFileSync(
    path.join(ROOT, '.codex', 'playbooks', 'release-crate.md'),
    'utf8'
  );
  const standardFlow = releasePlaybook.slice(releasePlaybook.indexOf('## Standard Flow'));

  assert.match(
    standardFlow,
    /"<canonical-node-executable>" "<canonical-npm-cli>" ci --ignore-scripts/u
  );
  assert.match(
    standardFlow,
    /"<canonical-node-executable>" "<canonical-npm-cli>" version <version> --no-git-tag-version --ignore-scripts/u
  );
  assert.match(standardFlow, /root `preversion`, `version`, and `postversion` hooks are absent/iu);
  assert.match(standardFlow, /"<canonical-node-executable>" scripts\/verify-install-scripts\.js/u);
  assert.match(
    standardFlow,
    /"<canonical-node-executable>" scripts\/install-approved-canvas-prebuild\.js <canvas-arm64-prebuild>/u
  );
  assert.match(standardFlow, /exact pinned official Canvas arm64 prebuild/iu);
  assert.match(standardFlow, /do not run Canvas, npm, or dependency lifecycle scripts/iu);
  const canvasDownloadLine = standardFlow.split('\n')
    .find(line => line.includes('/usr/bin/curl -q --noproxy')) || '';
  assert.match(
    canvasDownloadLine,
    /\/usr\/bin\/env -i HOME="<private-live-check-home>" PATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin \/usr\/bin\/curl -q --noproxy '\*' --proto '=https' --tlsv1\.2 --fail --silent --show-error --location/u
  );
  assert.equal(canvasDownloadLine.includes('--output "<canvas-arm64-prebuild>"'), true);
  assert.equal(canvasDownloadLine.includes(`"${APPROVED_CANVAS_PREBUILD.url}"`), true);
  assert.match(standardFlow, /new path inside `<private-release-temp-root>`/u);
  assert.match(standardFlow, /resulting path to be a regular file, not a symlink/iu);
  assert.doesNotMatch(standardFlow, /Download[^\n]+with `\/usr\/bin\/curl /iu);
  assert.doesNotMatch(standardFlow, /(?:npm|<canonical-npm-cli>)`? rebuild|rebuild canvas/iu);
  assert.match(standardFlow, /canonical realpath Node executable and one canonical npm CLI file/iu);
  assert.match(standardFlow, /record their realpaths, SHA-256 hashes, and versions/iu);
  assert.match(standardFlow, /Recompute every tool path, hash, version, and npm-config file identity before each release or proof use/iu);
  assert.match(standardFlow, /Invoke npm only through canonical Node and its canonical CLI file/iu);
  assert.doesNotMatch(standardFlow, /command -v npm/u);
  assert.doesNotMatch(standardFlow, /<canonical-npm-executable>/u);
  assert.match(standardFlow, /prevents Node\/npm\/script-shell injection and package-local executable lookup/iu);
  assert.match(standardFlow, /Rerun the install-script verifier/iu);
  assert.match(standardFlow, /exact Canvas native bytes to reviewed inputs/iu);
  assert.match(standardFlow, /exact `@electron\/asar` and `@electron\/fuses` execution closure from the committed lockfile/iu);
  assert.match(standardFlow, /authenticates every installed package in that closure against its registry integrity before loading either module/iu);
  assert.match(standardFlow, /rechecks both package bytes and committed verifier sources after proof execution/iu);
  assert.match(
    releasePlaybook,
    /distinct empty mode-`0600` regular files `<private-release-user-npmrc>` and `<private-release-global-npmrc>`/u
  );
  assert.match(releasePlaybook, /\/usr\/bin\/install -m 600 \/dev\/null/u);
  assert.match(releasePlaybook, /canonical paths stay inside the private root, differ from each other/iu);
  assert.match(
    standardFlow,
    /\/usr\/bin\/env -i HOME="<approved-home>" TMPDIR="<private-release-temp-root>" PATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin npm_config_cache="<private-release-cache-root>" npm_config_userconfig="<private-release-user-npmrc>" npm_config_globalconfig="<private-release-global-npmrc>"/u
  );
  assert.doesNotMatch(standardFlow, /npm_config_(?:user|global)config=\/dev\/null/u);
  assert.match(
    standardFlow,
    /build under the exact sanitized Node environment with `"<canonical-node-executable>" scripts\/run-electron-builder-release\.js --mac --arm64 --config\.npmRebuild=false --config\.publish\.provider=github --config\.publish\.owner=bfeintuch123 --config\.publish\.repo=crate-app --publish never`/u
  );
  assert.match(standardFlow, /reauthenticates the canonical Node bytes/iu);
  assert.match(standardFlow, /built-in in-process filesystem traversal collector/iu);
  assert.match(standardFlow, /fails closed if Electron Builder requests an npm subprocess/iu);
  assert.match(standardFlow, /cannot run install, rebuild, lifecycle, version, publish, or other npm commands/iu);
  assert.match(
    standardFlow,
    /fresh lockfile-integrity-reconstructed Electron Builder CLI/iu
  );
  assert.match(
    standardFlow,
    /signed-app verifier remains the hard byte-authentication gate/iu
  );
  assert.doesNotMatch(standardFlow, /authenticated Electron Builder CLI/iu);
  assert.match(releasePlaybook, /Define `<sanitized-git-environment>` as exactly `\/usr\/bin\/env -i/iu);
  assert.match(releasePlaybook, /Define `<sanitized-git-command>` as that environment followed by `\/usr\/bin\/git --no-optional-locks --no-replace-objects -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false -c core\.untrackedCache=false`/u);
  assert.match(releasePlaybook, /Define `<sanitized-gh-environment>` as exactly `\/usr\/bin\/env -i/iu);
  assert.match(standardFlow, /inherited `GIT_\*`, `GH_\*`, proxy, shell, executable-path, hook, filesystem-monitor, credential-helper, alias, include, and URL-rewrite configuration cannot redirect/iu);
  assert.match(releasePlaybook, /Authenticate and hash the local Git config.*includes disabled/iu);
  assert.match(releasePlaybook, /Reject aliases.*`include`.*`includeIf`.*URL rewrites.*executable remote helpers.*`core\.hooksPath`.*`core\.fsmonitor`.*`core\.sshCommand`.*`protocol\.\*\.allow`.*credential helpers/iu);
  assert.doesNotMatch(standardFlow, /\/usr\/bin\/env -u/u);
  assert.doesNotMatch(standardFlow, /npx\s+(?:electron-builder|wrangler)|npm exec\s+(?:electron-builder|wrangler)/iu);
  assert.match(standardFlow, /one combined build, signing, app-notarization, app-stapling, and app-staple-validation approval/iu);
  assert.match(standardFlow, /build-only approval is insufficient/iu);
  assert.match(standardFlow, /afterSign.*scripts\/notarize\.js/iu);
  assert.match(standardFlow, /create two detached worktrees at the release commit/iu);
  assert.match(standardFlow, /<isolated-verifier-source-root>/u);
  assert.match(standardFlow, /different canonical directories/iu);
  assert.match(standardFlow, /Reconstruct each worktree independently with canonical npm `ci --ignore-scripts`/iu);
  assert.match(standardFlow, /verifier worktree's independently reconstructed dependencies may execute only the reviewed verifier/iu);
  assert.match(standardFlow, /proof worktree supplies all dependency-byte evidence/iu);
  assert.match(standardFlow, /From `<isolated-verifier-source-root>`/u);
  assert.match(standardFlow, /exact launch and security metadata.*internally consistent main\/helper build metadata/iu);
  assert.match(standardFlow, /--electron-archive <electron-arm64-archive>/u);
  assert.match(standardFlow, /--canvas-prebuild <canvas-arm64-prebuild>/u);
  assert.match(standardFlow, /--source-root <isolated-proof-source-root>/u);
  assert.match(standardFlow, /latest-mac\.yml/iu);
  assert.match(standardFlow, /blockmap/iu);
  assert.match(standardFlow, /dist\/\.crate-release-metadata-incomplete.*hard stop.*clean rebuild/iu);
  assert.match(standardFlow, /Mount the final DMG read-only/iu);
  assert.match(standardFlow, /extract the final ZIP/iu);
  assert.match(standardFlow, /complete container inventories.*explicit allowlist/iu);
  assert.match(standardFlow, /Create the GitHub release as a draft/iu);
  assert.match(standardFlow, /download all draft assets through.*authenticated.*GitHub/iu);
  assert.match(standardFlow, /Download the complete draft asset set again into a second new empty directory/iu);
  assert.match(standardFlow, /The next bounded operation must be.*release edit <tag> --draft=false/iu);
  assert.match(standardFlow, /isDraft: false.*isImmutable: true/iu);
  assert.match(standardFlow, /run `release verify <tag>`/u);
  assert.match(standardFlow, /run `release verify-asset <tag> <local-approved-artifact>`/u);
  assert.match(standardFlow, /byte size, and SHA-256 hash/iu);
  assert.match(standardFlow, /no missing, duplicate, or additional asset/iu);
  assert.match(standardFlow, /attested subjects to equal that manifest exactly/iu);
  assert.match(releasePlaybook, /non-null GitHub App `integration_id`/iu);
  assert.match(releasePlaybook, /app slug must be `github-actions`/iu);
  assert.match(releasePlaybook, /immutable path is `\.github\/workflows\/security-gate\.yml`/iu);
  assert.match(releasePlaybook, /Release Session Trust Boundary/u);
  assert.match(releasePlaybook, /same user identity is compromised/iu);
  assert.match(releasePlaybook, /manual attestation naming the PR author, approving code owner, and separately controlled release authority/iu);
  assert.match(releasePlaybook, /notarytool history --keychain-profile "crate-release-notarytool"/u);
  assert.match(releasePlaybook, /notarytool submit <dmg> --keychain-profile "crate-release-notarytool" --wait/u);
  const governanceEvidence = releasePlaybook.slice(
    releasePlaybook.indexOf('### Bounded GitHub Governance Evidence'),
    releasePlaybook.indexOf('## Standard Flow')
  );
  for (const endpoint of [
    'repos/bfeintuch123/crate-app/rulesets?includes_parents=false',
    'repos/bfeintuch123/crate-app/rulesets/<ruleset-id>',
    'repos/bfeintuch123/crate-app/immutable-releases',
    'repos/bfeintuch123/crate-app/pulls/<release-pr-number>/reviews?per_page=100',
    'repos/bfeintuch123/crate-app/pulls/<release-pr-number>',
    'repos/bfeintuch123/crate-app/commits/<release-pr-head-sha>/check-runs?filter=latest&per_page=100',
    'repos/bfeintuch123/crate-app/actions/workflows/security-gate.yml/runs?branch=<release-prep-branch>&event=pull_request&per_page=100',
    'repos/bfeintuch123/crate-app/commits/<release-merge-sha>/check-runs?filter=latest&per_page=100',
    'repos/bfeintuch123/crate-app/actions/workflows/security-gate.yml/runs?branch=v2.4.x&event=push&per_page=100',
    'repos/bfeintuch123/crate-app/actions/runs/<workflow-run-id>',
  ]) {
    assert.equal(governanceEvidence.includes(endpoint), true, endpoint);
  }
  assert.match(governanceEvidence, /check_suite_id:\.check_suite\.id/u);
  assert.match(governanceEvidence, /app:\{id:\.app\.id,slug:\.app\.slug\}/u);
  assert.match(governanceEvidence, /version-only PR head SHA.*protected-branch release merge SHA/iu);
  assert.match(governanceEvidence, /`merged: true`.*`head\.sha: <release-pr-head-sha>`.*`merge_commit_sha: <release-merge-sha>`/iu);
  assert.match(governanceEvidence, /PR-head workflow event must be `pull_request`/iu);
  assert.match(governanceEvidence, /\{user:\.user\.login,state,commit_id,submitted_at\}/u);
  assert.match(governanceEvidence, /zero or multiple candidates where exactly one is required/iu);
  assert.doesNotMatch(governanceEvidence, /--paginate/u);
  assert.doesNotMatch(standardFlow, /run `npm ci`(?:\s|from)/u);

  assert.equal(packageJson.build.afterSign, 'scripts/notarize.js');
  assert.equal(packageJson.build.dmg.sign, true);
  assert.equal(packageJson.build.disableDefaultIgnoredFiles, undefined);
  assert.equal(packageJson.build.onNodeModuleFile, undefined);
  assert.equal(
    packageJson.build.files.some(pattern => String(pattern).includes('node_modules')),
    false
  );

  const repositoryToolIndex = standardFlow.indexOf('Before any repository or release command');
  const governanceIndex = standardFlow.indexOf('Complete every Required Repository Protection check');
  const canonicalToolIndex = standardFlow.indexOf('authenticate the dependency and build tools');
  const versionIndex = standardFlow.indexOf('version <version> --no-git-tag-version --ignore-scripts');
  const buildIndex = standardFlow.indexOf('build under');
  const finalizerIndex = standardFlow.indexOf('immediately run `scripts/finalize-mac-release-metadata.js`');
  const proofRootIndex = standardFlow.indexOf('create two detached worktrees at the release commit');
  const proofIndex = standardFlow.indexOf('run-macos-release-proof.js');
  const containerProofIndex = standardFlow.indexOf('Mount the final DMG read-only');
  const metadataIndex = standardFlow.indexOf('Validate final DMG/ZIP');
  const tagIndex = standardFlow.indexOf('Tag the verified release commit only');
  const remoteTagIndex = standardFlow.indexOf('verify the remote tag resolves');
  const draftReleaseIndex = standardFlow.indexOf('Create the GitHub release as a draft');
  const downloadProofIndex = standardFlow.indexOf('Download all draft assets');
  const publishIndex = standardFlow.indexOf('Immediately before publication');
  const attestationIndex = standardFlow.indexOf('release verify <tag>');
  const siteBranchIndex = standardFlow.indexOf('post-release site branch');
  const siteMergeIndex = standardFlow.indexOf('merge its code-owned PR into protected `v2.4.x`');
  const deployIndex = standardFlow.indexOf('Deploy Cloudflare Pages only');
  for (const marker of [
    repositoryToolIndex,
    governanceIndex,
    canonicalToolIndex,
    versionIndex,
    buildIndex,
    finalizerIndex,
    proofRootIndex,
    proofIndex,
    containerProofIndex,
    metadataIndex,
    tagIndex,
    remoteTagIndex,
    draftReleaseIndex,
    downloadProofIndex,
    publishIndex,
    attestationIndex,
    siteBranchIndex,
    siteMergeIndex,
    deployIndex,
  ]) {
    assert.notEqual(marker, -1);
  }
  assert.equal(repositoryToolIndex < governanceIndex, true);
  assert.equal(governanceIndex < canonicalToolIndex, true);
  assert.equal(canonicalToolIndex < versionIndex, true);
  assert.equal(buildIndex < finalizerIndex, true);
  assert.equal(finalizerIndex < proofRootIndex, true);
  assert.equal(buildIndex < proofRootIndex, true);
  assert.equal(proofRootIndex < proofIndex, true);
  assert.equal(proofIndex < containerProofIndex, true);
  assert.equal(containerProofIndex < metadataIndex, true);
  assert.equal(metadataIndex < tagIndex, true);
  assert.equal(tagIndex < remoteTagIndex, true);
  assert.equal(remoteTagIndex < draftReleaseIndex, true);
  assert.equal(draftReleaseIndex < downloadProofIndex, true);
  assert.equal(downloadProofIndex < publishIndex, true);
  assert.equal(publishIndex < attestationIndex, true);
  assert.equal(attestationIndex < siteBranchIndex, true);
  assert.equal(siteBranchIndex < siteMergeIndex, true);
  assert.equal(siteMergeIndex < deployIndex, true);

  const dmgEnvelopeFlow = standardFlow.slice(
    standardFlow.indexOf('11. With separate approval'),
    standardFlow.indexOf('12. With explicit approval')
  );
  const dmgCodesignIndex = dmgEnvelopeFlow.indexOf('/usr/bin/codesign --verify --strict --verbose=2 <dmg>');
  const dmgSubmitIndex = dmgEnvelopeFlow.indexOf('/usr/bin/xcrun notarytool submit <dmg>');
  const dmgStapleIndex = dmgEnvelopeFlow.indexOf('/usr/bin/xcrun stapler staple <dmg>');
  const dmgStapleValidateIndex = dmgEnvelopeFlow.indexOf('/usr/bin/xcrun stapler validate <dmg>');
  const dmgSpctlIndex = dmgEnvelopeFlow.indexOf('/usr/sbin/spctl -a -t open --context context:primary-signature -v <dmg>');
  const dmgFinalizerIndex = dmgEnvelopeFlow.indexOf('scripts/finalize-mac-release-metadata.js');
  for (const marker of [
    dmgCodesignIndex,
    dmgSubmitIndex,
    dmgStapleIndex,
    dmgStapleValidateIndex,
    dmgSpctlIndex,
    dmgFinalizerIndex,
  ]) {
    assert.notEqual(marker, -1);
  }
  assert.equal(dmgCodesignIndex < dmgSubmitIndex, true);
  assert.equal(dmgSubmitIndex < dmgStapleIndex, true);
  assert.equal(dmgStapleIndex < dmgStapleValidateIndex, true);
  assert.equal(dmgStapleValidateIndex < dmgSpctlIndex, true);
  assert.equal(dmgSpctlIndex < dmgFinalizerIndex, true);
  assert.doesNotMatch(dmgEnvelopeFlow, /(?:require|run).*spctl.*before submission/iu);

  const approvalCommands = releasePlaybook.slice(
    releasePlaybook.indexOf('## Commands Requiring Explicit Bryant Approval'),
    releasePlaybook.indexOf('## Standard Flow')
  );
  assert.match(
    approvalCommands,
    /<sanitized-git-command> fetch --force origin refs\/tags\/<tag>:refs\/tags\/<tag>/u
  );
  assert.match(
    approvalCommands,
    /test "\$\(<sanitized-git-command> rev-parse '<tag>\^\{commit\}'\)" = "<approved-release-commit>"/u
  );
  assert.match(approvalCommands, /<sanitized-git-command> worktree add --detach <isolated-verifier-source-root> <release-commit>/u);
  assert.match(approvalCommands, /<sanitized-gh-environment> "<canonical-gh-executable>" release create --verify-tag --draft <tag>/u);
  assert.match(approvalCommands, /<sanitized-gh-environment> "<canonical-gh-executable>" release download <tag>/u);
  assert.match(approvalCommands, /<sanitized-gh-environment> "<canonical-gh-executable>" release edit <tag> --draft=false/u);
  assert.match(approvalCommands, /<sanitized-gh-environment> "<canonical-gh-executable>" release verify <tag>/u);
  assert.match(approvalCommands, /<sanitized-gh-environment> "<canonical-gh-executable>" release verify-asset <tag> <local-approved-artifact>/u);
  assert.match(approvalCommands, /\/usr\/bin\/hdiutil attach -readonly -nobrowse/u);
  assert.match(approvalCommands, /\/usr\/bin\/ditto -x -k/u);
  assert.match(approvalCommands, /\/usr\/bin\/codesign --verify --strict --verbose=2 <dmg>/u);
  assert.match(approvalCommands, /scripts\/finalize-mac-release-metadata\.js/u);
  assert.match(approvalCommands, /<sanitized-gh-environment> "<canonical-gh-executable>" pr checks <pr-number> --watch/u);
  assert.match(approvalCommands, /<sanitized-gh-environment> "<canonical-gh-executable>" pr merge <pr-number>/u);
  assert.doesNotMatch(approvalCommands, /(?:^|\n)(?!<sanitized-git-command>)\s*(?:\/usr\/bin\/)?git\s+/u);
  assert.doesNotMatch(approvalCommands, /(?:^|\n)(?!<sanitized-gh-environment>)\s*(?:gh|"<canonical-gh-executable>")\s+/u);
  assert.doesNotMatch(approvalCommands, /git push origin v2\.4\.x/u);

  const releaseGate = fs.readFileSync(
    path.join(ROOT, '.codex', 'playbooks', 'crate-release-gate.md'),
    'utf8'
  );
  assert.match(
    releaseGate,
    /<sanitized-git-command> fetch --force origin refs\/tags\/<tag>:refs\/tags\/<tag>/u
  );
  assert.match(
    releaseGate,
    /test "\$\(<sanitized-git-command> rev-parse '<tag>\^\{commit\}'\)" = "<approved-release-commit>"/u
  );
  assert.match(releaseGate, /<sanitized-git-command> worktree add --detach <isolated-verifier-source-root> <release-commit>/u);
  assert.match(releaseGate, /<sanitized-gh-environment> "<canonical-gh-executable>" release create --verify-tag --draft <tag>/u);
  assert.match(releaseGate, /<sanitized-gh-environment> "<canonical-gh-executable>" release download <tag>/u);
  assert.match(releaseGate, /<sanitized-gh-environment> "<canonical-gh-executable>" release edit <tag> --draft=false/u);
  assert.match(releaseGate, /<sanitized-gh-environment> "<canonical-gh-executable>" release verify <tag>/u);
  assert.match(releaseGate, /<sanitized-gh-environment> "<canonical-gh-executable>" release verify-asset <tag> <local-approved-artifact>/u);
  assert.match(releaseGate, /complete outer inventories.*explicit reviewed allowlists/iu);
  assert.match(releaseGate, /`codesign` validates that pre-submission signature/iu);
  assert.match(releaseGate, /Pre-notarization `spctl` acceptance is not a gate/iu);
  assert.match(releaseGate, /\/usr\/bin\/codesign --verify --strict --verbose=2 <path-to-dmg>/u);
  assert.match(releaseGate, /Pre-submission DMG signature check:[\s\S]*codesign[\s\S]*Post-notarization and post-staple DMG checks:[\s\S]*stapler validate[\s\S]*spctl/iu);
  assert.match(releaseGate, /immutable asset set.*attested subjects.*same exact manifest/iu);
  assert.match(releaseGate, /code-owned `crate-site\/index\.html`/iu);
  assert.match(
    releaseGate,
    /Define `<sanitized-git-environment>` as exactly `\/usr\/bin\/env -i HOME="<approved-home>" PATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin GIT_CONFIG_GLOBAL=\/dev\/null GIT_CONFIG_SYSTEM=\/dev\/null GIT_CONFIG_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 GIT_OPTIONAL_LOCKS=0`/u
  );
  assert.match(releaseGate, /Define `<sanitized-git-command>` as that environment followed by `\/usr\/bin\/git --no-optional-locks --no-replace-objects -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false -c core\.untrackedCache=false`/u);
  assert.match(
    releaseGate,
    /Define `<sanitized-node-environment>` as exactly `\/usr\/bin\/env -i HOME="<approved-home>" TMPDIR="<private-release-temp-root>" PATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin npm_config_cache="<private-release-cache-root>" npm_config_userconfig="<private-release-user-npmrc>" npm_config_globalconfig="<private-release-global-npmrc>"`/u
  );
  assert.match(releaseGate, /distinct empty mode-`0600` regular `<private-release-user-npmrc>` and `<private-release-global-npmrc>` files/iu);
  assert.doesNotMatch(releaseGate, /npm_config_(?:user|global)config=\/dev\/null/u);
  assert.doesNotMatch(releaseGate, /\/usr\/bin\/env -u/u);
  assert.doesNotMatch(releaseGate, /git push origin v2\.4\.x/u);
  assert.doesNotMatch(releaseGate, /(?:^|\n)\/usr\/bin\/curl /u);
  assert.match(
    releaseGate,
    /\/usr\/bin\/env -i HOME="<private-live-check-home>" PATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin \/usr\/bin\/curl -q --noproxy '\*' --proto '=https' --tlsv1\.2/u
  );
  assert.match(releaseGate, /live worktree is never the deploy input/iu);

  const checkSuites = fs.readFileSync(
    path.join(ROOT, '.codex', 'checks', 'crate-check-suites.md'),
    'utf8'
  );
  const releaseCheckSuites = checkSuites.slice(checkSuites.indexOf('## release-gate-readonly'));
  assert.match(
    releaseCheckSuites,
    /<sanitized-node-environment> "<canonical-node-executable>" "<canonical-npm-cli>" audit --audit-level=high --registry=https:\/\/registry\.npmjs\.org\//u
  );
  assert.doesNotMatch(releaseCheckSuites, /^npm audit /mu);
});

test('Cloudflare deployment authenticates fixed tools before reading the token', () => {
  const cloudflare = fs.readFileSync(
    path.join(ROOT, '.codex', 'playbooks', 'crate-cloudflare-deploy.md'),
    'utf8'
  );
  const toolGateIndex = cloudflare.indexOf('## Authenticated Tool Gate');
  const tokenIndex = cloudflare.indexOf('## Keychain Token Pattern');
  assert.notEqual(toolGateIndex, -1);
  assert.notEqual(tokenIndex, -1);
  assert.equal(toolGateIndex < tokenIndex, true);
  assert.match(cloudflare, /Never use `npx`, `npm exec`, an env shebang, or an on-demand Wrangler download/u);
  assert.match(cloudflare, /npm ci --ignore-scripts/u);
  assert.match(cloudflare, /reconstruct the tool tree immediately before token access/iu);
  assert.match(cloudflare, /complete reachable Wrangler dependency tree.*registry archives/iu);
  assert.match(cloudflare, /stale previously installed tool tree is not acceptable/iu);
  assert.match(cloudflare, /Wrangler CLI realpath\/SHA-256\/version.*tool lock hash.*tree inventory digest/iu);
  assert.match(
    cloudflare,
    /"<canonical-node-executable>" "<authenticated-wrangler-cli>" pages deploy "<private-site-snapshot-root>"/u
  );
  assert.match(cloudflare, /Materialize only the exact committed `crate-site` tree/iu);
  assert.match(cloudflare, /complete relative-path, Git-mode, byte-size, and Git-blob-ID inventory/iu);
  assert.match(cloudflare, /Never deploy `crate-site` from the live checkout/iu);
  assert.match(cloudflare, /\/usr\/bin\/security find-generic-password/u);
  assert.match(cloudflare, /-a "<approved-local-account>"/u);
  assert.doesNotMatch(cloudflare, /\$USER/u);
  assert.match(cloudflare, /\/usr\/bin\/env -i/u);
  assert.match(cloudflare, /<private-wrangler-home>.*start empty.*must not contain credentials, Wrangler configuration, npm configuration, or links/iu);
  assert.match(cloudflare, /HOME="<private-wrangler-home>"/u);
  assert.doesNotMatch(cloudflare, /\/usr\/bin\/env -i HOME="<approved-home>"[^\n]*(?:npm|Wrangler|authenticated-wrangler-cli)/iu);
  assert.match(cloudflare, /TMPDIR="<private-deploy-temp-root>"/u);
  assert.match(cloudflare, /PATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin/u);
  assert.match(cloudflare, /distinct empty mode-`0600` regular `<private-wrangler-user-npmrc>` and `<private-wrangler-global-npmrc>` files/iu);
  assert.match(cloudflare, /\/usr\/bin\/install -m 600 \/dev\/null/u);
  assert.match(
    cloudflare,
    /npm_config_userconfig="<private-wrangler-user-npmrc>" npm_config_globalconfig="<private-wrangler-global-npmrc>"/u
  );
  assert.doesNotMatch(cloudflare, /npm_config_(?:user|global)config=\/dev\/null/u);
  assert.match(cloudflare, /set \+x\n  set \+v/u);
  assert.match(cloudflare, /trap 'unset CLOUDFLARE_API_TOKEN; test -z "\$account_proof" \|\| \/bin\/rm -f "\$account_proof"' EXIT HUP INT TERM/u);
  assert.doesNotMatch(cloudflare, /export CLOUDFLARE_API_TOKEN/u);
  assert.match(cloudflare, /Never export or echo the token/u);
  assert.match(cloudflare, /\/usr\/bin\/mktemp "<private-deploy-temp-root>\/crate-site-live\.XXXXXX"/u);
  assert.doesNotMatch(cloudflare, /\/tmp\/crate-site-live\.html/u);
  const deployWrapper = [
    '  cd "<private-wrangler-home>" || exit 1',
    '  /usr/bin/env -i \\',
    '    HOME="<private-wrangler-home>" \\',
    '    TMPDIR="<private-deploy-temp-root>" \\',
    '    PATH=/usr/bin:/bin:/usr/sbin:/sbin \\',
    '    CLOUDFLARE_ACCOUNT_ID="ba2eae4575a070ed70ae9be217fa21dc" \\',
    '    CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \\',
    '    "<canonical-node-executable>" "<authenticated-wrangler-cli>" pages deploy "<private-site-snapshot-root>" \\',
  ].join('\n');
  const listWrapper = [
    '  cd "<private-wrangler-home>" || exit 1',
    '  /usr/bin/env -i \\',
    '    HOME="<private-wrangler-home>" \\',
    '    TMPDIR="<private-deploy-temp-root>" \\',
    '    PATH=/usr/bin:/bin:/usr/sbin:/sbin \\',
    '    CLOUDFLARE_ACCOUNT_ID="ba2eae4575a070ed70ae9be217fa21dc" \\',
    '    CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \\',
    '    "<canonical-node-executable>" "<authenticated-wrangler-cli>" pages deployment list --project-name get-crate',
  ].join('\n');
  assert.equal(cloudflare.includes(deployWrapper), true);
  assert.equal(cloudflare.includes(listWrapper), true);
  assert.match(cloudflare, /"<authenticated-wrangler-cli>" whoami/u);
  assert.match(cloudflare, /crate-cloudflare-account\.XXXXXX/u);
  assert.match(cloudflare, /private `whoami` proof must contain the one fixed account ID/iu);
  assert.match(cloudflare, /CLOUDFLARE_ACCOUNT_ID="ba2eae4575a070ed70ae9be217fa21dc"/u);
  assert.match(cloudflare, /\/usr\/bin\/env -i HOME="<private-live-check-home>" PATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin \\\n  \/usr\/bin\/curl -q --noproxy '\*' --proto '=https'/u);
  assert.doesNotMatch(cloudflare, /\bnpx\s+wrangler\b|npm exec\s+wrangler/iu);
  assert.match(cloudflare, /git status --porcelain=v1 --untracked-files=all.*empty/iu);
  assert.match(cloudflare, /`HEAD` equals the approved commit.*`origin\/<approved-branch>`/iu);
  assert.match(cloudflare, /Never pass `--commit-dirty=true`/u);
  assert.doesNotMatch(cloudflare, /pages deploy crate-site/u);
  assert.doesNotMatch(cloudflare, /^\s+--commit-dirty=true$/mu);
});

test('top-level release authority matches the hardened release playbook', () => {
  const instructions = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  assert.match(instructions, /Select the release profile before mutation/iu);
  assert.match(instructions, /tester beta.*GitHub release and `get-crate\.com` download flow/iu);
  assert.match(instructions, /public stable release.*independent controlling-principal approval/iu);
  assert.match(instructions, /account-gated download backend/iu);
  assert.match(instructions, /version-only release-prep PR/iu);
  assert.match(instructions, /combined build, signing, app-notarization, app-stapling, and app-staple-validation approval/iu);
  assert.match(instructions, /separate clean proof and verifier worktrees at the release commit/iu);
  assert.match(instructions, /canonical paths differ/iu);
  assert.match(instructions, /exact pinned official Canvas arm64 prebuild/iu);
  assert.match(instructions, /exact release SHA, GitHub Actions app, check suite/iu);
  assert.match(instructions, /exact launch\/security metadata/iu);
  assert.match(instructions, /internally consistent main\/helper build metadata/iu);
  assert.match(instructions, /complete allowlisted outer container inventories/iu);
  assert.match(instructions, /app extracted from every final DMG\/ZIP/iu);
  assert.match(instructions, /every and only approved filename, byte size, and SHA-256/iu);
  assert.match(instructions, /remote SHA matches the approved release commit/iu);
  assert.match(instructions, /GitHub release as a draft/iu);
  assert.match(instructions, /immutable-release enforcement/iu);
  assert.match(instructions, /attested subjects to equal the same exact set/iu);
  const governanceIndex = instructions.indexOf('Select the release profile before mutation');
  const versionIndex = instructions.indexOf('version-only release-prep PR');
  assert.notEqual(governanceIndex, -1);
  assert.notEqual(versionIndex, -1);
  assert.equal(governanceIndex < versionIndex, true);
});

test('notarization logging and failures omit local app paths and tool diagnostics', async () => {
  const notarizeSource = fs.readFileSync(path.join(ROOT, 'scripts', 'notarize.js'), 'utf8');
  assert.doesNotMatch(notarizeSource, /Submitting \$\{appPath\}/u);
  assert.match(notarizeSource, /Submitting signed app to Apple/u);
  assert.doesNotMatch(notarizeSource, /^const \{ notarize \} = require\('@electron\/notarize'\);$/mu);
  assert.match(notarizeSource, /const notarizeEntry = require\.resolve\('@electron\/notarize'\)/u);
  assert.match(notarizeSource, /require\.resolve\('debug', \{\s*paths: \[path\.dirname\(notarizeEntry\)\]/u);
  assert.match(notarizeSource, /dependencies\.notarize \|\| require\('@electron\/notarize'\)\.notarize/u);
  assert.equal(NOTARYTOOL_KEYCHAIN_PROFILE, 'crate-release-notarytool');
  assert.match(notarizeSource, /keychainProfile: NOTARYTOOL_KEYCHAIN_PROFILE/u);
  assert.doesNotMatch(notarizeSource, /appleApiKey|appleApiIssuer|AuthKey_/u);
  const notarizeIndex = notarizeSource.indexOf('await withoutNotarizeDebug');
  const stapleIndex = notarizeSource.indexOf("['stapler', 'staple', appPath]");
  const validateIndex = notarizeSource.indexOf("['stapler', 'validate', appPath]");
  assert.equal(notarizeIndex < stapleIndex, true);
  assert.equal(stapleIndex < validateIndex, true);
  assert.match(notarizeSource, /Signed app could not be submitted and accepted by Apple/u);
  assert.match(notarizeSource, /Accepted ticket could not be stapled and validated/u);

  const context = {
    appOutDir: '/private/tmp/private-release-output',
    electronPlatformName: 'darwin',
    packager: { appInfo: { productFilename: 'Crate' } },
  };
  const privateFailure = 'private notary diagnostics at /Users/example/secret/Crate.app';
  await assert.rejects(
    notarizing({
      appOutDir: '/Users/example/private-release-output',
      electronPlatformName: 'darwin',
    }),
    error => error.message === '[notarize] Signed app could not be prepared for Apple notarization.' &&
      error.stack === error.message &&
      !error.message.includes('/Users/example') && !error.message.includes('private-release-output')
  );
  await assert.rejects(
    notarizing({
      appOutDir: '/private/tmp/private-release-output',
      electronPlatformName: 'darwin',
      packager: { appInfo: { productFilename: '../private-app-name' } },
    }),
    error => error.message === '[notarize] Signed app could not be prepared for Apple notarization.' &&
      error.stack === error.message &&
      !error.message.includes('private-app-name')
  );
  await assert.rejects(
    notarizing(context, {
      notarize: async () => { throw new Error(privateFailure); },
    }),
    error => error.message === '[notarize] Signed app could not be submitted and accepted by Apple.' &&
      error.stack === error.message &&
      !error.message.includes('/Users/example') && !error.message.includes('private notary')
  );
  await assert.rejects(
    notarizing(context, {
      notarize: async () => {},
      execFileSync: () => { throw new Error(privateFailure); },
    }),
    error => error.message === '[notarize] Accepted ticket could not be stapled and validated.' &&
      error.stack === error.message &&
      !error.message.includes('/Users/example') && !error.message.includes('private notary')
  );

  const previousNamespaces = debug.disable();
  debug.enable('crate-test:*,electron-notarize:*');
  try {
    let observed = null;
    let submitted = null;
    await notarizing(context, {
      notarize: async options => {
        submitted = options;
        observed = {
          unrelated: debug.enabled('crate-test:release'),
          private: debug.enabled('electron-notarize:notarytool'),
        };
      },
      notarizeDebug: debug,
      execFileSync: () => Buffer.alloc(0),
    });
    assert.deepEqual(observed, { unrelated: true, private: false });
    assert.deepEqual(submitted, {
      appPath: '/private/tmp/private-release-output/Crate.app',
      keychainProfile: NOTARYTOOL_KEYCHAIN_PROFILE,
      tool: 'notarytool',
    });
    assert.equal(debug.disable(), 'crate-test:*,electron-notarize:*');
  } finally {
    debug.enable(previousNamespaces);
  }
});

test('optional notarization Keychain selection preserves literal arguments and awaited staple guards', async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(
    process.env.CRATE_TEST_OUTPUT_ROOT || require('node:os').tmpdir(), 'crate-notary-keychain-'
  )));
  const keychain = path.join(root, "literal $(not-a-command) ; ' --keychain-profile other.keychain-db");
  fs.writeFileSync(keychain, 'synthetic fixture; no credentials', { mode: 0o600 });
  const context = {
    appOutDir: root, electronPlatformName: 'darwin',
    packager: { appInfo: { productFilename: 'Crate' } },
  };
  const events = [];
  let finishSubmission;
  const accepted = new Promise(resolve => { finishSubmission = resolve; });
  const previousNamespaces = debug.disable();
  debug.enable('crate-test:*,electron-notarize:*');
  try {
    const operation = notarizing(context, {
      env: { CRATE_RELEASE_NOTARYTOOL_KEYCHAIN: keychain },
      notarizeDebug: debug,
      notarize: async options => {
        events.push(['submit', options]);
        assert.equal(debug.enabled('electron-notarize:notarytool'), false);
        await accepted;
      },
      execFileSync: (command, args, options) => {
        events.push([command, args, options]);
        return Buffer.alloc(0);
      },
    });
    assert.deepEqual(events, [['submit', {
      tool: 'notarytool', appPath: path.join(root, 'Crate.app'),
      keychainProfile: 'crate-release-notarytool', keychain,
    }]]);
    finishSubmission();
    await operation;
    assert.deepEqual(events.slice(1), [
      ['/usr/bin/xcrun', ['stapler', 'staple', path.join(root, 'Crate.app')], { stdio: ['ignore', 'pipe', 'pipe'] }],
      ['/usr/bin/xcrun', ['stapler', 'validate', path.join(root, 'Crate.app')], { stdio: ['ignore', 'pipe', 'pipe'] }],
    ]);
    assert.equal(debug.disable(), 'crate-test:*,electron-notarize:*');
  } finally {
    debug.enable(previousNamespaces);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('invalid optional notarization Keychain paths fail before submission without path disclosure', async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(
    process.env.CRATE_TEST_OUTPUT_ROOT || require('node:os').tmpdir(), 'crate-notary-invalid-'
  )));
  const file = path.join(root, 'synthetic.keychain-db');
  fs.writeFileSync(file, 'synthetic fixture; no credentials', { mode: 0o600 });
  const link = path.join(root, 'link.keychain-db');
  fs.symlinkSync(file, link);
  const parentLink = path.join(root, 'linked-parent');
  fs.symlinkSync(root, parentLink, 'dir');
  const unreadable = path.join(root, 'unreadable.keychain-db');
  fs.writeFileSync(unreadable, 'synthetic fixture; no credentials', { mode: 0o000 });
  let calls = 0;
  try {
    for (const keychain of ['', 'relative.keychain-db', '--keychain-profile other', null, 42,
      path.join(root, 'missing.keychain-db'), root, link, unreadable, path.join(parentLink, 'synthetic.keychain-db'),
      `${file}\n--password secret`, `${file}\u0000`, `${file}\t`, `${file}\u007f`]) {
      await assert.rejects(notarizing({
        appOutDir: root, electronPlatformName: 'darwin',
        packager: { appInfo: { productFilename: 'Crate' } },
      }, {
        env: { CRATE_RELEASE_NOTARYTOOL_KEYCHAIN: keychain },
        notarize: async () => { calls++; }, execFileSync: () => { calls++; },
      }), error => error.message === '[notarize] Existing Keychain path is invalid or unavailable.' &&
        error.stack === error.message && !error.message.includes(root) && !error.message.includes('secret'));
    }
    assert.equal(calls, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('explicit Keychain submission and staple failures preserve refusal and diagnostic redaction', async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(
    process.env.CRATE_TEST_OUTPUT_ROOT || require('node:os').tmpdir(), 'crate-notary-refusal-'
  )));
  const keychain = path.join(root, 'private-synthetic.keychain-db');
  fs.writeFileSync(keychain, 'synthetic fixture; no credentials', { mode: 0o600 });
  const context = { appOutDir: root, electronPlatformName: 'darwin', packager: { appInfo: { productFilename: 'Crate' } } };
  let stapleCalls = 0;
  try {
    await assert.rejects(notarizing(context, {
      env: { CRATE_RELEASE_NOTARYTOOL_KEYCHAIN: keychain },
      notarize: async () => { throw new Error(`private diagnostics ${keychain} secret`); },
      execFileSync: () => { stapleCalls++; },
    }), error => error.message === '[notarize] Signed app could not be submitted and accepted by Apple.' && error.stack === error.message);
    assert.equal(stapleCalls, 0);
    await assert.rejects(notarizing(context, {
      env: { CRATE_RELEASE_NOTARYTOOL_KEYCHAIN: keychain },
      notarize: async () => {},
      execFileSync: (command, args) => {
        stapleCalls++;
        assert.equal(args[1], 'staple');
        throw new Error(`private diagnostics ${keychain} secret`);
      },
    }), error => error.message === '[notarize] Accepted ticket could not be stapled and validated.' && error.stack === error.message);
    assert.equal(stapleCalls, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('CODEOWNERS declares Crate review ownership for sensitive release-policy files', () => {
  const codeowners = fs.readFileSync(path.join(ROOT, '.github', 'CODEOWNERS'), 'utf8');
  const ownersByPath = new Map(codeowners.trim().split('\n').map(line => line.trim().split(/\s+/u)));
  for (const protectedPath of [
    '/.github/**',
    '/AGENTS.md',
    '/.codex/**',
    '/entitlements.inherit.plist',
    '/entitlements.plist',
    '/package-lock.json',
    '/package.json',
    '/crate-site/**',
    '/main.js',
    '/preload.js',
    '/provenance.js',
    '/diagnostic-summary.js',
    '/renderer/**',
    '/parsers/**',
    '/assets/**',
    '/build/**',
    '/scripts/**',
    '/tests/**',
  ]) {
    assert.equal(ownersByPath.get(protectedPath), '@bfeintuch123');
  }
});

const REAL_SWIFT_TOOLCHAIN_SKIP = process.platform !== 'darwin' || !fs.existsSync('/usr/bin/swiftc')
  ? 'requires macOS with /usr/bin/swiftc'
  : false;
let cachedCompiledNativeHelper = null;

function repositoryNativeHelperSources() {
  return Object.fromEntries(NATIVE_HELPER_SOURCE_FILES.map(name => [
    name,
    fs.readFileSync(path.join(ROOT, ...NATIVE_HELPER_SOURCE_DIR.split('/'), name)),
  ]));
}

function compileRepositoryNativeHelper() {
  if (!cachedCompiledNativeHelper) {
    cachedCompiledNativeHelper = compileNativeHelper(repositoryNativeHelperSources());
    assert.equal(Buffer.isBuffer(cachedCompiledNativeHelper), true);
  }
  return cachedCompiledNativeHelper;
}

function machOTextSectionRange(bytes) {
  const commandCount = bytes.readUInt32LE(16);
  let offset = 32;
  for (let index = 0; index < commandCount; index += 1) {
    const command = bytes.readUInt32LE(offset);
    const size = bytes.readUInt32LE(offset + 4);
    if (command === 0x19) {
      const sectionCount = bytes.readUInt32LE(offset + 64);
      for (let section = 0; section < sectionCount; section += 1) {
        const sectionOffset = offset + 72 + section * 80;
        const name = bytes.subarray(sectionOffset, sectionOffset + 16).toString('latin1').replace(/\0+$/u, '');
        const segment = bytes.subarray(sectionOffset + 16, sectionOffset + 32).toString('latin1').replace(/\0+$/u, '');
        if (segment === '__TEXT' && name === '__text') {
          return {
            offset: bytes.readUInt32LE(sectionOffset + 48),
            size: Number(bytes.readBigUInt64LE(sectionOffset + 40)),
          };
        }
      }
    }
    offset += size;
  }
  return null;
}

function codesignStrictRequirement(filePath) {
  return spawnSync('/usr/bin/codesign', [
    '--verify',
    '--strict',
    `-R=${EXPECTED_NATIVE_HELPER_REQUIREMENT}`,
    filePath,
  ], { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, encoding: 'utf8' });
}

function buildSyntheticArm64MachO({
  magic = 0xfeedfacf,
  cputype = 0x0100000c,
  filetype = 2,
  gapBytes = 8,
  gapFill = 0x00,
  includeCodeSignature = false,
  codeSigDataoff = null,
  codeSigDatasize = 64,
  trailingBytes = 0,
  linkeditVmsize = 16384,
  linkeditNsects = 0,
  duplicateLinkedit = false,
  duplicateSymtab = false,
  duplicateDysymtab = false,
  extraCommand = null,
  textSectionNreloc = 0,
  textSectionReloff = 0,
  functionStartsEndOffset = null,
  overrideSymtabStrsize = null,
} = {}) {
  const linkeditOff = 4096;
  const symOff = linkeditOff;
  const symSize = 16; // 1 nlist_64
  const strOff = symOff + symSize;
  const targetUnalignedEnd = 4160 - gapBytes;
  const strSize = overrideSymtabStrsize !== null ? overrideSymtabStrsize : Math.max(1, targetUnalignedEnd - strOff);
  const strEnd = strOff + strSize;
  const linkeditContentEnd = strEnd + gapBytes;
  const sigOff = codeSigDataoff !== null ? codeSigDataoff : linkeditContentEnd;
  const linkeditEnd = includeCodeSignature ? sigOff + codeSigDatasize : linkeditContentEnd;
  const linkeditFilesize = linkeditEnd - linkeditOff;
  const totalSize = linkeditEnd + trailingBytes;

  const commands = [];
  // __TEXT segment with one __text section (72 + 80 = 152 bytes)
  const textSeg = Buffer.alloc(152, 0);
  textSeg.writeUInt32LE(0x19, 0);
  textSeg.writeUInt32LE(152, 4);
  textSeg.write('__TEXT', 8, 'latin1');
  textSeg.writeBigUInt64LE(0x100000000n, 24);
  textSeg.writeBigUInt64LE(BigInt(linkeditOff), 32);
  textSeg.writeBigUInt64LE(0n, 40);
  textSeg.writeBigUInt64LE(BigInt(linkeditOff), 48);
  textSeg.writeUInt32LE(1, 64); // nsects
  textSeg.write('__text', 72, 'latin1');
  textSeg.write('__TEXT', 88, 'latin1');
  textSeg.writeBigUInt64LE(64n, 72 + 40); // size
  textSeg.writeUInt32LE(2048, 72 + 48); // offset
  textSeg.writeUInt32LE(textSectionReloff, 72 + 56);
  textSeg.writeUInt32LE(textSectionNreloc, 72 + 60);
  textSeg.writeUInt32LE(0x80000400, 72 + 64); // S_REGULAR | S_ATTR_PURE_INSTRUCTIONS
  commands.push(textSeg);

  const makeLinkeditCmd = () => {
    const size = 72 + linkeditNsects * 80;
    const cmd = Buffer.alloc(size, 0);
    cmd.writeUInt32LE(0x19, 0);
    cmd.writeUInt32LE(size, 4);
    cmd.write('__LINKEDIT', 8, 'latin1');
    cmd.writeBigUInt64LE(0x100004000n, 24);
    cmd.writeBigUInt64LE(BigInt(linkeditVmsize), 32);
    cmd.writeBigUInt64LE(BigInt(linkeditOff), 40);
    cmd.writeBigUInt64LE(BigInt(linkeditFilesize), 48);
    cmd.writeUInt32LE(linkeditNsects, 64);
    return cmd;
  };
  commands.push(makeLinkeditCmd());
  if (duplicateLinkedit) commands.push(makeLinkeditCmd());

  const makeSymtabCmd = () => {
    const cmd = Buffer.alloc(24, 0);
    cmd.writeUInt32LE(0x02, 0);
    cmd.writeUInt32LE(24, 4);
    cmd.writeUInt32LE(symOff, 8);
    cmd.writeUInt32LE(1, 12);
    cmd.writeUInt32LE(strOff, 16);
    cmd.writeUInt32LE(strSize, 20);
    return cmd;
  };
  commands.push(makeSymtabCmd());
  if (duplicateSymtab) commands.push(makeSymtabCmd());

  if (duplicateDysymtab) {
    for (let index = 0; index < 2; index += 1) {
      const dysym = Buffer.alloc(80, 0);
      dysym.writeUInt32LE(0x0b, 0);
      dysym.writeUInt32LE(80, 4);
      commands.push(dysym);
    }
  }

  if (functionStartsEndOffset !== null) {
    const fnCmd = Buffer.alloc(16, 0);
    fnCmd.writeUInt32LE(0x26, 0);
    fnCmd.writeUInt32LE(16, 4);
    fnCmd.writeUInt32LE(linkeditOff, 8);
    fnCmd.writeUInt32LE(functionStartsEndOffset - linkeditOff, 12);
    commands.push(fnCmd);
  }

  const uuidCmd = Buffer.alloc(24, 0);
  uuidCmd.writeUInt32LE(0x1b, 0);
  uuidCmd.writeUInt32LE(24, 4);
  commands.push(uuidCmd);

  if (extraCommand) commands.push(extraCommand);

  if (includeCodeSignature) {
    const sigCmd = Buffer.alloc(16, 0);
    sigCmd.writeUInt32LE(0x1d, 0);
    sigCmd.writeUInt32LE(16, 4);
    sigCmd.writeUInt32LE(sigOff, 8);
    sigCmd.writeUInt32LE(codeSigDatasize, 12);
    commands.push(sigCmd);
  }

  const cmdBlock = Buffer.concat(commands);
  const buffer = Buffer.alloc(totalSize, 0);
  buffer.writeUInt32LE(magic, 0);
  buffer.writeUInt32LE(cputype, 4);
  buffer.writeUInt32LE(0, 8);
  buffer.writeUInt32LE(filetype, 12);
  buffer.writeUInt32LE(commands.length, 16);
  buffer.writeUInt32LE(cmdBlock.length, 20);
  buffer.writeUInt32LE(0x00200085, 24);
  cmdBlock.copy(buffer, 32);

  // Fill synthetic __text and string table with non-zero bytes so truncation/corruption is obvious.
  buffer.fill(0x55, 2048, 2048 + 64);
  buffer.fill(0x41, strOff, strEnd);
  if (gapBytes > 0) buffer.fill(gapFill, strEnd, strEnd + gapBytes);
  if (includeCodeSignature) buffer.fill(0xaa, sigOff, sigOff + codeSigDatasize);
  return { buffer, linkeditCmdOffset: 32 + textSeg.length, linkeditOff, linkeditFilesize, strEnd, sigOff };
}

test('trimRemovedSignaturePadding trims only provable 1..15-byte all-zero signature alignment padding', () => {
  for (const gapBytes of [1, 8, 15]) {
    const signed = buildSyntheticArm64MachO({ gapBytes, includeCodeSignature: true });
    const removed = buildSyntheticArm64MachO({ gapBytes, includeCodeSignature: false });
    const trimmed = trimRemovedSignaturePadding(signed.buffer, removed.buffer);
    assert.notEqual(trimmed, removed.buffer, `gap ${gapBytes} should trim`);
    assert.equal(trimmed.length, removed.strEnd);
    assert.equal(
      trimmed.readBigUInt64LE(removed.linkeditCmdOffset + 48),
      BigInt(removed.linkeditFilesize - gapBytes)
    );
    assert.equal(trimmed.readBigUInt64LE(removed.linkeditCmdOffset + 32), 16384n);
    const expected = Buffer.from(removed.buffer.subarray(0, removed.strEnd));
    expected.writeBigUInt64LE(BigInt(removed.linkeditFilesize - gapBytes), removed.linkeditCmdOffset + 48);
    assert.equal(trimmed.equals(expected), true);
  }
});

test('trimRemovedSignaturePadding leaves ineligible, unsigned, tampered, or malformed inputs unchanged', () => {
  const signed8 = buildSyntheticArm64MachO({ gapBytes: 8, includeCodeSignature: true }).buffer;
  const removed8 = buildSyntheticArm64MachO({ gapBytes: 8, includeCodeSignature: false }).buffer;

  // Gap 0 (already aligned)
  const signed0 = buildSyntheticArm64MachO({ gapBytes: 0, includeCodeSignature: true }).buffer;
  const removed0 = buildSyntheticArm64MachO({ gapBytes: 0, includeCodeSignature: false }).buffer;
  assert.equal(trimRemovedSignaturePadding(signed0, removed0), removed0);

  // Gap >= 16
  const signed16 = buildSyntheticArm64MachO({ gapBytes: 16, includeCodeSignature: true }).buffer;
  const removed16 = buildSyntheticArm64MachO({ gapBytes: 16, includeCodeSignature: false }).buffer;
  assert.equal(trimRemovedSignaturePadding(signed16, removed16), removed16);

  // Non-zero byte in the 8-byte alignment gap
  const removedNonZeroGap = buildSyntheticArm64MachO({ gapBytes: 8, gapFill: 0x01, includeCodeSignature: false }).buffer;
  assert.equal(trimRemovedSignaturePadding(signed8, removedNonZeroGap), removedNonZeroGap);

  // Already-unsigned input (no LC_CODE_SIGNATURE on originalBytes)
  assert.equal(trimRemovedSignaturePadding(removed8, removed8), removed8);

  // Original LC_CODE_SIGNATURE not 16-byte aligned
  const unalignedSig = buildSyntheticArm64MachO({
    gapBytes: 0,
    includeCodeSignature: true,
    codeSigDataoff: 4152,
    overrideSymtabStrsize: 4148 - 4112,
  }).buffer;
  const removedAt4152 = buildSyntheticArm64MachO({
    gapBytes: 4,
    includeCodeSignature: false,
    overrideSymtabStrsize: 4148 - 4112,
  }).buffer;
  assert.equal(trimRemovedSignaturePadding(unalignedSig, removedAt4152), removedAt4152);

  // Removed length differs from original LC_CODE_SIGNATURE dataoff (e.g. already trimmed on newer macOS)
  const alreadyTrimmed = trimRemovedSignaturePadding(signed8, removed8);
  assert.equal(trimRemovedSignaturePadding(signed8, alreadyTrimmed), alreadyTrimmed);

  // LC_CODE_SIGNATURE still present after removal
  assert.equal(trimRemovedSignaturePadding(signed8, signed8), signed8);

  // Trailing bytes after __LINKEDIT
  const signedTrail = buildSyntheticArm64MachO({ gapBytes: 8, includeCodeSignature: true, trailingBytes: 0 }).buffer;
  const removedTrail = buildSyntheticArm64MachO({ gapBytes: 8, includeCodeSignature: false, trailingBytes: 16 }).buffer;
  assert.equal(trimRemovedSignaturePadding(signedTrail, removedTrail), removedTrail);

  // Another linkedit range ends past strEnd
  const removedRangePastStr = buildSyntheticArm64MachO({
    gapBytes: 8,
    includeCodeSignature: false,
    functionStartsEndOffset: 4160,
  }).buffer;
  assert.equal(trimRemovedSignaturePadding(signed8, removedRangePastStr), removedRangePastStr);

  // Excluded / unknown load commands: LC_NOTE (0x31), LC_ENCRYPTION_INFO_64 (0x2c), unknown (0x7fff)
  for (const [cmdId, size] of [[0x31, 40], [0x2c, 24], [0x7fff, 16]]) {
    const extra = Buffer.alloc(size, 0);
    extra.writeUInt32LE(cmdId, 0);
    extra.writeUInt32LE(size, 4);
    const s = buildSyntheticArm64MachO({ gapBytes: 8, includeCodeSignature: true, extraCommand: extra }).buffer;
    const r = buildSyntheticArm64MachO({ gapBytes: 8, includeCodeSignature: false, extraCommand: extra }).buffer;
    assert.equal(trimRemovedSignaturePadding(s, r), r, `cmd 0x${cmdId.toString(16)} must not trim`);
  }

  // Duplicate __LINKEDIT, LC_SYMTAB, or LC_DYSYMTAB
  for (const opts of [{ duplicateLinkedit: true }, { duplicateSymtab: true }, { duplicateDysymtab: true }]) {
    const s = buildSyntheticArm64MachO({ gapBytes: 8, includeCodeSignature: true, ...opts }).buffer;
    const r = buildSyntheticArm64MachO({ gapBytes: 8, includeCodeSignature: false, ...opts }).buffer;
    assert.equal(trimRemovedSignaturePadding(s, r), r);
  }

  // Non-zero section relocations
  const sRel = buildSyntheticArm64MachO({ gapBytes: 8, includeCodeSignature: true, textSectionNreloc: 1 }).buffer;
  const rRel = buildSyntheticArm64MachO({ gapBytes: 8, includeCodeSignature: false, textSectionNreloc: 1 }).buffer;
  assert.equal(trimRemovedSignaturePadding(sRel, rRel), rRel);

  // Fat, 32-bit, big-endian, non-arm64, truncated, or malformed inputs never throw
  for (const bad of [
    Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]),
    Buffer.from([0xbe, 0xba, 0xfe, 0xca, 0, 0, 0, 2]),
    buildSyntheticArm64MachO({ magic: 0xfeedface, gapBytes: 8, includeCodeSignature: false }).buffer,
    buildSyntheticArm64MachO({ magic: 0xcffaedfe, gapBytes: 8, includeCodeSignature: false }).buffer,
    buildSyntheticArm64MachO({ cputype: 0x01000007, gapBytes: 8, includeCodeSignature: false }).buffer,
    removed8.subarray(0, 20),
    Buffer.alloc(0),
  ]) {
    assert.equal(trimRemovedSignaturePadding(signed8, bad), bad);
    assert.equal(trimRemovedSignaturePadding(bad, removed8), removed8);
  }
  const overflowingCmds = Buffer.from(removed8);
  overflowingCmds.writeUInt32LE(0xffffffff, 20);
  assert.equal(trimRemovedSignaturePadding(signed8, overflowingCmds), overflowingCmds);
  assert.equal(trimRemovedSignaturePadding(null, removed8), removed8);
});

test('canonicalNativeDigestFromBytes normalizes macOS 15 leftover signature padding while failing closed on non-zero or unsigned gaps', () => {
  const signed8 = buildSyntheticArm64MachO({ gapBytes: 8, includeCodeSignature: true });
  const removed8 = buildSyntheticArm64MachO({ gapBytes: 8, includeCodeSignature: false });
  const unpaddedTrimmed = trimRemovedSignaturePadding(signed8.buffer, removed8.buffer);
  assert.notEqual(unpaddedTrimmed, removed8.buffer);

  const strictStripAcceptsOnlyFilledLinkedit = filePath => {
    const buf = fs.readFileSync(filePath);
    const linkeditFilesize = Number(buf.readBigUInt64LE(removed8.linkeditCmdOffset + 48));
    const linkeditEnd = removed8.linkeditOff + linkeditFilesize;
    return linkeditEnd === removed8.strEnd && buf.length === removed8.strEnd;
  };

  // Emulate macOS 15 codesign --remove-signature (truncates only to dataoff, keeping 8 zero bytes) + strict strip -S.
  const digestFromMacos15Removal = canonicalNativeDigestFromBytes(signed8.buffer, (command, args) => {
    const target = args[args.length - 1];
    if (command === '/usr/bin/codesign') {
      fs.writeFileSync(target, removed8.buffer, { mode: 0o600 });
      return { ok: true, stdout: '', stderr: '' };
    }
    if (command === '/usr/bin/strip') {
      return { ok: strictStripAcceptsOnlyFilledLinkedit(target), stdout: '', stderr: '' };
    }
    return { ok: false, stdout: '', stderr: '' };
  });
  const expectedDigest = crypto.createHash('sha256').update(unpaddedTrimmed).digest('hex');
  assert.equal(digestFromMacos15Removal, expectedDigest);

  // Non-zero byte in the 8-byte gap is NOT trimmed -> strict strip rejects -> null.
  const removedNonZero = buildSyntheticArm64MachO({ gapBytes: 8, gapFill: 0x01, includeCodeSignature: false });
  const nonZeroGapDigest = canonicalNativeDigestFromBytes(signed8.buffer, (command, args) => {
    const target = args[args.length - 1];
    if (command === '/usr/bin/codesign') {
      fs.writeFileSync(target, removedNonZero.buffer, { mode: 0o600 });
      return { ok: true, stdout: '', stderr: '' };
    }
    if (command === '/usr/bin/strip') {
      return { ok: strictStripAcceptsOnlyFilledLinkedit(target), stdout: '', stderr: '' };
    }
    return { ok: false, stdout: '', stderr: '' };
  });
  assert.equal(nonZeroGapDigest, null);

  // Already-unsigned binary with 8 trailing zero bytes is NOT trimmed -> strict strip rejects -> null.
  const unsignedPaddedDigest = canonicalNativeDigestFromBytes(removed8.buffer, (command, args) => {
    const target = args[args.length - 1];
    if (command === '/usr/bin/codesign') {
      return { ok: true, stdout: '', stderr: '' };
    }
    if (command === '/usr/bin/strip') {
      return { ok: strictStripAcceptsOnlyFilledLinkedit(target), stdout: '', stderr: '' };
    }
    return { ok: false, stdout: '', stderr: '' };
  });
  assert.equal(unsignedPaddedDigest, null);
});

test('native helper recipe matches the developer build script token for token', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'build-native-helper.sh'), 'utf8');
  assert.equal(script.includes('SRC_DIR="$ROOT_DIR/native/crate-helper"'), true);
  assert.equal(NATIVE_HELPER_SOURCE_DIR, 'native/crate-helper');
  const invocation = script.match(/\/usr\/bin\/swiftc \\\n([\s\S]*?)\n\s*-o "\$OUT_BIN"\n/u);
  assert.ok(invocation);
  const tokens = invocation[1].replace(/\s*\\$/u, '').split(/\\\n/u)
    .flatMap(line => line.trim().split(/\s+/u)).filter(Boolean);
  const firstSource = tokens.findIndex(token => token.startsWith('"$SRC_DIR/'));
  assert.deepEqual(tokens.slice(0, firstSource), [...NATIVE_HELPER_SWIFTC_ARGS]);
  assert.deepEqual(
    tokens.slice(firstSource).map(token => token.replace(/^"\$SRC_DIR\//u, '').replace(/"$/u, '')),
    [...NATIVE_HELPER_SOURCE_FILES]
  );
  assert.deepEqual(
    fs.readdirSync(path.join(ROOT, ...NATIVE_HELPER_SOURCE_DIR.split('/'))).sort(),
    [...NATIVE_HELPER_SOURCE_FILES].sort()
  );
});

test('real Swift toolchain rebuilds the committed helper byte-identically from different private directories', {
  skip: REAL_SWIFT_TOOLCHAIN_SKIP,
}, t => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'crate-native-determinism-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const firstTemp = path.join(parent, 'a');
  const secondTemp = path.join(parent, 'a-considerably-longer-private-directory-name');
  fs.mkdirSync(firstTemp, { mode: 0o700 });
  fs.mkdirSync(secondTemp, { mode: 0o700 });
  const originalTmpdir = process.env.TMPDIR;
  const sources = repositoryNativeHelperSources();
  let first;
  let second;
  try {
    process.env.TMPDIR = firstTemp;
    first = compileNativeHelper(sources);
    process.env.TMPDIR = secondTemp;
    second = compileNativeHelper(sources);
  } finally {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
  }
  assert.equal(Buffer.isBuffer(first) && Buffer.isBuffer(second), true);
  assert.equal(first.equals(second), true);
  assert.equal(first.readUInt32LE(0), 0xfeedfacf);
  assert.equal(first.readUInt32LE(4), 0x0100000c);
  assert.equal(first.readUInt32LE(12), 2);
  assert.deepEqual(fs.readdirSync(firstTemp), []);
  assert.deepEqual(fs.readdirSync(secondTemp), []);
  cachedCompiledNativeHelper = first;
});

test('canonical helper digest survives runtime re-signing but not a code byte change or a trust downgrade', {
  skip: REAL_SWIFT_TOOLCHAIN_SKIP,
}, t => {
  const compiled = compileRepositoryNativeHelper();
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'crate-native-digest-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const helperPath = path.join(directory, 'crate-helper');
  fs.writeFileSync(helperPath, compiled, { mode: 0o755 });

  const compiledDigest = canonicalNativeDigestFromBytes(compiled);
  assert.match(String(compiledDigest), /^[a-f0-9]{64}$/u);
  assert.notEqual(codesignStrictRequirement(helperPath).status, 0);

  const resigned = spawnSync('/usr/bin/codesign', [
    '--force',
    '--sign',
    '-',
    '--options',
    'runtime',
    '--entitlements',
    path.join(ROOT, 'entitlements.inherit.plist'),
    helperPath,
  ], { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, encoding: 'utf8' });
  assert.equal(resigned.status, 0);
  const resignedBytes = fs.readFileSync(helperPath);
  assert.equal(resignedBytes.equals(compiled), false);
  assert.equal(canonicalNativeDigestFromBytes(resignedBytes), compiledDigest);
  assert.notEqual(codesignStrictRequirement(helperPath).status, 0);

  const largeSigPath = path.join(directory, 'crate-helper-large-sig');
  fs.writeFileSync(largeSigPath, compiled, { mode: 0o755 });
  const largeResigned = spawnSync('/usr/bin/codesign', [
    '--force',
    '--sign',
    '-',
    '--options',
    'runtime',
    '--signature-size',
    '24000',
    '--entitlements',
    path.join(ROOT, 'entitlements.inherit.plist'),
    largeSigPath,
  ], { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, encoding: 'utf8' });
  assert.equal(largeResigned.status, 0);
  const largeResignedBytes = fs.readFileSync(largeSigPath);
  assert.equal(largeResignedBytes.length > compiled.length + 16384, true);
  assert.equal(canonicalNativeDigestFromBytes(largeResignedBytes), compiledDigest);
  assert.notEqual(codesignStrictRequirement(largeSigPath).status, 0);

  const unsignedPath = path.join(directory, 'unsigned');
  fs.writeFileSync(unsignedPath, compiled, { mode: 0o755 });
  assert.equal(spawnSync('/usr/bin/codesign', ['--remove-signature', unsignedPath]).status, 0);
  assert.notEqual(codesignStrictRequirement(unsignedPath).status, 0);

  // When the compiled helper has alignment padding before LC_CODE_SIGNATURE (8 bytes at this revision),
  // emulate macOS 15 codesign --remove-signature leaving those zero bytes and verify real /usr/bin/strip -S
  // succeeds after trimRemovedSignaturePadding() and fails closed when a pad byte is non-zero.
  const unsignedBytes = fs.readFileSync(unsignedPath);
  let compiledSigOff = null;
  let unsignedLinkeditCmdOff = null;
  {
    let off = 32;
    const count = compiled.readUInt32LE(16);
    for (let index = 0; index < count; index += 1) {
      const cmd = compiled.readUInt32LE(off);
      const size = compiled.readUInt32LE(off + 4);
      if (cmd === 0x1d) compiledSigOff = compiled.readUInt32LE(off + 8);
      off += size;
    }
    off = 32;
    const uCount = unsignedBytes.readUInt32LE(16);
    for (let index = 0; index < uCount; index += 1) {
      const cmd = unsignedBytes.readUInt32LE(off);
      const size = unsignedBytes.readUInt32LE(off + 4);
      if (cmd === 0x19 && unsignedBytes.subarray(off + 8, off + 24).toString('latin1').replace(/\0+$/u, '') === '__LINKEDIT') {
        unsignedLinkeditCmdOff = off;
      }
      off += size;
    }
  }
  if (compiledSigOff !== null && unsignedLinkeditCmdOff !== null && compiledSigOff > unsignedBytes.length) {
    const gap = compiledSigOff - unsignedBytes.length;
    const makeMacos15Padded = fillByte => {
      const padded = Buffer.concat([unsignedBytes, Buffer.alloc(gap, fillByte)]);
      const oldFilesize = padded.readBigUInt64LE(unsignedLinkeditCmdOff + 48);
      padded.writeBigUInt64LE(oldFilesize + BigInt(gap), unsignedLinkeditCmdOff + 48);
      return padded;
    };
    const paddedZeros = makeMacos15Padded(0x00);
    const paddedNonZero = makeMacos15Padded(0x01);
    const runRealStrip = (command, args) => {
      const result = spawnSync(command, args, {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      });
      return { ok: !result.error && result.status === 0, stdout: result.stdout || '', stderr: result.stderr || '' };
    };
    const emulatedRunner = paddedBuffer => (command, args) => {
      if (command === '/usr/bin/codesign') {
        fs.writeFileSync(args[args.length - 1], paddedBuffer, { mode: 0o600 });
        return { ok: true, stdout: '', stderr: '' };
      }
      return runRealStrip(command, args);
    };
    assert.equal(canonicalNativeDigestFromBytes(compiled, emulatedRunner(paddedZeros)), compiledDigest);
    assert.equal(canonicalNativeDigestFromBytes(compiled, emulatedRunner(paddedNonZero)), null);
  }

  const text = machOTextSectionRange(compiled);
  assert.ok(text && text.size > 0);
  const flipped = Buffer.from(compiled);
  const flipOffset = text.offset + Math.floor(text.size / 2);
  flipped[flipOffset] ^= 0x01;
  const flippedDigest = canonicalNativeDigestFromBytes(flipped);
  assert.match(String(flippedDigest), /^[a-f0-9]{64}$/u);
  assert.notEqual(flippedDigest, compiledDigest);
});

async function probeBundledNativeHelper(t, resourcesPath) {
  const {
    NativeHelperClient,
    resolveNativeHelperBinaryPath,
  } = require('../parsers/native-helper');
  const originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  const originalDisable = process.env.CRATE_DISABLE_NATIVE_HELPER;
  t.after(() => {
    if (originalResourcesPath) Object.defineProperty(process, 'resourcesPath', originalResourcesPath);
    else delete process.resourcesPath;
    if (originalDisable === undefined) delete process.env.CRATE_DISABLE_NATIVE_HELPER;
    else process.env.CRATE_DISABLE_NATIVE_HELPER = originalDisable;
  });
  delete process.env.CRATE_DISABLE_NATIVE_HELPER;
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    enumerable: true,
    value: resourcesPath,
    writable: true,
  });
  const expectedPath = path.join(resourcesPath, 'native', 'crate-helper');
  assert.equal(resolveNativeHelperBinaryPath(), expectedPath);

  const client = new NativeHelperClient();
  t.after(() => client.shutdown());
  assert.equal(client.binaryPath, expectedPath);
  const pong = await client.ping();
  assert.equal(pong.version, 1);
  assert.equal(pong.arch, 'arm64');
  assert.equal(pong.pid, client.child.pid);

  const directory = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'crate-native-probe-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const syntheticPath = path.join(directory, 'synthetic-input.bin');
  const syntheticBytes = crypto.randomBytes(256 * 1024 + 17);
  fs.writeFileSync(syntheticPath, syntheticBytes);
  const digest = await client.sha256File(syntheticPath);
  assert.equal(digest.sha256, crypto.createHash('sha256').update(syntheticBytes).digest('hex'));
  assert.equal(digest.size, syntheticBytes.length);

  process.env.CRATE_DISABLE_NATIVE_HELPER = '1';
  const disabled = new NativeHelperClient();
  await assert.rejects(async () => disabled.ping(), /native_helper_unavailable/u);
  assert.equal(disabled.child, null);
}

test('packaged helper location resolves and answers the runtime probe', {
  skip: REAL_SWIFT_TOOLCHAIN_SKIP,
}, async t => {
  const fixtureRoot = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'crate-native-runtime-')));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const resourcesPath = path.join(fixtureRoot, 'Fixture.app', 'Contents', 'Resources');
  writeNativeHelperResource(resourcesPath, compileRepositoryNativeHelper());
  await probeBundledNativeHelper(t, resourcesPath);
});

const SIGNED_APP_UNDER_TEST = process.env.CRATE_SIGNED_APP_UNDER_TEST;
const SIGNED_APP_SKIP = typeof SIGNED_APP_UNDER_TEST === 'string' && path.isAbsolute(SIGNED_APP_UNDER_TEST) &&
  SIGNED_APP_UNDER_TEST.endsWith('.app') && process.platform === 'darwin'
  ? false
  : 'set CRATE_SIGNED_APP_UNDER_TEST to an absolute signed Crate.app path';

test('signed candidate bundles the source-bound Developer ID native helper', {
  skip: SIGNED_APP_SKIP,
}, async t => {
  const appPath = SIGNED_APP_UNDER_TEST;
  const contents = verifyPackagedAppContents(appPath);
  assert.ok(contents.asarEntryCount > 0);
  const revision = spawnSync('/usr/bin/git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  });
  assert.equal(revision.status, 0);
  const evidence = collectNativeHelperEvidence(
    appPath,
    fs.realpathSync(ROOT),
    revision.stdout.trim(),
    undefined,
    { expectedTeamId: PUBLIC_TEAM_ID }
  );
  assert.equal(evidence.resourceValid, true);
  assert.equal(evidence.strictRequirementValid, true);
  assert.equal(evidence.signature.valid, true);
  assert.equal(evidence.signature.identifier, NATIVE_HELPER_IDENTIFIER);
  assert.equal(evidence.signature.teamIdentifier, PUBLIC_TEAM_ID);
  assert.equal(evidence.signature.hardenedRuntime, true);
  assert.equal(evidence.signature.timestamped, true);
  assert.equal(evidence.sourceBound, true);
  assert.deepEqual(
    evaluateReleaseEvidence({ ...safeEvidence(), nativeHelper: evidence }, releaseOptions()).failures,
    []
  );
  assert.equal(
    codesignStrictRequirement(path.join(appPath, 'Contents', 'Resources', 'native', 'crate-helper')).status,
    0
  );
  await probeBundledNativeHelper(t, path.join(appPath, 'Contents', 'Resources'));
});
