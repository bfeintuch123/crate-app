'use strict';
// Production admission, scanning, trusted IPC and store. Native collectors and
// archive/PSD decoding are controlled boundaries; no desktop apps are launched.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const harnessPath = path.join(__dirname, 'provenance-dual-write.test.js');
let harness = fs.readFileSync(harnessPath, 'utf8');
harness = harness.replace("const test = require('node:test');", "const choiceTest = require('node:test'); const test = new Proxy(choiceTest, { apply() {} });");
harness = harness.replace("fs.mkdtempSync(path.join(os.tmpdir(), 'crate-provenance-dual-write-home-'))", "fs.mkdtempSync(path.join(path.dirname(MAIN_UNDER_TEST_ROOT), 'choice-synthetic-home-'))");
harness = harness.replace('  captureProjectOperation,\n  runScanOnOpen', '  refreshWorkingSourceLocators, clearDocumentIdentityCache() { workingSourceDocumentIdentityCache.clear(); }, getAssetBaselineSourceRecoveryRouteKey, stageLiveObservedFile, mutateProject, pollPsForProject, readOwnerOnlyCacheFileSync, hardenOwnerOnlyCacheFileSync, ensurePresentationAssetsDir, getWorkingSourceSelection, getWorkingSourceVerification, getWorkingFileChoicePresentation, getWorkingSourceMembership,\n  captureProjectOperation,\n  runScanOnOpen');
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
  for (const mode of ['closed','app-absent']) choiceTest(`InDesign Retry verifies ${mode} saved bytes and preserves choices/shared assets`, async () => {
    const f = await inDesignRecoveryFixture();
    const before = await f.card(); assert.equal(before.reason, 'indesign-live-unbound'); assert.equal(before.ready,false);
    assert.equal((await f.resolve(before,'retry')).success,false,'open clean never binds live inventory');
    f.state.mode = mode;
    const counts = {...f.state};
    assert.equal((await f.resolve(await f.card(),'retry')).success,true);
    assert.equal(f.state.inventories,counts.inventories+1);
    assert.equal(f.state.queries,counts.queries+(mode==='closed'?1:0));
    assert.equal((await f.card()).ready,true);
    assert.equal((await callIpcRaw('projects:prepare-package-review',f.id)).error,'working_file_choice_required');
    assert.equal((await f.resolve(before,'keep-both')).success,false,'stale unbound token remains invalid');
    const ready=await f.card();
    assert.equal((await f.resolve(ready,'replace',ready.predecessors.find(row=>row.name==='A.ai').visualIdentity)).success,true);
    const ws=await f.workspace();
    assert.equal(ws.files.find(row=>row.name==='A.ai').sourceSelection,'excluded');
    assert.equal(ws.files.find(row=>row.name==='C.ai').sourceSelection,'selected');
    assert.equal(ws.workingSourceDisplayOrder[0],ws.files.find(row=>row.name==='Recovery.indd').visualIdentity);
    assert.ok(ws.files.some(row=>row.name==='Required-shared.png'));
    const source=f.stored().files.find(row=>row.path===f.target);
    assert.ok(metadataTestHooks.getWorkingSourceVerification(f.stored(),source).requiredReferences.some(ref=>ref.path===f.shared));
    for(const [p,bytes] of f.original) assert.deepEqual(fs.readFileSync(p),bytes);
  });
  for (const mode of ['denied','timeout','incomplete','count-mismatch','query-error','process-failed','process-incomplete','missing-link']) {
    choiceTest(`InDesign Retry refuses ${mode} with a sanitized reason`, async () => {
      const f=await inDesignRecoveryFixture(); f.state.mode=mode==='missing-link'?'closed':mode;
      if(mode==='missing-link') fs.unlinkSync(f.shared);
      const choice=await f.card();
      assert.equal((await f.resolve(choice,'retry')).success,false);
      const after=await f.card(); assert.equal(after.ready,false);
      assert.equal(after.reason,mode==='denied'?'indesign-access-denied':mode==='missing-link'?'indesign-saved-file-unverified':'indesign-query-failed');
      assert.equal(JSON.stringify(after).includes('private/path'),false);
      assert.equal((await f.resolve(after,'keep-both')).success,false);
      assert.equal((await callIpcRaw('projects:prepare-package-review',f.id)).error,'working_file_choice_required');
      assert.ok((await f.workspace()).files.filter(row=>['A.ai','C.ai','Recovery.indd'].includes(row.name)).every(row=>row.sourceSelection==='selected'));
    });
  }
  choiceTest('InDesign dirty query holds survive closing early; trusted clean poll permits later closed-file Retry', async () => {
    const f=await inDesignRecoveryFixture(); f.state.modified=true;
    assert.equal((await f.resolve(await f.card(),'retry')).success,false);
    assert.equal((await f.card()).reason,'indesign-save-required');
    f.state.mode='closed';
    const inventories=f.state.inventories;
    assert.equal((await f.resolve(await f.card(),'retry')).error,'working_file_saved_observation_required');
    assert.equal(f.state.inventories,inventories,'closing early cannot bypass dirty hold');
    f.state.mode='open'; f.state.observer=true; f.state.modified='unknown';
    await callIpcRaw('projects:start-watching',f.id); await metadataTestHooks.waitForWatcherIdle(f.id); clearTrackedTimers();
    assert.equal((await f.card()).reason,'indesign-save-required','failed modified read cannot clear hold');
    f.state.modified=false;
    await metadataTestHooks.pollPsForProject(f.id,metadataTestHooks.getActiveWatchingActivationToken(f.id)); clearTrackedTimers();
    assert.notEqual((await f.card()).reason,'indesign-save-required');
    assert.equal((await f.card()).ready,false,'clean observation is not saved-byte binding');
    await callIpcRaw('projects:pause',f.id); f.state.mode='closed';
    assert.equal((await f.resolve(await f.card(),'retry')).success,true);
  });
  choiceTest('InDesign Retry serializes repeated clicks and refuses dirty evidence arriving during its query', async () => {
    const f=await inDesignRecoveryFixture(); f.state.mode='closed';
    let release; const gate={promise:new Promise(resolve=>{release=resolve;}),release:()=>release()}; f.state.queryWait=gate;
    const entry=await f.card(),queries=f.state.queries;
    const pending=f.resolve(entry,'retry');
    await waitForCondition(()=>f.state.queries>queries,'retry query not entered');
    assert.equal((await f.resolve(entry,'retry')).error,'working_file_choice_busy');
    const source=f.stored().files.find(row=>row.path===f.target);
    metadataTestHooks.mutateProject(f.id,project=>metadataTestHooks.stageLiveObservedFile(project,source,{liveEvidence:{
      source:'app-opened',appFamily:'indesign',observerMethod:'indesign-live-applescript',
      evidenceStrength:'structured-app-document',sourceDocumentPath:f.target,documentModified:true}}));
    gate.release(); assert.equal((await pending).success,false);
    assert.equal((await f.card()).reason,'indesign-save-required');
    assert.equal((await callIpcRaw('projects:prepare-package-review',f.id)).error,'working_file_choice_required');
  });

  for (const mode of ['incomplete','count-mismatch','query-error','rejected-partial']) {
    for (const modified of [true,'unknown']) choiceTest(`InDesign correction retains ${modified} obligation after ${mode} then close`, async () => {
      const f=await inDesignRecoveryFixture(); f.state.mode=mode; f.state.modified=modified;
      assert.equal((await f.resolve(await f.card(),'retry')).success,false);
      assert.equal((await f.card()).reason,'indesign-save-required');
      roundTripFakeStore();
      f.state.mode='closed'; const inventories=f.state.inventories;
      assert.equal((await f.resolve(await f.card(),'retry')).error,'working_file_saved_observation_required');
      assert.equal(f.state.inventories,inventories);
      assert.equal((await callIpcRaw('projects:prepare-package-review',f.id)).error,'working_file_choice_required');
      for(const [p,bytes] of f.original) assert.deepEqual(fs.readFileSync(p),bytes);
    });
  }
  choiceTest('InDesign correction incomplete clean poll cannot discharge a retained obligation', async () => {
    const f=await inDesignRecoveryFixture(); f.state.modified=true;
    assert.equal((await f.resolve(await f.card(),'retry')).success,false);
    f.state.modified=false; f.state.observer=true; f.state.pollIncomplete=true;
    await callIpcRaw('projects:start-watching',f.id); await metadataTestHooks.waitForWatcherIdle(f.id); clearTrackedTimers();
    await metadataTestHooks.pollPsForProject(f.id,metadataTestHooks.getActiveWatchingActivationToken(f.id)); clearTrackedTimers();
    assert.equal((await f.card()).reason,'indesign-save-required');
    f.state.pollIncomplete=false;
    await metadataTestHooks.pollPsForProject(f.id,metadataTestHooks.getActiveWatchingActivationToken(f.id)); clearTrackedTimers();
    assert.notEqual((await f.card()).reason,'indesign-save-required');
    assert.equal((await f.card()).ready,false);
  });
  choiceTest('InDesign correction delayed older clean publication cannot clear a newer dirty Retry hold', async () => {
    const f=await inDesignRecoveryFixture();
    await callIpcRaw('projects:start-watching',f.id); await metadataTestHooks.waitForWatcherIdle(f.id); clearTrackedTimers();
    f.state.observer=true;
    const gate=metadataTestHooks.delayInDesignPublication(f.target);
    const pending=metadataTestHooks.pollPsForProject(f.id,metadataTestHooks.getActiveWatchingActivationToken(f.id));
    try {
      await gate.entered;
      f.state.modified=true;
      assert.equal((await f.resolve(await f.card(),'retry')).success,false);
      assert.equal((await f.card()).reason,'indesign-save-required');
      gate.release(); await pending; clearTrackedTimers();
      assert.equal((await f.card()).reason,'indesign-save-required');
      f.state.mode='closed';
      assert.equal((await f.resolve(await f.card(),'retry')).error,'working_file_saved_observation_required');
      f.state.mode='open'; f.state.modified=false;
      await metadataTestHooks.pollPsForProject(f.id,metadataTestHooks.getActiveWatchingActivationToken(f.id)); clearTrackedTimers();
      assert.notEqual((await f.card()).reason,'indesign-save-required');
      assert.equal((await f.card()).ready,false);
      await callIpcRaw('projects:pause',f.id); f.state.mode='closed';
      assert.equal((await f.resolve(await f.card(),'retry')).success,true);
      assert.equal((await callIpcRaw('projects:prepare-package-review',f.id)).error,'working_file_choice_required');
      for(const [p,bytes] of f.original) assert.deepEqual(fs.readFileSync(p),bytes);
    } finally { gate.release(); await pending; gate.restore(); clearTrackedTimers(); }
  });
  choiceTest('InDesign correction query order precedes delayed native result delivery', async () => {
    const f=await inDesignRecoveryFixture();
    await callIpcRaw('projects:start-watching',f.id); await metadataTestHooks.waitForWatcherIdle(f.id); clearTrackedTimers();
    f.state.observer=true;
    let enter,release;
    const entered=new Promise(resolve=>{enter=resolve;});
    f.state.pollQueryWait={enter,promise:new Promise(resolve=>{release=resolve;})};
    const pending=metadataTestHooks.pollPsForProject(f.id,metadataTestHooks.getActiveWatchingActivationToken(f.id));
    try {
      await entered;
      f.state.modified=true;
      assert.equal((await f.resolve(await f.card(),'retry')).success,false);
      release(); await pending; clearTrackedTimers();
      assert.equal((await f.card()).reason,'indesign-save-required');
      f.state.mode='closed';
      assert.equal((await f.resolve(await f.card(),'retry')).error,'working_file_saved_observation_required');
    } finally { release(); await pending; f.state.pollQueryWait=null; clearTrackedTimers(); }
  });
  for(const boundary of ['poll-publication','retry-query']) choiceTest(`InDesign correction dirty ${boundary} retains the observed physical source across replacement`, async () => {
    const f=await inDesignRecoveryFixture();
    await callIpcRaw('projects:start-watching',f.id); await metadataTestHooks.waitForWatcherIdle(f.id); clearTrackedTimers();
    f.state.observer=true; f.state.modified=true;
    let pending,release,restore=()=>{};
    if(boundary==='poll-publication') {
      const gate=metadataTestHooks.delayInDesignPublication(f.target); release=gate.release; restore=gate.restore;
      pending=metadataTestHooks.pollPsForProject(f.id,metadataTestHooks.getActiveWatchingActivationToken(f.id));
      await gate.entered;
    } else {
      f.state.queryWait={promise:new Promise(resolve=>{release=resolve;})};
      const queries=f.state.queries;
      pending=f.resolve(await f.card(),'retry');
      await waitForCondition(()=>f.state.queries>queries,'dirty retry did not enter native collection');
    }
    try {
      const oldBytes=fs.readFileSync(f.target);
      fs.renameSync(f.target,f.target+'.observed-original'); fs.writeFileSync(f.target,oldBytes);
      release(); await pending; clearTrackedTimers();
      f.state.queryWait=null;
      assert.equal((await f.card()).reason,'indesign-save-required');
      f.state.modified=false;
      await metadataTestHooks.pollPsForProject(f.id,metadataTestHooks.getActiveWatchingActivationToken(f.id)); clearTrackedTimers();
      assert.equal((await f.card()).reason,'indesign-save-required','clean replacement cannot discharge the original physical source');
      await callIpcRaw('projects:pause',f.id); f.state.mode='closed';
      assert.equal((await f.resolve(await f.card(),'retry')).error,'working_file_saved_observation_required');
      assert.deepEqual(fs.readFileSync(f.target+'.observed-original'),oldBytes);
    } finally { release(); await pending; restore(); f.state.queryWait=null; clearTrackedTimers(); }
  });
  choiceTest('InDesign correction newly discovered dirty source retains unresolved identity through later clean', async () => {
    const f=await inDesignRecoveryFixture({admit:false});
    const project=await createProject('New InDesign source');
    await metadataTestHooks.waitForWatcherIdle(project.id); clearTrackedTimers();
    const stored=()=>storeInstance.data.projects.find(row=>row.id===project.id);
    f.state.modified=true; f.state.observer=true;
    await metadataTestHooks.pollPsForProject(project.id,metadataTestHooks.getActiveWatchingActivationToken(project.id)); clearTrackedTimers();
    const source=[...stored().files,...stored().pendingFiles].find(row=>row.path===f.target);
    assert.ok(source);
    const key=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(stored(),source);
    assert.deepEqual(stored().workingFileDirtyHolds.records[key].identities,[null]);
    f.state.modified=false;
    await metadataTestHooks.pollPsForProject(project.id,metadataTestHooks.getActiveWatchingActivationToken(project.id)); clearTrackedTimers();
    assert.deepEqual(stored().workingFileDirtyHolds.records[key].identities,[null],'post-collection identity cannot identify the original buffer');
    for(const [p,bytes] of f.original) assert.deepEqual(fs.readFileSync(p),bytes);
  });
  for (const modified of [true,'unknown']) choiceTest(`InDesign second correction rejected dirty ${modified} poll survives close and Retry`, async () => {
    const f=await inDesignRecoveryFixture();
    await callIpcRaw('projects:start-watching',f.id); await metadataTestHooks.waitForWatcherIdle(f.id); clearTrackedTimers();
    f.state.modified=modified; f.state.observer=true; f.state.pollIncomplete=true; f.state.pollReject=true;
    await metadataTestHooks.pollPsForProject(f.id,metadataTestHooks.getActiveWatchingActivationToken(f.id)); clearTrackedTimers();
    assert.equal((await f.card()).reason,'indesign-save-required');
    roundTripFakeStore();
    await callIpcRaw('projects:pause',f.id); f.state.mode='closed';
    const inventories=f.state.inventories;
    assert.equal((await f.resolve(await f.card(),'retry')).error,'working_file_saved_observation_required');
    assert.equal(f.state.inventories,inventories);
    assert.equal((await callIpcRaw('projects:prepare-package-review',f.id)).error,'working_file_choice_required');
    f.state.mode='open'; f.state.modified=false;
    await callIpcRaw('projects:start-watching',f.id); await metadataTestHooks.waitForWatcherIdle(f.id); clearTrackedTimers();
    await metadataTestHooks.pollPsForProject(f.id,metadataTestHooks.getActiveWatchingActivationToken(f.id)); clearTrackedTimers();
    assert.equal((await f.card()).reason,'indesign-save-required','rejected clean rows cannot clear');
    f.state.pollReject=false; f.state.pollIncomplete=false;
    await metadataTestHooks.pollPsForProject(f.id,metadataTestHooks.getActiveWatchingActivationToken(f.id)); clearTrackedTimers();
    assert.notEqual((await f.card()).reason,'indesign-save-required');
    assert.equal((await f.card()).ready,false);
    await callIpcRaw('projects:pause',f.id); f.state.mode='closed';
    assert.equal((await f.resolve(await f.card(),'retry')).success,true);
    for(const [p,bytes] of f.original) assert.deepEqual(fs.readFileSync(p),bytes);
  });
  for (const rejected of [false,true]) choiceTest(`InDesign second correction discovered source replacement during ${rejected?'rejected':'resolved'} collection stays unresolved`, async () => {
    const f=await inDesignRecoveryFixture({admit:false});
    const project=await createProject('Collection identity');
    await metadataTestHooks.waitForWatcherIdle(project.id); clearTrackedTimers();
    const stored=()=>storeInstance.data.projects.find(row=>row.id===project.id);
    f.state.modified=true; f.state.observer=true; f.state.pollReject=rejected; f.state.pollIncomplete=rejected;
    let enter,release;
    const entered=new Promise(resolve=>{enter=resolve;});
    f.state.pollQueryWait={enter,promise:new Promise(resolve=>{release=resolve;})};
    const pending=metadataTestHooks.pollPsForProject(project.id,metadataTestHooks.getActiveWatchingActivationToken(project.id));
    try {
      await entered;
      fs.renameSync(f.target,f.target+'.observed-original'); fs.writeFileSync(f.target,'%PDF-1.7\nreplacement\n%%EOF\n');
      release(); await pending; clearTrackedTimers(); f.state.pollQueryWait=null;
      const source=[...stored().files,...stored().pendingFiles].find(row=>row.path===f.target);
      assert.ok(source,'dirty partial output must be retained');
      const key=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(stored(),source);
      assert.deepEqual(stored().workingFileDirtyHolds.records[key].identities,[null]);
      roundTripFakeStore(); f.state.modified=false; f.state.pollReject=false; f.state.pollIncomplete=false;
      await metadataTestHooks.pollPsForProject(project.id,metadataTestHooks.getActiveWatchingActivationToken(project.id)); clearTrackedTimers();
      assert.deepEqual(stored().workingFileDirtyHolds.records[key].identities,[null],'clean replacement cannot discharge unknown original');
      assert.deepEqual(fs.readFileSync(f.target+'.observed-original'),f.original.find(([p])=>p===f.target)[1]);
    } finally {release(); await pending; clearTrackedTimers();}
  });
  for (const modified of [true,'unknown']) for (const order of ['clean-first','dirty-first','clean-sandwich']) {
    for (const result of ['duplicate-terminal','incomplete','rejected']) choiceTest(`InDesign third correction ${modified} ${order} ${result} duplicates retain hold through close and Retry`, async () => {
      const f=await inDesignRecoveryFixture();
      await callIpcRaw('projects:start-watching',f.id); await metadataTestHooks.waitForWatcherIdle(f.id); clearTrackedTimers();
      const states=order==='clean-first'?[false,modified]:order==='dirty-first'?[modified,false]:[false,modified,false];
      const rows=states.map(value=>`DOC\t${f.target}\tRecovery.indd\t${value}\ttrue\t0`);
      f.state.pollOutput=rows.join('\n')+(result==='duplicate-terminal'?`\nEND\t${rows.length}\t${rows.length}\t0\t0`:'');
      f.state.pollReject=result==='rejected';
      await metadataTestHooks.pollPsForProject(f.id,metadataTestHooks.getActiveWatchingActivationToken(f.id)); clearTrackedTimers();
      assert.equal((await f.card()).reason,'indesign-save-required','a clean duplicate must never hide dirty or unknown work');
      roundTripFakeStore();
      await callIpcRaw('projects:pause',f.id); f.state.mode='closed';
      const inventories=f.state.inventories;
      assert.equal((await f.resolve(await f.card(),'retry')).error,'working_file_saved_observation_required');
      assert.equal(f.state.inventories,inventories,'closed-file Retry cannot bypass the retained hold');
      assert.equal((await callIpcRaw('projects:prepare-package-review',f.id)).error,'working_file_choice_required');
      // The same malformed snapshot cannot clear the hold even if every row is clean.
      f.state.pollOutput=f.state.pollOutput.replace(/\t(?:true|unknown)\ttrue\t0/g,'\tfalse\ttrue\t0');
      f.state.mode='open';
      await callIpcRaw('projects:start-watching',f.id); await metadataTestHooks.waitForWatcherIdle(f.id); clearTrackedTimers();
      await metadataTestHooks.pollPsForProject(f.id,metadataTestHooks.getActiveWatchingActivationToken(f.id)); clearTrackedTimers();
      assert.equal((await f.card()).reason,'indesign-save-required');
      // A later complete clean observation may clear the same physical source.
      f.state.pollOutput=null; f.state.pollReject=false; f.state.observer=true; f.state.modified=false;
      await metadataTestHooks.pollPsForProject(f.id,metadataTestHooks.getActiveWatchingActivationToken(f.id)); clearTrackedTimers();
      assert.notEqual((await f.card()).reason,'indesign-save-required');
      assert.equal((await f.card()).ready,false,'open clean remains unbound to saved bytes');
      await callIpcRaw('projects:pause',f.id); f.state.mode='closed';
      assert.equal((await f.resolve(await f.card(),'retry')).success,true);
      assert.equal((await callIpcRaw('projects:prepare-package-review',f.id)).error,'working_file_choice_required');
      for(const [p,bytes] of f.original) assert.deepEqual(fs.readFileSync(p),bytes);
    });
  }
  for (const modified of [true,'unknown']) choiceTest(`InDesign third correction close consequence after clean-first ${modified} duplicate`, async () => {
    const f=await inDesignRecoveryFixture();
    await callIpcRaw('projects:start-watching',f.id); await metadataTestHooks.waitForWatcherIdle(f.id); clearTrackedTimers();
    f.state.pollOutput=`DOC\t${f.target}\tRecovery.indd\tfalse\ttrue\t0\nDOC\t${f.target}\tRecovery.indd\t${modified}\ttrue\t0\nEND\t2\t2\t0\t0`;
    await metadataTestHooks.pollPsForProject(f.id,metadataTestHooks.getActiveWatchingActivationToken(f.id)); clearTrackedTimers();
    await callIpcRaw('projects:pause',f.id); f.state.mode='closed';
    const retry=await f.resolve(await f.card(),'retry');
    assert.equal(retry.success,false,'closing after malformed dirty output must not verify saved bytes');
    assert.equal(retry.error,'working_file_saved_observation_required');
    assert.equal((await f.card()).ready,false);
    for(const [p,bytes] of f.original) assert.deepEqual(fs.readFileSync(p),bytes);
  });
  for(const order of [null,{epoch:'invalid',sequence:1}]) choiceTest(`InDesign correction malformed stored observation order ${JSON.stringify(order)} remains opaque`, async () => {
    const f=await inDesignRecoveryFixture(); f.state.modified=true;
    assert.equal((await f.resolve(await f.card(),'retry')).success,false);
    const source=f.stored().files.find(row=>row.path===f.target);
    const key=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),source);
    metadataTestHooks.mutateProject(f.id,project=>{project.workingFileDirtyHolds.records[key].inDesignOrder=order;return true;});
    roundTripFakeStore(); const before=JSON.stringify(f.stored().workingFileDirtyHolds);
    f.state.modified=false; f.state.observer=true;
    await callIpcRaw('projects:start-watching',f.id); await metadataTestHooks.waitForWatcherIdle(f.id); clearTrackedTimers();
    await metadataTestHooks.pollPsForProject(f.id,metadataTestHooks.getActiveWatchingActivationToken(f.id)); clearTrackedTimers();
    assert.equal((await f.card()).reason,'indesign-save-required');
    assert.equal(JSON.stringify(f.stored().workingFileDirtyHolds),before);
  });
  choiceTest('InDesign correction fresh complete observation can clear a valid hold from an earlier process epoch', async () => {
    const f=await inDesignRecoveryFixture(); f.state.modified=true;
    assert.equal((await f.resolve(await f.card(),'retry')).success,false);
    const source=f.stored().files.find(row=>row.path===f.target);
    const key=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),source);
    metadataTestHooks.mutateProject(f.id,project=>{
      const epoch='ffffffff-ffff-4fff-8fff-ffffffffffff';
      assert.notEqual(project.workingFileDirtyHolds.records[key].inDesignOrder.epoch,epoch);
      project.workingFileDirtyHolds.records[key].inDesignOrder={epoch,sequence:999999};return true;
    });
    roundTripFakeStore(); f.state.modified=false; f.state.observer=true;
    await callIpcRaw('projects:start-watching',f.id); await metadataTestHooks.waitForWatcherIdle(f.id); clearTrackedTimers();
    await metadataTestHooks.pollPsForProject(f.id,metadataTestHooks.getActiveWatchingActivationToken(f.id)); clearTrackedTimers();
    assert.notEqual((await f.card()).reason,'indesign-save-required');
    assert.equal((await f.card()).ready,false);
  });
  for(const variant of ['absent','malformed','revision-mismatch']) choiceTest(`InDesign correction ${variant} receipt projects guidance and permits Retry recovery`, async () => {
    const f=await inDesignRecoveryFixture();
    const source=f.stored().files.find(row=>row.path===f.target);
    const key=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),source);
    metadataTestHooks.mutateProject(f.id,project=>{
      if(variant==='absent') delete project.workingSourceVerification[key];
      else if(variant==='malformed') project.workingSourceVerification[key]={status:'scanned'};
      else project.workingSourceVerification[key].selectionRevision+=1;
      return true;
    });
    roundTripFakeStore();
    const before=await f.card();
    assert.equal(before.ready,false); assert.equal(before.reason,'indesign-saved-file-unverified');
    f.state.mode='closed';
    assert.equal((await f.resolve(before,'retry')).success,true);
    assert.equal((await f.card()).ready,true);
    assert.equal((await callIpcRaw('projects:prepare-package-review',f.id)).error,'working_file_choice_required');
  });

  for (const boundary of ['account','project-delete','activation']) choiceTest(`InDesign Retry rejects a stale ${boundary} query result`, async () => {
    const f=await inDesignRecoveryFixture(); f.state.mode='closed';
    let release; f.state.queryWait={promise:new Promise(resolve=>{release=resolve;})};
    const before=JSON.stringify(f.stored().workingSourceSelections),queries=f.state.queries,now=testAccountSession.now;
    const pending=f.resolve(await f.card(),'retry').catch(error=>({success:false,error:error.message}));
    try {
      await waitForCondition(()=>f.state.queries>queries,'retry query not entered');
      if(boundary==='account') invalidateScanAccount('clock');
      else if(boundary==='project-delete') await callIpcRaw('projects:delete',f.id);
      else { await callIpcRaw('projects:start-watching',f.id); clearTrackedTimers(); }
      release(); assert.equal((await pending).success,false);
      if(boundary==='project-delete') assert.equal(f.stored(),undefined);
      else assert.equal(JSON.stringify(f.stored().workingSourceSelections),before);
      for(const [p,bytes] of f.original) assert.deepEqual(fs.readFileSync(p),bytes);
    } finally {
      release(); await pending;
      testAccountSession.now=now; await testAccountSession.restore(); clearTrackedTimers();
    }
  });

  async function failedRemovalFixture() {
    resetTestHomeWorkspace(); setPresentationUnzipFixture([]);
    const project = await createProject('Retained removal choices');
    await callIpcRaw('projects:pause', project.id); clearTrackedTimers();
    const root = path.join(TEST_HOME, 'Desktop');
    const shared = path.join(root, 'Shared.png'); fs.writeFileSync(shared, 'shared original');
    const paths = ['A.ai', 'C.ai', 'D.ai', 'Failed.indd', 'Other.ai'].map(name => path.join(root, name));
    for (const source of paths) {
      if (source.endsWith('.indd')) fs.writeFileSync(source, 'native inventory unavailable');
      else writeSyntheticAiFile(source, shared);
    }
    manualDialogFor(paths);
    await callIpcRaw('projects:add-files', project.id);
    const stored = () => storeInstance.data.projects.find(item => item.id === project.id);
    const workspace = () => callIpcRaw('projects:get-asset-workspace', project.id);
    for (const name of ['C.ai', 'D.ai']) {
      const card = (await workspace()).workingFileChoices.choices.find(item => item.source.name === name);
      assert.ok(card?.ready, JSON.stringify(card));
      assert.equal((await callIpcRaw('projects:resolve-working-file-choice', project.id,
        { id: card.id, revision: card.revision, choice: 'keep-both', predecessorIdentity: null })).success, true);
    }
    const ws = await workspace(), file = ws.files.find(item => item.name === 'Failed.indd');
    assert.equal(ws.workingFileChoices.recoveryRequired, false);
    assert.equal(file.sourceRecoveryAllowed, true, 'fixture reaches the retained destructive recovery path');
    assert.equal(ws.workingFileChoices.choices.find(item => item.source.name === file.name).ready, false);
    return { id: project.id, paths, shared, stored, workspace, file };
  }

  choiceTest('retained Remove refuses unanswered failed source without invalidating choices', async t => {
    const f = await failedRemovalFixture();
    const before = JSON.stringify(f.stored());
    const originals = [...f.paths, f.shared].map(source => fs.readFileSync(source));
    let rejection;
    try { await callIpcRaw('projects:remove-file', f.id, f.file.visualIdentity); } catch (error) { rejection = error; }
    const after = await f.workspace();
    t.diagnostic(JSON.stringify({ retained: after.files.some(item => item.name === f.file.name),
      recoveryRequired: after.workingFileChoices.recoveryRequired, rejection: rejection?.message || null }));
    assert.match(rejection?.message || '', /Exclude this working file instead of removing it/);
    assert.equal(after.workingFileChoices.recoveryRequired, false);
    assert.equal(JSON.stringify(f.stored()), before, 'refusal preserves all choices, selections, receipts and dirty history');
    assert.deepEqual([...f.paths, f.shared].map(source => fs.readFileSync(source)), originals);
    const review = await callIpcRaw('projects:prepare-package-review', f.id);
    assert.equal(review.error, 'asset_baseline_scan_incomplete');
    assert.equal(review.token, undefined);
  });

  choiceTest('retained Remove production UI routes failed source through Exclude and Restore', async () => {
    const f = await failedRemovalFixture();
    const records = JSON.stringify(f.stored().workingFileChoices);
    const originals = [...f.paths, f.shared].map(source => fs.readFileSync(source));
    const ui = require('./opus-renderer-helpers').loadProjectedWorkspace(await getProject(f.id), await f.workspace());
    const vm = require('node:vm'), calls = [];
    ui.renderer.window.crate.setWorkingSourceSelection = async (...args) => {
      calls.push(args); return callIpcRaw('projects:set-working-source-selection', ...args);
    };
    ui.renderer.window.crate.getAssetWorkspace = f.workspace;
    ui.renderer.window.crate.removeFile = () => { assert.fail('working source must never invoke legacy Remove'); };
    vm.runInContext('accountStatus={canUseWorkspace:true};', ui.renderer);
    let completion;
    const change = ui.renderer.changeWorkingSourceSelection;
    ui.renderer.changeWorkingSourceSelection = (...args) => (completion = change(...args));
    const descendants = node => [node, ...node.children.flatMap(descendants)];
    async function click(action) {
      const workspace = await f.workspace();
      ui.renderer.testWorkspace = workspace;
      vm.runInContext('state.assetWorkspace=testWorkspace;', ui.renderer);
      const file = workspace.files.find(item => item.name === 'Failed.indd');
      const row = ui.renderer.createAssetFileRow(await getProject(f.id), file,
        { protectedSource: file.protectedSource, sourceRecoveryAllowed: file.sourceRecoveryAllowed, loadVisual: false });
      const buttons = descendants(row).filter(item => item.tagName === 'BUTTON');
      assert.equal(buttons.some(item => item.textContent === 'Remove'), false);
      const button = buttons.find(item => item.textContent === action); assert.ok(button, ui.text(row));
      button.click(); assert.equal(await completion, true);
      assert.equal(calls.at(-1)[2].action, action.toLowerCase());
      assert.equal(calls.at(-1)[1], file.visualIdentity);
    }
    await click('Exclude');
    let ws = await f.workspace();
    assert.equal(ws.workingFileChoices.recoveryRequired, false);
    assert.equal(ws.workingFileChoices.remaining, 1, 'unrelated Other choice is still unanswered');
    assert.equal(ws.workingFileChoices.choices[0].source.name, 'Other.ai');
    assert.equal(JSON.stringify(f.stored().workingFileChoices), records, 'Exclude does not acknowledge or rebuild choices');
    // Legacy Remove must also retain the excluded, still-unanswered record.
    await assert.rejects(callIpcRaw('projects:remove-file', f.id, f.file.visualIdentity), /Exclude this working file/);
    const other = ws.workingFileChoices.choices[0];
    assert.equal((await callIpcRaw('projects:resolve-working-file-choice', f.id,
      { id: other.id, revision: other.revision, choice: 'keep-both', predecessorIdentity: null })).success, true);
    await callIpcRaw('projects:set-existing-assets-decision', f.id, 'include');
    ws = await f.workspace();
    assert.equal(ws.workingFileChoices.blocked, false);
    for (const name of ['A.ai', 'C.ai', 'D.ai', 'Other.ai']) assert.equal(ws.files.find(item => item.name === name).sourceSelection, 'selected');
    const shared = ws.files.find(item => item.name === 'Shared.png');
    assert.equal(shared.included, true);
    assert.deepEqual(shared.currentWorkingSources.map(item => item.name).sort(), ['A.ai', 'C.ai', 'D.ai', 'Other.ai']);
    const review = await callIpcRaw('projects:prepare-package-review', f.id); assert.ok(review.token, JSON.stringify(review));
    await click('Restore');
    ws = await f.workspace();
    assert.equal(ws.workingFileChoices.recoveryRequired, false);
    assert.equal(ws.workingFileChoices.remaining, 1);
    assert.equal(ws.workingFileChoices.choices[0].source.name, 'Failed.indd');
    assert.equal(ws.workingFileChoices.blocked, true, 'Restore reactivates the unanswered obligation');
    // The harness's ordinary Restore scan reports scanned; that still cannot
    // acknowledge the renewed choice or make the old package token usable.
    assert.equal(ws.files.find(item => item.name === 'Failed.indd').verificationStatus, 'scanned');
    assert.equal(ws.workingFileChoices.choices[0].ready, true);
    assert.equal((await callIpcRaw('projects:package', f.id, TEST_HOME, review.token)).error, 'package_review_stale');
    assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).token, undefined);
    assert.deepEqual([...f.paths, f.shared].map(source => fs.readFileSync(source)), originals);
    roundTripFakeStore(); assert.equal((await f.workspace()).workingFileChoices.recoveryRequired, false);
  });

  choiceTest('retained Remove rechecks unanswered choice after recovery receipt resolves', async () => {
    const f = await failedRemovalFixture(), gate = deferredScanBoundary();
    const file = f.stored().files.find(item => item.name === 'Failed.indd');
    const key = metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(), file);
    // Controlled race boundary: a record that was acknowledged at request time
    // becomes unanswered before the helper returns its still-valid receipt.
    f.stored().workingFileChoices.records[key].acknowledged = true;
    const restore = metadataTestHooks.pauseRecoveryEligibility(gate.wait);
    try {
      const removal = callIpcRaw('projects:remove-file', f.id, f.file.visualIdentity);
      const rejected = assert.rejects(removal, /Exclude this working file/);
      await gate.started;
      f.stored().workingFileChoices.records[key].acknowledged = false;
      const before = JSON.stringify(f.stored());
      gate.release(); await rejected;
      assert.equal(JSON.stringify(f.stored()), before);
    } finally { gate.release(); restore(); }
  });

  for (const mode of ['valid', 'physical-replacement', 'retry-reserved', 'project-delete', 'activation', 'clock', 'generation', 'identity']) {
    choiceTest(`retained Remove existing receipt fence ${mode}`, async () => {
      resetTestHomeWorkspace();
      const source = path.join(TEST_HOME, 'Desktop', 'First-failed.ai'); fs.writeFileSync(source, 'malformed source');
      const original = fs.readFileSync(source);
      const project = await createProject('Retained removal fence');
      manualDialogFor([source]); await callIpcRaw('projects:add-files', project.id);
      const ws = await callIpcRaw('projects:get-asset-workspace', project.id);
      const file = ws.files.find(item => item.name === 'First-failed.ai');
      assert.equal(file.sourceRecoveryAllowed, true); assert.equal(ws.workingFileChoices.remaining, 0);
      const gate = deferredScanBoundary(), originalNow = testAccountSession.now;
      const restore = metadataTestHooks.pauseRecoveryEligibility(gate.wait);
      try {
        const removal = callIpcRaw('projects:remove-file', project.id, file.visualIdentity);
        const completion = ['clock', 'generation', 'identity'].includes(mode)
          ? assert.rejects(removal, /account|Sign in|authorization/i) : removal;
        await gate.started; restore();
        if (mode === 'physical-replacement') { fs.renameSync(source, source + '.old'); fs.writeFileSync(source, 'replacement bytes'); }
        if (mode === 'retry-reserved') metadataTestHooks.reserveProjectAssetBaselineScanQueue(project.id, [source]);
        if (mode === 'project-delete') await callIpcRaw('projects:delete', project.id);
        if (mode === 'activation') { await callIpcRaw('projects:pause', project.id); await callIpcRaw('projects:start-watching', project.id); clearTrackedTimers(); }
        if (['clock', 'generation', 'identity'].includes(mode)) invalidateScanAccount(mode);
        const before = JSON.stringify(storeInstance.get('projects', []));
        gate.release(); await completion;
        if (mode === 'valid') {
          assert.equal((await getProject(project.id)).files.some(item => item.path === source), false);
          assert.equal((await getProject(project.id)).assetBaseline.status, 'empty');
        } else assert.equal(JSON.stringify(storeInstance.get('projects', [])), before, 'retired receipt cannot mutate current project state');
        assert.deepEqual(fs.readFileSync(mode === 'physical-replacement' ? source + '.old' : source), original);
      } finally { gate.release(); restore(); testAccountSession.now = originalNow; await testAccountSession.restore(); clearTrackedTimers(); }
    });
  }

  choiceTest('retained Remove leaves legitimate asset exclusion and restoration unchanged', async () => {
    const f = await setup(); await f.add('Loose.png'); await f.add('Unanswered.ai');
    let ws = await f.workspace(); const file = ws.files.find(item => item.name === 'Loose.png');
    const records = JSON.stringify(f.stored().workingFileChoices);
    const disk = path.join(TEST_HOME, 'Desktop', 'Loose.png'), bytes = fs.readFileSync(disk);
    for (const included of [false, true]) {
      const result = await callIpcRaw('projects:remove-file', f.id, file.visualIdentity);
      assert.ok(Array.isArray(result), 'successful legacy API retains its array contract');
      ws = await f.workspace(); assert.equal(ws.files.find(item => item.name === 'Loose.png').included, included);
      assert.equal(JSON.stringify(f.stored().workingFileChoices), records);
      assert.equal(ws.workingFileChoices.recoveryRequired, false);
      assert.deepEqual(fs.readFileSync(disk), bytes);
    }
  });

  for (const ext of ['.ai','.psd','.indd','.idml','.sketch','.afdesign','.afphoto','.afpub','.key','.pptx','.ppt','.pxd','.fig','.pdf','.xd']) {
    choiceTest(`explicit Add Files ${ext}: production admission enables owner-selected replacement, C stays selected`, async () => {
      const f = await setup(ext), successor = await f.add('1A' + ext);
      const ws = await f.workspace(), entry = ws.workingFileChoices.choices.find(item => item.source.name === '1A' + ext);
      if (ext === '.indd') {
        assert.equal(entry.ready, false, 'native baseline unavailable must not certify an empty inventory');
        assert.equal((await f.resolve(entry)).success, false);
        return;
      }
      assert.ok(entry?.ready, JSON.stringify({entry, receipts:f.stored().workingSourceVerification})); assert.equal(entry.predecessors.length, 2);
      const predecessor = entry.predecessors.find(item => item.name === 'A' + ext);
      const response = await f.resolve(entry, 'replace', predecessor.visualIdentity);
      assert.equal(response.success, true, JSON.stringify(response));
      const after = await f.workspace();
      assert.equal(after.files.find(row => row.name === 'A' + ext).sourceSelection, 'excluded');
      for (const name of ['C.ai', '1A' + ext]) assert.equal(after.files.find(row => row.name === name).sourceSelection, 'selected');
      assert.ok(fs.existsSync(f.a)); assert.ok(fs.existsSync(successor));
      assert.equal(after.workingFileChoices.choices.length, 0);
      assert.equal(after.workingSourceDisplayOrder[0], after.files.find(row=>row.name==='1A'+ext).visualIdentity);
      roundTripFakeStore(); const reloaded=await f.workspace(); assert.equal(reloaded.workingFileChoices.choices.length, 0);
      assert.deepEqual(reloaded.workingSourceDisplayOrder,after.workingSourceDisplayOrder);
      clearTrackedTimers();
    });
  }
  choiceTest('picker display order survives explicit Restore and reload without changing other selections or original bytes',async()=>{
    const f=await setup(),target=await f.add('B.ai'),entry=(await f.workspace()).workingFileChoices.choices[0];
    const prior=entry.predecessors.find(row=>row.name==='A.ai');assert.equal((await f.resolve(entry,'replace',prior.visualIdentity)).success,true);
    let ws=await f.workspace(),a=ws.files.find(row=>row.name==='A.ai');const b=ws.files.find(row=>row.name==='B.ai');
    const bytes=[f.a,f.c,target].map(p=>[p,fs.readFileSync(p)]);
    assert.equal((await callIpcRaw('projects:set-working-source-selection',f.id,a.visualIdentity,{action:'restore',expectedRevision:a.selectionRevision})).success,true);
    roundTripFakeStore();ws=await f.workspace();assert.equal(ws.workingSourceDisplayOrder[0],b.visualIdentity);
    for(const name of ['A.ai','B.ai','C.ai'])assert.equal(ws.files.find(row=>row.name===name).sourceSelection,'selected');
    for(const [p,value] of bytes)assert.deepEqual(fs.readFileSync(p),value);
  });
  choiceTest('Keep both persists across restart and duplicate admission without changing selections', async () => {
    const f = await setup(), target = await f.add('1A.ai'), entry = (await f.workspace()).workingFileChoices.choices[0];
    assert.equal((await f.resolve(entry)).success, true);
    roundTripFakeStore(); manualDialogFor([target]); await callIpcRaw('projects:add-files', f.id);
    const ws = await f.workspace(); assert.equal(ws.workingFileChoices.choices.length, 0);
    assert.ok(ws.files.filter(row => row.projectRole === 'source').every(row => row.sourceSelection === 'selected'));
  });
  choiceTest('user may deliberately choose independent C without changing A', async () => {
    const f = await setup(); await f.add('1A.ai'); const entry = (await f.workspace()).workingFileChoices.choices[0];
    assert.equal((await f.resolve(entry, 'replace', entry.predecessors.find(row => row.name === 'C.ai').visualIdentity)).success, true);
    const ws = await f.workspace(); assert.equal(ws.files.find(row => row.name === 'A.ai').sourceSelection, 'selected');
    assert.equal(ws.files.find(row => row.name === 'C.ai').sourceSelection, 'excluded');
  });
  for (const fault of ['bytes','deleted','symlink','hardlink','selection','foreign-predecessor']) {
    choiceTest(`stale or invalid ${fault} cannot commit replacement`, async () => {
      const f = await setup(), target = await f.add('1A.ai'), entry = (await f.workspace()).workingFileChoices.choices[0];
      let pred = entry.predecessors.find(row => row.name === 'A.ai').visualIdentity;
      if (fault === 'bytes') fs.appendFileSync(target, 'changed');
      if (fault === 'deleted') fs.unlinkSync(target);
      if (fault === 'symlink') { fs.unlinkSync(target); fs.symlinkSync(f.a, target); }
      if (fault === 'hardlink') { fs.unlinkSync(target); fs.linkSync(f.a, target); }
      if (fault === 'selection') { const c = (await f.workspace()).files.find(row => row.name === 'C.ai'); await callIpcRaw('projects:set-working-source-selection', f.id, c.visualIdentity, {action:'exclude',expectedRevision:c.selectionRevision}); }
      if (fault === 'foreign-predecessor') pred = 'foreign';
      assert.equal((await f.resolve(entry, 'replace', pred)).success, false);
      assert.equal((await f.workspace()).files.find(row => row.name === 'A.ai').sourceSelection, 'selected');
    });
  }
  choiceTest('current shared attribution follows real scans and selected roots, retaining disk originals', async () => {
    const f = await setup();
    const shared = path.join(TEST_HOME, 'Desktop', 'Shared.png'); fs.writeFileSync(shared, 'shared asset');
    await f.add('Shared.png', 'asset');
    for (const target of [f.a, f.c]) {
      writeSyntheticAiFile(target, shared);
      const operation = metadataTestHooks.captureProjectOperation(f.id);
      try { await metadataTestHooks.runScanOnOpen(f.id, target, operation.activationToken, operation, {allowPausedBaseline:true,verifySelectedSource:true,establishBaseline:false}); } finally { operation.close(); }
    }
    await f.add('1A.ai', shared);
    let ws = await f.workspace(); const entry = ws.workingFileChoices.choices[0];
    const parents = () => ws.files.find(row => row.name === 'Shared.png')?.currentWorkingSources.map(row => row.name).sort();
    assert.deepEqual(parents(), ['1A.ai','A.ai','C.ai'], JSON.stringify({files:ws.files,pending:ws.pendingFiles,receipts:f.stored().workingSourceVerification}));
    assert.equal((await f.resolve(entry, 'replace', entry.predecessors.find(row => row.name === 'A.ai').visualIdentity)).success, true);
    ws = await f.workspace(); assert.deepEqual(parents(), ['1A.ai','C.ai']);
    assert.equal(ws.files.find(row => row.name === 'Shared.png').included, true);
    assert.ok(fs.existsSync(shared));
    const ui = require('./opus-renderer-helpers').loadProjectedWorkspace(await getProject(f.id), ws);
    assert.match(ui.text(ui.elements['added-assets-list']) + ui.text(ui.elements['existing-assets-list']), /Shared by 1A.ai, C.ai|Shared by C.ai, 1A.ai/);
  });

  choiceTest('unrelated broad lsof remains quarantined even with a structured hint', async () => {
    const f = await setup(); const target = path.join(TEST_HOME, 'Desktop', 'Pending.pptx');
    fs.writeFileSync(target, 'synthetic archive bytes');
    metadataTestHooks.mutateProject(f.id, project => metadataTestHooks.stageLiveObservedFile(project,
      {path:target,name:'Pending.pptx',ext:'.pptx',source:'lsof',projectRole:'source'},
      {forcePending:true,reason:'app-live-evidence',appFamily:'powerpoint',liveEvidence:{evidenceStrength:'structured-app-document',documentModified:true,requiresSave:true}}));
    assert.equal((await f.workspace()).workingFileChoices.choices.length,0);
    assert.equal(f.stored().pendingFiles.some(row => row.path === target), false);
    assert.equal(await callIpcRaw('projects:accept-pending',f.id,target), null);
  });
  choiceTest('real Illustrator query/parser stages unsaved pending, acceptance scans, saved producer enables choice', async () => {
    const f = await setup(), target = path.join(TEST_HOME, 'Desktop', 'Pending.ai');
    writeSyntheticAiFile(target, 'saved source');
    let visible = false, modified = true;
    setChildProcessHandler(request => {
      if (isIllustratorPgrepCheck(request)) return {stdout:'432\n'};
      if (isOsascriptInvocation(request, 'crate-ai-active-session.applescript')) {
        const paths = visible ? [f.a, f.c, target] : [];
        return {stdout: (paths.length ? '' : 'STATUS\tno-documents\n') + paths.map(p => `DOC\t${p}\t${path.basename(p)}\t${p === target && modified}\t${p === target}\n`).join('') + `COMPLETE\t${paths.length}\t0\n`};
      }
      return {stdout:''};
    });
    await callIpcRaw('projects:start-watching', f.id); clearTrackedTimers();
    visible = true;
    const token = metadataTestHooks.getActiveWatchingActivationToken(f.id);
    await metadataTestHooks.pollPsForProject(f.id, token); clearTrackedTimers();
    assert.ok(f.stored().pendingFiles.some(row => row.path === target && row.source === 'app-opened' && row.captureState === 'needs-save'));
    assert.equal((await f.workspace()).workingFileChoices.choices.length, 0);
    const accepted = await callIpcRaw('projects:accept-pending', f.id, target);
    assert.ok(accepted.files.some(row => row.path === target));
    let entry = (await f.workspace()).workingFileChoices.choices.find(row => row.source.name === 'Pending.ai');
    assert.ok(entry); assert.equal(entry.ready, false, 'acceptance cannot erase unsaved observer evidence');
    assert.equal((await f.resolve(entry)).success, false);
    assert.equal((await f.resolve(entry,'retry')).error, 'working_file_saved_observation_required');
    const dirtyEntry = entry;
    // Actual registered production watcher path writes weaker filesystem evidence.
    await emitWatcher('change', target); clearTrackedTimers();
    assert.equal(f.stored().liveEvidenceLedger.candidates[Object.keys(f.stored().liveEvidenceLedger.candidates).find(key =>
      f.stored().liveEvidenceLedger.candidates[key].latest?.candidateName === 'Pending.ai')].latest.documentModified, undefined);
    entry = (await f.workspace()).workingFileChoices.choices.find(row => row.source.name === 'Pending.ai');
    assert.equal(entry.ready, false);
    assert.equal((await f.resolve(entry,'retry')).error, 'working_file_saved_observation_required');
    assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).error, 'working_file_choice_required');
    assert.ok((await f.workspace()).files.filter(row => ['A.ai','C.ai','Pending.ai'].includes(row.name)).every(row => row.sourceSelection === 'selected'));
    await callIpcRaw('projects:pause', f.id);
    roundTripFakeStore();
    entry = (await f.workspace()).workingFileChoices.choices.find(row => row.source.name === 'Pending.ai');
    assert.equal((await f.resolve(entry,'retry')).error, 'working_file_saved_observation_required', 'paused or absent app is not proof of saved state');
    await callIpcRaw('projects:start-watching', f.id); clearTrackedTimers();
    modified = false;
    await metadataTestHooks.pollPsForProject(f.id, metadataTestHooks.getActiveWatchingActivationToken(f.id)); clearTrackedTimers();
    entry = (await f.workspace()).workingFileChoices.choices.find(row => row.source.name === 'Pending.ai');
    assert.equal((await f.resolve(entry,'retry')).success, true, 'fresh clean evidence permits saved-byte verification after the watcher scan was paused');
    entry = (await f.workspace()).workingFileChoices.choices.find(row => row.source.name === 'Pending.ai');
    assert.equal(entry.ready, true); assert.equal(entry.route, 'accepted-pending');
    assert.equal((await f.resolve(dirtyEntry)).success, false, 'old dirty presentation token cannot authorize the clean state');
    assert.deepEqual(f.stored().workingFileDirtyHolds.records, {});
    fs.appendFileSync(target, 'new bytes');
    assert.equal((await f.resolve(entry)).success, false, 'saved producer cannot authorize changed bytes');
    await callIpcRaw('projects:pause', f.id);
  });
  choiceTest('saved collector admission makes a neutral choice; repeat events and initial snapshots do not', async () => {
    const f = await setup(); const target = path.join(TEST_HOME, 'Desktop', 'Observed.pptx');
    fs.writeFileSync(target,'archive bytes');
    const row = {path:target,name:'Observed.pptx',ext:'.pptx',projectRole:'source',source:'chokidar'};
    const event = {reason:'chokidar-add',allowDirect:true,filesystemSaved:true,appFamily:'powerpoint'};
    metadataTestHooks.mutateProject(f.id, project => metadataTestHooks.stageLiveObservedFile(project,row,event));
    assert.ok(f.stored().files.some(file=>file.path===target));
    let ws = await f.workspace(); assert.equal(ws.workingFileChoices.choices.length,1); assert.equal(ws.workingFileChoices.choices[0].ready,false);
    const operation=metadataTestHooks.captureProjectOperation(f.id);
    try { await metadataTestHooks.runScanOnOpen(f.id,target,operation.activationToken,operation,{allowPausedBaseline:true,verifySelectedSource:true,establishBaseline:false}); } finally {operation.close();}
    ws=await f.workspace(); assert.equal(ws.workingFileChoices.choices[0].ready,true);
    assert.equal((await f.resolve(ws.workingFileChoices.choices[0])).success,true);
    metadataTestHooks.mutateProject(f.id, project => metadataTestHooks.stageLiveObservedFile(project,row,event));
    assert.equal((await f.workspace()).workingFileChoices.choices.length,0);
  });
  choiceTest('capacity: 128 cards drain 129 durable obligations with 130 predecessors across restart', { timeout: 600000 }, async () => {
    const f = await setup();
    const paths = Array.from({length:129}, (_,i) => path.join(TEST_HOME,'Desktop',`Capacity-${String(i).padStart(3,'0')}.ai`));
    for (const target of paths) writeSyntheticAiFile(target, 'saved source');
    manualDialogFor(paths.slice(0,126));
    const added = await callIpcRaw('projects:add-files',f.id);
    assert.equal(getAddFilesResultFiles(added).filter(row=>paths.includes(row.path)).length,126);
    assert.equal((await f.workspace()).workingFileChoices.remaining,126,'128 selected roots');
    for (let i=126;i<129;i++) {
      manualDialogFor([paths[i]]);await callIpcRaw('projects:add-files',f.id);
      assert.equal((await f.workspace()).workingFileChoices.remaining,i+1,`${i+3} selected roots retain every obligation`);
    }
    roundTripFakeStore();
    let ws = await f.workspace();
    assert.equal(ws.workingFileChoices.remaining,129);
    assert.equal(ws.workingFileChoices.choices.length,128);
    assert.equal(ws.workingFileChoices.limited,true);
    assert.equal((await callIpcRaw('projects:prepare-package-review',f.id)).error,'working_file_choice_required');
    const resolved = new Set();
    while ((ws = await f.workspace()).workingFileChoices.remaining) {
      const card = ws.workingFileChoices.choices[0]; assert.ok(card?.ready,JSON.stringify(card));
      assert.equal(resolved.has(card.source.name),false);
      resolved.add(card.source.name);
      assert.equal((await f.resolve(card)).success,true);
    }
    assert.equal(resolved.size,129);
    assert.equal(ws.workingFileChoices.blocked,false);
    assert.ok((await callIpcRaw('projects:prepare-package-review',f.id)).token);
    // All acknowledged capacity can retire an old receipt without dropping the
    // next admission, including the former >128-prior-selected-source boundary.
    await f.add('After-capacity.ai');
    ws=await f.workspace();
    assert.equal(ws.workingFileChoices.remaining,1);
    assert.equal(ws.workingFileChoices.choices[0].predecessors.length,131);
    assert.equal((await f.resolve(ws.workingFileChoices.choices[0])).success,true);
    roundTripFakeStore();assert.equal((await f.workspace()).workingFileChoices.blocked,false);
  });
  for (const corruption of ['legacy-overflow','null','array','bad-version','bad-record','duplicate-event']) {
    choiceTest(`canonical malformed or ${corruption} state blocks tokens and explicitly recovers`, async () => {
      const f=await setup(); const token=(await callIpcRaw('projects:prepare-package-review',f.id)).token;
      assert.ok(token);
      const stored=f.stored();
      if(corruption==='legacy-overflow') stored.workingFileChoiceLimit=true;
      if(corruption==='null') stored.workingFileChoices=null;
      if(corruption==='array') stored.workingFileChoices={version:1,records:[]};
      if(corruption==='bad-version') stored.workingFileChoices={version:99,records:{}};
      if(corruption==='bad-record') stored.workingFileChoices.records.bad={acknowledged:true};
      if(corruption==='duplicate-event') {const [key,event]=Object.entries(stored.workingFileChoices.records)[0];stored.workingFileChoices.records['f'.repeat(64)]={...event};}
      roundTripFakeStore();
      const ws=await f.workspace();assert.equal(ws.workingFileChoices.blocked,true);assert.equal(ws.workingFileChoices.recoveryRequired,true);
      const held=await callIpcRaw('projects:prepare-package-review',f.id);assert.equal(held.error,'working_file_choice_required');assert.equal(held.token,undefined);
      assert.equal((await callIpcRaw('projects:package',f.id,TEST_HOME,token)).error,'package_review_stale');
      const ui=require('./opus-renderer-helpers').loadProjectedWorkspace(await getProject(f.id),ws);
      ui.renderer.renderPackageReview(await getProject(f.id),{...held,token:'forged',materializable:true});assert.equal(ui.elements['btn-confirm-package'].disabled,true);
      const before=JSON.stringify(stored.workingSourceSelections);
      const request={id:'recovery',revision:ws.workingFileChoices.recoveryRevision,choice:'recover',predecessorIdentity:null};
      assert.equal((await callIpcRaw('projects:resolve-working-file-choice',f.id,{...request,revision:'0'.repeat(64)})).success,false);
      assert.equal((await callIpcRaw('projects:resolve-working-file-choice',f.id,request)).success,true);
      assert.equal(JSON.stringify(f.stored().workingSourceSelections),before);
      assert.equal((await callIpcRaw('projects:resolve-working-file-choice',f.id,request)).success,false,'recovery request cannot replay');
      assert.equal((await f.workspace()).workingFileChoices.remaining,2);
      for(const name of ['A.ai','C.ai']) {const card=(await f.workspace()).workingFileChoices.choices.find(row=>row.source.name===name);assert.ok(card?.ready);assert.equal((await f.resolve(card)).success,true);}
      roundTripFakeStore();assert.equal((await f.workspace()).workingFileChoices.blocked,false);
      assert.ok((await callIpcRaw('projects:prepare-package-review',f.id)).token);
    });
  }
  choiceTest('paused selected stale and failed file retries preserve intent and require current saved bytes', async () => {
    const f=await setup();const target=await f.add('Retry.ai');
    let card=(await f.workspace()).workingFileChoices.choices[0];const old=card;
    const selection=JSON.stringify(f.stored().workingSourceSelections);
    writeSyntheticAiFile(target,'changed valid saved bytes');
    card=(await f.workspace()).workingFileChoices.choices[0];assert.equal(card.ready,false);
    assert.equal((await f.resolve(old,'retry')).success,false,'old revision cannot initiate a scan');
    assert.equal((await f.resolve(card,'retry')).success,true);
    assert.equal(JSON.stringify(f.stored().workingSourceSelections),selection);
    card=(await f.workspace()).workingFileChoices.choices[0];assert.equal(card.ready,true);
    fs.writeFileSync(target,'%PDF-1.7\nmissing EOF');
    card=(await f.workspace()).workingFileChoices.choices[0];assert.equal((await f.resolve(card,'retry')).success,false);
    writeSyntheticAiFile(target,'valid repaired saved bytes');
    card=(await f.workspace()).workingFileChoices.choices[0];assert.equal((await f.resolve(card,'retry')).success,true);
    // Excluding all prior sources leaves a selected choice with no predecessor;
    // Keep both still resolves it, without fabricating a predecessor identity.
    for(const name of ['A.ai','C.ai']) {const row=(await f.workspace()).files.find(x=>x.name===name);assert.equal((await callIpcRaw('projects:set-working-source-selection',f.id,row.visualIdentity,{action:'exclude',expectedRevision:row.selectionRevision})).success,true);}
    card=(await f.workspace()).workingFileChoices.choices[0];assert.equal(card.predecessors.length,0);assert.ok(card.ready);assert.equal((await f.resolve(card)).success,true);
  });
  for(const ext of ['.pptx','.key','.sketch','.afdesign','.afphoto','.afpub','.pxd','.fig','.xd']) {
    choiceTest(`explicit ${ext} predecessor offers direct Restore after successor identity changes`, async () => {
      const f=await setup(ext),target=await f.add('Replacement'+ext);
      const card=(await f.workspace()).workingFileChoices.choices[0];
      assert.equal((await f.resolve(card,'replace',card.predecessors.find(row=>row.name==='A'+ext).visualIdentity)).success,true);
      const tmp=target+'.replacement';fs.writeFileSync(tmp,fs.readFileSync(target));fs.renameSync(tmp,target);
      const row=(await f.workspace()).files.find(x=>x.name==='A'+ext);
      assert.equal(row.sourceSelection,'invalid');assert.deepEqual(row.selectionRecovery.actions,['exclude','restore']);
      assert.equal((await callIpcRaw('projects:set-working-source-selection',f.id,row.visualIdentity,{action:'restore',expectedRevision:row.selectionRevision})).success,true);
      assert.equal((await f.workspace()).files.find(x=>x.name==='A'+ext).sourceSelection,'selected');
      assert.ok(fs.existsSync(f.a));assert.ok(fs.existsSync(target));
    });
  }
  choiceTest('account retirement rejects a displayed choice without selection mutation', async () => {
    const f=await setup(); await f.add('1A.ai'); const entry=(await f.workspace()).workingFileChoices.choices[0];
    const before=JSON.stringify(f.stored().workingSourceSelections); const now=testAccountSession.now;
    try { invalidateScanAccount('clock'); await f.resolve(entry,'replace',entry.predecessors[0].visualIdentity); }
    catch (_) { /* trusted IPC refuses an expired account */ }
    finally { testAccountSession.now=now; await testAccountSession.restore(); }
    assert.equal(JSON.stringify(f.stored().workingSourceSelections),before);
  });
  choiceTest('unanswered choices block review and old-token packaging until explicit resolution', async () => {
    const f=await setup();
    const old=await callIpcRaw('projects:prepare-package-review',f.id); assert.ok(old.token);
    await f.add('1A.ai');
    const review=await callIpcRaw('projects:prepare-package-review',f.id);
    assert.equal(review.error,'working_file_choice_required');
    assert.equal(review.workingFileChoices.choices.length,1); assert.equal(review.token,undefined);
    assert.equal((await callIpcRaw('projects:package',f.id,TEST_HOME,old.token)).error,'package_review_stale');
    assert.ok((await f.workspace()).files.filter(row=>row.projectRole==='source').every(row=>row.sourceSelection==='selected'));
    const ui=require('./opus-renderer-helpers').loadProjectedWorkspace(await getProject(f.id),await f.workspace());
    ui.renderer.renderPackageReview(await getProject(f.id),{...review,token:'forged',materializable:true});
    assert.equal(ui.elements['btn-confirm-package'].disabled,true);
    assert.match(ui.text(ui.elements['source-continuation-choices']),/Packaging (?:is )?blocked/);
    assert.equal((await f.resolve(review.workingFileChoices.choices[0])).success,true);
    assert.ok((await callIpcRaw('projects:prepare-package-review',f.id)).token);
  });
  choiceTest('same filenames in same-named folders have distinct safe picker labels and no default', async () => {
    const f=await setup();
    for (const dir of ['One/Work','Two/Work']) {
      fs.mkdirSync(path.join(TEST_HOME,'Desktop',dir),{recursive:true});
      await f.add(dir+'/Deck.ai');
      for (const entry of (await f.workspace()).workingFileChoices.choices) assert.equal((await f.resolve(entry)).success,true);
    }
    await f.add('New.ai'); const ws=await f.workspace(),entry=ws.workingFileChoices.choices[0];
    const peers=entry.predecessors.filter(row=>row.name==='Deck.ai');
    assert.deepEqual(peers.map(row=>row.folder).sort(),['One › Work','Two › Work']);
    assert.equal(JSON.stringify(entry).includes(TEST_HOME),false);
    const ui=require('./opus-renderer-helpers').loadProjectedWorkspace(await getProject(f.id),ws);
    ui.renderer.renderWorkingFileChoices(await getProject(f.id),ws);
    const descend = el => [el,...el.children.flatMap(descend)];
    const buttons=descend(ui.elements['project-file-list']).filter(el=>el.tagName==='BUTTON'&&el.dataset.choice==='replace');
    assert.equal(descend(ui.elements['project-file-list']).some(el=>el.tagName==='SELECT'),false);
    const labels=buttons.filter(el=>el.textContent.includes('Deck.ai')).map(el=>el.getAttribute('aria-label'));
    assert.equal(new Set(labels).size,2);
    assert.ok(labels.some(label=>label.includes('One › Work')));assert.ok(labels.some(label=>label.includes('Two › Work')));
    const question=ui.elements['project-file-list'].querySelector('.working-file-choice-question');question.focus();
    ui.renderer.renderWorkingFileChoices(await getProject(f.id),await f.workspace());
    assert.ok(ui.document.activeElement===question,'identical refresh preserves decision context/focus');
  });
  choiceTest('cache hardening/read preserve correct-mode ctime and still reject unsafe targets', async () => {
    const f=await setup(),dir=metadataTestHooks.ensurePresentationAssetsDir(f.id),target=path.join(dir,'Safe.png');
    fs.writeFileSync(target,'safe bytes',{mode:0o600});
    const before=fs.lstatSync(target).ctimeMs;
    assert.equal(metadataTestHooks.hardenOwnerOnlyCacheFileSync(target,dir,'test'),true);
    assert.equal(metadataTestHooks.readOwnerOnlyCacheFileSync(target,dir,'test').toString(),'safe bytes');
    assert.equal(fs.lstatSync(target).ctimeMs,before);
    fs.chmodSync(target,0o644);
    assert.equal(metadataTestHooks.readOwnerOnlyCacheFileSync(target,dir,'test').toString(),'safe bytes');
    assert.equal(fs.lstatSync(target).mode & 0o777,0o600);
    const link=path.join(dir,'Link.png'); fs.linkSync(target,link);
    assert.throws(()=>metadataTestHooks.readOwnerOnlyCacheFileSync(target,dir,'test'),/Unsafe cache path/);
    fs.unlinkSync(link);fs.symlinkSync(target,link);
    assert.throws(()=>metadataTestHooks.readOwnerOnlyCacheFileSync(link,dir,'test'),/Unsafe cache path/);
  });
  for (const ext of ['.pptx','.key']) choiceTest(`actual ${ext} media extraction and dedup retain current shared attribution`, async () => {
    const f=await setup(ext); const data=Buffer.alloc(700,57);
    setPresentationUnzipFixture([{internalPath:ext==='.pptx'?'ppt/media/image1.png':'Data/picture-1234.png',data}]);
    await f.add('WithMedia'+ext);
    await metadataTestHooks.runScanOnSavePresentation(f.id,path.join(TEST_HOME,'Desktop','WithMedia'+ext));
    let ws=await f.workspace(); const media=ws.files.find(row=>row.ext==='.png'); assert.ok(media,JSON.stringify(ws));
    await f.add('SameMedia'+ext);
    await metadataTestHooks.runScanOnSavePresentation(f.id,path.join(TEST_HOME,'Desktop','SameMedia'+ext));
    ws=await f.workspace();
    assert.deepEqual(ws.files.find(row=>row.visualIdentity===media.visualIdentity).currentWorkingSources.map(row=>row.name).sort(),['SameMedia'+ext,'WithMedia'+ext]);
    assert.equal(ws.files.filter(row=>row.ext==='.png').length,1,'dedup leaves one shared media row');
    const ui=require('./opus-renderer-helpers').loadProjectedWorkspace(await getProject(f.id),ws);
    ui.renderer.renderWorkingFileChoices(await getProject(f.id),ws);
    const descend=el=>[el,...el.children.flatMap(descend)];
    const question=ui.elements['project-file-list'].querySelector('.working-file-choice-question');question.focus();
    const before=JSON.stringify(f.stored()), writes=storeInstance.projectSetCount, events=testRendererEvents.length;
    await metadataTestHooks.runScanOnSavePresentation(f.id,path.join(TEST_HOME,'Desktop','SameMedia'+ext));
    assert.equal(JSON.stringify(f.stored()),before); assert.equal(storeInstance.projectSetCount,writes);
    assert.equal(testRendererEvents.length,events);
    ws=await f.workspace(); ui.renderer.renderWorkingFileChoices(await getProject(f.id),ws);
    assert.ok(ui.document.activeElement===question,'unchanged media refresh preserves decision focus');
    for (const entry of ws.workingFileChoices.choices) {
      const current=(await f.workspace()).workingFileChoices.choices.find(row=>row.id===entry.id);
      assert.equal((await f.resolve(current)).success,true);
    }
    const review=await callIpcRaw('projects:prepare-package-review',f.id); assert.ok(review.token);
    await metadataTestHooks.runScanOnSavePresentation(f.id,path.join(TEST_HOME,'Desktop','SameMedia'+ext));
    const out=fs.mkdtempSync(path.join(TEST_HOME,'Output-'+ext.slice(1)+'-'));
    const packaged=await callIpcRaw('projects:package',f.id,out,review.token);
    assert.equal(packaged.success,true,'unchanged scan preserves usable review token');
    ws=await f.workspace();
    const source=ws.files.find(row=>row.name==='WithMedia'+ext);
    assert.equal((await callIpcRaw('projects:set-working-source-selection',f.id,source.visualIdentity,{action:'exclude',expectedRevision:source.selectionRevision})).success,true);
    ws=await f.workspace(); const currentMedia=ws.files.find(row=>row.visualIdentity===media.visualIdentity);
    assert.deepEqual(currentMedia.currentWorkingSources.map(row=>row.name),['SameMedia'+ext]);
    assert.equal(currentMedia.included,true,'other selected source retains shared media');
    const mediaPath=f.stored().files.find(row=>row.ext==='.png').path;
    fs.appendFileSync(mediaPath,'changed media');
    ws=await f.workspace(); assert.deepEqual(ws.files.find(row=>row.visualIdentity===media.visualIdentity).currentWorkingSources,[]);
    fs.appendFileSync(path.join(TEST_HOME,'Desktop','SameMedia'+ext),'changed source');
    ws=await f.workspace(); assert.deepEqual(ws.files.find(row=>row.visualIdentity===media.visualIdentity).currentWorkingSources,[]);

  });
  choiceTest('owner-selected physical pair survives committed document-ID upgrade and rejects real inode replacement', async () => {
    const f = await setup(), b = await f.add('B.ai');
    const card = (await f.workspace()).workingFileChoices.choices[0];
    assert.equal((await f.resolve(card, 'replace', card.predecessors.find(row => row.name === 'A.ai').visualIdentity)).success, true);
    const pairBefore = JSON.stringify(f.stored().workingSourceContinuations);
    const locatorsBefore = JSON.stringify(f.stored().workingSourceLocators);
    setChildProcessHandler(({command,args}) => {
      if (command !== '/usr/bin/osascript' || path.basename(args.at(-1) || '') !== 'crate-source-document-identity.js') return {stdout:''};
      const script = fs.readFileSync(args.at(-1),'utf8');
      const target = [f.a,f.c,b].find(p => script.includes(JSON.stringify(p)));
      assert.ok(target);
      return {stdout:JSON.stringify({documentId:String([f.a,f.c,b].indexOf(target)+101),volumeUuid:'00000000-0000-4000-8000-000000000001'})};
    });
    metadataTestHooks.clearDocumentIdentityCache();
    await metadataTestHooks.refreshWorkingSourceLocators(f.id);
    assert.notEqual(JSON.stringify(f.stored().workingSourceLocators),locatorsBefore, 'refresh must really commit changed locators');
    assert.ok(Object.values(f.stored().workingSourceLocators.records).every(row => /^[a-f0-9]{64}$/.test(row.documentIdentity)));
    assert.equal(JSON.stringify(f.stored().workingSourceContinuations), pairBefore);
    roundTripFakeStore();
    assert.equal((await f.workspace()).files.find(row => row.name === 'A.ai').sourceSelection,'excluded');
    assert.ok((await callIpcRaw('projects:prepare-package-review',f.id)).token);
    const old = fs.statSync(b).ino;
    fs.renameSync(b,b+'.original'); fs.writeFileSync(b,'%PDF-1.7\nreplacement inode\n%%EOF\n');
    assert.notEqual(fs.statSync(b).ino,old);
    const ws = await f.workspace();
    assert.equal(ws.files.find(row => row.name === 'A.ai').sourceSelection,'invalid');
    assert.equal((await callIpcRaw('projects:prepare-package-review',f.id)).token,undefined);
    assert.ok(fs.existsSync(f.a)); assert.ok(fs.existsSync(b+'.original'));
  });
  for (const role of ['predecessor','successor']) for (const outcome of ['unanswered','keep-both','replace']) {
    choiceTest(`recognized rename migrates ${role} choice keys and preserves ${outcome}`, async () => {
      const f=await setup(), b=await f.add('B.ai');
      const card=(await f.workspace()).workingFileChoices.choices[0];
      if (outcome !== 'unanswered') assert.equal((await f.resolve(card,outcome,
        outcome==='replace'?card.predecessors.find(row=>row.name==='A.ai').visualIdentity:null)).success,true);
      const target=role==='predecessor'?f.a:b, destination=target.replace('.ai','-Moved.ai');
      const row=f.stored().files.find(row=>row.path===target);
      const key=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),row);
      const recordsBefore=JSON.parse(JSON.stringify(f.stored().workingFileChoices.records));
      const inode=fs.statSync(target).ino; fs.renameSync(target,destination); assert.equal(fs.statSync(destination).ino,inode);
      await metadataTestHooks.refreshWorkingSourceLocators(f.id,[destination]);
      roundTripFakeStore();
      const ws=await f.workspace(); assert.equal(ws.workingFileChoices.recoveryRequired,false);
      const moved=f.stored().files.find(row=>row.path===destination); assert.ok(moved);
      const newKey=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),moved);
      const expected=Object.fromEntries(Object.entries(recordsBefore).map(([k,event])=>[k===key?newKey:k,
        {...event,priorKeys:event.priorKeys.map(k=>k===key?newKey:k)}]));
      assert.deepEqual(f.stored().workingFileChoices.records,expected);
      assert.equal((await f.resolve(card)).success,false,'pre-rename/replayed token refuses');
      assert.equal(ws.files.find(row=>row.name==='C.ai').sourceSelection,'selected');
      assert.equal(ws.files.find(row=>row.name===path.basename(role==='predecessor'?destination:f.a)).sourceSelection,
        outcome==='replace'?'excluded':'selected');
      if(outcome==='unanswered') {
        const current=ws.workingFileChoices.choices.find(row=>row.id===card.id); assert.ok(current?.ready,JSON.stringify(current));
        assert.ok(current.predecessors.some(row=>row.name===path.basename(role==='predecessor'?destination:f.a)));
        assert.equal((await f.resolve(current)).success,true);
      } else assert.equal(ws.workingFileChoices.remaining,0);
      assert.ok((await callIpcRaw('projects:prepare-package-review',f.id)).token);
    });
  }
  for (const state of [null,{version:99,records:{},aliases:{}},{version:1,records:[],aliases:[]},
    {version:1,records:{},aliases:{}},{version:1,records:null,aliases:[]}]) {
    choiceTest(`malformed locator guard preserves state independently: ${JSON.stringify(state)}`, async()=>{
      const f=await setup(); await f.add('B.ai');
      f.stored().workingSourceLocators=state; roundTripFakeStore();
      const before=JSON.stringify(f.stored().workingSourceLocators);
      const ws=await f.workspace(); assert.equal(ws.workingFileChoices.recoveryRequired,false);
      assert.equal(JSON.stringify(f.stored().workingSourceLocators),before,'no implicit locator repair');
      assert.equal((await callIpcRaw('projects:prepare-package-review',f.id)).error,'working_file_choice_required');
      f.stored().workingFileChoices={version:99,records:{}};
      assert.equal((await f.workspace()).workingFileChoices.recoveryRequired,true,'choice guard is independent');
      assert.equal(JSON.stringify(f.stored().workingSourceLocators),before);
    });
  }

  choiceTest('dirty hold requires same-identity trusted clean document, survives weak clean and renamed source', async()=>{
    const f=await setup(), target=await f.add('Dirty.ai');
    const row=()=>f.stored().files.find(row=>row.name==='Dirty.ai'||row.name==='Dirty-Moved.ai');
    const observe=(evidence)=>metadataTestHooks.mutateProject(f.id,project=>metadataTestHooks.stageLiveObservedFile(project,row(),
      {allowDirect:true,reason:'app-live-evidence',appFamily:'illustrator',liveEvidence:evidence}));
    const trusted={source:'app-opened',observerMethod:'illustrator-active-session',evidenceStrength:'structured-app-document',sourceDocumentPath:target};
    observe({...trusted,documentModified:true});
    const card=()=>f.workspace().then(ws=>ws.workingFileChoices.choices.find(row=>row.source.name.startsWith('Dirty')));
    assert.equal((await card()).ready,false);
    observe({source:'chokidar',documentModified:false,filesystemSaved:true});
    assert.equal((await f.resolve(await card(),'retry')).error,'working_file_saved_observation_required');
    observe({...trusted,sourceDocumentPath:f.a,documentModified:false});
    assert.equal((await card()).ready,false,'clean other document is not authority');
    const destination=target.replace('.ai','-Moved.ai');fs.renameSync(target,destination);
    await metadataTestHooks.refreshWorkingSourceLocators(f.id,[destination]);roundTripFakeStore();
    assert.equal((await card()).ready,false,'dirty hold moves atomically with same inode rename');
    observe({...trusted,sourceDocumentPath:destination,documentModified:false});
    assert.equal((await f.resolve(await card(),'retry')).success,true);
    assert.equal((await card()).ready,true);
    observe({...trusted,sourceDocumentPath:destination,documentModified:true});
    const old=fs.statSync(destination).ino;fs.renameSync(destination,destination+'.original');fs.writeFileSync(destination,'%PDF-1.7\nnew inode\n%%EOF\n');
    assert.notEqual(fs.statSync(destination).ino,old);
    observe({...trusted,sourceDocumentPath:destination,documentModified:false});
    assert.equal((await f.resolve(await card(),'retry')).error,'working_file_saved_observation_required','clean replacement inode cannot clear old buffer obligation');
  });

  for(const malformed of [null,false,0,'']) choiceTest(`malformed dirty entry survives rename: ${JSON.stringify(malformed)}`,async()=>{
    const f=await setup(),target=await f.add('Dirty.ai');
    await f.workspace();
    const oldKey=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),f.stored().files.find(row=>row.path===target));
    f.stored().workingFileDirtyHolds={version:1,records:{[oldKey]:malformed}};
    const destination=target.replace('.ai','-Moved.ai');fs.renameSync(target,destination);
    await metadataTestHooks.refreshWorkingSourceLocators(f.id,[destination]);roundTripFakeStore();
    const moved=f.stored().files.find(row=>row.path===destination);assert.ok(moved);
    const key=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),moved);
    assert.equal(Object.hasOwn(f.stored().workingFileDirtyHolds.records,oldKey),false);
    assert.equal(Object.hasOwn(f.stored().workingFileDirtyHolds.records,key),true);
    const card=(await f.workspace()).workingFileChoices.choices[0];assert.equal(card.ready,false);
    assert.equal((await f.resolve(card,'retry')).error,'working_file_saved_observation_required');
  });
  for(const malformed of [null,{version:99,records:{}},{version:1,records:[]}]) choiceTest(`malformed dirty schema remains blocked during rename: ${JSON.stringify(malformed)}`,async()=>{
    const f=await setup(),target=await f.add('Dirty.ai');await f.workspace();
    f.stored().workingFileDirtyHolds=malformed;
    const destination=target.replace('.ai','-Moved.ai');fs.renameSync(target,destination);
    await metadataTestHooks.refreshWorkingSourceLocators(f.id,[destination]);roundTripFakeStore();
    assert.deepEqual(f.stored().workingFileDirtyHolds,malformed);
    const card=(await f.workspace()).workingFileChoices.choices[0];assert.equal(card.ready,false);
    assert.equal((await f.resolve(card,'retry')).error,'working_file_saved_observation_required');
  });

  for (const cleanOrder of ['replacement-first', 'original-first']) {
    choiceTest(`dirty identity obligations survive intervening dirty observation: ${cleanOrder}`, async () => {
      const f=await setup(), target=await f.add('Turnover.ai');
      const row=()=>f.stored().files.find(row=>row.path===target);
      const route=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),row());
      const card=()=>f.workspace().then(ws=>ws.workingFileChoices.choices.find(item=>item.source.name==='Turnover.ai'));
      const observe=modified=>metadataTestHooks.mutateProject(f.id,project=>metadataTestHooks.stageLiveObservedFile(project,row(),{
        allowDirect:true,reason:'app-live-evidence',appFamily:'illustrator',liveEvidence:{source:'app-opened',
          observerMethod:'illustrator-active-session',evidenceStrength:'structured-app-document',sourceDocumentPath:target,documentModified:modified}}));
      const identities=()=>{const r=f.stored().workingFileDirtyHolds.records[route];return r?.identities || (r ? [r.identity] : []);};
      observe(true);const originalIdentity=identities()[0],originalInode=fs.statSync(target).ino;
      fs.renameSync(target,target+'.I1');fs.writeFileSync(target,'%PDF-1.7\nsecond physical file\n%%EOF\n');
      assert.notEqual(fs.statSync(target).ino,originalInode);
      observe(true);observe(true);roundTripFakeStore();
      // Both physical buffers remain obligations; repeat dirty is not a rebind.
      assert.ok(identities().includes(originalIdentity),'intervening dirty observation must retain I1');
      assert.equal(identities().length,2,'one unresolved obligation per physical identity');
      if(cleanOrder==='original-first') {fs.renameSync(target,target+'.I2');fs.renameSync(target+'.I1',target);}
      observe(false);roundTripFakeStore();
      assert.equal(identities().length,1,'clean discharges only its own identity');
      assert.equal((await card()).ready,false);
      assert.equal((await f.resolve(await card(),'retry')).error,'working_file_saved_observation_required');
      assert.equal((await callIpcRaw('projects:prepare-package-review',f.id)).error,'working_file_choice_required');
      if(cleanOrder==='replacement-first') {fs.renameSync(target,target+'.I2');fs.renameSync(target+'.I1',target);}
      else {fs.renameSync(target,target+'.I1');fs.renameSync(target+'.I2',target);}
      observe(false);assert.deepEqual(f.stored().workingFileDirtyHolds.records,{});
      assert.equal((await f.resolve(await card(),'retry')).success,true);
      assert.equal((await f.resolve(await card())).success,true);
      assert.ok(fs.existsSync(target));assert.ok(fs.existsSync(target+(cleanOrder==='replacement-first'?'.I2':'.I1')));
    });
  }
  choiceTest('Replace refuses dirty successor arriving during actual required-predecessor rescan, then clean recovery commits atomically', {timeout:15000}, async()=>{
    const f=await setup('.psd');
    const shared=await f.add('Shared.png','shared asset');
    writeSyntheticAiFile(f.c,f.a+'\n'+shared);
    const operation=metadataTestHooks.captureProjectOperation(f.id);
    try {assert.equal((await metadataTestHooks.runScanOnOpen(f.id,f.c,operation.activationToken,operation,
      {allowPausedBaseline:true,verifySelectedSource:true,establishBaseline:false})).success,true);} finally {operation.close();}
    const d=await f.add('D.ai');
    assert.equal((await f.resolve((await f.workspace()).workingFileChoices.choices.find(item=>item.source.name==='D.ai'))).success,true);
    for(const action of ['exclude','restore']) {
      const row=(await f.workspace()).files.find(item=>item.name==='C.ai');
      assert.equal((await callIpcRaw('projects:set-working-source-selection',f.id,row.visualIdentity,
        {action,expectedRevision:row.selectionRevision})).success,true);
    }
    const b=await f.add('B.ai');
    const savedA=fs.readFileSync(f.a);savedA.writeUInt32BE(2,18);fs.writeFileSync(f.a,savedA);
    const originals=new Map([f.a,f.c,d,b,shared].map(p=>[p,fs.readFileSync(p)]));
    const card=(await f.workspace()).workingFileChoices.choices.find(item=>item.source.name==='B.ai');assert.ok(card.ready);
    const predecessor=card.predecessors.find(row=>row.name==='A.psd');assert.ok(predecessor);
    const aReceipt=metadataTestHooks.getWorkingSourceVerification(f.stored(),f.stored().files.find(row=>row.path===f.a));
    assert.equal(aReceipt.provider,'psd-agpsd-worker');
    assert.equal((await f.workspace()).files.find(row=>row.name==='A.psd').includedAsDependency,true,JSON.stringify([...metadataTestHooks.getWorkingSourceMembership(f.stored()).requiredByPath]));
    const observe=modified=>metadataTestHooks.mutateProject(f.id,project=>metadataTestHooks.stageLiveObservedFile(project,
      project.files.find(row=>row.path===b),{allowDirect:true,reason:'app-live-evidence',appFamily:'illustrator',liveEvidence:{
        source:'app-opened',observerMethod:'illustrator-active-session',evidenceStrength:'structured-app-document',sourceDocumentPath:b,documentModified:modified}}));
    let entered,release;const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    const unpause=metadataTestHooks.pausePsdExtraction(async()=>{entered();await gate;});
    let pending;
    try {
      pending=f.resolve(card,'replace',predecessor.visualIdentity);
      const boundary=await Promise.race([started.then(()=>({entered:true})),pending.then(result=>({earlyResult:result}))]);
      assert.equal(boundary.entered,true,JSON.stringify(boundary)); // Actual required-predecessor rescan.
      assert.equal(metadataTestHooks.getWorkingSourceVerification(f.stored(),f.stored().files.find(row=>row.path===f.a)).status,'pending');
      observe(true);release();
      const result=await pending;assert.equal(result.success,false,JSON.stringify(result));
    } finally {release();unpause();if(pending)await pending;}
    let ws=await f.workspace();
    for(const name of ['A.psd','B.ai','C.ai','D.ai'])assert.equal(ws.files.find(row=>row.name===name).sourceSelection,'selected',name);
    assert.equal(Object.values(f.stored().workingFileChoices.records).find(row=>row.id===card.id).acknowledged,false);
    assert.equal((await callIpcRaw('projects:prepare-package-review',f.id)).error,'working_file_choice_required');
    observe(false);assert.equal((await f.resolve(card,'replace',predecessor.visualIdentity)).success,false,'old request cannot replay');
    const current=(await f.workspace()).workingFileChoices.choices.find(item=>item.id===card.id);assert.ok(current.ready);
    const writes=[],originalSet=storeInstance.set;
    storeInstance.set=function(key,value,...args){
      if(key==='projects') {
        const project=value.find(item=>item.id===f.id);
        const pair=Object.values(project?.workingSourceContinuations?.pairs||{}).find(item=>item.choiceEventId===card.id&&item.decision?.choice==='replace');
        if(pair)writes.push(JSON.parse(JSON.stringify(project)));
      }
      return originalSet.call(this,key,value,...args);
    };
    try {assert.equal((await f.resolve(current,'replace',current.predecessors.find(row=>row.name==='A.psd').visualIdentity)).success,true);}
    finally {storeInstance.set=originalSet;}
    assert.ok(writes.length>0);
    assert.ok(writes.every(project=>Object.values(project.workingFileChoices.records).find(row=>row.id===card.id)?.acknowledged===true),
      'selection replacement and choice acknowledgement must appear in the same durable write');
    ws=await f.workspace();
    const a=ws.files.find(row=>row.name==='A.psd');assert.equal(a.sourceSelection,'excluded');assert.equal(a.includedAsDependency,true);
    for(const name of ['B.ai','C.ai','D.ai'])assert.equal(ws.files.find(row=>row.name===name).sourceSelection,'selected');
    assert.equal(ws.files.find(row=>row.name==='Shared.png').included,true);
    assert.equal(ws.workingFileChoices.remaining,0);
    for(const [p,bytes]of originals)assert.deepEqual(fs.readFileSync(p),bytes,'original source/asset bytes preserved');
    roundTripFakeStore();assert.equal((await f.workspace()).workingFileChoices.remaining,0);
  });

  for(const malformed of [null,{version:99,identity:'a'.repeat(64)},{version:2,identities:[]},{version:2,identities:['invalid']}]) {
    choiceTest(`dirty observation preserves malformed persisted obligation: ${JSON.stringify(malformed)}`,async()=>{
      const f=await setup(),target=await f.add('Persisted.ai');
      const row=()=>f.stored().files.find(item=>item.path===target);
      const route=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),row());
      const observe=modified=>metadataTestHooks.mutateProject(f.id,project=>metadataTestHooks.stageLiveObservedFile(project,row(),{
        allowDirect:true,reason:'app-live-evidence',appFamily:'illustrator',liveEvidence:{source:'app-opened',
          observerMethod:'illustrator-active-session',evidenceStrength:'structured-app-document',sourceDocumentPath:target,documentModified:modified}}));
      observe(true);f.stored().workingFileDirtyHolds.records[route]=malformed;roundTripFakeStore();
      observe(true);observe(false);roundTripFakeStore();
      assert.deepEqual(f.stored().workingFileDirtyHolds.records[route],malformed);
      const card=(await f.workspace()).workingFileChoices.choices[0];assert.equal(card.ready,false);
      assert.equal((await f.resolve(card,'retry')).error,'working_file_saved_observation_required');
    });
  }
  choiceTest('persisted version-one dirty identity migrates without rebinding and clears only on trusted clean',async()=>{
    const f=await setup(),target=await f.add('Legacy.ai');
    const row=()=>f.stored().files.find(item=>item.path===target);
    const route=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),row());
    const observe=modified=>metadataTestHooks.mutateProject(f.id,project=>metadataTestHooks.stageLiveObservedFile(project,row(),{
      allowDirect:true,reason:'app-live-evidence',appFamily:'illustrator',liveEvidence:{source:'app-opened',
        observerMethod:'illustrator-active-session',evidenceStrength:'structured-app-document',sourceDocumentPath:target,documentModified:modified}}));
    observe(true);const identity=f.stored().workingFileDirtyHolds.records[route].identities[0];
    f.stored().workingFileDirtyHolds.records[route]={version:1,identity};roundTripFakeStore();
    observe(true);assert.deepEqual(f.stored().workingFileDirtyHolds.records[route].identities,[identity]);
    assert.equal((await f.workspace()).workingFileChoices.choices[0].ready,false);
    observe(false);assert.deepEqual(f.stored().workingFileDirtyHolds.records,{});
    assert.equal((await f.resolve((await f.workspace()).workingFileChoices.choices[0])).success,true);
  });

  choiceTest('legacy ledger-only dirty observation remains an unknown obligation across new inode dirty and clean',async()=>{
    const f=await setup(),target=await f.add('LegacyUnknown.ai');
    const row=()=>f.stored().files.find(item=>item.path===target);
    const route=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),row());
    const observe=modified=>metadataTestHooks.mutateProject(f.id,project=>metadataTestHooks.stageLiveObservedFile(project,row(),{
      allowDirect:true,reason:'app-live-evidence',appFamily:'illustrator',liveEvidence:{source:'app-opened',
        observerMethod:'illustrator-active-session',evidenceStrength:'structured-app-document',sourceDocumentPath:target,documentModified:modified}}));
    observe(true);delete f.stored().workingFileDirtyHolds;roundTripFakeStore(); // Saved pre-hold schema.
    const inode=fs.statSync(target).ino;
    fs.renameSync(target,target+'.preserved');fs.writeFileSync(target,'%PDF-1.7\nreplacement\n%%EOF\n');
    assert.notEqual(fs.statSync(target).ino,inode);
    observe(true);observe(false);roundTripFakeStore();
    assert.deepEqual(f.stored().workingFileDirtyHolds.records[route]?.identities,[null],
      'a new physical binding cannot discharge an earlier unbound dirty buffer');
    const card=(await f.workspace()).workingFileChoices.choices[0];assert.equal(card.ready,false);
    assert.equal((await f.resolve(card,'retry')).error,'working_file_saved_observation_required');
    assert.equal((await callIpcRaw('projects:prepare-package-review',f.id)).error,'working_file_choice_required');
    assert.ok(fs.existsSync(target+'.preserved'));
  });

  for(const legacyContainer of ['absent','empty']) {
    choiceTest(`legacy dirty rename through registered add handler retains unknown obligation: ${legacyContainer}`,async()=>{
      const f=await setup(),target=await f.add('LegacyRename.ai');
      await callIpcRaw('projects:start-watching',f.id);clearTrackedTimers();
      await metadataTestHooks.refreshWorkingSourceLocators(f.id);
      const row=()=>f.stored().files.find(item=>item.path===target);
      const oldKey=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),row());
      assert.ok(f.stored().workingSourceLocators.records[oldKey]);
      const observe=(filePath,modified)=>metadataTestHooks.mutateProject(f.id,project=>metadataTestHooks.stageLiveObservedFile(project,
        project.files.find(item=>item.path===filePath),{allowDirect:true,reason:'app-live-evidence',appFamily:'illustrator',liveEvidence:{
          source:'app-opened',observerMethod:'illustrator-active-session',evidenceStrength:'structured-app-document',
          sourceDocumentPath:filePath,documentModified:modified}}));
      observe(target,true);
      if(legacyContainer==='absent')delete f.stored().workingFileDirtyHolds;
      else f.stored().workingFileDirtyHolds={version:1,records:{}};
      const evidenceKey=Object.keys(f.stored().liveEvidenceLedger.candidates).find(key=>
        f.stored().liveEvidenceLedger.candidates[key].latest?.candidateName==='LegacyRename.ai');
      assert.ok(evidenceKey);
      if(legacyContainer==='empty')delete f.stored().liveEvidenceLedger.candidates[evidenceKey].latest.documentModified;
      const legacyEvidence=JSON.parse(JSON.stringify(f.stored().liveEvidenceLedger.candidates[evidenceKey]));
      assert.equal(legacyEvidence.latest.needsSave,true);
      const provenanceNodes=JSON.parse(JSON.stringify(f.stored().provenance.nodes));
      roundTripFakeStore();
      const before=(await f.workspace()).workingFileChoices.choices.find(item=>item.source.name==='LegacyRename.ai');
      assert.equal(before.ready,false);
      const destination=target.replace('.ai','-Moved.ai'),bytes=fs.readFileSync(target),inode=fs.statSync(target).ino;
      fs.renameSync(target,destination);assert.equal(fs.statSync(destination).ino,inode);
      const writes=[],originalSet=storeInstance.set;
      storeInstance.set=function(key,value,...args){
        if(key==='projects') {
          const project=value.find(item=>item.id===f.id);
          if(project?.files.some(item=>item.path===destination))writes.push(JSON.parse(JSON.stringify(project)));
        }
        return originalSet.call(this,key,value,...args);
      };
      try {await emitWatcher('add',destination);clearTrackedTimers();}
      finally {storeInstance.set=originalSet;}
      const moved=f.stored().files.find(item=>item.path===destination);assert.ok(moved,'registered add handler recognizes real rename');
      const newKey=metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),moved);
      assert.notEqual(newKey,oldKey);assert.ok(writes.length);
      assert.ok(writes.every(project=>project.workingFileDirtyHolds?.records?.[newKey]?.identities?.includes(null)),
        'every durable moved-source write must already retain the unbound dirty obligation');
      assert.ok(writes.every(project=>!Object.hasOwn(project.workingFileDirtyHolds.records,oldKey)));
      assert.deepEqual(f.stored().workingFileDirtyHolds.records[newKey],{version:2,identities:[null]});
      assert.deepEqual(f.stored().liveEvidenceLedger.candidates[evidenceKey],legacyEvidence,'old evidence remains provenance');
      for(const [key,node]of Object.entries(provenanceNodes))assert.deepEqual(f.stored().provenance.nodes[key],node);
      // The watching activation may retire its old scope after locator commit.
      // A fresh ordinary production scan still cannot discharge editor state.
      const scanOperation=metadataTestHooks.captureProjectOperation(f.id);
      try {assert.equal((await metadataTestHooks.runScanOnOpen(f.id,destination,scanOperation.activationToken,scanOperation,
        {allowPausedBaseline:true,verifySelectedSource:true,establishBaseline:false})).success,true);}
      finally {scanOperation.close();}
      assert.equal(metadataTestHooks.getWorkingSourceVerification(f.stored(),moved).status,'scanned','ordinary rescan cannot clear editor obligation');
      assert.equal((await f.resolve(before)).success,false,'pre-rename choice token refuses');
      for(const modified of [false,true,false]) {
        observe(destination,modified);roundTripFakeStore();
        assert.ok(f.stored().workingFileDirtyHolds.records[newKey].identities.includes(null));
        const current=(await f.workspace()).workingFileChoices.choices.find(item=>item.id===before.id);
        assert.equal(current.ready,false);
        assert.equal((await f.resolve(current,'retry')).error,'working_file_saved_observation_required');
        assert.equal((await f.resolve(current)).success,false);
        assert.equal((await f.resolve(current,'replace',current.predecessors.find(item=>item.name==='A.ai').visualIdentity)).success,false);
        assert.equal((await callIpcRaw('projects:prepare-package-review',f.id)).error,'working_file_choice_required');
      }
      await callIpcRaw('projects:pause',f.id);roundTripFakeStore();
      await callIpcRaw('projects:start-watching',f.id);clearTrackedTimers();
      assert.equal((await f.workspace()).workingFileChoices.choices.find(item=>item.id===before.id).ready,false);
      assert.equal(f.stored().workingFileChoices.records[newKey].acknowledged,false);
      for(const name of ['A.ai','C.ai','LegacyRename-Moved.ai'])assert.equal((await f.workspace()).files.find(item=>item.name===name).sourceSelection,'selected');
      assert.deepEqual(fs.readFileSync(destination),bytes);assert.equal(fs.existsSync(target),false);
      await callIpcRaw('projects:pause',f.id);clearTrackedTimers();
    });
  }

  async function dirtyReturnFixture() {
    const f=await setup(),shared=await f.add('ReturnShared.png','shared bytes');
    writeSyntheticAiFile(f.c,f.a+'\n'+shared);
    const d=await f.add('ReturnD.ai',shared);
    assert.equal((await f.resolve((await f.workspace()).workingFileChoices.choices.find(item=>item.source.name==='ReturnD.ai'))).success,true);
    for(const action of ['exclude','restore']) {
      const row=(await f.workspace()).files.find(item=>item.name===path.basename(f.c));
      assert.equal((await callIpcRaw('projects:set-working-source-selection',f.id,row.visualIdentity,
        {action,expectedRevision:row.selectionRevision})).success,true);
    }
    const target=await f.add('ReturnDirty.ai',shared),moved=target.replace('.ai','-Moved.ai');
    await callIpcRaw('projects:start-watching',f.id);clearTrackedTimers();
    await metadataTestHooks.refreshWorkingSourceLocators(f.id);
    const row=filePath=>f.stored().files.find(item=>item.path===filePath);
    const route=filePath=>metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(),row(filePath));
    const observe=(filePath,modified)=>metadataTestHooks.mutateProject(f.id,project=>metadataTestHooks.stageLiveObservedFile(project,
      project.files.find(item=>item.path===filePath),{allowDirect:true,reason:'app-live-evidence',appFamily:'illustrator',liveEvidence:{
        source:'app-opened',observerMethod:'illustrator-active-session',evidenceStrength:'structured-app-document',
        sourceDocumentPath:filePath,documentModified:modified}}));
    const scan=async filePath=>{
      const op=metadataTestHooks.captureProjectOperation(f.id);
      try {assert.equal((await metadataTestHooks.runScanOnOpen(f.id,filePath,op.activationToken,op,
        {allowPausedBaseline:true,verifySelectedSource:true,establishBaseline:false})).success,true);}
      finally {op.close();}
    };
    const rename=async(from,to)=>{
      const ino=fs.statSync(from).ino;fs.renameSync(from,to);assert.equal(fs.statSync(to).ino,ino);
      await emitWatcher('add',to);clearTrackedTimers();assert.ok(row(to),'registered handler migrates the source');
    };
    const originals=new Map([f.a,f.c,d,target,shared].map(filePath=>[filePath,fs.readFileSync(filePath)]));
    const oldKey=route(target);
    observe(target,true);
    const evidenceKey=Object.keys(f.stored().liveEvidenceLedger.candidates).find(key=>
      f.stored().liveEvidenceLedger.candidates[key].latest?.candidateName==='ReturnDirty.ai');
    const history=JSON.parse(JSON.stringify(f.stored().liveEvidenceLedger.candidates[evidenceKey]));
    assert.equal(history.latest.documentModified,true);
    const originalCard=(await f.workspace()).workingFileChoices.choices.find(item=>item.source.name==='ReturnDirty.ai');
    await rename(target,moved);
    assert.deepEqual(f.stored().liveEvidenceLedger.candidates[evidenceKey],history,'first rename preserves exact dirty history');
    return {...f,shared,d,target,moved,route,observe,scan,rename,oldKey,evidenceKey,history,originalCard,originals};
  }
  for(const outcome of ['keep-both','replace']) {
    choiceTest(`dirty rename return recovers after trusted clean without resurrecting history: ${outcome}`,async()=>{
      const f=await dirtyReturnFixture();
      f.observe(f.moved,false);await f.scan(f.moved);roundTripFakeStore();
      assert.deepEqual(f.stored().workingFileDirtyHolds.records,{});
      const middle=(await f.workspace()).workingFileChoices.choices.find(item=>item.id===f.originalCard.id);assert.ok(middle.ready);
      await f.rename(f.moved,f.target);await f.scan(f.target);roundTripFakeStore();
      assert.deepEqual(f.stored().workingFileDirtyHolds.records,{},'return must not materialize a previously discharged dirty observation');
      let current=(await f.workspace()).workingFileChoices.choices.find(item=>item.id===f.originalCard.id);
      assert.equal(current.ready,true,'retained dirty history is not an outstanding obligation');
      f.observe(f.target,false);roundTripFakeStore();
      assert.deepEqual(f.stored().workingFileDirtyHolds.records,{},'trusted clean must not resurrect unknown history');
      await callIpcRaw('projects:pause',f.id);roundTripFakeStore();
      await callIpcRaw('projects:start-watching',f.id);clearTrackedTimers();
      current=(await f.workspace()).workingFileChoices.choices.find(item=>item.id===f.originalCard.id);assert.ok(current.ready);
      assert.equal((await f.resolve(f.originalCard)).success,false);assert.equal((await f.resolve(middle)).success,false);
      assert.equal((await f.resolve(current,'retry')).success,true);
      current=(await f.workspace()).workingFileChoices.choices.find(item=>item.id===f.originalCard.id);
      assert.equal((await f.resolve(current,outcome,outcome==='replace'?current.predecessors.find(item=>item.name==='A.ai').visualIdentity:null)).success,true);
      const ws=await f.workspace();assert.equal(ws.workingFileChoices.remaining,0);
      for(const filePath of [f.c,f.d,f.target])assert.equal(ws.files.find(item=>item.name===path.basename(filePath)).sourceSelection,'selected');
      const a=ws.files.find(item=>item.name===path.basename(f.a));assert.equal(a.sourceSelection,outcome==='replace'?'excluded':'selected');
      assert.equal(a.includedAsDependency,true);
      assert.equal(ws.files.find(item=>item.name===path.basename(f.shared)).included,true);
      const refs=[...metadataTestHooks.getWorkingSourceMembership(f.stored()).requiredByPath.values()].find(item=>item.path===f.shared);
      assert.ok([...refs.sources.values()].some(item=>item.path===f.c));assert.ok([...refs.sources.values()].some(item=>item.path===f.d));
      for(const [filePath,bytes]of f.originals)assert.deepEqual(fs.readFileSync(filePath),bytes);
      assert.ok((await callIpcRaw('projects:prepare-package-review',f.id)).token);
      await callIpcRaw('projects:pause',f.id);clearTrackedTimers();
    });
  }
  choiceTest('reused migrated path retains fresh legacy dirty obligation while original buffer stays unresolved',async()=>{
    const f=await dirtyReturnFixture(),movedKey=f.route(f.moved);
    const originalHold=JSON.parse(JSON.stringify(f.stored().workingFileDirtyHolds.records[movedKey]));
    const reused=await f.add('ReturnDirty.ai','new inode bytes');assert.equal(reused,f.target);
    assert.notEqual(fs.statSync(f.target).ino,fs.statSync(f.moved).ino);
    f.observe(f.target,true);
    // Persisted legacy import of this new observation has no bound hold.
    delete f.stored().workingFileDirtyHolds.records[f.route(f.target)];roundTripFakeStore();
    f.observe(f.target,false);roundTripFakeStore();
    assert.deepEqual(f.stored().workingFileDirtyHolds.records[f.route(f.target)].identities,[null]);
    assert.deepEqual(f.stored().workingFileDirtyHolds.records[movedKey],originalHold,'receipt/alias cannot clear another unresolved buffer');
    f.observe(f.moved,false);await f.scan(f.moved);
    const movedChoice=(await f.workspace()).workingFileChoices.choices.find(item=>item.id===f.originalCard.id);
    assert.equal((await f.resolve(movedChoice)).success,true);
    const current=(await f.workspace()).workingFileChoices.choices.find(item=>item.source.name==='ReturnDirty.ai');assert.equal(current.ready,false);
    assert.equal((await f.resolve(current,'retry')).error,'working_file_saved_observation_required');
    assert.equal((await f.resolve(current)).success,false);
    assert.equal((await callIpcRaw('projects:prepare-package-review',f.id)).error,'working_file_choice_required');
    await callIpcRaw('projects:pause',f.id);clearTrackedTimers();
  });
  choiceTest('malformed migrated dirty receipt cannot discard retained history on rename return',async()=>{
    const f=await dirtyReturnFixture();f.observe(f.moved,false);await f.scan(f.moved);
    f.stored().workingFileDirtyHolds.migratedEvidence={[f.oldKey]:{version:99,evidenceHash:'a'.repeat(64)}};
    roundTripFakeStore();await f.rename(f.moved,f.target);await f.scan(f.target);
    f.observe(f.target,false);roundTripFakeStore();
    assert.deepEqual(f.stored().workingFileDirtyHolds.records[f.oldKey].identities,[null]);
    const current=(await f.workspace()).workingFileChoices.choices.find(item=>item.id===f.originalCard.id);
    assert.equal(current.ready,false);assert.equal((await f.resolve(current,'retry')).error,'working_file_saved_observation_required');
    await callIpcRaw('projects:pause',f.id);clearTrackedTimers();
  });

}
