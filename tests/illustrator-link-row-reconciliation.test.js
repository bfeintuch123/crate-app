'use strict';
// Illustrator link rows under Needs Review are re-checked against every trusted
// Illustrator reading. Source harness: Electron, the store and the
// native collectors (Illustrator AppleScript, pgrep/ps, Photoshop and InDesign
// scripts) are simulated by tests/provenance-dual-write.test.js, loaded through
// the same adapter tests/cross-app-live-pipeline.test.js uses. Synthetic files only.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), assert = require('./bounded-assert');
const sourceRoot = process.env.CRATE_COVERAGE_SOURCE_ROOT || path.resolve(__dirname, '..');
const harnessPath = path.join(sourceRoot, 'tests/provenance-dual-write.test.js');
let harness = fs.readFileSync(harnessPath, 'utf8');
function replaceOnce(before, after) { assert.equal(harness.split(before).length - 1, 1, 'harness drift: ' + before); harness = harness.replace(before, after); }
replaceOnce("const test = require('node:test');", "const adapterTest = require('node:test'); const test = new Proxy(adapterTest, { apply() {} });");
// The saved-file link scan only reads paths under /Users or /Volumes, so the
// synthetic home lives beside the checkout (as in cross-app-live-pipeline).
replaceOnce("fs.mkdtempSync(path.join(os.tmpdir(), 'crate-provenance-dual-write-home-'))", "fs.mkdtempSync(path.join(path.dirname(MAIN_UNDER_TEST_ROOT), 'illustrator-link-reconciliation-home-'))");
// Read-only views of main-process state these tests need.
replaceOnce("  isLsofPollInProgress(projectId) {", "  isLivePollInProgress(projectId) { return psInProgress.has(projectId); },\n  scopedProjectView(project) { return getIllustratorScopedProjectView(project); },\n  illustratorQueryOrder(projectId) { return illustratorActivationScopes.get(projectId)?.queryOrder ?? null; },\n  overlappingWorkInFlight() { return scanInFlight.size + psInProgress.size; },\n  isLsofPollInProgress(projectId) {");
const compiled = new Module(harnessPath, module); compiled.filename = harnessPath; compiled.paths = Module._nodeModulePaths(path.dirname(harnessPath));
compiled._compile(harness + '\n(' + cases.toString() + ')();', harnessPath);

function cases() {
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const stored = id => storeInstance.data.projects.find(project => project.id === id);
  const storedRow = (id, name) => (stored(id).pendingFiles || []).find(row => row.name === name);
  const viewRow = async (id, name) => ((await getProject(id)).pendingFiles || []).find(row => row.name === name);
  const isProjectFile = (id, name) => (stored(id).files || []).some(file => file.name === name);
  const pause = ms => new Promise(resolve => originalSetTimeout(resolve, ms));

  // A path the saved-file scan cannot confirm (outside /Users and /Volumes).
  function unconfirmableDir() {
    const tmp = fs.realpathSync(os.tmpdir());
    const base = /^\/(Users|Volumes)\//.test(tmp + '/') ? '/private/tmp' : tmp;
    return fs.mkdtempSync(path.join(base, 'link-unconfirmable-'));
  }

  function illustratorRows(docs) {
    if (!docs.length) return 'STATUS\tno-documents\nCOMPLETE\t0\t0\n';
    const rows = [];
    let links = 0;
    docs.forEach((doc, index) => {
      const name = path.basename(doc.path), current = index === 0;
      rows.push(`DOC\t${doc.path}\t${name}\t${doc.modified}\t${current}`);
      for (const link of doc.links) { rows.push(`LINK\t${doc.path}\t${name}\t${link}\t${doc.modified}\t${current}`); links++; }
    });
    rows.push(`COMPLETE\t${docs.length}\t${links}`);
    return rows.join('\n') + '\n';
  }

  // Simulated Illustrator (and optionally other apps through `extra`).
  function illustrator(extra = null) {
    const state = { running: true, processCheckFails: false, commandCheckFails: false, docs: [], raw: null, queries: 0, onQuery: null, hold: null };
    setChildProcessHandler(request => {
      if (isIllustratorPgrepCheck(request)) return { stdout: state.running && !state.processCheckFails ? '654\n' : '' };
      if (isIllustratorPsCommCheck(request) || isIllustratorPsCommandCheck(request)) {
        if (state.commandCheckFails && isIllustratorPsCommandCheck(request)) return { error: new Error('synthetic ps timeout') };
        return state.processCheckFails ? { error: new Error('synthetic ps failure') } : { stdout: '' };
      }
      if (isOsascriptInvocation(request, 'crate-ai-active-session.applescript')) {
        state.queries++;
        if (state.onQuery) state.onQuery();
        // The snapshot is taken now; a held query returns it later.
        const result = { stdout: state.raw !== null ? state.raw : illustratorRows(state.docs) }, hold = state.hold;
        state.hold = null;
        return hold ? hold.reach(result) : result;
      }
      return (extra && extra(request)) || { stdout: '' };
    });
    return state;
  }

  async function poll(id) {
    await metadataTestHooks.waitForWatcherIdle(id);
    for (let attempt = 0; attempt < 40; attempt++) {
      const outcome = await metadataTestHooks.pollPsForProject(id, metadataTestHooks.getActiveWatchingActivationToken(id));
      if (!(outcome && outcome.skipped)) break;
      if (attempt === 39) assert.fail('live poll stayed skipped: ' + JSON.stringify(outcome));
      await pause(50);
      await metadataTestHooks.waitForWatcherIdle(id);
    }
    await metadataTestHooks.waitForWatcherIdle(id);
  }

  async function save(f, content) {
    writeSyntheticAiFile(f.ai, content);
    await emitWatcher('change', f.ai);
    await metadataTestHooks.waitForWatcherIdle(f.id);
  }

  // A watched project whose saved .ai document, opened after watching started,
  // is a project file.
  async function watchedDocument(label, { extra = null, docs = ['Board.ai'] } = {}) {
    resetTestHomeWorkspace();
    fs.mkdirSync(path.join(TEST_HOME, 'Desktop'), { recursive: true });
    const dir = fs.mkdtempSync(path.join(TEST_HOME, 'Desktop', 'link-row-'));
    const paths = docs.map(name => { const filePath = path.join(dir, name); writeSyntheticAiFile(filePath, 'no links'); return filePath; });
    const ill = illustrator(extra);
    const project = await createProject(label);
    await waitForCondition(() => ill.queries >= 1, 'activation query');
    ill.docs = paths.map(filePath => ({ path: filePath, modified: false, links: [] }));
    await poll(project.id);
    await waitForProject(project.id, item => paths.every(filePath => item.files.some(file => file.path === filePath)));
    return { project, id: project.id, dir, ai: paths[0], paths, ill };
  }

  const openGates = new Set();
  function gate() {
    let release;
    const opened = new Promise(resolve => { release = resolve; });
    const held = { reached: false, open() { openGates.delete(held); release(); }, reach(result) { held.reached = true; return opened.then(() => result); } };
    openGates.add(held);
    return held;
  }
  // Overlap tests never leave held work behind, even when an assertion fails.
  const overlapTest = (name, body) => adapterTest(name, async () => {
    try { await body(); } finally {
      for (const held of [...openGates]) held.open();
      await waitForCondition(() => metadataTestHooks.overlappingWorkInFlight() === 0, 'overlapping work finished', 5000);
    }
  });
  // Starts a live poll the way Add Files does: outside the watcher coordinator,
  // so it can overlap a pre-package scan.
  async function startAddFilesPoll(f, name) {
    manualDialogFor([png(f.dir, name)]);
    const added = await callIpcRaw('projects:add-files', f.id);
    assert.ok(added, 'Add Files finished');
  }
  // The packaged app's store returns a new copy on every read; the harness store
  // returns live objects. Runs `work` with the packaged behavior.
  async function withCopiedStore(enabled, work) {
    if (!enabled) return work();
    const liveGet = storeInstance.get;
    storeInstance.get = function copiedGet(key, fallback) {
      const value = liveGet.call(this, key, fallback);
      return key === 'projects' ? structuredClone(value) : value;
    };
    try { return await work(); } finally { delete storeInstance.get; }
  }
  const pollFinished = id => waitForCondition(() => !metadataTestHooks.isLivePollInProgress(id), 'live poll finished', 5000);
  async function offerOlderPsd(f, name = 'LayeredOlder.psd') {
    const psd = path.join(f.dir, name);
    fs.writeFileSync(psd, '8BPS synthetic ' + name);
    const watchStartedAt = stored(f.id).watchStartedAt;
    await emitWatcherWithStats('add', psd, { mtimeMs: watchStartedAt - 86_400_000, birthtimeMs: watchStartedAt - 172_800_000 });
    await metadataTestHooks.waitForWatcherIdle(f.id);
    assert.equal(storedRow(f.id, name)?.captureState, 'pending');
    return psd;
  }

  // A row the designer cannot decide, written by another app's live claim.
  async function photoshopClaimRow(f, other, name) {
    const file = png(f.dir, name);
    other.output = file + '\n';
    await poll(f.id);
    other.output = '';
    const row = clone(storedRow(f.id, name));
    assert.equal(row?.source, 'ps-poll');
    assert.equal(row.captureState, 'needs-save');
    return { file, row };
  }
  const withoutSessionStamp = row => {
    if (!row) return row;
    const { captureSessionId, captureSessionObserved, ...rest } = row;
    return rest;
  };
  async function linkInUnsavedDocument(f, link) {
    setDoc(f, { modified: true, links: [...f.ill.docs[0].links, link] });
    await poll(f.id);
  }
  async function changeWatchSession(f, kind, during = null) {
    const before = stored(f.id).watchSessionId;
    if (kind === 'pause then Watch') {
      await callIpcRaw('projects:pause', f.id);
      if (during) during();
      await callIpcRaw('projects:start-watching', f.id);
    } else {
      const account = testAccountSession, realNow = account.now;
      account.now = () => account.accessExpiresAt;
      account.publish('offline', 'Your session needs to be checked. Connect to the internet to continue.');
      if (during) during();
      account.now = realNow;
      account.accessExpiresAt = Date.now() + 3_600_000;
      account.publish('signed_in', '', account.status.identity);
    }
    await waitForCondition(() => stored(f.id).watchSessionId !== before, 'watch session changed', 5000);
    await metadataTestHooks.waitForWatcherIdle(f.id);
    await pause(200);
    await poll(f.id);
  }

  function png(dir, name) { const filePath = path.join(dir, name); fs.writeFileSync(filePath, createSyntheticPngBytes()); return filePath; }

  async function placeUnsaved(f, link, docIndex = 0) {
    const doc = f.ill.docs[docIndex];
    f.ill.docs[docIndex] = { ...doc, modified: true, links: [...doc.links, link] };
    await poll(f.id);
    const row = storedRow(f.id, path.basename(link));
    assert.ok(row, 'linked asset row was not written: ' + JSON.stringify((stored(f.id).pendingFiles || []).map(item => item.name)));
    assert.equal(row.captureState, 'needs-save');
    assert.equal(row.source, 'ai-linked');
    return row;
  }

  function setDoc(f, patch, docIndex = 0) { f.ill.docs[docIndex] = { ...f.ill.docs[docIndex], ...patch }; }

  // 1. Link deleted while the document is unsaved.
  adapterTest('link-row-1: a link deleted while unsaved leaves Needs Review at the next trusted reading and stays gone after save', async () => {
    const f = await watchedDocument('Link row 1 deleted link');
    const link = png(f.dir, 'Deleted.png');
    await placeUnsaved(f, link);
    setDoc(f, { modified: true, links: [] });
    await poll(f.id);
    assert.equal(storedRow(f.id, 'Deleted.png'), undefined, 'row withdrawn at the next trusted reading');
    setDoc(f, { modified: false, links: [] });
    await save(f, 'saved after the link was deleted');
    await poll(f.id);
    await poll(f.id);
    assert.equal(storedRow(f.id, 'Deleted.png'), undefined, 'still gone after save');
    assert.equal(isProjectFile(f.id, 'Deleted.png'), false);
  });

  // 2. Document closed without saving.
  adapterTest('link-row-2: closing the document without saving withdraws its link row', async () => {
    const f = await watchedDocument('Link row 2 closed');
    await placeUnsaved(f, png(f.dir, 'Closed.png'));
    f.ill.docs = [];
    await poll(f.id);
    assert.equal(storedRow(f.id, 'Closed.png'), undefined);
  });

  // 3. Illustrator quits; a failed process check is not a reading.
  adapterTest('link-row-3: Illustrator quitting withdraws the row; a failed process check keeps it', async () => {
    const f = await watchedDocument('Link row 3 quit');
    await placeUnsaved(f, png(f.dir, 'Quit.png'));
    const before = clone(storedRow(f.id, 'Quit.png'));
    f.ill.running = false;
    f.ill.processCheckFails = true;
    await poll(f.id);
    assert.deepEqual(storedRow(f.id, 'Quit.png'), before, 'process check failure: row kept unchanged');
    f.ill.processCheckFails = false;
    await poll(f.id);
    assert.equal(storedRow(f.id, 'Quit.png'), undefined, 'Illustrator definitively not running: row withdrawn');
  });

  // 4 and 5. Link kept and saved, path the save scan cannot confirm.
  adapterTest('link-row-4/5: a saved link the scan cannot confirm becomes decidable on the second clean reading, stays decidable, and Include/Exclude work', async () => {
    const f = await watchedDocument('Link row 4 unconfirmable');
    const tempDir = unconfirmableDir();
    try {
      const keep = png(tempDir, 'Kept Image.png'), drop = png(tempDir, 'Dropped Image.png');
      await placeUnsaved(f, keep);
      await placeUnsaved(f, drop);
      // Saved with both links. Saving itself triggers a reading here, so the
      // clean readings are counted before the save is announced.
      writeSyntheticAiFile(f.ai, `linked\n${keep}\n${drop}\n`);
      setDoc(f, { modified: false, links: [keep, drop] });
      await poll(f.id);
      for (const name of ['Kept Image.png', 'Dropped Image.png']) {
        assert.equal(storedRow(f.id, name).captureState, 'needs-save', 'first clean reading: still Needs Save');
      }
      await poll(f.id);
      await emitWatcher('change', f.ai);
      await metadataTestHooks.waitForWatcherIdle(f.id);
      await poll(f.id);
      for (const name of ['Kept Image.png', 'Dropped Image.png']) assert.equal(isProjectFile(f.id, name), false, 'the scan cannot confirm ' + name);
      for (const name of ['Kept Image.png', 'Dropped Image.png']) {
        const row = storedRow(f.id, name);
        assert.equal(row.captureState, 'pending', 'second clean reading: Include or Exclude');
        assert.equal(row.captureEvidence.needsSave, false);
        assert.notEqual(row.captureEvidence.savedEvidence, true, 'never saved evidence');
        assert.equal(isProjectFile(f.id, name), false, 'never admitted directly');
        assert.equal((await viewRow(f.id, name))?.captureState, 'pending', 'visible as decidable');
      }
      // 5. The document becomes unsaved again: the row stays decidable.
      setDoc(f, { modified: true });
      await poll(f.id);
      await poll(f.id);
      assert.equal(storedRow(f.id, 'Kept Image.png').captureState, 'pending', 'stays decidable after an unsaved edit');
      // Include makes it a project file; Exclude records it as excluded.
      const keepRow = storedRow(f.id, 'Kept Image.png');
      assert.ok(await callIpcRaw('projects:accept-pending', f.id, keepRow.path));
      assert.equal(isProjectFile(f.id, 'Kept Image.png'), true);
      assert.equal(storedRow(f.id, 'Kept Image.png'), undefined);
      const keptFile = stored(f.id).files.find(file => file.name === 'Kept Image.png');
      assert.equal(keptFile.illustratorLinkReview, undefined, 'review state never reaches a project file');
      const keysBefore = (stored(f.id).excludedAssetKeys || []).length;
      await callIpcRaw('projects:reject-pending', f.id, storedRow(f.id, 'Dropped Image.png').path);
      assert.equal(storedRow(f.id, 'Dropped Image.png'), undefined);
      assert.equal((stored(f.id).excludedAssetKeys || []).length, keysBefore + 1);
      const record = (stored(f.id).excludedPendingFiles || []).find(item => item.name === 'Dropped Image.png');
      assert.ok(record, 'Excluded record written');
      assert.equal(record.illustratorLinkReview, undefined, 'review state never reaches an Excluded record');
    } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
  });

  // 6. A decidable PSD row overwritten by a live link is restored exactly.
  adapterTest('link-row-6: a decidable row stays as it is while linked and after the link goes; placed and saved it is Included', async () => {
    const f = await watchedDocument('Link row 6 PSD');
    const psd = await offerOlderPsd(f);
    const before = clone(storedRow(f.id, 'LayeredOlder.psd'));
    const beforeView = clone(await viewRow(f.id, 'LayeredOlder.psd'));
    assert.ok(beforeView, 'decidable row visible');
    await linkInUnsavedDocument(f, psd);
    // The claim only re-observes the row, which updates its session stamp.
    assert.deepEqual(withoutSessionStamp(storedRow(f.id, 'LayeredOlder.psd')), withoutSessionStamp(before), 'an unsaved link does not replace the row');
    assert.deepEqual(withoutSessionStamp(await viewRow(f.id, 'LayeredOlder.psd')), withoutSessionStamp(beforeView), 'still offered as before');
    setDoc(f, { modified: true, links: [] });
    await poll(f.id);
    assert.deepEqual(withoutSessionStamp(storedRow(f.id, 'LayeredOlder.psd')), withoutSessionStamp(before), 'the link going changes nothing');
    assert.deepEqual(withoutSessionStamp(await viewRow(f.id, 'LayeredOlder.psd')), withoutSessionStamp(beforeView));
    // Placed again and saved with a confirmable path: Included.
    await linkInUnsavedDocument(f, psd);
    setDoc(f, { modified: false, links: [psd] });
    await save(f, `linked\n${psd}\n`);
    await waitForCondition(() => isProjectFile(f.id, 'LayeredOlder.psd'), 'saved link promoted', 5000);
    await poll(f.id);
    assert.equal(isProjectFile(f.id, 'LayeredOlder.psd'), true, 'still a project file after the next reading');
    assert.equal(storedRow(f.id, 'LayeredOlder.psd'), undefined);
  });

  // 7. Two documents link the same file.
  adapterTest('link-row-7: a link kept by one of two documents stays; removed from both it is withdrawn', async () => {
    const f = await watchedDocument('Link row 7 shared', { docs: ['First.ai', 'Second.ai'] });
    const link = png(f.dir, 'Shared.png');
    await placeUnsaved(f, link, 0);
    setDoc(f, { modified: true, links: [link] }, 1);
    await poll(f.id);
    setDoc(f, { links: [] }, 0);
    await poll(f.id);
    assert.equal(storedRow(f.id, 'Shared.png')?.captureState, 'needs-save', 'still linked by the second document');
    setDoc(f, { links: [] }, 1);
    await poll(f.id);
    assert.equal(storedRow(f.id, 'Shared.png'), undefined, 'linked by neither document');
  });

  // 8. Untrusted readings change no row.
  for (const kind of ['error row', 'count mismatch', 'pathless document']) {
    adapterTest(`link-row-8: an untrusted reading (${kind}) and the scope it leaves not ready change no row`, async () => {
      const f = await watchedDocument('Link row 8 ' + kind);
      await placeUnsaved(f, png(f.dir, 'Guarded.png'));
      const before = clone(storedRow(f.id, 'Guarded.png'));
      const name = path.basename(f.ai);
      f.ill.raw = {
        'error row': `DOC\t${f.ai}\t${name}\ttrue\ttrue\nERROR\tillustrator-query-failed\nCOMPLETE\t1\t0\n`,
        'count mismatch': `DOC\t${f.ai}\t${name}\ttrue\ttrue\nCOMPLETE\t1\t1\n`,
        'pathless document': `DOC\t${f.ai}\t${name}\ttrue\ttrue\nDOC\t\tUntitled-1\ttrue\tfalse\nCOMPLETE\t2\t0\n`,
      }[kind];
      await poll(f.id);
      assert.deepEqual(storedRow(f.id, 'Guarded.png'), before, kind + ': row unchanged');
      f.ill.raw = null;
      setDoc(f, { modified: true, links: [] });
      await poll(f.id);
      assert.equal(metadataTestHooks.getIllustratorActivationScopeSnapshot(f.id).status, 'failed-closed');
      assert.deepEqual(storedRow(f.id, 'Guarded.png'), before, 'scope not ready: row unchanged');
      f.ill.running = false;
      await poll(f.id);
      assert.equal(storedRow(f.id, 'Guarded.png'), undefined, 'a trusted reading (Illustrator not running) still withdraws');
    });
  }

  // Control: the base never withdraws a row, so this also passes there.
  adapterTest('link-row-8 (control): a stale reading (activation ended during the query) changes no row', async () => {
    const f = await watchedDocument('Link row 8 stale');
    await placeUnsaved(f, png(f.dir, 'Stale.png'));
    const before = clone(storedRow(f.id, 'Stale.png'));
    let paused = null;
    setDoc(f, { modified: true, links: [] });
    f.ill.onQuery = () => { f.ill.onQuery = null; paused = callIpcRaw('projects:pause', f.id); };
    await metadataTestHooks.pollPsForProject(f.id, metadataTestHooks.getActiveWatchingActivationToken(f.id));
    await paused;
    await metadataTestHooks.waitForWatcherIdle(f.id);
    assert.equal(stored(f.id).status, 'paused');
    assert.deepEqual(storedRow(f.id, 'Stale.png'), before, 'stale reading: row unchanged');
  });

  // 9. Other apps' rows, earlier-session rows and project files are untouched.
  adapterTest('link-row-9: Photoshop and InDesign link rows, earlier-session rows and project files are untouched', async () => {
    const other = { photoshop: false, indesign: false, psLink: null, inddDoc: null, inddLink: null };
    const extra = request => {
      if (request.kind === 'exec' && request.command.includes("grep -i 'Adobe Photoshop'")) {
        return { stdout: other.photoshop ? '777 /Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app/Contents/MacOS/Adobe Photoshop 2026\n' : '' };
      }
      if (other.photoshop && isOsascriptInvocation(request, 'crate-ps-poll.applescript')) return { stdout: `${other.psLink}\n` };
      if (request.kind === 'exec' && request.command.includes("grep -i 'Adobe InDesign'")) {
        return { stdout: other.indesign ? '456 /Applications/Adobe InDesign.app/Contents/MacOS/Adobe InDesign\n' : '' };
      }
      if (other.indesign && isOsascriptInvocation(request, 'crate-indd-poll.applescript')) {
        const name = path.basename(other.inddDoc);
        return { stdout: `DOC\t${other.inddDoc}\t${name}\ttrue\ttrue\nLINK\t${other.inddDoc}\t${name}\t${other.inddLink}\ttrue\ttrue\n` };
      }
      return null;
    };
    const f = await watchedDocument('Link row 9 untouched', { extra });
    // An Illustrator link row from an earlier watch session.
    await placeUnsaved(f, png(f.dir, 'Earlier.png'));
    await callIpcRaw('projects:pause', f.id);
    setDoc(f, { modified: false, links: [] });
    await callIpcRaw('projects:start-watching', f.id);
    await metadataTestHooks.waitForWatcherIdle(f.id);
    await poll(f.id);
    const earlier = clone(storedRow(f.id, 'Earlier.png'));
    assert.ok(earlier, 'earlier-session row is still stored');
    // Photoshop and InDesign link rows of this session.
    other.psLink = png(f.dir, 'PhotoshopLink.png');
    other.inddDoc = path.join(f.dir, 'Layout.indd'); fs.writeFileSync(other.inddDoc, 'synthetic indd');
    // The InDesign document is a project file too, so its links are relevant.
    const sessionStart = stored(f.id).watchStartedAt;
    await emitWatcherWithStats('add', other.inddDoc, { mtimeMs: sessionStart + 1, birthtimeMs: sessionStart + 1 });
    await waitForCondition(() => isProjectFile(f.id, 'Layout.indd'), 'InDesign document admitted', 5000);
    await metadataTestHooks.waitForWatcherIdle(f.id);
    other.inddLink = png(f.dir, 'InDesignLink.png');
    other.photoshop = true; other.indesign = true;
    await poll(f.id);
    const psRow = clone(storedRow(f.id, 'PhotoshopLink.png'));
    const inddRow = clone(storedRow(f.id, 'InDesignLink.png'));
    assert.ok(psRow && inddRow, 'Photoshop and InDesign link rows written: ' + JSON.stringify(stored(f.id).pendingFiles.map(row => row.name)));
    // A current Illustrator link row, then a trusted reading without any link.
    await placeUnsaved(f, png(f.dir, 'Current.png'));
    const files = clone(stored(f.id).files);
    setDoc(f, { modified: true, links: [] });
    await poll(f.id);
    assert.equal(storedRow(f.id, 'Current.png'), undefined, 'current-session Illustrator link row withdrawn');
    assert.deepEqual(storedRow(f.id, 'Earlier.png'), earlier, 'earlier-session row untouched');
    assert.deepEqual(storedRow(f.id, 'PhotoshopLink.png'), psRow, 'Photoshop row untouched');
    assert.deepEqual(storedRow(f.id, 'InDesignLink.png'), inddRow, 'InDesign row untouched');
    assert.deepEqual(stored(f.id).files, files, 'project files untouched');
    f.ill.running = false;
    await poll(f.id);
    assert.deepEqual(storedRow(f.id, 'Earlier.png'), earlier, 'earlier-session row untouched when Illustrator quits');
    assert.deepEqual(storedRow(f.id, 'PhotoshopLink.png'), psRow);
    assert.deepEqual(storedRow(f.id, 'InDesignLink.png'), inddRow);
  });

  // 9b. A link row restaged from an earlier session is not itself remembered:
  // once the link goes, nothing refuted is put back.
  adapterTest('link-row-9b: an earlier-session link row restaged in this session is gone when its link goes', async () => {
    const f = await watchedDocument('Link row 9b restaged');
    const kept = png(f.dir, 'Restaged.png'), gone = png(f.dir, 'HiddenEarlier.png');
    await placeUnsaved(f, kept);
    await placeUnsaved(f, gone);
    await callIpcRaw('projects:pause', f.id);
    setDoc(f, { modified: true, links: [kept] });
    const earlierSession = storedRow(f.id, 'Restaged.png').captureSessionId;
    await callIpcRaw('projects:start-watching', f.id);
    await metadataTestHooks.waitForWatcherIdle(f.id);
    await poll(f.id);
    const restaged = storedRow(f.id, 'Restaged.png');
    assert.equal(restaged.captureSessionId, stored(f.id).watchSessionId, 'restaged into this session');
    assert.notEqual(earlierSession, restaged.captureSessionId);
    assert.equal(restaged.illustratorLinkReview, undefined, 'an earlier link row is never remembered');
    const view = await viewRow(f.id, 'Restaged.png');
    assert.equal(view?.captureState, 'needs-save', 'visible in this session');
    assert.equal(await viewRow(f.id, 'HiddenEarlier.png'), undefined, 'earlier-session row hidden');
    assert.equal(Object.hasOwn(view, 'illustratorLinkReview'), false, 'review state is not part of the scoped view');
    setDoc(f, { links: [] });
    await poll(f.id);
    assert.equal(storedRow(f.id, 'Restaged.png'), undefined, 'not stored');
    assert.equal(await viewRow(f.id, 'Restaged.png'), undefined, 'not visible');
  });

  adapterTest('link-row-9c: a remembered row the designer could not decide survives a session change and returns exactly', async () => {
    const other = photoshopChecks();
    const f = await watchedDocument('Link row 9c remembered row', { extra: other.extra });
    const { file, row: original } = await photoshopClaimRow(f, other, 'ClaimedElsewhere.png');
    const first = await placeUnsaved(f, file);
    assert.deepEqual(first.illustratorLinkReview.prior, original);
    setDoc(f, { modified: false, links: [file] });
    await poll(f.id);
    assert.equal(storedRow(f.id, 'ClaimedElsewhere.png').illustratorLinkReview.cleanSeen, true);
    setDoc(f, { modified: true, links: [file] });
    await callIpcRaw('projects:pause', f.id);
    await callIpcRaw('projects:start-watching', f.id);
    await metadataTestHooks.waitForWatcherIdle(f.id);
    await poll(f.id);
    const restaged = storedRow(f.id, 'ClaimedElsewhere.png');
    assert.equal(restaged.captureSessionId, stored(f.id).watchSessionId);
    assert.deepEqual(restaged.illustratorLinkReview, { version: 1, prior: original }, 'only the remembered row is inherited');
    assert.equal(Object.hasOwn(restaged.illustratorLinkReview.prior, 'illustratorLinkReview'), false);
    setDoc(f, { links: [] });
    await poll(f.id);
    assert.deepEqual(storedRow(f.id, 'ClaimedElsewhere.png'), original, 'the remembered row returns exactly');
  });

  // 10. A link reported only by an excluded working file.
  adapterTest('link-row-10: a link reported only by an excluded working file keeps Needs Save on clean readings and is withdrawn when unlinked', async () => {
    const f = await watchedDocument('Link row 10 excluded working file');
    const link = png(f.dir, 'OwnedByExcluded.png');
    await placeUnsaved(f, link);
    const workspace = await callIpcRaw('projects:get-asset-workspace', f.id);
    const source = workspace.files.find(file => file.name === path.basename(f.ai));
    const selected = await callIpcRaw('projects:set-working-source-selection', f.id, source.visualIdentity,
      { action: 'exclude', expectedRevision: source.selectionRevision });
    assert.equal(selected.success, true, JSON.stringify(selected));
    setDoc(f, { modified: false, links: [link] });
    await poll(f.id);
    await poll(f.id);
    await poll(f.id);
    assert.equal(storedRow(f.id, 'OwnedByExcluded.png')?.captureState, 'needs-save', 'excluded working file: Needs Save kept');
    setDoc(f, { links: [] });
    await poll(f.id);
    assert.equal(storedRow(f.id, 'OwnedByExcluded.png'), undefined, 'withdrawn when unlinked');
  });

  // 11. Withdrawal is not a designer decision.
  adapterTest('link-row-11: withdrawal writes no exclusion key, no Excluded record and no decision provenance', async () => {
    const f = await watchedDocument('Link row 11 not a decision');
    await placeUnsaved(f, png(f.dir, 'Withdrawn.png'));
    const keys = clone(stored(f.id).excludedAssetKeys || []);
    const records = clone(stored(f.id).excludedPendingFiles || []);
    setDoc(f, { modified: true, links: [] });
    await poll(f.id);
    assert.equal(storedRow(f.id, 'Withdrawn.png'), undefined);
    assert.deepEqual(stored(f.id).excludedAssetKeys || [], keys);
    assert.deepEqual(stored(f.id).excludedPendingFiles || [], records);
    const provenance = JSON.stringify(stored(f.id).provenance || {});
    for (const marker of ['projects:reject-pending', 'projects:accept-pending', 'pending_file_rejected']) {
      assert.equal(provenance.includes(marker), false, 'no decision provenance: ' + marker);
    }
  });

  // 12. The Needs Save notification follows the rows.
  adapterTest('link-row-12: the Needs Save notice is withdrawn with its rows; none is raised for a row that stayed decidable', async () => {
    backgroundNeedsSave();
    const f = await watchedDocument('Link row 12 notice');
    await placeUnsaved(f, png(f.dir, 'Noticed.png'));
    await waitForNeedsSave(() => needsSaveNotices().length === 1, 'first notice');
    const first = needsSaveNotices()[0];
    setDoc(f, { modified: true, links: [] });
    await poll(f.id);
    assert.equal(storedRow(f.id, 'Noticed.png'), undefined);
    await waitForNeedsSave(() => first.closed === true, 'notice withdrawn with its row');
    await poll(f.id);
    await pause(150);
    assert.equal(needsSaveNotices().length, 1, 'withdrawal raises no second notice');
    const tempDir = unconfirmableDir();
    try {
      const link = png(tempDir, 'Decidable.png');
      await placeUnsaved(f, link);
      await waitForNeedsSave(() => needsSaveNotices().length === 2, 'second episode notice');
      setDoc(f, { modified: false, links: [link] });
      await poll(f.id);
      await poll(f.id);
      assert.equal(storedRow(f.id, 'Decidable.png').captureState, 'pending');
      await waitForNeedsSave(() => needsSaveNotices()[1].closed === true, 'notice withdrawn when the row became decidable');
      await pause(150);
      assert.equal(needsSaveNotices().length, 2, 'becoming decidable raises no further notice');
      setDoc(f, { modified: true });
      await poll(f.id);
      await poll(f.id);
      await pause(150);
      assert.equal(storedRow(f.id, 'Decidable.png').captureState, 'pending');
      assert.equal(needsSaveNotices().length, 2, 'no notice for a row that stayed decidable');
    } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
  });

  // 12b. A same-account refresh starts a new watch session: stored rows stay
  // stored, its first reading reconciles nothing, and nothing is re-announced.
  adapterTest('link-row-12b: rows stored across a refresh stay stored exactly and are not announced again', async () => {
    backgroundNeedsSave();
    const f = await watchedDocument('Link row 12b refresh');
    const restaged = png(f.dir, 'StaysLinked.png'), gone = png(f.dir, 'GoneBeforeRefresh.png');
    await placeUnsaved(f, restaged);
    await placeUnsaved(f, gone);
    await waitForNeedsSave(() => needsSaveNotices().length === 1, 'first notice');
    const goneBefore = clone(storedRow(f.id, 'GoneBeforeRefresh.png'));
    const sessionBefore = stored(f.id).watchSessionId;
    setDoc(f, { links: [restaged] });
    const queries = f.ill.queries;
    testAccountSession.invalidate();
    testAccountSession.publish('signed_in', '', { id: 'test-account' });
    await waitForCondition(() => stored(f.id).watchSessionId !== sessionBefore && f.ill.queries > queries, 'refreshed activation read Illustrator', 5000);
    await metadataTestHooks.waitForWatcherIdle(f.id);
    await pause(100);
    assert.deepEqual(storedRow(f.id, 'GoneBeforeRefresh.png'), goneBefore, 'the activation reading reconciles nothing');
    await poll(f.id);
    await poll(f.id);
    assert.deepEqual(storedRow(f.id, 'GoneBeforeRefresh.png'), goneBefore, 'an earlier-session row stays stored exactly');
    assert.equal(await viewRow(f.id, 'GoneBeforeRefresh.png'), undefined, 'and hidden');
    assert.equal(storedRow(f.id, 'StaysLinked.png').captureSessionId, stored(f.id).watchSessionId, 'a link still present restages');
    await pause(150);
    assert.equal(needsSaveNotices().length, 1, 'stored rows are not announced again');
    setDoc(f, { links: [] });
    await poll(f.id);
    assert.equal(storedRow(f.id, 'StaysLinked.png'), undefined, 'its link gone, the restaged row leaves');
    assert.equal(await viewRow(f.id, 'StaysLinked.png'), undefined);
    await poll(f.id);
    await pause(150);
    assert.deepEqual(storedRow(f.id, 'GoneBeforeRefresh.png'), goneBefore, 'the other stored row is still untouched');
    assert.equal(needsSaveNotices().length, 1, 'no second notice');
  });

  // 13. The pre-package Illustrator refresh reconciles too.
  for (const gone of ['link deleted', 'Illustrator quit']) adapterTest(`link-row-13: the pre-package Illustrator refresh withdraws a link that is gone (${gone})`, async () => {
    const f = await watchedDocument('Link row 13 pre-package ' + gone);
    await placeUnsaved(f, png(f.dir, 'PrePackage.png'));
    if (gone === 'link deleted') setDoc(f, { modified: true, links: [] });
    else f.ill.running = false;
    await metadataTestHooks.waitForWatcherIdle(f.id);
    const queries = f.ill.queries;
    await callIpcRaw('projects:pre-package-scan', f.id);
    if (gone === 'link deleted') assert.ok(f.ill.queries > queries, 'the pre-package scan read Illustrator');
    assert.equal(storedRow(f.id, 'PrePackage.png'), undefined);
  });

  // Overlapping readings: order is fixed when each query starts.
  // Control: the base never withdraws a row, so this also passes there.
  overlapTest('link-row-race-a (control): an older empty snapshot finishing last does not withdraw a row a newer reading kept', async () => {
    const f = await watchedDocument('Link row race a');
    const link = png(f.dir, 'Relinked.png');
    await placeUnsaved(f, link);
    setDoc(f, { links: [] });
    const older = f.ill.hold = gate();
    await startAddFilesPoll(f, 'AddedA.png');
    await waitForCondition(() => older.reached, 'older poll took its snapshot');
    setDoc(f, { links: [link] });
    await callIpcRaw('projects:pre-package-scan', f.id);
    const kept = clone(storedRow(f.id, 'Relinked.png'));
    assert.equal(kept?.captureState, 'needs-save', 'the newer reading keeps the row');
    older.open();
    await pollFinished(f.id);
    assert.deepEqual(storedRow(f.id, 'Relinked.png'), kept, 'the older snapshot changes nothing');
  });

  overlapTest('link-row-race-b: an older snapshot finishing last does not stage a row a newer reading withdrew', async () => {
    const other = photoshopChecks();
    const f = await watchedDocument('Link row race b', { extra: other.extra });
    const { file, row: original } = await photoshopClaimRow(f, other, 'ClaimedElsewhere.png');
    await placeUnsaved(f, file);
    const older = f.ill.hold = gate();
    await startAddFilesPoll(f, 'AddedB.png');
    await waitForCondition(() => older.reached, 'older poll took its snapshot');
    setDoc(f, { links: [] });
    await callIpcRaw('projects:pre-package-scan', f.id);
    assert.deepEqual(storedRow(f.id, 'ClaimedElsewhere.png'), original, 'the newer reading restored the row');
    older.open();
    await pollFinished(f.id);
    assert.deepEqual(storedRow(f.id, 'ClaimedElsewhere.png'), original, 'the older snapshot does not overwrite it again');
  });

  overlapTest('link-row-race-c: an older pre-package reading is discarded and the rest of the scan continues', async () => {
    const f = await watchedDocument('Link row race c');
    const link = png(f.dir, 'KeptByPoll.png');
    await placeUnsaved(f, link);
    setDoc(f, { links: [] });
    const older = f.ill.hold = gate();
    const scan = callIpcRaw('projects:pre-package-scan', f.id);
    await waitForCondition(() => older.reached, 'pre-package scan took its snapshot');
    setDoc(f, { links: [link] });
    await startAddFilesPoll(f, 'AddedC.png');
    await pollFinished(f.id);
    const kept = clone(storedRow(f.id, 'KeptByPoll.png'));
    assert.equal(kept?.captureState, 'needs-save');
    older.open();
    const result = await scan;
    assert.ok(result && !result.error, 'the scan finished: ' + JSON.stringify(result)?.slice(0, 200));
    assert.deepEqual(storedRow(f.id, 'KeptByPoll.png'), kept);
  });

  overlapTest('link-row-race-control: readings that finish in start order apply in order', async () => {
    const f = await watchedDocument('Link row race control');
    const link = png(f.dir, 'InOrder.png');
    await placeUnsaved(f, link);
    setDoc(f, { links: [] });
    const first = f.ill.hold = gate();
    await startAddFilesPoll(f, 'AddedControl.png');
    await waitForCondition(() => first.reached, 'first reading took its snapshot');
    setDoc(f, { links: [link] });
    const second = f.ill.hold = gate();
    const scan = callIpcRaw('projects:pre-package-scan', f.id);
    await waitForCondition(() => second.reached, 'second reading took its snapshot');
    first.open();
    await pollFinished(f.id);
    assert.equal(storedRow(f.id, 'InOrder.png'), undefined, 'the first reading withdrew the row');
    second.open();
    await scan;
    assert.equal(storedRow(f.id, 'InOrder.png')?.captureState, 'needs-save', 'the second reading brought it back');
    assert.ok(metadataTestHooks.illustratorQueryOrder(f.id), 'order is tracked while watching');
    await callIpcRaw('projects:pause', f.id);
    assert.equal(metadataTestHooks.illustratorQueryOrder(f.id), null, 'Pause retires the reading order');
    assert.ok(metadataTestHooks.getIllustratorActivationScopeSnapshot(f.id), 'the paused view keeps its scope');
  });

  // A poll that read Illustrator and then waits on Photoshop while a newer
  // reading is applied.
  function photoshopChecks() {
    const other = { running: true, hold: null, output: '' };
    other.extra = request => {
      if (request.kind === 'exec' && request.command.includes("grep -i 'Adobe Photoshop'")) return { stdout: other.running ? '777 /Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app/Contents/MacOS/Adobe Photoshop 2026\n' : '' };
      if (isOsascriptInvocation(request, 'crate-ps-poll.applescript')) {
        const result = { stdout: other.output }, hold = other.hold;
        other.hold = null;
        return hold ? hold.reach(result) : result;
      }
      return null;
    };
    return other;
  }
  for (const remembered of [false, true]) {
    overlapTest(`link-row-race-d: a poll held at the Photoshop check cannot restore a withdrawn link (${remembered ? 'remembered row underneath' : 'no earlier row'})`, async () => {
      backgroundNeedsSave();
      const other = photoshopChecks();
      const f = await watchedDocument('Link row race d', { extra: other.extra });
      const earlier = remembered ? await photoshopClaimRow(f, other, 'ClaimedElsewhere.png') : null;
      const link = earlier ? earlier.file : png(f.dir, 'Withdrawn.png');
      const name = path.basename(link);
      await placeUnsaved(f, link);
      await waitForNeedsSave(() => needsSaveNotices().length === 1, 'first notice');
      const held = other.hold = gate();
      await startAddFilesPoll(f, 'AddedD.png');
      await waitForCondition(() => held.reached, 'poll waits at the Photoshop check');
      setDoc(f, { links: [] });
      await callIpcRaw('projects:pre-package-scan', f.id);
      assert.deepEqual(storedRow(f.id, name), earlier ? earlier.row : undefined, 'withdrawn by the newer reading');
      if (!earlier) await waitForNeedsSave(() => needsSaveNotices()[0].closed === true, 'notice withdrawn');
      const rows = clone(stored(f.id).pendingFiles), events = testRendererEvents.length;
      held.open();
      await pollFinished(f.id);
      await pause(150);
      assert.deepEqual(stored(f.id).pendingFiles, rows, 'the old reading changes no row');
      assert.equal(testRendererEvents.slice(events).some(event => event.channel === 'files:pending'), false, 'no file-state update from the old reading');
      assert.equal(needsSaveNotices().length, 1, 'no notice from the old reading');
    });
  }

  overlapTest('link-row-race-e: Photoshop records in the held poll still stage when its Illustrator reading is dropped', async () => {
    const other = photoshopChecks();
    const f = await watchedDocument('Link row race e', { extra: other.extra });
    const link = png(f.dir, 'IllustratorLink.png');
    await placeUnsaved(f, link);
    other.output = png(f.dir, 'PhotoshopLink.png') + '\n';
    const held = other.hold = gate();
    await startAddFilesPoll(f, 'AddedE.png');
    await waitForCondition(() => held.reached, 'poll waits at the Photoshop check');
    other.output = '';
    setDoc(f, { links: [] });
    await callIpcRaw('projects:pre-package-scan', f.id);
    assert.equal(storedRow(f.id, 'IllustratorLink.png'), undefined);
    held.open();
    await pollFinished(f.id);
    assert.equal(storedRow(f.id, 'IllustratorLink.png'), undefined, 'the Illustrator record is dropped');
    assert.equal(storedRow(f.id, 'PhotoshopLink.png')?.source, 'ps-poll', 'the Photoshop record stages');
  });

  overlapTest('link-row-race-f: a poll whose activation scope was replaced while it waited stages no Illustrator record', async () => {
    const other = photoshopChecks();
    const f = await watchedDocument('Link row race f', { extra: other.extra });
    const link = png(f.dir, 'SeenBeforeScopeChange.png');
    setDoc(f, { modified: true, links: [link] });
    const held = other.hold = gate();
    await startAddFilesPoll(f, 'AddedF1.png');
    await waitForCondition(() => held.reached, 'poll waits at the Photoshop check');
    const before = clone(metadataTestHooks.getIllustratorActivationScopeSnapshot(f.id).admittedDocumentPaths);
    await startAddFilesPoll(f, 'AddedF2.png');
    assert.notDeepEqual(metadataTestHooks.getIllustratorActivationScopeSnapshot(f.id).admittedDocumentPaths, before, 'the scope was replaced');
    held.open();
    await pollFinished(f.id);
    assert.equal(storedRow(f.id, 'SeenBeforeScopeChange.png'), undefined, 'the old snapshot stages nothing');
    await poll(f.id);
    assert.equal(storedRow(f.id, 'SeenBeforeScopeChange.png')?.captureState, 'needs-save', 'the next reading does');
  });

  // Control: the base always applies the activation reading, so this also passes there.
  overlapTest('link-row-race-activation (control): the activation reading sets the baseline even when a later reading finishes first', async () => {
    resetTestHomeWorkspace();
    fs.mkdirSync(path.join(TEST_HOME, 'Desktop'), { recursive: true });
    const dir = fs.mkdtempSync(path.join(TEST_HOME, 'Desktop', 'link-row-'));
    const doc = path.join(dir, 'OpenAtWatch.ai');
    writeSyntheticAiFile(doc, 'open before watching');
    const ill = illustrator();
    ill.docs = [{ path: doc, modified: false, links: [] }];
    const activation = ill.hold = gate();
    const creating = createProject('Link row race activation');
    await waitForCondition(() => activation.reached, 'activation took its snapshot');
    const id = storeInstance.data.projects.find(project => project.status === 'watching').id;
    await callIpcRaw('projects:pre-package-scan', id);
    activation.open();
    await creating;
    await metadataTestHooks.waitForWatcherIdle(id);
    assert.equal(metadataTestHooks.getIllustratorActivationScopeSnapshot(id).baselineDocumentPaths.length, 1, 'the open document is baseline');
    await poll(id);
    assert.equal(isProjectFile(id, 'OpenAtWatch.ai'), false, 'a document open at Watch is not admitted');
  });

  overlapTest('link-row-race-e2: a Photoshop claim for the same path still stages when the Illustrator reading is dropped', async () => {
    const other = photoshopChecks();
    const f = await watchedDocument('Link row race e2', { extra: other.extra });
    const link = png(f.dir, 'ClaimedByBoth.png');
    await placeUnsaved(f, link);
    other.output = link + '\n';
    const held = other.hold = gate();
    await startAddFilesPoll(f, 'AddedE2.png');
    await waitForCondition(() => held.reached, 'poll waits at the Photoshop check');
    other.output = '';
    setDoc(f, { links: [] });
    await callIpcRaw('projects:pre-package-scan', f.id);
    assert.equal(storedRow(f.id, 'ClaimedByBoth.png'), undefined, 'withdrawn by the newer reading');
    held.open();
    await pollFinished(f.id);
    const row = storedRow(f.id, 'ClaimedByBoth.png');
    assert.equal(row?.source, 'ps-poll', 'the Photoshop claim stages as if the Illustrator record were absent');
    assert.equal(row.captureState, 'needs-save');
  });

  // The saved-file pass must see the project as it is now.
  const includedShape = file => { const { path: filePath, name, addedAt, dependencyOwners, ...rest } = file; return { ...rest, owners: dependencyOwners }; };
  for (const copied of [false, true]) {
    const storeLabel = copied ? 'copying store' : 'live store';
    overlapTest(`link-row-membership-a: a discarded scan reading does not keep a row a newer reading withdrew pending (${storeLabel})`, async () => {
      const f = await watchedDocument('Link row membership a');
      const link = png(f.dir, 'WithdrawnMeanwhile.png'), neverSeen = png(f.dir, 'BesideItA.png');
      await placeUnsaved(f, link);
      writeSyntheticAiFile(f.ai, `linked\n${link}\n${neverSeen}\n`);
      await withCopiedStore(copied, async () => {
        const older = f.ill.hold = gate();
        const scan = callIpcRaw('projects:pre-package-scan', f.id);
        await waitForCondition(() => older.reached, 'scan took its snapshot');
        setDoc(f, { links: [] });
        await startAddFilesPoll(f, 'AddedMembershipA.png');
        await pollFinished(f.id);
        assert.equal(storedRow(f.id, 'WithdrawnMeanwhile.png'), undefined, 'the newer reading withdrew the row');
        older.open();
        assert.ok(await scan, 'the scan finished');
      });
      const file = name => stored(f.id).files.find(item => item.name === name);
      assert.ok(file('BesideItA.png'), 'control: the never-seen path is included');
      assert.ok(file('WithdrawnMeanwhile.png'), 'the withdrawn path follows the same rule');
      assert.deepEqual(includedShape(file('WithdrawnMeanwhile.png')), includedShape(file('BesideItA.png')));
      assert.equal(storedRow(f.id, 'WithdrawnMeanwhile.png'), undefined);
    });

    overlapTest(`link-row-membership-b: a discarded scan reading treats a row a newer reading created as pending (${storeLabel})`, async () => {
      const f = await watchedDocument('Link row membership b');
      const link = png(f.dir, 'CreatedMeanwhile.png'), neverSeen = png(f.dir, 'BesideItB.png');
      writeSyntheticAiFile(f.ai, `linked\n${link}\n${neverSeen}\n`);
      await withCopiedStore(copied, async () => {
        const older = f.ill.hold = gate();
        const scan = callIpcRaw('projects:pre-package-scan', f.id);
        await waitForCondition(() => older.reached, 'scan took its snapshot');
        setDoc(f, { modified: true, links: [link] });
        await startAddFilesPoll(f, 'AddedMembershipB.png');
        await pollFinished(f.id);
        assert.equal(storedRow(f.id, 'CreatedMeanwhile.png')?.captureState, 'needs-save', 'the newer reading created the row');
        older.open();
        assert.ok(await scan, 'the scan finished');
      });
      assert.equal(isProjectFile(f.id, 'BesideItB.png'), true, 'control: the never-seen path is included');
      assert.equal(isProjectFile(f.id, 'CreatedMeanwhile.png'), false, 'a path pending now is not included');
      assert.equal(storedRow(f.id, 'CreatedMeanwhile.png')?.captureState, 'needs-save');
    });

    overlapTest(`link-row-membership-c: an in-order scan sees another reading's withdrawal and keeps what it staged (${storeLabel})`, async () => {
      const f = await watchedDocument('Link row membership c');
      const link = png(f.dir, 'WithdrawnEarlier.png'), neverSeen = png(f.dir, 'BesideItC.png');
      fs.writeFileSync(path.join(f.dir, 'FoundDuringScan.fig'), 'synthetic design file');
      await placeUnsaved(f, link);
      writeSyntheticAiFile(f.ai, `linked\n${link}\n${neverSeen}\n`);
      setDoc(f, { links: [] });
      await withCopiedStore(copied, async () => {
        const first = f.ill.hold = gate();
        await startAddFilesPoll(f, 'AddedMembershipC.png');
        await waitForCondition(() => first.reached, 'first reading took its snapshot');
        const second = f.ill.hold = gate();
        const scan = callIpcRaw('projects:pre-package-scan', f.id);
        await waitForCondition(() => second.reached, 'scan took its snapshot');
        first.open();
        await pollFinished(f.id);
        assert.equal(storedRow(f.id, 'WithdrawnEarlier.png'), undefined, 'withdrawn by the other reading');
        second.open();
        assert.ok(await scan, 'the scan finished');
      });
      const file = name => stored(f.id).files.find(item => item.name === name);
      assert.ok(file('WithdrawnEarlier.png'), 'no longer pending, so the saved-file pass includes it');
      assert.deepEqual(includedShape(file('WithdrawnEarlier.png')), includedShape(file('BesideItC.png')));
      assert.ok(storedRow(f.id, 'FoundDuringScan.fig') || file('FoundDuringScan.fig'), 'what the scan found earlier is kept');
    });
  }

  overlapTest('link-row-race-g: a discarded poll does not move a working file; an in-order reading does', async () => {
    const f = await watchedDocument('Link row race g');
    await poll(f.id);
    assert.ok(Object.keys(stored(f.id).workingSourceLocators?.records || {}).length, 'the working file has a locator');
    const renamed = path.join(f.dir, 'BoardRenamed.ai');
    const scopeBefore = clone(metadataTestHooks.getIllustratorActivationScopeSnapshot(f.id).admittedDocumentPaths);
    fs.renameSync(f.ai, renamed);
    f.ill.docs = [{ path: renamed, modified: false, links: [] }];
    const older = f.ill.hold = gate();
    await startAddFilesPoll(f, 'AddedG.png');
    await waitForCondition(() => older.reached, 'older poll took its snapshot');
    f.ill.docs = [];
    const queries = f.ill.queries;
    await callIpcRaw('projects:pre-package-scan', f.id);
    assert.ok(f.ill.queries > queries, 'a newer reading was applied');
    older.open();
    await pollFinished(f.id);
    assert.equal(isProjectFile(f.id, 'BoardRenamed.ai'), false, 'the older reading moved nothing');
    assert.equal(isProjectFile(f.id, 'Board.ai'), true);
    const admitted = metadataTestHooks.getIllustratorActivationScopeSnapshot(f.id).admittedDocumentPaths;
    for (const documentPath of scopeBefore) assert.ok(admitted.includes(documentPath), 'admitted paths are not rewritten');
    f.ill.docs = [{ path: renamed, modified: false, links: [] }];
    await poll(f.id);
    assert.equal(isProjectFile(f.id, 'BoardRenamed.ai'), true, 'an in-order reading follows the rename');
  });

  overlapTest('link-row-race-h: a failed activation reading does not close a scope a newer reading left ready', async () => {
    resetTestHomeWorkspace();
    fs.mkdirSync(path.join(TEST_HOME, 'Desktop'), { recursive: true });
    const dir = fs.mkdtempSync(path.join(TEST_HOME, 'Desktop', 'link-row-'));
    const doc = path.join(dir, 'BoardAfterFailure.ai');
    writeSyntheticAiFile(doc, 'no links');
    const ill = illustrator();
    ill.raw = 'ERROR\tillustrator-query-failed\nCOMPLETE\t0\t0\n';
    const activation = ill.hold = gate();
    const creating = createProject('Link row race h');
    await waitForCondition(() => activation.reached, 'activation took its failing snapshot');
    ill.raw = null;
    const id = storeInstance.data.projects.find(project => project.status === 'watching').id;
    await callIpcRaw('projects:pre-package-scan', id);
    assert.equal(metadataTestHooks.getIllustratorActivationScopeSnapshot(id).status, 'ready', 'the newer reading left the scope ready');
    activation.open();
    await creating;
    await metadataTestHooks.waitForWatcherIdle(id);
    assert.equal(metadataTestHooks.getIllustratorActivationScopeSnapshot(id).status, 'ready', 'the older failure does not close it');
    const f = { id, dir, ai: doc, ill };
    ill.docs = [{ path: doc, modified: false, links: [] }];
    await poll(id);
    await waitForProject(id, item => item.files.some(file => file.path === doc));
    await placeUnsaved(f, png(dir, 'AfterFailure.png'));
    setDoc(f, { links: [] });
    await poll(id);
    assert.equal(storedRow(id, 'AfterFailure.png'), undefined, 'later readings stage and reconcile');
  });

  adapterTest('link-row-remembered: another app\'s same-rank claim does not displace a link row holding a remembered row', async () => {
    const other = photoshopChecks(), layout = { running: false, doc: null, link: null };
    const extra = request => {
      if (request.kind === 'exec' && request.command.includes("grep -i 'Adobe InDesign'")) return { stdout: layout.running ? '456 /Applications/Adobe InDesign.app/Contents/MacOS/Adobe InDesign\n' : '' };
      if (layout.running && isOsascriptInvocation(request, 'crate-indd-poll.applescript')) {
        const name = path.basename(layout.doc);
        return { stdout: `DOC\t${layout.doc}\t${name}\ttrue\ttrue\nLINK\t${layout.doc}\t${name}\t${layout.link}\ttrue\ttrue\n` };
      }
      return other.extra(request);
    };
    const f = await watchedDocument('Link row remembered', { extra });
    layout.doc = path.join(f.dir, 'Layout.indd');
    fs.writeFileSync(layout.doc, 'synthetic layout');
    const sessionStart = stored(f.id).watchStartedAt;
    await emitWatcherWithStats('add', layout.doc, { mtimeMs: sessionStart + 1, birthtimeMs: sessionStart + 1 });
    await waitForCondition(() => isProjectFile(f.id, 'Layout.indd'), 'layout admitted', 5000);
    await metadataTestHooks.waitForWatcherIdle(f.id);
    layout.link = png(f.dir, 'ClaimedThreeWays.png');
    layout.running = true;
    await poll(f.id);
    layout.running = false;
    const original = clone(storedRow(f.id, 'ClaimedThreeWays.png'));
    assert.equal(original?.captureState, 'needs-save');
    assert.notEqual(original.source, 'ai-linked');
    const linkRow = clone(await placeUnsaved(f, layout.link));
    assert.deepEqual(linkRow.illustratorLinkReview.prior, original);
    // Illustrator's reading fails here, so Photoshop's report is the only claim.
    other.output = layout.link + '\n';
    f.ill.raw = 'ERROR\tillustrator-query-failed\nCOMPLETE\t0\t0\n';
    await poll(f.id);
    f.ill.raw = null;
    other.output = '';
    assert.deepEqual(storedRow(f.id, 'ClaimedThreeWays.png'), linkRow, 'the link row and its remembered row survive');
    f.ill.running = false;
    await poll(f.id);
    assert.deepEqual(storedRow(f.id, 'ClaimedThreeWays.png'), original, 'the remembered row returns');
    other.output = layout.link + '\n';
    await poll(f.id);
    assert.equal(storedRow(f.id, 'ClaimedThreeWays.png')?.source, 'ps-poll', 'the other app can stage on its next report');
  });

  // An inconclusive process check is not "Illustrator is not running".
  for (const route of ['poll', 'pre-package scan']) {
    adapterTest(`link-row-3b: an unfinished process listing keeps a linked row (${route})`, async () => {
      const f = await watchedDocument('Link row 3b ' + route);
      await placeUnsaved(f, png(f.dir, 'StillLinked.png'));
      const before = clone(storedRow(f.id, 'StillLinked.png'));
      f.ill.running = false;
      f.ill.commandCheckFails = true;
      if (route === 'poll') await poll(f.id); else await callIpcRaw('projects:pre-package-scan', f.id);
      assert.deepEqual(storedRow(f.id, 'StillLinked.png'), before, 'no row change');
      f.ill.commandCheckFails = false;
      if (route === 'poll') await poll(f.id); else await callIpcRaw('projects:pre-package-scan', f.id);
      assert.equal(storedRow(f.id, 'StillLinked.png'), undefined, 'a completed listing withdraws it');
    });
  }

  // A withdrawn row no longer holds its path back from the saved-file pass.
  adapterTest('link-row-13b: at pre-package a withdrawn path in saved bytes follows the rule for a never-seen path', async () => {
    const f = await watchedDocument('Link row 13b');
    const withdrawn = png(f.dir, 'WithdrawnSaved.png'), neverSeen = png(f.dir, 'NeverSeenSaved.png'), notSaved = png(f.dir, 'WithdrawnNotSaved.png');
    await placeUnsaved(f, withdrawn);
    await placeUnsaved(f, notSaved);
    setDoc(f, { links: [] });
    writeSyntheticAiFile(f.ai, `linked\n${withdrawn}\n${neverSeen}\n`);
    await callIpcRaw('projects:pre-package-scan', f.id);
    assert.equal(storedRow(f.id, 'WithdrawnSaved.png'), undefined);
    const row = name => stored(f.id).files.find(file => file.name === name);
    assert.ok(row('NeverSeenSaved.png'), 'control: a never-seen path in saved bytes is included');
    const shape = file => { const { path: filePath, name, addedAt, dependencyOwners, ...rest } = file; return { ...rest, owners: dependencyOwners }; };
    assert.deepEqual(shape(row('WithdrawnSaved.png')), shape(row('NeverSeenSaved.png')), 'same project file as the never-seen control');
    assert.equal(row('WithdrawnNotSaved.png'), undefined, 'withdrawn and not in saved bytes: not included');
    assert.equal(storedRow(f.id, 'WithdrawnNotSaved.png'), undefined);
  });

  adapterTest('link-row-13c: at pre-package a restored row keeps its path out of the saved-file pass', async () => {
    const other = photoshopChecks();
    const f = await watchedDocument('Link row 13c', { extra: other.extra });
    const { file, row: original } = await photoshopClaimRow(f, other, 'ClaimedElsewhere.png');
    await placeUnsaved(f, file);
    setDoc(f, { links: [] });
    writeSyntheticAiFile(f.ai, `linked\n${file}\n`);
    await callIpcRaw('projects:pre-package-scan', f.id);
    assert.equal(isProjectFile(f.id, 'ClaimedElsewhere.png'), false);
    // The saved-file pass records the referencing document on a row it skips.
    const { dependencyOwners, ...restored } = storedRow(f.id, 'ClaimedElsewhere.png');
    assert.deepEqual(restored, original);
    assert.deepEqual(dependencyOwners, [f.ai]);
  });

  // Review state stays in the main process, also when nothing is hidden.
  adapterTest('link-row-view: review state reaches no renderer route when nothing is hidden', async () => {
    const other = photoshopChecks();
    const f = await watchedDocument('Link row view', { extra: other.extra });
    const { file: claimed } = await photoshopClaimRow(f, other, 'ClaimedElsewhere.png');
    const plain = png(f.dir, 'PlainLink.png'), rejected = png(f.dir, 'RejectedLater.png');
    testRendererEvents.length = 0;
    const row = await placeUnsaved(f, claimed);
    assert.ok(row.illustratorLinkReview?.prior, 'the stored row carries review state');
    await placeUnsaved(f, plain);
    const scope = metadataTestHooks.getIllustratorActivationScopeSnapshot(f.id);
    assert.deepEqual([scope.baselineDocumentPaths, scope.excludedLinkedPaths], [[], []], 'nothing is hidden');
    const leaks = (label, value) => assert.equal(JSON.stringify(value ?? null).includes('illustratorLinkReview'), false, label);
    leaks('projects:get-all', await callIpcRaw('projects:get-all'));
    leaks('projects:get-asset-workspace', await callIpcRaw('projects:get-asset-workspace', f.id));
    leaks('projects:get-files', await callIpcRaw('projects:get-files', f.id));
    leaks('projects:set-existing-assets-decision', await callIpcRaw('projects:set-existing-assets-decision', f.id, 'include'));
    fs.writeFileSync(rejected, 'x');
    await offerOlderPsd(f, 'Decidable.psd');
    leaks('projects:accept-pending', await callIpcRaw('projects:accept-pending', f.id, path.join(f.dir, 'Decidable.psd')));
    await offerOlderPsd(f, 'Rejected.psd');
    leaks('projects:reject-pending', await callIpcRaw('projects:reject-pending', f.id, path.join(f.dir, 'Rejected.psd')));
    manualDialogFor([png(f.dir, 'ViewAdded.png')]);
    leaks('projects:add-files', await callIpcRaw('projects:add-files', f.id));
    leaks('renderer events', testRendererEvents.map(event => event.data));
    assert.ok(testRendererEvents.some(event => event.channel === 'files:pending'), 'file state was sent');
    leaks('projects:pause', await callIpcRaw('projects:pause', f.id));
    leaks('projects:start-watching', await callIpcRaw('projects:start-watching', f.id));
    const noReview = { id: 'no-review', files: [], pendingFiles: [{ path: claimed, name: 'ClaimedElsewhere.png' }] };
    assert.equal(metadataTestHooks.scopedProjectView(noReview), noReview, 'a project with no review state is returned as is');
  });

  // A live claim never takes a decision away.
  for (const change of ['pause then Watch', 'account-access lapse']) {
    adapterTest(`link-row-decision-1: a decidable row linked across a session change (${change}) is still offered when the link goes`, async () => {
      const f = await watchedDocument('Link row decision 1');
      const psd = await offerOlderPsd(f);
      const original = clone(storedRow(f.id, 'LayeredOlder.psd'));
      const stillOriginal = label => {
        assert.deepEqual(withoutSessionStamp(storedRow(f.id, 'LayeredOlder.psd')), withoutSessionStamp(original), label);
      };
      await linkInUnsavedDocument(f, psd);
      stillOriginal('never a Needs Save row while linked');
      await changeWatchSession(f, change);
      stillOriginal('after the session change');
      assert.equal(storedRow(f.id, 'LayeredOlder.psd').captureSessionId, stored(f.id).watchSessionId, 'the link still present re-observes it in this session');
      setDoc(f, { links: [] });
      await poll(f.id);
      stillOriginal('after the link goes');
      assert.equal((await viewRow(f.id, 'LayeredOlder.psd'))?.captureState, 'pending', 'shown for a decision');
    });

    adapterTest(`link-row-decision-2: a link removed during a session change (${change}) leaves only the original row stored`, async () => {
      const f = await watchedDocument('Link row decision 2');
      const psd = await offerOlderPsd(f);
      const original = clone(storedRow(f.id, 'LayeredOlder.psd'));
      await linkInUnsavedDocument(f, psd);
      await changeWatchSession(f, change, () => setDoc(f, { links: [] }));
      const row = storedRow(f.id, 'LayeredOlder.psd');
      assert.deepEqual(withoutSessionStamp(row), withoutSessionStamp(original), 'the original decidable row');
      assert.equal(Object.hasOwn(row, 'illustratorLinkReview'), false, 'nothing is kept inside it');
      assert.equal((stored(f.id).pendingFiles || []).some(item => item.captureState === 'needs-save'), false, 'no Needs Save row');
    });
  }

  adapterTest('link-row-decision-3: a Photoshop smart-object claim leaves a decidable row decidable, also after Photoshop quits', async () => {
    const other = photoshopChecks();
    const f = await watchedDocument('Link row decision 3', { extra: other.extra });
    const psd = await offerOlderPsd(f);
    const original = clone(storedRow(f.id, 'LayeredOlder.psd'));
    other.output = psd + '\n';
    await poll(f.id);
    assert.deepEqual(withoutSessionStamp(storedRow(f.id, 'LayeredOlder.psd')), withoutSessionStamp(original), 'not replaced by the claim');
    other.running = false;
    await poll(f.id);
    assert.deepEqual(withoutSessionStamp(storedRow(f.id, 'LayeredOlder.psd')), withoutSessionStamp(original), 'unchanged after Photoshop quits');
    assert.equal((await viewRow(f.id, 'LayeredOlder.psd'))?.captureState, 'pending');
  });

  for (const observer of ['Illustrator', 'Photoshop']) {
    const claim = async (f, other, file) => {
      if (observer === 'Illustrator') await linkInUnsavedDocument(f, file);
      else { other.output = file + '\n'; await poll(f.id); }
      assert.equal(storedRow(f.id, path.basename(file))?.captureState, 'pending', 'still decidable under the claim');
    };
    adapterTest(`link-row-decision-4: Include on a decidable row under a ${observer} claim makes it a project file`, async () => {
      const other = photoshopChecks();
      const f = await watchedDocument('Link row decision include', { extra: other.extra });
      const psd = await offerOlderPsd(f);
      await claim(f, other, psd);
      assert.ok(await callIpcRaw('projects:accept-pending', f.id, psd));
      assert.equal(isProjectFile(f.id, 'LayeredOlder.psd'), true);
      assert.equal(storedRow(f.id, 'LayeredOlder.psd'), undefined);
    });
    adapterTest(`link-row-decision-4: Exclude on a decidable row under a ${observer} claim survives a save with the link still there`, async () => {
      const other = photoshopChecks();
      const f = await watchedDocument('Link row decision exclude', { extra: other.extra });
      const psd = await offerOlderPsd(f);
      await claim(f, other, psd);
      await callIpcRaw('projects:reject-pending', f.id, psd);
      assert.ok((stored(f.id).excludedPendingFiles || []).some(item => item.name === 'LayeredOlder.psd'));
      setDoc(f, { modified: false, links: [psd] });
      await save(f, `linked\n${psd}\n`);
      await pause(700);
      await metadataTestHooks.waitForWatcherIdle(f.id);
      await poll(f.id);
      assert.equal(isProjectFile(f.id, 'LayeredOlder.psd'), false, 'not included');
      assert.equal(storedRow(f.id, 'LayeredOlder.psd'), undefined, 'no row comes back');
      assert.ok((stored(f.id).excludedPendingFiles || []).some(item => item.name === 'LayeredOlder.psd'), 'still excluded');
    });
    adapterTest(`link-row-decision-5: a package scan with only an unsaved ${observer} claim adds nothing and leaves the row decidable`, async () => {
      const other = photoshopChecks();
      const f = await watchedDocument('Link row decision scan', { extra: other.extra });
      const psd = await offerOlderPsd(f);
      const original = clone(storedRow(f.id, 'LayeredOlder.psd'));
      await claim(f, other, psd);
      const files = stored(f.id).files.map(file => file.name).sort();
      await callIpcRaw('projects:pre-package-scan', f.id);
      assert.deepEqual(stored(f.id).files.map(file => file.name).sort(), files, 'no project file added');
      assert.deepEqual(withoutSessionStamp(storedRow(f.id, 'LayeredOlder.psd')), withoutSessionStamp(original), 'still the decidable row');
    });
    // Control: a file with no row behaves as it does on the base.
    adapterTest(`link-row-decision-6 (control): a file with no row claimed through ${observer} shows Needs Save and raises the notice`, async () => {
      backgroundNeedsSave();
      const other = photoshopChecks();
      const f = await watchedDocument('Link row decision control', { extra: other.extra });
      const file = png(f.dir, 'NoEarlierRow.png');
      if (observer === 'Illustrator') await linkInUnsavedDocument(f, file);
      else { other.output = file + '\n'; await poll(f.id); }
      assert.equal(storedRow(f.id, 'NoEarlierRow.png')?.captureState, 'needs-save');
      await waitForNeedsSave(() => needsSaveNotices().length === 1, 'notice');
    });
    adapterTest(`link-row-decision-8: no notice is raised for a decidable row under a ${observer} claim`, async () => {
      backgroundNeedsSave();
      const other = photoshopChecks();
      const f = await watchedDocument('Link row decision notice', { extra: other.extra });
      const psd = await offerOlderPsd(f);
      await claim(f, other, psd);
      await poll(f.id);
      await pause(150);
      assert.equal(needsSaveNotices().length, 0);
    });
  }

  // Control: saved-file inclusion is the same on the base.
  adapterTest('link-row-decision-7 (control): a decidable row linked and saved with a confirmable path is Included', async () => {
    const f = await watchedDocument('Link row decision saved');
    const psd = await offerOlderPsd(f);
    await linkInUnsavedDocument(f, psd);
    setDoc(f, { modified: false, links: [psd] });
    await save(f, `linked\n${psd}\n`);
    await waitForCondition(() => isProjectFile(f.id, 'LayeredOlder.psd'), 'saved link Included', 5000);
    assert.equal(storedRow(f.id, 'LayeredOlder.psd'), undefined);
  });

  adapterTest('link-row-decision-9: a link row made decidable by clean readings stays so without a mark and is still withdrawn', async () => {
    const f = await watchedDocument('Link row decision 9');
    const tempDir = unconfirmableDir();
    try {
      const link = png(tempDir, 'CleanLink.png');
      await placeUnsaved(f, link);
      setDoc(f, { modified: false, links: [link] });
      await poll(f.id);
      await poll(f.id);
      const row = storedRow(f.id, 'CleanLink.png');
      assert.equal(row.captureState, 'pending');
      assert.equal(row.source, 'ai-linked');
      assert.equal(Object.hasOwn(row, 'illustratorLinkReview'), false, 'no mark is stored');
      setDoc(f, { modified: true });
      await poll(f.id);
      assert.equal(storedRow(f.id, 'CleanLink.png').captureState, 'pending', 'stays decidable on unsaved edits');
      setDoc(f, { links: [] });
      await poll(f.id);
      assert.equal(storedRow(f.id, 'CleanLink.png'), undefined, 'withdrawn when unlinked');
    } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
  });

  // One chronological workflow through a document with existing links. It pins
  // what reconciliation must remove (the latest capture's row) and what it must
  // not disturb. Whether undecided rows stay visible after pause then Watch is
  // deliberately not asserted here.
  function workflowFixture() {
    resetTestHomeWorkspace();
    fs.mkdirSync(path.join(TEST_HOME, 'Desktop'), { recursive: true });
    const dir = fs.mkdtempSync(path.join(TEST_HOME, 'Desktop', 'link-workflow-'));
    const file = name => path.join(dir, name);
    // Crate excludes by content, so every fixture has its own bytes.
    const write = (filePath, label = path.basename(filePath)) => { fs.writeFileSync(filePath, Buffer.concat([createSyntheticPngBytes(), Buffer.from('workflow:' + label)])); return filePath; };
    const layered = name => { const filePath = file(name); fs.writeFileSync(filePath, '8BPS synthetic ' + name); return filePath; };
    return {
      dir, write, doc: file('Board.ai'),
      existing: Array.from({ length: 12 }, (_, i) => write(file(`Existing${i + 1}.png`))),
      firstLayered: layered('LayeredOne.psd'), secondLayered: layered('LayeredTwo.psd'),
      photos: [1, 2, 3].map(i => write(file(`Photo${i}.jpg`))),
      earlierCaptures: [1, 2, 3].map(i => write(file(`EarlierCapture${i}.png`))),
    };
  }
  async function workflowState(id) {
    const workspace = await callIpcRaw('projects:get-asset-workspace', id);
    const files = workspace.files || [];
    const isAsset = file => file.projectRole !== 'source' && file.protectedSource !== true;
    const isExcluded = file => file.excluded === true || file.included === false;
    const assets = files.filter(isAsset);
    const included = assets.filter(file => !isExcluded(file));
    return {
      workingFiles: files.filter(file => !isAsset(file)).map(file => file.name),
      existing: included.filter(file => file.assetOrigin === 'existing').map(file => file.name).sort(),
      added: included.filter(file => file.assetOrigin !== 'existing').map(file => file.name).sort(),
      excluded: assets.filter(isExcluded).map(file => file.name).sort(),
      excludedRecords: (workspace.excludedPendingFiles || []).map(file => file.name).sort(),
    };
  }
  for (const session of ['no session change', 'pause then Watch']) for (const captureCase of ['removed before any save', 'unconfirmable path saved then removed']) {
    adapterTest(`link-row workflow (${session}; latest capture ${captureCase}): only the removed link's row leaves`, { timeout: 120000 }, async () => {
      const f = workflowFixture(), ill = illustrator();
      const names = paths => paths.map(item => path.basename(item));
      let tempDir = null;
      const doc = () => ill.docs[0];
      const place = async paths => { ill.docs = [{ ...doc(), modified: true, links: [...doc().links, ...paths] }]; await poll(id); };
      const unlink = async paths => { ill.docs = [{ ...doc(), modified: true, links: doc().links.filter(link => !paths.includes(link)) }]; await poll(id); };
      const saveDoc = async () => {
        ill.docs = [{ ...doc(), modified: false }];
        writeSyntheticAiFile(f.doc, `${doc().links.join('\n')}\nsaved ${++saves}`);
        await emitWatcher('change', f.doc);
        await metadataTestHooks.waitForWatcherIdle(id);
        await pause(150);
        await poll(id);
        await poll(id);
      };
      const includedAfterSave = async paths => {
        const expected = names(paths);
        await waitForCondition(() => expected.every(name => isProjectFile(id, name)), 'saved links Included: ' + expected.join(', '), 10000);
        await metadataTestHooks.waitForWatcherIdle(id);
        const state = await workflowState(id);
        for (const name of expected) assert.ok(state.added.includes(name), name + ' Included: ' + JSON.stringify(state.added));
      };
      const secondLayeredDecidable = async label => {
        if (session !== 'no session change') return;
        const name = path.basename(f.secondLayered);
        assert.equal(storedRow(id, name)?.captureState, 'pending', label + ': stored row decidable');
        assert.equal((await viewRow(id, name))?.captureState, 'pending', label + ': visible row decidable');
      };
      const checkpoint = async (label, { added, excluded }) => {
        assert.equal(storedRow(id, 'LatestCapture.png'), undefined, label + ': no stored row for the removed link');
        assert.equal(await viewRow(id, 'LatestCapture.png'), undefined, label + ': no visible row for the removed link');
        const state = await workflowState(id);
        assert.deepEqual(state.workingFiles, ['Board.ai'], label + ': one working file');
        assert.deepEqual(state.existing, names(f.existing).sort(), label + ': existing assets still included');
        assert.deepEqual(state.added, names(added).sort(), label + ': added assets');
        assert.deepEqual([...state.excluded, ...state.excludedRecords].sort(), names(excluded).sort(), label + ': excluded assets');
      };
      let saves = 0;
      const project = await createProject('Link row workflow');
      const id = project.id;
      try {
        await waitForCondition(() => ill.queries >= 1, 'activation query');
        writeSyntheticAiFile(f.doc, f.existing.join('\n'));
        await emitWatcher('add', f.doc);
        await metadataTestHooks.waitForWatcherIdle(id);
        ill.docs = [{ path: f.doc, modified: false, links: [...f.existing] }];
        await poll(id);
        await poll(id);
        const decision = await callIpcRaw('projects:set-existing-assets-decision', id, 'include');
        assert.equal(decision.success, true, JSON.stringify(decision));
        await poll(id);
        const watchStart = stored(id).watchStartedAt;
        for (const layered of [f.secondLayered, f.firstLayered]) {
          await emitWatcherWithStats('add', layered, { mtimeMs: watchStart - 86_400_000, birthtimeMs: watchStart - 86_400_000 });
        }
        await metadataTestHooks.waitForWatcherIdle(id);
        await secondLayeredDecidable('offered for review');
        if (session === 'pause then Watch') {
          await callIpcRaw('projects:pause', id);
          await callIpcRaw('projects:start-watching', id);
          await metadataTestHooks.waitForWatcherIdle(id);
          await pause(200);
          await poll(id);
          await poll(id);
        }

        await place(f.photos);
        await saveDoc();
        await includedAfterSave(f.photos);
        await secondLayeredDecidable('after the photos');

        await place([...f.earlierCaptures, f.firstLayered]);
        await saveDoc();
        await includedAfterSave([...f.earlierCaptures, f.firstLayered]);
        await secondLayeredDecidable('after the first layered file');

        let latestCapture = f.write(path.join(f.dir, 'LatestCapture.png'));
        if (captureCase !== 'removed before any save') {
          tempDir = unconfirmableDir();
          latestCapture = f.write(path.join(tempDir, 'LatestCapture.png'), 'LatestCapture-unconfirmable');
        }
        await place([latestCapture]);
        assert.ok(storedRow(id, 'LatestCapture.png'), 'the latest capture is under Needs Review while linked');
        if (captureCase !== 'removed before any save') await saveDoc();
        await unlink([latestCapture]);
        await saveDoc();
        await saveDoc();
        const beforeExclusions = [...f.photos, ...f.earlierCaptures, f.firstLayered];
        await checkpoint('after the removed link and two saves', { added: beforeExclusions, excluded: [] });
        await secondLayeredDecidable('after the removed link');

        await unlink(f.earlierCaptures);
        await saveDoc();
        for (const capturePath of f.earlierCaptures) await callIpcRaw('projects:remove-file', id, capturePath);
        await secondLayeredDecidable('after the exclusions');
        await place([f.secondLayered]);
        await saveDoc();
        await includedAfterSave([f.secondLayered]);
        const afterExclusions = [...f.photos, f.firstLayered, f.secondLayered];
        await checkpoint('after the exclusions and second layered file', { added: afterExclusions, excluded: f.earlierCaptures });

        await unlink(f.photos);
        await saveDoc();
        await checkpoint('at the end', { added: afterExclusions, excluded: f.earlierCaptures });
      } finally {
        if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  }

  // 14. Control: a confirmable saved link is promoted as on the base.
  for (const cleanReadings of [0, 1, 2]) {
    adapterTest(`link-row-14 (unchanged): a confirmable saved link is promoted after ${cleanReadings} clean reading(s) first`, async () => {
      const f = await watchedDocument('Link row 14 promoted ' + cleanReadings);
      const link = png(f.dir, 'Confirmed.png');
      await placeUnsaved(f, link);
      setDoc(f, { modified: false, links: [link] });
      for (let i = 0; i < cleanReadings; i++) await poll(f.id);
      assert.equal(isProjectFile(f.id, 'Confirmed.png'), false);
      await save(f, `linked\n${link}\n`);
      await waitForCondition(() => isProjectFile(f.id, 'Confirmed.png'), 'promoted by saved-file evidence', 5000);
      await poll(f.id);
      assert.equal(isProjectFile(f.id, 'Confirmed.png'), true, 'still a project file after the next reading');
      assert.equal(storedRow(f.id, 'Confirmed.png'), undefined);
      assert.equal(stored(f.id).files.find(file => file.name === 'Confirmed.png').illustratorLinkReview, undefined);
    });
  }
}
