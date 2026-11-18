'use strict';
// The complete production routes against the real IPC/store harness with real
// generated PSD bytes. Electron, Photoshop, Illustrator and the watcher are
// modeled; ag-psd, the filesystem and the package writer are real.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), assert = require('./bounded-assert');
const entry = path.join(__dirname, 'provenance-dual-write.test.js');
let source = fs.readFileSync(entry, 'utf8');
function replaceOnce(before, after) { assert.equal(source.split(before).length, 2, `harness anchor drift: ${before.slice(0, 60)}`); source = source.replace(before, () => after); }
replaceOnce("const test = require('node:test');", "const routeTest = require('node:test'); const test = new Proxy(routeTest, { apply() {} });");
// Linked paths must start with /Users/, so the synthetic home sits in the real one.
replaceOnce("fs.mkdtempSync(path.join(os.tmpdir(), 'crate-provenance-dual-write-home-'))", "fs.mkdtempSync(path.join(originalHomedir(), 'crate-embedded-documents-home-'))");
replaceOnce('  readPsd: () => {', "  readPsd: (buffer, options) => originalLoad.call(Module, 'ag-psd/dist/index.js', module).readPsd(buffer, options),\n  fixtureReadPsd: () => {");
replaceOnce('const fixture = structuredClone(currentPsdFixture);', 'const fixture = null;');
replaceOnce('                  psd: fixture,',
  "                  psd: originalLoad.call(Module, 'ag-psd/dist/index.js', module).readPsd(fs.readFileSync(filePath), { skipLayerImageData: true, skipCompositeImageData: true, totalMemoryLimit: -Infinity }),\n" +
  "                  framing: require('../parsers/add-files-psd-worker').inspectPsdLinkFraming(fs.readFileSync(filePath)),");
replaceOnce('      return nextOpenDialogResult;', '      if (globalThis.__embeddedDialog) return globalThis.__embeddedDialog();\n      return nextOpenDialogResult;');
replaceOnce('  captureProjectOperation,\n  runScanOnOpen', '  clearPsdParseDebounce() { psdParseDebounce.clear(); },\n  isRowExcludedForReview(project, row) { return isAssetReviewFileExcluded(project, row); },\n  fileNodeId(filePath) { return createNodeId(NODE_TYPES.FILE, { normalizedPath: normalizeTrackedFilePath(filePath) }); },\n  sourceRouteKey(project, row) { return getAssetBaselineSourceRecoveryRouteKey(project, row); },\n  captureProjectOperation,\n  runScanOnOpen');
source += '\n(' + cases.toString() + ')();\n';
const compiled = new Module(entry, module); compiled.filename = entry; compiled.paths = Module._nodeModulePaths(path.dirname(entry)); compiled._compile(source, entry);

function cases() {
  const nodeCrypto = require('node:crypto');
  const agPsd = originalLoad.call(Module, 'ag-psd/dist/index.js', module);
  const psdFixtures = require('./fixtures/embedded-photoshop-documents.cjs').createFixtures(agPsd);
  const { embedded, external, plainDocument, documentHolding, parentPsd, png } = psdFixtures;
  const sha = data => nodeCrypto.createHash('sha256').update(data).digest('hex');
  routeTest.after(() => { fs.rmSync(TEST_HOME, { recursive: true, force: true }); });
  const SMART = '[YOUR IMAGE HERE].psb';
  // What the sequence shows besides the 12 linked PNGs: every step equals the same
  // sequence on the previous code with the proven documents' rows removed.
  const row = (source, name, state = 'included') => `files | ${source} | ${name} | ${state}`;
  const SOURCES = [row('app-opened', 'Logo Board.ai'), row('scan-on-open', 'Pin Mockup.psd'), row('scan-on-open', 'Tote Mockup.psd')];
  const withSources = rows => [...SOURCES, ...rows].sort();
  const FIRST_SCAN = withSources([row('psd-embedded', 'Linked Smart.psb'), row('psd-embedded', 'Placed Texture.png')]);
  const EXCLUDED = withSources([row('psd-embedded', 'Linked Smart.psb', 'excluded'), row('psd-embedded', 'Placed Texture.png')]);
  const SAVED = withSources([row('psd-embedded', 'Linked Smart.psb', 'excluded'), row('psd-embedded', 'Placed Texture.png'),
    row('scan-on-save-embedded', 'Linked Smart.psb'), row('scan-on-save-embedded', 'Placed Texture.png')]);
  const CLOSED = [...SAVED, row('psd-embedded', 'Linked Smart_1.psb'), row('psd-embedded', 'Placed Texture_1.png')].sort();
  const EXPECTED_ROWS = { 'links read': SOURCES, 'package 1': FIRST_SCAN, 'package 2': FIRST_SCAN, 'package 3': FIRST_SCAN, 'after exclude': EXCLUDED,
    'photoshop open': EXCLUDED, saved: SAVED, 'photoshop closed': CLOSED, 'final package click': CLOSED };
  const FIRST_CACHE = ['Linked Smart.psb', 'Placed Texture.png', 'Retired Sentinel.psb'], LAST_CACHE = ['Linked Smart.psb', 'Linked Smart_1.psb', 'Placed Texture.png', 'Placed Texture_1.png', 'Retired Sentinel.psb'];
  const EXPECTED_CACHE = { 'links read': [], 'package 1': FIRST_CACHE, 'package 2': FIRST_CACHE, 'package 3': FIRST_CACHE, 'after exclude': FIRST_CACHE,
    'photoshop open': FIRST_CACHE, saved: FIRST_CACHE, 'photoshop closed': LAST_CACHE, 'final package click': LAST_CACHE };
  const EXPECTED_PACKAGE = ["AI/Logo Board.ai", "Crate Diagnostics/crate-provenance.json", "PNG/Pin_Option1.png", "PNG/Pin_Option2.png", "PNG/Pin_Option3.png", "PNG/Pin_Option4.png", "PNG/Pin_Option5.png", "PNG/Pin_Option6.png", "PNG/Placed Texture_1_1.png", "PNG/Placed Texture_1.png", "PNG/Placed Texture.png", "PNG/Tote_Option1.png", "PNG/Tote_Option2.png", "PNG/Tote_Option3.png", "PNG/Tote_Option4.png", "PNG/Tote_Option5.png", "PNG/Tote_Option6.png", "PSB/Linked Smart_1.psb", "PSB/Linked Smart.psb", "PSD/Pin Mockup.psd", "PSD/Tote Mockup.psd"];
  const stored = id => storeInstance.data.projects.find(item => item.id === id);
  const extractDir = id => path.join(os.tmpdir(), 'crate-psd-extract-' + id);
  const cacheNames = id => { try { return fs.readdirSync(extractDir(id)).filter(name => !name.startsWith('.')).sort(); } catch (_) { return []; } };
  const idle = async id => { await metadataTestHooks.waitForWatcherIdle(id); clearTrackedTimers(); };
  const token = id => metadataTestHooks.getActiveWatchingActivationToken(id);
  function rowsOf(id) {
    const project = stored(id);
    const describe = (row, collection) => [collection, row.source, row.name, metadataTestHooks.isRowExcludedForReview(project, row) ? 'excluded' : 'included'].join(' | ');
    return [...project.files.map(row => describe(row, 'files')), ...(project.pendingFiles || []).map(row => describe(row, 'pending'))].sort();
  }

  // Two mockups. Tote holds every kind of object; Pin only proven ones.
  function createMockups(root) {
    const links = path.join(root, 'Links'); fs.mkdirSync(links, { recursive: true });
    const tote = path.join(links, 'Tote Mockup.psd'), pin = path.join(links, 'Pin Mockup.psd');
    const fabric = path.join(links, 'Shared Fabric.psb'), inner = path.join(links, 'Inner External.png');
    fs.writeFileSync(fabric, plainDocument('fabric')); fs.writeFileSync(inner, createSyntheticPngBytes(8, 8, 0x21));
    const ids = {}, documents = {};
    const stable = (key, record) => { record.id = ids[key] ||= record.id; return record; };
    const once = (key, make) => (documents[key] ||= make());
    const state = { revision: { tote: 0, pin: 0 } };
    const write = {
      tote() {
        const r = state.revision.tote;
        fs.writeFileSync(tote, parentPsd([
          stable('t0', embedded(SMART, plainDocument(`tote-0-${r}`))), stable('t1', embedded(SMART, once('t1', () => plainDocument('tote-1')))), stable('t2', embedded(SMART, once('t2', () => plainDocument('tote-2')))),
          stable('png', embedded('Placed Texture.png', png('texture'), { type: 'png ' })),
          stable('open', embedded('Linked Smart.psb', once('open', () => documentHolding([external('Inner External.png', inner)])))),
          stable('nest', embedded('Nested Smart.psb', once('nest', () => documentHolding([embedded('Inner.psb', plainDocument('tote-inner'))])))),
          stable('ext', external('Shared Fabric.psb', fabric)),
        ], `tote-doc-${r}`));
      },
      pin() {
        const r = state.revision.pin;
        fs.writeFileSync(pin, parentPsd([stable('p0', embedded(SMART, plainDocument(`pin-0-${r}`))), stable('p1', embedded(SMART, once('p1', () => plainDocument('pin-1'))))], `pin-doc-${r}`));
      },
    };
    write.tote(); write.pin();
    return { links, tote, pin, fabric, inner, state, write, documents };
  }

  function modelApps(apps, ai, linkPaths) {
    setChildProcessHandler(request => {
      const { kind, command, args } = request, text = String(request.commandText || command);
      if (isIllustratorPgrepCheck(request)) return { stdout: '432\n' };
      if (isOsascriptInvocation(request, 'crate-ai-active-session.applescript')) {
        if (!apps.aiOpen) return { stdout: 'STATUS\tno-documents\nCOMPLETE\t0\t0\n' };
        return { stdout: `DOC\t${ai}\t${path.basename(ai)}\tfalse\ttrue\n` + linkPaths.map(link => `LINK\t${ai}\t${path.basename(ai)}\t${link}\tfalse\ttrue\n`).join('') + `COMPLETE\t1\t${linkPaths.length}\n` };
      }
      if (isOsascriptInvocation(request, 'crate-ps-poll.applescript') || isOsascriptInvocation(request, 'crate-ps-scan.applescript')) return { stdout: apps.psOpen.size ? SMART : '' };
      const paths = bulkXattrPaths(request);
      if (paths.length) return { stdout: formatBulkXattrOutput(paths, () => encodeLastUsedXattr(Date.now() - 30 * 86400000)) };
      if (isBulkSpotlightRequest(request)) return { stdout: Buffer.alloc(0) };
      if (text.includes("grep -i 'Adobe Photoshop'")) return { stdout: apps.psOpen.size ? '/Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app/Contents/MacOS/Adobe Photoshop 2026\n' : '' };
      if (text.includes("grep -i 'Adobe InDesign'")) return { stdout: '' };
      if ((command === '/bin/ps' && Array.isArray(args)) || (kind === 'exec' && text.startsWith('/bin/ps ') && text.includes('pid='))) {
        return { stdout: '432 /Applications/Adobe Illustrator 2026/Adobe Illustrator.app/Contents/MacOS/Adobe Illustrator\n' +
          (apps.psOpen.size ? '555 /Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app/Contents/MacOS/Adobe Photoshop 2026\n' : '') };
      }
      if (text.includes('/usr/sbin/lsof')) return { stdout: (apps.aiOpen ? `p432\ntREG\nn${ai}\n` : '') + (apps.psOpen.size ? 'p555\n' + [...apps.psOpen].map(file => `tREG\nn${file}\n`).join('') : '') };
      return { stdout: '' };
    });
  }

  async function createSequenceProject() {
    resetTestHomeWorkspace(); storeInstance.set('quickPackageOutputPaths', []);
    const root = path.join(TEST_HOME, 'Desktop', 'Synthetic Mockup Project'), outDir = path.join(TEST_HOME, 'Desktop', 'Synthetic Packages');
    fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(outDir, { recursive: true });
    const mockups = createMockups(root), pngs = [];
    for (const kind of ['Tote', 'Pin']) for (let i = 1; i <= 6; i++) { const file = path.join(mockups.links, `${kind}_Option${i}.png`); fs.writeFileSync(file, createSyntheticPngBytes(16, 12, 0x40 + pngs.length)); pngs.push(file); }
    const ai = path.join(root, 'Logo Board.ai'), linkPaths = [mockups.tote, mockups.pin, ...pngs];
    writeSyntheticAiFile(ai, linkPaths.join('\n'));
    const apps = { aiOpen: false, psOpen: new Set() };
    modelApps(apps, ai, linkPaths);
    const project = await createProject('Synthetic Mockup Board'); clearTrackedTimers();
    fs.rmSync(extractDir(project.id), { recursive: true, force: true });
    return { id: project.id, ai, outDir, apps, pngs, ...mockups };
  }

  const pollApps = async f => { await metadataTestHooks.pollPsForProject(f.id, token(f.id)); await idle(f.id); };
  const pollFiles = async f => { await metadataTestHooks.pollLsofForProject(f.id, token(f.id)); await idle(f.id); };
  const packageClick = async f => {
    metadataTestHooks.clearPsdParseDebounce();
    const scan = await callIpcRaw('projects:pre-package-scan', f.id);
    assert.equal(scan?.error, undefined);
    const review = await callIpcRaw('projects:prepare-package-review', f.id);
    assert.equal(review?.error, undefined);
    f.review = review;
  };
  async function save(f, which) {
    f.state.revision[which]++; f.write[which]();
    const file = f[which], time = new Date(Date.now() + 2000 * f.state.revision[which]);
    fs.utimesSync(file, time, time);
    await emitWatcher('change', file, fs.statSync(file));
    metadataTestHooks.clearPsdParseDebounce();
    await metadataTestHooks.runScanOnSave(f.id, file, token(f.id));
    await idle(f.id);
  }
  function listPackage(dir) {
    const out = [];
    const walk = current => { for (const item of fs.readdirSync(current, { withFileTypes: true })) { const full = path.join(current, item.name); if (item.isDirectory()) walk(full); else out.push({ rel: path.relative(dir, full), sha: sha(fs.readFileSync(full)) }); } };
    walk(dir); return out.sort((a, b) => a.rel.localeCompare(b.rel));
  }

  // A row left by an earlier build, for a document no longer in the PSD. It must
  // leave membership at the first scan; its record then must stay private.
  const SENTINEL_NAME = 'Retired Sentinel.psb', SENTINEL_ID = 'retired-sentinel-row';
  function addRetiringRow(f) {
    const data = plainDocument('retired-sentinel'), file = path.join(extractDir(f.id), SENTINEL_NAME);
    fs.mkdirSync(extractDir(f.id), { recursive: true }); fs.writeFileSync(file, data);
    stored(f.id).files.push({ path: file, name: SENTINEL_NAME, ext: '.psb', source: 'psd-embedded', addedAt: Date.now(), fileId: SENTINEL_ID,
      psdExtractionReceipt: { version: 1, parentPath: f.tote, sourceDigest: sha(fs.readFileSync(f.tote)), layerPath: null, linkedIndex: 40, originalName: SENTINEL_NAME, outputDigest: sha(data) } });
  }
  const LEAK_MARKERS = ['retiredEmbeddedDocuments', SENTINEL_ID, SENTINEL_NAME];
  const leakIn = text => LEAK_MARKERS.find(marker => text.includes(marker)) || null;
  const serialize = value => { try { return JSON.stringify(value) || ''; } catch (_) { return String(value); } };

  routeTest('full sequence: proven documents never become rows, and everything else is as before', { timeout: 300000 }, async t => {
    const f = await createSequenceProject();
    await callIpcRaw('settings:update', 'includeDiagnosticReport', true);
    t.after(() => callIpcRaw('settings:update', 'includeDiagnosticReport', false));
    // Every IPC answer, renderer message and log line of the run is inspected.
    const leaks = [], realHandlers = new Map(ipcHandlers), realConsole = {};
    for (const [channel, handler] of realHandlers) {
      ipcHandlers.set(channel, async (...args) => {
        const result = await handler(...args), marker = leakIn(serialize(result));
        if (marker) leaks.push(`ipc ${channel}: ${marker}`);
        return result;
      });
    }
    for (const level of ['log', 'warn', 'error']) {
      realConsole[level] = console[level];
      console[level] = (...args) => { const marker = leakIn(args.map(serialize).join(' ')); if (marker) leaks.push(`console.${level}: ${marker}`); realConsole[level](...args); };
    }
    testRendererEvents.length = 0;
    const seen = {};
    const check = name => {
      seen[name] = rowsOf(f.id);
      assert.deepEqual(seen[name].filter(row => !row.includes('_Option')), EXPECTED_ROWS[name], name);
      assert.equal(seen[name].filter(row => row.includes('_Option')).length, 12, name);
      assert.deepEqual(cacheNames(f.id), EXPECTED_CACHE[name], `${name}: cache`);
      assert.equal(stored(f.id).workingSourceRelationshipHolds ?? null, null, `${name}: holds`);
    };
    try {
      await pollApps(f); f.apps.aiOpen = true; await pollApps(f); await pollFiles(f); await pollApps(f); check('links read');
      if (stored(f.id).assetBaseline?.status === 'decision-required') await callIpcRaw('projects:set-existing-assets-decision', f.id, 'include');
      addRetiringRow(f);
      for (const n of [1, 2, 3]) { await packageClick(f); check(`package ${n}`); }
      assert.deepEqual(stored(f.id).retiredEmbeddedDocuments.entries.map(entry => entry.row.fileId), [SENTINEL_ID]);
      for (const row of stored(f.id).files.filter(item => item.ext === '.psb' && item.source === 'psd-embedded')) await callIpcRaw('projects:remove-file', f.id, row.fileId || row.path);
      await packageClick(f); check('after exclude');
      f.apps.psOpen = new Set([f.tote, f.pin]); await pollFiles(f); await pollApps(f); check('photoshop open');
      await save(f, 'tote'); await save(f, 'pin'); check('saved');
      f.apps.psOpen = new Set(); await pollFiles(f); check('photoshop closed');
      await packageClick(f); check('final package click');
      const toteBytes = fs.readFileSync(f.tote), pinBytes = fs.readFileSync(f.pin);
      let result = await callIpcRaw('projects:package', f.id, f.outDir, f.review.token);
      if (result?.error === 'package_review_changed' && result.review?.token) result = await callIpcRaw('projects:package', f.id, f.outDir, result.review.token);
      assert.equal(result?.success, true, serialize(result).slice(0, 300));
      const listing = listPackage(result.folderPath), bySuffix = name => listing.filter(item => path.basename(item.rel) === name).map(item => item.sha);
      {
        assert.deepEqual(listing.map(item => item.rel), EXPECTED_PACKAGE);
        assert.deepEqual(bySuffix('Tote Mockup.psd'), [sha(toteBytes)]);
        assert.deepEqual(bySuffix('Pin Mockup.psd'), [sha(pinBytes)]);
        assert.deepEqual(bySuffix('Logo Board.ai'), [sha(fs.readFileSync(f.ai))]);
        for (const file of f.pngs) assert.deepEqual(bySuffix(path.basename(file)), [sha(fs.readFileSync(file))]);
        for (const name of ['Placed Texture.png', 'Placed Texture_1.png', 'Placed Texture_1_1.png']) assert.deepEqual(bySuffix(name), [sha(png('texture'))], name);
        for (const name of ['Linked Smart.psb', 'Linked Smart_1.psb']) assert.deepEqual(bySuffix(name), [sha(f.documents.open)], name);
        const forbidden = [...Object.entries(f.documents).filter(([key]) => key !== 'open').map(([, data]) => sha(data))];
        assert.equal(listing.some(item => forbidden.includes(item.sha)), false, 'no extracted copy of a proven document');
        assert.equal(result.embeddedCount, 0);
      }
      // Package output, including the provenance manifest and diagnostic report.
      assert.ok(listing.some(item => item.rel.endsWith('crate-provenance.json')));
      for (const item of listing) {
        const marker = leakIn(fs.readFileSync(path.join(result.folderPath, item.rel)).toString('latin1'));
        if (marker) leaks.push(`package ${item.rel}: ${marker}`);
      }
      for (const event of testRendererEvents) { const marker = leakIn(serialize(event)); if (marker) leaks.push(`send ${event.channel}: ${marker}`); }
      assert.ok(testRendererEvents.length > 0);
      assert.deepEqual(leaks, []);
    } finally {
      for (const [channel, handler] of realHandlers) ipcHandlers.set(channel, handler);
      Object.assign(console, realConsole);
      await callIpcRaw('projects:pause', f.id); await idle(f.id);
    }
  });

  // --- Seeded stores -------------------------------------------------------
  async function seededProject(label = 'Seeded') {
    resetTestHomeWorkspace(); storeInstance.set('quickPackageOutputPaths', []); setChildProcessHandler(() => ({ stdout: '' }));
    const project = await createProject(label); await callIpcRaw('projects:pause', project.id); clearTrackedTimers();
    const dir = path.join(TEST_HOME, 'Desktop', 'Seed'); fs.mkdirSync(dir, { recursive: true });
    const psd = path.join(dir, 'Mock.psd'), smart = plainDocument(`seed-smart-${label}`), texture = png(`seed-${label}`);
    const records = () => [{ ...embedded('Smart.psb', smart), id: smartId }, { ...embedded('Texture.png', texture, { type: 'png ' }), id: textureId }];
    const smartId = psdFixtures.guid('smart'), textureId = psdFixtures.guid('texture');
    fs.writeFileSync(psd, parentPsd(records(), 'seed-parent'));
    await setProjectFiles(project.id, { files: [{ path: psd, name: 'Mock.psd', ext: '.psd', source: 'manual-browse', addedAt: Date.now() }] });
    fs.rmSync(extractDir(project.id), { recursive: true, force: true }); fs.mkdirSync(extractDir(project.id), { recursive: true });
    const f = { id: project.id, psd, smart, texture, smartId, textureId, project: () => stored(project.id) };
    f.rewrite = (data, seed) => fs.writeFileSync(psd, parentPsd([{ ...embedded('Smart.psb', data), id: smartId }, { ...embedded('Texture.png', texture, { type: 'png ' }), id: textureId }], seed));
    return f;
  }
  function seedRow(f, { name = 'Smart.psb', data = f.smart, field = 'psdExtractionReceipt', linkedIndex = 0, fileId = 'seed-row', parent = f.psd, write = true } = {}) {
    const file = path.join(extractDir(f.id), name);
    if (write) fs.writeFileSync(file, data);
    const receipt = { version: 1, parentPath: parent, sourceDigest: sha(fs.readFileSync(f.psd)), layerPath: null, linkedIndex, originalName: name, outputDigest: sha(data),
      ...(field === 'psdResource' ? { producerId: f.smartId } : {}) };
    return { path: file, name, ext: path.extname(name), source: 'psd-embedded', addedAt: 1700000000000, fileId, [field]: receipt };
  }
  const logicalRow = (f, overrides = {}) => ({ path: f.psd, name: 'Smart.psb', ext: '.psb', source: 'scan-on-save-embedded', embedded: true, parentPsd: f.psd, addedAt: 1700000000000,
    embeddedOriginalName: 'Smart.psb', embeddedIndex: 0, fileId: 'logical-row', embeddedContentFingerprint: `${f.smart.length}:${sha(f.smart)}`, ...overrides });
  const ROUTES = {
    'pre-package scan': async f => { assert.equal((await callIpcRaw('projects:pre-package-scan', f.id))?.error, undefined); },
    'scan on open': async f => { assert.equal((await metadataTestHooks.runScanOnOpen(f.id, f.psd, null, null, { allowPausedBaseline: true, establishBaseline: false }))?.success, true); },
    'save scan': async f => { await metadataTestHooks.runScanOnSave(f.id, f.psd, null); },
  };
  const scanOn = async (route, f) => { metadataTestHooks.clearPsdParseDebounce(); await ROUTES[route](f); };
  const memberRows = f => [...f.project().files, ...(f.project().pendingFiles || [])];
  const findRow = (f, fileId) => memberRows(f).find(row => row.fileId === fileId);
  const retiredEntries = f => f.project().retiredEmbeddedDocuments?.entries || [];
  const plain = value => JSON.parse(JSON.stringify(value));
  // A store write applies the normal row defaults, so "unchanged" means after them.
  const settled = f => callIpcRaw('projects:pause', f.id);

  for (const route of Object.keys(ROUTES)) {
    for (const [label, setup] of Object.entries({
      'accepted row with an extraction receipt': (f, row) => f.project().files.push(row),
      'pending row with an extraction receipt': (f, row) => { f.project().pendingFiles = [row]; },
      'row with a resource record': (f, _row) => f.project().files.push(seedRow(f, { field: 'psdResource' })),
      'row of an object no longer in the PSD': (f, _row) => f.project().files.push(seedRow(f, { name: 'Old Smart.psb', data: plainDocument('old-smart'), linkedIndex: 9 })),
    })) {
      routeTest(`${route}: retires ${label}`, { timeout: 60000 }, async () => {
        const f = await seededProject(); setup(f, seedRow(f)); await settled(f);
        const before = plain(memberRows(f).find(row => row.fileId === 'seed-row'));
        const excludedBefore = plain(f.project().excludedAssetKeys);
        await scanOn(route, f);
        assert.equal(findRow(f, 'seed-row'), undefined);
        const [entry, ...others] = retiredEntries(f);
        assert.deepEqual(others, []);
        assert.deepEqual(plain(entry.row), before);
        assert.equal(entry.parentPath, f.psd); assert.equal(entry.reason, 'proven-self-contained-embedded-document'); assert.ok(Number.isFinite(entry.retiredAt));
        assert.ok(fs.existsSync(before.path), 'the cached file stays');
        assert.deepEqual(plain(f.project().excludedAssetKeys), excludedBefore);
        assert.equal(memberRows(f).some(row => row.source === 'psd-embedded' && row.name.startsWith('Smart')), false);
        assert.equal(cacheNames(f.id).includes('Smart_1.psb'), false);
      });
    }
  }

  routeTest('save scan: a logical row is retired only when this scan finds and proves its object', { timeout: 60000 }, async () => {
    const f = await seededProject();
    f.project().files.push(logicalRow(f), logicalRow(f, { fileId: 'no-print', embeddedIndex: 0, embeddedOriginalName: 'Smart.psb', name: 'Smart_copy.psb', embeddedContentFingerprint: undefined }));
    f.project().files.push(logicalRow(f, { fileId: 'other-bytes', name: 'Other.psb', embeddedContentFingerprint: `9:${'0'.repeat(64)}` }));
    await scanOn('save scan', f);
    assert.equal(findRow(f, 'logical-row'), undefined); assert.equal(findRow(f, 'no-print'), undefined);
    assert.ok(findRow(f, 'other-bytes'), 'recorded bytes differ');
    assert.deepEqual(retiredEntries(f).map(entry => entry.row.fileId).sort(), ['logical-row', 'no-print']);
    assert.equal(memberRows(f).some(row => row.source === 'scan-on-save-embedded' && row.embeddedOriginalName === 'Smart.psb' && row.fileId !== 'other-bytes'), false);
  });

  const KEPT_ROWS = {
    'an Include marker': row => { row.individualContentInclude = `5:${'a'.repeat(64)}`; },
    'a keep marker': row => { row.keptAfterSourceExclusion = true; },
    'a choice review': row => { row.individualChoiceReview = { version: 1, reason: 'psd-embedded-restaged' }; },
    'acceptance': row => { row.acceptedPending = true; },
    'explicit authority': row => { row.explicitUserAuthority = { granted: true, source: 'manual-browse', method: 'projects:add-files', grantedAt: 1 }; },
    'an Include All episode': row => { row.existingIncludeEpisode = { version: 1, owners: {} }; },
    'an accept record': (row, f) => { f.project().provenance.observations.push({ objectNodeId: metadataTestHooks.fileNodeId(row.path), observer: { kind: 'manual_user_action', method: 'projects:accept-pending' }, payload: {} }); },
    'a working-file selection': (row, f) => { f.project().workingSourceSelections = { [metadataTestHooks.sourceRouteKey(f.project(), row)]: { state: 'excluded', revision: 1 } }; },
    'another document as its producer': row => { row.assetBaselineSourcePath = path.join(path.dirname(row.path), 'Other.psd'); },
    'a resource record no longer current': row => { row.psdExtractionReceipt.current = false; },
  };
  const EXCLUDED_ROWS = {
    'an excluded key': (row, f) => { f.project().excludedAssetKeys = [row.fileId]; },
    'an excluded path key': (row, f) => { f.project().excludedAssetKeys = [row.path]; },
    'a content exclusion': row => { row.individualContentExclusion = `${row.ext.length}:${'b'.repeat(64)}`; },
  };
  for (const [label, choose] of Object.entries({ ...KEPT_ROWS, ...EXCLUDED_ROWS })) {
    routeTest(`a row with ${label} stays exactly as it is`, { timeout: 60000 }, async () => {
      const f = await seededProject(), row = seedRow(f); f.project().files.push(row); choose(row, f); await settled(f);
      const before = plain(findRow(f, 'seed-row')), keys = plain(f.project().excludedAssetKeys);
      for (const route of Object.keys(ROUTES)) await scanOn(route, f);
      assert.deepEqual(plain(findRow(f, 'seed-row')), before);
      assert.deepEqual(retiredEntries(f), []);
      assert.deepEqual(plain(f.project().excludedAssetKeys), keys);
    });
  }

  routeTest('a row whose path another row shares is not retired', { timeout: 60000 }, async () => {
    // A store write merges such rows, so only the save scan, which plans first, can meet one.
    const f = await seededProject(), row = seedRow(f); f.project().files.push(row);
    f.project().pendingFiles = [{ ...plain(row), fileId: 'twin', source: 'psd-linked' }];
    await scanOn('save scan', f);
    assert.deepEqual(retiredEntries(f), []);
  });

  for (const [label, damage, stillThere] of [
    ['no receipt', (row, f) => { delete row.psdExtractionReceipt; f.project().files.push(row); }, true],
    ['a modified cache file', (row, f) => { fs.writeFileSync(row.path, plainDocument('modified')); f.project().files.push(row); }, true],
    ['a cache file outside the project folder', (row, f) => { const outside = path.join(path.dirname(f.psd), 'Smart.psb'); fs.copyFileSync(row.path, outside); row.path = outside; f.project().files.push(row); }, true],
    ['another parent', (row, f) => { row.psdExtractionReceipt.parentPath = path.join(path.dirname(f.psd), 'Other.psd'); f.project().files.push(row); }, true],
    ['bytes that are not a proven document', (row, f) => { const data = documentHolding([external('out.png', '/Users/synthetic/out.png')]); fs.writeFileSync(row.path, data); row.psdExtractionReceipt.outputDigest = sha(data); f.project().files.push(row); }, true],
  ]) {
    routeTest(`a row with ${label} is not retired`, { timeout: 60000 }, async () => {
      const f = await seededProject(), row = seedRow(f); damage(row, f);
      for (const route of Object.keys(ROUTES)) await scanOn(route, f);
      assert.equal(!!findRow(f, 'seed-row'), stillThere); assert.deepEqual(retiredEntries(f), []);
    });
  }

  routeTest('a row whose cached file is missing is repaired as before, then retired once provable', { timeout: 60000 }, async () => {
    const f = await seededProject(), row = seedRow(f); f.project().files.push(row); fs.rmSync(row.path);
    await scanOn('pre-package scan', f);
    assert.ok(findRow(f, 'seed-row'), 'the first scan keeps the row'); assert.ok(fs.existsSync(row.path), 'and restores its bytes'); assert.deepEqual(retiredEntries(f), []);
    await scanOn('pre-package scan', f);
    assert.equal(findRow(f, 'seed-row'), undefined); assert.deepEqual(retiredEntries(f).map(entry => entry.row.fileId), ['seed-row']);
  });

  routeTest('a kept row does not make its object add and retire outputs on every scan', { timeout: 60000 }, async () => {
    const f = await seededProject(), row = seedRow(f); fs.writeFileSync(row.path, plainDocument('modified-cache')); f.project().files.push(row);
    for (let scan = 0; scan < 4; scan++) await scanOn('pre-package scan', f);
    assert.deepEqual(retiredEntries(f), []);
    const copies = memberRows(f).filter(item => item.psdExtractionReceipt?.originalName === 'Smart.psb');
    assert.ok(copies.length <= 2, `${copies.length} rows`);
    assert.ok(cacheNames(f.id).filter(name => name.startsWith('Smart')).length <= 2);
  });

  routeTest('retirement is idempotent, survives a store round trip, and the record restores the identical row', { timeout: 60000 }, async () => {
    const f = await seededProject(), row = seedRow(f); f.project().files.push(row); await settled(f);
    const original = plain(findRow(f, 'seed-row'));
    await scanOn('pre-package scan', f); await scanOn('scan on open', f); await scanOn('save scan', f);
    assert.equal(retiredEntries(f).length, 1);
    storeInstance.data = JSON.parse(JSON.stringify(storeInstance.data));
    assert.deepEqual(plain(retiredEntries(f)[0].row), original);
    await scanOn('pre-package scan', f);
    assert.equal(retiredEntries(f).length, 1);
    const restored = plain(retiredEntries(f)[0].row);
    assert.deepEqual(restored, original);
    f.project().files.push(restored);
    assert.deepEqual(plain(findRow(f, 'seed-row')), original);
    await scanOn('pre-package scan', f);
    assert.equal(findRow(f, 'seed-row'), undefined); assert.equal(retiredEntries(f).length, 1, 'the same row is recorded once');
  });

  routeTest('a malformed record blocks retirement and is left alone', { timeout: 60000 }, async () => {
    const f = await seededProject(), row = seedRow(f); f.project().files.push(row); f.project().retiredEmbeddedDocuments = { version: 2 };
    await scanOn('pre-package scan', f);
    assert.ok(findRow(f, 'seed-row')); assert.deepEqual(plain(f.project().retiredEmbeddedDocuments), { version: 2 });
  });

  routeTest('a simple receipt hold on a retired row is released with its last member', { timeout: 60000 }, async () => {
    const f = await seededProject(), row = seedRow(f); f.project().files.push(row);
    f.project().workingSourceRelationshipHolds = [{ reason: 'psd-extraction-receipt-unverified', sourcePath: row.path }];
    await scanOn('pre-package scan', f);
    assert.equal(findRow(f, 'seed-row'), undefined); assert.deepEqual(f.project().workingSourceRelationshipHolds, []);
  });

  for (const route of Object.keys(ROUTES)) {
    routeTest(`${route}: an excluded object gets no new row or export after its bytes change`, { timeout: 60000 }, async () => {
      const f = await seededProject(), row = seedRow(f); f.project().files.push(row); f.project().excludedAssetKeys = [row.fileId];
      row.individualContentExclusion = `${f.smart.length}:${sha(f.smart)}`; await settled(f);
      const before = plain(findRow(f, 'seed-row')), cacheBefore = fs.readFileSync(row.path);
      f.rewrite(plainDocument('edited-after-exclusion'), 'edited-parent');
      await scanOn(route, f);
      assert.deepEqual(plain(findRow(f, 'seed-row')), before);
      assert.equal(memberRows(f).filter(item => item.embeddedOriginalName === 'Smart.psb' || item.psdExtractionReceipt?.originalName === 'Smart.psb' || item.psdResource?.originalName === 'Smart.psb').length, 1);
      assert.deepEqual(cacheNames(f.id).filter(name => name.startsWith('Smart')), ['Smart.psb']);
      assert.ok(fs.readFileSync(row.path).equals(cacheBefore));
      assert.equal(f.project().workingSourceRelationshipHolds ?? null, null);
      const review = await callIpcRaw('projects:prepare-package-review', f.id);
      assert.equal(review?.error, undefined, serialize(review).slice(0, 200));
    });
  }

  routeTest('an object with an Include row keeps its complete handling when its bytes change', { timeout: 60000 }, async () => {
    const f = await seededProject(), row = seedRow(f); row.keptAfterSourceExclusion = true; f.project().files.push(row);
    const edited = plainDocument('edited-after-include');
    f.rewrite(edited, 'edited-parent');
    await scanOn('pre-package scan', f);
    assert.ok(findRow(f, 'seed-row'));
    assert.ok(memberRows(f).some(item => item.psdExtractionReceipt?.outputDigest === sha(edited)), 'a replacement output exists');
    assert.ok(cacheNames(f.id).length >= 2);
  });

  routeTest('an object with both an excluded and a kept row keeps its complete handling', { timeout: 60000 }, async () => {
    const f = await seededProject();
    const excluded = seedRow(f), kept = seedRow(f, { name: 'Smart Copy.psb', fileId: 'kept-row' });
    kept.psdExtractionReceipt.originalName = 'Smart.psb'; kept.keptAfterSourceExclusion = true;
    f.project().files.push(excluded, kept); f.project().excludedAssetKeys = [excluded.fileId];
    const edited = plainDocument('edited-both'); f.rewrite(edited, 'edited-parent');
    await scanOn('pre-package scan', f);
    assert.ok(findRow(f, 'seed-row')); assert.ok(findRow(f, 'kept-row'));
    assert.ok(memberRows(f).some(item => item.psdExtractionReceipt?.outputDigest === sha(edited)));
  });

  routeTest('objects keep their names and indexes when a proven object before them is skipped', { timeout: 60000 }, async () => {
    const f = await seededProject();
    const open = documentHolding([external('out.png', '/Users/synthetic/out.png')]), openId = psdFixtures.guid('open');
    fs.writeFileSync(f.psd, parentPsd([{ ...embedded('Same.psb', f.smart), id: f.smartId }, { ...embedded('Same.psb', open), id: openId }], 'names'));
    await scanOn('pre-package scan', f);
    const rows = memberRows(f).filter(row => row.source === 'psd-embedded');
    assert.deepEqual(rows.map(row => [row.name, row.psdExtractionReceipt.linkedIndex, row.psdExtractionReceipt.originalName]), [['Same_1.psb', 1, 'Same.psb']]);
    assert.deepEqual(cacheNames(f.id), ['Same_1.psb']);
  });

  // --- Engaged working-source route (worker scan) ---------------------------
  async function engagedProject() {
    const f = await seededProject('Engaged'); f.project().workingSourceSelections = {};
    const scan = () => metadataTestHooks.runScanOnOpen(f.id, f.psd, null, null, { allowPausedBaseline: true, establishBaseline: false });
    f.scan = async () => { metadataTestHooks.clearPsdParseDebounce(); const result = await scan(); assert.equal(result?.success, true, serialize(result)); };
    f.record = () => Object.values(f.project().workingSourceVerification || {})[0];
    return f;
  }
  routeTest('engaged route: proven objects get no output and non-proven objects keep theirs', { timeout: 60000 }, async () => {
    const f = await engagedProject(); await f.scan();
    assert.deepEqual(memberRows(f).filter(row => row.source === 'psd-embedded').map(row => row.name), ['Texture.png']);
    assert.deepEqual(cacheNames(f.id), ['Texture.png']);
    assert.deepEqual(f.record().requiredEmbeddedOutputs.map(output => path.basename(output.path)), ['Texture.png']);
    assert.equal(f.project().workingSourceRelationshipHolds?.length || 0, 0);
    const pngRow = memberRows(f).find(row => row.name === 'Texture.png');
    assert.equal(pngRow.psdResource.linkedIndex, 1, 'the later object keeps its index');
  });
  routeTest('engaged route: a stored record naming a retired row is replaced by the same scan', { timeout: 60000 }, async () => {
    const f = await engagedProject(); await f.scan();
    const row = seedRow(f, { field: 'psdResource' }); f.project().files.push(row);
    const record = f.record();
    record.requiredEmbeddedOutputs.push({ path: row.path, sourceDigest: record.sourceFingerprint, outputDigest: sha(f.smart) });
    await f.scan();
    assert.equal(findRow(f, 'seed-row'), undefined); assert.deepEqual(retiredEntries(f).map(entry => entry.row.fileId), ['seed-row']);
    assert.deepEqual(f.record().requiredEmbeddedOutputs.map(output => path.basename(output.path)), ['Texture.png']);
    assert.equal(f.project().workingSourceRelationshipHolds?.length || 0, 0);
    assert.equal((await callIpcRaw('projects:prepare-package-review', f.id))?.error, undefined);
  });
  routeTest('engaged route: an excluded resource row stays and raises no hold after its bytes change', { timeout: 60000 }, async () => {
    const f = await engagedProject(); await f.scan();
    const row = seedRow(f, { field: 'psdResource' }); f.project().files.push(row); f.project().excludedAssetKeys = [row.fileId]; await settled(f);
    const before = plain(findRow(f, 'seed-row')); f.rewrite(plainDocument('engaged-edit'), 'engaged-parent');
    await f.scan();
    assert.deepEqual(plain(findRow(f, 'seed-row')), before);
    assert.equal(f.project().workingSourceRelationshipHolds?.length || 0, 0);
    assert.equal((await callIpcRaw('projects:prepare-package-review', f.id))?.error, undefined);
  });
  routeTest('engaged route: a logical row of a proven object raises no legacy hold', { timeout: 60000 }, async () => {
    const f = await engagedProject(); await f.scan();
    f.project().files.push(logicalRow(f));
    await f.scan();
    assert.equal(findRow(f, 'logical-row'), undefined);
    assert.equal(f.project().workingSourceRelationshipHolds?.length || 0, 0);
  });

  // --- Scans that stop being current ----------------------------------------
  function holdRead(file) {
    const real = fs.promises.readFile; let reached, release;
    const started = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
    fs.promises.readFile = async function (target, ...args) { if (target === file) { reached(); fs.promises.readFile = real; await gate; } return real.call(this, target, ...args); };
    return { started, release, restore() { fs.promises.readFile = real; release(); } };
  }
  async function watchingSeed() {
    const f = await seededProject('Watching'); const row = seedRow(f); f.project().files.push(row);
    await callIpcRaw('projects:start-watching', f.id); await idle(f.id);
    // Starting Watch may already scan; put the row back for the scan under test.
    if (!findRow(f, 'seed-row')) { f.project().files.push(plain(row)); delete f.project().retiredEmbeddedDocuments; }
    return f;
  }
  const INTERRUPTIONS = {
    'a pause': f => callIpcRaw('projects:pause', f.id),
    'a switch to another project': async () => { const other = await createProject('Other'); clearTrackedTimers(); return other; },
    'an account change': async () => { await testAccountSession.logout(); await testAccountSession.restore(); },
    'an expired session': async () => { testAccountSession.invalidate(); await testAccountSession.restore(); },
  };
  for (const [route, run] of [
    ['scan on open', f => metadataTestHooks.runScanOnOpen(f.id, f.psd, token(f.id), null, { establishBaseline: false })],
    ['save scan', f => metadataTestHooks.runScanOnSave(f.id, f.psd, token(f.id))],
  ]) for (const [label, interrupt] of Object.entries(INTERRUPTIONS)) {
    routeTest(`${route}: ${label} mid-scan publishes and retires nothing`, { timeout: 60000 }, async () => {
      const f = await watchingSeed(), hold = holdRead(f.psd); metadataTestHooks.clearPsdParseDebounce();
      try {
        const scan = Promise.resolve(run(f)).catch(() => null); await hold.started;
        await interrupt(f); hold.release(); await scan; await idle(f.id).catch(() => {});
        assert.ok(findRow(f, 'seed-row')); assert.deepEqual(retiredEntries(f), []);
        assert.equal(memberRows(f).some(row => row.name === 'Texture.png'), false);
      } finally { hold.restore(); await callIpcRaw('projects:delete-all'); clearTrackedTimers(); }
    });
  }
  routeTest('pre-package scan: an account change mid-scan publishes and retires nothing', { timeout: 60000 }, async () => {
    const f = await seededProject('Account'), row = seedRow(f); f.project().files.push(row);
    const hold = holdRead(f.psd); metadataTestHooks.clearPsdParseDebounce();
    try {
      const scan = callIpcRaw('projects:pre-package-scan', f.id).catch(error => ({ error: error.message }));
      await hold.started; await testAccountSession.logout(); await testAccountSession.restore(); hold.release(); await scan;
      assert.ok(findRow(f, 'seed-row')); assert.deepEqual(retiredEntries(f), []);
    } finally { hold.restore(); }
  });
  routeTest('overlapping scans retire a row once', { timeout: 60000 }, async () => {
    const f = await seededProject('Overlap'), row = seedRow(f); f.project().files.push(row); metadataTestHooks.clearPsdParseDebounce();
    await Promise.all([ROUTES['pre-package scan'](f), ROUTES['scan on open'](f), ROUTES['save scan'](f)]);
    assert.equal(findRow(f, 'seed-row'), undefined); assert.deepEqual(retiredEntries(f).map(entry => entry.row.fileId), ['seed-row']);
  });

  // --- The record belongs to its project -------------------------------------
  routeTest('the record is removed with its project and never reaches another project or the renderer', { timeout: 60000 }, async () => {
    const f = await seededProject('Private'), row = seedRow(f); f.project().files.push(row);
    await scanOn('pre-package scan', f); assert.equal(retiredEntries(f).length, 1);
    const other = await createProject('Other project'); clearTrackedTimers(); await callIpcRaw('projects:pause', other.id); await idle(other.id);
    assert.equal(stored(other.id).retiredEmbeddedDocuments, undefined);
    const answers = [await callIpcRaw('projects:get-all'), await callIpcRaw('projects:pause', f.id), await callIpcRaw('projects:get-files', f.id), await callIpcRaw('projects:get-asset-workspace', f.id)];
    for (const answer of answers) assert.equal(leakIn(serialize(answer)), null);
    assert.equal((await callIpcRaw('projects:delete', f.id)).some(project => project.id === f.id), false);
    assert.equal(serialize(storeInstance.data.projects).includes('retiredEmbeddedDocuments'), false);
    const g = await seededProject('Private 2'), again = seedRow(g); g.project().files.push(again); await scanOn('pre-package scan', g);
    assert.equal(retiredEntries(g).length, 1);
    await callIpcRaw('projects:delete-all');
    assert.deepEqual(storeInstance.data.projects, []);
  });
}
