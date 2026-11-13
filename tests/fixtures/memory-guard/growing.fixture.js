'use strict';
// Run only by tests/run-tests-memory-guard.test.js. Holds a little more memory
// every few milliseconds without yielding to the event loop, so the guard has
// something to stop. It is finite on its own: it never holds more than
// CEILING_MB, lets go after HOLD_MS, and then passes. If the guard does
// nothing, this costs 256 MB for under three seconds.
const test = require('node:test');

const STEP_MB = 8;
const STEP_PAUSE_MS = 40;
const CEILING_MB = 256;
const HOLD_MS = 1500;

test('holds more memory step by step, up to its own ceiling', () => {
  const held = [];
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let megabytes = 0; megabytes < CEILING_MB; megabytes += STEP_MB) {
    held.push(Buffer.alloc(STEP_MB * 1024 * 1024, 1));
    Atomics.wait(pause, 0, 0, STEP_PAUSE_MS);
  }
  Atomics.wait(pause, 0, 0, HOLD_MS);
  held.length = 0;
});
