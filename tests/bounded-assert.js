'use strict';
// Drop-in replacement for `node:assert/strict` whose failures are rendered in
// bounded memory. Every test file imports assert from here
// (tests/bounded-assert.test.js enforces that).
//
// Why: when equal() or deepEqual() fails, Node renders both operands with
// inspect({ depth: 1000 }) and line-diffs the two texts with a Myers
// implementation that keeps one Int32Array(2 * (N + M) + 1) snapshot per edit
// step (internal/assert/myers_diff.js). That is O((N + M) * D) memory in
// typed-array backing stores, outside the V8 heap, so no heap limit stops it.
// The synthetic DOM in these tests makes it explosive: every node reaches the
// whole document through ownerDocument, parentNode and children, one node
// renders as roughly 300,000 lines, and a single failed identity check between
// two nodes allocated about 3 GB per second until the machine swapped. Large
// Buffers and long strings hit the same path.
//
// Passing assertions are unaffected, and what passes or fails is unchanged. A
// failing assertion still gets Node's own message and diff whenever both
// operands are small enough to render. Larger operands fail with the same
// AssertionError type and a compact description of the difference instead.
//
// What is covered, which is every way node:assert renders two operands:
// - equal, notEqual, deepEqual, notDeepEqual and their strict aliases;
// - throws and rejects with a validation object, which diff the compared
//   properties of the error;
// - the deprecated fail(actual, expected), which renders both in full;
// - partialDeepStrictEqual, which has no cheap way to be decided here and so
//   refuses operands that are too large instead of comparing them.
// ok, match, doesNotMatch, ifError, doesNotThrow, doesNotReject, and throws
// and rejects with a function, class or pattern render at most one value, cut
// short by Node itself, and are node:assert/strict's own functions.
// `assert.Assert` is left out: an instance of it would be unbounded again. So
// would `t.assert` from node:test; the same test file forbids both.

const nodeAssert = require('node:assert/strict');
const { inspect, isDeepStrictEqual, types } = require('node:util');

const { AssertionError } = nodeAssert;

// Combined size of both operands, in rendered lines (or characters, for two
// strings), above which Node's diff is skipped. The diff's worst case is about
// 8 * size^2 bytes, so this bounds it at 128 MB. A long line counts once more
// for every LINE_WIDTH characters, which keeps the message itself small.
const RENDER_BUDGET = 4000;
const LINE_WIDTH = 200;
const SUMMARY_PROPERTIES = 10;
// Bounds on the search for where two large structures first differ.
const DIFFERENCE_DEPTH = 64;
const DIFFERENCE_COMPARISONS = 50000;
const DIFFERENCE_MILLISECONDS = 1000;

function isPrimitive(value) {
  return value === null || (typeof value !== 'object' && typeof value !== 'function');
}

function countNewlines(text) {
  let count = 0;
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) count += 1;
  return count;
}

// Values inspect() renders from something other than their own properties:
// what a promise settled to, what an iterator has left, what a weak reference
// points at, what a module exports. Their size cannot be told by looking.
function hasHiddenContents(value) {
  return types.isProxy(value) || types.isPromise(value) || types.isMapIterator(value) || types.isSetIterator(value)
    || types.isModuleNamespaceObject(value) || value instanceof WeakRef;
}

// Lines Node's failure message would spend on `value`, counted the way its
// inspect() call walks: every enumerable own property on its own line, and a
// shared object expanded again on every path that reaches it. Stops counting
// once `limit` is passed, so the cost is bounded by the limit, not the value.
// Infinity means "too large, or not safely measurable".
function countRenderLines(value, limit) {
  let lines = 0;
  const ancestors = new Set();
  const visit = current => {
    lines += 1;
    if (lines > limit) return;
    if (typeof current === 'string') { lines += countNewlines(current) + Math.floor(current.length / LINE_WIDTH); return; }
    if (isPrimitive(current) || ancestors.has(current)) return;
    if (hasHiddenContents(current)) { lines = Infinity; return; }
    if (ArrayBuffer.isView(current) || Array.isArray(current)) {
      const length = current.length || 0;
      if (lines + length > limit) { lines = Infinity; return; }
      if (ArrayBuffer.isView(current)) { lines += length + 1; return; }
    }
    ancestors.add(current);
    const isError = types.isNativeError(current);
    if (isError) {
      const stack = Object.getOwnPropertyDescriptor(current, 'stack');
      lines += stack && typeof stack.value === 'string' ? countNewlines(stack.value) : 50;
    }
    if (types.isMap(current) || types.isSet(current)) {
      const entries = types.isMap(current) ? Map.prototype.entries.call(current) : Set.prototype.values.call(current);
      for (const entry of entries) {
        if (types.isMap(current)) { visit(entry[0]); visit(entry[1]); } else visit(entry);
        if (lines > limit) return;
      }
    }
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor) continue;
      if (!descriptor.enumerable && !(isError && (key === 'cause' || key === 'errors'))) continue;
      // inspect() would call the getter and render whatever it returns.
      if (!('value' in descriptor)) { lines = Infinity; return; }
      visit(descriptor.value);
      if (lines > limit) return;
    }
    ancestors.delete(current);
    lines += 1;
  };
  try {
    visit(value);
  } catch {
    // A value that cannot even be walked (too deep, or hostile) is not rendered.
    return Infinity;
  }
  return lines;
}

function fitsRenderBudget(...operands) {
  // Two strings can be diffed per character instead of per line.
  if (operands.length === 2 && operands.every(operand => typeof operand === 'string')) {
    return operands[0].length + operands[1].length <= RENDER_BUDGET;
  }
  let remaining = RENDER_BUDGET;
  for (const operand of operands) {
    remaining -= countRenderLines(operand, remaining);
    if (!(remaining >= 0)) return false;
  }
  return true;
}

// One bounded line for a value of any size: its own scalar properties only.
// It reads data properties through their descriptors, so it calls no getter,
// and it does not look into a Proxy at all. It does not throw.
function summarize(value) {
  try {
    if (isPrimitive(value)) {
      const length = typeof value === 'string' && value.length > 120 ? `string(${value.length}) ` : '';
      return `${length}${inspect(value, { maxStringLength: 120, breakLength: Infinity })}`;
    }
    if (types.isProxy(value)) return '[Proxy]';
    const own = key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && 'value' in descriptor ? descriptor.value : undefined;
    };
    if (typeof value === 'function') return `[Function: ${typeof own('name') === 'string' && own('name') ? own('name') : '(anonymous)'}]`;
    const isList = Array.isArray(value) || (ArrayBuffer.isView(value) && !types.isDataView(value));
    const prototype = Object.getPrototypeOf(value);
    const constructor = prototype && Object.getOwnPropertyDescriptor(prototype, 'constructor');
    const constructorName = constructor && typeof constructor.value === 'function'
      && Object.getOwnPropertyDescriptor(constructor.value, 'name');
    const name = (constructorName && typeof constructorName.value === 'string' && constructorName.value) || 'Object';
    const length = isList ? value.length : 0;
    const keys = isList ? Array.from({ length: Math.min(length, SUMMARY_PROPERTIES + 1) }, (_, index) => index) : Object.keys(value);
    // Names and numbers identify a value better than its flags, so they go first.
    const identifying = [];
    const flags = [];
    for (const key of keys) {
      const item = isList && ArrayBuffer.isView(value) ? value[key] : own(key);
      if (item === undefined || item === null || item === '' || typeof item === 'symbol' || !isPrimitive(item)) continue;
      const text = inspect(item, { maxStringLength: 60, breakLength: Infinity });
      (isList || typeof item !== 'boolean' ? identifying : flags).push(isList ? text : `${String(key)}: ${text}`);
    }
    const shown = [...identifying, ...flags].slice(0, SUMMARY_PROPERTIES);
    const more = (isList ? length : keys.length) - shown.length;
    if (more > 0) shown.push(`… ${more} more`);
    return `${name}${isList ? `(${length})` : ''} { ${shown.join(', ')} }`;
  } catch {
    return '[a value that cannot be described]';
  }
}

function isPlainContainer(value) {
  if (isPrimitive(value) || typeof value === 'function' || types.isProxy(value)) return false;
  if (Array.isArray(value) || (ArrayBuffer.isView(value) && !types.isDataView(value))) return true;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

// The own data property `key` of a plain container, without calling a getter.
function readOwn(container, key) {
  if (ArrayBuffer.isView(container)) return key < container.length ? { value: container[key] } : null;
  const descriptor = Object.getOwnPropertyDescriptor(container, key);
  if (!descriptor) return null;
  return 'value' in descriptor ? { value: descriptor.value } : { accessor: true };
}

function listKeys(value) {
  return Array.isArray(value) || ArrayBuffer.isView(value)
    ? Array.from({ length: value.length }, (_, index) => index)
    : Object.keys(value);
}

// Follows the first property whose values are not deeply equal, so a failed
// comparison of two large structures still names where they part ways. The
// search is bounded in depth, in comparisons and in time; when a bound is hit
// it reports the place it had reached. It compares nested values the way the
// assertion itself did, and reads no getter of its own.
function findFirstDifference(actual, expected) {
  let path = '';
  const visited = new Set();
  const deadline = Date.now() + DIFFERENCE_MILLISECONDS;
  let comparisons = 0;
  const differs = (left, right) => {
    if (isPrimitive(left) && isPrimitive(right)) return !Object.is(left, right);
    comparisons += 1;
    return !isDeepStrictEqual(left, right);
  };
  try {
    for (let depth = 0; depth < DIFFERENCE_DEPTH; depth += 1) {
      if (!isPlainContainer(actual) || !isPlainContainer(expected) || visited.has(actual)) break;
      if (Array.isArray(actual) !== Array.isArray(expected) || ArrayBuffer.isView(actual) !== ArrayBuffer.isView(expected)) break;
      visited.add(actual);
      const keys = listKeys(actual);
      const known = new Set(keys);
      for (const key of listKeys(expected)) if (!known.has(key)) keys.push(key);
      let found = null;
      for (const key of keys) {
        if (comparisons >= DIFFERENCE_COMPARISONS || Date.now() > deadline) return { path, actual, expected };
        const left = readOwn(actual, key);
        const right = readOwn(expected, key);
        // A getter is not read here; the difference is reported at this level.
        if ((left && left.accessor) || (right && right.accessor)) return { path, actual, expected };
        if (!left || !right || differs(left.value, right.value)) { found = { key, left, right }; break; }
      }
      if (found === null) break;
      path += typeof found.key === 'number' ? `[${found.key}]`
        : /^[A-Za-z_$][\w$]*$/.test(found.key) ? `.${found.key}` : `[${JSON.stringify(found.key)}]`;
      actual = found.left ? found.left.value : undefined;
      expected = found.right ? found.right.value : undefined;
    }
  } catch {
    // Describe as much of the path as was reached.
  }
  return { path, actual, expected };
}

function describeStringDifference(actual, expected) {
  let index = 0;
  const shared = Math.min(actual.length, expected.length);
  while (index < shared && actual[index] === expected[index]) index += 1;
  const excerpt = text => `${index > 40 ? '…' : ''}${JSON.stringify(text.slice(Math.max(0, index - 40), index + 80))}`
    + `${text.length > index + 80 ? '…' : ''}`;
  return [
    `First difference at index ${index} (lengths ${actual.length} and ${expected.length}):`,
    `+ actual:   ${excerpt(actual)}`,
    `- expected: ${excerpt(expected)}`,
  ];
}

const NOTE = '(too large to diff; showing a summary)';
const HEADLINES = {
  strictEqual: 'Expected values to be strictly equal',
  strictEqualObject: 'Expected "actual" to be reference-equal to "expected"',
  deepStrictEqual: 'Expected values to be strictly deep-equal',
  notStrictEqual: 'Expected "actual" to be strictly unequal to',
  notStrictEqualObject: 'Expected "actual" not to be reference-equal to "expected"',
  notDeepStrictEqual: 'Expected "actual" not to be strictly deep-equal to',
};

function describeDeepDifference(headline, actual, expected) {
  const difference = findFirstDifference(actual, expected);
  return [
    `${headline} ${NOTE}:`,
    ...(difference.path ? [`First difference at actual${difference.path}:`] : []),
    `+ actual${difference.path}:   ${summarize(difference.actual)}`,
    `- expected${difference.path}: ${summarize(difference.expected)}`,
  ];
}

function describeFailure(actual, expected, operator) {
  const objects = !isPrimitive(actual) && !isPrimitive(expected);
  if (operator === 'notStrictEqual' || operator === 'notDeepStrictEqual') {
    const headline = HEADLINES[operator === 'notStrictEqual' && objects ? 'notStrictEqualObject' : operator];
    return [`${headline} ${NOTE}:`, summarize(actual)];
  }
  if (typeof actual === 'string' && typeof expected === 'string') {
    return [`${HEADLINES[operator]} ${NOTE}:`, ...describeStringDifference(actual, expected)];
  }
  if (operator === 'strictEqual') {
    const headline = HEADLINES[objects ? 'strictEqualObject' : 'strictEqual'];
    return [`${headline} ${NOTE}:`, `+ actual:   ${summarize(actual)}`, `- expected: ${summarize(expected)}`];
  }
  return describeDeepDifference(HEADLINES[operator], actual, expected);
}

// An AssertionError that carries a description instead of the operands:
// reporters would render operands left on it in full.
function summaryError(lines, message, operator, stackStartFn) {
  const description = lines.join('\n');
  const error = new AssertionError({
    message: message == null ? `${description}\n` : `${message}\n\n${description}\n`,
    stackStartFn,
  });
  error.generatedMessage = message == null;
  error.operator = operator;
  return error;
}

function fail(actual, expected, message, operator, stackStartFn) {
  if (message instanceof Error) throw message;
  const renders = operator === 'notStrictEqual' || operator === 'notDeepStrictEqual' ? [actual] : [actual, expected];
  if (fitsRenderBudget(...renders)) {
    // Exactly what node:assert throws for this failure, message and diff included.
    throw new AssertionError({ actual, expected, message, operator, stackStartFn });
  }
  throw summaryError(describeFailure(actual, expected, operator), message, operator, stackStartFn);
}

function strictEqual(actual, expected, message) {
  if (arguments.length < 2) return nodeAssert.strictEqual(...arguments);
  if (!Object.is(actual, expected)) fail(actual, expected, message, 'strictEqual', strictEqual);
  return undefined;
}

function notStrictEqual(actual, expected, message) {
  if (arguments.length < 2) return nodeAssert.notStrictEqual(...arguments);
  if (Object.is(actual, expected)) fail(actual, expected, message, 'notStrictEqual', notStrictEqual);
  return undefined;
}

function deepStrictEqual(actual, expected, message) {
  if (arguments.length < 2) return nodeAssert.deepStrictEqual(...arguments);
  if (!isDeepStrictEqual(actual, expected)) fail(actual, expected, message, 'deepStrictEqual', deepStrictEqual);
  return undefined;
}

function notDeepStrictEqual(actual, expected, message) {
  if (arguments.length < 2) return nodeAssert.notDeepStrictEqual(...arguments);
  if (isDeepStrictEqual(actual, expected)) fail(actual, expected, message, 'notDeepStrictEqual', notDeepStrictEqual);
  return undefined;
}

// A failure that node:assert raises on behalf of a function in this file has
// that function as the first frame of its stack. This rebuilds the stack from
// the caller, with the header node:assert gives it. An error that comes from
// anywhere else, such as an assertion inside the caller's own validation
// function, starts elsewhere and is passed on untouched.
function fromCaller(error, wrapper) {
  if (!(error instanceof AssertionError)) return error;
  const firstFrame = /\n\s+at [^\n]*/.exec(String(error.stack));
  if (firstFrame === null || !firstFrame[0].includes(__filename)) return error;
  const { name } = error;
  try {
    error.name = 'AssertionError [ERR_ASSERTION]';
    Error.captureStackTrace(error, wrapper);
    // Reading the stack fixes its header before the name is put back.
    if (typeof error.stack !== 'string') return error;
  } finally {
    error.name = name;
  }
  return error;
}

function passThrough(method, wrapper, args) {
  try {
    return method(...args);
  } catch (error) {
    throw fromCaller(error, wrapper);
  }
}

// throws() and rejects() with a validation object compare the named properties
// of the error and, on a mismatch, diff them (or the thrown value itself, when
// it is not an object).
function isValidationObject(expected) {
  return typeof expected === 'object' && expected !== null && !types.isRegExp(expected);
}

function validationKeys(expected) {
  const keys = Object.keys(expected);
  if (expected instanceof Error) keys.push('name', 'message');
  return keys;
}

// True when node:assert can be left to judge `thrown` against `expected`: its
// message for a mismatch will be small, or it will not render the operands.
function validationIsCheap(thrown, expected, message) {
  try {
    if (typeof thrown !== 'object' || thrown === null) return fitsRenderBudget(thrown, expected);
    if (message) return true;
    const keys = validationKeys(expected);
    const compared = { actual: {}, expected: {} };
    for (const key of keys) {
      if (key in thrown) compared.actual[key] = thrown[key];
      if (key in expected) compared.expected[key] = expected[key];
    }
    return fitsRenderBudget(compared.actual, compared.expected);
  } catch {
    // Whatever reading the error does, node:assert would do the same.
    return true;
  }
}

// node:assert's own rule for a validation object, with a summary in place of
// the diff. Returns the error to raise, or null when the validation passes.
function validate(thrown, expected, message, operator, wrapper) {
  if (typeof thrown !== 'object' || thrown === null) {
    return summaryError(describeDeepDifference(`Expected the ${operator === 'rejects' ? 'rejection' : 'thrown value'} to match the validation object`, thrown, expected),
      message, operator, wrapper);
  }
  for (const key of validationKeys(expected)) {
    if (typeof thrown[key] === 'string' && types.isRegExp(expected[key]) && RegExp.prototype.exec.call(expected[key], thrown[key]) !== null) continue;
    if (key in thrown && isDeepStrictEqual(thrown[key], expected[key])) continue;
    const named = /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
    const difference = findFirstDifference(thrown[key], expected[key]);
    return summaryError([
      `Expected the error to match the validation object ${NOTE}:`,
      `First difference at actual${named}${difference.path}:`,
      `+ actual${named}${difference.path}:   ${key in thrown ? summarize(difference.actual) : '(no such property)'}`,
      `- expected${named}${difference.path}: ${summarize(difference.expected)}`,
    ], message, operator, wrapper);
  }
  return null;
}

const NOTHING_THROWN = Symbol('nothing thrown');

function throws(fn, ...args) {
  const [expected, message] = args;
  if (typeof fn !== 'function' || !isValidationObject(expected)) return passThrough(nodeAssert.throws, throws, [fn, ...args]);
  // Run fn once, here, to see what it throws before anything renders it.
  let thrown = NOTHING_THROWN;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (thrown === NOTHING_THROWN || validationIsCheap(thrown, expected, message)) {
    const replay = () => { if (thrown !== NOTHING_THROWN) throw thrown; };
    return passThrough(nodeAssert.throws, throws, [replay, ...args]);
  }
  const failure = validate(thrown, expected, message, 'throws', throws);
  if (failure !== null) throw failure;
  return undefined;
}

function rejects(promiseFn, ...args) {
  const [expected, message] = args;
  // Only a validation object can lead to a diff. Everything else, and anything
  // that is not a plain function or a native promise, is node:assert's own.
  if (!isValidationObject(expected) || !(typeof promiseFn === 'function' || types.isPromise(promiseFn))) {
    return nodeAssert.rejects(promiseFn, ...args);
  }
  return (async () => {
    let promise = promiseFn;
    if (typeof promiseFn === 'function') {
      try {
        promise = promiseFn();
      } catch (error) {
        return nodeAssert.rejects(() => { throw error; }, ...args);
      }
      if (!types.isPromise(promise)) return nodeAssert.rejects(() => promise, ...args);
    }
    // Settle it once, here, to see what it rejects with before anything renders it.
    let thrown = NOTHING_THROWN;
    try {
      await promise;
    } catch (error) {
      thrown = error;
    }
    if (thrown === NOTHING_THROWN || validationIsCheap(thrown, expected, message)) {
      return nodeAssert.rejects(typeof promiseFn === 'function' ? () => promise : promise, ...args);
    }
    const failure = validate(thrown, expected, message, 'rejects', rejects);
    if (failure !== null) throw failure;
    return undefined;
  })();
}

// fail(actual, expected, message, operator) is deprecated and, without a
// message, renders both values in full.
function failAssertion(...args) {
  if (args.length >= 2 && args[2] === undefined && !fitsRenderBudget(args[0], args[1])) {
    const operator = args[3] === undefined ? (args.length === 2 ? '!=' : 'fail') : args[3];
    throw summaryError([`${summarize(args[0])} ${operator} ${summarize(args[1])} ${NOTE}`], undefined, operator, failAssertion);
  }
  return passThrough(nodeAssert.fail, failAssertion, args);
}

// There is no way to decide a partial comparison here without the function
// that would also render it, so operands too large to render are refused.
function partialDeepStrictEqual(...args) {
  if (args.length >= 2 && !fitsRenderBudget(args[0], args[1])) {
    throw new TypeError('assert.partialDeepStrictEqual: these operands are too large to compare without risking an '
      + 'unbounded failure message. Compare the part that matters with assert.deepEqual.');
  }
  return passThrough(nodeAssert.partialDeepStrictEqual, partialDeepStrictEqual, args);
}

// A bound function adds no stack frame, so `assert(value)` keeps reporting the
// caller's own expression.
const boundedAssert = nodeAssert.ok.bind(undefined);
for (const key of Reflect.ownKeys(nodeAssert)) {
  if (key === 'length' || key === 'name' || key === 'prototype' || key === 'Assert') continue;
  Object.defineProperty(boundedAssert, key, Object.getOwnPropertyDescriptor(nodeAssert, key));
}
Object.assign(boundedAssert, {
  equal: strictEqual,
  strictEqual,
  notEqual: notStrictEqual,
  notStrictEqual,
  deepEqual: deepStrictEqual,
  deepStrictEqual,
  notDeepEqual: notDeepStrictEqual,
  notDeepStrictEqual,
  throws,
  rejects,
  fail: failAssertion,
  strict: boundedAssert,
});
if (typeof nodeAssert.partialDeepStrictEqual === 'function') boundedAssert.partialDeepStrictEqual = partialDeepStrictEqual;

module.exports = boundedAssert;
module.exports.RENDER_BUDGET = RENDER_BUDGET;
