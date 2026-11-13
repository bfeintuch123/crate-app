'use strict';
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
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

async function rejectionOf(run) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return null;
}

const firstFrame = error => error.stack.split('\n').find(line => line.trimStart().startsWith('at '));

// Operands a little over the render budget: bounded-assert must summarize them.
// They differ in one place wherever that is enough for the test, so that Node's
// own diff of them stays small, and these tests stay harmless, even if the
// summary path is ever lost. The exception is the one real synthetic-DOM
// failure, which runs in a child under the memory guard.
const overBudget = assert.RENDER_BUDGET;
// `overBudget` bytes, all 1 except the first.
const bytes = (first = 1) => { const buffer = Buffer.alloc(overBudget, 1); buffer[0] = first; return buffer; };

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

test('across a pool of ordinary values, every comparison agrees with node:assert/strict, message for message', () => {
  class Point { constructor() { this.x = 1; this.y = 2; } }
  const cyclic = { name: 'cyclic' };
  cyclic.self = cyclic;
  const pool = [
    undefined, null, true, false, 0, -0, NaN, 1, 1n, '', 'a', 'two\nlines', Symbol.for('shared'),
    [], [1, 2], [1, [2, 3]], [undefined], {}, { a: 1 }, { a: 1, b: { c: [1] } }, { a: undefined }, Object.create(null),
    new Map([[1, 'a']]), new Map([[1, 'b']]), new Set([1]), new Set([[1]]), new Date(0), new Date(1), /re/g, /re/i,
    new Uint8Array([1, 2]), Buffer.from([1, 2]), new Float64Array([NaN]), new Point(), new Number(1), new String('a'),
    cyclic, function named() {}, new Error('one'), new TypeError('one'), Object.assign(new Error('one'), { code: 'E_ONE' }),
  ];
  let compared = 0;
  let failures = 0;
  for (const [left, actual] of pool.entries()) {
    for (const [right, expected] of pool.entries()) {
      for (const method of ['equal', 'notEqual', 'deepEqual', 'notDeepEqual']) {
        // Every seventh comparison is made with a message of the caller's own.
        const message = compared % 7 === 0 ? `pool ${left} against ${right}` : undefined;
        const label = `${method}(pool[${left}], pool[${right}])`;
        const bounded = failureOf(() => assert[method](actual, expected, message));
        const native = failureOf(() => nodeAssert[method](actual, expected, message));
        compared += 1;
        nodeAssert.equal(bounded === null, native === null, label);
        if (native === null) continue;
        failures += 1;
        for (const field of ['name', 'code', 'operator', 'generatedMessage', 'message']) {
          nodeAssert.equal(bounded[field], native[field], `${label}: ${field}`);
        }
        nodeAssert.equal(bounded instanceof nodeAssert.AssertionError, true, label);
        nodeAssert.match(firstFrame(bounded), /bounded-assert\.test\.js/, label);
      }
    }
  }
  nodeAssert.equal(compared, pool.length * pool.length * 4);
  nodeAssert.ok(failures > pool.length * pool.length, `${failures} failing comparisons checked`);
});

test('on operands too large to render, what passes and what fails is still decided as node:assert/strict decides it', () => {
  const rows = () => Array.from({ length: overBudget }, (_, index) => ({ id: index, tags: ['a', 'b'] }));
  const star = () => {
    // A document and its nodes: every node reaches the document, and through it every other node.
    const document = { nodes: [] };
    for (let index = 0; index < overBudget; index += 1) document.nodes.push({ index, ownerDocument: document });
    return document.nodes[0];
  };
  const changedRows = rows();
  changedRows[overBudget - 1].tags = ['a', 'c'];
  const changedStar = star();
  changedStar.ownerDocument.nodes[overBudget - 1].index = -1;
  const sameStar = star();
  const pairs = [
    [rows(), rows()], [rows(), changedRows], [star(), star()], [star(), changedStar], [sameStar, sameStar],
    [Buffer.alloc(overBudget, 1), Buffer.alloc(overBudget, 1)], [Buffer.alloc(overBudget, 1), new Uint8Array(overBudget).fill(1)],
    ['x'.repeat(overBudget), 'x'.repeat(overBudget)], ['x'.repeat(overBudget), `${'x'.repeat(overBudget)}y`],
    [new Map(rows().map(row => [row.id, row])), new Map(rows().map(row => [row.id, row]))],
    [new Set(rows().map(row => row.id)), new Set(rows().map(row => row.id + 1))],
  ];
  for (const [index, [actual, expected]] of pairs.entries()) {
    const same = Object.is(actual, expected);
    const deep = isDeepStrictEqual(actual, expected);
    const outcomes = { equal: same, notEqual: !same, deepEqual: deep, notDeepEqual: !deep };
    for (const [method, passes] of Object.entries(outcomes)) {
      const failure = failureOf(() => assert[method](actual, expected));
      nodeAssert.equal(failure === null, passes, `pair ${index}: ${method}`);
      if (failure === null) continue;
      nodeAssert.equal(failure instanceof nodeAssert.AssertionError, true);
      nodeAssert.equal(failure.code, 'ERR_ASSERTION');
      // Summarized, or (one long string that must not equal itself) small enough for node:assert/strict's own message.
      nodeAssert.ok(failure.message.length < 3 * overBudget, `pair ${index}: ${method}: a message of ${failure.message.length} characters`);
      if (index !== 7) {
        nodeAssert.match(failure.message, /too large to diff; showing a summary/, `pair ${index}: ${method}`);
        nodeAssert.ok(failure.message.length < 1000, `pair ${index}: ${method}: a message of ${failure.message.length} characters`);
        nodeAssert.equal(failure.actual, undefined);
        nodeAssert.equal(failure.expected, undefined);
      }
    }
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
  const failures = [
    failureOf(() => assert.equal(1, 2)),
    failureOf(() => assert.deepEqual(bytes(1), bytes(2))),
    failureOf(() => assert.throws(() => {}, { code: 'E_NONE' })),
    failureOf(() => assert.throws(() => { throw new Error('thrown'); }, { message: 'expected' })),
    failureOf(() => assert.throws(() => { throw Object.assign(new Error('thrown'), { payload: bytes(1) }); }, { payload: bytes(2) })),
    failureOf(() => assert.throws(() => { throw new Error('thrown'); }, /expected/)),
    failureOf(() => assert.throws(() => {})),
    failureOf(() => assert.fail('failed on purpose')),
    failureOf(() => assert.fail()),
  ];
  for (const [index, error] of failures.entries()) {
    nodeAssert.equal(error instanceof nodeAssert.AssertionError, true, `failure ${index}`);
    nodeAssert.match(firstFrame(error), /bounded-assert\.test\.js/, `failure ${index}`);
    nodeAssert.doesNotMatch(error.stack, /bounded-assert\.js/, `failure ${index}`);
    nodeAssert.ok(error.stack.startsWith('AssertionError [ERR_ASSERTION]: '), `failure ${index}: ${error.stack.split('\n')[0]}`);
  }
  // An assertion inside the caller's own validation function keeps its own
  // place: its stack is not rebuilt from the outer call.
  let innerLine = null;
  const inner = failureOf(() => assert.throws(() => { throw new Error('thrown'); }, error => {
    innerLine = Number(/:(\d+):\d+\)?$/.exec(new Error('here').stack.split('\n')[1])[1]) + 1;
    assert.equal(error.message, 'expected');
    return true;
  }));
  nodeAssert.equal(inner.operator, 'strictEqual');
  nodeAssert.match(firstFrame(inner), new RegExp(`bounded-assert\\.test\\.js:${innerLine}:`));
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

test('what renders at most one value is node:assert/strict itself, and nothing unbounded is handed out', () => {
  for (const name of ['ok', 'match', 'doesNotMatch', 'doesNotThrow', 'doesNotReject', 'ifError', 'AssertionError']) {
    nodeAssert.equal(assert[name], nodeAssert[name], name);
  }
  nodeAssert.equal(assert.strict, assert);
  nodeAssert.equal(assert.equal, assert.strictEqual);
  nodeAssert.equal(assert.deepEqual, assert.deepStrictEqual);
  nodeAssert.equal(assert.notEqual, assert.notStrictEqual);
  nodeAssert.equal(assert.notDeepEqual, assert.notDeepStrictEqual);
  // Every function of node:assert/strict is here, bounded or its own, except the class that would hand out unbounded ones.
  nodeAssert.deepEqual(Object.keys(nodeAssert).filter(name => !(name in assert)), ['Assert']);
  for (const name of ['equal', 'strictEqual', 'notEqual', 'notStrictEqual', 'deepEqual', 'deepStrictEqual', 'notDeepEqual',
    'notDeepStrictEqual', 'throws', 'rejects', 'fail', 'partialDeepStrictEqual']) {
    nodeAssert.equal(typeof assert[name], 'function', name);
    nodeAssert.notEqual(assert[name], nodeAssert[name], `${name} is the bounded one`);
  }
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
  // Shaped like a node of the synthetic DOM, and too large to render, but
  // without that DOM's web of back-references: its size is one long list.
  const parent = { tagName: 'DIV', id: 'list' };
  const filler = Array.from({ length: overBudget }, (_, index) => index);
  const makeNode = (id, focused) => (
    { tagName: 'BUTTON', style: {}, children: filler, focused, disabled: false, parentNode: parent, click() {}, id, textContent: '' });
  const first = makeNode('include', true);
  const second = makeNode('exclude', false);
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
  const sparse = [];
  sparse.length = overBudget + 1;
  nodeAssert.match(failureOf(() => assert.equal(sparse, [])).message, /too large to diff/);
  // What a promise settled to, what an iterator has left: not visible in own properties.
  for (const hidden of [Promise.resolve(Buffer.alloc(8)), new Map([[1, 2]]).entries(), new Set([1]).values(), new WeakRef({ a: 1 })]) {
    nodeAssert.match(failureOf(() => assert.equal(hidden, {})).message, /too large to diff/);
    nodeAssert.match(failureOf(() => assert.equal({ nested: [hidden] }, {})).message, /too large to diff/);
  }
  // Too deep to walk.
  let deep = {};
  for (let depth = 0; depth < 100000; depth += 1) deep = { inner: deep };
  const tooDeep = failureOf(() => assert.equal(deep, {}));
  nodeAssert.ok(tooDeep instanceof nodeAssert.AssertionError);
  nodeAssert.match(tooDeep.message, /too large to diff/);
});

test('a Proxy is never called into while a failure is being described', () => {
  const calls = [];
  const trap = name => (...args) => { calls.push(name); return Reflect[name](...args); };
  const watched = new Proxy({ a: 1 }, Object.fromEntries(['get', 'has', 'ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf'].map(name => [name, trap(name)])));
  const quiet = failureOf(() => assert.equal(watched, {}, 'not the same object'));
  nodeAssert.equal(quiet.message, [
    'not the same object', '',
    'Expected "actual" to be reference-equal to "expected" (too large to diff; showing a summary):',
    '+ actual:   [Proxy]', '- expected: Object {  }', '',
  ].join('\n'));
  nodeAssert.deepEqual(calls, []);
  nodeAssert.match(failureOf(() => assert.notEqual(watched, watched)).message, /\[Proxy\]/);
  nodeAssert.match(failureOf(() => assert.equal({ inside: watched }, {})).message, /too large to diff/);
  nodeAssert.deepEqual(calls, []);

  // One whose every trap throws still produces an assertion failure, not its own error.
  const refuse = () => { throw new Error('this trap must not be called'); };
  const hostile = new Proxy(function target() {}, new Proxy({}, { get: () => refuse }));
  for (const failure of [failureOf(() => assert.equal(hostile, {})), failureOf(() => assert.equal({}, hostile)), failureOf(() => assert.notEqual(hostile, hostile))]) {
    nodeAssert.ok(failure instanceof nodeAssert.AssertionError);
    nodeAssert.match(failure.message, /\[Proxy\]/);
  }
});

test('the search for the first difference is bounded', () => {
  // More comparisons than the search allows before the one that differs: the
  // failure is still reported, at the level the search had reached.
  const many = 60000;
  const left = Array.from({ length: many }, (_, index) => ({ id: index }));
  const right = left.map(row => ({ ...row }));
  right[many - 1].id = -1;
  const capped = failureOf(() => assert.deepEqual({ rows: left }, { rows: right }));
  nodeAssert.equal(capped.message, [
    'Expected values to be strictly deep-equal (too large to diff; showing a summary):',
    'First difference at actual.rows:',
    `+ actual.rows:   Array(${many}) { … ${many} more }`,
    `- expected.rows: Array(${many}) { … ${many} more }`,
    '',
  ].join('\n'));
  // Within the allowance the place is named exactly.
  const near = left.map(row => ({ ...row }));
  near[20000].id = -1;
  nodeAssert.match(failureOf(() => assert.deepEqual(left, near)).message, /First difference at actual\[20000\]\.id:\n\+ actual\[20000\]\.id: {3}20000\n- expected\[20000\]\.id: -1\n/);

  // The search stops at a property that is a getter, without reading it, and names the level it reached.
  const computed = Object.defineProperty({ plain: Buffer.alloc(overBudget, 1) }, 'value', { enumerable: true, get() { return 1; } });
  const failure = failureOf(() => assert.deepEqual({ holder: computed }, { holder: { plain: Buffer.alloc(overBudget, 1), value: 0 } }));
  nodeAssert.match(failure.message, /First difference at actual\.holder:\n\+ actual\.holder: {3}Object \{ … 2 more \}\n- expected\.holder: Object \{ value: 0, … 1 more \}\n$/);
});

test('throws with a validation object is decided as node:assert/strict decides it, and runs the function once', () => {
  const coded = (code, extra = {}) => Object.assign(new Error(`failed with ${code}`), { code, ...extra });
  const cases = [
    [() => { throw coded('E_ONE'); }, { code: 'E_ONE' }],
    [() => { throw coded('E_ONE'); }, { code: 'E_TWO' }],
    [() => { throw coded('E_ONE'); }, { code: 'E_ONE', message: /failed with/ }],
    [() => { throw coded('E_ONE'); }, { code: 'E_ONE', message: /something else/ }],
    [() => { throw coded('E_ONE'); }, { code: 'E_ONE', missing: true }],
    [() => { throw coded('E_ONE', { details: { rows: [1, 2] } }); }, { details: { rows: [1, 3] } }],
    [() => { throw new TypeError('wrong type'); }, new TypeError('wrong type')],
    [() => { throw new TypeError('wrong type'); }, new RangeError('wrong type')],
    [() => { throw 'a string'; }, { code: 'E_ONE' }], // eslint-disable-line no-throw-literal
    [() => { throw null; }, { code: 'E_ONE' }], // eslint-disable-line no-throw-literal
    [() => {}, { code: 'E_ONE' }],
    [() => {}, { name: 'TypeError' }],
  ];
  for (const [index, [fn, expected]] of cases.entries()) {
    for (const message of [undefined, 'with a message']) {
      let runs = 0;
      const counted = () => { runs += 1; return fn(); };
      const bounded = failureOf(() => assert.throws(counted, expected, message));
      const native = failureOf(() => nodeAssert.throws(fn, expected, message));
      const label = `case ${index}${message ? ' with a message' : ''}`;
      nodeAssert.equal(runs, 1, label);
      nodeAssert.equal(bounded === null, native === null, label);
      if (native === null) continue;
      for (const field of ['name', 'code', 'operator', 'generatedMessage', 'message']) {
        nodeAssert.equal(bounded[field], native[field], `${label}: ${field}`);
      }
    }
  }
  // Arguments node:assert/strict refuses are refused the same way.
  nodeAssert.equal(failureOf(() => assert.throws(() => { throw new Error('x'); }, {})).code, 'ERR_INVALID_ARG_VALUE');
  nodeAssert.equal(failureOf(() => assert.throws('not a function', { code: 'E_ONE' })).code, 'ERR_INVALID_ARG_TYPE');
  nodeAssert.equal(failureOf(() => assert.throws(() => { throw new Error('same'); }, 'same')).code, 'ERR_AMBIGUOUS_ARGUMENT');
});

test('throws with a validation object summarizes a mismatch that is too large to diff', () => {
  const payload = bytes;
  const carrying = extra => () => { throw Object.assign(new Error('carrying'), { code: 'E_BIG', ...extra }); };
  let runs = 0;
  const failure = failureOf(() => assert.throws(() => { runs += 1; carrying({ payload: payload(1) })(); }, { code: 'E_BIG', payload: payload(2) }));
  nodeAssert.equal(runs, 1);
  nodeAssert.equal(failure.message, [
    'Expected the error to match the validation object (too large to diff; showing a summary):',
    'First difference at actual.payload[0]:',
    '+ actual.payload[0]:   1',
    '- expected.payload[0]: 2',
    '',
  ].join('\n'));
  nodeAssert.deepEqual([failure.name, failure.code, failure.operator, failure.generatedMessage], ['AssertionError', 'ERR_ASSERTION', 'throws', true]);
  nodeAssert.equal(failure.actual, undefined);

  // Decided as node:assert/strict decides it. With a message of the caller's
  // own, node:assert/strict renders nothing, so it can be asked directly.
  const judged = [
    [carrying({ payload: payload(1) }), { payload: payload(1) }],
    [carrying({ payload: payload(1) }), { payload: payload(2) }],
    [carrying({ payload: payload(1) }), { code: 'E_BIG', payload: payload(1) }],
    [carrying({ payload: payload(1) }), { code: 'E_OTHER', payload: payload(1) }],
    [carrying({ payload: payload(1) }), { payload: payload(1), missing: 1 }],
    [carrying({ text: `${'line\n'.repeat(overBudget)}end` }), { text: /^line\nline/ }],
    [carrying({ text: `${'line\n'.repeat(overBudget)}end` }), { text: /never there/ }],
    [carrying({ text: `${'line\n'.repeat(overBudget)}end` }), { text: `${'line\n'.repeat(overBudget)}end` }],
    [() => { throw `${'line\n'.repeat(overBudget)}end`; }, { code: 'E_BIG' }], // eslint-disable-line no-throw-literal
  ];
  for (const [index, [fn, expected]] of judged.entries()) {
    const bounded = failureOf(() => assert.throws(fn, expected));
    // A thrown value that is not an object is always diffed by node:assert/strict; it never matches a validation object.
    const nativePasses = index === judged.length - 1 ? false : failureOf(() => nodeAssert.throws(fn, expected, 'judged with a message')) === null;
    nodeAssert.equal(bounded === null, nativePasses, `case ${index}`);
    if (bounded === null) continue;
    nodeAssert.ok(bounded instanceof nodeAssert.AssertionError, `case ${index}`);
    nodeAssert.equal(bounded.operator, 'throws');
    nodeAssert.ok(bounded.message.length < 1000, `case ${index}: a message of ${bounded.message.length} characters`);
  }
  nodeAssert.match(failureOf(() => assert.throws(carrying({ payload: payload(1) }), { payload: payload(1), missing: 1 })).message,
    /First difference at actual\.missing:\n\+ actual\.missing: {3}\(no such property\)\n- expected\.missing: 1\n/);
});

test('rejects with a validation object behaves as throws does, for promises and for functions', async () => {
  const coded = code => Object.assign(new Error(`failed with ${code}`), { code });
  const cases = [
    [() => Promise.reject(coded('E_ONE')), { code: 'E_ONE' }],
    [() => Promise.reject(coded('E_ONE')), { code: 'E_TWO' }],
    [() => Promise.resolve('fine'), { code: 'E_ONE' }],
    [async () => { throw coded('E_ONE'); }, { code: 'E_ONE', message: /failed with/ }],
    [() => { throw coded('E_SYNC'); }, { code: 'E_ONE' }],
    [() => 'not a promise', { code: 'E_ONE' }],
    [() => Promise.reject('a string'), { code: 'E_ONE' }], // eslint-disable-line prefer-promise-reject-errors
  ];
  for (const [index, [fn, expected]] of cases.entries()) {
    for (const asPromise of [false, true]) {
      // Handing over a promise instead of a function only makes sense when the function returns one.
      if (asPromise && (index === 4 || index === 5)) continue;
      let runs = 0;
      const counted = () => { runs += 1; return fn(); };
      const bounded = await rejectionOf(() => assert.rejects(asPromise ? counted() : counted, expected));
      const native = await rejectionOf(() => nodeAssert.rejects(asPromise ? fn() : fn, expected));
      const label = `case ${index}${asPromise ? ' as a promise' : ''}`;
      nodeAssert.equal(runs, 1, label);
      nodeAssert.equal(bounded === null, native === null, label);
      if (native === null) continue;
      for (const field of ['name', 'code', 'operator', 'message']) nodeAssert.equal(bounded[field], native[field], `${label}: ${field}`);
    }
  }
  // Anything else goes to node:assert/strict untouched.
  nodeAssert.equal(await rejectionOf(() => assert.rejects(Promise.reject(new TypeError('typed')), TypeError)), null);
  const wrongClass = await rejectionOf(() => assert.rejects(Promise.reject(new TypeError('typed')), RangeError));
  nodeAssert.equal(wrongClass.message, (await rejectionOf(() => nodeAssert.rejects(Promise.reject(new TypeError('typed')), RangeError))).message);
  nodeAssert.equal((await rejectionOf(() => assert.rejects('neither', { code: 'E_ONE' }))).code, 'ERR_INVALID_ARG_TYPE');

  // Too large to diff: summarized, decided the same way.
  const payload = bytes;
  const carrying = fill => Promise.reject(Object.assign(new Error('carrying'), { payload: payload(fill) }));
  nodeAssert.equal(await rejectionOf(() => assert.rejects(carrying(1), { payload: payload(1) })), null);
  const failure = await rejectionOf(() => assert.rejects(() => carrying(1), { payload: payload(2) }));
  nodeAssert.equal(failure.message, [
    'Expected the error to match the validation object (too large to diff; showing a summary):',
    'First difference at actual.payload[0]:',
    '+ actual.payload[0]:   1',
    '- expected.payload[0]: 2',
    '',
  ].join('\n'));
  nodeAssert.deepEqual([failure.name, failure.code, failure.operator], ['AssertionError', 'ERR_ASSERTION', 'rejects']);
});

test('fail keeps its ordinary forms, and the deprecated two-value form and partial comparison refuse to render large values', () => {
  for (const args of [[], ['failed on purpose'], [undefined], [null]]) {
    const bounded = failureOf(() => assert.fail(...args));
    const native = failureOf(() => nodeAssert.fail(...args));
    for (const field of ['name', 'code', 'operator', 'generatedMessage', 'message']) nodeAssert.equal(bounded[field], native[field], `fail(${args.join()}): ${field}`);
  }
  const own = new RangeError('thrown as given');
  nodeAssert.equal(failureOf(() => assert.fail(own)), own);

  const big = () => Buffer.alloc(overBudget, 1);
  const legacy = failureOf(() => assert.fail(big(), big()));
  nodeAssert.ok(legacy instanceof nodeAssert.AssertionError);
  nodeAssert.equal(legacy.operator, '!=');
  nodeAssert.equal(legacy.generatedMessage, true);
  nodeAssert.match(legacy.message, new RegExp(`^Buffer\\(${overBudget}\\) \\{ 1, 1, .* \\} != Buffer\\(${overBudget}\\) \\{ 1, 1, .* \\} \\(too large to diff; showing a summary\\)\n$`));
  nodeAssert.equal(failureOf(() => assert.fail(big(), big(), undefined, 'custom')).operator, 'custom');

  const partial = failureOf(() => assert.partialDeepStrictEqual({ rows: big() }, { rows: big() }));
  nodeAssert.ok(partial instanceof TypeError);
  nodeAssert.match(partial.message, /too large to compare/);
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

// What a file in tests/ may not contain, because it would bring unbounded
// rendering back. The only direct imports of node:assert are the wrapper, the
// worker body that pre-package-discovery-legacy-conf compiles into a module
// outside tests/, and this file, which compares against node:assert and quotes
// the forbidden forms as samples, and so is not searched.
const allowedImports = new Map([['bounded-assert.js', 1], ['pre-package-discovery-legacy-conf.test.js', 1]]);
const directImport = /\brequire\(\s*['"](?:node:)?assert(?:\/strict)?['"]\s*\)|\bfrom\s+['"](?:node:)?assert(?:\/strict)?['"]|\bimport\(\s*['"](?:node:)?assert(?:\/strict)?['"]\s*\)|getBuiltinModule\(\s*['"](?:node:)?assert/g;
// Other ways to an assert that renders without bound: the one node:test hangs
// on its context, an instance of the Assert class, and a hand-built AssertionError.
const otherWays = [
  [/[\w$)\]]\.assert\s*[.(]/, 'an assert reached through another object (for example t.assert)'],
  [/\bassert\s*\.\s*Assert\b/, 'assert.Assert'],
  [/\bAssertionError\s*\(/, 'a hand-built AssertionError'],
];
function unboundedUses(name, source) {
  const found = [];
  if (name === 'bounded-assert.test.js') return found;
  const imports = (source.match(directImport) || []).length;
  if (imports !== (allowedImports.get(name) || 0)) found.push(`${name}: ${imports} direct node:assert import(s)`);
  if (name !== 'bounded-assert.js') {
    for (const [pattern, what] of otherWays) if (pattern.test(source)) found.push(`${name}: ${what}`);
  }
  return found;
}

test('the import check recognizes each way back to an unbounded assert, and nothing else', () => {
  const clean = [
    "const assert = require('./bounded-assert');\nassert.equal(1, 1);\n// A sentence that ends before the next line.\n  assert.ok(true);",
    "const test = require('node:test'), assert = require('./bounded-assert'), fs = require('node:fs');",
    "assert.throws(() => run(), { code: 'E_ONE' });\nassert.partialDeepStrictEqual(a, b);\nif (error instanceof assert.AssertionError) throw error;",
  ];
  for (const source of clean) nodeAssert.deepEqual(unboundedUses('some.test.js', source), []);
  const offending = [
    ["const assert = require('node:assert/strict');", 'direct node:assert import'],
    ["const assert = require('assert');", 'direct node:assert import'],
    ["const { strict: assert } = require( \"node:assert\" );", 'direct node:assert import'],
    ["import assert from 'node:assert/strict';", 'direct node:assert import'],
    ["const assert = await import('node:assert');", 'direct node:assert import'],
    ["const assert = process.getBuiltinModule('node:assert');", 'direct node:assert import'],
    ["const assert = require('./bounded-assert');\ntest('x', t => { t.assert.equal(a, b); });", 't.assert'],
    ["const assert = require('./bounded-assert');\ntest('x', context => context.assert(a));", 't.assert'],
    ["const assert = require('./bounded-assert');\nconst loud = new assert.Assert({ diff: 'full' });", 'assert.Assert'],
    ["const assert = require('./bounded-assert');\nthrow new assert.AssertionError({ actual, expected, operator: 'strictEqual' });", 'hand-built AssertionError'],
  ];
  for (const [source, what] of offending) {
    const found = unboundedUses('some.test.js', source);
    nodeAssert.equal(found.length, 1, `${what}: ${JSON.stringify(found)}`);
    nodeAssert.match(found[0], new RegExp(what.replace('.', '\\.')));
  }
  // Each allowed direct import is allowed once, in its own file only.
  nodeAssert.deepEqual(unboundedUses('bounded-assert.js', "const nodeAssert = require('node:assert/strict');"), []);
  nodeAssert.equal(unboundedUses('bounded-assert.js', '').length, 1);
  nodeAssert.equal(unboundedUses('pre-package-discovery-legacy-conf.test.js', "require('node:assert/strict'); require('node:assert/strict');").length, 1);
});

test('every test file takes assert from tests/bounded-assert.js, and from nowhere that is unbounded', () => {
  const offenders = [];
  let testFiles = 0;
  for (const name of fs.readdirSync(__dirname).sort()) {
    if (!/\.[cm]?js$/.test(name)) continue;
    offenders.push(...unboundedUses(name, fs.readFileSync(path.join(__dirname, name), 'utf8')));
    if (/\.test\.c?js$/.test(name)) testFiles += 1;
  }
  nodeAssert.ok(testFiles > 90, `scanned ${testFiles} test files`);
  nodeAssert.deepEqual(offenders, [], 'import assert with require(\'./bounded-assert\') so a failed assertion cannot exhaust memory');
});
