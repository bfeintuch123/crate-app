'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { loadPolicy } = require('./policy-fixtures.cjs');
const authenticatedLoader = require('./authenticated-loader.cjs');
const URL = 'https://cache.example.invalid/resource';
const options = { protocol: 'https:', hostname: 'cache.example.invalid', path: '/resource', method: 'GET', headers: { host: 'cache.example.invalid' } };

async function scenario(variant, responseHeaders, originStatus, originHeaders = {}, incomingHeaders = {}, seededHeaders = {}) {
  const Policy = loadPolicy(variant);
  const modules = authenticatedLoader(Policy);
  const CacheableRequest = modules.load('cacheable-request');
  const Keyv = modules.load('keyv');
  let completeWrite;
  let writeCompleted = new Promise(resolve => { completeWrite = resolve; });
  class ObservedStore extends Map {
    set(key, value) { const result = super.set(key, value); completeWrite(); return result; }
    delete(key) { const result = super.delete(key); completeWrite(); return result; }
  }
  const store = new ObservedStore();
  const keyv = new Keyv({ store, namespace: 'cacheable-request' });
  const seedOptions = { ...options, headers: { ...options.headers, ...seededHeaders } };
  const policy = new Policy(seedOptions, { status: 200, headers: { age: '120', etag: '"cached"', ...responseHeaders } });
  await keyv.set('GET:' + URL, { cachePolicy: policy.toObject(), url: URL, statusCode: 200, body: Buffer.from('synthetic-cached-body') });
  writeCompleted = new Promise(resolve => { completeWrite = resolve; });
  let networkCalls = 0;
  const requestOptions = [];
  const streams = [];
  const cachedRequest = new CacheableRequest((opts, callback) => {
    networkCalls++;
    requestOptions.push(opts);
    const request = new EventEmitter();
    queueMicrotask(() => {
      const response = new PassThrough();
      streams.push(response);
      response.statusCode = originStatus;
      response.headers = { ...originHeaders };
      response.url = URL;
      callback(response);
      response.end('synthetic-origin-' + originStatus);
    });
    return request;
  }, store);
  async function read() {
    return new Promise((resolve, reject) => {
      const events = cachedRequest({ ...options, headers: { ...options.headers, ...incomingHeaders } });
      events.once('error', reject);
      events.once('response', response => {
        const chunks = [];
        response.once('error', reject);
        response.on('data', chunk => chunks.push(chunk));
        response.once('end', () => resolve({ status: response.statusCode, fromCache: response.fromCache, body: Buffer.concat(chunks).toString(), headers: response.headers }));
      });
    });
  }
  return { read, waitForWrite: () => writeCompleted, cacheEntry: () => keyv.get('GET:' + URL), get networkCalls() { return networkCalls; }, requestOptions, async close() {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    for (const stream of streams) stream.destroy();
    store.clear();
  } };
}

test('BASELINE INTEGRATION BYPASS: real cacheable-request serves restricted cookie body after 503', { timeout: 2000 }, async () => {
  const s = await scenario('baseline', { 'set-cookie': 'session=synthetic', 'cache-control': 'max-age=60, stale-if-error=600' }, 503, { 'cache-control': 'no-store' });
  try {
    const result = await s.read();
    assert.equal(s.networkCalls, 1);
    assert.equal(result.status, 200);
    assert.equal(result.fromCache, true);
    assert.equal(result.body, 'synthetic-cached-body');
    assert.equal(result.headers['set-cookie'], 'session=synthetic');
  } finally { await s.close(); }
});

for (const [name, headers, incoming, seeded] of [
  ['s-maxage', { 'cache-control': 'max-age=600, s-maxage=60, stale-if-error=600' }, {}, {}],
  ['authenticated s-maxage', { 'cache-control': 's-maxage=60, stale-if-error=600' }, { authorization: 'synthetic' }, { authorization: 'synthetic' }],
  ['Vary wildcard list', { vary: 'accept, *', 'cache-control': 'max-age=60, stale-if-error=600' }, {}, {}],
  ['mixed-case empty no-cache', { 'cache-control': 'max-age=60, No-Cache="", stale-if-error=600' }, {}, {}],
  ['incoming no-cache', { 'cache-control': 'max-age=60, stale-if-error=600' }, { 'cache-control': 'No-Cache=""' }, {}],
  ['incoming pragma', { 'cache-control': 'max-age=60, stale-if-error=600' }, { pragma: 'no-cache' }, {}],
  ['incoming max-age', { 'cache-control': 'max-age=60, stale-if-error=600' }, { 'cache-control': 'max-age=0' }, {}],
  ['incoming min-fresh', { 'cache-control': 'max-age=60, stale-if-error=600' }, { 'cache-control': 'min-fresh=999' }, {}],
  ['Connection strips no-cache', { 'cache-control': 'max-age=60, stale-if-error=600' }, { 'cache-control': 'no-cache', connection: 'cache-control' }, {}],
  ['Connection strips pragma', { 'cache-control': 'max-age=60, stale-if-error=600' }, { pragma: 'no-cache', connection: 'pragma' }, {}],
  ['Connection strips max-age', { 'cache-control': 'max-age=60, stale-if-error=600' }, { 'cache-control': 'max-age=0', connection: 'cache-control' }, {}],
  ['Connection strips min-fresh', { 'cache-control': 'max-age=60, stale-if-error=600' }, { 'cache-control': 'min-fresh=999', connection: 'cache-control' }, {}],
  ['Connection strips huge min-fresh', { age: '30', 'cache-control': 'max-age=60, stale-if-error=600' }, { 'cache-control': 'min-fresh=1000000000000000000000', connection: 'cache-control' }, {}],
  ['Connection strips overflow min-fresh', { age: '30', 'cache-control': 'max-age=60, stale-if-error=600' }, { 'cache-control': 'min-fresh=1' + '0'.repeat(400), connection: 'cache-control' }, {}],
]) {
  test(`residual integration ${name}: origin 503 returned and obsolete stored body deleted`, { timeout: 2000 }, async () => {
    const s = await scenario(process.env.POLICY_VARIANT || 'candidate', headers, 503, { 'cache-control': 'no-store' }, incoming, seeded);
    try {
      const result = await s.read();
      assert.equal(s.networkCalls, 1);
      assert.equal(result.status, 503);
      assert.equal(result.fromCache, false);
      assert.equal(result.body, 'synthetic-origin-503');
      await s.waitForWrite();
      assert.equal(await s.cacheEntry(), undefined);
    } finally { await s.close(); }
  });
}
for (const status of [500, 502, 503, 504]) {
  test(`candidate integration: real cacheable-request returns origin ${status}, not restricted stored body`, { timeout: 2000 }, async () => {
    const s = await scenario('candidate', { 'set-cookie': 'session=synthetic', 'cache-control': 'max-age=60, stale-if-error=600' }, status, { 'cache-control': 'no-store' });
    try {
      const result = await s.read();
      assert.equal(s.networkCalls, 1);
      assert.equal(result.status, status);
      assert.equal(result.fromCache, false);
      assert.equal(result.body, 'synthetic-origin-' + status);
      assert.equal(result.headers['set-cookie'], undefined);
    } finally { await s.close(); }
  });
}
test('candidate integration: ordinary matching stale-if-error still serves allowed cached body', { timeout: 2000 }, async () => {
  const s = await scenario('candidate', { 'cache-control': 'max-age=60, stale-if-error=600' }, 503, { 'cache-control': 'no-store' });
  try {
    const result = await s.read();
    assert.equal(result.fromCache, true);
    assert.equal(result.body, 'synthetic-cached-body');
    assert.equal(result.status, 200);
  } finally { await s.close(); }
});
test('candidate integration: successful 304 refreshes cache and next warm read avoids another request', { timeout: 2000 }, async () => {
  const s = await scenario('candidate', { 'cache-control': 'max-age=60' }, 304, { etag: '"cached"', 'cache-control': 'max-age=60', age: '0' });
  try {
    const first = await s.read();
    assert.equal(first.fromCache, true);
    assert.equal(first.body, 'synthetic-cached-body');
    assert.equal(s.requestOptions[0].headers['if-none-match'], '"cached"');
    await s.waitForWrite();
    const second = await s.read();
    assert.equal(second.fromCache, true);
    assert.equal(second.body, 'synthetic-cached-body');
    assert.equal(s.networkCalls, 1);
  } finally { await s.close(); }
});
