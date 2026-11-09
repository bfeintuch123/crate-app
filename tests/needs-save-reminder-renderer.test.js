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
  const heldReads = [];
  let failReads = false, pauseGate = null;
  const longTimers = [];
  const timerOverrides = {
    setTimeout: (fn, ms, ...args) => {
      if (ms < 60_000) return setTimeout(fn, ms, ...args);
      const timer = { fn, ms, cancelled: false };
      longTimers.push(timer);
      return timer;
    },
    clearTimeout: timer => (longTimers.includes(timer) ? (timer.cancelled = true) : clearTimeout(timer)),
  };
  const renderer = scope.loadRendererHelpers(dom.document, { crate: {
    getSettings: async () => ({}), getFigmaStatus: async () => ({}),
    // Real watch/pause bridges: the Projects pill replaces state.projects from getProjects.
    pauseProject: async id => {
      if (pauseGate) await pauseGate.promise;
      projects.find(item => item.id === id).status = 'paused';
    },
    // Mirrors main's activateSingleWatchingProject: starting one pauses any other.
    startWatching: async id => {
      for (const item of projects) item.status = item.id === id ? 'watching' : item.status === 'watching' ? 'paused' : item.status;
    },
    getProjects: async () => clone(projects),
    getAssetWorkspace: async id => {
      if (failReads) throw new Error('synthetic workspace unavailable');
      if (heldReads.length) return heldReads.shift().promise;
      return clone(workspaces.get(id));
    },
  } }, { Date: FakeDate, ...timerOverrides });
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
    deferRead() { const read = deferred(); heldReads.push(read); return read; },
    gatePause() { pauseGate = deferred(); return pauseGate; },
    fireLongTimers() { for (const timer of longTimers.splice(0)) if (!timer.cancelled) timer.fn(); },
    pendingLongTimers: () => longTimers.filter(timer => !timer.cancelled).length,
    failReads(value) { failReads = value; },
  };
}

test('genuine Needs Save shows one in-app reminder plus Review Assets guidance without paths', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg'), rawRow('a', 'logo.png')], [needsSave('a', 'hero.jpg', 0), needsSave('a', 'logo.png', 1)]);
  await f.refresh();
  assert.equal(f.visible(), true);
  assert.equal(f.reminderText(), STABLE_WATCHING);
  assert.equal(f.guidanceVisible(), true);
  assert.equal(f.guidanceText(), 'Save your file to include these assets Unsaved changes in Brochure.indd. Save your changes in InDesign, then return to Crate so it can check them.');
  await tick();
  assert.equal(f.status(), spoken(STABLE_WATCHING));
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
  assert.equal(f.reminderText(), STABLE_WATCHING, 'the reminder makes no count, document or app claim');
  assert.match(f.guidanceText(), /Unsaved changes in 2 files\./);
  const copy = items => f.renderer.getSourceSaveCopy(f.projects[0], items);
  assert.match(copy([{ sourceSaveAppFamily: 'mystery-app', sourceSaveSourceName: 'X.doc' }]).guidance, /Save your changes in the app, then return to Crate so it can check them\./);
  assert.match(copy([{ sourceSaveAppFamily: 'illustrator' }, { sourceSaveAppFamily: 'indesign' }, { sourceSaveAppFamily: 'photoshop' }]).guidance,
    /Save your changes in each app, then return to Crate so it can check them\./);
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

test('links arriving during an active scan keep the visible reminder steady and update the note', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await f.refresh();
  await tick();
  assert.match(f.guidanceText(), /this asset/);
  f.set('a', [rawRow('a', 'hero.jpg'), rawRow('a', 'new.jpg')], [needsSave('a', 'hero.jpg', 0), needsSave('a', 'new.jpg', 1)]);
  await f.refresh();
  assert.equal(f.visible(), true);
  assert.equal(f.reminderText(), STABLE_WATCHING);
  assert.match(f.guidanceText(), /these assets/);
  assert.equal(f.status(), spoken(STABLE_WATCHING), 'never cleared for identical text');
  await tick();
  assert.equal(f.status(), spoken(STABLE_WATCHING));
  await f.refresh();
  assert.equal(f.status(), spoken(STABLE_WATCHING), 'an unchanged refresh does not re-announce');
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
  assert.match(f.guidanceText(), /InDesign/);
  f.evaluate("setSelectedProject('b')");
  assert.equal(f.visible(), false, 'switching projects hides the other project reminder');
  await f.refresh();
  assert.match(f.guidanceText(), /Illustrator/);
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
  assert.equal(f.reminderText(), STABLE_PAUSED);
  assert.equal(f.guidanceText(), 'Save your file to include this asset Unsaved changes in Cover.ai. Save your changes in Illustrator. Resume watching so Crate can check the saved files.');
});

test('a Projects watch/pause click never leaves stale status copy; fresh evidence restores it', async () => {
  const f = await fixture();
  const watchingCopy = STABLE_WATCHING;
  const pausedCopy = STABLE_PAUSED;
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await f.refresh();
  assert.equal(f.reminderText(), watchingCopy);
  const toggle = async (expectVisible = true) => {
    await f.renderer.switchTab('projects');
    assert.equal(f.visible(), expectVisible, 'the notice is app-wide, so it shows on Projects');
    f.el('project-rows').children[0].querySelector('.project-pill').click();
    await tick();
  };

  await toggle();
  assert.equal(f.evaluate('state.projects[0].status'), 'paused', 'the real click replaced project state');
  assert.equal(f.visible(), false, 'a watching-only request never outlives the project state it described');
  assert.equal(f.status(), '');
  await f.renderer.switchTab('current-project');
  assert.equal(f.visible(), true, 'still unsaved and never dismissed: restored despite the cooldown');
  assert.equal(f.reminderText(), pausedCopy);
  assert.equal(f.guidanceText(), 'Save your file to include this asset Unsaved changes in Brochure.indd. Save your changes in InDesign. Resume watching so Crate can check the saved files.');
  assert.equal(/only while watching/.test(f.guidanceText()), false, 'packaging also checks saved files');
  await tick();
  assert.equal(f.status(), spoken(STABLE_PAUSED));

  await toggle();
  assert.equal(f.evaluate('state.projects[0].status'), 'watching');
  assert.equal(f.visible(), false);
  await f.renderer.switchTab('current-project');
  assert.equal(f.reminderText(), watchingCopy);

  // A dismissal survives a toggle; the guidance still follows the new status.
  f.el('btn-needs-save-dismiss').click();
  assert.equal(f.visible(), false);
  await toggle(false);
  assert.equal(f.evaluate('state.projects[0].status'), 'paused');
  await f.renderer.switchTab('current-project');
  assert.equal(f.visible(), false, 'a dismissed reminder stays dismissed');
  assert.match(f.guidanceText(), /Resume watching so Crate can check the saved files\.$/);
});

test('starting another project from Projects suspends the selected project reminder it paused', async () => {
  const f = await fixture();
  f.projects[1].status = 'paused';
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await f.refresh();
  assert.match(f.reminderText(), /then return to Crate/);
  await f.renderer.switchTab('projects');
  f.el('project-rows').children[1].querySelector('.project-pill').click();
  await tick();
  assert.deepEqual(f.evaluate('state.projects.map(item => item.status)'), ['paused', 'watching'], 'starting b paused the selected project a');
  assert.equal(f.visible(), false, 'the selected project reminder never keeps copy for a superseded status');
  assert.equal(f.status(), '');
  await f.renderer.switchTab('current-project');
  assert.equal(f.visible(), true);
  assert.equal(f.reminderText(), STABLE_PAUSED);
});

test('starting another project that leaves the selected project unchanged keeps its reminder steady', async () => {
  const f = await fixture({ status: 'paused' });
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await f.refresh();
  await tick();
  assert.equal(f.reminderText(), STABLE_PAUSED);
  f.el('needs-save-reminder-status').textContent = 'spoken';
  await f.renderer.switchTab('projects');
  f.el('project-rows').children[1].querySelector('.project-pill').click();
  await tick();
  assert.deepEqual(f.evaluate('state.projects.map(item => item.status)'), ['paused', 'watching'], 'a was already paused');
  assert.equal(f.visible(), true, 'nothing about a changed, so its reminder stays');
  assert.equal(f.status(), 'spoken');
  await f.renderer.switchTab('current-project');
  await tick();
  assert.equal(f.visible(), true);
  assert.equal(f.status(), 'spoken', 'no repeat announcement of unchanged text');
});

test('a pause finishing after returning to Current Project updates the announced copy once', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await f.refresh();
  await tick();
  assert.equal(f.status(), spoken(STABLE_WATCHING));
  const gate = f.gatePause();
  await f.renderer.switchTab('projects');
  f.el('project-rows').children[0].querySelector('.project-pill').click();
  await f.renderer.switchTab('current-project');
  gate.resolve();
  await tick();
  assert.equal(f.evaluate('state.projects[0].status'), 'paused');
  const paused = spoken(STABLE_PAUSED);
  assert.equal(f.reminderText(), STABLE_PAUSED);
  assert.equal(f.status(), paused, 'the live region never keeps superseded copy');
  // An identical refresh does not re-announce.
  f.el('needs-save-reminder-status').textContent = 'spoken';
  await f.refresh();
  await tick();
  assert.equal(f.status(), 'spoken');
});

test('dismissing from another tab never moves focus to a control in the hidden workspace', async () => {
  for (const how of ['button', 'escape']) {
    const f = await fixture();
    f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
    await f.refresh();
    await f.renderer.switchTab('settings');
    assert.equal(f.visible(), true);
    f.el('btn-needs-save-dismiss').focus();
    if (how === 'button') f.el('btn-needs-save-dismiss').click();
    else f.document.listeners.keydown({ type: 'keydown', key: 'Escape', target: f.document.activeElement, defaultPrevented: false, preventDefault() {} });
    assert.equal(f.visible(), false, how);
    assert.notEqual(f.document.activeElement, f.el('btn-review-assets'), `${how}: Review Assets is not rendered on Settings`);
  }
});

// Stable save instruction: the reminder makes no count, document or app claim, so a
// bounded current-project refresh can never make it wrong; the rows and the Review
// Assets note keep naming documents from the same authoritative items.
const STABLE_WATCHING = 'Save your changes to include the affected assets Save your changes, then return to Crate so it can check them.';
const STABLE_PAUSED = 'Save your changes to include the affected assets Save your changes. Resume watching so Crate can check the saved files.';
const spoken = text => text.replace('assets Save', 'assets. Save');

test('the reminder is one stable instruction for any count, document or app; guidance keeps the names', async () => {
  for (const [rows, pending, guidance] of [
    [[rawRow('a', 'poster.png')], [needsSave('a', 'poster.png', 0, 'illustrator', 'Poster.ai')], /Unsaved changes in Poster\.ai\. Save your changes in Illustrator, then return to Crate so it can check them\./],
    [[rawRow('a', 'ai.png'), rawRow('a', 'indd.png')],
      [needsSave('a', 'ai.png', 0, 'illustrator', 'Poster.ai'), needsSave('a', 'indd.png', 1, 'indesign', 'Brochure.indd')], /Unsaved changes in 2 files\./],
    [[rawRow('a', 'x.png'), rawRow('a', 'y.png')],
      [needsSave('a', 'x.png', 0, 'illustrator', null), needsSave('a', 'y.png', 1, 'illustrator', 'Poster B.ai')], /^Save .* Unsaved changes found\./],
  ]) {
    const f = await fixture();
    f.set('a', rows, pending);
    await f.refresh();
    assert.equal(f.reminderText(), STABLE_WATCHING);
    assert.match(f.guidanceText(), guidance);
    await tick();
    assert.equal(f.status(), spoken(STABLE_WATCHING));
    for (const text of [f.reminderText(), f.status()]) assert.equal(/Illustrator|InDesign|Poster|Brochure|this asset|these assets|your file/.test(text), false, text);
  }
  const g = await fixture({ status: 'paused' });
  g.set('a', [rawRow('a', 'poster.png')], [needsSave('a', 'poster.png', 0, 'illustrator', 'Poster.ai')]);
  await g.refresh();
  assert.equal(g.reminderText(), STABLE_PAUSED);
  assert.equal(g.guidanceText().endsWith('Unsaved changes in Poster.ai. Save your changes in Illustrator. Resume watching so Crate can check the saved files.'), true);
  for (const text of [g.reminderText(), g.guidanceText()]) assert.equal(/only while watching/.test(text), false);
});

test('a new flagged item while the stable reminder is visible updates history without re-announcing', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await f.refresh();
  await tick();
  f.el('needs-save-reminder-status').textContent = 'spoken';
  f.set('a', [rawRow('a', 'hero.jpg'), rawRow('a', 'new.jpg')], [needsSave('a', 'hero.jpg', 0), needsSave('a', 'new.jpg', 1, 'illustrator', 'Poster.ai')]);
  await f.refresh();
  await tick();
  assert.equal(f.visible(), true);
  assert.equal(f.reminderText(), STABLE_WATCHING);
  assert.equal(f.status(), 'spoken', 'identical text is never spoken again');
  assert.equal(f.evaluate("needsSaveReminder.projects.get('a').seen.has('vis-a-new.jpg')"), true);
  assert.match(f.guidanceText(), /Unsaved changes in 2 files\./, 'the note follows the rows');
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
  assert.equal(f.pendingLongTimers(), 1, 'a re-check is scheduled for the end of the cooldown');
  FakeDate.current += 2 * 60_000;
  f.fireLongTimers();
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
  assert.equal(f.status(), spoken(STABLE_WATCHING));
});

test('any project-list replacement is checked against the reminder evidence in the same turn', async () => {
  // Raw assignments stand in for every replacement path (package review behind a modal,
  // Add All/Skip All, delete, Figma link edits, recovery): one rule covers them all.
  for (const variant of ['unchanged', 'saved', 'status', 'missing']) {
    const f = await fixture();
    f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
    await f.refresh();
    await tick();
    f.el('needs-save-reminder-status').textContent = 'spoken';
    f.el('modal-upgrade').classList.remove('hidden');
    const next = {
      unchanged: 'state.projects.map(project => ({ ...project }))',
      saved: "state.projects.map(project => project.id === 'a' ? { ...project, pendingFiles: [] } : { ...project })",
      status: "state.projects.map(project => project.id === 'a' ? { ...project, status: 'paused' } : { ...project })",
      missing: "state.projects.filter(project => project.id !== 'a')",
    }[variant];
    f.evaluate(`state.projects = ${next}`);
    const kept = variant === 'unchanged';
    assert.equal(f.visible(), kept, `${variant}: decided in the same turn`);
    assert.equal(f.guidanceVisible(), kept, variant);
    assert.equal(f.status(), kept ? 'spoken' : '', variant);
    f.renderer.hidePackageLimitModal({ restoreFocus: false });
    await tick(10);
    await tick();
    assert.equal(f.visible(), kept, `${variant}: an unrelated modal close changes nothing`);
    assert.equal(f.status(), kept ? 'spoken' : '', `${variant}: no repeat announcement`);
  }
});

test('suspending also withdraws the Review Assets save guidance until fresh evidence', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await f.refresh();
  assert.equal(f.guidanceVisible(), true);
  assert.match(f.guidanceText(), /return to Crate/);
  await f.renderer.switchTab('projects');
  f.el('project-rows').children[0].querySelector('.project-pill').click();
  await tick();
  assert.equal(f.guidanceVisible(), false, 'no watching guidance survives the pause');
  await f.renderer.switchTab('current-project');
  assert.equal(f.guidanceVisible(), true);
  assert.match(f.guidanceText(), /Resume watching so Crate can check the saved files\.$/);
});

test('items arriving behind a modal while the reminder is visible are recorded after it closes without repeating identical text', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await f.refresh();
  await tick();
  f.el('modal-upgrade').classList.remove('hidden');
  f.set('a', [rawRow('a', 'hero.jpg'), rawRow('a', 'new.jpg')], [needsSave('a', 'hero.jpg', 0), needsSave('a', 'new.jpg', 1)]);
  await f.refresh();
  await tick();
  assert.equal(f.evaluate("needsSaveReminder.projects.get('a').seen.has('vis-a-new.jpg')"), false, 'not consumed while inert');
  assert.equal(f.status(), spoken(STABLE_WATCHING), 'no announcement into the inert region');
  f.el('needs-save-reminder-status').textContent = 'spoken';
  f.renderer.hidePackageLimitModal({ restoreFocus: false });
  await tick(10);
  await tick();
  assert.equal(f.evaluate("needsSaveReminder.projects.get('a').seen.has('vis-a-new.jpg')"), true, 'recorded once usable');
  assert.equal(f.status(), 'spoken', 'identical text is not spoken again');
  assert.match(f.guidanceText(), /these assets/);
});

test('a delayed announcement speaks the latest copy, not a superseded one', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'ai.png'), rawRow('a', 'indd.png')],
    [needsSave('a', 'ai.png', 0, 'illustrator', 'Poster.ai'), needsSave('a', 'indd.png', 1, 'indesign', 'Brochure.indd')]);
  await f.refresh();
  f.set('a', [rawRow('a', 'indd.png')], [needsSave('a', 'indd.png', 1 - 1, 'indesign', 'Brochure.indd')]);
  await f.refresh();
  await tick();
  assert.equal(f.status(), spoken(STABLE_WATCHING));
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


test('an off-tab project refresh suspends a visible reminder until fresh authoritative data', async () => {
  for (const stillUnsaved of [false, true]) {
    const f = await fixture();
    f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
    await f.refresh();
    assert.equal(f.visible(), true);
    await f.renderer.switchTab('settings');
    // The live poll confirms the save (or not) while Settings is open.
    const next = f.projects.map(project => ({ ...project }));
    f.renderer.testNext = next;
    f.set('a', stillUnsaved ? [rawRow('a', 'hero.jpg')] : [], stillUnsaved ? [needsSave('a', 'hero.jpg', 0)] : []);
    next[0].pendingFiles = f.projects[0].pendingFiles;
    f.evaluate("applyProjectRefresh(testNext, projectRefreshGeneration, new Set(['a']), projectListReadEpoch)");
    assert.equal(f.visible(), false, 'no save request outlives the data it was based on');
    await f.renderer.switchTab('current-project');
    assert.equal(f.visible(), stillUnsaved, stillUnsaved ? 'still unsaved: shown again' : 'saved: stays hidden');
  }
});

test('an unavailable workspace read suspends the reminder without resolving or re-arming it', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await f.refresh();
  f.failReads(true);
  await f.refresh();
  assert.equal(f.visible(), false);
  assert.equal(f.guidanceVisible(), false);
  assert.equal(f.evaluate("needsSaveReminder.projects.get('a').seen.has('vis-a-hero.jpg')"), true, 'unavailable is not resolved');
  f.failReads(false);
  await f.refresh();
  assert.equal(f.visible(), true, 'restored inside the cooldown because it was never dismissed');
  // A dismissal survives an unavailable read.
  f.el('btn-needs-save-dismiss').click();
  f.failReads(true);
  await f.refresh();
  f.failReads(false);
  FakeDate.current += 3 * 60_000;
  await f.refresh();
  assert.equal(f.visible(), false);
});

test('a modal opening during the announcement delay announces once it closes', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await f.refresh();
  f.el('modal-upgrade').classList.remove('hidden');
  await tick();
  assert.equal(f.status(), '', 'nothing announced into the inert region');
  f.renderer.hidePackageLimitModal({ restoreFocus: false });
  await tick(10);
  await tick();
  assert.equal(f.status(), spoken(STABLE_WATCHING));
});

test('resume after a modal uses the current workspace even when it was replaced', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  f.el('modal-upgrade').classList.remove('hidden');
  await f.refresh();
  assert.equal(f.visible(), false);
  // Another read swaps the workspace object for the same project and selection.
  f.evaluate('state.assetWorkspace = JSON.parse(JSON.stringify(state.assetWorkspace))');
  f.renderer.hidePackageLimitModal({ restoreFocus: false });
  await tick(10);
  assert.equal(f.visible(), true);
});

test('a clean replacement workspace behind a modal also withdraws the save guidance on resume', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await f.refresh();
  assert.equal(f.guidanceVisible(), true);
  f.el('modal-upgrade').classList.remove('hidden');
  f.evaluate("state.assetWorkspace = { projectId: 'a', files: [], pendingFiles: [] }");
  f.renderer.hidePackageLimitModal({ restoreFocus: false });
  await tick(10);
  assert.equal(f.visible(), false);
  assert.equal(f.guidanceVisible(), false, 'guidance follows the same current evidence as the reminder');
});

test('project and account changes withdraw the previous save guidance before the next read', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await f.refresh();
  assert.equal(f.guidanceVisible(), true);
  const held = f.deferRead();
  f.evaluate("setSelectedProject('b')");
  const pending = f.refresh();
  assert.equal(f.guidanceVisible(), false, 'no guidance naming the previous project document');
  held.resolve(clone(f.workspaces.get('b')));
  await pending;

  const g = await fixture();
  g.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await g.refresh();
  assert.equal(g.guidanceVisible(), true);
  g.evaluate("acceptAccountSnapshot({revision:2,state:'signed_in',canUseWorkspace:true,identity:{id:'B'}})");
  assert.equal(g.guidanceVisible(), false, 'an account change never keeps the previous account guidance');
});

test('a Current Project refresh that leaves no unsaved rows retires the reminder before the read returns', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await f.refresh();
  await tick();
  assert.equal(f.visible(), true);
  const next = f.projects.map(project => ({ ...project }));
  next[0].pendingFiles = [];
  f.renderer.testNext = next;
  const held = f.deferRead();
  f.evaluate("applyProjectRefresh(testNext, projectRefreshGeneration, new Set(['a']), projectListReadEpoch)");
  assert.equal(f.visible(), false, 'the saved project no longer shows a save request');
  assert.equal(f.guidanceVisible(), false);
  assert.equal(f.status(), '');
  held.resolve({ projectId: 'a', files: [], pendingFiles: [] });
  await tick();
  assert.equal(f.visible(), false);
});

test('another project refresh that changes the selected project status re-checks it on Current Project', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await f.refresh();
  await tick();
  assert.match(f.reminderText(), /then return to Crate/);
  const next = f.projects.map(project => ({ ...project }));
  next[0].status = 'paused';
  next[1].status = 'watching';
  f.renderer.testNext = next;
  const held = f.deferRead();
  f.evaluate("applyProjectRefresh(testNext, projectRefreshGeneration, new Set(['b']), projectListReadEpoch)");
  assert.equal(f.visible(), false, 'no watching copy for a project that is now paused');
  assert.equal(f.status(), '');
  held.resolve(clone(f.workspaces.get('a')));
  await tick();
  assert.equal(f.visible(), true, 'still unsaved: restored from the fresh read');
  assert.equal(f.reminderText(), STABLE_PAUSED);
  assert.equal(f.status(), spoken(STABLE_PAUSED));
});

test('an unchanged Current Project refresh during a scan updates the reminder in place without re-announcing', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await f.refresh();
  await tick();
  f.el('needs-save-reminder-status').textContent = 'spoken';
  f.renderer.testNext = f.projects.map(project => ({ ...project }));
  f.evaluate("applyProjectRefresh(testNext, projectRefreshGeneration, new Set(['a']), projectListReadEpoch)");
  assert.equal(f.visible(), true, 'no flicker for unchanged evidence');
  await tick();
  assert.equal(f.visible(), true);
  assert.equal(f.status(), 'spoken', 'no repeat announcement');
});

test('a flagged row names the same document as the save guidance', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.png')], [presented('a', 'hero.png', 0, { sourceName: 'Poster A.ai',
    sourceSaveRequired: true, sourceSaveAppFamily: 'illustrator', sourceSaveSourceName: 'Draft B.ai' })]);
  await f.refresh();
  const reason = f.evaluate('getPendingFileReason(composePendingReviewFiles(state.projects[0], state.assetWorkspace.pendingFiles)[0])');
  assert.equal(reason.includes('Draft B.ai'), true);
  assert.equal(reason.includes('Poster A.ai'), false);
  // Unflagged Needs Save rows keep their existing copy.
  assert.equal(f.evaluate("getPendingFileReason({ captureState: 'needs-save', captureEvidence: { sourceName: 'Poster A.ai' } })"),
    'Linked asset observed from Poster A.ai. Save to make package-ready.');
});

// The reasons actually rendered in the Needs Review list (retained rows included).
function renderedReasons(f) {
  const out = [];
  const walk = node => {
    if (!node) return;
    if (typeof node.className === 'string' && node.className.split(/\s+/).includes('pending-file-reason')) out.push(node.textContent);
    for (const child of node.children || []) walk(child);
  };
  walk(f.el('pending-file-list'));
  return out;
}

test('a retained row redraws its save reason when the qualifying observation changes or clears', async () => {
  const f = await fixture();
  const flagged = name => presented('a', 'hero.png', 0, { sourceSaveRequired: true, sourceSaveAppFamily: 'indesign', sourceSaveSourceName: name });
  f.set('a', [rawRow('a', 'hero.png')], [flagged('Poster A.indd')]);
  await f.refresh();
  assert.deepEqual(renderedReasons(f), ['Unsaved changes in Poster A.indd. Save your changes so Crate can check it.']);
  f.set('a', [rawRow('a', 'hero.png')], [flagged('Draft B.indd')]);
  await f.refresh();
  assert.deepEqual(renderedReasons(f), ['Unsaved changes in Draft B.indd. Save your changes so Crate can check it.'], 'no superseded document name');
  f.set('a', [rawRow('a', 'hero.png')], [presented('a', 'hero.png', 0)]);
  await f.refresh();
  assert.equal(renderedReasons(f).some(text => /Unsaved changes/.test(text)), false, 'no unsaved claim after the flag clears');
  assert.equal(f.guidanceVisible(), false);
});

test('Add Files reconciliation that leaves nothing unsaved withdraws the reminder before its read returns', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await f.refresh();
  await tick();
  assert.equal(f.visible(), true);
  f.set('a', [], []);
  const held = f.deferRead();
  f.evaluate("activeAddFilesOperation = { projectId: 'a' }; testReconcile = reconcileAddFilesRendererState(activeAddFilesOperation, projectSelectionEpoch, projectSelectionIntentEpoch)");
  await tick(5);
  assert.equal(f.evaluate('state.projects[0].pendingFiles.length'), 0, 'the new snapshot is installed');
  assert.equal(f.visible(), false, 'no save request outlives the snapshot that contradicts it');
  assert.equal(f.guidanceVisible(), false);
  assert.equal(f.status(), '');
  held.resolve({ projectId: 'a', files: [], pendingFiles: [] });
  await tick();
  assert.equal(f.visible(), false);
});

test('Add Files reconciliation with the same unsaved evidence keeps the reminder steady', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await f.refresh();
  await tick();
  f.el('needs-save-reminder-status').textContent = 'spoken';
  const held = f.deferRead();
  f.evaluate("activeAddFilesOperation = { projectId: 'a' }; testReconcile = reconcileAddFilesRendererState(activeAddFilesOperation, projectSelectionEpoch, projectSelectionIntentEpoch)");
  await tick(5);
  assert.equal(f.visible(), true, 'bounded current-project refresh: no hide');
  held.resolve(clone(f.workspaces.get('a')));
  await tick();
  assert.equal(f.visible(), true);
  assert.equal(f.status(), 'spoken');
});

test('save guidance never promises that saving moves Illustrator links out of Needs Review', async () => {
  for (const [app, file] of [['illustrator', 'Poster.ai'], ['indesign', 'Brochure.indd']]) {
    const f = await fixture();
    f.set('a', [rawRow('a', 'hero.png')], [needsSave('a', 'hero.png', 0, app, file)]);
    await f.refresh();
    const label = app === 'illustrator' ? 'Illustrator' : 'InDesign';
    assert.equal(f.guidanceText(), `Save your file to include this asset Unsaved changes in ${file}. Save your changes in ${label}, then return to Crate so it can check them.`);
    assert.equal(/out of Needs Review|moves the assets/.test(f.guidanceText()), false);
  }
});

test('an unchanged selected project replaced by another project update survives an unrelated modal close', async () => {
  for (const via of ['pill', 'refresh']) {
    const f = await fixture({ status: 'paused' });
    f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
    await f.refresh();
    await tick();
    f.el('needs-save-reminder-status').textContent = 'spoken';
    if (via === 'pill') {
      await f.renderer.switchTab('projects');
      f.el('project-rows').children[1].querySelector('.project-pill').click();
      await tick();
      // Stay on Projects: no Current Project render rebinds the reminder before the modal closes.
    } else {
      f.renderer.testNext = f.projects.map(project => ({ ...project }));
      f.evaluate("applyProjectRefresh(testNext, projectRefreshGeneration, new Set(['b']), projectListReadEpoch)");
    }
    assert.notEqual(f.evaluate("state.projects.find(item => item.id === 'a')"), f.projects[0], `${via}: a's object was replaced`);
    assert.equal(f.visible(), true, via);
    // An unrelated modal opens and closes; nothing about a changed.
    f.el('modal-upgrade').classList.remove('hidden');
    f.renderer.hidePackageLimitModal({ restoreFocus: false });
    await tick(10);
    await tick();
    assert.equal(f.visible(), true, `${via}: proven-unchanged evidence is not withdrawn`);
    assert.equal(f.guidanceVisible(), true, via);
    assert.equal(f.status(), 'spoken', `${via}: no repeat announcement`);
    await f.renderer.switchTab('current-project');
    await tick();
    assert.equal(f.visible(), true, via);
    assert.equal(f.status(), 'spoken', `${via}: still no repeat announcement after the next read`);
  }
});

test('a flagged row without a usable qualifying name never names a historical document', async () => {
  for (const name of [undefined, '/Users/someone/Poster.ai', 'file:Poster.ai']) {
    const f = await fixture();
    // The raw row's first decoration names Brochure.indd; the qualifying Illustrator observation has no usable name.
    const flagged = presented('a', 'hero.png', 0, { sourceSaveRequired: true, sourceSaveAppFamily: 'illustrator',
      ...(name === undefined ? {} : { sourceSaveSourceName: name }) });
    f.set('a', [rawRow('a', 'hero.png')], [flagged]);
    await f.refresh();
    assert.deepEqual(renderedReasons(f), ['Unsaved changes in Illustrator. Save your changes so Crate can check it.'], String(name));
    assert.match(f.guidanceText(), /Unsaved changes found\./);
    for (const text of [...renderedReasons(f), f.guidanceText()]) assert.equal(/Brochure|Poster|someone/.test(text), false, text);
  }
  // A retained row that loses its qualifying name repaints without falling back.
  const g = await fixture();
  g.set('a', [rawRow('a', 'hero.png')], [presented('a', 'hero.png', 0, { sourceSaveRequired: true, sourceSaveAppFamily: 'indesign', sourceSaveSourceName: 'Draft.indd' })]);
  await g.refresh();
  assert.deepEqual(renderedReasons(g), ['Unsaved changes in Draft.indd. Save your changes so Crate can check it.']);
  g.set('a', [rawRow('a', 'hero.png')], [presented('a', 'hero.png', 0, { sourceSaveRequired: true, sourceSaveAppFamily: 'indesign' })]);
  await g.refresh();
  assert.deepEqual(renderedReasons(g), ['Unsaved changes in InDesign. Save your changes so Crate can check it.']);
  // Unflagged Needs Save rows keep their existing historical copy.
  assert.equal(g.evaluate("getPendingFileReason({ captureState: 'needs-save', captureEvidence: { sourceName: 'Poster A.ai' } })"),
    'Linked asset observed from Poster A.ai. Save to make package-ready.');
});

test('a modal closing while the selected project own refresh read is in flight never hides or re-announces it', async () => {
  for (const via of ['refresh', 'add-files']) {
    const f = await fixture();
    f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
    await f.refresh();
    await tick();
    f.el('needs-save-reminder-status').textContent = 'spoken';
    const held = f.deferRead();
    if (via === 'refresh') {
      f.renderer.testNext = f.projects.map(project => ({ ...project }));
      f.evaluate("applyProjectRefresh(testNext, projectRefreshGeneration, new Set(['a']), projectListReadEpoch)");
    } else {
      f.evaluate("activeAddFilesOperation = { projectId: 'a' }; testReconcile = reconcileAddFilesRendererState(activeAddFilesOperation, projectSelectionEpoch, projectSelectionIntentEpoch)");
      await tick(5);
    }
    f.el('modal-upgrade').classList.remove('hidden');
    f.renderer.hidePackageLimitModal({ restoreFocus: false });
    await tick(10);
    assert.equal(f.visible(), true, `${via}: same project, status and unsaved rows`);
    assert.equal(f.guidanceVisible(), true, via);
    assert.equal(f.status(), 'spoken', via);
    held.resolve(clone(f.workspaces.get('a')));
    await tick();
    assert.equal(f.visible(), true, via);
    assert.equal(f.status(), 'spoken', `${via}: the finished read does not announce it again`);
  }
});

test('out-of-order workspace reads never repaint or re-announce from the superseded one', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0, 'indesign', 'Brochure.indd')]);
  await f.refresh();
  await tick();
  f.el('needs-save-reminder-status').textContent = 'spoken';
  const first = f.deferRead();
  const second = f.deferRead();
  f.renderer.testNext = f.projects.map(project => ({ ...project }));
  f.evaluate("applyProjectRefresh(testNext, projectRefreshGeneration, new Set(['a']), projectListReadEpoch)");
  f.renderer.testNext = f.projects.map(project => ({ ...project }));
  f.evaluate("applyProjectRefresh(testNext, projectRefreshGeneration, new Set(['a']), projectListReadEpoch)");
  second.resolve({ projectId: 'a', files: [], pendingFiles: [needsSave('a', 'hero.jpg', 0, 'indesign', 'Newest.indd')] });
  await tick();
  first.resolve({ projectId: 'a', files: [], pendingFiles: [needsSave('a', 'hero.jpg', 0, 'illustrator', 'Superseded.ai')] });
  await tick();
  assert.equal(f.visible(), true);
  assert.match(f.guidanceText(), /Newest\.indd/);
  assert.equal(/Superseded/.test(f.guidanceText() + renderedReasons(f).join(' ')), false);
  assert.equal(f.status(), 'spoken');
});

test('a cooldown re-check survives an unchanged project-list replacement', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await f.refresh();
  f.el('btn-needs-save-dismiss').click();
  FakeDate.current += 20_000;
  f.set('a', [rawRow('a', 'hero.jpg'), rawRow('a', 'new.jpg')], [needsSave('a', 'hero.jpg', 0), needsSave('a', 'new.jpg', 1)]);
  await f.refresh();
  assert.equal(f.visible(), false, 'quiet during the cooldown');
  assert.equal(f.pendingLongTimers(), 1);
  // Another project's update replaces the list; nothing about a changed.
  f.evaluate('state.projects = state.projects.map(project => ({ ...project }))');
  FakeDate.current += 2 * 60_000;
  f.fireLongTimers();
  assert.equal(f.visible(), true, 'the genuinely new item still reminds once the cooldown ends');
});

test('a flagged row tells the user to save without promising a package-ready result', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.png'), rawRow('a', 'logo.png')], [
    presented('a', 'hero.png', 0, { sourceSaveRequired: true, sourceSaveAppFamily: 'illustrator', sourceSaveSourceName: 'Draft.ai' }),
    presented('a', 'logo.png', 1, { sourceSaveRequired: true, sourceSaveAppFamily: 'illustrator' }),
  ]);
  await f.refresh();
  assert.deepEqual(renderedReasons(f), [
    'Unsaved changes in Draft.ai. Save your changes so Crate can check it.',
    'Unsaved changes in Illustrator. Save your changes so Crate can check it.',
  ]);
  assert.equal(renderedReasons(f).some(text => /package-ready/.test(text)), false);
});

test('contradicted evidence never comes back from a later compatible replacement without a fresh read', async () => {
  for (const dismissed of [false, true]) {
    const f = await fixture();
    f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
    await f.refresh();
    await tick();
    if (dismissed) f.el('btn-needs-save-dismiss').click();
    assert.equal(f.guidanceVisible(), true);
    f.evaluate("state.projects = state.projects.map(project => project.id === 'a' ? { ...project, status: 'paused' } : { ...project })");
    assert.equal(f.visible(), false);
    assert.equal(f.guidanceVisible(), false);
    // The status flips back with no workspace read, then a modal closes and the cooldown re-check fires.
    f.evaluate("state.projects = state.projects.map(project => project.id === 'a' ? { ...project, status: 'watching' } : { ...project })");
    f.el('modal-upgrade').classList.remove('hidden');
    f.renderer.hidePackageLimitModal({ restoreFocus: false });
    await tick(10);
    FakeDate.current += 3 * 60_000;
    f.fireLongTimers();
    await tick();
    assert.equal(f.visible(), false, `dismissed=${dismissed}: invalidated evidence is never reused`);
    assert.equal(f.guidanceVisible(), false, `dismissed=${dismissed}: the note waits for a fresh read too`);
    assert.equal(f.status(), '');
    // Only a fresh authoritative read revalidates; dismissal history is untouched.
    await f.refresh();
    await tick();
    assert.equal(f.guidanceVisible(), true);
    assert.equal(f.visible(), !dismissed, dismissed ? 'a dismissal still sticks' : 'restored from fresh evidence');
    if (!dismissed) assert.equal(f.status(), spoken(STABLE_WATCHING));
  }
});

test('an off-tab suspension stays hidden through a modal close until a fresh read', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  await f.refresh();
  await tick();
  await f.renderer.switchTab('settings');
  f.renderer.testNext = f.projects.map(project => ({ ...project }));
  f.evaluate("applyProjectRefresh(testNext, projectRefreshGeneration, new Set(['a']), projectListReadEpoch)");
  assert.equal(f.visible(), false);
  f.el('modal-upgrade').classList.remove('hidden');
  f.renderer.hidePackageLimitModal({ restoreFocus: false });
  await tick(10);
  await tick();
  assert.equal(f.visible(), false, 'a modal close is not a fresh read');
  assert.equal(f.guidanceVisible(), false);
  assert.equal(f.status(), '', 'and announces nothing');
  await f.renderer.switchTab('current-project');
  await tick();
  assert.equal(f.visible(), true, 'the fresh read restores it, inside the cooldown, as a suspension not a dismissal');
  assert.equal(f.status(), spoken(STABLE_WATCHING));
});

// Lifecycle matrix: every starting state crossed with every transition, checked together.
// Expectations come from the owner-approved rules: once per item, dismissal sticks, a
// project switch never repeats an already-shown item, suspension is not a dismissal, and
// only a fresh authoritative read for the current context can restore a withdrawn request.
test('reminder lifecycle matrix: starting states x transitions', async () => {
  const W = spoken(STABLE_WATCHING), P = spoken(STABLE_PAUSED);
  const setStatus = (f, id, status) => f.evaluate(`state.projects = state.projects.map(p => p.id === '${id}' ? { ...p, status: '${status}' } : { ...p })`);
  const freshRead = async f => { await f.renderer.switchTab('current-project'); await f.refresh(); await tick(); };
  const starts = {
    shown: async () => {},
    dismissed: async f => { f.el('btn-needs-save-dismiss').click(); },
    'suspended-offtab': async f => {
      await f.renderer.switchTab('settings');
      f.renderer.testNext = f.projects.map(project => ({ ...project }));
      f.evaluate("applyProjectRefresh(testNext, projectRefreshGeneration, new Set(['a']), projectListReadEpoch)");
    },
    'suspended-status': async f => { setStatus(f, 'a', 'paused'); f.projects[0].status = 'paused'; },
  };
  const transitions = {
    'switch-and-return': async f => {
      f.evaluate("setSelectedProject('b')"); await freshRead(f);
      f.evaluate("setSelectedProject('a')"); await freshRead(f);
    },
    'modal-close': async f => {
      f.el('modal-upgrade').classList.remove('hidden');
      f.renderer.hidePackageLimitModal({ restoreFocus: false });
      await tick(10); await tick();
    },
    'cooldown-timer': async f => { FakeDate.current += 3 * 60_000; f.fireLongTimers(); await tick(); },
    'unchanged-replacement': async f => { f.evaluate('state.projects = state.projects.map(project => ({ ...project }))'); await tick(); },
    'fresh-read': async f => { await freshRead(f); },
    'contradictory-replacement': async f => { setStatus(f, 'a', 'paused'); await tick(); },
  };
  // [reminder visible, live region, Review Assets note visible] after the transition.
  // 'kept' = the live region was not rewritten.
  const expected = {
    shown: { 'switch-and-return': [false, '', true], 'modal-close': [true, 'kept', true], 'cooldown-timer': [true, 'kept', true],
      'unchanged-replacement': [true, 'kept', true], 'fresh-read': [true, 'kept', true], 'contradictory-replacement': [false, '', false] },
    dismissed: { 'switch-and-return': [false, '', true], 'modal-close': [false, 'kept', true], 'cooldown-timer': [false, 'kept', true],
      'unchanged-replacement': [false, 'kept', true], 'fresh-read': [false, 'kept', true], 'contradictory-replacement': [false, 'kept', false] },
    'suspended-offtab': { 'switch-and-return': [false, '', true], 'modal-close': [false, '', false], 'cooldown-timer': [false, '', false],
      'unchanged-replacement': [false, '', false], 'fresh-read': [true, W, true], 'contradictory-replacement': [false, '', false] },
    'suspended-status': { 'switch-and-return': [false, '', true], 'modal-close': [false, '', false], 'cooldown-timer': [false, '', false],
      'unchanged-replacement': [false, '', false], 'fresh-read': [true, P, true], 'contradictory-replacement': [false, '', false] },
  };
  const failures = [];
  for (const [startName, start] of Object.entries(starts)) {
    for (const [name, transition] of Object.entries(transitions)) {
      const f = await fixture();
      f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
      await f.refresh();
      await tick();
      await start(f);
      const status = f.el('needs-save-reminder-status');
      status.textContent = status.textContent ? 'spoken' : status.textContent;
      const before = status.textContent;
      await transition(f);
      const [visible, region, note] = expected[startName][name];
      const want = region === 'kept' ? before : region;
      const got = [f.visible(), f.status(), f.guidanceVisible()];
      if (got[0] !== visible || got[1] !== want || got[2] !== note) {
        failures.push(`${startName} -> ${name}: visible ${got[0]} (want ${visible}), live "${got[1]}" (want "${want}"), note ${got[2]} (want ${note})`);
      }
      // Whatever happened, the evidence behind any visible reminder must be current and unrepeated history must hold.
      if (f.visible()) assert.equal(f.evaluate("needsSaveReminder.last && needsSaveReminder.last.project.id"), 'a');
    }
  }
  assert.deepEqual(failures, []);
});

test('missing pending list nodes return no items instead of throwing', async () => {
  const f = await fixture();
  f.set('a', [rawRow('a', 'hero.jpg')], [needsSave('a', 'hero.jpg', 0)]);
  const saved = f.document.querySelector;
  f.document.querySelector = selector => selector === '#pending-section' ? null : saved(selector);
  let items;
  try { items = f.evaluate('renderPendingFiles(state.projects[0], [])'); } finally { f.document.querySelector = saved; }
  assert.ok(Array.isArray(items) && items.length === 0);
});
