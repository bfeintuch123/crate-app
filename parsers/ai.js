/**
 * Crate v2.0 — Adobe Illustrator Parser
 *
 * Extracts linked asset paths from .ai files by scanning for embedded path strings.
 *
 * .ai files are PDF-based (PDF 1.x format). When images are linked (not embedded),
 * their absolute paths are stored as text strings within the binary data.
 * This approach scans the raw bytes for macOS absolute paths matching known
 * image/design file extensions.
 *
 * Ported from Crate v1.3 logic (main.js:1236-1275)
 *
 * Limitations:
 * - Modern .ai files using PDF 1.6+ may compress object streams (FlateDecode),
 *   making some linked paths unreadable from raw bytes.
 * - For complete coverage when Illustrator is running, v1.3 also uses AppleScript
 *   to query the app directly. That approach is out of scope for the v2.0 parser
 *   (which focuses on file-based extraction).
 */

'use strict';

const path = require('node:path');
const { BaseParser } = require('./base');
const { nativeHelper } = require('./native-helper');

// Exact supported link extensions for Quick Package Illustrator extraction.
// Matches base Quick Package AI policy (including .psb) while deliberately
// excluding web-font (.woff2/.woff), installable-font, and video extensions so
// web-font copy policy is never broadened silently.
const QUICK_AI_SUPPORTED_EXTENSIONS = Object.freeze([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'pdf', 'eps', 'ai',
  'psd', 'psb', 'tiff', 'tif', 'afdesign', 'afphoto', 'afpub',
  'indd', 'idml', 'sketch', 'fig',
]);
const QUICK_AI_SUPPORTED_EXT_SET = new Set(QUICK_AI_SUPPORTED_EXTENSIONS.map(ext => `.${ext}`));
const QUICK_AI_LINKED_ASSET_SOURCE =
  `(?:\\/Users\\/|\\/Volumes\\/)[^\\x00-\\x1f\\x22\\x27\\x7f<>|*\\n\\r]+?\\.(${QUICK_AI_SUPPORTED_EXTENSIONS.join('|')})`;

function isSupportedQuickAiLinkedPath(candidatePath) {
  if (typeof candidatePath !== 'string' || !candidatePath) return false;
  const ext = path.extname(candidatePath).toLowerCase();
  return QUICK_AI_SUPPORTED_EXT_SET.has(ext);
}

/**
 * ReDoS-safe anchored lazy matcher for Quick Package .ai/.ait files.
 * Supports /Users/ and /Volumes/, multiple links on one line, and .psb,
 * matching the Swift helper's filtered output identically.
 */
function extractQuickAiLinkedPaths(content, filePath) {
  const prefix = /(?:\/Users\/|\/Volumes\/)/gi;
  const anchored = new RegExp(QUICK_AI_LINKED_ASSET_SOURCE, 'giy');
  const delimiter = /[\x00-\x1f\x22\x27\x7f<>|*\n\r]/g;
  const results = [];
  let candidate;
  while ((candidate = prefix.exec(content)) !== null) {
    const startIdx = candidate.index;
    // Cap scan at the earliest delimiter or subsequent /Users/ or /Volumes/ prefix
    // so an unsupported extension (e.g. .woff2) never spans into the next path.
    delimiter.lastIndex = startIdx;
    const delimMatch = delimiter.exec(content);
    const delimEnd = delimMatch ? delimMatch.index : content.length;

    const nextPrefixMatcher = /(?:\/Users\/|\/Volumes\/)/gi;
    nextPrefixMatcher.lastIndex = startIdx + candidate[0].length;
    const nextPrefixMatch = nextPrefixMatcher.exec(content);
    const nextPrefixStart = nextPrefixMatch ? nextPrefixMatch.index : content.length;

    const segmentEnd = Math.min(delimEnd, nextPrefixStart);
    const segment = content.slice(startIdx, segmentEnd);
    anchored.lastIndex = 0;
    const match = anchored.exec(segment);
    if (match) {
      if (match[0] !== filePath) results.push(match[0]);
      prefix.lastIndex = startIdx + anchored.lastIndex;
    } else if (nextPrefixStart < delimEnd) {
      prefix.lastIndex = nextPrefixStart;
    } else {
      prefix.lastIndex = delimMatch ? delimEnd + 1 : content.length;
    }
  }
  return results;
}

class AIParser extends BaseParser {
  /**
   * Extract linked assets from an Adobe Illustrator file.
   *
   * @param {string} filePath - Absolute path to the .ai file
   * @returns {Promise<Array<{path: string, source: string, exists: boolean}>>}
   */
  async extractAssets(filePath) {
    const assets = [];

    // Fast & more accurate native path: scans raw bytes, XMP packets, AND
    // FlateDecode compressed PDF streams (recovering modern .ai links even
    // when Illustrator is closed).
    if (nativeHelper.isAvailable()) {
      const fs = require('node:fs');
      const { ADMISSION_LIMITS, admissionError } = require('./admission-budgets');
      let stat;
      try { stat = fs.lstatSync(filePath); } catch (_) { stat = null; }
      if (stat && (stat.isSymbolicLink() || !stat.isFile() || stat.size > ADMISSION_LIMITS.localParserFileBytes)) {
        throw admissionError('This design file is too large for Crate to inspect safely.');
      }
      try {
        const parsed = await nativeHelper.parsePdfAi(filePath, { decompressStreams: true });
        if (parsed && (parsed.incomplete === true || (Array.isArray(parsed.issues) && parsed.issues.length > 0))) {
          throw new Error('pdf_ai_native_incomplete');
        }
        for (const linkedPath of (parsed && parsed.paths) || []) {
          if (!this.isUserPath(linkedPath) || !isSupportedQuickAiLinkedPath(linkedPath)) continue;
          const exists = this.fileExists(linkedPath);
          this.appendAsset(assets, {
            path: linkedPath,
            source: 'ai-regex',
            exists
          });
        }
        return this.deduplicateAssets(assets);
      } catch (err) {
        if (err && err.code === 'CRATE_PARSER_ADMISSION_LIMIT') throw err;
        // Fall through to bounded JS regex scan on any native edge case or incomplete coverage.
      }
    }

    // Read file as buffer and convert to UTF-8 string for regex scanning
    // Binary paths appear as readable strings in the PDF structure
    const buffer = this.readFileBuffer(filePath);
    const content = buffer.toString('utf8');

    for (const linkedPath of extractQuickAiLinkedPaths(content, filePath)) {
      // Skip system paths (unlikely to be user assets)
      if (!this.isUserPath(linkedPath) || !isSupportedQuickAiLinkedPath(linkedPath)) continue;

      // Check if the file exists and record result
      const exists = this.fileExists(linkedPath);

      this.appendAsset(assets, {
        path: linkedPath,
        source: 'ai-regex',
        exists
      });
    }

    // Deduplicate (same path may appear multiple times in the file)
    return this.deduplicateAssets(assets);
  }

  static get extensions() {
    return ['.ai', '.ait'];  // .ait = Illustrator template
  }

  static get displayName() {
    return 'Adobe Illustrator';
  }
}

module.exports = { AIParser };
