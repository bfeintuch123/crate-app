'use strict';

// Reuse the real IPC/store/observer harness read-only. Suppress its unrelated
// registrations, retaining its cleanup hooks; append only this file's cases.
// This is source-level mock coverage, not a compiled or native-app acceptance.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const assert = require('node:assert/strict');
const harnessPath = path.join(__dirname, 'provenance-dual-write.test.js');
let harness = fs.readFileSync(harnessPath, 'utf8');
function replaceExactlyOnce(before, after) {
  assert.equal(harness.split(before).length - 1, 1, `harness anchor drift: ${before}`);
  harness = harness.replace(before, after);
}
replaceExactlyOnce("const test = require('node:test');",
  "const baselineTest = require('node:test'); const test = new Proxy(baselineTest, { apply() {} });");
// Source parser accepts /Users/ links. Keep all physical fixtures in a disposable
// sibling of this checkout, never the user's actual HOME or private projects.
replaceExactlyOnce("fs.mkdtempSync(path.join(os.tmpdir(), 'crate-provenance-dual-write-home-'))",
  "fs.mkdtempSync(path.join(path.dirname(MAIN_UNDER_TEST_ROOT), 'olivia-synthetic-home-'))");
replaceExactlyOnce('  captureProjectOperation,\n  runScanOnOpen',
  '  parseInDesignActiveSessionOutput, createInDesignLiveEvidenceRecords, parseDependableInDesignBaselineSnapshot, inDesignScript: INDD_APPLESCRIPT, selectProjectFilesForPackaging, extractLinkedAssets, extractLinkedAssetsIdml, createProjectFileVisualIdentity, getAssetBaselineSourceRecoveryRouteKey, getWorkingSourceMembership, getWorkingSourceVerification, getStablePackageReviewSourceContentFingerprint, getPackageReviewSourceFingerprint,\n' +
  '  getWorkingScanLifetime() { return { operations: workingSourceScanOperations.size, leases: workingSourceScanLeases.size }; },\n' +
  '  pauseWorkingPsdPublicationSource(wait) { const prepare = prepareWorkingPsdReconciliation, digest = getAddFilesCurrentSourceDigest; let prepared = false; prepareWorkingPsdReconciliation = async (...args) => { const result = await prepare(...args); prepared = true; return result; }; getAddFilesCurrentSourceDigest = async (...args) => { if (prepared) { prepared = false; await wait(); } return digest(...args); }; return () => { prepareWorkingPsdReconciliation = prepare; getAddFilesCurrentSourceDigest = digest; }; },\n' +
  '  forceWorkingPsdPendingAdmission() { const stage = stageLiveObservedFile; stageLiveObservedFile = (project, file, observation = {}) => stage(project, file, file.source === \'psd-embedded\' ? { ...observation, forcePending: true } : observation); return () => { stageLiveObservedFile = stage; }; },\n' +
  '  clearPsdParseDebounce(filePath) { psdParseDebounce.delete(filePath); },\n' +
  '  pollPsForProject, pollLsofForProject, runBackgroundWatcherOperation, projectHasUnresolvedLocalAssetBaseline,\n' +
  '  getIllustratorPollState(id) { return { scopeRevision: getIllustratorActivationScope(id)?.revision, inProgress: psInProgress.has(id) }; },\n' +
  '  getScannedPaths(id) { return [...(scannedDesignFiles.get(id) || [])]; },\n' +
  '  isWatcherGenerationCurrent(projectId, generation) { return getWatcherCoordinator(projectId).isCurrent(projectId, generation); },\n' +
  '  captureProjectOperation,\n  runScanOnOpen');
// Exercise the actual retained parser and wire inspection in the complete main
// IPC/store route; the utility-process transport and Electron remain modeled.
replaceExactlyOnce('const fixture = structuredClone(currentPsdFixture);',
  "const fixture = currentPsdFixture === 'actual-source-buffer' ? null : structuredClone(currentPsdFixture);");
replaceExactlyOnce('                  psd: fixture,',
  "                  psd: fixture || originalLoad.call(Module, 'ag-psd/dist/index.js', module).readPsd(fs.readFileSync(filePath), { skipLayerImageData: true, skipCompositeImageData: true }),\n" +
  "                  framing: fixture ? undefined : require('../parsers/add-files-psd-worker').inspectPsdLinkFraming(fs.readFileSync(filePath)),");
// The main-process ag-psd boundary: a function fixture sees the bytes read; a
// test can opt in to decoding the actual bytes for the PSD it wrote.
replaceExactlyOnce("  readPsd: () => {\n    if (currentPsdFixture instanceof Error) throw currentPsdFixture;\n    if (typeof currentPsdFixture === 'function') return currentPsdFixture();",
  "  readPsd: (buffer, options) => {\n    if (globalThis.__crateRealMainPsdBytes && currentPsdFixture === 'actual-source-buffer' && Buffer.isBuffer(buffer)) return originalLoad.call(Module, 'ag-psd/dist/index.js', module).readPsd(buffer, options);\n    if (currentPsdFixture instanceof Error) throw currentPsdFixture;\n    if (typeof currentPsdFixture === 'function') return currentPsdFixture(buffer);");
// Locator refresh for proven renames, as in the working-file choice suite.
replaceExactlyOnce('  captureProjectOperation,\n  runScanOnOpen', '  applyLiveAppEvidenceRefresh, refreshWorkingSourceLocators,\n  captureProjectOperation,\n  runScanOnOpen');
const compiled = new Module(harnessPath, module);
compiled.filename = harnessPath;
compiled.paths = Module._nodeModulePaths(__dirname);
compiled._compile(harness + '\n(' + baselineCases.toString() + ')();\n(' + excludedSourceMembershipCases.toString() + ')();\n', harnessPath);

function baselineCases() {
  // V29 drives trusted account IPC into the real AccountSession.cancel and
  // main change listener. Only native/observer transport remains modeled.
  async function waitForRecoveryWatcher(f, previousCount) {
    await waitForCondition(() => watcherRecords.length === previousCount + 1 &&
      typeof watcherRecords.at(-1).handlers.change === 'function', 'exactly one replacement Watch subscription was not installed');
    await metadataTestHooks.waitForWatcherIdle(f.project.id);
    clearTrackedTimers();
    assert.equal(watcherRecords.length, previousCount + 1);
    return watcherRecords.at(-1);
  }
  for (const location of ['inside', 'outside']) {
    baselineTest(`v29 Watch recovery ${location}: trusted cancel replaces stale watcher and delivers current source changes`, { timeout: 20000 }, async () => {
      const f = await tildeWatchFixture(location, 'Recovery.ai');
      try {
        assert.ok(testAccountSession instanceof RealAccountSession);
        const old = f.watch, count = watcherRecords.length;
        const generation = testAccountSession.generation, identity = testAccountSession.snapshot().identity.id;
        const startedAt = f.current().watchStartedAt;
        const oldOperation = metadataTestHooks.captureProjectOperation(f.project.id);
        const oldSubscription = metadataTestHooks.getAcceptedSourceWatchSnapshot(f.project.id);
        const review = await callIpcRaw('projects:prepare-package-review', f.project.id);
        assert.ok(review.token, JSON.stringify(review));
        const result = await callIpcRaw('account:cancel');
        assert.equal(result.state, 'offline'); assert.equal(result.canUseWorkspace, true);
        assert.equal(result.identity.id, identity); assert.equal(testAccountSession.generation, generation + 1);
        assert.equal(old.closed, true, 'obsolete Watch retired synchronously before cancel returns');
        assert.equal(oldOperation.current(), false);
        assert.equal(metadataTestHooks.getPackageReviewState().tokens.includes(review.token), false);
        const currentWatch = await waitForRecoveryWatcher(f, count);
        const currentSubscription = metadataTestHooks.getAcceptedSourceWatchSnapshot(f.project.id);
        assert.notEqual(currentSubscription.activationToken, oldSubscription.activationToken);
        assert.equal(currentSubscription.accountGeneration, testAccountSession.generation);
        assert.equal(f.current().watchStartedAt, startedAt);
        assert.equal(storeInstance.data.projects.filter(p => p.status === 'watching').length, 1);
        assert.equal(watcherRecords.filter(record => !record.closed).length, 1);
        assert.equal(tildeCoverage(f).status, location === 'inside' ? 'default-root' : 'exact-enrolled');
        assert.equal(currentWatch.addedPaths.has(f.source), location === 'outside');
        const x = path.join(TEST_HOME, 'Desktop', 'Recovery-X.png'); fs.writeFileSync(x, 'recovered source dependency');
        fs.writeFileSync(f.source, `%PDF-1.7\n${f.paths[0].link}\n${x}\n%%EOF\n`);
        const before = JSON.stringify(f.current());
        await old.handlers.add(f.source); await old.handlers.change(f.source, fs.statSync(f.source));
        await drainTildeScan(f);
        assert.equal(JSON.stringify(f.current()), before, 'retired callbacks remain unable to mutate after recovery');
        await currentWatch.handlers.change(f.source, fs.statSync(f.source)); await drainTildeScan(f);
        assert.equal(metadataTestHooks.getWorkingSourceVerification(f.current(), f.row()).sourceFingerprint,
          crypto.createHash('sha256').update(fs.readFileSync(f.source)).digest('hex'));
        assert.equal(f.current().files.filter(row => row.path === x).length, 1);
        assert.equal(f.current().files.filter(row => row.path === f.paths[0].link).length, 1, 'independent prior asset remains');
        assert.equal(watcherRecords.length, count + 1, 'delivery cannot create a second replacement');
      } finally { await callIpcRaw('projects:pause', f.project.id); await f.cleanup(); }
    });
  }
  baselineTest('v29 Watch recovery: current default-root add admits once while retired add stays rejected', { timeout: 15000 }, async () => {
    const f = await fixture({ structuredLinks: false });
    try {
      const old = watcherRecords.at(-1), count = watcherRecords.length;
      const startedAt = (await f.current()).watchStartedAt;
      await callIpcRaw('account:cancel');
      const current = await waitForRecoveryWatcher(f, count);
      await waitForCondition(() => Date.now() > startedAt, 'fixture clock did not advance');
      const source = path.join(TEST_HOME, 'Desktop', 'Recovery-New.ai');
      writeSyntheticAiFile(source, f.paths[0].link);
      const before = JSON.stringify(storeInstance.data.projects);
      await old.handlers.add(source); assert.equal(JSON.stringify(storeInstance.data.projects), before);
      await current.handlers.add(source); await metadataTestHooks.waitForWatcherIdle(f.project.id);
      assert.equal((await f.current()).files.filter(row => row.path === source).length, 1);
      await current.handlers.add(source); await metadataTestHooks.waitForWatcherIdle(f.project.id);
      assert.equal((await f.current()).files.filter(row => row.path === source).length, 1);
    } finally { await callIpcRaw('projects:pause', f.project.id); await f.cleanup(); }
  });
  baselineTest('v29 Watch recovery: consecutive trusted cancels install only the latest activation', { timeout: 15000 }, async () => {
    const f = await tildeWatchFixture('outside', 'Rapid.ai');
    try {
      const count = watcherRecords.length, generation = testAccountSession.generation, start = f.current().watchStartedAt;
      const first = callIpcRaw('account:cancel'), second = callIpcRaw('account:cancel'), third = callIpcRaw('account:cancel');
      assert.equal(f.watch.closed, true);
      await Promise.all([first, second, third]);
      const current = await waitForRecoveryWatcher(f, count);
      assert.equal(testAccountSession.generation, generation + 3);
      assert.equal(metadataTestHooks.getAcceptedSourceWatchSnapshot(f.project.id).accountGeneration, generation + 3);
      assert.equal(f.current().watchStartedAt, start);
      assert.equal(current.addedPaths.has(f.source), true);
      assert.equal(watcherRecords.filter(record => !record.closed).length, 1);
    } finally { await callIpcRaw('projects:pause', f.project.id); await f.cleanup(); }
  });
  baselineTest('v29 Watch recovery: retired coordinator ticket remains stale through held operation drain', { timeout: 15000 }, async () => {
    const f = await tildeWatchFixture('inside', 'Drain.ai'), gate = deferred();
    let running, oldTicketGeneration, retiredCurrent, entered = false;
    try {
      const operation = metadataTestHooks.captureProjectOperation(f.project.id), count = watcherRecords.length;
      running = metadataTestHooks.runBackgroundWatcherOperation(f.project.id, 'v29-held', async generation => {
        oldTicketGeneration = generation; entered = true; await gate.promise;
        retiredCurrent = metadataTestHooks.isWatcherGenerationCurrent(f.project.id, generation);
        assert.equal(operation.current(), false);
      });
      await waitForCondition(() => entered, 'held coordinator operation did not start');
      await callIpcRaw('account:cancel');
      assert.equal(f.watch.closed, true);
      assert.equal(operation.current(), false);
      assert.equal(metadataTestHooks.isWatcherGenerationCurrent(f.project.id, oldTicketGeneration), false);
      assert.equal(metadataTestHooks.getWatcherCoordinatorSnapshot(f.project.id).running, true, 'retirement preserves the owned drain');
      gate.release(); await running;
      await waitForRecoveryWatcher(f, count);
      await waitForCondition(() => metadataTestHooks.getWatcherCoordinatorSnapshot(f.project.id).pendingKinds.length === 0,
        'replacement coordinator deferred work did not drain');
      assert.equal(retiredCurrent, false);
      assert.equal(metadataTestHooks.getWatcherCoordinatorSnapshot(f.project.id).running, false);
      assert.equal(metadataTestHooks.isWatcherGenerationCurrent(f.project.id, oldTicketGeneration), false);
      assert.equal(tildeCoverage(f).status, 'default-root');
    } finally { gate.release(); if (running) await running; await callIpcRaw('projects:pause', f.project.id); await f.cleanup(); }
  });
  for (const location of ['inside', 'outside']) {
    baselineTest(`v29 Watch recovery ${location}: in-flight old source scan cannot publish across trusted cancel`, { timeout: 20000 }, async () => {
      const f = await tildeWatchFixture(location, 'Held.ai'), gate = deferred();
      const read = fs.promises.readFile;
      let entered = false, changing;
      try {
        const oldFingerprint = metadataTestHooks.getWorkingSourceVerification(f.current(), f.row()).sourceFingerprint;
        const x = path.join(TEST_HOME, 'Desktop', 'Held-X.png'); fs.writeFileSync(x, 'late old dependency');
        fs.writeFileSync(f.source, `%PDF-1.7\n${f.paths[0].link}\n${x}\n%%EOF\n`);
        fs.promises.readFile = async function holdFirstSourceRead(candidate, ...args) {
          if (!entered && path.resolve(candidate) === f.source) { entered = true; await gate.promise; }
          return read.call(fs.promises, candidate, ...args);
        };
        changing = f.watch.handlers.change(f.source, fs.statSync(f.source));
        await waitForCondition(() => entered, 'old current-byte scan did not reach held read');
        const count = watcherRecords.length;
        await callIpcRaw('account:cancel'); assert.equal(f.watch.closed, true);
        const current = await waitForRecoveryWatcher(f, count);
        const before = JSON.stringify(f.current());
        gate.release(); await changing; await drainTildeScan(f);
        assert.equal(JSON.stringify(f.current()), before, 'old parser completion cannot overwrite replacement activation');
        assert.equal(f.current().files.some(row => row.path === x), false);
        assert.equal(metadataTestHooks.getWorkingSourceVerification(f.current(), f.row()).sourceFingerprint, oldFingerprint);
        await current.handlers.change(f.source, fs.statSync(f.source)); await drainTildeScan(f);
        assert.equal(f.current().files.filter(row => row.path === x).length, 1);
        assert.equal(metadataTestHooks.getWorkingSourceVerification(f.current(), f.row()).sourceFingerprint,
          crypto.createHash('sha256').update(fs.readFileSync(f.source)).digest('hex'));
      } finally {
        gate.release(); if (changing) await changing; fs.promises.readFile = read;
        await callIpcRaw('projects:pause', f.project.id); await f.cleanup();
      }
    });
  }
  baselineTest('v29 Watch recovery: cancel without valid access retires Watch until subsequent authorization', { timeout: 15000 }, async () => {
    const f = await tildeWatchFixture('outside', 'Expired.ai'), now = testAccountSession.now;
    try {
      const count = watcherRecords.length, startedAt = f.current().watchStartedAt;
      testAccountSession.now = () => testAccountSession.accessExpiresAt;
      const result = await callIpcRaw('account:cancel');
      assert.equal(result.canUseWorkspace, false); assert.equal(f.watch.closed, true);
      assert.equal(metadataTestHooks.getAcceptedSourceWatchSnapshot(f.project.id), null);
      assert.equal(metadataTestHooks.getActiveWatchingActivationToken(f.project.id), null);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(watcherRecords.length, count);
      testAccountSession.now = now; await testAccountSession.restore();
      const current = await waitForRecoveryWatcher(f, count);
      assert.equal(current.addedPaths.has(f.source), true); assert.equal(f.current().watchStartedAt, startedAt);
    } finally { testAccountSession.now = now; await callIpcRaw('projects:pause', f.project.id); await f.cleanup(); }
  });

  baselineTest('v29 Watch recovery: real same-generation refresh keeps current watcher and consent', { timeout: 15000 }, async () => {
    const provider = testAccountSession.provider, credentials = testAccountSession.credentials;
    const identity = { id: '11111111-1111-4111-8111-111111111111', email: 'fixture@example.invalid', verified: true, methods: [] };
    testAccountSession.record = { identity, refreshToken: 'modeled-refresh' };
    testAccountSession.publish('signed_in', '', identity);
    const f = await tildeWatchFixture('outside', 'Refresh.ai');
    try {
      const count = watcherRecords.length, generation = testAccountSession.generation;
      const subscription = metadataTestHooks.getAcceptedSourceWatchSnapshot(f.project.id);
      const review = await callIpcRaw('projects:prepare-package-review', f.project.id); assert.ok(review.token);
      let refreshes = 0;
      testAccountSession.provider = {
        async refresh() { refreshes++; return { access_token: 'modeled-current', refresh_token: 'modeled-rotated' }; },
        async validate() { return { subject: identity.id, expiresAt: Date.now() + 3600000 }; },
        async me() { return identity; },
      };
      testAccountSession.credentials = { write() {} };
      assert.equal((await callIpcRaw('account:refresh')).canUseWorkspace, true);
      assert.equal(refreshes, 1); assert.equal(testAccountSession.generation, generation);
      assert.equal(f.watch.closed, false); assert.equal(watcherRecords.length, count);
      assert.deepEqual(metadataTestHooks.getAcceptedSourceWatchSnapshot(f.project.id), subscription);
      assert.equal(metadataTestHooks.getPackageReviewState().tokens.includes(review.token), true);
      fs.writeFileSync(f.source, `%PDF-1.7\n${f.paths[0].link}\n% refreshed current bytes\n%%EOF\n`);
      await f.watch.handlers.change(f.source, fs.statSync(f.source)); await drainTildeScan(f);
      assert.equal(metadataTestHooks.getWorkingSourceVerification(f.current(), f.row()).sourceFingerprint,
        crypto.createHash('sha256').update(fs.readFileSync(f.source)).digest('hex'));
    } finally {
      testAccountSession.provider = provider; testAccountSession.credentials = credentials;
      await callIpcRaw('projects:pause', f.project.id); await testAccountSession.restore(); await f.cleanup();
    }
  });
  baselineTest('v29 Watch recovery: trusted cancel refuses old review before output and does not resume paused project', async () => {
    const f = await makeSessionTokenFixture();
    try {
      const review = await f.review(); assert.ok(review.token);
      const count = watcherRecords.length, generation = testAccountSession.generation;
      const cancelled = await callIpcRaw('account:cancel'); assert.equal(cancelled.canUseWorkspace, true);
      assert.equal(testAccountSession.generation, generation + 1);
      await assertSessionTokenDeniedBeforeOutput(f, review.token);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(watcherRecords.length, count); assert.equal(watcherRecords.filter(row => !row.closed).length, 0);
    } finally { f.cleanup(); }
  });

  // V25 uses Add Files to admit the named source. Only app/session/chokidar
  // transport is modeled; these execute the complete production main callbacks
  // and DTO together and do not claim native filesystem event delivery.
  async function tildeWatchFixture(location, name = 'Design~.ai', engageSelection = true) {
    const f = await fixture({ sourceNames: [name], structuredLinks: false });
    if (location === 'outside') {
      const outside = path.join(TEST_HOME, 'Tilde-outside'); fs.mkdirSync(outside, { recursive: true });
      const moved = path.join(outside, name); fs.renameSync(f.paths[0].source, moved); f.paths[0].source = moved;
    }
    const source = f.paths[0].source;
    manualDialogFor([source]);
    assert.ok(Array.isArray(await callIpcRaw('projects:add-files', f.project.id, crypto.randomUUID())));
    assert.equal((await callIpcRaw('projects:set-existing-assets-decision', f.project.id, 'include')).success, true);
    f.state.opened = true; await f.live(); clearTrackedTimers();
    await metadataTestHooks.waitForWatcherIdle(f.project.id); clearTrackedTimers();
    const current = () => storeInstance.data.projects.find(p => p.id === f.project.id);
    const row = () => current().files.find(item => item.path === source);
    assert.ok(row(), 'source is actually accepted through Add Files');
    assert.equal(metadataTestHooks.getWorkingSourceVerification(current(), row()).status, 'scanned');
    if (engageSelection) {
      // Current-byte package blocking and strict publication apply after source
      // selection is engaged. Establish that production contract through IPC,
      // rather than attributing legacy lenient capture to the strict route.
      for (const action of ['exclude', 'restore']) {
        const dto = (await callIpcRaw('projects:get-asset-workspace', f.project.id)).files.find(item => item.name === name);
        const result = await callIpcRaw('projects:set-working-source-selection', f.project.id, dto.visualIdentity,
          { action, expectedRevision: dto.selectionRevision });
        assert.equal(result.success, true, JSON.stringify(result));
      }
      assert.equal(metadataTestHooks.getWorkingSourceVerification(current(), row()).status, 'scanned');
      assert.equal(metadataTestHooks.getWorkingSourceMembership(current()).blocked, false);
    }
    return { ...f, source, current, row, watch: watcherRecords.at(-1) };
  }
  const tildeCoverage = f => metadataTestHooks.getWorkingSourceWatchCoverage(f.current(), f.row(),
    metadataTestHooks.getWorkingSourceMembership(f.current()));
  async function drainTildeScan(f) {
    await metadataTestHooks.waitForWatcherIdle(f.project.id);
    await waitForCondition(() => metadataTestHooks.getWorkingScanLifetime().operations === 0, 'tilde source scan did not drain');
    clearTrackedTimers();
  }
  baselineTest('v25 tilde Watch inside: legacy accepted folder change route also has honest coverage', { timeout: 15000 }, async () => {
    const f = await tildeWatchFixture('inside', 'Design~.ai', false);
    try {
      assert.equal(f.current().workingSourceSelections, undefined);
      const x = path.join(TEST_HOME, 'Desktop', 'Legacy-X.png'); fs.writeFileSync(x, 'legacy tilde X');
      fs.writeFileSync(f.source, `%PDF-1.7\n${f.paths[0].link}\n${x}\n%%EOF\n`);
      await f.watch.handlers.change(f.source, fs.statSync(f.source)); await drainTildeScan(f);
      assert.equal(f.current().files.filter(row => row.path === x).length, 1);
      assert.equal(metadataTestHooks.getWorkingSourceVerification(f.current(), f.row()).sourceFingerprint,
        crypto.createHash('sha256').update(fs.readFileSync(f.source)).digest('hex'));
      assert.deepEqual(tildeCoverage(f), { status: 'default-root', reason: 'default-root-eligible', nativeDelivery: 'unverified' });
      const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      assert.deepEqual(workspace.files.find(row => row.name === 'Design~.ai').watchCoverage, tildeCoverage(f));
      assert.equal(f.watch.addedPaths.has(f.source), false);
    } finally { await callIpcRaw('projects:pause', f.project.id); await f.cleanup(); }
  });
  for (const location of ['inside', 'outside']) {
    baselineTest(`v25 tilde Watch ${location}: accepted source change callback and DTO agree without expanding add or exact enrollment`, { timeout: 15000 }, async () => {
      const f = await tildeWatchFixture(location);
      try {
        assert.equal(f.watch.addedPaths.has(f.source), false, 'tilde source never gains exact enrollment');
        const beforeAdd = JSON.stringify(f.current());
        await f.watch.handlers.add(f.source);
        assert.equal(JSON.stringify(f.current()), beforeAdd, 'existing add-name filter is retained');
        const before = metadataTestHooks.getWorkingSourceVerification(f.current(), f.row()).sourceFingerprint;
        const x = path.join(TEST_HOME, 'Desktop', 'Tilde-X.png'); fs.writeFileSync(x, 'new tilde X');
        fs.writeFileSync(f.source, `%PDF-1.7\n${f.paths[0].link}\n${x}\n%%EOF\n`);
        const digest = crypto.createHash('sha256').update(fs.readFileSync(f.source)).digest('hex');
        await f.watch.handlers.change(f.source, fs.statSync(f.source));
        await drainTildeScan(f);
        if (location === 'inside') {
          assert.equal(metadataTestHooks.getWorkingSourceVerification(f.current(), f.row()).sourceFingerprint, digest,
            'existing folder callback scans accepted tilde source current bytes');
          assert.equal(f.current().files.filter(row => row.path === x).length, 1);
        } else {
          assert.equal(metadataTestHooks.getWorkingSourceVerification(f.current(), f.row()).sourceFingerprint, before);
          assert.equal(f.current().files.some(row => row.path === x), false, 'outside unregistered callback cannot admit X');
          assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).token, undefined,
            'changed source bytes still block stale package review');
        }
        const expected = location === 'inside'
          ? { status: 'default-root', reason: 'default-root-eligible', nativeDelivery: 'unverified' }
          : { status: 'ignored', reason: 'event-name-ignored', nativeDelivery: 'unverified' };
        assert.deepEqual(tildeCoverage(f), expected);
        const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        assert.deepEqual(workspace.files.find(row => row.name === 'Design~.ai').watchCoverage, expected);
        assert.equal(metadataTestHooks.getWorkingScanLifetime().leases, 0);
      } finally { await callIpcRaw('projects:pause', f.project.id); await f.cleanup(); }
    });
  }
  for (const location of ['inside', 'outside']) {
    baselineTest(`v25 tilde Watch ${location}: temporary prefix remains ignored by change callback and DTO`, { timeout: 15000 }, async () => {
      const f = await tildeWatchFixture(location, '~$Temporary.ai');
      try {
        const before = JSON.stringify(f.current());
        fs.appendFileSync(f.source, 'temporary changed bytes');
        await f.watch.handlers.add(f.source); await f.watch.handlers.change(f.source, fs.statSync(f.source));
        await drainTildeScan(f);
        assert.equal(JSON.stringify(f.current()), before);
        assert.equal(f.watch.addedPaths.has(f.source), false);
        assert.deepEqual(tildeCoverage(f), { status: 'ignored', reason: 'event-name-ignored', nativeDelivery: 'unverified' });
        const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        assert.equal(workspace.files.find(row => row.name === '~$Temporary.ai').watchCoverage.status, 'ignored');
      } finally { await callIpcRaw('projects:pause', f.project.id); await f.cleanup(); }
    });
  }
  for (const invalidation of ['membership', 'account', 'activation', 'changed-bytes']) {
    baselineTest(`v25 tilde Watch inside: held current-byte scan cannot publish after ${invalidation}`, { timeout: 15000 }, async () => {
      const f = await tildeWatchFixture('inside'), gate = deferred(), priorRead = fs.promises.readFile;
      let entered = false, saving;
      try {
        assert.deepEqual(tildeCoverage(f), { status: 'default-root', reason: 'default-root-eligible', nativeDelivery: 'unverified' });
        const beforeFingerprint = metadataTestHooks.getWorkingSourceVerification(f.current(), f.row()).sourceFingerprint;
        const x = path.join(TEST_HOME, 'Desktop', 'Refused-X.png'); fs.writeFileSync(x, 'refused tilde X');
        fs.writeFileSync(f.source, `%PDF-1.7\n${f.paths[0].link}\n${x}\n%%EOF\n`);
        fs.promises.readFile = async function heldTildeSource(filePath, ...args) {
          if (!entered && path.resolve(filePath) === f.source) { entered = true; await gate.promise; }
          return priorRead.call(fs.promises, filePath, ...args);
        };
        saving = f.watch.handlers.change(f.source, fs.statSync(f.source));
        await waitForCondition(() => entered, 'tilde scan did not reach the current source read');
        if (invalidation === 'membership') {
          const dto = (await callIpcRaw('projects:get-asset-workspace', f.project.id)).files.find(row => row.name === 'Design~.ai');
          const result = await callIpcRaw('projects:set-working-source-selection', f.project.id, dto.visualIdentity,
            { action: 'exclude', expectedRevision: dto.selectionRevision });
          assert.equal(result.success, true, JSON.stringify(result));
          assert.equal(tildeCoverage(f).status, 'not-included');
        }
        if (invalidation === 'account') { testAccountSession.generation++; assert.equal(tildeCoverage(f).reason, 'stale-account'); }
        if (invalidation === 'activation') {
          await callIpcRaw('projects:pause', f.project.id);
          assert.equal(tildeCoverage(f).status, 'inactive');
          await callIpcRaw('projects:start-watching', f.project.id); clearTrackedTimers();
          assert.deepEqual(tildeCoverage(f), { status: 'default-root', reason: 'default-root-eligible', nativeDelivery: 'unverified' });
        }
        if (invalidation === 'changed-bytes') fs.appendFileSync(f.source, 'changed during source read');
        const retired = JSON.stringify(f.current());
        gate.release(); await saving; await drainTildeScan(f);
        assert.equal(f.current().files.some(row => row.path === x), false);
        assert.equal(f.current().pendingFiles.some(row => row.path === x), false);
        if (invalidation !== 'changed-bytes') assert.equal(JSON.stringify(f.current()), retired, 'retired work cannot overwrite current intent/lifetime');
        assert.equal(metadataTestHooks.getWorkingSourceVerification(f.current(), f.row())?.sourceFingerprint, beforeFingerprint);
        assert.equal(metadataTestHooks.getWorkingScanLifetime().leases, 0);
      } finally {
        gate.release(); if (saving) await saving; fs.promises.readFile = priorRead;
        await testAccountSession.restore(); await callIpcRaw('projects:pause', f.project.id); await f.cleanup();
      }
    });
  }

  // Seed accepted fixture rows only for capacity/configuration tests; ordinary
  // B admission and saved-X composition remain the real IPC cases below.
  async function watchCapacityFixture(count) {
    const f = await fixture({ sourceNames: ['A.ai'], structuredLinks: false });
    const outside = path.join(TEST_HOME, 'Watch-capacity'); fs.mkdirSync(outside, { recursive: true });
    const source = path.join(outside, 'Source_000.ai');
    fs.renameSync(f.paths[0].source, source); f.paths[0].source = source;
    manualDialogFor([source]);
    assert.ok(Array.isArray(await callIpcRaw('projects:add-files', f.project.id, crypto.randomUUID())));
    assert.equal((await callIpcRaw('projects:set-existing-assets-decision', f.project.id, 'include')).success, true);
    const current = () => storeInstance.data.projects.find(p => p.id === f.project.id);
    const template = current().files.find(row => row.path === source); assert.ok(template);
    const sources = [source];
    for (let i = 1; i < count; i++) {
      const sourcePath = path.join(outside, `Source_${String(i).padStart(3, '0')}.ai`);
      fs.writeFileSync(sourcePath, '%PDF-1.7\n%%EOF\n');
      current().files.push({ ...template, path: sourcePath, name: path.basename(sourcePath) });
      sources.push(sourcePath);
    }
    metadataTestHooks.syncAcceptedSourceWatchSubscriptions(f.project.id);
    return { ...f, current, outside, sources, template };
  }
  for (const count of [255, 256, 257]) {
    baselineTest(`v23 Watch coverage ${count}: authoritative limit and row reorder stability`, { timeout: 20000 }, async () => {
      const f = await watchCapacityFixture(count);
      try {
        const watch = watcherRecords.at(-1);
        assert.equal(watch.addedPaths.size, Math.min(count, 256));
        const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        const rows = workspace.files.filter(row => row.ext === '.ai');
        assert.equal(rows.length, count);
        assert.equal(rows.filter(row => row.watchCoverage.status === 'exact-enrolled').length, Math.min(count, 256));
        assert.equal(rows.filter(row => row.watchCoverage.status === 'cap-limited').length, Math.max(0, count - 256));
        assert.equal(workspace.watchCoverage.exactPathLimit, 256);
        assert.equal(workspace.watchCoverage.nativeDelivery, 'unverified');
        assert.ok(rows.every(row => row.watchCoverage.nativeDelivery === 'unverified'));
        const paths = [...watch.addedPaths];
        f.current().files.reverse();
        metadataTestHooks.syncAcceptedSourceWatchSubscriptions(f.project.id);
        assert.deepEqual([...watch.addedPaths], paths, 'reorder cannot displace valid enrollments');
        assert.equal(watch.retiredPaths.size, 0);
        const included = await metadataTestHooks.selectProjectFilesForPackaging(f.current());
        assert.equal(included.filter(row => row.ext === '.ai').length, count, 'cap does not drop accepted package members');
        const review = await callIpcRaw('projects:prepare-package-review', f.project.id);
        assert.ok(review.token, JSON.stringify(review));
        if (count === 257) {
          for (const name of ['ZZZ-wait.ai', 'AAA-wait.ai']) {
            const source = path.join(f.outside, name); fs.writeFileSync(source, '%PDF-1.7\n%%EOF\n');
            f.current().files.unshift({ ...f.template, path: source, name });
          }
          metadataTestHooks.syncAcceptedSourceWatchSubscriptions(f.project.id);
          assert.deepEqual([...watch.addedPaths], paths, 'new waiting rows cannot evict valid subscriptions');
          f.current().files = f.current().files.filter(row => row.path !== f.sources[100]);
          metadataTestHooks.syncAcceptedSourceWatchSubscriptions(f.project.id);
          assert.equal(watch.addedPaths.size, 256);
          assert.equal(watch.retiredPaths.has(f.sources[100]), true);
          assert.equal(watch.addedPaths.has(path.join(f.outside, 'AAA-wait.ai')), true, 'lexical physical-path order picks first current waiter');
          assert.equal(watch.addedPaths.has(f.sources[256]), false);
          assert.equal(watch.addedPaths.has(path.join(f.outside, 'ZZZ-wait.ai')), false);
        }
      } finally { await callIpcRaw('projects:pause', f.project.id); await f.cleanup(); }
    });
  }
  baselineTest('v23 Watch coverage appended B: required A retains slot and actual vacancy promotes B saved X', { timeout: 30000 }, async () => {
    const f = await fixture({ sources: 3, sourceNames: ['A.ai', 'C.ai', 'D.ai'], structuredLinks: false });
    const [a, c, d] = f.paths;
    const outside = path.join(TEST_HOME, 'Coverage-composition'); fs.mkdirSync(outside, { recursive: true });
    for (const p of f.paths) { const moved = path.join(outside, path.basename(p.source)); fs.renameSync(p.source, moved); p.source = moved; }
    const shared = path.join(outside, 'Shared.png'); fs.writeFileSync(shared, 'shared coverage bytes');
    const write = (source, links) => fs.writeFileSync(source, `%PDF-1.7\n${links.join('\n')}\n%%EOF\n`);
    write(a.source, [a.link, shared]); write(c.source, [c.link, shared, a.source]); write(d.source, [d.link, shared]);
    const current = () => storeInstance.data.projects.find(p => p.id === f.project.id);
    const choose = async source => {
      const row = (await callIpcRaw('projects:get-asset-workspace', f.project.id)).files.find(item => item.name === path.basename(source));
      const result = await callIpcRaw('projects:set-working-source-selection', f.project.id, row.visualIdentity,
        { action: 'exclude', expectedRevision: row.selectionRevision });
      assert.equal(result.success, true, JSON.stringify(result));
    };
    try {
      manualDialogFor(f.paths.map(p => p.source));
      assert.ok(Array.isArray(await callIpcRaw('projects:add-files', f.project.id, crypto.randomUUID())));
      assert.equal((await callIpcRaw('projects:set-existing-assets-decision', f.project.id, 'include')).success, true);
      const template = current().files.find(row => row.path === d.source);
      f.state.opened = true; await f.live(); clearTrackedTimers();
      await metadataTestHooks.waitForWatcherIdle(f.project.id); clearTrackedTimers();
      const fillers = [];
      for (let i = 0; i < 253; i++) {
        const source = path.join(outside, `Filler_${String(i).padStart(3, '0')}.ai`); fs.writeFileSync(source, '%PDF-1.7\n%%EOF\n');
        current().files.push({ ...template, path: source, name: path.basename(source) }); fillers.push(source);
      }
      metadataTestHooks.syncAcceptedSourceWatchSubscriptions(f.project.id);
      const watch = watcherRecords.at(-1); assert.equal(watch.addedPaths.size, 256);
      const b = path.join(outside, 'B.ai'); write(b, [a.link, shared]);
      // Use the existing ordinary DOC transition producer, as the V22 composed
      // route does; do not introduce an uncontrolled concurrent manual poll.
      f.paths[0] = { source: b, link: a.link }; await f.live(); clearTrackedTimers();
      const bRow = current().files.find(row => row.path === b);
      assert.ok(bRow, 'ordinary producer admits saved B after the first 256');
      assert.equal(metadataTestHooks.getWorkingSourceVerification(current(), bRow).status, 'scanned');
      const aBytes = fs.readFileSync(a.source), cd = JSON.stringify([c,d].map(p => current().files.find(row => row.path === p.source)));
      await choose(a.source);
      let workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      const aDto = workspace.files.find(row => row.name === 'A.ai');
      assert.equal(aDto.sourceSelection, 'excluded'); assert.equal(aDto.includedAsDependency, true);
      assert.equal(aDto.watchCoverage.status, 'exact-enrolled');
      assert.equal(workspace.files.find(row => row.name === 'B.ai').watchCoverage.status, 'cap-limited');
      const x = path.join(outside, 'X.png'); fs.writeFileSync(x, 'new B linked X'); write(b, [a.link, shared, x]);
      const before = metadataTestHooks.getWorkingSourceVerification(current(), bRow).sourceFingerprint;
      await watch.handlers.change(b, fs.statSync(b));
      assert.equal(metadataTestHooks.getWorkingSourceVerification(current(), bRow).sourceFingerprint, before, 'unenrolled callback has no authority');
      assert.equal(current().files.some(row => row.path === x), false);
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).token, undefined, 'changed B still blocks stale package');
      await choose(fillers[0]);
      assert.equal(watch.addedPaths.has(fillers[0]), false); assert.equal(watch.retiredPaths.has(fillers[0]), true);
      assert.equal(watch.addedPaths.has(b), true); assert.equal(watch.addedPaths.size, 256);
      await watch.handlers.change(b, fs.statSync(b));
      const digest = crypto.createHash('sha256').update(fs.readFileSync(b)).digest('hex');
      await waitForCondition(() => metadataTestHooks.getWorkingSourceVerification(current(), bRow)?.sourceFingerprint === digest,
        'promoted B save did not refresh bytes');
      await metadataTestHooks.waitForWatcherIdle(f.project.id); clearTrackedTimers();
      assert.equal(current().files.filter(row => row.path === x).length, 1);
      workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      assert.equal(workspace.files.find(row => row.name === 'B.ai').watchCoverage.status, 'exact-enrolled');
      assert.equal(workspace.files.find(row => row.name === path.basename(fillers[0])).watchCoverage.status, 'not-included');
      const selected = await metadataTestHooks.selectProjectFilesForPackaging(current());
      for (const p of [a.source, b, c.source, d.source, shared, x]) assert.ok(selected.some(row => row.path === p), p);
      assert.equal(selected.filter(row => row.path === shared).length, 1);
      assert.deepEqual(fs.readFileSync(a.source), aBytes);
      assert.equal(JSON.stringify([c,d].map(p => current().files.find(row => row.path === p.source))), cd);
      await callIpcRaw('projects:pause', f.project.id);
      assert.equal(metadataTestHooks.getAcceptedSourceWatchSnapshot(f.project.id), null);
      assert.equal((await callIpcRaw('projects:get-asset-workspace', f.project.id)).files.find(row => row.name === 'B.ai').watchCoverage.status, 'inactive');
    } finally { await callIpcRaw('projects:pause', f.project.id); await f.cleanup(); }
  });
  baselineTest('v23 Watch coverage DTO: default roots unsupported ignored unavailable pending enrollment failure', async () => {
    const f = await watchCapacityFixture(1);
    try {
      const watch = watcherRecords.at(-1), project = f.current();
      const make = (name, folder = f.outside) => {
        fs.mkdirSync(folder, { recursive: true }); const filePath = path.join(folder, name);
        fs.writeFileSync(filePath, '%PDF-1.7\n%%EOF\n');
        const row = { ...f.template, path: filePath, name, ext: path.extname(name), projectRole: 'source' }; project.files.push(row); return row;
      };
      const root = make('Root.ai', path.join(TEST_HOME, 'Desktop'));
      const deep = make('Deep.ai', path.join(TEST_HOME, 'Desktop', 'one', 'two', 'three', 'four'));
      const ignored = make('Dot.ai', path.join(f.outside, '.hidden'));
      const modules = make('Modules.ai', path.join(f.outside, 'node_modules'));
      const temp = make('Backup~.ai');
      const unsupported = make('Unsupported.eps');
      const missing = make('Missing.ai'); fs.unlinkSync(missing.path);
      const hard = make('Hard.ai'); fs.linkSync(hard.path, hard.path + '.copy');
      const directory = make('Directory.key'); fs.unlinkSync(directory.path); fs.mkdirSync(directory.path);
      const symlink = make('Symlink.ai'); fs.unlinkSync(symlink.path); fs.symlinkSync(root.path, symlink.path);
      const pending = make('Pending.ai'); project.files.pop(); project.pendingFiles.push(pending);
      metadataTestHooks.syncAcceptedSourceWatchSubscriptions(f.project.id);
      const coverage = row => metadataTestHooks.getWorkingSourceWatchCoverage(project, row, metadataTestHooks.getWorkingSourceMembership(project));
      for (const [row, status, reason] of [[root,'default-root','default-root-eligible'], [deep,'exact-enrolled','exact-path-enrolled'],
        [ignored,'ignored','watcher-ignored'], [modules,'ignored','watcher-ignored'], [temp,'ignored','event-name-ignored'],
        [unsupported,'unsupported','format-unsupported'], [missing,'unavailable','source-unavailable'],
        [hard,'unsupported','source-hard-linked'], [directory,'unsupported','source-not-regular'], [symlink,'unsupported','source-symlink']]) {
        assert.deepEqual(coverage(row), { status, reason, nativeDelivery: 'unverified' });
      }
      assert.equal(metadataTestHooks.getWorkingSourceWatchCoverage(project, pending, metadataTestHooks.getWorkingSourceMembership(project), true).status, 'not-admitted');
      const failed = make('Failed.ai'), subscription = metadataTestHooks.getAcceptedSourceWatchSnapshot(f.project.id);
      assert.ok(subscription);
      // Registration request failure is modeled; it never grants event authority.
      metadataTestHooks.failAcceptedSourceWatchAdd(f.project.id, failed.path);
      metadataTestHooks.syncAcceptedSourceWatchSubscriptions(f.project.id);
      assert.deepEqual(coverage(failed), { status: 'unavailable', reason: 'enrollment-failed', nativeDelivery: 'unverified' });
      assert.equal(watch.addedPaths.has(failed.path), false);
    } finally { await callIpcRaw('projects:pause', f.project.id); await f.cleanup(); }
  });
  for (const reconciled of [false, true]) {
    baselineTest(`v23 Watch coverage manual-at-cap ${reconciled ? 'reconciled seeded scope admission' : 'unreconciled fixture cancellation diagnostic'}`, { timeout: 20000 }, async () => {
      const f = await watchCapacityFixture(256), trace = [];
      let restore;
      try {
        await metadataTestHooks.waitForWatcherIdle(f.project.id); clearTrackedTimers();
        if (reconciled) { f.state.opened = true; await f.live(); clearTrackedTimers(); }
        const b = path.join(f.outside, 'B.ai'); fs.writeFileSync(b, `%PDF-1.7\n${f.paths[0].link}\n%%EOF\n`);
        const before = metadataTestHooks.getAcceptedSourceWatchSnapshot(f.project.id); assert.equal(before.paths.length, 256);
        restore = metadataTestHooks.traceWatchCoverageOperations(f.project.id, trace);
        manualDialogFor([b]); const result = await callIpcRaw('projects:add-files', f.project.id, crypto.randomUUID());
        restore(); restore = null;
        if (!reconciled) {
          // This diagnosis retains the original successful-admission expectation
          // as failed evidence; it proves why these direct fixture seeds cancel
          // that attempt. It is not a passing manual-admission product claim.
          assert.equal(result, null);
          const stale = trace.find(item => item.actual.scopeRevision > item.expected.scopeRevision); assert.ok(stale, JSON.stringify(trace));
          for (const field of ['activationToken','generation','accountGeneration','status']) assert.equal(stale.actual[field], stale.expected[field], field);
          // Scope keys are normalized physical paths; the diagnostic's first
          // comparison incorrectly used the case-preserving fixture spelling.
          const normalizedSources = f.sources.map(p => fs.realpathSync.native(p).toLowerCase());
          assert.equal(stale.expected.admittedPaths.includes(normalizedSources[1]), false);
          assert.equal(stale.actual.admittedPaths.includes(normalizedSources[1]), true);
          assert.equal(stale.actual.admittedPaths.filter(p => normalizedSources.includes(p)).length, 256);
          console.log('V23_MANUAL_CAP_DIAGNOSIS ' + JSON.stringify({ classification: 'SCOPE_REVISION_CANCELLED_ORIGINAL_SEEDED_FIXTURE',
            expectedRevision: stale.expected.scopeRevision, actualRevision: stale.actual.scopeRevision,
            newlyAdmittedNames: stale.actual.admittedPaths.filter(p => !stale.expected.admittedPaths.includes(p)).map(p => path.basename(p)),
            retiredAdmittedNames: stale.expected.admittedPaths.filter(p => !stale.actual.admittedPaths.includes(p)).map(p => path.basename(p)),
            fillerAdmissionBefore: stale.expected.admittedPaths.includes(normalizedSources[1]), fillerAdmissionAfter: stale.actual.admittedPaths.includes(normalizedSources[1]),
            unchangedAccountActivationStatus: true, originalAdmissionSuccess: false }));
        } else {
          assert.ok(Array.isArray(result), JSON.stringify({ result, trace }));
          const row = f.current().files.find(row => row.path === b); assert.ok(row);
          assert.equal(metadataTestHooks.getWorkingSourceVerification(f.current(), row).status, 'scanned');
          const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
          assert.equal(workspace.files.find(row => row.name === 'B.ai').watchCoverage.status, 'cap-limited');
          assert.equal(watcherRecords.at(-1).addedPaths.has(b), false);
          const held = await callIpcRaw('projects:prepare-package-review', f.project.id);
          assert.equal(held.error, 'working_file_choice_required');
          assert.deepEqual(held.workingFileChoices.choices.map(row => row.source.name), ['B.ai']);
          const card = (await callIpcRaw('projects:get-asset-workspace', f.project.id)).workingFileChoices.choices[0];
          assert.ok(card.ready);
          assert.equal((await callIpcRaw('projects:resolve-working-file-choice', f.project.id,
            { id: card.id, revision: card.revision, choice: 'keep-both', predecessorIdentity: null })).success, true);
          assert.ok((await callIpcRaw('projects:prepare-package-review', f.project.id)).token, 'cap alone preserves current saved-source package eligibility');
          console.log('V23_MANUAL_CAP_RECONCILED ' + JSON.stringify({ admission: 'Add Files', priorExactPaths: 256,
            BAccepted: true, BScanned: true, coverage: 'cap-limited', validPackageReview: true, nativeDelivery: 'unverified' }));
        }
      } finally { restore?.(); await callIpcRaw('projects:pause', f.project.id); await f.cleanup(); }
    });
  }
  for (const invalidation of ['pause', 'project', 'activation', 'account', 'selection']) {
    baselineTest(`v23 Watch coverage lifetime: stale ${invalidation} workspace cannot certify prior subscription`, { timeout: 20000 }, async () => {
      const f = await watchCapacityFixture(1), gate = deferred();
      let entered = false, pending, restore;
      try {
        restore = metadataTestHooks.holdWatchWorkspacePresentation(async () => { entered = true; await gate.promise; });
        pending = metadataTestHooks.getProjectAssetWorkspace(f.project.id);
        await waitForCondition(() => entered, 'workspace did not reach presentation await');
        const old = metadataTestHooks.getAcceptedSourceWatchSnapshot(f.project.id);
        if (invalidation === 'pause') await callIpcRaw('projects:pause', f.project.id);
        if (invalidation === 'project') { await createProject('New coverage owner'); clearTrackedTimers(); }
        if (invalidation === 'activation') { await callIpcRaw('projects:pause', f.project.id); await callIpcRaw('projects:start-watching', f.project.id); clearTrackedTimers(); }
        if (invalidation === 'account') {
          testAccountSession.generation++;
          const row = f.current().files.find(row => row.path === f.sources[0]);
          assert.deepEqual(metadataTestHooks.getWorkingSourceWatchCoverage(f.current(), row,
            metadataTestHooks.getWorkingSourceMembership(f.current())), { status: 'inactive', reason: 'stale-account', nativeDelivery: 'unverified' });
        }
        if (invalidation === 'selection') f.current().files = f.current().files.filter(row => row.path !== f.sources[0]);
        gate.release(); const result = await pending;
        if (invalidation === 'account') assert.equal(result, null);
        if (['pause','project'].includes(invalidation)) assert.equal(result.files.find(row => row.ext === '.ai').watchCoverage.status, 'inactive');
        if (invalidation === 'activation') assert.notEqual(result.watchCoverage.activationToken, old.activationToken);
        if (invalidation === 'selection') {
          assert.equal(result.files.some(row => row.name === 'Source_000.ai'), false);
          assert.equal(watcherRecords.at(-1).addedPaths.has(f.sources[0]), false);
        }
      } finally { gate.release(); if (pending) await pending; restore?.(); await testAccountSession.restore(); await callIpcRaw('projects:pause', f.project.id); await f.cleanup(); }
    });
  }
  for (const location of ['inside', 'outside']) for (const admission of ['ordinary', 'manual']) {
    baselineTest(`v22 explicit integration ${location} ${admission}: unknown identical-links B choice Watch saved X union`, { timeout: 15000 }, async () => {
      const f = await fixture({ sources: 3, sourceNames: ['A.ai', 'C.ai', 'D.ai'], structuredLinks: false });
      const [a, c, d] = f.paths;
      const write = (source, links) => fs.writeFileSync(source, `%PDF-1.7\n${links.join('\n')}\n%%EOF\n`);
      const shared = path.join(TEST_HOME, 'Desktop', 'Shared.png');
      fs.writeFileSync(shared, 'shared asset bytes');
      write(a.source, [a.link, shared]);
      write(c.source, [c.link, shared, a.source]);
      write(d.source, [d.link, shared]);
      const current = () => storeInstance.data.projects.find(p => p.id === f.project.id);
      const digest = source => crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
      const sourceNames = async () => (await metadataTestHooks.selectProjectFilesForPackaging(current())).map(row => row.name).sort();
      const choose = async (source, action) => {
        const row = (await callIpcRaw('projects:get-asset-workspace', f.project.id)).files.find(item => item.name === path.basename(source));
        assert.ok(row, source);
        const result = await callIpcRaw('projects:set-working-source-selection', f.project.id, row.visualIdentity,
          { action, expectedRevision: row.selectionRevision });
        assert.equal(result.success, true, JSON.stringify(result));
      };
      try {
        manualDialogFor(f.paths.map(row => row.source));
        assert.ok(Array.isArray(await callIpcRaw('projects:add-files', f.project.id, crypto.randomUUID())));
        assert.equal(current().assetBaseline.status, 'decision-required');
        assert.equal((await callIpcRaw('projects:set-existing-assets-decision', f.project.id, 'include')).success, true);
        // These independent sources are intentional Keep both decisions, not
        // inferred successors. Refetch each revision after the preceding choice.
        for (const name of ['C.ai', 'D.ai']) {
          const entry = (await callIpcRaw('projects:get-asset-workspace', f.project.id)).workingFileChoices.choices.find(row => row.source.name === name);
          assert.ok(entry?.ready, JSON.stringify(entry));
          assert.equal((await callIpcRaw('projects:resolve-working-file-choice', f.project.id,
            { id: entry.id, revision: entry.revision, choice: 'keep-both', predecessorIdentity: null })).success, true);
        }
        const baseline = structuredClone(current().assetBaseline);
        const aBytes = fs.readFileSync(a.source);
        const independent = JSON.stringify([c, d].map(row => ({ file: current().files.find(file => file.path === row.source),
          receipt: metadataTestHooks.getWorkingSourceVerification(current(), current().files.find(file => file.path === row.source)) })));
        f.state.opened = true;
        await f.live(); clearTrackedTimers();
        const directory = location === 'inside' ? path.join(TEST_HOME, 'Desktop') : path.join(TEST_HOME, 'External-volume');
        fs.mkdirSync(directory, { recursive: true });
        const b = { source: path.join(directory, 'B.ai'), link: a.link };
        write(b.source, [a.link, shared]);
        // Model a DOC path transition while exercising the actual query/parser,
        // activation scope, admission and continuation observer, not pair seeding.
        f.paths[0] = b;
        if (admission === 'manual') f.state.opened = false;
        await f.live(); clearTrackedTimers();
        const discovered = { accepted: current().files.some(row => row.path === b.source),
          pending: current().pendingFiles.some(row => row.path === b.source) };
        console.log('V22_ORDINARY_B ' + JSON.stringify({ location, admission, ...discovered }));
        assert.deepEqual(discovered, { accepted: admission === 'ordinary', pending: false });
        if (!discovered.accepted) {
          manualDialogFor([b.source]);
          assert.ok(Array.isArray(await callIpcRaw('projects:add-files', f.project.id, crypto.randomUUID())));
        }
        const bRow = current().files.find(row => row.path === b.source); assert.ok(bRow);
        assert.equal(metadataTestHooks.getWorkingSourceVerification(current(), bRow)?.status, 'scanned',
          'new accepted B after baseline completion must reserve and finish saved-byte verification');
        assert.deepEqual(current().assetBaseline, baseline);
        f.state.opened = true; await f.live(); clearTrackedTimers();
        const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        const explicit = workspace.workingFileChoices.choices.find(item => item.source.name === 'B.ai');
        assert.ok(explicit?.ready, 'new admitted B presents a verified neutral choice');
        assert.equal(workspace.sourceContinuation.candidates.length, 0, 'no duplicate inferred pair');
        const predecessor = explicit.predecessors.find(item => item.name === 'A.ai');
        assert.ok(predecessor);
        const result = await callIpcRaw('projects:resolve-working-file-choice', f.project.id,
          {id:explicit.id,revision:explicit.revision,choice:'replace',predecessorIdentity:predecessor.visualIdentity});
        assert.equal(result.success,true,JSON.stringify(result));
        console.log('V22_EXPLICIT_CHOICE ' + JSON.stringify({location,admission,route:'owner-selected predecessor'}));
        const selected = await sourceNames();
        assert.ok(selected.includes('A.ai'), 'C requires A as dependency');
        for (const name of ['B.ai', 'C.ai', 'D.ai', 'Shared.png']) assert.ok(selected.includes(name), name);
        assert.equal(selected.filter(name => name === 'Shared.png').length, 1);
        assert.deepEqual(fs.readFileSync(a.source), aBytes);
        const watch = watcherRecords.at(-1);
        const covered = source => !watch.closed && (watch.addedPaths.has(source) || watch.roots.some(root =>
          source.startsWith(root + path.sep) && path.relative(root, source).split(path.sep).length <= watch.options.depth + 1));
        assert.equal(covered(b.source), true, 'accepted B needs current exact subscription outside default roots');
        const before = structuredClone(metadataTestHooks.getWorkingSourceVerification(current(), bRow));
        f.state.modifiedBySource.set(b.source, true); await f.live(); clearTrackedTimers();
        assert.equal(metadataTestHooks.getWorkingSourceVerification(current(), bRow).sourceFingerprint, before.sourceFingerprint,
          'unsaved live observation does not refresh saved dependencies');
        f.state.modifiedBySource.set(b.source, false);
        const x = path.join(directory, 'X.png'); fs.writeFileSync(x, 'new linked X');
        write(b.source, [a.link, shared, x]);
        await f.live(); clearTrackedTimers(); // Fresh per-document clean evidence; C/D were never dirty.
        const savedDigest = digest(b.source);
        await emitWatcher('change', b.source, fs.statSync(b.source));
        await waitForCondition(() => metadataTestHooks.getWorkingSourceVerification(current(), bRow)?.sourceFingerprint === savedDigest,
          'saved B did not finish current verification');
        await metadataTestHooks.waitForWatcherIdle(f.project.id); clearTrackedTimers();
        const verification = metadataTestHooks.getWorkingSourceVerification(current(), bRow);
        assert.equal(verification.status, 'scanned');
        assert.ok(verification.requiredReferences.some(ref => ref.path === x), 'fresh receipt binds X');
        assert.equal(current().files.filter(row => row.path === x).length, 1, 'Watch admits parser-only X without Add Files X');
        assert.equal(current().pendingFiles.some(row => row.path === x), false);
        const finalNames = await sourceNames();
        const inventory = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        assert.ok(inventory.files.some(row => row.name === path.basename(x) && row.included === true));
        const review = await callIpcRaw('projects:prepare-package-review', f.project.id);
        assert.ok(review.token, JSON.stringify(review));
        assert.equal(review.totalFiles, finalNames.length);
        assert.equal(finalNames.filter(name => name === 'Shared.png').length, 1);
        assert.equal(JSON.stringify([c, d].map(row => ({ file: current().files.find(file => file.path === row.source),
          receipt: metadataTestHooks.getWorkingSourceVerification(current(), current().files.find(file => file.path === row.source)) }))), independent);
        assert.deepEqual(fs.readFileSync(a.source), aBytes);
        assert.deepEqual(current().assetBaseline, baseline);
        assert.equal(inventory.semanticCounts.selectedWorkingSources, 3);
        assert.equal(inventory.semanticCounts.excludedWorkingSources, 1);
        assert.equal(inventory.semanticCounts.includedAssets, 6);
        console.log('V22_SAVED_X_PARITY ' + JSON.stringify({ location, admission, selected: finalNames,
          totalFiles: review.totalFiles, counts: inventory.semanticCounts, digest: verification.sourceFingerprint,
          references: verification.requiredReferences, exactPaths: [...watch.addedPaths] }));
        const oldToken = review.token;
        await choose(b.source, 'exclude');
        if (location === 'outside') {
          assert.equal(watch.addedPaths.has(b.source), false, 'excluded B exact subscription retires');
          assert.equal(watch.retiredPaths.has(b.source), true);
        }
        const y = path.join(directory, 'Y.png'); fs.writeFileSync(y, 'excluded source link');
        write(b.source, [a.link, shared, x, y]);
        await watch.handlers.change(b.source, fs.statSync(b.source));
        await metadataTestHooks.waitForWatcherIdle(f.project.id); clearTrackedTimers();
        assert.equal(current().files.some(row => row.path === y), false, 'excluded B cannot admit Y');
        assert.equal(metadataTestHooks.getWorkingSourceVerification(current(), bRow).sourceFingerprint, savedDigest);
        assert.equal((await callIpcRaw('projects:package', f.project.id, TEST_HOME, oldToken)).error, 'package_review_stale');
        await callIpcRaw('projects:pause', f.project.id); assert.equal(watch.closed, true);
        const frozen = JSON.stringify(current());
        write(b.source, [a.link, shared]);
        await watch.handlers.change(b.source, fs.statSync(b.source));
        assert.equal(JSON.stringify(current()), frozen, 'retired callback cannot mutate paused project');
      } finally {
        await callIpcRaw('projects:pause', f.project.id);
        await f.cleanup();
      }
    });
  }
  async function observeNegativeFixture(f) {
    const idle = () => {
      const state = metadataTestHooks.getWatcherCoordinatorSnapshot(f.project.id);
      return !state.running && state.pendingKinds.length === 0 &&
        !metadataTestHooks.getIllustratorPollState(f.project.id).inProgress;
    };
    // Periodic polls can resolve as coalesced without reading this snapshot.
    // Serialize this fixture's observations before changing its modeled DOCs
    // or clearing timers that may still own a deferred observation.
    await waitForCondition(idle, 'negative fixture observer did not become idle');
    const result = await f.live();
    assert.notEqual(result?.skipped, true, 'negative fixture observation was skipped');
    await waitForCondition(idle, 'negative fixture observation did not finish');
  }
  for (const [observation, overlap] of [
    ['pending-unsaved', false],
    ['independent-equal-assets-focus', false],
    ['pending-unsaved', true],
  ]) {
    baselineTest(`v22 explicit integration negative ${observation}${overlap ? ' with a busy observer' : ''}: ordinary DOC query cannot infer succession`, async () => {
      const f = await fixture({ sources: 2, sourceNames: ['A.ai', 'B.ai'], structuredLinks: false });
      const [a, b] = f.paths;
      fs.writeFileSync(b.source, fs.readFileSync(a.source));
      const current = () => storeInstance.data.projects.find(p => p.id === f.project.id);
      let releasePredecessor, predecessor;
      try {
        manualDialogFor([a.source]);
        assert.ok(Array.isArray(await callIpcRaw('projects:add-files', f.project.id, crypto.randomUUID())));
        assert.equal((await callIpcRaw('projects:set-existing-assets-decision', f.project.id, 'include')).success, true);
        const baseline = structuredClone(current().assetBaseline), aBytes = fs.readFileSync(a.source);
        f.state.opened = true; f.state.visible = 1;
        await observeNegativeFixture(f); clearTrackedTimers();
        f.state.visible = 2; f.state.modified = observation === 'pending-unsaved';
        if (overlap) {
          const gate = deferred();
          let entered = false;
          releasePredecessor = () => gate.release();
          predecessor = metadataTestHooks.runBackgroundWatcherOperation(f.project.id, 'live-app', async () => {
            entered = true; await gate.promise;
          });
          await waitForCondition(() => entered, 'negative fixture predecessor did not start');
          assert.equal(metadataTestHooks.getWatcherCoordinatorSnapshot(f.project.id).runningKind, 'live-app');
          queueMicrotask(releasePredecessor);
        }
        await observeNegativeFixture(f); clearTrackedTimers();
        const bRow = current().files.find(row => row.path === b.source);
        if (observation === 'pending-unsaved') {
          assert.equal(bRow, undefined);
          assert.equal(current().pendingFiles.some(row => row.path === b.source), true);
          assert.equal(watcherRecords.at(-1).addedPaths.has(b.source), false);
        } else {
          assert.ok(bRow);
          assert.equal(metadataTestHooks.getWorkingSourceVerification(current(), bRow).status, 'scanned');
          // Coexisting A stays open when B becomes current. Equal links and
          // a focus switch do not supply a path-transition pair or owner intent.
          f.paths.splice(0, 2, b, a);
          await observeNegativeFixture(f); clearTrackedTimers();
          assert.deepEqual((await metadataTestHooks.selectProjectFilesForPackaging(current()))
            .filter(row => row.ext === '.ai').map(row => row.name).sort(), ['A.ai', 'B.ai']);
        }
        const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        assert.equal(workspace.sourceContinuation.candidates.length, 0);
        assert.equal(workspace.files.find(row => row.name === 'A.ai').sourceSelection, 'selected');
        assert.deepEqual(current().assetBaseline, baseline);
        assert.deepEqual(fs.readFileSync(a.source), aBytes);
      } finally {
        releasePredecessor?.();
        if (predecessor) await predecessor;
        await callIpcRaw('projects:pause', f.project.id); await f.cleanup();
      }
    });
  }
  for (const invalidation of ['pause', 'project', 'account', 'reauthorize', 'revision', 'changed-bytes', 'missing']) {
    baselineTest(`v22 exact B Watch late saved scan refuses ${invalidation}`, { timeout: 15000 }, async () => {
      const f = await fixture({ sources: 2, sourceNames: ['A.ai', 'B.ai'], structuredLinks: false });
      const [a, b] = f.paths, gate = deferred();
      const current = () => storeInstance.data.projects.find(p => p.id === f.project.id);
      const priorRead = fs.promises.readFile;
      let held = false, saving;
      try {
        const outside = path.join(TEST_HOME, 'External-volume'); fs.mkdirSync(outside, { recursive: true });
        const moved = path.join(outside, 'B.ai'); fs.renameSync(b.source, moved); b.source = moved;
        manualDialogFor([a.source]);
        assert.ok(Array.isArray(await callIpcRaw('projects:add-files', f.project.id, crypto.randomUUID())));
        assert.equal((await callIpcRaw('projects:set-existing-assets-decision', f.project.id, 'include')).success, true);
        manualDialogFor([b.source]);
        assert.ok(Array.isArray(await callIpcRaw('projects:add-files', f.project.id, crypto.randomUUID())));
        const choose = async source => {
          const row = (await callIpcRaw('projects:get-asset-workspace', f.project.id)).files.find(item => item.name === path.basename(source));
          const result = await callIpcRaw('projects:set-working-source-selection', f.project.id, row.visualIdentity,
            { action: 'exclude', expectedRevision: row.selectionRevision });
          assert.equal(result.success, true, JSON.stringify(result));
        };
        await choose(a.source);
        const watch = watcherRecords.at(-1); assert.equal(watch.addedPaths.has(b.source), true);
        const baseline = structuredClone(current().assetBaseline), aBytes = fs.readFileSync(a.source);
        const x = path.join(outside, 'late-X.png'); fs.writeFileSync(x, 'late X');
        fs.writeFileSync(b.source, `%PDF-1.7\n${b.link}\n${x}\n%%EOF\n`);
        fs.promises.readFile = async function heldSavedSource(filePath, ...args) {
          if (!held && path.resolve(filePath) === b.source) { held = true; await gate.promise; }
          return priorRead.call(fs.promises, filePath, ...args);
        };
        saving = watch.handlers.change(b.source, fs.statSync(b.source));
        await waitForCondition(() => held, 'current B scan did not reach its owned source read');
        if (invalidation === 'pause') await callIpcRaw('projects:pause', f.project.id);
        if (invalidation === 'project') { await createProject('New Watch owner'); clearTrackedTimers(); }
        if (invalidation === 'account') await testAccountSession.logout();
        if (invalidation === 'reauthorize') testAccountSession.generation++;
        if (invalidation === 'revision') await choose(b.source);
        if (invalidation === 'changed-bytes') fs.appendFileSync(b.source, 'changed during held read');
        if (invalidation === 'missing') fs.renameSync(b.source, b.source + '.preserved');
        const retired = JSON.stringify(current());
        gate.release(); await saving;
        // Child scans deliberately outlive the callback's return. Wait for the
        // existing bounded scan lifetime, not just the watcher coordinator.
        await waitForCondition(() => metadataTestHooks.getWorkingScanLifetime().operations === 0,
          'retired saved-source work did not drain');
        assert.equal(current().files.some(row => row.path === x), false, 'late work cannot admit X');
        assert.equal(current().pendingFiles.some(row => row.path === x), false);
        if (['pause', 'project', 'account', 'reauthorize', 'revision'].includes(invalidation)) {
          assert.equal(JSON.stringify(current()), retired, 'retired work cannot publish over current owner');
        }
        assert.deepEqual(current().assetBaseline, baseline);
        assert.deepEqual(fs.readFileSync(a.source), aBytes);
        assert.equal(metadataTestHooks.getWorkingScanLifetime().leases, 0);
        console.log('V22_LATE_REFUSAL ' + JSON.stringify({ invalidation, source: 'B.ai', admittedX: false }));
      } finally {
        gate.release(); if (saving) await saving;
        fs.promises.readFile = priorRead;
        await testAccountSession.restore();
        await callIpcRaw('projects:pause', f.project.id);
        await f.cleanup();
      }
    });
  }
  function deferred() {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return { promise, release };
  }

  async function fixture({ opened = false, modified = false, descriptor = false, sources = 1, malformed = false, structuredLinks = true, sourceNames = null } = {}) {
    resetTestHomeWorkspace();
    const paths = Array.from({ length: sources }, (_, i) => ({
      source: path.join(TEST_HOME, 'Desktop', sourceNames?.[i] || `Design_${i}.ai`),
      link: path.join(TEST_HOME, 'Desktop', `Link_${i}.png`),
    }));
    for (const p of paths) {
      fs.writeFileSync(p.link, 'synthetic PNG fixture');
      if (malformed) fs.writeFileSync(p.source, '%PDF-1.7\n' + p.link + '\nmissing EOF');
      else writeSyntheticAiFile(p.source, p.link);
    }
    const state = { opened, modified, modifiedBySource: new Map(), descriptor, visible: sources };
    const reads = new Map(paths.map(p => [p.source, 0]));
    const gates = new Map();
    const entered = new Set();
    const originalRead = fs.promises.readFile;
    fs.promises.readFile = async function trackedSourceRead(filePath, ...args) {
      const normalized = path.resolve(filePath);
      if (reads.has(normalized)) {
        reads.set(normalized, reads.get(normalized) + 1);
        entered.add(normalized);
        if (gates.has(normalized)) await gates.get(normalized).promise;
      }
      return originalRead.call(fs.promises, filePath, ...args);
    };
    setChildProcessHandler(({ kind, command, args }) => {
      if (isIllustratorPgrepCheck({ kind, command, args })) return { stdout: '432\n' };
      if (isOsascriptInvocation({ kind, command, args }, 'crate-ai-active-session.applescript')) {
        if (!state.opened) return { stdout: 'STATUS\tno-documents\nCOMPLETE\t0\t0\n' };
        const visible = paths.slice(0, state.visible);
        return { stdout: visible.map((p, i) =>
          `DOC\t${p.source}\t${path.basename(p.source)}\t${state.modifiedBySource.get(p.source) ?? state.modified}\t${i === 0}\n` +
          (structuredLinks ? `LINK\t${p.source}\t${path.basename(p.source)}\t${p.link}\t${state.modifiedBySource.get(p.source) ?? state.modified}\t${i === 0}\n` : '')
        ).join('') + `COMPLETE\t${visible.length}\t${structuredLinks ? visible.length : 0}\n` };
      }
      if ((command === '/bin/ps' && args.includes('pid=')) ||
          (kind === 'exec' && String(command).includes('pid=') && String(command).includes('command='))) {
        return { stdout: '432 /Applications/Adobe Illustrator.app/Contents/MacOS/Adobe Illustrator\n' };
      }
      if (String(command).includes('/usr/sbin/lsof')) return { stdout: state.opened && state.descriptor
        ? 'p432\n' + paths.slice(0, state.visible).map(p => `tREG\nn${p.source}\n`).join('') : '' };
      return { stdout: '' };
    });
    const project = await createProject('Olivia baseline fixture');
    clearTrackedTimers();
    const completionLogs = [];
    const originalLog = console.log;
    console.log = function trackStagedCompletion(...args) {
      if (String(args[0]).includes(`active-session evidence candidates for project ${project.id}`)) {
        completionLogs.push(String(args[0]));
      }
      return originalLog.apply(console, args);
    };
    const token = metadataTestHooks.getActiveWatchingActivationToken(project.id);
    const current = () => getProject(project.id);
    const live = () => metadataTestHooks.pollPsForProject(project.id, token);
    const lsof = async () => {
      await metadataTestHooks.pollLsofForProject(project.id, token);
      await metadataTestHooks.waitForWatcherIdle(project.id);
    };
    const count = (index = 0) => reads.get(paths[index].source);
    const snapshot = async () => JSON.parse(JSON.stringify(await current()));
    return { paths, state, project, token, current, live, lsof, count, snapshot, completionLogs,
      block(index = 0) { const gate = deferred(); gates.set(paths[index].source, gate); return gate; },
      entered(index = 0) { return entered.has(paths[index].source); },
      async cleanup() {
        for (const gate of gates.values()) gate.release();
        await metadataTestHooks.waitForWatcherIdle(project.id);
        fs.promises.readFile = originalRead;
        console.log = originalLog;
        clearTrackedTimers();
      },
      async save(index = 0) {
        const before = count(index);
        const stored = storeInstance.data.projects.find(p => p.id === project.id);
        const time = Math.max(Date.now(), stored.watchStartedAt + 1000);
        fs.utimesSync(paths[index].source, new Date(time), new Date(time));
        await emitWatcher('change', paths[index].source, { mtimeMs: time, birthtimeMs: stored.watchStartedAt - 1000 });
        await waitForCondition(() => count(index) === before + 1, 'source save did not trigger exactly one read');
        await waitForCondition(() => !metadataTestHooks.getBaselineState(project.id)?.inFlightBySource.size, 'source save did not finish');
      },
    };
  }

  async function assertComplete(f, sourceReads = 1) {
    assert.equal(f.count(), sourceReads);
    const p = await f.current();
    assert.equal(p.assetBaseline.status, 'decision-required');
    assert.equal(p.assetBaseline.failedRequiredSources, undefined);
    assert.equal(metadataTestHooks.projectHasUnresolvedLocalAssetBaseline(p), false);
    for (const entry of f.paths.slice(0, f.state.visible)) {
      assert.equal(p.files.filter(file => file.path === entry.source).length, 1);
      assert.equal(p.files.filter(file => file.path === entry.link).length, 1);
      assert.equal(p.pendingFiles.some(file => file.path === entry.source || file.path === entry.link), false);
      assert.equal(fs.existsSync(entry.source), true);
      assert.equal(fs.existsSync(entry.link), true);
    }
    assert.equal((await callIpcRaw('projects:prepare-package-review', p.id)).error, 'asset_baseline_decision_required');
    assert.equal((await callIpcRaw('projects:set-existing-assets-decision', p.id, 'include')).success, true);
    const review = await callIpcRaw('projects:prepare-package-review', p.id);
    assert.equal(review.error, undefined);
    assert.equal(typeof review.token, 'string');
  }

  // LD-1: only the trusted Add Files picker admits each saved source. The
  // dependency is present solely in its real AI bytes, never an observer LINK.
  for (const completedBaseline of [false, true]) {
    baselineTest(`LD-1 manual Add Files: ${completedBaseline ? 'completed baseline retains B parser dependency' : 'awaiting baseline positive control'}`, async () => {
      const f = await fixture({ sources: 2, sourceNames: ['A.ai', 'B.ai'], structuredLinks: false });
      const scans = [];
      const chronology = [];
      const previousLog = console.log;
      console.log = function trackLd1Scan(...args) {
        const message = String(args[0]);
        for (const entry of f.paths) {
          if (message === `[crate] scan-on-open: scanning ${path.basename(entry.source)}`) scans.push(entry.source);
        }
        return previousLog.apply(console, args);
      };
      const snapshot = () => JSON.parse(JSON.stringify(storeInstance.data.projects.find(p => p.id === f.project.id)));
      const sourceBytes = f.paths.map(entry => fs.readFileSync(entry.source));
      const linkBytes = f.paths.map(entry => fs.readFileSync(entry.link));
      const add = async index => {
        clearTrackedTimers();
        manualDialogFor([f.paths[index].source]);
        chronology.push({ action: `Add ${path.basename(f.paths[index].source)}`, at: Date.now() });
        const result = await callIpcRaw('projects:add-files', f.project.id, crypto.randomUUID());
        assert.ok(Array.isArray(result), 'trusted Add Files must finish without a partial failure');
        await metadataTestHooks.waitForWatcherIdle(f.project.id);
        clearTrackedTimers();
        return snapshot();
      };
      const assertSourceAndLink = (project, index, origin) => {
        const entry = f.paths[index];
        const source = project.files.filter(file => file.path === entry.source);
        const links = project.files.filter(file => file.path === entry.link);
        assert.equal(source.length, 1, 'manual source must have one admitted row');
        assert.equal(source[0].source, 'manual-browse');
        assert.equal(source[0].assetOrigin, 'added');
        assert.equal(source[0].projectRole, 'source');
        assert.equal(links.length, 1, 'B parser-only dependency must be admitted after Add Files');
        assert.equal(links[0].assetOrigin, origin);
        assert.equal(links[0].projectRole, 'asset');
        if (origin === 'existing') assert.equal(links[0].assetBaselineSourcePath, entry.source);
        assert.equal(links[0].source, 'scan-on-open');
        assert.equal(project.pendingFiles.some(file => file.path === entry.source || file.path === entry.link), false);
        const verification = metadataTestHooks.getWorkingSourceVerification(project, source[0]);
        assert.equal(verification?.status, 'scanned');
        assert.ok(verification.requiredReferences.some(ref => ref.path === entry.link), 'current parser receipt must bind source to dependency');
        assert.equal(verification.sourceFingerprint, crypto.createHash('sha256').update(sourceBytes[index]).digest('hex'));
        const identity = fs.statSync(entry.source);
        for (const field of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(verification.sourceIdentity[field], identity[field]);
        assert.equal(scans.filter(sourcePath => sourcePath === entry.source).length, 1,
          'one bounded parser scan; hashing/read counts are only supporting evidence');
        assert.deepEqual(fs.readFileSync(entry.source), sourceBytes[index]);
        assert.deepEqual(fs.readFileSync(entry.link), linkBytes[index]);
      };
      try {
        const activation = snapshot();
        assert.equal(activation.assetBaseline.status, 'awaiting-first-scan');
        assert.deepEqual(activation.files, []);
        assert.deepEqual(activation.pendingFiles, []);
        let beforeB = activation;
        if (completedBaseline) {
          const afterA = await add(0);
          assertSourceAndLink(afterA, 0, 'existing');
          assert.equal(afterA.assetBaseline.status, 'decision-required');
          assert.ok(Number.isFinite(afterA.assetBaseline.establishedAt));
          assert.equal((await callIpcRaw('projects:set-existing-assets-decision', f.project.id, 'include')).success, true);
          beforeB = snapshot();
          chronology.push({ action: 'Include Existing', at: Date.now(), baseline: beforeB.assetBaseline });
          assert.equal(beforeB.assetBaseline.status, 'included');
          assert.equal(beforeB.assetBaseline.decision, 'include');
          // Wait for the real boundary to pass; never fabricate completed state.
          await waitForCondition(() => Date.now() > beforeB.assetBaseline.establishedAt, 'baseline time did not advance');
        }
        const afterB = await add(1);
        console.log('LD1_EVIDENCE ' + JSON.stringify({ arm: completedBaseline ? 'completed' : 'awaiting',
          chronology, beforeB, afterB, scans, supportingAsyncSourceReads: f.paths.map((_, i) => f.count(i)),
          producerControls: { opened: f.state.opened, descriptor: f.state.descriptor, timers: activeTimeouts.size + activeIntervals.size } }));
        assert.equal(f.state.opened, false);
        assert.equal(f.state.descriptor, false);
        assert.equal(activeTimeouts.size + activeIntervals.size, 0);
        assert.deepEqual(afterB.workingSourceSelections, beforeB.workingSourceSelections);
        assert.deepEqual(afterB.excludedAssetKeys || [], beforeB.excludedAssetKeys || []);
        if (completedBaseline) {
          assert.deepEqual(afterB.assetBaseline, beforeB.assetBaseline, 'prior baseline and Include decision must stay intact');
          for (const entry of f.paths.slice(0, 1)) {
            for (const filePath of [entry.source, entry.link]) {
              assert.deepEqual(afterB.files.find(file => file.path === filePath), beforeB.files.find(file => file.path === filePath));
            }
          }
          assert.equal(scans.filter(sourcePath => sourcePath === f.paths[0].source).length, 1, 'A must not be requeued');
          assert.ok(afterB.files.find(file => file.path === f.paths[1].source).addedAt > beforeB.assetBaseline.establishedAt);
        } else {
          assert.equal(afterB.assetBaseline.status, 'decision-required');
          assert.ok(Number.isFinite(afterB.assetBaseline.establishedAt));
        }
        assertSourceAndLink(afterB, 1, completedBaseline ? 'added' : 'existing');
      } finally {
        console.log = previousLog;
        await f.cleanup();
      }
    });
  }

  async function ld1CompletedFixture(beforeFirstAdd = () => {}) {
    const f = await fixture({ sources: 3, sourceNames: ['A.ai', 'B.ai', 'C.ai'], structuredLinks: false });
    const scans = [];
    const originalLog = console.log;
    console.log = function trackLd1ControlScan(...args) {
      for (const entry of f.paths) {
        if (String(args[0]) === `[crate] scan-on-open: scanning ${path.basename(entry.source)}`) scans.push(entry.source);
      }
      return originalLog.apply(console, args);
    };
    const current = () => JSON.parse(JSON.stringify(storeInstance.data.projects.find(p => p.id === f.project.id)));
    const begin = (indices, id = crypto.randomUUID()) => {
      clearTrackedTimers();
      manualDialogFor(indices.map(index => typeof index === 'number' ? f.paths[index].source : index));
      return callIpcRaw('projects:add-files', f.project.id, id);
    };
    const add = async (...indices) => {
      const result = await begin(indices);
      await metadataTestHooks.waitForWatcherIdle(f.project.id);
      clearTrackedTimers();
      return result;
    };
    try {
      beforeFirstAdd(f);
      assert.ok(Array.isArray(await add(0)));
      const initial = current();
      assert.equal(initial.assetBaseline.status, 'decision-required');
      assert.ok(Number.isFinite(initial.assetBaseline.establishedAt));
      assert.equal(initial.files.find(file => file.path === f.paths[0].link)?.assetOrigin, 'existing');
      assert.equal((await callIpcRaw('projects:set-existing-assets-decision', f.project.id, 'include')).success, true);
      const baseline = current();
      await waitForCondition(() => Date.now() > baseline.assetBaseline.establishedAt, 'completed baseline clock did not advance');
      return { ...f, current, begin, add, scans, baseline,
        scanCount(index) { return scans.filter(filePath => filePath === f.paths[index].source).length; },
        assertPrior() {
          const project = current();
          assert.deepEqual(project.assetBaseline, baseline.assetBaseline);
          for (const filePath of [f.paths[0].source, f.paths[0].link]) {
            assert.deepEqual(project.files.find(file => file.path === filePath), baseline.files.find(file => file.path === filePath));
          }
          assert.equal(scans.filter(filePath => filePath === f.paths[0].source).length, 1);
        },
        assertMissing(index) {
          const project = current();
          assert.equal([...project.files, ...project.pendingFiles].some(file => file.path === f.paths[index].link), false);
          assert.equal(JSON.stringify(project.provenance).includes(f.paths[index].link), false);
          const row = project.files.find(file => file.path === f.paths[index].source);
          assert.notEqual(metadataTestHooks.getWorkingSourceVerification(project, row)?.status, 'scanned');
        },
        evidence(control) {
          console.log('LD1_CONTROL_EVIDENCE ' + JSON.stringify({ control, baseline, after: current(), scans }));
        },
        async cleanup() { console.log = originalLog; await f.cleanup(); },
      };
    } catch (error) { console.log = originalLog; await f.cleanup(); throw error; }
  }

  baselineTest('WR-4 manual Add Files: completed baseline reload preserves first B parser dependency', async () => {
    const f = await ld1CompletedFixture();
    const bytes = f.paths.map(entry => ({ source: fs.readFileSync(entry.source), link: fs.readFileSync(entry.link) }));
    try {
      const beforeReload = f.current();
      assert.equal(beforeReload.assetBaseline.status, 'included');
      assert.equal(beforeReload.assetBaseline.decision, 'include');
      assert.ok(Number.isFinite(beforeReload.assetBaseline.establishedAt));
      assert.notEqual(f.paths[0].link, f.paths[1].link, 'B must have a unique parser-only dependency');
      assert.equal([...beforeReload.files, ...beforeReload.pendingFiles].some(file =>
        file.path === f.paths[1].source || file.path === f.paths[1].link), false, 'B was never admitted before reload');
      assert.equal(f.scanCount(1), 0);
      assert.equal(f.count(1), 0);
      const priorVerification = metadataTestHooks.getWorkingSourceVerification(beforeReload,
        beforeReload.files.find(file => file.path === f.paths[0].source));
      const oldStoreData = storeInstance.data;
      // Existing harness reload: persisted JSON bytes become new store objects.
      // This deliberately retains in-process owners; it is not process restart.
      roundTripFakeStore();
      assert.notEqual(storeInstance.data, oldStoreData);
      const afterReload = f.current();
      assert.deepEqual(afterReload, beforeReload);
      f.assertPrior();

      const result = await f.begin([1]); // FIRST B admission, after persisted reload.
      const immediate = f.current(); // Seal before workspace or any package call.
      const timersAtReturn = activeTimeouts.size + activeIntervals.size;
      clearTrackedTimers(); // No wait, poll or queued observer rescues this snapshot.
      console.log('WR4_RELOAD_EVIDENCE ' + JSON.stringify({
        chronology: ['A Add Files and Include Existing', 'persisted JSON roundtrip', 'FIRST B Add Files'],
        beforeReload, afterReload, immediate, result, scans: [...f.scans],
        producerControls: { opened: f.state.opened, descriptor: f.state.descriptor,
          structuredLinks: false, timersAtReturn, timersAfterClear: activeTimeouts.size + activeIntervals.size },
        qualification: 'Existing IPC/mock store reload; no process restart, watcher save, live LINK or package call',
      }));
      assert.ok(Array.isArray(result), 'first B Add Files must complete without partial failure');
      assert.equal(f.state.opened, false);
      assert.equal(f.state.descriptor, false);
      assert.equal(activeTimeouts.size + activeIntervals.size, 0);
      assert.deepEqual(immediate.assetBaseline, beforeReload.assetBaseline, 'baseline decision and timestamp must not reset');
      assert.deepEqual(immediate.workingSourceSelections, beforeReload.workingSourceSelections, 'no implicit Restore or intent drift');
      assert.deepEqual(immediate.excludedAssetKeys || [], beforeReload.excludedAssetKeys || []);
      assert.deepEqual(immediate.pendingFiles, []);
      f.assertPrior();
      const a = immediate.files.find(file => file.path === f.paths[0].source);
      assert.deepEqual(metadataTestHooks.getWorkingSourceVerification(immediate, a), priorVerification);
      assert.equal(f.scanCount(0), 1, 'reload and B admission must not rescan A');
      const sources = immediate.files.filter(file => file.path === f.paths[1].source);
      const links = immediate.files.filter(file => file.path === f.paths[1].link);
      assert.equal(sources.length, 1);
      assert.equal(sources[0].source, 'manual-browse');
      assert.equal(sources[0].projectRole, 'source');
      assert.equal(sources[0].assetOrigin, 'added');
      assert.ok(sources[0].addedAt > beforeReload.assetBaseline.establishedAt);
      assert.equal(links.length, 1, 'parser-only B dependency must already be present');
      assert.equal(links[0].source, 'scan-on-open');
      assert.equal(links[0].projectRole, 'asset');
      assert.equal(links[0].assetOrigin, 'added');
      assert.equal(f.scanCount(1), 1, 'ordinary selected-source verification scans B once');
      assert.equal(f.scanCount(2), 0, 'unselected sibling must remain untouched');
      const verification = metadataTestHooks.getWorkingSourceVerification(immediate, sources[0]);
      assert.equal(verification?.status, 'scanned');
      assert.ok(verification.requiredReferences.some(ref => ref.path === f.paths[1].link));
      assert.equal(verification.sourceFingerprint, crypto.createHash('sha256').update(bytes[1].source).digest('hex'));
      const identity = fs.statSync(f.paths[1].source);
      for (const field of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(verification.sourceIdentity[field], identity[field]);
      for (let i = 0; i < 2; i++) {
        assert.deepEqual(fs.readFileSync(f.paths[i].source), bytes[i].source);
        assert.deepEqual(fs.readFileSync(f.paths[i].link), bytes[i].link);
      }
      const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      console.log('WR4_WORKSPACE_EVIDENCE ' + JSON.stringify({ projectId: workspace.projectId, semanticCounts: workspace.semanticCounts }));
      assert.equal(workspace.files.find(file => file.name === 'B.ai').sourceSelection, 'selected');
      assert.equal(workspace.semanticCounts.unresolvedVerification, 0);
      assert.equal(workspace.semanticCounts.missingRequiredReferences, 0);
    } finally { await f.cleanup(); }
  });

  baselineTest('WR-1 quiet completed baseline: pause resume replaces one watcher without rescan', async () => {
    const f = await ld1CompletedFixture();
    try {
      const before = f.current(), token = metadataTestHooks.getActiveWatchingActivationToken(f.project.id);
      const created = watcherRecords.length, closed = watcherCloseCount;
      const priorVerification = before.workingSourceVerification;
      await callIpcRaw('projects:pause', f.project.id);
      assert.equal(metadataTestHooks.getActiveWatchingActivationToken(f.project.id), null);
      assert.equal(watcherCloseCount, closed + 1);
      await callIpcRaw('projects:pause', f.project.id);
      assert.equal(watcherCloseCount, closed + 1, 'repeated pause must not close another watcher');
      await callIpcRaw('projects:start-watching', f.project.id);
      clearTrackedTimers();
      const after = f.current();
      const replacement = metadataTestHooks.getActiveWatchingActivationToken(f.project.id);
      assert.ok(replacement !== null && replacement !== token);
      assert.equal(watcherRecords.length, created + 1, 'one replacement watcher');
      assert.equal(watcherCloseCount, closed + 1);
      assert.equal(after.status, 'watching');
      assert.deepEqual(after.workingSourceVerification, priorVerification);
      assert.deepEqual(after.workingSourceSelections, before.workingSourceSelections);
      assert.deepEqual(after.pendingFiles, []);
      assert.equal(f.scanCount(1), 0); assert.equal(f.scanCount(2), 0);
      f.assertPrior();
      console.log('WR1_EVIDENCE ' + JSON.stringify({ before, after, token, replacement,
        watchersCreated: watcherRecords.length - created, watchersClosed: watcherCloseCount - closed, scans: f.scans }));
    } finally { await f.cleanup(); }
  });

  baselineTest('WR-2 stale pending reload resume: raw row survives public projection and project isolation', async () => {
    const f = await ld1CompletedFixture();
    try {
      const stored = storeInstance.data.projects.find(project => project.id === f.project.id);
      const stale = { ...makePendingFile(f.paths[1].source, 'app-opened'), addedAt: stored.watchStartedAt - 1000,
        captureState: 'needs-save', captureReason: 'unsaved-source-needs-save',
        captureEvidence: { source: 'app-opened', appFamily: 'illustrator',
          observerMethod: 'illustrator-active-session', evidenceStrength: 'structured-app-document' } };
      stored.pendingFiles.push(stale);
      await callIpcRaw('projects:pause', f.project.id);
      const other = await createProject('WR2 foreign project');
      manualDialogFor([f.paths[2].source]);
      assert.ok(Array.isArray(await callIpcRaw('projects:add-files', other.id, crypto.randomUUID())));
      clearTrackedTimers();
      roundTripFakeStore();
      await callIpcRaw('projects:start-watching', f.project.id);
      clearTrackedTimers();
      const raw = f.current(), publicProject = await getProject(f.project.id);
      const publicFiles = await callIpcRaw('projects:get-files', f.project.id);
      const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      assert.deepEqual(raw.pendingFiles.filter(file => file.path === stale.path), [stale], 'projection must not delete persisted pending state');
      assert.equal(publicProject.pendingFiles.some(file => file.path === stale.path), false);
      assert.equal(publicFiles.some(file => file.path === stale.path || file.path === f.paths[2].source), false);
      assert.equal(publicFiles.filter(file => file.path === f.paths[0].source).length, 1);
      assert.equal(workspace.pendingFiles.some(file => file.name === 'B.ai'), false);
      assert.equal(workspace.files.some(file => file.name === 'C.ai'), false);
      assert.equal(workspace.files.filter(file => file.name === 'A.ai').length, 1);
      assert.equal(storeInstance.data.projects.find(project => project.id === other.id).files.filter(file => file.path === f.paths[2].source).length, 1);
      assert.equal(f.scanCount(1), 0);
      f.assertPrior();
      console.log('WR2_EVIDENCE ' + JSON.stringify({ raw, publicProject, publicFiles, workspace, foreignProjectId: other.id }));
    } finally { await f.cleanup(); }
  });

  baselineTest('WR-3 deferred parser pause resume: retired completion preserves new owner reservation', async () => {
    const f = await fixture({ sources: 2, sourceNames: ['Retired.ai', 'Current.ai'], structuredLinks: false });
    const oldGate = deferredScanBoundary();
    const restoreReads = interceptBaselineSourceReads(async (filePath, read) => {
      if (path.resolve(filePath) === f.paths[0].source) await oldGate.wait();
      return read();
    });
    let retired, freshQueue, newState;
    try {
      manualDialogFor([f.paths[0].source]);
      retired = callIpcRaw('projects:add-files', f.project.id, crypto.randomUUID());
      await oldGate.started;
      const oldState = metadataTestHooks.getBaselineState(f.project.id);
      assert.ok(oldState?.inFlightBySource.size);
      const oldToken = metadataTestHooks.getActiveWatchingActivationToken(f.project.id);
      await callIpcRaw('projects:pause', f.project.id);
      await callIpcRaw('projects:start-watching', f.project.id);
      clearTrackedTimers();
      assert.notEqual(metadataTestHooks.getActiveWatchingActivationToken(f.project.id), oldToken);
      manualDialogFor([f.paths[1].source]);
      const busy = await callIpcRaw('projects:add-files', f.project.id, crypto.randomUUID());
      assert.deepEqual(busy, { success: false, error: 'add_files_operation_in_progress' });
      // The public picker intentionally stays busy until its retired operation
      // settles. Model only the fresh private queue contract at this boundary.
      freshQueue = metadataTestHooks.reserveProjectAssetBaselineScanQueue(f.project.id, [f.paths[1].source]);
      newState = metadataTestHooks.getBaselineState(f.project.id);
      assert.ok(newState && newState !== oldState);
      assert.equal(newState.queuedSourceKeys.size, 1);
      const reservation = { required: [...newState.requiredSourceKeys], queued: [...newState.queuedSourceKeys],
        inFlight: [...newState.inFlightBySource.keys()] };
      const beforeRelease = JSON.parse(JSON.stringify(storeInstance.data.projects));
      oldGate.release();
      assert.equal(await retired, null);
      assert.deepEqual(storeInstance.data.projects, beforeRelease, 'retired completion must not publish persisted changes');
      assert.equal(metadataTestHooks.getBaselineState(f.project.id), newState);
      assert.deepEqual({ required: [...newState.requiredSourceKeys], queued: [...newState.queuedSourceKeys],
        inFlight: [...newState.inFlightBySource.keys()] }, reservation, 'old cleanup must not consume fresh reservations');
      assert.equal(oldState.inFlightBySource.size, 0);
      assert.equal(oldState.activeScans.size, 0);
      assert.equal(storeInstance.data.projects.find(project => project.id === f.project.id).files
        .some(file => file.path === f.paths[0].link), false, 'retired completion cannot publish its dependency');
      // This is the retirement boundary. Subsequent fresh Add Files may scan
      // both admitted roots while their initial baseline remains awaiting.
      metadataTestHooks.cancelProjectAssetBaselineScanQueue(f.project.id, freshQueue, newState);
      assert.equal(newState.queuedSourceKeys.size, 0);
      manualDialogFor([f.paths[1].source]);
      assert.ok(Array.isArray(await callIpcRaw('projects:add-files', f.project.id, crypto.randomUUID())));
      const after = JSON.parse(JSON.stringify(storeInstance.data.projects.find(project => project.id === f.project.id)));
      assert.equal(after.files.filter(file => file.path === f.paths[1].link).length, 1, 'fresh owner positive control');
      assert.equal(metadataTestHooks.getWorkingSourceVerification(after, after.files.find(file => file.path === f.paths[1].source))?.status, 'scanned');
      assert.equal(newState.inFlightBySource.size, 0);
      console.log('WR3_EVIDENCE ' + JSON.stringify({ oldToken, reservation, beforeRelease, after,
        busy, qualification: 'Trusted IPC retirement plus privately modeled fresh queue reservation; fresh public Add Files only after old picker settles; no native restart' }));
    } finally {
      oldGate.release();
      if (retired) await retired;
      if (freshQueue) metadataTestHooks.cancelProjectAssetBaselineScanQueue(f.project.id, freshQueue, newState);
      restoreReads(); await f.cleanup();
    }
  });

  baselineTest('WR-7 excluded failed healthy siblings: reload resume readd preserves independent intent and receipts', async () => {
    const f = await ld1CompletedFixture();
    try {
      assert.ok(Array.isArray(await f.add(1)));
      const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      const row = workspace.files.find(file => file.name === 'B.ai');
      assert.equal((await callIpcRaw('projects:set-working-source-selection', f.project.id, row.visualIdentity,
        { action: 'exclude', expectedRevision: row.selectionRevision })).success, true);
      fs.writeFileSync(f.paths[2].source, `%PDF-1.7\n${f.paths[2].link}\nmissing EOF`);
      assertAddFilesPartialScanFailure(await f.add(2));
      const before = f.current();
      const failed = metadataTestHooks.getWorkingSourceVerification(before, before.files.find(file => file.path === f.paths[2].source));
      assert.equal(failed?.status, 'failed');
      roundTripFakeStore();
      await callIpcRaw('projects:pause', f.project.id);
      await callIpcRaw('projects:start-watching', f.project.id);
      clearTrackedTimers();
      assert.ok(Array.isArray(await f.add(1, 2)));
      const after = f.current(), resumed = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      assert.deepEqual(after.workingSourceSelections, before.workingSourceSelections);
      assert.deepEqual(after.workingSourceVerification, before.workingSourceVerification);
      assert.equal(resumed.files.find(file => file.name === 'B.ai').sourceSelection, 'excluded');
      assert.deepEqual(metadataTestHooks.getWorkingSourceVerification(after, after.files.find(file => file.path === f.paths[2].source)), failed);
      assert.equal(after.files.some(file => file.path === f.paths[2].link), false);
      assert.equal(after.files.filter(file => file.path === f.paths[1].link).length, 1, 'prior genuine dependency retained');
      assert.deepEqual([f.scanCount(0), f.scanCount(1), f.scanCount(2)], [1, 1, 1], 'no implicit Restore or failed-source retry');
      f.assertPrior();
      console.log('WR7_EVIDENCE ' + JSON.stringify({ before, after, workspace: resumed, scans: f.scans }));
    } finally { await f.cleanup(); }
  });

  baselineTest('WR-8 deferred watcher account project replacement: retired callback cannot publish to either owner', async () => {
    const f = await fixture({ sources: 2, structuredLinks: false });
    const originalStat = fs.promises.stat, gate = deferredScanBoundary();
    let changing;
    try {
      const stat = await originalStat.call(fs.promises, f.paths[0].source);
      const retiredWatcher = watcherRecords[watcherRecords.length - 1];
      fs.promises.stat = async (candidate, ...args) => {
        if (path.resolve(candidate) === f.paths[0].source) { await gate.wait(); return stat; }
        return originalStat.call(fs.promises, candidate, ...args);
      };
      changing = retiredWatcher.handlers.change(f.paths[0].source);
      await gate.started;
      const generation = testAccountSession.generation;
      testAccountSession.invalidate();
      assert.ok(testAccountSession.generation > generation);
      const replacement = await createProject('WR8 fresh account generation project');
      clearTrackedTimers();
      const currentWatcher = watcherRecords[watcherRecords.length - 1];
      const beforeRelease = JSON.parse(JSON.stringify(storeInstance.data.projects));
      testRendererEvents.length = 0;
      fs.promises.stat = originalStat; gate.release(); await changing;
      await metadataTestHooks.waitForWatcherIdle(f.project.id);
      assert.deepEqual(storeInstance.data.projects, beforeRelease);
      assert.equal(testRendererEvents.filter(event => event.data?.projectId === f.project.id || event.data?.projectId === replacement.id).length, 0);
      await retiredWatcher.handlers.add(f.paths[0].source);
      assert.deepEqual(storeInstance.data.projects, beforeRelease, 'retired watcher stays retired after account/project replacement');
      const currentStored = storeInstance.data.projects.find(project => project.id === replacement.id);
      await waitForCondition(() => Date.now() > currentStored.watchStartedAt, 'replacement activation clock did not advance');
      const positiveSource = path.join(TEST_HOME, 'Desktop', 'Created_After_Replacement.ai');
      writeSyntheticAiFile(positiveSource, f.paths[1].link);
      await currentWatcher.handlers.add(positiveSource);
      await metadataTestHooks.waitForWatcherIdle(replacement.id);
      const after = JSON.parse(JSON.stringify(storeInstance.data.projects));
      const old = after.find(project => project.id === f.project.id), fresh = after.find(project => project.id === replacement.id);
      assert.equal(old.status, 'paused'); assert.equal(fresh.status, 'watching');
      assert.equal([...old.files, ...old.pendingFiles].length, 0);
      assert.equal(fresh.files.some(file => file.path === f.paths[0].source), false);
      assert.equal(fresh.files.filter(file => file.path === positiveSource).length, 1, 'current watcher positive control from newly created synthetic source');
      console.log('WR8_EVIDENCE ' + JSON.stringify({ generation, replacementGeneration: testAccountSession.generation,
        beforeRelease, after, positiveSource, qualification: 'Synthetic account generation and IPC project replacement; positive file physically created after replacement; no login or process restart' }));
    } finally {
      fs.promises.stat = originalStat; gate.release(); if (changing) await changing;
      await testAccountSession.restore(); await f.cleanup();
    }
  });

  baselineTest('LD-1 controls: completed baseline ignores re-add, unselected roots and images', async () => {
    const f = await ld1CompletedFixture();
    try {
      assert.ok(Array.isArray(await f.add(1)));
      const verified = f.current();
      const b = verified.files.find(file => file.path === f.paths[1].source);
      assert.equal(metadataTestHooks.getWorkingSourceVerification(verified, b)?.status, 'scanned');
      assert.equal(verified.files.find(file => file.path === f.paths[1].link)?.assetOrigin, 'added');
      assert.deepEqual(verified.pendingFiles, []);
      assert.ok(Array.isArray(await f.add(1, 1, f.paths[2].link)));
      assert.equal(f.scanCount(1), 1);
      assert.equal(f.scanCount(2), 0);
      assert.equal(f.current().files.some(file => file.path === f.paths[2].source), false);
      assert.equal(f.current().files.find(file => file.path === f.paths[2].link)?.projectRole, 'asset');
      assert.deepEqual(f.current().workingSourceVerification, verified.workingSourceVerification);
      f.assertPrior(); f.evidence('re-add/unselected/image');
    } finally { await f.cleanup(); }
  });

  baselineTest('LD-1 controls: prior exclusion survives row absence and manual readmission', async () => {
    const f = await ld1CompletedFixture();
    try {
      assert.ok(Array.isArray(await f.add(1)));
      const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      const row = workspace.files.find(file => file.name === 'B.ai');
      assert.equal((await callIpcRaw('projects:set-working-source-selection', f.project.id, row.visualIdentity,
        { action: 'exclude', expectedRevision: row.selectionRevision })).success, true);
      const excluded = f.current();
      // Model a persisted absent row, as the existing durable-intent control
      // does. The exclusion itself and subsequent admission use real IPC.
      const stored = storeInstance.data.projects.find(project => project.id === f.project.id);
      stored.files = stored.files.filter(file => file.path !== f.paths[1].source);
      roundTripFakeStore();
      assert.ok(Array.isArray(await f.add(1)));
      const after = f.current();
      assert.equal(f.scanCount(1), 1, 'new row at an excluded route cannot trigger Restore');
      assert.deepEqual(after.workingSourceSelections, excluded.workingSourceSelections);
      assert.deepEqual(after.workingSourceVerification, excluded.workingSourceVerification);
      assert.equal((await callIpcRaw('projects:get-asset-workspace', f.project.id)).files.find(file => file.name === 'B.ai').sourceSelection, 'excluded');
      assert.deepEqual(after.files.find(file => file.path === f.paths[1].link), excluded.files.find(file => file.path === f.paths[1].link),
        'genuine prior dependency must survive source exclusion and re-admission');
      f.assertPrior(); f.evidence('durable exclusion/modeled row absence/manual readmission');
    } finally { await f.cleanup(); }
  });

  baselineTest('LD-1 controls: malformed later source fails without baseline reset or re-add retry', async () => {
    const f = await ld1CompletedFixture();
    try {
      fs.writeFileSync(f.paths[1].source, `%PDF-1.7\n${f.paths[1].link}\nmissing EOF`);
      const result = await f.add(1);
      assertAddFilesPartialScanFailure(result);
      assert.equal(result.failedCount, 1);
      assert.equal(result.completedCount, 0);
      assert.equal(f.scanCount(1), 1);
      f.assertMissing(1);
      const failed = f.current().workingSourceVerification;
      assert.ok(Array.isArray(await f.add(1)));
      assert.equal(f.scanCount(1), 1);
      assert.deepEqual(f.current().workingSourceVerification, failed);
      f.assertPrior(); f.evidence('malformed/no implicit retry');
    } finally { await f.cleanup(); }
  });

  for (const interruption of ['source-bytes', 'cancel', 'generation', 'exclude']) {
    baselineTest(`LD-1 controls: ${interruption} during later scan prevents dependency publication`, async () => {
      const f = await ld1CompletedFixture();
      const entered = deferred(), release = deferred();
      const restoreReads = interceptBaselineSourceReads(async (filePath, read) => {
        if (path.resolve(filePath) === f.paths[1].source) { entered.release(); await release.promise; }
        return read();
      });
      let pending;
      try {
        const id = crypto.randomUUID();
        pending = f.begin([1], id);
        await entered.promise;
        if (interruption === 'source-bytes') {
          writeSyntheticAiFile(f.paths[1].source, `${f.paths[2].link}\nchanged saved bytes`);
        } else if (interruption === 'cancel') {
          assert.equal(await callIpcRaw('projects:cancel-add-files', f.project.id, id), true);
        } else if (interruption === 'generation') {
          await createProject('LD-1 generation replacement');
          clearTrackedTimers();
        } else {
          const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
          const row = workspace.files.find(file => file.name === 'B.ai');
          const excluded = await callIpcRaw('projects:set-working-source-selection', f.project.id, row.visualIdentity,
            { action: 'exclude', expectedRevision: row.selectionRevision });
          assert.equal(excluded.success, true);
        }
        release.release();
        const result = await pending;
        if (['cancel', 'generation'].includes(interruption)) assert.equal(result, null);
        else assertAddFilesPartialScanFailure(result);
        f.assertMissing(1);
        assert.equal(f.current().files.some(file => file.path === f.paths[2].link), false);
        if (interruption === 'exclude') {
          const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
          assert.equal(workspace.files.find(file => file.name === 'B.ai').sourceSelection, 'excluded');
          assert.ok(Array.isArray(await f.add(1)));
          assert.equal(f.scanCount(1), 1, 'excluded re-add must not act as Restore');
          f.assertMissing(1);
        }
        f.assertPrior(); f.evidence(interruption);
      } finally {
        release.release();
        if (pending) await pending;
        restoreReads();
        await f.cleanup();
      }
    });
  }

  baselineTest('LD-1 controls: later timeout retains bounded sibling success without late publication', async () => {
    const f = await ld1CompletedFixture();
    const entered = deferred(), release = deferred();
    const restoreReads = interceptBaselineSourceReads(async (filePath, read) => {
      if (path.resolve(filePath) === f.paths[1].source) { entered.release(); await release.promise; }
      return read();
    });
    const trackedTimer = global.setTimeout;
    // The established test harness scales only the production scan deadline.
    global.setTimeout = (callback, delay, ...args) => trackedTimer(callback, delay === 30000 ? 250 : delay, ...args);
    let pending;
    try {
      pending = f.begin([1, 2]);
      await entered.promise;
      const result = await pending;
      assertAddFilesPartialScanFailure(result);
      assert.equal(result.selectedCount, 2);
      assert.equal(result.completedCount, 1);
      assert.equal(result.failedCount, 1);
      assert.equal(result.scanResults.find(item => item.path === f.paths[1].source).error, 'add_files_scan_timeout');
      assert.equal(f.current().files.find(file => file.path === f.paths[2].link)?.assetOrigin, 'added');
      assert.equal(metadataTestHooks.getWorkingSourceVerification(f.current(), f.current().files.find(file => file.path === f.paths[2].source))?.status, 'scanned');
      f.assertMissing(1);
      release.release();
      await new Promise(resolve => originalSetTimeout(resolve, 25));
      f.assertMissing(1);
      assert.equal(f.scanCount(1), 1); assert.equal(f.scanCount(2), 1);
      f.assertPrior(); f.evidence('timeout/sibling/late result');
    } finally {
      global.setTimeout = trackedTimer;
      release.release();
      if (pending) await pending;
      restoreReads(); await f.cleanup();
    }
  });

  function ld1InDesignFixture(f, scenario) {
    const source = path.join(TEST_HOME, 'Desktop', 'Later.indd');
    const savedLink = f.paths[1].link;
    const liveLink = path.join(TEST_HOME, 'Desktop', 'Live-only.png');
    const otherSource = path.join(TEST_HOME, 'Desktop', 'Other.indd');
    const otherLink = path.join(TEST_HOME, 'Desktop', 'Other-only.png');
    fs.writeFileSync(source, `synthetic saved InDesign bytes\n${savedLink}\n`);
    fs.writeFileSync(liveLink, 'synthetic live linked bytes');
    fs.writeFileSync(otherLink, 'synthetic unrelated linked bytes');
    const selected = [
      `DOC\t${source}\tLater.indd\tfalse\ttrue\t1`,
      `LINK\t${source}\tLater.indd\t${liveLink}\tfalse\ttrue`,
      'END\t1\t1\t1\t0',
    ].join('\n');
    const other = [
      `DOC\t${otherSource}\tOther.indd\tfalse\ttrue\t1`,
      `LINK\t${otherSource}\tOther.indd\t${otherLink}\tfalse\ttrue`,
      'END\t1\t1\t1\t0',
    ].join('\n');
    const counts = { processChecks: 0, enumerations: 0, queries: 0, observerScripts: [], otherObserverScripts: [], processCalls: [] };
    const closed = scenario === 'closed' || scenario === 'closed-lookalike-processes';
    const processFailure = scenario.startsWith('process-');
    const inventoryErrors = {
      'process-invocation-failure': { code: 'ENOENT' },
      'process-exit-one': { code: 1, killed: false, signal: null },
      'process-policy-denied': { code: 'EPERM' },
      'process-access-denied': { code: 'EACCES' },
      'process-timeout': { code: null, killed: true, signal: 'SIGTERM' },
      'process-signal': { code: null, killed: false, signal: 'SIGKILL' },
      'process-overflow': { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true },
    };
    const validClosedInventory = '    0 kernel_task\n    1 /sbin/launchd\n  432 /bin/ps\n';
    const invalidInventories = {
      'process-empty': '',
      'process-unknown': 'unknown process inventory\n',
      'process-malformed': 'not-a-pid /sbin/launchd\n',
      'process-truncated': validClosedInventory.trimEnd(),
      'process-duplicate-pid': validClosedInventory + '432 /bin/zsh\n',
      'process-invalid-pid': '9007199254740992 /bin/ps\n',
      'process-unknown-command': '432 ???\n',
      'process-control-byte': '432 /bin/p\0s\n',
      'process-blank-row': validClosedInventory + '\n',
    };
    setChildProcessHandler(request => {
      if (request.kind === 'execFile' && request.command === '/bin/ps' &&
          request.args.includes('pid=') && request.args.includes('comm=')) {
        counts.processChecks++; counts.enumerations++;
        counts.processCalls.push({ route: 'selected-source-inventory', kind: request.kind,
          command: request.command, args: [...request.args] });
        // Model the execFile result contract, not a boolean running-app answer.
        assert.deepEqual(request.args, ['axww', '-o', 'pid=', '-o', 'comm=']);
        assert.equal(request.options.encoding, 'utf8');
        assert.equal(request.options.timeout, 3000);
        assert.equal(request.options.maxBuffer, 4 * 1024 * 1024);
        if (scenario === 'process-malformed') {
          // Deterministically model the foreign callback observed in full CI.
          // This harness helper dispatches a mocked result; it runs no process.
          getChildProcessResult('execFile', '/usr/bin/osascript', [path.join(TEST_HOME, 'crate-ai-active-session.applescript')]);
        }
        if (inventoryErrors[scenario]) return { error: Object.assign(new Error('synthetic process invocation failure'),
          { stdout: validClosedInventory, stderr: '' }, inventoryErrors[scenario]) };
        if (Object.hasOwn(invalidInventories, scenario)) return { stdout: invalidInventories[scenario], stderr: '' };
        if (scenario === 'process-stderr') return { stdout: validClosedInventory, stderr: 'ps: incomplete result' };
        if (scenario === 'closed-lookalike-processes') return { stdout: validClosedInventory +
          '555 /Applications/Adobe InDesign Server.app/Contents/MacOS/Adobe InDesign Server\n' +
          '556 /Applications/Adobe InDesign.app/Contents/MacOS/Adobe InDesign Helper\n', stderr: '' };
        if (closed) return { stdout: validClosedInventory, stderr: '' };
        const command = scenario === 'running-bare-name' ? 'Adobe InDesign' :
          '/Applications/Adobe InDesign 2026/Adobe InDesign 2026.app/Contents/MacOS/Adobe InDesign';
        return { stdout: validClosedInventory + `555 ${command}\n`, stderr: '' };
      }
      if (request.kind === 'exec' && String(request.command).includes("grep -i 'Adobe InDesign'")) {
        counts.processChecks++;
        counts.processCalls.push({ route: 'background-indesign-observer', kind: request.kind,
          command: request.command, args: [...request.args] });
        if (scenario === 'process-policy-denied') {
          return { error: Object.assign(new Error('synthetic process policy denial'), { code: 'EPERM' }) };
        }
        // exec rejects the original grep pipeline when no process matches.
        // A successful empty stdout would mask the selected-source regression.
        if (closed || processFailure) return { error: Object.assign(
          new Error('synthetic grep pipeline no-match'), { code: 1, killed: false, signal: null, stdout: '', stderr: '' }) };
        return { stdout: '/Applications/Adobe InDesign/Adobe InDesign' };
      }
      if (isOsascriptInvocation(request, 'crate-indd-query.applescript')) {
        counts.queries++;
        if (scenario === 'script-automation-denied') return { error: Object.assign(
          new Error('synthetic Not authorized to send Apple events (-1743)'), { code: -1743 }) };
        if (scenario === 'script-query-failure') return { error: new Error('synthetic query execution failure') };
        if (scenario === 'malformed') return { stdout: other.replace(/END.*$/, '') };
        if (scenario === 'count-mismatch') return { stdout: other.replace('END\t1\t1\t1\t0', 'END\t2\t1\t1\t0') };
        if (scenario === 'query-error-count') return { stdout: other.replace('END\t1\t1\t1\t0', 'END\t1\t1\t1\t1') };
        if (scenario === 'snapshot-source-change') fs.appendFileSync(source, `changed bytes\n${otherLink}\n`);
        return { stdout: scenario === 'selected-present' ? selected : scenario === 'running-no-documents' ? 'END\t0\t0\t0\t0' : other };
      }
      if (request.kind === 'execFile' && request.command === '/usr/bin/osascript') {
        const script = path.basename(request.args[0]);
        // The shared harness may finish another app's modeled callback here.
        // Retain it separately; only InDesign's observer could rescue this scan.
        (script === 'crate-indd-poll.applescript' ? counts.observerScripts : counts.otherObserverScripts).push(script);
        if (script === 'crate-ai-active-session.applescript') {
          return { stdout: 'STATUS\tno-documents\nCOMPLETE\t0\t0\n' };
        }
      }
      return { stdout: '' };
    });
    return { source, savedLink, liveLink, otherLink, counts };
  }

  for (const scenario of ['running-no-documents', 'closed-lookalike-processes']) {
    for (const foreignOutput of ['fixture', 'empty-control']) {
      baselineTest(`LD-1 M1 InDesign callback replacement: ${scenario}/${foreignOutput}`, async () => {
        const pollGate = deferred(), readGate = deferred();
        const chronology = [];
        let held = false, readEntered = false, pending, f;
        let restoreReads = () => {};
        try {
          f = await ld1CompletedFixture(() => {
            const originalHandler = childProcessHandler;
            setChildProcessHandler(request => {
              if (!held && isIllustratorPgrepCheck(request)) {
                held = true;
                chronology.push('original-admission-poll-held');
                return pollGate.promise.then(() => originalHandler(request));
              }
              return originalHandler(request);
            });
          });
          assert.equal(held, true, 'hold the actual poll started by A admission');
          assert.equal(metadataTestHooks.getIllustratorPollState(f.project.id).inProgress, true);
          const d = ld1InDesignFixture(f, scenario);
          const inDesignHandler = childProcessHandler;
          setChildProcessHandler(request => {
            const result = inDesignHandler(request);
            if (isOsascriptInvocation(request, 'crate-ai-active-session.applescript')) {
              chronology.push('foreign-illustrator-script-dispatched');
              if (foreignOutput === 'empty-control') return { stdout: '' };
            }
            return result;
          });
          chronology.push('indesign-handler-installed');
          restoreReads = interceptBaselineSourceReads(async (filePath, read) => {
            if (path.resolve(filePath) === d.source && !readEntered) {
              readEntered = true;
              chronology.push('selected-source-verification-read-held');
              await readGate.promise;
            }
            return read();
          });
          pending = f.begin([d.source]);
          await waitForCondition(() => readEntered, 'selected-source verification did not reach the read gate');
          const before = metadataTestHooks.getIllustratorPollState(f.project.id);
          chronology.push('original-poll-released');
          pollGate.release();
          await waitForCondition(() => !metadataTestHooks.getIllustratorPollState(f.project.id).inProgress,
            'original poll did not settle across handler replacement');
          const after = metadataTestHooks.getIllustratorPollState(f.project.id);
          chronology.push('original-poll-settled');
          readGate.release();
          const result = await pending;
          await metadataTestHooks.waitForWatcherIdle(f.project.id);
          const project = f.current();
          const source = project.files.find(file => file.path === d.source);
          const record = metadataTestHooks.getWorkingSourceVerification(project, source);
          console.log('LD1_CALLBACK_REPLACEMENT_EVIDENCE ' + JSON.stringify({ scenario, foreignOutput,
            chronology, before, after, result, verification: record, counters: d.counts }));
          assert.deepEqual(chronology, ['original-admission-poll-held', 'indesign-handler-installed',
            'selected-source-verification-read-held', 'original-poll-released',
            'foreign-illustrator-script-dispatched', 'original-poll-settled']);
          assert.deepEqual(d.counts.otherObserverScripts, ['crate-ai-active-session.applescript']);
          const noQuery = scenario === 'closed-lookalike-processes';
          assert.deepEqual(d.counts.observerScripts, noQuery ? [] : ['crate-indd-poll.applescript']);
          if (foreignOutput === 'empty-control') {
            assert.equal(result, null, 'invalid foreign output must still retire the production lease');
            assert.equal(after.scopeRevision, before.scopeRevision + 1);
            assert.equal(record?.status, 'pending');
            assert.equal(project.files.some(file => file.path === d.savedLink), false);
          } else {
            assert.ok(Array.isArray(result), 'valid foreign callback must preserve the InDesign operation');
            assert.equal(after.scopeRevision, before.scopeRevision);
            assert.equal(record?.status, 'scanned');
            assert.equal(record.provider, 'ordinary-indd');
            assert.equal(record.sourceFingerprint, crypto.createHash('sha256').update(fs.readFileSync(d.source)).digest('hex'));
            assert.ok(record.notes.includes('saved-byte-regex-fallback'));
            assert.deepEqual(record.unresolved, []);
            assert.equal(project.files.filter(file => file.path === d.savedLink).length, 1);
            assert.ok(record.requiredReferences.some(ref => ref.path === d.savedLink));
          }
          assert.equal(d.counts.processChecks, foreignOutput === 'empty-control' ? 1 : 2);
          assert.equal(d.counts.queries, foreignOutput === 'empty-control' || noQuery ? 0 : 1);
          assert.equal([...project.files, ...project.pendingFiles].some(file => [d.liveLink, d.otherLink].includes(file.path)), false);
          assert.equal(JSON.stringify(project.provenance).includes(d.otherLink), false);
          assert.deepEqual(project.pendingFiles, []);
          f.assertPrior();
        } finally {
          pollGate.release(); readGate.release();
          if (pending) await pending;
          if (f) await waitForCondition(() => !metadataTestHooks.getIllustratorPollState(f.project.id).inProgress,
            'original callback cleanup did not settle');
          restoreReads();
          if (f) await f.cleanup();
        }
      });
    }
  }

  for (const scenario of ['process-unknown', 'process-stderr']) {
    for (const timing of ['prior-poll-running', 'prior-poll-settled']) {
      baselineTest(`LD-1 M1 InDesign process count timing: ${scenario}/${timing}`, async () => {
        const priorGate = deferred(), laterGate = deferred();
        const chronology = [];
        let priorHeld = false, laterHeld = false, pending, f;
        try {
          f = await ld1CompletedFixture(() => {
            const originalHandler = childProcessHandler;
            setChildProcessHandler(request => {
              if (!priorHeld && isIllustratorPgrepCheck(request)) {
                priorHeld = true; chronology.push('prior-admission-poll-held');
                return priorGate.promise.then(() => originalHandler(request));
              }
              return originalHandler(request);
            });
          });
          assert.equal(priorHeld, true);
          if (timing === 'prior-poll-settled') {
            priorGate.release();
            await waitForCondition(() => !metadataTestHooks.getIllustratorPollState(f.project.id).inProgress,
              'prior poll did not settle before handler replacement');
            chronology.push('prior-poll-settled-before-replacement');
          }
          const d = ld1InDesignFixture(f, scenario);
          const inDesignHandler = childProcessHandler;
          setChildProcessHandler(request => {
            if (timing === 'prior-poll-settled' && !laterHeld && isIllustratorPgrepCheck(request)) {
              laterHeld = true; chronology.push('later-admission-poll-held');
              return laterGate.promise.then(() => inDesignHandler(request));
            }
            return inDesignHandler(request);
          });
          chronology.push('indesign-handler-installed');
          pending = f.add(d.source);
          const result = await pending;
          chronology.push('selected-source-operation-settled');
          const before = structuredClone(d.counts);
          const pollBefore = metadataTestHooks.getIllustratorPollState(f.project.id);
          assert.equal(pollBefore.inProgress, true);
          assert.equal(laterHeld, timing === 'prior-poll-settled');
          assert.equal(before.processChecks, 1);
          assert.equal(before.enumerations, 1);
          assert.deepEqual(before.processCalls, [{ route: 'selected-source-inventory', kind: 'execFile',
            command: '/bin/ps', args: ['axww', '-o', 'pid=', '-o', 'comm='] }]);
          priorGate.release(); laterGate.release();
          chronology.push('background-poll-released');
          await waitForCondition(() => !metadataTestHooks.getIllustratorPollState(f.project.id).inProgress,
            'background poll did not settle before count assertion');
          chronology.push('background-poll-settled');
          const after = structuredClone(d.counts);
          const pollAfter = metadataTestHooks.getIllustratorPollState(f.project.id);
          const project = f.current();
          const source = project.files.find(file => file.path === d.source);
          const record = metadataTestHooks.getWorkingSourceVerification(project, source);
          console.log('LD1_PROCESS_COUNT_TIMING_EVIDENCE ' + JSON.stringify({ scenario, timing,
            chronology, before, after, pollBefore, pollAfter, result, verification: record }));
          assertAddFilesPartialScanFailure(result);
          assert.equal(result.failedCount, 1); assert.equal(result.completedCount, 0);
          assert.equal(record?.status, 'failed');
          assert.equal(record.notes?.includes('saved-byte-regex-fallback') || false, false);
          assert.equal([...project.files, ...project.pendingFiles].some(file =>
            [d.savedLink, d.liveLink, d.otherLink].includes(file.path)), false);
          assert.equal(JSON.stringify(project.provenance).includes(d.otherLink), false);
          assert.deepEqual(project.pendingFiles, []);
          assert.equal(pollAfter.scopeRevision, pollBefore.scopeRevision);
          assert.equal(after.processChecks, 2); assert.equal(after.enumerations, 1);
          assert.equal(after.queries, 0); assert.deepEqual(after.observerScripts, []);
          assert.deepEqual(after.processCalls, [before.processCalls[0], {
            route: 'background-indesign-observer', kind: 'exec',
            command: "/bin/ps ax -o command= 2>/dev/null | grep -i 'Adobe InDesign' | grep -v grep", args: [],
          }]);
          assert.deepEqual(after.otherObserverScripts,
            timing === 'prior-poll-running' ? ['crate-ai-active-session.applescript'] : []);
          f.assertPrior();
        } finally {
          priorGate.release(); laterGate.release();
          if (pending) await pending;
          if (f) {
            await waitForCondition(() => !metadataTestHooks.getIllustratorPollState(f.project.id).inProgress,
              'process count timing cleanup did not settle');
            await f.cleanup();
          }
        }
      });
    }
  }

  for (const scenario of ['running-other-document', 'running-no-documents', 'selected-present', 'closed',
    'malformed', 'count-mismatch', 'query-error-count', 'script-query-failure', 'script-automation-denied', 'process-policy-denied',
    'snapshot-source-change', 'running-bare-name', 'closed-lookalike-processes',
    'process-invocation-failure', 'process-exit-one', 'process-access-denied', 'process-timeout', 'process-signal',
    'process-overflow', 'process-empty', 'process-unknown', 'process-malformed', 'process-truncated',
    'process-duplicate-pid', 'process-invalid-pid', 'process-unknown-command', 'process-control-byte',
    'process-blank-row', 'process-stderr']) {
    baselineTest(`LD-1 M1 InDesign: ${scenario}`, async () => {
      const f = await ld1CompletedFixture();
      try {
        await waitForCondition(() => !metadataTestHooks.getIllustratorPollState(f.project.id).inProgress,
          'prior admission poll did not settle before InDesign handler replacement');
        const d = ld1InDesignFixture(f, scenario);
        const originalBytes = fs.readFileSync(d.source);
        const result = await f.add(d.source);
        await waitForCondition(() => !metadataTestHooks.getIllustratorPollState(f.project.id).inProgress,
          'InDesign admission poll did not settle before observer count assertions');
        const project = f.current();
        const source = project.files.find(file => file.path === d.source);
        const record = metadataTestHooks.getWorkingSourceVerification(project, source);
        const success = ['running-other-document', 'running-no-documents', 'selected-present', 'closed', 'running-bare-name', 'closed-lookalike-processes'].includes(scenario);
        const noQuery = scenario.startsWith('process-') || ['closed', 'closed-lookalike-processes'].includes(scenario);
        console.log('LD1_M1_EVIDENCE ' + JSON.stringify({ scenario, counters: d.counts, before: f.baseline, after: project, result }));
        // Add Files also refreshes the live observer. Its modeled output is
        // empty; only the selected-source query can produce these links.
        assert.deepEqual(d.counts.observerScripts, noQuery
          ? [] : ['crate-indd-poll.applescript']);
        if (scenario === 'process-malformed') assert.ok(d.counts.otherObserverScripts.includes('crate-ai-active-session.applescript'));
        assert.equal(d.counts.processChecks, 2);
        assert.equal(d.counts.processCalls.filter(call => call.route === 'selected-source-inventory').length, 1);
        assert.equal(d.counts.processCalls.filter(call => call.route === 'background-indesign-observer').length, 1);
        assert.equal(d.counts.queries, noQuery ? 0 : 1);
        assert.equal(source.source, 'manual-browse'); assert.equal(source.assetOrigin, 'added');
        if (success) {
          assert.ok(Array.isArray(result), 'valid non-open saved source must not cause a partial failure');
          assert.equal(record?.status, 'scanned');
          assert.equal(record.provider, 'ordinary-indd');
          assert.equal(record.inventoryStatus, 'unverified');
          assert.equal(record.sourceFingerprint, crypto.createHash('sha256').update(originalBytes).digest('hex'));
          const stat = fs.statSync(d.source);
          for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(record.sourceIdentity[key], stat[key]);
          const expectedLink = scenario === 'selected-present' ? d.liveLink : d.savedLink;
          assert.equal(project.files.filter(file => file.path === expectedLink).length, 1);
          assert.equal(project.files.find(file => file.path === expectedLink).assetOrigin, 'added');
          assert.ok(record.requiredReferences.some(ref => ref.path === expectedLink));
          if (scenario === 'selected-present') {
            assert.ok(record.unresolved.some(item => item.reason === 'indesign-live-current-bytes-unbound'));
            assert.equal(record.notes.includes('saved-byte-regex-fallback'), false);
            assert.equal(project.files.some(file => file.path === d.savedLink), false);
          } else {
            assert.ok(record.notes.includes('saved-byte-regex-fallback'));
            assert.equal(record.notes.includes('indesign-live-current-bytes-unbound'), false);
            assert.deepEqual(record.unresolved, []);
            assert.equal(project.files.some(file => file.path === d.liveLink), false);
          }
        } else {
          assertAddFilesPartialScanFailure(result);
          assert.equal(result.failedCount, 1);
          assert.equal(record?.status, 'failed');
          assert.equal([...project.files, ...project.pendingFiles].some(file => [d.savedLink, d.liveLink].includes(file.path)), false);
          assert.equal(record?.notes?.includes('saved-byte-regex-fallback') || false, false);
        }
        assert.equal([...project.files, ...project.pendingFiles].some(file => file.path === d.otherLink), false);
        assert.equal(JSON.stringify(project.provenance).includes(d.otherLink), false);
        assert.deepEqual(project.pendingFiles, []);
        assert.equal(d.counts.enumerations, 1);
        f.assertPrior();
      } finally { await f.cleanup(); }
    });
  }

  baselineTest('LD-1 M1 InDesign: strict first baseline still rejects a valid snapshot missing the selected document', async () => {
    const f = await fixture({ sources: 2, structuredLinks: false });
    const d = ld1InDesignFixture(f, 'running-other-document');
    try {
      manualDialogFor([d.source]);
      const result = await callIpcRaw('projects:add-files', f.project.id, crypto.randomUUID());
      assertAddFilesPartialScanFailure(result);
      const project = JSON.parse(JSON.stringify(storeInstance.data.projects.find(p => p.id === f.project.id)));
      assert.equal(project.assetBaseline.status, 'awaiting-first-scan');
      assert.equal(project.assetBaseline.establishedAt, null);
      assert.equal(project.files.some(file => file.path === d.savedLink || file.path === d.otherLink), false);
      assert.equal(d.counts.queries, 1);
      console.log('LD1_M1_EVIDENCE ' + JSON.stringify({ scenario: 'strict-first-baseline', after: project, result }));
    } finally { await f.cleanup(); }
  });

  baselineTest('LD-1 M1 InDesign: strict first baseline still rejects real closed-process no-match', async () => {
    const f = await fixture({ sources: 2, structuredLinks: false });
    const d = ld1InDesignFixture(f, 'closed');
    try {
      manualDialogFor([d.source]);
      const result = await callIpcRaw('projects:add-files', f.project.id, crypto.randomUUID());
      assertAddFilesPartialScanFailure(result);
      const project = JSON.parse(JSON.stringify(storeInstance.data.projects.find(p => p.id === f.project.id)));
      assert.equal(project.assetBaseline.status, 'awaiting-first-scan');
      assert.equal(project.assetBaseline.establishedAt, null);
      assert.equal(project.files.some(file => file.path === d.savedLink || file.path === d.otherLink), false);
      assert.equal(d.counts.enumerations, 0); assert.equal(d.counts.queries, 0);
      console.log('LD1_M1_EVIDENCE ' + JSON.stringify({ scenario: 'strict-first-baseline-closed', counters: d.counts, after: project, result }));
    } finally { await f.cleanup(); }
  });

  baselineTest('InDesign unknown modified state is never clean evidence or a dependable snapshot', () => {
    const source = path.join(TEST_HOME, 'Desktop', 'Unknown.indd');
    for (const modified of ['unknown', '', 'FALSE', 'null']) {
      const output = `DOC\t${source}\tUnknown.indd\t${modified}\ttrue\t0\nEND\t1\t0\t0\t0`;
      const parsed = metadataTestHooks.parseInDesignActiveSessionOutput(output);
      assert.equal(parsed.documents[0].modified, null);
      const records = metadataTestHooks.createInDesignLiveEvidenceRecords('test', parsed);
      assert.equal(records.length, 1);
      assert.equal(records[0].savedEvidence, false); assert.equal(records[0].requiresSave, true);
      assert.throws(() => metadataTestHooks.parseDependableInDesignBaselineSnapshot(output, source), /snapshot_incomplete/);
    }
    assert.throws(() => metadataTestHooks.parseDependableInDesignBaselineSnapshot(
      `DOC\t${path.dirname(source)}/\t\tfalse\ttrue\t0\nEND\t1\t0\t0\t0`, source,
      { allowMissingSelectedSource: true }), /snapshot_incomplete/, 'missing document name cannot establish selected-source absence');
    assert.match(metadataTestHooks.inDesignScript, /set docName to name of aDoc\s+on error\s+set queryErrorCount to queryErrorCount \+ 1/);
    assert.match(metadataTestHooks.inDesignScript, /set docCurrent to \(aDoc is active document\)\s+on error\s+set queryErrorCount to queryErrorCount \+ 1/);
    assert.match(metadataTestHooks.inDesignScript, /docPathText & docName\s+end if\s+on error\s+set queryErrorCount to queryErrorCount \+ 1/);
    assert.match(metadataTestHooks.inDesignScript, /set docModified to "unknown"/);
    assert.match(metadataTestHooks.inDesignScript, /set docModified to modified of aDoc\s+on error\s+set queryErrorCount to queryErrorCount \+ 1/);
  });

  baselineTest('LD-1 M1 InDesign: Restore still rejects a valid running snapshot missing the selected document', async () => {
    const f = await ld1CompletedFixture();
    let d = ld1InDesignFixture(f, 'selected-present');
    try {
      assert.ok(Array.isArray(await f.add(d.source)));
      let row = (await callIpcRaw('projects:get-asset-workspace', f.project.id)).files.find(file => file.name === 'Later.indd');
      assert.equal((await callIpcRaw('projects:set-working-source-selection', f.project.id, row.visualIdentity,
        { action: 'exclude', expectedRevision: row.selectionRevision })).success, true);
      // Same physical saved source; only the modeled live document changes.
      d = ld1InDesignFixture(f, 'running-other-document');
      row = (await callIpcRaw('projects:get-asset-workspace', f.project.id)).files.find(file => file.name === 'Later.indd');
      const result = await callIpcRaw('projects:set-working-source-selection', f.project.id, row.visualIdentity,
        { action: 'restore', expectedRevision: row.selectionRevision });
      assert.equal(result.success, true);
      assert.equal(result.verificationStatus, 'failed');
      assert.equal(d.counts.enumerations, 0); assert.equal(d.counts.queries, 1);
      const project = f.current();
      assert.equal(project.files.some(file => file.path === d.otherLink), false);
      assert.equal(JSON.stringify(project.provenance).includes(d.otherLink), false);
      assert.equal(metadataTestHooks.getWorkingSourceMembership(project).blocked, true);
      f.assertPrior();
      console.log('LD1_M1_EVIDENCE ' + JSON.stringify({ scenario: 'strict-restore-missing-selected', counters: d.counts, after: project, result }));
    } finally { await f.cleanup(); }
  });

  baselineTest('no descriptor: saved direct admission scans once and requires ordinary Existing decision', async () => {
    const f = await fixture();
    try {
      const activation = await f.snapshot();
      f.state.opened = true;
      await f.live();
      await assertComplete(f);
      assert.equal(activation.assetBaseline.status, 'awaiting-first-scan');
      assert.equal(activation.assetBaseline.failedRequiredSources, undefined);
      assert.deepEqual(activation.files, []);
      for (let i = 0; i < 3; i++) { await f.live(); await f.lsof(); }
      assert.equal(f.count(), 1, 'unchanged polls must not requeue an admitted source');
    } finally { await f.cleanup(); }
  });

  baselineTest('malformed direct source stays blocked without poll retries; corrected save recovers', async () => {
    const f = await fixture({ malformed: true });
    try {
      const activation = await f.snapshot();
      f.state.opened = true;
      await f.live();
      assert.equal(f.count(), 1);
      const failed = await f.snapshot();
      assert.equal(failed.assetBaseline.status, 'awaiting-first-scan');
      assert.equal(failed.assetBaseline.failedRequiredSources.length, 1);
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).error, 'asset_baseline_scan_incomplete');
      const early = await callIpcRaw('projects:set-existing-assets-decision', f.project.id, 'include');
      assert.equal(early.success, false);
      assert.equal(early.error, 'asset_baseline_decision_unavailable');
      for (let i = 0; i < 3; i++) { await f.live(); await f.lsof(); }
      assert.equal(f.count(), 1, 'failure must not create polling retries');
      // Another malformed save remains blocked; save status alone is not proof.
      await f.save();
      assert.equal(f.count(), 2);
      assert.equal((await f.current()).assetBaseline.status, 'awaiting-first-scan');
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).error, 'asset_baseline_scan_incomplete');
      writeSyntheticAiFile(f.paths[0].source, f.paths[0].link);
      await f.save();
      await assertComplete(f, 3);
      assert.equal(failed.assetBaseline.status, 'awaiting-first-scan', 'snapshot must not alias live state');
      assert.equal(failed.assetBaseline.failedRequiredSources.length, 1);
      assert.equal(activation.assetBaseline.failedRequiredSources, undefined);
    } finally { await f.cleanup(); }
  });

  baselineTest('modified-to-saved admission scans despite already marked lsof cache', async () => {
    const f = await fixture({ modified: true, descriptor: true });
    try {
      f.state.opened = true;
      await f.live(); await f.lsof();
      assert.equal(f.count(), 0);
      assert.deepEqual(metadataTestHooks.getScannedPaths(f.project.id), [f.paths[0].source]);
      assert.equal((await f.current()).pendingFiles.find(p => p.path === f.paths[0].source).captureState, 'needs-save');
      f.state.modified = false;
      await f.live(); await f.lsof();
      await assertComplete(f);
      for (let i = 0; i < 3; i++) { await f.live(); await f.lsof(); }
      assert.equal(f.count(), 1);
    } finally { await f.cleanup(); }
  });

  for (const order of ['live-first', 'lsof-first']) {
    baselineTest(`descriptor present ${order}: admission and lsof reads are bounded`, async () => {
      const f = await fixture({ descriptor: true });
      try {
        f.state.opened = true;
        if (order === 'lsof-first') {
          await f.lsof(); assert.equal(f.count(), 0);
          assert.deepEqual(metadataTestHooks.getScannedPaths(f.project.id), []);
        }
        await f.live(); assert.equal(f.count(), 1);
        await f.lsof();
        // The existing first descriptor scan remains independent of the new
        // admission scan. Subsequent same-PID observations must not repeat it.
        await assertComplete(f, 2);
        for (let i = 0; i < 3; i++) { await f.live(); await f.lsof(); }
        assert.equal(f.count(), 2);
      } finally { await f.cleanup(); }
    });
  }

  baselineTest('unsaved source never starts baseline parsing', async () => {
    const f = await fixture({ modified: true });
    try {
      f.state.opened = true;
      for (let i = 0; i < 3; i++) { await f.live(); await f.lsof(); }
      assert.equal(f.count(), 0);
      const p = await f.current();
      assert.deepEqual(p.files, []);
      assert.equal(p.pendingFiles.length, 2);
      assert.equal(p.pendingFiles.every(row => row.captureState === 'needs-save'), true);
      assert.equal(metadataTestHooks.getBaselineState(p.id), undefined);
    } finally { await f.cleanup(); }
  });

  baselineTest('open-before-Watch remains isolated until a qualifying source save', async () => {
    const f = await fixture({ opened: true, descriptor: true });
    try {
      for (let i = 0; i < 3; i++) { await f.live(); await f.lsof(); }
      assert.equal(f.count(), 0);
      assert.deepEqual((await f.current()).files, []);
      assert.deepEqual((await f.current()).pendingFiles, []);
      assert.equal(metadataTestHooks.getIllustratorActivationScopeSnapshot(f.project.id).baselineDocumentPaths.length, 1);
      await f.save();
      await assertComplete(f);
    } finally { await f.cleanup(); }
  });

  baselineTest('current live-app completion persists success after parser-owned scope adoption', async () => {
    const f = await fixture({ structuredLinks: false });
    const gate = f.block();
    let scan;
    try {
      f.state.opened = true;
      scan = f.live();
      await waitForCondition(() => f.entered(), 'current scan did not reach source read');
      const before = await f.snapshot();
      const writesBefore = storeInstance.projectSetCount;
      assert.equal(before.assetBaseline.status, 'awaiting-first-scan');
      assert.equal(before.liveAppEvidenceStatus.apps.illustrator.latest.stagedCount, 0);
      assert.deepEqual(metadataTestHooks.getIllustratorActivationScopeSnapshot(f.project.id).allowedLinkedPaths, []);
      assert.equal(f.completionLogs.length, 0);
      gate.release(); await scan;
      const after = await f.snapshot();
      const completion = after.liveAppEvidenceStatus.apps.illustrator.latest;
      assert.equal(completion.projectWatching, true);
      assert.equal(completion.scriptSuccess, true);
      assert.equal(completion.stagedCount, 1);
      assert.equal(completion.errorCategory, 'script-success');
      assert.notDeepEqual(after.liveAppEvidenceStatus, before.liveAppEvidenceStatus);
      assert.ok(storeInstance.projectSetCount > writesBefore);
      assert.equal(f.completionLogs.length, 1);
      assert.deepEqual(metadataTestHooks.getIllustratorActivationScopeSnapshot(f.project.id).allowedLinkedPaths, [f.paths[0].link.toLowerCase()]);
      await assertComplete(f);
    } finally { gate.release(); if (scan) await scan; await f.cleanup(); }
  });

  for (const invalidation of ['pause', 'project', 'account', 'identity', 'restored-access', 'scope', 'coordinator']) {
    baselineTest(`triggered scan rejects stale ${invalidation} before dependency publication`, async () => {
      const f = await fixture();
      const gate = f.block();
      let scan;
      const originalGeneration = testAccountSession.generation;
      const originalStatus = testAccountSession.status;
      try {
        f.state.opened = true;
        scan = f.live();
        await waitForCondition(() => f.entered(), 'admission scan did not reach source read');
        assert.equal(f.count(), 1);
        assert.equal((await f.current()).files.some(row => row.path === f.paths[0].source), true);
        if (invalidation === 'pause') await callIpcRaw('projects:pause', f.project.id);
        if (invalidation === 'project') {
          f.state.opened = false;
          await createProject('Different project');
          clearTrackedTimers();
        }
        if (invalidation === 'account') {
          testAccountSession.invalidate();
          testAccountSession.status = { ...testAccountSession.status, identity: { id: 'different-synthetic-account' } };
        }
        if (invalidation === 'identity') {
          testAccountSession.status = { ...testAccountSession.status, identity: { id: 'different-synthetic-account' } };
          assert.equal(testAccountSession.generation, originalGeneration, 'identity must fence independently of generation');
        }
        if (invalidation === 'restored-access') {
          testAccountSession.invalidate();
          testAccountSession.status = originalStatus;
          assert.equal(testAccountSession.canUseWorkspace(), true, 'restored access must permit fresh work');
          assert.notEqual(testAccountSession.generation, originalGeneration, 'retired generation must not be restored');
        }
        if (invalidation === 'scope') metadataTestHooks.getProjectOperationScope(f.project.id).revision++;
        if (invalidation === 'coordinator') {
          const generation = metadataTestHooks.getWatcherCoordinatorSnapshot(f.project.id).generation;
          metadataTestHooks.cancelWatcherCoordinator(f.project.id);
          assert.ok(metadataTestHooks.getWatcherCoordinatorSnapshot(f.project.id).generation > generation);
          assert.equal(metadataTestHooks.getActiveWatchingActivationToken(f.project.id), f.token, 'coordinator must fence independently of activation');
        }
        const fence = testRendererEvents.length;
        const statusBefore = JSON.parse(JSON.stringify(storeInstance.data.projects.find(p => p.id === f.project.id).liveAppEvidenceStatus));
        const writesBefore = storeInstance.projectSetCount;
        const logsBefore = f.completionLogs.length;
        gate.release(); await scan;
        const old = storeInstance.data.projects.find(p => p.id === f.project.id);
        assert.equal(old.files.some(row => row.path === f.paths[0].link), false);
        assert.equal(old.assetBaseline.status, 'awaiting-first-scan');
        assert.equal(testRendererEvents.slice(fence).some(e => e.data?.projectId === f.project.id &&
          ['project:updated', 'files:updated', 'files:pending'].includes(e.channel)), false);
        assert.equal(f.count(), 1);
        assert.deepEqual(old.liveAppEvidenceStatus, statusBefore, 'cancelled poll must not persist a late success breadcrumb');
        assert.equal(storeInstance.projectSetCount, writesBefore, 'retired completion must not write the project store');
        assert.equal(f.completionLogs.length, logsBefore, 'retired completion must not log staged success');
      } finally {
        gate.release(); if (scan) await scan;
        testAccountSession.generation = originalGeneration;
        testAccountSession.status = originalStatus;
        await f.cleanup();
      }
    });
  }

  baselineTest('package review drains the triggered live-app scan before issuing any result', async () => {
    const f = await fixture();
    const gate = f.block();
    let scan, reviewPromise;
    try {
      f.state.opened = true;
      scan = f.live();
      await waitForCondition(() => f.entered(), 'triggered scan did not start');
      assert.equal(metadataTestHooks.getWatcherCoordinatorSnapshot(f.project.id).running, true);
      let reviewSettled = false;
      reviewPromise = callIpcRaw('projects:prepare-package-review', f.project.id).then(r => { reviewSettled = true; return r; });
      await new Promise(resolve => originalSetTimeout(resolve, 50));
      assert.equal(reviewSettled, false, 'review must await the owned live-app parser work');
      assert.equal(f.count(), 1);
      gate.release(); await scan;
      const review = await reviewPromise;
      assert.equal(review.token, undefined);
      assert.equal(review.error, 'asset_baseline_decision_required');
      await assertComplete(f);
    } finally { gate.release(); if (scan) await scan; if (reviewPromise) await reviewPromise; await f.cleanup(); }
  });

  baselineTest('pre-package admission waits for newly discovered links and retains its parent scope', async () => {
    // No early poll and no LINK rows: only the real source parser can discover
    // these relationships, changing scope while the pre-package caller owns it.
    const f = await fixture({ sources: 2, structuredLinks: false });
    const gate = f.block(1);
    let scan;
    try {
      const initial = await f.snapshot();
      assert.deepEqual(initial.files, []);
      assert.equal(initial.assetBaseline.status, 'awaiting-first-scan');
      assert.deepEqual(metadataTestHooks.getIllustratorActivationScopeSnapshot(f.project.id).allowedLinkedPaths, []);
      f.state.opened = true;
      let settled = false;
      scan = callIpcRaw('projects:pre-package-scan', f.project.id).then(result => { settled = true; return result; });
      await waitForCondition(() => f.entered(0) && f.entered(1), 'pre-package admission did not start both parser reads');
      await waitForCondition(() => metadataTestHooks.getBaselineState(f.project.id)?.completedSourceKeys.size === 1, 'unblocked sibling did not complete');
      await new Promise(resolve => originalSetTimeout(resolve, 50));
      assert.equal(settled, false, 'pre-package must await its admitted source cohort');
      assert.equal(f.count(0), 1); assert.equal(f.count(1), 1);
      const partial = await f.snapshot();
      assert.equal(partial.assetBaseline.status, 'awaiting-first-scan');
      assert.equal(partial.assetBaseline.failedRequiredSources, undefined);
      assert.equal(partial.files.some(row => row.path === f.paths[0].link), true);
      assert.equal(partial.files.some(row => row.path === f.paths[1].link), false);
      gate.release();
      const result = await scan;
      assert.ok(result && Array.isArray(result.files), 'discovered relationships must not stale the parent and return null');
      assert.equal(result.error, undefined);
      assert.equal(result.newCount, 2);
      for (const entry of f.paths) {
        assert.equal(result.files.filter(row => row.path === entry.source).length, 1);
        assert.equal(result.files.filter(row => row.path === entry.link).length, 1);
      }
      assert.deepEqual(metadataTestHooks.getIllustratorActivationScopeSnapshot(f.project.id).allowedLinkedPaths.sort(), f.paths.map(p => p.link.toLowerCase()).sort());
      assert.equal(partial.assetBaseline.status, 'awaiting-first-scan', 'partial snapshot must remain immutable');
      // One triggered baseline read plus the existing package-time raw-link
      // and double-check reads; unchanged live polls must add no further reads.

      // Explicitly retain the independently admitted second source.
      {
        const entry = (await callIpcRaw('projects:get-asset-workspace', f.project.id)).workingFileChoices.choices.find(row => row.source.name === 'Design_1.ai');
        assert.ok(entry?.ready, JSON.stringify(entry));
        assert.equal((await callIpcRaw('projects:resolve-working-file-choice', f.project.id,
          { id: entry.id, revision: entry.revision, choice: 'keep-both', predecessorIdentity: null })).success, true);
      }
      await assertComplete(f, 3);
      assert.equal(f.count(1), 3);
      for (let i = 0; i < 3; i++) await f.live();
      assert.equal(f.count(0), 3); assert.equal(f.count(1), 3);
    } finally { gate.release(); if (scan) await scan; await f.cleanup(); }
  });

  for (const invalidation of ['pause', 'account', 'scope']) {
    baselineTest(`pre-package admission rejects stale ${invalidation} during the owned parser read`, async () => {
      const f = await fixture({ structuredLinks: false });
      const gate = f.block();
      let scan;
      const originalGeneration = testAccountSession.generation;
      const originalStatus = testAccountSession.status;
      try {
        f.state.opened = true;
        scan = callIpcRaw('projects:pre-package-scan', f.project.id).then(result => ({ result }), error => ({ error }));
        await waitForCondition(() => f.entered(), 'pre-package parser read did not start');
        assert.equal(f.count(), 1);
        assert.equal((await f.current()).files.some(row => row.path === f.paths[0].source), true);
        if (invalidation === 'pause') await callIpcRaw('projects:pause', f.project.id);
        if (invalidation === 'account') {
          testAccountSession.invalidate();
          testAccountSession.status = { ...testAccountSession.status, identity: { id: 'different-synthetic-account' } };
        }
        // External scope revision is a synthetic cancellation fence, not a
        // substitute for the parser-driven scope change in the success case.
        if (invalidation === 'scope') metadataTestHooks.getProjectOperationScope(f.project.id).revision++;
        const fence = testRendererEvents.length;
        gate.release();
        const outcome = await scan;
        if (invalidation === 'account') {
          // The trusted IPC wrapper independently rejects expired account
          // authority after the handler returns; it must expose no result.
          assert.match(outcome.error?.message || '', /Sign in to Crate/);
          assert.equal(outcome.result, undefined);
        } else {
          assert.equal(outcome.error, undefined);
          assert.equal(outcome.result, null, 'a stale parent must not return successful package-scan files');
        }
        const old = storeInstance.data.projects.find(p => p.id === f.project.id);
        assert.equal(old.files.some(row => row.path === f.paths[0].link), false);
        assert.equal(old.assetBaseline.status, 'awaiting-first-scan');
        assert.equal(testRendererEvents.slice(fence).some(e => e.data?.projectId === f.project.id &&
          ['project:updated', 'files:updated', 'files:pending'].includes(e.channel)), false);
        assert.equal(f.count(), 1);
      } finally {
        gate.release(); if (scan) await scan;
        testAccountSession.generation = originalGeneration;
        testAccountSession.status = originalStatus;
        await f.cleanup();
      }
    });
  }

  baselineTest('two direct sources share one snapshot and finalise only after both dependable reads', async () => {
    const f = await fixture({ sources: 2 });
    const a = f.block(0), b = f.block(1);
    let scan;
    try {
      f.state.opened = true; scan = f.live();
      await waitForCondition(() => f.entered(0) && f.entered(1), 'two admitted sources did not both start');
      assert.equal(f.count(0), 1); assert.equal(f.count(1), 1);
      a.release();
      await waitForCondition(() => metadataTestHooks.getBaselineState(f.project.id)?.completedSourceKeys.size === 1, 'first source did not complete');
      const partial = await f.snapshot();
      assert.equal(partial.assetBaseline.status, 'awaiting-first-scan');
      assert.equal(partial.assetBaseline.failedRequiredSources, undefined, 'in-flight sibling must not acquire a failure receipt');
      assert.equal(partial.files.some(row => row.path === f.paths[0].link), true);
      assert.equal(partial.files.some(row => row.path === f.paths[1].link), false);
      b.release(); await scan;

      // Explicitly retain the independently admitted second source.
      {
        const entry = (await callIpcRaw('projects:get-asset-workspace', f.project.id)).workingFileChoices.choices.find(row => row.source.name === 'Design_1.ai');
        assert.ok(entry?.ready, JSON.stringify(entry));
        assert.equal((await callIpcRaw('projects:resolve-working-file-choice', f.project.id,
          { id: entry.id, revision: entry.revision, choice: 'keep-both', predecessorIdentity: null })).success, true);
      }
      await assertComplete(f);
      assert.equal(f.count(1), 1);
      assert.equal(partial.assetBaseline.status, 'awaiting-first-scan');
      for (let i = 0; i < 3; i++) await f.live();
      assert.equal(f.count(0), 1); assert.equal(f.count(1), 1);
    } finally { a.release(); b.release(); if (scan) await scan; await f.cleanup(); }
  });

  baselineTest('a newly admitted sibling does not requeue an already failed source', async () => {
    const f = await fixture({ sources: 2, malformed: true });
    try {
      f.state.visible = 1; f.state.opened = true;
      await f.live();
      assert.equal(f.count(0), 1); assert.equal(f.count(1), 0);
      writeSyntheticAiFile(f.paths[1].source, f.paths[1].link);
      f.state.visible = 2; await f.live();
      assert.equal(f.count(0), 1, 'new admission must not pass every required source to the queue');
      assert.equal(f.count(1), 1);
      const p = await f.current();
      assert.equal(p.assetBaseline.status, 'awaiting-first-scan');
      assert.equal(p.assetBaseline.failedRequiredSources.length, 1);
      assert.equal(p.files.some(row => row.path === f.paths[1].link), true);
      assert.equal(p.files.some(row => row.path === f.paths[0].link), false);
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).error, 'asset_baseline_scan_incomplete');
      for (let i = 0; i < 3; i++) await f.live();
      assert.equal(f.count(0), 1); assert.equal(f.count(1), 1);
    } finally { await f.cleanup(); }
  });


  baselineTest('working selection: real IPC, reload and re-admission preserve exclusion; Restore clears concrete obligations', async () => {
    const f = await fixture();
    try {
      f.state.opened = true; await f.live();
      await assertComplete(f);
      const initial = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      const row = initial.files.find(file => file.name === 'Design_0.ai');
      assert.equal(row.sourceSelection, 'selected');
      const previousReview = await callIpcRaw('projects:prepare-package-review', f.project.id);
      const sourceBytes = fs.readFileSync(f.paths[0].source);
      const exclusion = await callIpcRaw('projects:set-working-source-selection', f.project.id, row.visualIdentity,
        { action: 'exclude', expectedRevision: row.selectionRevision });
      assert.equal(exclusion.success, true);
      assert.equal(exclusion.selection.reason, 'user-excluded');
      assert.deepEqual(fs.readFileSync(f.paths[0].source), sourceBytes);
      assert.equal((await callIpcRaw('projects:package', f.project.id, TEST_HOME, previousReview.token)).error,
        'package_review_stale');
      // The link was captured only as this excluded file's dependency and was
      // admitted without owner intent (no flag, marker, Include or acceptance
      // record), so it is withheld and nothing selected cannot issue.
      const excludedProject = storeInstance.data.projects.find(p => p.id === f.project.id);
      assertNoOwnerIntent(excludedProject, excludedProject.files.find(file => file.name === 'Link_0.png'));
      const assetOnly = await callIpcRaw('projects:prepare-package-review', f.project.id);
      assert.equal(assetOnly.materializable, false);
      assert.deepEqual(assetOnly.files.map(file => file.name), []);
      assert.equal(assetOnly.semanticCounts.selectedWorkingSources, 0);
      assert.equal(assetOnly.semanticCounts.excludedWorkingSources, 1);
      assert.equal(assetOnly.semanticCounts.includedAssets, 0);
      assert.equal(assetOnly.semanticCounts.excludedAssets, 1);
      // Include All Existing while it is withheld keeps it for this exclusion.
      await callIpcRaw('projects:set-existing-assets-decision', f.project.id, 'include');
      roundTripFakeStore();
      let current = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      assert.equal(current.files.find(file => file.name === 'Link_0.png').included, true);
      assert.equal(current.files.find(file => file.name === 'Design_0.ai').selectionReason, 'user-excluded');
      const stored = storeInstance.data.projects.find(p => p.id === f.project.id);
      const source = stored.files.find(file => file.path === f.paths[0].source);
      stored.files = stored.files.filter(file => file !== source);
      stored.pendingFiles.push({ ...source, fileId: 'same-path-new-row', acceptedPending: false });
      roundTripFakeStore();
      await callIpcRaw('projects:accept-pending', f.project.id, f.paths[0].source);
      current = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      const readmitted = current.files.find(file => file.name === 'Design_0.ai');
      assert.equal(readmitted.sourceSelection, 'excluded');
      assert.equal(readmitted.selectionReason, 'user-excluded');
      // Re-admission of the same path keeps the same selection and exclusion.
      assert.deepEqual((await callIpcRaw('projects:prepare-package-review', f.project.id)).files.map(file => file.name), ['Link_0.png']);
      const restored = await callIpcRaw('projects:set-working-source-selection', f.project.id, readmitted.visualIdentity,
        { action: 'restore', expectedRevision: readmitted.selectionRevision });
      assert.equal(restored.success, true);
      assert.equal(restored.selection.reason, null);
      assert.equal(restored.verificationStatus, 'scanned');
      const verified = await callIpcRaw('projects:prepare-package-review', f.project.id);
      assert.equal(verified.materializable, true);
      assert.equal(typeof verified.token, 'string');
      assert.equal(verified.totalFiles, 2);
      assert.equal(verified.semanticCounts.unresolvedVerification, 0);
      assert.equal(verified.semanticCounts.missingRequiredReferences, 0);
      const freshWorkspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      assert.deepEqual(freshWorkspace.semanticCounts, verified.semanticCounts);
      const packaged = await callIpcRaw('projects:package', f.project.id, TEST_HOME, verified.token);
      assert.equal(packaged.success, true);
      assert.equal(packaged.totalFiles, verified.totalFiles);
      const outputNames = fs.readdirSync(packaged.folderPath, { recursive: true }).map(name => path.basename(name));
      assert.ok(outputNames.includes('Design_0.ai')); assert.ok(outputNames.includes('Link_0.png'));
    } finally { await f.cleanup(); }
  });

  baselineTest('publication correction: scoped copied rows preserve owned Exclude and Restore admission', async () => {
    const f = await fixture();
    try {
      f.state.opened = true; await f.live();
      await assertComplete(f);
      const initial = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      const row = initial.files.find(file => file.name === 'Design_0.ai');
      // A different open-before-Watch document forces the production scoped
      // projection to copy visible rows, including this accepted source.
      const scope = metadataTestHooks.getProjectOperationScope(f.project.id);
      scope.baselineDocumentPaths.add(path.join(TEST_HOME, 'Desktop', 'Hidden.ai').toLowerCase());
      const exclusion = await callIpcRaw('projects:set-working-source-selection', f.project.id, row.visualIdentity,
        { action: 'exclude', expectedRevision: row.selectionRevision });
      assert.equal(exclusion.success, true);
      const restoration = await callIpcRaw('projects:set-working-source-selection', f.project.id, row.visualIdentity,
        { action: 'restore', expectedRevision: exclusion.selection.revision });
      assert.equal(restoration.success, true);
      assert.equal(restoration.verificationStatus, 'scanned');
      const stored = storeInstance.data.projects.find(project => project.id === f.project.id);
      const before = JSON.stringify(stored.workingSourceSelections);
      // Foreign and pending-only identities never become accepted source rows.
      const foreign = await createProject('Foreign selection fixture');
      assert.equal((await callIpcRaw('projects:set-working-source-selection', foreign.id, row.visualIdentity,
        { action: 'exclude', expectedRevision: 0 })).error, 'working_source_not_found');
      const pending = { ...stored.files.find(file => file.path === f.paths[0].source),
        path: path.join(TEST_HOME, 'Desktop', 'Pending.ai'), name: 'Pending.ai', fileId: 'pending-only',
        acceptedPending: false, captureState: 'needs-save' };
      stored.pendingFiles.push(pending);
      assert.equal((await callIpcRaw('projects:set-working-source-selection', f.project.id,
        metadataTestHooks.createProjectFileVisualIdentity(f.project.id, pending),
        { action: 'exclude', expectedRevision: 0 })).error, 'working_source_not_found');
      assert.equal(JSON.stringify(stored.workingSourceSelections), before);
    } finally { await f.cleanup(); }
  });

  baselineTest('publication correction: package rows count an excluded required source as an asset', async () => {
    const f = await fixture({ sources: 2 });
    try {
      f.state.opened = true; await f.live();

      // Explicitly retain the independently admitted second source.
      {
        const entry = (await callIpcRaw('projects:get-asset-workspace', f.project.id)).workingFileChoices.choices.find(row => row.source.name === 'Design_1.ai');
        assert.ok(entry?.ready, JSON.stringify(entry));
        assert.equal((await callIpcRaw('projects:resolve-working-file-choice', f.project.id,
          { id: entry.id, revision: entry.revision, choice: 'keep-both', predecessorIdentity: null })).success, true);
      }
      await assertComplete(f);
      const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      fs.writeFileSync(f.paths[0].source, fs.readFileSync(f.paths[0].source, 'utf8')
        .replace('%%EOF', `${f.paths[1].source}\n%%EOF`));
      const root = workspace.files.find(file => file.name === 'Design_0.ai');
      assert.equal((await callIpcRaw('projects:set-working-source-selection', f.project.id, root.visualIdentity,
        { action: 'exclude', expectedRevision: root.selectionRevision })).success, true);
      assert.equal((await callIpcRaw('projects:set-working-source-selection', f.project.id, root.visualIdentity,
        { action: 'restore', expectedRevision: 1 })).success, true);
      const required = workspace.files.find(file => file.name === 'Design_1.ai');
      const result = await callIpcRaw('projects:set-working-source-selection', f.project.id, required.visualIdentity,
        { action: 'exclude', expectedRevision: required.selectionRevision });
      assert.equal(result.success, true);
      const review = await callIpcRaw('projects:prepare-package-review', f.project.id);
      const asset = review.files.find(file => file.name === 'Design_1.ai');
      assert.ok(asset);
      assert.equal(asset.sourceSelection, 'excluded');
      assert.equal(asset.includedAsDependency, true);
      assert.equal(asset.effectiveRole, 'asset');
      assert.equal(asset.projectRole, 'asset');
      // These are the current renderer's existing count predicates.
      assert.equal(review.files.filter(file => file.projectRole === 'source').length,
        review.semanticCounts.selectedWorkingSources);
      assert.equal(review.files.filter(file => file.projectRole !== 'source').length,
        review.semanticCounts.includedAssets);
    } finally { await f.cleanup(); }
  });

  baselineTest('publication correction: final package filters cannot silently omit a required source role', async () => {
    const f = await fixture({ sources: 2 });
    try {
      f.state.opened = true; await f.live();

      // Explicitly retain the independently admitted second source.
      {
        const entry = (await callIpcRaw('projects:get-asset-workspace', f.project.id)).workingFileChoices.choices.find(row => row.source.name === 'Design_1.ai');
        assert.ok(entry?.ready, JSON.stringify(entry));
        assert.equal((await callIpcRaw('projects:resolve-working-file-choice', f.project.id,
          { id: entry.id, revision: entry.revision, choice: 'keep-both', predecessorIdentity: null })).success, true);
      }
      await assertComplete(f);
      const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      fs.writeFileSync(f.paths[0].source, fs.readFileSync(f.paths[0].source, 'utf8')
        .replace('%%EOF', `${f.paths[1].source}\n%%EOF`));
      const root = workspace.files.find(file => file.name === 'Design_0.ai');
      const required = workspace.files.find(file => file.name === 'Design_1.ai');
      assert.equal((await callIpcRaw('projects:set-working-source-selection', f.project.id, root.visualIdentity,
        { action: 'exclude', expectedRevision: 0 })).success, true);
      const restored = await callIpcRaw('projects:set-working-source-selection', f.project.id, root.visualIdentity,
        { action: 'restore', expectedRevision: 1 });
      assert.equal(restored.verificationStatus, 'scanned');
      assert.equal((await callIpcRaw('projects:set-working-source-selection', f.project.id, required.visualIdentity,
        { action: 'exclude', expectedRevision: 0 })).success, true);
      const stored = storeInstance.data.projects.find(project => project.id === f.project.id);
      const file = stored.files.find(file => file.path === f.paths[1].source);
      file.source = 'lsof'; file.acceptedPending = true;
      stored.watchStartedAt = Date.now() + 60000;
      const key = metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(stored, file);
      stored.workingSourceVerification[key] = { ...stored.workingSourceVerification[key],
        status: 'unavailable', reason: 'not-scanned', sourceFingerprint: null, sourceIdentity: null,
        requiredReferences: [], unresolved: [] };
      assert.equal(metadataTestHooks.getWorkingSourceMembership(stored).blocked, false,
        'the tracked dependency exists and the untouched excluded role has no invented scan obligation');
      const selected = await metadataTestHooks.selectProjectFilesForPackaging(stored);
      assert.equal(selected.some(row => row.path === file.path), false, 'existing stale-lsof veto stays enforced');
      const review = await callIpcRaw('projects:prepare-package-review', f.project.id);
      assert.equal(review.materializable, false);
      assert.equal(review.token, undefined);
      assert.ok(review.semanticCounts.missingRequiredReferences > 0);
    } finally { await f.cleanup(); }
  });

  baselineTest('working selection: last failed source exclusion removes its baseline obligation and returns honest empty review', async () => {
    const f = await fixture({ malformed: true });
    try {
      f.state.opened = true; await f.live();
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).error, 'asset_baseline_scan_incomplete');
      const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      const source = workspace.files.find(file => file.name === 'Design_0.ai');
      const selected = await callIpcRaw('projects:set-working-source-selection', f.project.id, source.visualIdentity,
        { action: 'exclude', expectedRevision: source.selectionRevision });
      assert.equal(selected.success, true);
      const review = await callIpcRaw('projects:prepare-package-review', f.project.id);
      assert.equal(review.error, undefined);
      assert.equal(review.materializable, false);
      assert.equal(review.token, undefined);
      assert.equal(review.totalFiles, 0);
      assert.equal(review.message, 'No files are selected for packaging.');
      assert.equal(fs.existsSync(f.paths[0].source), true);
      assert.equal((await f.current()).files.length, 1);
    } finally { await f.cleanup(); }
  });

  baselineTest('working selection: current-byte changes block review and reject the earlier package token', async () => {
    const f = await fixture();
    try {
      f.state.opened = true; await f.live(); await assertComplete(f);
      await callIpcRaw('projects:set-existing-assets-decision', f.project.id, 'include');
      const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      const row = workspace.files.find(file => file.name === 'Design_0.ai');
      await callIpcRaw('projects:set-working-source-selection', f.project.id, row.visualIdentity, { action: 'exclude', expectedRevision: 0 });
      await callIpcRaw('projects:set-working-source-selection', f.project.id, row.visualIdentity, { action: 'restore', expectedRevision: 1 });
      const review = await callIpcRaw('projects:prepare-package-review', f.project.id);
      assert.equal(review.materializable, true);
      fs.appendFileSync(f.paths[0].source, '\nchanged saved bytes');
      const fresh = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      assert.equal(fresh.semanticCounts.unresolvedVerification, 1);
      const result = await callIpcRaw('projects:package', f.project.id, TEST_HOME, review.token);
      assert.equal(result.error, 'package_review_stale');
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).materializable, false);
    } finally { await f.cleanup(); }
  });

  baselineTest('working selection: excluding one source preserves untouched sibling readiness in the real workspace and review', async () => {
    const f = await fixture({ sources: 2 });
    try {
      f.state.opened = true; await f.live();
      // Explicitly retain the independently admitted second source.
      {
        const entry = (await callIpcRaw('projects:get-asset-workspace', f.project.id)).workingFileChoices.choices.find(row => row.source.name === 'Design_1.ai');
        assert.ok(entry?.ready, JSON.stringify(entry));
        assert.equal((await callIpcRaw('projects:resolve-working-file-choice', f.project.id,
          { id: entry.id, revision: entry.revision, choice: 'keep-both', predecessorIdentity: null })).success, true);
      }
      await assertComplete(f);
      await callIpcRaw('projects:set-existing-assets-decision', f.project.id, 'include');
      const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      const row = workspace.files.find(file => file.name === 'Design_0.ai');
      await callIpcRaw('projects:set-working-source-selection', f.project.id, row.visualIdentity, { action: 'exclude', expectedRevision: 0 });
      const review = await callIpcRaw('projects:prepare-package-review', f.project.id);
      assert.equal(review.materializable, true); assert.equal(review.semanticCounts.unresolvedVerification, 0);
      assert.equal(review.semanticCounts.selectedWorkingSources, 1); assert.equal(review.semanticCounts.excludedWorkingSources, 1);
      assert.equal(review.files.some(file => file.name === 'Design_0.ai'), false);
      assert.equal(review.files.some(file => file.name === 'Design_1.ai'), true);
      assert.deepEqual((await callIpcRaw('projects:get-asset-workspace', f.project.id)).semanticCounts, review.semanticCounts);
    } finally { await f.cleanup(); }
  });

  baselineTest('working selection: workspace publication rechecks an exclusion made during its async presentation', async () => {
    const f = await fixture();
    let restoreEligibility;
    let workspace;
    const gate = deferred();
    try {
      f.state.opened = true; await f.live();
      await assertComplete(f);
      const initial = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      const source = initial.files.find(file => file.name === 'Design_0.ai');
      let entered = false;
      restoreEligibility = metadataTestHooks.pauseRecoveryEligibility(async () => { entered = true; await gate.promise; });
      workspace = callIpcRaw('projects:get-asset-workspace', f.project.id);
      await waitForCondition(() => entered, 'workspace presentation did not pause');
      await callIpcRaw('projects:set-working-source-selection', f.project.id, source.visualIdentity,
        { action: 'exclude', expectedRevision: source.selectionRevision });
      gate.release();
      const current = await workspace;
      assert.equal(current.files.find(file => file.name === 'Design_0.ai').sourceSelection, 'excluded');
      assert.equal(current.semanticCounts.excludedWorkingSources, 1);
    } finally {
      gate.release(); if (workspace) await workspace;
      restoreEligibility?.(); await f.cleanup();
    }
  });

  for (const mode of ['zero', 'present', 'missing', 'pathless', 'audio']) {
    baselineTest(`PSD Restore main IPC uses actual parser and preserves ${mode} obligations`, async () => {
      resetTestHomeWorkspace();
      const actual = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
      const filePath = path.join(TEST_HOME, 'Desktop', 'Restore.psd');
      const linkPath = path.join(TEST_HOME, 'Desktop', 'Linked.png');
      if (mode === 'present') fs.writeFileSync(linkPath, 'synthetic linked bytes');
      const linkedFiles = ['present', 'missing', 'pathless'].includes(mode) ? [{
        id: '11111111-1111-4111-8111-111111111111', name: 'Linked.png', childDocumentID: '',
        linkedFile: { fileSize: 10, name: 'Linked.png', fullPath: mode === 'pathless' ? '' : linkPath,
          originalPath: linkPath, relativePath: '../Linked.png' },
      }] : [];
      const zero = { numerator: 0, denominator: 1 }, second = { numerator: 1, denominator: 1 };
      const imageResources = mode === 'audio' ? { timelineInformation: { enabled: true, frameStep: second, frameRate: 24,
        time: zero, duration: second, workInTime: zero, workOutTime: second, repeats: 0, hasMotion: true, globalTracks: [],
        audioClipGroups: [{ id: 'group', muted: false, audioClips: [{ id: 'clip', start: zero, duration: second,
          inTime: zero, outTime: second, muted: false, audioLevel: 0, frameReader: { type: 1, mediaDescriptor: '',
            link: { name: 'Audio.wav', fullPath: path.join(TEST_HOME, 'Desktop', 'Audio.wav'), relativePath: '../Audio.wav' } } }] }],
      } } : {};
      fs.writeFileSync(filePath, actual.writePsdBuffer({ width: 1, height: 1, linkedFiles, imageResources }));
      currentPsdFixture = 'actual-source-buffer';
      try {
        const created = await createProject('PSD Restore route'); clearTrackedTimers();
        const project = storeInstance.data.projects.find(p => p.id === created.id);
        project.assetBaseline = { schemaVersion: 1, status: 'legacy-included', decision: 'include', establishedAt: Date.now() };
        project.files.push({ path: filePath, name: 'Restore.psd', ext: '.psd', source: 'user-added',
          acceptedPending: true, projectRole: 'source', addedAt: Date.now() });
        const workspace = await callIpcRaw('projects:get-asset-workspace', project.id);
        const row = workspace.files.find(file => file.name === 'Restore.psd');
        await callIpcRaw('projects:set-working-source-selection', project.id, row.visualIdentity,
          { action: 'exclude', expectedRevision: row.selectionRevision });
        const result = await callIpcRaw('projects:set-working-source-selection', project.id, row.visualIdentity,
          { action: 'restore', expectedRevision: row.selectionRevision + 1 });
        assert.equal(result.success, true); assert.equal(result.verificationStatus, 'scanned');
        const current = storeInstance.data.projects.find(p => p.id === project.id);
        const verification = Object.values(current.workingSourceVerification)[0];
        assert.equal(verification.provider, 'psd-agpsd-worker');
        assert.equal(verification.inventoryStatus, 'unverified');
        assert.equal(verification.sourceFingerprint, crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'));
        const review = await callIpcRaw('projects:prepare-package-review', project.id);
        const freshWorkspace = await callIpcRaw('projects:get-asset-workspace', project.id);
        assert.deepEqual(freshWorkspace.semanticCounts, review.semanticCounts);
        if (['zero', 'present'].includes(mode)) {
          assert.equal(review.materializable, true);
          assert.equal(review.totalFiles, mode === 'present' ? 2 : 1);
        } else {
          assert.equal(review.materializable, false); assert.equal(review.token, undefined);
          if (mode === 'missing') assert.equal(review.semanticCounts.missingRequiredReferences, 1);
          else assert.ok(review.semanticCounts.unresolvedVerification > 0);
        }
        if (mode === 'audio') assert.ok(verification.unresolved.some(item => item.reason === 'unverified-timeline-frame-reader-type'));
      } finally { currentPsdFixture = { children: [], linkedFiles: [] }; clearTrackedTimers(); }
    });
  }

  async function correctionProject(ext, content = 'synthetic source bytes') {
    resetTestHomeWorkspace();
    setChildProcessHandler(() => ({ stdout: '' }));
    const created = await createProject('Confirmed correction ' + ext); clearTrackedTimers();
    const project = storeInstance.data.projects.find(p => p.id === created.id);
    project.assetBaseline = { schemaVersion: 1, status: 'legacy-included', decision: 'include', establishedAt: Date.now() };
    const filePath = path.join(TEST_HOME, 'Desktop', 'Correction' + ext);
    fs.writeFileSync(filePath, content);
    project.files.push({ path: filePath, name: path.basename(filePath), ext, source: 'user-added',
      acceptedPending: true, projectRole: 'source', addedAt: Date.now() });
    return { project, filePath, current: () => storeInstance.data.projects.find(p => p.id === project.id) };
  }

  async function ordinaryFailureCase(ext, mode) {
    const f = await correctionProject(ext);
    const known = path.join(TEST_HOME, 'Desktop', 'PreviouslyKnown.png');
    const fresh = path.join(TEST_HOME, 'Desktop', 'NewlyFound.png');
    fs.writeFileSync(known, 'known fixture'); fs.writeFileSync(fresh, 'fresh fixture');
    const container = ['.sketch', '.afdesign', '.afphoto', '.afpub', '.pxd'].includes(ext);
    const originalRead = fs.promises.readFile;
    const budgets = require('../parsers/admission-budgets');
    const originalBudgetRead = budgets.readFileWithinBudget;
    let phase = mode === 'zero' ? 'zero' : 'initial';
    setChildProcessHandler(({ command, args }) => {
      if (command !== '/usr/bin/unzip') return { stdout: '' };
      if (args[0] === '-l') {
        if (phase === 'listing-failure') return { error: new Error('F4 listing refusal') };
        return { stdout: '     100  01-01-2026  00:00   good.json\n     100  01-01-2026  00:00   bad.json\n' };
      }
      if (args[0] === '-p') {
        if (phase === 'partial-failure' && args[2] === 'bad.json') return { error: new Error('F4 entry refusal') };
        return { stdout: phase === 'zero' ? '{}' : JSON.stringify({ link: phase === 'initial' ? known : fresh }) };
      }
      return { stdout: '' };
    });
    if (ext === '.pptx') writeLinkedPresentationArchive(f.filePath, phase === 'zero' ? null : known);
    else if (!container) fs.writeFileSync(f.filePath, phase === 'zero' ? 'empty source' : known);
    budgets.readFileWithinBudget = function controlledPresentationRead(file, ...args) {
      if (ext === '.pptx' && phase === 'read-failure' && path.resolve(file) === f.filePath) throw new Error('F4 ordinary read refusal');
      return originalBudgetRead.call(this, file, ...args);
    };
    fs.promises.readFile = async function controlledExtractorRead(file, ...args) {
      if (phase === 'read-failure' && path.resolve(file) === f.filePath) throw new Error('F4 ordinary read refusal');
      return originalRead.call(fs.promises, file, ...args);
    };
    const scan = () => metadataTestHooks.runScanOnOpen(f.project.id, f.filePath, null, null, { allowPausedBaseline: true });
    try {
      assert.equal((await scan()).success, true);
      const initial = Object.values(f.current().workingSourceVerification)[0];
      assert.equal(initial.status, 'scanned');
      if (mode === 'zero') {
        assert.deepEqual(initial.requiredReferences, []);
        assert.equal(initial.reason, 'ordinary-scan-finished');
        return;
      }
      assert.ok(initial.requiredReferences.some(ref => ref.path === known));
      phase = mode;
      const result = await scan();
      assert.equal(result.success, true, 'legacy capture remains lenient');
      const record = Object.values(f.current().workingSourceVerification)[0];
      assert.equal(record.status, 'failed', 'extractor refusal must not certify empty success');
      assert.equal(record.reason, 'source-verification-unavailable');
      assert.ok(record.requiredReferences.some(ref => ref.path === known), 'prior declared reference survives');
      assert.notEqual(record.inventoryStatus, 'complete');
      assert.ok([...f.current().files, ...(f.current().pendingFiles || [])].some(row => row.path === known));
      if (mode === 'partial-failure') {
        assert.ok(record.requiredReferences.some(ref => ref.path === fresh));
        assert.ok([...f.current().files, ...(f.current().pendingFiles || [])].some(row => row.path === fresh),
          'successful legacy entries still admit beside a refused entry');
      }
      f.current().workingSourceSelections = {};
      assert.equal((await scan()).success, false, 'engaged verification still rejects extraction refusal');
      assert.equal(Object.values(f.current().workingSourceVerification)[0].status, 'failed');
    } finally { budgets.readFileWithinBudget = originalBudgetRead; fs.promises.readFile = originalRead; clearTrackedTimers(); }
  }

  for (const ext of ['.sketch', '.afdesign', '.afphoto', '.afpub', '.pxd']) {
    for (const mode of ['zero', 'partial-failure', 'listing-failure']) {
      baselineTest(`F4 ordinary ${ext} ${mode}: honest status and retained legacy roles`, () => ordinaryFailureCase(ext, mode));
    }
  }
  for (const ext of ['.xd', '.ppt', '.fig', '.pptx', '.key']) {
    for (const mode of ['zero', 'read-failure']) {
      baselineTest(`F4 ordinary ${ext} ${mode}: honest status and retained legacy roles`, () => ordinaryFailureCase(ext, mode));
    }
  }

  baselineTest('F4 InDesign query refusal retains prior references and lenient fallback capture', async () => {
    const f = await correctionProject('.indd');
    const known = path.join(TEST_HOME, 'Desktop', 'KnownInDesign.png');
    const fresh = path.join(TEST_HOME, 'Desktop', 'FallbackInDesign.png');
    fs.writeFileSync(known, 'known fixture'); fs.writeFileSync(fresh, 'fresh fixture');
    let refused = false;
    setChildProcessHandler(({ kind, command, args }) => {
      if (String(command).includes('Adobe InDesign')) return { stdout: 'synthetic running InDesign' };
      if (isOsascriptInvocation({ kind, command, args }, 'crate-indd-query.applescript')) {
        return refused ? { error: new Error('F4 InDesign query refusal') } : { stdout:
          `DOC\t${f.filePath}\tCorrection.indd\tfalse\ttrue\t1\nLINK\t${f.filePath}\tCorrection.indd\t${known}\tfalse\ttrue\nEND\t1\t1\t1\t0\n` };
      }
      return { stdout: '' };
    });
    const scan = () => metadataTestHooks.runScanOnOpen(f.project.id, f.filePath, null, null, { allowPausedBaseline: true });
    try {
      assert.equal((await scan()).success, true);
      assert.ok(Object.values(f.current().workingSourceVerification)[0].requiredReferences.some(ref => ref.path === known));
      refused = true; fs.writeFileSync(f.filePath, fresh);
      assert.equal((await scan()).success, true);
      const record = Object.values(f.current().workingSourceVerification)[0];
      assert.equal(record.status, 'failed'); assert.equal(record.reason, 'source-verification-unavailable');
      for (const linked of [known, fresh]) {
        assert.ok(record.requiredReferences.some(ref => ref.path === linked));
        assert.ok([...f.current().files, ...(f.current().pendingFiles || [])].some(row => row.path === linked));
      }
      f.current().workingSourceSelections = {};
      assert.equal((await scan()).success, false, 'strict query refusal still rejects');
    } finally { clearTrackedTimers(); }
  });

  baselineTest('F4 InDesign closed-app empty fallback remains an ordinary scan success', async () => {
    const f = await correctionProject('.indd');
    setChildProcessHandler(() => ({ stdout: '' }));
    try {
      assert.equal((await metadataTestHooks.runScanOnOpen(f.project.id, f.filePath, null, null,
        { allowPausedBaseline: true })).success, true);
      const record = Object.values(f.current().workingSourceVerification)[0];
      assert.equal(record.status, 'scanned'); assert.deepEqual(record.requiredReferences, []);
      assert.equal(record.reason, 'ordinary-scan-finished');
    } finally { clearTrackedTimers(); }
  });

  baselineTest('F4 ordinary extractor size limit is explicit and strict mode still rejects', async () => {
    const f = await correctionProject('.xd');
    const originalStat = fs.promises.stat;
    fs.promises.stat = async function oversizedExtractorStat(file, ...args) {
      const stat = await originalStat.call(fs.promises, file, ...args);
      return path.resolve(file) === f.filePath ? new Proxy(stat, { get(target, key) {
        return key === 'size' ? 2 ** 31 : Reflect.get(target, key);
      } }) : stat;
    };
    try {
      const limits = []; let failures = 0;
      assert.deepEqual(await metadataTestHooks.extractLinkedAssets(f.filePath, {
        onOrdinaryScanLimit: reason => limits.push(reason), onOrdinaryScanFailure: () => failures++,
      }), []);
      assert.deepEqual(limits, ['source-too-large']); assert.equal(failures, 0);
      await assert.rejects(metadataTestHooks.extractLinkedAssets(f.filePath, { strict: true }), /asset_baseline_source_too_large/);
    } finally { fs.promises.stat = originalStat; clearTrackedTimers(); }
  });

  baselineTest('F4 genuinely oversized sparse source is limited without false byte-change evidence', async () => {
    const f = await correctionProject('.xd');
    const originalSize = fs.statSync(f.filePath).size;
    try {
      // Owned sparse fixture: actual stat/digest/extractor views all see the
      // same oversized source. No allocation or read of a multi-gigabyte buffer.
      fs.truncateSync(f.filePath, 2 ** 31);
      assert.equal(fs.statSync(f.filePath).size, 2 ** 31);
      const result = await metadataTestHooks.runScanOnOpen(f.project.id, f.filePath, null, null, { allowPausedBaseline: true });
      assert.equal(result.success, true, 'size refusal must not tighten legacy admission');
      const record = Object.values(f.current().workingSourceVerification)[0];
      assert.equal(record.status, 'limited'); assert.equal(record.reason, 'ordinary-extractor-source-too-large');
      assert.equal(record.sourceFingerprint, null); assert.notEqual(record.inventoryStatus, 'complete');
      f.current().workingSourceSelections = {};
      assert.equal((await metadataTestHooks.runScanOnOpen(f.project.id, f.filePath, null, null,
        { allowPausedBaseline: true })).success, false, 'strict source size refusal still rejects');
    } finally { fs.truncateSync(f.filePath, originalSize); clearTrackedTimers(); }
  });

  baselineTest('F7 mixed-case encoded IDML file schemes preserve lowercase decoding and path boundaries', async () => {
    const f = await correctionProject('.idml');
    const linked = path.join(TEST_HOME, 'Desktop', 'Encoded image#.png');
    const outside = '/private/Encoded outside.png';
    let scheme = 'file:';
    setChildProcessHandler(({ command, args }) => command === '/usr/bin/unzip' ? { stdout: args[0] === '-l'
      ? '     100  01-01-2026  00:00   document.xml\n'
      : `<Link LinkResourceURI="${scheme}${encodeURI(linked).replace('#', '%23')}"/><Link LinkResourceURI="${scheme}${encodeURI(outside)}"/>` } : { stdout: '' });
    const lower = await metadataTestHooks.extractLinkedAssetsIdml(f.filePath);
    assert.ok(lower.includes(linked)); assert.ok(!lower.includes(outside));
    for (scheme of ['FILE:', 'FiLe:']) {
      const issues = [];
      assert.deepEqual(await metadataTestHooks.extractLinkedAssetsIdml(f.filePath), lower);
      const verified = await metadataTestHooks.extractLinkedAssetsIdml(f.filePath, {
        strict: true, ordinaryVerification: true, onUnresolvedDependency: reason => issues.push(reason),
      });
      assert.ok(verified.includes(linked)); assert.ok(verified.includes(outside));
      assert.deepEqual(issues, ['unsupported-declared-link-uri'], 'only the outside admission path is unresolved');
    }
    clearTrackedTimers();
  });

  baselineTest('F7 unsupported IDML schemes remain declared obligations without path admission', async () => {
    const f = await correctionProject('.idml');
    setChildProcessHandler(({ command, args }) => command === '/usr/bin/unzip' ? { stdout: args[0] === '-l'
      ? '     100  01-01-2026  00:00   document.xml\n'
      : '<Link LinkResourceURI="https://example.invalid/Required.png"/><Link LinkResourceURI="FiLeX:../Required.png"/>' } : { stdout: '' });
    const issues = [];
    assert.deepEqual(await metadataTestHooks.extractLinkedAssetsIdml(f.filePath, {
      strict: true, ordinaryVerification: true, onUnresolvedDependency: reason => issues.push(reason),
    }), []);
    assert.deepEqual(issues, ['unsupported-declared-link-uri', 'unsupported-declared-link-uri']);
    const result = await metadataTestHooks.runScanOnOpen(f.project.id, f.filePath, null, null, { allowPausedBaseline: true });
    assert.equal(result.success, true);
    const record = Object.values(f.current().workingSourceVerification)[0];
    assert.equal(record.unresolved.length, 2);
    assert.ok(record.unresolved.every(item => item.reason === 'unsupported-declared-link-uri'));
    clearTrackedTimers();
  });

  async function f1LinkedRecheck(mode, strictKind = null) {
    const f = await correctionProject('.ai');
    const linked = path.join(TEST_HOME, 'Desktop', 'F1-linked.png');
    fs.writeFileSync(linked, 'synthetic linked asset');
    fs.writeFileSync(f.filePath, `%PDF-1.7\n${linked}\n%%EOF\n`);
    if (strictKind === 'baseline') f.current().assetBaseline = { schemaVersion: 1, status: 'awaiting-first-scan' };
    if (strictKind === 'selection') f.current().workingSourceSelections = {};
    const frozenStat = fs.statSync(f.filePath);
    const originalRead = fs.promises.readFile, originalOpen = fs.promises.open, originalStat = fs.promises.stat;
    let reached = false;
    fs.promises.readFile = async function moveAfterOrdinaryRead(filePath, ...args) {
      const data = await originalRead.call(fs.promises, filePath, ...args);
      if (filePath === f.filePath && !reached) {
        reached = true;
        if (mode === 'same-identity') fs.writeFileSync(filePath, data.toString().replace('%PDF-1.7', '%PDF-1.6'));
        else if (mode !== 'read-refusal') fs.appendFileSync(filePath, '\nsource moved during extraction');
      }
      return data;
    };
    fs.promises.stat = async function controlledStat(filePath, ...args) {
      if (mode === 'same-identity' && filePath === f.filePath && !args[0]?.bigint) return frozenStat;
      return originalStat.call(fs.promises, filePath, ...args);
    };
    fs.promises.open = async function controlledOpen(filePath, ...args) {
      if (mode === 'read-refusal' && filePath === f.filePath && reached) throw new Error('synthetic recheck read refusal');
      const handle = await originalOpen.call(fs.promises, filePath, ...args);
      if (mode === 'same-identity' && filePath === f.filePath) {
        const originalHandleStat = handle.stat.bind(handle);
        handle.stat = options => options?.bigint ? originalHandleStat(options) : Promise.resolve(frozenStat);
      }
      return handle;
    };
    try {
      const result = await metadataTestHooks.runScanOnOpen(f.project.id, f.filePath, null, null, { allowPausedBaseline: true });
      assert.equal(reached, true, 'fixture moves/refuses after initial digest, during extraction');
      const admitted = [...f.current().files, ...(f.current().pendingFiles || [])].filter(file => file.path === linked);
      const record = Object.values(f.current().workingSourceVerification)[0];
      if (strictKind) {
        assert.equal(result.success, false);
        assert.equal(result.error, strictKind === 'baseline' ? 'asset_baseline_scan_incomplete' : 'scan_on_open_failed');
        assert.equal(admitted.length, 0); assert.equal(record.status, 'failed');
      } else {
        assert.equal(result.success, true, 'legacy admission must survive a side-ledger recheck refusal');
        assert.equal(admitted.length, 1);
        assert.equal(record.status, mode === 'read-refusal' ? 'failed' : 'stale');
        assert.equal(record.reason, mode === 'read-refusal' ? 'source-verification-unavailable' : 'source-bytes-changed');
        assert.equal(record.sourceFingerprint, null);
        assert.equal(record.requiredReferences[0].path, linked);
        assert.notEqual(record.inventoryStatus, 'complete');
      }
    } finally {
      fs.promises.readFile = originalRead; fs.promises.open = originalOpen; fs.promises.stat = originalStat;
      clearTrackedTimers();
    }
  }

  for (const mode of ['stat-change', 'same-identity', 'read-refusal']) {
    baselineTest(`F1 recheck: untouched linked admission survives ${mode}`, () => f1LinkedRecheck(mode));
  }
  for (const strictKind of ['baseline', 'selection']) {
    baselineTest(`F1 recheck: ${strictKind} still rejects moving source bytes`, () => f1LinkedRecheck('stat-change', strictKind));
  }

  baselineTest('F1 recheck: legacy PSD admits owned embedded output after source movement', async () => {
    const f = await correctionProject('.psd');
    const originalTmpdir = os.tmpdir;
    const privateTmp = fs.mkdtempSync(path.join(TEST_HOME, 'Documents', 'f1-owned-tmp-'));
    os.tmpdir = () => privateTmp;
    const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XcAAAAASUVORK5CYII=', 'base64');
    let parsed = false;
    currentPsdFixture = () => {
      parsed = true; fs.appendFileSync(f.filePath, '\nchanged after ordinary linked-path extraction');
      return { children: [], linkedFiles: [{ name: 'F1-embedded.png', data }] };
    };
    try {
      const result = await metadataTestHooks.runScanOnOpen(f.project.id, f.filePath, null, null, { allowPausedBaseline: true });
      assert.equal(parsed, true);
      assert.equal(result.success, true, 'post-parser recheck must not abort legacy PSD admission');
      const admitted = [...f.current().files, ...(f.current().pendingFiles || [])]
        .filter(file => file.source === 'psd-embedded' && file.name === 'F1-embedded.png');
      assert.equal(admitted.length, 1);
      assert.ok(admitted[0].path.startsWith(privateTmp + path.sep));
      assert.deepEqual(fs.readFileSync(admitted[0].path), data);
      const record = Object.values(f.current().workingSourceVerification)[0];
      assert.equal(record.status, 'stale'); assert.equal(record.sourceFingerprint, null);
      assert.notEqual(record.inventoryStatus, 'complete');
    } finally {
      currentPsdFixture = { children: [], linkedFiles: [] }; os.tmpdir = originalTmpdir;
      metadataTestHooks.clearPsdParseDebounce(f.filePath);
      fs.rmSync(privateTmp, { recursive: true, force: true }); clearTrackedTimers();
    }
  });

  baselineTest('confirmed correction 1: legacy auto masters dedupe while explicit and selected roots remain independent', async () => {
    const f = await correctionProject('.ai', '%PDF-1.7\n%%EOF\n');
    const second = path.join(TEST_HOME, 'Desktop', 'second', path.basename(f.filePath));
    fs.mkdirSync(path.dirname(second)); fs.copyFileSync(f.filePath, second);
    f.project.files[0].source = 'auto-captured'; delete f.project.files[0].acceptedPending;
    f.project.files.push({ ...f.project.files[0], path: second });
    assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).totalFiles, 1);
    f.current().files.forEach(file => { file.source = 'manual'; file.acceptedPending = true; });
    assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).totalFiles, 2);
    f.current().files.forEach(file => { file.source = 'auto-captured'; delete file.acceptedPending; });
    f.current().workingSourceSelections = {};
    assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).totalFiles, 2);
    clearTrackedTimers();
  });

  baselineTest('confirmed correction 2: IDML extra paths are verification evidence only', async () => {
    const f = await correctionProject('.idml');
    const supported = path.join(TEST_HOME, 'Desktop', 'Supported.png');
    const extra = '/private/Required.png';
    setChildProcessHandler(({ command, args }) => command === '/usr/bin/unzip' ? { stdout: args[0] === '-l'
      ? '     100  01-01-2026  00:00   document.xml\n'
      : `<Link LinkResourceURI="file:${supported}"/><Link LinkResourceURI="file:${extra}"/>` } : { stdout: '' });
    const legacy = await metadataTestHooks.extractLinkedAssetsIdml(f.filePath);
    assert.deepEqual(legacy, [supported]);
    const issues = [];
    const verified = await metadataTestHooks.extractLinkedAssetsIdml(f.filePath,
      { strict: true, ordinaryVerification: true, onUnresolvedDependency: reason => issues.push(reason) });
    assert.deepEqual(verified, [supported, extra]);
    assert.deepEqual(issues, ['unsupported-declared-link-uri']);
    clearTrackedTimers();
  });

  baselineTest('confirmed correction 3: malformed ordinary AI stays lenient while baseline and selection remain strict', async () => {
    const f = await correctionProject('.ai', '%PDF-1.7\nmissing EOF');
    const scan = () => metadataTestHooks.runScanOnOpen(f.project.id, f.filePath, null, null, { allowPausedBaseline: true });
    assert.equal((await scan()).success, true);
    assert.equal(Object.values(f.current().workingSourceVerification)[0].status, 'scanned');
    f.current().assetBaseline = { schemaVersion: 1, status: 'awaiting-first-scan' };
    assert.equal((await scan()).error, 'asset_baseline_scan_incomplete');
    f.current().assetBaseline = { schemaVersion: 1, status: 'legacy-included', decision: 'include' };
    f.current().workingSourceSelections = {};
    assert.equal((await scan()).error, 'scan_on_open_failed');
    assert.equal(Object.values(f.current().workingSourceVerification)[0].status, 'failed');
    clearTrackedTimers();
  });

  baselineTest('confirmed correction 3: lenient IDML entry failure does not tighten untouched admission', async () => {
    const f = await correctionProject('.idml');
    const link = path.join(TEST_HOME, 'Desktop', 'Required.png'); fs.writeFileSync(link, 'synthetic asset');
    setChildProcessHandler(({ command, args }) => {
      if (command !== '/usr/bin/unzip') return { stdout: '' };
      if (args[0] === '-l') return { stdout: '     100  01-01-2026  00:00   good.xml\n     100  01-01-2026  00:00   failed.xml\n' };
      if (args[2] === 'failed.xml') return { error: new Error('synthetic unreadable entry') };
      return { stdout: `<Link LinkResourceURI="file:${link}"/>` };
    });
    const scan = () => metadataTestHooks.runScanOnOpen(f.project.id, f.filePath, null, null, { allowPausedBaseline: true });
    assert.equal((await scan()).success, true);
    assert.equal(Object.values(f.current().workingSourceVerification)[0].requiredReferences[0].path, link);
    assert.equal(Object.values(f.current().workingSourceVerification)[0].status, 'failed');
    f.current().workingSourceSelections = {};
    assert.equal((await scan()).success, false);
    clearTrackedTimers();
  });

  baselineTest('confirmed correction 3: untouched PSD retains ordinary parser route and debounce', async () => {
    const f = await correctionProject('.psd'); let parses = 0;
    currentPsdFixture = () => { parses++; return { children: [], linkedFiles: [] }; };
    try {
      const scan = () => metadataTestHooks.runScanOnOpen(f.project.id, f.filePath, null, null, { allowPausedBaseline: true });
      assert.equal((await scan()).success, true); assert.equal(parses, 1);
      assert.equal(Object.values(f.current().workingSourceVerification)[0].provider, 'psd-ordinary');
      assert.equal((await scan()).skipped, 'ordinary-scan-debounced'); assert.equal(parses, 1);
      assert.equal(Object.values(f.current().workingSourceVerification)[0].status, 'scanned');
      fs.appendFileSync(f.filePath, '\nchanged saved bytes');
      assert.equal((await scan()).skipped, 'ordinary-scan-debounced'); assert.equal(parses, 1);
      assert.equal(Object.values(f.current().workingSourceVerification)[0].status, 'incomplete');
      assert.notEqual(Object.values(f.current().workingSourceVerification)[0].inventoryStatus, 'complete');
      metadataTestHooks.clearPsdParseDebounce(f.filePath);
      currentPsdFixture = new Error('synthetic ordinary parser failure');
      assert.equal((await scan()).success, true);
      assert.equal(Object.values(f.current().workingSourceVerification)[0].status, 'failed');
    } finally { currentPsdFixture = { children: [], linkedFiles: [] }; clearTrackedTimers(); }
  });

  baselineTest('confirmed correction 3: side-ledger digest refusal does not block legacy capture', async () => {
    const f = await correctionProject('.ai');
    const originalOpen = fs.promises.open;
    fs.promises.open = async function failLedgerOpen(filePath, ...args) {
      if (filePath === f.filePath) throw new Error('synthetic digest open refusal');
      return originalOpen.call(fs.promises, filePath, ...args);
    };
    try {
      const result = await metadataTestHooks.runScanOnOpen(f.project.id, f.filePath, null, null, { allowPausedBaseline: true });
      assert.equal(result.success, true);
      const record = Object.values(f.current().workingSourceVerification)[0];
      assert.equal(record.status, 'failed'); assert.equal(record.reason, 'source-verification-unavailable');
      assert.equal(record.sourceFingerprint, null);
    } finally { fs.promises.open = originalOpen; clearTrackedTimers(); }
  });

  baselineTest('confirmed correction 4: closed InDesign still fails first-scan baseline dependability', async () => {
    const f = await correctionProject('.indd');
    f.current().assetBaseline = { schemaVersion: 1, status: 'awaiting-first-scan' };
    setChildProcessHandler(() => ({ error: new Error('synthetic process check failure') }));
    const result = await metadataTestHooks.runScanOnOpen(f.project.id, f.filePath, null, null, { allowPausedBaseline: true });
    assert.equal(result.error, 'asset_baseline_scan_incomplete');
    assert.equal(Object.values(f.current().workingSourceVerification)[0].status, 'failed');
    clearTrackedTimers();
  });


  baselineTest('cycle2: untouched vetoed root keeps legacy readiness and final counts', async () => {
    const f = await correctionProject('.ai', '%PDF-1.7\n%%EOF\n');
    try {
      const project = f.current();
      project.files[0].source = 'lsof'; project.files[0].acceptedPending = true;
      project.watchStartedAt = Date.now() + 60000;
      const sibling = path.join(TEST_HOME, 'Desktop', 'Excluded.ai'); fs.writeFileSync(sibling, '%PDF-1.7\n%%EOF\n');
      const asset = path.join(TEST_HOME, 'Desktop', 'Kept.png'); fs.writeFileSync(asset, 'kept asset');
      project.files.push({ path: sibling, name: 'Excluded.ai', ext: '.ai', source: 'user-added', projectRole: 'source', acceptedPending: true },
        { path: asset, name: 'Kept.png', ext: '.png', source: 'user-added', projectRole: 'asset', acceptedPending: true });
      const workspace = await callIpcRaw('projects:get-asset-workspace', project.id);
      const row = workspace.files.find(file => file.name === 'Excluded.ai');
      await callIpcRaw('projects:set-working-source-selection', project.id, row.visualIdentity, { action: 'exclude', expectedRevision: 0 });
      const review = await callIpcRaw('projects:prepare-package-review', project.id);
      assert.equal(review.materializable, true); assert.deepEqual(review.files.map(file => file.name), ['Kept.png']);
      assert.equal(review.semanticCounts.selectedWorkingSources, 0);
      assert.equal(review.semanticCounts.includedAssets, 1);
      const latest = await callIpcRaw('projects:get-asset-workspace', project.id);
      assert.deepEqual(latest.semanticCounts, review.semanticCounts); assert.equal(latest.workingSourceSelectionBlocked, false);
      const source = f.current().files.find(file => file.path === f.filePath);
      const key = metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.current(), source);
      const priorSource = source.source, priorWatch = f.current().watchStartedAt;
      source.source = 'user-added'; f.current().watchStartedAt = 0;
      assert.equal((await metadataTestHooks.runScanOnOpen(project.id, source.path, null, null, { establishBaseline: false, allowPausedBaseline: true })).success, true);
      assert.equal(f.current().workingSourceVerification[key].status, 'scanned');
      assert.deepEqual(f.current().workingSourceVerification[key].requiredReferences, []);
      source.source = priorSource; f.current().watchStartedAt = priorWatch;
      const cleanDormant = await callIpcRaw('projects:prepare-package-review', project.id);
      assert.equal(cleanDormant.materializable, true, 'clean dormant revision zero retains observer veto');
      assert.deepEqual(cleanDormant.files.map(file => file.name), ['Kept.png']);
      f.current().workingSourceVerification[key] = { status: 'failed', selectionRevision: 0, attempt: 'known-failure',
        reason: 'scan-failed', requiredReferences: [], unresolved: [{ reason: 'scan-failed' }] };
      assert.equal((await callIpcRaw('projects:prepare-package-review', project.id)).materializable, false,
        'revision zero does not waive concrete persisted failure');
    } finally { clearTrackedTimers(); }
  });

  baselineTest('L2 Current Page veto preserves clean dormant root but blocks explicit restored intent', async () => {
    const f = await correctionProject('.fig', 'synthetic local fig bytes');
    try {
      f.current().figmaScopeMode = 'current-page';
      const asset = path.join(TEST_HOME, 'Desktop', 'Scope-kept.png'); fs.writeFileSync(asset, 'safe asset');
      f.current().files.push({ path: asset, name: 'Scope-kept.png', ext: '.png', source: 'user-added', acceptedPending: true, projectRole: 'asset' });
      assert.equal((await metadataTestHooks.runScanOnOpen(f.project.id, f.filePath, null, null,
        { establishBaseline: false, allowPausedBaseline: true })).success, true);
      const source = f.current().files.find(row => row.path === f.filePath);
      const key = metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.current(), source);
      assert.equal(f.current().workingSourceVerification[key].status, 'scanned');
      f.current().workingSourceSelections = {};
      let review = await callIpcRaw('projects:prepare-package-review', f.project.id);
      assert.equal(review.materializable, true); assert.deepEqual(review.files.map(row => row.name), ['Scope-kept.png']);
      assert.equal(review.semanticCounts.selectedWorkingSources, 0);
      const ws = await callIpcRaw('projects:get-asset-workspace', f.project.id), row = ws.files.find(item => item.name === 'Correction.fig');
      await callIpcRaw('projects:set-working-source-selection', f.project.id, row.visualIdentity, { action: 'exclude', expectedRevision: 0 });
      const restored = await callIpcRaw('projects:set-working-source-selection', f.project.id, row.visualIdentity, { action: 'restore', expectedRevision: 1 });
      assert.equal(restored.verificationStatus, 'scanned');
      review = await callIpcRaw('projects:prepare-package-review', f.project.id);
      assert.equal(review.materializable, false); assert.equal(review.token, undefined);
      assert.equal(review.files.some(item => item.name === 'Correction.fig'), false, 'Current Page veto remains in force');
      assert.ok(review.semanticCounts.unresolvedVerification > 0);
    } finally { clearTrackedTimers(); }
  });

  baselineTest('cycle2: logical embedded alias cannot satisfy a missing required physical PSD', async () => {
    const actual = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
    const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XcAAAAASUVORK5CYII=', 'base64');
    const f = await correctionProject('.ai', '%PDF-1.7\n%%EOF\n');
    try {
      const required = path.join(TEST_HOME, 'Desktop', 'Required.psd');
      fs.writeFileSync(required, actual.writePsdBuffer({ width: 1, height: 1, linkedFiles: [{
        id: '22222222-2222-4222-8222-222222222222', name: 'Embedded.png', data,
      }] }));
      currentPsdFixture = actual.readPsd(fs.readFileSync(required), { skipLayerImageData: true, skipCompositeImageData: true });
      fs.writeFileSync(f.filePath, `%PDF-1.7\n${required}\n%%EOF\n`);
      const project = f.current();
      project.files.push({ path: required, name: 'Required.psd', ext: '.psd', source: 'lsof', acceptedPending: true, projectRole: 'source' },
        { path: required, parentPsd: required, embeddedIndex: 0, embeddedOriginalName: 'Embedded.png', name: 'Embedded.png', ext: '.png',
          source: 'scan-on-save-embedded', embedded: true, fileId: crypto.randomUUID(), assetOrigin: 'existing', projectRole: 'asset' });
      project.watchStartedAt = Date.now() + 60000;
      let workspace = await callIpcRaw('projects:get-asset-workspace', project.id);
      const root = workspace.files.find(file => file.name === path.basename(f.filePath));
      await callIpcRaw('projects:set-working-source-selection', project.id, root.visualIdentity, { action: 'exclude', expectedRevision: 0 });
      await callIpcRaw('projects:set-working-source-selection', project.id, root.visualIdentity, { action: 'restore', expectedRevision: 1 });
      const parent = workspace.files.find(file => file.name === 'Required.psd');
      await callIpcRaw('projects:set-working-source-selection', project.id, parent.visualIdentity, { action: 'exclude', expectedRevision: 0 });
      const stored = f.current();
      const physical = stored.files.find(file => file.path === required && !file.embedded);
      physical.source = 'lsof'; physical.acceptedPending = true;
      const key = metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(stored, physical);
      stored.workingSourceVerification[key] = { ...stored.workingSourceVerification[key], status: 'unavailable', reason: 'not-scanned',
        sourceFingerprint: null, sourceIdentity: null, requiredReferences: [], unresolved: [] };
      const selected = await metadataTestHooks.selectProjectFilesForPackaging(stored);
      assert.ok(selected.some(file => file.embedded)); assert.equal(selected.some(file => file.path === required && !file.embedded), false);
      const review = await callIpcRaw('projects:prepare-package-review', project.id);
      assert.equal(review.materializable, false); assert.ok(review.semanticCounts.missingRequiredReferences > 0);
      assert.equal(review.files.find(file => file.embedded)?.includedAsDependency, false);
      stored.files = stored.files.filter(file => file !== physical);
      assert.equal((await callIpcRaw('projects:prepare-package-review', project.id)).materializable, false,
        'an accepted logical alias alone cannot satisfy physical inventory presence');
      stored.files.push({ ...physical, source: 'user-added' });
      assert.equal((await callIpcRaw('projects:prepare-package-review', project.id)).materializable, true,
        'the actual direct PSD still satisfies the required role');
    } finally { currentPsdFixture = { children: [], linkedFiles: [] }; clearTrackedTimers(); }
  });

  baselineTest('cycle2: unchanged dormant scan preserves token while source change rejects it', async () => {
    const f = await correctionProject('.ai', '%PDF-1.7\n%%EOF\n');
    try {
      const review = await callIpcRaw('projects:prepare-package-review', f.project.id);
      assert.equal(review.materializable, true);
      assert.equal((await metadataTestHooks.runScanOnOpen(f.project.id, f.filePath, null, null, { establishBaseline: false })).success, true);
      const packaged = await callIpcRaw('projects:package', f.project.id, TEST_HOME, review.token);
      assert.equal(packaged.success, true);
      f.current().status = 'watching';
      const second = await callIpcRaw('projects:prepare-package-review', f.project.id);
      fs.appendFileSync(f.filePath, '\nchanged bytes');
      const rejected = await callIpcRaw('projects:package', f.project.id, TEST_HOME, second.token);
      assert.ok(['package_review_changed', 'package_review_stale'].includes(rejected.error));
    } finally { clearTrackedTimers(); }
  });

  const embeddedPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XcAAAAASUVORK5CYII=', 'base64');
  for (const ext of ['.psd', '.ai']) for (const logicalFirst of [false, true]) {
    baselineTest(`C1 logical design child ${ext} ${logicalFirst ? 'logical-first' : 'parent-first'} stays an asset across admission reload and source controls`, async () => {
      const actual = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
      const f = await correctionProject('.psd', actual.writePsdBuffer({ width: 1, height: 1 }));
      currentPsdFixture = 'actual-source-buffer';
      try {
        const logical = { fileId: 'logical-child', path: f.filePath, parentPsd: f.filePath,
          name: 'Embedded' + ext, ext, embedded: true, embeddedIndex: 0,
          embeddedOriginalName: 'Embedded' + ext, projectRole: 'asset', source: 'scan-on-save-embedded' };
        f.current().pendingFiles = [logical];
        await callIpcRaw('projects:accept-pending', f.project.id,
          metadataTestHooks.createProjectFileVisualIdentity(f.project.id, logical));
        assert.equal(f.current().files.length, 2, 'logical dedup identity survives beside physical parent');
        assert.equal(f.current().files[1].acceptedPending, true, 'exercise production pending acceptance');
        const parent = f.current().files[0];
        const parentKey = metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.current(), parent);
        const logicalKey = metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.current(), logical);
        assert.notEqual(parentKey, logicalKey);
        if (logicalFirst) f.current().files.reverse();
        storeInstance.data.projects = JSON.parse(JSON.stringify(storeInstance.data.projects));
        let ws = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        let child = ws.files.find(row => row.name === logical.name);
        const root = ws.files.find(row => row.name === parent.name);
        assert.equal(ws.semanticCounts.selectedWorkingSources, 1);
        assert.equal(child.sourceSelection, null);
        assert.equal(child.effectiveRole, 'asset');
        for (const action of ['exclude', 'restore']) {
          const result = await callIpcRaw('projects:set-working-source-selection', f.project.id,
            child.visualIdentity, { action, expectedRevision: 0 });
          assert.equal(result.error, 'working_source_not_found');
        }
        assert.equal(f.current().workingSourceSelections?.[logicalKey], undefined);
        assert.equal((await callIpcRaw('projects:set-working-source-selection', f.project.id,
          root.visualIdentity, { action: 'exclude', expectedRevision: 0 })).success, true);
        // Accepted through production accept-pending, the child keeps owner
        // intent although it reads only the explicitly excluded parent.
        child = (await callIpcRaw('projects:get-asset-workspace', f.project.id)).files.find(row => row.name === logical.name);
        assert.equal(child.included, true); assert.equal(child.excludedSourceOnly, true);
        // Asset exclusion is independent of source intent. A hidden logical row
        // must not intercept the physical parent's Restore scan by shared path.
        await callIpcRaw('projects:remove-file', f.project.id, child.visualIdentity);
        const restored = await callIpcRaw('projects:set-working-source-selection', f.project.id,
          root.visualIdentity, { action: 'restore', expectedRevision: 1 });
        assert.equal(restored.success, true);
        assert.equal(restored.verificationStatus, 'scanned');
        assert.equal(f.current().workingSourceVerification?.[logicalKey], undefined);
        storeInstance.data.projects = JSON.parse(JSON.stringify(storeInstance.data.projects));
        ws = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        assert.equal(ws.semanticCounts.unresolvedVerification, 0);
        assert.equal(ws.semanticCounts.selectedWorkingSources, 1);
        assert.equal(ws.semanticCounts.excludedAssets, 1);
        assert.ok(f.current().files.some(row => row.fileId === 'logical-child'), 'asset exclusion preserves extraction metadata');
        f.current().excludedAssetKeys = [];
        f.current().workingSourceRelationshipHolds = [{ sourcePath: f.filePath, reason: 'legacy-psd-object-association-unverified' }];
        await callIpcRaw('projects:set-working-source-selection', f.project.id,
          root.visualIdentity, { action: 'exclude', expectedRevision: 2 });
        ws = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        assert.equal(ws.semanticCounts.relationshipHolds, 1, 'included logical asset retains concrete parent read hold');
        assert.ok((await metadataTestHooks.selectProjectFilesForPackaging(f.current())).some(row => row.fileId === 'logical-child'));
        await callIpcRaw('projects:remove-file', f.project.id, child.visualIdentity);
        assert.equal((await callIpcRaw('projects:get-asset-workspace', f.project.id)).semanticCounts.relationshipHolds, 0);
        assert.equal(f.current().workingSourceRelationshipHolds.length, 1, 'dormant hold is preserved');
      } finally { currentPsdFixture = { children: [], linkedFiles: [] }; clearTrackedTimers(); }
    });
  }

  for (const ext of ['.psd', '.ai']) {
    baselineTest(`C1 independently added physical child ${ext} retains Exclude Restore`, async () => {
      const actual = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
      const childBytes = ext === '.psd' ? actual.writePsdBuffer({ width: 1, height: 1 }) : Buffer.from('%PDF-1.7\n%%EOF\n');
      const f = await workingPsdFixture([{ id: psdId, name: 'Physical' + ext, data: childBytes }]);
      try {
        const physical = f.rows()[0]; assert.ok(physical); assert.notEqual(physical.path, f.filePath);
        manualDialogFor([physical.path]); await callIpcRaw('projects:add-files', f.project.id);
        storeInstance.data.projects = JSON.parse(JSON.stringify(storeInstance.data.projects));
        const ws = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        const child = ws.files.find(row => row.name === 'Physical' + ext); assert.ok(child);
        assert.equal(child.sourceSelection, 'selected');
        assert.equal((await callIpcRaw('projects:set-working-source-selection', f.project.id,
          child.visualIdentity, { action: 'exclude', expectedRevision: 0 })).success, true);
        const restored = await callIpcRaw('projects:set-working-source-selection', f.project.id,
          child.visualIdentity, { action: 'restore', expectedRevision: 1 });
        assert.equal(restored.success, true); assert.equal(restored.verificationStatus, 'scanned');
        assert.deepEqual(fs.readFileSync(physical.path), childBytes);
      } finally { f.cleanup(); }
    });
  }

  const psdId = '22222222-2222-4222-8222-222222222222';
  async function workingPsdFixture(linkedFiles, children = [], viaAddFiles = false, forcePending = false, engageProducer = true, retrySibling = false) {
    const actual = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
    const write = (linkedFiles, children = [], width = 1) => actual.writePsdBuffer({ width, height: 1, linkedFiles, children });
    const f = viaAddFiles ? await (async () => {
      resetTestHomeWorkspace(); setChildProcessHandler(() => ({ stdout: '' }));
      const created = await createProject('PSD paused Add Files'); clearTrackedTimers();
      const filePath = path.join(TEST_HOME, 'Desktop', 'Correction.psd');
      fs.writeFileSync(filePath, write(linkedFiles, children));
      return { project: storeInstance.data.projects.find(p => p.id === created.id), filePath,
        current: () => storeInstance.data.projects.find(p => p.id === created.id) };
    })() : await correctionProject('.psd', write(linkedFiles, children));
    // Conf10.2/electron-store8.2 deserialize fresh JSON on every get. Scope
    // that persistence behavior to these PSD cases rather than sharing rows
    // between the asynchronous preparation and canonical writer reads.
    const originalStoreGet = storeInstance.get;
    storeInstance.get = function clonedStoreGet(...args) {
      const value = originalStoreGet.apply(this, args);
      return value === undefined ? value : JSON.parse(JSON.stringify(value));
    };
    const originalTmpdir = os.tmpdir;
    const privateTmp = fs.mkdtempSync(path.join(TEST_HOME, 'Documents', 'cycle2-owned-psd-'));
    os.tmpdir = () => privateTmp;
    currentPsdFixture = 'actual-source-buffer';
    const restoreAdmission = forcePending ? metadataTestHooks.forceWorkingPsdPendingAdmission() : () => {};
    const retrySiblingPath = retrySibling ? path.join(TEST_HOME, 'Desktop', 'Retry-sibling.psd') : null;
    if (retrySiblingPath) fs.writeFileSync(retrySiblingPath, 'invalid PSD sibling');
    if (viaAddFiles) {
      manualDialogFor(retrySiblingPath ? [f.filePath, retrySiblingPath] : [f.filePath]); await callIpcRaw('projects:add-files', f.project.id);
      if (f.current().assetBaseline.status === 'decision-required' && !(forcePending && !engageProducer)) {
        await callIpcRaw('projects:set-existing-assets-decision', f.project.id, 'include');
      }
    }
    const rows = () => [...f.current().files, ...(f.current().pendingFiles || [])].filter(file => file.source === 'psd-embedded');
    const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
    const source = workspace.files.find(file => file.name === path.basename(f.filePath));
    if (engageProducer) {
      await callIpcRaw('projects:set-working-source-selection', f.project.id, source.visualIdentity, { action: 'exclude', expectedRevision: 0 });
      assert.equal((await callIpcRaw('projects:set-working-source-selection', f.project.id, source.visualIdentity,
        { action: 'restore', expectedRevision: 1 })).verificationStatus, 'scanned');
    }
    return { ...f, rows, write, source, privateTmp, actual, retrySiblingPath,
      async save(linkedFiles, children = [], width = 1) {
        fs.writeFileSync(f.filePath, write(linkedFiles, children, width));
        const result = await metadataTestHooks.runScanOnSave(f.project.id, f.filePath);
        assert.equal(result.success, true); return result;
      },
      cleanup() { restoreAdmission(); currentPsdFixture = { children: [], linkedFiles: [] }; os.tmpdir = originalTmpdir;
        storeInstance.get = originalStoreGet;
        fs.rmSync(privateTmp, { recursive: true, force: true }); clearTrackedTimers(); },
    };
  }

  // A PSD with distinct embedded PNG outputs, a link shared with a kept .ai and
  // a PSD-only link. Exclude must leave the PSD-only closure out of the package.
  async function excludedPsdAssetsFixture(outputCount = 6) {
    const zlib = require('zlib');
    const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const out = Buffer.alloc(8 + data.length + 4);
      out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(zlib.crc32(body) >>> 0, 8 + data.length); return out; };
    const png = value => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0])),
      chunk('IDAT', zlib.deflateSync(Buffer.from([0, value]))), chunk('IEND', Buffer.alloc(0))]);
    const desk = name => path.join(TEST_HOME, 'Desktop', name);
    const link = (id, name) => ({ id, name, childDocumentID: '', linkedFile: { fileSize: 1, name, fullPath: desk(name), originalPath: '', relativePath: '' } });
    const outputNames = Array.from({ length: outputCount }, (_, i) => 'Layer-' + String(i).padStart(2, '0') + '.png');
    const outputs = outputNames.map((name, i) => ({ id: '33333333-3333-4333-8333-' + String(i).padStart(12, '0'), name, data: png(i) }));
    const actual = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
    resetTestHomeWorkspace(); setChildProcessHandler(() => ({ stdout: '' }));
    const created = await createProject('Excluded PSD assets'); clearTrackedTimers();
    const current = () => storeInstance.data.projects.find(p => p.id === created.id);
    for (const [name, value] of [['Shared.png', 201], ['PsdOnly.png', 202], ['AiOnly.png', 203]]) fs.writeFileSync(desk(name), png(value));
    const psdPath = desk('Art.psd'), aiPath = desk('Poster.ai');
    fs.writeFileSync(psdPath, actual.writePsdBuffer({ width: 1, height: 1, children: [], linkedFiles: [...outputs,
      link('44444444-4444-4444-8444-444444444441', 'Shared.png'), link('44444444-4444-4444-8444-444444444442', 'PsdOnly.png')] }));
    fs.writeFileSync(aiPath, '%PDF-1.7\n' + desk('Shared.png') + '\n' + desk('AiOnly.png') + '\n%%EOF\n');
    const originalStoreGet = storeInstance.get;
    storeInstance.get = function clonedStoreGet(...args) {
      const value = originalStoreGet.apply(this, args);
      return value === undefined ? value : JSON.parse(JSON.stringify(value));
    };
    const originalTmpdir = os.tmpdir;
    const privateTmp = fs.mkdtempSync(path.join(TEST_HOME, 'Documents', 'excluded-psd-assets-'));
    os.tmpdir = () => privateTmp;
    currentPsdFixture = 'actual-source-buffer';
    const cleanup = () => { currentPsdFixture = { children: [], linkedFiles: [] }; os.tmpdir = originalTmpdir;
      storeInstance.get = originalStoreGet; fs.rmSync(privateTmp, { recursive: true, force: true }); clearTrackedTimers(); };
    try {
      for (const filePath of [psdPath, aiPath]) {
        manualDialogFor([filePath]); await callIpcRaw('projects:add-files', created.id);
        if (current().assetBaseline.status === 'decision-required') await callIpcRaw('projects:set-existing-assets-decision', created.id, 'include');
      }
      for (let round = 0; round < 6; round++) {
        const pending = (await callIpcRaw('projects:get-asset-workspace', created.id)).workingFileChoices?.choices || [];
        if (!pending.length) break;
        for (const entry of pending) {
          assert.equal((await callIpcRaw('projects:resolve-working-file-choice', created.id,
            { id: entry.id, revision: entry.revision, choice: 'keep-both', predecessorIdentity: null })).success, true);
        }
      }
    } catch (error) { cleanup(); throw error; }
    const workspace = () => callIpcRaw('projects:get-asset-workspace', created.id);
    const row = async name => (await workspace()).files.find(file => file.name === name);
    const setSelection = async (name, action) => {
      const file = await row(name);
      return callIpcRaw('projects:set-working-source-selection', created.id, file.visualIdentity, { action, expectedRevision: file.selectionRevision ?? 0 });
    };
    const out = desk('excluded-psd-out'); fs.mkdirSync(out, { recursive: true });
    const review = () => callIpcRaw('projects:prepare-package-review', created.id, out);
    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
    return { project: created, current, psdPath, aiPath, outputNames, workspace, row, setSelection, review, walk, out, cleanup,
      toggle: async name => callIpcRaw('projects:remove-file', created.id, (await row(name)).visualIdentity),
      stored: name => current().files.find(file => file.name === name) };
  }
  const sortedNames = files => files.map(file => file.name).sort();

  baselineTest('excluded PSD leaves its embedded outputs and PSD-only link out of review and package', { timeout: 120000 }, async () => {
    const f = await excludedPsdAssetsFixture();
    try {
      const before = await f.workspace();
      for (const name of [...f.outputNames, 'PsdOnly.png', 'Shared.png', 'AiOnly.png']) {
        assert.equal(before.files.find(file => file.name === name)?.included, true, name);
      }
      assert.equal(f.stored('Layer-00.png').source, 'psd-embedded');
      assert.equal(f.stored('PsdOnly.png').source, 'psd-linked');
      const excluded = await f.setSelection('Art.psd', 'exclude');
      assert.equal(excluded.success, true);
      const ws = await f.workspace();
      for (const name of [...f.outputNames, 'PsdOnly.png']) {
        const file = ws.files.find(item => item.name === name);
        assert.equal(file.included, false, name); assert.equal(file.excludedSourceOnly, true, name);
        assert.equal(file.excluded, false, name); assert.equal(file.includedAsDependency, false, name);
      }
      const shared = ws.files.find(file => file.name === 'Shared.png');
      assert.equal(shared.included, true); assert.equal(shared.includedAsDependency, true);
      assert.equal(shared.excludedSourceOnly, false); assert.deepEqual(shared.requiredBy, ['Poster.ai']);
      assert.equal(ws.files.find(file => file.name === 'AiOnly.png').included, true);
      assert.deepEqual(ws.semanticCounts, { selectedWorkingSources: 1, excludedWorkingSources: 1, invalidWorkingSources: 0,
        includedAssets: 2, excludedAssets: f.outputNames.length + 1, unresolvedVerification: 0, missingRequiredReferences: 0, relationshipHolds: 0 });
      assert.deepEqual(excluded.semanticCounts, ws.semanticCounts);
      assert.deepEqual(f.current().excludedAssetKeys || [], [], 'withholding writes no asset exclusion intent');
      const review = await f.review();
      assert.equal(review.materializable, true, review.error || review.message);
      assert.deepEqual(sortedNames(review.files), ['AiOnly.png', 'Poster.ai', 'Shared.png']);
      assert.equal(review.totalFiles, 3);
      const packaged = await callIpcRaw('projects:package', f.project.id, f.out, review.token);
      assert.equal(packaged.success, true, packaged.error);
      assert.equal(packaged.copiedCount, 3);
      assert.deepEqual(packaged.errors || [], []);
      assert.deepEqual(f.walk(packaged.folderPath).map(file => path.basename(file)).filter(name => name !== '.DS_Store').sort(),
        ['AiOnly.png', 'Poster.ai', 'Shared.png']);
    } finally { f.cleanup(); }
  });

  baselineTest('excluded PSD rescan stays skipped and Restore brings back its outputs', { timeout: 120000 }, async () => {
    const f = await excludedPsdAssetsFixture();
    try {
      assert.equal((await f.setSelection('Art.psd', 'exclude')).success, true);
      const counts = (await f.workspace()).semanticCounts;
      const rows = JSON.stringify(f.current().files);
      const rescan = await metadataTestHooks.runScanOnSave(f.project.id, f.psdPath);
      assert.equal(rescan.success, true); assert.equal(rescan.skipped, 'source-excluded');
      assert.deepEqual((await f.workspace()).semanticCounts, counts);
      assert.equal(JSON.stringify(f.current().files), rows);
      // Restore before any package: the restored PSD and its outputs return.
      const restored = await f.setSelection('Art.psd', 'restore');
      assert.equal(restored.success, true); assert.equal(restored.verificationStatus, 'scanned');
      const ws = await f.workspace();
      for (const name of [...f.outputNames, 'PsdOnly.png']) {
        const file = ws.files.find(item => item.name === name);
        assert.equal(file.included, true, name); assert.equal(file.excludedSourceOnly, false, name);
        assert.equal(file.includedAsDependency, true, name);
      }
      assert.equal(ws.semanticCounts.excludedAssets, 0);
      const review = await f.review();
      assert.equal(review.materializable, true, review.error || review.message);
      assert.deepEqual(sortedNames(review.files), ['AiOnly.png', 'Art.psd', ...f.outputNames, 'Poster.ai', 'PsdOnly.png', 'Shared.png'].sort());
      const packaged = await callIpcRaw('projects:package', f.project.id, f.out, review.token);
      assert.equal(packaged.success, true, packaged.error);
      assert.equal(packaged.copiedCount, f.outputNames.length + 5);
      assert.deepEqual(packaged.errors || [], []);
    } finally { f.cleanup(); }
  });

  baselineTest('owner Include keeps a withheld PSD output; a second click explicitly excludes it', { timeout: 120000 }, async () => {
    const f = await excludedPsdAssetsFixture();
    try {
      // Layer-01 is explicitly excluded first, then also withheld by Exclude.
      await f.toggle('Layer-01.png');
      assert.equal((f.current().excludedAssetKeys || []).length, 1);
      assert.equal((await f.setSelection('Art.psd', 'exclude')).success, true);
      assert.equal((await f.row('Layer-01.png')).excludedSourceOnly, true);
      const keys = [...f.current().excludedAssetKeys];
      await f.toggle('Layer-00.png');
      assert.equal(f.stored('Layer-00.png').keptAfterSourceExclusion, true);
      assert.deepEqual(f.current().excludedAssetKeys, keys, 'Include of a withheld row writes no exclusion key');
      storeInstance.data.projects = JSON.parse(JSON.stringify(storeInstance.data.projects));
      assert.equal(f.stored('Layer-00.png').keptAfterSourceExclusion, true, 'marker survives a store round trip');
      let layer = await f.row('Layer-00.png');
      assert.equal(layer.included, true); assert.equal(layer.excludedSourceOnly, true);
      // One click includes a row that is both explicitly excluded and withheld.
      await f.toggle('Layer-01.png');
      assert.deepEqual(f.current().excludedAssetKeys, []);
      assert.equal(f.stored('Layer-01.png').keptAfterSourceExclusion, true);
      assert.equal((await f.row('Layer-01.png')).included, true);
      // Restore reconciles the PSD outputs; the owner marker stays on the rows,
      // so a second Exclude keeps them while their siblings leave again.
      const restored = await f.setSelection('Art.psd', 'restore');
      assert.equal(restored.success, true); assert.equal(restored.verificationStatus, 'scanned');
      for (const name of ['Layer-00.png', 'Layer-01.png']) assert.equal(f.stored(name).keptAfterSourceExclusion, true, name);
      assert.equal((await f.setSelection('Art.psd', 'exclude')).success, true);
      for (const name of ['Layer-00.png', 'Layer-01.png']) assert.equal((await f.row(name)).included, true, name);
      assert.equal((await f.row('Layer-02.png')).included, false);
      let review = await f.review();
      assert.equal(review.materializable, true, review.error || review.message);
      assert.deepEqual(sortedNames(review.files), ['AiOnly.png', 'Layer-00.png', 'Layer-01.png', 'Poster.ai', 'Shared.png']);
      await f.toggle('Layer-00.png');
      assert.equal(Object.hasOwn(f.stored('Layer-00.png'), 'keptAfterSourceExclusion'), false);
      assert.equal(f.current().excludedAssetKeys.length, 1);
      layer = await f.row('Layer-00.png');
      assert.equal(layer.included, false); assert.equal(layer.excluded, true);
      review = await f.review();
      assert.deepEqual(sortedNames(review.files), ['AiOnly.png', 'Layer-01.png', 'Poster.ai', 'Shared.png']);
      const packaged = await callIpcRaw('projects:package', f.project.id, f.out, review.token);
      assert.equal(packaged.success, true, packaged.error);
      assert.equal(packaged.copiedCount, 4); assert.deepEqual(packaged.errors || [], []);
      assert.deepEqual(f.walk(packaged.folderPath).map(file => path.basename(file)).filter(name => name !== '.DS_Store').sort(),
        ['AiOnly.png', 'Layer-01.png', 'Poster.ai', 'Shared.png']);
    } finally { f.cleanup(); }
  });

  function assertNoOwnerIntent(project, row) {
    assert.ok(row);
    for (const field of ['acceptedPending', 'keptAfterSourceExclusion', 'individualContentInclude', 'explicitUserAuthority']) {
      assert.equal(row[field], undefined, `${row.name} ${field}`);
    }
    assert.ok(['ai-linked', 'indd-poll', 'indd-linked', 'ps-poll', 'psd-linked', 'psd-embedded', 'scan-on-open',
      'scan-on-save-linked', 'scan-on-save-embedded', 'scan-on-save-presentation', 'embedded-media', 'figma-auto'].includes(row.source),
    `${row.name} is dependency-captured (${row.source})`);
    const records = (project.provenance?.observations || []).filter(item =>
      ['projects:accept-pending', 'projects:set-existing-assets-decision'].includes(item?.observer?.method) &&
      project.provenance.nodes[item.objectNodeId]?.path === row.path);
    assert.deepEqual(records, [], `${row.name} has no owner acceptance record`);
  }

  // Accepted dependency assets of an excluded working file stay (owner
  // decision). Pending rows use the live-capture shape; acceptance, scan,
  // selection, review and packaging run through the real IPC routes.
  async function acceptedLinkFixture(label, { acceptedOrigin = 'added', baselineStatus = 'legacy-included' } = {}) {
    resetTestHomeWorkspace(); setChildProcessHandler(() => ({ stdout: '' }));
    const created = await createProject('Accepted link ' + label);
    await callIpcRaw('projects:pause', created.id); clearTrackedTimers();
    const current = () => storeInstance.data.projects.find(p => p.id === created.id);
    const desk = name => path.join(TEST_HOME, 'Desktop', name);
    for (const name of ['A.psd', 'Accepted.png', 'Sibling.png']) fs.writeFileSync(desk(name), `synthetic ${name}`);
    fs.writeFileSync(desk('Keep.ai'), '%PDF-1.7\n%%EOF\n');
    const source = name => ({ fileId: name, path: desk(name), name, ext: path.extname(name), projectRole: 'source', source: 'user-added', addedAt: Date.now() });
    const pendingRow = (name, assetOrigin) => ({ fileId: name, path: desk(name), name, ext: '.png', projectRole: 'asset', source: 'psd-linked', assetOrigin,
      addedAt: Date.now() - 60000, captureState: 'needs-save', captureReason: 'linked-asset-observed',
      captureEvidence: { schemaVersion: 1, source: 'psd-linked', appFamily: 'photoshop', relationshipSourcePath: desk('A.psd'), documentModified: true } });
    current().files = [source('A.psd'), source('Keep.ai')];
    current().pendingFiles = [pendingRow('Accepted.png', acceptedOrigin), pendingRow('Sibling.png', 'added')];
    current().assetBaseline = { schemaVersion: 1, status: baselineStatus, decision: baselineStatus === 'legacy-included' ? 'include' : null, establishedAt: Date.now() };
    roundTripFakeStore();
    currentPsdFixture = { children: [], linkedFiles: ['Accepted.png', 'Sibling.png'].map(name => ({ name, linkedFile: { fullPath: desk(name) } })) };
    const workspace = () => callIpcRaw('projects:get-asset-workspace', created.id);
    const select = async action => {
      const row = (await workspace()).files.find(file => file.name === 'A.psd');
      const response = await callIpcRaw('projects:set-working-source-selection', created.id, row.visualIdentity,
        { action, expectedRevision: row.selectionRevision });
      assert.equal(response.success, true, JSON.stringify(response)); return response;
    };
    const methods = method => (current().provenance?.observations || []).filter(item => item?.observer?.method === method)
      .map(item => current().provenance.nodes[item.objectNodeId]?.name).sort();
    const out = desk('accepted-link-out'); fs.mkdirSync(out, { recursive: true });
    return { project: created, current, desk, workspace, select, methods, out,
      stored: name => current().files.find(file => file.name === name),
      async scanThenExclude() {
        await select('exclude');
        assert.equal((await select('restore')).verificationStatus, 'scanned');
        const record = metadataTestHooks.getWorkingSourceVerification(current(), current().files.find(file => file.name === 'A.psd'));
        assert.deepEqual(record.requiredReferences.map(ref => path.basename(ref.path)).sort(), ['Accepted.png', 'Sibling.png'],
          'the scan receipt lists both links only under A.psd');
        for (const name of ['Accepted.png', 'Sibling.png']) assert.ok(current().files.some(file => file.name === name), name);
        await select('exclude');
      } };
  }

  baselineTest('an asset accepted through accept-pending stays in review and package after its only working file is excluded', { timeout: 120000 }, async () => {
    const f = await acceptedLinkFixture('accept');
    try {
      assert.ok(await callIpcRaw('projects:accept-pending', f.project.id, f.desk('Accepted.png')));
      const accepted = f.stored('Accepted.png');
      assert.equal(accepted.acceptedPending, true);
      assert.equal(accepted.captureEvidence, undefined, 'production acceptance strips capture evidence');
      assert.deepEqual(f.methods('projects:accept-pending'), ['Accepted.png']);
      await f.scanThenExclude();
      // The scan admitted the sibling directly; nothing records owner intent on it.
      const sibling = f.stored('Sibling.png');
      for (const field of ['acceptedPending', 'keptAfterSourceExclusion', 'individualContentInclude', 'explicitUserAuthority']) {
        assert.equal(sibling[field], undefined, field);
      }
      const ws = await f.workspace();
      const fact = name => ws.files.find(file => file.name === name);
      assert.equal(fact('Accepted.png').included, true); assert.equal(fact('Accepted.png').excludedSourceOnly, true);
      assert.equal(fact('Accepted.png').excluded, false);
      assert.equal(fact('Sibling.png').included, false); assert.equal(fact('Sibling.png').excludedSourceOnly, true);
      assert.equal(fact('A.psd').sourceSelection, 'excluded');
      assert.deepEqual(f.current().excludedAssetKeys || [], []);
      const review = await callIpcRaw('projects:prepare-package-review', f.project.id, f.out);
      assert.equal(review.materializable, true, review.error || review.message);
      assert.deepEqual(review.files.map(file => file.name).sort(), ['Accepted.png', 'Keep.ai']);
      const packaged = await callIpcRaw('projects:package', f.project.id, f.out, review.token);
      assert.equal(packaged.success, true, packaged.error);
      assert.equal(packaged.copiedCount, 2); assert.deepEqual(packaged.errors || [], []);
      const written = fs.readdirSync(packaged.folderPath, { recursive: true }).map(name => path.basename(name)).filter(name => /\.(png|ai)$/.test(name)).sort();
      assert.deepEqual(written, ['Accepted.png', 'Keep.ai']);
      roundTripFakeStore();
      assert.equal((await f.workspace()).files.find(file => file.name === 'Accepted.png').included, true, 'kept after reload');
    } finally { currentPsdFixture = { children: [], linkedFiles: [] }; clearTrackedTimers(); }
  });

  baselineTest('existing assets included through the existing-assets decision before an exclusion are withheld after it', { timeout: 120000 }, async () => {
    const f = await acceptedLinkFixture('existing', { acceptedOrigin: 'existing', baselineStatus: 'decision-required' });
    try {
      const decided = await callIpcRaw('projects:set-existing-assets-decision', f.project.id, 'include');
      assert.equal(decided.success, true);
      assert.equal(f.stored('Accepted.png').acceptedPending, true);
      assert.equal(f.stored('Accepted.png').captureEvidence, undefined);
      assert.deepEqual(f.methods('projects:set-existing-assets-decision'), ['Accepted.png']);
      const record = f.current().provenance.observations.find(item => item.observer.method === 'projects:set-existing-assets-decision');
      assert.equal(record.observer.kind, 'manual_user_action'); assert.equal(record.payload.decision, 'include');
      assert.deepEqual(f.methods('projects:accept-pending'), [], 'bulk Include writes no accept-pending record');
      assert.ok(f.current().pendingFiles.some(file => file.name === 'Sibling.png'), 'an added-origin row is not an existing asset');
      await f.scanThenExclude();
      // A provably bulk Include made before the exclusion is not owner intent
      // for it: the later exclusion wins (owner decision).
      const ws = await f.workspace();
      assert.equal(ws.files.find(file => file.name === 'Accepted.png').included, false);
      assert.equal(ws.files.find(file => file.name === 'Accepted.png').excludedSourceOnly, true);
      assert.equal(f.stored('Accepted.png').existingIncludeEpisode, undefined);
      assert.equal(ws.files.find(file => file.name === 'Sibling.png').included, false);
      const review = await callIpcRaw('projects:prepare-package-review', f.project.id, f.out);
      assert.equal(review.materializable, true, review.error || review.message);
      assert.deepEqual(review.files.map(file => file.name).sort(), ['Keep.ai']);
      roundTripFakeStore();
      assert.equal((await f.workspace()).files.find(file => file.name === 'Accepted.png').included, false, 'after reload');
    } finally { currentPsdFixture = { children: [], linkedFiles: [] }; clearTrackedTimers(); }
  });

  // A byte-changing save replaces an output row at a new path. Owner intent on
  // the predecessor travels as the keep marker; a same-bytes save retains it.
  for (const intent of ['include', 'accept']) {
    baselineTest(`replaced PSD output carries owner ${intent} intent across a changed-bytes save`, { timeout: 120000 }, async () => {
      const kept = { id: psdId, name: 'Kept.png', data: embeddedPng };
      const sibling = { id: '33333333-3333-4333-8333-333333333334', name: 'Sibling.png', data: Buffer.from('sibling bytes') };
      const f = await workingPsdFixture([kept, sibling], [], false, intent === 'accept');
      try {
        const output = producerId => f.current().files.find(row => row.source === 'psd-embedded' && row.psdResource?.producerId === producerId);
        const workspace = () => callIpcRaw('projects:get-asset-workspace', f.project.id);
        const fact = async row => (await workspace()).files.find(file =>
          file.visualIdentity === metadataTestHooks.createProjectFileVisualIdentity(f.project.id, row));
        const select = async action => {
          const row = (await workspace()).files.find(file => file.name === path.basename(f.filePath));
          const response = await callIpcRaw('projects:set-working-source-selection', f.project.id, row.visualIdentity,
            { action, expectedRevision: row.selectionRevision });
          assert.equal(response.success, true, JSON.stringify(response)); return response;
        };
        const save = async objects => {
          metadataTestHooks.clearPsdParseDebounce(f.filePath);
          const result = await f.save(objects); assert.equal(result.skipped, undefined); return result;
        };
        if (intent === 'accept') {
          const pending = f.current().pendingFiles.find(row => row.psdResource?.producerId === psdId);
          assert.ok(pending, 'outputs are pending under forced pending admission');
          assert.ok(await callIpcRaw('projects:accept-pending', f.project.id, pending.path));
          assert.equal(output(psdId).acceptedPending, true);
        }
        await select('exclude');
        const predecessor = output(psdId);
        assert.equal((await fact(predecessor)).excludedSourceOnly, true);
        if (intent === 'include') {
          assert.equal((await fact(predecessor)).included, false);
          assert.equal((await fact(output(sibling.id))).included, false);
          await callIpcRaw('projects:remove-file', f.project.id, (await fact(predecessor)).visualIdentity);
          assert.equal(output(psdId).keptAfterSourceExclusion, true);
        }
        assert.equal((await fact(output(psdId))).included, true);
        assert.equal((await select('restore')).verificationStatus, 'scanned');
        // Control: unchanged bytes retain the exact row and its intent.
        const retained = { ...output(psdId) };
        await save([kept, sibling]);
        assert.equal(output(psdId).path, retained.path); assert.equal(output(psdId).fileId, retained.fileId);
        assert.equal(output(psdId).keptAfterSourceExclusion, retained.keptAfterSourceExclusion);
        assert.equal(output(psdId).acceptedPending, retained.acceptedPending);
        // Changed bytes for that object: a new row at a new path replaces it.
        await save([{ ...kept, data: Buffer.from('replacement bytes') }, sibling]);
        const replacement = output(psdId);
        assert.notEqual(replacement.path, retained.path);
        assert.equal(f.current().files.some(row => row.path === retained.path), false, 'the predecessor row is retired');
        assert.equal(replacement.fileId, retained.fileId);
        assert.equal(replacement.keptAfterSourceExclusion, true, 'keep marker carried onto the replacement');
        for (const field of ['acceptedPending', 'explicitUserAuthority', 'individualContentInclude']) {
          assert.equal(Object.hasOwn(replacement, field), false, `${field} is not copied`);
        }
        await select('exclude');
        const replacementFact = await fact(replacement);
        assert.equal(replacementFact.included, true); assert.equal(replacementFact.excludedSourceOnly, true);
        if (intent === 'include') {
          const siblingRow = output(sibling.id);
          assert.equal(siblingRow.keptAfterSourceExclusion, undefined);
          assert.equal((await fact(siblingRow)).included, false, 'a sibling without intent is withheld');
          assert.deepEqual((await metadataTestHooks.selectProjectFilesForPackaging(f.current())).map(row => row.name), [replacement.name]);
        } else {
          assert.ok(f.current().pendingFiles.some(row => row.psdResource?.producerId === sibling.id), 'the unaccepted sibling stays pending');
          assert.deepEqual((await metadataTestHooks.selectProjectFilesForPackaging(f.current())).map(row => row.name), [replacement.name]);
        }
      } finally { f.cleanup(); }
    });
  }

  baselineTest('cycle2: PSD identical saves reuse one output and removal/empty retire exact membership', async () => {
    const objects = [{ id: psdId, name: 'Embedded.png', data: embeddedPng }];
    const f = await workingPsdFixture(objects);
    try {
      assert.equal(f.rows().length, 1);
      const original = { ...f.rows()[0] };
      await f.save(objects); await f.save(objects);
      assert.equal(f.rows().length, 1);
      assert.equal(original.psdResource.parentPath, f.filePath); assert.equal(original.psdResource.linkedIndex, 0); assert.equal(f.rows()[0].path, original.path); assert.equal(f.rows()[0].fileId, original.fileId);
      assert.deepEqual(fs.readFileSync(original.path), embeddedPng);
      assert.equal(fs.readdirSync(path.dirname(original.path)).filter(name => !name.startsWith('.')).length, 1,
        'transaction retires its own unused new snapshots');
      await f.save([], [], 2);
      assert.equal(f.rows().length, 0); assert.ok(fs.existsSync(original.path), 'prior output bytes are preserved');
      const review = await callIpcRaw('projects:prepare-package-review', f.project.id);
      assert.equal(review.materializable, true); assert.equal(review.totalFiles, 1);
    } finally { f.cleanup(); }
  });

  baselineTest('cycle2: PSD replacement and reordered same-name objects preserve exclusions and index domains', async () => {
    const linked = { id: '11111111-1111-4111-8111-111111111111', name: 'Linked.png', childDocumentID: '',
      linkedFile: { fileSize: 1, name: 'Linked.png', fullPath: path.join(TEST_HOME, 'Desktop', 'Linked.png'), originalPath: '', relativePath: '' } };
    const a = { id: psdId, name: 'Same.png', data: embeddedPng };
    const b = { id: '33333333-3333-4333-8333-333333333333', name: 'Same.png', data: Buffer.from('other bytes') };
    const f = await workingPsdFixture([a, b]);
    try {
      const original = f.rows().find(row => row.psdResource.producerId === psdId);
      const oldPath = original.path;
      const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      const row = workspace.files.find(file => file.visualIdentity === metadataTestHooks.createProjectFileVisualIdentity(f.project.id, original));
      await callIpcRaw('projects:remove-file', f.project.id, row.visualIdentity);
      assert.ok(f.current().excludedAssetKeys.includes(original.fileId));
      fs.writeFileSync(linked.linkedFile.fullPath, 'linked byte');
      const replacement = { ...a, data: Buffer.from('replacement bytes') };
      await f.save([linked, b, replacement]);
      const current = f.rows().find(row => row.psdResource.producerId === psdId);
      assert.equal(f.rows().length, 2); assert.equal(current.fileId, original.fileId);
      const saved = f.actual.readPsd(fs.readFileSync(f.filePath), { skipLayerImageData: true, skipCompositeImageData: true });
      assert.equal(current.psdResource.linkedIndex, saved.linkedFiles.findIndex(item => item.id === psdId),
        'locator uses the actual saved root record index, never assumes serialization order');
      assert.equal(current.psdResource.layerPath, null); assert.notEqual(current.path, oldPath);
      assert.ok(f.current().excludedAssetKeys.includes(current.fileId)); assert.ok(fs.existsSync(oldPath));
      assert.deepEqual(fs.readFileSync(current.path), replacement.data);
      await f.save([linked, replacement]);
      assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].fileId, original.fileId);
    } finally { f.cleanup(); }
  });

  baselineTest('cycle2: PSD layer outputs retain their own locator and two parent sources do not reconcile each other', async () => {
    const root = { id: psdId, name: 'Root.bin', data: Buffer.from('root') };
    const layerObject = { id: '33333333-3333-4333-8333-333333333333', name: 'Layer.bin', data: Buffer.from('layer') };
    const children = [{ name: 'layer', linkedFiles: [layerObject] }];
    const f = await workingPsdFixture([root], children);
    try {
      assert.equal(f.rows().length, 2);
      const layer = f.rows().find(row => row.psdResource.producerId === layerObject.id);
      assert.deepEqual(layer.psdResource.layerPath, [0]); assert.equal(layer.psdResource.linkedIndex, 0);
      const otherPath = path.join(TEST_HOME, 'Desktop', 'Other.psd'); fs.writeFileSync(otherPath, f.write([root]));
      f.current().files.push({ path: otherPath, name: 'Other.psd', ext: '.psd', source: 'user-added', acceptedPending: true, projectRole: 'source' });
      const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      const other = workspace.files.find(file => file.name === 'Other.psd');
      await callIpcRaw('projects:set-working-source-selection', f.project.id, other.visualIdentity, { action: 'exclude', expectedRevision: 0 });
      await callIpcRaw('projects:set-working-source-selection', f.project.id, other.visualIdentity, { action: 'restore', expectedRevision: 1 });
      const otherOutput = f.rows().find(row => row.psdResource.parentPath === otherPath);
      assert.ok(otherOutput);
      await f.save([], []);
      assert.deepEqual(f.rows().map(row => row.psdResource.parentPath), [otherPath]); assert.ok(fs.existsSync(otherOutput.path));
    } finally { f.cleanup(); }
  });

  baselineTest('cycle2: PSD removal retains a physical asset still required by another selected root', async () => {
    const f = await workingPsdFixture([{ id: psdId, name: 'Embedded.png', data: embeddedPng }]);
    try {
      const output = f.rows()[0];
      const otherPath = path.join(TEST_HOME, 'Desktop', 'Other.ai'); fs.writeFileSync(otherPath, `%PDF-1.7\n${output.path}\n%%EOF\n`);
      f.current().files.push({ path: otherPath, name: 'Other.ai', ext: '.ai', source: 'user-added', acceptedPending: true, projectRole: 'source' });
      const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      const other = workspace.files.find(file => file.name === 'Other.ai');
      await callIpcRaw('projects:set-working-source-selection', f.project.id, other.visualIdentity, { action: 'exclude', expectedRevision: 0 });
      await callIpcRaw('projects:set-working-source-selection', f.project.id, other.visualIdentity, { action: 'restore', expectedRevision: 1 });
      await f.save([], [], 2);
      assert.ok(f.current().files.some(row => row.path === output.path));
      assert.equal(f.current().files.find(row => row.path === output.path).psdResource.current, false);
      const review = await callIpcRaw('projects:prepare-package-review', f.project.id);
      assert.equal(review.materializable, true);
      assert.ok(review.files.some(row => row.ext === '.png' && row.includedAsDependency));
      assert.deepEqual(fs.readFileSync(output.path), embeddedPng);
    } finally { f.cleanup(); }
  });

  baselineTest('cycle3: cloned persisted pending rows retain/reorder, replace and retire exact membership', async () => {
    const a = { id: psdId, name: 'Same.bin', data: Buffer.from('original pending bytes') };
    const b = { id: '33333333-3333-4333-8333-333333333333', name: 'Same.bin', data: Buffer.from('other bytes') };
    const f = await workingPsdFixture([a, b]);
    try {
      const original = JSON.parse(JSON.stringify(f.rows().find(row => row.psdResource.producerId === psdId)));
      const project = f.current();
      project.files = project.files.filter(row => row.fileId !== original.fileId);
      project.pendingFiles = [...(project.pendingFiles || []), original];
      project.excludedAssetKeys.push(original.fileId);
      await f.save([b, a]);
      let pending = f.current().pendingFiles.find(row => row.fileId === original.fileId);
      const parsed = f.actual.readPsd(fs.readFileSync(f.filePath), { skipLayerImageData: true, skipCompositeImageData: true });
      assert.equal(pending.psdResource.linkedIndex, parsed.linkedFiles.findIndex(item => item.id === psdId));
      assert.equal(pending.path, original.path);
      const replacement = { ...a, data: Buffer.from('new pending bytes') };
      await f.save([replacement, b]);
      pending = f.current().pendingFiles.find(row => row.fileId === original.fileId);
      assert.equal(f.current().pendingFiles.filter(row => row.fileId === original.fileId).length, 1);
      assert.equal(f.current().files.some(row => row.fileId === original.fileId), false);
      assert.notEqual(pending.path, original.path);
      assert.deepEqual(fs.readFileSync(pending.path), replacement.data);
      assert.ok(f.current().excludedAssetKeys.includes(original.fileId));
      const replacementPath = pending.path;
      await f.save([], [], 2);
      assert.equal(f.rows().length, 0); assert.ok(fs.existsSync(original.path)); assert.ok(fs.existsSync(replacementPath));
      const review = await callIpcRaw('projects:prepare-package-review', f.project.id);
      assert.equal(review.materializable, true); assert.equal(review.totalFiles, 1);
      assert.equal(review.files.some(row => row.path === original.path || row.path === replacementPath), false);
    } finally { f.cleanup(); }
  });

  baselineTest('cycle3: verified clean PSD retires only its resolved current-flow domain hold', async () => {
    const object = { id: psdId, name: 'Embedded.png', data: embeddedPng };
    const f = await workingPsdFixture([object]);
    try {
      const original = JSON.parse(JSON.stringify(f.rows()[0]));
      f.current().excludedAssetKeys.push(original.fileId);
      await f.save([], [{ name: 'layer', linkedFiles: [object] }]);
      assert.ok(f.current().workingSourceRelationshipHolds.some(hold => hold.reason === 'psd-resource-domain-changed'));
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).materializable, false);
      assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].fileId, original.fileId);
      await f.save([object]);
      assert.deepEqual(f.current().workingSourceRelationshipHolds, []);
      const review = await callIpcRaw('projects:prepare-package-review', f.project.id);
      const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      assert.equal(review.materializable, true); assert.equal(workspace.workingSourceSelectionBlocked, false);
      assert.deepEqual(workspace.semanticCounts, review.semanticCounts);
      assert.equal(f.rows()[0].path, original.path); assert.ok(f.current().excludedAssetKeys.includes(original.fileId));
      assert.deepEqual(fs.readFileSync(original.path), embeddedPng);
      const protectedHolds = [{ reason: 'legacy-psd-object-association-unverified', sourcePath: f.filePath },
        { reason: 'psd-resource-domain-changed', sourcePath: path.join(TEST_HOME, 'Desktop', 'Other.psd') },
        { signal: 'unknown-manual-hold', sourcePath: f.filePath }];
      f.current().workingSourceRelationshipHolds.push(...protectedHolds);
      await f.save([], [{ name: 'layer', linkedFiles: [object] }]); await f.save([object]);
      assert.deepEqual(f.current().workingSourceRelationshipHolds, protectedHolds);
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).materializable, false);
      f.current().workingSourceRelationshipHolds = { reason: 'malformed-container' };
      await f.save([object]);
      assert.deepEqual(f.current().workingSourceRelationshipHolds, { reason: 'malformed-container' });
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).materializable, false);
    } finally { f.cleanup(); }
  });

  baselineTest('cycle3: unique verified PSD clears a temporary duplicate-ID hold', async () => {
    const object = { id: psdId, name: 'Embedded.png', data: embeddedPng };
    const f = await workingPsdFixture([object]);
    try {
      const original = JSON.parse(JSON.stringify(f.rows()[0]));
      await f.save([object, { ...object, name: 'Other.png' }]);
      assert.ok(f.current().workingSourceRelationshipHolds.some(hold => hold.reason === 'psd-resource-identity-ambiguous'));
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).materializable, false);
      await f.save([object]);
      assert.deepEqual(f.current().workingSourceRelationshipHolds, []);
      assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].fileId, original.fileId);
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).materializable, true);
      assert.deepEqual(fs.readFileSync(original.path), embeddedPng);
    } finally { f.cleanup(); }
  });

  baselineTest('extra round: paused Add Files detached output preserves other-root obligation then respects exclusion', async () => {
    const f = await workingPsdFixture([{ id: psdId, name: 'Embedded.png', data: embeddedPng }], [], true);
    try {
      const output = JSON.parse(JSON.stringify(f.rows()[0]));
      assert.equal(output.assetBaselineSourcePath, f.filePath, 'real paused Add Files baseline stamps the origin edge');
      f.current().excludedAssetKeys.push(output.fileId);
      const otherPath = path.join(TEST_HOME, 'Desktop', 'Other.ai'); fs.writeFileSync(otherPath, `%PDF-1.7\n${output.path}\n%%EOF\n`);
      f.current().files.push({ path: otherPath, name: 'Other.ai', ext: '.ai', source: 'user-added', acceptedPending: true, projectRole: 'source' });
      const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      const other = workspace.files.find(file => file.name === 'Other.ai');
      await callIpcRaw('projects:set-working-source-selection', f.project.id, other.visualIdentity, { action: 'exclude', expectedRevision: 0 });
      await callIpcRaw('projects:set-working-source-selection', f.project.id, other.visualIdentity, { action: 'restore', expectedRevision: 1 });
      await f.save([], [], 2);
      assert.equal(f.current().files.find(row => row.fileId === output.fileId).psdResource.current, false);
      const requiredReview = await callIpcRaw('projects:prepare-package-review', f.project.id);
      const retained = requiredReview.files.find(row => row.visualIdentity === metadataTestHooks.createProjectFileVisualIdentity(f.project.id, output));
      assert.ok(retained.includedAsDependency); assert.deepEqual(retained.requiredBy, ['Other.ai']);
      await callIpcRaw('projects:set-working-source-selection', f.project.id, other.visualIdentity, { action: 'exclude', expectedRevision: 2 });
      const review = await callIpcRaw('projects:prepare-package-review', f.project.id);
      assert.equal(review.materializable, true);
      assert.equal(review.files.some(row => row.visualIdentity === retained.visualIdentity), false);
      const latest = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      const excluded = latest.files.find(row => row.visualIdentity === retained.visualIdentity);
      assert.equal(excluded.includedAsDependency, false); assert.deepEqual(excluded.requiredBy, []);
      assert.ok(f.current().files.some(row => row.fileId === output.fileId));
      assert.ok(f.current().excludedAssetKeys.includes(output.fileId)); assert.deepEqual(fs.readFileSync(output.path), embeddedPng);
    } finally { f.cleanup(); }
  });

  for (const carrier of ['external', 'alias']) for (const collection of ['files', 'pendingFiles']) {
    baselineTest(`extra round: mixed ${carrier} duplicate preserves ${collection} row until unique proof`, async () => {
      const object = { id: psdId, name: 'Embedded.png', data: embeddedPng };
      const f = await workingPsdFixture([object]);
      try {
        const original = JSON.parse(JSON.stringify(f.rows()[0]));
        if (collection === 'pendingFiles') {
          f.current().files = f.current().files.filter(row => row.fileId !== original.fileId);
          f.current().pendingFiles = [...(f.current().pendingFiles || []), original];
        }
        f.current().excludedAssetKeys.push(original.fileId);
        const exclusions = [...f.current().excludedAssetKeys];
        const linkedPath = path.join(TEST_HOME, 'Desktop', 'External.png'); fs.writeFileSync(linkedPath, 'external');
        const duplicate = carrier === 'external' ? { id: psdId, name: 'External.png', childDocumentID: '', linkedFile: {
          fileSize: 8, name: 'External.png', fullPath: linkedPath, originalPath: '', relativePath: '' } }
          : { id: psdId, name: 'Alias.png' };
        await f.save([{ ...object, data: Buffer.from('replacement') }, duplicate]);
        assert.ok(Object.values(f.current().workingSourceVerification).some(record => record.unresolved.some(item => item.reason === 'ambiguous-linked-id')));
        assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).materializable, false);
        assert.ok((f.current().workingSourceRelationshipHolds || []).some(hold => hold.reason === 'psd-resource-identity-ambiguous' && hold.sourcePath === f.filePath));
        assert.equal(f.rows().length, 1); assert.deepEqual(f.current()[collection].find(row => row.fileId === original.fileId), original);
        assert.deepEqual(f.current().excludedAssetKeys, exclusions); assert.deepEqual(fs.readFileSync(original.path), embeddedPng);
        assert.equal(fs.readdirSync(path.dirname(original.path)).filter(name => !name.startsWith('.')).length, 1,
          'ambiguous replacement output is owned by this transaction and cleaned');
        const conflictedWorkspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        assert.equal(conflictedWorkspace.workingSourceSelectionBlocked, true);
        const replacement = { ...object, data: Buffer.from('unique replacement') };
        await f.save([replacement]);
        const current = f.current()[collection].find(row => row.fileId === original.fileId);
        assert.equal(f.rows().length, 1); assert.notEqual(current.path, original.path);
        assert.equal(current.assetOrigin, original.assetOrigin); assert.equal(current.projectRole, original.projectRole);
        assert.deepEqual(f.current().excludedAssetKeys, exclusions); assert.deepEqual(fs.readFileSync(current.path), replacement.data);
        assert.deepEqual(f.current().workingSourceRelationshipHolds, []); assert.ok(fs.existsSync(original.path));
        const reconciledReview = await callIpcRaw('projects:prepare-package-review', f.project.id);
        assert.equal(reconciledReview.materializable, collection === 'files');
        if (collection === 'pendingFiles') {
          assert.equal(reconciledReview.semanticCounts.missingRequiredReferences, 1);
          await callIpcRaw('projects:accept-pending', f.project.id, current.path);
          const acceptedReview = await callIpcRaw('projects:prepare-package-review', f.project.id);
          assert.equal(acceptedReview.materializable, true);
          assert.equal(acceptedReview.totalFiles, carrier === 'external' ? 3 : 2);
          assert.equal(acceptedReview.files.some(row => row.visualIdentity ===
            metadataTestHooks.createProjectFileVisualIdentity(f.project.id, current)), true);
        }
      } finally { f.cleanup(); }
    });
  }

  for (const kind of ['replacement-files', 'replacement-pending', 'fresh']) {
    for (const timing of ['before-output-hash', 'after-output-hash']) {
      baselineTest(`publication receipts: ${kind} rejects ${timing} byte rewrite`, async () => {
        const old = { id: psdId, name: 'Owned.bin', data: Buffer.from('old output bytes') };
        const replacement = { ...old, data: Buffer.from('new output bytes') };
        const f = await workingPsdFixture(kind === 'fresh' ? [] : [old]);
        const originalOpen = fs.promises.open;
        try {
          const original = f.rows()[0];
          if (kind === 'replacement-pending') {
            f.current().files = f.current().files.filter(row => row.fileId !== original.fileId);
            f.current().pendingFiles = [...(f.current().pendingFiles || []), original];
          }
          if (original) f.current().excludedAssetKeys.push(original.fileId);
          const rowsBefore = JSON.parse(JSON.stringify(f.rows()));
          const exclusions = [...f.current().excludedAssetKeys];
          const guards = [{ reason: 'psd-resource-domain-changed', sourcePath: f.filePath }];
          f.current().workingSourceRelationshipHolds = guards;
          const previousPaths = new Set(rowsBefore.map(row => row.path));
          const directory = path.join(f.privateTmp, 'crate-psd-extract-' + f.project.id);
          let hashed = false, changed = false, rewrittenPath = null;
          fs.promises.open = async function rewritePromotedOutput(filePath, ...args) {
            const handle = await originalOpen.call(fs.promises, filePath, ...args);
            if (filePath !== f.filePath && path.dirname(filePath) === directory &&
                !path.basename(filePath).startsWith('.') && !previousPaths.has(filePath)) {
              const read = handle.read.bind(handle);
              handle.read = async (...readArgs) => { const result = await read(...readArgs); hashed = true; return result; };
            }
            if (filePath === f.filePath && !changed && (timing === 'before-output-hash' || hashed) && fs.existsSync(directory)) {
              const candidate = fs.readdirSync(directory).map(name => path.join(directory, name))
                .find(candidate => !path.basename(candidate).startsWith('.') && !previousPaths.has(candidate));
              if (candidate) {
                const before = fs.statSync(candidate);
                const bytes = fs.readFileSync(candidate); bytes[0] ^= 0xff;
                fs.writeFileSync(candidate, bytes); fs.utimesSync(candidate, before.atimeMs / 1000, before.mtimeMs / 1000);
                const after = fs.statSync(candidate);
                assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino); assert.equal(after.size, before.size);
                changed = true; rewrittenPath = candidate;
              }
            }
            return handle;
          };
          fs.writeFileSync(f.filePath, f.write([replacement], [], 2));
          const result = await metadataTestHooks.runScanOnSave(f.project.id, f.filePath);
          assert.equal(changed, true, 'promoted output changes during later asynchronous source preparation');
          assert.equal(result.success, false, 'unverified output cannot authorize reconciliation');
          assert.deepEqual(f.rows(), rowsBefore);
          assert.deepEqual(f.current().excludedAssetKeys, exclusions);
          assert.deepEqual(f.current().workingSourceRelationshipHolds, guards);
          if (original) assert.deepEqual(fs.readFileSync(original.path), old.data);
          assert.equal(fs.existsSync(rewrittenPath), false, 'refused transaction cleans only its own unaccepted output');
          assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).materializable, false);
        } finally { fs.promises.open = originalOpen; f.cleanup(); }
      });
    }
  }


  for (const kind of ['restore', 'baseline']) for (const movement of ['changed-size', 'same-size']) {
    baselineTest(`publication receipts: ${kind} rejects ${movement} linked source rewrite after access`, async () => {
      const f = await correctionProject('.ai');
      const linked = path.join(TEST_HOME, 'Desktop', 'Late-linked.png'); fs.writeFileSync(linked, 'synthetic linked asset');
      fs.writeFileSync(f.filePath, `%PDF-1.7\n${linked}\n%%EOF\n`); fs.utimesSync(f.filePath, 1791100800, 1791100800);
      const keptPath = path.join(TEST_HOME, 'Desktop', 'Existing.png'); fs.writeFileSync(keptPath, 'preserved old asset');
      const kept = { path: keptPath, name: 'Existing.png', ext: '.png', source: 'user-added', projectRole: 'asset', fileId: crypto.randomUUID() };
      f.current().files.push(kept); f.current().excludedAssetKeys.push(kept.fileId);
      let source;
      if (kind === 'baseline') f.current().assetBaseline = { schemaVersion: 1, status: 'awaiting-first-scan' };
      else {
        const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        source = workspace.files.find(row => row.name === path.basename(f.filePath));
        await callIpcRaw('projects:set-working-source-selection', f.project.id, source.visualIdentity, { action: 'exclude', expectedRevision: 0 });
      }
      const preserved = JSON.parse(JSON.stringify(f.current().files.find(row => row.path === keptPath)));
      const exclusions = [...f.current().excludedAssetKeys];
      const originalAccess = fs.promises.access;
      let changed = false;
      fs.promises.access = async function rewriteAfterLinkedAccess(filePath, ...args) {
        const result = await originalAccess.call(fs.promises, filePath, ...args);
        if (filePath === linked && !changed) {
          changed = true;
          const before = fs.statSync(f.filePath);
          if (movement === 'same-size') {
            fs.writeFileSync(f.filePath, fs.readFileSync(f.filePath, 'utf8').replace(linked, ' '.repeat(linked.length)));
            fs.utimesSync(f.filePath, before.atimeMs / 1000, before.mtimeMs / 1000);
            const after = fs.statSync(f.filePath);
            assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
            assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
          } else fs.writeFileSync(f.filePath, '%PDF-1.7\n%%EOF\n');
        }
        return result;
      };
      try {
        const result = kind === 'restore'
          ? await callIpcRaw('projects:set-working-source-selection', f.project.id, source.visualIdentity, { action: 'restore', expectedRevision: 1 })
          : await metadataTestHooks.runScanOnOpen(f.project.id, f.filePath, null, null, { allowPausedBaseline: true });
        assert.equal(changed, true);
        if (kind === 'restore') assert.equal(result.verificationStatus, 'failed');
        else assert.equal(result.success, false);
        assert.equal([...f.current().files, ...(f.current().pendingFiles || [])].some(row => row.path === linked), false,
          'refused previous-byte links cannot persist as surplus package members');
        assert.deepEqual(f.current().files.find(row => row.path === keptPath), preserved);
        assert.deepEqual(f.current().excludedAssetKeys, exclusions); assert.equal(fs.readFileSync(keptPath, 'utf8'), 'preserved old asset');
        assert.equal(Object.values(f.current().workingSourceVerification)[0].status, 'failed');
        if (kind === 'restore') assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).materializable, false);
        fs.promises.access = originalAccess;
        const recovery = await metadataTestHooks.runScanOnOpen(f.project.id, f.filePath, null, null, { allowPausedBaseline: true });
        assert.equal(recovery.success, true); assert.equal(Object.values(f.current().workingSourceVerification)[0].status, 'scanned');
        assert.equal((await metadataTestHooks.selectProjectFilesForPackaging(f.current())).some(row => row.path === linked), false);
      } finally { fs.promises.access = originalAccess; clearTrackedTimers(); }
    });
  }

  for (const state of ['excluded', 'invalid']) {
    baselineTest(`independent root boundary: ${state} intent is handled without guessing a selected root`, async () => {
      const actual = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
      const bytes = actual.writePsdBuffer({ width: 1, height: 1 });
      const f = await workingPsdFixture([{ id: psdId, name: 'Boundary.psd', data: bytes }]);
      try {
        const child = JSON.parse(JSON.stringify(f.rows()[0]));
        manualDialogFor([child.path]); await callIpcRaw('projects:add-files', f.project.id);
        const identity = metadataTestHooks.createProjectFileVisualIdentity(f.project.id, child);
        await callIpcRaw('projects:set-working-source-selection', f.project.id, identity, { action: 'exclude', expectedRevision: 0 });
        const key = metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.current(), child);
        if (state === 'invalid') {
          await callIpcRaw('projects:set-working-source-selection', f.project.id, identity, { action: 'restore', expectedRevision: 1 });
          // Fault-injected persisted intent, not a valid IPC user action.
          f.current().workingSourceSelections[key] = { state: 'malformed', reason: null, revision: 2 };
        }
        const selection = JSON.parse(JSON.stringify(f.current().workingSourceSelections[key]));
        await f.save([], [], 2);
        const kept = f.current().files.find(row => row.fileId === child.fileId);
        assert.deepEqual(f.current().workingSourceSelections[key], selection); assert.deepEqual(fs.readFileSync(child.path), bytes);
        const review = await callIpcRaw('projects:prepare-package-review', f.project.id);
        if (state === 'excluded') {
          assert.equal(kept, undefined, 'a source excluded independently and not required elsewhere can retire');
          assert.equal(review.materializable, true); assert.equal(review.totalFiles, 1);
        } else {
          assert.ok(kept, 'malformed durable intent is held and never silently erased');
          assert.equal(kept.psdResource.current, false);
          const row = (await callIpcRaw('projects:get-asset-workspace', f.project.id)).files.find(row => row.visualIdentity === identity);
          assert.equal(row.sourceSelection, 'invalid'); assert.equal(review.materializable, false); assert.equal(review.token, undefined);
        }
      } finally { f.cleanup(); }
    });
  }

  for (const domain of ['root', 'layer']) for (const change of ['remove', 'replace']) {
    baselineTest(`independent root: ${domain} ${change} retains separately added restored child and its excluded required asset`, async () => {
      const actual = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
      // The linked asset path must be in the actual current synthetic home.
      const f = await workingPsdFixture([]);
      try {
        const requiredPath = path.join(TEST_HOME, 'Desktop', 'Child-required.png'); fs.writeFileSync(requiredPath, embeddedPng);
        const childBytes = width => actual.writePsdBuffer({ width, height: 1, linkedFiles: [{
          id: '99999999-9999-4999-8999-999999999999', name: 'Child-required.png', childDocumentID: '',
          linkedFile: { fileSize: embeddedPng.length, name: 'Child-required.png', fullPath: requiredPath,
            originalPath: '', relativePath: '' },
        }] });
        const object = { id: psdId, name: 'Independent.psd', data: childBytes(1) };
        const linked = value => domain === 'root' ? [value] : [];
        const children = value => domain === 'layer' ? [{ name: 'independent layer', linkedFiles: [value] }] : [];
        await f.save(linked(object), children(object), 2);
        const child = JSON.parse(JSON.stringify(f.rows()[0]));
        manualDialogFor([child.path]); await callIpcRaw('projects:add-files', f.project.id);
        let workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        let childPresentation = workspace.files.find(row => row.visualIdentity ===
          metadataTestHooks.createProjectFileVisualIdentity(f.project.id, child));
        assert.equal(childPresentation.sourceSelection, 'selected');
        assert.equal((await callIpcRaw('projects:set-working-source-selection', f.project.id, childPresentation.visualIdentity,
          { action: 'exclude', expectedRevision: 0 })).success, true);
        assert.equal((await callIpcRaw('projects:set-working-source-selection', f.project.id, childPresentation.visualIdentity,
          { action: 'restore', expectedRevision: 1 })).verificationStatus, 'scanned');
        const required = f.current().files.find(row => row.path === requiredPath); assert.ok(required);
        await callIpcRaw('projects:remove-file', f.project.id,
          metadataTestHooks.createProjectFileVisualIdentity(f.project.id, required));
        assert.ok(f.current().excludedAssetKeys.includes(required.fileId || required.path));
        const key = metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.current(), child);
        const selection = JSON.parse(JSON.stringify(f.current().workingSourceSelections[key]));
        const verification = JSON.parse(JSON.stringify(f.current().workingSourceVerification[key]));
        const authority = JSON.parse(JSON.stringify(f.current().files.find(row => row.fileId === child.fileId).explicitUserAuthority));
        assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).totalFiles, 3);
        storeInstance.data.projects = JSON.parse(JSON.stringify(storeInstance.data.projects));
        const replacement = { ...object, data: childBytes(2) };
        await f.save(change === 'remove' ? [] : linked(replacement), change === 'remove' ? [] : children(replacement), 3);
        const kept = f.current().files.find(row => row.fileId === child.fileId);
        assert.ok(kept, 'independently selected source must survive retirement of its former producer relationship');
        assert.equal(kept.path, child.path); assert.equal(kept.psdResource.current, false);
        assert.deepEqual(fs.readFileSync(kept.path), object.data); assert.deepEqual(kept.explicitUserAuthority, authority);
        assert.deepEqual(f.current().workingSourceSelections[key], selection);
        assert.deepEqual(f.current().workingSourceVerification[key], verification);
        workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        childPresentation = workspace.files.find(row => row.visualIdentity ===
          metadataTestHooks.createProjectFileVisualIdentity(f.project.id, kept));
        assert.equal(childPresentation.sourceSelection, 'selected'); assert.equal(childPresentation.effectiveRole, 'source');
        assert.equal(childPresentation.includedAsDependency, false); assert.deepEqual(childPresentation.requiredBy, []);
        const asset = workspace.files.find(row => row.visualIdentity ===
          metadataTestHooks.createProjectFileVisualIdentity(f.project.id, required));
        assert.equal(asset.includedAsDependency, true); assert.deepEqual(asset.requiredBy, [path.basename(child.path)]);
        const review = await callIpcRaw('projects:prepare-package-review', f.project.id);
        assert.equal(review.materializable, true); assert.equal(review.semanticCounts.selectedWorkingSources, 2);
        assert.equal(review.totalFiles, change === 'remove' ? 3 : 4);
        assert.equal(review.files.some(row => row.visualIdentity === asset.visualIdentity), true);
        if (change === 'replace') {
          const current = f.rows().find(row => row.psdResource.current !== false && row.psdResource.parentPath === f.filePath);
          assert.ok(current); assert.notEqual(current.path, kept.path); assert.notEqual(current.fileId, kept.fileId);
          assert.deepEqual(fs.readFileSync(current.path), replacement.data);
        }
        fs.unlinkSync(requiredPath);
        const missing = await callIpcRaw('projects:prepare-package-review', f.project.id);
        assert.equal(missing.materializable, false); assert.equal(missing.semanticCounts.missingRequiredReferences, 1);
        fs.writeFileSync(requiredPath, embeddedPng);
        await callIpcRaw('projects:set-working-source-selection', f.project.id, childPresentation.visualIdentity,
          { action: 'exclude', expectedRevision: 2 });
        const excluded = await callIpcRaw('projects:prepare-package-review', f.project.id);
        assert.equal(excluded.materializable, true); assert.equal(excluded.semanticCounts.selectedWorkingSources, 1);
        assert.equal(excluded.totalFiles, change === 'remove' ? 1 : 2);
      } finally { f.cleanup(); }
    });
  }

  baselineTest('output obligation hash: shared producer receipts attempt a failed physical read once per projection', async () => {
    const f = await workingPsdFixture([{ id: psdId, name: 'Shared-read.png', data: embeddedPng }]);
    const open = fs.openSync;
    try {
      const output = f.rows()[0], project = f.current(), producer = project.files.find(row => row.path === f.filePath);
      const secondPath = path.join(TEST_HOME, 'Desktop', 'Second-producer.psd'); fs.writeFileSync(secondPath, fs.readFileSync(f.filePath));
      const second = { ...producer, path: secondPath, name: 'Second-producer.psd', fileId: 'second-producer' }; project.files.push(second);
      const key = metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(project, second), stat = fs.statSync(secondPath);
      // Modeled valid persisted receipt for another source with identical bytes;
      // exercise shared obligation accounting, not native producer association.
      project.workingSourceVerification[key] = { ...metadataTestHooks.getWorkingSourceVerification(project, producer),
        selectionRevision: 0, attempt: 'second-producer-receipt', sourceIdentity: { dev: stat.dev, ino: stat.ino,
          size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs } };
      let attempts = 0;
      fs.openSync = function refusedSharedOutput(filePath, ...args) {
        if (filePath === output.path) { attempts++; throw new Error('modeled output read refusal'); }
        return open.call(fs, filePath, ...args);
      };
      const membership = metadataTestHooks.getWorkingSourceMembership(project, project.files);
      assert.equal(attempts, 1); assert.equal(membership.blocked, true);
      assert.equal(membership.counts.unresolvedVerification, 1, 'one failed output fact, not one per producer');
    } finally { fs.openSync = open; f.cleanup(); }
  });

  baselineTest('output obligation hash: explicit byte bound retires a modeled growing read with fixed scratch', async () => {
    const f = await correctionProject('.txt', '12345678');
    const originalRead = fs.readSync;
    try {
      const expected = metadataTestHooks.getPackageReviewSourceFingerprint(f.filePath);
      assert.match(metadataTestHooks.getStablePackageReviewSourceContentFingerprint(f.filePath, expected, 8), /^8:[a-f0-9]{64}$/);
      let reads = 0;
      fs.readSync = function modeledGrowingRead(fd, buffer, offset, length, position) {
        reads++; assert.equal(buffer.length, 1024 * 1024);
        if (reads === 1) return originalRead.call(fs, fd, buffer, offset, length, position);
        if (reads > 3) throw new Error('byte bound did not stop growing read');
        buffer.fill(1, 0, 8); return 8;
      };
      assert.throws(() => metadataTestHooks.getStablePackageReviewSourceContentFingerprint(f.filePath, expected, 8),
        error => error.constructor.name === 'PackageReviewChangedError');
      assert.equal(reads, 2); assert.equal(fs.readFileSync(f.filePath, 'utf8'), '12345678');
    } finally { fs.readSync = originalRead; clearTrackedTimers(); }
  });

  for (const domain of ['root', 'layer']) {
    baselineTest(`output closure bytes: ${domain} source-bound receipt refuses altered physical output and recovers exact bytes`, async () => {
      const object = { id: psdId, name: 'Bound.png', data: embeddedPng };
      const f = await workingPsdFixture(domain === 'root' ? [object] : [],
        domain === 'layer' ? [{ name: 'bound layer', linkedFiles: [object] }] : []);
      try {
        const output = f.rows()[0]; const sourceBytes = fs.readFileSync(f.filePath);
        const stat = fs.statSync(output.path); const altered = Buffer.from(embeddedPng); altered[altered.length - 1] ^= 1;
        assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).materializable, true);
        fs.writeFileSync(output.path, altered); fs.utimesSync(output.path, stat.atimeMs / 1000, stat.mtimeMs / 1000);
        assert.deepEqual(fs.readFileSync(f.filePath), sourceBytes);
        const changed = await callIpcRaw('projects:prepare-package-review', f.project.id);
        assert.equal(changed.materializable, false, 'actual derived bytes must satisfy the validated current source receipt');
        assert.equal(changed.token, undefined);
        let workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        assert.equal(workspace.workingSourceSelectionBlocked, true);
        assert.equal(workspace.semanticCounts.unresolvedVerification, 1);
        assert.deepEqual(workspace.semanticCounts, changed.semanticCounts);
        const broken = workspace.files.find(row => row.name === 'Bound.png');
        assert.equal(broken.verificationStatus, 'incomplete'); assert.equal(broken.verificationRequired, true);
        const producer = f.current().files.find(row => row.path === f.filePath);
        assert.equal(metadataTestHooks.getWorkingSourceVerification(f.current(), producer).status, 'scanned', 'source bytes remain valid');
        fs.writeFileSync(output.path, embeddedPng);
        const recovered = await callIpcRaw('projects:prepare-package-review', f.project.id);
        assert.equal(recovered.materializable, true); assert.equal(recovered.totalFiles, 2);
        workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        assert.equal(workspace.workingSourceSelectionBlocked, false); assert.equal(workspace.semanticCounts.unresolvedVerification, 0);
        assert.deepEqual(workspace.semanticCounts, recovered.semanticCounts);
        // Only an inactive producer's obligation is released; a separate root
        // requiring that producer keeps the same concrete output receipt active.
        const safe = path.join(TEST_HOME, 'Desktop', 'Parity-safe.txt'); fs.writeFileSync(safe, 'safe independent asset');
        f.current().files.push({ path: safe, name: 'Parity-safe.txt', ext: '.txt', source: 'user-added', acceptedPending: true, projectRole: 'asset' });
        fs.writeFileSync(output.path, altered);
        await callIpcRaw('projects:set-working-source-selection', f.project.id, f.source.visualIdentity, { action: 'exclude', expectedRevision: 2 });
        workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        assert.equal(workspace.workingSourceSelectionBlocked, false);
        assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).materializable, true);
        const consumer = path.join(TEST_HOME, 'Desktop', 'Parity-consumer.ai'); fs.writeFileSync(consumer, `%PDF-1.7\n${f.filePath}\n%%EOF\n`);
        f.current().files.push({ path: consumer, name: 'Parity-consumer.ai', ext: '.ai', source: 'user-added', acceptedPending: true, projectRole: 'source' });
        assert.equal((await metadataTestHooks.runScanOnOpen(f.project.id, consumer, null, null,
          { establishBaseline: false, allowPausedBaseline: true })).success, true);
        workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        assert.equal(workspace.files.find(row => row.name === 'Correction.psd').includedAsDependency, true);
        assert.equal(workspace.workingSourceSelectionBlocked, true); assert.equal(workspace.semanticCounts.unresolvedVerification, 1);
        const requiredReview = await callIpcRaw('projects:prepare-package-review', f.project.id);
        assert.equal(requiredReview.materializable, false); assert.equal(requiredReview.token, undefined);
        assert.deepEqual(workspace.semanticCounts, requiredReview.semanticCounts);
        fs.writeFileSync(output.path, embeddedPng);
        assert.equal((await callIpcRaw('projects:get-asset-workspace', f.project.id)).workingSourceSelectionBlocked, false);
        const consumerRow = f.current().files.find(row => row.path === consumer);
        await callIpcRaw('projects:set-working-source-selection', f.project.id,
          metadataTestHooks.createProjectFileVisualIdentity(f.project.id, consumerRow), { action: 'exclude', expectedRevision: 0 });
        await callIpcRaw('projects:set-working-source-selection', f.project.id, f.source.visualIdentity, { action: 'restore', expectedRevision: 3 });
        await f.save([], [], 2);
        assert.equal(f.rows().length, 0, 'source-validated retirement releases only its old output obligation');
        workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        assert.equal(workspace.workingSourceSelectionBlocked, false); assert.equal(workspace.semanticCounts.unresolvedVerification, 0);
        assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).materializable, true);
      } finally { f.cleanup(); }
    });
  }

  for (const domain of ['root', 'layer']) for (const pending of [false, true]) {
    baselineTest(`dormant output: ${domain} ${pending ? 'rejection' : 'bytes'} remains bound when another source engages selection`, async () => {
      const object = { id: psdId, name: 'Dormant.png', data: embeddedPng };
      const f = await workingPsdFixture(domain === 'root' ? [object] : [],
        domain === 'layer' ? [{ name: 'dormant layer', linkedFiles: [object] }] : [], true, pending, false);
      try {
        const output = JSON.parse(JSON.stringify(f.rows()[0]));
        const sourceBytes = fs.readFileSync(f.filePath);
        const producer = f.current().files.find(row => row.path === f.filePath);
        const producerKey = metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.current(), producer);
        assert.equal(Object.keys(f.current().workingSourceSelections || {}).length, 0);
        assert.equal(Boolean((await callIpcRaw('projects:prepare-package-review', f.project.id)).materializable), !pending,
          'dormant admission retains its existing accepted/pending decision behavior');
        if (pending) {
          assert.ok(f.current().pendingFiles.some(row => row.fileId === output.fileId));
          await callIpcRaw('projects:reject-pending', f.project.id, output.path);
          assert.equal(f.rows().length, 0); assert.ok(f.current().excludedAssetKeys.includes(output.fileId));
          await callIpcRaw('projects:set-existing-assets-decision', f.project.id, 'include');
        }
        const otherPath = path.join(TEST_HOME, 'Desktop', 'Engage-other.ai');
        fs.writeFileSync(otherPath, '%PDF-1.7\n%%EOF\n');
        manualDialogFor([otherPath]); await callIpcRaw('projects:add-files', f.project.id);
        const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        const other = workspace.files.find(row => row.name === path.basename(otherPath));
        assert.ok(other);
        await callIpcRaw('projects:set-working-source-selection', f.project.id, other.visualIdentity,
          { action: 'exclude', expectedRevision: 0 });
        assert.equal(f.current().workingSourceSelections?.[producerKey], undefined, 'producer is never Excluded/Restored');
        if (!pending) {
          assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).materializable, true);
          const stat = fs.statSync(output.path), altered = Buffer.from(embeddedPng); altered[altered.length - 1] ^= 1;
          fs.writeFileSync(output.path, altered); fs.utimesSync(output.path, stat.atimeMs / 1000, stat.mtimeMs / 1000);
        }
        const assertBlocked = async () => {
          const changed = await callIpcRaw('projects:prepare-package-review', f.project.id);
          assert.equal(changed.materializable, false, 'dormant worker obligation survives unrelated-source engagement');
          assert.equal(changed.token, undefined);
          if (pending) assert.equal(changed.semanticCounts.missingRequiredReferences, 1);
        };
        await assertBlocked();
        storeInstance.data.projects = JSON.parse(JSON.stringify(storeInstance.data.projects));
        await assertBlocked();
        assert.deepEqual(fs.readFileSync(f.filePath), sourceBytes);
        const receipt = f.current().workingSourceVerification[producerKey].requiredEmbeddedOutputs;
        assert.equal(receipt.length, 1); assert.equal(receipt[0].path, output.path);
        if (!pending) {
          fs.writeFileSync(output.path, embeddedPng);
          const recovered = await callIpcRaw('projects:prepare-package-review', f.project.id);
          assert.equal(recovered.materializable, true); assert.equal(recovered.totalFiles, 2);
        }
      } finally { f.cleanup(); }
    });
  }

  for (const domain of ['root', 'layer']) for (const pending of [false, true]) {
    baselineTest(`baseline output reuse: ${domain} ${pending ? 'pending' : 'accepted'} partial scan retry keeps exact borrowed output obligation`, async () => {
      const object = { id: psdId, name: 'Borrowed.png', data: embeddedPng };
      const f = await workingPsdFixture(domain === 'root' ? [object] : [],
        domain === 'layer' ? [{ name: 'borrowed layer', linkedFiles: [object] }] : [], true, pending, false, true);
      try {
        assert.equal(f.current().assetBaseline.status, 'awaiting-first-scan');
        const original = JSON.parse(JSON.stringify(f.rows()[0]));
        assert.ok(original);
        assert.equal((f.current().pendingFiles || []).some(row => row.fileId === original.fileId), pending);
        fs.writeFileSync(f.retrySiblingPath, f.write([], []));
        manualDialogFor([f.filePath]); await callIpcRaw('projects:add-files', f.project.id);
        assert.equal(f.current().assetBaseline.status, 'decision-required');
        assert.equal(f.rows().length, 1, 'successful source retry borrows rather than readmits the output');
        assert.equal(f.rows()[0].path, original.path); assert.equal(f.rows()[0].fileId, original.fileId);
        assert.deepEqual(fs.readFileSync(original.path), embeddedPng);
        await callIpcRaw('projects:set-existing-assets-decision', f.project.id, 'include');
        const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        const other = workspace.files.find(row => row.name === path.basename(f.retrySiblingPath));
        await callIpcRaw('projects:set-working-source-selection', f.project.id, other.visualIdentity,
          { action: 'exclude', expectedRevision: 0 });
        const assertReady = async () => {
          const review = await callIpcRaw('projects:prepare-package-review', f.project.id);
          assert.equal(review.materializable, true, 'retained physical output satisfies its validated receipt after retry');
          assert.equal(review.totalFiles, 2); assert.equal(review.semanticCounts.missingRequiredReferences, 0);
        };
        await assertReady();
        storeInstance.data.projects = JSON.parse(JSON.stringify(storeInstance.data.projects));
        await assertReady();
        const key = metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.current(),
          f.current().files.find(row => row.path === f.filePath));
        assert.equal(f.current().workingSourceVerification[key].requiredEmbeddedOutputs[0].path, original.path);
        const altered = Buffer.from(embeddedPng); altered[altered.length - 1] ^= 1;
        fs.writeFileSync(original.path, altered);
        assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).materializable, false,
          'reused receipt still binds the retained output bytes');
        fs.writeFileSync(original.path, embeddedPng); await assertReady();
      } finally { f.cleanup(); }
    });
  }

  for (const fault of ['not-array', 'wrong-source', 'wrong-output', 'too-many', 'long-path', 'total-path-budget']) {
    baselineTest(`rejected receipt: ${fault} blocks workspace and review conservatively`, async () => {
      const f = await workingPsdFixture([{ id: psdId, name: 'Receipt.png', data: embeddedPng }], [], false, true);
      try {
        const output = f.rows()[0];
        await callIpcRaw('projects:reject-pending', f.project.id, output.path);
        const key = metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.current(),
          f.current().files.find(row => row.path === f.filePath));
        const record = f.current().workingSourceVerification[key];
        assert.equal(record.requiredEmbeddedOutputs.length, 1, 'receipt comes from an actual validated worker result');
        const receipt = { ...record.requiredEmbeddedOutputs[0] };
        if (fault === 'not-array') record.requiredEmbeddedOutputs = {};
        else if (fault === 'wrong-source') record.requiredEmbeddedOutputs = [{ ...receipt, sourceDigest: '0'.repeat(64) }];
        else if (fault === 'wrong-output') record.requiredEmbeddedOutputs = [{ ...receipt, outputDigest: 'invalid' }];
        else if (fault === 'too-many') record.requiredEmbeddedOutputs = Array(8193).fill(receipt);
        else if (fault === 'long-path') record.requiredEmbeddedOutputs = [{ ...receipt, path: '/Users/' + 'x'.repeat(16384) }];
        else record.requiredEmbeddedOutputs = Array(4096).fill({ ...receipt, path: '/Users/' + 'x'.repeat(1100) });
        const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        assert.equal(workspace.workingSourceSelectionBlocked, true); assert.ok(workspace.semanticCounts.unresolvedVerification > 0);
        const review = await callIpcRaw('projects:prepare-package-review', f.project.id);
        assert.equal(review.materializable, false); assert.equal(review.token, undefined);
      } finally { f.cleanup(); }
    });
  }

  for (const domain of ['root', 'layer']) for (const route of ['restore', 'save']) {
    baselineTest(`rejected output: ${domain} ${route} retains source obligation through rejection reload exclusion and retirement`, async () => {
      const object = { id: psdId, name: 'Rejected.png', data: embeddedPng };
      const linked = domain === 'root' ? [object] : [];
      const children = domain === 'layer' ? [{ name: 'rejected layer', linkedFiles: [object] }] : [];
      const f = await workingPsdFixture(route === 'restore' ? linked : [], route === 'restore' ? children : [], false, true);
      try {
        if (route === 'save') await f.save(linked, children, 2);
        const output = JSON.parse(JSON.stringify(f.rows()[0]));
        const sourceBytes = fs.readFileSync(f.filePath);
        assert.equal(f.current().pendingFiles.some(row => row.fileId === output.fileId), true);
        assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).materializable, false);
        await callIpcRaw('projects:reject-pending', f.project.id, output.path);
        assert.equal(f.rows().length, 0, 'Reject keeps its normal row-removal behavior');
        assert.ok(f.current().excludedAssetKeys.includes(output.fileId), 'Reject intent survives');
        assert.deepEqual(fs.readFileSync(f.filePath), sourceBytes, 'rejection never changes the source proof');
        assert.ok(fs.existsSync(output.path));
        const assertBlocked = async () => {
          const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
          assert.equal(workspace.workingSourceSelectionBlocked, true, 'deleting the candidate cannot erase its source requirement');
          assert.equal(workspace.semanticCounts.missingRequiredReferences, 1);
          const review = await callIpcRaw('projects:prepare-package-review', f.project.id);
          assert.equal(review.materializable, false); assert.equal(review.token, undefined);
          assert.equal(review.semanticCounts.missingRequiredReferences, 1);
        };
        await assertBlocked();
        storeInstance.data.projects = JSON.parse(JSON.stringify(storeInstance.data.projects));
        await assertBlocked();
        const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        const source = workspace.files.find(row => row.name === path.basename(f.filePath));
        await callIpcRaw('projects:set-working-source-selection', f.project.id, source.visualIdentity, { action: 'exclude', expectedRevision: 2 });
        const excludedReview = await callIpcRaw('projects:prepare-package-review', f.project.id);
        assert.equal(excludedReview.semanticCounts.selectedWorkingSources, 0);
        assert.equal(excludedReview.semanticCounts.missingRequiredReferences, 0);
        assert.equal((await callIpcRaw('projects:get-asset-workspace', f.project.id)).workingSourceSelectionBlocked, false,
          'inactive root does not require its rejected output; an empty package is still unavailable');
        await callIpcRaw('projects:set-working-source-selection', f.project.id, source.visualIdentity, { action: 'restore', expectedRevision: 3 });
        const restoredOutput = f.rows()[0];
        assert.ok(restoredOutput, 'a fresh Restore reparses the current saved producer');
        await callIpcRaw('projects:reject-pending', f.project.id, restoredOutput.path);
        await assertBlocked();
        await f.save([], [], 4);
        const retired = await callIpcRaw('projects:prepare-package-review', f.project.id);
        assert.equal(retired.materializable, true); assert.equal(retired.totalFiles, 1);
        assert.equal(retired.semanticCounts.missingRequiredReferences, 0);
        assert.ok(f.current().excludedAssetKeys.includes(output.fileId)); assert.ok(fs.existsSync(output.path));
      } finally { f.cleanup(); }
    });
  }

  for (const domain of ['root', 'layer']) {
    baselineTest(`rejected output: ${domain} retirement preserves another real source obligation after rejection`, async () => {
      const object = { id: psdId, name: 'Shared.png', data: embeddedPng };
      const f = await workingPsdFixture(domain === 'root' ? [object] : [],
        domain === 'layer' ? [{ name: 'shared layer', linkedFiles: [object] }] : [], false, true);
      try {
        const output = JSON.parse(JSON.stringify(f.rows()[0]));
        await callIpcRaw('projects:reject-pending', f.project.id, output.path);
        assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).materializable, false,
          'a later independent scanner must not be needed to notice the rejected obligation');
        const otherPath = path.join(TEST_HOME, 'Desktop', 'Other-required.ai');
        fs.writeFileSync(otherPath, `%PDF-1.7\n${output.path}\n%%EOF\n`);
        f.current().files.push({ path: otherPath, name: path.basename(otherPath), ext: '.ai', source: 'user-added',
          acceptedPending: true, projectRole: 'source' });
        assert.equal((await metadataTestHooks.runScanOnOpen(f.project.id, otherPath, null, null,
          { establishBaseline: false, allowPausedBaseline: true })).success, true);
        let workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        const physical = f.current().files.find(row => row.path === output.path);
        assert.ok(physical, 'actual ordinary scanner satisfies the physical obligation');
        assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).materializable, true);
        await callIpcRaw('projects:remove-file', f.project.id,
          metadataTestHooks.createProjectFileVisualIdentity(f.project.id, physical));
        assert.equal(f.current().files.some(row => row.path === output.path), true, 'asset removal preserves the row and toggles exclusion');
        assert.ok(f.current().excludedAssetKeys.includes(physical.fileId || physical.path));
        assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).materializable, true,
          'a known required asset overrides its exclusion');
        await f.save([], [], 2);
        const stillRequired = await callIpcRaw('projects:prepare-package-review', f.project.id);
        assert.equal(stillRequired.materializable, true); assert.equal(stillRequired.totalFiles, 3);
        const retained = (await callIpcRaw('projects:get-asset-workspace', f.project.id)).files.find(row =>
          row.visualIdentity === metadataTestHooks.createProjectFileVisualIdentity(f.project.id, physical));
        assert.equal(retained.includedAsDependency, true); assert.deepEqual(retained.requiredBy, [path.basename(otherPath)],
          'retiring the PSD resource cannot erase another root external reference');
        workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        const other = workspace.files.find(row => row.name === path.basename(otherPath));
        await callIpcRaw('projects:set-working-source-selection', f.project.id, other.visualIdentity, { action: 'exclude', expectedRevision: 0 });
        const released = await callIpcRaw('projects:prepare-package-review', f.project.id);
        assert.equal(released.materializable, true); assert.equal(released.totalFiles, 1);
        assert.ok(f.current().excludedAssetKeys.includes(output.fileId)); assert.ok(fs.existsSync(output.path));
      } finally { f.cleanup(); }
    });
  }

  for (const domain of ['root', 'layer']) for (const route of ['restore', 'save']) for (const admission of ['direct', 'pending']) {
    baselineTest(`producer closure: non-Add-Files ${route} ${domain} ${admission} survives acceptance exclusion reload and saves`, async () => {
      const original = { id: psdId, name: 'Ordinary.bin', data: Buffer.from('ordinary original output') };
      const linked = value => domain === 'root' ? [value] : [];
      const children = value => domain === 'layer' ? [{ name: 'ordinary layer', linkedFiles: [value] }] : [];
      const f = await workingPsdFixture(route === 'restore' ? linked(original) : [],
        route === 'restore' ? children(original) : [], false, admission === 'pending');
      try {
        assert.equal(f.current().assetBaseline.status, 'legacy-included');
        if (route === 'save') await f.save(linked(original), children(original), 2);
        assert.equal(f.rows().length, 1);
        let output = f.rows()[0];
        assert.equal(output.assetBaselineSourcePath, undefined, 'ordinary admission has no paused baseline stamp');
        assert.equal(output.psdResource.parentPath, f.filePath);
        assert.equal(output.psdResource.version, 1);
        assert.equal(Object.values(f.current().workingSourceVerification)[0].requiredReferences.length, 0,
          'embedded producer obligations must not be invented as external references');
        if (admission === 'pending') {
          assert.equal(f.current().files.some(row => row.path === output.path), false);
          assert.equal(f.current().pendingFiles.some(row => row.path === output.path), true);
          const pendingReview = await callIpcRaw('projects:prepare-package-review', f.project.id);
          assert.equal(pendingReview.materializable, false);
          assert.equal(pendingReview.semanticCounts.missingRequiredReferences, 1, 'pending current output is a known required obligation');
          const accepted = await callIpcRaw('projects:accept-pending', f.project.id, output.path);
          assert.equal(accepted.files.some(row => row.fileId === output.fileId), true);
        } else assert.equal(f.current().files.some(row => row.path === output.path), true);
        output = f.current().files.find(row => row.fileId === output.fileId);
        assert.equal(output.captureEvidence, undefined, 'production direct/accept paths strip transient evidence');
        f.current().excludedAssetKeys.push(output.fileId);
        const assertClosure = async currentOutput => {
          const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
          const identity = metadataTestHooks.createProjectFileVisualIdentity(f.project.id, currentOutput);
          const row = workspace.files.find(row => row.visualIdentity === identity);
          assert.equal(row.includedAsDependency, true, 'validated current producer relationship must survive transient admission metadata');
          assert.deepEqual(row.requiredBy, [path.basename(f.filePath)]);
          const review = await callIpcRaw('projects:prepare-package-review', f.project.id);
          assert.equal(review.materializable, true); assert.equal(review.totalFiles, 2);
          assert.equal(review.semanticCounts.includedAssets, 1); assert.equal(review.semanticCounts.missingRequiredReferences, 0);
          assert.equal(review.files.some(row => row.visualIdentity === identity), true, 'exclusion cannot drop a required current output');
        };
        await assertClosure(output);
        storeInstance.data.projects = JSON.parse(JSON.stringify(storeInstance.data.projects));
        await assertClosure(output);
        await f.save(linked(original), children(original), route === 'save' ? 2 : 1);
        assert.equal(f.rows()[0].path, output.path); await assertClosure(f.rows()[0]);
        const replacement = { ...original, data: Buffer.from('ordinary replacement output') };
        await f.save(linked(replacement), children(replacement), 3);
        const replaced = f.rows()[0];
        assert.equal(replaced.fileId, output.fileId); assert.notEqual(replaced.path, output.path);
        assert.equal(replaced.assetBaselineSourcePath, undefined);
        assert.ok(f.current().excludedAssetKeys.includes(replaced.fileId));
        await assertClosure(replaced);
        await f.save([], [], 4); assert.equal(f.rows().length, 0);
        assert.ok(fs.existsSync(replaced.path), 'retirement preserves old physical bytes');
        const review = await callIpcRaw('projects:prepare-package-review', f.project.id);
        assert.equal(review.materializable, true); assert.equal(review.totalFiles, 1);
      } finally { f.cleanup(); }
    });
  }

  for (const domain of ['root', 'layer']) for (const collection of ['files', 'pendingFiles']) {
    baselineTest(`final graph: ${domain} ${collection} replacement preserves proven producer edge`, async () => {
      const originalObject = { id: psdId, name: 'Resource.bin', data: Buffer.from('old resource') };
      const children = domain === 'layer' ? [{ name: 'resource layer', linkedFiles: [originalObject] }] : [];
      const f = await workingPsdFixture(domain === 'root' ? [originalObject] : [], children, true);
      try {
        const original = JSON.parse(JSON.stringify(f.rows()[0]));
        assert.equal(original.assetBaselineSourcePath, f.filePath);
        f.current().excludedAssetKeys.push(original.fileId);
        if (collection === 'pendingFiles') {
          f.current().files = f.current().files.filter(row => row.fileId !== original.fileId);
          f.current().pendingFiles = [...(f.current().pendingFiles || []), original];
        }
        const replacement = { ...originalObject, data: Buffer.from('changed resource') };
        await f.save(domain === 'root' ? [replacement] : [], domain === 'layer' ? [{ name: 'resource layer', linkedFiles: [replacement] }] : []);
        const current = f.current()[collection].find(row => row.fileId === original.fileId);
        assert.equal(current.assetBaselineSourcePath, f.filePath, 'same proved producer relationship must survive replacement');
        assert.notEqual(current.path, original.path); assert.deepEqual(fs.readFileSync(current.path), replacement.data);
        assert.ok(f.current().excludedAssetKeys.includes(current.fileId));
        if (collection === 'pendingFiles') {
          const accepted = await callIpcRaw('projects:accept-pending', f.project.id, current.path);
          assert.equal(accepted.files.some(row => row.fileId === current.fileId), true);
          // Retain the user's exclusion to exercise the dependency override,
          // independently of the explicit accept command's inclusion intent.
          if (!f.current().excludedAssetKeys.includes(current.fileId)) f.current().excludedAssetKeys.push(current.fileId);
        }
        const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        const row = workspace.files.find(row => row.visualIdentity === metadataTestHooks.createProjectFileVisualIdentity(f.project.id, current));
        assert.equal(row.includedAsDependency, true); assert.deepEqual(row.requiredBy, [path.basename(f.filePath)]);
        const review = await callIpcRaw('projects:prepare-package-review', f.project.id);
        assert.equal(review.materializable, true); assert.equal(review.totalFiles, 2); assert.equal(review.semanticCounts.includedAssets, 1);
        assert.equal(review.files.some(file => file.visualIdentity === row.visualIdentity), true);
        await f.save([], [], 2); assert.equal(f.rows().length, 0); assert.ok(fs.existsSync(current.path));
        assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).totalFiles, 1);
      } finally { f.cleanup(); }
    });
  }

  for (const mutation of ['restore', 'scan']) {
    baselineTest(`final graph: ${mutation} of another root during source hash refuses stale retirement`, async () => {
      const f = await workingPsdFixture([{ id: psdId, name: 'Embedded.png', data: embeddedPng }], [], true);
      let restorePause, saving;
      const gate = deferred();
      try {
        const output = JSON.parse(JSON.stringify(f.rows()[0]));
        const otherPath = path.join(TEST_HOME, 'Desktop', 'Concurrent.ai');
        const linkedBytes = `%PDF-1.7\n${output.path}\n%%EOF\n`;
        fs.writeFileSync(otherPath, mutation === 'restore' ? linkedBytes : '%PDF-1.7\n%%EOF\n');
        f.current().files.push({ path: otherPath, name: 'Concurrent.ai', ext: '.ai', source: 'user-added', acceptedPending: true, projectRole: 'source' });
        const scanOther = () => metadataTestHooks.runScanOnOpen(f.project.id, otherPath, null, null,
          { establishBaseline: false, allowPausedBaseline: true });
        assert.equal((await scanOther()).success, true);
        const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        const other = workspace.files.find(row => row.name === 'Concurrent.ai');
        if (mutation === 'restore') await callIpcRaw('projects:set-working-source-selection', f.project.id, other.visualIdentity, { action: 'exclude', expectedRevision: 0 });
        f.current().excludedAssetKeys.push(output.fileId);
        const guards = [{ reason: 'psd-resource-domain-changed', sourcePath: f.filePath }]; f.current().workingSourceRelationshipHolds = guards;
        const before = JSON.parse(JSON.stringify([f.current().files, f.current().pendingFiles || []]));
        const exclusions = [...f.current().excludedAssetKeys];
        let entered = false;
        restorePause = metadataTestHooks.pauseWorkingPsdPublicationSource(async () => { entered = true; await gate.promise; });
        fs.writeFileSync(f.filePath, f.write([], [], 2));
        saving = metadataTestHooks.runScanOnSave(f.project.id, f.filePath);
        await waitForCondition(() => entered, 'PSD final source hash did not pause');
        if (mutation === 'restore') {
          const restored = await callIpcRaw('projects:set-working-source-selection', f.project.id, other.visualIdentity, { action: 'restore', expectedRevision: 1 });
          assert.equal(restored.verificationStatus, 'scanned');
        } else { fs.writeFileSync(otherPath, linkedBytes); assert.equal((await scanOther()).success, true); }
        assert.deepEqual([f.current().files, f.current().pendingFiles || []], before, 'other-root graph changes need not change row arrays');
        gate.release(); const result = await saving; saving = null;
        assert.equal(result.success, false, 'old prospective graph cannot authorize retirement');
        assert.deepEqual([f.current().files, f.current().pendingFiles || []], before);
        assert.deepEqual(f.current().excludedAssetKeys, exclusions); assert.deepEqual(f.current().workingSourceRelationshipHolds, guards);
        assert.deepEqual(fs.readFileSync(output.path), embeddedPng);
        restorePause(); restorePause = null;
        assert.equal((await metadataTestHooks.runScanOnSave(f.project.id, f.filePath)).success, true);
        const retained = f.rows().find(row => row.fileId === output.fileId); assert.ok(retained); assert.equal(retained.psdResource.current, false);
        const currentWorkspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        assert.deepEqual(currentWorkspace.files.find(row => row.visualIdentity === metadataTestHooks.createProjectFileVisualIdentity(f.project.id, retained)).requiredBy, ['Concurrent.ai']);
      } finally { gate.release(); if (saving) await saving; restorePause?.(); f.cleanup(); }
    });
  }

  for (const mutation of ['exclude', 'scan', 'newer-review', 'unavailable-exclude', 'dormant-scan']) {
    baselineTest(`final response: ${mutation} during presentation cannot return a ready stale token`, async () => {
      const f = await correctionProject('.ai', '%PDF-1.7\n%%EOF\n');
      const outputPath = fs.mkdtempSync(path.join(TEST_HOME, 'Documents', 'response-package-'));
      const originalGet = storeInstance.get;
      storeInstance.get = function(...args) { const value = originalGet.apply(this, args); return value === undefined ? value : JSON.parse(JSON.stringify(value)); };
      const gate = deferred(); let restorePause, review;
      try {
        const assetPath = path.join(TEST_HOME, 'Desktop', 'Presentation.png'); fs.writeFileSync(assetPath, embeddedPng);
        f.current().files.push({ path: assetPath, name: 'Presentation.png', ext: '.png', source: 'user-added', projectRole: 'asset' });
        if (mutation !== 'dormant-scan') f.current().workingSourceSelections = {};
        const scan = () => metadataTestHooks.runScanOnOpen(f.project.id, f.filePath, null, null,
          { allowPausedBaseline: true, ...(mutation === 'dormant-scan' ? { establishBaseline: false } : {}) });
        assert.equal((await scan()).success, true);
        const initial = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        const source = initial.files.find(row => row.name === path.basename(f.filePath));
        if (mutation === 'unavailable-exclude') f.current().workingSourceRelationshipHolds = [{ reason: 'manual-guard', sourcePath: f.filePath }];
        let entered = false;
        restorePause = metadataTestHooks.pauseRecoveryEligibility(async () => { if (!entered) { entered = true; await gate.promise; } });
        review = callIpcRaw('projects:prepare-package-review', f.project.id, outputPath);
        await waitForCondition(() => entered, 'package review presentation did not pause');
        let newer;
        if (mutation === 'exclude' || mutation === 'unavailable-exclude') await callIpcRaw('projects:set-working-source-selection', f.project.id, source.visualIdentity, { action: 'exclude', expectedRevision: 0 });
        else if (mutation === 'scan') { fs.writeFileSync(f.filePath, '%PDF-1.7\ninvalid incomplete source'); assert.equal((await scan()).success, false); }
        else if (mutation === 'dormant-scan') assert.equal((await scan()).success, true);
        else { newer = await callIpcRaw('projects:prepare-package-review', f.project.id, outputPath); assert.equal(newer.materializable, true); }
        gate.release(); const result = await review; review = null;
        if (mutation === 'dormant-scan') {
          assert.equal(result.materializable, true, 'identical dormant attempt bookkeeping does not stale review semantics');
          restorePause(); restorePause = null;
          assert.equal((await callIpcRaw('projects:package', f.project.id, outputPath, result.token)).success, true);
          return;
        }
        assert.equal(result.error, 'package_review_changed'); assert.equal(result.token, undefined); assert.notEqual(result.materializable, true);
        restorePause(); restorePause = null;
        if (newer) assert.equal((await callIpcRaw('projects:package', f.project.id, outputPath, newer.token)).success, true, 'older refusal cannot invalidate newer token');
        else {
          const current = await callIpcRaw('projects:prepare-package-review', f.project.id, outputPath);
          if (mutation === 'exclude' || mutation === 'unavailable-exclude') assert.equal(current.semanticCounts.selectedWorkingSources, 0);
          else assert.equal(current.materializable, false);
        }
      } finally { gate.release(); if (review) await review; restorePause?.(); storeInstance.get = originalGet; clearTrackedTimers(); }
    });
  }

  for (const surface of ['ready', 'unavailable', 'workspace']) for (const mutation of ['source-bytes', 'required-file']) {
    baselineTest(`disk response: ${surface} rechecks ${mutation} after presentation`, async () => {
      const f = await correctionProject('.ai');
      const assetPath = path.join(TEST_HOME, 'Desktop', 'Required-presentation.png'); fs.writeFileSync(assetPath, embeddedPng);
      fs.writeFileSync(f.filePath, `%PDF-1.7\n${assetPath}\n%%EOF\n`); fs.utimesSync(f.filePath, 1791100800, 1791100800);
      f.current().workingSourceSelections = {};
      const originalGet = storeInstance.get;
      storeInstance.get = function(...args) { const value = originalGet.apply(this, args); return value === undefined ? value : JSON.parse(JSON.stringify(value)); };
      const gate = deferred(); let restorePause, response;
      try {
        assert.equal((await metadataTestHooks.runScanOnOpen(f.project.id, f.filePath, null, null, { allowPausedBaseline: true })).success, true);
        const initial = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        assert.equal(initial.semanticCounts.missingRequiredReferences, 0); assert.equal(initial.semanticCounts.unresolvedVerification, 0);
        if (surface === 'unavailable') f.current().workingSourceRelationshipHolds = [{ reason: 'manual-guard', sourcePath: f.filePath }];
        const storedBefore = JSON.stringify(f.current());
        let entered = false;
        restorePause = metadataTestHooks.pauseRecoveryEligibility(async () => { if (!entered) { entered = true; await gate.promise; } });
        response = callIpcRaw(surface === 'workspace' ? 'projects:get-asset-workspace' : 'projects:prepare-package-review', f.project.id);
        await waitForCondition(() => entered, 'presentation did not pause');
        if (mutation === 'source-bytes') {
          const before = fs.statSync(f.filePath);
          fs.writeFileSync(f.filePath, fs.readFileSync(f.filePath, 'utf8').replace(assetPath, ' '.repeat(assetPath.length)));
          fs.utimesSync(f.filePath, before.atimeMs / 1000, before.mtimeMs / 1000);
          const after = fs.statSync(f.filePath);
          assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
          assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino); assert.notEqual(after.ctimeMs, before.ctimeMs);
        } else fs.unlinkSync(assetPath);
        assert.equal(JSON.stringify(f.current()), storedBefore, 'only filesystem changes, no scan/store publication');
        gate.release(); const result = await response; response = null;
        if (surface === 'workspace') {
          assert.ok(result); assert.equal(result.workingSourceSelectionBlocked, true);
          if (mutation === 'source-bytes') {
            assert.equal(result.files.find(row => row.name === path.basename(f.filePath)).verificationStatus, 'stale');
            assert.ok(result.semanticCounts.unresolvedVerification > 0);
          } else assert.equal(result.semanticCounts.missingRequiredReferences, 1);
        } else {
          assert.equal(result.error, 'package_review_changed'); assert.equal(result.token, undefined); assert.notEqual(result.materializable, true);
        }
        restorePause(); restorePause = null;
        const current = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        assert.equal(current.workingSourceSelectionBlocked, true);
        assert.ok(mutation === 'source-bytes' ? current.semanticCounts.unresolvedVerification > 0 : current.semanticCounts.missingRequiredReferences === 1);
      } finally { gate.release(); if (response) await response; restorePause?.(); storeInstance.get = originalGet; clearTrackedTimers(); }
    });
  }

  baselineTest('reconciliation completion: indirect parent reference cannot retain removed PSD output', async () => {
    const f = await workingPsdFixture([{ id: psdId, name: 'Embedded.png', data: embeddedPng }], [], true);
    try {
      const output = JSON.parse(JSON.stringify(f.rows()[0]));
      const otherPath = path.join(TEST_HOME, 'Desktop', 'Indirect.ai'); fs.writeFileSync(otherPath, `%PDF-1.7\n${f.filePath}\n%%EOF\n`);
      f.current().files.push({ path: otherPath, name: 'Indirect.ai', ext: '.ai', source: 'user-added', acceptedPending: true, projectRole: 'source' });
      const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      const other = workspace.files.find(file => file.name === 'Indirect.ai');
      await callIpcRaw('projects:set-working-source-selection', f.project.id, other.visualIdentity, { action: 'exclude', expectedRevision: 0 });
      await callIpcRaw('projects:set-working-source-selection', f.project.id, other.visualIdentity, { action: 'restore', expectedRevision: 1 });
      await f.save([], [], 2);
      assert.equal(f.rows().length, 0, 'retirement evaluates obligations after disproving the former PSD edge');
      const review = await callIpcRaw('projects:prepare-package-review', f.project.id);
      assert.equal(review.materializable, true); assert.equal(review.totalFiles, 2);
      assert.equal(review.files.some(row => row.visualIdentity === metadataTestHooks.createProjectFileVisualIdentity(f.project.id, output)), false);
      assert.ok(fs.existsSync(output.path)); assert.deepEqual(fs.readFileSync(output.path), embeddedPng);
    } finally { f.cleanup(); }
  });

  baselineTest('reconciliation completion: source rewrite during retained-output hash preserves rows and guards on refusal', async () => {
    const a = { id: psdId, name: 'A.bin', data: Buffer.from('retained A') };
    const b = { id: '33333333-3333-4333-8333-333333333333', name: 'B.bin', data: Buffer.from('preserved B') };
    const f = await workingPsdFixture([a, b]);
    const originalOpen = fs.promises.open;
    try {
      const rowsBefore = JSON.parse(JSON.stringify(f.rows()));
      const kept = rowsBefore.find(row => row.psdResource.producerId === psdId);
      const removed = rowsBefore.find(row => row.psdResource.producerId === b.id);
      f.current().excludedAssetKeys.push(removed.fileId);
      const exclusions = [...f.current().excludedAssetKeys];
      const guards = [{ reason: 'psd-resource-domain-changed', sourcePath: f.filePath }];
      f.current().workingSourceRelationshipHolds = guards;
      fs.writeFileSync(f.filePath, f.write([a])); fs.utimesSync(f.filePath, 1791100800, 1791100800);
      const beforeStat = fs.statSync(f.filePath);
      let changed = false;
      fs.promises.open = async function rewriteDuringRetainedHash(filePath, ...args) {
        const handle = await originalOpen.call(fs.promises, filePath, ...args);
        if (filePath === kept.path && !changed) {
          const originalRead = handle.read.bind(handle);
          handle.read = async (...readArgs) => {
            const result = await originalRead(...readArgs);
            if (!changed) {
              changed = true;
              const bytes = fs.readFileSync(f.filePath); bytes.writeUInt32BE(2, 18);
              fs.writeFileSync(f.filePath, bytes); fs.utimesSync(f.filePath, beforeStat.atimeMs / 1000, beforeStat.mtimeMs / 1000);
              const after = fs.statSync(f.filePath);
              assert.equal(after.size, beforeStat.size); assert.equal(after.mtimeMs, beforeStat.mtimeMs);
              assert.equal(after.dev, beforeStat.dev); assert.equal(after.ino, beforeStat.ino);
            }
            return result;
          };
        }
        return handle;
      };
      const result = await metadataTestHooks.runScanOnSave(f.project.id, f.filePath);
      assert.equal(changed, true, 'source changes after parsed proof while retained bytes are read');
      assert.equal(result.success, false);
      assert.deepEqual(f.rows(), rowsBefore, 'refused current bytes cannot retire or update existing membership');
      assert.deepEqual(f.current().workingSourceRelationshipHolds, guards, 'refusal cannot clear prior guards');
      assert.deepEqual(f.current().excludedAssetKeys, exclusions);
      assert.deepEqual(fs.readFileSync(removed.path), b.data);
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).materializable, false);
    } finally { fs.promises.open = originalOpen; f.cleanup(); }
  });

  baselineTest('reconciliation completion: detached output keeps a genuine alternate transitive obligation', async () => {
    const f = await correctionProject('.ai', '%PDF-1.7\n%%EOF\n');
    try {
      const formerPath = path.join(TEST_HOME, 'Desktop', 'Former.psd'); fs.writeFileSync(formerPath, 'unused excluded source');
      const bridgePath = path.join(TEST_HOME, 'Desktop', 'Bridge.ai'); fs.writeFileSync(bridgePath, '%PDF-1.7\n%%EOF\n');
      const assetPath = path.join(TEST_HOME, 'Desktop', 'Retained.png'); fs.writeFileSync(assetPath, 'retained bytes');
      const assetId = crypto.randomUUID();
      f.current().files.push({ path: formerPath, name: 'Former.psd', ext: '.psd', source: 'user-added', projectRole: 'source' },
        { path: bridgePath, name: 'Bridge.ai', ext: '.ai', source: 'user-added', projectRole: 'source', captureEvidence: { relationshipSourcePath: f.filePath } },
        { path: assetPath, name: 'Retained.png', ext: '.png', source: 'psd-embedded', projectRole: 'asset', assetOrigin: 'existing', fileId: assetId,
          assetBaselineSourcePath: formerPath, captureEvidence: { relationshipSourcePath: bridgePath },
          psdResource: { version: 1, current: false, parentPath: formerPath } });
      f.current().excludedAssetKeys.push(assetId);
      const initial = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      for (const name of ['Former.psd', 'Bridge.ai']) {
        const row = initial.files.find(file => file.name === name);
        await callIpcRaw('projects:set-working-source-selection', f.project.id, row.visualIdentity, { action: 'exclude', expectedRevision: 0 });
      }
      const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      const retained = workspace.files.find(file => file.name === 'Retained.png');
      assert.equal(retained.includedAsDependency, true); assert.deepEqual(retained.requiredBy, [path.basename(f.filePath)]);
      assert.equal(workspace.workingSourceSelectionBlocked, false); assert.ok(f.current().excludedAssetKeys.includes(assetId));
      const root = workspace.files.find(file => file.name === path.basename(f.filePath));
      await callIpcRaw('projects:set-working-source-selection', f.project.id, root.visualIdentity, { action: 'exclude', expectedRevision: 0 });
      const excluded = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      assert.equal(excluded.files.find(file => file.name === 'Retained.png').includedAsDependency, false);
      assert.equal((await metadataTestHooks.selectProjectFilesForPackaging(f.current())).some(file => file.path === assetPath), false);
      assert.ok(f.current().excludedAssetKeys.includes(assetId)); assert.equal(fs.readFileSync(assetPath, 'utf8'), 'retained bytes');
    } finally { clearTrackedTimers(); }
  });

  baselineTest('cycle2: concrete legacy association conflict preserves rows/bytes/exclusions and gives a specific hold', async () => {
    const f = await workingPsdFixture([{ id: psdId, name: 'Embedded.png', data: embeddedPng }]);
    try {
      const current = f.rows()[0];
      const oldPath = path.join(f.privateTmp, 'old-output.png'); fs.writeFileSync(oldPath, 'old preserved bytes');
      const old = { path: oldPath, name: 'old-output.png', ext: '.png', source: 'psd-embedded', assetBaselineSourcePath: f.filePath,
        fileId: crypto.randomUUID(), projectRole: 'asset', assetOrigin: 'existing' };
      f.current().files.push(old); f.current().excludedAssetKeys.push(old.fileId);
      const exclusions = [...f.current().excludedAssetKeys];
      await f.save([], [], 2);
      assert.ok(f.current().files.some(row => row.path === old.path && row.fileId === old.fileId));
      assert.ok(f.current().files.some(row => row.path === current.path && row.fileId === current.fileId));
      assert.deepEqual(f.current().excludedAssetKeys, exclusions); assert.equal(fs.readFileSync(oldPath, 'utf8'), 'old preserved bytes');
      const review = await callIpcRaw('projects:prepare-package-review', f.project.id);
      assert.equal(review.materializable, false); assert.ok(review.semanticCounts.relationshipHolds > 0);
      assert.match(review.message, /Photoshop asset association/);
    } finally { f.cleanup(); }
  });

  for (const mode of ['ready', 'missing', 'excluded']) {
    baselineTest(`confirmed correction 6: PSD save refreshes current bytes and preserves ${mode} state`, async () => {
      const actual = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
      const f = await correctionProject('.psd', actual.writePsdBuffer({ width: 1, height: 1 }));
      currentPsdFixture = 'actual-source-buffer';
      try {
        const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        const row = workspace.files.find(file => file.name === path.basename(f.filePath));
        await callIpcRaw('projects:set-working-source-selection', f.project.id, row.visualIdentity, { action: 'exclude', expectedRevision: 0 });
        await callIpcRaw('projects:set-working-source-selection', f.project.id, row.visualIdentity, { action: 'restore', expectedRevision: 1 });
        const previous = Object.values(f.current().workingSourceVerification)[0];
        assert.equal(previous.status, 'scanned');
        if (mode === 'excluded') await callIpcRaw('projects:set-working-source-selection', f.project.id, row.visualIdentity, { action: 'exclude', expectedRevision: 2 });
        const beforeSave = JSON.stringify(f.current().workingSourceVerification);
        const link = path.join(TEST_HOME, 'Desktop', 'Missing.png');
        const linkedFiles = mode === 'missing' ? [{ id: '11111111-1111-4111-8111-111111111111', name: 'Missing.png', childDocumentID: '',
          linkedFile: { fileSize: 10, name: 'Missing.png', fullPath: link, originalPath: link, relativePath: '../Missing.png' } }] : [];
        fs.writeFileSync(f.filePath, actual.writePsdBuffer({ width: 2, height: 1, linkedFiles }));
        if (mode !== 'excluded') assert.equal((await callIpcRaw('projects:get-asset-workspace', f.project.id)).semanticCounts.unresolvedVerification, 1);
        const save = await metadataTestHooks.runScanOnSave(f.project.id, f.filePath);
        if (mode === 'excluded') {
          assert.equal(save.skipped, 'source-excluded');
          assert.equal(JSON.stringify(f.current().workingSourceVerification), beforeSave);
        } else {
          assert.equal(save.success, true);
          const current = Object.values(f.current().workingSourceVerification)[0];
          assert.equal(current.status, 'scanned'); assert.notEqual(current.attempt, previous.attempt);
          assert.equal(current.sourceFingerprint, crypto.createHash('sha256').update(fs.readFileSync(f.filePath)).digest('hex'));
          const review = await callIpcRaw('projects:prepare-package-review', f.project.id);
          assert.equal(review.materializable, mode === 'ready');
          assert.equal(review.semanticCounts.missingRequiredReferences, mode === 'missing' ? 1 : 0);
          assert.deepEqual((await callIpcRaw('projects:get-asset-workspace', f.project.id)).semanticCounts, review.semanticCounts);
        }
      } finally { currentPsdFixture = { children: [], linkedFiles: [] }; clearTrackedTimers(); }
    });
  }

  async function restoreRoute(ext, mode, container = false) {
    resetTestHomeWorkspace();
    const filePath = path.join(TEST_HOME, 'Desktop', 'Route' + ext);
    const linkPath = path.join(TEST_HOME, 'Desktop', 'Missing.png');
    const content = mode === 'missing' || mode === 'native-missing' ? linkPath : (mode === 'unsupported' ? '../Required.png' : '');
    fs.writeFileSync(filePath, ext === '.ai' || ext === '.pdf'
      ? `%PDF-1.7\n${content}\n${mode === 'failed' ? '' : '%%EOF\n'}` : `synthetic saved route bytes\n${content}\n`);
    if (ext === '.pptx') writeLinkedPresentationArchive(filePath, mode === 'missing' ? linkPath : null);
    const commands = [];
    setChildProcessHandler(({ kind, command, args }) => {
      if (mode === 'native-missing') {
        if (String(command).includes('Adobe InDesign')) return { stdout: 'synthetic running process' };
        if (isOsascriptInvocation({ kind, command, args }, 'crate-indd-query.applescript')) return { stdout:
          `DOC\t${filePath}\tRoute.indd\tfalse\ttrue\t1\nLINK\t${filePath}\tRoute.indd\t${linkPath}\tfalse\ttrue\nEND\t1\t1\t1\t0\n` };
      }
      if (command !== '/usr/bin/unzip') return { stdout: '' };
      commands.push([...args]);
      if (mode === 'failed') return { error: new Error('synthetic container failure') };
      if (args[0] === '-l') return { stdout: '     100  01-01-2026  00:00   document.json\n     100  01-01-2026  00:00   document.xml\n' };
      if (args[0] === '-p' && mode === 'empty-uri') return { stdout: '<Link LinkResourceURI=""/>' };
      if (args[0] === '-p') return { stdout: !content ? '<Document/>' :
        (args[2].endsWith('.json') ? JSON.stringify({ externalLink: content }) : `<Link LinkResourceURI="file:${content}"/>`) };
      return { stdout: '' };
    });
    const created = await createProject('Ordinary route ' + ext); clearTrackedTimers();
    const project = storeInstance.data.projects.find(p => p.id === created.id);
    project.assetBaseline = { schemaVersion: 1, status: 'legacy-included', decision: 'include', establishedAt: Date.now() };
    project.files.push({ path: filePath, name: 'Route' + ext, ext, source: 'user-added', acceptedPending: true,
      projectRole: 'source', addedAt: Date.now() });
    if (mode === 'empty-uri') {
      const legacyScan = await metadataTestHooks.runScanOnOpen(project.id, filePath);
      assert.equal(legacyScan.success, true, 'unresolved declarations do not reject ordinary legacy admission');
      assert.equal(Object.keys(project.workingSourceSelections || {}).length, 0);
      assert.equal((await getProject(project.id)).files.some(file => file.path === filePath), true);
      assert.equal((await callIpcRaw('projects:prepare-package-review', project.id)).materializable, true,
        'dormant legacy readiness remains unchanged before explicit selection intent');
    }
    const initial = await callIpcRaw('projects:get-asset-workspace', project.id);
    const row = initial.files.find(file => file.name === 'Route' + ext);
    await callIpcRaw('projects:set-working-source-selection', project.id, row.visualIdentity, { action: 'exclude', expectedRevision: 0 });
    const result = await callIpcRaw('projects:set-working-source-selection', project.id, row.visualIdentity,
      { action: 'restore', expectedRevision: 1 });
    const current = storeInstance.data.projects.find(p => p.id === project.id);
    const verification = Object.values(current.workingSourceVerification)[0];
    assert.equal(result.success, true);
    assert.equal(verification.status, mode === 'failed' ? 'failed' : 'scanned');
    assert.equal(verification.inventoryStatus, 'unverified');
    if (container) assert.ok(commands.some(args => args[0] === '-tqq'), 'ordinary container admission was exercised');
    if (mode === 'missing' || mode === 'native-missing') {
      assert.equal(verification.requiredReferences[0].path, linkPath);
      assert.equal(result.semanticCounts.missingRequiredReferences, 1);
    }
    if (mode === 'native-missing') {
      assert.equal(result.semanticCounts.unresolvedVerification, 1);
      assert.ok(verification.unresolved.some(item => item.reason === 'indesign-live-current-bytes-unbound'));
    }
    if (mode === 'unsupported' || mode === 'empty-uri') {
      assert.equal(result.semanticCounts.unresolvedVerification, 1);
      assert.ok(verification.unresolved.some(item => item.reason === 'unsupported-declared-link-uri'));
    }
    if (mode === 'failed') assert.equal(result.semanticCounts.unresolvedVerification, 1);
    if (mode === 'zero') {
      assert.equal(result.semanticCounts.unresolvedVerification, 0);
      if (ext === '.idml') {
        const review = await callIpcRaw('projects:prepare-package-review', project.id);
        assert.equal(review.materializable, true, 'a genuine zero-link document retains readiness');
        assert.equal(typeof review.token, 'string');
      }
    }
    if (mode === 'empty-uri') {
      assert.equal(verification.requiredReferences.length, 0, 'an empty declaration cannot admit a path');
      const assertBlocked = async () => {
        const workspace = await callIpcRaw('projects:get-asset-workspace', project.id);
        const restored = workspace.files.find(file => file.name === 'Route.idml');
        assert.equal(restored.sourceSelection, 'selected');
        assert.equal(restored.selectionRevision, 2, 'Restore intent remains durable');
        assert.equal(workspace.semanticCounts.unresolvedVerification, 1);
        const review = await callIpcRaw('projects:prepare-package-review', project.id);
        assert.equal(review.materializable, false, 'the declared unresolved link blocks engaged readiness');
        assert.equal(review.token, undefined);
        assert.deepEqual(workspace.semanticCounts, review.semanticCounts);
      };
      await assertBlocked();
      storeInstance.data.projects = JSON.parse(JSON.stringify(storeInstance.data.projects));
      await assertBlocked();
    }
    clearTrackedTimers();
  }

  for (const ext of ['.ai', '.pdf', '.xd', '.ppt', '.fig', '.indd']) {
    for (const mode of ext === '.ai' || ext === '.pdf' ? ['zero', 'missing', 'failed'] : ['zero', 'missing']) {
      baselineTest(`ordinary regex Restore ${ext} ${mode} main route`, () => restoreRoute(ext, mode));
    }
  }
  for (const ext of ['.idml', '.sketch', '.afdesign', '.afphoto', '.afpub', '.pxd', '.pptx', '.key']) {
    for (const mode of ['zero', 'missing', 'failed']) {
      baselineTest(`ordinary container Restore ${ext} ${mode} main route with modeled unzip`, () => restoreRoute(ext, mode, true));
    }
  }
  baselineTest('InDesign live declared missing link survives existence filtering and holds unbound saved bytes',
    () => restoreRoute('.indd', 'native-missing'));
  baselineTest('IDML unsupported declared URI blocks without a complete-empty verdict', () => restoreRoute('.idml', 'unsupported', true));
  baselineTest('C1 correction: IDML empty declared URI stays unresolved through Restore and reload',
    () => restoreRoute('.idml', 'empty-uri', true));
  baselineTest('Opus correction: legacy hold follows concrete physical and logical reads across Exclude Restore reload', async () => {
    const object = { id: psdId, name: 'Legacy.png', data: embeddedPng };
    const f = await workingPsdFixture([object], [], false, false, false);
    try {
      currentPsdFixture = () => f.actual.readPsd(fs.readFileSync(f.filePath), { skipLayerImageData: true, skipCompositeImageData: true });
      await metadataTestHooks.runScanOnSave(f.project.id, f.filePath);
      const logical = f.current().files.find(row => row.source === 'scan-on-save-embedded'); assert.ok(logical);
      // Admitted directly by the save scan: no flag, marker, Include or owner
      // acceptance record on its node, so the decided rule withholds it.
      assertNoOwnerIntent(f.current(), logical);
      const safe = path.join(TEST_HOME, 'Desktop', 'Safe.txt'); fs.writeFileSync(safe, 'independent asset');
      f.current().files.push({ path: safe, name: 'Safe.txt', ext: '.txt', source: 'user-added', acceptedPending: true, projectRole: 'asset' });
      const q = path.join(TEST_HOME, 'Desktop', 'Unrelated.ai'); fs.writeFileSync(q, '%PDF-1.7\n%%EOF\n');
      f.current().files.push({ path: q, name: 'Unrelated.ai', ext: '.ai', source: 'user-added', acceptedPending: true, projectRole: 'source' });
      let ws = await callIpcRaw('projects:get-asset-workspace', f.project.id); const unrelated = ws.files.find(row => row.name === 'Unrelated.ai');
      await callIpcRaw('projects:set-working-source-selection', f.project.id, unrelated.visualIdentity, { action: 'exclude', expectedRevision: 0 });
      currentPsdFixture = 'actual-source-buffer'; await f.save([object]);
      const holds = JSON.parse(JSON.stringify(f.current().workingSourceRelationshipHolds)); assert.equal(holds.length, 1);
      await callIpcRaw('projects:set-working-source-selection', f.project.id, f.source.visualIdentity, { action: 'exclude', expectedRevision: 0 });
      ws = await callIpcRaw('projects:get-asset-workspace', f.project.id); assert.equal(ws.semanticCounts.relationshipHolds, 0, 'logical asset withheld with its excluded parent leaves the hold dormant');
      // Owner Include keeps the logical asset; it then reads the excluded parent.
      await callIpcRaw('projects:remove-file', f.project.id, metadataTestHooks.createProjectFileVisualIdentity(f.project.id, logical));
      ws = await callIpcRaw('projects:get-asset-workspace', f.project.id); assert.equal(ws.semanticCounts.relationshipHolds, 1, 'included logical asset still reads parent');
      await callIpcRaw('projects:remove-file', f.project.id, metadataTestHooks.createProjectFileVisualIdentity(f.project.id, logical));
      ws = await callIpcRaw('projects:get-asset-workspace', f.project.id); assert.equal(ws.semanticCounts.relationshipHolds, 0);
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).materializable, true);
      assert.deepEqual(f.current().workingSourceRelationshipHolds, holds); assert.ok(f.current().files.some(row => row.fileId === logical.fileId));
      storeInstance.data.projects = JSON.parse(JSON.stringify(storeInstance.data.projects));
      assert.equal((await callIpcRaw('projects:get-asset-workspace', f.project.id)).semanticCounts.relationshipHolds, 0);
      await callIpcRaw('projects:set-working-source-selection', f.project.id, f.source.visualIdentity, { action: 'restore', expectedRevision: 1 });
      assert.equal((await callIpcRaw('projects:get-asset-workspace', f.project.id)).semanticCounts.relationshipHolds, 0, 'excluded legacy row does not hold the restored current physical root');
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).materializable, true);
      assert.deepEqual(f.current().workingSourceRelationshipHolds, holds);
      await callIpcRaw('projects:remove-file', f.project.id, metadataTestHooks.createProjectFileVisualIdentity(f.project.id, logical));
      assert.equal((await callIpcRaw('projects:get-asset-workspace', f.project.id)).semanticCounts.relationshipHolds, 1, 'including legacy row restores its concrete parent-read hold');
      await callIpcRaw('projects:set-working-source-selection', f.project.id, f.source.visualIdentity, { action: 'exclude', expectedRevision: 2 });
      const consumer = path.join(TEST_HOME, 'Desktop', 'Consumer.ai'); fs.writeFileSync(consumer, `%PDF-1.7\n${f.filePath}\n%%EOF\n`);
      f.current().files.push({ path: consumer, name: 'Consumer.ai', ext: '.ai', source: 'user-added', acceptedPending: true, projectRole: 'source' });
      assert.equal((await metadataTestHooks.runScanOnOpen(f.project.id, consumer, null, null, { establishBaseline: false, allowPausedBaseline: true })).success, true);
      assert.equal((await callIpcRaw('projects:get-asset-workspace', f.project.id)).semanticCounts.relationshipHolds, 1, 'included legacy association still reads the required parent');
      await callIpcRaw('projects:remove-file', f.project.id, metadataTestHooks.createProjectFileVisualIdentity(f.project.id, logical));
      ws = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      assert.equal(ws.semanticCounts.relationshipHolds, 0);
      assert.ok(ws.files.find(row => row.name === 'Correction.psd').includedAsDependency, 'required physical parent remains included independently of dormant legacy hold');
      assert.deepEqual(f.current().workingSourceRelationshipHolds, holds);
      const consumerRow = f.current().files.find(row => row.path === consumer);
      await callIpcRaw('projects:set-working-source-selection', f.project.id, metadataTestHooks.createProjectFileVisualIdentity(f.project.id, consumerRow), { action: 'exclude', expectedRevision: 0 });
      for (const hold of [null, { reason: 'unknown-hold', sourcePath: f.filePath }, { reason: holds[0].reason, sourcePath: 'relative.psd' }, { ...holds[0], unknownAssociation: true }]) {
        f.current().workingSourceRelationshipHolds = [hold];
        assert.equal((await callIpcRaw('projects:get-asset-workspace', f.project.id)).semanticCounts.relationshipHolds, 1);
      }
      f.current().workingSourceRelationshipHolds = { reason: 'malformed-container' };
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).materializable, false);
      assert.deepEqual(fs.readFileSync(f.filePath), f.write([object]));
    } finally { f.cleanup(); }
  });

  // ag-psd writes only8bit. Build valid16/32 RGB1x1 controls by retaining its
  // metadata sections and replacing the header/composite raw samples together.
  // These are synthetic format fixtures, not Photoshop producer acceptance.
  function higherDepthPsd(actual, depth, linkedFiles = [], alternate = false, layerResources = false) {
    let bytes = actual.writePsdBuffer({ width: 1, height: 1, channels: 3, bitsPerChannel: 8, colorMode: 3, linkedFiles: layerResources ? [] : linkedFiles,
      children: layerResources ? [{ name: 'Alternate resources', linkedFiles }] : [] });
    let offset = 26;
    for (let i = 0; i < 2; i++) offset += 4 + bytes.readUInt32BE(offset);
    const maskLengthOffset = offset; offset += 4 + bytes.readUInt32BE(offset);
    bytes = Buffer.concat([bytes.subarray(0, offset), Buffer.alloc(2 + 3 * (depth / 8))]); bytes.writeUInt16BE(depth, 22);
    if (alternate) {
      const primaryLength = bytes.readUInt32BE(maskLengthOffset + 4);
      const layerData = layerResources ? bytes.subarray(maskLengthOffset + 8, maskLengthOffset + 8 + primaryLength) : Buffer.alloc(2);
      const block = Buffer.alloc(16 + layerData.length); block.write('8B64Lr' + depth); block.writeUInt32BE(layerData.length, 12); layerData.copy(block, 16);
      const maskData = layerResources ? Buffer.concat([Buffer.alloc(4), bytes.subarray(maskLengthOffset + 8 + primaryLength, offset), block])
        : Buffer.concat([bytes.subarray(maskLengthOffset + 4, offset), block]);
      const maskLength = Buffer.alloc(4); maskLength.writeUInt32BE(maskData.length);
      bytes = Buffer.concat([bytes.subarray(0, maskLengthOffset), maskLength, maskData, bytes.subarray(offset)]);
    }
    return bytes;
  }
  for (const depth of [16, 32]) for (const mode of ['empty', 'resources', 'alternate-resources']) for (const role of ['root', 'required']) {
    baselineTest(`Opus correction: valid synthetic PSD${depth} ${mode} ${role} keeps current declared obligations`, async () => {
      const actual = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
      resetTestHomeWorkspace(); const linked = path.join(TEST_HOME, 'Desktop', 'Depth-linked.png'); fs.writeFileSync(linked, 'linked bytes');
      const resources = mode !== 'empty' ? [{ id: psdId, name: 'Embedded.png', data: embeddedPng },
        { id: '33333333-3333-4333-8333-333333333333', name: 'Depth-linked.png', childDocumentID: '',
          linkedFile: { fileSize: 12, name: 'Depth-linked.png', fullPath: linked, originalPath: linked, relativePath: '../Depth-linked.png' } }] : [];
      const f = await correctionProject('.psd', higherDepthPsd(actual, depth, resources, true, mode === 'alternate-resources'));
      fs.writeFileSync(linked, 'linked bytes'); currentPsdFixture = 'actual-source-buffer';
      try {
        const parsed = actual.readPsd(fs.readFileSync(f.filePath), { skipLayerImageData: true, skipCompositeImageData: true }); assert.equal(parsed.bitsPerChannel, depth);
        const ws = await callIpcRaw('projects:get-asset-workspace', f.project.id); const source = ws.files.find(x => x.name === 'Correction.psd');
        await callIpcRaw('projects:set-working-source-selection', f.project.id, source.visualIdentity, { action: 'exclude', expectedRevision: 0 });
        const restored = await callIpcRaw('projects:set-working-source-selection', f.project.id, source.visualIdentity, { action: 'restore', expectedRevision: 1 });
        assert.equal(restored.verificationStatus, 'scanned'); const key = metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.current(), f.current().files.find(x => x.path === f.filePath));
        const record = f.current().workingSourceVerification[key]; assert.deepEqual(record.unresolved, []); assert.equal(record.inventoryStatus, 'unverified');
        assert.ok(record.notes.includes('alternate-layer-carrier-domain-unverified'));
        if (mode !== 'empty') { assert.ok(record.requiredReferences.some(x => x.path === linked)); assert.equal(record.requiredEmbeddedOutputs.length, 1); }
        if (role === 'required') {
          const consumer = path.join(TEST_HOME, 'Desktop', 'Depth-consumer.ai'); fs.writeFileSync(consumer, `%PDF-1.7\n${f.filePath}\n%%EOF\n`);
          f.current().files.push({ path: consumer, name: 'Depth-consumer.ai', ext: '.ai', source: 'user-added', acceptedPending: true, projectRole: 'source' });
          assert.equal((await metadataTestHooks.runScanOnOpen(f.project.id, consumer, null, null, { establishBaseline: false, allowPausedBaseline: true })).success, true);
          await callIpcRaw('projects:set-working-source-selection', f.project.id, source.visualIdentity, { action: 'exclude', expectedRevision: 2 });
          const current = await callIpcRaw('projects:get-asset-workspace', f.project.id); const parent = current.files.find(x => x.visualIdentity === source.visualIdentity);
          assert.equal(parent.includedAsDependency, true); assert.equal(parent.included, true); assert.equal(parent.verificationStatus, 'scanned');
        }
        assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).materializable, true);
      } finally { currentPsdFixture = { children: [], linkedFiles: [] }; clearTrackedTimers(); }
    });
  }
  for (const fault of ['id', 'tail', 'malformed-record', 'pathless', 'notes-not-array', 'notes-unknown', 'notes-cap', 'old-version']) {
    baselineTest(`Opus correction: partial framing coverage preserves concrete ${fault} refusal`, async () => {
      const object = { id: psdId, name: 'Control.png', data: embeddedPng };
      const actual = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
      const f = await correctionProject('.psd', higherDepthPsd(actual, 16, fault === 'pathless' ?
        [{ id: psdId, name: 'Pathless.png', childDocumentID: '', linkedFile: { fileSize: 10, name: 'Pathless.png', fullPath: '', originalPath: 'file:///raw/Pathless.png', relativePath: '../Pathless.png' } }] : [object]));
      const worker = require('../parsers/add-files-psd-worker'); const inspect = worker.inspectPsdLinkFraming;
      worker.inspectPsdLinkFraming = bytes => {
        const facts = inspect(bytes); facts.status = 'incomplete'; facts.notes = ['alternate-layer-carrier-domain-unverified'];
        if (fault === 'id') facts.records[0].id = 'unmatched-wire-id';
        if (fault === 'tail') { facts.records[0].tailBytes = 4; facts.issues.push('unexplained-link-tail'); }
        if (fault === 'malformed-record') facts.issues.push('unsupported-or-malformed-framing');
        if (fault === 'notes-not-array') facts.notes = {};
        if (fault === 'notes-unknown') facts.notes = ['erase-record-obligations'];
        if (fault === 'notes-cap') facts.notes = Array(129).fill('alternate-layer-carrier-domain-unverified');
        if (fault === 'old-version') facts.version = 2;
        return facts;
      };
      currentPsdFixture = 'actual-source-buffer';
      try {
        const ws = await callIpcRaw('projects:get-asset-workspace', f.project.id); const source = ws.files.find(x => x.name === 'Correction.psd');
        await callIpcRaw('projects:set-working-source-selection', f.project.id, source.visualIdentity, { action: 'exclude', expectedRevision: 0 });
        const restored = await callIpcRaw('projects:set-working-source-selection', f.project.id, source.visualIdentity, { action: 'restore', expectedRevision: 1 });
        assert.ok(restored.semanticCounts.unresolvedVerification > 0);
        const record = Object.values(f.current().workingSourceVerification)[0];
        if (fault === 'id') assert.ok(record.unresolved.some(x => x.reason === 'wire-parsed-record-disagreement'));
        if (fault === 'tail') assert.ok(record.unresolved.some(x => x.reason === 'unexplained-link-tail'));
        if (fault === 'malformed-record') assert.ok(record.unresolved.some(x => x.reason === 'unsupported-or-malformed-framing'));
        if (fault === 'pathless') assert.ok(record.unresolved.some(x => ['unresolved-declared-reference', 'unresolved-linked-record', 'unresolved-external'].includes(x.reason)), JSON.stringify(record.unresolved));
        if (fault.startsWith('notes-') || fault === 'old-version') { assert.equal(record.status, 'failed'); assert.equal(f.current().files.some(x => x.source === 'psd-embedded'), false); }
        assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).materializable, false);
      } finally { worker.inspectPsdLinkFraming = inspect; currentPsdFixture = { children: [], linkedFiles: [] }; clearTrackedTimers(); }
    });
  }
  baselineTest('Opus correction: changed source cannot inherit worker output receipts and fresh worker replaces concrete stale reason', async () => {
    const object = { id: psdId, name: 'Receipt.png', data: embeddedPng }; const f = await workingPsdFixture([object], [], true, false, false);
    try {
      const source = f.current().files.find(x => x.path === f.filePath); const key = metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.current(), source);
      const before = JSON.parse(JSON.stringify(f.current().workingSourceVerification[key])); assert.ok(before.requiredEmbeddedOutputs.length);
      const oldPaths = f.rows().map(x => x.path); fs.writeFileSync(f.filePath, f.write([object], [], 2));
      currentPsdFixture = () => f.actual.readPsd(fs.readFileSync(f.filePath), { skipLayerImageData: true, skipCompositeImageData: true });
      metadataTestHooks.clearPsdParseDebounce(f.filePath);
      assert.equal((await metadataTestHooks.runScanOnOpen(f.project.id, f.filePath, null, null, { establishBaseline: false })).success, true);
      const record = f.current().workingSourceVerification[key]; assert.notEqual(record.sourceFingerprint, before.sourceFingerprint);
      assert.equal(record.status, 'incomplete'); assert.equal(record.reason, 'embedded-output-receipt-stale'); assert.deepEqual(record.requiredEmbeddedOutputs, []);
      assert.ok(record.unresolved.some(x => x.reason === 'embedded-output-receipt-stale')); assert.ok(metadataTestHooks.getWorkingSourceVerification(f.current(), source));
      assert.ok(oldPaths.every(p => fs.existsSync(p))); storeInstance.data.projects = JSON.parse(JSON.stringify(storeInstance.data.projects));
      currentPsdFixture = 'actual-source-buffer';
      await callIpcRaw('projects:set-working-source-selection', f.project.id, f.source.visualIdentity, { action: 'exclude', expectedRevision: 0 });
      await callIpcRaw('projects:set-working-source-selection', f.project.id, f.source.visualIdentity, { action: 'restore', expectedRevision: 1 });
      const fresh = f.current().workingSourceVerification[key]; assert.equal(fresh.status, 'scanned'); assert.ok(fresh.requiredEmbeddedOutputs.length);
      assert.ok(fresh.requiredEmbeddedOutputs.every(x => x.sourceDigest === fresh.sourceFingerprint));
      assert.equal(fresh.unresolved.some(x => x.reason === 'embedded-output-receipt-stale'), false);
    } finally { f.cleanup(); }
  });
  baselineTest('Opus correction: no-state reload last-source exclusion does not establish a baseline', async () => {
    const f = await correctionProject('.ai', '%PDF-1.7\n%%EOF\n');
    try {
      f.current().assetBaseline = { schemaVersion: 1, status: 'awaiting-first-scan', decision: null, establishedAt: null };
      const pending = { ...f.current().files[0], path: path.join(TEST_HOME, 'Desktop', 'Pending.ai'), name: 'Pending.ai', fileId: 'pending-control', acceptedPending: false, captureState: 'needs-save' };
      f.current().pendingFiles.push(pending); storeInstance.data.projects = JSON.parse(JSON.stringify(storeInstance.data.projects)); metadataTestHooks.clearAssetBaselineScans();
      const identity = metadataTestHooks.createProjectFileVisualIdentity(f.project.id, f.current().files.find(x => x.path === f.filePath));
      await callIpcRaw('projects:set-working-source-selection', f.project.id, identity, { action: 'exclude', expectedRevision: 0 });
      assert.equal(f.current().assetBaseline.status, 'awaiting-first-scan'); assert.equal(f.current().assetBaseline.establishedAt, null);
      assert.equal(f.current().files.some(x => x.path === pending.path), false);
      assert.equal(f.current().pendingFiles.find(x => x.fileId === pending.fileId).captureState, 'needs-save');
      storeInstance.data.projects = JSON.parse(JSON.stringify(storeInstance.data.projects)); metadataTestHooks.clearAssetBaselineScans();
      assert.equal(f.current().assetBaseline.status, 'awaiting-first-scan');
    } finally { clearTrackedTimers(); }
  });
  baselineTest('Opus correction: missing or retired operation refuses without throwing or publishing', async () => {
    assert.equal(metadataTestHooks.captureProjectOperation('missing-project'), null);
    assert.deepEqual(await metadataTestHooks.runScanOnOpen('missing-project', '/synthetic/missing.ai'), { success: false, error: 'stale_project_operation' });
    const f = await correctionProject('.ai', '%PDF-1.7\n%%EOF\n');
    try { const operation = metadataTestHooks.captureProjectOperation(f.project.id); operation.close();
      const before = JSON.stringify(f.current());
      assert.deepEqual(await metadataTestHooks.runScanOnOpen(f.project.id, f.filePath, null, operation), { success: false, error: 'stale_project_operation' });
      assert.equal(JSON.stringify(f.current()), before);
    } finally { clearTrackedTimers(); }
  });

  for (const depth of [16, 32]) {
    baselineTest(`Opus correction: actual parser tolerates malformed PSD${depth} alternate record but framing keeps concrete refusal`, async () => {
      const actual = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
      const bytes = higherDepthPsd(actual, depth, [], true); const alternate = bytes.indexOf('8B64Lr' + depth); assert.ok(alternate > 0);
      bytes.writeInt16BE(1, alternate + 16); // declares a layer record but supplies none
      assert.doesNotThrow(() => actual.readPsd(bytes, { skipLayerImageData: true, skipCompositeImageData: true }));
      const facts = require('../parsers/add-files-psd-worker').inspectPsdLinkFraming(bytes);
      assert.ok(facts.notes.includes('alternate-layer-carrier-domain-unverified')); assert.ok(facts.issues.includes('unsupported-or-malformed-framing'));
      const f = await correctionProject('.psd', bytes); currentPsdFixture = 'actual-source-buffer';
      try {
        const ws = await callIpcRaw('projects:get-asset-workspace', f.project.id); const source = ws.files.find(x => x.name === 'Correction.psd');
        await callIpcRaw('projects:set-working-source-selection', f.project.id, source.visualIdentity, { action: 'exclude', expectedRevision: 0 });
        const restored = await callIpcRaw('projects:set-working-source-selection', f.project.id, source.visualIdentity, { action: 'restore', expectedRevision: 1 });
        assert.ok(restored.semanticCounts.unresolvedVerification > 0);
        assert.ok(Object.values(f.current().workingSourceVerification)[0].unresolved.some(x => x.reason === 'unsupported-or-malformed-framing'));
        assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).materializable, false);
      } finally { currentPsdFixture = { children: [], linkedFiles: [] }; clearTrackedTimers(); }
    });
  }
  baselineTest('Opus correction: observed media disagreement remains blocking beside partial coverage note', async () => {
    const actual = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
    const zero = { numerator: 0, denominator: 1 }, second = { numerator: 1, denominator: 1 };
    const bytes = actual.writePsdBuffer({ width: 1, height: 1, imageResources: { timelineInformation: {
      enabled: true, frameStep: second, frameRate: 24, time: zero, duration: second, workInTime: zero, workOutTime: second,
      repeats: 0, hasMotion: true, globalTracks: [], audioClipGroups: [{ id: 'group', muted: false, audioClips: [{
        id: 'clip', start: zero, duration: second, inTime: zero, outTime: second, muted: false, audioLevel: 0,
        frameReader: { type: 1, mediaDescriptor: '', link: { name: 'Audio.wav', fullPath: '/Users/synthetic/Audio.wav', relativePath: '../Audio.wav' } },
      }] }],
    } } });
    const f = await correctionProject('.psd', bytes); const worker = require('../parsers/add-files-psd-worker'); const inspect = worker.inspectPsdLinkFraming;
    worker.inspectPsdLinkFraming = data => { const facts = inspect(data); facts.status = 'incomplete'; facts.notes = ['alternate-layer-carrier-domain-unverified'];
      facts.mediaCarriers[0].references[0].frameReader['Lnk '].fullPath = '/Users/synthetic/Different.wav'; return facts; };
    currentPsdFixture = 'actual-source-buffer';
    try {
      const ws = await callIpcRaw('projects:get-asset-workspace', f.project.id); const source = ws.files.find(x => x.name === 'Correction.psd');
      await callIpcRaw('projects:set-working-source-selection', f.project.id, source.visualIdentity, { action: 'exclude', expectedRevision: 0 });
      await callIpcRaw('projects:set-working-source-selection', f.project.id, source.visualIdentity, { action: 'restore', expectedRevision: 1 });
      const record = Object.values(f.current().workingSourceVerification)[0]; assert.ok(record.unresolved.some(x => x.reason === 'wire-parsed-media-disagreement'));
      assert.ok(record.requiredReferences.some(x => x.path === '/Users/synthetic/Audio.wav')); assert.ok(record.requiredReferences.some(x => x.path === '/Users/synthetic/Different.wav'));
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).materializable, false);
    } finally { worker.inspectPsdLinkFraming = inspect; currentPsdFixture = { children: [], linkedFiles: [] }; clearTrackedTimers(); }
  });

  for (const fault of ['type', 'version', 'tail', 'incomplete-tail', 'media-version', 'media-tail', 'media-incomplete-tail']) {
    baselineTest(`Receiver correction: incomplete coverage cannot suppress received ${fault} without redundant issue`, async () => {
      const actual = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
      const f = await correctionProject('.psd', higherDepthPsd(actual, 16, [{ id: psdId, name: 'Receiver.png', data: embeddedPng }]));
      const worker = require('../parsers/add-files-psd-worker'), inspect = worker.inspectPsdLinkFraming;
      worker.inspectPsdLinkFraming = bytes => {
        const facts = inspect(bytes); facts.status = 'incomplete'; facts.notes = ['alternate-layer-carrier-domain-unverified']; facts.issues = [];
        if (fault === 'type') facts.records[0].type = 'liZZ';
        if (fault === 'version') facts.records[0].version = 8;
        if (fault === 'tail') facts.records[0].tailBytes = 4;
        if (fault === 'incomplete-tail') facts.records[0].tailBytes = null;
        if (fault.startsWith('media-')) facts.mediaCarriers = [{ carrier: '1075', carrierIndex: 1, layerIndex: null, layerId: null,
          status: 'decoded', version: fault === 'media-version' ? 2 : 1, pixelSourceType: null,
          tailBytes: fault === 'media-tail' ? 4 : fault === 'media-incomplete-tail' ? null : 0, references: [] }];
        return facts;
      };
      currentPsdFixture = 'actual-source-buffer';
      try {
        const ws = await callIpcRaw('projects:get-asset-workspace', f.project.id), source = ws.files.find(x => x.name === 'Correction.psd');
        await callIpcRaw('projects:set-working-source-selection', f.project.id, source.visualIdentity, { action: 'exclude', expectedRevision: 0 });
        const restored = await callIpcRaw('projects:set-working-source-selection', f.project.id, source.visualIdentity, { action: 'restore', expectedRevision: 1 });
        const record = Object.values(f.current().workingSourceVerification)[0]; assert.equal(record.status, 'scanned');
        const reason = { type: 'unsupported-link-form', version: 'unsupported-link-form', tail: 'unexplained-link-tail',
          'incomplete-tail': 'unresolved-link-record-framing', 'media-version': 'unsupported-media-descriptor-version',
          'media-tail': 'unexplained-media-tail', 'media-incomplete-tail': 'unresolved-media-descriptor-framing' }[fault];
        assert.ok(record.unresolved.some(item => item.reason === reason)); assert.ok(restored.semanticCounts.unresolvedVerification > 0);
        assert.equal((await callIpcRaw('projects:get-asset-workspace', f.project.id)).workingSourceSelectionBlocked, true);
        const review = await callIpcRaw('projects:prepare-package-review', f.project.id); assert.equal(review.materializable, false); assert.equal(review.token, undefined);
      } finally { worker.inspectPsdLinkFraming = inspect; currentPsdFixture = { children: [], linkedFiles: [] }; clearTrackedTimers(); }
    });
  }

  function videoBytes({ fullPath = '/Users/synthetic/missing.mov', pixelType = 1986285651,
    readerType = 1364477522, readerVersion = 1, descriptorVersion = 1, tail = 0 } = {}) {
    const agPsd = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
    const w = originalLoad.call(Module, 'ag-psd/dist/psdWriter', module);
    const writer = w.createWriter();
    const id = value => {
      w.writeUint32(writer, value.length === 4 ? 0 : value.length);
      w.writeAsciiString(writer, value);
    };
    // Explicit test-only Action Descriptor types avoid ag-psd's disabled PxSc
    // writer's unrelated key-type inference. No production encoder is added.
    function typedDescriptor(classId, fields) {
      w.writeUnicodeStringWithPadding(writer, ''); id(classId); w.writeUint32(writer, fields.length);
      for (const [key, type, value] of fields) {
        id(key); w.writeSignature(writer, type);
        if (type === 'Objc') typedDescriptor(value[0], value[1]);
        else if (type === 'long') w.writeInt32(writer, value);
        else if (type === 'doub') w.writeFloat64(writer, value);
        else if (type === 'TEXT') w.writeUnicodeString(writer, value);
        else if (type === 'bool') w.writeUint8(writer, value ? 1 : 0);
        else if (type === 'enum') { id(value[0]); id(value[1]); }
        else if (type === 'tdta') { w.writeInt32(writer, value.length); w.writeBytes(writer, value); }
        else if (type === 'alis') { w.writeInt32(writer, value.length); w.writeAsciiString(writer, value); }
        else throw new Error('unsupported synthetic fixture type');
      }
    }
    w.writeUint32(writer, 16);
    typedDescriptor('PixelSource', [
      ['pixelSourceType', 'long', pixelType], ['descVersion', 'long', descriptorVersion],
      ['origin', 'Objc', ['null', [['Hrzn', 'doub', 0], ['Vrtc', 'doub', 0]]]],
      ['interpretation', 'Objc', ['footageInterpretation', [
        ['Vrsn', 'long', 1], ['interpretAlpha', 'enum', ['alphaInterpretation', 'straight']], ['profile', 'tdta', new Uint8Array()],
      ]]],
      ['frameReader', 'Objc', ['FrameReader', [
        ['frameReaderType', 'long', readerType], ['descVersion', 'long', readerVersion],
        ['Lnk ', 'Objc', ['ExternalFileLink', [
          ['descVersion', 'long', 2], ['Nm  ', 'TEXT', 'movie.mov'], ['fullPath', 'TEXT', fullPath],
          ['originalPath', 'TEXT', 'file:///raw/original.mov'], ['relPath', 'TEXT', '../raw.mov'], ['alis', 'alis', 'raw-alias\u0000token'],
        ]]], ['mediaDescriptor', 'TEXT', ''],
      ]]], ['showAlteredVideo', 'bool', false],
    ]);
    const descriptor = Buffer.from(w.getWriterBuffer(writer));
    const payload = Buffer.concat([descriptor, Buffer.alloc(tail, 7)]);
    const block = Buffer.alloc(12 + payload.length + payload.length % 2);
    block.write('8BIM'); block.write('PxSc', 4); block.writeUInt32BE(payload.length, 8); payload.copy(block, 12);
    const original = agPsd.writePsdBuffer({ width: 1, height: 1, children: [{ id: 42, name: 'video layer' }] });
    const resourceLength = 30 + original.readUInt32BE(26);
    const maskLength = resourceLength + 4 + original.readUInt32BE(resourceLength);
    const layerLength = maskLength + 4;
    let offset = layerLength + 4 + 2 + 16;
    const channelCount = original.readUInt16BE(offset); offset += 2 + channelCount * 6 + 12;
    const extraLength = offset;
    const extraEnd = extraLength + 4 + original.readUInt32BE(extraLength);
    const bytes = Buffer.concat([original.subarray(0, extraEnd), block, original.subarray(extraEnd)]);
    for (const position of [extraLength, layerLength, maskLength]) {
      bytes.writeUInt32BE(original.readUInt32BE(position) + block.length, position);
    }
    return bytes;
  }

  for (const mode of ['timeline', 'timeline-frame-version', 'timeline-link-version', 'video-frame-version',
    'video-link-version', 'video-pixel', 'video-reader', 'video-supported', 'video-worker-refusal',
    'timeline-not-examined', 'video-not-examined']) {
    baselineTest(`Media receiver correction: actual IPC preserves ${mode} policy without redundant reason`, async () => {
      resetTestHomeWorkspace();
      const actual = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
      const target = path.join(TEST_HOME, 'Desktop', mode.startsWith('timeline') ? 'Media.wav' : 'movie.mov');
      const zero = { numerator: 0, denominator: 1 }, second = { numerator: 1, denominator: 1 };
      const bytes = mode.startsWith('timeline') ? actual.writePsdBuffer({ width: 1, height: 1, imageResources: {
        timelineInformation: { enabled: true, frameStep: second, frameRate: 24, time: zero, duration: second,
          workInTime: zero, workOutTime: second, repeats: 0, hasMotion: true, globalTracks: [],
          audioClipGroups: [{ id: 'group', muted: false, audioClips: [{ id: 'clip', start: zero, duration: second,
            inTime: zero, outTime: second, muted: false, audioLevel: 0, frameReader: { type: 1, mediaDescriptor: '',
              link: { name: 'Media.wav', fullPath: target, relativePath: '../Media.wav' } } }] }],
        },
      } }) : videoBytes({ fullPath: target });
      const f = await correctionProject('.psd', bytes); fs.writeFileSync(target, 'synthetic accepted media');
      f.current().files.push({ path: target, name: path.basename(target), ext: path.extname(target),
        source: 'user-added', acceptedPending: true, projectRole: 'asset' });
      const worker = require('../parsers/add-files-psd-worker'), inspect = worker.inspectPsdLinkFraming;
      worker.inspectPsdLinkFraming = data => {
        const facts = inspect(data); const carrier = facts.mediaCarriers[0], ref = carrier.references[0];
        assert.equal(carrier.status, 'decoded'); assert.equal(carrier.version, 1); assert.equal(carrier.tailBytes, 0);
        facts.status = 'incomplete'; facts.notes = ['alternate-layer-carrier-domain-unverified']; facts.issues = []; ref.reason = null;
        if (mode.endsWith('frame-version')) ref.frameReader.descVersion = 2;
        if (mode.endsWith('link-version')) ref.frameReader['Lnk '].descVersion = 9;
        if (mode === 'video-pixel') carrier.pixelSourceType = 1;
        if (mode === 'video-reader') ref.frameReader.frameReaderType = 1;
        if (mode === 'video-worker-refusal') ref.reason = 'unsupported-media-reference-shape';
        if (mode.endsWith('not-examined')) return { status: 'not-examined' };
        return facts;
      };
      currentPsdFixture = 'actual-source-buffer';
      try {
        const ws = await callIpcRaw('projects:get-asset-workspace', f.project.id), source = ws.files.find(x => x.name === 'Correction.psd');
        await callIpcRaw('projects:set-working-source-selection', f.project.id, source.visualIdentity, { action: 'exclude', expectedRevision: 0 });
        await callIpcRaw('projects:set-working-source-selection', f.project.id, source.visualIdentity, { action: 'restore', expectedRevision: 1 });
        const record = Object.values(f.current().workingSourceVerification)[0]; assert.equal(record.status, 'scanned');
        assert.ok(record.requiredReferences.some(x => x.path === target));
        const review = await callIpcRaw('projects:prepare-package-review', f.project.id);
        if (mode === 'video-supported') {
          assert.deepEqual(record.unresolved, []); assert.equal(review.materializable, true); assert.equal(typeof review.token, 'string');
        } else {
          const reason = mode.endsWith('not-examined') ? 'wire-coverage-not-examined' : mode === 'timeline' ? 'unverified-timeline-frame-reader-type'
            : ['video-pixel', 'video-reader'].includes(mode) ? 'unsupported-video-reader-type' : 'unsupported-media-reference-shape';
          assert.ok(record.unresolved.some(x => x.reason === reason));
          assert.equal(record.unresolved.filter(x => x.reason === reason).length, 1);
          if (mode === 'timeline-not-examined') assert.ok(record.unresolved.some(x => x.reason === 'unverified-timeline-frame-reader-type'));
          assert.equal(review.materializable, false); assert.equal(review.token, undefined);
          assert.equal((await callIpcRaw('projects:get-asset-workspace', f.project.id)).workingSourceSelectionBlocked, true);
        }
      } finally { worker.inspectPsdLinkFraming = inspect; currentPsdFixture = { children: [], linkedFiles: [] }; clearTrackedTimers(); }
    });
  }

  for (const route of ['add-files', 'accept-pending', 'figma-complete']) {
    baselineTest(`Morning bounded correction: last-root exclusion preserves awaiting baseline through ${route}`, async () => {
      const f = await correctionProject('.ai', '%PDF-1.7\nmissing EOF');
      try {
        f.current().assetBaseline = { schemaVersion: 1, status: 'awaiting-first-scan', decision: null, establishedAt: null };
        const kept = path.join(TEST_HOME, 'Desktop', 'Kept.png'); fs.writeFileSync(kept, 'kept synthetic asset');
        f.current().files.push({ path: kept, name: 'Kept.png', ext: '.png', source: 'user-added',
          acceptedPending: true, projectRole: 'asset', assetOrigin: 'existing' });
        if (route !== 'figma-complete') {
          assert.equal((await metadataTestHooks.runScanOnOpen(f.project.id, f.filePath)).success, false);
        }
        const identity = metadataTestHooks.createProjectFileVisualIdentity(f.project.id, f.current().files.find(x => x.path === f.filePath));
        assert.equal((await callIpcRaw('projects:set-working-source-selection', f.project.id, identity,
          { action: 'exclude', expectedRevision: 0 })).success, true);
        assert.equal(f.current().assetBaseline.status, 'awaiting-first-scan');
        if (route === 'add-files') {
          const added = path.join(TEST_HOME, 'Desktop', 'Added.png'); fs.writeFileSync(added, 'added synthetic asset');
          manualDialogFor([added]); await callIpcRaw('projects:add-files', f.project.id);
          assert.ok(f.current().files.some(x => x.path === added), 'ordinary asset admission must continue');
        } else if (route === 'accept-pending') {
          const root = f.current().files.find(x => x.path === f.filePath);
          f.current().files = f.current().files.filter(x => x.path !== f.filePath);
          f.current().pendingFiles.push({ ...root, acceptedPending: false, fileId: 'morning-reaccepted-root' });
          assert.ok(await callIpcRaw('projects:accept-pending', f.project.id, f.filePath));
          assert.ok(f.current().files.some(x => x.path === f.filePath));
        } else {
          const fileKey = 'morning-complete-file';
          f.current().figmaTrackedFiles = [{ key: fileKey, requestedPageId: '1:1', requestedNodeId: null }];
          f.current().figmaScopeMode = 'current-page'; f.current().figmaSession = null;
          roundTripFakeStore(); metadataTestHooks.clearAssetBaselineScans();
          const asset = makeSyntheticFigmaAsset(fileKey, 'morning-complete');
          await withSyntheticFigmaScans([makeSyntheticFigmaScan(fileKey, [asset])],
            async () => syntheticFigmaAssetResponse(true), async () => {
              await metadataTestHooks.runFigmaPoll(f.project.id, metadataTestHooks.getActiveWatchingActivationToken(f.project.id));
            });
          assert.ok(Number.isSafeInteger(f.current().figmaAssetBaselineEstablishedAt), 'complete cloud snapshot should retain its own receipt');
        }
        assert.equal(f.current().assetBaseline.status, 'awaiting-first-scan', 'no excluded local root can establish the local baseline');
        assert.equal(f.current().assetBaseline.establishedAt, null);
        const assetOnly = await callIpcRaw('projects:prepare-package-review', f.project.id);
        assert.equal(assetOnly.materializable, true, 'remaining assets keep the existing packaging policy');
        assert.equal(assetOnly.semanticCounts.selectedWorkingSources, 0);
        fs.writeFileSync(f.filePath, '%PDF-1.7\n%%EOF\n');
        const currentRoot = f.current().files.find(x => x.path === f.filePath);
        const restored = await callIpcRaw('projects:set-working-source-selection', f.project.id,
          metadataTestHooks.createProjectFileVisualIdentity(f.project.id, currentRoot), { action: 'restore', expectedRevision: 1 });
        assert.equal(restored.success, true); assert.equal(restored.verificationStatus, 'scanned');
        assert.equal(f.current().assetBaseline.status, 'decision-required', 'Restore must still establish the deferred first baseline');
        assert.ok(Number.isFinite(f.current().assetBaseline.establishedAt));
      } finally { clearTrackedTimers(); }
    });
  }

  for (const mode of ['missing', 'audio', 'zero']) {
    baselineTest(`Morning bounded correction: ordinary pre-engagement PSD ${mode} receipt needs declaration proof`, async () => {
      const actual = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
      const f = await correctionProject('.psd');
      const target = path.join(TEST_HOME, 'Desktop', 'Missing.png');
      const zero = { numerator: 0, denominator: 1 }, second = { numerator: 1, denominator: 1 };
      const linkedFiles = mode === 'missing' ? [{ id: '11111111-1111-4111-8111-111111111111', name: 'Missing.png',
        childDocumentID: '', linkedFile: { fileSize: 10, name: 'Missing.png', fullPath: target, originalPath: target, relativePath: '../Missing.png' } }] : [];
      const imageResources = mode === 'audio' ? { timelineInformation: { enabled: true, frameStep: second, frameRate: 24,
        time: zero, duration: second, workInTime: zero, workOutTime: second, repeats: 0, hasMotion: true, globalTracks: [],
        audioClipGroups: [{ id: 'group', muted: false, audioClips: [{ id: 'clip', start: zero, duration: second,
          inTime: zero, outTime: second, muted: false, audioLevel: 0, frameReader: { type: 1, mediaDescriptor: '',
            link: { name: 'Audio.wav', fullPath: path.join(TEST_HOME, 'Desktop', 'Audio.wav'), relativePath: '../Audio.wav' } } }] }],
      } } : {};
      const bytes = actual.writePsdBuffer({ width: 1, height: 1, linkedFiles, imageResources });
      fs.writeFileSync(f.filePath, bytes);
      // The legacy parser stub receives the actual parsed source; the later
      // worker uses the actual buffer and framing through the existing harness.
      currentPsdFixture = actual.readPsd(bytes, { skipLayerImageData: true, skipCompositeImageData: true });
      try {
        const sibling = path.join(TEST_HOME, 'Desktop', 'Other.ai'); fs.writeFileSync(sibling, '%PDF-1.7\n%%EOF\n');
        f.current().files.push({ path: sibling, name: 'Other.ai', ext: '.ai', source: 'user-added', acceptedPending: true, projectRole: 'source' });
        metadataTestHooks.clearPsdParseDebounce(f.filePath);
        const scan = await metadataTestHooks.runScanOnOpen(f.project.id, f.filePath, null, null, { allowPausedBaseline: true });
        assert.equal(scan.success, true, 'legacy capture stays admitted before engagement');
        const key = metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.current(), f.current().files[0]);
        const saved = JSON.parse(JSON.stringify(f.current().workingSourceVerification[key]));
        assert.equal(saved.provider, 'psd-ordinary'); assert.equal(saved.status, 'scanned');
        const legacyReview = await callIpcRaw('projects:prepare-package-review', f.project.id);
        assert.equal(legacyReview.materializable, true);
        const before = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        const other = before.files.find(x => x.name === 'Other.ai'), source = before.files.find(x => x.name === 'Correction.psd');
        await callIpcRaw('projects:set-working-source-selection', f.project.id, other.visualIdentity, { action: 'exclude', expectedRevision: 0 });
        roundTripFakeStore(); metadataTestHooks.clearAssetBaselineScans();
        assert.deepEqual(f.current().workingSourceVerification[key], saved, 'engagement does not rewrite or invent a worker receipt');
        assert.equal((await callIpcRaw('projects:package', f.project.id, TEST_HOME, legacyReview.token)).error, 'package_review_stale');
        const blocked = await callIpcRaw('projects:prepare-package-review', f.project.id);
        assert.equal(blocked.materializable, false); assert.equal(blocked.token, undefined);
        assert.ok(blocked.semanticCounts.unresolvedVerification > 0);
        const ws = await callIpcRaw('projects:get-asset-workspace', f.project.id);
        assert.equal(ws.files.find(x => x.name === 'Correction.psd').verificationStatus, 'incomplete');
        assert.deepEqual(ws.semanticCounts, blocked.semanticCounts);
        currentPsdFixture = 'actual-source-buffer';
        await callIpcRaw('projects:set-working-source-selection', f.project.id, source.visualIdentity, { action: 'exclude', expectedRevision: 0 });
        await callIpcRaw('projects:set-working-source-selection', f.project.id, source.visualIdentity, { action: 'restore', expectedRevision: 1 });
        const proof = f.current().workingSourceVerification[key]; assert.equal(proof.provider, 'psd-agpsd-worker');
        assert.equal(proof.sourceFingerprint, crypto.createHash('sha256').update(bytes).digest('hex'));
        const verified = await callIpcRaw('projects:prepare-package-review', f.project.id);
        if (mode === 'zero') {
          assert.equal(verified.materializable, true); assert.equal(verified.semanticCounts.unresolvedVerification, 0);
          assert.equal(typeof verified.token, 'string');
        } else {
          assert.equal(verified.materializable, false); assert.equal(verified.token, undefined);
          if (mode === 'missing') assert.ok(proof.requiredReferences.some(x => x.path === target));
          else assert.ok(proof.unresolved.some(x => x.reason === 'unverified-timeline-frame-reader-type'));
        }
      } finally { currentPsdFixture = { children: [], linkedFiles: [] }; clearTrackedTimers(); }
    });
  }

  baselineTest('Morning bounded correction: untouched revision-zero PSD without receipt keeps legacy readiness', async () => {
    const f = await correctionProject('.psd');
    try {
      const sibling = path.join(TEST_HOME, 'Desktop', 'Other.ai'); fs.writeFileSync(sibling, '%PDF-1.7\n%%EOF\n');
      f.current().files.push({ path: sibling, name: 'Other.ai', ext: '.ai', source: 'user-added', acceptedPending: true, projectRole: 'source' });
      const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      const other = workspace.files.find(x => x.name === 'Other.ai');
      await callIpcRaw('projects:set-working-source-selection', f.project.id, other.visualIdentity, { action: 'exclude', expectedRevision: 0 });
      const source = f.current().files.find(x => x.path === f.filePath);
      const key = metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.current(), source);
      assert.equal(f.current().workingSourceVerification[key], undefined);
      const review = await callIpcRaw('projects:prepare-package-review', f.project.id);
      assert.equal(review.materializable, true); assert.equal(review.semanticCounts.unresolvedVerification, 0);
      const ws = await callIpcRaw('projects:get-asset-workspace', f.project.id);
      assert.equal(ws.files.find(x => x.name === 'Correction.psd').selectionRevision, 0);
      assert.deepEqual(ws.semanticCounts, review.semanticCounts);
    } finally { clearTrackedTimers(); }
  });

}

// Excluded working files across every supported format: owner records on the
// routes that observe assets for a working file, Include All Existing for the
// current exclusion only, and per-asset choices across a legacy PSD restage.
// Complete main IPC/store routes on real files and written package folders;
// app scripting, ps/lsof, Electron and the utility-process transport remain
// modeled exactly as in the rest of this harness (no native-app acceptance).
function excludedSourceMembershipCases() {
  const zlib = require('zlib');
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(zlib.crc32(body) >>> 0, 8 + data.length); return out; };
  // Distinct PNGs over 500 bytes, so presentation media qualifies.
  const png = seed => { const header = Buffer.alloc(13); header.writeUInt32BE(24); header.writeUInt32BE(24, 4); header[8] = 8; header[9] = 6;
    const rows = Buffer.alloc(24 * (1 + 24 * 4)); let n = seed >>> 0; for (let y = 0; y < 24; y++) for (let x = 1; x < 97; x++) { n = (n * 1664525 + 1013904223) >>> 0; rows[y * 97 + x] = n >>> 24; }
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]); };
  // InDesign is modeled as running with `inddDoc` open; its links are read from the document bytes.
  let inddDoc = null, inddModified = false, idmlForm = 'file:', idmlExtra = [], extraMediaSeed = 0;
  const inddSnapshot = () => { if (!inddDoc || !fs.existsSync(inddDoc)) return 'END\t0\t0\t0\t0\n';
    const links = fs.readFileSync(inddDoc, 'utf8').split('\n').filter(line => line.startsWith('/'));
    const name = path.basename(inddDoc);
    return `DOC\t${inddDoc}\t${name}\t${inddModified}\ttrue\t${links.length}\n` + links.map(link => `LINK\t${inddDoc}\t${name}\t${link}\t${inddModified}\ttrue\n`).join('') +
      `END\t1\t${links.length}\t${links.length}\t0\n`; };
  const passthroughInner = ({ kind, command, args, options }) => {
    if (inddDoc && String(command).includes('Adobe InDesign')) return { stdout: '/Applications/Adobe InDesign 2026/Adobe InDesign.app/Contents/MacOS/Adobe InDesign\n' };
    if (inddDoc && kind === 'execFile' && command === '/bin/ps' && args[0] === 'axww') return { stdout: '  101 /Applications/Adobe InDesign 2026/Adobe InDesign.app/Contents/MacOS/Adobe InDesign\n', stderr: '' };
    if (inddDoc && (isOsascriptInvocation({ kind, command, args }, 'crate-indd-query.applescript') || isOsascriptInvocation({ kind, command, args }, 'crate-indd-poll.applescript'))) return { stdout: inddSnapshot() };
    if (inddDoc && isOsascriptInvocation({ kind, command, args }, 'crate-indd-scan.applescript')) return { stdout: inddSnapshot().split('\n').filter(line => line.startsWith('LINK')).map(line => line.split('\t')[3]).join('\n') };
    if (kind === 'execFile' && command === '/usr/bin/unzip') {
      const binary = args[0] === '-p' && options && options.encoding === 'buffer';
      const result = realSpawnSync(command, args, { encoding: binary ? null : 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (result.status !== 0 && args[0] !== '-l') { const error = new Error('unzip failed ' + result.status); error.stderr = String(result.stderr || ''); throw error; }
      return { stdout: result.stdout, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  const passthrough = () => setChildProcessHandler(passthroughInner);
  const zipDir = (target, entries, store = false) => {
    const stage = fs.mkdtempSync(path.join(TEST_HOME, 'Documents', 'zipstage-'));
    for (const [name, data] of Object.entries(entries)) { const file = path.join(stage, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); }
    fs.rmSync(target, { force: true });
    assert.equal(realSpawnSync('/usr/bin/zip', ['-q', '-r', ...(store ? ['-0'] : []), target, '.'], { cwd: stage }).status, 0, 'zip');
    fs.rmSync(stage, { recursive: true, force: true });
  };
  const desk = name => path.join(TEST_HOME, 'Desktop', name);
  const matchName = (actual, name) => { actual = actual || ''; return actual === name || actual.endsWith(' — ' + name) ||
    (/^(.*)_\d+(\.[a-z]+)$/.test(actual) && actual.replace(/_\d+(\.[a-z]+)$/, '$1').endsWith(name.replace(/\.[a-z]+$/, ''))); };
  const actualPsd = () => originalLoad.call(Module, 'ag-psd/dist/index.js', module);
  const RN = 'http://schemas.openxmlformats.org/package/2006/relationships', ON = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  // A working file of `ext` that references `links` and, where the format
  // embeds media, carries one embedded media object.
  function writeWorking(ext, filePath, links, embeddedSeed = 900) {
    const text = links.join('\n');
    switch (ext) {
      case '.ai': case '.pdf': fs.writeFileSync(filePath, `%PDF-1.7\n${text}\n%%EOF\n`); return null;
      case '.xd': case '.fig': case '.ppt': case '.indd': fs.writeFileSync(filePath, `SYNTH${ext}\n${text}\n`); return null;
      case '.idml': zipDir(filePath, { 'designmap.xml': '<Document>' + [...links.map(link => `<Link LinkResourceURI="${idmlForm}${link}"/>`),
        ...idmlExtra.map(uri => `<Link LinkResourceURI="${uri}"/>`)].join('') + '</Document>' }); return null;
      case '.sketch': zipDir(filePath, { 'document.json': JSON.stringify({ images: links }) }); return null;
      case '.afdesign': case '.afphoto': case '.afpub': zipDir(filePath, { 'doc.xml': '<doc>' + links.map(link => `<r p="${link}"/>`).join('') + '</doc>' }); return null;
      case '.pxd': zipDir(filePath, { 'doc.json': JSON.stringify({ links }) }); return null;
      case '.key': zipDir(filePath, { 'Index/Document.iwa': text, 'Data/embedded-photo.png': png(embeddedSeed),
        ...(extraMediaSeed ? { 'Data/second-photo.png': png(extraMediaSeed) } : {}) }, true); return 'embedded-photo.png';
      case '.pptx': {
        const rels = links.map((link, i) => `<Relationship Id="rIdL${i}" Type="${ON}/image" Target="${pathToFileURL(link).href}" TargetMode="External"/>`).join('');
        zipDir(filePath, {
          '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>',
          'ppt/slides/slide1.xml': `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${ON}"><p:spTree>${links.map((_, i) => `<a:blip r:link="rIdL${i}"/>`).join('')}<a:blip r:embed="rIdE"/></p:spTree></p:sld>`,
          'ppt/slides/_rels/slide1.xml.rels': `<Relationships xmlns="${RN}">${rels}<Relationship Id="rIdE" Type="${ON}/image" Target="../media/image1.png"/></Relationships>`,
          'ppt/media/image1.png': png(embeddedSeed),
          ...(extraMediaSeed ? { 'ppt/media/image2.png': png(extraMediaSeed) } : {}),
        });
        return 'image1.png';
      }
      case '.psd': {
        const linkObj = (i, link) => ({ id: '44444444-4444-4444-8444-44444444444' + i, name: path.basename(link), childDocumentID: '',
          linkedFile: { fileSize: 1, name: path.basename(link), fullPath: link, originalPath: '', relativePath: '' } });
        fs.writeFileSync(filePath, actualPsd().writePsdBuffer({ width: 1, height: 1, children: [],
          linkedFiles: [{ id: '33333333-3333-4333-8333-' + String(embeddedSeed).padStart(12, '0'), name: 'Embedded-Layer.png', data: png(embeddedSeed) },
            ...links.map((link, i) => linkObj(i, link))] }));
        return 'Embedded-Layer.png';
      }
      default: throw new Error('no builder ' + ext);
    }
  }
  const resolveChoices = async projectId => {
    for (let round = 0; round < 6; round++) {
      const pending = (await callIpcRaw('projects:get-asset-workspace', projectId)).workingFileChoices?.choices || [];
      if (!pending.length) return;
      for (const entry of pending) {
        assert.equal((await callIpcRaw('projects:resolve-working-file-choice', projectId,
          { id: entry.id, revision: entry.revision, choice: 'keep-both', predecessorIdentity: null })).success, true);
      }
    }
  };
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
  const normalizeCasePath = value => String(value || '').toLowerCase();
  const FORMATS = ['.ai', '.pdf', '.xd', '.fig', '.ppt', '.psd', '.indd', '.idml', '.sketch', '.afdesign', '.afphoto', '.afpub', '.pxd', '.key', '.pptx'];
  const originalTmpdir = os.tmpdir;
  async function withEnv(work, { realTmp = false, realMainPsd = false } = {}) {
    const privateTmp = fs.mkdtempSync(path.join(TEST_HOME, 'Documents', 'matrix-tmp-'));
    if (!realTmp) os.tmpdir = () => privateTmp;
    currentPsdFixture = 'actual-source-buffer';
    if (realMainPsd) globalThis.__crateRealMainPsdBytes = true;
    const originalStoreGet = storeInstance.get;
    storeInstance.get = function clonedStoreGet(...args) { const value = originalStoreGet.apply(this, args); return value === undefined ? value : JSON.parse(JSON.stringify(value)); };
    try { return await work(); } finally {
      inddDoc = null; inddModified = false; os.tmpdir = originalTmpdir; currentPsdFixture = { children: [], linkedFiles: [] }; storeInstance.get = originalStoreGet;
      delete globalThis.__crateRealMainPsdBytes; passthrough(); fs.rmSync(privateTmp, { recursive: true, force: true }); clearTrackedTimers();
    }
  }
  async function newProject(label, { scope, pause, before } = {}) {
    resetTestHomeWorkspace(); passthrough(); clearTrackedTimers();
    fs.mkdirSync(path.join(TEST_HOME, 'Desktop'), { recursive: true });
    if (before) before();
    const created = scope ? await callIpc('projects:create', label, 'branding', scope, null) : await createProject(label); clearTrackedTimers();
    if (pause) await callIpcRaw('projects:pause', created.id);
    return projectHandleFor(created.id, () => storeInstance.data.projects.find(project => project.id === created.id));
  }
  // Work-<t><ext> links Solo and Shared (and embeds E); Keep-<t>.ai links Shared and KeepSide.
  async function formatProject(ext, opts = {}) {
    const tag = ext.slice(1);
    const names = { only: `Solo-${tag}${opts.onlyExt || '.png'}`, shared: `Shared-${tag}.png`, keepOnly: `KeepSide-${tag}.png`, newLink: `Fresh-${tag}.png` };
    const W = desk('Work-' + tag + ext), K = desk('Keep-' + tag + '.ai');
    let embeddedName = null;
    const f = await newProject('Matrix ' + tag, { scope: opts.scope, before() {
      fs.writeFileSync(desk(names.only), png(11)); fs.writeFileSync(desk(names.shared), png(12)); fs.writeFileSync(desk(names.keepOnly), png(13)); fs.writeFileSync(desk(names.newLink), png(14));
      embeddedName = writeWorking(ext, W, [desk(names.only), desk(names.shared)]);
      fs.writeFileSync(K, `%PDF-1.7\n${desk(names.shared)}\n${desk(names.keepOnly)}\n%%EOF\n`);
      inddDoc = ext === '.indd' ? W : null;
    } });
    for (const filePath of opts.keepFirst ? [K, W] : [W, K]) await f.add(filePath);
    return { ...f, names, W, K, tag, ext, embeddedName, keepNames: [`Keep-${tag}.ai`, names.keepOnly, names.shared].sort() };
  }
  // The same handle API over an existing project.
  async function projectHandleFor(id, current) {
    const workspace = () => callIpcRaw('projects:get-asset-workspace', id);
    const add = async filePath => {
      manualDialogFor([filePath]);
      const result = await callIpcRaw('projects:add-files', id);
      assert.notEqual(result?.success, false, JSON.stringify(result));
      if (current().assetBaseline?.status === 'decision-required') {
        assert.equal((await callIpcRaw('projects:set-existing-assets-decision', id, 'include')).success, true);
      }
      await resolveChoices(id);
    };
    const fact = async name => { const rows = (await workspace()).files.filter(file => matchName(file.name, name)); assert.equal(rows.length, 1, `one workspace row ${name}`); return rows[0]; };
    const stored = name => { const rows = current().files.filter(file => matchName(file.name, name)); assert.equal(rows.length, 1, `one stored row ${name}`); return rows[0]; };
    const anyRowAt = filePath => [...current().files, ...(current().pendingFiles || [])].filter(file => normalizeCasePath(file.path) === normalizeCasePath(filePath));
    const select = async (filePath, action) => {
      const row = (await workspace()).files.find(file => file.name === path.basename(filePath) && file.sourceSelection);
      assert.ok(row, 'working row ' + path.basename(filePath));
      const response = await callIpcRaw('projects:set-working-source-selection', id, row.visualIdentity, { action, expectedRevision: row.selectionRevision ?? 0 });
      assert.equal(response.success, true, JSON.stringify(response));
      return response;
    };
    const selectionOf = filePath => { const row = current().files.find(file => file.path === filePath);
      const key = metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(current(), row);
      return { key, revision: current().workingSourceSelections?.[key]?.revision ?? 0 }; };
    const out = desk('out-' + id.slice(-6)); fs.mkdirSync(out, { recursive: true });
    const review = async () => { const result = await callIpcRaw('projects:prepare-package-review', id, out); assert.ok(result && !result.error, JSON.stringify(result?.error)); return result; };
    const reviewNames = result => (result.files || []).map(file => file.name).sort();
    const written = async result => {
      assert.equal(result.materializable, true, JSON.stringify(result.semanticCounts));
      const packaged = await callIpcRaw('projects:package', id, out, result.token);
      assert.equal(packaged.success, true, packaged.error);
      const names = walk(packaged.folderPath).map(file => path.basename(file)).filter(name => name !== '.DS_Store' && !/\.(json|txt|md)$/.test(name)).sort();
      fs.rmSync(packaged.folderPath, { recursive: true, force: true });
      return names;
    };
    const toggle = async name => { const response = await callIpcRaw('projects:remove-file', id, (await fact(name)).visualIdentity); assert.ok(Array.isArray(response)); };
    const bulk = async decision => { const response = await callIpcRaw('projects:set-existing-assets-decision', id, decision); assert.equal(response.success, true, JSON.stringify(response)); return response; };
    return { id, current, add, workspace, fact, stored, anyRowAt, select, selectionOf, review, reviewNames, written, toggle, bulk };
  }
  const withoutEmbedded = (list, embedded) => list.filter(name => !embedded || !matchName(name, embedded));

  // ---- Format matrix: every supported working-file format.
  for (const ext of FORMATS) {
    baselineTest(`excluded working file ${ext}: only its own assets leave; Include All Existing keeps them for that exclusion only`, { timeout: 180000 }, () => withEnv(async () => {
      const f = await formatProject(ext, { scope: ext === '.fig' ? 'entire-file' : undefined });
      const { names, embeddedName: E } = f;
      // A PSD packaged before Restore cannot be restored (pre-existing, identical on base); package it only at the end.
      const packageBeforeRestore = ext !== '.psd';
      for (const name of [names.only, names.shared, names.keepOnly, ...(E ? [E] : [])]) assert.equal((await f.fact(name)).included, true, name + ' before');
      await f.select(f.W, 'exclude');
      const assertWithheld = async name => { const row = await f.fact(name);
        assert.deepEqual([row.included, row.excludedSourceOnly, row.excluded, row.includedAsDependency], [false, true, false, false], name); };
      await assertWithheld(names.only);
      if (E) await assertWithheld(E);
      const shared = await f.fact(names.shared);
      assert.deepEqual([shared.included, shared.includedAsDependency, shared.excludedSourceOnly], [true, true, false]);
      assert.deepEqual(shared.requiredBy, [path.basename(f.K)]);
      assert.equal((await f.fact(names.keepOnly)).included, true);
      assert.deepEqual(f.current().excludedAssetKeys || [], [], 'withholding writes no exclusion intent');
      assert.equal((await f.workspace()).semanticCounts.excludedAssets, E ? 2 : 1);
      let review = await f.review();
      assert.equal(review.materializable, true);
      assert.deepEqual(f.reviewNames(review), f.keepNames);
      if (packageBeforeRestore) {
        assert.deepEqual(await f.written(review), f.keepNames, 'written package without the excluded file and its own assets');
        review = await f.review();
      }
      // A rescan of the excluded file is skipped and changes nothing.
      const rowsBefore = JSON.stringify(f.current().files);
      assert.equal((await metadataTestHooks.runScanOnOpen(f.id, f.W))?.skipped, 'source-excluded');
      assert.equal(JSON.stringify(f.current().files), rowsBefore);
      // Pre-package scan while excluded admits nothing the excluded file links.
      const originalBytes = fs.readFileSync(f.W);
      writeWorking(ext, f.W, [desk(names.only), desk(names.shared), desk(names.newLink)]);
      await callIpcRaw('projects:pre-package-scan', f.id);
      assert.deepEqual(f.anyRowAt(desk(names.newLink)), [], 'no row or pending row for the new link');
      assert.equal(f.current().files.some(row => ['psd-linked', 'psd-embedded', 'indd-linked'].includes(row.source) && /Fresh-/.test(row.name || '')), false);
      fs.writeFileSync(f.W, originalBytes);
      if (ext === '.indd') inddModified = false;
      // Store reload changes nothing.
      const factsBefore = JSON.stringify((await f.workspace()).files.map(row => [row.name, row.included, row.excludedSourceOnly]));
      roundTripFakeStore();
      assert.equal(JSON.stringify((await f.workspace()).files.map(row => [row.name, row.included, row.excludedSourceOnly])), factsBefore);
      const staleToken = review.token;

      // Include All Existing while withheld keeps them for this exclusion.
      const wSelection = f.selectionOf(f.W);
      await f.bulk('include');
      for (const name of [names.only, ...(E ? [E] : [])]) {
        const row = await f.fact(name);
        assert.deepEqual([row.included, row.excludedSourceOnly, row.excluded], [true, true, false], name + ' after Include All Existing');
        assert.deepEqual(f.stored(name).existingIncludeEpisode, { version: 1, owners: { [wSelection.key]: wSelection.revision } });
        assert.equal(f.stored(name).keptAfterSourceExclusion, undefined);
      }
      assert.equal(f.stored(names.shared).existingIncludeEpisode, undefined, 'a required shared asset is not marked');
      assert.equal((await callIpcRaw('projects:package', f.id, desk('stale-out'), staleToken)).error, 'package_review_stale', 'a token issued before the click is refused');
      const bulkNames = [...f.keepNames, names.only, ...(E ? [E] : [])];
      roundTripFakeStore();
      review = await f.review();
      assert.equal(f.reviewNames(review).length, bulkNames.length);
      for (const name of bulkNames) assert.ok(f.reviewNames(review).some(actual => matchName(actual, name)), name + ' in review');
      if (packageBeforeRestore) {
        const out = await f.written(review);
        for (const name of bulkNames) assert.ok(out.some(actual => matchName(actual, name)), name + ' written');
      }

      // Restore: its own assets return as dependencies.
      const restored = await f.select(f.W, 'restore');
      const assertDependency = async name => { const row = await f.fact(name);
        assert.deepEqual([row.included, row.includedAsDependency, row.excludedSourceOnly], [true, true, false], name + ' after Restore'); };
      if (ext === '.indd') {
        // InDesign has the document open: Restore needs current bytes (pre-existing, identical on base).
        assert.equal((await f.review()).materializable, false);
      } else {
        assert.equal(restored.verificationStatus, 'scanned');
        await assertDependency(names.only);
        review = await f.review();
        assert.equal(review.materializable, true);
        for (const name of [...bulkNames, path.basename(f.W)]) assert.ok(f.reviewNames(review).some(actual => matchName(actual, name)), name + ' after Restore');
        // Written package at the Restore point (all formats except .indd, whose open-document Restore is not materializable).
        const restoredWritten = await f.written(review);
        assert.deepEqual(restoredWritten, f.reviewNames(review).slice().sort());
        for (const name of [...bulkNames, path.basename(f.W)]) assert.ok(restoredWritten.some(actual => matchName(actual, name)), name + ' written after Restore');
        review = await f.review();
      }
      // A later Exclude withholds them again: the earlier click belonged to the earlier exclusion.
      await f.select(f.W, 'exclude');
      roundTripFakeStore();
      await assertWithheld(names.only);
      if (E) await assertWithheld(E);
      assert.ok(f.stored(names.only).existingIncludeEpisode.owners[wSelection.key] < f.selectionOf(f.W).revision);
      assert.deepEqual(f.reviewNames(await f.review()), f.keepNames);
      // A per-asset Include is durable and independent of the bulk state.
      await f.toggle(names.only);
      assert.equal(f.stored(names.only).keptAfterSourceExclusion, true);
      assert.equal((await f.fact(names.only)).included, true);
      // A second Include All Existing follows the current exclusion.
      await f.bulk('include');
      if (E) {
        assert.equal((await f.fact(E)).included, true);
        assert.deepEqual(f.stored(E).existingIncludeEpisode.owners, { [wSelection.key]: f.selectionOf(f.W).revision });
      }
      await f.select(f.W, 'restore');
      await f.select(f.W, 'exclude');
      roundTripFakeStore();
      assert.equal((await f.fact(names.only)).included, true, 'per-asset Include survives Restore and a later Exclude');
      if (E) await assertWithheld(E);
      review = await f.review();
      assert.equal(review.materializable, true);
      const expected = [...f.keepNames, names.only].sort();
      assert.deepEqual(f.reviewNames(review), expected);
      assert.deepEqual(await f.written(review), expected);
    }, { realTmp: ext === '.indd', realMainPsd: ext === '.psd' }));
  }

  // ---- Include All Existing for the current exclusion: several owners.
  // X is linked by W1 and W2 only (existing); Keep.ai keeps the project packageable.
  async function twoOwnerProject() {
    const W1 = desk('W1.ai'), W2 = desk('W2.ai'), K = desk('Keep.ai'), X = desk('X.png'), side = desk('Side.png');
    const f = await newProject('Two owners', { before() {
      fs.writeFileSync(X, png(31)); fs.writeFileSync(side, png(32));
      fs.writeFileSync(W1, `%PDF-1.7\n${X}\n%%EOF\n`); fs.writeFileSync(W2, `%PDF-1.7\n${X}\n%%EOF\n`);
      fs.writeFileSync(K, `%PDF-1.7\n${side}\n%%EOF\n`);
    } });
    for (const filePath of [W1, W2, K]) await f.add(filePath);
    assert.equal(f.stored('X.png').assetOrigin, 'existing');
    const included = async () => (await f.fact('X.png')).included;
    const state = async () => { const row = await f.fact('X.png'); return [row.included, row.includedAsDependency, row.excludedSourceOnly]; };
    return { ...f, W1, W2, K, X, included, state };
  }
  const KEPT_BY_BULK = [true, false, true], WITHHELD = [false, false, true], DEPENDENCY = [true, true, false];
  baselineTest('Include All Existing keeps an asset only while each excluded owner is in the exclusion current at the click (W1 first)', { timeout: 120000 }, () => withEnv(async () => {
    const f = await twoOwnerProject();
    await f.select(f.W1, 'exclude');
    assert.deepEqual(await f.state(), DEPENDENCY, 'an included owner keeps it');
    await f.select(f.W2, 'exclude');
    assert.deepEqual(await f.state(), WITHHELD);
    await f.bulk('include');
    const w1 = f.selectionOf(f.W1), w2 = f.selectionOf(f.W2);
    assert.deepEqual(f.stored('X.png').existingIncludeEpisode, { version: 1, owners: { [w1.key]: w1.revision, [w2.key]: w2.revision } });
    assert.deepEqual(await f.state(), KEPT_BY_BULK);
    roundTripFakeStore(); assert.deepEqual(await f.state(), KEPT_BY_BULK, 'reload');
    await f.select(f.W1, 'restore'); assert.deepEqual(await f.state(), DEPENDENCY, 'Restore W1');
    await f.select(f.W1, 'exclude'); assert.deepEqual(await f.state(), WITHHELD, 'W1 is in a later exclusion');
    roundTripFakeStore(); assert.deepEqual(await f.state(), WITHHELD, 'reload');
    await f.select(f.W2, 'restore'); assert.deepEqual(await f.state(), DEPENDENCY, 'Restore W2');
    await f.select(f.W2, 'exclude'); assert.deepEqual(await f.state(), WITHHELD, 'both in later exclusions');
    await f.bulk('include'); assert.deepEqual(await f.state(), KEPT_BY_BULK, 'a second click honors the new exclusions');
    const review = await f.review();
    assert.deepEqual(f.reviewNames(review), ['Keep.ai', 'Side.png', 'X.png']);
    assert.deepEqual(await f.written(review), ['Keep.ai', 'Side.png', 'X.png']);
  }));
  baselineTest('Include All Existing keeps an asset only while each excluded owner is in the exclusion current at the click (W2 cycles)', { timeout: 120000 }, () => withEnv(async () => {
    const f = await twoOwnerProject();
    await f.select(f.W1, 'exclude'); await f.select(f.W2, 'exclude');
    await f.bulk('include'); assert.deepEqual(await f.state(), KEPT_BY_BULK);
    // W2 alone restored and excluded again: W1 is unchanged, W2 is not.
    await f.select(f.W2, 'restore'); assert.deepEqual(await f.state(), DEPENDENCY);
    await f.select(f.W2, 'exclude'); assert.deepEqual(await f.state(), WITHHELD);
    await f.select(f.W1, 'restore'); assert.deepEqual(await f.state(), DEPENDENCY);
    await f.select(f.W1, 'exclude'); assert.deepEqual(await f.state(), WITHHELD);
    // An owner excluded only after the click: W1 alone at the click, W2 excluded later.
    await f.select(f.W2, 'restore');
    await f.bulk('include');
    assert.deepEqual(await f.state(), DEPENDENCY, 'not withheld at the click: nothing recorded');
    assert.equal(f.stored('X.png').existingIncludeEpisode.owners[f.selectionOf(f.W2).key] < f.selectionOf(f.W2).revision, true);
    await f.select(f.W2, 'exclude');
    assert.deepEqual(await f.state(), WITHHELD, 'a later exclusion of another owner withholds it');
  }));

  // Per-asset choices, explicit exclusions, Skip, shared assets and Add Files additions.
  baselineTest('Include All Existing for the current exclusion leaves per-asset choices, shared assets and Add Files additions as they are', { timeout: 120000 }, () => withEnv(async () => {
    const W = desk('Art.ai'), K = desk('Keep.ai');
    const solo = desk('Solo.png'), toggled = desk('Toggled.png'), shared = desk('Shared.png'), manual = desk('Manual.png'), side = desk('Side.png');
    const f = await newProject('Bulk choices', { before() {
      for (const [file, seed] of [[solo, 41], [toggled, 42], [shared, 43], [manual, 44], [side, 45]]) fs.writeFileSync(file, png(seed));
      fs.writeFileSync(W, `%PDF-1.7\n${solo}\n${toggled}\n${shared}\n${manual}\n%%EOF\n`);
      fs.writeFileSync(K, `%PDF-1.7\n${shared}\n${side}\n%%EOF\n`);
    } });
    for (const filePath of [W, K]) await f.add(filePath);
    // Manual.png is then added explicitly with Add Files.
    manualDialogFor([manual]); await callIpcRaw('projects:add-files', f.id);
    assert.equal(f.stored('Manual.png').assetOrigin === 'existing', false);
    await f.select(W, 'exclude');
    assert.equal((await f.fact('Solo.png')).included, false);
    assert.equal((await f.fact('Manual.png')).included, true, 'Add Files addition stays');
    assert.equal((await f.fact('Shared.png')).includedAsDependency, true);
    // Per-asset Include before the click is durable and is not replaced by it.
    await f.toggle('Toggled.png');
    assert.equal(f.stored('Toggled.png').keptAfterSourceExclusion, true);
    await f.bulk('include');
    for (const name of ['Shared.png', 'Manual.png', 'Side.png', 'Toggled.png']) assert.equal(f.stored(name).existingIncludeEpisode, undefined, name);
    assert.ok(f.stored('Solo.png').existingIncludeEpisode);
    // Per-asset Exclude of a bulk-kept asset excludes it explicitly and ends the bulk keep.
    await f.toggle('Solo.png');
    let row = await f.fact('Solo.png');
    assert.deepEqual([row.included, row.excluded], [false, true]);
    assert.equal(f.stored('Solo.png').existingIncludeEpisode, undefined);
    assert.ok(f.current().excludedAssetKeys.length >= 1);
    // Include All Existing clears explicit exclusions of existing assets (unchanged behavior) and keeps it again.
    await f.bulk('include');
    row = await f.fact('Solo.png');
    assert.deepEqual([row.included, row.excluded, row.excludedSourceOnly], [true, false, true]);
    assert.ok(f.stored('Solo.png').existingIncludeEpisode);
    // Skip All Existing afterwards is the later bulk choice: every existing asset is explicitly excluded and the keep ends.
    await f.bulk('skip');
    assert.equal(f.stored('Solo.png').existingIncludeEpisode, undefined);
    for (const name of ['Solo.png', 'Toggled.png']) assert.equal((await f.fact(name)).included, false, name + ' after Skip');
    assert.equal((await f.fact('Side.png')).includedAsDependency, true, 'required by the selected Keep.ai');
    assert.equal((await f.fact('Manual.png')).included, true, 'an Add Files addition is not an existing asset');
    // Restore and a later Exclude: the per-asset Include survives; Solo is withheld again after Include All.
    await f.bulk('include');
    await f.select(W, 'restore'); await f.select(W, 'exclude');
    roundTripFakeStore();
    assert.equal((await f.fact('Toggled.png')).included, true);
    assert.equal((await f.fact('Solo.png')).included, false);
    assert.equal((await f.fact('Manual.png')).included, true);
    assert.equal((await f.fact('Shared.png')).included, true);
  }));

  // Include All Existing before any exclusion is not owner intent for a later exclusion.
  async function pendingExistingFixture() {
    const f = await newProject('Pending existing', { pause: true });
    const A = desk('A.psd'), keep = desk('Keep.ai');
    for (const name of ['A.psd', 'Accepted.png', 'Sibling.png']) fs.writeFileSync(desk(name), `synthetic ${name}`);
    fs.writeFileSync(keep, '%PDF-1.7\n%%EOF\n');
    const source = name => ({ fileId: name, path: desk(name), name, ext: path.extname(name), projectRole: 'source', source: 'user-added', addedAt: Date.now() });
    const pendingRow = (name, assetOrigin) => ({ fileId: name, path: desk(name), name, ext: '.png', projectRole: 'asset', source: 'psd-linked', assetOrigin,
      addedAt: Date.now() - 60000, captureState: 'needs-save', captureReason: 'linked-asset-observed',
      captureEvidence: { schemaVersion: 1, source: 'psd-linked', appFamily: 'photoshop', relationshipSourcePath: A, documentModified: true } });
    f.current().files = [source('A.psd'), source('Keep.ai')];
    f.current().pendingFiles = [pendingRow('Accepted.png', 'existing'), pendingRow('Sibling.png', 'added')];
    f.current().assetBaseline = { schemaVersion: 1, status: 'decision-required', decision: null, establishedAt: Date.now() };
    roundTripFakeStore();
    currentPsdFixture = { children: [], linkedFiles: ['Accepted.png', 'Sibling.png'].map(name => ({ name, linkedFile: { fullPath: desk(name) } })) };
    const scanThenExclude = async () => {
      await f.select(A, 'exclude');
      assert.equal((await f.select(A, 'restore')).verificationStatus, 'scanned');
      await f.select(A, 'exclude');
    };
    return { ...f, A, scanThenExclude };
  }
  baselineTest('pending existing assets promoted by Include All Existing during an exclusion are kept for that exclusion only', { timeout: 120000 }, async () => {
    const f = await pendingExistingFixture();
    try {
      await f.scanThenExclude();
      // An existing row still awaiting review while its working file is excluded.
      const admitted = f.current().files.find(file => file.name === 'Accepted.png');
      f.current().files = f.current().files.filter(file => file !== admitted);
      f.current().pendingFiles.push({ ...admitted, assetOrigin: 'existing', captureState: 'needs-save', captureReason: 'linked-asset-observed',
        captureEvidence: { schemaVersion: 1, source: 'psd-linked', appFamily: 'photoshop', relationshipSourcePath: f.A, documentModified: true } });
      f.current().assetBaseline = { ...f.current().assetBaseline, status: 'decision-required', decision: null };
      roundTripFakeStore();
      const decided = await f.bulk('include');
      assert.ok(decided.project.files.some(file => file.name === 'Accepted.png'), 'the IPC result carries the promoted row');
      const row = await f.fact('Accepted.png');
      assert.deepEqual([row.included, row.excludedSourceOnly], [true, true], 'the promoted row is included, as the click reported');
      assert.deepEqual(f.reviewNames(await f.review()), ['Accepted.png', 'Keep.ai']);
      await f.select(f.A, 'restore'); await f.select(f.A, 'exclude');
      assert.equal((await f.fact('Accepted.png')).included, false, 'withheld after the next exclusion');
    } finally { currentPsdFixture = { children: [], linkedFiles: [] }; clearTrackedTimers(); }
  });

  // ---- Selection or Include landing while a scan, a presentation save or a Start Watching snapshot is in flight.
  const gateRead = (target, read = fs.promises.readFile) => {
    let release, entered = false; const gate = new Promise(resolve => { release = resolve; });
    fs.promises.readFile = async function gated(file, ...args) {
      if (path.resolve(String(file)) === target && !entered) { entered = true; await gate; }
      return read.call(fs.promises, file, ...args);
    };
    return { entered: () => entered, release, restore() { release(); fs.promises.readFile = read; } };
  };
  for (const landing of ['exclude', 'restore', 'include-all']) {
    baselineTest(`pre-package scan in flight: ${landing} landing during the scan`, { timeout: 120000 }, () => withEnv(async () => {
      const f = await formatProject('.ai');
      if (landing !== 'exclude') await f.select(f.W, 'exclude');
      writeWorking('.ai', f.W, [desk(f.names.only), desk(f.names.shared), desk(f.names.newLink)]);
      const gate = gateRead(f.K);
      try {
        const scan = callIpcRaw('projects:pre-package-scan', f.id);
        await waitForCondition(() => gate.entered(), 'scan did not reach the gated read', 20000);
        if (landing === 'include-all') await f.bulk('include'); else await f.select(f.W, landing);
        gate.release(); await scan;
      } finally { gate.restore(); }
      const fresh = f.anyRowAt(desk(f.names.newLink));
      if (landing === 'exclude') {
        // Admitted for W before the Exclude landed; its owner record withholds it.
        assert.equal(fresh.length, 1); assert.deepEqual(fresh[0].dependencyOwners, [f.W]);
        assert.equal((await f.fact(f.names.newLink)).included, false);
        await f.select(f.W, 'restore');
        assert.equal((await f.fact(f.names.newLink)).included, true);
      } else if (landing === 'restore') {
        // The scan skipped W; Restore's own scan admits the new link as a dependency.
        assert.equal((await f.fact(f.names.newLink)).includedAsDependency, true);
        assert.equal((await f.workspace()).semanticCounts.missingRequiredReferences, 0);
      } else {
        assert.deepEqual(fresh, [], 'the excluded file was not scanned');
        assert.equal((await f.fact(f.names.only)).included, true, 'the merge keeps the click');
        assert.ok(f.stored(f.names.only).existingIncludeEpisode);
      }
    }));
  }
  for (const landing of ['exclude', 'include-all']) {
    baselineTest(`presentation save in flight: ${landing} landing during the save`, { timeout: 120000 }, () => withEnv(async () => {
      const f = await formatProject('.pptx');
      if (landing === 'include-all') await f.select(f.W, 'exclude');
      extraMediaSeed = 557; try { writeWorking('.pptx', f.W, [desk(f.names.only), desk(f.names.shared)]); } finally { extraMediaSeed = 0; }
      let release, entered = false; const gate = new Promise(resolve => { release = resolve; });
      setChildProcessHandler(request => {
        if (request.kind === 'execFile' && request.command === '/usr/bin/unzip' && request.args[0] === '-l' && !entered) {
          entered = true; return gate.then(() => passthroughInner(request));
        }
        return passthroughInner(request);
      });
      const save = metadataTestHooks.runScanOnSavePresentation(f.id, f.W);
      if (landing === 'include-all') {
        // Excluded: the save does not start.
        await save; assert.equal(entered, false);
        await f.bulk('include');
        assert.equal(f.current().files.some(row => /image2/.test(row.name || '')), false);
        return;
      }
      await waitForCondition(() => entered, 'save did not reach the archive listing', 20000);
      await f.select(f.W, 'exclude');
      release(); await save;
      const media = f.current().files.filter(row => /image2/.test(row.name || ''));
      assert.equal(media.length, 1); assert.deepEqual(media[0].dependencyOwners, [f.W]);
      assert.equal((await f.fact('image2.png')).included, false, 'withheld with its presentation');
      await f.select(f.W, 'restore');
      assert.equal((await f.fact('image2.png')).included, true);
    }));
  }
  baselineTest('Start Watching snapshot: an Exclude landing before the snapshot commits is honored', { timeout: 120000 }, () => withEnv(async () => {
    const f = await formatProject('.ai');
    await callIpcRaw('projects:pause', f.id); clearTrackedTimers();
    writeWorking('.ai', f.W, [desk(f.names.only), desk(f.names.shared), desk(f.names.newLink)]);
    let release, entered = false; const gate = new Promise(resolve => { release = resolve; });
    setChildProcessHandler(request => {
      if (request.kind === 'execFile' && request.command === '/bin/ps') return { stdout: '444 /Applications/Adobe Illustrator.app/Contents/MacOS/Adobe Illustrator\n' };
      if (request.kind === 'execFile' && request.command === '/usr/sbin/lsof') {
        const out = { stdout: `p444\nf14\ntREG\nn${f.W}\n` };
        if (!entered) { entered = true; return gate.then(() => out); }
        return out;
      }
      return passthroughInner(request);
    });
    const started = callIpcRaw('projects:start-watching', f.id);
    await waitForCondition(() => entered, 'snapshot did not reach lsof', 20000);
    await f.select(f.W, 'exclude');
    release(); await started;
    await metadataTestHooks.waitForWatcherIdle(f.id).catch(() => null);
    await callIpcRaw('projects:pause', f.id); clearTrackedTimers(); passthrough();
    assert.deepEqual(f.anyRowAt(desk(f.names.newLink)), [], 'the excluded file is not parsed for links');
  }));

  // ---- Owner records: every route that observes an asset for a working file.
  const ROUTES = [['regex', '.ai'], ['doublecheck', '.sketch'], ['psdparse', '.psd'], ['snapshot', '.ai']];
  for (const [route, ext] of ROUTES) for (const order of ['W-only', 'W-first', 'K-first']) {
    baselineTest(`owner records ${route}: ${order}`, { timeout: 120000 }, () => withEnv(async () => {
      const f = await formatProject(ext);
      const X = desk('Shared2-' + f.tag + '.png'); fs.writeFileSync(X, png(88));
      const K2 = desk('Keep2-' + f.tag + (route === 'psdparse' ? '.psd' : route === 'doublecheck' ? '.sketch' : '.ai'));
      writeWorking(path.extname(K2), K2, [desk(f.names.keepOnly)], 901);
      await f.add(K2);
      const links = { W: false, K: false };
      const linkIn = (file, withX) => {
        if (route === 'psdparse') { links[file === f.W ? 'W' : 'K'] = withX; return; }
        writeWorking(path.extname(file), file, file === f.W ? [desk(f.names.only), desk(f.names.shared), ...(withX ? [X] : [])]
          : [desk(f.names.keepOnly), ...(withX ? [X] : [])], file === f.W ? 900 : 901);
      };
      const runRoute = async () => {
        if (route === 'snapshot') {
          await callIpcRaw('projects:pause', f.id); clearTrackedTimers();
          const open = [f.W, K2].map((file, i) => `f${14 + i}\ntREG\nn${file}\n`).join('');
          setChildProcessHandler(request => {
            if (request.kind === 'execFile' && request.command === '/bin/ps') return { stdout: '444 /Applications/Adobe Illustrator.app/Contents/MacOS/Adobe Illustrator\n' };
            if (request.kind === 'execFile' && request.command === '/usr/sbin/lsof') return { stdout: `p444\n${open}` };
            return passthroughInner(request);
          });
          await callIpcRaw('projects:start-watching', f.id);
          await metadataTestHooks.waitForWatcherIdle(f.id).catch(() => null);
          await callIpcRaw('projects:pause', f.id); clearTrackedTimers(); passthrough();
        } else if (route === 'psdparse') {
          const wBytes = fs.readFileSync(f.W), kBytes = fs.readFileSync(K2);
          currentPsdFixture = buffer => ({ children: buffer && ((links.W && buffer.equals(wBytes)) || (links.K && buffer.equals(kBytes)))
            ? [{ name: 'L', linkedFile: { fullPath: X } }] : [], linkedFiles: [] });
          try { await callIpcRaw('projects:pre-package-scan', f.id); } finally { currentPsdFixture = 'actual-source-buffer'; }
        } else await callIpcRaw('projects:pre-package-scan', f.id);
      };
      if (order !== 'K-first') { linkIn(f.W, true); await runRoute(); }
      if (order !== 'W-only') { linkIn(K2, true); await runRoute(); }
      if (order === 'K-first') { linkIn(f.W, true); await runRoute(); }
      const rows = f.anyRowAt(X);
      assert.equal(rows.length, 1, 'one row for X');
      const expectedOwners = order === 'W-only' ? [f.W] : order === 'W-first' ? [f.W, K2] : [K2, f.W];
      assert.deepEqual(rows[0].dependencyOwners, expectedOwners);
      await f.select(f.W, 'exclude');
      const kept = order !== 'W-only';
      assert.equal((await f.fact(path.basename(X))).included, kept);
      roundTripFakeStore();
      assert.equal((await f.fact(path.basename(X))).included, kept, 'after reload');
      assert.deepEqual(f.anyRowAt(X)[0].dependencyOwners, expectedOwners);
      if (!kept) {
        assert.ok(!f.reviewNames(await f.review()).includes(path.basename(X)));
        await f.select(f.W, 'restore');
        assert.equal((await f.fact(path.basename(X))).included, true, 'Restore');
      }
    }, { realTmp: route === 'snapshot' }));
  }
  baselineTest('owner records: a late owner keeps the asset; an owner that is no longer a project file does not', { timeout: 120000 }, () => withEnv(async () => {
    const f = await formatProject('.ai');
    const fresh = desk(f.names.newLink);
    writeWorking('.ai', f.W, [desk(f.names.only), desk(f.names.shared), fresh]);
    await callIpcRaw('projects:pre-package-scan', f.id);
    assert.deepEqual(f.anyRowAt(fresh)[0].dependencyOwners, [f.W]);
    await f.select(f.W, 'exclude');
    assert.equal((await f.fact(f.names.newLink)).included, false);
    // K gains the link while W is excluded: the next scan records K, which keeps it.
    fs.writeFileSync(f.K, `%PDF-1.7\n${desk(f.names.shared)}\n${desk(f.names.keepOnly)}\n${fresh}\n%%EOF\n`);
    await callIpcRaw('projects:pre-package-scan', f.id);
    assert.deepEqual(f.anyRowAt(fresh)[0].dependencyOwners, [f.W, f.K]);
    assert.equal((await f.fact(f.names.newLink)).included, true);
    // An owner removed from the project no longer keeps it.
    const owners = f.anyRowAt(fresh)[0].dependencyOwners;
    f.current().files.find(row => row.path === fresh).dependencyOwners = [...owners.slice(0, 1), desk('Removed.ai')];
    roundTripFakeStore();
    assert.equal((await f.fact(f.names.newLink)).included, false, 'a recorded owner that is not a project file is ignored');
  }));
  baselineTest('owner records: the bound sets overflow and keeps; a token issued before an owner-only change is refused', { timeout: 120000 }, () => withEnv(async () => {
    const f = await formatProject('.ai');
    const X = desk('Many-ai.png'); fs.writeFileSync(X, png(91));
    writeWorking('.ai', f.W, [desk(f.names.only), desk(f.names.shared), X]);
    await callIpcRaw('projects:pre-package-scan', f.id);
    const review = await f.review();
    fs.writeFileSync(f.K, `%PDF-1.7\n${desk(f.names.shared)}\n${desk(f.names.keepOnly)}\n${X}\n%%EOF\n`);
    await callIpcRaw('projects:pre-package-scan', f.id);
    assert.deepEqual(f.anyRowAt(X)[0].dependencyOwners, [f.W, f.K]);
    assert.equal((await callIpcRaw('projects:package', f.id, desk('token-out'), review.token)).error, 'package_review_changed');
    f.current().files.find(row => row.path === X).dependencyOwners = Array.from({ length: 8 }, (_, i) => desk(`Gone-${i}.ai`));
    fs.writeFileSync(f.K, `%PDF-1.7\n${desk(f.names.shared)}\n${desk(f.names.keepOnly)}\n%%EOF\n`);
    roundTripFakeStore();
    await callIpcRaw('projects:pre-package-scan', f.id);
    assert.equal(f.anyRowAt(X)[0].dependencyOwnersOverflow, true);
    assert.equal(f.anyRowAt(X)[0].dependencyOwners.length, 8);
    await f.select(f.W, 'exclude');
    assert.equal((await f.fact('Many-ai.png')).included, true, 'overflow keeps');
  }));
  baselineTest('kept bridge: an excluded InDesign file places an Illustrator file; Including the placed file keeps what it links', { timeout: 120000 }, () => withEnv(async () => {
    const W = desk('Chain.indd'), placed = desk('Placed.ai'), deep = desk('Deep.png'), keep = desk('KeepChain.ai');
    const f = await newProject('Cross chain', { before() {
      fs.writeFileSync(deep, png(61)); fs.writeFileSync(placed, `%PDF-1.7\n${deep}\n%%EOF\n`); fs.writeFileSync(W, `SYNTH.indd\n${placed}\n`);
      fs.writeFileSync(keep, '%PDF-1.7\n%%EOF\n');
    } });
    inddDoc = W;
    for (const filePath of [W, keep]) await f.add(filePath);
    await callIpcRaw('projects:pre-package-scan', f.id);
    assert.equal(f.anyRowAt(deep).length, 1, 'Deep.png admitted while the InDesign file is selected');
    await f.select(W, 'exclude');
    for (const name of ['Placed.ai', 'Deep.png']) assert.equal((await f.fact(name)).included, false, name);
    await callIpcRaw('projects:pre-package-scan', f.id);
    for (const name of ['Placed.ai', 'Deep.png']) assert.equal((await f.fact(name)).included, false, name + ' after a scan');
    await f.toggle('Placed.ai');
    assert.equal((await f.fact('Placed.ai')).included, true);
    assert.equal((await f.fact('Deep.png')).included, true, 'kept by the included placed file');
    assert.deepEqual(f.reviewNames(await f.review()), ['Deep.png', 'KeepChain.ai', 'Placed.ai']);
  }, { realTmp: true }));
  for (const variant of ['retained-as-dependency', 'never-engaged']) {
    baselineTest(`scan guard does not skip: ${variant}`, { timeout: 120000 }, () => withEnv(async () => {
      const f = await formatProject('.ai');
      if (variant === 'retained-as-dependency') {
        fs.writeFileSync(f.K, `%PDF-1.7\n${desk(f.names.shared)}\n${desk(f.names.keepOnly)}\n${f.W}\n%%EOF\n`);
        await metadataTestHooks.runScanOnOpen(f.id, f.K, null, null, { verifySelectedSource: true });
        await f.select(f.W, 'exclude');
        assert.equal((await f.fact(path.basename(f.W))).includedAsDependency, true);
      } else assert.equal(Object.hasOwn(f.current(), 'workingSourceSelections'), false);
      writeWorking('.ai', f.W, [desk(f.names.only), desk(f.names.shared), desk(f.names.newLink)]);
      await callIpcRaw('projects:pre-package-scan', f.id);
      assert.equal(f.anyRowAt(desk(f.names.newLink)).length, 1, 'the link of a file still in the package is admitted');
      assert.equal((await f.fact(f.names.newLink)).included, true);
    }));
  }

  // ---- Presentation save while excluded, and while selected followed by Exclude.
  for (const ext of ['.pptx', '.key']) for (const mode of ['excluded', 'selected-then-exclude']) {
    baselineTest(`presentation save ${ext} ${mode}`, { timeout: 120000 }, () => withEnv(async () => {
      const f = await formatProject(ext);
      const second = ext === '.pptx' ? 'image2.png' : 'second-photo.png';
      if (mode === 'excluded') await f.select(f.W, 'exclude');
      const before = JSON.stringify([f.current().files, f.current().pendingFiles]);
      extraMediaSeed = 557; try { writeWorking(ext, f.W, [desk(f.names.only), desk(f.names.shared)]); } finally { extraMediaSeed = 0; }
      await metadataTestHooks.runScanOnSavePresentation(f.id, f.W);
      if (mode === 'excluded') {
        assert.equal(JSON.stringify([f.current().files, f.current().pendingFiles]), before, 'no row while excluded');
        return;
      }
      const media = f.current().files.filter(row => matchName(row.name, second));
      assert.equal(media.length, 1); assert.deepEqual(media[0].dependencyOwners, [f.W]);
      await f.select(f.W, 'exclude');
      assert.equal((await f.fact(second)).included, false);
      const review = await f.review();
      assert.deepEqual(f.reviewNames(review), f.keepNames);
      assert.deepEqual(await f.written(review), f.keepNames, 'no package-time extraction from the excluded presentation');
      await f.select(f.W, 'restore');
      assert.equal((await f.fact(second)).included, true);
    }));
  }

  // ---- Live link polls: Illustrator, Photoshop, InDesign (modeled scripting output).
  const P_CASES = [['.ai', false], ['.ai', true], ['.psd', null], ['.indd', false], ['.indd', true]];
  for (const [ext, modified] of P_CASES) for (const mode of ['excluded', 'selected-then-exclude']) {
    baselineTest(`live poll ${ext} modified=${modified} ${mode}`, { timeout: 120000 }, () => withEnv(async () => {
      const f = await formatProject(ext);
      const fresh = desk(f.names.newLink);
      if (mode === 'excluded') await f.select(f.W, 'exclude');
      writeWorking(ext, f.W, [desk(f.names.only), desk(f.names.shared), fresh]);
      if (ext === '.indd') inddModified = modified;
      const appName = path.basename(f.W);
      setChildProcessHandler(request => {
        const { kind, command } = request;
        if (ext === '.ai') {
          if (isIllustratorPgrepCheck(request)) return { stdout: '432\n' };
          if (isOsascriptInvocation(request, 'crate-ai-active-session.applescript')) return { stdout:
            `DOC\t${f.W}\t${appName}\t${modified}\ttrue\nLINK\t${f.W}\t${appName}\t${fresh}\t${modified}\ttrue\nCOMPLETE\t1\t1\n` };
        }
        if (ext === '.psd') {
          if (kind === 'exec' && String(command).includes("grep -i 'Adobe Photoshop'")) return { stdout: '123 /Applications/Adobe Photoshop.app/Contents/MacOS/Adobe Photoshop\n' };
          if (isOsascriptInvocation(request, 'crate-ps-poll.applescript')) return { stdout: `${fresh}\n` };
        }
        return passthroughInner(request);
      });
      await metadataTestHooks.pollPsForProject(f.id, metadataTestHooks.getActiveWatchingActivationToken(f.id));
      await metadataTestHooks.waitForWatcherIdle(f.id).catch(() => null);
      clearTrackedTimers(); passthrough();
      const savedInDesign = ext === '.indd' && modified === false;
      const pending = (f.current().pendingFiles || []).filter(row => row.path === fresh);
      if (savedInDesign && mode === 'selected-then-exclude') {
        // A saved InDesign document admits its link directly; the owner record withholds it after Exclude.
        assert.equal(f.current().files.filter(row => row.path === fresh).length, 1);
        assert.deepEqual(f.current().files.find(row => row.path === fresh).dependencyOwners, [f.W]);
        await f.select(f.W, 'exclude');
        assert.equal((await f.fact(f.names.newLink)).included, false);
        await f.select(f.W, 'restore');
        assert.equal((await f.fact(f.names.newLink)).included, true);
        return;
      }
      // Otherwise (including a saved InDesign document while excluded) the link waits for the owner.
      assert.equal(pending.length, 1, 'pending');
      assert.equal(f.current().files.some(row => row.path === fresh), false);
      assert.ok(!f.reviewNames(await f.review()).includes(f.names.newLink));
      assert.ok(await callIpcRaw('projects:accept-pending', f.id, metadataTestHooks.createProjectFileVisualIdentity(f.id, pending[0])));
      if (mode === 'selected-then-exclude') await f.select(f.W, 'exclude');
      assert.equal((await f.fact(f.names.newLink)).included, true, 'Add keeps it while excluded');
      await f.select(f.W, 'restore'); await f.select(f.W, 'exclude');
      assert.equal((await f.fact(f.names.newLink)).included, true, 'and after Restore and a later Exclude');
    }, { realTmp: true }));
  }

  // ---- Links read whole since #324: .woff2 fonts and IDML declared-link forms.
  for (const ext of ['.ai', '.idml', '.sketch', '.afdesign', '.pxd', '.key']) {
    baselineTest(`woff2 font of an excluded ${ext} leaves and returns with it`, { timeout: 120000 }, () => withEnv(async () => {
      const f = await formatProject(ext, { onlyExt: '.woff2' });
      const font = f.stored(f.names.only);
      assert.equal(font.path, desk(f.names.only));
      await f.select(f.W, 'exclude');
      assert.deepEqual([(await f.fact(f.names.only)).included, (await f.fact(f.names.only)).excludedSourceOnly], [false, true]);
      assert.deepEqual(f.reviewNames(await f.review()), f.keepNames);
      await f.select(f.W, 'restore');
      const review = await f.review();
      assert.ok((await f.written(review)).includes(f.names.only));
    }));
  }
  for (const form of ['file://localhost', 'file://']) {
    baselineTest(`IDML ${form} declared links leave and return with the excluded document`, { timeout: 120000 }, () => withEnv(async () => {
      idmlForm = form;
      try {
        const f = await formatProject('.idml');
        await f.select(f.W, 'exclude');
        assert.equal((await f.fact(f.names.only)).included, false);
        assert.deepEqual(f.reviewNames(await f.review()), f.keepNames);
        await f.select(f.W, 'restore');
        const review = await f.review();
        assert.ok((await f.written(review)).includes(f.names.only));
      } finally { idmlForm = 'file:'; }
    }));
  }

  // ---- Legacy logical PSD rows: a per-asset choice follows identical embedded
  // bytes of the same PSD across a rename or reorder restage (dormant project).
  async function legacyPsdProject(label) {
    const W = desk('Legacy.psd'), keep = desk('Keep.ai');
    const f = await newProject('Legacy ' + label);
    fs.writeFileSync(W, 'synthetic psd bytes'); fs.writeFileSync(keep, '%PDF-1.7\n%%EOF\n');
    f.current().files = [
      { fileId: 'w', path: W, name: 'Legacy.psd', ext: '.psd', projectRole: 'source', source: 'manual-browse', addedAt: Date.now() },
      { fileId: 'keep', path: keep, name: 'Keep.ai', ext: '.ai', projectRole: 'source', source: 'manual-browse', addedAt: Date.now() }];
    f.current().pendingFiles = [];
    f.current().assetBaseline = { schemaVersion: 1, status: 'legacy-included', decision: 'include', establishedAt: Date.now() };
    roundTripFakeStore();
    const save = async linkedFiles => { currentPsdFixture = { children: [], linkedFiles }; await metadataTestHooks.runScanOnSave(f.id, W); };
    const logical = () => f.current().files.filter(row => row.source === 'scan-on-save-embedded');
    return { ...f, W, save, logical };
  }
  const objA = { name: 'Obj-A.png', data: png(41) }, objB = { name: 'Obj-B.png', data: png(42) };
  for (const choice of ['exclude', 'exclude-include']) for (const restage of ['rename-reorder', 'unchanged']) {
    baselineTest(`legacy PSD ${choice} survives a ${restage} save on identical embedded bytes`, { timeout: 120000 }, async () => {
      const f = await legacyPsdProject(choice + restage);
      try {
        await f.save([objA, objB]);
        assert.deepEqual(f.logical().map(row => row.name), ['Obj-A.png', 'Obj-B.png']);
        await f.toggle('Obj-A.png');
        if (choice === 'exclude-include') await f.toggle('Obj-A.png');
        const fingerprint = f.stored('Obj-A.png')[choice === 'exclude' ? 'individualContentExclusion' : 'individualContentInclude'];
        assert.match(fingerprint, /^\d+:[0-9a-f]{64}$/);
        const renamed = restage === 'unchanged' ? 'Obj-A.png' : 'Obj-A-renamed.png';
        await f.save(restage === 'unchanged' ? [objA, objB] : [objB, { name: renamed, data: objA.data }]);
        const row = f.stored(renamed);
        assert.equal(row[choice === 'exclude' ? 'individualContentExclusion' : 'individualContentInclude'], fingerprint);
        assert.equal((await f.fact(renamed)).included, choice !== 'exclude');
        assert.equal((await f.fact('Obj-B.png')).included, true, 'the other object is unaffected');
        assert.equal(f.current().files.some(item => item.individualChoiceReview !== undefined), false, 'a proven carry raises no hold');
        // Then the PSD is excluded: an Include stays, the untouched sibling leaves.
        await f.select(f.W, 'exclude');
        assert.equal((await f.fact(renamed)).included, choice !== 'exclude');
        assert.equal((await f.fact('Obj-B.png')).included, false);
      } finally { currentPsdFixture = { children: [], linkedFiles: [] }; clearTrackedTimers(); }
    });
  }
  // ---- Choice guard, legacy logical PSD rows (older Photoshop save route).
  const choiceReviewOf = f => f.current().files.filter(row => row.individualChoiceReview !== undefined).map(row => row.name).sort();
  const assertHeld = async (f, names, reason, staleToken = null) => {
    assert.deepEqual(choiceReviewOf(f), [...names].sort());
    for (const name of names) assert.deepEqual(f.stored(name).individualChoiceReview, { version: 1, reason }, name);
    const workspace = await f.workspace();
    assert.equal(workspace.workingSourceSelectionBlocked, true, 'the workspace shows Package needs review');
    const review = await f.review();
    assert.equal(review.materializable, false); assert.equal(review.token, undefined);
    for (const name of names) assert.ok(review.message.includes(`“${name}”`) || /and \d+ more/.test(review.message), review.message);
    assert.match(review.message, /Choose Include or Exclude for each to continue packaging\./);
    for (const file of review.files) {
      if (names.some(name => matchName(file.name, name))) assert.equal(file.status, 'unavailable', file.name);
    }
    if (staleToken) assert.ok(['package_review_stale', 'package_review_changed'].includes((await callIpcRaw('projects:package', f.id, desk('held-out'), staleToken)).error));
  };
  const assertNotHeld = async f => {
    assert.deepEqual(choiceReviewOf(f), []);
    assert.equal((await f.workspace()).workingSourceSelectionBlocked, false);
    assert.equal((await f.review()).materializable, true);
  };
  baselineTest('legacy PSD guard: an Exclude whose bytes changed in a restage holds the restaged rows until each is chosen', { timeout: 120000 }, async () => {
    const f = await legacyPsdProject('guard-exclude');
    try {
      await f.save([objA, objB]);
      await f.toggle('Obj-A.png');
      const token = (await f.review()).token; assert.ok(token);
      await f.save([objB, { name: 'A2.png', data: png(77) }]);
      // Obj-B moved index but its recorded bytes prove it is the unchosen Obj-B;
      // A2 has new bytes: nothing proves where the Exclude belongs.
      await assertHeld(f, ['A2.png'], 'psd-embedded-restaged', token);
      assert.equal(f.stored('A2.png').individualContentExclusion, undefined);
      assert.equal((await f.fact('A2.png')).included, true, 'membership itself is unchanged; packaging is held');
      roundTripFakeStore();
      await assertHeld(f, ['A2.png'], 'psd-embedded-restaged');
      // The unchanged save keeps the hold; nothing is restaged.
      await f.save([objB, { name: 'A2.png', data: png(77) }]);
      await assertHeld(f, ['A2.png'], 'psd-embedded-restaged');
      // Resolution: one per-asset click records an explicit choice (here Exclude).
      await f.toggle('A2.png');
      assert.equal(f.stored('A2.png').individualChoiceReview, undefined);
      assert.equal((await f.fact('A2.png')).included, false, 'A2 explicitly excluded');
      await assertNotHeld(f);
      const review = await f.review();
      assert.deepEqual(f.reviewNames(review), ['Keep.ai', 'Legacy.psd', 'Obj-B.png']);
      assert.deepEqual(await f.written(review), ['Keep.ai', 'Legacy.psd', 'Obj-B.png'], 'written folder matches review: A2 (Exclude) absent');
    } finally { currentPsdFixture = { children: [], linkedFiles: [] }; clearTrackedTimers(); }
  });
  baselineTest('legacy PSD guard: conflicting choices on identical bytes and a second restage before resolution stay held', { timeout: 120000 }, async () => {
    const f = await legacyPsdProject('guard-conflict');
    try {
      const twin = { name: 'Obj-C.png', data: objA.data };
      await f.save([objA, objB, twin]);
      await f.toggle('Obj-A.png');      // Exclude A; C (same bytes) follows by content
      await f.toggle('Obj-C.png');      // Include C on its own
      await f.save([{ name: 'A2.png', data: objA.data }, objB, { name: 'C2.png', data: objA.data }]);
      // Obj-B kept its identity (same index and name): not restaged, not held.
      await assertHeld(f, ['A2.png', 'C2.png'], 'psd-embedded-restaged');
      for (const name of ['A2.png', 'C2.png']) {
        assert.equal(f.stored(name).individualContentExclusion, undefined); assert.equal(f.stored(name).individualContentInclude, undefined);
      }
      // A second restage before resolution: the hold moves to the new rows.
      await f.save([{ name: 'A3.png', data: objA.data }, objB, { name: 'C3.png', data: png(78) }]);
      await assertHeld(f, ['A3.png', 'C3.png'], 'psd-embedded-restaged');
      await f.toggle('A3.png'); await f.toggle('C3.png');
      await assertNotHeld(f);
    } finally { currentPsdFixture = { children: [], linkedFiles: [] }; clearTrackedTimers(); }
  });
  baselineTest('legacy PSD guard does not fire without a choice, for a proven carry, or when an object is only removed', { timeout: 120000 }, async () => {
    const f = await legacyPsdProject('guard-none');
    try {
      await f.save([objA, objB]);
      await f.save([objB, { name: 'A2.png', data: png(77) }]);
      await assertNotHeld(f);
      await f.toggle('A2.png');                                   // Exclude, bytes recorded
      await f.save([{ name: 'A3.png', data: png(77) }, objB]);   // rename+reorder, same bytes: proven
      assert.equal(f.stored('A3.png').individualContentExclusion !== undefined, true);
      await assertNotHeld(f);
      await f.save([objB]);                                       // the chosen object removed, no successor row
      assert.deepEqual(f.logical().map(row => row.name), ['Obj-B.png']);
      await assertNotHeld(f);
    } finally { currentPsdFixture = { children: [], linkedFiles: [] }; clearTrackedTimers(); }
  });
  baselineTest('legacy PSD guard: the choice hold survives working-file Exclude, Restore and Exclude again and the per-asset control clears it; the separate association block remains', { timeout: 120000 }, async () => {
    const f = await legacyPsdProject('guard-selection');
    try {
      await f.save([objA, objB]);
      await f.toggle('Obj-A.png'); await f.toggle('Obj-A.png');   // Exclude then Include
      await f.save([objB, { name: 'A2.png', data: png(77) }]);
      await assertHeld(f, ['A2.png'], 'psd-embedded-restaged');
      await f.select(f.W, 'exclude');
      await assertHeld(f, ['A2.png'], 'psd-embedded-restaged');
      assert.equal((await metadataTestHooks.runScanOnSave(f.id, f.W))?.skipped, 'source-excluded', 'saves while excluded are skipped');
      await assertHeld(f, ['A2.png'], 'psd-embedded-restaged');
      await f.select(f.W, 'restore');
      assert.equal(f.stored('A2.png').individualChoiceReview?.reason, 'psd-embedded-restaged', 'Restore keeps the hold');
      assert.equal((await f.workspace()).workingSourceSelectionBlocked, true);
      await f.select(f.W, 'exclude');
      await assertHeld(f, ['A2.png'], 'psd-embedded-restaged');
      // Withheld with the excluded PSD, the held row is one click from an explicit Include.
      await f.toggle('A2.png');
      assert.equal(f.stored('A2.png').keptAfterSourceExclusion, true);
      assert.equal((await f.fact('A2.png')).included, true);
      // The choice hold is cleared by the per-asset control. After the engaged
      // Restore of a legacy PSD the pre-existing, separate Photoshop association
      // block remains (unchanged by this PR; identical on base).
      assert.deepEqual(choiceReviewOf(f), []);
      const settled = await f.review();
      assert.equal(settled.materializable, false);
      assert.equal(settled.message, 'Photoshop asset association is unresolved. Your files are preserved; this package is blocked.');
      assert.equal(/Include or Exclude/.test(settled.message), false, 'not a choice-review refusal');
    } finally { currentPsdFixture = { children: [], linkedFiles: [] }; clearTrackedTimers(); }
  });

  // ---- Choice guard, presentation media (presentation save route).
  const mediaName = ext => ext === '.pptx' ? 'image1.png' : 'embedded-photo.png';
  const changedName = ext => ext === '.pptx' ? 'image1_1.png' : 'embedded-photo_1.png';
  // A save, then the selected deck's verification refresh (skipped while excluded).
  const savePresentation = async (f, seed) => { writeWorking(f.ext, f.W, [desk(f.names.only), desk(f.names.shared)], seed);
    await metadataTestHooks.runScanOnSavePresentation(f.id, f.W);
    await metadataTestHooks.runScanOnOpen(f.id, f.W, null, null, { verifySelectedSource: true }); };
  for (const ext of ['.pptx', '.key']) {
    baselineTest(`presentation guard ${ext}: changed media after a per-asset Include holds the new row until chosen`, { timeout: 120000 }, () => withEnv(async () => {
      const f = await formatProject(ext);
      const old = `Work-${f.tag} — ${mediaName(ext)}`, fresh = `Work-${f.tag} — ${changedName(ext)}`;
      await f.select(f.W, 'exclude');
      await f.toggle(old);                                   // per-asset Include of the withheld media
      await f.select(f.W, 'restore');
      const token = (await f.review()).token; assert.ok(token);
      await savePresentation(f, 777);                        // same member, different bytes
      await assertHeld(f, [fresh], 'presentation-media-changed', token);
      assert.deepEqual(f.stored(old).presentationChoiceSuperseded, { version: 1 });
      assert.equal(f.stored(old).keptAfterSourceExclusion, true, 'the old row keeps its own choice');
      roundTripFakeStore();
      await assertHeld(f, [fresh], 'presentation-media-changed');
      await savePresentation(f, 777);                        // unchanged save: no new row, no new hold
      await assertHeld(f, [fresh], 'presentation-media-changed');
      await f.select(f.W, 'exclude');
      await assertHeld(f, [fresh], 'presentation-media-changed');
      await savePresentation(f, 778);                        // saves while excluded are skipped
      await assertHeld(f, [fresh], 'presentation-media-changed');
      await f.select(f.W, 'restore');                        // Restore captures the 778 change: also held
      const whileExcluded = `Work-${f.tag} — ${changedName(ext).replace('_1', '_2')}`;
      await assertHeld(f, [fresh, whileExcluded], 'presentation-media-changed');
      await f.toggle(whileExcluded);                         // Exclude it
      await savePresentation(f, 777);
      await assertHeld(f, [fresh], 'presentation-media-changed');
      // Resolution: Include the new media (two clicks: Exclude, then Include).
      await f.toggle(fresh);
      assert.equal(f.stored(fresh).individualChoiceReview, undefined);
      await f.toggle(fresh);
      assert.equal((await f.fact(fresh)).included, true);
      await assertNotHeld(f);
      const review = await f.review();
      // The old row is no longer in the presentation; it is still packaged by its own Include (from Crate's copy).
      for (const name of [old, fresh]) assert.ok(f.reviewNames(review).includes(name), name);
      assert.ok((await f.written(review)).includes(old));
    }));
    baselineTest(`presentation guard ${ext}: a second change before resolution, and a change after it, hold again`, { timeout: 120000 }, () => withEnv(async () => {
      const f = await formatProject(ext);
      const old = `Work-${f.tag} — ${mediaName(ext)}`;
      await f.toggle(old);                                   // explicit Exclude while selected
      await savePresentation(f, 777);
      const first = f.current().files.filter(row => row.individualChoiceReview !== undefined).map(row => row.name);
      assert.equal(first.length, 1);
      await savePresentation(f, 779);                        // second change before resolution
      const held = choiceReviewOf(f);
      assert.equal(held.length, 2); assert.ok(held.includes(first[0]));
      for (const name of held) await f.toggle(name);
      await assertNotHeld(f);
      // A later change of a row with an explicit choice raises the guard once more.
      await savePresentation(f, 780);
      assert.equal(choiceReviewOf(f).length, 1);
      await f.toggle(choiceReviewOf(f)[0]);
      await assertNotHeld(f);
    }));
    baselineTest(`presentation guard ${ext} does not fire without a choice or for bytes Crate already has`, { timeout: 120000 }, () => withEnv(async () => {
      const f = await formatProject(ext);
      await savePresentation(f, 777);                        // no individual choice anywhere
      await assertNotHeld(f);
      const old = `Work-${f.tag} — ${mediaName(ext)}`;
      await f.toggle(old);                                   // Exclude the original media
      fs.writeFileSync(desk('Same-bytes.png'), png(781));
      await savePresentation(f, 777);                        // bytes Crate already has: no new row
      await assertNotHeld(f);
      // Bytes equal to another existing row are deduplicated: no successor, no hold.
      await savePresentation(f, 900);                        // the original bytes return: re-armed, no new row
      assert.equal(f.stored(old).presentationChoiceSuperseded, undefined);
      await assertNotHeld(f);
    }));
  }
  // .pptx/.key are outside Crate's proven-rename domain (LOCAL_ADOBE_CONTINUATION_EXTENSIONS):
  // a renamed deck is not relocated. The hold is on the asset row, so it stays and stays clearable.
  baselineTest('presentation guard: a held row stays held and clearable when the presentation is renamed on disk', { timeout: 120000 }, () => withEnv(async () => {
    const f = await formatProject('.pptx');
    const old = 'Work-pptx — image1.png', fresh = 'Work-pptx — image1_1.png';
    await f.toggle(old);
    await savePresentation(f, 777);
    await assertHeld(f, [fresh], 'presentation-media-changed');
    await callIpcRaw('projects:pause', f.id); clearTrackedTimers();
    await metadataTestHooks.refreshWorkingSourceLocators(f.id);
    const destination = desk('Work-pptx-Moved.pptx');
    fs.renameSync(f.W, destination);
    await metadataTestHooks.refreshWorkingSourceLocators(f.id, [destination]);
    roundTripFakeStore();
    assert.equal(f.current().files.some(row => row.path === destination), false, 'not a proven rename for presentations (pre-existing)');
    assert.deepEqual(choiceReviewOf(f), [fresh]);
    assert.equal((await f.workspace()).workingSourceSelectionBlocked, true);
    await f.toggle(fresh);
    assert.deepEqual(choiceReviewOf(f), []);
  }));

  // The production renderer computes the Include All Existing button from the
  // workspace facts alone (no renderer change): enabled while existing assets
  // are withheld, disabled once the click includes them, enabled again after a
  // later exclusion withholds them.
  baselineTest('Include All Existing button state follows the workspace facts in the production renderer', { timeout: 120000 }, () => withEnv(async () => {
    const { loadProjectedWorkspace } = require('./opus-renderer-helpers'), vm = require('node:vm');
    const f = await formatProject('.ai');
    const button = async () => {
      const project = structuredClone(f.current()), workspace = await f.workspace();
      const ui = loadProjectedWorkspace(project, workspace);
      // Same inputs restoreAssetReviewBatchControls derives from the current workspace.
      ui.renderer.testFiles = workspace.files;
      vm.runInContext(`(() => { const existingAssets = testFiles.filter(file => file && file.assetOrigin === 'existing' && file.protectedSource !== true && file.projectRole !== 'source');
        updateAssetReviewBatchControls(testProject, existingAssets, existingAssets.filter(file => (typeof file.included === 'boolean' ? file.included : file.excluded !== true)).length); })()`, ui.renderer);
      const element = ui.elements['btn-include-all-existing'];
      return [element.disabled, element.textContent];
    };
    assert.deepEqual(await button(), [true, 'All Existing Included']);
    await f.select(f.W, 'exclude');
    assert.deepEqual(await button(), [false, 'Include All Existing'], 'withheld existing assets enable the button');
    await f.bulk('include');
    assert.deepEqual(await button(), [true, 'All Existing Included'], 'the click included them');
    await f.select(f.W, 'restore');
    assert.deepEqual(await button(), [true, 'All Existing Included']);
    await f.select(f.W, 'exclude');
    assert.deepEqual(await button(), [false, 'Include All Existing'], 'a later exclusion withholds them again');
  }));

  // A presentation changed while excluded (its saves are skipped): Restore
  // captures the current media through the save route, so the guard applies.
  for (const ext of ['.pptx', '.key']) for (const choice of ['exclude', 'include']) {
    baselineTest(`presentation guard ${ext}: media changed while excluded is held at Restore (${choice})`, { timeout: 120000 }, () => withEnv(async () => {
      const f = await formatProject(ext);
      const old = `Work-${f.tag} — ${mediaName(ext)}`, fresh = `Work-${f.tag} — ${changedName(ext)}`;
      if (choice === 'exclude') { await f.toggle(old); await f.select(f.W, 'exclude'); }
      else { await f.select(f.W, 'exclude'); await f.toggle(old); }
      writeWorking(ext, f.W, [desk(f.names.only), desk(f.names.shared)], 777);
      await metadataTestHooks.runScanOnSavePresentation(f.id, f.W);
      assert.equal(f.current().files.some(row => row.name === fresh), false, 'no row while excluded');
      await f.select(f.W, 'restore');
      await assertHeld(f, [fresh], 'presentation-media-changed');
      await f.toggle(fresh);
      await assertNotHeld(f);
    }));
  }

  // ---- Restore capture for presentations (deck changed or unchanged while excluded).
  // Gate the capture's archive listing once the Restore verification has published.
  const gateRestoreCapture = (f, deckPath) => {
    let release, entered = false; const gate = new Promise(resolve => { release = resolve; });
    setChildProcessHandler(request => {
      if (!entered && request.kind === 'execFile' && request.command === '/usr/bin/unzip' && request.args[0] === '-l' && request.args[1] === deckPath) {
        const row = f.current().files.find(file => file.path === deckPath);
        const key = row && metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.current(), row);
        if (f.current().workingSourceSelections?.[key]?.state === 'selected' && f.current().workingSourceVerification?.[key]?.status === 'scanned') {
          entered = true; return gate.then(() => passthroughInner(request));
        }
      }
      return passthroughInner(request);
    });
    return { entered: () => entered, release };
  };
  const restoreAsync = async (f, deckPath) => {
    const row = (await f.workspace()).files.find(file => file.name === path.basename(deckPath));
    return callIpcRaw('projects:set-working-source-selection', f.id, row.visualIdentity, { action: 'restore', expectedRevision: row.selectionRevision });
  };
  for (const ext of ['.pptx', '.key']) {
    baselineTest(`Restore capture ${ext}: unchanged media keeps per-asset Include and Exclude exactly; no hold`, { timeout: 120000 }, () => withEnv(async () => {
      const f = await formatProject(ext);
      const second = `Work-${f.tag} — ${ext === '.pptx' ? 'image2.png' : 'second-photo.png'}`, first = `Work-${f.tag} — ${mediaName(ext)}`;
      extraMediaSeed = 557; try { await savePresentation(f, 900); } finally { extraMediaSeed = 0; }
      await f.toggle(first);                                  // per-asset Exclude while selected
      await f.select(f.W, 'exclude');
      await f.toggle(second);                                 // per-asset Include while excluded
      const choices = () => [first, second].map(name => { const row = f.stored(name);
        return [row.keptAfterSourceExclusion ?? null, row.individualContentExclusion ?? null, row.individualContentInclude ?? null,
          (f.current().excludedAssetKeys || []).includes(row.fileId || row.path)]; });
      const before = JSON.stringify(choices());
      const token = (await f.review()).token; assert.ok(token);
      await f.select(f.W, 'restore');
      assert.equal(JSON.stringify(choices()), before, 'choices unchanged by the Restore capture');
      await assertNotHeld(f);
      assert.equal((await callIpcRaw('projects:package', f.id, desk('stale-out'), token)).error, 'package_review_stale');
      roundTripFakeStore();
      assert.equal(JSON.stringify(choices()), before);
      await f.select(f.W, 'exclude');
      assert.equal((await f.fact(second)).included, true, 'per-asset Include survives Restore and a later Exclude');
      assert.equal((await f.fact(first)).included, false);
      const review = await f.review();
      assert.deepEqual(await f.written(review), [...f.keepNames, second].sort(), 'written folder: only the kept media, nothing extracted from the excluded deck');
    }));
    baselineTest(`Restore capture ${ext}: Include All Existing during the exclusion is not turned into a lasting keep`, { timeout: 120000 }, () => withEnv(async () => {
      const f = await formatProject(ext);
      const media = `Work-${f.tag} — ${mediaName(ext)}`;
      await f.select(f.W, 'exclude');
      await f.bulk('include');
      const episode = JSON.stringify(f.stored(media).existingIncludeEpisode);
      assert.ok(f.stored(media).existingIncludeEpisode);
      await f.select(f.W, 'restore');
      assert.equal(JSON.stringify(f.stored(media).existingIncludeEpisode), episode);
      assert.equal(f.stored(media).keptAfterSourceExclusion, undefined);
      await f.select(f.W, 'exclude');
      assert.equal((await f.fact(media)).included, false, 'withheld again after a later Exclude');
      assert.deepEqual(await f.written(await f.review()), f.keepNames);
    }));
    baselineTest(`Restore capture ${ext}: a review while the capture runs issues no token; holds survive reload`, { timeout: 120000 }, () => withEnv(async () => {
      const f = await formatProject(ext);
      const old = `Work-${f.tag} — ${mediaName(ext)}`, fresh = `Work-${f.tag} — ${changedName(ext)}`;
      await f.select(f.W, 'exclude'); await f.toggle(old);
      writeWorking(ext, f.W, [desk(f.names.only), desk(f.names.shared)], 777);
      const gate = gateRestoreCapture(f, f.W);
      const restoring = restoreAsync(f, f.W);
      await waitForCondition(() => gate.entered(), 'Restore capture did not start', 20000);
      const during = await f.review();
      gate.release(); assert.equal((await restoring).success, true); passthrough();
      // Before the capture lists the new media, review planning already refuses it.
      assert.equal(during.materializable, false); assert.equal(during.token, undefined);
      assert.match(during.message, /cannot carry your earlier Include or Exclude/);
      await assertHeld(f, [fresh], 'presentation-media-changed');
      roundTripFakeStore();
      await assertHeld(f, [fresh], 'presentation-media-changed');
      assert.equal(f.stored(old).keptAfterSourceExclusion, true, 'the earlier Include stays on its own row');
      // No package path can write while held: review has no token and nothing is written.
      assert.equal(fs.existsSync(path.join(desk('held-out'))), false);
      await f.toggle(fresh); await f.toggle(fresh);          // Exclude, then Include: explicit Include
      await assertNotHeld(f);
      const review = await f.review();
      const written = await f.written(review);
      assert.deepEqual(written, f.reviewNames(review).filter(name => name !== path.basename(f.W)).concat(path.basename(f.W)).sort(), 'written folder matches review');
      assert.ok(written.includes(fresh) && written.includes(old));
    }));
    baselineTest(`Restore capture ${ext}: an Exclude landing during the capture withholds what it admits`, { timeout: 120000 }, () => withEnv(async () => {
      const f = await formatProject(ext);
      await f.select(f.W, 'exclude');
      extraMediaSeed = 559; try { writeWorking(ext, f.W, [desk(f.names.only), desk(f.names.shared)], 900); } finally { extraMediaSeed = 0; }
      const gate = gateRestoreCapture(f, f.W);
      const restoring = restoreAsync(f, f.W);
      await waitForCondition(() => gate.entered(), 'Restore capture did not start', 20000);
      const row = (await f.workspace()).files.find(file => file.name === path.basename(f.W));
      const excluded = callIpcRaw('projects:set-working-source-selection', f.id, row.visualIdentity, { action: 'exclude', expectedRevision: row.selectionRevision });
      gate.release(); await restoring; assert.equal((await excluded).success, true); passthrough();
      const added = f.current().files.filter(file => /image2|second-photo/.test(file.name || ''));
      assert.equal(added.length, 1); assert.deepEqual(added[0].dependencyOwners, [f.W]);
      assert.equal((await f.fact(added[0].name)).included, false, 'withheld with the excluded deck');
      assert.deepEqual(await f.written(await f.review()), f.keepNames);
      // A Restore that does not apply (stale revision) captures nothing.
      const before = JSON.stringify(f.current().files);
      writeWorking(ext, f.W, [desk(f.names.only), desk(f.names.shared)], 901);
      const stale = await callIpcRaw('projects:set-working-source-selection', f.id, row.visualIdentity, { action: 'restore', expectedRevision: row.selectionRevision });
      assert.equal(stale.success, false);
      assert.equal(JSON.stringify(f.current().files), before, 'no capture for a deck that is still excluded');
    }));
  }
  // Two decks share media bytes. One is excluded and restored; the other stays,
  // is excluded, or is restored, in both orders. An included deck always keeps it.
  for (const order of ['W-restored-first', 'D2-restored-first']) {
    baselineTest(`Restore capture: media shared by two decks (${order})`, { timeout: 120000 }, () => withEnv(async () => {
      const f = await formatProject('.pptx');
      const D2 = desk('Second.pptx');
      writeWorking('.pptx', D2, [], 900);
      await f.add(D2);
      await metadataTestHooks.runScanOnSavePresentation(f.id, D2);
      const original = 'Work-pptx — image1.png';
      assert.ok((f.stored(original).dependencyOwners || []).includes(D2), 'the second deck is recorded for the shared media');
      await f.select(f.W, 'exclude');
      assert.equal((await f.fact(original)).included, true, 'the included deck keeps the shared media');
      // New media added to both decks while W is excluded: D2's save sees it first, W's Restore second.
      extraMediaSeed = 560;
      try { writeWorking('.pptx', f.W, [desk(f.names.only), desk(f.names.shared)], 900); writeWorking('.pptx', D2, [], 900); } finally { extraMediaSeed = 0; }
      await metadataTestHooks.runScanOnSavePresentation(f.id, D2);
      const added = () => f.current().files.find(row => /image2/.test(row.name || ''));
      assert.deepEqual(added().dependencyOwners, [D2]);
      if (order === 'W-restored-first') {
        await f.select(f.W, 'restore');
        assert.deepEqual(added().dependencyOwners, [D2, f.W], 'the Restore capture records the restored deck');
        await f.select(D2, 'exclude');
        assert.equal((await f.fact(added().name)).included, true, 'kept by the restored deck');
        await f.select(f.W, 'exclude');
        assert.equal((await f.fact(added().name)).included, false, 'both decks excluded');
        await f.select(D2, 'restore');
        assert.equal((await f.fact(added().name)).included, true);
      } else {
        await f.select(D2, 'exclude');
        assert.equal((await f.fact(added().name)).included, false, 'both excluded: withheld');
        await f.select(D2, 'restore');
        assert.equal((await f.fact(added().name)).included, true);
        await f.select(f.W, 'restore');
        assert.deepEqual(added().dependencyOwners, [D2, f.W]);
        await f.select(D2, 'exclude');
        assert.equal((await f.fact(added().name)).included, true, 'kept by the restored deck');
      }
      assert.deepEqual(choiceReviewOf(f), [], 'no individual choice: no hold');
      const review = await f.review();
      assert.deepEqual(await f.written(review), f.reviewNames(review).slice().sort());
    }));
  }

  // ---- Paused project: a presentation changes while Crate is not capturing it.
  // Review planning fails closed when an individually chosen media row lost its
  // bytes and new media would be written; the pre-package scan then lists the
  // new media (held) so the per-asset control resolves it.
  const pausedDeck = async (ext, { decks = 1 } = {}) => {
    const f = await formatProject(ext);
    const D2 = desk('Second' + ext);
    if (decks === 2) { writeWorking(ext, D2, [], 900); await f.add(D2); await metadataTestHooks.runScanOnSavePresentation(f.id, D2); }
    return { ...f, D2, media: `Work-${f.tag} — ${mediaName(ext)}`, pause: async () => { await callIpcRaw('projects:pause', f.id); clearTrackedTimers(); },
      change: seed => writeWorking(ext, f.W, [desk(f.names.only), desk(f.names.shared)], seed) };
  };
  const heldNow = f => f.current().files.filter(row => row.individualChoiceReview !== undefined).map(row => row.name).sort();
  const assertClosedForChange = async (f, staleToken = null) => {
    const review = await f.review();
    assert.equal(review.materializable, false); assert.equal(review.token, undefined);
    assert.match(review.message, /cannot carry your earlier Include or Exclude/);
    // Without an existing hold, the changed deck itself is the unavailable entry.
    if (!heldNow(f).length) assert.equal(review.files.find(file => file.name === path.basename(f.W)).status, 'unavailable');
    if (staleToken) assert.ok(['package_review_stale', 'package_review_changed'].includes((await callIpcRaw('projects:package', f.id, desk('stale-out'), staleToken)).error));
    return review;
  };
  const prePackage = f => callIpcRaw('projects:pre-package-scan', f.id);
  // An engaged deck changed after its receipt is already refused (stale
  // verification); re-verify it to reach the choice guard.
  const staleThenReverify = async f => {
    const stale = await f.review();
    assert.equal(stale.materializable, false);
    assert.equal(stale.message, 'Working-source verification is unresolved. Resolve it before packaging.');
    await metadataTestHooks.runScanOnOpen(f.id, f.W, null, null, { verifySelectedSource: true });
  };
  for (const ext of ['.pptx', '.key']) {
    baselineTest(`paused deck ${ext}: an explicit Exclude whose picture changed fails closed, is listed by the pre-package scan and resolves per asset`, { timeout: 120000 }, () => withEnv(async () => {
      const f = await pausedDeck(ext);
      await f.toggle(f.media);                                        // explicit Exclude, deck selected
      await f.pause();
      const token = (await f.review()).token; assert.ok(token);
      f.change(777);
      await assertClosedForChange(f, token);
      roundTripFakeStore();
      await assertClosedForChange(f);
      await prePackage(f);
      const held = heldNow(f); assert.equal(held.length, 1);
      await assertHeld(f, held, 'presentation-media-changed');
      roundTripFakeStore();
      await assertHeld(f, held, 'presentation-media-changed');
      await prePackage(f);                                            // no second row, no double hold
      assert.deepEqual(heldNow(f), held);
      assert.equal(f.current().files.filter(row => /image|photo/.test(row.name || '')).length, 2);
      await f.toggle(held[0]);                                        // explicit Exclude of the new picture
      await assertNotHeld(f);
      const review = await f.review();
      const written = await f.written(review);
      assert.deepEqual(written, f.reviewNames(review));
      assert.equal(written.some(name => /image|photo/.test(name) && name !== f.media), false, 'the newly excluded picture is not written by any route');
    }));
    baselineTest(`paused deck ${ext}: an Include made while excluded, restored then changed while paused, again before and after resolution`, { timeout: 120000 }, () => withEnv(async () => {
      const f = await pausedDeck(ext);
      await f.select(f.W, 'exclude'); await f.toggle(f.media);       // Include marker
      await f.pause();
      f.change(777);
      assert.equal((await f.review()).materializable, true, 'an excluded deck is not packaged: nothing to guard');
      await f.select(f.W, 'restore');                                 // paused: no Restore capture
      await assertClosedForChange(f);
      await prePackage(f);
      const first = heldNow(f); assert.equal(first.length, 1);
      f.change(778);                                                  // a second change before resolution
      await staleThenReverify(f);
      await assertClosedForChange(f);
      await prePackage(f);
      const both = heldNow(f); assert.equal(both.length, 2); assert.ok(both.includes(first[0]));
      await f.select(f.W, 'exclude');                                 // Exclude/Restore keep the holds
      await assertHeld(f, both, 'presentation-media-changed');
      await f.select(f.W, 'restore');
      await assertHeld(f, both, 'presentation-media-changed');
      for (const name of both) { await f.toggle(name); await f.toggle(name); }   // Include both
      await assertNotHeld(f);
      f.change(779);                                                  // a further change after resolution
      await staleThenReverify(f);
      await assertClosedForChange(f);
      await prePackage(f);
      assert.equal(heldNow(f).length, 1);
      await f.toggle(heldNow(f)[0]);
      await assertNotHeld(f);
      const review = await f.review();
      assert.deepEqual(await f.written(review), f.reviewNames(review));
      assert.ok(f.reviewNames(review).includes(f.media), 'the old row is packaged by its own Include (Crate copy)');
    }));
    baselineTest(`paused deck ${ext}: never fires without a choice or while chosen bytes remain; watching does not double-hold`, { timeout: 120000 }, () => withEnv(async () => {
      const f = await pausedDeck(ext);
      await f.pause();
      f.change(777);                                                  // no choice anywhere
      await prePackage(f);
      assert.deepEqual(heldNow(f), []);
      let review = await f.review(); assert.equal(review.materializable, true);
      assert.deepEqual(await f.written(review), f.reviewNames(review));
      assert.equal(f.current().files.some(row => /_1\.png$/.test(row.name || '')), false, 'nothing captured for a deck without choices');
      // A chosen picture whose bytes are still in the deck: no trigger.
      const g = await pausedDeck(ext);
      await g.toggle(g.media);
      await g.pause();
      extraMediaSeed = 561; try { g.change(900); } finally { extraMediaSeed = 0; }
      await prePackage(g);
      assert.deepEqual(heldNow(g), []);
      assert.equal((await g.review()).materializable, true);
      // Watching: the save route holds once; the pre-package capture adds nothing.
      const h = await pausedDeck(ext);
      await h.toggle(h.media);
      await savePresentation(h, 777);
      const held = heldNow(h); assert.equal(held.length, 1);
      await prePackage(h);
      assert.deepEqual(heldNow(h), held);
    }));
  }
  baselineTest('paused deck: media shared by two decks; the changed deck alone is guarded', { timeout: 120000 }, () => withEnv(async () => {
    const f = await pausedDeck('.pptx', { decks: 2 });
    await f.toggle(f.media);                                          // explicit Exclude of the shared picture
    await f.pause();
    f.change(777);                                                    // W changes; Second.pptx still has the picture
    const review = await assertClosedForChange(f);
    assert.equal(review.files.find(file => file.name === 'Second.pptx').status, 'ready');
    await prePackage(f);
    const held = heldNow(f); assert.equal(held.length, 1);
    assert.deepEqual(f.stored(held[0]).dependencyOwners, [f.W]);
    await f.toggle(held[0]);
    await assertNotHeld(f);
    const settled = await f.review();
    const written = await f.written(settled);
    assert.deepEqual(written, f.reviewNames(settled).slice().sort());
    assert.equal(written.includes(held[0]), false, 'the new picture was excluded explicitly');
    assert.ok(written.includes('Second.pptx') && written.includes(path.basename(f.W)));
  }));

  // ---- Independent review regressions (frozen v1), kept as permanent tests.
  // Accepted trade-off (owner decision, round five): a recorded owner counts for
  // as long as it is a project file. If an included file stops linking an asset
  // it once recorded, the asset is retained and written (possibly a stale extra
  // file). No scan receipt retires the record.
  baselineTest('stale recorded owner (accepted trade-off): a still-present owner that stops linking the asset keeps it, and it is written', { timeout: 120000 }, () => withEnv(async () => {
    const f = await formatProject('.ai'); const x = desk(f.names.newLink);
    writeWorking('.ai', f.W, [desk(f.names.only), desk(f.names.shared), x]);
    writeWorking('.ai', f.K, [desk(f.names.keepOnly), desk(f.names.shared), x]);
    await callIpcRaw('projects:pre-package-scan', f.id);
    assert.deepEqual(f.stored(f.names.newLink).dependencyOwners, [f.W, f.K]);
    writeWorking('.ai', f.K, [desk(f.names.keepOnly), desk(f.names.shared)]);
    await callIpcRaw('projects:pre-package-scan', f.id);
    // Before K is re-verified its receipt is stale: K still counts (and packaging needs re-verification).
    await metadataTestHooks.runScanOnOpen(f.id, f.K, null, null, { verifySelectedSource: true });
    await f.select(f.W, 'exclude');
    const fact = await f.fact(f.names.newLink);
    assert.deepEqual([fact.included, fact.includedAsDependency, fact.excludedSourceOnly], [true, false, false], 'retained by the stale record, not required');
    const review = await f.review();
    assert.deepEqual(await f.written(review), [...f.keepNames, f.names.newLink].sort(), 'written folder: the stale extra file is written');
  }));
  baselineTest('review finding 1: live links accumulate both owners on an existing row and within one batch', { timeout: 120000 }, () => withEnv(async () => {
    for (const batch of ['separate', 'same-batch']) {
      const f = await newProject('Live legacy owners ' + batch);
      const W = desk('LiveW.indd'), K = desk('LiveK.indd'), X = desk('LiveShared.png');
      fs.writeFileSync(W, 'SYNTH W'); fs.writeFileSync(K, 'SYNTH K'); fs.writeFileSync(X, png(141));
      f.current().files = [W, K].map(p => ({ path: p, name: path.basename(p), ext: '.indd', source: 'manual-browse', projectRole: 'source', addedAt: Date.now() }));
      f.current().pendingFiles = []; f.current().assetBaseline = { schemaVersion: 1, status: 'legacy-included', decision: 'include', establishedAt: Date.now() }; roundTripFakeStore();
      const evidence = owner => ({ filePath: X, source: 'indd-poll', appFamily: 'indesign', relationshipSourcePath: owner, savedEvidence: true, documentModified: false, allowDirect: true, forcePending: false });
      if (batch === 'separate') { await metadataTestHooks.applyLiveAppEvidenceRefresh(f.id, [evidence(W)]); await metadataTestHooks.applyLiveAppEvidenceRefresh(f.id, [evidence(K)]); }
      else await metadataTestHooks.applyLiveAppEvidenceRefresh(f.id, [evidence(W), evidence(K)]);
      assert.deepEqual(f.stored('LiveShared.png').dependencyOwners, [W, K], batch);
      await f.select(W, 'exclude');
      assert.equal((await f.fact('LiveShared.png')).included, true, 'K still needs the shared link');
      const review = await f.review();
      assert.ok((await f.written(review)).includes('LiveShared.png'));
    }
  }, { realTmp: true }));
  baselineTest('review finding 4: a missing cached copy does not erase the choice review of changed media', { timeout: 120000 }, () => withEnv(async () => {
    const f = await formatProject('.pptx'); const old = 'Work-pptx — image1.png';
    await f.toggle(old); const oldPath = f.stored(old).path; fs.unlinkSync(oldPath);
    await savePresentation(f, 777);
    const review = await f.review();
    assert.equal(review.materializable, false, 'changed chosen media with unavailable old bytes must be reviewed');
    assert.equal(f.stored(old).path, oldPath, 'the old row keeps its own path');
    const held = choiceReviewOf(f); assert.equal(held.length, 1);
    assert.notEqual(f.current().files.find(row => row.name === held[0]).path, oldPath, 'the new media never reuses the old cache path');
    await f.toggle(held[0]);
    const after = await f.review();
    assert.equal(after.materializable, true);
    assert.equal((await f.written(after)).some(name => name === held[0]), false, 'the explicitly excluded new media is not written');
  }));
  baselineTest('review finding paused: a known paused presentation change is refused at review', { timeout: 120000 }, () => withEnv(async () => {
    const f = await formatProject('.pptx'); const old = 'Work-pptx — image1.png';
    await f.toggle(old); await callIpcRaw('projects:pause', f.id); clearTrackedTimers();
    writeWorking('.pptx', f.W, [desk(f.names.only), desk(f.names.shared)], 777);
    const review = await f.review();
    assert.equal(review.materializable, false, 'paused change with prior individual choice needs guard');
  }));
  baselineTest('review finding 2b: a live-owned placed file and what it links leave with the excluded file', { timeout: 120000 }, () => withEnv(async () => {
    const f = await newProject('Live chain'); const W = desk('ChainW.indd'), K = desk('ChainKeep.ai'), P = desk('ChainPlaced.ai'), X = desk('ChainDeep.png');
    fs.writeFileSync(W, 'SYNTH'); writeWorking('.ai', K, []); writeWorking('.ai', P, [X]); fs.writeFileSync(X, png(142));
    f.current().files = [W, K].map(p => ({ path: p, name: path.basename(p), ext: path.extname(p), source: 'manual-browse', projectRole: 'source', addedAt: Date.now() }));
    f.current().pendingFiles = []; f.current().assetBaseline = { schemaVersion: 1, status: 'legacy-included', decision: 'include', establishedAt: Date.now() }; roundTripFakeStore();
    await metadataTestHooks.applyLiveAppEvidenceRefresh(f.id, [{ filePath: P, source: 'indd-poll', appFamily: 'indesign', relationshipSourcePath: W, savedEvidence: true, documentModified: false, allowDirect: true, forcePending: false }]);
    await callIpcRaw('projects:pre-package-scan', f.id);
    await f.select(W, 'exclude');
    assert.equal((await f.fact('ChainPlaced.ai')).included, false);
    assert.equal((await f.fact('ChainDeep.png')).included, false, 'transitive descendant must leave');
    const review = await f.review();
    assert.deepEqual(await f.written(review), ['ChainKeep.ai']);
    await f.select(W, 'restore');
    for (const name of ['ChainPlaced.ai', 'ChainDeep.png']) assert.equal((await f.fact(name)).included, true, name + ' after Restore');
  }, { realTmp: true }));
  baselineTest('review finding 2a: a placed file kept by an included recorded owner keeps what it links', { timeout: 120000 }, () => withEnv(async () => {
    const f = await newProject('Legacy bridge'); const W = desk('BridgeW.indd'), K = desk('BridgeKeep.ai'), P = desk('BridgePlaced.ai'), X = desk('BridgeDeep.png');
    fs.writeFileSync(W, `SYNTH\n${P}\n`); writeWorking('.ai', K, [P]); writeWorking('.ai', P, [X]); fs.writeFileSync(X, png(143));
    inddDoc = W; await f.add(W);
    f.current().files.push({ path: K, name: path.basename(K), ext: '.ai', source: 'manual-browse', projectRole: 'source', addedAt: Date.now() }); roundTripFakeStore();
    await callIpcRaw('projects:pre-package-scan', f.id);
    await f.select(W, 'exclude');
    assert.equal((await f.fact('BridgePlaced.ai')).included, true);
    assert.equal((await f.fact('BridgeDeep.png')).included, true, 'included bridge must keep what it needs');
    const review = await f.review();
    assert.deepEqual(await f.written(review), ['BridgeDeep.png', 'BridgeKeep.ai', 'BridgePlaced.ai']);
  }, { realTmp: true }));
  baselineTest('review finding 3: an excluded InDesign file retained as a dependency still admits its saved links', { timeout: 120000 }, () => withEnv(async () => {
    const f = await newProject('Retained live'); const W = desk('RetainedW.indd'), K = desk('RetainedK.ai'), X = desk('RetainedLink.png');
    fs.writeFileSync(W, 'SYNTH'); writeWorking('.ai', K, [W]); fs.writeFileSync(X, png(144));
    f.current().files = [W, K].map(p => ({ path: p, name: path.basename(p), ext: path.extname(p), source: 'manual-browse', projectRole: 'source', addedAt: Date.now() }));
    f.current().pendingFiles = []; f.current().assetBaseline = { schemaVersion: 1, status: 'legacy-included', decision: 'include', establishedAt: Date.now() }; roundTripFakeStore();
    await metadataTestHooks.runScanOnOpen(f.id, K, null, null, { verifySelectedSource: true });
    await f.select(W, 'exclude'); assert.equal((await f.fact('RetainedW.indd')).includedAsDependency, true);
    await metadataTestHooks.applyLiveAppEvidenceRefresh(f.id, [{ filePath: X, source: 'indd-poll', appFamily: 'indesign', relationshipSourcePath: W, savedEvidence: true, documentModified: false, allowDirect: true, forcePending: false }]);
    const review = await f.review();
    assert.ok(f.reviewNames(review).includes('RetainedLink.png'), 'retained owner still needs its saved link');
    assert.ok((await f.written(review)).includes('RetainedLink.png'));
  }, { realTmp: true }));
  baselineTest('review finding 6: more than 64 excluded owners never turn Include All Existing into a lasting keep', { timeout: 180000 }, () => withEnv(async () => {
    const f = await newProject('Many roots'); const X = desk('Shared65.png'); fs.writeFileSync(X, png(145));
    const roots = Array.from({ length: 65 }, (_, i) => desk(`Root-${i}.ai`)); roots.forEach(p => writeWorking('.ai', p, [X]));
    f.current().files = roots.map(p => ({ path: p, name: path.basename(p), ext: '.ai', source: 'manual-browse', projectRole: 'source', addedAt: Date.now() }));
    f.current().pendingFiles = []; f.current().assetBaseline = { schemaVersion: 1, status: 'legacy-included', decision: 'include', establishedAt: Date.now() }; roundTripFakeStore();
    for (const p of roots) await metadataTestHooks.runScanOnOpen(f.id, p, null, null, { verifySelectedSource: true });
    for (const p of roots) await f.select(p, 'exclude');
    assert.equal((await f.fact('Shared65.png')).included, false);
    await f.bulk('include'); assert.equal((await f.fact('Shared65.png')).included, true, 'kept for the current exclusion');
    const episode = f.stored('Shared65.png').existingIncludeEpisode;
    assert.equal(episode.ownerCount, 65); assert.match(episode.ownersDigest, /^[a-f0-9]{64}$/); assert.equal(episode.owners, undefined);
    assert.equal(f.stored('Shared65.png').keptAfterSourceExclusion, undefined, 'no lasting per-asset keep');
    roundTripFakeStore(); assert.equal((await f.fact('Shared65.png')).included, true, 'after reload');
    await f.select(roots[0], 'restore'); await f.select(roots[0], 'exclude');
    assert.equal((await f.fact('Shared65.png')).included, false, 'a newer exclusion must end the bulk episode');
    const keep = desk('Keep65w.ai'); writeWorking('.ai', keep, []);
    f.current().files.push({ path: keep, name: 'Keep65w.ai', ext: '.ai', source: 'manual-browse', projectRole: 'source', addedAt: Date.now() }); roundTripFakeStore();
    assert.deepEqual(await f.written(await f.review()), ['Keep65w.ai'], 'written folder: the asset is not packaged');
  }));

  // ---- Second review finding A: byte equality never makes a deck the owner of another asset.
  for (const scope of [undefined, 'entire-file']) {
    baselineTest(`presentation bytes equal to a Figma capture (${scope || 'current-page'}): the Figma row takes no deck owner`, { timeout: 120000 }, () => withEnv(async () => {
      const f = await formatProject('.key', { scope });
      const logo = desk('Logo.png'); fs.writeFileSync(logo, png(901));
      f.current().files.push({ path: logo, name: 'Logo.png', ext: '.png', source: 'figma-auto', projectRole: 'asset', assetOrigin: 'added', addedAt: Date.now() });
      roundTripFakeStore();
      const before = (await f.fact('Logo.png')).included;            // Figma scope decides this, unchanged by the candidate
      extraMediaSeed = 901; try { await savePresentation(f, 900); } finally { extraMediaSeed = 0; }
      assert.equal(f.stored('Logo.png').dependencyOwners, undefined, 'no recorded owner on a Figma capture');
      await f.select(f.W, 'exclude');
      const logoFact = await f.fact('Logo.png');
      assert.deepEqual([logoFact.included, logoFact.excludedSourceOnly], [before, false], 'excluding the deck does not change the Figma row');
      const review = await f.review();
      assert.equal(f.reviewNames(review).includes('Logo.png'), before);
      assert.equal((await f.written(review)).includes('Logo.png'), before, 'written folder follows the Figma scope, not the deck');
    }));
  }
  baselineTest('presentation bytes equal to a Photoshop link: the deck does not become its owner', { timeout: 120000 }, () => withEnv(async () => {
    const f = await formatProject('.psd');
    const deck = desk('Deck.key'); writeWorking('.key', deck, [], 11);             // embeds the same bytes as Solo-psd.png
    await f.add(deck);
    await metadataTestHooks.runScanOnSavePresentation(f.id, deck);
    assert.equal((f.stored(f.names.only).dependencyOwners || []).includes(deck), false, 'the deck is not recorded on the linked file');
    await f.select(f.W, 'exclude');
    assert.equal((await f.fact(f.names.only)).included, false, 'withheld with the only Photoshop file that links it');
    const written = await f.written(await f.review());
    assert.equal(written.includes(f.names.only), false, 'written folder: the excluded file\'s link is not packaged');
    assert.ok(written.includes('Deck.key'));
  }, { realMainPsd: true }));
  baselineTest('pre-existing ownerless rows stay kept after their working file is excluded (keep on no knowledge)', { timeout: 120000 }, () => withEnv(async () => {
    const f = await formatProject('.ai');
    const old = desk('OldLinked.png'); fs.writeFileSync(old, png(77));
    f.current().files.push({ path: old, name: 'OldLinked.png', ext: '.png', source: 'linked-asset', projectRole: 'asset', assetOrigin: 'added', addedAt: Date.now() });
    roundTripFakeStore();
    writeWorking('.ai', f.W, [desk(f.names.only), desk(f.names.shared), old]);   // W links it, but W is now excluded and not rescanned
    await f.select(f.W, 'exclude');
    await callIpcRaw('projects:pre-package-scan', f.id);
    assert.equal(f.stored('OldLinked.png').dependencyOwners, undefined, 'the excluded file is not scanned, so no owner is backfilled');
    const fact = await f.fact('OldLinked.png');
    assert.deepEqual([fact.included, fact.excludedSourceOnly], [true, false], 'no ownership knowledge: kept');
  }));
  baselineTest('legacy PSD guard: a hold resolved as Include is packaged and written as reviewed', { timeout: 120000 }, async () => {
    const f = await legacyPsdProject('guard-include-written');
    try {
      await f.save([objA, objB]);
      await f.toggle('Obj-A.png');                                  // Exclude
      await f.save([objB, { name: 'A2.png', data: png(77) }]);
      await assertHeld(f, ['A2.png'], 'psd-embedded-restaged');
      await f.toggle('A2.png'); await f.toggle('A2.png');           // Exclude, then Include
      assert.equal((await f.fact('A2.png')).included, true);
      await assertNotHeld(f);
      const review = await f.review();
      assert.deepEqual(f.reviewNames(review), ['A2.png', 'Keep.ai', 'Legacy.psd', 'Obj-B.png']);
      assert.deepEqual(await f.written(review), ['A2.png', 'Keep.ai', 'Legacy.psd', 'Obj-B.png'], 'written folder matches review: A2 (Include) written');
    } finally { currentPsdFixture = { children: [], linkedFiles: [] }; clearTrackedTimers(); }
  });

  // ==== Round 4 (owner-approved bounded round) ====
  // ---- Item 1: live InDesign admission is decided by the whole reported-owner set.
  // Records come from the production parsers (parseInDesignActiveSessionOutput,
  // createInDesignLiveEvidenceRecords) for saved, unmodified documents.
  async function inddProject(label, names) {
    const f = await newProject(label);
    const docs = names.map(name => desk(name)), X = desk('Mixed.png');
    for (const doc of docs) fs.writeFileSync(doc, 'SYNTH');
    fs.writeFileSync(X, png(144));
    f.current().files = docs.map(p => ({ path: p, name: path.basename(p), ext: path.extname(p), source: 'manual-browse', projectRole: 'source', addedAt: Date.now() }));
    f.current().pendingFiles = []; f.current().assetBaseline = { schemaVersion: 1, status: 'legacy-included', decision: 'include', establishedAt: Date.now() };
    roundTripFakeStore();
    return { f, docs, X };
  }
  const inddSnapshotOf = docs => docs.map(doc => `DOC\t${doc.path}\t${path.basename(doc.path)}\tfalse\t${doc.current ? 'true' : 'false'}\t${doc.links.length}\n` +
    doc.links.map(link => `LINK\t${doc.path}\t${path.basename(doc.path)}\t${link}\tfalse\t${doc.current ? 'true' : 'false'}`).join('\n')).join('\n') + '\n';
  const refreshFromDocuments = async (f, docs) => {
    const active = metadataTestHooks.parseInDesignActiveSessionOutput(inddSnapshotOf(docs));
    const records = metadataTestHooks.createInDesignLiveEvidenceRecords(f.id, active, f.current());
    assert.ok(records.some(record => record.source === 'indd-poll'), 'the parser produced link records');
    await metadataTestHooks.applyLiveAppEvidenceRefresh(f.id, records);
  };
  const where = (f, filePath) => f.current().files.some(row => row.path === filePath) ? 'files'
    : (f.current().pendingFiles || []).some(row => row.path === filePath) ? 'pending' : 'none';
  for (const order of ['excluded-first', 'included-first']) {
    baselineTest(`live InDesign mixed owners (${order}): an included reporter admits the shared link`, { timeout: 120000 }, () => withEnv(async () => {
      const { f, docs: [W, K], X } = await inddProject('Mixed ' + order, ['MixedW.indd', 'MixedK.indd']);
      await f.select(W, 'exclude');
      const batch = [{ path: W, current: false, links: [X] }, { path: K, current: true, links: [X] }];
      await refreshFromDocuments(f, order === 'excluded-first' ? batch : batch.slice().reverse());
      assert.equal(where(f, X), 'files');
      assert.deepEqual(f.stored('Mixed.png').dependencyOwners.slice().sort(), [W, K].sort(), 'every owner recorded');
      await refreshFromDocuments(f, batch);                           // repeated batch (before packaging ends Watch)
      assert.equal(f.current().files.filter(row => row.path === X).length, 1);
      roundTripFakeStore();
      const review = await f.review();
      assert.deepEqual(await f.written(review), ['Mixed.png', 'MixedK.indd'], 'after reload');
      await f.select(K, 'exclude');                                    // now every owner is excluded
      assert.equal((await f.fact('Mixed.png')).included, false);
    }, { realTmp: true }));
  }
  baselineTest('live InDesign mixed owners: both excluded stays pending; both included admits', { timeout: 120000 }, () => withEnv(async () => {
    const a = await inddProject('Both excluded', ['MixedW.indd', 'MixedK.indd']);
    await a.f.select(a.docs[0], 'exclude'); await a.f.select(a.docs[1], 'exclude');
    await refreshFromDocuments(a.f, [{ path: a.docs[0], current: false, links: [a.X] }, { path: a.docs[1], current: true, links: [a.X] }]);
    assert.equal(where(a.f, a.X), 'pending');
    const refused = await a.f.review();
    assert.equal(refused.materializable, false); assert.equal(refused.message, 'No files are selected for packaging.');
    const b = await inddProject('Both included', ['MixedW.indd', 'MixedK.indd']);
    await refreshFromDocuments(b.f, [{ path: b.docs[0], current: false, links: [b.X] }, { path: b.docs[1], current: true, links: [b.X] }]);
    assert.equal(where(b.f, b.X), 'files');
    assert.deepEqual(await b.f.written(await b.f.review()), ['Mixed.png', 'MixedK.indd', 'MixedW.indd']);
  }, { realTmp: true }));
  baselineTest('live InDesign mixed owners: an excluded reporter retained by an included file admits', { timeout: 120000 }, () => withEnv(async () => {
    const f = await newProject('Retained reporter'); const W = desk('RetainedW.indd'), K = desk('RetainedK.ai'), E2 = desk('OtherExcluded.indd'), X = desk('Mixed.png');
    fs.writeFileSync(W, 'SYNTH'); fs.writeFileSync(E2, 'SYNTH'); writeWorking('.ai', K, [W]); fs.writeFileSync(X, png(144));
    f.current().files = [W, K, E2].map(p => ({ path: p, name: path.basename(p), ext: path.extname(p), source: 'manual-browse', projectRole: 'source', addedAt: Date.now() }));
    f.current().pendingFiles = []; f.current().assetBaseline = { schemaVersion: 1, status: 'legacy-included', decision: 'include', establishedAt: Date.now() }; roundTripFakeStore();
    await metadataTestHooks.runScanOnOpen(f.id, K, null, null, { verifySelectedSource: true });
    await f.select(W, 'exclude'); await f.select(E2, 'exclude');
    assert.equal((await f.fact('RetainedW.indd')).includedAsDependency, true);
    await refreshFromDocuments(f, [{ path: E2, current: false, links: [X] }, { path: W, current: true, links: [X] }]);
    assert.equal(where(f, X), 'files');
    const written = await f.written(await f.review());
    assert.ok(written.includes('Mixed.png') && written.includes('RetainedW.indd') && written.includes('RetainedK.ai'));
  }, { realTmp: true }));
  baselineTest('live InDesign mixed owners: separate batches, three owners and an existing row', { timeout: 120000 }, () => withEnv(async () => {
    // Separate batches: excluded-only stays pending; a later included-only batch promotes and writes it.
    const s = await inddProject('Separate', ['MixedW.indd', 'MixedK.indd']);
    await s.f.select(s.docs[0], 'exclude');
    await refreshFromDocuments(s.f, [{ path: s.docs[0], current: true, links: [s.X] }]);
    assert.equal(where(s.f, s.X), 'pending');
    const pendingReview = await s.f.review();
    assert.deepEqual(s.f.reviewNames(pendingReview), ['MixedK.indd'], 'a pending link is not in the package');
    await refreshFromDocuments(s.f, [{ path: s.docs[0], current: true, links: [s.X] }]);    // repeated excluded-only batch
    assert.equal(where(s.f, s.X), 'pending');
    await refreshFromDocuments(s.f, [{ path: s.docs[1], current: true, links: [s.X] }]);
    assert.equal(where(s.f, s.X), 'files');
    assert.deepEqual(await s.f.written(await s.f.review()), ['Mixed.png', 'MixedK.indd']);
    // Three owners: any order with an included reporter admits; all excluded stays pending.
    // The included reporter is first, middle or last in the batch (T1, T2, T3 always reported in that order).
    for (const [label, included, expected] of [['included first', 0, 'files'], ['included middle', 1, 'files'], ['included last', 2, 'files'], ['all excluded', -1, 'pending']]) {
      const t = await inddProject('Three ' + label, ['T1.indd', 'T2.indd', 'T3.indd']);
      for (const index of [0, 1, 2]) if (index !== included) await t.f.select(t.docs[index], 'exclude');
      await refreshFromDocuments(t.f, [0, 1, 2].map(index => ({ path: t.docs[index], current: index === 2, links: [t.X] })));
      assert.equal(where(t.f, t.X), expected, label);
      assert.equal((t.f.current().files.find(row => row.path === t.X) || t.f.current().pendingFiles.find(row => row.path === t.X)).dependencyOwners.length, 3);
      const review = await t.f.review();
      if (expected === 'files') assert.deepEqual(await t.f.written(review), ['Mixed.png', path.basename(t.docs[included])], label);
      else { assert.equal(review.materializable, false, label); assert.equal(review.message, 'No files are selected for packaging.'); }
    }
    // Existing row: X is already a row through K; an excluded W reports it later.
    const e = await inddProject('Existing', ['MixedW.indd', 'MixedK.indd']);
    assert.equal(where(e.f, e.X), 'none');
    await refreshFromDocuments(e.f, [{ path: e.docs[1], current: true, links: [e.X] }]);
    assert.equal(where(e.f, e.X), 'files');
    await e.f.select(e.docs[0], 'exclude');
    await refreshFromDocuments(e.f, [{ path: e.docs[0], current: true, links: [e.X] }]);
    assert.deepEqual(e.f.stored('Mixed.png').dependencyOwners.slice().sort(), [e.docs[0], e.docs[1]].sort());
    roundTripFakeStore();
    assert.deepEqual(await e.f.written(await e.f.review()), ['Mixed.png', 'MixedK.indd']);
  }, { realTmp: true }));

  // ---- Item 2: a resolved presentation choice never leaves a block with no row.
  const choiceNames = message => [...String(message || '').matchAll(/“([^”]+)”/g)].map(match => match[1]);
  // Invariant for every choice-review refusal: each named asset is a row the per-asset
  // toggle acts on, and acting on all of them clears the refusal.
  const assertRefusalResolvable = async f => {
    let review = await f.review();
    for (let round = 0; round < 4 && !review.materializable && /Include or Exclude/.test(review.message || ''); round++) {
      const names = choiceNames(review.message);
      assert.ok(names.length > 0, 'a choice-review refusal names the assets to choose: ' + review.message);
      for (const name of names) {
        assert.equal(f.current().files.filter(row => row.name === name).length, 1, `“${name}” is a row the toggle can act on`);
        await f.toggle(name);
      }
      review = await f.review();
      for (const name of names) assert.ok(!choiceNames(review.message).includes(name), `${name} no longer refused`);
    }
    assert.equal(review.materializable, true, review.message);
    return review;
  };
  for (const ext of ['.pptx', '.key']) for (const resolution of ['exclude', 'include']) {
    baselineTest(`paused deck ${ext}: after the hold is resolved as ${resolution}, later new media is written with the deck`, { timeout: 120000 }, () => withEnv(async () => {
      const f = await pausedDeck(ext);
      const extra = ext === '.pptx' ? 'image2.png' : 'second-photo.png';
      await f.toggle(f.media); await f.pause(); f.change(777);
      await prePackage(f);
      const held = heldNow(f); assert.equal(held.length, 1);
      await f.toggle(held[0]); if (resolution === 'include') await f.toggle(held[0]);
      await assertNotHeld(f);
      extraMediaSeed = 888; try { f.change(777); } finally { extraMediaSeed = 0; }   // B unchanged, add C
      await prePackage(f); await prePackage(f);
      assert.deepEqual(heldNow(f), [], 'no hold: nothing chosen was lost');
      let review = await f.review();
      assert.equal(review.materializable, true, review.message);
      let written = await f.written(review);
      assert.ok(written.some(name => matchName(name, extra)), 'the new media is written with the deck');
      assert.equal(written.includes(held[0]), resolution === 'include', 'B follows its explicit choice');
      roundTripFakeStore();
      assert.equal((await f.review()).materializable, true, 'after reload');
      // A second later addition.
      extraMediaSeed = 889; try { f.change(777); } finally { extraMediaSeed = 0; }   // C replaced by D: no chosen media lost
      await prePackage(f);
      assert.deepEqual(heldNow(f), []);
      assert.equal((await f.review()).materializable, true);
      // A later replacement of B itself holds again and is clearable. The same
      // capture also lists the unrelated new media, and nothing proves which new
      // media replaced B, so every new row of that capture is held.
      extraMediaSeed = 889; try { f.change(779); } finally { extraMediaSeed = 0; }
      await prePackage(f);
      assert.ok(heldNow(f).length >= 1, 'replacing B raises a hold');
      review = await assertRefusalResolvable(f);
      written = await f.written(review);
      assert.deepEqual(written, f.reviewNames(review).slice().sort());
      // Excluding the deck omits the deck and its media, except an explicit per-asset Include (durable).
      await f.select(f.W, 'exclude');
      assert.deepEqual(await f.written(await f.review()), [...f.keepNames, ...(resolution === 'include' ? [held[0]] : [])].sort());
    }));
  }
  for (const ext of ['.pptx', '.key']) {
    baselineTest(`watching deck ${ext}: a later addition after a resolved hold is written (reviewers' V3 CONTROL)`, { timeout: 120000 }, () => withEnv(async () => {
      const f = await pausedDeck(ext);
      const fresh = `Work-${f.tag} — ${changedName(ext)}`, extra = ext === '.pptx' ? 'image2.png' : 'second-photo.png';
      await f.toggle(f.media); await savePresentation(f, 777); await f.toggle(fresh); await f.pause();
      extraMediaSeed = 888; try { f.change(777); } finally { extraMediaSeed = 0; }
      await prePackage(f); await prePackage(f);
      const review = await f.review();
      assert.equal(review.materializable, true, 'all earlier changes resolved and currently chosen bytes remain; new unrelated media needs no hold');
      assert.ok((await f.written(review)).some(name => matchName(name, extra)));
    }));
    baselineTest(`paused deck ${ext}: a deck with no individual choice and a second deck sharing media never refuse`, { timeout: 120000 }, () => withEnv(async () => {
      const f = await pausedDeck(ext, { decks: 2 });
      await f.pause();
      extraMediaSeed = 888; try { f.change(777); } finally { extraMediaSeed = 0; }
      await prePackage(f);
      assert.deepEqual(heldNow(f), []);
      const review = await f.review(); assert.equal(review.materializable, true);
      const written = await f.written(review);
      assert.ok(written.includes(path.basename(f.D2)) && written.includes(path.basename(f.W)));
    }));
  }
  baselineTest('choice-review invariant: every refusal names rows the per-asset toggle clears', { timeout: 180000 }, () => withEnv(async () => {
    for (const ext of ['.pptx', '.key']) {
      // Paused change after an Exclude, reviewed without a pre-package scan.
      const a = await pausedDeck(ext); await a.toggle(a.media); await a.pause(); a.change(777);
      const refused = await a.review(); assert.equal(refused.materializable, false);
      await assertRefusalResolvable(a);
      // Watching save, missing cache, second change before resolution.
      const b = await pausedDeck(ext); await b.toggle(b.media); fs.unlinkSync(b.stored(b.media).path);
      await savePresentation(b, 777); await savePresentation(b, 778);
      await assertRefusalResolvable(b);
      // Paused, two changes, repeated pre-package and review.
      const c = await pausedDeck(ext); await c.select(c.W, 'exclude'); await c.toggle(c.media); await c.pause(); await c.select(c.W, 'restore');
      c.change(777); await prePackage(c); c.change(778); await metadataTestHooks.runScanOnOpen(c.id, c.W, null, null, { verifySelectedSource: true }); await prePackage(c);
      await assertRefusalResolvable(c);
    }
  }));

  // ---- Item 4a: a receipt never disproves an owner its reader cannot see.
  baselineTest('receipt incompleteness: an IDML link seen only by the raw-bytes pass keeps its included owner', { timeout: 120000 }, () => withEnv(async () => {
    const f = await formatProject('.ai'); const X = desk(f.names.newLink);
    const K2 = desk('Keep2.idml');
    // Stored archive: the XML the IDML reader parses has no link; a non-XML entry names X.
    zipDir(K2, { 'designmap.xml': '<Document></Document>', 'META-INF/notes.txt': X }, true);
    writeWorking('.ai', f.W, [desk(f.names.only), desk(f.names.shared), X]);
    await f.add(K2);
    await prePackage(f);
    assert.ok(f.stored(f.names.newLink).dependencyOwners.includes(K2), 'the raw-bytes pass records the Affinity file');
    await metadataTestHooks.runScanOnOpen(f.id, K2, null, null, { verifySelectedSource: true });
    const receipt = metadataTestHooks.getWorkingSourceVerification(f.current(), f.current().files.find(row => row.path === K2));
    assert.equal(receipt.status, 'scanned');
    assert.equal(receipt.requiredReferences.some(ref => ref.path === X), false, 'the ordinary IDML reader does not see it');
    await f.select(f.W, 'exclude');
    assert.equal((await f.fact(f.names.newLink)).included, true, 'kept: the receipt cannot disprove what its reader does not read');
    assert.ok((await f.written(await f.review())).includes(f.names.newLink));
  }));
  // Round five: a recorded owner is never retired by a scan receipt, whatever
  // route recorded it (accepted trade-off: possibly stale extra files are kept).
  for (const route of ['live', 'regex']) {
    baselineTest(`recorded owner never retired by a receipt: an owner recorded by the ${route} route keeps the asset its clean receipt omits`, { timeout: 120000 }, () => withEnv(async () => {
      const f = await formatProject('.ai'); const X = desk(f.names.newLink);
      writeWorking('.ai', f.W, [desk(f.names.only), desk(f.names.shared), X]);
      await prePackage(f);
      await metadataTestHooks.runScanOnOpen(f.id, f.K, null, null, { verifySelectedSource: true });
      assert.equal(metadataTestHooks.getWorkingSourceVerification(f.current(), f.current().files.find(row => row.path === f.K)).status, 'scanned');
      const row = f.current().files.find(item => item.path === X);
      row.dependencyOwners = [f.W, f.K];
      if (route === 'live') row.dependencyOwnerRoutes = { [f.W]: ['regex'], [f.K]: ['live'] };   // an older v4 field, now ignored
      roundTripFakeStore();
      await f.select(f.W, 'exclude');
      assert.equal((await f.fact(f.names.newLink)).included, true);
      assert.ok((await f.written(await f.review())).includes(f.names.newLink));
    }));
  }

  // ---- Item 4b: the >64-owner episode follows a proven rename of an owner.
  baselineTest('Include All Existing above 64 owners survives a proven owner rename and ends at the next exclusion', { timeout: 240000 }, () => withEnv(async () => {
    const f = await newProject('Many roots rename'); const X = desk('Shared65.png'); fs.writeFileSync(X, png(145));
    const keep = desk('Keep65.ai'); writeWorking('.ai', keep, []);
    const roots = Array.from({ length: 65 }, (_, i) => desk(`Root-${i}.ai`)); roots.forEach(p => writeWorking('.ai', p, [X]));
    f.current().files = [...roots, keep].map(p => ({ path: p, name: path.basename(p), ext: '.ai', source: 'manual-browse', projectRole: 'source', addedAt: Date.now() }));
    f.current().pendingFiles = []; f.current().assetBaseline = { schemaVersion: 1, status: 'legacy-included', decision: 'include', establishedAt: Date.now() }; roundTripFakeStore();
    for (const p of roots) await metadataTestHooks.runScanOnOpen(f.id, p, null, null, { verifySelectedSource: true });
    for (const p of roots) await f.select(p, 'exclude');
    await f.bulk('include');
    assert.equal(f.stored('Shared65.png').existingIncludeEpisode.ownerCount, 65);
    await callIpcRaw('projects:pause', f.id); clearTrackedTimers();
    await metadataTestHooks.refreshWorkingSourceLocators(f.id);
    const moved = desk('Root-7-Moved.ai'), inode = fs.statSync(roots[7]).ino;
    fs.renameSync(roots[7], moved); assert.equal(fs.statSync(moved).ino, inode);
    await metadataTestHooks.refreshWorkingSourceLocators(f.id, [moved]);
    assert.ok(f.current().files.some(row => row.path === moved), 'proven rename');
    assert.equal((await f.fact('Shared65.png')).included, true, 'the same exclusion is still current after the rename');
    roundTripFakeStore();
    assert.equal((await f.fact('Shared65.png')).included, true, 'after reload');
    assert.deepEqual(await f.written(await f.review()), ['Keep65.ai', 'Shared65.png']);
    await f.select(moved, 'restore'); await f.select(moved, 'exclude');
    assert.equal((await f.fact('Shared65.png')).included, false, 'the next exclusion ends it');
    assert.equal(f.stored('Shared65.png').keptAfterSourceExclusion, undefined);
    assert.deepEqual(await f.written(await f.review()), ['Keep65.ai']);
  }));

  // ---- Item 3: counted cost of one membership call; owner work is linear.
  baselineTest('membership cost: recorded-owner work adds linear, not assets-times-references, operations', { timeout: 300000 }, () => withEnv(async () => {
    const measure = (project, stripOwners) => {
      const p = structuredClone(project);
      if (stripOwners) for (const row of p.files) { delete row.dependencyOwners; delete row.dependencyOwnerRoutes; }
      let realpaths = 0, stats = 0, receiptLookups = 0;
      const verification = p.workingSourceVerification || {};
      p.workingSourceVerification = new Proxy(verification, { get(target, key, receiver) { if (typeof key === 'string' && /^[a-f0-9]{64}$/.test(key)) receiptLookups++; return Reflect.get(target, key, receiver); } });
      const orig = fs.realpathSync.native, origStat = fs.statSync;
      fs.realpathSync.native = function (...args) { realpaths++; return orig.apply(this, args); };
      fs.statSync = function (...args) { stats++; return origStat.apply(this, args); };
      let facts; try { facts = metadataTestHooks.getWorkingSourceMembership(p).facts; } finally { fs.realpathSync.native = orig; fs.statSync = origStat; }
      return { realpaths, stats, receiptLookups, included: [...facts.values()].filter(fact => fact.included).length };
    };
    for (const count of [100, 200, 400]) {
      const f = await newProject('cost ' + count), W = desk('Cost.ai'), K = desk('Excluded.ai');
      const paths = Array.from({ length: count }, (_, i) => desk('Cost-' + i + '.png'));
      paths.forEach(p => fs.writeFileSync(p, png(13))); writeWorking('.ai', W, paths); writeWorking('.ai', K, []);
      f.current().files = [W, K].map(p => ({ path: p, name: path.basename(p), ext: '.ai', source: 'manual-browse', projectRole: 'source', addedAt: Date.now() }));
      f.current().pendingFiles = []; f.current().assetBaseline = { schemaVersion: 1, status: 'legacy-included', decision: 'include', establishedAt: Date.now() }; roundTripFakeStore();
      await metadataTestHooks.runScanOnOpen(f.id, W, null, null, { verifySelectedSource: true }); await prePackage(f); await f.select(K, 'exclude');
      assert.ok(f.current().files.filter(row => paths.includes(row.path)).every(row => row.dependencyOwners?.includes(W)), 'every asset records its owner');
      const withOwners = measure(f.current(), false), without = measure(f.current(), true);
      assert.equal(withOwners.included, without.included, 'same membership result');
      assert.ok(withOwners.realpaths - without.realpaths <= 5 * count + 16, JSON.stringify({ count, withOwners, without }));
      assert.ok(withOwners.stats - without.stats <= 2, JSON.stringify({ count, withOwners, without }));
      assert.ok(withOwners.receiptLookups - without.receiptLookups <= 2, JSON.stringify({ count, withOwners, without }));
    }
  }));

  // ==== Round five: receipt-based owner retirement removed ====
  const legacyRoots5 = (f, files) => {
    f.current().files = files.map(p => ({ path: p, name: path.basename(p), ext: path.extname(p), source: 'manual-browse', projectRole: 'source', addedAt: Date.now() }));
    f.current().pendingFiles = []; f.current().assetBaseline = { schemaVersion: 1, status: 'legacy-included', decision: 'include', establishedAt: Date.now() };
    roundTripFakeStore();
  };
  const inddLink = async (f, doc, links, current = true) => {
    const active = metadataTestHooks.parseInDesignActiveSessionOutput(`DOC\t${doc}\t${path.basename(doc)}\tfalse\t${current}\t${links.length}\n` +
      links.map(link => `LINK\t${doc}\t${path.basename(doc)}\t${link}\tfalse\t${current}\n`).join('') + `END\t1\t${links.length}\t${links.length}\t0\n`);
    await metadataTestHooks.applyLiveAppEvidenceRefresh(f.id, metadataTestHooks.createInDesignLiveEvidenceRecords(f.id, active, f.current()));
  };

  // ---- Reviewer regression 1 (first reviewer, round four): reader disagreement.
  for (const ext of ['.ai', '.pdf', '.afdesign']) {
    baselineTest(`round-five regression: a raw-route owner is not retired by a lazy ordinary receipt (${ext})`, { timeout: 120000 }, () => withEnv(async () => {
      const f = await newProject('Raw reader ' + ext), W = desk('Excluded.ai'), K = desk('Included' + ext), X = desk('Picture.png.final.png'), short = desk('Picture.png');
      fs.writeFileSync(X, png(901)); fs.writeFileSync(short, png(902));
      writeWorking('.ai', W, [X]); if (ext === '.afdesign') zipDir(K, { 'doc.xml': '<r p="' + X + '"/>' }, true); else writeWorking(ext, K, [X]);
      legacyRoots5(f, [W, K]);
      await prePackage(f);
      await metadataTestHooks.runScanOnOpen(f.id, K, null, null, { verifySelectedSource: true });
      const receipt = metadataTestHooks.getWorkingSourceVerification(f.current(), f.current().files.find(r => r.path === K));
      assert.equal(receipt.status, 'scanned'); assert.equal(receipt.unresolved.length, 0);
      assert.ok(receipt.requiredReferences.some(r => r.path === short)); assert.ok(!receipt.requiredReferences.some(r => r.path === X));
      await f.select(W, 'exclude');
      assert.deepEqual(await f.written(await f.review()), ['Included' + ext, 'Picture.png', 'Picture.png.final.png'].sort(),
        'included file still links the full filename found by the raw route');
    }));
  }
  // ---- Reviewer regression 2 (first reviewer): an older untagged owner note observed again.
  baselineTest('round-five regression: an older owner note observed again is not retired', { timeout: 120000 }, () => withEnv(async () => {
    const f = await formatProject('.ai'), X = desk(f.names.newLink);
    writeWorking('.ai', f.W, [desk(f.names.only), desk(f.names.shared), X]);
    writeWorking('.ai', f.K, [desk(f.names.keepOnly), desk(f.names.shared), X]);
    await prePackage(f);
    delete f.current().files.find(r => r.path === X).dependencyOwnerRoutes; roundTripFakeStore();   // as the reviewer did (no-op now)
    await prePackage(f);                                                                             // observed again
    assert.equal(f.stored(f.names.newLink).dependencyOwnerRoutes, undefined, 'no route field is written');
    writeWorking('.ai', f.K, [desk(f.names.keepOnly), desk(f.names.shared)]);
    await metadataTestHooks.runScanOnOpen(f.id, f.K, null, null, { verifySelectedSource: true });
    await f.select(f.W, 'exclude');
    assert.equal((await f.fact(f.names.newLink)).included, true);
    assert.ok((await f.written(await f.review())).includes('Fresh-ai.png'));
  }));
  // ---- Reviewer regression 3 (second reviewer): Shot.png.copy.png with a live excluded owner.
  async function shotProject(label, { keepExt = '.ai', excludedLive = true, route = 'regex' } = {}) {
    const f = await newProject(label);
    const short = desk('Shot.png'), long = desk('Shot.png.copy.png'), K = desk('KeepG' + keepExt), W = desk('WorkG.indd');
    fs.writeFileSync(short, png(21)); fs.writeFileSync(long, png(22)); fs.writeFileSync(W, 'SYNTH');
    if (keepExt === '.afdesign') zipDir(K, { 'doc.xml': `<doc><r p="${long}"/></doc>` }, true); else fs.writeFileSync(K, `%PDF-1.7\n${long}\n%%EOF\n`);
    legacyRoots5(f, excludedLive ? [K, W] : [K]);
    if (excludedLive) await f.select(W, 'exclude');
    if (route === 'snapshot') {
      setChildProcessHandler(request => {
        if (request.kind === 'execFile' && request.command === '/bin/ps') return { stdout: '444 /Applications/Adobe Illustrator.app/Contents/MacOS/Adobe Illustrator\n' };
        if (request.kind === 'execFile' && request.command === '/usr/sbin/lsof') return { stdout: `p444\nf14\ntREG\nn${K}\n` };
        return passthroughInner(request);
      });
      await callIpcRaw('projects:pause', f.id); clearTrackedTimers();
      await callIpcRaw('projects:start-watching', f.id);
      await metadataTestHooks.waitForWatcherIdle(f.id).catch(() => null);
      passthrough();
    } else await prePackage(f);
    assert.ok((f.anyRowAt(long)[0]?.dependencyOwners || []).includes(K), route + ' records the included owner');
    await metadataTestHooks.runScanOnOpen(f.id, K, null, null, { verifySelectedSource: true });
    if (excludedLive) await inddLink(f, W, [long]);
    return { f, short, long, K, W };
  }
  for (const [keepExt, route] of [['.ai', 'regex'], ['.afdesign', 'regex'], ['.ai', 'snapshot']]) {
    baselineTest(`round-five regression: an included ${keepExt} ${route} owner of Shot.png.copy.png is not retired when an excluded InDesign file reports it`, { timeout: 120000 }, () => withEnv(async () => {
      const { f, long, K } = await shotProject('Shot ' + keepExt + ' ' + route, { keepExt, route });
      const receipt = metadataTestHooks.getWorkingSourceVerification(f.current(), f.current().files.find(r => r.path === K));
      assert.equal(receipt.status, 'scanned'); assert.ok(!receipt.requiredReferences.some(r => r.path === long));
      if (route === 'snapshot') { await callIpcRaw('projects:pause', f.id); clearTrackedTimers(); }
      const fact = await f.fact('Shot.png.copy.png');
      assert.equal(fact.included, true); assert.equal(fact.excludedSourceOnly, false);
      assert.deepEqual(await f.written(await f.review()), [path.basename(K), 'Shot.png', 'Shot.png.copy.png'].sort());
    }, { realTmp: true }));
  }
  baselineTest('round-five bounding controls: included owner alone, an agreed path, a live-only owner, an IDML regex owner', { timeout: 180000 }, () => withEnv(async () => {
    const solo = await shotProject('Shot solo', { excludedLive: false });
    assert.deepEqual(await solo.f.written(await solo.f.review()), ['KeepG.ai', 'Shot.png', 'Shot.png.copy.png']);
    // Agreed path both grammars name, shared with an excluded InDesign file.
    const a = await newProject('Agreed'); const agreed = desk('Agreed.png'), KA = desk('KeepA.ai'), WA = desk('WorkA.indd');
    fs.writeFileSync(agreed, png(23)); fs.writeFileSync(KA, `%PDF-1.7\n${agreed}\n%%EOF\n`); fs.writeFileSync(WA, 'SYNTH');
    legacyRoots5(a, [KA, WA]); await a.select(WA, 'exclude'); await inddLink(a, WA, [agreed]); await prePackage(a);
    await metadataTestHooks.runScanOnOpen(a.id, KA, null, null, { verifySelectedSource: true });
    assert.deepEqual(await a.written(await a.review()), ['Agreed.png', 'KeepA.ai']);
    // Live-only owner: kept while its document is included, withheld when it is excluded.
    const l = await newProject('Live only'); const extra = desk('LiveOnly.png'), KL = desk('KeepL.ai'), side = desk('SideL.png');
    fs.writeFileSync(extra, png(24)); fs.writeFileSync(side, png(25)); fs.writeFileSync(KL, `%PDF-1.7\n${side}\n%%EOF\n`);
    legacyRoots5(l, [KL]);
    await metadataTestHooks.applyLiveAppEvidenceRefresh(l.id, [{ filePath: extra, source: 'indd-poll', appFamily: 'indesign', relationshipSourcePath: KL, savedEvidence: true, documentModified: false, allowDirect: true, forcePending: false }]);
    await metadataTestHooks.runScanOnOpen(l.id, KL, null, null, { verifySelectedSource: true });
    assert.ok((await l.written(await l.review())).includes('LiveOnly.png'));
  }, { realTmp: true }));

  // ---- Trade-off verification (owner-accepted): stale recorded owners keep assets.
  // a. Each owner-noting route: W and K recorded; K stops linking X; K is freshly verified; W is excluded.
  async function staleOwner(route) {
    if (route === 'regex' || route === 'snapshot') {
      const f = await formatProject('.ai'); const X = desk(f.names.newLink);
      writeWorking('.ai', f.W, [desk(f.names.only), desk(f.names.shared), X]); writeWorking('.ai', f.K, [desk(f.names.keepOnly), desk(f.names.shared), X]);
      if (route === 'regex') await prePackage(f);
      else {
        await callIpcRaw('projects:pause', f.id); clearTrackedTimers();
        setChildProcessHandler(request => {
          if (request.kind === 'execFile' && request.command === '/bin/ps') return { stdout: '444 /Applications/Adobe Illustrator.app/Contents/MacOS/Adobe Illustrator\n' };
          if (request.kind === 'execFile' && request.command === '/usr/sbin/lsof') return { stdout: `p444\nf14\ntREG\nn${f.W}\nf15\ntREG\nn${f.K}\n` };
          return passthroughInner(request);
        });
        await callIpcRaw('projects:start-watching', f.id); await metadataTestHooks.waitForWatcherIdle(f.id).catch(() => null);
        await callIpcRaw('projects:pause', f.id); clearTrackedTimers(); passthrough();
      }
      writeWorking('.ai', f.K, [desk(f.names.keepOnly), desk(f.names.shared)]);
      await metadataTestHooks.runScanOnOpen(f.id, f.K, null, null, { verifySelectedSource: true });
      await f.select(f.W, 'exclude');
      return { f, name: f.names.newLink, W: f.W, K: f.K, expectOthers: f.keepNames };
    }
    if (route === 'doublecheck') {
      const f = await formatProject('.sketch'); const X = desk(f.names.newLink), K2 = desk('Keep2.sketch');
      writeWorking('.sketch', K2, [X]); await f.add(K2);                              // K2's Add Files scan admits X
      writeWorking('.sketch', f.W, [desk(f.names.only), desk(f.names.shared), X]);
      await prePackage(f);
      assert.deepEqual(f.stored(f.names.newLink).dependencyOwners.slice().sort(), [f.W, K2].sort(), 'the double-check pass records both');
      writeWorking('.sketch', K2, []);
      await metadataTestHooks.runScanOnOpen(f.id, K2, null, null, { verifySelectedSource: true });
      await f.select(f.W, 'exclude');
      return { f, name: f.names.newLink, W: f.W, K: K2, expectOthers: [...f.keepNames, 'Keep2.sketch'] };
    }
    if (route === 'live') {
      const f = await newProject('Stale live'); const W = desk('StaleW.indd'), K = desk('StaleK.indd'), X = desk('StaleLive.png');
      fs.writeFileSync(W, 'SYNTH'); fs.writeFileSync(K, 'SYNTH'); fs.writeFileSync(X, png(146));
      legacyRoots5(f, [W, K]);
      await inddLink(f, W, [X]); await inddLink(f, K, [X]);
      setChildProcessHandler(request => request.kind === 'execFile' && request.command === '/bin/ps' && request.args[0] === 'axww' ? { stdout: '  1 /sbin/launchd\n', stderr: '' } : passthroughInner(request));
      await metadataTestHooks.runScanOnOpen(f.id, K, null, null, { verifySelectedSource: true });       // clean receipt, no X
      passthrough();
      await f.select(W, 'exclude');
      return { f, name: 'StaleLive.png', W, K, expectOthers: ['StaleK.indd'] };
    }
    // presentation: both decks embed the same image; K's deck drops it.
    const f = await formatProject('.pptx'); const K2 = desk('Second.pptx');
    writeWorking('.pptx', K2, [], 900); await f.add(K2); await metadataTestHooks.runScanOnSavePresentation(f.id, K2);
    const media = 'Work-pptx — image1.png';
    assert.ok(f.stored(media).dependencyOwners.includes(K2));
    writeWorking('.pptx', K2, [], 950);
    await metadataTestHooks.runScanOnSavePresentation(f.id, K2);
    await metadataTestHooks.runScanOnOpen(f.id, K2, null, null, { verifySelectedSource: true });
    await f.select(f.W, 'exclude');
    return { f, name: media, W: f.W, K: K2, expectOthers: null };
  }
  for (const route of ['regex', 'doublecheck', 'snapshot', 'live', 'presentation']) {
    baselineTest(`accepted trade-off a (${route}): a stale recorded owner keeps the asset and it is written`, { timeout: 120000 }, () => withEnv(async () => {
      const s = await staleOwner(route);
      const fact = await s.f.fact(s.name);
      assert.deepEqual([fact.included, fact.includedAsDependency, fact.excluded], [true, false, false]);
      const written = await s.f.written(await s.f.review());
      assert.ok(written.includes(s.name), JSON.stringify(written));
      if (s.expectOthers) assert.deepEqual(written, [...s.expectOthers, s.name].sort());
    }, { realTmp: route === 'snapshot' || route === 'live' }));
  }
  // b. The existing per-asset control removes the retained stale asset (variants: regex, double-check, snapshot, live, presentation).
  const rendererButtonsFor = async (f, name) => {
    const { loadProjectedWorkspace } = require('./opus-renderer-helpers');
    const ui = loadProjectedWorkspace(structuredClone(f.current()), await f.workspace());
    const labels = [];
    const descend = element => { if (!element) return; const label = element.getAttribute?.('aria-label'); if (element.tagName === 'BUTTON' && label && label.includes(name)) labels.push(label); for (const child of element.children || []) descend(child); };
    for (const id of ['existing-assets-list', 'added-assets-list', 'working-assets-list', 'project-file-list']) descend(ui.elements[id]);
    return labels;
  };
  for (const route of ['regex', 'doublecheck', 'snapshot', 'live', 'presentation']) {
    baselineTest(`accepted trade-off b (${route}): the per-asset Exclude removes the retained stale asset; Include brings it back`, { timeout: 120000 }, () => withEnv(async () => {
      const s = await staleOwner(route);
      const labels = await rendererButtonsFor(s.f, s.name);
      assert.ok(labels.includes(`Exclude ${s.name} from this project`), 'the production renderer offers Exclude: ' + JSON.stringify(labels));
      await s.f.toggle(s.name);
      let fact = await s.f.fact(s.name);
      assert.deepEqual([fact.included, fact.excluded], [false, true]);
      let review = await s.f.review();
      assert.equal(s.f.reviewNames(review).includes(s.name), false);
      roundTripFakeStore();
      review = await s.f.review();
      assert.equal((await s.f.written(review)).includes(s.name), false, 'written folder: omitted after the per-asset Exclude, after reload');
      await s.f.toggle(s.name);
      fact = await s.f.fact(s.name);
      assert.equal(fact.included, true);
    }, { realTmp: route === 'snapshot' || route === 'live' }));
  }
  // c. Contrast: an authoritatively required asset (K's current receipt lists it). The pre-existing rule: per-asset Exclude is overridden.
  baselineTest('pre-existing rule (unchanged): an asset the included file currently requires overrides a per-asset Exclude', { timeout: 120000 }, () => withEnv(async () => {
    const f = await formatProject('.ai'); const X = desk(f.names.newLink);
    writeWorking('.ai', f.W, [desk(f.names.only), desk(f.names.shared), X]); writeWorking('.ai', f.K, [desk(f.names.keepOnly), desk(f.names.shared), X]);
    await prePackage(f);
    await metadataTestHooks.runScanOnOpen(f.id, f.K, null, null, { verifySelectedSource: true });     // K's receipt lists X
    await f.select(f.W, 'exclude');
    let fact = await f.fact(f.names.newLink);
    assert.equal(fact.includedAsDependency, true);
    const labels = await rendererButtonsFor(f, f.names.newLink);
    assert.ok(labels.some(label => label.startsWith(`Why ${f.names.newLink} is required`)), 'the renderer shows Required asset, not Exclude: ' + JSON.stringify(labels));
    assert.equal(labels.includes(`Exclude ${f.names.newLink} from this project`), false);
    await f.toggle(f.names.newLink);                                                                  // the IPC still records an Exclude
    fact = await f.fact(f.names.newLink);
    assert.deepEqual([fact.excluded, fact.included, fact.includedAsDependency], [true, true, true]);
    assert.ok((await f.written(await f.review())).includes(f.names.newLink), 'written: overridden by the required link (as on base)');
  }));
  // d. Extent: a stale-kept placed document (asset role, admitted by the Add Files
  // scan) keeps what it links while it is included, and the pre-package passes
  // read it as included. Its own per-asset Exclude withholds what only it links.
  baselineTest('accepted trade-off d: a stale-kept placed document keeps its links while included; its per-asset Exclude withholds what only it links', { timeout: 120000 }, () => withEnv(async () => {
    const W = desk('Work-d.ai'), K = desk('Keep-d.ai'), P = desk('Placed.ai'), Y = desk('Nested.png'), Z = desk('LaterNested.png'), side = desk('KeepSide-d.png');
    const f = await newProject('Trade-off d', { before() {
      fs.writeFileSync(Y, png(61)); fs.writeFileSync(Z, png(62)); fs.writeFileSync(side, png(63));
      writeWorking('.ai', P, [Y]); writeWorking('.ai', W, [P]); writeWorking('.ai', K, [P, side]);
    } });
    for (const file of [W, K]) await f.add(file);
    assert.equal(f.stored('Placed.ai').source, 'scan-on-open'); assert.equal(f.stored('Placed.ai').projectRole, 'asset');
    await prePackage(f);                                       // the regex pass reads W, K and the placed P
    assert.deepEqual(f.stored('Placed.ai').dependencyOwners.slice().sort(), [W, K].sort());
    assert.deepEqual(f.stored('Nested.png').dependencyOwners, [P]);
    writeWorking('.ai', K, [side]);                            // K stops placing P
    await metadataTestHooks.runScanOnOpen(f.id, K, null, null, { verifySelectedSource: true });
    await f.select(W, 'exclude');
    for (const name of ['Placed.ai', 'Nested.png']) {
      const fact = await f.fact(name);
      assert.deepEqual([fact.included, fact.includedAsDependency], [true, false], name + ' retained, not required');
    }
    let written = await f.written(await f.review());
    assert.deepEqual(written, ['Keep-d.ai', 'KeepSide-d.png', 'Nested.png', 'Placed.ai']);
    writeWorking('.ai', P, [Y, Z]);
    await prePackage(f);                                       // P is read as an included document: its new link is admitted
    assert.deepEqual(f.stored('LaterNested.png').dependencyOwners, [P]);
    written = await f.written(await f.review());
    assert.deepEqual(written, ['Keep-d.ai', 'KeepSide-d.png', 'LaterNested.png', 'Nested.png', 'Placed.ai']);
    // The per-asset Exclude removes the placed document and what only it links.
    const labels = await rendererButtonsFor(f, 'Placed.ai');
    assert.ok(labels.includes('Exclude Placed.ai from this project'), JSON.stringify(labels));
    await f.toggle('Placed.ai');
    for (const name of ['Nested.png', 'LaterNested.png']) {
      const fact = await f.fact(name);
      assert.deepEqual([fact.included, fact.excludedSourceOnly], [false, true], name + ' withheld with its excluded document');
    }
    assert.deepEqual(await f.written(await f.review()), ['Keep-d.ai', 'KeepSide-d.png']);
    roundTripFakeStore();
    assert.deepEqual(await f.written(await f.review()), ['Keep-d.ai', 'KeepSide-d.png'], 'after reload');
    await f.toggle('Placed.ai');                                // Include brings the document and its links back
    assert.deepEqual(await f.written(await f.review()), ['Keep-d.ai', 'KeepSide-d.png', 'LaterNested.png', 'Nested.png', 'Placed.ai']);
  }));
  // e. Owner removal, owner Exclude and Restore.
  baselineTest('accepted trade-off e: a removed stale owner is ignored; owner Exclude and Restore follow selection', { timeout: 120000 }, () => withEnv(async () => {
    const s = await staleOwner('regex');
    await s.f.select(s.K, 'exclude'); roundTripFakeStore();
    assert.equal((await s.f.fact(s.name)).included, false, 'both owners excluded');
    await s.f.select(s.K, 'restore'); roundTripFakeStore();
    assert.equal((await s.f.fact(s.name)).included, true, 'restored stale owner keeps it');
    await s.f.select(s.W, 'restore'); roundTripFakeStore();
    const viaW = await s.f.fact(s.name);
    assert.deepEqual([viaW.included, viaW.includedAsDependency], [true, true], "W's dependency");
    await s.f.select(s.W, 'exclude');
    // Remove K from the project: the record is ignored.
    const kRow = (await s.f.workspace()).files.find(row => row.name === path.basename(s.K));
    s.f.current().files = s.f.current().files.filter(row => row.path !== s.K); roundTripFakeStore();
    void kRow;
    assert.equal((await s.f.fact(s.name)).included, false, 'an owner that is no longer a project file keeps nothing');
    roundTripFakeStore();
    assert.equal((await s.f.fact(s.name)).included, false);
  }));
  // f. Shared assets and individual choices are unaffected.
  baselineTest('accepted trade-off f: shared assets, per-asset Include, Add Files and Add are kept through Exclude, Restore and Exclude', { timeout: 120000 }, () => withEnv(async () => {
    const f = await formatProject('.ai'); const added = desk('AddedByHand.png'), pending = desk(f.names.newLink);
    fs.writeFileSync(added, png(70));
    writeWorking('.ai', f.W, [desk(f.names.only), desk(f.names.shared), added, pending]);
    manualDialogFor([added]); await callIpcRaw('projects:add-files', f.id);
    await f.select(f.W, 'exclude');
    await f.toggle(f.names.only);                                                                     // per-asset Include
    setChildProcessHandler(request => {
      if (isIllustratorPgrepCheck(request)) return { stdout: '432\n' };
      if (isOsascriptInvocation(request, 'crate-ai-active-session.applescript')) return { stdout: `DOC\t${f.W}\tWork-ai.ai\ttrue\ttrue\nLINK\t${f.W}\tWork-ai.ai\t${pending}\ttrue\ttrue\nCOMPLETE\t1\t1\n` };
      return passthroughInner(request);
    });
    await metadataTestHooks.pollPsForProject(f.id, metadataTestHooks.getActiveWatchingActivationToken(f.id));
    await metadataTestHooks.waitForWatcherIdle(f.id).catch(() => null); clearTrackedTimers(); passthrough();
    const row = f.current().pendingFiles.find(item => item.path === pending); assert.ok(row);
    assert.ok(await callIpcRaw('projects:accept-pending', f.id, metadataTestHooks.createProjectFileVisualIdentity(f.id, row)));   // Add
    await f.select(f.W, 'restore'); await f.select(f.W, 'exclude'); roundTripFakeStore();
    const expected = [...f.keepNames, 'AddedByHand.png', f.names.only, f.names.newLink].sort();
    assert.deepEqual(await f.written(await f.review()), expected);
    assert.deepEqual((await f.fact(f.names.shared)).requiredBy, [path.basename(f.K)], 'shared asset stays required');
  }, { realTmp: true }));

  // ---- Presentation capture failure: once, and persistently.
  baselineTest('presentation capture failure once: the unnamed refusal recovers on the next review to clearable rows', { timeout: 120000 }, () => withEnv(async () => {
    const f = await pausedDeck('.pptx'); await f.toggle(f.media); await f.pause(); f.change(777);
    let listingFailed = false;
    setChildProcessHandler(req => { if (!listingFailed && req.kind === 'execFile' && req.command === '/usr/bin/unzip' && req.args[0] === '-l' && req.args[1] === f.W) { listingFailed = true; throw new Error('synthetic listing failure'); } return passthroughInner(req); });
    const failed = await f.review();
    assert.equal(failed.materializable, false);
    assert.equal(failed.message, 'A presentation changed while Crate was not capturing it, and Crate could not list its new media. Open Package Review again; Crate lists them so you can choose Include or Exclude for each.');
    passthrough();
    const retry = await f.review();
    assert.match(retry.message, /cannot carry your earlier Include or Exclude/);
    for (const name of heldNow(f)) await f.toggle(name);
    assert.equal((await f.review()).materializable, true);
  }));
  baselineTest('presentation capture failure persistent: refusals stay clearable with existing controls', { timeout: 120000 }, () => withEnv(async () => {
    // (1) The deck cannot be listed at all: planning also fails; the deck entry is unavailable.
    const a = await pausedDeck('.pptx'); await a.toggle(a.media); await a.pause(); a.change(777);
    setChildProcessHandler(req => { if (req.kind === 'execFile' && req.command === '/usr/bin/unzip' && req.args[1] === a.W) throw new Error('synthetic persistent read failure'); return passthroughInner(req); });
    for (let attempt = 0; attempt < 2; attempt++) {
      const refused = await a.review();
      assert.equal(refused.materializable, false);
      assert.equal(refused.message, 'Some files are unavailable. Resolve them before packaging.');
    }
    await a.select(a.W, 'exclude');                                                                   // existing control
    assert.equal((await a.review()).materializable, true, 'excluding the unreadable deck clears it');
    passthrough();
    // (2) The deck is readable, but the capture's member extraction keeps failing
    // (planning, which reads the same archive afterwards, succeeds).
    const b = await pausedDeck('.pptx'); await b.toggle(b.media); await b.pause(); b.change(777);
    let phase = 'plan', failing = true;
    setChildProcessHandler(req => {
      if (req.kind === 'execFile' && req.command === '/usr/bin/unzip' && req.args[1] === b.W) {
        if (req.args[0] === '-l') phase = phase === 'capture' ? 'plan' : 'capture';
        else if (failing && phase === 'capture') throw new Error('synthetic capture extraction failure');
      }
      return passthroughInner(req);
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      phase = 'plan';
      const refused = await b.review();
      assert.equal(refused.materializable, false);
      assert.equal(refused.message, 'A presentation changed while Crate was not capturing it, and Crate could not list its new media. Open Package Review again; Crate lists them so you can choose Include or Exclude for each.');
      assert.deepEqual(heldNow(b), []);
    }
    await b.select(b.W, 'exclude');
    assert.equal((await b.review()).materializable, true, 'excluding the deck clears the refusal');
    await b.select(b.W, 'restore');
    failing = false; passthrough();
    const retry = await b.review();                                                                   // capture succeeds again
    assert.match(retry.message || '', /cannot carry your earlier Include or Exclude/);
    for (const name of heldNow(b)) await b.toggle(name);
    assert.equal((await b.review()).materializable, true);
  }));

  // ---- Row kinds and the control that governs each (round five).
  const rowKind = async (f, name) => {
    const stored = f.stored(name), fact = await f.fact(name);
    return { projectRole: stored.projectRole, source: stored.source, workingSource: !!fact.sourceSelection, protectedSource: fact.protectedSource === true,
      included: fact.included, includedAsDependency: fact.includedAsDependency, excludedSourceOnly: fact.excludedSourceOnly, requiredBy: fact.requiredBy };
  };
  baselineTest('row kinds: a stale retained asset-role image and asset-role placed document use the per-asset control; the placed document takes what only it links', { timeout: 120000 }, () => withEnv(async () => {
    // Asset-role image (regex route).
    const s = await staleOwner('regex');
    assert.deepEqual(await rowKind(s.f, s.name), { projectRole: 'asset', source: 'linked-asset', workingSource: false, protectedSource: false,
      included: true, includedAsDependency: false, excludedSourceOnly: false, requiredBy: [] });
    // Asset-role placed document with its own link.
    const W = desk('Work-k.ai'), K = desk('Keep-k.ai'), P = desk('PlacedK.ai'), Y = desk('NestedK.png'), side = desk('Side-k.png');
    const f = await newProject('Row kinds', { before() { fs.writeFileSync(Y, png(64)); fs.writeFileSync(side, png(65)); writeWorking('.ai', P, [Y]); writeWorking('.ai', W, [P]); writeWorking('.ai', K, [P, side]); } });
    for (const file of [W, K]) await f.add(file);
    await prePackage(f); writeWorking('.ai', K, [side]);
    await metadataTestHooks.runScanOnOpen(f.id, K, null, null, { verifySelectedSource: true });
    await f.select(W, 'exclude');
    assert.deepEqual(await rowKind(f, 'PlacedK.ai'), { projectRole: 'asset', source: 'scan-on-open', workingSource: false, protectedSource: false,
      included: true, includedAsDependency: false, excludedSourceOnly: false, requiredBy: [] });
    await f.toggle('PlacedK.ai');                                                  // control: per-asset Exclude (projects:remove-file)
    assert.equal((await f.fact('PlacedK.ai')).excluded, true);
    const nested = await f.fact('NestedK.png');
    assert.deepEqual([nested.included, nested.excludedSourceOnly], [false, true], 'its nested asset leaves with it');
    assert.deepEqual(await f.written(await f.review()), ['Keep-k.ai', 'Side-k.png']);
    await f.toggle('NestedK.png');                                                 // per-asset Include keeps the nested asset alone
    assert.deepEqual(await f.written(await f.review()), ['Keep-k.ai', 'NestedK.png', 'Side-k.png']);
    await f.toggle('PlacedK.ai');                                                  // Include again
    roundTripFakeStore();
    assert.deepEqual(await f.written(await f.review()), ['Keep-k.ai', 'NestedK.png', 'PlacedK.ai', 'Side-k.png']);
  }));
  // Working-role documents (existing working-file behavior, unchanged by this round):
  // the per-asset toggle is not their control; working-file Exclude/Restore is.
  baselineTest('row kinds: an independent working file is governed by working-file Exclude and Restore (existing behavior)', { timeout: 120000 }, () => withEnv(async () => {
    const f = await formatProject('.ai'); const P = desk('OtherWork.ai'), Y = desk('OtherWorkLink.png');
    fs.writeFileSync(Y, png(66)); writeWorking('.ai', P, [Y]);
    await f.add(P);
    const kind = await rowKind(f, 'OtherWork.ai');
    assert.deepEqual([kind.projectRole, kind.workingSource, kind.protectedSource], ['source', true, true]);
    const before = JSON.stringify(f.current().files);
    await callIpcRaw('projects:remove-file', f.id, (await f.fact('OtherWork.ai')).visualIdentity);
    assert.equal(JSON.stringify(f.current().files), before, 'the per-asset call does not act on a working file');
    await f.select(P, 'exclude');                                                    // control: working-file Exclude
    assert.equal((await f.fact('OtherWorkLink.png')).included, false, 'its own asset leaves with it');
    let written = await f.written(await f.review());
    assert.equal(written.includes('OtherWork.ai') || written.includes('OtherWorkLink.png'), false);
    await f.select(P, 'restore');                                                    // control: working-file Restore
    written = await f.written(await f.review());
    assert.ok(written.includes('OtherWork.ai') && written.includes('OtherWorkLink.png'));
  }));
  baselineTest('row kinds: a working file that an included file links stays as its required dependency when excluded (existing behavior)', { timeout: 120000 }, () => withEnv(async () => {
    const f = await formatProject('.ai'); const P = desk('PlacedWork.ai'), Y = desk('PlacedWorkLink.png');
    fs.writeFileSync(Y, png(66)); writeWorking('.ai', P, [Y]);
    writeWorking('.ai', f.W, [desk(f.names.only), desk(f.names.shared), P]);
    await prePackage(f);                                                             // the regex pass admits P; an .ai is stored as a working file
    const kind = await rowKind(f, 'PlacedWork.ai');
    assert.deepEqual([kind.projectRole, kind.source, kind.workingSource, kind.protectedSource], ['source', 'linked-asset', true, true]);
    await metadataTestHooks.runScanOnOpen(f.id, P, null, null, { verifySelectedSource: true });
    await f.select(P, 'exclude');                                                    // control: working-file Exclude
    const stale = await f.review();                                                  // W changed after its receipt: not packageable yet
    assert.equal(stale.materializable, false); assert.equal(stale.message, 'Working-source verification is unresolved. Resolve it before packaging.');
    await metadataTestHooks.runScanOnOpen(f.id, f.W, null, null, { verifySelectedSource: true });
    const placed = await f.fact('PlacedWork.ai');
    assert.deepEqual([placed.sourceSelection, placed.includedAsDependency, placed.included], ['excluded', true, true], 'retained as W\'s dependency');
    assert.equal((await f.fact('PlacedWorkLink.png')).included, true);
    const written = await f.written(await f.review());
    assert.ok(written.includes('PlacedWork.ai') && written.includes('PlacedWorkLink.png'));
  }));
  baselineTest('presentation capture succeeds but lists nothing new: no refusal, a token is issued', { timeout: 120000 }, () => withEnv(async () => {
    const f = await pausedDeck('.pptx'); await f.toggle(f.media); await f.pause();
    writeWorking('.pptx', f.W, [desk(f.names.only), desk(f.names.shared)], 11);    // the deck now embeds bytes Crate already has (Solo-pptx.png)
    const review = await f.review();
    assert.equal(review.materializable, true, review.message); assert.ok(review.token);
    assert.deepEqual(heldNow(f), []);
    const written = await f.written(review);
    assert.equal(written.includes(f.media), false, 'the explicitly excluded old picture stays out');
  }));

  // ==== Excluded documents: whatever is written keeps what it links (P), and a
  // document the owner excluded directly keeps nothing and admits nothing (Q). ====
  // Work-g.ai places Logo-g.ai and Icon-g.ai; Logo-g.ai places Icon-g.ai and links
  // Badge-g.png; Icon-g.ai links Texture-g.png and Shared-g.png, which the
  // unrelated included Keep-g.ai also links.
  baselineTest('excluded documents: a document the owner includes keeps what its placed documents link (Texture regression)', { timeout: 180000 }, () => withEnv(async () => {
    const W = desk('Work-g.ai'), K = desk('Keep-g.ai'), L = desk('Logo-g.ai'), I = desk('Icon-g.ai');
    const T = desk('Texture-g.png'), B = desk('Badge-g.png'), S = desk('Shared-g.png'), side = desk('KeepSide-g.png');
    const f = await newProject('Diamond', { before() {
      [[T, 411], [B, 412], [S, 413], [side, 414]].forEach(([file, seed]) => fs.writeFileSync(file, png(seed)));
      writeWorking('.ai', I, [T, S]); writeWorking('.ai', L, [I, B]); writeWorking('.ai', W, [L, I]); writeWorking('.ai', K, [side, S]);
    } });
    for (const file of [W, K]) await f.add(file);
    await prePackage(f); await prePackage(f);
    for (const name of ['Logo-g.ai', 'Icon-g.ai', 'Texture-g.png', 'Badge-g.png']) assert.equal(f.stored(name).projectRole, 'asset', name);
    assert.deepEqual(f.stored('Icon-g.ai').dependencyOwners.slice().sort(), [I, L, W].filter(p => p !== I).sort());
    const all = ['Badge-g.png', 'Icon-g.ai', 'Keep-g.ai', 'KeepSide-g.png', 'Logo-g.ai', 'Shared-g.png', 'Texture-g.png', 'Work-g.ai'];
    const keepOnly = ['Keep-g.ai', 'KeepSide-g.png', 'Shared-g.png'];
    const placed = ['Badge-g.png', 'Icon-g.ai', 'Logo-g.ai', 'Texture-g.png'];
    assert.deepEqual(await f.written(await f.review()), all);
    await f.select(W, 'exclude');                                                    // 1. working-file Exclude
    assert.deepEqual(await f.written(await f.review()), keepOnly);
    await f.toggle('Logo-g.ai');                                                     // 2. per-asset Include on Logo
    assert.equal(f.stored('Logo-g.ai').keptAfterSourceExclusion, true);
    assert.deepEqual(await f.written(await f.review()), [...keepOnly, ...placed].sort(), 'Logo keeps Icon, and Icon keeps Texture');
    roundTripFakeStore();
    assert.deepEqual(await f.written(await f.review()), [...keepOnly, ...placed].sort(), 'after reload');
    await f.toggle('Logo-g.ai');                                                     // 3. per-asset Exclude on Logo again
    assert.deepEqual(await f.written(await f.review()), keepOnly);
    await f.select(W, 'restore');                                                    // 4. Restore
    assert.deepEqual(await f.written(await f.review()), all);
    // Include All Existing after the Exclude keeps all placed files for that exclusion.
    await f.select(W, 'exclude');
    assert.deepEqual(await f.written(await f.review()), keepOnly);
    await f.bulk('include');
    assert.deepEqual(await f.written(await f.review()), [...keepOnly, ...placed].sort(), 'Include All Existing');
    roundTripFakeStore();
    assert.deepEqual(await f.written(await f.review()), [...keepOnly, ...placed].sort(), 'Include All Existing after reload');
  }));
  // Counts reads of one file by the main process while `work` runs.
  const readsOf = async (target, work) => {
    const key = target.toLowerCase(); let count = 0;
    const wrap = (owner, name) => { const original = owner[name];
      owner[name] = function (file, ...rest) { if (typeof file === 'string' && file.toLowerCase() === key) count++; return original.call(this, file, ...rest); };
      return () => { owner[name] = original; }; };
    const restore = [wrap(fs, 'readFileSync'), wrap(fs, 'readFile'), wrap(fs, 'openSync'), wrap(fs, 'open'), wrap(fs, 'createReadStream'),
      wrap(fs.promises, 'readFile'), wrap(fs.promises, 'open')];
    try { await work(); } finally { restore.forEach(undo => undo()); }
    return count;
  };
  const verifyScan = (f, filePath) => metadataTestHooks.runScanOnOpen(f.id, filePath, null, null, { verifySelectedSource: true });
  baselineTest('excluded documents N1/N2: a placed document\'s per-asset Exclude withholds what only it links, and it is not read until Include', { timeout: 180000 }, () => withEnv(async () => {
    const W = desk('Work-n.ai'), K = desk('Keep-n.ai'), P = desk('Placed-n.ai'), Y = desk('Nested-n.png'), Z = desk('LaterNested-n.png'), A = desk('AfterExclude-n.png'), side = desk('KeepSide-n.png');
    const f = await newProject('N1 N2', { before() {
      [[Y, 421], [Z, 422], [A, 423], [side, 424]].forEach(([file, seed]) => fs.writeFileSync(file, png(seed)));
      writeWorking('.ai', P, [Y]); writeWorking('.ai', W, [P]); writeWorking('.ai', K, [P, side]);
    } });
    for (const file of [W, K]) await f.add(file);
    await prePackage(f);
    writeWorking('.ai', K, [side]); await verifyScan(f, K);                        // Keep-n.ai holds only an old link record for Placed-n.ai
    await f.select(W, 'exclude');
    writeWorking('.ai', P, [Y, Z]); await prePackage(f);
    const all = ['Keep-n.ai', 'KeepSide-n.png', 'LaterNested-n.png', 'Nested-n.png', 'Placed-n.ai'], keep = ['Keep-n.ai', 'KeepSide-n.png'];
    assert.deepEqual(await f.written(await f.review()), all, 'kept by the old record, with its links');
    for (let cycle = 0; cycle < 3; cycle++) {
      await f.toggle('Placed-n.ai');                                               // per-asset Exclude
      for (const name of ['Nested-n.png', 'LaterNested-n.png']) {
        const fact = await f.fact(name);
        assert.deepEqual([fact.included, fact.excludedSourceOnly, fact.excluded], [false, true, false], `${name} cycle ${cycle}`);
      }
      assert.deepEqual(await f.written(await f.review()), keep, `Exclude, cycle ${cycle}`);
      if (cycle === 1) { roundTripFakeStore(); assert.deepEqual(await f.written(await f.review()), keep, 'after reload'); }
      await f.toggle('Placed-n.ai');                                               // per-asset Include
      assert.deepEqual(await f.written(await f.review()), all, `Include, cycle ${cycle}`);
    }
    // N2: the excluded document gains a link; the pre-package passes neither read it nor admit the link.
    await f.toggle('Placed-n.ai');
    writeWorking('.ai', P, [Y, Z, A]);
    assert.equal(await readsOf(P, () => prePackage(f)), 0, 'the excluded document is not read');
    assert.deepEqual(f.anyRowAt(A), [], 'no row or pending row for its new link');
    assert.deepEqual(await f.written(await f.review()), keep);
    roundTripFakeStore();
    assert.deepEqual(await f.written(await f.review()), keep, 'after reload');
    await f.toggle('Placed-n.ai');
    assert.ok(await readsOf(P, () => prePackage(f)) > 0, 'read again once included');
    assert.ok(f.current().files.some(row => row.path === A), 'the link is admitted on the first pass after Include');
    assert.deepEqual(await f.written(await f.review()), [...all, 'AfterExclude-n.png'].sort());
  }));
  baselineTest('excluded documents N3-i: a working-role placed document kept only by an old record takes its own link when excluded', { timeout: 180000 }, () => withEnv(async () => {
    const f = await formatProject('.ai'); const P = desk('PlacedWork-i.ai'), Y = desk('PlacedWorkLink-i.png');
    fs.writeFileSync(Y, png(431)); writeWorking('.ai', P, [Y]);
    writeWorking('.ai', f.W, [desk(f.names.only), desk(f.names.shared), P]);
    writeWorking('.ai', f.K, [desk(f.names.keepOnly), desk(f.names.shared), P]);
    await prePackage(f);
    assert.equal(f.stored('PlacedWork-i.ai').projectRole, 'source');
    writeWorking('.ai', f.K, [desk(f.names.keepOnly), desk(f.names.shared)]); await verifyScan(f, f.K);
    await f.select(f.W, 'exclude');
    const withPlaced = [...f.keepNames, 'PlacedWork-i.ai', 'PlacedWorkLink-i.png'].sort();
    assert.deepEqual(await f.written(await f.review()), withPlaced);
    await f.select(P, 'exclude');                                                  // working-file Exclude of the placed document
    const link = await f.fact('PlacedWorkLink-i.png');
    assert.deepEqual([link.included, link.excludedSourceOnly, link.excluded], [false, true, false]);
    assert.deepEqual(await f.written(await f.review()), f.keepNames);
    roundTripFakeStore();
    assert.deepEqual(await f.written(await f.review()), f.keepNames, 'after reload');
    await f.select(P, 'restore');
    assert.deepEqual(await f.written(await f.review()), withPlaced, 'Restore returns the document and its link');
    await f.select(P, 'exclude'); roundTripFakeStore();
    assert.deepEqual(await f.written(await f.review()), f.keepNames, 'Exclude again, after reload');
  }));
  baselineTest('excluded documents: shared, old-record, individually included, accepted and added links of an excluded placed document stay', { timeout: 180000 }, () => withEnv(async () => {
    const W = desk('Work-m.ai'), K = desk('Keep-m.ai'), P = desk('PlacedM.ai'), side = desk('KeepSide-m.png');
    const shared = desk('SharedN-m.png'), stale = desk('StaleN-m.png'), only = desk('OnlyN-m.png'), added = desk('AddedN-m.png'), pend = desk('PendingN-m.png');
    const f = await newProject('Mixed owners', { before() {
      [[side, 441], [shared, 442], [stale, 443], [only, 444], [added, 445], [pend, 446]].forEach(([file, seed]) => fs.writeFileSync(file, png(seed)));
      writeWorking('.ai', P, [shared, stale, only, added]); writeWorking('.ai', W, [P]); writeWorking('.ai', K, [P, side, shared, stale]);
    } });
    for (const file of [W, K]) await f.add(file);
    manualDialogFor([added]); await callIpcRaw('projects:add-files', f.id);      // explicitly added by the owner
    await prePackage(f);
    writeWorking('.ai', K, [side, shared]); await verifyScan(f, K);                 // Keep-m.ai: current link to SharedN, old records for PlacedM and StaleN
    await f.select(W, 'exclude');
    // A link Illustrator reports for the placed document while it is unsaved waits as pending; the owner adds it.
    setChildProcessHandler(request => {
      if (isIllustratorPgrepCheck(request)) return { stdout: '432\n' };
      if (isOsascriptInvocation(request, 'crate-ai-active-session.applescript')) return { stdout: `DOC\t${P}\tPlacedM.ai\ttrue\ttrue\nLINK\t${P}\tPlacedM.ai\t${pend}\ttrue\ttrue\nCOMPLETE\t1\t1\n` };
      return passthroughInner(request);
    });
    await metadataTestHooks.pollPsForProject(f.id, metadataTestHooks.getActiveWatchingActivationToken(f.id));
    await metadataTestHooks.waitForWatcherIdle(f.id).catch(() => null); clearTrackedTimers(); passthrough();
    const row = f.current().pendingFiles.find(item => item.path === pend); assert.ok(row, 'pending row for the live link');
    assert.ok(await callIpcRaw('projects:accept-pending', f.id, metadataTestHooks.createProjectFileVisualIdentity(f.id, row)));
    const all = ['AddedN-m.png', 'Keep-m.ai', 'KeepSide-m.png', 'OnlyN-m.png', 'PendingN-m.png', 'PlacedM.ai', 'SharedN-m.png', 'StaleN-m.png'];
    const stays = all.filter(name => !['OnlyN-m.png', 'PlacedM.ai'].includes(name));
    assert.deepEqual(await f.written(await f.review()), all);
    await f.toggle('PlacedM.ai');                                                  // per-asset Exclude of the placed document
    assert.deepEqual(await f.written(await f.review()), stays, 'only the link nothing else keeps leaves');
    await f.toggle('OnlyN-m.png');                                                 // per-asset Include on the withheld link
    assert.deepEqual(await f.written(await f.review()), [...stays, 'OnlyN-m.png'].sort());
    await f.toggle('PlacedM.ai'); await f.toggle('PlacedM.ai'); roundTripFakeStore();
    assert.deepEqual(await f.written(await f.review()), [...stays, 'OnlyN-m.png'].sort(), 'the Include survives Include/Exclude of its document and reload');
    await f.toggle('OnlyN-m.png');                                                 // a second click excludes it
    assert.deepEqual(await f.written(await f.review()), stays);
  }, { realTmp: true }));
  baselineTest('excluded documents: a document an included file requires stays whole with its links (N3-ii, C1a)', { timeout: 180000 }, () => withEnv(async () => {
    // Asset-role placed document listed by Keep-c.ai's current receipt, per-asset Exclude.
    const W = desk('Work-c.ai'), K = desk('Keep-c.ai'), P = desk('PlacedC.ai'), Y = desk('NestedC.png'), side = desk('KeepSide-c.png'), solo = desk('Solo-c.png');
    const c = await newProject('Required asset doc', { before() {
      [[Y, 451], [side, 452], [solo, 453]].forEach(([file, seed]) => fs.writeFileSync(file, png(seed)));
      writeWorking('.ai', P, [Y]); writeWorking('.ai', K, [P, side]); writeWorking('.ai', W, [solo]);
    } });
    for (const file of [W, K]) await c.add(file);
    await prePackage(c); await verifyScan(c, K); await verifyScan(c, W);
    await c.select(W, 'exclude');
    const required = ['Keep-c.ai', 'KeepSide-c.png', 'NestedC.png', 'PlacedC.ai'];
    assert.deepEqual(await c.written(await c.review()), required);
    await c.toggle('PlacedC.ai');
    const placed = await c.fact('PlacedC.ai');
    assert.deepEqual([placed.excluded, placed.included, placed.includedAsDependency], [true, true, true]);
    assert.deepEqual(await c.written(await c.review()), required, 'the required document keeps its link');
    roundTripFakeStore();
    assert.deepEqual(await c.written(await c.review()), required, 'after reload');
    // Working-role placed document that the included working file currently links, working-file Exclude.
    const f = await formatProject('.ai'); const PW = desk('PlacedWork-r.ai'), YW = desk('PlacedWorkLink-r.png');
    fs.writeFileSync(YW, png(454)); writeWorking('.ai', PW, [YW]);
    writeWorking('.ai', f.W, [desk(f.names.only), desk(f.names.shared), PW]);
    await prePackage(f); await verifyScan(f, PW);
    await f.select(PW, 'exclude'); await verifyScan(f, f.W);
    assert.equal((await f.fact('PlacedWork-r.ai')).includedAsDependency, true);
    assert.deepEqual(await f.written(await f.review()),
      [...f.keepNames, f.names.only, 'PlacedWork-r.ai', 'PlacedWorkLink-r.png', 'Work-ai.ai'].sort());
  }));
  baselineTest('excluded documents: a reader disagreement keeps the long name an included file recorded (before and after the Exclude and a rescan)', { timeout: 180000 }, () => withEnv(async () => {
    const W = desk('Work-r.ai'), K = desk('Keep-r.ai'), P = desk('PlacedR.ai'), long = desk('Picture.png.final.png'), short = desk('Picture.png'), side = desk('KeepSide-r.png');
    const f = await newProject('Reader disagreement', { before() {
      [[long, 461], [short, 462], [side, 463]].forEach(([file, seed]) => fs.writeFileSync(file, png(seed)));
      writeWorking('.ai', P, [long]); writeWorking('.ai', W, [P]); writeWorking('.ai', K, [P, side, long]);
    } });
    for (const file of [W, K]) await f.add(file);
    await prePackage(f);
    writeWorking('.ai', K, [side, long]); await verifyScan(f, K);
    const receipt = metadataTestHooks.getWorkingSourceVerification(f.current(), f.current().files.find(row => row.path === K));
    assert.ok(receipt.requiredReferences.some(ref => ref.path === short) && !receipt.requiredReferences.some(ref => ref.path === long), 'the clean scan lists only the short name');
    assert.ok(f.stored('Picture.png.final.png').dependencyOwners.includes(K));
    await f.select(W, 'exclude');
    const before = await f.written(await f.review());
    assert.ok(before.includes('Picture.png.final.png'), JSON.stringify(before));
    await f.toggle('PlacedR.ai');                                                  // Exclude the placed document that also links it
    const after = await f.written(await f.review());
    assert.deepEqual(after, before.filter(name => name !== 'PlacedR.ai'));
    await verifyScan(f, K); await prePackage(f);
    assert.deepEqual(await f.written(await f.review()), after, 'after a rescan and another pre-package pass');
  }));
  baselineTest('excluded documents: a document with no owner evidence stays, and so does what it links', { timeout: 180000 }, () => withEnv(async () => {
    const W = desk('Work-o.ai'), K = desk('Keep-o.ai'), U = desk('Unowned-o.ai'), C = desk('UnownedChild-o.png'), side = desk('KeepSide-o.png');
    const f = await newProject('No owner evidence', { before() {
      [[C, 471], [side, 472]].forEach(([file, seed]) => fs.writeFileSync(file, png(seed)));
      writeWorking('.ai', U, [C]); writeWorking('.ai', W, [U, C]); writeWorking('.ai', K, [side]);
    } });
    for (const file of [W, K]) await f.add(file);
    await prePackage(f);
    assert.equal(f.stored('Unowned-o.ai').projectRole, 'asset');
    assert.ok(f.stored('UnownedChild-o.png').dependencyOwners.includes(U));
    // W stops placing the document and is rescanned; the document's row loses its owner
    // evidence, as in a store written before owner recording.
    writeWorking('.ai', W, [C]); await verifyScan(f, W);
    const stored = f.current().files.find(row => row.path === U);
    delete stored.dependencyOwners; delete stored.assetBaselineSourcePath;
    if (stored.captureEvidence) { delete stored.captureEvidence.relationshipSourcePath; delete stored.captureEvidence.sourceDocumentPath; }
    roundTripFakeStore();
    await f.select(W, 'exclude');
    assert.deepEqual(await f.written(await f.review()), ['Keep-o.ai', 'KeepSide-o.png', 'Unowned-o.ai', 'UnownedChild-o.png']);
  }));
  baselineTest('membership cost: an excluded document that owns 400 rows adds linear work', { timeout: 300000 }, () => withEnv(async () => {
    const count = 400, W = desk('CostWork.ai'), K = desk('CostKeep.ai'), P = desk('CostPlaced.ai');
    const paths = Array.from({ length: count }, (_, i) => desk('Owned-' + i + '.png'));
    const f = await newProject('Excluded document cost', { before() {
      paths.forEach((file, i) => fs.writeFileSync(file, png(5000 + i))); writeWorking('.ai', P, paths); writeWorking('.ai', W, [P]); writeWorking('.ai', K, [P]);
    } });
    for (const file of [W, K]) await f.add(file);
    await prePackage(f);
    assert.ok(f.current().files.filter(row => paths.includes(row.path)).every(row => row.dependencyOwners?.includes(P)), 'every row records the document');
    writeWorking('.ai', K, []); await verifyScan(f, K);                            // the document stays by K's old record
    await f.select(W, 'exclude');
    const measure = (handle = f) => {
      const p = structuredClone(handle.current());
      let realpaths = 0, stats = 0, receiptLookups = 0;
      p.workingSourceVerification = new Proxy(p.workingSourceVerification || {}, { get(target, key, receiver) { if (typeof key === 'string' && /^[a-f0-9]{64}$/.test(key)) receiptLookups++; return Reflect.get(target, key, receiver); } });
      const orig = fs.realpathSync.native, origStat = fs.statSync;
      fs.realpathSync.native = function (...args) { realpaths++; return orig.apply(this, args); };
      fs.statSync = function (...args) { stats++; return origStat.apply(this, args); };
      let facts; try { facts = metadataTestHooks.getWorkingSourceMembership(p).facts; } finally { fs.realpathSync.native = orig; fs.statSync = origStat; }
      return { realpaths, stats, receiptLookups, included: [...facts.values()].filter(fact => fact.included).length };
    };
    const included = measure();
    await f.toggle('CostPlaced.ai');
    const excluded = measure();
    // No selection record: an excluded row that owns nothing, or a bulk skip, adds no work to the rule.
    const g = await newProject('Inactive rule cost', { before() { paths.forEach((file, i) => fs.writeFileSync(file, png(5000 + i))); writeWorking('.ai', K, paths); } });
    await g.add(K); await prePackage(g);
    const untouched = measure(g);
    await g.toggle('Owned-7.png');
    const leafExcluded = measure(g);
    neverEngaged(g);
    console.log('# EXCLUDED_DOCUMENT_COST ' + JSON.stringify({ count, included, excluded, untouched, leafExcluded }));
    // The rule stays inactive: its counted work equals merged code's (compared across trees in the PR evidence).
    assert.equal(leafExcluded.included, untouched.included - 1);
    assert.equal(metadataTestHooks.getWorkingSourceMembership(structuredClone(g.current())).excludedAssetDocumentKeys.size, 0);
    assert.deepEqual([included.included, excluded.included], [count + 2, 1], 'the document and every row it alone links leave');
    assert.ok(excluded.realpaths - included.realpaths <= 5 * count + 16, JSON.stringify({ included, excluded }));
    assert.ok(excluded.stats - included.stats <= 2, JSON.stringify({ included, excluded }));
    assert.ok(excluded.receiptLookups - included.receiptLookups <= 2, JSON.stringify({ included, excluded }));
  }));
  // ---- Projects with no working-file selection record (part D).
  const neverEngaged = f => assert.equal(Object.hasOwn(f.current(), 'workingSourceSelections'), false, 'no selection record');
  baselineTest('excluded documents without a selection record: N1b, a shared and an included nested asset, then the required-asset override', { timeout: 180000 }, () => withEnv(async () => {
    const W = desk('Work-b.ai'), K = desk('Keep-b.ai'), P = desk('PlacedB.ai'), Y = desk('NestedB.png'), Y2 = desk('NestedB2.png'), shared = desk('SharedB.png'), side = desk('KeepSide-b.png'), solo = desk('Solo-b.png');
    const f = await newProject('N1b', { before() {
      [[Y, 491], [Y2, 492], [shared, 493], [side, 494], [solo, 495]].forEach(([file, seed]) => fs.writeFileSync(file, png(seed)));
      writeWorking('.ai', P, [Y, Y2, shared]); writeWorking('.ai', K, [P, side, shared]); writeWorking('.ai', W, [solo]);
    } });
    for (const file of [W, K]) await f.add(file);
    await prePackage(f); await verifyScan(f, K); await verifyScan(f, W);
    neverEngaged(f);
    const all = ['Keep-b.ai', 'KeepSide-b.png', 'NestedB.png', 'NestedB2.png', 'PlacedB.ai', 'SharedB.png', 'Solo-b.png', 'Work-b.ai'];
    const without = names => all.filter(name => !names.includes(name));
    assert.deepEqual(await f.written(await f.review()), all);
    await f.toggle('PlacedB.ai');                                                  // per-asset Exclude (honored: no selection record)
    neverEngaged(f);
    const nested = await f.fact('NestedB.png');
    assert.deepEqual([nested.included, nested.excludedSourceOnly], [false, true]);
    assert.deepEqual(await f.written(await f.review()), without(['PlacedB.ai', 'NestedB.png', 'NestedB2.png']), 'the shared asset stays');
    await f.toggle('NestedB2.png');                                                // Include on the withheld row includes it
    assert.equal(f.stored('NestedB2.png').keptAfterSourceExclusion, true);
    assert.deepEqual(f.current().excludedAssetKeys, [P]);
    assert.deepEqual(await f.written(await f.review()), without(['PlacedB.ai', 'NestedB.png']));
    await f.toggle('PlacedB.ai');
    assert.deepEqual(await f.written(await f.review()), all);
    await f.toggle('PlacedB.ai'); roundTripFakeStore();
    assert.deepEqual(await f.written(await f.review()), without(['PlacedB.ai', 'NestedB.png']), 'the Include is sticky, after reload');
    await f.toggle('NestedB2.png');                                                // a second click excludes it
    assert.deepEqual(await f.written(await f.review()), without(['PlacedB.ai', 'NestedB.png', 'NestedB2.png']));
    neverEngaged(f);
    // A selection record appears: the required placed document comes back (existing override) with its links.
    await f.select(W, 'exclude');
    assert.equal((await f.fact('PlacedB.ai')).includedAsDependency, true);
    assert.deepEqual(await f.written(await f.review()), without(['NestedB2.png', 'Solo-b.png', 'Work-b.ai']));
  }));
  baselineTest('excluded documents without a selection record: C2, a document held only by old records is not read until Include', { timeout: 180000 }, () => withEnv(async () => {
    const W = desk('Work-s.ai'), K = desk('Keep-s.ai'), P = desk('PlacedS.ai'), Y = desk('NestedS.png'), Z = desk('LaterS.png'), side = desk('KeepSide-s.png'), solo = desk('Solo-s.png');
    const f = await newProject('C2', { before() {
      [[Y, 501], [Z, 502], [side, 503], [solo, 504]].forEach(([file, seed]) => fs.writeFileSync(file, png(seed)));
      writeWorking('.ai', P, [Y]); writeWorking('.ai', K, [P, side]); writeWorking('.ai', W, [P, solo]);
    } });
    for (const file of [W, K]) await f.add(file);
    await prePackage(f);
    writeWorking('.ai', K, [side]); writeWorking('.ai', W, [solo]); await verifyScan(f, K); await verifyScan(f, W);
    neverEngaged(f);
    const all = ['Keep-s.ai', 'KeepSide-s.png', 'NestedS.png', 'PlacedS.ai', 'Solo-s.png', 'Work-s.ai'], keep = ['Keep-s.ai', 'KeepSide-s.png', 'Solo-s.png', 'Work-s.ai'];
    assert.deepEqual(await f.written(await f.review()), all);
    await f.toggle('PlacedS.ai');
    assert.deepEqual(await f.written(await f.review()), keep);
    writeWorking('.ai', P, [Y, Z]);
    assert.equal(await readsOf(P, () => prePackage(f)), 0, 'the excluded document is not read');
    assert.deepEqual(f.anyRowAt(Z), [], 'its new link is not admitted');
    assert.equal((await metadataTestHooks.runScanOnOpen(f.id, P))?.skipped, 'source-excluded', 'scan-on-open skips the excluded document');
    assert.deepEqual(f.anyRowAt(Z), []);
    roundTripFakeStore();
    assert.deepEqual(await f.written(await f.review()), keep, 'after reload');
    await f.toggle('PlacedS.ai');
    assert.ok(await readsOf(P, () => prePackage(f)) > 0);
    assert.ok(f.current().files.some(row => row.path === Z), 'admitted on the first pass after Include');
    assert.deepEqual(await f.written(await f.review()), [...all, 'LaterS.png'].sort());
    neverEngaged(f);
    // A link known only through the excluded document's own scan receipt. Work-r.ai's Add Files scan
    // admits Placed-r.ai and Linked-r.png; Work-r.ai then drops the link, and the link's row carries no
    // source field (as in an older store), so no other row names Placed-r.ai.
    const WR = desk('Work-r2.ai'), PR = desk('Placed-r2.ai'), YR = desk('Linked-r2.png');
    const g = await newProject('C2 receipt only', { before() { fs.writeFileSync(YR, png(505)); writeWorking('.ai', PR, [YR]); writeWorking('.ai', WR, [PR, YR]); } });
    await g.add(WR);
    await verifyScan(g, PR);
    assert.ok(metadataTestHooks.getWorkingSourceVerification(g.current(), g.current().files.find(row => row.path === PR)).requiredReferences.some(ref => ref.path === YR));
    writeWorking('.ai', WR, [PR]); await verifyScan(g, WR);
    const linked = g.current().files.find(row => row.path === YR);
    assert.equal(linked.source, 'scan-on-open');
    delete linked.assetBaselineSourcePath; delete linked.dependencyOwners; if (linked.captureEvidence) { delete linked.captureEvidence.relationshipSourcePath; delete linked.captureEvidence.sourceDocumentPath; }
    roundTripFakeStore();
    assert.equal(g.current().files.some(row => [row.assetBaselineSourcePath, row.captureEvidence?.relationshipSourcePath, ...(row.dependencyOwners || [])].includes(PR)), false, 'no row names the document');
    const withDocument = ['Linked-r2.png', 'Placed-r2.ai', 'Work-r2.ai'];
    assert.deepEqual(await g.written(await g.review()), withDocument);
    await g.toggle('Placed-r2.ai');
    neverEngaged(g);
    assert.deepEqual(await g.written(await g.review()), ['Work-r2.ai'], 'the receipt-only link leaves with its document');
    await g.toggle('Placed-r2.ai');
    assert.deepEqual(await g.written(await g.review()), withDocument, 'Include returns it');
  }));
  baselineTest('excluded documents without a selection record: Skip existing assets is not an Exclude of a document', { timeout: 180000 }, () => withEnv(async () => {
    const W = desk('Work-k.ai'), K = desk('Keep-k2.ai'), P = desk('PlacedH.ai'), Y = desk('NestedH.png'), side = desk('KeepSide-k2.png'), solo = desk('Solo-k.png'), Z = desk('NewInSkippedH.png');
    const f = await newProject('Bulk skip', { before() {
      [[Y, 511], [side, 512], [solo, 513], [Z, 514]].forEach(([file, seed]) => fs.writeFileSync(file, png(seed)));
      writeWorking('.ai', P, [Y]); writeWorking('.ai', W, [solo]); writeWorking('.ai', K, [P, side]);
    } });
    for (const file of [K, W]) await f.add(file);
    await prePackage(f);
    await f.bulk('skip');
    neverEngaged(f);
    assert.ok(f.current().excludedAssetKeys.includes(P));
    const first = await f.written(await f.review());
    assert.equal(first.includes('PlacedH.ai'), false);
    assert.ok(first.includes('NestedH.png'), 'a skipped document keeps its later-found link, as before: ' + JSON.stringify(first));
    writeWorking('.ai', P, [Y, Z]);
    assert.ok(await readsOf(P, () => prePackage(f)) > 0, 'the skipped document is still read');
    assert.deepEqual(await f.written(await f.review()), [...first, 'NewInSkippedH.png'].sort());
  }));
  // ---- Placed Photoshop files (part C): an output's extraction record ties it to its parent.
  // Work-<t>.ai and Keep-<t>.ai place PlacedA-<t>.psd and PlacedB-<t>.psd; Keep then drops
  // both links, so only old link records keep the placed files.
  const psdPlaced = async (tag, { sameBytes = false } = {}) => {
    const W = desk(`Work-${tag}.ai`), K = desk(`Keep-${tag}.ai`), A = desk(`PlacedA-${tag}.psd`), B = desk(`PlacedB-${tag}.psd`), side = desk(`KeepSide-${tag}.png`);
    const f = await newProject('PSD ' + tag, { before() {
      fs.writeFileSync(side, png(601)); writeWorking('.psd', A, [], 611); writeWorking('.psd', B, [], sameBytes ? 611 : 622);
      writeWorking('.ai', W, [A, B]); writeWorking('.ai', K, [A, B, side]);
    } });
    for (const file of [W, K]) await f.add(file);
    await prePackage(f);
    writeWorking('.ai', K, [side]); await verifyScan(f, K);
    const outputs = parent => f.current().files.filter(row => row.source === 'psd-embedded' && row.psdExtractionReceipt?.parentPath === parent);
    const toggleRow = async row => assert.ok(Array.isArray(await callIpcRaw('projects:remove-file', f.id, metadataTestHooks.createProjectFileVisualIdentity(f.id, row))));
    const factOfRow = async row => (await f.workspace()).files.find(item => item.visualIdentity === metadataTestHooks.createProjectFileVisualIdentity(f.id, row));
    const keep = [`Keep-${tag}.ai`, `KeepSide-${tag}.png`];
    assert.equal(outputs(A).length, 1); assert.equal(outputs(B).length, 1);
    return { f, W, K, A, B, outputs, toggleRow, factOfRow, keep, name: row => path.basename(row.path) };
  };
  const noChoiceReview = f => assert.deepEqual(f.current().files.filter(row => row.individualChoiceReview !== undefined).map(row => row.name), []);
  baselineTest('placed Photoshop files: excluding one withholds only its own output, for different and identical embedded bytes', { timeout: 240000 }, () => withEnv(async () => {
    for (const sameBytes of [false, true]) {
      const t = await psdPlaced(sameBytes ? 'p1b' : 'p1a', { sameBytes });
      const [a] = t.outputs(t.A), [b] = t.outputs(t.B);
      assert.notEqual(t.name(a), t.name(b));
      await t.f.select(t.W, 'exclude');
      assert.deepEqual(await t.f.written(await t.f.review()), [t.name(a), t.name(b), ...t.keep, path.basename(t.A), path.basename(t.B)].sort());
      await t.f.toggle(path.basename(t.A));                                          // per-asset Exclude of PlacedA
      const fact = await t.factOfRow(a);
      assert.deepEqual([fact.included, fact.excludedSourceOnly], [false, true]);
      assert.deepEqual(await t.f.written(await t.f.review()), [t.name(b), ...t.keep, path.basename(t.B)].sort(), sameBytes ? 'identical bytes' : 'different bytes');
    }
  }, { realMainPsd: true }));
  baselineTest('placed Photoshop files: a parent saved again while included, then excluded, withholds both of its outputs', { timeout: 180000 }, () => withEnv(async () => {
    const t = await psdPlaced('p2');
    writeWorking('.psd', t.A, [], 633); await prePackage(t.f);
    const aRows = t.outputs(t.A), [b] = t.outputs(t.B);
    assert.equal(aRows.length, 2, 'the save adds a row; the earlier row stays');
    await t.f.select(t.W, 'exclude');
    assert.deepEqual(await t.f.written(await t.f.review()), [...aRows.map(t.name), t.name(b), ...t.keep, path.basename(t.A), path.basename(t.B)].sort());
    await t.f.toggle(path.basename(t.A));
    const expected = [t.name(b), ...t.keep, path.basename(t.B)].sort();
    assert.deepEqual(await t.f.written(await t.f.review()), expected);
    roundTripFakeStore();
    assert.deepEqual(await t.f.written(await t.f.review()), expected, 'after reload');
  }, { realMainPsd: true }));
  // No choice is carried between rows: an Include stays on its own row; a row from a later save is new.
  for (const variant of ['changed', 'identical']) {
    baselineTest(`placed Photoshop files: an Include stays on its row; a later save's ${variant}-bytes output is not included`, { timeout: 240000 }, () => withEnv(async () => {
      const t = await psdPlaced('p3' + variant[0]), extra = desk(`ExtraLink-p3${variant[0]}.png`);
      fs.writeFileSync(extra, png(699));
      await t.f.select(t.W, 'exclude');
      await t.f.toggle(path.basename(t.A));                                          // Exclude the parent
      const [a0] = t.outputs(t.A), [b] = t.outputs(t.B);
      await t.toggleRow(a0);                                                         // Include its output
      assert.equal(t.f.current().files.find(row => row.path === a0.path).keptAfterSourceExclusion, true);
      roundTripFakeStore();
      const keptOnly = [t.name(a0), t.name(b), ...t.keep, path.basename(t.B)].sort();
      assert.deepEqual(await t.f.written(await t.f.review()), keptOnly);
      // Saved again: different embedded bytes, or the same embedded bytes in a changed file.
      if (variant === 'changed') writeWorking('.psd', t.A, [], 644); else writeWorking('.psd', t.A, [extra], 611);
      assert.ok(await readsOf(t.A, () => prePackage(t.f)) > 0, 'the excluded placed Photoshop file is still read');
      const aRows = t.outputs(t.A), a1 = aRows.find(row => row.path !== a0.path);
      assert.equal(aRows.length, 2, 'the save adds a new row');
      if (variant === 'identical') assert.equal(a1.psdExtractionReceipt.outputDigest, a0.psdExtractionReceipt.outputDigest);
      else assert.notEqual(a1.psdExtractionReceipt.outputDigest, a0.psdExtractionReceipt.outputDigest);
      const fact = await t.factOfRow(a1);
      assert.deepEqual([fact.included, fact.excludedSourceOnly, fact.excluded], [false, true, false], 'the new row is withheld, not chosen');
      assert.deepEqual(await t.f.written(await t.f.review()), keptOnly, 'the included row is written; the new row is not');
      noChoiceReview(t.f);
      await t.f.toggle(path.basename(t.A));                                          // Include the parent
      const withParent = await t.f.written(await t.f.review());
      assert.ok([t.name(a0), t.name(a1), path.basename(t.A)].every(name => withParent.includes(name)), JSON.stringify(withParent));
      await t.f.toggle(path.basename(t.A));                                          // Exclude it again
      assert.deepEqual(await t.f.written(await t.f.review()), keptOnly);
      noChoiceReview(t.f);
      await t.toggleRow(a1);                                                         // the new row has its own Include
      assert.deepEqual(await t.f.written(await t.f.review()), [...keptOnly, t.name(a1)].sort());
    }, { realMainPsd: true }));
  }
  baselineTest('placed Photoshop files: an individual Exclude of an output behaves as before across a save (changed and identical bytes)', { timeout: 240000 }, () => withEnv(async () => {
    const results = {};
    for (const variant of ['changed', 'identical']) {
      const t = await psdPlaced('p4' + variant[0]), extra = desk(`ExtraLink-p4${variant[0]}.png`);
      fs.writeFileSync(extra, png(698));
      await t.f.select(t.W, 'exclude');
      const [a0] = t.outputs(t.A);
      await t.toggleRow(a0);                                                         // individual Exclude, parent included
      if (variant === 'changed') writeWorking('.psd', t.A, [], 688); else writeWorking('.psd', t.A, [extra], 611);
      await prePackage(t.f);
      results[variant] = { written: await t.f.written(await t.f.review()), rows: t.outputs(t.A).map(row => t.name(row)),
        excluded: t.f.current().excludedAssetKeys.length, review: t.f.current().files.filter(row => row.individualChoiceReview !== undefined).length };
    }
    // Pinned from merged v2.4.x (7ba7589b) on the same fixture.
    assert.deepEqual(results, {
      changed: { written: ['Embedded-Layer_1.png', 'Embedded-Layer_2.png', 'Keep-p4c.ai', 'KeepSide-p4c.png', 'PlacedA-p4c.psd', 'PlacedB-p4c.psd'],
        rows: ['Embedded-Layer.png', 'Embedded-Layer_2.png'], excluded: 1, review: 0 },
      identical: { written: ['Embedded-Layer_1.png', 'Keep-p4i.ai', 'KeepSide-p4i.png', 'PlacedA-p4i.psd', 'PlacedB-p4i.psd'],
        rows: ['Embedded-Layer.png'], excluded: 1, review: 0 } });
  }, { realMainPsd: true }));
  baselineTest('placed Photoshop files: a kept output of an excluded parent is repaired after full cache loss', { timeout: 180000 }, () => withEnv(async () => {
    const t = await psdPlaced('p5');
    await t.f.select(t.W, 'exclude');
    await t.f.toggle(path.basename(t.A));
    const [a0] = t.outputs(t.A), [b] = t.outputs(t.B);
    await t.toggleRow(a0);
    const expected = [t.name(a0), t.name(b), ...t.keep, path.basename(t.B)].sort();
    assert.deepEqual(await t.f.written(await t.f.review()), expected);
    for (const dir of new Set([a0, b].map(row => path.dirname(row.path)))) for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { force: true });
    assert.equal((await t.f.review()).materializable, false, 'refused until repaired');
    await prePackage(t.f);
    assert.deepEqual(await t.f.written(await t.f.review()), expected, 'repaired from the excluded parent and written');
  }, { realMainPsd: true }));
  baselineTest('placed Photoshop files: a withheld parent\'s missing output does not lend its name to another file\'s new object', { timeout: 180000 }, () => withEnv(async () => {
    const W = desk('Work-p6.ai'), K = desk('Keep-p6.ai'), A = desk('PlacedA-p6.psd'), B = desk('PlacedB-p6.psd'), side = desk('KeepSide-p6.png');
    const f = await newProject('PSD p6', { before() {
      fs.writeFileSync(side, png(601)); writeWorking('.psd', A, [], 611); writeWorking('.psd', B, [], 622); writeWorking('.ai', W, [A]); writeWorking('.ai', K, [B, side]);
    } });
    for (const file of [W, K]) await f.add(file);
    await prePackage(f);
    await f.select(W, 'exclude');                                                    // PlacedA is withheld with Work
    const outputs = parent => f.current().files.filter(row => row.source === 'psd-embedded' && row.psdExtractionReceipt?.parentPath === parent);
    const [a] = outputs(A), [b0] = outputs(B);
    assert.deepEqual(await f.written(await f.review()), [path.basename(b0.path), 'Keep-p6.ai', 'KeepSide-p6.png', 'PlacedB-p6.psd']);
    fs.rmSync(a.path, { force: true });                                              // the withheld parent's cached output is lost
    writeWorking('.psd', B, [], 677); await verifyScan(f, K);
    await prePackage(f);
    const bRows = outputs(B), b1 = bRows.find(row => row.path !== b0.path);
    assert.ok(b1, 'the new object gets its own row on the first pass');
    assert.notEqual(path.basename(b1.path).toLowerCase(), path.basename(a.path).toLowerCase(), 'not at the withheld row\'s path');
    assert.equal(fs.existsSync(a.path), false);
    assert.deepEqual(await f.written(await f.review()), [path.basename(b0.path), path.basename(b1.path), 'Keep-p6.ai', 'KeepSide-p6.png', 'PlacedB-p6.psd'].sort(),
      'written in the first package; the missing withheld output does not block');
  }, { realMainPsd: true }));
}
