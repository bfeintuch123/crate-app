'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_CHUNK_BYTES,
  startPackageTransactionWorker,
} = require('../parsers/package-transaction-worker');

class TestParentPort extends EventEmitter {
  constructor() {
    super();
    this.messages = [];
  }

  postMessage(message) {
    this.messages.push(message);
  }

  send(message) {
    this.emit('message', { data: message });
  }
}

function withTemporaryWorkingDirectory(t) {
  const original = process.cwd();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-package-worker-'));
  process.chdir(directory);
  t.after(() => {
    process.chdir(original);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function startTestWorker(options = {}) {
  const port = new TestParentPort();
  const exits = [];
  startPackageTransactionWorker(port, { ...options, exit: code => exits.push(code) });
  return { port, exits };
}

function currentIdentity() {
  const stat = fs.statSync('.', { bigint: true });
  return { dev: `${stat.dev}`, ino: `${stat.ino}` };
}

function ancestryFor(candidatePath = '.') {
  const ancestry = [];
  let currentPath = fs.realpathSync(candidatePath);
  while (true) {
    const stat = fs.statSync(currentPath, { bigint: true });
    ancestry.push({ dev: `${stat.dev}`, ino: `${stat.ino}` });
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) break;
    currentPath = parentPath;
  }
  return ancestry;
}

function initializeSession(port, options = {}) {
  port.send({
    type: 'init-session',
    identity: options.identity || currentIdentity(),
    ancestries: options.ancestries || [ancestryFor()],
    ownedOutputs: options.ownedOutputs || [],
  });
}

function writeFileThroughSession(port, leafName, chunks) {
  const expectedLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  port.send({ type: 'write-start', leafName, expectedLength: `${expectedLength}` });
  const opened = port.messages.shift();
  assert.equal(opened.type, 'opened');
  assert.match(opened.outputIdentity.dev, /^\d+$/u);
  assert.match(opened.outputIdentity.ino, /^\d+$/u);
  port.send({ type: 'ownership-ack', outputIdentity: opened.outputIdentity });
  assert.deepEqual(port.messages.shift(), { type: 'ready' });
  chunks.forEach((chunk, sequence) => {
    port.send({ type: 'chunk', sequence, data: chunk });
    assert.deepEqual(port.messages.shift(), { type: 'ack', sequence });
  });
  port.send({ type: 'end', sequence: chunks.length });
  return port.messages.shift();
}

test('utility worker reuses one pinned session for multiple acknowledged writes', async t => {
  const directory = withTemporaryWorkingDirectory(t);
  const { port, exits } = startTestWorker();
  initializeSession(port);
  assert.deepEqual(port.messages.shift(), { type: 'session-ready' });

  const first = Buffer.alloc(MAX_CHUNK_BYTES, 0x41);
  const firstComplete = writeFileThroughSession(port, 'reviewed.ai', [first, Buffer.from('tail')]);
  assert.equal(firstComplete.type, 'complete');
  assert.equal(firstComplete.bytesWritten, `${first.length + 4}`);
  assert.match(firstComplete.outputIdentity.dev, /^\d+$/u);
  assert.match(firstComplete.outputIdentity.ino, /^\d+$/u);

  const secondComplete = writeFileThroughSession(port, 'second.ai', [Buffer.from('second')]);
  assert.equal(secondComplete.type, 'complete');
  assert.equal(secondComplete.bytesWritten, '6');
  assert.deepEqual(exits, []);
  assert.equal(fs.statSync(path.join(directory, 'reviewed.ai')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(directory, 'second.ai')).mode & 0o777, 0o600);

  port.send({ type: 'release' });
  assert.deepEqual(port.messages.shift(), { type: 'released' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(exits, [0]);
});

test('utility worker rejects out-of-order chunks and removes every session-owned output', async t => {
  const directory = withTemporaryWorkingDirectory(t);
  const { port, exits } = startTestWorker();
  initializeSession(port);
  port.messages.length = 0;
  assert.equal(writeFileThroughSession(port, 'first.png', [Buffer.from('first')]).type, 'complete');
  port.send({ type: 'write-start', leafName: 'ordered.png', expectedLength: '7' });
  const opened = port.messages.shift();
  port.send({ type: 'ownership-ack', outputIdentity: opened.outputIdentity });
  port.messages.length = 0;
  port.send({ type: 'chunk', sequence: 1, data: Buffer.from('private') });

  assert.deepEqual(port.messages, [{ type: 'failed' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(exits, [72]);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('utility worker removes an opened output when ownership is not acknowledged', async t => {
  const directory = withTemporaryWorkingDirectory(t);
  const { port, exits } = startTestWorker({ ownershipAckTimeoutMs: 5 });
  initializeSession(port);
  port.messages.length = 0;
  port.send({ type: 'write-start', leafName: 'unacknowledged.ai', expectedLength: '7' });

  assert.equal(port.messages.shift().type, 'opened');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(port.messages, [{ type: 'failed' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(exits, [72]);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('utility worker removes its exact output when descriptor hardening fails', async t => {
  const directory = withTemporaryWorkingDirectory(t);
  const originalFchmod = fs.fchmodSync;
  fs.fchmodSync = () => { throw new Error('simulated fchmod failure'); };
  t.after(() => { fs.fchmodSync = originalFchmod; });
  const { port, exits } = startTestWorker();
  initializeSession(port);
  port.messages.length = 0;
  port.send({ type: 'write-start', leafName: 'unhardened.ai', expectedLength: '7' });

  assert.deepEqual(port.messages, [{ type: 'failed' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(exits, [72]);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('utility worker removes a renamed output before writing private bytes', async t => {
  const directory = withTemporaryWorkingDirectory(t);
  const { port, exits } = startTestWorker();
  initializeSession(port);
  port.messages.length = 0;
  port.send({ type: 'write-start', leafName: 'reviewed.ai', expectedLength: '14' });
  const opened = port.messages.shift();
  port.send({ type: 'ownership-ack', outputIdentity: opened.outputIdentity });
  assert.deepEqual(port.messages.shift(), { type: 'ready' });
  fs.renameSync('reviewed.ai', 'renamed.ai');
  fs.writeFileSync('sentinel.txt', 'unrelated sentinel');

  port.send({ type: 'chunk', sequence: 0, data: Buffer.from('private bytes!') });

  assert.deepEqual(port.messages, [{ type: 'failed' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(exits, [72]);
  assert.deepEqual(fs.readdirSync(directory), ['sentinel.txt']);
  assert.equal(fs.readFileSync('sentinel.txt', 'utf8'), 'unrelated sentinel');
});

test('utility worker truncates an outside hard link inserted after the first chunk', async t => {
  const directory = withTemporaryWorkingDirectory(t);
  const outsideDirectory = path.join(directory, 'outside');
  fs.mkdirSync(outsideDirectory);
  fs.writeFileSync(path.join(outsideDirectory, 'sentinel.txt'), 'unrelated sentinel');
  const { port, exits } = startTestWorker();
  initializeSession(port);
  port.messages.length = 0;
  port.send({ type: 'write-start', leafName: 'reviewed.ai', expectedLength: '25' });
  const opened = port.messages.shift();
  port.send({ type: 'ownership-ack', outputIdentity: opened.outputIdentity });
  assert.deepEqual(port.messages.shift(), { type: 'ready' });
  port.send({ type: 'chunk', sequence: 0, data: Buffer.from('first private') });
  assert.deepEqual(port.messages.shift(), { type: 'ack', sequence: 0 });
  const outsideLink = path.join(outsideDirectory, 'captured.ai');
  fs.linkSync('reviewed.ai', outsideLink);

  port.send({ type: 'chunk', sequence: 1, data: Buffer.from('second bytes') });

  assert.deepEqual(port.messages, [{ type: 'failed' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(exits, [72]);
  assert.equal(fs.existsSync('reviewed.ai'), false);
  assert.equal(fs.readFileSync(outsideLink).length, 0);
  assert.equal(fs.readFileSync(path.join(outsideDirectory, 'sentinel.txt'), 'utf8'), 'unrelated sentinel');
});

test('utility worker keeps its cwd inode pinned after an allowed directory move', async t => {
  const directory = withTemporaryWorkingDirectory(t);
  const originalParent = path.join(directory, 'original');
  const finalParent = path.join(directory, 'final', 'nested');
  const originalGroup = path.join(originalParent, 'group');
  const finalGroup = path.join(finalParent, 'group');
  fs.mkdirSync(originalGroup, { recursive: true });
  fs.mkdirSync(finalParent, { recursive: true });
  const groupStat = fs.statSync(originalGroup, { bigint: true });
  const identity = { dev: `${groupStat.dev}`, ino: `${groupStat.ino}` };
  const originalAncestry = ancestryFor(originalGroup);
  const finalAncestry = [identity, ...ancestryFor(finalParent)];
  process.chdir(originalGroup);
  const { port, exits } = startTestWorker();
  initializeSession(port, { identity, ancestries: [originalAncestry, finalAncestry] });
  assert.deepEqual(port.messages.shift(), { type: 'session-ready' });

  fs.renameSync(originalGroup, finalGroup);
  const complete = writeFileThroughSession(port, 'moved.ai', [Buffer.from('pinned bytes')]);
  assert.equal(complete.type, 'complete');
  assert.equal(fs.readFileSync(path.join(finalGroup, 'moved.ai'), 'utf8'), 'pinned bytes');
  port.send({ type: 'release' });
  assert.deepEqual(port.messages.shift(), { type: 'released' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(exits, [0]);
  process.chdir(directory);
});

test('utility worker refuses a mismatched directory identity without creating output', async t => {
  const directory = withTemporaryWorkingDirectory(t);
  const identity = currentIdentity();
  const { port, exits } = startTestWorker();
  initializeSession(port, { identity: { ...identity, ino: `${BigInt(identity.ino) + 1n}` } });

  assert.deepEqual(port.messages, [{ type: 'failed' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(exits, [72]);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('utility worker cleanup removes only children of the pinned directory', async t => {
  const directory = withTemporaryWorkingDirectory(t);
  fs.mkdirSync(path.join(directory, 'AI'));
  fs.writeFileSync(path.join(directory, 'AI', 'working.ai'), 'bytes');
  fs.writeFileSync(path.join(directory, 'preview.png'), 'bytes');
  const { port, exits } = startTestWorker();
  initializeSession(port);
  port.messages.length = 0;
  port.send({ type: 'cleanup' });

  assert.deepEqual(port.messages, [{ type: 'complete', bytesWritten: '0' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(exits, [0]);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('utility worker rejects a moved-directory alias before starting a session', async t => {
  const directory = withTemporaryWorkingDirectory(t);
  const originalParent = path.join(directory, 'original');
  const outsideParent = path.join(directory, 'outside');
  const originalGroup = path.join(originalParent, 'group');
  const movedGroup = path.join(outsideParent, 'group');
  fs.mkdirSync(originalGroup, { recursive: true });
  fs.mkdirSync(outsideParent);
  const groupStat = fs.statSync(originalGroup, { bigint: true });
  const identity = { dev: `${groupStat.dev}`, ino: `${groupStat.ino}` };
  const ancestry = ancestryFor(originalGroup);
  fs.renameSync(originalGroup, movedGroup);
  fs.symlinkSync(movedGroup, originalGroup, 'dir');
  fs.writeFileSync(path.join(movedGroup, 'sentinel.txt'), 'outside sentinel');
  process.chdir(originalGroup);

  const { port, exits } = startTestWorker();
  initializeSession(port, { identity, ancestries: [ancestry] });

  assert.deepEqual(port.messages, [{ type: 'failed' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(exits, [72]);
  assert.deepEqual(fs.readdirSync(movedGroup), ['sentinel.txt']);
});

test('utility worker removes exact prior outputs from a moved group and preserves unrelated files', async t => {
  const directory = withTemporaryWorkingDirectory(t);
  const originalParent = path.join(directory, 'original');
  const outsideParent = path.join(directory, 'outside');
  const originalGroup = path.join(originalParent, 'group');
  const movedGroup = path.join(outsideParent, 'group');
  fs.mkdirSync(originalGroup, { recursive: true });
  fs.mkdirSync(outsideParent);
  const ownedPath = path.join(originalGroup, 'First.ai');
  fs.writeFileSync(ownedPath, 'first private bytes', { mode: 0o600 });
  const groupStat = fs.statSync(originalGroup, { bigint: true });
  const ownedStat = fs.statSync(ownedPath, { bigint: true });
  const identity = { dev: `${groupStat.dev}`, ino: `${groupStat.ino}` };
  const ancestry = ancestryFor(originalGroup);
  fs.renameSync(originalGroup, movedGroup);
  fs.symlinkSync(movedGroup, originalGroup, 'dir');
  fs.writeFileSync(path.join(movedGroup, 'sentinel.txt'), 'outside sentinel');
  process.chdir(originalGroup);

  const { port, exits } = startTestWorker();
  initializeSession(port, {
    identity,
    ancestries: [ancestry],
    ownedOutputs: [{
      leafName: 'First.ai',
      identity: { dev: `${ownedStat.dev}`, ino: `${ownedStat.ino}` },
    }],
  });

  assert.deepEqual(port.messages, [{ type: 'failed' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(exits, [72]);
  assert.deepEqual(fs.readdirSync(movedGroup), ['sentinel.txt']);
});

for (const ownershipCount of [10_000, 10_001]) {
  test(`utility worker retains recovery cleanup ownership across ${ownershipCount} records`, async t => {
    const directory = withTemporaryWorkingDirectory(t);
    const ownedPath = path.join(directory, 'First.ai');
    fs.writeFileSync(ownedPath, 'first private bytes', { mode: 0o600 });
    fs.writeFileSync(path.join(directory, 'sentinel.txt'), 'unrelated sentinel');
    const ownedStat = fs.statSync(ownedPath, { bigint: true });
    const ownedOutputs = Array.from({ length: ownershipCount }, (_, index) => ({
      leafName: index === 0 ? 'First.ai' : `Missing-${index}.ai`,
      identity: index === 0
        ? { dev: `${ownedStat.dev}`, ino: `${ownedStat.ino}` }
        : { dev: '1', ino: `${index + 1}` },
    }));
    const { port, exits } = startTestWorker();
    initializeSession(port, { ownedOutputs });
    port.messages.length = 0;
    port.send({ type: 'write-start', leafName: 'Second.ai', expectedLength: 'invalid' });

    assert.deepEqual(port.messages, [{ type: 'failed' }]);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(exits, [72]);
    assert.deepEqual(fs.readdirSync(directory), ['sentinel.txt']);
  });
}

for (const order of ['wrong-first', 'correct-first']) {
  test(`utility worker rejects conflicting ownership identities in ${order} order without mutation`, async t => {
    const directory = withTemporaryWorkingDirectory(t);
    const ownedPath = path.join(directory, 'Reviewed.ai');
    fs.writeFileSync(ownedPath, 'private bytes', { mode: 0o600 });
    fs.writeFileSync(path.join(directory, 'sentinel.txt'), 'unrelated sentinel');
    const stat = fs.statSync(ownedPath, { bigint: true });
    const correct = { leafName: 'Reviewed.ai', identity: { dev: `${stat.dev}`, ino: `${stat.ino}` } };
    const wrong = { leafName: 'Reviewed.ai', identity: { dev: `${stat.dev}`, ino: `${stat.ino + 1n}` } };
    const { port, exits } = startTestWorker();
    initializeSession(port, { ownedOutputs: order === 'wrong-first' ? [wrong, correct] : [correct, wrong] });

    assert.deepEqual(port.messages, [{ type: 'failed' }]);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(exits, [72]);
    assert.deepEqual(fs.readdirSync(directory).sort(), ['Reviewed.ai', 'sentinel.txt']);
    assert.equal(fs.readFileSync(ownedPath, 'utf8'), 'private bytes');
    assert.equal(fs.readFileSync(path.join(directory, 'sentinel.txt'), 'utf8'), 'unrelated sentinel');
  });
}

test('utility worker does not guess when a conflicting recovery leaf was replaced', async t => {
  const directory = withTemporaryWorkingDirectory(t);
  const privatePath = path.join(directory, 'Reviewed.ai');
  const renamedPrivatePath = path.join(directory, 'Renamed.ai');
  fs.writeFileSync(privatePath, 'private bytes', { mode: 0o600 });
  const privateStat = fs.statSync(privatePath, { bigint: true });
  fs.renameSync(privatePath, renamedPrivatePath);
  fs.writeFileSync(privatePath, 'unrelated replacement', { mode: 0o600 });
  const replacementStat = fs.statSync(privatePath, { bigint: true });
  const { port, exits } = startTestWorker();

  initializeSession(port, { ownedOutputs: [
    {
      leafName: 'Reviewed.ai',
      identity: { dev: `${privateStat.dev}`, ino: `${privateStat.ino}` },
    },
    {
      leafName: 'Reviewed.ai',
      identity: { dev: `${replacementStat.dev}`, ino: `${replacementStat.ino}` },
    },
  ] });

  assert.deepEqual(port.messages, [{ type: 'failed' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(exits, [72]);
  assert.equal(fs.readFileSync(renamedPrivatePath, 'utf8'), 'private bytes');
  assert.equal(fs.readFileSync(privatePath, 'utf8'), 'unrelated replacement');
});
