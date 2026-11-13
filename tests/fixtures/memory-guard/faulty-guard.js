'use strict';
// Helper for tests/run-tests-memory-guard.test.js, not a test. Runs the real
// guard (scripts/run-tests.js) as a real command, with one fault injected
// between the guard and its samplers, to show what the guard does when it
// cannot read, cannot end, or cannot watch a run. A <role> is a name from the
// pid file the fixture process tree writes.
//
//   CRATE_GUARD_FAULT=undeliverable:<role>         signals to that process are reported sent but never delivered
//   CRATE_GUARD_FAULT=unreadable:<role>            that process's start time and memory cannot be read
//   CRATE_GUARD_FAULT=unreadable-after-run:<role>  the same, but only once the test run has ended
//   CRATE_GUARD_FAULT=unreadable-runner            the test runner itself cannot be read, from the first scan
//   CRATE_GUARD_FAULT=primary-fails                the sampler in use fails once the tree is up, and no new one can be started
//   CRATE_GUARD_FAULT=all-samplers-fail            the same, and the sampler standing by fails too
//
// Everything else goes to the real sampler untouched.
const fs = require('node:fs');
const guard = require('../../../scripts/run-tests');

const [kind, role] = String(process.env.CRATE_GUARD_FAULT).split(':');
const EPERM = 1;
const recorded = () => new Map(fs.readFileSync(process.env.CRATE_GUARD_FIXTURE_PIDS, 'utf8').split('\n').filter(Boolean)
  .map(line => line.split(' ')).map(([name, pid]) => [name, Number(pid)]));
const cannotRead = row => ({ ...row, start: '0', megabytes: 0, usageError: EPERM });

const samplerPids = new Set();
let opened = 0;
// The test file's process and the test runner above it, learned from the tree
// while it is up: the test file is the parent of the role `nested`.
let testFilePid = null;
let runnerPid = null;

function misread(rows) {
  if (kind === 'unreadable-runner') {
    // The runner is the guard's only child that is not a sampler.
    return rows.map(row => (row.ppid === process.pid && !samplerPids.has(row.pid) ? cannotRead(row) : row));
  }
  if (!kind.startsWith('unreadable')) return rows;
  const pids = recorded();
  const target = pids.get(role);
  const nested = rows.find(row => row.pid === pids.get('nested'));
  const testFile = nested && nested.ppid > 1 && rows.find(row => row.pid === nested.ppid);
  if (testFile && testFile.ppid > 1 && runnerPid === null) {
    testFilePid = testFile.pid;
    runnerPid = testFile.ppid;
  }
  const runEnded = runnerPid !== null && !rows.some(row => row.pid === testFilePid || row.pid === runnerPid);
  if (kind === 'unreadable-after-run' && !runEnded) return rows;
  return rows.map(row => (row.pid === target ? cannotRead(row) : row));
}

async function startFaultySampler() {
  opened += 1;
  const number = opened;
  const samplersFail = kind === 'primary-fails' || kind === 'all-samplers-fail';
  if (samplersFail && number > 2) throw new Error('no new sampler can be started (injected)');
  const real = await guard.startCheckedSampler();
  samplerPids.add(real.pid);
  // The first sampler is the one in use, the second the one standing by.
  const failsOnceTreeIsUp = samplersFail && (number === 1 || kind === 'all-samplers-fail');
  let failed = false;
  const use = async action => {
    if (failsOnceTreeIsUp && (failed || recorded().has('ready'))) {
      failed = true;
      throw new Error('sampler exited (injected)');
    }
    return action();
  };
  const signalProcesses = async (name, rows) => {
    if (kind !== 'undeliverable') return real.signalProcesses(name, rows);
    const target = recorded().get(role);
    const deliverable = rows.filter(row => row.pid !== target);
    const results = deliverable.length > 0 ? await real.signalProcesses(name, deliverable) : [];
    return rows.map(row => (row.pid === target ? 'sent' : results[deliverable.indexOf(row)]));
  };
  return {
    get pid() { return real.pid; },
    get dead() { return failed || real.dead; },
    stop: () => real.stop(),
    scan: (...args) => use(async () => misread(await real.scan(...args))),
    signalGroup: (...args) => use(() => real.signalGroup(...args)),
    signalProcesses: (name, rows) => use(() => signalProcesses(name, rows)),
  };
}

guard.runGuard({
  argv: process.argv.slice(2),
  env: process.env,
  startSampler: startFaultySampler,
  timing: { confirmMs: 600, leftoverGraceMs: 300 },
}).then(code => process.exit(code), error => {
  process.stderr.write(`faulty-guard: ${error && error.stack ? error.stack : error}\n`);
  process.exit(99);
});
