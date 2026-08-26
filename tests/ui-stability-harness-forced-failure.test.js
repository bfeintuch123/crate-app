'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const harness = fs.readFileSync(
  path.join(__dirname, 'ui-stability-electron-harness.js'),
  'utf8',
);
const policy = fs.readFileSync(
  path.join(__dirname, 'ui-stability-harness-policy.js'),
  'utf8',
);

test('UI stability harness exposes an explicit fail-closed verification mode', () => {
  assert.match(
    harness,
    /FORCE_FAILURE = process\.env\.CRATE_UI_FORCE_FAILURE === '1'/,
  );
  assert.match(
    harness,
    /forced harness failure for exit-code verification/,
  );
  assert.match(harness, /forcedFailure: FORCE_FAILURE/);
  assert.match(harness, /getHarnessExitCode\(\{/);
  assert.match(harness, /finalizeHarnessProcess\(\{/);
  assert.match(policy, /processModule\.exitCode = finalExitCode/);
  assert.match(policy, /appModule\.exit\(finalExitCode\)/);
});

test('UI stability harness flushes its structured report before exiting Electron', () => {
  assert.match(harness, /async function writeReport\(report\)/);
  assert.match(harness, /process\.stdout\.write\(output, error =>/);
  assert.match(harness, /await writeReport\(report\)/);
});
