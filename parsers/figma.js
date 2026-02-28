/**
 * Crate v2.0 — Figma Parser
 *
 * Extracts image assets from Figma files via the Figma REST API.
 *
 * Unlike desktop design tools, Figma files are cloud-native.
 * This parser works by:
 *   1. User provides a Figma file URL
 *   2. Parser extracts the file key from the URL
 *   3. API calls retrieve the file structure and image exports
 *   4. Images can be downloaded to local disk
 *
 * AUTHENTICATION:
 * Figma API requires a Personal Access Token (PAT).
 * Token is stored using keytar (macOS Keychain) if available,
 * or falls back to ~/.crate/figma-token file or FIGMA_PAT env var.
 */

'use strict';

const { BaseParser } = require('./base');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Try to load optional dependencies
let fetch = null;
let keytar = null;

try {
  fetch = require('node-fetch');
} catch (e) {
  // node-fetch not installed
}

try {
  keytar = require('keytar');
} catch (e) {
  // keytar not installed — will use file-based fallback
}

const FIGMA_API_BASE = 'https://api.figma.com/v1';
const TOKEN_FILE_PATH = path.join(os.homedir(), '.crate', 'figma-token');

class FigmaParser extends BaseParser {
  /**
   * Get stored Figma Personal Access Token.
   * Tries multiple sources in order:
   *   1. macOS Keychain (via keytar)
   *   2. FIGMA_PAT environment variable
   *   3. ~/.crate/figma-token file
   *
   * @returns {Promise<string|null>}
   */
  async getStoredToken() {
    // Try keytar first (secure storage)
    if (keytar) {
      try {
        const token = await keytar.getPassword('crate-app', 'figma-pat');
        if (token) return token;
      } catch (e) {
        // Keytar failed — continue to fallbacks
      }
    }

    // Try environment variable
    if (process.env.FIGMA_PAT) {
      return process.env.FIGMA_PAT;
    }

    // Try file-based storage
    try {
      if (fs.existsSync(TOKEN_FILE_PATH)) {
        const token = fs.readFileSync(TOKEN_FILE_PATH, 'utf8').trim();
        if (token) return token;
      }
    } catch (e) {
      // File read failed
    }

    return null;
  }

  /**
   * Store Figma Personal Access Token.
   * Tries keytar first, falls back to file storage.
   *
   * @param {string} token - Figma PAT to store
   * @returns {Promise<boolean>} - true if stored successfully
   */
  async storeToken(token) {
    if (!token || typeof token !== 'string') return false;

    // Try keytar first (secure storage)
    if (keytar) {
      try {
        await keytar.setPassword('crate-app', 'figma-pat', token);
        return true;
      } catch (e) {
        // Keytar failed — fall back to file storage
      }
    }

    // Fall back to file storage
    try {
      const dir = path.dirname(TOKEN_FILE_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(TOKEN_FILE_PATH, token, { mode: 0o600 });
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Delete stored Figma Personal Access Token.
   *
   * @returns {Promise<boolean>} - true if deleted successfully
   */
  async deleteToken() {
    let deleted = false;

    // Try keytar
    if (keytar) {
      try {
        await keytar.deletePassword('crate-app', 'figma-pat');
        deleted = true;
      } catch (e) {
        // Ignore
      }
    }

    // Also try file
    try {
      if (fs.existsSync(TOKEN_FILE_PATH)) {
        fs.unlinkSync(TOKEN_FILE_PATH);
        deleted = true;
      }
    } catch (e) {
      // Ignore
    }

    return deleted;
  }

  /**
   * Extract assets from a Figma file.
   *
   * @param {string} filePath - Figma file URL or local .fig file path
   * @returns {Promise<Array<{path: string, source: string, exists: boolean, nodeId?: string, name?: string}>>}
   */
  async extractAssets(filePath) {
    // Check if node-fetch is available
    if (!fetch) {
      throw new Error(
        'Figma parser requires: npm install node-fetch@2\n' +
        'Run this command in the parsers directory and try again.'
      );
    }

    // Check if this is a local .fig file
    if (filePath.endsWith('.fig') && !filePath.includes('://')) {
      throw new Error(
        'Figma files are cloud-based. Please provide a Figma URL instead, or set up the Figma API connection.\n\n' +
        'Example URL: https://www.figma.com/file/ABC123/My-File\n\n' +
        'To use the Figma API:\n' +
        '  1. Generate a Personal Access Token at https://www.figma.com/developers/api#access-tokens\n' +
        '  2. Store it with: export FIGMA_PAT="your-token-here"\n' +
        '     Or save to: ~/.crate/figma-token'
      );
    }

    // Extract file key from URL
    const fileKey = FigmaParser.extractFileKey(filePath);
    if (!fileKey) {
      throw new Error(
        'Invalid Figma URL. Expected format:\n' +
        '  https://www.figma.com/file/ABC123/File-Name\n' +
        '  https://www.figma.com/design/ABC123/File-Name\n' +
        '  https://www.figma.com/proto/ABC123/File-Name'
      );
    }

    // Get stored token
    const token = await this.getStoredToken();
    if (!token) {
      throw new Error(
        'Figma API requires authentication.\n\n' +
        'Setup instructions:\n' +
        '  1. Generate a Personal Access Token at:\n' +
        '     https://www.figma.com/developers/api#access-tokens\n\n' +
        '  2. Store your token using one of these methods:\n' +
        '     • Environment variable: export FIGMA_PAT="your-token-here"\n' +
        '     • Token file: echo "your-token" > ~/.crate/figma-token\n' +
        '     • Programmatic: const parser = new FigmaParser(); await parser.storeToken("your-token");'
      );
    }

    const assets = [];

    // Fetch file structure
    const fileData = await this._fetchAPI(`/files/${fileKey}`, token);

    // Find all nodes with image fills or that are exportable
    const imageNodeIds = [];
    const nodeNames = {};
    this._findImageNodes(fileData.document, imageNodeIds, nodeNames);

    if (imageNodeIds.length === 0) {
      // No exportable nodes found
      return assets;
    }

    // Request image exports for all nodes (batch request)
    // Figma API limits to 500 IDs per request
    const batches = this._chunkArray(imageNodeIds, 500);

    for (const batch of batches) {
      try {
        const imagesData = await this._fetchAPI(
          `/images/${fileKey}?ids=${batch.join(',')}&format=png&scale=2`,
          token
        );

        if (imagesData.images) {
          for (const [nodeId, url] of Object.entries(imagesData.images)) {
            if (url) {
              assets.push({
                path: url,
                source: 'figma-api',
                exists: true,
                nodeId,
                name: nodeNames[nodeId] || nodeId
              });
            }
          }
        }
      } catch (err) {
        // Continue with other batches on error
      }
    }

    return this.deduplicateAssets(assets);
  }

  /**
   * Download assets from CDN URLs to a local directory.
   *
   * @param {Array<{path: string, name?: string}>} assets - Assets with CDN URLs
   * @param {string} destDir - Destination directory
   * @returns {Promise<string[]>} - Array of local file paths
   */
  async downloadAssets(assets, destDir) {
    if (!fetch) {
      throw new Error('node-fetch is required for downloading assets');
    }

    // Ensure destination directory exists
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const downloadedPaths = [];

    for (const asset of assets) {
      try {
        const response = await fetch(asset.path);
        if (!response.ok) {
          continue;
        }

        // Determine filename
        const safeName = (asset.name || asset.nodeId || 'asset')
          .replace(/[^a-zA-Z0-9_-]/g, '_')
          .substring(0, 100);
        const filename = `${safeName}.png`;
        const localPath = path.join(destDir, filename);

        // Write file
        const buffer = await response.buffer();
        fs.writeFileSync(localPath, buffer);
        downloadedPaths.push(localPath);
      } catch (err) {
        // Skip failed downloads
      }
    }

    return downloadedPaths;
  }

  /**
   * Make an authenticated request to the Figma API.
   * @private
   */
  async _fetchAPI(endpoint, token) {
    const url = `${FIGMA_API_BASE}${endpoint}`;
    const response = await fetch(url, {
      headers: {
        'X-Figma-Token': token
      }
    });

    if (!response.ok) {
      const status = response.status;
      if (status === 401) {
        throw new Error('Invalid Figma API token. Please check your Personal Access Token.');
      } else if (status === 403) {
        throw new Error('Access denied. You may not have permission to view this Figma file.');
      } else if (status === 404) {
        throw new Error('Figma file not found. Check that the file URL is correct and the file still exists.');
      } else if (status === 429) {
        throw new Error('Rate limit exceeded. Please wait a moment and try again.');
      } else {
        throw new Error(`Figma API error: ${status} ${response.statusText}`);
      }
    }

    return response.json();
  }

  /**
   * Recursively find nodes with image fills or export settings.
   * @private
   */
  _findImageNodes(node, nodeIds, nodeNames) {
    if (!node) return;

    // Check if node has export settings or image fills
    const hasExport = node.exportSettings && node.exportSettings.length > 0;
    const hasImageFill = node.fills && node.fills.some(f => f.type === 'IMAGE');
    const isFrame = node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE';

    if (hasExport || hasImageFill || isFrame) {
      nodeIds.push(node.id);
      nodeNames[node.id] = node.name || node.id;
    }

    // Recurse into children
    if (node.children) {
      for (const child of node.children) {
        this._findImageNodes(child, nodeIds, nodeNames);
      }
    }
  }

  /**
   * Split array into chunks.
   * @private
   */
  _chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Extract the file key from a Figma URL.
   *
   * Supported URL formats:
   *   https://www.figma.com/file/FILEKEY/...
   *   https://www.figma.com/design/FILEKEY/...
   *   https://www.figma.com/proto/FILEKEY/...
   *
   * @param {string} url - Figma URL
   * @returns {string|null} - File key or null if URL is invalid
   */
  static extractFileKey(url) {
    if (!url || typeof url !== 'string') return null;

    // Match Figma URL patterns
    const patterns = [
      /figma\.com\/file\/([a-zA-Z0-9]+)/,
      /figma\.com\/design\/([a-zA-Z0-9]+)/,
      /figma\.com\/proto\/([a-zA-Z0-9]+)/
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }

    return null;
  }

  static get extensions() {
    // Figma is URL-based, not file-based
    // This is here for completeness but the parser works differently
    return ['.fig'];
  }

  static get displayName() {
    return 'Figma';
  }
}

module.exports = { FigmaParser };
