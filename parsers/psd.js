/** Structured Photoshop linked-resource inspection for Quick Package. */
'use strict';
const path = require('node:path');
const { BaseParser } = require('./base');
const { sendPsdRecords, inspectPsdLinkFraming } = require('./add-files-psd-worker');
const { readPsd } = require('ag-psd');

class PSDParser extends BaseParser {
  async extractAssets(filePath) {
    // Reuse the bounded saved-file reader and record inventory used by Add Files.
    // Embedded resource records are not exported by this Quick linked-file adapter.
    const assets = [];
    let currentPath = null;
    const bytes = this.readFileBuffer(filePath);
    const psd = readPsd(bytes, { skipLayerImageData: true, skipCompositeImageData: true });
    await sendPsdRecords({ psd, framing: inspectPsdLinkFraming(bytes) }, async record => {
      if (record.type === 'record' && record.kind === 'linked-path') currentPath = '';
      else if (record.type === 'record') currentPath = null;
      if (record.type === 'text' && currentPath !== null) currentPath += record.text;
      if (record.type === 'record-end' && currentPath !== null) {
        if (path.isAbsolute(currentPath) && this.isUserPath(currentPath)) {
          this.appendAsset(assets, { path: currentPath, source: 'psd-smartobject', exists: this.fileExists(currentPath) });
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
