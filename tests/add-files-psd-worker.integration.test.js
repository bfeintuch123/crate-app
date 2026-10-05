'use strict';

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createAddFilesScanLease } = require('../parsers/add-files-operation');
const { startAddFilesPsdWorker, inspectPsdLinkFraming } = require('../parsers/add-files-psd-worker');

let agPsd = null;
try {
  agPsd = require('ag-psd');
} catch (_) {
  // The source-only test environment may not have reconstructed dependencies.
}

const workerPath = path.join(__dirname, '..', 'parsers', 'add-files-psd-worker.js');

function createSyntheticPsd(bytes = 'embedded-worker-bytes') {
  const linkedId = '11111111-1111-4111-8111-111111111111';
  const embeddedId = '22222222-2222-4222-8222-222222222222';
  return agPsd.writePsdBuffer({
    width: 1,
    height: 1,
    channels: 3,
    bitsPerChannel: 8,
    colorMode: 3,
    children: [{
      name: 'linked smart object',
      placedLayer: {
        id: linkedId,
        type: 'raster',
        transform: [0, 0, 1, 0, 1, 1, 0, 1],
        width: 1,
        height: 1,
      },
    }],
    linkedFiles: [
      {
        id: linkedId,
        name: 'external.png',
        childDocumentID: '',
        linkedFile: {
          fileSize: 10,
          name: 'external.png',
          fullPath: '/Users/synthetic/external.png',
          originalPath: '/Users/synthetic/external.png',
          relativePath: '',
        },
      },
      {
        id: embeddedId,
        name: 'embedded.png',
        data: Buffer.from(bytes),
      },
    ],
  });
}

// Actual main coordinator/transaction code; only application startup is omitted.
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function section(start, end) {
  const a = main.indexOf(start), b = main.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a);
  return main.slice(a, b);
}
const production = [
  section('function sanitizeEmbeddedPsdAssetName(', 'function getEmbeddedPsdDedupKey('),
  section('function cacheSafetyError(', 'function ensureSafeCacheSegment('),
  section('function safeCacheTempPath(', 'function openVerifiedCacheFileSync('),
  section('function getAddFilesSourceIdentity(', 'async function assertDependableAssetBaselineSource('),
  section('async function getAddFilesCurrentSourceDigest(', '\n/**'),
].join('\n');
const turn = () => new Promise(resolve => setImmediate(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function harness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-psd-transfer-'));
  const children = new Set();
  const finishes = [];
  t.after(async () => { for (const child of children) child.kill(); await Promise.all(finishes.map(finish => finish())); fs.rmSync(root, { recursive: true, force: true }); });
  const events = [];
  const fsView = { ...fs, promises: { ...fs.promises, ...options.io } };
  const context = { fs: fsView, path, os: { tmpdir: () => root }, crypto, process, Buffer, Uint8Array, ArrayBuffer,
    setImmediate, console, MAX_PARSE_FILE_SIZE: 300 * 1024 * 1024, OWNER_ONLY_FILE_MODE: 0o600,
    ADD_FILES_PSD_WORKER_PATH: workerPath,
    ADD_FILES_REGEX_WORKER_PATH: path.join(path.dirname(workerPath), 'add-files-regex-worker.js'),
    utilityProcess: { fork(modulePath) {
      let child;
      if (options.parsed) {
        child = new EventEmitter();
        let receiver;
        let dead = false;
        child.kill = () => { if (!dead) { dead = true; child.emit('exit', 0); } return true; };
        startAddFilesPsdWorker({
          on: (_, fn) => { receiver = fn; },
          postMessage: message => { if (!dead) queueMicrotask(() => child.emit('message', message)); },
        }, { parse: () => structuredClone(options.parsed), exit: () => child.kill() });
        child.postMessage = message => { if (!dead) receiver({ data: message }); };
        queueMicrotask(() => child.emit('spawn'));
      } else {
        child = fork(modulePath, [], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        child.postMessage = message => child.send(message);
      }
      const post = child.postMessage;
      child.postMessage = message => { events.push({ direction: 'ack', type: message.type, seq: message.seq }); options.onAck?.(message); post(message); };
      child.on('message', message => {
        // Node advanced IPC embeds decoded views inside its framing packet.
        // Model Electron's exact backing here; genuine Electron is a separate gate.
        if (!options.parsed && message.bytes) message.bytes = new Uint8Array(message.bytes);
        events.push({ direction: 'worker', type: message.type, seq: message.seq, bytes: message.bytes?.byteLength }); options.onMessage?.(message, child); });
      children.add(child);
      child.once('exit', () => children.delete(child));
      return child;
    } },
  };
  vm.createContext(context);
  vm.runInContext(production, context);
  let counter = 0;
  const start = async (sourcePath = path.join(root, 'source.psd'), timeoutMs = 3000, sharedProjectId = null) => {
    const lease = createAddFilesScanLease({ timeoutMs });
    const release = await context.acquireAddFilesPsdTransferSlot(lease);
    const projectId = sharedProjectId || `test-${counter++}`;
    const transaction = context.createAddFilesPsdTransaction(projectId, lease, () => lease.current(), release);
    const promise = context.runAddFilesPsdWorker(sourcePath, lease, transaction);
    promise.catch(() => {});
    const finish = async () => { await transaction.finish(); lease.dispose(); };
    finishes.push(finish);
    return { lease, transaction, promise, finish, extractDir: path.join(root, 'crate-psd-extract-' + projectId) };
  };
  return { root, context, start, events, children, fsView };
}
const identity = { dev: 1, ino: 2, size: 10, mtimeMs: 100 };
function parsed(files = []) { return { psd: { linkedFiles: files }, sourceIdentity: identity, sourceDigest: 'a'.repeat(64) }; }

test('Node advanced IPC: actual PSD parser, coordinator, stage bytes, digest and normal exit', { timeout: 10000 }, async t => {
  assert.ok(agPsd, 'prepared ag-psd dependency required');
  const h = harness(t);
  const source = path.join(h.root, 'source.psd');
  fs.writeFileSync(source, createSyntheticPsd());
  const run = await h.start(source);
  const result = await run.promise;
  assert.equal(result.entries[0].filePath, '/Users/synthetic/external.png');
  assert.equal(result.linkedInventory.references[0].rawPaths.fullPath, '/Users/synthetic/external.png');
  assert.equal(result.linkedInventory.associations[0].disposition, 'matched-parsed-id');
  assert.equal(result.linkedInventory.status, 'incomplete');
  assert.equal(result.linkedInventory.framing.parsedAgreement, true);
  assert.equal(result.sourceDigest, crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'));
  assert.equal(await h.context.getAddFilesCurrentSourceDigest(source, run.lease, result.sourceIdentity), result.sourceDigest);
  const assets = run.transaction.promote();
  assert.equal(fs.readFileSync(assets[0].filePath, 'utf8'), 'embedded-worker-bytes');
  run.transaction.assertReady();
  run.transaction.accept({ files: assets.map(asset => ({ path: asset.filePath })) });
  await run.finish();
  assert.equal(h.children.size, 0);
  assert.equal(fs.existsSync(assets[0].filePath), true);
});

for (const mode of ['present', 'missing', 'pathless', 'alias', 'empty']) {
  test(`actual PSD parser retains ${mode} linked inventory without inventing completeness`, async t => {
    const h = harness(t);
    const source = path.join(h.root, 'source.psd');
    const target = path.join(h.root, 'external.png');
    if (mode === 'present') fs.writeFileSync(target, 'external bytes');
    const linkedFiles = mode === 'empty' ? [] : [{
      id: '11111111-1111-4111-8111-111111111111', name: 'external.png', childDocumentID: '',
      ...(mode === 'alias' ? {} : { linkedFile: { fileSize: 14, name: 'external.png',
        fullPath: mode === 'pathless' ? '' : target, originalPath: 'file:///raw/original.png', relativePath: '../raw.png' } }),
    }];
    fs.writeFileSync(source, agPsd.writePsdBuffer({ width: 1, height: 1, channels: 3, bitsPerChannel: 8, colorMode: 3, linkedFiles }));
    const run = await h.start(source);
    const result = await run.promise;
    const inventory = result.linkedInventory;
    assert.equal(inventory.status, 'incomplete');
    assert.equal(inventory.reason, 'required-reference-domain-unverified');
    assert.equal(inventory.counts.linkedFiles, linkedFiles.length);
    if (mode === 'empty') assert.equal(inventory.records.length, 0);
    else if (mode === 'alias') assert.equal(inventory.records[0].disposition, 'unresolved-linked-record');
    else {
      assert.equal(inventory.references[0].rawPaths.originalPath, 'file:///raw/original.png');
      assert.equal(inventory.references[0].rawPaths.relativePath, '../raw.png');
      assert.equal(inventory.references[0].disposition, mode === 'pathless' ? 'unresolved-external' : 'external-reference');
      assert.equal(result.entries[0].filePath, mode === 'pathless' ? '' : target);
    }
    fs.appendFileSync(source, 'changed saved bytes');
    await assert.rejects(h.context.getAddFilesCurrentSourceDigest(source, run.lease, result.sourceIdentity), /source_changed/);
    await run.finish();
  });
}

test('parsed-field double retains external requirement alongside bytes, duplicate IDs and orphan associations', async t => {
  const value = parsed([
    { id: 'same-id', name: 'cached.bin', linkedFile: { fullPath: '/missing/external.bin', originalPath: 'raw token' }, data: new Uint8Array(8) },
    { id: 'same-id', name: 'alias.bin' },
  ]);
  value.psd.children = [{ placedLayer: { id: 'same-id', type: 'raster' }, children: [{ placedLayer: { id: 'orphan-id', type: 'raster' } }] }];
  const h = harness(t, { parsed: value });
  const run = await h.start();
  const result = await run.promise;
  assert.equal(result.linkedInventory.references[0].dataPresent, true);
  assert.equal(result.linkedInventory.references[0].disposition, 'external-reference');
  assert.equal(result.linkedInventory.references[0].rawPaths.originalPath, 'raw token');
  assert.deepEqual(Array.from(result.linkedInventory.associations, item => item.disposition), ['ambiguous-linked-id', 'unresolved-placed-id']);
  assert.ok(result.linkedInventory.unresolved.some(item => item.reason === 'unresolved-linked-record'));
  await run.finish();
});

test('actual parser layer-local carrier preserves raw links and embedded bytes independently of global records', async t => {
  const h = harness(t);
  const source = path.join(h.root, 'layer-carrier.psd');
  const id = '11111111-1111-4111-8111-111111111111';
  fs.writeFileSync(source, agPsd.writePsdBuffer({ width: 1, height: 1,
    children: [{ name: 'layer carrier', linkedFiles: [
      { id, name: 'external.png', childDocumentID: '', linkedFile: { fileSize: 10, name: 'external.png',
        fullPath: '/Users/synthetic/missing.png', originalPath: 'raw original', relativePath: '../missing.png' } },
      { id: '22222222-2222-4222-8222-222222222222', name: 'embedded.bin', data: Buffer.from('layer embedded bytes') },
    ] }] }));
  const run = await h.start(source);
  const result = await run.promise;
  assert.equal(result.entries[0].filePath, '/Users/synthetic/missing.png');
  const records = result.linkedInventory.records.filter(item => item.origin === 'linked-file');
  assert.deepEqual(Array.from(records, item => Array.from(item.layerPath)), [[0], [0]]);
  assert.equal(result.linkedInventory.references[0].rawPaths.originalPath, 'raw original');
  assert.equal(result.linkedInventory.counts.linkedFiles, 2);
  assert.equal(result.linkedInventory.status, 'incomplete');
  assert.equal(result.linkedInventory.framing.facts.status, 'framed');
  assert.equal(result.linkedInventory.framing.parsedAgreement, true);
  const assets = run.transaction.promote();
  assert.equal(fs.readFileSync(assets[0].filePath, 'utf8'), 'layer embedded bytes');
  await run.finish();
});

function aliasBytes() {
  return agPsd.writePsdBuffer({ width: 1, height: 1, linkedFiles: [
    { id: '11111111-1111-4111-8111-111111111111', name: 'alias.bin' },
  ] });
}

// Spec/pinned-reader-grounded synthetic descriptor. ag-psd's PxSc writer is
// disabled, so inject one declared additional-info block into a valid layer.
function videoBytes({ fullPath = '/Users/synthetic/missing.mov', pixelType = 1986285651,
  readerType = 1364477522, readerVersion = 1, descriptorVersion = 1, tail = 0 } = {}) {
  const w = require('ag-psd/dist/psdWriter');
  const writer = w.createWriter();
  const id = value => {
    w.writeUint32(writer, value.length === 4 ? 0 : value.length);
    w.writeAsciiString(writer, value);
  };
  // Explicit test-only Action Descriptor types avoid ag-psd's disabled PxSc
  // writer's unrelated key-type inference. No production encoder is added.
  function typedDescriptor(classId, fields) {
    w.writeUnicodeStringWithPadding(writer, ''); id(classId); w.writeUint32(writer, fields.length);
    for (const [key, type, value] of fields) {
      id(key); w.writeSignature(writer, type);
      if (type === 'Objc') typedDescriptor(value[0], value[1]);
      else if (type === 'long') w.writeInt32(writer, value);
      else if (type === 'doub') w.writeFloat64(writer, value);
      else if (type === 'TEXT') w.writeUnicodeString(writer, value);
      else if (type === 'bool') w.writeUint8(writer, value ? 1 : 0);
      else if (type === 'enum') { id(value[0]); id(value[1]); }
      else if (type === 'tdta') { w.writeInt32(writer, value.length); w.writeBytes(writer, value); }
      else if (type === 'alis') { w.writeInt32(writer, value.length); w.writeAsciiString(writer, value); }
      else throw new Error('unsupported synthetic fixture type');
    }
  }
  w.writeUint32(writer, 16);
  typedDescriptor('PixelSource', [
    ['pixelSourceType', 'long', pixelType], ['descVersion', 'long', descriptorVersion],
    ['origin', 'Objc', ['null', [['Hrzn', 'doub', 0], ['Vrtc', 'doub', 0]]]],
    ['interpretation', 'Objc', ['footageInterpretation', [
      ['Vrsn', 'long', 1], ['interpretAlpha', 'enum', ['alphaInterpretation', 'straight']], ['profile', 'tdta', new Uint8Array()],
    ]]],
    ['frameReader', 'Objc', ['FrameReader', [
      ['frameReaderType', 'long', readerType], ['descVersion', 'long', readerVersion],
      ['Lnk ', 'Objc', ['ExternalFileLink', [
        ['descVersion', 'long', 2], ['Nm  ', 'TEXT', 'movie.mov'], ['fullPath', 'TEXT', fullPath],
        ['originalPath', 'TEXT', 'file:///raw/original.mov'], ['relPath', 'TEXT', '../raw.mov'], ['alis', 'alis', 'raw-alias\u0000token'],
      ]]], ['mediaDescriptor', 'TEXT', ''],
    ]]], ['showAlteredVideo', 'bool', false],
  ]);
  const descriptor = Buffer.from(w.getWriterBuffer(writer));
  const payload = Buffer.concat([descriptor, Buffer.alloc(tail, 7)]);
  const block = Buffer.alloc(12 + payload.length + payload.length % 2);
  block.write('8BIM'); block.write('PxSc', 4); block.writeUInt32BE(payload.length, 8); payload.copy(block, 12);
  const original = agPsd.writePsdBuffer({ width: 1, height: 1, children: [{ id: 42, name: 'video layer' }] });
  const resourceLength = 30 + original.readUInt32BE(26);
  const maskLength = resourceLength + 4 + original.readUInt32BE(resourceLength);
  const layerLength = maskLength + 4;
  let offset = layerLength + 4 + 2 + 16;
  const channelCount = original.readUInt16BE(offset); offset += 2 + channelCount * 6 + 12;
  const extraLength = offset;
  const extraEnd = extraLength + 4 + original.readUInt32BE(extraLength);
  const bytes = Buffer.concat([original.subarray(0, extraEnd), block, original.subarray(extraEnd)]);
  for (const position of [extraLength, layerLength, maskLength]) {
    bytes.writeUInt32BE(original.readUInt32BE(position) + block.length, position);
  }
  return bytes;
}

for (const mode of ['missing', 'present', 'pathless', 'unknown-pixel', 'unknown-reader', 'reader-version', 'descriptor-version', 'tail']) {
  test(`actual parser PxSc ${mode} preserves wire tokens and explicit unsupported evidence`, async t => {
    const h = harness(t);
    const target = path.join(h.root, 'movie.mov');
    if (mode === 'present') fs.writeFileSync(target, 'synthetic media');
    const bytes = videoBytes({ fullPath: mode === 'pathless' ? '' : target,
      pixelType: mode === 'unknown-pixel' ? 99 : 1986285651, readerType: mode === 'unknown-reader' ? 99 : 1364477522,
      readerVersion: mode === 'reader-version' ? 2 : 1, descriptorVersion: mode === 'descriptor-version' ? 2 : 1,
      tail: mode === 'tail' ? 4 : 0 });
    const source = path.join(h.root, 'video.psd'); fs.writeFileSync(source, bytes);
    const run = await h.start(source); const result = await run.promise;
    const carrier = result.linkedInventory.framing.facts.mediaCarriers[0];
    assert.equal(carrier.carrier, 'PxSc'); assert.equal(carrier.layerId, 42);
    assert.equal(carrier.references[0].frameReader['Lnk '].alis, 'raw-alias\u0000token');
    assert.equal(carrier.references[0].frameReader['Lnk '].originalPath, 'file:///raw/original.mov');
    assert.equal(carrier.references[0].frameReader['Lnk '].relPath, '../raw.mov');
    assert.equal(result.linkedInventory.status, 'incomplete');
    assert.equal(result.sourceDigest, crypto.createHash('sha256').update(bytes).digest('hex'));
    if (mode === 'unknown-pixel') {
      assert.equal(result.linkedInventory.counts.mediaReferences, 0);
      assert.equal(result.linkedInventory.counts.wireMediaReferences, 1);
      assert.equal(result.linkedInventory.framing.mediaParsedAgreement, false);
      assert.ok(result.linkedInventory.unresolved.some(item => item.reason === 'unsupported-video-reader-type'));
    } else {
      assert.equal(result.linkedInventory.counts.mediaReferences, 1);
      assert.deepEqual(Array.from(result.linkedInventory.records.find(item => item.origin === 'media-reference').layerPath), [0]);
      assert.equal(result.entries[0].filePath, mode === 'pathless' ? '' : target);
      assert.equal(result.linkedInventory.framing.mediaParsedAgreement, mode !== 'unknown-reader');
    }
    if (['unknown-pixel', 'unknown-reader', 'reader-version', 'descriptor-version', 'tail'].includes(mode)) {
      assert.equal(result.linkedInventory.framing.facts.status, 'incomplete');
    }
    if (mode === 'pathless') assert.ok(result.linkedInventory.unresolved.some(item => item.reason === 'unresolved-media-reference'));
    await run.finish();
  });
}

for (const fault of ['type', 'version', 'overflow', 'truncation', 'signature', 'psb']) {
  test(`same-buffer framing ${fault} mutation stays incomplete and bounded`, () => {
    const bytes = Buffer.from(aliasBytes());
    const record = bytes.indexOf('liFA');
    assert.ok(record > 0);
    if (fault === 'type') bytes.write('liZZ', record, 'ascii');
    if (fault === 'version') bytes.writeUInt32BE(8, record + 4);
    if (fault === 'overflow') bytes.writeUInt32BE(1, record - 8);
    if (fault === 'signature') bytes.write('8B64', bytes.indexOf('lnk2') - 4, 'ascii');
    if (fault === 'psb') bytes.writeUInt16BE(2, 4);
    const facts = inspectPsdLinkFraming(fault === 'truncation' ? bytes.subarray(0, record + 10) : bytes);
    assert.equal(facts.status, 'incomplete');
    assert.ok(facts.issues.length > 0);
    if (fault === 'type') assert.equal(facts.records[0].type, 'liZZ');
    if (fault === 'version') assert.equal(facts.records[0].version, 8);
  });
}

test('actual parser ignores a link tail while the same-buffer framing retains refusal evidence', () => {
  const original = aliasBytes();
  const type = original.indexOf('liFA');
  const size = original.readUInt32BE(type - 4);
  const recordEnd = type + size;
  const bytes = Buffer.concat([original.subarray(0, recordEnd), Buffer.alloc(4, 7), original.subarray(recordEnd)]);
  bytes.writeUInt32BE(size + 4, type - 4);
  const blockLength = original.indexOf('lnk2') + 4;
  bytes.writeUInt32BE(original.readUInt32BE(blockLength) + 4, blockLength);
  const resourcesLength = 30 + original.readUInt32BE(26);
  const maskLength = resourcesLength + 4 + original.readUInt32BE(resourcesLength);
  bytes.writeUInt32BE(original.readUInt32BE(maskLength) + 4, maskLength);
  const parsedOriginal = agPsd.readPsd(original, { skipLayerImageData: true, skipCompositeImageData: true });
  const parsedChanged = agPsd.readPsd(bytes, { skipLayerImageData: true, skipCompositeImageData: true });
  assert.deepEqual(parsedChanged.linkedFiles, parsedOriginal.linkedFiles);
  const facts = inspectPsdLinkFraming(bytes);
  assert.equal(facts.status, 'incomplete');
  assert.equal(facts.records[0].tailBytes, 4);
  assert.ok(facts.issues.includes('unexplained-link-tail'));
});

test('unrelated image-resource note does not become a dependency failure or a complete verdict', () => {
  const original = aliasBytes();
  const lengthOffset = 30 + original.readUInt32BE(26);
  const start = lengthOffset + 4;
  const resource = Buffer.alloc(12);
  resource.write('8BIM'); resource.writeUInt16BE(65000, 4);
  const bytes = Buffer.concat([original.subarray(0, start), resource, original.subarray(start)]);
  bytes.writeUInt32BE(original.readUInt32BE(lengthOffset) + 12, lengthOffset);
  const facts = inspectPsdLinkFraming(bytes);
  assert.equal(facts.status, 'framed');
  assert.ok(facts.resourceIds.includes(65000));
  assert.equal(facts.records[0].id, inspectPsdLinkFraming(original).records[0].id);
  // Framed means positioning of the declared carrier domain, not irrelevance
  // of every possible resource or complete required-reference verification.
});

function audioBytes({ fullPath = '/Users/synthetic/missing.wav', readerType = 1, clips = 1 } = {}) {
  const zero = { numerator: 0, denominator: 1 }, second = { numerator: 1, denominator: 1 };
  return agPsd.writePsdBuffer({ width: 1, height: 1, imageResources: {
    timelineInformation: { enabled: true, frameStep: second, frameRate: 24, time: zero, duration: second,
      workInTime: zero, workOutTime: second, repeats: 0, hasMotion: true, globalTracks: [],
      audioClipGroups: [{ id: 'synthetic-group', muted: false, audioClips: Array.from({ length: clips }, (_, index) => ({ id: `synthetic-clip-${index}`,
        start: zero, duration: second, inTime: zero, outTime: second, muted: false, audioLevel: 0,
        frameReader: { type: readerType, mediaDescriptor: '', link: {
          name: 'missing.wav', fullPath, relativePath: '../missing.wav',
        } } })) }],
    },
  } });
}

test('actual parser timeline audio proves zero smart-object records is not complete required-reference evidence', async t => {
  const bytes = audioBytes();
  const parsed = agPsd.readPsd(bytes, { skipLayerImageData: true, skipCompositeImageData: true });
  assert.equal(parsed.imageResources.timelineInformation.audioClipGroups[0].audioClips[0].frameReader.link.fullPath,
    '/Users/synthetic/missing.wav');
  const h = harness(t); const source = path.join(h.root, 'timeline.psd'); fs.writeFileSync(source, bytes);
  const run = await h.start(source); const result = await run.promise;
  assert.equal(result.linkedInventory.framing.facts.records.length, 0);
  assert.ok(result.linkedInventory.framing.facts.resourceIds.includes(1075));
  assert.equal(result.linkedInventory.status, 'incomplete');
  assert.equal(result.linkedInventory.reason, 'wire-coverage-unverified');
  assert.equal(result.linkedInventory.framing.mediaParsedAgreement, true);
  assert.ok(result.linkedInventory.references.some(ref => ref.rawPaths.fullPath === '/Users/synthetic/missing.wav'));
  await run.finish();
});

for (const mode of ['pathless', 'unknown-reader', 'multiple']) {
  test(`actual parser timeline ${mode} retains clip association and unresolved evidence`, async t => {
    const h = harness(t);
    const bytes = audioBytes({ fullPath: mode === 'pathless' ? '' : '/Users/synthetic/missing.wav',
      readerType: mode === 'unknown-reader' ? 99 : 1, clips: mode === 'multiple' ? 3 : 1 });
    const source = path.join(h.root, 'audio.psd'); fs.writeFileSync(source, bytes);
    const run = await h.start(source); const result = await run.promise;
    const inventory = result.linkedInventory;
    assert.equal(inventory.status, 'incomplete');
    assert.equal(inventory.framing.mediaParsedAgreement, true);
    const carrier = inventory.framing.facts.mediaCarriers[0];
    assert.equal(carrier.references.length, mode === 'multiple' ? 3 : 1);
    for (const [index, ref] of carrier.references.entries()) {
      assert.equal(ref.clipIndex, index); assert.equal(ref.clipId, `synthetic-clip-${index}`);
      assert.equal(ref.groupIndex, 0); assert.equal(ref.groupId, 'synthetic-group');
      assert.equal(ref.frameReader.frameReaderType, mode === 'unknown-reader' ? 99 : 1);
      assert.equal(ref.frameReader['Lnk '].relPath, '../missing.wav');
      assert.equal(ref.reason, 'unverified-timeline-frame-reader-type');
    }
    assert.equal(inventory.counts.mediaReferences, carrier.references.length);
    assert.ok(inventory.unresolved.some(item => item.reason === 'unverified-timeline-frame-reader-type'));
    await run.finish();
  });
}

test('media descriptor decode error retains carrier digest and explicit unresolved evidence', () => {
  const bytes = videoBytes(); const body = bytes.indexOf('PxSc') + 8;
  bytes.writeUInt32BE(15, body); // Descriptor wrapper requires version 16.
  const facts = inspectPsdLinkFraming(bytes);
  assert.equal(facts.status, 'incomplete');
  assert.equal(facts.mediaCarriers[0].status, 'unresolved');
  assert.equal(facts.mediaCarriers[0].reason, 'media-descriptor-decode-or-shape-error');
  assert.match(facts.mediaCarriers[0].payloadDigest, /^[a-f0-9]{64}$/);
});

test('oversized audio clip domain refuses coverage without publishing an empty proof', () => {
  const facts = inspectPsdLinkFraming(audioBytes({ clips: 129 }));
  assert.equal(facts.status, 'incomplete');
  assert.equal(facts.mediaCarriers.length, 1);
  assert.equal(facts.mediaCarriers[0].status, 'unresolved');
  assert.ok(facts.issues.includes('coverage-limit') || facts.issues.includes('media-descriptor-decode-or-shape-error'));
});

test('wire/parsed ID disagreement remains explicit even when the framing claims a supported shape', async t => {
  const value = parsed([{ id: 'parsed-id', name: 'embedded.bin', data: new Uint8Array(8) }]);
  value.framing = { domain: 'psd-v1-link-and-media-descriptors', version: 3, status: 'framed', issues: [], notes: [], mediaCarriers: [],
    records: [{ carrier: 'lnk2', layerIndex: null, id: 'other-id', type: 'liFD', version: 2, tailBytes: 0 }] };
  const h = harness(t, { parsed: value }); const run = await h.start(); const result = await run.promise;
  assert.equal(result.linkedInventory.framing.parsedAgreement, false);
  assert.ok(result.linkedInventory.unresolved.some(item => item.reason === 'wire-parsed-record-disagreement'));
  await run.finish();
});

for (const fault of ['coverage-version', 'type', 'tail']) {
  test(`receiver rejects a forged framed claim with unsupported ${fault}`, async t => {
    const value = parsed([{ id: 'id', name: 'embedded.bin', data: new Uint8Array(8) }]);
    value.framing = { domain: 'psd-v1-link-and-media-descriptors', version: fault === 'coverage-version' ? 2 : 3,
      status: 'framed', issues: [], notes: [], mediaCarriers: [], records: [{ carrier: 'lnk2', layerIndex: null, id: 'id',
        type: fault === 'type' ? 'liZZ' : 'liFD', version: 2, tailBytes: fault === 'tail' ? 4 : 0 }] };
    const h = harness(t, { parsed: value }); const run = await h.start();
    await assert.rejects(run.promise, /invalid_result/); await run.finish();
    assert.equal(fs.existsSync(run.extractDir), false);
  });
}

test('cancellation during metadata credit retires without reaching embedded writes', async t => {
  let lease;
  const h = harness(t, { parsed: parsed([{ name: 'embedded.bin', data: new Uint8Array(8) }]), onMessage(message) {
    if (message.type === 'record' && message.kind === 'linked-metadata') lease.cancel();
  } });
  const run = await h.start(); lease = run.lease;
  await assert.rejects(run.promise, /cancelled/); await run.finish();
  assert.equal(h.events.some(event => event.type === 'chunk'), false);
  assert.equal(h.children.size, 0);
});

for (const fault of ['begin-version', 'result-version', 'metadata-count', 'metadata-units', 'metadata-cap', 'path-mismatch']) {
  test(`linked metadata protocol ${fault} rejects without accepting a partial inventory`, async t => {
    const h = harness(t, { parsed: parsed([{ id: 'id', name: 'raw.bin', linkedFile: { fullPath: '/missing/raw.bin' } }]),
      onMessage(message) {
        if (fault === 'begin-version' && message.type === 'begin') message.protocolVersion++;
        if (message.type === 'result') {
          if (fault === 'result-version') message.protocolVersion++;
          if (fault === 'metadata-count') message.metadataCount++;
          if (fault === 'metadata-units') message.metadataUnits++;
        }
        if (fault === 'metadata-cap' && message.type === 'record' && message.kind === 'linked-metadata') message.textUnits = 65537;
        if (fault === 'path-mismatch' && message.type === 'text' && message.text === '/missing/raw.bin') message.text = '/missing/bad.bin';
      } });
    const run = await h.start();
    await assert.rejects(run.promise, /invalid_result/);
    await run.finish();
    assert.equal(fs.existsSync(run.extractDir) ? fs.readdirSync(run.extractDir).length : 0, 0);
  });
}

test('Node advanced IPC: invalid PSD is a controlled error and exits', async t => {
  const h = harness(t);
  fs.writeFileSync(path.join(h.root, 'source.psd'), 'not-a-psd');
  const run = await h.start();
  await assert.rejects(run.promise, /psd_worker_failed/);
  await run.finish();
  assert.equal(h.children.size, 0);
});

test('production sender/receiver double: chunks, exact backing, long metadata, empty and repeated names', async t => {
  const backing = new Uint8Array(3 * 1024 * 1024 + 41).fill(79);
  const data = backing.subarray(19, 2 * 1024 * 1024 + 26);
  const name = 'x'.repeat(33000) + '.png';
  const h = harness(t, { parsed: parsed([{ name, data }, { name: 'same.png', data: new Uint8Array(1024 * 1024) }, { name: 'same.png', data: new Uint8Array() }]),
    onMessage(message) {
      assert.equal('result' in message, false);
      if (message.type === 'chunk') {
        assert.equal(message.bytes.byteOffset, 0);
        assert.equal(message.bytes.buffer.byteLength, message.bytes.byteLength);
        assert.ok(message.bytes.byteLength <= 1024 * 1024);
      }
      if (message.type === 'text') assert.ok(message.text.length <= 16384);
    } });
  const run = await h.start();
  await run.promise;
  const assets = run.transaction.promote();
  assert.deepEqual(Buffer.from(fs.readFileSync(assets[0].filePath)), Buffer.from(data));
  assert.equal(assets[0].embeddedOriginalName, name);
  assert.deepEqual(Array.from(assets, asset => asset.embeddedIndex), [0, 1, 2]);
  assert.notEqual(assets[1].filePath, assets[2].filePath);
  assert.equal(fs.statSync(assets[2].filePath).size, 0);
  assert.deepEqual(h.events.filter(e => e.bytes).map(e => e.bytes), [1048576, 1048576, 7, 1048576]);
  await run.finish();
  assert.equal(fs.readdirSync(run.extractDir).length, 0);
});

test('partial writes withhold ACK until the entire chunk drains; no second payload is queued', async t => {
  const blocked = deferred(), entered = deferred();
  let writes = 0;
  const h = harness(t, { parsed: parsed([{ name: 'asset.bin', data: new Uint8Array(1048577).fill(9) }]), io: {
    async open(...args) {
      const handle = await fs.promises.open(...args), write = handle.write.bind(handle);
      handle.write = async (bytes, offset, length, position) => {
        writes++;
        if (writes === 1) { entered.resolve(); await blocked.promise; }
        return write(bytes, offset, Math.min(length, 400000), position);
      };
      return handle;
    },
  } });
  const run = await h.start();
  await entered.promise;
  await delay(20);
  assert.equal(h.events.filter(e => e.type === 'chunk').length, 1);
  const seq = h.events.find(e => e.type === 'chunk').seq;
  assert.equal(h.events.some(e => e.direction === 'ack' && e.seq === seq), false);
  blocked.resolve();
  await run.promise;
  assert.equal(writes, 4);
  await run.finish();
});

for (const mode of ['cancel', 'timeout', 'write-failure', 'zero-write', 'exit']) {
  test(`${mode} during write fences ACK and cleans only after issued IO drains`, async t => {
    const blocked = deferred(), entered = deferred();
    const h = harness(t, { parsed: parsed([{ name: 'asset.bin', data: new Uint8Array(1048577) }]), io: {
      async open(...args) {
        const handle = await fs.promises.open(...args), write = handle.write.bind(handle);
        handle.write = async (...writeArgs) => {
          entered.resolve(); await blocked.promise;
          if (mode === 'write-failure') throw new Error('injected write failure');
          if (mode === 'zero-write') return { bytesWritten: 0 };
          return write(...writeArgs);
        };
        return handle;
      },
    } });
    const run = await h.start(undefined, mode === 'timeout' ? 50 : 3000);
    await entered.promise;
    if (mode === 'cancel') run.lease.cancel();
    if (mode === 'exit') [...h.children][0].kill();
    if (mode === 'timeout') await delay(70);
    let retired = false;
    if (['cancel', 'timeout', 'exit'].includes(mode)) {
      await assert.rejects(run.promise);
      run.finish().then(() => { retired = true; });
      await turn();
      assert.equal(retired, false);
      assert.equal(fs.readdirSync(run.extractDir).length, 1);
    }
    blocked.resolve();
    await assert.rejects(run.promise);
    await run.finish();
    assert.equal(fs.readdirSync(run.extractDir).length, 0);
    assert.equal(h.events.filter(e => e.type === 'chunk').length, 1);
  });
}

test('four retiring writes retain all slots; waiting retries allocate nothing and remain cancellable', async t => {
  const blocked = deferred(), entered = deferred();
  let writes = 0;
  const h = harness(t, { parsed: parsed([{ name: 'asset.bin', data: new Uint8Array(1048576) }]), io: {
    async open(...args) {
      const handle = await fs.promises.open(...args), write = handle.write.bind(handle);
      handle.write = async (...writeArgs) => { if (++writes === 4) entered.resolve(); await blocked.promise; return write(...writeArgs); };
      return handle;
    },
  } });
  const runs = await Promise.all(Array.from({ length: 4 }, () => h.start()));
  await entered.promise;
  for (const run of runs) run.lease.cancel();
  await Promise.all(runs.map(run => assert.rejects(run.promise)));
  const retiring = runs.map(run => run.finish());
  const retry = createAddFilesScanLease({ timeoutMs: 1000 });
  const waiting = h.context.acquireAddFilesPsdTransferSlot(retry);
  let acquired = false; waiting.then(() => { acquired = true; }, () => {});
  await delay(20);
  assert.equal(acquired, false);
  assert.equal(writes, 4);
  retry.cancel();
  await assert.rejects(waiting, /cancelled/);
  blocked.resolve();
  await Promise.all(retiring);
  const fresh = createAddFilesScanLease();
  const release = await h.context.acquireAddFilesPsdTransferSlot(fresh);
  release(); fresh.dispose(); retry.dispose();
});

for (const kind of ['open', 'read']) {
  test(`cancellation during delayed ${kind} observes the eventual handle/IO and closes it`, async t => {
    const entered = deferred(), blocked = deferred();
    let closed = false;
    const h = harness(t, { parsed: parsed([{ name: 'asset.bin', data: new Uint8Array(8) }]), io: {
      async open(...args) {
        const handle = await fs.promises.open(...args), close = handle.close.bind(handle);
        handle.close = async () => { await close(); closed = true; };
        if (kind === 'open') { entered.resolve(); await blocked.promise; }
        else { const read = handle.read.bind(handle); handle.read = async (...readArgs) => { entered.resolve(); await blocked.promise; return read(...readArgs); }; }
        return handle;
      },
    } });
    if (kind === 'open') {
      const run = await h.start();
      await entered.promise; run.lease.cancel();
      await assert.rejects(run.promise);
      const finish = run.finish();
      assert.equal(closed, false); blocked.resolve(); await finish;
      assert.equal(fs.readdirSync(run.extractDir).length, 0);
    } else {
      const source = path.join(h.root, 'digest'); fs.writeFileSync(source, Buffer.alloc(100000));
      const lease = createAddFilesScanLease();
      const digest = h.context.getAddFilesCurrentSourceDigest(source, lease);
      await entered.promise; lease.cancel(); assert.equal(closed, false); blocked.resolve();
      await assert.rejects(digest, /cancelled/); lease.dispose();
    }
    assert.equal(closed, true);
  });
}

test('streaming digest handles partial reads, fixed scratch size, restored mtime mutations, growth and replacement', async t => {
  let largest = 0, reads = 0;
  const h = harness(t, { io: { async open(...args) {
    const handle = await fs.promises.open(...args), read = handle.read.bind(handle);
    handle.read = (buffer, offset, length, position) => { largest = Math.max(largest, buffer.byteLength); reads++; return read(buffer, offset, Math.min(length, 7000), position); };
    return handle;
  } } });
  const source = path.join(h.root, 'digest'); const data = Buffer.alloc(200000, 7); fs.writeFileSync(source, data);
  const stat = fs.statSync(source), expected = h.context.getAddFilesSourceIdentity(stat);
  const digest = await h.context.getAddFilesCurrentSourceDigest(source, null, expected);
  assert.equal(digest, crypto.createHash('sha256').update(data).digest('hex'));
  assert.equal(largest, 65536); assert.ok(reads > 20);
  data[0] = 8; fs.writeFileSync(source, data); fs.utimesSync(source, stat.atime, stat.mtime);
  const restored = h.context.getAddFilesSourceIdentity(fs.statSync(source));
  assert.notEqual(await h.context.getAddFilesCurrentSourceDigest(source, null, restored), digest);
  fs.appendFileSync(source, 'growth');
  await assert.rejects(h.context.getAddFilesCurrentSourceDigest(source, null, restored), /source_changed/);
  fs.renameSync(source, source + '.old'); fs.writeFileSync(source, data);
  await assert.rejects(h.context.getAddFilesCurrentSourceDigest(source, null, restored), /source_changed/);
});

for (const fault of ['seq', 'offset', 'backing', 'oversize', 'duplicate', 'eof', 'result', 'stale-session']) {
  test(`protocol ${fault} fails closed or ignores stale traffic without filesystem acceptance`, async t => {
    let injected = false;
    const h = harness(t, { parsed: parsed([{ name: 'asset.bin', data: new Uint8Array(8) }]), onMessage(message, child) {
      if (message.type !== 'chunk' || injected) return;
      injected = true;
      if (fault === 'seq') message.seq++;
      if (fault === 'offset') message.offset++;
      if (fault === 'backing') message.bytes = new Uint8Array(100).subarray(5, 13);
      if (fault === 'oversize') message.bytes = new Uint8Array(1048577);
      if (fault === 'eof') message.type = 'record-end';
      if (fault === 'result') message.type = 'result';
      if (fault === 'duplicate') queueMicrotask(() => child.emit('message', { ...message }));
      if (fault === 'stale-session') child.emit('message', { ...message, sessionId: 'old-attempt' });
    } });
    const run = await h.start();
    if (fault === 'stale-session') await run.promise;
    else await assert.rejects(run.promise, /invalid_result/);
    await run.finish();
    assert.equal(fs.existsSync(run.extractDir) ? fs.readdirSync(run.extractDir).length : 0, 0);
  });
}

for (const fault of ['file-replacement', 'directory-replacement', 'collision', 'link-failure', 'close-failure']) {
  test(`owned cleanup preserves unrelated files after ${fault}`, async t => {
    let closeFailed = false;
    const h = harness(t, { parsed: parsed([{ name: 'asset.bin', data: new Uint8Array(8) }]), io: {
      async open(...args) {
        const handle = await fs.promises.open(...args), close = handle.close.bind(handle);
        handle.close = async () => { if (fault === 'close-failure' && !closeFailed) { closeFailed = true; throw new Error('close failure'); } return close(); };
        return handle;
      },
    } });
    const run = await h.start();
    if (fault === 'close-failure') { await assert.rejects(run.promise, /close failure/); await run.finish(); assert.equal(fs.readdirSync(run.extractDir).length, 0); return; }
    await run.promise;
    const stage = path.join(run.extractDir, fs.readdirSync(run.extractDir)[0]);
    let unrelated;
    if (fault === 'file-replacement') { fs.renameSync(stage, stage + '.owned'); fs.writeFileSync(stage, 'unrelated'); unrelated = stage; }
    if (fault === 'directory-replacement') { fs.renameSync(run.extractDir, run.extractDir + '.owned'); fs.mkdirSync(run.extractDir); unrelated = path.join(run.extractDir, 'unrelated'); fs.writeFileSync(unrelated, 'unrelated'); }
    if (fault === 'collision' || fault === 'link-failure') { unrelated = path.join(run.extractDir, 'asset.bin'); fs.writeFileSync(unrelated, 'unrelated'); }
    if (fault === 'link-failure') h.fsView.linkSync = () => { throw Object.assign(new Error('link denied'), { code: 'EACCES' }); };
    if (fault === 'collision') {
      const entries = run.transaction.promote();
      assert.notEqual(entries[0].filePath, unrelated);
    } else assert.throws(() => run.transaction.promote());
    await run.finish();
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'unrelated');
  });
}

test('sender missing/duplicate/out-of-order ACK uses one credit and never queues the next record', async () => {
  for (const fault of ['missing', 'duplicate', 'out-of-order']) {
    let receiver, exited = false;
    const messages = [];
    startAddFilesPsdWorker({ on: (_, fn) => { receiver = fn; }, postMessage: m => messages.push(m) },
      { parse: () => parsed([{ name: 'a', data: new Uint8Array(8) }]), exit: () => { exited = true; } });
    receiver({ data: { type: 'parse', sessionId: 'ack-test', filePath: 'synthetic' } });
    await turn(); await turn();
    assert.equal(messages.length, 1);
    if (fault === 'missing') continue;
    receiver({ data: { type: 'ack', sessionId: 'ack-test', seq: fault === 'duplicate' ? 0 : 1 } });
    if (fault === 'duplicate') receiver({ data: { type: 'ack', sessionId: 'ack-test', seq: 0 } });
    await turn(); await turn();
    assert.equal(exited, true);
    assert.equal(messages.at(-1).type, 'error');
  }
});

test('slots remain held through later source hashing, including cancelled native reads', async t => {
  const blocked = deferred(), entered = deferred();
  let reads = 0;
  const h = harness(t, { parsed: parsed([]), io: {
    async open(...args) {
      const handle = await fs.promises.open(...args);
      if (args[1] === 'r') {
        const read = handle.read.bind(handle);
        handle.read = async (...readArgs) => { assert.equal(readArgs[0].byteLength, 65536); if (++reads === 4) entered.resolve(); await blocked.promise; return read(...readArgs); };
      }
      return handle;
    },
  } });
  const source = path.join(h.root, 'digest'); fs.writeFileSync(source, Buffer.alloc(200000));
  const runs = await Promise.all(Array.from({ length: 4 }, () => h.start()));
  await Promise.all(runs.map(run => run.promise));
  const digests = runs.map(async run => {
    try { await assert.rejects(h.context.getAddFilesCurrentSourceDigest(source, run.lease), /cancelled/); }
    finally { await run.finish(); }
  });
  await entered.promise;
  for (const run of runs) run.lease.cancel();
  const waiter = createAddFilesScanLease();
  let acquired = false;
  const waiting = h.context.acquireAddFilesPsdTransferSlot(waiter).then(release => { acquired = true; release(); });
  await delay(20); assert.equal(acquired, false); assert.equal(reads, 4);
  blocked.resolve(); await Promise.all(digests); await waiting; waiter.dispose();
  assert.equal(acquired, true);
});

test('the existing 300 MiB source admission is preserved without allocating a near-limit fixture', async () => {
  const { parsePsd, MAX_PARSE_FILE_SIZE } = require('../parsers/add-files-psd-worker');
  assert.equal(MAX_PARSE_FILE_SIZE, 300 * 1024 * 1024);
  const stat = fs.statSync, read = fs.readFileSync;
  try {
    let admitted = 0;
    fs.statSync = () => ({ isFile: () => true, size: MAX_PARSE_FILE_SIZE });
    fs.readFileSync = () => { admitted++; throw new Error('admitted source seam'); };
    assert.throws(() => parsePsd('synthetic'), /admitted source seam/);
    assert.equal(admitted, 1);
    fs.statSync = () => ({ isFile: () => true, size: MAX_PARSE_FILE_SIZE + 1 });
    assert.throws(() => parsePsd('synthetic'), /source_too_large/);
    assert.equal(admitted, 1);
  } finally { fs.statSync = stat; fs.readFileSync = read; }
});

test('failed final ACK never accepts staged output', async t => {
  let finalSeq;
  const h = harness(t, { parsed: parsed([{ name: 'asset.bin', data: new Uint8Array(8) }]),
    onMessage(message) { if (message.type === 'result') finalSeq = message.seq; },
    onAck(message) { if (message.type === 'ack' && message.seq === finalSeq) throw new Error('final ACK failure'); },
  });
  const run = await h.start();
  await assert.rejects(run.promise, /final ACK failure/);
  await run.finish();
  assert.equal(fs.readdirSync(run.extractDir).length, 0);
});

for (const fault of ['text-cap', 'text-total', 'record-index', 'final-count']) {
  test(`metadata ${fault} is rejected without truncating or accepting incomplete records`, async t => {
    const h = harness(t, { parsed: parsed([{ name: 'asset.bin', data: new Uint8Array(8) }]), onMessage(message) {
      if (fault === 'text-cap' && message.type === 'text') message.text = 'x'.repeat(16385);
      if (fault === 'text-total' && message.type === 'record') message.textUnits++;
      if (fault === 'record-index' && message.type === 'record') message.index++;
      if (fault === 'final-count' && message.type === 'result') message.embeddedCount++;
    } });
    const run = await h.start();
    await assert.rejects(run.promise, /invalid_result/);
    await run.finish();
    assert.equal(fs.existsSync(run.extractDir) ? fs.readdirSync(run.extractDir).length : 0, 0);
  });
}

for (const acceptSecond of [true, false]) {
  test(`same-project concurrent PSD names preserve distinct bytes and ownership (accept second: ${acceptSecond})`, async t => {
    const h = harness(t);
    const a = path.join(h.root, 'a.psd'), b = path.join(h.root, 'b.psd');
    fs.writeFileSync(a, createSyntheticPsd('first-source-bytes'));
    fs.writeFileSync(b, createSyntheticPsd('second-source-bytes'));
    const first = await h.start(a, 10000, 'shared');
    const second = await h.start(b, 10000, 'shared');
    const results = await Promise.all([first.promise, second.promise]);
    const firstEntry = first.transaction.promote()[0];
    first.transaction.accept({ files: [{ path: firstEntry.filePath }] });
    const secondEntry = second.transaction.promote()[0];
    assert.notEqual(firstEntry.filePath, secondEntry.filePath);
    for (const [entry, bytes, result] of [[firstEntry, 'first-source-bytes', results[0]], [secondEntry, 'second-source-bytes', results[1]]]) {
      assert.equal(fs.readFileSync(entry.filePath, 'utf8'), bytes);
      assert.equal(entry.embeddedOriginalName, 'embedded.png');
      assert.equal(entry.embeddedIndex, 0);
      assert.equal(entry.sourceDigest, result.sourceDigest);
    }
    if (acceptSecond) second.transaction.accept({ files: [{ path: secondEntry.filePath }] });
    else { second.lease.cancel(); assert.throws(() => second.transaction.assertReady(), /cancelled/); }
    await Promise.all([first.finish(), second.finish()]);
    assert.equal(fs.readFileSync(firstEntry.filePath, 'utf8'), 'first-source-bytes');
    assert.equal(fs.existsSync(secondEntry.filePath), acceptSecond);
    assert.equal(fs.readdirSync(first.extractDir).length, acceptSecond ? 2 : 1);
  });
}

test('legacy PSD extraction retries a destination claimed after both name snapshots', async t => {
  let writes = 0;
  const bothStaged = deferred();
  const h = harness(t, { io: { async writeFile(...args) {
    await fs.promises.writeFile(...args);
    if (++writes === 2) bothStaged.resolve();
    await bothStaged.promise;
  } } });
  h.context.readPsd = bytes => ({ linkedFiles: [{ name: 'shared.bin', data: bytes }] });
  vm.runInContext(section('async function extractPsdAssets(', '\n/**'), h.context);
  const a = path.join(h.root, 'a.psd'), b = path.join(h.root, 'b.psd');
  fs.writeFileSync(a, 'legacy a'); fs.writeFileSync(b, 'legacy b');
  const [first, second] = await Promise.all([
    h.context.extractPsdAssets(a, 'legacy', () => true, { strict: true }),
    h.context.extractPsdAssets(b, 'legacy', () => true, { strict: true }),
  ]);
  assert.notEqual(first[0].filePath, second[0].filePath);
  assert.equal(fs.readFileSync(first[0].filePath, 'utf8'), 'legacy a');
  assert.equal(fs.readFileSync(second[0].filePath, 'utf8'), 'legacy b');
  assert.equal(fs.readdirSync(path.dirname(first[0].filePath)).length, 2);
});

for (const form of ['bit-depth', 'alternate-layer']) {
  test(`bounded framing recognized ${form} is supported or remains a coverage note`, () => {
    const bytes = Buffer.from(aliasBytes());
    if (form === 'bit-depth') bytes.writeUInt16BE(16, 22);
    if (form === 'alternate-layer') {
      const length = 30 + bytes.readUInt32BE(26); const mask = length + 4 + bytes.readUInt32BE(length);
      const end = mask + 4 + bytes.readUInt32BE(mask); const block = Buffer.alloc(18);
      block.write('8B64Lr16'); block.writeUInt32BE(2, 12);
      const extended = Buffer.concat([bytes.subarray(0, end), block, bytes.subarray(end)]);
      extended.writeUInt32BE(bytes.readUInt32BE(mask) + block.length, mask);
      const facts = inspectPsdLinkFraming(extended);
      assert.deepEqual(facts.issues, []); assert.equal(facts.status, 'incomplete');
      assert.deepEqual(facts.notes, ['alternate-layer-carrier-domain-unverified']); return;
    }
    const facts = inspectPsdLinkFraming(bytes);
    assert.deepEqual(facts.issues, []);
    assert.equal(facts.status, form === 'alternate-layer' ? 'incomplete' : 'framed');
    assert.deepEqual(facts.notes, form === 'alternate-layer' ? ['alternate-layer-carrier-domain-unverified'] : []);
  });
}

for (const fault of ['missing-notes', 'unknown-note', 'note-cap', 'framed-note', 'old-domain']) {
  test(`receiver rejects incompatible or malformed coverage notes ${fault}`, async t => {
    const value = parsed();
    value.framing = { domain: 'psd-v1-link-and-media-descriptors', version: 3,
      status: 'incomplete', records: [], mediaCarriers: [], issues: [], notes: [] };
    if (fault === 'missing-notes') delete value.framing.notes;
    if (fault === 'unknown-note') value.framing.notes = ['ignore-declared-errors'];
    if (fault === 'note-cap') value.framing.notes = Array(129).fill('alternate-layer-carrier-domain-unverified');
    if (fault === 'framed-note') { value.framing.status = 'framed'; value.framing.notes = ['alternate-layer-carrier-domain-unverified']; }
    if (fault === 'old-domain') { value.framing.domain = 'psd-v1-8bit-link-and-media-descriptors'; value.framing.version = 2; }
    const h = harness(t, { parsed: value }); const run = await h.start();
    await assert.rejects(run.promise, /invalid_result/); await run.finish();
    assert.equal(fs.existsSync(run.extractDir), false);
  });
}

for (const fault of ['type', 'version', 'tail', 'incomplete-tail', 'media-version', 'media-tail', 'media-incomplete-tail']) {
  test(`incomplete receiver derives ${fault} refusal without redundant worker issue`, async t => {
    const value = parsed([{ id: 'id', name: 'embedded.bin', data: new Uint8Array(8) }]);
    value.framing = { domain: 'psd-v1-link-and-media-descriptors', version: 3, status: 'incomplete', issues: [],
      notes: ['alternate-layer-carrier-domain-unverified'], mediaCarriers: [],
      records: [{ carrier: 'lnk2', layerIndex: null, id: 'id', type: fault === 'type' ? 'liZZ' : 'liFD',
        version: fault === 'version' ? 8 : 2, tailBytes: fault === 'tail' ? 4 : fault === 'incomplete-tail' ? null : 0 }] };
    if (fault.startsWith('media-')) value.framing.mediaCarriers.push({ carrier: '1075', carrierIndex: 1, layerIndex: null, layerId: null,
      status: 'decoded', version: fault === 'media-version' ? 2 : 1, pixelSourceType: null,
      tailBytes: fault === 'media-tail' ? 4 : fault === 'media-incomplete-tail' ? null : 0, references: [] });
    const h = harness(t, { parsed: value }), run = await h.start(), result = await run.promise;
    const reason = { type: 'unsupported-link-form', version: 'unsupported-link-form', tail: 'unexplained-link-tail',
      'incomplete-tail': 'unresolved-link-record-framing', 'media-version': 'unsupported-media-descriptor-version',
      'media-tail': 'unexplained-media-tail', 'media-incomplete-tail': 'unresolved-media-descriptor-framing' }[fault];
    assert.ok(result.linkedInventory.unresolved.some(item => item.reason === reason)); await run.finish();
  });
}


for (const mode of ['timeline', 'timeline-frame-version', 'timeline-link-version', 'video-frame-version',
  'video-link-version', 'video-pixel', 'video-reader', 'video-supported', 'video-worker-refusal']) {
  test(`media receiver derives ${mode} policy without redundant worker reason`, async t => {
    const bytes = mode.startsWith('timeline') ? audioBytes() : videoBytes();
    const value = parsed();
    value.psd = agPsd.readPsd(bytes, { skipLayerImageData: true, skipCompositeImageData: true });
    value.framing = inspectPsdLinkFraming(bytes);
    const carrier = value.framing.mediaCarriers[0], ref = carrier.references[0];
    value.framing.status = 'incomplete'; value.framing.notes = ['alternate-layer-carrier-domain-unverified'];
    value.framing.issues = []; ref.reason = null;
    if (mode.endsWith('frame-version')) ref.frameReader.descVersion = 2;
    if (mode.endsWith('link-version')) ref.frameReader['Lnk '].descVersion = 9;
    if (mode === 'video-pixel') carrier.pixelSourceType = 1;
    if (mode === 'video-reader') ref.frameReader.frameReaderType = 1;
    if (mode === 'video-worker-refusal') ref.reason = 'unsupported-media-reference-shape';
    const h = harness(t, { parsed: value }), run = await h.start(), result = await run.promise;
    const inventory = result.linkedInventory;
    if (mode === 'video-supported') {
      assert.deepEqual(Array.from(inventory.unresolved), []);
      assert.ok(inventory.references.some(x => x.source === 'wire-media' && x.disposition === 'external-reference'));
    } else {
      const reason = mode === 'timeline' ? 'unverified-timeline-frame-reader-type'
        : ['video-pixel', 'video-reader'].includes(mode) ? 'unsupported-video-reader-type' : 'unsupported-media-reference-shape';
      assert.equal(inventory.unresolved.filter(x => x.reason === reason).length, 1);
      assert.ok(inventory.references.some(x => x.source === 'wire-media' && x.disposition === 'unresolved-media-reference'));
    }
    await run.finish();
  });
}

for (const mode of ['timeline', 'video', 'linked']) {
  test(`not-examined receiver retains ${mode} refusal with parsed observations`, async t => {
    const value = parsed();
    if (mode !== 'linked') value.psd = agPsd.readPsd(mode === 'timeline' ? audioBytes() : videoBytes(),
      { skipLayerImageData: true, skipCompositeImageData: true });
    else value.psd.linkedFiles = [{ id: 'external', name: 'Linked.png', linkedFile: { fullPath: '/Users/synthetic/Linked.png' } }];
    value.framing = { status: 'not-examined' };
    const h = harness(t, { parsed: value }), run = await h.start(), result = await run.promise;
    const inventory = result.linkedInventory;
    assert.equal(inventory.unresolved.filter(item => item.reason === 'wire-coverage-not-examined').length, 1);
    if (mode === 'timeline') assert.equal(inventory.unresolved.filter(item => item.reason === 'unverified-timeline-frame-reader-type').length, 1);
    assert.ok(inventory.references.length > 0); await run.finish();
  });
}
