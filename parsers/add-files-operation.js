'use strict';

/**
 * A small, dependency-free lease for one Add Files scan.  The lease is
 * intentionally per-scan: a stalled source must not consume a total batch
 * deadline or cancel the other queued sources.
 */
function createAddFilesScanLease(options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs >= 0
    ? options.timeoutMs
    : 30_000;
  const parentCurrent = typeof options.parentCurrent === 'function'
    ? options.parentCurrent
    : () => true;
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
  let state = 'active';
  let reason = null;
  let timer = null;
  let resolveTimeout;
  const cancelListeners = new Set();
  const timeoutPromise = new Promise(resolve => { resolveTimeout = resolve; });

  const disposeTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const cancel = (nextReason = 'cancelled') => {
    if (state !== 'active') return false;
    state = nextReason === 'timeout' ? 'timed-out' : 'cancelled';
    reason = nextReason;
    disposeTimer();
    resolveTimeout({ timedOut: state === 'timed-out', reason });
    for (const listener of [...cancelListeners]) {
      try { listener(reason); } catch (_) {}
    }
    cancelListeners.clear();
    return true;
  };

  timer = setTimer(() => cancel('timeout'), timeoutMs);
  return {
    timeoutMs,
    timeoutPromise,
    get state() { return state; },
    get reason() { return reason; },
    current() {
      if (state !== 'active') return false;
      if (!parentCurrent()) {
        cancel('stale-project-operation');
        return false;
      }
      return true;
    },
    cancel,
    onCancel(listener) {
      if (typeof listener !== 'function') return () => {};
      if (state !== 'active') {
        try { listener(reason); } catch (_) {}
        return () => {};
      }
      cancelListeners.add(listener);
      return () => cancelListeners.delete(listener);
    },
    dispose() {
      disposeTimer();
      cancelListeners.clear();
    },
  };
}

async function runBoundedAddFilesScan(work, options = {}) {
  const lease = createAddFilesScanLease(options);
  const workPromise = Promise.resolve().then(() => work(lease));
  const settled = workPromise.then(
    value => ({ status: 'complete', value }),
    error => ({ status: 'error', error })
  );
  const outcome = await Promise.race([
    settled,
    lease.timeoutPromise.then(value => ({
      status: value.timedOut ? 'timeout' : 'cancelled',
      ...value,
    })),
  ]);

  if (outcome.status === 'timeout') {
    lease.cancel(outcome.reason || 'timeout');
    return {
      timedOut: true,
      reason: outcome.reason || 'timeout',
      lease,
      settled,
    };
  }
  if (outcome.status === 'error') {
    lease.dispose();
    throw outcome.error;
  }
  if (outcome.status === 'cancelled') {
    lease.dispose();
    return {
      cancelled: true,
      reason: outcome.reason || 'cancelled',
      lease,
      settled,
    };
  }
  if (!lease.current()) {
    lease.dispose();
    return {
      cancelled: true,
      reason: lease.reason || 'cancelled',
      lease,
      value: outcome.value,
      settled,
    };
  }
  lease.dispose();
  return { value: outcome.value, lease, settled };
}

module.exports = {
  createAddFilesScanLease,
  runBoundedAddFilesScan,
};
