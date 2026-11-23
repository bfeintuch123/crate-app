'use strict';

/**
 * Phase 4A — Coalesced Delta IPC Bridge
 *
 * Replaces repeated full-array (`files[]`, `pendingFiles[]`) IPC broadcasts
 * with revisioned per-item deltas (`added`, `updated`, `removed`) keyed by
 * stable file identity, plus payload-signature deduplication so unchanged
 * snapshots emit zero redundant IPC messages.
 *
 * Pure, dependency-free, deterministic module usable in both main and renderer.
 */

const crypto = require('node:crypto');

function getStableItemKey(item) {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.fileId === 'string' && item.fileId.length > 0) return `id:${item.fileId}`;
  if (typeof item.id === 'string' && item.id.length > 0) return `id:${item.id}`;
  if (typeof item.path === 'string' && item.path.length > 0) {
    const suffix = item.embedded && item.embeddedIndex !== undefined ? `#emb:${item.embeddedIndex}` : '';
    return `path:${item.path.toLowerCase()}${suffix}`;
  }
  if (typeof item.name === 'string' && item.name.length > 0) return `name:${item.name.toLowerCase()}`;
  return null;
}

function fingerprintItem(item) {
  try {
    return crypto.createHash('sha256').update(JSON.stringify(item)).digest('hex').slice(0, 16);
  } catch (_) {
    return '';
  }
}

function buildIndexedSnapshot(items) {
  const list = Array.isArray(items) ? items : [];
  const entries = new Map();
  const order = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const baseKey = getStableItemKey(item) || `idx:${i}`;
    let key = baseKey;
    if (entries.has(key)) {
      let n = 2;
      while (entries.has(`${baseKey}#${n}`)) n++;
      key = `${baseKey}#${n}`;
    }
    const fp = fingerprintItem(item);
    entries.set(key, { key, fp, item });
    order.push(key);
  }
  return { entries, order };
}

function diffSnapshots(prevSnapshot, nextSnapshot) {
  const added = [];
  const updated = [];
  const removed = [];

  const prevEntries = prevSnapshot ? prevSnapshot.entries : new Map();
  const nextEntries = nextSnapshot.entries;

  for (const key of nextSnapshot.order) {
    const nextEntry = nextEntries.get(key);
    const prevEntry = prevEntries.get(key);
    if (!prevEntry) {
      added.push({ key, item: nextEntry.item });
    } else if (prevEntry.fp !== nextEntry.fp) {
      updated.push({ key, item: nextEntry.item });
    }
  }

  if (prevSnapshot) {
    for (const key of prevSnapshot.order) {
      if (!nextEntries.has(key)) {
        removed.push(key);
      }
    }
  }

  let orderChanged = false;
  if (!prevSnapshot || prevSnapshot.order.length !== nextSnapshot.order.length) {
    orderChanged = true;
  } else if (added.length === 0 && removed.length === 0) {
    for (let i = 0; i < nextSnapshot.order.length; i++) {
      if (prevSnapshot.order[i] !== nextSnapshot.order[i]) {
        orderChanged = true;
        break;
      }
    }
  }

  const changed = !prevSnapshot || added.length > 0 || updated.length > 0 || removed.length > 0 || orderChanged;
  return {
    changed,
    added,
    updated,
    removed,
    orderChanged,
    totalCount: nextSnapshot.order.length,
  };
}

/**
 * Apply a delta produced by `diffSnapshots` onto an existing item array in
 * O(N) without re-creating unchanged item references.
 */
function applyProjectFileDelta(currentItems, delta) {
  if (!delta || typeof delta !== 'object') return Array.isArray(currentItems) ? currentItems : [];
  const base = Array.isArray(currentItems) ? currentItems : [];
  if (!delta.changed) return base;

  const removedSet = new Set(Array.isArray(delta.removed) ? delta.removed : []);
  const updatedMap = new Map();
  for (const entry of delta.updated || []) {
    if (entry && typeof entry.key === 'string') updatedMap.set(entry.key, entry.item);
  }

  const seenCounts = new Map();
  const next = [];
  for (let i = 0; i < base.length; i++) {
    const item = base[i];
    const baseKey = getStableItemKey(item) || `idx:${i}`;
    const count = (seenCounts.get(baseKey) || 0) + 1;
    seenCounts.set(baseKey, count);
    const key = count === 1 ? baseKey : `${baseKey}#${count}`;
    if (removedSet.has(key)) continue;
    if (updatedMap.has(key)) {
      next.push(updatedMap.get(key));
    } else {
      next.push(item);
    }
  }
  for (const entry of delta.added || []) {
    if (entry && entry.item !== undefined) next.push(entry.item);
  }
  return next;
}

class ProjectIpcDeltaBridge {
  constructor({ coalesceMs = 0 } = {}) {
    this.coalesceMs = Number.isInteger(coalesceMs) && coalesceMs > 0 ? coalesceMs : 0;
    this.projectState = new Map(); // projectId -> { revision, filesSnap, pendingSnap }
    this.pendingTimers = new Map(); // projectId -> { timer, emitFn }
  }

  computeProjectUpdate(projectId, files = [], pendingFiles = []) {
    if (typeof projectId !== 'string' || !projectId) {
      return null;
    }
    const existing = this.projectState.get(projectId) || {
      revision: 0,
      filesSnap: null,
      pendingSnap: null,
    };

    const nextFilesSnap = buildIndexedSnapshot(files);
    const nextPendingSnap = buildIndexedSnapshot(pendingFiles);

    const filesDelta = diffSnapshots(existing.filesSnap, nextFilesSnap);
    const pendingDelta = diffSnapshots(existing.pendingSnap, nextPendingSnap);
    const anyChanged = filesDelta.changed || pendingDelta.changed;
    const revision = anyChanged ? existing.revision + 1 : existing.revision;

    this.projectState.set(projectId, {
      revision,
      filesSnap: nextFilesSnap,
      pendingSnap: nextPendingSnap,
    });

    return {
      projectId,
      revision,
      anyChanged,
      filesChanged: filesDelta.changed,
      pendingChanged: pendingDelta.changed,
      filesDelta,
      pendingDelta,
      counts: {
        files: nextFilesSnap.order.length,
        pending: nextPendingSnap.order.length,
      },
    };
  }

  /**
   * Schedule an emission for a projectId. When `coalesceMs === 0` (default),
   * invokes `emitFn` synchronously for deterministic tests; when `coalesceMs > 0`,
   * coalesces burst updates within a single animation frame window.
   */
  schedule(projectId, emitFn) {
    if (typeof emitFn !== 'function') return;
    if (this.coalesceMs <= 0) {
      emitFn();
      return;
    }
    const pending = this.pendingTimers.get(projectId);
    if (pending && !pending.coalesced) {
      pending.emitFn = emitFn;
      return;
    }
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingTimers.delete(projectId);
    }
    const entry = { coalesced: false, emitFn, timer: null };
    entry.timer = setTimeout(() => {
      this.pendingTimers.delete(projectId);
      entry.emitFn();
    }, this.coalesceMs);
    if (typeof entry.timer.unref === 'function') entry.timer.unref();
    this.pendingTimers.set(projectId, entry);
  }

  /**
   * Coalesce notifications per projectId while retaining the union of scheduled
   * activation tokens and account-authorization assertions so a stale caller
   * cannot overwrite/drop an earlier valid refresh, and logout/account changes
   * cannot leak queued notifications.
   */
  scheduleCoalesced(projectId, { activationToken = null, assertAuthorized = null, emitFn } = {}) {
    if (typeof projectId !== 'string' || !projectId || typeof emitFn !== 'function') return;
    const caller = {
      activationToken,
      assertAuthorized: typeof assertAuthorized === 'function' ? assertAuthorized : null,
    };
    const invoke = (entry) => {
      entry.emitFn({
        tokens: entry.tokens,
        hasNullToken: entry.hasNullToken,
        authChecks: entry.authChecks,
        callers: entry.callers,
      });
    };
    if (this.coalesceMs <= 0) {
      invoke({
        emitFn,
        tokens: activationToken === null ? new Set() : new Set([activationToken]),
        hasNullToken: activationToken === null,
        authChecks: caller.assertAuthorized ? [caller.assertAuthorized] : [],
        callers: [caller],
      });
      return;
    }
    const existing = this.pendingTimers.get(projectId);
    if (existing && existing.coalesced) {
      if (activationToken === null) existing.hasNullToken = true;
      else existing.tokens.add(activationToken);
      if (caller.assertAuthorized) existing.authChecks.push(caller.assertAuthorized);
      existing.callers.push(caller);
      existing.emitFn = emitFn;
      return;
    }
    if (existing) {
      clearTimeout(existing.timer);
      this.pendingTimers.delete(projectId);
    }
    const entry = {
      coalesced: true,
      tokens: activationToken === null ? new Set() : new Set([activationToken]),
      hasNullToken: activationToken === null,
      authChecks: caller.assertAuthorized ? [caller.assertAuthorized] : [],
      callers: [caller],
      emitFn,
      timer: null,
    };
    entry.timer = setTimeout(() => {
      if (this.pendingTimers.get(projectId) !== entry) return;
      this.pendingTimers.delete(projectId);
      invoke(entry);
    }, this.coalesceMs);
    if (typeof entry.timer.unref === 'function') entry.timer.unref();
    this.pendingTimers.set(projectId, entry);
  }

  flush(projectId = null) {
    const fire = (entry) => {
      if (entry.coalesced) {
        entry.emitFn({
          tokens: entry.tokens,
          hasNullToken: entry.hasNullToken,
          authChecks: entry.authChecks,
          callers: entry.callers,
        });
      } else {
        entry.emitFn();
      }
    };
    if (projectId) {
      const entry = this.pendingTimers.get(projectId);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pendingTimers.delete(projectId);
      fire(entry);
      return;
    }
    for (const [id, entry] of [...this.pendingTimers.entries()]) {
      clearTimeout(entry.timer);
      this.pendingTimers.delete(id);
      fire(entry);
    }
  }

  clearProject(projectId) {
    if (typeof projectId !== 'string' || !projectId) return;
    const pending = this.pendingTimers.get(projectId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingTimers.delete(projectId);
    }
    this.projectState.delete(projectId);
  }

  clearAll() {
    for (const entry of this.pendingTimers.values()) {
      clearTimeout(entry.timer);
    }
    this.pendingTimers.clear();
    this.projectState.clear();
  }

  getRevision(projectId) {
    return this.projectState.get(projectId)?.revision || 0;
  }
}

module.exports = {
  ProjectIpcDeltaBridge,
  applyProjectFileDelta,
  buildIndexedSnapshot,
  diffSnapshots,
  getStableItemKey,
};
