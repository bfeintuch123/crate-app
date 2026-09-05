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
  return { psd, sourceIdentity: getSourceIdentity(stat), sourceDigest };
}

const CHUNK_BYTES = 1024 * 1024;
const TEXT_UNITS = 16384;

async function sendPsdRecords(parsed, send) {
  const { psd, sourceIdentity, sourceDigest } = parsed;
  await send({ type: 'begin', sourceIdentity, sourceDigest });
  let entryCount = 0;
  let embeddedCount = 0;
  async function record(kind, text, data, index) {
    await send({ type: 'record', kind, index, textUnits: text.length, byteLength: data ? data.byteLength : 0 });
    for (let offset = 0; offset < text.length; offset += TEXT_UNITS) {
      await send({ type: 'text', text: text.slice(offset, offset + TEXT_UNITS) });
    }
    for (let offset = 0; data && offset < data.byteLength; offset += CHUNK_BYTES) {
      // ag-psd commonly returns a view of the entire source allocation. Electron
      // clones its backing store: a subarray here would send that whole source.
      let bytes = new Uint8Array(Math.min(CHUNK_BYTES, data.byteLength - offset));
      bytes.set(data.subarray(offset, offset + bytes.length));
      const acknowledgement = send({ type: 'chunk', offset, bytes });
      bytes = null;
      await acknowledgement;
    }
    await send({ type: 'record-end' });
  }
  async function walkLayers(layers) {
    for (const layer of layers || []) {
      if (typeof layer.linkedFile?.fullPath === 'string') {
        await record('linked-path', layer.linkedFile.fullPath, null, entryCount++);
      }
      await walkLayers(layer.children);
    }
  }
  await walkLayers(psd.children);
  for (const file of psd.linkedFiles || []) {
    if (typeof file?.linkedFile?.fullPath === 'string') {
      await record('linked-path', file.linkedFile.fullPath, null, entryCount++);
    }
  }
  for (const file of psd.linkedFiles || []) {
    if (!file?.data) continue;
    await record('embedded', typeof file.name === 'string' ? file.name : '', file.data, embeddedCount++);
    file.data = null;
  }
  await send({ type: 'result', entryCount, embeddedCount, sourceIdentity, sourceDigest });
}

function startAddFilesPsdWorker(port = getParentPort(), options = {}) {
  if (!port || typeof port.on !== 'function' || typeof port.postMessage !== 'function') {
    throw new Error('Add Files PSD worker requires a parent port');
  }
  const exit = typeof options.exit === 'function' ? options.exit : code => process.exit(code);
  let started = false;
  let finished = false;
  let sessionId;
  let seq = 0;
  let pending = null;
  const fail = () => {
    if (finished) return;
    finished = true;
    const waiting = pending;
    pending = null;
    waiting?.reject(new Error('asset_baseline_psd_worker_failed'));
    try { port.postMessage({ type: 'error', sessionId, error: 'asset_baseline_psd_worker_failed' }); } catch (_) {}
    setImmediate(() => exit(0));
  };
  // Serialize synchronously and retain only the ACK resolver, never the message.
  const send = payload => new Promise((resolve, reject) => {
    if (finished || pending || !Number.isSafeInteger(seq)) return reject(new Error('asset_baseline_psd_worker_failed'));
    const currentSeq = seq++;
    pending = { seq: currentSeq, resolve, reject };
    try { port.postMessage({ ...payload, sessionId, seq: currentSeq }); }
    catch (_) { fail(); }
  });
  port.on('message', event => {
    const message = event && Object.prototype.hasOwnProperty.call(event, 'data') ? event.data : event;
    if (finished || !message) return;
    if (started) {
      if (message.sessionId !== sessionId) return;
      if (message.type !== 'ack' || !pending || message.seq !== pending.seq) return fail();
      const waiting = pending;
      pending = null;
      waiting.resolve();
      return;
    }
    if (message.type !== 'parse' || typeof message.filePath !== 'string' || typeof message.sessionId !== 'string') return fail();
    started = true;
    sessionId = message.sessionId;
    Promise.resolve().then(() => (options.parse || parsePsd)(message.filePath))
      .then(parsed => sendPsdRecords(parsed, send))
      .then(() => { finished = true; setImmediate(() => exit(0)); }, fail);
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
  CHUNK_BYTES,
  TEXT_UNITS,
  sendPsdRecords,
  startAddFilesPsdWorker,
};
