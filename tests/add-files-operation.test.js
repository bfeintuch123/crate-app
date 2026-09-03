'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { runAddFilesAttempt } = require('../parsers/add-files-operation');

function createFakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (callback, delay) => {
      const id = ++nextId;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    tick: async delay => {
      now += delay;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.callback();
      }
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('normal and slow-within-deadline attempts finalize once', async () => {
  const clock = createFakeClock();
  const slow = deferred();
  let finalizations = 0;
  const run = runAddFilesAttempt(async attempt => {
    await slow.promise;
    assert.equal(attempt.isCurrent(), true);
    finalizations += 1;
    return { success: true };
  }, { timeoutMs: 100, ...clock });

  await Promise.resolve();
  await clock.tick(50);
  slow.resolve();
  await Promise.resolve();
  const result = await run;

  assert.deepEqual(result.value, { success: true });
  assert.equal(result.timedOut, false);
  assert.equal(finalizations, 1);
  assert.equal(result.attempt.finalize('late'), false);
});

test('never-settling scan times out and fences its late completion', async () => {
  const clock = createFakeClock();
  const scan = deferred();
  let lateMutation = 0;
  const run = runAddFilesAttempt(async attempt => {
    await scan.promise;
    if (attempt.isCurrent()) lateMutation += 1;
    return { success: true };
  }, { timeoutMs: 100, ...clock });

  await clock.tick(100);
  const outcome = await run;
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.attempt.state, 'timed-out');

  scan.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lateMutation, 0);
});

test('late renderer refresh is rejected after timeout and supersession', async () => {
  const clock = createFakeClock();
  const refresh = deferred();
  let appliedProject = null;
  const run = runAddFilesAttempt(async attempt => {
    const projects = await refresh.promise;
    if (attempt.isCurrent()) appliedProject = projects;
    return projects;
  }, { timeoutMs: 25, ...clock });

  await clock.tick(25);
  const timeout = await run;
  assert.equal(timeout.timedOut, true);

  refresh.resolve([{ id: 'old-project' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(appliedProject, null);
});

test('cancellation models project switch and exact-once finalization', async () => {
  const clock = createFakeClock();
  const attempt = (await runAddFilesAttempt(async currentAttempt => {
    currentAttempt.cancel('project-switch');
    currentAttempt.cancel('project-switch');
    return 'must-not-win';
  }, { timeoutMs: 100, ...clock })).attempt;

  assert.equal(attempt.state, 'cancelled');
  assert.equal(attempt.reason, 'project-switch');
  assert.equal(attempt.cancel('timeout'), false);
  assert.equal(attempt.finalize('first'), false);
});
