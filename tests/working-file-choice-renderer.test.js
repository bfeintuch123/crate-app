'use strict';
// Execute the complete production renderer with the existing modeled DOM and
// deferred bridge responses. This is not installed-app or visual acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const sharedPath = path.join(__dirname, 'renderer-figma-scope.test.js');
const shared = fs.readFileSync(sharedPath, 'utf8');
const scope = { require: createRequire(sharedPath), __dirname, console, setTimeout, clearTimeout };
vm.createContext(scope);
vm.runInContext(shared.slice(0, shared.indexOf('\ntest(')), scope);
const clone = value => JSON.parse(JSON.stringify(value));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function fixture() {
  const dom = scope.createInteractiveRendererDom();
  const projects = ['a','b'].map(id => ({ id, name: `Project ${id}`, status: 'paused', files: [], pendingFiles: [], excludedAssetKeys: [] }));
  const workspaces = new Map(projects.map(p => [p.id, { projectId: p.id, files: [], pendingFiles: [], workingFileChoices: { version: 1, blocked: true, choices: [
    { id: `choice-${p.id}`, revision: 'r1', ready: true, source: { name: 'New.ai' }, predecessors: [{ visualIdentity: `prior-${p.id}`, name: 'Prior.ai' }] },
    { id: `unverified-${p.id}`, revision: 'u1', ready: false, source: { name: 'Unsaved.ai' }, predecessors: [] },
  ] } }]));
  const calls = [], reads = [], toasts = [];
  let nextRead = null;
  const renderer = scope.loadRendererHelpers(dom.document, { crate: {
    getSettings: async () => ({}), getFigmaStatus: async () => ({}),
    getAssetWorkspace: async id => { reads.push(id); if (nextRead) { const read = nextRead; nextRead = null; return read.promise; } return clone(workspaces.get(id)); },
    resolveWorkingFileChoice: (id, payload) => { const wait = deferred(); calls.push({ id, payload: clone(payload), ...wait }); return wait.promise; },
  } });
  renderer.testProjects = projects;
  vm.runInContext("state.projects=testProjects; setSelectedProject('a'); accountStatus={revision:1,state:'signed_in',canUseWorkspace:true,identity:{id:'A'}}; state.packageReviewToken='old-token';", renderer);
  renderer.showToast = message => toasts.push(message);
  await renderer.switchTab('current-project');
  const evaluate = code => vm.runInContext(code, renderer);
  const entry = () => evaluate('state.assetWorkspace.workingFileChoices.choices[0]');
  const start = (choice = 'keep-both') => renderer.submitWorkingFileChoice(evaluate('state.selectedProjectId'), entry(), choice, choice === 'replace' ? `prior-${evaluate('state.selectedProjectId')}` : null);
  const descendants = node => [node, ...node.children.flatMap(descendants)];
  const controls = () => descendants(dom.elements['working-file-choices']).filter(node => node.tagName === 'BUTTON');
  const status = () => descendants(dom.elements['working-file-choices']).find(node => node.className === 'working-choice-status')?.textContent;
  const snapshot = () => JSON.stringify(evaluate('({projects:state.projects,workspace:state.assetWorkspace,token:state.packageReviewToken,selected:state.selectedProjectId})'));
  const busy = () => { assert.ok(controls().length >= 4); assert.ok(controls().every(node => node.disabled)); assert.equal(status(), 'Verifying your choice…'); };
  const available = () => {
    assert.equal(evaluate('workingFileChoiceOwner'), null);
    assert.equal(status(), '');
    const buttons = controls();
    assert.equal(buttons.filter(node => node.dataset.choice === 'keep-both')[0].disabled, false);
    assert.equal(buttons.find(node => node.dataset.choice === 'replace').disabled, false);
    assert.equal(buttons.find(node => node.textContent === 'Retry verification').disabled, false);
    assert.equal(buttons.filter(node => node.dataset.choice === 'keep-both')[1].disabled, true, 'unsaved choice stays unready');
    assert.ok(buttons.filter(node => node.tagName === 'SELECT').every(node => node.disabled), 'predecessor is never preselected');
  };
  return { ...dom, renderer, projects, workspaces, calls, reads, toasts, evaluate, entry, start, controls, status, snapshot, busy, available,
    deferRead() { const read = deferred(); nextRead = read; return read; } };
}
for (const outcome of ['refusal','reject','success']) test(`chooser delayed ${outcome} after tab round trip reconciles current controls without stale UI`, async () => {
  const f = await fixture();
  const pending = f.start('replace'); f.busy();
  assert.equal(f.evaluate('state.packageReviewToken'), null); assert.equal(f.elements['btn-confirm-package'].disabled, true);
  assert.deepEqual(f.calls[0].payload, { id: 'choice-a', revision: 'r1', choice: 'replace', predecessorIdentity: 'prior-a' });
  await f.renderer.switchTab('settings'); await f.renderer.switchTab('current-project'); f.busy();
  f.document.querySelector('#btn-review-assets').focus(); const focus = f.document.activeElement;
  const before = f.snapshot(); const reads = f.reads.length;
  if (outcome === 'reject') f.calls[0].reject(new Error('synthetic bridge failure'));
  else f.calls[0].resolve({ success: outcome === 'success', error: 'working_file_choice_stale', token: 'stale-token' });
  assert.equal(await pending, false, 'retired response never reports current success');
  f.available(); assert.equal(f.reads.length, reads + 1, 'completion refreshes without project event or extra navigation');
  assert.deepEqual(f.toasts, []); assert.equal(f.document.activeElement, focus); assert.equal(f.snapshot(), before);
});
for (const boundary of ['project','selection','account']) for (const outcome of ['success','refusal','reject']) test(`chooser old ${outcome} preserves a newer ${boundary} owner and package state`, async () => {
  const f = await fixture(); const old = f.start();
  if (boundary === 'account') {
    f.evaluate("acceptAccountSnapshot({revision:2,state:'expired',canUseWorkspace:false,identity:{id:'A'}});acceptAccountSnapshot({revision:3,state:'signed_in',canUseWorkspace:true,identity:{id:'B'}});state.projects=testProjects;setSelectedProject('a',{invalidate:true});");
  } else f.renderer.setSelectedProject(boundary === 'project' ? 'b' : 'a', { invalidate: true });
  await f.renderer.switchTab('current-project');
  const newer = f.start(); const owner = f.evaluate('workingFileChoiceOwner'); f.busy();
  f.evaluate("state.packageReviewToken='newer-token'");
  const before = f.snapshot(), reads = f.reads.length, focus = f.document.activeElement;
  if (outcome === 'reject') f.calls[0].reject(new Error('synthetic retired failure'));
  else f.calls[0].resolve({ success: outcome === 'success', token: 'stale-token' });
  assert.equal(await old, false);
  assert.equal(f.evaluate('workingFileChoiceOwner'), owner); f.busy(); assert.equal(f.snapshot(), before);
  assert.equal(f.reads.length, reads); assert.equal(f.document.activeElement, focus); assert.deepEqual(f.toasts, []);
  f.calls[1].resolve({ success: false, error: 'working_file_saved_observation_required' }); assert.equal(await newer, false);
  f.available(); assert.equal(f.toasts.length, 1); assert.match(f.toasts[0], /Save in the app/);
});
test('chooser completion on another tab does not render or steal focus and return recovers', async () => {
  const f = await fixture(); const pending = f.start(); await f.renderer.switchTab('settings');
  f.tabs.find(tab => tab.dataset.tab === 'settings').focus(); const focus = f.document.activeElement, reads = f.reads.length;
  f.calls[0].reject(new Error('synthetic failure')); assert.equal(await pending, false);
  assert.equal(f.reads.length, reads); assert.deepEqual(f.toasts, []); assert.equal(f.document.activeElement, focus);
  await f.renderer.switchTab('current-project'); f.available();
});
test('chooser refresh retired by a newer request cannot install its stale workspace or clear busy controls', async () => {
  const f = await fixture(); const old = f.start(); await f.renderer.switchTab('settings'); await f.renderer.switchTab('current-project');
  const refresh = f.deferRead(); const priorReads = f.reads.length;
  f.calls[0].resolve({ success: false }); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.reads.length, priorReads + 1, 'old completion starts a current-view refresh');
  const newer = f.start(); const owner = f.evaluate('workingFileChoiceOwner'); f.busy(); const before = f.snapshot();
  refresh.resolve({ projectId: 'a', files: [], pendingFiles: [], workingFileChoices: { version: 1, choices: [] } });
  assert.equal(await old, false); assert.equal(f.snapshot(), before); assert.equal(f.evaluate('workingFileChoiceOwner'), owner); f.busy();
  f.calls[1].resolve({ success: true }); assert.equal(await newer, true); f.available(); assert.equal(f.toasts.length, 1);
});
for (const outcome of ['success','refusal','reject']) test(`chooser current ${outcome} keeps normal feedback and rechecks current readiness`, async () => {
  const f = await fixture(); const pending = f.start(); f.busy();
  f.workspaces.get('a').workingFileChoices.choices[0].ready = false;
  if (outcome === 'reject') f.calls[0].reject(new Error('synthetic failure')); else f.calls[0].resolve({ success: outcome === 'success' });
  assert.equal(await pending, outcome === 'success'); assert.equal(f.evaluate('workingFileChoiceOwner'), null);
  assert.equal(f.toasts.length, 1); assert.equal(f.status(), '');
  assert.ok(f.controls().filter(node => node.dataset.choice === 'keep-both').every(node => node.disabled));
  assert.ok(f.controls().filter(node => node.textContent === 'Retry verification').every(node => !node.disabled));
  assert.equal(f.evaluate('state.packageReviewToken'), null);
});
test('chooser submission refuses stale revision, wrong predecessor, locked account and active modal', async () => {
  const f = await fixture(); const initial = f.snapshot();
  assert.equal(await f.renderer.submitWorkingFileChoice('a', { ...f.entry(), revision: 'stale' }, 'keep-both', null), false);
  assert.equal(await f.renderer.submitWorkingFileChoice('a', f.entry(), 'replace', 'not-owned'), false);
  f.evaluate('accountStatus.canUseWorkspace=false'); assert.equal(await f.start(), false); f.evaluate('accountStatus.canUseWorkspace=true;activeModalLease={id:"modal-package",sessionId:1}');
  assert.equal(await f.start(), false); f.evaluate('activeModalLease=null');
  assert.equal(f.calls.length, 0); assert.equal(f.snapshot(), initial);
});
for (const boundary of ['tab','project','account']) test(`chooser reconciliation read retired by ${boundary} cannot install old choices or focus`, async () => {
  const f = await fixture(); const pending = f.start(); await f.renderer.switchTab('settings'); await f.renderer.switchTab('current-project');
  const refresh = f.deferRead(); const reads = f.reads.length;
  f.calls[0].resolve({ success: false }); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.reads.length, reads + 1);
  if (boundary === 'tab') await f.renderer.switchTab('settings');
  else if (boundary === 'project') { f.renderer.setSelectedProject('b'); await f.renderer.switchTab('current-project'); }
  else f.evaluate("acceptAccountSnapshot({revision:2,state:'expired',canUseWorkspace:false,identity:{id:'A'}})");
  f.document.querySelector('#synthetic-current-focus').focus(); const focus = f.document.activeElement, before = f.snapshot();
  refresh.resolve({ projectId: 'a', files: [], pendingFiles: [], workingFileChoices: { version: 1, choices: [] } });
  assert.equal(await pending, false); assert.equal(f.snapshot(), before); assert.equal(f.document.activeElement, focus); assert.deepEqual(f.toasts, []);
  assert.equal(f.evaluate('workingFileChoiceOwner'), null);
});
test('chooser delayed success reconciles authoritative remaining choices without reviving package authority', async () => {
  const f = await fixture(); const pending = f.start(); await f.renderer.switchTab('settings'); await f.renderer.switchTab('current-project');
  const workspace = f.workspaces.get('a'); workspace.workingFileChoices.choices.shift();
  f.calls[0].resolve({ success: true, token: 'retired-token', project: { id: 'not-current' } });
  assert.equal(await pending, false); assert.deepEqual(f.toasts, []); assert.equal(f.status(), '');
  assert.equal(f.evaluate('state.assetWorkspace.workingFileChoices.choices.length'), 1);
  assert.equal(f.evaluate('state.assetWorkspace.workingFileChoices.choices[0].id'), 'unverified-a');
  assert.equal(f.controls().find(node => node.textContent === 'Retry verification').disabled, false);
  assert.equal(f.controls().find(node => node.dataset.choice === 'keep-both').disabled, true);
  assert.equal(f.evaluate('state.packageReviewToken'), null); assert.equal(f.elements['btn-confirm-package'].disabled, true);
});

for (const [reason, action, copy] of [
  ['indesign-save-required', null, 'Resume Watch'],
  ['indesign-live-unbound', 'Verify saved file', 'Save and close in InDesign'],
  ['indesign-access-denied', 'Check again', 'Automation'],
  ['indesign-query-failed', 'Check again', 'Check the app'],
  ['indesign-saved-file-unverified', 'Verify saved file', 'file or links unverified'],
]) test(`InDesign chooser ${reason} offers one supported next step`, async () => {
  const f=await fixture();
  const workspace=f.workspaces.get('a'); workspace.workingFileChoices.choices=[{...workspace.workingFileChoices.choices[1],reason}];
  await f.renderer.renderFiles();
  const descendants=node=>[node,...node.children.flatMap(descendants)];
  const help=descendants(f.elements['working-file-choices']).find(node=>node.className==='working-source-detail');
  assert.ok(help.textContent.includes(copy));
  const enabled=f.controls().filter(node=>!node.disabled);
  assert.deepEqual(enabled.map(node=>node.textContent),action?[action]:[]);
  assert.ok(f.controls().filter(node=>['keep-both','replace'].includes(node.dataset.choice)).every(node=>node.disabled));
  if(reason==='indesign-save-required') {
    f.projects[0].status='watching';
    // A watch-state-only transition must refresh the guidance, not remain stale.
    f.renderer.renderWorkingFileChoices(f.projects[0],workspace);
    const updated=descendants(f.elements['working-file-choices']).find(node=>node.className==='working-source-detail');
    assert.equal(updated.textContent.startsWith('Save in InDesign'),true);
    return;
  }
  enabled[0].focus();
  const entry=f.evaluate('state.assetWorkspace.workingFileChoices.choices[0]');
  const pending=f.renderer.submitWorkingFileChoice('a',entry,'retry',null);
  assert.equal(f.calls.length,1); assert.equal(f.calls[0].payload.choice,'retry');
  assert.equal(await f.renderer.submitWorkingFileChoice('a',entry,'retry',null),false);
  assert.ok(f.controls().every(node=>node.disabled)); assert.equal(f.status(),'Verifying your choice…');
  assert.equal(f.evaluate('state.packageReviewToken'),null);
  assert.equal(f.document.activeElement.tagName,'H2');
  f.calls[0].resolve({success:false}); await pending;
  assert.equal(f.controls().filter(node=>!node.disabled).length,1);
});

const choiceTree = node => [node, ...(node.children || []).flatMap(choiceTree)];
const choiceButtons = node => choiceTree(node).filter(el => el.tagName === 'BUTTON' && el.dataset.choice);
test('picker approved simple flow names both outcomes without a dropdown', async () => {
  const f=await fixture(); const region=f.elements['working-file-choices'];
  assert.equal(choiceTree(region).some(el=>el.tagName==='SELECT'),false);
  const buttons=choiceButtons(region);
  assert.ok(buttons.some(el=>el.textContent==='Replace Prior.ai with New.ai'));
  assert.ok(buttons.some(el=>el.textContent==='Keep Prior.ai and New.ai'));
});
test('picker approved ambiguous targets are independent named actions with no default', async () => {
  const f=await fixture(), ws=f.workspaces.get('a');
  ws.workingFileChoices.choices=[{...ws.workingFileChoices.choices[0],predecessors:[
    {visualIdentity:'one',name:'Deck.ai',folder:'One › Work'},
    {visualIdentity:'two',name:'Deck.ai',folder:'Two › Work'},
    {visualIdentity:'other',name:'Other.ai',folder:'Work'},
  ]}];
  await f.renderer.renderFiles();
  const buttons=choiceButtons(f.elements['working-file-choices']);
  assert.equal(buttons.filter(el=>el.dataset.choice==='replace').length,3);
  assert.equal(choiceTree(f.elements['working-file-choices']).some(el=>el.tagName==='SELECT'),false);
  assert.equal(f.calls.length,0);
  assert.ok(buttons.find(el=>el.dataset.predecessorIdentity==='one').getAttribute('aria-label').includes('One › Work'));
  const target=buttons.find(el=>el.dataset.predecessorIdentity==='two'); target.click();
  assert.deepEqual(f.calls[0].payload,{id:'choice-a',revision:'r1',choice:'replace',predecessorIdentity:'two'});
  assert.ok(choiceButtons(f.elements['working-file-choices']).every(el=>el.disabled));
  target.click(); assert.equal(f.calls.length,1);
  f.calls[0].resolve({success:false}); await new Promise(resolve=>setTimeout(resolve,0));
});
async function mountedPickerFixture() {
  const f=await fixture(),ws=f.workspaces.get('a');
  f.renderer.window.crate.setWorkingSourceSelection=async()=>({success:false});
  const source=(name,id,selection='selected')=>({name,ext:'.ai',appFamily:'illustrator',visualIdentity:id,visualRevision:id+'-v1',
    protectedSource:true,projectRole:'source',sourceSelection:selection,selectionRevision:0,included:selection==='selected',
    verificationStatus:'scanned',verificationRequired:true});
  ws.files=[source('A.ai','A'),source('C.ai','C'),source('B.ai','B'),
    {name:'image.png',ext:'.png',projectRole:'asset',visualIdentity:'image',visualRevision:'image-v1',included:true,assetOrigin:'added',currentWorkingSources:[{identity:'B',name:'B.ai'}]}];
  ws.workingFileChoices={version:1,blocked:true,choices:[{id:'new-B',revision:'r1',ready:true,
    source:{name:'B.ai',visualIdentity:'B'},predecessors:[{name:'A.ai',visualIdentity:'A'}]}]};
  await f.renderer.renderFiles(); return f;
}
test('picker approved decision is in B row on both surfaces; authoritative replacement orders B first and mutes A through navigation/reload', async () => {
  const f=await mountedPickerFixture(),ws=f.workspaces.get('a');
  for(const id of ['project-file-list','working-assets-list']) {
    const row=f.elements[id].children.find(node=>node.dataset.renderKey==='visual:B');
    assert.ok(row.querySelector('.working-file-choice'));
    assert.equal(choiceButtons(row).filter(el=>el.dataset.choice==='replace').length,1);
  }
  assert.equal(choiceButtons(f.elements['working-file-choices']).length,0,'no separate decision column');
  // This modeled bridge applies authoritative state only after a valid IPC request.
  const button=choiceButtons(f.elements['project-file-list']).find(el=>el.dataset.choice==='replace');
  button.click(); assert.equal(f.calls.length,1);button.click();assert.equal(f.calls.length,1);
  ws.files.find(row=>row.visualIdentity==='A').sourceSelection='excluded';ws.files.find(row=>row.visualIdentity==='A').included=false;
  ws.workingFileChoices={version:1,blocked:false,choices:[]};ws.workingSourceDisplayOrder=['B'];
  f.calls[0].resolve({success:true}); await new Promise(resolve=>setTimeout(resolve,0));
  async function verify() {
    await f.renderer.renderFiles();
    for(const id of ['project-file-list','working-assets-list']) {
      const rows=f.elements[id].children;
      assert.deepEqual(Array.from(rows,row=>row.dataset.renderKey),['visual:B','visual:C','visual:A']);
      assert.ok(rows[0].classList.contains('is-selected-source'));assert.ok(rows[2].matches('.is-excluded'));
      assert.equal(rows[2].classList.contains('is-selected-source'),false);
      assert.ok(choiceTree(rows[2]).some(el=>el.tagName==='BUTTON'&&el.textContent==='Restore'));
      assert.ok(rows[0].querySelector('.working-source-assets'));
      assert.equal(choiceButtons(rows[0]).length,0);
    }
  }
  await verify(); await f.renderer.switchTab('settings');await f.renderer.switchTab('current-project');await verify();
  f.workspaces.set('a',clone(ws)); await verify();
});
for(const reason of ['working-file-dependencies-unverified','working-file-source-changed','saved-file-verification-required']) test(`picker approved ${reason} never substitutes generic Save advice`,async()=>{
  const f=await fixture(),ws=f.workspaces.get('a');ws.workingFileChoices.choices=[{...ws.workingFileChoices.choices[0],ready:false,reason}];
  await f.renderer.renderFiles();const guidance=choiceTree(f.elements['working-file-choices']).find(el=>el.className==='working-source-detail');
  assert.ok(guidance);assert.equal(/save the file|resume watching/i.test(guidance.textContent),false);
  assert.ok(choiceButtons(f.elements['working-file-choices']).filter(el=>['replace','keep-both'].includes(el.dataset.choice)).every(el=>el.disabled));
});

test('picker leaving the screen without choosing preserves decisions and sends no request',async()=>{
  const f=await mountedPickerFixture(),before=f.snapshot();await f.renderer.switchTab('settings');await f.renderer.switchTab('current-project');
  assert.equal(f.calls.length,0);assert.equal(f.snapshot(),before);
  assert.equal(choiceButtons(f.elements['project-file-list']).filter(el=>el.dataset.choice==='replace').length,1);
});
test('picker detached stale named action cannot submit after revision changes',async()=>{
  const f=await mountedPickerFixture(),old=choiceButtons(f.elements['project-file-list']).find(el=>el.dataset.choice==='replace');
  f.workspaces.get('a').workingFileChoices.choices[0].revision='new-revision';await f.renderer.renderFiles();old.click();
  assert.equal(f.calls.length,0);
});
test('picker same-named pair shows both safe folder labels in the named outcome',async()=>{
  const f=await fixture(),ws=f.workspaces.get('a');ws.workingFileChoices.choices=[{...ws.workingFileChoices.choices[0],
    source:{name:'Deck.ai',folder:'Two › Work'},predecessors:[{visualIdentity:'prior-a',name:'Deck.ai',folder:'One › Work'}]}];
  await f.renderer.renderFiles();const button=choiceButtons(f.elements['working-file-choices']).find(el=>el.dataset.choice==='replace');
  assert.ok(button.textContent.includes('One › Work'));assert.ok(button.textContent.includes('Two › Work'));
});
test('picker long filenames retain accessible named actions without redundant descriptions on both surfaces',async()=>{
  const f=await mountedPickerFixture(),ws=f.workspaces.get('a'),name='A long filename — '.repeat(12)+'final.pptx';
  ws.workingFileChoices.choices[0].source.name=name;ws.files.find(row=>row.visualIdentity==='B').name=name;await f.renderer.renderFiles();
  for(const id of ['project-file-list','working-assets-list']) {
    const row=f.elements[id].children.find(node=>node.dataset.workingSourceIdentity==='B');
    const card=row.querySelector('.working-file-choice');assert.equal(card.querySelector('.working-source-detail'),null);
    for(const button of choiceButtons(card)) {assert.equal(button.type,'button');assert.ok(button.getAttribute('aria-label').includes('final.pptx'));assert.ok(!button.getAttribute('aria-describedby'));}
  }
});
test('picker shared assets remain standalone instead of guessing a parent from filenames',async()=>{
  const f=await mountedPickerFixture(),ws=f.workspaces.get('a');ws.files.find(row=>row.visualIdentity==='image').currentWorkingSources=[{identity:'B',name:'B.ai'},{identity:'C',name:'C.ai'}];
  await f.renderer.renderFiles();
  for(const id of ['project-file-list','working-assets-list']) {
    const row=f.elements[id].children.find(node=>node.dataset.workingSourceIdentity==='B'),children=row.querySelector('.working-source-assets');
    assert.ok(!children||children.classList.contains('hidden'));
  }
  assert.equal(f.evaluate('state.assetReviewLogicalItems.added.length'),1);
});

test('picker name labels reject paths, URLs and controls while retaining ordinary long basenames',async()=>{
  const f=await fixture();for(const value of ['/private/Deck.ai','https://example.test/Deck.ai','bad\nname.ai','bad\\name.ai'])assert.equal(f.renderer.sanitizeWorkingFileChoiceName(value),null);
  const name='x'.repeat(200)+'-final.ai';assert.equal(f.renderer.sanitizeWorkingFileChoiceName(name),name);
  assert.equal(f.renderer.sanitizeWorkingFileChoiceName('x'.repeat(400)).length,255);
});

for (const surface of ['project-file-list', 'working-assets-list']) for (const outcome of ['refusal', 'reject'])
test(`picker failed Retry ${outcome} retains keyboard focus after row replacement on ${surface}`, async () => {
  const f=await mountedPickerFixture(), ws=f.workspaces.get('a');
  if(surface==='working-assets-list') f.evaluate('state.assetReviewOpen=true');
  ws.workingFileChoices.choices[0].ready=false;
  ws.workingFileChoices.choices[0].reason='working-file-dependencies-unverified';
  await f.renderer.renderFiles();
  const row=()=>f.elements[surface].children.find(node=>node.dataset.workingSourceIdentity==='B');
  const original=row(), retry=choiceButtons(original).find(node=>node.dataset.choice==='retry');
  assert.ok(retry && !retry.disabled);retry.focus();assert.ok(f.document.activeElement===retry);
  const pending=f.renderer.submitWorkingFileChoice('a',f.entry(),'retry',null);
  ws.files.find(file=>file.visualIdentity==='B').verificationStatus='unverified';
  ws.workingFileChoices.choices[0].revision='retry-r2';
  if(outcome==='reject')f.calls[0].reject(new Error('synthetic Retry failure'));else f.calls[0].resolve({success:false});
  assert.equal(await pending,false);
  assert.ok(row()!==original,'verification refresh must replace the source row');
  const heading=row().querySelector('.working-file-choice-question');
  assert.ok(heading.isConnected);assert.ok(f.document.activeElement===heading,'focus stays at the same current choice on the same surface');
  const nextRetry=choiceButtons(row()).find(node=>node.dataset.choice==='retry');
  assert.ok(!nextRetry.disabled);assert.equal(heading.tabIndex,-1);
  nextRetry.focus();assert.ok(f.document.activeElement===nextRetry,'keyboard continuation has a connected enabled action');
  assert.equal(f.calls.length,1);assert.equal(f.evaluate('state.packageReviewToken'),null);
});

for (const change of ['decision-removed','source-removed','different-choice','duplicate-source','newer-focus','tab-retired'])
test(`picker Retry focus restoration respects ${change} during reconciliation`, async () => {
  const f=await mountedPickerFixture(),ws=f.workspaces.get('a');
  ws.workingFileChoices.choices[0].ready=false;await f.renderer.renderFiles();
  const row=()=>f.elements['project-file-list'].children.find(node=>node.dataset.workingSourceIdentity==='B');
  choiceButtons(row()).find(node=>node.dataset.choice==='retry').focus();
  const pending=f.renderer.submitWorkingFileChoice('a',f.entry(),'retry',null);
  const refresh=f.deferRead();f.calls[0].resolve({success:false});await Promise.resolve();await Promise.resolve();
  const next=clone(ws);next.files.find(file=>file.visualIdentity==='B').verificationStatus='unverified';
  if(change==='decision-removed')next.workingFileChoices.choices=[];
  if(change==='source-removed') {next.files=next.files.filter(file=>file.visualIdentity!=='B');next.workingFileChoices.choices=[];}
  if(change==='different-choice')next.workingFileChoices.choices[0].id='different-B';
  if(change==='duplicate-source')next.files.push(clone(next.files.find(file=>file.visualIdentity==='B')));
  let external;
  if(change==='newer-focus'){external=f.document.querySelector('#btn-review-assets');external.focus();}
  if(change==='tab-retired'){await f.renderer.switchTab('settings');external=f.tabs.find(tab=>tab.dataset.tab==='settings');external.focus();}
  refresh.resolve(next);assert.equal(await pending,false);
  if(external)assert.ok(f.document.activeElement===external,'newer focus/navigation wins');
  else if(change==='decision-removed')assert.ok(f.document.activeElement===row(),'same source row is the fallback after decision removal');
  else assert.ok(f.document.activeElement===f.document.body,'never guess another source, choice, or duplicate row');
  assert.equal(f.calls.length,1);
});
for(const newerFocus of [false,true])test(`picker successful replacement restores source focus only for the current keyboard intent (${newerFocus})`,async()=>{
  const f=await mountedPickerFixture(),ws=f.workspaces.get('a');
  const button=choiceButtons(f.elements['project-file-list']).find(node=>node.dataset.choice==='replace');button.focus();
  const pending=f.renderer.submitWorkingFileChoice('a',f.entry(),'replace','A');
  const external=f.document.querySelector('#btn-review-assets');if(newerFocus)external.focus();
  ws.files.find(file=>file.visualIdentity==='A').sourceSelection='excluded';ws.workingFileChoices.choices=[];ws.workingSourceDisplayOrder=['B'];
  f.calls[0].resolve({success:true});assert.equal(await pending,true);
  const row=f.elements['project-file-list'].children.find(node=>node.dataset.workingSourceIdentity==='B');
  assert.ok(f.document.activeElement===(newerFocus?external:row));assert.equal(f.calls.length,1);
});

test('picker fallback Retry retains its connected region heading through reconciliation',async()=>{
  const f=await fixture(),retry=f.controls().find(node=>node.dataset.choice==='retry');retry.focus();
  const pending=f.renderer.submitWorkingFileChoice('a',f.evaluate('state.assetWorkspace.workingFileChoices.choices[1]'),'retry',null);
  f.workspaces.get('a').workingFileChoices.choices[1].revision='u2';
  f.calls[0].resolve({success:false});assert.equal(await pending,false);
  assert.ok(f.document.activeElement.isConnected);assert.equal(f.document.activeElement.tagName,'H2');
  assert.ok(f.elements['working-file-choices'].contains(f.document.activeElement));
});

for(const surface of ['project-file-list','working-assets-list'])for(const outcome of ['success','refusal','reject'])
test(`picker pre-existing duplicate rows preserve the activated second row during immediate busy rendering (${surface}, ${outcome})`,async()=>{
  const f=await mountedPickerFixture(),ws=f.workspaces.get('a');
  if(surface==='working-assets-list')f.evaluate('state.assetReviewOpen=true');
  ws.files.push(clone(ws.files.find(file=>file.visualIdentity==='B')));
  ws.workingFileChoices.choices[0].ready=false;await f.renderer.renderFiles();
  const rows=Array.from(f.elements[surface].children).filter(row=>row.dataset.workingSourceIdentity==='B');
  assert.equal(rows.length,2,'normal authoritative projection renders both duplicate rows');
  const first=rows[0],second=rows[1],retry=choiceButtons(second).find(node=>node.dataset.choice==='retry');
  assert.ok(retry&&!retry.disabled);retry.focus();assert.ok(f.document.activeElement===retry);
  const pending=f.renderer.submitWorkingFileChoice('a',f.entry(),'retry',null);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].payload.choice,'retry');
  const expected=second.querySelector('.working-file-choice-question');
  // Save immediate state, then settle the owned request even when reproduction fails.
  const stayedInSecond=f.document.activeElement===expected;
  const movedToFirst=first.contains(f.document.activeElement);
  assert.ok(choiceButtons(first).every(node=>node.disabled));assert.ok(choiceButtons(second).every(node=>node.disabled));
  if(outcome==='reject')f.calls[0].reject(new Error('synthetic duplicate-row Retry failure'));else f.calls[0].resolve({success:outcome==='success'});
  assert.equal(await pending,outcome==='success');
  assert.equal(movedToFirst,false,'busy rendering must not jump from the second duplicate row to the first');
  assert.equal(stayedInSecond,true,'the exact mounted row is a safe synchronous focus anchor');
  assert.equal(f.calls.length,1);assert.equal(f.evaluate('state.packageReviewToken'),null);
});

for(const surface of ['project-file-list','working-assets-list'])test(`picker immediate duplicate-row busy rendering respects newer synchronous focus (${surface})`,async()=>{
  const f=await mountedPickerFixture(),ws=f.workspaces.get('a');
  if(surface==='working-assets-list')f.evaluate('state.assetReviewOpen=true');
  ws.files.push(clone(ws.files.find(file=>file.visualIdentity==='B')));ws.workingFileChoices.choices[0].ready=false;await f.renderer.renderFiles();
  const rows=Array.from(f.elements[surface].children).filter(row=>row.dataset.workingSourceIdentity==='B');assert.equal(rows.length,2);
  const second=rows[1],external=f.document.querySelector('#btn-review-assets');
  choiceButtons(second).find(node=>node.dataset.choice==='retry').focus();
  const replace=second.replaceChild.bind(second);
  // Model a synchronous focus listener triggered by the focused card's removal.
  second.replaceChild=(...args)=>{const result=replace(...args);external.focus();return result;};
  const pending=f.renderer.submitWorkingFileChoice('a',f.entry(),'retry',null);
  assert.ok(f.document.activeElement===external,'busy rendering must respect newer synchronous focus');
  f.calls[0].resolve({success:false});assert.equal(await pending,false);
  assert.ok(f.document.activeElement===external);assert.equal(f.calls.length,1);
});
