'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const packageJson = require('../package.json');
const afterPack = require('../scripts/patch-helper-info-plists');
const {
  REQUIRED_ASAR_ENTRIES,
  inspectAsarEntries,
  inspectUnpackedEntries,
  normalizeEntry,
  verifyPackagedAppContents
} = require('../scripts/verify-app-contents');

const EXPECTED_BUILD_FILES = Object.freeze([
  'main.js',
  'preload.js',
  'provenance.js',
  'renderer/**/*',
  'parsers/*.js',
  'assets/tray-icon.png'
]);

test('electron-builder uses the explicit Crate runtime allowlist', () => {
  assert.deepEqual(packageJson.build.files, EXPECTED_BUILD_FILES);
  assert.equal(packageJson.build.files.some(pattern => pattern === '**/*'), false);
  assert.equal(packageJson.build.extraFiles, undefined);
  assert.equal(packageJson.build.extraResources, undefined);
  assert.equal(packageJson.build.mac.extraFiles, undefined);
  assert.equal(packageJson.build.mac.extraResources, undefined);
});

test('packaged-content policy accepts the required runtime and dependencies', () => {
  assert.equal(REQUIRED_ASAR_ENTRIES.includes('/parsers/figma-credential-store.js'), true);
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
  fs.mkdirSync(appBundle, { recursive: true });
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
  } finally {
    fs.rmSync(appOutDir, { recursive: true, force: true });
  }
});
