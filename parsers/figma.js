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
if (!fetch && typeof globalThis.fetch === 'function') {
  fetch = globalThis.fetch.bind(globalThis);
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
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, {
        headers: { 'X-Figma-Token': token },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

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
    } catch (e) {
      clearTimeout(timeoutId);
      if (e.name === 'AbortError') throw new Error('Figma API request timed out after 30s');
      throw e;
    }
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
    if (hasExport || hasImageFill) {
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

  // =========================================================================
  // AUTO-TRACKING: Discover all Figma files the user has access to
  // =========================================================================

  /**
   * Verify the stored token is valid and get user info.
   * @returns {Promise<{valid: boolean, user?: {id: string, handle: string, email: string}}>}
   */
  async verifyToken() {
    const token = await this.getStoredToken();
    if (!token) return { valid: false };

    if (!fetch) return { valid: false, error: 'node-fetch not installed' };

    try {
      const userData = await this._fetchAPI('/me', token);
      return {
        valid: true,
        user: {
          id: userData.id,
          handle: userData.handle,
          email: userData.email
        }
      };
    } catch (e) {
      return { valid: false, error: e.message };
    }
  }

  /**
   * Get team info for a known team ID.
   * NOTE: The Figma /v1/me endpoint does NOT return team_id (despite earlier assumptions).
   * Team IDs must be provided by the user from their Figma team URL.
   *
   * @param {string} teamId - Team ID (from URL: figma.com/files/team/{teamId}/...)
   * @returns {Promise<{id: string, name: string}|null>}
   */
  async getTeamInfo(teamId) {
    const token = await this.getStoredToken();
    if (!token || !fetch || !teamId) return null;

    try {
      const teamData = await this._fetchAPI(`/teams/${teamId}`, token);
      if (teamData && teamData.name) {
        return { id: teamId, name: teamData.name };
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Get all projects in a team.
   * @param {string} teamId
   * @returns {Promise<Array<{id: string, name: string}>>}
   */
  async getTeamProjects(teamId) {
    const token = await this.getStoredToken();
    if (!token || !fetch) return [];

    try {
      const data = await this._fetchAPI(`/teams/${teamId}/projects`, token);
      return (data.projects || []).map(p => ({ id: p.id, name: p.name }));
    } catch (e) {
      return [];
    }
  }

  /**
   * Get all files in a project.
   * @param {string} projectId
   * @returns {Promise<Array<{key: string, name: string, lastModified: string, thumbnailUrl: string}>>}
   */
  async getProjectFiles(projectId) {
    const token = await this.getStoredToken();
    if (!token || !fetch) return [];

    try {
      const data = await this._fetchAPI(`/projects/${projectId}/files`, token);
      return (data.files || []).map(f => ({
        key: f.key,
        name: f.name,
        lastModified: f.last_modified,
        thumbnailUrl: f.thumbnail_url
      }));
    } catch (e) {
      return [];
    }
  }

  /**
   * Get metadata for a single Figma file by its key.
   * Works on ALL Figma plans (free, starter, professional).
   *
   * @param {string} fileKey - Figma file key
   * @returns {Promise<{key: string, name: string, lastModified: string, lastModifiedMs: number}|null>}
   */
  async getFileMetadata(fileKey) {
    const token = await this.getStoredToken();
    if (!token || !fetch) return null;

    try {
      // Use the lightweight metadata endpoint (doesn't download full file tree)
      const data = await this._fetchAPI(`/files/${fileKey}/metadata`, token);
      return {
        key: fileKey,
        name: data.name,
        lastModified: data.lastModified,
        lastModifiedMs: new Date(data.lastModified).getTime(),
        thumbnailUrl: data.thumbnailUrl || null,
        projectName: 'Tracked File',
        teamName: 'Manual'
      };
    } catch (metaErr) {
      // Fallback: /files/{key} with minimal depth (metadata endpoint may not exist on older API)
      try {
        const data = await this._fetchAPI(`/files/${fileKey}?depth=1`, token);
        return {
          key: fileKey,
          name: data.name,
          lastModified: data.lastModified,
          lastModifiedMs: new Date(data.lastModified).getTime(),
          thumbnailUrl: data.thumbnailUrl || null,
          projectName: 'Tracked File',
          teamName: 'Manual'
        };
      } catch (e) {
        console.error(`[crate][figma] getFileMetadata error for ${fileKey}:`, e.message);
        return null;
      }
    }
  }

  /**
   * Discover Figma files the user has access to.
   *
   * Two modes:
   *   1. Team-based discovery (requires Professional+ plan): provide teamIds
   *   2. Direct file tracking (works on ALL plans): provide fileKeys
   *
   * NOTE: The Figma /v1/me endpoint does NOT return team_id.
   * There is no API to list a user's files without a team_id.
   * Team IDs must be provided by the user from their Figma team URL.
   *
   * @param {Object} options
   * @param {number} [options.sinceMs] - Only include files modified after this timestamp (ms)
   * @param {number} [options.maxAgeDays=7] - If sinceMs not provided, look back this many days
   * @param {string[]} [options.teamIds=[]] - Team IDs to scan (Professional+ plan required)
   * @param {string[]} [options.fileKeys=[]] - Individual file keys to check (works on ALL plans)
   * @returns {Promise<Array<{key: string, name: string, lastModified: string, projectName: string, teamName: string}>>}
   */
  async discoverRecentFiles(options = {}) {
    const token = await this.getStoredToken();
    if (!token || !fetch) return { recentFiles: [], errors: ['No token or fetch available'] };

    const sinceMs = options.sinceMs || (Date.now() - (options.maxAgeDays || 7) * 24 * 60 * 60 * 1000);
    const teamIds = options.teamIds || [];
    const fileKeys = options.fileKeys || [];
    const recentFiles = [];
    const errors = [];
    const seenKeys = new Set();

    try {
      // --- Method 1: Team-based discovery (Professional+ plan) ---
      for (const teamId of teamIds) {
        let teamName = 'Team';
        try {
          const teamData = await this._fetchAPI(`/teams/${teamId}`, token);
          teamName = teamData.name || teamName;
        } catch (e) {
          const hint = e.message.toLowerCase().includes('not found')
            ? 'Team not found or not accessible via API. If this is a personal workspace, paste a direct Figma file URL instead.'
            : e.message;
          const msg = `Cannot access team ${teamId}: ${hint}`;
          console.warn(`[crate][figma] ${msg}`);
          errors.push(msg);
          continue;
        }

        let projects = [];
        try {
          const projectsData = await this._fetchAPI(`/teams/${teamId}/projects`, token);
          projects = projectsData.projects || [];
        } catch (e) {
          const msg = `Cannot list projects for team ${teamId} (${teamName}): ${e.message}`;
          console.warn(`[crate][figma] ${msg}`);
          errors.push(msg);
          continue;
        }

        for (const project of projects) {
          try {
            const filesData = await this._fetchAPI(`/projects/${project.id}/files`, token);
            const files = filesData.files || [];

            for (const file of files) {
              if (seenKeys.has(file.key)) continue;
              const lastModifiedMs = new Date(file.last_modified).getTime();
              if (lastModifiedMs >= sinceMs) {
                seenKeys.add(file.key);
                recentFiles.push({
                  key: file.key,
                  name: file.name,
                  lastModified: file.last_modified,
                  lastModifiedMs,
                  thumbnailUrl: file.thumbnail_url,
                  projectId: project.id,
                  projectName: project.name,
                  teamId,
                  teamName
                });
              }
            }
          } catch (e) {
            errors.push(`Error listing files in project ${project.name}: ${e.message}`);
          }
        }
      }

      // --- Method 2: Direct file tracking (ALL plans) ---
      for (const fileKey of fileKeys) {
        if (seenKeys.has(fileKey)) continue;
        const meta = await this.getFileMetadata(fileKey);
        if (meta && meta.lastModifiedMs >= sinceMs) {
          seenKeys.add(fileKey);
          recentFiles.push(meta);
        }
      }

      // Sort by most recently modified first
      recentFiles.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);

      return { recentFiles, errors };
    } catch (e) {
      console.error('[crate][figma] discoverRecentFiles error:', e.message);
      errors.push(`discoverRecentFiles failed: ${e.message}`);
      return { recentFiles, errors };
    }
  }

  /**
   * Extract image assets from a Figma file by its key.
   * Returns CDN URLs that can be downloaded.
   *
   * @param {string} fileKey - Figma file key
   * @returns {Promise<Array<{url: string, nodeId: string, name: string}>>}
   */
  async extractAssetsFromFileKey(fileKey) {
    const token = await this.getStoredToken();
    if (!token || !fetch) return { assets: [], errors: ["No token or fetch available"] };

    try {
      // Fetch file structure
      const fileData = await this._fetchAPI(`/files/${fileKey}`, token);

      // Find all exportable nodes
      const imageNodeIds = [];
      const nodeNames = {};
      this._findImageNodes(fileData.document, imageNodeIds, nodeNames);

      if (imageNodeIds.length === 0) return { assets: [], errors: [] };

      const assets = [];
      const errors = [];

      // Request image exports (batch, max 500 per request)
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
                  url,
                  nodeId,
                  name: nodeNames[nodeId] || nodeId,
                  fileKey,
                  source: 'figma-auto'
                });
              }
            }
          }
        } catch (err) {
          errors.push("Batch image export failed for " + fileKey + ": " + err.message);
        }
      }

      return { assets, errors };
    } catch (e) {
      console.error('[crate][figma] extractAssetsFromFileKey error:', e.message);
      return { assets: [], errors: [e.message] };
    }
  }

  /**
   * Full auto-tracking scan: discover recent files and extract assets.
   * This is the main entry point for the auto-tracking feature.
   *
   * @param {Object} options
   * @param {number} [options.sinceMs] - Only scan files modified after this timestamp
   * @param {number} [options.maxAgeDays=7] - Fallback: look back this many days
   * @param {number} [options.maxFiles=20] - Maximum number of files to process
   * @param {string[]} [options.teamIds=[]] - Team IDs for discovery (Professional+ plan)
   * @param {string[]} [options.fileKeys=[]] - Direct file keys to track (ALL plans)
   * @returns {Promise<{files: Array, assets: Array, errors: Array}>}
   */
  async autoTrackScan(options = {}) {
    const result = { files: [], assets: [], errors: [] };

    // Verify token first
    const tokenStatus = await this.verifyToken();
    if (!tokenStatus.valid) {
      result.errors.push({ type: 'auth', message: 'Figma token invalid or not set' });
      return result;
    }

    const teamIds = options.teamIds || [];
    const fileKeys = options.fileKeys || [];

    if (teamIds.length === 0 && fileKeys.length === 0) {
      result.errors.push({ type: 'config', message: 'No Figma team IDs or file URLs configured — add files in Settings → Figma' });
      return result;
    }

    // Discover recent files
    const discovery = await this.discoverRecentFiles({
      sinceMs: options.sinceMs,
      maxAgeDays: options.maxAgeDays || 7,
      teamIds,
      fileKeys
    });

    // Handle both old array format and new {recentFiles, errors} format
    const files = Array.isArray(discovery) ? discovery : (discovery.recentFiles || []);
    if (discovery.errors && discovery.errors.length > 0) {
      result.errors.push(...discovery.errors);
    }

    result.files = files.slice(0, options.maxFiles || 20);

    // Extract assets from each file
    for (const file of result.files) {
      try {
        const extractResult = await this.extractAssetsFromFileKey(file.key);
        if (extractResult.errors && extractResult.errors.length > 0) { result.errors.push(...extractResult.errors); }
        for (const asset of extractResult.assets) {
          asset.figmaFileName = file.name;
          asset.figmaFileKey = file.key;
          result.assets.push(asset);
        }
      } catch (e) {
        result.errors.push(`Error extracting from ${file.name}: ${e.message}`);
      }
    }

    return result;
  }
}

module.exports = { FigmaParser };
