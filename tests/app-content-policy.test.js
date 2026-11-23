'use strict';

const assert = require('./bounded-assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const packageJson = require('../package.json');
const packageLock = require('../package-lock.json');
const afterPack = require('../scripts/patch-helper-info-plists');
const {
  NATIVE_HELPER_FILE_MODE,
  REQUIRED_ASAR_ENTRIES,
  RUNTIME_PARSER_FILES,
  hasThinArm64ExecuteHeader,
  inspectAsarEntries,
  inspectNativeHelperResource,
  inspectUnpackedEntries,
  normalizeEntry,
  verifyPackagedAppContents
} = require('../scripts/verify-app-contents');

// Synthetic Mach-O header bytes only; nothing here is executed.
function syntheticMachO({
  magic = 0xfeedfacf,
  cpuType = 0x0100000c,
  cpuSubtype = 0,
  fileType = 2,
  length = 64
} = {}) {
  const header = Buffer.alloc(16);
  header.writeUInt32LE(magic >>> 0, 0);
  header.writeUInt32LE(cpuType >>> 0, 4);
  header.writeUInt32LE(cpuSubtype >>> 0, 8);
  header.writeUInt32LE(fileType >>> 0, 12);
  const bytes = Buffer.alloc(length, 0x5a);
  header.copy(bytes, 0, 0, Math.min(16, length));
  return bytes;
}

function writeNativeHelper(resourcesPath, bytes = syntheticMachO(), mode = 0o755) {
  const nativePath = path.join(resourcesPath, 'native');
  fs.mkdirSync(nativePath, { recursive: true });
  const helperPath = path.join(nativePath, 'crate-helper');
  fs.writeFileSync(helperPath, bytes);
  fs.chmodSync(helperPath, mode);
  return helperPath;
}

const EXPECTED_BUILD_FILES = Object.freeze([
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
  'renderer/**/*',
  'parsers/*.js',
  'assets/tray-icon.png'
]);

test('runtime UUID policy uses Node crypto without an external uuid dependency', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

  assert.equal(Object.hasOwn(packageJson.dependencies, 'uuid'), false);
  assert.equal(Object.hasOwn(packageLock.packages[''].dependencies, 'uuid'), false);
  assert.equal(Object.hasOwn(packageLock.packages, 'node_modules/uuid'), false);
  assert.equal(mainSource.includes("require('uuid')"), false);
  assert.equal((mainSource.match(/\bcrypto\.randomUUID\(\)/gu) || []).length, 19); // Explicit receipt recovery attempt plus admission, explicit-choice nonce, ledger recovery, verification retry IDs and InDesign observation epoch.
});

function listJavaScriptFiles(rootDirectory, currentDirectory = rootDirectory) {
  return fs.readdirSync(currentDirectory, { withFileTypes: true }).flatMap(entry => {
    const absolutePath = path.join(currentDirectory, entry.name);
    if (entry.isDirectory() && entry.name === 'node_modules') return [];
    if (entry.isDirectory()) return listJavaScriptFiles(rootDirectory, absolutePath);
    if (!entry.isFile() || !entry.name.endsWith('.js')) return [];
    return [path.relative(rootDirectory, absolutePath).split(path.sep).join('/')];
  });
}

function writePermissiveInfoPlist(infoPlistPath) {
  fs.mkdirSync(path.dirname(infoPlistPath), { recursive: true });
  fs.writeFileSync(infoPlistPath, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>NSAppTransportSecurity</key>',
    '  <dict>',
    '    <key>NSAllowsArbitraryLoads</key>',
    '    <true/>',
    '    <key>NSAllowsLocalNetworking</key>',
    '    <true/>',
    '  </dict>',
    '</dict>',
    '</plist>',
    ''
  ].join('\n'));
}

test('packaged-content policy declares every first-party parser module', () => {
  const parserFiles = listJavaScriptFiles(path.join(__dirname, '..', 'parsers')).sort();

  assert.deepEqual([...RUNTIME_PARSER_FILES].sort(), parserFiles);
});

test('parser inventory ignores generated dependency trees', t => {
  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-parser-inventory-'));
  t.after(() => fs.rmSync(rootDirectory, { recursive: true, force: true }));

  fs.mkdirSync(path.join(rootDirectory, 'nested'), { recursive: true });
  fs.mkdirSync(path.join(rootDirectory, 'node_modules', 'example'), { recursive: true });
  fs.writeFileSync(path.join(rootDirectory, 'nested', 'first-party.js'), 'module.exports = true;');
  fs.writeFileSync(path.join(rootDirectory, 'node_modules', 'example', 'index.js'), 'module.exports = true;');

  assert.deepEqual(listJavaScriptFiles(rootDirectory), ['nested/first-party.js']);
});

test('electron-builder uses the explicit Crate runtime allowlist', () => {
  assert.deepEqual(packageJson.build.files, EXPECTED_BUILD_FILES);
  assert.equal(packageJson.build.files.some(pattern => pattern === '**/*'), false);
  assert.equal(packageJson.build.extraFiles, undefined);
  assert.deepEqual(packageJson.build.extraResources, [
    { from: 'native/bin/crate-helper', to: 'native/crate-helper' }
  ]);
  assert.equal(packageJson.build.mac.extraFiles, undefined);
  assert.equal(packageJson.build.mac.extraResources, undefined);
});

test('electron-builder locks production execution to the signed ASAR', () => {
  assert.deepEqual(packageJson.build.electronFuses, {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: true
  });
});

test('mac build metadata separates main-process Automation from helper entitlements', () => {
  const mainEntitlements = fs.readFileSync(path.join(__dirname, '..', 'entitlements.plist'), 'utf8');
  const inheritedEntitlements = fs.readFileSync(
    path.join(__dirname, '..', 'entitlements.inherit.plist'),
    'utf8'
  );

  assert.equal(packageJson.build.mac.entitlements, 'entitlements.plist');
  assert.equal(packageJson.build.mac.entitlementsInherit, 'entitlements.inherit.plist');
  assert.match(mainEntitlements, /com\.apple\.security\.automation\.apple-events/);
  assert.equal(
    inheritedEntitlements.includes('com.apple.security.automation.apple-events'),
    false
  );
  for (const entitlement of [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.allow-unsigned-executable-memory',
    'com.apple.security.cs.disable-library-validation'
  ]) {
    assert.match(mainEntitlements, new RegExp(entitlement.replaceAll('.', '\\.'), 'u'));
    assert.match(inheritedEntitlements, new RegExp(entitlement.replaceAll('.', '\\.'), 'u'));
  }
});

test('mac build metadata requests strict transport and omits unused permissions', () => {
  assert.equal(
    packageJson.build.mac.extendInfo.NSAppTransportSecurity.NSAllowsArbitraryLoads,
    false
  );
  for (const usageDescription of [
    'NSAudioCaptureUsageDescription',
    'NSBluetoothAlwaysUsageDescription',
    'NSBluetoothPeripheralUsageDescription',
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription'
  ]) {
    assert.equal(packageJson.build.mac.extendInfo[usageDescription], null);
  }
});

test('packaged-content policy accepts the required runtime and dependencies', () => {
  assert.equal(REQUIRED_ASAR_ENTRIES.includes('/startup-phase-journal.js'), true);
  assert.equal(REQUIRED_ASAR_ENTRIES.includes('/account-config.json'), true);
  assert.equal(REQUIRED_ASAR_ENTRIES.includes('/diagnostic-summary.js'), true);
  assert.equal(REQUIRED_ASAR_ENTRIES.includes('/parsers/working-source-recovery-core.js'), true);
  assert.equal(REQUIRED_ASAR_ENTRIES.includes('/parsers/figma-credential-store.js'), true);
  assert.equal(REQUIRED_ASAR_ENTRIES.includes('/parsers/figma-redaction.js'), true);
  const result = inspectAsarEntries([
    '/assets',
    '/renderer',
    '/parsers',
    '/node_modules',
    '/node_modules/electron-store/index.js',
    ...REQUIRED_ASAR_ENTRIES
  ]);

  assert.deepEqual(result.invalidEntries, []);
  assert.deepEqual(result.disallowedEntries, []);
  assert.deepEqual(result.missingEntries, []);
});

test('packaged-content policy rejects internal and sensitive workspace files', () => {
  const result = inspectAsarEntries([
    ...REQUIRED_ASAR_ENTRIES,
    '/.env',
    '/.codex/playbooks/crate-security-scan.md',
    '/docs/crate/security-notes.md',
    '/tests/app-content-policy.test.js',
    '/crate-web/.env.local',
    '/mission-control/index.js',
    '/scripts/notarize.js',
    '/node_modules/example/.env.production',
    '/node_modules/example/private-key.pem'
  ]);

  assert.deepEqual(result.missingEntries, []);
  assert.deepEqual(result.disallowedEntries, [
    '/.env',
    '/.codex/playbooks/crate-security-scan.md',
    '/docs/crate/security-notes.md',
    '/tests/app-content-policy.test.js',
    '/crate-web/.env.local',
    '/mission-control/index.js',
    '/scripts/notarize.js',
    '/node_modules/example/.env.production',
    '/node_modules/example/private-key.pem'
  ]);
});

test('packaged-content policy fails when a runtime file is absent', () => {
  const result = inspectAsarEntries(REQUIRED_ASAR_ENTRIES.filter(entry => entry !== '/preload.js'));
  assert.deepEqual(result.missingEntries, ['/preload.js']);
});

test('packaged-content policy rejects traversal-shaped entries', () => {
  assert.equal(normalizeEntry('/renderer/../.env'), null);
  const result = inspectAsarEntries([...REQUIRED_ASAR_ENTRIES, '/renderer/../.env']);
  assert.deepEqual(result.invalidEntries, ['/renderer/../.env']);
});

test('unpacked-content policy permits production dependencies only', () => {
  const accepted = inspectUnpackedEntries([
    '/node_modules',
    '/node_modules/canvas/build/Release/canvas.node'
  ]);
  assert.deepEqual(accepted.invalidEntries, []);
  assert.deepEqual(accepted.disallowedEntries, []);

  const rejected = inspectUnpackedEntries([
    '/node_modules/canvas/build/Release/canvas.node',
    '/node_modules/example/.npmrc',
    '/node_modules/example/id_ed25519',
    '/.env',
    '/docs/security.md'
  ]);
  assert.deepEqual(rejected.disallowedEntries, [
    '/node_modules/example/.npmrc',
    '/node_modules/example/id_ed25519',
    '/.env',
    '/docs/security.md'
  ]);
});

test('packaged app verification accepts an injected safe ASAR inventory', () => {
  const appBundle = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-content-policy-app-'));
  const asarPath = path.join(appBundle, 'Contents', 'Resources', 'app.asar');
  fs.mkdirSync(path.dirname(asarPath), { recursive: true });
  fs.writeFileSync(asarPath, 'synthetic test placeholder');
  writeNativeHelper(path.dirname(asarPath));

  try {
    const result = verifyPackagedAppContents(appBundle, {
      asar: { listPackage: () => REQUIRED_ASAR_ENTRIES },
      unpackedEntries: []
    });
    assert.equal(result.asarEntryCount, REQUIRED_ASAR_ENTRIES.length);
    assert.equal(result.unpackedEntryCount, 0);
  } finally {
    fs.rmSync(appBundle, { recursive: true, force: true });
  }
});

test('existing afterPack hook invokes packaged-content verification', async () => {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-after-pack-policy-'));
  const appBundle = path.join(appOutDir, 'Crate.app');
  writePermissiveInfoPlist(path.join(appBundle, 'Contents', 'Info.plist'));
  let verifiedPath = null;

  try {
    await afterPack({
      electronPlatformName: 'darwin',
      appOutDir,
      packager: { appInfo: { productFilename: 'Crate' } },
      verifyPackagedContents: candidatePath => {
        verifiedPath = candidatePath;
      }
    });
    assert.equal(verifiedPath, appBundle);
    const transportPolicy = JSON.parse(execFileSync('/usr/bin/plutil', [
      '-extract',
      'NSAppTransportSecurity',
      'json',
      '-o',
      '-',
      path.join(appBundle, 'Contents', 'Info.plist'),
    ], { encoding: 'utf8' }));
    assert.deepEqual(transportPolicy, afterPack.STRICT_APP_TRANSPORT_SECURITY);
  } finally {
    fs.rmSync(appOutDir, { recursive: true, force: true });
  }
});

test('afterPack hardens the final app transport policy before signing', () => {
  const appBundle = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-after-pack-ats-'));
  const infoPlistPath = path.join(appBundle, 'Contents', 'Info.plist');
  writePermissiveInfoPlist(infoPlistPath);

  try {
    assert.equal(afterPack.hardenMainInfoPlist(appBundle), infoPlistPath);
    const transportPolicy = JSON.parse(execFileSync('/usr/bin/plutil', [
      '-extract',
      'NSAppTransportSecurity',
      'json',
      '-o',
      '-',
      infoPlistPath,
    ], { encoding: 'utf8' }));
    assert.deepEqual(transportPolicy, afterPack.STRICT_APP_TRANSPORT_SECURITY);
  } finally {
    fs.rmSync(appBundle, { recursive: true, force: true });
  }
});

test('native helper resource accepts only one regular mode-0755 thin arm64 executable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-native-resource-'));
  let caseIndex = 0;
  const freshResources = () => {
    const resourcesPath = path.join(root, `case-${caseIndex += 1}`, 'Resources');
    fs.mkdirSync(resourcesPath, { recursive: true });
    return resourcesPath;
  };
  const rejects = (label, setup) => {
    const resourcesPath = freshResources();
    setup(resourcesPath);
    assert.deepEqual(inspectNativeHelperResource(resourcesPath), { valid: false, bytes: null }, label);
  };

  try {
    assert.equal(NATIVE_HELPER_FILE_MODE, 0o755);
    const validResources = freshResources();
    const validBytes = syntheticMachO();
    writeNativeHelper(validResources, validBytes);
    const accepted = inspectNativeHelperResource(validResources);
    assert.equal(accepted.valid, true);
    assert.equal(Buffer.compare(accepted.bytes, validBytes), 0);
    assert.equal(hasThinArm64ExecuteHeader(syntheticMachO({ length: 32 })), true);

    rejects('missing native directory', () => {});
    rejects('empty native directory', resourcesPath => {
      fs.mkdirSync(path.join(resourcesPath, 'native'));
    });
    rejects('native is a file', resourcesPath => {
      fs.writeFileSync(path.join(resourcesPath, 'native'), syntheticMachO());
    });
    for (const sibling of ['extra-file', '.DS_Store']) {
      rejects(`extra sibling ${sibling}`, resourcesPath => {
        writeNativeHelper(resourcesPath);
        fs.writeFileSync(path.join(resourcesPath, 'native', sibling), 'synthetic');
      });
    }
    rejects('extra sibling directory', resourcesPath => {
      writeNativeHelper(resourcesPath);
      fs.mkdirSync(path.join(resourcesPath, 'native', 'extra-directory'));
    });
    rejects('symlinked native directory', resourcesPath => {
      const realNative = path.join(path.dirname(resourcesPath), 'real-native');
      fs.mkdirSync(realNative);
      fs.writeFileSync(path.join(realNative, 'crate-helper'), syntheticMachO());
      fs.chmodSync(path.join(realNative, 'crate-helper'), 0o755);
      fs.symlinkSync(realNative, path.join(resourcesPath, 'native'));
    });
    rejects('symlinked helper', resourcesPath => {
      const target = path.join(path.dirname(resourcesPath), 'real-helper');
      fs.writeFileSync(target, syntheticMachO());
      fs.chmodSync(target, 0o755);
      fs.mkdirSync(path.join(resourcesPath, 'native'));
      fs.symlinkSync(target, path.join(resourcesPath, 'native', 'crate-helper'));
    });
    rejects('helper directory', resourcesPath => {
      fs.mkdirSync(path.join(resourcesPath, 'native', 'crate-helper'), { recursive: true });
    });
    rejects('helper FIFO', resourcesPath => {
      fs.mkdirSync(path.join(resourcesPath, 'native'));
      const created = require('node:child_process').spawnSync('/usr/bin/mkfifo', [
        path.join(resourcesPath, 'native', 'crate-helper')
      ]);
      assert.equal(created.status, 0);
    });
    for (const mode of [0o644, 0o700, 0o775, 0o4755]) {
      rejects(`mode ${mode.toString(8)}`, resourcesPath => {
        const helperPath = writeNativeHelper(resourcesPath, syntheticMachO(), mode);
        assert.equal(fs.lstatSync(helperPath).mode & 0o7777, mode);
      });
    }
    const fatHeader = syntheticMachO();
    fatHeader.writeUInt32BE(0xcafebabe, 0);
    for (const [label, bytes] of [
      ['x86_64', syntheticMachO({ cpuType: 0x01000007 })],
      ['fat', fatHeader],
      ['arm64e', syntheticMachO({ cpuSubtype: 2 })],
      ['arm64e with pointer-auth capability bits', syntheticMachO({ cpuSubtype: 0x80000002 })],
      ['32-bit arm', syntheticMachO({ magic: 0xfeedface, cpuType: 12 })],
      ['MH_DYLIB', syntheticMachO({ fileType: 6 })],
      ['MH_BUNDLE', syntheticMachO({ fileType: 8 })],
      ['shell script', Buffer.from('#!/bin/sh\necho synthetic\n'.padEnd(64, ' '))],
      ['empty file', Buffer.alloc(0)],
      ['31-byte file', syntheticMachO({ length: 31 })]
    ]) {
      rejects(label, resourcesPath => writeNativeHelper(resourcesPath, bytes));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('packaged app verification rejects a missing or invalid bundled helper but keeps bare ASAR input', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-content-policy-helper-'));
  const options = {
    asar: { listPackage: () => REQUIRED_ASAR_ENTRIES },
    unpackedEntries: []
  };
  const expectRejected = appBundle => {
    assert.throws(() => verifyPackagedAppContents(appBundle, options), error => (
      error.message === 'Bundled native helper is missing or not approved.' && error.exitCode === 1
    ));
  };
  try {
    const appBundle = path.join(root, 'Crate.app');
    const resourcesPath = path.join(appBundle, 'Contents', 'Resources');
    fs.mkdirSync(resourcesPath, { recursive: true });
    fs.writeFileSync(path.join(resourcesPath, 'app.asar'), 'synthetic test placeholder');
    expectRejected(appBundle);

    fs.mkdirSync(path.join(resourcesPath, 'native'));
    expectRejected(appBundle);

    const helperPath = writeNativeHelper(resourcesPath, syntheticMachO(), 0o644);
    expectRejected(appBundle);
    fs.chmodSync(helperPath, 0o755);
    fs.writeFileSync(helperPath, syntheticMachO({ cpuType: 0x01000007 }));
    expectRejected(appBundle);

    fs.writeFileSync(helperPath, syntheticMachO());
    assert.equal(verifyPackagedAppContents(appBundle, options).asarEntryCount, REQUIRED_ASAR_ENTRIES.length);

    const bareAsar = path.join(root, 'bare', 'app.asar');
    fs.mkdirSync(path.dirname(bareAsar));
    fs.writeFileSync(bareAsar, 'synthetic test placeholder');
    assert.equal(verifyPackagedAppContents(bareAsar, options).asarEntryCount, REQUIRED_ASAR_ENTRIES.length);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
