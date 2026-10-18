'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EXPECTED_TEST_COUNT, validateGeometryResult, runGeometry } = require('../scripts/run-nested-asset-geometry');

const summary = (changes = {}) => Object.entries({
  tests: EXPECTED_TEST_COUNT, suites: 0, pass: EXPECTED_TEST_COUNT,
  fail: 0, cancelled: 0, skipped: 0, todo: 0, ...changes,
}).filter(([, value]) => value !== null).map(([key, value]) => `# ${key} ${value}`).join('\n') + '\n';
const result = (changes = {}) => ({ status: 0, signal: null, stdout: summary(), ...changes });

test('geometry runner accepts only the complete expected successful result', () => {
  assert.deepEqual(validateGeometryResult(result()), []);
});
for (const field of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
  test(`geometry runner rejects missing ${field} summary`, () => {
    assert.ok(validateGeometryResult(result({ stdout: summary({ [field]: null }) })).length);
  });
}
for (const [name, changes] of [
  ['skipped browser cases with exit zero', { tests: 32, pass: 0, skipped: 32 }],
  ['one skipped case', { pass: 31, skipped: 1 }],
  ['cancelled case', { pass: 31, cancelled: 1 }],
  ['failed case', { pass: 31, fail: 1 }],
  ['todo case', { pass: 31, todo: 1 }],
  ['zero tests', { tests: 0, pass: 0 }],
  ['missing case', { tests: 31, pass: 31 }],
  ['unexpected extra case', { tests: 33, pass: 33 }],
  ['unexpected suite', { suites: 1 }],
]) {
  test(`geometry runner rejects ${name}`, () => {
    assert.ok(validateGeometryResult(result({ stdout: summary(changes) })).length);
  });
}
for (const [name, changes] of [
  ['nonzero exit', { status: 1 }],
  ['signal', { status: null, signal: 'SIGTERM' }],
  ['spawn failure', { status: null, error: new Error('not available') }],
  ['missing exit status', { status: undefined }],
  ['empty output', { stdout: '' }],
  ['duplicate count', { stdout: summary() + '# tests 32\n' }],
]) {
  test(`geometry runner rejects ${name} even with otherwise passing output`, () => {
    assert.ok(validateGeometryResult(result(changes)).length);
  });
}
for (const valid of [false, true]) {
  test(`geometry command returns ${valid ? 'success' : 'failure'} after validating child output`, () => {
    const output = [], errors = [];
    const exit = runGeometry({
      spawn: (executable, args, options) => {
        assert.equal(executable, process.execPath);
        assert.ok(args.at(-1).endsWith('nested-asset-geometry.test.js'));
        assert.ok(options.timeout > 0 && options.maxBuffer > 0);
        return result({ stdout: valid ? summary() : summary({ skipped: 1, pass: 31 }) });
      },
      output: { write: text => output.push(text) },
      diagnostics: { write: text => errors.push(text) },
    });
    assert.equal(exit, valid ? 0 : 1);
    assert.equal(errors.join('').includes('geometry gate FAILED'), !valid);
    assert.ok(output.length);
  });
}
