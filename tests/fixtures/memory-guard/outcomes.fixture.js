'use strict';
// Run only by tests/run-tests-memory-guard.test.js: one test that passes and,
// when asked, one that fails, to show the guard passes results through.
const test = require('node:test');

test('passes', () => {
  if (1 + 1 !== 2) throw new Error('arithmetic is broken');
});

if (process.env.CRATE_GUARD_FIXTURE_FAIL === '1') {
  test('fails', () => {
    throw new Error('this test fails on purpose');
  });
}
