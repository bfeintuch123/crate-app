const fs = require('fs');
const path = require('path');

const STARTUP_PHASE_JOURNAL_FILE = 'startup-phases.jsonl';
const STARTUP_PHASE_JOURNAL_MODE = 0o600;
const STARTUP_PHASE_JOURNAL_MAX_BYTES = 128 * 1024;
const STARTUP_PHASE_JOURNAL_MAX_ENTRIES = 128;
const DESKTOP_WINDOW_MINIMUM = Object.freeze({
  width: 1100,
  height: 760,
});
const desktopWindowMinimumApps = new WeakSet();

function applyDesktopWindowMinimum(browserWindow) {
  if (
    !browserWindow ||
    (typeof browserWindow.isDestroyed === 'function' && browserWindow.isDestroyed()) ||
    typeof browserWindow.setMinimumSize !== 'function'
  ) return false;

  try {
    browserWindow.setMinimumSize(
      DESKTOP_WINDOW_MINIMUM.width,
      DESKTOP_WINDOW_MINIMUM.height
    );

    if (
      typeof browserWindow.getSize === 'function' &&
      typeof browserWindow.setSize === 'function'
    ) {
      const [currentWidth, currentHeight] = browserWindow.getSize();
      const nextWidth = Math.max(
        Number(currentWidth) || 0,
        DESKTOP_WINDOW_MINIMUM.width
      );
      const nextHeight = Math.max(
        Number(currentHeight) || 0,
        DESKTOP_WINDOW_MINIMUM.height
      );
      if (nextWidth !== currentWidth || nextHeight !== currentHeight) {
        browserWindow.setSize(nextWidth, nextHeight, false);
      }
    }
    return true;
  } catch (_) {
    return false;
  }
}

function installDesktopWindowMinimum(appModule) {
  if (
    !appModule ||
    (typeof appModule !== 'object' && typeof appModule !== 'function') ||
    typeof appModule.on !== 'function'
  ) return false;
  if (desktopWindowMinimumApps.has(appModule)) return true;

  desktopWindowMinimumApps.add(appModule);
  appModule.on('browser-window-created', (_event, browserWindow) => {
    applyDesktopWindowMinimum(browserWindow);
  });
  return true;
}

function installDesktopWindowMinimumFromElectron() {
  try {
    const electron = require('electron');
    return installDesktopWindowMinimum(electron && electron.app);
  } catch (_) {
    return false;
  }
}

const desktopWindowMinimumInstalled = installDesktopWindowMinimumFromElectron();

const STARTUP_PHASES = new Set([
  'main-module-entered',
  'dependencies-loaded',
  'single-instance-lock-start',
  'single-instance-lock-acquired',
  'single-instance-lock-denied',
  'store-preflight-start',
  'store-path-preflight-complete',
  'store-constructor-complete',
  'store-path-security-complete',
  'store-shape-validation-complete',
  'store-migrations-complete',
  'store-preflight-complete',
  'store-preflight-failed',
  'ready-handler-entered',
  'figma-credential-storage-configured',
  'figma-credential-storage-failed',
  'main-window-create-start',
  'main-window-constructed',
  'web-contents-created',
  'renderer-load-start',
  'renderer-dom-ready',
  'renderer-load-finished',
  'renderer-load-failed',
  'renderer-process-gone',
  'preload-error',
  'main-window-show-event',
  'main-window-focus-event',
  'main-window-unresponsive',
  'main-window-responsive',
  'child-process-gone',
  'main-event-loop-immediate-after-window',
  'main-event-loop-timer-after-window',
  'main-window-ready-to-show',
  'main-window-show-requested',
  'main-window-visible',
  'tray-create-start',
  'tray-created',
  'watch-recovery-start',
  'watch-state-repair-complete',
  'watch-resume-start',
  'watch-recovery-complete',
  'watch-recovery-failed',
  'ready-handler-complete',
  'startup-error',
  'uncaught-exception',
  'before-quit',
  'second-instance-received',
  'preload-entered',
  'preload-bridge-exposed',
  'renderer-script-entered',
  'renderer-init-entered',
  'renderer-startup-data-complete',
  'renderer-startup-data-failed',
  'renderer-first-render-complete',
  'renderer-first-frame',
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
  DESKTOP_WINDOW_MINIMUM,
  STARTUP_PHASE_JOURNAL_FILE,
  STARTUP_PHASE_JOURNAL_MAX_BYTES,
  STARTUP_PHASE_JOURNAL_MODE,
  STARTUP_PHASES,
  applyDesktopWindowMinimum,
  createStartupPhaseJournal,
  desktopWindowMinimumInstalled,
  getWatchRecoveryPhase,
  installDesktopWindowMinimum,
};
