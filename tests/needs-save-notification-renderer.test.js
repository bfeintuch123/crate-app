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
const { createInteractiveRendererDom, loadRendererHelpers } = fixtureScope;

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

// Two watching projects: "a" has no Needs Save rows, "b" has two linked assets
// waiting for Campaign_Board.ai to be saved.
function needsSaveNotificationFixture({ projectsOverride = null } = {}) {
  const { document, elements } = createInteractiveRendererDom();
  const projects = projectsOverride || ['a', 'b'].map(id => ({
    id, name: `Synthetic ${id}`, type: 'branding', status: 'watching',
    files: [{ name: `${id}.png`, path: `/synthetic/${id}.png`, assetOrigin: 'added', projectRole: 'asset' }],
    pendingFiles: id === 'b' ? structuredClone(wordingCases[0].rows) : [],
    excludedAssetKeys: [],
  }));
  let handler = null;
  const updates = [];
  const noOp = () => {};
  const renderer = loadRendererHelpers(document, { crate: {
    getProjects: async () => structuredClone(projects),
    getSettings: async () => ({}), getUsage: async () => ({}), getFigmaStatus: async () => ({ connected: false }),
    updateSetting: async (key, value) => { updates.push([key, value]); return { [key]: value }; },
    onNeedsSaveReview: callback => { handler = callback; },
    onExistingAssetsReview: noOp,
    onFilesUpdated: noOp, onProjectUpdated: noOp, onPendingFilesUpdated: noOp, onPackageTrigger: noOp,
    onFigmaAuthError: noOp, onFigmaScanStarted: noOp, onFigmaScanComplete: noOp, onFigmaScanError: noOp,
  } });
  renderer.testProjects = projects;
  vm.runInContext("state.projects=testProjects;state.selectedProjectId='a';state.assetReviewOpen=false;accountStatus={canUseWorkspace:true,identity:{id:'synthetic'}};", renderer);
  document.querySelector('#tab-current-project').classList.add('active');
  renderer.setupMainProcessListeners();
  return {
    document, elements, projects, renderer, updates,
    click: (projectId = 'b') => handler({ projectId }),
    selected: () => vm.runInContext('state.selectedProjectId', renderer),
    reviewOpen: () => vm.runInContext('state.assetReviewOpen', renderer) === true,
  };
}

test('notice click selects its project and opens Review Assets, without changing any row', async () => {
  const f = needsSaveNotificationFixture();
  await f.renderer.renderFiles();
  const rows = JSON.stringify(f.projects);
  await f.click('b');
  assert.equal(f.selected(), 'b');
  assert.equal(f.reviewOpen(), true);
  assert.equal(f.elements['asset-review-workspace'].classList.contains('hidden'), false);
  assert.equal(JSON.stringify(f.projects), rows);
});

test('notice click is ignored while a dialog is open, signed out, or when its project is gone or has no Needs Save rows', async () => {
  for (const modal of ['modal-package', 'modal-success', 'modal-existing-assets']) {
    const f = needsSaveNotificationFixture();
    await f.renderer.renderFiles();
    f.elements[modal].classList.remove('hidden');
    f.renderer.claimModalLease(modal);
    await f.click('b');
    assert.equal(f.selected(), 'a', modal);
    assert.equal(f.reviewOpen(), false, modal);
    assert.equal(f.elements[modal].classList.contains('hidden'), false, modal);
  }
  for (const [label, target, setup] of [
    ['signed out', 'b', f => vm.runInContext('accountStatus={canUseWorkspace:false,identity:null};', f.renderer)],
    ['project gone', 'missing', () => {}],
    ['no Needs Save rows', 'a', () => {}],
    ['only an Include or Exclude row', 'b', f => { f.projects[1].pendingFiles = [{ name: 'Maybe.png', path: '/synthetic/Maybe.png', captureState: 'pending' }]; }],
  ]) {
    const f = needsSaveNotificationFixture();
    await f.renderer.renderFiles();
    setup(f);
    await f.click(target);
    assert.equal(f.selected(), 'a', label);
    assert.equal(f.reviewOpen(), false, label);
  }
});

test('a delayed notice click does not open Review Assets after a newer tab choice or after the last Needs Save row saves', async () => {
  for (const change of ['projects tab', 'rows saved']) {
    const f = needsSaveNotificationFixture();
    await f.renderer.renderFiles();
    const bridge = f.renderer.window.crate;
    const original = bridge.getAssetWorkspace;
    let release;
    const held = new Promise(resolve => { release = resolve; });
    bridge.getAssetWorkspace = async projectId => { await held; return original(projectId); };
    const clicking = f.click('b');
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    if (change === 'projects tab') f.renderer.switchTab('projects');
    else vm.runInContext("state.projects.find(item => item.id === 'b').pendingFiles = [];", f.renderer);
    release();
    await clicking;
    assert.equal(f.reviewOpen(), false, change);
  }
});

test('Settings: "Assets need save" switch follows Existing assets, defaults on and saves its value', async () => {
  const existing = html.indexOf('id="toggle-existing-assets-notifications"');
  const needsSave = html.indexOf('id="toggle-needs-save-notifications"');
  assert.ok(existing > 0 && needsSave > existing, 'the switch sits after "Existing assets need review"');
  assert.match(html, /id="setting-needs-save-notifications-label">Assets need save \(requires Package Alerts\)<\/div>/);
  assert.match(html, /<input type="checkbox" id="toggle-needs-save-notifications" aria-labelledby="setting-needs-save-notifications-label">/);
  const f = needsSaveNotificationFixture();
  f.renderer.setupEventListeners();
  for (const [settings, checked] of [[{}, true], [{ needsSaveNotifications: true }, true], [{ needsSaveNotifications: false }, false]]) {
    f.renderer.testSettings = settings;
    vm.runInContext('state.settings = testSettings; renderSettingsControls();', f.renderer);
    assert.equal(f.elements['toggle-needs-save-notifications'].checked, checked, JSON.stringify(settings));
  }
  f.elements['toggle-needs-save-notifications'].checked = false;
  await f.elements['toggle-needs-save-notifications'].dispatchEvent({ type: 'change' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(f.updates.at(-1), ['needsSaveNotifications', false]);
});
