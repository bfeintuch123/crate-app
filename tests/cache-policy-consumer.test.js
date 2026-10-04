'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

test('reviewed private fork retains the installed consumer security contract', { timeout: 30000 }, t => {
  const archive = path.join(root, 'vendor/crate-http-cache-semantics-backport-0.1.0.tgz');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
    '2254db1cde2bda50f960d563f7c108558d5ad7933057f882c40eeacb0920d266');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'vendor/crate-http-cache-semantics-backport-0.1.0/package.json')));
  assert.equal(manifest.name, 'crate-http-cache-semantics-backport');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.private, true);
  assert.equal(manifest.crateBackport.upstreamName, 'http-cache-semantics');
  assert.equal(manifest.crateBackport.upstreamVersion, '4.2.0');
  const stage = path.join(__dirname, 'fixtures/cache-policy-backport');
  const tests = ['cacheable-integration.test.cjs', 'privacy-consumer.test.cjs', 'cookie-consumer.test.cjs'];
  // The deliberate vulnerable-baseline injection experiment is source evidence,
  // not an installed-candidate check. All candidate assertions run unchanged.
  const result = spawnSync(process.execPath,
    ['--test', '--test-concurrency=1', '--test-skip-pattern=^BASELINE', ...tests.map(name => path.join(stage, name))],
    { cwd: root, timeout: 25000, encoding: 'utf8', env: {
      PATH: path.dirname(process.execPath), HOME: root, TMPDIR: require('node:os').tmpdir(),
      NODE_OPTIONS: '', NODE_PATH: '', POLICY_VARIANT: 'candidate',
    } });
  t.diagnostic(result.stdout || '');
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
