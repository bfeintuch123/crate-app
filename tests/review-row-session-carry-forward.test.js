'use strict';
// A review row the designer was still being asked about stays under Needs Review
// when the project gets a new watch session (Pause then Watch, project switch,
// relaunch, sign-in restore). Runs main.js in the provenance harness: creative
// apps and the folder watcher are simulated, all files are synthetic.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), assert = require('./bounded-assert');
const harnessPath = path.join(__dirname, 'provenance-dual-write.test.js');
let harness = fs.readFileSync(harnessPath, 'utf8');
function replaceOnce(before, after) { assert.equal(harness.split(before).length - 1, 1, 'harness drift: ' + before); harness = harness.replace(before, after); }
replaceOnce("const test = require('node:test');", "const adapterTest = require('node:test'); const test = new Proxy(adapterTest, { apply() {} });");
// The saved-file link scan reads only /Users and /Volumes paths.
replaceOnce("fs.mkdtempSync(path.join(os.tmpdir(), 'crate-provenance-dual-write-home-'))", "fs.mkdtempSync(path.join(path.dirname(MAIN_UNDER_TEST_ROOT), 'review-row-carry-home-'))");
const compiled = new Module(harnessPath, module); compiled.filename = harnessPath; compiled.paths = Module._nodeModulePaths(path.dirname(harnessPath));
compiled._compile(harness + '\n(' + cases.toString() + ')();', harnessPath);

function cases() {
  const OWNERS_KEY = 'watchSessionOwners';
  const ACCOUNT_KEY = 'watchSessionAccount';
  const ownerOf = id => (storeInstance.data[OWNERS_KEY] || {})[id];
  const DAY_MS = 86400000;
  const stored = id => storeInstance.data.projects.find(project => project.id === id);
  const clone = value => JSON.parse(JSON.stringify(value));
  const realWait = ms => new Promise(resolve => originalSetTimeout(resolve, ms));
  const storedRow = (id, filePath) => (stored(id).pendingFiles || []).find(file => file.path === filePath);
  const projection = async id => (await callIpcRaw('projects:get-all')).find(project => project.id === id);
  const visibleRow = async (id, filePath) => ((await projection(id)).pendingFiles || []).find(file => file.path === filePath);
  const idle = id => metadataTestHooks.waitForWatcherIdle(id);

  function setup(tag) {
    resetTestHomeWorkspace();
    clearTrackedTimers();
    setChildProcessHandler(() => ({ stdout: '' }));
    const dir = path.join(TEST_HOME, 'Desktop', tag);
    fs.mkdirSync(dir, { recursive: true });
    return { dir, file: name => makeFile(path.join(dir, name)) };
  }
  function makeFile(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '8BPS synthetic ' + path.basename(filePath));
    return filePath;
  }
  // The folder watcher reports an older file: the ordinary way a decidable row appears.
  async function addReviewRow(id, filePath) {
    const startedAt = stored(id).watchStartedAt;
    await emitWatcherWithStats('add', filePath, { mtimeMs: startedAt - DAY_MS, birthtimeMs: startedAt - DAY_MS });
    await idle(id);
    const row = storedRow(id, filePath);
    assert.ok(row, 'expected a stored review row');
    assert.equal(row.captureState, 'pending');
    assert.equal(row.captureSessionId, stored(id).watchSessionId);
    assert.ok(await visibleRow(id, filePath), 'a new review row is visible in its own session');
    return clone(row);
  }
  // A stored row of the current session, for states the watcher does not produce.
  async function pushRow(id, filePath, fields = {}) {
    const project = stored(id);
    project.pendingFiles.push(clone({ ...makePendingFile(filePath, 'chokidar-add'), captureState: 'pending', captureReason: 'chokidar-add',
      captureEvidence: { source: 'chokidar-add', appFamily: 'generic', state: 'pending' },
      captureSessionId: project.watchSessionId, captureSessionObserved: false, ...fields }));
    await projection(id); // the ordinary store read fills in derived fields such as projectRole
    return clone(storedRow(id, filePath) || { path: filePath }); // the ordinary cleanup may already have dropped it
  }
  async function pauseThenWatch(id) {
    await callIpcRaw('projects:pause', id);
    await callIpcRaw('projects:start-watching', id);
    await idle(id);
  }
  // Only the session stamp differs from the row as it was.
  async function assertCarried(id, before) {
    const project = stored(id);
    assert.deepEqual(storedRow(id, before.path), { ...before, captureSessionId: project.watchSessionId }, 'only the session stamp changes');
    const shown = await visibleRow(id, before.path);
    assert.ok(shown, 'the row is still under Needs Review');
    assert.equal(shown.captureState, 'pending', 'the row is still decidable');
    assert.equal(project.files.some(file => file.path === before.path), false, 'a carried row is not a project file');
  }
  async function assertLeftHidden(id, before) {
    assert.deepEqual(storedRow(id, before.path), before, 'a row not carried stays exactly as it was');
    assert.equal(await visibleRow(id, before.path), undefined, 'a row not carried stays hidden');
  }
  function useAccount(accountId) {
    testAccountSession.record = { identity: { id: accountId } };
    testAccountSession.accessToken = 'synthetic-access';
    testAccountSession.accessExpiresAt = Date.now() + 3600000;
    testAccountSession.publish('signed_in', '', { id: accountId });
  }
  const lifecycleTest = (name, body) => adapterTest(name, async () => {
    try { await body(); }
    finally { setChildProcessHandler(null); await testAccountSession.restore(); clearTrackedTimers(); }
  });

  // --- Lifecycle ---------------------------------------------------------------

  lifecycleTest('decidable row stays under Needs Review after Pause then Watch', async () => {
    const { file } = setup('carry-pause');
    const project = await createProject('Carry pause');
    const row = await addReviewRow(project.id, file('Pause.psd'));
    await callIpcRaw('projects:pause', project.id);
    assert.ok(await visibleRow(project.id, row.path), 'still visible while paused');
    const endedSession = stored(project.id).watchSessionId;
    await callIpcRaw('projects:start-watching', project.id);
    await idle(project.id);
    assert.notEqual(stored(project.id).watchSessionId, endedSession, 'Watch starts a new session');
    await assertCarried(project.id, row);
  });

  lifecycleTest('decidable row stays after switching to another project and back', async () => {
    const { file } = setup('carry-switch');
    const project = await createProject('Carry switch');
    const row = await addReviewRow(project.id, file('Switch.psd'));
    const other = await createProject('Carry switch other');
    assert.equal(stored(project.id).status, 'paused');
    await idle(other.id);
    await callIpcRaw('projects:start-watching', project.id);
    await idle(project.id);
    await assertCarried(project.id, row);
  });

  lifecycleTest('decidable row stays after a relaunch-shaped activation', async () => {
    const { file } = setup('carry-restart');
    const project = await createProject('Carry restart');
    const row = await addReviewRow(project.id, file('Restart.psd'));
    roundTripFakeStore();
    await callIpcRaw('projects:start-watching', project.id);
    await idle(project.id);
    await assertCarried(project.id, row);
  });

  lifecycleTest('decidable row is carried through consecutive session changes', async () => {
    const { file } = setup('carry-twice');
    const project = await createProject('Carry twice');
    const row = await addReviewRow(project.id, file('Twice.psd'));
    for (let cycle = 0; cycle < 2; cycle++) {
      await pauseThenWatch(project.id);
      await assertCarried(project.id, row);
    }
  });

  lifecycleTest('a row already hidden from an older session stays hidden', async () => {
    const { file } = setup('carry-older');
    const project = await createProject('Carry older');
    const row = await pushRow(project.id, file('Older.psd'), { captureSessionId: 'session-before-last' });
    await pauseThenWatch(project.id);
    await assertLeftHidden(project.id, row);
    await pauseThenWatch(project.id);
    await assertLeftHidden(project.id, row);
  });

  lifecycleTest('a project with no recorded owner carries nothing on its first activation, then records one', async () => {
    const { file } = setup('carry-first');
    const project = await createProject('Carry first');
    const row = await addReviewRow(project.id, file('First.psd'));
    delete storeInstance.data[OWNERS_KEY][project.id];
    await pauseThenWatch(project.id);
    await assertLeftHidden(project.id, row);
    assert.match(String(ownerOf(project.id)), /^[0-9a-f]{64}$/, 'the new session records its owner');
    const next = await addReviewRow(project.id, file('Next.psd'));
    await pauseThenWatch(project.id);
    await assertCarried(project.id, next);
    await assertLeftHidden(project.id, row);
  });

  // --- Stale, missing, changed ---------------------------------------------------

  lifecycleTest('a row whose file is gone or no longer a readable regular file is not carried', async () => {
    const { file } = setup('carry-missing');
    const project = await createProject('Carry missing');
    const target = file('Target.psd');
    const deleted = await addReviewRow(project.id, file('Deleted.psd'));
    const folder = await addReviewRow(project.id, file('NowFolder.psd'));
    const link = await addReviewRow(project.id, file('NowLink.psd'));
    const unreadable = await addReviewRow(project.id, file('Unreadable.psd'));
    await callIpcRaw('projects:pause', project.id);
    fs.rmSync(deleted.path);
    fs.rmSync(folder.path); fs.mkdirSync(folder.path);
    fs.rmSync(link.path); fs.symlinkSync(target, link.path);
    fs.chmodSync(unreadable.path, 0o000);
    try {
      await callIpcRaw('projects:start-watching', project.id);
      await idle(project.id);
      for (const row of [deleted, folder, link, unreadable]) await assertLeftHidden(project.id, row);
    } finally { fs.chmodSync(unreadable.path, 0o600); }
  });

  lifecycleTest('a file replaced while paused keeps its undecided row, and Include takes the ordinary path', async () => {
    const { file } = setup('carry-replaced');
    const project = await createProject('Carry replaced');
    const row = await addReviewRow(project.id, file('Replaced.psd'));
    await callIpcRaw('projects:pause', project.id);
    fs.writeFileSync(row.path, '8BPS synthetic replaced bytes');
    await callIpcRaw('projects:start-watching', project.id);
    await idle(project.id);
    await assertCarried(project.id, row);
    await callIpcRaw('projects:accept-pending', project.id, row.path);
    await idle(project.id);
    assert.ok(stored(project.id).files.some(item => item.path === row.path), 'Include makes it a project file');
    assert.equal(storedRow(project.id, row.path), undefined);
  });

  lifecycleTest('rows the session cleanup rule rejects are not shown; a related weak row is kept', async () => {
    const { dir, file } = setup('carry-eligibility');
    const project = await createProject('Carry eligibility');
    const source = file('Anchor.indd');
    stored(project.id).files.push({ ...makePendingFile(source, 'manual-browse'), addedAt: Date.now() });
    const related = await pushRow(project.id, file('Related.png'), { source: 'lastused-scan', captureReason: 'lastused-broad-observer',
      captureEvidence: { source: 'lastused-scan', appFamily: 'generic', state: 'pending', reason: 'lastused-broad-observer', evidenceStrength: 'broad-app-signal' } });
    const packageOutput = await pushRow(project.id, makeFile(path.join(dir, 'Client_2026-01-02', 'Output.png')));
    const unrelated = await pushRow(project.id, makeFile(path.join(TEST_HOME, 'Downloads', 'Elsewhere', 'Unrelated.png')), { source: 'lastused-scan', captureReason: 'lastused-broad-observer',
      captureEvidence: { source: 'lastused-scan', appFamily: 'generic', state: 'pending', reason: 'lastused-broad-observer', evidenceStrength: 'broad-app-signal' } });
    await pauseThenWatch(project.id);
    await assertCarried(project.id, related);
    assert.equal(await visibleRow(project.id, packageOutput.path), undefined);
    assert.equal(await visibleRow(project.id, unrelated.path), undefined);
  });

  lifecycleTest('Needs Save, Opened, stateless and Illustrator-scoped rows are not carried', async () => {
    const { file } = setup('carry-states');
    const project = await createProject('Carry states');
    const evidence = (state, appFamily) => ({ source: 'chokidar-add', appFamily, state });
    const rows = [
      await pushRow(project.id, file('NeedsSave.png'), { captureState: 'needs-save', captureEvidence: evidence('needs-save', 'photoshop') }),
      await pushRow(project.id, file('Opened.psd'), { captureState: 'observed', captureEvidence: evidence('observed', 'photoshop') }),
      await pushRow(project.id, file('NoState.psd'), { captureState: undefined }),
      await pushRow(project.id, file('IllustratorEvidence.png'), { captureEvidence: evidence('pending', 'illustrator') }),
      await pushRow(project.id, file('IllustratorSource.png'), { source: 'ai-linked', captureEvidence: undefined }),
    ];
    await pauseThenWatch(project.id);
    for (const row of rows) await assertLeftHidden(project.id, row);
  });

  // Simulated Illustrator: one saved project document that can link a file.
  function illustrator(documentPath, links = []) {
    const app = { running: true, open: true, modified: false, links: [...links], queries: 0 };
    const name = path.basename(documentPath);
    setChildProcessHandler(({ kind, command, args }) => {
      if (isIllustratorPgrepCheck({ kind, command, args })) return { stdout: app.running ? '654\n' : '' };
      if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
        app.queries++;
        if (!app.open) return { stdout: 'STATUS\tno-documents\nCOMPLETE\t0\t0\n' };
        return { stdout: [`DOC\t${documentPath}\t${name}\t${app.modified}\ttrue`,
          ...app.links.map(link => `LINK\t${documentPath}\t${name}\t${link}\t${app.modified}\ttrue`),
          `COMPLETE\t1\t${app.links.length}`].join('\n') + '\n' };
      }
      return { stdout: '' };
    });
    return app;
  }
  async function poll(id, times = 1) {
    for (let n = 0; n < times; n++) {
      await idle(id);
      for (let attempt = 0; attempt < 60; attempt++) {
        const outcome = await metadataTestHooks.pollPsForProject(id, metadataTestHooks.getActiveWatchingActivationToken(id));
        if (!(outcome && outcome.skipped)) break;
        await realWait(100);
        await idle(id);
      }
      await idle(id);
    }
  }
  async function admitDocument(id, documentPath, app, content = 'synthetic document') {
    writeSyntheticAiFile(documentPath, content);
    await emitWatcher('add', documentPath);
    await idle(id);
    app.open = true;
    await poll(id, 2);
    assert.ok(stored(id).files.some(item => item.path === documentPath), 'the document is a project file');
  }

  for (const withCopy of [false, true]) {
    lifecycleTest(`a Needs Save link row ${withCopy ? 'holding a copy of an earlier row ' : ''}is untouched and hidden, and returns as Needs Save when reported again`, async () => {
      const { dir, file } = setup(`carry-link-${withCopy ? 'copy' : 'plain'}`);
      const documentPath = path.join(dir, 'Board.ai'), linkPath = file('Linked.png');
      const app = illustrator(documentPath);
      app.open = false;
      const project = await createProject('Carry link row');
      await waitForCondition(() => app.queries >= 1, 'no activation query');
      await admitDocument(project.id, documentPath, app);
      app.links.push(linkPath); app.modified = true;
      await poll(project.id);
      const live = storedRow(project.id, linkPath);
      assert.equal(live && live.captureState, 'needs-save');
      assert.ok(await visibleRow(project.id, linkPath));
      if (withCopy) live.reviewRowBeforeLink = { path: linkPath, captureState: 'pending', captureSessionId: live.captureSessionId };
      const before = clone(live);
      // The document is closed across the change, so the activation does not re-read the link.
      app.open = false; app.links = [];
      await pauseThenWatch(project.id);
      await assertLeftHidden(project.id, before);
      app.open = true; app.links = [linkPath]; app.modified = true;
      await poll(project.id, 2);
      const shown = await visibleRow(project.id, linkPath);
      assert.ok(shown, 'the reported link is shown again');
      assert.equal(shown.captureState, 'needs-save');
    });
  }

  // --- Separation ----------------------------------------------------------------

  lifecycleTest("activating a project leaves another project's rows alone", async () => {
    const { file } = setup('carry-isolation');
    const first = await createProject('Carry isolation first');
    const firstRow = await addReviewRow(first.id, file('First.psd'));
    const second = await createProject('Carry isolation second');
    await idle(second.id);
    const secondRow = await addReviewRow(second.id, file('Second.psd'));
    // A row in the other project that carries this project's session id is still not this project's.
    const foreign = await pushRow(second.id, file('Foreign.psd'), { captureSessionId: stored(first.id).watchSessionId });
    await callIpcRaw('projects:pause', second.id);
    const before = clone(stored(second.id)), secondOwner = ownerOf(second.id);
    assert.ok(secondOwner);
    await callIpcRaw('projects:start-watching', first.id);
    await idle(first.id);
    await assertCarried(first.id, firstRow);
    assert.deepEqual(stored(second.id).pendingFiles, before.pendingFiles);
    assert.equal(stored(second.id).watchSessionId, before.watchSessionId);
    assert.equal(ownerOf(second.id), secondOwner);
    assert.equal(stored(first.id).pendingFiles.some(item => item.path === secondRow.path || item.path === foreign.path), false);
  });

  // The real store hands out a new copy on every read; the harness store does not.
  async function withCopyingStore(action) {
    const copied = value => (value === undefined ? undefined : clone(value));
    const { get, set } = storeInstance;
    storeInstance.get = function copyingGet(key, ...rest) { return copied(get.call(this, key, ...rest)); };
    storeInstance.set = function copyingSet(key, value) { return set.call(this, copied(key), copied(value)); };
    try { return await action(); } finally { delete storeInstance.get; delete storeInstance.set; }
  }

  lifecycleTest('a row staged on a paused project under another account is not carried when the first account returns', async () => {
    const { dir, file } = setup('carry-paused-account');
    const project = await createProject('Carry paused account');
    const ownRow = await addReviewRow(project.id, file('OwnRow.psd'));
    await callIpcRaw('projects:pause', project.id);
    const anchor = path.join(dir, 'Anchor.ai');
    writeSyntheticAiFile(anchor);
    await setProjectFiles(project.id, { files: [{ path: anchor, ext: '.ai', name: 'Anchor.ai', source: 'manual-browse' }], pendingFiles: stored(project.id).pendingFiles });
    await withCopyingStore(async () => {
      const endedSession = stored(project.id).watchSessionId;
      assert.ok(ownerOf(project.id));
      useAccount('second-account');
      assert.equal(ownerOf(project.id), undefined, 'a new identity ends the earlier claim before it can stage anything');
      const staged = file('StagedByOther.png');
      setChildProcessHandler(request => {
        const paths = bulkXattrPaths(request);
        return { stdout: paths.length ? formatBulkXattrOutput(paths, () => encodeLastUsedXattr(Date.now())) : '' };
      });
      assert.equal((await callIpcRaw('projects:pre-package-scan', project.id)).error, undefined);
      await projection(project.id); // the ordinary store read fills in derived fields
      const row = clone(storedRow(project.id, staged)), ownBefore = clone(storedRow(project.id, ownRow.path));
      assert.equal(row.captureState, 'pending');
      assert.equal(row.captureSessionId, endedSession, 'the row carries the stored session id');
      assert.equal(ownBefore.captureSessionId, endedSession);
      useAccount('test-account');
      setChildProcessHandler(() => ({ stdout: '' }));
      await callIpcRaw('projects:start-watching', project.id);
      await idle(project.id);
      assert.notEqual(stored(project.id).watchSessionId, endedSession);
      await assertLeftHidden(project.id, row);
      await assertLeftHidden(project.id, ownBefore); // fail closed: A, then B, then A carries nothing
    });
  });

  lifecycleTest('a marker written for one session does not carry rows of another session of the project', async () => {
    const { file } = setup('carry-other-session');
    const project = await createProject('Carry other session');
    const ownRow = await addReviewRow(project.id, file('OwnSession.psd'));
    stored(project.id).watchSessionId = 'session-started-without-a-marker'; // as a build without markers would
    const otherRow = await pushRow(project.id, file('OtherSession.psd'));
    assert.equal(otherRow.captureSessionId, 'session-started-without-a-marker');
    await pauseThenWatch(project.id);
    await assertLeftHidden(project.id, otherRow);
    await assertLeftHidden(project.id, ownRow);
  });

  lifecycleTest('a marker written for another project is not accepted, even for the same session id', async () => {
    const { file } = setup('carry-other-project-marker');
    const project = await createProject('Carry marker target');
    const other = await createProject('Carry marker source');
    await idle(other.id);
    await callIpcRaw('projects:pause', other.id);
    stored(project.id).watchSessionId = stored(other.id).watchSessionId;
    storeInstance.data[OWNERS_KEY][project.id] = ownerOf(other.id);
    const row = await pushRow(project.id, file('OtherProjectMarker.psd'));
    await callIpcRaw('projects:start-watching', project.id);
    await idle(project.id);
    await assertLeftHidden(project.id, row);
  });

  lifecycleTest('a stale projects write during a delayed project creation does not make its older session trusted', async () => {
    const { file } = setup('carry-stale-write');
    const project = await createProject('Carry stale write');
    await addReviewRow(project.id, file('StaleWrite.psd'));
    await callIpcRaw('projects:pause', project.id);
    const olderSession = stored(project.id).watchSessionId;
    const previousStub = STUBS.get('./parsers/figma');
    const { FigmaParser } = require('../parsers/figma');
    let entered = false, release;
    const released = new Promise(resolve => { release = resolve; });
    class DelayedFigmaParser extends FigmaParser {
      async validateTrackedFileScope(fileKey, scopeEntry = {}) {
        entered = true;
        await released;
        const lockedPageId = scopeEntry.requestedPageId || scopeEntry.requestedNodeId || null;
        return { valid: true, scope: { scopeMode: scopeEntry.scopeMode, lockStatus: 'locked', lockedPageId, lockedPageName: 'Verified test page', statusReason: null } };
      }
      async autoTrackScan() { return { files: [], assets: [], errors: [], warnings: [], scopeEntries: [] }; }
    }
    setStub('./parsers/figma', () => ({ FigmaParser: DelayedFigmaParser }));
    try {
      await withCopyingStore(async () => {
        const creating = callIpcRaw('projects:create', 'Carry delayed create', 'branding', 'current-page', 'https://www.figma.com/file/CARRY1/Layout?node-id=1-1');
        await waitForCondition(() => entered, 'the creation should reach its preflight');
        await callIpcRaw('projects:start-watching', project.id);
        await idle(project.id);
        const newerSession = stored(project.id).watchSessionId;
        assert.notEqual(newerSession, olderSession);
        release();
        const created = await creating;
        assert.equal(created.error, undefined);
        await idle(created.id);
        assert.equal(stored(project.id).watchSessionId, olderSession, 'the stale write put the older session back');
        const staleRow = clone(stored(project.id).pendingFiles[0]);
        assert.equal(staleRow.captureSessionId, olderSession);
        await callIpcRaw('projects:start-watching', project.id);
        await idle(project.id);
        await assertLeftHidden(project.id, staleRow);
      });
    } finally {
      release();
      if (previousStub) STUBS.set('./parsers/figma', previousStub); else STUBS.delete('./parsers/figma');
    }
  });

  lifecycleTest('a change of identity clears every project marker in one store write', async () => {
    setup('carry-identity-change');
    const first = await createProject('Carry identity first');
    const second = await createProject('Carry identity second');
    await idle(second.id);
    await callIpcRaw('projects:pause', second.id);
    assert.ok(ownerOf(first.id) && ownerOf(second.id));
    const accountBefore = storeInstance.data[ACCOUNT_KEY];
    const writes = await recordStoreWrites(() => useAccount('second-account'));
    assert.deepEqual(storeInstance.data[OWNERS_KEY], {});
    assert.match(String(storeInstance.data[ACCOUNT_KEY]), /^[0-9a-f]{64}$/);
    assert.notEqual(storeInstance.data[ACCOUNT_KEY], accountBefore);
    assert.deepEqual(writes, [{ [OWNERS_KEY]: {}, [ACCOUNT_KEY]: storeInstance.data[ACCOUNT_KEY] }]);
  });

  lifecycleTest('the same identity after a relaunch keeps every project marker', async () => {
    setup('carry-identity-same');
    const first = await createProject('Carry same identity first');
    const second = await createProject('Carry same identity second');
    await idle(second.id);
    await callIpcRaw('projects:pause', second.id);
    const owners = clone(storeInstance.data[OWNERS_KEY]), account = storeInstance.data[ACCOUNT_KEY];
    assert.ok(owners[first.id] && owners[second.id] && account);
    roundTripFakeStore();
    const writes = await recordStoreWrites(() => { testAccountSession.invalidate(); useAccount('test-account'); });
    assert.deepEqual(storeInstance.data[OWNERS_KEY], owners);
    assert.equal(storeInstance.data[ACCOUNT_KEY], account);
    assert.equal(writes.some(write => OWNERS_KEY in write || ACCOUNT_KEY in write), false);
  });

  lifecycleTest('a settings file from before these markers carries nothing at first, then starts carrying', async () => {
    const { file } = setup('carry-older-settings');
    const project = await createProject('Carry older settings');
    const firstRow = await addReviewRow(project.id, file('BeforeMarkers.psd'));
    await callIpcRaw('projects:pause', project.id);
    delete storeInstance.data[OWNERS_KEY];
    delete storeInstance.data[ACCOUNT_KEY];
    roundTripFakeStore();
    testAccountSession.invalidate();
    useAccount('test-account');
    await callIpcRaw('projects:start-watching', project.id);
    await idle(project.id);
    await assertLeftHidden(project.id, firstRow);
    assert.ok(storeInstance.data[OWNERS_KEY] && typeof storeInstance.data[OWNERS_KEY] === 'object');
    assert.match(String(ownerOf(project.id)), /^[0-9a-f]{64}$/);
    assert.match(String(storeInstance.data[ACCOUNT_KEY]), /^[0-9a-f]{64}$/);
    const nextRow = await addReviewRow(project.id, file('AfterMarkers.psd'));
    await pauseThenWatch(project.id);
    await assertCarried(project.id, nextRow);
    await assertLeftHidden(project.id, firstRow);
  });

  lifecycleTest('a malformed marker for another project does not stop this project, and is repaired', async () => {
    const { file } = setup('carry-mixed-owners');
    const other = await createProject('Carry mixed other');
    await idle(other.id);
    const textOther = await createProject('Carry mixed text');
    await idle(textOther.id);
    const project = await createProject('Carry mixed');
    const row = await addReviewRow(project.id, file('MixedOwners.psd'));
    storeInstance.data[OWNERS_KEY][other.id] = 123;
    storeInstance.data[OWNERS_KEY][textOther.id] = 'not-a-digest';
    await pauseThenWatch(project.id);
    await assertCarried(project.id, row);
    assert.deepEqual(Object.keys(storeInstance.data[OWNERS_KEY]), [project.id]);
  });

  lifecycleTest('an account marker that does not match carries nothing and is replaced at activation', async () => {
    const { file } = setup('carry-account-marker');
    const project = await createProject('Carry account marker');
    const row = await addReviewRow(project.id, file('AccountMarker.psd'));
    const account = storeInstance.data[ACCOUNT_KEY];
    storeInstance.data[ACCOUNT_KEY] = 'b'.repeat(64);
    await pauseThenWatch(project.id);
    await assertLeftHidden(project.id, row);
    assert.equal(storeInstance.data[ACCOUNT_KEY], account);
    const next = await addReviewRow(project.id, file('AfterAccountMarker.psd'));
    await pauseThenWatch(project.id);
    await assertCarried(project.id, next);
  });

  lifecycleTest('when clearing markers fails, none is trusted until an activation replaces them', async () => {
    const { file } = setup('carry-clear-fails');
    const project = await createProject('Carry clear fails');
    const row = await addReviewRow(project.id, file('ClearFails.psd'));
    await callIpcRaw('projects:pause', project.id);
    const originalSet = storeInstance.set;
    storeInstance.set = function failingSet(key, value) {
      if (key && typeof key === 'object' && ACCOUNT_KEY in key) throw new Error('synthetic write failure');
      return originalSet.call(this, key, value);
    };
    try { useAccount('second-account'); } finally { delete storeInstance.set; }
    assert.ok(ownerOf(project.id), 'the failed write left the old marker in place');
    useAccount('test-account');
    await callIpcRaw('projects:start-watching', project.id);
    await idle(project.id);
    await assertLeftHidden(project.id, row);
    const next = await addReviewRow(project.id, file('AfterClearFails.psd'));
    await pauseThenWatch(project.id);
    await assertCarried(project.id, next);
  });

  // While `reads.failing` is true, reads of `onlyKey` throw, or every read when no key is given.
  function failStoreReads(onlyKey = null) {
    const reads = { failing: false }, { get } = storeInstance;
    storeInstance.get = function failableGet(key, ...rest) {
      if (reads.failing && (!onlyKey || key === onlyKey)) throw new Error('synthetic settings read failure');
      return get.call(this, key, ...rest);
    };
    return reads;
  }
  async function stageRecentRow(projectId, filePath) {
    setChildProcessHandler(request => {
      const paths = bulkXattrPaths(request);
      return { stdout: paths.length ? formatBulkXattrOutput(paths, () => encodeLastUsedXattr(Date.now())) : '' };
    });
    assert.equal((await callIpcRaw('projects:pre-package-scan', projectId)).error, undefined);
    await projection(projectId);
    setChildProcessHandler(() => ({ stdout: '' }));
    return clone(storedRow(projectId, filePath));
  }
  const ignoreFailure = async action => { try { await action(); } catch (_) { /* the outcome is checked below */ } };

  // With every read failing, the listener still stops at its own project read,
  // as it does without this change; the row must stay hidden either way.
  for (const [readsLabel, failingKey] of [['every settings read', null], ['the account marker read', ACCOUNT_KEY]]) {
    lifecycleTest(`a sign-in while ${readsLabel} fails cannot leave the first account marker trusted`, async () => {
      const { dir } = setup('carry-read-failure');
      const project = await createProject('Carry read failure');
      await callIpcRaw('projects:pause', project.id);
      const anchor = path.join(dir, 'Anchor.ai');
      writeSyntheticAiFile(anchor);
      await setProjectFiles(project.id, { files: [{ path: anchor, ext: '.ai', name: 'Anchor.ai', source: 'manual-browse' }], pendingFiles: [] });
      const session = testAccountSession, saved = { provider: session.provider, credentials: session.credentials, openExternal: session.openExternal, config: session.config };
      const identity = { id: '00000000-0000-4000-8000-00000000000b', email: 'second@example.invalid', verified: true };
      Object.assign(session, {
        config: session.config || { issuer: 'https://accounts.example.invalid', clientId: 'synthetic', redirectUri: 'https://accounts.example.invalid/callback' },
        openExternal: async () => {},
        credentials: { read: () => null, write() {}, clear() {} },
        provider: {
          exchange: async () => ({ access_token: 'second-access', refresh_token: 'second-refresh' }),
          validate: async () => ({ subject: identity.id, expiresAt: Date.now() + 3600000 }),
          me: async () => identity,
        },
      });
      try {
        await withCopyingStore(async () => {
          const reads = failStoreReads(failingKey);
          const endedSession = stored(project.id).watchSessionId;
          await session.begin();
          const { CALLBACK } = require('../account-config');
          const callback = `${CALLBACK}?code=synthetic-code&state=${session.pending.state}`;
          reads.failing = true;
          await ignoreFailure(() => session.callback(callback));
          await ignoreFailure(() => session.begin());
          await ignoreFailure(() => session.cancel());
          reads.failing = false;
          assert.equal(session.canUseWorkspace(), true, 'the second account has workspace access');
          assert.equal(session.snapshot().identity.id, identity.id);
          const staged = path.join(dir, 'StagedDuringFailure.png');
          fs.writeFileSync(staged, 'synthetic');
          const row = await stageRecentRow(project.id, staged);
          assert.equal(row.captureSessionId, endedSession);
          useAccount('test-account');
          await callIpcRaw('projects:start-watching', project.id);
          await idle(project.id);
          await assertLeftHidden(project.id, row);
        });
      } finally { Object.assign(session, saved); }
    });
  }

  lifecycleTest('a failed read of the account marker does not stop the account listener', async () => {
    const { file } = setup('carry-listener-read');
    const project = await createProject('Carry listener read');
    const row = await addReviewRow(project.id, file('ListenerRead.psd'));
    const endedSession = stored(project.id).watchSessionId, watchers = watcherRecords.length, closedBefore = watcherCloseCount;
    testRendererEvents.length = 0;
    const reads = failStoreReads(ACCOUNT_KEY);
    reads.failing = true;
    try {
      assert.doesNotThrow(() => useAccount('second-account'));
      assert.ok(watcherCloseCount > closedBefore, 'the old watch is stopped');
      assert.ok(testRendererEvents.some(event => event.channel === 'account:changed'), 'the window is told');
      assert.notEqual(stored(project.id).watchSessionId, endedSession, 'Watch restarts as it does on a healthy store');
      await waitForCondition(() => watcherRecords.length > watchers, 'Watch should restart');
      await idle(project.id);
    } finally { reads.failing = false; delete storeInstance.get; }
    await assertLeftHidden(project.id, row);
  });

  lifecycleTest('offline grace for the same identity keeps every marker and its rows', async () => {
    const { file } = setup('carry-offline-grace');
    const project = await createProject('Carry offline grace');
    const row = await addReviewRow(project.id, file('OfflineGrace.psd'));
    await callIpcRaw('projects:pause', project.id);
    const owners = clone(storeInstance.data[OWNERS_KEY]), account = storeInstance.data[ACCOUNT_KEY];
    const writes = await recordStoreWrites(() => testAccountSession.publish('offline', 'Account could not be checked online.'));
    assert.equal(testAccountSession.canUseWorkspace(), true);
    assert.equal(writes.some(write => OWNERS_KEY in write || ACCOUNT_KEY in write), false);
    assert.deepEqual(storeInstance.data[OWNERS_KEY], owners);
    assert.equal(storeInstance.data[ACCOUNT_KEY], account);
    await callIpcRaw('projects:start-watching', project.id);
    await idle(project.id);
    await assertCarried(project.id, row);
  });

  for (const [label, publishNext] of [
    ['the same identity', () => useAccount('test-account')],
    ['a signed-out state', () => { testAccountSession.invalidate(); testAccountSession.accessToken = null; testAccountSession.publish('signed_out', '', null); }],
  ]) {
    lifecycleTest(`after a read failure, the next publish (${label}) clears the markers on disk`, async () => {
      const { file } = setup('carry-retry-clear');
      const project = await createProject('Carry retry clear');
      const row = await addReviewRow(project.id, file('RetryClear.psd'));
      await callIpcRaw('projects:pause', project.id);
      const reads = failStoreReads(ACCOUNT_KEY);
      reads.failing = true;
      try { assert.doesNotThrow(() => useAccount('second-account')); } finally { reads.failing = false; delete storeInstance.get; }
      assert.ok(ownerOf(project.id), 'nothing could be cleared while the read failed');
      publishNext();
      assert.deepEqual(storeInstance.data[OWNERS_KEY], {}, 'the retry cleared the markers');
      roundTripFakeStore();
      useAccount('test-account');
      await callIpcRaw('projects:start-watching', project.id);
      await idle(project.id);
      await assertLeftHidden(project.id, row);
    });
  }

  lifecycleTest('an activation honors an earlier read failure even with no account publish after it', async () => {
    const { file } = setup('carry-latch-activation');
    const project = await createProject('Carry latch activation');
    const row = await addReviewRow(project.id, file('LatchActivation.psd'));
    await callIpcRaw('projects:pause', project.id);
    const reads = failStoreReads(ACCOUNT_KEY);
    reads.failing = true;
    try { assert.doesNotThrow(() => testAccountSession.publish('offline', 'Account could not be checked online.')); } finally { reads.failing = false; delete storeInstance.get; }
    await callIpcRaw('projects:start-watching', project.id);
    await idle(project.id);
    await assertLeftHidden(project.id, row);
    const next = await addReviewRow(project.id, file('AfterLatchActivation.psd'));
    await pauseThenWatch(project.id);
    await assertCarried(project.id, next);
  });

  lifecycleTest('a failed read of the account marker at activation trusts nothing, and the activation replaces the markers', async () => {
    const { file } = setup('carry-activation-read');
    const project = await createProject('Carry activation read');
    const row = await addReviewRow(project.id, file('ActivationRead.psd'));
    await callIpcRaw('projects:pause', project.id);
    const { get } = storeInstance;
    storeInstance.get = function accountReadFails(key, ...rest) {
      if (key === ACCOUNT_KEY) throw new Error('synthetic settings read failure');
      return get.call(this, key, ...rest);
    };
    try { await callIpcRaw('projects:start-watching', project.id); } finally { delete storeInstance.get; }
    await idle(project.id);
    await assertLeftHidden(project.id, row);
    const next = await addReviewRow(project.id, file('AfterActivationRead.psd'));
    await pauseThenWatch(project.id);
    await assertCarried(project.id, next);
  });

  // The account listener stops the watching project and restarts it, keeping its
  // watch start time: the same path a relaunch or sign-in restore takes.
  async function restartThroughAccountChange(id, change) {
    const endedSession = stored(id).watchSessionId, watchStartedAt = stored(id).watchStartedAt, watchers = watcherRecords.length;
    change();
    await waitForCondition(() => stored(id).watchSessionId !== endedSession && watcherRecords.length > watchers, 'the account change did not restart Watch');
    await idle(id);
    assert.equal(stored(id).watchStartedAt, watchStartedAt);
  }

  // Records every store write made while `action` runs.
  async function recordStoreWrites(action) {
    const writes = [], originalSet = storeInstance.set;
    storeInstance.set = function recordingSet(key, value) {
      writes.push(typeof key === 'object' ? clone(key) : { [key]: clone(value === undefined ? null : value) });
      return originalSet.call(this, key, value);
    };
    try { await action(); } finally { storeInstance.set = originalSet; }
    return writes;
  }

  lifecycleTest('deleting a project removes its owner marker in the same store write', async () => {
    setup('carry-delete');
    const removed = await createProject('Carry deleted');
    const kept = await createProject('Carry kept');
    await idle(kept.id);
    assert.ok(ownerOf(removed.id));
    const keptOwner = ownerOf(kept.id);
    const writes = await recordStoreWrites(() => callIpcRaw('projects:delete', removed.id));
    assert.equal(ownerOf(removed.id), undefined);
    assert.equal(ownerOf(kept.id), keptOwner);
    const deletion = writes.filter(write => write.projects && !write.projects.some(project => project.id === removed.id));
    assert.ok(deletion.length >= 1, 'the project is removed by a store write');
    for (const write of deletion) assert.deepEqual(write[OWNERS_KEY], { [kept.id]: keptOwner }, 'the marker goes in that same write');
  });

  lifecycleTest('deleting all projects clears every owner marker in the same store write', async () => {
    setup('carry-delete-all');
    const first = await createProject('Carry delete all first');
    const second = await createProject('Carry delete all second');
    await idle(second.id);
    assert.ok(ownerOf(first.id) && ownerOf(second.id));
    const writes = await recordStoreWrites(() => callIpcRaw('projects:delete-all'));
    assert.deepEqual(storeInstance.data[OWNERS_KEY], {});
    assert.ok(writes.some(write => Array.isArray(write.projects) && write.projects.length === 0 && Object.keys(write[OWNERS_KEY] || { unset: true }).length === 0));
  });

  lifecycleTest('an owner marker left behind by an older state is dropped at the next activation', async () => {
    setup('carry-orphan');
    const project = await createProject('Carry orphan');
    await idle(project.id);
    storeInstance.data[OWNERS_KEY]['project-that-no-longer-exists'] = 'a'.repeat(64);
    await pauseThenWatch(project.id);
    assert.deepEqual(Object.keys(storeInstance.data[OWNERS_KEY]), [project.id]);
  });

  for (const [label, makeOwners] of [
    ['an array', () => ['not', 'a', 'map']],
    ['a string', () => 'not a map'],
    ['a number', () => 42],
    ['null', () => null],
    ['a map whose entry is not a string', id => ({ [id]: 123 })],
  ]) {
    lifecycleTest(`a malformed owner map (${label}) carries nothing and is replaced by a valid map`, async () => {
      const { file } = setup('carry-bad-owners');
      const project = await createProject('Carry bad owners');
      const row = await addReviewRow(project.id, file('BadOwners.psd'));
      await callIpcRaw('projects:pause', project.id);
      storeInstance.data[OWNERS_KEY] = makeOwners(project.id);
      await callIpcRaw('projects:start-watching', project.id);
      await idle(project.id);
      await assertLeftHidden(project.id, row);
      assert.deepEqual(Object.keys(storeInstance.data[OWNERS_KEY]), [project.id]);
      assert.match(String(ownerOf(project.id)), /^[0-9a-f]{64}$/);
      const next = await addReviewRow(project.id, file('AfterRepair.psd'));
      await pauseThenWatch(project.id);
      await assertCarried(project.id, next);
    });
  }

  lifecycleTest('a different account carries nothing, in either direction', async () => {
    const { file } = setup('carry-account');
    const project = await createProject('Carry account');
    const rowA = await addReviewRow(project.id, file('AccountA.psd'));
    const digestA = ownerOf(project.id);
    await restartThroughAccountChange(project.id, () => useAccount('other-account'));
    await assertLeftHidden(project.id, rowA);
    assert.notEqual(ownerOf(project.id), digestA);
    const rowB = await addReviewRow(project.id, file('AccountB.psd'));
    await restartThroughAccountChange(project.id, () => useAccount('test-account'));
    await assertLeftHidden(project.id, rowA);
    await assertLeftHidden(project.id, rowB);
    assert.notEqual(ownerOf(project.id), digestA, 'a marker belongs to one session');
  });

  lifecycleTest('the same account keeps its rows through a session refresh and a sign-in restore', async () => {
    const { file } = setup('carry-refresh');
    const project = await createProject('Carry refresh');
    const row = await addReviewRow(project.id, file('Refresh.psd'));
    await restartThroughAccountChange(project.id, () => { testAccountSession.invalidate(); useAccount('test-account'); });
    await assertCarried(project.id, row);
    testAccountSession.invalidate();
    testAccountSession.accessToken = null;
    testAccountSession.publish('signed_out', '', null);
    await restartThroughAccountChange(project.id, () => useAccount('test-account'));
    await assertCarried(project.id, row);
  });

  lifecycleTest('an activation with no known identity carries nothing and clears the owner', async () => {
    const { file } = setup('carry-no-identity');
    const project = await createProject('Carry no identity');
    const row = await addReviewRow(project.id, file('NoIdentity.psd'));
    await callIpcRaw('projects:pause', project.id);
    testAccountSession.status = { ...testAccountSession.status, identity: null };
    await callIpcRaw('projects:start-watching', project.id);
    await idle(project.id);
    await assertLeftHidden(project.id, row);
    assert.equal(ownerOf(project.id), undefined, 'an unknown owner is not recorded');
    const unowned = await addReviewRow(project.id, file('Unowned.psd'));
    useAccount('test-account');
    await callIpcRaw('projects:start-watching', project.id);
    await idle(project.id);
    await assertLeftHidden(project.id, unowned);
  });

  lifecycleTest('the owner digest never reaches a renderer reply, event or log across a full carry cycle', async () => {
    const { file } = setup('carry-private');
    const logged = [];
    const restores = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
      const original = console[level];
      console[level] = (...args) => { logged.push(args.map(String).join(' ')); };
      restores.push(() => { console[level] = original; });
    }
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write;
      stream.write = function capturedWrite(chunk, ...args) { logged.push(String(chunk)); return original.call(this, chunk, ...args); };
      restores.push(() => { stream.write = original; });
    }
    try {
      testRendererEvents.length = 0;
      const project = await callIpcRaw('projects:create', 'Carry private', 'branding', 'current-page', null);
      const other = await callIpcRaw('projects:create', 'Carry private other', 'branding', 'current-page', null);
      await idle(other.id);
      const replies = [project, other, await callIpcRaw('projects:start-watching', project.id)];
      await idle(project.id);
      const row = await addReviewRow(project.id, file('Private.psd'));
      await pushRow(project.id, file('HiddenStale.psd'), { captureSessionId: 'session-before-last' }); // forces the filtered projection
      replies.push(await callIpcRaw('projects:pause', project.id), await callIpcRaw('projects:start-watching', project.id));
      await idle(project.id);
      await assertCarried(project.id, row);
      replies.push(await callIpcRaw('projects:get-all'), await callIpcRaw('projects:get-asset-workspace', project.id),
        await callIpcRaw('projects:get-files', project.id), await callIpcRaw('projects:set-existing-assets-decision', project.id, 'include'));
      stored(project.id).pendingFiles = stored(project.id).pendingFiles.filter(item => item.path === row.path);
      replies.push(await callIpcRaw('projects:get-all'), await callIpcRaw('projects:get-asset-workspace', project.id)); // the unfiltered projection
      const digest = ownerOf(project.id), otherDigest = ownerOf(other.id);
      assert.match(String(digest), /^[0-9a-f]{64}$/);
      assert.notEqual(otherDigest, digest, 'digests are per project');
      assert.ok(testRendererEvents.some(event => event.channel === 'files:pending'), 'the file-state channels were exercised');
      for (const text of [JSON.stringify(replies), JSON.stringify(testRendererEvents), logged.join('\n')]) {
        for (const secret of [digest, otherDigest, storeInstance.data[ACCOUNT_KEY], OWNERS_KEY, ACCOUNT_KEY]) assert.equal(text.includes(secret), false);
      }
      assert.equal(JSON.stringify(stored(project.id)).includes(digest), false, 'the digest is not on the project');
      assert.match(String(storeInstance.data[ACCOUNT_KEY]), /^[0-9a-f]{64}$/);
      assert.equal(JSON.stringify([stored(project.id), storeInstance.data[OWNERS_KEY], storeInstance.data[ACCOUNT_KEY]]).includes('test-account'), false, 'the identity itself is never stored');
    } finally { for (const restore of restores) restore(); }
  });

  // --- Decisions -----------------------------------------------------------------

  lifecycleTest('a row with an exclusion key or an Excluded record is not carried', async () => {
    const { file } = setup('carry-excluded');
    const project = await createProject('Carry excluded');
    const keyed = await addReviewRow(project.id, file('Keyed.psd'));
    const recorded = await addReviewRow(project.id, file('Recorded.psd'));
    await callIpcRaw('projects:pause', project.id);
    const current = stored(project.id);
    current.excludedAssetKeys = [keyed.path];
    current.excludedPendingFiles = [{ path: recorded.path, name: recorded.name, ext: recorded.ext, addedAt: recorded.addedAt, excludedRecordVersion: 1, excludedAt: Date.now() }];
    const decisions = clone({ keys: current.excludedAssetKeys, records: current.excludedPendingFiles });
    await callIpcRaw('projects:start-watching', project.id);
    await idle(project.id);
    await assertLeftHidden(project.id, keyed);
    await assertLeftHidden(project.id, recorded);
    assert.deepEqual({ keys: stored(project.id).excludedAssetKeys, records: stored(project.id).excludedPendingFiles }, decisions);
  });

  lifecycleTest('an unreadable Excluded list stops the carry and is left as it is', async () => {
    const { file } = setup('carry-bad-records');
    const project = await createProject('Carry bad records');
    const row = await addReviewRow(project.id, file('BadRecords.psd'));
    await callIpcRaw('projects:pause', project.id);
    stored(project.id).excludedPendingFiles = [{ path: 'not a valid record' }];
    await callIpcRaw('projects:start-watching', project.id);
    await idle(project.id);
    await assertLeftHidden(project.id, row);
    assert.deepEqual(stored(project.id).excludedPendingFiles, [{ path: 'not a valid record' }]);
  });

  lifecycleTest('Exclude and Include on a carried row work as usual, and only on the click', async () => {
    const { file } = setup('carry-decide');
    const project = await createProject('Carry decide');
    const excludeRow = await addReviewRow(project.id, file('ExcludeMe.psd'));
    const includeRow = await addReviewRow(project.id, file('IncludeMe.psd'));
    await pauseThenWatch(project.id);
    await assertCarried(project.id, excludeRow);
    await assertCarried(project.id, includeRow);
    assert.deepEqual(stored(project.id).excludedAssetKeys, [], 'carrying records no decision');
    assert.equal((stored(project.id).excludedPendingFiles || []).length, 0);
    await callIpcRaw('projects:reject-pending', project.id, excludeRow.path);
    await callIpcRaw('projects:accept-pending', project.id, includeRow.path);
    await idle(project.id);
    const current = stored(project.id);
    assert.ok(current.excludedAssetKeys.includes(excludeRow.path));
    assert.ok(current.excludedPendingFiles.some(record => record.path === excludeRow.path));
    assert.equal(current.files.some(item => item.path === excludeRow.path), false);
    assert.ok(current.files.some(item => item.path === includeRow.path));
    assert.equal(current.excludedAssetKeys.includes(includeRow.path), false);
    assert.equal(current.pendingFiles.some(item => [excludeRow.path, includeRow.path].includes(item.path)), false);
  });

  lifecycleTest('a carried row never becomes a project file or an anchor by itself', async () => {
    const { dir, file } = setup('carry-never-admitted');
    const documentPath = path.join(dir, 'Board.ai'), neighbor = file('Neighbor.png');
    const app = illustrator(documentPath);
    app.open = false;
    const project = await createProject('Carry never admitted');
    await waitForCondition(() => app.queries >= 1, 'no activation query');
    await admitDocument(project.id, documentPath, app);
    const row = await addReviewRow(project.id, file('Undecided.ai'));
    setChildProcessHandler(({ kind, command, args }) => {
      if (kind === 'exec' && command.startsWith('/bin/ps ax -o pid= -o command=')) return { stdout: '777 /Applications/Figma.app/Contents/MacOS/Figma\n' };
      if (kind === 'exec' && command.startsWith('/usr/sbin/lsof -F ptn -p 777')) return { stdout: `p777\nf13\ntREG\nn${neighbor}\n` };
      return { stdout: '' };
    });
    fs.rmSync(documentPath);
    mutateStoredFilesWithout(project.id, documentPath);
    for (let cycle = 0; cycle < 3; cycle++) {
      await pauseThenWatch(project.id);
      const startedAt = stored(project.id).watchStartedAt;
      await emitWatcherWithStats('add', row.path, { mtimeMs: startedAt - DAY_MS, birthtimeMs: startedAt - DAY_MS });
      await idle(project.id);
      await metadataTestHooks.pollLsofForProject(project.id, metadataTestHooks.getActiveWatchingActivationToken(project.id));
      await poll(project.id);
      await assertCarried(project.id, row);
      assert.equal(stored(project.id).pendingFiles.filter(item => item.path === row.path).length, 1, 'one stored row');
      assert.equal(stored(project.id).pendingFiles.some(item => item.path === neighbor), false, 'the carried row anchors nothing');
      assert.equal(stored(project.id).files.some(item => item.path === neighbor), false);
    }
  });
  function mutateStoredFilesWithout(id, filePath) {
    stored(id).files = stored(id).files.filter(item => item.path !== filePath);
    stored(id).pendingFiles = stored(id).pendingFiles.filter(item => item.path !== filePath);
  }

  // --- Full sequence: one project from the first review rows to the final save ---

  function makeSequenceFixture(tag) {
    const dir = path.join(TEST_HOME, 'Desktop', `Sequence_${tag}`);
    fs.mkdirSync(dir, { recursive: true });
    const file = name => path.join(dir, name);
    const existing = [];
    for (let i = 1; i <= 12; i++) existing.push(file(`Asset${String(i).padStart(2, '0')}.png`));
    const fixture = { dir, doc: file('Board.ai'), existing, layeredA: file('LayeredA.psd'), layeredB: file('LayeredB.psd'), layeredC: file('LayeredC.psd'),
      jpgs: [1, 2, 3].map(i => file(`Photo${i}.jpg`)), earlierImages: [1, 2, 3].map(i => file(`Earlier${i}.png`)) };
    for (const p of [...existing, ...fixture.jpgs, ...fixture.earlierImages]) fs.writeFileSync(p, Buffer.concat([createSyntheticPngBytes(), Buffer.from(`sequence:${tag}:${path.basename(p)}`)]));
    for (const p of [fixture.layeredA, fixture.layeredB, fixture.layeredC]) fs.writeFileSync(p, `8BPS synthetic ${tag} ${path.basename(p)}`);
    return fixture;
  }
  async function save(id, fixture, app) {
    writeSyntheticAiFile(fixture.doc, app.links.join('\n') + `\nsaved ${Date.now()} ${Math.random()}`);
    app.modified = false;
    await emitWatcher('change', fixture.doc);
    await idle(id);
    await realWait(150);
    await poll(id, 2);
  }
  async function place(id, app, paths) { app.links.push(...paths); app.modified = true; await poll(id); }
  async function unlink(id, app, paths) { app.links = app.links.filter(link => !paths.includes(link)); app.modified = true; await poll(id); }
  async function sequenceState(id) {
    const workspace = await callIpcRaw('projects:get-asset-workspace', id);
    const view = await projection(id);
    const files = workspace.files || [];
    const isAsset = file => file.projectRole !== 'source' && file.protectedSource !== true && file.role !== 'source';
    const isExcluded = file => file.excluded === true || file.included === false;
    const origin = file => file.assetOrigin || file.origin || (file.category === 'existing' ? 'existing' : 'added');
    const assets = files.filter(isAsset);
    const remembered = (workspace.excludedPendingFiles || []).map(file => file.name).sort();
    const rows = view.pendingFiles || [];
    return {
      existing: assets.filter(file => origin(file) === 'existing' && !isExcluded(file)).length,
      added: assets.filter(file => origin(file) !== 'existing' && !isExcluded(file)).map(file => file.name).sort(),
      excluded: assets.filter(isExcluded).map(file => file.name).sort(),
      remembered,
      review: rows.map(file => `${file.name}[${file.captureState}]`).sort(),
      decidable: rows.filter(file => file.captureState === 'pending').map(file => file.name).sort(),
      working: files.filter(file => !isAsset(file)).length,
      keys: (stored(id).excludedAssetKeys || []).length,
      all: assets.length + rows.length + remembered.length,
    };
  }
  async function reachReviewState(tag, second) {
    resetTestHomeWorkspace();
    const fixture = makeSequenceFixture(tag);
    const app = illustrator(fixture.doc, fixture.existing);
    app.open = false;
    const project = await createProject(`Sequence ${tag}`);
    await waitForCondition(() => app.queries >= 1, 'no activation query');
    await admitDocument(project.id, fixture.doc, app, fixture.existing.join('\n'));
    await callIpcRaw('projects:set-existing-assets-decision', project.id, 'include');
    await poll(project.id);
    const secondPath = second === 'placed-later' ? fixture.layeredB : fixture.layeredC;
    await addReviewRow(project.id, fixture.layeredA);
    await addReviewRow(project.id, secondPath);
    const state = await sequenceState(project.id);
    assert.deepEqual([state.existing, state.added, state.excluded, state.working], [12, [], [], 1]);
    assert.deepEqual(state.decidable, [path.basename(fixture.layeredA), path.basename(secondPath)].sort());
    return { fixture, app, project, secondName: path.basename(secondPath) };
  }
  async function afterSessionChange(gap, id) {
    if (gap === 'pause-then-watch') {
      await callIpcRaw('projects:pause', id);
    } else if (gap === 'switch-and-back') {
      const other = await createProject(`Sequence other ${Date.now()}`);
      await idle(other.id);
    } else {
      roundTripFakeStore();
    }
    await callIpcRaw('projects:start-watching', id);
    await idle(id);
    await realWait(200);
    await poll(id, 2);
  }
  const earlierNames = fixture => fixture.earlierImages.map(file => path.basename(file)).sort();
  const photos = fixture => fixture.jpgs.map(file => path.basename(file)).sort();

  for (const gap of ['pause-then-watch', 'switch-and-back', 'relaunch']) for (const second of ['placed-later', 'never-placed']) {
    lifecycleTest(`full sequence, ${gap}, second row ${second}: undecided rows survive and resolve only by decision or saved link`, async () => {
      const { fixture, app, project, secondName } = await reachReviewState(`${gap}_${second}`.replace(/[^a-z_]/g, '_'), second);
      const id = project.id, nameA = path.basename(fixture.layeredA), nameB = path.basename(fixture.layeredB);
      await afterSessionChange(gap, id);
      let state = await sequenceState(id);
      assert.deepEqual(state.decidable, [nameA, secondName].sort(), 'both PSD rows are still decidable after the session change');

      await place(id, app, fixture.jpgs);
      state = await sequenceState(id);
      assert.deepEqual(state.decidable, [nameA, secondName].sort());
      assert.deepEqual(state.review.filter(row => row.endsWith('[needs-save]')), photos(fixture).map(name => `${name}[needs-save]`));
      assert.deepEqual([state.existing, state.added, state.excluded, state.working, state.keys], [12, [], [], 1, 0], 'nothing was added or excluded');

      await save(id, fixture, app);
      await place(id, app, [...fixture.earlierImages, fixture.layeredB]);
      await save(id, fixture, app);
      state = await sequenceState(id);
      assert.ok(state.added.includes(nameB), 'the placed and saved layered file is Included');
      assert.ok(state.decidable.includes(nameA), 'the unplaced layered file is still decidable');
      assert.equal(state.decidable.includes(nameB), false);
      assert.deepEqual([state.existing, state.working], [12, 1]);

      await unlink(id, app, fixture.earlierImages);
      await save(id, fixture, app);
      for (const image of fixture.earlierImages) await callIpcRaw('projects:remove-file', id, image);
      await place(id, app, [fixture.layeredA]);
      await save(id, fixture, app);
      state = await sequenceState(id);
      assert.ok(state.added.includes(nameA), 'the layered file placed and saved later is Included');
      assert.equal(state.decidable.includes(nameA), false);
      assert.deepEqual(state.excluded, earlierNames(fixture), 'the three earlier images stay excluded');

      await unlink(id, app, fixture.jpgs);
      await save(id, fixture, app);
      state = await sequenceState(id);
      assert.deepEqual([state.existing, state.working], [12, 1], 'existing assets and the working file never change');
      assert.deepEqual(state.excluded, earlierNames(fixture));
      assert.deepEqual(state.decidable, second === 'never-placed' ? [secondName] : [], 'an undecided file that was never placed is still only a question');
      assert.ok(state.added.includes(nameA) && state.added.includes(nameB));
      assert.equal(stored(id).files.some(file => file.path === fixture.layeredC), false, 'an unplaced undecided file is never admitted');
    });
  }

  for (const bulk of ['skip-all', 'add-all']) for (const second of ['placed-later', 'never-placed']) {
    lifecycleTest(`full sequence, ${bulk}, second row ${second}: bulk decisions behave as before`, async () => {
      const { fixture, app, project, secondName } = await reachReviewState(`${bulk}_${second}`.replace(/[^a-z_]/g, '_'), second);
      const id = project.id, nameA = path.basename(fixture.layeredA), nameB = path.basename(fixture.layeredB);
      const channel = bulk === 'skip-all' ? 'projects:reject-pending' : 'projects:accept-pending';
      for (const row of (await projection(id)).pendingFiles.filter(file => file.captureState === 'pending')) await callIpcRaw(channel, id, row.path);
      await idle(id); await realWait(200); await poll(id, 2);

      await place(id, app, fixture.jpgs);
      let state = await sequenceState(id);
      assert.deepEqual(state.review, photos(fixture).map(name => `${name}[needs-save]`));
      assert.deepEqual([state.existing, state.added, state.excluded], [12, [], []]);
      if (bulk === 'skip-all') {
        assert.deepEqual([state.all, state.working, state.keys], [17, 1, 2]);
        assert.deepEqual(state.remembered, [nameA, secondName].sort());
      } else {
        assert.deepEqual([state.all, state.working, state.keys, state.remembered], [15, 3, 0, []]);
      }

      await save(id, fixture, app);
      await place(id, app, [...fixture.earlierImages, fixture.layeredB]);
      await save(id, fixture, app);
      await unlink(id, app, fixture.earlierImages);
      await save(id, fixture, app);
      for (const image of fixture.earlierImages) await callIpcRaw('projects:remove-file', id, image);
      await place(id, app, [fixture.layeredA]);
      await save(id, fixture, app);
      await unlink(id, app, fixture.jpgs);
      await save(id, fixture, app);
      state = await sequenceState(id);
      assert.equal(state.added.includes(nameA), false, 'an earlier bulk decision on the layered file still stands');
      assert.equal(state.added.includes(nameB), second === 'never-placed');
      assert.deepEqual(state.excluded, earlierNames(fixture));
      assert.deepEqual(state.decidable, []);
    });
  }
}
