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
const { NativeHelperClient, DEFAULT_BINARY_PATH, nativeHelper } = require('../parsers/native-helper');
const { AIParser } = require('../parsers/ai');
const { PSDParser } = require('../parsers/psd');

const hasNativeBinary = nativeHelper.isAvailable();

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

test('Swift native helper: CryptoKit SHA-256 works and deprecated package_batch op is removed', { skip: !hasNativeBinary }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-swift-pkg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = new NativeHelperClient(DEFAULT_BINARY_PATH);
  t.after(() => client.shutdown());

  const srcA = path.join(dir, 'sourceA.bin');
  const bytesA = crypto.randomBytes(256 * 1024);
  fs.writeFileSync(srcA, bytesA);
  const shaA = crypto.createHash('sha256').update(bytesA).digest('hex');

  // Direct hardware CryptoKit sha256 check
  const directHash = await client.sha256File(srcA);
  assert.equal(directHash.sha256, shaA);
  assert.equal(directHash.size, bytesA.length);

  // Deprecated package_batch op must be removed from both JS client and Swift helper
  assert.equal(typeof client.packageBatch, 'undefined');
  await assert.rejects(
    () => client.call('package_batch', { destDir: dir, items: [] }),
    /unknown_op/
  );
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
});

test('WatchOps completeness & error distinction: xattr errors, invalid PIDs, and case-sensitive runningApps', { skip: !hasNativeBinary }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-swift-watch-errors-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = new NativeHelperClient(DEFAULT_BINARY_PATH);
  t.after(() => client.shutdown());

  // 1. Missing xattr (ENOATTR) => null with zero errors; missing file (ENOENT) => explicit error!
  const plainFile = path.join(dir, 'plain.png');
  const missingFile = path.join(dir, 'does-not-exist.png');
  fs.writeFileSync(plainFile, 'ok');
  const xattrRes = await client.readLastUsedXattrs([plainFile, missingFile]);
  assert.equal(xattrRes.timestamps[plainFile], null);
  assert.equal(xattrRes.errors[plainFile], undefined);
  assert.ok(typeof xattrRes.errors[missingFile] === 'string' && xattrRes.errors[missingFile].startsWith('errno_'));

  // 2. openFiles on valid PID is complete; openFiles including nonexistent PID signals complete=false + failedPids
  const okOpen = await client.openFiles([process.pid], []);
  assert.equal(okOpen.complete, true);
  assert.deepEqual(okOpen.failedPids, []);

  const badOpen = await client.openFiles([process.pid, 999999], []);
  assert.equal(badOpen.complete, false);
  assert.ok(badOpen.failedPids.includes(999999));

  // 3. runningApps caseSensitive=true respects exact keyword casing
  const exactRes = await client.runningApps(['NO_SUCH_CASE_VARIANT_XYZ'], 3000, { caseSensitive: true });
  assert.deepEqual(exactRes.apps, []);
});

test('Swift PdfAiParser signals incomplete on >512 FlateDecode streams and AIParser falls back safely without broadening web-font policy', { skip: !hasNativeBinary }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-swift-ai-cap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = new NativeHelperClient(DEFAULT_BINARY_PATH);
  t.after(() => client.shutdown());

  // Build a synthetic PDF/AI with 520 tiny FlateDecode streams (> 512 cap), placing a
  // compressed-only link in stream #1 plus raw .psb, .woff2, and /Volumes links at EOF.
  const firstStreamCompressed = zlib.deflateSync(Buffer.from('BT (/Users/synthetic/compressed-only.png) Tj ET'));
  const tinyCompressed = zlib.deflateSync(Buffer.from('BT () Tj ET'));
  const parts = [Buffer.from('%PDF-1.6\n')];
  for (let i = 1; i <= 520; i++) {
    const payload = i === 1 ? firstStreamCompressed : tinyCompressed;
    parts.push(Buffer.from(`${i} 0 obj\n<< /Filter /FlateDecode /Length ${payload.length} >>\nstream\n`));
    parts.push(payload);
    parts.push(Buffer.from('\nendstream\nendobj\n'));
  }
  parts.push(Buffer.from('% /Users/synthetic/Smart.psb /Users/synthetic/Brand.woff2 /Volumes/Studio/hero.png\n%%EOF\n'));
  const cappedAi = path.join(dir, 'many-streams.ai');
  fs.writeFileSync(cappedAi, Buffer.concat(parts));

  const parsed = await client.parsePdfAi(cappedAi, { decompressStreams: true });
  assert.equal(parsed.incomplete, true);
  assert.ok(Array.isArray(parsed.issues) && parsed.issues.includes('flate-stream-count-limit'));
  assert.ok(parsed.paths.includes('/Users/synthetic/compressed-only.png'), 'Swift helper found stream #1 link before hitting 512-stream cap');

  // AIParser MUST discard the incomplete native result and fall back to JS raw scan
  // (so compressed-only.png is absent while raw .psb & /Volumes are kept and .woff2 excluded).
  const parser = new AIParser();
  const assets = await parser.extractAssets(cappedAi);
  const paths = assets.map(a => a.path);
  assert.equal(paths.includes('/Users/synthetic/compressed-only.png'), false, 'must fall back to JS scan instead of trusting incomplete native output');
  assert.deepEqual(paths, ['/Users/synthetic/Smart.psb', '/Volumes/Studio/hero.png']);
});

test('PSDParser falls back to ag-psd when native parsePsd reports incomplete or issues (A-P1-7)', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-psd-issues-fallback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const linkedTarget = '/Users/synthetic/fallback-hero.png';
  const psdBytes = agPsd.writePsdBuffer({
    width: 2,
    height: 2,
    channels: 3,
    bitsPerChannel: 8,
    colorMode: 3,
    linkedFiles: [{
      id: '44444444-4444-4444-8444-444444444444',
      name: 'fallback-hero.png',
      childDocumentID: '',
      linkedFile: {
        fileSize: 128,
        name: 'fallback-hero.png',
        fullPath: linkedTarget,
        originalPath: linkedTarget,
        relativePath: '',
      },
    }],
  });
  const psdPath = path.join(dir, 'incomplete-native.psd');
  fs.writeFileSync(psdPath, psdBytes);

  const origIsAvailable = nativeHelper.isAvailable;
  const origParsePsd = nativeHelper.parsePsd;
  let nativeCalled = false;
  nativeHelper.isAvailable = () => true;
  nativeHelper.parsePsd = async () => {
    nativeCalled = true;
    return {
      linkedPaths: [],
      mediaPaths: [],
      issues: ['unsupported-additional-signature'],
      incomplete: true,
    };
  };
  t.after(() => {
    nativeHelper.isAvailable = origIsAvailable;
    nativeHelper.parsePsd = origParsePsd;
  });

  const assets = await new PSDParser().extractAssets(psdPath);
  assert.equal(nativeCalled, true);
  assert.deepEqual(assets, [{ path: linkedTarget, source: 'psd-smartobject', exists: false }]);
});

test('Swift PsdParser real binary fixtures emit incomplete + issues for oversized PxSc, oversized/unreadable 1075, and non-8BIM resources (A-P1-7 / Fable B3)', { skip: !hasNativeBinary }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-psd-issues-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = new NativeHelperClient(DEFAULT_BINARY_PATH);
  t.after(() => client.shutdown());

  function makeMinimalPsd({ resourcesBuf = Buffer.alloc(0), addLayerBuf = Buffer.alloc(0) }) {
    const header = Buffer.alloc(26);
    header.write('8BPS', 0, 'ascii');
    header.writeUInt16BE(1, 4); // PSD v1
    header.writeUInt16BE(3, 12); // RGB 3 channels
    header.writeUInt32BE(2, 14); // height
    header.writeUInt32BE(2, 18); // width
    header.writeUInt16BE(8, 22); // depth
    header.writeUInt16BE(3, 24); // RGB mode
    const colorModeLen = Buffer.alloc(4);
    const resLen = Buffer.alloc(4);
    resLen.writeUInt32BE(resourcesBuf.length, 0);
    // Layer & mask section: empty layerInfo (4B) + empty globalMask (4B) + additional layer info
    const layerSecBody = Buffer.concat([Buffer.alloc(4), Buffer.alloc(4), addLayerBuf]);
    const layerSecLen = Buffer.alloc(4);
    layerSecLen.writeUInt32BE(layerSecBody.length, 0);
    const imgData = Buffer.alloc(2 + 2 * 2 * 3);
    return Buffer.concat([header, colorModeLen, resLen, resourcesBuf, layerSecLen, layerSecBody, imgData]);
  }

  function makeResourceBlock(sig, id, payload) {
    const head = Buffer.alloc(12);
    head.write(sig, 0, 'ascii');
    head.writeUInt16BE(id, 4);
    head.writeUInt8(0, 6); // empty Pascal name + 1 pad byte at 7
    head.writeUInt32BE(payload.length, 8);
    const pad = (payload.length % 2) === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
    return Buffer.concat([head, payload, pad]);
  }

  // 1. Oversized image resource 1075 (> 256 KiB)
  const oversized1075Path = path.join(dir, 'oversized-1075.psd');
  fs.writeFileSync(oversized1075Path, makeMinimalPsd({
    resourcesBuf: makeResourceBlock('8BIM', 1075, Buffer.alloc(262200)),
  }));
  const res1 = await client.parsePsd(oversized1075Path);
  assert.equal(res1.incomplete, true);
  assert.ok(res1.issues.includes('oversized-resource-1075'));

  // 2. Unreadable image resource 1075 (invalid descriptor bytes)
  const bad1075Path = path.join(dir, 'bad-1075.psd');
  fs.writeFileSync(bad1075Path, makeMinimalPsd({
    resourcesBuf: makeResourceBlock('8BIM', 1075, Buffer.from([0, 0, 0, 16, 255, 255])),
  }));
  const res2 = await client.parsePsd(bad1075Path);
  assert.equal(res2.incomplete, true);
  assert.ok(res2.issues.includes('unreadable-resource-1075'));

  // 3. Non-8BIM image resource signature
  const non8bimPath = path.join(dir, 'non-8bim.psd');
  fs.writeFileSync(non8bimPath, makeMinimalPsd({
    resourcesBuf: makeResourceBlock('MeSa', 1000, Buffer.alloc(4)),
  }));
  const res3 = await client.parsePsd(non8bimPath);
  assert.equal(res3.incomplete, true);
  assert.ok(res3.issues.includes('non-8bim-image-resource'));

  // 4. Oversized PxSc additional layer block (> 256 KiB)
  const pxscPayload = Buffer.alloc(262200);
  const pxscHeader = Buffer.alloc(12);
  pxscHeader.write('8BIM', 0, 'ascii');
  pxscHeader.write('PxSc', 4, 'ascii');
  pxscHeader.writeUInt32BE(pxscPayload.length, 8);
  const oversizedPxScPath = path.join(dir, 'oversized-pxsc.psd');
  fs.writeFileSync(oversizedPxScPath, makeMinimalPsd({
    addLayerBuf: Buffer.concat([pxscHeader, pxscPayload]),
  }));
  const res4 = await client.parsePsd(oversizedPxScPath);
  assert.equal(res4.incomplete, true);
  assert.ok(res4.issues.includes('oversized-pxsc-descriptor'));
});

test('normalizePsdExternalPath JS unit cases (always run in helper-ON and helper-OFF modes)', () => {
  const { normalizePsdExternalPath } = require('../parsers/xml-path');
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
  assert.equal(normalizePsdExternalPath('/Users/synthetic/Brand Kit/Boundary.otf \0'), '/Users/synthetic/Brand Kit/Boundary.otf ');
  assert.equal(normalizePsdExternalPath('/Users/synthetic/Brand Kit/Photo.png\u200B\0'), '/Users/synthetic/Brand Kit/Photo.png\u200B');
  assert.equal(normalizePsdExternalPath('/Users/synthetic/Brand Kit/Hidden.otf\u200B'), '/Users/synthetic/Brand Kit/Hidden.otf\u200B');
  assert.equal(normalizePsdExternalPath('/Users/synthetic/Brand\0Kit/bad.png'), '');
});

test('Photoshop CC external links: file://// four-slash URIs with spaces and NULs resolve across Swift, worker, and Quick Package', { skip: !hasNativeBinary }, async t => {
  const { normalizePsdExternalPath } = require('../parsers/xml-path');
  const { parsePsd, sendPsdRecords } = require('../parsers/add-files-psd-worker');

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

  // 5. Direct Swift PdfAiParser preserves inner /users/, /Volumes/, (old)/Users/, and lossy non-UTF-8 bytes
  const edgeAiPath = path.join(dir, 'Illustrator_Edge_Dirs.ai');
  fs.writeFileSync(
    edgeAiPath,
    Buffer.concat([
      Buffer.from('%PDF-1.6\n'),
      Buffer.from('/Users/me/Projects/users/avatar.png\n'),
      Buffer.from('/Users/me/Old Mac/Users/jane/logo.png\n'),
      Buffer.from('/Users/me/Client/Volumes/hero.png\n'),
      Buffer.from('/Users/me/Archive (old)/Users/jo/a.png\n'),
      Buffer.from('/Users/me/caf'), Buffer.from([0x8e]), Buffer.from('.png\n'),
      Buffer.from('%%EOF\n'),
    ])
  );
  const edgeParsed = await client.parsePdfAi(edgeAiPath, { decompressStreams: true });
  assert.deepEqual(edgeParsed.paths, [
    '/Users/me/Projects/users/avatar.png',
    '/Users/me/Old Mac/Users/jane/logo.png',
    '/Users/me/Client/Volumes/hero.png',
    '/Users/me/Archive (old)/Users/jo/a.png',
    '/Users/me/caf\uFFFD.png',
  ]);
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

test('canUseNativePackageClone stays disabled unconditionally even when CRATE_ENABLE_NATIVE_CLONE=1 (A1/A7)', t => {
  const bridge = require('../parsers/native-watcher-bridge');
  const prevCloneEnv = process.env.CRATE_ENABLE_NATIVE_CLONE;
  process.env.CRATE_ENABLE_NATIVE_CLONE = '1';
  t.after(() => {
    if (prevCloneEnv === undefined) delete process.env.CRATE_ENABLE_NATIVE_CLONE;
    else process.env.CRATE_ENABLE_NATIVE_CLONE = prevCloneEnv;
  });

  assert.equal(bridge.canUseNativePackageClone(), false);
  const origElectronDesc = Object.getOwnPropertyDescriptor(process.versions, 'electron');
  Object.defineProperty(process.versions, 'electron', { value: '42.11.16', configurable: true });
  t.after(() => {
    if (origElectronDesc) Object.defineProperty(process.versions, 'electron', origElectronDesc);
    else delete process.versions.electron;
  });
  assert.equal(bridge.canUseNativePackageClone(), false);
});

test('NativeHelperClient caps unfinished stdout lines and kills oversized helper sessions (A2)', { skip: process.platform !== 'darwin' }, async t => {
  const prevDisable = process.env.CRATE_DISABLE_NATIVE_HELPER;
  delete process.env.CRATE_DISABLE_NATIVE_HELPER;
  t.after(() => {
    if (prevDisable === undefined) delete process.env.CRATE_DISABLE_NATIVE_HELPER;
    else process.env.CRATE_DISABLE_NATIVE_HELPER = prevDisable;
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-helper-stdout-cap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const fakeHelper = path.join(dir, 'oversized-helper.sh');
  fs.writeFileSync(
    fakeHelper,
    '#!/bin/sh\nIFS= read -r _line\nprintf "%0*d\\n" 512 0\n',
    { mode: 0o755 }
  );

  const client = new NativeHelperClient(fakeHelper, { maxStdoutLineChars: 128 });
  t.after(() => client.shutdown());

  await assert.rejects(
    () => client.ping(),
    /native_helper_response_too_large/
  );
  assert.equal(client.session, null, 'oversized helper session must be terminated and detached');
});

test('Swift PdfAiParser enforces reference count & byte ceilings during scanning and returns pdf_ai_reference_limit (A2)', { skip: !hasNativeBinary }, async t => {
  const { ADMISSION_LIMITS } = require('../parsers/admission-budgets');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-swift-ai-budget-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = new NativeHelperClient(DEFAULT_BINARY_PATH);
  t.after(() => client.shutdown());

  // 1. 10,001 repeated raw links -> Swift throws typed pdf_ai_reference_limit directly
  const repeatOverPath = path.join(dir, 'repeat-over.ai');
  const target = '/Users/synthetic-swift-budget/hero.png';
  fs.writeFileSync(
    repeatOverPath,
    Array.from({ length: ADMISSION_LIMITS.parserReferences + 1 }, () => target).join('\n')
  );
  await assert.rejects(
    () => client.parsePdfAi(repeatOverPath, { decompressStreams: true }),
    error => error && error.code === 'pdf_ai_reference_limit'
  );

  // 2. Repeated long paths exceeding 16 MiB under 10,000 count -> pdf_ai_reference_limit
  const byteOverPath = path.join(dir, 'bytes-over.ai');
  const longTarget = `/Users/synthetic-swift-budget/${'b'.repeat(3500)}.png`;
  const countForBytes = Math.floor(ADMISSION_LIMITS.parserReferenceBytes / Buffer.byteLength(longTarget, 'utf8')) + 2;
  assert.ok(countForBytes < ADMISSION_LIMITS.parserReferences);
  fs.writeFileSync(
    byteOverPath,
    Array.from({ length: countForBytes }, () => longTarget).join('\n')
  );
  await assert.rejects(
    () => client.parsePdfAi(byteOverPath, { decompressStreams: true }),
    error => error && error.code === 'pdf_ai_reference_limit'
  );

  // 3. 4,000 raw links + 4,000 matching XMP + 4,000 matching FlateDecode links
  //    (8,000 raw hits + 0 unseen XMP + 0 unseen FlateDecode) -> admitted without double-counting
  const parityPath = path.join(dir, 'parity-xmp-flate.ai');
  const rawLinks = Array.from({ length: 4000 }, (_, i) => `/Users/synthetic-swift-budget/img-${i}.png`);
  const xmpDupes = rawLinks.map(p => `<stRef:filePath>${p}</stRef:filePath>`);
  const inflatedPayload = zlib.deflateSync(Buffer.from(rawLinks.join('\n')));
  const streamBlock = Buffer.concat([
    Buffer.from('1 0 obj\n<< /Filter /FlateDecode /Length '),
    Buffer.from(`${inflatedPayload.length} >>\nstream\n`),
    inflatedPayload,
    Buffer.from('\nendstream\nendobj\n'),
  ]);
  fs.writeFileSync(
    parityPath,
    Buffer.concat([
      Buffer.from('%PDF-1.6\n'),
      Buffer.from(`${rawLinks.join('\n')}\n${xmpDupes.join('\n')}\n`),
      streamBlock,
      Buffer.from('%%EOF\n'),
    ])
  );
  const parsed = await client.parsePdfAi(parityPath, { decompressStreams: true });
  assert.equal(parsed.incomplete, false);
  assert.equal(parsed.paths.length, 4000);

  // 4. 6,000 raw links + 4,001 NEW unseen FlateDecode links -> 10,001 charged -> pdf_ai_reference_limit
  const flateOverPath = path.join(dir, 'flate-over.ai');
  const rawSixK = Array.from({ length: 6000 }, (_, i) => `/Users/synthetic-swift-budget/raw-${i}.png`);
  const flateNew = Array.from({ length: 4001 }, (_, i) => `/Users/synthetic-swift-budget/flate-${i}.png`);
  const overPayload = zlib.deflateSync(Buffer.from(flateNew.join('\n')));
  fs.writeFileSync(
    flateOverPath,
    Buffer.concat([
      Buffer.from('%PDF-1.6\n'),
      Buffer.from(`${rawSixK.join('\n')}\n`),
      Buffer.from(`1 0 obj\n<< /Filter /FlateDecode /Length ${overPayload.length} >>\nstream\n`),
      overPayload,
      Buffer.from('\nendstream\nendobj\n%%EOF\n'),
    ])
  );
  await assert.rejects(
    () => client.parsePdfAi(flateOverPath, { decompressStreams: true }),
    error => error && error.code === 'pdf_ai_reference_limit'
  );
});

test('Swift parsePdfAi and parsePsd enforce per-request maxFileBytes at fstat and reject invalid limits (N1)', { skip: !hasNativeBinary }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-swift-max-bytes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = new NativeHelperClient(DEFAULT_BINARY_PATH);
  t.after(() => client.shutdown());

  // Benign ~1 KiB synthetic .ai and .psd fixtures
  const aiPath = path.join(dir, 'sample.ai');
  fs.writeFileSync(aiPath, `%PDF-1.6\n% ${'x'.repeat(1024)}\n/Users/synthetic-n1/a.png\n%%EOF\n`);
  const psdBytes = agPsd.writePsdBuffer({
    width: 4,
    height: 4,
    linkedFiles: [{
      id: '66666666-6666-4666-8666-666666666666',
      name: 'a.png',
      childDocumentID: '',
      linkedFile: {
        fullPath: '/Users/synthetic-n1/a.png',
        originalPath: '/Users/synthetic-n1/a.png',
        relativePath: '',
        name: 'a.png',
        fileSize: 16,
      },
    }],
  });
  const psdPath = path.join(dir, 'sample.psd');
  fs.writeFileSync(psdPath, Buffer.concat([psdBytes, Buffer.alloc(1024)]));

  const aiSize = fs.statSync(aiPath).size;
  const psdSize = fs.statSync(psdPath).size;
  assert.ok(aiSize > 512 && psdSize > 512);

  // Under-size limit rejected directly at fstat with typed code
  await assert.rejects(
    () => client.parsePdfAi(aiPath, { decompressStreams: true, maxFileBytes: 512 }),
    error => error && error.code === 'pdf_ai_too_large'
  );
  await assert.rejects(
    () => client.parsePsd(psdPath, { maxFileBytes: 512 }),
    error => error && error.code === 'psd_too_large'
  );

  // Exact file size limit succeeds
  const aiOk = await client.parsePdfAi(aiPath, { decompressStreams: true, maxFileBytes: aiSize });
  assert.deepEqual(aiOk.paths, ['/Users/synthetic-n1/a.png']);
  const psdOk = await client.parsePsd(psdPath, { maxFileBytes: psdSize });
  assert.deepEqual(psdOk.linkedPaths, ['/Users/synthetic-n1/a.png']);

  // Non-positive or non-integer maxFileBytes rejected explicitly (never treated as absent)
  for (const badLimit of [0, -1, 1.5, true, '512']) {
    await assert.rejects(
      () => client.parsePdfAi(aiPath, { decompressStreams: true, maxFileBytes: badLimit }),
      error => error && error.code === 'invalid_max_file_bytes'
    );
    await assert.rejects(
      () => client.parsePsd(psdPath, { maxFileBytes: badLimit }),
      error => error && error.code === 'invalid_max_file_bytes'
    );
  }
});

test('Swift PdfAiParser charges failed FlateDecode attempts & produced bytes and bounds unterminated stream scans (N2)', { skip: !hasNativeBinary }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-swift-flate-fail-budget-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = new NativeHelperClient(DEFAULT_BINARY_PATH);
  t.after(() => client.shutdown());

  // 1. >512 tiny invalid-zlib FlateDecode streams must charge streamAttempts and hit flate-stream-count-limit
  const badStreamParts = [Buffer.from('%PDF-1.6\n')];
  for (let i = 1; i <= 520; i += 1) {
    badStreamParts.push(Buffer.from(`${i} 0 obj\n<< /Filter /FlateDecode /Length 8 >>\nstream\nnot-zlib\nendstream\nendobj\n`));
  }
  badStreamParts.push(Buffer.from('%%EOF\n'));
  const badStreamsPath = path.join(dir, 'invalid-flate-count.ai');
  fs.writeFileSync(badStreamsPath, Buffer.concat(badStreamParts));

  const badCountRes = await client.parsePdfAi(badStreamsPath, { decompressStreams: true });
  assert.equal(badCountRes.incomplete, true);
  assert.equal(badCountRes.compressedStreamsScanned, 0, 'failed streams must not inflate compressedStreamsScanned');
  assert.ok(badCountRes.issues.includes('flate-stream-budget-or-decode'));
  assert.ok(badCountRes.issues.includes('flate-stream-count-limit'), 'failed attempts must still exhaust the 512-stream cap');

  // 2. 10 benign streams that each expand slightly over 8 MiB must debit produced bytes on failure
  //    and stop at flate-total-output-limit (64 MiB)
  const nineMbSpacesCompressed = zlib.deflateSync(Buffer.alloc(9 * 1024 * 1024, 0x20));
  const overOutParts = [Buffer.from('%PDF-1.6\n')];
  for (let i = 1; i <= 10; i += 1) {
    overOutParts.push(Buffer.from(`${i} 0 obj\n<< /Filter /FlateDecode /Length ${nineMbSpacesCompressed.length} >>\nstream\n`));
    overOutParts.push(nineMbSpacesCompressed);
    overOutParts.push(Buffer.from('\nendstream\nendobj\n'));
  }
  overOutParts.push(Buffer.from('%%EOF\n'));
  const overOutPath = path.join(dir, 'over-output-flate.ai');
  fs.writeFileSync(overOutPath, Buffer.concat(overOutParts));

  const overOutRes = await client.parsePdfAi(overOutPath, { decompressStreams: true });
  assert.equal(overOutRes.incomplete, true);
  assert.equal(overOutRes.compressedStreamsScanned, 0);
  assert.ok(overOutRes.issues.includes('flate-stream-budget-or-decode'));
  assert.ok(overOutRes.issues.includes('flate-total-output-limit'), 'bytes produced before failure must exhaust the 64 MiB cap');

  // 3. Repeated unterminated `stream\n` markers with no `endstream` complete in linear time (no O(N^2) rescan)
  const unterminatedPath = path.join(dir, 'unterminated-streams.ai');
  const repeatedTokens = Buffer.from('<< /Filter /FlateDecode >>\nstream\n'.repeat(30000));
  fs.writeFileSync(unterminatedPath, Buffer.concat([Buffer.from('%PDF-1.6\n'), repeatedTokens, Buffer.from('\n%%EOF\n')]));

  const unterminatedRes = await client.parsePdfAi(unterminatedPath, { decompressStreams: true });
  assert.equal(unterminatedRes.incomplete, true);
  assert.ok(unterminatedRes.issues.includes('flate-endstream-unbounded'));
});
