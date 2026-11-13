'use strict';
// Broad pre-package discovery against the complete production handler, actual
// Conf 10 store reads and generated synthetic files only. OS metadata, ps and
// lsof are modeled. The production 8 s discovery deadline is never changed.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), assert = require('./bounded-assert');
const root = process.env.CRATE_DIAGNOSTIC_SOURCE_ROOT || path.resolve(__dirname, '..');
assert.ok(root && path.isAbsolute(root));
const entry = path.join(root, 'tests/provenance-dual-write.test.js');
let source = fs.readFileSync(entry, 'utf8');
function replaceOnce(before, after) { assert.equal(source.split(before).length, 2, 'adapter drift'); source = source.replace(before, () => after); }
replaceOnce("const test = require('node:test');", "const budgetTest = require('node:test'); const test = new Proxy(budgetTest, { apply() {} });");
replaceOnce("fs.mkdtempSync(path.join(os.tmpdir(), 'crate-provenance-dual-write-home-'))", "fs.mkdtempSync(path.join(os.tmpdir(), 'crate-collection-budget-home-'))");
// Let modeled ps/lsof responses settle later, like a slow process query.
replaceOnce("execStub[nodePromisify.custom] = async (command) => {\n  const result = getChildProcessResult('exec', command, []);", "execStub[nodePromisify.custom] = async (command) => {\n  const result = await Promise.resolve(getChildProcessResult('exec', command, []));");
replaceOnce('  captureProjectOperation,\n  runScanOnOpen', '  isPackageScanInFlight(id) { return scanInFlight.has(id); },\n  captureProjectOperation,\n  runScanOnOpen');
source += '\n(' + cases.toString() + ')();\n';
const compiled = new Module(entry, module); compiled.filename = entry; compiled.paths = Module._nodeModulePaths(path.dirname(entry)); compiled._compile(source, entry);

function cases() {
  const DAY = 86400000;
  const sleep = ms => new Promise(resolve => originalSetTimeout(resolve, ms));
  const realReaddir = fs.promises.readdir;
  const createdHomes = [];
  budgetTest.after(() => { fs.promises.readdir = realReaddir; for (const home of createdHomes) fs.rmSync(home, { recursive: true, force: true }); });

  // A synthetic Illustrator-style project: one accepted .ai source and 50
  // accepted links, `recent` session files beside it, and a broad tree of
  // `candidates` older design files spread over `dirs` directories.
  async function fixture({ dirs = 12, candidates = 40, recent = 4, padBytes = 0, figma = false } = {}) {
    resetTestHomeWorkspace(); storeInstance.set('quickPackageOutputPaths', []); setChildProcessHandler(() => ({ stdout: '' }));
    const p = await createProject('Collection budget'); await callIpcRaw('projects:pause', p.id); clearTrackedTimers();
    const projectDir = path.join(TEST_HOME, 'Desktop', 'Synthetic Project');
    fs.mkdirSync(path.join(projectDir, 'Links'), { recursive: true });
    const anchor = path.join(projectDir, 'Synthetic.ai'); writeSyntheticAiFile(anchor);
    const files = [{ path: anchor, ext: '.ai', name: 'Synthetic.ai', source: 'manual-browse' }];
    for (let i = 0; i < 50; i++) {
      const link = path.join(projectDir, 'Links', `link-${String(i).padStart(3, '0')}.png`);
      fs.writeFileSync(link, 'synthetic link'); files.push({ path: link, ext: '.png', name: path.basename(link), source: 'manual-browse' });
    }
    await setProjectFiles(p.id, { files });
    const recentFiles = [];
    for (let i = 0; i < recent; i++) { const file = path.join(projectDir, `Recent-${String(i).padStart(3, '0')}.png`); fs.writeFileSync(file, 'synthetic recent'); recentFiles.push(file); }
    const roots = ['Desktop', 'Documents', 'Downloads'].map(name => path.join(TEST_HOME, name));
    const leaves = [];
    for (let i = 0; i < dirs; i++) {
      const leaf = path.join(roots[i % 3], `area-${Math.floor(i / 3) % 12}`, `group-${Math.floor(i / 36)}`, `leaf-${i}`);
      fs.mkdirSync(leaf, { recursive: true }); leaves.push(leaf);
    }
    const old = (Date.now() - 30 * DAY) / 1000;
    const exts = ['.png', '.jpg', '.svg', '.psd', '.ttf', '.ai', '.gif', '.tif'];
    for (let i = 0; i < candidates; i++) {
      const leaf = leaves[i % leaves.length];
      const file = path.join(leaf, `asset-${String(i).padStart(5, '0')}${exts[i % exts.length]}`);
      fs.writeFileSync(file, 'synthetic'); fs.utimesSync(file, old, old);
      fs.writeFileSync(path.join(leaf, `notes-${i}.txt`), 'non-design noise');
    }
    // Actual Conf: every get reads and parses the complete store file.
    const initial = JSON.parse(JSON.stringify(storeInstance.data));
    if (padBytes > 0) {
      const neighbor = { id: '00000000-0000-4000-8000-00000000fff1', name: 'Synthetic archived neighbor', type: 'branding', status: 'archived', createdAt: Date.now() - 400 * DAY, files: [], pendingFiles: [], excludedAssetKeys: [] };
      for (let i = 0, bytes = 0; bytes < padBytes; i++) {
        const file = { path: path.join(TEST_HOME, 'Archive', `old-${i}.png`), name: `old-${i}.png`, ext: '.png', source: 'manual-browse', addedAt: Date.now() - 400 * DAY + i };
        neighbor.files.push(file); bytes += JSON.stringify(file).length + 1;
      }
      initial.projects.push(neighbor);
    }
    const Conf = originalLoad.call(Module, 'conf', module), cwd = fs.mkdtempSync(path.join(TEST_HOME, 'conf-budget-'));
    const backend = new Conf({ cwd, projectName: 'synthetic-collection-budget', watch: false }); backend.store = initial;
    const methods = { get: storeInstance.get, set: storeInstance.set, delete: storeInstance.delete };
    // Store reads are attributed to discovery phases: collection begins with
    // the first async directory listing and ends with the first metadata query.
    const counts = { phase: 'idle', reads: { idle: 0, collection: 0, metadata: 0 }, xattrRequests: 0, mdfindRequests: 0, lsofRequests: 0 };
    storeInstance.get = (...args) => { counts.reads[counts.phase] = (counts.reads[counts.phase] || 0) + 1; return backend.get(...args); };
    storeInstance.set = backend.set.bind(backend); storeInstance.delete = backend.delete.bind(backend);
    const holds = [];
    fs.promises.readdir = async function (folder, ...args) {
      if (counts.phase === 'idle' && String(folder).startsWith(TEST_HOME + path.sep)) counts.phase = 'collection';
      const hold = holds.find(item => !item.used && item.match(String(folder)));
      if (hold) { hold.used = true; hold.reached(); await hold.gate; }
      return realReaddir.call(this, folder, ...args);
    };
    const recentSet = new Set(recentFiles);
    const latency = { ps: 0, lsof: 0, xattr: 0, mdfind: 0 };
    const respond = (ms, value) => ms ? new Promise(resolve => originalSetTimeout(() => resolve(value), ms)) : value;
    const lateFig = path.join(TEST_HOME, 'Desktop', 'Late Figma.fig');
    setChildProcessHandler(request => {
      if (request.kind === 'exec' && request.command.startsWith('/bin/ps ')) return respond(latency.ps, { stdout: figma ? '  4242 /Applications/Figma.app/Contents/MacOS/Figma\n' : '  1 /sbin/launchd\n' });
      if (request.kind === 'exec' && request.command.startsWith('/usr/sbin/lsof ')) { counts.lsofRequests++; return respond(latency.lsof, { stdout: `p4242\nn${lateFig}\n` }); }
      const paths = bulkXattrPaths(request);
      if (paths.length) {
        counts.phase = 'metadata'; counts.xattrRequests++;
        return respond(latency.xattr, { stdout: formatBulkXattrOutput(paths, file => encodeLastUsedXattr(recentSet.has(file) ? Date.now() : Date.now() - 30 * DAY)) });
      }
      if (request.kind === 'execFile' && request.command === '/usr/bin/mdfind') { counts.phase = 'metadata'; counts.mdfindRequests++; return respond(latency.mdfind, { stdout: Buffer.alloc(0) }); }
      return { stdout: '' };
    });
    // One normalizing read so later snapshots compare against the stable view.
    await getProject(p.id); counts.reads.idle = 0;
    return {
      p, projectDir, recentFiles, markRecent(file) { recentFiles.push(file); recentSet.add(file); }, backend, counts, latency, lateFig, storeBytes: fs.statSync(backend.path).size,
      stored() { return backend.get('projects').find(project => project.id === p.id); },
      hold(match) { let reached, release; const reachedPromise = new Promise(resolve => { reached = resolve; }); const gate = new Promise(resolve => { release = resolve; }); holds.push({ match, reached, gate, used: false }); return { reached: reachedPromise, release }; },
      restore() { fs.promises.readdir = realReaddir; storeInstance.data = JSON.parse(JSON.stringify(backend.store)); Object.assign(storeInstance, methods); clearTrackedTimers(); },
    };
  }
  async function waitForSettlement(f) {
    for (let i = 0; i < 400 && metadataTestHooks.isPackageScanInFlight(f.p.id); i++) await sleep(25);
    assert.equal(metadataTestHooks.isPackageScanInFlight(f.p.id), false, 'retired discovery work must settle');
  }
  const pendingPaths = project => (project.pendingFiles || []).map(file => file.path).sort();
  function assertUnchanged(actual, expected, message) {
    const changed = [...new Set([...Object.keys(actual || {}), ...Object.keys(expected || {})])]
      .filter(key => JSON.stringify(actual?.[key]) !== JSON.stringify(expected?.[key]));
    assert.deepEqual(changed, [], `${message}; changed project keys: ${changed.join(', ')}`);
  }

  budgetTest('representative 1,327-candidate discovery with a 2.6 MB actual Conf store finishes inside the unchanged 8 s deadline', { timeout: 30000 }, async () => {
    const f = await fixture({ dirs: 600, candidates: 1327, recent: 20, padBytes: 1_700_000 });
    try {
      const acceptedBefore = JSON.stringify(f.stored().files);
      const started = Date.now();
      const result = await callIpcRaw('projects:pre-package-scan', f.p.id);
      const elapsedMs = Date.now() - started;
      console.log('COLLECTION_BUDGET ' + JSON.stringify({ storeBytes: f.storeBytes, directories: 600, candidates: 1327, elapsedMs, storeReads: f.counts.reads, result: result && (result.error || 'ok') }));
      assert.equal(result.error, undefined, `discovery must not be refused as incomplete (${JSON.stringify(result.diagnostics || null)})`);
      assert.equal(result.newCount, 20);
      assert.deepEqual(pendingPaths(f.stored()), [...f.recentFiles].sort(), 'every recent session file is still admitted for review');
      assert.equal(JSON.stringify(f.stored().files), acceptedBefore, 'accepted sources are unchanged');
      // Base reread the complete store about three times per directory (1,729 reads here).
      assert.ok(f.counts.reads.collection <= 600 / 8, `broad collection must not re-read the complete store per directory (read ${f.counts.reads.collection} times)`);
    } finally { f.restore(); }
  });

  budgetTest('collection store reads do not grow with directory count', { timeout: 30000 }, async () => {
    const reads = [];
    for (const dirs of [24, 480]) {
      const f = await fixture({ dirs, candidates: 480, recent: 2 });
      try {
        const result = await callIpcRaw('projects:pre-package-scan', f.p.id);
        assert.equal(result.error, undefined); assert.equal(result.newCount, 2);
        reads.push(f.counts.reads.collection);
      } finally { f.restore(); }
    }
    assert.ok(reads[1] - reads[0] <= 456 / 16, `456 more directories added ${reads[1] - reads[0]} complete store reads`);
  });

  budgetTest('empty broad roots without Figma succeed and admit nothing', async () => {
    const f = await fixture({ dirs: 0, candidates: 0, recent: 0 });
    try {
      const acceptedBefore = f.stored().files.map(file => file.path);
      const result = await callIpcRaw('projects:pre-package-scan', f.p.id);
      assert.equal(result.error, undefined); assert.equal(result.newCount, 0);
      assert.equal(f.counts.lsofRequests, 0, 'no Figma process means no lsof query');
      assert.deepEqual(pendingPaths(f.stored()), []);
      assert.deepEqual(f.stored().files.map(file => file.path), acceptedBefore);
    } finally { f.restore(); }
  });

  budgetTest('generated output registered during directory reads is excluded before metadata or staging', { timeout: 20000 }, async () => {
    const f = await fixture({ dirs: 12, candidates: 40, recent: 0 });
    try {
      const outputDir = path.join(TEST_HOME, 'Documents', 'Fresh Output');
      fs.mkdirSync(outputDir);
      const outputFile = path.join(outputDir, 'Generated.png'); fs.writeFileSync(outputFile, 'generated');
      const datedFile = path.join(TEST_HOME, 'Documents', 'Synthetic_2026-11-01', 'Dated.png');
      fs.mkdirSync(path.dirname(datedFile)); fs.writeFileSync(datedFile, 'generated');
      const kept = path.join(f.projectDir, 'Kept.svg'); fs.writeFileSync(kept, '<svg/>');
      const otherApp = path.join(TEST_HOME, 'Downloads', 'Imported.fig'); fs.writeFileSync(otherApp, 'figma local file');
      for (const file of [outputFile, datedFile, kept]) f.markRecent(file);
      const held = f.hold(folder => folder === path.join(TEST_HOME, 'Downloads'));
      const scan = callIpcRaw('projects:pre-package-scan', f.p.id);
      await held.reached;
      // The output folder was already walked; a later output registration must
      // still exclude it before metadata or staging can see it.
      f.backend.set('quickPackageOutputPaths', [outputDir]);
      held.release();
      const result = await scan;
      assert.equal(result.error, undefined);
      const pending = pendingPaths(f.stored());
      assert.equal(pending.includes(outputFile), false, 'newly registered output stays excluded');
      assert.equal(pending.includes(datedFile), false, 'dated package folders stay excluded');
      assert.ok(pending.includes(kept), 'recent session file beside the project is still admitted');
      assert.ok(pending.includes(otherApp), 'a local Figma file saved this session is still discovered');
      assert.equal(f.stored().files.length, 51);
      assert.ok(f.counts.xattrRequests > 0);
    } finally { f.restore(); }
  });

  for (const mode of ['project-status', 'account']) budgetTest(`ownership change during collection stops before metadata or staging (${mode})`, { timeout: 20000 }, async () => {
    const f = await fixture({ dirs: 300, candidates: 600, recent: 6 });
    try {
      const before = JSON.stringify(f.stored());
      const held = f.hold(folder => folder.endsWith(`${path.sep}leaf-7`));
      const scan = callIpcRaw('projects:pre-package-scan', f.p.id);
      await held.reached;
      if (mode === 'account') testAccountSession.invalidate();
      else { const projects = f.backend.get('projects'); projects.find(p => p.id === f.p.id).status = 'archived'; f.backend.set('projects', projects); }
      held.release();
      if (mode === 'account') await assert.rejects(scan, { message: 'Sign in to Crate to use your workspace.' });
      else assert.equal(await scan, null);
      await waitForSettlement(f);
      assert.equal(f.counts.xattrRequests, 0, 'superseded collection must not launch metadata queries');
      assert.equal(f.counts.mdfindRequests, 0);
      const expected = JSON.parse(before); if (mode === 'project-status') expected.status = 'archived';
      assertUnchanged(f.stored(), expected, 'superseded discovery stages nothing');
    } finally { await testAccountSession.restore(); f.restore(); }
  });

  // Each slow phase below is a controlled failure injection, not a native reproduction.
  for (const phase of ['figma-process', 'collection', 'metadata']) budgetTest(`slow ${phase} is refused at the actual 8 s deadline and its late completion stages nothing`, { timeout: 30000 }, async () => {
    const f = await fixture({ dirs: 12, candidates: 40, recent: 4, figma: phase === 'figma-process' });
    let held = null;
    try {
      fs.writeFileSync(f.lateFig, 'late figma file');
      const before = JSON.stringify(f.stored());
      if (phase === 'figma-process') f.latency.lsof = 9000;
      else if (phase === 'metadata') f.latency.mdfind = 9000;
      else held = f.hold(folder => folder.endsWith(`${path.sep}leaf-5`));
      const started = Date.now();
      const result = await callIpcRaw('projects:pre-package-scan', f.p.id);
      const elapsed = Date.now() - started;
      assert.equal(result.error, 'package_scan_incomplete');
      assert.equal(result.diagnostics.failurePhase, 'pre-package-discovery');
      assert.ok(elapsed >= 7900 && elapsed < 12000, `refused at ${elapsed} ms`);
      assertUnchanged(f.stored(), JSON.parse(before), 'refusal persists no discovery result');
      assert.equal(metadataTestHooks.isPackageScanInFlight(f.p.id), true, 'timed-out work keeps ownership until it settles');
      const overlap = await callIpcRaw('projects:pre-package-scan', f.p.id);
      assert.equal(overlap.diagnostics.failurePhase, 'pre-package-scan-in-flight');
      if (held) held.release();
      await waitForSettlement(f);
      assertUnchanged(f.stored(), JSON.parse(before), 'late completion cannot stage files');
      assert.equal((await callIpcRaw('projects:prepare-package-review', f.p.id)).error, 'package_scan_incomplete', 'no package review after an incomplete scan');
      if (phase === 'collection') assert.equal(f.counts.xattrRequests, 0, 'expired collection must not start metadata queries');
    } finally { if (held) held.release(); await waitForSettlement(f).catch(() => {}); f.restore(); }
  });

  budgetTest('metadata query failure refuses promptly without staging', { timeout: 20000 }, async () => {
    const f = await fixture({ dirs: 12, candidates: 40, recent: 4 });
    try {
      const before = JSON.stringify(f.stored());
      setChildProcessHandler(request => bulkXattrPaths(request).length ? { error: Object.assign(new Error('synthetic xattr failure'), { code: 'ETIMEDOUT', killed: true, signal: 'SIGTERM' }) } : { stdout: '' });
      const started = Date.now();
      const result = await callIpcRaw('projects:pre-package-scan', f.p.id);
      assert.equal(result.error, 'package_scan_incomplete');
      assert.ok(Date.now() - started < 4000);
      assertUnchanged(f.stored(), JSON.parse(before), 'metadata failure stages nothing');
    } finally { f.restore(); }
  });
}
