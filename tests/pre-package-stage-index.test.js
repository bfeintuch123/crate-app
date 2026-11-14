'use strict';
// The complete production pre-package handler, real owned filesystem fixtures,
// modeled OS metadata results. The synchronous batch and production deadlines stay unchanged.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), assert = require('./bounded-assert');
const root = process.env.CRATE_DIAGNOSTIC_SOURCE_ROOT || path.resolve(__dirname,'..');
assert.ok(root && path.isAbsolute(root));
const entry = path.join(root, 'tests/provenance-dual-write.test.js');
let source = fs.readFileSync(entry, 'utf8');
function replaceOnce(before, after) { assert.equal(source.split(before).length, 2, 'adapter drift'); source = source.replace(before, after); }
replaceOnce("const test = require('node:test');", "const discoveryTest = require('node:test'); const test = new Proxy(discoveryTest, { apply() {} });");
replaceOnce("fs.mkdtempSync(path.join(os.tmpdir(), 'crate-provenance-dual-write-home-'))", "fs.mkdtempSync(path.join(path.dirname(MAIN_UNDER_TEST_ROOT), 'index-stage-home-'))");
replaceOnce('if (!key) return this.data;', 'if (!key) return JSON.parse(JSON.stringify(this.data));');
replaceOnce('return cur === undefined ? fallback : cur;', 'return cur === undefined ? fallback : JSON.parse(JSON.stringify(cur));');
replaceOnce('  set(key, value) {', '  set(key, value) { value = value === undefined ? undefined : JSON.parse(JSON.stringify(value));');
replaceOnce('  captureProjectOperation,\n  runScanOnOpen', '  observeRecentStage(callback) { const prior = stageLiveObservedFile; stageLiveObservedFile = (...args) => { const result = prior(...args); callback(args,result); return result; }; return () => { stageLiveObservedFile = prior; }; },   isPackageScanInFlight(id) { return scanInFlight.has(id); },\n  captureProjectOperation,\n  runScanOnOpen');
source += '\n(' + cases.toString() + ')();\n';
const compiled = new Module(entry, module); compiled.filename = entry; compiled.paths = Module._nodeModulePaths(path.dirname(entry)); compiled._compile(source, entry);
function cases(){
  async function fixture(count){
    resetTestHomeWorkspace();storeInstance.set('quickPackageOutputPaths',[]);setChildProcessHandler(()=>({stdout:''}));const p=await createProject('Index integrity');await callIpcRaw('projects:pause',p.id);clearTrackedTimers();
    const folder=path.join(TEST_HOME,'Desktop','Owned');fs.mkdirSync(folder);const anchor=path.join(folder,'Anchor.ai');writeSyntheticAiFile(anchor);
    await setProjectFiles(p.id,{files:[{path:anchor,ext:'.ai',name:'Anchor.ai',source:'manual-browse'}]});
    const files=[];for(let i=0;i<count;i++){const file=path.join(folder,'Synthetic-'+String(i).padStart(4,'0')+'.png');fs.writeFileSync(file,'synthetic');files.push(file);}
    setChildProcessHandler(request=>{const paths=bulkXattrPaths(request);if(paths.length)return{stdout:formatBulkXattrOutput(paths,p=>encodeLastUsedXattr(Date.now()-(Number(path.basename(p).slice(10,14))%32===0?86400000:0)))};return{stdout:''};});
    return{p,folder,files};
  }
  for(const count of [4,773])discoveryTest('actual Conf full '+count+' pre-package handler admits unchanged recent sources', {timeout:20000},async()=>{
    const f=await fixture(count);await getProject(f.p.id);
    if(count===773)setChildProcessHandler(request=>{const paths=bulkXattrPaths(request);return paths.length?{stdout:formatBulkXattrOutput(paths,()=>encodeLastUsedXattr(Date.now()))}:{stdout:''};});
    const initial=JSON.parse(JSON.stringify(storeInstance.data));
    const Conf=originalLoad.call(Module,'conf',module),cwd=fs.mkdtempSync(path.join(TEST_HOME,'conf-handler-'));
    const backend=new Conf({cwd,projectName:'synthetic-handler',watch:false});backend.store=initial;
    const methods={get:storeInstance.get,set:storeInstance.set,delete:storeInstance.delete};
    storeInstance.get=backend.get.bind(backend);storeInstance.set=backend.set.bind(backend);storeInstance.delete=backend.delete.bind(backend);
    try{
      const started=Date.now(),result=await callIpcRaw('projects:pre-package-scan',f.p.id),expected=count===4?3:773;assert.equal(result.error,undefined);assert.equal(result.newCount,expected);
      const p=backend.get('projects').find(p=>p.id===f.p.id);assert.equal(p.pendingFiles.length,expected);assert.equal(p.files.length,1);
      assert.deepEqual(p.files,initial.projects.find(p=>p.id===f.p.id).files);
      console.log('ACTUAL_CONF_HANDLER '+JSON.stringify({candidateCount:count,recentCount:expected,admittedPending:expected,elapsedMs:Date.now()-started,acceptedSourcesUnchanged:true}));
    }finally{storeInstance.data=JSON.parse(JSON.stringify(backend.store));Object.assign(storeInstance,methods);clearTrackedTimers();}
  });
  discoveryTest('synchronous recent staging keeps pending membership and final package output exact', {timeout:30000},async()=>{
    const f=await fixture(70);await getProject(f.p.id);
    const initial=JSON.parse(JSON.stringify(storeInstance.data));
    const Conf=originalLoad.call(Module,'conf',module),cwd=fs.mkdtempSync(path.join(TEST_HOME,'conf-stage-index-'));
    const backend=new Conf({cwd,projectName:'synthetic-stage-index',watch:false});backend.store=initial;
    const methods={get:storeInstance.get,set:storeInstance.set,delete:storeInstance.delete};
    storeInstance.get=backend.get.bind(backend);storeInstance.set=backend.set.bind(backend);storeInstance.delete=backend.delete.bind(backend);
    let stageCalls=0;
    const restore=metadataTestHooks.observeRecentStage(()=>{stageCalls++;});
    try{
      const result=await callIpcRaw('projects:pre-package-scan',f.p.id);
      assert.equal(result.error,undefined);assert.equal(stageCalls,67);
      assert.deepEqual(result.files.map(file=>file.path),[path.join(TEST_HOME,'Desktop','Owned','Anchor.ai')]);
      const current=backend.get('projects').find(project=>project.id===f.p.id);
      const admittedPaths=(current.pendingFiles||[]).map(file=>file.path);
      assert.equal(admittedPaths.length,67,'all recent candidates remain pending');
      assert.equal(admittedPaths.filter(filePath=>filePath===f.files[34]).length,1,'pending candidates are not duplicated');
      assert.equal(new Set(admittedPaths).size,67,'synchronous staging preserves path uniqueness');
      assert.deepEqual(current.files.map(file=>file.path),[path.join(TEST_HOME,'Desktop','Owned','Anchor.ai')],'weak discovery never promotes pending images to accepted project files');
      const out=path.join(TEST_HOME,'StageIndexPackageOutput');fs.mkdirSync(out,{recursive:true});
      const review=await callIpcRaw('projects:prepare-package-review',f.p.id,out);
      assert.equal(review.materializable,true,JSON.stringify(review));assert.equal(review.totalFiles,1);
      assert.deepEqual(review.files.map(file=>file.name),['Anchor.ai'],'fresh package review includes only the accepted anchor');
      const packaged=await callIpcRaw('projects:package',f.p.id,out,review.token);
      assert.equal(packaged.success,true,JSON.stringify(packaged));assert.equal(packaged.totalFiles,1);assert.equal(packaged.copiedCount+packaged.embeddedCount,1);
      const reviewedFolder=review.files[0].packageFolder==='Package root'?packaged.folderPath:path.join(packaged.folderPath,review.files[0].packageFolder);
      assert.deepEqual(fs.readFileSync(path.join(reviewedFolder,'Anchor.ai')),fs.readFileSync(path.join(TEST_HOME,'Desktop','Owned','Anchor.ai')),'package bytes match the accepted source');
      const outputNames=fs.readdirSync(packaged.folderPath,{recursive:true}).map(name=>path.basename(name));
      assert.ok(!outputNames.includes(path.basename(f.files[34])),'a pending discovered image is not written into the package');
      console.log('STAGE_INDEX_PACKAGE '+JSON.stringify({candidateCount:70,recentCount:67,stageCalls,uniquePending:admittedPaths.length,packageFiles:packaged.totalFiles,acceptedSourceUnchanged:true}));
    }finally{
      restore();storeInstance.data=JSON.parse(JSON.stringify(backend.store));Object.assign(storeInstance,methods);clearTrackedTimers();
    }
  });

  discoveryTest('actual Conf stage-index pruning preserves active evidence and evicts the exact oldest inactive entries', {timeout:20000},async()=>{
    const f=await fixture(4);await getProject(f.p.id);
    const anchor=path.join(f.folder,'Anchor.ai'),base=Date.now()+200000,orphans=[];
    for(let i=0;i<499;i++){
      const orphanPath=path.join(TEST_HOME,'Documents','inactive-'+String(i).padStart(4,'0')+'.png');
      orphans.push(makeLiveEvidenceLedgerEntry(orphanPath,'package-ready',base+i));
    }
    const anchorEntry=makeLiveEvidenceLedgerEntry(anchor,'ignored',base-1000);
    const seededCandidates=Object.fromEntries([...orphans,anchorEntry]);
    await setProjectFiles(f.p.id,{files:[{path:anchor,ext:'.ai',name:'Anchor.ai',source:'manual-browse'}],liveEvidenceLedger:{schemaVersion:1,candidates:seededCandidates}});
    const initial=JSON.parse(JSON.stringify(storeInstance.data));
    const Conf=originalLoad.call(Module,'conf',module),cwd=fs.mkdtempSync(path.join(TEST_HOME,'conf-stage-index-prune-'));
    const backend=new Conf({cwd,projectName:'synthetic-stage-index-prune',watch:false});backend.store=initial;
    const methods={get:storeInstance.get,set:storeInstance.set,delete:storeInstance.delete};
    storeInstance.get=backend.get.bind(backend);storeInstance.set=backend.set.bind(backend);storeInstance.delete=backend.delete.bind(backend);
    let stagingProject=null;
    const restore=metadataTestHooks.observeRecentStage(args=>{stagingProject ||= args[0];});
    try{
      const result=await callIpcRaw('projects:pre-package-scan',f.p.id);
      assert.equal(result.error,undefined);assert.equal(result.newCount,3);
      const current=backend.get('projects').find(project=>project.id===f.p.id),ledger=stagingProject.liveEvidenceLedger;
      const retained=new Set(Object.keys(ledger.candidates));
      const activePaths=[anchor,...f.files.slice(1)];
      const activeKeys=activePaths.map(liveEvidenceKeyForTest);
      activeKeys.forEach((key,index)=>assert.ok(retained.has(key),`accepted source or pending candidate evidence remains protected: ${path.basename(activePaths[index])}`));
      assert.equal(ledger.candidateLimit,EXPECTED_LIVE_EVIDENCE_CANDIDATE_CAP);
      assert.equal(retained.size,EXPECTED_LIVE_EVIDENCE_CANDIDATE_CAP);
      const oldestInactive=orphans.slice(0,3).map(([key])=>key);
      for(const key of oldestInactive)assert.equal(retained.has(key),false,'oldest unprotected entries are evicted first');
      const expectedRetained=[...Object.keys(seededCandidates),...f.files.slice(1).map(liveEvidenceKeyForTest)].filter(key=>!oldestInactive.includes(key)).sort();
      assert.deepEqual([...retained].sort(),expectedRetained,'pruning preserves the exact expected evidence-key set');
      assert.deepEqual(current.files.map(file=>file.path),[anchor]);
      assert.equal(current.pendingFiles.length,3);
      assert.deepEqual(Object.keys(current.liveEvidenceLedger.candidates).sort(),Object.keys(seededCandidates).sort(),'request-local staging evidence remains unpersisted, matching the pre-index path');
      console.log('STAGE_INDEX_PRUNE '+JSON.stringify({seededEntries:500,stagedCandidates:3,retainedEntries:retained.size,activeEntriesProtected:true,oldestInactiveEvicted:3,persistedLedgerUnchanged:true,acceptedFilesUnchanged:true}));
    }finally{restore();storeInstance.data=JSON.parse(JSON.stringify(backend.store));Object.assign(storeInstance,methods);clearTrackedTimers();}
  });

  discoveryTest('non-index evidence pruning preserves the current pre-append admission key', {timeout:20000},async()=>{
    resetTestHomeWorkspace();setChildProcessHandler(()=>({stdout:''}));
    const project=await createProject('No-index evidence protection');await getProject(project.id);
    const futureBase=Date.now()+10000,oldEntries=[];
    for(let i=0;i<EXPECTED_LIVE_EVIDENCE_CANDIDATE_CAP;i++){
      const oldPath=path.join(TEST_HOME,'Documents','protected-history-'+String(i).padStart(4,'0')+'.ai');
      oldEntries.push(makeLiveEvidenceLedgerEntry(oldPath,'package-ready',futureBase+i));
    }
    await setProjectFiles(project.id,{files:[],pendingFiles:[],liveEvidenceLedger:{schemaVersion:1,candidates:Object.fromEntries(oldEntries)}});
    const initial=JSON.parse(JSON.stringify(storeInstance.data));
    const Conf=originalLoad.call(Module,'conf',module),cwd=fs.mkdtempSync(path.join(TEST_HOME,'conf-no-index-extra-key-'));
    const backend=new Conf({cwd,projectName:'synthetic-no-index-extra-key',watch:false});backend.store=initial;
    const methods={get:storeInstance.get,set:storeInstance.set,delete:storeInstance.delete};
    storeInstance.get=backend.get.bind(backend);storeInstance.set=backend.set.bind(backend);storeInstance.delete=backend.delete.bind(backend);
    const filePath=path.join(TEST_HOME,'Desktop','FreshAdmission.ai');writeSyntheticAiFile(filePath);
    try{
      const now=Date.now()+1000;
      await emitWatcherWithStats('add',filePath,{mtimeMs:now,birthtimeMs:now});
      const fresh=await waitForProject(project.id,item=>item.files.some(file=>file.path===filePath),5000);
      const currentKey=liveEvidenceKeyForTest(filePath),candidates=fresh.liveEvidenceLedger.candidates;
      assert.ok(candidates[currentKey],'the just-recorded pre-append evidence is protected through bounded pruning');
      assert.equal(Object.keys(candidates).length,EXPECTED_LIVE_EVIDENCE_CANDIDATE_CAP);
      assert.equal(Object.prototype.hasOwnProperty.call(candidates,oldEntries[0][0]),false,'an older unprotected history entry is evicted instead');
      console.log('NO_INDEX_EXTRA_KEY '+JSON.stringify({seededEntries:EXPECTED_LIVE_EVIDENCE_CANDIDATE_CAP,currentAdmissionRetained:true,oldHistoryEvicted:true,ledgerCount:Object.keys(candidates).length}));
    }finally{storeInstance.data=JSON.parse(JSON.stringify(backend.store));Object.assign(storeInstance,methods);clearTrackedTimers();}
  });
}
