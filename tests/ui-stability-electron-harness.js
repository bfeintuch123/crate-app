'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { app, screen } = require('electron');
const {
  analyzeOuterSizeRequest,
  finalizeHarnessProcess,
  getHarnessExitCode,
} = require('./ui-stability-harness-policy');

const LEGACY_HARNESS_PATH = path.join(__dirname, 'ui-stability-electron-harness-legacy.js');
const SHOW_WINDOW = process.env.CRATE_UI_SHOW === '1';
const FORCE_FAILURE = process.env.CRATE_UI_FORCE_FAILURE === '1';
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const HARNESS_TIMEOUT_MS = 180_000;

function runLegacyHarness() {
  return new Promise((resolve, reject) => {
    const childEnvironment = { ...process.env };
    delete childEnvironment.ELECTRON_RUN_AS_NODE;

    const child = spawn(process.execPath, [LEGACY_HARNESS_PATH], {
      env: childEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timeout = null;

    const finish = callback => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      callback();
    };
    const capture = (chunks, chunk, currentBytes, label) => {
      const nextBytes = currentBytes + chunk.length;
      if (nextBytes > MAX_CAPTURE_BYTES) {
        child.kill('SIGKILL');
        finish(() => reject(new Error(`${label} exceeded ${MAX_CAPTURE_BYTES} bytes`)));
        return null;
      }
      chunks.push(chunk);
      return nextBytes;
    };

    child.stdout.on('data', chunk => {
      const nextBytes = capture(stdoutChunks, chunk, stdoutBytes, 'Harness stdout');
      if (nextBytes !== null) stdoutBytes = nextBytes;
    });
    child.stderr.on('data', chunk => {
      const nextBytes = capture(stderrChunks, chunk, stderrBytes, 'Harness stderr');
      if (nextBytes !== null) stderrBytes = nextBytes;
    });
    child.on('error', error => finish(() => reject(error)));
    child.on('close', (exitCode, signal) => finish(() => resolve({
      exitCode,
      signal,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
    })));

    timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error(`Electron harness timed out after ${HARNESS_TIMEOUT_MS}ms`)));
    }, HARNESS_TIMEOUT_MS);
    timeout.unref();
  });
}

function parseHarnessReport(stdout) {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end < start) throw new Error('Electron harness did not emit a JSON report');
  return JSON.parse(stdout.slice(start, end + 1));
}

function readConnectedWorkAreas() {
  return screen.getAllDisplays().map(display => ({
    displayId: display.id,
    x: display.workArea.x,
    y: display.workArea.y,
    width: display.workArea.width,
    height: display.workArea.height,
  }));
}

function legacySizeFailure(requestedSize, actualSize) {
  const label = `${requestedSize.width}x${requestedSize.height}`;
  return `${label}: requested outer size ${requestedSize.width}x${requestedSize.height}, observed `
    + `${actualSize.width}x${actualSize.height}`;
}

function reconcileWorkAreaCaps(report, workAreas) {
  const removedFailures = [];
  const visibleMacEvidence = process.platform === 'darwin' && SHOW_WINDOW;

  for (const result of Array.isArray(report.results) ? report.results : []) {
    const requestedSize = result && result.requestedSize;
    const actualSize = result && result.windowContract && result.windowContract.outerSize;
    if (!requestedSize || !actualSize || !report.configuredMinimum) continue;

    let disposition = analyzeOuterSizeRequest({
      requestedSize,
      actualSize,
      configuredMinimum: report.configuredMinimum,
      allowWorkAreaCap: false,
    });
    let matchedWorkArea = null;

    if (!disposition.accepted && visibleMacEvidence) {
      for (const workArea of workAreas) {
        const candidate = analyzeOuterSizeRequest({
          requestedSize,
          actualSize,
          configuredMinimum: report.configuredMinimum,
          workArea,
          allowWorkAreaCap: true,
        });
        if (candidate.accepted && candidate.workAreaCapped) {
          disposition = candidate;
          matchedWorkArea = workArea;
          break;
        }
      }
    }

    result.outerSizeDisposition = disposition;
    if (matchedWorkArea) result.windowContract.workArea = matchedWorkArea;
    if (!disposition.accepted || !disposition.workAreaCapped) continue;

    const removable = legacySizeFailure(requestedSize, actualSize);
    const beforeResultFailures = Array.isArray(result.failures) ? result.failures : [];
    result.failures = beforeResultFailures.filter(failure => failure !== removable);
    if (result.failures.length !== beforeResultFailures.length) removedFailures.push(removable);
  }

  if (removedFailures.length > 0 && Array.isArray(report.failures)) {
    const removed = new Set(removedFailures);
    report.failures = report.failures.filter(failure => !removed.has(failure));
  }
  return removedFailures;
}

async function run() {
  const legacy = await runLegacyHarness();
  if (legacy.stderr) process.stderr.write(legacy.stderr);

  const report = parseHarnessReport(legacy.stdout);
  const workAreas = readConnectedWorkAreas();
  const removedWorkAreaFailures = reconcileWorkAreaCaps(report, workAreas);
  const runnerFailures = [];
  if (legacy.signal) runnerFailures.push(`legacy harness terminated by ${legacy.signal}`);
  if (legacy.exitCode !== 0) runnerFailures.push(`legacy harness exited with status ${legacy.exitCode}`);
  if (FORCE_FAILURE) runnerFailures.push('forced harness failure for exit-code verification');
  report.failures = [...(Array.isArray(report.failures) ? report.failures : []), ...runnerFailures];

  const exitCode = getHarnessExitCode({
    pageErrors: Array.isArray(report.pageErrors) ? report.pageErrors : [],
    consoleErrors: Array.isArray(report.consoleErrors) ? report.consoleErrors : [],
    failures: report.failures,
  });
  report.schemaVersion = 3;
  report.harnessRunner = {
    legacyExitCode: legacy.exitCode,
    legacySignal: legacy.signal,
    visibleMacEvidence: process.platform === 'darwin' && SHOW_WINDOW,
    forcedFailure: FORCE_FAILURE,
    connectedWorkAreas: workAreas,
    removedWorkAreaFailures,
  };
  report.exitCode = exitCode;

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return exitCode;
}

let finalExitCode = 1;
app.whenReady()
  .then(run)
  .then(exitCode => {
    finalExitCode = exitCode === 0 ? 0 : 1;
  })
  .catch(error => {
    console.error(error && error.stack ? error.stack : error);
    finalExitCode = 1;
  })
  .finally(() => {
    finalizeHarnessProcess({
      appModule: app,
      processModule: process,
      exitCode: finalExitCode,
    });
  });
