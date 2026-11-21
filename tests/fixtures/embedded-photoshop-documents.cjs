'use strict';
// Generated Photoshop bytes for the embedded-document tests. Every document is
// written by ag-psd, so its structure is real; its pixels are seeded noise.
const crypto = require('node:crypto');

let idCounter = 0;
function guid(label) {
  const hex = crypto.createHash('sha256').update(`${label}:${++idCounter}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// Offsets of a written document's sections, for edits ag-psd's writer cannot make.
function documentLayout(bytes) {
  const large = bytes.readUInt16BE(4) === 2, sizeBytes = large ? 8 : 4;
  const readSize = at => (large ? bytes.readUInt32BE(at + 4) : bytes.readUInt32BE(at));
  const colorEnd = 30 + bytes.readUInt32BE(26);
  const mask = colorEnd + 4 + bytes.readUInt32BE(colorEnd);
  const layers = mask + sizeBytes, maskEnd = layers + readSize(mask);
  return { large, sizeBytes, readSize, mask, layers, maskEnd, firstLayer: layers + sizeBytes + 2 };
}
function withSizes(bytes, layout, grown, positions) {
  for (const { at, wide } of positions) {
    const offset = wide ? at + 4 : at;
    bytes.writeUInt32BE(bytes.readUInt32BE(offset) + grown, offset);
  }
  return bytes;
}
// One additional-info block appended to the first layer.
function withLayerBlock(original, key, payload) {
  const layout = documentLayout(original);
  let offset = layout.firstLayer + 16;
  const channels = original.readUInt16BE(offset);
  offset += 2 + channels * (2 + layout.sizeBytes) + 12;
  const extraEnd = offset + 4 + original.readUInt32BE(offset);
  const block = Buffer.alloc(12 + payload.length + payload.length % 2);
  block.write('8BIM'); block.write(key, 4); block.writeUInt32BE(payload.length, 8); payload.copy(block, 12);
  return withSizes(Buffer.concat([original.subarray(0, extraEnd), block, original.subarray(extraEnd)]), layout, block.length,
    [{ at: offset, wide: false }, { at: layout.layers, wide: layout.large }, { at: layout.mask, wide: layout.large }]);
}
// One additional-info block at the end of the layer and mask section.
function withDocumentBlock(original, key, payload, { wideLength = false } = {}) {
  const layout = documentLayout(original), lengthBytes = wideLength ? 8 : 4;
  const block = Buffer.alloc(8 + lengthBytes + payload.length + payload.length % 2);
  block.write('8BIM'); block.write(key, 4); block.writeUInt32BE(payload.length, 8 + lengthBytes - 4); payload.copy(block, 8 + lengthBytes);
  return withSizes(Buffer.concat([original.subarray(0, layout.maskEnd), block, original.subarray(layout.maskEnd)]), layout, block.length,
    [{ at: layout.mask, wide: layout.large }]);
}
// The composite image replaced by a compression code and these bytes.
function withComposite(original, compression, payload) {
  const code = Buffer.alloc(2); code.writeUInt16BE(compression);
  return Buffer.concat([original.subarray(0, documentLayout(original).maskEnd), code, payload]);
}
// A video source descriptor in the layout Photoshop stores, linking a movie.
function pixelSourcePayload({ pixelType, fullPath }) {
  const w = require('ag-psd/dist/psdWriter'), writer = w.createWriter();
  const id = value => { w.writeUint32(writer, value.length === 4 ? 0 : value.length); w.writeAsciiString(writer, value); };
  function descriptor(classId, fields) {
    w.writeUnicodeStringWithPadding(writer, ''); id(classId); w.writeUint32(writer, fields.length);
    for (const [key, type, value] of fields) {
      id(key); w.writeSignature(writer, type);
      if (type === 'Objc') descriptor(value[0], value[1]);
      else if (type === 'long') w.writeInt32(writer, value);
      else if (type === 'TEXT') w.writeUnicodeString(writer, value);
    }
  }
  w.writeUint32(writer, 16);
  descriptor('PixelSource', [['pixelSourceType', 'long', pixelType], ['descVersion', 'long', 1],
    ['frameReader', 'Objc', ['FrameReader', [['frameReaderType', 'long', 1364477522], ['descVersion', 'long', 1],
      ['Lnk ', 'Objc', ['ExternalFileLink', [['descVersion', 'long', 2], ['Nm  ', 'TEXT', 'clip.mov'], ['fullPath', 'TEXT', fullPath]]]]]]]]);
  return Buffer.from(w.getWriterBuffer(writer));
}

function createFixtures(agPsd) {
  function pixels(size, seed) {
    const data = new Uint8ClampedArray(size * size * 4);
    let block = Buffer.alloc(0), used = 0, counter = 0;
    for (let i = 0; i < data.length; i++) {
      if (used === block.length) { block = crypto.createHash('sha256').update(`${seed}:${counter++}`).digest(); used = 0; }
      data[i] = block[used++];
    }
    return { width: size, height: size, data };
  }
  function layer(name, seed, extra = {}) {
    return { name, left: 0, top: 0, right: 8, bottom: 8, imageData: pixels(8, seed), ...extra };
  }
  function write(fields, { psb = true } = {}) {
    return Buffer.from(agPsd.writePsdBuffer({ width: 8, height: 8, imageData: pixels(8, 'composite'), ...fields }, { psb, generateThumbnail: false }));
  }
  const embedded = (name, data, extra = {}) => ({ id: guid(name), name, type: extra.type ?? '8BPB', creator: '8BIM', data, ...extra });
  const external = (name, fullPath) => ({ id: guid(name), name, childDocumentID: '',
    linkedFile: { fileSize: 1, name, fullPath, originalPath: fullPath, relativePath: '' } });
  // A smart object as a mockup holds it: a complete document with no links.
  const plainDocument = (seed, options) => write({ children: [layer('Artwork', seed)] }, options);
  const documentHolding = (records, seed = 'holder') => write({ linkedFiles: records, children: [layer('Holder', seed)] });
  // Bytes that start like a PNG, whatever name they are stored under.
  const png = seed => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    crypto.createHash('sha256').update(String(seed)).digest()]);
  const parentPsd = (records, seed = 'parent') => write({ linkedFiles: records, children: [layer('Mockup photo', seed)] }, { psb: false });
  return { guid, pixels, layer, write, embedded, external, plainDocument, documentHolding, png, parentPsd };
}

module.exports = { createFixtures, withLayerBlock, withDocumentBlock, withComposite, pixelSourcePayload };
