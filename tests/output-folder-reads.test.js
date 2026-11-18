'use strict';
// How often the known package output folders are read, through the real routes
// with the real store shape. Every count is of store.get calls; nothing is timed.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), assert = require('./bounded-assert');
const entry = path.join(__dirname, 'provenance-dual-write.test.js');
let source = fs.readFileSync(entry, 'utf8');
function replaceOnce(before, after) { assert.equal(source.split(before).length, 2, `harness anchor drift: ${before.slice(0, 60)}`); source = source.replace(before, () => after); }
replaceOnce("const test = require('node:test');", "const routeTest = require('node:test'); const test = new Proxy(routeTest, { apply() {} });");
// Linked paths must start with /Users/, so the synthetic home sits in the real one.
replaceOnce("fs.mkdtempSync(path.join(os.tmpdir(), 'crate-provenance-dual-write-home-'))", "fs.mkdtempSync(path.join(originalHomedir(), 'crate-output-folder-home-'))");
replaceOnce('  captureProjectOperation,\n  runScanOnOpen', [
  '  mutateProjectForTest: mutateProject,',
  '  pruneRows: pruneExcludedAutoCapturedFiles,',
  '  isOutputPath: isAutoCaptureExcludedPath,',
  '  dedupeSourceMasters: deduplicatePackageSourceMastersForOutput,',
  '  dedupePriority: getPackageSourceMasterDedupePriority,',
  '  pollLastUsedCore: pollLastUsedForProjectCore,',
  '  markDesignAppRunning(projectId) { designAppRunningCache.set(projectId, true); },',
  '  watchStagedFiles(observe) { const stage = stageLiveObservedFile; stageLiveObservedFile = (project, file, ...rest) => { observe(file); return stage(project, file, ...rest); }; return () => { stageLiveObservedFile = stage; }; },',
  '  captureProjectOperation,',
  '  runScanOnOpen',
].join('\n'));
source += '\n(' + cases.toString() + ')();\n';
const compiled = new Module(entry, module); compiled.filename = entry; compiled.paths = Module._nodeModulePaths(path.dirname(entry)); compiled._compile(source, entry);

function cases() {
  routeTest.after(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));
  const hooks = metadataTestHooks;
  const desktop = (...parts) => path.join(TEST_HOME, 'Desktop', ...parts);
  const documentsFolder = (...parts) => path.join(TEST_HOME, 'Documents', ...parts);
  const stored = id => storeInstance.data.projects.find(item => item.id === id);
  const touch = (file, data = 'synthetic') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
  const rowFor = (file, extra = {}) => ({ path: file, name: path.basename(file), ext: path.extname(file), source: 'scan-on-open', addedAt: 1700000000000, ...extra });

  async function freshProject({ others = 3 } = {}) {
    resetTestHomeWorkspace(); await callIpcRaw('projects:delete-all'); clearTrackedTimers();
    storeInstance.set('quickPackageOutputPaths', []); setChildProcessHandler(() => ({ stdout: '' }));
    const project = await createProject('Output folder reads'); await callIpcRaw('projects:pause', project.id); clearTrackedTimers();
    for (let i = 0; i < others; i++) { const other = await createProject(`Neighbor ${i}`); await callIpcRaw('projects:pause', other.id); clearTrackedTimers(); }
    return { id: project.id, project: () => stored(project.id) };
  }
  async function projectWithRows(count, options) {
    const f = await freshProject(options), files = [];
    for (let i = 0; i < count; i++) files.push(rowFor(touch(desktop('Rows', `asset-${i}.png`)), { fileId: `row-${i}` }));
    await setProjectFiles(f.id, { files });
    return f;
  }
  async function countReads(run) {
    const realGet = storeInstance.get; let reads = 0;
    storeInstance.get = function (...args) { reads++; return realGet.apply(this, args); };
    try { await run(); } finally { storeInstance.get = realGet; }
    return reads;
  }
  const scan = async f => { const result = await callIpcRaw('projects:pre-package-scan', f.id); assert.equal(result?.error, undefined); };
  // The first scan of a process fills one-time caches; compare scans after it.
  // A scan's other reads vary by a few with scheduling. One read per item would
  // add at least the difference in items, so that is what these bounds exclude.
  const assertNotPerItem = (reads, counts) => {
    for (let i = 1; i < reads.length; i++) assert.ok(reads[i] - reads[0] < (counts[i] - counts[0]) / 4, `${reads} for ${counts}`);
  };
  const settleProcess = async () => scan(await freshProject());
  function modelTools({ figmaPaths = [], photoshopPaths = [], indesignPaths = [] } = {}) {
    setChildProcessHandler(request => {
      const text = String(request.commandText || request.command);
      if (figmaPaths.length && text.startsWith('/bin/ps ax -o pid= -o command=')) return { stdout: '900 /Applications/Figma.app/Contents/MacOS/Figma\n' };
      if (text.includes('/usr/sbin/lsof -F n -p 900')) return { stdout: figmaPaths.map(file => `n${file}\n`).join('') };
      if (text.includes("grep -i 'Adobe Photoshop'")) return { stdout: photoshopPaths.length ? 'Adobe Photoshop\n' : '' };
      if (text.includes("grep -i 'Adobe InDesign'")) return { stdout: indesignPaths.length ? 'Adobe InDesign\n' : '' };
      if (isOsascriptInvocation(request, 'crate-ps-scan.applescript')) return { stdout: photoshopPaths.join('\n') };
      if (isOsascriptInvocation(request, 'crate-indd-scan.applescript')) return { stdout: indesignPaths.join('\n') };
      return { stdout: '' };
    });
  }
  const addSource = async (f, file) => { f.project().files.push({ ...rowFor(file), source: 'manual-browse' }); };
  const linkDocument = (file, links) => { if (file.endsWith('.ai')) writeSyntheticAiFile(file, links.join('\n')); else touch(file, links.join('\n')); return file; };

  // --- Reads do not follow the number of rows or items --------------------------
  routeTest('the row pass reads the output folders once however many rows there are', { timeout: 120000 }, async () => {
    const reads = {};
    for (const count of [10, 100, 400]) {
      const f = await projectWithRows(count);
      reads[count] = await countReads(() => hooks.pruneRows(f.project()));
    }
    assert.deepEqual(reads, { 10: 2, 100: 2, 400: 2 });
  });
  for (const [label, run] of [
    ['a store write that changes one row', f => hooks.mutateProjectForTest(f.id, project => { project.files[0].touched = true; })],
    ['removing one row', f => callIpcRaw('projects:remove-file', f.id, 'row-1')],
    ['a pre-package scan', f => scan(f)],
  ]) {
    routeTest(`${label} costs the same reads for 10, 100 and 400 rows`, { timeout: 180000 }, async () => {
      const reads = []; await settleProcess();
      for (const count of [10, 100, 400]) { const f = await projectWithRows(count); reads.push(await countReads(() => run(f))); }
      assertNotPerItem(reads, [10, 100, 400]);
    });
  }
  routeTest('a project of manual rows reads nothing in the row pass', { timeout: 60000 }, async () => {
    const f = await freshProject();
    f.project().files = [rowFor(touch(desktop('a.png')), { source: 'manual' }), rowFor(touch(desktop('b.png')), { source: 'manual-browse' }), null];
    assert.equal(await countReads(() => hooks.pruneRows(f.project())), 0);
  });
  routeTest('the source-master dedupe pass reads once however many candidates there are', { timeout: 60000 }, async () => {
    const reads = [];
    for (const count of [5, 50]) {
      const f = await freshProject(), files = [];
      for (let i = 0; i < count; i++) files.push(rowFor(touch(desktop(`Copy ${i}`, 'Layout.psd')), { source: 'lsof', fileId: `copy-${i}` }));
      reads.push(await countReads(() => hooks.dedupeSourceMasters(f.project(), files)));
    }
    assert.equal(reads[1], reads[0], reads.join());
  });

  const LOOP_SITES = {
    'Figma open-file lines': async (f, items) => modelTools({ figmaPaths: items.map(i => desktop(`missing-${i}.fig`)) }),
    'Figma folder walk': async (f, items) => {
      const old = new Date(Date.now() - 90 * 86400000);
      for (const i of items) fs.utimesSync(touch(desktop('Figs', `old-${i}.fig`)), old, old);
    },
    'Photoshop path lines': async (f, items) => modelTools({ photoshopPaths: items.map(i => desktop(`missing-${i}.png`)) }),
    'InDesign path lines': async (f, items) => modelTools({ indesignPaths: items.map(i => desktop(`missing-${i}.png`)) }),
    'linked paths of a design file': async (f, items) => addSource(f, linkDocument(desktop('Links.ai'), items.map(i => desktop(`missing-${i}.png`)))),
    'double-check of a design file': async (f, items) => addSource(f, linkDocument(desktop('Links.xd'), items.map(i => desktop(`missing-${i}.png`)))),
  };
  const range = count => Array.from({ length: count }, (_, i) => i);
  for (const [label, setup] of Object.entries(LOOP_SITES)) {
    routeTest(`${label}: a pre-package scan costs the same reads for 10 and 120 items`, { timeout: 120000 }, async () => {
      const reads = []; await settleProcess();
      for (const count of [10, 120]) { const f = await freshProject(); await setup(f, range(count)); reads.push(await countReads(() => scan(f))); }
      assertNotPerItem(reads, [10, 120]);
    });
  }
  routeTest('the last-used poll reads the output folders once for all its lines', { timeout: 120000 }, async () => {
    const reads = [];
    for (const count of [10, 120]) {
      const f = await freshProject(); await callIpcRaw('projects:start-watching', f.id); await hooks.waitForWatcherIdle(f.id); clearTrackedTimers();
      storeInstance.set('quickPackageOutputPaths', [desktop('Generated')]); hooks.markDesignAppRunning(f.id);
      const lines = range(count).map(i => desktop('Generated', `item-${i}.png`)).join('\n');
      setChildProcessHandler(({ command }) => ({ stdout: command === '/usr/bin/mdfind' ? lines : '' }));
      const token = hooks.getActiveWatchingActivationToken(f.id);
      reads.push(await countReads(() => hooks.pollLastUsedCore(f.id, token)));
      await callIpcRaw('projects:pause', f.id); clearTrackedTimers();
    }
    assert.equal(reads[1], reads[0], reads.join());
  });
  routeTest('reads follow the staged items of a loop, not its length', { timeout: 120000 }, async () => {
    const readsFor = async (missing, staged) => {
      const f = await freshProject(), present = range(staged).map(i => touch(desktop(`present-${i}.png`)));
      modelTools({ photoshopPaths: [...present, ...range(missing).map(i => desktop(`missing-${i}.png`))] });
      return countReads(() => scan(f));
    };
    await settleProcess();
    const small = await readsFor(10, 2);
    assertNotPerItem([small, await readsFor(120, 2)], [10, 120]);
    assert.ok(await readsFor(10, 12) > small + 20, 'each staged item takes a fresh read');
  });

  // --- The same answers as a fresh check of each path ---------------------------
  function equivalenceRows() {
    const paths = [
      '', '   ', 5, null, undefined, desktop('Keep', 'kept.png'), desktop('OwnOutput', 'inside.png'), desktop('OtherOutput', 'inside.png'),
      desktop('QuickOutput', 'inside.png'), desktop('Keep', 'crate-provenance.json'), desktop('Crate Diagnostics', 'x.png'),
      desktop('Client_2026-01-02', 'x.png'), path.resolve('relative-output', 'inside.png'), path.resolve('relative-quick', 'inside.png'),
    ];
    return [...paths.map((file, index) => ({ path: file, name: `row-${index}`, ext: '.png', source: 'lsof', fileId: `row-${index}` })),
      { path: desktop('OwnOutput', 'manual.png'), name: 'manual.png', ext: '.png', source: 'manual', fileId: 'manual' },
      { path: desktop('OwnOutput', 'browse.png'), name: 'browse.png', ext: '.png', source: 'manual-browse', fileId: 'browse' }];
  }
  function setOutputs(f) {
    f.project().outputPath = desktop('OwnOutput');
    storeInstance.data.projects.find(item => item.id !== f.id).outputPath = desktop('OtherOutput');
    const third = storeInstance.data.projects.filter(item => item.id !== f.id)[1]; third.outputPath = 'relative-output';
    storeInstance.set('quickPackageOutputPaths', [desktop('QuickOutput'), 'relative-quick', '', 7]);
  }
  const expectedKept = rows => rows.filter(row => row.source === 'manual' || row.source === 'manual-browse' || !hooks.isOutputPath(row.path)).map(row => row.fileId);
  routeTest('the row pass keeps and drops exactly what one check per row would', { timeout: 60000 }, async () => {
    const f = await freshProject(); setOutputs(f);
    const rows = equivalenceRows(), expected = expectedKept(rows);
    assert.ok(expected.includes('row-5')); assert.ok(expected.includes('manual')); assert.ok(!expected.includes('row-6')); assert.ok(!expected.includes('row-7')); assert.ok(!expected.includes('row-8'));
    assert.ok(!expected.includes('row-12'), 'relative project output'); assert.ok(!expected.includes('row-13'), 'relative quick output');
    const target = { files: rows };
    hooks.pruneRows(target);
    assert.deepEqual(target.files.map(row => row.fileId), expected);
  });
  routeTest('with an empty store the row pass keeps ordinary rows', { timeout: 60000 }, async () => {
    await callIpcRaw('projects:delete-all'); storeInstance.set('quickPackageOutputPaths', []);
    const target = { files: [{ path: desktop('Keep', 'a.png'), source: 'lsof', fileId: 'a' }, { path: '', source: 'lsof', fileId: 'empty' }] };
    hooks.pruneRows(target);
    assert.deepEqual(target.files.map(row => row.fileId), ['a']);
  });
  routeTest('a first row decided early still reads once, and a normalizing read writes once', { timeout: 60000 }, async () => {
    const f = await freshProject(); setOutputs(f);
    delete f.project().assetBaseline; // the next read repairs this and writes it back
    const realSet = storeInstance.set; let projectWrites = 0;
    storeInstance.set = function (key, ...rest) { if (key === 'projects') projectWrites++; return realSet.call(this, key, ...rest); };
    const target = { files: [{ path: '', source: 'lsof', fileId: 'early' }, { path: desktop('Keep', 'crate-provenance.json'), source: 'lsof', fileId: 'manifest' },
      { path: desktop('Keep', 'kept.png'), source: 'lsof', fileId: 'kept' }, { path: desktop('QuickOutput', 'x.png'), source: 'lsof', fileId: 'quick' }] };
    let reads;
    try { reads = await countReads(() => hooks.pruneRows(target)); } finally { storeInstance.set = realSet; }
    assert.deepEqual(target.files.map(row => row.fileId), ['kept']);
    assert.equal(projectWrites, 1); assert.equal(reads, 2);
  });
  routeTest('the dedupe pass ranks candidates as one check per candidate would', { timeout: 60000 }, async () => {
    const f = await freshProject(); setOutputs(f);
    const outside = rowFor(touch(desktop('Keep', 'Layout.psd')), { source: 'lsof', fileId: 'outside', addedAt: 1 });
    const inside = rowFor(touch(desktop('OwnOutput', 'Layout.psd')), { source: 'lsof', fileId: 'inside', addedAt: 2 });
    assert.equal(hooks.dedupePriority(f.project(), inside) < hooks.dedupePriority(f.project(), outside), true);
    assert.deepEqual(hooks.dedupeSourceMasters(f.project(), [inside, outside]).map(row => row.fileId), ['outside']);
  });

  // --- Never a stale view --------------------------------------------------------
  routeTest('a store write between two row passes is seen by the second', { timeout: 60000 }, async () => {
    const f = await freshProject(), file = desktop('Later', 'x.png'), target = { files: [{ path: file, source: 'lsof', fileId: 'x' }] };
    hooks.pruneRows(target); assert.equal(target.files.length, 1);
    storeInstance.set('quickPackageOutputPaths', [desktop('Later')]);
    hooks.pruneRows(target); assert.deepEqual(target.files, []);
  });
  const STAGING_SITES = {
    'Figma open-file lines': ['.fig', async (f, first, second) => modelTools({ figmaPaths: [first, second] })],
    'Figma folder walk': ['.fig', async () => {}],
    'Photoshop path lines': ['.png', async (f, first, second) => modelTools({ photoshopPaths: [first, second] })],
    'InDesign path lines': ['.png', async (f, first, second) => modelTools({ indesignPaths: [first, second] })],
    'linked paths of a design file': ['.png', async (f, first, second) => addSource(f, linkDocument(desktop('Links.ai'), [first, second]))],
    'double-check of a design file': ['.png', async (f, first, second) => addSource(f, linkDocument(desktop('Links.xd'), [first, second]))],
  };
  for (const [label, [ext, setup]] of Object.entries(STAGING_SITES)) {
    routeTest(`${label}: the item after a staging write is judged against the new output folders`, { timeout: 60000 }, async () => {
      const f = await freshProject(), folder = documentsFolder('Generated');
      const first = touch(desktop(`first${ext}`)), second = touch(path.join(folder, `second${ext}`));
      await setup(f, first, second);
      const staged = [];
      const restore = hooks.watchStagedFiles(file => { staged.push(file.path); if (file.path === first) storeInstance.set('quickPackageOutputPaths', [folder]); });
      try { await scan(f); } finally { restore(); }
      assert.ok(staged.includes(first), 'the first item was staged');
      assert.equal(staged.includes(second), false);
    });
  }
  function holdRead(file) {
    const real = fs.promises.readFile; let reached, release;
    const started = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
    fs.promises.readFile = async function (target, ...args) { if (target === file) { reached(); fs.promises.readFile = real; await gate; } return real.call(this, target, ...args); };
    return { started, release, restore() { fs.promises.readFile = real; release(); } };
  }
  for (const [label, ext] of [['linked paths', '.ai'], ['double-check', '.xd']]) {
    routeTest(`${label}: a store change during one file's read is seen for that file`, { timeout: 60000 }, async () => {
      const f = await freshProject(), folder = documentsFolder('Generated');
      const present = touch(desktop('present.png')), generated = touch(path.join(folder, 'generated.png'));
      const firstDocument = linkDocument(desktop(`A${ext}`), [desktop('missing.png')]), secondDocument = linkDocument(desktop(`B${ext}`), [present, generated]);
      await addSource(f, firstDocument); await addSource(f, secondDocument);
      const staged = [], restore = hooks.watchStagedFiles(file => staged.push(file.path)), hold = holdRead(secondDocument);
      try {
        const running = scan(f); await hold.started;
        storeInstance.set('quickPackageOutputPaths', [folder]); hold.release(); await running;
      } finally { hold.restore(); restore(); }
      assert.ok(staged.includes(present)); assert.equal(staged.includes(generated), false);
    });
  }
}
