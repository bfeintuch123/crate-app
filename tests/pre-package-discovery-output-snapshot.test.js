'use strict';
// Complete source IPC harness; native metadata/Electron are doubles. The store
// adapter returns detached JSON data. No claim of native or real-Conf timing.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const assert = require('node:assert/strict');
const root = process.env.CRATE_DISCOVERY_SOURCE_ROOT || path.resolve(__dirname, '..');
const entry = path.join(root, 'tests/provenance-dual-write.test.js');
let source = fs.readFileSync(entry, 'utf8');
function once(text, before, after) {
  assert.equal(text.split(before).length - 1, 1, `adapter drift: ${before}`);
  return text.replace(before, after);
}
source = once(source, "const test = require('node:test');", "const discoveryTest = require('node:test'); const test = new Proxy(discoveryTest, { apply() {} });");
source = once(source, "  let source = fs.readFileSync(filename, 'utf8');", "  let source = global.__discoveryInstrument(fs.readFileSync(filename, 'utf8'));");
source = once(source, '  captureProjectOperation,\n  runScanOnOpen',
  '  observeDiscoveryStage(callback) { const prior = stageLiveObservedFile; stageLiveObservedFile = (...args) => { const result = prior(...args); callback(args, result); return result; }; return () => { stageLiveObservedFile = prior; }; },\n  captureProjectOperation,\n  runScanOnOpen');
global.__discoveryInstrument = text => {
  const retirementMutant = process.env.CRATE_DISCOVERY_RETIREMENT_MUTANT;
  if (retirementMutant) {
    const start = text.indexOf('  const collectLastUsedCandidates = async (folder, depth) => {');
    const end = text.indexOf('\n  for (const dir of scanDirs)', start);
    assert.ok(start >= 0 && end > start, 'retirement mutant scope drift');
    const anchors = {
      readdir: ["    if (!operationCurrent()) return;\n    entries.sort", '    entries.sort'],
      child: ["        await collectLastUsedCandidates(fullPath, depth + 1);\n        if (!operationCurrent()) return;", '        await collectLastUsedCandidates(fullPath, depth + 1);'],
      yield: ["        await new Promise(resolve => setImmediate(resolve));\n        if (!operationCurrent()) return;", '        await new Promise(resolve => setImmediate(resolve));'],
    };
    assert.ok(Object.hasOwn(anchors, retirementMutant), 'unknown retirement mutant');
    const [before, after] = anchors[retirementMutant];
    const mutated = once(text.slice(start, end), before, after);
    text = text.slice(0, start) + mutated + text.slice(end);
  }
  if (process.env.CRATE_DISCOVERY_NAIVE_CONTROL === '1') {
    const resets = /^ {8}outputPaths = null;\n/gm;
    assert.equal([...text.matchAll(resets)].length, 2, 'naive-cache control anchor drift');
    text = text.replace(resets, '');
  }
  text = once(text, '  const lastUsedCandidates = [];', "  global.__discoveryMark('traversal');\n  const lastUsedCandidates = [];");
  return once(text, '  const recentLastUsedCandidates = new Array(lastUsedCandidates.length).fill(false);', "  global.__discoveryMark('metadata', scanMetrics, lastUsedCandidates.map(candidate => candidate.fullPath));\n  const recentLastUsedCandidates = new Array(lastUsedCandidates.length).fill(false);");
};
const compiled = new Module(entry, module);
compiled.filename = entry; compiled.paths = Module._nodeModulePaths(path.dirname(entry));
compiled._compile(source + '\n(' + cases.toString() + ')();', entry);

function cases() {
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  async function fixture(count = 735, withChild = false, acceptedAnchor = false) {
    resetTestHomeWorkspace();
    storeInstance.set('quickPackageOutputPaths', []);
    setChildProcessHandler(() => ({ stdout: '' }));
    const p = await createProject('Discovery output snapshot');
    await callIpcRaw('projects:pause', p.id); clearTrackedTimers();
    const folder = path.join(TEST_HOME, 'Desktop', 'Discovery');
    fs.mkdirSync(folder);
    for (let i = 0; i < count; i++) fs.writeFileSync(path.join(folder, `image-${String(i).padStart(4, '0')}.png`), 'synthetic');
    let child;
    if (withChild) {
      fs.writeFileSync(path.join(folder, '000-before.png'), 'synthetic');
      child = path.join(folder, 'a-child'); fs.mkdirSync(child);
      fs.writeFileSync(path.join(child, 'child.png'), 'synthetic');
    }
    if (acceptedAnchor) {
      const anchor = path.join(folder, 'Anchor.ai'); writeSyntheticAiFile(anchor);
      await setProjectFiles(p.id, { files: [{ path: anchor, name: 'Anchor.ai', ext: '.ai', source: 'manual-browse' }] });
      await getProject(p.id); // Establish ordinary normalized state before parity assertions.
    }
    const originalGet = storeInstance.get, originalSet = storeInstance.set;
    let stage = 'before', record, candidatePaths, projectReads = 0, outputReads = 0, delayMs = 0;
    global.__discoveryMark = (next, metrics, paths) => {
      if (next === 'metadata') { record = { projectReads, outputReads, ...metrics }; candidatePaths = paths; }
      stage = next;
    };
    storeInstance.get = function(key, ...args) {
      if (stage === 'traversal') {
        if (key === 'projects') projectReads++;
        if (key === 'quickPackageOutputPaths') outputReads++;
        if ((key === 'projects' || key === 'quickPackageOutputPaths') && delayMs) {
          const end = performance.now() + delayMs;
          while (performance.now() < end) {} // Controlled synchronous store-cost sensitivity.
        }
      }
      return clone(originalGet.call(this, key, ...args));
    };
    storeInstance.set = function(key, value) { return originalSet.call(this, key, clone(value)); };
    const stored = storeInstance.get('projects').find(project => project.id === p.id);
    const watchStart = stored.watchStartedAt || stored.createdAt;
    const stale = encodeLastUsedXattr(watchStart - 1000), fresh = encodeLastUsedXattr(watchStart + 1000);
    const recent = new Set();
    setChildProcessHandler(request => {
      const paths = bulkXattrPaths(request);
      if (paths.length) return { stdout: formatBulkXattrOutput(paths, file => recent.has(file) ? fresh : stale) };
      return { stdout: Buffer.alloc(0) };
    });
    return { p, folder, child,
      traversing() { return stage === 'traversal'; },
      candidatePaths() { return candidatePaths; },
      files: Array.from({ length: count }, (_, i) => path.join(folder, `image-${String(i).padStart(4, '0')}.png`)),
      setRecent(files) { recent.clear(); for (const file of files) recent.add(file); },
      setCost(value) { delayMs = value; },
      receipt() { return record || { projectReads, outputReads, stoppedBeforeMetadata: true }; },
      async cleanup() {
        storeInstance.get = originalGet; storeInstance.set = originalSet;
        delete global.__discoveryMark; setChildProcessHandler(null); clearTrackedTimers();
      } };
  }
  discoveryTest('735 unrelated home candidates do not reread output policy per file', { timeout: 15000 }, async () => {
    const f = await fixture();
    try {
      const result = await callIpcRaw('projects:pre-package-scan', f.p.id);
      const r = f.receipt(); console.log('DISCOVERY_READS ' + JSON.stringify(r));
      assert.equal(result.error, undefined); assert.equal(r.candidateCount, 735);
      assert.ok(r.outputReads < 20, 'output policy reads must be bounded by synchronous segments, not candidate count');
      assert.ok(r.projectReads < 100, 'project normalization reads must not scale once per candidate');
    } finally { await f.cleanup(); }
  });
  for (const outputKind of ['quick', 'project']) discoveryTest(`traversal cache refreshes ${outputKind} output exclusions after candidate yield`, async () => {
    const f = await fixture(); const immediate = global.setImmediate; let changed = false;
    global.setImmediate = (callback, ...args) => immediate(() => {
      if (!changed && f.traversing()) {
        changed = true;
        if (outputKind === 'quick') storeInstance.set('quickPackageOutputPaths', [f.folder]);
        else { const rows = storeInstance.get('projects'); rows.find(p => p.id === f.p.id).outputPath = f.folder; storeInstance.set('projects', rows); }
      }
      callback(...args);
    });
    try {
      const result = await callIpcRaw('projects:pre-package-scan', f.p.id);
      assert.equal(changed, true); assert.equal(result.error, undefined);
      assert.equal(f.receipt().candidateCount, 256, 'remaining output contents must be excluded after the yield');
      const current = storeInstance.get('projects').find(p => p.id === f.p.id);
      assert.equal(current.pendingFiles.length, 0);
    } finally { global.setImmediate = immediate; await f.cleanup(); }
  });
  discoveryTest('traversal cache refreshes exclusions after nested directory awaits', async () => {
    const f = await fixture(3, true); const readdir = fs.promises.readdir; let changed = false;
    fs.promises.readdir = async function(folder, ...args) {
      const value = await readdir.call(this, folder, ...args);
      if (folder === f.child) { changed = true; storeInstance.set('quickPackageOutputPaths', [f.folder]); }
      return value;
    };
    try {
      const result = await callIpcRaw('projects:pre-package-scan', f.p.id);
      assert.equal(changed, true); assert.equal(result.error, undefined);
      assert.equal(f.receipt().candidateCount, 1, 'the pre-await candidate remains counted; later siblings must use the refreshed policy');
    } finally { fs.promises.readdir = readdir; await f.cleanup(); }
  });
  for (const mode of ['status', 'account']) discoveryTest(`traversal yield retains live ${mode} retirement`, async () => {
    const f = await fixture(); const immediate = global.setImmediate, realpath = fs.realpathSync.native;
    let changed = false, postRetirementReads = 0;
    fs.realpathSync.native = (file, ...args) => {
      if (changed && typeof file === 'string' && file.startsWith(f.folder + path.sep) && file.endsWith('.png')) postRetirementReads++;
      return realpath(file, ...args);
    };
    global.setImmediate = (callback, ...args) => immediate(() => {
      if (!changed && f.traversing()) {
        changed = true;
        if (mode === 'account') testAccountSession.invalidate();
        else { const rows = storeInstance.get('projects'); rows.find(p => p.id === f.p.id).status = 'archived'; storeInstance.set('projects', rows); }
      }
      callback(...args);
    });
    try {
      const pending = callIpcRaw('projects:pre-package-scan', f.p.id);
      if (mode === 'account') {
        const outcome = await pending.then(result => ({ result }), error => ({ error: error.message }));
        console.log('RETIRE_PROBE ' + JSON.stringify({ mode, changed, outcome, counts: f.receipt() }));
        assert.match(outcome.error || '', /Sign in to Crate/);
      } else {
        const result = await pending;
        console.log('RETIRE_PROBE ' + JSON.stringify({ mode, changed, result, status: storeInstance.get('projects').find(p => p.id === f.p.id).status, counts: f.receipt() }));
        assert.equal(result, null);
      }
      assert.equal(changed, true);
      assert.equal(postRetirementReads, 0, 'retirement must stop further traversal filesystem work, not only final publication');
      assert.equal(storeInstance.get('projects').find(p => p.id === f.p.id).pendingFiles.length, 0);
    } finally { fs.realpathSync.native = realpath; global.setImmediate = immediate; await testAccountSession.restore(); await f.cleanup(); }
  });
  for (const count of [255, 256, 257, 512]) discoveryTest(`exact ${count} enumerated-candidate boundary preserves yield count and order`, async () => {
    const f = await fixture(count); const immediate = global.setImmediate; let yields = 0;
    global.setImmediate = (callback, ...args) => {
      if (f.traversing()) yields++;
      return immediate(callback, ...args);
    };
    try {
      const result = await callIpcRaw('projects:pre-package-scan', f.p.id);
      assert.equal(result.error, undefined);
      assert.equal(yields, Math.floor(count / 256));
      assert.equal(f.receipt().candidateCount, count);
      assert.deepEqual(f.candidatePaths(), Array.from({ length: count }, (_, i) => path.join(f.folder, `image-${String(i).padStart(4, '0')}.png`)));
    } finally { global.setImmediate = immediate; await f.cleanup(); }
  });
  discoveryTest('long excluded run introduces no yield and leaves following candidate order exact', async () => {
    const f = await fixture(257); const immediate = global.setImmediate; let yields = 0;
    const excluded = path.join(f.folder, '000-excluded'); fs.mkdirSync(excluded);
    for (let i = 0; i < 735; i++) fs.writeFileSync(path.join(excluded, `excluded-${i}.png`), 'synthetic');
    storeInstance.set('quickPackageOutputPaths', [excluded]);
    global.setImmediate = (callback, ...args) => {
      if (f.traversing()) yields++;
      return immediate(callback, ...args);
    };
    try {
      const result = await callIpcRaw('projects:pre-package-scan', f.p.id);
      assert.equal(result.error, undefined); assert.equal(yields, 1);
      assert.equal(f.receipt().candidateCount, 257);
      assert.deepEqual(f.candidatePaths(), Array.from({ length: 257 }, (_, i) => path.join(f.folder, `image-${String(i).padStart(4, '0')}.png`)));
    } finally { global.setImmediate = immediate; await f.cleanup(); }
  });
  for (const mode of ['status', 'account']) discoveryTest(`nested traversal return retains live ${mode} retirement`, async () => {
    const f = await fixture(3, true); const readdir = fs.promises.readdir, realpath = fs.realpathSync.native;
    let changed = false, postRetirementReads = 0;
    fs.realpathSync.native = (file, ...args) => {
      if (changed && typeof file === 'string' && file.startsWith(f.folder + path.sep) && file.endsWith('.png')) postRetirementReads++;
      return realpath(file, ...args);
    };
    fs.promises.readdir = async function(folder, ...args) {
      const value = await readdir.call(this, folder, ...args);
      if (folder === f.child) {
        changed = true;
        if (mode === 'account') testAccountSession.invalidate();
        else { const rows = storeInstance.get('projects'); rows.find(p => p.id === f.p.id).status = 'archived'; storeInstance.set('projects', rows); }
      }
      return value;
    };
    try {
      if (mode === 'account') await assert.rejects(callIpcRaw('projects:pre-package-scan', f.p.id), /Sign in to Crate/);
      else assert.equal(await callIpcRaw('projects:pre-package-scan', f.p.id), null);
      assert.equal(changed, true); assert.equal(f.candidatePaths(), undefined);
      assert.equal(postRetirementReads, 0, 'both child and parent must stop traversal work immediately after retirement');
      assert.equal(storeInstance.get('projects').find(p => p.id === f.p.id).pendingFiles.length, 0);
    } finally { fs.realpathSync.native = realpath; fs.promises.readdir = readdir; await testAccountSession.restore(); await f.cleanup(); }
  });
  for (const count of [4, 70, 735]) discoveryTest(`positive recent staging admits all ${count} weak candidates exactly once`, { timeout: 15000 }, async () => {
    const f = await fixture(count, false, true); f.setRecent(f.files);
    const before = clone(storeInstance.get('projects').find(p => p.id === f.p.id));
    const staged = []; const restore = metadataTestHooks.observeDiscoveryStage((args, result) => staged.push({ path: args[1].path, changed: result?.changed, decision: result?.decision }));
    try {
      const result = await callIpcRaw('projects:pre-package-scan', f.p.id);
      const current = storeInstance.get('projects').find(p => p.id === f.p.id);
      assert.equal(result.error, undefined); assert.equal(result.newCount, count);
      assert.equal(staged.length, count); assert.equal(staged.filter(row => row.changed).length, count);
      assert.deepEqual(staged.map(row => row.path), f.files);
      assert.deepEqual(current.pendingFiles.map(row => row.path), f.files);
      assert.equal(new Set(current.pendingFiles.map(row => row.path)).size, count);
      assert.deepEqual(current.files, before.files, 'weak metadata discovery must not promote candidates to accepted files');
      assert.deepEqual(result.files, before.files);
      console.log('POSITIVE_STAGING ' + JSON.stringify({ count, staged: staged.length, pending: current.pendingFiles.length, acceptedUnchanged: true }));
    } finally { restore(); await f.cleanup(); }
  });
  discoveryTest('positive mixed staging admits only recent evidence and excludes known output contents', async () => {
    const f = await fixture(70, false, true); const expected = f.files.filter((_, i) => i % 3 === 0);
    f.setRecent(expected);
    const output = path.join(f.folder, '000-output'); fs.mkdirSync(output);
    const excluded = path.join(output, 'must-not-stage.png'); fs.writeFileSync(excluded, 'synthetic');
    storeInstance.set('quickPackageOutputPaths', [output]);
    const restore = metadataTestHooks.observeDiscoveryStage(args => assert.ok(!args[1].path.startsWith(output + path.sep)));
    try {
      const result = await callIpcRaw('projects:pre-package-scan', f.p.id);
      const current = storeInstance.get('projects').find(p => p.id === f.p.id);
      assert.equal(result.error, undefined); assert.equal(result.newCount, expected.length);
      assert.deepEqual(current.pendingFiles.map(row => row.path), expected);
      assert.deepEqual(current.files.map(row => row.name), ['Anchor.ai']);
      assert.equal(f.receipt().candidateCount, 70);
    } finally { restore(); await f.cleanup(); }
  });
  discoveryTest('positive staging revalidates outputs changed after a staged prefix', async () => {
    const f = await fixture(70, false, true); f.setRecent(f.files);
    const immediate = global.setImmediate; let stages = 0, changed = false;
    const restore = metadataTestHooks.observeDiscoveryStage(() => { stages++; });
    global.setImmediate = (callback, ...args) => immediate(() => {
      if (!changed && stages > 0) { changed = true; storeInstance.set('quickPackageOutputPaths', [f.folder]); }
      callback(...args);
    });
    try {
      const result = await callIpcRaw('projects:pre-package-scan', f.p.id);
      assert.equal(changed, true); assert.ok(stages > 0); assert.equal(result.error, undefined);
      const current = storeInstance.get('projects').find(p => p.id === f.p.id);
      assert.equal(current.pendingFiles.length, 0, 'fresh downstream policy must remove a now-excluded staged prefix');
      assert.deepEqual(current.files.map(row => row.name), ['Anchor.ai']);
    } finally { global.setImmediate = immediate; restore(); await f.cleanup(); }
  });
  for (const mode of ['status', 'account']) discoveryTest(`positive staged prefix never publishes after ${mode} retirement`, async () => {
    const f = await fixture(70, false, true); f.setRecent(f.files);
    const before = clone(storeInstance.get('projects').find(p => p.id === f.p.id));
    const immediate = global.setImmediate; let stages = 0, changed = false;
    const restore = metadataTestHooks.observeDiscoveryStage(() => { stages++; });
    global.setImmediate = (callback, ...args) => immediate(() => {
      if (!changed && stages > 0) {
        changed = true;
        if (mode === 'account') testAccountSession.invalidate();
        else { const rows = storeInstance.get('projects'); rows.find(p => p.id === f.p.id).status = 'archived'; storeInstance.set('projects', rows); }
      }
      callback(...args);
    });
    try {
      if (mode === 'account') await assert.rejects(callIpcRaw('projects:pre-package-scan', f.p.id), /Sign in to Crate/);
      else assert.equal(await callIpcRaw('projects:pre-package-scan', f.p.id), null);
      assert.equal(changed, true); assert.ok(stages > 0 && stages <= 32);
      if (mode === 'status') before.status = 'archived';
      assert.deepEqual(storeInstance.get('projects').find(p => p.id === f.p.id), before, 'detached staged prefix cannot alter persisted state after retirement');
    } finally { global.setImmediate = immediate; restore(); await testAccountSession.restore(); await f.cleanup(); }
  });
  if (process.env.CRATE_DISCOVERY_COST_CONTROL === '1') discoveryTest('controlled store cost preserves the original eight-second discovery deadline', { timeout: 20000 }, async () => {
    const f = await fixture(); f.setCost(6);
    try {
      const started = performance.now(); const result = await callIpcRaw('projects:pre-package-scan', f.p.id);
      console.log('DISCOVERY_COST ' + JSON.stringify({ elapsedMs: Math.round(performance.now() - started), ...f.receipt(), error: result?.error || null }));
      assert.equal(result.error, undefined, 'a repeated-read amplification must not exhaust the unchanged deadline');
    } finally { await f.cleanup(); }
  });
}
