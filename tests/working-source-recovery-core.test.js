'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { fileURLToPath } = require('node:url');
const { verifyInDesignRecovery } = require('../parsers/working-source-recovery-core');
const { runBoundedAddFilesScan } = require('../parsers/add-files-operation');
const { extractLinkedAssetPaths } = require('../parsers/linked-asset-matcher');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const names = ['getWorkingSourceDiskIdentity','getAddFilesSourceIdentity','isAddFilesSourceIdentityCurrent',
  'getAddFilesCurrentSourceDigest','assertDependableAssetBaselineSource','collectWorkingSourceScanEvidence',
  'normalizeTrackedFilePath','sanitizeLiveEvidenceText','normalizeIllustratorHfsPath','normalizeIllustratorEvidencePath',
  'recordIllustratorPathNormalization','normalizeLiveCaptureReason','incrementLiveAppSkipCount','parseInDesignActiveSessionOutput',
  'parseDependableInDesignBaselineSnapshot','extractLinkedAssetsInDesign','extractLinkedAssetsRegex'];
const functionSource = names.map(name => {
  const start = main.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
  if (start < 0) throw new Error('function missing: ' + name);
  const end = main.slice(start).search(/^\}/m);
  if (end < 0) throw new Error('function end missing: ' + name);
  return main.slice(start, start + end + 1);
}).join('\n\n');

const MAX_PARSE_FILE_SIZE = 300 * 1024 * 1024;
const savedProvider = 'saved-byte-regex-fallback';
const liveProvider = 'indesign-live-current-bytes-unbound';
const plain = value => JSON.parse(JSON.stringify(value));
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise,resolve}; };

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'crate-recovery-core-'));
  const filePath = path.join(root,'selected.indd');
  fs.writeFileSync(filePath, 'synthetic saved bytes\0/Users/synthetic/Missing.png\0');
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  let current = true, listener = null, queries = 0, inventoryCalls = 0, sequence = 0;
  const capability = {
    current: () => current,
    onCancel(fn) { listener = fn; return () => { listener = null; }; },
  };
  const context = vm.createContext({fs,path,crypto,Buffer,fileURLToPath,MAX_PARSE_FILE_SIZE,extractLinkedAssetPaths,
    REGEX_SOURCE_EXTENSIONS:new Set(), STRICT_ZIP_ASSET_BASELINE_EXTENSIONS:new Set(),
    INDD_APPLESCRIPT:'synthetic-placeholder-no-native-execution', console:{log(){},warn(){},error(){}},
    execFileAsync:async (command,args,options) => {
      assert.equal(command,'/bin/ps'); assert.deepEqual(plain(args),['axww','-o','pid=','-o','comm=']);
      assert.equal(options.timeout,3000); assert.equal(options.maxBuffer,4*1024*1024);
      inventoryCalls++;
      if (overrides.inventoryError) throw overrides.inventoryError;
      return overrides.inventory || {stdout:' 1 /sbin/launchd\n',stderr:''};
    },
    execAsync:async () => {throw Error('legacy process lookup must not run');},
    beginInDesignObservation:() => ({epoch:'11111111-2222-3333-4444-555555555555',sequence:++sequence}),
    runOsascriptInPrivateTemp:async () => {
      queries++;
      if (overrides.queryError) throw overrides.queryError;
      return {stdout:typeof overrides.snapshot === 'function' ? overrides.snapshot(filePath) : overrides.snapshot || '',stderr:''};
    },
  });
  vm.runInContext(functionSource+'\nthis.api = {getWorkingSourceDiskIdentity,getAddFilesCurrentSourceDigest,assertDependableAssetBaselineSource,collectWorkingSourceScanEvidence,extractLinkedAssets:extractLinkedAssetsInDesign};',context);
  const deps = {...context.api,runBoundedAddFilesScan};
  return {root,filePath,capability,deps,
    run:input => verifyInDesignRecovery({filePath,capability,...input},deps),
    cancel() {current=false; listener?.();}, stale(){current=false;},
    queries:()=>queries,inventoryCalls:()=>inventoryCalls,listener:()=>listener};
}
const running = {stdout:' 1 /sbin/launchd\n 42 /Applications/Adobe InDesign/Adobe InDesign\n',stderr:''};
const snapshot = (source, modified='false', links=['/Users/synthetic/Linked.png']) => [
  `DOC\t${source}\tSelected\t${modified}\ttrue\t${links.length}`,
  ...links.map(link=>`LINK\t${source}\tSelected\t${link}\tfalse\ttrue`),
  `END\t1\t${links.length}\t${links.length}\t0`,
].join('\n');

test('fixture extracts all named functions from the current production source',()=>{
  assert.equal(new Set(names).size,names.length);
  for(const name of names) assert.ok(functionSource.includes('function '+name+'('));
});
test('closed-app saved scan preserves missing references and produces frozen result only',async t=>{
  const f=fixture(t); const raw={status:'invalid',requiredReferences:[{path:'/Users/synthetic/Old.png'}],opaque:{keep:true}};
  const state={workingSourceVerification:{key:raw},files:[],assetBaseline:{status:'decision-required'}};
  const before=JSON.stringify(state); Object.freeze(raw); Object.freeze(state);
  const result=await f.run();
  assert.equal(result.success,true); assert.equal(result.eligible,true); assert.equal(result.verification.status,'scanned');
  assert.equal(result.verification.sourceFingerprint,crypto.createHash('sha256').update(fs.readFileSync(f.filePath)).digest('hex'));
  assert.deepEqual(plain(result.verification.requiredReferences),[{path:'/Users/synthetic/Missing.png'}]);
  assert.ok(result.verification.notes.includes(savedProvider)); assert.equal(result.verification.inventoryStatus,'unverified');
  assert.equal(f.queries(),0); assert.equal(JSON.stringify(state),before); assert.equal(state.workingSourceVerification.key,raw);
  assert.equal(f.listener(),null); assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.verification.requiredReferences[0]));
});
test('complete running-app snapshot missing selected document permits saved fallback',async t=>{
  const f=fixture(t,{inventory:running,snapshot:'END\t0\t0\t0\t0'}); const r=await f.run();
  assert.equal(r.eligible,true); assert.equal(f.queries(),1); assert.ok(r.verification.notes.includes(savedProvider));
});
test('clean live selected source remains unbound and cannot be eligible',async t=>{
  const f=fixture(t,{inventory:running,snapshot:source=>snapshot(source)}); const r=await f.run();
  assert.equal(r.success,true); assert.equal(r.eligible,false); assert.equal(r.verification.status,'scanned');
  assert.ok(r.verification.unresolved.some(x=>x.reason===liveProvider));
  assert.deepEqual(plain(r.verification.requiredReferences),[{path:'/Users/synthetic/Linked.png'}]);
});
for (const modified of ['true','unknown']) test(`dirty ${modified} selected source aborts before proof and returns bounded observation`,async t=>{
  const f=fixture(t,{inventory:running,snapshot:source=>snapshot(source,modified)}); const r=await f.run();
  assert.equal(r.success,false); assert.equal(r.reason,'indesign-document-dirty'); assert.equal(r.verification.sourceIdentity,null);
  assert.equal(r.dirtyObservation.documentModified,modified==='true'?true:null); assert.equal(r.dirtyObservation.order.sequence,1);
});
test('dirty recognizable row in failed query cannot become fallback',async t=>{
  const f=fixture(t,{inventory:running}); f.deps.extractLinkedAssets=async (file,options)=>{
    try {options.onInDesignDirtyDocument({modified:true,secret:'not returned'},{epoch:'11111111-2222-3333-4444-555555555555',sequence:2});} catch (_) {}
    options.onProvider(savedProvider); return [];
  };
  const r=await f.run(); assert.equal(r.reason,'indesign-document-dirty'); assert.equal(JSON.stringify(r).includes('secret'),false);
});
test('dirty failed AppleScript stdout is retained even with permission denial',async t=>{
  const f=fixture(t,{inventory:running}); const error=Error('denied'); error.code=-1743; error.stdout=snapshot(f.filePath,'true');
  const other=fixture(t,{inventory:running,queryError:error});
  // Use the same selected path to make the failed query's DOC relevant.
  const r=await verifyInDesignRecovery({filePath:f.filePath,capability:f.capability},other.deps);
  assert.equal(r.reason,'indesign-document-dirty'); assert.equal(r.dirtyObservation.documentModified,true);
});
for (const entry of [
  ['empty inventory',{inventory:{stdout:'',stderr:''}},'indesign-query-failed'],
  ['inventory missing newline',{inventory:{stdout:'1 /sbin/launchd',stderr:''}},'indesign-query-failed'],
  ['inventory stderr',{inventory:{stdout:'1 /sbin/launchd\n',stderr:'failure'}},'indesign-query-failed'],
  ['duplicate pid',{inventory:{stdout:'1 /sbin/launchd\n1 /bin/another\n',stderr:''}},'indesign-query-failed'],
  ['inventory error',{inventoryError:Error('private contents')},'indesign-query-failed'],
  ['query denial',{inventory:running,queryError:Object.assign(Error('private contents'),{code:-1743})},'indesign-access-denied'],
  ['query failure',{inventory:running,queryError:Error('private contents')},'indesign-query-failed'],
  ['incomplete snapshot',{inventory:running,snapshot:'END\t1\t0\t0\t0'},'indesign-query-failed'],
  ['terminal query errors',{inventory:running,snapshot:'END\t0\t0\t0\t1'},'indesign-query-failed'],
]) test(entry[0]+' fails closed without regex fallback',async t=>{
  const f=fixture(t,entry[1]),r=await f.run(); assert.equal(r.success,false); assert.equal(r.reason,entry[2]);
  assert.equal(r.verification.sourceFingerprint,null); assert.equal(JSON.stringify(r).includes('private contents'),false);
});
test('live extraction only includes the selected source links',async t=>{
  const f=fixture(t,{inventory:running,snapshot:source=>[
    `DOC\t${source}\tSelected\tfalse\ttrue\t1`,`LINK\t${source}\tSelected\t/Users/synthetic/Selected.png\tfalse\ttrue`,
    'DOC\t/Users/synthetic/Other.indd\tOther\tfalse\tfalse\t1','LINK\t/Users/synthetic/Other.indd\tOther\t/Users/synthetic/Other.png\tfalse\tfalse',
    'END\t2\t2\t2\t0'].join('\n')});
  const r=await f.run(); assert.deepEqual(plain(r.verification.requiredReferences),[{path:'/Users/synthetic/Selected.png'}]);
});
for (const key of ['dev','ino','size','mtimeMs','ctimeMs']) test(`full identity ${key} change blocks result`,async t=>{
  const f=fixture(t); const get=f.deps.getWorkingSourceDiskIdentity; let changed=false;
  f.deps.extractLinkedAssets=async (_,o)=>{o.onProvider(savedProvider);changed=true;return [];};
  f.deps.getWorkingSourceDiskIdentity=file=>{const identity=get(file);return changed?{...identity,[key]:identity[key]+1}:identity;};
  assert.equal((await f.run()).reason,'source-bytes-changed');
});
test('same-stat digest mismatch blocks result',async t=>{
  const f=fixture(t); let calls=0;
  f.deps.getAddFilesCurrentSourceDigest=async()=> (++calls===1?'a':'b').repeat(64);
  assert.equal((await f.run()).reason,'source-bytes-changed');
});
test('identity change after bounded runner completes is checked again',async t=>{
  const f=fixture(t); const run=f.deps.runBoundedAddFilesScan;
  f.deps.runBoundedAddFilesScan=async(...args)=>{const r=await run(...args); fs.writeFileSync(f.filePath,'changed');return r;};
  assert.equal((await f.run()).reason,'source-bytes-changed');
});
test('stale capability before scan prevents IO',async t=>{
  const f=fixture(t);f.stale();const r=await f.run();assert.equal(r.reason,'recovery-capability-stale');assert.equal(f.inventoryCalls(),0);
});
test('stale capability after dependable-source await prevents extraction',async t=>{
  const f=fixture(t);f.deps.assertDependableAssetBaselineSource=async()=>{f.stale();};
  assert.equal((await f.run()).reason,'recovery-capability-stale');assert.equal(f.inventoryCalls(),0);
});
test('cancellation during extraction settles promptly and cannot return late success',async t=>{
  const f=fixture(t),started=defer(),gate=defer();let options;
  f.deps.extractLinkedAssets=async(_,o)=>{options=o;started.resolve();await gate.promise;return [];};
  const pending=f.run();await started.promise;f.cancel();const r=await pending;
  assert.equal(r.reason,'recovery-capability-stale');assert.throws(()=>options.onProvider(savedProvider));
  gate.resolve();await new Promise(r=>setImmediate(r));assert.equal(f.listener(),null);
});
test('deadline bounds unresolved provider wait and late callbacks are retired',async t=>{
  const f=fixture(t),gate=defer();let options;
  f.deps.extractLinkedAssets=async(_,o)=>{options=o;await gate.promise;return [];};
  const r=await f.run({timeoutMs:20});assert.equal(r.reason,'scan-timeout');
  assert.throws(()=>options.onProvider(savedProvider));gate.resolve();await new Promise(r=>setImmediate(r));
});
for(const stage of ['onOrdinaryScanFailure','onOrdinaryScanLimit'])test(`${stage} survives a nonthrowing extractor`,async t=>{
  const f=fixture(t);f.deps.extractLinkedAssets=async(_,o)=>{o.onProvider(savedProvider);o[stage]();return [];};
  const r=await f.run();assert.equal(r.eligible,false);assert.equal(r.verification.status,stage.endsWith('Limit')?'limited':'failed');
});
test('declared unresolved issues and limits remain bounded and ineligible',async t=>{
  const f=fixture(t);f.deps.extractLinkedAssets=async(_,o)=>{o.onProvider(savedProvider);for(let i=0;i<140;i++)o.onUnresolvedDependency('unresolved-link');return [];};
  const r=await f.run();assert.equal(r.eligible,false);assert.equal(r.verification.status,'limited');assert.equal(r.verification.unresolved.length,128);
  assert.ok(r.verification.unresolved.some(x=>x.reason==='reference-coverage-limit'));
});
test('oversized linked path inventory is bounded, retains obligations, and ineligible',async t=>{
  const f=fixture(t);f.deps.extractLinkedAssets=async(_,o)=>{o.onProvider(savedProvider);return Array.from({length:8200},(_,i)=>`/Users/synthetic/${i}.png`);};
  const r=await f.run();assert.equal(r.verification.requiredReferences.length,8192);assert.equal(r.verification.status,'limited');assert.equal(r.eligible,false);
});
test('unsupported references and overlong issue strings cannot certify recovery',async t=>{
  const f=fixture(t);f.deps.extractLinkedAssets=async(_,o)=>{o.onProvider(savedProvider);o.onUnresolvedDependency('x'.repeat(1000));return ['relative.png'];};
  const r=await f.run();assert.equal(r.eligible,false);assert.ok(r.verification.unresolved.every(x=>x.reason.length<=128));
});
for(const [name,extractor] of [
  ['missing provider',async()=>[]],
  ['unknown provider',async(_,o)=>{o.onProvider('unsupported-provider');return [];}],
  ['contradictory providers',async(_,o)=>{o.onProvider(savedProvider);o.onProvider(liveProvider);return [];}],
  ['non-array result',async(_,o)=>{o.onProvider(savedProvider);return 'malformed';}],
])test(`${name} is rejected`,async t=>{const f=fixture(t);f.deps.extractLinkedAssets=extractor;const r=await f.run();assert.equal(r.success,false);assert.equal(r.eligible,false);});
test('source size limit prevents extraction',async t=>{
  const f=fixture(t);f.deps.getWorkingSourceDiskIdentity=()=>({dev:1,ino:1,size:MAX_PARSE_FILE_SIZE+1,mtimeMs:1,ctimeMs:1});
  const r=await f.run();assert.equal(r.verification.status,'limited');assert.equal(f.inventoryCalls(),0);
});
test('no write-oriented dependencies exist in core source',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','parsers','working-source-recovery-core.js'),'utf8');
  for(const name of ['beginWorkingSourceScan','publishWorkingSourceScan','mutateProject','beginProjectAssetBaselineScan','stageLiveObservedFile','admitIllustratorRelationshipPathsForProject'])assert.equal(source.includes(name+'('),false);
});

test('full issue list retains both coverage-limit and live-unbound mandatory markers',async t=>{
  const f=fixture(t);f.deps.extractLinkedAssets=async(_,o)=>{o.onProvider(liveProvider);for(let i=0;i<140;i++)o.onUnresolvedDependency('unresolved-link');return [];};
  const r=await f.run();assert.equal(r.verification.unresolved.length,128);assert.equal(r.eligible,false);
  assert.ok(r.verification.unresolved.some(x=>x.reason===liveProvider));assert.ok(r.verification.unresolved.some(x=>x.reason==='reference-coverage-limit'));
});
test('4 MiB path-unit limit produces bounded ineligible evidence',async t=>{
  const f=fixture(t);f.deps.extractLinkedAssets=async(_,o)=>{o.onProvider(savedProvider);return Array.from({length:5000},(_,i)=>`/Users/synthetic/${'a'.repeat(1000)}/${i}.png`);};
  const r=await f.run();assert.equal(r.eligible,false);assert.equal(r.verification.status,'limited');
  assert.ok(r.verification.requiredReferences.reduce((s,r)=>s+r.path.length,0)<=4*1024*1024);
});
test('malformed internal collector output cannot become receipt',async t=>{
  const f=fixture(t);f.deps.collectWorkingSourceScanEvidence=()=>({requiredReferences:[{path:'relative'}],unresolved:[],limited:false});
  const r=await f.run();assert.equal(r.reason,'recovery-extractor-invalid-result');assert.equal(r.eligible,false);
});
test('stale capability during collector blocks result',async t=>{
  const f=fixture(t),collect=f.deps.collectWorkingSourceScanEvidence;
  f.deps.collectWorkingSourceScanEvidence=(...args)=>{const r=collect(...args);f.stale();return r;};
  assert.equal((await f.run()).reason,'recovery-capability-stale');
});
test('stale capability during first digest blocks dependable-source and extraction',async t=>{
  const f=fixture(t);f.deps.getAddFilesCurrentSourceDigest=async()=>{f.stale();return 'a'.repeat(64);};
  assert.equal((await f.run()).reason,'recovery-capability-stale');assert.equal(f.inventoryCalls(),0);
});
test('stale capability after outer bounded await blocks result',async t=>{
  const f=fixture(t),run=f.deps.runBoundedAddFilesScan;
  f.deps.runBoundedAddFilesScan=async(...args)=>{const r=await run(...args);f.stale();return r;};
  assert.equal((await f.run()).reason,'recovery-capability-stale');
});
test('invalid source identity and digest cannot create a scanned receipt',async t=>{
  const f=fixture(t);f.deps.getWorkingSourceDiskIdentity=()=>null;assert.equal((await f.run()).reason,'source-unavailable');
  const g=fixture(t);g.deps.getAddFilesCurrentSourceDigest=async()=>null;assert.equal((await g.run()).reason,'source-verification-unavailable');
});
for(const pathValue of ['relative.indd','/tmp/unsupported.idml','/tmp/bad\0name.indd'])test(`invalid source path ${JSON.stringify(pathValue)} refuses before dependencies`,async()=>{
  const result=await verifyInDesignRecovery({filePath:pathValue,capability:{current:()=>true}},{});
  assert.equal(result.reason,'recovery-extractor-invalid-result');
});
test('dirty observations with malformed order never forward opaque provider state',async t=>{
  const f=fixture(t);f.deps.extractLinkedAssets=async(_,o)=>{o.onInDesignDirtyDocument({modified:null},{epoch:'bad',sequence:Infinity,extra:'private'});return [];};
  const r=await f.run();assert.equal(r.reason,'indesign-document-dirty');assert.equal(r.dirtyObservation.order,null);assert.equal(JSON.stringify(r).includes('private'),false);
});
test('a second invocation cannot revive callbacks from a previous timeout',async t=>{
  const f=fixture(t);const original=f.deps.extractLinkedAssets;let retired;const gate=defer();
  f.deps.extractLinkedAssets=async(_,o)=>{retired=o;await gate.promise;return [];};
  assert.equal((await f.run({timeoutMs:10})).reason,'scan-timeout');f.deps.extractLinkedAssets=original;
  assert.equal((await f.run()).eligible,true);assert.throws(()=>retired.onInDesignDirtyDocument({modified:true},{}));
  gate.resolve();await new Promise(r=>setImmediate(r));
});
