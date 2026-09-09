'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { DESKTOP_WINDOW_MINIMUM } = require('../startup-phase-journal');

const rendererDir = path.join(__dirname, '..', 'renderer');
const stylesHref = new URL(`file://${path.join(rendererDir, 'styles.css')}`).href;
const rendererIndex = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
const stabilityMatch = rendererIndex.match(/<style id="crate-ui-stability">([\s\S]*?)<\/style>/u);
assert.ok(stabilityMatch, 'renderer/index.html must contain the source-bound UI-stability style block');
const stabilityStyles = stabilityMatch[1];
const viewports = [
  [1440, 900],
  [1280, 800],
  [1200, 800],
  [DESKTOP_WINDOW_MINIMUM.width, DESKTOP_WINDOW_MINIMUM.height],
];

function findBrowser() {
  const candidates = [
    process.env.CRATE_UI_TEST_BROWSER,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
  }

  for (const command of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
    const result = childProcess.spawnSync('/usr/bin/env', ['sh', '-lc', `command -v ${command}`], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    const resolved = result.status === 0 ? result.stdout.trim() : '';
    if (resolved && fs.existsSync(resolved)) return resolved;
  }

  return null;
}

function fixtureHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="${stylesHref}">
  <style>${stabilityStyles}</style>
</head>
<body>
  <div id="app">
    <aside class="app-sidebar" id="app-sidebar">
      <div class="sidebar-brand"><span class="app-logo">CRATE</span></div>
      <nav class="app-tabs"><button class="app-tab active">Projects</button><button class="app-tab">Project Workspace</button><button class="app-tab">Quick Package</button></nav>
      <div class="sidebar-spacer"></div>
      <nav class="app-tabs app-tabs-secondary"><button class="app-tab">Settings</button><button class="app-tab">Help</button></nav>
    </aside>
    <main class="app-main" id="app-main">
      <div class="app-content">
        <div class="tab-content active" id="tab-current-project">
          <div id="files-view">
            <section class="asset-review-workspace" id="asset-review-workspace">
              <button class="asset-review-back">&lsaquo; Project Workspace</button>
              <div class="asset-review-header">
                <div id="review-copy"><h1>Review Assets</h1><p>Everything is included automatically. Use × only when something does not belong.</p></div>
                <label class="asset-review-search"><input type="search" value="synthetic query"></label>
              </div>
              <div class="asset-review-filters"><button class="asset-filter active">All 263</button><button class="asset-filter">Existing 7</button><button class="asset-filter">Added 256</button><button class="asset-filter">Needs Linking 0</button><button class="asset-filter">Excluded 0</button></div>
              <div class="asset-review-toolbar"><div id="asset-review-summary">263 assets included · 4 Working Files ready</div><div class="asset-panel-actions"><button class="asset-batch-button primary">Include All Existing</button><button class="asset-batch-button">Skip All Existing</button></div></div>
              <div class="asset-workspace"><section class="asset-panel"><div class="asset-panel-header"><h2 class="asset-panel-title">Added While Working</h2><span class="asset-panel-count">256</span></div><div class="asset-file-list asset-card-grid" id="added-assets-list"></div></section></div>
              <footer class="asset-review-footer"><span id="asset-review-footer-summary">263 assets included</span><div><button class="modal-btn-secondary">Back</button><button class="modal-btn-primary">Continue</button></div></footer>
            </section>
          </div>
        </div>
      </div>
    </main>
  </div>
  <pre id="geometry-result"></pre>
  <script>
    const logicalRowHeight = 58;
    const logicalRowCount = 263;
    const mountedRowLimit = 36;
    const list = document.getElementById('added-assets-list');
    list.classList.add('asset-virtual-list');
    list.style.position = 'relative';
    list.style.height = String(logicalRowCount * logicalRowHeight) + 'px';
    list.style.setProperty('--asset-review-logical-height', String(logicalRowCount * logicalRowHeight) + 'px');
    list.style.overflow = 'auto';
    const renderRange = start => {
      list.replaceChildren();
      const end = Math.min(logicalRowCount, start + mountedRowLimit);
      for (let index = start; index < end; index += 1) {
        const row = document.createElement('div');
        row.className = 'app-file asset-file-row';
        row.style.position = 'absolute';
        row.style.top = String(index * logicalRowHeight) + 'px';
        row.style.left = '0';
        row.style.right = '0';
        row.style.height = String(logicalRowHeight) + 'px';
        row.style.minHeight = String(logicalRowHeight) + 'px';
        row.dataset.assetIndex = String(index);
        row.innerHTML = '<span class="file-visual"><span class="file-visual-badge">PNG</span></span><div class="asset-file-copy"><div class="app-file-name">Synthetic_Figma_Asset_' + String(index + 1).padStart(4, '0') + '_with_a_long_name.png</div><div class="file-origin"><span class="file-origin-mark figma">F</span><span class="file-origin-label">Figma · Current Page</span></div></div><span class="file-status-badge linked">LNK</span><button class="app-file-remove">×</button>';
        list.appendChild(row);
      }
    };
    renderRange(0);

    const rect = selector => document.querySelector(selector).getBoundingClientRect();
    const overlaps = (left, right) => !(
      left.right <= right.left + 0.5 ||
      right.right <= left.left + 0.5 ||
      left.bottom <= right.top + 0.5 ||
      right.bottom <= left.top + 0.5
    );
    const within = (child, parent) => (
      child.left >= parent.left - 1 &&
      child.right <= parent.right + 1 &&
      child.top >= parent.top - 1
    );
    const root = document.documentElement;
    const app = document.getElementById('app');
    const content = document.querySelector('.app-content');
    const review = document.getElementById('asset-review-workspace');
    const grid = document.getElementById('added-assets-list');
    const initialCards = Array.from(grid.children);
    const reviewRect = rect('#asset-review-workspace');
    const headerRect = rect('#review-copy');
    const searchRect = rect('.asset-review-search');
    const filtersRect = rect('.asset-review-filters');
    const summaryRect = rect('#asset-review-summary');
    const actionsRect = rect('.asset-review-toolbar .asset-panel-actions');
    const footerRect = rect('.asset-review-footer');
    const sidebarRect = rect('.app-sidebar');
    const cardRects = initialCards.slice(0, 12).map(card => card.getBoundingClientRect());
    const initialListRect = grid.getBoundingClientRect();
    const initialRowRects = initialCards.slice(0, 12).map(card => card.getBoundingClientRect());
    const initialRowHeight = initialRowRects[0]?.height ?? 0;
    const initialRowTopDelta = initialRowRects[1]
      ? initialRowRects[1].top - initialRowRects[0].top
      : 0;
    const initialAdjacentNonOverlap = initialRowRects.every((card, index) => (
      index === 0 || card.top >= initialRowRects[index - 1].bottom - 0.5
    ));
    const maxScrollTop = Math.max(0, grid.scrollHeight - grid.clientHeight);
    grid.scrollTop = maxScrollTop;
    renderRange(logicalRowCount - mountedRowLimit);
    const finalCards = Array.from(grid.children);
    const finalRow = finalCards.find(card => card.dataset.assetIndex === String(logicalRowCount - 1));
    const finalListRect = grid.getBoundingClientRect();
    const finalRowRect = finalRow?.getBoundingClientRect() || null;
    const columns = getComputedStyle(grid).gridTemplateColumns.split(/\\s+/).filter(Boolean).length;
    const navigationLabelsVisible = Array.from(document.querySelectorAll('.app-tab')).every(button => {
      const value = button.getBoundingClientRect();
      return value.width > 1 && value.height > 1 && button.textContent.trim().length > 0;
    });
    const metrics = {
      innerWidth,
      root: { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth },
      app: { clientWidth: app.clientWidth, scrollWidth: app.scrollWidth },
      content: { clientWidth: content.clientWidth, scrollWidth: content.scrollWidth },
      review: { clientWidth: review.clientWidth, scrollWidth: review.scrollWidth },
      columns,
      minimumCardWidth: Math.min(...cardRects.map(card => card.width)),
      initialMountedRows: initialCards.length,
      finalMountedRows: finalCards.length,
      rowHeight: initialRowHeight,
      rowTopDelta: initialRowTopDelta,
      adjacentNonOverlap: initialAdjacentNonOverlap,
      logicalScrollHeight: grid.scrollHeight,
      logicalHeight: logicalRowCount * logicalRowHeight,
      finalMountedIndex: finalCards.at(-1)?.dataset.assetIndex
        ? Number(finalCards.at(-1).dataset.assetIndex)
        : null,
      lastRowVisible: Boolean(
        finalRowRect
        && finalRowRect.top >= finalListRect.top - 1
        && finalRowRect.bottom <= finalListRect.bottom + 1
      ),
      finalScrollTop: grid.scrollTop,
      initialListHeight: initialListRect.height,
      compactNavigationActive: matchMedia('(max-width: 760px)').matches,
      navigationLabelsVisible,
      desktopSidebarVisible: sidebarRect.width >= 180 && sidebarRect.height >= innerHeight - 2,
      headerSearchOverlap: overlaps(headerRect, searchRect),
      summaryActionsOverlap: overlaps(summaryRect, actionsRect),
      footerFiltersOverlap: overlaps(footerRect, filtersRect),
      footerSummaryOverlap: overlaps(footerRect, summaryRect),
      footerActionsOverlap: overlaps(footerRect, actionsRect),
      footerContained: within(footerRect, reviewRect) && footerRect.right <= reviewRect.right + 1,
      cardsContained: cardRects.every(card => within(card, reviewRect) && card.right <= reviewRect.right + 1),
      query: document.querySelector('.asset-review-search input').value,
    };
    document.getElementById('geometry-result').textContent = JSON.stringify(metrics);
  </script>
</body>
</html>`;
}

function productionWorkingFilesFixture() {
  // Keep the real markup, styles, and renderer. Only startup IPC is replaced
  // with synthetic data; rows and virtual ranges are built by renderFiles().
  const html = rendererIndex
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]+>/u, '')
    .replace(/<link[^>]+https:\/\/fonts\.googleapis\.com[^>]+>/u, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, '')
    .replace('<head>', `<head><base href="${new URL(`file://${rendererDir}/`).href}">`);
  const probe = String.raw`
    document.removeEventListener('DOMContentLoaded', init);
    (async () => {
      const results = [];
      let workspace;
      let previewRequests = 0;
      window.crate = {
        getAssetWorkspace: async () => workspace,
        getFileVisual: async () => { previewRequests += 1; return { kind: 'fallback' }; },
      };
      // This geometry probe measures the authenticated workspace, not onboarding.
      accountStatus = { revision: 1, state: 'signed_in', canUseWorkspace: true, identity: { id: 'geometry-account' }, message: '' };
      renderAccount();
      document.querySelector('#tab-projects').classList.remove('active');
      document.querySelector('#tab-current-project').classList.add('active');
      const working = document.querySelector('#project-file-list');
      const added = document.querySelector('#added-assets-list');
      for (const [sourceCount, assetCount] of [[0, 0], [1, 30], [4, 263], [4, 500]]) {
        const files = [
          ...Array.from({ length: sourceCount }, (_, index) => ({
            name: 'Working_' + index + '.ai', ext: '.ai', projectRole: 'source',
            protectedSource: true, sourceRecoveryAllowed: index === 3,
            visualIdentity: 'source-' + index, visualRevision: 'source-revision-' + index,
          })),
          ...Array.from({ length: assetCount }, (_, index) => ({
            name: 'Asset_' + index + '.png', ext: '.png', projectRole: 'asset', assetOrigin: 'added',
            visualIdentity: 'asset-' + index, visualRevision: 'asset-revision-' + index,
          })),
        ];
        const project = { id: 'synthetic-flow-' + assetCount, files, pendingFiles: [], excludedAssetKeys: [] };
        workspace = { projectId: project.id, files, pendingFiles: [] };
        state.projects = [project];
        state.selectedProjectId = project.id;
        state.assetReviewOpen = true;
        await renderFiles();
        closeAssetReviewWorkspace();
        const rows = Array.from(working.querySelectorAll('.asset-file-row'));
        const rects = rows.map(row => row.getBoundingClientRect());
        const snapshot = {
          sourceCount, assetCount, previewRequests,
          display: getComputedStyle(working).display,
          gap: getComputedStyle(working).rowGap,
          positions: rows.map(row => getComputedStyle(row).position),
          gaps: rects.slice(1).map((rect, index) => rect.top - rects[index].bottom),
          sourceRows: rows.length,
          empty: working.querySelector('.asset-panel-empty')?.textContent || null,
          sourceVirtual: Boolean(working.__assetReviewVirtualState),
          sourceHeight: working.style.height,
          sourceControls: rows.map(row => Array.from(row.querySelectorAll('button')).map(button => button.className)),
          projectSelection: state.assetReviewSelectedKey,
        };
        const sourceRow = rows[0];
        openAssetReviewWorkspace();
        if (assetCount) {
          added.scrollTop = added.scrollHeight;
          added.dispatchEvent(new Event('scroll'));
          const finalRow = added.lastElementChild;
          const finalRect = finalRow.getBoundingClientRect();
          const listRect = added.getBoundingClientRect();
          snapshot.mounted = added.children.length;
          snapshot.rowHeight = finalRect.height;
          snapshot.finalIndex = Number(finalRow.dataset.assetIndex);
          snapshot.lastRowVisible = finalRect.top >= listRect.top - 1 && finalRect.bottom <= listRect.bottom + 1;
          finalRow.click();
        }
        closeAssetReviewWorkspace();
        snapshot.sourceRowPreserved = !sourceRow || working.firstElementChild === sourceRow;
        snapshot.sourceStillNormal = !working.__assetReviewVirtualState
          && rows.every(row => !row.style.position && !row.style.top);
        results.push(snapshot);
      }
      document.querySelector('#geometry-result').textContent = JSON.stringify({ results });
    })().catch(error => {
      document.querySelector('#geometry-result').textContent = JSON.stringify({ error: error.message });
    });
  `;
  return html.replace('</body>', `<pre id="geometry-result"></pre><script src="app.js"></script><script>${probe}</script></body>`);
}

// Chrome may finish --dump-dom without exiting. Close only this isolated
// browser through its private pipe, then require a clean native process exit.
function collectGeometryDom(browser, args) {
  return new Promise(resolve => {
    const child = childProcess.spawn(browser, [...args, '--remote-debugging-pipe'], {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', protocol = '', error = null, closeSent = false;
    let bytes = 0;
    const fail = failure => {
      error ||= failure;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      fail(Object.assign(new Error('Chrome geometry probe ETIMEDOUT'), { code: 'ETIMEDOUT' }));
    }, 30_000);
    const accountBytes = chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 8 * 1024 * 1024) {
        fail(new Error('Chrome geometry probe exceeded output limit'));
        return false;
      }
      return true;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdio[4].setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (!accountBytes(chunk)) return;
      stdout += chunk;
      if (!error && !closeSent && /<\/html>\s*$/.test(stdout)) {
        closeSent = true;
        child.stdio[3].write(JSON.stringify({ id: 1, method: 'Browser.close' }) + '\0');
      }
    });
    child.stderr.on('data', chunk => { if (accountBytes(chunk)) stderr += chunk; });
    child.stdio[4].on('data', chunk => {
      if (!accountBytes(chunk)) return;
      protocol += chunk;
      let end;
      while ((end = protocol.indexOf('\0')) !== -1) {
        const frame = protocol.slice(0, end);
        protocol = protocol.slice(end + 1);
        try {
          const response = JSON.parse(frame);
          if (response.id === 1 && response.error) fail(new Error('Chrome rejected Browser.close'));
        } catch (_) { fail(new Error('Chrome returned malformed close protocol')); }
      }
    });
    for (const stream of [child.stdout, child.stderr, child.stdio[3], child.stdio[4]]) {
      stream.on('error', fail);
    }
    child.on('error', failure => { error ||= failure; });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      if (!error && !/<\/html>\s*$/.test(stdout)) error = new Error('Chrome geometry DOM was incomplete');
      resolve({ status, signal, stdout, stderr, error });
    });
  });
}

async function runGeometryProbe(browser, width, height, html = fixtureHtml()) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-ui-geometry-'));
  const fixturePath = path.join(temporaryDirectory, 'fixture.html');
  fs.writeFileSync(fixturePath, html, 'utf8');

  try {
    const result = await collectGeometryDom(browser, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--allow-file-access-from-files',
      `--user-data-dir=${path.join(temporaryDirectory, 'profile')}`,
      `--window-size=${width},${height}`,
      '--dump-dom',
      new URL(`file://${fixturePath}`).href,
    ]);

    assert.ifError(result.error);
    assert.equal(result.signal, null, `browser terminated with ${result.signal}`);
    assert.equal(result.status, 0, result.stderr || `browser exited with ${result.status}`);
    const match = result.stdout.match(/<pre id="geometry-result">([^<]+)<\/pre>/);
    assert.ok(match, 'geometry probe must emit structured results');
    return JSON.parse(match[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

// Exercise the real helper with successful DOM output even when the process failed.
const probeResult = {
  status: 0,
  signal: null,
  stdout: '<html><pre id="geometry-result">{&quot;results&quot;:[&quot;A&amp;B&quot;]}</pre></html>',
  stderr: '',
};

function mockGeometryBrowser(t, result = probeResult, { holdOpen = false, pipeError = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdio = [null, child.stdout, child.stderr, new PassThrough(), new PassThrough()];
  const commands = [];
  const finish = (status, signal) => queueMicrotask(() => child.emit('close', status, signal));
  child.kill = signal => { finish(null, signal); return true; };
  child.stdio[3].on('data', chunk => {
    commands.push(chunk.toString());
    if (pipeError) child.stdio[3].emit('error', new Error('close pipe failed'));
    else if (!holdOpen) finish(result.status, result.signal);
  });
  const spawn = t.mock.method(childProcess, 'spawn', (_browser, args, options) => {
    assert.ok(args.includes('--remote-debugging-pipe'));
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe', 'pipe', 'pipe']);
    queueMicrotask(() => {
      if (result.error) child.emit('error', result.error);
      child.stdout.write(result.stdout);
      child.stderr.write(result.stderr);
      if (!holdOpen && !commands.length) finish(result.status, result.signal);
    });
    return child;
  });
  return { child, commands, spawn, finish };
}

for (const [label, failure, expected] of [
  ['timeout with zero exit status', { error: Object.assign(new Error('spawn ETIMEDOUT'), { code: 'ETIMEDOUT' }) }, /ETIMEDOUT/],
  ['spawn error', { error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }, /ENOENT/],
  ['signal with zero exit status', { signal: 'SIGTERM' }, /SIGTERM/],
  ['nonzero exit status', { status: 1 }, /browser exited with 1/],
  ['missing exit status', { status: null }, /browser exited with null/],
]) {
  test(`geometry probe rejects ${label} despite valid DOM`, async t => {
    const { spawn } = mockGeometryBrowser(t, { ...probeResult, ...failure });
    await assert.rejects(runGeometryProbe('fixture-browser', 1100, 760, '<!doctype html>'), expected);
    assert.equal(spawn.mock.callCount(), 1);
  });
}

test('geometry probe explicitly closes completed DOM and accepts only clean exit', async t => {
  const { commands, spawn } = mockGeometryBrowser(t);
  assert.deepEqual(await runGeometryProbe('fixture-browser', 1100, 760, '<!doctype html>'), { results: ['A&B'] });
  assert.deepEqual(commands, [JSON.stringify({ id: 1, method: 'Browser.close' }) + '\0']);
  assert.equal(spawn.mock.callCount(), 1);
});

test('geometry probe times out when completed DOM never gets a clean browser exit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { commands } = mockGeometryBrowser(t, probeResult, { holdOpen: true });
  const running = runGeometryProbe('fixture-browser', 1100, 760, '<!doctype html>');
  const rejected = assert.rejects(running, /ETIMEDOUT/);
  await new Promise(setImmediate);
  assert.equal(commands.length, 1);
  t.mock.timers.tick(30_000);
  await rejected;
});

test('geometry probe rejects shutdown pipe errors despite completed DOM', async t => {
  mockGeometryBrowser(t, probeResult, { pipeError: true });
  await assert.rejects(runGeometryProbe('fixture-browser', 1100, 760, '<!doctype html>'), /close pipe failed/);
});

test('geometry probe does not close or accept truncated DOM', async t => {
  const { commands } = mockGeometryBrowser(t, { ...probeResult, stdout: probeResult.stdout.replace('</html>', '') });
  await assert.rejects(runGeometryProbe('fixture-browser', 1100, 760, '<!doctype html>'), /DOM was incomplete/);
  assert.equal(commands.length, 0);
});

const browser = findBrowser();

test('production renderer preserves Working Files grid spacing and Review Assets virtual geometry', {
  skip: browser ? false : 'Chrome or Chromium is not available in this environment',
  timeout: 35_000,
}, async () => {
  const metrics = await runGeometryProbe(browser, 1100, 760, productionWorkingFilesFixture());
  assert.equal(metrics.error, undefined);
  assert.equal(metrics.results.length, 4);
  for (const result of metrics.results) {
    assert.equal(result.display, 'grid');
    assert.equal(result.gap, '8px');
    assert.equal(result.sourceRows, result.sourceCount);
    assert.equal(result.previewRequests, 0);
    assert.equal(result.sourceVirtual, false);
    assert.equal(result.sourceHeight, '');
    assert.ok(result.positions.every(position => position === 'static'));
    assert.ok(result.gaps.every(gap => Math.abs(gap - 8) < 0.5));
    assert.equal(result.sourceRowPreserved, true);
    assert.equal(result.sourceStillNormal, true);
    assert.equal(result.projectSelection, null);
    if (!result.sourceCount) assert.equal(result.empty, 'Add a project file to begin.');
    else assert.deepEqual(result.sourceControls[0], []);
    if (result.sourceCount === 4) assert.deepEqual(result.sourceControls[3], ['app-file-recovery']);
    if (result.assetCount) {
      assert.ok(result.mounted > 0 && result.mounted <= 36);
      assert.equal(result.rowHeight, 58);
      assert.equal(result.finalIndex, result.assetCount - 1);
      assert.equal(result.lastRowVisible, true);
    }
  }
});

test('real browser geometry keeps supported desktop Review Assets inside the Crate shell', {
  skip: browser ? false : 'Chrome or Chromium is not available in this environment',
  timeout: 120_000,
}, async () => {
  for (const [width, height] of viewports) {
    const metrics = await runGeometryProbe(browser, width, height);
    const label = `${width}x${height}`;

    assert.ok(metrics.root.scrollWidth <= metrics.root.clientWidth + 1, `${label}: root must not overflow horizontally`);
    assert.ok(metrics.app.scrollWidth <= metrics.app.clientWidth + 1, `${label}: app must not overflow horizontally`);
    assert.ok(metrics.content.scrollWidth <= metrics.content.clientWidth + 1, `${label}: content must not overflow horizontally`);
    assert.ok(metrics.review.scrollWidth <= metrics.review.clientWidth + 1, `${label}: Review Assets must not overflow horizontally`);
    assert.equal(metrics.compactNavigationActive, false, `${label}: compact navigation is not a supported desktop layout`);
    assert.equal(metrics.navigationLabelsVisible, true, `${label}: desktop navigation labels must remain visible`);
    assert.equal(metrics.desktopSidebarVisible, true, `${label}: desktop sidebar must remain visible`);
    assert.equal(metrics.headerSearchOverlap, false, `${label}: heading and search must not overlap`);
    assert.equal(metrics.summaryActionsOverlap, false, `${label}: summary and bulk actions must not overlap`);
    assert.equal(metrics.footerFiltersOverlap, false, `${label}: footer must not overlap filters`);
    assert.equal(metrics.footerSummaryOverlap, false, `${label}: footer must not overlap summary`);
    assert.equal(metrics.footerActionsOverlap, false, `${label}: footer must not overlap bulk actions`);
    assert.equal(metrics.footerContained, true, `${label}: footer must stay inside Review Assets`);
    assert.equal(metrics.cardsContained, true, `${label}: cards must stay inside Review Assets`);
    assert.ok(metrics.minimumCardWidth >= 150, `${label}: asset presentation must remain readable`);
    assert.equal(metrics.initialMountedRows, 36, `${label}: initial virtual window must stay bounded`);
    assert.equal(metrics.finalMountedRows, 36, `${label}: final virtual window must stay bounded`);
    assert.equal(metrics.rowHeight, 58, `${label}: virtual rows must have the fixed 58px height`);
    assert.equal(metrics.rowTopDelta, 58, `${label}: virtual rows must advance by their fixed height`);
    assert.equal(metrics.adjacentNonOverlap, true, `${label}: virtual rows must not overlap`);
    assert.equal(metrics.logicalScrollHeight, metrics.logicalHeight, `${label}: logical scroll range must include every row`);
    assert.equal(metrics.finalMountedIndex, 262, `${label}: final virtual window must mount the final logical row`);
    assert.equal(metrics.lastRowVisible, true, `${label}: final logical row must be visible at the end of the scroll range`);
    assert.equal(metrics.query, 'synthetic query', `${label}: search state must survive layout`);
  }
});

test('geometry probe rejects browser close protocol failure despite valid DOM', async t => {
  const { child } = mockGeometryBrowser(t, probeResult, { holdOpen: true });
  const running = runGeometryProbe('fixture-browser', 1100, 760, '<!doctype html>');
  const rejected = assert.rejects(running, /rejected Browser.close/);
  await new Promise(setImmediate);
  child.stdio[4].write(JSON.stringify({ id: 1, error: { code: -1 } }) + '\0');
  await rejected;
});

test('geometry probe keeps its output bound and rejects oversized DOM', async t => {
  mockGeometryBrowser(t, { ...probeResult, stdout: 'x'.repeat(8 * 1024 * 1024 + 1) });
  await assert.rejects(runGeometryProbe('fixture-browser', 1100, 760, '<!doctype html>'), /exceeded output limit/);
});
