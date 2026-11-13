'use strict';

// Full-main regression for a scan that drains without publishing because a
// DIFFERENT source legitimately revised the Illustrator scope after this scan
// reserved its receipt. Runs production main/IPC/store/package gates through the
// existing dependency-free Electron harness. Files are synthetic. The foreign
// admission is injected at the linked-path existence check, after the source
// digest; this suite does not hold or gate the digest promise.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('./bounded-assert');
const harnessPath = path.join(__dirname, 'provenance-dual-write.test.js');
let harness = fs.readFileSync(harnessPath, 'utf8');
function replaceOnce(before, after) {
  assert.equal(harness.split(before).length - 1, 1, `scope retirement adapter drift: ${before}`);
  harness = harness.replace(before, after);
}
replaceOnce("const test = require('node:test');", "const scopeTest = require('node:test'); const test = new Proxy(scopeTest, { apply() {} });");
// The linked-asset matcher recognizes /Users and /Volumes paths only; keep the
// synthetic home there, as the continuation suite does.
replaceOnce("fs.mkdtempSync(path.join(os.tmpdir(), 'crate-provenance-dual-write-home-'))",
  "fs.mkdtempSync(path.join(process.env.CRATE_TEST_OUTPUT_ROOT || path.dirname(MAIN_UNDER_TEST_ROOT), 'scope-retirement-synthetic-home-'))");
replaceOnce('  captureProjectOperation,\n  runScanOnOpen',
  '  admitIllustratorRelationshipPathsForProject, getAssetBaselineSourceRecoveryRouteKey, getWorkingSourceVerification,\n' +
  '  scanLeases() { return workingSourceScanLeases; }, scanOperationCount() { return workingSourceScanOperations.size; },\n' +
  '  bumpWatchingGeneration() { watchingActivationSequence++; },\n' +
  '  captureProjectOperation,\n  runScanOnOpen');
const compiled = new Module(harnessPath, module);
compiled.filename = harnessPath;
compiled.paths = Module._nodeModulePaths(__dirname);
compiled._compile(harness + '\n(' + scopeRetirementCases.toString() + ')();\n', harnessPath);

function scopeRetirementCases() {
  async function scopeFixture() {
    const project = await createProject('Scope retirement');
    const dir = path.join(TEST_HOME, 'Desktop', `scope-retire-${crypto.randomUUID()}`);
    fs.mkdirSync(dir);
    const p = name => path.join(dir, name);
    fs.writeFileSync(p('B-link.png'), 'synthetic B link');
    fs.writeFileSync(p('Other-link.png'), 'synthetic Other link');
    writeSyntheticAiFile(p('B.ai'), p('B-link.png'));
    writeSyntheticAiFile(p('Other.ai'), p('Other-link.png'));
    const rows = Object.fromEntries(['B.ai', 'Other.ai'].map(name => [name, { fileId: name, path: p(name), name, ext: '.ai',
      projectRole: 'source', source: 'manual-browse', addedAt: Date.now() }]));
    await setProjectFiles(project.id, { files: Object.values(rows) });
    roundTripFakeStore();
    const stored = () => storeInstance.get('projects', []).find(item => item.id === project.id);
    async function choose(name, action) {
      const row = (await callIpcRaw('projects:get-asset-workspace', project.id)).files.find(item => item.name === name);
      assert.ok(row, name);
      const response = await callIpcRaw('projects:set-working-source-selection', project.id, row.visualIdentity,
        { action, expectedRevision: row.selectionRevision });
      assert.equal(response.success, true, JSON.stringify(response));
    }
    // Engage selection so the receipt gates packaging.
    for (const name of ['B.ai', 'Other.ai']) { await choose(name, 'exclude'); await choose(name, 'restore'); }
    const key = metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(stored(), rows['B.ai']);
    const receipt = () => stored().workingSourceVerification?.[key];
    assert.equal(receipt().status, 'scanned', 'fixture starts from a genuine scanned receipt');
    return { id: project.id, rows, dir, stored, key, receipt, choose, link: p('B-link.png'), otherLink: p('Other-link.png') };
  }

  // A different source's legitimate admission revises the shared scope.
  function admitForeignSource(f) {
    const before = metadataTestHooks.getProjectOperationScope(f.id).revision;
    metadataTestHooks.admitIllustratorRelationshipPathsForProject(f.id, f.rows['Other.ai'].path, [f.otherLink, f.link + '.foreign']);
    const scope = metadataTestHooks.getProjectOperationScope(f.id);
    assert.equal(scope.revision, before + 1, `foreign source revised the scope (status ${scope.status})`);
  }

  // Run scan B; `duringScan` runs once when B checks its linked path, i.e. after
  // B reserved its pending receipt and before it can publish.
  async function runScanB(f, duringScan = null) {
    const operation = metadataTestHooks.captureProjectOperation(f.id);
    const originalAccess = fs.promises.access;
    let armed = !!duringScan, observed = null, hookError = null;
    fs.promises.access = async function accessForTest(target, ...args) {
      if (armed && path.resolve(String(target)) === path.resolve(f.link)) {
        armed = false;
        observed = structuredClone(f.receipt());
        // B swallows access errors as a missing link; keep hook failures visible.
        try { await duringScan(observed); } catch (error) { hookError = error; }
      }
      return originalAccess.call(fs.promises, target, ...args);
    };
    try {
      const result = await metadataTestHooks.runScanOnOpen(f.id, f.rows['B.ai'].path, operation.activationToken, operation,
        { establishBaseline: false, verifySelectedSource: true });
      await waitForCondition(() => metadataTestHooks.scanOperationCount() === 0, 'scan B drained');
      if (hookError) throw hookError;
      assert.equal(armed, false, 'scan B reached its linked-path check');
      return { result, observed };
    } finally {
      fs.promises.access = originalAccess;
      operation.close();
      clearTrackedTimers();
    }
  }

  // Seed concrete prior obligations so preservation is checked, not assumed.
  function seedPriorEvidence(f) {
    const record = f.receipt();
    record.unresolved = [{ reason: 'declared-reference-unresolved' }];
    record.requiredEmbeddedOutputs = [{ path: path.join(f.dir, 'embedded-output.png'),
      sourceDigest: record.sourceFingerprint, outputDigest: 'a'.repeat(64) }];
    roundTripFakeStore();
    assert.ok(metadataTestHooks.getWorkingSourceVerification(f.stored(), f.rows['B.ai']), 'seeded receipt stays valid');
    return structuredClone(f.receipt());
  }

  scopeTest('foreign-source scope change retires stale scan B as interrupted and keeps evidence and the package block', { timeout: 30000 }, async () => {
    const f = await scopeFixture();
    const prior = seedPriorEvidence(f);
    const { result, observed } = await runScanB(f, async pending => {
      assert.equal(pending.status, 'pending');
      admitForeignSource(f);
    });
    assert.notEqual(result?.success, true, 'stale scan B cannot report success');
    const after = f.receipt();
    assert.notEqual(after.status, 'pending', 'scan B must not leave its own receipt pending after draining');
    assert.equal(after.status, 'failed');
    assert.equal(after.reason, 'scan-interrupted');
    assert.equal(after.attempt, observed.attempt, 'retired exactly scan B\'s own attempt');
    assert.equal(after.selectionRevision, observed.selectionRevision);
    assert.deepEqual(after.requiredReferences, prior.requiredReferences);
    assert.deepEqual(after.requiredEmbeddedOutputs, prior.requiredEmbeddedOutputs);
    assert.deepEqual(after.unresolved, [...prior.unresolved, { reason: 'scan-interrupted' }]);
    assert.equal(after.sourceFingerprint, prior.sourceFingerprint);
    assert.deepEqual(after.sourceIdentity, prior.sourceIdentity);
    assert.equal(Object.hasOwn(after, 'pendingReviewFacts'), false);
    assert.ok(metadataTestHooks.getWorkingSourceVerification(f.stored(), f.rows['B.ai']), 'retired receipt is valid, not an invalid-record hold');
    const row = (await callIpcRaw('projects:get-asset-workspace', f.id)).files.find(item => item.name === 'B.ai');
    assert.equal(row.verificationStatus, 'failed');
    const review = await callIpcRaw('projects:prepare-package-review', f.id);
    assert.equal(review.token, undefined, 'packaging stays blocked until genuine re-verification');
    // Genuine re-verification on the new scope clears the interruption.
    const fresh = await runScanB(f);
    assert.equal(fresh.result.success, true);
    assert.equal(f.receipt().status, 'scanned');
    assert.notEqual(f.receipt().attempt, observed.attempt);
  });

  scopeTest('current scan with no scope change still publishes its own success', { timeout: 30000 }, async () => {
    const f = await scopeFixture();
    const before = structuredClone(f.receipt());
    const { result, observed } = await runScanB(f, async pending => { assert.equal(pending.status, 'pending'); });
    assert.equal(result.success, true);
    assert.equal(f.receipt().status, 'scanned');
    assert.equal(f.receipt().attempt, observed.attempt);
    assert.equal(f.receipt().sourceFingerprint, before.sourceFingerprint);
    assert.ok((await callIpcRaw('projects:prepare-package-review', f.id)).token);
  });

  scopeTest('A/B/C: a completed newer scan C keeps its receipt when stale B drains', { timeout: 30000 }, async () => {
    const f = await scopeFixture();
    const a = structuredClone(f.receipt());
    let c = null;
    const { observed } = await runScanB(f, async () => {
      admitForeignSource(f);
      const operation = metadataTestHooks.captureProjectOperation(f.id);
      try {
        const result = await metadataTestHooks.runScanOnOpen(f.id, f.rows['B.ai'].path, operation.activationToken, operation,
          { establishBaseline: false, verifySelectedSource: true });
        assert.equal(result.success, true, 'C runs on the revised scope');
      } finally { operation.close(); }
      c = structuredClone(f.receipt());
      assert.equal(c.status, 'scanned');
    });
    assert.notEqual(observed.attempt, a.attempt);
    assert.notEqual(c.attempt, observed.attempt);
    assert.deepEqual(f.receipt(), c, 'stale B never overwrites completed C');
  });

  // Real routes build their own operation facades; each must let its own
  // stranded receipt retire after a foreign scope change.
  async function withForeignAdmissionAt(f, linkPath, sourcePath, run) {
    const originalAccess = fs.promises.access;
    let armed = true, hookError = null, observed = null;
    const receiptFor = () => {
      const project = f.stored(), row = project.files.find(file => file.path === sourcePath);
      return row && project.workingSourceVerification?.[metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(project, row)];
    };
    fs.promises.access = async function accessForTest(target, ...args) {
      if (armed && path.resolve(String(target)) === path.resolve(linkPath)) {
        armed = false;
        try { observed = structuredClone(receiptFor()); admitForeignSource(f); } catch (error) { hookError = error; }
      }
      return originalAccess.call(fs.promises, target, ...args);
    };
    try {
      await run();
      await waitForCondition(() => !armed && metadataTestHooks.scanOperationCount() === 0, 'route scan reached its link check and drained', 10000);
      if (hookError) throw hookError;
      return { observed, after: receiptFor() };
    } finally {
      fs.promises.access = originalAccess;
      clearTrackedTimers();
    }
  }

  for (const route of ['add-files', 'file-change']) {
    scopeTest(`${route} route retires its own stranded receipt after a foreign scope change`, { timeout: 30000 }, async () => {
      const f = await scopeFixture();
      let sourcePath = f.rows['B.ai'].path, linkPath = f.link, run = () => emitWatcher('change', sourcePath);
      if (route === 'add-files') {
        sourcePath = path.join(f.dir, 'C.ai'); linkPath = path.join(f.dir, 'C-link.png');
        fs.writeFileSync(linkPath, 'synthetic C link');
        writeSyntheticAiFile(sourcePath, linkPath);
        manualDialogFor([sourcePath]);
        run = () => callIpcRaw('projects:add-files', f.id, 'scope_retirement_add_files');
      }
      const { observed, after } = await withForeignAdmissionAt(f, linkPath, sourcePath, run);
      assert.equal(observed?.status, 'pending', 'the route reserved its receipt before the foreign change');
      assert.equal(after.status, 'failed');
      assert.equal(after.reason, 'scan-interrupted');
      assert.equal(after.attempt, observed.attempt);
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).token, undefined);
    });
  }

  const negatives = {
    account: async () => { testAccountSession.invalidate(); },
    'project paused': async f => { await callIpcRaw('projects:pause', f.id); },
    'watching generation': async () => { metadataTestHooks.bumpWatchingGeneration(); },
    'selection revision': async f => { await f.choose('B.ai', 'exclude'); },
    'lease ownership': async f => { metadataTestHooks.scanLeases().set(f.id + ':' + f.key, { cancel() {} }); },
    'lease timeout': async f => { metadataTestHooks.scanLeases().get(f.id + ':' + f.key).cancel('timeout'); },
    'recovery hold': async f => { f.stored().workingSourceRecovery = { version: 2 }; },
    'invalid receipt': async f => { f.stored().workingSourceVerification[f.key].inventoryStatus = 'complete'; },
  };
  for (const [name, change] of Object.entries(negatives)) {
    scopeTest(`stale scan B does not retire its receipt after ${name} changes`, { timeout: 30000 }, async () => {
      const f = await scopeFixture();
      let snapshot = null;
      try {
        const { observed } = await runScanB(f, async () => {
          admitForeignSource(f);
          await change(f);
          snapshot = structuredClone(f.receipt());
        });
        assert.deepEqual(f.receipt(), snapshot, `scan B left its receipt unchanged after ${name} changed`);
        if (!['selection revision'].includes(name)) {
          assert.equal(f.receipt().status, 'pending', 'documented follow-up: this orphan stays pending in the strict scope-only fix');
          assert.equal(f.receipt().attempt, observed.attempt);
        }
      } finally {
        delete f.stored().workingSourceRecovery;
        metadataTestHooks.scanLeases().delete(f.id + ':' + f.key);
        await testAccountSession.restore();
      }
    });
  }
}
