'use strict';
// Focused production-handler controls; modeled metadata/native boundaries,
// actual detached Conf storage and unchanged production/test deadlines.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),assert=require('node:assert/strict');
const existing=fs.readFileSync(path.join(__dirname,'pre-package-recent-yield.test.js'),'utf8');
const boundary=existing.indexOf('function cases(){');
const fixtureStart=existing.indexOf('  async function fixture(count){',boundary);
const fixtureEnd=existing.indexOf('  for(const count of [4,773])',fixtureStart);
assert.ok(boundary>0&&fixtureStart>boundary&&fixtureEnd>fixtureStart,'scope-budget fixture prelude drift');
const source=existing.slice(0,boundary)+'function cases(){\n'+existing.slice(fixtureStart,fixtureEnd)+'\n('+budgetCases.toString()+')();\n}\n';
const entry=path.join(__dirname,'pre-package-recent-yield.test.js');
const compiled=new Module(entry,module);compiled.filename=entry;compiled.paths=Module._nodeModulePaths(__dirname);compiled._compile(source,entry);
function budgetCases(){
  const clone=value=>JSON.parse(JSON.stringify(value));
  async function attach(f){
    await getProject(f.p.id);
    const initial=clone(storeInstance.data),Conf=originalLoad.call(Module,'conf',module);
    const backend=new Conf({cwd:fs.mkdtempSync(path.join(TEST_HOME,'conf-scope-budget-')),projectName:'synthetic-scope-budget',watch:false});backend.store=initial;
    const methods={get:storeInstance.get,set:storeInstance.set,delete:storeInstance.delete};
    storeInstance.get=backend.get.bind(backend);storeInstance.set=backend.set.bind(backend);storeInstance.delete=backend.delete.bind(backend);
    return {backend,initial,detach(){storeInstance.data=clone(backend.store);Object.assign(storeInstance,methods);}};
  }
  for(const boundary of [0,32,64])for(const mode of ['account','status','source','output']){
    discoveryTest('scope context yield '+boundary+' fences '+mode+' and permits a clean retry',{timeout:20000},async()=>{
      const f=await fixture(70),storage=await attach(f),backend=storage.backend,initial=clone(backend.get('projects'));
      let stages=0,triggered=false;
      const restore=metadataTestHooks.observeRecentStage(()=>{stages++;});
      const immediate=global.setImmediate;
      const changedPath=boundary===0?f.files[50]:f.files[1];
      global.setImmediate=(callback,...args)=>immediate(()=>{
        if(!triggered&&stages===boundary){
          triggered=true;
          if(mode==='account')testAccountSession.invalidate();
          else if(mode==='status'){const rows=backend.get('projects');rows.find(p=>p.id===f.p.id).status='archived';backend.set('projects',rows);}
          else if(mode==='source')fs.appendFileSync(changedPath,' changed after source snapshot');
          else backend.set('quickPackageOutputPaths',[f.folder]);
        }
        callback(...args);
      });
      try{
        const completion=callIpcRaw('projects:pre-package-scan',f.p.id);let result;
        if(mode==='account')await assert.rejects(completion,{message:'Sign in to Crate to use your workspace.'});
        else result=await completion;
        assert.equal(triggered,true,'the requested real yield boundary must execute');
        const rows=backend.get('projects'),current=rows.find(p=>p.id===f.p.id);
        if(mode==='account')assert.deepEqual(rows,initial,'retired detached staging must not reach storage');
        else if(mode==='status'){
          const expected=clone(initial);expected.find(p=>p.id===f.p.id).status='archived';assert.deepEqual(rows,expected);
          assert.equal(result,null);
        }else{
          assert.equal(result.error,undefined);
          assert.equal(current.pendingFiles.length,mode==='source'?66:0,'only unchanged sources outside current generated outputs may remain pending');
          assert.equal(current.pendingFiles.some(file=>file.path===changedPath),false,'changed or excluded evidence cannot be merged from a staged prefix');
          assert.deepEqual(current.files,initial.find(p=>p.id===f.p.id).files,'the accepted source is unchanged');
        }
        assert.equal(metadataTestHooks.isPackageScanInFlight(f.p.id),false);
        global.setImmediate=immediate;restore();await testAccountSession.restore();
        backend.set('projects',initial);backend.set('quickPackageOutputPaths',[]);setChildProcessHandler(()=>({stdout:''}));
        const retry=await callIpcRaw('projects:pre-package-scan',f.p.id);
        assert.equal(retry.error,undefined);assert.equal(retry.newCount,0);
        assert.deepEqual(backend.get('projects'),initial,'a new request can retry without reviving the retired prefix');
        console.log('SCOPE_BUDGET_DIAGNOSTIC '+JSON.stringify({boundary,mode,retiredPrefixNotPublished:true,cleanRetry:true}));
      }finally{
        global.setImmediate=immediate;restore();await testAccountSession.restore();storage.detach();clearTrackedTimers();
      }
    });
  }
  discoveryTest('expired synchronous discovery refuses success before its delayed eight-second timer can fire',{timeout:18000},async()=>{
    const f=await fixture(70),storage=await attach(f),backend=storage.backend,before=clone(backend.get('projects'));
    let stages=0,blocked=false,timerDelivered=false;
    const timer=global.setTimeout;
    global.setTimeout=(callback,delay,...args)=>timer(delay===8000?(...values)=>{timerDelivered=true;callback(...values);}:callback,delay,...args);
    const restore=metadataTestHooks.observeRecentStage(()=>{
      stages++;
      if(!blocked){
        blocked=true;
        const until=process.hrtime.bigint()+8_100_000_000n;
        while(process.hrtime.bigint()<until){} // Deliberately prevent timer delivery; never change the deadline.
      }
    });
    try{
      const started=process.hrtime.bigint(),result=await callIpcRaw('projects:pre-package-scan',f.p.id),elapsedMs=Number(process.hrtime.bigint()-started)/1e6;
      assert.equal(blocked,true);assert.ok(elapsedMs>=8000);
      assert.equal(result.error,'package_scan_incomplete','elapsed work cannot return success just because its timer callback was delayed');
      assert.equal(result.diagnostics.failurePhase,'pre-package-discovery');
      assert.equal(timerDelivered,false,'explicit elapsed refusal must win before timer callback delivery');
      assert.deepEqual(backend.get('projects'),before,'an expired staged prefix cannot be admitted');
      for(let i=0;i<100&&metadataTestHooks.isPackageScanInFlight(f.p.id);i++)await new Promise(resolve=>originalSetTimeout(resolve,5));
      assert.equal(metadataTestHooks.isPackageScanInFlight(f.p.id),false);
      assert.deepEqual(backend.get('projects'),before,'settlement cannot publish late rows');
      restore();global.setTimeout=timer;setChildProcessHandler(()=>({stdout:''}));
      const retry=await callIpcRaw('projects:pre-package-scan',f.p.id);assert.equal(retry.error,undefined);assert.equal(retry.newCount,0);
      assert.deepEqual(backend.get('projects'),before);
      console.log('SCOPE_BUDGET_DIAGNOSTIC '+JSON.stringify({elapsedMs,stages,timerDelivered:false,expiredSuccessRefused:true,noLateAdmission:true,cleanRetry:true}));
    }finally{restore();global.setTimeout=timer;storage.detach();clearTrackedTimers();}
  });
}
