'use strict';
// Run only by tests/run-tests-memory-guard.test.js. Starts the system's own
// `ps` the way tests in this repository do: over and over for about a second
// and a half, one at a time; a few at once; and one after another with this
// process too busy to collect each one when it ends. On macOS that tool is
// set-uid root, so the memory guard cannot read it; it has to let it through.
const test = require('node:test');
const { execFileSync, spawn } = require('node:child_process');

const PS = '/bin/ps';

test('lists processes with the system ps, repeatedly', async () => {
  const deadline = Date.now() + 1500;
  let calls = 0;
  while (Date.now() < deadline) {
    const listing = execFileSync(PS, ['-axo', 'pid=,command='], { encoding: 'utf8' });
    if (!listing.includes(String(process.pid))) throw new Error('ps did not list this process');
    calls += 1;
  }
  const outcomes = await Promise.all(Array.from({ length: 4 }, () => new Promise(resolve => {
    const child = spawn(PS, ['-axo', 'pid='], { stdio: 'ignore' });
    child.on('exit', code => resolve(code));
  })));
  for (let index = 0; index < 8; index += 1) {
    const child = spawn(PS, ['-axo', 'pid='], { stdio: 'ignore' });
    const ended = new Promise(resolve => { child.on('exit', resolve); });
    await new Promise(resolve => { setTimeout(resolve, 40); });
    // Busy, not waiting: a ps that has ended by now stays uncollected until this loop is over.
    const until = Date.now() + 80;
    while (Date.now() < until);
    outcomes.push(await ended);
  }
  if (calls < 5 || outcomes.some(code => code !== 0)) throw new Error(`ps calls ${calls}, exit codes ${outcomes.join()}`);
});
