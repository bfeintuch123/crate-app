'use strict';
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const assert = require('./bounded-assert');
const {
  parseArguments, parseRow, createOwnership, createGuard, startCheckedSampler, UsageError, TIMING,
  DEFAULT_PROCESS_LIMIT_MB, DEFAULT_TOTAL_LIMIT_MB, DEFAULT_DEADLINE_SECONDS, UNREADABLE_SAMPLES,
  EXIT_MEMORY_LIMIT, EXIT_DEADLINE, EXIT_GUARD_FAILURE, ZOMBIE, ESRCH,
} = require('../scripts/run-tests');

const root = path.resolve(__dirname, '..');
const runTests = path.join(root, 'scripts/run-tests.js');
const fixtures = path.join(__dirname, 'fixtures/memory-guard');
const growing = path.join(fixtures, 'growing.fixture.js');
const outcomes = path.join(fixtures, 'outcomes.fixture.js');
const descendants = path.join(fixtures, 'descendants.fixture.js');
const faultyGuard = path.join(fixtures, 'faulty-guard.js');
const EPERM = 1;

// ---------------------------------------------------------------------------
// The guard's decisions, on a simulated process table. Nothing real is started
// or signalled in this half of the file.

const GUARD = 10;
const SAMPLER = 11;
const STANDBY = 13;
const RUNNER = 100;

function row(pid, ppid, pgid, extra = {}) {
  return { pid, ppid, pgid, uid: 501, status: 2, start: `started-${pid}`, megabytes: 10, infoError: 0, usageError: 0, ...extra };
}
const unreadableRow = (pid, ppid, pgid, errno = EPERM) => row(pid, ppid, pgid, { start: '0', megabytes: 0, usageError: errno });

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
  const ownership = createOwnership({ guardPid: GUARD, helperPids: [SAMPLER, STANDBY], runnerPid: RUNNER });
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
const newOwnership = () => createOwnership({ guardPid: GUARD, helperPids: [SAMPLER, STANDBY], runnerPid: RUNNER });
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
  assert.deepEqual(parseRow('4242 100 100 501 2 98765432109876543210 1048576 3145728 0 0'),
    { pid: 4242, ppid: 100, pgid: 100, uid: 501, status: 2, start: '98765432109876543210', megabytes: 3, infoError: 0, usageError: 0 });
  assert.equal(parseRow('4242 100 100 501 2 5 9437184 1048576 0 0').megabytes, 9);
  assert.deepEqual(parseRow('4242 0 0 0 0 0 0 0 3 1'),
    { pid: 4242, ppid: 0, pgid: 0, uid: 0, status: 0, start: '0', megabytes: 0, infoError: 3, usageError: 1 });
  for (const bad of ['', '4242 100 100 501 2 5 1 2 0 ', '4242 100 100 501 2 5 1 2 0', '4242 100 100 501 2 5 1 2 0 0 0',
    'pid 100 100 501 2 5 1 2 0 0', '-1 100 100 501 2 5 1 2 0 0', '4242  100 100 501 2 5 1 2 0 0', '4242 100 100 501 2 5 1 2 0 0\r']) {
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
  assert.match(result.stderr, /run-tests: Every process of the run is gone\./);
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
  assert.match(result.stderr, /run-tests: Every process of the run is gone\./);
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
  assert.match(result.stderr, /run-tests: Every process of the run is gone\./);
  await allGone([...treeRoles, 'ready']);
  assert.equal(bystanderSurvived(), true);
});

test('what a finished run leaves running is ended, without changing the run\'s result', { timeout: 60000 }, async t => {
  const { environment, recorded, allGone, bystanderSurvived } = scenario(t);
  const result = await startGuard([descendants], environment('leave', true)).done;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^# pass 1$/m);
  assert.match(result.stderr, /run-tests: The test run ended and left \d+ of its processes running; ending them\./);
  assert.match(result.stderr, /run-tests: Every process of the run is gone\./);
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
  assert.match(result.stderr, /run-tests: Not every process of the run is confirmed gone\./);
  assert.doesNotMatch(result.stderr, /Every process of the run is gone/);
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
  assert.match(result.stderr, /run-tests: Not every process of the run is confirmed gone\./);
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
  assert.match(result.stderr, /run-tests: Every process of the run is gone\./);
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
  assert.match(result.stderr, /run-tests: Every process of the run is gone\./);
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
  assert.match(result.stderr, /run-tests: Not every process of the run is confirmed gone\./);
  assert.doesNotMatch(result.stderr, /Every process of the run is gone/);
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
    assert.match(result.stderr, /run-tests: Every process of the run is gone\./);
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
  assert.match(result.stderr, /run-tests: Every process of the run is gone\./);
  assert.ok(Date.now() - second < 3000, 'did not wait out the grace period');
  await allGone([...treeRoles, 'stubborn', 'ready']);
  assert.equal(bystanderSurvived(), true);
});

test('a run that passes its deadline is stopped and reported as 124', { timeout: 60000 }, async t => {
  const { environment, ready, allGone, bystanderSurvived } = scenario(t);
  const run = startGuard(['--deadline-seconds=3', descendants], environment('idle'));
  await ready();
  const result = await run.done;
  assert.equal(result.code, EXIT_DEADLINE, result.stderr);
  assert.match(result.stderr, /run-tests: DEADLINE PASSED after [\d.]+ s \(limit 3 s\)\./);
  assert.match(result.stderr, /run-tests: Every process of the run is gone\./);
  assert.ok(result.seconds < 12, `took ${result.seconds} s`);
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
    assert.match(result.stderr, /run-tests: Every process of the run is gone\./);
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
