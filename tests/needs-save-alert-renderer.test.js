'use strict';
const test = require('node:test');
const assert = require('./bounded-assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const wordingCases = require('./needs-save-wording-cases');

// Reuse the established modeled DOM and renderer fixture without running its tests.
const sharedPath = path.join(__dirname, 'renderer-figma-scope.test.js');
const shared = fs.readFileSync(sharedPath, 'utf8');
const fixtureEnd = shared.indexOf('\ntest(');
assert.ok(fixtureEnd > 0, 'shared fixture declarations must precede tests');
const fixtureScope = { require: createRequire(sharedPath), __dirname, console, setTimeout, clearTimeout };
vm.createContext(fixtureScope);
vm.runInContext(shared.slice(0, fixtureEnd), fixtureScope);
const { createInteractiveRendererDom, loadRendererHelpers, loadPendingBatchFixture, createPendingBatchProject, getElementTreeText } = fixtureScope;

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

function projectWith(id, pendingFiles) {
  const project = createPendingBatchProject(id);
  project.pendingFiles = pendingFiles;
  return project;
}

function alertText(elements) {
  return getElementTreeText(elements['needs-save-alert']).replace(/\s+/g, ' ').trim();
}

function setQuery(renderer, query, filter = 'all') {
  renderer.testQuery = query;
  renderer.testFilter = filter;
  vm.runInContext('state.assetReviewQuery = testQuery; state.assetReviewFilter = testFilter;', renderer);
  renderer.applyAssetReviewFilter();
}

test('markup: the alert is a polite live region between the Needs Review header and the batch controls', () => {
  const section = html.slice(html.indexOf('id="pending-section"'), html.indexOf('id="pending-file-list"'));
  const header = section.indexOf('id="pending-header"');
  const alert = section.indexOf('id="needs-save-alert"');
  const batch = section.indexOf('id="pending-batch-slot"');
  assert.ok(header > 0 && header < alert && alert < batch, 'alert sits at the top of the Needs Review section');
  assert.match(html, /id="needs-save-alert"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  // Package Review's alert is read in dialog order, not as a live region, and sits above "Save before packaging".
  assert.match(html, /<div class="modal-reminder is-thin hidden" id="modal-needs-save-reminder"><\/div>/);
  assert.ok(html.indexOf('id="modal-needs-save-reminder"') < html.indexOf('id="modal-presentation-reminder"'));
  assert.match(css, /\.modal-reminder\.is-thin\s*\{[^}]*padding:\s*7px 12px;[^}]*border-color:\s*#fcd34d;/);
  // Both alerts keep an 8px gap below them, as in the mockups.
  assert.match(css, /\.needs-save-alert\.modal-reminder\s*\{\s*margin:\s*0 0 8px;\s*\}/);
  assert.match(css, /#modal-needs-save-reminder\.modal-reminder\s*\{\s*margin-bottom:\s*8px;\s*\}/);
});

for (const wording of wordingCases) test(`alert and dashboard banner wording: ${wording.name}`, async () => {
  const f = await loadPendingBatchFixture({ project: projectWith(`wording-${wording.name}`, structuredClone(wording.rows)) });
  const alert = f.elements['needs-save-alert'];
  assert.equal(alert.classList.contains('modal-reminder'), true);
  assert.equal(alert.classList.contains('is-thin'), true);
  assert.equal(alertText(f.elements), `Needs Save ${wording.alert}`);
  const count = wording.rows.length;
  assert.equal(f.elements['project-review-eyebrow'].textContent, `${count} asset${count === 1 ? ' needs' : 's need'} save`);
  assert.equal(f.elements['project-review-detail'].textContent, wording.banner);
  assert.doesNotMatch(alertText(f.elements) + f.elements['project-review-detail'].textContent, /\/Users|\/synthetic|private/);
});

test('no Needs Save rows: the alert stays empty and the banner keeps its review wording', async () => {
  const f = await loadPendingBatchFixture({ id: 'no-needs-save' });
  const alert = f.elements['needs-save-alert'];
  assert.equal(alert.children.length, 0);
  assert.equal(alert.classList.contains('modal-reminder'), false);
  assert.equal(f.elements['project-review-eyebrow'].textContent, '4 files need review');
});

test('mixed list: the alert covers the Needs Save rows, the banner and row order are unchanged', async () => {
  const project = createPendingBatchProject('mixed-needs-save');
  project.pendingFiles[1].captureState = 'needs-save';
  const f = await loadPendingBatchFixture({ project });
  assert.equal(alertText(f.elements), 'Needs Save Save Working.ai in Illustrator to add this linked asset to the package.');
  assert.equal(f.elements['project-review-eyebrow'].textContent, '4 files need review');
  assert.equal(f.elements['asset-review-batch-reason'].textContent, 'Include All and Exclude All apply only to rows marked Include or Exclude.');
  const order = f.elements['pending-file-list'].__assetReviewAllItems.map(file => file.name).join(',');
  assert.equal(order, 'Needs_1.png,Needs_2.png,Needs_3.png,Needs_4.png');
});

test('search: the alert follows the Needs Save rows the search leaves visible', async () => {
  const project = createPendingBatchProject('search-needs-save');
  project.pendingFiles[3].captureState = 'needs-save';
  const f = await loadPendingBatchFixture({ project });
  assert.match(alertText(f.elements), /this linked asset/);
  setQuery(f.renderer, 'needs_1');
  assert.equal(f.elements['needs-save-alert'].children.length, 0, 'search hides the only Needs Save row');
  assert.equal(f.elements['needs-save-alert'].classList.contains('modal-reminder'), false);
  setQuery(f.renderer, 'needs_4');
  assert.match(alertText(f.elements), /^Needs Save Save Working\.ai in Illustrator/);
});

test('unchanged text is not rewritten: filter switches and re-renders do not re-announce', async () => {
  const project = projectWith('stable-needs-save', structuredClone(wordingCases[0].rows));
  const f = await loadPendingBatchFixture({ project });
  const alert = f.elements['needs-save-alert'];
  const children = [...alert.children];
  setQuery(f.renderer, '', 'existing');
  setQuery(f.renderer, '', 'missing');
  setQuery(f.renderer, '', 'all');
  await f.renderer.renderFiles();
  assert.equal(alert.children.length, 2);
  assert.ok(alert.children.every((child, index) => child === children[index]), 'live region content was not replaced');
});

test('the alert clears itself when no Needs Save rows remain', async () => {
  const project = projectWith('clears-needs-save', structuredClone(wordingCases[0].rows));
  const f = await loadPendingBatchFixture({ project });
  assert.match(alertText(f.elements), /Needs Save/);
  f.getPersisted().pendingFiles = [];
  vm.runInContext('state.projects[0].pendingFiles = []', f.renderer);
  await f.renderer.renderFiles();
  assert.equal(f.elements['needs-save-alert'].children.length, 0);
  assert.equal(f.elements['needs-save-alert'].classList.contains('modal-reminder'), false);
});

test('project switch: the previous project\'s instruction is cleared before the next workspace arrives', async () => {
  const f = await loadPendingBatchFixture({ project: projectWith('switch-a', structuredClone(wordingCases[0].rows)) });
  assert.match(alertText(f.elements), /Campaign_Board\.ai/);
  const previousChildren = [...f.elements['needs-save-alert'].children];
  const other = projectWith('switch-b', []);
  f.renderer.otherProject = other;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const bridge = f.renderer.window.crate;
  const originalWorkspace = bridge.getAssetWorkspace;
  bridge.getProjects = async () => [structuredClone(f.getPersisted()), structuredClone(other)];
  bridge.getAssetWorkspace = async projectId => projectId === other.id ? held : originalWorkspace(projectId);
  assert.equal(f.elements['project-review-eyebrow'].textContent, '2 assets need save');
  vm.runInContext('state.projects = [state.projects[0], otherProject]; setSelectedProject(otherProject.id);', f.renderer);
  const rendering = f.renderer.renderFiles();
  assert.equal(f.elements['needs-save-alert'].children.length, 0, 'no instruction from the previous project while the next one loads');
  // The dashboard banner is reset too, so it does not name the previous project's file.
  assert.equal(f.elements['project-review-eyebrow'].textContent, 'Project assets');
  assert.equal(f.elements['project-linking-alert'].textContent, '');
  assert.equal(f.elements['project-review-detail'].textContent, '');
  assert.equal(f.elements['needs-save-alert'].classList.contains('modal-reminder'), false);
  assert.doesNotMatch(alertText(f.elements), /Campaign_Board/);
  // The next project gives the identical sentence: it is written again, so it is announced.
  other.pendingFiles = structuredClone(wordingCases[0].rows);
  vm.runInContext('state.projects[1].pendingFiles = otherProject.pendingFiles', f.renderer);
  release({ projectId: other.id, files: [], pendingFiles: other.pendingFiles.map((file, sourceIndex) => ({ name: file.name, ext: file.ext, visualIdentity: file.path, visualRevision: 'r', sourceIndex })) });
  await rendering;
  await f.renderer.renderFiles();
  assert.equal(alertText(f.elements), `Needs Save ${wordingCases[0].alert}`);
  assert.ok(f.elements['needs-save-alert'].children.every(child => !previousChildren.includes(child)), 'new nodes, so the live region announces');
});

test('account change: the previous account\'s instruction is cleared', async () => {
  const f = await loadPendingBatchFixture({ project: projectWith('account-a', structuredClone(wordingCases[0].rows)) });
  const signedIn = id => ({ state: 'signed_in', canUseWorkspace: true, identity: { id }, message: '' });
  f.renderer.acceptAccountSnapshot({ revision: 10, ...signedIn('account-a') });
  await f.renderer.renderFiles();
  assert.match(alertText(f.elements), /Campaign_Board\.ai/);
  f.renderer.acceptAccountSnapshot({ revision: 11, ...signedIn('account-b') });
  assert.equal(f.elements['needs-save-alert'].children.length, 0);
  assert.doesNotMatch(alertText(f.elements), /Campaign_Board/);
  // The dashboard banner is retired with it.
  assert.equal(f.elements['project-review-eyebrow'].textContent, 'Project assets');
  assert.equal(f.elements['project-linking-alert'].textContent, '');
  assert.equal(f.elements['project-review-detail'].textContent, '');
  // The rows kept on screen still belong to account A until the workspace
  // reloads: changing the filter or search must not bring the sentence back.
  for (const [query, filter] of [['', 'existing'], ['', 'missing'], ['linked', 'all'], ['', 'all']]) {
    setQuery(f.renderer, query, filter);
    assert.equal(f.elements['needs-save-alert'].children.length, 0, `stays cleared after ${filter} / "${query}"`);
  }
  // Once the selected project's workspace has loaded again, the alert returns.
  await f.renderer.renderFiles();
  assert.equal(alertText(f.elements), `Needs Save ${wordingCases[0].alert}`);
});

function packageReviewSetup({ pendingFiles = [], files = null } = {}) {
  const { document, elements } = createInteractiveRendererDom();
  const projectFiles = files || [
    { name: 'Campaign_Board.ai', ext: '.ai', visualIdentity: 'board', visualRevision: 'rev-board', projectRole: 'source', packageFolder: 'AI' },
    { name: 'Logo.svg', ext: '.svg', visualIdentity: 'logo', visualRevision: 'rev-logo', projectRole: 'asset', packageFolder: 'SVG' },
  ];
  const project = { id: 'needs-save-package-review', name: 'Synthetic project', files: projectFiles, pendingFiles, excludedAssetKeys: [] };
  const review = { projectId: project.id, files: projectFiles, token: 'review-token', materializable: true };
  const renderer = loadRendererHelpers(document, { crate: {
    getFileVisual: async () => null, getProjects: async () => [project], preScanSession: async () => null,
    preparePackageReview: async () => review,
  } });
  renderer.fixtureProject = project;
  vm.runInContext(`state.projects = [fixtureProject]; state.selectedProjectId = fixtureProject.id;
    state.settings = { namingTemplate: '{Project}', packageOutputLayoutMode: 'by-extension-v1' };
    state.packageOutputPath = '/synthetic/output';`, renderer);
  renderer.setupEventListeners();
  renderer.renderPackageReview(project, review);
  return { renderer, elements, project, review };
}

test('Package Review re-render without Needs Save rows clears the alert and the button description', () => {
  const { renderer, elements, project, review } = packageReviewSetup({ pendingFiles: structuredClone(wordingCases[0].rows) });
  assert.equal(elements['btn-confirm-package'].getAttribute('aria-describedby'), 'modal-needs-save-reminder');
  project.pendingFiles = [];
  renderer.renderPackageReview(project, review, '', vm.runInContext('activeModalLease', renderer));
  assert.ok(vm.runInContext('activeModalLease', renderer), 'the open dialog keeps its lease');
  assert.equal(elements['modal-needs-save-reminder'].classList.contains('hidden'), true);
  assert.equal(elements['modal-needs-save-reminder'].children.length, 0);
  assert.equal(elements['btn-confirm-package'].getAttribute('aria-describedby'), undefined);
});

test('Package Review reads current rows, not a project captured before preparation', () => {
  const { renderer, elements, project, review } = packageReviewSetup({ pendingFiles: structuredClone(wordingCases[0].rows) });
  // The save landed while the review was being prepared: state now has no Needs Save rows.
  renderer.currentProject = { ...structuredClone(project), pendingFiles: [] };
  vm.runInContext('state.projects = [currentProject]', renderer);
  renderer.renderPackageReview(project, review, '', vm.runInContext('activeModalLease', renderer));
  assert.ok(vm.runInContext('activeModalLease', renderer), 'the open dialog keeps its lease');
  assert.equal(elements['modal-needs-save-reminder'].classList.contains('hidden'), true);
  assert.equal(elements['btn-confirm-package'].getAttribute('aria-describedby'), undefined);
});

test('Package Review drops path-like names and leaves out remembered excluded rows', () => {
  const rows = [
    { ...structuredClone(wordingCases[0].rows[0]), captureEvidence: { appFamily: 'illustrator', sourceName: '/Users/private/Client/Board.ai' } },
    { ...structuredClone(wordingCases[0].rows[1]), captureEvidence: { appFamily: 'illustrator', sourceName: '/Users/private/Client/Board.ai' } },
  ];
  const { renderer, elements, project, review } = packageReviewSetup({ pendingFiles: rows });
  assert.equal(getElementTreeText(elements['modal-needs-save-reminder']).replace(/\s+/g, ' ').trim(),
    'Needs Save Save your file in Illustrator to add these 2 linked assets to the package.');
  project.excludedAssetKeys = [rows[1].path];
  renderer.renderPackageReview(project, review, '', vm.runInContext('activeModalLease', renderer));
  assert.ok(vm.runInContext('activeModalLease', renderer), 'the open dialog keeps its lease');
  assert.equal(getElementTreeText(elements['modal-needs-save-reminder']).replace(/\s+/g, ' ').trim(),
    'Needs Save Save your file in Illustrator to add this linked asset to the package.');
  assert.doesNotMatch(getElementTreeText(elements['modal-needs-save-reminder']), /private|\/Users/);
});

test('Package Review shows the same sentence, keeps packaging allowed and describes the Package Project button', () => {
  const { elements } = packageReviewSetup({ pendingFiles: structuredClone(wordingCases[0].rows) });
  const reminder = elements['modal-needs-save-reminder'];
  assert.equal(reminder.classList.contains('hidden'), false);
  assert.equal(getElementTreeText(reminder).replace(/\s+/g, ' ').trim(), `Needs Save ${wordingCases[0].alert}`);
  assert.equal(elements['btn-confirm-package'].getAttribute('aria-describedby'), 'modal-needs-save-reminder');
  assert.equal(elements['btn-confirm-package'].disabled, false);
  assert.equal(elements['package-review-ready'].textContent, 'Ready to package');
});

for (const [label, choiceReview] of [
  ['working-file choice', { error: 'working_file_choice_required' }],
  ['source continuation choice', { error: 'working_source_continuation_choice_required' }],
  ['not materializable', { materializable: false }],
]) test(`Package Review that cannot be packaged yet (${label}) does not show the Needs Save alert`, () => {
  const { renderer, elements, project, review } = packageReviewSetup({ pendingFiles: structuredClone(wordingCases[0].rows) });
  assert.equal(elements['modal-needs-save-reminder'].classList.contains('hidden'), false);
  // These paths render before the project is refreshed, so the rows may be stale.
  const { token, ...rest } = review;
  renderer.choiceReview = { ...rest, ...choiceReview, ...(choiceReview.materializable === false ? { token } : {}) };
  renderer.renderPackageReview(project, renderer.choiceReview, '', vm.runInContext('activeModalLease', renderer));
  assert.ok(vm.runInContext('activeModalLease', renderer), 'the open dialog keeps its lease');
  assert.equal(elements['btn-confirm-package'].disabled, true);
  assert.equal(elements['modal-needs-save-reminder'].classList.contains('hidden'), true);
  assert.equal(elements['modal-needs-save-reminder'].children.length, 0);
  assert.equal(elements['btn-confirm-package'].getAttribute('aria-describedby'), undefined);
});

test('Package Review counts linked assets only, not the unsaved working file', () => {
  const wording = wordingCases.find(item => item.name === 'unsaved working file and one new linked asset');
  const { elements } = packageReviewSetup({ pendingFiles: structuredClone(wording.rows) });
  assert.equal(getElementTreeText(elements['modal-needs-save-reminder']).replace(/\s+/g, ' ').trim(), `Needs Save ${wording.alert}`);
});

test('Package Review without Needs Save rows hides the alert and drops the description', () => {
  const { elements } = packageReviewSetup({ pendingFiles: [{ name: 'Maybe.png', ext: '.png', captureState: 'pending' }] });
  assert.equal(elements['modal-needs-save-reminder'].classList.contains('hidden'), true);
  assert.equal(elements['modal-needs-save-reminder'].children.length, 0);
  assert.equal(elements['btn-confirm-package'].getAttribute('aria-describedby'), undefined);
});

test('Package Review: "Save before packaging" is unchanged beside the Needs Save alert for a mixed deck project', () => {
  const { elements } = packageReviewSetup({
    pendingFiles: structuredClone(wordingCases[1].rows),
    files: [
      { name: 'Pitch.pptx', ext: '.pptx', visualIdentity: 'deck', visualRevision: 'rev-deck', projectRole: 'source', packageFolder: 'PPTX' },
      { name: 'Campaign_Board.ai', ext: '.ai', visualIdentity: 'board', visualRevision: 'rev-board', projectRole: 'source', packageFolder: 'AI' },
    ],
  });
  assert.equal(elements['modal-needs-save-reminder'].classList.contains('hidden'), false);
  assert.equal(elements['modal-presentation-reminder'].classList.contains('hidden'), false);
  assert.match(html, /id="modal-presentation-reminder">\s*<div class="modal-reminder-title">Save before packaging<\/div>\s*<div class="modal-reminder-copy">Unsaved changes are not included\.<\/div>/);
});
