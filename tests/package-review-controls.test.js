'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
