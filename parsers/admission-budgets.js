'use strict';

const fs = require('fs');
const zlib = require('zlib');

const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;

const ADMISSION_LIMITS = Object.freeze({
  localParserFileBytes: 256 * MEBIBYTE,
  premiereCompressedBytes: 128 * MEBIBYTE,
  archiveFileBytes: 2 * GIBIBYTE,
  archiveEntries: 100000,
  archiveUncompressedBytes: 20 * GIBIBYTE,
  archiveListingBufferBytes: 8 * MEBIBYTE,
  presentationMediaEntries: 5000,
  presentationMediaEntryBytes: 100 * MEBIBYTE,
  presentationMediaBytes: 2 * GIBIBYTE,
  idmlXmlEntries: 10000,
  idmlXmlEntryBytes: 50 * MEBIBYTE,
  idmlXmlBytes: 512 * MEBIBYTE,
  premiereDecompressedBytes: 256 * MEBIBYTE,
  parserReferences: 10000,
  parserReferenceBytes: 16 * MEBIBYTE,
  parserReferencePathBytes: 32 * 1024,
});

const referenceBudgetState = new WeakMap();

class ParserAdmissionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParserAdmissionError';
    this.code = 'CRATE_PARSER_ADMISSION_LIMIT';
  }
}

function isParserAdmissionError(error) {
  return Boolean(error && error.code === 'CRATE_PARSER_ADMISSION_LIMIT');
}

function admissionError(message) {
  return new ParserAdmissionError(message);
}

function assertFileWithinBudget(filePath, maxBytes, message) {
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.size > maxBytes) throw admissionError(message);
  return stats.size;
}

function readFileWithinBudget(filePath, maxBytes, message) {
  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
  let fd = null;

  try {
    try {
      fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    } catch (error) {
      if (error && error.code === 'ELOOP') throw admissionError(message);
      throw error;
    }

    const stats = fs.fstatSync(fd);
    if (!stats.isFile()) throw admissionError(message);

    const header = Buffer.alloc(Math.min(2, stats.size));
    if (header.length > 0) fs.readSync(fd, header, 0, header.length, 0);
    const effectiveMaxBytes = typeof maxBytes === 'function' ? maxBytes(header) : maxBytes;
    if (!Number.isSafeInteger(effectiveMaxBytes) || effectiveMaxBytes < 0 || stats.size > effectiveMaxBytes) {
      throw admissionError(message);
    }

    const buffer = Buffer.allocUnsafe(stats.size);
    let offset = 0;
    while (offset < stats.size) {
      const bytesRead = fs.readSync(fd, buffer, offset, stats.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset === stats.size ? buffer : buffer.subarray(0, offset);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function assertBufferWithinBudget(buffer, maxBytes, message) {
  if (!Buffer.isBuffer(buffer) || buffer.length > maxBytes) throw admissionError(message);
  return buffer;
}

function assertEntriesWithinBudget(entries, options = {}) {
  const {
    predicate = () => true,
    maxEntries,
    maxEntryBytes,
    maxTotalBytes,
    sizeOf = entry => entry && entry.size,
    message,
  } = options;
  let count = 0;
  let totalBytes = 0;

  for (const entry of entries) {
    if (!predicate(entry)) continue;
    const size = Number(sizeOf(entry));
    if (!Number.isSafeInteger(size) || size < 0) throw admissionError(message);

    count += 1;
    totalBytes += size;
    if (
      count > maxEntries
      || size > maxEntryBytes
      || !Number.isSafeInteger(totalBytes)
      || totalBytes > maxTotalBytes
    ) {
      throw admissionError(message);
    }
  }

  return { count, totalBytes };
}

function appendReferenceWithinBudget(references, reference, options = {}) {
  const {
    maxReferences = ADMISSION_LIMITS.parserReferences,
    maxReferenceBytes = ADMISSION_LIMITS.parserReferenceBytes,
    maxReferencePathBytes = ADMISSION_LIMITS.parserReferencePathBytes,
    message = 'This design file contains too many file references for Crate to inspect safely.',
  } = options;
  if (!Array.isArray(references)) throw admissionError(message);

  const pathBytes = Buffer.byteLength(String(reference && reference.path || ''), 'utf8')
    + Buffer.byteLength(String(reference && reference.zipPath || ''), 'utf8');
  const previous = referenceBudgetState.get(references) || { count: 0, totalBytes: 0 };
  const count = previous.count + 1;
  const totalBytes = previous.totalBytes + pathBytes;

  if (
    pathBytes > maxReferencePathBytes
    || count > maxReferences
    || !Number.isSafeInteger(totalBytes)
    || totalBytes > maxReferenceBytes
  ) {
    throw admissionError(message);
  }

  references.push(reference);
  referenceBudgetState.set(references, { count, totalBytes });
  return reference;
}

function parseArchiveListing(listing, options = {}) {
  const {
    maxEntries = ADMISSION_LIMITS.archiveEntries,
    maxTotalBytes = ADMISSION_LIMITS.archiveUncompressedBytes,
    message = 'This archive is too large or complex for Crate to inspect safely.',
  } = options;
  const entries = [];

  for (const line of String(listing || '').split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d{2}-\d{2}-\d{2,4})\s+(\d{2}:\d{2})\s+(.+)$/);
    if (!match) continue;

    const size = Number(match[1]);
    const archivePath = match[4].trim();
    if (!archivePath) continue;
    entries.push({ path: archivePath, size });
  }

  assertEntriesWithinBudget(entries, {
    maxEntries,
    maxEntryBytes: maxTotalBytes,
    maxTotalBytes,
    message,
  });
  return entries;
}

function decompressGzipWithinBudget(buffer, maxOutputBytes, message) {
  try {
    return zlib.gunzipSync(buffer, { maxOutputLength: maxOutputBytes });
  } catch (error) {
    if (error && error.code === 'ERR_BUFFER_TOO_LARGE') throw admissionError(message);
    throw error;
  }
}

function isChildProcessMaxBufferError(error) {
  return Boolean(error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
}

function isChildProcessTimeoutError(error) {
  return Boolean(error && (error.code === 'ETIMEDOUT' || error.killed === true));
}

function isChildProcessAdmissionError(error) {
  return isChildProcessMaxBufferError(error) || isChildProcessTimeoutError(error);
}

module.exports = {
  ADMISSION_LIMITS,
  ParserAdmissionError,
  admissionError,
  appendReferenceWithinBudget,
  assertBufferWithinBudget,
  assertEntriesWithinBudget,
  assertFileWithinBudget,
  decompressGzipWithinBudget,
  isChildProcessAdmissionError,
  isChildProcessMaxBufferError,
  isChildProcessTimeoutError,
  isParserAdmissionError,
  parseArchiveListing,
  readFileWithinBudget,
};
