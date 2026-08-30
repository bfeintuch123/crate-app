'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');
const {
  DESKTOP_WINDOW_MINIMUM,
  applyDesktopWindowMinimum,
} = require('../startup-phase-journal');
const { SMOOTHNESS_ASSET_COUNTS } = require('./ui-smoothness-fixture');

const ROOT = path.join(__dirname, '..');
const RENDERER_PATH = path.join(ROOT, 'renderer', 'index.html');
const PRELOAD_PATH = path.join(__dirname, 'ui-smoothness-preload.js');
const SHOW_WINDOW = process.env.CRATE_SMOOTHNESS_SHOW === '1';
const EVIDENCE_DIR = process.env.CRATE_SMOOTHNESS_EVIDENCE_DIR
  ? path.resolve(process.env.CRATE_SMOOTHNESS_EVIDENCE_DIR)
  : null;
const TEST_TIMEOUT_MS = 45_000;
const QUIET_READS = 5;
const CANONICAL_BASE = '279dad5db5b5341c66d83bee9913849f17f0b9b1';
const temporaryUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-ui-smoothness-'));

app.setPath('userData', temporaryUserData);
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isAssetWorkspaceReady(expected) {
  return [
    ['#project-file-list', expected.representedSourceFiles],
    ['#existing-assets-list', expected.existingAssets],
    ['#added-assets-list', expected.addedAssets],
  ].every(([selector, count]) => {
    const list = document.querySelector(selector);
    if (!list || list.__assetReviewAllItems?.length !== count) return false;
    if (count === 0) {
      return !list.__assetReviewVirtualState && list.children.length === 1
        && list.children[0].className === 'asset-panel-empty';
    }
    return list.__assetReviewVirtualState?.items.length === count
      && list.style.height === `${count * 58}px`
      && list.children.length > 0 && list.children.length <= 36
      && Array.from(list.children).every(row => row.getAttribute('aria-setsize') === String(count));
  });
}

async function settleLayout(window) {
  await window.webContents.executeJavaScript(`new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })`, true);
  await wait(35);
}

async function waitForExpression(window, expression, label, timeoutMs = TEST_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matched = await window.webContents.executeJavaScript(`Boolean(${expression})`, true);
    if (matched) return;
    await wait(30);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function waitForQuietMetrics(window, timeoutMs = TEST_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let previousLength = -1;
  let stableReads = 0;
  while (Date.now() < deadline) {
    const metrics = await window.webContents.executeJavaScript(
      'window.crateSmoothnessHarness.getMetrics()',
      true,
    );
    const currentLength = Array.isArray(metrics.timeline) ? metrics.timeline.length : 0;
    if (currentLength === previousLength) stableReads += 1;
    else stableReads = 0;
    previousLength = currentLength;
    if (stableReads >= QUIET_READS) return metrics;
    await wait(40);
  }
  throw new Error('Smoothness metrics did not settle.');
}

async function resetMetrics(window) {
  return window.webContents.executeJavaScript(
    'window.crateSmoothnessHarness.resetMetrics()',
    true,
  );
}

async function installRendererObservers(window) {
  await window.webContents.executeJavaScript(`(() => {
    window.__crateSmoothnessPerformance = {
      longTasks: [],
      layoutShifts: [],
    };
    try {
      const longTaskObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          window.__crateSmoothnessPerformance.longTasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
          });
        }
      });
      longTaskObserver.observe({ entryTypes: ['longtask'] });
      window.__crateSmoothnessLongTaskObserver = longTaskObserver;
    } catch (_) {}
    try {
      const layoutShiftObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (entry.hadRecentInput) continue;
          window.__crateSmoothnessPerformance.layoutShifts.push({
            startTime: entry.startTime,
            value: entry.value,
          });
        }
      });
      layoutShiftObserver.observe({ entryTypes: ['layout-shift'] });
      window.__crateSmoothnessLayoutShiftObserver = layoutShiftObserver;
    } catch (_) {}
  })()`, true);
}

async function installMutationAudit(window) {
  return window.webContents.executeJavaScript(`(() => {
    for (const observer of window.__crateSmoothnessMutationObservers || []) observer.disconnect();
    const audit = {};
    const observers = [];
    const targets = {
      projectRows: '#project-rows',
      workingFiles: '#project-file-list',
      existingAssets: '#existing-assets-list',
      addedAssets: '#added-assets-list',
      pendingFiles: '#pending-file-list',
      appContent: '.app-content',
    };
    for (const [name, selector] of Object.entries(targets)) {
      const target = document.querySelector(selector);
      audit[name] = {
        selector,
        childListRecords: 0,
        attributesRecords: 0,
        addedNodes: 0,
        removedNodes: 0,
      };
      if (!target) continue;
      const observer = new MutationObserver(records => {
        for (const record of records) {
          if (record.type === 'childList') {
            audit[name].childListRecords += 1;
            audit[name].addedNodes += record.addedNodes.length;
            audit[name].removedNodes += record.removedNodes.length;
          } else if (record.type === 'attributes') {
            audit[name].attributesRecords += 1;
          }
        }
      });
      observer.observe(target, { childList: true, subtree: true, attributes: true });
      observers.push(observer);
    }
    window.__crateSmoothnessMutationAudit = audit;
    window.__crateSmoothnessMutationObservers = observers;
    return audit;
  })()`, true);
}

async function readMutationAudit(window) {
  return window.webContents.executeJavaScript(
    'JSON.parse(JSON.stringify(window.__crateSmoothnessMutationAudit || {}))',
    true,
  );
}

async function prepareReviewState(window, expected) {
  return window.webContents.executeJavaScript(`(() => {
    const search = document.querySelector('#asset-review-search');
    const selectedFilter = ${expected.addedAssets > 0 ? "'added'" : (expected.existingAssets > 0 ? "'existing'" : "'all'")};
    const filter = document.querySelector(
      '.asset-filter[data-asset-filter="' + selectedFilter + '"]'
    );
    const scroller = document.querySelector('.app-content');
    if (search) {
      search.value = 'Synthetic';
      search.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (filter) filter.click();
    if (scroller) scroller.scrollTop = Math.min(900, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
    if (search) search.focus();
    const primaryRow = document.querySelector(
      '#added-assets-list > .asset-file-row, #existing-assets-list > .asset-file-row, #project-file-list > .asset-file-row'
    );
    window.__crateSmoothnessNodeRefs = {
      primaryRow,
      primaryVisual: primaryRow?.querySelector('.file-visual') || null,
      primaryImage: primaryRow?.querySelector('.file-visual-image') || null,
    };
    return {
      searchValue: search?.value || '',
      activeFilter: document.querySelector('.asset-filter.active')?.dataset.assetFilter || null,
      scrollTop: scroller?.scrollTop || 0,
      focusId: document.activeElement?.id || null,
      primaryRowFound: Boolean(primaryRow),
      visibleRows: document.querySelectorAll('.asset-file-row:not(.filtered-out)').length,
    };
  })()`, true);
}

async function collectReviewState(window) {
  return window.webContents.executeJavaScript(`(() => {
    const scroller = document.querySelector('.app-content');
    const primaryRow = document.querySelector(
      '#added-assets-list > .asset-file-row, #existing-assets-list > .asset-file-row, #project-file-list > .asset-file-row'
    );
    const refs = window.__crateSmoothnessNodeRefs || {};
    return {
      searchValue: document.querySelector('#asset-review-search')?.value || '',
      activeFilter: document.querySelector('.asset-filter.active')?.dataset.assetFilter || null,
      scrollTop: scroller?.scrollTop || 0,
      focusId: document.activeElement?.id || null,
      reviewOpen: !document.querySelector('#asset-review-workspace')?.classList.contains('hidden'),
      primaryRowFound: Boolean(primaryRow),
      primaryRowPreserved: refs.primaryRow ? refs.primaryRow === primaryRow : null,
      primaryVisualPreserved: refs.primaryVisual
        ? refs.primaryVisual === primaryRow?.querySelector('.file-visual')
        : null,
      primaryImagePreserved: refs.primaryImage
        ? refs.primaryImage === primaryRow?.querySelector('.file-visual-image')
        : null,
      visibleRows: document.querySelectorAll('.asset-file-row:not(.filtered-out)').length,
      totalAssetRows: document.querySelectorAll(
        '#existing-assets-list > .asset-file-row, #added-assets-list > .asset-file-row'
      ).length,
    };
  })()`, true);
}

async function captureScreenshot(window, name) {
  if (!EVIDENCE_DIR) return null;
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true, mode: 0o700 });
  const destination = path.join(EVIDENCE_DIR, `${name}.png`);
  const image = await window.webContents.capturePage();
  fs.writeFileSync(destination, image.toPNG(), { mode: 0o600 });
  return { name: path.basename(destination), bytes: fs.statSync(destination).size };
}

async function activateTab(window, tabName) {
  const startedAt = Date.now();
  const beforeMetrics = await window.webContents.executeJavaScript(
    'window.crateSmoothnessHarness.getMetrics()',
    true,
  );
  await window.webContents.executeJavaScript(`(() => {
    document.querySelector('.app-tab[data-tab="${tabName}"]')?.click();
  })()`, true);
  await waitForExpression(
    window,
    `document.querySelector('#tab-${tabName}')?.classList.contains('active')`,
    `${tabName} tab acknowledgement`,
  );
  const acknowledgedMs = Date.now() - startedAt;
  const afterMetrics = await waitForQuietMetrics(window);
  return {
    tabName,
    acknowledgedMs,
    settledMs: Date.now() - startedAt,
    callDelta: diffCountMaps(beforeMetrics.calls, afterMetrics.calls),
    actionDelta: diffCountMaps(beforeMetrics.actions, afterMetrics.actions),
  };
}

function diffCountMaps(before = {}, after = {}) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const result = {};
  for (const key of keys) {
    const delta = Number(after?.[key] || 0) - Number(before?.[key] || 0);
    if (delta !== 0) result[key] = delta;
  }
  return result;
}

async function readControlState(window, selector) {
  return window.webContents.executeJavaScript(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    return {
      text: element.textContent.trim(),
      disabled: 'disabled' in element ? Boolean(element.disabled) : false,
      ariaBusy: element.getAttribute('aria-busy'),
      ariaDisabled: element.getAttribute('aria-disabled'),
      className: element.className,
    };
  })()`, true);
}

async function sampleActionFeedback(window, {
  selector,
  actionName,
  latency = 220,
  waitForSelector = null,
}) {
  await window.webContents.executeJavaScript(
    `window.crateSmoothnessHarness.setLatencies(${JSON.stringify({ read: 8, action: latency, visual: 2 })})`,
    true,
  );
  await resetMetrics(window);
  const before = await readControlState(window, selector);
  await window.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(selector)})?.click()`,
    true,
  );
  await wait(30);
  const immediate = await readControlState(window, selector);
  if (actionName) {
    await waitForExpression(
      window,
      `Number(window.crateSmoothnessHarness.getMetrics().actions[${JSON.stringify(actionName)}] || 0) >= 1`,
      `${actionName} action`,
    );
  }
  if (waitForSelector) {
    await waitForExpression(window, waitForSelector, `${actionName || selector} result`);
  }
  const metrics = await waitForQuietMetrics(window);
  const settled = await readControlState(window, selector);
  return {
    selector,
    actionName,
    before,
    immediate,
    settled,
    immediateAcknowledgement: Boolean(
      immediate
      && before
      && (
        immediate.disabled !== before.disabled
        || immediate.ariaBusy !== before.ariaBusy
        || immediate.ariaDisabled !== before.ariaDisabled
        || immediate.text !== before.text
      )
    ),
    metrics,
  };
}

async function auditNavigationAndFeedback(window) {
  const navigation = [];
  for (const tabName of ['projects', 'quick-package', 'current-project', 'settings', 'help']) {
    navigation.push(await activateTab(window, tabName));
  }

  await activateTab(window, 'projects');
  const projectPill = await sampleActionFeedback(window, {
    selector: '.project-pill',
    actionName: 'pauseProject',
  });

  await activateTab(window, 'current-project');
  const addFiles = await sampleActionFeedback(window, {
    selector: '#btn-add-files',
    actionName: 'addFiles',
  });

  await activateTab(window, 'settings');
  const figmaScan = await sampleActionFeedback(window, {
    selector: '#btn-figma-scan-now',
    actionName: 'figmaScanNow',
  });

  await activateTab(window, 'current-project');
  await resetMetrics(window);
  const packageButtonBefore = await readControlState(window, '#btn-package');
  const packageStartedAt = Date.now();
  await window.webContents.executeJavaScript(
    "document.querySelector('#btn-package')?.click()",
    true,
  );
  await wait(30);
  const packageButtonImmediate = await readControlState(window, '#btn-package');
  const packageModalImmediate = await window.webContents.executeJavaScript(
    "!document.querySelector('#modal-package')?.classList.contains('hidden')",
    true,
  );
  await waitForExpression(
    window,
    "!document.querySelector('#modal-package')?.classList.contains('hidden')",
    'Package Review modal',
  );
  await settleLayout(window);
  const packageModal = await window.webContents.executeJavaScript(`(() => {
    const modal = document.querySelector('#modal-package .modal');
    const rect = modal?.getBoundingClientRect();
    return {
      openedMs: ${Date.now()} - ${packageStartedAt},
      visible: !document.querySelector('#modal-package')?.classList.contains('hidden'),
      width: rect?.width || 0,
      height: rect?.height || 0,
      confirmDisabled: Boolean(document.querySelector('#btn-confirm-package')?.disabled),
      activeElementId: document.activeElement?.id || null,
    };
  })()`, true);
  const packageMetrics = await waitForQuietMetrics(window);
  await window.webContents.executeJavaScript(
    "document.querySelector('#btn-cancel-package')?.click()",
    true,
  );
  await settleLayout(window);

  return {
    navigation,
    actions: {
      projectPill,
      addFiles,
      figmaScan,
      packageReview: {
        before: packageButtonBefore,
        immediate: packageButtonImmediate,
        modalVisibleImmediately: packageModalImmediate,
        immediateAcknowledgement: Boolean(
          packageButtonBefore
          && packageButtonImmediate
          && (
            packageButtonBefore.disabled !== packageButtonImmediate.disabled
            || packageButtonBefore.text !== packageButtonImmediate.text
            || packageModalImmediate
          )
        ),
        modal: packageModal,
        metrics: packageMetrics,
      },
    },
  };
}

async function auditFixture(assetCount) {
  const pageErrors = [];
  const consoleErrors = [];
  const rendererProcessFailures = [];
  const startedAt = Date.now();
  const window = new BrowserWindow({
    width: DESKTOP_WINDOW_MINIMUM.width,
    height: DESKTOP_WINDOW_MINIMUM.height,
    show: SHOW_WINDOW,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: PRELOAD_PATH,
      additionalArguments: [
        `--crate-smoothness-assets=${assetCount}`,
        '--crate-smoothness-read-latency=8',
        '--crate-smoothness-action-latency=120',
        '--crate-smoothness-visual-latency=2',
      ],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });
  applyDesktopWindowMinimum(window);

  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) consoleErrors.push(String(message));
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    rendererProcessFailures.push(details.reason);
  });

  try {
    await window.loadFile(RENDERER_PATH);
    await waitForExpression(window, 'Boolean(window.crateSmoothnessHarness)', 'smoothness bridge');
    await installRendererObservers(window);
    await waitForExpression(
      window,
      "document.querySelectorAll('#project-rows .project-row').length === 1",
      'synthetic project row',
    );
    const startupMetrics = await waitForQuietMetrics(window);
    const projectClickAt = Date.now();
    await window.webContents.executeJavaScript(
      "document.querySelector('#project-rows .project-row')?.click()",
      true,
    );
    await waitForExpression(
      window,
      "!document.querySelector('#files-view')?.classList.contains('hidden')",
      'Project Workspace visibility',
    );
    const workspaceVisibleMs = Date.now() - projectClickAt;
    const expected = await window.webContents.executeJavaScript(
      'window.crateSmoothnessHarness.getExpected()',
      true,
    );
    await waitForExpression(
      window,
      `(${isAssetWorkspaceReady.toString()})(${JSON.stringify(expected)})`,
      `${assetCount}-asset workspace`,
    );
    const workspaceMetrics = await waitForQuietMetrics(window);
    const workspaceSettledMs = Date.now() - projectClickAt;

    const reviewClickAt = Date.now();
    await window.webContents.executeJavaScript(
      "document.querySelector('#btn-review-assets')?.click()",
      true,
    );
    await waitForExpression(
      window,
      "!document.querySelector('#asset-review-workspace')?.classList.contains('hidden')",
      'Review Assets visibility',
    );
    await settleLayout(window);
    const reviewOpenMs = Date.now() - reviewClickAt;
    const beforeState = await prepareReviewState(window, expected);

    await installMutationAudit(window);
    await resetMetrics(window);
    await window.webContents.executeJavaScript(
      "window.crateSmoothnessHarness.emitFilesUpdated('baseline-single')",
      true,
    );
    const singleUpdateMetrics = await waitForQuietMetrics(window);
    await settleLayout(window);
    const singleUpdate = {
      before: beforeState,
      after: await collectReviewState(window),
      metrics: singleUpdateMetrics,
      mutations: await readMutationAudit(window),
    };

    await prepareReviewState(window, expected);
    await installMutationAudit(window);
    await resetMetrics(window);
    await window.webContents.executeJavaScript(
      'window.crateSmoothnessHarness.emitFileBurst(10)',
      true,
    );
    const burstMetrics = await waitForQuietMetrics(window);
    await settleLayout(window);
    const burstUpdate = {
      after: await collectReviewState(window),
      metrics: burstMetrics,
      mutations: await readMutationAudit(window),
    };

    await activateTab(window, 'settings');
    await installMutationAudit(window);
    await resetMetrics(window);
    await window.webContents.executeJavaScript(
      "window.crateSmoothnessHarness.emitFilesUpdated('hidden-destination')",
      true,
    );
    const hiddenMetrics = await waitForQuietMetrics(window);
    await settleLayout(window);
    const hiddenDestinationUpdate = {
      metrics: hiddenMetrics,
      mutations: await readMutationAudit(window),
      settingsStillActive: await window.webContents.executeJavaScript(
        "document.querySelector('#tab-settings')?.classList.contains('active')",
        true,
      ),
    };

    const appWide = assetCount === 30
      ? await auditNavigationAndFeedback(window)
      : null;
    const performance = await window.webContents.executeJavaScript(
      'JSON.parse(JSON.stringify(window.__crateSmoothnessPerformance || {}))',
      true,
    );
    const finalMetrics = await window.webContents.executeJavaScript(
      'window.crateSmoothnessHarness.getMetrics()',
      true,
    );
    const screenshot = await captureScreenshot(window, `smoothness-baseline-${assetCount}-assets`);

    return {
      assetCount,
      expected,
      elapsedMs: Date.now() - startedAt,
      timings: {
        workspaceVisibleMs,
        workspaceSettledMs,
        reviewOpenMs,
      },
      startupMetrics,
      workspaceMetrics,
      singleUpdate,
      burstUpdate,
      hiddenDestinationUpdate,
      appWide,
      performance,
      finalMetrics,
      screenshot,
      pageErrors,
      consoleErrors,
      rendererProcessFailures,
    };
  } catch (error) {
    pageErrors.push(error && error.stack ? error.stack : String(error));
    return {
      assetCount,
      elapsedMs: Date.now() - startedAt,
      pageErrors,
      consoleErrors,
      rendererProcessFailures,
    };
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

function createFindings(results) {
  const findings = [];
  for (const result of results) {
    if (result.pageErrors?.length || result.consoleErrors?.length || result.rendererProcessFailures?.length) {
      findings.push({ assetCount: result.assetCount, category: 'harness-error', detail: 'Renderer or harness errors occurred.' });
      continue;
    }
    const single = result.singleUpdate;
    if (single?.after?.primaryRowFound && single.after.primaryRowPreserved === false) {
      findings.push({ assetCount: result.assetCount, category: 'node-rebuild', detail: 'One file event replaced an unchanged primary asset row.' });
    }
    if (single?.after?.primaryImagePreserved === false) {
      findings.push({ assetCount: result.assetCount, category: 'preview-rebuild', detail: 'One file event replaced an already loaded preview image.' });
    }
    if (Number(single?.metrics?.getFileVisual || 0) > 0) {
      findings.push({ assetCount: result.assetCount, category: 'preview-refetch', detail: `One file event requested ${single.metrics.getFileVisual} previews.` });
    }
    if (Number(result.burstUpdate?.metrics?.getProjects || 0) > 1) {
      findings.push({ assetCount: result.assetCount, category: 'event-burst', detail: `Ten file events triggered ${result.burstUpdate.metrics.getProjects} project reads.` });
    }
    if (Number(result.hiddenDestinationUpdate?.mutations?.projectRows?.addedNodes || 0) > 0) {
      findings.push({ assetCount: result.assetCount, category: 'hidden-rerender', detail: 'A hidden Projects destination rebuilt after a file event.' });
    }
    const previewRequests = Number(result.workspaceMetrics?.getFileVisual || 0);
    if (previewRequests > 36) {
      findings.push({ assetCount: result.assetCount, category: 'preview-mount-bound', detail: `${previewRequests} preview requests exceeded the mounted-row ceiling.` });
    }
  }

  const appWide = results.find(result => result.assetCount === 30)?.appWide;
  for (const [name, audit] of Object.entries(appWide?.actions || {})) {
    if (audit && audit.immediateAcknowledgement === false) {
      findings.push({ assetCount: 30, category: 'action-feedback', detail: `${name} had no immediate busy, disabled, label, or modal acknowledgement.` });
    }
  }
  return findings;
}

async function run() {
  const gitRead = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  const sourceCommit = gitRead(['rev-parse', 'HEAD']);
  if (gitRead(['merge-base', sourceCommit, CANONICAL_BASE]) !== CANONICAL_BASE) {
    throw new Error('Smoothness evidence canonical base is not an ancestor of the tested source.');
  }
  const sourceTreeDirty = gitRead(['status', '--porcelain', '--untracked-files=no']) !== '';
  const results = [];
  for (const assetCount of SMOOTHNESS_ASSET_COUNTS) {
    results.push(await auditFixture(assetCount));
  }
  const report = {
    schemaVersion: 1,
    kind: 'app-wide-smoothness-baseline',
    canonicalBase: CANONICAL_BASE,
    sourceCommit,
    sourceTreeDirty,
    minimumWindow: DESKTOP_WINDOW_MINIMUM,
    assetCounts: SMOOTHNESS_ASSET_COUNTS,
    results,
    findings: createFindings(results),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const harnessFailed = results.some(result => (
    result.pageErrors?.length || result.consoleErrors?.length || result.rendererProcessFailures?.length
  ));
  return harnessFailed ? 1 : 0;
}

let finalExitCode = 1;
app.whenReady()
  .then(run)
  .then(exitCode => { finalExitCode = exitCode === 0 ? 0 : 1; })
  .catch(error => {
    console.error(error && error.stack ? error.stack : error);
    finalExitCode = 1;
  })
  .finally(() => {
    try {
      fs.rmSync(temporaryUserData, { recursive: true, force: true });
    } catch (_) {
      finalExitCode = 1;
    }
    app.exit(finalExitCode);
  });
