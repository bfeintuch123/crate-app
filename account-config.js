'use strict';

const fs = require('node:fs');
const path = require('node:path');

const runtimeIdentity = require('./runtime-identity.json');
const { isDeepStrictEqual } = require('node:util');
if (!isDeepStrictEqual(runtimeIdentity, { appId: 'com.crate.app', productName: 'Crate', callbackScheme: 'com.get-crate.app' })) {
  throw new Error('account_runtime_identity');
}
const CALLBACK_SCHEME = runtimeIdentity.callbackScheme;
const CALLBACK = `${CALLBACK_SCHEME}:/oauth/callback`;
const BUNDLED_CONFIG_PATH = path.join(__dirname, 'account-config.json');
const CONFIG_KEYS = Object.freeze([
  'CRATE_ACCOUNT_PROVIDER_URL',
  'CRATE_ACCOUNT_WEB_ORIGIN',
  'CRATE_ACCOUNT_CLIENT_ID',
  'CRATE_ACCOUNT_PUBLIC_KEY'
]);
function httpsOrigin(value) {
  const url = new URL(value);
  const hostname = url.hostname.replace(/\.$/, '').toLowerCase();
  const localHost = hostname === 'localhost' || hostname.endsWith('.localhost') ||
    /^127\./.test(hostname) || ['0.0.0.0', '[::]', '[::1]'].includes(hostname) ||
    /^\[::(?:ffff:)?7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(hostname);
  if (localHost || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('account_configuration');
  return url.origin;
}

function readBundledConfig(configPath) {
  try {
    const value = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (Object.keys(value).some(key => !['providerUrl', 'webOrigin', 'clientId', 'publicKey'].includes(key))) return null;
    return {
      CRATE_ACCOUNT_PROVIDER_URL: value.providerUrl,
      CRATE_ACCOUNT_WEB_ORIGIN: value.webOrigin,
      CRATE_ACCOUNT_CLIENT_ID: value.clientId,
      CRATE_ACCOUNT_PUBLIC_KEY: value.publicKey
    };
  } catch (_) {
    return null;
  }
}

// Public configuration only. Missing configuration leaves workspace access locked.
function loadAccountConfig(env = process.env, bundledConfigPath = BUNDLED_CONFIG_PATH) {
  try {
    const hasEnvironmentConfig = CONFIG_KEYS.some(key => Object.prototype.hasOwnProperty.call(env, key));
    const source = hasEnvironmentConfig ? env : readBundledConfig(bundledConfigPath);
    if (!source) return null;
    const provider = httpsOrigin(source.CRATE_ACCOUNT_PROVIDER_URL);
    const origin = httpsOrigin(source.CRATE_ACCOUNT_WEB_ORIGIN);
    const clientId = source.CRATE_ACCOUNT_CLIENT_ID;
    const publicKey = source.CRATE_ACCOUNT_PUBLIC_KEY;
    if (typeof publicKey !== 'string' || publicKey.length > 2048 || /[\s\x00-\x1f]/.test(publicKey)) return null;
    if (!/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(publicKey)) {
      try { if (JSON.parse(Buffer.from(publicKey.split('.')[1], 'base64url').toString()).role !== 'anon') return null; } catch (_) { return null; }
    }
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(clientId || '')) return null;
    return Object.freeze({ provider, origin, clientId, publicKey, issuer: `${provider}/auth/v1`,
      redirectUri: `${origin}/auth/desktop/callback`, callback: CALLBACK });
  } catch (_) { return null; }
}
module.exports = { BUNDLED_CONFIG_PATH, CALLBACK, CALLBACK_SCHEME, loadAccountConfig };
