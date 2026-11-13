'use strict';
// Run only by tests/run-tests-memory-guard.test.js. Holds more memory every few
// milliseconds without ever yielding to the event loop, the way a runaway test
// does, so the guard has something to stop. If nothing stops it, it gives up
// on its own at a ceiling that is harmless on any machine and the test passes.
const test = require('node:test');

const STEP_MB = 16;
const CEILING_MB = 1024;

test('holds more and more memory', () => {
  const held = [];
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let megabytes = 0; megabytes < CEILING_MB; megabytes += STEP_MB) {
    held.push(Buffer.alloc(STEP_MB * 1024 * 1024, 1));
    Atomics.wait(pause, 0, 0, 20);
  }
});
