'use strict';
// Production trusted IPC, package plan, descriptor writer and ZIP resolution.
// Only desktop collectors are stubbed. Archives and filesystem IO are real.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const harnessPath=path.join(__dirname,'provenance-dual-write.test.js');
let harness=fs.readFileSync(harnessPath,'utf8').replace("const test = require('node:test');","const repairTest = require('node:test'); const test = new Proxy(repairTest, { apply() {} });");
const compiled=new Module(harnessPath,module);compiled.filename=harnessPath;compiled.paths=Module._nodeModulePaths(__dirname);compiled._compile(harness+'\n('+cases.toString()+')();',harnessPath);
function cases(){
 function realUnzip(){setChildProcessHandler(({kind,command,args})=>{
  if(kind==='execFile'&&command==='/usr/bin/unzip'){const r=realSpawnSync(command,args,{encoding:args[0]==='-l'?'utf8':null});if(r.status!==0)throw new Error('fixture unzip failed');return {stdout:r.stdout,stderr:r.stderr};}
  return {stdout:'',stderr:''};
 });}
 function deck(root,name,target,media=[]){
  const staging=path.join(root,'zip-'+name);fs.mkdirSync(path.join(staging,'ppt/slides/_rels'),{recursive:true});fs.mkdirSync(path.join(staging,'ppt/media'),{recursive:true});
  const relationship=target?`<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}" TargetMode="External"/>`:'';
  fs.writeFileSync(path.join(staging,'ppt/slides/_rels/slide1.xml.rels'),`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship}</Relationships>`);
  fs.writeFileSync(path.join(staging,'ppt/slides/slide1.xml'),'<slide/>');for(const item of media)fs.writeFileSync(path.join(staging,'ppt/media',item.name),item.data);
  const targetPath=path.join(root,name+'.pptx');const result=realSpawnSync('/usr/bin/zip',['-q','-r',targetPath,'ppt'],{cwd:staging});assert.equal(result.status,0);return targetPath;
 }
 for(const layout of ['flat','by-extension-v1'])repairTest('PPTX linked image copied and relationship survives relocation ('+layout+')',async()=>{
  resetTestHomeWorkspace();realUnzip();const root=fs.mkdtempSync(path.join(TEST_HOME,'Desktop','portable-'));const image=path.join(root,'linked green.png');fs.writeFileSync(image,Buffer.from('green linked media'.repeat(80)));const source=deck(root,'Linked','file:////'+image.slice(1));const original=fs.readFileSync(source);const out=path.join(root,'out');fs.mkdirSync(out);
  storeInstance.data.settings.packageOutputLayoutMode=layout;
  const project=await createProject('Portable linked');await callIpcRaw('projects:pause',project.id);manualDialogFor([source]);await callIpcRaw('projects:add-files',project.id);
  const included=await callIpcRaw('projects:set-existing-assets-decision',project.id,'include');assert.equal(included.success,true);
  const fresh=await getProject(project.id);assert.ok(fresh.files.some(f=>f.path===image),'external linked image discovered');
  const review=await callIpcRaw('projects:prepare-package-review',project.id,out);assert.equal(review.materializable,true,JSON.stringify(review));
  const result=await callIpcRaw('projects:package',project.id,out,review.token);assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.copiedCount+result.embeddedCount,review.totalFiles);
  const packaged=path.join(result.folderPath,layout==='flat'?'Linked.pptx':'PPTX/Linked.pptx');const {inspectLinks}=require('../parsers/ooxml-links');const relocated=path.join(root,'relocated');fs.cpSync(result.folderPath,relocated,{recursive:true});fs.renameSync(image,image+'.unavailable');const relocatedDeck=path.join(relocated,path.relative(result.folderPath,packaged));const link=inspectLinks(fs.readFileSync(relocatedDeck),relocatedDeck)[0];assert.ok(fs.existsSync(link.resolvedPath));assert.deepEqual(fs.readFileSync(link.resolvedPath),Buffer.from('green linked media'.repeat(80)));assert.deepEqual(fs.readFileSync(source),original);
 });
 for(const restored of [false,true])repairTest('excluded embedded image across reconstructed persisted deck identities, restored='+restored,async()=>{
  resetTestHomeWorkspace();realUnzip();const root=fs.mkdtempSync(path.join(TEST_HOME,'Desktop','exclude-'));const bytes=Buffer.from('excluded exact JPEG'.repeat(80));const a=deck(root,'A',null,[{name:'image2.jpeg',data:bytes}]);const c=deck(root,'C',null,[{name:'image2.jpeg',data:bytes}]);const out=path.join(root,'out');fs.mkdirSync(out);
  const project=await createProject('Exclude across deck names');await callIpcRaw('projects:pause',project.id);manualDialogFor([a]);await callIpcRaw('projects:add-files',project.id);await callIpcRaw('projects:set-existing-assets-decision',project.id,'include');
  const stored=storeInstance.data.projects.find(p=>p.id===project.id);const asset=stored.files.find(f=>f.source==='scan-on-save-presentation');assert.ok(asset);await callIpcRaw('projects:remove-file',project.id,asset.fileId||asset.path);
  if(restored)await callIpcRaw('projects:remove-file',project.id,asset.fileId||asset.path);
  // Same persisted excluded output, selected document has a new disk identity.
  stored.files=stored.files.filter(f=>f.path!==a);stored.files.unshift({path:c,name:path.basename(c),ext:'.pptx',source:'manual-browse'});
  storeInstance.data.projects=JSON.parse(JSON.stringify(storeInstance.data.projects));
  const review=await callIpcRaw('projects:prepare-package-review',project.id,out);assert.equal(review.materializable,true,JSON.stringify(review));const result=await callIpcRaw('projects:package',project.id,out,review.token);assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.embeddedCount,0);assert.equal(result.copiedCount,restored?2:1);assert.equal(review.totalFiles,restored?2:1);
 });
 repairTest('missing declared PPTX link blocks review rather than producing a broken package',async()=>{
  resetTestHomeWorkspace();realUnzip();const root=fs.mkdtempSync(path.join(TEST_HOME,'Desktop','missing-link-'));
  const source=deck(root,'Missing','file:////'+path.join(root,'absent.png').slice(1));const out=path.join(root,'out');fs.mkdirSync(out);
  const project=await createProject('Missing external link');await callIpcRaw('projects:pause',project.id);manualDialogFor([source]);await callIpcRaw('projects:add-files',project.id);
  const review=await callIpcRaw('projects:prepare-package-review',project.id,out);assert.ok(review.error||review.materializable===false);assert.ok(!review.token);assert.deepEqual(fs.readdirSync(out),[]);
 });
 repairTest('changed linked image invalidates review, fresh review uses new bytes',async()=>{
  resetTestHomeWorkspace();realUnzip();const root=fs.mkdtempSync(path.join(TEST_HOME,'Desktop','changed-link-'));const image=path.join(root,'changed.png');fs.writeFileSync(image,'first saved image');
  const source=deck(root,'Changed','file:////'+image.slice(1));const out=path.join(root,'out');fs.mkdirSync(out);
  const project=await createProject('Changed linked image');await callIpcRaw('projects:pause',project.id);manualDialogFor([source]);await callIpcRaw('projects:add-files',project.id);await callIpcRaw('projects:set-existing-assets-decision',project.id,'include');
  const review=await callIpcRaw('projects:prepare-package-review',project.id,out);assert.equal(review.materializable,true);
  fs.writeFileSync(image,'new saved image bytes');const stale=await callIpcRaw('projects:package',project.id,out,review.token);assert.equal(stale.error,'package_review_changed');assert.deepEqual(fs.readdirSync(out),[]);
  const fresh=await callIpcRaw('projects:prepare-package-review',project.id,out);assert.equal(fresh.materializable,true);const result=await callIpcRaw('projects:package',project.id,out,fresh.token);assert.equal(result.success,true,JSON.stringify(result));
  const {inspectLinks}=require('../parsers/ooxml-links');const packaged=path.join(result.folderPath,'Changed.pptx');const link=inspectLinks(fs.readFileSync(packaged),packaged)[0];assert.equal(fs.readFileSync(link.resolvedPath,'utf8'),'new saved image bytes');
 });

 for(const ext of ['.psd','.ai','.indd','.key'])repairTest('shared asset exclusion and explicit restore across '+ext+' cache identities',async()=>{
  resetTestHomeWorkspace();const root=fs.mkdtempSync(path.join(TEST_HOME,'Desktop','shared-exclusion-'));const a=path.join(root,'A.png'),b=path.join(root,'B.png');fs.writeFileSync(a,'same shared raster bytes');fs.copyFileSync(a,b);const out=path.join(root,'out');fs.mkdirSync(out);
  const project=await createProject('Shared exclusions '+ext);await callIpcRaw('projects:pause',project.id);
  const stored=storeInstance.data.projects.find(p=>p.id===project.id);stored.assetBaseline={schemaVersion:1,status:'included',decision:'include',establishedAt:Date.now()};stored.files=[{path:a,name:'A.png',ext:'.png',source:'scan-on-save-presentation',projectRole:'asset',parentFile:path.join(root,'A'+ext)},{path:b,name:'B.png',ext:'.png',source:'scan-on-save-presentation',projectRole:'asset',parentFile:path.join(root,'B'+ext)}];
  await callIpcRaw('projects:remove-file',project.id,a);storeInstance.data.projects=JSON.parse(JSON.stringify(storeInstance.data.projects));
  const excluded=await callIpcRaw('projects:prepare-package-review',project.id,out);assert.equal(excluded.totalFiles,0,JSON.stringify(excluded));
  await callIpcRaw('projects:remove-file',project.id,b);const restored=await callIpcRaw('projects:prepare-package-review',project.id,out);assert.equal(restored.materializable,true,JSON.stringify(restored));assert.equal(restored.totalFiles,1);assert.equal(restored.files[0].name,'B.png');
 });
 repairTest('package review includes every planned media output and completion count agrees',async()=>{
  resetTestHomeWorkspace();realUnzip();const root=fs.mkdtempSync(path.join(TEST_HOME,'Desktop','late-derived-'));const source=deck(root,'Derived',null,[{name:'image1.jpeg',data:Buffer.from('derived JPEG'.repeat(100))}]);const out=path.join(root,'out');fs.mkdirSync(out);
  const project=await createProject('Derived media count');await callIpcRaw('projects:pause',project.id);manualDialogFor([source]);await callIpcRaw('projects:add-files',project.id);await callIpcRaw('projects:set-existing-assets-decision',project.id,'include');const stored=storeInstance.data.projects.find(p=>p.id===project.id);stored.files=stored.files.filter(f=>f.path===source);
  const review=await callIpcRaw('projects:prepare-package-review',project.id,out);assert.equal(review.materializable,true,JSON.stringify(review));assert.equal(review.files.length,2);assert.equal(review.totalFiles,2);const result=await callIpcRaw('projects:package',project.id,out,review.token);assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.totalFiles,2);assert.equal(result.copiedCount+result.embeddedCount,review.totalFiles);
 });

 repairTest('PSD virtual embedded resources preserve content exclusion and explicit alias restore',async()=>{
  resetTestHomeWorkspace();const root=fs.mkdtempSync(path.join(TEST_HOME,'Desktop','psd-resource-exclusion-'));const a=path.join(root,'A.psd'),b=path.join(root,'B.psd');fs.writeFileSync(a,'fixture PSD A');fs.writeFileSync(b,'fixture PSD B');const out=path.join(root,'out');fs.mkdirSync(out);
  currentPsdFixture={children:[],linkedFiles:[{name:'Shared.png',data:Buffer.from('same PSD embedded smart-object bytes')}]};
  const project=await createProject('PSD resource exclusions');await callIpcRaw('projects:pause',project.id);const stored=storeInstance.data.projects.find(p=>p.id===project.id);stored.assetBaseline={schemaVersion:1,status:'included',decision:'include',establishedAt:Date.now()};stored.files=[a,b].map((parent,i)=>({path:parent,parentPsd:parent,name:'Shared.png',ext:'.png',embedded:true,embeddedIndex:0,embeddedOriginalName:'Shared.png',fileId:'resource-'+i,source:'scan-on-save-embedded',projectRole:'asset'}));
  await callIpcRaw('projects:remove-file',project.id,'resource-0');storeInstance.data.projects=JSON.parse(JSON.stringify(storeInstance.data.projects));const excluded=await callIpcRaw('projects:prepare-package-review',project.id,out);assert.equal(excluded.totalFiles,0,JSON.stringify(excluded));
  await callIpcRaw('projects:remove-file',project.id,'resource-1');const review=await callIpcRaw('projects:prepare-package-review',project.id,out);assert.equal(review.materializable,true,JSON.stringify(review));assert.equal(review.totalFiles,1);const result=await callIpcRaw('projects:package',project.id,out,review.token);assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.totalFiles,1);assert.equal(fs.readFileSync(path.join(result.folderPath,'Shared.png'),'utf8'),'same PSD embedded smart-object bytes');
 });

}
