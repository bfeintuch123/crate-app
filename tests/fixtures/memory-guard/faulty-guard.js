'use strict';
// Helper for tests/run-tests-memory-guard.test.js, not a test. Runs the real
// guard (scripts/run-tests.js) as a real command, with one fault injected
// between the guard and its sampler, to show what the guard does when it
// cannot read or cannot end a process of the run. The fault names a role from
// the pid file the fixture process tree writes:
//
//   CRATE_GUARD_FAULT=undeliverable:<role>         signals to that process are reported sent but never delivered
//   CRATE_GUARD_FAULT=unreadable:<role>            that process's start time and memory cannot be read
//   CRATE_GUARD_FAULT=unreadable-after-run:<role>  the same, but only once the test file has ended
//
// Everything else goes to the real sampler untouched.
const fs = require('node:fs');
const guard = require('../../../scripts/run-tests');

const [kind, role] = String(process.env.CRATE_GUARD_FAULT).split(':');
const EPERM = 1;
const recorded = () => new Map(fs.readFileSync(process.env.CRATE_GUARD_FIXTURE_PIDS, 'utf8').split('\n').filter(Boolean)
  .map(line => line.split(' ')).map(([name, pid]) => [name, Number(pid)]));

// The test file's process and the test runner above it, learned from the tree
// while it is up: the test file is the parent of the role `nested`.
let testFilePid = null;
let runnerPid = null;

async function startFaultySampler() {
  const real = await guard.startCheckedSampler();
  const unreadable = rows => {
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
    return rows.map(row => (row.pid === target ? { ...row, start: '0', megabytes: 0, usageError: EPERM } : row));
  };
  return {
    get pid() { return real.pid; },
    get dead() { return real.dead; },
    stop: () => real.stop(),
    scan: async (...args) => (kind.startsWith('unreadable') ? unreadable(await real.scan(...args)) : real.scan(...args)),
    signalGroup: (...args) => real.signalGroup(...args),
    async signalProcesses(name, rows) {
      if (kind !== 'undeliverable') return real.signalProcesses(name, rows);
      const target = recorded().get(role);
      const deliverable = rows.filter(row => row.pid !== target);
      const results = deliverable.length > 0 ? await real.signalProcesses(name, deliverable) : [];
      return rows.map(row => (row.pid === target ? 'sent' : results[deliverable.indexOf(row)]));
    },
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
