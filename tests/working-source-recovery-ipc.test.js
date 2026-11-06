'use strict';
// Production admission, scanning, trusted IPC and store. Native collectors and
// archive/PSD decoding are controlled boundaries; no desktop apps are launched.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const harnessPath = path.join(__dirname, 'provenance-dual-write.test.js');
let harness = fs.readFileSync(harnessPath, 'utf8');
harness = harness.replace("const test = require('node:test');", "const choiceTest = require('node:test'); const test = new Proxy(choiceTest, { apply() {} });");
harness = harness.replace("fs.mkdtempSync(path.join(os.tmpdir(), 'crate-provenance-dual-write-home-'))", "fs.mkdtempSync(path.join(path.dirname(MAIN_UNDER_TEST_ROOT), 'choice-synthetic-home-'))");
harness = harness.replace('  captureProjectOperation,\n  runScanOnOpen', '  recoverInvalidInDesignReceipt, getWorkingSourceRecoveryChoiceHolds, beginWorkingSourceScan, refreshWorkingSourceLocators, clearDocumentIdentityCache() { workingSourceDocumentIdentityCache.clear(); }, getAssetBaselineSourceRecoveryRouteKey, stageLiveObservedFile, mutateProject, pollPsForProject, readOwnerOnlyCacheFileSync, hardenOwnerOnlyCacheFileSync, ensurePresentationAssetsDir, getWorkingSourceSelection, getWorkingSourceVerification, getWorkingFileChoicePresentation, getWorkingSourceMembership,\n  captureProjectOperation,\n  runScanOnOpen');
harness = harness.replace('                  psd: fixture,', '                  psd: fixture, framing: require("../parsers/add-files-psd-worker").inspectPsdLinkFraming(fs.readFileSync(filePath)),');
harness = harness.replace('  captureProjectOperation,\n  runScanOnOpen', `
  delayInDesignPublication(filePath) {
    const original = refreshWorkingSourceLocators;
    let enter, release, held = false;
    const entered = new Promise(resolve => { enter = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    refreshWorkingSourceLocators = async (...args) => {
      if (!held && args[1]?.includes(filePath)) { held = true; enter(); await gate; }
      return original(...args);
    };
    return { entered, release, restore() { release(); refreshWorkingSourceLocators = original; } };
  },
  captureProjectOperation,
  runScanOnOpen`);
const compiled = new Module(harnessPath, module);
compiled.filename = harnessPath; compiled.paths = Module._nodeModulePaths(__dirname);
compiled._compile(harness + '\n(' + cases.toString() + ')();', harnessPath);
function cases() {
  function emptyPsdBytes() {
    // Actual bounded PSD v1 header/section framing; decoder is a test boundary.
    const bytes = Buffer.alloc(40); bytes.write('8BPS'); bytes.writeUInt16BE(1,4);
    bytes.writeUInt16BE(3,12); bytes.writeUInt32BE(1,14); bytes.writeUInt32BE(1,18);
    bytes.writeUInt16BE(8,22); bytes.writeUInt16BE(3,24); return bytes;
  }
  async function setup(ext = '.ai') {
    resetTestHomeWorkspace(); setPresentationUnzipFixture([]);
    currentPsdFixture = { children: [], linkedFiles: [] };
    const project = await createProject('Explicit source choice');
    await callIpcRaw('projects:pause', project.id); clearTrackedTimers();
    const stored = () => storeInstance.data.projects.find(item => item.id === project.id);
    const workspace = () => callIpcRaw('projects:get-asset-workspace', project.id);
    async function add(name, content = '') {
      const target = path.join(TEST_HOME, 'Desktop', name);
      fs.writeFileSync(target, name.endsWith('.psd') ? emptyPsdBytes() : '%PDF-1.7\n' + content + '\n%%EOF\n');
      manualDialogFor([target]);
      const result = await callIpcRaw('projects:add-files', project.id);
      assert.ok(getAddFilesResultFiles(result).some(row => row.path === target), JSON.stringify(result));
      return target;
    }
    async function resolve(entry, choice = 'keep-both', predecessorIdentity = null) {
      return callIpcRaw('projects:resolve-working-file-choice', project.id, { id: entry.id, revision: entry.revision, choice, predecessorIdentity });
    }
    const a = await add('A' + ext);
    assert.equal((await workspace()).workingFileChoices.choices.length, 0);
    const c = await add('C.ai');
    const initial = (await workspace()).workingFileChoices.choices[0];
    assert.ok(initial?.ready, JSON.stringify(initial));
    assert.equal((await resolve(initial)).success, true);
    return { id: project.id, ext, a, c, stored, workspace, add, resolve };
  }
  async function inDesignRecoveryFixture({ admit = true } = {}) {
    const f = await setup();
    await metadataTestHooks.waitForWatcherIdle(f.id);
    await callIpcRaw('projects:pause', f.id); clearTrackedTimers();
    const target = path.join(TEST_HOME, 'Desktop', 'Recovery.indd');
    const shared = path.join(TEST_HOME, 'Desktop', 'Required-shared.png'); fs.writeFileSync(shared, 'shared original');
    writeSyntheticAiFile(f.c, shared);
    const operation = metadataTestHooks.captureProjectOperation(f.id);
    try { await metadataTestHooks.runScanOnOpen(f.id, f.c, operation.activationToken, operation,
      { allowPausedBaseline: true, verifySelectedSource: true, establishBaseline: false }); } finally { operation.close(); }
    const state = { mode: 'open', modified: false, queryWait: null, queries: 0, inventories: 0, observer: false };
    const snapshot = () => `DOC\t${target}\tRecovery.indd\t${state.modified}\ttrue\t1\nLINK\t${target}\tRecovery.indd\t${shared}\t${state.modified}\ttrue\nEND\t1\t1\t1\t0`;
    setChildProcessHandler(request => {
      if (isIllustratorPgrepCheck(request)) return { stdout: '' };
      if (request.kind === 'execFile' && request.command === '/bin/ps') {
        state.inventories++;
        if (state.mode === 'process-failed') return { error: Object.assign(new Error('process denied'), {code:'EPERM'}) };
        if (state.mode === 'process-incomplete') return {stdout:'1 /sbin/launchd',stderr:''};
        return { stdout: '1 /sbin/launchd\n' + (state.mode === 'app-absent' ? '' : '2 /Applications/Adobe InDesign.app/Contents/MacOS/Adobe InDesign\n'), stderr: '' };
      }
      if (String(request.command).includes("grep -i 'Adobe InDesign'")) return {stdout:'Adobe InDesign'};
      if (isOsascriptInvocation(request, 'crate-indd-query.applescript')) {
        state.queries++;
        const result = () => {
          if (state.mode === 'denied') return {error:Object.assign(new Error('Not authorized (-1743) private/path'),{code:-1743})};
          if (state.mode === 'timeout') return {error:new Error('execution timeout -1712 private/path')};
          if (state.mode === 'incomplete') return {stdout:snapshot().replace(/END.*$/, '')};
          if (state.mode === 'count-mismatch') return {stdout:snapshot().replace('END\t1\t1\t1\t0','END\t2\t1\t1\t0')};
          if (state.mode === 'query-error') return {stdout:snapshot().replace('END\t1\t1\t1\t0','END\t1\t1\t1\t1')};
          if (state.mode === 'rejected-partial') return {error:Object.assign(new Error('execution failed'),{stdout:snapshot().replace(/END.*$/, '')})};
          return {stdout:state.mode === 'closed' ? 'END\t0\t0\t0\t0' : snapshot()};
        };
        return state.queryWait ? state.queryWait.promise.then(result) : result();
      }
      if (isOsascriptInvocation(request, 'crate-indd-poll.applescript')) {
        const output=state.pollOutput ?? (state.observer ? (state.pollIncomplete ? snapshot().replace(/END.*$/, '') : snapshot()) : '');
        const result=state.pollReject ? {error:Object.assign(new Error('execution failed'),{stdout:output})} : {stdout:output};
        if(state.pollQueryWait) { state.pollQueryWait.enter(); return state.pollQueryWait.promise.then(()=>result); }
        return result;
      }
      return {stdout:''};
    });
    if(admit) await f.add('Recovery.indd', shared);
    else fs.writeFileSync(target,'%PDF-1.7\n'+shared+'\n%%EOF\n');
    await metadataTestHooks.waitForWatcherIdle(f.id);
    await callIpcRaw('projects:pause', f.id); clearTrackedTimers();
    const card = async () => (await f.workspace()).workingFileChoices.choices.find(row => row.source.name === 'Recovery.indd');
    const original = [f.a, f.c, target, shared].map(p => [p, fs.readFileSync(p)]);
    return {...f,target,shared,state,card,original};
  }
  choiceTest('staged recovery advances held attempt after store reopen',async()=>{
    const f=await inDesignRecoveryFixture(),source=f.stored().files.find(row=>row.path===f.target),key=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),source);
    metadataTestHooks.mutateProject(f.id,p=>{p.workingSourceVerification[key]={status:'scanned'};return true;});roundTripFakeStore();
    f.state.mode='denied';assert.equal((await f.resolve(await f.card(),'retry')).success,false);
    const first=f.stored().workingSourceRecovery.records[key].attempt;
    assert.equal(f.stored().workingSourceRecovery.records[key].status,'held');roundTripFakeStore();
    f.state.mode='closed';assert.equal((await f.resolve(await f.card(),'retry')).success,true);
    assert.equal(Object.keys(f.stored().workingSourceRecovery.records).length,0);
    assert.notEqual(f.stored().workingSourceRecoveryHistory[0].attempt,first);
    assert.deepEqual(f.stored().workingSourceRecoveryHistory[0].original,{status:'scanned'});clearTrackedTimers();
  });
  for(const mode of ['missing-reference','unknown-domain','mixed-domain']) choiceTest(`staged recovery retains ${mode}`,async()=>{
    const f=await inDesignRecoveryFixture(),source=f.stored().files.find(row=>row.path===f.target),key=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),source);
    const raw={status:'bad',requiredReferences:[{path:path.join(TEST_HOME,'Desktop','never-present.png')}],unresolved:mode==='unknown-domain'?[{reason:'unresolved-declared-reference'}]:mode==='mixed-domain'?[{reason:'indesign-live-current-bytes-unbound'},{reason:'unresolved-declared-reference'}]:[]};
    metadataTestHooks.mutateProject(f.id,p=>{p.workingSourceVerification[key]=raw;p.workingSourceSelections={...(p.workingSourceSelections||{}),[key]:{state:'selected',reason:null,revision:1}};return true;});roundTripFakeStore();
    const before=await f.card();f.state.mode='closed';await f.resolve(before,'retry');
    assert.equal(metadataTestHooks.getWorkingSourceMembership(f.stored()).blocked,true);
    const review=await callIpcRaw('projects:prepare-package-review',f.id);assert.notEqual(review.materializable,true);
    if(mode!=='missing-reference'){assert.deepEqual(f.stored().workingSourceVerification[key],raw);assert.equal(f.stored().workingSourceRecovery,undefined);}
    else assert.ok(f.stored().workingSourceVerification[key].requiredReferences.some(r=>r.path===raw.requiredReferences[0].path));
    clearTrackedTimers();
  });
  choiceTest('staged recovery preserves newly observed dirty state',async()=>{
    const f=await inDesignRecoveryFixture(),source=f.stored().files.find(row=>row.path===f.target),key=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),source);
    metadataTestHooks.mutateProject(f.id,p=>{p.workingSourceVerification[key]={status:'scanned'};return true;});roundTripFakeStore();
    const before=await f.card();f.state.modified=true;
    const result=await f.resolve(before,'retry');assert.equal(result.success,false);
    assert.deepEqual(f.stored().workingSourceVerification[key],{status:'scanned'});
    assert.ok(f.stored().workingSourceRecovery.records[key]);
    assert.ok(f.stored().workingFileDirtyHolds?.records?.[key]);
    roundTripFakeStore();assert.equal(metadataTestHooks.getWorkingSourceMembership(f.stored()).blocked,true);clearTrackedTimers();
  });
  for(const phase of ['begin','commit']) for(const after of [false,true]) choiceTest(`recovery persistence ${phase} ${after}`,async()=>{
    const f=await inDesignRecoveryFixture(),source=f.stored().files.find(row=>row.path===f.target);
    const key=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),source);
    metadataTestHooks.mutateProject(f.id,p=>{p.workingSourceVerification[key]={status:'scanned'};return true;});roundTripFakeStore();
    const before=await f.card();f.state.mode='closed';
    const get=storeInstance.get.bind(storeInstance),set=storeInstance.set.bind(storeInstance);let injected=false;
    storeInstance.get=(k,d)=>{const value=get(k,d);return k==='projects'?structuredClone(value):value;};
    storeInstance.set=(k,v)=>{
      const p=k==='projects'&&v.find(x=>x.id===f.id);
      const match=p&&(phase==='begin'?p.workingSourceRecovery?.records?.[key]?.status==='pending':p.workingSourceRecoveryHistory?.length);
      if(match&&!injected){injected=true;if(after)set(k,v);throw Error('synthetic-store-failure');}return set(k,v);
    };
    try{const result=await f.resolve(before,'retry');assert.equal(injected,true);assert.equal(result.success,after);
      if(!after)assert.deepEqual(f.stored().workingSourceVerification[key],{status:'scanned'});
      else assert.equal(f.stored().workingSourceRecoveryHistory.length,1);
    }finally{storeInstance.get=get;storeInstance.set=set;clearTrackedTimers();}
  });
  for(const boundary of ['remove','duplicate','delete-receipt','corrupt-hold','cancel']) choiceTest(`staged recovery fencing ${boundary}`,async()=>{
    const f=await inDesignRecoveryFixture(),source=f.stored().files.find(row=>row.path===f.target);
    const key=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),source);
    metadataTestHooks.mutateProject(f.id,p=>{p.workingSourceVerification[key]={status:'scanned'};return true;});
    roundTripFakeStore();const before=await f.card(),raw=JSON.stringify(f.stored().workingSourceVerification[key]);
    f.state.mode='closed';let release;f.state.queryWait={promise:new Promise(resolve=>{release=resolve;})};
    const originalNow=testAccountSession.now,queries=f.state.queries,pending=f.resolve(before,'retry').catch(error=>({success:false,error:error.message}));
    try{
      await waitForCondition(()=>f.state.queries>queries,'staging query did not start');
      assert.equal(JSON.stringify(f.stored().workingSourceVerification[key]),raw);
      assert.equal(metadataTestHooks.getWorkingSourceMembership(f.stored()).blocked,true);
      const review=await callIpcRaw('projects:prepare-package-review',f.id);assert.notEqual(review.materializable,true);
      if(boundary==='cancel') invalidateScanAccount('clock');
      else if(boundary==='duplicate') f.stored().files.push({...source});
      else metadataTestHooks.mutateProject(f.id,p=>{
        if(boundary==='remove')p.files=p.files.filter(row=>row.path!==f.target);
        if(boundary==='duplicate')p.files.push({...source});
        if(boundary==='delete-receipt')delete p.workingSourceVerification[key];
        if(boundary==='corrupt-hold')p.workingSourceRecovery.records[key].selectionRevision=999;
        return true;
      });
      release();assert.equal((await pending).success,false);
      assert.ok(f.stored().workingSourceRecovery.records[key]);
      if(boundary!=='delete-receipt')assert.equal(JSON.stringify(f.stored().workingSourceVerification[key]),raw);
    }finally{release();await pending;testAccountSession.now=originalNow;await testAccountSession.restore();clearTrackedTimers();}
  });
  for (const existing of [false,true]) for (const kind of ['pending-reference','pending-unresolved','pending-output','pending-empty','unknown-field','future-version','nested-reference','unknown-domain']) choiceTest(`unsupported evidence ${kind} existing=${existing} preserves owner exit or prior hold without scanning`,async()=>{
    const f=await inDesignRecoveryFixture(),source=f.stored().files.find(row=>row.path===f.target),key=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),source);
    const raw={status:'bad',requiredReferences:[],unresolved:[]};
    if(kind.startsWith('pending-'))raw.pendingReviewFacts=kind==='pending-reference'?{requiredReferences:[{path:path.join(TEST_HOME,'missing.png')}]}:kind==='pending-unresolved'?{unresolved:[{reason:'unknown'}]}:kind==='pending-output'?{requiredEmbeddedOutputs:[{path:path.join(TEST_HOME,'output.png')}]}:{};
    if(kind==='unknown-field')raw.futureObligations=[{path:f.shared}];
    if(kind==='future-version')raw.version=2;
    if(kind==='nested-reference')raw.requiredReferences=[{path:f.shared,extra:'proof'}];
    if(kind==='unknown-domain')raw.unresolved=[{reason:'unresolved-declared-reference'}];
    if(existing){
      // A prior-version hold is modeled with the same schema/hash/identity as
      // a real failed supported transaction, retaining unsupported evidence.
      metadataTestHooks.mutateProject(f.id,p=>{p.workingSourceVerification[key]={status:'bad'};return true;});f.state.mode='denied';
      assert.equal((await f.resolve(await f.card(),'retry')).success,false);
      metadataTestHooks.mutateProject(f.id,p=>{const hold=p.workingSourceRecovery.records[key];hold.original=structuredClone(raw);hold.originalHash=require('node:crypto').createHash('sha256').update(JSON.stringify(raw)).digest('hex');return true;});
    }
    metadataTestHooks.mutateProject(f.id,p=>{p.workingSourceVerification[key]=raw;return true;});f.state.mode='closed';
    const queries=f.state.queries,inventories=f.state.inventories,prior=structuredClone(f.stored().workingSourceRecovery);
    for(let i=0;i<2;i++){
      const card=await f.card();assert.equal(card.reason,existing?'working-source-recovery-unsupported':'working-source-evidence-retained');
      const result=await f.resolve(card,'retry');assert.equal(result.error,'working_source_recovery_unsupported');
      assert.equal(f.state.queries,queries);assert.equal(f.state.inventories,inventories);
      assert.deepEqual(f.stored().workingSourceVerification[key],raw);assert.deepEqual(f.stored().workingSourceRecovery,prior);
      if(existing)assert.equal(metadataTestHooks.getWorkingSourceMembership(f.stored()).blocked,true);
      assert.notEqual((await callIpcRaw('projects:prepare-package-review',f.id)).materializable,true);roundTripFakeStore();
    }
    const excluded=await ownerSelection(f,'Recovery.indd','exclude');assert.equal(excluded.success,!existing,JSON.stringify(excluded));
    assert.deepEqual(f.stored().workingSourceVerification[key],raw);assert.deepEqual(f.stored().workingSourceRecovery,prior);
    if(!existing){
      assert.equal((await callIpcRaw('projects:prepare-package-review',f.id)).materializable,true);
      assert.equal((await ownerSelection(f,'Recovery.indd','restore')).success,true);
      assert.notEqual((await callIpcRaw('projects:prepare-package-review',f.id)).materializable,true);
      assert.deepEqual(f.stored().workingSourceVerification[key],raw);assert.equal(f.stored().workingSourceRecovery,undefined);
    }
    clearTrackedTimers();
  });
  for(const mutation of ['identity','selection'])choiceTest(`reconstructed held Retry refuses ${mutation} rebind`,async()=>{
    const f=await inDesignRecoveryFixture(),source=f.stored().files.find(row=>row.path===f.target),key=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),source);
    const raw={status:'bad',requiredReferences:[{path:f.shared}],unresolved:[]};metadataTestHooks.mutateProject(f.id,p=>{p.workingSourceVerification[key]=raw;return true;});
    assert.equal((await f.resolve(await f.card(),'retry')).success,false);const hold=structuredClone(f.stored().workingSourceRecovery);
    if(mutation==='identity'){const b=fs.readFileSync(f.target);fs.renameSync(f.target,f.target+'.old');fs.writeFileSync(f.target,b);}
    else metadataTestHooks.mutateProject(f.id,p=>{p.workingSourceRecovery.records[key].selectionRevision+=1;return true;});
    const before=structuredClone(f.stored().workingSourceRecovery);f.state.mode='closed';assert.equal((await f.resolve(await f.card(),'retry')).success,false);
    assert.deepEqual(f.stored().workingSourceRecovery,before);assert.deepEqual(f.stored().workingSourceVerification[key],raw);clearTrackedTimers();
  });
  for(const mutation of ['dependency','identity','delete-guard','delete-key'])choiceTest(`reconstructed committed guard blocks ${mutation}`,async()=>{
    const f=await inDesignRecoveryFixture(),source=f.stored().files.find(row=>row.path===f.target),key=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),source);
    metadataTestHooks.mutateProject(f.id,p=>{p.workingSourceVerification[key]={status:'bad',requiredReferences:[{path:f.shared}],unresolved:[]};return true;});f.state.mode='closed';
    assert.equal((await f.resolve(await f.card(),'retry')).success,true);assert.equal((await f.resolve(await f.card(),'keep-both')).success,true);
    const before=await callIpcRaw('projects:prepare-package-review',f.id);assert.equal(before.materializable,true,JSON.stringify(before));assert.ok(before.token);
    if(mutation==='dependency')fs.unlinkSync(f.shared);
    if(mutation==='identity'){const b=fs.readFileSync(f.target);fs.renameSync(f.target,f.target+'.old');fs.writeFileSync(f.target,b);}
    if(mutation==='delete-guard')metadataTestHooks.mutateProject(f.id,p=>{delete p.workingSourceRecoveryGuards;return true;});
    if(mutation==='delete-key')metadataTestHooks.mutateProject(f.id,p=>{p.workingSourceRecoveryGuards.sourceKeys=[];return true;});
    roundTripFakeStore();assert.equal(metadataTestHooks.getWorkingSourceMembership(f.stored()).blocked,true);
    assert.notEqual((await callIpcRaw('projects:prepare-package-review',f.id)).materializable,true);clearTrackedTimers();
  });
  for(const choice of ['keep-both','replace'])choiceTest(`reconstructed unrelated ${choice} during attributed hold`,async()=>{
    const f=await inDesignRecoveryFixture();const other=await f.add('Other.ai');
    const source=f.stored().files.find(row=>row.path===f.target),key=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),source);
    metadataTestHooks.mutateProject(f.id,p=>{p.workingSourceVerification[key]={status:'bad',requiredReferences:[],unresolved:[]};return true;});f.state.mode='denied';
    assert.equal((await f.resolve(await f.card(),'retry')).success,false);roundTripFakeStore();
    const card=(await f.workspace()).workingFileChoices.choices.find(row=>row.source.name==='Other.ai');assert.equal(card.ready,true);assert.equal(card.replaceBlocked,true);
    const raw=structuredClone(f.stored().workingSourceVerification[key]);
    const result=await f.resolve(card,choice,choice==='replace'?card.predecessors[0].visualIdentity:null);
    assert.equal(result.success,choice==='keep-both');assert.deepEqual(f.stored().workingSourceVerification[key],raw);
    assert.equal(metadataTestHooks.getWorkingSourceMembership(f.stored()).blocked,true);clearTrackedTimers();
  });
  for(const change of ['identity','selection','dependency'])choiceTest(`reconstructed committed review token invalidated by ${change}`,async()=>{
    const f=await inDesignRecoveryFixture(),source=f.stored().files.find(row=>row.path===f.target),key=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),source);
    metadataTestHooks.mutateProject(f.id,p=>{p.workingSourceVerification[key]={status:'bad',requiredReferences:[{path:f.shared}],unresolved:[]};return true;});f.state.mode='closed';
    assert.equal((await f.resolve(await f.card(),'retry')).success,true);assert.equal((await f.resolve(await f.card(),'keep-both')).success,true);
    const review=await callIpcRaw('projects:prepare-package-review',f.id);assert.equal(review.materializable,true);assert.ok(review.token);
    if(change==='identity'){fs.renameSync(f.target,f.target+'.old');fs.copyFileSync(f.target+'.old',f.target);}
    if(change==='dependency')fs.unlinkSync(f.shared);
    if(change==='selection')metadataTestHooks.mutateProject(f.id,p=>{p.workingSourceSelections={...(p.workingSourceSelections||{}),[key]:{state:'selected',revision:999}};return true;});
    assert.notEqual((await callIpcRaw('projects:prepare-package-review',f.id)).materializable,true);
    // The registered materialization handler must independently reject its old review.
    const result=await callIpcRaw('projects:package',f.id,TEST_HOME,review.token);assert.equal(result.error,'package_review_stale');clearTrackedTimers();
  });
  for(const change of ['omit-root','duplicate-root','delete-root','invalid-intermediate','duplicate-intermediate'])choiceTest(`reconstructed per-source closure ${change} refuses packaging`,async()=>{
    const f=await inDesignRecoveryFixture(),source=f.stored().files.find(row=>row.path===f.target),key=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),source);
    let intermediate=null;if(change.includes('intermediate')){const target=await f.add('Intermediate.ai');intermediate=f.stored().files.find(row=>row.path===target);}
    metadataTestHooks.mutateProject(f.id,p=>{p.workingSourceVerification[key]={status:'bad',requiredReferences:[{path:intermediate?.path||f.shared}],unresolved:[]};return true;});f.state.mode='closed';
    assert.equal((await f.resolve(await f.card(),'retry')).success,true);
    if(change==='omit-root')assert.equal(metadataTestHooks.getWorkingSourceMembership(f.stored(),f.stored().files.filter(row=>row.path!==f.target)).blocked,true);
    else {
      metadataTestHooks.mutateProject(f.id,p=>{
        if(change==='delete-root')p.files=p.files.filter(row=>row.path!==f.target);
        if(change==='duplicate-root')p.files.push({...source,id:'duplicate-root'});
        if(change==='duplicate-intermediate')p.files.push({...intermediate,id:'duplicate-intermediate'});
        if(change==='invalid-intermediate')p.workingSourceVerification[metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(p,intermediate)]={status:'bad',requiredReferences:[{path:path.join(TEST_HOME,'missing-transitive.png')}]};return true;
      });
      if(change==='duplicate-root')f.stored().files.push({...source,id:'raw-duplicate-root'});
      if(change==='duplicate-intermediate')f.stored().files.push({...intermediate,id:'raw-duplicate-intermediate'});
      assert.equal(metadataTestHooks.getWorkingSourceMembership(f.stored()).blocked,true);
    }
    clearTrackedTimers();
  });
  for(const related of [false,true]) for(const outputMode of ['ordinary','valid','missing','mismatch']) choiceTest(`independent PSD matrix related=${related} output=${outputMode}`,async()=>{
    const f=await inDesignRecoveryFixture(), source=f.stored().files.find(row=>row.path===f.target),key=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),source);
    const target=path.join(TEST_HOME,'Desktop','Legacy.psd');fs.writeFileSync(target,emptyPsdBytes());
    const psd={fileId:'legacy-psd',path:target,name:'Legacy.psd',ext:'.psd',projectRole:'source',source:'user-added',addedAt:Date.now()};
    const psdKey=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),psd),stat=fs.statSync(target);
    const receipt={version:1,status:'scanned',attempt:'legacy',selectionRevision:0,provider:'psd-ordinary',coverage:'ordinary-route',sourceIdentity:{dev:stat.dev,ino:stat.ino,size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs},sourceFingerprint:crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'),requiredReferences:[],unresolved:[]};
    let output;
    if(outputMode!=='ordinary'){
      const outputPath=path.join(TEST_HOME,'Desktop','Embedded.png');
      if(outputMode!=='missing'){fs.writeFileSync(outputPath,outputMode==='mismatch'?'changed bytes':'expected bytes');output={fileId:'output',path:outputPath,name:'Embedded.png',ext:'.png',projectRole:'asset',source:'user-added',addedAt:Date.now()};}
      receipt.provider='psd-agpsd-worker';receipt.requiredEmbeddedOutputs=[{path:outputPath,sourceDigest:receipt.sourceFingerprint,outputDigest:crypto.createHash('sha256').update('expected bytes').digest('hex')}];
    }
    metadataTestHooks.mutateProject(f.id,p=>{p.files.push(psd);if(output)p.files.push(output);p.workingSourceVerification[psdKey]=receipt;p.workingSourceVerification[key]={status:'bad',requiredReferences:related?[{path:target}]:[]};return true;});roundTripFakeStore();
    f.state.mode='closed';assert.equal((await f.resolve(await f.card(),'retry')).success,true);
    assert.equal(f.stored().workingSourceSelections,undefined);
    assert.equal((await f.resolve(await f.card(),'keep-both')).success,true);
    const review=await callIpcRaw('projects:prepare-package-review',f.id);
    console.log('INDEPENDENT_PSD_RESULT',JSON.stringify({related,outputMode,materializable:review.materializable,expected:!related||outputMode==='valid'}));
    assert.equal(review.materializable,!related || outputMode==='valid');clearTrackedTimers();
  });
  for(const malformed of ['null-identity','invalid-revision'])choiceTest(`malformed recovery attribution ${malformed} cannot unlock unrelated choices`,async()=>{
    const f=await inDesignRecoveryFixture();await f.add('Other.ai');
    const source=f.stored().files.find(row=>row.path===f.target),key=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),source);
    metadataTestHooks.mutateProject(f.id,p=>{p.workingSourceVerification[key]={status:'bad',requiredReferences:[],unresolved:[]};return true;});f.state.mode='denied';
    assert.equal((await f.resolve(await f.card(),'retry')).success,false);
    assert.equal((await f.workspace()).workingFileChoices.choices.find(row=>row.source.name==='Other.ai').ready,true);
    metadataTestHooks.mutateProject(f.id,p=>{if(malformed==='null-identity')p.workingSourceRecovery.records[key].identity=null;else p.workingSourceRecovery.records[key].selectionRevision=-1;return true;});
    if(malformed==='null-identity')fs.unlinkSync(f.target);
    roundTripFakeStore();
    assert.equal((await f.workspace()).workingFileChoices.choices.find(row=>row.source.name==='Other.ai').ready,false);
    assert.equal(metadataTestHooks.getWorkingSourceMembership(f.stored()).blocked,true);clearTrackedTimers();
  });

  async function ownerSelection(f, name, action) {
    const row=(await f.workspace()).files.find(row=>row.name===name); assert.ok(row,name);
    return callIpcRaw('projects:set-working-source-selection',f.id,row.visualIdentity,{action,expectedRevision:row.selectionRevision});
  }
  for(const mismatch of ['identity','selection','receipt','missing-receipt','missing-row','duplicate-row'])choiceTest(`round2 attributed ${mismatch} isolates unrelated choice and fences writers`,async()=>{
    const f=await inDesignRecoveryFixture();await f.add('Other.ai');
    const source=f.stored().files.find(row=>row.path===f.target),key=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),source);
    metadataTestHooks.mutateProject(f.id,p=>{p.workingSourceVerification[key]={status:'bad',requiredReferences:[],unresolved:[]};return true;});f.state.mode='denied';
    assert.equal((await f.resolve(await f.card(),'retry')).success,false);
    const hold=structuredClone(f.stored().workingSourceRecovery);
    if(mismatch==='identity'){fs.renameSync(f.target,f.target+'.old');fs.copyFileSync(f.target+'.old',f.target);}
    metadataTestHooks.mutateProject(f.id,p=>{
      if(mismatch==='selection')p.workingSourceSelections={...(p.workingSourceSelections||{}),[key]:{state:'selected',reason:null,revision:7}};
      if(mismatch==='receipt')p.workingSourceVerification[key]={status:'bad',unresolved:[]};
      if(mismatch==='missing-receipt')delete p.workingSourceVerification[key];
      if(mismatch==='missing-row')p.files=p.files.filter(row=>row.path!==f.target);
      if(mismatch==='duplicate-row')p.files.push({...source,fileId:'duplicate'});
      return true;
    });roundTripFakeStore();
    const before=JSON.stringify(f.stored().workingSourceVerification);
    assert.ok(metadataTestHooks.getWorkingSourceRecoveryChoiceHolds(f.stored()).has(key));
    const other=(await f.workspace()).workingFileChoices.choices.find(row=>row.source.name==='Other.ai');
    if(mismatch!=='missing-row')assert.equal(other.ready,true); // Existing choice ledger separately refuses a removed admitted member.
    const card=await f.card();
    if(mismatch==='duplicate-row'){
      // Normal mutateProject deduplicates rows. Inject at the reservation seam
      // to exercise a genuine duplicate, rather than claiming that fixture did.
      f.stored().files.push({...source,fileId:'duplicate-reservation'});
      assert.equal(f.stored().files.filter(row=>row.path===f.target).length,2);
      const op=metadataTestHooks.captureProjectOperation(f.id);
      try{assert.equal((await metadataTestHooks.recoverInvalidInDesignReceipt(f.id,source,op)).success,false);}finally{op.close();}
    }else if(card)assert.equal((await f.resolve(card,'retry')).success,false);
    assert.equal(metadataTestHooks.beginWorkingSourceScan(f.id,f.target,()=>true),null);
    assert.equal(JSON.stringify(f.stored().workingSourceVerification),before);
    assert.deepEqual(f.stored().workingSourceRecovery,hold);
    assert.equal(metadataTestHooks.getWorkingSourceMembership(f.stored()).blocked,true);
    assert.notEqual((await callIpcRaw('projects:prepare-package-review',f.id)).materializable,true);clearTrackedTimers();
  });
  for(const kind of ['opaque','null','false','revision'])for(const required of [false,true])choiceTest(`round2 ${kind} non-InDesign selection preserves evidence required=${required}`,async()=>{
    const f=await setup();await metadataTestHooks.waitForWatcherIdle(f.id);await callIpcRaw('projects:pause',f.id);clearTrackedTimers();
    if(required){writeSyntheticAiFile(f.c,f.a);const op=metadataTestHooks.captureProjectOperation(f.id);try{await metadataTestHooks.runScanOnOpen(f.id,f.c,op.activationToken,op,{allowPausedBaseline:true,verifySelectedSource:true,establishBaseline:false});}finally{op.close();}}
    const row=f.stored().files.find(row=>row.path===f.a),key=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),row);
    const original=kind==='revision'?{...structuredClone(f.stored().workingSourceVerification[key]),selectionRevision:2}:kind==='null'?null:kind==='false'?false:{status:'bad',selectionRevision:2,requiredReferences:[{path:path.join(TEST_HOME,'Desktop','missing-obligation.png')}],unresolved:[{reason:'unknown-producer-obligation'}]};
    metadataTestHooks.mutateProject(f.id,p=>{p.workingSourceVerification[key]=original;p.workingSourceSelections={...(p.workingSourceSelections||{}),[key]:{state:'selected',reason:null,revision:1}};return true;});
    assert.equal(metadataTestHooks.getWorkingSourceMembership(f.stored()).blocked,true);
    assert.equal((await ownerSelection(f,'A.ai','exclude')).success,true);
    assert.deepEqual(f.stored().workingSourceVerification[key],original);assert.equal(metadataTestHooks.getWorkingSourceVerification(f.stored(),row),null);
    const excluded=await callIpcRaw('projects:prepare-package-review',f.id);assert.equal(excluded.materializable,!required,JSON.stringify(excluded));
    roundTripFakeStore();assert.deepEqual(f.stored().workingSourceVerification[key],original);
    assert.equal((await ownerSelection(f,'A.ai','restore')).success,true);
    assert.deepEqual(f.stored().workingSourceVerification[key],original);
    assert.equal(metadataTestHooks.getWorkingSourceMembership(f.stored()).blocked,true);
    assert.notEqual((await callIpcRaw('projects:prepare-package-review',f.id)).materializable,true);
    if(excluded.token)assert.equal((await callIpcRaw('projects:package',f.id,TEST_HOME,excluded.token)).error,'package_review_stale');
    for(let i=0;i<2;i++){
      roundTripFakeStore();assert.equal((await ownerSelection(f,'A.ai','exclude')).success,true);
      assert.deepEqual(f.stored().workingSourceVerification[key],original);assert.equal(metadataTestHooks.getWorkingSourceVerification(f.stored(),row),null);
      assert.equal((await ownerSelection(f,'A.ai','restore')).success,true);
      assert.deepEqual(f.stored().workingSourceVerification[key],original);assert.equal(metadataTestHooks.getWorkingSourceVerification(f.stored(),row),null);
      assert.equal(metadataTestHooks.getWorkingSourceMembership(f.stored()).blocked,true);
    }
    clearTrackedTimers();
  });
  choiceTest('round2 committed guard locator does not orphan retained evidence',async()=>{
    const f=await inDesignRecoveryFixture(),source=f.stored().files.find(row=>row.path===f.target),key=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),source);
    metadataTestHooks.mutateProject(f.id,p=>{p.workingSourceVerification[key]={status:'bad',requiredReferences:[{path:f.shared}],unresolved:[]};return true;});f.state.mode='closed';
    assert.equal((await f.resolve(await f.card(),'retry')).success,true);assert.equal((await f.resolve(await f.card(),'keep-both')).success,true);
    await metadataTestHooks.refreshWorkingSourceLocators(f.id,[f.target]);
    const before=structuredClone(f.stored());const destination=f.target.replace('.indd','-moved.indd');fs.renameSync(f.target,destination);
    metadataTestHooks.clearDocumentIdentityCache();await metadataTestHooks.refreshWorkingSourceLocators(f.id,[destination]);
    assert.ok(f.stored().files.some(row=>row.path===f.target));assert.ok(!f.stored().files.some(row=>row.path===destination));
    assert.deepEqual(f.stored().workingSourceRecoveryGuards,before.workingSourceRecoveryGuards);assert.deepEqual(f.stored().workingSourceRecoveryHistory,before.workingSourceRecoveryHistory);
    assert.notEqual((await callIpcRaw('projects:prepare-package-review',f.id)).materializable,true);clearTrackedTimers();
  });

}
