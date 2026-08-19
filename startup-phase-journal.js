const fs = require('fs');
const path = require('path');

const STARTUP_PHASE_JOURNAL_FILE = 'startup-phases.jsonl';
const STARTUP_PHASE_JOURNAL_MODE = 0o600;
const STARTUP_PHASE_JOURNAL_MAX_BYTES = 128 * 1024;
const STARTUP_PHASE_JOURNAL_MAX_ENTRIES = 128;
const STARTUP_PHASES = new Set([
  'main-module-entered',
  'dependencies-loaded',
  'single-instance-lock-start',
  'single-instance-lock-acquired',
  'single-instance-lock-denied',
  'store-preflight-start',
  'store-preflight-complete',
  'store-preflight-failed',
  'ready-handler-entered',
  'figma-credential-storage-configured',
  'figma-credential-storage-failed',
  'main-window-create-start',
  'main-window-constructed',
  'renderer-load-start',
  'renderer-dom-ready',
  'renderer-load-finished',
  'renderer-load-failed',
  'renderer-process-gone',
  'main-window-ready-to-show',
  'main-window-show-requested',
  'main-window-visible',
  'tray-create-start',
  'tray-created',
  'watch-recovery-start',
  'watch-recovery-complete',
  'watch-recovery-failed',
  'ready-handler-complete',
  'startup-error',
  'uncaught-exception',
  'before-quit',
]);

function createDisabledJournal() {
  return {
    mark: () => false,
    close: () => {},
    enabled: false,
    filePath: null,
  };
}

function getWatchRecoveryPhase(recoveredProject) {
  return recoveredProject == null ? 'watch-recovery-failed' : 'watch-recovery-complete';
}

function createStartupPhaseJournal(options = {}) {
  const fsModule = options.fsModule || fs;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const processId = Number.isSafeInteger(options.processId) ? options.processId : process.pid;
  const getLogDirectory = typeof options.getLogDirectory === 'function'
    ? options.getLogDirectory
    : () => options.logDirectory;
  const startedAt = now();
  const launchId = `${Math.max(0, startedAt).toString(36)}-${Math.max(0, processId).toString(36)}`;
  let fileDescriptor = null;
  let filePath = null;
  let sequence = 0;
  let fileSize = 0;

  try {
    const logDirectory = getLogDirectory();
    if (typeof logDirectory !== 'string' || !path.isAbsolute(logDirectory)) {
      return createDisabledJournal();
    }

    const directoryStat = fsModule.lstatSync(logDirectory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      return createDisabledJournal();
    }
    if (typeof process.getuid === 'function' && directoryStat.uid !== process.getuid()) {
      return createDisabledJournal();
    }

    filePath = path.join(logDirectory, STARTUP_PHASE_JOURNAL_FILE);
    const noFollow = fsModule.constants.O_NOFOLLOW || 0;
    fileDescriptor = fsModule.openSync(
      filePath,
      fsModule.constants.O_WRONLY | fsModule.constants.O_CREAT | fsModule.constants.O_APPEND | noFollow,
      STARTUP_PHASE_JOURNAL_MODE
    );
    const fileStat = fsModule.fstatSync(fileDescriptor);
    if (
      !fileStat.isFile() ||
      fileStat.nlink !== 1 ||
      (typeof process.getuid === 'function' && fileStat.uid !== process.getuid())
    ) {
      throw new Error('unsafe_startup_phase_journal');
    }
    fsModule.fchmodSync(fileDescriptor, STARTUP_PHASE_JOURNAL_MODE);
    if (fileStat.size > STARTUP_PHASE_JOURNAL_MAX_BYTES) {
      fsModule.ftruncateSync(fileDescriptor, 0);
    } else {
      fileSize = fileStat.size;
    }
  } catch (_) {
    if (fileDescriptor !== null) {
      try { fsModule.closeSync(fileDescriptor); } catch (_) {}
    }
    return createDisabledJournal();
  }

  const disable = () => {
    if (fileDescriptor === null) return;
    try { fsModule.closeSync(fileDescriptor); } catch (_) {}
    fileDescriptor = null;
  };

  return {
    mark(phase) {
      if (
        fileDescriptor === null ||
        !STARTUP_PHASES.has(phase) ||
        sequence >= STARTUP_PHASE_JOURNAL_MAX_ENTRIES
      ) return false;

      const nextSequence = sequence + 1;
      const elapsedMs = Math.max(0, Math.floor(now() - startedAt));
      const entry = JSON.stringify({
        schemaVersion: 1,
        launchId,
        sequence: nextSequence,
        phase,
        elapsedMs,
      });
      const line = `${entry}\n`;
      const lineSize = Buffer.byteLength(line);
      try {
        if (fileSize + lineSize > STARTUP_PHASE_JOURNAL_MAX_BYTES) {
          if (sequence > 0) return false;
          fsModule.ftruncateSync(fileDescriptor, 0);
          fileSize = 0;
        }
        fsModule.writeSync(fileDescriptor, line, null, 'utf8');
        sequence = nextSequence;
        fileSize += lineSize;
        return true;
      } catch (_) {
        disable();
        return false;
      }
    },
    close: disable,
    enabled: true,
    filePath,
  };
}

module.exports = {
  STARTUP_PHASE_JOURNAL_FILE,
  STARTUP_PHASE_JOURNAL_MAX_BYTES,
  STARTUP_PHASE_JOURNAL_MODE,
  STARTUP_PHASES,
  createStartupPhaseJournal,
  getWatchRecoveryPhase,
};
