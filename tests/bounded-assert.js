'use strict';
// Drop-in replacement for `node:assert/strict` whose failures are always
// rendered in bounded time and memory. Every test file imports assert from
// here (tests/bounded-assert.test.js enforces that).
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
// This covers equal, notEqual, deepEqual and notDeepEqual with their strict
// aliases, which is every comparison these tests make. Everything else,
// including partialDeepStrictEqual, is node:assert/strict's own function.

const nodeAssert = require('node:assert/strict');
const { inspect, isDeepStrictEqual, types } = require('node:util');

const { AssertionError } = nodeAssert;

// Combined size of both operands, in rendered lines (or characters, for two
// strings), above which Node's diff is skipped. The diff's worst case is about
// 8 * size^2 bytes, so this bounds it at 128 MB.
const RENDER_BUDGET = 4000;
const SUMMARY_PROPERTIES = 10;
const DIFFERENCE_DEPTH = 64;

function isPrimitive(value) {
  return value === null || (typeof value !== 'object' && typeof value !== 'function');
}

function countNewlines(text) {
  let count = 0;
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) count += 1;
  return count;
}

// Lines Node's failure message would spend on `value`, counted the way its
// inspect() call walks: every enumerable own property on its own line, and a
// shared object expanded again on every path that reaches it. Stops counting
// once `limit` is passed, so the cost is bounded by the limit, not the value.
function countRenderLines(value, limit) {
  let lines = 0;
  const ancestors = new Set();
  const visit = current => {
    lines += 1;
    if (lines > limit) return;
    if (typeof current === 'string') { lines += countNewlines(current); return; }
    if (isPrimitive(current) || ancestors.has(current)) return;
    if (types.isProxy(current)) { lines = Infinity; return; }
    if (ArrayBuffer.isView(current) || Array.isArray(current)) {
      const length = current.length || 0;
      if (lines + length > limit) { lines = Infinity; return; }
      if (ArrayBuffer.isView(current)) { lines += length + 1; return; }
    }
    ancestors.add(current);
    const isError = types.isNativeError(current);
    if (isError) lines += countNewlines(String(current.stack || ''));
    if (types.isMap(current) || types.isSet(current)) {
      for (const entry of current.entries()) {
        visit(entry[0]);
        if (types.isMap(current)) visit(entry[1]);
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
  visit(value);
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
function summarize(value) {
  if (isPrimitive(value)) {
    const length = typeof value === 'string' && value.length > 120 ? `string(${value.length}) ` : '';
    return `${length}${inspect(value, { maxStringLength: 120, breakLength: Infinity })}`;
  }
  if (typeof value === 'function') return `[Function: ${value.name || '(anonymous)'}]`;
  try {
    const isList = Array.isArray(value) || (ArrayBuffer.isView(value) && typeof value.length === 'number');
    const name = (value.constructor && value.constructor.name) || 'Object';
    const keys = isList
      ? Array.from({ length: Math.min(value.length, SUMMARY_PROPERTIES + 1) }, (_, index) => index)
      : Object.keys(value);
    // Names and numbers identify a value better than its flags, so they go first.
    const identifying = [];
    const flags = [];
    let total = isList ? value.length : keys.length;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      const item = descriptor && 'value' in descriptor ? descriptor.value : undefined;
      if (item === undefined || item === null || item === '' || typeof item === 'symbol' || !isPrimitive(item)) continue;
      const text = inspect(item, { maxStringLength: 60, breakLength: Infinity });
      (isList || typeof item !== 'boolean' ? identifying : flags).push(isList ? text : `${String(key)}: ${text}`);
    }
    const shown = [...identifying, ...flags].slice(0, SUMMARY_PROPERTIES);
    total -= shown.length;
    if (total > 0) shown.push(`… ${total} more`);
    return `${name}${isList ? `(${value.length})` : ''} { ${shown.join(', ')} }`;
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function isPlainContainer(value) {
  if (isPrimitive(value) || typeof value === 'function' || types.isProxy(value)) return false;
  if (Array.isArray(value) || (ArrayBuffer.isView(value) && typeof value.length === 'number')) return true;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

function listKeys(value) {
  return Array.isArray(value) || ArrayBuffer.isView(value)
    ? Array.from({ length: value.length }, (_, index) => index)
    : Object.keys(value);
}

// Follows the first property whose values are not deeply equal, so a failed
// comparison of two large structures still names where they part ways.
function findFirstDifference(actual, expected) {
  let path = '';
  const visited = new Set();
  try {
    for (let depth = 0; depth < DIFFERENCE_DEPTH; depth += 1) {
      if (!isPlainContainer(actual) || !isPlainContainer(expected) || visited.has(actual)) break;
      if (Array.isArray(actual) !== Array.isArray(expected)) break;
      visited.add(actual);
      const keys = listKeys(actual);
      for (const key of listKeys(expected)) if (!Object.hasOwn(actual, key)) keys.push(key);
      const differing = keys.find(key => !Object.hasOwn(actual, key) || !Object.hasOwn(expected, key)
        || !isDeepStrictEqual(actual[key], expected[key]));
      if (differing === undefined) break;
      path += typeof differing === 'number' ? `[${differing}]`
        : /^[A-Za-z_$][\w$]*$/.test(differing) ? `.${differing}` : `[${JSON.stringify(differing)}]`;
      actual = Object.hasOwn(actual, differing) ? actual[differing] : undefined;
      expected = Object.hasOwn(expected, differing) ? expected[differing] : undefined;
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

const HEADLINES = {
  strictEqual: 'Expected values to be strictly equal',
  strictEqualObject: 'Expected "actual" to be reference-equal to "expected"',
  deepStrictEqual: 'Expected values to be strictly deep-equal',
  notStrictEqual: 'Expected "actual" to be strictly unequal to',
  notStrictEqualObject: 'Expected "actual" not to be reference-equal to "expected"',
  notDeepStrictEqual: 'Expected "actual" not to be strictly deep-equal to',
};

function describeFailure(actual, expected, operator) {
  const objects = !isPrimitive(actual) && !isPrimitive(expected);
  const note = '(too large to diff; showing a summary)';
  if (operator === 'notStrictEqual' || operator === 'notDeepStrictEqual') {
    const headline = HEADLINES[operator === 'notStrictEqual' && objects ? 'notStrictEqualObject' : operator];
    return [`${headline} ${note}:`, summarize(actual)];
  }
  if (typeof actual === 'string' && typeof expected === 'string') {
    return [`${HEADLINES[operator]} ${note}:`, ...describeStringDifference(actual, expected)];
  }
  if (operator === 'strictEqual') {
    const headline = HEADLINES[objects ? 'strictEqualObject' : 'strictEqual'];
    return [`${headline} ${note}:`, `+ actual:   ${summarize(actual)}`, `- expected: ${summarize(expected)}`];
  }
  const difference = findFirstDifference(actual, expected);
  return [
    `${HEADLINES[operator]} ${note}:`,
    ...(difference.path ? [`First difference at actual${difference.path}:`] : []),
    `+ actual${difference.path}:   ${summarize(difference.actual)}`,
    `- expected${difference.path}: ${summarize(difference.expected)}`,
  ];
}

function fail(actual, expected, message, operator, stackStartFn) {
  if (message instanceof Error) throw message;
  const renders = operator === 'notStrictEqual' || operator === 'notDeepStrictEqual' ? [actual] : [actual, expected];
  if (fitsRenderBudget(...renders)) {
    // Exactly what node:assert throws for this failure, message and diff included.
    throw new AssertionError({ actual, expected, message, operator, stackStartFn });
  }
  const description = describeFailure(actual, expected, operator).join('\n');
  const error = new AssertionError({
    message: message == null ? `${description}\n` : `${message}\n\n${description}\n`,
    stackStartFn,
  });
  // The operands stay off the error: reporters would render them in full.
  error.generatedMessage = message == null;
  error.operator = operator;
  throw error;
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

// A bound function adds no stack frame, so `assert(value)` keeps reporting the
// caller's own expression.
const boundedAssert = nodeAssert.ok.bind(undefined);
for (const key of Reflect.ownKeys(nodeAssert)) {
  if (key === 'length' || key === 'name' || key === 'prototype') continue;
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
  strict: boundedAssert,
});

module.exports = boundedAssert;
module.exports.RENDER_BUDGET = RENDER_BUDGET;
