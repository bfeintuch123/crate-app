'use strict';
// Rules F1 to F3 for a failed Illustrator reading. Source harness: Electron, the
// store and Illustrator are simulated by tests/provenance-dual-write.test.js and
// all files are synthetic. Nothing here is native evidence.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('./bounded-assert');

const harnessPath = path.join(__dirname, 'provenance-dual-write.test.js');
let harness = fs.readFileSync(harnessPath, 'utf8');
function replaceOnce(before, after) { assert.equal(harness.split(before).length - 1, 1, 'harness drift: ' + before); harness = harness.replace(before, after); }
replaceOnce("const test = require('node:test');", "const scopeTest = require('node:test'); const test = new Proxy(scopeTest, { apply() {} });");
// The saved-file link scan reads only paths under /Users or /Volumes.
replaceOnce("fs.mkdtempSync(path.join(os.tmpdir(), 'crate-provenance-dual-write-home-'))", "fs.mkdtempSync(path.join(path.dirname(MAIN_UNDER_TEST_ROOT), 'failed-reading-home-'))");
// Read-only views of main-process state, plus one poll outside the watcher coordinator.
replaceOnce("  isLsofPollInProgress(projectId) {", `  scopeFlag(projectId) { return illustratorActivationScopes.get(projectId)?.baselineFlag || null; },
  scopeStatus(projectId) { return illustratorActivationScopes.get(projectId)?.status || null; },
  pollOutsideCoordinator(projectId) { return pollPsForProjectCore(projectId, getActiveWatchingActivationToken(projectId), null); },
  isLivePollInProgress(projectId) { return psInProgress.has(projectId); },
  stageIllustratorFile(projectId, fileEntry, observation) {
    let staged = null;
    mutateProject(projectId, project => { staged = stageLiveObservedFile(project, fileEntry, observation); return staged; });
    return staged;
  },
  isLsofPollInProgress(projectId) {`);
// Deterministic test-only pause immediately before finalManifest inside projects:package.
replaceOnce(
  "  return module._compile(`${source}",
  "  const finalManifestAnchor = '    const finalManifest = await buildCanonicalPackageReviewManifest(id);';\n" +
  "  assert.equal(source.split(finalManifestAnchor).length - 1, 1, 'final package manifest anchor');\n" +
  "  source = source.replace(finalManifestAnchor, '    if (global.__crateBeforeFinalPackageManifest) await global.__crateBeforeFinalPackageManifest(id);\\n' + finalManifestAnchor);\n" +
  "  return module._compile(`${source}"
);
const compiled = new Module(harnessPath, module);
compiled.filename = harnessPath;
compiled.paths = Module._nodeModulePaths(__dirname);
compiled._compile(harness + '\n(' + scopeCases.toString() + ')();', harnessPath);

function scopeCases() {
  const stored = id => storeInstance.data.projects.find(project => project.id === id);
  const pause = ms => new Promise(resolve => originalSetTimeout(resolve, ms));
  const base = filePath => path.basename(filePath);
  const isIdentityRead = ({ kind, command, args }) => kind === 'execFile' && command === '/usr/bin/osascript' && Array.isArray(args) &&
    args.some(arg => path.basename(String(arg)) === 'crate-source-document-identity.js');

  // The packaged app's store returns a new copy on every read; the harness store returns live objects.
  async function withStore(copied, work) {
    if (!copied) return work();
    const liveGet = storeInstance.get;
    storeInstance.get = function copiedGet(key, fallback) {
      const value = liveGet.call(this, key, fallback);
      return key === 'projects' ? structuredClone(value) : value;
    };
    try { return await work(); } finally { delete storeInstance.get; }
  }

  const openGates = new Set();
  function gate() {
    let release;
    const opened = new Promise(resolve => { release = resolve; });
    const held = { reached: false, open() { openGates.delete(held); release(); }, reach(result) { held.reached = true; return opened.then(() => result); } };
    openGates.add(held);
    return held;
  }

  // A simulated Illustrator. `fail` fails every reading until cleared; `failOnce` fails the next one.
  // Failure kinds: 'empty', 'count-mismatch', 'osascript-timeout', 'applescript-timeout-error',
  // 'osascript-exec-error', 'automation-denied', and 'pathless-untitled-doc'.
  function illustrator() {
    const app = { running: true, docs: [], fail: null, failOnce: null, hold: null, queries: 0, openFiles: [], recentLastUsedPaths: [], inddDocs: [], inddScanLinks: [] };
    setChildProcessHandler(request => {
      const { kind, command, args } = request;
      const xattrPaths = bulkXattrPaths(request);
      if (xattrPaths.length) {
        const recent = new Set(app.recentLastUsedPaths.map(item => path.resolve(item).toLowerCase()));
        return {
          stdout: formatBulkXattrOutput(xattrPaths, filePath => encodeLastUsedXattr(
            recent.has(path.resolve(filePath).toLowerCase()) ? Date.now() + 5000 : Date.now() - 400 * 86400000
          )),
        };
      }
      if (isIdentityRead(request)) return { stdout: '' };
      if (isIllustratorPgrepCheck({ kind, command, args })) return { stdout: app.running ? '654\n' : '' };
      if (kind === 'exec' && String(command).includes('Adobe InDesign') && String(command).startsWith('/bin/ps ax -o command=')) {
        return { stdout: (app.inddDocs.length || app.inddScanLinks.length) ? '/Applications/Adobe InDesign 2026/Adobe InDesign.app/Contents/MacOS/Adobe InDesign\n' : '' };
      }
      if (kind === 'exec' && String(command).startsWith('/bin/ps ax -o pid= -o command=')) {
        const lines = [];
        if (app.openFiles.length) lines.push('888 /Applications/Adobe Illustrator 2026/Adobe Illustrator.app/Contents/MacOS/Adobe Illustrator');
        if (app.inddDocs.length || app.inddScanLinks.length) lines.push('889 /Applications/Adobe InDesign 2026/Adobe InDesign.app/Contents/MacOS/Adobe InDesign');
        return { stdout: lines.length ? lines.join('\n') + '\n' : '' };
      }
      if (kind === 'exec' && String(command).startsWith('/usr/sbin/lsof -F ptn -p 888')) {
        return { stdout: 'p888\n' + app.openFiles.map((item, index) => `f${20 + index}\ntREG\nn${item}\n`).join('') };
      }
      if (isOsascriptInvocation({ kind, command, args }, 'crate-indd-scan.applescript')) {
        return { stdout: app.inddScanLinks.length ? app.inddScanLinks.join('\n') + '\n' : '' };
      }
      if (
        isOsascriptInvocation({ kind, command, args }, 'crate-indd-query.applescript') ||
        isOsascriptInvocation({ kind, command, args }, 'crate-indd-poll.applescript')
      ) {
        const rows = [];
        let totalLinks = 0;
        app.inddDocs.forEach((doc, index) => {
          const name = base(doc.path), current = index === 0, links = doc.links || [];
          rows.push(`DOC\t${doc.path}\t${name}\t${doc.modified === true}\t${current}\t${links.length}`);
          for (const link of links) {
            rows.push(`LINK\t${doc.path}\t${name}\t${link}\t${doc.modified === true}\t${current}`);
            totalLinks++;
          }
        });
        rows.push(`END\t${app.inddDocs.length}\t${totalLinks}\t${totalLinks}\t0`);
        return { stdout: rows.join('\n') + '\n' };
      }
      if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
        app.queries++;
        const mode = app.failOnce || app.fail;
        app.failOnce = null;
        let result;
        if (mode === 'osascript-timeout') {
          result = {
            error: Object.assign(new Error('Command failed: /usr/bin/osascript timed out'), {
              code: 'ETIMEDOUT',
              killed: true,
              signal: 'SIGTERM',
              stderr: 'execution error: Adobe Illustrator got an error: AppleEvent timed out. (-1712)',
            }),
          };
        } else if (mode === 'applescript-timeout-error') {
          result = { stdout: 'ERROR\tillustrator-query-timeout\n' };
        } else if (mode === 'osascript-exec-error') {
          result = {
            error: Object.assign(new Error('execution error: Adobe Illustrator got an error: Connection is invalid. (-609)'), {
              code: 1,
              stderr: 'execution error: Adobe Illustrator got an error: Connection is invalid. (-609)',
            }),
          };
        } else if (mode === 'automation-denied') {
          result = { stdout: 'ERROR\tautomation-permission-denied\n' };
        } else {
          const rows = [];
          let links = 0;
          app.docs.forEach((doc, index) => {
            const name = base(doc.path), current = index === 0;
            rows.push(`DOC\t${doc.path}\t${name}\t${doc.modified === true}\t${current}`);
            for (const link of doc.links || []) { rows.push(`LINK\t${doc.path}\t${name}\t${link}\t${doc.modified === true}\t${current}`); links++; }
          });
          let stdout;
          if (mode === 'empty') stdout = '';
          else if (mode === 'count-mismatch') stdout = [...rows, `COMPLETE\t${app.docs.length}\t${links + 1}`].join('\n') + '\n';
          else if (mode === 'pathless-untitled-doc') stdout = [...rows, 'DOC\t\tUntitled-1\ttrue\tfalse', `COMPLETE\t${app.docs.length + 1}\t${links}`].join('\n') + '\n';
          else stdout = app.docs.length ? [...rows, `COMPLETE\t${app.docs.length}\t${links}`].join('\n') + '\n' : 'STATUS\tno-documents\nCOMPLETE\t0\t0\n';
          result = { stdout };
        }
        const held = app.hold;
        app.hold = null;
        return held ? held.reach(result) : result;
      }
      return { stdout: '' };
    });
    return app;
  }

  async function poll(id, times = 1) {
    for (let n = 0; n < times; n++) {
      await metadataTestHooks.waitForWatcherIdle(id);
      for (let attempt = 0; attempt < 60; attempt++) {
        const outcome = await metadataTestHooks.pollPsForProject(id, metadataTestHooks.getActiveWatchingActivationToken(id));
        if (!(outcome && outcome.skipped)) break;
        await pause(100);
        await metadataTestHooks.waitForWatcherIdle(id);
      }
      await metadataTestHooks.waitForWatcherIdle(id);
    }
  }
  const pollFinished = id => waitForCondition(() => !metadataTestHooks.isLivePollInProgress(id), 'live poll finished', 5000);
  const uniqueBytes = (tag, filePath) => Buffer.concat([createSyntheticPngBytes(), Buffer.from('sample:' + tag + ':' + base(filePath))]);

  // A watched project whose saved Illustrator document links four included assets.
  async function setup(tag, { swatchCount = 4 } = {}) {
    resetTestHomeWorkspace();
    currentPsdFixture = { children: [], linkedFiles: [] };
    const dir = path.join(TEST_HOME, 'Desktop', `Sample_${tag}`);
    fs.mkdirSync(dir, { recursive: true });
    const file = name => path.join(dir, name);
    const elsewhere = path.join(TEST_HOME, 'Documents', `Elsewhere_${tag}`);
    fs.mkdirSync(elsewhere, { recursive: true });
    const f = { dir, file, doc: file('Layout.ai'), swatches: Array.from({ length: swatchCount }, (_, i) => file(`Swatch${i + 1}.png`)),
      fresh: file('Fresh1.png'), flyer: path.join(elsewhere, 'Flyer.ai'), flyerArt: path.join(elsewhere, 'FlyerArt.png') };
    for (const item of [...f.swatches, f.fresh, f.flyerArt]) fs.writeFileSync(item, uniqueBytes(tag, item));
    writeSyntheticAiFile(f.flyer, f.flyerArt);
    const app = illustrator();
    const project = await createProject(`Sample ${tag}`);
    const id = project.id;
    await waitForCondition(() => app.queries >= 1, 'activation query');
    writeSyntheticAiFile(f.doc, f.swatches.join('\n'));
    await emitWatcher('add', f.doc);
    await metadataTestHooks.waitForWatcherIdle(id);
    app.docs = [{ path: f.doc, links: [...f.swatches] }];
    await poll(id, 2);
    await callIpcRaw('projects:set-existing-assets-decision', id, 'include');
    await poll(id);
    const c = { f, app, id };
    const ws = await workspace(c);
    assert.equal(ws.included, swatchCount, 'setup: every linked asset included');
    return c;
  }

  async function workspace(c) {
    const ws = await callIpcRaw('projects:get-asset-workspace', c.id);
    return { raw: ws, included: ws?.semanticCounts?.includedAssets ?? null,
      names: (ws?.files || []).map(row => row.name).sort(),
      // The workspace projection carries no capture state; read it from the stored row of a shown name.
      pending: (ws?.pendingFiles || []).map(row => [row.name,
        (stored(c.id).pendingFiles || []).find(item => base(item.path) === row.name)?.captureState || 'pending']) };
  }

  // A new working document raises a working-file question; Keep both answers it, as a designer would.
  async function keepNewWorkingFiles(c) {
    for (let round = 0; round < 40; round++) {
      const ws = await callIpcRaw('projects:get-asset-workspace', c.id);
      const choices = ws?.workingFileChoices?.choices || [];
      const choice = choices.find(item => item.ready);
      if (!choice) {
        // A save's verification may still be running; wait for it rather than answer early.
        if (!choices.some(item => item.reason === 'working-file-verification-pending')) return;
        await pause(100);
        await metadataTestHooks.waitForWatcherIdle(c.id);
        continue;
      }
      await callIpcRaw('projects:resolve-working-file-choice', c.id, { id: choice.id, revision: choice.revision, choice: 'keep-both', predecessorIdentity: null });
    }
  }

  const UNRESOLVED_MESSAGE = 'Working-source verification is unresolved. Review the files and try again.';

  async function packageStep(c, { scan = true } = {}) {
    if (scan) await callIpcRaw('projects:pre-package-scan', c.id);
    await metadataTestHooks.waitForWatcherIdle(c.id);
    await keepNewWorkingFiles(c);
    const answer = await callIpcRaw('projects:prepare-package-review', c.id);
    return { error: answer?.error || null, materializable: answer?.materializable ?? null,
      token: answer?.token || null, message: answer?.message || null,
      statuses: Array.isArray(answer?.files) ? answer.files.map(item => item.status) : null,
      files: Array.isArray(answer?.files) ? answer.files.map(item => item.name).sort() : null };
  }

  async function runPackage(c, token, label) {
    const output = path.join(TEST_HOME, 'Documents', `Package_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(output, { recursive: true });
    const result = await callIpcRaw('projects:package', c.id, output, token);
    const written = fs.readdirSync(output);
    return { result, output, written };
  }

  const FULL = ['Layout.ai', 'Swatch1.png', 'Swatch2.png', 'Swatch3.png', 'Swatch4.png'];
  async function assertFullProject(c, label, { scan = true, extra = [], materializable = true } = {}) {
    const ws = await workspace(c);
    assert.equal(ws.included, 4, label + ': four included assets: ' + JSON.stringify(ws.names));
    for (const name of FULL) assert.ok(ws.names.includes(name), label + ': workspace shows ' + name);
    const pkg = await packageStep(c, { scan });
    assert.deepEqual(pkg.files, [...FULL, ...extra].sort(), label + ': package: ' + JSON.stringify(pkg));
    assert.equal(pkg.materializable, materializable, label + ': materializable: ' + JSON.stringify(pkg));
    if (materializable) {
      assert.equal(typeof pkg.token, 'string', label + ': approval token issued');
    } else {
      assert.equal(pkg.token, null, label + ': no approval token while verification is incomplete');
      assert.equal(pkg.message, UNRESOLVED_MESSAGE, label + ': established retry message');
      assert.ok((pkg.statuses || []).every(state => state === 'unavailable'), label + ': review rows marked unavailable');
    }
    return { ws, pkg };
  }

  // Pause, then Watch again: a new activation whose first reading is the next query.
  async function restart(c, { failOnce = null, fail, hold = null, wait = true } = {}) {
    await callIpcRaw('projects:pause', c.id);
    clearTrackedTimers();
    if (fail !== undefined) c.app.fail = fail;
    c.app.failOnce = failOnce;
    if (hold) c.app.hold = hold;
    const watching = callIpcRaw('projects:start-watching', c.id);
    // Wrapped, so that awaiting restart() does not wait for the held activation.
    if (!wait) return { watching };
    await watching;
    await metadataTestHooks.waitForWatcherIdle(c.id);
    return null;
  }

  const scope = id => metadataTestHooks.getIllustratorActivationScopeSnapshot(id);
  const status = id => metadataTestHooks.scopeStatus(id);
  const flag = id => metadataTestHooks.scopeFlag(id);
  const hasPath = (list, filePath) => list.some(item => item.endsWith('/' + base(filePath).toLowerCase()));

  async function addManually(c, filePath) {
    manualDialogFor([filePath]);
    const result = await callIpcRaw('projects:add-files', c.id);
    assert.ok(result, 'Add Files finished');
    await metadataTestHooks.waitForWatcherIdle(c.id);
  }

  const STORES = [['live store', false], ['copying store', true]];
  const scopeCase = (name, body) => {
    for (const [label, copied] of STORES) {
      scopeTest(`${name} (${label})`, { timeout: 120000 }, async () => {
        try { await withStore(copied, body); } finally {
          for (const held of [...openGates]) held.open();
          await pause(50);
        }
      });
    }
  };

  // ===== Fail on the base, pass with the rules =====
  scopeCase('failed-reading 1: a first reading that returns nothing keeps the project visible while blocking incomplete packaging', async () => {
    const c = await setup('first_empty');
    await restart(c, { fail: 'empty' });
    await assertFullProject(c, 'readings keep failing', { materializable: false });
    assert.equal(status(c.id), 'failed-closed');
  });

  scopeCase('failed-reading 2: a first reading with a count mismatch keeps the project visible while blocking incomplete packaging', async () => {
    const c = await setup('first_mismatch');
    await restart(c, { fail: 'count-mismatch' });
    await assertFullProject(c, 'readings keep failing', { materializable: false });
    assert.equal(status(c.id), 'failed-closed');
  });

  scopeCase('failed-reading 3: after a failed first reading, one complete running reading restores link tracking', async () => {
    const c = await setup('first_then_complete');
    await restart(c, { fail: 'empty' });
    c.app.fail = null;
    await poll(c.id);
    c.app.docs = [{ path: c.f.doc, modified: true, links: [...c.f.swatches, c.f.fresh] }];
    await poll(c.id);
    const ws = await workspace(c);
    assert.deepEqual(ws.pending, [['Fresh1.png', 'needs-save']], 'a new unsaved link gets its Needs Save row');
    assert.deepEqual([status(c.id), flag(c.id)], ['ready', 'recovered']);
    await assertFullProject(c, 'after recovery');
  });

  scopeCase('failed-reading 4: a mid-session count mismatch preserves scope and visibility while blocking incomplete packaging until recovery', async () => {
    const c = await setup('mid_mismatch');
    c.app.fail = 'count-mismatch';
    await poll(c.id);
    await assertFullProject(c, 'while readings fail', { materializable: false });
    assert.equal(status(c.id), 'ready');
    c.app.fail = null;
    await poll(c.id);
    await assertFullProject(c, 'after readings complete again', { materializable: true });
  });

  scopeCase('failed-reading 5: a mid-session reading that returns nothing does not end link tracking', async () => {
    const c = await setup('mid_empty');
    c.app.failOnce = 'empty';
    await poll(c.id);
    c.app.docs = [{ path: c.f.doc, modified: true, links: [...c.f.swatches, c.f.fresh] }];
    await poll(c.id);
    const ws = await workspace(c);
    assert.deepEqual(ws.pending, [['Fresh1.png', 'needs-save']]);
    await assertFullProject(c, 'after the failure');
  });

  scopeCase('failed-reading 6: failed readings before any baseline never hide the working document or its links', async () => {
    const c = await setup('two_failures');
    await restart(c, { fail: 'count-mismatch' });
    let snapshot = scope(c.id);
    assert.deepEqual([snapshot.status, snapshot.baselineDocumentPaths, snapshot.excludedLinkedPaths], ['failed-closed', [], []], 'after the first failed reading');
    await poll(c.id);
    snapshot = scope(c.id);
    assert.deepEqual([snapshot.status, snapshot.baselineDocumentPaths, snapshot.excludedLinkedPaths], ['failed-closed', [], []], 'after the second failed reading');
    await assertFullProject(c, 'while readings fail', { materializable: false });
    snapshot = scope(c.id);
    assert.deepEqual([snapshot.baselineDocumentPaths, snapshot.excludedLinkedPaths], [[], []], 'after the package step');
  });

  async function pendingAiFile(c, name, links = []) {
    const target = c.f.file(name);
    writeSyntheticAiFile(target, links.join('\n'));
    const started = stored(c.id).watchStartedAt;
    await emitWatcherWithStats('add', target, { mtimeMs: started - 86_400_000, birthtimeMs: started - 172_800_000 });
    await metadataTestHooks.waitForWatcherIdle(c.id);
    assert.ok((stored(c.id).pendingFiles || []).some(row => row.path === target), name + ' offered for review');
    return target;
  }
  function newAiFile(c, name, links = []) {
    const target = c.f.file(name);
    writeSyntheticAiFile(target, links.join('\n'));
    return target;
  }
  const projectFileNames = c => (stored(c.id).files || []).map(row => base(row.path));
  const pendingNames = c => (stored(c.id).pendingFiles || []).map(row => base(row.path));

  scopeCase('failed-reading 7: on the explicit-add path an admitted document is not put in the baseline', async () => {
    const c = await setup('explicit_add_recovery');
    const extraLinks = [c.f.file('Second1.png'), c.f.file('Second2.png')];
    for (const item of extraLinks) fs.writeFileSync(item, uniqueBytes('explicit_add_recovery', item));
    await restart(c, { fail: 'empty' });
    const second = await pendingAiFile(c, 'Second.ai', extraLinks);
    // From here readings complete; the accept moves the scope to recovering-explicit, so the next
    // complete reading, whichever route takes it, is the explicit-add recovery.
    c.app.fail = null;
    c.app.docs = [{ path: c.f.doc, links: [...c.f.swatches] }, { path: second, links: extraLinks }];
    // The accept is stored even when its own refreshed answer is superseded by the scan it starts.
    await callIpcRaw('projects:accept-pending', c.id, second);
    await metadataTestHooks.waitForWatcherIdle(c.id);
    assert.ok(projectFileNames(c).includes('Second.ai'), 'accepted');
    // A save event verifies the new working document, as the folder watcher would after a save.
    await emitWatcher('change', second);
    await metadataTestHooks.waitForWatcherIdle(c.id);
    await poll(c.id);
    assert.equal(hasPath(scope(c.id).baselineDocumentPaths, second), false, 'the admitted document is not put in the baseline');
    assert.deepEqual([status(c.id), flag(c.id)], ['ready', 'activation']);
    const ws = await workspace(c);
    for (const name of ['Second.ai', 'Second1.png', 'Second2.png']) assert.ok(ws.names.includes(name), 'workspace shows ' + name);
    const pkg = await packageStep(c);
    for (const name of ['Second.ai', 'Second1.png', 'Second2.png', ...FULL]) assert.ok(pkg.files?.includes(name), 'package includes ' + name + ': ' + JSON.stringify(pkg));
  });

  for (const scanFirst of [true, false]) {
    scopeCase(`failed-reading 8${scanFirst ? '' : ' (pair)'}: the flag reaches activation ${scanFirst ? 'after a package-scan recovery' : 'with no scan first'}`, async () => {
      const c = await setup(scanFirst ? 'flag_survives' : 'flag_survives_pair');
      const held = gate();
      const { watching } = await restart(c, { hold: held, wait: false });
      await waitForCondition(() => held.reached, 'activation reading held');
      if (scanFirst) {
        await callIpcRaw('projects:pre-package-scan', c.id);
        assert.equal(flag(c.id), 'recovered', 'the package-scan reading recovered first');
      }
      held.open();
      await watching;
      await metadataTestHooks.waitForWatcherIdle(c.id);
      assert.equal(flag(c.id), 'activation');
      const later = c.f.file('Later.ai');
      writeSyntheticAiFile(later, '');
      c.app.docs = [{ path: c.f.doc, links: [...c.f.swatches] }, { path: later, links: [] }];
      await poll(c.id);
      assert.equal(hasPath(scope(c.id).admittedDocumentPaths, later), true, 'a document opened after the activation is admitted');
      await assertFullProject(c, 'at the end', { extra: ['Later.ai'] });
    });
  }

  scopeCase('failed-reading 9: a mid-session failed reading refuses an earlier Package Review token and requires a fresh review after recovery', async () => {
    const c = await setup('review_refused_mid');
    const review = await callIpcRaw('projects:prepare-package-review', c.id);
    assert.equal(review?.materializable, true);
    assert.equal(typeof review.token, 'string', JSON.stringify(review).slice(0, 200));
    c.app.failOnce = 'count-mismatch';
    await poll(c.id);
    assert.deepEqual([status(c.id), flag(c.id)], ['ready', 'activation'], 'Rule F1 preserves scope state');
    const ws = await workspace(c);
    assert.equal(ws.included, 4, 'workspace keeps known project files visible');
    const refusedDuring = await runPackage(c, review.token, 'review_refused_during');
    assert.equal(refusedDuring.result?.error, 'package_review_stale', JSON.stringify(refusedDuring.result));
    assert.deepEqual(refusedDuring.written, [], 'no output written while verification is incomplete');
    await assertFullProject(c, 'review while still unverified after mid-session failure', { scan: false, materializable: false });
    // Next complete reading recovers verification; old token remains refused, fresh review succeeds.
    await poll(c.id);
    const refusedAfter = await runPackage(c, review.token, 'review_refused_after');
    assert.equal(refusedAfter.result?.error, 'package_review_stale', 'old pre-failure token remains refused after recovery');
    assert.deepEqual(refusedAfter.written, [], 'no output written for old token');
    const { pkg: fresh } = await assertFullProject(c, 'fresh review after recovery', { scan: false, materializable: true });
    const packaged = await runPackage(c, fresh.token, 'review_fresh_after');
    assert.equal(packaged.result?.success, true, JSON.stringify(packaged.result).slice(0, 300));
    assert.equal(packaged.result.totalFiles, 5);
  });

  scopeCase('failed-reading 10: an excluded owned asset is omitted from closed-scope review; not excluded, it stays visible while packaging stays blocked', async () => {
    const c = await setup('excluded_owned');
    writeSyntheticAiFile(c.f.doc, c.f.swatches.slice(0, 3).join('\n'));
    await emitWatcher('change', c.f.doc);
    await metadataTestHooks.waitForWatcherIdle(c.id);
    await poll(c.id);
    assert.ok(projectFileNames(c).includes('Swatch4.png'), 'still a project file after the save');
    await restart(c, { fail: 'empty' });
    let pkg = await packageStep(c);
    assert.ok(pkg.files?.includes('Swatch4.png'), 'not excluded: shown in closed-scope review: ' + JSON.stringify(pkg));
    assert.equal(pkg.materializable, false);
    assert.equal(pkg.token, null);
    await callIpcRaw('projects:remove-file', c.id, c.f.swatches[3]);
    await metadataTestHooks.waitForWatcherIdle(c.id);
    const ws = await workspace(c);
    assert.equal(ws.raw.files.find(row => row.name === 'Swatch4.png')?.included, false, 'shown as excluded');
    pkg = await packageStep(c);
    assert.equal(pkg.files?.includes('Swatch4.png'), false, 'excluded: omitted from review: ' + JSON.stringify(pkg));
    assert.equal(pkg.materializable, false);
    assert.equal(pkg.token, null);
    assert.equal(status(c.id), 'failed-closed');
  });

  for (const explicitAdd of [false, true]) {
    scopeCase(`failed-reading ${explicitAdd ? '12' : '11'}: package scans in the activation window${explicitAdd ? ' after an explicit add' : ''}, then a failed activation reading, never admit another project's document`, async () => {
      const c = await setup(explicitAdd ? 'window_explicit' : 'window_scans');
      c.app.docs = [{ path: c.f.doc, links: [...c.f.swatches] }, { path: c.f.flyer, links: [c.f.flyerArt] }];
      const held = gate();
      const { watching } = await restart(c, { hold: held, failOnce: 'empty', wait: false });
      await waitForCondition(() => held.reached, 'activation reading held');
      if (explicitAdd) {
        await addManually(c, newAiFile(c, 'Added.ai'));
        assert.equal(status(c.id), 'initializing');
      }
      await callIpcRaw('projects:pre-package-scan', c.id);
      await callIpcRaw('projects:pre-package-scan', c.id);
      held.open();
      await watching;
      await metadataTestHooks.waitForWatcherIdle(c.id);
      assert.equal(hasPath(scope(c.id).admittedDocumentPaths, c.f.flyer), false, 'the other document is not admitted');
      assert.equal(pendingNames(c).includes('FlyerArt.png'), false, 'its link is not staged');
      const ws = await workspace(c);
      assert.equal(ws.names.includes('FlyerArt.png') || ws.names.includes('Flyer.ai'), false);
      const pkg = await packageStep(c);
      assert.equal(pkg.files?.includes('FlyerArt.png') || pkg.files?.includes('Flyer.ai'), false, JSON.stringify(pkg));
      assert.equal(ws.included, 4);
    });
  }

  scopeCase('failed-reading 13: an accept after an automatic recovery leaves the flag recovered and admits no other document', async () => {
    const c = await setup('accept_after_recovery');
    const accepted = await pendingAiFile(c, 'Accepted.ai');
    const held = gate();
    const { watching } = await restart(c, { hold: held, wait: false });
    await waitForCondition(() => held.reached, 'activation reading held');
    // The automatic recovery: its flag is asserted with the later checks, so that on the base
    // this test fails where the accept's poll admits the other document.
    await callIpcRaw('projects:pre-package-scan', c.id);
    c.app.docs = [{ path: c.f.doc, links: [...c.f.swatches] }, { path: c.f.flyer, links: [c.f.flyerArt] }];
    // Two complete readings follow the accept: its own poll, then another poll.
    const before = c.app.queries;
    await callIpcRaw('projects:accept-pending', c.id, accepted);
    assert.ok(projectFileNames(c).includes('Accepted.ai'), 'accepted');
    await pollFinished(c.id);
    await metadataTestHooks.pollOutsideCoordinator(c.id);
    await pollFinished(c.id);
    assert.ok(c.app.queries - before >= 2, 'two readings after the accept: ' + (c.app.queries - before));
    assert.equal(hasPath(scope(c.id).admittedDocumentPaths, c.f.flyer), false, 'the other document is not admitted');
    assert.equal(pendingNames(c).includes('FlyerArt.png'), false);
    const ws = await workspace(c);
    assert.equal(ws.included, 4);
    assert.equal(ws.names.includes('FlyerArt.png'), false);
    assert.deepEqual([status(c.id), flag(c.id)], ['ready', 'recovered'], 'after two complete readings');
    // The first reading after the accept revises the scope while the accept's own verification
    // scan runs, so that scan's receipt is never published (the base does the same, there by
    // admitting the other document). A save of the accepted document verifies it again. The held
    // activation reading was taken before the other document opened, so a later reading would see
    // that document as opened after this activation; it is closed before the release.
    c.app.docs = [{ path: c.f.doc, links: [...c.f.swatches] }];
    held.open();
    await watching;
    await metadataTestHooks.waitForWatcherIdle(c.id);
    writeSyntheticAiFile(accepted, '');
    await emitWatcher('change', accepted);
    await metadataTestHooks.waitForWatcherIdle(c.id);
    await waitForCondition(() => Object.values(stored(c.id).workingSourceVerification || {})
      .every(receipt => receipt.status !== 'pending'), 'accepted document verified');
    const pkg = await packageStep(c, { scan: false });
    for (const name of ['Flyer.ai', 'FlyerArt.png']) assert.equal(pkg.files?.includes(name), false, name + ' not packaged: ' + JSON.stringify(pkg));
    for (const name of [...FULL, 'Accepted.ai']) assert.ok(pkg.files?.includes(name), name + ': ' + JSON.stringify(pkg));
  });

  scopeCase('failed-reading 14: an owned asset whose owner document is closed stays visible while packaging stays blocked until recovery', async () => {
    const c = await setup('owner_closed');
    c.app.docs = [{ path: c.f.flyer, links: [] }];
    await restart(c, { fail: 'count-mismatch' });
    await assertFullProject(c, 'owner closed', { materializable: false });
    assert.equal(status(c.id), 'failed-closed');
  });

  scopeCase('failed-reading 15: an asset with no owner record but an accepted source document stays visible while packaging stays blocked until recovery', async () => {
    const c = await setup('source_document');
    const row = stored(c.id).files.find(item => item.path === c.f.swatches[0]);
    delete row.dependencyOwners;
    row.sourceDocumentPath = c.f.doc;
    await restart(c, { fail: 'empty' });
    await assertFullProject(c, 'source document only', { materializable: false });
    assert.equal(status(c.id), 'failed-closed');
  });

  scopeCase('failed-reading 26: a poll reading started while recovering and applied after another reading failed is an automatic recovery', async () => {
    const c = await setup('in_flight_failure');
    await restart(c, { fail: 'empty' });
    const added = newAiFile(c, 'Added.ai');
    await addManually(c, added);
    assert.equal(status(c.id), 'recovering-explicit');
    c.app.fail = null;
    const held = c.app.hold = gate();
    const polling = metadataTestHooks.pollOutsideCoordinator(c.id);
    await waitForCondition(() => held.reached, 'poll reading held');
    c.app.failOnce = 'empty';
    await callIpcRaw('projects:pre-package-scan', c.id);
    assert.equal(status(c.id), 'failed-closed');
    held.open();
    await polling;
    await pollFinished(c.id);
    assert.deepEqual([status(c.id), flag(c.id)], ['ready', 'recovered']);
    const ws = await workspace(c);
    assert.equal(ws.included, 4);
    const pkg = await packageStep(c);
    for (const name of [...FULL, 'Added.ai']) assert.ok(pkg.files?.includes(name), name + ': ' + JSON.stringify(pkg));
  });

  scopeCase('failed-reading 27: a "not running" package-scan reading while initializing changes nothing', async () => {
    const c = await setup('not_running_initializing');
    const held = gate();
    const { watching } = await restart(c, { hold: held, wait: false });
    await waitForCondition(() => held.reached, 'activation reading held');
    c.app.running = false;
    await callIpcRaw('projects:pre-package-scan', c.id);
    assert.deepEqual([status(c.id), flag(c.id)], ['initializing', null], 'the scope is unchanged');
    const ws = await workspace(c);
    assert.equal(ws.names.includes('Swatch1.png'), false, 'as at any watch start');
    c.app.running = true;
    held.open();
    await watching;
    await metadataTestHooks.waitForWatcherIdle(c.id);
    assert.deepEqual([status(c.id), flag(c.id)], ['ready', 'activation']);
    await assertFullProject(c, 'after the activation reading');
  });

  // ===== Controls: each also holds on the base =====
  scopeCase('control 16: after a failed first reading another project\'s document is not staged by the poll, the open-files observer or accept-pending', async () => {
    const c = await setup('other_project_closed');
    // In the session before, the other project's unsaved document and its link get review rows
    // through the live reading, as any open document's do.
    c.app.docs = [{ path: c.f.doc, links: [...c.f.swatches] }, { path: c.f.flyer, links: [c.f.flyerArt], modified: true }];
    await poll(c.id, 2);
    const others = ['Flyer.ai', 'FlyerArt.png'];
    assert.deepEqual(pendingNames(c).filter(name => others.includes(name)).sort(), others, 'review rows for the other project');
    c.app.docs = [{ path: c.f.doc, links: [...c.f.swatches] }, { path: c.f.flyer, links: [c.f.flyerArt] }];
    await restart(c, { fail: 'count-mismatch' });
    await poll(c.id);
    c.app.openFiles = [c.f.flyer, c.f.flyerArt];
    await metadataTestHooks.pollLsofForProject(c.id, metadataTestHooks.getActiveWatchingActivationToken(c.id));
    await metadataTestHooks.waitForWatcherIdle(c.id);
    for (const target of [c.f.flyer, c.f.flyerArt]) {
      assert.equal(await callIpcRaw('projects:accept-pending', c.id, target), null, base(target) + ': accept refused');
    }
    // No route stages an Illustrator row while the scope is closed, so a row of this session is
    // the earlier row moved into it.
    for (const row of stored(c.id).pendingFiles.filter(item => others.includes(base(item.path)))) row.captureSessionId = stored(c.id).watchSessionId;
    for (const target of [c.f.flyer, c.f.flyerArt]) {
      assert.equal(await callIpcRaw('projects:accept-pending', c.id, target), null, base(target) + ': accept refused in this session');
    }
    const accepted = () => projectFileNames(c).filter(name => others.includes(name));
    assert.deepEqual(accepted(), []);
    assert.deepEqual(pendingNames(c).filter(name => others.includes(name)).sort(), others, 'the rows stay undecided');
    const ws = await workspace(c);
    for (const name of others) assert.equal(ws.names.includes(name) || ws.pending.some(([shown]) => shown === name), false, name + ' not shown');
    const pkg = await packageStep(c);
    for (const name of others) assert.equal((pkg.files || []).includes(name), false, name + ' not packaged: ' + JSON.stringify(pkg));
    assert.deepEqual(accepted(), []);
  });

  for (const recovery of ['automatic', 'explicit add']) {
    scopeCase(`control 17${recovery === 'automatic' ? '' : ' (pair)'}: another project's document closed before ${recovery === 'automatic' ? 'an automatic recovery' : 'an explicit-add recovery'} and reopened after it`, async () => {
      const c = await setup(recovery === 'automatic' ? 'reopened_automatic' : 'reopened_explicit');
      await restart(c, { fail: 'empty' });
      if (recovery === 'explicit add') await addManually(c, newAiFile(c, 'Added.ai'));
      c.app.fail = null;
      await poll(c.id);
      c.app.docs = [{ path: c.f.doc, links: [...c.f.swatches] }, { path: c.f.flyer, links: [c.f.flyerArt] }];
      await poll(c.id);
      const admitted = hasPath(scope(c.id).admittedDocumentPaths, c.f.flyer);
      const ws = await workspace(c);
      const pkg = await packageStep(c, { scan: false });
      if (recovery === 'automatic') {
        assert.equal(admitted, false, 'the reopened document is not admitted');
        assert.equal(pendingNames(c).includes('FlyerArt.png'), false);
        assert.equal(ws.names.includes('FlyerArt.png'), false);
        assert.equal((pkg.files || []).includes('Flyer.ai') || (pkg.files || []).includes('FlyerArt.png'), false, JSON.stringify(pkg));
      } else {
        assert.equal(admitted, true, 'today\'s explicit-add recovery admits it');
        assert.ok((pkg.files || []).includes('Flyer.ai'), 'and packages it: ' + JSON.stringify(pkg));
      }
    });
  }

  scopeCase('control 18: a failed first reading, then Illustrator quits; a package scan keeps the scope closed', async () => {
    const c = await setup('quit_after_failure');
    await restart(c, { fail: 'empty' });
    c.app.running = false;
    c.app.fail = null;
    const pkg = await packageStep(c);
    assert.equal(status(c.id), 'failed-closed');
    assert.equal((pkg.files || []).includes('Fresh1.png'), false);
    const ws = await workspace(c);
    assert.deepEqual(ws.pending, []);
  });

  scopeCase('control 18 (pair, needs rule F3): Illustrator running, a complete package-scan reading recovers', async () => {
    const c = await setup('running_after_failure');
    await restart(c, { fail: 'empty' });
    c.app.fail = null;
    await assertFullProject(c, 'after the package scan');
    assert.deepEqual([status(c.id), flag(c.id)], ['ready', 'recovered']);
  });

  scopeCase('control 18 (second part): a "not running" package-scan reading while recovering-explicit makes the scope ready', async () => {
    const c = await setup('quit_while_recovering');
    await restart(c, { fail: 'empty' });
    await addManually(c, newAiFile(c, 'Added.ai'));
    assert.equal(status(c.id), 'recovering-explicit');
    c.app.running = false;
    c.app.fail = null;
    const pkg = await packageStep(c);
    assert.equal(status(c.id), 'ready');
    assert.ok((pkg.files || []).includes('Added.ai'), JSON.stringify(pkg));
    const ws = await workspace(c);
    assert.ok(ws.names.includes('Added.ai'));
  });

  scopeCase('control 19: stored files outside change 2\'s conditions stay hidden while the scope is closed', async () => {
    const c = await setup('negatives', { swatchCount: 5 });
    const rows = stored(c.id).files;
    const row = filePath => rows.find(item => item.path === filePath);
    // A document of no project that no reading lists, so no hidden set names it and only
    // change 2's own conditions can keep the rows that name it hidden.
    const unlisted = path.join(path.dirname(c.f.flyer), 'Unlisted.ai');
    writeSyntheticAiFile(unlisted, '');
    delete row(c.f.swatches[0]).dependencyOwners;
    row(c.f.swatches[1]).dependencyOwners = [unlisted];
    row(c.f.swatches[3]).assetBaselineSourcePath = unlisted;
    row(c.f.swatches[4]).dependencyOwnersOverflow = true;
    // The package scan re-records the referencing document as an owner, so the saved
    // document no longer references the two files whose owner records are under test.
    writeSyntheticAiFile(c.f.doc, c.f.swatches.slice(2).join('\n'));
    c.app.docs = [{ path: c.f.doc, links: [...c.f.swatches] }, { path: c.f.flyer, links: [c.f.swatches[2]] }];
    await restart(c, { fail: 'count-mismatch' });
    assert.equal(hasPath(scope(c.id).excludedLinkedPaths, c.f.swatches[2]), true, 'Swatch3 is in the excluded set');
    const pendingArt = c.f.file('PendingArt.png');
    fs.writeFileSync(pendingArt, uniqueBytes('negatives', pendingArt));
    stored(c.id).pendingFiles.push({ path: pendingArt, name: 'PendingArt.png', ext: '.png', source: 'ai-linked', addedAt: Date.now(),
      captureState: 'needs-save', captureSessionId: stored(c.id).watchSessionId, dependencyOwners: [c.f.doc],
      captureEvidence: { appFamily: 'illustrator', observerMethod: 'illustrator-active-session', state: 'needs-save' } });
    assert.equal(hasPath(scope(c.id).baselineDocumentPaths, unlisted), false, 'no reading lists the unlisted document');
    // Swatch1 no owner and no source; Swatch2 owner not accepted; Swatch3 in the excluded set;
    // Swatch4 a recorded baseline source; Swatch5 an overflowed owner list and no source; a review row.
    const hidden = ['Swatch1.png', 'Swatch2.png', 'Swatch3.png', 'Swatch4.png', 'Swatch5.png', 'PendingArt.png'];
    const ws = await workspace(c);
    for (const name of hidden) assert.equal(ws.names.includes(name) || ws.pending.some(([shown]) => shown === name), false, name + ' hidden');
    const pkg = await packageStep(c);
    for (const name of hidden) assert.equal((pkg.files || []).includes(name), false, name + ' not packaged: ' + JSON.stringify(pkg));
    assert.equal(status(c.id), 'failed-closed');
  });

  scopeCase('control 20: change 2 does not apply while the activation reading is pending', async () => {
    const c = await setup('initializing_view');
    const held = gate();
    const { watching } = await restart(c, { hold: held, wait: false });
    await waitForCondition(() => held.reached, 'activation reading held');
    assert.equal(status(c.id), 'initializing');
    const ws = await workspace(c);
    for (const item of c.f.swatches) assert.equal(ws.names.includes(base(item)), false, base(item) + ' hidden as today');
    const pkg = await packageStep(c, { scan: false });
    assert.equal(pkg.materializable, false);
    assert.equal(pkg.token, null);
    assert.equal(pkg.message, UNRESOLVED_MESSAGE);
    for (const item of c.f.swatches) assert.equal((pkg.files || []).includes(base(item)), false, JSON.stringify(pkg));
    held.open();
    await watching;
  });

  scopeCase('control 21: while the scope is closed, staging and accept-pending of an owned asset are still refused', async () => {
    const c = await setup('gate_unchanged');
    await restart(c, { fail: 'empty' });
    const pendingArt = c.f.file('PendingArt.png');
    fs.writeFileSync(pendingArt, uniqueBytes('gate_unchanged', pendingArt));
    stored(c.id).pendingFiles.push({ path: pendingArt, name: 'PendingArt.png', ext: '.png', source: 'ai-linked', addedAt: Date.now(),
      captureState: 'needs-save', captureSessionId: stored(c.id).watchSessionId, dependencyOwners: [c.f.doc],
      captureEvidence: { appFamily: 'illustrator', observerMethod: 'illustrator-active-session', state: 'needs-save' } });
    assert.equal(await callIpcRaw('projects:accept-pending', c.id, pendingArt), null, 'accept-pending is refused');
    const staged = metadataTestHooks.stageIllustratorFile(c.id, { path: c.f.fresh, name: 'Fresh1.png', ext: '.png', source: 'ai-linked' },
      { appFamily: 'illustrator', relationshipSourcePath: c.f.doc, reason: 'app-live-evidence' });
    assert.equal(staged.reason, 'illustrator-activation-scope', 'staging is refused');
    assert.equal(projectFileNames(c).includes('PendingArt.png') || projectFileNames(c).includes('Fresh1.png'), false);
    const ws = await workspace(c);
    assert.equal(ws.names.includes('PendingArt.png'), false);
    const pkg = await packageStep(c);
    assert.equal((pkg.files || []).includes('PendingArt.png') || (pkg.files || []).includes('Fresh1.png'), false, JSON.stringify(pkg));
  });

  scopeCase('control 22: an explicit add from "failed closed" opens the scope and later documents are admitted', async () => {
    const c = await setup('explicit_add_opens');
    await restart(c, { fail: 'empty' });
    await addManually(c, newAiFile(c, 'Added.ai'));
    c.app.fail = null;
    await poll(c.id);
    assert.equal(status(c.id), 'ready');
    c.app.docs = [{ path: c.f.doc, links: [...c.f.swatches] }, { path: c.f.flyer, links: [] }];
    await poll(c.id);
    assert.equal(hasPath(scope(c.id).admittedDocumentPaths, c.f.flyer), true, 'a document opened later is admitted');
    const ws = await workspace(c);
    assert.ok(ws.names.includes('Added.ai'));
    const pkg = await packageStep(c, { scan: false });
    assert.ok((pkg.files || []).includes('Added.ai'), JSON.stringify(pkg));
  });

  scopeCase('control 22 (second part, needs rule F3): an explicit add after an automatic recovery admits the file and leaves the flag recovered', async () => {
    const c = await setup('explicit_add_after_recovery');
    await restart(c, { fail: 'empty' });
    c.app.fail = null;
    await poll(c.id);
    assert.equal(flag(c.id), 'recovered');
    const added = newAiFile(c, 'Added.ai');
    await addManually(c, added);
    await pollFinished(c.id);
    assert.deepEqual([status(c.id), flag(c.id)], ['ready', 'recovered']);
    assert.equal(hasPath(scope(c.id).admittedDocumentPaths, added), true);
    c.app.docs = [{ path: c.f.doc, links: [...c.f.swatches] }, { path: c.f.flyer, links: [] }];
    await poll(c.id);
    assert.equal(hasPath(scope(c.id).admittedDocumentPaths, c.f.flyer), false, 'the admitting clause stays off');
    const ws = await workspace(c);
    assert.ok(ws.names.includes('Added.ai'));
    const pkg = await packageStep(c, { scan: false });
    assert.ok((pkg.files || []).includes('Added.ai'), JSON.stringify(pkg));
  });

  scopeCase('control 24: a poll reading started while "failed closed" and applied after a manual add is the explicit-add recovery', async () => {
    const c = await setup('in_flight_manual_add');
    await restart(c, { fail: 'empty' });
    c.app.fail = null;
    const held = c.app.hold = gate();
    const polling = metadataTestHooks.pollOutsideCoordinator(c.id);
    await waitForCondition(() => held.reached, 'poll reading held');
    await addManually(c, newAiFile(c, 'Added.ai'));
    assert.equal(status(c.id), 'recovering-explicit');
    held.open();
    await polling;
    await pollFinished(c.id);
    assert.equal(status(c.id), 'ready');
    c.app.docs = [{ path: c.f.doc, links: [...c.f.swatches] }, { path: c.f.flyer, links: [] }];
    await poll(c.id);
    assert.equal(hasPath(scope(c.id).admittedDocumentPaths, c.f.flyer), true, 'the admitting clause is on, as after an explicit add');
    const ws = await workspace(c);
    assert.ok(ws.names.includes('Added.ai'));
    const pkg = await packageStep(c, { scan: false });
    assert.equal(pkg.materializable, true);
    assert.ok((pkg.files || []).includes('Added.ai'), JSON.stringify(pkg));
  });

  // ===== Incomplete-verification package guard & ordinary reader failures =====
  for (const mode of ['osascript-timeout', 'applescript-timeout-error', 'osascript-exec-error', 'automation-denied', 'pathless-untitled-doc']) {
    scopeCase(`failed-reading 28 (${mode}): ordinary reader failure keeps project visible, blocks incomplete approval, and recovers cleanly`, async () => {
      const c = await setup(`ordinary_${mode.replace(/-/g, '_')}`);
      c.app.docs = [{ path: c.f.doc, links: [...c.f.swatches] }, { path: c.f.flyer, links: [c.f.flyerArt] }];
      await restart(c, { fail: mode });
      assert.equal(status(c.id), 'failed-closed');
      const { ws: closedWs, pkg: closedPkg } = await assertFullProject(c, 'during ' + mode, { materializable: false });
      assert.equal(closedWs.names.includes('Flyer.ai') || closedWs.names.includes('FlyerArt.png'), false);
      assert.equal((closedPkg.files || []).includes('Flyer.ai') || (closedPkg.files || []).includes('FlyerArt.png'), false);

      // Recovery on next complete running read restores tracking and fresh packaging.
      c.app.fail = null;
      await poll(c.id);
      assert.deepEqual([status(c.id), flag(c.id)], ['ready', 'recovered']);
      assert.equal(hasPath(scope(c.id).baselineDocumentPaths, c.f.flyer), true);
      assert.equal(hasPath(scope(c.id).admittedDocumentPaths, c.f.flyer), false);

      c.app.docs = [
        { path: c.f.doc, modified: true, links: [...c.f.swatches, c.f.fresh] },
        { path: c.f.flyer, modified: true, links: [c.f.flyerArt] },
      ];
      await poll(c.id);
      const afterWs = await workspace(c);
      assert.deepEqual(afterWs.pending, [['Fresh1.png', 'needs-save']]);
      assert.equal(afterWs.names.includes('Flyer.ai') || afterWs.names.includes('FlyerArt.png'), false);

      const { pkg: fresh } = await assertFullProject(c, 'after recovery from ' + mode, { scan: false, materializable: true });
      const packaged = await runPackage(c, fresh.token, 'ordinary_' + mode.replace(/-/g, '_'));
      assert.equal(packaged.result?.success, true, JSON.stringify(packaged.result));
      assert.equal(packaged.result.totalFiles, 5);
    });
  }

  scopeCase('failed-reading 29: saved new link in illustrator-family doc without watcher change is blocked while failed-closed and packaged after recovery', async () => {
    const c = await setup('saved_link_no_watcher');
    const docRow = stored(c.id).files.find(item => item.path === c.f.doc);
    docRow.captureEvidence = { ...(docRow.captureEvidence || {}), appFamily: 'illustrator' };
    await restart(c, { fail: 'osascript-timeout' });
    assert.equal(status(c.id), 'failed-closed');

    // Save Layout.ai on disk linking Fresh1.png with no watcher change event.
    writeSyntheticAiFile(c.f.doc, [...c.f.swatches, c.f.fresh].join('\n'));
    const closedPkg = await packageStep(c, { scan: true });
    assert.equal(closedPkg.materializable, false, 'must refuse incomplete 5-file approval while failed-closed');
    assert.equal(closedPkg.token, null);
    assert.equal(closedPkg.message, UNRESOLVED_MESSAGE);
    assert.equal(projectFileNames(c).includes('Fresh1.png'), false, 'no implicit scope admission while failed-closed');

    // Next retry scan succeeds: recovers scope and surfaces Fresh1.png for review; accepting it packages all 6 files.
    c.app.fail = null;
    c.app.docs = [{ path: c.f.doc, links: [...c.f.swatches, c.f.fresh] }];
    await callIpcRaw('projects:pre-package-scan', c.id);
    await metadataTestHooks.waitForWatcherIdle(c.id);
    assert.equal(status(c.id), 'ready');
    assert.equal(flag(c.id), 'recovered');
    assert.ok(pendingNames(c).includes('Fresh1.png') || projectFileNames(c).includes('Fresh1.png'), 'recovery surfaces Fresh1.png');
    if (pendingNames(c).includes('Fresh1.png')) {
      assert.ok(await callIpcRaw('projects:accept-pending', c.id, c.f.fresh), 'Fresh1.png accepted after recovery');
      await metadataTestHooks.waitForWatcherIdle(c.id);
    }
    const recoveredPkg = await packageStep(c, { scan: false });
    assert.equal(recoveredPkg.materializable, true);
    assert.equal(typeof recoveredPkg.token, 'string');
    assert.deepEqual(recoveredPkg.files, [...FULL, 'Fresh1.png'].sort());
    const packaged = await runPackage(c, recoveredPkg.token, 'saved_link_recovered');
    assert.equal(packaged.result?.success, true, JSON.stringify(packaged.result));
    assert.equal(packaged.result.totalFiles, 6);
  });

  scopeCase('failed-reading 30: legacy unowned and overflow-owned ai-linked assets cannot produce a complete approval while failed-closed, then recover to full package', async () => {
    const c = await setup('incomplete_owner_inventory');
    const rows = stored(c.id).files;
    const r1 = rows.find(item => item.path === c.f.swatches[0]);
    const r2 = rows.find(item => item.path === c.f.swatches[1]);
    const r3 = rows.find(item => item.path === c.f.swatches[2]);
    delete r1.dependencyOwners;
    delete r1.sourceDocumentPath;
    r2.dependencyOwnersOverflow = true;
    delete r2.sourceDocumentPath;
    delete r3.dependencyOwners;
    delete r3.sourceDocumentPath;
    writeSyntheticAiFile(c.f.doc, [c.f.swatches[0], c.f.swatches[1], c.f.swatches[3]].join('\n'));

    await restart(c, { fail: 'osascript-timeout' });
    const noScanPkg = await packageStep(c, { scan: false });
    assert.equal(noScanPkg.materializable, false);
    assert.equal(noScanPkg.token, null);
    assert.equal(noScanPkg.message, UNRESOLVED_MESSAGE);
    const withScanPkg = await packageStep(c, { scan: true });
    assert.equal(withScanPkg.materializable, false, 'still blocked while Swatch2/Swatch3 remain hidden');
    assert.equal(withScanPkg.token, null);
    assert.equal(withScanPkg.message, UNRESOLVED_MESSAGE);

    // Next complete reading recovers full 5-file inventory and packaging.
    c.app.fail = null;
    c.app.docs = [{ path: c.f.doc, links: [...c.f.swatches] }];
    await poll(c.id);
    const { pkg: recovered } = await assertFullProject(c, 'after recovery', { scan: false, materializable: true });
    const packaged = await runPackage(c, recovered.token, 'incomplete_owner_recovered');
    assert.equal(packaged.result?.success, true, JSON.stringify(packaged.result));
    assert.equal(packaged.result.totalFiles, 5);
  });

  scopeCase('failed-reading 31: guard holds in recovering-explicit and at final pre-publish package check if Illustrator fails mid-flight', async () => {
    const c = await setup('final_package_guard');
    // Part A: recovering-explicit refuses approval until the recovery reading completes.
    await restart(c, { fail: 'osascript-timeout' });
    await addManually(c, newAiFile(c, 'Added.ai'));
    assert.equal(status(c.id), 'recovering-explicit');
    const recoveringPkg = await packageStep(c, { scan: false });
    assert.equal(recoveringPkg.materializable, false);
    assert.equal(recoveringPkg.token, null);
    assert.equal(recoveringPkg.message, UNRESOLVED_MESSAGE);

    c.app.fail = null;
    await poll(c.id);
    assert.equal(status(c.id), 'ready');
    const healthyReview = await packageStep(c, { scan: false });
    assert.equal(healthyReview.materializable, true);
    assert.equal(typeof healthyReview.token, 'string');

    // Part B: Final-package guard — valid token consumed, staging runs, then mid-session
    // Illustrator timeout lands right before finalManifest pre-publish verification.
    let finalHookHit = 0;
    const output = path.join(TEST_HOME, 'Documents', `Package_final_guard_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(output, { recursive: true });
    global.__crateBeforeFinalPackageManifest = async projectId => {
      if (projectId !== c.id) return;
      finalHookHit++;
      c.app.fail = 'osascript-timeout';
      await metadataTestHooks.pollOutsideCoordinator(c.id);
      await pollFinished(c.id);
    };
    let pkgResult;
    try {
      pkgResult = await callIpcRaw('projects:package', c.id, output, healthyReview.token);
    } finally {
      delete global.__crateBeforeFinalPackageManifest;
    }
    assert.equal(finalHookHit, 1, 'intercepted final pre-publish manifest check');
    assert.equal(pkgResult?.success, undefined, 'final package must refuse output: ' + JSON.stringify(pkgResult));
    assert.equal(pkgResult?.error, 'package_review_changed');
    assert.equal(pkgResult?.review?.materializable, false);
    assert.equal(pkgResult?.review?.token, undefined);
    assert.equal(pkgResult?.review?.message, UNRESOLVED_MESSAGE);
    assert.deepEqual(fs.readdirSync(output), [], 'zero output published after final-package refusal');

    // Recovery restores clean fresh packaging.
    c.app.fail = null;
    await poll(c.id);
    const freshReview = await packageStep(c, { scan: false });
    assert.equal(freshReview.materializable, true);
    const packaged = await runPackage(c, freshReview.token, 'final_guard_recovered');
    assert.equal(packaged.result?.success, true, JSON.stringify(packaged.result));
    assert.equal(packaged.result.totalFiles, 6);
  });

  scopeCase('control 25: non-Illustrator projects and paused healthy Illustrator projects continue packaging normally', async () => {
    // Part A: Non-Illustrator watching project packages normally even while Illustrator fails to read.
    resetTestHomeWorkspace();
    currentPsdFixture = { children: [], linkedFiles: [] };
    const dir = path.join(TEST_HOME, 'Desktop', 'NonIllustrator');
    fs.mkdirSync(dir, { recursive: true });
    const psdPath = path.join(dir, 'Poster.psd');
    const pngPath = path.join(dir, 'Photo.png');
    fs.writeFileSync(psdPath, Buffer.from('8BPS\0\x01\0\0\0\0\0\0\0\x03\0\0\0\x01\0\0\0\x01\0\x08\0\x03\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0'));
    fs.writeFileSync(pngPath, uniqueBytes('non_ai', pngPath));
    const app = illustrator();
    app.fail = 'osascript-timeout';
    const project = await createProject('Non Illustrator');
    await waitForCondition(() => app.queries >= 1, 'activation query failed');
    assert.equal(status(project.id), 'failed-closed');
    manualDialogFor([psdPath, pngPath]);
    await callIpcRaw('projects:add-files', project.id);
    await metadataTestHooks.waitForWatcherIdle(project.id);
    const nonAiReview = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(nonAiReview?.materializable, true, 'non-Illustrator project is not blocked: ' + JSON.stringify(nonAiReview));
    assert.equal(typeof nonAiReview?.token, 'string');
    const nonAiOut = path.join(TEST_HOME, 'Documents', `Package_non_ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(nonAiOut, { recursive: true });
    const nonAiPkg = await callIpcRaw('projects:package', project.id, nonAiOut, nonAiReview.token);
    assert.equal(nonAiPkg?.success, true, JSON.stringify(nonAiPkg));
    assert.equal(nonAiPkg.totalFiles, 2);

    // Part B: Paused healthy Illustrator project packages normally.
    const c = await setup('paused_healthy_ai');
    await callIpcRaw('projects:pause', c.id);
    clearTrackedTimers();
    const { pkg: pausedReview } = await assertFullProject(c, 'paused healthy Illustrator project', { scan: false, materializable: true });
    const pausedPkg = await runPackage(c, pausedReview.token, 'paused_healthy_ai');
    assert.equal(pausedPkg.result?.success, true, JSON.stringify(pausedPkg.result));
    assert.equal(pausedPkg.result.totalFiles, 5);

    // Part C: Pausing after a genuine Illustrator read failure does not bypass the guard;
    // resuming watching with a complete reading recovers normal packaging.
    await restart(c, { fail: 'osascript-timeout' });
    assert.equal(status(c.id), 'failed-closed');
    await callIpcRaw('projects:pause', c.id);
    clearTrackedTimers();
    await assertFullProject(c, 'paused after genuine Illustrator read failure', { scan: false, materializable: false });
    await restart(c, { fail: null });
    assert.equal(status(c.id), 'ready');
    const { pkg: resumedReview } = await assertFullProject(c, 'resumed after complete Illustrator reading', { scan: false, materializable: true });
    const resumedPkg = await runPackage(c, resumedReview.token, 'resumed_healthy_ai');
    assert.equal(resumedPkg.result?.success, true, JSON.stringify(resumedPkg.result));
    assert.equal(resumedPkg.result.totalFiles, 5);
  });

  function collectPackagedFileNames(rootDir) {
    const names = [];
    const walk = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'Crate Diagnostics') continue;
          walk(full);
        } else if (entry.isFile()) {
          names.push(entry.name);
        }
      }
    };
    walk(rootDir);
    return names.sort();
  }

  // ===== Finding 2: Illustrator package relevance scoping =====
  scopeCase('failed-reading 32: Add Files saved .ai working file (no Illustrator-tagged rows) is held on failed reading and packages cleanly after recovery', async () => {
    resetTestHomeWorkspace();
    currentPsdFixture = { children: [], linkedFiles: [] };
    const dir = path.join(TEST_HOME, 'Desktop', 'Sample_add_files_ai');
    const elsewhere = path.join(TEST_HOME, 'Documents', 'Elsewhere_add_files_ai');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(elsewhere, { recursive: true });
    const doc = path.join(dir, 'ManualLayout.ai');
    const flyer = path.join(elsewhere, 'Flyer.ai');
    const flyerArt = path.join(elsewhere, 'FlyerArt.png');
    fs.writeFileSync(flyerArt, uniqueBytes('add_files_ai', flyerArt));
    writeSyntheticAiFile(doc, '');
    writeSyntheticAiFile(flyer, flyerArt);

    const app = illustrator();
    app.running = false;
    const project = await createProject('Add Files AI');
    const c = { id: project.id, app, f: { dir, doc, flyer, flyerArt } };
    await waitForCondition(() => app.queries >= 0, 'project ready');
    await callIpcRaw('projects:pause', c.id);
    clearTrackedTimers();

    // Add saved .ai via the real projects:add-files route (no Illustrator-tagged rows).
    await addManually(c, doc);
    const storedRows = stored(c.id).files || [];
    assert.deepEqual(storedRows.map(row => row.name), ['ManualLayout.ai']);
    assert.equal(storedRows[0].source, 'manual-browse');
    assert.equal(storedRows[0].captureEvidence, undefined, 'must not force captureEvidence on Add Files row');

    // Watch with Illustrator running and first reading failing while another unrelated doc is open.
    app.running = true;
    app.docs = [{ path: doc, links: [] }, { path: flyer, links: [flyerArt] }];
    await restart(c, { fail: 'osascript-timeout' });
    assert.equal(status(c.id), 'failed-closed');

    const blocked = await packageStep(c, { scan: false });
    assert.equal(blocked.materializable, false, 'Add Files .ai must be held while Illustrator reading fails: ' + JSON.stringify(blocked));
    assert.equal(blocked.token, null, 'no approval token while failed-closed');
    assert.equal(blocked.message, UNRESOLVED_MESSAGE);

    // Next complete reading restores fresh review and packages exact project files with intact manifest.
    app.fail = null;
    await poll(c.id);
    assert.deepEqual([status(c.id), flag(c.id)], ['ready', 'recovered']);
    const fresh = await packageStep(c, { scan: false });
    assert.equal(fresh.materializable, true, 'fresh review ready after complete reading: ' + JSON.stringify(fresh));
    assert.equal(typeof fresh.token, 'string');
    assert.deepEqual(fresh.files, ['ManualLayout.ai'], 'review manifest holds only project files');

    const packaged = await runPackage(c, fresh.token, 'add_files_ai_recovered');
    assert.equal(packaged.result?.success, true, JSON.stringify(packaged.result));
    assert.equal(packaged.result.totalFiles, 1);
    const writtenNames = collectPackagedFileNames(packaged.result.folderPath);
    assert.deepEqual(writtenNames, ['ManualLayout.ai'], 'package output holds only project files, nothing from Flyer.ai');
    assert.equal(writtenNames.includes('Flyer.ai') || writtenNames.includes('FlyerArt.png'), false);
  });

  scopeCase('failed-reading 33 (lastused-scan): accepted .ai from ordinary open-file admission is held on failed reading and packages cleanly after recovery', async () => {
    resetTestHomeWorkspace();
    currentPsdFixture = { children: [], linkedFiles: [] };
    const dir = path.join(TEST_HOME, 'Desktop', 'Sample_lastused_scan_ai');
    const elsewhere = path.join(TEST_HOME, 'Documents', 'Elsewhere_lastused_scan_ai');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(elsewhere, { recursive: true });
    const anchorPng = path.join(dir, 'Brief.png');
    const doc = path.join(dir, 'LastUsedLayout.ai');
    const flyer = path.join(elsewhere, 'Flyer.ai');
    const flyerArt = path.join(elsewhere, 'FlyerArt.png');
    fs.writeFileSync(anchorPng, uniqueBytes('lastused_scan', anchorPng));
    fs.writeFileSync(flyerArt, uniqueBytes('lastused_scan', flyerArt));
    writeSyntheticAiFile(doc, '');
    writeSyntheticAiFile(flyer, flyerArt);

    const app = illustrator();
    app.running = false;
    const project = await createProject('Open File lastused-scan');
    const c = { id: project.id, app, f: { dir, doc, flyer, flyerArt } };
    await waitForCondition(() => status(c.id) === 'ready', 'activation scope ready');
    await metadataTestHooks.waitForWatcherIdle(c.id);

    // Establish the project folder as the session anchor with a non-Illustrator file (no Illustrator rows).
    await addManually(c, anchorPng);
    assert.deepEqual((stored(c.id).files || []).map(row => row.name), ['Brief.png']);
    await callIpcRaw('projects:pause', c.id);
    clearTrackedTimers();

    // Ordinary open-file discovery via lastused-scan stages LastUsedLayout.ai as pending; accept it.
    app.recentLastUsedPaths = [doc];
    await callIpcRaw('projects:pre-package-scan', c.id);
    await metadataTestHooks.waitForWatcherIdle(c.id);
    app.recentLastUsedPaths = [];

    assert.ok((stored(c.id).pendingFiles || []).some(row => row.path === doc), 'lastused-scan staged pending .ai candidate');
    const accepted = await callIpcRaw('projects:accept-pending', c.id, doc);
    assert.ok(accepted, 'lastused-scan accept-pending succeeded');
    await metadataTestHooks.waitForWatcherIdle(c.id);

    const row = (stored(c.id).files || []).find(item => item.path === doc);
    assert.ok(row, 'lastused-scan .ai admitted to project.files');
    assert.equal(row.source, 'lastused-scan');
    assert.equal(row.acceptedPending, true);
    assert.equal(row.captureEvidence, undefined, 'accepted pending row has no forced captureEvidence');

    // Watch with Illustrator running and first reading failing while another unrelated doc is open.
    app.running = true;
    app.docs = [{ path: doc, links: [] }, { path: flyer, links: [flyerArt] }];
    await restart(c, { fail: 'osascript-timeout' });
    assert.equal(status(c.id), 'failed-closed');

    const blocked = await packageStep(c, { scan: false });
    assert.equal(blocked.materializable, false, 'lastused-scan accepted .ai must be held while Illustrator reading fails: ' + JSON.stringify(blocked));
    assert.equal(blocked.token, null);
    assert.equal(blocked.message, UNRESOLVED_MESSAGE);

    // Next complete reading recovers and packages exact project files.
    app.fail = null;
    await poll(c.id);
    assert.deepEqual([status(c.id), flag(c.id)], ['ready', 'recovered']);
    const fresh = await packageStep(c, { scan: false });
    assert.equal(fresh.materializable, true, 'lastused-scan fresh review ready after recovery: ' + JSON.stringify(fresh));
    assert.equal(typeof fresh.token, 'string');
    assert.deepEqual(fresh.files, ['Brief.png', 'LastUsedLayout.ai']);

    const packaged = await runPackage(c, fresh.token, 'lastused_scan_ai_recovered');
    assert.equal(packaged.result?.success, true, JSON.stringify(packaged.result));
    assert.equal(packaged.result.totalFiles, 2);
    const writtenNames = collectPackagedFileNames(packaged.result.folderPath);
    assert.deepEqual(writtenNames, ['Brief.png', 'LastUsedLayout.ai']);
    assert.equal(writtenNames.includes('Flyer.ai') || writtenNames.includes('FlyerArt.png'), false);
  });

  scopeCase('control 26a: Photoshop project linking .ai assets still packages normally when Illustrator readings fail', async () => {
    const validPsdHeader = Buffer.from('8BPS\0\x01\0\0\0\0\0\0\0\x03\0\0\0\x01\0\0\0\x01\0\x08\0\x03\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0');
    resetTestHomeWorkspace();
    const psdDir = path.join(TEST_HOME, 'Desktop', 'Sample_psd_links_ai');
    fs.mkdirSync(psdDir, { recursive: true });
    const psdPath = path.join(psdDir, 'Poster.psd');
    const psdBadgeAi = path.join(psdDir, 'PsdBadge.ai');
    writeSyntheticAiFile(psdBadgeAi, '');
    fs.writeFileSync(psdPath, validPsdHeader);
    currentPsdFixture = {
      children: [{ name: 'PsdBadge', linkedFile: { fullPath: psdBadgeAi } }],
      linkedFiles: [],
    };

    const psdApp = illustrator();
    psdApp.fail = 'osascript-timeout';
    const psdProject = await createProject('PSD Links AI');
    await waitForCondition(() => psdApp.queries >= 1, 'psd project activation query failed');
    assert.equal(status(psdProject.id), 'failed-closed');

    manualDialogFor([psdPath]);
    await callIpcRaw('projects:add-files', psdProject.id);
    await metadataTestHooks.waitForWatcherIdle(psdProject.id);
    await callIpcRaw('projects:set-existing-assets-decision', psdProject.id, 'include');

    const psdRows = stored(psdProject.id).files || [];
    assert.equal(psdRows.find(row => row.path === psdBadgeAi)?.source, 'psd-linked', 'psd-linked .ai present');

    const psdReview = await callIpcRaw('projects:prepare-package-review', psdProject.id);
    assert.equal(psdReview?.materializable, true, 'Photoshop project linking .ai must not be blocked: ' + JSON.stringify(psdReview));
    assert.equal(typeof psdReview?.token, 'string');
    const psdOut = path.join(TEST_HOME, 'Documents', `Package_psd_links_ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(psdOut, { recursive: true });
    const psdPkg = await callIpcRaw('projects:package', psdProject.id, psdOut, psdReview.token);
    assert.equal(psdPkg?.success, true, JSON.stringify(psdPkg));
    assert.equal(psdPkg.totalFiles, 2);
    assert.deepEqual(collectPackagedFileNames(psdPkg.folderPath), ['Poster.psd', 'PsdBadge.ai']);
  });

  scopeCase('control 26b: InDesign project linking .ai assets still packages normally when Illustrator readings fail', async () => {
    resetTestHomeWorkspace();
    currentPsdFixture = { children: [], linkedFiles: [] };
    const inddDir = path.join(TEST_HOME, 'Desktop', 'Sample_indd_links_ai');
    fs.mkdirSync(inddDir, { recursive: true });
    const inddPath = path.join(inddDir, 'Brochure.indd');
    const inddScanAi = path.join(inddDir, 'InddScanMark.ai');
    const inddScriptAi = path.join(inddDir, 'InddScriptMark.ai');
    writeSyntheticAiFile(inddScanAi, '');
    writeSyntheticAiFile(inddScriptAi, '');
    fs.writeFileSync(inddPath, 'synthetic indesign document\n');

    const inddApp = illustrator();
    inddApp.fail = 'osascript-timeout';
    inddApp.inddDocs = [{ path: inddPath, links: [inddScanAi] }];
    inddApp.inddScanLinks = [inddScriptAi];
    const inddProject = await createProject('InDesign Links AI');
    await waitForCondition(() => inddApp.queries >= 1, 'indd project activation query failed');
    assert.equal(status(inddProject.id), 'failed-closed');

    manualDialogFor([inddPath]);
    await callIpcRaw('projects:add-files', inddProject.id);
    await metadataTestHooks.waitForWatcherIdle(inddProject.id);
    await callIpcRaw('projects:set-existing-assets-decision', inddProject.id, 'include');

    await callIpcRaw('projects:pre-package-scan', inddProject.id);
    await metadataTestHooks.waitForWatcherIdle(inddProject.id);
    if ((stored(inddProject.id).pendingFiles || []).some(row => row.path === inddScriptAi)) {
      await callIpcRaw('projects:accept-pending', inddProject.id, inddScriptAi);
      await metadataTestHooks.waitForWatcherIdle(inddProject.id);
    }
    await keepNewWorkingFiles({ id: inddProject.id });

    const inddRows = stored(inddProject.id).files || [];
    assert.equal(inddRows.find(row => row.path === inddScanAi)?.source, 'scan-on-open', 'scan-on-open InDesign-linked .ai present');
    assert.equal(inddRows.find(row => row.path === inddScriptAi)?.source, 'indd-linked', 'indd-linked .ai present');

    const inddReview = await callIpcRaw('projects:prepare-package-review', inddProject.id);
    assert.equal(inddReview?.materializable, true, 'InDesign project linking .ai must not be blocked: ' + JSON.stringify(inddReview));
    assert.equal(typeof inddReview?.token, 'string');
    const inddOut = path.join(TEST_HOME, 'Documents', `Package_indd_links_ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(inddOut, { recursive: true });
    const inddPkg = await callIpcRaw('projects:package', inddProject.id, inddOut, inddReview.token);
    assert.equal(inddPkg?.success, true, JSON.stringify(inddPkg));
    assert.equal(inddPkg.totalFiles, 3);
    assert.deepEqual(collectPackagedFileNames(inddPkg.folderPath), ['Brochure.indd', 'InddScanMark.ai', 'InddScriptMark.ai']);
  });

  scopeCase('control 27: non-Illustrator project with explicit Add Files .pdf, .svg, and .eps still packages normally when Illustrator readings fail', async () => {
    resetTestHomeWorkspace();
    currentPsdFixture = { children: [], linkedFiles: [] };
    const dir = path.join(TEST_HOME, 'Desktop', 'Sample_generic_vector_files');
    fs.mkdirSync(dir, { recursive: true });
    const psdPath = path.join(dir, 'Board.psd');
    const pdfPath = path.join(dir, 'Spec.pdf');
    const svgPath = path.join(dir, 'Icon.svg');
    const epsPath = path.join(dir, 'Emblem.eps');
    fs.writeFileSync(psdPath, Buffer.from('8BPS\0\x01\0\0\0\0\0\0\0\x03\0\0\0\x01\0\0\0\x01\0\x08\0\x03\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0'));
    writeSyntheticPdfFile(pdfPath, 'generic pdf spec');
    fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"></svg>');
    fs.writeFileSync(epsPath, '%!PS-Adobe-3.0 EPSF-3.0\n%%EOF\n');

    const app = illustrator();
    app.fail = 'osascript-timeout';
    const project = await createProject('Generic PDF SVG EPS');
    await waitForCondition(() => app.queries >= 1, 'activation query failed');
    assert.equal(status(project.id), 'failed-closed');

    manualDialogFor([psdPath, pdfPath, svgPath, epsPath]);
    await callIpcRaw('projects:add-files', project.id);
    await metadataTestHooks.waitForWatcherIdle(project.id);
    await keepNewWorkingFiles({ id: project.id });

    const review = await callIpcRaw('projects:prepare-package-review', project.id);
    assert.equal(review?.materializable, true, 'explicit generic .pdf/.svg/.eps must not be blocked: ' + JSON.stringify(review));
    assert.equal(typeof review?.token, 'string');
    const out = path.join(TEST_HOME, 'Documents', `Package_generic_vectors_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(out, { recursive: true });
    const pkg = await callIpcRaw('projects:package', project.id, out, review.token);
    assert.equal(pkg?.success, true, JSON.stringify(pkg));
    assert.equal(pkg.totalFiles, 4);
    assert.deepEqual(collectPackagedFileNames(pkg.folderPath), ['Board.psd', 'Emblem.eps', 'Icon.svg', 'Spec.pdf']);
  });

  scopeCase('failed-reading 34: former psd-linked .ai explicitly added via Add Files is held on failed Illustrator reading and packages cleanly after recovery', async () => {
    const validPsdHeader = Buffer.from('8BPS\0\x01\0\0\0\0\0\0\0\x03\0\0\0\x01\0\0\0\x01\0\x08\0\x03\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0');
    resetTestHomeWorkspace();
    const psdDir = path.join(TEST_HOME, 'Desktop', 'Sample_psd_readd_ai');
    const elsewhere = path.join(TEST_HOME, 'Documents', 'Elsewhere_psd_readd_ai');
    fs.mkdirSync(psdDir, { recursive: true });
    fs.mkdirSync(elsewhere, { recursive: true });
    const psdPath = path.join(psdDir, 'Poster.psd');
    const psdBadgeAi = path.join(psdDir, 'PsdBadge.ai');
    const flyer = path.join(elsewhere, 'Flyer.ai');
    const flyerArt = path.join(elsewhere, 'FlyerArt.png');
    fs.writeFileSync(flyerArt, uniqueBytes('psd_readd_ai', flyerArt));
    writeSyntheticAiFile(psdBadgeAi, '');
    writeSyntheticAiFile(flyer, flyerArt);
    fs.writeFileSync(psdPath, validPsdHeader);
    currentPsdFixture = {
      children: [{ name: 'PsdBadge', linkedFile: { fullPath: psdBadgeAi } }],
      linkedFiles: [],
    };

    const app = illustrator();
    app.running = false;
    const project = await createProject('PSD Re-Add AI');
    const c = { id: project.id, app, f: { dir: psdDir, psdPath, psdBadgeAi, flyer, flyerArt } };
    await waitForCondition(() => status(c.id) === 'ready', 'activation scope ready');
    await metadataTestHooks.waitForWatcherIdle(c.id);

    // Add Poster.psd so PsdBadge.ai is captured as a Photoshop-linked asset (psd-linked).
    await addManually(c, psdPath);
    await callIpcRaw('projects:set-existing-assets-decision', c.id, 'include');
    await metadataTestHooks.waitForWatcherIdle(c.id);

    const beforeRow = (stored(c.id).files || []).find(row => row.path === psdBadgeAi);
    assert.ok(beforeRow, 'psd-linked .ai row exists before Add Files');
    assert.equal(beforeRow.source, 'psd-linked');
    assert.equal(beforeRow.explicitUserAuthority, undefined);

    // User explicitly adds that same .ai via real Add Files as a working file.
    await addManually(c, psdBadgeAi);
    const afterRow = (stored(c.id).files || []).find(row => row.path === psdBadgeAi);
    assert.ok(afterRow, 're-added .ai row remains in project.files');
    assert.equal(afterRow.source, 'psd-linked', 'capture source stays psd-linked');
    assert.equal(afterRow.explicitUserAuthority?.granted, true, 'Add Files grants explicit user authority');
    assert.equal(afterRow.explicitUserAuthority?.source, 'manual-browse');
    assert.equal(afterRow.explicitUserAuthority?.method, 'projects:add-files');
    assert.equal(afterRow.assetOrigin, 'added');
    assert.equal(afterRow.assetBaselineSourcePath, undefined);

    // Watch with Illustrator running and reading failing while an unrelated document is also open.
    app.running = true;
    app.docs = [{ path: psdBadgeAi, links: [] }, { path: flyer, links: [flyerArt] }];
    await restart(c, { fail: 'osascript-timeout' });
    assert.equal(status(c.id), 'failed-closed');

    const blocked = await packageStep(c, { scan: false });
    assert.equal(blocked.materializable, false, 'former psd-linked .ai added via Add Files must be held while Illustrator reading fails: ' + JSON.stringify(blocked));
    assert.equal(blocked.token, null, 'no approval token while failed-closed');
    assert.equal(blocked.message, UNRESOLVED_MESSAGE);

    // Next complete reading in the same Watch session restores fresh review and packages only exact project files.
    app.fail = null;
    await poll(c.id);
    assert.deepEqual([status(c.id), flag(c.id)], ['ready', 'recovered']);

    const fresh = await packageStep(c, { scan: false });
    assert.equal(fresh.materializable, true, 'fresh review ready after complete reading: ' + JSON.stringify(fresh));
    assert.equal(typeof fresh.token, 'string');
    assert.deepEqual(fresh.files, ['Poster.psd', 'PsdBadge.ai']);

    const packaged = await runPackage(c, fresh.token, 'psd_readd_ai_recovered');
    assert.equal(packaged.result?.success, true, JSON.stringify(packaged.result));
    assert.equal(packaged.result.totalFiles, 2);
    const writtenNames = collectPackagedFileNames(packaged.result.folderPath);
    assert.deepEqual(writtenNames, ['Poster.psd', 'PsdBadge.ai'], 'package holds only project files, nothing from Flyer.ai');
    assert.equal(writtenNames.includes('Flyer.ai') || writtenNames.includes('FlyerArt.png'), false);
  });

  scopeCase('failed-reading 35: in-session Add Files promotion of a psd-linked .ai during an Illustrator failure engages the hold until the next complete reading', async () => {
    const validPsdHeader = Buffer.from('8BPS\0\x01\0\0\0\0\0\0\0\x03\0\0\0\x01\0\0\0\x01\0\x08\0\x03\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0');
    resetTestHomeWorkspace();
    const psdDir = path.join(TEST_HOME, 'Desktop', 'Sample_psd_readd_insession');
    const elsewhere = path.join(TEST_HOME, 'Documents', 'Elsewhere_psd_readd_insession');
    fs.mkdirSync(psdDir, { recursive: true });
    fs.mkdirSync(elsewhere, { recursive: true });
    const psdPath = path.join(psdDir, 'Poster.psd');
    const psdBadgeAi = path.join(psdDir, 'PsdBadge.ai');
    const flyer = path.join(elsewhere, 'Flyer.ai');
    const flyerArt = path.join(elsewhere, 'FlyerArt.png');
    fs.writeFileSync(flyerArt, uniqueBytes('psd_readd_insession', flyerArt));
    writeSyntheticAiFile(psdBadgeAi, '');
    writeSyntheticAiFile(flyer, flyerArt);
    fs.writeFileSync(psdPath, validPsdHeader);
    currentPsdFixture = {
      children: [{ name: 'PsdBadge', linkedFile: { fullPath: psdBadgeAi } }],
      linkedFiles: [],
    };

    const app = illustrator();
    app.fail = 'osascript-timeout';
    app.docs = [{ path: psdBadgeAi, links: [] }, { path: flyer, links: [flyerArt] }];
    const project = await createProject('PSD Re-Add In-Session');
    const c = { id: project.id, app, f: { dir: psdDir, psdPath, psdBadgeAi, flyer, flyerArt } };
    await waitForCondition(() => app.queries >= 1, 'activation query failed');
    assert.equal(status(c.id), 'failed-closed');

    // Before Add Files: PsdBadge.ai is merely psd-linked, so Package Review remains materializable.
    await addManually(c, psdPath);
    await callIpcRaw('projects:set-existing-assets-decision', c.id, 'include');
    await metadataTestHooks.waitForWatcherIdle(c.id);

    const linkedOnlyRow = (stored(c.id).files || []).find(row => row.path === psdBadgeAi);
    assert.equal(linkedOnlyRow?.source, 'psd-linked');
    assert.equal(linkedOnlyRow?.explicitUserAuthority, undefined);

    const beforeAddReview = await packageStep(c, { scan: false });
    assert.equal(beforeAddReview.materializable, true, 'merely linked psd-linked .ai remains unblocked before Add Files: ' + JSON.stringify(beforeAddReview));
    assert.equal(typeof beforeAddReview.token, 'string');

    // Now the user adds PsdBadge.ai via real Add Files in this same Watch session.
    await addManually(c, psdBadgeAi);
    assert.equal(status(c.id), 'recovering-explicit');

    const promotedRow = (stored(c.id).files || []).find(row => row.path === psdBadgeAi);
    assert.equal(promotedRow?.source, 'psd-linked');
    assert.equal(promotedRow?.explicitUserAuthority?.granted, true);
    assert.equal(promotedRow?.explicitUserAuthority?.source, 'manual-browse');

    const blocked = await packageStep(c, { scan: false });
    assert.equal(blocked.materializable, false, 'promoted psd-linked .ai must be held while Illustrator reading is unresolved: ' + JSON.stringify(blocked));
    assert.equal(blocked.token, null);
    assert.equal(blocked.message, UNRESOLVED_MESSAGE);

    // Next complete reading in the same Watch session restores fresh review and packages exact project files.
    app.fail = null;
    await poll(c.id);
    assert.equal(status(c.id), 'ready');

    const fresh = await packageStep(c, { scan: false });
    assert.equal(fresh.materializable, true, 'fresh review ready after complete reading: ' + JSON.stringify(fresh));
    assert.equal(typeof fresh.token, 'string');
    assert.deepEqual(fresh.files, ['Poster.psd', 'PsdBadge.ai']);

    const packaged = await runPackage(c, fresh.token, 'psd_readd_insession_recovered');
    assert.equal(packaged.result?.success, true, JSON.stringify(packaged.result));
    assert.equal(packaged.result.totalFiles, 2);
    const writtenNames = collectPackagedFileNames(packaged.result.folderPath);
    assert.deepEqual(writtenNames, ['Poster.psd', 'PsdBadge.ai'], 'package holds only project files, nothing from Flyer.ai');
    assert.equal(writtenNames.includes('Flyer.ai') || writtenNames.includes('FlyerArt.png'), false);
  });
}
