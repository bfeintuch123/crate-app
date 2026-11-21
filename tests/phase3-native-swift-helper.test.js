'use strict';

const assert = require('./bounded-assert');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const agPsd = require('ag-psd');
const { NativeHelperClient, DEFAULT_BINARY_PATH } = require('../parsers/native-helper');
const { AIParser } = require('../parsers/ai');
const { PSDParser } = require('../parsers/psd');

const hasNativeBinary = fs.existsSync(DEFAULT_BINARY_PATH);

test('Swift native helper: ping and clean shutdown', { skip: !hasNativeBinary }, async t => {
  const client = new NativeHelperClient(DEFAULT_BINARY_PATH);
  t.after(() => client.shutdown());
  const pong = await client.ping();
  assert.equal(pong.version, 1);
  assert.equal(pong.arch, 'arm64');
  assert.ok(Number.isInteger(pong.pid) && pong.pid > 0);
});

test('Swift native helper: seek-based PSD & PSB parsing skips giant pixel sections cleanly', { skip: !hasNativeBinary }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-swift-psd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = new NativeHelperClient(DEFAULT_BINARY_PATH);
  t.after(() => client.shutdown());

  const linkedTarget = '/Users/synthetic/hero-shot.png';
  const basePsd = agPsd.writePsdBuffer({
    width: 4,
    height: 4,
    channels: 3,
    bitsPerChannel: 8,
    colorMode: 3,
    children: [{ name: 'smart-obj-layer' }],
    linkedFiles: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'hero-shot.png',
        childDocumentID: '',
        linkedFile: {
          fileSize: 4096,
          name: 'hero-shot.png',
          fullPath: linkedTarget,
          originalPath: linkedTarget,
          relativePath: '../hero-shot.png',
        },
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        name: 'embedded.png',
        data: Buffer.from('embedded-smart-object-payload'),
      },
    ],
  });

  // Append 16 MiB of trailing composite pixel bytes — seek-based parser never reads them!
  const psdPath = path.join(dir, 'large-composite.psd');
  const fd = fs.openSync(psdPath, 'w');
  try {
    fs.writeSync(fd, basePsd);
    fs.ftruncateSync(fd, basePsd.length + 16 * 1024 * 1024);
  } finally {
    fs.closeSync(fd);
  }

  const parsed = await client.parsePsd(psdPath);
  assert.equal(parsed.format, 'psd');
  assert.equal(parsed.width, 4);
  assert.equal(parsed.height, 4);
  assert.deepEqual(parsed.linkedPaths, [linkedTarget]);
  assert.equal(parsed.embeddedRecords.length, 1);
  assert.equal(parsed.embeddedRecords[0].name, 'embedded.png');
  assert.equal(parsed.embeddedRecords[0].byteLength, Buffer.byteLength('embedded-smart-object-payload'));

  // Also test PSB (version 2)
  const psbPath = path.join(dir, 'large.psb');
  const psbBytes = agPsd.writePsdBuffer({
    width: 2,
    height: 2,
    channels: 3,
    bitsPerChannel: 8,
    colorMode: 3,
    linkedFiles: [
      {
        id: '33333333-3333-4333-8333-333333333333',
        name: 'banner.tif',
        childDocumentID: '',
        linkedFile: {
          fileSize: 99,
          name: 'banner.tif',
          fullPath: '/Users/synthetic/banner.tif',
          originalPath: '/Users/synthetic/banner.tif',
          relativePath: '',
        },
      },
    ],
  }, { psb: true });
  fs.writeFileSync(psbPath, psbBytes);
  const parsedPsb = await client.parsePsd(psbPath);
  assert.equal(parsedPsb.format, 'psb');
  assert.deepEqual(parsedPsb.linkedPaths, ['/Users/synthetic/banner.tif']);

  // Verify PSDParser integration uses native path cleanly
  const psdParser = new PSDParser();
  const assets = await psdParser.extractAssets(psbPath);
  assert.deepEqual(assets, [{ path: '/Users/synthetic/banner.tif', source: 'psd-smartobject', exists: false }]);

  // Symlink refusal
  const sym = path.join(dir, 'sym.psd');
  fs.symlinkSync(psdPath, sym);
  await assert.rejects(() => client.parsePsd(sym), /symlink/);
});

test('Swift native helper: PDF/AI parser recovers FlateDecode compressed streams and XMP links', { skip: !hasNativeBinary }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-swift-ai-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = new NativeHelperClient(DEFAULT_BINARY_PATH);
  t.after(() => client.shutdown());

  const compressedLink = '/Users/synthetic/compressed-from-illustrator.png';
  const xmpLink = '/Users/synthetic/xmp-manifest-photo.jpg';
  const rawLink = '/Users/synthetic/raw-uncompressed.svg';

  const compressedPayload = zlib.deflateSync(Buffer.from(
    `BT (${compressedLink}) Tj ET\n<stRef:filePath>file://${xmpLink}</stRef:filePath>`
  ));
  const aiBytes = Buffer.concat([
    Buffer.from('%PDF-1.6\n1 0 obj\n<< /Filter /FlateDecode /Length ' + compressedPayload.length + ' >>\nstream\n'),
    compressedPayload,
    Buffer.from(`\nendstream\nendobj\n% raw link ${rawLink}\n%%EOF\n`),
  ]);

  const aiPath = path.join(dir, 'modern.ai');
  fs.writeFileSync(aiPath, aiBytes);

  const parsed = await client.parsePdfAi(aiPath, { decompressStreams: true });
  assert.ok(parsed.compressedStreamsScanned >= 1);
  assert.ok(parsed.compressedHits >= 2);
  assert.ok(parsed.paths.includes(compressedLink), 'must recover FlateDecode-compressed link');
  assert.ok(parsed.paths.includes(xmpLink), 'must recover XMP stRef:filePath inside compressed stream');
  assert.ok(parsed.paths.includes(rawLink), 'must retain raw uncompressed links');

  // Verify AIParser integration discovers all three!
  const parser = new AIParser();
  const assets = await parser.extractAssets(aiPath);
  const foundPaths = assets.map(a => a.path);
  assert.ok(foundPaths.includes(compressedLink));
  assert.ok(foundPaths.includes(xmpLink));
  assert.ok(foundPaths.includes(rawLink));
});

test('Swift native helper: openat + APFS fclonefileat packaging, CryptoKit SHA-256, symlink refusal, and rollback', { skip: !hasNativeBinary }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-swift-pkg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = new NativeHelperClient(DEFAULT_BINARY_PATH);
  t.after(() => client.shutdown());

  const srcA = path.join(dir, 'sourceA.bin');
  const srcB = path.join(dir, 'sourceB.bin');
  const bytesA = crypto.randomBytes(256 * 1024);
  const bytesB = crypto.randomBytes(128 * 1024);
  fs.writeFileSync(srcA, bytesA);
  fs.writeFileSync(srcB, bytesB);
  const shaA = crypto.createHash('sha256').update(bytesA).digest('hex');
  const shaB = crypto.createHash('sha256').update(bytesB).digest('hex');

  // Direct hardware CryptoKit sha256 check
  const directHash = await client.sha256File(srcA);
  assert.equal(directHash.sha256, shaA);
  assert.equal(directHash.size, bytesA.length);

  // Batch clone + hash into pinned destination directory
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(outDir, { mode: 0o700 });
  const batch = await client.packageBatch(outDir, [
    { sourcePath: srcA, leafName: 'A.bin' },
    { sourcePath: srcB, leafName: 'B.bin' },
  ], { mode: 'clone_or_copy', computeHash: true });

  assert.equal(batch.files.length, 2);
  assert.equal(batch.files[0].sha256, shaA);
  assert.equal(batch.files[1].sha256, shaB);
  assert.equal(fs.lstatSync(path.join(outDir, 'A.bin')).mode & 0o777, 0o600);
  assert.deepEqual(fs.readFileSync(path.join(outDir, 'A.bin')), bytesA);
  assert.deepEqual(fs.readFileSync(path.join(outDir, 'B.bin')), bytesB);

  // Symlink destination directory refused
  const symDir = path.join(dir, 'out-link');
  fs.symlinkSync(outDir, symDir);
  await assert.rejects(
    () => client.packageBatch(symDir, [{ sourcePath: srcA, leafName: 'C.bin' }]),
    /dest_dir_unsafe/
  );

  // Atomic rollback on mid-batch collision (EEXIST) or symlink source
  const rollbackDir = path.join(dir, 'rollback');
  fs.mkdirSync(rollbackDir, { mode: 0o700 });
  const symSrc = path.join(dir, 'sym-src.bin');
  fs.symlinkSync(srcA, symSrc);
  await assert.rejects(
    () => client.packageBatch(rollbackDir, [
      { sourcePath: srcA, leafName: 'good.bin' },
      { sourcePath: symSrc, leafName: 'bad.bin' },
    ]),
    /source_symlink/
  );
  assert.deepEqual(fs.readdirSync(rollbackDir), [], 'failed batch must roll back earlier created files');
});

test('Swift native helper: NSWorkspace runningApps, libproc openFiles, and getxattr lastUsed', { skip: !hasNativeBinary }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-swift-watch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = new NativeHelperClient(DEFAULT_BINARY_PATH);
  t.after(() => client.shutdown());

  // 1. NSWorkspace running apps
  const appsRes = await client.runningApps([]);
  assert.ok(Array.isArray(appsRes.apps) && appsRes.apps.length > 0);

  // 2. libproc openFiles: hold a synthetic .psd open in our own process and verify libproc sees it!
  const openFilePath = fs.realpathSync.native(dir) + '/live-probe.psd';
  fs.writeFileSync(openFilePath, 'probe');
  const fd = fs.openSync(openFilePath, 'r');
  try {
    const openRes = await client.openFiles([process.pid], ['.psd']);
    assert.ok(
      openRes.files.some(entry => entry.pid === process.pid && entry.path === openFilePath),
      'libproc must detect the open regular .psd file in this PID'
    );
  } finally {
    fs.closeSync(fd);
  }

  // 3. getxattr com.apple.lastuseddate#PS (16-byte LE timespec)
  const xattrPath = path.join(dir, 'touched.png');
  const plainPath = path.join(dir, 'untouched.png');
  fs.writeFileSync(xattrPath, 'x');
  fs.writeFileSync(plainPath, 'y');
  const tsBuf = Buffer.alloc(16);
  const seconds = 1760000000n;
  const nanos = 500_000_000n;
  tsBuf.writeBigInt64LE(seconds, 0);
  tsBuf.writeBigInt64LE(nanos, 8);
  execFileSync('/usr/bin/xattr', ['-wx', 'com.apple.lastuseddate#PS', tsBuf.toString('hex'), xattrPath]);

  const xRes = await client.readLastUsedXattrs([xattrPath, plainPath]);
  assert.equal(xRes.timestamps[xattrPath], 1760000000 * 1000 + 500);
  assert.equal(xRes.timestamps[plainPath], null);
});
