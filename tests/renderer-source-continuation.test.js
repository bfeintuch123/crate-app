'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
// Execute the production renderer against the existing synthetic DOM fixture.
// IPC is mocked: these cases do not establish A1/native integration acceptance.
const sharedPath = path.join(__dirname, 'renderer-figma-scope.test.js');
const shared = fs.readFileSync(sharedPath, 'utf8');
const fixtureScope = { require: createRequire(sharedPath), __dirname, console, setTimeout, clearTimeout };
vm.createContext(fixtureScope);
vm.runInContext(shared.slice(0, shared.indexOf('\ntest(')), fixtureScope);
const { createInteractiveRendererDom, loadRendererHelpers, getElementTreeText } = fixtureScope;
const clone = value => JSON.parse(JSON.stringify(value));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function setup(overrides = {}) {
  const { document, elements } = createInteractiveRendererDom();
  const row = { name: 'Original.ai', ext: '.ai', appFamily: 'illustrator', visualIdentity: 'owned-source', visualRevision: 'bytes-1', protectedSource: true,
    projectRole: 'source', sourceSelection: 'selected', selectionRevision: 0, included: true, includedAsDependency: false,
    effectiveRole: 'source', verificationStatus: 'scanned', verificationRequired: false, requiredBy: [], ...overrides };
  const project = { id: 'a2-project', name: 'Synthetic A2', status: 'watching', files: [row], pendingFiles: [], excludedAssetKeys: [] };
  const workspace = { projectId: project.id, files: [row], pendingFiles: [], semanticCounts: {
    selectedWorkingSources: 1, excludedWorkingSources: 0, invalidWorkingSources: 0, includedAssets: 0,
    excludedAssets: 0, unresolvedVerification: 0, missingRequiredReferences: 0, relationshipHolds: 0 }, workingSourceSelectionBlocked: false };
  const calls = [];
  const crate = { getProjects: async () => [clone(project)], getAssetWorkspace: async () => clone(workspace),
    setWorkingSourceSelection: async (...args) => { calls.push(args); return { success: false, error: 'working_source_selection_stale' }; },
    preparePackageReview: async () => ({ projectId: project.id, files: [], materializable: false }),
    preScanSession: async () => null,
  };
  const renderer = loadRendererHelpers(document, { crate });
  renderer.fixtureProject = project; renderer.fixtureWorkspace = workspace;
  vm.runInContext('state.projects = [fixtureProject]; state.selectedProjectId = fixtureProject.id; state.assetWorkspace = fixtureWorkspace; accountStatus.canUseWorkspace = true;', renderer);
  renderer.setAssetReviewProject(project.id);
  const notices = [];
  renderer.showToast = message => notices.push(message);
  return { renderer, document, elements, project, workspace, row, calls, crate, notices };
}
function descendants(node) { return [node, ...(node.children || []).flatMap(descendants)]; }
function buttonFor(node, text) { return descendants(node).find(child => child.tagName === 'BUTTON' && child.textContent === text); }

for (const outcome of ['failure', 'close']) test(`pending continuation keeps keyboard focus before disabling choice: ${outcome}`, async () => {
  const f = setup(); const gate = deferred(); let refreshed = 0;
  f.crate.resolveWorkingSourceContinuation = () => gate.promise;
  const review = pairReview(f); f.renderer.renderPackageReview(f.project, review);
  const button = buttonFor(f.elements['source-continuation-choices'], 'Replace');
  const originalQuery = f.document.querySelectorAll.bind(f.document);
  f.document.querySelectorAll = selector => selector === '.continuation-choice' ? [button] : originalQuery(selector);
  let disabled = button.disabled;
  Object.defineProperty(button, 'disabled', { get: () => disabled, set: value => {
    if (value && f.document.activeElement === button) f.document.activeElement = f.document.body;
    disabled = value;
  } });
  button.focus(); f.renderer.showPackageModal = async () => { refreshed++; };
  const pending = f.renderer.chooseSourceContinuation(f.project, review.sourceContinuation.candidates[0], 'replace', vm.runInContext('packageReviewContents.lease', f.renderer));
  assert.equal(button.disabled, true);
  assert.equal(f.document.activeElement, f.elements['btn-back-package']);
  assert.equal(f.document.activeElement.disabled, false);
  if (outcome === 'close') {
    let prevented = false;
    f.renderer.handlePackageReviewKeydown({ key: 'Escape', preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true); assert.equal(f.elements['modal-package'].classList.contains('hidden'), true);
  }
  gate.resolve({ success: false, error: 'continuation_stale' }); await pending;
  assert.equal(refreshed, outcome === 'close' ? 0 : 1);
  if (outcome === 'failure') assert.equal(f.document.activeElement, f.elements['btn-back-package']);
});

function pairReview(f) {
  return { projectId: f.project.id, files: [], materializable: false, sourceContinuation: { version: 1, capability: 'pair-choice-v1', candidates: [{
    pairIdentity: 'a'.repeat(64), evidenceIdentity: 'b'.repeat(64), revision: 4,
    predecessor: { name: 'Original.ai', visualIdentity: 'old-1', selectionRevision: 1, selectionState: 'selected', admissionState: 'accepted' },
    successor: { name: 'Current.ai', visualIdentity: 'new-1', selectionRevision: 2, selectionState: 'selected', admissionState: 'accepted' },
    replaceRequires: null, retainsPredecessorAsDependency: true,
  }] } };
}

test('pair controls appear only for backend versioned candidates inside Package Review', () => {
  const f = setup(); f.crate.resolveWorkingSourceContinuation = async () => ({ success: true });
  const review = pairReview(f); f.renderer.renderPackageReview(f.project, review);
  const region = f.elements['source-continuation-choices'];
  for (const text of ['Replace', 'Keep both', 'Not related']) assert.ok(buttonFor(region, text));
  assert.match(getElementTreeText(region), /still required as an asset/);
  assert.equal(f.elements['btn-confirm-package'].disabled, true);
  assert.equal(f.renderer.getContinuationCandidates({ ...review, sourceContinuation: { ...review.sourceContinuation, version: 2 } }).length, 0);
});

test('unrelated package remains packageable without pair controls', () => {
  const f = setup(); f.renderer.renderPackageReview(f.project, { projectId: f.project.id, files: [], token: 'unrelated', materializable: true });
  assert.equal(f.elements['source-continuation-choices'].classList.contains('hidden'), true);
  assert.equal(f.elements['btn-confirm-package'].disabled, false);
});

for (const choice of ['replace', 'keep-both', 'not-related']) test(`pair ${choice} sends one atomic evidence-bound request`, async () => {
  const f = setup(); const calls = []; let refreshes = 0;
  f.crate.resolveWorkingSourceContinuation = async (...args) => { calls.push(args); return { success: true }; };
  const review = pairReview(f); f.renderer.renderPackageReview(f.project, review);
  f.renderer.showPackageModal = async () => { refreshes++; };
  const lease = vm.runInContext('packageReviewContents.lease', f.renderer);
  await f.renderer.chooseSourceContinuation(f.project, review.sourceContinuation.candidates[0], choice, lease);
  assert.deepEqual(clone(calls[0]), [f.project.id, { pairIdentity: 'a'.repeat(64), evidenceIdentity: 'b'.repeat(64), expectedRevision: 4,
    predecessorSelectionRevision: 1, successorSelectionRevision: 2, choice }]);
  assert.equal(f.calls.length, 0, 'never two sequential selection requests'); assert.equal(refreshes, 1);
});

test('late pair completion never reopens a closed/replaced review', async () => {
  const f = setup(); const gate = deferred(); let refreshes = 0;
  f.crate.resolveWorkingSourceContinuation = () => gate.promise;
  const review = pairReview(f); f.renderer.renderPackageReview(f.project, review);
  f.renderer.showPackageModal = async () => { refreshes++; };
  const pending = f.renderer.chooseSourceContinuation(f.project, review.sourceContinuation.candidates[0], 'replace', vm.runInContext('packageReviewContents.lease', f.renderer));
  vm.runInContext('packageReviewRequestId += 1', f.renderer);
  gate.resolve({ success: true }); await pending;
  assert.equal(refreshes, 0);
});

test('foreign project pair-error response is rejected before any pair display or resolver call', async () => {
  const f = setup(); let resolved = 0;
  const review = { ...pairReview(f), projectId: 'foreign-project', error: 'working_source_continuation_choice_required' };
  f.crate.preparePackageReview = async () => review;
  f.crate.resolveWorkingSourceContinuation = async () => { resolved++; return { success: true }; };
  assert.equal(await f.renderer.showPackageModal({ runPreScan: false }), false);
  assert.equal(f.elements['source-continuation-choices']?.children.length || 0, 0);
  assert.equal(resolved, 0);
});

for (const message of ['These files changed. Review the current pair before choosing again.', 'Crate needs to verify the saved files and their links before replacing a working file.', 'Choice saved. Review the updated package.']) test(`matching pair refresh retains outcome and focuses status: ${message}`, async () => {
  const f = setup(); f.crate.resolveWorkingSourceContinuation = async () => ({ success: true });
  f.crate.preparePackageReview = async () => ({ ...pairReview(f), error: 'working_source_continuation_choice_required' });
  await f.renderer.showPackageModal({ runPreScan: false, message });
  assert.ok(buttonFor(f.elements['source-continuation-choices'], 'Replace'));
  assert.equal(f.elements['modal-package-review-message'].textContent, message);
  assert.equal(f.document.activeElement, f.elements['modal-package-review-message']);
});

for (const projectId of [undefined, 'foreign-project']) test(`actual underscore ambiguity error requires matching project envelope: ${projectId}`, async () => {
  const f = setup(); let resolves = 0;
  f.crate.resolveWorkingSourceContinuation = async () => { resolves++; return { success: true }; };
  const response = { ...pairReview(f), error: 'working_source_continuation_choice_required' };
  if (projectId === undefined) delete response.projectId;
  else response.projectId = projectId;
  f.crate.preparePackageReview = async () => response;
  await f.renderer.showPackageModal({ runPreScan: false });
  assert.equal(f.elements['source-continuation-choices'] ? buttonFor(f.elements['source-continuation-choices'], 'Replace') : undefined, undefined);
  assert.equal(resolves, 0);
  assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null);
});

test('old hyphenated ambiguity spelling is not a supported alias', async () => {
  const f = setup();
  f.crate.preparePackageReview = async () => ({ ...pairReview(f), error: 'working-source-continuation-choice-required' });
  await f.renderer.showPackageModal({ runPreScan: false });
  assert.equal(f.elements['source-continuation-choices'] ? buttonFor(f.elements['source-continuation-choices'], 'Replace') : undefined, undefined);
  assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null);
});

for (const error of [null, 'invalid_continuation_request', 'continuation_stale', 'continuation_not_found', 'continuation_verification_required']) test(`atomic choice reloads workspace before reprepare without response counts: ${error}`, async () => {
  const f = setup(); const order = [];
  f.crate.resolveWorkingSourceContinuation = async () => { order.push('resolve'); return error ? { success: false, error } : { success: true, decision: { authority: 'owner-choice', choice: 'replace' } }; };
  const review = pairReview(f); f.renderer.renderPackageReview(f.project, review);
  const renderFiles = f.renderer.renderFiles;
  f.renderer.renderFiles = async options => { assert.equal(options.isCurrent(), true); order.push('workspace'); return renderFiles(options); };
  f.renderer.showPackageModal = async options => { assert.equal(options.runPreScan, false); order.push('prepare'); };
  await f.renderer.chooseSourceContinuation(f.project, review.sourceContinuation.candidates[0], 'replace', vm.runInContext('packageReviewContents.lease', f.renderer));
  assert.deepEqual(order, ['resolve', 'workspace', 'prepare']);
  assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null);
});

test('project change while refreshed workspace is pending cannot reprepare the old pair', async () => {
  const f = setup(); const gate = deferred(); let preparations = 0;
  f.crate.resolveWorkingSourceContinuation = async () => ({ success: true });
  const review = pairReview(f); f.renderer.renderPackageReview(f.project, review);
  f.renderer.renderFiles = () => gate.promise;
  f.renderer.showPackageModal = async () => { preparations++; };
  const pending = f.renderer.chooseSourceContinuation(f.project, review.sourceContinuation.candidates[0], 'replace', vm.runInContext('packageReviewContents.lease', f.renderer));
  await new Promise(resolve => setImmediate(resolve));
  vm.runInContext('projectSelectionEpoch += 1', f.renderer);
  gate.resolve(); await pending;
  assert.equal(preparations, 0);
});

for (const responseProjectId of ['a2-project', 'foreign-project', null, undefined]) test(`pair success requires owned resolver project identity: ${responseProjectId}`, async () => {
  const f = setup(); const order = []; let message;
  f.crate.resolveWorkingSourceContinuation = async () => {
    order.push('resolve');
    return { success: true, projectId: responseProjectId, semanticCounts: { selectedWorkingSources: 999 } };
  };
  const review = pairReview(f); f.renderer.renderPackageReview(f.project, review);
  const renderFiles = f.renderer.renderFiles;
  f.renderer.renderFiles = async options => { assert.equal(options.isCurrent(), true); order.push('workspace'); return renderFiles(options); };
  f.renderer.showPackageModal = async options => { order.push('prepare'); message = options.message; };
  const result = await f.renderer.chooseSourceContinuation(f.project, review.sourceContinuation.candidates[0], 'replace', vm.runInContext('packageReviewContents.lease', f.renderer));
  assert.equal(result, responseProjectId === f.project.id);
  assert.equal(message.startsWith('Choice saved.'), responseProjectId === f.project.id);
  assert.deepEqual(order, ['resolve', 'workspace', 'prepare'], 'untrusted completion still refreshes authoritative current workspace before preparing again');
  assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null);
  assert.equal(vm.runInContext('state.assetWorkspace.semanticCounts.selectedWorkingSources', f.renderer), 1, 'never consume resolver count claims');
});

for (const selectionState of ['selected', 'excluded']) test(`pending ${selectionState} successor cannot be admitted by renderer Replace`, async () => {
  const f = setup(); let calls = 0;
  f.crate.resolveWorkingSourceContinuation = async () => { calls++; return { success: true, projectId: f.project.id }; };
  const review = pairReview(f), pair = review.sourceContinuation.candidates[0];
  Object.assign(pair.successor, { selectionState, admissionState: 'pending' }); pair.replaceRequires = 'successor-admission';
  f.renderer.renderPackageReview(f.project, review);
  const region = f.elements['source-continuation-choices'];
  assert.equal(buttonFor(region, 'Replace').disabled, true);
  assert.equal(buttonFor(region, 'Keep both').disabled, false);
  assert.equal(buttonFor(region, 'Not related').disabled, false);
  assert.match(getElementTreeText(region), /has not been added to this project/);
  assert.match(getElementTreeText(region), /Keep both and Not related will not add it/);
  assert.doesNotMatch(getElementTreeText(region), /includes both versions/);
  assert.equal(await f.renderer.chooseSourceContinuation(f.project, pair, 'replace', vm.runInContext('packageReviewContents.lease', f.renderer)), false);
  assert.equal(calls, 0, 'disabled UI also has a handler-level admission guard');
  assert.equal(f.calls.length, 0, 'no ordinary selection or admission is fabricated');
  assert.equal(f.elements['btn-confirm-package'].disabled, true);
});

for (const choice of ['keep-both', 'not-related']) test(`pending successor ${choice} records only the existing atomic intent`, async () => {
  const f = setup(); const calls = []; let refreshes = 0;
  f.crate.resolveWorkingSourceContinuation = async (...args) => { calls.push(args); return { success: true, projectId: f.project.id }; };
  const review = pairReview(f), pair = review.sourceContinuation.candidates[0];
  pair.successor.admissionState = 'pending'; pair.replaceRequires = 'successor-admission';
  f.renderer.renderPackageReview(f.project, review);
  f.renderer.showPackageModal = async () => { refreshes++; };
  assert.equal(await f.renderer.chooseSourceContinuation(f.project, pair, choice, vm.runInContext('packageReviewContents.lease', f.renderer)), true);
  assert.deepEqual(clone(calls), [[f.project.id, { pairIdentity: pair.pairIdentity, evidenceIdentity: pair.evidenceIdentity, expectedRevision: pair.revision,
    predecessorSelectionRevision: pair.predecessor.selectionRevision, successorSelectionRevision: pair.successor.selectionRevision, choice }]]);
  assert.equal(f.calls.length, 0); assert.equal(refreshes, 1);
  assert.equal(pair.successor.admissionState, 'pending');
});

test('accepted excluded successor permits explicit Replace without promising Keep both restores it', async () => {
  const f = setup(); const calls = [];
  f.crate.resolveWorkingSourceContinuation = async (...args) => { calls.push(args); return { success: true, projectId: f.project.id }; };
  const review = pairReview(f), pair = review.sourceContinuation.candidates[0]; pair.successor.selectionState = 'excluded';
  f.renderer.renderPackageReview(f.project, review);
  const region = f.elements['source-continuation-choices'];
  assert.equal(buttonFor(region, 'Replace').disabled, false);
  assert.match(getElementTreeText(region), /Keep both and Not related leave it excluded/);
  assert.doesNotMatch(getElementTreeText(region), /includes both versions|Ready to package/);
  f.renderer.showPackageModal = async () => {};
  assert.equal(await f.renderer.chooseSourceContinuation(f.project, pair, 'replace', vm.runInContext('packageReviewContents.lease', f.renderer)), true);
  assert.equal(calls.length, 1); assert.equal(f.calls.length, 0);
  assert.equal(pair.successor.selectionState, 'excluded', 'selection changes only through authoritative refresh');
});

for (const [label, mutate] of [
  ['legacy missing selection', pair => { delete pair.successor.selectionState; }],
  ['legacy missing admission', pair => { delete pair.successor.admissionState; }],
  ['legacy missing requirement', pair => { delete pair.replaceRequires; }],
  ['unknown admission', pair => { pair.successor.admissionState = 'unknown'; }],
  ['invalid selection', pair => { pair.successor.selectionState = 'invalid'; }],
  ['pending without requirement', pair => { pair.successor.admissionState = 'pending'; }],
  ['accepted with pending requirement', pair => { pair.replaceRequires = 'successor-admission'; }],
  ['unaccepted predecessor', pair => { pair.predecessor.admissionState = 'pending'; }],
]) test(`unsupported eligibility fails closed: ${label}`, async () => {
  const f = setup(); let calls = 0;
  f.crate.resolveWorkingSourceContinuation = async () => { calls++; };
  const review = pairReview(f), pair = review.sourceContinuation.candidates[0]; mutate(pair);
  Object.assign(review, { materializable: true, token: 'must-not-use' });
  f.renderer.renderPackageReview(f.project, review);
  assert.equal(f.renderer.getContinuationCandidates(review).length, 0);
  assert.equal(buttonFor(f.elements['source-continuation-choices'], 'Replace'), undefined);
  assert.equal(f.elements['btn-confirm-package'].disabled, true);
  assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null);
  assert.equal(await f.renderer.chooseSourceContinuation(f.project, pair, 'replace', vm.runInContext('packageReviewContents.lease', f.renderer)), false);
  assert.equal(calls, 0);
});

test('admission-required refusal refreshes ordinary files and gives truthful recovery without a selection request', async () => {
  const f = setup(); const order = []; let message;
  f.crate.resolveWorkingSourceContinuation = async () => { order.push('resolve'); return { success: false, error: 'continuation_admission_required' }; };
  const review = pairReview(f), pair = review.sourceContinuation.candidates[0]; f.renderer.renderPackageReview(f.project, review);
  const renderFiles = f.renderer.renderFiles;
  f.renderer.renderFiles = async options => { assert.equal(options.isCurrent(), true); order.push('workspace'); return renderFiles(options); };
  f.renderer.showPackageModal = async options => { order.push('prepare'); message = options.message; };
  assert.equal(await f.renderer.chooseSourceContinuation(f.project, pair, 'replace', vm.runInContext('packageReviewContents.lease', f.renderer)), false);
  assert.match(message, /Close Package Review to return to your files/);
  assert.match(message, /cannot add it to the project/);
  assert.doesNotMatch(message, /Choice saved/);
  assert.deepEqual(order, ['resolve', 'workspace', 'prepare']); assert.equal(f.calls.length, 0);
});

test('pending successor enables Replace only after a fresh accepted projection', () => {
  const f = setup(); f.crate.resolveWorkingSourceContinuation = async () => ({ success: true, projectId: f.project.id });
  const pendingReview = pairReview(f), pendingPair = pendingReview.sourceContinuation.candidates[0];
  pendingPair.successor.admissionState = 'pending'; pendingPair.replaceRequires = 'successor-admission';
  f.renderer.renderPackageReview(f.project, pendingReview);
  assert.equal(buttonFor(f.elements['source-continuation-choices'], 'Replace').disabled, true);
  const freshReview = pairReview(f); freshReview.sourceContinuation.candidates[0].revision++;
  assert.equal(f.renderer.renderPackageReview(f.project, freshReview, '', vm.runInContext('packageReviewContents.lease', f.renderer)), true);
  assert.equal(buttonFor(f.elements['source-continuation-choices'], 'Replace').disabled, false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.elements['btn-confirm-package'].disabled, true, 'fresh eligibility is not package readiness');
});

test('lost resolver reply refreshes authoritative rows before reprepare without replaying the choice', async () => {
  const f = setup(); const order = []; let message;
  f.crate.resolveWorkingSourceContinuation = async () => { order.push('resolve'); throw new Error('reply lost'); };
  const review = pairReview(f); f.renderer.renderPackageReview(f.project, review);
  const renderFiles = f.renderer.renderFiles;
  f.renderer.renderFiles = async options => { assert.equal(options.isCurrent(), true); order.push('workspace'); return renderFiles(options); };
  f.renderer.showPackageModal = async options => { order.push('prepare'); message = options.message; };
  assert.equal(await f.renderer.chooseSourceContinuation(f.project, review.sourceContinuation.candidates[0], 'replace', vm.runInContext('packageReviewContents.lease', f.renderer)), false);
  assert.deepEqual(order, ['resolve', 'workspace', 'prepare']);
  assert.doesNotMatch(message, /Choice saved/); assert.equal(f.calls.length, 0);
});

test('lost resolver reply and project switch during refresh never prepare the old pair', async () => {
  const f = setup(); const gate = deferred(); let preparations = 0;
  f.crate.resolveWorkingSourceContinuation = async () => { throw new Error('reply lost'); };
  const review = pairReview(f); f.renderer.renderPackageReview(f.project, review);
  f.renderer.renderFiles = () => gate.promise; f.renderer.showPackageModal = async () => { preparations++; };
  const pending = f.renderer.chooseSourceContinuation(f.project, review.sourceContinuation.candidates[0], 'replace', vm.runInContext('packageReviewContents.lease', f.renderer));
  await new Promise(resolve => setImmediate(resolve));
  vm.runInContext('projectSelectionEpoch += 1', f.renderer); gate.resolve();
  assert.equal(await pending, false); assert.equal(preparations, 0);
});

test('unexpected workspace refresh exception keeps packaging blocked instead of preparing stale facts', async () => {
  const f = setup(); let preparations = 0;
  f.crate.resolveWorkingSourceContinuation = async () => ({ success: true, projectId: f.project.id });
  const review = pairReview(f); f.renderer.renderPackageReview(f.project, review);
  f.elements['source-continuation-status'] = descendants(f.elements['source-continuation-choices']).find(node => node.id === 'source-continuation-status');
  f.renderer.renderFiles = async () => { throw new Error('refresh failed'); };
  f.renderer.showPackageModal = async () => { preparations++; };
  assert.equal(await f.renderer.chooseSourceContinuation(f.project, review.sourceContinuation.candidates[0], 'replace', vm.runInContext('packageReviewContents.lease', f.renderer)), false);
  assert.equal(preparations, 0); assert.equal(f.elements['btn-confirm-package'].disabled, true);
  assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null);
  assert.match(getElementTreeText(f.elements['source-continuation-choices']), /could not refresh the current files/);
  assert.equal(await f.renderer.chooseSourceContinuation(f.project, review.sourceContinuation.candidates[0], 'replace', vm.runInContext('packageReviewContents.lease', f.renderer)), false);
});

for (const identityStatus of ['changed', 'unavailable']) {
  for (const admissionState of ['accepted', 'pending']) {
    test(`v11 identity hold: ${identityStatus}, ${admissionState} successor`, async () => {
      const f = setup(); let calls = 0;
      f.crate.resolveWorkingSourceContinuation = async () => { calls++; };
      const review = pairReview(f), pair = review.sourceContinuation.candidates[0];
      Object.assign(pair, { identityStatus, resolutionRequires: 'identity-refresh' });
      pair.successor.admissionState = admissionState;
      pair.replaceRequires = admissionState === 'pending' ? 'successor-admission' : null;
      f.crate.preparePackageReview = async () => ({ ...review, error: 'working_source_continuation_choice_required' });
      vm.runInContext("state.packageReviewToken = 'obsolete-token'", f.renderer);
      await f.renderer.showPackageModal({ runPreScan: false });
      const region = f.elements['source-continuation-choices'];
      assert.equal(region.classList.contains('hidden'), false);
      assert.match(getElementTreeText(region), /choices are paused.*refresh the project/i);
      assert.match(getElementTreeText(region), identityStatus === 'changed' ? /identity changed/ : /could not verify/);
      for (const [choice, label] of [['replace', 'Replace'], ['keep-both', 'Keep both'], ['not-related', 'Not related']]) {
        assert.equal(buttonFor(region, label).disabled, true);
        assert.equal(await f.renderer.chooseSourceContinuation(f.project, pair, choice,
          vm.runInContext('packageReviewContents.lease', f.renderer)), false);
      }
      assert.equal(calls, 0); assert.equal(f.calls.length, 0);
      assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null);
      assert.equal(f.elements['btn-confirm-package'].disabled, true);
      assert.doesNotMatch(getElementTreeText(region), /Choose file|Add Files|automatically/i);
    });
  }
}

test('v11 identity recovery requires a fresh projection and rejects detached old choices', async () => {
  const f = setup(); let calls = 0;
  f.crate.resolveWorkingSourceContinuation = async () => { calls++; return { success: true, projectId: f.project.id }; };
  const held = pairReview(f), previous = held.sourceContinuation.candidates[0];
  Object.assign(previous, { identityStatus: 'unavailable', resolutionRequires: 'identity-refresh' });
  f.renderer.renderPackageReview(f.project, held);
  const lease = vm.runInContext('packageReviewContents.lease', f.renderer);
  const fresh = pairReview(f), current = fresh.sourceContinuation.candidates[0];
  current.revision++; current.evidenceIdentity = 'c'.repeat(64);
  f.renderer.renderPackageReview(f.project, fresh, '', lease);
  assert.equal(buttonFor(f.elements['source-continuation-choices'], 'Replace').disabled, false);
  assert.equal(await f.renderer.chooseSourceContinuation(f.project, previous, 'keep-both', lease), false);
  f.renderer.showPackageModal = async () => {};
  assert.equal(await f.renderer.chooseSourceContinuation(f.project, current, 'replace', lease), true);
  assert.equal(calls, 1); assert.equal(f.calls.length, 0);
});

for (const invalidation of ['accountWorkspaceEpoch += 1', 'projectSelectionEpoch += 1',
  'packageReviewRequestId += 1', 'assetWorkspaceRequestGeneration += 1', 'hidePackageReviewDialog()',
  "setSelectedProject('another-project')"]) {
  for (const stage of ['resolver', 'workspace']) {
    test(`v11 late ${stage} result is discarded after ${invalidation}`, async () => {
      const f = setup(); const gate = deferred(); let preparations = 0, workspaceReads = 0;
      const review = pairReview(f); f.renderer.renderPackageReview(f.project, review);
      f.crate.resolveWorkingSourceContinuation = async () => {
        if (stage === 'resolver') await gate.promise;
        return { success: true, projectId: f.project.id };
      };
      f.renderer.renderFiles = async options => {
        workspaceReads++; assert.equal(options.isCurrent(), true);
        if (stage === 'workspace') await gate.promise;
      };
      f.renderer.showPackageModal = async () => { preparations++; };
      const pending = f.renderer.chooseSourceContinuation(f.project, review.sourceContinuation.candidates[0],
        'replace', vm.runInContext('packageReviewContents.lease', f.renderer));
      await new Promise(resolve => setImmediate(resolve));
      vm.runInContext(invalidation, f.renderer); gate.resolve();
      assert.equal(await pending, false);
      assert.equal(preparations, 0); assert.equal(workspaceReads, stage === 'workspace' ? 1 : 0);
      assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null);
    });
  }
}

test('v11 pair preparation discards a response from the prior account', async () => {
  const f = setup(), gate = deferred();
  f.crate.preparePackageReview = () => gate.promise;
  const pending = f.renderer.showPackageModal({ runPreScan: false });
  vm.runInContext('accountWorkspaceEpoch += 1', f.renderer);
  gate.resolve({ ...pairReview(f), error: 'working_source_continuation_choice_required' });
  assert.equal(await pending, false);
  assert.equal(f.elements['source-continuation-choices']?.children.length || 0, 0);
  assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null);
});

test('v11 repeated submissions and superseded pair controls cannot reuse old revisions', async () => {
  const f = setup(), gate = deferred(), calls = [];
  f.crate.resolveWorkingSourceContinuation = async (...args) => { calls.push(args); return gate.promise; };
  const review = pairReview(f), oldPair = review.sourceContinuation.candidates[0];
  f.renderer.renderPackageReview(f.project, review);
  const lease = vm.runInContext('packageReviewContents.lease', f.renderer);
  const pending = f.renderer.chooseSourceContinuation(f.project, oldPair, 'replace', lease);
  assert.equal(await f.renderer.chooseSourceContinuation(f.project, oldPair, 'keep-both', lease), false);
  assert.equal(calls.length, 1);
  const fresh = pairReview(f); fresh.sourceContinuation.candidates[0].revision++;
  fresh.sourceContinuation.candidates[0].successor.selectionRevision++;
  f.renderer.renderPackageReview(f.project, fresh, '', lease);
  gate.resolve({ success: false, error: 'continuation_stale' });
  assert.equal(await pending, false, 'superseded in-flight presentation cannot reopen or replace the current view');
  assert.equal(await f.renderer.chooseSourceContinuation(f.project, oldPair, 'replace', lease), false);
  assert.equal(buttonFor(f.elements['source-continuation-choices'], 'Replace').disabled, false,
    'the fresh presentation must regain choices after the old request settles');
  assert.equal(calls.length, 1); assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null);
});

for (const choice of ['replace', 'keep-both', 'not-related']) {
  for (const successorState of ['selected', 'excluded', 'pending']) {
    if (choice === 'replace' && successorState === 'pending') continue;
    test(`v11 two-pair refresh: ${choice}, B ${successorState}, independent roots preserved`, async () => {
      const f = setup(), review = pairReview(f), first = review.sourceContinuation.candidates[0];
      first.successor.selectionState = successorState === 'excluded' ? 'excluded' : 'selected';
      first.successor.admissionState = successorState === 'pending' ? 'pending' : 'accepted';
      first.replaceRequires = successorState === 'pending' ? 'successor-admission' : null;
      const second = clone(first);
      second.pairIdentity = 'c'.repeat(64); second.evidenceIdentity = 'd'.repeat(64);
      second.predecessor = { ...second.predecessor, name: 'C.ai', visualIdentity: 'root-c' };
      second.successor = { ...second.successor, name: 'D.ai', visualIdentity: 'root-d', admissionState: 'accepted', selectionState: 'selected' };
      second.replaceRequires = null;
      let pendingPairs = [first, second], prepareCount = 0, workspaceReads = 0;
      const calls = [], order = [];
      const rows = ['Original.ai', 'Current.ai', 'C.ai', 'D.ai', 'Shared.png', 'C-only.png', 'D-only.png'].map((name, i) => ({
        ...clone(f.row), name, visualIdentity: ['old-1', 'new-1', 'root-c', 'root-d', 'shared', 'c-only', 'd-only'][i],
        visualRevision: `unchanged-bytes-${i}`, sourceSelection: i === 1 ? first.successor.selectionState : 'selected',
        projectRole: i < 4 ? 'source' : 'asset', protectedSource: i < 4, included: true,
      }));
      f.project.files = rows.filter(row => successorState !== 'pending' || row.visualIdentity !== 'new-1');
      f.project.pendingFiles = successorState === 'pending' ? [rows[1]] : [];
      f.workspace.files = f.project.files; f.workspace.pendingFiles = f.project.pendingFiles;
      const independent = clone(rows.slice(2)), originalBytes = rows[0].visualRevision;
      f.crate.getAssetWorkspace = async () => { workspaceReads++; order.push('workspace'); return clone(f.workspace); };
      f.crate.preparePackageReview = async () => {
        prepareCount++; order.push('prepare');
        return pendingPairs.length ? { ...review, error: 'working_source_continuation_choice_required',
          sourceContinuation: { ...review.sourceContinuation, candidates: clone(pendingPairs) } }
          : { projectId: f.project.id, files: [], materializable: true, token: 'fresh-after-both-pairs' };
      };
      f.crate.resolveWorkingSourceContinuation = async (projectId, request) => {
        order.push('resolve'); calls.push([projectId, clone(request)]);
        const pair = pendingPairs.find(item => item.pairIdentity === request.pairIdentity);
        assert.ok(pair); assert.equal(projectId, f.project.id);
        assert.deepEqual(clone(request), { pairIdentity: pair.pairIdentity, evidenceIdentity: pair.evidenceIdentity,
          expectedRevision: pair.revision, predecessorSelectionRevision: pair.predecessor.selectionRevision,
          successorSelectionRevision: pair.successor.selectionRevision, choice: request.choice });
        // Closed IPC response model; actual backend selectors/bytes are covered by v11's own suite.
        if (request.choice === 'replace') {
          assert.equal(pair.successor.admissionState, 'accepted');
          rows[0].sourceSelection = 'excluded'; rows[0].includedAsDependency = true;
          rows[1].sourceSelection = 'selected';
        }
        pendingPairs = pendingPairs.filter(item => item !== pair);
        return { success: true, projectId, decision: { authority: 'owner-choice', choice: request.choice } };
      };
      vm.runInContext("state.packageReviewToken = 'retired-before-choice'", f.renderer);
      await f.renderer.showPackageModal({ runPreScan: false });
      assert.equal(f.elements['source-continuation-choices'].children.filter(n => n.className === 'continuation-pair').length, 2);
      assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null);
      const currentPair = vm.runInContext('continuationChoicePresentation.candidates[0]', f.renderer);
      assert.equal(await f.renderer.chooseSourceContinuation(f.project, currentPair, choice,
        vm.runInContext('packageReviewContents.lease', f.renderer)), true);
      assert.equal(prepareCount, 2); assert.equal(workspaceReads, 1);
      assert.equal(pendingPairs.length, 1); assert.equal(pendingPairs[0].pairIdentity, second.pairIdentity);
      assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null);
      assert.equal(f.elements['btn-confirm-package'].disabled, true);
      assert.deepEqual(clone(rows.slice(2)), independent); assert.equal(rows[0].visualRevision, originalBytes);
      assert.equal(f.project.pendingFiles.length, successorState === 'pending' ? 1 : 0);
      if (choice !== 'replace') assert.equal(rows[1].sourceSelection, first.successor.selectionState);
      const remaining = vm.runInContext('continuationChoicePresentation.candidates[0]', f.renderer);
      assert.equal(await f.renderer.chooseSourceContinuation(f.project, remaining, 'not-related',
        vm.runInContext('packageReviewContents.lease', f.renderer)), true);
      assert.deepEqual(order, ['prepare', 'resolve', 'workspace', 'prepare', 'resolve', 'workspace', 'prepare']);
      assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), 'fresh-after-both-pairs');
      assert.equal(f.elements['btn-confirm-package'].disabled, false);
      assert.equal(calls.length, 2); assert.equal(f.calls.length, 0, 'no sequential selection/Restore/admission calls');
      assert.deepEqual(clone(rows.slice(2)), independent); assert.equal(rows[0].visualRevision, originalBytes);
    });
  }
}

function recoveryRow(overrides = {}) {
  return { sourceSelection: 'invalid', selectionReason: 'continuation-identity-changed', selectionRevision: 3,
    selectionRecovery: { version: 1, reason: 'continuation-identity-changed', expectedRevision: 3, actions: ['exclude', 'restore'] }, ...overrides };
}
async function recoverySetup(overrides = {}) {
  const f = setup(recoveryRow(overrides));
  await f.renderer.renderFiles();
  f.recoveryRow = () => f.elements['project-file-list'].children[0];
  f.activate = label => {
    const button = buttonFor(f.recoveryRow(), label); assert.ok(button, label);
    return button.listeners.click[0]({ stopPropagation() {} });
  };
  return f;
}

test('v14 recovery displays blocked status, dependency obligation, labeled controls and focus before pending disable', async () => {
  const f = await recoverySetup({ includedAsDependency: true });
  const row = f.recoveryRow(), button = buttonFor(row, 'Exclude'), gate = deferred();
  assert.match(getElementTreeText(row), /Needs attention/);
  assert.match(getElementTreeText(row), /does not remove that requirement/);
  assert.doesNotMatch(getElementTreeText(row), /Ready|always included/);
  assert.match(button.getAttribute('aria-label'), /Original.ai as a working file/);
  f.crate.setWorkingSourceSelection = async (...args) => { f.calls.push(args); assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null); return gate.promise; };
  vm.runInContext("state.packageReviewToken = 'old-token'", f.renderer);
  button.focus(); const pending = f.activate('Exclude');
  assert.equal(button.disabled, true); assert.equal(f.document.activeElement.getAttribute('role'), 'status');
  assert.equal(await f.activate('Restore'), false); assert.equal(f.calls.length, 1);
  assert.deepEqual(clone(f.calls[0]), [f.project.id, 'owned-source', { action: 'exclude', expectedRevision: 3 }]);
  assert.equal(await f.renderer.showPackageModal({ runPreScan: false }), false);
  gate.resolve({ success: false, error: 'working_source_selection_stale' }); await pending;
});

for (const [name, change] of [
  ['missing projection', { selectionRecovery: undefined }], ['arbitrary invalid', { selectionReason: 'malformed' }],
  ['version', { selectionRecovery: { version: 2, reason: 'continuation-identity-changed', expectedRevision: 3, actions: ['exclude'] } }],
  ['revision mismatch', { selectionRevision: 4 }], ['exhausted revision', { selectionRevision: Number.MAX_SAFE_INTEGER }],
  ['unavailable identity', { visualIdentity: null }], ['ordinary asset', { projectRole: 'asset', protectedSource: false }],
  ['unknown action', { selectionRecovery: { version: 1, reason: 'continuation-identity-changed', expectedRevision: 3, actions: ['admit'] } }],
]) test(`v14 no recovery for ${name}`, async () => {
  const f = await recoverySetup(change);
  assert.equal(buttonFor(f.recoveryRow(), 'Exclude'), undefined); assert.equal(f.calls.length, 0);
});

test('v14 missing A only offers the projected Exclude; duplicate identity and foreign workspace offer no action', async () => {
  const f = await recoverySetup({ selectionRecovery: { version: 1, reason: 'continuation-identity-changed', expectedRevision: 3, actions: ['exclude'] } });
  assert.ok(buttonFor(f.recoveryRow(), 'Exclude')); assert.equal(buttonFor(f.recoveryRow(), 'Restore'), undefined);
  assert.match(getElementTreeText(f.recoveryRow()), /Restore is unavailable/);
  f.workspace.pendingFiles.push(clone(f.row)); await f.renderer.renderFiles();
  assert.equal(buttonFor(f.recoveryRow(), 'Exclude'), undefined);
  f.workspace.projectId = 'foreign'; await f.renderer.renderFiles();
  assert.equal(buttonFor(f.recoveryRow(), 'Exclude'), undefined);
});

const recoveryInvalidations = [
  'accountWorkspaceEpoch += 1', 'accountStatus.canUseWorkspace = false', 'projectSelectionEpoch += 1',
  "state.selectedProjectId = 'foreign'", 'tabNavigationEpoch += 1', 'modalLeaseSequence += 1',
  'assetWorkspaceRequestGeneration += 1', 'assetWorkspaceRequestId += 1', 'packageReviewRequestId += 1',
];
for (const invalidation of recoveryInvalidations) for (const stage of ['before', 'pending', 'refresh']) {
  test(`v14 recovery ${stage} fence: ${invalidation}`, async () => {
    const f = await recoverySetup(), gate = deferred(); let preparations = 0;
    const oldButton = buttonFor(f.recoveryRow(), 'Exclude');
    f.crate.preparePackageReview = async () => { preparations++; return { projectId: f.project.id, materializable: false }; };
    f.crate.setWorkingSourceSelection = async (...args) => { f.calls.push(args); if (stage === 'pending') await gate.promise; return { success: true }; };
    if (stage === 'refresh') f.crate.getAssetWorkspace = async () => { await gate.promise; return clone(f.workspace); };
    if (stage === 'before') vm.runInContext(invalidation, f.renderer);
    const pending = oldButton.listeners.click[0]({ stopPropagation() {} });
    if (stage !== 'before') { await new Promise(r => setImmediate(r)); vm.runInContext(invalidation, f.renderer); gate.resolve(); }
    assert.equal(await pending, false); assert.equal(f.calls.length, stage === 'before' ? 0 : 1);
    assert.equal(preparations, 0); assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null);
  });
}

test('v14 detached and unchanged refreshed controls cannot submit old recovery', async () => {
  const f = await recoverySetup(); const old = buttonFor(f.recoveryRow(), 'Exclude');
  await f.renderer.renderFiles();
  assert.equal(await old.listeners.click[0]({ stopPropagation() {} }), false);
  const next = buttonFor(f.recoveryRow(), 'Exclude'); f.elements['project-file-list'].replaceChildren();
  assert.equal(await next.listeners.click[0]({ stopPropagation() {} }), false); assert.equal(f.calls.length, 0);
});

for (const lostReply of [false, true]) test(`v14 caught production workspace rejection never prepares after recovery; lost reply ${lostReply}`, async () => {
  const f = await recoverySetup(); let preparations = 0;
  f.crate.setWorkingSourceSelection = async (...args) => { f.calls.push(args); if (lostReply) throw Error('lost reply'); return { success: true }; };
  f.crate.getAssetWorkspace = async () => { throw Error('actual caught refresh failure'); };
  f.crate.preparePackageReview = async () => { preparations++; };
  assert.equal(await f.activate('Exclude'), false);
  assert.equal(preparations, 0); assert.equal(f.calls.length, 1);
  assert.equal(vm.runInContext('assetWorkspaceLoadedRequestId', f.renderer), 0);
  assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null);
  assert.equal(buttonFor(f.recoveryRow(), 'Exclude'), undefined);
});

test('v14 pair choice also stops on actual caught workspace failure and cannot replay detached callbacks', async () => {
  const f = setup(); let calls = 0, prepares = 0;
  f.crate.resolveWorkingSourceContinuation = async () => { calls++; return { success: true, projectId: f.project.id }; };
  f.crate.getAssetWorkspace = async () => { throw Error('actual caught workspace failure'); };
  const review = pairReview(f); f.renderer.renderPackageReview(f.project, review);
  f.crate.preparePackageReview = async () => { prepares++; };
  const choose = () => f.renderer.chooseSourceContinuation(f.project, review.sourceContinuation.candidates[0], 'replace', vm.runInContext('packageReviewContents.lease', f.renderer));
  assert.equal(await choose(), false); assert.equal(await choose(), false);
  assert.equal(prepares, 0); assert.equal(calls, 1); assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null);
});

test('v14 overlapping actual workspace refresh cannot grant a recovery review', async () => {
  const f = await recoverySetup(), gate = deferred(); let reads = 0, prepares = 0;
  f.crate.getAssetWorkspace = async () => { if (++reads === 1) await gate.promise; return clone(f.workspace); };
  f.crate.preparePackageReview = async () => { prepares++; };
  const pending = f.activate('Exclude'); await new Promise(r => setImmediate(r));
  await f.renderer.renderFiles(); gate.resolve();
  assert.equal(await pending, false); assert.equal(prepares, 0); assert.equal(f.calls.length, 1);
});


test('v14 in-place selection revision change cannot reuse an old recovery control', async () => {
  const f = await recoverySetup();
  vm.runInContext('state.assetWorkspace.files[0].selectionRevision += 1; state.assetWorkspace.files[0].selectionRecovery.expectedRevision += 1;', f.renderer);
  assert.equal(await f.activate('Exclude'), false); assert.equal(f.calls.length, 0);
});

test('v14 ordinary workspace request from prior account cannot mount recovery controls under the new account', async () => {
  const f = setup(recoveryRow()), gate = deferred();
  f.crate.getAssetWorkspace = async () => { await gate.promise; return clone(f.workspace); };
  const pending = f.renderer.renderFiles(); vm.runInContext('accountWorkspaceEpoch += 1', f.renderer); gate.resolve();
  assert.equal(await pending, undefined);
  assert.equal(f.elements['project-file-list']?.children.length || 0, 0);
});


test('v14 unavailable required asset and display fallback do not claim Ready or Selected', async () => {
  const f = setup({ sourceSelection: 'excluded', includedAsDependency: true, included: false, verificationRequired: true, verificationStatus: 'stale' });
  await f.renderer.renderFiles();
  assert.match(getElementTreeText(f.elements['project-file-list']), /Needs attention/);
  f.crate.getAssetWorkspace = async () => { throw Error('offline'); }; await f.renderer.renderFiles();
  assert.doesNotMatch(getElementTreeText(f.elements['project-file-list']), /Ready|Selected|always included/);
});

for (const [label, invalidate] of [
  ['account epoch', 'accountWorkspaceEpoch += 1'],
  ['selection round trip', 'projectSelectionEpoch += 2'],
  ['workspace generation', 'assetWorkspaceRequestGeneration += 1'],
  ['request ownership', 'assetWorkspaceRequestId += 1'],
  ['workspace object', 'state.assetWorkspace = { ...state.assetWorkspace }'],
  ['project snapshot', 'state.projects = [{ ...fixtureProject }]'],
  ['published snapshot reference', 'assetWorkspaceProjectSnapshot = null'],
]) test(`display fallback reuse rejects changed ${label} without authority`, async () => {
  const f = setup(); let reads = 0;
  f.crate.getAssetWorkspace = async () => { reads++; throw new Error('synthetic unavailable workspace'); };
  const receipt = await f.renderer.renderFiles();
  const fallback = vm.runInContext('state.assetWorkspace', f.renderer);
  assert.equal(receipt.authoritative, false);
  assert.equal(f.renderer.isAuthoritativeWorkspaceRefresh(receipt, f.project.id), false);
  assert.equal(vm.runInContext('assetWorkspaceLoadedRequestId', f.renderer), 0);
  assert.equal(await f.renderer.ensureProjectAssetWorkspace(f.project, { allowDisplayFallback: true }), fallback);
  assert.equal(reads, 1);
  vm.runInContext(invalidate, f.renderer);
  assert.equal(await f.renderer.ensureProjectAssetWorkspace(f.project, { allowDisplayFallback: true }), null);
  assert.equal(reads, 2, 'invalid display provenance must seek a new backend response');
  assert.equal(vm.runInContext('assetWorkspaceLoadedRequestId', f.renderer), 0);
  assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null);
  assert.equal(f.calls.length, 0);
});

for (const [label, invalidate] of [
  ['account epoch', 'accountWorkspaceEpoch += 1'],
  ['selection round trip', 'projectSelectionEpoch += 2'],
  ['workspace generation', 'assetWorkspaceRequestGeneration += 1'],
  ['project snapshot', 'state.projects = [{ ...fixtureProject }]'],
]) test(`stale failed render cannot publish display provenance after ${label}`, async () => {
  const f = setup(); const gate = deferred();
  const before = vm.runInContext('state.assetWorkspace', f.renderer);
  f.crate.getAssetWorkspace = () => gate.promise;
  const pending = f.renderer.renderFiles();
  vm.runInContext(invalidate, f.renderer);
  gate.resolve(null);
  assert.equal(await pending, undefined);
  assert.equal(vm.runInContext('state.assetWorkspace', f.renderer), before);
  assert.equal(vm.runInContext('displayOnlyAssetWorkspaceProvenance', f.renderer), null);
  assert.equal(vm.runInContext('assetWorkspaceLoadedRequestId', f.renderer), 0);
  assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null);
});

test('superseded failed render preserves the newer current display fallback', async () => {
  const f = setup(); const old = deferred(); let reads = 0;
  f.crate.getAssetWorkspace = async () => {
    if (++reads === 1) return old.promise;
    throw new Error('newer workspace unavailable');
  };
  const pending = f.renderer.renderFiles();
  const current = await f.renderer.renderFiles();
  assert.equal(current.authoritative, false);
  const fallback = vm.runInContext('state.assetWorkspace', f.renderer);
  old.resolve(null);
  assert.equal(await pending, undefined);
  assert.equal(await f.renderer.ensureProjectAssetWorkspace(f.project), fallback);
  assert.equal(reads, 2);
  assert.equal(vm.runInContext('assetWorkspaceLoadedRequestId', f.renderer), 0);
  assert.equal(f.renderer.isAuthoritativeWorkspaceRefresh(current, f.project.id), false);
});

test('display fallback cannot become authoritative after a refused read; real recovery supplies its own receipt', async () => {
  const f = setup(); let reads = 0;
  f.crate.getAssetWorkspace = async () => { reads++; throw new Error('workspace unavailable'); };
  const failed = await f.renderer.renderFiles();
  const fallback = vm.runInContext('state.assetWorkspace', f.renderer);
  assert.equal(await f.renderer.ensureProjectAssetWorkspace(f.project), fallback);
  assert.equal(await f.renderer.ensureProjectAssetWorkspace(f.project, { allowDisplayFallback: false }), null);
  assert.equal(reads, 2);
  assert.equal(vm.runInContext('assetWorkspaceLoadedRequestId', f.renderer), 0);
  assert.equal(f.renderer.isAuthoritativeWorkspaceRefresh(failed, f.project.id), false);
  assert.equal(await f.renderer.ensureProjectAssetWorkspace(f.project), null,
    'the refused newer read also retires old fallback request ownership');
  assert.equal(reads, 3);
  f.crate.getAssetWorkspace = async () => { reads++; return clone(f.workspace); };
  const recovered = await f.renderer.renderFiles();
  assert.equal(f.renderer.isAuthoritativeWorkspaceRefresh(recovered, f.project.id), true);
  assert.notEqual(recovered.workspace, fallback);
  assert.equal(f.renderer.isAuthoritativeWorkspaceRefresh(failed, f.project.id), false);
  assert.equal(vm.runInContext('displayOnlyAssetWorkspaceProvenance', f.renderer), null);
  assert.equal(await f.renderer.ensureProjectAssetWorkspace(f.project, { allowDisplayFallback: false }), recovered.workspace);
  assert.equal(reads, 4);
  assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null,
    'even an authoritative workspace refresh does not itself issue a review token');
  assert.equal(f.calls.length, 0);
});

// v20: use the production modal/key handler and both mounted recovery lists.
for (const listId of ['project-file-list', 'working-assets-list']) {
  test(`v20 Escape renews ${listId} recovery while unchanged old callbacks stay refused`, async () => {
    const f = setup(recoveryRow());
    vm.runInContext(`state.assetReviewOpen = ${listId === 'working-assets-list'}`, f.renderer);
    await f.renderer.renderFiles();
    const old = buttonFor(f.elements[listId], 'Exclude');
    const initial = clone(f.workspace), revision = f.row.selectionRevision;
    await f.renderer.showPackageModal({ runPreScan: false });
    assert.equal(f.elements['modal-package'].classList.contains('hidden'), false);
    let prevented = false;
    await f.renderer.handlePackageReviewKeydown({ key: 'Escape', preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.equal(f.elements['modal-package'].classList.contains('hidden'), true);
    assert.deepEqual(clone(f.workspace), initial, 'no watcher, mutation, revision or byte change to renew controls');
    assert.equal(await old.listeners.click[0]({ stopPropagation() {} }), false);
    assert.equal(f.calls.length, 0);
    const current = buttonFor(f.elements[listId], 'Exclude');
    assert.ok(current); assert.notEqual(current, old); assert.equal(current.disabled, false);
    assert.equal(await current.listeners.click[0]({ stopPropagation() {} }), false, 'modeled backend refusal is preserved');
    assert.deepEqual(clone(f.calls), [[f.project.id, 'owned-source', { action: 'exclude', expectedRevision: revision }]]);
    assert.equal(await old.listeners.click[0]({ stopPropagation() {} }), false);
    assert.equal(f.calls.length, 1);
  });

  for (const scenario of ['refusal', 'other-invalid-row', 'project-switch']) {
    test(`v20 ${scenario} overlap releases only current ${listId} recovery controls`, async () => {
      const f = setup(recoveryRow()), gate = deferred();
      vm.runInContext(`state.assetReviewOpen = ${listId === 'working-assets-list'}`, f.renderer);
      await f.renderer.renderFiles();
      const old = buttonFor(f.elements[listId], 'Exclude');
      let reads = 0, prepares = 0;
      f.crate.getAssetWorkspace = async () => { if (++reads === 1) await gate.promise; return clone(f.workspace); };
      f.crate.preparePackageReview = async () => { prepares++; return { projectId: f.project.id, files: [], materializable: false }; };
      const pending = old.listeners.click[0]({ stopPropagation() {} });
      await new Promise(resolve => setImmediate(resolve));
      let expectedIdentity = 'owned-source';
      if (scenario !== 'refusal') {
        expectedIdentity = 'current-other-source';
        f.row = { ...clone(f.row), name: 'Other.ai', visualIdentity: expectedIdentity, selectionRevision: 7,
          selectionRecovery: { ...f.row.selectionRecovery, expectedRevision: 7 } };
        f.workspace.files = [f.row]; f.project.files = [f.row];
      }
      if (scenario === 'project-switch') {
        f.project = { ...f.project, id: 'current-project' }; f.workspace.projectId = f.project.id;
        f.renderer.nextProject = f.project;
        vm.runInContext('state.projects = [nextProject]; setSelectedProject(nextProject.id);', f.renderer);
      }
      const fresh = await f.renderer.renderFiles();
      assert.equal(f.renderer.isAuthoritativeWorkspaceRefresh(fresh, f.project.id), true);
      const locked = buttonFor(f.elements[listId], 'Exclude');
      assert.ok(locked); assert.equal(locked.disabled, true);
      assert.equal(await locked.listeners.click[0]({ stopPropagation() {} }), false);
      gate.resolve(); assert.equal(await pending, false);
      assert.equal(vm.runInContext('workingSourceRecoveryOwner', f.renderer), null);
      assert.equal(prepares, 0); assert.equal(f.calls.length, 1);
      assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null);
      const current = buttonFor(f.elements[listId], 'Exclude');
      assert.ok(current); assert.notEqual(current, locked); assert.equal(current.disabled, false);
      assert.equal(await old.listeners.click[0]({ stopPropagation() {} }), false);
      assert.equal(await locked.listeners.click[0]({ stopPropagation() {} }), false);
      assert.equal(f.calls.length, 1, 'settlement must not replay any mutation');
      await current.listeners.click[0]({ stopPropagation() {} });
      assert.equal(f.calls.length, 2);
      assert.deepEqual(clone(f.calls[1]), [f.project.id, expectedIdentity, { action: 'exclude', expectedRevision: f.row.selectionRevision }]);
      assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null);
    });
  }
}

test('v20 old recovery completion preserves a newer owner and its disabled current rows', async () => {
  const f = await recoverySetup(), gate = deferred();
  f.crate.setWorkingSourceSelection = async (...args) => { f.calls.push(args); return gate.promise; };
  const pending = f.activate('Exclude');
  // Controlled owner supersession checks the identity guard, not a second mutation.
  vm.runInContext('workingSourceRecoveryOwner = { newerOwner: true };', f.renderer);
  const owner = vm.runInContext('workingSourceRecoveryOwner', f.renderer);
  await f.renderer.renderFiles(); const current = buttonFor(f.recoveryRow(), 'Exclude');
  assert.equal(current.disabled, true);
  gate.resolve({ success: false }); assert.equal(await pending, false);
  assert.equal(vm.runInContext('workingSourceRecoveryOwner', f.renderer), owner);
  assert.equal(buttonFor(f.recoveryRow(), 'Exclude'), current); assert.equal(current.disabled, true);
  assert.equal(await current.listeners.click[0]({ stopPropagation() {} }), false); assert.equal(f.calls.length, 1);
});

for (const unavailable of ['throws', 'null', 'missing-api']) {
  test(`v20 Escape and owner release cannot promote ${unavailable} display fallback`, async () => {
    const f = await recoverySetup(), gate = deferred();
    const old = buttonFor(f.recoveryRow(), 'Exclude');
    f.crate.setWorkingSourceSelection = async (...args) => { f.calls.push(args); return gate.promise; };
    const pending = f.activate('Exclude');
    if (unavailable === 'missing-api') delete f.crate.getAssetWorkspace;
    else f.crate.getAssetWorkspace = async () => { if (unavailable === 'throws') throw Error('unavailable'); return null; };
    const failed = await f.renderer.renderFiles();
    assert.equal(failed.authoritative, false);
    gate.resolve({ success: true }); assert.equal(await pending, false);
    assert.equal(vm.runInContext('workingSourceRecoveryOwner', f.renderer), null);
    assert.equal(buttonFor(f.recoveryRow(), 'Exclude'), undefined);
    await f.renderer.showPackageModal({ runPreScan: false });
    await f.renderer.handlePackageReviewKeydown({ key: 'Escape', preventDefault() {} });
    assert.equal(vm.runInContext('assetWorkspaceLoadedRequestId', f.renderer), 0);
    assert.equal(buttonFor(f.recoveryRow(), 'Exclude'), undefined);
    assert.equal(await old.listeners.click[0]({ stopPropagation() {} }), false);
    assert.equal(f.calls.length, 1); assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null);
  });
}

// v21: drive the production account lifecycle; account snapshots and DOM remain modeled.
for (const listId of ['project-file-list', 'working-assets-list']) {
  for (const transition of ['reauthorize', 'identity-change']) {
    for (const rowKind of ['same-row', 'other-row']) for (const outcome of ['success', 'refusal', 'lost-reply']) {
      test(`v21 account ${transition} ${rowKind} delayed ${outcome} renews ${listId} at current revision`, async () => {
        const f = setup(recoveryRow()), gate = deferred();
        f.renderer.acceptAccountSnapshot({ revision: 10, state: 'signed_in', canUseWorkspace: true, identity: { id: 'account-a' } });
        vm.runInContext(`state.assetReviewOpen = ${listId === 'working-assets-list'}`, f.renderer);
        await f.renderer.renderFiles();
        const old = buttonFor(f.elements[listId], 'Exclude');
        let prepares = 0, reads = 0;
        f.crate.preparePackageReview = async () => { prepares++; return { projectId: f.project.id, files: [], materializable: false }; };
        f.crate.getAssetWorkspace = async () => { reads++; return clone(f.workspace); };
        f.crate.setWorkingSourceSelection = async (...args) => {
          f.calls.push(args);
          if (f.calls.length === 1) {
            await gate.promise;
            if (outcome === 'lost-reply') throw Error('delayed reply lost');
            return { success: outcome === 'success', projectId: f.project.id };
          }
          return { success: false, error: 'working_source_selection_stale' };
        };
        vm.runInContext("state.packageReviewToken = 'old-account-token'", f.renderer);
        const pending = old.listeners.click[0]({ stopPropagation() {} });
        assert.equal(f.calls.length, 1);
        const oldEpoch = vm.runInContext('accountWorkspaceEpoch', f.renderer);
        const oldOwner = vm.runInContext('workingSourceRecoveryOwner', f.renderer);
        if (transition === 'reauthorize') {
          f.renderer.acceptAccountSnapshot({ revision: 11, state: 'signed_out', canUseWorkspace: false, identity: null });
          assert.equal(vm.runInContext('state.assetWorkspace', f.renderer), null);
          f.renderer.acceptAccountSnapshot({ revision: 12, state: 'signed_in', canUseWorkspace: true, identity: { id: 'account-a' } });
        } else {
          f.renderer.acceptAccountSnapshot({ revision: 11, state: 'signed_in', canUseWorkspace: true, identity: { id: 'account-b' } });
        }
        assert.ok(vm.runInContext('accountWorkspaceEpoch', f.renderer) > oldEpoch);
        assert.equal(vm.runInContext('state.assetWorkspace', f.renderer), null);
        assert.equal(vm.runInContext('workingSourceRecoveryOwner', f.renderer), oldOwner);
        assert.equal(await old.listeners.click[0]({ stopPropagation() {} }), false);
        f.row = { ...f.row, selectionRevision: 7, selectionRecovery: { ...f.row.selectionRecovery, expectedRevision: 7 },
          ...(rowKind === 'other-row' ? { name: 'Current-other.ai', visualIdentity: 'current-other-source' } : {}) };
        f.workspace.files = [f.row]; f.project.files = [f.row];
        const fresh = await f.renderer.renderFiles();
        assert.equal(f.renderer.isAuthoritativeWorkspaceRefresh(fresh, f.project.id), true);
        const locked = buttonFor(f.elements[listId], 'Exclude');
        assert.ok(locked); assert.equal(locked.disabled, true);
        assert.equal(await locked.listeners.click[0]({ stopPropagation() {} }), false);
        assert.equal(reads, 1);
        gate.resolve(); assert.equal(await pending, false, 'old account result is never applied');
        assert.equal(reads, 1, 'finalization uses the current mounted workspace, not an old read');
        assert.equal(vm.runInContext('state.assetWorkspace', f.renderer), fresh.workspace);
        assert.equal(vm.runInContext('workingSourceRecoveryOwner', f.renderer), null);
        assert.equal(prepares, 0); assert.equal(f.calls.length, 1, 'no automatic mutation replay');
        assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null);
        assert.equal(f.elements['modal-package'].classList.contains('hidden'), true);
        const current = buttonFor(f.elements[listId], 'Exclude');
        assert.ok(current); assert.notEqual(current, locked); assert.equal(current.disabled, false);
        assert.equal(await old.listeners.click[0]({ stopPropagation() {} }), false);
        assert.equal(await locked.listeners.click[0]({ stopPropagation() {} }), false);
        assert.equal(f.calls.length, 1);
        await current.listeners.click[0]({ stopPropagation() {} });
        assert.equal(f.calls.length, 2);
        assert.deepEqual(clone(f.calls[1]), [f.project.id, f.row.visualIdentity, { action: 'exclude', expectedRevision: 7 }]);
        assert.equal(await current.listeners.click[0]({ stopPropagation() {} }), false);
        assert.equal(f.calls.length, 2, 'each current explicit action is sent exactly once');
        assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null);
      });
    }

    test(`v21 account ${transition} settlement preserves a newer owner in ${listId}`, async () => {
      const f = setup(recoveryRow()), gate = deferred();
      f.renderer.acceptAccountSnapshot({ revision: 10, state: 'signed_in', canUseWorkspace: true, identity: { id: 'account-a' } });
      vm.runInContext(`state.assetReviewOpen = ${listId === 'working-assets-list'}`, f.renderer);
      await f.renderer.renderFiles();
      f.crate.setWorkingSourceSelection = (...args) => { f.calls.push(args); return gate.promise; };
      const old = buttonFor(f.elements[listId], 'Exclude'), pending = old.listeners.click[0]({ stopPropagation() {} });
      if (transition === 'reauthorize') f.renderer.acceptAccountSnapshot({ revision: 11, state: 'signed_out', canUseWorkspace: false, identity: null });
      f.renderer.acceptAccountSnapshot({ revision: 12, state: 'signed_in', canUseWorkspace: true,
        identity: { id: transition === 'reauthorize' ? 'account-a' : 'account-b' } });
      // Explicit modeled owner supersession checks the guard without sending a second mutation.
      vm.runInContext('workingSourceRecoveryOwner = { account: accountWorkspaceEpoch, newerOwner: true };', f.renderer);
      const newer = vm.runInContext('workingSourceRecoveryOwner', f.renderer);
      await f.renderer.renderFiles(); const locked = buttonFor(f.elements[listId], 'Exclude');
      assert.equal(locked.disabled, true);
      gate.resolve({ success: true }); assert.equal(await pending, false);
      assert.equal(vm.runInContext('workingSourceRecoveryOwner', f.renderer), newer);
      assert.equal(buttonFor(f.elements[listId], 'Exclude'), locked); assert.equal(locked.disabled, true);
      assert.equal(await locked.listeners.click[0]({ stopPropagation() {} }), false);
      assert.equal(await old.listeners.click[0]({ stopPropagation() {} }), false);
      assert.equal(f.calls.length, 1); assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null);
    });
  }

  for (const unavailable of ['throws', 'null', 'missing-api', 'unauthorized', 'read-pending']) {
    test(`v21 account transition finalization cannot authorize ${unavailable} workspace in ${listId}`, async () => {
      const f = setup(recoveryRow()), gate = deferred(), readGate = deferred();
      f.renderer.acceptAccountSnapshot({ revision: 10, state: 'signed_in', canUseWorkspace: true, identity: { id: 'account-a' } });
      vm.runInContext(`state.assetReviewOpen = ${listId === 'working-assets-list'}`, f.renderer);
      await f.renderer.renderFiles();
      f.crate.setWorkingSourceSelection = (...args) => { f.calls.push(args); return gate.promise; };
      const old = buttonFor(f.elements[listId], 'Exclude'), pending = old.listeners.click[0]({ stopPropagation() {} });
      f.renderer.acceptAccountSnapshot({ revision: 11, state: 'signed_out', canUseWorkspace: false, identity: null });
      let readPending;
      if (unavailable !== 'unauthorized') {
        f.renderer.acceptAccountSnapshot({ revision: 12, state: 'signed_in', canUseWorkspace: true, identity: { id: 'account-a' } });
        if (unavailable === 'missing-api') delete f.crate.getAssetWorkspace;
        else f.crate.getAssetWorkspace = async () => {
          if (unavailable === 'read-pending') await readGate.promise;
          if (unavailable === 'throws') throw Error('workspace unavailable');
          return null;
        };
        readPending = f.renderer.renderFiles();
        if (unavailable !== 'read-pending') assert.equal((await readPending).authoritative, false);
      }
      const before = vm.runInContext('state.assetWorkspace', f.renderer);
      gate.resolve({ success: true }); assert.equal(await pending, false);
      assert.equal(vm.runInContext('state.assetWorkspace', f.renderer), before);
      assert.equal(vm.runInContext('workingSourceRecoveryOwner', f.renderer), null);
      assert.equal(await old.listeners.click[0]({ stopPropagation() {} }), false);
      const control = buttonFor(f.elements[listId], 'Exclude');
      if (control) assert.equal(await control.listeners.click[0]({ stopPropagation() {} }), false);
      if (unavailable === 'read-pending') { readGate.resolve(); assert.equal((await readPending).authoritative, false); }
      if (unavailable !== 'unauthorized') {
        assert.equal(vm.runInContext('assetWorkspaceLoadedRequestId', f.renderer), 0);
        assert.equal(buttonFor(f.elements[listId], 'Exclude'), undefined);
      }
      assert.equal(f.calls.length, 1); assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null);
    });
  }
}

// V24: modeled renderer coverage only. No filesystem enrollment or native delivery claim.
function coverageFixture(status = 'cap-limited', reason = 'exact-path-limit') {
  const f = setup({ watchCoverage: { status, reason, nativeDelivery: 'unverified' } });
  f.workspace.watchCoverage = { accountGeneration: 7, activationToken: 9, exactPathLimit: 256, nativeDelivery: 'unverified' };
  return f;
}
function currentCoverage(f) {
  const row = vm.runInContext('state.assetWorkspace.files[0]', f.renderer);
  return f.renderer.getWorkingSourceWatchPresentation(f.project, row);
}
function watchNodes(f, list = 'working-assets-list') {
  return descendants(f.elements[list]).filter(node => node.className === 'working-source-watch');
}
for (const [status, reasons, label] of [
  ['default-root', ['default-root-eligible'], 'Watch configured · folder'],
  ['exact-enrolled', ['exact-path-enrolled'], 'Watch configured · file'],
  ['cap-limited', ['exact-path-limit'], 'Not watched · 256-file limit'],
  ['inactive', ['watch-inactive', 'watch-unavailable', 'stale-account'], 'Not watched · inactive'],
  ['not-included', ['source-not-included'], 'Not watched · excluded'],
  ['unsupported', ['format-unsupported', 'source-not-regular', 'source-symlink', 'source-hard-linked'], 'Not watched · unsupported'],
  ['ignored', ['watcher-ignored', 'event-name-ignored'], 'Not watched · ignored'],
  ['unavailable', ['source-unavailable', 'enrollment-failed'], 'Not watched · unavailable'],
]) for (const reason of reasons) test(`v24 Watch UI status ${status}/${reason}`, async () => {
  const f = coverageFixture(status, reason);
  if (status === 'not-included') Object.assign(f.row, { sourceSelection: 'excluded', included: false });
  if (reason === 'watch-inactive') { f.project.status = 'paused'; f.workspace.watchCoverage.activationToken = null; }
  await f.renderer.renderFiles();
  assert.equal(currentCoverage(f).status, status);
  for (const list of ['working-assets-list', 'project-file-list']) {
    const nodes = watchNodes(f, list); assert.equal(nodes.length, 1);
    assert.equal(nodes[0].children[0].textContent, label);
    assert.equal(nodes[0].children[0].getAttribute('aria-label'), `Original.ai: ${label}`);
    assert.doesNotMatch(getElementTreeText(nodes[0]), /Ready|verified delivery|automatically replace/i);
    if (status === 'exact-enrolled' || status === 'default-root') assert.match(getElementTreeText(nodes[0]), /unverified/);
  }
  assert.equal(f.calls.length, 0);
});

for (const [label, mutate] of [
  ['absent envelope', f => { delete f.workspace.watchCoverage; }],
  ['absent row', f => { delete f.row.watchCoverage; }],
  ['bad envelope limit', f => { f.workspace.watchCoverage.exactPathLimit = 257; }],
  ['bad account generation', f => { f.workspace.watchCoverage.accountGeneration = '7'; }],
  ['bad activation token', f => { f.workspace.watchCoverage.activationToken = '9'; }],
  ['missing activation token', f => { delete f.workspace.watchCoverage.activationToken; }],
  ['claimed native delivery', f => { f.row.watchCoverage.nativeDelivery = 'verified'; }],
  ['claimed workspace delivery', f => { f.workspace.watchCoverage.nativeDelivery = 'verified'; }],
  ['unknown status', f => { f.row.watchCoverage.status = 'watched'; }],
  ['wrong reason', f => { f.row.watchCoverage.reason = 'exact-path-enrolled'; }],
  ['missing identity', f => { f.row.visualIdentity = null; }],
  ['missing revision', f => { f.row.visualRevision = null; }],
  ['selection unavailable', f => { f.row.selectionUnavailable = true; }],
  ['duplicate identity', f => { f.workspace.files.push({ ...f.row, name: 'Unrelated.ai' }); }],
  ['paused enrollment', f => { f.project.status = 'paused'; }],
  ['no activation enrollment', f => { f.workspace.watchCoverage.activationToken = null; }],
  ['display fallback', f => { f.crate.getAssetWorkspace = async () => null; }],
]) test(`v24 Watch UI unknown for ${label}`, async () => {
  const f = coverageFixture(); mutate(f); await f.renderer.renderFiles();
  assert.equal(currentCoverage(f).status, 'unknown');
  assert.equal(watchNodes(f)[0].children[0].textContent, 'Watch coverage unknown');
  assert.equal(f.calls.length, 0);
});

test('v24 Watch UI pending preserves Needs Save and ordinary assets have no coverage label', async () => {
  const f = coverageFixture();
  const pending = { ...f.row, name: 'Unsaved.ai', visualIdentity: 'pending-source', sourceIndex: 0,
    captureState: 'needs-save', watchCoverage: { status: 'not-admitted', reason: 'source-pending', nativeDelivery: 'unverified' } };
  f.project.pendingFiles = [pending]; f.workspace.pendingFiles = [pending];
  const asset = { ...f.row, name: 'Shared.png', ext: '.png', visualIdentity: 'shared', projectRole: 'asset', protectedSource: false,
    sourceSelection: undefined, includedAsDependency: true, requiredBy: ['C.ai', 'D.ai'], assetOrigin: 'existing' };
  f.project.files.push(asset); f.workspace.files.push(asset);
  await f.renderer.renderFiles();
  const contents = getElementTreeText(f.elements['pending-file-list']);
  assert.match(contents, /Not watched · pending/); assert.match(contents, /Needs Save/);
  assert.equal(buttonFor(f.elements['pending-file-list'], 'Add'), undefined);
  assert.equal(watchNodes(f, 'existing-assets-list').length, 0);
  assert.match(getElementTreeText(f.elements['existing-assets-list']), /Required asset/);
});

test('v24 Watch UI cap leaves valid packaging and verification copy independent', async () => {
  const f = coverageFixture(); await f.renderer.renderFiles();
  f.renderer.renderPackageReview(f.project, { projectId: f.project.id, files: [], token: 'current-token', materializable: true });
  assert.equal(f.elements['btn-confirm-package'].disabled, false);
  assert.equal(f.elements['btn-package'].disabled, false);
  const detail = currentCoverage(f).detail;
  assert.match(detail, /256 individual-file/); assert.match(detail, /eligible waiting files.*path order/);
  assert.match(detail, /still required.*does not free/); assert.match(detail, /Refreshing does not guarantee/);
  assert.match(detail, /limit alone does not prevent packaging/);
  Object.assign(f.row, { verificationRequired: true, verificationStatus: 'stale' });
  await f.renderer.renderFiles();
  const text = getElementTreeText(f.elements['working-assets-list']);
  assert.match(text, /saved file changed/); assert.match(text, /Needs attention/); assert.match(text, /256-file limit/);
  assert.equal(f.calls.length, 0);
});

test('v24 Watch UI authoritative promotion updates both rows without changing bytes or promising reorder promotion', async () => {
  const f = coverageFixture(); await f.renderer.renderFiles();
  const before = watchNodes(f)[0];
  await f.renderer.renderFiles(); assert.equal(watchNodes(f)[0], before, 'unchanged status retains the existing disclosure');
  f.row.watchCoverage = { status: 'exact-enrolled', reason: 'exact-path-enrolled', nativeDelivery: 'unverified' };
  await f.renderer.renderFiles();
  for (const list of ['working-assets-list', 'project-file-list']) {
    assert.match(getElementTreeText(f.elements[list]), /Watch configured · file/);
    assert.doesNotMatch(getElementTreeText(f.elements[list]), /256-file limit/);
  }
  assert.notEqual(watchNodes(f)[0], before);
  assert.equal(f.row.visualRevision, 'bytes-1'); assert.equal(f.calls.length, 0);
});

test('v24 Watch UI required A and C D shared roles survive coverage refresh', async () => {
  const f = coverageFixture('exact-enrolled', 'exact-path-enrolled');
  Object.assign(f.row, { name: 'A.ai', sourceSelection: 'excluded', included: true, includedAsDependency: true, effectiveRole: 'asset', requiredBy: ['C.ai'] });
  const c = { ...f.row, name: 'C.ai', visualIdentity: 'c', sourceSelection: 'selected', includedAsDependency: false, effectiveRole: 'source', requiredBy: [] };
  const d = { ...c, name: 'D.ai', visualIdentity: 'd' };
  const shared = { name: 'Shared.png', ext: '.png', projectRole: 'asset', protectedSource: false, assetOrigin: 'existing',
    visualIdentity: 'shared', visualRevision: 'shared-1', included: true, includedAsDependency: true, requiredBy: ['C.ai', 'D.ai'], watchCoverage: null };
  f.workspace.files.push(c, d, shared); f.project.files.push(c, d, shared);
  const before = clone(f.workspace.files);
  await f.renderer.renderFiles();
  assert.match(getElementTreeText(f.elements['working-assets-list']), /Still included because C.ai uses it/);
  assert.equal(watchNodes(f).length, 3);
  f.workspace.files.reverse(); await f.renderer.renderFiles();
  assert.deepEqual(clone(f.workspace.files).reverse(), before);
  assert.equal(f.elements['existing-assets-list'].__assetReviewAllItems.filter(row => row.name === 'Shared.png').length, 1);
  assert.equal(f.calls.length, 0, 'coverage rendering never sends membership changes');
});

for (const invalidation of ['accountWorkspaceEpoch += 1', 'projectSelectionEpoch += 1', 'assetWorkspaceRequestId += 1',
  'assetWorkspaceRequestGeneration += 1', "state.projects = [{ ...fixtureProject }]", "fixtureProject.status = 'paused'"]) {
  for (const route of ['renderFiles', 'ensureProjectAssetWorkspace']) test(`v24 Watch UI stale ${route}: ${invalidation}`, async () => {
    const f = coverageFixture(); const gate = deferred();
    f.crate.getAssetWorkspace = () => gate.promise;
    const before = vm.runInContext('state.assetWorkspace', f.renderer);
    const pending = route === 'renderFiles' ? f.renderer.renderFiles() : f.renderer.ensureProjectAssetWorkspace(f.project);
    vm.runInContext(invalidation, f.renderer); gate.resolve(clone(f.workspace)); await pending;
    assert.equal(vm.runInContext('state.assetWorkspace', f.renderer), before);
    assert.equal(currentCoverage(f).status, 'unknown'); assert.equal(f.calls.length, 0);
  });
}
for (const invalidation of ['state.assetWorkspace.files[0].selectionRevision += 1',
  'state.assetWorkspace.files[0].visualRevision = "new-bytes"', 'state.assetWorkspace.files[0].includedAsDependency = true',
  'state.assetWorkspace.watchCoverage.activationToken += 1', 'accountWorkspaceEpoch += 1']) test(`v24 Watch UI rejects changed receipt: ${invalidation}`, async () => {
  const f = coverageFixture(); await f.renderer.renderFiles();
  assert.equal(currentCoverage(f).status, 'cap-limited'); vm.runInContext(invalidation, f.renderer);
  assert.equal(currentCoverage(f).status, 'unknown');
});

test('v24 Watch UI superseded response cannot overwrite current promotion', async () => {
  const f = coverageFixture(), old = deferred(); let reads = 0;
  f.crate.getAssetWorkspace = async () => ++reads === 1 ? old.promise : clone(f.workspace);
  const pending = f.renderer.renderFiles();
  const stale = clone(f.workspace);
  f.row.watchCoverage = { status: 'exact-enrolled', reason: 'exact-path-enrolled', nativeDelivery: 'unverified' };
  await f.renderer.renderFiles(); old.resolve(stale); await pending;
  assert.equal(currentCoverage(f).status, 'exact-enrolled');
  assert.doesNotMatch(getElementTreeText(f.elements['working-assets-list']), /256-file limit/);
});

for (const invalidate of ['hidePackageReviewDialog()', 'packageReviewRequestId += 1', 'projectSelectionEpoch += 1', 'accountWorkspaceEpoch += 1']) {
  test(`v24 Watch UI late pair workspace cannot publish coverage or reopen consumed action: ${invalidate}`, async () => {
    const f = coverageFixture(), gate = deferred(); let reads = 0, preparations = 0;
    await f.renderer.renderFiles();
    f.crate.resolveWorkingSourceContinuation = async () => ({ success: true, projectId: f.project.id });
    const review = pairReview(f); f.renderer.renderPackageReview(f.project, review);
    f.crate.getAssetWorkspace = () => { reads++; return gate.promise; };
    f.renderer.showPackageModal = async () => { preparations++; };
    const before = vm.runInContext('state.assetWorkspace', f.renderer);
    const pending = f.renderer.chooseSourceContinuation(f.project, review.sourceContinuation.candidates[0], 'replace', vm.runInContext('packageReviewContents.lease', f.renderer));
    await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, 1);
    vm.runInContext(invalidate, f.renderer);
    f.row.watchCoverage = { status: 'exact-enrolled', reason: 'exact-path-enrolled', nativeDelivery: 'unverified' };
    gate.resolve(clone(f.workspace)); assert.equal(await pending, false);
    assert.equal(vm.runInContext('state.assetWorkspace', f.renderer), before);
    assert.equal(preparations, 0); assert.equal(f.calls.length, 0);
  });
}

// V26 modeled regressions: virtual-source construction and connected disclosure focus.
for (const route of ['materialized', 'tracked', 'project-fallback']) {
  for (const title of ['Website', 'Website.v2', 'Design.fig']) for (const keyed of [false, true]) {
    test(`v26 Figma ${route} ${title} ${keyed ? 'opaque' : 'keyless'} keeps both virtual cards separate from physical fig`, async () => {
      const f = coverageFixture('exact-enrolled', 'exact-path-enrolled');
      Object.assign(f.row, { name: 'Physical.fig', ext: '.fig', appFamily: 'figma' });
      const identity = keyed ? 'opaque:source/17' : null;
      const asset = { name: 'Image.png', ext: '.png', appFamily: 'figma', sourceName: route === 'materialized' ? title : null,
        figmaSourceIdentity: identity, projectRole: 'asset', protectedSource: false, visualIdentity: 'image', visualRevision: 'image-1', assetOrigin: 'added' };
      f.workspace.files.push(asset); f.project.files.push(asset);
      if (route === 'tracked') f.workspace.trackedFigmaFiles = [{ displayName: title, figmaSourceIdentity: identity }];
      if (route === 'project-fallback') f.project.figmaTrackedFiles = [{ displayName: title, ...(keyed ? { fileKey: 'opaque-project-key' } : {}) }];
      await f.renderer.renderFiles();
      for (const surface of ['working-assets-list', 'project-file-list']) {
        const list = f.elements[surface];
        assert.equal(list.__assetReviewAllItems.length, 2);
        const virtualIndex = list.__assetReviewAllItems.findIndex(row => row.name === title);
        assert.ok(virtualIndex >= 0);
        assert.equal(descendants(list.children[virtualIndex]).filter(node => node.className === 'working-source-watch').length, 0);
        assert.equal(watchNodes(f, surface).length, 1);
        assert.match(getElementTreeText(watchNodes(f, surface)[0]), /Watch configured · file.*unverified/);
        assert.equal(buttonFor(list.children[virtualIndex], 'Exclude'), undefined);
      }
      assert.equal(watchNodes(f, 'added-assets-list').length, 0);
      assert.equal(f.calls.length, 0);
    });
  }
}

function connectWatchSurfaces(f, surface) {
  const dashboard = f.document.querySelector('#project-dashboard');
  const review = f.document.querySelector('#asset-review-workspace');
  dashboard.appendChild(f.elements['project-file-list']);
  review.appendChild(f.elements['working-assets-list']);
  if (surface === 'working-assets-list') f.renderer.openAssetReviewWorkspace();
  else f.renderer.closeAssetReviewWorkspace();
}
function changeCoverage(f, status) {
  if (status === 'unknown') { delete f.workspace.watchCoverage; return; }
  if (status === 'inactive') { f.project.status = 'paused'; f.workspace.watchCoverage.activationToken = null; }
  f.row.watchCoverage = { status, reason: status === 'inactive' ? 'watch-inactive' : 'exact-path-enrolled', nativeDelivery: 'unverified' };
}
for (const surface of ['working-assets-list', 'project-file-list']) {
  for (const status of ['exact-enrolled', 'inactive', 'unknown']) for (const expanded of [false, true]) {
    test(`v26 Watch focus ${surface} ${status} expanded=${expanded}`, async () => {
      const f = coverageFixture(); await f.renderer.renderFiles(); connectWatchSurfaces(f, surface);
      const old = watchNodes(f, surface)[0], summary = old.children[0]; old.open = expanded; summary.focus();
      assert.equal(summary.isConnected, true); assert.ok(f.document.activeElement === summary);
      changeCoverage(f, status); await f.renderer.renderFiles();
      const next = watchNodes(f, surface)[0];
      assert.notEqual(next, old); assert.equal(old.isConnected, false); assert.equal(summary.isConnected, false);
      assert.equal(next.dataset.watchStatus, status); assert.equal(next.open, expanded);
      assert.ok(f.document.activeElement === next.children[0]); assert.equal(f.document.activeElement.isConnected, true);
      const other = surface === 'working-assets-list' ? 'project-file-list' : 'working-assets-list';
      assert.equal(watchNodes(f, other)[0].open, false, 'duplicate identity on other surface does not inherit expansion');
      summary.focus(); assert.ok(f.document.activeElement === next.children[0], 'detached focus must be a no-op');
      assert.equal(f.calls.length, 0);
    });
  }
  test(`v26 Watch unfocused expansion remains on its own surface ${surface}`, async () => {
    const f = coverageFixture(); await f.renderer.renderFiles(); connectWatchSurfaces(f, surface);
    watchNodes(f, surface)[0].open = true;
    const button = f.document.querySelector('#btn-package'); button.focus();
    changeCoverage(f, 'exact-enrolled'); await f.renderer.renderFiles();
    assert.equal(watchNodes(f, surface)[0].open, true); assert.ok(f.document.activeElement === button);
  });
  test(`v26 Watch duplicate identities within ${surface} never restore ambiguous focus or expansion`, async () => {
    const f = coverageFixture(); await f.renderer.renderFiles(); connectWatchSurfaces(f, surface);
    const old = watchNodes(f, surface)[0]; old.open = true; old.children[0].focus();
    f.workspace.files.push({ ...f.row, name: 'Duplicate.ai' }); changeCoverage(f, 'exact-enrolled');
    await f.renderer.renderFiles();
    assert.equal(old.isConnected, false);
    assert.equal(watchNodes(f, surface).length, 2);
    assert.ok(watchNodes(f, surface).every(node => node.open === false));
    assert.ok(f.document.activeElement === f.document.body);
  });
  test(`v26 Watch source replacement in ${surface} does not inherit focus or expansion`, async () => {
    const f = coverageFixture(); await f.renderer.renderFiles(); connectWatchSurfaces(f, surface);
    const old = watchNodes(f, surface)[0]; old.open = true; old.children[0].focus();
    f.row.visualIdentity = 'unrelated-source'; changeCoverage(f, 'exact-enrolled'); await f.renderer.renderFiles();
    assert.equal(old.isConnected, false); assert.equal(watchNodes(f, surface)[0].open, false);
    assert.ok(f.document.activeElement === f.document.body);
  });
}

test('v26 DOM fixture detaches descendants on replacement and ignores detached focus', () => {
  const f = setup(), root = f.document.querySelector('#fixture-root');
  const row = f.document.createElement('div'), details = f.document.createElement('details'), summary = f.document.createElement('summary');
  row.appendChild(details); details.appendChild(summary); root.appendChild(row); summary.focus();
  assert.ok(f.document.activeElement === summary); root.innerHTML = '';
  assert.equal(summary.parentNode, details); assert.equal(summary.isConnected, false);
  assert.ok(f.document.activeElement === f.document.body); summary.focus(); assert.ok(f.document.activeElement === f.document.body);
});

for (const surface of ['working-assets-list', 'project-file-list']) {
  test(`v26 Watch identical duplicate rows remain ambiguous across repeated refresh in ${surface}`, async () => {
    const f = coverageFixture(); f.workspace.files.push({ ...f.row });
    await f.renderer.renderFiles(); connectWatchSurfaces(f, surface);
    const old = watchNodes(f, surface)[0]; old.open = true; old.children[0].focus();
    await f.renderer.renderFiles();
    assert.equal(watchNodes(f, surface).length, 2); assert.equal(old.isConnected, false);
    assert.ok(watchNodes(f, surface).every(node => node.open === false));
    assert.ok(f.document.activeElement === f.document.body);
    watchNodes(f, surface)[1].open = true; watchNodes(f, surface)[1].children[0].focus();
    f.workspace.files.pop(); await f.renderer.renderFiles();
    assert.equal(watchNodes(f, surface).length, 1); assert.equal(watchNodes(f, surface)[0].open, false);
    assert.ok(f.document.activeElement === f.document.body);
  });
  test(`v26 Watch reorder follows source and retains independent expansion in ${surface}`, async () => {
    const f = coverageFixture(); f.workspace.files.push({ ...f.row, name: 'Second.ai', visualIdentity: 'second' });
    await f.renderer.renderFiles(); connectWatchSurfaces(f, surface);
    watchNodes(f, surface)[0].open = true; watchNodes(f, surface)[0].children[0].focus();
    changeCoverage(f, 'exact-enrolled'); f.workspace.files.reverse(); await f.renderer.renderFiles();
    assert.equal(watchNodes(f, surface)[1].open, true); assert.equal(watchNodes(f, surface)[0].open, false);
    assert.ok(f.document.activeElement === watchNodes(f, surface)[1].children[0]);
    assert.match(f.document.activeElement.getAttribute('aria-label'), /^Original.ai:/);
  });
  for (const invalidation of ['accountWorkspaceEpoch += 1', 'projectSelectionEpoch += 1', 'tabNavigationEpoch += 1',
    'assetWorkspaceRequestId += 1', 'assetWorkspaceRequestGeneration += 1', 'modalLeaseSequence += 1', 'packageReviewRequestId += 1',
    'state.assetReviewOpen = !state.assetReviewOpen']) {
    test(`v26 Watch pending refresh cannot restore stale focus ${surface}: ${invalidation}`, async () => {
      const f = coverageFixture(); await f.renderer.renderFiles(); connectWatchSurfaces(f, surface);
      const old = watchNodes(f, surface)[0]; old.open = true; old.children[0].focus();
      const gate = deferred(); f.crate.getAssetWorkspace = () => gate.promise;
      changeCoverage(f, 'exact-enrolled'); const pending = f.renderer.renderFiles();
      vm.runInContext(invalidation, f.renderer);
      gate.resolve(clone(f.workspace)); await pending;
      if (old.isConnected) assert.ok(f.document.activeElement === old.children[0], 'rejected render leaves connected focus alone');
      else assert.ok(f.document.activeElement === f.document.body, 'retired focus request cannot target a replacement');
      assert.equal(f.calls.length, 0);
    });
  }
  test(`v26 Watch pending refresh respects newer user focus in ${surface}`, async () => {
    const f = coverageFixture(); await f.renderer.renderFiles(); connectWatchSurfaces(f, surface);
    watchNodes(f, surface)[0].children[0].focus();
    const gate = deferred(); f.crate.getAssetWorkspace = () => gate.promise;
    changeCoverage(f, 'exact-enrolled'); const pending = f.renderer.renderFiles();
    const newer = f.document.querySelector('#btn-package'); newer.focus();
    gate.resolve(clone(f.workspace)); await pending;
    assert.ok(f.document.activeElement === newer);
  });
}

// V28: production renderFiles with a deferred workspace response. Focus and IPC
// are modeled; these cases are not native keyboard or VoiceOver acceptance.
for (const surface of ['working-assets-list', 'project-file-list']) {
  for (const outcome of ['replaced', 'reordered', 'removed', 'ambiguous', 'identity-changed', 'action', 'external', 'body', 'hidden', 'filtered-out']) {
    test(`v28 latest focus ${surface}: ${outcome}`, async () => {
      const f = coverageFixture();
      const second = { ...f.row, name: 'Second.ai', visualIdentity: 'second-source' };
      f.workspace.files.push(second); f.project.files.push(second);
      await f.renderer.renderFiles(); connectWatchSurfaces(f, surface);
      const [oldA, oldB] = watchNodes(f, surface);
      oldA.children[0].focus();
      const gate = deferred(); f.crate.getAssetWorkspace = () => gate.promise;
      const pending = f.renderer.renderFiles();
      let newer = oldB.children[0];
      if (outcome === 'action') newer = buttonFor(f.elements[surface].children[1], 'Exclude');
      if (outcome === 'external') newer = f.document.querySelector('#btn-package');
      assert.ok(newer); newer.focus();
      if (outcome === 'body') f.document.activeElement = f.document.body;
      changeCoverage(f, 'exact-enrolled'); second.watchCoverage = { ...f.row.watchCoverage };
      if (outcome === 'removed') f.workspace.files = [f.row];
      if (outcome === 'ambiguous') f.workspace.files.push({ ...second });
      if (outcome === 'identity-changed') second.visualIdentity = 'unrelated-new-source';
      if (outcome === 'reordered') f.workspace.files.reverse();
      if (outcome === 'hidden' || outcome === 'filtered-out') f.elements[surface].classList.add(outcome);
      gate.resolve(clone(f.workspace)); await pending;
      assert.equal(oldA.isConnected, false); assert.equal(oldB.isConnected, false);
      const next = watchNodes(f, surface);
      if (outcome === 'replaced' || outcome === 'reordered') {
        const index = outcome === 'reordered' ? 0 : 1;
        assert.ok(f.document.activeElement === next[index].children[0]);
        assert.match(f.document.activeElement.getAttribute('aria-label'), /^Second.ai:/);
        assert.ok(f.document.activeElement.closest('[data-render-key]').parentElement === f.elements[surface]);
      } else if (outcome === 'external') assert.ok(f.document.activeElement === newer);
      else assert.ok(f.document.activeElement === f.document.body, 'retire unsupported or ambiguous newer intent; never return to A');
      assert.equal(f.calls.length, 0);
      assert.equal(f.project.files.length, 2, 'independent selected sources remain intact');
    });
  }
  for (const invalidation of ['accountWorkspaceEpoch += 1', 'projectSelectionEpoch += 1', 'tabNavigationEpoch += 1',
    'assetWorkspaceRequestId += 1', 'assetWorkspaceRequestGeneration += 1', 'modalLeaseSequence += 1', 'packageReviewRequestId += 1',
    'state.assetReviewOpen = !state.assetReviewOpen']) {
    test(`v28 latest focus retains context fence ${surface}: ${invalidation}`, async () => {
      const f = coverageFixture(), second = { ...f.row, name: 'Second.ai', visualIdentity: 'second-source' };
      f.workspace.files.push(second); await f.renderer.renderFiles(); connectWatchSurfaces(f, surface);
      const [oldA, oldB] = watchNodes(f, surface); oldA.children[0].focus();
      const gate = deferred(); f.crate.getAssetWorkspace = () => gate.promise;
      const pending = f.renderer.renderFiles(); oldB.children[0].focus();
      changeCoverage(f, 'exact-enrolled'); second.watchCoverage = { ...f.row.watchCoverage };
      vm.runInContext(invalidation, f.renderer); gate.resolve(clone(f.workspace)); await pending;
      if (oldB.isConnected) assert.ok(f.document.activeElement === oldB.children[0]);
      else assert.ok(f.document.activeElement === f.document.body);
      assert.equal(f.calls.length, 0);
    });
  }
}

for (const surface of ['working-assets-list', 'project-file-list']) {
  test(`v28 ordinary unchanged focus ${surface}`, async () => {
    const f = coverageFixture(); await f.renderer.renderFiles(); connectWatchSurfaces(f, surface);
    const original = watchNodes(f, surface)[0]; original.children[0].focus();
    const gate = deferred(); f.crate.getAssetWorkspace = () => gate.promise;
    const pending = f.renderer.renderFiles(); gate.resolve(clone(f.workspace)); await pending;
    assert.ok(watchNodes(f, surface)[0] === original, 'unchanged row keeps its node');
    assert.ok(f.document.activeElement === original.children[0]);
    assert.equal(f.calls.length, 0);
  });
}
// V30: an external starting control must not outrank incoming Watch intent.
// Production rendering runs against the retained modeled DOM and held IPC.
for (const surface of ['working-assets-list', 'project-file-list']) {
  for (const origin of ['package', 'source-action']) for (const outcome of ['unchanged', 'replaced', 'reordered', 'removed', 'ambiguous', 'identity-changed', 'unsupported', 'hidden', 'filtered-out', 'external']) {
    test(`v30 incoming Watch focus ${surface} ${origin}: ${outcome}`, async () => {
      const f = coverageFixture();
      const second = { ...f.row, name: 'Second.ai', visualIdentity: 'second-source' };
      f.workspace.files.push(second); f.project.files.push(second);
      await f.renderer.renderFiles(); connectWatchSurfaces(f, surface);
      const original = origin === 'package' ? f.document.querySelector('#btn-package') : buttonFor(f.elements[surface].children[0], 'Exclude');
      assert.ok(original); original.focus();
      const old = watchNodes(f, surface)[1]; old.open = true;
      const gate = deferred(); f.crate.getAssetWorkspace = () => gate.promise;
      const pending = f.renderer.renderFiles(); old.children[0].focus();
      assert.ok(f.document.activeElement === old.children[0]);
      const newer = buttonFor(f.elements[surface].children[0], 'Exclude');
      if (outcome === 'external') { assert.ok(newer); newer.focus(); }
      if (outcome !== 'unchanged' && outcome !== 'external') {
        changeCoverage(f, 'exact-enrolled'); second.watchCoverage = { ...f.row.watchCoverage };
      }
      if (outcome === 'removed') f.workspace.files = [f.row];
      if (outcome === 'ambiguous') f.workspace.files.push({ ...second });
      if (outcome === 'identity-changed') second.visualIdentity = 'unrelated-source';
      if (outcome === 'unsupported') { second.ext = ''; second.name = 'Source without extension'; }
      if (outcome === 'reordered') f.workspace.files.reverse();
      if (outcome === 'hidden' || outcome === 'filtered-out') f.elements[surface].classList.add(outcome);
      gate.resolve(clone(f.workspace)); await pending;
      const next = watchNodes(f, surface);
      if (['unchanged', 'replaced', 'reordered'].includes(outcome)) {
        const target = next[outcome === 'reordered' ? 0 : 1];
        assert.ok(f.document.activeElement === target.children[0], 'incoming Watch intent wins over the original external control');
        assert.equal(target === old, outcome === 'unchanged');
        assert.equal(target.open, true);
        assert.match(f.document.activeElement.getAttribute('aria-label'), /^Second.ai:/);
        assert.ok(f.document.activeElement.closest('[data-render-key]').parentElement === f.elements[surface]);
      } else if (outcome === 'external') {
        assert.equal(newer.isConnected, true); assert.ok(f.document.activeElement === newer, 'newer connected external action wins');
      } else {
        assert.equal(old.isConnected, false);
        assert.ok(f.document.activeElement === f.document.body, 'retired incoming intent must not revive the starting control');
      }
      assert.equal(f.calls.length, 0);
      assert.equal(f.project.files.length, 2, 'selected source membership remains unchanged');
    });
  }
  for (const invalidation of ['accountWorkspaceEpoch += 1', 'projectSelectionEpoch += 1', 'tabNavigationEpoch += 1',
    'assetWorkspaceRequestId += 1', 'assetWorkspaceRequestGeneration += 1', 'modalLeaseSequence += 1', 'packageReviewRequestId += 1',
    'state.assetReviewOpen = !state.assetReviewOpen', 'fileWorkspaceRenderRequestId += 1']) {
    test(`v30 incoming Watch context fence ${surface}: ${invalidation}`, async () => {
      const f = coverageFixture(); await f.renderer.renderFiles(); connectWatchSurfaces(f, surface);
      const original = f.document.querySelector('#btn-package'); original.focus();
      const old = watchNodes(f, surface)[0];
      const gate = deferred(); f.crate.getAssetWorkspace = () => gate.promise;
      const pending = f.renderer.renderFiles(); old.children[0].focus();
      changeCoverage(f, 'exact-enrolled'); vm.runInContext(invalidation, f.renderer);
      gate.resolve(clone(f.workspace)); await pending;
      if (old.isConnected) assert.ok(f.document.activeElement === old.children[0], 'rejected rendering preserves connected intent');
      else assert.ok(f.document.activeElement === f.document.body, 'original context must fence the incoming Watch target');
      assert.equal(f.calls.length, 0);
    });
  }
}
