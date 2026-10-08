'use strict';

// Run production main/IPC/store/package gates with the existing dependency-free
// Electron harness. Files are synthetic; OS scripting and Adobe are modeled.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const harnessPath = path.join(__dirname, 'provenance-dual-write.test.js');
let harness = fs.readFileSync(harnessPath, 'utf8');
function replaceOnce(before, after) {
  assert.equal(harness.split(before).length - 1, 1, `A1 adapter v1 drift: ${before}`);
  harness = harness.replace(before, after);
}
replaceOnce("const test = require('node:test');", "const continuationTest = require('node:test'); const test = new Proxy(continuationTest, { apply() {} });");
replaceOnce("fs.mkdtempSync(path.join(os.tmpdir(), 'crate-provenance-dual-write-home-'))",
  "fs.mkdtempSync(path.join(process.env.CRATE_TEST_OUTPUT_ROOT || path.dirname(MAIN_UNDER_TEST_ROOT), 'continuation-synthetic-home-'))");
replaceOnce('  captureProjectOperation,\n  runScanOnOpen',
  '  recordWorkingSourceContinuationCandidate, refreshWorkingSourceLocators, getWorkingSourceSelection, getWorkingSourceVerification, getAssetBaselineSourceRecoveryRouteKey, pollPsForProjectCore, observeIllustratorWorkingSourceContinuation,\n  selectProjectFilesForPackaging, getIllustratorScopedProjectView, isObservedPrimarySourceFile, shouldKeepObservedSourceFileForPackaging,\n  expireDocumentIdentityCache() { for (const entry of workingSourceDocumentIdentityCache.values()) entry.expiresAt = 0; },\n  clearDocumentIdentityCache() { workingSourceDocumentIdentityCache.clear(); },\n  seedSelectorScope(id, value) { illustratorActivationScopes.set(id, value); },\n  seedSnapshot(id, value) { illustratorContinuationSnapshots.set(id, value); }, readSnapshot(id) { return illustratorContinuationSnapshots.get(id); },\n  replacePollRefresh(fn) { const previous = applyLiveAppEvidenceRefresh; applyLiveAppEvidenceRefresh = fn; return previous; },\n  replacePollQuery(fn) { const previous = queryIllustratorActiveState; queryIllustratorActiveState = fn; return previous; },\n  captureProjectOperation,\n  runScanOnOpen');
const compiled = new Module(harnessPath, module);
replaceOnce('  runScanOnOpen, beginProjectAssetBaselineScan,',
  '  scanMeasurementState() { return { leases: workingSourceScanLeases, operations: workingSourceScanOperations }; },\n  getWatcherCoordinator,\n  runScanOnOpen, beginProjectAssetBaselineScan,');
compiled.filename = harnessPath;
compiled.paths = Module._nodeModulePaths(__dirname);
compiled._compile(harness + '\n(' + continuationCases.toString() + ')();\n', harnessPath);

function continuationCases() {
  async function psdReceiptFixture(requiredBy = null) {
    const f = await fixture();
    const rows = Object.fromEntries(['A.psd', 'B.ai', 'C.ai', 'Shared.png'].map(name => {
      const filePath = path.join(TEST_HOME, 'Desktop', name);
      fs.writeFileSync(filePath, name.endsWith('.ai') ? '%PDF-1.7\n%%EOF\n' : `synthetic ${name}`);
      return [name, { fileId: name, path: filePath, name, ext: path.extname(name),
        projectRole: name.endsWith('.png') ? 'asset' : 'source', source: 'user-added', addedAt: Date.now() }];
    }));
    f.stored().files = Object.values(rows); roundTripFakeStore();
    currentPsdFixture = { children: [], linkedFiles: [
      { id: 'embedded-producer', name: 'Embedded.png', data: Buffer.from('old embedded bytes') },
      { name: 'Shared.png', linkedFile: { fullPath: rows['Shared.png'].path } }
    ] };
    async function choose(name, action) {
      const row = (await callIpcRaw('projects:get-asset-workspace', f.id)).files.find(item => item.name === name);
      assert.ok(row, name);
      const response = await callIpcRaw('projects:set-working-source-selection', f.id, row.visualIdentity,
        { action, expectedRevision: row.selectionRevision });
      assert.equal(response.success, true, JSON.stringify(response)); return response;
    }
    for (const name of ['A.psd', 'B.ai', 'C.ai']) {
      await choose(name, 'exclude'); await choose(name, 'restore');
    }
    // Use the actual worker-generated receipt and actual trusted pending admission.
    for (const pending of [...f.stored().pendingFiles]) await callIpcRaw('projects:accept-pending', f.id, pending.path);
    const receipt = metadataTestHooks.getWorkingSourceVerification(f.stored(), rows['A.psd']);
    assert.equal(receipt.status, 'scanned'); assert.equal(receipt.requiredEmbeddedOutputs.length, 1);
    assert.ok(receipt.requiredReferences.some(ref => ref.path === rows['Shared.png'].path));
    assert.ok(metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, rows['A.psd'].path, rows['B.ai'].path));
    const candidate = (await callIpcRaw('projects:get-asset-workspace', f.id)).sourceContinuation.candidates[0];
    assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(candidate, 'replace'))).success, true);
    const prior = await callIpcRaw('projects:prepare-package-review', f.id); assert.ok(prior.token);
    if (requiredBy) {
      const name = `${requiredBy}.ai`;
      fs.writeFileSync(rows[name].path, `%PDF-1.7\n${rows['A.psd'].path}\n%%EOF\n`);
      const operation = metadataTestHooks.captureProjectOperation(f.id);
      try {
        const result = await metadataTestHooks.runScanOnOpen(f.id, rows[name].path, operation.activationToken, operation,
          { allowPausedBaseline: true, verifySelectedSource: true, establishBaseline: false });
        assert.equal(result.success, true);
      } finally { operation.close(); }
    }
    return { ...f, rows, choose, receipt: structuredClone(receipt), oldToken: prior.token };
  }

  for (const mode of ['replacement', 'missing']) for (const action of mode === 'missing' ? ['exclude'] : ['exclude', 'restore']) {
    continuationTest(`v19 canonical PSD receipt ${mode} recovery ${action} retains obligations and old-token refusal`, { timeout: 15000 }, async () => {
      const f = await psdReceiptFixture();
      const before = await callIpcRaw('projects:prepare-package-review', f.id); assert.ok(before.token);
      const a = f.rows['A.psd'], original = fs.readFileSync(a.path);
      fs.renameSync(a.path, a.path + '.preserved');
      if (mode === 'replacement') fs.writeFileSync(a.path, 'replacement PSD source bytes');
      const row = (await callIpcRaw('projects:get-asset-workspace', f.id)).files.find(item => item.name === a.name);
      assert.equal(row.sourceSelection, 'invalid');
      assert.deepEqual(row.selectionRecovery.actions, mode === 'missing' ? ['exclude'] : ['exclude', 'restore']);
      const pairs = JSON.stringify(f.stored().workingSourceContinuations);
      const independent = JSON.stringify(metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows['C.ai']));
      let release = () => {}, unpause = () => {}, restore;
      try {
        if (action === 'restore') {
          let entered; const started = new Promise(resolve => { entered = resolve; });
          const gate = new Promise(resolve => { release = resolve; });
          currentPsdFixture.linkedFiles[0].data = Buffer.from('new embedded bytes');
          unpause = metadataTestHooks.pausePsdExtraction(async () => { entered(); await gate; });
          restore = callIpcRaw('projects:set-working-source-selection', f.id, row.visualIdentity,
            { action, expectedRevision: row.selectionRevision });
          await started;
          const pending = metadataTestHooks.getWorkingSourceVerification(f.stored(), a);
          assert.equal(pending.status, 'pending'); assert.equal(pending.sourceIdentity, null);
          assert.equal(pending.sourceFingerprint, f.receipt.sourceFingerprint);
          assert.deepEqual(pending.requiredEmbeddedOutputs, f.receipt.requiredEmbeddedOutputs);
          assert.deepEqual(pending.requiredReferences, f.receipt.requiredReferences);
          assert.equal((await callIpcRaw('projects:package', f.id, TEST_HOME, before.token)).error, 'package_review_stale');
          release(); assert.equal((await restore).verificationStatus, 'scanned');
        } else await f.choose('A.psd', action);
        roundTripFakeStore();
        const receipt = metadataTestHooks.getWorkingSourceVerification(f.stored(), a); assert.ok(receipt);
        assert.equal(receipt.status, action === 'restore' ? 'scanned' : 'stale');
        assert.ok(receipt.requiredReferences.some(ref => ref.path === f.rows['Shared.png'].path));
        assert.equal(receipt.requiredEmbeddedOutputs.length, 1);
        if (action === 'restore') {
          const digest = crypto.createHash('sha256').update(fs.readFileSync(a.path)).digest('hex');
          assert.equal(receipt.sourceFingerprint, digest);
          for (const output of receipt.requiredEmbeddedOutputs) {
            assert.equal(output.sourceDigest, digest);
            assert.equal(output.outputDigest, crypto.createHash('sha256').update(fs.readFileSync(output.path)).digest('hex'));
          }
        } else {
          assert.equal(receipt.sourceIdentity, null); assert.equal(receipt.sourceFingerprint, f.receipt.sourceFingerprint);
          assert.deepEqual(receipt.requiredEmbeddedOutputs, f.receipt.requiredEmbeddedOutputs);
        }
        assert.equal(JSON.stringify(f.stored().workingSourceContinuations), pairs);
        assert.equal(JSON.stringify(metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows['C.ai'])), independent);
        assert.deepEqual(fs.readFileSync(a.path + '.preserved'), original);
        assert.equal((await callIpcRaw('projects:package', f.id, TEST_HOME, before.token)).error, 'package_review_stale');
      } finally { release(); unpause(); if (restore) await restore; clearTrackedTimers(); }
    });
  }

  for (const requiredBy of ['B', 'C']) for (const mode of ['replacement', 'missing']) {
    continuationTest(`v19 PSD ${mode} A required by ${requiredBy} retains canonical stale obligations after Exclude/reload`, { timeout: 15000 }, async () => {
      const f = await psdReceiptFixture(requiredBy), a = f.rows['A.psd'];
      const before = { token: f.oldToken };
      fs.renameSync(a.path, a.path + '.preserved');
      if (mode === 'replacement') fs.writeFileSync(a.path, 'different PSD bytes');
      await f.choose('A.psd', 'exclude'); roundTripFakeStore();
      const receipt = metadataTestHooks.getWorkingSourceVerification(f.stored(), a);
      assert.equal(receipt.status, 'stale'); assert.equal(receipt.sourceIdentity, null);
      assert.deepEqual(receipt.requiredEmbeddedOutputs, f.receipt.requiredEmbeddedOutputs);
      assert.deepEqual(receipt.requiredReferences, f.receipt.requiredReferences);
      const workspace = await callIpcRaw('projects:get-asset-workspace', f.id);
      assert.equal(workspace.files.find(row => row.name === a.name).includedAsDependency, true);
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).token, undefined);
      assert.equal((await callIpcRaw('projects:package', f.id, TEST_HOME, before.token)).error, 'package_review_stale');
      clearTrackedTimers();
    });
  }

  for (const fault of ['missing', 'rejected', 'changed-bytes']) {
    continuationTest(`v19 canonical PSD output ${fault} after Restore cannot gain package authority`, { timeout: 15000 }, async () => {
      const f = await psdReceiptFixture('C'), a = f.rows['A.psd'];
      const before = { token: f.oldToken };
      fs.renameSync(a.path, a.path + '.preserved'); fs.writeFileSync(a.path, 'restored current PSD bytes');
      await f.choose('A.psd', 'restore');
      for (const pending of [...f.stored().pendingFiles]) await callIpcRaw('projects:accept-pending', f.id, pending.path);
      const receipt = metadataTestHooks.getWorkingSourceVerification(f.stored(), a);
      assert.equal(receipt.status, 'scanned');
      const output = receipt.requiredEmbeddedOutputs[0];
      if (fault === 'missing') fs.unlinkSync(output.path);
      if (fault === 'changed-bytes') fs.writeFileSync(output.path, 'foreign output bytes');
      if (fault === 'rejected') {
        const stored = f.stored(), row = stored.files.find(item => item.path === output.path); assert.ok(row);
        stored.files = stored.files.filter(item => item !== row); stored.pendingFiles.push(row);
        await callIpcRaw('projects:reject-pending', f.id, output.path);
      }
      roundTripFakeStore();
      assert.deepEqual(metadataTestHooks.getWorkingSourceVerification(f.stored(), a).requiredEmbeddedOutputs, receipt.requiredEmbeddedOutputs);
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).token, undefined);
      assert.equal((await callIpcRaw('projects:package', f.id, TEST_HOME, before.token)).error, 'package_review_stale');
      clearTrackedTimers();
    });
  }

  function measurementFixture(f) {
    const vm = require('node:vm'), file = path.join(__dirname, 'keynote-permission-preflight.test.js');
    const text = fs.readFileSync(file, 'utf8');
    const scope = { Buffer: require('node:buffer').Buffer, require: require('node:module').createRequire(file), __dirname, console };
    vm.createContext(scope); vm.runInContext(text.slice(0, text.indexOf('\ntest(')), scope);
    const measurement = scope.fixture({ projects: [f.stored()], scanState: metadataTestHooks.scanMeasurementState() });
    measurement.context.store.get = () => [f.stored()];
    const coordinator = metadataTestHooks.getWatcherCoordinator(f.id);
    assert.equal(coordinator.snapshot(f.id).cancelled, true);
    assert.equal(coordinator.snapshot(f.id).running, false);
    measurement.context.watcherCoordinators.set(f.id, coordinator);
    return measurement;
  }

  for (const retiring of [false, true]) {
    continuationTest(`v19 production paused Restore ${retiring ? 'cancelled retirement' : 'active scan'} keeps measurement BUSY until fully drained`, { timeout: 15000 }, async () => {
      const f = await psdReceiptFixture(), a = f.rows['A.psd'];
      await f.choose('A.psd', 'exclude');
      let entered, release; const started = new Promise(resolve => { entered = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      const unpause = retiring
        ? metadataTestHooks.pausePsdFinish(async () => { entered(); await gate; })
        : metadataTestHooks.pausePsdExtraction(async () => { entered(); await gate; });
      let restore;
      try {
        restore = f.choose('A.psd', 'restore'); await started;
        const measurement = measurementFixture(f);
        assert.equal((await measurement.api.runKeynotePermissionPreflightOnce()).outcome, 'BUSY');
        assert.equal(measurement.calls.length, 0);
        if (retiring) {
          await f.choose('A.psd', 'exclude'); await restore;
          assert.equal((await measurement.api.runKeynotePermissionPreflightOnce()).outcome, 'BUSY');
          assert.equal(measurement.calls.length, 0);
        }
        release(); await restore;
        for (let turn = 0; metadataTestHooks.scanMeasurementState().operations.size && turn < 100; turn++) {
          await new Promise(resolve => setImmediate(resolve));
        }
        assert.equal(metadataTestHooks.scanMeasurementState().operations.size, 0);
        assert.equal(metadataTestHooks.scanMeasurementState().leases.size, 0);
        assert.equal((await measurement.api.runKeynotePermissionPreflightOnce()).outcome, 'CALLER_UNBOUND');
        assert.equal((await measurement.api.runKeynotePermissionPreflightOnce()).outcome, 'UNAVAILABLE');
        assert.equal(measurement.calls.filter(call => call[0] === 'runner').length, 1);
      } finally { release(); unpause(); if (restore) await restore; clearTrackedTimers(); }
    });
  }

  async function fixture() {
    resetTestHomeWorkspace();
    setChildProcessHandler(() => ({ stdout: '' }));
    const project = await createProject('Synthetic continuation');
    await callIpcRaw('projects:pause', project.id);
    clearTrackedTimers();
    const files = ['Original.ai', 'Successor.ai', 'Unrelated.ai'].map(name => {
      const sourcePath = path.join(TEST_HOME, 'Desktop', name);
      fs.writeFileSync(sourcePath, '%PDF-1.7\n%%EOF\n');
      return { fileId: name, path: sourcePath, name, ext: '.ai', projectRole: 'source', source: 'user-added', addedAt: Date.now() };
    });
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    stored.files = files; stored.pendingFiles = [];
    stored.assetBaseline = { schemaVersion: 1, status: 'legacy-included', decision: 'include', establishedAt: Date.now() };
    roundTripFakeStore();
    return { id: project.id, files, stored: () => storeInstance.data.projects.find(item => item.id === project.id) };
  }
  function request(candidate, choice) {
    return { pairIdentity: candidate.pairIdentity, evidenceIdentity: candidate.evidenceIdentity, expectedRevision: candidate.revision,
      predecessorSelectionRevision: candidate.predecessor.selectionRevision, successorSelectionRevision: candidate.successor.selectionRevision, choice };
  }

  async function multipleSelectedFixture({ predecessorRequired = false } = {}) {
    const f = await fixture();
    const names = ['A.ai', 'B.ai', 'C.ai', 'D.ai', 'Shared.png', 'AB.png', 'C-only.png', 'D-only.png'];
    const rows = Object.fromEntries(names.map(name => {
      const filePath = path.join(TEST_HOME, 'Desktop', name);
      const source = name.endsWith('.ai');
      fs.writeFileSync(filePath, source ? '%PDF-1.7\n%%EOF\n' : `synthetic asset ${name}`);
      return [name, { fileId: name, name, path: filePath, ext: path.extname(name), projectRole: source ? 'source' : 'asset',
        source: source ? 'lsof' : 'ai-linked', acceptedPending: true, addedAt: Date.now(),
        captureEvidence: { appFamily: 'illustrator', savedEvidence: true } }];
    }));
    const save = (name, linkedNames) => fs.writeFileSync(rows[name].path,
      `%PDF-1.7\n${linkedNames.map(link => rows[link].path).join('\n')}\n%%EOF\n`);
    save('A.ai', ['Shared.png', 'AB.png']); save('B.ai', ['Shared.png', 'AB.png']);
    save('C.ai', ['Shared.png', 'C-only.png', ...(predecessorRequired ? ['A.ai'] : [])]);
    save('D.ai', ['Shared.png', 'D-only.png']);
    f.stored().files = Object.values(rows); roundTripFakeStore();
    // Model an existing admitted scope, but execute the real scope and observed
    // source selectors below. This fixture does not prove native admission.
    metadataTestHooks.seedSelectorScope(f.id, { activationToken: null, revision: 0, status: 'ready',
      baselineDocumentPaths: new Set(), admittedDocumentPaths: new Set(['A.ai', 'B.ai', 'C.ai', 'D.ai'].map(n => rows[n].path)),
      allowedLinkedPaths: new Set(names.filter(n => n.endsWith('.png')).map(n => rows[n].path)), excludedLinkedPaths: new Set() });
    async function choose(name, action) {
      const workspace = await callIpcRaw('projects:get-asset-workspace', f.id);
      const row = workspace.files.find(file => file.name === name); assert.ok(row, name);
      const result = await callIpcRaw('projects:set-working-source-selection', f.id, row.visualIdentity,
        { action, expectedRevision: row.selectionRevision });
      assert.equal(result.success, true, `${name} ${action}: ${JSON.stringify(result)}`);
    }
    // Real owner-selection IPC and ordinary saved-byte verification, not a
    // forged selection/verification record. Independent C and D stay selected.
    for (const name of ['A.ai', 'C.ai', 'D.ai']) { await choose(name, 'exclude'); await choose(name, 'restore'); }
    await choose('B.ai', 'exclude');
    const independent = JSON.stringify(['C.ai', 'D.ai'].map(name => metadataTestHooks.getWorkingSourceSelection(f.stored(), rows[name])));
    const aBytes = fs.readFileSync(rows['A.ai'].path);
    const selectNames = async () => (await metadataTestHooks.selectProjectFilesForPackaging(f.stored())).map(file => file.name).sort();
    const roots = async () => (await selectNames()).filter(name => name.endsWith('.ai'));
    return { ...f, rows, choose, save, independent, aBytes, selectNames, roots };
  }

  continuationTest('multi-source real selectors Replace A with B preserve C/D and unique/shared dependency union', async () => {
    const f = await multipleSelectedFixture();
    assert.deepEqual(await f.roots(), ['A.ai', 'C.ai', 'D.ai']);
    for (const name of ['A.ai', 'C.ai', 'D.ai']) {
      assert.equal(metadataTestHooks.isObservedPrimarySourceFile(f.rows[name]), true);
      assert.equal(await metadataTestHooks.shouldKeepObservedSourceFileForPackaging(f.rows[name], f.stored()), true);
    }
    assert.ok(metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.rows['A.ai'].path, f.rows['B.ai'].path));
    const workspace = await callIpcRaw('projects:get-asset-workspace', f.id);
    assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(workspace.sourceContinuation.candidates[0], 'replace'))).success, true);
    assert.deepEqual(await f.selectNames(), ['AB.png', 'B.ai', 'C-only.png', 'C.ai', 'D-only.png', 'D.ai', 'Shared.png']);
    assert.equal(JSON.stringify(['C.ai', 'D.ai'].map(name => metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows[name]))), f.independent);
    assert.deepEqual(fs.readFileSync(f.rows['A.ai'].path), f.aBytes);
    const review = await callIpcRaw('projects:prepare-package-review', f.id);
    assert.equal(review.materializable, true); assert.equal(review.totalFiles, 7);
    const result = await callIpc('projects:package', f.id, path.join(TEST_HOME, 'Documents'));
    assert.equal(result.success, true, JSON.stringify(result)); assert.equal(result.totalFiles, 7);
    const copied = fs.readdirSync(result.folderPath, { recursive: true }).filter(name => namesForCopy.has(path.basename(name))).map(name => path.basename(name)).sort();
    assert.deepEqual(copied, await f.selectNames());
    clearTrackedTimers();
  });
  const namesForCopy = new Set(['A.ai', 'B.ai', 'C.ai', 'D.ai', 'Shared.png', 'AB.png', 'C-only.png', 'D-only.png']);

  continuationTest('combined production renderer and backend pair IPC yield fresh review tokens and real synthetic package output', async () => {
    const f = await multipleSelectedFixture();
    assert.ok(metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.rows['A.ai'].path, f.rows['B.ai'].path));
    const vm = require('node:vm');
    const sharedPath = path.join(__dirname, 'renderer-figma-scope.test.js');
    const shared = fs.readFileSync(sharedPath, 'utf8');
    const scope = { require: require('node:module').createRequire(sharedPath), __dirname, console, setTimeout, clearTimeout };
    vm.createContext(scope);
    // Reuse only the existing DOM/renderer fixture declarations; its tests do
    // not run here. No new helper module or native/renderer runtime is loaded.
    vm.runInContext(shared.slice(0, shared.indexOf('\ntest(')), scope);
    const { document, elements } = scope.createInteractiveRendererDom();
    const calls = [], reviews = [], packages = [];
    const crate = {
      getProjects: () => callIpcRaw('projects:get-all'),
      getUsage: () => callIpcRaw('usage:get'),
      getAssetWorkspace: async id => { calls.push('workspace'); return callIpcRaw('projects:get-asset-workspace', id); },
      preparePackageReview: async (id, outputPath) => {
        calls.push('prepare');
        const result = await callIpcRaw('projects:prepare-package-review', id, ...(outputPath === undefined ? [] : [outputPath]));
        reviews.push(result); return result;
      },
      resolveWorkingSourceContinuation: async (id, choice) => {
        calls.push('resolve');
        assert.deepEqual(Object.keys(choice).sort(), ['choice', 'evidenceIdentity', 'expectedRevision', 'pairIdentity', 'predecessorSelectionRevision', 'successorSelectionRevision'].sort());
        return callIpcRaw('projects:resolve-working-source-continuation', id, choice);
      },
      // Pre-scan and native scope establishment remain outside this closed
      // composition control. The package backend still validates saved bytes.
      preScanSession: async () => null,
      packageProject: async (...args) => {
        calls.push('package');
        const result = await callIpcRaw('projects:package', ...args);
        packages.push({ token: args[2], result }); return result;
      },
    };
    const renderer = scope.loadRendererHelpers(document, { crate });
    renderer.fixtureProject = JSON.parse(JSON.stringify(f.stored()));
    renderer.fixtureWorkspace = await callIpcRaw('projects:get-asset-workspace', f.id);
    renderer.fixtureOutput = path.join(TEST_HOME, 'Documents', 'Chosen destination');
    fs.mkdirSync(renderer.fixtureOutput);
    vm.runInContext('state.projects = [fixtureProject]; state.selectedProjectId = fixtureProject.id; state.assetWorkspace = fixtureWorkspace; state.packageOutputPath = fixtureOutput; accountStatus.canUseWorkspace = true;', renderer);
    renderer.setAssetReviewProject(f.id);
    renderer.showToast = () => {};
    try {
      assert.equal(await renderer.showPackageModal({ runPreScan: false }), false);
      assert.equal(reviews.at(-1).error, 'working_source_continuation_choice_required');
      assert.equal(reviews.at(-1).token, undefined);
      assert.equal(vm.runInContext('state.packageReviewToken', renderer), null);
      assert.equal(elements['btn-confirm-package'].disabled, true);
      const pair = reviews.at(-1).sourceContinuation.candidates[0];
      assert.equal(pair.predecessor.name, 'A.ai'); assert.equal(pair.successor.name, 'B.ai');
      assert.equal(scope.getElementTreeText(elements['source-continuation-choices']).includes('Replace'), true);
      const lease = vm.runInContext('packageReviewContents.lease', renderer);
      const beforeChoice = calls.length;
      assert.equal(await renderer.chooseSourceContinuation(renderer.fixtureProject, pair, 'replace', lease), true);
      assert.deepEqual(calls.slice(beforeChoice).slice(0, 3), ['resolve', 'workspace', 'prepare']);
      const fresh = reviews.at(-1);
      assert.equal(fresh.materializable, true);
      assert.equal(fresh.totalFiles, 7);
      assert.equal(vm.runInContext('state.packageReviewToken', renderer), fresh.token);
      assert.equal(elements['btn-confirm-package'].disabled, false);
      assert.deepEqual(await f.selectNames(), ['AB.png', 'B.ai', 'C-only.png', 'C.ai', 'D-only.png', 'D.ai', 'Shared.png']);
      // A destination collision changes the reviewed folder name. The real
      // backend requires a fresh destination-bound review; production renderer
      // consumes that response before a second explicit confirmation.
      fs.mkdirSync(path.join(renderer.fixtureOutput, fresh.folderName));
      await renderer.confirmPackage();
      assert.equal(packages.length, 1);
      assert.equal(packages[0].result.error, 'package_review_changed');
      assert.equal(packages[0].result.reason, 'package_destination_changed');
      const boundToken = vm.runInContext('state.packageReviewToken', renderer);
      assert.ok(boundToken); assert.notEqual(boundToken, fresh.token);
      assert.equal(boundToken, packages[0].result.review.token);
      assert.equal(elements['btn-confirm-package'].disabled, false);
      await renderer.confirmPackage();
      assert.equal(packages.length, 2);
      assert.equal(packages[1].token, boundToken);
      const result = packages[1].result;
      assert.equal(result.success, true, JSON.stringify(result)); assert.equal(result.totalFiles, 7);
      const copied = fs.readdirSync(result.folderPath, { recursive: true }).filter(name => namesForCopy.has(path.basename(name))).map(name => path.basename(name)).sort();
      assert.deepEqual(copied, await f.selectNames());
      assert.equal(JSON.stringify(['C.ai', 'D.ai'].map(name => metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows[name]))), f.independent);
      assert.deepEqual(fs.readFileSync(f.rows['A.ai'].path), f.aBytes);
      for (const name of copied) {
        const relative = fs.readdirSync(result.folderPath, { recursive: true }).find(item => path.basename(item) === name);
        assert.deepEqual(fs.readFileSync(path.join(result.folderPath, relative)), fs.readFileSync(f.rows[name].path));
      }
      await renderer.renderFiles();
    } finally { renderer.hidePackageReviewDialog(); clearTrackedTimers(); }
  });


  async function recoveryRendererBridge(f) {
    const vm = require('node:vm');
    const sharedPath = path.join(__dirname, 'renderer-figma-scope.test.js');
    const shared = fs.readFileSync(sharedPath, 'utf8');
    const scope = { require: require('node:module').createRequire(sharedPath), __dirname, console, setTimeout, clearTimeout };
    vm.createContext(scope); vm.runInContext(shared.slice(0, shared.indexOf('\ntest(')), scope);
    const { document, elements } = scope.createInteractiveRendererDom();
    const calls = [], reviews = [], results = [];
    const crate = {
      getProjects: () => callIpcRaw('projects:get-all'),
      getAssetWorkspace: async id => { calls.push('workspace'); return callIpcRaw('projects:get-asset-workspace', id); },
      preparePackageReview: async id => {
        calls.push('prepare'); const review = await callIpcRaw('projects:prepare-package-review', id); reviews.push(review); return review;
      },
      setWorkingSourceSelection: async (...args) => {
        calls.push('selection');
        assert.equal(vm.runInContext('state.packageReviewToken', renderer), null, 'old token retired before real IPC');
        assert.deepEqual(Object.keys(args[2]).sort(), ['action', 'expectedRevision']);
        const result = await callIpcRaw('projects:set-working-source-selection', ...args); results.push(result); return result;
      },
      resolveWorkingSourceContinuation: (...args) => callIpcRaw('projects:resolve-working-source-continuation', ...args),
      preScanSession: async () => null,
    };
    const renderer = scope.loadRendererHelpers(document, { crate });
    renderer.fixtureProject = JSON.parse(JSON.stringify(f.stored()));
    vm.runInContext('state.projects = [fixtureProject]; state.selectedProjectId = fixtureProject.id; accountStatus.canUseWorkspace = true;', renderer);
    renderer.setAssetReviewProject(f.id); renderer.showToast = () => {};
    await renderer.renderFiles();
    const descendants = node => [node, ...(node.children || []).flatMap(descendants)];
    const row = (name = 'A.ai') => elements['project-file-list'].children.find(item => scope.getElementTreeText(item).includes(name));
    const button = (label, name = 'A.ai') => descendants(row(name)).find(item => item.tagName === 'BUTTON' && item.textContent === label);
    const activate = (label, name = 'A.ai') => { const control = button(label, name); assert.ok(control, `${name} ${label}`); return control.listeners.click[0]({ stopPropagation() {} }); };
    return { renderer, crate, calls, reviews, results, elements, document, row, button, activate,
      read: expression => vm.runInContext(expression, renderer), text: scope.getElementTreeText,
      close: () => { renderer.hidePackageReviewDialog(); clearTrackedTimers(); } };
  }

  async function resolvedRecoveryFixture({ requiredBy = null } = {}) {
    const f = await multipleSelectedFixture({ predecessorRequired: requiredBy === 'C' });
    if (requiredBy === 'B') f.save('B.ai', ['Shared.png', 'AB.png', 'A.ai']);
    assert.ok(metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.rows['A.ai'].path, f.rows['B.ai'].path));
    const candidate = (await callIpcRaw('projects:get-asset-workspace', f.id)).sourceContinuation.candidates[0];
    assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(candidate, 'replace'))).success, true);
    return f;
  }

  for (const listId of ['project-file-list', 'working-assets-list']) {
    continuationTest(`v20 production open and Escape renew ${listId} recovery with one trusted selection IPC`, async () => {
      const f = await resolvedRecoveryFixture();
      fs.renameSync(f.rows['A.ai'].path, f.rows['A.ai'].path + '.preserved');
      f.save('A.ai', ['Shared.png', 'AB.png']);
      const b = await recoveryRendererBridge(f);
      const descendants = node => [node, ...(node.children || []).flatMap(descendants)];
      const control = () => {
        const row = b.elements[listId].children.find(item => b.text(item).includes('A.ai'));
        return descendants(row).find(item => item.tagName === 'BUTTON' && item.textContent === 'Exclude');
      };
      try {
        b.read(`state.assetReviewOpen = ${listId === 'working-assets-list'}`);
        await b.renderer.renderFiles();
        const old = control(); assert.ok(old);
        const initial = await callIpcRaw('projects:get-asset-workspace', f.id);
        const revision = initial.files.find(row => row.name === 'A.ai').selectionRevision;
        const bytes = fs.readFileSync(f.rows['A.ai'].path);
        await b.renderer.showPackageModal({ runPreScan: false });
        assert.equal(b.elements['modal-package'].classList.contains('hidden'), false);
        let prevented = false;
        await b.renderer.handlePackageReviewKeydown({ key: 'Escape', preventDefault() { prevented = true; } });
        assert.equal(prevented, true); assert.equal(b.elements['modal-package'].classList.contains('hidden'), true);
        assert.equal(b.read('state.packageReviewToken'), null);
        assert.equal(b.read("state.assetWorkspace.files.find(row => row.name === 'A.ai').selectionRevision"), revision);
        assert.deepEqual(fs.readFileSync(f.rows['A.ai'].path), bytes);
        assert.equal(await old.listeners.click[0]({ stopPropagation() {} }), false);
        assert.equal(b.calls.filter(call => call === 'selection').length, 0);
        const current = control(); assert.notEqual(current, old); assert.equal(current.disabled, false);
        const requests = [], receiver = b.crate.setWorkingSourceSelection;
        b.crate.setWorkingSourceSelection = (...args) => { requests.push(JSON.parse(JSON.stringify(args))); return receiver(...args); };
        assert.equal(await current.listeners.click[0]({ stopPropagation() {} }), true);
        assert.equal(requests.length, 1);
        assert.deepEqual(requests[0], [f.id, initial.files.find(row => row.name === 'A.ai').visualIdentity,
          { action: 'exclude', expectedRevision: revision }]);
        assert.equal(b.calls.filter(call => call === 'selection').length, 1);
        assert.equal(await old.listeners.click[0]({ stopPropagation() {} }), false);
        assert.equal(b.calls.filter(call => call === 'selection').length, 1);
        assert.deepEqual(fs.readFileSync(f.rows['A.ai'].path), bytes);
        assert.deepEqual(fs.readFileSync(f.rows['A.ai'].path + '.preserved'), f.aBytes);
        assert.equal(JSON.stringify(['C.ai', 'D.ai'].map(name => metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows[name]))), f.independent);
      } finally { b.close(); }
    });
  }

  for (const listId of ['project-file-list', 'working-assets-list']) {
    continuationTest(`v20 trusted late completion unlocks another invalid pair in ${listId} without replay`, async () => {
      const f = await resolvedRecoveryFixture();
      assert.ok(metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.rows['C.ai'].path, f.rows['D.ai'].path));
      const second = (await callIpcRaw('projects:get-asset-workspace', f.id)).sourceContinuation.candidates[0];
      assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(second, 'replace'))).success, true);
      const bytes = {};
      for (const name of ['A.ai', 'C.ai']) {
        bytes[name] = fs.readFileSync(f.rows[name].path);
        fs.renameSync(f.rows[name].path, f.rows[name].path + '.preserved');
      }
      const b = await recoveryRendererBridge(f);
      let release, committed = false;
      const gate = new Promise(resolve => { release = resolve; });
      const receiver = b.crate.setWorkingSourceSelection, requests = [];
      b.crate.setWorkingSourceSelection = async (...args) => {
        requests.push(JSON.parse(JSON.stringify(args)));
        const result = await receiver(...args);
        if (requests.length === 1) { committed = true; await gate; }
        return result;
      };
      const descendants = node => [node, ...(node.children || []).flatMap(descendants)];
      const control = name => {
        const row = b.elements[listId].children.find(item => b.text(item).includes(name));
        return descendants(row).find(item => item.tagName === 'BUTTON' && item.textContent === 'Exclude');
      };
      try {
        b.read(`state.assetReviewOpen = ${listId === 'working-assets-list'}`); await b.renderer.renderFiles();
        const old = control('A.ai'), pending = old.listeners.click[0]({ stopPropagation() {} });
        while (!committed) await new Promise(resolve => setImmediate(resolve));
        await b.renderer.renderFiles();
        const locked = control('C.ai'); assert.ok(locked); assert.equal(locked.disabled, true);
        const revision = b.read("state.assetWorkspace.files.find(row => row.name === 'C.ai').selectionRevision");
        release(); assert.equal(await pending, false);
        assert.equal(b.reviews.length, 0); assert.equal(b.read('state.packageReviewToken'), null);
        const current = control('C.ai'); assert.notEqual(current, locked); assert.equal(current.disabled, false);
        assert.equal(await old.listeners.click[0]({ stopPropagation() {} }), false);
        assert.equal(await locked.listeners.click[0]({ stopPropagation() {} }), false);
        assert.equal(requests.length, 1);
        assert.equal(await current.listeners.click[0]({ stopPropagation() {} }), true);
        assert.equal(requests.length, 2); assert.equal(requests[1][0], f.id);
        assert.deepEqual(requests[1][2], { action: 'exclude', expectedRevision: revision });
        for (const name of ['A.ai', 'C.ai']) assert.deepEqual(fs.readFileSync(f.rows[name].path + '.preserved'), bytes[name]);
        const names = await f.selectNames();
        for (const name of ['B.ai', 'D.ai', 'Shared.png', 'D-only.png']) assert.ok(names.includes(name), name);
      } finally { release(); b.close(); }
    });
  }

  // v21: production account invalidation and renderer controls with the real trusted IPC receiver.
  // DOM, account snapshots, Electron sender, app admission and OS inputs remain modeled.
  for (const listId of ['project-file-list', 'working-assets-list']) {
    for (const transition of ['reauthorize', 'identity-change']) for (const outcome of ['success', 'refusal', 'lost-reply']) {
      continuationTest(`v21 trusted account ${transition} delayed ${outcome} renews ${listId} without token reuse or replay`, async () => {
        const f = await resolvedRecoveryFixture();
        const prior = await callIpcRaw('projects:prepare-package-review', f.id); assert.ok(prior.token);
        assert.ok(metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.rows['C.ai'].path, f.rows['D.ai'].path));
        const second = (await callIpcRaw('projects:get-asset-workspace', f.id)).sourceContinuation.candidates[0];
        assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(second, 'replace'))).success, true);
        const pairDecisions = JSON.stringify(f.stored().workingSourceContinuations);
        const bytes = {};
        for (const name of ['A.ai', 'C.ai']) {
          bytes[name] = fs.readFileSync(f.rows[name].path);
          fs.renameSync(f.rows[name].path, f.rows[name].path + '.preserved');
        }
        const b = await recoveryRendererBridge(f);
        let release, reached;
        const gate = new Promise(resolve => { release = resolve; });
        const received = new Promise(resolve => { reached = resolve; });
        const receiver = b.crate.setWorkingSourceSelection, requests = [];
        b.crate.setWorkingSourceSelection = async (...args) => {
          requests.push(JSON.parse(JSON.stringify(args)));
          const first = requests.length === 1;
          // Inject stale expectedRevision at the boundary to obtain a real receiver refusal.
          const delivered = first && outcome === 'refusal'
            ? [args[0], args[1], { ...args[2], expectedRevision: args[2].expectedRevision + 1 }] : args;
          const result = await receiver(...delivered);
          if (first) {
            reached(result); await gate;
            if (outcome === 'lost-reply') throw Error('lost after real receiver completion');
          }
          return result;
        };
        const descendants = node => [node, ...(node.children || []).flatMap(descendants)];
        const control = name => {
          const row = b.elements[listId].children.find(item => b.text(item).includes(name));
          assert.ok(row, name);
          return descendants(row).find(item => item.tagName === 'BUTTON' && item.textContent === 'Exclude');
        };
        try {
          b.renderer.acceptAccountSnapshot({ revision: 10, state: 'signed_in', canUseWorkspace: true, identity: { id: 'account-a' } });
          b.read(`state.assetReviewOpen = ${listId === 'working-assets-list'}`); await b.renderer.renderFiles();
          b.renderer.oldAccountToken = prior.token; b.read('state.packageReviewToken = oldAccountToken');
          const old = control('A.ai'), pending = old.listeners.click[0]({ stopPropagation() {} });
          const firstResult = await received;
          assert.equal(firstResult.success, outcome !== 'refusal');
          assert.equal(requests.length, 1);
          const oldEpoch = b.read('accountWorkspaceEpoch');
          if (transition === 'reauthorize') {
            b.renderer.acceptAccountSnapshot({ revision: 11, state: 'signed_out', canUseWorkspace: false, identity: null });
            assert.equal(b.read('state.assetWorkspace'), null);
          }
          b.renderer.acceptAccountSnapshot({ revision: 12, state: 'signed_in', canUseWorkspace: true,
            identity: { id: transition === 'reauthorize' ? 'account-a' : 'account-b' } });
          assert.ok(b.read('accountWorkspaceEpoch') > oldEpoch);
          assert.equal(b.read('state.assetWorkspace'), null);
          const fresh = await b.renderer.renderFiles();
          assert.equal(b.renderer.isAuthoritativeWorkspaceRefresh(fresh, f.id), true);
          const target = outcome === 'refusal' ? 'A.ai' : 'C.ai';
          const targetRow = fresh.workspace.files.find(row => row.name === target);
          assert.equal(targetRow.sourceSelection, 'invalid');
          const locked = control(target); assert.ok(locked); assert.equal(locked.disabled, true);
          assert.equal(await locked.listeners.click[0]({ stopPropagation() {} }), false);
          const reads = b.calls.filter(call => call === 'workspace').length;
          release(); assert.equal(await pending, false, 'account-stale completion cannot apply or open a review');
          assert.equal(b.read('state.assetWorkspace'), fresh.workspace);
          assert.equal(b.calls.filter(call => call === 'workspace').length, reads);
          assert.equal(b.reviews.length, 0); assert.equal(b.read('state.packageReviewToken'), null);
          assert.equal(b.read('workingSourceRecoveryOwner'), null);
          assert.equal(requests.length, 1); assert.equal(b.results.length, 1);
          assert.equal((await callIpcRaw('projects:package', f.id, TEST_HOME, prior.token)).error, 'package_review_stale');
          const current = control(target); assert.ok(current); assert.notEqual(current, locked); assert.equal(current.disabled, false);
          assert.equal(await old.listeners.click[0]({ stopPropagation() {} }), false);
          assert.equal(await locked.listeners.click[0]({ stopPropagation() {} }), false);
          assert.equal(requests.length, 1, 'settlement and stale callbacks never replay a mutation');
          assert.equal(await current.listeners.click[0]({ stopPropagation() {} }), true);
          assert.equal(requests.length, 2); assert.equal(b.results.length, 2);
          assert.deepEqual(requests[1], [f.id, targetRow.visualIdentity, { action: 'exclude', expectedRevision: targetRow.selectionRevision }]);
          assert.equal(await current.listeners.click[0]({ stopPropagation() {} }), false);
          assert.equal(requests.length, 2, 'one subsequent explicit current-revision request');
          assert.notEqual(b.read('state.packageReviewToken'), prior.token);
          assert.equal(JSON.stringify(f.stored().workingSourceContinuations), pairDecisions, 'both pair decisions remain unchanged');
          for (const name of ['A.ai', 'C.ai']) assert.deepEqual(fs.readFileSync(f.rows[name].path + '.preserved'), bytes[name]);
          for (const name of ['B.ai', 'D.ai']) assert.equal(metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows[name]).state, 'selected');
          if (outcome !== 'refusal') {
            const names = await f.selectNames();
            for (const name of ['B.ai', 'D.ai', 'Shared.png', 'D-only.png']) assert.ok(names.includes(name), name);
          }
        } finally { release(); b.close(); }
      });
    }
  }

  for (const mode of ['replaced-A', 'missing-A', 'changed-B', 'missing-B', 'demoted-B']) {
    for (const action of mode === 'missing-A' ? ['exclude'] : ['exclude', 'restore']) {
      continuationTest(`v14 production recovery bridge ${mode} ${action} preserves independent intent and bytes`, async () => {
        const f = await resolvedRecoveryFixture();
        const prior = await callIpcRaw('projects:prepare-package-review', f.id); assert.ok(prior.token);
        if (mode === 'replaced-A' || mode === 'missing-A') {
          fs.renameSync(f.rows['A.ai'].path, f.rows['A.ai'].path + '.preserved');
          if (mode === 'replaced-A') f.save('A.ai', ['Shared.png', 'AB.png']);
        } else if (mode === 'changed-B' || mode === 'missing-B') {
          fs.renameSync(f.rows['B.ai'].path, f.rows['B.ai'].path + '.preserved');
          if (mode === 'changed-B') { f.save('B.ai', ['Shared.png', 'AB.png']); await ordinaryReverify(f, 'B.ai'); }
        } else {
          f.stored().files = f.stored().files.filter(row => row.name !== 'B.ai'); f.stored().pendingFiles = [f.rows['B.ai']];
        }
        const invalid = await callIpcRaw('projects:get-asset-workspace', f.id);
        const a = invalid.files.find(row => row.name === 'A.ai'); assert.equal(a.sourceSelection, 'invalid');
        const pairSnapshot = JSON.stringify(f.stored().workingSourceContinuations);
        const b = await recoveryRendererBridge(f);
        try {
          assert.match(b.text(b.row()), /Needs attention/);
          if (mode === 'missing-A') assert.equal(b.button('Restore'), undefined);
          b.renderer.oldToken = prior.token; b.read('state.packageReviewToken = oldToken');
          const start = b.calls.length;
          assert.equal(await b.activate(action === 'exclude' ? 'Exclude' : 'Restore'), true);
          assert.deepEqual(b.calls.slice(start, start + 3), ['selection', 'workspace', 'prepare']);
          const latest = (await callIpcRaw('projects:get-asset-workspace', f.id)).files.find(row => row.name === 'A.ai');
          assert.equal(latest.selectionRevision, a.selectionRevision + 1);
          assert.equal(latest.sourceSelection, action === 'exclude' ? 'excluded' : 'selected');
          assert.equal(latest.selectionRecovery, undefined);
          assert.equal(JSON.stringify(f.stored().workingSourceContinuations), pairSnapshot, 'no pair decision transfer');
          assert.equal(JSON.stringify(['C.ai', 'D.ai'].map(name => metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows[name]))), f.independent);
          assert.deepEqual(fs.readFileSync(f.rows['A.ai'].path + (mode.endsWith('-A') ? '.preserved' : '')), f.aBytes);
          const fresh = b.reviews.at(-1);
          if (mode === 'missing-B' || (mode === 'demoted-B' && action === 'restore')) { assert.equal(fresh.token, undefined); assert.equal(b.read('state.packageReviewToken'), null); }
          else {
            assert.equal(fresh.materializable, true); assert.ok(fresh.token); assert.notEqual(fresh.token, prior.token);
            assert.equal(b.read('state.packageReviewToken'), fresh.token);
            const names = await f.selectNames();
            for (const name of ['C.ai', 'D.ai', 'Shared.png', 'C-only.png', 'D-only.png']) assert.ok(names.includes(name), name);
            if (mode === 'demoted-B') {
              assert.equal(names.includes('B.ai'), false);
              assert.equal(names.includes('AB.png'), true, 'independently accepted asset is preserved, not swept with the excluded role');
              assert.equal(f.stored().pendingFiles.some(row => row.name === 'B.ai'), true);
              assert.equal(f.stored().files.some(row => row.name === 'B.ai'), false);
            } else for (const name of ['B.ai', 'AB.png']) assert.ok(names.includes(name), name);
            assert.equal(names.filter(name => name === 'Shared.png').length, 1);
          }
        } finally { b.close(); }
      });
    }
  }

  for (const requiredBy of ['B', 'C']) for (const mode of ['replacement', 'missing']) {
    continuationTest(`v14 production recovery ${mode} A required by ${requiredBy} still blocks dependency closure after Exclude`, async () => {
      const f = await resolvedRecoveryFixture({ requiredBy });
      fs.renameSync(f.rows['A.ai'].path, f.rows['A.ai'].path + '.preserved');
      if (mode === 'replacement') f.save('A.ai', ['Shared.png', 'AB.png']);
      const b = await recoveryRendererBridge(f);
      try {
        assert.match(b.text(b.row()), /does not remove that requirement/);
        assert.equal(await b.activate('Exclude'), true);
        const a = (await callIpcRaw('projects:get-asset-workspace', f.id)).files.find(row => row.name === 'A.ai');
        assert.equal(a.sourceSelection, 'excluded'); assert.equal(a.includedAsDependency, true);
        assert.equal(a.verificationStatus, 'stale'); assert.equal(b.reviews.at(-1).token, undefined);
        assert.equal(b.read('state.packageReviewToken'), null);
        assert.equal(JSON.stringify(['C.ai', 'D.ai'].map(name => metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows[name]))), f.independent);
        assert.deepEqual(fs.readFileSync(f.rows['A.ai'].path + '.preserved'), f.aBytes);
      } finally { b.close(); }
    });
  }

  for (const fault of ['workspace-failure', 'overlap', 'lost-reply']) {
    continuationTest(`v14 trusted recovery ${fault} uses actual renderer refresh and never replays mutation`, async () => {
      const f = await resolvedRecoveryFixture();
      fs.renameSync(f.rows['A.ai'].path, f.rows['A.ai'].path + '.preserved'); f.save('A.ai', ['Shared.png', 'AB.png']);
      const b = await recoveryRendererBridge(f);
      let release; const gate = new Promise(resolve => { release = resolve; });
      try {
        const originalWorkspace = b.crate.getAssetWorkspace, originalSelection = b.crate.setWorkingSourceSelection;
        let reads = 0;
        b.crate.getAssetWorkspace = async id => {
          if (fault === 'workspace-failure') throw Error('actual caught workspace failure');
          if (fault === 'overlap' && ++reads === 1) await gate;
          return originalWorkspace(id);
        };
        b.crate.setWorkingSourceSelection = async (...args) => { const result = await originalSelection(...args); if (fault === 'lost-reply') throw Error('reply lost after commit'); return result; };
        const pending = b.activate('Exclude');
        if (fault === 'overlap') { while (reads === 0) await new Promise(r => setImmediate(r)); await b.renderer.renderFiles(); release(); }
        const succeeded = await pending;
        assert.equal(succeeded, false); assert.equal(b.results.length, 1); assert.equal(b.results[0].success, true);
        assert.equal(metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows['A.ai']).reason, 'user-excluded');
        if (fault === 'lost-reply') { assert.equal(b.reviews.length, 1); assert.ok(b.read('state.packageReviewToken')); }
        else { assert.equal(b.reviews.length, 0); assert.equal(b.read('state.packageReviewToken'), null); }
      } finally { release(); b.close(); }
    });
  }

  for (const fault of ['stale', 'foreign-identity', 'foreign-project']) {
    continuationTest(`v14 trusted recovery receiver refuses ${fault} despite formerly eligible renderer projection`, async () => {
      const f = await resolvedRecoveryFixture(); fs.renameSync(f.rows['A.ai'].path, f.rows['A.ai'].path + '.preserved');
      const b = await recoveryRendererBridge(f), before = JSON.stringify(f.stored().workingSourceSelections);
      try {
        const receiver = b.crate.setWorkingSourceSelection;
        b.crate.setWorkingSourceSelection = (id, identity, command) => receiver(fault === 'foreign-project' ? 'foreign-project' : id,
          fault === 'foreign-identity' ? 'foreign-identity' : identity, fault === 'stale' ? { ...command, expectedRevision: command.expectedRevision - 1 } : command);
        assert.equal(await b.activate('Exclude'), false); assert.equal(b.results[0].success, false);
        assert.equal(JSON.stringify(f.stored().workingSourceSelections), before);
        assert.equal(b.read('state.packageReviewToken'), null);
      } finally { b.close(); }
    });
  }

  for (const fault of ['malformed', 'ambiguous']) {
    continuationTest(`v14 real ${fault} invalid projection has no renderer recovery control`, async () => {
      const f = await resolvedRecoveryFixture();
      fs.renameSync(f.rows['A.ai'].path, f.rows['A.ai'].path + '.preserved');
      if (fault === 'malformed') {
        const key = metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(), f.rows['A.ai']);
        f.stored().workingSourceSelections[key].revision = -1;
      } else f.stored().files.push({ ...f.rows['A.ai'], fileId: 'duplicate-A' });
      const b = await recoveryRendererBridge(f);
      try { assert.equal(b.button('Exclude'), undefined); assert.equal(b.button('Restore'), undefined); assert.equal(b.results.length, 0); }
      finally { b.close(); }
    });
  }

  continuationTest('v14 recovering one resolved pair preserves an independent pending pair hold', async () => {
    const f = await resolvedRecoveryFixture();
    assert.ok(metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.rows['C.ai'].path, f.rows['D.ai'].path));
    const before = JSON.stringify(f.stored().workingSourceContinuations);
    fs.renameSync(f.rows['A.ai'].path, f.rows['A.ai'].path + '.preserved');
    const b = await recoveryRendererBridge(f);
    try {
      assert.equal(await b.activate('Exclude'), true);
      assert.equal(b.reviews.at(-1).error, 'working_source_continuation_choice_required');
      assert.equal(b.reviews.at(-1).sourceContinuation.candidates.length, 1);
      assert.equal(b.reviews.at(-1).sourceContinuation.candidates[0].predecessor.name, 'C.ai');
      assert.equal(b.read('state.packageReviewToken'), null); assert.equal(JSON.stringify(f.stored().workingSourceContinuations), before);
      assert.deepEqual(fs.readFileSync(f.rows['A.ai'].path + '.preserved'), f.aBytes);
    } finally { b.close(); }
  });


  for (const invalidation of ['accountWorkspaceEpoch += 1', "state.selectedProjectId = 'foreign'", 'projectSelectionEpoch += 1',
    'tabNavigationEpoch += 1', 'modalLeaseSequence += 1', 'assetWorkspaceRequestGeneration += 1', 'packageReviewRequestId += 1']) {
    continuationTest(`v14 production recovery bridge discards committed late reply after ${invalidation}`, async () => {
      const f = await resolvedRecoveryFixture(); fs.renameSync(f.rows['A.ai'].path, f.rows['A.ai'].path + '.preserved');
      const b = await recoveryRendererBridge(f); let release; const gate = new Promise(resolve => { release = resolve; });
      const receiver = b.crate.setWorkingSourceSelection;
      let committed = false;
      b.crate.setWorkingSourceSelection = async (...args) => { const result = await receiver(...args); committed = true; await gate; return result; };
      try {
        const pending = b.activate('Exclude'); while (!committed) await new Promise(r => setImmediate(r));
        b.read(invalidation); release(); assert.equal(await pending, false);
        assert.equal(b.reviews.length, 0); assert.equal(b.results.length, 1); assert.equal(b.read('state.packageReviewToken'), null);
        assert.equal(metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows['A.ai']).reason, 'user-excluded');
        assert.equal(JSON.stringify(['C.ai', 'D.ai'].map(name => metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows[name]))), f.independent);
      } finally { release(); b.close(); }
    });
  }

  async function documentBoundFixture() {
    const f = await multipleSelectedFixture();
    await f.choose('B.ai', 'restore');
    let observation = 'valid';
    const ids = { 'A.ai': '101', 'B.ai': '102', 'C.ai': '103', 'D.ai': '104' };
    setChildProcessHandler(({ command, args }) => {
      if (command !== '/usr/bin/osascript' || path.basename(args.at(-1) || '') !== 'crate-source-document-identity.js') return { stdout: '' };
      if (observation === 'timeout') return { error: Error('synthetic identity timeout') };
      if (observation === 'null') return { stdout: 'null' };
      if (observation === 'malformed') return { stdout: '{"documentId":"invalid","volumeUuid":null}' };
      const script = fs.readFileSync(args.at(-1), 'utf8');
      const name = Object.keys(ids).find(name => script.includes(JSON.stringify(f.rows[name].path)));
      assert.ok(name, 'identity read must address a scoped synthetic source');
      return { stdout: JSON.stringify({ documentId: ids[name], volumeUuid: '00000000-0000-4000-8000-000000000001' }) };
    });
    // Establish the physical pair first, then exercise production document-ID
    // upgrade of that same durable pair before losing the observation cache.
    assert.ok(metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.rows['A.ai'].path, f.rows['B.ai'].path));
    metadataTestHooks.expireDocumentIdentityCache();
    await metadataTestHooks.refreshWorkingSourceLocators(f.id);
    for (const name of Object.keys(ids)) {
      const key = metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(), f.rows[name]);
      assert.match(f.stored().workingSourceLocators.records[key].documentIdentity, /^[a-f0-9]{64}$/);
    }
    const candidate = (await callIpcRaw('projects:get-asset-workspace', f.id)).sourceContinuation.candidates[0];
    assert.ok(candidate);
    const pair = JSON.stringify(f.stored().workingSourceContinuations);
    const locators = JSON.stringify(f.stored().workingSourceLocators);
    const selections = JSON.stringify(f.stored().workingSourceSelections);
    return { ...f, candidate, pair, locators, selections, ids, observe(mode) { observation = mode; } };
  }

  async function ordinaryReverify(f, name) {
    const operation = metadataTestHooks.captureProjectOperation(f.id);
    try {
      const result = await metadataTestHooks.runScanOnOpen(f.id, f.rows[name].path, operation.activationToken, operation,
        { establishBaseline: false });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(metadataTestHooks.getWorkingSourceVerification(f.stored(), f.rows[name]).status, 'scanned');
    } finally { operation.close(); clearTrackedTimers(); }
  }

  for (const binding of ['document', 'physical']) for (const observation of ['distinct', 'null']) {
    continuationTest(`v13 resolved ${binding} Replace refuses new successor inode with ${observation} ID after ordinary scan`, async () => {
      const f = binding === 'document' ? await documentBoundFixture() : await multipleSelectedFixture();
      if (binding === 'physical') {
        await f.choose('B.ai', 'restore');
        assert.ok(metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.rows['A.ai'].path, f.rows['B.ai'].path));
      }
      const candidate = (await callIpcRaw('projects:get-asset-workspace', f.id)).sourceContinuation.candidates[0];
      assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(candidate, 'replace'))).success, true);
      const selections = JSON.stringify(f.stored().workingSourceSelections), pairs = JSON.stringify(f.stored().workingSourceContinuations);
      const bBytes = fs.readFileSync(f.rows['B.ai'].path), priorInode = fs.statSync(f.rows['B.ai'].path).ino;
      fs.renameSync(f.rows['B.ai'].path, f.rows['B.ai'].path + '.preserved');
      fs.writeFileSync(f.rows['B.ai'].path, bBytes);
      assert.notEqual(fs.statSync(f.rows['B.ai'].path).ino, priorInode);
      if (binding === 'document') { f.ids['B.ai'] = '202'; f.observe(observation === 'null' ? 'null' : 'valid'); }
      else if (observation === 'distinct') setChildProcessHandler(({ command, args }) => {
        if (command !== '/usr/bin/osascript' || path.basename(args.at(-1) || '') !== 'crate-source-document-identity.js') return { stdout: '' };
        return { stdout: fs.readFileSync(args.at(-1), 'utf8').includes(JSON.stringify(f.rows['B.ai'].path))
          ? JSON.stringify({ documentId: '202', volumeUuid: '00000000-0000-4000-8000-000000000001' }) : 'null' };
      });
      metadataTestHooks.clearDocumentIdentityCache();
      await metadataTestHooks.refreshWorkingSourceLocators(f.id);
      await ordinaryReverify(f, 'B.ai');
      assert.equal(metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows['B.ai']).revision, candidate.successor.selectionRevision + 1);
      const blocked = await callIpcRaw('projects:prepare-package-review', f.id);
      assert.equal(blocked.materializable, false); assert.equal(blocked.token, undefined);
      assert.equal(JSON.stringify(f.stored().workingSourceSelections), selections);
      assert.equal(JSON.stringify(f.stored().workingSourceContinuations), pairs);
      const workspace = await callIpcRaw('projects:get-asset-workspace', f.id), a = workspace.files.find(row => row.name === 'A.ai');
      assert.equal(a.sourceSelection, 'invalid');
      assert.equal(a.selectionReason, 'continuation-identity-changed');
      assert.deepEqual(a.selectionRecovery, { version: 1, reason: a.selectionReason, expectedRevision: a.selectionRevision, actions: ['exclude', 'restore'] });
      assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(candidate, 'replace'))).success, false);
      await f.choose('B.ai', 'exclude'); await f.choose('B.ai', 'restore');
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).token, undefined);
      const beforeRecovery = JSON.stringify(f.stored());
      for (const [id, identity, revision] of [[f.id, a.visualIdentity, a.selectionRevision - 1], ['foreign-project', a.visualIdentity, a.selectionRevision], [f.id, 'foreign-identity', a.selectionRevision]]) {
        assert.equal((await callIpcRaw('projects:set-working-source-selection', id, identity, { action: 'exclude', expectedRevision: revision })).success, false);
        assert.equal(JSON.stringify(f.stored()), beforeRecovery);
      }
      await f.choose('A.ai', 'exclude');
      assert.equal(metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows['A.ai']).reason, 'user-excluded');
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).materializable, true);
      assert.equal(JSON.stringify(['C.ai', 'D.ai'].map(name => metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows[name]))), f.independent);
      assert.deepEqual(fs.readFileSync(f.rows['A.ai'].path), f.aBytes);
      clearTrackedTimers();
    });
  }

  for (const binding of ['document', 'physical']) {
    continuationTest(`v13 resolved ${binding} Replace blocks missing B and preserves intent when the same B returns`, async () => {
      const f = binding === 'document' ? await documentBoundFixture() : await multipleSelectedFixture();
      if (binding === 'physical') assert.ok(metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.rows['A.ai'].path, f.rows['B.ai'].path));
      const candidate = (await callIpcRaw('projects:get-asset-workspace', f.id)).sourceContinuation.candidates[0];
      assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(candidate, 'replace'))).success, true);
      const selections = JSON.stringify(f.stored().workingSourceSelections), pairs = JSON.stringify(f.stored().workingSourceContinuations);
      fs.renameSync(f.rows['B.ai'].path, f.rows['B.ai'].path + '.preserved');
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).token, undefined);
      assert.equal(metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows['A.ai']).state, 'invalid');
      fs.renameSync(f.rows['B.ai'].path + '.preserved', f.rows['B.ai'].path);
      await ordinaryReverify(f, 'B.ai');
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).materializable, true);
      assert.equal(JSON.stringify(f.stored().workingSourceSelections), selections);
      assert.equal(JSON.stringify(f.stored().workingSourceContinuations), pairs);
      assert.deepEqual(fs.readFileSync(f.rows['A.ai'].path), f.aBytes);
      clearTrackedTimers();
    });
  }

  continuationTest('v13 resolved document Replace retains qualified successor safe-save and verifies changed bytes', async () => {
    const f = await documentBoundFixture();
    assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(f.candidate, 'replace'))).success, true);
    const selections = JSON.stringify(f.stored().workingSourceSelections), pairs = JSON.stringify(f.stored().workingSourceContinuations);
    fs.renameSync(f.rows['B.ai'].path, f.rows['B.ai'].path + '.preserved');
    f.save('B.ai', ['Shared.png', 'AB.png', 'C-only.png']);
    metadataTestHooks.clearDocumentIdentityCache();
    await metadataTestHooks.refreshWorkingSourceLocators(f.id);
    assert.equal(metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows['A.ai']).reason, 'continuation-replaced');
    assert.equal(metadataTestHooks.getWorkingSourceVerification(f.stored(), f.rows['B.ai']).status, 'scanned');
    assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).materializable, true);
    assert.equal(JSON.stringify(f.stored().workingSourceSelections), selections);
    assert.equal(JSON.stringify(f.stored().workingSourceContinuations), pairs);
    assert.deepEqual(fs.readFileSync(f.rows['A.ai'].path), f.aBytes);
    clearTrackedTimers();
  });

  continuationTest('v13 successor replacement recovery preserves independent Replace and C-required A dependency closure', async () => {
    const f = await multipleSelectedFixture({ predecessorRequired: true });
    assert.ok(metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.rows['A.ai'].path, f.rows['B.ai'].path));
    assert.ok(metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.rows['D.ai'].path, f.rows['C.ai'].path));
    const candidates = (await callIpcRaw('projects:get-asset-workspace', f.id)).sourceContinuation.candidates;
    for (const pair of candidates) assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(pair, 'replace'))).success, true);
    const independent = JSON.stringify(['C.ai', 'D.ai'].map(name => metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows[name])));
    const included = await f.selectNames();
    const priorVerification = JSON.stringify(metadataTestHooks.getWorkingSourceVerification(f.stored(), f.rows['A.ai']).requiredReferences);
    fs.renameSync(f.rows['B.ai'].path, f.rows['B.ai'].path + '.preserved'); f.save('B.ai', ['Shared.png', 'AB.png']);
    await ordinaryReverify(f, 'B.ai');
    assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).token, undefined);
    let a = (await callIpcRaw('projects:get-asset-workspace', f.id)).files.find(row => row.name === 'A.ai');
    assert.equal(a.includedAsDependency, true); assert.equal(a.sourceSelection, 'invalid');
    await f.choose('A.ai', 'exclude');
    a = (await callIpcRaw('projects:get-asset-workspace', f.id)).files.find(row => row.name === 'A.ai');
    assert.equal(a.includedAsDependency, true); assert.equal(a.effectiveRole, 'asset');
    assert.equal(JSON.stringify(metadataTestHooks.getWorkingSourceVerification(f.stored(), f.rows['A.ai']).requiredReferences), priorVerification);
    assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).materializable, true);
    assert.equal(JSON.stringify(['C.ai', 'D.ai'].map(name => metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows[name]))), independent);
    assert.deepEqual(await f.selectNames(), included);
    assert.equal(included.includes('A.ai'), true);
    assert.equal(included.includes('D.ai'), false);
    assert.deepEqual(fs.readFileSync(f.rows['A.ai'].path), f.aBytes);
    clearTrackedTimers();
  });

  for (const mode of ['replacement', 'missing']) {
    continuationTest(`v13 recovery projection for ${mode} A preserves C-required dependency verification`, async () => {
      const f = await multipleSelectedFixture({ predecessorRequired: true });
      assert.ok(metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.rows['A.ai'].path, f.rows['B.ai'].path));
      const candidate = (await callIpcRaw('projects:get-asset-workspace', f.id)).sourceContinuation.candidates[0];
      assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(candidate, 'replace'))).success, true);
      fs.renameSync(f.rows['A.ai'].path, f.rows['A.ai'].path + '.preserved');
      if (mode === 'replacement') f.save('A.ai', ['C-only.png']);
      let workspace = await callIpcRaw('projects:get-asset-workspace', f.id), a = workspace.files.find(row => row.name === 'A.ai');
      assert.equal(a.sourceSelection, 'invalid'); assert.equal(a.includedAsDependency, true);
      assert.deepEqual(a.selectionRecovery.actions, mode === 'missing' ? ['exclude'] : ['exclude', 'restore']);
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).token, undefined);
      await f.choose('A.ai', 'exclude');
      workspace = await callIpcRaw('projects:get-asset-workspace', f.id); a = workspace.files.find(row => row.name === 'A.ai');
      assert.equal(a.sourceSelection, 'excluded'); assert.equal(a.selectionReason, 'user-excluded');
      assert.equal(a.selectionRecovery, undefined); assert.equal(a.includedAsDependency, true);
      assert.equal(a.verificationStatus, 'stale');
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).token, undefined);
      if (mode === 'replacement') {
        await ordinaryReverify(f, 'A.ai');
        assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).materializable, true);
        assert.deepEqual(metadataTestHooks.getWorkingSourceVerification(f.stored(), f.rows['A.ai']).requiredReferences,
          [{ path: f.rows['C-only.png'].path }]);
      }
      assert.equal(JSON.stringify(['C.ai', 'D.ai'].map(name => metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows[name]))), f.independent);
      assert.deepEqual(fs.readFileSync(f.rows['A.ai'].path + '.preserved'), f.aBytes);
      clearTrackedTimers();
    });
  }

  for (const mode of ['demoted', 'out-of-scope', 'duplicate']) {
    continuationTest(`v13 successor ${mode} after Replace cannot retain the old exclusion`, async () => {
      const f = await multipleSelectedFixture();
      assert.ok(metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.rows['A.ai'].path, f.rows['B.ai'].path));
      const candidate = (await callIpcRaw('projects:get-asset-workspace', f.id)).sourceContinuation.candidates[0];
      assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(candidate, 'replace'))).success, true);
      const pairs = JSON.stringify(f.stored().workingSourceContinuations);
      if (mode === 'demoted') {
        f.stored().files = f.stored().files.filter(row => row.name !== 'B.ai'); f.stored().pendingFiles = [f.rows['B.ai']];
      } else if (mode === 'out-of-scope') {
        f.stored().files = f.stored().files.map(row => row.name === 'B.ai'
          ? { ...f.rows['B.ai'], acceptedPending: false, captureEvidence: { appFamily: 'illustrator' } } : row);
        metadataTestHooks.getProjectOperationScope(f.id).admittedDocumentPaths.delete(f.rows['B.ai'].path);
        metadataTestHooks.getProjectOperationScope(f.id).baselineDocumentPaths.add(f.rows['B.ai'].path);
        assert.equal(metadataTestHooks.getIllustratorScopedProjectView(f.stored()).files.some(row => row.name === 'B.ai'), false);
      } else f.stored().files.push({ ...f.rows['B.ai'], fileId: 'duplicate-B' });
      assert.equal(metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows['A.ai']).state, 'invalid');
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).token, undefined);
      assert.equal(JSON.stringify(f.stored().workingSourceContinuations), pairs);
      assert.equal(JSON.stringify(['C.ai', 'D.ai'].map(name => metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows[name]))), f.independent);
      assert.deepEqual(fs.readFileSync(f.rows['A.ai'].path), f.aBytes);
      clearTrackedTimers();
    });
  }

  for (const cache of ['expired', 'cold']) for (const failure of ['timeout', 'null', 'malformed']) {
    continuationTest(`document-ID ${cache} ${failure} preserves pending hold, pair revisions and C/D assets`, async () => {
      const f = await documentBoundFixture();
      f.observe(failure);
      if (cache === 'cold') { roundTripFakeStore(); metadataTestHooks.clearDocumentIdentityCache(); }
      else metadataTestHooks.expireDocumentIdentityCache();
      const blocked = await callIpcRaw('projects:prepare-package-review', f.id);
      assert.equal(blocked.error, 'working_source_continuation_choice_required');
      assert.equal(blocked.token, undefined);
      assert.deepEqual(blocked.sourceContinuation.candidates[0], f.candidate);
      assert.equal(JSON.stringify(f.stored().workingSourceContinuations), f.pair);
      assert.equal(JSON.stringify(f.stored().workingSourceLocators), f.locators);
      assert.equal(JSON.stringify(f.stored().workingSourceSelections), f.selections);
      assert.deepEqual(await f.selectNames(), [...namesForCopy].sort());
      assert.deepEqual(fs.readFileSync(f.rows['A.ai'].path), f.aBytes);
      f.observe('valid'); metadataTestHooks.expireDocumentIdentityCache();
      await metadataTestHooks.refreshWorkingSourceLocators(f.id);
      const recovered = (await callIpcRaw('projects:get-asset-workspace', f.id)).sourceContinuation.candidates[0];
      assert.deepEqual(recovered, f.candidate);
      assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(recovered, 'replace'))).success, true);
      assert.deepEqual(await f.roots(), ['B.ai', 'C.ai', 'D.ai']);
      assert.equal(JSON.stringify(['C.ai', 'D.ai'].map(name => metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows[name]))), f.independent);
      clearTrackedTimers();
    });

    continuationTest(`document-ID ${cache} ${failure} preserves verified Replace intent`, async () => {
      const f = await documentBoundFixture();
      assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(f.candidate, 'replace'))).success, true);
      const selections = JSON.stringify(f.stored().workingSourceSelections);
      const pairs = JSON.stringify(f.stored().workingSourceContinuations);
      f.observe(failure);
      if (cache === 'cold') { roundTripFakeStore(); metadataTestHooks.clearDocumentIdentityCache(); }
      else metadataTestHooks.expireDocumentIdentityCache();
      const review = await callIpcRaw('projects:prepare-package-review', f.id);
      assert.equal(review.materializable, true);
      assert.equal(typeof review.token, 'string');
      assert.equal(JSON.stringify(f.stored().workingSourceSelections), selections);
      assert.equal(JSON.stringify(f.stored().workingSourceContinuations), pairs);
      assert.equal(metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows['A.ai']).reason, 'continuation-replaced');
      assert.deepEqual(await f.selectNames(), ['AB.png', 'B.ai', 'C-only.png', 'C.ai', 'D-only.png', 'D.ai', 'Shared.png']);
      assert.deepEqual(fs.readFileSync(f.rows['A.ai'].path), f.aBytes);
      f.observe('valid'); metadataTestHooks.expireDocumentIdentityCache();
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).materializable, true);
      clearTrackedTimers();
    });
  }

  for (const decision of ['pending', 'replace']) {
    continuationTest(`genuine physical replacement cannot inherit document ID or ${decision} decision`, async () => {
      const f = await documentBoundFixture();
      if (decision === 'replace') assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(f.candidate, 'replace'))).success, true);
      const selections = JSON.stringify(f.stored().workingSourceSelections);
      const pairs = JSON.stringify(f.stored().workingSourceContinuations);
      const key = metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(), f.rows['A.ai']);
      const prior = f.stored().workingSourceLocators.records[key];
      fs.renameSync(f.rows['A.ai'].path, f.rows['A.ai'].path + '.preserved');
      fs.writeFileSync(f.rows['A.ai'].path, '%PDF-1.7\nUnrelated replacement\n%%EOF\n');
      f.observe('null'); metadataTestHooks.clearDocumentIdentityCache(); roundTripFakeStore();
      const blocked = await callIpcRaw('projects:prepare-package-review', f.id);
      assert.equal(blocked.token, undefined);
      const next = f.stored().workingSourceLocators.records[key];
      assert.notEqual(next.physicalIdentity, prior.physicalIdentity);
      assert.equal(next.documentIdentity, null);
      assert.equal(JSON.stringify(f.stored().workingSourceSelections), selections);
      assert.equal(JSON.stringify(f.stored().workingSourceContinuations), pairs);
      if (decision === 'pending') {
        assert.equal(blocked.error, 'working_source_continuation_choice_required');
        assert.equal(blocked.sourceContinuation.candidates[0].identityStatus, 'changed');
      } else {
        assert.equal(blocked.materializable, false);
        assert.equal(metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows['A.ai']).reason, 'continuation-identity-changed');
      }
      assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(f.candidate, 'replace'))).error, 'continuation_stale');
      f.observe('valid'); f.ids['A.ai'] = '201'; metadataTestHooks.expireDocumentIdentityCache();
      const recovered = await callIpcRaw('projects:prepare-package-review', f.id);
      assert.equal(recovered.token, undefined);
      assert.notEqual(f.stored().workingSourceLocators.records[key].documentIdentity, prior.documentIdentity);
      assert.equal(JSON.stringify(f.stored().workingSourceContinuations), pairs);
      assert.equal(JSON.stringify(['C.ai', 'D.ai'].map(name => metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows[name]))), f.independent);
      assert.deepEqual(fs.readFileSync(f.rows['A.ai'].path + '.preserved'), f.aBytes);
      if (decision === 'replace') {
        await f.choose('A.ai', 'restore');
        assert.equal(metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows['A.ai']).state, 'selected');
        assert.equal(metadataTestHooks.getWorkingSourceVerification(f.stored(), f.rows['A.ai']).status, 'scanned');
      }
      clearTrackedTimers();
    });
  }

  continuationTest('unavailable refresh retains two independent holds and still permits a strictly bound Replace', async () => {
    const f = await documentBoundFixture();
    assert.ok(metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.rows['C.ai'].path, f.rows['D.ai'].path));
    const before = (await callIpcRaw('projects:get-asset-workspace', f.id)).sourceContinuation.candidates;
    const other = before.find(pair => pair.predecessor.name === 'C.ai');
    assert.ok(other);
    f.observe('timeout'); metadataTestHooks.clearDocumentIdentityCache(); roundTripFakeStore();
    const blocked = await callIpcRaw('projects:prepare-package-review', f.id);
    assert.deepEqual(blocked.sourceContinuation.candidates, before);
    assert.equal(blocked.token, undefined);
    assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(f.candidate, 'replace'))).success, true);
    const remaining = (await callIpcRaw('projects:get-asset-workspace', f.id)).sourceContinuation.candidates;
    assert.deepEqual(remaining, [other]);
    assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).error, 'working_source_continuation_choice_required');
    assert.deepEqual(await f.selectNames(), ['AB.png', 'B.ai', 'C-only.png', 'C.ai', 'D-only.png', 'D.ai', 'Shared.png']);
    assert.equal(JSON.stringify(['C.ai', 'D.ai'].map(name => metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows[name]))), f.independent);
    assert.deepEqual(fs.readFileSync(f.rows['A.ai'].path), f.aBytes);
    clearTrackedTimers();
  });

  continuationTest('missing document-bound successor retains an unavailable hold and recovers only the same physical file', async () => {
    const f = await documentBoundFixture();
    fs.renameSync(f.rows['B.ai'].path, f.rows['B.ai'].path + '.preserved');
    f.observe('null'); metadataTestHooks.clearDocumentIdentityCache();
    const blocked = await callIpcRaw('projects:prepare-package-review', f.id);
    assert.equal(blocked.error, 'working_source_continuation_choice_required');
    assert.equal(blocked.token, undefined);
    assert.equal(blocked.sourceContinuation.candidates[0].identityStatus, 'unavailable');
    assert.equal(blocked.sourceContinuation.candidates[0].resolutionRequires, 'identity-refresh');
    assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(f.candidate, 'replace'))).error, 'continuation_stale');
    assert.equal(JSON.stringify(f.stored().workingSourceSelections), f.selections);
    fs.renameSync(f.rows['B.ai'].path + '.preserved', f.rows['B.ai'].path);
    f.observe('valid'); metadataTestHooks.expireDocumentIdentityCache();
    const recovered = (await callIpcRaw('projects:get-asset-workspace', f.id)).sourceContinuation.candidates[0];
    assert.deepEqual(recovered, f.candidate);
    assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(recovered, 'replace'))).success, true);
    assert.deepEqual(await f.roots(), ['B.ai', 'C.ai', 'D.ai']);
    assert.deepEqual(fs.readFileSync(f.rows['A.ai'].path), f.aBytes);
    clearTrackedTimers();
  });

  continuationTest('multi-source real selectors still reject a foreign unadmitted Illustrator source', async () => {
    const f = await multipleSelectedFixture();
    const foreignPath = path.join(TEST_HOME, 'Desktop', 'Foreign.ai');
    fs.writeFileSync(foreignPath, '%PDF-1.7\n%%EOF\n');
    f.stored().files.push({ fileId: 'foreign', name: 'Foreign.ai', path: foreignPath, ext: '.ai', source: 'lsof',
      projectRole: 'source', addedAt: Date.now(), captureEvidence: { appFamily: 'illustrator' } });
    metadataTestHooks.getProjectOperationScope(f.id).baselineDocumentPaths.add(foreignPath);
    assert.equal(metadataTestHooks.getIllustratorScopedProjectView(f.stored()).files.some(file => file.path === foreignPath), false);
    assert.equal((await f.selectNames()).includes('Foreign.ai'), false);
    assert.equal((await resolveNamedPair(f)).success, true);
    assert.deepEqual(await f.roots(), ['B.ai', 'C.ai', 'D.ai']);
    assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).materializable, true);
    clearTrackedTimers();
  });

  async function resolveNamedPair(f, choice = 'replace') {
    assert.ok(metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.rows['A.ai'].path, f.rows['B.ai'].path));
    const workspace = await callIpcRaw('projects:get-asset-workspace', f.id);
    const pair = workspace.sourceContinuation.candidates.find(item => item.predecessor.name === 'A.ai');
    assert.ok(pair);
    return callIpcRaw('projects:resolve-working-source-continuation', f.id, request(pair, choice));
  }

  continuationTest('multi-source real selectors retain A and its transitive assets when independent C requires A', async () => {
    const f = await multipleSelectedFixture({ predecessorRequired: true });
    assert.equal((await resolveNamedPair(f)).success, true);
    const workspace = await callIpcRaw('projects:get-asset-workspace', f.id);
    const a = workspace.files.find(file => file.name === 'A.ai');
    assert.equal(a.sourceSelection, 'excluded'); assert.equal(a.includedAsDependency, true); assert.equal(a.effectiveRole, 'asset');
    assert.ok(a.requiredBy.includes('C.ai'));
    assert.deepEqual(await f.selectNames(), [...namesForCopy].sort());
    assert.deepEqual(fs.readFileSync(f.rows['A.ai'].path), f.aBytes);
    assert.equal(JSON.stringify(['C.ai', 'D.ai'].map(name => metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows[name]))), f.independent);
    const result = await callIpc('projects:package', f.id, path.join(TEST_HOME, 'Documents'));
    assert.equal(result.success, true, JSON.stringify(result)); assert.equal(result.totalFiles, 8);
    clearTrackedTimers();
  });

  for (const choice of ['keep-both', 'not-related']) {
    continuationTest(`multi-source real selectors ambiguous ${choice} preserves all independently selected roots`, async () => {
      const f = await multipleSelectedFixture(); await f.choose('B.ai', 'restore');
      const before = JSON.stringify(['A.ai', 'B.ai', 'C.ai', 'D.ai'].map(name => metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows[name])));
      assert.ok(metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.rows['A.ai'].path, f.rows['B.ai'].path));
      assert.deepEqual(await f.roots(), ['A.ai', 'B.ai', 'C.ai', 'D.ai']);
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).error, 'working_source_continuation_choice_required');
      const workspace = await callIpcRaw('projects:get-asset-workspace', f.id);
      assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(workspace.sourceContinuation.candidates[0], choice))).success, true);
      assert.equal(JSON.stringify(['A.ai', 'B.ai', 'C.ai', 'D.ai'].map(name => metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows[name]))), before);
      roundTripFakeStore();
      assert.deepEqual(await f.roots(), ['A.ai', 'B.ai', 'C.ai', 'D.ai']);
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).materializable, true);
      clearTrackedTimers();
    });
  }

  for (const mode of ['changed-successor', 'missing-successor']) {
    continuationTest(`multi-source real selectors ${mode} cannot change A/C/D selection`, async () => {
      const f = await multipleSelectedFixture();
      assert.ok(metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.rows['A.ai'].path, f.rows['B.ai'].path));
      const workspace = await callIpcRaw('projects:get-asset-workspace', f.id);
      const req = request(workspace.sourceContinuation.candidates[0], 'replace');
      const before = JSON.stringify(f.stored().workingSourceSelections);
      if (mode === 'changed-successor') fs.appendFileSync(f.rows['B.ai'].path, '\nChanged saved source\n');
      else fs.unlinkSync(f.rows['B.ai'].path);
      const result = await callIpcRaw('projects:resolve-working-source-continuation', f.id, req);
      assert.equal(result.success, false);
      assert.equal(JSON.stringify(f.stored().workingSourceSelections), before);
      assert.deepEqual(await f.roots(), ['A.ai', 'C.ai', 'D.ai']);
      assert.deepEqual(fs.readFileSync(f.rows['A.ai'].path), f.aBytes);
      clearTrackedTimers();
    });
  }

  continuationTest('multi-source real selectors resolving A/B leaves an independent pending C/D pair untouched', async () => {
    const f = await multipleSelectedFixture();
    assert.ok(metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.rows['C.ai'].path, f.rows['D.ai'].path));
    const prior = (await callIpcRaw('projects:get-asset-workspace', f.id)).sourceContinuation.candidates[0];
    assert.equal((await resolveNamedPair(f)).success, true);
    const after = (await callIpcRaw('projects:get-asset-workspace', f.id)).sourceContinuation.candidates;
    assert.equal(after.length, 1); assert.equal(after[0].pairIdentity, prior.pairIdentity);
    assert.equal(after[0].evidenceIdentity, prior.evidenceIdentity); assert.equal(after[0].revision, prior.revision);
    assert.deepEqual(await f.roots(), ['B.ai', 'C.ai', 'D.ai']);
    assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).error, 'working_source_continuation_choice_required');
    clearTrackedTimers();
  });

  continuationTest('multi-source real selectors new B dependency requires a saved-byte change and ordinary verification', async () => {
    const f = await multipleSelectedFixture(); assert.equal((await resolveNamedPair(f)).success, true);
    const before = metadataTestHooks.getWorkingSourceVerification(f.stored(), f.rows['B.ai']).sourceFingerprint;
    const newPath = path.join(TEST_HOME, 'Desktop', 'New-B.png'); fs.writeFileSync(newPath, 'new B asset');
    assert.equal((await f.selectNames()).includes('New-B.png'), false);
    fs.writeFileSync(f.rows['B.ai'].path, `%PDF-1.7\n${f.rows['Shared.png'].path}\n${f.rows['AB.png'].path}\n${newPath}\n%%EOF\n`);
    assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).materializable, false);
    // Explicit ordinary re-verification; this is not a native Save observer.
    await f.choose('B.ai', 'exclude'); await f.choose('B.ai', 'restore');
    const record = metadataTestHooks.getWorkingSourceVerification(f.stored(), f.rows['B.ai']);
    assert.notEqual(record.sourceFingerprint, before); assert.ok(record.requiredReferences.some(ref => ref.path === newPath));
    assert.equal(JSON.stringify(['C.ai', 'D.ai'].map(name => metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows[name]))), f.independent);
    assert.deepEqual(await f.roots(), ['B.ai', 'C.ai', 'D.ai']);
    // Paused verification records the required reference without bypassing
    // capture admission. The actual Add Files IPC can admit it explicitly.
    const allRows = [...f.stored().files, ...f.stored().pendingFiles];
    assert.equal(allRows.some(file => file.path === newPath), false);
    assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).materializable, false);
    manualDialogFor([newPath]);
    const added = await callIpcRaw('projects:add-files', f.id);
    assert.ok(Array.isArray(added) && added.some(file => file.path === newPath));
    assert.ok((await f.selectNames()).includes('New-B.png'));
    assert.deepEqual(await f.roots(), ['B.ai', 'C.ai', 'D.ai']);
    assert.equal(JSON.stringify(['C.ai', 'D.ai'].map(name => metadataTestHooks.getWorkingSourceSelection(f.stored(), f.rows[name]))), f.independent);
    const result = await callIpc('projects:package', f.id, path.join(TEST_HOME, 'Documents'));
    assert.equal(result.success, true, JSON.stringify(result)); assert.equal(result.totalFiles, 8);
    clearTrackedTimers();
  });
  continuationTest('real IPC gates only the unresolved included pair, then Keep both survives reload and yields a fresh package token', async () => {
    const f = await fixture();
    const before = await callIpcRaw('projects:prepare-package-review', f.id);
    assert.equal(before.materializable, true);
    assert.ok(metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.files[0].path, f.files[1].path));
    const workspace = await callIpcRaw('projects:get-asset-workspace', f.id);
    assert.equal(workspace.sourceContinuation.version, 1);
    assert.equal(workspace.sourceContinuation.candidates.length, 1);
    assert.equal(JSON.stringify(workspace.sourceContinuation).includes(TEST_HOME), false);
    const blocked = await callIpcRaw('projects:prepare-package-review', f.id);
    assert.equal(blocked.error, 'working_source_continuation_choice_required');
    assert.equal(blocked.projectId, f.id);
    assert.equal(blocked.token, undefined);
    assert.equal((await callIpcRaw('projects:package', f.id, TEST_HOME, before.token)).error, 'package_review_stale');
    const candidate = blocked.sourceContinuation.candidates[0];
    const decision = await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(candidate, 'keep-both'));
    assert.equal(decision.success, true);
    assert.equal(decision.projectId, f.id);
    roundTripFakeStore();
    assert.equal((await callIpcRaw('projects:get-asset-workspace', f.id)).sourceContinuation.candidates.length, 0);
    const after = await callIpcRaw('projects:prepare-package-review', f.id);
    assert.equal(after.materializable, true);
    assert.equal(after.totalFiles, 3);
    assert.notEqual(after.token, before.token);
  });
  continuationTest('real IPC Replace verifies successor before selection and retains a genuine predecessor dependency', async () => {
    const f = await fixture();
    fs.writeFileSync(f.files[1].path, `%PDF-1.7\n${f.files[0].path}\n%%EOF\n`);
    metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.files[0].path, f.files[1].path);
    const workspace = await callIpcRaw('projects:get-asset-workspace', f.id);
    const decision = await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(workspace.sourceContinuation.candidates[0], 'replace'));
    assert.equal(decision.success, true);
    assert.equal(decision.projectId, f.id);
    const updated = await callIpcRaw('projects:get-asset-workspace', f.id);
    const predecessor = updated.files.find(file => file.name === 'Original.ai');
    assert.equal(predecessor.sourceSelection, 'excluded');
    assert.equal(predecessor.selectionReason, 'continuation-replaced');
    assert.equal(predecessor.includedAsDependency, true);
    assert.equal(predecessor.effectiveRole, 'asset');
    assert.equal(updated.files.find(file => file.name === 'Successor.ai').verificationStatus, 'scanned');
    const review = await callIpcRaw('projects:prepare-package-review', f.id);
    assert.equal(review.materializable, true);
    assert.equal(review.totalFiles, 3);
  });
  continuationTest('real IPC holds the selected original for an excluded successor and verifies explicit Replace before restoring it', async () => {
    const f = await fixture();
    const initial = await callIpcRaw('projects:get-asset-workspace', f.id);
    const successor = initial.files.find(file => file.name === 'Successor.ai');
    assert.equal((await callIpcRaw('projects:set-working-source-selection', f.id, successor.visualIdentity,
      { action: 'exclude', expectedRevision: 0 })).success, true);
    const before = await callIpcRaw('projects:prepare-package-review', f.id);
    assert.equal(before.materializable, true);
    assert.equal(before.totalFiles, 2);
    assert.ok(metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.files[0].path, f.files[1].path));
    const blocked = await callIpcRaw('projects:prepare-package-review', f.id);
    assert.equal(blocked.error, 'working_source_continuation_choice_required');
    assert.equal(blocked.token, undefined);
    const candidate = blocked.sourceContinuation.candidates[0];
    assert.equal(candidate.successor.selectionState, 'excluded');
    assert.equal(candidate.successor.admissionState, 'accepted');
    const result = await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(candidate, 'replace'));
    assert.equal(result.success, true, JSON.stringify({ result, verification: f.stored().workingSourceVerification }));
    const updated = await callIpcRaw('projects:get-asset-workspace', f.id);
    assert.equal(updated.files.find(file => file.name === 'Original.ai').selectionReason, 'continuation-replaced');
    assert.equal(updated.files.find(file => file.name === 'Successor.ai').sourceSelection, 'selected');
    assert.equal(updated.files.find(file => file.name === 'Successor.ai').verificationStatus, 'scanned');
    assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).materializable, true);
  });
  continuationTest('real IPC pending successor blocks the original but cannot be admitted by Replace or Keep both', async () => {
    const f = await fixture();
    f.stored().files = [f.files[0], f.files[2]];
    f.stored().pendingFiles = [f.files[1]];
    roundTripFakeStore();
    assert.ok(metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.files[0].path, f.files[1].path));
    const blocked = await callIpcRaw('projects:prepare-package-review', f.id);
    assert.equal(blocked.error, 'working_source_continuation_choice_required');
    const candidate = blocked.sourceContinuation.candidates[0];
    assert.equal(candidate.successor.admissionState, 'pending');
    assert.equal(candidate.replaceRequires, 'successor-admission');
    const before = JSON.stringify(f.stored());
    assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(candidate, 'replace'))).error,
      'continuation_admission_required');
    assert.equal(JSON.stringify(f.stored()), before);
    assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(candidate, 'keep-both'))).success, true);
    roundTripFakeStore();
    assert.equal(f.stored().files.length, 2);
    assert.equal(f.stored().pendingFiles.length, 1);
    assert.equal((await callIpcRaw('projects:get-asset-workspace', f.id)).sourceContinuation.candidates.length, 0);
    assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).totalFiles, 2);
  });
  continuationTest('real filesystem rename preserves exclusion and rejects inheritance at the old path', async () => {
    const f = await fixture();
    const workspace = await callIpcRaw('projects:get-asset-workspace', f.id);
    const original = workspace.files.find(file => file.name === 'Original.ai');
    await callIpcRaw('projects:set-working-source-selection', f.id, original.visualIdentity, { action: 'exclude', expectedRevision: 0 });
    const destination = path.join(TEST_HOME, 'Desktop', 'Moved.ai');
    fs.renameSync(f.files[0].path, destination);
    await metadataTestHooks.refreshWorkingSourceLocators(f.id, [destination]);
    let stored = f.stored();
    const moved = stored.files.find(file => file.path === destination);
    assert.ok(moved);
    assert.equal(metadataTestHooks.getWorkingSourceSelection(stored, moved).reason, 'user-excluded');
    fs.writeFileSync(f.files[0].path, '%PDF-1.7\nunrelated new file\n%%EOF\n');
    stored.files.push({ ...f.files[0], fileId: 'new-old-path-occupant' });
    roundTripFakeStore(); stored = f.stored();
    assert.equal(metadataTestHooks.getWorkingSourceSelection(stored, stored.files.find(file => file.path === f.files[0].path)).revision, 0);
    assert.equal(metadataTestHooks.getWorkingSourceSelection(stored, stored.files.find(file => file.path === destination)).reason, 'user-excluded');
  });
  continuationTest('real pair receiver rejects foreign project, forged proof fields, stale revision and replay without changing either intent', async () => {
    const f = await fixture();
    metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.files[0].path, f.files[1].path);
    const blocked = await callIpcRaw('projects:prepare-package-review', f.id);
    const command = request(blocked.sourceContinuation.candidates[0], 'keep-both');
    const before = JSON.stringify(f.stored());
    assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', 'foreign-project', command)).success, false);
    assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, { ...command, authority: 'app-operation' })).error, 'invalid_continuation_request');
    assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, { ...command, expectedRevision: 0 })).error, 'continuation_stale');
    assert.equal(JSON.stringify(f.stored()), before);
    assert.equal((await callIpcRaw('projects:prepare-package-review', 'foreign-project')).error, 'not_found');
    const success = await callIpcRaw('projects:resolve-working-source-continuation', f.id, command);
    assert.equal(success.projectId, f.id);
    const committed = JSON.stringify(f.stored());
    assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, command)).error, 'continuation_stale');
    assert.equal(JSON.stringify(f.stored()), committed);
  });
  for (const mode of ['replacement-restore', 'replacement-exclude', 'missing-exclude', 'missing-restore', 'forged-decision']) {
    continuationTest(`S1 real IPC explicit recovery after Replace: ${mode}`, async () => {
      const f = await fixture();
      metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.files[0].path, f.files[1].path);
      let workspace = await callIpcRaw('projects:get-asset-workspace', f.id);
      const identity = workspace.files.find(file => file.name === 'Original.ai').visualIdentity;
      const candidate = workspace.sourceContinuation.candidates[0];
      assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(candidate, 'replace'))).success, true);
      if (mode.startsWith('missing')) fs.unlinkSync(f.files[0].path);
      else {
        const temporary = f.files[0].path + '.tmp';
        fs.writeFileSync(temporary, '%PDF-1.7\nnew current bytes\n%%EOF\n');
        fs.renameSync(temporary, f.files[0].path);
      }
      if (mode === 'forged-decision') f.stored().workingSourceContinuations.pairs[candidate.pairIdentity].decision.authority = 'untrusted';
      roundTripFakeStore();
      const selected = metadataTestHooks.getWorkingSourceSelection(f.stored(), f.files[0]);
      assert.equal(selected.state, 'invalid');
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).materializable, false);
      const before = JSON.stringify(f.stored());
      const action = mode.endsWith('exclude') ? 'exclude' : 'restore';
      const stale = await callIpcRaw('projects:set-working-source-selection', f.id, identity, { action, expectedRevision: 0 });
      assert.equal(stale.success, false);
      assert.equal(JSON.stringify(f.stored()), before);
      const recovered = await callIpcRaw('projects:set-working-source-selection', f.id, identity, { action, expectedRevision: 1 });
      if (mode === 'missing-restore' || mode === 'forged-decision') {
        assert.equal(recovered.success, false);
        assert.equal(JSON.stringify(f.stored()), before);
        return;
      }
      assert.equal(selected.reason, 'continuation-identity-changed');
      assert.equal(selected.revision, 1);
      assert.equal(recovered.success, true, JSON.stringify(recovered));
      assert.equal(recovered.selection.revision, 2);
      assert.equal(recovered.selection.reason, action === 'exclude' ? 'user-excluded' : null);
      if (action === 'restore') assert.equal(recovered.verificationStatus, 'scanned');
      roundTripFakeStore();
      const review = await callIpcRaw('projects:prepare-package-review', f.id);
      assert.equal(review.materializable, true, JSON.stringify(review));
      assert.equal(review.totalFiles, action === 'restore' ? 3 : 2);
      assert.equal(f.stored().files.length, 3);
      assert.equal(f.stored().workingSourceContinuations.pairs[candidate.pairIdentity].decision.choice, 'replace');
    });
  }
  for (const mode of ['no-apps', 'stale-query', 'query-error', 'newer-activation', 'newer-same-activation', 'first-snapshot']) {
    continuationTest(`S3 production poll clears only its own stale snapshot: ${mode}`, async () => {
      resetTestHomeWorkspace(); setChildProcessHandler(() => ({ stdout: '' }));
      const project = await createProject('Synthetic poll lifecycle'); clearTrackedTimers();
      const token = metadataTestHooks.getActiveWatchingActivationToken(project.id);
      assert.ok(token);
      const snapshot = { activationToken: token, current: '/Users/synthetic/A.ai', paths: ['/Users/synthetic/A.ai'] };
      if (mode !== 'first-snapshot') metadataTestHooks.seedSnapshot(project.id, snapshot);
      let originalQuery;
      if (mode !== 'no-apps') originalQuery = metadataTestHooks.replacePollQuery(async () => {
        if (mode === 'query-error') throw new Error('synthetic poll failure');
        if (mode === 'newer-activation') metadataTestHooks.seedSnapshot(project.id, { ...snapshot, activationToken: token + '-new' });
        if (mode === 'newer-same-activation' || mode === 'first-snapshot') metadataTestHooks.seedSnapshot(project.id, { ...snapshot, current: '/Users/synthetic/B.ai' });
        return { stale: true };
      });
      try { await metadataTestHooks.pollPsForProjectCore(project.id, token, null); }
      finally { if (originalQuery) metadataTestHooks.replacePollQuery(originalQuery); clearTrackedTimers(); }
      const remaining = metadataTestHooks.readSnapshot(project.id);
      if (mode === 'newer-activation') {
        assert.equal(remaining.activationToken, token + '-new');
        metadataTestHooks.observeIllustratorWorkingSourceContinuation(project.id, token, { running: false });
        assert.equal(metadataTestHooks.readSnapshot(project.id).activationToken, token + '-new');
      } else if (mode === 'newer-same-activation' || mode === 'first-snapshot') assert.equal(remaining.current, '/Users/synthetic/B.ai');
      else assert.equal(remaining, undefined);
    });
  }

  continuationTest('S1 explicit recovery cannot discard a missing predecessor required by its successor', async () => {
    const f = await fixture();
    fs.writeFileSync(f.files[1].path, `%PDF-1.7\n${f.files[0].path}\n%%EOF\n`);
    metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.files[0].path, f.files[1].path);
    let workspace = await callIpcRaw('projects:get-asset-workspace', f.id);
    const identity = workspace.files.find(file => file.name === 'Original.ai').visualIdentity;
    assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(workspace.sourceContinuation.candidates[0], 'replace'))).success, true);
    fs.unlinkSync(f.files[0].path); roundTripFakeStore();
    const result = await callIpcRaw('projects:set-working-source-selection', f.id, identity, { action: 'exclude', expectedRevision: 1 });
    assert.equal(result.success, true);
    assert.equal(result.selection.reason, 'user-excluded');
    assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).materializable, false);
    workspace = await callIpcRaw('projects:get-asset-workspace', f.id);
    assert.equal(workspace.files.find(file => file.name === 'Original.ai').includedAsDependency, true);
    assert.equal(f.stored().files.length, 3);
  });

  for (const mode of ['cancelled', 'error']) {
    continuationTest(`S3 production poll clears snapshot after refresh ${mode}`, async () => {
      resetTestHomeWorkspace(); setChildProcessHandler(() => ({ stdout: '' }));
      const project = await createProject('Synthetic interrupted refresh'); clearTrackedTimers();
      const token = metadataTestHooks.getActiveWatchingActivationToken(project.id);
      const asset = path.join(TEST_HOME, 'Desktop', 'Poll-asset.png'); fs.writeFileSync(asset, 'synthetic');
      metadataTestHooks.seedSnapshot(project.id, { activationToken: token, current: '/Users/synthetic/A.ai', paths: ['/Users/synthetic/A.ai'] });
      setChildProcessHandler(request => {
        if (request.kind === 'exec' && request.command.includes('Adobe Photoshop')) return { stdout: 'Adobe Photoshop' };
        if (isOsascriptInvocation(request, 'crate-ps-poll.applescript')) return { stdout: asset + '\n' };
        return { stdout: '' };
      });
      let refreshCalls = 0;
      const original = metadataTestHooks.replacePollRefresh(async () => {
        refreshCalls++;
        if (mode === 'error') throw new Error('synthetic refresh failure');
        return { cancelled: true };
      });
      try { await metadataTestHooks.pollPsForProjectCore(project.id, token, null); }
      finally { metadataTestHooks.replacePollRefresh(original); setChildProcessHandler(() => ({ stdout: '' })); clearTrackedTimers(); }
      assert.equal(refreshCalls, 1);
      assert.equal(metadataTestHooks.readSnapshot(project.id), undefined);
    });
  }

}
