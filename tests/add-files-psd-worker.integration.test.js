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
const { startAddFilesPsdWorker } = require('../parsers/add-files-psd-worker');

let agPsd = null;
try {
  agPsd = require('ag-psd');
} catch (_) {
  // The source-only test environment may not have reconstructed dependencies.
}

const workerPath = path.join(__dirname, '..', 'parsers', 'add-files-psd-worker.js');

function createSyntheticPsd() {
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
        data: Buffer.from('embedded-worker-bytes'),
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
  const start = async (sourcePath = path.join(root, 'source.psd'), timeoutMs = 3000) => {
    const lease = createAddFilesScanLease({ timeoutMs });
    const release = await context.acquireAddFilesPsdTransferSlot(lease);
    const projectId = `test-${counter++}`;
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

for (const fault of ['file-replacement', 'directory-replacement', 'link-failure', 'close-failure']) {
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
    if (fault === 'link-failure') { unrelated = path.join(run.extractDir, 'asset.bin'); fs.writeFileSync(unrelated, 'unrelated'); }
    assert.throws(() => run.transaction.promote());
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
