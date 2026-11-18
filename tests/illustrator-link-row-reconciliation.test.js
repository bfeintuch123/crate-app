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
    const state = { running: true, processCheckFails: false, docs: [], raw: null, queries: 0, onQuery: null };
    setChildProcessHandler(request => {
      if (isIllustratorPgrepCheck(request)) return { stdout: state.running && !state.processCheckFails ? '654\n' : '' };
      if (isIllustratorPsCommCheck(request) || isIllustratorPsCommandCheck(request)) {
        return state.processCheckFails ? { error: new Error('synthetic ps failure') } : { stdout: '' };
      }
      if (isOsascriptInvocation(request, 'crate-ai-active-session.applescript')) {
        state.queries++;
        if (state.onQuery) state.onQuery();
        return { stdout: state.raw !== null ? state.raw : illustratorRows(state.docs) };
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
      const keep = png(tempDir, 'Screenshot Keep.png'), drop = png(tempDir, 'Screenshot Drop.png');
      await placeUnsaved(f, keep);
      await placeUnsaved(f, drop);
      // Saved with both links. Saving itself triggers a reading here, so the
      // clean readings are counted before the save is announced.
      writeSyntheticAiFile(f.ai, `linked\n${keep}\n${drop}\n`);
      setDoc(f, { modified: false, links: [keep, drop] });
      await poll(f.id);
      for (const name of ['Screenshot Keep.png', 'Screenshot Drop.png']) {
        assert.equal(storedRow(f.id, name).captureState, 'needs-save', 'first clean reading: still Needs Save');
      }
      await poll(f.id);
      await emitWatcher('change', f.ai);
      await metadataTestHooks.waitForWatcherIdle(f.id);
      await poll(f.id);
      for (const name of ['Screenshot Keep.png', 'Screenshot Drop.png']) assert.equal(isProjectFile(f.id, name), false, 'the scan cannot confirm ' + name);
      for (const name of ['Screenshot Keep.png', 'Screenshot Drop.png']) {
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
      assert.equal(storedRow(f.id, 'Screenshot Keep.png').captureState, 'pending', 'stays decidable after an unsaved edit');
      // Include makes it a project file; Exclude records it as excluded.
      const keepRow = storedRow(f.id, 'Screenshot Keep.png');
      assert.ok(await callIpcRaw('projects:accept-pending', f.id, keepRow.path));
      assert.equal(isProjectFile(f.id, 'Screenshot Keep.png'), true);
      assert.equal(storedRow(f.id, 'Screenshot Keep.png'), undefined);
      const keptFile = stored(f.id).files.find(file => file.name === 'Screenshot Keep.png');
      assert.equal(keptFile.illustratorLinkReview, undefined, 'review state never reaches a project file');
      const keysBefore = (stored(f.id).excludedAssetKeys || []).length;
      await callIpcRaw('projects:reject-pending', f.id, storedRow(f.id, 'Screenshot Drop.png').path);
      assert.equal(storedRow(f.id, 'Screenshot Drop.png'), undefined);
      assert.equal((stored(f.id).excludedAssetKeys || []).length, keysBefore + 1);
      const record = (stored(f.id).excludedPendingFiles || []).find(item => item.name === 'Screenshot Drop.png');
      assert.ok(record, 'Excluded record written');
      assert.equal(record.illustratorLinkReview, undefined, 'review state never reaches an Excluded record');
    } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
  });

  // 6. A decidable PSD row overwritten by a live link is restored exactly.
  adapterTest('link-row-6: a decidable PSD row placed and deleted is restored deep-equal; placed and saved it is Included', async () => {
    const f = await watchedDocument('Link row 6 PSD');
    const psd = path.join(f.dir, 'PinMockup.psd');
    fs.writeFileSync(psd, '8BPS synthetic');
    const watchStartedAt = stored(f.id).watchStartedAt;
    await emitWatcherWithStats('add', psd, { mtimeMs: watchStartedAt - 86_400_000, birthtimeMs: watchStartedAt - 172_800_000 });
    await metadataTestHooks.waitForWatcherIdle(f.id);
    const before = clone(storedRow(f.id, 'PinMockup.psd'));
    const beforeView = clone(await viewRow(f.id, 'PinMockup.psd'));
    assert.equal(before.captureState, 'pending');
    assert.ok(beforeView, 'decidable PSD row visible');
    await placeUnsaved(f, psd);
    setDoc(f, { modified: true, links: [] });
    await poll(f.id);
    assert.deepEqual(storedRow(f.id, 'PinMockup.psd'), before, 'stored row restored exactly');
    assert.deepEqual(await viewRow(f.id, 'PinMockup.psd'), beforeView, 'visible exactly as before');
    // Placed again and saved with a confirmable path: Included.
    await placeUnsaved(f, psd);
    setDoc(f, { modified: false, links: [psd] });
    await save(f, `linked\n${psd}\n`);
    await waitForCondition(() => isProjectFile(f.id, 'PinMockup.psd'), 'saved link promoted', 5000);
    await poll(f.id);
    assert.equal(isProjectFile(f.id, 'PinMockup.psd'), true, 'still a project file after the next reading');
    assert.equal(storedRow(f.id, 'PinMockup.psd'), undefined);
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

  adapterTest('link-row-8: a stale reading (activation ended during the query) changes no row', async () => {
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

  // 9b. An earlier-session row restaged by this session's reading is restored
  // unchanged (still hidden) when the link goes; the scoped view never carries
  // the review state.
  adapterTest('link-row-9b: an earlier-session row restaged in this session is restored unchanged when the link goes', async () => {
    const f = await watchedDocument('Link row 9b restaged');
    const kept = png(f.dir, 'Restaged.png'), gone = png(f.dir, 'HiddenEarlier.png');
    await placeUnsaved(f, kept);
    await placeUnsaved(f, gone);
    await callIpcRaw('projects:pause', f.id);
    setDoc(f, { modified: true, links: [kept] });
    const earlier = clone(storedRow(f.id, 'Restaged.png'));
    await callIpcRaw('projects:start-watching', f.id);
    await metadataTestHooks.waitForWatcherIdle(f.id);
    await poll(f.id);
    const restaged = storedRow(f.id, 'Restaged.png');
    assert.equal(restaged.captureSessionId, stored(f.id).watchSessionId, 'restaged into this session');
    assert.notEqual(earlier.captureSessionId, restaged.captureSessionId);
    assert.deepEqual(restaged.illustratorLinkReview?.prior, earlier, 'the stored row remembers the earlier-session row');
    const view = await viewRow(f.id, 'Restaged.png');
    assert.equal(view?.captureState, 'needs-save', 'visible in this session');
    assert.equal(await viewRow(f.id, 'HiddenEarlier.png'), undefined, 'earlier-session row hidden');
    assert.equal(Object.hasOwn(view, 'illustratorLinkReview'), false, 'review state is not part of the scoped view');
    setDoc(f, { links: [] });
    await poll(f.id);
    assert.deepEqual(storedRow(f.id, 'Restaged.png'), earlier, 'restored exactly as the earlier session left it');
    assert.equal(await viewRow(f.id, 'Restaged.png'), undefined, 'hidden again, as before');
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
    const staysBefore = clone(storedRow(f.id, 'StaysLinked.png'));
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
    assert.deepEqual(storedRow(f.id, 'StaysLinked.png'), staysBefore, 'its link gone, the restaged row returns to the stored earlier row');
    assert.equal(await viewRow(f.id, 'StaysLinked.png'), undefined);
    await poll(f.id);
    await pause(150);
    assert.deepEqual(storedRow(f.id, 'StaysLinked.png'), staysBefore);
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

  // One chronological workflow through a document with existing links. It pins
  // what reconciliation must remove (the new screenshot's row) and what it must
  // not disturb. Whether undecided rows stay visible after pause then Watch is
  // deliberately not asserted here.
  function workflowFixture() {
    resetTestHomeWorkspace();
    fs.mkdirSync(path.join(TEST_HOME, 'Desktop'), { recursive: true });
    const dir = fs.mkdtempSync(path.join(TEST_HOME, 'Desktop', 'link-workflow-'));
    const file = name => path.join(dir, name);
    // Crate excludes by content, so every fixture has its own bytes.
    const write = (filePath, label = path.basename(filePath)) => { fs.writeFileSync(filePath, Buffer.concat([createSyntheticPngBytes(), Buffer.from('workflow:' + label)])); return filePath; };
    const mockup = name => { const filePath = file(name); fs.writeFileSync(filePath, '8BPS synthetic ' + name); return filePath; };
    return {
      dir, write, doc: file('Board.ai'),
      existing: Array.from({ length: 12 }, (_, i) => write(file(`Existing${i + 1}.png`))),
      firstMockup: mockup('FirstMockup.psd'), secondMockup: mockup('SecondMockup.psd'),
      photos: [1, 2, 3].map(i => write(file(`Photo${i}.jpg`))),
      olderShots: [1, 2, 3].map(i => write(file(`OlderScreenshot${i}.png`))),
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
  for (const session of ['no session change', 'pause then Watch']) for (const shot of ['removed before any save', 'unconfirmable path saved then removed']) {
    adapterTest(`link-row workflow (${session}; new screenshot ${shot}): only the removed link's row leaves`, { timeout: 120000 }, async () => {
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
      const secondMockupDecidable = async label => {
        if (session !== 'no session change') return;
        const name = path.basename(f.secondMockup);
        assert.equal(storedRow(id, name)?.captureState, 'pending', label + ': stored row decidable');
        assert.equal((await viewRow(id, name))?.captureState, 'pending', label + ': visible row decidable');
      };
      const checkpoint = async (label, { added, excluded }) => {
        assert.equal(storedRow(id, 'NewScreenshot.png'), undefined, label + ': no stored row for the removed link');
        assert.equal(await viewRow(id, 'NewScreenshot.png'), undefined, label + ': no visible row for the removed link');
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
        for (const mockup of [f.secondMockup, f.firstMockup]) {
          await emitWatcherWithStats('add', mockup, { mtimeMs: watchStart - 86_400_000, birthtimeMs: watchStart - 86_400_000 });
        }
        await metadataTestHooks.waitForWatcherIdle(id);
        await secondMockupDecidable('offered for review');
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
        await secondMockupDecidable('after the photos');

        await place([...f.olderShots, f.firstMockup]);
        await saveDoc();
        await includedAfterSave([...f.olderShots, f.firstMockup]);
        await secondMockupDecidable('after the first mockup');

        let newShot = f.write(path.join(f.dir, 'NewScreenshot.png'));
        if (shot !== 'removed before any save') {
          tempDir = unconfirmableDir();
          newShot = f.write(path.join(tempDir, 'NewScreenshot.png'), 'NewScreenshot-unconfirmable');
        }
        await place([newShot]);
        assert.ok(storedRow(id, 'NewScreenshot.png'), 'the new screenshot is under Needs Review while linked');
        if (shot !== 'removed before any save') await saveDoc();
        await unlink([newShot]);
        await saveDoc();
        await saveDoc();
        const beforeExclusions = [...f.photos, ...f.olderShots, f.firstMockup];
        await checkpoint('after the removed link and two saves', { added: beforeExclusions, excluded: [] });
        await secondMockupDecidable('after the removed link');

        await unlink(f.olderShots);
        await saveDoc();
        for (const shotPath of f.olderShots) await callIpcRaw('projects:remove-file', id, shotPath);
        await secondMockupDecidable('after the exclusions');
        await place([f.secondMockup]);
        await saveDoc();
        await includedAfterSave([f.secondMockup]);
        const afterExclusions = [...f.photos, f.firstMockup, f.secondMockup];
        await checkpoint('after the exclusions and second mockup', { added: afterExclusions, excluded: f.olderShots });

        await unlink(f.photos);
        await saveDoc();
        await checkpoint('at the end', { added: afterExclusions, excluded: f.olderShots });
      } finally {
        if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  }

  // 14. Unchanged: a confirmable saved link is promoted as before.
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
