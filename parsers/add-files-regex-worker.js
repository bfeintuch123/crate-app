'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

const MAX_PARSE_FILE_SIZE = 300 * 1024 * 1024;
const LINKED_ASSET_REGEX = /(?:\/Users\/|\/Volumes\/)[^\x00-\x1f\x22\x27]+?\.(jpg|jpeg|png|gif|webp|svg|pdf|eps|ai|psd|tiff|tif|afdesign|afphoto|afpub|indd|idml|sketch|fig|heic|ttf|otf|woff|woff2|mp4|mov|avi|webm)/gi;

const REGEX_SOURCE_EXTENSIONS = new Set(['.ai', '.pdf', '.xd', '.ppt', '.fig']);

function getSourceIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function assertDependableStructure(sourceBuffer, ext) {
  if (ext !== '.ai' && ext !== '.pdf') return;
  const headerText = sourceBuffer.subarray(0, Math.min(sourceBuffer.length, 1024)).toString('latin1');
  const trailerText = sourceBuffer.subarray(Math.max(0, sourceBuffer.length - 2048)).toString('latin1');
  const pdfHeaderPattern = /(?:^|[\r\n])%PDF-(?:1\.[0-7]|2\.0)(?:\r\n|\r|\n)/;
  const postscriptHeaderPattern = /(?:^|[\r\n])%!PS-Adobe-(?:2\.0|3\.0)(?:\r\n|\r|\n)/;
  const validHeader = ext === '.pdf'
    ? pdfHeaderPattern.test(headerText)
    : (pdfHeaderPattern.test(headerText) || postscriptHeaderPattern.test(headerText));
  const validTrailer = /(?:^|[\r\n])%%EOF[\t\f ]*(?:[\x00\t\f\r\n ]*)$/.test(trailerText);
  if (!validHeader || !validTrailer) throw new Error('asset_baseline_source_invalid_structure');
}

function extractLinkedAssetsFromBuffer(sourceBuffer, filePath, ext = '') {
  assertDependableStructure(sourceBuffer, ext);
  const content = sourceBuffer.toString('utf8');
  const results = [];
  let match;
  while ((match = LINKED_ASSET_REGEX.exec(content)) !== null) {
    const linkedPath = match[0];
    if (linkedPath !== filePath) results.push(linkedPath);
  }
  return results;
}

function parseRegex(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('asset_baseline_source_not_file');
  if (stat.size > MAX_PARSE_FILE_SIZE) throw new Error('asset_baseline_source_too_large');
  const sourceBuffer = fs.readFileSync(filePath);
  return {
    sourceIdentity: getSourceIdentity(stat),
    sourceDigest: crypto.createHash('sha256').update(sourceBuffer).digest('hex'),
    paths: extractLinkedAssetsFromBuffer(sourceBuffer, filePath, require('node:path').extname(filePath).toLowerCase()),
  };
}

function getParentPort() {
  if (process.parentPort) return process.parentPort;
  if (typeof process.on === 'function' && typeof process.send === 'function') {
    return {
      on(eventName, handler) {
        process.on(eventName, message => handler({ data: message }));
      },
      postMessage(message) {
        process.send(message);
      },
    };
  }
  return null;
}

function startAddFilesRegexWorker(port = getParentPort(), options = {}) {
  if (!port || typeof port.on !== 'function' || typeof port.postMessage !== 'function') {
    throw new Error('Add Files regex worker requires a parent port');
  }
  const exit = typeof options.exit === 'function' ? options.exit : code => process.exit(code);
  let finished = false;
  port.on('message', event => {
    const message = event && Object.prototype.hasOwnProperty.call(event, 'data') ? event.data : event;
    if (finished || !message || message.type !== 'parse' || typeof message.filePath !== 'string') return;
    finished = true;
    try {
      port.postMessage({ type: 'result', result: parseRegex(message.filePath) });
    } catch (error) {
      port.postMessage({
        type: 'error',
        error: error && typeof error.message === 'string'
          ? error.message
          : 'asset_baseline_regex_worker_failed',
      });
    }
    setImmediate(() => exit(0));
  });
}

if (process.parentPort || (typeof process.send === 'function' && process.argv[1] === __filename)) {
  startAddFilesRegexWorker();
}

module.exports = {
  LINKED_ASSET_REGEX,
  MAX_PARSE_FILE_SIZE,
  REGEX_SOURCE_EXTENSIONS,
  extractLinkedAssetsFromBuffer,
  getParentPort,
  getSourceIdentity,
  parseRegex,
  startAddFilesRegexWorker,
};
