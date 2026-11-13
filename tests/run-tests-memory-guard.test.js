'use strict';
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('./bounded-assert');
const {
  parseArguments, findRunProcesses, DEFAULT_PROCESS_LIMIT_MB, DEFAULT_TOTAL_LIMIT_MB, MEMORY_LIMIT_EXIT_CODE,
} = require('../scripts/run-tests');

const root = path.resolve(__dirname, '..');
const runTests = path.join(root, 'scripts/run-tests.js');
const growing = path.join(__dirname, 'fixtures/memory-guard/growing.fixture.js');
const outcomes = path.join(__dirname, 'fixtures/memory-guard/outcomes.fixture.js');

function runGuarded(args, extraEnvironment = {}) {
  // A nested `node --test` must not inherit this test process's reporter channel.
  const environment = { ...process.env, ...extraEnvironment };
  delete environment.NODE_TEST_CONTEXT;
  delete environment.CRATE_TEST_MEMORY_LIMIT_MB;
  delete environment.CRATE_TEST_TOTAL_MEMORY_LIMIT_MB;
  Object.assign(environment, extraEnvironment);
  const started = Date.now();
  const result = spawnSync(process.execPath, [runTests, '--test-reporter=tap', ...args],
    { cwd: root, encoding: 'utf8', timeout: 60000, env: environment });
  return { ...result, seconds: (Date.now() - started) / 1000 };
}

test('a test process that passes the per-process limit is killed and named', { timeout: 90000 }, () => {
  const result = runGuarded(['--memory-limit-mb=256', growing]);
  assert.equal(result.error, undefined);
  assert.equal(result.status, MEMORY_LIMIT_EXIT_CODE, result.stderr);
  assert.match(result.stderr, /run-tests: MEMORY LIMIT EXCEEDED after [\d.]+ s: process \d+ reached \d+ MB \(limit 256 MB per process\)\./);
  assert.match(result.stderr, /run-tests: {3}\S.*growing\.fixture\.js/);
  assert.match(result.stderr, /run-tests: Killed the test run \(\d+ processes\)\./);
  // The fixture stops by itself at 1 GB and would then pass: it never got there.
  assert.doesNotMatch(result.stdout, /^ok 1 /m);
  const reached = Number(/reached (\d+) MB/.exec(result.stderr)[1]);
  assert.ok(reached > 256 && reached < 900, `stopped at ${reached} MB`);
});

test('a run that passes the total limit is killed even when no single process is over', { timeout: 90000 }, () => {
  const result = runGuarded(['--memory-limit-mb=2048', '--total-memory-limit-mb=300', growing]);
  assert.equal(result.status, MEMORY_LIMIT_EXIT_CODE, result.stderr);
  assert.match(result.stderr, /run-tests: MEMORY LIMIT EXCEEDED after [\d.]+ s: the run reached \d+ MB across \d+ processes \(limit 300 MB in total\)\./);
  assert.match(result.stderr, /largest: process \d+ at \d+ MB: .*growing\.fixture\.js/);
  assert.doesNotMatch(result.stdout, /^ok 1 /m);
});

test('the limits can come from the environment', { timeout: 90000 }, () => {
  const result = runGuarded([growing], { CRATE_TEST_MEMORY_LIMIT_MB: '256' });
  assert.equal(result.status, MEMORY_LIMIT_EXIT_CODE, result.stderr);
  assert.match(result.stderr, /limit 256 MB per process/);
});

test('an ordinary run reports its results and exit status unchanged', { timeout: 90000 }, () => {
  const passing = runGuarded([outcomes]);
  assert.equal(passing.status, 0, passing.stderr);
  assert.match(passing.stdout, /^ok 1 - passes$/m);
  assert.match(passing.stdout, /^# pass 1$/m);
  assert.match(passing.stdout, /^# fail 0$/m);
  assert.match(passing.stderr, /^run-tests: memory guard on; peak \d+ MB in one process, \d+ MB in total \(limits [\d.]+ GB and [\d.]+ GB\)$/m);
  assert.doesNotMatch(passing.stderr, /MEMORY LIMIT EXCEEDED/);

  const failing = runGuarded([outcomes], { CRATE_GUARD_FIXTURE_FAIL: '1' });
  assert.equal(failing.status, 1, failing.stderr);
  assert.match(failing.stdout, /^ok 1 - passes$/m);
  assert.match(failing.stdout, /^not ok 2 - fails$/m);
  assert.doesNotMatch(failing.stderr, /MEMORY LIMIT EXCEEDED/);

  const filtered = runGuarded(['--test-name-pattern=passes', outcomes], { CRATE_GUARD_FIXTURE_FAIL: '1' });
  assert.equal(filtered.status, 0, filtered.stderr);
  assert.match(filtered.stdout, /^# pass 1$/m);
});

test('a limit that is not a whole number of megabytes is refused before anything runs', () => {
  for (const args of [['--memory-limit-mb=0'], ['--memory-limit-mb=lots'], ['--total-memory-limit-mb=-5'], ['--memory-limit-mb=']]) {
    const result = runGuarded([...args, outcomes]);
    if (args[0] === '--memory-limit-mb=') {
      assert.equal(result.status, 0, 'an empty value keeps the default');
      continue;
    }
    assert.equal(result.status, 2, args[0]);
    assert.match(result.stderr, /must be a whole number of megabytes/);
    assert.equal(result.stdout, '');
  }
  const environment = runGuarded([outcomes], { CRATE_TEST_TOTAL_MEMORY_LIMIT_MB: '1.5' });
  assert.equal(environment.status, 2);
  assert.match(environment.stderr, /CRATE_TEST_TOTAL_MEMORY_LIMIT_MB must be a whole number of megabytes, got "1\.5"/);
});

test('arguments go to node --test, with the serial whole suite as the default', () => {
  const everyTestFile = fs.readdirSync(__dirname).filter(name => name.endsWith('.test.js')).sort()
    .map(name => path.relative(process.cwd(), path.join(__dirname, name)));
  assert.ok(everyTestFile.length > 90);

  const whole = parseArguments([], {});
  assert.deepEqual(whole.nodeArguments, ['--test', '--test-concurrency=1', ...everyTestFile]);
  assert.deepEqual(whole.limits, { process: DEFAULT_PROCESS_LIMIT_MB, total: DEFAULT_TOTAL_LIMIT_MB });

  const chosen = parseArguments(['--test-name-pattern=focus', 'tests/renderer-figma-scope.test.js'], {});
  assert.deepEqual(chosen.nodeArguments,
    ['--test', '--test-concurrency=1', '--test-name-pattern=focus', 'tests/renderer-figma-scope.test.js']);

  const patternOnly = parseArguments(['--test-name-pattern', 'focus'], {});
  assert.deepEqual(patternOnly.nodeArguments,
    ['--test', '--test-concurrency=1', '--test-name-pattern', 'focus', ...everyTestFile]);

  const missingFile = parseArguments(['tests/not-there.test.js'], {});
  assert.deepEqual(missingFile.nodeArguments, ['--test', '--test-concurrency=1', 'tests/not-there.test.js']);

  const glob = parseArguments(['--test-concurrency=2', 'tests/figma-*.test.js'], {});
  assert.deepEqual(glob.nodeArguments, ['--test', '--test-concurrency=2', 'tests/figma-*.test.js']);

  const limited = parseArguments(['--memory-limit-mb=512', '--total-memory-limit-mb=1024', 'tests/file-uri.test.js'],
    { CRATE_TEST_MEMORY_LIMIT_MB: '4096', CRATE_TEST_TOTAL_MEMORY_LIMIT_MB: '9000' });
  assert.deepEqual(limited.limits, { process: 512, total: 1024 });
  assert.deepEqual(limited.nodeArguments, ['--test', '--test-concurrency=1', 'tests/file-uri.test.js']);
  assert.deepEqual(parseArguments(['tests/file-uri.test.js'],
    { CRATE_TEST_MEMORY_LIMIT_MB: '4096', CRATE_TEST_TOTAL_MEMORY_LIMIT_MB: '9000' }).limits, { process: 4096, total: 9000 });
});

test('the run is the runner, its descendants, its process group and its recent orphans, and nothing else', () => {
  const row = (pid, ppid, pgid) => ({ pid, ppid, pgid, megabytes: 1 });
  const rows = [
    row(1, 0, 1),
    row(process.pid, 1, process.pid),
    row(100, process.pid, 100),      // the runner
    row(101, 100, 100),              // a test file
    row(102, 101, 100),              // something the test file started
    row(103, 102, 103),              // a grandchild that made its own process group
    row(104, 1, 100),                // reparented, still in the runner's group
    row(105, 1, 105),                // orphaned into its own group, seen in the run last time
    row(200, process.pid, 200),      // this guard's own helper
    row(300, 1, 300),                // unrelated
    row(301, 300, 300),              // unrelated
  ];
  const found = findRunProcesses(rows, 100, new Map([[105, row(105, 102, 105)]]));
  assert.deepEqual([...found.keys()].sort((a, b) => a - b), [100, 101, 102, 103, 104, 105]);
  assert.deepEqual([...findRunProcesses(rows, 100, new Map()).keys()].sort((a, b) => a - b), [100, 101, 102, 103, 104]);
  assert.deepEqual([...findRunProcesses(rows.filter(item => item.pid !== 100 && item.ppid !== 100 && item.pgid !== 100), 100, new Map()).keys()], []);
});
