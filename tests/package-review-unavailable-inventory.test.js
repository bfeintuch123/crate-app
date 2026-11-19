'use strict';
// Package Review when no file list is available: the production renderer runs
// against the shared synthetic DOM. IPC is mocked and all files are synthetic;
// nothing here is native evidence.
const test = require('node:test');
const assert = require('./bounded-assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const sharedPath = path.join(__dirname, 'renderer-figma-scope.test.js');
const shared = fs.readFileSync(sharedPath, 'utf8');
const fixtureScope = { require: createRequire(sharedPath), __dirname, console, setTimeout, clearTimeout };
vm.createContext(fixtureScope);
vm.runInContext(shared.slice(0, shared.indexOf('\ntest(')), fixtureScope);
const { createInteractiveRendererDom, loadRendererHelpers, getElementTreeText } = fixtureScope;

const UNAVAILABLE_TOTAL = 'Visual assets unavailable';
const COUNT_LABELS = ['Working files', 'Existing assets', 'Added while working', 'Needs Review'];
const CHOICE_CODE = 'working_file_choice_required';
const PAIR_CODE = 'working_source_continuation_choice_required';
const CHOICE_MESSAGE = 'Decide how to use the new working files before packaging.';
const PAIR_MESSAGE = 'Choose how these working files relate.';
const RECOVERY_MESSAGE = 'Synthetic recovery note.';
const FIGMA_TRACKED = [{ fileKey: 'synthetic-key', url: 'https://www.figma.com/design/synthetic-key/Sample', lockedPageName: 'Sample Page' }];

const clone = value => JSON.parse(JSON.stringify(value));
const descendants = node => [node, ...(node.children || []).flatMap(descendants)];
const buttonFor = (node, text) => descendants(node).find(child => child.tagName === 'BUTTON' && child.textContent === text);

function workspaceRow(overrides = {}) {
  return { name: 'Layout.ai', ext: '.ai', appFamily: 'illustrator', visualIdentity: 'layout-visual', visualRevision: 'layout-1',
    protectedSource: true, projectRole: 'source', effectiveRole: 'source', assetOrigin: 'added', sourceSelection: 'selected',
    selectionRevision: 0, included: true, includedAsDependency: false, verificationStatus: 'scanned', verificationRequired: false,
    requiredBy: [], ...overrides };
}

function setup({ figma = false, row = {} } = {}) {
  const { document, elements } = createInteractiveRendererDom();
  const fileRow = workspaceRow(row);
  const project = { id: 'inventory-project', name: 'Sample Project', status: 'watching', files: [fileRow], pendingFiles: [],
    excludedAssetKeys: [], ...(figma ? { figmaTrackedFiles: FIGMA_TRACKED } : {}) };
  const workspace = { projectId: project.id, files: [fileRow], pendingFiles: [] };
  const packageRequests = [];
  const crate = {
    getProjects: async () => [clone(project)],
    getAssetWorkspace: async () => clone(workspace),
    getFileVisual: async () => null,
    preparePackageReview: async () => ({ projectId: project.id, files: [], materializable: false }),
    preScanSession: async () => null,
    packageProject: async (...args) => { packageRequests.push(args); return { success: true }; },
  };
  const renderer = loadRendererHelpers(document, { crate });
  renderer.fixtureProject = project;
  renderer.fixtureWorkspace = workspace;
  vm.runInContext(`state.projects = [fixtureProject]; state.selectedProjectId = fixtureProject.id;
    state.assetWorkspace = fixtureWorkspace; assetWorkspaceProjectSnapshot = fixtureProject;
    state.settings = { namingTemplate: '{Project}' }; state.packageOutputPath = '/synthetic/output';
    accountStatus.canUseWorkspace = true;`, renderer);
  renderer.showToast = () => {};
  const rendered = [], built = [];
  const render = renderer.renderPackageReview;
  renderer.renderPackageReview = (...args) => { rendered.push(args[1]); return render(...args); };
  const build = renderer.createUnavailableRendererReview;
  renderer.createUnavailableRendererReview = async (...args) => { const review = await build(...args); built.push(review); return review; };
  const f = { renderer, document, elements, project, workspace, crate, rendered, built, packageRequests };
  f.show = (options = {}) => renderer.showPackageModal({ runPreScan: false, ...options });
  f.answer = review => { crate.preparePackageReview = async () => review; };
  f.last = () => rendered.at(-1);
  f.token = () => vm.runInContext('state.packageReviewToken', renderer);
  f.contents = () => vm.runInContext('packageReviewContents', renderer);
  f.element = id => document.getElementById(id);
  f.freshPage = () => { f.element('package-review-total').textContent = '0 visual assets'; };
  f.noWorkspace = () => {
    vm.runInContext('state.assetWorkspace = null', renderer);
    crate.getAssetWorkspace = async () => null;
  };
  return f;
}

function summaryRows(f) {
  return new Map(Array.from(f.element('package-review-summary-list').children, row => [row.children[0].textContent, row.children[1].textContent]));
}

function choiceRefusal(f, extra = {}) {
  return { projectId: f.project.id, error: CHOICE_CODE, workingFileChoices: { version: 1, blocked: true, choices: [] }, ...extra };
}

function pairContract() {
  return { version: 1, capability: 'pair-choice-v1', candidates: [{
    pairIdentity: 'a'.repeat(64), evidenceIdentity: 'b'.repeat(64), revision: 4,
    predecessor: { name: 'Earlier.ai', visualIdentity: 'earlier-1', selectionRevision: 1, selectionState: 'selected', admissionState: 'accepted' },
    successor: { name: 'Later.ai', visualIdentity: 'later-1', selectionRevision: 2, selectionState: 'selected', admissionState: 'accepted' },
    replaceRequires: null, retainsPredecessorAsDependency: true,
  }] };
}

function pairRefusal(f, extra = {}) {
  return { projectId: f.project.id, error: PAIR_CODE, sourceContinuation: pairContract(), ...extra };
}

const REFUSALS = [
  { code: CHOICE_CODE, build: choiceRefusal, options: {}, message: CHOICE_MESSAGE },
  { code: PAIR_CODE, build: pairRefusal, options: { message: PAIR_MESSAGE }, message: PAIR_MESSAGE },
];

function reviewFiles(count) {
  return Array.from({ length: count }, (_, index) => {
    if (index === 0) return { name: 'Layout.ai', ext: '.ai', appFamily: 'illustrator', projectRole: 'source', assetOrigin: 'added', status: 'ready' };
    return { name: `Item${index}.png`, ext: '.png', appFamily: 'generic', projectRole: 'asset',
      assetOrigin: index % 2 ? 'existing' : 'added', status: index === 1 ? 'needs-review' : 'ready' };
  });
}

function expectedCounts(files) {
  return new Map([
    ['Working files', String(files.filter(file => file.projectRole === 'source').length)],
    ['Existing assets', String(files.filter(file => file.assetOrigin === 'existing' && file.projectRole !== 'source').length)],
    ['Added while working', String(files.filter(file => file.assetOrigin === 'added' && file.projectRole !== 'source').length)],
    ['Needs Review', String(files.filter(file => file.status && file.status !== 'ready').length)],
  ]);
}

function assertUnavailableScreen(f, message) {
  assert.equal(f.element('package-review-total').textContent, UNAVAILABLE_TOTAL);
  const rows = summaryRows(f);
  for (const label of COUNT_LABELS) assert.equal(rows.get(label), 'Unavailable', label);
  assert.equal(rows.get('Package status'), 'Review required');
  assert.equal(f.element('package-review-ready').textContent, 'Review required');
  assert.equal(f.element('modal-package-review-message').textContent, message);
  assert.equal(f.element('btn-confirm-package').disabled, true);
  assert.equal(f.token(), null);
}

function assertRouteControls(f, code) {
  const choices = f.element('source-continuation-choices');
  if (code === CHOICE_CODE) assert.match(getElementTreeText(choices), /Packaging blocked\. Review working-file decisions in Project Workspace\./);
  else assert.ok(buttonFor(choices, 'Replace'), 'the pair keeps its Replace control');
}

function assertFigmaKept(f) {
  assert.equal(f.element('modal-figma-scope-row').classList.contains('hidden'), false);
  const scopeLabel = f.renderer.getProjectFigmaScopeLabel(f.project);
  assert.ok(scopeLabel);
  assert.equal(f.element('modal-figma-scope').textContent, scopeLabel);
  assert.ok(getElementTreeText(f.element('package-review-apps')).includes(`Figma · ${scopeLabel}`));
}

function assertZeroScreen(f) {
  assert.equal(f.element('package-review-total').textContent, '0 visual assets');
  const rows = summaryRows(f);
  for (const label of COUNT_LABELS) assert.equal(rows.get(label), '0', label);
}

function assertCountsScreen(f, files) {
  assert.equal(f.element('package-review-total').textContent, `${files.length} visual asset${files.length === 1 ? '' : 's'}`);
  const rows = summaryRows(f), expected = expectedCounts(files);
  for (const label of COUNT_LABELS) assert.equal(rows.get(label), expected.get(label), label);
}

const hasField = review => Object.prototype.hasOwnProperty.call(review, 'inventoryUnavailable');

// ===== Part 1a: the two direct refusal routes =====
for (const refusal of REFUSALS) {
  for (const [variant, extra] of [['missing', {}], ['null', { files: null }], ['not a list', { files: {} }]]) {
    test(`${refusal.code} with files ${variant} shows unavailable values`, async () => {
      const f = setup();
      f.freshPage();
      f.answer(refusal.build(f, extra));
      assert.equal(await f.show(refusal.options), false);
      assert.equal(f.rendered.length, 1, 'rendered once, with nothing thrown');
      assert.equal(f.last().inventoryUnavailable, true);
      assert.equal(f.built.length, 0, 'no window-built review');
      assertUnavailableScreen(f, refusal.message);
      assertRouteControls(f, refusal.code);
    });
  }

  test(`${refusal.code} keeps the Figma chip and scope row`, async () => {
    const f = setup({ figma: true });
    f.answer(refusal.build(f));
    await f.show(refusal.options);
    assert.equal(f.last().inventoryUnavailable, true);
    assertUnavailableScreen(f, refusal.message);
    assertRouteControls(f, refusal.code);
    assertFigmaKept(f);
  });

  test(`${refusal.code} replaces the counts of an earlier review`, async () => {
    const f = setup();
    const files = reviewFiles(3);
    f.answer({ projectId: f.project.id, files, totalFiles: files.length, materializable: false });
    await f.show();
    assertCountsScreen(f, files);
    f.answer(refusal.build(f));
    await f.show(refusal.options);
    assert.equal(f.last().inventoryUnavailable, true);
    assertUnavailableScreen(f, refusal.message);
    assertRouteControls(f, refusal.code);
  });

  test(`${refusal.code} state ends when an ordinary review follows`, async () => {
    const f = setup();
    f.answer(refusal.build(f));
    await f.show(refusal.options);
    assertUnavailableScreen(f, refusal.message);
    assertRouteControls(f, refusal.code);
    const files = reviewFiles(11);
    f.answer({ projectId: f.project.id, files, totalFiles: files.length, materializable: true, token: 'ordinary-token' });
    assert.equal(await f.show(), true);
    assert.equal(hasField(f.last()), false);
    assertCountsScreen(f, files);
    const toggle = f.element('btn-toggle-package-contents');
    assert.equal(toggle.classList.contains('hidden'), false);
    assert.match(toggle.textContent, /^\+3 more/);
    assert.equal(f.element('btn-confirm-package').disabled, false);
    assert.equal(f.token(), 'ordinary-token', 'an ordinary review can still be packaged');
    assert.equal(f.element('package-review-ready').textContent, 'Ready to package');
  });

  test(`${refusal.code} collapses and relabels expanded contents`, async () => {
    const f = setup();
    const files = reviewFiles(10);
    f.answer({ projectId: f.project.id, files, totalFiles: files.length, materializable: false });
    await f.show();
    f.renderer.togglePackageReviewContents();
    const toggle = f.element('btn-toggle-package-contents');
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    f.answer(refusal.build(f));
    await f.show(refusal.options);
    assertUnavailableScreen(f, refusal.message);
    assertRouteControls(f, refusal.code);
    assert.equal(toggle.classList.contains('hidden'), true);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(toggle.textContent, 'Show all files');
    const contents = f.contents();
    assert.ok(contents.lease, 'the contents keep their lease');
    assert.equal(contents.expanded, false);
    assert.equal(contents.files.length, 0);
    assert.equal(f.element('modal-file-list').children.length, 0);
  });

  test(`control: ${refusal.code} with an empty list shows zero and carries no field`, async () => {
    const f = setup();
    f.answer(refusal.build(f, { files: [] }));
    await f.show(refusal.options);
    assert.equal(hasField(f.last()), false);
    assertZeroScreen(f);
  });
}

test('the screen alone: the field blocks packaging and the file list is not read', () => {
  const f = setup();
  f.freshPage();
  const shown = f.renderer.renderPackageReview(f.project, { projectId: f.project.id, inventoryUnavailable: true, materializable: true,
    token: 'usable-token', files: [{ name: 'Deck.pptx', ext: '.pptx', appFamily: 'powerpoint', projectRole: 'source', assetOrigin: 'added' }] }, RECOVERY_MESSAGE);
  assert.equal(shown, true);
  assertUnavailableScreen(f, RECOVERY_MESSAGE);
  assert.equal(f.element('modal-file-list').children.length, 0, 'no file row');
  assert.equal(f.element('package-review-apps').children.length, 0, 'no app chip');
  assert.equal(f.element('package-portable-pictures-row').classList.contains('hidden'), true);
});

test('control: an ordinary answer with files shows its counts and carries no field', async () => {
  const f = setup();
  const files = reviewFiles(4);
  f.answer({ projectId: f.project.id, files, totalFiles: 4, materializable: true, token: 'ordinary-token' });
  assert.equal(await f.show(), true);
  assert.equal(hasField(f.last()), false);
  assertCountsScreen(f, files);
  assert.equal(f.token(), 'ordinary-token');
});

test('control: a blocked answer with files shows its counts and carries no field', async () => {
  const f = setup();
  const files = reviewFiles(4);
  f.answer({ projectId: f.project.id, files, totalFiles: 4, materializable: false, message: 'Blocked for a synthetic reason.' });
  await f.show();
  assert.equal(hasField(f.last()), false);
  assertCountsScreen(f, files);
  assert.equal(f.element('btn-confirm-package').disabled, true);
});

for (const [variant, extra] of [['missing', {}], ['null', { files: null }]]) {
  test(`control: an ordinary answer with files ${variant} still prints zero`, async () => {
    const f = setup();
    f.answer({ projectId: f.project.id, materializable: true, token: 'ordinary-token', ...extra });
    await f.show();
    assert.equal(hasField(f.last()), false);
    assertZeroScreen(f);
  });
}

test('control: a refusal rendered by a direct call still prints zero', () => {
  const f = setup();
  assert.equal(f.renderer.renderPackageReview(f.project, { ...choiceRefusal(f), materializable: false }, CHOICE_MESSAGE), true);
  assert.equal(hasField(f.last()), false);
  assertZeroScreen(f);
});

test('control: a malformed ordinary answer is recovered and sends no package request', async () => {
  const f = setup();
  f.answer({ projectId: f.project.id, files: {}, materializable: true, token: 'ordinary-token' });
  assert.equal(await f.show({ message: RECOVERY_MESSAGE }), false);
  assert.equal(f.built.length, 1, 'a window-built review replaces it');
  assert.equal(f.last(), f.built[0]);
  assert.equal(f.element('btn-confirm-package').disabled, true);
  assert.equal(f.token(), null);
  await f.renderer.confirmPackage();
  assert.deepEqual(f.packageRequests, []);
});

// ===== Part 1b: a window-built review with no workspace list =====
const FAILURES = [
  ['an error answer', f => f.answer({ projectId: f.project.id, error: 'package_review_unavailable' })],
  ['a rejected request', f => { f.crate.preparePackageReview = async () => { throw new Error('synthetic preparation failure'); }; }],
];

for (const [label, fail] of FAILURES) {
  test(`${label} with no workspace shows unavailable values`, async () => {
    const f = setup();
    f.freshPage();
    f.noWorkspace();
    fail(f);
    assert.equal(await f.show({ message: RECOVERY_MESSAGE }), false);
    assert.equal(f.built.length, 1);
    assert.equal(f.last().inventoryUnavailable, true);
    assert.equal(f.last().totalFiles, 0);
    assert.equal(f.last().files.length, 0);
    assert.equal(f.last().materializable, false);
    assertUnavailableScreen(f, RECOVERY_MESSAGE);
  });
}

test('a window-built review with no workspace keeps the Figma chip and scope row', async () => {
  const f = setup({ figma: true });
  f.noWorkspace();
  FAILURES[0][1](f);
  await f.show({ message: RECOVERY_MESSAGE });
  assert.equal(f.last().inventoryUnavailable, true);
  assertUnavailableScreen(f, RECOVERY_MESSAGE);
  assertFigmaKept(f);
});

test('a workspace for this project with no file list shows unavailable values', async () => {
  const f = setup();
  vm.runInContext('state.assetWorkspace = null', f.renderer);
  f.crate.getAssetWorkspace = async () => ({ projectId: f.project.id, pendingFiles: [] });
  FAILURES[0][1](f);
  await f.show({ message: RECOVERY_MESSAGE });
  assert.equal(f.last().inventoryUnavailable, true);
  assertUnavailableScreen(f, RECOVERY_MESSAGE);
});

const invalidPairRefusal = f => ({ projectId: f.project.id, error: PAIR_CODE,
  sourceContinuation: { version: 1, capability: 'pair-choice-v1', candidates: [{ pairIdentity: 'not-valid' }] } });

test('a pair refusal with no valid candidate and no workspace shows unavailable values', async () => {
  const f = setup();
  f.noWorkspace();
  f.answer(invalidPairRefusal(f));
  await f.show({ message: RECOVERY_MESSAGE });
  assert.equal(f.built.length, 1);
  assert.equal(f.last().inventoryUnavailable, true);
  assertUnavailableScreen(f, RECOVERY_MESSAGE);
});

test('the window-built state ends when a later workspace read yields files', async () => {
  const f = setup();
  f.noWorkspace();
  FAILURES[0][1](f);
  await f.show({ message: RECOVERY_MESSAGE });
  assertUnavailableScreen(f, RECOVERY_MESSAGE);
  f.crate.getAssetWorkspace = async () => clone(f.workspace);
  await f.show({ message: RECOVERY_MESSAGE });
  assert.equal(hasField(f.last()), false);
  assert.equal(f.element('package-review-total').textContent, '1 visual asset');
  assert.equal(summaryRows(f).get('Working files'), '1');
});

test('control: a workspace read with an empty list shows zero and carries no field', async () => {
  const f = setup();
  vm.runInContext('state.assetWorkspace = null', f.renderer);
  f.crate.getAssetWorkspace = async () => ({ projectId: f.project.id, files: [], pendingFiles: [] });
  FAILURES[0][1](f);
  await f.show({ message: RECOVERY_MESSAGE });
  assert.equal(hasField(f.last()), false);
  assertZeroScreen(f);
});

test('control: a workspace whose only row is an excluded working file shows zero and carries no field', async () => {
  const f = setup({ row: { sourceSelection: 'excluded', included: false, excluded: false } });
  FAILURES[0][1](f);
  await f.show({ message: RECOVERY_MESSAGE });
  assert.equal(hasField(f.last()), false);
  assertZeroScreen(f);
});

test('control: a workspace read with files shows their counts and carries no field', async () => {
  const f = setup();
  FAILURES[1][1](f);
  await f.show({ message: RECOVERY_MESSAGE });
  assert.equal(hasField(f.last()), false);
  assert.equal(f.element('package-review-total').textContent, '1 visual asset');
  assert.equal(summaryRows(f).get('Working files'), '1');
});

test('control: a pair refusal with no valid candidate and a readable workspace shows its counts', async () => {
  const f = setup();
  f.answer(invalidPairRefusal(f));
  await f.show({ message: RECOVERY_MESSAGE });
  assert.equal(f.built.length, 1);
  assert.equal(hasField(f.last()), false);
  assert.equal(f.element('package-review-total').textContent, '1 visual asset');
});
