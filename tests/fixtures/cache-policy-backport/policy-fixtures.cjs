'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const NOW = 1700000000000;
const rootRequire = createRequire(path.resolve(__dirname, '../../../package.json'));
const consumerRequire = createRequire(rootRequire.resolve('cacheable-request/package.json'));
const filename = consumerRequire.resolve('http-cache-semantics');
const expected = '91395fae0cfe22fb18f5c905f484856ac7ee39f737a9aa6c351c63bc3ca8abcf';
if (crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex') !== expected) {
  throw new Error('Installed policy differs from the independently reviewed source');
}
const InstalledPolicy = consumerRequire('http-cache-semantics');
const request = { url: '/resource', method: 'GET', headers: { host: 'cache.example.invalid', accept: 'text/plain' } };
function loadPolicy(variant) {
  if (variant !== 'candidate') throw new Error('This integration suite only runs the installed candidate');
  // Control time only. The real consumer loads the same ordinary installed module;
  // no constructor replacement, loader injection or product-file mutation occurs.
  InstalledPolicy.prototype.now = function now() { return NOW; };
  return class FixedTimePolicy extends InstalledPolicy { now() { return NOW; } };
}
function policyFor(Policy, headers = {}, options, originalRequest = request) {
  return new Policy(originalRequest, { status: 200, headers: {
    'cache-control': 'max-age=60', age: '120', etag: '"synthetic-original"', ...headers,
  } }, options);
}
function variants(Policy, policy) {
  return [policy, Policy.fromObject(JSON.parse(JSON.stringify(policy.toObject())))];
}
function withRequestHeaders(headers) {
  return { ...request, headers: { ...request.headers, ...headers } };
}
module.exports = { NOW, request, loadPolicy, policyFor, variants, withRequestHeaders, consumerRequire, InstalledPolicy };
