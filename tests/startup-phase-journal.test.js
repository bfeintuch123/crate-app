const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  STARTUP_PHASE_JOURNAL_FILE,
  STARTUP_PHASE_JOURNAL_MAX_BYTES,
  STARTUP_PHASE_JOURNAL_MODE,
  createStartupPhaseJournal,
  getWatchRecoveryPhase,
} = require('../startup-phase-journal');

function modeOf(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}

test('startup journal records only bounded privacy-safe phase data', () => {
  const logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-startup-journal-'));
  const clock = [1000, 1004, 1017, 1021];
  const journal = createStartupPhaseJournal({
    logDirectory,
    processId: 42,
    now: () => clock.shift(),
  });

  try {
    assert.equal(journal.enabled, true);
    assert.equal(journal.mark('main-module-entered'), true);
    assert.equal(journal.mark('/Users/private/project.ai'), false);
    assert.equal(journal.mark('main-window-constructed'), true);
    journal.close();

    const journalPath = path.join(logDirectory, STARTUP_PHASE_JOURNAL_FILE);
    const lines = fs.readFileSync(journalPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines, [
      {
        schemaVersion: 1,
        launchId: 'rs-16',
        sequence: 1,
        phase: 'main-module-entered',
        elapsedMs: 4,
      },
      {
        schemaVersion: 1,
        launchId: 'rs-16',
        sequence: 2,
        phase: 'main-window-constructed',
        elapsedMs: 17,
      },
    ]);
    assert.equal(modeOf(journalPath), STARTUP_PHASE_JOURNAL_MODE);
    assert.doesNotMatch(fs.readFileSync(journalPath, 'utf8'), /Users|Volumes|token|credential/i);
  } finally {
    journal.close();
    fs.rmSync(logDirectory, { recursive: true, force: true });
  }
});

test('startup journal truncates oversized history and rejects unsafe destinations', () => {
  const logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-startup-journal-cap-'));
  const journalPath = path.join(logDirectory, STARTUP_PHASE_JOURNAL_FILE);
  fs.writeFileSync(journalPath, 'x'.repeat(STARTUP_PHASE_JOURNAL_MAX_BYTES + 1));
  const journal = createStartupPhaseJournal({ logDirectory, now: () => 5000, processId: 7 });

  try {
    assert.equal(journal.mark('dependencies-loaded'), true);
    journal.close();
    const lines = fs.readFileSync(journalPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).phase, 'dependencies-loaded');

    const unsafePath = path.join(os.tmpdir(), `crate-startup-journal-link-${process.pid}-${Date.now()}`);
    fs.symlinkSync(logDirectory, unsafePath);
    try {
      const disabled = createStartupPhaseJournal({ logDirectory: unsafePath });
      assert.equal(disabled.enabled, false);
      assert.equal(disabled.mark('main-module-entered'), false);
    } finally {
      fs.unlinkSync(unsafePath);
    }
  } finally {
    journal.close();
    fs.rmSync(logDirectory, { recursive: true, force: true });
  }
});

test('startup journal keeps the file within the hard byte limit', () => {
  const logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-startup-journal-hard-cap-'));
  const journalPath = path.join(logDirectory, STARTUP_PHASE_JOURNAL_FILE);
  fs.writeFileSync(journalPath, 'x'.repeat(STARTUP_PHASE_JOURNAL_MAX_BYTES - 1));
  const journal = createStartupPhaseJournal({ logDirectory, now: () => 5000, processId: 8 });

  try {
    assert.equal(journal.mark('main-module-entered'), true);
    assert.equal(journal.mark('dependencies-loaded'), true);
    journal.close();
    assert.ok(fs.statSync(journalPath).size <= STARTUP_PHASE_JOURNAL_MAX_BYTES);
    assert.deepEqual(
      fs.readFileSync(journalPath, 'utf8').trim().split('\n').map(line => JSON.parse(line).phase),
      ['main-module-entered', 'dependencies-loaded']
    );
  } finally {
    journal.close();
    fs.rmSync(logDirectory, { recursive: true, force: true });
  }
});

test('startup outcome phases distinguish credential and watcher failures', () => {
  const logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-startup-journal-outcomes-'));
  const journal = createStartupPhaseJournal({ logDirectory, now: () => 5000, processId: 9 });

  try {
    for (const phase of [
      'figma-credential-storage-configured',
      'figma-credential-storage-failed',
      'watch-recovery-complete',
      'watch-recovery-failed',
    ]) {
      assert.equal(journal.mark(phase), true);
    }
    journal.close();
    assert.deepEqual(
      fs.readFileSync(path.join(logDirectory, STARTUP_PHASE_JOURNAL_FILE), 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line).phase),
      [
        'figma-credential-storage-configured',
        'figma-credential-storage-failed',
        'watch-recovery-complete',
        'watch-recovery-failed',
      ]
    );
  } finally {
    journal.close();
    fs.rmSync(logDirectory, { recursive: true, force: true });
  }
});

test('watch recovery treats a non-throwing null result as failure', () => {
  assert.equal(getWatchRecoveryPhase(null), 'watch-recovery-failed');
  assert.equal(getWatchRecoveryPhase(undefined), 'watch-recovery-failed');
  assert.equal(getWatchRecoveryPhase({ id: 'project-1' }), 'watch-recovery-complete');
});

test('startup journal fails open when logging is unavailable', () => {
  const missingDirectory = path.join(os.tmpdir(), `crate-startup-journal-missing-${process.pid}-${Date.now()}`);
  const journal = createStartupPhaseJournal({ logDirectory: missingDirectory });
  assert.equal(journal.enabled, false);
  assert.equal(journal.filePath, null);
  assert.equal(journal.mark('main-module-entered'), false);
  assert.doesNotThrow(() => journal.close());
});
