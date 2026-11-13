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
// What it does. Twenty times a second it asks scripts/run-tests-sampler.py for
// every process on the machine: parent, process group, start time, resident
// size and memory footprint (macOS's own accounting, which includes compressed
// memory). From that it works out which processes belong to the run, and it
// stops the run when one of them, or all of them together, passes a limit, or
// when the deadline passes. It reads from outside the test processes, so it
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
// process of the run, repeated until a scan finds nothing new, so nothing can
// start more processes behind its back. Then SIGKILL, and then it scans until
// every process of the run is gone. Every signal is sent by the sampler, which
// reads the target's start time again and signals in the next system call.
// The same cleanup runs after a signal (once the run has had a few seconds to
// stop by itself) and for anything a finished run leaves behind.
//
// When it gives up on a run. It does not let a run continue that it cannot
// watch: no answer from the sampler for three seconds, or a process of the run
// whose start time and memory cannot be read. It stops the run and exits 125.
// It also exits 125, whatever the tests' own result, when it cannot confirm
// that every process of the run is gone.
//
// What it is not.
// - Not a hard cap. It samples. A run can pass its limit by whatever it
//   allocates between two samples (0.05 s) plus the time to freeze it.
// - Not able to see a process that never appears in a scan as part of the run:
//   one that is started, leaves the runner's process group, and loses its
//   parent, all between two samples. Such a process is not tracked, limited or
//   cleaned up.
// - Not proof against pid reuse in the last instant. Between the sampler's
//   check of a start time and its signal lie a few microseconds in which the
//   target could end and its pid pass to another process. Nothing available to
//   an ordinary program on macOS closes that gap.
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
  if (!/^\d+(?: \d+){9}$/.test(line)) return null;
  const [pid, ppid, pgid, uid, status, start, resident, footprint, infoError, usageError] = line.split(' ');
  return {
    pid: Number(pid),
    ppid: Number(ppid),
    pgid: Number(pgid),
    uid: Number(uid),
    status: Number(status),
    start,
    megabytes: Math.max(Number(resident), Number(footprint)) / MB,
    infoError: Number(infoError),
    usageError: Number(usageError),
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
    child.stdin.write(`${[words[0], id, ...words.slice(1)].join(' ')}\n`, error => { if (error) fail('sampler closed its input'); });
    return undefined;
  });

  child.on('error', error => fail(`sampler could not start (${error.code || error.message})`));
  child.on('exit', (code, signal) => fail(`sampler exited (${signal || code})`));
  child.stdin.on('error', () => fail('sampler closed its input'));
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
// when one of them cannot be read.
function createOwnership({ guardPid, samplerPid, runnerPid }) {
  let runnerStart = null;
  let anchored = false; // the runner leads the process group that carries its pid
  let owned = new Map();
  let latest = new Map();
  const identified = new Map(); // pid -> start time under which that pid was last identified as the run's
  const unread = new Map(); // pid -> { errno, samples } for processes of the run that cannot be read

  return {
    get owned() { return owned; },
    get runnerStart() { return runnerStart; },
    row(pid) { return latest.get(pid) || null; },
    setSampler(pid) { samplerPid = pid; },
    // A process known to be the run's that is in the runner's group right now,
    // while the runner still reserves the group's id: the evidence that a
    // signal to the whole group reaches only the run.
    groupMember(runnerExists) {
      if (!anchored || !runnerExists) return null;
      const inGroup = row => row.infoError === 0 && row.pgid === runnerPid && isIdentified(row) && !hasEnded(row);
      const runner = owned.get(runnerPid);
      return (runner && inGroup(runner) && runner) || [...owned.values()].find(inGroup) || null;
    },
    // A process of the run the guard cannot watch, or null.
    readFailure() {
      for (const [pid, entry] of unread) {
        if (entry.errno !== ESRCH || entry.samples > UNREADABLE_SAMPLES) return { pid, ...entry };
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
      const adopt = row => {
        if (!row || row.pid <= 1 || row.pid === guardPid || row.pid === samplerPid || next.has(row.pid)) return;
        next.set(row.pid, row);
        queue.push(row);
      };
      // Started by a process of the run, wherever it went afterwards.
      const descend = () => {
        while (queue.length > 0) {
          const parent = queue.pop();
          for (const child of children.get(parent.pid) || []) adopt(child);
        }
      };
      const runner = latest.get(runnerPid);
      if (runner && runnerStart === null && runner.infoError === 0 && isIdentified(runner) && runner.ppid === guardPid) {
        runnerStart = runner.start;
        anchored = runner.pgid === runnerPid;
      }
      const runnerSeen = Boolean(runner) && isIdentified(runner) && runner.start === runnerStart;
      if (runnerSeen) adopt(runner);
      // Identified as the run's before: same pid and the same start time,
      // however long ago and whether or not it showed up in every scan since.
      for (const row of rows) {
        if (isIdentified(row) && identified.get(row.pid) === row.start) adopt(row);
      }
      // In the runner's group, in a scan that shows the runner itself. Only the
      // run's own session can put a process there while the runner holds the
      // pid that names the group. Being told the runner exists is not enough:
      // word of its end arrives a moment after the system frees its pid.
      if (anchored && runnerExists && runnerSeen) {
        for (const row of rows) if (row.infoError === 0 && row.pgid === runnerPid) adopt(row);
      }
      descend();
      // In the run a moment ago and unreadable now. It cannot be shown to be
      // the same process, and it must not be quietly dropped: it stays, counted
      // as a process the guard cannot read.
      for (const row of rows) {
        if (before.has(row.pid) && !isIdentified(row) && !hasEnded(row)) adopt(row);
      }
      descend();
      for (const pid of [...unread.keys()]) if (!next.has(pid)) unread.delete(pid);
      for (const row of next.values()) {
        if (isIdentified(row)) identified.set(row.pid, row.start);
        if (hasEnded(row) || (isIdentified(row) && row.infoError === 0)) {
          unread.delete(row.pid);
        } else {
          unread.set(row.pid, { errno: row.usageError || row.infoError, samples: (unread.get(row.pid)?.samples || 0) + 1 });
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
  ownership, runnerPid, scan, signalProcesses, signalGroup, sleep, now, isRunnerGone,
  onAnomaly = () => {}, timing = TIMING,
}) {
  const alive = () => [...ownership.owned.values()].filter(row => !hasEnded(row));
  const identifiedRows = () => alive().filter(isIdentified);
  const unidentifiedRows = () => alive().filter(row => !isIdentified(row));
  const observe = async () => ownership.update(await scan(), !isRunnerGone());

  // Signals the runner's group in one call when that provably reaches only the
  // run, and every identified process not covered by that call one by one.
  // Returns the rows whose signal was sent, by either route.
  const signalRun = async (name, except = () => false) => {
    const rows = identifiedRows().filter(row => !except(row));
    const member = ownership.groupMember(!isRunnerGone());
    const grouped = member !== null && (await signalGroup(name, runnerPid, member)) === 'sent';
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
  let sampler;
  try {
    sampler = await openSampler();
  } catch (error) {
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
  // Without a sampler nothing can be matched by pid and start time. What is
  // left is the runner's process group, signalled without that check and only
  // while the runner has not been collected, so that its number is still the
  // run's. Processes the run started outside the group are not reached.
  const killGroupUnchecked = () => {
    if (runnerCollected()) return false;
    try { process.kill(-runner.pid, 'SIGKILL'); return true; } catch { return false; }
  };
  // Last resort for a guard that is going down with the run still up.
  process.on('exit', killGroupUnchecked);
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

  const ownership = createOwnership({ guardPid: process.pid, samplerPid: sampler.pid, runnerPid: runner.pid });
  const guard = createGuard({
    ownership,
    runnerPid: runner.pid,
    scan: () => sampler.scan(),
    signalProcesses: (name, rows) => sampler.signalProcesses(name, rows),
    signalGroup: (name, pgid, member) => sampler.signalGroup(name, pgid, member),
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
  let report = [];
  let offender = null;
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
      let total = 0;
      let largest = null;
      for (const row of owned.values()) {
        total += row.megabytes;
        if (largest === null || row.megabytes > largest.megabytes) largest = row;
      }
      if (largest) peak.process = Math.max(peak.process, largest.megabytes);
      peak.total = Math.max(peak.total, total);
      const unreadable = ownership.readFailure();
      if (runnerExit) reason = 'exit';
      else if (received.length > 0) reason = 'signal';
      else if (unreadable) {
        reason = 'unreadable';
        report = [`GUARD CANNOT READ PROCESS ${unreadable.pid} OF THE RUN after ${seconds()} s (errno ${unreadable.errno}, ${unreadable.samples} samples in a row). Its memory is unknown.`];
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
  // sampler; if the current one fails, it is replaced once.
  const withSight = async action => {
    try {
      return await action();
    } catch (error) {
      sampler.stop();
      sampler = await openSampler();
      ownership.setSampler(sampler.pid);
      say(`the sampler failed during cleanup (${error.message}); continuing with a new one`);
      return action();
    }
  };
  let exitCode = EXIT_GUARD_FAILURE;
  let cleanup = { survivors: [], unverified: [] };
  let leftovers = 0;
  try {
    if (reason === 'memory' || reason === 'deadline' || reason === 'unreadable') {
      if (reason === 'memory') exitCode = EXIT_MEMORY_LIMIT;
      if (reason === 'deadline') exitCode = EXIT_DEADLINE;
      cleanup = await withSight(() => guard.stopRun({
        onFrozen: frozen => {
          if (offender) report.push(`  ${describeProcess(offender)}`);
          offender = null;
          report.push(`Stopping the test run (${frozen.length} processes).`);
        },
      }));
    } else if (reason === 'signal') {
      exitCode = 128 + os.constants.signals[received[0]];
      report = [`Received ${received[0]} after ${seconds()} s; ending the test run.`];
      cleanup = await withSight(() => guard.endRun(forwarded[received[0]], timing.signalGraceMs, () => received.length > 1));
    } else if (reason === 'exit') {
      exitCode = runnerExit.code;
      if (runnerExit.error) report = [`Could not start ${process.execPath}: ${runnerExit.error.message}.`];
      cleanup = await withSight(async () => {
        await guard.observe();
        leftovers = guard.alive().length;
        if (leftovers === 0) return { survivors: [], unverified: [] };
        report.push(`The test run ended and left ${leftovers} of its processes running; ending them.`);
        return guard.endRun('SIGTERM', timing.leftoverGraceMs);
      });
    } else {
      // Blind: the old sampler is not trusted any more.
      sampler.stop();
      sampler = await openSampler();
      ownership.setSampler(sampler.pid);
      cleanup = await withSight(() => guard.stopRun({
        onFrozen: frozen => report.push(`Stopping the test run (${frozen.length} processes).`),
      }));
    }
  } catch (error) {
    report.push(`Cleanup could not be verified (${error.message}).`);
    report.push(killGroupUnchecked()
      ? 'Killed the test runner\'s process group. Processes the run started outside that group were NOT touched and may still be running.'
      : 'Processes the run started may still be running. They were NOT touched.');
    cleanup = { survivors: [], unverified: [], unknown: true };
  }
  sampler.stop();

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
    report.push('Not every process of the run is confirmed gone.');
    exitCode = EXIT_GUARD_FAILURE;
  } else if (reason !== 'exit' || leftovers > 0) {
    report.push('Every process of the run is gone.');
  }
  if (reason === 'memory') {
    report.push('A test that needs this much memory is almost always a bug: rerun the file with --test-name-pattern to find the test, or pass a higher limit if the need is real.');
  }
  if (report.length > 0) process.stderr.write(`\n${report.map(line => `run-tests: ${line}`).join('\n')}\n`);
  say(`memory guard: ${samples} samples, peak ${formatSize(peak.process)} in one process and ${formatSize(peak.total)} in total `
    + `(limits ${formatSize(limits.process)}, ${formatSize(limits.total)}, ${limits.deadlineSeconds} s)`);
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
};
