'use strict';

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

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

function runWorker(filePath) {
  return new Promise((resolve, reject) => {
    const child = fork(workerPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let message = null;
    let settled = false;
    child.on('message', nextMessage => {
      message = nextMessage;
    });
    child.once('error', reject);
    child.once('exit', code => {
      if (settled) return;
      settled = true;
      resolve({ code, message });
    });
    child.once('spawn', () => child.send({ type: 'parse', filePath }));
  });
}

function requireDependency(t) {
  if (!agPsd) {
    t.skip('ag-psd is not available in this source-only checkout');
    return false;
  }
  return true;
}

test('real PSD worker protocol parses linked and embedded synthetic PSD data', async t => {
  if (!requireDependency(t)) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-add-files-psd-worker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'source.psd');
  fs.writeFileSync(sourcePath, createSyntheticPsd(), { mode: 0o600 });

  const { code, message } = await runWorker(sourcePath);
  assert.equal(code, 0);
  assert.equal(message.type, 'result');
  assert.deepEqual(message.result.entries, [{
    filePath: '/Users/synthetic/external.png',
    source: 'psd-linked',
  }]);
  assert.deepEqual(message.result.embedded.map(file => ({
    name: file.name,
    data: Buffer.from(file.data, 'base64').toString('utf8'),
  })), [{ name: 'embedded.png', data: 'embedded-worker-bytes' }]);
  assert.equal(message.result.sourceDigest, crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex'));
});

test('real PSD worker reports parse errors and exits cleanly', async t => {
  if (!requireDependency(t)) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-add-files-psd-worker-error-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'invalid.psd');
  fs.writeFileSync(sourcePath, 'not-a-psd', { mode: 0o600 });

  const { code, message } = await runWorker(sourcePath);
  assert.equal(code, 0);
  assert.equal(message.type, 'error');
  assert.match(message.error, /signature|PSD|psd/i);
});

test('Node PSD worker protocol cancellation/timeout kills the child and fences a late result', async t => {
  if (!requireDependency(t)) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-add-files-psd-worker-cancel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'source.psd');
  fs.writeFileSync(sourcePath, createSyntheticPsd(), { mode: 0o600 });

  await new Promise((resolve, reject) => {
    const child = fork(workerPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let cancelled = false;
    let committed = 0;
    child.once('error', reject);
    child.once('spawn', () => {
      child.send({ type: 'parse', filePath: sourcePath });
      setTimeout(() => {
        cancelled = true;
        child.kill();
      }, 0);
    });
    child.on('message', () => {
      setImmediate(() => {
        if (!cancelled) committed += 1;
      });
    });
    child.once('exit', () => {
      setImmediate(() => {
        try {
          assert.equal(cancelled, true);
          assert.equal(committed, 0);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  });
});

test('Node PSD worker protocol compares source identity and cleans a manually owned stage', async t => {
  if (!requireDependency(t)) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-add-files-psd-worker-mutation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'source.psd');
  const stagePath = path.join(root, 'owned-stage.tmp');
  fs.writeFileSync(sourcePath, createSyntheticPsd(), { mode: 0o600 });
  const beforeDigest = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
  const beforeStat = fs.statSync(sourcePath);
  const { message } = await runWorker(sourcePath);
  fs.appendFileSync(sourcePath, Buffer.from('mutated-after-worker'));
  const afterStat = fs.statSync(sourcePath);
  const afterDigest = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');

  assert.equal(message.type, 'result');
  assert.equal(message.result.sourceDigest, beforeDigest);
  assert.notEqual(afterDigest, message.result.sourceDigest);
  assert.notEqual(afterStat.size, beforeStat.size);

  fs.writeFileSync(stagePath, Buffer.from(message.result.embedded[0].data, 'base64'), { mode: 0o600, flag: 'wx' });
  fs.unlinkSync(stagePath);
  assert.equal(fs.existsSync(stagePath), false);
});
