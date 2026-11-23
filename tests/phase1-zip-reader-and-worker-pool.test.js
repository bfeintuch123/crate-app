'use strict';

const assert = require('./bounded-assert');
const { execFileSync, fork } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const zlib = require('node:zlib');

const agPsd = require('ag-psd');
const { openZipArchive, computeCrc32 } = require('../parsers/zip-reader');
const { isParserAdmissionError } = require('../parsers/admission-budgets');
const { createAddFilesScanLease } = require('../parsers/add-files-operation');
const { startAddFilesRegexWorker } = require('../parsers/add-files-regex-worker');
const { startAddFilesPsdWorker } = require('../parsers/add-files-psd-worker');
const fontHandoff = require('../parsers/font-handoff');

function buildSyntheticZip(entries, { zip64 = false } = {}) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const item of entries) {
    const nameBytes = Buffer.isBuffer(item.nameBytes)
      ? item.nameBytes
      : Buffer.from(item.name, 'utf8');
    const rawData = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data, 'utf8');
    const method = item.method === 0 ? 0 : 8;
    const compressed = method === 0 ? rawData : zlib.deflateRawSync(rawData);
    const crc = item.corruptCrc ? ((computeCrc32(rawData) ^ 0xffffffff) >>> 0) : computeCrc32(rawData);
    const declaredUncompressed = item.declaredUncompressed ?? rawData.length;

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(item.flags ?? 0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(Math.min(declaredUncompressed, 0xffffffff), 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);

    let extra = Buffer.alloc(0);
    if (zip64) {
      extra = Buffer.alloc(4 + 24);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(declaredUncompressed), 4);
      extra.writeBigUInt64LE(BigInt(compressed.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }

    const central = Buffer.alloc(46 + nameBytes.length + extra.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(zip64 ? 45 : 20, 4);
    central.writeUInt16LE(zip64 ? 45 : 20, 6);
    central.writeUInt16LE(item.flags ?? 0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(zip64 ? 0xffffffff : compressed.length, 20);
    central.writeUInt32LE(zip64 ? 0xffffffff : declaredUncompressed, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    nameBytes.copy(central, 46);
    extra.copy(central, 46 + nameBytes.length);

    localParts.push(local, compressed);
    centralParts.push(central);
    offset += local.length + compressed.length;
  }

  const cd = Buffer.concat(centralParts);
  const parts = [...localParts, cd];
  if (zip64) {
    const zip64EocdOffset = offset + cd.length;
    const zip64Eocd = Buffer.alloc(56);
    zip64Eocd.writeUInt32LE(0x06064b50, 0);
    zip64Eocd.writeBigUInt64LE(44n, 4);
    zip64Eocd.writeUInt16LE(45, 12);
    zip64Eocd.writeUInt16LE(45, 14);
    zip64Eocd.writeUInt32LE(0, 16);
    zip64Eocd.writeUInt32LE(0, 20);
    zip64Eocd.writeBigUInt64LE(BigInt(entries.length), 24);
    zip64Eocd.writeBigUInt64LE(BigInt(entries.length), 32);
    zip64Eocd.writeBigUInt64LE(BigInt(cd.length), 40);
    zip64Eocd.writeBigUInt64LE(BigInt(offset), 48);

    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeUInt32LE(0, 4);
    locator.writeBigUInt64LE(BigInt(zip64EocdOffset), 8);
    locator.writeUInt32LE(1, 16);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0xffff, 4);
    eocd.writeUInt16LE(0xffff, 6);
    eocd.writeUInt16LE(0xffff, 8);
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(0xffffffff, 12);
    eocd.writeUInt32LE(0xffffffff, 16);
    parts.push(zip64Eocd, locator, eocd);
  } else {
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    parts.push(eocd);
  }
  return Buffer.concat(parts);
}

test('zip-reader: parses stored, deflated, and ZIP64 archives in-process and enforces budgets', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-zip-reader-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  for (const zip64 of [false, true]) {
    const zipPath = path.join(dir, zip64 ? 'zip64.zip' : 'standard.zip');
    fs.writeFileSync(zipPath, buildSyntheticZip([
      { name: 'stored.txt', data: 'hello stored world', method: 0 },
      { name: 'nested/deflated.xml', data: '<Link LinkResourceURI="file:///Users/synthetic/a.png"/>'.repeat(20), method: 8 },
    ], { zip64 }));

    const archive = openZipArchive(zipPath);
    assert.ok(archive);
    try {
      assert.equal(archive.entries.length, 2);
      assert.equal(archive.readEntry('stored.txt').toString('utf8'), 'hello stored world');
      assert.equal(
        archive.readEntry('nested/deflated.xml').toString('utf8'),
        '<Link LinkResourceURI="file:///Users/synthetic/a.png"/>'.repeat(20)
      );
    } finally {
      archive.close();
    }
  }

  // Zip bomb: small compressed deflate payload expanding beyond maxOutputBytes.
  const bombPath = path.join(dir, 'bomb.zip');
  fs.writeFileSync(bombPath, buildSyntheticZip([
    { name: 'bomb.xml', data: Buffer.alloc(128 * 1024, 65), method: 8, declaredUncompressed: 1024 },
  ]));
  const bombArchive = openZipArchive(bombPath);
  assert.ok(bombArchive);
  try {
    assert.throws(
      () => bombArchive.readEntry('bomb.xml', { maxOutputBytes: 4096, message: 'Safe admission error.' }),
      error => isParserAdmissionError(error) && error.message === 'Safe admission error.'
    );
  } finally {
    bombArchive.close();
  }

  // Corrupt CRC-32 fails closed.
  const corruptPath = path.join(dir, 'corrupt.zip');
  fs.writeFileSync(corruptPath, buildSyntheticZip([
    { name: 'bad.txt', data: 'payload', method: 8, corruptCrc: true },
  ]));
  const corruptArchive = openZipArchive(corruptPath);
  assert.ok(corruptArchive);
  try {
    assert.throws(() => corruptArchive.readEntry('bad.txt'), /zip_corrupt_entry/);
  } finally {
    corruptArchive.close();
  }

  // Symlink archive is rejected with ParserAdmissionError.
  const symlinkPath = path.join(dir, 'link.zip');
  fs.symlinkSync(path.join(dir, 'standard.zip'), symlinkPath);
  assert.throws(
    () => openZipArchive(symlinkPath, { message: 'No symlink.' }),
    error => isParserAdmissionError(error) && error.message === 'No symlink.'
  );
});

test('InDesignParser and PowerPointParser read real IDML/PPTX/KEY archives with zero /usr/bin/unzip spawns', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-no-unzip-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const linkedPath = path.join(dir, 'photo.png');
  fs.writeFileSync(linkedPath, 'synthetic-image-bytes');

  const idmlPath = path.join(dir, 'doc.idml');
  fs.writeFileSync(idmlPath, buildSyntheticZip([
    { name: 'Spreads/Spread_1.xml', data: `<Link LinkResourceURI="file://${encodeURI(linkedPath)}"/>`, method: 8 },
    { name: 'Spreads/Spread_2.xml', data: '<Link LinkResourceURI="file:///Users/synthetic/missing.jpg"/>', method: 0 },
  ]));

  const pptxPath = path.join(dir, 'deck.pptx');
  const NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
  const mediaA = Buffer.alloc(1024, 0x41);
  const mediaB = Buffer.alloc(1024, 0x42);
  fs.writeFileSync(pptxPath, buildSyntheticZip([
    { name: 'ppt/slides/_rels/slide1.xml.rels', data: `<?xml version="1.0"?><Relationships xmlns="${NS}"><Relationship Id="rId1" Type="${TYPE}" Target="file://${encodeURI(linkedPath)}" TargetMode="External"/></Relationships>`, method: 8 },
    { name: 'ppt/media/img1.png', data: mediaA, method: 8 },
    { name: 'ppt/media/img2.jpg', data: mediaB, method: 0 },
  ]));

  const keyPath = path.join(dir, 'slides.key');
  const keynoteBytes = Buffer.alloc(1200, 0x55);
  fs.writeFileSync(keyPath, buildSyntheticZip([
    {
      nameBytes: Buffer.concat([Buffer.from('Data/Slide '), Buffer.from([0x80, 0xff]), Buffer.from(' hero-9089.png')]),
      flags: 0,
      data: keynoteBytes,
      method: 8,
    },
    { name: 'Data/st-1234abcd-5678.jpeg', data: Buffer.alloc(1000, 0x11), method: 8 },
  ]));

  // Intercept child_process to prove zero /usr/bin/unzip calls happen on real ZIP archives.
  let unzipSpawns = 0;
  const childProcess = require('node:child_process');
  const origLoad = Module._load;
  const indesignPath = require.resolve('../parsers/indesign');
  const powerpointPath = require.resolve('../parsers/powerpoint');
  delete require.cache[indesignPath];
  delete require.cache[powerpointPath];
  Module._load = function patchedLoad(request, parent, ...rest) {
    if (request === 'child_process') {
      return {
        ...childProcess,
        execFile(...args) {
          unzipSpawns += 1;
          throw new Error(`Unexpected child_process.execFile call: ${args[0]}`);
        },
      };
    }
    return origLoad.call(this, request, parent, ...rest);
  };
  let InDesignParser;
  let PowerPointParser;
  try {
    ({ InDesignParser } = require('../parsers/indesign'));
    ({ PowerPointParser } = require('../parsers/powerpoint'));
  } finally {
    Module._load = origLoad;
    delete require.cache[indesignPath];
    delete require.cache[powerpointPath];
  }

  const idmlParser = new InDesignParser();
  idmlParser.isUserPath = () => true;
  const idmlAssets = await idmlParser.extractAssets(idmlPath);
  assert.equal(idmlAssets.length, 2);
  assert.equal(idmlAssets.some(a => a.path === linkedPath && a.exists === true), true);
  assert.equal(idmlAssets.some(a => a.path === '/Users/synthetic/missing.jpg' && a.exists === false), true);

  const pptParser = new PowerPointParser();
  const pptAssets = await pptParser.extractAssets(pptxPath);
  assert.equal(pptAssets.filter(a => a.source === 'pptx-linked').length, 1);
  assert.equal(pptAssets.filter(a => a.source === 'pptx-embedded').length, 2);
  const pptOut = path.join(dir, 'ppt-out');
  const pptExtracted = await pptParser.extractToDirectory(pptxPath, pptOut, pptAssets);
  assert.equal(pptExtracted.length, 2);
  assert.deepEqual(fs.readFileSync(pptExtracted[0].extractedPath), mediaA);
  assert.deepEqual(fs.readFileSync(pptExtracted[1].extractedPath), mediaB);

  const keyAssets = await pptParser.extractAssets(keyPath);
  assert.equal(keyAssets.length, 1);
  const keyOut = path.join(dir, 'key-out');
  const keyExtracted = await pptParser.extractToDirectory(keyPath, keyOut, keyAssets);
  assert.equal(keyExtracted.length, 1);
  assert.deepEqual(fs.readFileSync(keyExtracted[0].extractedPath), keynoteBytes);

  assert.equal(unzipSpawns, 0, 'Real ZIP IDML/PPTX/KEY must never spawn /usr/bin/unzip');
});

function loadMainWorkerPoolHarness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-worker-pool-'));
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  function section(start, end) {
    const a = main.indexOf(start);
    const b = main.indexOf(end, a + start.length);
    assert.ok(a >= 0 && b > a);
    return main.slice(a, b);
  }
  const production = [
    section('function sanitizeEmbeddedPsdAssetName(', 'function getEmbeddedPsdDedupKey('),
    section('function cacheSafetyError(', 'function ensureSafeCacheSegment('),
    section('function safeCacheTempPath(', 'function openVerifiedCacheFileSync('),
    section('function getAddFilesSourceIdentity(', 'async function assertDependableAssetBaselineSource('),
  ].join('\n');

  let forkCount = 0;
  const children = new Set();
  const context = {
    fs, path, os: { tmpdir: () => root }, crypto, process, Buffer, Uint8Array, ArrayBuffer,
    fontHandoff, setImmediate, setTimeout, clearTimeout, console,
    MAX_PARSE_FILE_SIZE: 300 * 1024 * 1024,
    OWNER_ONLY_FILE_MODE: 0o600,
    ADD_FILES_PSD_WORKER_PATH: path.join(__dirname, '..', 'parsers', 'add-files-psd-worker.js'),
    ADD_FILES_REGEX_WORKER_PATH: path.join(__dirname, '..', 'parsers', 'add-files-regex-worker.js'),
    utilityProcess: {
      fork(modulePath, args, opts) {
        forkCount += 1;
        const child = fork(modulePath, args || [], {
          cwd: opts?.cwd,
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
  vm.runInContext(production, context);
  t.after(async () => {
    await context.disposeAddFilesWorkerPool();
    for (const child of children) {
      try { child.kill(); } catch (_) {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, context, children, getForkCount: () => forkCount };
}

test('worker pool: reuses one regex worker across files, isolates errors, and disposes cleanly', async t => {
  const h = loadMainWorkerPoolHarness(t);
  const ai1 = path.join(h.root, 'one.ai');
  const ai2 = path.join(h.root, 'two.ai');
  const badAi = path.join(h.root, 'corrupt.ai');
  const ai3 = path.join(h.root, 'three.ai');
  fs.writeFileSync(ai1, '%PDF-1.7\n/Users/synthetic/a.png\n%%EOF\n');
  fs.writeFileSync(ai2, '%PDF-1.7\n/Users/synthetic/b.png\n%%EOF\n');
  fs.writeFileSync(badAi, 'not a pdf at all');
  fs.writeFileSync(ai3, '%PDF-1.7\n/Users/synthetic/c.png\n%%EOF\n');

  const runRegex = async filePath => {
    const lease = createAddFilesScanLease({ timeoutMs: 10000 });
    try {
      return await h.context.runAddFilesRegexWorker(filePath, lease);
    } finally {
      lease.dispose();
    }
  };

  const r1 = await runRegex(ai1);
  const r2 = await runRegex(ai2);
  assert.deepEqual(r1.paths, ['/Users/synthetic/a.png']);
  assert.deepEqual(r2.paths, ['/Users/synthetic/b.png']);
  assert.equal(h.getForkCount(), 1, 'second valid file must reuse the warm regex worker');
  assert.equal(h.children.size, 1);

  // An error retires the worker immediately; the next valid file forks a fresh one.
  await assert.rejects(() => runRegex(badAi), /invalid_structure/);
  const r3 = await runRegex(ai3);
  assert.deepEqual(r3.paths, ['/Users/synthetic/c.png']);
  assert.equal(h.getForkCount(), 2, 'error must retire previous worker and fork a clean replacement');

  await h.context.disposeAddFilesWorkerPool();
  assert.equal(h.children.size, 0);
});

test('worker pool: reuses one PSD worker across sequential PSDs and disposes cleanly', async t => {
  const h = loadMainWorkerPoolHarness(t);
  const makePsd = (name, linked, embeddedBytes) => {
    const filePath = path.join(h.root, name);
    fs.writeFileSync(filePath, agPsd.writePsdBuffer({
      width: 2,
      height: 2,
      channels: 3,
      bitsPerChannel: 8,
      colorMode: 3,
      linkedFiles: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          name: path.basename(linked),
          childDocumentID: '',
          linkedFile: { fileSize: 10, name: path.basename(linked), fullPath: linked, originalPath: linked, relativePath: '' },
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          name: 'embed.png',
          data: Buffer.from(embeddedBytes),
        },
      ],
    }));
    return filePath;
  };

  const p1 = makePsd('first.psd', '/Users/synthetic/one.png', 'first-embedded-bytes');
  const p2 = makePsd('second.psd', '/Users/synthetic/two.png', 'second-embedded-bytes');

  for (const [idx, psdPath, expectedLinked, expectedBytes] of [
    [1, p1, '/Users/synthetic/one.png', 'first-embedded-bytes'],
    [2, p2, '/Users/synthetic/two.png', 'second-embedded-bytes'],
  ]) {
    const lease = createAddFilesScanLease({ timeoutMs: 10000 });
    const release = await h.context.acquireAddFilesPsdTransferSlot(lease);
    const tx = h.context.createAddFilesPsdTransaction(`pool-psd-${idx}`, lease, () => lease.current(), release);
    try {
      const res = await h.context.runAddFilesPsdWorker(psdPath, lease, tx);
      assert.equal(res.entries[0].filePath, expectedLinked);
      const promoted = tx.promote();
      assert.equal(fs.readFileSync(promoted[0].filePath, 'utf8'), expectedBytes);
    } finally {
      await tx.finish();
      lease.dispose();
    }
  }

  assert.equal(h.getForkCount(), 1, 'second sequential PSD must reuse the warm PSD worker');
  assert.equal(h.children.size, 1);
  await h.context.disposeAddFilesWorkerPool();
  assert.equal(h.children.size, 0);
});

test('pooled workers recycle automatically when hitting maxPooledRequests cap', async () => {
  // Regex worker request cap
  let regexHandler;
  let regexExited = 0;
  const regexMessages = [];
  startAddFilesRegexWorker(
    { on: (_, fn) => { regexHandler = fn; }, postMessage: m => regexMessages.push(m) },
    {
      parse: () => ({ sourceIdentity: { dev: 1, ino: 1, size: 10, mtimeMs: 1 }, sourceDigest: 'a'.repeat(64), paths: [] }),
      exit: () => { regexExited += 1; },
      maxPooledRequests: 2,
    }
  );
  regexHandler({ data: { type: 'parse', filePath: '/synthetic/1.ai', pooled: true, requestId: 1 } });
  assert.equal(regexMessages[0].keepAlive, true);
  assert.equal(regexExited, 0);
  regexHandler({ data: { type: 'parse', filePath: '/synthetic/2.ai', pooled: true, requestId: 2 } });
  assert.equal(regexMessages[1].keepAlive, undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(regexExited, 1);

  // PSD worker request cap
  let psdHandler;
  let psdExited = 0;
  const psdMessages = [];
  startAddFilesPsdWorker(
    {
      on: (_, fn) => { psdHandler = fn; },
      postMessage: m => {
        psdMessages.push(m);
        if (m.type !== 'session-idle' && m.type !== 'error') {
          queueMicrotask(() => psdHandler({ data: { type: 'ack', sessionId: m.sessionId, seq: m.seq } }));
        }
      },
    },
    {
      parse: () => ({ psd: { linkedFiles: [] }, sourceIdentity: { dev: 1, ino: 1, size: 10, mtimeMs: 1 }, sourceDigest: 'a'.repeat(64) }),
      exit: () => { psdExited += 1; },
      maxPooledRequests: 1,
    }
  );
  psdHandler({ data: { type: 'parse', filePath: '/synthetic/1.psd', sessionId: 's1', pooled: true } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(psdExited, 1);
  assert.equal(psdMessages.some(m => m.type === 'session-idle'), false);
});

test('openZipArchive rejects deflated entry whose compressedSize exceeds maxOutputBytes ceiling before allocating (A-P1-5)', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-zip-comp-cap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Craft a synthetic ZIP with a deflated entry whose compressed payload is 128 KiB
  // while its declared uncompressed size is 64 bytes and caller requests maxOutputBytes = 4096.
  const nameBuf = Buffer.from('Spreads/Spread_1.xml', 'utf8');
  const compPayload = Buffer.alloc(128 * 1024, 0x00);
  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(compPayload.length, 18); // compressedSize = 128 KiB
  local.writeUInt32LE(64, 22); // declared size = 64 bytes
  local.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(local, 30);

  const cdOffset = local.length + compPayload.length;
  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 8);
  central.writeUInt32LE(compPayload.length, 20);
  central.writeUInt32LE(64, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  nameBuf.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  const zipPath = path.join(dir, 'oversized-deflate.idml');
  fs.writeFileSync(zipPath, Buffer.concat([local, compPayload, central, eocd]));

  const archive = openZipArchive(zipPath, { message: 'too large' });
  t.after(() => archive.close());
  assert.throws(
    () => archive.readEntry(archive.entries[0], { maxOutputBytes: 4096, message: 'entry too large' }),
    err => err && err.code === 'CRATE_PARSER_ADMISSION_LIMIT'
  );
});
