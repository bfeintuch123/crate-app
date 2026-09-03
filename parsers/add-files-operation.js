'use strict';

/**
 * A small, dependency-free deadline and fencing primitive for user-visible
 * Add Files attempts.  A timeout is authoritative: it fences the attempt
 * before the timeout result is released.  Work that cannot be interrupted by
 * the underlying API may still settle later, but callers must use isCurrent()
 * before every side effect.
 */
function createAddFilesAttempt(options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs >= 0
    ? options.timeoutMs
    : 30_000;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
  let state = 'active';
  let reason = null;
  let timer = null;
  let finalized = false;
  const cancelListeners = new Set();
  let resolveTimeout;
  const timeoutPromise = new Promise(resolve => { resolveTimeout = resolve; });
  const deadlineAt = now() + timeoutMs;

  const finishTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const cancel = (nextReason = 'cancelled') => {
    if (state !== 'active') return false;
    state = nextReason === 'timeout' ? 'timed-out' : 'cancelled';
    reason = nextReason;
    finishTimer();
    resolveTimeout({ timedOut: state === 'timed-out', reason });
    for (const listener of [...cancelListeners]) {
      try { listener(reason); } catch (_) {}
    }
    cancelListeners.clear();
    return true;
  };
  const finalize = value => {
    if (finalized || state !== 'active') return false;
    finalized = true;
    finishTimer();
    return value;
  };

  timer = setTimer(() => cancel('timeout'), timeoutMs);
  return {
    timeoutMs,
    deadlineAt,
    isCurrent: () => state === 'active' && now() < deadlineAt,
    get state() { return state; },
    get reason() { return reason; },
    timeoutPromise,
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
    finalize,
    dispose: finishTimer,
  };
}

async function runAddFilesAttempt(work, options = {}) {
  const attempt = createAddFilesAttempt(options);
  const workPromise = Promise.resolve().then(() => work(attempt));
  const outcome = await Promise.race([
    workPromise.then(value => ({ timedOut: false, value })),
    attempt.timeoutPromise,
  ]);
  if (outcome.timedOut) {
    attempt.cancel(outcome.reason || 'timeout');
    return { ...outcome, attempt };
  }
  if (!attempt.isCurrent()) {
    return {
      timedOut: false,
      cancelled: true,
      reason: attempt.reason || 'cancelled',
      attempt,
    };
  }
  attempt.finalize(outcome.value);
  return { ...outcome, attempt };
}

module.exports = {
  createAddFilesAttempt,
  runAddFilesAttempt,
};
