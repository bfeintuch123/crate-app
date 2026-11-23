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
const { decodeXMLPath, normalizePsdExternalPath } = require('./xml-path');

// Exact supported link extensions for Quick Package Illustrator extraction.
// Matches base Quick Package AI policy (including .psb) while deliberately
// excluding web-font (.woff2/.woff), installable-font, and video extensions so
// web-font copy policy is never broadened silently.
const QUICK_AI_SUPPORTED_EXTENSIONS = Object.freeze([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'pdf', 'eps', 'ai',
  'psd', 'psb', 'tiff', 'tif', 'afdesign', 'afphoto', 'afpub',
  'indd', 'idml', 'sketch', 'fig',
]);
const QUICK_AI_SUPPORTED_EXT_SET = new Set(QUICK_AI_SUPPORTED_EXTENSIONS);
const QUICK_AI_MAX_PATH_LENGTH = 4096;

function isAsciiAlnumCode(code) {
  return (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a);
}

function isQuickAiDelimiterCode(code) {
  // Exact base 00c5e92 delimiter set: \x00-\x1f, '"', '\'', \x7f, '<', '>', '|', '*', '?'
  return code < 0x20
    || code === 0x22
    || code === 0x27
    || code === 0x7f
    || code === 0x3c
    || code === 0x3e
    || code === 0x7c
    || code === 0x2a
    || code === 0x3f;
}

function matchUsersOrVolumesPrefix(content, index, limit) {
  if (content.charCodeAt(index) !== 0x2f) return 0; // '/'
  if (index + 7 <= limit) {
    const c1 = content.charCodeAt(index + 1);
    const c2 = content.charCodeAt(index + 2);
    const c3 = content.charCodeAt(index + 3);
    const c4 = content.charCodeAt(index + 4);
    const c5 = content.charCodeAt(index + 5);
    if ((c1 === 0x55 || c1 === 0x75)
      && (c2 === 0x73 || c2 === 0x53)
      && (c3 === 0x65 || c3 === 0x45)
      && (c4 === 0x72 || c4 === 0x52)
      && (c5 === 0x73 || c5 === 0x53)
      && content.charCodeAt(index + 6) === 0x2f) {
      return 7;
    }
  }
  if (index + 9 <= limit) {
    const c1 = content.charCodeAt(index + 1);
    const c2 = content.charCodeAt(index + 2);
    const c3 = content.charCodeAt(index + 3);
    const c4 = content.charCodeAt(index + 4);
    const c5 = content.charCodeAt(index + 5);
    const c6 = content.charCodeAt(index + 6);
    const c7 = content.charCodeAt(index + 7);
    if ((c1 === 0x56 || c1 === 0x76)
      && (c2 === 0x6f || c2 === 0x4f)
      && (c3 === 0x6c || c3 === 0x4c)
      && (c4 === 0x75 || c4 === 0x55)
      && (c5 === 0x6d || c5 === 0x4d)
      && (c6 === 0x65 || c6 === 0x45)
      && (c7 === 0x73 || c7 === 0x53)
      && content.charCodeAt(index + 8) === 0x2f) {
      return 9;
    }
  }
  return 0;
}

function isSegmentBoundarySeparator(code) {
  return code === 0x20 || code === 0x09 || code === 0x2c || code === 0x3b
    || code === 0x28 || code === 0x29 || code === 0x5b || code === 0x5d;
}

function isSupportedQuickAiLinkedPath(candidatePath) {
  if (typeof candidatePath !== 'string' || !candidatePath || candidatePath.length > QUICK_AI_MAX_PATH_LENGTH) {
    return false;
  }
  const dot = candidatePath.lastIndexOf('.');
  const slash = candidatePath.lastIndexOf('/');
  if (dot <= slash || dot < 0) return false;
  const ext = candidatePath.slice(dot + 1).toLowerCase();
  return QUICK_AI_SUPPORTED_EXT_SET.has(ext);
}

/**
 * Strictly O(N) single-pass raw path scanner for Quick Package .ai/.ait files.
 * Shares exact delimiters, prefix segmentation, 4096-char ceiling, and
 * last-whole-extension matching with native/crate-helper/PdfAiParser.swift.
 */
function scanQuickAiRawPaths(content, onMatch) {
  const n = content.length;
  let i = 0;
  while (i < n) {
    while (i < n && isQuickAiDelimiterCode(content.charCodeAt(i))) i += 1;
    const runStart = i;
    while (i < n && !isQuickAiDelimiterCode(content.charCodeAt(i))) i += 1;
    const runEnd = i;
    if (runEnd - runStart < 10) continue;

    // Collect /Users/ and /Volumes/ segment starts within this delimiter-free run.
    // Preserve nested /Volumes/<disk>/Users/... paths unless preceded by a separator.
    const segments = [];
    let p = runStart;
    while (p < runEnd - 7) {
      const prefixLen = matchUsersOrVolumesPrefix(content, p, runEnd);
      if (prefixLen === 9) {
        segments.push({ pos: p, prefixLen: 9, isVolumes: true });
        p += 9;
        continue;
      }
      if (prefixLen === 7) {
        const prevSeg = segments.length > 0 ? segments[segments.length - 1] : null;
        const insideVolumes = Boolean(prevSeg && prevSeg.isVolumes);
        const precededBySep = p > runStart && isSegmentBoundarySeparator(content.charCodeAt(p - 1));
        if (!insideVolumes || precededBySep) {
          segments.push({ pos: p, prefixLen: 7, isVolumes: false });
          p += 7;
          continue;
        }
      }
      p += 1;
    }

    for (let s = 0; s < segments.length; s += 1) {
      const segStart = segments[s].pos;
      const prefixLen = segments[s].prefixLen;
      const segEnd = s + 1 < segments.length ? segments[s + 1].pos : runEnd;
      const cappedEnd = Math.min(segEnd, segStart + QUICK_AI_MAX_PATH_LENGTH);
      if (cappedEnd <= segStart + prefixLen) continue;

      // Scan backwards to find the LAST whole supported extension in this segment
      // (preserves base behavior on paths like /Users/sam.ainsworth/.../logo.png
      // and /Users/me/Client.ai files/hero.png while rejecting partial prefixes like .pngx).
      for (let pos = cappedEnd - 1; pos >= segStart + prefixLen; pos -= 1) {
        if (content.charCodeAt(pos) !== 0x2e) continue; // '.'
        const extStart = pos + 1;
        let extEnd = extStart;
        while (extEnd < segEnd && extEnd - extStart <= 9 && isAsciiAlnumCode(content.charCodeAt(extEnd))) {
          extEnd += 1;
        }
        if (extEnd > extStart && extEnd <= cappedEnd && extEnd - extStart <= 8) {
          // Ensure whole ASCII-alnum run was consumed (reject .pngx, .aif, etc.)
          if (extEnd < segEnd && isAsciiAlnumCode(content.charCodeAt(extEnd))) continue;
          const ext = content.slice(extStart, extEnd).toLowerCase();
          if (QUICK_AI_SUPPORTED_EXT_SET.has(ext)) {
            onMatch(content.slice(segStart, extEnd));
            break;
          }
        }
      }
    }
  }
}

/**
 * O(N) XMP / URI attribute extractor matching PdfAiParser.swift's scanXmpAndUris.
 */
function scanQuickAiXmpAndUris(content, onMatch) {
  const markers = [
    { token: 'stRef:filePath>', stop: '<' },
    { token: 'stRef:filePath="', stop: '"' },
    { token: 'LinkResourceURI="', stop: '"' },
  ];
  for (const { token, stop } of markers) {
    let idx = content.indexOf(token);
    while (idx !== -1) {
      const start = idx + token.length;
      const end = content.indexOf(stop, start);
      if (end === -1) break;
      if (end > start && end - start <= QUICK_AI_MAX_PATH_LENGTH) {
        const rawVal = decodeXMLPath(content.slice(start, end)).trim();
        const normalized = normalizePsdExternalPath(rawVal);
        if (normalized
          && (normalized.startsWith('/Users/') || normalized.startsWith('/Volumes/'))
          && isSupportedQuickAiLinkedPath(normalized)) {
          onMatch(normalized);
        }
      }
      idx = content.indexOf(token, end + 1);
    }
  }
}

/**
 * Unified O(N) Quick Package .ai/.ait extractor used by JS fallback (helper OFF)
 * and matching native/crate-helper/PdfAiParser.swift identically on raw bytes.
 */
function extractQuickAiLinkedPaths(content, filePath) {
  const results = [];
  const seen = new Set();
  const record = candidate => {
    if (!candidate || candidate === filePath || candidate.length > QUICK_AI_MAX_PATH_LENGTH) return;
    if (!seen.has(candidate)) {
      seen.add(candidate);
      results.push(candidate);
    }
  };
  scanQuickAiRawPaths(content, record);
  scanQuickAiXmpAndUris(content, record);
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
