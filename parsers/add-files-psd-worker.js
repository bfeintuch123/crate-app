'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { readPsd } = require('ag-psd');

const MAX_PARSE_FILE_SIZE = 300 * 1024 * 1024;
const port = process.parentPort;

function parsePsd(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('asset_baseline_source_not_file');
  if (stat.size > MAX_PARSE_FILE_SIZE) throw new Error('asset_baseline_source_too_large');

  const sourceBuffer = fs.readFileSync(filePath);
  const sourceDigest = crypto.createHash('sha256').update(sourceBuffer).digest('hex');
  const psd = readPsd(sourceBuffer, {
    skipLayerImageData: true,
    skipCompositeImageData: true,
  });
  const entries = [];
  const walkLayers = layers => {
    for (const layer of layers || []) {
      if (layer.linkedFile && typeof layer.linkedFile.fullPath === 'string') {
        entries.push({ filePath: layer.linkedFile.fullPath, source: 'psd-linked' });
      }
      walkLayers(layer.children);
    }
  };
  walkLayers(psd.children);

  const embedded = (psd.linkedFiles || [])
    .filter(file => file && file.data)
    .map(file => ({
      name: typeof file.name === 'string' ? file.name : '',
      data: Buffer.from(file.data).toString('base64'),
    }));
  return { entries, embedded, sourceDigest };
}

if (!port || typeof port.on !== 'function' || typeof port.postMessage !== 'function') {
  throw new Error('Add Files PSD worker requires a parent port');
}

port.on('message', event => {
  const message = event && Object.prototype.hasOwnProperty.call(event, 'data') ? event.data : event;
  if (!message || message.type !== 'parse' || typeof message.filePath !== 'string') return;
  try {
    port.postMessage({ type: 'result', result: parsePsd(message.filePath) });
  } catch (error) {
    port.postMessage({
      type: 'error',
      error: error && typeof error.message === 'string' ? error.message : 'asset_baseline_psd_worker_failed',
    });
  }
  setImmediate(() => process.exit(0));
});
