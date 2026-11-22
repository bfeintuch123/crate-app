'use strict';

const assert = require('./bounded-assert');
const { execFileSync, spawn } = require('node:child_process');
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
  const parenLink = '/Users/synthetic/Logo (1).png';
  const xmpLink = '/Users/synthetic/xmp-manifest-photo.jpg';
  const rawLink = '/Users/synthetic/raw-uncompressed.svg';

  const compressedPayload = zlib.deflateSync(Buffer.from(
    `BT (${compressedLink}) Tj ET\nBT (${parenLink}) Tj ET\n<stRef:filePath>file://${xmpLink}</stRef:filePath>`
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
  assert.ok(parsed.compressedHits >= 3);
  assert.ok(parsed.paths.includes(compressedLink), 'must recover FlateDecode-compressed link');
  assert.ok(parsed.paths.includes(parenLink), 'must preserve parentheses in filenames like Logo (1).png');
  assert.ok(parsed.paths.includes(xmpLink), 'must recover XMP stRef:filePath inside compressed stream');
  assert.ok(parsed.paths.includes(rawLink), 'must retain raw uncompressed links');

  // Verify AIParser integration discovers all four!
  const parser = new AIParser();
  const assets = await parser.extractAssets(aiPath);
  const foundPaths = assets.map(a => a.path);
  assert.ok(foundPaths.includes(compressedLink));
  assert.ok(foundPaths.includes(parenLink));
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

test('Phase 3B: cloneVerifiedFile enforces ancestry, source identity, mode 0o600, and EEXIST', { skip: !hasNativeBinary }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-swift-clone-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = new NativeHelperClient(DEFAULT_BINARY_PATH);
  t.after(() => client.shutdown());

  const srcPath = path.join(dir, 'design-master.psd');
  const destDir = path.join(dir, 'staged-package');
  fs.mkdirSync(destDir, { mode: 0o700 });
  const payload = crypto.randomBytes(512 * 1024);
  fs.writeFileSync(srcPath, payload, { mode: 0o644 });

  const srcStat = fs.lstatSync(srcPath, { bigint: true });
  const destStat = fs.lstatSync(destDir, { bigint: true });
  const ancestry = [];
  let cur = fs.realpathSync(destDir);
  while (true) {
    const st = fs.lstatSync(cur, { bigint: true });
    ancestry.push({ dev: `${st.dev}`, ino: `${st.ino}` });
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  // Happy path: verified APFS clone with 0o600 hardening
  const res = await client.cloneVerifiedFile({
    sourcePath: srcPath,
    expectedSourceDev: `${srcStat.dev}`,
    expectedSourceIno: `${srcStat.ino}`,
    expectedSourceSize: `${srcStat.size}`,
    destDir,
    expectedDestDev: `${destStat.dev}`,
    expectedDestIno: `${destStat.ino}`,
    ancestries: [ancestry],
    leafName: 'design-master.psd',
    mode: 0o600,
  });
  assert.equal(res.cloned, true);
  assert.equal(res.bytesWritten, `${payload.length}`);
  const outPath = path.join(destDir, 'design-master.psd');
  const outStat = fs.lstatSync(outPath, { bigint: true });
  assert.equal(Number(outStat.mode & 0o777n), 0o600);
  assert.equal(res.outputIdentity.dev, `${outStat.dev}`);
  assert.equal(res.outputIdentity.ino, `${outStat.ino}`);
  assert.deepEqual(fs.readFileSync(outPath), payload);

  // Rejects EEXIST (atomic non-overwrite)
  await assert.rejects(
    client.cloneVerifiedFile({
      sourcePath: srcPath,
      expectedSourceDev: `${srcStat.dev}`,
      expectedSourceIno: `${srcStat.ino}`,
      expectedSourceSize: `${srcStat.size}`,
      destDir,
      expectedDestDev: `${destStat.dev}`,
      expectedDestIno: `${destStat.ino}`,
      ancestries: [ancestry],
      leafName: 'design-master.psd',
      mode: 0o600,
    }),
    /dest_already_exists/
  );

  // Rejects forged directory ancestry
  const badAncestry = ancestry.map((item, idx) => (idx === 1 ? { ...item, ino: '999999999999' } : item));
  await assert.rejects(
    client.cloneVerifiedFile({
      sourcePath: srcPath,
      expectedSourceDev: `${srcStat.dev}`,
      expectedSourceIno: `${srcStat.ino}`,
      expectedSourceSize: `${srcStat.size}`,
      destDir,
      expectedDestDev: `${destStat.dev}`,
      expectedDestIno: `${destStat.ino}`,
      ancestries: [badAncestry],
      leafName: 'should-not-exist.psd',
      mode: 0o600,
    }),
    /dest_dir_changed/
  );
  assert.equal(fs.existsSync(path.join(destDir, 'should-not-exist.psd')), false);

  // Rejects source identity mismatch
  await assert.rejects(
    client.cloneVerifiedFile({
      sourcePath: srcPath,
      expectedSourceDev: `${srcStat.dev}`,
      expectedSourceIno: `${srcStat.ino}`,
      expectedSourceSize: `${srcStat.size + 1n}`,
      destDir,
      expectedDestDev: `${destStat.dev}`,
      expectedDestIno: `${destStat.ino}`,
      ancestries: [ancestry],
      leafName: 'wrong-size.psd',
      mode: 0o600,
    }),
    /source_changed/
  );
  assert.equal(fs.existsSync(path.join(destDir, 'wrong-size.psd')), false);
});

test('WatchOps live kernel parity: sees processes launched after first poll and detects mmap-only files without open fds', { skip: !hasNativeBinary }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-swift-watch-live-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = new NativeHelperClient(DEFAULT_BINARY_PATH);
  t.after(() => client.shutdown());

  // 1. Prime persistent helper with an initial runningApps call (would freeze NSWorkspace cache!)
  const beforeApps = await client.runningApps(['python']);
  assert.ok(Array.isArray(beforeApps.apps));

  // 2. Launch a brand-new process AFTER the first call that mmaps a .ttf file and closes its fd immediately
  const mappedFont = path.join(fs.realpathSync.native(dir), 'MappedFont (1).ttf');
  fs.writeFileSync(mappedFont, Buffer.alloc(8192, 0x41));
  const pyScript = [
    'import mmap, os, sys, time',
    'fd = os.open(sys.argv[1], os.O_RDONLY)',
    'mm = mmap.mmap(fd, 0, access=mmap.ACCESS_READ)',
    'os.close(fd)',
    'print("READY", flush=True)',
    'time.sleep(30)',
  ].join('\n');
  const child = spawn('/usr/bin/python3', ['-c', pyScript, mappedFont], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { try { child.kill('SIGKILL'); } catch (_) {} });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('python mmap helper timed out')), 5000);
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('python mmap helper exited early')); });
  });

  // Persistent helper MUST see the newly launched child PID immediately (no RunLoop cache!)
  const afterApps = await client.runningApps(['python']);
  assert.ok(
    afterApps.apps.some(app => app.pid === child.pid),
    `persistent helper must see newly launched PID ${child.pid} immediately`
  );

  // Persistent helper MUST see the mmap-only .ttf file even though its fd was closed!
  const openRes = await client.openFiles([child.pid], ['.ttf']);
  assert.ok(
    openRes.files.some(entry => entry.pid === child.pid && entry.path === mappedFont),
    'PROC_PIDREGIONPATHINFO must detect mmap-only regular files with closed fds'
  );
});

test('NativeHelperClient process isolation: watcher and package helpers use distinct child processes', { skip: !hasNativeBinary }, async t => {
  const { watcherNativeHelper, packageNativeHelper } = require('../parsers/native-helper');
  t.after(async () => {
    await watcherNativeHelper.shutdown();
    await packageNativeHelper.shutdown();
  });
  assert.notEqual(watcherNativeHelper, packageNativeHelper);
  const [wPong, pPong] = await Promise.all([watcherNativeHelper.ping(), packageNativeHelper.ping()]);
  assert.notEqual(wPong.pid, pPong.pid, 'watcher and package helpers must run in isolated OS processes');
});

test('Phase 3B hardening: cloneVerifiedFile strips source xattrs and falls back safely on Finder-locked sources', { skip: !hasNativeBinary }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-swift-clone-hardening-'));
  const lockedPath = path.join(dir, 'locked-asset.png');
  t.after(() => {
    try { execFileSync('/usr/bin/chflags', ['nouchg', lockedPath]); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const client = new NativeHelperClient(DEFAULT_BINARY_PATH);
  t.after(() => client.shutdown());

  const destDir = path.join(dir, 'staged');
  fs.mkdirSync(destDir, { mode: 0o700 });
  const destStat = fs.lstatSync(destDir, { bigint: true });
  const ancestry = [];
  let cur = fs.realpathSync(destDir);
  while (true) {
    const st = fs.lstatSync(cur, { bigint: true });
    ancestry.push({ dev: `${st.dev}`, ino: `${st.ino}` });
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  // 1. Source with privacy-sensitive extended attributes (WhereFroms + quarantine)
  const xattrSrc = path.join(dir, 'downloaded.png');
  const payload = crypto.randomBytes(64 * 1024);
  fs.writeFileSync(xattrSrc, payload);
  execFileSync('/usr/bin/xattr', ['-w', 'com.apple.metadata:kMDItemWhereFroms', 'https://private.example/secret', xattrSrc]);
  execFileSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0081;00000000;Safari;', xattrSrc]);
  const xattrSrcStat = fs.lstatSync(xattrSrc, { bigint: true });

  const cloneRes = await client.cloneVerifiedFile({
    sourcePath: xattrSrc,
    expectedSourceDev: `${xattrSrcStat.dev}`,
    expectedSourceIno: `${xattrSrcStat.ino}`,
    expectedSourceSize: `${xattrSrcStat.size}`,
    destDir,
    expectedDestDev: `${destStat.dev}`,
    expectedDestIno: `${destStat.ino}`,
    ancestries: [ancestry],
    leafName: 'downloaded.png',
    mode: 0o600,
  });
  assert.equal(cloneRes.cloned, true);
  const clonedPath = path.join(destDir, 'downloaded.png');
  assert.deepEqual(fs.readFileSync(clonedPath), payload);
  const outXattrs = execFileSync('/usr/bin/xattr', [clonedPath], { encoding: 'utf8' })
    .split('\n')
    .map(line => line.trim())
    .filter(name => name && name !== 'com.apple.provenance');
  assert.deepEqual(outXattrs, [], 'cloned output must strip all non-kernel extended attributes including WhereFroms and quarantine');

  // 2. Finder-locked source (UF_IMMUTABLE via chflags uchg) must NOT fail hard or leave an undeletable file
  fs.writeFileSync(lockedPath, payload);
  execFileSync('/usr/bin/chflags', ['uchg', lockedPath]);
  const lockedStat = fs.lstatSync(lockedPath, { bigint: true });

  const lockedRes = await client.cloneVerifiedFile({
    sourcePath: lockedPath,
    expectedSourceDev: `${lockedStat.dev}`,
    expectedSourceIno: `${lockedStat.ino}`,
    expectedSourceSize: `${lockedStat.size}`,
    destDir,
    expectedDestDev: `${destStat.dev}`,
    expectedDestIno: `${destStat.ino}`,
    ancestries: [ancestry],
    leafName: 'locked-asset.png',
    mode: 0o600,
  });
  assert.equal(lockedRes.cloned, false);
  assert.equal(lockedRes.fallback, true);
  assert.equal(lockedRes.reason, 'source_has_flags');
  assert.equal(fs.existsSync(path.join(destDir, 'locked-asset.png')), false, 'locked fallback must leave no undeletable file in staging');

  // 3. packageBatch must also fall back to streaming copy on a locked source
  const batchDir = path.join(dir, 'batch-out');
  fs.mkdirSync(batchDir, { mode: 0o700 });
  const batchRes = await client.packageBatch(batchDir, [{ sourcePath: lockedPath, leafName: 'locked-copy.png' }], {
    mode: 'clone_or_copy',
    computeHash: true,
  });
  assert.equal(batchRes.files.length, 1);
  assert.equal(batchRes.files[0].cloned, false);
  assert.deepEqual(fs.readFileSync(path.join(batchDir, 'locked-copy.png')), payload);
});

test('Photoshop CC external links: file://// four-slash URIs with spaces and NULs resolve across Swift, worker, and Quick Package', { skip: !hasNativeBinary }, async t => {
  const { normalizePsdExternalPath } = require('../parsers/xml-path');
  const { parsePsd, sendPsdRecords } = require('../parsers/add-files-psd-worker');

  // Unit cases for normalizePsdExternalPath
  assert.equal(
    normalizePsdExternalPath('file:////Users/synthetic/QA Folder/qa-asset-one.jpg\0'),
    '/Users/synthetic/QA Folder/qa-asset-one.jpg'
  );
  assert.equal(
    normalizePsdExternalPath('file:////Volumes/Studio Drive/My Shot (1).jpg'),
    '/Volumes/Studio Drive/My Shot (1).jpg'
  );
  assert.equal(
    normalizePsdExternalPath('file:///Users/synthetic/My%20Folder/hero.png'),
    '/Users/synthetic/My Folder/hero.png'
  );
  assert.equal(
    normalizePsdExternalPath('file://localhost/Users/synthetic/100% Sale.jpg'),
    '/Users/synthetic/100% Sale.jpg'
  );
  assert.equal(normalizePsdExternalPath('file://evil-host/Users/synthetic/a.jpg'), '');
  assert.equal(normalizePsdExternalPath('file:/%2FUsers/synthetic/a.jpg'), '');
  assert.equal(normalizePsdExternalPath('file://///Users/synthetic/a.jpg'), '');
  assert.equal(normalizePsdExternalPath('//Users/synthetic/a.jpg'), '');
  assert.equal(normalizePsdExternalPath(''), '');

  // End-to-end PSD with Photoshop CC-style file://// fullPath + literal spaces + trailing NUL
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-psd-cc-uri-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = new NativeHelperClient(DEFAULT_BINARY_PATH);
  t.after(() => client.shutdown());

  const expectedPosix = '/Users/synthetic/QA Folder/source-copies/qa-asset-one.jpg';
  const ccFileUri = `file:///${expectedPosix}`; // yields file:////Users/... (four slashes)
  const psdBytes = agPsd.writePsdBuffer({
    width: 4,
    height: 4,
    channels: 3,
    bitsPerChannel: 8,
    linkedFiles: [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: 'qa-asset-one.jpg',
        childDocumentID: '',
        linkedFile: {
          fileSize: 20495,
          name: 'qa-asset-one.jpg',
          fullPath: `${ccFileUri}\0`,
          originalPath: expectedPosix,
          relativePath: 'qa-asset-one.jpg',
        },
      },
    ],
  });
  const psdPath = path.join(dir, 'Photoshop_CC_Linked.psd');
  fs.writeFileSync(psdPath, psdBytes);

  // 1. Native Swift PsdParser
  const swiftParsed = await client.parsePsd(psdPath);
  assert.deepEqual(swiftParsed.linkedPaths, [expectedPosix]);

  // 2. Quick Package PSDParser (Swift path)
  const quickAssets = await new PSDParser().extractAssets(psdPath);
  assert.deepEqual(quickAssets, [{ path: expectedPosix, source: 'psd-smartobject', exists: false }]);

  // 3. Add Files PSD worker emits raw declared fullPath (matching linked-metadata
  // for createAddFilesPsdTransaction protocol verification); main normalizes downstream.
  const workerParsed = parsePsd(psdPath);
  const emitted = [];
  let current = null;
  await sendPsdRecords(workerParsed, async rec => {
    if (rec.type === 'record') current = rec.kind === 'linked-path' ? '' : null;
    else if (rec.type === 'text' && current !== null) current += rec.text;
    else if (rec.type === 'record-end' && current !== null) { emitted.push(current); current = null; }
  });
  assert.deepEqual(emitted, [`${ccFileUri}\0`]);
  assert.deepEqual(emitted.map(normalizePsdExternalPath), [expectedPosix]);

  // 4. Native Swift PdfAiParser XMP four-slash URI + numeric XML entities + %2F guard
  const aiPath = path.join(dir, 'Illustrator_CC_XMP.ai');
  fs.writeFileSync(
    aiPath,
    [
      '%PDF-1.6',
      '<stRef:filePath>file:////Users/synthetic/QA Folder/ai-asset.jpg</stRef:filePath>',
      '<stRef:filePath>file:///Users/synthetic/R&#38;D&#x20;Team/logo.png</stRef:filePath>',
      '<stRef:filePath>file:/%2FUsers/synthetic/smuggled.jpg</stRef:filePath>',
      '%%EOF',
    ].join('\n')
  );
  const aiParsed = await client.parsePdfAi(aiPath, { decompressStreams: true });
  assert.ok(aiParsed.paths.includes('/Users/synthetic/QA Folder/ai-asset.jpg'));
  assert.ok(aiParsed.paths.includes('/Users/synthetic/R&D Team/logo.png'));
  assert.ok(!aiParsed.paths.some(p => p.includes('smuggled.jpg')));
});

test('Photoshop external link normalization preserves literal trailing spaces and U+200B in Swift helper and JS', { skip: !hasNativeBinary }, async t => {
  const { normalizePsdExternalPath } = require('../parsers/xml-path');
  const { packageMasterFile } = require('../parsers/index');
  const { nativeHelper } = require('../parsers/native-helper');

  // Verify the rebuilt native Swift helper is actually active for PSDParser
  assert.equal(nativeHelper.isAvailable(), true);

  // JS normalizePsdExternalPath preserves literal trailing spaces and U+200B,
  // strips only trailing NUL padding, and still rejects embedded NULs.
  assert.equal(normalizePsdExternalPath('/Users/synthetic/Brand Kit/Boundary.otf \0'), '/Users/synthetic/Brand Kit/Boundary.otf ');
  assert.equal(normalizePsdExternalPath('/Users/synthetic/Brand Kit/Photo.png\u200B\0'), '/Users/synthetic/Brand Kit/Photo.png\u200B');
  assert.equal(normalizePsdExternalPath('/Users/synthetic/Brand Kit/Hidden.otf\u200B'), '/Users/synthetic/Brand Kit/Hidden.otf\u200B');
  assert.equal(normalizePsdExternalPath('/Users/synthetic/Brand\0Kit/bad.png'), '');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-psd-literal-chars-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const brandDir = path.join(dir, 'Brand Kit');
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(brandDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const photoPath = path.join(brandDir, 'Photo.png\u200B');
  const hiddenFontPath = path.join(brandDir, 'Hidden.otf\u200B');
  const spacedFontPath = path.join(brandDir, 'Boundary.otf ');
  const photoBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5, 6, 7, 8]);
  fs.writeFileSync(photoPath, photoBytes);
  fs.writeFileSync(hiddenFontPath, Buffer.from('OTTO-synthetic-hidden-font'));
  fs.writeFileSync(spacedFontPath, Buffer.from('OTTO-synthetic-spaced-font'));

  const psdPath = path.join(dir, 'Comp.psd');
  const makeLink = (file, id) => ({
    id,
    name: path.basename(file),
    childDocumentID: '',
    linkedFile: { fileSize: fs.statSync(file).size, name: path.basename(file), fullPath: `${file}\0`, originalPath: file, relativePath: '' },
  });
  fs.writeFileSync(psdPath, agPsd.writePsdBuffer({
    width: 2,
    height: 2,
    linkedFiles: [
      makeLink(photoPath, '11111111-1111-4111-8111-111111111111'),
      makeLink(hiddenFontPath, '22222222-2222-4222-8222-222222222222'),
      makeLink(spacedFontPath, '33333333-3333-4333-8333-333333333333'),
    ],
  }));

  // 1. Direct Swift helper call preserves exact paths
  const client = new NativeHelperClient(DEFAULT_BINARY_PATH);
  t.after(() => client.shutdown());
  const swiftParsed = await client.parsePsd(psdPath);
  assert.deepEqual(swiftParsed.linkedPaths, [photoPath, hiddenFontPath, spacedFontPath]);

  // 2. PSDParser (using Swift helper) finds all three with exists: true
  const extracted = await new PSDParser().extractAssets(psdPath);
  assert.deepEqual(
    extracted.map(a => ({ path: a.path, exists: a.exists })),
    [
      { path: photoPath, exists: true },
      { path: hiddenFontPath, exists: true },
      { path: spacedFontPath, exists: true },
    ]
  );

  // 3. Quick Package copies Photo.png\u200B with exact name and identical bytes,
  //    while excluding both fonts and listing them under fontsNotIncluded.
  const pkg = await packageMasterFile(psdPath, outDir);
  const copiedPhoto = path.join(outDir, 'Brand Kit', 'Photo.png\u200B');
  assert.equal(fs.existsSync(copiedPhoto), true);
  assert.deepEqual(fs.readFileSync(copiedPhoto), photoBytes);
  assert.equal(fs.existsSync(path.join(outDir, 'Brand Kit', 'Hidden.otf\u200B')), false);
  assert.equal(fs.existsSync(path.join(outDir, 'Brand Kit', 'Boundary.otf ')), false);
  assert.deepEqual(
    (pkg.fontsNotIncluded || []).map(item => item.name).sort(),
    ['Boundary.otf ', 'Hidden.otf\u200B']
  );
});
