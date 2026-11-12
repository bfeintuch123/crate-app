'use strict';

// Minimal synthetic OpenType/TrueType tables for tests. No real font data:
// only the table directory, `name`, `OS/2` (fsType) and optional `fvar`.

function utf16be(text) {
  const buffer = Buffer.alloc(text.length * 2);
  for (let index = 0; index < text.length; index++) buffer.writeUInt16BE(text.charCodeAt(index), index * 2);
  return buffer;
}

function nameRecord(id, text, platform = 3, encoding = 1, language = 0x0409) {
  return { id, text, platform, encoding, language };
}

function englishNames({
  family = 'Brand Sans',
  style = 'Regular',
  postscriptName = 'BrandSans-Regular',
  version = 'Version 1.000',
  copyright = 'Copyright 2026 Example Type Foundry',
  licence = null,
  licenceUrl = null,
} = {}) {
  const records = [
    nameRecord(0, copyright),
    nameRecord(1, family),
    nameRecord(2, style),
    nameRecord(4, `${family} ${style}`),
    nameRecord(5, version),
    nameRecord(6, postscriptName),
  ];
  if (licence) records.push(nameRecord(13, licence));
  if (licenceUrl) records.push(nameRecord(14, licenceUrl));
  return records;
}

function buildNameTable(records) {
  const strings = [];
  let storageLength = 0;
  const encoded = records.map(record => {
    // `data` lets a test place raw bytes (unsupported encodings, odd lengths).
    const data = Buffer.isBuffer(record.data) ? record.data
      : record.platform === 1 ? Buffer.from(record.text, 'latin1') : utf16be(record.text);
    const entry = { ...record, data, offset: storageLength };
    storageLength += data.length;
    strings.push(data);
    return entry;
  });
  const header = Buffer.alloc(6 + encoded.length * 12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(encoded.length, 2);
  header.writeUInt16BE(header.length, 4);
  encoded.forEach((record, index) => {
    const base = 6 + index * 12;
    header.writeUInt16BE(record.platform, base);
    header.writeUInt16BE(record.encoding, base + 2);
    header.writeUInt16BE(record.language, base + 4);
    header.writeUInt16BE(record.id, base + 6);
    header.writeUInt16BE(record.data.length, base + 8);
    header.writeUInt16BE(record.offset, base + 10);
  });
  return Buffer.concat([header, ...strings]);
}

function buildOs2Table(fsType) {
  const table = Buffer.alloc(78);
  table.writeUInt16BE(4, 0);
  table.writeUInt16BE(fsType, 8);
  return table;
}

function buildFvarTable({ axisCount = 1, instances = [] }) {
  const axisSize = 20;
  const instanceSize = axisCount * 4 + 6;
  const table = Buffer.alloc(16 + axisCount * axisSize + instances.length * instanceSize);
  table.writeUInt16BE(1, 0);
  table.writeUInt16BE(0, 2);
  table.writeUInt16BE(16, 4);
  table.writeUInt16BE(2, 6);
  table.writeUInt16BE(axisCount, 8);
  table.writeUInt16BE(axisSize, 10);
  table.writeUInt16BE(instances.length, 12);
  table.writeUInt16BE(instanceSize, 14);
  for (let axis = 0; axis < axisCount; axis++) table.write('wght', 16 + axis * axisSize, 'latin1');
  instances.forEach((instance, index) => {
    const base = 16 + axisCount * axisSize + index * instanceSize;
    table.writeUInt16BE(instance.subfamilyNameId, base);
    table.writeUInt16BE(instance.postscriptNameId ?? 0xffff, base + 4 + axisCount * 4);
  });
  return table;
}

// Returns a function (baseOffset) => Buffer so faces can be placed in a collection.
// `nameTable` replaces the generated name table with raw bytes.
function sfntBuilder({ signature = 'OTTO', names = englishNames(), nameTable = null, fsType = 0, fvar = null, os2 = true, extraTables = [] } = {}) {
  const tables = [['name', Buffer.isBuffer(nameTable) ? nameTable : buildNameTable(names)]];
  if (os2) tables.push(['OS/2', buildOs2Table(fsType)]);
  if (fvar) tables.push(['fvar', buildFvarTable(fvar)]);
  tables.push(...extraTables);
  tables.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return baseOffset => {
    const directoryLength = 12 + tables.length * 16;
    const header = Buffer.alloc(directoryLength);
    if (signature === 'TRUE') header.writeUInt32BE(0x00010000, 0);
    else header.write(signature, 0, 'latin1');
    header.writeUInt16BE(tables.length, 4);
    let offset = baseOffset + directoryLength;
    const bodies = [];
    tables.forEach(([tag, data], index) => {
      const padded = Buffer.alloc(Math.ceil(data.length / 4) * 4);
      data.copy(padded);
      const base = 12 + index * 16;
      header.write(tag.padEnd(4, ' '), base, 'latin1');
      header.writeUInt32BE(offset, base + 8);
      header.writeUInt32BE(data.length, base + 12);
      offset += padded.length;
      bodies.push(padded);
    });
    return Buffer.concat([header, ...bodies]);
  };
}

function buildFont(options = {}) {
  return sfntBuilder(options)(0);
}

function buildCollection(faceOptions) {
  const headerLength = 12 + faceOptions.length * 4;
  const header = Buffer.alloc(headerLength);
  header.write('ttcf', 0, 'latin1');
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(faceOptions.length, 8);
  const parts = [];
  let offset = headerLength;
  faceOptions.forEach((options, index) => {
    header.writeUInt32BE(offset, 12 + index * 4);
    const data = sfntBuilder(options)(offset);
    parts.push(data);
    offset += data.length;
  });
  return Buffer.concat([header, ...parts]);
}

const OFL_STATEMENT = 'This Font Software is licensed under the SIL Open Font License, Version 1.1. This license is available with a FAQ at: https://openfontlicense.org';

module.exports = {
  OFL_STATEMENT,
  buildCollection,
  buildFont,
  englishNames,
  nameRecord,
  buildNameTable,
  utf16be,
};
