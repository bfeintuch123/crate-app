'use strict';

// Measurement-only continuation state. No app launch, file IO, IPC, or selection
// authority. No app/version/bridge has native qualification; callers cannot
// enable automatic selection through a snapshot or configuration flag.
const path = require('node:path');
const MAX_DOCUMENTS = 64;
const MAX_SESSION_HANDLES = 2048;
const text = (value, max = 256) => typeof value === 'string' && value.length > 0 &&
  value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const processIdentity = value => value && Number.isSafeInteger(value.pid) && value.pid > 0 &&
  text(value.startToken) ? JSON.stringify([value.pid, value.startToken]) : null;

function normalizeSnapshot(value) {
  if (!value || value.complete !== true || !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
      !text(value.projectId) || !text(value.activationToken) || !text(value.app) ||
      !text(value.version) || !text(value.bridge) || !text(value.handleKind)) return null;
  // The future trusted acquisition route must read actual OS process identity
  // around the bridge call. This helper never synthesizes it from wall time,
  // filenames, app labels, or document IDs, and PID alone is insufficient.
  const epoch = processIdentity(value.processBefore);
  if (!epoch || epoch !== processIdentity(value.processAfter)) return null;
  if (!Array.isArray(value.documents) || value.documents.length > MAX_DOCUMENTS ||
      value.documentCount !== value.documents.length) return null;
  const docs = new Map(), paths = new Set();
  let currentCount = 0;
  for (const row of value.documents) {
    if (!row || !text(row.handle, 128) || docs.has(row.handle) ||
        typeof row.saved !== 'boolean' || typeof row.current !== 'boolean' ||
        (row.path !== null && (!text(row.path, 16384) || !path.posix.isAbsolute(row.path) ||
          path.posix.normalize(row.path) !== row.path || paths.has(row.path)))) return null;
    if (row.path !== null) paths.add(row.path);
    if (row.current) currentCount++;
    docs.set(row.handle, { handle: row.handle, path: row.path, saved: row.saved, current: row.current });
  }
  if (currentCount > 1) return null;
  return { sequence: value.sequence, docs,
    scope: JSON.stringify([value.projectId, value.activationToken, value.app, value.version, value.bridge, value.handleKind]), epoch };
}

function createWorkingSourceWitnessTracker() {
  let previous = null, inventory = null, scope = null, epoch = null, sequence = 0;
  let seen = new Set(), retired = new Set(), quarantined = false;
  const result = (kind, reason, transition = null) => Object.freeze({ kind, reason,
    automaticSelectionAllowed: false, qualification: 'disabled-native-proof-missing', transition });
  return Object.freeze({
    reset() { previous = inventory = null; scope = epoch = null; sequence = 0; seen = new Set(); retired = new Set(); quarantined = false; },
    observe(input) {
      const next = normalizeSnapshot(input);
      if (!next) { previous = null; return result('invalidate', 'incomplete-or-invalid-observation'); }
      if (next.scope !== scope || next.epoch !== epoch) {
        const hadScope = scope !== null;
        scope = next.scope; epoch = next.epoch; sequence = next.sequence;
        previous = inventory = next; seen = new Set(next.docs.keys()); retired = new Set(); quarantined = false;
        return result(hadScope ? 'invalidate' : 'baseline', hadScope ? 'scope-or-process-changed' : 'first-complete-observation');
      }
      if (next.sequence <= sequence) {
        previous = null;
        return result('invalidate', 'replayed-or-out-of-order-poll');
      }
      const consecutive = next.sequence === sequence + 1;
      sequence = next.sequence;
      if (quarantined) { previous = null; return result('invalidate', 'session-handle-contract-failed'); }
      // Complete, in-order inventories prove closure even when a gap or failed
      // poll has invalidated the separate consecutive transition baseline.
      for (const handle of inventory.docs.keys()) if (!next.docs.has(handle)) retired.add(handle);
      inventory = next;
      for (const handle of next.docs.keys()) {
        if (retired.has(handle)) { quarantined = true; previous = null; return result('invalidate', 'closed-handle-reused'); }
        seen.add(handle);
      }
      if (seen.size > MAX_SESSION_HANDLES) {
        quarantined = true; previous = null; return result('invalidate', 'session-handle-limit');
      }
      const before = previous;
      previous = next;
      if (!before || !consecutive) {
        // Discard the gap-ending sample; require fresh consecutive evidence
        // after it rather than turning that uncertain interval into a baseline.
        if (!consecutive) previous = null;
        return result('invalidate', 'poll-gap');
      }
      if (before.docs.size !== next.docs.size || [...before.docs.keys()].some(handle => !next.docs.has(handle))) {
        return result('none', 'document-set-changed');
      }
      const changed = [...next.docs.values()].filter(row => before.docs.get(row.handle).path !== row.path);
      if (!changed.length) return result('none', 'no-path-transition');
      if (changed.length !== 1) return result('invalidate', 'multiple-path-transitions');
      const after = changed[0], old = before.docs.get(after.handle);
      if (!old.path || !after.path || !after.saved || !after.current || !old.current) {
        return result('none', 'unsaved-first-save-or-background-transition');
      }
      // Identical handle + new path is a hypothesis, not a Save As event.
      // Copy/duplicate lifetime, file identities, admission and ordinary source
      // verification still require the future qualified integration path.
      return result('candidate', 'unqualified-handle-path-transition', Object.freeze({
        handle: after.handle, predecessorPath: old.path, successorPath: after.path,
        previousSequence: before.sequence, sequence: next.sequence,
      }));
    },
  });
}

// Maps only properties present in the installed Keynote scripting dictionary.
// This does not execute AppleScript or claim a document-ID lifetime contract.
function createKeynoteWitnessObservation(envelope, documents) {
  if (!Array.isArray(documents) || documents.length > MAX_DOCUMENTS) return null;
  const snapshot = { ...envelope, app: 'keynote', bridge: 'applescript', handleKind: 'scriptIdentifier',
    documents: documents.map(row => ({ handle: row?.id, path: row?.file,
      saved: typeof row?.modified === 'boolean' ? !row.modified : null, current: row?.current })) };
  return normalizeSnapshot(snapshot) ? snapshot : null;
}

module.exports = { createWorkingSourceWitnessTracker, createKeynoteWitnessObservation };
