'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const RENDERER_PATH = path.join(ROOT, 'renderer', 'index.html');
const PRELOAD_PATH = path.join(__dirname, 'ui-stability-preload.js');
const MAIN_SOURCE_PATH = path.join(ROOT, 'main.js');
const SHOW_WINDOW = process.env.CRATE_UI_SHOW === '1';
const EVIDENCE_DIR = process.env.CRATE_UI_EVIDENCE_DIR
  ? path.resolve(process.env.CRATE_UI_EVIDENCE_DIR)
  : null;
const TOLERANCE_PX = 1;
const TEST_TIMEOUT_MS = 30_000;
const temporaryUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-ui-stability-'));

app.setPath('userData', temporaryUserData);
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

function readConfiguredMinimumWindow() {
  const source = fs.readFileSync(MAIN_SOURCE_PATH, 'utf8');
  const minWidthMatch = source.match(/minWidth:\s*(\d+)/);
  const minHeightMatch = source.match(/minHeight:\s*(\d+)/);
  if (!minWidthMatch || !minHeightMatch) {
    throw new Error('Could not resolve Crate minimum BrowserWindow dimensions.');
  }
  return {
    width: Number(minWidthMatch[1]),
    height: Number(minHeightMatch[1]),
  };
}

function uniqueSizes(sizes) {
  const seen = new Set();
  return sizes.filter(size => {
    const key = `${size.width}x${size.height}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function expectedAssetColumns(workspaceWidth) {
  if (workspaceWidth <= 420) return 1;
  if (workspaceWidth <= 560) return 2;
  if (workspaceWidth <= 900) return 3;
  return 4;
}

function rectanglesOverlap(first, second) {
  if (!first || !second) return false;
  return (
    Math.min(first.right, second.right) - Math.max(first.left, second.left) > TOLERANCE_PX
    && Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top) > TOLERANCE_PX
  );
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForExpression(window, expression, label, timeoutMs = TEST_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matched = await window.webContents.executeJavaScript(`Boolean(${expression})`, true);
    if (matched) return;
    await wait(40);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function settleLayout(window) {
  await window.webContents.executeJavaScript(`new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })`, true);
  await wait(40);
}

async function waitForPreviewMetricsToSettle(window) {
  let previous = null;
  let stableReads = 0;
  const deadline = Date.now() + TEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const metrics = await window.webContents.executeJavaScript('window.crateUiHarness.getMetrics()', true);
    const current = metrics.getFileVisual;
    if (current === previous) stableReads += 1;
    else stableReads = 0;
    if (stableReads >= 4) return metrics;
    previous = current;
    await wait(50);
  }
  throw new Error('Preview request metrics did not settle.');
}

async function collectGeometry(window) {
  return window.webContents.executeJavaScript(`(() => {
    const rect = selector => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const value = element.getBoundingClientRect();
      return {
        left: value.left,
        top: value.top,
        right: value.right,
        bottom: value.bottom,
        width: value.width,
        height: value.height,
      };
    };
    const dimensions = selector => {
      const element = document.querySelector(selector);
      return element ? {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      } : null;
    };
    const cards = [...document.querySelectorAll('#added-assets-list > .asset-file-row:not(.filtered-out)')];
    const workspace = document.querySelector('#asset-review-workspace');
    const workspaceRect = workspace?.getBoundingClientRect() || null;
    const cardRects = cards.slice(0, 32).map(card => card.getBoundingClientRect());
    const firstTop = cardRects[0]?.top ?? null;
    const firstRowColumns = firstTop === null
      ? 0
      : cardRects.filter(card => Math.abs(card.top - firstTop) <= 1).length;
    const outsideCards = workspaceRect
      ? cardRects.filter(card => (
        card.left < workspaceRect.left - 1 || card.right > workspaceRect.right + 1
      )).length
      : 0;
    const activeFilter = document.querySelector('.asset-filter.active')?.dataset.assetFilter || null;
    const root = document.documentElement;
    const body = document.body;
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      root: { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth },
      body: { clientWidth: body.clientWidth, scrollWidth: body.scrollWidth },
      app: dimensions('#app'),
      sidebar: dimensions('.app-sidebar'),
      main: dimensions('.app-main'),
      content: dimensions('.app-content'),
      currentProject: dimensions('#tab-current-project'),
      filesView: dimensions('#files-view'),
      assetReview: dimensions('#asset-review-workspace'),
      rects: {
        sidebar: rect('.app-sidebar'),
        main: rect('.app-main'),
        content: rect('.app-content'),
        assetReview: rect('#asset-review-workspace'),
        back: rect('#btn-review-assets-back'),
        heading: rect('.asset-review-header > div'),
        search: rect('.asset-review-search'),
        filters: rect('#asset-review-filters'),
        summary: rect('#asset-review-summary'),
        actions: rect('.asset-review-toolbar .asset-panel-actions'),
        existing: rect('#existing-assets-section'),
        added: rect('#added-assets-section'),
        footer: rect('.asset-review-footer'),
      },
      firstRowColumns,
      minimumMeasuredCardWidth: cardRects.length
        ? Math.min(...cardRects.map(card => card.width))
        : null,
      outsideCards,
      visibleAddedCards: cards.length,
      searchValue: document.querySelector('#asset-review-search')?.value || '',
      activeFilter,
    };
  })()`, true);
}

function evaluateGeometry(geometry, sizeLabel) {
  const failures = [];
  const assertFits = (label, dimensions) => {
    if (!dimensions) failures.push(`${sizeLabel}: missing ${label}`);
    else if (dimensions.scrollWidth > dimensions.clientWidth + TOLERANCE_PX) {
      failures.push(
        `${sizeLabel}: ${label} scrollWidth ${dimensions.scrollWidth} exceeds clientWidth ${dimensions.clientWidth}`,
      );
    }
  };

  if (geometry.root.scrollWidth > geometry.root.clientWidth + TOLERANCE_PX) {
    failures.push(`${sizeLabel}: document has horizontal overflow`);
  }
  if (geometry.body.scrollWidth > geometry.body.clientWidth + TOLERANCE_PX) {
    failures.push(`${sizeLabel}: body has horizontal overflow`);
  }
  assertFits('app', geometry.app);
  assertFits('main content', geometry.main);
  assertFits('app content', geometry.content);
  assertFits('Current Project', geometry.currentProject);
  assertFits('files view', geometry.filesView);
  assertFits('Review Assets', geometry.assetReview);

  if (rectanglesOverlap(geometry.rects.sidebar, geometry.rects.main)) {
    failures.push(`${sizeLabel}: sidebar overlaps main content`);
  }
  if (rectanglesOverlap(geometry.rects.heading, geometry.rects.search)) {
    failures.push(`${sizeLabel}: Review Assets heading overlaps search`);
  }
  if (rectanglesOverlap(geometry.rects.summary, geometry.rects.actions)) {
    failures.push(`${sizeLabel}: asset summary overlaps bulk actions`);
  }

  const footerOverlapTargets = [
    ['Review Assets back control', geometry.rects.back],
    ['Review Assets heading', geometry.rects.heading],
    ['Review Assets search', geometry.rects.search],
    ['asset filters', geometry.rects.filters],
    ['asset summary', geometry.rects.summary],
    ['bulk actions', geometry.rects.actions],
  ];
  for (const [label, target] of footerOverlapTargets) {
    if (rectanglesOverlap(geometry.rects.footer, target)) {
      failures.push(`${sizeLabel}: Review Assets footer overlaps ${label}`);
    }
  }

  if (geometry.outsideCards > 0) {
    failures.push(`${sizeLabel}: ${geometry.outsideCards} sampled cards cross the workspace boundary`);
  }
  if (geometry.rects.footer && geometry.rects.assetReview) {
    if (
      geometry.rects.footer.left < geometry.rects.assetReview.left - TOLERANCE_PX
      || geometry.rects.footer.right > geometry.rects.assetReview.right + TOLERANCE_PX
    ) {
      failures.push(`${sizeLabel}: Review Assets footer crosses its workspace boundary`);
    }
  }

  const expectedColumns = expectedAssetColumns(geometry.assetReview?.clientWidth || 0);
  if (geometry.firstRowColumns !== expectedColumns) {
    failures.push(
      `${sizeLabel}: expected ${expectedColumns} asset columns at Review Assets width `
      + `${geometry.assetReview?.clientWidth}, observed ${geometry.firstRowColumns}`,
    );
  }
  if (geometry.minimumMeasuredCardWidth !== null && geometry.minimumMeasuredCardWidth < 150) {
    failures.push(
      `${sizeLabel}: measured card width ${geometry.minimumMeasuredCardWidth.toFixed(1)}px is below 150px`,
    );
  }

  return failures;
}

async function captureScreenshot(window, size) {
  if (!EVIDENCE_DIR) return null;
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const name = `crate-ui-stability-${size.width}x${size.height}.png`;
  const destination = path.join(EVIDENCE_DIR, name);
  const image = await window.webContents.capturePage();
  fs.writeFileSync(destination, image.toPNG(), { mode: 0o600 });
  return { name, bytes: fs.statSync(destination).size };
}

async function run() {
  const configuredMinimum = readConfiguredMinimumWindow();
  const sizes = uniqueSizes([
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
    { width: 1200, height: 800 },
    { width: 1100, height: 760 },
    { width: 1040, height: 760 },
    { width: 960, height: 760 },
    { width: 900, height: 700 },
    configuredMinimum,
  ]);
  const pageErrors = [];
  const consoleErrors = [];
  const results = [];
  const failures = [];

  const window = new BrowserWindow({
    width: sizes[0].width,
    height: sizes[0].height,
    show: SHOW_WINDOW,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) consoleErrors.push(String(message));
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    pageErrors.push(`render-process-gone: ${details.reason}`);
  });

  try {
    await window.loadFile(RENDERER_PATH);
    await waitForExpression(
      window,
      "document.querySelectorAll('#project-rows .project-row').length === 1",
      'synthetic project row',
    );
    await window.webContents.executeJavaScript(
      "document.querySelector('#project-rows .project-row').click()",
      true,
    );
    await waitForExpression(
      window,
      "!document.querySelector('#files-view').classList.contains('hidden')",
      'Current Project workspace',
    );
    await waitForExpression(
      window,
      "document.querySelectorAll('#added-assets-list > .asset-file-row').length === 256",
      'large synthetic asset workspace',
    );
    await window.webContents.executeJavaScript(
      "document.querySelector('#btn-review-assets').click()",
      true,
    );
    await waitForExpression(
      window,
      "!document.querySelector('#asset-review-workspace').classList.contains('hidden')",
      'Review Assets workspace',
    );
    await settleLayout(window);
    const initialPreviewMetrics = await waitForPreviewMetricsToSettle(window);
    await window.webContents.executeJavaScript('window.crateUiHarness.resetMetrics()', true);

    for (const size of sizes) {
      window.setContentSize(size.width, size.height, false);
      await settleLayout(window);
      const geometry = await collectGeometry(window);
      const sizeLabel = `${size.width}x${size.height}`;
      const sizeFailures = evaluateGeometry(geometry, sizeLabel);
      failures.push(...sizeFailures);
      results.push({
        size,
        geometry,
        failures: sizeFailures,
        screenshot: await captureScreenshot(window, size),
      });
    }

    await window.webContents.executeJavaScript(`(() => {
      const search = document.querySelector('#asset-review-search');
      search.value = 'Synthetic_Figma_Asset_00';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.asset-filter[data-asset-filter="added"]').click();
    })()`, true);
    await settleLayout(window);
    const beforeStateResize = await collectGeometry(window);
    window.setContentSize(1200, 800, false);
    await settleLayout(window);
    window.setContentSize(configuredMinimum.width, configuredMinimum.height, false);
    await settleLayout(window);
    const afterStateResize = await collectGeometry(window);

    if (afterStateResize.searchValue !== beforeStateResize.searchValue) {
      failures.push('search query changed during resize sequence');
    }
    if (afterStateResize.activeFilter !== beforeStateResize.activeFilter) {
      failures.push('active asset filter changed during resize sequence');
    }

    const resizeMetrics = await window.webContents.executeJavaScript(
      'window.crateUiHarness.getMetrics()',
      true,
    );
    if (resizeMetrics.getProjects !== 0) {
      failures.push(`resize triggered ${resizeMetrics.getProjects} getProjects calls`);
    }
    if (resizeMetrics.getAssetWorkspace !== 0) {
      failures.push(`resize triggered ${resizeMetrics.getAssetWorkspace} getAssetWorkspace calls`);
    }
    if (resizeMetrics.getFileVisual !== 0) {
      failures.push(`resize triggered ${resizeMetrics.getFileVisual} new preview requests`);
    }

    const report = {
      schemaVersion: 1,
      configuredMinimum,
      fixture: await window.webContents.executeJavaScript('window.crateUiHarness.getExpected()', true),
      initialPreviewMetrics,
      resizeMetrics,
      pageErrors,
      consoleErrors,
      results,
      statePreservation: {
        before: {
          searchValue: beforeStateResize.searchValue,
          activeFilter: beforeStateResize.activeFilter,
        },
        after: {
          searchValue: afterStateResize.searchValue,
          activeFilter: afterStateResize.activeFilter,
        },
      },
      failures,
    };

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (pageErrors.length || consoleErrors.length || failures.length) process.exitCode = 1;
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

app.whenReady()
  .then(run)
  .catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await app.quit();
    fs.rmSync(temporaryUserData, { recursive: true, force: true });
  });
