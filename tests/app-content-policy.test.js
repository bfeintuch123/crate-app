'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const packageJson = require('../package.json');
const packageLock = require('../package-lock.json');
const afterPack = require('../scripts/patch-helper-info-plists');
const {
  REQUIRED_ASAR_ENTRIES,
  RUNTIME_PARSER_FILES,
  inspectAsarEntries,
  inspectUnpackedEntries,
  normalizeEntry,
  verifyPackagedAppContents
} = require('../scripts/verify-app-contents');

const EXPECTED_BUILD_FILES = Object.freeze([
  'main.js',
  'startup-phase-journal.js',
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
  assert.equal((mainSource.match(/\bcrypto\.randomUUID\(\)/gu) || []).length, 3);
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
  assert.equal(packageJson.build.extraResources, undefined);
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
  assert.equal(REQUIRED_ASAR_ENTRIES.includes('/diagnostic-summary.js'), true);
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
