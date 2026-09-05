'use strict';

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runBoundedAddFilesScan } = require('../parsers/add-files-operation');

const regexWorkerPath = path.join(__dirname, '..', 'parsers', 'add-files-regex-worker.js');

function runRegexWorker(filePath) {
  return new Promise((resolve, reject) => {
    const child = fork(regexWorkerPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let message = null;
    child.once('error', reject);
    child.on('message', nextMessage => { message = nextMessage; });
    child.once('exit', code => resolve({ code, message }));
    child.once('spawn', () => child.send({ type: 'parse', filePath }));
  });
}

function createFakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    setTimeout(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    tick: async delay => {
      now += delay;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.callback();
      }
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('a slow scan that settles before its own deadline succeeds', async () => {
  const clock = createFakeClock();
  const scan = deferred();
  let applied = 0;
  const running = runBoundedAddFilesScan(async lease => {
    await scan.promise;
    assert.equal(lease.current(), true);
    applied += 1;
    return 'ok';
  }, { timeoutMs: 100, ...clock });

  await clock.tick(50);
  scan.resolve();
  const result = await running;
  assert.equal(result.value, 'ok');
  assert.equal(applied, 1);
  assert.equal(result.timedOut, undefined);
});

test('a never-settling scan times out and fences a late mutation', async () => {
  const clock = createFakeClock();
  const scan = deferred();
  let lateMutation = 0;
  const running = runBoundedAddFilesScan(async lease => {
    await scan.promise;
    if (lease.current()) lateMutation += 1;
    return 'late';
  }, { timeoutMs: 100, ...clock });

  await clock.tick(100);
  const result = await running;
  assert.equal(result.timedOut, true);
  assert.equal(result.lease.state, 'timed-out');

  scan.resolve();
  await result.settled;
  assert.equal(lateMutation, 0);
});

test('a stale project operation cancels the scan without mutating late state', async () => {
  const clock = createFakeClock();
  const scan = deferred();
  let current = true;
  let lateMutation = 0;
  const running = runBoundedAddFilesScan(async lease => {
    await scan.promise;
    if (lease.current()) lateMutation += 1;
    return 'late';
  }, { timeoutMs: 100, parentCurrent: () => current, ...clock });

  current = false;
  scan.resolve();
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.equal(result.reason, 'stale-project-operation');
  assert.equal(lateMutation, 0);
});

test('a timed-out scan can be retried with a fresh lease', async () => {
  const clock = createFakeClock();
  const first = deferred();
  const firstRun = runBoundedAddFilesScan(() => first.promise, { timeoutMs: 25, ...clock });
  await clock.tick(25);
  assert.equal((await firstRun).timedOut, true);

  const secondRun = await runBoundedAddFilesScan(async lease => {
    assert.equal(lease.current(), true);
    return 'retry-ok';
  }, { timeoutMs: 25, ...clock });
  assert.equal(secondRun.value, 'retry-ok');
});

test('the Add Files regex worker preserves absolute-path matching and source identity', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-add-files-regex-worker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'source.ai');
  const linkedPath = '/Users/synthetic/linked asset.png';
  fs.writeFileSync(sourcePath, `%PDF-1.7\n${linkedPath}\n%%EOF\n`, { mode: 0o600 });

  const { code, message } = await runRegexWorker(sourcePath);
  assert.equal(code, 0);
  assert.equal(message.type, 'result');
  assert.deepEqual(message.result.paths, [linkedPath]);
  assert.equal(message.result.sourceIdentity.size, fs.statSync(sourcePath).size);
  assert.equal(typeof message.result.sourceDigest, 'string');
});
