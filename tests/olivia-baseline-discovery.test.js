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
  '  selectProjectFilesForPackaging, extractLinkedAssets, extractLinkedAssetsIdml, createProjectFileVisualIdentity, getAssetBaselineSourceRecoveryRouteKey, getWorkingSourceMembership,\n' +
  '  clearPsdParseDebounce(filePath) { psdParseDebounce.delete(filePath); },\n' +
  '  pollPsForProject, pollLsofForProject, projectHasUnresolvedLocalAssetBaseline,\n' +
  '  getScannedPaths(id) { return [...(scannedDesignFiles.get(id) || [])]; },\n' +
  '  captureProjectOperation,\n  runScanOnOpen');
// Exercise the actual retained parser and wire inspection in the complete main
// IPC/store route; the utility-process transport and Electron remain modeled.
replaceExactlyOnce('const fixture = structuredClone(currentPsdFixture);',
  "const fixture = currentPsdFixture === 'actual-source-buffer' ? null : structuredClone(currentPsdFixture);");
replaceExactlyOnce('                  psd: fixture,',
  "                  psd: fixture || originalLoad.call(Module, 'ag-psd/dist/index.js', module).readPsd(fs.readFileSync(filePath), { skipLayerImageData: true, skipCompositeImageData: true }),\n" +
  "                  framing: fixture ? undefined : require('../parsers/add-files-psd-worker').inspectPsdLinkFraming(fs.readFileSync(filePath)),");
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
      const assetOnly = await callIpcRaw('projects:prepare-package-review', f.project.id);
      assert.equal(assetOnly.materializable, true);
      assert.deepEqual(assetOnly.files.map(file => file.name), ['Link_0.png']);
      assert.equal(assetOnly.semanticCounts.selectedWorkingSources, 0);
      assert.equal(assetOnly.semanticCounts.excludedWorkingSources, 1);
      assert.equal(assetOnly.semanticCounts.includedAssets, 1);
      await callIpcRaw('projects:set-existing-assets-decision', f.project.id, 'include');
      roundTripFakeStore();
      let current = await callIpcRaw('projects:get-asset-workspace', f.project.id);
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
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.project.id)).files.length, 1);
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
      f.state.opened = true; await f.live(); await assertComplete(f);
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
    if (!container) fs.writeFileSync(f.filePath, phase === 'zero' ? 'empty source' : known);
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
    } finally { fs.promises.readFile = originalRead; clearTrackedTimers(); }
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
      f.current().workingSourceVerification[key] = { status: 'failed', selectionRevision: 0, attempt: 'known-failure',
        reason: 'scan-failed', requiredReferences: [], unresolved: [{ reason: 'scan-failed' }] };
      assert.equal((await callIpcRaw('projects:prepare-package-review', project.id)).materializable, false,
        'revision zero does not waive concrete persisted failure');
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
  const psdId = '22222222-2222-4222-8222-222222222222';
  async function workingPsdFixture(linkedFiles, children = []) {
    const actual = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
    const write = (linkedFiles, children = [], width = 1) => actual.writePsdBuffer({ width, height: 1, linkedFiles, children });
    const f = await correctionProject('.psd', write(linkedFiles, children));
    const originalTmpdir = os.tmpdir;
    const privateTmp = fs.mkdtempSync(path.join(TEST_HOME, 'Documents', 'cycle2-owned-psd-'));
    os.tmpdir = () => privateTmp;
    currentPsdFixture = 'actual-source-buffer';
    const rows = () => [...f.current().files, ...(f.current().pendingFiles || [])].filter(file => file.source === 'psd-embedded');
    const workspace = await callIpcRaw('projects:get-asset-workspace', f.project.id);
    const source = workspace.files.find(file => file.name === path.basename(f.filePath));
    await callIpcRaw('projects:set-working-source-selection', f.project.id, source.visualIdentity, { action: 'exclude', expectedRevision: 0 });
    assert.equal((await callIpcRaw('projects:set-working-source-selection', f.project.id, source.visualIdentity,
      { action: 'restore', expectedRevision: 1 })).verificationStatus, 'scanned');
    return { ...f, rows, write, source, privateTmp, actual,
      async save(linkedFiles, children = [], width = 1) {
        fs.writeFileSync(f.filePath, write(linkedFiles, children, width));
        const result = await metadataTestHooks.runScanOnSave(f.project.id, f.filePath);
        assert.equal(result.success, true); return result;
      },
      cleanup() { currentPsdFixture = { children: [], linkedFiles: [] }; os.tmpdir = originalTmpdir;
        fs.rmSync(privateTmp, { recursive: true, force: true }); clearTrackedTimers(); },
    };
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
      assert.ok(f.current().files.includes(old)); assert.ok(f.current().files.includes(current));
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
      if (args[0] === '-p') return { stdout: !content ? '<Document/>' :
        (args[2].endsWith('.json') ? JSON.stringify({ externalLink: content }) : `<Link LinkResourceURI="file:${content}"/>`) };
      return { stdout: '' };
    });
    const created = await createProject('Ordinary route ' + ext); clearTrackedTimers();
    const project = storeInstance.data.projects.find(p => p.id === created.id);
    project.assetBaseline = { schemaVersion: 1, status: 'legacy-included', decision: 'include', establishedAt: Date.now() };
    project.files.push({ path: filePath, name: 'Route' + ext, ext, source: 'user-added', acceptedPending: true,
      projectRole: 'source', addedAt: Date.now() });
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
    if (mode === 'unsupported') {
      assert.equal(result.semanticCounts.unresolvedVerification, 1);
      assert.ok(verification.unresolved.some(item => item.reason === 'unsupported-declared-link-uri'));
    }
    if (mode === 'failed') assert.equal(result.semanticCounts.unresolvedVerification, 1);
    if (mode === 'zero') assert.equal(result.semanticCounts.unresolvedVerification, 0);
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
}
