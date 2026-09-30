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
  '  pollPsForProject, pollLsofForProject, projectHasUnresolvedLocalAssetBaseline,\n' +
  '  getScannedPaths(id) { return [...(scannedDesignFiles.get(id) || [])]; },\n' +
  '  captureProjectOperation,\n  runScanOnOpen');
const compiled = new Module(harnessPath, module);
compiled.filename = harnessPath;
compiled.paths = Module._nodeModulePaths(__dirname);
compiled._compile(harness + '\n(' + baselineCases.toString() + ')();\n', harnessPath);

function baselineCases() {
  function deferred() {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return { promise, release };
  }

  async function fixture({ opened = false, modified = false, descriptor = false, sources = 1, malformed = false, structuredLinks = true } = {}) {
    resetTestHomeWorkspace();
    const paths = Array.from({ length: sources }, (_, i) => ({
      source: path.join(TEST_HOME, 'Desktop', `Design_${i}.ai`),
      link: path.join(TEST_HOME, 'Desktop', `Link_${i}.png`),
    }));
    for (const p of paths) {
      fs.writeFileSync(p.link, 'synthetic PNG fixture');
      if (malformed) fs.writeFileSync(p.source, '%PDF-1.7\n' + p.link + '\nmissing EOF');
      else writeSyntheticAiFile(p.source, p.link);
    }
    const state = { opened, modified, descriptor, visible: sources };
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
          `DOC\t${p.source}\t${path.basename(p.source)}\t${state.modified}\t${i === 0}\n` +
          (structuredLinks ? `LINK\t${p.source}\t${path.basename(p.source)}\t${p.link}\t${state.modified}\t${i === 0}\n` : '')
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
}
