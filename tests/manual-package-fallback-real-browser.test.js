'use strict';
// Manual packaging fallback end to end in a real browser: the production
// index.html, styles.css and app.js in Chrome, the production preload.js
// mapping, and the production main process (trusted IPC, scanning, store and
// package transaction) in this Node process. Electron, the native pickers and
// the store file are the repository's synthetic harness; all files are
// synthetic. Keyboard and mouse input are real CDP input. This is not native
// or installed-app evidence.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const assertAnchor = (text, anchor, label) => require('./bounded-assert').equal(text.split(anchor).length - 1, 1, label);
const harnessPath = path.join(__dirname, 'provenance-dual-write.test.js');
let harness = fs.readFileSync(harnessPath, 'utf8');
const testAnchor = "const test = require('node:test');";
assertAnchor(harness, testAnchor, 'harness test anchor');
harness = harness.replace(testAnchor, "const browserTest = require('node:test'); const test = new Proxy(browserTest, { apply() {} });");
const homeAnchor = "fs.mkdtempSync(path.join(os.tmpdir(), 'crate-provenance-dual-write-home-'))";
assertAnchor(harness, homeAnchor, 'harness home anchor');
harness = harness.replace(homeAnchor, "fs.mkdtempSync(path.join(path.dirname(MAIN_UNDER_TEST_ROOT), 'manual-package-browser-home-'))");
const compiled = new Module(harnessPath, module);
compiled.filename = harnessPath; compiled.paths = Module._nodeModulePaths(__dirname);
compiled._compile(harness + '\n(' + cases.toString() + ')();', harnessPath);

function cases() {
  const crypto = require('node:crypto');
  const { findBrowser, withBrowserPage } = require('./asset-controls-cdp-helper');
  const browser = findBrowser();
  const skip = browser ? false : 'Chrome/Chromium unavailable: rendered checks NOT RUN';
  const rendererDir = path.join(__dirname, '..', 'renderer');
  const json = value => JSON.stringify(value);
  const sha = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  const desktop = name => path.join(TEST_HOME, 'Desktop', name);
  // Optional private captures for the PR's visual review; never committed.
  const captureDir = process.env.CRATE_MANUAL_FALLBACK_CAPTURE_DIR || null;

  // The production preload, loaded here with ipcRenderer.invoke routed to the
  // production main process handlers.
  function loadPreloadApi() {
    let api = null;
    const preloadPath = path.join(__dirname, '..', 'preload.js');
    const preload = new Module(preloadPath, module);
    preload.filename = preloadPath;
    preload.paths = Module._nodeModulePaths(path.dirname(preloadPath));
    const fakeElectron = {
      contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'crate') api = value; } },
      ipcRenderer: { invoke: (channel, ...args) => callIpcRaw(channel, ...args), on() {}, removeListener() {}, send() {} },
      webUtils: { getPathForFile: () => '' },
    };
    const originalRequire = preload.require.bind(preload);
    preload.require = request => request === 'electron' ? fakeElectron : originalRequire(request);
    preload._compile(fs.readFileSync(preloadPath, 'utf8'), preloadPath);
    assert.ok(api && typeof api.retryPackageVerification === 'function', 'preload exposes the fallback bridge');
    return api;
  }

  // In-page bridge: every window.crate method queues its call; the Node side
  // drains the queue, calls the same preload method, and settles the promise.
  function bootstrap() {
    const pending = new Map();
    let queue = [], next = 0;
    window.__takeIpc = () => { const taken = queue; queue = []; return taken; };
    window.__settleIpc = (id, ok, value) => {
      const waiter = pending.get(id);
      if (!waiter) return;
      pending.delete(id);
      if (ok) waiter.resolve(value); else waiter.reject(new Error(value));
    };
    window.__ipcIdle = () => queue.length === 0 && pending.size === 0;
    window.__installCrate = methods => {
      const api = {};
      for (const name of methods) {
        api[name] = name.startsWith('on') ? () => () => {} : (...args) => new Promise((resolve, reject) => {
          const id = ++next;
          pending.set(id, { resolve, reject });
          queue.push({ id, name, args: JSON.parse(JSON.stringify(args)) });
        });
      }
      api.getFileVisual = async () => ({ kind: 'fallback' });
      api.preScanSession = async () => null;
      window.crate = api;
    };
    window.__label = element => !element ? null : element === document.body ? 'BODY'
      : (element.getAttribute('aria-label') || element.id || element.textContent.trim());
    window.__text = selector => document.querySelector(selector)?.textContent.trim() ?? null;
    window.__visible = selector => {
      // Settle Crate's modal transitions (0.01ms under Reduce Motion) before reading styles.
      document.getAnimations().forEach(animation => animation.finish());
      const element = document.querySelector(selector);
      return !!element && !element.closest('.hidden') && element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible';
    };
    window.__pressTargets = [];
    document.addEventListener('pointerdown', event => window.__pressTargets.push(event.target), true);
    window.__center = selector => {
      const element = document.querySelector(selector);
      if (!element) return null;
      document.getAnimations().forEach(animation => animation.finish());
      window.__pressTargets = [];
      element.scrollIntoView({ block: 'center' });
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2, hit = document.elementFromPoint(x, y);
      return { x, y, hit: !!hit && (hit === element || element.contains(hit)) };
    };
    window.__manualRows = () => [...document.querySelectorAll('#package-manual-file-list .package-manual-file')].map(row => {
      const button = row.querySelector('button');
      return { name: row.querySelector('.package-manual-file-name').textContent, detail: row.querySelector('.package-manual-file-detail').textContent,
        control: button.getAttribute('aria-label'), kind: button.classList.contains('row-icon-button') ? 'square' : 'text',
        text: button.textContent, square: button.classList.contains('row-icon-button') ? [button.className.includes('row-action-include') ? '+' : 'x'] : [] };
    });
    window.__start = async projectId => {
      setupEventListeners();
      accountStatus = { revision: 1, state: 'signed_in', canUseWorkspace: true, identity: { id: 'synthetic' }, message: '' };
      renderAccount();
      document.querySelector('#tab-projects').classList.remove('active');
      document.querySelector('#tab-current-project').classList.add('active');
      state.projects = await window.crate.getProjects();
      state.selectedProjectId = projectId;
      state.settings = await window.crate.getSettings();
      state.packageOutputPath = null;
      return true;
    };
  }

  async function withPage(options, run) {
    const api = loadPreloadApi();
    return withBrowserPage({ browser, rendererDir, bootstrapSource: `(${bootstrap.toString()})();`, width: 1100, height: 760, ...options }, async page => {
      await page.evaluate(`window.__installCrate(${json(Object.keys(api))})`);
      let stopped = false;
      const calls = [];
      const pump = (async () => {
        while (!stopped) {
          let taken = [];
          try { taken = await page.evaluate('window.__takeIpc()'); } catch (_) { if (stopped) break; }
          for (const call of taken) {
            calls.push([call.name, ...call.args.slice(0, 1)]);
            Promise.resolve().then(() => api[call.name](...call.args)).then(
              value => page.evaluate(`window.__settleIpc(${call.id}, true, ${json(value ?? null)})`),
              error => page.evaluate(`window.__settleIpc(${call.id}, false, ${json(String(error?.message || error))})`)).catch(() => {});
          }
          await page.sleep(10);
        }
      })();
      page.calls = calls;
      page.idle = async () => {
        for (let attempt = 0; attempt < 400; attempt += 1) {
          if (await page.evaluate('window.__ipcIdle()')) {
            await page.sleep(120);
            if (await page.evaluate('window.__ipcIdle()')) return;
          }
          await page.sleep(15);
        }
        throw new Error('bridge calls did not settle');
      };
      page.click = async selector => {
        const point = await page.evaluate(`window.__center(${json(selector)})`);
        assert.ok(point?.hit, `${selector} receives the pointer: ${json(point)}`);
        await page.clickAt(point.x, point.y);
        const pressed = await page.evaluate(`window.__pressTargets.map(target => !!target.closest(${json(selector)}))`);
        assert.deepEqual(pressed, [true], `the press reached ${selector}`);
        await page.idle();
      };
      page.focusOn = selector => page.evaluate(`document.querySelector(${json(selector)}).focus()`);
      page.active = () => page.evaluate('window.__label(document.activeElement)');
      try { return await run(page); } finally { stopped = true; await pump; }
    });
  }

  // The same synthetic route as the main-process tests: Keep both, then the
  // owner excludes and restores Flyer.ai, whose bytes no longer parse.
  async function fixture({ breakSecond = true } = {}) {
    resetTestHomeWorkspace(); setPresentationUnzipFixture([]);
    const project = await createProject('Synthetic fallback');
    const id = project.id;
    await callIpcRaw('projects:pause', id); clearTrackedTimers();
    const workspace = () => callIpcRaw('projects:get-asset-workspace', id);
    const logo = desktop('Logo.png'); fs.writeFileSync(logo, 'synthetic logo bytes');
    const add = async name => { const target = desktop(name); writeSyntheticAiFile(target, logo); manualDialogFor([target]); await callIpcRaw('projects:add-files', id); return target; };
    const poster = await add('Poster.ai');
    await callIpcRaw('projects:set-existing-assets-decision', id, 'include');
    const flyer = await add('Flyer.ai');
    const card = (await workspace()).workingFileChoices.choices[0];
    await callIpcRaw('projects:resolve-working-file-choice', id, { id: card.id, revision: card.revision, choice: 'keep-both', predecessorIdentity: null });
    const select = async action => {
      const row = (await workspace()).files.find(file => file.name === 'Flyer.ai');
      return callIpcRaw('projects:set-working-source-selection', id, row.visualIdentity, { action, expectedRevision: row.selectionRevision });
    };
    assert.equal((await select('exclude')).success, true);
    if (breakSecond) fs.writeFileSync(flyer, '%PDF-1.7\nmissing EOF');
    assert.equal((await select('restore')).success, true);
    const out = path.join(TEST_HOME, 'Out-' + crypto.randomUUID().slice(0, 8));
    fs.mkdirSync(out, { recursive: true });
    return { id, poster, flyer, logo, out, stored: () => storeInstance.data.projects.find(item => item.id === id) };
  }

  async function screen(page) {
    return page.evaluate(`(() => ({
      title: window.__text('#package-review-title'),
      pill: window.__visible('#package-review-ready') ? window.__text('#package-review-ready') : null,
      message: window.__visible('#modal-package-review-message') ? window.__text('#modal-package-review-message') : null,
      retry: window.__visible('#btn-retry-package-verification') ? [window.__text('#btn-retry-package-verification'), document.querySelector('#btn-retry-package-verification').disabled] : null,
      manual: window.__visible('#btn-review-files-manually') ? [window.__text('#btn-review-files-manually'), document.querySelector('#btn-review-files-manually').disabled] : null,
      packageProject: window.__visible('#btn-confirm-package') ? [window.__text('#btn-confirm-package'), document.querySelector('#btn-confirm-package').disabled] : null,
      back: window.__visible('#btn-cancel-package') ? window.__text('#btn-cancel-package') : null,
      total: window.__visible('#package-review-total') ? window.__text('#package-review-total') : null,
      token: state.packageReviewToken,
      manualView: window.__visible('#package-manual-body'),
    }))()`);
  }

  async function manualScreen(page) {
    return page.evaluate(`(() => ({
      title: window.__text('#package-review-title'),
      warning: [...document.querySelectorAll('#package-manual-warning > div')].map(element => element.textContent),
      heading: window.__text('#package-manual-assets-heading'),
      total: window.__text('#package-manual-total'),
      rows: window.__manualRows(),
      message: window.__text('#package-manual-message'),
      packageButton: [window.__text('#btn-manual-package'), document.querySelector('#btn-manual-package').disabled],
      back: window.__text('#btn-manual-back'),
      choose: window.__text('#btn-manual-choose-files'),
      reviewBodyHidden: !window.__visible('#package-review-body'),
      packageProjectHidden: !window.__visible('#btn-confirm-package'),
    }))()`);
  }

  // Layout at the target window size: nothing overflows the page or the dialog,
  // and every control of the shown view is visible and receives the pointer.
  async function assertLayout(page, selectors, label) {
    const layout = await page.evaluate(`(() => {
      document.getAnimations().forEach(animation => animation.finish());
      const dialog = document.querySelector('.package-review-modal');
      return { pageOverflow: document.documentElement.scrollWidth - innerWidth, dialogOverflow: dialog.scrollWidth - dialog.clientWidth,
        controls: ${json(selectors)}.flatMap(selector => [...document.querySelectorAll(selector)]).filter(element => !element.closest('.hidden')).map(element => {
          element.scrollIntoView({ block: 'center' });
          const r = element.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return { label: window.__label(element), size: [Math.round(r.width), Math.round(r.height)],
            inViewport: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
            receivesPointer: !!hit && (hit === element || element.contains(hit)), clipped: element.scrollWidth > element.clientWidth + 1 };
        }) };
    })()`);
    assert.ok(layout.pageOverflow <= 0 && layout.dialogOverflow <= 0, `${label}: no horizontal overflow ${json(layout)}`);
    assert.ok(layout.controls.length > 0, label);
    for (const control of layout.controls) {
      assert.ok(control.inViewport && control.receivesPointer && !control.clipped && control.size[0] > 0 && control.size[1] > 0, `${label}: ${json(control)}`);
    }
    return layout;
  }

  async function captureView(page, name) {
    if (!captureDir) return;
    fs.mkdirSync(captureDir, { recursive: true });
    await page.moveAway();
    await page.evaluate('document.getAnimations().forEach(animation => animation.finish())');
    await page.screenshot(path.join(captureDir, name));
  }

  for (const reducedMotion of [false, true]) browserTest(`Package Review: failed reading, Retry, Review files manually, keyboard decisions and a manual package at 1100x760${reducedMotion ? ' with Reduce Motion' : ''}`, { skip, timeout: 120000 }, async () => {
    const f = await fixture();
    const capture = reducedMotion ? async () => {} : captureView;
    await withPage({}, async page => {
      // CI's macOS runner reports prefers-reduced-motion: reduce.
      await page.emulateReducedMotion(reducedMotion);
      assert.equal(await page.evaluate(`window.__start(${json(f.id)})`), true);
      assert.equal(await page.evaluate('showPackageModal({ runPreScan: false })'), true, 'Package Review opens through the renderer');
      await page.idle();
      let shown = await screen(page);
      assert.deepEqual(shown, { title: 'Package Review', pill: 'Review required', message: 'File changed. Verify again.',
        retry: ['Retry verification', false], manual: null, packageProject: ['Package Project', true], back: 'Back to selection',
        total: '3 visual assets', token: null, manualView: false });
      assert.equal(await page.evaluate("[...document.querySelectorAll('#package-review-summary-list dd')].some(cell => cell.textContent === 'Unavailable')"), false,
        'a review with a file list never shows Unavailable counts');
      await assertLayout(page, ['#btn-retry-package-verification', '#btn-cancel-package', '#btn-confirm-package', '#btn-back-package'], 'screen 1');
      await capture(page, '01-package-review-retry.png');

      // Retry by keyboard. It fails again; Review files manually appears. Package Project stays disabled.
      await page.focusOn('#btn-retry-package-verification');
      await page.press('Enter');
      await page.idle();
      shown = await screen(page);
      assert.equal(shown.message, 'Verification couldn’t finish. Try again.');
      assert.deepEqual(shown.retry, ['Retry verification', false]);
      assert.deepEqual(shown.manual, ['Review files manually', false]);
      assert.deepEqual(shown.packageProject, ['Package Project', true]);
      assert.equal(shown.token, null);
      assert.equal(await page.active(), 'modal-package-review-message', 'the result is announced and focused');
      assert.equal(page.calls.filter(call => call[0] === 'packageProject' || call[0] === 'packageManualFiles').length, 0, 'Retry never packages');
      await assertLayout(page, ['#btn-retry-package-verification', '#btn-review-files-manually', '#btn-confirm-package'], 'screen 1 after Retry');
      await capture(page, '02-package-review-after-retry.png');

      // Screen 2.
      const storeBefore = JSON.stringify(storeInstance.data.projects);
      await page.click('#btn-review-files-manually');
      let manual = await manualScreen(page);
      assert.deepEqual(manual.rows.map(row => row.name).sort(), ['Flyer.ai', 'Logo.png', 'Poster.ai']);
      assert.equal(manual.title, 'Review files manually');
      assert.deepEqual(manual.warning, ['Linked assets unverified', 'This manual package includes only the files marked Included.']);
      assert.equal(manual.heading, 'What Will Be Packaged');
      assert.equal(manual.total, '3 files Included');
      assert.deepEqual(manual.packageButton, ['Package these 3 files', false]);
      assert.equal(manual.back, 'Back to Package Review');
      assert.equal(manual.choose, 'Choose Files…');
      assert.equal(manual.reviewBodyHidden && manual.packageProjectHidden, true);
      const logoRow = manual.rows.find(row => row.name === 'Logo.png');
      assert.deepEqual(logoRow, { name: 'Logo.png', detail: 'Existing · Included', control: 'Exclude Logo.png', kind: 'square', text: '', square: ['x'] });
      for (const name of ['Poster.ai', 'Flyer.ai']) {
        assert.deepEqual(manual.rows.find(row => row.name === name), { name, detail: 'Working file · Included', control: `Exclude ${name}`, kind: 'text', text: 'Exclude', square: [] });
      }
      assert.equal(await page.active(), 'package-review-title', 'focus moves to the new view title');
      await assertLayout(page, ['#btn-manual-choose-files', '.package-manual-toggle', '#btn-manual-change-dest', '#btn-manual-back', '#btn-manual-package'], 'screen 2');
      await capture(page, '03-review-files-manually.png');

      // Keyboard: Tab reaches each control in order; Enter and Space toggle and keep focus on the row.
      const order = [];
      for (let step = 0; step < 8; step += 1) { await page.press('Tab'); order.push(await page.active()); }
      assert.deepEqual(order.slice(0, 7), ['btn-manual-choose-files', ...manual.rows.map(row => row.control), 'btn-manual-change-dest', 'btn-manual-back', 'btn-manual-package'].slice(0, 7));
      await page.focusOn('.package-manual-toggle[aria-label="Exclude Logo.png"]');
      await page.press('Enter');
      manual = await manualScreen(page);
      assert.deepEqual(manual.rows.find(row => row.name === 'Logo.png'), { name: 'Logo.png', detail: 'Existing · Excluded', control: 'Include Logo.png', kind: 'square', text: '', square: ['+'] });
      assert.equal(await page.active(), 'Include Logo.png', 'focus stays on the same row');
      assert.equal(manual.total, '2 files Included');
      assert.deepEqual(manual.packageButton, ['Package these 2 files', false]);
      assert.equal(manual.message, 'Logo.png excluded.');
      await page.press('Space');
      assert.equal((await manualScreen(page)).total, '3 files Included');
      for (const name of ['Poster.ai', 'Logo.png']) {
        await page.focusOn(`.package-manual-toggle[aria-label="Exclude ${name}"]`);
        await page.press('Enter');
      }
      manual = await manualScreen(page);
      assert.deepEqual(manual.rows.find(row => row.name === 'Poster.ai'), { name: 'Poster.ai', detail: 'Working file · Excluded', control: 'Include Poster.ai', kind: 'text', text: 'Include', square: [] });
      assert.deepEqual(manual.packageButton, ['Package this file', false]);
      await page.focusOn('.package-manual-toggle[aria-label="Exclude Flyer.ai"]');
      await page.press('Enter');
      manual = await manualScreen(page);
      assert.equal(manual.total, 'No files Included');
      assert.deepEqual(manual.packageButton, ['Package these files', true]);

      // Choose Files… with a same-named file: listed, never added to the project; the name collision blocks.
      const other = path.join(TEST_HOME, 'Documents', 'LOGO.png');
      fs.mkdirSync(path.dirname(other), { recursive: true }); fs.writeFileSync(other, 'another logo');
      for (const name of ['Poster.ai', 'Logo.png', 'Flyer.ai']) {
        await page.focusOn(`.package-manual-toggle[aria-label="Include ${name}"]`);
        await page.press('Enter');
      }
      manualDialogFor([other]);
      await page.click('#btn-manual-choose-files');
      manual = await manualScreen(page);
      assert.deepEqual(manual.rows.find(row => row.name === 'LOGO.png'), { name: 'LOGO.png', detail: 'Chosen for this package · Included', control: 'Exclude LOGO.png', kind: 'square', text: '', square: ['x'] });
      assert.equal(manual.message, 'Two Included files are named Logo.png. Exclude one to continue.');
      assert.deepEqual(manual.packageButton, ['Package these 4 files', true]);
      await page.focusOn('.package-manual-toggle[aria-label="Exclude LOGO.png"]');
      await page.press('Enter');
      assert.deepEqual((await manualScreen(page)).packageButton, ['Package these 3 files', false]);
      assert.equal(JSON.stringify(storeInstance.data.projects), storeBefore, 'manual decisions never reach the project');

      // Escape steps back to Package Review; nothing changed; manual mode can open again with the listed files.
      await page.press('Escape');
      await page.idle();
      shown = await screen(page);
      assert.equal(shown.title, 'Package Review');
      assert.equal(shown.manualView, false);
      assert.deepEqual(shown.manual, ['Review files manually', false]);
      assert.equal(JSON.stringify(storeInstance.data.projects), storeBefore);
      await page.click('#btn-review-files-manually');
      assert.equal((await manualScreen(page)).total, '3 files Included', 'a new manual review starts from the confirmed files again');

      // A file changed after listing is reported on its row; nothing is written.
      manualDialogFor([f.out]);
      await page.click('#btn-manual-change-dest');
      assert.equal(await page.evaluate("window.__text('#package-manual-dest-path')"), 'Selected output folder');
      fs.appendFileSync(f.logo, ' changed');
      await page.click('#btn-manual-package');
      manual = await manualScreen(page);
      assert.equal(manual.rows.find(row => row.name === 'Logo.png').detail, 'Existing · Changed or missing. Exclude it or choose it again.');
      assert.equal(manual.message, 'Some files changed or are missing. Exclude them or choose them again. Nothing was packaged.');
      assert.equal(manual.packageButton[1], true);
      assert.deepEqual(fs.readdirSync(f.out), []);
      manualDialogFor([f.logo]);
      await page.click('#btn-manual-choose-files');
      manual = await manualScreen(page);
      assert.equal(manual.rows.find(row => row.name === 'Logo.png').detail, 'Existing · Included');

      // Package these 3 files.
      await page.click('#btn-manual-package');
      const success = await page.evaluate(`(() => ({ open: window.__visible('#modal-success'), title: window.__text('#success-title'),
        message: window.__text('#success-message'), note: window.__visible('#success-manual-note') ? window.__text('#success-manual-note') : null,
        details: window.__visible('#package-details'), review: window.__visible('#modal-package') }))()`);
      assert.deepEqual(success, { open: true, title: 'Packaged Manually', message: '3 files packaged manually.',
        note: 'Linked assets weren’t verified. Only the files you marked Included were copied.', details: false, review: false });
      await capture(page, '04-manual-package-complete.png');
      const [folder] = fs.readdirSync(f.out);
      assert.deepEqual(fs.readdirSync(path.join(f.out, folder)).sort(), ['Flyer.ai', 'Logo.png', 'Poster.ai']);
      for (const source of [f.poster, f.flyer, f.logo]) assert.equal(sha(path.join(f.out, folder, path.basename(source))), sha(source));
      assert.equal(JSON.stringify(storeInstance.data.projects), storeBefore, 'the manual package changes no project state');
      assert.equal(f.stored().status, 'paused');
    });
  });

  browserTest('Package Review: a successful Retry shows a fresh, normal review and does not package', { skip, timeout: 60000 }, async () => {
    const f = await fixture();
    await withPage({}, async page => {
      await page.evaluate(`window.__start(${json(f.id)})`);
      await page.evaluate('showPackageModal({ runPreScan: false })');
      await page.idle();
      writeSyntheticAiFile(f.flyer, f.logo);
      await page.click('#btn-retry-package-verification');
      const shown = await screen(page);
      assert.deepEqual(shown.retry, null);
      assert.deepEqual(shown.manual, null);
      assert.equal(shown.pill, 'Ready to package');
      assert.deepEqual(shown.packageProject, ['Package Project', false]);
      assert.equal(typeof shown.token, 'string');
      assert.equal(page.calls.some(call => call[0] === 'packageProject' || call[0] === 'packageManualFiles'), false);
      assert.deepEqual(fs.readdirSync(f.out), []);
      assert.equal(f.stored().status, 'paused');
    });
  });

  browserTest('Package Review: an unanswered working-file choice keeps its own wording, Unavailable counts and no fallback controls', { skip, timeout: 60000 }, async () => {
    const f = await fixture({ breakSecond: false });
    const extra = desktop('Extra.ai'); writeSyntheticAiFile(extra, f.logo);
    manualDialogFor([extra]);
    await callIpcRaw('projects:add-files', f.id);
    fs.writeFileSync(extra, '%PDF-1.7\nmissing EOF');
    await withPage({}, async page => {
      await page.evaluate(`window.__start(${json(f.id)})`);
      await page.evaluate('showPackageModal({ runPreScan: false })');
      await page.idle();
      const shown = await screen(page);
      assert.equal(shown.message, 'Decide how to use the new working files before packaging.');
      assert.equal(shown.retry, null);
      assert.equal(shown.manual, null);
      assert.deepEqual(shown.packageProject, ['Package Project', true]);
      assert.equal(shown.total, 'Visual assets unavailable');
      assert.equal(await page.evaluate("[...document.querySelectorAll('#package-review-summary-list dd')].filter(cell => cell.textContent === 'Unavailable').length"), 4);
    });
  });

  browserTest('Package Review: an account change during manual review returns to a fresh Package Review without output', { skip, timeout: 60000 }, async () => {
    const f = await fixture();
    await callIpcRaw('projects:retry-package-verification', f.id);
    await withPage({}, async page => {
      await page.evaluate(`window.__start(${json(f.id)})`);
      await page.evaluate('showPackageModal({ runPreScan: false })');
      await page.idle();
      await page.click('#btn-review-files-manually');
      manualDialogFor([f.out]);
      await page.click('#btn-manual-change-dest');
      await testAccountSession.logout(); await testAccountSession.restore();
      await page.click('#btn-manual-package');
      const shown = await screen(page);
      assert.equal(shown.title, 'Package Review');
      assert.equal(shown.manualView, false);
      assert.equal(shown.message, 'Your project changed. Review the updated files before packaging.');
      assert.deepEqual(fs.readdirSync(f.out), []);
    });
  });
}
