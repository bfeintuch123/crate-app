'use strict';
// User-approved additional TEST-ONLY cycle. Production main stays frozen.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),assert=require('node:assert/strict');
const existing=fs.readFileSync(path.join(__dirname,'pre-package-recent-yield.test.js'),'utf8');
const boundary=existing.indexOf('function cases(){');
const fixtureStart=existing.indexOf('  async function fixture(count){',boundary);
const fixtureEnd=existing.indexOf('  for(const count of [4,773])',fixtureStart);
assert.ok(boundary>0&&fixtureStart>boundary&&fixtureEnd>fixtureStart,'frozen fixture prelude drift');
const source=existing.slice(0,boundary)+'function cases(){\n'+existing.slice(fixtureStart,fixtureEnd)+'\n('+confCases.toString()+')();\n}\n';
const entry=path.join(__dirname,'pre-package-recent-yield.test.js');
const compiled=new Module(entry,module);compiled.filename=entry;compiled.paths=Module._nodeModulePaths(__dirname);compiled._compile(source,entry);
function confCases(){
  const clone=value=>JSON.parse(JSON.stringify(value));
  async function attach(f){
    await getProject(f.p.id); // Complete ordinary fixture normalization before snapshot.
    const initial=clone(storeInstance.data),Conf=originalLoad.call(Module,'conf',module);
    assert.equal(originalLoad.call(Module,'conf/package.json',module).version,'10.2.0');
    const cwd=fs.mkdtempSync(path.join(TEST_HOME,'conf-retirement-'));
    const backend=new Conf({cwd,projectName:'synthetic-retirement',watch:false});backend.store=initial;
    const methods={get:storeInstance.get,set:storeInstance.set,delete:storeInstance.delete,path:storeInstance.path};
    storeInstance.get=backend.get.bind(backend);storeInstance.set=backend.set.bind(backend);storeInstance.delete=backend.delete.bind(backend);storeInstance.path=backend.path;
    return{backend,detach(){storeInstance.data=clone(backend.store);Object.assign(storeInstance,methods);}};
  }
  async function drain(id){
    for(let i=0;i<400&&metadataTestHooks.isPackageScanInFlight(id);i++)await new Promise(r=>originalSetTimeout(r,5));
    assert.equal(metadataTestHooks.isPackageScanInFlight(id),false,'real work must settle before teardown/retry');
  }
  discoveryTest('actual Conf detached project edits cannot persist through an unrelated write',async()=>{
    const f=await fixture(4),storage=await attach(f);
    try{
      const before=storage.backend.get('projects'),a=storage.backend.get('projects'),b=storage.backend.get('projects');
      assert.notStrictEqual(a,b);assert.notStrictEqual(a[0],b[0]);
      a.find(p=>p.id===f.p.id).pendingFiles.push({path:path.join(f.folder,'Never-persisted.png'),source:'synthetic-detachment-probe'});
      assert.deepEqual(storage.backend.get('projects'),before);
      storage.backend.set('syntheticUnrelatedWrite','after-detached-edit');
      assert.deepEqual(storage.backend.get('projects'),before);
      assert.deepEqual(JSON.parse(fs.readFileSync(storage.backend.path,'utf8')).projects,before);
    }finally{storage.detach();clearTrackedTimers();}
  });
  for(const mode of ['account','project','timeout'])discoveryTest('actual Conf '+mode+' retirement after staged prefix preserves durable state and review ownership',{timeout:18000},async()=>{
    const f=await fixture(70);
    setChildProcessHandler(request=>{const paths=bulkXattrPaths(request);return paths.length?{stdout:formatBulkXattrOutput(paths,()=>encodeLastUsedXattr(Date.now()))}:{stdout:''};});
    const storage=await attach(f),backend=storage.backend;
    const row=()=>backend.get('projects').find(p=>p.id===f.p.id);
    const sourceBytes=f.files.map(file=>[file,fs.readFileSync(file)]);
    const initialReview=await callIpcRaw('projects:prepare-package-review',f.p.id);assert.ok(initialReview.token,'fixture starts with a reviewable accepted anchor');
    assert.equal(initialReview.totalFiles,1);assert.deepEqual(initialReview.files.map(file=>file.name),['Anchor.ai']);
    const assertAnchorReview=value=>{assert.equal(value.error,undefined);assert.equal(typeof value.token,'string');assert.equal(value.totalFiles,1);assert.deepEqual(value.files.map(file=>file.name),['Anchor.ai']);assert.equal(value.planSummary.reviewedSourceInputCount,1);};
    // Preparing the initial review legitimately persists source locators. Freeze
    // the cancellation control only after that setup, retaining exact equality.
    const initial=clone(backend.get('projects')),beforeBytes=fs.readFileSync(backend.path),expected=clone(initial);
    let stages=0,changedStages=0,stagedProject=null,held=false,released=false,releaseYield=()=>{},completion=null,review=null,reviewSettled=false;
    let entered;const enteredYield=new Promise(resolve=>{entered=resolve;});
    const immediate=global.setImmediate;
    const restore=metadataTestHooks.observeRecentStage((args,result)=>{stages++;if(result?.changed)changedStages++;stagedProject=args[0];});
    global.setImmediate=(callback,...args)=>{
      if(!held&&stages>0){held=true;releaseYield=()=>{if(!released){released=true;immediate(callback,...args);}};entered();return;}
      return immediate(callback,...args);
    };
    try{
      const started=Date.now();
      completion=callIpcRaw('projects:pre-package-scan',f.p.id).then(value=>({resolved:true,value}),error=>({resolved:false,message:error.message}));
      let entryTimer;try{await Promise.race([enteredYield,new Promise((_,reject)=>{entryTimer=originalSetTimeout(()=>reject(new Error('staged-prefix yield not reached')),3000);})]);}finally{originalClearTimeout(entryTimer);}
      assert.equal(stages,32,'hold the second real recent-batch yield, after a nonempty 32-row prefix');
      assert.equal(changedStages,32,'all 32 observed calls must actually change detached staging');
      assert.deepEqual(stagedProject.pendingFiles.map(file=>file.path),f.files.slice(0,32),'the real detached project must contain precisely that nonempty prefix');
      assert.equal(metadataTestHooks.isPackageScanInFlight(f.p.id),true);
      assert.deepEqual(backend.get('projects'),initial);assert.deepEqual(fs.readFileSync(backend.path),beforeBytes,'staging cannot write even an in-memory prefix to the Conf file');
      if(mode==='account'){testAccountSession.invalidate();assert.equal(testAccountSession.canUseWorkspace(),true,'generation retirement leaves fresh requests authorized');}
      if(mode==='project'){
        expected.find(p=>p.id===f.p.id).status='archived';backend.set('projects',expected);
      }
      let outcome;
      if(mode==='timeout'){
        outcome=await completion;assert.equal(outcome.resolved,true);assert.equal(outcome.value.error,'package_scan_incomplete');
        assert.equal(outcome.value.diagnostics.failurePhase,'pre-package-discovery');assert.ok(Date.now()-started>=7900);
      }
      assert.deepEqual(backend.get('projects'),expected);
      {
        const overlap=await callIpcRaw('projects:pre-package-scan',f.p.id);
        assert.equal(overlap.error,'package_scan_incomplete');assert.equal(overlap.diagnostics.failurePhase,'pre-package-scan-in-flight');
        review=callIpcRaw('projects:prepare-package-review',f.p.id).then(value=>{reviewSettled=true;return value;});
        await new Promise(r=>originalSetTimeout(r,10));assert.equal(reviewSettled,false,'review cannot pass while scan work remains held');
      }
      backend.set('syntheticUnrelatedWrite','while-retiring');
      assert.deepEqual(JSON.parse(fs.readFileSync(backend.path,'utf8')).projects,expected,'unrelated write cannot serialize the detached staged prefix');
      releaseYield();outcome??=await completion;await drain(f.p.id);
      assert.deepEqual(backend.get('projects'),expected);
      if(mode==='account')assert.deepEqual(outcome,{resolved:false,message:'Sign in to Crate to use your workspace.'});
      else if(mode==='project')assert.deepEqual(outcome,{resolved:true,value:null});
      const retiredReview=review?await review:await callIpcRaw('projects:prepare-package-review',f.p.id);
      if(mode==='timeout'){assert.equal(retiredReview.error,'package_scan_incomplete');assert.equal(retiredReview.token,undefined);}
      else assertAnchorReview(retiredReview);
      if(mode==='account')await testAccountSession.restore();
      assert.deepEqual(backend.get('projects'),expected);
      backend.set('syntheticUnrelatedWrite','after-retirement');assert.deepEqual(JSON.parse(fs.readFileSync(backend.path,'utf8')).projects,expected);
      if(mode==='project')backend.set('projects',initial);
      setChildProcessHandler(()=>({stdout:''}));
      const retry=await callIpcRaw('projects:pre-package-scan',f.p.id);assert.equal(retry.error,undefined);assert.equal(retry.newCount,0);
      const recoveredReview=await callIpcRaw('projects:prepare-package-review',f.p.id);assertAnchorReview(recoveredReview);
      assert.deepEqual(backend.get('projects'),initial);
      assert.equal((row().pendingFiles||[]).length,0);
      for(const[file,bytes]of sourceBytes)assert.deepEqual(fs.readFileSync(file),bytes);
      console.log('ACTUAL_CONF_RETIREMENT '+JSON.stringify({mode,stages,changedStages,elapsedMs:Date.now()-started,prefixPersisted:false,settlementOwned:true,subsequentWritePrefixPersisted:false,retiredReview:retiredReview.error||'token',cleanRetryReview:'token'}));
    }finally{
      releaseYield();global.setImmediate=immediate;restore();
      try{if(completion)await completion;await drain(f.p.id);if(review)await review;}
      finally{try{await testAccountSession.restore();}finally{storage.detach();clearTrackedTimers();}}
    }
  });
}
