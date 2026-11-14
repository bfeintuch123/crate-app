'use strict';

// Reason precedence for the working-file choice card. The production reason
// function and its identity helpers run against a synthetic in-memory disk.
// No Electron, store, producer app or real project data is loaded.
const test = require('node:test');
const assert = require('./bounded-assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function between(start, end) {
  const first = main.indexOf(start);
  const last = main.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `production anchor drift: ${start}`);
  return main.slice(first, last);
}

function fixture() {
  const disk = new Map();
  let dirty = false;
  const context = vm.createContext({
    path,
    fs: { statSync: filePath => {
      const stat = disk.get(filePath);
      if (!stat) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { ...stat, isFile: () => true };
    } },
    getAddFilesSourceIdentity: stat => ({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs }),
    hasInvalidWorkingSourceReceipt: () => false,
    hasWorkingSourceRecoveryRecord: () => false,
    hasUnsupportedInDesignRecoveryObligations: () => false,
    hasWorkingFileDirtyHold: () => dirty,
    getAssetBaselineSourceRecoveryRouteKey: () => 'route',
  });
  vm.runInContext(
    between('function getWorkingSourceDiskIdentity(', 'function getWorkingSourceVerification(') +
    between('// Renderer contract is an allowlist', '// Picker labels are bounded basenames.') +
    ';this.api = { getWorkingFileVerificationReason, getWorkingSourceDiskIdentity };', context);
  const source = { path: '/Users/synthetic/Saved copy.psd' };
  disk.set(source.path, { dev: 1, ino: 7, size: 4096, mtimeMs: 10, ctimeMs: 10 });
  const identity = () => context.api.getWorkingSourceDiskIdentity(source);
  const reason = receipt => context.api.getWorkingFileVerificationReason({ id: 'project-a' }, source, receipt);
  // Prior verified evidence, as the observed saved copy retained 50 references.
  const references = Array.from({ length: 50 }, (_, index) => ({ path: `/Users/synthetic/links/asset-${index}.png` }));
  const verified = () => ({ version: 1, status: 'scanned', reason: 'ordinary-scan-finished', attempt: 'a1',
    requiredReferences: references, unresolved: [], sourceFingerprint: 'f'.repeat(64), sourceIdentity: identity() });
  // Retry reserves a fresh attempt and clears the saved identity before scanning.
  const retried = prior => ({ ...prior, status: 'pending', reason: 'verification-required', attempt: 'a2', sourceIdentity: null });
  return { disk, source, identity, reason, verified, retried, references, setDirty(value) { dirty = value; } };
}

test('observed Retry timeout with cleared identity reports the timeout, not a file change', () => {
  const f = fixture();
  // failWorkingSourceScan writes scan-timeout; the Retry route then relabels it.
  const failed = { ...f.retried(f.verified()), status: 'failed', reason: 'add_files_scan_timeout', unresolved: [{ reason: 'scan-timeout' }] };
  assert.equal(failed.sourceIdentity, null);
  assert.equal(f.reason(failed), 'working-file-verification-timed-out');
  assert.equal(f.reason({ ...failed, reason: 'scan-timeout' }), 'working-file-verification-timed-out');
  assert.equal(failed.requiredReferences.length, 50, 'the classifier reads evidence without consuming it');
});

test('observed first-baseline timeout without any prior identity reports the timeout', () => {
  const f = fixture();
  const failed = { version: 1, status: 'failed', reason: 'scan-timeout', attempt: 'a1', requiredReferences: [],
    unresolved: [{ reason: 'scan-timeout' }], sourceFingerprint: null, sourceIdentity: null };
  assert.equal(f.reason(failed), 'working-file-verification-timed-out');
});

test('timeout precedes a proven identity mismatch; both remain fail-closed', () => {
  const f = fixture();
  const failed = { ...f.verified(), status: 'failed', reason: 'scan-timeout', unresolved: [{ reason: 'scan-timeout' }] };
  f.disk.get(f.source.path).mtimeMs = 99;
  assert.equal(f.reason(failed), 'working-file-verification-timed-out');
});

test('an inherited timeout entry never labels a later non-timeout failure', () => {
  const f = fixture();
  const cancelled = { ...f.retried(f.verified()), status: 'failed', reason: 'scan-cancelled', unresolved: [{ reason: 'scan-timeout' }] };
  assert.equal(f.reason(cancelled), 'working-file-verification-failed');
});

test('unknown failure with cleared identity is a failed verification, not a file change', () => {
  const f = fixture();
  for (const reason of ['scan_on_open_failed', 'asset_baseline_scan_incomplete', 'ordinary-scan-failed', 'scan-interrupted',
    'stale_project_operation', 'source-verification-unavailable']) {
    const failed = { ...f.retried(f.verified()), status: 'failed', reason, unresolved: [{ reason: 'ordinary-scan-failed' }] };
    assert.equal(f.reason(failed), 'working-file-verification-failed', reason);
  }
});

test('missing or unreadable source reports availability before any receipt fallback', () => {
  const f = fixture();
  const failed = { ...f.retried(f.verified()), status: 'failed', reason: 'add_files_scan_timeout' };
  f.disk.delete(f.source.path);
  assert.equal(f.reason(failed), 'working-file-source-unavailable');
  assert.equal(f.reason(f.verified()), 'working-file-source-unavailable');
  assert.equal(f.reason(null), 'working-file-source-unavailable');
  // A source-unavailable receipt for a file that stats now is not live proof
  // that it is missing; its writer also covers other failed scans.
  const g = fixture();
  assert.equal(g.reason({ ...g.retried(g.verified()), status: 'failed', reason: 'source-unavailable',
    unresolved: [{ reason: 'source-unavailable' }] }), 'working-file-verification-failed');
});

test('only a recorded identity mismatch says the file changed', () => {
  const f = fixture();
  const scanned = f.verified();
  // Refresh and scan routes also write these labels after digest read errors.
  assert.equal(f.reason({ ...scanned, status: 'stale', reason: 'source-bytes-changed' }), 'saved-file-verification-required');
  assert.equal(f.reason({ ...f.retried(scanned), status: 'failed', reason: 'source-bytes-changed' }), 'working-file-verification-failed');
  assert.equal(f.reason({ ...scanned, status: 'failed', reason: 'source-bytes-changed' }), 'working-file-verification-failed');
  f.disk.get(f.source.path).size = 8192;
  assert.equal(f.reason(scanned), 'working-file-source-changed', 'recorded identity no longer matches');
  assert.equal(f.reason({ ...scanned, status: 'stale', reason: 'source-bytes-changed' }), 'working-file-source-changed');
  assert.equal(f.reason({ ...scanned, status: 'failed', reason: 'ordinary-scan-failed' }), 'working-file-source-changed');
});

test('format findings name only what was observed and keep precedence', () => {
  const f = fixture();
  const withIssues = (...reasons) => ({ ...f.verified(), reason: 'declared-reference-unresolved', unresolved: reasons.map(reason => ({ reason })) });
  assert.equal(f.reason(withIssues('unsupported-link-form')), 'working-file-link-records-unrecognized');
  assert.equal(f.reason(withIssues('unresolved-link-record-framing')), 'working-file-link-records-unreadable');
  assert.equal(f.reason(withIssues('unexplained-link-tail')), 'working-file-link-records-unreadable');
  assert.equal(f.reason(withIssues('unresolved-link-record-framing', 'unsupported-link-form')), 'working-file-link-records-unrecognized');
  assert.equal(f.reason(withIssues('reference-coverage-limit')), 'working-file-link-coverage-limit');
  assert.equal(f.reason(withIssues('coverage-limit')), 'working-file-link-coverage-limit');
  assert.equal(f.reason(withIssues('unresolved-external')), 'working-file-dependencies-unverified');
  assert.equal(f.reason(withIssues('wire-parsed-record-disagreement')), 'working-file-dependencies-unverified');
  // Worker catch-alls stay generic; they are not promoted to a format claim.
  assert.equal(f.reason(withIssues('unsupported-or-malformed-framing')), 'working-file-dependencies-unverified');
  assert.equal(f.reason(withIssues('wire-coverage-not-examined')), 'working-file-dependencies-unverified');
  assert.equal(f.reason({ ...withIssues('unsupported-link-form'), status: 'stale' }), 'saved-file-verification-required');
  // Findings bound to other bytes are not reported as this file's format.
  const unbound = { ...withIssues('unsupported-link-form'), status: 'incomplete', sourceIdentity: null };
  assert.equal(f.reason(unbound), 'saved-file-verification-required');
});

test('existing save, pending and normal outcomes are unchanged', () => {
  const f = fixture();
  assert.equal(f.reason(f.retried(f.verified())), 'working-file-verification-pending');
  assert.equal(f.reason(null), 'saved-file-verification-required');
  assert.equal(f.reason(f.verified()), 'saved-file-verification-required');
  f.setDirty(true);
  assert.equal(f.reason({ ...f.verified(), status: 'failed', reason: 'scan-timeout' }), 'working-file-save-required');
  f.disk.delete(f.source.path);
  assert.equal(f.reason(null), 'working-file-save-required', 'dirty hold still precedes availability');
});

test('repeated Retry keeps reporting the current attempt only', () => {
  const f = fixture();
  let receipt = f.verified();
  for (let attempt = 0; attempt < 3; attempt++) {
    receipt = f.retried(receipt);
    assert.equal(f.reason(receipt), 'working-file-verification-pending');
    receipt = { ...receipt, status: 'failed', reason: 'add_files_scan_timeout', unresolved: [{ reason: 'scan-timeout' }] };
    assert.equal(f.reason(receipt), 'working-file-verification-timed-out');
  }
  assert.deepEqual(receipt.requiredReferences, f.references);
  assert.equal(receipt.sourceFingerprint, 'f'.repeat(64));
});

test('InDesign reasons are outside this correction', () => {
  const f = fixture();
  f.source.path = '/Users/synthetic/Layout.indd';
  f.disk.set(f.source.path, { dev: 1, ino: 8, size: 10, mtimeMs: 1, ctimeMs: 1 });
  assert.equal(f.reason({ version: 1, status: 'failed', reason: 'scan-timeout', sourceIdentity: null, requiredReferences: [], unresolved: [] }),
    'indesign-saved-file-unverified');
});
