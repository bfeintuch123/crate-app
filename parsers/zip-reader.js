'use strict';

// Seek-based, bounded in-process ZIP reader for IDML, PPTX, and Keynote archives.
// Reads only the End-of-Central-Directory and Central Directory from an open file
// descriptor (O_NOFOLLOW) and inflates requested entries on demand with strict
// maxOutputLength and CRC-32 verification. Never loads the full archive into RAM.

const fs = require('node:fs');
const zlib = require('node:zlib');
const {
  ADMISSION_LIMITS,
  admissionError,
} = require('./admission-budgets');

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

const EOCD_MIN_BYTES = 22;
const EOCD_MAX_SEARCH_BYTES = 65557; // 22 + 65535 max comment length
const ZIP64_LOCATOR_BYTES = 20;
const ZIP64_EOCD_MIN_BYTES = 56;
const DEFAULT_MAX_CENTRAL_DIR_BYTES = 32 * 1024 * 1024;
const O_NOFOLLOW = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;

class UnsupportedZipEntryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedZipEntryError';
    this.code = 'CRATE_ZIP_UNSUPPORTED_ENTRY';
  }
}

function isUnsupportedZipEntryError(error) {
  return Boolean(error && error.code === 'CRATE_ZIP_UNSUPPORTED_ENTRY');
}

function computeCrc32(buffer) {
  if (typeof zlib.crc32 === 'function') {
    return zlib.crc32(buffer) >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readExactSync(fd, position, length) {
  if (length === 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const bytesRead = fs.readSync(fd, buffer, offset, length - offset, position + offset);
    if (bytesRead <= 0) {
      throw new Error('zip_unexpected_eof');
    }
    offset += bytesRead;
  }
  return buffer;
}

function readSafeUint64LE(buffer, offset) {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(value);
}

function parseZip64ExtraField(extra, needUncompressed, needCompressed, needOffset) {
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const headerId = extra.readUInt16LE(cursor);
    const dataSize = extra.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor + dataSize > extra.length) return null;
    if (headerId === 0x0001) {
      let fieldCursor = cursor;
      const fieldEnd = cursor + dataSize;
      const parsed = {};
      if (needUncompressed) {
        if (fieldCursor + 8 > fieldEnd) return null;
        parsed.uncompressedSize = readSafeUint64LE(extra, fieldCursor);
        if (parsed.uncompressedSize === null) return null;
        fieldCursor += 8;
      }
      if (needCompressed) {
        if (fieldCursor + 8 > fieldEnd) return null;
        parsed.compressedSize = readSafeUint64LE(extra, fieldCursor);
        if (parsed.compressedSize === null) return null;
        fieldCursor += 8;
      }
      if (needOffset) {
        if (fieldCursor + 8 > fieldEnd) return null;
        parsed.localHeaderOffset = readSafeUint64LE(extra, fieldCursor);
        if (parsed.localHeaderOffset === null) return null;
      }
      return parsed;
    }
    cursor += dataSize;
  }
  return null;
}

function locateCentralDirectory(fd, fileSize, maxEntries, maxCentralDirBytes, message) {
  if (fileSize < EOCD_MIN_BYTES) return null;

  const tailLen = Math.min(fileSize, EOCD_MAX_SEARCH_BYTES);
  const tailStart = fileSize - tailLen;
  const tail = readExactSync(fd, tailStart, tailLen);

  let eocdOffsetInTail = -1;
  for (let i = tailLen - EOCD_MIN_BYTES; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) !== EOCD_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(i + 20);
    if (i + EOCD_MIN_BYTES + commentLength === tailLen) {
      eocdOffsetInTail = i;
      break;
    }
  }
  if (eocdOffsetInTail < 0) return null;

  const eocdFileOffset = tailStart + eocdOffsetInTail;
  let diskNumber = tail.readUInt16LE(eocdOffsetInTail + 4);
  let cdDisk = tail.readUInt16LE(eocdOffsetInTail + 6);
  let diskEntries = tail.readUInt16LE(eocdOffsetInTail + 8);
  let totalEntries = tail.readUInt16LE(eocdOffsetInTail + 10);
  let cdSize = tail.readUInt32LE(eocdOffsetInTail + 12);
  let cdOffset = tail.readUInt32LE(eocdOffsetInTail + 16);

  const needsZip64 = (
    diskNumber === 0xffff
    || cdDisk === 0xffff
    || diskEntries === 0xffff
    || totalEntries === 0xffff
    || cdSize === 0xffffffff
    || cdOffset === 0xffffffff
  );

  if (needsZip64) {
    if (eocdFileOffset < ZIP64_LOCATOR_BYTES) return null;
    const locator = readExactSync(fd, eocdFileOffset - ZIP64_LOCATOR_BYTES, ZIP64_LOCATOR_BYTES);
    if (locator.readUInt32LE(0) !== ZIP64_EOCD_LOCATOR_SIGNATURE) return null;
    const zip64EocdOffset = readSafeUint64LE(locator, 8);
    const totalDisks = locator.readUInt32LE(16);
    if (
      zip64EocdOffset === null
      || totalDisks > 1
      || zip64EocdOffset + ZIP64_EOCD_MIN_BYTES > eocdFileOffset - ZIP64_LOCATOR_BYTES
    ) {
      return null;
    }
    const zip64Eocd = readExactSync(fd, zip64EocdOffset, ZIP64_EOCD_MIN_BYTES);
    if (zip64Eocd.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) return null;
    diskNumber = zip64Eocd.readUInt32LE(16);
    cdDisk = zip64Eocd.readUInt32LE(20);
    diskEntries = readSafeUint64LE(zip64Eocd, 24);
    totalEntries = readSafeUint64LE(zip64Eocd, 32);
    cdSize = readSafeUint64LE(zip64Eocd, 40);
    cdOffset = readSafeUint64LE(zip64Eocd, 48);
    if (diskEntries === null || totalEntries === null || cdSize === null || cdOffset === null) {
      throw admissionError(message);
    }
  }

  if (diskNumber !== 0 || cdDisk !== 0 || diskEntries !== totalEntries) return null;
  if (totalEntries > maxEntries || cdSize > maxCentralDirBytes) {
    throw admissionError(message);
  }
  if (cdOffset < 0 || cdSize < 0 || cdOffset + cdSize > eocdFileOffset) return null;

  return { totalEntries, cdSize, cdOffset };
}

/**
 * Open a ZIP archive for seek-based, bounded in-process listing and extraction.
 *
 * Returns `null` when the file is not a recognized ZIP container (allowing
 * callers to handle legacy non-ZIP fixtures or report an inspection failure).
 * Always throws `ParserAdmissionError` when any admission limit or symlink
 * guard is violated.
 */
function openZipArchive(filePath, options = {}) {
  const {
    maxFileBytes = ADMISSION_LIMITS.archiveFileBytes,
    maxEntries = ADMISSION_LIMITS.archiveEntries,
    maxTotalBytes = ADMISSION_LIMITS.archiveUncompressedBytes,
    maxCentralDirectoryBytes = DEFAULT_MAX_CENTRAL_DIR_BYTES,
    message = 'This archive is too large or complex for Crate to inspect safely.',
  } = options;

  let fd = null;
  let keepOpen = false;
  try {
    try {
      fd = fs.openSync(filePath, fs.constants.O_RDONLY | O_NOFOLLOW);
    } catch (error) {
      if (error && error.code === 'ELOOP') throw admissionError(message);
      throw error;
    }

    const stats = fs.fstatSync(fd);
    if (!stats.isFile() || stats.size > maxFileBytes) {
      throw admissionError(message);
    }
    const fileSize = stats.size;
    const directory = locateCentralDirectory(fd, fileSize, maxEntries, maxCentralDirectoryBytes, message);
    if (!directory) return null;

    const cdBuffer = readExactSync(fd, directory.cdOffset, directory.cdSize);
    const entries = [];
    const byPath = new Map();
    let cursor = 0;
    let totalUncompressedBytes = 0;

    for (let i = 0; i < directory.totalEntries; i += 1) {
      if (cursor + 46 > cdBuffer.length || cdBuffer.readUInt32LE(cursor) !== CENTRAL_DIR_SIGNATURE) {
        return null;
      }
      const flags = cdBuffer.readUInt16LE(cursor + 8);
      const method = cdBuffer.readUInt16LE(cursor + 10);
      const crc32 = cdBuffer.readUInt32LE(cursor + 16);
      let compressedSize = cdBuffer.readUInt32LE(cursor + 20);
      let uncompressedSize = cdBuffer.readUInt32LE(cursor + 24);
      const nameLength = cdBuffer.readUInt16LE(cursor + 28);
      const extraLength = cdBuffer.readUInt16LE(cursor + 30);
      const commentLength = cdBuffer.readUInt16LE(cursor + 32);
      let localHeaderOffset = cdBuffer.readUInt32LE(cursor + 42);

      const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
      if (recordEnd > cdBuffer.length) return null;

      const nameBytes = cdBuffer.subarray(cursor + 46, cursor + 46 + nameLength);
      const extraBytes = cdBuffer.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);

      const needUncompressed = uncompressedSize === 0xffffffff;
      const needCompressed = compressedSize === 0xffffffff;
      const needOffset = localHeaderOffset === 0xffffffff;
      if (needUncompressed || needCompressed || needOffset) {
        const zip64 = parseZip64ExtraField(extraBytes, needUncompressed, needCompressed, needOffset);
        if (!zip64) return null;
        if (needUncompressed) uncompressedSize = zip64.uncompressedSize;
        if (needCompressed) compressedSize = zip64.compressedSize;
        if (needOffset) localHeaderOffset = zip64.localHeaderOffset;
      }

      if (
        !Number.isSafeInteger(uncompressedSize)
        || uncompressedSize < 0
        || !Number.isSafeInteger(compressedSize)
        || compressedSize < 0
        || !Number.isSafeInteger(localHeaderOffset)
        || localHeaderOffset < 0
      ) {
        throw admissionError(message);
      }

      totalUncompressedBytes += uncompressedSize;
      if (
        entries.length + 1 > maxEntries
        || uncompressedSize > maxTotalBytes
        || !Number.isSafeInteger(totalUncompressedBytes)
        || totalUncompressedBytes > maxTotalBytes
      ) {
        throw admissionError(message);
      }

      const entryPath = nameBytes.toString('utf8');
      const entry = {
        path: entryPath,
        size: uncompressedSize,
        compressedSize,
        method,
        flags,
        crc32,
        localHeaderOffset,
        nameBytes: Buffer.from(nameBytes),
      };
      entries.push(entry);
      const existing = byPath.get(entryPath);
      if (existing) existing.push(entry);
      else byPath.set(entryPath, [entry]);

      cursor = recordEnd;
    }

    let closed = false;
    const handle = {
      entries,
      fileSize,
      findEntry(targetPath) {
        const matches = byPath.get(targetPath);
        return matches && matches.length > 0 ? matches[0] : null;
      },
      findEntries(targetPath) {
        return byPath.get(targetPath) || [];
      },
      readEntry(entryOrPath, readOptions = {}) {
        if (closed) throw new Error('zip_archive_closed');
        const entry = typeof entryOrPath === 'string' ? handle.findEntry(entryOrPath) : entryOrPath;
        if (!entry) {
          throw Object.assign(new Error('zip_entry_not_found'), { code: 'CRATE_ZIP_ENTRY_NOT_FOUND' });
        }
        const entryMaxBytes = readOptions.maxOutputBytes;
        const entryMessage = readOptions.message || message;
        if (Number.isSafeInteger(entryMaxBytes) && entry.size > entryMaxBytes) {
          throw admissionError(entryMessage);
        }
        if ((entry.flags & 1) !== 0) {
          throw new UnsupportedZipEntryError('zip_encrypted_entry');
        }
        if (entry.method !== 0 && entry.method !== 8) {
          throw new UnsupportedZipEntryError(`zip_unsupported_method_${entry.method}`);
        }
        if (entry.localHeaderOffset + 30 > fileSize) {
          throw new Error('zip_invalid_local_header');
        }
        const localHeader = readExactSync(fd, entry.localHeaderOffset, 30);
        if (localHeader.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE) {
          throw new Error('zip_invalid_local_header');
        }
        const localNameLength = localHeader.readUInt16LE(26);
        const localExtraLength = localHeader.readUInt16LE(28);
        const dataOffset = entry.localHeaderOffset + 30 + localNameLength + localExtraLength;
        if (dataOffset + entry.compressedSize > fileSize) {
          throw new Error('zip_truncated_entry');
        }
        if (entry.method === 0 && Number.isSafeInteger(entryMaxBytes) && entry.compressedSize > entryMaxBytes) {
          throw admissionError(entryMessage);
        }

        const compressed = readExactSync(fd, dataOffset, entry.compressedSize);
        let output;
        if (entry.method === 0) {
          output = compressed;
        } else {
          try {
            output = zlib.inflateRawSync(
              compressed,
              Number.isSafeInteger(entryMaxBytes) ? { maxOutputLength: entryMaxBytes } : undefined
            );
          } catch (error) {
            if (error && error.code === 'ERR_BUFFER_TOO_LARGE') {
              throw admissionError(entryMessage);
            }
            throw error;
          }
        }

        if (Number.isSafeInteger(entryMaxBytes) && output.length > entryMaxBytes) {
          throw admissionError(entryMessage);
        }
        if (output.length !== entry.size || computeCrc32(output) !== entry.crc32) {
          throw new Error('zip_corrupt_entry');
        }
        return output;
      },
      close() {
        if (closed) return;
        closed = true;
        try { fs.closeSync(fd); } catch (_) {}
      },
    };

    keepOpen = true;
    return handle;
  } finally {
    if (!keepOpen && fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

module.exports = {
  UnsupportedZipEntryError,
  computeCrc32,
  isUnsupportedZipEntryError,
  openZipArchive,
};
