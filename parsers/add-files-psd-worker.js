'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { readPsd } = require('ag-psd');

const MAX_PARSE_FILE_SIZE = 300 * 1024 * 1024;

function getParentPort() {
  if (process.parentPort) return process.parentPort;
  if (typeof process.on === 'function' && typeof process.send === 'function') {
    return {
      on(eventName, handler) {
        process.on(eventName, message => handler({ data: message }));
      },
      postMessage(message) {
        process.send(message);
      },
    };
  }
  return null;
}

function getSourceIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

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
  for (const file of psd.linkedFiles || []) {
    if (file?.linkedFile && typeof file.linkedFile.fullPath === 'string') {
      entries.push({ filePath: file.linkedFile.fullPath, source: 'psd-linked' });
    }
  }

  const embedded = (psd.linkedFiles || [])
    .filter(file => file && file.data)
    .map(file => ({
      name: typeof file.name === 'string' ? file.name : '',
      data: Buffer.from(file.data).toString('base64'),
    }));
  return {
    sourceIdentity: getSourceIdentity(stat),
    sourceDigest,
    entries,
    embedded,
  };
}

function startAddFilesPsdWorker(port = getParentPort(), options = {}) {
  if (!port || typeof port.on !== 'function' || typeof port.postMessage !== 'function') {
    throw new Error('Add Files PSD worker requires a parent port');
  }
  const exit = typeof options.exit === 'function' ? options.exit : code => process.exit(code);
  let finished = false;
  port.on('message', event => {
    const message = event && Object.prototype.hasOwnProperty.call(event, 'data') ? event.data : event;
    if (finished || !message || message.type !== 'parse' || typeof message.filePath !== 'string') return;
    finished = true;
    try {
      port.postMessage({ type: 'result', result: parsePsd(message.filePath) });
    } catch (error) {
      port.postMessage({
        type: 'error',
        error: error && typeof error.message === 'string'
          ? error.message
          : 'asset_baseline_psd_worker_failed',
      });
    }
    setImmediate(() => exit(0));
  });
}

if (process.parentPort || (typeof process.send === 'function' && process.argv[1] === __filename)) {
  startAddFilesPsdWorker();
}

module.exports = {
  MAX_PARSE_FILE_SIZE,
  getSourceIdentity,
  getParentPort,
  parsePsd,
  startAddFilesPsdWorker,
};
