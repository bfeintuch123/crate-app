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
  // Failure kinds: 'empty' (nothing comes back) and 'count-mismatch' (rows listed, wrong end counts).
  function illustrator() {
    const app = { running: true, docs: [], fail: null, failOnce: null, hold: null, queries: 0, openFiles: [] };
    setChildProcessHandler(request => {
      const { kind, command, args } = request;
      const xattrPaths = bulkXattrPaths(request);
      if (xattrPaths.length) return { stdout: formatBulkXattrOutput(xattrPaths, () => encodeLastUsedXattr(Date.now() - 400 * 86400000)) };
      if (isIdentityRead(request)) return { stdout: '' };
      if (isIllustratorPgrepCheck({ kind, command, args })) return { stdout: app.running ? '654\n' : '' };
      if (kind === 'exec' && String(command).startsWith('/bin/ps ax -o pid= -o command=')) {
        return { stdout: app.openFiles.length ? '888 /Applications/Adobe Illustrator 2026/Adobe Illustrator.app/Contents/MacOS/Adobe Illustrator\n' : '' };
      }
      if (kind === 'exec' && String(command).startsWith('/usr/sbin/lsof -F ptn -p 888')) {
        return { stdout: 'p888\n' + app.openFiles.map((item, index) => `f${20 + index}\ntREG\nn${item}\n`).join('') };
      }
      if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
        app.queries++;
        const mode = app.failOnce || app.fail;
        app.failOnce = null;
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
        else stdout = app.docs.length ? [...rows, `COMPLETE\t${app.docs.length}\t${links}`].join('\n') + '\n' : 'STATUS\tno-documents\nCOMPLETE\t0\t0\n';
        const result = { stdout }, held = app.hold;
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

  async function packageStep(c, { scan = true } = {}) {
    if (scan) await callIpcRaw('projects:pre-package-scan', c.id);
    await metadataTestHooks.waitForWatcherIdle(c.id);
    await keepNewWorkingFiles(c);
    const answer = await callIpcRaw('projects:prepare-package-review', c.id);
    return { error: answer?.error || null, materializable: answer?.materializable ?? null,
      files: Array.isArray(answer?.files) ? answer.files.map(item => item.name).sort() : null };
  }

  const FULL = ['Layout.ai', 'Swatch1.png', 'Swatch2.png', 'Swatch3.png', 'Swatch4.png'];
  async function assertFullProject(c, label, { scan = true, extra = [] } = {}) {
    const ws = await workspace(c);
    assert.equal(ws.included, 4, label + ': four included assets: ' + JSON.stringify(ws.names));
    for (const name of FULL) assert.ok(ws.names.includes(name), label + ': workspace shows ' + name);
    const pkg = await packageStep(c, { scan });
    assert.deepEqual(pkg.files, [...FULL, ...extra].sort(), label + ': package: ' + JSON.stringify(pkg));
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
  scopeCase('failed-reading 1: a first reading that returns nothing keeps the project visible and packaged', async () => {
    const c = await setup('first_empty');
    await restart(c, { fail: 'empty' });
    await assertFullProject(c, 'readings keep failing');
    assert.equal(status(c.id), 'failed-closed');
  });

  scopeCase('failed-reading 2: a first reading with a count mismatch keeps the project visible and packaged', async () => {
    const c = await setup('first_mismatch');
    await restart(c, { fail: 'count-mismatch' });
    await assertFullProject(c, 'readings keep failing');
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

  scopeCase('failed-reading 4: a mid-session count mismatch changes nothing', async () => {
    const c = await setup('mid_mismatch');
    c.app.fail = 'count-mismatch';
    await poll(c.id);
    await assertFullProject(c, 'while readings fail');
    assert.equal(status(c.id), 'ready');
    c.app.fail = null;
    await poll(c.id);
    await assertFullProject(c, 'after readings complete again');
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
    await assertFullProject(c, 'while readings fail');
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

  scopeCase('failed-reading 9: a Package Review prepared before a mid-session failed reading is still accepted', async () => {
    const c = await setup('review_kept');
    const review = await callIpcRaw('projects:prepare-package-review', c.id);
    assert.equal(typeof review.token, 'string', JSON.stringify(review).slice(0, 200));
    c.app.failOnce = 'count-mismatch';
    await poll(c.id);
    const ws = await workspace(c);
    assert.equal(ws.included, 4);
    const output = path.join(TEST_HOME, 'Documents', 'Package_review_kept');
    fs.mkdirSync(output, { recursive: true });
    const packaged = await callIpcRaw('projects:package', c.id, output, review.token);
    assert.equal(packaged?.success, true, JSON.stringify(packaged).slice(0, 300));
    assert.equal(packaged.totalFiles, 5);
  });

  scopeCase('failed-reading 10: an excluded owned asset is not packaged while the scope is closed; not excluded, it is', async () => {
    const c = await setup('excluded_owned');
    writeSyntheticAiFile(c.f.doc, c.f.swatches.slice(0, 3).join('\n'));
    await emitWatcher('change', c.f.doc);
    await metadataTestHooks.waitForWatcherIdle(c.id);
    await poll(c.id);
    assert.ok(projectFileNames(c).includes('Swatch4.png'), 'still a project file after the save');
    await restart(c, { fail: 'empty' });
    let pkg = await packageStep(c);
    assert.ok(pkg.files?.includes('Swatch4.png'), 'not excluded: packaged while closed: ' + JSON.stringify(pkg));
    await callIpcRaw('projects:remove-file', c.id, c.f.swatches[3]);
    await metadataTestHooks.waitForWatcherIdle(c.id);
    const ws = await workspace(c);
    assert.equal(ws.raw.files.find(row => row.name === 'Swatch4.png')?.included, false, 'shown as excluded');
    pkg = await packageStep(c);
    assert.equal(pkg.files?.includes('Swatch4.png'), false, 'excluded: not packaged: ' + JSON.stringify(pkg));
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

  scopeCase('failed-reading 14: an owned asset whose owner document is closed is shown and packaged while the scope is closed', async () => {
    const c = await setup('owner_closed');
    c.app.docs = [{ path: c.f.flyer, links: [] }];
    await restart(c, { fail: 'count-mismatch' });
    await assertFullProject(c, 'owner closed');
    assert.equal(status(c.id), 'failed-closed');
  });

  scopeCase('failed-reading 15: an asset with no owner record but an accepted source document is shown while the scope is closed', async () => {
    const c = await setup('source_document');
    const row = stored(c.id).files.find(item => item.path === c.f.swatches[0]);
    delete row.dependencyOwners;
    row.sourceDocumentPath = c.f.doc;
    await restart(c, { fail: 'empty' });
    await assertFullProject(c, 'source document only');
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
    c.app.docs = [{ path: c.f.doc, links: [...c.f.swatches] }, { path: c.f.flyer, links: [c.f.flyerArt] }];
    await restart(c, { fail: 'count-mismatch' });
    await poll(c.id);
    c.app.openFiles = [c.f.flyer, c.f.flyerArt];
    await metadataTestHooks.pollLsofForProject(c.id, metadataTestHooks.getActiveWatchingActivationToken(c.id));
    await metadataTestHooks.waitForWatcherIdle(c.id);
    assert.equal(await callIpcRaw('projects:accept-pending', c.id, c.f.flyer), null);
    const notStaged = () => [...projectFileNames(c), ...pendingNames(c)].filter(name => name === 'Flyer.ai' || name === 'FlyerArt.png');
    assert.deepEqual(notStaged(), []);
    const ws = await workspace(c);
    assert.equal(ws.names.includes('FlyerArt.png') || ws.names.includes('Flyer.ai'), false);
    const pkg = await packageStep(c);
    assert.equal((pkg.files || []).includes('FlyerArt.png') || (pkg.files || []).includes('Flyer.ai'), false, JSON.stringify(pkg));
    assert.deepEqual(notStaged(), []);
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
    delete row(c.f.swatches[0]).dependencyOwners;
    row(c.f.swatches[1]).dependencyOwners = [c.f.flyer];
    row(c.f.swatches[3]).assetBaselineSourcePath = c.f.flyer;
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
    assert.ok((pkg.files || []).includes('Added.ai'), JSON.stringify(pkg));
  });
}
