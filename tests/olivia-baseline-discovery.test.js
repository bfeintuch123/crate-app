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
  '  selectProjectFilesForPackaging, extractLinkedAssets, extractLinkedAssetsIdml, createProjectFileVisualIdentity, getAssetBaselineSourceRecoveryRouteKey, getWorkingSourceMembership, getWorkingSourceVerification, getStablePackageReviewSourceContentFingerprint, getPackageReviewSourceFingerprint,\n' +
  '  pauseWorkingPsdPublicationSource(wait) { const prepare = prepareWorkingPsdReconciliation, digest = getAddFilesCurrentSourceDigest; let prepared = false; prepareWorkingPsdReconciliation = async (...args) => { const result = await prepare(...args); prepared = true; return result; }; getAddFilesCurrentSourceDigest = async (...args) => { if (prepared) { prepared = false; await wait(); } return digest(...args); }; return () => { prepareWorkingPsdReconciliation = prepare; getAddFilesCurrentSourceDigest = digest; }; },\n' +
  '  forceWorkingPsdPendingAdmission() { const stage = stageLiveObservedFile; stageLiveObservedFile = (project, file, observation = {}) => stage(project, file, file.source === \'psd-embedded\' ? { ...observation, forcePending: true } : observation); return () => { stageLiveObservedFile = stage; }; },\n' +
  '  clearPsdParseDebounce(filePath) { psdParseDebounce.delete(filePath); },\n' +
  '  pollPsForProject, pollLsofForProject, projectHasUnresolvedLocalAssetBaseline,\n' +
  '  getIllustratorPollState(id) { return { scopeRevision: getIllustratorActivationScope(id)?.revision, inProgress: psInProgress.has(id) }; },\n' +
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
    const counts = { processChecks: 0, enumerations: 0, queries: 0, observerScripts: [], otherObserverScripts: [] };
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

  for (const scenario of ['running-other-document', 'running-no-documents', 'selected-present', 'closed',
    'malformed', 'count-mismatch', 'query-error-count', 'script-query-failure', 'script-automation-denied', 'process-policy-denied',
    'snapshot-source-change', 'running-bare-name', 'closed-lookalike-processes',
    'process-invocation-failure', 'process-exit-one', 'process-access-denied', 'process-timeout', 'process-signal',
    'process-overflow', 'process-empty', 'process-unknown', 'process-malformed', 'process-truncated',
    'process-duplicate-pid', 'process-invalid-pid', 'process-unknown-command', 'process-control-byte',
    'process-blank-row', 'process-stderr']) {
    baselineTest(`LD-1 M1 InDesign: ${scenario}`, async () => {
      const f = await ld1CompletedFixture();
      const d = ld1InDesignFixture(f, scenario);
      const originalBytes = fs.readFileSync(d.source);
      try {
        const result = await f.add(d.source);
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
      const safe = path.join(TEST_HOME, 'Desktop', 'Safe.txt'); fs.writeFileSync(safe, 'independent asset');
      f.current().files.push({ path: safe, name: 'Safe.txt', ext: '.txt', source: 'user-added', acceptedPending: true, projectRole: 'asset' });
      const q = path.join(TEST_HOME, 'Desktop', 'Unrelated.ai'); fs.writeFileSync(q, '%PDF-1.7\n%%EOF\n');
      f.current().files.push({ path: q, name: 'Unrelated.ai', ext: '.ai', source: 'user-added', acceptedPending: true, projectRole: 'source' });
      let ws = await callIpcRaw('projects:get-asset-workspace', f.project.id); const unrelated = ws.files.find(row => row.name === 'Unrelated.ai');
      await callIpcRaw('projects:set-working-source-selection', f.project.id, unrelated.visualIdentity, { action: 'exclude', expectedRevision: 0 });
      currentPsdFixture = 'actual-source-buffer'; await f.save([object]);
      const holds = JSON.parse(JSON.stringify(f.current().workingSourceRelationshipHolds)); assert.equal(holds.length, 1);
      await callIpcRaw('projects:set-working-source-selection', f.project.id, f.source.visualIdentity, { action: 'exclude', expectedRevision: 0 });
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
