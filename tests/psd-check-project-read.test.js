'use strict';

// PSD transaction checks: one project read per synchronous check, with no loss
// of liveness or new-asset detection. Reuses the real IPC/store/observer
// harness (Electron, utilityProcess transport and electron-store are modeled;
// the real PSD worker parse code and main.js consumer run). store.get applies
// conf-style copy semantics. Store-read counters are harness counts, not
// native timing, and passing here is not native acceptance.
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
// The source parser accepts /Users/ links. Keep physical fixtures in a disposable
// sibling of this checkout, never the user's actual HOME or private projects.
replaceExactlyOnce("fs.mkdtempSync(path.join(os.tmpdir(), 'crate-provenance-dual-write-home-'))",
  "fs.mkdtempSync(path.join(path.dirname(MAIN_UNDER_TEST_ROOT), 'psd-check-read-synthetic-home-'))");
// Bracket every PSD transaction check() with a test probe. This instruments the
// loaded source only; it does not change the check body under test.
replaceExactlyOnce('  return module._compile(`${source}',
  "  {\n" +
  "    const transactionAt = source.indexOf('function createAddFilesPsdTransaction(');\n" +
  "    const checkAnchor = '\\n  const check = () => {';\n" +
  "    const checkAt = source.indexOf(checkAnchor, transactionAt);\n" +
  "    assert.ok(transactionAt >= 0 && checkAt > transactionAt, 'PSD transaction check anchor');\n" +
  "    source = source.slice(0, checkAt) +\n" +
  "      '\\n  const check = () => { const probe = global.__cratePsdCheckProbe; probe?.enter(); try { return checkUnderProbe(); } finally { probe?.exit(); } };' +\n" +
  "      '\\n  const checkUnderProbe = () => {' + source.slice(checkAt + checkAnchor.length);\n" +
  "  }\n" +
  '  return module._compile(`${source}');
replaceExactlyOnce('  captureProjectOperation,\n  runScanOnOpen',
  '  getWorkingSourceVerification, getAssetBaselineSourceRecoveryRouteKey,\n' +
  '  getWorkingScanLifetime() { return { operations: workingSourceScanOperations.size, leases: workingSourceScanLeases.size }; },\n' +
  '  pauseWorkingPsdPublicationSource(wait) { const prepare = prepareWorkingPsdReconciliation, digest = getAddFilesCurrentSourceDigest; let prepared = false; prepareWorkingPsdReconciliation = async (...args) => { const result = await prepare(...args); prepared = true; return result; }; getAddFilesCurrentSourceDigest = async (...args) => { if (prepared) { prepared = false; await wait(); } return digest(...args); }; return () => { prepareWorkingPsdReconciliation = prepare; getAddFilesCurrentSourceDigest = digest; }; },\n' +
  '  clearPsdParseDebounce(filePath) { psdParseDebounce.delete(filePath); },\n' +
  '  bumpIllustratorActivationScopeRevision(projectId) { const scope = illustratorActivationScopes.get(projectId); if (!scope) return false; scope.revision += 1; return true; },\n' +
  '  hasIllustratorActivationScope(projectId) { return illustratorActivationScopes.has(projectId); },\n' +
  "  projectCheckRead: typeof openProjectCheckRead === 'function' ? { open: openProjectCheckRead, isActiveWatchingProject, captureProjectOperation } : null,\n" +
  '  captureProjectOperation,\n  runScanOnOpen');
replaceExactlyOnce('const fixture = structuredClone(currentPsdFixture);',
  "const fixture = currentPsdFixture === 'actual-source-buffer' ? null : structuredClone(currentPsdFixture);");
replaceExactlyOnce('                  psd: fixture,',
  "                  psd: fixture || originalLoad.call(Module, 'ag-psd/dist/index.js', module).readPsd(fs.readFileSync(filePath), { skipLayerImageData: true, skipCompositeImageData: true }),\n" +
  "                  framing: fixture ? undefined : require('../parsers/add-files-psd-worker').inspectPsdLinkFraming(fs.readFileSync(filePath)),");
const compiled = new Module(harnessPath, module);
compiled.filename = harnessPath;
compiled.paths = Module._nodeModulePaths(__dirname);
compiled._compile(harness + '\n(' + checkReadCases.toString() + ')();\n', harnessPath);

function checkReadCases() {
  const agPsd = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
  const desk = () => path.join(TEST_HOME, 'Desktop');
  const sha256 = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  const turn = () => new Promise(resolve => setImmediate(resolve));

  function linkRecord(filePath) {
    return { id: crypto.randomUUID(), name: path.basename(filePath), childDocumentID: '',
      linkedFile: { fileSize: 10, name: path.basename(filePath), fullPath: filePath, originalPath: filePath,
        relativePath: '../' + path.basename(filePath) } };
  }
  function writeLinks(count, prefix = 'Link') {
    const paths = [];
    for (let i = 0; i < count; i++) {
      const linkPath = path.join(desk(), `${prefix}_${String(i).padStart(3, '0')}.png`);
      fs.writeFileSync(linkPath, `synthetic linked bytes ${prefix} ${i}`);
      paths.push(linkPath);
    }
    return paths;
  }
  function writePsd(filePath, linkPaths) {
    fs.writeFileSync(filePath, Buffer.from(agPsd.writePsdBuffer({ width: 1, height: 1, linkedFiles: linkPaths.map(linkRecord) })));
  }

  // One probe per test: conf-style copies on store.get('projects'), read/write
  // counts inside each check, and optional between-check / in-check injections.
  function installProbe() {
    const originalGet = storeInstance.get, originalSet = storeInstance.set;
    const probe = {
      depth: 0, armed: false, checks: 0, getsInCheck: [], setsInCheck: 0, gets: 0, sets: 0,
      afterCheck: null, onFirstGetInCheck: null, current: 0,
      enter() { this.depth++; if (this.depth === 1) { this.checks++; this.current = 0; } },
      exit() {
        this.depth--;
        if (this.depth !== 0) return;
        if (this.armed) this.getsInCheck.push(this.current);
        const hook = this.afterCheck;
        const index = this.checks;
        // Between checks: run on a later microtask, never inside the check frame.
        if (hook) queueMicrotask(() => hook(index));
      },
      reset() {
        Object.assign(this, { checks: 0, getsInCheck: [], setsInCheck: 0, gets: 0, sets: 0, afterCheck: null, onFirstGetInCheck: null });
      },
      get maxGetsPerCheck() { return this.getsInCheck.reduce((max, value) => Math.max(max, value), 0); },
    };
    storeInstance.get = function probedGet(...args) {
      const value = originalGet.apply(this, args);
      if (args[0] === 'projects') {
        if (probe.armed) probe.gets++;
        if (probe.depth > 0) {
          probe.current++;
          if (probe.current === 1 && probe.onFirstGetInCheck) {
            const copy = value === undefined ? value : JSON.parse(JSON.stringify(value));
            // A write that lands inside this check after its first read.
            probe.onFirstGetInCheck(probe.checks);
            return copy;
          }
        }
      }
      return value === undefined ? value : JSON.parse(JSON.stringify(value));
    };
    storeInstance.set = function probedSet(...args) {
      if (args[0] === 'projects') {
        if (probe.armed) probe.sets++;
        if (probe.depth > 0) probe.setsInCheck++;
      }
      return originalSet.apply(this, args);
    };
    global.__cratePsdCheckProbe = probe;
    const originalTmpdir = os.tmpdir;
    const privateTmp = fs.mkdtempSync(path.join(TEST_HOME, 'Documents', 'psd-check-read-tmp-'));
    os.tmpdir = () => privateTmp;
    currentPsdFixture = 'actual-source-buffer';
    probe.restore = () => {
      storeInstance.get = originalGet; storeInstance.set = originalSet;
      delete global.__cratePsdCheckProbe;
      currentPsdFixture = { children: [], linkedFiles: [] };
      os.tmpdir = originalTmpdir;
      fs.rmSync(privateTmp, { recursive: true, force: true });
      clearTrackedTimers();
    };
    return probe;
  }

  const stored = projectId => storeInstance.data.projects.find(project => project.id === projectId);
  function receiptOf(projectId, psdPath) {
    const project = stored(projectId);
    const row = project?.files?.find(file => file.path === psdPath);
    return project && row ? metadataTestHooks.getWorkingSourceVerification(project, row) : null;
  }
  function outcome(projectId, psdPath) {
    const project = stored(projectId);
    if (!project) return { project: 'missing', leases: metadataTestHooks.getWorkingScanLifetime().leases };
    const receipt = receiptOf(projectId, psdPath);
    return {
      status: project.status,
      baseline: project.assetBaseline?.status || null,
      failedRequiredSources: (project.assetBaseline?.failedRequiredSources || []).length,
      files: (project.files || []).map(file => path.basename(file.path)).sort(),
      pending: (project.pendingFiles || []).map(file => path.basename(file.path)).sort(),
      receipt: receipt && {
        status: receipt.status,
        reason: receipt.reason,
        refs: (receipt.requiredReferences || []).map(ref => path.basename(ref.path || '')).sort(),
        unresolved: [...new Set((receipt.unresolved || []).map(item => item.reason))].sort(),
        fingerprintIsCurrentBytes: !!receipt.sourceFingerprint && fs.existsSync(psdPath) && receipt.sourceFingerprint === sha256(psdPath),
      },
      leases: metadataTestHooks.getWorkingScanLifetime().leases,
    };
  }
  const refNames = paths => paths.map(item => path.basename(item)).sort();

  async function addPsdProject(probe, { links = 10, name = 'Synthetic.psd', arm = true, before } = {}) {
    resetTestHomeWorkspace(); setChildProcessHandler(() => ({ stdout: '' }));
    const linkPaths = writeLinks(links);
    const psdPath = path.join(desk(), name);
    writePsd(psdPath, linkPaths);
    const project = await createProject('PSD check read');
    clearTrackedTimers();
    manualDialogFor([psdPath]);
    probe.reset(); probe.armed = arm;
    before?.(project, psdPath, linkPaths);
    let result;
    try { result = await callIpcRaw('projects:add-files', project.id, crypto.randomUUID()); }
    catch (error) { result = { thrown: error.message }; }
    probe.armed = false;
    return { project, psdPath, linkPaths, result };
  }
  async function settleBaseline(projectId) {
    if (stored(projectId)?.assetBaseline?.status === 'decision-required') {
      assert.equal((await callIpcRaw('projects:set-existing-assets-decision', projectId, 'include')).success, true);
    }
  }
  async function sourceRow(projectId, psdPath) {
    const workspace = await callIpcRaw('projects:get-asset-workspace', projectId);
    return workspace.files.find(file => file.name === path.basename(psdPath));
  }
  async function exclude(projectId, psdPath) {
    const source = await sourceRow(projectId, psdPath);
    const result = await callIpcRaw('projects:set-working-source-selection', projectId, source.visualIdentity,
      { action: 'exclude', expectedRevision: source.selectionRevision });
    assert.equal(result.success, true, JSON.stringify(result));
  }
  async function restore(probe, projectId, psdPath, { arm = true, before } = {}) {
    metadataTestHooks.clearPsdParseDebounce(psdPath);
    const source = await sourceRow(projectId, psdPath);
    probe.reset(); probe.armed = arm;
    before?.();
    let result;
    try {
      result = await callIpcRaw('projects:set-working-source-selection', projectId, source.visualIdentity,
        { action: 'restore', expectedRevision: source.selectionRevision });
    } catch (error) { result = { thrown: error.message }; }
    probe.armed = false;
    return result;
  }
  // Exclude then Restore runs the same verifyRestoredWorkingSource queue that a
  // working-file choice Retry uses after its own reservation.
  async function restoreVerification(probe, projectId, psdPath, options) {
    await exclude(projectId, psdPath);
    return restore(probe, projectId, psdPath, options);
  }
  function withProbe(name, options, body) {
    baselineTest(name, { timeout: 120000, ...options }, async () => {
      const probe = installProbe();
      try { await body(probe); }
      finally { await testAccountSession.restore(); probe.restore(); }
    });
  }

  // ---------------------------------------------------------------- read budget
  // Failure-first: b1ed6fb re-reads and re-parses the whole store for every
  // predicate in a check (about 5 reads per Add Files check, 13 per Restore).
  withProbe('read budget: each PSD transaction check reads the project store at most once', {}, async probe => {
    const added = await addPsdProject(probe, { links: 10 });
    assert.ok(probe.checks > 60, `checks ${probe.checks}`);
    assert.equal(probe.setsInCheck, 0);
    assert.equal(probe.maxGetsPerCheck, 1, `Add Files gets per check ${JSON.stringify([...new Set(probe.getsInCheck)])}`);
    await settleBaseline(added.project.id);
    await restoreVerification(probe, added.project.id, added.psdPath);
    assert.ok(probe.checks > 60, `checks ${probe.checks}`);
    assert.equal(probe.setsInCheck, 0);
    assert.equal(probe.maxGetsPerCheck, 1, `Restore gets per check ${JSON.stringify([...new Set(probe.getsInCheck)])}`);
  });

  withProbe('read budget: whole-scan store reads grow by a bounded amount per link', {}, async probe => {
    const counts = {};
    for (const links of [10, 50]) {
      const added = await addPsdProject(probe, { links });
      counts[`add${links}`] = probe.gets;
      await settleBaseline(added.project.id);
      await restoreVerification(probe, added.project.id, added.psdPath);
      counts[`restore${links}`] = probe.gets;
      assert.equal(outcome(added.project.id, added.psdPath).receipt.status, 'scanned');
    }
    const addPerLink = (counts.add50 - counts.add10) / 40;
    const restorePerLink = (counts.restore50 - counts.restore10) / 40;
    console.log('PSD_CHECK_READ_BUDGET ' + JSON.stringify({ ...counts, addPerLink, restorePerLink }));
    // b1ed6fb: about 98 (Add Files) and 250 (Restore) reads per added link.
    assert.ok(addPerLink <= 30, `Add Files reads per link ${addPerLink}`);
    assert.ok(restorePerLink <= 40, `Restore reads per link ${restorePerLink}`);
  });

  // ------------------------------------------------------------ baseline parity
  for (const links of [50, 99]) {
    withProbe(`parity ${links} links: receipts, references and fingerprints are unchanged`, {}, async probe => {
      const added = await addPsdProject(probe, { links });
      const expectedRefs = refNames(added.linkPaths);
      assert.equal(Array.isArray(added.result), true, JSON.stringify(added.result).slice(0, 300));
      let state = outcome(added.project.id, added.psdPath);
      assert.equal(state.baseline, 'decision-required');
      assert.equal(state.failedRequiredSources, 0);
      assert.deepEqual(state.files, [...expectedRefs, 'Synthetic.psd'].sort());
      assert.deepEqual(state.receipt, { status: 'scanned', reason: 'ordinary-scan-finished', refs: expectedRefs,
        unresolved: [], fingerprintIsCurrentBytes: true });
      assert.equal(probe.checks, 18 * links + 17, 'every worker-message and ack check still runs');
      assert.equal(state.leases, 0);
      await settleBaseline(added.project.id);
      const result = await restoreVerification(probe, added.project.id, added.psdPath);
      assert.equal(result.success, true, JSON.stringify(result).slice(0, 300));
      assert.equal(result.verificationStatus, 'scanned');
      state = outcome(added.project.id, added.psdPath);
      assert.deepEqual(state.receipt, { status: 'scanned', reason: 'ordinary-scan-finished', refs: expectedRefs,
        unresolved: [], fingerprintIsCurrentBytes: true });
      assert.equal(probe.checks, 18 * links + 17);
      assert.equal(state.leases, 0);
    });
  }

  // --------------------------------------------- detection during an active scan
  // A Photoshop save that adds a link while the scan is in flight: the stale scan
  // must not publish, and the next verification must see the new link.
  for (const route of ['add-files', 'restore']) {
    withProbe(`detection ${route}: a save that adds a link mid-scan fails closed and the next scan finds it`, {}, async probe => {
      const extra = () => path.join(desk(), 'Added_During_Scan.png');
      const save = (psdPath, linkPaths) => index => {
        if (index !== 40) return;
        fs.writeFileSync(extra(), 'synthetic link added during scan');
        writePsd(psdPath, [...linkPaths, extra()]);
      };
      let added;
      if (route === 'add-files') {
        added = await addPsdProject(probe, { links: 10, before: (_, psdPath, linkPaths) => { probe.afterCheck = save(psdPath, linkPaths); } });
        const state = outcome(added.project.id, added.psdPath);
        assert.equal(added.result.success, false, JSON.stringify(added.result).slice(0, 200));
        assert.equal(added.result.error, 'add_files_partial_scan_failure');
        assert.equal(state.baseline, 'awaiting-first-scan');
        assert.equal(state.failedRequiredSources, 1);
        assert.equal(state.receipt.status, 'failed');
        assert.deepEqual(state.receipt.refs, []);
        assert.equal(state.files.includes('Added_During_Scan.png'), false);
      } else {
        added = await addPsdProject(probe, { links: 10 });
        await settleBaseline(added.project.id);
        await exclude(added.project.id, added.psdPath);
        const result = await restore(probe, added.project.id, added.psdPath, { before: () => { probe.afterCheck = save(added.psdPath, added.linkPaths); } });
        const state = outcome(added.project.id, added.psdPath);
        assert.notEqual(result.verificationStatus, 'scanned', JSON.stringify(result).slice(0, 200));
        assert.notEqual(state.receipt.status, 'scanned');
        assert.equal(state.receipt.refs.includes('Added_During_Scan.png'), false);
        assert.equal(state.receipt.fingerprintIsCurrentBytes, false, 'no receipt binds the saved bytes before a scan of them');
      }
      assert.equal(outcome(added.project.id, added.psdPath).leases, 0);
      await settleBaseline(added.project.id);
      const next = await restoreVerification(probe, added.project.id, added.psdPath);
      assert.equal(next.verificationStatus, 'scanned', JSON.stringify(next).slice(0, 300));
      const state = outcome(added.project.id, added.psdPath);
      assert.deepEqual(state.receipt.refs, refNames([...added.linkPaths, extra()]));
      assert.equal(state.receipt.fingerprintIsCurrentBytes, true);
    });
  }

  // Watcher events for new or moved files arrive on their own turns, between
  // checks. A newly added design file is admitted exactly as before.
  withProbe('detection: a new design file and a moved link image reported by the watcher during a scan', {}, async probe => {
    const added = await addPsdProject(probe, { links: 10 });
    await settleBaseline(added.project.id);
    const project = stored(added.project.id);
    assert.equal(project.status, 'watching');
    const newDesign = path.join(desk(), 'New_During_Scan.ai');
    const moved = path.join(desk(), 'Moved', path.basename(added.linkPaths[0]));
    const events = [];
    await exclude(added.project.id, added.psdPath);
    const result = await restore(probe, added.project.id, added.psdPath, { before: () => {
      probe.afterCheck = index => {
        if (index !== 30) return;
        writeSyntheticAiFile(newDesign, 'saved during scan');
        fs.mkdirSync(path.dirname(moved), { recursive: true });
        fs.renameSync(added.linkPaths[0], moved);
        const stats = { ...fs.statSync(newDesign), mtimeMs: project.watchStartedAt + 1, birthtimeMs: project.watchStartedAt + 1,
          isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
        events.push(emitWatcherWithStats('add', newDesign, stats));
        // Crate subscribes to add/change only (no unlink handler): a move reaches
        // the watcher as an add at the new path.
        events.push(emitWatcher('add', moved));
      };
    } });
    await Promise.all(events);
    await metadataTestHooks.waitForWatcherIdle(added.project.id);
    await runTrackedIntervalCallbacks();
    const state = outcome(added.project.id, added.psdPath);
    const latest = stored(added.project.id);
    const row = latest.files.find(file => file.path === added.psdPath);
    const receiptPaths = (metadataTestHooks.getWorkingSourceVerification(latest, row).requiredReferences || []).map(ref => ref.path);
    const movedOutcome = {
      receiptKeepsOldPath: receiptPaths.includes(added.linkPaths[0]),
      receiptHasMovedPath: receiptPaths.includes(moved),
      fileRows: latest.files.filter(file => [added.linkPaths[0], moved].includes(file.path)).map(file => file.path === moved ? 'moved' : 'old'),
      pendingRows: latest.pendingFiles.filter(file => [added.linkPaths[0], moved].includes(file.path)).map(file => file.path === moved ? 'moved' : 'old'),
    };
    console.log('PSD_CHECK_READ_WATCHER ' + JSON.stringify({ result: result.verificationStatus || result.error, receipt: state.receipt, movedOutcome,
      newDesign: state.files.includes('New_During_Scan.ai') ? 'file' : state.pending.includes('New_During_Scan.ai') ? 'pending' : 'absent' }));
    assert.equal(state.files.includes('New_During_Scan.ai') || state.pending.includes('New_During_Scan.ai'), true,
      'the new design file is admitted after the scan');
    assert.equal(state.receipt.refs.length, 10);
    // Existing gap, unchanged from b1ed6fb and documented, not fixed here: a link
    // image moved outside Photoshop is not relocated by this scan. The receipt
    // keeps the path the PSD still declares, and an image add event is not an
    // admission path.
    assert.deepEqual(movedOutcome, { receiptKeepsOldPath: true, receiptHasMovedPath: false, fileRows: ['old'], pendingRows: [] });
    assert.equal(state.leases, 0);
    await callIpcRaw('projects:pause', added.project.id);
  });

  // --------------------------------------- independent writes between checks
  withProbe('detection: independent project writes between checks are preserved and seen', {}, async probe => {
    const other = await createProject('Independent project');
    const added = await addPsdProject(probe, { links: 10 });
    await settleBaseline(added.project.id);
    const extraRow = path.join(desk(), 'Written_Between_Checks.png');
    fs.writeFileSync(extraRow, 'independent row');
    await exclude(added.project.id, added.psdPath);
    const result = await restore(probe, added.project.id, added.psdPath, { before: () => {
      probe.afterCheck = index => {
        if (index !== 25) return;
        const projects = storeInstance.data.projects;
        const target = projects.find(item => item.id === added.project.id);
        target.files.push({ path: extraRow, name: path.basename(extraRow), ext: '.png', addedAt: 1, source: 'manual',
          assetOrigin: 'existing', projectRole: 'asset' });
        projects.find(item => item.id === other.id).name = 'Renamed between checks';
        storeInstance.set('projects', projects);
      };
    } });
    assert.equal(result.verificationStatus, 'scanned', JSON.stringify(result).slice(0, 300));
    const state = outcome(added.project.id, added.psdPath);
    assert.equal(state.files.includes('Written_Between_Checks.png'), true, 'publication rereads and keeps the independent row');
    assert.equal(stored(other.id).name, 'Renamed between checks');
    assert.equal(state.receipt.refs.length, 10);
  });

  // ------------------------------------------- overlapping and fenced attempts
  withProbe('fences: a newer Restore attempt during a scan supersedes the old attempt', {}, async probe => {
    const added = await addPsdProject(probe, { links: 10 });
    await settleBaseline(added.project.id);
    let newer = null;
    await exclude(added.project.id, added.psdPath);
    const first = await restore(probe, added.project.id, added.psdPath, { before: () => {
      probe.afterCheck = index => {
        if (index !== 30 || newer) return;
        newer = (async () => {
          await exclude(added.project.id, added.psdPath);
          return restore({ reset() {}, set armed(_) {} }, added.project.id, added.psdPath, { arm: false });
        })();
      };
    } });
    const second = await newer;
    const state = outcome(added.project.id, added.psdPath);
    console.log('PSD_CHECK_READ_OVERLAP ' + JSON.stringify({ first: first.verificationStatus || first.error, second: second.verificationStatus || second.error }));
    assert.notEqual(first.verificationStatus, 'scanned');
    assert.equal(second.verificationStatus, 'scanned', JSON.stringify(second).slice(0, 300));
    assert.equal(state.receipt.status, 'scanned');
    assert.equal(state.receipt.refs.length, 10);
    assert.equal(state.leases, 0);
  });

  const invalidations = {
    // Store writes, seen by the next check's read.
    pause: async projectId => { await callIpcRaw('projects:pause', projectId); },
    exclude: async (projectId, psdPath) => { await exclude(projectId, psdPath); },
    'selection-revision': async (projectId, psdPath) => {
      // The store effect an owner Replace or Exclude has on this source's intent.
      const projects = storeInstance.data.projects;
      const project = projects.find(item => item.id === projectId);
      const row = project.files.find(file => file.path === psdPath);
      const key = metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(project, row);
      project.workingSourceSelections = { ...(project.workingSourceSelections || {}),
        [key]: { state: 'excluded', reason: 'user-excluded', revision: (project.workingSourceSelections?.[key]?.revision || 0) + 5 } };
      storeInstance.set('projects', projects);
    },
    delete: async projectId => { await callIpcRaw('projects:delete', projectId); },
    'recreate-same-id': async projectId => {
      const projects = storeInstance.data.projects;
      const index = projects.findIndex(item => item.id === projectId);
      const prior = projects[index];
      projects[index] = { id: prior.id, name: 'Recreated', status: prior.status, files: [], pendingFiles: [],
        createdAt: Date.now(), watchStartedAt: prior.watchStartedAt };
      storeInstance.set('projects', projects);
    },
    'external-replace-attempt': async (projectId, psdPath) => {
      // Another writer atomically replaces config.json with a different attempt.
      const replaced = JSON.parse(JSON.stringify(storeInstance.data.projects));
      const project = replaced.find(item => item.id === projectId);
      const row = project.files.find(file => file.path === psdPath);
      const key = metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(project, row);
      project.workingSourceVerification[key] = { ...project.workingSourceVerification[key], attempt: 'external-attempt' };
      storeInstance.data.projects = replaced;
    },
    // Live, in-memory checks.
    account: async () => { testAccountSession.generation++; },
    scope: async projectId => { assert.equal(metadataTestHooks.bumpIllustratorActivationScopeRevision(projectId), true); },
  };
  // Exact b1ed6fb outcomes. Each change starts after check 30; the scan stops at
  // the first check after the change has landed (IPC changes land after awaits).
  const fenceGolden = {
    pause: { result: 'pending', receipt: 'pending' },
    exclude: { result: 'stale', receipt: 'stale' },
    'selection-revision': { result: 'unavailable', receipt: null },
    delete: { result: 'working_source_not_found', receipt: undefined },
    'recreate-same-id': { result: 'working_source_not_found', receipt: null },
    'external-replace-attempt': { result: 'pending', receipt: 'pending' },
    account: { result: 'Sign in to Crate to use your workspace.', receipt: 'pending' },
    scope: { result: 'failed', receipt: 'failed' },
  };
  for (const [name, invalidate] of Object.entries(invalidations)) {
    withProbe(`fences: ${name} between checks stops the Restore scan before publication`, {}, async probe => {
      const added = await addPsdProject(probe, { links: 10 });
      await settleBaseline(added.project.id);
      if (name === 'scope') {
        // The scope revision is bound only when an activation scope exists; this
        // fixture must have one, or the scope fence would not be exercised.
        assert.equal(metadataTestHooks.hasIllustratorActivationScope(added.project.id), true, 'activation scope present');
      }
      await exclude(added.project.id, added.psdPath);
      let pending = null, landedAt = null;
      const result = await restore(probe, added.project.id, added.psdPath, { before: () => {
        probe.afterCheck = index => {
          if (index !== 30 || pending) return;
          pending = Promise.resolve(invalidate(added.project.id, added.psdPath)).then(() => { landedAt = probe.checks; });
        };
      } });
      await pending;
      await turn();
      const state = outcome(added.project.id, added.psdPath);
      console.log('PSD_CHECK_READ_FENCE ' + JSON.stringify({ name, checks: probe.checks, result: result?.verificationStatus || result?.error || result, receipt: state.receipt }));
      const golden = fenceGolden[name];
      assert.ok(probe.checks > 30 && landedAt !== null && probe.checks <= landedAt + 1,
        `stopped by the first check after the change landed (${probe.checks} checks, landed after ${landedAt})`);
      assert.equal(result?.verificationStatus || result?.error || result?.thrown, golden.result);
      assert.equal(state.receipt === undefined ? undefined : state.receipt?.status ?? null, golden.receipt);
      assert.equal(state.leases, 0);
    });
  }

  // -------------------------------------- normalization and writes inside checks
  withProbe('normalizer write-back during a check is not shared and the scan completes', {}, async probe => {
    const added = await addPsdProject(probe, { links: 10 });
    await settleBaseline(added.project.id);
    await exclude(added.project.id, added.psdPath);
    let planted = false;
    const result = await restore(probe, added.project.id, added.psdPath, { before: () => {
      probe.afterCheck = index => {
        if (index !== 20 || planted) return;
        planted = true;
        // getProjects removes this field and writes the store back on its next read.
        stored(added.project.id).files[0].currentSessionFilesystemEvidence = { planted: true };
      };
    } });
    assert.equal(planted, true);
    assert.equal(result.verificationStatus, 'scanned', JSON.stringify(result).slice(0, 300));
    assert.equal(probe.setsInCheck, 1, 'the only write inside any check is the single normalizer write-back');
    assert.equal(stored(added.project.id).files.some(file => 'currentSessionFilesystemEvidence' in file), false);
    assert.equal(outcome(added.project.id, added.psdPath).receipt.refs.length, 10);
  });

  withProbe('a write that lands inside a check after its read cannot let the stale scan publish', {}, async probe => {
    const added = await addPsdProject(probe, { links: 10 });
    await settleBaseline(added.project.id);
    await exclude(added.project.id, added.psdPath);
    let injected = 0;
    const result = await restore(probe, added.project.id, added.psdPath, { before: () => {
      probe.onFirstGetInCheck = index => {
        if (index !== 30 || injected) return;
        injected = index;
        stored(added.project.id).status = 'paused';
      };
    } });
    const state = outcome(added.project.id, added.psdPath);
    console.log('PSD_CHECK_READ_IN_CHECK ' + JSON.stringify({ injected, checks: probe.checks, result: result.verificationStatus || result.error, receipt: state.receipt }));
    assert.equal(injected, 30);
    // b1ed6fb re-reads inside the same check and stops at 30; one read per check
    // sees a write made after that read at the very next check (31).
    assert.equal(probe.checks, metadataTestHooks.projectCheckRead ? 31 : 30, 'the disclosed one-check delay, and no later');
    assert.notEqual(result.verificationStatus, 'scanned');
    assert.notEqual(state.receipt?.status, 'scanned');
    assert.equal(state.leases, 0);
  });

  withProbe('external config replacement with identical content between checks is harmless', {}, async probe => {
    const added = await addPsdProject(probe, { links: 10 });
    await settleBaseline(added.project.id);
    await exclude(added.project.id, added.psdPath);
    const result = await restore(probe, added.project.id, added.psdPath, { before: () => {
      probe.afterCheck = index => { if (index % 20 === 0) storeInstance.data.projects = JSON.parse(JSON.stringify(storeInstance.data.projects)); };
    } });
    assert.equal(result.verificationStatus, 'scanned', JSON.stringify(result).slice(0, 300));
    assert.equal(outcome(added.project.id, added.psdPath).receipt.refs.length, 10);
  });

  // ------------------------------------------------- await and publication
  for (const change of ['independent-row', 'pause']) {
    withProbe(`publication rereads fresh state after the last check (${change})`, {}, async probe => {
      const added = await addPsdProject(probe, { links: 10 });
      await settleBaseline(added.project.id);
      await exclude(added.project.id, added.psdPath);
      const row = path.join(desk(), 'Written_Before_Publication.png');
      fs.writeFileSync(row, 'independent row');
      let held = false;
      const release = metadataTestHooks.pauseWorkingPsdPublicationSource(async () => {
        held = true;
        if (change === 'pause') await callIpcRaw('projects:pause', added.project.id);
        else {
          const projects = storeInstance.data.projects;
          projects.find(item => item.id === added.project.id).files.push({ path: row, name: path.basename(row), ext: '.png',
            addedAt: 1, source: 'manual', assetOrigin: 'existing', projectRole: 'asset' });
          storeInstance.set('projects', projects);
        }
      });
      let result;
      try { result = await restore(probe, added.project.id, added.psdPath); }
      finally { release(); }
      const state = outcome(added.project.id, added.psdPath);
      console.log('PSD_CHECK_READ_PUBLICATION ' + JSON.stringify({ change, held, result: result.verificationStatus || result.error, receipt: state.receipt,
        row: state.files.includes('Written_Before_Publication.png') }));
      assert.equal(held, true, 'publication paused after the final worker check');
      // Publication revalidates against the store after its awaits: either change
      // made after the last worker check refuses this scan (as on b1ed6fb), and
      // the independent row is kept rather than overwritten.
      assert.notEqual(result.verificationStatus, 'scanned');
      assert.notEqual(state.receipt.status, 'scanned');
      if (change !== 'pause') assert.equal(state.files.includes('Written_Before_Publication.png'), true);
      assert.equal(state.leases, 0);
    });
  }

  // ---------------------------------------------------- read object contract
  withProbe('check read contract: closed, foreign and look-alike reads are ignored', {}, async probe => {
    const api = metadataTestHooks.projectCheckRead;
    assert.ok(api, 'per-check project read is available');
    const added = await addPsdProject(probe, { links: 1 });
    const projectId = added.project.id;
    const read = api.open(projectId);
    assert.equal(read.project.id, projectId);
    assert.equal(Object.isFrozen(read), true);
    const operation = api.captureProjectOperation(projectId);
    probe.reset(); probe.armed = true;
    assert.equal(api.isActiveWatchingProject(projectId, null, read), true);
    assert.equal(operation.current(read), true);
    assert.equal(probe.gets, 0, 'an open read for this project is shared');
    // A write after the read: open reads see the read; the next read sees the write.
    stored(projectId).status = 'paused';
    assert.equal(operation.current(read), true);
    read.close();
    assert.equal(read.project, undefined);
    assert.equal(operation.current(read), false, 'a closed read falls back to a fresh read');
    assert.equal(probe.gets, 1);
    stored(projectId).status = 'watching';
    const other = await createProject('Foreign read');
    const foreign = api.open(other.id);
    const lookAlike = { projectId, open: true, project: { id: projectId, status: 'paused' }, soleWatchingProjectId: null };
    probe.reset(); probe.armed = true;
    assert.equal(operation.current(foreign), operation.current());
    assert.equal(operation.current(lookAlike), operation.current());
    assert.equal(api.isActiveWatchingProject(projectId, null, lookAlike), api.isActiveWatchingProject(projectId));
    assert.equal(probe.gets, 6, 'foreign and look-alike reads are never trusted');
    foreign.close();
    // A read whose acquisition ran a normalizer write-back is not shared.
    stored(projectId).files[0].currentSessionFilesystemEvidence = { planted: true };
    probe.reset(); probe.armed = true;
    assert.equal(api.open(projectId), null);
    assert.equal(probe.sets, 1);
  });
}
