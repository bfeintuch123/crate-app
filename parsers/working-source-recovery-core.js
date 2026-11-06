'use strict';

// Result-only verification. The caller supplies read-only extraction primitives,
// plus a current capability covering project/source identity and retry intent.
// No project, receipt, store, baseline, admission, or publisher is accepted.
const path = require('node:path');
const IDENTITY_KEYS = ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'];
const MAX_PARSE_FILE_SIZE = 300 * 1024 * 1024;
const MAX_REFERENCES = 8192;
const MAX_ISSUES = 128;
const LIVE_UNBOUND = 'indesign-live-current-bytes-unbound';
const SAVED_FALLBACK = 'saved-byte-regex-fallback';

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}
function copyIdentity(value) {
  if (!value || !IDENTITY_KEYS.every(key => Number.isFinite(value[key])) ||
      !Number.isSafeInteger(value.size) || value.size < 0) throw new Error('source-unavailable');
  return Object.freeze(Object.fromEntries(IDENTITY_KEYS.map(key => [key, value[key]])));
}
function sameIdentity(a, b) {
  return !!a && !!b && IDENTITY_KEYS.every(key => a[key] === b[key]);
}
function normalizeFailure(error) {
  const reason = error?.message;
  if (reason === 'asset_baseline_source_changed' || reason === 'source-bytes-changed') return 'source-bytes-changed';
  if (reason === 'asset_baseline_source_too_large') return 'ordinary-extractor-source-too-large';
  if (reason === 'indesign-access-denied') return reason;
  if (reason === 'indesign-document-dirty') return reason;
  if (reason === 'scan-timeout') return reason;
  if (reason === 'recovery-capability-stale' || reason === 'add_files_parser_cancelled') return 'recovery-capability-stale';
  if (reason === 'indesign-query-failed' || reason?.startsWith('asset_baseline_indesign_')) return 'indesign-query-failed';
  if (reason === 'source-unavailable') return reason;
  if (reason === 'source-verification-unavailable') return reason;
  if (reason === 'recovery-extractor-invalid-result') return reason;
  return 'ordinary-scan-failed';
}

/**
 * verifyInDesignRecovery({ filePath, capability: { current, onCancel? }, timeoutMs? }, deps)
 * deps (existing function signatures, read-only in this use):
 *   getWorkingSourceDiskIdentity({ path }) -> { dev, ino, size, mtimeMs, ctimeMs } | null
 *   getAddFilesCurrentSourceDigest(path, lease, identity) -> Promise<sha256>
 *   assertDependableAssetBaselineSource(path, { isCurrent }) -> Promise<null> for .indd
 *   extractLinkedAssets(path, options) -> Promise<string[]>
 *   collectWorkingSourceScanEvidence(paths, inventory) -> bounded evidence
 *   runBoundedAddFilesScan(work, { parentCurrent, timeoutMs }) -> bounded outcome
 *
 * Returns { success, eligible, reason, verification, dirtyObservation }.
 * success means extraction completed, NOT that recovery is authorized.
 * eligible is only this core's extraction gate, NOT a commit capability.
 * The caller must recheck its capability, exact old raw receipt, selection/pair
 * revisions and the returned full disk identity synchronously at atomic commit.
 * Dirty observations must be persisted through the trusted existing observer
 * path outside this core, under its own source/epoch/current checks.
 */
async function verifyInDesignRecovery(input, deps) {
  const filePath = input?.filePath;
  const capability = input?.capability;
  let dirtyObservation = null;
  let dirty = false;
  let finished = false;
  let activeLease = null;
  let removeCancel = () => {};
  const failed = (reason) => freeze({
    success: false, eligible: false, reason,
    verification: {
      status: reason === 'source-bytes-changed' ? 'stale' : reason === 'ordinary-extractor-source-too-large' ? 'limited' : 'failed',
      reason, provider: 'ordinary-indd', coverage: 'ordinary-route', version: 1,
      inventoryStatus: 'unverified', requiredReferences: [], unresolved: [{ reason }],
      notes: ['required-reference-domain-unverified'], sourceIdentity: null, sourceFingerprint: null,
    },
    dirtyObservation,
  });
  const parentCurrent = () => {
    try { return !finished && capability?.current() === true; } catch (_) { return false; }
  };
  const check = () => {
    if (dirty) throw new Error('indesign-document-dirty');
    if (!parentCurrent() || (activeLease && !activeLease.current())) throw new Error('recovery-capability-stale');
  };
  try {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.length > 16384 || filePath.includes('\0') ||
        path.extname(filePath).toLowerCase() !== '.indd') return failed('recovery-extractor-invalid-result');
    check();
    const timeoutMs = Number.isFinite(input.timeoutMs) && input.timeoutMs >= 0
      ? Math.min(input.timeoutMs, 30_000) : 30_000;
    const outcome = await deps.runBoundedAddFilesScan(async lease => {
      activeLease = lease;
      if (typeof capability.onCancel === 'function') {
        const cleanup = capability.onCancel(() => lease.cancel('recovery-capability-stale'));
        if (typeof cleanup === 'function') removeCancel = cleanup;
      }
      check();
      const sourceIdentity = copyIdentity(deps.getWorkingSourceDiskIdentity({ path: filePath }));
      if (sourceIdentity.size > MAX_PARSE_FILE_SIZE) throw new Error('asset_baseline_source_too_large');
      const assertIdentity = () => {
        check();
        if (!sameIdentity(sourceIdentity, deps.getWorkingSourceDiskIdentity({ path: filePath }))) throw new Error('asset_baseline_source_changed');
        check();
      };
      const digest = async () => {
        assertIdentity();
        const value = await deps.getAddFilesCurrentSourceDigest(filePath, lease, sourceIdentity);
        assertIdentity();
        if (!/^[a-f0-9]{64}$/.test(value || '')) throw new Error('source-verification-unavailable');
        return value;
      };
      const sourceFingerprint = await digest();
      check();
      await deps.assertDependableAssetBaselineSource(filePath, { isCurrent: () => parentCurrent() && !dirty && lease.current() });
      assertIdentity();
      let providerNote = null;
      let extractionFailed = false;
      let extractionLimited = false;
      let declaredIssueLimit = false;
      const declaredIssues = [];
      const callbacksCurrent = () => { check(); };
      const paths = await deps.extractLinkedAssets(filePath, {
        strict: true, ordinaryVerification: true, verifySelectedSource: true,
        onOrdinaryScanFailure() { callbacksCurrent(); extractionFailed = true; },
        onOrdinaryScanLimit() { callbacksCurrent(); extractionLimited = true; },
        onProvider(value) {
          callbacksCurrent();
          if (![LIVE_UNBOUND, SAVED_FALLBACK].includes(value) || (providerNote && providerNote !== value)) {
            extractionFailed = true;
            return;
          }
          providerNote = value;
        },
        onInDesignDirtyDocument(document, order) {
          callbacksCurrent();
          dirty = true;
          const validOrder = order && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(order.epoch || '') &&
            Number.isSafeInteger(order.sequence) && order.sequence > 0;
          dirtyObservation = freeze({ sourceDocumentPath: filePath,
            documentModified: document?.modified === true ? true : document?.modified === false ? false : null,
            order: validOrder ? { epoch: order.epoch, sequence: order.sequence } : null });
          throw new Error('indesign-document-dirty');
        },
        onUnresolvedDependency(reason) {
          callbacksCurrent();
          if (declaredIssues.length < MAX_ISSUES) declaredIssues.push({
            reason: typeof reason === 'string' && reason.length > 0 && reason.length <= 128 ? reason : 'unsupported-dependency-form',
          });
          else declaredIssueLimit = true;
        },
      });
      check(); // Also catches a provider that swallows the dirty callback throw.
      if (!Array.isArray(paths)) throw new Error('recovery-extractor-invalid-result');
      if (!providerNote || extractionFailed) throw new Error('source-verification-unavailable');
      if (sourceFingerprint !== await digest()) throw new Error('asset_baseline_source_changed');
      check();
      const inputLimited = paths.length > MAX_REFERENCES;
      const evidence = deps.collectWorkingSourceScanEvidence(paths.slice(0, MAX_REFERENCES), {
        references: [], notes: [], unresolved: declaredIssues,
      });
      check();
      // Treat even the internal collector's output as data, never mutable store state.
      if (!evidence || !Array.isArray(evidence.requiredReferences) || evidence.requiredReferences.length > MAX_REFERENCES ||
          !evidence.requiredReferences.every(ref => ref && typeof ref.path === 'string' && path.isAbsolute(ref.path) &&
            ref.path.length <= 16384 && !ref.path.includes('\0')) ||
          evidence.requiredReferences.reduce((sum, ref) => sum + ref.path.length, 0) > 4 * 1024 * 1024 ||
          !Array.isArray(evidence.unresolved) || evidence.unresolved.length > MAX_ISSUES ||
          !evidence.unresolved.every(item => item && typeof item.reason === 'string' && item.reason.length > 0 && item.reason.length <= 128)) {
        throw new Error('recovery-extractor-invalid-result');
      }
      const unresolved = evidence.unresolved.map(item => ({ reason: item.reason }));
      const limited = !!evidence.limited || inputLimited || extractionLimited || declaredIssueLimit;
      const requireIssue = reason => {
        if (unresolved.some(item => item.reason === reason)) return;
        if (unresolved.length === MAX_ISSUES) {
          const replaceable = unresolved.findIndex(item => !['reference-coverage-limit', LIVE_UNBOUND].includes(item.reason));
          unresolved.splice(replaceable >= 0 ? replaceable : unresolved.length - 1, 1);
        }
        unresolved.push({ reason });
      };
      if (limited) requireIssue('reference-coverage-limit');
      if (providerNote === LIVE_UNBOUND) requireIssue(LIVE_UNBOUND);
      const notes = ['required-reference-domain-unverified', providerNote];
      const status = limited ? 'limited' : 'scanned';
      const reason = extractionLimited ? 'ordinary-extractor-source-too-large'
        : limited ? 'reference-coverage-limit' : unresolved.length ? 'declared-reference-unresolved' : 'ordinary-scan-finished';
      const result = freeze({ success: true, eligible: status === 'scanned' && unresolved.length === 0,
        reason, verification: { status, reason, provider: 'ordinary-indd', coverage: 'ordinary-route', version: 1,
          inventoryStatus: 'unverified', sourceIdentity: { ...sourceIdentity }, sourceFingerprint,
          requiredReferences: evidence.requiredReferences.map(ref => ({ path: ref.path })), unresolved, notes },
        dirtyObservation: null });
      assertIdentity();
      return result;
    }, { parentCurrent, timeoutMs });
    if (outcome.timedOut) return failed('scan-timeout');
    if (outcome.cancelled) return failed(dirty ? 'indesign-document-dirty' : 'recovery-capability-stale');
    check();
    // The bounded runner itself awaits: seal again after that asynchronous gap.
    if (!sameIdentity(outcome.value?.verification.sourceIdentity, deps.getWorkingSourceDiskIdentity({ path: filePath }))) {
      return failed('source-bytes-changed');
    }
    check();
    return outcome.value;
  } catch (error) {
    return failed(dirty ? 'indesign-document-dirty' : normalizeFailure(error));
  } finally {
    finished = true;
    try { removeCancel(); } catch (_) {}
    activeLease?.cancel('recovery-core-finished');
  }
}

module.exports = { verifyInDesignRecovery };
