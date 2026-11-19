'use strict';
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const assert = require('./bounded-assert');
const {
  parseArguments, parseRow, createOwnership, createGuard, measureRun, formatOver, formatSecondsOver, startCheckedSampler, UsageError, TIMING,
  describeUnreadable, parseDescription, EXITING,
  DEFAULT_PROCESS_LIMIT_MB, DEFAULT_TOTAL_LIMIT_MB, DEFAULT_DEADLINE_SECONDS, UNREADABLE_SAMPLES,
  EXIT_MEMORY_LIMIT, EXIT_DEADLINE, EXIT_GUARD_FAILURE, ZOMBIE, ESRCH, EPERM, SYSTEM_TOOL,
} = require('../scripts/run-tests');

const root = path.resolve(__dirname, '..');
const runTests = path.join(root, 'scripts/run-tests.js');
const fixtures = path.join(__dirname, 'fixtures/memory-guard');
const growing = path.join(fixtures, 'growing.fixture.js');
const outcomes = path.join(fixtures, 'outcomes.fixture.js');
const descendants = path.join(fixtures, 'descendants.fixture.js');
const faultyGuard = path.join(fixtures, 'faulty-guard.js');
const systemPs = path.join(fixtures, 'system-ps.fixture.js');
const uncollected = path.join(fixtures, 'uncollected.fixture.js');
const endsWithChild = path.join(fixtures, 'ends-with-child.fixture.js');
const samplerFile = path.join(root, 'scripts/run-tests-sampler.py');
const samplerHarness = path.join(fixtures, 'sampler-harness.py');

// ---------------------------------------------------------------------------
// The guard's decisions, on a simulated process table. Nothing real is started
// or signalled in this half of the file.

const GUARD = 10;
const SAMPLER = 11;
const STANDBY = 13;
const RUNNER = 100;
const OWNER = 501; // the user the guard runs as

function row(pid, ppid, pgid, extra = {}) {
  return {
    pid, ppid, pgid, uid: OWNER, ruid: OWNER, status: 2, start: `started-${pid}`, megabytes: 10, infoError: 0, usageError: 0, path: null, ...extra,
  };
}
const unreadableRow = (pid, ppid, pgid, errno = EPERM) => row(pid, ppid, pgid, { start: '0', megabytes: 0, usageError: errno });
// What the sampler reports for the system's set-uid ps, started by the guard's user.
const psRow = (pid, ppid, pgid, extra = {}) => row(pid, ppid, pgid,
  { uid: 0, start: '0', megabytes: 0, usageError: EPERM, path: SYSTEM_TOOL.path, ...extra });

// A process table that reacts to signals the way the system does: SIGSTOP and
// SIGCONT freeze and resume, SIGKILL removes (children pass to pid 1), other
// signals remove unless the process ignores them. Like the real sampler, it
// checks the start time at the moment of each signal and reports what it did.
function simulate(rows, { collected = false } = {}) {
  const table = new Map(rows.map(item => [item.pid, { ...item }]));
  const delivered = [];
  const attempts = [];
  const held = [];
  const afterScan = new Map();
  const races = new Map();
  let scans = 0;
  let clock = 0;
  const remove = pid => {
    table.delete(pid);
    for (const item of table.values()) if (item.ppid === pid) item.ppid = 1;
    // The guard collects its runner as soon as the runner is gone.
    if (pid === RUNNER) machine.collected = true;
  };
  const deliver = (item, name, target) => {
    delivered.push([target, name]);
    if (name === 'SIGSTOP') item.frozen = true;
    else if (name === 'SIGCONT') item.frozen = false;
    else if (name === 'SIGKILL' ? !item.unkillable : !item.ignoresTerm) remove(item.pid);
  };
  const check = target => {
    const item = table.get(target.pid);
    if (!item) return 'gone';
    if (item.usageError !== 0) return 'unreadable';
    return item.start === target.start ? null : 'mismatch';
  };
  const machine = {
    table,
    delivered,
    attempts,
    // Group signals sent by the runner's pid alone, without a start-time check.
    held,
    // Whether the guard has collected the runner. Until then the runner's pid
    // is the runner's, and the group that carries it is the run's.
    collected,
    get scans() { return scans; },
    deliveredTo: pid => delivered.filter(([target]) => target === pid).map(([, name]) => name),
    // Runs `change` right after scan number `number` is taken, before the
    // guard acts on it: something that happens behind the guard's back.
    after(number, change) { afterScan.set(number, change); },
    replace(pid, item) { remove(pid); table.set(item.pid, { ...item }); },
    // The one thing no check can exclude: between the check of the start time
    // and the signal itself, the process ends and `item` receives its pid.
    raceOnNextSignalTo(pid, item) { races.set(pid, item); },
    scan: async () => {
      scans += 1;
      const snapshot = [...table.values()].map(item => ({ ...item }));
      if (afterScan.has(scans)) afterScan.get(scans)();
      return snapshot;
    },
    signalProcesses: async (name, targets) => targets.map(target => {
      attempts.push([target.pid, name]);
      const problem = check(target);
      if (problem) return problem;
      if (races.has(target.pid)) {
        machine.replace(target.pid, races.get(target.pid));
        races.delete(target.pid);
      }
      deliver(table.get(target.pid), name, target.pid);
      return 'sent';
    }),
    signalGroup: async (name, pgid, member) => {
      attempts.push([-pgid, name]);
      const problem = check(member);
      if (problem) return problem;
      if (table.get(member.pid).pgid !== pgid) return 'mismatch';
      for (const item of [...table.values()].filter(candidate => candidate.pgid === pgid)) deliver(item, name, -pgid);
      return 'sent';
    },
    signalGroupWhileHeld: name => {
      if (machine.collected) throw new Error('the guard signalled the group by number after collecting the runner');
      held.push(name);
      attempts.push([-RUNNER, name]);
      for (const item of [...table.values()].filter(candidate => candidate.pgid === RUNNER)) deliver(item, name, -RUNNER);
      return true;
    },
    sleep: async ms => { clock += ms; },
    now: () => clock,
  };
  return machine;
}

function guardFor(machine, { seed = null } = {}) {
  const ownership = createOwnership({ guardPid: GUARD, guardUid: OWNER, helperPids: [SAMPLER, STANDBY], runnerPid: RUNNER, now: () => 0 });
  if (seed) applied(ownership, seed, true);
  const anomalies = [];
  const guard = createGuard({
    ownership,
    runnerPid: RUNNER,
    scan: machine.scan,
    signalProcesses: machine.signalProcesses,
    signalGroup: machine.signalGroup,
    signalGroupWhileHeld: machine.signalGroupWhileHeld,
    sleep: machine.sleep,
    now: machine.now,
    isRunnerGone: () => machine.collected,
    onAnomaly: message => anomalies.push(message),
  });
  return { ownership, guard, anomalies };
}

// A scan given to ownership through take(), the one way a scan reaches it; what the run is afterwards.
const applied = (ownership, rows, runnerExists) => ownership.take(rows, runnerExists).owned;

const system = [row(1, 0, 1), row(GUARD, 1, GUARD), row(SAMPLER, GUARD, GUARD), row(STANDBY, GUARD, GUARD), row(12, GUARD, GUARD)];
// `clock.now` is the ownership's time in milliseconds; a test moves it.
const newOwnership = (clock = { now: 0 }) => createOwnership(
  { guardPid: GUARD, guardUid: OWNER, helperPids: [SAMPLER, STANDBY], runnerPid: RUNNER, now: () => clock.now });
const stranger = [row(200, 1, 200), row(201, 200, 200)];
const run = [
  row(RUNNER, GUARD, RUNNER),   // the test runner, leader of its own group
  row(101, RUNNER, RUNNER),     // a test file
  row(102, 101, RUNNER),        // something the test file started
  row(103, 101, 103),           // started detached: own session and group
  row(104, 103, 103),           // started by the detached process
];
const pids = owned => [...owned.keys()].sort((a, b) => a - b);
const clean = { survivors: [], unverified: [] };

test('the run is the runner, its group, everything they started and everything identified before; nobody else', () => {
  const ownership = newOwnership();
  const inGroupOrphan = row(105, 1, RUNNER); // lost its parent before any scan, still in the runner's group
  assert.deepEqual(pids(applied(ownership, [...system, ...stranger, ...run, inGroupOrphan], true)), [100, 101, 102, 103, 104, 105]);
  assert.equal(ownership.groupMember(true).pid, RUNNER);
  assert.equal(ownership.groupMember(false), null);
  assert.equal(ownership.runnerStart, 'started-100');

  // The test file is gone. Its children now belong to pid 1, the detached ones
  // in a group of their own; they stay in the run because they were identified in it.
  const orphaned = [row(RUNNER, GUARD, RUNNER), row(102, 1, RUNNER), row(103, 1, 103), row(104, 103, 103), inGroupOrphan];
  assert.deepEqual(pids(applied(ownership, [...system, ...stranger, ...orphaned], true)), [100, 102, 103, 104, 105]);

  // The runner is gone too. Its group id no longer shows anything: a process
  // in that group that was never identified is not taken to be the run's.
  const unseen = row(106, 1, RUNNER);
  const afterRunner = [row(102, 1, RUNNER), row(103, 1, 103), row(104, 103, 103), inGroupOrphan, unseen, row(107, 104, 103)];
  assert.deepEqual(pids(applied(ownership, [...system, ...stranger, ...afterRunner], false)), [102, 103, 104, 105, 107]);
  assert.equal(ownership.groupMember(false), null);
});

test('a process missing from one scan is still the run\'s when it shows up again with the same start time', () => {
  const ownership = newOwnership();
  applied(ownership, [...system, ...run], true);
  // The detached pair is adopted by pid 1 and, for one scan, not listed at all.
  assert.deepEqual(pids(applied(ownership, [...system, row(RUNNER, GUARD, RUNNER)], true)), [100]);
  assert.deepEqual(pids(applied(ownership, [...system, row(RUNNER, GUARD, RUNNER), row(103, 1, 103), row(104, 1, 103)], true)), [100, 103, 104]);
});

test('a pid is the run\'s only together with its start time', () => {
  const ownership = newOwnership();
  applied(ownership, [...system, ...run], true);
  // 103 ended and the system gave its pid to an unrelated process, which has a
  // child of its own. The run's old 104 passed to pid 1 and is still the run's.
  const reused = [row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER), row(102, 101, RUNNER),
    row(103, 1, 103, { start: 'someone-else' }), row(300, 103, 103), row(104, 1, 104)];
  assert.deepEqual(pids(applied(ownership, [...system, ...reused], true)), [100, 101, 102, 104]);
  // The same for the runner's own pid once the runner is gone.
  const runnerReused = [row(RUNNER, 1, RUNNER, { start: 'someone-else' }), row(301, RUNNER, RUNNER), row(104, 1, 104)];
  assert.deepEqual(pids(applied(ownership, [...system, ...runnerReused], false)), [104]);
});

test('the runner is the root of the run by its own pid from the first scan, readable or not', () => {
  // Its start time and memory cannot be read. It is the root all the same, with
  // everything it started, and the guard cannot watch the run.
  const unreadable = newOwnership();
  const fromTheStart = [...system, unreadableRow(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER), row(103, 101, 103)];
  assert.deepEqual(pids(applied(unreadable, fromTheStart, true)), [100, 101, 103]);
  assert.deepEqual(unreadable.readFailure(), { pid: RUNNER, problem: 'unreadable', errno: EPERM, samples: 1 });
  assert.equal(unreadable.runnerStart, null);
  assert.equal(unreadable.groupMember(true), null);
  assert.equal(unreadable.groupUsable, true);

  // Nothing but its pid can be read.
  const opaque = newOwnership();
  const onlyPid = row(RUNNER, 0, 0, { status: 0, start: '0', megabytes: 0, infoError: EPERM, usageError: EPERM });
  assert.deepEqual(pids(applied(opaque, [...system, onlyPid, row(101, RUNNER, RUNNER)], true)), [100, 101]);
  assert.deepEqual(opaque.readFailure(), { pid: RUNNER, problem: 'unreadable', errno: EPERM, samples: 1 });

  // Unreadable the way an ending process is: tolerated for a few samples only.
  const ending = newOwnership();
  for (let sample = 1; sample <= UNREADABLE_SAMPLES; sample += 1) {
    applied(ending, [...system, unreadableRow(RUNNER, GUARD, RUNNER, ESRCH)], true);
    assert.equal(ending.readFailure(), null, `sample ${sample}`);
  }
  applied(ending, [...system, unreadableRow(RUNNER, GUARD, RUNNER, ESRCH)], true);
  assert.deepEqual(ending.readFailure(), { pid: RUNNER, problem: 'unreadable', errno: ESRCH, samples: UNREADABLE_SAMPLES + 1 });
});

test('a runner that exists and is not listed, or is listed as something this guard did not start, makes the guard give up', () => {
  const missing = newOwnership();
  for (let sample = 1; sample <= UNREADABLE_SAMPLES; sample += 1) {
    assert.deepEqual(pids(applied(missing, [...system, ...stranger], true)), []);
    assert.equal(missing.readFailure(), null, `sample ${sample}`);
  }
  applied(missing, [...system, ...stranger], true);
  assert.deepEqual(missing.readFailure(), { pid: RUNNER, problem: 'missing', errno: ESRCH, samples: UNREADABLE_SAMPLES + 1 });
  // Listed again: watched again.
  assert.deepEqual(pids(applied(missing, [...system, ...run], true)), [100, 101, 102, 103, 104]);
  assert.equal(missing.readFailure(), null);

  const inconsistent = { pid: RUNNER, problem: 'inconsistent', errno: 0, samples: 1 };
  const notOurChild = newOwnership();
  applied(notOurChild, [...system, row(RUNNER, 1, RUNNER), row(101, RUNNER, RUNNER)], true);
  assert.deepEqual(notOurChild.readFailure(), inconsistent);
  assert.equal(notOurChild.groupMember(true), null);

  const otherGroup = newOwnership();
  applied(otherGroup, [...system, row(RUNNER, GUARD, 555)], true);
  assert.deepEqual(otherGroup.readFailure(), inconsistent);
  assert.equal(otherGroup.groupUsable, false, 'its group is not signalled by number');

  const restarted = newOwnership();
  applied(restarted, [...system, ...run], true);
  assert.equal(restarted.readFailure(), null);
  applied(restarted, [...system, row(RUNNER, GUARD, RUNNER, { start: 'another-start' })], true);
  assert.deepEqual(restarted.readFailure(), inconsistent);

  // A runner that has ended and waits to be collected is neither.
  const ended = newOwnership();
  applied(ended, [...system, ...run], true);
  applied(ended, [...system, row(RUNNER, GUARD, RUNNER, { status: ZOMBIE, start: '0', megabytes: 0, usageError: ESRCH })], true);
  assert.equal(ended.readFailure(), null);
});

test('once the guard has collected the runner, a process holding the runner\'s old pid is nothing to the run', () => {
  const ownership = newOwnership();
  applied(ownership, [...system, ...run], true);
  const reused = [row(RUNNER, 1, RUNNER, { start: 'someone-else' }), row(301, RUNNER, RUNNER), unreadableRow(302, RUNNER, RUNNER)];
  assert.deepEqual(pids(applied(ownership, [...system, ...reused], false)), []);
  assert.equal(ownership.readFailure(), null);
  assert.equal(ownership.groupMember(false), null);
  // Never having been listed is no failure either, once the runner is collected.
  const never = newOwnership();
  for (let sample = 0; sample < UNREADABLE_SAMPLES + 2; sample += 1) applied(never, [...system], false);
  assert.equal(never.readFailure(), null);
  // The guard and its own helpers are not part of the run, whatever the table says.
  const odd = [row(1, 0, 1), row(GUARD, RUNNER, RUNNER), row(SAMPLER, RUNNER, RUNNER), row(STANDBY, RUNNER, RUNNER), row(RUNNER, GUARD, RUNNER)];
  assert.deepEqual(pids(newOwnership().take(odd, true).owned), [100]);
});

test('a process of the run that cannot be read is kept, counted, and makes the guard give up', () => {
  const ownership = newOwnership();
  applied(ownership, [...system, ...run], true);
  assert.equal(ownership.readFailure(), null);

  // The detached process becomes unreadable for a reason other than ending.
  // It is not dropped, and neither is what it started.
  const blocked = [row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER), unreadableRow(103, 1, 103), row(104, 103, 103)];
  assert.deepEqual(pids(applied(ownership, [...system, ...blocked], true)), [100, 101, 103, 104]);
  assert.deepEqual(ownership.readFailure(), { pid: 103, problem: 'unreadable', errno: EPERM, samples: 1 });
  // Readable again: no failure.
  applied(ownership, [...system, row(RUNNER, GUARD, RUNNER), row(103, 1, 103), row(104, 103, 103)], true);
  assert.equal(ownership.readFailure(), null);

  // Started by the run and never readable at all.
  const born = [row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER), unreadableRow(108, 101, 108)];
  assert.deepEqual(pids(applied(ownership, [...system, ...born], true)), [100, 101, 108]);
  assert.deepEqual(ownership.readFailure(), { pid: 108, problem: 'unreadable', errno: EPERM, samples: 1 });

  // Nothing but the pid could be read (parent, group and state unknown too).
  const opaque = [row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER), row(108, 0, 0, { status: 0, start: '0', megabytes: 0, infoError: EPERM, usageError: EPERM })];
  assert.deepEqual(pids(applied(ownership, [...system, ...opaque], true)), [100, 101, 108]);
  assert.deepEqual(ownership.readFailure(), { pid: 108, problem: 'unreadable', errno: EPERM, samples: 2 });
});

test('a process that is ending may be unreadable for a few samples, and no longer', () => {
  const ownership = newOwnership();
  applied(ownership, [...system, ...run], true);
  const ending = [...system, row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER), unreadableRow(102, 101, RUNNER, ESRCH)];
  for (let sample = 1; sample <= UNREADABLE_SAMPLES; sample += 1) {
    applied(ownership, ending, true);
    assert.equal(ownership.readFailure(), null, `sample ${sample}`);
  }
  applied(ownership, ending, true);
  assert.deepEqual(ownership.readFailure(), { pid: 102, problem: 'unreadable', errno: ESRCH, samples: UNREADABLE_SAMPLES + 1 });
  // Gone: nothing to read, nothing wrong.
  applied(ownership, [...system, row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER)], true);
  assert.equal(ownership.readFailure(), null);
  // A process that has ended and waits to be collected has no memory to read.
  applied(ownership, [...system, row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER, { status: ZOMBIE, start: '0', megabytes: 0, usageError: ESRCH })], true);
  applied(ownership, [...system, row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER, { status: ZOMBIE, start: '0', megabytes: 0, usageError: EPERM })], true);
  assert.equal(ownership.readFailure(), null);
});

// What the sampler writes for a listed pid whose info and usage reads both answer ESRCH.
const noSuchProcessRow = pid => row(pid, 0, 0, { uid: 0, ruid: 0, status: 0, start: '0', megabytes: 0, infoError: ESRCH, usageError: ESRCH });

test('a process that answers "no such process" to both reads stops the run as before, and what the guard knew of it is kept for the report', () => {
  const clock = { now: 0 };
  const ownership = newOwnership(clock);
  applied(ownership, [...system, ...run.slice(0, 2), row(102, 101, RUNNER, { start: 'started-102', megabytes: 87, resident: 87, footprint: 80 })], true);
  const stuck = [...system, ...run.slice(0, 2), noSuchProcessRow(102)];
  for (let sample = 1; sample <= UNREADABLE_SAMPLES; sample += 1) {
    clock.now += 51;
    applied(ownership, stuck, true);
    assert.equal(ownership.readFailure(), null, `sample ${sample}`);
  }
  clock.now += 52;
  applied(ownership, stuck, true);
  // The rule, its sample count and its answer are those of the guard before this report existed.
  assert.deepEqual(ownership.readFailure(), { pid: 102, problem: 'unreadable', errno: ESRCH, samples: UNREADABLE_SAMPLES + 1 });
  const details = ownership.unreadDetails(102);
  const unreadScan = (at, sample) => ({ at, info: ESRCH, usage: ESRCH, exiting: false, path: null, allowedAs: null, sample, resident: null, footprint: null });
  assert.deepEqual(details, {
    errno: ESRCH, samples: UNREADABLE_SAMPLES + 1, ending: UNREADABLE_SAMPLES + 1, info: ESRCH, usage: ESRCH, exitingSince: null,
    since: 51, scans: [51, 102, 153, 205].map((at, index) => unreadScan(at, index + 1)), at: 205,
    lastRead: { ...row(102, 101, RUNNER, { start: 'started-102', megabytes: 87, resident: 87, footprint: 80 }), at: 0 },
  });
  assert.deepEqual(ownership.exitingStats, { processes: 0, longestMilliseconds: 0, largest: null });
  assert.equal(ownership.unreadDetails(101), null, 'a process that can be read has nothing to report');

  const runnerStart = '1000000000';
  const lines = describeUnreadable({
    pid: 102, runnerPid: RUNNER, runnerStart, details: { ...details, lastRead: { ...details.lastRead, start: '1240000000' } },
    scans: [{ begun: 0, ms: 2.4 }, { begun: 53.1, ms: 3.9 }, { begun: 104.6, ms: 2.2 }],
    after: { at: 290, listed: false, info: ESRCH, usage: ESRCH, record: 'none', path: `/Applications/${'x'.repeat(400)}`, timebase: { numer: 125, denom: 3 } },
    cleanup: { scans: 7, runs: [{ state: 'listed, unreadable (process info errno 3, usage errno 3)', count: 3, first: 230, last: 330 },
      { state: 'not listed', count: 4, first: 380, last: 520 }], dropped: 0 },
  });
  assert.deepEqual(lines, [
    'About process 102, which stopped the run (for diagnosis; it changes nothing about the stop):',
    '  unreadable in 4 scans in a row over 154 ms; never shown exiting; the last 4, from the first:',
    '    +0 ms: process info errno 3, usage errno 3',
    '    +51 ms: process info errno 3, usage errno 3',
    '    +102 ms: process info errno 3, usage errno 3',
    '    +154 ms: process info errno 3, usage errno 3',
    '  last read in full 205 ms before the stop: parent 101, process group 100 (the test runner\'s), uid 501, 87.0 MB (87.0 MB resident, 80.0 MB footprint), start 1240000000 (Mach absolute time), 10.000 s after the test runner started',
    '  session: not known (the sampler does not read it)',
    '  in the 7 scans from the stop to the end of the cleanup (freeze, kill, confirmation): listed, unreadable (process info errno 3, usage errno 3) in 3 (+25 to +125 ms); not listed in 4 (+175 to +315 ms)',
    `  after the cleanup (+85 ms): not listed, process info errno 3, usage errno 3; process table: no record; executable: /Applications/${'x'.repeat(286)}...`,
    '  the last 3 scans before the stop took 2.2 to 3.9 ms and began 51.5 to 53.1 ms apart',
  ]);
  // A stop the clock decided, after the last scan: times are counted from the stop, and the gap is said.
  const byClock = describeUnreadable({ pid: 102, runnerPid: RUNNER, runnerStart: null, details, scans: [], stoppedAt: 1205,
    after: { at: 1290, error: 'no answer within 500 ms' }, cleanup: { scans: 1, runs: [{ state: 'not listed', count: 1, first: 1230, last: 1230 }], dropped: 0 } });
  assert.equal(byClock[1], '  unreadable in 4 scans in a row over 154 ms; never shown exiting; the stop came 1000 ms after the last of them; the last 4, from the first:');
  assert.match(byClock[6], /^  last read in full 1205 ms before the stop: /);
  assert.deepEqual(byClock.slice(8, 10), ['  in the 1 scans from the stop to the end of the cleanup (freeze, kill, confirmation): not listed in 1 (+25 to +25 ms)',
    '  after the cleanup (+85 ms): the sampler did not describe it (no answer within 500 ms)']);
  // A record that could not be read is not "no record"; the sampler not answering is said as such; text from the system is shown escaped.
  const other = describeUnreadable({ pid: 102, runnerPid: RUNNER, runnerStart: null, details: { ...details, lastRead: null },
    scans: [], after: { at: 290, listed: true, info: ESRCH, usage: 0, record: 'unreadable', path: '/tmp/a\nrun-tests: forged', timebase: { numer: 0, denom: 0 } },
    cleanup: { scans: 0, runs: [], dropped: 0 } });
  assert.deepEqual(other.slice(6), [
    '  never read in full while it was a process of the run',
    '  session: not known (the sampler does not read it)',
    '  in the scans from the stop to the end of the cleanup: none recorded',
    '  after the cleanup (+85 ms): listed, process info errno 3, usage errno 0; process table: no whole record of that pid could be read; executable: /tmp/a\\u000arun-tests: forged',
  ]);
  assert.equal(describeUnreadable({ pid: 102, runnerPid: RUNNER, runnerStart: null, details, scans: [], after: { at: 290, error: 'no answer within 500 ms' },
    cleanup: { scans: 0, runs: [], dropped: 0 } })[9], '  after the cleanup (+85 ms): the sampler did not describe it (no answer within 500 ms)');
  assert.equal(describeUnreadable({ pid: 102, runnerPid: RUNNER, runnerStart: null, details, scans: [], after: null,
    cleanup: { scans: 0, runs: [], dropped: 0 } })[9], '  after the cleanup: not asked');
  // The sampler's answer is read strictly; an odd one, numbers out of range included, is dropped and never thrown.
  assert.deepEqual(parseDescription('1 3 3 101,100,501,501,2 /Applications/Google%20Chrome 125/3'.split(' ')), {
    listed: true, info: 3, usage: 3, record: { ppid: 101, pgid: 100, uid: 501, ruid: 501, status: 2 },
    path: '/Applications/Google Chrome', timebase: { numer: 125, denom: 3 },
  });
  assert.deepEqual(parseDescription('- 3 3 - - 0/0'.split(' ')),
    { listed: null, info: 3, usage: 3, record: 'none', path: null, timebase: { numer: 0, denom: 0 } });
  assert.equal(parseDescription('0 3 3 ? - 4294967295/1'.split(' ')).record, 'unreadable');
  for (const bad of ['1 3 3 - - 125/3 extra', '2 3 3 - - 125/3', '1 x 3 - - 125/3', '1 3 3 1,2,3 - 125/3', '1 3 3 - %E0%A4%A 125/3', '1 3 3 - - 125',
    `1 3 3 - - ${'9'.repeat(400)}/3`, '1 3 3 - - 4294967296/3', '1 3 3 - - 125/4294967296', `1 ${'9'.repeat(20)} 3 - - 125/3`,
    `1 3 3 ${'9'.repeat(30)},1,1,1,1 - 125/3`, '1 3 3 1.5,1,1,1,1 - 125/3']) {
    assert.equal(parseDescription(bad.split(' ')), null, bad.slice(0, 60));
  }
  assert.equal(parseDescription(null), null);
});

// An exiting process as the sampler reports it: libproc has no info, its usage
// answers with the start time it had, its resident size, no footprint and an exit time.
const exitingRow = (pid, ppid, pgid, extra = {}) => row(pid, 0, 0, {
  uid: 0, ruid: 0, status: 0, megabytes: 60, resident: 60, footprint: 0, infoError: ESRCH, usageError: 0, exiting: true, ...extra,
});
const tree = (...extra) => [...system, ...run.slice(0, 2), ...extra];
const full102 = row(102, 101, RUNNER, { megabytes: 87, resident: 87, footprint: 80 });

test('a process of the run that is exiting is let through for a second, counted at its last full reading or more', () => {
  const clock = { now: 0 };
  const ownership = newOwnership(clock);
  applied(ownership, tree(full102), true);
  // Six scans, more than the three a process that answers "no such process" to both reads gets.
  for (let scan = 1; scan <= 6; scan += 1) {
    clock.now += 55;
    const owned = applied(ownership, tree(exitingRow(102, 101, RUNNER, { start: 'started-102' })), true);
    assert.equal(ownership.readFailure(), null, `scan ${scan}`);
    // Counted at the larger of its last full reading (87 MB) and what its usage says now (60 MB).
    assert.equal(owned.get(102).megabytes, 87);
    assert.equal(measureRun(owned).total, 87 + 10 + 10);
  }
  // Then gone: the run goes on, and the summary knows of it.
  clock.now += 55;
  applied(ownership, tree(), true);
  assert.equal(ownership.readFailure(), null);
  assert.deepEqual(ownership.exitingStats, { processes: 1, longestMilliseconds: 275, largest: { megabytes: 60, resident: 60, footprint: 0, lastFull: 87 } });

  // What it holds while exiting counts when it is more than its last full reading.
  const larger = newOwnership(clock);
  applied(larger, tree(full102), true);
  const owned = applied(larger, tree(exitingRow(102, 101, RUNNER, { start: 'started-102', megabytes: 120, resident: 120 })), true);
  assert.equal(owned.get(102).megabytes, 120);
});

test('the exiting second ends exactly at 1000 ms: not stopped at 1000, stopped at 1000.25, with the figure as measured', () => {
  const clock = { now: 0 };
  const ownership = newOwnership(clock);
  applied(ownership, tree(full102), true);
  clock.now = 10;
  const exiting = tree(exitingRow(102, 101, RUNNER, { start: 'started-102' }));
  applied(ownership, exiting, true);
  clock.now = 10 + EXITING.milliseconds;
  assert.equal(ownership.expiredExiting(clock.now), null);
  assert.equal(ownership.take(exiting, true).stop, null);
  assert.equal(ownership.readFailure(), null);
  clock.now = 10 + EXITING.milliseconds + 0.25;
  assert.equal(ownership.expiredExiting(clock.now).exitingMilliseconds, 1000.25);
  assert.equal(ownership.take(exiting, true).stop.exitingMilliseconds, 1000.25);
});

test('an exiting process that is still exiting after a second stops the run, as one the guard cannot read', () => {
  const clock = { now: 0 };
  const ownership = newOwnership(clock);
  applied(ownership, tree(full102), true);
  clock.now = 10;
  const exiting = tree(exitingRow(102, 101, RUNNER, { start: 'started-102' }));
  applied(ownership, exiting, true);
  // Measured in time, not samples: a second from the first scan that showed it exiting, and not a moment more.
  clock.now = 10 + EXITING.milliseconds;
  applied(ownership, exiting, true);
  assert.equal(ownership.readFailure(), null);
  clock.now += 1;
  // Judged before the scan is applied: the stop comes back and the scan is not applied (still two samples).
  assert.deepEqual(ownership.take(exiting, true).stop,
    { pid: 102, problem: 'unreadable', errno: ESRCH, samples: 2, exitingMilliseconds: EXITING.milliseconds + 1, countedMegabytes: 87 });
  // A scan in between that answers "no such process" to both reads does not restart the second; it gets its own three samples.
  const mixed = newOwnership(clock);
  clock.now = 0;
  applied(mixed, tree(full102), true);
  clock.now = 10;
  applied(mixed, exiting, true);
  for (let sample = 1; sample <= UNREADABLE_SAMPLES; sample += 1) {
    clock.now += 55;
    applied(mixed, tree(noSuchProcessRow(102)), true);
    assert.equal(mixed.readFailure(), null, `sample ${sample}`);
  }
  clock.now += 55;
  applied(mixed, tree(noSuchProcessRow(102)), true);
  assert.deepEqual(mixed.readFailure(), { pid: 102, problem: 'unreadable', errno: ESRCH, samples: UNREADABLE_SAMPLES + 2 });
  const late = newOwnership(clock);
  clock.now = 0;
  applied(late, tree(full102), true);
  clock.now = 10;
  applied(late, exiting, true);
  clock.now = 900;
  applied(late, tree(noSuchProcessRow(102)), true);
  assert.equal(late.readFailure(), null);
  clock.now = 1011;
  // Ending after a scan that no longer showed it exiting, the stop still gives the figure it was counted at while exiting.
  const { stop: lateStop } = late.take(tree(noSuchProcessRow(102)), true);
  assert.deepEqual([lateStop.exitingMilliseconds, lateStop.countedMegabytes, late.row(102).megabytes], [1001, 87, 0]);
});

test('the exiting allowance is judged by the clock, as the guard asks before applying a scan', () => {
  const clock = { now: 0 };
  const ownership = newOwnership(clock);
  applied(ownership, tree(full102), true);
  assert.equal(ownership.expiredExiting(5000), null, 'nothing exiting, nothing to judge');
  clock.now = 10;
  applied(ownership, tree(exitingRow(102, 101, RUNNER, { start: 'started-102' })), true);
  // Asked at any time, before the next scan is applied: a second from the first scan that showed it exiting, and not a moment more.
  assert.equal(ownership.expiredExiting(10 + EXITING.milliseconds), null);
  assert.deepEqual(ownership.expiredExiting(10 + EXITING.milliseconds + 1),
    { pid: 102, problem: 'unreadable', errno: ESRCH, samples: 1, exitingMilliseconds: EXITING.milliseconds + 1, countedMegabytes: 87 });
  // Applied before the second is over, a scan that no longer lists it ends the allowance.
  clock.now = 500;
  applied(ownership, tree(), true);
  assert.equal(ownership.expiredExiting(5000), null);
});

test('a full reading that already carries the exit figures never lowers what an exiting process is counted at', () => {
  // The kernel publishes its cached exit figures (footprint 0, an exit time) a
  // moment before libproc stops describing the process: one full reading can carry them.
  const clock = { now: 0 };
  const ownership = newOwnership(clock);
  applied(ownership, tree(full102), true);
  clock.now = 55;
  const cached = row(102, 101, RUNNER, { start: 'started-102', megabytes: 60, resident: 60, footprint: 0, exiting: true });
  assert.equal(applied(ownership, tree(cached), true).get(102).megabytes, 60, 'a full reading is counted as read');
  clock.now = 110;
  const owned = applied(ownership, tree(exitingRow(102, 101, RUNNER, { start: 'started-102', megabytes: 60, resident: 60 })), true);
  assert.equal(owned.get(102).megabytes, 87, 'while exiting: the last full reading from before the exit figures');
  assert.equal(ownership.exitingStats.largest.lastFull, 87);
  // A full reading without exit figures replaces the one before it, as any reading does.
  const fresh = newOwnership(clock);
  applied(fresh, tree(full102), true);
  applied(fresh, tree(row(102, 101, RUNNER, { start: 'started-102', megabytes: 50, resident: 50, footprint: 40 })), true);
  assert.equal(applied(fresh, tree(exitingRow(102, 101, RUNNER, { start: 'started-102', megabytes: 30, resident: 30 })), true).get(102).megabytes, 50);
});

test('one process gets one exiting allowance, however its readings come and go', () => {
  const clock = { now: 0 };
  const ownership = newOwnership(clock);
  applied(ownership, tree(full102), true);
  clock.now = 10;
  const exiting = tree(exitingRow(102, 101, RUNNER, { start: 'started-102' }));
  applied(ownership, exiting, true);
  // Read as ended (the process table said so) and then, the table not answering, as exiting again.
  clock.now = 500;
  applied(ownership, tree(row(102, 101, RUNNER, { status: ZOMBIE, start: 'started-102', megabytes: 60, resident: 60, footprint: 0, exiting: true })), true);
  assert.equal(ownership.readFailure(), null);
  clock.now = 900;
  applied(ownership, exiting, true);
  assert.equal(ownership.readFailure(), null);
  // The second still runs from the first scan that showed it exiting.
  clock.now = 1011;
  assert.equal(ownership.take(exiting, true).stop?.exitingMilliseconds, 1001);
  assert.equal(ownership.exitingStats.processes, 1);
  // Its pid listed again with another start time is another process: a new allowance.
  const reused = newOwnership(clock);
  clock.now = 0;
  applied(reused, tree(full102), true);
  clock.now = 10;
  applied(reused, exiting, true);
  clock.now = 60;
  applied(reused, tree(), true);
  clock.now = 100;
  applied(reused, tree(row(102, 101, RUNNER, { start: 'started-again', megabytes: 20 })), true);
  clock.now = 900;
  applied(reused, tree(exitingRow(102, 101, RUNNER, { start: 'started-again' })), true);
  assert.deepEqual([reused.expiredExiting(900 + EXITING.milliseconds), reused.expiredExiting(901 + EXITING.milliseconds)?.exitingMilliseconds,
    reused.exitingStats.processes], [null, EXITING.milliseconds + 1, 2]);
});


test('nothing but an exiting process of the run, read in full before with that start time, and not the runner, gets the allowance', () => {
  // Each of these stops the run exactly as it would without the allowance:
  // `cases` gives the scans, and the samples after which the guard gives up.
  const stopsAfter = (label, first, then, expected) => {
    const clock = { now: 0 };
    const ownership = newOwnership(clock);
    applied(ownership, first, true);
    for (let sample = 1; ; sample += 1) {
      clock.now += 55;
      const owned = applied(ownership, then, true);
      const failure = ownership.readFailure();
      if (failure || sample > 10) return { failure, owned: pids(owned), sample, label, expected };
    }
  };
  // The runner itself.
  const runner = stopsAfter('runner', tree(), [...system, exitingRow(RUNNER, GUARD, RUNNER, { start: `started-${RUNNER}` }), row(101, RUNNER, RUNNER)]);
  assert.deepEqual([runner.failure, runner.sample], [{ pid: RUNNER, problem: 'unreadable', errno: ESRCH, samples: UNREADABLE_SAMPLES + 1 }, UNREADABLE_SAMPLES + 1]);
  // Without an exit time in its usage.
  const noExit = stopsAfter('no exit time', tree(full102), tree(exitingRow(102, 101, RUNNER, { start: 'started-102', exiting: false })));
  assert.deepEqual([noExit.failure, noExit.sample], [{ pid: 102, problem: 'unreadable', errno: ESRCH, samples: UNREADABLE_SAMPLES + 1 }, UNREADABLE_SAMPLES + 1]);
  // Another start time: not the process the guard read, so not the run's at all.
  const other = stopsAfter('other start', tree(full102), tree(exitingRow(102, 101, RUNNER, { start: 'someone-else' })));
  assert.deepEqual([other.failure, other.owned.includes(102), other.sample], [null, false, 11]);
  // Never read in full: a pid first seen exiting is not the run's.
  const never = stopsAfter('never read', tree(), tree(exitingRow(102, 101, RUNNER, { start: 'started-102' })));
  assert.deepEqual([never.failure, never.owned.includes(102), never.sample], [null, false, 11]);
  // Its usage denied, whatever else: no allowance.
  const denied = stopsAfter('denied', tree(full102), tree(exitingRow(102, 101, RUNNER, { start: '0', usageError: EPERM, exiting: false })));
  assert.deepEqual(denied.failure, { pid: 102, problem: 'unreadable', errno: EPERM, samples: 1 });
});

// --- the system's own ps, which this user cannot read

const withPs = (...extra) => [...system, ...stranger, ...run, ...extra];
const unreadable = (pid, samples = 1, errno = EPERM) => ({ pid, problem: 'unreadable', errno, samples });

// The system's ps as the sampler reports it alive (let through as the tool), and once killed and
// before it has ended: no process info, usage denied.
const toolRow = (pid, ppid, pgid, extra = {}) => psRow(pid, ppid, pgid, extra);
const killedPsRow = pid => row(pid, 0, 0, { uid: 0, ruid: 0, status: 0, start: '0', megabytes: 0, infoError: ESRCH, usageError: EPERM });

test('a ps or another process whose usage is denied is handled as on the base: no allowance for one that was killed', () => {
  const clock = { now: 0 };
  const stopsAt = (first, then) => {
    const ownership = newOwnership(clock);
    for (const rows of first) applied(ownership, rows, true);
    applied(ownership, then, true);
    return ownership.readFailure();
  };
  // Let through as the tool, then read as a killed ps: stopped at once, as on the base (the CI stop).
  assert.deepEqual(stopsAt([withPs(toolRow(110, 101, RUNNER))], withPs(killedPsRow(110))), unreadable(110, 2));
  // First seen in that state.
  assert.deepEqual(stopsAt([withPs(row(110, 101, RUNNER))], withPs(killedPsRow(110))), unreadable(110));
  // Another set-uid tool.
  assert.deepEqual(stopsAt([withPs(row(110, 101, RUNNER))], withPs(psRow(110, 101, RUNNER, { path: '/usr/bin/top' }))), unreadable(110));
  // Both reads "no such process" after the tool (info ESRCH and usage ESRCH): the three-sample rule, as on the base.
  const both = newOwnership(clock);
  applied(both, withPs(toolRow(110, 101, RUNNER)), true);
  for (let sample = 1; sample <= UNREADABLE_SAMPLES; sample += 1) {
    applied(both, withPs(noSuchProcessRow(110)), true);
    assert.equal(both.readFailure(), null);
  }
  const bothRow = applied(both, withPs(noSuchProcessRow(110)), true).get(110);
  assert.deepEqual([bothRow.infoError, bothRow.usageError], [ESRCH, ESRCH]);
  assert.deepEqual(both.readFailure(), unreadable(110, UNREADABLE_SAMPLES + 2, ESRCH));
  // The runner.
  const runner = newOwnership(clock);
  applied(runner, [...system, row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER)], true);
  applied(runner, [...system, killedPsRow(RUNNER), row(101, RUNNER, RUNNER)], true);
  assert.deepEqual(runner.readFailure(), unreadable(RUNNER));
});

test('an exiting process\'s second is not skipped because a later scan lets its pid through as the system tool', () => {
  const clock = { now: 0 };
  const ownership = newOwnership(clock);
  applied(ownership, withPs(row(110, 101, RUNNER, { start: 'started-110', megabytes: 50 })), true);
  clock.now = 10;
  applied(ownership, withPs(exitingRow(110, 101, RUNNER, { start: 'started-110' })), true);
  clock.now = 500;
  applied(ownership, withPs(toolRow(110, 101, RUNNER)), true);
  assert.equal(ownership.readFailure(), null, 'let through as the tool, inside the second');
  // Past the second, judged before the next scan is applied: stopped, whatever that scan would let through.
  clock.now = 10 + EXITING.milliseconds + 1;
  const { stop, owned } = ownership.take(withPs(toolRow(110, 101, RUNNER)), true);
  assert.deepEqual(stop, { pid: 110, problem: 'unreadable', errno: EPERM, samples: 2, exitingMilliseconds: EXITING.milliseconds + 1, countedMegabytes: 60 });
  assert.equal(owned.get(110).assumed, true, 'the scan that would have let it through was not applied');
  assert.deepEqual(ownership.expiredExiting(clock.now)?.exitingMilliseconds, EXITING.milliseconds + 1);
});

test('a scan reaches ownership only through take(), which judges every exiting allowance before applying it', () => {
  // Nothing else is exposed that applies a scan.
  const ownership = newOwnership();
  assert.deepEqual(Object.keys(ownership).filter(key => typeof ownership[key] === 'function').sort(),
    ['addHelper', 'endJudging', 'expiredExiting', 'groupMember', 'readFailure', 'row', 'take', 'unreadDetails']);
  // And in the guard's own source, the private apply() is called from take() alone, and nothing calls an update().
  const source = fs.readFileSync(runTests, 'utf8');
  assert.equal(source.match(/\bapply\(rows, runnerExists\)/g).length, 2, 'the definition and the one call in take()');
  assert.doesNotMatch(source, /\.update\(/);
  // An allowance that has run out: the scan is not applied, and the stop comes back instead.
  const clock = { now: 0 };
  const judged = newOwnership(clock);
  applied(judged, tree(full102), true);
  clock.now = 10;
  applied(judged, tree(exitingRow(102, 101, RUNNER, { start: 'started-102' })), true);
  clock.now = 10 + EXITING.milliseconds + 1;
  for (const late of [tree(), tree(row(102, 101, RUNNER, { start: 'started-102', status: ZOMBIE, megabytes: 0 })), tree(full102)]) {
    const before = judged.owned;
    const { stop, owned } = judged.take(late, true);
    assert.equal(stop?.exitingMilliseconds, EXITING.milliseconds + 1);
    assert.equal(owned, before, 'not applied');
  }
  // Once the outcome is settled (the cleanup), the same function applies scans as they come, as before.
  judged.endJudging();
  const { stop, owned } = judged.take(tree(), true);
  assert.deepEqual([stop, pids(owned)], [null, [100, 101]]);
});

test('the system ps, started by the run, is let through and counted at an assumed size', () => {
  const ownership = newOwnership();
  const owned = applied(ownership, withPs(psRow(110, 101, RUNNER)), true);
  assert.deepEqual(pids(owned), [100, 101, 102, 103, 104, 110]);
  assert.equal(ownership.readFailure(), null);
  assert.equal(owned.get(110).megabytes, SYSTEM_TOOL.assumedMegabytes);
  assert.equal(owned.get(110).assumed, true);
  // Still not identified: no start time, so it is not signalled by pid.
  assert.equal(owned.get(110).start, '0');
  assert.equal(owned.get(110).usageError, EPERM);
  assert.deepEqual(ownership.toolStats, { samples: 1, longestSamples: 1, longestMilliseconds: 0 });

  // Both limits see the assumed size: 5 ordinary processes of 10 MB and one ps of 32.
  const { total, largest } = measureRun(owned);
  assert.equal(total, 5 * 10 + SYSTEM_TOOL.assumedMegabytes);
  assert.equal(largest.pid, 110);
  // Started detached by a process of the run: parentage in this scan is enough.
  assert.equal(newOwnership().take(withPs(psRow(110, 104, 110)), true).owned.get(110).assumed, true);
  // An ordinary run has none.
  const plain = newOwnership();
  applied(plain, withPs(), true);
  assert.deepEqual(plain.toolStats, { samples: 0, longestSamples: 0, longestMilliseconds: 0 });
});

test('anything that is not exactly the system ps for this user stops the run as before', () => {
  const failsClosed = (label, rows, errno = EPERM, pid = 110) => {
    const ownership = newOwnership();
    const owned = applied(ownership, rows, true);
    assert.deepEqual(ownership.readFailure(), unreadable(pid, 1, errno), label);
    assert.notEqual(owned.get(pid).assumed, true, label);
    assert.equal(owned.get(pid).megabytes, 0, label);
    assert.deepEqual(ownership.toolStats.samples, 0, label);
  };
  // The path must be exactly the one the system reports for its ps, and it must have been readable.
  for (const wrongPath of [null, '', '-', '/bin/p', '/bin/ps ', ' /bin/ps', '/bin/psx', '/bin/ps/', '/bin/ps\n', '/BIN/PS', '/private/bin/ps',
    '/usr/bin/ps', '/usr/bin/top', '/usr/bin/sudo', 'ps', './bin/ps', '/bin/../bin/ps', '/tmp/bin/ps']) {
    failsClosed(`path ${JSON.stringify(wrongPath)}`, withPs(psRow(110, 101, RUNNER, { path: wrongPath })));
  }
  // It must run as root for this user: real owner the guard's user, effective owner root.
  failsClosed('started by another user', withPs(psRow(110, 101, RUNNER, { ruid: 0 })));
  failsClosed('started by a third user', withPs(psRow(110, 101, RUNNER, { ruid: 502 })));
  failsClosed('runs as a user other than root', withPs(psRow(110, 101, RUNNER, { uid: 502 })));
  failsClosed('runs as the guard\'s own user and is still unreadable', withPs(psRow(110, 101, RUNNER, { uid: OWNER })));
  // A guard that itself runs as root can read everything, so nothing is let through for it.
  const asRoot = createOwnership({ guardPid: GUARD, guardUid: 0, helperPids: [SAMPLER, STANDBY], runnerPid: RUNNER, now: () => 0 });
  applied(asRoot, withPs(psRow(110, 101, RUNNER, { ruid: 0 })), true);
  assert.deepEqual(asRoot.readFailure(), unreadable(110));
  // Unreadable for exactly the reason a set-uid tool is, and otherwise readable.
  failsClosed('usage fails for another reason', withPs(psRow(110, 101, RUNNER, { usageError: 13 })), 13);
  // Parent, group and owners unreadable as well: such a row cannot be placed in
  // the run by this scan at all, only kept from the one before.
  const opaque = newOwnership();
  applied(opaque, withPs(row(110, 101, RUNNER)), true);
  applied(opaque, withPs(psRow(110, 101, RUNNER, { infoError: EPERM })), true);
  assert.deepEqual(opaque.readFailure(), unreadable(110));
  // The runner itself is never the tool.
  const asRunner = newOwnership();
  applied(asRunner, [...system, psRow(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER)], true);
  assert.deepEqual(asRunner.readFailure(), unreadable(RUNNER));
  // A ps that is ending (no such process) is not let through as the tool; it is the ordinary short grace.
  const ending = newOwnership();
  const gone = applied(ending, withPs(psRow(110, 101, RUNNER, { usageError: ESRCH })), true);
  assert.equal(ending.readFailure(), null);
  assert.notEqual(gone.get(110).assumed, true);
  applied(ending, withPs(psRow(110, 101, RUNNER)), true);
  for (let sample = 1; sample <= UNREADABLE_SAMPLES; sample += 1) {
    applied(ending, withPs(psRow(110, 101, RUNNER, { usageError: ESRCH })), true);
    assert.equal(ending.readFailure(), null, 'let through, then ending: the grace counts the samples that said it was ending');
  }
  applied(ending, withPs(psRow(110, 101, RUNNER, { usageError: ESRCH })), true);
  assert.deepEqual(ending.readFailure(), unreadable(110, UNREADABLE_SAMPLES + 3, ESRCH));
  // A ps that has ended and waits to be collected counts for nothing, for as long as that takes.
  const collected = newOwnership();
  applied(collected, withPs(psRow(110, 101, RUNNER)), true);
  for (let sample = 0; sample < 3 * SYSTEM_TOOL.samples; sample += 1) {
    const ended = applied(collected, withPs(psRow(110, 101, RUNNER, { status: ZOMBIE, path: null })), true);
    assert.equal(collected.readFailure(), null);
    assert.notEqual(ended.get(110).assumed, true);
    assert.equal(measureRun(ended).total, 5 * 10);
  }
  assert.equal(collected.toolStats.samples, 1);
});

test('a process that has ended teaches the guard no identity, and one known before stays known', () => {
  // An ended child of the run that no scan saw alive. Its row carries a start time.
  const ownership = newOwnership();
  assert.deepEqual(pids(applied(ownership, withPs(row(110, 101, RUNNER, { status: ZOMBIE, start: 'someone' })), true)), [100, 101, 102, 103, 104, 110]);
  assert.equal(ownership.readFailure(), null);
  // Collected. A process that is tied to the run by nothing now holds that pid, with that very start time.
  const unrelated = row(110, 200, 200, { start: 'someone' });
  assert.deepEqual(pids(applied(ownership, withPs(unrelated), true)), [100, 101, 102, 103, 104]);

  // A process the guard knew alive is still the run's when it has ended, wherever it now hangs.
  const known = newOwnership();
  applied(known, withPs(row(110, 103, 110)), true);
  const ended = applied(known, [...system, ...stranger, row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER), row(110, 1, 110, { status: ZOMBIE })], true);
  assert.deepEqual(pids(ended), [100, 101, 110]);
  assert.equal(known.readFailure(), null);

  // What reads as ended is taken as ended only when its parent, group and state could be read.
  const unclear = newOwnership();
  applied(unclear, withPs(unreadableRow(110, 101, RUNNER, ESRCH)), true);
  applied(unclear, withPs(unreadableRow(110, 0, 0, EPERM)), true);
  assert.deepEqual(unclear.readFailure(), unreadable(110, 2));
  const stillUnclear = newOwnership();
  applied(stillUnclear, withPs(unreadableRow(110, 101, RUNNER, ESRCH)), true);
  applied(stillUnclear, withPs({ ...unreadableRow(110, 0, 0, EPERM), status: ZOMBIE, infoError: ESRCH }), true);
  assert.deepEqual(stillUnclear.readFailure(), unreadable(110, 2));
});

test('a process that has ended is left out of what the run holds, whatever size the system still reports for it', () => {
  const ownership = newOwnership();
  applied(ownership, withPs(row(110, 101, RUNNER, { megabytes: 3000 }), row(111, 110, RUNNER, { megabytes: 70 })), true);
  // Ended, not collected: the same start time, and the resident size it had at the end. What it started lives on.
  const endedRow = row(110, 101, RUNNER, { status: ZOMBIE, megabytes: 3000 });
  const owned = applied(ownership, withPs(endedRow, row(111, 1, RUNNER, { megabytes: 70 })), true);
  assert.deepEqual(pids(owned), [100, 101, 102, 103, 104, 110, 111]);
  assert.equal(ownership.readFailure(), null);
  assert.deepEqual([measureRun(owned).total, measureRun(owned).largest.pid], [5 * 10 + 70, 111]);
  // Nothing but ended processes: nothing held, and no largest process.
  assert.deepEqual(measureRun(new Map([[110, endedRow], [112, psRow(112, 101, RUNNER, { status: ZOMBIE, path: null })]])), { total: 0, largest: null });
  // Alive, it counts in full. So does a row that says "ended" where the state could not be read at all.
  assert.equal(measureRun(applied(ownership, withPs(row(110, 101, RUNNER, { megabytes: 3000 })), true)).largest.pid, 110);
  assert.equal(measureRun(new Map([[110, { ...endedRow, infoError: ESRCH }]])).total, 3000);
  // A ps that is let through still counts at its assumed size.
  assert.equal(measureRun(newOwnership().take(withPs(psRow(110, 101, RUNNER)), true).owned).total, 5 * 10 + SYSTEM_TOOL.assumedMegabytes);
});

test('what an unreadable process started stays in the run when that process has ended', () => {
  // Scan 1: a ps started by the detached process, let through.
  const ownership = newOwnership();
  assert.equal(applied(ownership, withPs(psRow(110, 103, 103)), true).get(110).assumed, true);
  // Scan 2 is not one instant. It read a new process while its parent, the
  // ps, was alive, and the ps after it had ended and after its own parent had
  // gone: the ps now hangs under pid 1, outside the runner's group. Nothing
  // but the ended ps ties the new process to the run.
  const rest = [...system, ...stranger, row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER), row(102, 101, RUNNER)];
  const endedPs = psRow(110, 1, 103, { status: ZOMBIE, path: null });
  const owned = applied(ownership, [...rest, endedPs, row(111, 110, 111, { megabytes: 70 })], true);
  assert.deepEqual(pids(owned), [100, 101, 102, 110, 111]);
  assert.equal(ownership.readFailure(), null);
  assert.equal(measureRun(owned).largest.pid, 111);
  assert.notEqual(owned.get(110).assumed, true);
  assert.equal(ownership.toolStats.samples, 1);
  // The ended ps is no evidence for letting another ps through.
  const strict = newOwnership();
  applied(strict, withPs(psRow(110, 103, 103)), true);
  applied(strict, [...rest, endedPs, psRow(112, 110, 103)], true);
  assert.deepEqual(strict.readFailure(), unreadable(112));

  // Scan 3: the ps has been collected. The new process is known by now, whoever holds pid 110.
  assert.deepEqual(pids(applied(ownership, [...rest, row(111, 1, 111)], true)), [100, 101, 102, 111]);
  assert.deepEqual(pids(applied(ownership, [...rest, row(110, 200, 200, { start: 'someone-else' }), row(111, 1, 111)], true)), [100, 101, 102, 111]);
  // An unreadable stranger at that pid right after the ps is not assumed to be a stranger.
  const reused = newOwnership();
  applied(reused, withPs(psRow(110, 103, 103)), true);
  applied(reused, [...rest, endedPs, row(111, 110, 111)], true);
  assert.deepEqual(pids(applied(reused, [...rest, unreadableRow(110, 200, 200), row(111, 1, 111)], true)), [100, 101, 102, 110, 111]);
  assert.deepEqual(reused.readFailure(), unreadable(110));
});

test('the system ps is let through only on this scan\'s own evidence that it belongs to the run', () => {
  // Scan 1: started by the detached process, in that process's group. Let through.
  const ownership = newOwnership();
  assert.equal(applied(ownership, withPs(psRow(110, 103, 103)), true).get(110).assumed, true);
  // Scan 2: its parent is gone. It belongs to pid 1 now and is outside the
  // runner's group. All that ties it to the run is that pid 110 was in the run
  // a moment ago, and that is not enough: it stays in the run, unread.
  const orphaned = [...system, ...stranger, row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER), row(102, 101, RUNNER), psRow(110, 1, 103)];
  assert.deepEqual(pids(applied(ownership, orphaned, true)), [100, 101, 102, 110]);
  assert.deepEqual(ownership.readFailure(), unreadable(110, 2));

  // Left behind inside the runner's group, in a scan that shows the runner: the group is evidence.
  const inGroup = newOwnership();
  applied(inGroup, withPs(psRow(110, 102, RUNNER)), true);
  const stillGrouped = [...system, row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER), psRow(110, 1, RUNNER)];
  assert.equal(applied(inGroup, stillGrouped, true).get(110).assumed, true);
  assert.equal(inGroup.readFailure(), null);
  // The same once the runner has been collected: the group shows nothing any more.
  assert.deepEqual(pids(applied(inGroup, [...system, psRow(110, 1, RUNNER)], false)), [110]);
  assert.deepEqual(inGroup.readFailure(), unreadable(110, 3));

  // A pid the run held, now held by an unrelated ps of the same user.
  const reused = newOwnership();
  applied(reused, withPs(), true);
  const sameUsersPs = psRow(103, 1, 103);
  assert.deepEqual(pids(applied(reused, [...system, row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER), row(104, 1, 104), sameUsersPs], true)), [100, 101, 103, 104]);
  assert.deepEqual(reused.readFailure(), unreadable(103), 'in consecutive scans the guard cannot tell, and does not assume');
  // After a scan without that pid, it is simply somebody else's process.
  const later = newOwnership();
  applied(later, withPs(), true);
  applied(later, [...system, row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER)], true);
  assert.deepEqual(pids(applied(later, [...system, row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER), sameUsersPs, psRow(301, 200, 200)], true)), [100, 101]);
  assert.equal(later.readFailure(), null);
  assert.deepEqual(later.toolStats.samples, 0);

  // A process the run started that then became the system ps, as every ps does between being started and running.
  const becomes = newOwnership();
  applied(becomes, withPs(row(110, 101, RUNNER)), true);
  assert.equal(applied(becomes, withPs(psRow(110, 101, RUNNER)), true).get(110).assumed, true);
  assert.equal(becomes.readFailure(), null);
  // And one that was the system ps and now reports another executable.
  applied(becomes, withPs(psRow(110, 101, RUNNER, { path: '/usr/bin/top' })), true);
  assert.deepEqual(becomes.readFailure(), unreadable(110, 2));
});

test('the system ps is let through for a bounded time, a bounded number of samples, and a bounded number at once', () => {
  // Samples: 40 in a row, not 41, however quickly they come.
  const clock = { now: 0 };
  const bySamples = newOwnership(clock);
  for (let sample = 1; sample <= SYSTEM_TOOL.samples; sample += 1) {
    clock.now += 1;
    assert.equal(applied(bySamples, withPs(psRow(110, 101, RUNNER)), true).get(110).assumed, true, `sample ${sample}`);
    assert.equal(bySamples.readFailure(), null, `sample ${sample}`);
  }
  clock.now += 1;
  assert.notEqual(applied(bySamples, withPs(psRow(110, 101, RUNNER)), true).get(110).assumed, true);
  assert.deepEqual(bySamples.readFailure(), unreadable(110, SYSTEM_TOOL.samples + 1));
  assert.deepEqual(bySamples.toolStats, { samples: SYSTEM_TOOL.samples, longestSamples: SYSTEM_TOOL.samples, longestMilliseconds: SYSTEM_TOOL.samples - 1 });

  // Time: two seconds from the first sample that saw it, however few samples that is.
  const slow = { now: 5000 };
  const byTime = newOwnership(slow);
  for (const at of [5000, 5900, 6800, 7000]) {
    slow.now = at;
    applied(byTime, withPs(psRow(110, 101, RUNNER)), true);
    assert.equal(byTime.readFailure(), null, `at ${at} ms`);
  }
  slow.now = 7001;
  applied(byTime, withPs(psRow(110, 101, RUNNER)), true);
  assert.deepEqual(byTime.readFailure(), unreadable(110, 5));
  // Scans that fail produce no sample, and give no extra time: the clock is not theirs to stop.
  const blind = { now: 0 };
  const acrossFailures = newOwnership(blind);
  applied(acrossFailures, withPs(psRow(110, 101, RUNNER)), true);
  blind.now = SYSTEM_TOOL.milliseconds + 500; // several scans failed in between
  applied(acrossFailures, withPs(psRow(110, 101, RUNNER)), true);
  assert.deepEqual(acrossFailures.readFailure(), unreadable(110, 2));
  // Each ps has its own allowance; a new one does not inherit the old one's.
  const fresh = { now: 0 };
  const oneAfterAnother = newOwnership(fresh);
  for (let pid = 300; pid < 300 + 3 * SYSTEM_TOOL.samples; pid += 1) {
    fresh.now += 60;
    applied(oneAfterAnother, withPs(psRow(pid, 101, RUNNER)), true);
    assert.equal(oneAfterAnother.readFailure(), null);
  }
  assert.deepEqual(oneAfterAnother.toolStats, { samples: 3 * SYSTEM_TOOL.samples, longestSamples: 1, longestMilliseconds: 0 });

  // At once: eight, not nine.
  const several = count => Array.from({ length: count }, (_, index) => psRow(400 + index, 101, RUNNER));
  const eight = newOwnership();
  const ownedEight = applied(eight, withPs(...several(SYSTEM_TOOL.atOnce)), true);
  assert.equal(eight.readFailure(), null);
  assert.equal(measureRun(ownedEight).total, 5 * 10 + SYSTEM_TOOL.atOnce * SYSTEM_TOOL.assumedMegabytes);
  const nine = newOwnership();
  applied(nine, withPs(...several(SYSTEM_TOOL.atOnce + 1)), true);
  assert.deepEqual(nine.readFailure(), unreadable(400 + SYSTEM_TOOL.atOnce));
});

test('what the system ps started is judged on its own, like any other process of the run', () => {
  const heavy = newOwnership();
  const owned = applied(heavy, withPs(psRow(110, 101, RUNNER), row(111, 110, RUNNER, { megabytes: 5000 })), true);
  assert.equal(heavy.readFailure(), null);
  assert.deepEqual([measureRun(owned).largest.pid, measureRun(owned).largest.megabytes], [111, 5000]);
  const unread = newOwnership();
  applied(unread, withPs(psRow(110, 101, RUNNER), unreadableRow(111, 110, RUNNER)), true);
  assert.deepEqual(unread.readFailure(), unreadable(111));
  const another = newOwnership();
  applied(another, withPs(psRow(110, 101, RUNNER), psRow(111, 110, RUNNER, { path: '/usr/bin/top' })), true);
  assert.deepEqual(another.readFailure(), unreadable(111));
});

test('a system ps is never signalled by pid, and one that outlives a stop keeps cleanup from being confirmed', async () => {
  // The runner still exists and the ps is in its group: the group signal takes it, as it takes everything there.
  const grouped = simulate([...system, ...stranger, ...run, psRow(110, 102, RUNNER)]);
  assert.deepEqual(await guardFor(grouped).guard.stopRun(), clean);
  assert.deepEqual(grouped.attempts.filter(([target]) => target === 110), []);
  assert.equal(grouped.table.has(110), false);

  // Outside the runner's group: the stop cannot reach it, does not try by pid, and says so.
  const outside = simulate([...system, ...run, psRow(110, 104, 103)]);
  const left = await guardFor(outside).guard.stopRun();
  assert.deepEqual(outside.attempts.filter(([target]) => target === 110), []);
  assert.deepEqual(left.survivors, []);
  assert.deepEqual(left.unverified.map(item => item.pid), [110]);
  assert.equal(outside.table.has(110), true);

  // The runner has been collected and a ps the run started is still there, in the old group or not.
  for (const pgid of [RUNNER, 103]) {
    const after = simulate([...system, psRow(110, 1, pgid)], { collected: true });
    for (const act of [guard => guard.stopRun(), guard => guard.endRun('SIGTERM', 1000)]) {
      const outcome = await act(guardFor(after, { seed: withPs(psRow(110, 101, pgid)) }).guard);
      assert.deepEqual(outcome.unverified.map(item => item.pid), [110]);
      assert.deepEqual(after.attempts, []);
    }
    // One that has ended is nothing to wait for and nothing to signal.
    const ended = simulate([...system, psRow(110, 1, pgid, { status: ZOMBIE, path: null })], { collected: true });
    for (const act of [guard => guard.stopRun(), guard => guard.endRun('SIGTERM', 1000)]) {
      const { guard } = guardFor(ended, { seed: withPs(psRow(110, 101, pgid)) });
      assert.deepEqual(await act(guard), clean);
      assert.deepEqual(guard.alive(), []);
      assert.deepEqual(ended.attempts, []);
    }
  }
});

test('stopping a run freezes every process first, finds what was started meanwhile, and only then kills', async () => {
  const machine = simulate([...system, ...stranger, ...run]);
  // Right after the first scan the detached process starts one more child.
  machine.after(1, () => machine.table.set(105, row(105, 103, 103)));
  const { guard } = guardFor(machine);
  assert.deepEqual(await guard.stopRun(), clean);
  const firstKill = machine.delivered.findIndex(([, name]) => name === 'SIGKILL');
  const frozenBeforeKill = machine.delivered.slice(0, firstKill).filter(([, name]) => name === 'SIGSTOP').map(([target]) => target);
  // The group in one call, each process outside it by pid.
  for (const target of [-RUNNER, 103, 104, 105]) assert.ok(frozenBeforeKill.includes(target), `froze ${target} before killing anything`);
  assert.deepEqual(machine.delivered.slice(0, firstKill).filter(([, name]) => name !== 'SIGSTOP'), []);
  for (const pid of [100, 101, 102, 103, 104, 105]) assert.equal(machine.table.has(pid), false, `process ${pid} is gone`);
  // Nobody else was signalled, or even tried, by pid or through a group.
  assert.deepEqual([...new Set(machine.attempts.map(([target]) => target))].sort((a, b) => a - b), [-100, 103, 104, 105]);
  for (const pid of [1, GUARD, SAMPLER, 12, 200, 201]) assert.equal(machine.table.get(pid).frozen, undefined);
});

for (const scanNumber of [1, 2, 3]) {
  test(`a pid that changes hands after scan ${scanNumber} of a stop is not signalled: the start time is checked when the signal is sent`, async () => {
    const machine = simulate([...system, ...run]);
    machine.after(scanNumber, () => machine.replace(103, row(103, 1, 103, { start: 'someone-else' })));
    const { guard, anomalies } = guardFor(machine);
    assert.deepEqual(await guard.stopRun(), clean);
    // Whatever was delivered to pid 103 was delivered while it was still the run's.
    const untilReplaced = scanNumber === 1 ? [] : ['SIGSTOP'];
    assert.deepEqual(machine.deliveredTo(103), untilReplaced);
    assert.equal(machine.table.get(103).start, 'someone-else');
    assert.notEqual(machine.table.get(103).frozen, true);
    assert.deepEqual(anomalies, []);
    // The run's own processes, including the one the old 103 had started, are gone.
    for (const pid of [100, 101, 102, 104]) assert.equal(machine.table.has(pid), false);
  });
}

test('a pid the run used earlier is not signalled once another process holds it, in a stop or after a signal', async () => {
  for (const act of [guard => guard.stopRun(), guard => guard.endRun('SIGTERM', 5000)]) {
    const machine = simulate([...system, ...run]);
    const { guard } = guardFor(machine);
    await guard.observe();
    machine.replace(102, row(102, 1, 102, { start: 'someone-else' }));
    machine.replace(103, row(103, 200, 200, { start: 'someone-else' }));
    assert.deepEqual(await act(guard), clean);
    assert.deepEqual(machine.attempts.filter(([target]) => target === 102 || target === 103), []);
    assert.equal(machine.table.get(102).frozen, undefined);
    assert.equal(machine.table.has(104), false, 'the process the old 103 had started is still the run\'s');
  }
  // Changing hands between the guard's scan and its signal: tried, refused.
  const machine = simulate([...system, ...run]);
  machine.after(1, () => machine.replace(103, row(103, 1, 103, { start: 'someone-else' })));
  assert.deepEqual(await guardFor(machine).guard.endRun('SIGTERM', 5000), clean);
  assert.deepEqual(machine.attempts.filter(([target]) => target === 103), [[103, 'SIGTERM']]);
  assert.deepEqual(machine.deliveredTo(103), []);
});

test('if a pid changes hands in the instant between the check and the signal, the process frozen by mistake is resumed and left alone', async () => {
  const machine = simulate([...system, ...run]);
  machine.raceOnNextSignalTo(103, row(103, 1, 103, { start: 'someone-else' }));
  const { guard, anomalies } = guardFor(machine);
  assert.deepEqual(await guard.stopRun(), clean);
  assert.deepEqual(machine.deliveredTo(103), ['SIGSTOP', 'SIGCONT']);
  assert.equal(machine.table.get(103).start, 'someone-else');
  assert.equal(machine.table.get(103).frozen, false);
  assert.deepEqual(anomalies, ['process 103 is no longer the process the run started; it was resumed (sent) and left alone']);
  for (const pid of [100, 101, 102, 104]) assert.equal(machine.table.has(pid), false);
});

test('a run whose runner cannot be read is stopped through the runner\'s own process group', async () => {
  const machine = simulate([...system, ...stranger, unreadableRow(RUNNER, GUARD, RUNNER), ...run.slice(1)]);
  const { guard, ownership } = guardFor(machine);
  await guard.observe();
  assert.equal(ownership.readFailure().problem, 'unreadable');
  assert.deepEqual(await guard.stopRun(), clean);
  // Frozen (once per freezing round) and then killed by the number of the group
  // the guard still held; the detached processes, identified, one by one.
  assert.match(machine.held.join(' '), /^(SIGSTOP )+SIGKILL$/);
  assert.deepEqual([...new Set(machine.attempts.map(([target]) => target))].sort((a, b) => a - b), [-100, 103, 104]);
  for (const pid of [100, 101, 102, 103, 104]) assert.equal(machine.table.has(pid), false, `process ${pid} is gone`);
  for (const pid of [1, GUARD, SAMPLER, STANDBY, 12, 200, 201]) assert.equal(machine.table.get(pid).frozen, undefined);

  // The same when the runner is the only process and nothing else can vouch for the group.
  const alone = simulate([...system, unreadableRow(RUNNER, GUARD, RUNNER)]);
  assert.deepEqual(await guardFor(alone).guard.endRun('SIGTERM', 5000), clean);
  assert.deepEqual(alone.held, ['SIGTERM']);
  assert.equal(alone.table.has(RUNNER), false);

  // A runner shown outside its own group: its group is not signalled by number.
  const elsewhere = simulate([...system, row(RUNNER, GUARD, 555)]);
  await guardFor(elsewhere).guard.stopRun();
  assert.deepEqual(elsewhere.held, []);
});

test('the process group is signalled only while the runner exists, or an identified process of the run vouches for it', async () => {
  // The runner has been collected: group 100 may be anybody's by now. The
  // simulated machine itself refuses a group signal by number at this point.
  const leftover = simulate([...system, row(102, 1, RUNNER), row(103, 1, 103), row(400, 1, RUNNER, { start: 'someone-else' })], { collected: true });
  const first = guardFor(leftover, { seed: [...system, ...run] });
  assert.deepEqual(await first.guard.stopRun(), clean);
  assert.deepEqual(leftover.attempts.filter(([target]) => target < 0), []);
  assert.deepEqual(leftover.attempts.filter(([target]) => target === 400), []);
  assert.equal(leftover.table.has(400), true);
  assert.equal(leftover.table.has(102), false);
  assert.equal(leftover.table.has(103), false);

  // The runner ends, is collected, and its pid passes to another process
  // before the guard's next signal: nothing is sent, by any route.
  const swapped = simulate([...system, row(RUNNER, GUARD, RUNNER)]);
  swapped.after(1, () => swapped.replace(RUNNER, row(RUNNER, 1, RUNNER, { start: 'someone-else' })));
  await guardFor(swapped).guard.stopRun();
  assert.deepEqual(swapped.delivered, []);
  assert.deepEqual(swapped.held, []);
  assert.equal(swapped.table.get(RUNNER).start, 'someone-else');

  // While the runner exists, the sampler's checked signal is used, not the number alone.
  const normal = simulate([...system, ...run]);
  assert.deepEqual(await guardFor(normal).guard.stopRun(), clean);
  assert.deepEqual(normal.held, []);
});

test('a process that cannot be identified by start time is not signalled by pid, and cleanup reports it', async () => {
  const machine = simulate([...system, row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER), unreadableRow(103, 101, 103)]);
  const { guard } = guardFor(machine);
  const result = await guard.stopRun();
  assert.deepEqual(machine.attempts.filter(([target]) => target === 103), []);
  assert.deepEqual(result.survivors, []);
  // Killing its parent unlinked it from the run; it is reported all the same.
  assert.deepEqual(result.unverified.map(item => item.pid), [103]);
  assert.equal(machine.table.has(103), true);

  // One that was the run's and turned unreadable is reported too, after a stop and after a signal.
  for (const act of [item => item.stopRun(), item => item.endRun('SIGTERM', 1000)]) {
    const turned = simulate([...system, row(103, 1, 103, { start: '0', megabytes: 0, usageError: EPERM })], { collected: true });
    const outcome = await act(guardFor(turned, { seed: [...system, ...run] }).guard);
    assert.deepEqual(outcome.survivors, []);
    assert.deepEqual(outcome.unverified.map(item => item.pid), [103]);
    assert.deepEqual(turned.attempts, []);
  }
});

test('cleanup is bounded: a process that survives SIGKILL is reported after the confirmation window', async () => {
  const machine = simulate([...system, row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER, { unkillable: true })]);
  const { guard } = guardFor(machine);
  const result = await guard.stopRun();
  assert.deepEqual(result.survivors.map(item => item.pid), [101]);
  assert.deepEqual(result.unverified, []);
  assert.ok(machine.now() >= TIMING.confirmMs && machine.now() < TIMING.confirmMs + 1000, `gave up after ${machine.now()} ms`);
  assert.ok(machine.scans < 1000);
  // A process that has ended but not been collected yet does not count as surviving.
  const zombie = simulate([...system, row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER, { status: ZOMBIE })]);
  assert.deepEqual(await guardFor(zombie).guard.stopRun(), clean);
});

test('after a signal the run may end by itself; what does not is frozen and killed, at once when asked twice', async () => {
  const polite = simulate([...system, ...run]);
  assert.deepEqual(await guardFor(polite).guard.endRun('SIGTERM', 5000), clean);
  assert.deepEqual([...new Set(polite.delivered.map(([, name]) => name))], ['SIGTERM']);
  // The group gets one signal; the detached processes, outside it, one each.
  assert.deepEqual(polite.attempts.map(([target]) => target).sort((a, b) => a - b), [-100, 103, 104]);

  const withStubborn = () => simulate([...system, ...run.map(item => (item.pid === 103 ? { ...item, ignoresTerm: true } : item))]);
  const stubborn = withStubborn();
  assert.deepEqual(await guardFor(stubborn).guard.endRun('SIGTERM', 5000), clean);
  assert.ok(stubborn.now() >= 5000, 'waited for the whole grace period');
  assert.deepEqual(stubborn.deliveredTo(103), ['SIGTERM', 'SIGSTOP', 'SIGKILL']);

  const urgent = withStubborn();
  assert.deepEqual(await guardFor(urgent).guard.endRun('SIGINT', 5000, () => true), clean);
  assert.ok(urgent.now() < 1000, 'did not wait');
  assert.equal(urgent.table.has(103), false);
});

test('a failing scan stops a cleanup instead of letting it act on stale knowledge', async () => {
  const machine = simulate([...system, ...run]);
  let calls = 0;
  const broken = createGuard({
    ownership: newOwnership(),
    runnerPid: RUNNER,
    scan: async () => { calls += 1; if (calls > 1) throw new Error('sampler did not answer within 1000 ms'); return machine.scan(); },
    signalProcesses: machine.signalProcesses,
    signalGroup: machine.signalGroup,
    signalGroupWhileHeld: machine.signalGroupWhileHeld,
    sleep: machine.sleep,
    now: machine.now,
    isRunnerGone: () => machine.collected,
  });
  await assert.rejects(() => broken.stopRun(), /sampler did not answer/);
  assert.deepEqual(machine.delivered.filter(([, name]) => name === 'SIGKILL'), []);
});

test('sampler rows are read strictly', () => {
  assert.deepEqual(parseRow('4242 100 100 501 2 98765432109876543210 1048576 3145728 0 0 501 0 -'), {
    pid: 4242, ppid: 100, pgid: 100, uid: 501, ruid: 501, status: 2, start: '98765432109876543210', megabytes: 3, resident: 1, footprint: 3,
    infoError: 0, usageError: 0, exiting: false, path: null,
  });
  assert.equal(parseRow('4242 100 100 501 2 5 9437184 1048576 0 0 501 0 -').megabytes, 9);
  assert.deepEqual(parseRow('4242 0 0 0 0 0 0 0 3 1 0 0 -'), {
    pid: 4242, ppid: 0, pgid: 0, uid: 0, ruid: 0, status: 0, start: '0', megabytes: 0, resident: 0, footprint: 0, infoError: 3, usageError: 1, exiting: false, path: null,
  });
  // An exiting process: its usage answers with an exit time while libproc no longer describes it.
  assert.deepEqual(parseRow('4242 0 0 0 0 5 9437184 0 3 0 0 1 -'), {
    pid: 4242, ppid: 0, pgid: 0, uid: 0, ruid: 0, status: 0, start: '5', megabytes: 9, resident: 9, footprint: 0, infoError: 3, usageError: 0, exiting: true, path: null,
  });
  // The executable path arrives percent-encoded and is decoded exactly.
  assert.equal(parseRow('4242 100 100 0 2 0 0 0 0 1 501 0 /bin/ps').path, '/bin/ps');
  assert.equal(parseRow('4242 100 100 0 2 0 0 0 0 1 501 0 /Users/someone/My%20Tools/ps').path, '/Users/someone/My Tools/ps');
  assert.equal(parseRow('4242 100 100 0 2 0 0 0 0 1 501 0 /bin/ps%0A').path, '/bin/ps\n');
  for (const bad of ['', '4242 100 100 501 2 5 1 2 0 0 501 0 ', '4242 100 100 501 2 5 1 2 0 0 501 0', '4242 100 100 501 2 5 1 2 0 0 501', '4242 100 100 501 2 5 1 2 0 0 501 0 - -',
    'pid 100 100 501 2 5 1 2 0 0 501 0 -', '-1 100 100 501 2 5 1 2 0 0 501 0 -', '4242  100 100 501 2 5 1 2 0 0 501 0 -', '4242 100 100 501 2 5 1 2 0 0 501 0 -\r',
    '4242 100 100 0 2 0 0 0 0 1 501 0 /bin/ps extra', '4242 100 100 0 2 0 0 0 0 1 501 0 /bin/%E0%A4%A', '4242 100 100 0 2 0 0 0 0 1 501 0 /bin/p"s',
    // The row of the sampler before the exiting field, and an exiting field that is not 0 or 1.
    '4242 100 100 501 2 5 1 2 0 0 501 -', '4242 100 100 501 2 5 1 2 0 0 501 2 -', '4242 100 100 501 2 5 1 2 0 0 501 10 -']) {
    assert.equal(parseRow(bad), null, JSON.stringify(bad));
  }
});

test('arguments go to node --test, with the serial whole suite as the default', () => {
  const everyTestFile = fs.readdirSync(__dirname).filter(name => name.endsWith('.test.js')).sort()
    .map(name => path.relative(process.cwd(), path.join(__dirname, name)));
  assert.ok(everyTestFile.length > 90);
  const defaults = { process: DEFAULT_PROCESS_LIMIT_MB, total: DEFAULT_TOTAL_LIMIT_MB, deadlineSeconds: DEFAULT_DEADLINE_SECONDS };

  const whole = parseArguments([], {});
  assert.deepEqual(whole.nodeArguments, ['--test', '--test-concurrency=1', ...everyTestFile]);
  assert.deepEqual(whole.limits, defaults);

  assert.deepEqual(parseArguments(['--test-name-pattern=focus', 'tests/renderer-figma-scope.test.js'], {}).nodeArguments,
    ['--test', '--test-concurrency=1', '--test-name-pattern=focus', 'tests/renderer-figma-scope.test.js']);
  assert.deepEqual(parseArguments(['--test-name-pattern', 'focus'], {}).nodeArguments,
    ['--test', '--test-concurrency=1', '--test-name-pattern', 'focus', ...everyTestFile]);
  assert.deepEqual(parseArguments(['tests/not-there.test.js'], {}).nodeArguments,
    ['--test', '--test-concurrency=1', 'tests/not-there.test.js']);
  assert.deepEqual(parseArguments(['--test-concurrency=2', 'tests/figma-*.test.js'], {}).nodeArguments,
    ['--test', '--test-concurrency=2', 'tests/figma-*.test.js']);

  const environment = { CRATE_TEST_MEMORY_LIMIT_MB: '4096', CRATE_TEST_TOTAL_MEMORY_LIMIT_MB: '9000', CRATE_TEST_DEADLINE_SECONDS: '600' };
  const limited = parseArguments(['--memory-limit-mb=512', '--total-memory-limit-mb=1024', '--deadline-seconds=90', 'tests/file-uri.test.js'], environment);
  assert.deepEqual(limited.limits, { process: 512, total: 1024, deadlineSeconds: 90 });
  assert.deepEqual(limited.nodeArguments, ['--test', '--test-concurrency=1', 'tests/file-uri.test.js']);
  assert.deepEqual(parseArguments(['tests/file-uri.test.js'], environment).limits, { process: 4096, total: 9000, deadlineSeconds: 600 });
  assert.throws(() => parseArguments(['--deadline-seconds=soon'], {}), UsageError);
});

// ---------------------------------------------------------------------------
// The guard on real processes. Every fixture is finite by itself: allocators
// stop at 256 MB and let go, and every helper process exits within 20 seconds
// whether or not the guard works.

function startGuard(args, extraEnvironment = {}, command = runTests) {
  // A nested `node --test` must not inherit this test process's reporter channel.
  const environment = { ...process.env };
  for (const name of ['NODE_TEST_CONTEXT', 'CRATE_TEST_MEMORY_LIMIT_MB', 'CRATE_TEST_TOTAL_MEMORY_LIMIT_MB', 'CRATE_TEST_DEADLINE_SECONDS']) {
    delete environment[name];
  }
  Object.assign(environment, extraEnvironment);
  const started = Date.now();
  const child = spawn(process.execPath, [command, '--test-reporter=tap', ...args],
    { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const done = new Promise(resolve => {
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr, seconds: (Date.now() - started) / 1000 }));
  });
  // `child.kill` signals only while this process still holds the child.
  return { pid: child.pid, done, signal: name => child.kill(name) };
}

function commandOf(pid) {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

// A pid says nothing about which process holds it. These tests recognize their
// own processes by a marker in the command line that nothing else carries, and
// look at it again right before every signal they send.
const isOurs = (pid, marker) => Number.isInteger(pid) && pid > 1 && commandOf(pid).includes(marker);
function signalOurs(pid, marker, name) {
  if (!isOurs(pid, marker)) return false;
  try { process.kill(pid, name); return true; } catch { return false; }
}

async function waitFor(condition, milliseconds, what) {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    const value = condition();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${typeof what === 'function' ? what() : what}`);
    await new Promise(resolve => { setTimeout(resolve, 25); });
  }
}

// Everything one scenario needs, and its unconditional cleanup: a process that
// has nothing to do with the guarded run and must come through untouched, and a
// file in which the fixture's process tree records its pids. The file's path is
// unique to the scenario and is in the command line of every process of the tree.
function scenario(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-guard-'));
  const pidFile = path.join(directory, 'pids');
  fs.writeFileSync(pidFile, '');
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
  let bystanderExited = false;
  bystander.on('exit', () => { bystanderExited = true; });
  const recorded = () => new Map(fs.readFileSync(pidFile, 'utf8').split('\n').filter(Boolean)
    .map(line => line.split(' ')).map(([role, pid]) => [role, Number(pid)]));
  // The test file's own process carries no scenario marker; it is recognized
  // by the fixture's path and is never signalled from here.
  const stillThere = (role, pid) => isOurs(pid, role === 'ready' ? descendants : pidFile);
  t.after(() => {
    bystander.kill('SIGKILL');
    for (const [role, pid] of recorded()) if (role !== 'ready') signalOurs(pid, pidFile, 'SIGKILL');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    pidFile,
    environment: (mode, stubborn = false) => ({
      CRATE_GUARD_FIXTURE_PIDS: pidFile, CRATE_GUARD_FIXTURE_MODE: mode, CRATE_GUARD_FIXTURE_STUBBORN: stubborn ? '1' : '',
    }),
    recorded,
    stillThere: role => stillThere(role, recorded().get(role)),
    ready: () => waitFor(() => recorded().has('ready') && recorded(), 15000, 'the fixture\'s process tree'),
    bystanderSurvived: () => !bystanderExited && commandOf(bystander.pid).includes('setTimeout(() => {}, 60000)'),
    // Gone, allowing a moment for the system to collect a process that has ended.
    async allGone(roles) {
      const tree = recorded();
      const remaining = () => roles.filter(role => stillThere(role, tree.get(role)));
      await waitFor(() => remaining().length === 0, 3000, () => `these to disappear: ${remaining().join(', ')}`);
    },
  };
}

const treeRoles = ['nested', 'nested-child', 'detached', 'detached-child', 'short-lived', 'adopted'];

// The guard's samplers: the one in use and the one standing by.
function samplersOf(guardPid) {
  const children = execFileSync('pgrep', ['-P', String(guardPid)], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number);
  return children.filter(pid => isOurs(pid, 'run-tests-sampler.py'));
}

test('an ordinary run reports its results and exit status unchanged', { timeout: 60000 }, async t => {
  const { bystanderSurvived } = scenario(t);
  const passing = await startGuard([outcomes]).done;
  assert.equal(passing.code, 0, passing.stderr);
  assert.match(passing.stdout, /^ok 1 - passes$/m);
  assert.match(passing.stdout, /^# pass 1$/m);
  assert.match(passing.stdout, /^# fail 0$/m);
  assert.match(passing.stderr, /^run-tests: memory guard: \d+ samples, peak \d+ MB in one process and \d+ MB in total \(limits [\d.]+ GB, [\d.]+ GB, \d+ s\)$/m);
  assert.doesNotMatch(passing.stderr, /EXCEEDED|DEADLINE|LOST SIGHT|CANNOT READ|INCOMPLETE|left \d+ of its processes/);

  const failing = await startGuard([outcomes], { CRATE_GUARD_FIXTURE_FAIL: '1' }).done;
  assert.equal(failing.code, 1, failing.stderr);
  assert.match(failing.stdout, /^ok 1 - passes$/m);
  assert.match(failing.stdout, /^not ok 2 - fails$/m);
  assert.doesNotMatch(failing.stderr, /EXCEEDED|DEADLINE|LOST SIGHT|CANNOT READ|INCOMPLETE/);

  const filtered = await startGuard(['--test-name-pattern=passes', outcomes], { CRATE_GUARD_FIXTURE_FAIL: '1' }).done;
  assert.equal(filtered.code, 0, filtered.stderr);
  assert.match(filtered.stdout, /^# pass 1$/m);
  assert.equal(bystanderSurvived(), true);
});

test('a size that passed a limit is never reported as the limit itself', () => {
  // The guard stops a run for anything above the limit, 128.01 MB as much as
  // 140. Rounded to the nearest megabyte the first read "reached 128 MB (limit
  // 128 MB)", and the test below, which insists on a figure above the limit,
  // failed now and then.
  assert.deepEqual([128.01, 128.3, 128.5, 129, 139.2, 2048.4].map(formatOver), ['129 MB', '129 MB', '129 MB', '129 MB', '140 MB', '2049 MB']);
  for (const [megabytes, limit] of [[128.0001, 128], [200.2, 200], [2048.01, 2048], [4096.9, 4096]]) {
    assert.ok(Number.parseInt(formatOver(megabytes), 10) > limit, `${megabytes} over ${limit}`);
  }
});

test('a time past the deadline is never reported as the deadline itself', () => {
  // A run stopped 1 ms past 6 s does not read "after 6.0 s (limit 6 s)".
  assert.deepEqual([6001, 6040, 6099, 6100, 6101, 2400001].map(formatSecondsOver), ['6.1', '6.1', '6.1', '6.1', '6.2', '2400.1']);
  for (const [milliseconds, limit] of [[6001, 6], [6049, 6], [3400001, 3400]]) {
    assert.ok(Number(formatSecondsOver(milliseconds)) > limit, `${milliseconds} ms over ${limit} s`);
  }
});

test('a process that passes the per-process limit is stopped, named, and the run confirmed gone', { timeout: 60000 }, async t => {
  const { bystanderSurvived } = scenario(t);
  const result = await startGuard(['--memory-limit-mb=128', growing]).done;
  assert.equal(result.code, EXIT_MEMORY_LIMIT, result.stderr);
  assert.match(result.stderr, /run-tests: MEMORY LIMIT EXCEEDED after [\d.]+ s: process \d+ reached \d+ MB \(limit 128 MB per process\)\./);
  assert.match(result.stderr, /run-tests: {3}\S.*growing\.fixture\.js/);
  assert.match(result.stderr, /run-tests: Stopping the test run \(\d+ processes\)\./);
  assert.match(result.stderr, /run-tests: Every process of the run has ended\./);
  // The fixture lets go at 256 MB by itself and would then pass: it never got there.
  assert.doesNotMatch(result.stdout, /^ok 1 /m);
  const reached = Number(/reached (\d+) MB/.exec(result.stderr)[1]);
  assert.ok(reached > 128 && reached < 256, `stopped at ${reached} MB`);
  assert.ok(result.seconds < 10, `took ${result.seconds} s`);
  assert.equal(bystanderSurvived(), true);
});

test('a run that passes the total limit is stopped even when no single process is over', { timeout: 60000 }, async t => {
  const { bystanderSurvived } = scenario(t);
  const result = await startGuard(['--memory-limit-mb=1024', '--total-memory-limit-mb=200', growing]).done;
  assert.equal(result.code, EXIT_MEMORY_LIMIT, result.stderr);
  assert.match(result.stderr, /run-tests: MEMORY LIMIT EXCEEDED after [\d.]+ s: the run reached \d+ MB across \d+ processes \(limit 200 MB in total\)\./);
  assert.match(result.stderr, /run-tests: Every process of the run has ended\./);
  assert.doesNotMatch(result.stdout, /^ok 1 /m);
  assert.equal(bystanderSurvived(), true);

  const fromEnvironment = await startGuard([growing], { CRATE_TEST_MEMORY_LIMIT_MB: '128' }).done;
  assert.equal(fromEnvironment.code, EXIT_MEMORY_LIMIT, fromEnvironment.stderr);
  assert.match(fromEnvironment.stderr, /limit 128 MB per process/);
});

test('a memory stop takes the whole run with it: nested, detached and adopted processes', { timeout: 60000 }, async t => {
  const { environment, ready, stillThere, allGone, bystanderSurvived } = scenario(t);
  const run = startGuard(['--memory-limit-mb=128', descendants], environment('allocate'));
  await ready();
  for (const role of treeRoles.filter(name => name !== 'short-lived')) assert.equal(stillThere(role), true, `${role} is running`);
  const result = await run.done;
  assert.equal(result.code, EXIT_MEMORY_LIMIT, result.stderr);
  assert.match(result.stderr, /MEMORY LIMIT EXCEEDED/);
  assert.match(result.stderr, /run-tests: Every process of the run has ended\./);
  await allGone([...treeRoles, 'ready']);
  assert.equal(bystanderSurvived(), true);
});

test('what a finished run leaves running is ended, without changing the run\'s result', { timeout: 60000 }, async t => {
  const { environment, recorded, allGone, bystanderSurvived } = scenario(t);
  const result = await startGuard([descendants], environment('leave', true)).done;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^# pass 1$/m);
  assert.match(result.stderr, /run-tests: The test run ended and left \d+ of its processes running; ending them\./);
  assert.match(result.stderr, /run-tests: Every process of the run has ended\./);
  assert.ok(recorded().has('stubborn'), 'the tree included a process that ignores SIGTERM');
  await allGone([...treeRoles, 'stubborn', 'ready']);
  assert.equal(bystanderSurvived(), true);
});

test('a passing run whose leftover cannot be ended is a guard failure, not a pass', { timeout: 60000 }, async t => {
  const { environment, stillThere, allGone, bystanderSurvived } = scenario(t);
  const result = await startGuard([descendants], { ...environment('leave'), CRATE_GUARD_FAULT: 'undeliverable:detached' }, faultyGuard).done;
  assert.match(result.stdout, /^# pass 1$/m);
  assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
  assert.match(result.stderr, /run-tests: CLEANUP INCOMPLETE: 1 processes of the run were still there [\d.]+ s after SIGKILL: \d+\./);
  assert.match(result.stderr, /run-tests: Exit status 125 replaces 0\./);
  assert.match(result.stderr, /run-tests: Not every process of the run is confirmed to have ended\./);
  assert.doesNotMatch(result.stderr, /Every process of the run has ended/);
  // Exactly the one process the guard could not reach is left; this test ends it.
  assert.equal(stillThere('detached'), true);
  await allGone(treeRoles.filter(role => role !== 'detached'));
  assert.equal(bystanderSurvived(), true);
});

test('a passing run that leaves a process the guard cannot identify is a guard failure, not a pass', { timeout: 60000 }, async t => {
  const { environment, stillThere, allGone, bystanderSurvived } = scenario(t);
  const result = await startGuard([descendants], { ...environment('leave'), CRATE_GUARD_FAULT: 'unreadable-after-run:detached' }, faultyGuard).done;
  assert.match(result.stdout, /^# pass 1$/m);
  assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
  // The first scan after the run's end already cannot read it, and says so; the run's own status does not stand.
  assert.match(result.stderr, /run-tests: GUARD CANNOT READ PROCESS \d+ OF THE RUN after [\d.]+ s \(errno 1, 1 samples in a row\)\. Its memory is unknown\./);
  assert.match(result.stderr, /run-tests: The test run had ended by then, with exit status 0\. Exit status 125 replaces it\./);
  assert.match(result.stderr, /run-tests: CLEANUP INCOMPLETE: 1 processes of the run could not be identified by start time and were left alone: \d+\./);
  assert.match(result.stderr, /run-tests: Not every process of the run is confirmed to have ended\./);
  assert.equal(stillThere('detached'), true, 'a process that cannot be identified is not signalled');
  await allGone(treeRoles.filter(role => role !== 'detached' && role !== 'detached-child'));
  assert.equal(bystanderSurvived(), true);
});

test('a process of the run that cannot be read stops the run: its memory would be unknown', { timeout: 60000 }, async t => {
  const { environment, stillThere, allGone, bystanderSurvived } = scenario(t);
  // The guard notices within a sample or two of the process appearing, so the
  // fixture is usually stopped before its tree is even complete.
  const result = await startGuard([descendants], { ...environment('idle'), CRATE_GUARD_FAULT: 'unreadable:detached' }, faultyGuard).done;
  assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
  assert.match(result.stderr, /run-tests: GUARD CANNOT READ PROCESS \d+ OF THE RUN after [\d.]+ s \(errno 1, 1 samples in a row\)\. Its memory is unknown\./);
  assert.match(result.stderr, /run-tests: CLEANUP INCOMPLETE: 1 processes of the run could not be identified by start time and were left alone: \d+\./);
  assert.ok(result.seconds < 15, `took ${result.seconds} s`);
  assert.equal(stillThere('detached'), true);
  await allGone(['nested', 'nested-child', 'short-lived', 'adopted', 'ready']);
  assert.equal(bystanderSurvived(), true);
});

// What the guard's report says of a process that stopped the run by answering
// "no such process", checked line by line. `scans` is how many scans it lists.
function assertReport(result, pid, { scans, exiting }) {
  const report = result.stderr.slice(result.stderr.indexOf(`run-tests: About process ${pid}, which stopped the run`));
  assert.ok(report.startsWith('run-tests: About'), result.stderr);
  assert.ok(result.stderr.indexOf('Every process of the run has ended.') < result.stderr.indexOf('About process'));
  const lines = report.split('\n').filter(line => line.startsWith('run-tests:   ') || line.startsWith('run-tests: About'));
  assert.match(lines[1], new RegExp(`^run-tests:   unreadable in \\d+ scans in a row over \\d+ ms; ${exiting ? 'shown exiting from \\d+ ms after the first \\(1000 ms allowed\\)' : 'never shown exiting'}; the stop came \\d+ ms after the last of them; the last ${scans}, from the first:$`));
  const scanLine = exiting ? 'process info errno 3, usage errno 0, [\\d.]+ MB resident, 0\\.0 MB footprint, exiting' : 'process info errno 3, usage errno 3';
  for (const line of lines.slice(2, 2 + scans)) assert.match(line, new RegExp(`^run-tests:     \\+\\d+ ms: ${scanLine}$`));
  const rest = lines.slice(2 + scans);
  assert.match(rest[0], new RegExp(`^run-tests:   last read in full \\d+ ms before the stop: parent \\d+, process group \\d+ \\(the test runner's\\), uid ${process.getuid()}, [\\d.]+ MB \\([\\d.]+ MB resident, [\\d.]+ MB footprint\\), start \\d+ \\(Mach absolute time\\), [\\d.]+ s after the test runner started$`));
  assert.equal(rest[1], 'run-tests:   session: not known (the sampler does not read it)');
  assert.match(rest[2], /^run-tests:   in the \d+ scans from the stop to the end of the cleanup \(freeze, kill, confirmation\): .+ in \d+ \(\+\d+ to \+\d+ ms\)/);
  // Asked after the cleanup: here the process was killed with the run, and is gone or about to be collected.
  assert.match(rest[3], /^run-tests:   after the cleanup \(\+\d+ ms\): (not )?listed, process info errno \d+, usage errno \d+; process table: (no record|state \d+, parent -?\d+, group -?\d+, uid \d+, real uid \d+); executable: \S.*$/);
  assert.match(rest[4], /^run-tests:   the last 8 scans before the stop took [\d.]+ to [\d.]+ ms and began [\d.]+ to [\d.]+ ms apart$/);
  assert.equal(rest.length, 5);
  assert.ok(lines.every(line => line.length < 700));
  assert.doesNotMatch(report, /CRATE_GUARD|crate-guard-|pids/);
  return report;
}

test('a process that answers "no such process" to both reads for too long stops the run after the same samples, and the report says what was known of it', { timeout: 60000 }, async t => {
  const { environment, recorded, allGone, bystanderSurvived } = scenario(t);
  const result = await startGuard([descendants], { ...environment('idle'), CRATE_GUARD_FAULT: 'no-such-process:nested' }, faultyGuard).done;
  const nested = recorded().get('nested');
  // Exit status, message and sample count are those of the guard without this report.
  assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
  assert.match(result.stderr, new RegExp(`run-tests: GUARD CANNOT READ PROCESS ${nested} OF THE RUN after [\\d.]+ s \\(errno ${ESRCH}, ${UNREADABLE_SAMPLES + 1} samples in a row\\)\\. Its memory is unknown\\.\\nrun-tests:   .*\\nrun-tests: Stopping the test run \\(\\d+ processes\\)\\.`));
  assert.match(result.stderr, /run-tests: Every process of the run has ended\./);
  assert.ok(result.seconds < 15, `took ${result.seconds} s`);
  assertReport(result, nested, { scans: UNREADABLE_SAMPLES + 1, exiting: false });
  assert.doesNotMatch(result.stderr, /let through while exiting/);
  await allGone(['nested', 'nested-child', 'short-lived', 'ready']);
  assert.equal(bystanderSurvived(), true);
});

test('a process that is exiting and gone within a second does not stop the run, and the summary says so', { timeout: 60000 }, async t => {
  const { environment, allGone, bystanderSurvived } = scenario(t);
  // Six scans exiting, more than the three samples a process answering "no such process" to both reads gets.
  const result = await startGuard([descendants], { ...environment('short'), CRATE_GUARD_FAULT: 'exiting-then-gone:nested' }, faultyGuard).done;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^# pass 1$/m);
  assert.doesNotMatch(result.stderr, /CANNOT READ|EXCEEDED|INCOMPLETE|About process/);
  assert.match(result.stderr, /^run-tests: memory guard: \d+ samples, peak \d+ MB in one process and \d+ MB in total \(limits [\d.]+ GB, [\d.]+ GB, \d+ s\)$/m);
  assert.match(result.stderr, /^run-tests: memory guard: 1 processes were let through while exiting, the longest seen exiting for \d+ ms \(1000 ms allowed\); the largest usage read while exiting was [\d.]+ MB resident and 0\.0 MB footprint, against [\d.]+ MB at its last full reading$/m);
  const longest = Number(/seen exiting for (\d+) ms/.exec(result.stderr)[1]);
  assert.ok(longest > 0 && longest <= EXITING.milliseconds, `${longest} ms`);
  // The fault hides `nested` from every scan once it is "gone", so the guard never saw it to end it; the scenario does.
  await allGone(treeRoles.filter(role => role !== 'nested'));
  assert.equal(bystanderSurvived(), true);
});

test('a process that is still exiting after a second stops the run as before, saying how long and at what it was counted', { timeout: 60000 }, async t => {
  const { environment, recorded, allGone, bystanderSurvived } = scenario(t);
  // On the guard's own clock, so that nothing depends on where a real sample lands: five scans inside the
  // second, the last of them at exactly 1000 ms, and the next one past it, which is judged and not applied.
  const result = await startGuard([descendants], {
    ...environment('idle'), CRATE_GUARD_FAULT: 'exiting-stepped:nested', CRATE_GUARD_ELAPSED: '250,500,750,1000,1250',
  }, faultyGuard).done;
  const nested = recorded().get('nested');
  assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
  assert.match(result.stderr, new RegExp(`run-tests: GUARD CANNOT READ PROCESS ${nested} OF THE RUN after [\\d.]+ s \\(errno ${ESRCH}, 5 samples in a row\\)\\. It had been exiting for 1250 ms, longer than the 1000 ms allowed; while exiting it was counted at up to \\d+ MB\\.\\nrun-tests:   .*\\nrun-tests: Stopping the test run \\(\\d+ processes\\)\\.`));
  assert.match(result.stderr, /run-tests: Every process of the run has ended\./);
  assertReport(result, nested, { scans: 5, exiting: true });
  assert.match(result.stderr, /^run-tests: memory guard: 1 processes were let through while exiting/m);
  await allGone(['nested', 'nested-child', 'short-lived', 'ready']);
  assert.equal(bystanderSurvived(), true);
});

test('a process stopped a fraction of a millisecond past the exiting second is reported as past it, not as at the limit', { timeout: 60000 }, async t => {
  const { environment, recorded, allGone, bystanderSurvived } = scenario(t);
  const result = await startGuard([descendants], {
    ...environment('idle'), CRATE_GUARD_FAULT: 'exiting-stepped:nested', CRATE_GUARD_ELAPSED: '1000,1000.25',
  }, faultyGuard).done;
  const nested = recorded().get('nested');
  assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
  assert.match(result.stderr, new RegExp(`run-tests: GUARD CANNOT READ PROCESS ${nested} OF THE RUN after [\\d.]+ s \\(errno ${ESRCH}, 2 samples in a row\\)\\. It had been exiting for 1001 ms, longer than the 1000 ms allowed;`));
  await allGone(['nested', 'nested-child', 'short-lived', 'ready']);
  assert.equal(bystanderSurvived(), true);
});

test('an exiting process, then a sampler that does not answer: the stop comes when a scan times out after the second, before the blind limit', { timeout: 60000 }, async t => {
  const { environment, recorded, allGone, bystanderSurvived } = scenario(t);
  // Two scans show it exiting; then every scan of the sampler in use times out, as a sampler that does not answer does.
  const result = await startGuard([descendants], { ...environment('idle'), CRATE_GUARD_FAULT: 'exiting-then-stall:nested' }, faultyGuard).done;
  const nested = recorded().get('nested');
  assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
  const stopped = new RegExp(`run-tests: GUARD CANNOT READ PROCESS ${nested} OF THE RUN after [\\d.]+ s \\(errno ${ESRCH}, 2 samples in a row\\)\\. `
    + 'It had been exiting for (\\d+) ms, longer than the 1000 ms allowed; while exiting it was counted at up to \\d+ MB\\.\\n'
    + 'run-tests:   .*\\nrun-tests: Stopping the test run \\(\\d+ processes\\)\\.\\nrun-tests: Every process of the run has ended\\.').exec(result.stderr);
  assert.ok(stopped, result.stderr);
  // No timer of its own: the second is judged at the top of the pass after a scan fails at its request
  // timeout (1000 ms after it was sent), so at most 1000 + 1000 + 50 ms after the first exiting scan;
  // the blind limit (3000 ms after the last good scan) does not come first.
  const exitingFor = Number(stopped[1]);
  assert.ok(exitingFor > EXITING.milliseconds && exitingFor <= 2 * EXITING.milliseconds + 50 + 300, `stopped after ${exitingFor} ms exiting`);
  assert.doesNotMatch(result.stderr, /LOST SIGHT|INCOMPLETE|scan was still in progress/);
  // The cleanup meets the same sampler that does not answer, and goes on with the one standing by, as it always has.
  assert.match(result.stderr, /run-tests: the sampler failed \(sampler did not answer within 1000 ms \(injected\)\); continuing with the one standing by/);
  await allGone(['nested', 'nested-child', 'short-lived', 'ready']);
  assert.equal(bystanderSurvived(), true);
});

test('a sampler that stops answering with no process exiting is handled as before: the blind limit', { timeout: 60000 }, async t => {
  const { environment, allGone, bystanderSurvived } = scenario(t);
  const result = await startGuard([descendants], { ...environment('idle'), CRATE_GUARD_FAULT: 'stall:nested' }, faultyGuard).done;
  assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
  assert.match(result.stderr, /run-tests: GUARD LOST SIGHT OF THE RUN after [\d.]+ s: sampler did not answer within 1000 ms \(injected\)\.\nrun-tests: Stopping the test run \(\d+ processes\)\.\nrun-tests: Every process of the run has ended\./);
  assert.doesNotMatch(result.stderr, /CANNOT READ|allowance|let through while exiting/);
  await allGone(['nested', 'nested-child', 'short-lived', 'ready']);
  assert.equal(bystanderSurvived(), true);
});

for (const late of ['gone', 'ended', 'readable']) {
  test(`a scan that arrives after the exiting second, showing the process ${late}, stops the run and is not applied`, { timeout: 60000 }, async t => {
    const { environment, recorded, allGone, bystanderSurvived } = scenario(t);
    // One scan shows it exiting and the guard's clock stands still; the next arrives with it exactly 1100 ms on.
    const result = await startGuard([descendants], { ...environment('short'), CRATE_GUARD_FAULT: 'exiting-then-late:nested', CRATE_GUARD_LATE: late }, faultyGuard).done;
    const nested = recorded().get('nested');
    assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
    // Still one sample: the late scan was judged before it was applied, and not applied.
    assert.match(result.stderr, new RegExp(`run-tests: GUARD CANNOT READ PROCESS ${nested} OF THE RUN after [\\d.]+ s \\(errno ${ESRCH}, 1 samples in a row\\)\\. `
      + 'It had been exiting for 1100 ms, longer than the 1000 ms allowed'));
    assert.doesNotMatch(result.stdout, /^# pass 1$/m, 'stopped before the run could finish');
    await allGone(treeRoles.filter(role => role !== 'nested'));
    assert.equal(bystanderSurvived(), true);
  });
}

test('a scan that arrives inside the exiting second (exactly 900 ms), no longer listing the process, lets the run go on', { timeout: 60000 }, async t => {
  const { environment, allGone, bystanderSurvived } = scenario(t);
  const result = await startGuard([descendants], { ...environment('short'), CRATE_GUARD_FAULT: 'exiting-then-late:nested', CRATE_GUARD_LATE: 'early-gone' }, faultyGuard).done;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^# pass 1$/m);
  assert.doesNotMatch(result.stderr, /CANNOT READ|LOST SIGHT/);
  assert.match(result.stderr, /^run-tests: memory guard: 1 processes were let through while exiting/m);
  await allGone(treeRoles.filter(role => role !== 'nested'));
  assert.equal(bystanderSurvived(), true);
});

// The end of the run. The test run passes after 2.5 s and leaves its tree; the
// guard sees the end of the run in a scan inside the exiting second, and then
// takes one more scan, which is judged before it is applied.
const endedThen = (nested, stderr) => {
  const stopped = new RegExp(`run-tests: GUARD CANNOT READ PROCESS ${nested} OF THE RUN after [\\d.]+ s \\(errno ${ESRCH}, \\d+ samples in a row\\)\\. `
    + 'It had been exiting for 1100 ms, longer than the 1000 ms allowed; while exiting it was counted at up to \\d+ MB\\.\\n'
    + 'run-tests: The test run had ended by then, with exit status 0\\. Exit status 125 replaces it\\.\\n').test(stderr);
  assert.ok(stopped, stderr);
};
for (const late of ['gone', 'ended', 'readable']) {
  test(`the scan after the end of the run, arriving after the exiting second and showing the process ${late}, ends it 125, not with the run's own status`, { timeout: 60000 }, async t => {
    const { environment, recorded, bystanderSurvived } = scenario(t);
    const result = await startGuard([descendants], { ...environment('short'), CRATE_GUARD_FAULT: 'exiting-at-exit:nested', CRATE_GUARD_POST: 'late', CRATE_GUARD_LATE: late }, faultyGuard).done;
    assert.match(result.stdout, /^# pass 1$/m);
    assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
    endedThen(recorded().get('nested'), result.stderr);
    assert.equal(bystanderSurvived(), true);
  });
}

test('the end of the run seen after a scan failed, with the exiting second over by then, ends it 125', { timeout: 60000 }, async t => {
  const { environment, recorded, bystanderSurvived } = scenario(t);
  const result = await startGuard([descendants], { ...environment('short'), CRATE_GUARD_FAULT: 'exiting-at-exit:nested', CRATE_GUARD_POST: 'timeout', CRATE_GUARD_LATE: 'gone' }, faultyGuard).done;
  assert.match(result.stdout, /^# pass 1$/m);
  assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
  endedThen(recorded().get('nested'), result.stderr);
  assert.equal(bystanderSurvived(), true);
});

test('the scan after the end of the run, retried with the sampler standing by after the exiting second, ends it 125', { timeout: 60000 }, async t => {
  const { environment, recorded, bystanderSurvived } = scenario(t);
  const result = await startGuard([descendants], { ...environment('short'), CRATE_GUARD_FAULT: 'exiting-at-exit:nested', CRATE_GUARD_POST: 'retry', CRATE_GUARD_LATE: 'gone' }, faultyGuard).done;
  assert.match(result.stdout, /^# pass 1$/m);
  assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
  assert.match(result.stderr, /run-tests: the sampler failed \(sampler exited \(injected\)\); continuing with the one standing by/);
  endedThen(recorded().get('nested'), result.stderr);
  assert.equal(bystanderSurvived(), true);
});

test('the scan after the end of the run, arriving inside the exiting second and no longer listing the process, keeps the run\'s own status', { timeout: 60000 }, async t => {
  const { environment, bystanderSurvived } = scenario(t);
  const result = await startGuard([descendants], { ...environment('short'), CRATE_GUARD_FAULT: 'exiting-at-exit:nested', CRATE_GUARD_POST: 'inside', CRATE_GUARD_LATE: 'gone' }, faultyGuard).done;
  assert.match(result.stdout, /^# pass 1$/m);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /CANNOT READ|LOST SIGHT|INCOMPLETE/);
  // The fault fired: the scan after the end of the run came with the clock exactly 900 ms on.
  assert.match(result.stderr, /faulty-guard: after the end of the run, \d+ scans before the first signal; injected: the scan after the end of the run at 900 ms\n/);
  assert.equal(bystanderSurvived(), true);
});

// The hand-off. The guard stops judging exiting allowances at the first
// successful scan after the end of the run; a process still inside its second
// then is an ordinary leftover for the existing cleanup.
const handOff = (environment, how) => startGuard([descendants],
  { ...environment('short'), CRATE_GUARD_FAULT: 'exiting-at-exit:nested', CRATE_GUARD_POST: how }, faultyGuard).done;
const seam = stderr => {
  const line = /faulty-guard: after the end of the run, (\d+) scans before the first signal; injected: (.*)\n/.exec(stderr);
  assert.ok(line, stderr);
  return { beforeSignal: Number(line[1]), injected: line[2] };
};

test('hand-off: a process still exiting at the first scan after the end of the run is a leftover; gone during cleanup, the run keeps its own status', { timeout: 60000 }, async t => {
  const { environment, bystanderSurvived } = scenario(t);
  const result = await handOff(environment, 'handoff-gone');
  assert.match(result.stdout, /^# pass 1$/m);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /run-tests: The test run ended and left \d+ of its processes running; ending them\./);
  assert.doesNotMatch(result.stderr, /CANNOT READ|INCOMPLETE|LOST SIGHT/);
  // Not vacuous: the cleanup's scan arrived after the one-second mark, and showed the process gone.
  assert.equal(seam(result.stderr).injected, 'the scan after the end of the run at 500 ms, still exiting, a later scan at 1100 ms');
  assert.equal(bystanderSurvived(), true);
});

test('hand-off: a leftover that is still there when the cleanup\'s confirmation ends makes it 125, as on the base', { timeout: 60000 }, async t => {
  const { environment, recorded, bystanderSurvived } = scenario(t);
  const result = await handOff(environment, 'handoff-stays');
  assert.match(result.stdout, /^# pass 1$/m);
  assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
  assert.doesNotMatch(result.stderr, /CANNOT READ/);
  assert.match(result.stderr, new RegExp(`run-tests: CLEANUP INCOMPLETE: 1 processes of the run were still there [\\d.]+ s after SIGKILL: ${recorded().get('nested')}\\.\\n`));
  assert.match(result.stderr, /run-tests: Exit status 125 replaces 0\.\nrun-tests: Not every process of the run is confirmed to have ended\./);
  assert.equal(bystanderSurvived(), true);
});

test('hand-off: a retry of the cleanup after the first successful scan runs with judging off; gone after the mark, the run keeps its own status', { timeout: 60000 }, async t => {
  const { environment, bystanderSurvived } = scenario(t);
  const result = await handOff(environment, 'handoff-retry');
  assert.match(result.stdout, /^# pass 1$/m);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /run-tests: the sampler failed \(sampler exited \(injected\)\); continuing with the one standing by/);
  assert.doesNotMatch(result.stderr, /CANNOT READ|INCOMPLETE/);
  assert.equal(seam(result.stderr).injected,
    'the scan after the end of the run at 500 ms, still exiting, the cleanup\'s first scan failed as a sampler that ends does, a later scan at 1100 ms');
  assert.equal(bystanderSurvived(), true);
});

test('hand-off: a retry after it, still showing the process exiting past its second, does not judge the allowance; gone later, the run keeps its own status', { timeout: 60000 }, async t => {
  const { environment, bystanderSurvived } = scenario(t);
  const result = await handOff(environment, 'handoff-retry-still');
  assert.match(result.stdout, /^# pass 1$/m);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /run-tests: the sampler failed \(sampler exited \(injected\)\); continuing with the one standing by/);
  assert.doesNotMatch(result.stderr, /CANNOT READ|INCOMPLETE/);
  assert.equal(seam(result.stderr).injected, 'the scan after the end of the run at 500 ms, still exiting, '
    + 'the cleanup\'s first scan failed as a sampler that ends does, a later scan at 1100 ms, still exiting');
  assert.equal(bystanderSurvived(), true);
});

test('hand-off: a retry after it, and the process never goes away: 125 through the cleanup, not through the allowance', { timeout: 60000 }, async t => {
  const { environment, recorded, bystanderSurvived } = scenario(t);
  const result = await handOff(environment, 'handoff-retry-stays');
  assert.match(result.stdout, /^# pass 1$/m);
  assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
  assert.doesNotMatch(result.stderr, /CANNOT READ|had been exiting/);
  assert.match(result.stderr, new RegExp(`run-tests: CLEANUP INCOMPLETE: 1 processes of the run were still there [\\d.]+ s after SIGKILL: ${recorded().get('nested')}\\.\\n`));
  assert.match(result.stderr, /run-tests: Exit status 125 replaces 0\.\nrun-tests: Not every process of the run is confirmed to have ended\./);
  assert.equal(bystanderSurvived(), true);
});

test('hand-off: a retry after it that shows another process whose usage is denied stops the run, as the base does on that retry', { timeout: 60000 }, async t => {
  const { environment, recorded, bystanderSurvived } = scenario(t);
  const result = await handOff(environment, 'handoff-retry-eperm');
  assert.match(result.stdout, /^# pass 1$/m);
  assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
  // The base re-judges the retried scan with readFailure() for its own rules; so does this guard.
  assert.match(result.stderr, new RegExp(`run-tests: GUARD CANNOT READ PROCESS ${recorded().get('nested-child')} OF THE RUN after [\\d.]+ s \\(errno ${EPERM}, 1 samples in a row\\)\\. Its memory is unknown\\.\\n`
    + 'run-tests: The test run had ended by then, with exit status 0\\. Exit status 125 replaces it\\.\\n'));
  assert.doesNotMatch(result.stderr, /had been exiting/);
  assert.equal(bystanderSurvived(), true);
});

test('after the end of the run, a retry of the cleanup that shows a process whose usage is denied stops the run (the base\'s behaviour on that retry)', { timeout: 60000 }, async t => {
  const { environment, recorded, bystanderSurvived } = scenario(t);
  const result = await handOff(environment, 'retry-eperm');
  assert.match(result.stdout, /^# pass 1$/m);
  assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
  assert.match(result.stderr, /run-tests: the sampler failed \(sampler exited \(injected\)\); continuing with the one standing by/);
  assert.match(result.stderr, new RegExp(`run-tests: GUARD CANNOT READ PROCESS ${recorded().get('nested-child')} OF THE RUN after [\\d.]+ s \\(errno ${EPERM}, 1 samples in a row\\)\\. Its memory is unknown\\.\\n`
    + 'run-tests: The test run had ended by then, with exit status 0\\. Exit status 125 replaces it\\.\\n'));
  assert.equal(bystanderSurvived(), true);
});

test('before the hand-off: a failed scan after the end of the run whose retry still shows the process exiting past its second ends it 125', { timeout: 60000 }, async t => {
  const { environment, recorded, bystanderSurvived } = scenario(t);
  const result = await startGuard([descendants], { ...environment('short'), CRATE_GUARD_FAULT: 'exiting-at-exit:nested', CRATE_GUARD_POST: 'retry', CRATE_GUARD_LATE: 'exiting' }, faultyGuard).done;
  assert.match(result.stdout, /^# pass 1$/m);
  assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
  assert.match(result.stderr, /run-tests: the sampler failed \(sampler exited \(injected\)\); continuing with the one standing by/);
  endedThen(recorded().get('nested'), result.stderr);
  assert.equal(bystanderSurvived(), true);
});

test('hand-off: with no process exiting at the end of the run, the scan after it and then the cleanup, as on the base', { timeout: 60000 }, async t => {
  const { environment, bystanderSurvived } = scenario(t);
  const result = await handOff(environment, 'none');
  assert.match(result.stdout, /^# pass 1$/m);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /run-tests: The test run ended and left \d+ of its processes running; ending them\./);
  // The scan after the end of the run, and the cleanup's first scan, then its signal.
  assert.deepEqual(seam(result.stderr), { beforeSignal: 2, injected: 'nothing' });
  assert.equal(bystanderSurvived(), true);
});

test('a ps let through as the system tool and then read as killed stops the run as on the base, and the report shows each scan', { timeout: 60000 }, async t => {
  const { environment, recorded, allGone, bystanderSurvived } = scenario(t);
  // The shape of the CI stops: two scans as the live ps, then no process info with usage still denied.
  const result = await startGuard([descendants], { ...environment('idle'), CRATE_GUARD_FAULT: 'tool-exiting:nested' }, faultyGuard).done;
  const nested = recorded().get('nested');
  assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
  assert.match(result.stderr, new RegExp(`run-tests: GUARD CANNOT READ PROCESS ${nested} OF THE RUN after [\\d.]+ s \\(errno ${EPERM}, 3 samples in a row\\)\\. Its memory is unknown\\.\\n`));
  assert.match(result.stderr, new RegExp(`run-tests: About process ${nested}, which stopped the run`));
  assert.match(result.stderr, /run-tests:     \+0 ms: process info errno 0, usage errno 1, executable \/bin\/ps, let through as the system tool \(sample 1\)\n/);
  assert.match(result.stderr, /run-tests:     \+\d+ ms: process info errno 0, usage errno 1, executable \/bin\/ps, let through as the system tool \(sample 2\)\n/);
  assert.match(result.stderr, /run-tests:     \+\d+ ms: process info errno 3, usage errno 1, not let through \(sample 3\)\n/);
  assert.doesNotMatch(result.stderr, /processes were let through while exiting/);
  await allGone(['nested', 'nested-child', 'short-lived', 'ready']);
  assert.equal(bystanderSurvived(), true);
});

test('an exiting process still counts at its last full reading: over a limit, the run is stopped for memory', { timeout: 60000 }, async t => {
  const { environment, allGone, bystanderSurvived } = scenario(t);
  // 1300 MB at its last full reading, nothing while exiting, and another process 1100 MB larger:
  // over 2400 MB in total only when the exiting one counts at its last full reading.
  const result = await startGuard(['--total-memory-limit-mb=2400', descendants],
    { ...environment('idle'), CRATE_GUARD_FAULT: 'exiting-over-limit:nested' }, faultyGuard).done;
  assert.equal(result.code, EXIT_MEMORY_LIMIT, result.stderr);
  assert.match(result.stderr, /run-tests: MEMORY LIMIT EXCEEDED after [\d.]+ s: the run reached \d+ MB across \d+ processes \(limit 2400 MB in total\)\./);
  assert.doesNotMatch(result.stderr, /CANNOT READ/);
  await allGone(['nested', 'nested-child', 'short-lived', 'ready']);
  assert.equal(bystanderSurvived(), true);
});

for (const how of ['stall', 'die', 'throw']) {
  test(`a describe request that ${how}s after the cleanup changes nothing about the stop, its cleanup or its exit status`, { timeout: 60000 }, async t => {
    const { environment, recorded, allGone, bystanderSurvived } = scenario(t);
    const result = await startGuard([descendants], { ...environment('idle'), CRATE_GUARD_FAULT: 'no-such-process:nested', CRATE_GUARD_DESCRIBE: how }, faultyGuard).done;
    const nested = recorded().get('nested');
    assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
    assert.match(result.stderr, new RegExp(`run-tests: GUARD CANNOT READ PROCESS ${nested} OF THE RUN after [\\d.]+ s \\(errno ${ESRCH}, ${UNREADABLE_SAMPLES + 1} samples in a row\\)\\. Its memory is unknown\\.\\nrun-tests:   .*\\nrun-tests: Stopping the test run \\(\\d+ processes\\)\\.\\nrun-tests: Every process of the run has ended\\.\\nrun-tests: About process`));
    assert.doesNotMatch(result.stderr, /sampler failed|continuing with|INCOMPLETE|faulty-guard:/);
    assert.match(result.stderr, new RegExp(`run-tests:   after the cleanup \\(\\+\\d+ ms\\): the sampler did not describe it \\(${
      { stall: 'no answer within 500 ms', die: 'sampler stopped', throw: 'describe failed \\(injected\\)' }[how]}\\)\\n`));
    assert.ok(result.seconds < 15, `took ${result.seconds} s`);
    await allGone(['nested', 'nested-child', 'short-lived', 'ready']);
    assert.equal(bystanderSurvived(), true);
  });
}

test('a test runner that cannot be read is stopped at the first scan, before its tests get anywhere', { timeout: 60000 }, async t => {
  const { environment, recorded, bystanderSurvived } = scenario(t);
  const result = await startGuard([descendants], { ...environment('idle'), CRATE_GUARD_FAULT: 'unreadable-runner' }, faultyGuard).done;
  assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
  assert.match(result.stderr, /run-tests: GUARD CANNOT READ PROCESS \d+ OF THE RUN after 0\.\d s \(errno 1, 1 samples in a row\)\. Its memory is unknown\./);
  assert.match(result.stderr, /run-tests: Every process of the run has ended\./);
  assert.match(result.stderr, /run-tests: memory guard: 1 samples,/);
  assert.doesNotMatch(result.stdout, /^ok 1 /m);
  assert.deepEqual([...recorded().keys()], [], 'the fixture never started its process tree');
  assert.ok(result.seconds < 10, `took ${result.seconds} s`);
  assert.equal(bystanderSurvived(), true);
});

test('when the sampler in use fails and no new one can be started, the one standing by stops the whole run', { timeout: 60000 }, async t => {
  const { environment, ready, allGone, bystanderSurvived } = scenario(t);
  const run = startGuard([descendants], { ...environment('idle'), CRATE_GUARD_FAULT: 'primary-fails' }, faultyGuard);
  await ready();
  const result = await run.done;
  assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
  assert.match(result.stderr, /run-tests: GUARD LOST SIGHT OF THE RUN after [\d.]+ s: sampler exited \(injected\)\./);
  assert.match(result.stderr, /run-tests: Stopping the test run \(\d+ processes\)\./);
  assert.match(result.stderr, /run-tests: Every process of the run has ended\./);
  assert.doesNotMatch(result.stderr, /could not be verified|NOT touched/);
  await allGone([...treeRoles, 'ready']);
  assert.equal(bystanderSurvived(), true);
});

test('when no sampler works at all, only the runner\'s process group is ended, and the guard says what it left running', { timeout: 60000 }, async t => {
  const { environment, ready, recorded, stillThere, allGone, bystanderSurvived } = scenario(t);
  const run = startGuard([descendants], { ...environment('idle'), CRATE_GUARD_FAULT: 'all-samplers-fail' }, faultyGuard);
  await ready();
  const result = await run.done;
  assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
  assert.match(result.stderr, /run-tests: GUARD LOST SIGHT OF THE RUN after [\d.]+ s: sampler exited \(injected\)\./);
  assert.match(result.stderr, /run-tests: Cleanup could not be verified \(no new sampler can be started \(injected\)\)\./);
  assert.match(result.stderr, /run-tests: Killed the test runner's process group\. Processes the run started outside that group were NOT touched and may still be running\./);
  assert.match(result.stderr, /run-tests: Not every process of the run is confirmed to have ended\./);
  assert.doesNotMatch(result.stderr, /Every process of the run has ended/);
  // The runner's group is gone: the test file and what it started in that group.
  await allGone(['nested', 'nested-child', 'short-lived', 'ready']);
  // What the run started outside the group is still there. This is the limit
  // of the guard without a sampler; it names those processes, and this test ends them.
  const tree = recorded();
  const outside = ['detached', 'detached-child', 'adopted'];
  for (const role of outside) assert.equal(stillThere(role), true, `${role} was left running`);
  const listed = /Last seen outside that group, not signalled: ([\d, ]+)\./.exec(result.stderr);
  assert.ok(listed, result.stderr);
  assert.deepEqual(listed[1].split(', ').map(Number).sort((a, b) => a - b), outside.map(role => tree.get(role)).sort((a, b) => a - b));
  assert.equal(bystanderSurvived(), true);
});

const psIsSetUid = (fs.statSync(SYSTEM_TOOL.path).mode & 0o4000) !== 0 && fs.statSync(SYSTEM_TOOL.path).uid === 0 && process.getuid() !== 0;

test('the sampler reports who a process runs as, and an executable path only for a set-uid tool this user started', { timeout: 60000 }, async t => {
  const sampler = await startCheckedSampler();
  // A real ps, kept alive for a moment by output nobody reads, and ended here through the handle on our own child.
  const ps = spawn(SYSTEM_TOOL.path, ['-axwwo', Array(16).fill('command=').join(',')], { stdio: ['ignore', 'pipe', 'ignore'] });
  const ordinary = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });
  t.after(() => { ps.kill('SIGKILL'); ordinary.kill('SIGKILL'); sampler.stop(); });
  await new Promise(resolve => { setTimeout(resolve, 300); });
  const rows = await sampler.scan();
  const own = process.getuid();
  const find = pid => rows.find(item => item.pid === pid);
  assert.deepEqual([find(ordinary.pid).uid, find(ordinary.pid).ruid, find(ordinary.pid).usageError, find(ordinary.pid).path], [own, own, 0, null]);
  assert.deepEqual([find(process.pid).uid, find(process.pid).ruid, find(process.pid).path], [own, own, null]);
  if (psIsSetUid) {
    assert.equal(ps.exitCode, null, 'the ps is still running');
    assert.deepEqual([find(ps.pid).uid, find(ps.pid).ruid, find(ps.pid).usageError, find(ps.pid).infoError, find(ps.pid).start, find(ps.pid).path],
      [0, own, EPERM, 0, '0', SYSTEM_TOOL.path]);
  }
  // Across every process on the machine: a path is present exactly where the
  // sampler was entitled to read one, so nothing carries over from row to row.
  for (const item of rows) {
    const entitled = item.usageError === EPERM && item.infoError === 0 && item.ruid === own && item.uid !== own;
    if (item.path !== null) assert.ok(entitled, `process ${item.pid} has a path it should not have`);
    if (item.usageError === 0) assert.equal(item.path, null);
    if (item.infoError !== 0) assert.deepEqual([item.ppid, item.pgid, item.uid, item.ruid, item.status, item.path], [0, 0, 0, 0, 0, null]);
    if (item.usageError !== 0) assert.deepEqual([item.start, item.megabytes], ['0', 0]);
  }
  ps.kill('SIGKILL');
  await new Promise(resolve => { ps.on('exit', resolve); });
});

// A process that starts one child, which ends by itself at once, and then
// does not collect it: it prints the child's pid and blocks. The child is `ps`
// or an ordinary tool.
const HOLDER = `
  const { spawn } = require('node:child_process');
  const child = process.argv[1] === 'ps' ? spawn('/bin/ps', ['-axo', 'pid='], { stdio: 'ignore' }) : spawn('/bin/echo', [], { stdio: 'ignore' });
  require('node:fs').writeSync(1, child.pid + '\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);`;

test('a scan reports a process that has ended and is not collected as ended, with its parent, group and owners', { timeout: 60000 }, async t => {
  const sampler = await startCheckedSampler();
  const holders = ['echo', 'ps'].map(tool => spawn(process.execPath, ['-e', HOLDER, tool], { stdio: ['ignore', 'pipe', 'ignore'] }));
  t.after(() => { for (const holder of holders) holder.kill('SIGKILL'); sampler.stop(); });
  const childPids = await Promise.all(holders.map(holder => new Promise(resolve => {
    holder.stdout.setEncoding('utf8').once('data', text => resolve(Number(text)));
  })));
  await new Promise(resolve => { setTimeout(resolve, 500); });
  const rows = await sampler.scan();
  const own = process.getuid();
  const [ordinary, ps] = childPids.map(pid => rows.find(item => item.pid === pid));
  const group = rows.find(item => item.pid === process.pid).pgid;
  // The ordinary one still has its start time; its usage stays readable.
  assert.deepEqual([ordinary.infoError, ordinary.status, ordinary.ppid, ordinary.pgid, ordinary.uid, ordinary.ruid, ordinary.usageError, ordinary.path],
    [0, ZOMBIE, holders[0].pid, group, own, own, 0, null]);
  assert.notEqual(ordinary.start, '0');
  // The set-uid one: its usage stays denied, and nothing of it is in the row.
  if (psIsSetUid) {
    assert.deepEqual([ps.infoError, ps.status, ps.ppid, ps.pgid, ps.uid, ps.ruid, ps.usageError, ps.start, ps.megabytes, ps.path],
      [0, ZOMBIE, holders[1].pid, group, 0, own, EPERM, '0', 0, null]);
  }
  // Once the parents are gone the system collects them, and they are not listed as those processes any more.
  for (const holder of holders) holder.kill('SIGKILL');
  await new Promise(resolve => { setTimeout(resolve, 500); });
  const later = await sampler.scan();
  assert.deepEqual(later.filter(item => childPids.includes(item.pid) && (item.status === ZOMBIE || item.infoError === ESRCH)), []);
});

// Runs the sampler's own code under tests/fixtures/memory-guard/sampler-harness.py,
// with the Python the guard itself would use, and returns what it reports.
function inSampler(check, scenario) {
  const python = fs.existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3';
  const args = ['-I', '-B', samplerHarness, samplerFile, check, ...(scenario ? [JSON.stringify(scenario)] : [])];
  return JSON.parse(execFileSync(python, args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }));
}

test('the sampler takes a process record only whole and only for the pid it asked about, and does not start when it cannot read them', { timeout: 60000 }, () => {
  const { records, checks, started, refused } = inSampler('decoding');
  const ended = [100, 100, 0, 501, ZOMBIE];
  assert.deepEqual(records, {
    'whole record of that pid': [ended],
    'record of another pid': [null],
    'no record': [null],
    'part of a record': [null],
    'whole record, reported as shorter': [null],
    'reported as longer than a record': [null],
    'call fails: no such process': [null],
    'call fails: not permitted': [null],
    'call fails: no memory': [null],
    'after a good record: fails, none, short, nothing written': [ended, null, null, null, null],
  });
  // The check at start passes on the facts as they are, and fails when any one of them reads differently.
  const { 'as they are': right, ...wrong } = checks;
  assert.equal(right, true);
  assert.equal(Object.keys(wrong).length, 18);
  assert.deepEqual(Object.entries(wrong).filter(([, passed]) => passed !== false), []);
  assert.deepEqual(started, [0, '']);
  assert.deepEqual(refused, [2, 'run-tests-sampler: the system\'s process records are not laid out as this sampler expects']);

  // On this machine: parent, group, owners and state from the process table are
  // those libproc gives, for every process both describe; and a free pid has no record.
  const live = inSampler('records');
  assert.ok(live.agree > 20, `only ${live.agree} processes compared`);
  assert.deepEqual([live.differ, live.checked, live.free], [0, true, null]);
});

test('the sampler tells an ended process from a missing or unreadable one by the process table, and from nothing else', { timeout: 60000 }, () => {
  const { self, ordinary, ps } = inSampler('ended');
  const facts = uid => [self.pid, self.group, uid, self.uid];
  // Alive, the ordinary child holds its 48 MB and reads like any process.
  assert.deepEqual([ordinary.alive.info, ordinary.alive.usage, ordinary.alive.record], [0, 0, [...facts(self.uid), 2]]);
  assert.ok(ordinary.alive.megabytes[1] >= 48, `footprint ${ordinary.alive.megabytes[1]} MB`);
  // Ended and not collected: libproc says there is no such process, of both;
  // the process table says "ended", with the right parent, group and owners.
  assert.deepEqual([ordinary.ended.info, ordinary.ended.usage, ordinary.ended.record], [ESRCH, 0, [...facts(self.uid), ZOMBIE]]);
  assert.equal(ps.ended.info, ESRCH);
  // What the ordinary one held is released: the footprint is zero, and the resident size is still what it was at the end.
  assert.equal(ordinary.ended.megabytes[1], 0);
  assert.ok(ordinary.ended.megabytes[0] >= 48, `resident ${ordinary.ended.megabytes[0]} MB`);
  // Its row says ended, keeps the start time it had, and is not read again.
  const ordinaryRow = parseRow(ordinary.ended.row);
  assert.deepEqual([ordinaryRow.infoError, ordinaryRow.status, ordinaryRow.ppid, ordinaryRow.pgid, ordinaryRow.uid, ordinaryRow.ruid, ordinaryRow.usageError, ordinaryRow.path],
    [0, ZOMBIE, self.pid, self.group, self.uid, self.uid, 0, null]);
  assert.deepEqual([ordinaryRow.start, ordinary.ended.transition], [parseRow(ordinary.alive.row).start, false]);
  // Its usage, cached by the kernel as it began to exit, carries an exit time; alive, it carried none.
  assert.deepEqual([parseRow(ordinary.alive.row).exiting, ordinaryRow.exiting], [false, true]);
  if (psIsSetUid) {
    assert.deepEqual([ps.ended.usage, ps.ended.record], [EPERM, [...facts(0), ZOMBIE]]);
    // The set-uid one's row carries nothing of its usage.
    assert.deepEqual([ps.ended.row, ps.ended.transition], [`${ps.pid} ${self.pid} ${self.group} 0 ${ZOMBIE} 0 0 0 0 ${EPERM} ${self.uid} 0 -`, false]);
  }
  // Collected: no record, and nothing to report but that it is not there.
  for (const child of [ordinary, ps]) {
    assert.deepEqual([child.collected.info, child.collected.usage, child.collected.record, child.collected.row],
      [ESRCH, ESRCH, null, `${child.pid} 0 0 0 0 0 0 0 ${ESRCH} ${ESRCH} 0 0 -`]);
  }
});

// Scripted reads for the sampler: what one reading of a process is made of, in
// the order the sampler asks. The sampler runs "as" OWNER, under guard GUARD.
const MB = 1024 * 1024;
const read = {
  info: (ppid, pgid, uid, ruid, status = 2) => ['info', 0, [ppid, pgid, uid, ruid, status]],
  noInfo: errno => ['info', errno],
  usage: (start, resident, footprint) => ['usage', 0, [start, resident, footprint]],
  exitingUsage: (start, resident, footprint, exitTime) => ['usage', 0, [start, resident, footprint, exitTime]],
  noUsage: errno => ['usage', errno],
  path: text => ['path', text],
  record: (...facts) => ['record', facts.length > 0 ? facts : null],
};
const NODE = '/opt/tools/node';
// The states a ps passes through (see the sampler), as readings of a child of 101 in group 100.
const reading = {
  created: [read.info(101, 100, OWNER, OWNER), read.usage(5, 3 * MB, 2 * MB)],
  changingOwner: [read.info(101, 100, OWNER, OWNER), read.noUsage(EPERM)],
  starting: [read.info(101, 100, 0, OWNER), read.noUsage(EPERM), read.path(NODE)],
  tool: [read.info(101, 100, 0, OWNER), read.noUsage(EPERM), read.path('/bin/ps')],
  ending: [read.info(101, 100, 0, OWNER), read.noUsage(EPERM), read.path('-')],
  ended: [read.noInfo(ESRCH), read.noUsage(EPERM), read.record(101, 100, 0, OWNER, ZOMBIE)],
  gone: [read.noInfo(ESRCH), read.noUsage(ESRCH)],
  otherTool: [read.info(101, 100, 0, OWNER), read.noUsage(EPERM), read.path('/usr/bin/top')],
};
const rowOf = {
  created: pid => `${pid} 101 100 ${OWNER} 2 5 ${3 * MB} ${2 * MB} 0 0 ${OWNER} 0 -`,
  changingOwner: pid => `${pid} 101 100 ${OWNER} 2 0 0 0 0 ${EPERM} ${OWNER} 0 -`,
  starting: pid => `${pid} 101 100 0 2 0 0 0 0 ${EPERM} ${OWNER} 0 ${NODE}`,
  tool: pid => `${pid} 101 100 0 2 0 0 0 0 ${EPERM} ${OWNER} 0 /bin/ps`,
  ending: pid => `${pid} 101 100 0 2 0 0 0 0 ${EPERM} ${OWNER} 0 -`,
  ended: pid => `${pid} 101 100 0 ${ZOMBIE} 0 0 0 0 ${EPERM} ${OWNER} 0 -`,
  gone: pid => `${pid} 0 0 0 0 0 0 0 ${ESRCH} ${ESRCH} 0 0 -`,
  otherTool: pid => `${pid} 101 100 0 2 0 0 0 0 ${EPERM} ${OWNER} 0 /usr/bin/top`,
};
// Scans as scripted. Every read must be one the script expected next, and every scripted read must be asked for.
function scripted(script, { scans = [Object.keys(script).map(Number)], known = {} } = {}) {
  const result = inSampler('scripted', { uid: OWNER, guard: GUARD, scans, known, script });
  assert.deepEqual([result.errors, result.unused], [[], {}]);
  return result;
}
const readsOf = (result, pid) => result.calls.filter(([asked]) => asked === pid).map(([, kind]) => kind).join(' ');

test('a row holds one pid\'s own reads, taken in an order that cannot hand an ended process a later process\'s facts', { timeout: 60000 }, () => {
  const result = scripted({
    // An ordinary live process: two reads, and nothing else is asked.
    21: reading.created,
    // Ended set-uid process: the process table is asked last and believed, and no path is read.
    22: reading.ended,
    // Not there, not readable, and the process table shows it as running: the
    // pid passed on between the reads, or it is still on its way out. Not ended.
    23: [read.noInfo(ESRCH), read.noUsage(EPERM), read.record(1, 23, 0, 0, 2)],
    // The same with no record at all.
    24: [read.noInfo(ESRCH), read.noUsage(EPERM), read.record()],
    // Not there, but usage answers, and the process table says ended: an ordinary ended process.
    25: [read.noInfo(ESRCH), read.usage(9, 60 * MB, 0), read.record(101, 100, OWNER, OWNER, ZOMBIE)],
    // The same reads where the pid passed to a new process in between: the
    // usage is the new one's, and the process table shows it running. Not ended.
    30: [read.noInfo(ESRCH), read.usage(77, 300 * MB, 280 * MB), read.record(1, 30, OWNER, OWNER, 2)],
    // And where nothing holds the pid by the time the process table is asked.
    31: [read.noInfo(ESRCH), read.usage(9, 60 * MB, 0), read.record()],
    // Exiting (see the sampler): the cached usage carries an exit time, the process table still shows it running.
    32: [read.noInfo(ESRCH), read.exitingUsage(9, 60 * MB, 0, 12345), read.record(101, 100, OWNER, OWNER, 2)],
    // Read right after it: nothing of its exit time shows.
    33: reading.gone,
    // There, with usage that says it is not: on its way out.
    26: [read.info(101, 100, OWNER, OWNER), read.noUsage(ESRCH)],
    // Gone between being listed and being read. Read right after two readable ones: nothing of theirs shows.
    27: reading.gone,
    // Unreadable for other reasons: the process table is not asked.
    28: [read.noInfo(EPERM), read.noUsage(EPERM)],
    29: [read.noInfo(ESRCH), read.noUsage(13)],
  }, { scans: [[21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33]] });
  assert.deepEqual(result.scans[0].rows, [
    rowOf.created(21),
    rowOf.ended(22),
    `23 0 0 0 0 0 0 0 ${ESRCH} ${EPERM} 0 0 -`,
    `24 0 0 0 0 0 0 0 ${ESRCH} ${EPERM} 0 0 -`,
    `25 101 100 ${OWNER} ${ZOMBIE} 9 ${60 * MB} 0 0 0 ${OWNER} 0 -`,
    `26 101 100 ${OWNER} 2 0 0 0 0 ${ESRCH} ${OWNER} 0 -`,
    rowOf.gone(27),
    `28 0 0 0 0 0 0 0 ${EPERM} ${EPERM} 0 0 -`,
    `29 0 0 0 0 0 0 0 ${ESRCH} 13 0 0 -`,
    `30 0 0 0 0 77 ${300 * MB} ${280 * MB} ${ESRCH} 0 0 0 -`,
    `31 0 0 0 0 9 ${60 * MB} 0 ${ESRCH} 0 0 0 -`,
    // Exiting: libproc no longer describes it, its usage carries an exit time, and the process table does not say ended.
    `32 0 0 0 0 9 ${60 * MB} 0 ${ESRCH} 0 0 1 -`,
    // An exit time is reported only from this pid's own successful usage read.
    `33 0 0 0 0 0 0 0 ${ESRCH} ${ESRCH} 0 0 -`,
  ]);
  assert.deepEqual([21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33].map(pid => readsOf(result, pid)), ['info usage', 'info usage record', 'info usage record',
    'info usage record', 'info usage record', 'info usage', 'info usage', 'info usage', 'info usage', 'info usage record', 'info usage record',
    'info usage record', 'info usage']);
  // None of these can be in transition, so nothing was read twice and nothing is remembered.
  assert.deepEqual([result.scans[0].pauses, result.scans[0].remembered], [[], {}]);
  // The guard takes exactly two of these rows as ended.
  assert.deepEqual(result.scans[0].rows.map(parseRow).filter(item => item.infoError === 0 && item.status === ZOMBIE).map(item => item.pid), [22, 25]);
  // And exactly one as exiting, which is not ended.
  assert.deepEqual(result.scans[0].rows.map(parseRow).filter(item => item.exiting).map(item => item.pid), [32]);
});

test('the sampler reads a process in transition again until two readings agree, and reports the last one whatever it is', { timeout: 60000 }, () => {
  const pauses = [0.001, 0.001, 0.002];
  const settle = (...states) => {
    const result = scripted({ 7: states.flatMap(state => reading[state]) });
    return { row: result.scans[0].rows[0], pauses: result.scans[0].pauses, remembered: result.scans[0].remembered[7] || null };
  };
  // An ordinary row is read once.
  assert.deepEqual(settle('created'), { row: rowOf.created(7), pauses: [], remembered: null });
  // The tool, seen for the first time: read once more, a millisecond later.
  assert.deepEqual(settle('tool', 'tool'), { row: rowOf.tool(7), pauses: pauses.slice(0, 1), remembered: rowOf.tool(7) });
  // Caught while starting, at every point of it.
  assert.deepEqual(settle('changingOwner', 'starting', 'tool', 'tool'), { row: rowOf.tool(7), pauses, remembered: rowOf.tool(7) });
  assert.deepEqual(settle('starting', 'tool', 'tool'), { row: rowOf.tool(7), pauses: pauses.slice(0, 2), remembered: rowOf.tool(7) });
  // Caught while ending: once it has ended, or is gone, there is nothing left to wait for.
  assert.deepEqual(settle('ending', 'ended'), { row: rowOf.ended(7), pauses: pauses.slice(0, 1), remembered: null });
  assert.deepEqual(settle('tool', 'ending', 'gone'), { row: rowOf.gone(7), pauses: pauses.slice(0, 2), remembered: null });
  assert.deepEqual(settle('starting', 'gone'), { row: rowOf.gone(7), pauses: pauses.slice(0, 1), remembered: null });
  // A state that stays is reported as it is, also one the guard will stop the
  // run for: another set-uid tool, or a ps that has not finished starting.
  assert.deepEqual(settle('otherTool', 'otherTool'), { row: rowOf.otherTool(7), pauses: pauses.slice(0, 1), remembered: rowOf.otherTool(7) });
  assert.deepEqual(settle('starting', 'starting'), { row: rowOf.starting(7), pauses: pauses.slice(0, 1), remembered: rowOf.starting(7) });
  // Never the same twice: every pause is used, no more, and the last reading is the row.
  assert.deepEqual(settle('tool', 'otherTool', 'tool', 'otherTool'), { row: rowOf.otherTool(7), pauses, remembered: rowOf.otherTool(7) });
  assert.deepEqual(settle('starting', 'tool', 'starting', 'ending'), { row: rowOf.ending(7), pauses, remembered: rowOf.ending(7) });
  // What this gives up, stated as a test: a process that could not be read at
  // first and can be read a millisecond later reaches the guard as readable.
  assert.deepEqual(settle('otherTool', 'created'), { row: rowOf.created(7), pauses: pauses.slice(0, 1), remembered: null });

  // Any difference counts: another parent, group or owner, or an error.
  const moved = [read.info(1, 100, 0, OWNER), read.noUsage(EPERM), read.path('/bin/ps')];
  const regrouped = [read.info(101, 7, 0, OWNER), read.noUsage(EPERM), read.path('/bin/ps')];
  const otherOwner = [read.info(101, 100, 502, OWNER), read.noUsage(EPERM), read.path('/bin/ps')];
  for (const [changed, text] of [[moved, `7 1 100 0 2 0 0 0 0 ${EPERM} ${OWNER} 0 /bin/ps`], [regrouped, `7 101 7 0 2 0 0 0 0 ${EPERM} ${OWNER} 0 /bin/ps`],
    [otherOwner, `7 101 100 502 2 0 0 0 0 ${EPERM} ${OWNER} 0 /bin/ps`]]) {
    const result = scripted({ 7: [...reading.tool, ...changed, ...changed] });
    assert.deepEqual([result.scans[0].rows, result.scans[0].pauses], [[text], pauses.slice(0, 2)]);
  }

  // A child of the guard, which is where the test runner is, is never read
  // again: the guard gets its first reading, unreadable or not.
  const runner = [read.info(GUARD, 7, 0, OWNER), read.noUsage(EPERM), read.path('/usr/bin/top')];
  const first = scripted({ 7: runner });
  assert.deepEqual([first.scans[0].rows, first.scans[0].pauses, first.scans[0].remembered], [[`7 ${GUARD} 7 0 2 0 0 0 0 ${EPERM} ${OWNER} 0 /usr/bin/top`], [], {}]);
  // Nor is a process another user started.
  const foreign = scripted({ 7: [read.info(101, 100, 0, 0), read.noUsage(EPERM)] });
  assert.deepEqual([foreign.scans[0].rows, foreign.scans[0].pauses], [[`7 101 100 0 2 0 0 0 0 ${EPERM} 0 0 -`], []]);

  // Several at once share the waits, and each is read until it agrees with itself.
  const together = scripted({ 7: [...reading.tool, ...reading.tool], 8: [...reading.starting, ...reading.tool, ...reading.tool], 9: reading.created });
  assert.deepEqual([together.scans[0].rows, together.scans[0].pauses], [[rowOf.tool(7), rowOf.tool(8), rowOf.created(9)], pauses.slice(0, 2)]);
  assert.deepEqual([7, 8, 9].map(pid => readsOf(together, pid).split(' ').filter(kind => kind === 'info').length), [2, 3, 1]);

  // From scan to scan. What the last scan reported the same way is not read
  // again; that is all the earlier row is used for.
  const steady = scripted({ 7: [...reading.tool, ...reading.tool, ...reading.tool] }, { scans: [[7], [7]] });
  assert.deepEqual(steady.scans.map(scan => [scan.rows[0], scan.pauses]), [[rowOf.tool(7), pauses.slice(0, 1)], [rowOf.tool(7), []]]);
  assert.deepEqual(scripted({ 7: reading.tool }, { known: { 7: rowOf.tool(7) } }).scans[0].pauses, []);
  // Reported differently before: read again, and the fresh readings are the row.
  const changed = scripted({ 7: [...reading.otherTool, ...reading.otherTool] }, { known: { 7: rowOf.tool(7) } });
  assert.deepEqual([changed.scans[0].rows, changed.scans[0].pauses], [[rowOf.otherTool(7)], pauses.slice(0, 1)]);
  // The pid passes to an ordinary process and later to a ps again: nothing of the first ps is remembered by then.
  const reuse = scripted({ 7: [...reading.tool, ...reading.tool, ...reading.created, ...reading.tool, ...reading.tool] }, { scans: [[7], [7], [7]] });
  assert.deepEqual(reuse.scans.map(scan => [scan.rows[0], scan.pauses.length, Object.keys(scan.remembered).length]),
    [[rowOf.tool(7), 1, 1], [rowOf.created(7), 0, 0], [rowOf.tool(7), 1, 1]]);
  // Not listed any more: forgotten.
  const absent = scripted({ 7: [...reading.tool, ...reading.tool], 8: reading.created }, { scans: [[7], [8]] });
  assert.deepEqual(absent.scans.map(scan => scan.remembered), [{ 7: rowOf.tool(7) }, {}]);

  // And a scan does this for a real ps: read twice when it is new, once when the last scan saw it the same way.
  const real = inSampler('scan');
  assert.equal(real.running, true);
  assert.deepEqual(real.first, real.second);
  assert.equal(real.first.length, 1);
  if (psIsSetUid) {
    assert.equal(parseRow(real.first[0]).path, SYSTEM_TOOL.path);
    assert.deepEqual(real.reads, [2, 1]);
    assert.equal(real.remembered, real.first[0]);
  } else {
    assert.deepEqual(real.reads, [1, 1]);
  }
});

for (const [mode, what] of [['sleep', 'an ordinary child'], ['ps', 'a system ps']]) {
  test(`a run in which ${what} that the guard has seen ends and waits to be collected passes`, { timeout: 60000 }, async t => {
    const { bystanderSurvived } = scenario(t);
    const result = await startGuard([uncollected], { CRATE_GUARD_FIXTURE_MODE: mode }).done;
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^ok 1 - an ended ${mode} waits to be collected$`, 'm'));
    assert.doesNotMatch(result.stderr, /CANNOT READ|LOST SIGHT|INCOMPLETE|EXCEEDED|left \d+ of its processes/);
    assert.equal(/assumed 32 MB/.test(result.stderr), mode === 'ps' && psIsSetUid);
    assert.equal(bystanderSurvived(), true);
  });
}

test('a run whose tests start the system ps over and over passes, and the summary says what was assumed', { timeout: 60000 }, async t => {
  const { bystanderSurvived } = scenario(t);
  const result = await startGuard([systemPs]).done;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^ok 1 - lists processes with the system ps, repeatedly$/m);
  assert.doesNotMatch(result.stderr, /CANNOT READ|LOST SIGHT|INCOMPLETE|EXCEEDED/);
  const assumed = /; these figures include an assumed 32 MB, not a measurement, for each \/bin\/ps the guard could not read \(let through (\d+) times, at most (\d+) samples in a row and [\d.]+ s for any one\)$/m.exec(result.stderr);
  if (psIsSetUid) {
    assert.ok(assumed, result.stderr);
    assert.ok(Number(assumed[1]) >= 1 && Number(assumed[2]) <= SYSTEM_TOOL.samples, assumed[0]);
  } else {
    assert.equal(assumed, null, 'a ps this user can read is measured like anything else');
  }
  assert.equal(bystanderSurvived(), true);
});

test('a process that reads as the system ps but does not end is stopped with the run after its allowance', { timeout: 60000 }, async t => {
  const { environment, ready, allGone, bystanderSurvived } = scenario(t);
  const run = startGuard([descendants], { ...environment('idle'), CRATE_GUARD_FAULT: 'system-tool:nested' }, faultyGuard);
  await ready();
  const result = await run.done;
  assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
  const stopped = /run-tests: GUARD CANNOT READ PROCESS \d+ OF THE RUN after ([\d.]+) s \(errno 1, (\d+) samples in a row\)\. Its memory is unknown\./.exec(result.stderr);
  assert.ok(stopped, result.stderr);
  // Let through for its allowance and no longer: stopped by the clock (2 s) or by the count (40 samples), whichever came first.
  assert.ok(Number(stopped[1]) >= 1.5 && Number(stopped[1]) < 10, `stopped after ${stopped[1]} s`);
  assert.ok(Number(stopped[2]) > 1 && Number(stopped[2]) <= SYSTEM_TOOL.samples + 1, `after ${stopped[2]} samples`);
  assert.match(result.stderr, /these figures include an assumed 32 MB, not a measurement, for each \/bin\/ps the guard could not read/);
  // It was in the runner's group, so the stop reached it with everything else.
  assert.match(result.stderr, /run-tests: Every process of the run has ended\./);
  await allGone([...treeRoles, 'ready']);
  assert.equal(bystanderSurvived(), true);
});

test('a process that reads as another set-uid tool stops the run at once', { timeout: 60000 }, async t => {
  const { environment, allGone, bystanderSurvived } = scenario(t);
  const result = await startGuard([descendants], { ...environment('idle'), CRATE_GUARD_FAULT: 'other-tool:nested' }, faultyGuard).done;
  assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
  assert.match(result.stderr, /run-tests: GUARD CANNOT READ PROCESS \d+ OF THE RUN after [\d.]+ s \(errno 1, 1 samples in a row\)\. Its memory is unknown\./);
  assert.doesNotMatch(result.stderr, /assumed 32 MB/);
  assert.match(result.stderr, /run-tests: Every process of the run has ended\./);
  assert.ok(result.seconds < 15, `took ${result.seconds} s`);
  await allGone(['nested', 'nested-child', 'short-lived', 'ready']);
  assert.equal(bystanderSurvived(), true);
});

test('a process that reads as the system ps and outlives the run outside its group keeps the run from passing', { timeout: 60000 }, async t => {
  const { environment, stillThere, bystanderSurvived } = scenario(t);
  const result = await startGuard([descendants], { ...environment('leave'), CRATE_GUARD_FAULT: 'system-tool:detached' }, faultyGuard).done;
  assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
  assert.match(result.stderr, /run-tests: Not every process of the run is confirmed to have ended\./);
  assert.doesNotMatch(result.stderr, /Every process of the run has ended/);
  // Not identified, so not signalled by pid: it is still there, and this test ends it.
  assert.equal(stillThere('detached'), true);
  assert.equal(bystanderSurvived(), true);
});

// A scan that cannot read a process of the run does not lose its say because
// the run ended, or a signal arrived, while its answer was on the way.
for (const [fault, mode, what] of [
  ['unreadable-then-gone:nested', 'brief', 'and that is gone before the guard looks again'],
  ['unreadable-as-run-ends:nested', 'lasting', 'and that the run leaves behind'],
  ['unreadable-right-after-run:nested', 'lasting', 'in the one scan it makes right after the run has ended'],
]) {
  test(`a process the guard cannot read as the run ends, ${what}, turns a passing run into exit 125`, { timeout: 60000 }, async t => {
    const { environment, allGone, bystanderSurvived } = scenario(t);
    const result = await startGuard([endsWithChild], { ...environment(mode), CRATE_GUARD_FAULT: fault }, faultyGuard).done;
    assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
    assert.match(result.stdout, /^ok 1 - passes while its child is still running$/m);
    assert.match(result.stderr, /run-tests: GUARD CANNOT READ PROCESS \d+ OF THE RUN after [\d.]+ s \(errno 1, 1 samples in a row\)\. Its memory is unknown\./);
    assert.match(result.stderr, /run-tests: The test run had ended by then, with exit status 0\. Exit status 125 replaces it\./);
    assert.match(result.stderr, /run-tests: Stopping the test run \((\d) processes\)\.\nrun-tests: Every process of the run has ended\./);
    assert.doesNotMatch(result.stderr, /left \d+ of its processes running/);
    await allGone(['nested']);
    assert.equal(bystanderSurvived(), true);
  });
}

test('a process the guard cannot read, seen as a signal arrives, ends the run with exit 125 and not with the signal\'s status', { timeout: 60000 }, async t => {
  const { environment, ready, allGone, bystanderSurvived } = scenario(t);
  const run = startGuard([descendants], { ...environment('idle'), CRATE_GUARD_FAULT: 'unreadable-as-signal-arrives:nested' }, faultyGuard);
  await ready();
  // By now the scan that could not read it is on its way to the guard, and stays there until the signal.
  await new Promise(resolve => { setTimeout(resolve, 500); });
  run.signal('SIGTERM');
  const result = await run.done;
  assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
  assert.match(result.stderr, /run-tests: GUARD CANNOT READ PROCESS \d+ OF THE RUN after [\d.]+ s \(errno 1, 1 samples in a row\)\. Its memory is unknown\./);
  assert.match(result.stderr, /run-tests: SIGTERM had arrived by then\. Exit status 125 replaces 143\./);
  assert.doesNotMatch(result.stderr, /Received SIGTERM/);
  assert.match(result.stderr, /run-tests: Every process of the run has ended\./);
  await allGone([...treeRoles, 'ready']);
  assert.equal(bystanderSurvived(), true);
});

for (const [name, status] of [['SIGTERM', 143], ['SIGINT', 130]]) {
  test(`${name} to the guard ends the whole run and is reported as ${status}`, { timeout: 60000 }, async t => {
    const { environment, ready, allGone, bystanderSurvived } = scenario(t);
    const run = startGuard([descendants], environment('idle'));
    await ready();
    const samplers = samplersOf(run.pid);
    assert.equal(samplers.length, 2, 'the guard runs a sampler and keeps one standing by');
    run.signal(name);
    const result = await run.done;
    assert.equal(result.code, status, result.stderr);
    assert.match(result.stderr, new RegExp(`run-tests: Received ${name} after [\\d.]+ s; ending the test run\\.`));
    assert.match(result.stderr, /run-tests: Every process of the run has ended\./);
    await allGone([...treeRoles, 'ready']);
    for (const sampler of samplers) assert.equal(isOurs(sampler, 'run-tests-sampler.py'), false, 'the samplers ended with the guard');
    assert.equal(bystanderSurvived(), true);
  });
}

test('a second signal skips the wait for a process that ignores the first', { timeout: 60000 }, async t => {
  const { environment, ready, stillThere, allGone, bystanderSurvived } = scenario(t);
  const run = startGuard([descendants], environment('idle', true));
  await ready();
  run.signal('SIGTERM');
  await new Promise(resolve => { setTimeout(resolve, 400); });
  assert.equal(stillThere('stubborn'), true, 'the process that ignores SIGTERM is still there');
  const second = Date.now();
  run.signal('SIGTERM');
  const result = await run.done;
  assert.equal(result.code, 143, result.stderr);
  assert.match(result.stderr, /run-tests: Every process of the run has ended\./);
  assert.ok(Date.now() - second < 3000, 'did not wait out the grace period');
  await allGone([...treeRoles, 'stubborn', 'ready']);
  assert.equal(bystanderSurvived(), true);
});

test('a run that passes its deadline is stopped and reported as 124', { timeout: 60000 }, async t => {
  const { environment, ready, allGone, bystanderSurvived } = scenario(t);
  const run = startGuard(['--deadline-seconds=6', descendants], environment('idle'));
  await ready();
  const result = await run.done;
  assert.equal(result.code, EXIT_DEADLINE, result.stderr);
  assert.match(result.stderr, /run-tests: DEADLINE PASSED after [\d.]+ s \(limit 6 s\)\./);
  assert.ok(Number(/DEADLINE PASSED after ([\d.]+) s/.exec(result.stderr)[1]) > 6, result.stderr);
  assert.match(result.stderr, /run-tests: Every process of the run has ended\./);
  assert.ok(result.seconds < 18, `took ${result.seconds} s`);
  await allGone([...treeRoles, 'ready']);
  assert.equal(bystanderSurvived(), true);
});

test('a sampler that ends is reported as ended and gone for good, whichever way the guard notices first', { timeout: 60000 }, async () => {
  for (let round = 0; round < 12; round += 1) {
    const sampler = await startCheckedSampler();
    try {
      assert.ok((await sampler.scan()).length > 0);
      assert.equal(sampler.dead, false);
      assert.equal(signalOurs(sampler.pid, 'run-tests-sampler.py', 'SIGKILL'), true);
      // Asked at once, on the next turn, or a few milliseconds later: the exit
      // and the closed input can be noticed in either order.
      if (round % 3 === 1) await new Promise(resolve => { setImmediate(resolve); });
      if (round % 3 === 2) await new Promise(resolve => { setTimeout(resolve, round % 7); });
      const failure = await sampler.scan().then(() => null, error => error);
      assert.ok(failure, 'a scan of an ended sampler fails');
      assert.match(failure.message, /^sampler ended \((exited: SIGKILL|closed its input)\)$/);
      assert.equal(sampler.dead, true);
      // It stays failed, in the same words, and nothing is sent to it again.
      const again = await sampler.signalProcesses('SIGCONT', [{ pid: process.pid, start: '1' }]).then(() => null, error => error);
      assert.equal(again && again.message, failure.message);
    } finally {
      sampler.stop();
    }
  }
});

// How the guard words the loss of the sampler in use. A sampler that ends is
// noticed as its exit or as its closed input, whichever the guard sees first;
// one that hangs, as a request that got no answer.
const samplerLoss = [
  ['end', 'SIGKILL', /sampler ended \((exited: SIGKILL|closed its input)\)\./],
  ['hang', 'SIGSTOP', /sampler did not answer within 1000 ms\./],
];
for (const [how, name, wording] of samplerLoss) {
  test(`when its samplers ${how}, the guard stops the run with a new one rather than leave it unwatched`, { timeout: 60000 }, async t => {
    const { environment, ready, allGone, bystanderSurvived } = scenario(t);
    const run = startGuard([descendants], environment('idle'));
    await ready();
    const samplers = samplersOf(run.pid);
    assert.equal(samplers.length, 2);
    for (const sampler of samplers) assert.equal(signalOurs(sampler, 'run-tests-sampler.py', name), true, 'signalled a sampler of the guard');
    const result = await run.done;
    assert.equal(result.code, EXIT_GUARD_FAILURE, result.stderr);
    assert.match(result.stderr, new RegExp(`run-tests: GUARD LOST SIGHT OF THE RUN after [\\d.]+ s: ${wording.source}`));
    assert.match(result.stderr, /run-tests: Stopping the test run \(\d+ processes\)\./);
    assert.match(result.stderr, /run-tests: Every process of the run has ended\./);
    assert.ok(result.seconds < 20, `took ${result.seconds} s`);
    await allGone([...treeRoles, 'ready']);
    await waitFor(() => samplers.every(sampler => !isOurs(sampler, 'run-tests-sampler.py')), 3000, 'the old samplers to be gone');
    assert.equal(bystanderSurvived(), true);
  });
}

test('a bad limit or deadline is refused before anything runs', { timeout: 60000 }, async () => {
  for (const option of ['--memory-limit-mb=0', '--memory-limit-mb=lots', '--total-memory-limit-mb=-5', '--deadline-seconds=1.5', '--deadline-seconds=0']) {
    const result = await startGuard([option, outcomes]).done;
    assert.equal(result.code, 2, option);
    assert.match(result.stderr, /must be a whole number of (megabytes|seconds)/);
    assert.equal(result.stdout, '');
  }
  const environment = await startGuard([outcomes], { CRATE_TEST_DEADLINE_SECONDS: 'soon' }).done;
  assert.equal(environment.code, 2);
  assert.match(environment.stderr, /CRATE_TEST_DEADLINE_SECONDS must be a whole number of seconds, got "soon"/);
  assert.equal((await startGuard(['--memory-limit-mb=', outcomes]).done).code, 0, 'an empty value keeps the default');
});
