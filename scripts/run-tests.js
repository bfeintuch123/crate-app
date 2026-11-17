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
// so and exits 125. Signals to a single process, and to the group once one of
// its members is identified, are sent by the sampler, which reads the target's
// start time again and signals in the next system call. One kind of signal
// this process sends itself: to the runner's group by its number alone, only
// while it has not collected the runner, so that the number cannot have passed
// to anyone else. That is how the group is reached when the sampler's group
// signal is not confirmed as sent (no member of the group can be identified,
// or the member's check does not hold), when no sampler works, and when the
// guard itself goes down.
// The same cleanup runs after a signal (once the run has had a few seconds to
// stop by itself) and for anything a finished run leaves behind.
//
// When it gives up on a run. It does not let a run continue that it cannot
// watch: no answer from the sampler for three seconds, or a process of the run
// whose start time and memory cannot be read, the test runner itself included
// from the first scan on. It stops the run and exits 125. One allowance: a
// process of the run for which the system answers "no such process", which
// is how a process reads while it is ending or when it is collected between
// two of the sampler's reads, is given three samples in a row before that
// counts, and so is a runner that a scan does not list. A second allowance is
// for a process that is exiting (the kernel has marked it dead, so it can run
// none of its own code any more; see the sampler): a process of the run other
// than the runner, read in full before, that libproc no longer describes while
// its usage still answers with the same start time and an exit time. It is let
// through for up to one second, measured from the moment the guard took in the
// first scan that showed it so, once per process (pid and start time) for as
// long as its pid is listed; those scans do not count towards the three. It is
// counted meanwhile at its last full reading, or at what it holds then if that
// is more. The guard keeps that second by its own clock: when it runs out, the
// guard stops the run then, like any process it cannot read, whether or not a
// scan has come back, at most 1 ms plus the delay of its own event loop late.
// A scan still in progress then is abandoned, not taken as news that the
// process has gone, and the sampler standing by takes over the cleanup.
// A process whose usage is denied gets no allowance. All of that also holds
// when the same scan shows that the run has just ended by itself or that a
// signal has arrived, and for the one scan the guard makes right after a run
// has ended: a run that was not watched to its end does not get to report its
// own result. While the guard is ending a run, its scans follow each other
// too closely for "three samples" to mean anything; a process it cannot read
// then counts only if it is still running at the end.
//
// When a process that answers "no such process" stops the run, the report
// also says what the guard knew of it: when it was last read in full (parent,
// group, start time, memory), both errnos and the sizes of the last scans that
// could not read it, what each scan from the stop to the end of the cleanup
// showed of it, what the sampler says of it once the cleanup is over and its
// outcome settled (whether it is listed, both reads, the process table's
// record and the executable path, never its arguments or environment), and
// how long the last scans took. Nothing about the stop waits for any of it:
// the one question to the sampler comes after the cleanup and is bounded at
// half a second, so it can delay the guard's own exit by that much and change
// nothing else. When processes were let through as exiting, the summary at the
// end says how many, the longest one was seen so, and the largest usage read
// meanwhile against its last full reading.
//
// The one exception is the system's own `ps`. Tests start it, and macOS
// installs it set-uid root, so this user may not read its memory. A process is
// let through as that tool only when the system reports its executable as
// exactly /bin/ps, it runs as root for this user (real owner this user), the
// same scan shows that it was started by a process of the run or is in the
// runner's process group together with the runner, and it has been there for
// no longer than two seconds or forty samples, with no more than eight at
// once. It is counted at an assumed 32 MB,
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
//   parent, all between two samples. Or one that stays in the runner's group,
//   loses its parent, and is first scanned when the runner has already ended:
//   the group counts only in a scan that also shows the runner. Such a process
//   is not tracked, limited or cleaned up.
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
//   One more, a matter of microseconds: a `ps` that has ended is collected by
//   its parent after the sampler was denied its usage and before it asks the
//   process table. The row then says "not there" and "denied" and nothing
//   says "ended", and the guard stops the run.
// - Not able to end the whole run when no sampler works any more (the one in
//   use, the one standing by, and a newly started one all fail). It then kills
//   the runner's process group, leaves whatever the run started outside that
//   group as it is, lists it, and exits 125. "As it is" is running, or frozen
//   when the samplers failed after the freeze had begun; the report calls such
//   processes "NOT touched" in both cases.
// - Not a guard at all if it is itself killed with SIGKILL or frozen: the run
//   then continues unwatched. The run has its own session, so a SIGKILL sent
//   to the guard's process group does not end the run either, as it would end
//   a plain `node --test`. To end a guarded run, send the guard SIGINT,
//   SIGTERM, SIGHUP or SIGQUIT: it then ends the run and cleans up.
// - macOS only, and it needs a Python 3 for its sampler. Elsewhere, or when
//   the sampler cannot be started, it refuses to run the tests rather than
//   run them unguarded. There is no supported way to run these tests without
//   it.
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
// A process that is exiting: the kernel has marked it dead and it can run no
// more of its own code, but it is not yet a zombie (see the sampler). It is
// let through for this long from the first scan that shows it so, once per
// process, counted at its last full reading or more; longer, and it stops the
// run as any process the guard cannot read. The guard's main loop keeps the
// time with a timer, so the stop comes at the end of this time plus at most
// 1 ms and the delay of the guard's own event loop, whether or not a scan has
// come back. Only a process of the run that the guard has read in full, with
// the same start time, and not the runner.
const EXITING = { milliseconds: 1000 };
const ALLOWANCE_OVER = Symbol('exiting allowance over');
// How many recent scans the report of an unreadable process lists, at most,
// how many changes of its state during a cleanup, how long the guard waits for
// the sampler to describe it after the cleanup, and how much of its path shows.
const REPORTED_SCANS = 8;
const REPORTED_CHANGES = 8;
const DESCRIBE_TIMEOUT_MS = 500;
const REPORTED_PATH_LENGTH = 300;
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
// The largest pid the system's pid type can hold; the sampler refuses larger.
const MAX_PID = 2147483647;
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

// A size that passed a limit, to be shown next to that limit: whole megabytes,
// rounded up. Rounded to the nearest, 128.3 MB over a limit of 128 MB read
// "reached 128 MB (limit 128 MB)".
function formatOver(megabytes) {
  return `${Math.ceil(megabytes)} MB`;
}

// One line of a scan. `start` stays text: it identifies the process and must
// compare exactly, whatever its size.
function parseRow(line) {
  if (!/^\d+(?: \d+){10} [01] (?:-|[A-Za-z0-9\/%._~-]+)$/.test(line)) return null;
  const [pid, ppid, pgid, uid, status, start, resident, footprint, infoError, usageError, ruid, exiting, encodedPath] = line.split(' ');
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
    // The two sizes `megabytes` is made of, kept for reports only.
    resident: Number(resident) / MB,
    footprint: Number(footprint) / MB,
    infoError: Number(infoError),
    usageError: Number(usageError),
    // The usage read carried an exit time: see the sampler.
    exiting: exiting === '1',
    path,
  };
}

// The sampler's answer about one pid, for the report only (see the sampler's
// `describe`): null when it is not the expected shape, numbers out of range
// included. Never throws, so that an odd answer cannot take the sampler down
// or the report with it.
const UINT32_MAX = 4294967295;
function parseDescription(words) {
  if (!Array.isArray(words) || words.length !== 6) return null;
  const [listed, info, usage, record, encodedPath, timebase] = words;
  const base = /^(\d{1,10})\/(\d{1,10})$/.exec(timebase);
  if (!/^[01-]$/.test(listed) || !/^\d{1,10}$/.test(info) || !/^\d{1,10}$/.test(usage) || !base) return null;
  const [numer, denom] = [Number(base[1]), Number(base[2])];
  if (numer > UINT32_MAX || denom > UINT32_MAX) return null;
  let fields = null;
  if (record !== '-' && record !== '?') {
    if (!/^-?\d{1,10}(?:,-?\d{1,10}){4}$/.test(record)) return null;
    fields = record.split(',').map(Number);
  }
  let executable = null;
  if (encodedPath !== '-') {
    try {
      executable = decodeURIComponent(encodedPath);
    } catch {
      return null;
    }
  }
  const [ppid, pgid, uid, ruid, status] = fields || [];
  return {
    listed: listed === '-' ? null : listed === '1',
    info: Number(info),
    usage: Number(usage),
    // 'none': the table answered and has no record of it; 'unreadable': no whole record of that pid could be read.
    record: fields ? { ppid, pgid, uid, ruid, status } : record === '-' ? 'none' : 'unreadable',
    path: executable,
    // 0/0 when it could not be read.
    timebase: { numer, denom },
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
  const describeReader = id => line => {
    const words = line.split(' ');
    if (words[0] !== 'described' || Number(words[1]) !== id) return undefined;
    return parseDescription(words.slice(2));
  };
  const target = row => `${row.pid}:${row.start}`;
  const short = name => name.replace(/^SIG/, '');

  return {
    pid: child.pid,
    // Gone for good, as opposed to slow to answer.
    get dead() { return failure !== null; },
    scan: (timeoutMs = requestTimeoutMs) => request(['scan'], scanReader, timeoutMs),
    // What the system says about one pid right now, for a report.
    // Never sent for a pid the sampler would refuse, which would end it.
    describe: (pid, timeoutMs = requestTimeoutMs) => (Number.isInteger(pid) && pid > 1 && pid <= MAX_PID
      ? request(['describe', String(pid)], describeReader, timeoutMs) : Promise.resolve(null)),
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
  // ending, allowed, exiting, exitingSince, info, usage, scans }. `samples`
  // counts the scans in a row that could not read it and `since` is the time
  // of the first; `ending` counts those in a row that said it no longer exists,
  // apart from scans that showed it exiting; `allowed` marks the system tool
  // while it is let through. `exiting` marks a process that this scan shows
  // exiting, and `exitingSince` is the time of the first scan that did (see
  // EXITING). `info`, `usage` and `scans` (the last few scans' errnos and
  // sizes) are only reported, never decided on.
  const unread = new Map();
  // pid -> { row, at }: the latest scan that read that process of the run in
  // full (parent, group, state, start time and memory), and when.
  let lastRead = new Map();
  let latestTime = null;
  // Processes let through as exiting: how many, the longest one was seen
  // exiting, and the largest usage read while exiting with its last full
  // reading. Reported in the summary.
  const exitingStats = { processes: 0, longestMilliseconds: 0, largest: null };
  // pid -> { start, since, counted }: each process of the run seen exiting, by
  // pid and start time, with the time of the first scan that showed it so and
  // the largest figure it was counted at meanwhile. Kept while the pid is
  // listed with that start time (or with no start time readable), so that one
  // process gets one second in all, however its readings come and go.
  const exitingIdentities = new Map();
  // An entry's allowance as a stop, when it has run out by `time`, else null.
  const lapsed = (pid, entry, time) => (entry.exitingSince !== null && time - entry.exitingSince > EXITING.milliseconds
    ? { pid, problem: 'unreadable', errno: entry.errno, samples: entry.samples,
      exitingMilliseconds: time - entry.exitingSince, countedMegabytes: entry.counted }
    : null);

  return {
    get owned() { return owned; },
    get runnerStart() { return runnerStart; },
    // How often a system tool was let through (once per tool per scan, the
    // scans of a cleanup included), and the longest any one of them stayed.
    get toolStats() { return toolStats; },
    get exitingStats() { return exitingStats; },
    // False once a scan showed the runner outside the group it was started to lead.
    get groupUsable() { return anchored !== false; },
    // What is known about a process of the run that cannot be read, for the
    // report. Nothing the guard decides depends on it.
    unreadDetails(pid) {
      const entry = unread.get(pid);
      if (!entry) return null;
      const read = lastRead.get(pid);
      return {
        errno: entry.errno, samples: entry.samples, ending: entry.ending, info: entry.info, usage: entry.usage,
        exitingSince: entry.exitingSince, since: entry.since, scans: entry.scans.map(scan => ({ ...scan })), at: latestTime,
        lastRead: read ? { ...read.row, at: read.at } : null,
      };
    },
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
        // Exiting for longer than allowed, whatever this scan shows of it.
        const stop = lapsed(pid, entry, latestTime);
        if (stop) return stop;
        if (entry.exiting) continue;
        if (entry.errno !== ESRCH || entry.ending > UNREADABLE_SAMPLES) return { pid, problem: 'unreadable', errno: entry.errno, samples: entry.samples };
      }
      return null;
    },
    // When the earliest exiting allowance of a process that still cannot be
    // read runs out, on this ownership's clock, or null. The guard keeps this
    // time itself, so that the allowance ends by the clock even while a scan
    // has not come back.
    exitingDeadline() {
      let deadline = null;
      for (const entry of unread.values()) {
        if (entry.allowed || entry.exitingSince === null) continue;
        const end = entry.exitingSince + EXITING.milliseconds;
        if (deadline === null || end < deadline) deadline = end;
      }
      return deadline;
    },
    // The stop for an allowance that has run out by `time`, as readFailure()
    // gives it, or null. For the guard's clock between scans.
    expiredExiting(time) {
      for (const [pid, entry] of unread) {
        if (entry.allowed) continue;
        const stop = lapsed(pid, entry, time);
        if (stop) return stop;
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
      latestTime = time;
      let allowed = 0;
      const readNow = new Map();
      for (const pid of [...unread.keys()]) if (!next.has(pid)) unread.delete(pid);
      // An exiting process is one process from the first scan that shows it so
      // to the end of its pid: forget it only when its pid is no longer listed,
      // or is listed with another start time.
      for (const [pid, identity] of [...exitingIdentities]) {
        const row = latest.get(pid);
        if (!row || (row.usageError === 0 && row.start !== identity.start)) exitingIdentities.delete(pid);
      }
      for (const row of next.values()) {
        if (isIdentified(row) && row.infoError === 0 && !hasEnded(row)) {
          // `megabytes` is what a full reading lets the process be counted at
          // while exiting. The kernel publishes the figures it caches for an
          // exiting process (footprint 0, resident size, an exit time) a moment
          // before libproc stops describing it, so a full reading can already
          // carry them: such a reading never lowers the figure.
          const previous = lastRead.get(row.pid);
          const keep = row.exiting && previous && previous.row.start === row.start;
          readNow.set(row.pid, { row, at: time, megabytes: keep ? Math.max(previous.megabytes, row.megabytes) : row.megabytes });
        } else if (lastRead.has(row.pid)) readNow.set(row.pid, lastRead.get(row.pid));
        // Never learned from a process that has ended: its start time and its
        // state come from two reads, and only a live process is worth knowing again.
        if (isIdentified(row) && !hasEnded(row)) identified.set(row.pid, row.start);
        if (hasEnded(row) || (isIdentified(row) && row.infoError === 0)) {
          unread.delete(row.pid);
          continue;
        }
        const errno = row.usageError || row.infoError;
        const earlier = unread.get(row.pid) || { samples: 0, since: time, ending: 0, exitingSince: null, scans: [] };
        // Exiting (see EXITING): not the runner; libproc no longer describes
        // it, while its usage, read in this same row, carries an exit time and
        // the start time of its last full reading.
        const full = lastRead.get(row.pid);
        const exiting = row.pid !== runnerPid && row.infoError === ESRCH && row.usageError === 0 && row.exiting === true
          && full !== undefined && full.row.start === row.start;
        const used = { megabytes: row.megabytes, resident: row.resident, footprint: row.footprint };
        let identity = exitingIdentities.get(row.pid) || null;
        if (exiting && identity === null) {
          identity = { start: row.start, since: time, counted: 0 };
          exitingIdentities.set(row.pid, identity);
          exitingStats.processes += 1;
        }
        if (exiting) {
          // Counted at its last full reading, or at what it holds now if that is more.
          row.megabytes = Math.max(full.megabytes, row.megabytes);
          identity.counted = Math.max(identity.counted, row.megabytes);
        }
        const entry = {
          errno, samples: earlier.samples + 1, since: earlier.since, allowed: false,
          ending: exiting ? earlier.ending : (errno === ESRCH ? earlier.ending + 1 : 0),
          exiting, exitingSince: identity ? identity.since : null, counted: identity ? identity.counted : null,
          info: row.infoError, usage: row.usageError,
          scans: [...earlier.scans.slice(1 - REPORTED_SCANS), {
            at: time, info: row.infoError, usage: row.usageError, exiting,
            resident: row.usageError === 0 ? row.resident : null, footprint: row.usageError === 0 ? row.footprint : null,
          }],
        };
        unread.set(row.pid, entry);
        if (exiting) {
          exitingStats.longestMilliseconds = Math.max(exitingStats.longestMilliseconds, time - entry.exitingSince);
          if (exitingStats.largest === null || used.megabytes > exitingStats.largest.megabytes) {
            exitingStats.largest = { ...used, lastFull: full.megabytes };
          }
        }
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
      lastRead = readNow;
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

// One word or phrase for what a scan shows of `pid`, for the report.
function stateIn(rows, pid) {
  const row = rows.find(item => item.pid === pid);
  if (!row) return 'not listed';
  if (hasEnded(row)) return 'ended';
  if (isIdentified(row) && row.infoError === 0) return 'readable';
  return `listed, unreadable (process info errno ${row.infoError}, usage errno ${row.usageError})`;
}

// Notes one scan of a cleanup in `runs`, a list of { state, count, first, last }.
function noteState(record, state, at) {
  const last = record.runs[record.runs.length - 1];
  record.scans += 1;
  if (last && last.state === state) {
    last.count += 1;
    last.last = at;
  } else if (record.runs.length < REPORTED_CHANGES) {
    record.runs.push({ state, count: 1, first: at, last: at });
  } else {
    record.dropped += 1;
  }
}

// Text from the system shown as it is, but with control characters written
// out, so that it cannot add lines to the report or change how it shows.
function printable(text) {
  return String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\\]/g,
    character => (character === '\\' ? '\\\\' : `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`));
}

// The report of a process of the run that stopped the run by answering "no
// such process": what the guard and its sampler knew of it. Facts only,
// bounded, without arguments or environment. Times are in milliseconds on one
// clock, relative to the stop decision (`stoppedAt`; the last scan when it is
// not given) unless said otherwise.
function describeUnreadable({ pid, runnerPid, runnerStart, details, scans, after, cleanup, stoppedAt }) {
  const ms = value => `${Math.round(value)} ms`;
  const size = value => `${value.toFixed(1)} MB`;
  const lines = [`About process ${pid}, which stopped the run (for diagnosis; it changes nothing about the stop):`];
  const stop = details && Number.isFinite(stoppedAt) ? stoppedAt : details && details.at;
  if (details) {
    lines.push(`  unreadable in ${details.samples} scans in a row over ${ms(details.at - details.since)}; `
      + (details.exitingSince === null ? 'never shown exiting'
        : `shown exiting from ${ms(details.exitingSince - details.since)} after the first (${EXITING.milliseconds} ms allowed)`)
      + (Number.isFinite(stoppedAt) ? `; the stop came ${ms(stoppedAt - details.at)} after the last of them` : '')
      + `; the last ${details.scans.length}, from the first:`);
    for (const scan of details.scans) {
      lines.push(`    +${ms(scan.at - details.since)}: process info errno ${scan.info}, usage errno ${scan.usage}`
        + (scan.usage === 0 ? `, ${size(scan.resident)} resident, ${size(scan.footprint)} footprint` : '')
        + (scan.exiting ? ', exiting' : ''));
    }
    const read = details.lastRead;
    if (read) {
      let started = '';
      const base = after && after.timebase;
      if (base && base.numer > 0 && base.denom > 0 && runnerStart && /^\d+$/.test(runnerStart) && /^[1-9]\d*$/.test(read.start)) {
        const nanoseconds = (BigInt(read.start) - BigInt(runnerStart)) * BigInt(base.numer) / BigInt(base.denom);
        started = `, ${(Number(nanoseconds) / 1e9).toFixed(3)} s after the test runner started`;
      }
      lines.push(`  last read in full ${ms(stop - read.at)} before the stop: parent ${read.ppid}, process group ${read.pgid}`
        + `${read.pgid === runnerPid ? ' (the test runner\'s)' : ''}, uid ${read.uid}, ${size(read.megabytes)}`
        + (Number.isFinite(read.resident) ? ` (${size(read.resident)} resident, ${size(read.footprint)} footprint)` : '')
        + `, start ${read.start} (Mach absolute time)${started}`);
    } else {
      lines.push('  never read in full while it was a process of the run');
    }
  }
  lines.push('  session: not known (the sampler does not read it)');
  if (cleanup && cleanup.scans > 0 && details) {
    const runs = cleanup.runs.map(run => `${run.state} in ${run.count} (+${Math.round(run.first - stop)} to +${Math.round(run.last - stop)} ms)`);
    lines.push(`  in the ${cleanup.scans} scans from the stop to the end of the cleanup (freeze, kill, confirmation): ${runs.join('; ')}`
      + `${cleanup.dropped > 0 ? `; ${cleanup.dropped} more scans after ${REPORTED_CHANGES} changes not itemized` : ''}`);
  } else {
    lines.push('  in the scans from the stop to the end of the cleanup: none recorded');
  }
  const when = after && details && Number.isFinite(after.at) ? ` (+${Math.round(after.at - stop)} ms)` : '';
  if (!after) {
    lines.push('  after the cleanup: not asked');
  } else if (after.error) {
    lines.push(`  after the cleanup${when}: the sampler did not describe it (${printable(after.error)})`);
  } else {
    const listed = after.listed === null ? 'listing unknown' : after.listed ? 'listed' : 'not listed';
    const record = after.record === 'none' ? 'no record'
      : after.record === 'unreadable' ? 'no whole record of that pid could be read'
        : `state ${after.record.status}, parent ${after.record.ppid}, group ${after.record.pgid}, uid ${after.record.uid}, real uid ${after.record.ruid}`;
    const path = after.path === null ? 'not readable' : printable(after.path);
    const executable = path.length > REPORTED_PATH_LENGTH ? `${path.slice(0, REPORTED_PATH_LENGTH)}...` : path;
    lines.push(`  after the cleanup${when}: ${listed}, process info errno ${after.info}, usage errno ${after.usage}; `
      + `process table: ${record}; executable: ${executable}`);
  }
  if (scans.length > 0) {
    const durations = scans.map(scan => scan.ms);
    const gaps = scans.slice(1).map((scan, index) => scan.begun - scans[index].begun);
    const range = values => `${Math.min(...values).toFixed(1)} to ${Math.max(...values).toFixed(1)} ms`;
    lines.push(`  the last ${scans.length} scans before the stop took ${range(durations)}`
      + `${gaps.length > 0 ? ` and began ${range(gaps)} apart` : ''}`);
  }
  return lines;
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
  // For the report only: how long the last scans took, and, once a process
  // that answers "no such process" has stopped the run, what each later scan
  // showed of it. Nothing the guard decides depends on these.
  const recentScans = [];
  let diagnosis = null;
  const guard = createGuard({
    ownership,
    runnerPid: runner.pid,
    scan: async () => {
      const begun = performance.now();
      const rows = await sampler.scan();
      const done = performance.now();
      recentScans.push({ begun, ms: done - begun });
      if (recentScans.length > REPORTED_SCANS) recentScans.shift();
      if (diagnosis) noteState(diagnosis.cleanup, stateIn(rows, diagnosis.pid), done);
      return rows;
    },
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
    if (unreadable.problem === 'unreadable' && unreadable.errno === ESRCH && !diagnosis) {
      diagnosis = {
        pid: unreadable.pid,
        runnerPid: runner.pid,
        runnerStart: ownership.runnerStart,
        details: ownership.unreadDetails(unreadable.pid),
        scans: recentScans.map(scan => ({ ...scan })),
        stoppedAt: performance.now(),
        after: null,
        cleanup: { scans: 0, runs: [], dropped: 0 },
      };
    }
    const memory = unreadable.exitingMilliseconds === undefined ? 'Its memory is unknown.'
      : `It had been exiting for ${Math.round(unreadable.exitingMilliseconds)} ms, longer than the ${EXITING.milliseconds} ms allowed; `
        + `while exiting it was counted at up to ${formatOver(unreadable.countedMegabytes)}.`;
    const lines = [{
      unreadable: `GUARD CANNOT READ PROCESS ${unreadable.pid} OF THE RUN after ${seconds()} s (errno ${unreadable.errno}, ${unreadable.samples} samples in a row). ${memory}`,
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

  // A scan still in progress when an exiting allowance ran out (see below).
  let abandoned = null;
  while (reason === null) {
    // An exiting allowance ends by the clock (see EXITING): checked before
    // every scan, and raced against any scan that is in progress when it runs
    // out, so that a scan that does not come back cannot extend it. A scan
    // that does not come back is not taken to mean the process has gone.
    const lapsedBefore = ownership.expiredExiting(performance.now());
    if (lapsedBefore) {
      reason = 'unreadable';
      report = notWatched(lapsedBefore);
      break;
    }
    let owned = null;
    try {
      const observing = guard.observe();
      const due = ownership.exitingDeadline();
      if (due === null) {
        owned = await observing;
      } else {
        let timer;
        const ran = await Promise.race([observing, new Promise(resolve => {
          timer = setTimeout(() => resolve(ALLOWANCE_OVER), Math.max(0, due - performance.now()) + 1);
        })]);
        clearTimeout(timer);
        const lapsedDuring = ran === ALLOWANCE_OVER ? ownership.expiredExiting(performance.now()) : null;
        if (lapsedDuring) {
          observing.catch(() => {});
          abandoned = observing;
          reason = 'unreadable';
          report = notWatched(lapsedDuring);
          break;
        }
        owned = ran === ALLOWANCE_OVER ? await observing : ran;
      }
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
        report = [`MEMORY LIMIT EXCEEDED after ${seconds()} s: process ${largest.pid} reached ${formatOver(largest.megabytes)} (limit ${limits.process} MB per process).`];
      } else if (total > limits.total) {
        reason = 'memory';
        offender = largest.pid;
        report = [`MEMORY LIMIT EXCEEDED after ${seconds()} s: the run reached ${formatOver(total)} across ${owned.size} processes (limit ${limits.total} MB in total).`];
      } else if (Date.now() - started > limits.deadlineSeconds * 1000) {
        reason = 'deadline';
        report = [`DEADLINE PASSED after ${seconds()} s (limit ${limits.deadlineSeconds} s).`];
      }
    } else if (runnerExit) {
      reason = 'exit';
    } else if (received.length > 0) {
      reason = 'signal';
    }
    if (reason === null) {
      const due = ownership.exitingDeadline();
      await sleep(due === null ? timing.sampleIntervalMs
        : Math.min(timing.sampleIntervalMs, Math.max(0, due - performance.now()) + 1));
    }
  }

  // The summary's figures for processes let through while exiting, as they
  // stand when the guard stops watching: what the cleanup scans show of them
  // after this is not an allowance.
  let exitingSeen = structuredClone(ownership.exitingStats);
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
  // One question to the sampler for the report, asked only after the cleanup
  // is over and its outcome settled, so that nothing about the stop waits for
  // it. Bounded here as well as by the sampler, and never thrown: a sampler
  // that stalls, ends or throws costs at most this long and is reported.
  const describeAfterCleanup = async pid => {
    if (sampler.dead || typeof sampler.describe !== 'function') return { error: 'no sampler could be asked' };
    const asked = Promise.resolve().then(() => sampler.describe(pid, DESCRIBE_TIMEOUT_MS));
    asked.catch(() => {});
    let timer;
    const late = new Promise(resolve => {
      timer = setTimeout(() => resolve({ error: `no answer within ${DESCRIBE_TIMEOUT_MS} ms` }), DESCRIBE_TIMEOUT_MS);
    });
    try {
      return (await Promise.race([asked, late])) || { error: 'its answer was not understood' };
    } catch (error) {
      return { error: String(error && error.message) };
    } finally {
      clearTimeout(timer);
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
      // The sampler answers one request at a time, and the scan an exiting
      // allowance ran out during may never come back: the one standing by
      // takes over at once, as when the guard loses sight of the run.
      if (abandoned) {
        report.push('A scan was still in progress when the allowance ran out; the sampler standing by takes over.');
        await replaceSampler();
      }
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
        if (reason === 'exit') exitingSeen = structuredClone(ownership.exitingStats);
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
    // started outside that group is left as it is (running, or frozen if the
    // freeze had already reached it): the guard is not able to stop the whole
    // run in this case, and says so.
    const outside = [...ownership.owned.values()].filter(row => !hasEnded(row) && !(row.infoError === 0 && row.pgid === runner.pid));
    report.push(`Cleanup could not be verified (${error.message}).`);
    report.push(signalGroupWhileHeld('SIGKILL')
      ? 'Killed the test runner\'s process group. Processes the run started outside that group were NOT touched and may still be running.'
      : 'Processes the run started may still be running. They were NOT touched.');
    if (outside.length > 0) report.push(`Last seen outside that group, not signalled: ${outside.map(row => row.pid).join(', ')}.`);
    cleanup = { survivors: [], unverified: [], unknown: true };
  }
  if (diagnosis && !cleanup.unknown) {
    const asked = performance.now();
    diagnosis.after = { ...(await describeAfterCleanup(diagnosis.pid)), at: asked };
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
  if (diagnosis) report.push(...describeUnreadable(diagnosis));
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
  if (exitingSeen.processes > 0) {
    const { largest } = exitingSeen;
    say(`memory guard: ${exitingSeen.processes} processes were let through while exiting, the longest seen exiting for `
      + `${Math.round(exitingSeen.longestMilliseconds)} ms (${EXITING.milliseconds} ms allowed); the largest usage read while exiting was `
      + `${largest.resident.toFixed(1)} MB resident and ${largest.footprint.toFixed(1)} MB footprint, against ${largest.lastFull.toFixed(1)} MB at its last full reading`);
  }
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
  formatOver,
  describeUnreadable,
  parseDescription,
  printable,
  EXITING,
  MAX_PID,
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
