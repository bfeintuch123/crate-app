'use strict';

// Real Chromium geometry over production HTML/CSS/JS, with synthetic IPC and
// private temporary browser profiles. This does not launch Crate or use its data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Reuse the source-bound fixture and private-pipe browser transport without
// registering the neighboring suite. Its Electron bootstrap remains stubbed.
const sharedPath = path.join(__dirname, 'ui-stability-responsive-geometry.test.js');
const sharedRequire = createRequire(sharedPath);
const noTest = () => {};
noTest.skip = noTest;
const fixtureRequire = Object.assign(
  name => name === 'node:test' ? noTest : sharedRequire(name),
  { resolve: sharedRequire.resolve, cache: sharedRequire.cache },
);
const helpers = {
  require: fixtureRequire, __dirname, console, process, Buffer, URL,
  setTimeout, clearTimeout, setImmediate, clearImmediate, module: { exports: {} },
};
vm.createContext(helpers);
vm.runInContext(fs.readFileSync(sharedPath, 'utf8'), helpers, { filename: sharedPath });
const browser = helpers.findBrowser();

async function rendered(config) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-nested-geometry-'));
  let profileCleanupSafe = true, primaryFailure;
  try {
    const base = helpers.productionWorkingFilesFixture();
    const cut = base.indexOf('<pre id="geometry-result">');
    assert.ok(cut > 0, 'production fixture exposes its probe boundary');
    const html = base.slice(0, cut)
      + '<pre id="geometry-result"></pre><script src="app.js"></script><script>('
      + scenario.toString() + ')(' + JSON.stringify(config) + ')</script></body></html>';
    const file = path.join(directory, 'fixture.html');
    fs.writeFileSync(file, html);
    profileCleanupSafe = false;
    const result = await helpers.collectGeometryDom(browser, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-component-update',
      '--allow-file-access-from-files', '--virtual-time-budget=3000',
      `--user-data-dir=${path.join(directory, 'profile')}`,
      `--window-size=${config.width},${config.height}`,
      '--dump-dom', new URL('file://' + file).href,
    ]);
    profileCleanupSafe = result.profileCleanupSafe;
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    const match = result.stdout.match(/<pre id="geometry-result">([^<]+)<\/pre>/);
    assert.ok(match, 'probe emitted measured results');
    const data = JSON.parse(match[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
    assert.equal(data.error, undefined, JSON.stringify(data));
    return data;
  } catch (failure) {
    primaryFailure = failure; throw failure;
  } finally {
    if (profileCleanupSafe) {
      try { fs.rmSync(directory, { recursive: true, force: true }); }
      catch (failure) {
        if (!primaryFailure) throw failure;
        primaryFailure.message += `; private profile cleanup failed (${failure.code || 'unknown'}), retained`;
      }
    }
  }
}

// Serialized into the real browser. Renderer globals below come from app.js.
async function scenario(config) {
  document.removeEventListener('DOMContentLoaded', init);
  try {
    const source = (name, identity, selection) => ({
      name, ext: '.pptx', appFamily: 'powerpoint', visualIdentity: identity,
      visualRevision: identity + '-v1', projectRole: 'source', protectedSource: true,
      sourceSelection: selection, selectionRevision: 1, included: selection === 'selected',
      verificationStatus: 'scanned', verificationRequired: true,
    });
    const files = [
      source('2B.pptx', 'B', 'selected'), source('2A.pptx', 'A', 'excluded'),
      ...Array.from({ length: config.count }, (_, index) => ({
        name: '2A — ' + 'long image label '.repeat(index % 3 + 1) + 'image' + index + '.png',
        ext: '.png', appFamily: 'powerpoint', visualIdentity: 'image-' + index,
        visualRevision: 'v1', projectRole: 'asset', included: true, assetOrigin: 'existing',
        currentWorkingSources: [{ identity: 'B', name: '2B.pptx' }],
        includedAsDependency: config.required, linked: config.required, requiredBy: config.required ? ['2B.pptx'] : [],
      })),
    ];
    const project = {
      id: 'synthetic-nested', name: 'Synthetic', status: 'paused', files,
      pendingFiles: [], excludedAssetKeys: [],
    };
    const workspace = {
      projectId: project.id, files, pendingFiles: [], workingFileChoices: { version: 1, choices: [] },
      semanticCounts: { includedAssets: config.count, selectedWorkingSources: 1, excludedWorkingSources: 1, invalidWorkingSources: 0 },
    };
    window.crate = {
      getAssetWorkspace: async () => workspace,
      getFileVisual: async () => ({ kind: 'fallback' }),
      setWorkingSourceSelection: async () => ({ success: false }),
    };
    accountStatus = {
      revision: 1, state: 'signed_in', canUseWorkspace: true, identity: { id: 'synthetic-layout' },
    };
    renderAccount();
    state.projects = [project];
    state.selectedProjectId = project.id;
    document.querySelector('#tab-projects').classList.remove('active');
    document.querySelector('#tab-current-project').classList.add('active');
    await renderFiles();
    if (config.review) openAssetReviewWorkspace();
    else closeAssetReviewWorkspace();

    const list = document.querySelector(config.review ? '#working-assets-list' : '#project-file-list');
    const rows = Array.from(list.children).filter(element => element.classList.contains('asset-file-row'));
    const selected = rows.find(element => element.dataset.workingSourceIdentity === 'B');
    const excluded = rows.find(element => element.dataset.workingSourceIdentity === 'A');
    const nested = selected.querySelector('.working-source-assets');
    const cards = () => Array.from(nested?.querySelectorAll('.asset-file-row') || []);
    const rect = element => {
      const r = element.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
    };
    const controlsFit = () => cards().every(row => {
      const control = row.querySelector('.required-dependency-action');
      if (!control) return !config.required;
      const r = rect(row), c = rect(control), copy = rect(row.querySelector('.asset-file-copy'));
      return c.left >= copy.right - 1 && c.right <= r.right + 1 && c.top >= r.top - 1
        && c.bottom <= r.bottom + 1 && control.scrollWidth <= control.clientWidth + 1
        && getComputedStyle(control).whiteSpace === 'nowrap';
    });
    const originsFit = () => cards().every(row => {
      const copy = row.querySelector('.asset-file-copy');
      const origin = copy.querySelector('.file-origin');
      const bounds = rect(copy);
      return !origin || Array.from(origin.children).every(child => {
        const c = rect(child);
        return c.left >= bounds.left - 1 && c.right <= bounds.right + 1;
      });
    });
    const settle = () => new Promise(resolve => setTimeout(resolve, 100));
    await settle();
    const parentBounds = rect(selected);
    const excludedBounds = rect(excluded);
    const initial = cards().map(rect);
    const nestedBounds = nested ? rect(nested) : null;
    const metrics = {
      count: config.count, review: config.review, required: config.required,
      viewport: { width: innerWidth, height: innerHeight }, parentBounds, nestedBounds,
      sourceGap: excludedBounds.top - parentBounds.bottom,
      initialCardCount: cards().length, requiredControlsFit: controlsFit(), originItemsFit: originsFit(),
      // Virtual overscan may lie outside the scroll viewport; its visible
      // intersection must remain inside the source. Inspect row content too.
      contained: initial.filter(r => !nestedBounds || r.top < nestedBounds.bottom && r.bottom > nestedBounds.top)
        .every(r => r.right <= parentBounds.right + 1
          && Math.min(r.bottom, nestedBounds?.bottom ?? r.bottom) <= parentBounds.bottom + 1),
      rowHeights: initial.every(r => Math.abs(r.height - 58) < 1),
      contentFits: cards().every(row => {
        const r = rect(row);
        return Array.from(row.children).every(child => {
          const c = rect(child);
          return c.top >= r.top - 1 && c.bottom <= r.bottom + 1
            && c.left >= r.left - 1 && c.right <= r.right + 1;
        });
      }),
      cardNonOverlap: initial.slice(1).every((r, index) => r.top >= initial[index].bottom - 1),
      sourceSelected: selected.classList.contains('is-selected-source'),
      sourceExcluded: excluded.classList.contains('is-excluded'),
    };
    const restore = Array.from(excluded.querySelectorAll('button')).find(element => element.textContent === 'Restore');
    restore.scrollIntoView({ block: 'center' });
    const restoreBounds = rect(restore);
    const hit = document.elementFromPoint(
      (restoreBounds.left + restoreBounds.right) / 2,
      (restoreBounds.top + restoreBounds.bottom) / 2,
    );
    metrics.restoreHit = !!hit && (hit === restore || restore.contains(hit));
    restore.focus();
    metrics.restoreFocus = document.activeElement === restore;
    if (config.count > 40) {
      nested.scrollTop = nested.scrollHeight;
      nested.dispatchEvent(new Event('scroll'));
      await settle();
      const last = cards().find(element => Number(element.dataset.assetIndex) === config.count - 1);
      metrics.lastIndex = last ? Number(last.dataset.assetIndex) : -1;
      metrics.finalCardCount = cards().length;
      const lastBounds = last ? rect(last) : null;
      const viewport = rect(nested);
      metrics.lastVisible = !!lastBounds && lastBounds.top >= viewport.top - 1 && lastBounds.bottom <= viewport.bottom + 1;
      if (last) {
        last.focus();
        nested.style.width = '250px';
        await settle();
        metrics.focusAfterResize = document.activeElement === last;
        metrics.afterResizeCount = cards().length;
        metrics.resizedRequiredControlsFit = controlsFit();
        metrics.resizedOriginItemsFit = originsFit();
        if (config.required) {
          const action = last.querySelector('.required-dependency-action');
          action.focus();
          metrics.requiredControlFocus = document.activeElement === action;
          const actionRect = rect(action);
          const hit = document.elementFromPoint((actionRect.left + actionRect.right) / 2, (actionRect.top + actionRect.bottom) / 2);
          metrics.requiredControlHit = !!hit && (hit === action || action.contains(hit));
          action.click();
          metrics.requiredExplanation = document.querySelector('#toast-message').textContent.includes('Required by 2B.pptx');
          last.focus();
        }
        last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        metrics.keyboardSelected = last.getAttribute('aria-selected') === 'true';
        last.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        metrics.keyboardSpace = last.getAttribute('aria-selected') === 'true';
      }
      metrics.scrollExtent = nested.scrollHeight;
      metrics.viewportHeight = nested.clientHeight;
    }
    document.querySelector('#geometry-result').textContent = JSON.stringify(metrics);
  } catch (error) {
    document.querySelector('#geometry-result').textContent = JSON.stringify({ error: error.stack || error.message });
  }
}

for (const review of [false, true]) {
  for (const required of [false, true]) {
    for (const count of [0, 1, 5, 500]) {
      for (const [width, height] of [[1100, 760], [1440, 900]]) {
        test(`rendered nested layout ${review ? 'Review' : 'Workspace'} ${count} assets ${width} ${required ? 'required' : 'ordinary'}`, {
          skip: browser ? false : 'Chrome/Chromium unavailable: rendered checks NOT RUN', timeout: 35000,
        }, async t => {
          const result = await rendered({ review, count, width, height, required });
          const detail = JSON.stringify(result);
          t.diagnostic(detail);
          assert.ok(result.sourceGap >= 7, detail);
          for (const invariant of ['contained', 'rowHeights', 'contentFits', 'cardNonOverlap', 'restoreHit', 'restoreFocus', 'sourceSelected', 'sourceExcluded', 'requiredControlsFit', 'originItemsFit']) {
            assert.ok(result[invariant], invariant + ': ' + detail);
          }
          if (count > 40) {
            assert.ok(result.initialCardCount <= 36, detail);
            assert.ok(result.finalCardCount <= 36, detail);
            assert.equal(result.lastIndex, count - 1, detail);
            assert.ok(result.lastVisible, detail);
            assert.ok(result.focusAfterResize, detail);
            assert.ok(result.afterResizeCount <= 36, detail);
            assert.ok(result.resizedRequiredControlsFit, detail);
            assert.ok(result.resizedOriginItemsFit, detail);
            if (required) assert.ok(result.requiredControlFocus && result.requiredControlHit && result.requiredExplanation, detail);
            assert.ok(result.keyboardSelected && result.keyboardSpace, detail);
            assert.ok(result.scrollExtent > result.viewportHeight, detail);
          }
        });
      }
    }
  }
}
