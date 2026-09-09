'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  CALLBACK,
  CALLBACK_SCHEME,
  loadAccountConfig
} = require('../account-config');
const packageMetadata = require('../package.json');

const valid = Object.freeze({
  CRATE_ACCOUNT_PROVIDER_URL: 'https://project.supabase.co',
  CRATE_ACCOUNT_WEB_ORIGIN: 'https://accounts.example.test',
  CRATE_ACCOUNT_CLIENT_ID: 'internal-client',
  CRATE_ACCOUNT_PUBLIC_KEY: 'sb_publishable_synthetic_test_key_123'
});

test('release callback identity survives packaging and configuration preserves the public-only contract', () => {
  assert.equal(CALLBACK_SCHEME, 'com.get-crate.app');
  assert.equal(CALLBACK, `${CALLBACK_SCHEME}:/oauth/callback`);
  assert.deepEqual(loadAccountConfig(valid), {
    provider: 'https://project.supabase.co',
    origin: 'https://accounts.example.test',
    clientId: 'internal-client',
    publicKey: 'sb_publishable_synthetic_test_key_123',
    issuer: 'https://project.supabase.co/auth/v1',
    redirectUri: 'https://accounts.example.test/auth/desktop/callback',
    callback: CALLBACK
  });
});

test('release metadata excludes internal identity and TLS resources', () => {
  assert.equal(packageMetadata.productName, 'Crate');
  assert.equal(packageMetadata.build.appId, 'com.crate.app');
  assert.deepEqual(packageMetadata.build.protocols, [{ name: 'Crate account sign-in', schemes: [CALLBACK_SCHEME] }]);
  assert.equal(packageMetadata.build.files.includes('runtime-identity.json'), true);
  assert.equal(packageMetadata.build.files.some(value => /internal-|account-transport/.test(value)), false);
});

test('Finder-launched configuration comes only from the bundled public JSON when env is absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-account-config-'));
  const configPath = path.join(root, 'account-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    providerUrl: valid.CRATE_ACCOUNT_PROVIDER_URL,
    webOrigin: valid.CRATE_ACCOUNT_WEB_ORIGIN,
    clientId: valid.CRATE_ACCOUNT_CLIENT_ID,
    publicKey: valid.CRATE_ACCOUNT_PUBLIC_KEY
  }));
  try {
    assert.equal(loadAccountConfig({}, configPath).clientId, 'internal-client');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bundled configuration rejects unknown fields that could carry non-public material', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-account-config-'));
  const configPath = path.join(root, 'account-config.json');
  fs.writeFileSync(configPath, JSON.stringify({ ...valid, serviceRoleKey: 'must-not-be-accepted' }));
  try {
    assert.equal(loadAccountConfig({}, configPath), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('insecure, credential-bearing, arbitrary, and partial configuration fails closed', () => {
  for (const override of [
    { CRATE_ACCOUNT_PROVIDER_URL: 'http://project.supabase.co' },
    { CRATE_ACCOUNT_WEB_ORIGIN: 'https://user:pass@accounts.example.test' },
    { CRATE_ACCOUNT_WEB_ORIGIN: 'https://accounts.example.test/path' },
    { CRATE_ACCOUNT_CLIENT_ID: 'short' },
    { CRATE_ACCOUNT_PUBLIC_KEY: 'service_role_secret_value' },
    { CRATE_ACCOUNT_PROVIDER_URL: undefined }
  ]) {
    assert.equal(loadAccountConfig({ ...valid, ...override }), null);
  }
  assert.equal(loadAccountConfig({}, path.join(__dirname, 'missing-account-config.json')), null);
  assert.equal(loadAccountConfig({}, path.join(__dirname, '..', 'account-config.json')), null);
});

test('general release refuses normalized loopback and unspecified endpoints in both origins', () => {
  for (const origin of [
    'https://localhost:3000', 'https://localhost.', 'https://qa.localhost.',
    'https://127.0.0.1', 'https://127.0.0.2', 'https://127.255.255.254',
    'https://2130706433', 'https://0x7f000001', 'https://127.1',
    'https://[::1]', 'https://[0:0:0:0:0:0:0:1]',
    'https://[::ffff:127.0.0.1]', 'https://[::ffff:7fff:fffe]',
    'https://[::127.0.0.2]', 'https://0.0.0.0', 'https://[::]',
  ]) {
    for (const field of ['CRATE_ACCOUNT_WEB_ORIGIN', 'CRATE_ACCOUNT_PROVIDER_URL']) {
      assert.equal(loadAccountConfig({ ...valid, [field]: origin }), null, `${field}: ${origin}`);
    }
  }
  assert.ok(loadAccountConfig(valid));
});
