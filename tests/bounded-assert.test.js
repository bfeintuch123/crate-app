'use strict';
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const nodeAssert = require('node:assert/strict');
const assert = require('./bounded-assert');

const root = path.resolve(__dirname, '..');

function failureOf(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

// Operands a little over the render budget: bounded-assert must summarize them,
// yet Node's own diff of them would still be cheap, so these tests stay
// harmless even if the summary path is ever lost.
const overBudget = assert.RENDER_BUDGET;

test('a passing assertion passes and a failing one fails, exactly as in node:assert/strict', () => {
  const node = { tagName: 'BUTTON' };
  const cyclic = { name: 'a' };
  cyclic.self = cyclic;
  const otherCyclic = { name: 'a' };
  otherCyclic.self = otherCyclic;
  const outcomes = [
    ['equal', 1, 1, true], ['equal', 1, '1', false], ['equal', NaN, NaN, true], ['equal', 0, -0, false],
    ['equal', node, node, true], ['equal', node, { tagName: 'BUTTON' }, false],
    ['strictEqual', 'a', 'a', true], ['strictEqual', null, undefined, false],
    ['notEqual', node, { tagName: 'BUTTON' }, true], ['notEqual', node, node, false],
    ['notStrictEqual', 1, 2, true], ['notStrictEqual', NaN, NaN, false],
    ['deepEqual', { a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }, true], ['deepEqual', { a: 1 }, { a: '1' }, false],
    ['deepEqual', [1, 2, 3], [1, 2], false], ['deepEqual', cyclic, otherCyclic, true],
    ['deepStrictEqual', new Map([[1, { a: 1 }]]), new Map([[1, { a: 1 }]]), true],
    ['deepStrictEqual', new Set([1]), new Set([2]), false],
    ['notDeepEqual', { a: 1 }, { a: 2 }, true], ['notDeepEqual', { a: 1 }, { a: 1 }, false],
    ['notDeepStrictEqual', [1], [1], false],
    ['deepEqual', Buffer.alloc(overBudget, 1), Buffer.alloc(overBudget, 1), true],
    ['notDeepEqual', Buffer.alloc(overBudget, 1), Buffer.alloc(overBudget, 1), false],
  ];
  for (const [index, [method, actual, expected, passes]] of outcomes.entries()) {
    const label = `case ${index}: ${method}`;
    const bounded = failureOf(() => assert[method](actual, expected));
    const native = failureOf(() => nodeAssert[method](actual, expected));
    nodeAssert.equal(bounded === null, passes, label);
    nodeAssert.equal(native === null, passes, `${label} (node:assert/strict)`);
    if (!passes) nodeAssert.ok(bounded instanceof nodeAssert.AssertionError, label);
  }
});

test('a failure on ordinary values is the error node:assert/strict throws', () => {
  const failures = [
    ['equal', 1, 2], ['equal', 'left', 'right', 'with a message'], ['equal', { a: 1 }, { a: 1 }],
    ['equal', 'one\ntwo\nthree', 'one\n2\nthree'], ['notEqual', 7, 7], ['notEqual', 7, 7, 'with a message'],
    ['deepEqual', { a: [1, 2] }, { a: [1, 3] }], ['deepEqual', [1, 2, 3], [1, 2], 'with a message'],
    ['deepEqual', new Map([['k', 1]]), new Map([['k', 2]])], ['notDeepEqual', { a: 1 }, { a: 1 }],
    ['strictEqual', undefined, null], ['deepStrictEqual', new Error('one'), new Error('two')],
  ];
  for (const [method, actual, expected, message] of failures) {
    const bounded = failureOf(() => assert[method](actual, expected, message));
    const native = failureOf(() => nodeAssert[method](actual, expected, message));
    for (const field of ['name', 'code', 'message', 'operator', 'generatedMessage']) {
      nodeAssert.equal(bounded[field], native[field], `${method}: ${field}`);
    }
    // Node hands back the operands themselves, except that it copies two Errors.
    nodeAssert.equal(bounded.actual === actual, native.actual === actual, method);
    nodeAssert.equal(bounded.expected === expected, native.expected === expected, method);
    nodeAssert.deepEqual(bounded.actual, native.actual);
    nodeAssert.deepEqual(bounded.expected, native.expected);
  }
});

test('a failure is reported at the line that made the assertion', () => {
  const here = failureOf(() => assert.equal(1, 2));
  const large = failureOf(() => assert.deepEqual(Buffer.alloc(overBudget, 1), Buffer.alloc(overBudget, 2)));
  for (const error of [here, large]) {
    const firstFrame = error.stack.split('\n').find(line => line.trimStart().startsWith('at '));
    nodeAssert.match(firstFrame, /bounded-assert\.test\.js/);
    nodeAssert.doesNotMatch(error.stack, /bounded-assert\.js/);
  }
});

test('an Error given as the message is thrown itself, and missing operands are still a TypeError', () => {
  const custom = new RangeError('thrown as given');
  const large = Buffer.alloc(overBudget);
  for (const method of ['equal', 'notEqual', 'deepEqual', 'notDeepEqual']) {
    const equalOperands = method.startsWith('not');
    nodeAssert.equal(failureOf(() => assert[method](1, equalOperands ? 1 : 2, custom)), custom);
    nodeAssert.equal(failureOf(() => assert[method](large, equalOperands ? large : Buffer.alloc(overBudget, 1), custom)), custom);
    nodeAssert.equal(failureOf(() => assert[method](1)).code, 'ERR_MISSING_ARGS');
  }
});

test('everything else is node:assert/strict itself', () => {
  for (const name of ['ok', 'match', 'doesNotMatch', 'throws', 'doesNotThrow', 'rejects', 'doesNotReject', 'fail', 'ifError',
    'AssertionError']) {
    nodeAssert.equal(assert[name], nodeAssert[name], name);
  }
  nodeAssert.equal(assert.strict, assert);
  nodeAssert.equal(assert.equal, assert.strictEqual);
  nodeAssert.equal(assert.deepEqual, assert.deepStrictEqual);
  nodeAssert.equal(assert.notEqual, assert.notStrictEqual);
  nodeAssert.equal(assert.notDeepEqual, assert.notDeepStrictEqual);
  assert(true);
  const falsy = failureOf(() => assert(0));
  nodeAssert.ok(falsy instanceof nodeAssert.AssertionError);
  nodeAssert.match(falsy.message, /assert\(0\)/);
});

test('operands too large to diff fail with a summary of where they differ', () => {
  const actual = Buffer.alloc(overBudget, 7);
  const expected = Buffer.alloc(overBudget, 7);
  expected[overBudget - 5] = 9;
  const bytes = failureOf(() => assert.deepEqual(actual, expected));
  nodeAssert.equal(bytes.message, [
    'Expected values to be strictly deep-equal (too large to diff; showing a summary):',
    `First difference at actual[${overBudget - 5}]:`,
    `+ actual[${overBudget - 5}]:   7`,
    `- expected[${overBudget - 5}]: 9`,
    '',
  ].join('\n'));
  nodeAssert.equal(bytes.operator, 'deepStrictEqual');
  nodeAssert.equal(bytes.code, 'ERR_ASSERTION');
  nodeAssert.equal(bytes.generatedMessage, true);
  nodeAssert.equal(bytes.actual, undefined);
  nodeAssert.equal(bytes.expected, undefined);

  const rows = Array.from({ length: overBudget }, (_, index) => ({ id: index, name: `row ${index}` }));
  const changed = rows.map(row => ({ ...row }));
  changed[1234].name = 'renamed';
  delete changed[2000].id;
  const nested = failureOf(() => assert.deepEqual({ project: { files: rows } }, { project: { files: changed } }, 'files stay as saved'));
  nodeAssert.equal(nested.message, [
    'files stay as saved',
    '',
    'Expected values to be strictly deep-equal (too large to diff; showing a summary):',
    'First difference at actual.project.files[1234].name:',
    "+ actual.project.files[1234].name:   'row 1234'",
    "- expected.project.files[1234].name: 'renamed'",
    '',
  ].join('\n'));
  nodeAssert.equal(nested.generatedMessage, false);

  const missing = failureOf(() => assert.deepEqual(rows, changed.slice(0, 1234).concat(rows.slice(1234, 2000), changed.slice(2000))));
  nodeAssert.match(missing.message, /First difference at actual\[2000\]\.id:\n\+ actual\[2000\]\.id: {3}2000\n- expected\[2000\]\.id: undefined\n/);

  const text = 'x'.repeat(overBudget);
  const strings = failureOf(() => assert.equal(`${text}left${text}`, `${text}right${text}`));
  nodeAssert.match(strings.message, /^Expected values to be strictly equal \(too large to diff; showing a summary\):\n/);
  nodeAssert.match(strings.message, new RegExp(`First difference at index ${overBudget} \\(lengths ${2 * overBudget + 4} and ${2 * overBudget + 5}\\):`));
  nodeAssert.match(strings.message, /\+ actual: {3}…"x{40}leftx{76}"…\n- expected: …"x{40}rightx{75}"…\n$/);
  nodeAssert.ok(strings.message.length < 600);

  const same = failureOf(() => assert.notDeepEqual(rows, rows.map(row => ({ ...row }))));
  nodeAssert.match(same.message, new RegExp(`^Expected "actual" not to be strictly deep-equal to \\(too large to diff; showing a summary\\):\nArray\\(${overBudget}\\) \\{ … ${overBudget} more \\}\n$`));
  nodeAssert.equal(same.operator, 'notDeepStrictEqual');
});

test('a summary names an object by its own scalar properties and never by its contents', () => {
  const parent = { tagName: 'DIV', id: 'list', children: [] };
  const makeNode = (id, focused) => {
    const node = { tagName: 'BUTTON', style: {}, children: [], focused, disabled: false, parentNode: parent, click() {}, id, textContent: '' };
    parent.children.push(node);
    return node;
  };
  const first = makeNode('include', true);
  const second = makeNode('exclude', false);
  for (let index = 0; index < overBudget; index += 1) makeNode(`filler-${index}`, false);
  const identity = failureOf(() => assert.equal(first, second, 'focus moves to the next row'));
  nodeAssert.equal(identity.message, [
    'focus moves to the next row',
    '',
    'Expected "actual" to be reference-equal to "expected" (too large to diff; showing a summary):',
    "+ actual:   Object { tagName: 'BUTTON', id: 'include', focused: true, disabled: false, … 5 more }",
    "- expected: Object { tagName: 'BUTTON', id: 'exclude', focused: false, disabled: false, … 5 more }",
    '',
  ].join('\n'));
  nodeAssert.equal(identity.operator, 'strictEqual');
  const unwanted = failureOf(() => assert.notEqual(first, first));
  nodeAssert.equal(unwanted.message, [
    'Expected "actual" not to be reference-equal to "expected" (too large to diff; showing a summary):',
    "Object { tagName: 'BUTTON', id: 'include', focused: true, disabled: false, … 5 more }",
    '',
  ].join('\n'));
});

test('values whose size cannot be known cheaply are summarized rather than rendered', () => {
  let reads = 0;
  const withGetter = {};
  Object.defineProperty(withGetter, 'computed', { enumerable: true, get() { reads += 1; return 1; } });
  nodeAssert.match(failureOf(() => assert.equal(withGetter, {})).message, /too large to diff/);
  nodeAssert.equal(reads, 0);
  const proxy = new Proxy({}, {});
  nodeAssert.match(failureOf(() => assert.equal(proxy, {})).message, /too large to diff/);
  const sparse = [];
  sparse.length = overBudget + 1;
  nodeAssert.match(failureOf(() => assert.equal(sparse, [])).message, /too large to diff/);
});

test('a failed identity check between synthetic DOM nodes fails at once instead of exhausting memory', { timeout: 60000 }, () => {
  // Run under the memory guard: if this failure is ever rendered by Node's diff
  // again, the guard stops it at 512 MB and this test fails instead of the machine.
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/run-tests.js'), '--memory-limit-mb=512', '--test-reporter=tap',
    path.join(__dirname, 'fixtures/memory-guard/synthetic-dom-identity.fixture.js'),
  ], { cwd: root, encoding: 'utf8', timeout: 50000, env: environment });
  nodeAssert.equal(result.error, undefined);
  nodeAssert.equal(result.status, 1, result.stderr);
  nodeAssert.match(result.stdout, /^not ok 1 - focus is on Search$/m);
  nodeAssert.match(result.stdout, /focus stays on Search\n\s*\n\s*Expected "actual" to be reference-equal to "expected" \(too large to diff; showing a summary\):/);
  nodeAssert.match(result.stdout, /\+ actual: {3}Object \{ tagName: 'BUTTON', id: 'btn-package', focused: true, /);
  nodeAssert.match(result.stdout, /- expected: Object \{ tagName: 'INPUT', id: 'asset-review-search', focused: false, /);
  nodeAssert.match(result.stdout, /synthetic-dom-identity\.fixture\.js:\d+:\d+\)/);
  nodeAssert.doesNotMatch(result.stderr, /MEMORY LIMIT EXCEEDED/);
  const peak = /peak (\d+) MB in one process/.exec(result.stderr);
  nodeAssert.ok(peak && Number(peak[1]) < 256, result.stderr);
});

test('every test file takes assert from tests/bounded-assert.js', () => {
  // The only direct imports of node:assert are the wrapper, this file (to compare
  // against it), and the worker body that pre-package-discovery-legacy-conf
  // compiles into a module outside tests/.
  const allowed = new Map([
    ['bounded-assert.js', 1], ['bounded-assert.test.js', 1], ['pre-package-discovery-legacy-conf.test.js', 1],
  ]);
  const direct = /\brequire\(\s*['"](?:node:)?assert(?:\/strict)?['"]\s*\)|\bfrom\s+['"](?:node:)?assert(?:\/strict)?['"]/g;
  const offenders = [];
  let testFiles = 0;
  for (const name of fs.readdirSync(__dirname).sort()) {
    if (!/\.[cm]?js$/.test(name)) continue;
    const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
    const found = (source.match(direct) || []).length;
    if (found !== (allowed.get(name) || 0)) offenders.push(`${name}: ${found} direct node:assert import(s)`);
    if (/\.test\.c?js$/.test(name)) testFiles += 1;
  }
  nodeAssert.ok(testFiles > 90, `scanned ${testFiles} test files`);
  nodeAssert.deepEqual(offenders, [], 'import assert with require(\'./bounded-assert\') so a failed assertion cannot exhaust memory');
});
