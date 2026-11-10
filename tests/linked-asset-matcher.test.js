'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { extractLinkedAssetPaths, LINKED_ASSET_REGEX } = require('../parsers/linked-asset-matcher');
const worker = require('../parsers/add-files-regex-worker');
const { legacyPaths, source, flags } = require('./fixtures/linked-asset-legacy.cjs');
const { mainExtractor } = require('./fixtures/linked-asset-main.cjs');
const root = path.resolve(__dirname, '..');
const main = mainExtractor(root);

async function parity(buffer, filePath = '/synthetic/metadata.psd') {
  const expected = legacyPaths(buffer, filePath);
  assert.deepEqual(extractLinkedAssetPaths(buffer.toString('utf8'), filePath), expected);
  assert.deepEqual(worker.extractLinkedAssetsFromBuffer(buffer, filePath), expected);
  assert.deepEqual(Array.from(await main(filePath, { strict: true, sourceBuffer: buffer })), expected);
  return expected;
}

test('shared matcher grammar and production import stay bound to the frozen legacy oracle', () => {
  assert.equal(LINKED_ASSET_REGEX.source, source);
  assert.equal(LINKED_ASSET_REGEX.flags, flags);
  assert.equal(worker.LINKED_ASSET_REGEX, LINKED_ASSET_REGEX);
  assert.ok(fs.readFileSync(path.join(root, 'main.js'), 'utf8').includes("require('./parsers/linked-asset-matcher')"));
  assert.deepEqual([...worker.REGEX_SOURCE_EXTENSIONS], ['.ai', '.pdf', '.xd', '.ppt', '.fig']);
});

test('both callers preserve explicit output quirks, duplicates, order and self-skip', async () => {
  const cases = [
    ['', []], ['/Users/a.png', ['/Users/a.png']], ['/Users/.png', []],
    ['/Users/a.psb', []], ['/Users/a.woff2', ['/Users/a.woff2']],
    ['/Users/a.png /Users/a.png', ['/Users/a.png', '/Users/a.png']],
    ['/Users/no.psb /Volumes/disk/b.png', ['/Users/no.psb /Volumes/disk/b.png']],
    ['/Users/a.png/Users/b.jpg', ['/Users/a.png', '/Users/b.jpg']],
    ['/Users/a.png\0/Volumes/disk/b.tiff', ['/Users/a.png', '/Volumes/disk/b.tiff']],
    ['/USERS/a.PnG', ['/USERS/a.PnG']],
  ];
  for (const [input, expected] of cases) assert.deepEqual(await parity(Buffer.from(input)), expected);
  assert.deepEqual(await parity(Buffer.from('/Users/self.png /Users/other.png'), '/Users/self.png'), ['/Users/other.png']);
});

test('.woff2 and .woff both resolve whole through the shared matcher, worker and main', async () => {
  const cases = [
    ['/Users/a/Brand.woff2', ['/Users/a/Brand.woff2']],
    ['/Users/a/Brand.woff', ['/Users/a/Brand.woff']],
    ['/Users/a/Brand.WOFF2', ['/Users/a/Brand.WOFF2']],
    ['/Users/a/Brand.woff2x', ['/Users/a/Brand.woff2']],
    ['/Users/a/Brand.woffx', ['/Users/a/Brand.woff']],
    ['/Volumes/disk/One.woff2 /Users/a/Two.woff', ['/Volumes/disk/One.woff2', '/Users/a/Two.woff']],
  ];
  for (const [input, expected] of cases) assert.deepEqual(await parity(Buffer.from(input)), expected);
});

test('no product link pattern lists woff before woff2, and every inline copy reads .woff2 whole', () => {
  const files = ['main.js', ...fs.readdirSync(path.join(root, 'parsers')).filter(name => name.endsWith('.js')).map(name => path.join('parsers', name))];
  let groups = 0;
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const group of source.match(/\((?:[a-z0-9]+\|)+[a-z0-9]+\)/gi) || []) {
      const names = group.slice(1, -1).split('|');
      if (!names.includes('woff')) continue;
      groups++;
      assert.ok(names.includes('woff2') && names.indexOf('woff2') < names.indexOf('woff'), `${file}: ${group}`);
    }
  }
  assert.equal(groups, 8, 'shared matcher plus seven inline main.js copies');
  const inline = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
    .match(/const LINKED_ASSET_REGEX(?:_SNAPSHOT)? = \/.+\/gi;/g) || [];
  assert.equal(inline.length, 7);
  for (const line of inline) {
    const literal = line.slice(line.indexOf('= /') + 3, line.lastIndexOf('/gi;'));
    const regex = new RegExp(literal, 'gi');
    assert.deepEqual('/Users/a/Brand.woff2'.match(regex), ['/Users/a/Brand.woff2'], line);
    assert.deepEqual('/Users/a/Brand.woff'.match(regex), ['/Users/a/Brand.woff'], line);
    assert.deepEqual('/Users/a/Brand.WOFF2x'.match(regex), ['/Users/a/Brand.WOFF2'], line);
  }
});

test('every legacy extension and excluded separator keeps identical output in both callers', async () => {
  for (const ext of ['jpg','jpeg','png','gif','webp','svg','pdf','eps','ai','psd','tiff','tif','afdesign','afphoto','afpub','indd','idml','sketch','fig','heic','ttf','otf','woff','woff2','mp4','mov','avi','webm']) {
    await parity(Buffer.from(`/Volumes/disk/asset.${ext} /Users/other.${ext.toUpperCase()}`));
  }
  for (const code of [...Array.from({ length: 32 }, (_, i) => i), 34, 39]) {
    await parity(Buffer.concat([Buffer.from('/Users/unfinished.psb'), Buffer.from([code]), Buffer.from('/Volumes/disk/valid.png')]));
  }
});

test('UTF8 replacement and Unicode prefix behavior are unchanged in both callers', async () => {
  for (let byte = 128; byte < 256; byte++) {
    await parity(Buffer.concat([Buffer.from('/Users/'), Buffer.from([byte]), Buffer.from('.png /Users/no.psb')]));
  }
  for (const input of ['/Uſers/a.png', '/Users/emoji-😀.png', '/Users/a\u2028.png', '/Users/e\u0301.psb /Volumes/disk/é.png']) {
    await parity(Buffer.from(input));
  }
});

test('20000 deterministic mixed inputs match an independent oracle at both callers', async () => {
  const tokens = ['/Users/','/Volumes/','/users/','/volumeS/','/Users/.png','/Users/no.psb','.jpg','.jpeg','.png','.psd','.psb','.pdf','.woff2','.tiff','a','b',' ','\n','\0','"',"'",'😀','ſ','/','.','\\','/Users/nested/','/Users/self.png'];
  let state = 0x149e1234;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  let positive = 0, empty = 0, matches = 0;
  for (let i = 0; i < 20000; i++) {
    let content = '';
    const count = next() % 45;
    for (let n = 0; n < count; n++) content += tokens[next() % tokens.length];
    const paths = await parity(Buffer.from(content), i % 7 === 0 ? '/Users/self.png' : '/synthetic/metadata.psd');
    if (paths.length) positive++; else empty++;
    matches += paths.length;
  }
  assert.deepEqual({ positive, empty, matches }, { positive: 16344, empty: 3656, matches: 51209 });
});

test('entry index is explicitly zero for both callers despite external mutation of the compatibility export', async () => {
  const buffer = Buffer.from('/Users/a.png /Users/b.jpg');
  try {
    worker.LINKED_ASSET_REGEX.lastIndex = 13;
    assert.deepEqual(await parity(buffer), ['/Users/a.png', '/Users/b.jpg']);
    assert.deepEqual(await parity(buffer), ['/Users/a.png', '/Users/b.jpg']);
  } finally { worker.LINKED_ASSET_REGEX.lastIndex = 0; }
});

test('valid AI/PDF headers and source identity/digest validation remain in the worker', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-linked-source-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const ext of ['.ai', '.pdf']) {
    const file = path.join(dir, 'Source' + ext);
    const buffer = Buffer.from('%PDF-1.7\n/Users/synthetic/linked.png\n%%EOF\n');
    fs.writeFileSync(file, buffer);
    const result = worker.parseRegex(file), stat = fs.statSync(file);
    assert.deepEqual(result.paths, ['/Users/synthetic/linked.png']);
    assert.equal(result.sourceDigest, crypto.createHash('sha256').update(buffer).digest('hex'));
    assert.deepEqual(result.sourceIdentity, { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs });
    assert.throws(() => worker.extractLinkedAssetsFromBuffer(Buffer.from('/Users/required.png'), file, ext), /invalid_structure/);
  }
});

test('main keeps strict/permissive failure and size-limit callbacks, and worker rejects oversized sources', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-linked-limits-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const oversized = path.join(dir, 'Large.psd');
  const fd = fs.openSync(oversized, 'w');
  fs.ftruncateSync(fd, worker.MAX_PARSE_FILE_SIZE + 1); fs.closeSync(fd);
  let failures = 0, limits = 0;
  assert.deepEqual(Array.from(await main(oversized, { onOrdinaryScanLimit: reason => { assert.equal(reason, 'source-too-large'); limits++; } })), []);
  assert.equal(limits, 1);
  await assert.rejects(main(oversized, { strict: true }), /source_too_large/);
  assert.throws(() => worker.parseRegex(oversized), /source_too_large/);
  const missing = path.join(dir, 'missing.psd');
  assert.deepEqual(Array.from(await main(missing, { onOrdinaryScanFailure: () => failures++ })), []);
  assert.equal(failures, 1);
  await assert.rejects(main(missing, { strict: true, onOrdinaryScanFailure: () => failures++ }), /ENOENT/);
  assert.equal(failures, 1);
});

test('main retains validated-result, supplied-buffer and worker-delegation branches', async t => {
  const noRead = new Proxy({}, { get() { throw new Error('unexpected-disk-access'); } });
  const buffered = mainExtractor(root, { fs: noRead });
  assert.deepEqual(Array.from(await buffered('/synthetic/source', { strict: true, sourceBuffer: Buffer.from('/Users/a.png') })), ['/Users/a.png']);
  assert.deepEqual(Array.from(await buffered('/synthetic/source', { validatedRegexResult: { paths: ['/Users/validated.png'] } })), ['/Users/validated.png']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-linked-delegate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'Source.ai'); fs.writeFileSync(file, '%PDF-1.7\n/Users/a.png\n%%EOF\n');
  const lease = { syntheticIdentity: 'unchanged' }; let called = 0;
  const delegated = mainExtractor(root, { worker: async (received, receivedLease) => {
    assert.equal(received, file); assert.equal(receivedLease, lease); called++;
    return worker.parseRegex(received);
  } });
  assert.deepEqual(Array.from(await delegated(file, { strict: true, addFilesAttempt: lease })), ['/Users/a.png']);
  assert.equal(called, 1);
});

test('high match counts do not overflow a spread-call argument limit in main', async () => {
  const count = 180000;
  const paths = await main('/synthetic/metadata.psd', { strict: true, sourceBuffer: Buffer.from('/Users/a.png\n'.repeat(count)) });
  assert.equal(paths.length, count);
  assert.equal(paths[0], '/Users/a.png'); assert.equal(paths.at(-1), '/Users/a.png');
});

test('structured PSD/PSB metadata retains dependency matches without PSB suppression', async () => {
  const ag = require('ag-psd');
  const psb = ag.writePsdBuffer({ width: 1, height: 1, imageResources: { xmpMetadata: '/Users/not-an-asset.psb\n/Volumes/disk/linked.png' } }, { psb: true });
  const source = ag.writePsdBuffer({ width: 1, height: 1, linkedFiles: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Embedded.psb', data: psb }] });
  assert.deepEqual(Buffer.from(ag.readPsd(source, { skipLayerImageData: true, skipCompositeImageData: true }).linkedFiles[0].data), psb);
  await parity(source);
});

for (const route of ['main', 'worker']) {
  test(`${route}: near-miss prefix storm completes within an external child budget`, { timeout: 10000 }, t => {
    const child = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/linked-asset-probe.cjs')], {
      input: JSON.stringify({ root, route, repeats: 42000 }), encoding: 'utf8', timeout: 5000,
    });
    assert.ifError(child.error); assert.equal(child.status, 0, child.stderr);
    const row = JSON.parse(child.stdout); assert.equal(row.count, 0); assert.equal(row.bytes, 1134000);
    assert.equal(row.timedOut, false); assert.equal(row.cancelled, false);
    t.diagnostic(JSON.stringify(row));
  });
}

test('timer deadlines are characterized as scheduled callbacks, not synchronous preemption or package admission proof', t => {
  const child = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/linked-asset-probe.cjs')], {
    input: JSON.stringify({ root, route: 'main', repeats: 42000, leaseMs: 0 }), encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(child.error); assert.equal(child.status, 0, child.stderr);
  const row = JSON.parse(child.stdout);
  assert.ok(row.elapsedMs > 0); assert.equal(row.leaseAtReturn, 'active'); assert.equal(row.leaseAtOutcome, 'active');
  assert.equal(row.timedOut, false); assert.equal(row.cancelled, false); assert.equal(row.count, 0);
  t.diagnostic(JSON.stringify(row));
});
