'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const continuationSuite = path.join(__dirname, 'working-source-continuation-ipc.test.js');
const raceNames = [
  'workspace shared filter retries after a selection change during its async evidence wait',
  'workspace shared filter fails closed if its project is deleted during the async evidence wait',
  'workspace recomputes current attribution after a disk identity change during its async evidence wait',
  'workspace shared filter keeps same-stat source edits out of stale package reviews',
  'workspace refreshes once; package review and package finalization verify independently',
  'workspace discards an in-flight evidence projection after account loss and permits a fresh authorized request',
];

function runOwnedChild(args, { timeout = 25000, includeRaceMode = false } = {}) {
  const ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-workspace-filter-race-'));
  const env = {
    ...process.env,
    CRATE_TEST_OUTPUT_ROOT: ownedRoot,
    TMPDIR: ownedRoot,
    TMP: ownedRoot,
    TEMP: ownedRoot,
  };
  if (includeRaceMode) env.CRATE_WORKSPACE_FILTER_RACE_CHILD = '1';
  else delete env.CRATE_WORKSPACE_FILTER_RACE_CHILD;
  delete env.NODE_TEST_CONTEXT;
  let result;
  let cleanupError;
  try {
    result = spawnSync(process.execPath, args, {
      cwd: path.resolve(__dirname, '..'),
      env,
      encoding: 'utf8',
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    });
  } finally {
    try { fs.rmSync(ownedRoot, { recursive: true, force: true }); }
    catch (error) { cleanupError = error; }
  }
  return { result, output: `${result?.stdout || ''}${result?.stderr || ''}`, cleanupError,
    cleaned: !fs.existsSync(ownedRoot) };
}

test('isolated race runner removes child-owned files after timeout', { timeout: 5000 }, () => {
  const script = [
    "require('node:fs').writeFileSync(process.env.CRATE_TEST_OUTPUT_ROOT + '/marker', 'synthetic')",
    "process.stdout.write('fixture-created')",
    'setInterval(() => {}, 1000)',
  ].join(';');
  const { result, output, cleanupError, cleaned } = runOwnedChild(['-e', script], { timeout: 200 });
  assert.equal(result.error?.code, 'ETIMEDOUT', output);
  assert.match(output, /fixture-created/);
  assert.ifError(cleanupError);
  assert.equal(cleaned, true);
});

for (const name of raceNames) {
  test(name, { timeout: 30000 }, () => {
    const { result, output, cleanupError, cleaned } = runOwnedChild([
      '--test-reporter=tap',
      '--test-name-pattern',
      `^${name}$`,
      continuationSuite,
    ], { includeRaceMode: true });
    assert.ifError(cleanupError);
    assert.ifError(result?.error);
    assert.equal(result?.status, 0, `${name} child failed:\n${output}`);
    assert.match(output, /# tests 1\n# suites 0\n# pass 1\n# fail 0\n/);
    assert.equal(cleaned, true, 'child-owned synthetic files were removed');
  });
}
