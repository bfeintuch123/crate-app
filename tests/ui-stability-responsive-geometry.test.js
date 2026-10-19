'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const Module = require('node:module');
const originalLoad = Module._load;
const journalPath = require.resolve('../startup-phase-journal');
const previousJournalCache = require.cache[journalPath];
const electronModulePath = /[/\\]node_modules[/\\]electron(?:[/\\]|$)/u;
const previousElectronCache = Object.keys(require.cache).filter(id => electronModulePath.test(id));
const bootstrapListeners = [];
const electronStub = {
  app: {
    on(eventName, listener) {
      bootstrapListeners.push([eventName, listener]);
    },
  },
};
let stubbedElectronLoads = 0;
let rejectedElectronModuleLoads = 0;
let startupJournal;

// The journal imports Electron during evaluation. Fence that import before
// loading it: Electron's package entry can invoke its installer even when npm
// lifecycle scripts were disabled. Keep this stub local to the synchronous load.
delete require.cache[journalPath];
try {
  Module._load = function loadWithElectronStub(request, parent, isMain) {
    if (request === 'electron') {
      stubbedElectronLoads += 1;
      return electronStub;
    }
    if (electronModulePath.test(request)) {
      rejectedElectronModuleLoads += 1;
      throw new Error('Desktop minimum tests must not load Electron package files');
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  startupJournal = require('../startup-phase-journal');
} finally {
  Module._load = originalLoad;
  if (previousJournalCache) require.cache[journalPath] = previousJournalCache;
  else delete require.cache[journalPath];
}


const { DESKTOP_WINDOW_MINIMUM } = startupJournal;

test('geometry journal bootstrap uses the stub without loading Electron or its installer', () => {
  assert.equal(stubbedElectronLoads, 1);
  assert.equal(rejectedElectronModuleLoads, 0);
  assert.equal(bootstrapListeners.length, 1);
  assert.equal(bootstrapListeners[0][0], 'browser-window-created');
  assert.equal(typeof bootstrapListeners[0][1], 'function');
  assert.equal(Module._load, originalLoad);
  assert.equal(require.cache[journalPath], previousJournalCache);
  assert.deepEqual(
    Object.keys(require.cache).filter(id => electronModulePath.test(id)),
    previousElectronCache,
  );
});

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

// A native exit and inherited-pipe close are different events. Require the
// original DOM/exit contract, then reap only this probe's owned process group
// before callers may remove its profile. Neither teardown nor a late exit can
// turn a timed-out probe into a success.
function collectGeometryDom(browser, args) {
  return new Promise(resolve => {
    let child;
    try {
      child = childProcess.spawn(browser, [...args, '--remote-debugging-pipe'], {
        detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ status: null, signal: null, stdout: '', stderr: '', error, profileCleanupSafe: true });
      return;
    }
    let stdout = '', stderr = '', protocol = '', error = null, closeSent = false;
    let bytes = 0, settled = false, tearingDown = false, exited = false, spawnFailed = false;
    let status = null, signal = null, pollTimer, cleanupTimer, termTimer, killTimer, drainImmediate;
    const startedAt = Date.now(), stages = [{ stage: 'spawn', ms: 0 }], signals = [];
    const stage = name => { if (stages.length < 16) stages.push({ stage: name, ms: Date.now() - startedAt }); };
    const groupState = () => {
      if (!Number.isInteger(child.pid) || child.pid <= 0) return spawnFailed ? 'absent' : 'unknown';
      try { process.kill(-child.pid, 0); return 'present'; }
      catch (failure) { return failure.code === 'ESRCH' ? 'absent' : 'unknown'; }
    };
    const finish = profileCleanupSafe => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const pending of [pollTimer, cleanupTimer, termTimer, killTimer]) clearTimeout(pending);
      clearImmediate(drainImmediate);
      if (!error && !/<\/html>\s*$/.test(stdout)) error = new Error('Chrome geometry DOM was incomplete');
      const diagnostics = { stages, bytes, stdoutBytes: Buffer.byteLength(stdout),
        htmlEndSeen: stdout.includes('</html>'), stdoutTailTag: stdout.match(/<\/?([a-z0-9-]+)[^>]*>\s*$/i)?.[1] || null,
        exited, closeSent, signals, profileCleanupSafe,
        stderrTail: stderr.slice(-2048).replaceAll(/[\r\n]+/g, ' ')
          .replaceAll(/(?:https?|file):\/\/\S+/g, '[url]')
          .replaceAll(/\/(?:Users|var|private|tmp)\/[^\s)]+/g, '[path]') };
      if (error) error.message += `; geometry transport ${JSON.stringify(diagnostics)}`;
      for (const stream of [child.stdout, child.stderr, child.stdio[3], child.stdio[4]]) stream.destroy();
      if (!profileCleanupSafe) child.unref?.();
      resolve({ status, signal, stdout, stderr, error, diagnostics, profileCleanupSafe });
    };
    const inspectTeardown = () => {
      if (settled) return;
      if ((exited || spawnFailed) && groupState() === 'absent') {
        // Give already-buffered pipe data/errors one final event-loop turn;
        // inherited pipes need not emit close after their process group is gone.
        if (!drainImmediate) drainImmediate = setImmediate(() => {
          drainImmediate = null;
          if (groupState() === 'absent') { stage('teardown-complete'); finish(true); }
          else inspectTeardown();
        });
        return;
      }
      clearTimeout(pollTimer);
      pollTimer = setTimeout(inspectTeardown, 25);
    };
    const signalOwnedGroup = value => {
      if (settled || groupState() !== 'present') return;
      try { process.kill(-child.pid, value); signals.push(value); stage(value); }
      catch (failure) { if (failure.code !== 'ESRCH') error ||= new Error('Chrome owned-group termination failed'); }
      inspectTeardown();
    };
    const beginTeardown = () => {
      if (settled || tearingDown) return;
      tearingDown = true; clearTimeout(timer); stage('teardown-start');
      cleanupTimer = setTimeout(() => {
        error ||= new Error('Chrome geometry teardown could not be confirmed; private profile retained');
        stage('teardown-unconfirmed'); finish(false);
      }, 3000);
      // The DOM/clean-main-exit success requirement remains in the caller.
      // Residual descendants cannot withhold pipe close or race profile removal.
      termTimer = setTimeout(() => signalOwnedGroup('SIGTERM'), 200);
      killTimer = setTimeout(() => signalOwnedGroup('SIGKILL'), 800);
      inspectTeardown();
    };
    const fail = failure => {
      if (settled) return;
      error ||= failure; beginTeardown();
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
      if (!stdout) stage('first-output');
      stdout += chunk;
      if (!error && !closeSent && /<\/html>\s*$/.test(stdout)) {
        stage('dom-complete');
        closeSent = true;
        if (!exited) {
          stage('browser-close-sent');
          child.stdio[3].write(JSON.stringify({ id: 1, method: 'Browser.close' }) + '\0', failure => { if (failure) fail(failure); });
        } else beginTeardown();
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
    child.on('error', failure => { spawnFailed = !Number.isInteger(child.pid); fail(failure); });
    const exitedNative = (code, nativeSignal) => {
      if (settled) return;
      if (!exited) { exited = true; status = code; signal = nativeSignal; stage('native-exit'); }
      if (error || status !== 0 || signal !== null || /<\/html>\s*$/.test(stdout)) beginTeardown();
      if (tearingDown) inspectTeardown();
    };
    child.on('exit', exitedNative);
    child.on('close', (code, nativeSignal) => {
      exitedNative(code, nativeSignal);
      if (!settled && !/<\/html>\s*$/.test(stdout)) fail(new Error('Chrome geometry DOM was incomplete'));
    });
  });
}

async function runGeometryProbe(browser, width, height, html = fixtureHtml()) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-ui-geometry-'));
  const fixturePath = path.join(temporaryDirectory, 'fixture.html');
  fs.writeFileSync(fixturePath, html, 'utf8');

  let profileCleanupSafe = true, primaryFailure;
  try {
    profileCleanupSafe = false;
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

    profileCleanupSafe = result.profileCleanupSafe;
    assert.ifError(result.error);
    assert.equal(result.signal, null, `browser terminated with ${result.signal}`);
    assert.equal(result.status, 0, result.stderr || `browser exited with ${result.status}`);
    const match = result.stdout.match(/<pre id="geometry-result">([^<]+)<\/pre>/);
    assert.ok(match, 'geometry probe must emit structured results');
    return JSON.parse(match[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
  } catch (failure) {
    primaryFailure = failure; throw failure;
  } finally {
    if (profileCleanupSafe) {
      try { fs.rmSync(temporaryDirectory, { recursive: true, force: true }); }
      catch (failure) {
        if (!primaryFailure) throw failure;
        primaryFailure.message += `; private profile cleanup failed (${failure.code || 'unknown'}), retained`;
      }
    }
  }
}

// Exercise the real helper with successful DOM output even when the process failed.
const probeResult = {
  status: 0,
  signal: null,
  stdout: '<html><pre id="geometry-result">{&quot;results&quot;:[&quot;A&amp;B&quot;]}</pre></html>',
  stderr: '',
};

function mockGeometryBrowser(t, result = probeResult, { holdOpen = false, pipeError = false, closeOnKill = true, withholdClose = false, lingeringGroup = false } = {}) {
  const child = new EventEmitter();
  child.pid = 742000001;
  let groupAlive = true;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdio = [null, child.stdout, child.stderr, new PassThrough(), new PassThrough()];
  const commands = [];
  const finish = (status, signal) => queueMicrotask(() => {
    if (!lingeringGroup) groupAlive = false;
    child.emit('exit', status, signal);
    if (!withholdClose) child.emit('close', status, signal);
  });
  child.kill = signal => { if (closeOnKill) finish(null, signal); return true; };
  const groupSignals = [];
  const kill = t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, -child.pid, 'only the owned detached group may be inspected or signalled');
    if (!groupAlive) throw Object.assign(new Error('group gone'), { code: 'ESRCH' });
    if (signal !== 0) {
      groupSignals.push(signal);
      if (closeOnKill === true || closeOnKill === signal) { groupAlive = false; finish(null, signal); }
    }
    return true;
  });
  child.stdio[3].on('data', chunk => {
    commands.push(chunk.toString());
    if (pipeError) child.stdio[3].emit('error', new Error('close pipe failed'));
    else if (!holdOpen) finish(result.status, result.signal);
  });
  const spawn = t.mock.method(childProcess, 'spawn', (_browser, args, options) => {
    assert.ok(args.includes('--remote-debugging-pipe'));
    assert.equal(options.detached, true);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe', 'pipe', 'pipe']);
    queueMicrotask(() => {
      if (result.error) child.emit('error', result.error);
      child.stdout.write(result.stdout);
      child.stderr.write(result.stderr);
      if (!holdOpen && !commands.length) finish(result.status, result.signal);
    });
    return child;
  });
  return { child, commands, spawn, finish, groupSignals, kill };
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

test('geometry probe accepts clean native exit with complete DOM when inherited pipes withhold close', async t => {
  const { child } = mockGeometryBrowser(t, probeResult, { withholdClose: true });
  let closed = false;
  child.on('close', () => { closed = true; });
  const result = await collectGeometryDom('fixture-browser', []);
  assert.equal(result.error, null);
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.profileCleanupSafe, true);
  assert.equal(closed, false);
  assert.ok([child.stdout, child.stderr, child.stdio[3], child.stdio[4]].every(stream => stream.destroyed));
});

test('geometry probe waits for buffered DOM after native exit before accepting success', async t => {
  const { child, finish } = mockGeometryBrowser(t, { ...probeResult, stdout: probeResult.stdout.replace('</html>', '') },
    { holdOpen: true, withholdClose: true });
  let resolved = false;
  const running = collectGeometryDom('fixture-browser', []).then(result => { resolved = true; return result; });
  await new Promise(setImmediate);
  finish(0, null);
  await new Promise(setImmediate);
  assert.equal(resolved, false, 'native exit alone must not satisfy the DOM contract');
  child.stdout.write('</html>');
  const result = await running;
  assert.equal(result.error, null);
  assert.equal(result.profileCleanupSafe, true);
});

test('geometry probe reaps the owned residual group before permitting profile cleanup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { groupSignals } = mockGeometryBrowser(t, probeResult, { withholdClose: true, lingeringGroup: true });
  let resolved = false;
  const running = collectGeometryDom('fixture-browser', []).then(result => { resolved = true; return result; });
  await new Promise(setImmediate);
  assert.equal(resolved, false);
  t.mock.timers.tick(200);
  const result = await running;
  assert.deepEqual(groupSignals, ['SIGTERM']);
  assert.equal(result.error, null);
  assert.equal(result.status, 0, 'residual-group cleanup must not replace the main browser exit status');
  assert.equal(result.signal, null);
  assert.equal(result.profileCleanupSafe, true);
});

test('geometry probe bounds escalation to SIGKILL on its owned group', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { groupSignals } = mockGeometryBrowser(t, probeResult, { withholdClose: true, lingeringGroup: true, closeOnKill: 'SIGKILL' });
  const running = collectGeometryDom('fixture-browser', []);
  await new Promise(setImmediate);
  t.mock.timers.tick(800);
  const result = await running;
  assert.deepEqual(groupSignals, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.error, null);
  assert.equal(result.profileCleanupSafe, true);
});

test('geometry probe keeps the original deadline active after clean exit without complete DOM', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { finish } = mockGeometryBrowser(t, { ...probeResult, stdout: probeResult.stdout.replace('</html>', '') },
    { holdOpen: true, withholdClose: true });
  let resolved = false;
  const running = collectGeometryDom('fixture-browser', []).then(result => { resolved = true; return result; });
  await new Promise(setImmediate);
  finish(0, null);
  await new Promise(setImmediate);
  t.mock.timers.tick(29_999);
  assert.equal(resolved, false);
  t.mock.timers.tick(1);
  const result = await running;
  assert.equal(result.error.code, 'ETIMEDOUT');
  assert.equal(result.profileCleanupSafe, true);
});

test('geometry probe times out when completed DOM never gets a clean browser exit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { commands } = mockGeometryBrowser(t, probeResult, { holdOpen: true });
  const running = runGeometryProbe('fixture-browser', 1100, 760, '<!doctype html>');
  const rejected = assert.rejects(running, /ETIMEDOUT/);
  await new Promise(setImmediate);
  assert.equal(commands.length, 1);
  t.mock.timers.tick(30_000);
  t.mock.timers.tick(1000);
  await rejected;
});

test('geometry probe retains the profile when owned-group teardown cannot be confirmed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { child, spawn, groupSignals } = mockGeometryBrowser(t, probeResult, { holdOpen: true, closeOnKill: false });
  const rejected = assert.rejects(runGeometryProbe('fixture-browser', 1100, 760, '<!doctype html>'), /ETIMEDOUT/);
  await new Promise(setImmediate);
  const profileArg = spawn.mock.calls[0].arguments[1].find(value => value.startsWith('--user-data-dir='));
  const temporaryDirectory = path.dirname(profileArg.slice('--user-data-dir='.length));
  // This test has no native browser; remove only its mock fixture after proving retention.
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  t.mock.timers.tick(30_000);
  t.mock.timers.tick(3000);
  await rejected;
  assert.deepEqual(groupSignals, ['SIGTERM', 'SIGKILL']);
  assert.equal(fs.existsSync(temporaryDirectory), true);
  assert.ok([child.stdout, child.stderr, child.stdio[3], child.stdio[4]].every(stream => stream.destroyed));
});

test('geometry probe keeps timeout primary after a late clean exit and complete DOM', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { finish } = mockGeometryBrowser(t, probeResult, { holdOpen: true, closeOnKill: false, withholdClose: true });
  const running = collectGeometryDom('fixture-browser', []);
  await new Promise(setImmediate);
  t.mock.timers.tick(30_000);
  finish(0, null);
  const result = await running;
  assert.equal(result.error.code, 'ETIMEDOUT');
  assert.match(result.error.message, /geometry transport/);
  assert.equal(result.status, 0);
  assert.equal(result.profileCleanupSafe, true);
});

test('geometry probe fails closed when owned-group existence cannot be inspected', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { groupSignals, kill } = mockGeometryBrowser(t);
  kill.mock.mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
  const running = collectGeometryDom('fixture-browser', []);
  await new Promise(setImmediate);
  t.mock.timers.tick(3000);
  const result = await running;
  assert.match(result.error.message, /teardown could not be confirmed/);
  assert.equal(result.profileCleanupSafe, false);
  assert.deepEqual(groupSignals, []);
});

test('geometry probe latches the first error while draining shutdown pipes', async t => {
  const { child } = mockGeometryBrowser(t, probeResult, { withholdClose: true });
  const running = collectGeometryDom('fixture-browser', []);
  queueMicrotask(() => child.stderr.emit('error', new Error('first pipe failure')));
  queueMicrotask(() => child.stdio[4].emit('error', new Error('second pipe failure')));
  const result = await running;
  assert.match(result.error.message, /^first pipe failure/);
  assert.doesNotMatch(result.error.message, /second pipe failure/);
  assert.equal(result.profileCleanupSafe, true);
});

test('geometry probe treats synchronous spawn failure as safe to clean without signalling', async t => {
  t.mock.method(childProcess, 'spawn', () => { throw new Error('spawn rejected'); });
  const kill = t.mock.method(process, 'kill', () => { throw new Error('must not inspect another process'); });
  const result = await collectGeometryDom('fixture-browser', []);
  assert.match(result.error.message, /spawn rejected/);
  assert.equal(result.profileCleanupSafe, true);
  assert.equal(kill.mock.callCount(), 0);
});

test('geometry probe preserves the browser failure if profile removal also fails', async t => {
  mockGeometryBrowser(t, { ...probeResult, status: 1 });
  const remove = fs.rmSync;
  let retained;
  t.mock.method(fs, 'rmSync', directory => {
    retained = directory;
    throw Object.assign(new Error('mock profile still busy'), { code: 'ENOTEMPTY' });
  });
  t.after(() => { if (retained) remove(retained, { recursive: true, force: true }); });
  await assert.rejects(runGeometryProbe('fixture-browser', 1100, 760, '<!doctype html>'), failure => {
    assert.match(failure.message, /browser exited with 1/);
    assert.match(failure.message, /private profile cleanup failed \(ENOTEMPTY\), retained/);
    return true;
  });
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
