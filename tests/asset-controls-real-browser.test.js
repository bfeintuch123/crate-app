'use strict';

// Real Chrome, real production markup/styles/renderer, real keyboard and mouse
// input over CDP. Only the IPC bridge is synthetic (in-page, stateful), so these
// checks prove what the browser does with the buttons: Tab order, Enter/Space
// activation, focus after a row leaves, disabled state while an action is in
// flight, and the always-visible square controls at the desktop sizes.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { findBrowser, launch } = require('./asset-controls-cdp-helper');

const fs = require('node:fs');
const os = require('node:os');
const childProcess = require('node:child_process');
const browser = findBrowser();
const rendererDir = path.join(__dirname, '..', 'renderer');
const skip = browser ? false : 'Chrome/Chromium unavailable: rendered checks NOT RUN';

// Serialized into the page. Renderer globals (state, renderFiles, ...) come from app.js.
function bootstrap() {
  const B = window.__bridge = { calls: [], hold: null, release: null, holdRemove: null, releaseRemove: null, fail: null, inflight: 0 };
  const clone = value => JSON.parse(JSON.stringify(value));
  const id = name => 'id-' + name;
  const pendingRow = (name, captureState = 'pending') => ({ path: '/synthetic/' + name, name, ext: '.png', captureState,
    captureEvidence: { appFamily: 'indesign' }, visualIdentity: id(name) });
  const asset = (name, extra = {}) => ({ name, path: '/synthetic/' + name, ext: '.png', projectRole: 'asset', assetOrigin: 'added',
    included: true, excluded: false, visualIdentity: id(name), visualRevision: 'v1', ...extra });
  B.reset = pendingNames => {
    Object.assign(B, { calls: [], hold: null, release: null, holdRemove: null, releaseRemove: null, fail: null, inflight: 0 });
    B.files = [
      { name: 'Brochure.indd', path: '/synthetic/Brochure.indd', ext: '.indd', projectRole: 'source', protectedSource: true,
        sourceSelection: 'selected', selectionRevision: 1, included: true, verificationStatus: 'scanned', verificationRequired: true,
        visualIdentity: 'source-brochure', visualRevision: 'v1', appFamily: 'indesign' },
      asset('Placed.png', { currentWorkingSources: [{ identity: 'source-brochure', name: 'Brochure.indd' }] }),
      asset('Standalone.png'),
      asset('Excluded.png', { assetOrigin: 'existing', included: false, excluded: true }),
    ];
    B.pending = [...pendingNames.map(name => pendingRow(name)), pendingRow('Saved.png', 'needs-save')];
    B.records = [];
  };
  B.holdNext = () => { B.hold = new Promise(resolve => { B.release = resolve; }); };
  B.holdNextRemove = () => { B.holdRemove = new Promise(resolve => { B.releaseRemove = resolve; }); };
  const gate = async () => {
    B.inflight += 1;
    try {
      if (B.hold) await B.hold;
      if (B.fail) { const message = B.fail; B.fail = null; throw new Error(message); }
    } finally { B.inflight -= 1; }
  };
  B.project = () => ({ id: 'synthetic-controls', name: 'Synthetic', type: 'branding', status: 'paused',
    files: clone(B.files), pendingFiles: clone(B.pending),
    excludedAssetKeys: [...B.records, ...B.files.filter(file => file.excluded)].map(file => file.path),
    assetBaseline: { status: 'included', decision: 'include' } });
  const take = (list, target) => {
    const index = list.findIndex(file => file.visualIdentity === target || file.path === target);
    return index === -1 ? null : list.splice(index, 1)[0];
  };
  window.crate = {
    getProjects: async () => [B.project()],
    getFileVisual: async () => ({ kind: 'fallback' }),
    getAssetWorkspace: async projectId => ({
      projectId,
      files: clone(B.files),
      pendingFiles: B.pending.map((file, sourceIndex) => ({ name: file.name, ext: file.ext, visualIdentity: file.visualIdentity,
        visualRevision: 'v1', sourceIndex })),
      excludedPendingFiles: B.records.map(file => ({ name: file.name, ext: file.ext, assetOrigin: 'added', projectRole: 'asset',
        protectedSource: false, included: false, excluded: true, excludedPending: true, visualIdentity: file.visualIdentity, visualRevision: null })),
      workingFileChoices: { version: 1, choices: [] },
      semanticCounts: { includedAssets: B.files.filter(file => file.projectRole === 'asset' && file.included).length,
        selectedWorkingSources: 1, excludedWorkingSources: 0, invalidWorkingSources: 0,
        excludedAssets: B.files.filter(file => file.excluded).length },
    }),
    acceptPending: async (projectId, target) => {
      B.calls.push(['acceptPending', target]);
      await gate();
      if (B.refuseAccept) { B.refuseAccept = false; return null; }
      const row = take(B.pending, target) || take(B.records, target);
      if (!row) return null;
      B.files.push(asset(row.name));
      return { files: clone(B.files), pendingFiles: clone(B.pending) };
    },
    rejectPending: async (projectId, target) => {
      B.calls.push(['rejectPending', target]);
      await gate();
      const row = take(B.pending, target);
      if (row) B.records.push(row);
      return clone(B.pending);
    },
    removeFile: async (projectId, identity) => {
      B.calls.push(['removeFile', identity]);
      B.inflight += 1;
      try { if (B.holdRemove) await B.holdRemove; } finally { B.inflight -= 1; }
      const file = B.files.find(item => item.visualIdentity === identity);
      if (file) { file.excluded = !file.excluded; file.included = !file.excluded; }
      return clone(B.files);
    },
  };
  // The production listener wiring (init() itself is not run: it loads the account and IPC).
  let wired = false;
  window.__start = async pendingNames => {
    if (!wired) { setupEventListeners(); wired = true; }
    B.reset(pendingNames);
    accountStatus = { revision: 1, state: 'signed_in', canUseWorkspace: true, identity: { id: 'synthetic' }, message: '' };
    renderAccount();
    document.querySelector('#tab-projects').classList.remove('active');
    document.querySelector('#tab-current-project').classList.add('active');
    state.projects = [B.project()];
    state.selectedProjectId = 'synthetic-controls';
    await renderFiles();
    openAssetReviewWorkspace();
    await new Promise(resolve => setTimeout(resolve, 100));
    return true;
  };
  window.__idle = async () => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (B.inflight === 0 && rendererActionsInFlight.size === 0 && !B.hold && !B.holdRemove) {
        await new Promise(resolve => setTimeout(resolve, 150));
        if (B.inflight === 0 && rendererActionsInFlight.size === 0) return true;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return false;
  };
  window.__label = element => !element ? null : element === document.body ? 'BODY'
    : (element.getAttribute('aria-label') || element.id || element.tagName);
  window.__button = label => Array.from(document.querySelectorAll('button')).find(button => button.getAttribute('aria-label') === label) || null;
  window.__centerOf = selector => {
    const element = document.querySelector(selector);
    if (!element) return null;
    element.scrollIntoView({ block: 'center' });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, hit: true };
  };
  window.__center = label => {
    const button = window.__button(label);
    if (!button) return null;
    button.scrollIntoView({ block: 'center' });
    const rect = button.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, hit: !!hit && (hit === button || button.contains(hit)) };
  };
}

const json = value => JSON.stringify(value);
async function withPage(options, run) {
  const page = await launch({ browser, rendererDir, bootstrapSource: `(${bootstrap.toString()})();`, ...options });
  try { return await run(page); } finally { await page.close(); }
}
async function start(page, names) {
  assert.equal(await page.evaluate(`window.__start(${json(names)})`), true);
}
const active = page => page.evaluate('window.__label(document.activeElement)');
const idle = async page => assert.equal(await page.evaluate('window.__idle()'), true, 'actions settle');
const toast = page => page.evaluate("document.querySelector('#toast-message')?.textContent || ''");
const calls = page => page.evaluate('window.__bridge.calls');
// Press a key on the focused control and require exactly one bridge call, the expected one.
async function pressOnce(page, key, expected) {
  const before = (await calls(page)).length;
  await page.press(key);
  await idle(page);
  const after = await calls(page);
  assert.deepEqual(after.slice(before), [expected], `exactly one call for ${key}`);
}
async function clickSelector(page, selector) {
  const point = await page.evaluate(`window.__centerOf(${json(selector)})`);
  assert.ok(point, selector);
  await page.clickAt(point.x, point.y);
  await page.sleep(100);
}
async function click(page, label, count = 1) {
  const point = await page.evaluate(`window.__center(${json(label)})`);
  assert.ok(point, `button ${label} is mounted`);
  assert.ok(point.hit, `button ${label} receives the pointer`);
  await page.clickAt(point.x, point.y, 1);
  if (count === 2) await page.clickAt(point.x, point.y, 2);
}
// Tab at a human pace: a virtual list re-mounts rows on the scroll that focus causes.
async function tabTo(page, label, limit = 120, visited = null) {
  await page.evaluate("document.querySelector('#asset-review-search').focus()");
  for (let step = 0; step < limit; step += 1) {
    await page.press('Tab');
    await page.sleep(40);
    const current = await active(page);
    visited?.add(current);
    assert.notEqual(current, 'BODY', `Tab never drops focus to <body> (step ${step}, after ${json([...(visited || [])].slice(-3))})`);
    if (current === label) return true;
  }
  return false;
}

test('rendered [+]/[x]: always visible 22px box in a 28px target, no hover title, no clipping or overflow, visible focus ring', { skip, timeout: 60000 }, async () => {
  for (const [width, height] of [[1100, 760], [1440, 900]]) {
    await withPage({ width, height }, async page => {
      await start(page, ['Alpha.png', 'Beta.png']);
      await page.moveAway();
      // Make one remembered exclusion so the Excluded-record [+] is measured too.
      await page.evaluate("window.crate.rejectPending('synthetic-controls', 'id-Beta.png').then(async () => { state.projects = await window.crate.getProjects(); await renderFiles(); })");
      await idle(page);
      for (const review of [true, false]) {
        await page.evaluate(review ? 'openAssetReviewWorkspace()' : 'closeAssetReviewWorkspace()');
        await page.sleep(150);
        const metrics = await page.evaluate(`(() => {
          const visible = element => element.getClientRects().length > 0 && !element.closest('.hidden, .filtered-out');
          const buttons = Array.from(document.querySelectorAll('.row-icon-button')).filter(visible);
          const rect = element => element.getBoundingClientRect();
          return {
            labels: buttons.map(button => button.getAttribute('aria-label')),
            cardGrid: buttons.some(button => button.closest('.asset-card-grid')),
            virtual: buttons.some(button => button.closest('.asset-virtual-list')),
            pageOverflow: document.documentElement.scrollWidth - innerWidth,
            checks: buttons.map(button => {
              const box = button.querySelector('.row-icon-box'), b = rect(button), x = rect(box);
              const row = button.closest('[data-render-key]') || button.parentElement, r = rect(row);
              const list = row.parentElement;
              return {
                label: button.getAttribute('aria-label'),
                opacity: [getComputedStyle(button).opacity, getComputedStyle(box).opacity],
                visibility: getComputedStyle(button).visibility,
                target: [Math.round(b.width * 10) / 10, Math.round(b.height * 10) / 10],
                box: [Math.round(x.width * 10) / 10, Math.round(x.height * 10) / 10],
                insideRow: b.left >= r.left - 1 && b.right <= r.right + 1 && b.top >= r.top - 1 && b.bottom <= r.bottom + 1,
                rowOverflow: row.scrollWidth - row.clientWidth,
                listOverflow: list ? list.scrollWidth - list.clientWidth : 0,
                title: button.hasAttribute('title'),
                position: getComputedStyle(button).position,
              };
            }),
          };
        })()`);
        const where = `${width}x${height} ${review ? 'review' : 'dashboard'}: ${json(metrics)}`;
        assert.ok(metrics.checks.length > 0, where);
        assert.ok(metrics.pageOverflow <= 0, `no horizontal page overflow ${where}`);
        for (const check of metrics.checks) {
          assert.deepEqual(check.opacity, ['1', '1'], `opacity 1 without hover ${where}`);
          assert.equal(check.visibility, 'visible', where);
          assert.deepEqual(check.target, [28, 28], `28px target ${where}`);
          assert.deepEqual(check.box, [22, 22], `22px box ${where}`);
          assert.ok(check.insideRow, `no clipping ${where}`);
          assert.ok(check.rowOverflow <= 1 && check.listOverflow <= 1, `no overflow ${where}`);
          assert.equal(check.title, false, `no hover title ${where}`);
          // The legacy absolutely positioned card-grid rule is overridden in every rendered layout.
          assert.equal(check.position, 'static', `in-flow control ${where}`);
        }
        if (review) {
          assert.ok(metrics.virtual, `virtual-list layout measured ${where}`);
          for (const label of ['Include Alpha.png', 'Exclude Alpha.png', 'Exclude Placed.png', 'Exclude Standalone.png', 'Include Excluded.png', 'Include Beta.png']) {
            assert.ok(metrics.labels.includes(label), `${label} ${where}`);
          }
        } else {
          assert.ok(metrics.cardGrid, `card-grid layout measured ${where}`);
        }
      }
      // A keyboard-focused control shows the 2px black ring at 2px offset on its visible box.
      await page.evaluate('openAssetReviewWorkspace()');
      assert.equal(await tabTo(page, 'Exclude Alpha.png'), true, 'Tab reaches the [x]');
      const ring = await page.evaluate(`(() => { const box = document.activeElement.querySelector('.row-icon-box'), style = getComputedStyle(box);
        return [style.outlineStyle, style.outlineWidth, style.outlineColor, style.outlineOffset, document.activeElement.matches(':focus-visible')]; })()`);
      assert.deepEqual(ring, ['solid', '2px', 'rgb(17, 17, 17)', '2px', true]);
    });
  }
});

test('keyboard: Tab reaches every [+], [x] and batch button; Enter and Space press them; focus moves to the next row, then the heading, never <body>', { skip, timeout: 60000 }, async () => {
  await withPage({}, async page => {
    await start(page, ['Alpha.png', 'Beta.png', 'Gamma.png']);
    await page.evaluate("document.querySelector('#asset-review-search').focus()");
    const reached = new Set();
    for (let step = 0; step < 120; step += 1) {
      await page.press('Tab');
      reached.add(await active(page));
    }
    for (const label of ['Include 3 assets', 'Exclude 3 assets', 'Include Alpha.png', 'Exclude Alpha.png', 'Include Beta.png', 'Exclude Beta.png',
      'Include Gamma.png', 'Exclude Gamma.png', 'Exclude Placed.png', 'Exclude Standalone.png', 'Include Excluded.png']) {
      assert.ok(reached.has(label), `Tab reaches ${label}: ${json([...reached])}`);
    }
    assert.equal(await page.evaluate("window.__button('Include Saved.png') || window.__button('Exclude Saved.png')"), null, 'Needs Save rows have no buttons');

    assert.equal(await tabTo(page, 'Exclude Alpha.png'), true);
    await pressOnce(page, 'Enter', ['rejectPending', 'id-Alpha.png']);
    assert.equal(await toast(page), 'Alpha.png excluded');
    assert.equal(await active(page), 'Exclude Beta.png', 'focus moves to the same button on the next row');

    await pressOnce(page, 'Space', ['rejectPending', 'id-Beta.png']);
    assert.equal(await active(page), 'Exclude Gamma.png');

    await pressOnce(page, 'Enter', ['rejectPending', 'id-Gamma.png']);
    assert.equal(await active(page), 'pending-header', 'no rows with [x] left: focus moves to the Needs Review title');
    assert.notEqual(await active(page), 'BODY');

    // Remembered exclusion [+] in the Added list: Space includes it through accept and focus stays on that row's new [x].
    assert.equal(await tabTo(page, 'Include Alpha.png'), true);
    await pressOnce(page, 'Space', ['acceptPending', 'id-Alpha.png']);
    assert.equal(await toast(page), 'Alpha.png included');
    assert.equal(await active(page), 'Exclude Alpha.png');

    // Included asset [x] by Enter: focus moves to the same row's [+].
    assert.equal(await tabTo(page, 'Exclude Standalone.png'), true);
    await pressOnce(page, 'Enter', ['removeFile', 'id-Standalone.png']);
    assert.equal(await active(page), 'Include Standalone.png');
    assert.equal(await toast(page), 'Standalone.png excluded');

    // Excluded asset [+] by Space: one toggle, focus moves to the same row's [x].
    assert.equal(await tabTo(page, 'Include Excluded.png'), true);
    await pressOnce(page, 'Space', ['removeFile', 'id-Excluded.png']);
    assert.equal(await active(page), 'Exclude Excluded.png');
    assert.equal(await toast(page), 'Excluded.png included');

    // Batch buttons by keyboard: Exclude All (N) by Enter, then the hidden-at-0 state.
    await page.evaluate(`(async () => {
      window.__bridge.pending.unshift(...['Delta.png', 'Epsilon.png'].map(name => ({ path: '/synthetic/' + name, name, ext: '.png',
        captureState: 'pending', captureEvidence: { appFamily: 'indesign' }, visualIdentity: 'id-' + name })));
      state.projects = await window.crate.getProjects(); await renderFiles();
    })()`);
    assert.equal(await tabTo(page, 'Exclude 2 assets'), true);
    const beforeBatch = (await calls(page)).length;
    await page.press('Enter');
    await idle(page);
    assert.deepEqual((await calls(page)).slice(beforeBatch), [['rejectPending', 'id-Delta.png'], ['rejectPending', 'id-Epsilon.png']],
      'one press runs the batch once over exactly its rows');
    assert.equal(await toast(page), '2 assets excluded');
    assert.deepEqual(await page.evaluate("['#btn-include-all-existing', '#btn-skip-all-existing'].map(id => document.querySelector(id).classList.contains('hidden'))"), [true, true]);
    assert.equal(await active(page), 'pending-header', 'the batch button hid itself at 0: focus moves to the Needs Review title, not <body>');
  });
});

test('in flight: row, record and batch controls are disabled, double clicks are ignored, and all re-enable after success or failure', { skip, timeout: 60000 }, async () => {
  await withPage({}, async page => {
    await start(page, ['Alpha.png', 'Beta.png', 'Gamma.png', 'Delta.png', 'Epsilon.png']);
    await click(page, 'Exclude Alpha.png'); await idle(page);
    await click(page, 'Exclude Beta.png'); await idle(page);
    const controls = `(() => ({
      rows: Array.from(document.querySelectorAll('.pending-row-action')).filter(button => button.getClientRects().length).map(button => [button.getAttribute('aria-label'), button.disabled]),
      batch: ['#btn-include-all-existing', '#btn-skip-all-existing'].map(id => { const button = document.querySelector(id);
        return [button.textContent, button.disabled, button.getAttribute('aria-busy'), button.classList.contains('hidden')]; }),
    }))()`;

    // Include a remembered exclusion while the bridge is held.
    await page.evaluate('window.__bridge.holdNext()');
    await click(page, 'Include Alpha.png');
    await page.sleep(100);
    let held = await page.evaluate(controls);
    assert.ok(held.rows.length >= 7, json(held));
    assert.ok(held.rows.every(([, disabled]) => disabled), `every row and record control is disabled: ${json(held)}`);
    assert.ok(held.batch.every(([, disabled]) => disabled), json(held));
    await click(page, 'Exclude Gamma.png', 2);
    await click(page, 'Include Beta.png', 2);
    await page.press('Enter');
    assert.deepEqual(await page.evaluate('window.__bridge.calls.slice(2)'), [['acceptPending', 'id-Alpha.png']], 'nothing else is submitted');
    await page.evaluate('(() => { const release = window.__bridge.release; window.__bridge.hold = null; release(); })()');
    await idle(page);
    let after = await page.evaluate(controls);
    assert.ok(after.rows.every(([, disabled]) => !disabled), `re-enabled after success: ${json(after)}`);
    assert.equal(await toast(page), 'Alpha.png included');

    // A failing row decision re-enables everything and keeps the row.
    await page.evaluate("window.__bridge.fail = 'synthetic failure'");
    await click(page, 'Exclude Gamma.png');
    await idle(page);
    assert.equal(await toast(page), 'Crate could not exclude Gamma.png. Try again.');
    after = await page.evaluate(controls);
    assert.ok(after.rows.some(([label]) => label === 'Exclude Gamma.png'), json(after));
    assert.ok(after.rows.every(([, disabled]) => !disabled), `re-enabled after failure: ${json(after)}`);
    assert.ok(after.batch.every(([, disabled, , hidden]) => !disabled && !hidden), json(after));

    // Include All (3) while held: one request at a time, every control disabled and busy, double click ignored.
    const before = (await page.evaluate('window.__bridge.calls')).length;
    await page.evaluate('window.__bridge.holdNext()');
    await click(page, 'Include 3 assets', 2);
    await page.sleep(100);
    held = await page.evaluate(controls);
    assert.ok(held.rows.every(([, disabled]) => disabled), json(held));
    assert.deepEqual(held.batch.map(([, disabled, busy]) => [disabled, busy]), [[true, 'true'], [true, 'true']], json(held));
    assert.equal((await page.evaluate('window.__bridge.calls')).length, before + 1, 'the double click starts one batch');
    await page.evaluate('(() => { const release = window.__bridge.release; window.__bridge.hold = null; release(); })()');
    await idle(page);
    assert.equal(await toast(page), '3 assets included');
    assert.deepEqual((await page.evaluate('window.__bridge.calls')).slice(before).map(([action]) => action), ['acceptPending', 'acceptPending', 'acceptPending']);
    after = await page.evaluate(controls);
    assert.ok(after.batch.every(([, , , hidden]) => hidden), `hidden at 0: ${json(after)}`);
    assert.ok(after.rows.every(([, disabled]) => !disabled), json(after));

    // Included asset [x] while held: disabled, a double click sends one toggle, then the new [+] is usable.
    const removes = (await page.evaluate('window.__bridge.calls')).filter(([action]) => action === 'removeFile').length;
    await page.evaluate('window.__bridge.holdNextRemove()');
    await click(page, 'Exclude Standalone.png');
    await page.sleep(100);
    assert.equal(await page.evaluate("window.__button('Exclude Standalone.png').disabled"), true);
    await click(page, 'Exclude Standalone.png', 2);
    assert.equal((await page.evaluate('window.__bridge.calls')).filter(([action]) => action === 'removeFile').length, removes + 1);
    await page.evaluate('(() => { const release = window.__bridge.releaseRemove; window.__bridge.holdRemove = null; release(); })()');
    await idle(page);
    assert.equal(await toast(page), 'Standalone.png excluded');
    assert.equal(await page.evaluate("window.__button('Include Standalone.png').disabled"), false);
  });
});

test('virtual list boundary and filtered views: one call per key, focus follows to the next row, the filtered last row and remembered rows fall back to a heading', { skip, timeout: 120000 }, async () => {
  await withPage({}, async page => {
    const names = Array.from({ length: 40 }, (_, index) => `Asset_${String(index + 1).padStart(2, '0')}.png`);
    await start(page, names);
    const mounted = await page.evaluate("document.querySelectorAll('#pending-file-list .pending-file').length");
    assert.ok(mounted < 41, `the 40-row list is virtualized (${mounted} rows mounted)`);
    // Tab reaches every row's [+] and [x] across the virtual mount boundary, never dropping to <body>.
    const visited = new Set();
    assert.equal(await tabTo(page, 'Exclude Asset_40.png', 200, visited), true);
    for (const name of names) {
      assert.ok(visited.has('Include ' + name) && visited.has('Exclude ' + name), `Tab reaches both buttons of ${name}`);
    }
    // Deep in the list, each Enter removes exactly one row and focus follows to the next row.
    assert.equal(await tabTo(page, 'Exclude Asset_30.png', 200), true);
    for (const next of ['Asset_31.png', 'Asset_32.png', 'Asset_33.png']) {
      const current = await active(page);
      await pressOnce(page, 'Enter', ['rejectPending', 'id-' + current.replace('Exclude ', '')]);
      assert.equal(await active(page), 'Exclude ' + next);
      assert.equal(await page.evaluate(`(() => { const list = document.querySelector('#pending-file-list').getBoundingClientRect();
        const box = document.activeElement.getBoundingClientRect(); return box.top >= list.top - 1 && box.bottom <= list.bottom + 1; })()`), true,
        'the focused next-row button is inside the list viewport');
    }
    // The last row of the list: no next row, so focus moves to the title.
    assert.equal(await tabTo(page, 'Exclude Asset_40.png', 260), true);
    await pressOnce(page, 'Enter', ['rejectPending', 'id-Asset_40.png']);
    assert.equal(await active(page), 'pending-header');

    // Needs Review filter: exclude down to the last decidable row; the title keeps focus, never <body>.
    await page.evaluate("window.__start(['One.png', 'Two.png'])");
    await clickSelector(page, '[data-asset-filter="missing"]');
    assert.equal(await tabTo(page, 'Exclude One.png'), true);
    await pressOnce(page, 'Space', ['rejectPending', 'id-One.png']);
    assert.equal(await active(page), 'Exclude Two.png');
    await pressOnce(page, 'Enter', ['rejectPending', 'id-Two.png']);
    assert.equal(await active(page), 'pending-header');

    // Excluded filter: remembered rows leave the filtered list one by one; the last falls back to the page title.
    await clickSelector(page, '[data-asset-filter="excluded"]');
    assert.equal(await tabTo(page, 'Include One.png'), true);
    await pressOnce(page, 'Space', ['acceptPending', 'id-One.png']);
    assert.equal(await active(page), 'Include Two.png', 'the next remembered row keeps focus in the Excluded view');
    await pressOnce(page, 'Enter', ['acceptPending', 'id-Two.png']);
    assert.notEqual(await active(page), 'BODY');
    assert.ok(['added-assets-heading', 'asset-review-heading'].includes(await active(page)), await active(page));
  });
});

test('remembered-record [+]: disabled across a refresh while held, refused accept re-enables it with the exact message', { skip, timeout: 60000 }, async () => {
  await withPage({}, async page => {
    await start(page, ['Alpha.png', 'Beta.png', 'Gamma.png']);
    await click(page, 'Exclude Alpha.png'); await idle(page);
    await click(page, 'Exclude Beta.png'); await idle(page);
    const recordButtons = "Array.from(document.querySelectorAll('#added-assets-list .row-action-include.pending-row-action')).map(button => [button.getAttribute('aria-label'), button.disabled])";
    await page.evaluate('window.__bridge.holdNext()');
    await click(page, 'Include Alpha.png');
    await page.sleep(100);
    // A refresh while the action is held rebuilds rows; the rebuilt [+] buttons are still disabled.
    await page.evaluate('renderFiles()');
    await page.sleep(150);
    let state = await page.evaluate(recordButtons);
    assert.ok(state.length >= 2 && state.every(([, disabled]) => disabled), json(state));
    assert.equal(await page.evaluate("window.__button('Exclude Gamma.png').disabled"), true);
    await page.evaluate('(() => { const release = window.__bridge.release; window.__bridge.hold = null; release(); })()');
    await idle(page);
    state = await page.evaluate(recordButtons);
    assert.deepEqual(state, [['Include Beta.png', false]]);

    await page.evaluate('window.__bridge.refuseAccept = true');
    const before = (await calls(page)).length;
    await click(page, 'Include Beta.png');
    await idle(page);
    assert.deepEqual((await calls(page)).slice(before), [['acceptPending', 'id-Beta.png']]);
    assert.equal(await toast(page), 'Crate could not include Beta.png. Try again.');
    assert.deepEqual(await page.evaluate(recordButtons), [['Include Beta.png', false]], 'still Excluded with a usable [+]');
    assert.equal(await page.evaluate("window.__button('Exclude Gamma.png').disabled"), false);
  });
});

// Runs without Chrome: a browser path that exists but cannot be executed must
// fail the launch cleanly, leaving no fixture directory and no browser process.
test('a browser that cannot start fails the launch cleanly: no crash, no leftover fixture directory, no process', { timeout: 30000 }, async () => {
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-nonexec-browser-'));
  const fake = path.join(holder, 'not-a-browser');
  fs.writeFileSync(fake, 'synthetic, not executable');
  fs.chmodSync(fake, 0o644);
  const fixtureDirs = () => fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('crate-asset-controls-')).sort();
  const before = fixtureDirs();
  try {
    const unhandled = [];
    const onError = error => unhandled.push(error);
    process.on('uncaughtException', onError);
    try {
      await assert.rejects(launch({ browser: fake, rendererDir, bootstrapSource: '' }), error => {
        assert.match(String(error.code || error.message), /EACCES|ENOENT|EPERM|browser exited/);
        return true;
      });
      await new Promise(resolve => setTimeout(resolve, 200));
    } finally { process.off('uncaughtException', onError); }
    assert.deepEqual(unhandled, [], 'no unhandled child-process error');
    assert.deepEqual(fixtureDirs(), before, 'no crate-asset-controls-* directory is left behind');
    const running = childProcess.spawnSync('/usr/bin/pgrep', ['-f', fake], { encoding: 'utf8' });
    assert.equal(running.stdout.trim(), '', 'no browser process is left');
  } finally { fs.rmSync(holder, { recursive: true, force: true }); }
});
