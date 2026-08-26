'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  analyzeOuterSizeRequest,
  finalizeHarnessProcess,
  getHarnessExitCode,
} = require('./ui-stability-harness-policy');

const configuredMinimum = Object.freeze({ width: 1100, height: 760 });

test('outer-size policy accepts an exact supported Electron window size', () => {
  const result = analyzeOuterSizeRequest({
    requestedSize: { width: 1280, height: 800 },
    actualSize: { width: 1280, height: 800 },
    configuredMinimum,
    workArea: { width: 1440, height: 884 },
    allowWorkAreaCap: true,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.disposition, 'exact');
  assert.equal(result.workAreaCapped, false);
  assert.equal(result.failure, null);
});

test('outer-size policy accepts only the visible macOS work-area cap', () => {
  const result = analyzeOuterSizeRequest({
    requestedSize: { width: 1440, height: 900 },
    actualSize: { width: 1440, height: 884 },
    configuredMinimum,
    workArea: { width: 1440, height: 884 },
    allowWorkAreaCap: true,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.disposition, 'work-area-capped');
  assert.deepEqual(result.expectedSize, { width: 1440, height: 884 });
  assert.deepEqual(result.cappedDimensions, ['height']);
  assert.equal(result.workAreaCapped, true);
});

test('outer-size policy rejects a mismatch that the work area does not explain', () => {
  const result = analyzeOuterSizeRequest({
    requestedSize: { width: 1440, height: 900 },
    actualSize: { width: 1400, height: 884 },
    configuredMinimum,
    workArea: { width: 1440, height: 884 },
    allowWorkAreaCap: true,
  });

  assert.equal(result.accepted, false);
  assert.equal(result.disposition, 'unexpected-size');
  assert.match(result.failure, /does not explain the mismatch/);
});

test('outer-size policy does not excuse a hidden-window mismatch as a work-area cap', () => {
  const result = analyzeOuterSizeRequest({
    requestedSize: { width: 1440, height: 900 },
    actualSize: { width: 1440, height: 884 },
    configuredMinimum,
    workArea: { width: 1440, height: 884 },
    allowWorkAreaCap: false,
  });

  assert.equal(result.accepted, false);
  assert.equal(result.disposition, 'unexpected-size');
  assert.match(result.failure, /eligible work area not enabled/);
});

test('outer-size policy never accepts an actual size below the desktop minimum', () => {
  const result = analyzeOuterSizeRequest({
    requestedSize: { width: 1100, height: 760 },
    actualSize: { width: 1090, height: 750 },
    configuredMinimum,
    workArea: { width: 1090, height: 750 },
    allowWorkAreaCap: true,
  });

  assert.equal(result.accepted, false);
  assert.equal(result.disposition, 'below-minimum');
  assert.match(result.failure, /below the configured minimum/);
});

test('harness exit policy is fail-closed for every reported error channel', () => {
  assert.equal(getHarnessExitCode(), 0);
  assert.equal(getHarnessExitCode({ failures: ['geometry failure'] }), 1);
  assert.equal(getHarnessExitCode({ pageErrors: ['renderer gone'] }), 1);
  assert.equal(getHarnessExitCode({ consoleErrors: ['uncaught error'] }), 1);
});

test('harness finalizer exits Electron with the computed nonzero status', () => {
  const exits = [];
  const removals = [];
  const processModule = { exitCode: 0 };
  const result = finalizeHarnessProcess({
    appModule: { exit: code => exits.push(code) },
    fsModule: { rmSync: (...args) => removals.push(args) },
    processModule,
    temporaryUserData: '/tmp/synthetic-harness-user-data',
    exitCode: 1,
  });

  assert.equal(result, 1);
  assert.equal(processModule.exitCode, 1);
  assert.deepEqual(exits, [1]);
  assert.deepEqual(removals, [[
    '/tmp/synthetic-harness-user-data',
    { recursive: true, force: true },
  ]]);
});

test('harness finalizer remains fail-closed when cleanup throws', () => {
  const exits = [];
  const cleanupErrors = [];
  const processModule = { exitCode: 0 };
  const result = finalizeHarnessProcess({
    appModule: { exit: code => exits.push(code) },
    fsModule: { rmSync: () => { throw new Error('cleanup failed'); } },
    processModule,
    temporaryUserData: '/tmp/synthetic-harness-user-data',
    exitCode: 0,
    onCleanupError: error => cleanupErrors.push(error.message),
  });

  assert.equal(result, 1);
  assert.equal(processModule.exitCode, 1);
  assert.deepEqual(exits, [1]);
  assert.deepEqual(cleanupErrors, ['cleanup failed']);
});
