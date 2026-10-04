'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { readPsd } = require('ag-psd');
const { createReader } = require('ag-psd/dist/psdReader');
const { readVersionAndDescriptor } = require('ag-psd/dist/descriptor');

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
  return { psd, sourceIdentity: getSourceIdentity(stat), sourceDigest,
    framing: inspectPsdLinkFraming(sourceBuffer) };
}

// A bounded section walk, not a second PSD/descriptor parser. This supplies
// wire facts absent from ag-psd's parsed objects. It cannot establish that this
// named smart-object domain contains every reference required by a PSD.
function inspectPsdLinkFraming(buffer) {
  const facts = { domain: 'psd-v1-8bit-link-and-media-descriptors', version: 2,
    status: 'incomplete', records: [], mediaCarriers: [], keys: [], resourceIds: [], issues: [] };
  let offset = 0;
  let blocks = 0;
  let issueCount = 0;
  let recordUnits = 0;
  const layerIds = new Map();
  const issue = reason => {
    if (++issueCount > 128) throw new Error('coverage-limit');
    facts.issues.push(reason);
  };
  function need(bytes, end) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || offset > end || bytes > end - offset) throw new Error('framing-bounds');
  }
  function skip(bytes, end) { need(bytes, end); offset += bytes; }
  function u32(end) { need(4, end); const n = buffer.readUInt32BE(offset); offset += 4; return n; }
  function u16(end) { need(2, end); const n = buffer.readUInt16BE(offset); offset += 2; return n; }
  function signature(end) { need(4, end); const s = buffer.toString('ascii', offset, offset + 4); offset += 4; return s; }
  function section(end) { const size = u32(end); need(size, end); return offset + size; }
  function length64(end) {
    if (u32(end) !== 0) throw new Error('unsupported-large-length');
    return u32(end);
  }
  function unicode(end) {
    const units = u32(end);
    if (units > 16384) throw new Error('coverage-limit');
    skip(units * 2, end);
  }
  function mediaDescriptor(end, carrier, carrierIndex, layerIndex) {
    if (facts.mediaCarriers.length >= 128) throw new Error('coverage-limit');
    const item = { carrier, carrierIndex, layerIndex, layerId: null, status: 'unresolved', version: null,
      pixelSourceType: null, rawPixelSourceType: null, tailBytes: null, references: [], reason: null,
      payloadDigest: crypto.createHash('sha256').update(buffer.subarray(offset, end)).digest('hex') };
    facts.mediaCarriers.push(item);
    try {
      const reader = createReader(buffer.buffer, buffer.byteOffset + offset, Math.min(65536, end - offset));
      const desc = readVersionAndDescriptor(reader, true);
      item.tailBytes = end - offset - reader.offset;
      item.version = typeof (carrier === '1075' ? desc.Vrsn : desc.descVersion) === 'number'
        ? (carrier === '1075' ? desc.Vrsn : desc.descVersion) : null;
      if (item.tailBytes) issue('unexplained-media-tail');
      if (item.version !== 1) issue('unsupported-media-descriptor-version');
      function reference(frameReader, association) {
        if (item.references.length >= 128) throw new Error('coverage-limit');
        const raw = frameReader === undefined ? null : copyPsdMetadata(frameReader);
        const type = frameReader?.frameReaderType;
        const link = frameReader?.['Lnk '];
        const knownVideo = carrier === 'PxSc' && item.pixelSourceType === 1986285651 && type === 1364477522;
        const reason = !frameReader || typeof frameReader !== 'object' || Array.isArray(frameReader)
          || frameReader.descVersion !== 1 || !link || typeof link !== 'object' || Array.isArray(link)
          || link.descVersion !== (carrier === '1075' ? 1 : 2)
          ? 'unsupported-media-reference-shape'
          : (carrier === '1075' ? 'unverified-timeline-frame-reader-type' : (knownVideo ? null : 'unsupported-video-reader-type'));
        item.references.push({ ...association, frameReader: raw, reason });
        if (recordUnits + JSON.stringify(item).length > 32768) throw new Error('coverage-limit');
        if (reason) issue(reason);
      }
      if (carrier === '1075') {
        const groups = desc.audioClipGroupList?.audioClipGroupList;
        if (groups !== undefined && !Array.isArray(groups)) throw new Error('unsupported-media-group-shape');
        if ((groups || []).length > 128) throw new Error('coverage-limit');
        for (const [groupIndex, group] of (groups || []).entries()) {
          if (!group || !Array.isArray(group.audioClipList)) throw new Error('unsupported-media-clip-shape');
          if (group.audioClipList.length > 128) throw new Error('coverage-limit');
          for (const [clipIndex, clip] of group.audioClipList.entries()) {
            if (!clip || typeof clip !== 'object') throw new Error('unsupported-media-clip-shape');
            reference(clip.frameReader, { groupIndex, clipIndex,
              groupId: group.groupID ?? null, clipId: clip.clipID ?? null });
          }
        }
      } else {
        item.rawPixelSourceType = desc.pixelSourceType === undefined ? null : copyPsdMetadata(desc.pixelSourceType);
        item.pixelSourceType = typeof desc.pixelSourceType === 'number' ? desc.pixelSourceType : null;
        // Keep a wire reference even when ag-psd drops an unknown pixel source.
        reference(desc.frameReader, { groupIndex: null, clipIndex: null, groupId: null, clipId: null });
      }
      item.status = 'decoded';
    } catch (error) {
      item.reason = error.message === 'coverage-limit' || error.message === 'asset_baseline_psd_metadata_limit'
        ? 'coverage-limit' : 'media-descriptor-decode-or-shape-error';
      issue(item.reason);
    }
    recordUnits += JSON.stringify(item).length;
    if (recordUnits > 32768) throw new Error('coverage-limit');
  }
  function linkRecords(end, carrier, layerIndex) {
    while (offset < end) {
      if (facts.records.length >= 8192) throw new Error('coverage-limit');
      const size = length64(end);
      need(size, end);
      const recordEnd = offset + size;
      const type = signature(recordEnd);
      const version = u32(recordEnd);
      need(1, recordEnd);
      const idBytes = buffer[offset++];
      need(idBytes, recordEnd);
      const id = buffer.toString('latin1', offset, offset + idBytes);
      offset += idBytes;
      const item = { carrier, layerIndex, id, type, version, tailBytes: null };
      recordUnits += JSON.stringify(item).length;
      if (recordUnits > 32768) throw new Error('coverage-limit');
      facts.records.push(item);
      if (!['liFD', 'liFE', 'liFA'].includes(type) || version < 1 || version > 7) {
        issue('unsupported-link-form');
        offset = recordEnd;
      } else {
        unicode(recordEnd);
        skip(8, recordEnd); // file type and creator
        const dataSize = length64(recordEnd);
        need(1, recordEnd);
        const hasDescriptor = buffer[offset++];
        if (hasDescriptor > 1) throw new Error('invalid-open-descriptor-flag');
        function descriptor() {
          const reader = createReader(buffer.buffer, buffer.byteOffset + offset, Math.min(65536, recordEnd - offset));
          // The pinned decoder implements variable descriptors. The bounded
          // view prevents a malformed descriptor consuming another record.
          readVersionAndDescriptor(reader);
          skip(reader.offset, recordEnd);
        }
        if (hasDescriptor) descriptor();
        if (type === 'liFE') descriptor();
        if (type === 'liFE' && version > 3) skip(16, recordEnd);
        const fileSize = type === 'liFE' ? length64(recordEnd) : 0;
        if (type === 'liFA') skip(8, recordEnd);
        if (type === 'liFD') skip(dataSize, recordEnd);
        if (version >= 5) unicode(recordEnd);
        if (version >= 6) skip(8, recordEnd);
        if (version >= 7) skip(1, recordEnd);
        if (type === 'liFE' && version === 2) skip(fileSize, recordEnd);
        item.tailBytes = recordEnd - offset;
        if (item.tailBytes) issue('unexplained-link-tail');
        offset = recordEnd;
      }
      skip((4 - size % 4) % 4, end);
    }
  }
  function additional(end, layerIndex) {
    while (offset < end) {
      // Global additional info may include zero padding, not tag-like bytes.
      if (layerIndex === null && buffer[offset] === 0) { offset++; continue; }
      if (end - offset < 12) {
        while (offset < end) if (buffer[offset++] !== 0) issue('unexplained-additional-tail');
        return;
      }
      if (++blocks > 8192) throw new Error('coverage-limit');
      const sig = signature(end);
      if (sig !== '8BIM') throw new Error('unsupported-additional-signature');
      const key = signature(end);
      if (facts.keys.length < 128 && !facts.keys.includes(key)) facts.keys.push(key);
      const blockEnd = section(end);
      const size = blockEnd - offset;
      if (['Layr', 'Lr16', 'Lr32'].includes(key)) issue('alternate-layer-carrier');
      if (key === 'lyid' && layerIndex !== null) {
        if (size !== 4 || layerIds.has(layerIndex)) issue('ambiguous-layer-id');
        else layerIds.set(layerIndex, u32(blockEnd));
      }
      if (['lnk2', 'lnkD', 'lnk3', 'lnkE'].includes(key)) linkRecords(blockEnd, key, layerIndex);
      if (key === 'PxSc') mediaDescriptor(blockEnd, key, blocks, layerIndex);
      offset = blockEnd;
      skip(size % 2, end);
    }
  }
  try {
    const end = buffer.length;
    if (signature(end) !== '8BPS' || u16(end) !== 1) throw new Error('unsupported-psd-version');
    skip(6, end);
    const channels = u16(end);
    skip(8, end); // dimensions; semantic decoding belongs to ag-psd
    if (channels > 16 || u16(end) !== 8) throw new Error('unsupported-primary-layer-form');
    u16(end); // color mode already checked by the actual parser
    offset = section(end); // color-mode data
    const resourcesEnd = section(end);
    while (offset < resourcesEnd) {
      if (++blocks > 8192) throw new Error('coverage-limit');
      if (signature(resourcesEnd) !== '8BIM') throw new Error('unsupported-resource-signature');
      const id = u16(resourcesEnd);
      if (facts.resourceIds.length < 128 && !facts.resourceIds.includes(id)) facts.resourceIds.push(id);
      need(1, resourcesEnd);
      const nameBytes = buffer[offset++];
      skip(nameBytes + ((nameBytes + 1) % 2), resourcesEnd);
      const resourceEnd = section(resourcesEnd);
      const size = resourceEnd - offset;
      if (id === 1075) mediaDescriptor(resourceEnd, '1075', blocks, null);
      offset = resourceEnd;
      skip(size % 2, resourcesEnd);
    }
    const maskEnd = section(end);
    if (offset < maskEnd) {
      const layerEnd = section(maskEnd);
      const layerStart = offset;
      if (offset < layerEnd) {
        need(2, layerEnd);
        const count = Math.abs(buffer.readInt16BE(offset)); offset += 2;
        if (count > 8192) throw new Error('coverage-limit');
        let channelBytes = 0;
        for (let index = 0; index < count; index++) {
          skip(16, layerEnd);
          const channelCount = u16(layerEnd);
          if (channelCount > 16) throw new Error('unsupported-layer-channels');
          for (let c = 0; c < channelCount; c++) { skip(2, layerEnd); channelBytes += u32(layerEnd); }
          if (signature(layerEnd) !== '8BIM') throw new Error('invalid-layer-signature');
          skip(8, layerEnd); // blend mode, opacity, clipping, flags, filler
          const extraEnd = section(layerEnd);
          offset = section(extraEnd); // mask
          offset = section(extraEnd); // blending ranges
          need(1, extraEnd);
          const nameBytes = buffer[offset++];
          skip(nameBytes + ((4 - (nameBytes + 1) % 4) % 4), extraEnd);
          additional(extraEnd, index);
          for (const carrier of facts.mediaCarriers) {
            if (carrier.layerIndex === index) carrier.layerId = layerIds.get(index) ?? null;
          }
        }
        skip(channelBytes, layerEnd);
        while (offset < layerEnd) if (buffer[offset++] !== 0) issue('unexplained-layer-tail');
      }
      offset = layerEnd;
      skip((layerEnd - layerStart) % 2, maskEnd);
      if (offset < maskEnd) { offset = section(maskEnd); additional(maskEnd, null); }
    }
    facts.status = facts.issues.length ? 'incomplete' : 'framed';
  } catch (error) {
    if (facts.issues.length < 128) facts.issues.push(error.message === 'coverage-limit' ? 'coverage-limit' : 'unsupported-or-malformed-framing');
  }
  return facts;
}

const CHUNK_BYTES = 1024 * 1024;
const TEXT_UNITS = 16384;
const PSD_RECORD_PROTOCOL_VERSION = 3;
const PSD_METADATA_RECORD_UNITS = 65536;
const PSD_METADATA_TOTAL_UNITS = 4 * 1024 * 1024;
const PSD_METADATA_RECORD_COUNT = 8192;

// Preserve parsed metadata, not binary allocations. Reject excess metadata
// rather than truncate a token and accidentally turn it into an empty result.
function copyPsdMetadata(value, budget = { units: 0 }, depth = 0) {
  if (depth > 16) throw new Error('asset_baseline_psd_metadata_limit');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    budget.units += value.length;
    if (budget.units > PSD_METADATA_RECORD_UNITS) throw new Error('asset_baseline_psd_metadata_limit');
    return value;
  }
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) {
    throw new Error('asset_baseline_psd_metadata_invalid');
  }
  const keys = Object.keys(value);
  if (keys.length > 1024) throw new Error('asset_baseline_psd_metadata_limit');
  const result = Array.isArray(value) ? [] : Object.create(null);
  for (const key of keys) {
    if (value[key] === undefined) continue;
    budget.units += key.length;
    result[key] = copyPsdMetadata(value[key], budget, depth + 1);
  }
  return result;
}

async function sendPsdRecords(parsed, send) {
  const { psd, sourceIdentity, sourceDigest } = parsed;
  await send({ type: 'begin', protocolVersion: PSD_RECORD_PROTOCOL_VERSION, sourceIdentity, sourceDigest });
  let entryCount = 0;
  let embeddedCount = 0;
  let metadataCount = 0;
  let metadataUnits = 0;
  const linkedSources = [];
  const mediaSources = [];
  function collectLinkedFiles(files, layerPath) {
    if (files && !Array.isArray(files)) throw new Error('asset_baseline_psd_metadata_invalid');
    for (const file of files || []) {
      if (linkedSources.length >= PSD_METADATA_RECORD_COUNT) throw new Error('asset_baseline_psd_metadata_limit');
      linkedSources.push({ file, layerPath });
    }
  }
  collectLinkedFiles(psd.linkedFiles, null);
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
  async function metadata(value) {
    if (metadataCount >= PSD_METADATA_RECORD_COUNT) throw new Error('asset_baseline_psd_metadata_limit');
    const text = JSON.stringify(copyPsdMetadata(value));
    metadataUnits += text.length;
    if (text.length > PSD_METADATA_RECORD_UNITS || metadataUnits > PSD_METADATA_TOTAL_UNITS) {
      throw new Error('asset_baseline_psd_metadata_limit');
    }
    await record('linked-metadata', text, null, metadataCount++);
  }
  await metadata({ origin: 'framing', facts: parsed.framing || { status: 'not-examined' } });
  const groups = psd.imageResources?.timelineInformation?.audioClipGroups;
  if (groups !== undefined && !Array.isArray(groups)) throw new Error('asset_baseline_psd_metadata_invalid');
  for (const [groupIndex, group] of (groups || []).entries()) {
    if (!group || !Array.isArray(group.audioClips)) throw new Error('asset_baseline_psd_metadata_invalid');
    for (const [clipIndex, clip] of group.audioClips.entries()) {
      if (mediaSources.length >= PSD_METADATA_RECORD_COUNT) throw new Error('asset_baseline_psd_metadata_limit');
      mediaSources.push({ carrier: '1075', layerPath: null, groupIndex, clipIndex,
        groupId: group.id ?? null, clipId: clip?.id ?? null, pixelSourceType: null, frameReader: clip?.frameReader ?? null });
    }
  }
  async function walkLayers(layers, parent = []) {
    if (parent.length > 64 || (layers && !Array.isArray(layers))) throw new Error('asset_baseline_psd_metadata_invalid');
    for (const [index, layer] of (layers || []).entries()) {
      if (!layer || typeof layer !== 'object') throw new Error('asset_baseline_psd_metadata_invalid');
      const layerPath = [...parent, index];
      if (layer.placedLayer !== undefined || layer.linkedFile !== undefined || layer.linkedFiles !== undefined || layer.pixelSource !== undefined) {
        await metadata({ origin: 'layer', layerPath,
          placedLayer: layer.placedLayer === undefined ? null : {
            id: layer.placedLayer.id ?? null, type: layer.placedLayer.type ?? null,
          }, linkedFile: layer.linkedFile ?? null });
      }
      if (layer.pixelSource !== undefined) {
        if (mediaSources.length >= PSD_METADATA_RECORD_COUNT) throw new Error('asset_baseline_psd_metadata_limit');
        mediaSources.push({ carrier: 'PxSc', layerPath, layerId: layer.id ?? null, groupIndex: null, clipIndex: null, groupId: null, clipId: null,
          pixelSourceType: layer.pixelSource?.type ?? null, frameReader: layer.pixelSource?.frameReader ?? null });
      }
      collectLinkedFiles(layer.linkedFiles, layerPath);
      await walkLayers(layer.children, layerPath);
    }
  }
  await walkLayers(psd.children);
  let embeddedIndex = 0;
  for (const [index, { file, layerPath }] of linkedSources.entries()) {
    if (!file || typeof file !== 'object' || (file.data && !(file.data instanceof Uint8Array))) {
      throw new Error('asset_baseline_psd_metadata_invalid');
    }
    const { data, ...fields } = file;
    await metadata({ origin: 'linked-file', index, layerPath, metadata: fields, dataPresent: !!data,
      byteLength: data ? data.byteLength : 0, embeddedIndex: data ? embeddedIndex++ : null });
  }
  for (const [index, fields] of mediaSources.entries()) await metadata({ origin: 'media-reference', index, ...fields });
  async function walkLayerPaths(layers) {
    for (const layer of layers || []) {
      if (typeof layer.linkedFile?.fullPath === 'string') {
        await record('linked-path', layer.linkedFile.fullPath, null, entryCount++);
      }
      await walkLayerPaths(layer.children);
    }
  }
  await walkLayerPaths(psd.children);
  for (const { file } of linkedSources) {
    if (typeof file?.linkedFile?.fullPath === 'string') {
      await record('linked-path', file.linkedFile.fullPath, null, entryCount++);
    }
  }
  for (const media of mediaSources) {
    if (typeof media.frameReader?.link?.fullPath === 'string') {
      await record('linked-path', media.frameReader.link.fullPath, null, entryCount++);
    }
  }
  for (const { file } of linkedSources) {
    if (!file?.data) continue;
    await record('embedded', typeof file.name === 'string' ? file.name : '', file.data, embeddedCount++);
    file.data = null;
  }
  await send({ type: 'result', protocolVersion: PSD_RECORD_PROTOCOL_VERSION,
    metadataCount, metadataUnits, entryCount, embeddedCount, sourceIdentity, sourceDigest });
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
  inspectPsdLinkFraming,
  CHUNK_BYTES,
  TEXT_UNITS,
  sendPsdRecords,
  startAddFilesPsdWorker,
};
