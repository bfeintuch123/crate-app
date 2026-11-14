'use strict';

const assert = require('./bounded-assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const test = require('node:test');
const asar = require('@electron/asar');
const { FileMatcher } = require('app-builder-lib/out/fileMatcher');
const packageJson = require('../package.json');
const { REQUIRED_ASAR_ENTRIES, verifyPackagedAppContents } = require('../scripts/verify-app-contents');
const root = path.resolve(__dirname, '..');

test('runtime file selection and content policy both include the exact matcher helper', () => {
  const helper = path.join(root, 'parsers/linked-asset-matcher.js');
  const matcher = new FileMatcher(root, '/synthetic/packaged-root', value => value, packageJson.build.files);
  assert.equal(matcher.createFilter()(helper, fs.statSync(helper)), true);
  assert.ok(REQUIRED_ASAR_ENTRIES.includes('/parsers/linked-asset-matcher.js'));
});

test('real unsigned ASAR retains matcher bytes and extracted main/worker-relative imports resolve', async t => {
  // Archive/content test only: no app build, native binary, signing or launch.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-linked-asar-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const stage = path.join(temp, 'stage'); fs.mkdirSync(stage);
  for (const entry of REQUIRED_ASAR_ENTRIES) {
    const relative = entry.slice(1), target = path.join(stage, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, relative), target);
  }
  const archive = path.join(temp, 'app.asar');
  await asar.createPackage(stage, archive);
  assert.doesNotThrow(() => verifyPackagedAppContents(archive));
  for (const name of ['main.js', 'parsers/add-files-regex-worker.js', 'parsers/linked-asset-matcher.js']) {
    assert.equal(crypto.createHash('sha256').update(asar.extractFile(archive, name)).digest('hex'),
      crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex'));
  }
  const extracted = path.join(temp, 'extracted');
  asar.extractAll(archive, extracted);
  const fromMain = createRequire(path.join(extracted, 'main.js'))('./parsers/linked-asset-matcher');
  const fromWorker = createRequire(path.join(extracted, 'parsers/add-files-regex-worker.js'))('./linked-asset-matcher');
  assert.equal(fromMain, fromWorker);
  const packagedWorker = createRequire(path.join(extracted, 'package.json'))('./parsers/add-files-regex-worker');
  assert.deepEqual(packagedWorker.extractLinkedAssetsFromBuffer(Buffer.from('/Users/a.png'), '/synthetic/source'), ['/Users/a.png']);
  // Removing only our staged copy must make the real verifier reject the archive.
  fs.unlinkSync(path.join(stage, 'parsers/linked-asset-matcher.js'));
  const incomplete = path.join(temp, 'missing-helper.asar');
  await asar.createPackage(stage, incomplete);
  assert.throws(() => verifyPackagedAppContents(incomplete), /Missing runtime ASAR entries[\s\S]*linked-asset-matcher/);
});
