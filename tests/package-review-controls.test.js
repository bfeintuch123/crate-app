'use strict';
const test = require('node:test');
const assert = require('./bounded-assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Reuse the established DOM/renderer fixture declarations without executing its
// tests or editing the shared suite. Keep this lane's behavior cases independent.
const sharedPath = path.join(__dirname, 'renderer-figma-scope.test.js');
const shared = fs.readFileSync(sharedPath, 'utf8');
const fixtureEnd = shared.indexOf('\ntest(');
assert.ok(fixtureEnd > 0, 'shared fixture declarations must precede tests');
const fixtureScope = { require: createRequire(sharedPath), __dirname, console, setTimeout, clearTimeout };
vm.createContext(fixtureScope);
vm.runInContext(shared.slice(0, fixtureEnd), fixtureScope);
const { createInteractiveRendererDom, loadRendererHelpers, getElementTreeText } = fixtureScope;

function setup(count = 13) {
  const { document, elements } = createInteractiveRendererDom();
  const families = ['illustrator', 'photoshop', 'indesign', 'figma', 'powerpoint', 'keynote', 'sketch', 'affinity', 'adobe-xd'];
  const files = Array.from({ length: count }, (_, index) => ({
    name: index === 1 ? 'Working.ai' : index === 0 ? 'Working.ai' : `Long synthetic document ${index + 1} with complete inspectable name.png`,
    ext: index < 2 ? '.ai' : '.png', appFamily: families[index % families.length],
    visualIdentity: `opaque-${index}`, visualRevision: `rev-${index}`,
    projectRole: index < 2 ? 'source' : 'asset', packageFolder: index < 2 ? 'AI' : 'PNG',
  }));
  const project = { id: 'controls-project', name: 'Synthetic mixed project', files, excludedAssetKeys: ['excluded-id'] };
  const review = { projectId: project.id, files, token: 'review-token', materializable: true };
  const visualRequests = [];
  const renderer = loadRendererHelpers(document, { crate: {
    getFileVisual: async (_project, identity) => { visualRequests.push(identity); return null; },
    getProjects: async () => [project], preScanSession: async () => null,
    preparePackageReview: async () => review,
  } });
  renderer.fixtureProject = project;
  renderer.fixtureReview = review;
  vm.runInContext(`state.projects = [fixtureProject]; state.selectedProjectId = fixtureProject.id;
    state.settings = { namingTemplate: '{Project}', packageOutputLayoutMode: 'by-extension-v1' };
    state.packageOutputPath = '/synthetic/output';`, renderer);
  renderer.setupEventListeners();
  renderer.renderPackageReview(project, review);
  return { renderer, document, elements, project, review, visualRequests };
}

for (const count of [0, 1, 8, 9, 13, 200]) test(`contents exposes exactly ${count} mixed files without per-file tab stops`, async () => {
  const { renderer, elements, review, visualRequests, document } = setup(count);
  assert.equal(elements['modal-file-list'].children.length, Math.min(8, count));
  const toggle = elements['btn-toggle-package-contents'];
  assert.equal(toggle.classList.contains('hidden'), count <= 8);
  if (count > 8) {
    assert.match(toggle.textContent, new RegExp(`\\+${count - 8} more`));
    toggle.click();
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(document.activeElement, elements['package-review-contents']);
    assert.equal(elements['modal-file-list'].children.length, count);
    assert.equal(vm.runInContext('state.packageReviewToken', renderer), review.token);
    for (const row of elements['modal-file-list'].children) {
      assert.equal(row.getAttribute('role'), 'listitem');
      assert.equal(row.getAttribute('tabindex'), undefined);
      assert.equal(row.children[1].title, row.children[1].textContent);
    }
    assert.equal(getElementTreeText(elements['modal-file-list']).includes('/synthetic/'), false);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(visualRequests.every(id => Number(id.slice(7)) < 8), 'extra files never request thumbnails');
    toggle.click();
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(elements['modal-file-list'].children.length, 8);
    assert.equal(document.activeElement, toggle);
  }
});

test('return controls preserve project selections, destination and organization and focus selection heading', () => {
  for (const id of ['btn-back-package', 'btn-cancel-package']) {
    const { renderer, elements, document, project } = setup();
    const snapshot = JSON.stringify(project);
    elements['btn-toggle-package-contents'].click();
    elements[id].click();
    assert.equal(elements['modal-package'].classList.contains('hidden'), true);
    assert.equal(document.activeElement, elements['asset-review-heading']);
    assert.equal(JSON.stringify(project), snapshot);
    assert.equal(vm.runInContext('state.packageOutputPath', renderer), '/synthetic/output');
    assert.equal(vm.runInContext('state.settings.packageOutputLayoutMode', renderer), 'by-extension-v1');
    assert.equal(vm.runInContext('state.packageReviewToken', renderer), null);
    assert.equal(vm.runInContext('packageReviewContents', renderer), null);
  }
});

test('return rejects mismatched project and in-flight confirmation; controls visibly disable', () => {
  const { renderer, elements } = setup();
  vm.runInContext('packageReviewConfirmationInFlight = true; syncPackageReviewReturnControls();', renderer);
  assert.equal(elements['btn-back-package'].disabled, true);
  assert.equal(elements['btn-cancel-package'].disabled, true);
  renderer.changePackageReviewSelection();
  renderer.togglePackageReviewContents();
  assert.equal(elements['modal-package'].classList.contains('hidden'), false);
  assert.equal(elements['modal-file-list'].children.length, 8);
  vm.runInContext("packageReviewConfirmationInFlight = false; syncPackageReviewReturnControls(); state.selectedProjectId = 'other-project';", renderer);
  assert.equal(elements['btn-back-package'].disabled, false);
  renderer.changePackageReviewSelection();
  renderer.togglePackageReviewContents();
  assert.equal(elements['modal-package'].classList.contains('hidden'), false);
  assert.equal(elements['modal-file-list'].children.length, 8);
});

test('refreshed, hidden and switched reviews reset expansion and fence stale controls', () => {
  const { renderer, elements, project, review } = setup();
  elements['btn-toggle-package-contents'].click();
  renderer.renderPackageReview(project, { ...review, files: review.files.slice(0, 9) }, '', renderer.claimModalLease('modal-package', { replaceVisible: true }));
  assert.equal(elements['modal-file-list'].children.length, 8);
  assert.equal(elements['btn-toggle-package-contents'].getAttribute('aria-expanded'), 'false');
  elements['btn-toggle-package-contents'].click();
  renderer.hidePackageReviewDialog();
  elements['btn-toggle-package-contents'].click();
  assert.equal(elements['modal-file-list'].children.length, 8);
  renderer.renderPackageReview(project, review);
  elements['btn-toggle-package-contents'].click();
  renderer.setSelectedProject('other-project');
  assert.equal(vm.runInContext('packageReviewContents', renderer), null);
  assert.equal(elements['modal-package'].classList.contains('hidden'), true);
});

test('blocked review can expand and return without becoming packageable; Escape restores opener', () => {
  const { renderer, elements, project, review, document } = setup();
  renderer.renderPackageReview(project, { ...review, materializable: false, token: null }, 'Save before packaging', renderer.claimModalLease('modal-package', { replaceVisible: true }));
  elements['btn-toggle-package-contents'].click();
  assert.equal(elements['btn-confirm-package'].disabled, true);
  assert.equal(vm.runInContext('state.packageReviewToken', renderer), null);
  renderer.fixtureOpener = elements['btn-package'];
  vm.runInContext('packageReviewOpener = fixtureOpener;', renderer);
  renderer.handlePackageReviewKeydown({ key: 'Escape', preventDefault() {} });
  assert.equal(document.activeElement, elements['btn-package']);
  assert.equal(elements['modal-package'].classList.contains('hidden'), true);
});

test('cancelled output picker reopens a collapsed interactive review', async () => {
  const { renderer, elements } = setup();
  renderer.window.crate.selectOutputFolder = async () => {
    assert.equal(elements['btn-back-package'].disabled, true);
    return null;
  };
  vm.runInContext('state.packageOutputPath = null;', renderer);
  elements['btn-toggle-package-contents'].click();
  await renderer.confirmPackage();
  assert.equal(elements['modal-package'].classList.contains('hidden'), false);
  assert.equal(elements['btn-back-package'].disabled, false);
  assert.equal(elements['modal-file-list'].children.length, 8);
  elements['btn-toggle-package-contents'].click();
  assert.equal(elements['modal-file-list'].children.length, 13);
});

for (const boundary of ['project-switch', 'project-round-trip', 'same-project-reset', 'reopened-review']) {
  for (const outcome of ['selected', 'cancelled']) test(`confirmation picker ${outcome} after ${boundary} preserves the current destination and review`, async () => {
    const { renderer, elements, project, review } = setup();
    const picker = deferred();
    let pickerCalls = 0;
    let scanCalls = 0;
    let packageCalls = 0;
    renderer.window.crate.selectOutputFolder = () => { pickerCalls++; return picker.promise; };
    renderer.window.crate.preScanSession = async () => { scanCalls++; return null; };
    renderer.window.crate.packageProject = async () => { packageCalls++; };
    vm.runInContext('state.packageOutputPath = null;', renderer);
    const pending = renderer.confirmPackage();
    assert.equal(pickerCalls, 1, 'exercise the confirmation fallback picker');
    if (boundary === 'project-switch' || boundary === 'project-round-trip') renderer.setSelectedProject('other-project');
    if (boundary === 'project-round-trip') renderer.setSelectedProject(project.id);
    if (boundary === 'same-project-reset') renderer.setSelectedProject(project.id, { invalidate: true });
    if (boundary === 'reopened-review') {
      renderer.hidePackageReviewDialog();
      assert.equal(await renderer.showPackageModal({ runPreScan: false, review: { ...review, token: 'replacement-token' } }), true);
    }
    vm.runInContext("state.packageOutputPath = '/synthetic/current-output';", renderer);
    const currentToken = vm.runInContext('state.packageReviewToken', renderer);
    const currentSession = vm.runInContext('packageReviewModalSessionId', renderer);
    const reviewHidden = elements['modal-package'].classList.contains('hidden');
    picker.resolve(outcome === 'selected' ? '/synthetic/stale-output' : null);
    await pending;
    assert.equal(vm.runInContext('state.packageOutputPath', renderer), '/synthetic/current-output');
    assert.equal(vm.runInContext('state.packageReviewToken', renderer), currentToken);
    assert.equal(vm.runInContext('packageReviewModalSessionId', renderer), currentSession);
    assert.equal(elements['modal-package'].classList.contains('hidden'), reviewHidden);
    assert.equal(elements['modal-progress'].classList.contains('hidden'), true);
    assert.equal(scanCalls, 0);
    assert.equal(packageCalls, 0, 'the existing guard must still block stale packaging');
  });
}

test('confirmation picker cancellation permits a fresh selection and packages with that destination', async () => {
  const { renderer, elements, project, review } = setup();
  const picker = deferred();
  const packageCalls = [];
  renderer.window.crate.selectOutputFolder = async () => null;
  vm.runInContext('state.packageOutputPath = null;', renderer);
  await renderer.confirmPackage();
  assert.equal(elements['modal-package'].classList.contains('hidden'), false);
  assert.equal(vm.runInContext('state.packageOutputPath', renderer), null);
  renderer.window.crate.selectOutputFolder = () => picker.promise;
  renderer.window.crate.packageProject = async (...args) => {
    packageCalls.push(args);
    return { error: 'package_review_changed', review };
  };
  const pending = renderer.confirmPackage();
  picker.resolve('/synthetic/selected-output');
  await pending;
  assert.equal(vm.runInContext('state.packageOutputPath', renderer), '/synthetic/selected-output');
  assert.deepEqual(packageCalls, [[project.id, '/synthetic/selected-output', review.token]]);
});

test('markup supplies one keyboard scroll region, a semantic list, native buttons and retained return ID', () => {
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  assert.match(html, /id="package-review-contents"[^>]*role="region"[^>]*tabindex="0"/);
  assert.match(html, /id="modal-file-list"[^>]*role="list"/);
  assert.match(html, /<button[^>]*id="btn-back-package"/);
  assert.match(html, /<button[^>]*id="btn-toggle-package-contents"[^>]*aria-controls="modal-file-list"/);
  assert.match(html, /id="btn-cancel-package">Back to selection<\/button>/);
});

for (const exit of ['header', 'footer', 'escape', 'project-switch']) {
  for (const outcome of ['saved', 'failed']) test(`delayed organization ${outcome} cannot reopen review after ${exit}`, async () => {
    const { renderer, elements, document } = setup();
    let resolveSetting;
    let rejectSetting;
    let reviewCalls = 0;
    renderer.window.crate.updateSetting = () => new Promise((resolve, reject) => {
      resolveSetting = resolve;
      rejectSetting = reject;
    });
    renderer.window.crate.preparePackageReview = async () => { reviewCalls += 1; };
    const pending = renderer.updatePackageOutputLayoutMode(false, { refreshReview: true });
    if (exit === 'header') elements['btn-back-package'].click();
    if (exit === 'footer') elements['btn-cancel-package'].click();
    if (exit === 'escape') renderer.handlePackageReviewKeydown({ key: 'Escape', preventDefault() {} });
    if (exit === 'project-switch') renderer.setSelectedProject('other-project');
    const focusAfterExit = document.activeElement;
    if (outcome === 'saved') resolveSetting({ packageOutputLayoutMode: 'flat' });
    else rejectSetting(new Error('Synthetic setting failure'));
    await pending;
    assert.equal(reviewCalls, 0, 'an exited review must not be re-prepared');
    assert.equal(elements['modal-package'].classList.contains('hidden'), true);
    assert.equal(document.activeElement, focusAfterExit);
    assert.equal(vm.runInContext('state.packageReviewToken', renderer), null);
    assert.equal(elements['toggle-package-review-folders'].disabled, false);
  });
}


test('package action preserves its explicit opener across busy disabling and organization refresh', async () => {
  const { renderer, elements, document } = setup();
  renderer.hidePackageReviewDialog();
  document.activeElement = document.body;
  renderer.window.crate.updateSetting = async (_key, value) => ({ packageOutputLayoutMode: value });
  elements['btn-package'].click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements['modal-package'].classList.contains('hidden'), false);
  renderer.fixtureOpener = elements['btn-package'];
  assert.equal(vm.runInContext('packageReviewOpener === fixtureOpener', renderer), true);
  await renderer.updatePackageOutputLayoutMode(false, { refreshReview: true });
  renderer.handlePackageReviewKeydown({ key: 'Escape', preventDefault() {} });
  assert.equal(document.activeElement, elements['btn-package']);
  assert.equal(elements['modal-package'].classList.contains('hidden'), true);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function exitReview(renderer, elements, exit) {
  if (exit === 'escape') renderer.handlePackageReviewKeydown({ key: 'Escape', preventDefault() {} });
  else elements[exit === 'header' ? 'btn-back-package' : 'btn-cancel-package'].click();
}

for (const phase of ['prepare', 'project-read']) {
  for (const exit of ['escape', 'header', 'footer']) {
    for (const outcome of ['success', 'error', 'reject']) test(`refresh ${phase} ${outcome} after ${exit} releases authority and permits a fresh review`, async () => {
      const { renderer, elements, document, project, review } = setup();
      const gate = deferred();
      let entered = false;
      renderer.fixtureOpener = elements['btn-package'];
      vm.runInContext('packageReviewOpener = fixtureOpener;', renderer);
      renderer.window.crate.updateSetting = async () => ({ packageOutputLayoutMode: 'flat' });
      renderer.window.crate.preparePackageReview = async () => {
        if (phase === 'prepare') { entered = true; return gate.promise; }
        return { ...review, token: 'late-token' };
      };
      renderer.window.crate.getProjects = async () => {
        if (phase === 'project-read') { entered = true; return gate.promise; }
        return [project];
      };
      const originalProject = JSON.stringify(project);
      elements['btn-toggle-package-contents'].click();
      const pending = renderer.updatePackageOutputLayoutMode(false, { refreshReview: true });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(entered, true, 'exercise the await after the setting has saved');
      exitReview(renderer, elements, exit);
      const exitFocus = document.activeElement;
      const leaseAfterExit = vm.runInContext('activeModalLease', renderer);
      if (outcome === 'reject') gate.reject(new Error('Synthetic delayed failure'));
      else if (phase === 'project-read') gate.resolve(outcome === 'success' ? [project] : []);
      else gate.resolve(outcome === 'success' ? { ...review, token: 'late-token' } : { error: 'package_review_unavailable' });
      await pending;
      assert.equal(leaseAfterExit, null, 'exit must release the pending refresh lease immediately');
      assert.equal(vm.runInContext('activeModalLease', renderer), null);
      assert.equal(elements['modal-package'].classList.contains('hidden'), true);
      assert.equal(document.activeElement, exitFocus);
      assert.equal(vm.runInContext('state.packageReviewToken', renderer), null);
      assert.equal(elements['toggle-package-review-folders'].disabled, false);
      assert.equal(elements['toggle-package-folders'].disabled, false);
      assert.equal(JSON.stringify(project), originalProject);
      assert.equal(vm.runInContext('state.packageOutputPath', renderer), '/synthetic/output');
      assert.equal(vm.runInContext('state.settings.packageOutputLayoutMode', renderer), 'flat');
      renderer.window.crate.getProjects = async () => [project];
      renderer.window.crate.preparePackageReview = async () => ({ ...review, token: 'fresh-token' });
      elements['btn-package'].click();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(elements['modal-package'].classList.contains('hidden'), false);
      assert.equal(vm.runInContext('state.packageReviewToken', renderer), 'fresh-token');
      assert.equal(elements['modal-file-list'].children.length, 8);
      assert.equal(document.activeElement, elements['btn-back-package']);
      renderer.handlePackageReviewKeydown({ key: 'Escape', preventDefault() {} });
      assert.equal(document.activeElement, elements['btn-package']);
    });
  }
}

for (const outcome of ['success', 'error', 'reject']) test(`old prepare ${outcome} cannot replace a newer review or its authority`, async () => {
  const { renderer, elements, document, review } = setup();
  const gate = deferred();
  renderer.window.crate.updateSetting = async () => ({ packageOutputLayoutMode: 'flat' });
  renderer.window.crate.preparePackageReview = () => gate.promise;
  const old = renderer.updatePackageOutputLayoutMode(false, { refreshReview: true });
  await new Promise(resolve => setImmediate(resolve));
  await renderer.showPackageModal({ runPreScan: false, review: { ...review, token: 'replacement-token' } });
  elements['btn-toggle-package-contents'].click();
  const replacementFocus = document.activeElement;
  const replacementLease = vm.runInContext('activeModalLease.sessionId', renderer);
  if (outcome === 'reject') gate.reject(new Error('Synthetic obsolete preparation'));
  else gate.resolve(outcome === 'success' ? { ...review, token: 'obsolete-token' } : { error: 'package_review_unavailable' });
  await old;
  assert.equal(vm.runInContext('activeModalLease.sessionId', renderer), replacementLease);
  assert.equal(vm.runInContext('state.packageReviewToken', renderer), 'replacement-token');
  assert.equal(elements['modal-file-list'].children.length, 13);
  assert.equal(document.activeElement, replacementFocus);
});

test('exit guards preserve confirmation and a later different modal owns its lease after stale completion', async () => {
  const { renderer, elements, review } = setup();
  const initialLease = vm.runInContext('activeModalLease.sessionId', renderer);
  vm.runInContext('packageReviewConfirmationInFlight = true;', renderer);
  for (const exit of ['escape', 'header', 'footer']) exitReview(renderer, elements, exit);
  assert.equal(vm.runInContext('activeModalLease.sessionId', renderer), initialLease);
  assert.equal(elements['modal-package'].classList.contains('hidden'), false);
  vm.runInContext('packageReviewConfirmationInFlight = false;', renderer);
  const gate = deferred();
  renderer.window.crate.updateSetting = async () => ({ packageOutputLayoutMode: 'flat' });
  renderer.window.crate.preparePackageReview = () => gate.promise;
  const old = renderer.updatePackageOutputLayoutMode(false, { refreshReview: true });
  await new Promise(resolve => setImmediate(resolve));
  exitReview(renderer, elements, 'escape');
  const otherLease = renderer.claimModalLease('modal-upgrade');
  assert.ok(otherLease);
  elements['modal-upgrade'].classList.remove('hidden');
  gate.resolve({ ...review, token: 'obsolete-token' });
  await old;
  assert.equal(vm.runInContext('activeModalLease.id', renderer), 'modal-upgrade');
  assert.equal(vm.runInContext('activeModalLease.sessionId', renderer), otherLease.sessionId);
  assert.equal(elements['modal-package'].classList.contains('hidden'), true);
});

for (const outcome of ['saved', 'failed']) test(`late setting ${outcome} preserves a reentered review's authoritative destinations and controls`, async () => {
  const { renderer, elements, review } = setup();
  const gate = deferred();
  renderer.window.crate.updateSetting = () => gate.promise;
  const pending = renderer.updatePackageOutputLayoutMode(false, { refreshReview: true });
  exitReview(renderer, elements, 'escape');
  const replacementMode = outcome === 'saved' ? 'by-extension-v1' : 'flat';
  const replacement = { ...review, token: 'replacement-token', planSummary: { outputLayoutMode: replacementMode },
    files: review.files.map(file => ({ ...file, packageFolder: replacementMode === 'flat' ? '' : file.packageFolder })) };
  await renderer.showPackageModal({ runPreScan: false, review: replacement });
  const before = getElementTreeText(elements['modal-file-list']);
  if (outcome === 'saved') gate.resolve({ packageOutputLayoutMode: 'flat' });
  else gate.reject(new Error('Synthetic old setting failure'));
  await pending;
  assert.equal(elements['toggle-package-review-folders'].checked, replacementMode === 'by-extension-v1');
  assert.equal(getElementTreeText(elements['modal-file-list']), before);
  assert.equal(vm.runInContext('state.packageReviewToken', renderer), 'replacement-token');
});

// Model Chromium's native disabled-control blur locally, and route keys from
// the active element through its ancestors rather than calling the handler.
function installDisabledFocusRouting(document, elements) {
  const modal = elements['modal-package'];
  for (const id of ['toggle-package-review-folders', 'btn-confirm-package', 'btn-back-package']) {
    const control = elements[id];
    modal.appendChild(control);
    let disabled = control.disabled;
    Object.defineProperty(control, 'disabled', {
      get: () => disabled,
      set: value => {
        disabled = value;
        if (value && document.activeElement === control) document.activeElement = document.body;
      },
    });
  }
  return key => {
    const event = { type: 'keydown', key, preventDefault() {} };
    for (let target = document.activeElement; target; target = target.parentElement) target.dispatchEvent?.(event);
  };
}

for (const outcome of ['success', 'error', 'reject']) test(`native disabled-focus routing keeps immediate Escape reachable before late ${outcome}`, async () => {
  const { renderer, elements, document, review } = setup();
  const dispatchKey = installDisabledFocusRouting(document, elements);
  const gate = deferred();
  renderer.window.crate.updateSetting = async () => ({ packageOutputLayoutMode: 'flat' });
  renderer.window.crate.preparePackageReview = () => gate.promise;
  renderer.hidePackageReviewDialog();
  elements['btn-package'].focus();
  await renderer.showPackageModal({ runPreScan: false, review });
  const toggle = elements['toggle-package-review-folders'];
  toggle.focus();
  toggle.checked = false;
  toggle.dispatchEvent({ type: 'change', target: toggle });
  assert.equal(document.activeElement, elements['btn-back-package'], 'move focus before Chromium disables the checkbox');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(toggle.disabled, true);
  dispatchKey('Escape');
  assert.equal(elements['modal-package'].classList.contains('hidden'), true);
  assert.equal(vm.runInContext('activeModalLease', renderer), null);
  assert.equal(vm.runInContext('state.packageReviewToken', renderer), null);
  assert.equal(document.activeElement, elements['btn-package']);
  if (outcome === 'reject') gate.reject(new Error('Synthetic delayed rejection'));
  else gate.resolve(outcome === 'error' ? { error: 'synthetic' } : { ...review, token: 'late-token' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements['modal-package'].classList.contains('hidden'), true);
  assert.equal(vm.runInContext('activeModalLease', renderer), null);
  assert.equal(vm.runInContext('state.packageReviewToken', renderer), null);
  assert.equal(toggle.disabled, false);
  assert.equal(document.activeElement, elements['btn-package']);
});

for (const guard of ['settings', 'hidden', 'other-modal', 'confirmation']) test(`refresh focus transfer preserves ${guard} ownership`, async () => {
  const { renderer, elements, document } = setup();
  installDisabledFocusRouting(document, elements);
  const gate = deferred();
  renderer.window.crate.updateSetting = () => gate.promise;
  if (guard === 'settings') elements['toggle-package-folders'].focus();
  else elements['toggle-package-review-folders'].focus();
  if (guard === 'hidden') elements['modal-package'].classList.add('hidden');
  if (guard === 'other-modal') {
    renderer.hidePackageReviewDialog();
    assert.ok(renderer.claimModalLease('modal-upgrade'));
    elements['modal-upgrade'].classList.remove('hidden');
    elements['modal-upgrade'].focus();
  }
  if (guard === 'confirmation') vm.runInContext('packageReviewConfirmationInFlight = true;', renderer);
  const pending = renderer.updatePackageOutputLayoutMode(false, { refreshReview: guard !== 'settings' });
  assert.notEqual(document.activeElement, elements['btn-back-package'], 'do not redirect another flow into the review');
  // Fence completion; this test isolates synchronous focus ownership.
  vm.runInContext('projectSelectionEpoch += 1;', renderer);
  gate.resolve({ packageOutputLayoutMode: 'flat' });
  await pending;
});


for (const outcome of ['selected', 'cancelled', 'error']) test(`destination picker ${outcome} preserves ownership, privacy and keyboard focus`, async () => {
  const { renderer, elements, document, project, review } = setup();
  vm.runInContext("accountStatus = { canUseWorkspace: true }; state.packageOutputPath = null;", renderer);
  renderer.renderPackageReview(project, review, '', renderer.claimModalLease('modal-package', { replaceVisible: true }));
  assert.equal(elements['btn-change-dest'].textContent, 'Choose Folder');
  assert.equal(elements['modal-dest-path'].textContent, 'Choose a folder before packaging');
  let settle;
  let reject;
  let calls = 0;
  renderer.window.crate.selectOutputFolder = () => { calls++; return new Promise((resolve, fail) => { settle = resolve; reject = fail; }); };
  const button = elements['btn-change-dest'];
  button.focus();
  const operation = renderer.choosePackageDestination();
  assert.equal(document.activeElement, elements['btn-back-package'], 'move focus before disabling picker action');
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(elements['btn-confirm-package'].disabled, true);
  await renderer.choosePackageDestination();
  await renderer.confirmPackage();
  assert.equal(calls, 1, 'one owned picker, including confirmation path');
  if (outcome === 'error') reject(new Error('/private/path must not be exposed'));
  else settle(outcome === 'selected' ? '/private/synthetic/output' : null);
  await operation;
  assert.equal(vm.runInContext('state.packageOutputPath', renderer), outcome === 'selected' ? '/private/synthetic/output' : null);
  assert.equal(elements['modal-dest-path'].textContent, outcome === 'selected' ? 'Selected output folder' : 'Choose a folder before packaging');
  assert.equal(button.textContent, outcome === 'selected' ? 'Change Folder' : 'Choose Folder');
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('aria-busy'), 'false');
  assert.equal(elements['btn-confirm-package'].disabled, false);
  assert.equal(document.activeElement, button);
  assert.equal(elements['modal-dest-path'].textContent.includes('/private/'), false);
  assert.equal(vm.runInContext('state.packageReviewToken', renderer), 'review-token', 'backend destination confirmation still owns plan acceptance');
});

for (const boundary of ['close', 'project', 'same-project-reset', 'account', 'request', 'replacement-dialog']) {
  test(`destination picker ignores completion after ${boundary} without stealing focus`, async () => {
    const { renderer, elements, document, project, review } = setup();
    vm.runInContext('accountStatus = { canUseWorkspace: true };', renderer);
    let settle;
    renderer.window.crate.selectOutputFolder = () => new Promise(resolve => { settle = resolve; });
    elements['btn-change-dest'].focus();
    const operation = renderer.choosePackageDestination();
    if (boundary === 'close') renderer.hidePackageReviewDialog();
    if (boundary === 'project') renderer.setSelectedProject('new-project');
    if (boundary === 'same-project-reset') renderer.setSelectedProject(project.id, { invalidate: true });
    if (boundary === 'account') vm.runInContext('accountWorkspaceEpoch++; accountStatus.canUseWorkspace = false;', renderer);
    if (boundary === 'request') vm.runInContext('packageReviewRequestId++;', renderer);
    if (boundary === 'replacement-dialog') {
      renderer.hidePackageReviewDialog();
      renderer.renderPackageReview(project, review);
      assert.equal(elements['btn-change-dest'].disabled, true, 'native picker is still outstanding');
    }
    elements['btn-package'].focus();
    const currentLabel = elements['modal-dest-path'].textContent;
    settle('/private/stale/choice');
    await operation;
    assert.equal(vm.runInContext('state.packageOutputPath', renderer), '/synthetic/output');
    assert.equal(elements['modal-dest-path'].textContent, currentLabel);
    assert.equal(document.activeElement, elements['btn-package']);
    assert.equal(vm.runInContext('packageDestinationPicker', renderer), null);
  });
}

test('destination picker does not steal focus after another owned control receives it', async () => {
  const { renderer, elements, document } = setup();
  vm.runInContext('accountStatus = { canUseWorkspace: true };', renderer);
  let settle;
  renderer.window.crate.selectOutputFolder = () => new Promise(resolve => { settle = resolve; });
  elements['btn-change-dest'].focus();
  const operation = renderer.choosePackageDestination();
  elements['toggle-package-review-folders'].focus();
  settle(null);
  await operation;
  assert.equal(document.activeElement, elements['toggle-package-review-folders']);
  assert.equal(vm.runInContext('state.packageOutputPath', renderer), '/synthetic/output', 'cancel preserves existing choice');
});

test('destination is a single labeled button at the top of Package Summary', () => {
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  const summary = html.slice(html.indexOf('<aside class="package-review-summary"'), html.indexOf('</aside>', html.indexOf('<aside class="package-review-summary"')));
  assert.equal((html.match(/id="btn-change-dest"/g) || []).length, 1);
  assert.ok(summary.indexOf('id="btn-change-dest"') < summary.indexOf('id="package-review-summary-list"'));
  assert.match(summary, /id="package-destination-label">Save package to/);
  assert.match(summary, /<button[^>]*id="btn-change-dest"[^>]*aria-describedby="package-destination-label modal-dest-path"/);
  assert.match(summary, /id="modal-dest-path"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.doesNotMatch(summary, /~\/Desktop\//);
});

// Characterization of the unchanged renderer, not a recovery implementation.
// A deferred bridge models an outstanding request, not why a native picker
// stalled. One real, unchanged PNG avoids conflating that wait with asset load.
function setupStablePngPicker(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-picker-characterization-'));
  const source = path.join(root, 'Stable.png');
  // A 1x1 opaque black RGBA pixel with verified PNG chunk CRCs and zlib data.
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(source, bytes, { flag: 'wx' });
  const digest = () => crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const originalDigest = digest();
  const file = {
    path: source, name: 'Stable.png', ext: '.png', projectRole: 'asset', assetOrigin: 'existing',
    visualIdentity: 'stable-png', visualRevision: 'stable-png-v1', status: 'ready', packageFolder: 'PNG',
  };
  const projects = ['picker-a', 'picker-b'].map(id => ({ id, name: id, files: [{ ...file }], pendingFiles: [] }));
  const reviewFor = (project, token = `review-${project.id}`) => ({
    projectId: project.id, files: project.files.map(row => ({ ...row })), token, materializable: true,
  });
  const snapshots = projects.map(project => JSON.stringify(project));
  const requests = [], operations = [], toasts = [];
  const calls = { pickers: 0, active: 0, peak: 0, packages: 0, scans: 0, projectReads: 0 };
  const { document, elements } = createInteractiveRendererDom();
  const renderer = loadRendererHelpers(document, { crate: {
    getFileVisual: async () => null,
    getProjects: async () => { calls.projectReads++; return projects; },
    preparePackageReview: async id => reviewFor(projects.find(project => project.id === id)),
    preScanSession: async () => { calls.scans++; return null; },
    packageProject: async () => { calls.packages++; throw new Error('Unexpected package execution in picker characterization'); },
    selectOutputFolder: () => {
      const gate = deferred(), request = { gate, pending: true };
      requests.push(request);
      calls.pickers++; calls.active++; calls.peak = Math.max(calls.peak, calls.active);
      return gate.promise.finally(() => { request.pending = false; calls.active--; });
    },
  } });
  renderer.pickerProjects = projects;
  vm.runInContext(`state.projects = pickerProjects; state.selectedProjectId = pickerProjects[0].id;
    state.settings = { namingTemplate: '{Project}', packageOutputLayoutMode: 'by-extension-v1' };
    state.packageOutputPath = null; accountStatus = { canUseWorkspace: true };`, renderer);
  renderer.showToast = message => toasts.push(message);
  renderer.setupEventListeners();
  renderer.renderPackageReview(projects[0], reviewFor(projects[0]));
  const read = expression => vm.runInContext(expression, renderer);
  const start = (confirmation = false) => {
    const operation = confirmation ? renderer.confirmPackage() : renderer.choosePackageDestination();
    operations.push(operation);
    return operation;
  };
  const assertStable = ({ scans = 0, packages = 0 } = {}) => {
    assert.equal(digest(), originalDigest);
    assert.deepEqual(projects.map(project => JSON.stringify(project)), snapshots);
    assert.equal(read('state.projects.find(project => project.id === state.selectedProjectId).files.length'), 1);
    assert.equal(calls.scans, scans, 'only explicitly expected synthetic scans are permitted');
    assert.equal(calls.packages, packages);
  };
  const settle = (index, outcome) => {
    if (outcome === 'rejected') requests[index].gate.reject(new Error('/private/stale-picker-error'));
    else requests[index].gate.resolve(outcome === 'selected' ? path.join(root, `destination-${index}`) : null);
  };
  t.after(async () => {
    // Resolve owned doubles only after observations; never strand a test promise.
    for (const request of requests) if (request.pending) request.gate.resolve(null);
    await Promise.allSettled(operations);
    assert.equal(calls.active, 0);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { renderer, document, elements, projects, reviewFor, requests, calls, toasts, read, start, settle, assertStable, root };
}

test('destination characterization: an unanswered bridge blocks a stable single-PNG review', async t => {
  const f = setupStablePngPicker(t);
  let finished = false;
  f.start().then(() => { finished = true; });
  const owner = f.read('packageDestinationPicker');
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false, 'controlled request has no response, not a measured native timeout');
  assert.equal(f.read('packageDestinationPicker'), owner);
  assert.equal(f.elements['package-review-ready'].textContent, 'Ready to package');
  assert.equal(f.elements['btn-change-dest'].textContent, 'Choosing…');
  assert.equal(f.elements['btn-change-dest'].getAttribute('aria-busy'), 'true');
  assert.equal(f.elements['btn-change-dest'].disabled, true);
  assert.equal(f.elements['btn-confirm-package'].disabled, true);
  await f.renderer.choosePackageDestination();
  await f.renderer.confirmPackage();
  assert.equal(f.calls.pickers, 1);
  assert.equal(f.calls.active, 1);
  assert.equal(f.calls.peak, 1);
  f.assertStable();
});

for (const outcome of ['selected', 'cancelled', 'rejected']) {
  test(`destination characterization: current ${outcome} reply clears waiting and permits one fresh picker`, async t => {
    const f = setupStablePngPicker(t);
    const pending = f.start();
    f.settle(0, outcome);
    await pending;
    assert.equal(f.read('packageDestinationPicker'), null);
    assert.equal(f.read('state.packageOutputPath'), outcome === 'selected' ? path.join(f.root, 'destination-0') : null);
    assert.equal(f.read('state.packageReviewToken'), 'review-picker-a');
    assert.equal(f.elements['btn-change-dest'].disabled, false);
    assert.equal(f.elements['btn-change-dest'].getAttribute('aria-busy'), 'false');
    assert.equal(f.elements['btn-confirm-package'].disabled, false);
    assert.deepEqual(f.toasts, outcome === 'rejected' ? ['The folder picker could not open. Try again.'] : []);
    const next = f.start();
    await f.renderer.choosePackageDestination();
    await f.renderer.confirmPackage();
    assert.equal(f.calls.pickers, 2);
    assert.equal(f.calls.active, 1);
    assert.equal(f.calls.peak, 1);
    f.settle(1, 'cancelled');
    await next;
    f.assertStable();
  });
}

for (const navigation of ['back-reopen', 'project-navigation', 'same-project-reset']) {
  for (const outcome of ['selected', 'cancelled', 'rejected']) {
    test(`destination characterization: ${navigation} retains waiting then fences late ${outcome}`, async t => {
      const f = setupStablePngPicker(t);
      const pending = f.start();
      const oldOwner = f.read('packageDestinationPicker');
      let project = f.projects[0];
      if (navigation === 'back-reopen') f.elements['btn-back-package'].click();
      else {
        if (navigation === 'project-navigation') project = f.projects[1];
        f.renderer.setSelectedProject(project.id, { invalidate: navigation === 'same-project-reset' });
      }
      assert.equal(f.elements['modal-package'].classList.contains('hidden'), true);
      const review = f.reviewFor(project, `fresh-${project.id}`);
      assert.equal(await f.renderer.showPackageModal({ runPreScan: false, review }), true);
      const session = f.read('packageReviewModalSessionId');
      assert.equal(f.read('packageDestinationPicker'), oldOwner, 'navigation cannot silently release an outstanding bridge');
      assert.equal(f.elements['package-review-ready'].textContent, 'Ready to package');
      assert.equal(f.elements['btn-change-dest'].disabled, true);
      assert.equal(f.elements['btn-confirm-package'].disabled, true);
      await f.renderer.choosePackageDestination();
      await f.renderer.confirmPackage();
      assert.equal(f.calls.pickers, 1);
      assert.equal(f.calls.peak, 1);
      f.assertStable();
      f.settle(0, outcome);
      await pending;
      assert.equal(f.read('state.selectedProjectId'), project.id);
      assert.equal(f.read('state.packageOutputPath'), null, 'late success cannot install an obsolete destination');
      assert.equal(f.read('state.packageReviewToken'), review.token);
      assert.equal(f.read('packageReviewModalSessionId'), session);
      assert.equal(f.elements['modal-package'].classList.contains('hidden'), false);
      assert.equal(f.read('packageDestinationPicker'), null);
      assert.equal(f.elements['btn-change-dest'].disabled, false);
      assert.equal(f.elements['btn-confirm-package'].disabled, false);
      assert.deepEqual(f.toasts, [], 'stale errors cannot overwrite the current interaction');
      const fresh = f.start();
      assert.equal(f.calls.pickers, 2);
      assert.equal(f.calls.active, 1);
      assert.equal(f.calls.peak, 1);
      f.settle(1, 'cancelled');
      await fresh;
      f.assertStable();
    });
  }
}

test('destination characterization: unchanged project refresh does not retire or duplicate a pending picker', async t => {
  const f = setupStablePngPicker(t);
  const pending = f.start(), owner = f.read('packageDestinationPicker');
  assert.equal(await f.renderer.refreshProjectState(f.projects[0].id), true);
  assert.equal(f.calls.projectReads, 1);
  assert.equal(f.read('packageDestinationPicker'), owner);
  assert.equal(f.elements['btn-change-dest'].disabled, true);
  assert.equal(f.elements['btn-confirm-package'].disabled, true);
  await f.renderer.choosePackageDestination();
  assert.equal(f.calls.pickers, 1);
  f.assertStable();
  f.settle(0, 'cancelled');
  await pending;
  assert.equal(f.elements['btn-confirm-package'].disabled, false);
  f.assertStable();
});

// Approved guard behavior replaces the old two-request characterization.
for (const boundary of ['project-navigation', 'same-project-reset', 'account-change']) {
  for (const outcome of ['selected', 'cancelled', 'rejected']) {
    test(`shared destination guard: fallback survives ${boundary} until late ${outcome} settles`, async t => {
      const f = setupStablePngPicker(t);
      const oldConfirmation = f.start(true);
      const owner = f.read('packageDestinationPicker');
      assert.ok(owner, 'confirmation fallback must acquire the shared owner');
      assert.equal(f.calls.active, 1);
      await f.renderer.choosePackageDestination();
      await f.renderer.confirmPackage();
      let project = f.projects[0];
      if (boundary === 'project-navigation') {
        project = f.projects[1];
        f.renderer.setSelectedProject(project.id);
      } else if (boundary === 'same-project-reset') {
        f.renderer.setSelectedProject(project.id, { invalidate: true });
      } else {
        f.renderer.acceptAccountSnapshot({ revision: 1, state: 'signed_in', canUseWorkspace: true, identity: { id: 'second-synthetic-account' } });
      }
      const review = f.reviewFor(project, `new-${boundary}`);
      assert.equal(await f.renderer.showPackageModal({ runPreScan: false, review }), true);
      const session = f.read('packageReviewModalSessionId');
      assert.equal(f.read('packageDestinationPicker'), owner);
      assert.equal(f.elements['btn-change-dest'].disabled, true);
      assert.equal(f.elements['btn-confirm-package'].disabled, true);
      assert.equal(f.elements['btn-change-dest'].getAttribute('aria-busy'), 'true');
      for (let attempt = 0; attempt < 3; attempt++) {
        await f.renderer.choosePackageDestination();
        await f.renderer.confirmPackage();
      }
      assert.equal(f.calls.pickers, 1);
      assert.equal(f.calls.active, 1);
      assert.equal(f.calls.peak, 1);
      f.settle(0, outcome);
      await oldConfirmation;
      assert.equal(f.read('packageDestinationPicker'), null);
      assert.equal(f.read('state.packageOutputPath'), null, 'retired fallback cannot install its old destination');
      assert.equal(f.read('state.packageReviewToken'), review.token);
      assert.equal(f.read('packageReviewModalSessionId'), session);
      assert.equal(f.elements['modal-package'].classList.contains('hidden'), false);
      assert.equal(f.elements['btn-change-dest'].disabled, false);
      assert.equal(f.elements['btn-confirm-package'].disabled, false);
      assert.equal(f.elements['btn-change-dest'].getAttribute('aria-busy'), 'false');
      assert.deepEqual(f.toasts, []);
      const currentPicker = f.start();
      assert.equal(f.calls.active, 1);
      assert.equal(f.calls.pickers, 2);
      assert.equal(f.calls.peak, 1);
      f.settle(1, 'selected');
      await currentPicker;
      assert.equal(f.read('state.packageOutputPath'), path.join(f.root, 'destination-1'));
      f.assertStable();
    });
  }
}

for (const outcome of ['selected', 'cancelled', 'rejected']) {
  test(`shared destination guard: current fallback ${outcome} releases ownership and can recover`, async t => {
    const f = setupStablePngPicker(t);
    // A synthetic changed-plan response stops after exercising confirmation's
    // destination adoption; no filesystem package or backend authorization runs.
    f.renderer.window.crate.packageProject = async () => {
      f.calls.packages++;
      return { error: 'package_review_changed', review: f.reviewFor(f.projects[0]) };
    };
    const pending = f.start(true);
    assert.ok(f.read('packageDestinationPicker'));
    assert.equal(f.elements['btn-change-dest'].getAttribute('aria-busy'), 'true');
    for (let attempt = 0; attempt < 3; attempt++) {
      await f.renderer.choosePackageDestination();
      await f.renderer.confirmPackage();
    }
    assert.equal(f.calls.pickers, 1);
    f.settle(0, outcome);
    await pending;
    assert.equal(f.read('packageDestinationPicker'), null);
    assert.equal(f.read('packageReviewConfirmationInFlight'), false);
    assert.equal(f.read('state.packageOutputPath'), outcome === 'selected' ? path.join(f.root, 'destination-0') : null);
    assert.equal(f.elements['modal-package'].classList.contains('hidden'), false);
    assert.equal(f.elements['btn-change-dest'].disabled, false);
    assert.equal(f.elements['btn-confirm-package'].disabled, false);
    assert.equal(f.elements['btn-change-dest'].getAttribute('aria-busy'), 'false');
    const fresh = f.start();
    assert.equal(f.calls.pickers, 2);
    assert.equal(f.calls.active, 1);
    assert.equal(f.calls.peak, 1);
    f.settle(1, 'cancelled');
    await fresh;
    f.assertStable(outcome === 'selected' ? { scans: 1, packages: 1 } : {});
  });
}

for (const entry of ['choose', 'confirmation']) {
  test(`shared destination guard: synchronously throwing ${entry} bridge releases ownership`, async t => {
    const f = setupStablePngPicker(t);
    const realDouble = f.renderer.window.crate.selectOutputFolder;
    f.renderer.window.crate.selectOutputFolder = () => { f.calls.pickers++; throw new Error('synthetic synchronous bridge failure'); };
    await f.start(entry === 'confirmation');
    assert.equal(f.read('packageDestinationPicker'), null);
    assert.equal(f.read('packageReviewConfirmationInFlight'), false);
    assert.equal(f.calls.pickers, 1);
    assert.equal(f.calls.active, 0);
    assert.equal(f.elements['btn-change-dest'].disabled, false);
    assert.equal(f.elements['btn-confirm-package'].disabled, false);
    f.renderer.window.crate.selectOutputFolder = realDouble;
    const fresh = f.start(entry === 'confirmation');
    assert.equal(f.calls.pickers, 2);
    assert.equal(f.calls.active, 1);
    assert.equal(f.calls.peak, 1);
    f.settle(0, 'cancelled');
    await fresh;
    f.assertStable();
  });
}
