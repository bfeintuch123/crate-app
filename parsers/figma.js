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

function figmaParserText(value) {
  if (value instanceof Error) return value.message || '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (e) {
    return String(value);
  }
}

function redactFigmaParserText(value) {
  return figmaParserText(value)
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted-url]')
    .replace(/\b(?:Authorization|X-Figma-Token)\b\s*[:=]?\s*(?:Bearer\s+)?[^\s,;)]+/gi, '[redacted-credential]')
    .replace(/\b(?:Cookie|Set-Cookie)\b\s*[:=]?\s*[^\s,;)]+/gi, '[redacted-credential]')
    .replace(/\bBearer\s+[^\s,;)]+/gi, '[redacted-credential]')
    .replace(/\b(?:token|access_token|auth|sig|signature|client_secret|secret|key|cookie)\b\s*[:=]\s*[^\s,;)]+/gi, '[redacted-credential]')
    .replace(/[A-Za-z0-9._-]*(?:token|secret|authorization|bearer|cookie|auth)[A-Za-z0-9._-]*/gi, '[redacted-sensitive]')
    .replace(/\b\d+:\d+\b/g, '[redacted-figma-scope-id]')
    .replace(/(?:\/Users|\/Volumes|\/private\/var|\/var|\/tmp)\/[^\s"'<>),]+/g, '[redacted-path]');
}

function formatFigmaParserScalar(value, fallback = 'unknown') {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const redacted = redactFigmaParserText(value.trim());
  if (redacted.includes('[redacted')) return fallback;
  const safe = redacted.replace(/[^\w:.-]/g, '_').slice(0, 120);
  return safe || fallback;
}

function redactFigmaParserIssue(value) {
  if (value && typeof value === 'object' && !(value instanceof Error)) {
    return {
      ...value,
      ...(value.message != null ? { message: redactFigmaParserText(value.message) } : {}),
      ...(value.error != null ? { error: redactFigmaParserText(value.error) } : {}),
      ...(value.warning != null ? { warning: redactFigmaParserText(value.warning) } : {})
    };
  }
  return redactFigmaParserText(value);
}

function redactFigmaParserIssues(values) {
  return (Array.isArray(values) ? values : [values])
    .filter(value => value !== undefined && value !== null)
    .map(redactFigmaParserIssue);
}

function figmaEndpointCategory(endpoint) {
  const pathOnly = String(endpoint || '').split('?')[0];
  if (pathOnly === '/me') return 'user profile';
  if (/^\/files\/[^/]+\/metadata$/.test(pathOnly)) return 'file metadata';
  if (/^\/files\/[^/]+\/images$/.test(pathOnly)) return 'file images';
  if (/^\/files\/[^/]+$/.test(pathOnly)) return 'file';
  if (/^\/images\/[^/]+$/.test(pathOnly)) return 'rendered images';
  if (/^\/teams\/[^/]+\/projects$/.test(pathOnly)) return 'team projects';
  if (/^\/teams\/[^/]+$/.test(pathOnly)) return 'team';
  if (/^\/projects\/[^/]+\/files$/.test(pathOnly)) return 'project files';
  return 'request';
}

function figmaApiFailureMessage(endpoint, status = null, detail = null) {
  const parts = [figmaEndpointCategory(endpoint)];
  if (Number.isInteger(status)) parts.push(`status ${status}`);
  if (detail) parts.push(redactFigmaParserText(detail));
  return `Figma API request failed (${parts.join(', ')})`;
}

function safeFigmaParserError(message) {
  const error = new Error(message);
  error._crateFigmaParserSafe = true;
  return error;
}

const FIGMA_SCOPE_REASONS = Object.freeze({
  NO_PAGE_OR_NODE: 'figma-current-page-no-page-or-node-param',
  REQUESTED_PAGE_NOT_FOUND: 'figma-current-page-requested-page-not-found',
  REQUESTED_NODE_NOT_FOUND: 'figma-current-page-requested-node-not-found',
  FILE_FETCH_FAILED: 'figma-current-page-file-fetch-failed',
  ZERO_IMAGE_REFS: 'figma-current-page-zero-image-refs'
});
const FIGMA_CANONICAL_FILE_KEY_PARAM_NAMES = ['file-key', 'fileKey', 'file_key'];
const FIGMA_AMBIGUOUS_FILE_ID_PARAM_NAMES = ['file-id', 'fileId', 'file_id'];
const FIGMA_NESTED_URL_PARAM_NAMES = [
  'url',
  'href',
  'link',
  'u',
  'redirect',
  'redirectUrl',
  'redirect_url',
  'target',
  'targetUrl',
  'target_url',
  'fileUrl',
  'file_url',
  'file-url',
  'openUrl',
  'open_url',
  'deepLink',
  'deep_link',
  'deeplink'
];

function currentPageScopeWarning(statusReason) {
  switch (statusReason) {
    case FIGMA_SCOPE_REASONS.NO_PAGE_OR_NODE:
      return 'Current Page Only could not find a page or node in the tracked Figma URL. No Figma assets will be captured for this file in this session.';
    case FIGMA_SCOPE_REASONS.REQUESTED_PAGE_NOT_FOUND:
      return 'Current Page Only could not find the requested page in the tracked Figma file. No Figma assets will be captured for this file in this session.';
    case FIGMA_SCOPE_REASONS.REQUESTED_NODE_NOT_FOUND:
      return 'Current Page Only could not find the requested node in the tracked Figma file. No Figma assets will be captured for this file in this session.';
    case FIGMA_SCOPE_REASONS.FILE_FETCH_FAILED:
      return 'Current Page Only could not read the tracked Figma file. No Figma assets will be captured for this file in this session.';
    case FIGMA_SCOPE_REASONS.ZERO_IMAGE_REFS:
      return 'Current Page Only resolved the page, but Crate found no exportable image assets on that page.';
    default:
      return null;
  }
}

function incrementCount(target, key) {
  const safeKey = formatFigmaParserScalar(key || 'unknown', 'unknown');
  target[safeKey] = (target[safeKey] || 0) + 1;
}

function summarizeFigmaCandidateDiagnostics({
  fileKeys = [],
  scopeEntries = [],
  metadataDiagnostics = [],
  extractionDiagnostics = []
} = {}) {
  const uniqueCandidateCount = new Set(
    (Array.isArray(fileKeys) ? fileKeys : [])
      .filter(key => typeof key === 'string' && key.trim())
      .map(key => key.trim())
  ).size;

  const summary = {
    candidateCount: uniqueCandidateCount,
    candidateStrategyCounts: {},
    parsedScopeCounts: {
      withPageOrNode: 0,
      withoutPageOrNode: 0
    },
    metadataStatusCounts: {},
    fileFetchStatusCounts: {},
    lockStatusCounts: {},
    statusReasonCounts: {},
    assetResultCounts: {
      withAssets: 0,
      withoutAssets: 0
    }
  };

  for (const entry of Array.isArray(scopeEntries) ? scopeEntries : []) {
    incrementCount(summary.candidateStrategyCounts, entry && entry.isCandidateFallback ? 'fallback' : 'primary');
    if (entry && (entry.requestedPageId || entry.requestedNodeId)) {
      summary.parsedScopeCounts.withPageOrNode += 1;
    } else {
      summary.parsedScopeCounts.withoutPageOrNode += 1;
    }
  }

  for (const diagnostic of Array.isArray(metadataDiagnostics) ? metadataDiagnostics : []) {
    incrementCount(summary.metadataStatusCounts, diagnostic && diagnostic.metadataStatus);
  }

  for (const diagnostic of Array.isArray(extractionDiagnostics) ? extractionDiagnostics : []) {
    incrementCount(summary.fileFetchStatusCounts, diagnostic && diagnostic.fileFetchStatus);
    incrementCount(summary.lockStatusCounts, diagnostic && diagnostic.lockStatus);
    incrementCount(summary.statusReasonCounts, diagnostic && diagnostic.statusReason ? diagnostic.statusReason : 'none');
    if (diagnostic && diagnostic.assetCount > 0) summary.assetResultCounts.withAssets += 1;
    else summary.assetResultCounts.withoutAssets += 1;
  }

  return summary;
}

class FigmaParser extends BaseParser {
  /**
   * Figma-specific dedupe.
   * Base parser dedupe is path-based, but Figma assets are URL/imageRef objects.
   *
   * Priority:
   *   1) imageRef
   *   2) url
   *   3) nodeId
   */
  deduplicateFigmaAssets(assets) {
    const seen = new Set();
    return assets.filter((asset) => {
      const key = asset.imageRef || asset.url || asset.nodeId;
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Build a stable per-asset display name and include a short unique salt.
   * This keeps distinct Figma assets from collapsing later when filenames are derived from `asset.name`.
   */
  buildFigmaAssetName(baseName, stableKey) {
    const safeBase = String(baseName || stableKey || 'figma-asset').trim();
    const key = String(stableKey || '').trim();
    if (!key) return safeBase;
    const shortKey = key.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12);
    if (!shortKey) return safeBase;
    return `${safeBase}__${shortKey}`;
  }

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
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      try {
        fs.chmodSync(dir, 0o700);
      } catch (chmodDirError) {
        console.warn(`[crate][figma] could not harden token directory permissions: ${redactFigmaParserText(chmodDirError.message)}`);
      }
      fs.writeFileSync(TOKEN_FILE_PATH, token, { mode: 0o600 });
      fs.chmodSync(TOKEN_FILE_PATH, 0o600);
      return true;
    } catch (e) {
      console.warn(`[crate][figma] could not store token securely: ${redactFigmaParserText(e.message)}`);
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
          throw safeFigmaParserError('Invalid Figma API token. Please check your Personal Access Token.');
        } else if (status === 403) {
          throw safeFigmaParserError('Access denied. You may not have permission to view this Figma file.');
        } else if (status === 404) {
          throw safeFigmaParserError('Figma file not found. Check that the file URL is correct and the file still exists.');
        } else if (status === 429) {
          throw safeFigmaParserError('Rate limit exceeded. Please wait a moment and try again.');
        } else {
          throw safeFigmaParserError(figmaApiFailureMessage(endpoint, status));
        }
      }

      try {
        return await response.json();
      } catch (e) {
        throw safeFigmaParserError(figmaApiFailureMessage(endpoint));
      }
    } catch (e) {
      clearTimeout(timeoutId);
      if (e && e.name === 'AbortError') {
        throw safeFigmaParserError(figmaApiFailureMessage(endpoint, null, 'timed out after 30s'));
      }
      if (e && e._crateFigmaParserSafe) throw e;
      throw safeFigmaParserError(figmaApiFailureMessage(endpoint));
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
   * Recursively collect IMAGE fill refs from the file tree.
   * @private
   */
  _findImageFillRefs(node, imageRefs, refNames) {
    if (!node) return;

    if (Array.isArray(node.fills)) {
      for (const fill of node.fills) {
        if (!fill || fill.type !== 'IMAGE' || !fill.imageRef) continue;
        imageRefs.add(fill.imageRef);
        if (!refNames[fill.imageRef]) {
          refNames[fill.imageRef] = node.name || node.id || fill.imageRef;
        }
      }
    }

    if (node.children) {
      for (const child of node.children) {
        this._findImageFillRefs(child, imageRefs, refNames);
      }
    }
  }

  _isLikelyNodeReference(value) {
    if (typeof value !== 'string' || !value.trim()) return false;
    const normalized = FigmaParser.normalizeNodeId(value);
    return !!normalized && /^\d+:\d+(?::\d+)*$/.test(normalized);
  }

  _addNodeReference(value, nodeIds) {
    if (!this._isLikelyNodeReference(value)) return;
    nodeIds.add(FigmaParser.normalizeNodeId(value));
  }

  _findReferencedNodeIds(node, nodeIds) {
    if (!node) return;

    this._addNodeReference(node.componentId, nodeIds);

    if (node.componentProperties && typeof node.componentProperties === 'object') {
      for (const property of Object.values(node.componentProperties)) {
        if (!property || typeof property !== 'object') continue;
        this._addNodeReference(property.value, nodeIds);
        this._addNodeReference(property.defaultValue, nodeIds);
      }
    }

    if (node.componentPropertyDefinitions && typeof node.componentPropertyDefinitions === 'object') {
      for (const definition of Object.values(node.componentPropertyDefinitions)) {
        if (!definition || typeof definition !== 'object') continue;
        this._addNodeReference(definition.defaultValue, nodeIds);
      }
    }

    if (node.children) {
      for (const child of node.children) {
        this._findReferencedNodeIds(child, nodeIds);
      }
    }
  }

  /**
   * Collect image fills from a scoped page plus local component nodes reachable from it.
   * Preserves Current Page Only while keeping instance/component dependencies intact.
   * @private
   */
  _findScopedImageFillRefs(scopedRoot, document, imageRefs, refNames) {
    this._findImageFillRefs(scopedRoot, imageRefs, refNames);

    const pendingNodeIds = new Set();
    const visitedNodeIds = new Set();
    this._findReferencedNodeIds(scopedRoot, pendingNodeIds);

    while (pendingNodeIds.size > 0) {
      const nodeId = pendingNodeIds.values().next().value;
      pendingNodeIds.delete(nodeId);

      if (visitedNodeIds.has(nodeId)) continue;
      visitedNodeIds.add(nodeId);

      const referencedNode = this._findNodeById(document, nodeId);
      if (!referencedNode) continue;

      this._findImageFillRefs(referencedNode, imageRefs, refNames);

      const nestedNodeIds = new Set();
      this._findReferencedNodeIds(referencedNode, nestedNodeIds);
      for (const nestedNodeId of nestedNodeIds) {
        if (!visitedNodeIds.has(nestedNodeId)) {
          pendingNodeIds.add(nestedNodeId);
        }
      }
    }
  }

  /**
   * Recursively find a node by id.
   * @private
   */
  _findNodeById(node, targetId) {
    if (!node || !targetId) return null;
    if (node.id === targetId) return node;
    if (!Array.isArray(node.children)) return null;

    for (const child of node.children) {
      const match = this._findNodeById(child, targetId);
      if (match) return match;
    }

    return null;
  }

  /**
   * Recursively find the top-level CANVAS page containing the target node.
   * @private
   */
  _findEnclosingPage(node, targetId, currentPage = null) {
    if (!node || !targetId) return null;

    const nextPage = node.type === 'CANVAS' ? node : currentPage;
    if (node.id === targetId) {
      return node.type === 'CANVAS' ? node : nextPage;
    }
    if (!Array.isArray(node.children)) return null;

    for (const child of node.children) {
      const match = this._findEnclosingPage(child, targetId, nextPage);
      if (match) return match;
    }

    return null;
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

  _figmaExtractionResult({ assets = [], errors = [], warnings = [], scope }) {
    const safeScope = scope ? {
      ...scope,
      warning: scope.warning ? redactFigmaParserText(scope.warning) : scope.warning,
      statusReason: scope.statusReason ? formatFigmaParserScalar(scope.statusReason) : null
    } : scope;

    return {
      assets,
      errors: redactFigmaParserIssues(errors),
      warnings: redactFigmaParserIssues(warnings),
      scope: safeScope
    };
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

    const candidates = FigmaParser._figmaFileKeyCandidates(url);
    return candidates.length > 0 ? candidates[0] : null;
  }

  static _normalizeFigmaFileKey(value) {
    if (!value || typeof value !== 'string') return null;

    let key = value.trim();
    try {
      key = decodeURIComponent(key);
    } catch (e) {
      // Keep the raw value when decoding fails.
    }

    key = key.trim();
    return /^[a-zA-Z0-9_-]+$/.test(key) ? key : null;
  }

  static _figmaFileKeyCandidates(url) {
    if (!url || typeof url !== 'string') return [];

    const matches = [];
    let order = 0;
    const matchByKey = new Map();
    const addMatch = (key, priority) => {
      const normalized = FigmaParser._normalizeFigmaFileKey(key);
      if (!normalized) return;
      const existing = matchByKey.get(normalized);
      if (existing) {
        if (priority < existing.priority) existing.priority = priority;
        return;
      }
      const match = { key: normalized, priority, order: order++ };
      matchByKey.set(normalized, match);
      matches.push(match);
    };

    const directRoutePatterns = [
      /(?:https?:\/\/)?(?:www\.|embed\.)?figma\.com\/(?:file|design|board|slides|deck)\/([a-zA-Z0-9_-]+)/i,
      /^figma:\/\/(?:file|design|board|slides|deck)\/([a-zA-Z0-9_-]+)/i
    ];
    const protoRoutePatterns = [
      /(?:https?:\/\/)?(?:www\.|embed\.)?figma\.com\/proto\/([a-zA-Z0-9_-]+)/i,
      /^figma:\/\/proto\/([a-zA-Z0-9_-]+)/i
    ];

    const readFileKeyParams = (params) => {
      for (const name of FIGMA_CANONICAL_FILE_KEY_PARAM_NAMES) {
        addMatch(params.get(name), 1);
      }
      for (const name of FIGMA_AMBIGUOUS_FILE_ID_PARAM_NAMES) {
        addMatch(params.get(name), 3);
      }
    };

    for (const candidate of FigmaParser._figmaUrlCandidates(url)) {
      for (const pattern of directRoutePatterns) {
        const match = candidate.match(pattern);
        if (match) addMatch(match[1], 0);
      }

      try {
        const parsed = new URL(candidate);
        readFileKeyParams(parsed.searchParams);
        if (parsed.hash) {
          const hashText = parsed.hash.replace(/^#/, '').replace(/^\?/, '');
          if (hashText) {
            readFileKeyParams(new URLSearchParams(hashText));
            const hashQueryIndex = hashText.indexOf('?');
            if (hashQueryIndex >= 0) {
              readFileKeyParams(new URLSearchParams(hashText.slice(hashQueryIndex + 1)));
            }
          }
        }
      } catch (e) {
        // Regex fallback below handles malformed desktop handoff strings.
      }

      const fileKeyParamPattern = /[?&#](file-key|fileKey|file_key|file-id|fileId|file_id)=([^&#]+)/gi;
      let paramMatch = null;
      while ((paramMatch = fileKeyParamPattern.exec(candidate)) !== null) {
        const priority = FIGMA_AMBIGUOUS_FILE_ID_PARAM_NAMES.includes(paramMatch[1]) ? 3 : 1;
        addMatch(paramMatch[2], priority);
      }

      for (const pattern of protoRoutePatterns) {
        const match = candidate.match(pattern);
        if (match) addMatch(match[1], 2);
      }
    }

    matches.sort((a, b) => (a.priority - b.priority) || (a.order - b.order));
    return matches.map(match => match.key);
  }

  static _figmaUrlCandidates(url) {
    if (!url || typeof url !== 'string') return [];

    const candidates = [];
    const seen = new Set();
    const queue = [url.trim()];
    const pushCandidate = (value) => {
      if (typeof value !== 'string') return;
      const trimmed = value.trim();
      if (!trimmed || seen.has(trimmed)) return;
      seen.add(trimmed);
      candidates.push(trimmed);
      queue.push(trimmed);
    };

    while (queue.length > 0 && candidates.length < 16) {
      const current = queue.shift();
      if (typeof current !== 'string' || !current.trim()) continue;
      if (!seen.has(current)) {
        seen.add(current);
        candidates.push(current);
      }

      let decoded = current;
      try {
        decoded = decodeURIComponent(current);
      } catch (e) {
        decoded = current;
      }
      if (decoded && decoded !== current) {
        pushCandidate(decoded);
      }

      try {
        const parsed = new URL(current);
        for (const name of FIGMA_NESTED_URL_PARAM_NAMES) {
          const value = parsed.searchParams.get(name);
          if (value && /(?:figma\.com|^figma:\/\/)/i.test(value)) {
            pushCandidate(value);
          }
        }

        if (parsed.hash) {
          const hashText = parsed.hash.replace(/^#/, '').replace(/^\?/, '');
          if (hashText) {
            pushCandidate(hashText);
            const hashParams = new URLSearchParams(hashText);
            for (const name of FIGMA_NESTED_URL_PARAM_NAMES) {
              const value = hashParams.get(name);
              if (value && /(?:figma\.com|^figma:\/\/)/i.test(value)) {
                pushCandidate(value);
              }
            }
          }
        }
      } catch (e) {
        // Keep regex extraction for malformed desktop handoff strings.
      }

      const embeddedMatches = String(decoded).match(/(?:https?:\/\/(?:(?:www|embed)\.)?figma\.com|figma:\/\/)[^\s"'<>]+/gi) || [];
      for (const embedded of embeddedMatches) {
        pushCandidate(embedded);
      }
    }

    return candidates;
  }

  /**
   * Normalize a Figma node/page id from a URL query parameter.
   */
  static normalizeNodeId(value) {
    if (!value || typeof value !== 'string') return null;

    let normalized = value.trim();
    if (!normalized) return null;

    try {
      normalized = decodeURIComponent(normalized);
    } catch (e) {
      // Keep the raw value when decoding fails.
    }

    if (!normalized.includes(':') && /^[0-9]+(?:-[0-9]+)+$/.test(normalized)) {
      normalized = normalized.replace(/-/g, ':');
    }

    return normalized || null;
  }

  /**
   * Parse the page/node lock encoded in a tracked Figma URL snapshot.
   */
  static parseScopeFromTrackedUrl(url) {
    const fileKey = FigmaParser.extractFileKey(url);
    const result = {
      fileKey,
      requestedPageId: null,
      requestedNodeId: null,
    };

    if (!url || typeof url !== 'string') {
      return result;
    }

    const readParam = (params, names) => {
      for (const name of names) {
        const value = params.get(name);
        if (value) return value;
      }
      return null;
    };

    const mergeParams = (params) => {
      if (!result.requestedPageId) {
        result.requestedPageId = FigmaParser.normalizeNodeId(readParam(params, ['page-id', 'pageId', 'page_id']));
      }
      if (!result.requestedNodeId) {
        result.requestedNodeId = FigmaParser.normalizeNodeId(readParam(params, [
          'node-id',
          'nodeId',
          'node_id',
          'starting-point-node-id',
          'startingPointNodeId',
          'starting_point_node_id'
        ]));
      }
    };

    try {
      for (const candidate of FigmaParser._figmaUrlCandidates(url)) {
        const parsed = new URL(candidate);
        mergeParams(parsed.searchParams);
        if (parsed.hash) {
          const hashText = parsed.hash.replace(/^#/, '').replace(/^\?/, '');
          mergeParams(new URLSearchParams(hashText));
          const hashQueryIndex = hashText.indexOf('?');
          if (hashQueryIndex >= 0) {
            mergeParams(new URLSearchParams(hashText.slice(hashQueryIndex + 1)));
          }
        }
        if (result.requestedPageId || result.requestedNodeId) return result;
      }
    } catch (e) {
      // Fall through to regex extraction for malformed or desktop-style links.
    }

    for (const candidate of FigmaParser._figmaUrlCandidates(url)) {
      const pageMatch = candidate.match(/[?&#](?:page-id|pageId|page_id)=([^&#]+)/i);
      const nodeMatch = candidate.match(/[?&#](?:node-id|nodeId|node_id|starting-point-node-id|startingPointNodeId|starting_point_node_id)=([^&#]+)/i);
      result.requestedPageId = result.requestedPageId || FigmaParser.normalizeNodeId(pageMatch ? pageMatch[1] : null);
      result.requestedNodeId = result.requestedNodeId || FigmaParser.normalizeNodeId(nodeMatch ? nodeMatch[1] : null);
      if (result.requestedPageId || result.requestedNodeId) break;
    }
    return result;
  }

  _resolveScopeRoot(document, scopeEntry = null) {
    const scopeMode = scopeEntry && scopeEntry.scopeMode === 'current-page'
      ? 'current-page'
      : 'entire-file';

    const scope = {
      scopeMode,
      lockStatus: scopeMode === 'current-page' ? 'unresolved' : 'entire-file',
      lockedPageId: null,
      lockedPageName: null,
      warning: null,
      statusReason: null,
      rootNode: document,
    };

    if (scopeMode !== 'current-page') {
      return scope;
    }

    const requestedPageId = FigmaParser.normalizeNodeId(scopeEntry && scopeEntry.requestedPageId);
    const requestedNodeId = FigmaParser.normalizeNodeId(scopeEntry && scopeEntry.requestedNodeId);
    const existingWarning = scopeEntry && scopeEntry.warning;

    if (!requestedPageId && !requestedNodeId) {
      scope.statusReason = FIGMA_SCOPE_REASONS.NO_PAGE_OR_NODE;
      scope.warning = existingWarning || currentPageScopeWarning(scope.statusReason);
      return scope;
    }

    let pageNode = null;
    if (requestedPageId) {
      const matchedNode = this._findNodeById(document, requestedPageId);
      if (matchedNode && matchedNode.type === 'CANVAS') {
        pageNode = matchedNode;
      }
    }

    if (!pageNode && requestedNodeId) {
      pageNode = this._findEnclosingPage(document, requestedNodeId);
    }

    if (!pageNode) {
      scope.statusReason = requestedPageId && !requestedNodeId
        ? FIGMA_SCOPE_REASONS.REQUESTED_PAGE_NOT_FOUND
        : FIGMA_SCOPE_REASONS.REQUESTED_NODE_NOT_FOUND;
      scope.warning = existingWarning || currentPageScopeWarning(scope.statusReason);
      return scope;
    }

    scope.lockStatus = 'locked';
    scope.lockedPageId = pageNode.id || null;
    scope.lockedPageName = pageNode.name || null;
    scope.rootNode = pageNode;
    return scope;
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
      return { valid: false, error: redactFigmaParserText(e.message) };
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
        console.error(
          `[crate][figma] getFileMetadata error for ${formatFigmaParserScalar(fileKey)}:`,
          redactFigmaParserText(e.message)
        );
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
    const fileKeys = Array.from(new Set((options.fileKeys || []).filter(key => typeof key === 'string' && key.trim())));
    const recentFiles = [];
    const errors = [];
    const candidateDiagnostics = [];
    const seenKeys = new Set();
    const trackedKeySet = new Set(fileKeys);
    const trackedKeyIndex = new Map(fileKeys.map((key, index) => [key, index]));

    const mergeDiscoverySources = (existingSource, nextSource) => {
      const parts = new Set([
        ...(existingSource ? String(existingSource).split('+') : []),
        ...(nextSource ? String(nextSource).split('+') : [])
      ].filter(Boolean));
      return parts.size > 0 ? Array.from(parts).join('+') : undefined;
    };

    const upsertRecentFile = (fileRecord, { isTracked = false, discoverySource } = {}) => {
      if (!fileRecord || !fileRecord.key) return null;

      const existingIndex = recentFiles.findIndex(file => file.key === fileRecord.key);
      if (existingIndex >= 0) {
        const existing = recentFiles[existingIndex];
        if (!existing.name && fileRecord.name) existing.name = fileRecord.name;
        if (!existing.lastModified && fileRecord.lastModified) existing.lastModified = fileRecord.lastModified;
        if (!Number.isFinite(existing.lastModifiedMs) && Number.isFinite(fileRecord.lastModifiedMs)) {
          existing.lastModifiedMs = fileRecord.lastModifiedMs;
        }
        if (!existing.thumbnailUrl && fileRecord.thumbnailUrl) existing.thumbnailUrl = fileRecord.thumbnailUrl;
        if (!existing.projectId && fileRecord.projectId) existing.projectId = fileRecord.projectId;
        if (!existing.projectName && fileRecord.projectName) existing.projectName = fileRecord.projectName;
        if (!existing.teamId && fileRecord.teamId) existing.teamId = fileRecord.teamId;
        if (!existing.teamName && fileRecord.teamName) existing.teamName = fileRecord.teamName;
        if (existing.trackedIndex == null && fileRecord.trackedIndex != null) existing.trackedIndex = fileRecord.trackedIndex;
        existing.isTracked = existing.isTracked || isTracked;
        existing.discoverySource = mergeDiscoverySources(existing.discoverySource, discoverySource);
        return existing;
      }

      const record = {
        ...fileRecord,
        isTracked,
        discoverySource,
      };
      recentFiles.push(record);
      seenKeys.add(fileRecord.key);
      return record;
    };

    try {
      // --- Method 1: Team-based discovery (Professional+ plan) ---
      for (const teamId of teamIds) {
        let teamName = 'Team';
        try {
          const teamData = await this._fetchAPI(`/teams/${teamId}`, token);
          teamName = teamData.name || teamName;
        } catch (e) {
          const safeMessage = redactFigmaParserText(e.message);
          const hint = figmaParserText(e).toLowerCase().includes('not found')
            ? 'Team not found or not accessible via API. If this is a personal workspace, paste a direct Figma file URL instead.'
            : safeMessage;
          const msg = `Cannot access team ${formatFigmaParserScalar(teamId)}: ${hint}`;
          console.warn(`[crate][figma] ${msg}`);
          errors.push(msg);
          continue;
        }

        let projects = [];
        try {
          const projectsData = await this._fetchAPI(`/teams/${teamId}/projects`, token);
          projects = projectsData.projects || [];
        } catch (e) {
          const msg = `Cannot list projects for team ${formatFigmaParserScalar(teamId)} (${redactFigmaParserText(teamName)}): ${redactFigmaParserText(e.message)}`;
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
                upsertRecentFile({
                  key: file.key,
                  name: file.name,
                  lastModified: file.last_modified,
                  lastModifiedMs,
                  thumbnailUrl: file.thumbnail_url,
                  projectId: project.id,
                  projectName: project.name,
                  teamId,
                  teamName
                }, {
                  isTracked: trackedKeySet.has(file.key),
                  discoverySource: 'team'
                });
              }
            }
          } catch (e) {
            errors.push(`Error listing files in project ${redactFigmaParserText(project.name)}: ${redactFigmaParserText(e.message)}`);
          }
        }
      }

      // --- Method 2: Direct file tracking (ALL plans, authoritative) ---
      for (const [trackedIndex, fileKey] of fileKeys.entries()) {
        const candidateDiagnostic = {
          metadataStatus: 'not-attempted'
        };
        const meta = await this.getFileMetadata(fileKey);
        if (meta) {
          candidateDiagnostic.metadataStatus = 'success';
          candidateDiagnostics.push(candidateDiagnostic);
          upsertRecentFile({
            ...meta,
            trackedIndex
          }, {
            isTracked: true,
            discoverySource: 'tracked'
          });
          console.log(
            `[crate][figma] tracked file ${formatFigmaParserScalar(fileKey)}: lastModifiedMs=${meta.lastModifiedMs} included=yes reason=direct-tracked authoritative`
          );
          continue;
        }

        candidateDiagnostic.metadataStatus = 'failed';
        candidateDiagnostics.push(candidateDiagnostic);
        upsertRecentFile({
          key: fileKey,
          name: `Tracked File ${trackedKeyIndex.get(fileKey) != null ? trackedKeyIndex.get(fileKey) + 1 : ''}`.trim(),
          lastModified: null,
          lastModifiedMs: Number.NEGATIVE_INFINITY,
          thumbnailUrl: null,
          projectName: 'Tracked File',
          teamName: 'Manual',
          trackedIndex
        }, {
          isTracked: true,
          discoverySource: 'tracked'
        });
        errors.push(`Metadata fetch failed for tracked file ${formatFigmaParserScalar(fileKey)}; proceeding to extraction anyway.`);
        console.log(
          `[crate][figma] tracked file ${formatFigmaParserScalar(fileKey)}: lastModifiedMs=unknown included=yes reason=metadata unavailable; forcing scan`
        );
      }

      // Sort tracked files first (authoritative), then most-recent non-tracked files.
      recentFiles.sort((a, b) => {
        if (!!a.isTracked !== !!b.isTracked) return a.isTracked ? -1 : 1;
        if (a.isTracked && b.isTracked) {
          return (a.trackedIndex ?? Number.MAX_SAFE_INTEGER) - (b.trackedIndex ?? Number.MAX_SAFE_INTEGER);
        }
        const aLastModified = Number.isFinite(a.lastModifiedMs) ? a.lastModifiedMs : Number.NEGATIVE_INFINITY;
        const bLastModified = Number.isFinite(b.lastModifiedMs) ? b.lastModifiedMs : Number.NEGATIVE_INFINITY;
        return bLastModified - aLastModified;
      });

      return { recentFiles, errors: redactFigmaParserIssues(errors), candidateDiagnostics };
    } catch (e) {
      console.error('[crate][figma] discoverRecentFiles error:', redactFigmaParserText(e.message));
      errors.push(`discoverRecentFiles failed: ${redactFigmaParserText(e.message)}`);
      return { recentFiles, errors: redactFigmaParserIssues(errors), candidateDiagnostics };
    }
  }

  /**
   * Extract image assets from a Figma file by its key.
   * Returns CDN URLs that can be downloaded.
   *
   * @param {string} fileKey - Figma file key
   * @returns {Promise<Array<{url: string, nodeId: string, name: string}>>}
   */
  async extractAssetsFromFileKey(fileKey, scopeEntry = null) {
    const token = await this.getStoredToken();
    if (!token || !fetch) {
      return this._figmaExtractionResult({
        assets: [],
        errors: ["No token or fetch available"],
        warnings: [],
        scope: {
          scopeMode: scopeEntry && scopeEntry.scopeMode === 'current-page' ? 'current-page' : 'entire-file',
          lockStatus: 'unresolved',
          lockedPageId: null,
          lockedPageName: null,
          statusReason: scopeEntry && scopeEntry.scopeMode === 'current-page' ? FIGMA_SCOPE_REASONS.FILE_FETCH_FAILED : null,
          warning: null,
          fileFetchStatus: 'not-attempted'
        }
      });
    }

    try {
      // Fetch file structure
      const fileData = await this._fetchAPI(`/files/${fileKey}`, token);

      const assets = [];
      const errors = [];
      const warnings = [];
      const scope = this._resolveScopeRoot(fileData.document, scopeEntry);
      const scopedRoot = scope.rootNode || fileData.document;

      if (scope.warning) {
        warnings.push(redactFigmaParserText(scope.warning));
      }
      if (scope.scopeMode === 'current-page' && scope.lockStatus !== 'locked') {
        return this._figmaExtractionResult({
          assets: [],
          errors,
          warnings,
          scope: {
            scopeMode: scope.scopeMode,
            lockStatus: scope.lockStatus,
            lockedPageId: scope.lockedPageId,
            lockedPageName: scope.lockedPageName,
            statusReason: scope.statusReason,
            warning: scope.warning,
            fileFetchStatus: 'success'
          }
        });
      }

      // Primary path: recover original placed image-fill assets via imageRef mapping
      const imageRefs = new Set();
      const refNames = {};
      if (scope.scopeMode === 'current-page') {
        this._findScopedImageFillRefs(scopedRoot, fileData.document, imageRefs, refNames);
      } else {
        this._findImageFillRefs(scopedRoot, imageRefs, refNames);
      }
      const imageRefList = Array.from(imageRefs);
      console.log(
        `[crate][figma] extractAssetsFromFileKey ${formatFigmaParserScalar(fileKey)}: imageRefs found (${imageRefList.length})` +
        `${imageRefList.length > 0 ? `: ${imageRefList.map(ref => formatFigmaParserScalar(ref)).join(', ')}` : ''}`
      );

      if (imageRefs.size > 0) {
        try {
          const imageMapData = await this._fetchAPI(`/files/${fileKey}/images`, token);
          const imageMap = (imageMapData && imageMapData.meta && imageMapData.meta.images)
            || imageMapData.images
            || {};

          const resolvedImageRefs = [];
          for (const imageRef of imageRefs) {
            const url = imageMap[imageRef];
            if (!url) continue;
            let inferredFormat = null;
            try {
              const pathname = new URL(url).pathname || '';
              const match = pathname.toLowerCase().match(/\.([a-z0-9]{2,5})$/);
              if (match) inferredFormat = match[1];
            } catch (e) {
              const bareUrl = String(url).split('?')[0].toLowerCase();
              const match = bareUrl.match(/\.([a-z0-9]{2,5})$/);
              if (match) inferredFormat = match[1];
            }
            resolvedImageRefs.push(imageRef);
            assets.push({
              url,
              nodeId: imageRef,
              name: this.buildFigmaAssetName(refNames[imageRef] || imageRef, imageRef),
              imageRef,
              format: inferredFormat,
              fileKey,
              figmaPageId: scope.lockedPageId,
              figmaPageName: scope.lockedPageName,
              source: 'figma-auto'
            });
          }
          console.log(
            `[crate][figma] extractAssetsFromFileKey ${formatFigmaParserScalar(fileKey)}: image URLs resolved (${resolvedImageRefs.length})` +
            `${resolvedImageRefs.length > 0 ? ` for imageRefs: ${resolvedImageRefs.map(ref => formatFigmaParserScalar(ref)).join(', ')}` : ''}`
          );
        } catch (err) {
          errors.push(`Image-fill recovery failed for ${formatFigmaParserScalar(fileKey)}: ${redactFigmaParserText(err.message)}`);
        }
      }

      if (assets.length > 0) {
        const dedupedAssets = this.deduplicateFigmaAssets(assets);
        console.log(
          `[crate][figma] extractAssetsFromFileKey ${formatFigmaParserScalar(fileKey)}: image-fill pipeline counts ` +
          `resolved=${assets.length} deduped=${dedupedAssets.length} passed_to_ingestion=${dedupedAssets.length}`
        );
        console.log(`[crate][figma] extractAssetsFromFileKey ${formatFigmaParserScalar(fileKey)}: fallback rendered-node path used=no`);
        return this._figmaExtractionResult({
          assets: dedupedAssets,
          errors,
          warnings,
          scope: {
            scopeMode: scope.scopeMode,
            lockStatus: scope.lockStatus,
            lockedPageId: scope.lockedPageId,
            lockedPageName: scope.lockedPageName,
            statusReason: scope.statusReason,
            warning: scope.warning,
            fileFetchStatus: 'success'
          }
        });
      }

      // Fallback path: node render exports (legacy behavior)
      const imageNodeIds = [];
      const nodeNames = {};
      this._findImageNodes(scopedRoot, imageNodeIds, nodeNames);
      if (imageNodeIds.length === 0) {
        if (scope.scopeMode === 'current-page') {
          scope.statusReason = FIGMA_SCOPE_REASONS.ZERO_IMAGE_REFS;
          scope.warning = scope.warning || currentPageScopeWarning(scope.statusReason);
          warnings.push(redactFigmaParserText(scope.warning));
        }
        return this._figmaExtractionResult({
          assets: [],
          errors,
          warnings,
          scope: {
            scopeMode: scope.scopeMode,
            lockStatus: scope.lockStatus,
            lockedPageId: scope.lockedPageId,
            lockedPageName: scope.lockedPageName,
            statusReason: scope.statusReason,
            warning: scope.warning,
            fileFetchStatus: 'success'
          }
        });
      }

      console.log(`[crate][figma] extractAssetsFromFileKey ${formatFigmaParserScalar(fileKey)}: fallback rendered-node path used=yes`);

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
                  name: this.buildFigmaAssetName(nodeNames[nodeId] || nodeId, nodeId),
                  format: 'png',
                  fileKey,
                  figmaPageId: scope.lockedPageId,
                  figmaPageName: scope.lockedPageName,
                  source: 'figma-auto'
                });
              }
            }
          }
        } catch (err) {
          errors.push(`Batch image export failed for ${formatFigmaParserScalar(fileKey)}: ${redactFigmaParserText(err.message)}`);
        }
      }

      const dedupedFallbackAssets = this.deduplicateFigmaAssets(assets);
      console.log(
        `[crate][figma] extractAssetsFromFileKey ${formatFigmaParserScalar(fileKey)}: fallback pipeline counts ` +
        `resolved=${assets.length} deduped=${dedupedFallbackAssets.length} passed_to_ingestion=${dedupedFallbackAssets.length}`
      );
      return this._figmaExtractionResult({
        assets: dedupedFallbackAssets,
        errors,
        warnings,
        scope: {
          scopeMode: scope.scopeMode,
          lockStatus: scope.lockStatus,
          lockedPageId: scope.lockedPageId,
          lockedPageName: scope.lockedPageName,
          statusReason: scope.statusReason,
          warning: scope.warning,
          fileFetchStatus: 'success'
        }
      });
    } catch (e) {
      console.error('[crate][figma] extractAssetsFromFileKey error:', redactFigmaParserText(e.message));
      const isCurrentPage = scopeEntry && scopeEntry.scopeMode === 'current-page';
      const warning = isCurrentPage ? currentPageScopeWarning(FIGMA_SCOPE_REASONS.FILE_FETCH_FAILED) : null;
      return this._figmaExtractionResult({
        assets: [],
        errors: [redactFigmaParserText(e.message)],
        warnings: warning ? [warning] : [],
        scope: {
          scopeMode: isCurrentPage ? 'current-page' : 'entire-file',
          lockStatus: 'unresolved',
          lockedPageId: null,
          lockedPageName: null,
          statusReason: isCurrentPage ? FIGMA_SCOPE_REASONS.FILE_FETCH_FAILED : null,
          warning,
          fileFetchStatus: 'failed'
        }
      });
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
    const result = { files: [], assets: [], errors: [], warnings: [], scopeEntries: [], candidateDiagnostics: null };

    // Verify token first
    const tokenStatus = await this.verifyToken();
    if (!tokenStatus.valid) {
      result.errors.push({ type: 'auth', message: 'Figma token invalid or not set' });
      return result;
    }

    const teamIds = options.teamIds || [];
    const fileKeys = options.fileKeys || [];
    const scopeEntries = Array.isArray(options.scopeEntries) ? options.scopeEntries : [];
    const scopeEntriesByKey = new Map(
      scopeEntries
        .filter(entry => entry && typeof entry.key === 'string' && entry.key.trim())
        .map(entry => [entry.key.trim(), entry])
    );

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
    const metadataDiagnostics = Array.isArray(discovery && discovery.candidateDiagnostics)
      ? discovery.candidateDiagnostics
      : [];
    const extractionDiagnostics = [];
    if (discovery.errors && discovery.errors.length > 0) {
      result.errors.push(...redactFigmaParserIssues(discovery.errors));
    }

    const trackedFiles = files.filter(file => file.isTracked);
    const nonTrackedFiles = files.filter(file => !file.isTracked);
    const cappedNonTrackedFiles = nonTrackedFiles.slice(0, options.maxFiles || 20);
    result.files = [...trackedFiles, ...cappedNonTrackedFiles];
    console.log(
      `[crate][figma] autoTrackScan final file keys scanned (${result.files.length}): ` +
      `${result.files.map(file => formatFigmaParserScalar(file.key)).join(', ')}`
    );

    // Extract assets from each file
    for (const file of result.files) {
      try {
        const extractResult = await this.extractAssetsFromFileKey(file.key, scopeEntriesByKey.get(file.key) || null);
        if (extractResult.errors && extractResult.errors.length > 0) { result.errors.push(...redactFigmaParserIssues(extractResult.errors)); }
        if (extractResult.warnings && extractResult.warnings.length > 0) { result.warnings.push(...redactFigmaParserIssues(extractResult.warnings)); }
        if (extractResult.scope) {
          extractionDiagnostics.push({
            fileFetchStatus: extractResult.scope.fileFetchStatus || 'unknown',
            lockStatus: extractResult.scope.lockStatus || 'unknown',
            statusReason: extractResult.scope.statusReason || null,
            assetCount: Array.isArray(extractResult.assets) ? extractResult.assets.length : 0
          });
          result.scopeEntries.push({
            fileKey: file.key,
            fileName: file.name,
            scopeMode: extractResult.scope.scopeMode,
            lockStatus: extractResult.scope.lockStatus,
            lockedPageId: extractResult.scope.lockedPageId,
            lockedPageName: extractResult.scope.lockedPageName,
            statusReason: extractResult.scope.statusReason || null,
            warning: extractResult.scope.warning ? redactFigmaParserText(extractResult.scope.warning) : null,
            fileFetchStatus: extractResult.scope.fileFetchStatus || null
          });
        }
        for (const asset of extractResult.assets) {
          asset.figmaFileName = file.name;
          asset.figmaFileKey = file.key;
          result.assets.push(asset);
        }
      } catch (e) {
        result.errors.push(`Error extracting from ${redactFigmaParserText(file.name)}: ${redactFigmaParserText(e.message)}`);
      }
    }

    result.candidateDiagnostics = summarizeFigmaCandidateDiagnostics({
      fileKeys,
      scopeEntries,
      metadataDiagnostics,
      extractionDiagnostics
    });
    result.errors = redactFigmaParserIssues(result.errors);
    result.warnings = redactFigmaParserIssues(result.warnings);
    return result;
  }
}

module.exports = { FigmaParser };
