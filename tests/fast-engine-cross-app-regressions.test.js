'use strict';

const test = require('node:test');
const assert = require('./bounded-assert');
const { fork } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');

const agPsd = require('ag-psd');
const { createAddFilesScanLease } = require('../parsers/add-files-operation');
const { startAddFilesPsdWorker } = require('../parsers/add-files-psd-worker');
const { startAddFilesRegexWorker } = require('../parsers/add-files-regex-worker');
const { normalizePsdExternalPath } = require('../parsers/xml-path');
const { CrateSqliteStore } = require('../parsers/sqlite-store');
const { AIParser } = require('../parsers/ai');
const { InDesignParser } = require('../parsers/indesign');
const { PowerPointParser } = require('../parsers/powerpoint');
const { packageMasterFile } = require('../parsers/index');
const { DEFAULT_BINARY_PATH, nativeHelper } = require('../parsers/native-helper');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const psdWorkerPath = path.join(__dirname, '..', 'parsers', 'add-files-psd-worker.js');
const regexWorkerPath = path.join(__dirname, '..', 'parsers', 'add-files-regex-worker.js');
const hasNativeBinary = nativeHelper.isAvailable();

function sliceMain(start, end) {
  const a = mainSource.indexOf(start);
  const b = mainSource.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Missing main.js section ${start} -> ${end}`);
  return mainSource.slice(a, b);
}

// Build a minimal ZIP archive buffer in memory (stored or deflate) for synthetic
// .idml, .pptx, and .key fixtures without spawning external tools.
function buildSyntheticZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name, 'utf8');
    const rawData = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const method = entry.deflate ? 8 : 0;
    const compData = method === 8 ? zlib.deflateRawSync(rawData) : rawData;
    const crc = zlib.crc32(rawData) >>> 0;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compData.length, 18);
    local.writeUInt32LE(rawData.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compData.length, 20);
    central.writeUInt32LE(rawData.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    localParts.push(local, compData);
    centralParts.push(central);
    offset += local.length + compData.length;
  }
  const cdBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, cdBuf, eocd]);
}

function createPsdTransactionHarness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-fe-psd-tx-'));
  const children = new Set();
  const finishes = [];
  const productionCode = [
    'function normalizeTrackedFilePath(p) { return typeof p === "string" ? path.normalize(p) : ""; }',
    sliceMain('function collectWorkingSourceScanEvidence(', 'function publishWorkingSourceScan('),
    sliceMain('function sanitizeEmbeddedPsdAssetName(', 'function getEmbeddedPsdDedupKey('),
    sliceMain('function cacheSafetyError(', 'function ensureSafeCacheSegment('),
    sliceMain('function safeCacheTempPath(', 'function openVerifiedCacheFileSync('),
    sliceMain('function getAddFilesSourceIdentity(', 'async function assertDependableAssetBaselineSource('),
    sliceMain('async function getAddFilesCurrentSourceDigest(', '\n/**'),
  ].join('\n');

  const context = {
    fs,
    path,
    os: { tmpdir: () => root },
    crypto,
    process,
    Buffer,
    Uint8Array,
    ArrayBuffer,
    setImmediate,
    setTimeout,
    clearTimeout,
    console,
    fontHandoff: require('../parsers/font-handoff'),
    normalizePsdExternalPath,
    MAX_PARSE_FILE_SIZE: 300 * 1024 * 1024,
    OWNER_ONLY_FILE_MODE: 0o600,
    ADD_FILES_PSD_WORKER_PATH: psdWorkerPath,
    ADD_FILES_REGEX_WORKER_PATH: regexWorkerPath,
    utilityProcess: {
      fork(modulePath) {
        const child = fork(modulePath, [], {
          serialization: 'advanced',
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        child.postMessage = message => child.send(message);
        child.on('message', message => {
          if (message && message.bytes) message.bytes = new Uint8Array(message.bytes);
        });
        children.add(child);
        child.once('exit', () => children.delete(child));
        return child;
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(productionCode, context);

  t.after(async () => {
    await context.disposeAddFilesWorkerPool?.();
    for (const child of children) {
      try { child.kill(); } catch (_) {}
    }
    await Promise.allSettled(finishes.map(fn => fn()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  let counter = 0;
  async function runPsdWorkerAndTransaction(psdPath, projectId = `proj-${counter++}`) {
    const lease = createAddFilesScanLease({ timeoutMs: 10_000 });
    const releaseSlot = await context.acquireAddFilesPsdTransferSlot(lease);
    const tx = context.createAddFilesPsdTransaction(projectId, lease, () => true, releaseSlot);
    finishes.push(() => tx.finish());
    const result = await context.runAddFilesPsdWorker(psdPath, lease, tx);
    return { result, tx, projectId, context };
  }

  return { root, context, runPsdWorkerAndTransaction };
}

function createCcPsdBuffer({ externalFullPath, embeddedBytes = null }) {
  const linkedId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const embeddedId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const children = [
    {
      name: 'Linked Photo',
      placedLayer: {
        id: linkedId,
        type: 'raster',
        transform: [0, 0, 1, 0, 1, 1, 0, 1],
        width: 1,
        height: 1,
      },
    },
  ];
  const linkedFiles = [
    {
      id: linkedId,
      name: 'external-photo.jpg',
      childDocumentID: '',
      linkedFile: {
        fileSize: 1234,
        name: 'external-photo.jpg',
        fullPath: externalFullPath,
        originalPath: externalFullPath,
        relativePath: 'external-photo.jpg',
      },
    },
  ];
  if (embeddedBytes) {
    children.push({
      name: 'Embedded Photo',
      placedLayer: {
        id: embeddedId,
        type: 'raster',
        transform: [0, 0, 1, 0, 1, 1, 0, 1],
        width: 1,
        height: 1,
      },
    });
    linkedFiles.push({
      id: embeddedId,
      name: 'embedded-photo.jpg',
      data: Buffer.from(embeddedBytes),
    });
  }
  return agPsd.writePsdBuffer({
    width: 4,
    height: 4,
    channels: 3,
    bitsPerChannel: 8,
    colorMode: 3,
    children,
    linkedFiles,
  });
}

test('Photoshop CC Project Package: file://// linked-only, mixed lnkE+lnk2, missing-external, and pooled worker reuse pass createAddFilesPsdTransaction', async t => {
  const { root, context, runPsdWorkerAndTransaction } = createPsdTransactionHarness(t);

  const assetDir = path.join(root, 'QA Assets');
  fs.mkdirSync(assetDir, { recursive: true });
  const existingJpg = path.join(assetDir, 'qa-external.jpg');
  fs.writeFileSync(existingJpg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
  const missingJpg = path.join(assetDir, 'qa-missing.jpg');

  // 1. Linked-only CC PSD (four-slash file://// URI with literal space + trailing NUL)
  const linkedOnlyPsd = path.join(root, 'Linked_Only_CC.psd');
  fs.writeFileSync(linkedOnlyPsd, createCcPsdBuffer({ externalFullPath: `file:///${existingJpg}\0` }));
  const r1 = await runPsdWorkerAndTransaction(linkedOnlyPsd, 'proj-linked');
  assert.equal(r1.result.linkedInventory.framing.parsedAgreement, true);
  assert.equal(r1.result.linkedInventory.unresolved.length, 0);
  assert.deepEqual(Array.from(r1.result.entries, e => normalizePsdExternalPath(e.filePath)), [existingJpg]);
  const ev1 = JSON.parse(JSON.stringify(context.collectWorkingSourceScanEvidence([], r1.result.linkedInventory)));
  assert.deepEqual(ev1.requiredReferences, [{ path: existingJpg }]);
  assert.deepEqual(ev1.unresolved, []);
  await r1.tx.finish();

  // 2. Mixed CC PSD (lnkE external + lnk2 embedded) reusing the pooled PSD worker
  const embeddedPayload = Buffer.from('synthetic-embedded-smart-object-jpeg-payload-20495');
  const mixedPsd = path.join(root, 'Mixed_CC.psd');
  fs.writeFileSync(mixedPsd, createCcPsdBuffer({
    externalFullPath: `file:///${existingJpg}\0`,
    embeddedBytes: embeddedPayload,
  }));
  const r2 = await runPsdWorkerAndTransaction(mixedPsd, 'proj-mixed');
  assert.equal(r2.result.linkedInventory.framing.parsedAgreement, true);
  assert.equal(r2.result.linkedInventory.unresolved.length, 0);
  const promoted = r2.tx.promote();
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].source, 'psd-embedded');
  assert.equal(promoted[0].outputDigest, crypto.createHash('sha256').update(embeddedPayload).digest('hex'));
  assert.deepEqual(fs.readFileSync(promoted[0].filePath), embeddedPayload);
  const ev2 = JSON.parse(JSON.stringify(context.collectWorkingSourceScanEvidence([], r2.result.linkedInventory)));
  assert.deepEqual(ev2.requiredReferences, [{ path: existingJpg }]);
  r2.tx.accept({ files: [{ path: promoted[0].filePath }], pendingFiles: [] });
  await r2.tx.finish();

  // 3. Missing-external CC PSD: transaction succeeds and records normalized missing link in requiredReferences
  const missingPsd = path.join(root, 'Missing_Link_CC.psd');
  fs.writeFileSync(missingPsd, createCcPsdBuffer({ externalFullPath: `file:///${missingJpg}\0` }));
  const r3 = await runPsdWorkerAndTransaction(missingPsd, 'proj-missing');
  assert.equal(r3.result.linkedInventory.framing.parsedAgreement, true);
  assert.equal(r3.result.linkedInventory.unresolved.length, 0);
  const ev3 = JSON.parse(JSON.stringify(context.collectWorkingSourceScanEvidence([], r3.result.linkedInventory)));
  assert.deepEqual(ev3.requiredReferences, [{ path: missingJpg }]);
  assert.equal(fs.existsSync(ev3.requiredReferences[0].path), false);
  await r3.tx.finish();
});

test('SQLite stat-cache: main.js uses unified raster-thumbnail namespace and project delete clears persisted thumbnails', () => {
  assert.match(mainSource, /const RASTER_THUMBNAIL_STAT_CACHE_NAMESPACE = 'raster-thumbnail';/);
  assert.doesNotMatch(mainSource, /clearStatCache\?\.\('raster-thumb'\)/);
  assert.match(mainSource, /clearStatCache\?\.\(RASTER_THUMBNAIL_STAT_CACHE_NAMESPACE\)/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-fe-statcache-'));
  try {
    const realDir = fs.realpathSync.native(dir);
    const sample = path.join(realDir, 'thumb.png');
    fs.writeFileSync(sample, Buffer.from([137, 80, 78, 71]));
    const st = fs.statSync(sample);
    const store = new CrateSqliteStore({ userDataRealPath: realDir });
    try {
      store.setStatCache('raster-thumbnail', sample, st, { dataUrl: 'data:image/png;base64,AA==' });
      store.setStatCache('font-inspect', sample, st, { sha256: 'abc' });
      assert.deepEqual(store.getStatCache('raster-thumbnail', sample, st), { dataUrl: 'data:image/png;base64,AA==' });
      store.clearStatCache('raster-thumbnail');
      assert.equal(store.getStatCache('raster-thumbnail', sample, st), null);
      assert.deepEqual(store.getStatCache('font-inspect', sample, st), { sha256: 'abc' });
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Illustrator (.ai): pooled regex worker reuse and native Swift PdfAiParser compressed/XMP entity parity', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-fe-ai-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const ai1 = path.join(dir, 'one.ai');
  const ai2 = path.join(dir, 'two.ai');
  const badAi = path.join(dir, 'corrupt.ai');
  fs.writeFileSync(ai1, '%PDF-1.6\n(/Users/synthetic/Studio/brand-logo.jpg)\n%%EOF\n');
  fs.writeFileSync(ai2, '%PDF-1.6\n(/Volumes/Shared/Hero Banner.png)\n%%EOF\n');
  fs.writeFileSync(badAi, 'NOT A PDF HEADER\n');

  // 1. Pooled regex worker across two valid .ai files (reusing one worker instance)
  const port = new EventEmitter();
  const outbound = [];
  let exits = 0;
  port.postMessage = msg => outbound.push(msg);
  startAddFilesRegexWorker(port, { exit: () => { exits += 1; }, idleTimeoutMs: 60_000 });

  port.emit('message', { data: { type: 'parse', filePath: ai1, pooled: true, requestId: 1 } });
  port.emit('message', { data: { type: 'parse', filePath: ai2, pooled: true, requestId: 2 } });
  assert.equal(outbound.length, 2);
  assert.equal(outbound[0].type, 'result');
  assert.equal(outbound[0].keepAlive, true);
  assert.deepEqual(outbound[0].result.paths, ['/Users/synthetic/Studio/brand-logo.jpg']);
  assert.equal(outbound[1].type, 'result');
  assert.equal(outbound[1].keepAlive, true);
  assert.deepEqual(outbound[1].result.paths, ['/Volumes/Shared/Hero Banner.png']);
  assert.equal(exits, 0);

  // Invalid PDF/AI structure still fails closed
  port.emit('message', { data: { type: 'parse', filePath: badAi, pooled: true, requestId: 3 } });
  assert.equal(outbound[2].type, 'error');
  assert.equal(outbound[2].error, 'asset_baseline_source_invalid_structure');

  // 2. Native AIParser with FlateDecode compressed stream + numeric XMP entities
  if (hasNativeBinary) {
    const compressedPayload = zlib.deflateSync(
      Buffer.from('<stRef:filePath>file:///Users/synthetic/A&#38;B&#x20;Studio/slide&#x27;s.jpg</stRef:filePath>')
    );
    const compressedAi = path.join(dir, 'compressed.ai');
    fs.writeFileSync(
      compressedAi,
      Buffer.concat([
        Buffer.from('%PDF-1.6\n1 0 obj\n<< /Filter /FlateDecode /Length ' + compressedPayload.length + ' >>\nstream\n'),
        compressedPayload,
        Buffer.from('\nendstream\nendobj\n%%EOF\n'),
      ])
    );
    const extracted = await new AIParser().extractAssets(compressedAi);
    assert.ok(extracted.some(a => a.path === "/Users/synthetic/A&B Studio/slide's.jpg"));
  }
});

test('InDesign (.idml & .indd): in-process ZIP reader decodes XML entities and rejects non-local URIs', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-fe-indd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const idmlPath = path.join(dir, 'layout.idml');
  const spreadXml = [
    '<Spread>',
    '  <Link LinkResourceURI="file:///Users/synthetic/R&amp;D/hero%20shot.jpg" />',
    '  <Link LinkResourceURI="file:/Users/synthetic/Team&#38;Co/mark.png" />',
    '  <Link LinkResourceURI="file://evil-host/Users/synthetic/blocked.jpg" />',
    '  <Link LinkResourceURI="file:/%2FUsers/synthetic/smuggled.jpg" />',
    '</Spread>',
  ].join('\n');
  fs.writeFileSync(idmlPath, buildSyntheticZip([
    { name: 'mimetype', data: 'application/vnd.adobe.indesign-idml-package', deflate: false },
    { name: 'Spreads/Spread_u1.xml', data: spreadXml, deflate: true },
  ]));

  const idmlAssets = await new InDesignParser().extractAssets(idmlPath);
  const idmlPaths = idmlAssets.map(a => a.path).sort();
  assert.deepEqual(idmlPaths, [
    '/Users/synthetic/R&D/hero shot.jpg',
    '/Users/synthetic/Team&Co/mark.png',
  ]);

  const inddPath = path.join(dir, 'layout.indd');
  fs.writeFileSync(inddPath, Buffer.from('INDD\x00/Users/synthetic/Print/cover.tif\x00'));
  const inddAssets = await new InDesignParser().extractAssets(inddPath);
  assert.deepEqual(inddAssets.map(a => a.path), ['/Users/synthetic/Print/cover.tif']);
});

test('PowerPoint (.pptx) & Keynote (.key): in-process ZIP reader + OOXML external link rewrite + embedded extraction', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-fe-pres-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const externalImg = path.join(dir, 'linked-chart.png');
  const pngPayload = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(600, 0x42)]);
  fs.writeFileSync(externalImg, pngPayload);

  const pptxPath = path.join(dir, 'deck.pptx');
  const slideRels = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    `  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="file://${encodeURI(externalImg)}" TargetMode="External"/>`,
    '  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/embedded1.png"/>',
    '</Relationships>',
  ].join('\n');
  fs.writeFileSync(pptxPath, buildSyntheticZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>', deflate: true },
    { name: 'ppt/slides/_rels/slide1.xml.rels', data: slideRels, deflate: true },
    { name: 'ppt/media/embedded1.png', data: pngPayload, deflate: true },
  ]));

  const pptxAssets = await new PowerPointParser().extractAssets(pptxPath);
  assert.ok(pptxAssets.some(a => a.source === 'pptx-linked' && a.path === externalImg && a.exists === true));
  assert.ok(pptxAssets.some(a => a.source === 'pptx-embedded' && a.zipPath === 'ppt/media/embedded1.png'));

  // Quick Package rewrites OOXML external link and extracts embedded media cleanly
  const outDir = path.join(dir, 'pptx-pkg');
  const pkg = await packageMasterFile(pptxPath, outDir);
  assert.equal(pkg.assetsMissing.length, 0);
  assert.ok(pkg.files.some(f => f.source === 'pptx-linked' && fs.existsSync(f.copied)));
  assert.ok(pkg.files.some(f => f.source === 'embedded' && fs.existsSync(f.copied)));

  // Keynote (.key) embedded media via in-process ZIP reader
  const keyPath = path.join(dir, 'pitch.key');
  const jpgPayload = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 0x11), Buffer.from([0xff, 0xd9])]);
  fs.writeFileSync(keyPath, buildSyntheticZip([
    { name: 'Index/Document.iwa', data: Buffer.from([1, 2, 3, 4]), deflate: true },
    { name: 'Data/slide-hero-1234.jpg', data: jpgPayload, deflate: false },
  ]));
  const keyAssets = await new PowerPointParser().extractAssets(keyPath);
  assert.equal(keyAssets.length, 1);
  assert.equal(keyAssets[0].source, 'keynote-embedded');
  assert.equal(keyAssets[0].zipPath, 'Data/slide-hero-1234.jpg');
});

test('main.js structural guards: denied second instance skips store & ready init, thumbnail write checks cache generation, in-scan cache is byte-bounded with transient tooLarge read', () => {
  // 1. Denied second instance (!gotLock) must not open/migrate SQLite/electron-store or run whenReady startup
  const lockBlock = sliceMain('const gotLock = app.requestSingleInstanceLock();', '// One-time migration:');
  assert.ok(lockBlock.includes('if (gotLock) {'), 'store initialization must be guarded by if (gotLock)');
  const readyBlock = sliceMain('app.whenReady().then(async () => {', 'if (localStoreStartupError)');
  assert.ok(readyBlock.includes('if (!gotLock) return;'), 'whenReady handler must bail early when !gotLock');

  // 2. Thumbnail write-back must check cache generation and account guard right before cache publication
  const thumbBlock = sliceMain('function getBoundedRasterThumbnail(', 'function getProjectOwnedFileVisualRequestError(');
  assert.ok(thumbBlock.includes('rasterThumbnailCacheGeneration !== capturedCacheGeneration'));
  assert.ok(thumbBlock.includes('if (encoded && canPublishThumbnail())'));

  // 3. Pre-package in-scan file cache enforces total byte budget while preserving transient uncached tooLarge scan
  const cacheBlock = sliceMain('const IN_SCAN_FILE_CACHE_MAX_BYTES =', 'const ordinaryPsdOutputBatches =');
  assert.ok(cacheBlock.includes('IN_SCAN_FILE_CACHE_MAX_BYTES'));
  assert.ok(cacheBlock.includes("return { tooLarge: true }"));
  const regexBlock = sliceMain('const regexScanStartedAt = Date.now();', 'const regexScanElapsedMs =');
  assert.ok(regexBlock.includes('if (cachedFile && cachedFile.tooLarge)'));
  assert.ok(regexBlock.includes('const transientBuf = await fs.promises.readFile(designFile.path);'));
});

test('main.js behavioral inScanFileCache: enforces LRU byte budget and propagates tooLarge without caching (A-P1-4 / Opus B3)', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-inscan-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f1 = path.join(dir, 'a.ai');
  const f2 = path.join(dir, 'b.ai');
  const f3 = path.join(dir, 'big.psd');
  fs.writeFileSync(f1, Buffer.alloc(60, 0x41));
  fs.writeFileSync(f2, Buffer.alloc(60, 0x42));
  fs.writeFileSync(f3, Buffer.alloc(120, 0x43));

  const helperSlice = sliceMain('const rememberInScanFileEntry = (key, entry) => {', 'const ordinaryPsdOutputBatches =');
  const cacheCode = [
    'const IN_SCAN_FILE_CACHE_MAX_BYTES = 100;',
    'const MAX_PARSE_FILE_SIZE = 100;',
    'const inScanFileCache = new Map();',
    'let inScanFileCacheBytes = 0;',
    helperSlice,
    'function runGetInScanFileEntry(p) { return getInScanFileEntry(p); }',
    'function getCacheSummary() { return { keys: [...inScanFileCache.keys()], bytes: inScanFileCacheBytes }; }',
  ].join('\n');

  const ctx = {
    fs,
    Map,
    BigInt,
    normalizeTrackedFilePath: p => p,
  };
  vm.runInNewContext(cacheCode, ctx);

  const e1 = await ctx.runGetInScanFileEntry(f1);
  assert.equal(e1.buf.length, 60);
  assert.equal(ctx.getCacheSummary().bytes, 60);

  // Adding 60B f2 evicts 60B f1 so total stays <= 100B
  const e2 = await ctx.runGetInScanFileEntry(f2);
  assert.equal(e2.buf.length, 60);
  assert.deepEqual([...ctx.getCacheSummary().keys], [f2]);
  assert.equal(ctx.getCacheSummary().bytes, 60);

  // Oversized 120B f3 returns { tooLarge: true } and does not evict or enter cache
  const e3 = await ctx.runGetInScanFileEntry(f3);
  assert.equal(e3.tooLarge, true);
  assert.deepEqual([...ctx.getCacheSummary().keys], [f2]);
  assert.equal(ctx.getCacheSummary().bytes, 60);
});

test('main.js behavioral fence: in-flight getBoundedRasterThumbnail independently fences authGuard, global generation, and per-project epoch (A-P2-3)', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-thumb-fence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const imgPath = path.join(dir, 'hero.png');
  fs.writeFileSync(imgPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  async function runScenario(invalidateFn, { expectPublished = false } = {}) {
    let resolveThumb;
    let notifyInFlight;
    const inFlightPromise = new Promise(resolve => { notifyInFlight = resolve; });
    const statCacheWrites = [];
    let authed = true;
    const thumbCode = [
      'const RASTER_THUMBNAIL_STAT_CACHE_NAMESPACE = "raster-thumbnail";',
      'const FILE_VISUAL_PIXEL_SIZE = 64;',
      'const FILE_VISUAL_MAX_RASTER_QUEUE = 8;',
      'const fileVisualProjectCache = new Map();',
      'const fileVisualProjectCacheEpochs = new Map();',
      'let fileVisualProjectCacheGeneration = 0;',
      'let fileVisualRasterWorkTail = Promise.resolve();',
      'let fileVisualRasterWorkPending = 0;',
      'const embeddedPsdReviewCache = new Map();',
      sliceMain('function getFileVisualProjectCacheEpoch(', 'function getCurrentFileVisualProjectCache('),
      sliceMain('function runSerializedFileVisualRasterWork(', 'function getProjectOwnedFileVisualRequestError('),
      'function getRasterThumbnailMemoryCacheSize() { return rasterThumbnailMemoryCache.size; }',
    ].join('\n');

    const ctx = {
      fs,
      path,
      accountSession: { canUseWorkspace: () => authed },
      store: {
        getStatCache: () => null,
        setStatCache: (...args) => { statCacheWrites.push(args); },
      },
      openPreflightedRasterSource: async p => {
        const handle = await fs.promises.open(p, 'r');
        const sourceStat = await handle.stat({ bigint: true });
        return { handle, sourceStat };
      },
      createProjectFileVisualRevisionFromStat: () => 'rev-1',
      sameOpenFileStat: () => true,
      createPrivateFileVisualSnapshot: async () => {
        const snapPath = path.join(dir, `snap-${Math.random().toString(16).slice(2)}.png`);
        fs.writeFileSync(snapPath, Buffer.from([137, 80, 78, 71]));
        const handle = await fs.promises.open(snapPath, 'r');
        const stat = await handle.stat({ bigint: true });
        return { path: snapPath, directory: dir, handle, stat };
      },
      assertPrivateFileVisualDirectory: async () => {},
      cleanupPrivateFileVisualSnapshot: async snap => {
        if (snap?.handle) try { await snap.handle.close(); } catch (_) {}
      },
      nativeImage: {
        createThumbnailFromPath: () => new Promise(resolve => {
          resolveThumb = resolve;
          notifyInFlight();
        }),
      },
      encodeBoundedFileVisual: () => 'data:image/png;base64,AAAA',
      Map,
      Promise,
      Math,
    };
    vm.runInNewContext(thumbCode, ctx);

    const authGuard = () => { if (!authed) throw new Error('logged_out'); };
    const pendingThumb = ctx.getBoundedRasterThumbnail('proj-1', { path: imgPath, ext: '.png' }, 'rev-1', authGuard);
    await inFlightPromise;
    invalidateFn({ ctx, setAuthed: v => { authed = v; } });
    resolveThumb({ fake: true });
    const result = await pendingThumb;
    if (expectPublished) {
      assert.equal(result, 'data:image/png;base64,AAAA');
      assert.equal(ctx.getRasterThumbnailMemoryCacheSize(), 1);
      assert.equal(statCacheWrites.length, 1);
    } else {
      assert.equal(result, null);
      assert.equal(ctx.getRasterThumbnailMemoryCacheSize(), 0);
      assert.equal(statCacheWrites.length, 0);
    }
  }

  // 0. Positive control: uninterrupted thumbnail publishes to memory + SQLite stat cache
  await runScenario(() => {}, { expectPublished: true });
  // 1. Auth guard alone (without clearing cache)
  await runScenario(({ setAuthed }) => setAuthed(false));
  // 2. Global cache generation alone (while still authorized)
  await runScenario(({ ctx }) => ctx.clearFileVisualProjectCache());
  // 3. Per-project cache epoch alone (while still authorized)
  await runScenario(({ ctx }) => ctx.clearFileVisualProjectCache('proj-1'));
});

test('main.js behavioral IPC coalescing: preserves valid caller over later stale token, emits unchanged-row refresh, drops on logout, omits full rows in Electron (G-P1 / A-P1-1 / N2)', async () => {
  const { ProjectIpcDeltaBridge } = require('../parsers/ipc-delta-bridge');
  const sendFnSource = sliceMain('function sendProjectFileStateToRenderer(', 'function projectWatchActivityTime(');

  const emitted = [];
  let authed = true;
  let accountEpoch = 1;
  let activeToken = 'tok-valid';
  const project = {
    id: 'proj-ipc',
    files: [{ path: '/Users/synthetic/a.jpg', name: 'a.jpg' }],
    pendingFiles: [{ path: '/Users/synthetic/p.png', name: 'p.png' }],
  };

  const bridge = new ProjectIpcDeltaBridge({ coalesceMs: 16 });
  const ctx = {
    projectIpcDeltaBridge: bridge,
    accountSession: { canUseWorkspace: () => authed },
    captureAccountAuthorization: () => {
      const capturedEpoch = accountEpoch;
      return () => {
        if (!authed || accountEpoch !== capturedEpoch) throw new Error('stale_account');
      };
    },
    isBoundWatchingActivationCurrent: (_projectId, token) => token === activeToken,
    getProjectByIdFast: id => (id === project.id ? project : null),
    syncAcceptedSourceWatchSubscriptions: () => {},
    getIllustratorScopedProjectView: p => ({ files: p.files, pendingFiles: p.pendingFiles }),
    sendToRenderer: (channel, payload) => { emitted.push({ channel, payload }); },
    process: { versions: { electron: '42.11.16' } },
  };
  vm.runInNewContext(sendFnSource, ctx);

  // 1. Valid caller followed immediately by a stale caller within the 16ms coalesce window
  ctx.sendProjectFileStateToRenderer('proj-ipc', 'tok-valid');
  ctx.sendProjectFileStateToRenderer('proj-ipc', 'tok-stale');
  await new Promise(resolve => setTimeout(resolve, 40));

  assert.equal(emitted.length, 2, 'must emit both files:updated and files:pending despite trailing stale caller');
  assert.equal(emitted[0].channel, 'files:updated');
  assert.equal(emitted[1].channel, 'files:pending');
  assert.equal(emitted[0].payload.files, undefined, 'Electron IPC payload must omit unused full files array');
  assert.equal(emitted[1].payload.pendingFiles, undefined, 'Electron IPC payload must omit unused full pendingFiles array');
  assert.deepEqual({ ...emitted[0].payload.counts }, { files: 1, pending: 1 });

  // 2. Unchanged rows still emit refresh notifications (N2)
  emitted.length = 0;
  ctx.sendProjectFileStateToRenderer('proj-ipc', 'tok-valid');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(emitted.length, 2, 'unchanged rows must not suppress renderer refresh');
  assert.equal(emitted[0].payload.revision, 2);

  // 3. Account logout / clearAll cancels pending coalesced notification before timer fires
  emitted.length = 0;
  ctx.sendProjectFileStateToRenderer('proj-ipc', 'tok-valid');
  authed = false;
  accountEpoch += 1;
  bridge.clearAll();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(emitted.length, 0, 'logout + clearAll must drop queued notifications');

  // 3b. Paired caller fence: Caller A (valid token, stale account) + Caller B (stale token, valid account)
  // must NOT cross-pair into an authorized emission (Fable paired-caller check).
  authed = true;
  emitted.length = 0;
  ctx.sendProjectFileStateToRenderer('proj-ipc', 'tok-valid'); // captured under epoch 2
  accountEpoch += 1; // invalidates Caller A's account
  ctx.sendProjectFileStateToRenderer('proj-ipc', 'tok-stale'); // captured under epoch 3, but stale token
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(emitted.length, 0, 'valid token from stale account must not pair with valid account from stale token');

  // 4. Non-Electron path: if activation becomes stale during files:updated send, pendingSnap must not advance
  authed = true;
  const nonElectronBridge = new ProjectIpcDeltaBridge({ coalesceMs: 0 });
  const nonElectronEmitted = [];
  let dropAfterFirstSend = true;
  const ctx2 = {
    projectIpcDeltaBridge: nonElectronBridge,
    accountSession: { canUseWorkspace: () => authed },
    captureAccountAuthorization: () => () => {},
    isBoundWatchingActivationCurrent: (_projectId, token) => token === activeToken,
    getProjectByIdFast: id => (id === project.id ? project : null),
    syncAcceptedSourceWatchSubscriptions: () => {},
    getIllustratorScopedProjectView: p => ({ files: p.files, pendingFiles: p.pendingFiles }),
    sendToRenderer: (channel, payload) => {
      nonElectronEmitted.push({ channel, payload });
      if (dropAfterFirstSend && channel === 'files:updated') {
        activeToken = 'tok-new';
      }
    },
    process: { versions: {} },
  };
  vm.runInNewContext(sendFnSource, ctx2);
  ctx2.sendProjectFileStateToRenderer('proj-ipc', 'tok-valid');
  assert.equal(nonElectronEmitted.length, 1, 'files:pending must be skipped once token becomes stale');
  assert.equal(nonElectronEmitted[0].channel, 'files:updated');
  assert.equal(nonElectronBridge.projectState.get('proj-ipc').pendingSnap, null, 'pendingSnap must not advance for unsent files:pending');

  // Next call with new valid token still sees pendingDelta.changed === true
  dropAfterFirstSend = false;
  nonElectronEmitted.length = 0;
  ctx2.sendProjectFileStateToRenderer('proj-ipc', 'tok-new');
  assert.equal(nonElectronEmitted.length, 2);
  assert.equal(nonElectronEmitted[1].channel, 'files:pending');
  assert.equal(nonElectronEmitted[1].payload.delta.changed, true);
});

test('Keynote (.key) & PPTX: safely reject colliding non-UTF-8 ZIP media entry names while preserving unambiguous legacy entries (A8)', async t => {
  const { openZipArchive } = require('../parsers/zip-reader');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-keynote-a8-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const imgA = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 0x41)]);
  const imgB = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 0x42)]);
  const imgValid = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 0x43)]);

  // 1. Two distinct non-UTF-8 member names that both lossily decode to Data/photo-\uFFFD.jpg
  const collidingKeyPath = path.join(dir, 'colliding-legacy.key');
  const nameA = Buffer.concat([Buffer.from('Data/photo-'), Buffer.from([0x80]), Buffer.from('.jpg')]);
  const nameB = Buffer.concat([Buffer.from('Data/photo-'), Buffer.from([0x81]), Buffer.from('.jpg')]);
  fs.writeFileSync(collidingKeyPath, buildSyntheticZip([
    { name: 'Data/valid-1001.jpg', data: imgValid },
    { name: nameA, data: imgA },
    { name: nameB, data: imgB },
  ]));

  const archive = openZipArchive(collidingKeyPath);
  t.after(() => archive && archive.close());
  assert.ok(archive);
  assert.equal(archive.hasAmbiguousPath('Data/photo-\uFFFD.jpg'), true);
  assert.equal(archive.findEntries('Data/photo-\uFFFD.jpg').every(e => e.nameValidUtf8 === false), true);

  const inspectionErrors = [];
  const parser = new PowerPointParser();
  const discovered = await parser.extractAssets(collidingKeyPath, {
    onInspectionError: err => inspectionErrors.push(err),
  });
  assert.equal(inspectionErrors.length, 1, 'ambiguous legacy Keynote entry names must report an inspection error');
  assert.deepEqual(discovered, [], 'must not return a silently truncated asset list');

  // Direct extractToDirectory with the collided decoded path must also refuse instead of extracting member A
  const extractOutDir = path.join(dir, 'out-colliding');
  fs.mkdirSync(extractOutDir, { recursive: true });
  const extractionErrors = [];
  const extracted = await parser.extractToDirectory(
    collidingKeyPath,
    extractOutDir,
    [{ path: 'photo-\uFFFD.jpg', source: 'keynote-embedded', exists: true, zipPath: 'Data/photo-\uFFFD.jpg', size: imgA.length }],
    { onExtractionError: err => extractionErrors.push(err) }
  );
  assert.equal(extractionErrors.length, 1, 'ambiguous direct extraction must report an extraction error');
  assert.deepEqual(extracted, []);
  assert.deepEqual(fs.readdirSync(extractOutDir), []);

  // Direct PPTX extraction with colliding non-UTF-8 media names must also refuse via hasAmbiguousPath
  const collidingPptxPath = path.join(dir, 'colliding-legacy.pptx');
  const pptNameA = Buffer.concat([Buffer.from('ppt/media/img-'), Buffer.from([0x80]), Buffer.from('.jpg')]);
  const pptNameB = Buffer.concat([Buffer.from('ppt/media/img-'), Buffer.from([0x81]), Buffer.from('.jpg')]);
  fs.writeFileSync(collidingPptxPath, buildSyntheticZip([
    { name: pptNameA, data: imgA },
    { name: pptNameB, data: imgB },
  ]));
  const pptOutDir = path.join(dir, 'out-colliding-pptx');
  fs.mkdirSync(pptOutDir, { recursive: true });
  const pptExtErrors = [];
  const pptExtracted = await parser.extractToDirectory(
    collidingPptxPath,
    pptOutDir,
    [{ path: 'img-\uFFFD.jpg', source: 'pptx-embedded', exists: true, zipPath: 'ppt/media/img-\uFFFD.jpg', size: imgA.length }],
    { onExtractionError: err => pptExtErrors.push(err) }
  );
  assert.equal(pptExtErrors.length, 1, 'ambiguous PPTX direct extraction must report an extraction error');
  assert.deepEqual(pptExtracted, []);
  assert.deepEqual(fs.readdirSync(pptOutDir), []);

  // 2. Unambiguous single non-UTF-8 legacy media name in Keynote is preserved and extracted cleanly
  const singleLegacyKeyPath = path.join(dir, 'single-legacy.key');
  const legacyName = Buffer.concat([Buffer.from('Data/caf'), Buffer.from([0x8e]), Buffer.from('-2001.jpg')]);
  fs.writeFileSync(singleLegacyKeyPath, buildSyntheticZip([{ name: legacyName, data: imgA }]));
  const singleErrors = [];
  const singleDiscovered = await parser.extractAssets(singleLegacyKeyPath, {
    onInspectionError: err => singleErrors.push(err),
  });
  assert.equal(singleErrors.length, 0);
  assert.equal(singleDiscovered.length, 1);
  const singleOutDir = path.join(dir, 'out-single-legacy');
  fs.mkdirSync(singleOutDir, { recursive: true });
  const singleExtErrors = [];
  const singleExtracted = await parser.extractToDirectory(singleLegacyKeyPath, singleOutDir, singleDiscovered, {
    onExtractionError: err => singleExtErrors.push(err),
  });
  assert.equal(singleExtErrors.length, 0);
  assert.equal(singleExtracted.length, 1);
  assert.deepEqual(fs.readFileSync(singleExtracted[0].extractedPath), imgA);

  // 3. Positive control: valid UTF-8 Keynote media (including non-ASCII UTF-8) extracts cleanly
  const validUtf8KeyPath = path.join(dir, 'valid-utf8.key');
  fs.writeFileSync(validUtf8KeyPath, buildSyntheticZip([
    { name: 'Data/caf\u00e9-3001.jpg', data: imgValid },
  ]));
  const validInspErrors = [];
  const validExtErrors = [];
  const validAssets = await parser.extractAssets(validUtf8KeyPath, {
    onInspectionError: err => validInspErrors.push(err),
  });
  assert.equal(validInspErrors.length, 0);
  assert.equal(validAssets.length, 1);
  const validOutDir = path.join(dir, 'out-valid');
  fs.mkdirSync(validOutDir, { recursive: true });
  const validExtracted = await parser.extractToDirectory(validUtf8KeyPath, validOutDir, validAssets, {
    onExtractionError: err => validExtErrors.push(err),
  });
  assert.equal(validExtErrors.length, 0);
  assert.equal(validExtracted.length, 1);
  assert.deepEqual(fs.readFileSync(validExtracted[0].extractedPath), imgValid);
});
