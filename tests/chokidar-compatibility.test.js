'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const chokidar = require('chokidar');

// Evaluate only the watch options so compatibility follows the actual caller
// without loading Electron, user projects, or the main-process application.
function productionWatchOptions() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const match = source.match(/const watcher = chokidar\.watch\(watchPaths, (\{[\s\S]*?\})\);/);
  assert.ok(match, 'Expected the production watch configuration');
  return vm.runInThisContext(`(${match[1]})`, { filename: 'crate-watch-options' });
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, description, errors) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (errors.length) throw errors[0];
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
    await delay(10);
  }
}

async function watchFixture(t, prepare = () => {}) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-chokidar-compat-'));
  const root = path.join(temporaryRoot, '[literal]{project}');
  fs.mkdirSync(root);
  prepare(root);
  const events = [];
  const errors = [];
  const watcher = chokidar.watch([root], productionWatchOptions());
  let ready = false;
  watcher.on('all', (event, filePath) => events.push({ event, filePath }));
  watcher.on('error', error => errors.push(error));
  watcher.on('ready', () => { ready = true; });
  t.after(async () => {
    await watcher.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  await waitFor(() => ready, 'watcher ready', errors);
  return { root, events, errors, watcher };
}

function hasEvent(events, event, filePath) {
  return events.some(item => item.event === event && item.filePath === filePath);
}

test('CommonJS watcher accepts literal directory names and preserves initial-file suppression and live events', { timeout: 10000 }, async t => {
  assert.equal(typeof chokidar.watch, 'function');
  const { root, events, errors } = await watchFixture(t, directory => {
    fs.writeFileSync(path.join(directory, 'already-present.ai'), 'initial');
  });
  assert.equal(events.some(item => item.event === 'add' || item.event === 'addDir'), false);

  const filePath = path.join(root, 'new-document.ai');
  fs.writeFileSync(filePath, 'new content');
  await waitFor(() => hasEvent(events, 'add', filePath), 'live add', errors);
  fs.appendFileSync(filePath, ' changed content');
  await waitFor(() => hasEvent(events, 'change', filePath), 'live change', errors);
  fs.unlinkSync(filePath);
  await waitFor(() => hasEvent(events, 'unlink', filePath), 'live unlink', errors);
});

test('production ignored regexes and depth 3 preserve the intended admission boundary', { timeout: 10000 }, async t => {
  const { root, events, errors } = await watchFixture(t, directory => {
    fs.mkdirSync(path.join(directory, 'one', 'two', 'three', 'four'), { recursive: true });
    fs.mkdirSync(path.join(directory, 'node_modules'));
  });
  const ignored = [
    path.join(root, '.hidden.ai'),
    path.join(root, '.DS_Store'),
    path.join(root, 'node_modules', 'dependency.ai'),
    path.join(root, 'one', 'two', 'three', 'four', 'too-deep.ai'),
  ];
  for (const filePath of ignored) fs.writeFileSync(filePath, 'ignored');
  const admitted = path.join(root, 'one', 'two', 'three', 'at-depth-three.ai');
  fs.writeFileSync(admitted, 'admitted');
  await waitFor(() => hasEvent(events, 'add', admitted), 'depth-three add', errors);
  await delay(250);
  assert.deepEqual(events.filter(item => ignored.includes(item.filePath)), []);
  assert.deepEqual(errors, []);
});

test('atomic save replacement emits change without unlink/add churn', { timeout: 10000 }, async t => {
  const { root, events, errors } = await watchFixture(t, directory => {
    fs.writeFileSync(path.join(directory, 'saved.psd'), 'old document');
  });
  const saved = path.join(root, 'saved.psd');
  const temporary = path.join(root, '.replacement.psd');
  fs.writeFileSync(temporary, 'replacement document bytes');
  fs.unlinkSync(saved);
  fs.renameSync(temporary, saved);
  await waitFor(() => hasEvent(events, 'change', saved), 'atomic replacement change', errors);
  await delay(250);
  assert.equal(hasEvent(events, 'unlink', saved), false);
  assert.equal(hasEvent(events, 'add', saved), false);
  assert.equal(events.some(item => item.filePath === temporary), false);
  assert.deepEqual(errors, []);
});

test('awaited close releases watched directories and stops subsequent events', { timeout: 10000 }, async t => {
  const { root, events, errors, watcher } = await watchFixture(t);
  const beforeClose = path.join(root, 'before-close.ai');
  fs.writeFileSync(beforeClose, 'before');
  await waitFor(() => hasEvent(events, 'add', beforeClose), 'pre-close add', errors);
  const closing = watcher.close();
  assert.equal(typeof closing.then, 'function');
  await closing;
  const eventCount = events.length;
  assert.deepEqual(watcher.getWatched(), {});
  fs.writeFileSync(path.join(root, 'after-close.ai'), 'after');
  await delay(250);
  assert.equal(events.length, eventCount);
  assert.deepEqual(errors, []);
});
