'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const MAX_BUFFER = 1024 * 1024;
const strategy = process.env.CRATE_BUFFER_STRATEGY || 'size-capped';
const mainPath = process.env.CRATE_MAIN_UNDER_TEST || path.join(__dirname, '..', 'main.js');
const mainSource = fs.readFileSync(mainPath, 'utf8');
function section(start, end) {
  const a = mainSource.indexOf(start);
  const b = mainSource.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `source boundary ${start}`);
  return mainSource.slice(a, b);
}
const production = [
  section('function getAddFilesSourceIdentity(', 'function isAddFilesSourceIdentityCurrent('),
  section('function isAddFilesSourceIdentityCurrent(', '// A slot includes retiring IO.'),
  section('async function getAddFilesCurrentSourceDigest(', '\n/**'),
].join('\n');

function expectedCapacity(size) {
  if (strategy === 'size-capped') return Math.max(1, Math.min(size, MAX_BUFFER));
  if (strategy === 'base-64k') return 64 * 1024;
  if (strategy === 'fixed-1m') return MAX_BUFFER;
  throw new Error(`unsupported test strategy: ${strategy}`);
}

function makeDigestContext(t, io = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-digest-size-capped-'));
  const opened = [];
  const originalCloses = new WeakMap();
  t.after(async () => {
    for (const handle of opened) {
      if (handle.fd !== -1) {
        try { await originalCloses.get(handle)?.(); } catch (_) {}
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const fsView = {
    ...fs,
    promises: {
      ...fs.promises,
      ...io,
      async open(...args) {
        const handle = await fs.promises.open(...args);
        originalCloses.set(handle, handle.close.bind(handle));
        opened.push(handle);
        return io.wrapHandle ? io.wrapHandle(handle) : handle;
      },
    },
  };
  const context = { fs: fsView, crypto, Buffer: io.bufferView || Buffer, MAX_PARSE_FILE_SIZE: 300 * 1024 * 1024 };
  vm.createContext(context);
  vm.runInContext(production, context);
  return { root, context, opened, closeOriginal: handle => originalCloses.get(handle) };
}

async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

function makeBytes(size, seed = 19) {
  const out = Buffer.alloc(size);
  for (let i = 0; i < out.length; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

for (const [label, size] of [['empty', 0], ['small', 37], ['large', MAX_BUFFER + 13]]) {
  test(`digest matches SHA-256 and allocates the expected cap for ${label} input`, async t => {
    const capacities = [];
    const h = makeDigestContext(t, { wrapHandle(handle) {
      const read = handle.read.bind(handle);
      handle.read = async (buffer, offset, length, position) => {
        capacities.push(buffer.byteLength);
        return read(buffer, offset, length, position);
      };
      return handle;
    } });
    const file = path.join(h.root, `${label}.bin`);
    const bytes = makeBytes(size);
    fs.writeFileSync(file, bytes);
    const got = await h.context.getAddFilesCurrentSourceDigest(file);
    assert.equal(got, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.ok(capacities.length >= 1);
    assert.deepEqual([...new Set(capacities)], [expectedCapacity(size)]);
    assert.equal(h.opened.every(handle => handle.fd === -1), true);
  });
}

for (const [label, size] of [
  ['one byte below cap', MAX_BUFFER - 1],
  ['exactly at cap', MAX_BUFFER],
  ['one byte above cap', MAX_BUFFER + 1],
]) {
  test(`digest sizes the scratch buffer correctly ${label}`, async t => {
    const capacities = [];
    const h = makeDigestContext(t, { wrapHandle(handle) {
      const read = handle.read.bind(handle);
      handle.read = async (buffer, offset, length, position) => {
        capacities.push(buffer.byteLength);
        return read(buffer, offset, length, position);
      };
      return handle;
    } });
    const file = path.join(h.root, `${label.replaceAll(' ', '-')}.bin`);
    const bytes = makeBytes(size, size & 0xff);
    fs.writeFileSync(file, bytes);
    const got = await h.context.getAddFilesCurrentSourceDigest(file);
    assert.equal(got, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.ok(capacities.length >= 1);
    assert.deepEqual([...new Set(capacities)], [expectedCapacity(size)]);
    assert.equal(h.opened.every(handle => handle.fd === -1), true);
  });
}

test('a matching supplied identity preserves digest correctness and selected capacity', async t => {
  const capacities = [];
  const h = makeDigestContext(t, { wrapHandle(handle) {
    const read = handle.read.bind(handle);
    handle.read = async (buffer, offset, length, position) => {
      capacities.push(buffer.byteLength);
      return read(buffer, offset, length, position);
    };
    return handle;
  } });
  const file = path.join(h.root, 'supplied-identity.bin');
  const bytes = makeBytes(73);
  fs.writeFileSync(file, bytes);
  const identity = h.context.getAddFilesSourceIdentity(fs.statSync(file));
  const got = await h.context.getAddFilesCurrentSourceDigest(file, null, identity);
  assert.equal(got, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual([...new Set(capacities)], [expectedCapacity(bytes.length)]);
  assert.equal(h.opened.every(handle => handle.fd === -1), true);
});

test('a stale supplied size fails before reading or allocating a digest buffer', async t => {
  let reads = 0;
  const allocationSizes = [];
  const h = makeDigestContext(t, { bufferView: { allocUnsafe(size) {
    allocationSizes.push(size);
    return Buffer.allocUnsafe(size);
  } }, wrapHandle(handle) {
    const read = handle.read.bind(handle);
    handle.read = async (...args) => { reads++; return read(...args); };
    return handle;
  } });
  const file = path.join(h.root, 'stale-supplied-identity.bin');
  fs.writeFileSync(file, makeBytes(73));
  const identity = h.context.getAddFilesSourceIdentity(fs.statSync(file));
  await assert.rejects(h.context.getAddFilesCurrentSourceDigest(file, null, { ...identity, size: 74 }), /asset_baseline_source_changed/);
  assert.equal(reads, 0);
  assert.equal(allocationSizes.length, 0);
  assert.equal(h.opened.every(handle => handle.fd === -1), true);
});

test('size-capped digest handles positive short reads without changing the digest', async t => {
  const caps = [];
  const h = makeDigestContext(t, { wrapHandle(handle) {
    const read = handle.read.bind(handle);
    handle.read = async (buffer, offset, length, position) => {
      caps.push({ buffer: buffer.byteLength, request: length });
      return read(buffer, offset, Math.min(length, 7), position);
    };
    return handle;
  } });
  const file = path.join(h.root, 'short-read.bin');
  const bytes = makeBytes(4099);
  fs.writeFileSync(file, bytes);
  const got = await h.context.getAddFilesCurrentSourceDigest(file);
  assert.equal(got, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.ok(caps.length > 20);
  assert.ok(caps.every(item => item.buffer === expectedCapacity(bytes.length)));
  assert.equal(h.opened.every(handle => handle.fd === -1), true);
});

test('cancellation after a completed read rejects and closes before another read', async t => {
  let active = true, reads = 0, allocated = 0;
  const h = makeDigestContext(t, { wrapHandle(handle) {
    const read = handle.read.bind(handle);
    handle.read = async (buffer, offset, length, position) => {
      allocated = buffer.byteLength;
      reads++;
      const result = await read(buffer, offset, length, position);
      active = false;
      return result;
    };
    return handle;
  } });
  const file = path.join(h.root, 'cancel.bin');
  fs.writeFileSync(file, makeBytes(MAX_BUFFER + 10));
  const lease = { current: () => active };
  await assert.rejects(h.context.getAddFilesCurrentSourceDigest(file, lease), /add_files_parser_cancelled/);
  assert.equal(reads, 1);
  assert.equal(allocated, expectedCapacity(MAX_BUFFER + 10));
  assert.equal(h.opened.every(handle => handle.fd === -1), true);
});

test('cancellation during a pending read waits for that read, then closes without another read', async t => {
  let active = true, reads = 0;
  let enteredRead, releaseRead;
  const entered = new Promise(resolve => { enteredRead = resolve; });
  const blocked = new Promise(resolve => { releaseRead = resolve; });
  const h = makeDigestContext(t, { wrapHandle(handle) {
    const read = handle.read.bind(handle);
    handle.read = async (...args) => {
      reads++;
      enteredRead();
      await blocked;
      return read(...args);
    };
    return handle;
  } });
  const file = path.join(h.root, 'pending-cancel.bin');
  fs.writeFileSync(file, makeBytes(MAX_BUFFER + 9));
  const digest = h.context.getAddFilesCurrentSourceDigest(file, { current: () => active });
  const outcome = digest.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
  let barrierError = null;
  try {
    const enteredOrSettled = await bounded(Promise.race([
      entered.then(() => ({ entered: true })),
      outcome.then(result => ({ entered: false, result })),
    ]), 5000, 'pending-read test never entered or settled its read');
    assert.equal(enteredOrSettled.entered, true, 'digest must enter the deliberately blocked read');
    active = false;
    let settled = false;
    outcome.then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'an awaited filesystem read cannot be cancelled until it settles');
    releaseRead();
    const result = await bounded(outcome, 5000, 'digest did not drain after the blocked read was released');
    assert.equal(result.ok, false);
    assert.match(result.error.message, /add_files_parser_cancelled/);
  } catch (error) { barrierError = error; }
  finally { releaseRead(); }
  const drained = await bounded(outcome, 5000, 'digest remained active during pending-read cleanup');
  if (barrierError) throw barrierError;
  assert.equal(drained.ok, false);
  assert.match(drained.error.message, /add_files_parser_cancelled/);
  assert.equal(reads, 1);
  assert.equal(h.opened.every(handle => handle.fd === -1), true);
});

test('a normal same-size mutation during hashing fails the source identity fence', async t => {
  let changed = false;
  let file;
  const original = makeBytes(MAX_BUFFER + 10, 3);
  const replacement = Buffer.from(original); replacement[0] ^= 0xff;
  const h = makeDigestContext(t, { wrapHandle(handle) {
    const read = handle.read.bind(handle);
    handle.read = async (buffer, offset, length, position) => {
      const result = await read(buffer, offset, length, position);
      if (!changed && result.bytesRead > 0) {
        changed = true;
        fs.writeFileSync(file, replacement);
        const stat = fs.statSync(file);
        const future = new Date(stat.mtimeMs + 5000);
        fs.utimesSync(file, future, future);
      }
      return result;
    };
    return handle;
  } });
  file = path.join(h.root, 'mutation.bin');
  fs.writeFileSync(file, original);
  await assert.rejects(h.context.getAddFilesCurrentSourceDigest(file), /asset_baseline_source_changed/);
  assert.equal(changed, true);
  assert.equal(h.opened.every(handle => handle.fd === -1), true);
});

test('premature EOF after truncation fails closed and closes the digest handle', async t => {
  let reads = 0, file;
  const h = makeDigestContext(t, { wrapHandle(handle) {
    const read = handle.read.bind(handle);
    handle.read = async (...args) => {
      const result = await read(...args);
      if (++reads === 1) fs.truncateSync(file, 0);
      return result;
    };
    return handle;
  } });
  file = path.join(h.root, 'premature-eof.bin');
  fs.writeFileSync(file, makeBytes(MAX_BUFFER + 17));
  await assert.rejects(h.context.getAddFilesCurrentSourceDigest(file), /asset_baseline_source_changed/);
  assert.ok(reads >= 2);
  assert.equal(h.opened.every(handle => handle.fd === -1), true);
});

test('growth after the first read is detected by the final EOF probe', async t => {
  let reads = 0, file, eofProbeReadBytes = 0;
  const h = makeDigestContext(t, { wrapHandle(handle) {
    const read = handle.read.bind(handle);
    handle.read = async (buffer, offset, length, position) => {
      const result = await read(buffer, offset, length, position);
      if (position === 1048586 && length === 1) eofProbeReadBytes = result.bytesRead;
      if (++reads === 1) fs.appendFileSync(file, 'growth');
      return result;
    };
    return handle;
  } });
  file = path.join(h.root, 'growth.bin');
  fs.writeFileSync(file, makeBytes(MAX_BUFFER + 10));
  await assert.rejects(h.context.getAddFilesCurrentSourceDigest(file), /asset_baseline_source_changed/);
  assert.equal(eofProbeReadBytes, 1, 'the EOF probe reads the first grown byte before refusing the digest');
  assert.equal(h.opened.every(handle => handle.fd === -1), true);
});

test('midstream EIO propagates and the open digest handle is closed', async t => {
  let reads = 0;
  const h = makeDigestContext(t, { wrapHandle(handle) {
    const read = handle.read.bind(handle);
    handle.read = async (...args) => {
      if (++reads === 2) throw Object.assign(new Error('injected read failure'), { code: 'EIO' });
      return read(...args);
    };
    return handle;
  } });
  const file = path.join(h.root, 'eio.bin');
  fs.writeFileSync(file, makeBytes(MAX_BUFFER + 10));
  await assert.rejects(h.context.getAddFilesCurrentSourceDigest(file), error => error.code === 'EIO');
  assert.equal(reads, 2);
  assert.equal(h.opened.every(handle => handle.fd === -1), true);
});

test('a close error propagates and test cleanup closes the underlying descriptor', async t => {
  let closeAttempted = false, handleToDrain = null, realClose = null;
  const h = makeDigestContext(t, { wrapHandle(handle) {
    handleToDrain = handle;
    realClose = handle.close.bind(handle);
    handle.close = async () => {
      closeAttempted = true;
      throw Object.assign(new Error('injected close failure'), { code: 'EIO' });
    };
    return handle;
  } });
  const file = path.join(h.root, 'close-failure.bin');
  fs.writeFileSync(file, makeBytes(73));
  await assert.rejects(h.context.getAddFilesCurrentSourceDigest(file), error => error.code === 'EIO');
  assert.equal(closeAttempted, true);
  assert.notEqual(handleToDrain.fd, -1, 'the injected close failure leaves the descriptor open for test cleanup');
  await realClose();
  assert.equal(h.opened.every(handle => handle.fd === -1), true);
});

test('four concurrent large digests stay within four configured scratch buffers', async t => {
  const count = 4;
  let enteredCount = 0, resolveAllEntered, releaseReads;
  const allEntered = new Promise(resolve => { resolveAllEntered = resolve; });
  const blocked = new Promise(resolve => { releaseReads = resolve; });
  const scratchSizes = [];
  const h = makeDigestContext(t, { wrapHandle(handle) {
    const read = handle.read.bind(handle);
    handle.read = async (buffer, offset, length, position) => {
      if (position === 0 && enteredCount < count) {
        scratchSizes.push(buffer.byteLength);
        enteredCount++;
        if (enteredCount === count) resolveAllEntered();
        await blocked;
      }
      return read(buffer, offset, length, position);
    };
    return handle;
  } });
  const inputs = Array.from({ length: count }, (_, i) => {
    const file = path.join(h.root, `parallel-${i}.bin`);
    const bytes = makeBytes(MAX_BUFFER + 3, i + 1);
    fs.writeFileSync(file, bytes);
    return { file, bytes };
  });
  const digests = inputs.map(input => h.context.getAddFilesCurrentSourceDigest(input.file));
  const outcomes = digests.map(digest => digest.then(value => ({ ok: true, value }), error => ({ ok: false, error })));
  let barrierError = null;
  try {
    const enteredOrSettled = await bounded(Promise.race([
      allEntered.then(() => ({ entered: true })),
      ...outcomes.map(outcome => outcome.then(result => ({ entered: false, result }))),
    ]), 5000, 'concurrent digests neither entered all reads nor settled');
    assert.equal(enteredOrSettled.entered, true, 'all four digest reads are simultaneously held');
    assert.deepEqual(scratchSizes, Array(count).fill(expectedCapacity(MAX_BUFFER + 3)));
    assert.equal(scratchSizes.reduce((sum, size) => sum + size, 0), count * expectedCapacity(MAX_BUFFER + 3));
  } catch (error) { barrierError = error; }
  finally { releaseReads(); }
  const results = await bounded(Promise.all(outcomes), 5000, 'concurrent digests did not drain after release');
  if (barrierError) throw barrierError;
  for (const outcome of results) assert.equal(outcome.ok, true, outcome.error?.message || 'digest rejected');
  for (let i = 0; i < inputs.length; i++) {
    assert.equal(results[i].value, crypto.createHash('sha256').update(inputs[i].bytes).digest('hex'));
  }
  assert.equal(h.opened.every(handle => handle.fd === -1), true);
});
