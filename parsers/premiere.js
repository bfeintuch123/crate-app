/**
 * Crate v2.0 — Premiere Pro Parser
 *
 * Extracts linked media asset paths from .prproj files.
 *
 * Premiere Pro project files (.prproj) are gzip-compressed XML.
 * Media references are stored in various XML tags, primarily:
 *   - <ActualMediaFilePath>/path/to/file.mp4</ActualMediaFilePath>
 *   - <FilePath>/path/to/file.mp4</FilePath>
 *
 * The parser:
 *   1. Reads the .prproj file as a gzip buffer
 *   2. Decompresses using Node's built-in zlib
 *   3. Extracts paths using regex (no external XML parser needed)
 */

'use strict';

const { BaseParser } = require('./base');
const zlib = require('zlib');

// Regex patterns for extracting media paths from Premiere XML
// ActualMediaFilePath is the primary tag for linked footage
const MEDIA_PATH_REGEX = /<ActualMediaFilePath>([^<]+)<\/ActualMediaFilePath>/g;

// FilePath is used in some contexts (e.g., nested sequences, legacy projects)
const FILE_PATH_REGEX = /<FilePath>([^<]+)<\/FilePath>/g;

// Generic macOS path pattern as fallback for any other path-containing tags
const GENERIC_PATH_REGEX = />\/Users\/[^\x00-\x1f\x22\x27\x7f<>|*?\n\r]+\.(mp4|mov|avi|mkv|mxf|mpg|mpeg|m4v|wmv|flv|webm|jpg|jpeg|png|gif|tiff|tif|psd|ai|pdf|eps|svg|wav|mp3|aiff|aif|m4a|aac|wma|flac|ogg)/gi;

class PremiereParser extends BaseParser {
  /**
   * Extract linked media assets from a Premiere Pro project file.
   *
   * @param {string} filePath - Absolute path to the .prproj file
   * @returns {Promise<Array<{path: string, source: string, exists: boolean}>>}
   */
  async extractAssets(filePath) {
    const assets = [];

    // Read and decompress the gzip file
    const compressed = this.readFileBuffer(filePath);
    let xmlContent;

    try {
      const decompressed = zlib.gunzipSync(compressed);
      xmlContent = decompressed.toString('utf8');
    } catch (e) {
      // Not gzip compressed — try reading as plain text (older Premiere versions)
      xmlContent = compressed.toString('utf8');
    }

    // Extract paths from ActualMediaFilePath tags (primary source)
    MEDIA_PATH_REGEX.lastIndex = 0;
    let match;
    while ((match = MEDIA_PATH_REGEX.exec(xmlContent)) !== null) {
      const mediaPath = this.decodeXMLEntities(match[1]);

      if (this.isUserPath(mediaPath)) {
        const exists = this.fileExists(mediaPath);
        assets.push({
          path: mediaPath,
          source: 'prproj-mediapath',
          exists
        });
      }
    }

    // Extract paths from FilePath tags (secondary source)
    FILE_PATH_REGEX.lastIndex = 0;
    while ((match = FILE_PATH_REGEX.exec(xmlContent)) !== null) {
      const mediaPath = this.decodeXMLEntities(match[1]);

      if (this.isUserPath(mediaPath)) {
        const exists = this.fileExists(mediaPath);
        assets.push({
          path: mediaPath,
          source: 'prproj-filepath',
          exists
        });
      }
    }

    // Fallback: scan for any remaining paths not caught by specific tags
    GENERIC_PATH_REGEX.lastIndex = 0;
    while ((match = GENERIC_PATH_REGEX.exec(xmlContent)) !== null) {
      // Remove leading '>' from the match (it's part of the lookahead)
      const mediaPath = match[0].startsWith('>') ? match[0].slice(1) : match[0];

      if (this.isUserPath(mediaPath)) {
        const exists = this.fileExists(mediaPath);
        assets.push({
          path: mediaPath,
          source: 'prproj-generic',
          exists
        });
      }
    }

    return this.deduplicateAssets(assets);
  }

  /**
   * Decode common XML entities in path strings
   *
   * @param {string} str - String potentially containing XML entities
   * @returns {string} - Decoded string
   */
  decodeXMLEntities(str) {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec))
      .replace(/&#x([0-9a-f]+);/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
  }

  static get extensions() {
    return ['.prproj'];
  }

  static get displayName() {
    return 'Adobe Premiere Pro';
  }
}

module.exports = { PremiereParser };
