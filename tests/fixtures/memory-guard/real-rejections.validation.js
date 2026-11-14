'use strict';
// A validation, not part of the suite: its name keeps it out of `npm test`.
// Run it by itself, and not under the memory guard, because each case is a run
// the guard is meant to stop:
//
//   node --test --test-concurrency=1 tests/fixtures/memory-guard/real-rejections.validation.js
//
// It runs the real guard over real set-uid tools that the guard must not let
// through (see the header of scripts/run-tests.js): a tool other than ps, a ps
// that does not finish, and more ps at once than the guard allows. Every case
// is finite without the guard; see system-tools.fixture.js.
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const assert = require('../../bounded-assert');
const { EXIT_GUARD_FAILURE, SYSTEM_TOOL } = require('../../../scripts/run-tests');

const root = path.resolve(__dirname, '../../..');
const runTests = path.join(root, 'scripts/run-tests.js');
const fixture = path.join(__dirname, 'system-tools.fixture.js');
const CANNOT_READ = /run-tests: GUARD CANNOT READ PROCESS \d+ OF THE RUN after ([\d.]+) s \(errno 1, (\d+) samples in a row\)\. Its memory is unknown\./;
const ASSUMED = /these figures include an assumed 32 MB, not a measurement, for each \/bin\/ps the guard could not read/;
// The command lines the fixture starts, as `pgrep -f` patterns.
const STARTED = { ps: '^/bin/ps -axwwo (command=,){15}command=$', top: '^/usr/bin/top -l 3 -s 1$' };

const isSetUidRoot = file => (fs.statSync(file).mode & 0o4000) !== 0 && fs.statSync(file).uid === 0;
const applies = process.platform === 'darwin' && process.getuid() !== 0 && isSetUidRoot(SYSTEM_TOOL.path) && isSetUidRoot('/usr/bin/top');

function running(pattern) {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).split('\n').filter(Boolean).length;
  } catch {
    return 0; // pgrep exits 1 when nothing matches
  }
}

function guardedRun(mode) {
  const environment = { ...process.env, CRATE_GUARD_FIXTURE_MODE: mode };
  for (const name of ['NODE_TEST_CONTEXT', 'CRATE_TEST_MEMORY_LIMIT_MB', 'CRATE_TEST_TOTAL_MEMORY_LIMIT_MB', 'CRATE_TEST_DEADLINE_SECONDS']) {
    delete environment[name];
  }
  const started = Date.now();
  const child = spawn(process.execPath, [runTests, '--test-reporter=tap', fixture], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stdout.resume();
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  return new Promise(resolve => {
    child.on('close', code => resolve({ code, stderr, seconds: (Date.now() - started) / 1000 }));
  });
}

// A process that has nothing to do with the run and must come through untouched.
function bystander(t) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
  let exited = false;
  child.on('exit', () => { exited = true; });
  t.after(() => child.kill('SIGKILL'));
  return () => !exited;
}

async function rejected(t, mode, tool) {
  assert.equal(running(STARTED[tool]), 0, 'nothing like the fixture\'s tool is running before the case starts');
  const survived = bystander(t);
  const result = await guardedRun(mode);
  assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
  assert.match(result.stderr, CANNOT_READ);
  assert.match(result.stderr, /run-tests: Every process of the run has ended\./);
  assert.equal(running(STARTED[tool]), 0, 'the tool the run started is gone');
  assert.equal(survived(), true);
  const [, seconds, samples] = CANNOT_READ.exec(result.stderr);
  return { ...result, stoppedAfter: Number(seconds), samples: Number(samples) };
}

test('a real set-uid tool other than ps stops the run at once', { skip: !applies, timeout: 60000 }, async t => {
  const result = await rejected(t, 'top', 'top');
  assert.equal(result.samples, 1);
  assert.doesNotMatch(result.stderr, ASSUMED);
  assert.ok(result.seconds < 10, `took ${result.seconds} s`);
});

test('a real ps that does not finish is let through for its allowance and then stops the run', { skip: !applies, timeout: 60000 }, async t => {
  const result = await rejected(t, 'blocked-ps', 'ps');
  // Stopped by the clock (two seconds) or by the count (forty samples), whichever came first.
  assert.ok(result.samples > 1 && result.samples <= SYSTEM_TOOL.samples + 1, `after ${result.samples} samples`);
  assert.ok(result.stoppedAfter >= 1.5 && result.seconds < 8, `stopped after ${result.stoppedAfter} s, took ${result.seconds} s`);
  assert.match(result.stderr, ASSUMED);
});

test('more real ps at once than the guard allows stops the run at once', { skip: !applies, timeout: 60000 }, async t => {
  const result = await rejected(t, 'nine-ps', 'ps');
  assert.equal(result.samples, 1);
  assert.ok(result.seconds < 8, `took ${result.seconds} s`);
});
