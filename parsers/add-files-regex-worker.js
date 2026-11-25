'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

const MAX_PARSE_FILE_SIZE = 300 * 1024 * 1024;
const MAX_POOLED_REQUESTS = 32;
const MAX_POOLED_RETAIN_FILE_BYTES = 32 * 1024 * 1024;
const MAX_POOLED_RSS_BYTES = 256 * 1024 * 1024;
const POOLED_IDLE_TIMEOUT_MS = 30_000;
const { LINKED_ASSET_REGEX, extractLinkedAssetPaths } = require('./linked-asset-matcher');

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
  return extractLinkedAssetPaths(content, filePath);
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
  const parse = typeof options.parse === 'function' ? options.parse : parseRegex;
  const maxRequests = Number.isInteger(options.maxPooledRequests) && options.maxPooledRequests > 0
    ? options.maxPooledRequests
    : MAX_POOLED_REQUESTS;
  const maxRetainFileBytes = Number.isInteger(options.maxPooledRetainFileBytes) && options.maxPooledRetainFileBytes >= 0
    ? options.maxPooledRetainFileBytes
    : MAX_POOLED_RETAIN_FILE_BYTES;
  const maxRssBytes = Number.isInteger(options.maxPooledRssBytes) && options.maxPooledRssBytes > 0
    ? options.maxPooledRssBytes
    : MAX_POOLED_RSS_BYTES;
  const idleTimeoutMs = Number.isInteger(options.idleTimeoutMs) && options.idleTimeoutMs > 0
    ? options.idleTimeoutMs
    : POOLED_IDLE_TIMEOUT_MS;
  let finished = false;
  let busy = false;
  let requestCount = 0;
  let idleTimer = null;

  const clearIdleTimer = () => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const scheduleIdleExit = () => {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!finished && !busy) {
        finished = true;
        exit(0);
      }
    }, idleTimeoutMs);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  };

  port.on('message', event => {
    const message = event && Object.prototype.hasOwnProperty.call(event, 'data') ? event.data : event;
    if (finished || !message) return;
    if (message.type === 'shutdown') {
      if (!busy) {
        clearIdleTimer();
        finished = true;
        setImmediate(() => exit(0));
      }
      return;
    }
    if (busy || message.type !== 'parse' || typeof message.filePath !== 'string') return;
    clearIdleTimer();
    busy = true;
    const pooled = message.pooled === true;
    const requestId = message.requestId;
    try {
      const result = parse(message.filePath);
      requestCount += 1;
      const rss = typeof process.memoryUsage === 'function' ? process.memoryUsage().rss : 0;
      const fileSize = result && result.sourceIdentity && Number.isFinite(result.sourceIdentity.size)
        ? result.sourceIdentity.size
        : 0;
      const keepAlive = pooled
        && requestCount < maxRequests
        && fileSize <= maxRetainFileBytes
        && rss <= maxRssBytes;
      port.postMessage({
        type: 'result',
        ...(requestId !== undefined ? { requestId } : {}),
        result,
        ...(keepAlive ? { keepAlive: true } : {}),
      });
      busy = false;
      if (keepAlive) {
        scheduleIdleExit();
      } else {
        finished = true;
        setImmediate(() => exit(0));
      }
    } catch (error) {
      busy = false;
      finished = true;
      port.postMessage({
        type: 'error',
        ...(requestId !== undefined ? { requestId } : {}),
        error: error && typeof error.message === 'string'
          ? error.message
          : 'asset_baseline_regex_worker_failed',
      });
      setImmediate(() => exit(0));
    }
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
