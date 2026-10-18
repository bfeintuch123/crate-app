'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadProjectedWorkspace } = require('./opus-renderer-helpers');
function fixture({ pending = [], files = [], counts = {}, blocked = false } = {}) {
  const project = {id:'opus-corrections',status:'watching',files:[],pendingFiles:pending,excludedAssetKeys:[]};
  const workspace = {projectId:project.id,files,pendingFiles:pending.map((file,sourceIndex)=>({name:file.name,ext:file.ext,sourceIndex,visualIdentity:`pending-${sourceIndex}`,protectedSource:true,excluded:false})),semanticCounts:{selectedWorkingSources:1,excludedWorkingSources:0,includedAssets:2,excludedAssets:0,...counts},workingSourceSelectionBlocked:blocked};
  return loadProjectedWorkspace(project,workspace);
}
for (let mask=1;mask<8;mask++) test(`package warning keeps independent blocking facts, combination ${mask}`,()=>{
  const counts={unresolvedVerification:mask&1?2:0,missingRequiredReferences:mask&2?3:0,relationshipHolds:mask&4?1:0};
  for (const pending of [[],[{name:'Unrelated.pptx',ext:'.pptx',captureState:'observed'}]]) {
    const f=fixture({pending,counts,blocked:true}), warning=f.elements['project-package-warning'];
    assert.equal(warning.classList.contains('hidden'),false);
    assert.match(warning.textContent,/Package blocked.*Review working files and required assets/);
    assert.equal(warning.textContent.includes('2 working files need verification'),!!(mask&1));
    assert.equal(warning.textContent.includes('3 required links unavailable'),!!(mask&2));
    assert.equal(warning.textContent.includes('1 unresolved file relationship'),!!(mask&4));
    assert.doesNotMatch(warning.textContent,/Unrelated/);
    assert.doesNotMatch(f.elements['project-linking-alert'].textContent,/verification|blocked/);
    if(!pending.length) assert.equal(f.elements['project-review-eyebrow'].textContent,'Package needs review');
  }
});
test('pending count and capture consequences share one atomic status region',()=>{
  const raw={name:'Opened.pptx',ext:'.pptx',captureState:'observed'};
  const one=fixture({pending:[raw]}),two=fixture({pending:[raw,{name:'Saved.key',ext:'.key',captureState:'needs-save'}]});
  assert.equal(one.elements['project-review-eyebrow'].textContent,'1 file needs review');
  assert.equal(two.elements['project-review-eyebrow'].textContent,'2 files need review');
  assert.match(two.elements['project-linking-alert'].textContent,/Opened.pptx.*1 more/);
  const saved=fixture({pending:[{...raw,captureState:'needs-save',captureEvidence:{appFamily:'powerpoint'}}]});
  assert.match(saved.elements['project-review-detail'].textContent,/Save to make package-ready.*Not in the package/);
  assert.doesNotMatch(saved.elements['project-review-detail'].textContent,/\. ·/);
  const html=fs.readFileSync(path.join(__dirname,'../renderer/index.html'),'utf8');
  assert.match(html,/id="project-review-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.match(html,/id="project-package-warning"[^>]*role="status"/);
  two.renderer.openAssetReviewWorkspace();
  assert.equal(two.document.activeElement,two.elements['asset-review-heading']);
  two.renderer.closeAssetReviewWorkspace();
  assert.equal(two.document.activeElement,two.elements['btn-review-assets']);
});
for (const virtual of [false,true]) test(`all-nested mixed origins retain categories, counts and source context (${virtual?'virtual':'physical'})`,()=>{
  const source={name:virtual?'Cloud board':'Source.ai',ext:virtual?'.fig':'.ai',visualIdentity:virtual?'figma-source:cloud':'root',virtualFigmaSource:virtual,projectRole:'source',protectedSource:true,included:true,sourceSelection:'selected'};
  // A virtual source is normally generated from tracked files; feed logical rows
  // directly here to exercise the same hierarchy algorithm independently of that path.
  const children=['existing','added'].map((assetOrigin,index)=>({name:`Image-${index}.png`,ext:'.png',visualIdentity:`asset-${index}`,projectRole:'asset',included:true,assetOrigin,sourceName:source.name,...(virtual?{figmaSourceIdentity:'cloud'}:{requiredSourceIdentities:['root']})}));
  const f=fixture({files:[source,...children]});
  if(virtual){f.renderer.testSource=source;require('node:vm').runInContext('state.assetReviewLogicalItems.working=[testSource]',f.renderer);f.renderer.renderAssetPanelList(f.elements['working-assets-list'],f.renderer.testProject,[source],{protectedSource:true});f.filter('all');}
  const nested=f.elements['working-assets-list'].children[0].querySelector('.working-source-assets');
  assert.ok(nested);
  assert.equal(nested.__assetReviewVirtualState.items.length,2);
  assert.match(f.text(nested),/Existing/); assert.match(f.text(nested),/Added/);
  for(const category of ['existing','added']) {
    assert.equal(f.elements[`${category}-assets-section`].classList.contains('hidden'),true);
    assert.equal(f.elements[`${category}-assets-count`].textContent,'0');
  }
  assert.equal(f.elements['asset-review-batch-controls'].parentElement,f.elements['existing-batch-slot']);
  f.filter('added'); assert.equal(nested.__assetReviewVirtualState.items.length,1);assert.equal(nested.__assetReviewVirtualState.items[0].assetOrigin,'added');
  f.filter('existing','Image-0');assert.equal(nested.__assetReviewVirtualState.items.length,1);
  f.filter('all','no-match');assert.equal(f.elements['asset-review-empty'].textContent,'No files match your search.');assert.equal(f.elements['asset-review-empty'].classList.contains('hidden'),false);
  f.filter('all');assert.equal(nested.__assetReviewVirtualState.items.length,2);
  const child=nested.children.find(row=>row.dataset.renderKey);
  child.dispatchEvent({type:'keydown',key:'Enter',preventDefault(){},target:child});
  assert.equal(require('node:vm').runInContext('state.assetReviewSelectedKey',f.renderer),child.dataset.renderKey);
  f.renderer.testWorkspace.files=[];f.renderer.renderAssetWorkspace(f.renderer.testProject,{},[]);
  assert.equal(f.elements['working-assets-list'].children.some(row=>row.querySelector('.working-source-assets')),false);
});
test('standalone section counts only standalone rows and empty filters explain the result',()=>{
  const f=fixture({files:[{name:'Root.ai',ext:'.ai',visualIdentity:'root',projectRole:'source',included:true},{name:'Nested.png',visualIdentity:'nested',assetOrigin:'added',included:true,requiredSourceIdentities:['root']},{name:'Standalone.png',visualIdentity:'standalone',assetOrigin:'added',included:true}]});
  assert.equal(f.elements['added-assets-count'].textContent,'1');
  assert.equal(f.elements['metric-added-count'].textContent,'2');
  f.filter('existing');assert.equal(f.elements['asset-review-empty'].textContent,'No existing assets.');
  f.filter('missing');assert.equal(f.elements['asset-review-empty'].textContent,'No files need review.');
});
