'use strict';
// Run only by tests/run-tests-memory-guard.test.js. Starts a small tree of idle
// processes shaped like the ones real tests start, then does what
// CRATE_GUARD_FIXTURE_MODE says:
//
//   allocate   hold memory up to this file's own 256 MB ceiling, then pass
//   idle       wait, for at most 20 seconds, then pass
//   leave      pass at once and leave the tree running
//
// The tree: a child with a child of its own; a detached child (own session and
// process group, like a browser a test launches) with a child of its own; a
// short-lived child whose detached child outlives it and is adopted by the
// system; and, with CRATE_GUARD_FIXTURE_STUBBORN=1, a detached child that
// ignores SIGTERM. Every process in it exits by itself within 20 seconds.
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const pidFile = process.env.CRATE_GUARD_FIXTURE_PIDS;
const mode = process.env.CRATE_GUARD_FIXTURE_MODE;
const stubborn = process.env.CRATE_GUARD_FIXTURE_STUBBORN === '1';
const LIFE_MS = 20000;
const STEP_MB = 8;
const STEP_PAUSE_MS = 40;
const CEILING_MB = 256;
const HOLD_MS = 1500;

const leaf = (role, extra = {}) => ({ role, life: LIFE_MS, children: [], ...extra });
const tree = [
  leaf('nested', { children: [leaf('nested-child')] }),
  leaf('detached', { detached: true, children: [leaf('detached-child')] }),
  { role: 'short-lived', life: 400, children: [leaf('adopted', { detached: true })] },
  ...(stubborn ? [leaf('stubborn', { detached: true, ignoreTerm: true })] : []),
];
const expected = ['nested', 'nested-child', 'detached', 'detached-child', 'short-lived', 'adopted',
  ...(stubborn ? ['stubborn'] : [])];

test('starts its process tree', async () => {
  for (const spec of tree) {
    spawn(process.execPath, [path.join(__dirname, 'process-tree.js'), pidFile, JSON.stringify(spec)],
      { stdio: 'ignore', detached: spec.detached === true }).unref();
  }
  const seen = () => fs.readFileSync(pidFile, 'utf8').split('\n').map(line => line.split(' ')[0]);
  for (let waited = 0; waited < 10000 && !expected.every(role => seen().includes(role)); waited += 20) {
    await new Promise(resolve => { setTimeout(resolve, 20); });
  }
  // Long enough for the guard to have seen the short-lived parent with its child.
  await new Promise(resolve => { setTimeout(resolve, 500); });
  fs.appendFileSync(pidFile, `ready ${process.pid}\n`);

  if (mode === 'allocate') {
    const held = [];
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (let megabytes = 0; megabytes < CEILING_MB; megabytes += STEP_MB) {
      held.push(Buffer.alloc(STEP_MB * 1024 * 1024, 1));
      Atomics.wait(pause, 0, 0, STEP_PAUSE_MS);
    }
    Atomics.wait(pause, 0, 0, HOLD_MS);
    held.length = 0;
  } else if (mode === 'idle') {
    await new Promise(resolve => { setTimeout(resolve, LIFE_MS); });
  }
});
