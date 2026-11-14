'use strict';
// Run only by tests/run-tests-memory-guard.test.js. Starts one idle child,
// waits until the memory guard has seen it, and passes while the child is
// still running. CRATE_GUARD_FIXTURE_MODE says how long the child lives:
//
//   brief     1.5 seconds: it ends by itself soon after the run
//   lasting   20 seconds: the run leaves it behind
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const pidFile = process.env.CRATE_GUARD_FIXTURE_PIDS;
const life = process.env.CRATE_GUARD_FIXTURE_MODE === 'brief' ? 1500 : 20000;
const pause = milliseconds => new Promise(resolve => { setTimeout(resolve, milliseconds); });

test('passes while its child is still running', async () => {
  spawn(process.execPath, [path.join(__dirname, 'process-tree.js'), pidFile, JSON.stringify({ role: 'nested', life, children: [] })],
    { stdio: 'ignore' }).unref();
  for (let waited = 0; waited < 10000 && !fs.readFileSync(pidFile, 'utf8').includes('nested '); waited += 20) await pause(20);
  await pause(300);
  fs.appendFileSync(pidFile, `ready ${process.pid}\n`);
  // A few more samples with everything up.
  await pause(300);
});
