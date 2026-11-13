'use strict';
// Run only by tests/run-tests-memory-guard.test.js: one test that passes and,
// when asked, one that fails, to show the guard passes results through.
const test = require('node:test');
const assert = require('../../bounded-assert');

test('passes', () => {
  assert.equal(1 + 1, 2);
});

if (process.env.CRATE_GUARD_FIXTURE_FAIL === '1') {
  test('fails', () => {
    assert.equal(1 + 1, 3);
  });
}
