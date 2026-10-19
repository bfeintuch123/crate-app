'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const ciChrome = require('../scripts/ci-chrome');

function temporary(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crate-ci-chrome-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function environment(t, values) {
  for (const [name, value] of Object.entries(values)) {
    const previous = process.env[name];
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

test('CI browser file hashes reject symlinks, non-files, and oversized input', t => {
  const root = temporary(t), file = path.join(root, 'file');
  fs.writeFileSync(file, 'approved bytes');
  assert.match(ciChrome.fileHash(file), /^[a-f0-9]{64}$/);
  assert.throws(() => ciChrome.fileHash(file, 1), /CI_CHROME_INVALID_FILE/);
  fs.symlinkSync('file', path.join(root, 'link'));
  assert.throws(() => ciChrome.fileHash(path.join(root, 'link')));
  assert.throws(() => ciChrome.fileHash(root));
});

test('CI browser tree binds content, permissions, inventory and internal framework links', t => {
  const root = temporary(t), file = path.join(root, 'engine');
  fs.writeFileSync(file, 'engine', { mode: 0o644 });
  fs.symlinkSync('engine', path.join(root, 'Current'));
  const original = ciChrome.treeHash(root);
  fs.writeFileSync(file, 'changed');
  assert.notEqual(ciChrome.treeHash(root), original);
  fs.writeFileSync(file, 'engine');
  fs.chmodSync(file, 0o755);
  assert.notEqual(ciChrome.treeHash(root), original);
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(path.join(root, 'extra'), 'extra');
  assert.notEqual(ciChrome.treeHash(root), original);
  fs.unlinkSync(path.join(root, 'extra'));
  assert.equal(ciChrome.treeHash(root), original);
  fs.unlinkSync(path.join(root, 'Current'));
  fs.symlinkSync('../outside', path.join(root, 'Current'));
  assert.throws(() => ciChrome.treeHash(root), /CI_CHROME_EXTERNAL_LINK/);
});

test('CI browser pin has no system-browser fallback when configuration or identity fails', t => {
  const root = temporary(t);
  environment(t, { RUNNER_TEMP: root, CRATE_UI_TEST_BROWSER_PIN: undefined });
  assert.equal(ciChrome.pinnedBrowser(), null);
  process.env.CRATE_UI_TEST_BROWSER_PIN = 'yes';
  assert.throws(() => ciChrome.pinnedBrowser(), /CI_CHROME_INVALID_PIN_MODE/);
  process.env.CRATE_UI_TEST_BROWSER_PIN = '1';
  environment(t, { CRATE_UI_TEST_BROWSER: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  assert.throws(() => ciChrome.pinnedBrowser(), /CI_CHROME_PIN_PATH_MISMATCH/);
  process.env.CRATE_UI_TEST_BROWSER = path.join(ciChrome.installRoot(), ciChrome.RELATIVE_EXECUTABLE);
  assert.throws(() => ciChrome.pinnedBrowser(), /CI_CHROME_IDENTITY_MISMATCH/);
});

test('CI browser install is exclusive and restricted to canonical runner temporary storage', t => {
  const root = temporary(t);
  environment(t, { RUNNER_TEMP: root });
  const install = ciChrome.installRoot();
  assert.throws(() => ciChrome.install(path.join(root, 'other')), /CI_CHROME_INVALID_ROOT/);
  assert.equal(fs.existsSync(path.join(root, 'other')), false);
  fs.mkdirSync(install);
  fs.writeFileSync(path.join(install, 'existing'), 'preserve');
  assert.throws(() => ciChrome.install(install), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(path.join(install, 'existing'), 'utf8'), 'preserve');
  const alias = path.join(root, 'alias');
  fs.symlinkSync(root, alias);
  assert.throws(() => ciChrome.installRoot(alias), /CI_CHROME_INVALID_TEMP/);
  assert.throws(() => ciChrome.installRoot('relative'), /CI_CHROME_INVALID_TEMP/);
});

test('CI browser corrupt archives are rejected before extraction or browser launch', t => {
  const root = temporary(t), archive = path.join(root, 'corrupt.zip');
  environment(t, { RUNNER_TEMP: root });
  fs.writeFileSync(archive, 'untrusted bytes');
  const spawn = t.mock.method(childProcess, 'spawnSync', () => { throw new Error('must not execute'); });
  assert.throws(() => ciChrome.install(ciChrome.installRoot(), archive), /CI_CHROME_ARCHIVE_MISMATCH/);
  assert.equal(spawn.mock.callCount(), 0);
  assert.equal(fs.existsSync(path.join(ciChrome.installRoot(), 'payload')), false);
});

test('CI browser verification rejects missing or unexpected installed inventory', t => {
  const root = temporary(t);
  environment(t, { RUNNER_TEMP: root });
  assert.throws(() => ciChrome.verifyInstalled(path.join(root, 'other')), /CI_CHROME_INVALID_ROOT/);
  fs.mkdirSync(ciChrome.installRoot());
  fs.writeFileSync(path.join(ciChrome.installRoot(), 'unexpected'), 'extra');
  assert.throws(() => ciChrome.verifyInstalled(ciChrome.installRoot()), /CI_CHROME_INVALID_ROOT/);
  assert.throws(() => ciChrome.verifyIdentity(path.join(root, 'absent')), /CI_CHROME_IDENTITY_MISMATCH/);
});

test('CI browser CLI rejects extra arguments without provisioning anything', () => {
  for (const args of [['verify', '/unused', 'extra'], ['install', '/unused', '--archive'],
    ['install', '/unused', '--archive', '/unused.zip', 'extra'], ['unknown', '/unused']]) {
    const result = childProcess.spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'ci-chrome.js'), ...args],
      { encoding: 'utf8', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, timeout: 5000 });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), 'CI_CHROME_INVALID_ARGUMENTS');
    assert.equal(result.stdout, '');
  }
});
