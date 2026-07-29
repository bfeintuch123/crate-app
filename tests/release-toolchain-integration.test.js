'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  authenticateVerifierToolchain,
} = require('../scripts/verify-macos-release-app');

const ROOT = path.join(__dirname, '..');
const RUN_LIVE_TOOLCHAIN = process.env.CRATE_VERIFY_LIVE_TOOLCHAIN === '1';

test('fresh install authenticates and loads the committed release verifier toolchain', {
  skip: RUN_LIVE_TOOLCHAIN ? false : 'CI-only fresh-install verifier integration',
}, () => {
  assert.equal(typeof process.env.npm_config_cache, 'string');
  assert.notEqual(process.env.npm_config_cache, '');

  const authenticated = authenticateVerifierToolchain(ROOT, {
    npmCacheRoot: process.env.npm_config_cache,
  });

  assert.equal(authenticated.valid, true);
  assert.equal(authenticated.packageCount, 21);
  assert.equal(typeof authenticated.tools.asar.extractFile, 'function');
  assert.equal(typeof authenticated.tools.asar.getRawHeader, 'function');
  assert.equal(typeof authenticated.tools.getFuseWire, 'function');
  assert.equal(authenticated.recheck(), true);
});
