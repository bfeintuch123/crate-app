/** Structured Photoshop linked-resource inspection for Quick Package. */
'use strict';
const path = require('node:path');
const { BaseParser } = require('./base');
const { sendPsdRecords, inspectPsdLinkFraming } = require('./add-files-psd-worker');
const { nativeHelper } = require('./native-helper');
const { normalizePsdExternalPath } = require('./xml-path');
const { readPsd } = require('ag-psd');

class PSDParser extends BaseParser {
  async extractAssets(filePath) {
    // Fast path: seek-based native Swift PSD/PSB metadata reader skips pixel data
    // entirely. Enforce the Quick Package 256 MiB file-size budget both before
    // dispatch and on the helper's own fstat descriptor.
    // When ag-psd's readPsd has been wrapped by a dependency contract spy, fall
    // through to the ag-psd fallback so the spy can audit its options directly.
    if (nativeHelper.isAvailable() && readPsd.name === 'readPsd') {
      const fs = require('node:fs');
      const { ADMISSION_LIMITS, admissionError } = require('./admission-budgets');
      let stat;
      try { stat = fs.lstatSync(filePath); } catch (_) { stat = null; }
      if (stat && (stat.isSymbolicLink() || !stat.isFile() || stat.size > ADMISSION_LIMITS.localParserFileBytes)) {
        throw admissionError('This design file is too large for Crate to inspect safely.');
      }
      try {
        const parsed = await nativeHelper.parsePsd(filePath, {
          maxFileBytes: ADMISSION_LIMITS.localParserFileBytes,
        });
        if (parsed && (parsed.incomplete === true || (Array.isArray(parsed.issues) && parsed.issues.length > 0))) {
          throw new Error('psd_native_incomplete');
        }
        const reportedSize = parsed && parsed.sourceIdentity && parsed.sourceIdentity.size;
        if (typeof reportedSize !== 'number') {
          throw new Error('psd_native_missing_source_identity');
        }
        if (
          !Number.isSafeInteger(reportedSize)
          || reportedSize < 0
          || reportedSize > ADMISSION_LIMITS.localParserFileBytes
        ) {
          throw admissionError('This design file is too large for Crate to inspect safely.');
        }
        const assets = [];
        for (const rawCandidate of [...(parsed.linkedPaths || []), ...(parsed.mediaPaths || [])]) {
          const candidate = normalizePsdExternalPath(rawCandidate);
          if (candidate && path.isAbsolute(candidate) && this.isUserPath(candidate)) {
            this.appendAsset(assets, { path: candidate, source: 'psd-smartobject', exists: this.fileExists(candidate) });
          }
        }
        return this.deduplicateAssets(assets);
      } catch (err) {
        if (err && err.code === 'psd_too_large') {
          throw admissionError('This design file is too large for Crate to inspect safely.');
        }
        if (err && (
          err.code === 'CRATE_PARSER_ADMISSION_LIMIT' ||
          err.code === 'Invalid layer size' ||
          err.code === 'Invalid mask size'
        )) {
          throw err;
        }
        // Fall through to ag-psd metadata reader on any native parser edge case.
      }
    }

    // Reuse the bounded saved-file reader and record inventory used by Add Files.
    // Embedded resource records are not exported by this Quick linked-file adapter.
    const assets = [];
    let currentPath = null;
    const bytes = this.readFileBuffer(filePath);
    // Metadata-only read: no bitmap budget (-Infinity) prevents document pattern decoding.
    const psd = readPsd(bytes, { skipLayerImageData: true, skipCompositeImageData: true, totalMemoryLimit: -Infinity });
    await sendPsdRecords({ psd, framing: inspectPsdLinkFraming(bytes) }, async record => {
      if (record.type === 'record' && record.kind === 'linked-path') currentPath = '';
      else if (record.type === 'record') currentPath = null;
      if (record.type === 'text' && currentPath !== null) currentPath += record.text;
      if (record.type === 'record-end' && currentPath !== null) {
        const normalized = normalizePsdExternalPath(currentPath);
        if (normalized && path.isAbsolute(normalized) && this.isUserPath(normalized)) {
          this.appendAsset(assets, { path: normalized, source: 'psd-smartobject', exists: this.fileExists(normalized) });
        }
        currentPath = null;
      }
    });
    return this.deduplicateAssets(assets);
  }
  static get extensions() { return ['.psd', '.psb']; }
  static get displayName() { return 'Adobe Photoshop'; }
}
module.exports = { PSDParser };
