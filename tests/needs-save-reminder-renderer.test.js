'use strict';
// Executes the production renderer against the repository's modeled DOM with
// synthetic projects and bridge responses. This is source/UI evidence only, not
// installed-app, native-app or visual acceptance.
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
const tick = (ms = 70) => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

// Raw store rows carry synthetic paths; presentations never do.
function rawRow(projectId, name, captureState = 'needs-save', extra = {}) {
  return { path: `/synthetic/${projectId}/${name}`, name, ext: path.extname(name), source: 'indd-poll', captureState,
    captureEvidence: { appFamily: 'indesign', sourceName: 'Brochure.indd' }, ...extra };
}
function presented(projectId, name, sourceIndex, extra = {}) {
  return { name, ext: path.extname(name), appFamily: 'indesign', sourceName: 'Brochure.indd', protectedSource: false,
    excluded: false, visualIdentity: `vis-${projectId}-${name}`, visualRevision: `rev-${name}`, sourceIndex, ...extra };
}
const needsSave = (projectId, name, index, app = 'indesign', sourceName = 'Brochure.indd') =>
  presented(projectId, name, index, { sourceSaveRequired: true, sourceSaveAppFamily: app, sourceName, sourceSaveSourceName: sourceName });

class FakeDate extends Date {
  static current = 1_000_000;
  static now() { return FakeDate.current; }
}

async function fixture({ status = 'watching' } = {}) {
  const dom = scope.createInteractiveRendererDom();
  // Mirror the static index.html structure the modeled DOM does not parse.
  const node = id => dom.document.getElementById(id);
  for (const id of ['needs-save-reminder-title', 'needs-save-reminder-detail', 'btn-needs-save-review', 'btn-needs-save-dismiss']) node('needs-save-reminder').appendChild(node(id));
  for (const id of ['pending-save-guidance-title', 'pending-save-guidance-detail']) node('pending-save-guidance').appendChild(node(id));
  for (const id of ['needs-save-reminder', 'pending-save-guidance']) node(id).classList.add('hidden');
  const projects = ['a', 'b'].map(id => ({ id, name: `Project ${id}`, status, files: [], pendingFiles: [], excludedAssetKeys: [] }));
  const workspaces = new Map(projects.map(project => [project.id, { projectId: project.id, files: [], pendingFiles: [] }]));
  let nextRead = null, failReads = false;
  const renderer = scope.loadRendererHelpers(dom.document, { crate: {
    getSettings: async () => ({}), getFigmaStatus: async () => ({}),
    getAssetWorkspace: async id => {
      if (failReads) throw new Error('synthetic workspace unavailable');
      if (nextRead) { const read = nextRead; nextRead = null; return read.promise; }
      return clone(workspaces.get(id));
    },
  } }, { Date: FakeDate });
  renderer.testProjects = projects;
  vm.runInContext("state.projects=testProjects; setSelectedProject('a'); accountStatus={revision:1,state:'signed_in',canUseWorkspace:true,identity:{id:'A'}};", renderer);
  renderer.setupEventListeners();
  await renderer.switchTab('current-project');
  const el = id => dom.document.getElementById(id);
  const evaluate = code => vm.runInContext(code, renderer);
  const set = (projectId, rows, pending) => {
    const project = projects.find(item => item.id === projectId);
    project.pendingFiles = rows;
    workspaces.set(projectId, { projectId, files: [], pendingFiles: pending });
  };
  return {
    ...dom, renderer, projects, workspaces, el, evaluate, set,
    refresh: () => renderer.renderFiles(),
    visible: () => !el('needs-save-reminder').classList.contains('hidden'),
    guidanceVisible: () => !el('pending-save-guidance').classList.contains('hidden'),
    reminderText: () => `${el('needs-save-reminder-title').textContent} ${el('needs-save-reminder-detail').textContent}`,
    guidanceText: () => `${el('pending-save-guidance-title').textContent} ${el('pending-save-guidance-detail').textContent}`,
    status: () => el('needs-save-reminder-status').textContent,
    deferRead() { const read = deferred(); nextRead = read; return read; },
    failReads(value) { failReads = value; },
  };
}

test('genuine Needs Save shows one in-app reminder plus Review Assets guidance without paths', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg'), rawRow('a', 'logo.png')], [needsSave('a', 'hero.jpg', 0), needsSave('a', 'logo.png', 1)]);
  await f.refresh();
  assert.equal(f.visible(), true);
  assert.equal(f.reminderText(), 'Save your file to include these assets Save your changes in InDesign, then return to Crate so it can check them.');
  assert.equal(f.guidanceVisible(), true);
  assert.equal(f.guidanceText(), 'Save your file to include these assets Unsaved changes in Brochure.indd. Save your changes in InDesign, then return to Crate. When Crate can check the saved file, it moves the assets it confirms out of Needs Review.');
  await tick();
  assert.equal(f.status(), 'Save your file to include these assets. Save your changes in InDesign, then return to Crate so it can check them.');
  assert.equal(f.el('needs-save-reminder').contains(f.document.activeElement), false, 'showing never moves focus');
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const markup = html.slice(html.indexOf('id="needs-save-reminder-status"') - 40, html.indexOf('id="btn-needs-save-dismiss"') + 120);
  assert.match(markup, /<p id="needs-save-reminder-status" class="sr-only" role="status" aria-live="polite" aria-atomic="true"><\/p>/);
  assert.match(markup, /id="needs-save-reminder" class="needs-save-reminder hidden" role="region" aria-labelledby="needs-save-reminder-title"/);
  assert.equal(/aria-modal|role="dialog"|role="alert"/.test(markup), false, 'a polite, non-modal notice');
  assert.match(markup, /id="btn-needs-save-dismiss" aria-label="Dismiss save reminder"/);
  assert.ok(html.indexOf('id="needs-save-reminder"') > html.indexOf('id="app-main"') &&
    html.indexOf('id="needs-save-reminder"') < html.indexOf('</main>'), 'inside app-main so blocking modals make it inert');
  for (const text of [f.reminderText(), f.guidanceText(), f.status()]) {
    assert.equal(text.includes('/synthetic'), false);
    assert.equal(text.includes('Project a'), false);
  }
  // The overall Needs Review category keeps its name.
  assert.equal(f.evaluate("getPendingCaptureState(state.projects[0].pendingFiles[0])"), 'needs-save');
});

test('timeouts, unsupported, missing, general review, excluded and display-only data never trigger', async () => {
  const f = await fixture();
  f.set('a', [
    rawRow('a', 'photoshop-link.png', 'needs-save', { source: 'ps-poll' }),
    rawRow('a', 'general.png', 'pending'),
    rawRow('a', 'flag-on-general.png', 'pending'),
    rawRow('a', 'excluded.png'),
    rawRow('a', 'timeout.png'),
  ], [
    presented('a', 'photoshop-link.png', 0, { appFamily: 'photoshop' }),
    presented('a', 'general.png', 1),
    presented('a', 'flag-on-general.png', 2, { sourceSaveRequired: true, sourceSaveAppFamily: 'indesign' }),
    needsSave('a', 'excluded.png', 3, 'indesign', 'Brochure.indd'),
    presented('a', 'timeout.png', 4),
  ]);
  f.workspaces.get('a').pendingFiles[3].excluded = true;
  await f.refresh();
  assert.equal(f.visible(), false);
  assert.equal(f.guidanceVisible(), false);
  assert.equal(f.status(), '');
  // A raw record cannot supply the flag when the authoritative workspace is unavailable.
  f.set('a', [rawRow('a', 'raw-flag.png', 'needs-save', { sourceSaveRequired: true, sourceSaveAppFamily: 'indesign' })], []);
  f.failReads(true);
  await f.refresh();
  assert.equal(f.visible(), false);
  assert.equal(f.guidanceVisible(), false);
});

test('mixed states, multiple files and apps, and unknown app names stay accurate', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'ai-link.png'), rawRow('a', 'indd-link.png'), rawRow('a', 'review.png', 'pending')], [
    needsSave('a', 'ai-link.png', 0, 'illustrator', 'Poster.ai'),
    needsSave('a', 'indd-link.png', 1, 'indesign', 'Brochure.indd'),
    presented('a', 'review.png', 2),
  ]);
  await f.refresh();
  assert.equal(f.reminderText(), 'Save your files to include these assets Save your changes in Illustrator and InDesign, then return to Crate so it can check them.');
  assert.match(f.guidanceText(), /Unsaved changes in 2 files\./);
  const copy = items => f.renderer.getSourceSaveCopy(f.projects[0], items);
  assert.equal(copy([{ sourceSaveAppFamily: 'mystery-app', sourceSaveSourceName: 'X.doc' }]).reminder, 'Save your changes in the app, then return to Crate so it can check them.');
  assert.equal(copy([{ sourceSaveAppFamily: 'illustrator' }, { sourceSaveAppFamily: 'indesign' }, { sourceSaveAppFamily: 'photoshop' }]).reminder,
    'Save your changes in each app, then return to Crate so it can check them.');
  assert.equal(copy([{ sourceSaveAppFamily: 'illustrator', sourceSaveSourceName: 'Poster.ai' }]).title, 'Save your file to include this asset');
  assert.equal(copy([{ sourceSaveAppFamily: 'illustrator', sourceSaveSourceName: '/private/Poster.ai' }]).guidance.includes('/private'), false);
  // Without a name from the qualifying observation, never fall back to the row's first source.
  const unnamed = copy([{ sourceSaveAppFamily: 'illustrator', sourceName: 'Poster A.ai' }, { sourceSaveAppFamily: 'illustrator', sourceSaveSourceName: 'Poster B.ai' }]);
  assert.equal(unnamed.guidance.includes('Poster A.ai'), false);
  assert.equal(unnamed.guidance.includes('Poster B.ai'), false, 'one name cannot speak for an unnamed item');
  assert.match(unnamed.guidance, /^Unsaved changes found\./);
  assert.equal(unnamed.title, 'Save your changes to include these assets');
});

test('repeated refreshes do not repeat it; dismissal and Escape stick until a genuinely new change', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await f.refresh();
  assert.equal(f.visible(), true);
  f.el('btn-needs-save-dismiss').click();
  assert.equal(f.visible(), false);
  for (let i = 0; i < 3; i++) await f.refresh();
  assert.equal(f.visible(), false, 'repeated watcher refreshes stay quiet after dismissal');
  assert.equal(f.guidanceVisible(), true, 'Review Assets guidance remains while the save is still needed');

  // A new link arriving inside the cooldown updates guidance but stays quiet.
  FakeDate.current += 30_000;
  f.set('a', [rawRow('a', 'hero.jpg'), rawRow('a', 'new.jpg')], [needsSave('a', 'hero.jpg', 0), needsSave('a', 'new.jpg', 1)]);
  await f.refresh();
  assert.equal(f.visible(), false);
  // After the cooldown another genuinely new item re-arms it.
  FakeDate.current += 3 * 60_000;
  f.set('a', [rawRow('a', 'hero.jpg'), rawRow('a', 'new.jpg'), rawRow('a', 'third.jpg')],
    [needsSave('a', 'hero.jpg', 0), needsSave('a', 'new.jpg', 1), needsSave('a', 'third.jpg', 2)]);
  await f.refresh();
  assert.equal(f.visible(), true);

  // Escape from inside the reminder dismisses and returns focus to a visible control.
  f.el('btn-needs-save-review').focus();
  assert.equal(f.el('needs-save-reminder').contains(f.document.activeElement), true);
  let prevented = false;
  f.document.listeners.keydown({ type: 'keydown', key: 'Escape', target: f.document.activeElement, defaultPrevented: false, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(f.visible(), false);
  assert.equal(f.el('needs-save-reminder').contains(f.document.activeElement), false);
  await f.refresh();
  assert.equal(f.visible(), false);
});

test('links arriving during an active scan update a visible reminder and re-announce once', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await f.refresh();
  await tick();
  assert.match(f.reminderText(), /this asset/);
  f.set('a', [rawRow('a', 'hero.jpg'), rawRow('a', 'new.jpg')], [needsSave('a', 'hero.jpg', 0), needsSave('a', 'new.jpg', 1)]);
  await f.refresh();
  assert.equal(f.visible(), true);
  assert.match(f.reminderText(), /these assets/);
  assert.equal(f.status(), '', 'cleared before re-announcing');
  await tick();
  assert.match(f.status(), /these assets/);
  await f.refresh();
  assert.match(f.status(), /these assets/, 'an unchanged refresh does not re-announce');
});

test('a successful save clears it; failed verification keeps or drops it only by evidence; re-entry re-arms', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await f.refresh();
  assert.equal(f.visible(), true);
  // Save failed: the app still reports unsaved changes. Nothing new is announced.
  await f.refresh();
  assert.equal(f.visible(), true);
  // Saved, but saved-file verification has not confirmed the link: still Needs Save,
  // no longer an unsaved-document observation, so no save request remains.
  f.set('a', [rawRow('a', 'hero.jpg')], [presented('a', 'hero.jpg', 0)]);
  await f.refresh();
  assert.equal(f.visible(), false);
  assert.equal(f.guidanceVisible(), false);
  assert.equal(f.evaluate("getPendingCaptureState(state.projects[0].pendingFiles[0])"), 'needs-save', 'row keeps its existing badge');
  // Verified and moved out of Needs Review.
  f.set('a', [], []);
  await f.refresh();
  assert.equal(f.visible(), false);
  // A later genuinely new unsaved change to the same item re-arms after the cooldown.
  FakeDate.current += 3 * 60_000;
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await f.refresh();
  assert.equal(f.visible(), true);
});

test('project switching, reopening a project, paused copy and stale overlapping reads', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  f.set('b', [rawRow('b', 'cover.jpg')], [needsSave('b', 'cover.jpg', 0, 'illustrator', 'Cover.ai')]);
  await f.refresh();
  assert.match(f.reminderText(), /InDesign/);
  f.evaluate("setSelectedProject('b')");
  assert.equal(f.visible(), false, 'switching projects hides the other project reminder');
  await f.refresh();
  assert.match(f.reminderText(), /Illustrator/);
  f.el('btn-needs-save-dismiss').click();
  f.evaluate("setSelectedProject('a')");
  await f.refresh();
  assert.equal(f.visible(), false, 'returning to a project does not repeat an already shown reminder');

  // A delayed read for the previous project cannot surface after a switch.
  FakeDate.current += 3 * 60_000;
  f.set('a', [rawRow('a', 'hero.jpg'), rawRow('a', 'late.jpg')], [needsSave('a', 'hero.jpg', 0), needsSave('a', 'late.jpg', 1)]);
  const stale = f.deferRead();
  const pending = f.refresh();
  f.evaluate("setSelectedProject('b')");
  f.set('b', [], []);
  await f.refresh();
  stale.resolve(clone(f.workspaces.get('a')));
  await pending;
  assert.equal(f.visible(), false);

  // Paused projects say how Crate will check the save.
  f.projects[1].status = 'paused';
  f.set('b', [rawRow('b', 'new-cover.jpg')], [needsSave('b', 'new-cover.jpg', 0, 'illustrator', 'Cover.ai')]);
  await f.refresh();
  assert.equal(f.reminderText(), 'Save your file to include this asset Save your changes in Illustrator, then resume watching so Crate can check them.');
  assert.match(f.guidanceText(), /Crate checks saved files only while watching\./);
});

test('modals defer it, account changes reset it, and Review opens Needs Review', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  f.el('modal-upgrade').classList.remove('hidden');
  await f.refresh();
  assert.equal(f.visible(), false, 'no announcement under a blocking modal');
  f.el('modal-upgrade').classList.add('hidden');
  await f.refresh();
  assert.equal(f.visible(), true, 'deferred items are still unseen after the modal closes');

  f.evaluate("acceptAccountSnapshot({revision:2,state:'signed_in',canUseWorkspace:true,identity:{id:'B'}})");
  assert.equal(f.visible(), false, 'account change hides and resets reminder state');
  assert.equal(f.evaluate('needsSaveReminder.projects.size'), 0);

  await f.refresh();
  assert.equal(f.visible(), true);
  await f.renderer.switchTab('settings');
  f.el('btn-needs-save-review').click();
  await tick(10);
  assert.equal(f.visible(), false);
  assert.equal(f.evaluate('state.assetReviewFilter'), 'missing');
  assert.equal(f.evaluate('state.assetReviewOpen'), true);
  assert.equal(f.evaluate("isTabActive('current-project')"), true);
});


test('guidance names only the document from the qualifying observation', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.png')], [presented('a', 'hero.png', 0, { sourceName: 'Poster A.ai',
    sourceSaveRequired: true, sourceSaveAppFamily: 'illustrator', sourceSaveSourceName: 'Draft B.ai' })]);
  await f.refresh();
  assert.match(f.guidanceText(), /Unsaved changes in Draft B\.ai\./);
  assert.equal(f.guidanceText().includes('Poster A.ai'), false);
});

test('an item flagged during the cooldown still pops up once the cooldown ends', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await f.refresh();
  f.el('btn-needs-save-dismiss').click();
  // Saved, then flagged again inside the cooldown.
  f.set('a', [], []);
  await f.refresh();
  FakeDate.current += 20_000;
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await f.refresh();
  assert.equal(f.visible(), false, 'quiet during the cooldown');
  assert.notEqual(f.evaluate('needsSaveReminder.recheckTimer'), null, 'a re-check is scheduled for the end of the cooldown');
  FakeDate.current += 2 * 60_000;
  f.renderer.resumeNeedsSaveReminder();
  assert.equal(f.visible(), true, 'the timer re-check shows it without a new watcher event');
  f.el('btn-needs-save-dismiss').click();
  // An ordinary refresh after the cooldown also shows an item left unseen.
  f.set('a', [], []);
  await f.refresh();
  FakeDate.current += 10_000;
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await f.refresh();
  assert.equal(f.visible(), false);
  FakeDate.current += 3 * 60_000;
  await f.refresh();
  assert.equal(f.visible(), true);
});

test('closing a modal resumes a deferred reminder without another refresh', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  f.el('modal-upgrade').classList.remove('hidden');
  await f.refresh();
  assert.equal(f.visible(), false);
  f.renderer.hidePackageLimitModal({ restoreFocus: false });
  await tick(10);
  assert.equal(f.visible(), true);
  await tick();
  assert.match(f.status(), /this asset/);
});

test('items arriving behind a modal while the reminder is visible are announced after it closes', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await f.refresh();
  await tick();
  f.el('modal-upgrade').classList.remove('hidden');
  f.set('a', [rawRow('a', 'hero.jpg'), rawRow('a', 'new.jpg')], [needsSave('a', 'hero.jpg', 0), needsSave('a', 'new.jpg', 1)]);
  await f.refresh();
  await tick();
  assert.equal(f.evaluate("needsSaveReminder.projects.get('a').seen.has('vis-a-new.jpg')"), false, 'not consumed while inert');
  assert.match(f.status(), /this asset/, 'no announcement into the inert region');
  f.renderer.hidePackageLimitModal({ restoreFocus: false });
  await tick(10);
  await tick();
  assert.match(f.status(), /these assets/);
});

test('a delayed announcement speaks the latest copy, not a superseded one', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'ai.png'), rawRow('a', 'indd.png')],
    [needsSave('a', 'ai.png', 0, 'illustrator', 'Poster.ai'), needsSave('a', 'indd.png', 1, 'indesign', 'Brochure.indd')]);
  await f.refresh();
  f.set('a', [rawRow('a', 'indd.png')], [needsSave('a', 'indd.png', 1 - 1, 'indesign', 'Brochure.indd')]);
  await f.refresh();
  await tick();
  assert.equal(f.status(), 'Save your file to include this asset. Save your changes in InDesign, then return to Crate so it can check them.');
  f.el('btn-needs-save-dismiss').click();
  await tick();
  assert.equal(f.status(), '');
});

test('Escape outside the reminder dismisses it except while typing or under a modal', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await f.refresh();
  const escape = target => {
    const event = { type: 'keydown', key: 'Escape', target, defaultPrevented: false, prevented: false };
    event.preventDefault = () => { event.prevented = true; };
    f.document.listeners.keydown(event);
    return event;
  };
  const search = f.el('asset-review-search');
  search.closest = selector => selector.includes('input') ? search : null;
  assert.equal(escape(search).prevented, false);
  assert.equal(f.visible(), true, 'Escape in a text field is left to that field');
  f.el('modal-upgrade').classList.remove('hidden');
  assert.equal(escape(f.document.body).prevented, false);
  assert.equal(f.visible(), true, 'modals own Escape');
  f.el('modal-upgrade').classList.add('hidden');
  assert.equal(escape(f.document.body).prevented, true);
  assert.equal(f.visible(), false);
});
