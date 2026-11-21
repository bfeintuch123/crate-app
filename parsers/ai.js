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

const { BaseParser } = require('./base');
const { nativeHelper } = require('./native-helper');

// Regex to find macOS absolute paths to image/design/font/media files in binary data.
// Matches /Users/... and /Volumes/... lazily so adjacent paths on the same line
// stay distinct. Used as fallback when the native Swift PDF/XMP/FlateDecode
// extractor is unavailable.
const LINKED_ASSET_REGEX = /(?:\/Users\/|\/Volumes\/)[^\x00-\x1f\x22\x27\x7f<>|*?\n\r]+?\.(jpg|jpeg|png|gif|webp|svg|pdf|eps|ai|psd|psb|tiff|tif|afdesign|afphoto|afpub|indd|idml|sketch|fig|heic|ttf|otf|woff2|woff|mp4|mov|avi|webm)/gi;

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
        for (const linkedPath of parsed.paths || []) {
          if (!this.isUserPath(linkedPath)) continue;
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
        // Fall through to JS regex scan on any native edge case.
      }
    }

    // Read file as buffer and convert to UTF-8 string for regex scanning
    // Binary paths appear as readable strings in the PDF structure
    const buffer = this.readFileBuffer(filePath);
    const content = buffer.toString('utf8');

    // Reset regex lastIndex for fresh search
    LINKED_ASSET_REGEX.lastIndex = 0;

    let match;
    while ((match = LINKED_ASSET_REGEX.exec(content)) !== null) {
      const linkedPath = match[0];

      // Skip system paths (unlikely to be user assets)
      if (!this.isUserPath(linkedPath)) continue;

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
