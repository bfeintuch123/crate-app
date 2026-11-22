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
const { DEFAULT_BINARY_PATH } = require('../parsers/native-helper');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const psdWorkerPath = path.join(__dirname, '..', 'parsers', 'add-files-psd-worker.js');
const regexWorkerPath = path.join(__dirname, '..', 'parsers', 'add-files-regex-worker.js');
const hasNativeBinary = fs.existsSync(DEFAULT_BINARY_PATH);

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
    const nameBuf = Buffer.from(entry.name, 'utf8');
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
