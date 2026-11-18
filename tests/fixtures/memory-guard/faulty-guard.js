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
//   CRATE_GUARD_FAULT=unreadable-as-run-ends:<role>     one scan made while the run is alive cannot read that process, and its
//                                                       answer reaches the guard only when the test run has ended
//   CRATE_GUARD_FAULT=unreadable-then-gone:<role>       the same, and that process has ended as well by then
//   CRATE_GUARD_FAULT=unreadable-as-signal-arrives:<role>  the same, but the answer arrives when the guard has received SIGTERM
//   CRATE_GUARD_FAULT=unreadable-right-after-run:<role>  one scan made while the run is alive reaches the guard, as it is, only
//                                                       when the test run has ended; the scan the guard makes next, which is
//                                                       the one it makes for a run that has ended, cannot read that process
//   CRATE_GUARD_FAULT=unreadable-runner            the test runner itself cannot be read, from the first scan
//   CRATE_GUARD_FAULT=no-such-process:<role>       once the fixture's tree is up, that process is still listed but both reads
//                                                  answer "no such process", as the sampler reports it, for as long as it lives
//   CRATE_GUARD_FAULT=exiting:<role>               once the fixture's tree is up, that process reads as an exiting one does (see the
//                                                  sampler): no process info, usage with its start time, resident size, no
//                                                  footprint and an exit time, for as long as it lives
//   CRATE_GUARD_FAULT=exiting-then-gone:<role>     the same for six scans, after which no scan lists it (it is still running)
//   CRATE_GUARD_FAULT=exiting-then-stall:<role>    the same for two scans, after which every scan of the sampler in use fails
//                                                  as a real one does that does not answer: after the request timeout
//   CRATE_GUARD_FAULT=stall:<role>                 once the tree is up (and that process listed), every scan of the sampler in
//                                                  use fails in the same way; no process is exiting
//   CRATE_GUARD_FAULT=exiting-then-late:<role>     once the tree is up, one scan reads that process as exiting, and the guard's
//                                                  clock stands still from then on; the next scan arrives with the clock exactly
//                                                  1100 ms on (900 ms with CRATE_GUARD_LATE=early-gone) and from then on shows it
//                                                  as CRATE_GUARD_LATE says: gone (not listed), ended (a zombie), readable (as it
//                                                  is), early-gone (not listed)
//   CRATE_GUARD_FAULT=exiting-at-exit:<role>       once the tree is up, that process reads as exiting and the guard's clock
//                                                  stands still, through the first scan that no longer lists the test runner
//                                                  (the one the guard sees the end of the run in). Then, by CRATE_GUARD_POST:
//                                                  late (the next scan, the one the guard takes after the end of the run,
//                                                  arrives with the clock exactly 1100 ms on), inside (900 ms on), timeout (that
//                                                  first scan instead fails at the request timeout, with the clock 1100 ms on),
//                                                  retry (the next scan fails as a sampler that ends does, and the one taken
//                                                  with the sampler standing by arrives 1100 ms on). What those scans show of
//                                                  the process: CRATE_GUARD_LATE, gone, ended or readable, as above.
//                                                  The hand-off: handoff-gone (the scan after the end of the run arrives 500 ms
//                                                  on, still exiting; every later scan 1100 ms on, not listing it),
//                                                  handoff-stays (the same, but every later scan still lists it as exiting,
//                                                  whether or not it is there), handoff-retry (as handoff-gone, with the
//                                                  cleanup's first scan failing as a sampler that ends does),
//                                                  handoff-retry-still (as handoff-retry, but the retried scan still shows it
//                                                  exiting; the scans after that do not list it), handoff-retry-stays (the
//                                                  retried scan and every later one list it as exiting, there or not),
//                                                  handoff-retry-eperm (the retried scan shows it still exiting and
//                                                  nested-child with its usage denied), retry-eperm (no process is shown
//                                                  exiting; the cleanup's first scan fails as a sampler that ends does, and the
//                                                  retried scan shows nested-child with its usage denied), none (no
//                                                  process is ever shown exiting). At exit it prints how many scans the
//                                                  guard took after the end of the run before its first signal, and what
//                                                  it injected
//   CRATE_GUARD_FAULT=tool-exiting:<role>          once the tree is up, two scans read that process as the system's ps; after
//                                                  that it reads as that ps does once killed and before it has ended (no
//                                                  process info, usage denied)
//   CRATE_GUARD_FAULT=sampler-script:<role>        once the tree is up, that process's row comes from the sampler's own code
//                                                  (sampler-harness.py, "scripted") with the kernel's answers scripted: two scans
//                                                  as the system's ps, then what CRATE_GUARD_SHAPE says, with the guard's clock
//                                                  standing still: dying-then-ended, dying-twice-then-gone or collected, after
//                                                  which no scan lists it (it is still running); or other-start, wrong-parent,
//                                                  other-owner or still-dying, after which every scan shows the row it got. With
//                                                  other-helper there are no such scans: its first scan reads it as another
//                                                  set-uid tool, dying at the next read and ended at the one after. At exit it
//                                                  prints each row it got that way
//   CRATE_GUARD_FAULT=exiting-over-limit:<role>    once the tree is up, one scan reads that process in full at 1300 MB; after that
//                                                  it reads as exiting with no memory, and `nested-child` reads 1100 MB more than it holds
//   CRATE_GUARD_FAULT=system-tool:<role>           that process reads exactly as the system's set-uid ps does, for as long as it lives
//   CRATE_GUARD_FAULT=other-tool:<role>            the same, but its executable is another set-uid tool
//   CRATE_GUARD_FAULT=primary-fails                the sampler in use fails once the tree is up, and no new one can be started
//   CRATE_GUARD_FAULT=all-samplers-fail            the same, and the sampler standing by fails too
//
// With CRATE_GUARD_DESCRIBE=stall, die or throw, the sampler's describe request
// never answers, finds the sampler ended, or throws.
//
// Everything else goes to the real sampler untouched.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const guard = require('../../../scripts/run-tests');

const [kind, role] = String(process.env.CRATE_GUARD_FAULT).split(':');
const EPERM = 1;
const ESRCH = 3;
const HELD = ['unreadable-as-run-ends', 'unreadable-then-gone', 'unreadable-as-signal-arrives', 'unreadable-right-after-run'];
const sleep = milliseconds => new Promise(resolve => { setTimeout(resolve, milliseconds); });
const recorded = () => new Map(fs.readFileSync(process.env.CRATE_GUARD_FIXTURE_PIDS, 'utf8').split('\n').filter(Boolean)
  .map(line => line.split(' ')).map(([name, pid]) => [name, Number(pid)]));
const cannotRead = row => ({ ...row, start: '0', megabytes: 0, usageError: EPERM });
// The row the sampler writes for a listed pid whose info and usage reads both answer ESRCH.
const noSuchProcess = row => ({
  ...row, ppid: 0, pgid: 0, uid: 0, ruid: 0, status: 0, start: '0', megabytes: 0, resident: 0, footprint: 0, infoError: ESRCH, usageError: ESRCH,
  exiting: false, path: null,
});
// The row the sampler writes for an exiting process (see the sampler).
const exitingRow = (row, megabytes = row.resident) => ({
  ...row, ppid: 0, pgid: 0, uid: 0, ruid: 0, status: 0, megabytes, resident: megabytes, footprint: 0, infoError: ESRCH, usageError: 0, exiting: true, path: null,
});
let exitingScans = 0;
let inflated = false;
let stalling = false;
// The guard's clock for exiting allowances, which these faults may stop and set.
let fixed = null;
const clock = () => (fixed === null ? performance.now() : fixed);
let lateScans = 0;
let toolScans = 0;
let afterExit = 0;
let postDelivered = false;
let signalled = false;
let scansBeforeSignal = 0;
let lastTargetRow = null;
const injected = [];
if (kind === 'exiting-at-exit') {
  process.on('exit', () => {
    process.stderr.write(`faulty-guard: after the end of the run, ${scansBeforeSignal} scans before the first signal; injected: ${injected.join(', ') || 'nothing'}\n`);
  });
}
const deadSamplers = new Set();
// CRATE_GUARD_FAULT=sampler-script (see the top): the row of `role` as the
// sampler's own code makes it from scripted answers of the kernel.
const scriptedRows = [];
let scriptedRemembered = {};
let scriptedTools = {};
let scriptedLast = null;
if (kind === 'sampler-script') {
  process.on('exit', () => {
    process.stderr.write(`faulty-guard: scripted rows: ${scriptedRows.join(' | ') || 'none'}\n`);
  });
}
function askSampler(scenario) {
  const harness = path.join(__dirname, 'sampler-harness.py');
  const samplerFile = path.join(__dirname, '../../../scripts/run-tests-sampler.py');
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/python3', ['-I', '-B', harness, samplerFile, 'scripted', JSON.stringify(scenario)], { encoding: 'utf8' },
      (error, stdout) => { if (error) reject(error); else resolve(JSON.parse(stdout)); });
  });
}
function shapeReads(shown) {
  const owner = process.getuid();
  const WEXIT = 0x2000;
  const STARTED = [1763440000, 123456];
  const denied = ['usage', EPERM];
  const noInfo = ['info', ESRCH];
  const table = (status, start = STARTED, ppid = shown.ppid, ruid = owner) => ['record', [ppid, shown.pgid, 0, ruid, status, start, WEXIT]];
  const dying = [noInfo, denied, table(2)];
  const ended = [noInfo, denied, table(guard.ZOMBIE)];
  const gone = [noInfo, ['usage', ESRCH]];
  const shape = process.env.CRATE_GUARD_SHAPE;
  return {
    reads: {
      'dying-then-ended': [...dying, ...ended],
      'dying-twice-then-gone': [...dying, ...dying, ...gone],
      collected: [noInfo, denied, ['record', 'absent'], ...gone],
      'other-start': [noInfo, denied, table(2, [STARTED[0], STARTED[1] + 1])],
      'wrong-parent': [noInfo, denied, table(2, STARTED, process.pid)],
      'other-owner': [noInfo, denied, table(2, STARTED, shown.ppid, owner + 1)],
      'still-dying': [...dying, ...dying, ...dying, ...dying],
      'other-helper': [['info', 0, [shown.ppid, shown.pgid, 0, owner, 2]], denied, ['path', '/usr/bin/su'], ...dying, ...ended],
    }[shape],
    alive: [shown.ppid, shown.pgid, 0, owner, 2, STARTED, 0],
  };
}
async function samplerScript(rows) {
  if (!recorded().has('ready')) return rows;
  const target = recorded().get(role);
  const shown = rows.find(row => row.pid === target);
  if (!shown) return rows;
  const shape = process.env.CRATE_GUARD_SHAPE;
  const toolScans = shape === 'other-helper' ? 0 : 2;
  if (scriptedRows.length > toolScans) {
    return scriptedLast ? rows.map(row => (row.pid === target ? { ...scriptedLast } : row)) : rows.filter(row => row.pid !== target);
  }
  if (fixed === null) fixed = performance.now();
  const tool = [['info', 0, [shown.ppid, shown.pgid, 0, process.getuid(), 2]], ['usage', EPERM], ['path', '/bin/ps']];
  const number = scriptedRows.length + 1;
  const { reads: shaped, alive } = shapeReads(shown);
  const reads = number > toolScans ? shaped : number === 1 ? [...tool, ...tool] : tool;
  const answer = await askSampler({
    uid: process.getuid(), guard: process.pid, scans: [[target]], known: scriptedRemembered, tools: scriptedTools, learn: { [target]: alive }, script: { [target]: reads },
  });
  const text = answer.scans[0].rows[0];
  scriptedRemembered = answer.scans[0].remembered;
  scriptedTools = answer.scans[0].tools;
  scriptedRows.push(text);
  const row = guard.parseRow(text);
  if (number > toolScans && !['dying-then-ended', 'dying-twice-then-gone', 'collected'].includes(shape)) scriptedLast = row;
  return rows.map(item => (item.pid === target ? row : item));
}
// What a scan shows of `target` after the end of the run, by CRATE_GUARD_LATE.
const shownAs = (rows, target) => {
  const how = process.env.CRATE_GUARD_LATE;
  if (how === 'gone') return rows.filter(row => row.pid !== target);
  if (how === 'ended') return rows.map(row => (row.pid === target ? { ...row, status: guard.ZOMBIE, megabytes: 0, footprint: 0, exiting: true } : row));
  if (how === 'exiting') return rows.map(row => (row.pid === target ? exitingRow(row) : row));
  return rows;
};
// The row the sampler writes for a set-uid process that is exiting (see the sampler).
const toolExitingRow = row => ({
  ...row, ppid: 0, pgid: 0, uid: 0, ruid: 0, status: 0, start: '0', megabytes: 0, resident: 0, footprint: 0, infoError: ESRCH, usageError: EPERM,
  exiting: false, path: null,
});
// What the guard sees of a scan the sampler does not answer: its own request timeout.
const unanswered = () => new Promise((resolve, reject) => {
  setTimeout(() => reject(new Error(`sampler did not answer within ${guard.TIMING.requestTimeoutMs} ms (injected)`)), guard.TIMING.requestTimeoutMs);
});
// What the sampler reports for a set-uid root tool this user started.
const asTool = (row, path) => ({ ...cannotRead(row), uid: 0, ruid: process.getuid(), path });

const samplerPids = new Set();
let opened = 0;
// The test file's process and the test runner above it, learned from the tree
// while it is up: the test file is the parent of the role `nested`.
let testFilePid = null;
let runnerPid = null;
let held = false;
let misreadNext = false;

function misread(rows) {
  if (kind === 'unreadable-runner') {
    // The runner is the guard's only child that is not a sampler.
    return rows.map(row => (row.ppid === process.pid && !samplerPids.has(row.pid) ? cannotRead(row) : row));
  }
  if (kind === 'system-tool' || kind === 'other-tool') {
    const target = recorded().get(role);
    return rows.map(row => (row.pid === target ? asTool(row, kind === 'system-tool' ? '/bin/ps' : '/usr/bin/top') : row));
  }
  if (kind === 'exiting-then-late') {
    if (!recorded().has('ready')) return rows;
    const target = recorded().get(role);
    const how = process.env.CRATE_GUARD_LATE;
    lateScans += 1;
    if (lateScans === 1) {
      fixed = performance.now();
      return rows.map(row => (row.pid === target ? exitingRow(row) : row));
    }
    if (lateScans === 2) fixed += how === 'early-gone' ? 900 : 1100;
    return how === 'early-gone' ? rows.filter(row => row.pid !== target) : shownAs(rows, target);
  }
  if (kind === 'tool-exiting') {
    if (!recorded().has('ready')) return rows;
    const target = recorded().get(role);
    if (!rows.some(row => row.pid === target)) return rows;
    toolScans += 1;
    if (toolScans <= 2) return rows.map(row => (row.pid === target ? asTool(row, '/bin/ps') : row));
    return rows.map(row => (row.pid === target ? toolExitingRow(row) : row));
  }
  if (kind === 'exiting' || kind === 'exiting-then-gone' || kind === 'exiting-then-stall') {
    if (!recorded().has('ready')) return rows;
    const target = recorded().get(role);
    if (!rows.some(row => row.pid === target)) return rows;
    exitingScans += 1;
    if (kind === 'exiting-then-gone' && exitingScans > 6) return rows.filter(row => row.pid !== target);
    if (kind === 'exiting-then-stall' && exitingScans >= 2) stalling = true;
    return rows.map(row => (row.pid === target ? exitingRow(row) : row));
  }
  if (kind === 'stall') {
    if (recorded().has('ready') && rows.some(row => row.pid === recorded().get(role))) stalling = true;
    return rows;
  }
  if (kind === 'exiting-over-limit') {
    if (!recorded().has('ready')) return rows;
    const pids = recorded();
    const target = pids.get(role);
    const MB = 1300;
    if (!inflated) {
      inflated = true;
      return rows.map(row => (row.pid === target ? { ...row, megabytes: MB, resident: MB } : row));
    }
    return rows.map(row => (row.pid === target ? exitingRow(row, 0)
      : row.pid === pids.get('nested-child') ? { ...row, megabytes: row.megabytes + 1100, resident: row.resident + 1100 } : row));
  }
  if (kind === 'no-such-process') {
    // Only after the guard has read it in full: the tree is up.
    if (!recorded().has('ready')) return rows;
    const target = recorded().get(role);
    return rows.map(row => (row.pid === target ? noSuchProcess(row) : row));
  }
  if (!kind.startsWith('unreadable') || HELD.includes(kind)) return rows;
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

// One scan, made with the run alive and its tree up, that the guard gets
// late: when the test run has ended (and the target too, for
// unreadable-then-gone), or when a SIGTERM has arrived. The target cannot be
// read in it, or, for unreadable-right-after-run, in the scan that follows it.
async function holdBack(rows, real) {
  const target = recorded().get(role);
  const unread = scan => scan.map(row => (row.pid === target ? cannotRead(row) : row));
  if (misreadNext) {
    misreadNext = false;
    return unread(rows);
  }
  const runner = rows.find(row => row.ppid === process.pid && !samplerPids.has(row.pid));
  if (held || !recorded().has('ready') || !runner || !rows.some(row => row.pid === target)) return rows;
  held = true;
  misreadNext = kind === 'unreadable-right-after-run';
  const answer = misreadNext ? rows : unread(rows);
  if (kind === 'unreadable-as-signal-arrives') {
    await new Promise(resolve => { process.once('SIGTERM', resolve); });
  } else {
    const there = (now, pid) => now.some(row => row.pid === pid && !(row.infoError === 0 && row.status === guard.ZOMBIE));
    for (;;) {
      await sleep(20);
      const now = await real.scan();
      if (!there(now, runner.pid) && (kind !== 'unreadable-then-gone' || !there(now, target))) break;
    }
  }
  // Long enough for the guard to have heard of it.
  await sleep(100);
  return answer;
}

// CRATE_GUARD_FAULT=exiting-at-exit (see the top).
async function atExit(number, rows) {
  if (!recorded().has('ready')) return rows;
  const target = recorded().get(role);
  const how = process.env.CRATE_GUARD_POST;
  // The runner is the guard's only child that is not a sampler. A scan can
  // list it and still reach the guard after it has been collected, when the
  // guard already knows the run has ended: so it counts as gone once this
  // process (the guard) has collected it, which is when the guard learns of
  // the end of the run, in the same step.
  const runner = rows.find(row => row.ppid === process.pid && !samplerPids.has(row.pid));
  const collected = pid => { try { process.kill(pid, 0); return false; } catch { return true; } };
  const runnerRunning = runner !== undefined && !collected(runner.pid);
  if (runnerRunning || afterExit === 0) {
    if (how === 'none' || how === 'retry-eperm') {
      if (!runnerRunning) afterExit = 1;
      return rows;
    }
    if (!rows.some(row => row.pid === target)) return rows;
    if (fixed === null) fixed = performance.now();
    if (!runnerRunning) {
      afterExit = 1;
      if (how === 'timeout') {
        fixed += 1100;
        return unanswered();
      }
    }
    return rows.map(row => (row.pid === target ? exitingRow(row) : row));
  }
  afterExit += 1;
  if (!signalled) scansBeforeSignal += 1;
  if (how === 'none') return rows;
  if (how === 'retry-eperm') {
    const first = !postDelivered;
    if (number === 1 && !first) {
      deadSamplers.add(number);
      injected.push('the cleanup\'s first scan failed as a sampler that ends does');
      throw new Error('sampler exited (injected)');
    }
    postDelivered = true;
    if (!first && !injected.includes('nested-child with its usage denied')) {
      injected.push('nested-child with its usage denied');
      const other = recorded().get('nested-child');
      return rows.map(row => (row.pid === other ? cannotRead(row) : row));
    }
    return rows;
  }
  if (how.startsWith('handoff-')) {
    const first = !postDelivered;
    if (how.startsWith('handoff-retry') && number === 1 && !first) {
      deadSamplers.add(number);
      injected.push('the cleanup\'s first scan failed as a sampler that ends does');
      throw new Error('sampler exited (injected)');
    }
    postDelivered = true;
    const start = fixed;
    if (first) {
      fixed += 500;
      injected.push('the scan after the end of the run at 500 ms, still exiting');
      const shown = rows.find(row => row.pid === target);
      if (shown) lastTargetRow = exitingRow(shown);
      return rows.map(row => (row.pid === target ? exitingRow(row) : row));
    }
    const later = !injected.some(item => item.startsWith('a later scan'));
    if (start === fixed && fixed !== null && later) {
      fixed += 600;
      injected.push(`a later scan at 1100 ms${how === 'handoff-retry-still' || how === 'handoff-retry-eperm' ? ', still exiting' : ''}`);
    }
    // The retried scan (the first one after the injected failure).
    if (later && lastTargetRow && (how === 'handoff-retry-still' || how === 'handoff-retry-eperm')) {
      const shown = [...rows.filter(row => row.pid !== target), lastTargetRow];
      if (how === 'handoff-retry-still') return shown;
      const other = recorded().get('nested-child');
      injected.push('nested-child with its usage denied');
      return shown.map(row => (row.pid === other ? cannotRead(row) : row));
    }
    if ((how === 'handoff-stays' || how === 'handoff-retry-stays') && lastTargetRow) {
      // Listed as exiting for as long as the guard asks, there or not.
      return [...rows.filter(row => row.pid !== target), lastTargetRow];
    }
    return rows.filter(row => row.pid !== target);
  }
  if (how === 'retry' && number === 1) {
    deadSamplers.add(number);
    throw new Error('sampler exited (injected)');
  }
  if (!postDelivered) {
    postDelivered = true;
    if (how !== 'timeout') {
      fixed += how === 'inside' ? 900 : 1100;
      injected.push(`the scan after the end of the run at ${how === 'inside' ? 900 : 1100} ms`);
    }
  }
  return shownAs(rows, target);
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
    get dead() { return failed || deadSamplers.has(number) || real.dead; },
    stop: () => real.stop(),
    scan: (...args) => use(async () => {
      if (stalling && number === 1) return unanswered();
      if (kind === 'exiting-at-exit') return atExit(number, await real.scan(...args));
      if (kind === 'sampler-script') return samplerScript(await real.scan(...args));
      const rows = misread(await real.scan(...args));
      return HELD.includes(kind) && number === 1 ? holdBack(rows, real) : rows;
    }),
    // The real sampler signals the group through a readable member; the faults
    // above do not change what it reads.
    signalGroup: (...args) => use(() => { if (afterExit > 0) signalled = true; return real.signalGroup(...args); }),
    signalProcesses: (name, rows) => use(() => { if (afterExit > 0) signalled = true; return signalProcesses(name, rows); }),
    describe: (...args) => {
      const how = process.env.CRATE_GUARD_DESCRIBE;
      if (how === 'stall') return new Promise(() => {});
      if (how === 'throw') throw new Error('describe failed (injected)');
      if (how === 'die') real.stop();
      return use(() => real.describe(...args));
    },
  };
}

guard.runGuard({
  argv: process.argv.slice(2),
  env: process.env,
  startSampler: startFaultySampler,
  timing: { confirmMs: 600, leftoverGraceMs: 300 },
  clock,
}).then(code => process.exit(code), error => {
  process.stderr.write(`faulty-guard: ${error && error.stack ? error.stack : error}\n`);
  process.exit(99);
});
