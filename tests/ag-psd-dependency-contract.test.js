'use strict';

// Contract for the pinned ag-psd reader (GHSA-6w3r-6hpr-hp6p remediation).
// Crate only reads PSD metadata. These tests pin the dependency, keep every
// production read metadata-only with a zero bitmap budget, and record the
// stricter 31.0.2+ layer/mask bounds as controlled failures.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const agPsd = require('ag-psd');

// Observe the options production passes. Both parsers bind readPsd when they
// load, so the spy must be installed before they are required.
const realReadPsd = agPsd.readPsd;
const readCalls = [];
agPsd.readPsd = function observedReadPsd(buffer, options) {
  const call = { options: { ...options }, result: undefined };
  readCalls.push(call);
  call.result = realReadPsd.call(this, buffer, options);
  return call.result;
};
const { parsePsd, startAddFilesPsdWorker } = require('../parsers/add-files-psd-worker');
const { PSDParser } = require('../parsers/psd');

const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const i16 = n => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const i32 = n => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const section = (body, large = false) => Buffer.concat([large ? Buffer.concat([u32(0), u32(body.length)]) : u32(body.length), body]);
const pad2 = body => Buffer.concat([body, Buffer.alloc(body.length % 2)]);

function header({ version = 1, depth = 8 } = {}) {
  return Buffer.concat([Buffer.from('8BPS'), u16(version), Buffer.alloc(6), u16(3), u32(1), u32(1), u16(depth), u16(3),
    section(Buffer.alloc(0)), section(Buffer.alloc(0))]);
}
const imageData = Buffer.concat([u16(0), Buffer.alloc(6)]);

// One layer record with no channels. `mask` adds a 20-byte layer mask record.
function layerPsd({ box, mask = null, version = 1, depth = 8 }) {
  const large = version === 2;
  const [top, left, bottom, right] = box;
  const extra = mask === null ? Buffer.alloc(0) : Buffer.concat([
    section(Buffer.concat([...mask.map(i32), Buffer.from([0, 0]), Buffer.alloc(2)])), // box, default colour, flags, padding
    section(Buffer.alloc(0)), // blending ranges
    Buffer.from([0, 0, 0, 0]), // empty Pascal name padded to 4
  ]);
  const record = Buffer.concat([i32(top), i32(left), i32(bottom), i32(right), u16(0), Buffer.from('8BIMnorm'),
    Buffer.from([255, 0, 0, 0]), section(extra)]);
  const layerInfo = section(pad2(Buffer.concat([i16(1), record])), large);
  return Buffer.concat([header({ version, depth }), section(layerInfo, large), imageData]);
}

// A global `Patt` block declaring a document pattern of width x height.
function patternPsd(width, height) {
  const body = Buffer.concat([u32(1), u32(3), i16(0), i16(0), u32(0), Buffer.from([0]), // version, RGB, x, y, name, id
    u32(3), u32(0), u32(0), u32(0), u32(height), u32(width), u32(0), u32(0), u32(0)]); // VMAL bounds, no channels
  const pattern = Buffer.concat([u32(body.length), body, Buffer.alloc((4 - body.length % 4) % 4)]);
  const block = Buffer.concat([Buffer.from('8BIMPatt'), u32(pattern.length), pattern, Buffer.alloc(pattern.length % 2)]);
  return Buffer.concat([header(), section(Buffer.concat([u32(0), u32(0), block])), imageData]);
}

function tempFile(t, name, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-ag-psd-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

// Drive the real worker protocol over an in-memory port, acknowledging records.
function runWorker(filePath) {
  return new Promise(resolve => {
    const messages = [];
    let receive;
    const port = {
      on: (_event, handler) => { receive = handler; },
      postMessage(message) {
        messages.push(message);
        if (message.type === 'error') return; // every other message, including result, awaits an ACK
        queueMicrotask(() => receive({ data: { type: 'ack', sessionId: 'contract', seq: message.seq } }));
      },
    };
    startAddFilesPsdWorker(port, { exit: () => resolve(messages) });
    receive({ data: { type: 'parse', filePath, sessionId: 'contract' } });
  });
}

const PRODUCTION_FILES = ['main.js', ...fs.readdirSync(path.join(root, 'parsers'))
  .filter(name => name.endsWith('.js')).map(name => path.join('parsers', name))];

function readPsdCallsites() {
  const calls = [];
  for (const file of PRODUCTION_FILES) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const pattern = /\breadPsd\(/g;
    let match;
    while ((match = pattern.exec(source))) {
      let depth = 0, end = match.index + match[0].length - 1;
      for (; end < source.length; end++) {
        if (source[end] === '(') depth++;
        else if (source[end] === ')' && --depth === 0) break;
      }
      calls.push({ file, line: source.slice(0, match.index).split('\n').length, text: source.slice(match.index, end + 1) });
    }
  }
  return calls;
}

test('ag-psd is pinned to exactly 31.0.3 in the manifest, lock and installed tree', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(manifest.dependencies['ag-psd'], '31.0.3');
  assert.equal(lock.packages[''].dependencies['ag-psd'], '31.0.3');
  assert.deepEqual(
    (({ version, resolved, integrity }) => ({ version, resolved, integrity }))(lock.packages['node_modules/ag-psd']),
    {
      version: '31.0.3',
      resolved: 'https://registry.npmjs.org/ag-psd/-/ag-psd-31.0.3.tgz',
      integrity: 'sha512-THDYK+WK1F5GOH4G0l4wkQRc0Cyq5tnxIwBezACKwa6idKygphnGgMISr4lmW6n0Q89ceoqpdPZQF3Y7TL1pgg==',
    });
  assert.equal(require('ag-psd/package.json').version, '31.0.3');
});

test('internal ag-psd entry points Crate imports keep their call shapes', () => {
  const { createReader } = require('ag-psd/dist/psdReader');
  const { readVersionAndDescriptor } = require('ag-psd/dist/descriptor');
  const writer = require('ag-psd/dist/psdWriter');
  assert.equal(typeof createReader, 'function');
  assert.equal(typeof readVersionAndDescriptor, 'function');
  const reader = createReader(new Uint8Array(8).buffer, 2, 4);
  assert.equal(reader.view.byteLength, 4);
  assert.equal(reader.offset, 0);
  for (const name of ['createWriter', 'getWriterBuffer', 'writeAsciiString', 'writeBytes', 'writeFloat64', 'writeInt32',
    'writeSignature', 'writeUint32', 'writeUint8', 'writeUnicodeString', 'writeUnicodeStringWithPadding']) {
    assert.equal(typeof writer[name], 'function', name);
  }
});

test('the advisory memory limit is enforced by the pinned reader', () => {
  // Scaled GHSA-6w3r-6hpr-hp6p shape: a 2000x2000 16-bit layer from a tiny file.
  const bytes = layerPsd({ box: [0, 0, 2000, 2000], depth: 16 });
  assert.ok(bytes.length < 128);
  assert.throws(() => realReadPsd(bytes, { useImageData: true, totalMemoryLimit: 1024 }), /Exceeded memory limit/);
});

test('every production readPsd call is metadata-only with a zero bitmap budget', () => {
  const calls = readPsdCallsites();
  assert.deepEqual(calls.map(call => call.file).sort(),
    ['main.js', 'main.js', 'main.js', 'main.js', 'main.js', 'parsers/add-files-psd-worker.js', 'parsers/psd.js'],
    'a new readPsd callsite must be reviewed and added here');
  for (const call of calls) {
    for (const option of [/skipLayerImageData: true/, /skipCompositeImageData: true/, /totalMemoryLimit: 0\b/]) {
      assert.match(call.text, option, `${call.file}:${call.line} ${call.text}`);
    }
  }
  const imports = PRODUCTION_FILES.flatMap(file => fs.readFileSync(path.join(root, file), 'utf8')
    .split('\n').filter(line => line.includes("require('ag-psd")).map(line => `${file}: ${line.trim()}`));
  assert.deepEqual(imports, [
    "main.js: const { readPsd } = require('ag-psd');",
    "parsers/add-files-psd-worker.js: const { readPsd } = require('ag-psd');",
    "parsers/add-files-psd-worker.js: const { createReader } = require('ag-psd/dist/psdReader');",
    "parsers/add-files-psd-worker.js: const { readVersionAndDescriptor } = require('ag-psd/dist/descriptor');",
    "parsers/psd.js: const { readPsd } = require('ag-psd');",
  ]);
});

for (const [label, width, height] of [['large declared', 4000, 4000], ['1x1', 1, 1]]) {
  test(`document pattern (${label}) is never decoded by the production readers`, async t => {
    const bytes = patternPsd(width, height);
    assert.ok(bytes.length < 160);
    // Control: the pinned reader decodes this pattern without Crate's budget.
    if (width === 1) {
      assert.equal(realReadPsd(bytes, { skipLayerImageData: true, skipCompositeImageData: true }).patterns.length, 1);
    }
    const file = tempFile(t, 'pattern.psd', bytes);
    readCalls.length = 0;
    const decodedBytes = psd => psd.patterns?.map(pattern => pattern.data.byteLength);
    const parsed = parsePsd(file);
    assert.equal(decodedBytes(parsed.psd), undefined);
    assert.equal(await new PSDParser().extractAssets(file).then(assets => assets.length), 0);
    assert.equal(readCalls.length, 2);
    for (const call of readCalls) {
      assert.deepEqual(call.options, { skipLayerImageData: true, skipCompositeImageData: true, totalMemoryLimit: 0 });
      assert.equal(decodedBytes(call.result), undefined);
    }
  });
}

test('the zero budget leaves linked metadata and embedded bytes unchanged', async t => {
  const id = '11111111-1111-4111-8111-111111111111', embeddedId = '22222222-2222-4222-8222-222222222222';
  const bytes = agPsd.writePsdBuffer({ width: 2, height: 2,
    children: [{ name: 'group', children: [{ id: 7, name: 'smart', placedLayer: { id, type: 'raster', transform: [0, 0, 2, 0, 2, 2, 0, 2], width: 2, height: 2 } }] }],
    linkedFiles: [
      { id, name: 'Linked ü.png', childDocumentID: '', linkedFile: { fileSize: 5, name: 'Linked ü.png', fullPath: '/Users/synthetic/Linked ü.png', originalPath: '/Users/synthetic/Linked ü.png', relativePath: '' } },
      { id: embeddedId, name: 'Inside.png', childDocumentID: '', data: Buffer.alloc(2 * 1024 * 1024 + 3, 7) },
    ] });
  const strip = value => JSON.stringify(value, (_key, v) => ArrayBuffer.isView(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') : v);
  const unbudgeted = realReadPsd(bytes, { skipLayerImageData: true, skipCompositeImageData: true });
  const file = tempFile(t, 'linked.psd', bytes);
  readCalls.length = 0;
  const parsed = parsePsd(file);
  assert.equal(strip(parsed.psd), strip(unbudgeted));
  assert.equal(parsed.psd.linkedFiles.find(file => file.id === embeddedId).data.byteLength, 2 * 1024 * 1024 + 3);
  assert.equal(parsed.psd.children[0].children[0].placedLayer.id, id);
  assert.equal(parsed.framing.status, 'framed');
  assert.deepEqual(await new PSDParser().extractAssets(file).then(assets => assets.map(asset => asset.path)), ['/Users/synthetic/Linked ü.png']);
});

const ACCEPTED_BOXES = [
  ['PSD layer at 30000 px', { box: [0, 0, 1, 30000] }],
  ['PSD layer mask at 30000 px', { box: [0, 0, 1, 1], mask: [0, 0, 1, 30000] }],
  ['PSB layer at 300000 px', { box: [0, 0, 1, 300000], version: 2 }],
];
const REJECTED_BOXES = [
  ['PSD layer at 30001 px', { box: [0, 0, 1, 30001] }, /Invalid layer size/],
  ['PSD layer with negative extent', { box: [10, 10, 5, 5] }, /Invalid layer size/],
  ['PSD layer mask at 30001 px', { box: [0, 0, 1, 1], mask: [0, 0, 1, 30001] }, /Invalid mask size/],
  ['PSD layer mask with negative extent', { box: [0, 0, 1, 1], mask: [10, 10, 5, 5] }, /Invalid mask size/],
  ['PSB layer at 300001 px', { box: [0, 0, 1, 300001], version: 2 }, /Invalid layer size/],
];

for (const [label, shape] of ACCEPTED_BOXES) {
  test(`${label} still parses`, async t => {
    const file = tempFile(t, shape.version === 2 ? 'boundary.psb' : 'boundary.psd', layerPsd(shape));
    assert.equal(parsePsd(file).psd.children.length, 1);
    const messages = await runWorker(file);
    assert.equal(messages.at(-1).type, 'result');
  });
}

for (const [label, shape, reason] of REJECTED_BOXES) {
  test(`${label} fails closed instead of reporting an empty scan`, async t => {
    const file = tempFile(t, shape.version === 2 ? 'oversized.psb' : 'oversized.psd', layerPsd(shape));
    assert.throws(() => parsePsd(file), reason);
    await assert.rejects(new PSDParser().extractAssets(file), reason);
    const messages = await runWorker(file);
    assert.deepEqual(messages.map(message => message.type), ['error']);
    assert.equal(messages[0].error, 'asset_baseline_psd_worker_failed');
  });
}
