'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const EXPECTED_TEST_COUNT = 32;

function validateGeometryResult(result) {
  const errors = [];
  if (result.error) errors.push(`Browser test runner error: ${result.error.message}`);
  if (result.signal) errors.push(`Browser test runner terminated by ${result.signal}`);
  if (result.status !== 0) errors.push(`Browser test runner exit: ${result.status}`);
  const expected = {
    tests: EXPECTED_TEST_COUNT, suites: 0, pass: EXPECTED_TEST_COUNT,
    fail: 0, cancelled: 0, skipped: 0, todo: 0,
  };
  for (const [field, count] of Object.entries(expected)) {
    const matches = [...String(result.stdout || '').matchAll(new RegExp(`^# ${field} (\\d+)$`, 'gm'))];
    if (matches.length !== 1 || Number(matches[0][1]) !== count) {
      errors.push(`Expected exactly one TAP ${field} count of ${count}`);
    }
  }
  return errors;
}

function runGeometry({ spawn = spawnSync, output = process.stdout, diagnostics = process.stderr } = {}) {
  // Preserve the caller's explicit preload hooks (e.g. the isolated fixture home)
  // without forwarding inspector, test-runner or unrelated runtime switches.
  const preloads = [];
  for (let index = 0; index < process.execArgv.length; index++) {
    const argument = process.execArgv[index];
    if (argument === '--require' || argument === '-r') {
      preloads.push(argument, process.execArgv[++index]);
    } else if (argument.startsWith('--require=')) preloads.push(argument);
  }
  const result = spawn(process.execPath, [
    ...preloads, '--test', '--test-concurrency=1',
    path.join(__dirname, '..', 'tests', 'nested-asset-geometry.test.js'),
  ], { encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  if (result.stdout) output.write(result.stdout);
  if (result.stderr) diagnostics.write(result.stderr);
  const errors = validateGeometryResult(result);
  if (errors.length) diagnostics.write(`Required geometry gate FAILED:\n${errors.join('\n')}\n`);
  return errors.length ? 1 : 0;
}

module.exports = { EXPECTED_TEST_COUNT, validateGeometryResult, runGeometry };
if (require.main === module) process.exitCode = runGeometry();
