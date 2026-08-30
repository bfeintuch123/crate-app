'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
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
    const result = spawnSync('/usr/bin/env', ['sh', '-lc', `command -v ${command}`], {
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

function runGeometryProbe(browser, width, height) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-ui-geometry-'));
  const fixturePath = path.join(temporaryDirectory, 'fixture.html');
  fs.writeFileSync(fixturePath, fixtureHtml(), 'utf8');

  try {
    const result = spawnSync(browser, [
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
    ], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });

    assert.equal(result.status, 0, result.stderr || `browser exited with ${result.status}`);
    const match = result.stdout.match(/<pre id="geometry-result">([^<]+)<\/pre>/);
    assert.ok(match, 'geometry probe must emit structured results');
    return JSON.parse(match[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

const browser = findBrowser();

test('real browser geometry keeps supported desktop Review Assets inside the Crate shell', {
  skip: browser ? false : 'Chrome or Chromium is not available in this environment',
  timeout: 120_000,
}, () => {
  for (const [width, height] of viewports) {
    const metrics = runGeometryProbe(browser, width, height);
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
