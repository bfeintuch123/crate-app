'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { loadPolicy } = require('./policy-fixtures.cjs');
const authenticatedLoader = require('./authenticated-loader.cjs');
const URL = 'https://cache.example.invalid/resource';
const options = { protocol: 'https:', hostname: 'cache.example.invalid', path: '/resource', method: 'GET', headers: { host: 'cache.example.invalid' } };

async function scenario(variant, responseHeaders, originStatus, originHeaders = {}, incomingHeaders = {}, seededHeaders = {}, policyOptions = {}) {
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
  const policy = new Policy(seedOptions, { status: 200, headers: { age: '120', etag: '"cached"', ...responseHeaders } }, policyOptions);
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
      const selected = Array.isArray(originStatus) ? originStatus[Math.min(networkCalls - 1, originStatus.length - 1)] : {status:originStatus, headers:originHeaders};
      response.statusCode = selected.status;
      response.headers = { ...selected.headers };
      response.url = URL;
      callback(response);
      response.end('synthetic-origin-' + selected.status);
    });
    return request;
  }, store);
  async function read(currentHeaders = incomingHeaders) {
    return new Promise((resolve, reject) => {
      const events = cachedRequest({ ...options, ...policyOptions, headers: { ...options.headers, ...currentHeaders } });
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



const variant=process.env.POLICY_VARIANT||'candidate';
const settle=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
for(const extra of ['',', public',', immutable'])test(`consumer legacy shared cookie${extra} fetches current200 with no cachedcookie/body/validator`,{timeout:2000},async()=> {
 const s=await scenario(variant,{'cache-control':'max-age=600'+extra,'set-cookie':['session=synthetic-A'],'last-modified':'Mon, 13 Nov 2023 00:00:00 GMT'},200,{'cache-control':'max-age=600','set-cookie':['session=synthetic-B']},{cookie:'requester-B'});
 try{const result=await s.read();assert.equal(s.networkCalls,1);assert.equal(result.fromCache,false);assert.equal(result.body,'synthetic-origin-200');assert.deepEqual(result.headers['set-cookie'],['session=synthetic-B']);assert.equal(s.requestOptions[0].headers['if-none-match'],undefined);assert.equal(s.requestOptions[0].headers['if-modified-since'],undefined);await settle();assert.equal(s.writes,0);assert.equal(s.deletes,1);assert.equal(await s.cacheEntry(),undefined);}finally{await s.close();}
});
for(const status of [304,503])test(`consumer legacycookie origin${status} cannot substitute storedbody/cookie`,{timeout:2000},async()=> {
 const s=await scenario(variant,{'cache-control':'max-age=60, stale-if-error=600','set-cookie':['session=synthetic-A']},status,{etag:'"cached"','cache-control':'no-store'});
 try{const result=await s.read();assert.equal(result.fromCache,false);assert.equal(result.status,status);assert.equal(result.body,'synthetic-origin-'+status);assert.equal(result.headers['set-cookie'],undefined);assert.equal(s.requestOptions[0].headers['if-none-match'],undefined);await settle();assert.equal(s.writes,0);assert.equal(await s.cacheEntry(),undefined);}finally{await s.close();}
});
test('consumer requesterA304 cookie then requesterB sees only currentorigin200/body with noA cookie',{timeout:2000},async()=> {
 const s=await scenario(variant,{'cache-control':'max-age=60'},[{status:304,headers:{etag:'"cached"',age:'0','cache-control':'max-age=600','set-cookie':['session=synthetic-A']}},{status:200,headers:{'cache-control':'max-age=600'}}]);
 try{const a=await s.read({cookie:'requester-A'});assert.equal(a.fromCache,true);assert.equal(a.body,'synthetic-cached-body');assert.deepEqual(a.headers['set-cookie'],['session=synthetic-A']);await settle();assert.equal(s.writes,0);assert.equal(s.deletes,1);assert.equal(await s.cacheEntry(),undefined);
  const b=await s.read({cookie:'requester-B'});assert.equal(s.networkCalls,2);assert.equal(b.fromCache,false);assert.equal(b.body,'synthetic-origin-200');assert.equal(b.headers['set-cookie'],undefined);assert.equal(s.requestOptions[1].headers['if-none-match'],undefined);await settle();assert.equal((await s.cacheEntry()).cachePolicy.resh['set-cookie'],undefined);
 }finally{await s.close();}
});
test('consumer inherited200 sharedcookie is never cached then B receives only its current response',{timeout:2000},async()=> {
 const s=await scenario(variant,{'cache-control':'max-age=60'},[{status:200,headers:{'cache-control':'public, max-age=600','set-cookie':['session=synthetic-A']}},{status:200,headers:{'cache-control':'max-age=600','set-cookie':['session=synthetic-B']}}]);
 try{const a=await s.read({cookie:'requester-A'});assert.deepEqual(a.headers['set-cookie'],['session=synthetic-A']);await settle();assert.equal(s.writes,0);assert.equal(await s.cacheEntry(),undefined);const b=await s.read({cookie:'requester-B'});assert.deepEqual(b.headers['set-cookie'],['session=synthetic-B']);assert.equal(b.fromCache,false);assert.equal(s.networkCalls,2);await settle();assert.equal(await s.cacheEntry(),undefined);}finally{await s.close();}
});
test('consumer private cookie fresh reuse retains own policy behavior',{timeout:2000},async()=> {
 const s=await scenario(variant,{'cache-control':'max-age=600','set-cookie':['session=synthetic-private']},503,{}, {}, {}, {shared:false});
 try{const result=await s.read();assert.equal(result.fromCache,true);assert.equal(s.networkCalls,0);assert.deepEqual(result.headers['set-cookie'],['session=synthetic-private']);assert.ok(await s.cacheEntry());}finally{await s.close();}
});
test('consumer ordinarycookie-free304 retains validatedbody and nextwarmcachehit',{timeout:2000},async()=> {
 const s=await scenario(variant,{'cache-control':'max-age=60'},304,{etag:'"cached"',age:'0','cache-control':'max-age=600'});
 try{assert.equal((await s.read()).body,'synthetic-cached-body');await settle();assert.equal((await s.read()).body,'synthetic-cached-body');assert.equal(s.networkCalls,1);assert.equal(s.writes,1);assert.equal(s.deletes,0);}finally{await s.close();}
});
test('two-requester actual304 replay control: B matching304 never receives remembered A cookie or body',{timeout:2000},async()=> {
 const s=await scenario(variant,{'cache-control':'max-age=60'},[{status:304,headers:{etag:'"cached"',age:'0','cache-control':'max-age=600','set-cookie':['session=synthetic-A']}},{status:304,headers:{etag:'"cached"',age:'0','cache-control':'max-age=600'}}]);
 try{const a=await s.read({cookie:'requester-A'});assert.deepEqual(a.headers['set-cookie'],['session=synthetic-A']);await settle();
  const b=await s.read({cookie:'requester-B'});assert.equal(s.networkCalls,2);assert.equal(b.headers['set-cookie'],undefined);assert.equal(b.fromCache,false);assert.equal(b.status,304);assert.equal(b.body,'synthetic-origin-304');await settle();const entry=await s.cacheEntry();if(entry){assert.equal(entry.statusCode,304);assert.equal(entry.body.toString(),'synthetic-origin-304');assert.equal(entry.cachePolicy.resh['set-cookie'],undefined);}
 }finally{await s.close();}
});
