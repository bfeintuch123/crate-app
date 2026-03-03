/**
 * Crate v2.0 — InDesign/IDML Parser
 *
 * Extracts linked asset paths from .indd and .idml files.
 *
 * IDML (InDesign Markup Language) files are ZIP archives containing XML.
 * Linked assets are referenced via LinkResourceURI attributes in the XML.
 *
 * Format: file:///Users/name/path/to/file.jpg (URI-encoded)
 *
 * Key XML files inside IDML:
 *   - designmap.xml: document structure and references
 *   - Resources/Links.xml: link metadata (not always present)
 *   - Spreads/Spread_*.xml: spread content with placed items
 *
 * The LinkResourceURI attribute appears on <Link> elements and contains
 * the absolute file:// URI to the linked asset.
 *
 * Note: Native .indd files are binary and harder to parse. This parser
 * focuses on .idml which InDesign can export. For .indd, we fall back
 * to regex scanning similar to the AI parser approach.
 */

'use strict';

const { BaseParser } = require('./base');
const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execFileAsync = promisify(execFile);

// Regex to extract LinkResourceURI values from IDML XML
// Matches: LinkResourceURI="file:///Users/path/to/file.ext"
const LINK_URI_REGEX = /LinkResourceURI="([^"]+)"/g;

// Regex for binary .indd scanning (same approach as AI parser)
const LINKED_ASSET_REGEX = /\/Users\/[^\x00-\x1f\x22\x27\x7f<>|*?\n\r]+\.(jpg|jpeg|png|gif|webp|svg|pdf|eps|ai|psd|psb|tiff|tif|indd|idml)/gi;

class InDesignParser extends BaseParser {
  /**
   * Extract linked assets from an InDesign/IDML file.
   *
   * @param {string} filePath - Absolute path to the .indd or .idml file
   * @returns {Promise<Array<{path: string, source: string, exists: boolean}>>}
   */
  async extractAssets(filePath) {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.idml') {
      return this.extractFromIDML(filePath);
    } else {
      // .indd — binary format, use regex scanning
      return this.extractFromINDD(filePath);
    }
  }

  /**
   * Extract links from IDML (ZIP + XML format)
   */
  async extractFromIDML(filePath) {
    const assets = [];

    try {
      // List all files in the IDML archive
      const { stdout: listing } = await execFileAsync('/usr/bin/unzip', ['-l', filePath], {
        timeout: 10000,
        encoding: 'utf8'
      });

      // Find all XML files that might contain links
      const xmlFiles = [];
      for (const line of listing.split('\n')) {
        const match = line.match(/^\s*\d+\s+[\d-]+\s+[\d:]+\s+(.+\.xml)$/i);
        if (match) {
          xmlFiles.push(match[1].trim());
        }
      }

      // Extract and scan each XML file for LinkResourceURI attributes
      for (const xmlFile of xmlFiles) {
        try {
          const { stdout: xmlContent } = await execFileAsync('/usr/bin/unzip', ['-p', filePath, xmlFile], {
            timeout: 10000,
            encoding: 'utf8',
            maxBuffer: 50 * 1024 * 1024  // 50MB buffer for large files
          });

          // Find all LinkResourceURI values
          LINK_URI_REGEX.lastIndex = 0;
          let match;
          while ((match = LINK_URI_REGEX.exec(xmlContent)) !== null) {
            const uri = match[1];
            const assetPath = this.decodeFileURI(uri);

            if (assetPath && this.isUserPath(assetPath)) {
              const exists = this.fileExists(assetPath);
              assets.push({
                path: assetPath,
                source: 'idml-link',
                exists
              });
            }
          }
        } catch (e) {
          // Failed to extract this XML file — continue with others
        }
      }
    } catch (e) {
      // Failed to list IDML contents — return empty array
      console.error(`[InDesignParser] Failed to read IDML: ${e.message}`);
    }

    return this.deduplicateAssets(assets);
  }

  /**
   * Extract links from binary .indd using regex scanning
   */
  async extractFromINDD(filePath) {
    const assets = [];

    // Read file as buffer and convert to UTF-8 for regex scanning
    const buffer = this.readFileBuffer(filePath);
    const content = buffer.toString('utf8');

    LINKED_ASSET_REGEX.lastIndex = 0;
    let match;
    while ((match = LINKED_ASSET_REGEX.exec(content)) !== null) {
      const linkedPath = match[0];

      if (!this.isUserPath(linkedPath)) continue;

      const exists = this.fileExists(linkedPath);
      assets.push({
        path: linkedPath,
        source: 'indd-regex',
        exists
      });
    }

    return this.deduplicateAssets(assets);
  }

  /**
   * Decode a file:// URI to an absolute path
   *
   * Handles:
   *   - file:///Users/name/path/to/file.jpg
   *   - URL-encoded characters (%20 for space, etc.)
   *
   * @param {string} uri - The file:// URI
   * @returns {string|null} - Decoded absolute path, or null if not a file URI
   */
  decodeFileURI(uri) {
    if (!uri || !uri.startsWith('file://')) {
      return null;
    }

    // Remove file:// prefix (could be file:// or file:///)
    let path = uri.replace(/^file:\/\//, '');

    // Decode URI-encoded characters (%20 → space, etc.)
    try {
      path = decodeURIComponent(path);
    } catch (e) {
      // Invalid URI encoding — return as-is
    }

    // Ensure path starts with / (absolute path)
    if (!path.startsWith('/')) {
      return null;
    }

    return path;
  }

  static get extensions() {
    return ['.indd', '.idml'];
  }

  static get displayName() {
    return 'Adobe InDesign';
  }
}

module.exports = { InDesignParser };
