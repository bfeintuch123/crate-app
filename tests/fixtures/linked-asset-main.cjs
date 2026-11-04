'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function mainExtractor(root, options = {}) {
  const file = path.join(root, 'main.js');
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf('async function extractLinkedAssetsRegex(');
  const end = source.indexOf('\n/**', start);
  assert.ok(start >= 0 && end > start);
  // Evaluate the real import and unmodified function body, not a matcher stub.
  const importLine = source.split('\n').find(line => line.includes("require('./parsers/linked-asset-matcher')"));
  const context = vm.createContext({
    fs: options.fs || fs, Buffer, MAX_PARSE_FILE_SIZE: 300 * 1024 * 1024,
    path, console: { warn() {} }, require: createRequire(file),
    runAddFilesRegexWorker: options.worker || (() => { throw new Error('unexpected-worker-call'); }),
  });
  vm.runInContext((importLine || '') + '\n' + source.slice(start, end), context, { filename: file });
  return context.extractLinkedAssetsRegex;
}

module.exports = { mainExtractor };
