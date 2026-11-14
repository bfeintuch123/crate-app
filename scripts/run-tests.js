#!/usr/bin/env node
'use strict';
// Runs `node --test` under an external memory guard.
//
//   node scripts/run-tests.js                                    whole serial suite
//   node scripts/run-tests.js tests/figma-scope.test.js          chosen files
//   node scripts/run-tests.js --test-name-pattern="focus" tests/renderer-figma-scope.test.js
//
// Every argument goes to `node --test` unchanged, apart from the guard's own
// options. With no test files it runs tests/*.test.js, and it adds
// --test-concurrency=1 unless a concurrency is given.
//
//   --memory-limit-mb=N         most memory one process of the run may hold   (CRATE_TEST_MEMORY_LIMIT_MB)
//   --total-memory-limit-mb=N   most memory the whole run may hold            (CRATE_TEST_TOTAL_MEMORY_LIMIT_MB)
//   --deadline-seconds=N        longest the run may take                      (CRATE_TEST_DEADLINE_SECONDS)
//
// What it does. About twenty times a second (every 50 ms, plus the time one
// scan takes) it asks scripts/run-tests-sampler.py for every process on the
// machine: parent, process group, start time, resident size and memory
// footprint (macOS's own accounting, which includes compressed memory). From
// that it works out which processes belong to the run, and it stops the run
// when one of them, or all of them together, passes a limit, or when the
// deadline passes. A process that has ended and only waits for its parent to
// collect it is not running any more: the guard does not count it, signal it
// or wait for it. It reads from outside the test processes, so it
// works while a test is stuck in a synchronous loop, and it changes nothing
// about the environment the tests run in.
//
// Which processes belong to the run. The test runner is started in its own
// session and leads its own process group. Only processes of that session can
// join the group, and the system does not hand the group's number to anyone
// else while the runner or a member of the group exists. A process belongs to
// the run when it is the runner, is in that group in a scan that also shows
// the runner, was started by a process of the run (whatever session or group
// it then moved to), or was identified as the run's before. Identified means
// pid AND start time: the system reuses pids, not the pair.
//
// How it stops a run. It freezes first: SIGSTOP to the group and to every
// process of the run it has identified, repeated until a scan finds nothing
// new (at most fifty times), so that what it can signal does not start more
// processes behind its back. Then SIGKILL, and then it scans until every
// process of the run has ended. A process it could not identify outside the
// group is not signalled; if it is still running at the end, the guard says
// so and exits 125. Every signal is sent by the sampler, which reads the
// target's start time again and signals in the next system call.
// The same cleanup runs after a signal (once the run has had a few seconds to
// stop by itself) and for anything a finished run leaves behind.
//
// When it gives up on a run. It does not let a run continue that it cannot
// watch: no answer from the sampler for three seconds, or a process of the run
// whose start time and memory cannot be read, the test runner itself included
// from the first scan on. It stops the run and exits 125. That also holds
// when the same scan shows that the run has just ended by itself or that a
// signal has arrived, and for the one scan the guard makes right after a run
// has ended: a run that was not watched to its end does not get to report its
// own result. While the guard is ending a run, its scans follow each other
// too closely for "three samples" to mean anything; a process it cannot read
// then counts only if it is still running at the end.
//
// The one exception is the system's own `ps`. Tests start it, and macOS
// installs it set-uid root, so this user may not read its memory. A process is
// let through as that tool only when the system reports its executable as
// exactly /bin/ps, it runs as root for this user (real owner this user), it
// was started by a process of the run or is in the run's process group in the
// same scan, and it has been there for no longer than two seconds or forty
// samples, with no more than eight at once. It is counted at an assumed 32 MB,
// which is an estimate and not a measurement, and it is never signalled by
// pid. Once it has ended it is neither counted nor waited for, even while its
// parent has not collected it. Anything else the guard cannot read, including
// a `ps` that fails any of these conditions, stops the run as before.
//
// For a fraction of a millisecond while it starts, and again while it ends, a
// `ps` is not that tool: it already runs as root while its executable is
// still its parent's, or its executable is already gone. The guard allows
// nothing for that. Instead the sampler reads a process this user started
// and may not read a second time, a millisecond later, and up to twice more
// while its readings differ, and reports the last reading (see there). The
// price: a state of such a process that is over within those few milliseconds
// does not reach the guard, even one it would have stopped the run for. The
// test runner is not read again; its first reading always reaches the guard.
//
// It also exits 125, whatever the tests' own result, when it cannot confirm
// that every process of the run has ended.
//
// What it is not.
// - Not a hard cap. It samples. A run can pass its limit by whatever it
//   allocates between two samples (0.05 s and the time one scan takes, more
//   under load) plus the time to freeze it.
// - Not able to see a process that never appears in a scan as part of the run:
//   one that is started, leaves the runner's process group, and loses its
//   parent, all between two samples. Such a process is not tracked, limited or
//   cleaned up.
// - Not proof against pid reuse in the last instant. Between the sampler's
//   check of a start time and its signal lie a few microseconds in which the
//   target could end and its pid pass to another process. Nothing available to
//   an ordinary program on macOS closes that gap.
// - Not a measurement of the system's `ps`. While one is let through, the
//   guard counts an assumed 32 MB for it and does not know what it holds; a
//   run that starts one after another has that much unmeasured the whole
//   time. One that leaves the run's process group, or outlives the runner, is
//   not signalled either, because it cannot be identified: if it is still
//   there when the run is cleaned up, the guard lists it and exits 125.
// - Not free of false stops. It stops a run that did nothing wrong when a
//   `ps` runs for more than two seconds, when more than eight run at once,
//   when one is started by a process that has left the run's group and lost
//   its parent, and when one stays between two states (starting or ending)
//   for longer than the few milliseconds the sampler waits for it to settle,
//   which can happen when the machine is too busy to let it finish starting.
// - Not able to end the whole run when no sampler works any more (the one in
//   use, the one standing by, and a newly started one all fail). It then kills
//   the runner's process group, leaves whatever the run started outside that
//   group running, lists it, and exits 125.
// - Not a guard at all if it is itself killed with SIGKILL or frozen: the run
//   then continues unwatched.
// - macOS only. Elsewhere, or when the sampler cannot be started, it refuses
//   to run the tests rather than run them unguarded.
//
// Exit status: the test runner's own; or 137 when a memory limit was passed,
// 124 when the deadline passed, 128+N after signal N; or 125 when the guard
// could not watch the run or could not confirm its cleanup; 2 for a bad option.

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The whole suite peaks near 450 MB in one process and 1.2 GB in total, and
// takes about 19 minutes.
const DEFAULT_PROCESS_LIMIT_MB = 2048;
const DEFAULT_TOTAL_LIMIT_MB = 4096;
const DEFAULT_DEADLINE_SECONDS = 2400;
const TIMING = {
  sampleIntervalMs: 50,
  // One request takes about 2 ms. No answer in this long means the sampler is stuck.
  requestTimeoutMs: 1000,
  // Longest the guard keeps a run going without a good sample.
  blindLimitMs: 3000,
  // How long a run gets to stop by itself after a signal, and leftovers after SIGTERM.
  signalGraceMs: 5000,
  leftoverGraceMs: 2000,
  // How long processes get to disappear after SIGKILL before cleanup counts as failed.
  confirmMs: 5000,
};
// A process that is ending can be unreadable for a moment. Longer than this
// many samples in a row, or unreadable for any other reason, and the guard
// cannot watch it.
const UNREADABLE_SAMPLES = 3;
const MAX_FREEZE_ROUNDS = 50;
const EXIT_MEMORY_LIMIT = 137;
const EXIT_DEADLINE = 124;
const EXIT_GUARD_FAILURE = 125;
const ZOMBIE = 5; // SZOMB in <sys/proc.h>
const ESRCH = 3;
const EPERM = 1;
// The one tool a test may start that this user cannot read, and the bounds
// within which it is let through. See the header.
const SYSTEM_TOOL = {
  path: '/bin/ps',
  effectiveUid: 0,
  samples: 40,
  milliseconds: 2000,
  atOnce: 8,
  assumedMegabytes: 32,
};
const MB = 1024 * 1024;
const SIGNAL_RESULTS = new Set(['sent', 'mismatch', 'gone', 'unreadable', 'denied']);
const root = path.resolve(__dirname, '..');
const samplerPath = path.join(__dirname, 'run-tests-sampler.py');

class UsageError extends Error {}

function readWholeNumber(name, text, fallback, unit) {
  if (text === undefined || text === '') return fallback;
  if (!/^[1-9]\d{0,6}$/.test(text)) throw new UsageError(`${name} must be a whole number of ${unit}, got "${text}"`);
  return Number(text);
}

function parseArguments(argv, env) {
  const limits = {
    process: readWholeNumber('CRATE_TEST_MEMORY_LIMIT_MB', env.CRATE_TEST_MEMORY_LIMIT_MB, DEFAULT_PROCESS_LIMIT_MB, 'megabytes'),
    total: readWholeNumber('CRATE_TEST_TOTAL_MEMORY_LIMIT_MB', env.CRATE_TEST_TOTAL_MEMORY_LIMIT_MB, DEFAULT_TOTAL_LIMIT_MB, 'megabytes'),
    deadlineSeconds: readWholeNumber('CRATE_TEST_DEADLINE_SECONDS', env.CRATE_TEST_DEADLINE_SECONDS, DEFAULT_DEADLINE_SECONDS, 'seconds'),
  };
  const nodeArguments = [];
  for (const argument of argv) {
    const memory = /^--(total-)?memory-limit-mb=(.*)$/.exec(argument);
    const deadline = /^--deadline-seconds=(.*)$/.exec(argument);
    if (deadline) limits.deadlineSeconds = readWholeNumber('--deadline-seconds', deadline[1], limits.deadlineSeconds, 'seconds');
    else if (!memory) nodeArguments.push(argument);
    else if (memory[1]) limits.total = readWholeNumber('--total-memory-limit-mb', memory[2], limits.total, 'megabytes');
    else limits.process = readWholeNumber('--memory-limit-mb', memory[2], limits.process, 'megabytes');
  }
  const namesTests = nodeArguments.some(argument => !argument.startsWith('-')
    && (/[*?]|\.[cm]?js$/.test(argument) || fs.existsSync(argument)));
  if (!namesTests) {
    const directory = path.join(root, 'tests');
    for (const name of fs.readdirSync(directory).filter(file => file.endsWith('.test.js')).sort()) {
      nodeArguments.push(path.relative(process.cwd(), path.join(directory, name)));
    }
  }
  if (!nodeArguments.some(argument => argument.startsWith('--test-concurrency'))) {
    nodeArguments.unshift('--test-concurrency=1');
  }
  return { limits, nodeArguments: ['--test', ...nodeArguments] };
}

function formatSize(megabytes) {
  return megabytes >= 1024 ? `${(megabytes / 1024).toFixed(1)} GB` : `${Math.round(megabytes)} MB`;
}

// One line of a scan. `start` stays text: it identifies the process and must
// compare exactly, whatever its size.
function parseRow(line) {
  if (!/^\d+(?: \d+){10} (?:-|[A-Za-z0-9\/%._~-]+)$/.test(line)) return null;
  const [pid, ppid, pgid, uid, status, start, resident, footprint, infoError, usageError, ruid, encodedPath] = line.split(' ');
  let path = null;
  if (encodedPath !== '-') {
    try {
      path = decodeURIComponent(encodedPath);
    } catch {
      return null;
    }
  }
  return {
    pid: Number(pid),
    ppid: Number(ppid),
    pgid: Number(pgid),
    uid: Number(uid),
    ruid: Number(ruid),
    status: Number(status),
    start,
    megabytes: Math.max(Number(resident), Number(footprint)) / MB,
    infoError: Number(infoError),
    usageError: Number(usageError),
    path,
  };
}

const hasEnded = row => row.infoError === 0 && row.status === ZOMBIE;
const isIdentified = row => row.usageError === 0;

// The long-lived sampler process and its request/answer protocol.
function startSampler(command, requestTimeoutMs = TIMING.requestTimeoutMs) {
  const child = spawn(command, [samplerPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let nextId = 1;
  let pending = null; // { id, read(line) -> answer | undefined, resolve, reject, timer }
  let buffered = '';
  let failure = null;
  let stderrTail = '';

  const settle = (error, value) => {
    if (!pending) return;
    const request = pending;
    pending = null;
    clearTimeout(request.timer);
    if (error) request.reject(error);
    else request.resolve(value);
  };
  const fail = message => {
    failure ||= new Error(stderrTail ? `${message}: ${stderrTail}` : message);
    settle(failure);
  };
  const request = (words, makeReader, timeoutMs) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    if (pending) return reject(new Error('sampler asked twice at once'));
    const id = nextId;
    nextId += 1;
    pending = { id, read: makeReader(id), resolve, reject };
    pending.timer = setTimeout(() => settle(new Error(`sampler did not answer within ${timeoutMs} ms`)), timeoutMs);
    child.stdin.write(`${[words[0], id, ...words.slice(1)].join(' ')}\n`, error => { if (error) fail('sampler ended (closed its input)'); });
    return undefined;
  });

  child.on('error', error => fail(`sampler could not start (${error.code || error.message})`));
  // A sampler that ends is noticed as its exit or as its closed input,
  // whichever this process happens to see first. Both mean the same thing,
  // that it is gone for good, and both are reported as "sampler ended".
  child.on('exit', (code, signal) => fail(`sampler ended (exited: ${signal || code})`));
  child.stdin.on('error', () => fail('sampler ended (closed its input)'));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk).trim().split('\n').pop().slice(0, 200); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    const lines = (buffered + chunk).split('\n');
    buffered = lines.pop();
    for (const line of lines) {
      // A line that arrives when nothing is asked, or that belongs to a
      // request that already timed out, is skipped, not trusted.
      if (!pending) continue;
      let answer;
      try {
        answer = pending.read(line);
      } catch (error) {
        return fail(error.message);
      }
      if (answer !== undefined) settle(null, answer);
    }
    return undefined;
  });

  const scanReader = id => {
    let expected = null;
    const rows = [];
    return line => {
      if (expected === null) {
        const begin = /^begin (\d+) (\d+)$/.exec(line);
        if (begin && Number(begin[1]) === id) expected = Number(begin[2]);
        return undefined;
      }
      if (rows.length < expected) {
        const row = parseRow(line);
        if (!row) throw new Error('sampler sent a line that is not a process row');
        rows.push(row);
        return undefined;
      }
      if (line !== `end ${id}`) throw new Error('sampler answer did not end where it said it would');
      return rows;
    };
  };
  const signalReader = count => id => line => {
    const words = line.split(' ');
    if (words[0] !== 'signalled' || Number(words[1]) !== id) return undefined;
    const results = words.slice(2);
    if (results.length !== count || !results.every(result => SIGNAL_RESULTS.has(result))) {
      throw new Error('sampler sent a signal answer that does not match the request');
    }
    return results;
  };
  const target = row => `${row.pid}:${row.start}`;
  const short = name => name.replace(/^SIG/, '');

  return {
    pid: child.pid,
    // Gone for good, as opposed to slow to answer.
    get dead() { return failure !== null; },
    scan: (timeoutMs = requestTimeoutMs) => request(['scan'], scanReader, timeoutMs),
    // Sends `name` to each process that still has the start time in its row.
    signalProcesses: (name, rows) => request(['signal', short(name), ...rows.map(target)], signalReader(rows.length), requestTimeoutMs),
    // Sends `name` to process group `pgid` if `member` is still in it.
    signalGroup: async (name, pgid, member) => (
      await request(['group', short(name), String(pgid), target(member)], signalReader(1), requestTimeoutMs))[0],
    stop() {
      failure ||= new Error('sampler stopped');
      settle(failure);
      try { child.stdin.destroy(); } catch { /* already closed */ }
      // SIGKILL, because a sampler that someone froze ignores everything else.
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    },
  };
}

// Starts a sampler and proves it reads this very process correctly before it
// is trusted with anything else.
async function startCheckedSampler() {
  const problems = [];
  for (const command of ['/usr/bin/python3', 'python3']) {
    const sampler = startSampler(command);
    try {
      const rows = await sampler.scan(5000);
      const self = rows.find(row => row.pid === process.pid);
      const own = rows.find(row => row.pid === sampler.pid);
      const resident = process.memoryUsage.rss() / MB;
      if (!self || self.infoError !== 0 || !isIdentified(self) || !(self.megabytes > resident / 4 && self.megabytes < resident * 4)) {
        throw new Error('sampler misreads the guard process itself');
      }
      if (!own || own.ppid !== process.pid) throw new Error('sampler does not report itself as the guard\'s child');
      return sampler;
    } catch (error) {
      sampler.stop();
      problems.push(`${command}: ${error.message}`);
    }
  }
  throw new Error(problems.join('; '));
}

// Works out, scan by scan, which processes belong to the run, and notices
// when one of them, the runner first of all, cannot be read.
function createOwnership({ guardPid, guardUid, helperPids = [], runnerPid, now = () => performance.now() }) {
  const helpers = new Set(helperPids);
  const toolStats = { samples: 0, longestSamples: 0, longestMilliseconds: 0 };
  let runnerStart = null;
  let anchored = null; // does the runner lead the process group that carries its pid? null until a scan shows it
  let runnerProblem = null; // what is wrong with the runner's own row in the latest scan, if anything
  let runnerMissing = 0; // scans in a row that did not list the runner although it exists
  let owned = new Map();
  let latest = new Map();
  const identified = new Map(); // pid -> start time under which that pid was last identified as the run's
  // Processes of the run that cannot be read: pid -> { errno, samples, since,
  // ending, allowed }. `samples` counts the scans in a row that could not read
  // it and `since` is the time of the first; `ending` counts those in a row
  // that said it no longer exists; `allowed` marks the system tool while it is
  // let through.
  const unread = new Map();

  return {
    get owned() { return owned; },
    get runnerStart() { return runnerStart; },
    // How often a system tool was let through (once per tool per scan, the
    // scans of a cleanup included), and the longest any one of them stayed.
    get toolStats() { return toolStats; },
    // False once a scan showed the runner outside the group it was started to lead.
    get groupUsable() { return anchored !== false; },
    row(pid) { return latest.get(pid) || null; },
    addHelper(pid) { helpers.add(pid); },
    // An identified process of the run that is in the runner's group right
    // now, while the runner still exists: something the sampler can check
    // again at the moment it signals the whole group.
    groupMember(runnerExists) {
      if (anchored !== true || !runnerExists) return null;
      const inGroup = row => row.infoError === 0 && row.pgid === runnerPid && isIdentified(row) && !hasEnded(row);
      const runner = owned.get(runnerPid);
      return (runner && inGroup(runner) && runner) || [...owned.values()].find(inGroup) || null;
    },
    // Why the guard cannot watch the run, or null. `problem` is 'unreadable'
    // (start time and memory of a process of the run cannot be read),
    // 'missing' (the runner exists and scans do not list it) or 'inconsistent'
    // (scans show the runner as something this guard did not start).
    readFailure() {
      if (runnerProblem) return { pid: runnerPid, ...runnerProblem };
      for (const [pid, entry] of unread) {
        if (entry.allowed) continue;
        if (entry.errno !== ESRCH || entry.ending > UNREADABLE_SAMPLES) return { pid, problem: 'unreadable', errno: entry.errno, samples: entry.samples };
      }
      return null;
    },
    update(rows, runnerExists) {
      const before = owned;
      latest = new Map();
      const children = new Map();
      for (const row of rows) {
        latest.set(row.pid, row);
        if (row.infoError !== 0) continue;
        if (!children.has(row.ppid)) children.set(row.ppid, []);
        children.get(row.ppid).push(row);
      }
      const next = new Map();
      const queue = [];
      // Pids whose place in the run this very scan shows: the runner, a process
      // identified before, a member of the runner's group, or something one of
      // those started. A process kept only because it was in the run a moment
      // ago is in the run, but not in this set.
      const shownInRun = new Set();
      let carrying = false;
      const adopt = row => {
        if (!row || row.pid <= 1 || row.pid === guardPid || helpers.has(row.pid) || next.has(row.pid)) return;
        next.set(row.pid, row);
        if (!carrying) shownInRun.add(row.pid);
        queue.push(row);
      };
      // Started by a process of the run, wherever it went afterwards.
      const descend = () => {
        while (queue.length > 0) {
          const parent = queue.pop();
          for (const child of children.get(parent.pid) || []) adopt(child);
        }
      };
      // The runner. This process started it and has not collected it, so its
      // pid cannot have passed to anyone else: whatever a scan lists under
      // that pid is the runner, readable or not. It is the root of the run
      // from the first scan on. A scan that does not list it, or shows it as
      // something this guard did not start, cannot be trusted with the run.
      const runner = latest.get(runnerPid);
      let runnerSeen = false;
      runnerProblem = null;
      if (!runnerExists) {
        runnerMissing = 0;
      } else if (!runner) {
        runnerMissing += 1;
        if (runnerMissing > UNREADABLE_SAMPLES) runnerProblem = { problem: 'missing', errno: ESRCH, samples: runnerMissing };
      } else {
        runnerMissing = 0;
        adopt(runner);
        if (runner.infoError === 0 && isIdentified(runner) && !hasEnded(runner)) {
          if (runnerStart === null && runner.ppid === guardPid) {
            runnerStart = runner.start;
            anchored = runner.pgid === runnerPid;
          }
          runnerSeen = runner.ppid === guardPid && runner.start === runnerStart && runner.pgid === runnerPid;
          if (!runnerSeen) {
            if (runner.pgid !== runnerPid) anchored = false;
            runnerProblem = { problem: 'inconsistent', errno: 0, samples: 1 };
          }
        }
      }
      // Identified as the run's before: same pid and the same start time,
      // however long ago and whether or not it showed up in every scan since.
      for (const row of rows) {
        if (isIdentified(row) && identified.get(row.pid) === row.start) adopt(row);
      }
      // In the runner's group, in a scan that shows the runner itself. Only the
      // run's own session can put a process there while the runner holds the
      // pid that names the group.
      if (anchored === true && runnerSeen) {
        for (const row of rows) if (row.infoError === 0 && row.pgid === runnerPid) adopt(row);
      }
      descend();
      // In the run a moment ago and unreadable now. It cannot be shown to be
      // the same process, and it must not be quietly dropped: it stays, counted
      // as a process the guard cannot read. One that has ended stays too, for
      // what it started: a scan is not one instant, and a child read while its
      // parent was alive may have nothing else left that ties it to the run.
      carrying = true;
      for (const row of rows) {
        if (before.has(row.pid) && !isIdentified(row)) adopt(row);
      }
      descend();
      const time = now();
      let allowed = 0;
      for (const pid of [...unread.keys()]) if (!next.has(pid)) unread.delete(pid);
      for (const row of next.values()) {
        // Never learned from a process that has ended: its start time and its
        // state come from two reads, and only a live process is worth knowing again.
        if (isIdentified(row) && !hasEnded(row)) identified.set(row.pid, row.start);
        if (hasEnded(row) || (isIdentified(row) && row.infoError === 0)) {
          unread.delete(row.pid);
          continue;
        }
        const errno = row.usageError || row.infoError;
        const earlier = unread.get(row.pid) || { samples: 0, since: time, ending: 0 };
        const entry = { errno, samples: earlier.samples + 1, since: earlier.since, ending: errno === ESRCH ? earlier.ending + 1 : 0, allowed: false };
        unread.set(row.pid, entry);
        // The system tool (see the header). Every condition is read from this
        // scan; a remembered pid is not enough, and neither is the runner's pid.
        const isTool = row.pid !== runnerPid && shownInRun.has(row.pid)
          && row.infoError === 0 && row.usageError === EPERM && row.path === SYSTEM_TOOL.path
          && row.ruid === guardUid && row.uid === SYSTEM_TOOL.effectiveUid && guardUid !== SYSTEM_TOOL.effectiveUid;
        const withinBounds = entry.samples <= SYSTEM_TOOL.samples && time - entry.since <= SYSTEM_TOOL.milliseconds;
        if (isTool && withinBounds && allowed < SYSTEM_TOOL.atOnce) {
          allowed += 1;
          entry.allowed = true;
          // An estimate, because it cannot be measured. The row stays unidentified.
          row.megabytes = SYSTEM_TOOL.assumedMegabytes;
          row.assumed = true;
          toolStats.samples += 1;
          toolStats.longestSamples = Math.max(toolStats.longestSamples, entry.samples);
          toolStats.longestMilliseconds = Math.max(toolStats.longestMilliseconds, time - entry.since);
        }
      }
      owned = next;
      return owned;
    },
  };
}

// The guard's decisions, separated from real processes: it is given a way to
// scan, to signal, to wait and to read the clock.
function createGuard({
  ownership, runnerPid, scan, signalProcesses, signalGroup, signalGroupWhileHeld, sleep, now, isRunnerGone,
  onAnomaly = () => {}, timing = TIMING,
}) {
  const alive = () => [...ownership.owned.values()].filter(row => !hasEnded(row));
  const identifiedRows = () => alive().filter(isIdentified);
  const unidentifiedRows = () => alive().filter(row => !isIdentified(row));
  const observe = async () => ownership.update(await scan(), !isRunnerGone());

  // Signals the runner's group in one call, and every identified process not
  // covered by that call one by one. Returns the rows whose signal was sent,
  // by either route.
  const signalRun = async (name, except = () => false) => {
    const rows = identifiedRows().filter(row => !except(row));
    const member = ownership.groupMember(!isRunnerGone());
    let grouped = member !== null && (await signalGroup(name, runnerPid, member)) === 'sent';
    // No identified process to check the group by: the runner itself may be
    // the one that cannot be read. Until this process has collected the
    // runner, the runner's pid, and with it the group's number, is still the
    // run's, so the group can be signalled by that number alone.
    if (!grouped && ownership.groupUsable && !isRunnerGone()) grouped = signalGroupWhileHeld(name);
    const inGroup = row => grouped && row.infoError === 0 && row.pgid === runnerPid;
    const single = rows.filter(row => !inGroup(row));
    const results = single.length > 0 ? await signalProcesses(name, single) : [];
    single.forEach((row, index) => {
      if (results[index] === 'denied' || results[index] === 'unreadable') {
        onAnomaly(`${name} could not be sent to process ${row.pid} of the run (${results[index]})`);
      }
    });
    return rows.filter(row => inGroup(row) || results[single.indexOf(row)] === 'sent');
  };

  // Freeze, kill, confirm.
  const stopRun = async ({ onFrozen = () => {} } = {}) => {
    const frozen = new Map(); // pid -> start time of the process this guard froze
    const unidentified = new Set(); // pids seen in the run without a readable start time
    for (let round = 0; round < MAX_FREEZE_ROUNDS; round += 1) {
      await observe();
      for (const row of unidentifiedRows()) unidentified.add(row.pid);
      // The sampler checks a start time and signals in the next system call.
      // Should a pid change hands in that instant, the process that now holds
      // it was frozen by mistake: let it go again.
      for (const [pid, start] of frozen) {
        const row = ownership.row(pid);
        if (row && isIdentified(row) && row.start !== start) {
          frozen.delete(pid);
          const [result] = await signalProcesses('SIGCONT', [row]);
          onAnomaly(`process ${pid} is no longer the process the run started; it was resumed (${result}) and left alone`);
        }
      }
      let fresh = 0;
      for (const row of await signalRun('SIGSTOP', item => frozen.get(item.pid) === item.start)) {
        frozen.set(row.pid, row.start);
        fresh += 1;
      }
      // Nothing new in a scan taken after everything known was frozen: the
      // set is complete, because a frozen process cannot start another.
      if (fresh === 0) break;
    }
    await onFrozen(identifiedRows());
    const deadline = now() + timing.confirmMs;
    for (;;) {
      await observe();
      await signalRun('SIGKILL');
      await sleep(20);
      await observe();
      if (identifiedRows().length === 0 || now() >= deadline) break;
    }
    // Killing its parent unlinks an unidentified process from the run. It is
    // still reported, by the pid it had, for as long as that pid is unreadable.
    const leftAlone = new Map(unidentifiedRows().map(row => [row.pid, row]));
    for (const pid of unidentified) {
      const row = ownership.row(pid);
      if (row && !isIdentified(row) && !hasEnded(row)) leftAlone.set(pid, row);
    }
    return { survivors: identifiedRows(), unverified: [...leftAlone.values()] };
  };

  // After `name` the run gets `graceMs` to end by itself; what is left is stopped.
  const endRun = async (name, graceMs, isUrgent = () => false) => {
    await observe();
    await signalRun(name);
    const deadline = now() + graceMs;
    while (alive().length > 0 && now() < deadline && !isUrgent()) {
      await sleep(timing.sampleIntervalMs);
      await observe();
    }
    return alive().length === 0 ? { survivors: [], unverified: [] } : stopRun();
  };

  return { observe, stopRun, endRun, alive };
}

// What the run holds in one scan: all of it, and its largest process. A system
// tool that was let through counts at its assumed size. A process that has
// ended is left out: the system still reports the resident size it had at the
// end, with a footprint of zero.
function measureRun(owned) {
  let total = 0;
  let largest = null;
  for (const row of owned.values()) {
    if (hasEnded(row)) continue;
    total += row.megabytes;
    if (largest === null || row.megabytes > largest.megabytes) largest = row;
  }
  return { total, largest };
}

function describeProcess(pid) {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 }).trim() || '(no command)';
  } catch {
    return '(command unavailable)';
  }
}

// Runs the tests under the guard and returns the exit status. `startSampler`
// and `timing` exist so that tests can make the sampler misbehave and the
// waits short; the command line uses the real ones.
async function runGuard({ argv, env, startSampler: openSampler = startCheckedSampler, timing: timingOverrides = {} }) {
  const timing = { ...TIMING, ...timingOverrides };
  const say = message => process.stderr.write(`run-tests: ${message}\n`);
  let parsed;
  try {
    parsed = parseArguments(argv, env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    say(error.message);
    return 2;
  }
  const { limits, nodeArguments } = parsed;
  if (process.platform !== 'darwin') {
    say('the memory guard works on macOS only. Refusing to run the tests unguarded.');
    return EXIT_GUARD_FAILURE;
  }
  // Two samplers, both proven before any test starts. The second does nothing
  // until the first fails: cleanup then does not depend on being able to start
  // a new process at the worst moment.
  let sampler;
  let standby;
  try {
    sampler = await openSampler();
    standby = await openSampler();
  } catch (error) {
    if (sampler) sampler.stop();
    say(`the memory guard's sampler does not work (${error.message}). Refusing to run the tests unguarded.`);
    return EXIT_GUARD_FAILURE;
  }

  const started = Date.now();
  // Its own session, leading its own process group.
  const runner = spawn(process.execPath, nodeArguments, { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
  // True once this process has collected the runner, which is when the system
  // may give the runner's pid, and with it the group's number, to someone else.
  // Node records the collection in the same step in which it happens.
  const runnerCollected = () => runner.exitCode !== null || runner.signalCode !== null || !runner.pid;
  let runnerExit = null;
  let wake = () => {};
  const sleep = ms => new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    wake = () => { clearTimeout(timer); resolve(); };
  });
  runner.on('error', error => { runnerExit = { code: EXIT_GUARD_FAILURE, error }; wake(); });
  runner.on('exit', (code, signal) => {
    runnerExit = { code: signal ? 128 + (os.constants.signals[signal] || 0) : code };
    wake();
  });
  // Signals the runner's process group by its number alone. That needs no
  // sampler and no start time, and is done only while this process has not
  // collected the runner, when the number cannot have passed to anyone else.
  // The check and the signal are one step. Processes the run started outside
  // the group are not reached this way.
  const signalGroupWhileHeld = name => {
    if (runnerCollected()) return false;
    try { process.kill(-runner.pid, name); return true; } catch { return false; }
  };
  // Last resort for a guard that is going down with the run still up.
  process.on('exit', () => signalGroupWhileHeld('SIGKILL'));
  process.on('uncaughtException', error => {
    say(`the memory guard failed (${error && error.stack ? error.stack : error}). Stopping the test run.`);
    process.exit(EXIT_GUARD_FAILURE);
  });

  // What the run is sent when the guard receives each signal. SIGQUIT would
  // make every process of the run write a core file.
  const forwarded = { SIGINT: 'SIGINT', SIGTERM: 'SIGTERM', SIGHUP: 'SIGHUP', SIGQUIT: 'SIGTERM' };
  const received = [];
  for (const name of Object.keys(forwarded)) {
    process.on(name, () => { received.push(name); wake(); });
  }

  const ownership = createOwnership({
    guardPid: process.pid, guardUid: process.getuid(), helperPids: [sampler.pid, standby.pid], runnerPid: runner.pid,
  });
  const guard = createGuard({
    ownership,
    runnerPid: runner.pid,
    scan: () => sampler.scan(),
    signalProcesses: (name, rows) => sampler.signalProcesses(name, rows),
    signalGroup: (name, pgid, member) => sampler.signalGroup(name, pgid, member),
    signalGroupWhileHeld,
    sleep: ms => new Promise(resolve => { setTimeout(resolve, ms); }),
    now: Date.now,
    isRunnerGone: runnerCollected,
    onAnomaly: say,
    timing,
  });

  const peak = { process: 0, total: 0 };
  let samples = 0;
  let lastGoodSample = Date.now();
  let reason = null; // 'exit' | 'signal' | 'memory' | 'deadline' | 'blind' | 'unreadable'
  // What the guard reports when a scan shows a process of the run that it
  // cannot read, and what that does to a result the run already has.
  const notWatched = unreadable => {
    unreadablePid = unreadable.problem === 'unreadable' ? unreadable.pid : null;
    const lines = [{
      unreadable: `GUARD CANNOT READ PROCESS ${unreadable.pid} OF THE RUN after ${seconds()} s (errno ${unreadable.errno}, ${unreadable.samples} samples in a row). Its memory is unknown.`,
      missing: `GUARD CANNOT FIND THE TEST RUNNER after ${seconds()} s: process ${unreadable.pid} exists and ${unreadable.samples} scans in a row did not list it. The run's memory is unknown.`,
      inconsistent: `GUARD CANNOT TRUST ITS READING OF THE TEST RUNNER after ${seconds()} s: process ${unreadable.pid} does not show as this guard's child, leading its own process group, with one start time.`,
    }[unreadable.problem]];
    if (runnerExit && !runnerExit.error) {
      lines.push(`The test run had ended by then, with exit status ${runnerExit.code}. Exit status ${EXIT_GUARD_FAILURE} replaces it.`);
    } else if (received.length > 0) {
      lines.push(`${received[0]} had arrived by then. Exit status ${EXIT_GUARD_FAILURE} replaces ${128 + os.constants.signals[received[0]]}.`);
    }
    return lines;
  };
  let report = [];
  let offender = null;
  let unreadablePid = null;
  const seconds = () => ((Date.now() - started) / 1000).toFixed(1);

  while (reason === null) {
    let owned = null;
    try {
      owned = await guard.observe();
      lastGoodSample = Date.now();
      samples += 1;
    } catch (error) {
      // A sampler that is gone will not come back; one that is slow may. Either
      // way the run is not left unwatched for longer than the blind limit.
      if (sampler.dead || Date.now() - lastGoodSample > timing.blindLimitMs) {
        reason = 'blind';
        report = [`GUARD LOST SIGHT OF THE RUN after ${seconds()} s: ${error.message}.`];
        break;
      }
    }
    if (owned) {
      const { total, largest } = measureRun(owned);
      if (largest) peak.process = Math.max(peak.process, largest.megabytes);
      peak.total = Math.max(peak.total, total);
      const unreadable = ownership.readFailure();
      // A process the guard could not read outranks whatever else this scan
      // shows, the end of the run and a signal included.
      if (unreadable) {
        reason = 'unreadable';
        report = notWatched(unreadable);
      } else if (runnerExit) {
        reason = 'exit';
      } else if (received.length > 0) {
        reason = 'signal';
      } else if (largest && largest.megabytes > limits.process) {
        reason = 'memory';
        offender = largest.pid;
        report = [`MEMORY LIMIT EXCEEDED after ${seconds()} s: process ${largest.pid} reached ${formatSize(largest.megabytes)} (limit ${formatSize(limits.process)} per process).`];
      } else if (total > limits.total) {
        reason = 'memory';
        offender = largest.pid;
        report = [`MEMORY LIMIT EXCEEDED after ${seconds()} s: the run reached ${formatSize(total)} across ${owned.size} processes (limit ${formatSize(limits.total)} in total).`];
      } else if (Date.now() - started > limits.deadlineSeconds * 1000) {
        reason = 'deadline';
        report = [`DEADLINE PASSED after ${seconds()} s (limit ${limits.deadlineSeconds} s).`];
      }
    } else if (runnerExit) {
      reason = 'exit';
    } else if (received.length > 0) {
      reason = 'signal';
    }
    if (reason === null) await sleep(timing.sampleIntervalMs);
  }

  // From here on the run is being ended, and every step below is bounded.
  // Cleanup identifies processes by pid and start time, so it needs a working
  // sampler. When the current one fails, the one standing by takes over, and
  // when that fails too, a new one is started. After that there is no sight.
  const replaceSampler = async () => {
    sampler.stop();
    if (standby) {
      sampler = standby;
      standby = null;
    } else {
      sampler = await openSampler();
      ownership.addHelper(sampler.pid);
    }
  };
  const withSight = async action => {
    for (let replacements = 0; ; replacements += 1) {
      try {
        return await action();
      } catch (error) {
        if (replacements === 2) throw error;
        say(`the sampler failed (${error.message}); continuing with ${standby ? 'the one standing by' : 'a new one'}`);
        await replaceSampler();
      }
    }
  };
  const announceStop = frozen => {
    if (offender) report.push(`  ${describeProcess(offender)}`);
    if (unreadablePid) report.push(`  ${describeProcess(unreadablePid)}`);
    offender = null;
    unreadablePid = null;
    report.push(`Stopping the test run (${frozen.length} processes).`);
  };
  let exitCode = EXIT_GUARD_FAILURE;
  let cleanup = { survivors: [], unverified: [] };
  let leftovers = 0;
  try {
    if (reason === 'memory' || reason === 'deadline' || reason === 'unreadable') {
      if (reason === 'memory') exitCode = EXIT_MEMORY_LIMIT;
      if (reason === 'deadline') exitCode = EXIT_DEADLINE;
      cleanup = await withSight(() => guard.stopRun({ onFrozen: announceStop }));
    } else if (reason === 'signal') {
      exitCode = 128 + os.constants.signals[received[0]];
      report = [`Received ${received[0]} after ${seconds()} s; ending the test run.`];
      cleanup = await withSight(() => guard.endRun(forwarded[received[0]], timing.signalGraceMs, () => received.length > 1));
    } else if (reason === 'exit') {
      exitCode = runnerExit.code;
      if (runnerExit.error) report = [`Could not start ${process.execPath}: ${runnerExit.error.message}.`];
      cleanup = await withSight(async () => {
        await guard.observe();
        // The scan right after the end of the run is judged like every scan before it.
        const unreadable = reason === 'exit' ? ownership.readFailure() : null;
        if (unreadable) {
          reason = 'unreadable';
          exitCode = EXIT_GUARD_FAILURE;
          report.push(...notWatched(unreadable));
        }
        if (reason === 'unreadable') return guard.stopRun({ onFrozen: announceStop });
        leftovers = guard.alive().length;
        if (leftovers === 0) return { survivors: [], unverified: [] };
        report.push(`The test run ended and left ${leftovers} of its processes running; ending them.`);
        return guard.endRun('SIGTERM', timing.leftoverGraceMs);
      });
    } else {
      // Blind: the sampler that lost sight is not trusted any more.
      await replaceSampler();
      cleanup = await withSight(() => guard.stopRun({
        onFrozen: frozen => report.push(`Stopping the test run (${frozen.length} processes).`),
      }));
    }
  } catch (error) {
    // No sampler works. Nothing can be matched by pid and start time any more,
    // so only the runner's process group can still be ended. Whatever the run
    // started outside that group is left running: the guard is not able to
    // stop the whole run in this case, and says so.
    const outside = [...ownership.owned.values()].filter(row => !hasEnded(row) && !(row.infoError === 0 && row.pgid === runner.pid));
    report.push(`Cleanup could not be verified (${error.message}).`);
    report.push(signalGroupWhileHeld('SIGKILL')
      ? 'Killed the test runner\'s process group. Processes the run started outside that group were NOT touched and may still be running.'
      : 'Processes the run started may still be running. They were NOT touched.');
    if (outside.length > 0) report.push(`Last seen outside that group, not signalled: ${outside.map(row => row.pid).join(', ')}.`);
    cleanup = { survivors: [], unverified: [], unknown: true };
  }
  sampler.stop();
  if (standby) standby.stop();

  if (cleanup.survivors.length > 0) {
    report.push(`CLEANUP INCOMPLETE: ${cleanup.survivors.length} processes of the run were still there ${timing.confirmMs / 1000} s after SIGKILL: ${cleanup.survivors.map(row => row.pid).join(', ')}.`);
  }
  if (cleanup.unverified.length > 0) {
    report.push(`CLEANUP INCOMPLETE: ${cleanup.unverified.length} processes of the run could not be identified by start time and were left alone: ${cleanup.unverified.map(row => row.pid).join(', ')}.`);
  }
  const confirmed = !cleanup.unknown && cleanup.survivors.length === 0 && cleanup.unverified.length === 0;
  if (!confirmed) {
    // Whatever the tests said, a run whose processes may still be there is a failure of the guard.
    if (exitCode !== EXIT_GUARD_FAILURE) report.push(`Exit status ${EXIT_GUARD_FAILURE} replaces ${exitCode}.`);
    report.push('Not every process of the run is confirmed to have ended.');
    exitCode = EXIT_GUARD_FAILURE;
  } else if (reason !== 'exit' || leftovers > 0) {
    report.push('Every process of the run has ended.');
  }
  if (reason === 'memory') {
    report.push('A test that needs this much memory is almost always a bug: rerun the file with --test-name-pattern to find the test, or pass a higher limit if the need is real.');
  }
  if (report.length > 0) process.stderr.write(`\n${report.map(line => `run-tests: ${line}`).join('\n')}\n`);
  const { toolStats } = ownership;
  say(`memory guard: ${samples} samples, peak ${formatSize(peak.process)} in one process and ${formatSize(peak.total)} in total `
    + `(limits ${formatSize(limits.process)}, ${formatSize(limits.total)}, ${limits.deadlineSeconds} s)`
    + (toolStats.samples === 0 ? '' : `; these figures include an assumed ${SYSTEM_TOOL.assumedMegabytes} MB, not a measurement, for each `
      + `${SYSTEM_TOOL.path} the guard could not read (let through ${toolStats.samples} times, at most ${toolStats.longestSamples} samples in a row `
      + `and ${(toolStats.longestMilliseconds / 1000).toFixed(2)} s for any one)`));
  return exitCode;
}

if (require.main === module) {
  runGuard({ argv: process.argv.slice(2), env: process.env }).then(
    code => process.exit(code),
    error => {
      process.stderr.write(`run-tests: the memory guard failed (${error && error.stack ? error.stack : error}). Stopping the test run.\n`);
      process.exit(EXIT_GUARD_FAILURE);
    },
  );
}

module.exports = {
  runGuard,
  startCheckedSampler,
  parseArguments,
  parseRow,
  createOwnership,
  createGuard,
  measureRun,
  UsageError,
  TIMING,
  DEFAULT_PROCESS_LIMIT_MB,
  DEFAULT_TOTAL_LIMIT_MB,
  DEFAULT_DEADLINE_SECONDS,
  UNREADABLE_SAMPLES,
  EXIT_MEMORY_LIMIT,
  EXIT_DEADLINE,
  EXIT_GUARD_FAILURE,
  ZOMBIE,
  ESRCH,
  EPERM,
  SYSTEM_TOOL,
};
