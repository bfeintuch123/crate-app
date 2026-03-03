/**
 * Crate v2.0 — Parser Base Class
 *
 * Abstract base class that all format-specific parsers must extend.
 * Defines the common interface for extracting linked/embedded assets from design files.
 *
 * Each parser implements:
 *   - extractAssets(filePath): finds all assets referenced by the design file
 *   - static get extensions(): array of file extensions this parser handles
 *   - static get displayName(): human-readable format name
 */

'use strict';

const fs = require('fs');
const path = require('path');

class BaseParser {
  /**
   * Extract all linked/embedded assets from a design file.
   *
   * @param {string} filePath - Absolute path to the design file
   * @returns {Promise<Array<{path: string, source: string, exists: boolean}>>}
   *   - path: absolute path to the asset
   *   - source: short identifier for how this asset was found (e.g. 'ai-regex', 'idml-link')
   *   - exists: whether the file currently exists on disk
   */
  async extractAssets(filePath) {
    throw new Error(`extractAssets() must be implemented by ${this.constructor.name}`);
  }

  /**
   * File extensions this parser handles (e.g. ['.ai', '.ait'])
   * @returns {string[]}
   */
  static get extensions() {
    throw new Error('extensions getter must be implemented by subclass');
  }

  /**
   * Human-readable format name (e.g. 'Adobe Illustrator')
   * @returns {string}
   */
  static get displayName() {
    throw new Error('displayName getter must be implemented by subclass');
  }

  /**
   * Helper: check if a path exists on disk
   * @param {string} filePath
   * @returns {boolean}
   */
  fileExists(filePath) {
    try {
      return fs.existsSync(filePath);
    } catch (e) {
      return false;
    }
  }

  /**
   * Helper: read a file as Buffer
   * @param {string} filePath
   * @returns {Buffer}
   */
  readFileBuffer(filePath) {
    return fs.readFileSync(filePath);
  }

  /**
   * Helper: deduplicate an array of asset objects by path
   * @param {Array<{path: string, source: string, exists: boolean}>} assets
   * @returns {Array<{path: string, source: string, exists: boolean}>}
   */
  deduplicateAssets(assets) {
    const seen = new Set();
    return assets.filter(a => {
      if (seen.has(a.path)) return false;
      seen.add(a.path);
      return true;
    });
  }

  /**
   * Helper: filter out system paths (macOS system directories)
   * @param {string} filePath
   * @returns {boolean} true if path is NOT a system path
   */
  isUserPath(filePath) {
    const systemPrefixes = ['/System/', '/Library/', '/Applications/', '/usr/', '/bin/', '/sbin/', '/private/'];
    return !systemPrefixes.some(prefix => filePath.startsWith(prefix));
  }
}

module.exports = { BaseParser };
