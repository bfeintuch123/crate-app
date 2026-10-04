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
  let writes = 0; let deletes = 0;
  const oldSet = store.set.bind(store); const oldDelete = store.delete.bind(store);
  store.set = (k,v) => { writes++; return oldSet(k,v); };
  store.delete = k => { deletes++; return oldDelete(k); };
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
  return { read, waitForWrite: () => writeCompleted, cacheEntry: () => keyv.get('GET:' + URL), get networkCalls() { return networkCalls; }, get writes() { return writes; }, get deletes() { return deletes; }, requestOptions, async close() {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    for (const stream of streams) stream.destroy();
    store.clear();
  } };
}


const variant=process.env.POLICY_VARIANT || 'candidate';
for (const status of [200,304,503]) test(`consumer request no-store sanitized: status${status}, no storage, existing entry deleted`,{timeout:2000},async()=> {
 const s=await scenario(variant,{'cache-control':'max-age=60, stale-if-error=600'},status,{etag:'"cached"',age:'0','cache-control':'max-age=600'},{'cache-control':'no-store',connection:'cache-control'});
 try {
  const first=await s.read();assert.equal(s.networkCalls,1);
  assert.equal(s.requestOptions[0].headers['cache-control'],undefined);assert.equal(s.requestOptions[0].headers.connection,undefined);
  assert.equal(first.body,status===200?'synthetic-origin-200':'synthetic-cached-body');assert.equal(first.status,200);
  await s.waitForWrite();assert.equal(s.writes,0);assert.equal(s.deletes,1);assert.equal(await s.cacheEntry(),undefined);
 } finally {await s.close();}
});
for (const [name,added,deletion] of [
 ['no-store',{'cache-control':'no-store'},true],['private',{'cache-control':'private'},true],
 ['no-cache',{'cache-control':'no-cache'},false],['wildcard',{vary:'*'},false],['cookie',{'set-cookie':'synthetic=yes'},true]
]) test(`consumer matching304 adds ${name} absent from cached headers and forbids next unvalidated warm read`,{timeout:2000},async()=> {
 // No initial Cache-Control, Vary or Set-Cookie: stale Expires forces validation.
 const s=await scenario(variant,{expires:new Date(1699999990000).toUTCString()},304,{etag:'"cached"',age:'0',expires:new Date(1700000600000).toUTCString(),...added});
 try {
  const first=await s.read();assert.equal(first.body,'synthetic-cached-body');assert.equal(first.fromCache,true);
  await s.waitForWrite();
  if(deletion){assert.equal(s.writes,0);assert.equal(s.deletes,1);assert.equal(await s.cacheEntry(),undefined);}
  else {const entry=await s.cacheEntry();for(const [k,v] of Object.entries(added))assert.equal(entry.cachePolicy.resh[k],v);}
  await s.read();assert.equal(s.networkCalls,2);
 } finally {await s.close();}
});
test('consumer permitted304 newly added max-age refreshes and next warm read avoids network',{timeout:2000},async()=> {
 const s=await scenario(variant,{},304,{etag:'"cached"',age:'0','cache-control':'max-age=600'});
 try {assert.equal((await s.read()).body,'synthetic-cached-body');await s.waitForWrite();assert.equal(s.writes,1);assert.equal(s.deletes,0);
  assert.equal((await s.read()).body,'synthetic-cached-body');assert.equal(s.networkCalls,1);
 } finally{await s.close();}
});
test('consumer no-store fresh hit permits existing body without writing or deleting',{timeout:2000},async()=> {
 const s=await scenario(variant,{'cache-control':'max-age=600'},503,{}, {'cache-control':'no-store',connection:'cache-control'});
 try {assert.equal((await s.read()).body,'synthetic-cached-body');assert.equal(s.networkCalls,0);assert.equal(s.writes,0);assert.equal(s.deletes,0);assert.ok(await s.cacheEntry());}
 finally{await s.close();}
});
for(const cc of ['max-age=0, MAX-AGE=600','max-age=600, max-age=600']) test(`consumer duplicated freshness ${cc} rejects allowed stale503 fallback`,{timeout:2000},async()=> {
 const s=await scenario(variant,{'cache-control':cc+', stale-if-error=600, stale-while-revalidate=600'},503,{'cache-control':'no-store'});
 try {const result=await s.read();assert.equal(s.networkCalls,1);assert.equal(result.status,503);assert.equal(result.body,'synthetic-origin-503');await s.waitForWrite();assert.equal(await s.cacheEntry(),undefined);}
 finally {await s.close();}
});

for(const [name,cc,deletion] of [['no-store','no-store',true],['no-cache','no-cache',false]]) test(`consumer304 Connection-nominated ${name} cannot bypass restriction`,{timeout:2000},async()=> {
 const s=await scenario(variant,{expires:new Date(1699999990000).toUTCString()},304,{etag:'"cached"',age:'0',expires:new Date(1700000600000).toUTCString(),'cache-control':cc,connection:'cache-control'});
 try {const first=await s.read();assert.equal(first.body,'synthetic-cached-body');assert.equal(first.headers['cache-control'],undefined);assert.equal(first.headers.connection,undefined);await s.waitForWrite();
  if(deletion){assert.equal(s.writes,0);assert.equal(s.deletes,1);assert.equal(await s.cacheEntry(),undefined);}else{assert.equal((await s.cacheEntry()).cachePolicy.resh['cache-control'],cc);}
  await s.read();assert.equal(s.networkCalls,2);
 }finally{await s.close();}
});
