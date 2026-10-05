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
  vm.runInContext('state.projects = [fixtureProject]; state.selectedProjectId = fixtureProject.id; state.assetWorkspace = fixtureWorkspace; assetWorkspaceProjectSnapshot = fixtureProject; accountStatus.canUseWorkspace = true;', renderer);
  const notices = [];
  renderer.showToast = message => notices.push(message);
  return { renderer, document, elements, project, workspace, row, calls, crate, notices };
}
function descendants(node) { return [node, ...(node.children || []).flatMap(descendants)]; }
function buttonFor(node, text) { return descendants(node).find(child => child.tagName === 'BUTTON' && child.textContent === text); }

for (const failure of ['rejection', 'error-response-refresh-failure', 'error-response-same-snapshot']) {
  for (const recovery of ['still-unavailable', 'fresh-membership', 'legacy-backend']) {
    test(`cached display fallback cannot supply Package Review: ${failure}, ${recovery}`, async () => {
      const f = setup({ sourceSelection: 'excluded', included: false, excluded: false });
      const required = { name: 'Required.png', ext: '.png', path: '/synthetic/Required.png',
        projectRole: 'asset', effectiveRole: 'asset', assetOrigin: 'existing',
        excluded: true, included: true, includedAsDependency: true };
      f.project.files.push(required); f.workspace.files.push(required);
      f.project.excludedAssetKeys = [required.path];
      let workspaceReads = 0;
      f.crate.getAssetWorkspace = async () => { workspaceReads++; throw new Error('synthetic workspace failure'); };
      await f.renderer.renderFiles();
      const displayFallback = vm.runInContext('state.assetWorkspace', f.renderer);
      assert.deepEqual(Array.from(displayFallback.files, file => file.name), ['Original.ai', 'Required.png']);
      assert.ok(displayFallback.files.every(file => file.selectionUnavailable && !file.visualIdentity));
      assert.match(getElementTreeText(f.elements['working-assets-list']), /Original.ai/);
      assert.equal(await f.renderer.ensureProjectAssetWorkspace(f.project), displayFallback,
        'the existing display consumer may still reuse its harmless fallback');
      assert.equal(workspaceReads, 1);

      f.crate.getAssetWorkspace = async () => {
        workspaceReads++;
        if (recovery === 'still-unavailable') throw new Error('synthetic workspace still unavailable');
        if (recovery === 'legacy-backend') return { projectId: f.project.id,
          files: [{ name: 'Legacy.png', ext: '.png', projectRole: 'asset', assetOrigin: 'existing' }], pendingFiles: [] };
        return clone(f.workspace);
      };
      f.crate.getProjects = async () => {
        if (failure === 'error-response-refresh-failure') throw new Error('synthetic project refresh failure');
        return [f.project];
      };
      f.crate.preparePackageReview = async () => {
        if (failure === 'rejection') throw new Error('synthetic preparation rejection');
        return { projectId: f.project.id, error: 'package_review_unavailable' };
      };
      let renderedReview;
      const render = f.renderer.renderPackageReview;
      f.renderer.renderPackageReview = (...args) => { renderedReview = args[1]; return render(...args); };
      vm.runInContext("state.packageReviewToken = 'obsolete-token'", f.renderer);
      assert.equal(await f.renderer.showPackageModal({ runPreScan: false }), false);
      const names = recovery === 'still-unavailable' ? [] : [recovery === 'legacy-backend' ? 'Legacy.png' : 'Required.png'];
      assert.ok(renderedReview);
      assert.deepEqual(Array.from(renderedReview.files, file => file.name), names);
      assert.equal(workspaceReads, 2, 'recovery must seek backend authority instead of accepting a local display cache');
      assert.equal(renderedReview.totalFiles, names.length);
      assert.equal(f.elements['modal-file-list'].children.length, names.length);
      const contents = getElementTreeText(f.elements['modal-file-list']);
      assert.ok(!contents.includes('Original.ai'));
      for (const name of names) assert.ok(contents.includes(name));
      assert.equal(f.elements['package-review-total'].textContent, `${names.length} visual asset${names.length === 1 ? '' : 's'}`);
      const summary = getElementTreeText(f.elements['package-review-summary-list']);
      for (const label of ['Working files 0', `Existing assets ${names.length}`, 'Added while working 0', `Needs Review ${names.length}`]) {
        assert.ok(summary.includes(label), summary);
      }
      assert.equal(renderedReview.materializable, false);
      assert.equal(renderedReview.token, undefined);
      assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null);
      assert.equal(f.elements['btn-confirm-package'].disabled, true);
      for (const file of renderedReview.files) {
        assert.equal(file.selectionUnavailable, true);
        assert.equal(file.visualIdentity, null);
        assert.equal(file.visualRevision, null);
        assert.equal(file.path, undefined);
      }
      if (recovery === 'still-unavailable') {
        assert.equal(vm.runInContext('state.assetWorkspace', f.renderer), displayFallback,
          'seeking recovery authority must not remove the existing display fallback');
      }
    });
  }
}

for (const failure of ['error-response', 'rejection']) {
  const cases = [
    { label: 'excluded working root', row: { sourceSelection: 'excluded', included: false, excluded: false },
      names: [], working: 0, existing: 0, added: 0 },
    { label: 'excluded required dependency', row: { name: 'Required.png', ext: '.png', projectRole: 'asset',
      effectiveRole: 'asset', excluded: true, included: true, includedAsDependency: true, assetOrigin: 'existing',
      path: '/synthetic/Required.png' }, names: ['Required.png'], working: 0, existing: 1, added: 0 },
    { label: 'working root retained as asset', row: { sourceSelection: 'excluded', included: true,
      includedAsDependency: true, effectiveRole: 'asset', projectRole: 'source', assetOrigin: 'added' },
      names: ['Original.ai'], working: 0, existing: 0, added: 1 },
    { label: 'legacy membership and role', row: { included: undefined, effectiveRole: 'invalid',
      projectRole: 'source' }, names: ['Original.ai'], working: 1, existing: 0, added: 0 },
    { label: 'unavailable workspace', row: {}, unavailable: true, names: [], working: 0, existing: 0, added: 0 },
  ];
  for (const scenario of cases) test(`unavailable Package Review ${failure}: ${scenario.label}`, async () => {
    const f = setup(scenario.row);
    // A raw project inventory must not stand in for unavailable workspace data.
    f.project.files.push({ name: 'Raw-only.ai', projectRole: 'source' });
    f.project.excludedAssetKeys = ['/synthetic/Required.png', '/synthetic/Legacy-key.png'];
    if (scenario.label === 'legacy membership and role') {
      f.workspace.files.push(
        { name: 'Legacy-direct.png', excluded: true },
        { name: 'Legacy-key.png', path: '/synthetic/Legacy-key.png' }
      );
    }
    if (scenario.unavailable) {
      vm.runInContext('state.assetWorkspace = null', f.renderer);
      f.crate.getAssetWorkspace = async () => null;
    }
    f.crate.preparePackageReview = async () => {
      if (failure === 'rejection') throw new Error('synthetic preparation failure');
      return { projectId: f.project.id, error: 'package_review_unavailable' };
    };
    let renderedReview;
    const render = f.renderer.renderPackageReview;
    f.renderer.renderPackageReview = (...args) => { renderedReview = args[1]; return render(...args); };
    vm.runInContext("state.packageReviewToken = 'obsolete-token'", f.renderer);
    assert.equal(await f.renderer.showPackageModal({ runPreScan: false }), false);
    assert.ok(renderedReview, 'the real preparation recovery route must render its fallback');
    assert.deepEqual(Array.from(renderedReview.files, file => file.name), scenario.names);
    assert.equal(renderedReview.totalFiles, scenario.names.length);
    assert.equal(f.elements['package-review-total'].textContent,
      `${scenario.names.length} visual asset${scenario.names.length === 1 ? '' : 's'}`);
    const summary = getElementTreeText(f.elements['package-review-summary-list']);
    for (const [label, count] of [['Working files', scenario.working], ['Existing assets', scenario.existing],
      ['Added while working', scenario.added], ['Needs Review', scenario.names.length]]) {
      assert.ok(summary.includes(`${label} ${count}`), `${label} agrees with effective fallback contents: ${summary}`);
    }
    const contents = getElementTreeText(f.elements['modal-file-list']);
    assert.equal(f.elements['modal-file-list'].children.length, scenario.names.length);
    for (const name of scenario.names) assert.ok(contents.includes(name));
    for (const name of ['Raw-only.ai', 'Legacy-direct.png', 'Legacy-key.png',
      ...(scenario.names.includes('Original.ai') ? [] : ['Original.ai'])]) assert.ok(!contents.includes(name));
    assert.equal(renderedReview.materializable, false);
    assert.equal(renderedReview.token, undefined);
    assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null);
    assert.equal(f.elements['btn-confirm-package'].disabled, true);
    assert.equal(f.elements['package-review-ready'].textContent, 'Review required');
    for (const file of renderedReview.files) {
      assert.equal(file.status, 'unavailable');
      assert.equal(file.selectionUnavailable, true);
      assert.equal(file.visualIdentity, null);
      assert.equal(file.visualRevision, null);
      assert.equal(file.path, undefined);
      assert.equal(file.captureEvidence, undefined);
    }
  });
}

for (const projectStatus of ['paused', 'packaged']) test(`${projectStatus} status uses current inclusion through Exclude and Restore`, async () => {
  const f = setup(); f.project.status = projectStatus;
  // Keep the raw inventory unchanged throughout, including an old exclusion
  // overridden by the backend's current required-asset membership.
  const later = { ...f.row, name: 'Later.ai', visualIdentity: 'later-source' };
  const required = { name: 'Required.png', path: '/synthetic/Required.png', visualIdentity: 'required-asset', included: true,
    includedAsDependency: true, effectiveRole: 'asset' };
  f.project.files.push(later, required); f.project.excludedAssetKeys = ['/synthetic/Required.png'];
  f.workspace.files = [f.row, later, required];
  f.renderer.renderProjectRows();
  const initialSignature = f.renderer.getRendererItemSignature(f.project);
  assert.match(f.renderer.getStatusLabel(f.project), /3 included files$/);
  later.sourceSelection = 'excluded'; later.included = false;
  f.renderer.renderProjectRows();
  assert.notEqual(f.renderer.getRendererItemSignature(f.project), initialSignature, 'membership must invalidate keyed project cards');
  assert.match(f.elements['project-rows'].children[0].innerHTML, /2 included files/);
  if (projectStatus === 'paused') {
    await f.renderer.renderFiles();
    assert.equal(f.elements['files-status-text'].textContent, 'Paused · 2 included files');
  }
  later.sourceSelection = 'selected'; later.included = true;
  f.renderer.fixtureWorkspace = f.workspace;
  vm.runInContext('state.assetWorkspace = fixtureWorkspace', f.renderer);
  f.renderer.renderProjectRows();
  assert.match(f.elements['project-rows'].children[0].innerHTML, /3 included files/);
  if (projectStatus === 'paused') {
    await f.renderer.renderFiles();
    assert.equal(f.elements['files-status-text'].textContent, 'Paused · 3 included files');
  }
});

for (const unavailable of ['missing', 'foreign', 'incomplete', 'refreshing', 'empty-fallback', 'account-blocked']) test(`status omits unverified membership count: ${unavailable}`, async () => {
  const f = setup(); f.project.status = 'paused';
  if (unavailable === 'missing') vm.runInContext('state.assetWorkspace = null', f.renderer);
  if (unavailable === 'foreign') f.workspace.projectId = 'another-project';
  if (unavailable === 'incomplete') delete f.row.included;
  if (unavailable === 'refreshing') vm.runInContext('assetWorkspaceRequestId += 1', f.renderer);
  if (unavailable === 'empty-fallback') { f.workspace.files = []; delete f.workspace.semanticCounts; }
  if (unavailable === 'account-blocked') vm.runInContext('accountStatus.canUseWorkspace = false', f.renderer);
  assert.equal(f.renderer.getStatusLabel(f.project), 'Paused');
  f.project.status = 'packaged';
  assert.equal(f.renderer.getStatusLabel(f.project), 'Packaged');
});

test('authoritative empty membership reports zero while watching suppresses the counter', () => {
  const f = setup(); f.workspace.files = [];
  f.project.status = 'paused';
  assert.equal(f.renderer.getStatusLabel(f.project), 'Paused · 0 included files');
  f.project.status = 'watching';
  assert.equal(f.renderer.getStatusLabel(f.project), 'Watching');
});

test('status refresh discards the prior count while loading and after a workspace failure', async () => {
  const f = setup(); f.project.status = 'paused'; const gate = deferred();
  f.crate.getAssetWorkspace = () => gate.promise;
  const pending = f.renderer.renderFiles();
  assert.equal(f.elements['files-status-text'].textContent, 'Paused');
  gate.resolve(null); await pending;
  assert.equal(f.elements['files-status-text'].textContent, 'Paused');
  assert.equal(f.renderer.getStatusLabel(f.project), 'Paused');
});

test('project cards do not fetch per-project workspaces or borrow another project count', () => {
  const f = setup(); let requests = 0; f.project.status = 'paused';
  f.crate.getAssetWorkspace = async () => { requests++; return f.workspace; };
  f.renderer.foreignProject = { ...f.project, id: 'foreign-project' };
  vm.runInContext('state.projects.push(foreignProject)', f.renderer);
  f.renderer.renderProjectRows();
  assert.match(f.elements['project-rows'].children[0].innerHTML, /1 included file/);
  assert.doesNotMatch(f.elements['project-rows'].children[1].innerHTML, /included file/);
  assert.equal(requests, 0);
});

test('same-project refresh retires card counts without per-project scans and fences a pending workspace', async () => {
  const f = setup(); f.project.status = 'paused';
  await f.renderer.renderFiles();
  assert.match(f.renderer.getStatusLabel(f.project), /1 included file/);
  f.document.querySelector('#tab-projects').classList.add('active');
  f.document.querySelector('#tab-current-project').classList.remove('active');
  const gate = deferred(); let requests = 0;
  f.crate.getAssetWorkspace = () => { requests++; return gate.promise; };
  const pending = f.renderer.ensureProjectAssetWorkspace(f.project);
  await pending; // This read is satisfied by the current cached workspace.
  vm.runInContext('assetWorkspaceRequestId += 1', f.renderer);
  const staleRead = f.renderer.ensureProjectAssetWorkspace(f.project);
  const next = clone(f.project); next.files.push({ name: 'New.ai' });
  f.renderer.freshProject = next;
  assert.equal(vm.runInContext('applyProjectRefresh([freshProject], projectRefreshGeneration, new Set([freshProject.id]), projectListReadEpoch)', f.renderer), true);
  assert.equal(f.renderer.getStatusLabel(next), 'Paused');
  gate.resolve(clone(f.workspace)); assert.equal(await staleRead, null, 'the obsolete in-flight response is rejected');
  assert.equal(f.renderer.getStatusLabel(next), 'Paused', 'old in-flight workspace cannot republish the count');
  assert.equal(requests, 1, 'project cards do not fetch a replacement projection');
  assert.doesNotMatch(f.elements['project-rows'].children[0].innerHTML, /included file/);
  f.crate.getAssetWorkspace = async () => ({ ...clone(f.workspace), files: [...clone(f.workspace.files), { name: 'New.ai', included: true }] });
  await f.renderer.renderFiles();
  assert.match(f.renderer.getStatusLabel(next), /2 included files/);
});

test('replacing the project snapshot alone cannot reuse a previous inclusion count', async () => {
  const f = setup(); f.project.status = 'paused'; await f.renderer.renderFiles();
  f.renderer.freshProject = clone(f.project);
  vm.runInContext('state.projects = [freshProject]', f.renderer);
  assert.equal(f.renderer.getStatusLabel(f.renderer.freshProject), 'Paused');
  assert.equal(f.renderer.getStatusLabel(f.project), 'Paused', 'old render callers also lose count authority');
});

for (const origin of ['existing', 'added']) test(`${origin} required override agrees with filters and excluded styling`, () => {
  const f = setup();
  const asset = { name: 'Required.png', ext: '.png', visualIdentity: 'required', projectRole: 'asset', assetOrigin: origin,
    excluded: true, included: true, includedAsDependency: true, requiredBy: ['Original.ai'] };
  f.workspace.files.push(asset); f.workspace.semanticCounts.includedAssets = 1;
  f.renderer.renderAssetWorkspace(f.project, {}, f.workspace.files);
  const list = f.elements[`${origin}-assets-list`];
  const filter = value => { f.renderer.selectedFilter = value; vm.runInContext('state.assetReviewFilter = selectedFilter', f.renderer); f.renderer.applyAssetReviewFilter(); };
  filter(origin);
  assert.equal(f.elements[`filter-count-${origin}`].textContent, '1');
  assert.equal(list.__assetReviewVirtualState.items.length, 1);
  const requiredRow = list.children.find(row => /Required.png/.test(getElementTreeText(row)));
  assert.ok(requiredRow); assert.doesNotMatch(requiredRow.className, /is-excluded/);
  assert.ok(buttonFor(requiredRow, 'Required asset'));
  filter('excluded');
  assert.equal(f.elements['filter-count-excluded'].textContent, '0');
  assert.equal(list.__assetReviewVirtualState.items.length, 0);
  Object.assign(asset, { included: false, includedAsDependency: false, requiredBy: [] });
  Object.assign(f.workspace.semanticCounts, { includedAssets: 0, excludedAssets: 1 });
  f.renderer.renderAssetWorkspace(f.project, {}, f.workspace.files);
  filter(origin); assert.equal(list.__assetReviewVirtualState.items.length, 0);
  filter('excluded'); assert.equal(list.__assetReviewVirtualState.items.length, 1);
  assert.equal(f.elements['filter-count-excluded'].textContent, '1');
  const excludedRow = list.children.find(row => /Required.png/.test(getElementTreeText(row)));
  assert.match(excludedRow.className, /is-excluded/);
});

test('effective asset filters preserve excluded working-source intent and legacy fallback', () => {
  const f = setup({ sourceSelection: 'excluded', included: true, includedAsDependency: true, effectiveRole: 'asset' });
  const legacy = { name: 'Legacy.png', visualIdentity: 'legacy', assetOrigin: 'added', excluded: true };
  f.workspace.files.push(legacy);
  Object.assign(f.workspace.semanticCounts, { selectedWorkingSources: 0, excludedWorkingSources: 1, excludedAssets: 1 });
  vm.runInContext("state.assetReviewFilter = 'excluded'", f.renderer);
  f.renderer.renderAssetWorkspace(f.project, {}, f.workspace.files);
  assert.equal(f.elements['working-assets-list'].children[0].classList.contains('filtered-out'), false);
  assert.equal(f.elements['added-assets-list'].__assetReviewVirtualState.items.length, 1);
  assert.equal(f.elements['filter-count-excluded'].textContent, '2');
});

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

for (const state of ['selected', 'excluded']) test(`working-source ${state} uses an explicit reversible action`, () => {
  const f = setup({ sourceSelection: state, included: state === 'selected' });
  const row = f.renderer.createAssetFileRow(f.project, f.row, { protectedSource: true });
  assert.ok(buttonFor(row, state === 'selected' ? 'Exclude' : 'Restore'));
  assert.doesNotMatch(getElementTreeText(row), /always included|Ready/);
});

test('excluded dependency remains required and uses safe requiring-source names', () => {
  const f = setup({ sourceSelection: 'excluded', included: true, includedAsDependency: true, effectiveRole: 'asset', requiredBy: ['Current.ai'] });
  const row = f.renderer.createAssetFileRow(f.project, f.row, { protectedSource: true });
  assert.match(getElementTreeText(row), /Still included because Current.ai uses it/);
  assert.ok(buttonFor(row, 'Restore'));
});

test('required ordinary asset does not expose a removal toggle', () => {
  const f = setup();
  const row = f.renderer.createAssetFileRow(f.project, { name: 'Link.png', includedAsDependency: true, requiredBy: ['Current.ai'] });
  assert.match(getElementTreeText(row), /Required asset/);
  const disclosure = buttonFor(row, 'Required asset');
  assert.ok(disclosure);
  disclosure.click();
  assert.match(f.notices.at(-1), /Required by Current.ai/);
  assert.equal(descendants(row).filter(child => child.className === 'working-source-detail').length, 0, 'fixed virtual row has no extra wrapping line');
});

for (const status of ['pending', 'failed', 'incomplete', 'limited', 'unavailable', 'stale']) test(`Restore ${status} never claims readiness`, () => {
  const f = setup({ verificationRequired: true, verificationStatus: status });
  const row = f.renderer.createAssetFileRow(f.project, f.row, { protectedSource: true });
  assert.match(getElementTreeText(row), status === 'pending' ? /Verifying/ : /Needs attention/);
  assert.doesNotMatch(getElementTreeText(row), /Ready|always included/);
});

test('invalid and synthetic source rows never acquire a selection command', () => {
  const f = setup({ sourceSelection: 'invalid' });
  const row = f.renderer.createAssetFileRow(f.project, f.row, { protectedSource: true });
  assert.equal(buttonFor(row, 'Exclude'), undefined);
  assert.equal(buttonFor(f.renderer.createAssetFileRow(f.project, { name: 'Figma', protectedSource: true, visualIdentity: 'figma-source:display-only' }, { protectedSource: true }), 'Exclude'), undefined);
});

test('selection status changes invalidate row reconciliation with identical file bytes', () => {
  const f = setup();
  assert.notEqual(f.renderer.getRendererItemSignature(f.row), f.renderer.getRendererItemSignature({ ...f.row, sourceSelection: 'excluded', selectionRevision: 1 }));
  assert.notEqual(f.renderer.getRendererItemSignature(f.row), f.renderer.getRendererItemSignature({ ...f.row, verificationStatus: 'failed', verificationRequired: true }));
});

test('duplicate clicks invoke once and retire the old review token immediately', async () => {
  const f = setup(); const gate = deferred();
  f.crate.setWorkingSourceSelection = async (...args) => { f.calls.push(args); return gate.promise; };
  vm.runInContext("state.packageReviewToken = 'old-token'", f.renderer);
  const first = f.renderer.changeWorkingSourceSelection(f.project, f.row, 'exclude');
  await f.renderer.changeWorkingSourceSelection(f.project, f.row, 'exclude');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(clone(f.calls[0]), [f.project.id, 'owned-source', { action: 'exclude', expectedRevision: 0 }]);
  assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null);
  gate.resolve({ success: false, error: 'working_source_selection_stale' }); await first;
  assert.match(f.notices.at(-1), /selection changed/);
});

for (const invalidate of ['projectSelectionEpoch += 1', 'accountWorkspaceEpoch += 1', 'tabNavigationEpoch += 1']) test(`late selection completion fenced by ${invalidate}`, async () => {
  const f = setup(); const gate = deferred(); let renders = 0;
  f.crate.setWorkingSourceSelection = () => gate.promise;
  f.renderer.renderFiles = async () => { renders++; };
  const pending = f.renderer.changeWorkingSourceSelection(f.project, f.row, 'exclude');
  vm.runInContext(invalidate, f.renderer);
  gate.resolve({ success: true, semanticCounts: { selectedWorkingSources: 999 } });
  await pending;
  assert.equal(renders, 0); assert.equal(f.notices.length, 0);
});

test('successful Restore intent with failed verification refetches facts and never consumes action counts', async () => {
  const f = setup({ sourceSelection: 'excluded', selectionRevision: 2 });
  f.crate.setWorkingSourceSelection = async () => {
    Object.assign(f.row, { sourceSelection: 'selected', selectionRevision: 3, verificationStatus: 'failed', verificationRequired: true });
    f.workspace.workingSourceSelectionBlocked = true; f.workspace.semanticCounts.unresolvedVerification = 1;
    return { success: true, semanticCounts: { selectedWorkingSources: 999 } };
  };
  await f.renderer.changeWorkingSourceSelection(f.project, { ...f.row }, 'restore');
  assert.match(f.notices.at(-1), /not finished successfully/);
  assert.equal(vm.runInContext('state.assetWorkspace.semanticCounts.selectedWorkingSources', f.renderer), 1);
  assert.equal(vm.runInContext('state.packageReviewToken', f.renderer), null);
});

test('semantic count summary uses backend selected/dependency counts rather than row length', () => {
  const f = setup(); Object.assign(f.workspace.semanticCounts, { selectedWorkingSources: 0, excludedWorkingSources: 1, includedAssets: 1 });
  Object.assign(f.row, { sourceSelection: 'excluded', includedAsDependency: true, effectiveRole: 'asset' });
  f.renderer.renderAssetWorkspace(f.project, {}, [f.row]);
  assert.equal(f.elements['project-file-count'].textContent, '0 of 1');
  assert.match(f.elements['working-source-summary'].textContent, /0 selected.*1 excluded.*1 included asset/);
  assert.equal(f.elements['metric-excluded-count'].textContent, '1');
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

for (const status of ['pending', 'failed', 'stale', 'incomplete']) test(`excluded required source exposes ${status} instead of claiming inclusion`, () => {
  const f = setup({ sourceSelection: 'excluded', includedAsDependency: true, included: false, verificationRequired: true, verificationStatus: status, requiredBy: ['Current.ai'] });
  const row = f.renderer.createAssetFileRow(f.project, f.row, { protectedSource: true });
  const text = getElementTreeText(row);
  assert.doesNotMatch(text, /Still included/);
  assert.match(text, status === 'pending' ? /Verifying/ : /Needs attention/);
  assert.match(text, /Excluded as a working file/);
  assert.ok(buttonFor(row, 'Restore'));
});

test('included dependency with failed verification still shows needs attention', () => {
  const f = setup({ sourceSelection: 'excluded', includedAsDependency: true, included: true, verificationRequired: true, verificationStatus: 'failed' });
  assert.equal(f.renderer.getWorkingSourceStatus(f.row).label, 'Needs attention');
});

test('navigation return does not render stale busy state and old completion preserves new owner', async () => {
  const f = setup(); const first = deferred(); const second = deferred(); let count = 0;
  f.crate.setWorkingSourceSelection = () => (++count === 1 ? first.promise : second.promise);
  const old = f.renderer.changeWorkingSourceSelection(f.project, f.row, 'exclude');
  vm.runInContext('tabNavigationEpoch += 2', f.renderer);
  const returnedRow = f.renderer.createAssetFileRow(f.project, f.row, { protectedSource: true });
  assert.equal(buttonFor(returnedRow, 'Exclude').disabled, false);
  const newer = f.renderer.changeWorkingSourceSelection(f.project, f.row, 'exclude');
  first.resolve({ success: true }); await old;
  assert.equal(f.renderer.isWorkingSourceActionPending(f.row.visualIdentity), true);
  second.resolve({ success: false, error: 'working_source_selection_stale' }); await newer;
  assert.equal(f.renderer.isWorkingSourceActionPending(f.row.visualIdentity), false);
});

test('focus skips the restored row hidden by Excluded filter and uses visible fallback', () => {
  const f = setup();
  const hidden = f.document.createElement('button'); hidden.dataset.sourceIdentity = f.row.visualIdentity;
  hidden.closest = selector => selector === '.filtered-out' ? {} : null;
  const next = f.document.createElement('button'); next.dataset.sourceIdentity = 'other-source';
  const originalQuery = f.document.querySelectorAll.bind(f.document);
  f.document.querySelectorAll = selector => selector === '.working-source-action' ? [hidden, next] : originalQuery(selector);
  f.renderer.focusWorkingSourceControl(f.row.visualIdentity);
  assert.equal(f.document.activeElement, next);
  next.closest = selector => selector === '.filtered-out' ? {} : null;
  f.renderer.focusWorkingSourceControl(f.row.visualIdentity);
  assert.notEqual(f.document.activeElement, hidden);
  assert.notEqual(f.document.activeElement, next);
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

for (const key of ['Enter', ' ']) test(`linked required asset disclosure preserves native ${key} activation in selectable row`, () => {
  const f = setup();
  const row = f.renderer.createAssetFileRow(f.project, { name: 'Required.png', linked: true, includedAsDependency: true, included: true, requiredBy: ['Current.ai'] }, { selectable: true });
  const button = buttonFor(row, 'Required asset');
  button.closest = selector => selector === 'button' ? button : null;
  let prevented = false;
  row.dispatchEvent({ type: 'keydown', key, target: button, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false, 'row must leave native button activation intact');
  assert.equal(row.classList.contains('is-selected'), false);
  button.click();
  assert.match(f.notices.at(-1), /Required by Current.ai/);
  assert.equal(row.classList.contains('has-required-dependency'), true);
  assert.match(button.className, /required-dependency-action/);
});

test('dependency action has a dedicated content-sized column without altering virtual row height', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer/styles.css'), 'utf8');
  assert.match(css, /\.asset-file-row\.has-required-dependency\s*\{\s*grid-template-columns: 36px minmax\(0, 1fr\) auto auto;/);
  assert.match(css, /\.required-dependency-action\s*\{\s*grid-column: 4;\s*grid-row: 1;\s*white-space: nowrap;/);
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
  f.renderer.renderFiles = async options => { assert.equal(options.isCurrent(), true); order.push('workspace'); };
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
  f.renderer.renderFiles = async options => { assert.equal(options.isCurrent(), true); order.push('workspace'); };
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
  f.renderer.renderFiles = async options => { assert.equal(options.isCurrent(), true); order.push('workspace'); };
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
  f.renderer.renderFiles = async options => { assert.equal(options.isCurrent(), true); order.push('workspace'); };
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
});

test('unavailable workspace never claims working-file readiness or package inclusion in either summary', async () => {
  const f = setup(); f.crate.getAssetWorkspace = async () => { throw new Error('unavailable'); };
  await f.renderer.renderFiles();
  for (const id of ['asset-review-summary', 'asset-review-footer-summary']) {
    assert.match(f.elements[id].textContent, /selection and verification unavailable/);
    assert.doesNotMatch(f.elements[id].textContent, /ready|included|selected/i);
  }
  assert.match(getElementTreeText(f.elements['working-assets-list']), /Unavailable/);
});

test('tracked Figma working source remains counted independently of physical selection counts', () => {
  const f = setup(); f.project.files = []; f.workspace.files = [];
  Object.assign(f.workspace.semanticCounts, { selectedWorkingSources: 0 });
  f.renderer.renderAssetWorkspace(f.project, { trackedFigmaFiles: [{ displayName: 'Synthetic Figma', figmaSourceIdentity: 'opaque-figma' }] }, []);
  assert.equal(f.elements['working-assets-count'].textContent, '1');
  assert.equal(f.elements['project-file-count'].textContent, '1');
  assert.match(f.elements['working-source-summary'].textContent, /1 tracked Figma working file/);
  assert.match(f.elements['asset-review-summary'].textContent, /1 Figma Working File tracked/);
  assert.match(getElementTreeText(f.elements['working-assets-list']), /Synthetic Figma/);
  assert.equal(buttonFor(f.elements['working-assets-list'], 'Exclude'), undefined);
});
