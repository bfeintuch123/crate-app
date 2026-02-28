/**
 * Crate v2.0 — After Effects Parser
 *
 * Extracts linked footage/asset paths from .aep (After Effects project) files.
 *
 * BINARY FORMAT:
 * After Effects projects use a RIFX binary format (variant of RIFF).
 * Footage file paths are stored as UTF-8 strings within the binary data.
 *
 * APPROACH:
 * Uses binary regex scanning (same proven approach as ai.js).
 * Reads the .aep file as a buffer, converts to UTF-8, and scans for
 * macOS absolute paths with known media extensions.
 */

'use strict';

const { BaseParser } = require('./base');

// Regex to find macOS absolute paths to media files in binary data.
// Includes video, audio, image, and compositing formats common in AE projects.
const LINKED_ASSET_REGEX = /\/Users\/[^\x00-\x1f\x22\x27\x7f<>|*?\n\r]+\.(mp4|mov|avi|mkv|mxf|webm|wmv|flv|wav|mp3|aiff|aif|m4a|aac|ogg|flac|jpg|jpeg|png|gif|tiff|tif|psd|ai|pdf|eps|svg|exr|dpx|cin|hdr|raw|cr2|nef|arw|dng|bmp|tga|webp)/gi;

// Also scan for /Volumes/ paths (external drives, common in video production)
const VOLUMES_ASSET_REGEX = /\/Volumes\/[^\x00-\x1f\x22\x27\x7f<>|*?\n\r]+\.(mp4|mov|avi|mkv|mxf|webm|wmv|flv|wav|mp3|aiff|aif|m4a|aac|ogg|flac|jpg|jpeg|png|gif|tiff|tif|psd|ai|pdf|eps|svg|exr|dpx|cin|hdr|raw|cr2|nef|arw|dng|bmp|tga|webp)/gi;

// Scan for After Effects specific files (nested comps, project references)
const AEP_ASSET_REGEX = /\/Users\/[^\x00-\x1f\x22\x27\x7f<>|*?\n\r]+\.(aep|aet|aepx)/gi;
const AEP_VOLUMES_REGEX = /\/Volumes\/[^\x00-\x1f\x22\x27\x7f<>|*?\n\r]+\.(aep|aet|aepx)/gi;

class AfterEffectsParser extends BaseParser {
  /**
   * Extract linked footage paths from an After Effects project file.
   *
   * @param {string} filePath - Absolute path to the .aep file
   * @returns {Promise<Array<{path: string, source: string, exists: boolean}>>}
   */
  async extractAssets(filePath) {
    const assets = [];

    try {
      // Read file as buffer and convert to UTF-8 string for regex scanning
      const buffer = this.readFileBuffer(filePath);
      const content = buffer.toString('utf8');

      // Scan for /Users/ paths with media extensions
      LINKED_ASSET_REGEX.lastIndex = 0;
      let match;
      while ((match = LINKED_ASSET_REGEX.exec(content)) !== null) {
        const linkedPath = match[0];
        if (!this.isUserPath(linkedPath)) continue;

        assets.push({
          path: linkedPath,
          source: 'aep-regex',
          exists: this.fileExists(linkedPath)
        });
      }

      // Scan for /Volumes/ paths (external drives)
      VOLUMES_ASSET_REGEX.lastIndex = 0;
      while ((match = VOLUMES_ASSET_REGEX.exec(content)) !== null) {
        const linkedPath = match[0];

        assets.push({
          path: linkedPath,
          source: 'aep-regex',
          exists: this.fileExists(linkedPath)
        });
      }

      // Scan for nested AE project references
      AEP_ASSET_REGEX.lastIndex = 0;
      while ((match = AEP_ASSET_REGEX.exec(content)) !== null) {
        const linkedPath = match[0];
        if (!this.isUserPath(linkedPath)) continue;
        // Skip self-reference
        if (linkedPath === filePath) continue;

        assets.push({
          path: linkedPath,
          source: 'aep-project-ref',
          exists: this.fileExists(linkedPath)
        });
      }

      AEP_VOLUMES_REGEX.lastIndex = 0;
      while ((match = AEP_VOLUMES_REGEX.exec(content)) !== null) {
        const linkedPath = match[0];
        // Skip self-reference
        if (linkedPath === filePath) continue;

        assets.push({
          path: linkedPath,
          source: 'aep-project-ref',
          exists: this.fileExists(linkedPath)
        });
      }

    } catch (err) {
      // Graceful error handling — return what we have
      if (assets.length === 0) {
        // If we got nothing and had an error, report it
        throw new Error(`Failed to parse After Effects file: ${err.message}`);
      }
    }

    return this.deduplicateAssets(assets);
  }

  static get extensions() {
    return ['.aep', '.aet'];  // .aet = After Effects template
  }

  static get displayName() {
    return 'Adobe After Effects';
  }
}

module.exports = { AfterEffectsParser };
