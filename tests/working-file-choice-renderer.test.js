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
  const busy = () => { assert.ok(controls().length >= 5); assert.ok(controls().every(node => node.disabled)); assert.equal(status(), 'Verifying your choice…'); };
  const available = () => {
    assert.equal(evaluate('workingFileChoiceOwner'), null);
    assert.equal(status(), '');
    const buttons = controls();
    assert.equal(buttons.filter(node => node.textContent === 'Keep both')[0].disabled, false);
    assert.equal(buttons.find(node => node.textContent === 'Use this instead of…').disabled, false);
    assert.equal(buttons.find(node => node.textContent === 'Retry verification').disabled, false);
    assert.equal(buttons.filter(node => node.textContent === 'Keep both')[1].disabled, true, 'unsaved choice stays unready');
    assert.ok(buttons.filter(node => node.textContent === 'Use this file').every(node => node.disabled), 'predecessor is never preselected');
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
  assert.ok(f.controls().filter(node => node.textContent === 'Keep both').every(node => node.disabled));
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
  assert.equal(f.controls().find(node => node.textContent === 'Keep both').disabled, true);
  assert.equal(f.evaluate('state.packageReviewToken'), null); assert.equal(f.elements['btn-confirm-package'].disabled, true);
});
