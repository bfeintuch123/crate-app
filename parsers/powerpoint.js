/**
 * Crate v2.0 — PowerPoint/Keynote Parser
 *
 * Extracts embedded media from .pptx and .key presentation files.
 *
 * Both formats are ZIP archives:
 *   - .pptx (PowerPoint): Media lives in ppt/media/ folder
 *   - .key (Keynote): Media lives in Data/ folder
 *
 * Unlike other parsers that find LINKED assets (external files),
 * this parser extracts EMBEDDED assets (files stored inside the archive).
 * The extracted files are copies — the originals may or may not exist elsewhere.
 *
 * Ported from Crate v1.3 extractEmbeddedMedia() function (main.js:1330-1513)
 *
 * This parser:
 *   1. Lists ZIP contents using /usr/bin/unzip -l
 *   2. Filters for media files in the appropriate folder (ppt/media/ or Data/)
 *   3. Extracts each file to memory using /usr/bin/unzip -p
 *   4. Returns metadata about each embedded file
 *
 * Note: Unlike linked assets, embedded files are EXTRACTED COPIES.
 * The 'path' field contains the internal ZIP path, not a filesystem path.
 * Use the extractToDirectory() method to actually extract files.
 */

'use strict';

const { BaseParser } = require('./base');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  ADMISSION_LIMITS,
  admissionError,
  assertBufferWithinBudget,
  assertEntriesWithinBudget,
  assertFileWithinBudget,
  isChildProcessAdmissionError,
  isParserAdmissionError,
  parseArchiveListing,
} = require('./admission-budgets');
const {
  ensureSafePackageDirectory,
  removeCreatedPackageFiles,
  sanitizePackageFileName,
  writeFileIntoPackage,
} = require('./package-safety');

const execFileAsync = promisify(execFile);
const PRESENTATION_ADMISSION_MESSAGE = 'This presentation contains too much embedded media for Crate to inspect safely.';

function safeDisplayName(rawName, fallbackName) {
  return sanitizePackageFileName(path.basename(String(rawName || fallbackName || 'file')), fallbackName || 'file');
}

function formatEmbeddedMediaExtractionFailure(archivePath, zipPath) {
  const mediaName = safeDisplayName(getKeynoteArchiveEntryTail(zipPath) || zipPath, 'embedded media');
  const archiveName = safeDisplayName(archivePath, 'presentation');
  return `Could not extract embedded media ${mediaName} from ${archiveName}.`;
}

function formatEmbeddedMediaInspectionFailure(archivePath) {
  const archiveName = safeDisplayName(archivePath, 'presentation');
  return `Could not inspect embedded media in ${archiveName}.`;
}

// Media file extensions to extract
const EMBEDDED_MEDIA_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.tif', '.tiff', '.heic',
  '.svg', '.pdf', '.eps', '.mp4', '.mov', '.m4v', '.avi', '.wmv'
]);

const KEYNOTE_SAFE_WILDCARD_TAIL = /^[A-Za-z0-9][A-Za-z0-9._ ()-]*\.[A-Za-z0-9]{2,5}$/;
const KEYNOTE_SAFE_WILDCARD_CHAR = /^[A-Za-z0-9._ ()-]$/;

function stripKeynoteNumericSuffix(name) {
  return String(name || '').replace(/-\d{3,6}(\.[a-z0-9]{2,5})$/i, '$1');
}

function hasEmbeddedMediaExtension(name) {
  return EMBEDDED_MEDIA_EXTENSIONS.has(path.extname(String(name || '')).toLowerCase());
}

function isSafeKeynoteWildcardTail(candidate) {
  if (!candidate || candidate.includes('/') || candidate.includes('\\')) return false;
  if (/[\x00-\x1f\x7f*?\[\]{}]/.test(candidate)) return false;
  if (!KEYNOTE_SAFE_WILDCARD_TAIL.test(candidate)) return false;
  return hasEmbeddedMediaExtension(candidate);
}

function isUsefulKeynoteOutputTail(tail) {
  const stripped = stripKeynoteNumericSuffix(tail);
  const stem = path.basename(stripped, path.extname(stripped)).trim();
  return stem.length >= 3;
}

function getKeynoteArchiveEntryTail(zipPath) {
  if (typeof zipPath !== 'string' || !zipPath.startsWith('Data/')) return null;

  const entryName = path.basename(zipPath).trim();
  if (!entryName) return null;
  if (!hasEmbeddedMediaExtension(entryName)) return null;

  let suffixStart = entryName.length;
  while (suffixStart > 0 && KEYNOTE_SAFE_WILDCARD_CHAR.test(entryName[suffixStart - 1])) {
    suffixStart -= 1;
  }

  const candidate = entryName.slice(suffixStart).trim();
  return isSafeKeynoteWildcardTail(candidate) ? candidate : null;
}

function getKeynoteArchiveEntryOutputTail(zipPath, wildcardTail = null) {
  if (typeof zipPath !== 'string' || !zipPath.startsWith('Data/')) return null;

  const entryName = path.basename(zipPath).trim();
  if (!entryName) return wildcardTail;

  const tail = wildcardTail || getKeynoteArchiveEntryTail(zipPath);
  if (tail && isUsefulKeynoteOutputTail(tail)) return tail;

  const displayName = entryName
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/[\x00-\x1f\x7f*?\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const displayTail = safeDisplayName(displayName, tail || 'embedded media');
  if (hasEmbeddedMediaExtension(displayTail)) return displayTail;
  return tail;
}

function getUniqueKeynoteWildcardFallback(zipPath, assets) {
  const tail = getKeynoteArchiveEntryTail(zipPath);
  if (!tail) return null;

  const matches = (assets || [])
    .filter(asset => asset && typeof asset.zipPath === 'string')
    .filter(asset => asset.zipPath.startsWith('Data/'))
    .filter(asset => hasEmbeddedMediaExtension(asset.zipPath))
    .filter(asset => path.basename(asset.zipPath).trim().endsWith(tail));
  if (matches.length !== 1) return null;

  return {
    tail,
    wildcardPath: `Data/*${tail}`,
  };
}

async function extractArchiveEntryData(archivePath, zipPath, ext, assets) {
  try {
    const data = await readArchiveEntryData(archivePath, zipPath);
    return { data, outputTail: ext === '.key' ? getKeynoteArchiveEntryOutputTail(zipPath) : null };
  } catch (exactError) {
    if (ext !== '.key' || isParserAdmissionError(exactError)) throw exactError;

    const fallback = getUniqueKeynoteWildcardFallback(zipPath, assets);
    if (!fallback) throw exactError;

    const data = await readArchiveEntryData(archivePath, fallback.wildcardPath);
    return { data, outputTail: getKeynoteArchiveEntryOutputTail(zipPath, fallback.tail) || fallback.tail };
  }
}

async function readArchiveEntryData(archivePath, zipPath) {
  try {
    const { stdout: data } = await execFileAsync('/usr/bin/unzip', ['-p', archivePath, zipPath], {
      timeout: 30000,
      maxBuffer: ADMISSION_LIMITS.presentationMediaEntryBytes,
      encoding: 'buffer'
    });
    return assertBufferWithinBudget(
      data,
      ADMISSION_LIMITS.presentationMediaEntryBytes,
      PRESENTATION_ADMISSION_MESSAGE
    );
  } catch (error) {
    if (isChildProcessAdmissionError(error)) throw admissionError(PRESENTATION_ADMISSION_MESSAGE);
    throw error;
  }
}

class PowerPointParser extends BaseParser {
  /**
   * Extract embedded media metadata from a presentation file.
   *
   * Note: For PowerPoint/Keynote, 'path' is the internal ZIP path.
   * The 'exists' field is always true since the file exists in the archive.
   * Use extractToDirectory() to extract actual files.
   *
   * @param {string} filePath - Absolute path to the .pptx or .key file
   * @returns {Promise<Array<{path: string, source: string, exists: boolean, zipPath: string, size: number}>>}
   */
  async extractAssets(filePath, options = {}) {
    const ext = path.extname(filePath).toLowerCase();
    const assets = [];

    // Determine which folder to look in
    const mediaPrefix = (ext === '.pptx' || ext === '.ppt') ? 'ppt/media/' : 'Data/';
    const sourceType = (ext === '.pptx' || ext === '.ppt') ? 'pptx-embedded' : 'keynote-embedded';

    assertFileWithinBudget(
      filePath,
      ADMISSION_LIMITS.archiveFileBytes,
      PRESENTATION_ADMISSION_MESSAGE
    );

    try {
      // List the ZIP contents
      const { stdout: listing } = await execFileAsync('/usr/bin/unzip', ['-l', filePath], {
        timeout: 10000,
        maxBuffer: ADMISSION_LIMITS.archiveListingBufferBytes,
        encoding: 'utf8'
      });

      const entries = parseArchiveListing(listing, { message: PRESENTATION_ADMISSION_MESSAGE });
      for (const entry of entries) {
        const fileSize = entry.size;
        const zipPath = entry.path;

        // Skip directory entries
        if (zipPath.endsWith('/')) continue;

        // Skip macOS metadata
        if (zipPath.includes('__MACOSX')) continue;
        if (path.basename(zipPath).startsWith('.')) continue;

        // Check file extension
        const fileExt = path.extname(zipPath).toLowerCase();
        if (!EMBEDDED_MEDIA_EXTENSIONS.has(fileExt)) continue;

        // Must be in the correct media folder
        if (!zipPath.startsWith(mediaPrefix)) continue;

        // Skip tiny files (likely placeholders)
        if (fileSize < 500) continue;

        // Keynote-specific junk filtering
        if (ext === '.key') {
          const entryName = path.basename(zipPath);

          // Skip slide thumbnails (st-UUID.jpg)
          if (/^st-[0-9a-f-]+\.jpe?g$/i.test(entryName)) continue;

          // Skip theme/template assets (mt-, bg-, tx- prefixes)
          if (/^(mt|bg|tx)-[0-9a-f-]+\.jpe?g$/i.test(entryName)) continue;

          // Skip thumbnail variants (-small suffix)
          if (/-small(-\d{3,6})?\.[a-z]+$/i.test(entryName)) continue;
        }

        this.appendAsset(assets, {
          path: path.basename(zipPath),  // Filename only (internal)
          source: sourceType,
          exists: true,  // Always true — file exists in archive
          zipPath: zipPath,  // Full path within ZIP for extraction
          size: fileSize
        }, PRESENTATION_ADMISSION_MESSAGE);
      }
      assertEntriesWithinBudget(assets, {
        maxEntries: ADMISSION_LIMITS.presentationMediaEntries,
        maxEntryBytes: ADMISSION_LIMITS.presentationMediaEntryBytes,
        maxTotalBytes: ADMISSION_LIMITS.presentationMediaBytes,
        message: PRESENTATION_ADMISSION_MESSAGE,
      });
    } catch (e) {
      if (isParserAdmissionError(e)) throw e;
      if (isChildProcessAdmissionError(e)) throw admissionError(PRESENTATION_ADMISSION_MESSAGE);
      const message = formatEmbeddedMediaInspectionFailure(filePath);
      console.error(`[PowerPointParser] ${message}`);
      if (typeof options.onInspectionError === 'function') {
        try {
          options.onInspectionError({
            archivePath: filePath,
            message,
            source: sourceType
          });
        } catch (callbackError) {
          console.warn('[PowerPointParser] Embedded inspection error callback skipped');
        }
      }
    }

    return this.deduplicateAssets(assets);
  }

  /**
   * Extract embedded media files to a directory.
   *
   * This is an ADDITIONAL method beyond the base interface.
   * Call this after extractAssets() to actually extract the files.
   *
   * @param {string} archivePath - Path to the .pptx or .key file
   * @param {string} destDir - Directory to extract files into
   * @param {Array<{zipPath: string}>} assets - Assets from extractAssets()
   * @returns {Promise<Array<{originalZipPath: string, extractedPath: string}>>}
   */
  async extractToDirectory(archivePath, destDir, assets, options = {}) {
    const ext = path.extname(archivePath).toLowerCase();
    const baseName = path.basename(archivePath, ext);
    const extracted = [];
    const seenPowerPointMedia = new Set();
    let extractedBytes = 0;

    assertFileWithinBudget(
      archivePath,
      ADMISSION_LIMITS.archiveFileBytes,
      PRESENTATION_ADMISSION_MESSAGE
    );
    assertEntriesWithinBudget(assets, {
      predicate: asset => Boolean(asset && asset.zipPath),
      maxEntries: ADMISSION_LIMITS.presentationMediaEntries,
      maxEntryBytes: ADMISSION_LIMITS.presentationMediaEntryBytes,
      maxTotalBytes: ADMISSION_LIMITS.presentationMediaBytes,
      sizeOf: asset => Number.isSafeInteger(asset && asset.size) ? asset.size : 0,
      message: PRESENTATION_ADMISSION_MESSAGE,
    });

    const outputRoot = ensureSafePackageDirectory(destDir);

    try {
      for (const asset of assets) {
        if (!asset.zipPath) continue;

        try {
          const { data, outputTail } = await extractArchiveEntryData(archivePath, asset.zipPath, ext, assets);
          extractedBytes += data.length;
          if (extractedBytes > ADMISSION_LIMITS.presentationMediaBytes) {
            throw admissionError(PRESENTATION_ADMISSION_MESSAGE);
          }
          if (ext === '.pptx' || ext === '.ppt') {
            const hash = crypto.createHash('md5').update(data).digest('hex');
            const fingerprint = `${data.length}:${hash}`;
            if (seenPowerPointMedia.has(fingerprint)) continue;
            seenPowerPointMedia.add(fingerprint);
          }

          // Generate output filename
          let outputName = outputTail || path.basename(asset.zipPath);

          // Strip Keynote's numeric suffix (e.g., "image-9073.jpg" → "image.jpg")
          if (ext === '.key') {
            outputName = outputName.replace(/-\d{3,6}(\.[a-z]+)$/i, '$1');
          }

          // Prefix with presentation name to avoid collisions
          outputName = `${baseName} — ${outputName}`;

          const destPath = writeFileIntoPackage(outputRoot, outputName, data, {
            fallbackName: 'embedded-media'
          });
          extracted.push({
            originalZipPath: asset.zipPath,
            extractedPath: destPath
          });
        } catch (e) {
          if (isParserAdmissionError(e)) throw e;
          const message = formatEmbeddedMediaExtractionFailure(archivePath, asset.zipPath);
          console.error(`[PowerPointParser] ${message}`);
          if (typeof options.onExtractionError === 'function') {
            try {
              options.onExtractionError({
                archivePath,
                zipPath: asset.zipPath,
                asset,
                message
              });
            } catch (callbackError) {
              console.warn('[PowerPointParser] Embedded extraction error callback skipped');
            }
          }
        }
      }
    } catch (error) {
      if (isParserAdmissionError(error)) {
        removeCreatedPackageFiles(outputRoot, extracted.map(item => item.extractedPath));
      }
      throw error;
    }

    return extracted;
  }

  static get extensions() {
    return ['.pptx', '.ppt', '.key'];
  }

  static get displayName() {
    return 'PowerPoint / Keynote';
  }
}

module.exports = { PowerPointParser };
