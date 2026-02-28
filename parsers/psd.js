/**
 * Crate v2.0 — Photoshop Parser
 *
 * Extracts linked Smart Object paths from Photoshop .psd/.psb files.
 *
 * APPROACH:
 * Uses binary regex scanning (same proven approach as ai.js) as the primary
 * method, with the 'psd' npm package as an enhancement when available.
 * PSD files store linked Smart Object paths as UTF-8/UTF-16 strings in the
 * binary data, making regex scanning reliable.
 */

'use strict';

const { BaseParser } = require('./base');

// Regex to find macOS absolute paths to image/design files in binary data.
// Matches: /Users/name/path/to/file.jpg (and other extensions)
// Excludes control characters and path-illegal chars to avoid false matches.
const LINKED_ASSET_REGEX = /\/Users\/[^\x00-\x1f\x22\x27\x7f<>|*?\n\r]+\.(jpg|jpeg|png|gif|tiff|tif|pdf|eps|svg|psd|ai|psb|webp|heic|raw|cr2|nef|arw|dng)/gi;

// Also scan for /Volumes/ paths (external drives)
const VOLUMES_ASSET_REGEX = /\/Volumes\/[^\x00-\x1f\x22\x27\x7f<>|*?\n\r]+\.(jpg|jpeg|png|gif|tiff|tif|pdf|eps|svg|psd|ai|psb|webp|heic|raw|cr2|nef|arw|dng)/gi;

// Try to load psd package (optional enhancement)
let PSD = null;
try {
  PSD = require('psd');
} catch (e) {
  // psd package not installed — binary scanning will still work
}

class PSDParser extends BaseParser {
  /**
   * Extract linked Smart Objects from a Photoshop file.
   *
   * @param {string} filePath - Absolute path to the .psd file
   * @returns {Promise<Array<{path: string, source: string, exists: boolean}>>}
   */
  async extractAssets(filePath) {
    const assets = [];

    // Primary approach: binary regex scan (reliable)
    try {
      const buffer = this.readFileBuffer(filePath);
      const content = buffer.toString('utf8');

      // Scan for /Users/ paths
      LINKED_ASSET_REGEX.lastIndex = 0;
      let match;
      while ((match = LINKED_ASSET_REGEX.exec(content)) !== null) {
        const linkedPath = match[0];
        if (!this.isUserPath(linkedPath)) continue;

        assets.push({
          path: linkedPath,
          source: 'psd-regex',
          exists: this.fileExists(linkedPath)
        });
      }

      // Scan for /Volumes/ paths (external drives)
      VOLUMES_ASSET_REGEX.lastIndex = 0;
      while ((match = VOLUMES_ASSET_REGEX.exec(content)) !== null) {
        const linkedPath = match[0];

        assets.push({
          path: linkedPath,
          source: 'psd-regex',
          exists: this.fileExists(linkedPath)
        });
      }
    } catch (err) {
      // If binary scanning fails, continue to try psd package
    }

    // Enhancement: try psd package for additional coverage
    if (PSD) {
      try {
        const psd = await PSD.open(filePath);
        const tree = psd.tree();

        this._walkLayers(tree, assets);
      } catch (err) {
        // psd package failed — fall back to binary scan results only
      }
    }

    return this.deduplicateAssets(assets);
  }

  /**
   * Recursively walk PSD layer tree looking for Smart Objects.
   * @private
   */
  _walkLayers(node, assets) {
    try {
      // Try to get layer export data
      const exported = node.export ? node.export() : null;

      if (exported) {
        // Check for Smart Object references in layer data
        if (exported.smartObject && exported.smartObject.linked) {
          const linkedPath = exported.smartObject.linked;
          if (typeof linkedPath === 'string' && linkedPath.startsWith('/')) {
            assets.push({
              path: linkedPath,
              source: 'psd-smartobject',
              exists: this.fileExists(linkedPath)
            });
          }
        }

        // Check for placed layer references
        if (exported.placedLayer && exported.placedLayer.filePath) {
          const linkedPath = exported.placedLayer.filePath;
          if (typeof linkedPath === 'string' && linkedPath.startsWith('/')) {
            assets.push({
              path: linkedPath,
              source: 'psd-placedlayer',
              exists: this.fileExists(linkedPath)
            });
          }
        }
      }

      // Recursively process children
      const children = node.children ? node.children() : [];
      for (const child of children) {
        this._walkLayers(child, assets);
      }
    } catch (err) {
      // Skip problematic layers
    }
  }

  static get extensions() {
    return ['.psd', '.psb'];  // .psb = Large Document Format (Photoshop Big)
  }

  static get displayName() {
    return 'Adobe Photoshop';
  }
}

module.exports = { PSDParser };
