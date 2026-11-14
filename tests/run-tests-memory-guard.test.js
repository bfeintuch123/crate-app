'use strict';
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const assert = require('./bounded-assert');
const {
  parseArguments, parseRow, createOwnership, createGuard, measureRun, startCheckedSampler, UsageError, TIMING,
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
  if (seed) ownership.update(seed, true);
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
  assert.deepEqual(pids(ownership.update([...system, ...stranger, ...run, inGroupOrphan], true)), [100, 101, 102, 103, 104, 105]);
  assert.equal(ownership.groupMember(true).pid, RUNNER);
  assert.equal(ownership.groupMember(false), null);
  assert.equal(ownership.runnerStart, 'started-100');

  // The test file is gone. Its children now belong to pid 1, the detached ones
  // in a group of their own; they stay in the run because they were identified in it.
  const orphaned = [row(RUNNER, GUARD, RUNNER), row(102, 1, RUNNER), row(103, 1, 103), row(104, 103, 103), inGroupOrphan];
  assert.deepEqual(pids(ownership.update([...system, ...stranger, ...orphaned], true)), [100, 102, 103, 104, 105]);

  // The runner is gone too. Its group id no longer shows anything: a process
  // in that group that was never identified is not taken to be the run's.
  const unseen = row(106, 1, RUNNER);
  const afterRunner = [row(102, 1, RUNNER), row(103, 1, 103), row(104, 103, 103), inGroupOrphan, unseen, row(107, 104, 103)];
  assert.deepEqual(pids(ownership.update([...system, ...stranger, ...afterRunner], false)), [102, 103, 104, 105, 107]);
  assert.equal(ownership.groupMember(false), null);
});

test('a process missing from one scan is still the run\'s when it shows up again with the same start time', () => {
  const ownership = newOwnership();
  ownership.update([...system, ...run], true);
  // The detached pair is adopted by pid 1 and, for one scan, not listed at all.
  assert.deepEqual(pids(ownership.update([...system, row(RUNNER, GUARD, RUNNER)], true)), [100]);
  assert.deepEqual(pids(ownership.update([...system, row(RUNNER, GUARD, RUNNER), row(103, 1, 103), row(104, 1, 103)], true)), [100, 103, 104]);
});

test('a pid is the run\'s only together with its start time', () => {
  const ownership = newOwnership();
  ownership.update([...system, ...run], true);
  // 103 ended and the system gave its pid to an unrelated process, which has a
  // child of its own. The run's old 104 passed to pid 1 and is still the run's.
  const reused = [row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER), row(102, 101, RUNNER),
    row(103, 1, 103, { start: 'someone-else' }), row(300, 103, 103), row(104, 1, 104)];
  assert.deepEqual(pids(ownership.update([...system, ...reused], true)), [100, 101, 102, 104]);
  // The same for the runner's own pid once the runner is gone.
  const runnerReused = [row(RUNNER, 1, RUNNER, { start: 'someone-else' }), row(301, RUNNER, RUNNER), row(104, 1, 104)];
  assert.deepEqual(pids(ownership.update([...system, ...runnerReused], false)), [104]);
});

test('the runner is the root of the run by its own pid from the first scan, readable or not', () => {
  // Its start time and memory cannot be read. It is the root all the same, with
  // everything it started, and the guard cannot watch the run.
  const unreadable = newOwnership();
  const fromTheStart = [...system, unreadableRow(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER), row(103, 101, 103)];
  assert.deepEqual(pids(unreadable.update(fromTheStart, true)), [100, 101, 103]);
  assert.deepEqual(unreadable.readFailure(), { pid: RUNNER, problem: 'unreadable', errno: EPERM, samples: 1 });
  assert.equal(unreadable.runnerStart, null);
  assert.equal(unreadable.groupMember(true), null);
  assert.equal(unreadable.groupUsable, true);

  // Nothing but its pid can be read.
  const opaque = newOwnership();
  const onlyPid = row(RUNNER, 0, 0, { status: 0, start: '0', megabytes: 0, infoError: EPERM, usageError: EPERM });
  assert.deepEqual(pids(opaque.update([...system, onlyPid, row(101, RUNNER, RUNNER)], true)), [100, 101]);
  assert.deepEqual(opaque.readFailure(), { pid: RUNNER, problem: 'unreadable', errno: EPERM, samples: 1 });

  // Unreadable the way an ending process is: tolerated for a few samples only.
  const ending = newOwnership();
  for (let sample = 1; sample <= UNREADABLE_SAMPLES; sample += 1) {
    ending.update([...system, unreadableRow(RUNNER, GUARD, RUNNER, ESRCH)], true);
    assert.equal(ending.readFailure(), null, `sample ${sample}`);
  }
  ending.update([...system, unreadableRow(RUNNER, GUARD, RUNNER, ESRCH)], true);
  assert.deepEqual(ending.readFailure(), { pid: RUNNER, problem: 'unreadable', errno: ESRCH, samples: UNREADABLE_SAMPLES + 1 });
});

test('a runner that exists and is not listed, or is listed as something this guard did not start, makes the guard give up', () => {
  const missing = newOwnership();
  for (let sample = 1; sample <= UNREADABLE_SAMPLES; sample += 1) {
    assert.deepEqual(pids(missing.update([...system, ...stranger], true)), []);
    assert.equal(missing.readFailure(), null, `sample ${sample}`);
  }
  missing.update([...system, ...stranger], true);
  assert.deepEqual(missing.readFailure(), { pid: RUNNER, problem: 'missing', errno: ESRCH, samples: UNREADABLE_SAMPLES + 1 });
  // Listed again: watched again.
  assert.deepEqual(pids(missing.update([...system, ...run], true)), [100, 101, 102, 103, 104]);
  assert.equal(missing.readFailure(), null);

  const inconsistent = { pid: RUNNER, problem: 'inconsistent', errno: 0, samples: 1 };
  const notOurChild = newOwnership();
  notOurChild.update([...system, row(RUNNER, 1, RUNNER), row(101, RUNNER, RUNNER)], true);
  assert.deepEqual(notOurChild.readFailure(), inconsistent);
  assert.equal(notOurChild.groupMember(true), null);

  const otherGroup = newOwnership();
  otherGroup.update([...system, row(RUNNER, GUARD, 555)], true);
  assert.deepEqual(otherGroup.readFailure(), inconsistent);
  assert.equal(otherGroup.groupUsable, false, 'its group is not signalled by number');

  const restarted = newOwnership();
  restarted.update([...system, ...run], true);
  assert.equal(restarted.readFailure(), null);
  restarted.update([...system, row(RUNNER, GUARD, RUNNER, { start: 'another-start' })], true);
  assert.deepEqual(restarted.readFailure(), inconsistent);

  // A runner that has ended and waits to be collected is neither.
  const ended = newOwnership();
  ended.update([...system, ...run], true);
  ended.update([...system, row(RUNNER, GUARD, RUNNER, { status: ZOMBIE, start: '0', megabytes: 0, usageError: ESRCH })], true);
  assert.equal(ended.readFailure(), null);
});

test('once the guard has collected the runner, a process holding the runner\'s old pid is nothing to the run', () => {
  const ownership = newOwnership();
  ownership.update([...system, ...run], true);
  const reused = [row(RUNNER, 1, RUNNER, { start: 'someone-else' }), row(301, RUNNER, RUNNER), unreadableRow(302, RUNNER, RUNNER)];
  assert.deepEqual(pids(ownership.update([...system, ...reused], false)), []);
  assert.equal(ownership.readFailure(), null);
  assert.equal(ownership.groupMember(false), null);
  // Never having been listed is no failure either, once the runner is collected.
  const never = newOwnership();
  for (let sample = 0; sample < UNREADABLE_SAMPLES + 2; sample += 1) never.update([...system], false);
  assert.equal(never.readFailure(), null);
  // The guard and its own helpers are not part of the run, whatever the table says.
  const odd = [row(1, 0, 1), row(GUARD, RUNNER, RUNNER), row(SAMPLER, RUNNER, RUNNER), row(STANDBY, RUNNER, RUNNER), row(RUNNER, GUARD, RUNNER)];
  assert.deepEqual(pids(newOwnership().update(odd, true)), [100]);
});

test('a process of the run that cannot be read is kept, counted, and makes the guard give up', () => {
  const ownership = newOwnership();
  ownership.update([...system, ...run], true);
  assert.equal(ownership.readFailure(), null);

  // The detached process becomes unreadable for a reason other than ending.
  // It is not dropped, and neither is what it started.
  const blocked = [row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER), unreadableRow(103, 1, 103), row(104, 103, 103)];
  assert.deepEqual(pids(ownership.update([...system, ...blocked], true)), [100, 101, 103, 104]);
  assert.deepEqual(ownership.readFailure(), { pid: 103, problem: 'unreadable', errno: EPERM, samples: 1 });
  // Readable again: no failure.
  ownership.update([...system, row(RUNNER, GUARD, RUNNER), row(103, 1, 103), row(104, 103, 103)], true);
  assert.equal(ownership.readFailure(), null);

  // Started by the run and never readable at all.
  const born = [row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER), unreadableRow(108, 101, 108)];
  assert.deepEqual(pids(ownership.update([...system, ...born], true)), [100, 101, 108]);
  assert.deepEqual(ownership.readFailure(), { pid: 108, problem: 'unreadable', errno: EPERM, samples: 1 });

  // Nothing but the pid could be read (parent, group and state unknown too).
  const opaque = [row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER), row(108, 0, 0, { status: 0, start: '0', megabytes: 0, infoError: EPERM, usageError: EPERM })];
  assert.deepEqual(pids(ownership.update([...system, ...opaque], true)), [100, 101, 108]);
  assert.deepEqual(ownership.readFailure(), { pid: 108, problem: 'unreadable', errno: EPERM, samples: 2 });
});

test('a process that is ending may be unreadable for a few samples, and no longer', () => {
  const ownership = newOwnership();
  ownership.update([...system, ...run], true);
  const ending = [...system, row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER), unreadableRow(102, 101, RUNNER, ESRCH)];
  for (let sample = 1; sample <= UNREADABLE_SAMPLES; sample += 1) {
    ownership.update(ending, true);
    assert.equal(ownership.readFailure(), null, `sample ${sample}`);
  }
  ownership.update(ending, true);
  assert.deepEqual(ownership.readFailure(), { pid: 102, problem: 'unreadable', errno: ESRCH, samples: UNREADABLE_SAMPLES + 1 });
  // Gone: nothing to read, nothing wrong.
  ownership.update([...system, row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER)], true);
  assert.equal(ownership.readFailure(), null);
  // A process that has ended and waits to be collected has no memory to read.
  ownership.update([...system, row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER, { status: ZOMBIE, start: '0', megabytes: 0, usageError: ESRCH })], true);
  ownership.update([...system, row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER, { status: ZOMBIE, start: '0', megabytes: 0, usageError: EPERM })], true);
  assert.equal(ownership.readFailure(), null);
});

// --- the system's own ps, which this user cannot read

const withPs = (...extra) => [...system, ...stranger, ...run, ...extra];
const unreadable = (pid, samples = 1, errno = EPERM) => ({ pid, problem: 'unreadable', errno, samples });

test('the system ps, started by the run, is let through and counted at an assumed size', () => {
  const ownership = newOwnership();
  const owned = ownership.update(withPs(psRow(110, 101, RUNNER)), true);
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
  assert.equal(newOwnership().update(withPs(psRow(110, 104, 110)), true).get(110).assumed, true);
  // An ordinary run has none.
  const plain = newOwnership();
  plain.update(withPs(), true);
  assert.deepEqual(plain.toolStats, { samples: 0, longestSamples: 0, longestMilliseconds: 0 });
});

test('anything that is not exactly the system ps for this user stops the run as before', () => {
  const failsClosed = (label, rows, errno = EPERM, pid = 110) => {
    const ownership = newOwnership();
    const owned = ownership.update(rows, true);
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
  asRoot.update(withPs(psRow(110, 101, RUNNER, { ruid: 0 })), true);
  assert.deepEqual(asRoot.readFailure(), unreadable(110));
  // Unreadable for exactly the reason a set-uid tool is, and otherwise readable.
  failsClosed('usage fails for another reason', withPs(psRow(110, 101, RUNNER, { usageError: 13 })), 13);
  // Parent, group and owners unreadable as well: such a row cannot be placed in
  // the run by this scan at all, only kept from the one before.
  const opaque = newOwnership();
  opaque.update(withPs(row(110, 101, RUNNER)), true);
  opaque.update(withPs(psRow(110, 101, RUNNER, { infoError: EPERM })), true);
  assert.deepEqual(opaque.readFailure(), unreadable(110));
  // The runner itself is never the tool.
  const asRunner = newOwnership();
  asRunner.update([...system, psRow(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER)], true);
  assert.deepEqual(asRunner.readFailure(), unreadable(RUNNER));
  // A ps that is ending (no such process) is not let through as the tool; it is the ordinary short grace.
  const ending = newOwnership();
  const gone = ending.update(withPs(psRow(110, 101, RUNNER, { usageError: ESRCH })), true);
  assert.equal(ending.readFailure(), null);
  assert.notEqual(gone.get(110).assumed, true);
  ending.update(withPs(psRow(110, 101, RUNNER)), true);
  for (let sample = 1; sample <= UNREADABLE_SAMPLES; sample += 1) {
    ending.update(withPs(psRow(110, 101, RUNNER, { usageError: ESRCH })), true);
    assert.equal(ending.readFailure(), null, 'let through, then ending: the grace counts the samples that said it was ending');
  }
  ending.update(withPs(psRow(110, 101, RUNNER, { usageError: ESRCH })), true);
  assert.deepEqual(ending.readFailure(), unreadable(110, UNREADABLE_SAMPLES + 3, ESRCH));
  // A ps that has ended and waits to be collected counts for nothing, for as long as that takes.
  const collected = newOwnership();
  collected.update(withPs(psRow(110, 101, RUNNER)), true);
  for (let sample = 0; sample < 3 * SYSTEM_TOOL.samples; sample += 1) {
    const ended = collected.update(withPs(psRow(110, 101, RUNNER, { status: ZOMBIE, path: null })), true);
    assert.equal(collected.readFailure(), null);
    assert.notEqual(ended.get(110).assumed, true);
    assert.equal(measureRun(ended).total, 5 * 10);
  }
  assert.equal(collected.toolStats.samples, 1);
});

test('a process that has ended teaches the guard no identity, and one known before stays known', () => {
  // An ended child of the run that no scan saw alive. Its row carries a start time.
  const ownership = newOwnership();
  assert.deepEqual(pids(ownership.update(withPs(row(110, 101, RUNNER, { status: ZOMBIE, start: 'someone' })), true)), [100, 101, 102, 103, 104, 110]);
  assert.equal(ownership.readFailure(), null);
  // Collected. A process that is tied to the run by nothing now holds that pid, with that very start time.
  const unrelated = row(110, 200, 200, { start: 'someone' });
  assert.deepEqual(pids(ownership.update(withPs(unrelated), true)), [100, 101, 102, 103, 104]);

  // A process the guard knew alive is still the run's when it has ended, wherever it now hangs.
  const known = newOwnership();
  known.update(withPs(row(110, 103, 110)), true);
  const ended = known.update([...system, ...stranger, row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER), row(110, 1, 110, { status: ZOMBIE })], true);
  assert.deepEqual(pids(ended), [100, 101, 110]);
  assert.equal(known.readFailure(), null);

  // What reads as ended is taken as ended only when its parent, group and state could be read.
  const unclear = newOwnership();
  unclear.update(withPs(unreadableRow(110, 101, RUNNER, ESRCH)), true);
  unclear.update(withPs(unreadableRow(110, 0, 0, EPERM)), true);
  assert.deepEqual(unclear.readFailure(), unreadable(110, 2));
  const stillUnclear = newOwnership();
  stillUnclear.update(withPs(unreadableRow(110, 101, RUNNER, ESRCH)), true);
  stillUnclear.update(withPs({ ...unreadableRow(110, 0, 0, EPERM), status: ZOMBIE, infoError: ESRCH }), true);
  assert.deepEqual(stillUnclear.readFailure(), unreadable(110, 2));
});

test('a process that has ended is left out of what the run holds, whatever size the system still reports for it', () => {
  const ownership = newOwnership();
  ownership.update(withPs(row(110, 101, RUNNER, { megabytes: 3000 }), row(111, 110, RUNNER, { megabytes: 70 })), true);
  // Ended, not collected: the same start time, and the resident size it had at the end. What it started lives on.
  const endedRow = row(110, 101, RUNNER, { status: ZOMBIE, megabytes: 3000 });
  const owned = ownership.update(withPs(endedRow, row(111, 1, RUNNER, { megabytes: 70 })), true);
  assert.deepEqual(pids(owned), [100, 101, 102, 103, 104, 110, 111]);
  assert.equal(ownership.readFailure(), null);
  assert.deepEqual([measureRun(owned).total, measureRun(owned).largest.pid], [5 * 10 + 70, 111]);
  // Nothing but ended processes: nothing held, and no largest process.
  assert.deepEqual(measureRun(new Map([[110, endedRow], [112, psRow(112, 101, RUNNER, { status: ZOMBIE, path: null })]])), { total: 0, largest: null });
  // Alive, it counts in full. So does a row that says "ended" where the state could not be read at all.
  assert.equal(measureRun(ownership.update(withPs(row(110, 101, RUNNER, { megabytes: 3000 })), true)).largest.pid, 110);
  assert.equal(measureRun(new Map([[110, { ...endedRow, infoError: ESRCH }]])).total, 3000);
  // A ps that is let through still counts at its assumed size.
  assert.equal(measureRun(newOwnership().update(withPs(psRow(110, 101, RUNNER)), true)).total, 5 * 10 + SYSTEM_TOOL.assumedMegabytes);
});

test('what an unreadable process started stays in the run when that process has ended', () => {
  // Scan 1: a ps started by the detached process, let through.
  const ownership = newOwnership();
  assert.equal(ownership.update(withPs(psRow(110, 103, 103)), true).get(110).assumed, true);
  // Scan 2 is not one instant. It read a new process while its parent, the
  // ps, was alive, and the ps after it had ended and after its own parent had
  // gone: the ps now hangs under pid 1, outside the runner's group. Nothing
  // but the ended ps ties the new process to the run.
  const rest = [...system, ...stranger, row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER), row(102, 101, RUNNER)];
  const endedPs = psRow(110, 1, 103, { status: ZOMBIE, path: null });
  const owned = ownership.update([...rest, endedPs, row(111, 110, 111, { megabytes: 70 })], true);
  assert.deepEqual(pids(owned), [100, 101, 102, 110, 111]);
  assert.equal(ownership.readFailure(), null);
  assert.equal(measureRun(owned).largest.pid, 111);
  assert.notEqual(owned.get(110).assumed, true);
  assert.equal(ownership.toolStats.samples, 1);
  // The ended ps is no evidence for letting another ps through.
  const strict = newOwnership();
  strict.update(withPs(psRow(110, 103, 103)), true);
  strict.update([...rest, endedPs, psRow(112, 110, 103)], true);
  assert.deepEqual(strict.readFailure(), unreadable(112));

  // Scan 3: the ps has been collected. The new process is known by now, whoever holds pid 110.
  assert.deepEqual(pids(ownership.update([...rest, row(111, 1, 111)], true)), [100, 101, 102, 111]);
  assert.deepEqual(pids(ownership.update([...rest, row(110, 200, 200, { start: 'someone-else' }), row(111, 1, 111)], true)), [100, 101, 102, 111]);
  // An unreadable stranger at that pid right after the ps is not assumed to be a stranger.
  const reused = newOwnership();
  reused.update(withPs(psRow(110, 103, 103)), true);
  reused.update([...rest, endedPs, row(111, 110, 111)], true);
  assert.deepEqual(pids(reused.update([...rest, unreadableRow(110, 200, 200), row(111, 1, 111)], true)), [100, 101, 102, 110, 111]);
  assert.deepEqual(reused.readFailure(), unreadable(110));
});

test('the system ps is let through only on this scan\'s own evidence that it belongs to the run', () => {
  // Scan 1: started by the detached process, in that process's group. Let through.
  const ownership = newOwnership();
  assert.equal(ownership.update(withPs(psRow(110, 103, 103)), true).get(110).assumed, true);
  // Scan 2: its parent is gone. It belongs to pid 1 now and is outside the
  // runner's group. All that ties it to the run is that pid 110 was in the run
  // a moment ago, and that is not enough: it stays in the run, unread.
  const orphaned = [...system, ...stranger, row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER), row(102, 101, RUNNER), psRow(110, 1, 103)];
  assert.deepEqual(pids(ownership.update(orphaned, true)), [100, 101, 102, 110]);
  assert.deepEqual(ownership.readFailure(), unreadable(110, 2));

  // Left behind inside the runner's group, in a scan that shows the runner: the group is evidence.
  const inGroup = newOwnership();
  inGroup.update(withPs(psRow(110, 102, RUNNER)), true);
  const stillGrouped = [...system, row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER), psRow(110, 1, RUNNER)];
  assert.equal(inGroup.update(stillGrouped, true).get(110).assumed, true);
  assert.equal(inGroup.readFailure(), null);
  // The same once the runner has been collected: the group shows nothing any more.
  assert.deepEqual(pids(inGroup.update([...system, psRow(110, 1, RUNNER)], false)), [110]);
  assert.deepEqual(inGroup.readFailure(), unreadable(110, 3));

  // A pid the run held, now held by an unrelated ps of the same user.
  const reused = newOwnership();
  reused.update(withPs(), true);
  const sameUsersPs = psRow(103, 1, 103);
  assert.deepEqual(pids(reused.update([...system, row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER), row(104, 1, 104), sameUsersPs], true)), [100, 101, 103, 104]);
  assert.deepEqual(reused.readFailure(), unreadable(103), 'in consecutive scans the guard cannot tell, and does not assume');
  // After a scan without that pid, it is simply somebody else's process.
  const later = newOwnership();
  later.update(withPs(), true);
  later.update([...system, row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER)], true);
  assert.deepEqual(pids(later.update([...system, row(RUNNER, GUARD, RUNNER), row(101, RUNNER, RUNNER), sameUsersPs, psRow(301, 200, 200)], true)), [100, 101]);
  assert.equal(later.readFailure(), null);
  assert.deepEqual(later.toolStats.samples, 0);

  // A process the run started that then became the system ps, as every ps does between being started and running.
  const becomes = newOwnership();
  becomes.update(withPs(row(110, 101, RUNNER)), true);
  assert.equal(becomes.update(withPs(psRow(110, 101, RUNNER)), true).get(110).assumed, true);
  assert.equal(becomes.readFailure(), null);
  // And one that was the system ps and now reports another executable.
  becomes.update(withPs(psRow(110, 101, RUNNER, { path: '/usr/bin/top' })), true);
  assert.deepEqual(becomes.readFailure(), unreadable(110, 2));
});

test('the system ps is let through for a bounded time, a bounded number of samples, and a bounded number at once', () => {
  // Samples: 40 in a row, not 41, however quickly they come.
  const clock = { now: 0 };
  const bySamples = newOwnership(clock);
  for (let sample = 1; sample <= SYSTEM_TOOL.samples; sample += 1) {
    clock.now += 1;
    assert.equal(bySamples.update(withPs(psRow(110, 101, RUNNER)), true).get(110).assumed, true, `sample ${sample}`);
    assert.equal(bySamples.readFailure(), null, `sample ${sample}`);
  }
  clock.now += 1;
  assert.notEqual(bySamples.update(withPs(psRow(110, 101, RUNNER)), true).get(110).assumed, true);
  assert.deepEqual(bySamples.readFailure(), unreadable(110, SYSTEM_TOOL.samples + 1));
  assert.deepEqual(bySamples.toolStats, { samples: SYSTEM_TOOL.samples, longestSamples: SYSTEM_TOOL.samples, longestMilliseconds: SYSTEM_TOOL.samples - 1 });

  // Time: two seconds from the first sample that saw it, however few samples that is.
  const slow = { now: 5000 };
  const byTime = newOwnership(slow);
  for (const at of [5000, 5900, 6800, 7000]) {
    slow.now = at;
    byTime.update(withPs(psRow(110, 101, RUNNER)), true);
    assert.equal(byTime.readFailure(), null, `at ${at} ms`);
  }
  slow.now = 7001;
  byTime.update(withPs(psRow(110, 101, RUNNER)), true);
  assert.deepEqual(byTime.readFailure(), unreadable(110, 5));
  // Scans that fail produce no sample, and give no extra time: the clock is not theirs to stop.
  const blind = { now: 0 };
  const acrossFailures = newOwnership(blind);
  acrossFailures.update(withPs(psRow(110, 101, RUNNER)), true);
  blind.now = SYSTEM_TOOL.milliseconds + 500; // several scans failed in between
  acrossFailures.update(withPs(psRow(110, 101, RUNNER)), true);
  assert.deepEqual(acrossFailures.readFailure(), unreadable(110, 2));
  // Each ps has its own allowance; a new one does not inherit the old one's.
  const fresh = { now: 0 };
  const oneAfterAnother = newOwnership(fresh);
  for (let pid = 300; pid < 300 + 3 * SYSTEM_TOOL.samples; pid += 1) {
    fresh.now += 60;
    oneAfterAnother.update(withPs(psRow(pid, 101, RUNNER)), true);
    assert.equal(oneAfterAnother.readFailure(), null);
  }
  assert.deepEqual(oneAfterAnother.toolStats, { samples: 3 * SYSTEM_TOOL.samples, longestSamples: 1, longestMilliseconds: 0 });

  // At once: eight, not nine.
  const several = count => Array.from({ length: count }, (_, index) => psRow(400 + index, 101, RUNNER));
  const eight = newOwnership();
  const ownedEight = eight.update(withPs(...several(SYSTEM_TOOL.atOnce)), true);
  assert.equal(eight.readFailure(), null);
  assert.equal(measureRun(ownedEight).total, 5 * 10 + SYSTEM_TOOL.atOnce * SYSTEM_TOOL.assumedMegabytes);
  const nine = newOwnership();
  nine.update(withPs(...several(SYSTEM_TOOL.atOnce + 1)), true);
  assert.deepEqual(nine.readFailure(), unreadable(400 + SYSTEM_TOOL.atOnce));
});

test('what the system ps started is judged on its own, like any other process of the run', () => {
  const heavy = newOwnership();
  const owned = heavy.update(withPs(psRow(110, 101, RUNNER), row(111, 110, RUNNER, { megabytes: 5000 })), true);
  assert.equal(heavy.readFailure(), null);
  assert.deepEqual([measureRun(owned).largest.pid, measureRun(owned).largest.megabytes], [111, 5000]);
  const unread = newOwnership();
  unread.update(withPs(psRow(110, 101, RUNNER), unreadableRow(111, 110, RUNNER)), true);
  assert.deepEqual(unread.readFailure(), unreadable(111));
  const another = newOwnership();
  another.update(withPs(psRow(110, 101, RUNNER), psRow(111, 110, RUNNER, { path: '/usr/bin/top' })), true);
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
  assert.deepEqual(parseRow('4242 100 100 501 2 98765432109876543210 1048576 3145728 0 0 501 -'), {
    pid: 4242, ppid: 100, pgid: 100, uid: 501, ruid: 501, status: 2, start: '98765432109876543210', megabytes: 3, infoError: 0, usageError: 0, path: null,
  });
  assert.equal(parseRow('4242 100 100 501 2 5 9437184 1048576 0 0 501 -').megabytes, 9);
  assert.deepEqual(parseRow('4242 0 0 0 0 0 0 0 3 1 0 -'), {
    pid: 4242, ppid: 0, pgid: 0, uid: 0, ruid: 0, status: 0, start: '0', megabytes: 0, infoError: 3, usageError: 1, path: null,
  });
  // The executable path arrives percent-encoded and is decoded exactly.
  assert.equal(parseRow('4242 100 100 0 2 0 0 0 0 1 501 /bin/ps').path, '/bin/ps');
  assert.equal(parseRow('4242 100 100 0 2 0 0 0 0 1 501 /Users/someone/My%20Tools/ps').path, '/Users/someone/My Tools/ps');
  assert.equal(parseRow('4242 100 100 0 2 0 0 0 0 1 501 /bin/ps%0A').path, '/bin/ps\n');
  for (const bad of ['', '4242 100 100 501 2 5 1 2 0 0 501 ', '4242 100 100 501 2 5 1 2 0 0 501', '4242 100 100 501 2 5 1 2 0 0', '4242 100 100 501 2 5 1 2 0 0 501 - -',
    'pid 100 100 501 2 5 1 2 0 0 501 -', '-1 100 100 501 2 5 1 2 0 0 501 -', '4242  100 100 501 2 5 1 2 0 0 501 -', '4242 100 100 501 2 5 1 2 0 0 501 -\r',
    '4242 100 100 0 2 0 0 0 0 1 501 /bin/ps extra', '4242 100 100 0 2 0 0 0 0 1 501 /bin/%E0%A4%A', '4242 100 100 0 2 0 0 0 0 1 501 /bin/p"s']) {
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
  assert.match(result.stderr, /run-tests: CLEANUP INCOMPLETE: 1 processes of the run could not be identified by start time and were left alone: \d+\./);
  assert.match(result.stderr, /run-tests: Exit status 125 replaces 0\./);
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
  if (psIsSetUid) {
    assert.deepEqual([ps.ended.usage, ps.ended.record], [EPERM, [...facts(0), ZOMBIE]]);
    // The set-uid one's row carries nothing of its usage.
    assert.deepEqual([ps.ended.row, ps.ended.transition], [`${ps.pid} ${self.pid} ${self.group} 0 ${ZOMBIE} 0 0 0 0 ${EPERM} ${self.uid} -`, false]);
  }
  // Collected: no record, and nothing to report but that it is not there.
  for (const child of [ordinary, ps]) {
    assert.deepEqual([child.collected.info, child.collected.usage, child.collected.record, child.collected.row],
      [ESRCH, ESRCH, null, `${child.pid} 0 0 0 0 0 0 0 ${ESRCH} ${ESRCH} 0 -`]);
  }
});

// Scripted reads for the sampler: what one reading of a process is made of, in
// the order the sampler asks. The sampler runs "as" OWNER, under guard GUARD.
const MB = 1024 * 1024;
const read = {
  info: (ppid, pgid, uid, ruid, status = 2) => ['info', 0, [ppid, pgid, uid, ruid, status]],
  noInfo: errno => ['info', errno],
  usage: (start, resident, footprint) => ['usage', 0, [start, resident, footprint]],
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
  created: pid => `${pid} 101 100 ${OWNER} 2 5 ${3 * MB} ${2 * MB} 0 0 ${OWNER} -`,
  changingOwner: pid => `${pid} 101 100 ${OWNER} 2 0 0 0 0 ${EPERM} ${OWNER} -`,
  starting: pid => `${pid} 101 100 0 2 0 0 0 0 ${EPERM} ${OWNER} ${NODE}`,
  tool: pid => `${pid} 101 100 0 2 0 0 0 0 ${EPERM} ${OWNER} /bin/ps`,
  ending: pid => `${pid} 101 100 0 2 0 0 0 0 ${EPERM} ${OWNER} -`,
  ended: pid => `${pid} 101 100 0 ${ZOMBIE} 0 0 0 0 ${EPERM} ${OWNER} -`,
  gone: pid => `${pid} 0 0 0 0 0 0 0 ${ESRCH} ${ESRCH} 0 -`,
  otherTool: pid => `${pid} 101 100 0 2 0 0 0 0 ${EPERM} ${OWNER} /usr/bin/top`,
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
    // There, with usage that says it is not: on its way out.
    26: [read.info(101, 100, OWNER, OWNER), read.noUsage(ESRCH)],
    // Gone between being listed and being read. Read right after two readable ones: nothing of theirs shows.
    27: reading.gone,
    // Unreadable for other reasons: the process table is not asked.
    28: [read.noInfo(EPERM), read.noUsage(EPERM)],
    29: [read.noInfo(ESRCH), read.noUsage(13)],
  }, { scans: [[21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]] });
  assert.deepEqual(result.scans[0].rows, [
    rowOf.created(21),
    rowOf.ended(22),
    `23 0 0 0 0 0 0 0 ${ESRCH} ${EPERM} 0 -`,
    `24 0 0 0 0 0 0 0 ${ESRCH} ${EPERM} 0 -`,
    `25 101 100 ${OWNER} ${ZOMBIE} 9 ${60 * MB} 0 0 0 ${OWNER} -`,
    `26 101 100 ${OWNER} 2 0 0 0 0 ${ESRCH} ${OWNER} -`,
    rowOf.gone(27),
    `28 0 0 0 0 0 0 0 ${EPERM} ${EPERM} 0 -`,
    `29 0 0 0 0 0 0 0 ${ESRCH} 13 0 -`,
    `30 0 0 0 0 77 ${300 * MB} ${280 * MB} ${ESRCH} 0 0 -`,
    `31 0 0 0 0 9 ${60 * MB} 0 ${ESRCH} 0 0 -`,
  ]);
  assert.deepEqual([21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31].map(pid => readsOf(result, pid)), ['info usage', 'info usage record', 'info usage record',
    'info usage record', 'info usage record', 'info usage', 'info usage', 'info usage', 'info usage', 'info usage record', 'info usage record']);
  // None of these can be in transition, so nothing was read twice and nothing is remembered.
  assert.deepEqual([result.scans[0].pauses, result.scans[0].remembered], [[], {}]);
  // The guard takes exactly two of these rows as ended.
  assert.deepEqual(result.scans[0].rows.map(parseRow).filter(item => item.infoError === 0 && item.status === ZOMBIE).map(item => item.pid), [22, 25]);
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
  for (const [changed, text] of [[moved, `7 1 100 0 2 0 0 0 0 ${EPERM} ${OWNER} /bin/ps`], [regrouped, `7 101 7 0 2 0 0 0 0 ${EPERM} ${OWNER} /bin/ps`],
    [otherOwner, `7 101 100 502 2 0 0 0 0 ${EPERM} ${OWNER} /bin/ps`]]) {
    const result = scripted({ 7: [...reading.tool, ...changed, ...changed] });
    assert.deepEqual([result.scans[0].rows, result.scans[0].pauses], [[text], pauses.slice(0, 2)]);
  }

  // A child of the guard, which is where the test runner is, is never read
  // again: the guard gets its first reading, unreadable or not.
  const runner = [read.info(GUARD, 7, 0, OWNER), read.noUsage(EPERM), read.path('/usr/bin/top')];
  const first = scripted({ 7: runner });
  assert.deepEqual([first.scans[0].rows, first.scans[0].pauses, first.scans[0].remembered], [[`7 ${GUARD} 7 0 2 0 0 0 0 ${EPERM} ${OWNER} /usr/bin/top`], [], {}]);
  // Nor is a process another user started.
  const foreign = scripted({ 7: [read.info(101, 100, 0, 0), read.noUsage(EPERM)] });
  assert.deepEqual([foreign.scans[0].rows, foreign.scans[0].pauses], [[`7 101 100 0 2 0 0 0 0 ${EPERM} 0 -`], []]);

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
