#!/usr/bin/env node
'use strict';
// Runs `node --test` under a memory watchdog, so a test that allocates without
// limit is killed in about a second instead of taking the machine down.
//
//   node scripts/run-tests.js                                    whole serial suite
//   node scripts/run-tests.js tests/figma-scope.test.js          chosen files
//   node scripts/run-tests.js --test-name-pattern="focus" tests/renderer-figma-scope.test.js
//
// Every argument is handed to `node --test` unchanged, apart from the two
// limit options below. With no test files it runs tests/*.test.js, and it adds
// --test-concurrency=1 unless a concurrency is given.
//
//   --memory-limit-mb=N         most memory any one process may hold
//   --total-memory-limit-mb=N   most memory the whole run may hold
//   (or CRATE_TEST_MEMORY_LIMIT_MB / CRATE_TEST_TOTAL_MEMORY_LIMIT_MB)
//
// The watchdog reads memory from outside the test processes, so it works while
// a test is stuck in a synchronous loop and it changes nothing about the
// environment the tests run in. It watches the test runner and everything it
// starts (test files, Electron, Chrome, workers) and compares the larger of
// two readings with the limits: resident size from `ps` four times a second,
// and on macOS the memory footprint from `top` every five seconds. The second
// reading matters because macOS compresses memory under pressure: a runaway
// process can then hold a small resident size and a huge footprint.

const { spawn, execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The whole suite peaks near 450 MB in one process and 1.2 GB in total.
const DEFAULT_PROCESS_LIMIT_MB = 2048;
const DEFAULT_TOTAL_LIMIT_MB = 4096;
// A runaway test grows by gigabytes per second, so the check is frequent: a
// run overshoots its limit by at most what it can allocate in one interval.
const POLL_INTERVAL_MS = 250;
// Most checks ask only about the run's own process group, which costs a tenth
// of listing every process. A full listing this often finds anything the run
// started outside that group.
const FULL_SCAN_INTERVAL_MS = 2000;
const FOOTPRINT_INTERVAL_SECONDS = 5;
const MEMORY_LIMIT_EXIT_CODE = 137;
const MB = 1024 * 1024;
const root = path.resolve(__dirname, '..');

function fail(message) {
  process.stderr.write(`run-tests: ${message}\n`);
  process.exit(2);
}

function readLimit(name, text, fallback) {
  if (text === undefined || text === '') return fallback;
  if (!/^[1-9]\d{0,6}$/.test(text)) fail(`${name} must be a whole number of megabytes, got "${text}"`);
  return Number(text);
}

function parseArguments(argv, env) {
  const limits = {
    process: readLimit('CRATE_TEST_MEMORY_LIMIT_MB', env.CRATE_TEST_MEMORY_LIMIT_MB, DEFAULT_PROCESS_LIMIT_MB),
    total: readLimit('CRATE_TEST_TOTAL_MEMORY_LIMIT_MB', env.CRATE_TEST_TOTAL_MEMORY_LIMIT_MB, DEFAULT_TOTAL_LIMIT_MB),
  };
  const nodeArguments = [];
  for (const argument of argv) {
    const option = /^--(total-)?memory-limit-mb=(.*)$/.exec(argument);
    if (!option) nodeArguments.push(argument);
    else if (option[1]) limits.total = readLimit('--total-memory-limit-mb', option[2], limits.total);
    else limits.process = readLimit('--memory-limit-mb', option[2], limits.process);
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

// Resident size, in megabytes, of the selected processes: every process on the
// machine (['-ax']), or one process group and some known processes.
function readProcessTable(selection) {
  return new Promise(resolve => {
    execFile('ps', ['-o', 'pid=,ppid=,pgid=,rss=', ...selection], { maxBuffer: 16 * MB }, (error, stdout) => {
      // ps exits with 1 when nothing matches the selection; that is an empty table.
      if (error && error.code !== 1) return resolve(null);
      const rows = [];
      for (const line of stdout.split('\n')) {
        const fields = line.trim().split(/\s+/);
        if (fields.length !== 4) continue;
        const [pid, ppid, pgid, rssKb] = fields.map(Number);
        if (Number.isInteger(pid)) rows.push({ pid, ppid, pgid, megabytes: rssKb / 1024 });
      }
      return resolve(rows);
    });
  });
}

// Memory footprint per process, in megabytes, refreshed by one long-lived
// `top`. Stays empty where top is missing or prints something else.
function startFootprintReader() {
  const footprints = new Map();
  if (process.platform !== 'darwin') return { footprints, stop() {} };
  const units = { B: 1 / MB, K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024 };
  let sampled = new Set();
  let pending = '';
  let top;
  try {
    top = spawn('top', ['-l', '0', '-s', String(FOOTPRINT_INTERVAL_SECONDS), '-stats', 'pid,mem'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return { footprints, stop() {} };
  }
  top.on('error', () => {});
  top.stdout.setEncoding('utf8');
  top.stdout.on('data', chunk => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop();
    for (const line of lines) {
      // Each sample opens with a "Processes:" summary line. Readings are used
      // as they arrive; a process missing from the last sample is forgotten.
      if (line.startsWith('Processes:')) {
        for (const pid of footprints.keys()) if (!sampled.has(pid)) footprints.delete(pid);
        sampled = new Set();
        continue;
      }
      const row = /^\s*(\d+)\s+(\d+(?:\.\d+)?)([BKMGT])[+-]?\s*$/.exec(line);
      if (!row) continue;
      footprints.set(Number(row[1]), Number(row[2]) * units[row[3]]);
      sampled.add(Number(row[1]));
    }
  });
  top.unref();
  top.stdout.unref?.();
  return { footprints, stop() { try { top.kill('SIGKILL'); } catch { /* already gone */ } } };
}

// The runner and everything it started: its descendants, its process group,
// and any process seen in the run a moment ago that has since been orphaned.
function findRunProcesses(rows, runnerPid, previous) {
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }
  const found = new Map();
  const queue = rows.filter(row => row.pid === runnerPid || row.pgid === runnerPid || previous.has(row.pid));
  while (queue.length > 0) {
    const row = queue.pop();
    if (found.has(row.pid) || row.pid === process.pid) continue;
    found.set(row.pid, row);
    for (const child of children.get(row.pid) || []) queue.push(child);
  }
  return found;
}

function describeProcess(pid) {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim();
  } catch {
    return '(command unavailable)';
  }
}

function main() {
  const { limits, nodeArguments } = parseArguments(process.argv.slice(2), process.env);
  const started = Date.now();
  // Its own session, so the whole run can be signalled as one process group.
  const runner = spawn(process.execPath, nodeArguments, { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
  const footprintReader = startFootprintReader();
  const peak = { process: 0, total: 0 };
  let tracked = new Map();
  let lastFullScan = 0;
  let stopped = false;
  let timer = null;
  let outcome = null;
  let warned = false;

  const signalRun = signal => {
    try { process.kill(-runner.pid, signal); } catch { /* group already gone */ }
    for (const pid of tracked.keys()) {
      try { process.kill(pid, signal); } catch { /* already gone */ }
    }
  };

  const stopForMemory = (lines) => {
    stopped = true;
    // Freeze growth first, then name the culprit while its command line is still readable.
    signalRun('SIGSTOP');
    const report = lines();
    signalRun('SIGKILL');
    outcome = { code: MEMORY_LIMIT_EXIT_CODE };
    process.stderr.write(`\n${report.map(line => `run-tests: ${line}`).join('\n')}\n`);
  };

  const check = async () => {
    // Selecting by process group is only dependable in the BSD ps that macOS ships.
    const fullScan = process.platform !== 'darwin' || Date.now() - lastFullScan >= FULL_SCAN_INTERVAL_MS;
    if (fullScan) lastFullScan = Date.now();
    const rows = await readProcessTable(fullScan ? ['-ax']
      : ['-g', String(runner.pid), ...(tracked.size > 0 ? ['-p', [...tracked.keys()].join(',')] : [])]);
    if (stopped) return;
    if (rows === null) {
      if (!warned) process.stderr.write('run-tests: warning: cannot read process memory with ps; the memory limits are not enforced\n');
      warned = true;
    } else {
      tracked = findRunProcesses(rows, runner.pid, tracked);
      let total = 0;
      let largest = null;
      for (const row of tracked.values()) {
        const megabytes = Math.max(row.megabytes, footprintReader.footprints.get(row.pid) || 0);
        total += megabytes;
        if (largest === null || megabytes > largest.megabytes) largest = { pid: row.pid, megabytes };
      }
      if (largest) peak.process = Math.max(peak.process, largest.megabytes);
      peak.total = Math.max(peak.total, total);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (largest && largest.megabytes > limits.process) {
        stopForMemory(() => [
          `MEMORY LIMIT EXCEEDED after ${seconds} s: process ${largest.pid} reached ${formatSize(largest.megabytes)} (limit ${formatSize(limits.process)} per process).`,
          `  ${describeProcess(largest.pid)}`,
          `Killed the test run (${tracked.size} processes). A test that needs this much memory is almost always a bug:`,
          'rerun the file above with --test-name-pattern to find the test, or pass --memory-limit-mb=N if the need is real.',
        ]);
        return;
      }
      if (total > limits.total) {
        stopForMemory(() => [
          `MEMORY LIMIT EXCEEDED after ${seconds} s: the run reached ${formatSize(total)} across ${tracked.size} processes (limit ${formatSize(limits.total)} in total).`,
          `  largest: process ${largest.pid} at ${formatSize(largest.megabytes)}: ${describeProcess(largest.pid)}`,
          'Killed the test run. Pass --total-memory-limit-mb=N if the need is real.',
        ]);
        return;
      }
    }
    timer = setTimeout(check, POLL_INTERVAL_MS);
  };
  check();

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      outcome ||= { code: 128 + os.constants.signals[signal] };
      signalRun(signal);
      setTimeout(() => signalRun('SIGKILL'), 5000).unref();
    });
  }

  runner.on('error', error => {
    footprintReader.stop();
    fail(`could not start ${process.execPath}: ${error.message}`);
  });
  runner.on('exit', (code, signal) => {
    stopped = true;
    clearTimeout(timer);
    footprintReader.stop();
    outcome ||= { code: signal ? 128 + (os.constants.signals[signal] || 0) : code };
    process.stderr.write(`run-tests: memory guard on; peak ${formatSize(peak.process)} in one process, `
      + `${formatSize(peak.total)} in total (limits ${formatSize(limits.process)} and ${formatSize(limits.total)})\n`);
    process.exitCode = outcome.code;
  });
}

if (require.main === module) main();

module.exports = { parseArguments, findRunProcesses, DEFAULT_PROCESS_LIMIT_MB, DEFAULT_TOTAL_LIMIT_MB, MEMORY_LIMIT_EXIT_CODE };
