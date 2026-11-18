'use strict';
// Generated Photoshop bytes for the embedded-document tests. Every document is
// written by ag-psd, so its structure is real; its pixels are seeded noise.
const crypto = require('node:crypto');

let idCounter = 0;
function guid(label) {
  const hex = crypto.createHash('sha256').update(`${label}:${++idCounter}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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

module.exports = { createFixtures };
