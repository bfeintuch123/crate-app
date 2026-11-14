'use strict';
// Run only by tests/fixtures/memory-guard/real-rejections.validation.js. Starts
// real set-uid tools that the memory guard must NOT let through, as
// CRATE_GUARD_FIXTURE_MODE says:
//
//   top          /usr/bin/top, which is not the tool the guard makes room for
//   blocked-ps   one /bin/ps that cannot finish, because nobody reads its output
//   nine-ps      nine of those at once
//
// Each is finite without the guard: top takes three samples and ends, and this
// file ends every ps itself after eight seconds, through the handle it holds
// on its own child.
const test = require('node:test');
const { spawn } = require('node:child_process');

const mode = process.env.CRATE_GUARD_FIXTURE_MODE;
const LIFE_MS = 8000;
// Wide enough that the listing cannot fit a pipe on any machine.
const wideListing = ['-axwwo', Array(16).fill('command=').join(',')];

function ended(child) {
  return new Promise(resolve => { child.on('exit', resolve); });
}

test(`starts ${mode}`, async () => {
  if (mode === 'top') {
    await ended(spawn('/usr/bin/top', ['-l', '3', '-s', '1'], { stdio: 'ignore' }));
    return;
  }
  const children = Array.from({ length: mode === 'nine-ps' ? 9 : 1 },
    () => spawn('/bin/ps', wideListing, { stdio: ['ignore', 'pipe', 'ignore'] }));
  const timer = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); }, LIFE_MS);
  await Promise.all(children.map(ended));
  clearTimeout(timer);
});
