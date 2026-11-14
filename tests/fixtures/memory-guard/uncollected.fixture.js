'use strict';
// Run only by tests/run-tests-memory-guard.test.js. Starts a child that the
// memory guard gets to see running, and then keeps this process busy while
// the child ends, so that the ended child waits about 600 ms to be collected.
// CRATE_GUARD_FIXTURE_MODE says which child:
//
//   sleep   an ordinary tool
//   ps      the system's set-uid ps, held for a moment by output nobody reads
const test = require('node:test');
const { spawn } = require('node:child_process');

const mode = process.env.CRATE_GUARD_FIXTURE_MODE;
const wideListing = ['-axwwo', Array(16).fill('command=').join(',')];

test(`an ended ${mode} waits to be collected`, async () => {
  const child = mode === 'ps'
    ? spawn('/bin/ps', wideListing, { stdio: ['ignore', 'pipe', 'ignore'] })
    : spawn('/bin/sleep', ['0.3'], { stdio: 'ignore' });
  const exited = new Promise(resolve => { child.on('exit', resolve); });
  await new Promise(resolve => { setTimeout(resolve, 200); });
  if (mode === 'ps') {
    child.stdout.resume();
    await new Promise(resolve => { child.stdout.on('end', resolve); });
  }
  // Busy, not waiting: nothing is collected until this loop is over.
  const until = Date.now() + (mode === 'ps' ? 600 : 700);
  while (Date.now() < until);
  if (await exited !== 0) throw new Error(`${mode} failed`);
});
