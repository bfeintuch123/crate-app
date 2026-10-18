'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fingerprintTree, installedPackageRoots, validateVersionEdges, collectExpectedLockPaths } = require('../.codex/tools/cloudflare-pages/verify-toolchain.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-pages-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fs.realpathSync(root);
}
function packageAt(root, relative) {
  const directory = path.join(root, relative);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), '{}');
}
test('Pages tree seal detects byte drift and refuses symbolic links', t => {
  const root = fixture(t), file = path.join(root, 'module.js');
  fs.writeFileSync(file, 'first'); const first = fingerprintTree(root);
  fs.writeFileSync(file, 'other'); assert.notEqual(fingerprintTree(root), first);
  fs.symlinkSync(file, path.join(root, 'alias.js'));
  assert.throws(() => fingerprintTree(root), /authentication failed/);
});
test('Pages package inventory includes scoped and nested package roots', t => {
  const root = fixture(t);
  for (const name of ['node_modules/wrangler', 'node_modules/@cloudflare/preset', 'node_modules/wrangler/node_modules/child']) packageAt(root, name);
  fs.writeFileSync(path.join(root, 'node_modules/.package-lock.json'), '{}');
  assert.deepEqual([...installedPackageRoots(root).keys()].sort(), [
    'node_modules/@cloudflare/preset', 'node_modules/wrangler', 'node_modules/wrangler/node_modules/child',
  ]);
  fs.mkdirSync(path.join(root, 'node_modules/extra'));
  assert.throws(() => installedPackageRoots(root));
});
test('Pages version proof checks prerelease and compound constraints rather than skipping them', () => {
  const lock = { packages: {
    '': { dependencies: { preset: '2.0.0-rc.24' } },
    'node_modules/preset': { version: '2.0.0-rc.24', peerDependencies: { workerd: '>1.20260305.0 <2.0.0-0' } },
    'node_modules/workerd': { version: '1.20261012.1' },
  } };
  const roots = new Map([['node_modules/preset', 'preset'], ['node_modules/workerd', 'workerd']]), seen = [];
  validateVersionEdges(lock, roots, (version, range) => { seen.push([version, range]); return true; });
  assert.deepEqual(seen, [['2.0.0-rc.24', '2.0.0-rc.24'], ['1.20261012.1', '>1.20260305.0 <2.0.0-0']]);
  assert.throws(() => validateVersionEdges(lock, roots, () => false), /authentication failed/);
  roots.delete('node_modules/workerd');
  assert.throws(() => validateVersionEdges(lock, roots, () => true), /authentication failed/);
  lock.packages['node_modules/preset'].peerDependenciesMeta = { workerd: { optional: true } };
  assert.doesNotThrow(() => validateVersionEdges(lock, roots, () => true));
});
test('Pages dependency resolution checks a nested installed version before a hoisted version', () => {
  const lock = { packages: {
    '': { dependencies: { parent: '1.0.0' } },
    'node_modules/parent': { version: '1.0.0', dependencies: { child: '2.0.0' } },
    'node_modules/parent/node_modules/child': { version: '3.0.0' },
    'node_modules/child': { version: '2.0.0' },
  } };
  const roots = new Map(Object.keys(lock.packages).filter(Boolean).map(key => [key, key]));
  assert.throws(() => validateVersionEdges(lock, roots, (version, range) => version === range), /authentication failed/);
});
test('Pages lock proof retains declared neutral optional descendants and rejects an unrelated locked package', () => {
  const manifest = { name: 'test-tools', version: '1.0.0', dependencies: { chooser: '1.0.0' } };
  const entry = extra => ({ version: '1.0.0', resolved: 'https://registry.npmjs.org/test/-/test-1.0.0.tgz',
    integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`, ...extra });
  const lock = { lockfileVersion: 3, packages: {
    '': { ...manifest },
    'node_modules/chooser': entry({ optionalDependencies: { foreign: '1.0.0' } }),
    'node_modules/foreign': entry({ os: ['linux'], dependencies: { neutral: '1.0.0' } }),
    'node_modules/neutral': entry({ optional: true }),
  } };
  const proof = collectExpectedLockPaths(manifest, lock, 'darwin', 'arm64');
  assert.deepEqual([...proof.installed].sort(), ['node_modules/chooser', 'node_modules/neutral']);
  assert.equal(proof.all.size, 3);
  lock.packages['node_modules/unrelated'] = entry({ optional: true });
  assert.throws(() => collectExpectedLockPaths(manifest, lock, 'darwin', 'arm64'), /authentication failed/);
});
