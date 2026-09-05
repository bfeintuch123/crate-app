'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createAddFilesScanLease } = require('../parsers/add-files-operation');

// Exercise the production coordinator without starting the application. Unlike
// the broader IPC double, this models Electron's false kill before spawn.
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const start = main.indexOf('function runAddFilesWorker(');
const end = main.indexOf('async function assertDependableAssetBaselineSource(', start);
assert.ok(start >= 0 && end > start);

function harness(kind) {
  const child = new EventEmitter();
  const kills = [];
  const messages = [];
  let alive = false;
  child.kill = () => {
    kills.push(alive);
    if (!alive) return false;
    alive = false;
    child.emit('exit', 0);
    return true;
  };
  child.postMessage = message => messages.push(message);
  const context = {
    path, setImmediate,
    utilityProcess: { fork: () => child },
    ADD_FILES_PSD_WORKER_PATH: 'psd-worker.js',
    ADD_FILES_REGEX_WORKER_PATH: 'regex-worker.js',
  };
  vm.createContext(context);
  vm.runInContext(main.slice(start, end), context);
  let deadline;
  let timerCleared = false;
  const lease = createAddFilesScanLease({
    timeoutMs: 10,
    setTimeout: callback => { deadline = callback; return 1; },
    clearTimeout: () => { timerCleared = true; },
  });
  let listeners = 0;
  const onCancel = lease.onCancel;
  lease.onCancel = listener => {
    listeners++;
    const unsubscribe = onCancel(listener);
    return () => { listeners--; unsubscribe(); };
  };
  return {
    child, kills, messages, lease,
    run: () => context[`runAddFiles${kind}Worker`]('/synthetic/source', lease, {
      sessionId: 'test', finalReceived: false, check() {}, setWorkerExit() {},
      async consume(message) { this.finalReceived = true; return message.result; },
    }),
    spawn: () => { alive = true; child.emit('spawn'); },
    timeout: () => deadline(),
    get alive() { return alive; },
    get listeners() { return listeners; },
    get timerCleared() { return timerCleared; },
    result: kind === 'Psd' ? { entries: [] } : { paths: [] },
  };
}

for (const kind of ['Psd', 'Regex']) {
  for (const reason of ['cancel', 'timeout', 'already-cancelled', 'error']) {
    test(`${kind}: ${reason} before spawn retries a false kill and fences late results`, async () => {
      const h = harness(kind);
      if (reason === 'already-cancelled') h.lease.cancel();
      let resolutions = 0;
      let rejections = 0;
      const outcome = h.run().then(
        () => { resolutions++; },
        error => { rejections++; return error; }
      );
      if (reason === 'timeout') h.timeout();
      else if (reason === 'error') h.child.emit('error', new Error('worker failed'));
      else h.lease.cancel();
      const error = await outcome;
      assert.match(error.message, reason === 'error' ? /worker failed/ : /add_files_parser_cancelled/);
      assert.deepEqual(h.kills, [false]);
      assert.equal(h.listeners, 0);
      h.spawn();
      assert.deepEqual(h.kills, [false, true]);
      assert.equal(h.alive, false);
      assert.deepEqual(h.messages, []);
      h.child.emit('message', { type: 'result', sessionId: 'test', seq: 0, result: h.result });
      h.child.emit('exit', 0);
      await Promise.resolve();
      assert.equal(resolutions, 0);
      assert.equal(rejections, 1);
      assert.deepEqual(h.kills, [false, true]);
      if (reason === 'timeout') assert.equal(h.lease.state, 'timed-out');
      h.lease.dispose();
      assert.equal(h.timerCleared, true);
    });
  }

  for (const reason of ['cancel', 'timeout']) {
    test(`${kind}: ${reason} after spawn terminates once and ignores late results`, async () => {
      const h = harness(kind);
      const work = h.run();
      h.spawn();
      assert.equal(h.messages.length, 1);
      if (reason === 'timeout') h.timeout();
      else h.lease.cancel();
      await assert.rejects(work, /add_files_parser_cancelled/);
      h.child.emit('message', { type: 'result', sessionId: 'test', seq: 0, result: h.result });
      assert.deepEqual(h.kills, [true]);
      assert.equal(h.alive, false);
      assert.equal(h.listeners, 0);
      h.lease.dispose();
    });
  }

  test(`${kind}: success removes cancellation listener and lets the worker exit normally`, async () => {
    const h = harness(kind);
    const work = h.run();
    h.spawn();
    assert.equal(h.messages.length, 1);
    h.child.emit('message', { type: 'result', sessionId: 'test', seq: 0, result: h.result });
    assert.equal(await work, h.result);
    assert.equal(h.listeners, 0);
    h.timeout();
    h.child.emit('exit', 0);
    assert.deepEqual(h.kills, []);
    h.lease.dispose();
  });
}
