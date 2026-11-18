'use strict';
// What counts as a proven self-contained embedded Photoshop document. All bytes
// are written by ag-psd. Name, extension and file type are never evidence.

const test = require('node:test');
const assert = require('./bounded-assert');
const Module = require('node:module');
const agPsd = require('ag-psd');
const worker = require('../parsers/add-files-psd-worker');
const { createFixtures } = require('./fixtures/embedded-photoshop-documents.cjs');

const { isProvenEmbeddedDocumentBytes: isProven, createEmbeddedDocumentClassifier, inspectPsdLinkFraming, EMBEDDED_DOCUMENT_LIMITS } = worker;
const fixtures = createFixtures(agPsd);
const { embedded, external, plainDocument, documentHolding, parentPsd, png, layer, write, guid } = fixtures;
const read = bytes => agPsd.readPsd(bytes, { skipLayerImageData: true, skipCompositeImageData: true, totalMemoryLimit: -Infinity });

function classifyParent(records, framingOverride) {
  const bytes = parentPsd(records), psd = read(bytes);
  const decide = createEmbeddedDocumentClassifier(psd, () => (framingOverride ? framingOverride(inspectPsdLinkFraming(bytes)) : inspectPsdLinkFraming(bytes)));
  return { psd, results: Object.fromEntries(psd.linkedFiles.map((record, index) => [`${index}:${record.name}`, decide(record)])) };
}

function nested(depth) {
  let bytes = plainDocument('deepest');
  for (let level = 1; level < depth; level++) bytes = documentHolding([embedded(`level-${level}.psb`, bytes)], `level-${level}`);
  return bytes;
}

// The worker module with ag-psd answering a chosen parsed document, for shapes
// the writer cannot produce.
function workerParsing(parsed) {
  const file = require.resolve('../parsers/add-files-psd-worker');
  const cached = require.cache[file], load = Module._load;
  delete require.cache[file];
  Module._load = function (request, ...rest) {
    return request === 'ag-psd' ? { ...agPsd, readPsd: () => parsed } : load.call(this, request, ...rest);
  };
  try { return require(file); } finally { Module._load = load; delete require.cache[file]; require.cache[file] = cached; }
}

test('complete documents without links are proven, as PSB and as PSD', () => {
  assert.equal(isProven(plainDocument('a')), true);
  assert.equal(isProven(plainDocument('b', { psb: false })), true);
  assert.equal(isProven(documentHolding([embedded('inner.psb', plainDocument('c'))])), true);
  assert.equal(isProven(documentHolding([embedded('inner.png', png(1), { type: 'png ' })])), true, 'embedded non-Photoshop data is self-contained');
});

test('a signature without a valid document is not proven', () => {
  assert.equal(isProven(Buffer.from('8BPS')), false);
  assert.equal(isProven(Buffer.concat([Buffer.from('8BPS'), Buffer.alloc(64)])), false);
  assert.equal(isProven(Buffer.concat([plainDocument('x').subarray(0, 26), Buffer.alloc(32, 0xff)])), false);
  assert.equal(isProven(png(2)), false);
});

test('a document cut anywhere is not proven', () => {
  const bytes = plainDocument('truncate');
  for (const keep of [5, 12, 25, 26, 30, Math.floor(bytes.length / 2), bytes.length - 2, bytes.length - 1]) {
    assert.equal(isProven(bytes.subarray(0, keep)), false, `${keep} of ${bytes.length}`);
  }
});

test('only versions 1 and 2 are accepted', () => {
  const bytes = Buffer.from(plainDocument('version'));
  for (const version of [0, 3, 0xffff]) { bytes.writeUInt16BE(version, 4); assert.equal(isProven(bytes), false, `version ${version}`); }
});

test('nesting is proven to the depth limit and refused past it', () => {
  assert.equal(EMBEDDED_DOCUMENT_LIMITS.depth, 4);
  assert.equal(isProven(nested(4)), true);
  assert.equal(isProven(nested(5)), false);
});

test('record, layer, nesting and byte budgets each refuse a document past them', () => {
  const bytes = documentHolding([embedded('one.png', png(3)), embedded('two.png', png(4))]);
  const limits = { ...EMBEDDED_DOCUMENT_LIMITS };
  assert.equal(isProven(bytes, limits), true);
  assert.equal(isProven(bytes, { ...limits, records: 2 }), true);
  assert.equal(isProven(bytes, { ...limits, records: 1 }), false);
  assert.equal(isProven(bytes, { ...limits, layers: 1 }), true);
  assert.equal(isProven(bytes, { ...limits, layers: 0 }), false);
  assert.equal(isProven(bytes, { ...limits, parsedBytes: bytes.length }), true);
  assert.equal(isProven(bytes, { ...limits, parsedBytes: bytes.length - 1 }), false);
  const group = write({ children: [{ name: 'Group', children: [layer('Inner', 'nesting')] }] });
  assert.equal(isProven(group, { ...limits, layerNesting: 1 }), true);
  assert.equal(isProven(group, { ...limits, layerNesting: 0 }), false);
  const inner = plainDocument('budget');
  const outer = documentHolding([embedded('inner.psb', inner)]);
  assert.equal(isProven(outer, { ...limits, parsedBytes: outer.length + inner.length }), true, 'a nested document counts too');
  assert.equal(isProven(outer, { ...limits, parsedBytes: outer.length + inner.length - 1 }), false);
});

test('an external link at document or layer level is not self-contained', () => {
  assert.equal(isProven(documentHolding([external('outside.png', '/Users/synthetic/outside.png')])), false);
  assert.equal(isProven(write({ children: [layer('Linked', 'l', { linkedFiles: [external('outside.png', '/Users/synthetic/outside.png')] })] })), false);
  const holder = documentHolding([embedded('inner.psb', documentHolding([external('deep.png', '/Users/synthetic/deep.png')]))]);
  assert.equal(isProven(holder), false, 'an external link below an embedded document');
});

test('external and alias type codes anywhere in the bytes leave a document not proven', () => {
  // A record of those forms can parse like an embedded one, so its bytes decide.
  for (const code of ['liFE', 'liFA']) {
    assert.equal(isProven(documentHolding([embedded('note.png', Buffer.concat([png(8), Buffer.from(code)]), { type: 'png ' })])), false, code);
  }
});

test('parsed link fields refuse the document even when the bytes look clean', () => {
  const bytes = plainDocument('parsed');
  const id = guid('parsed');
  const record = { id, name: 'in.png', data: new Uint8Array(png(5)) };
  const cases = {
    'layer linkedFile': { children: [{ linkedFile: { fullPath: '/Users/synthetic/a.png' } }] },
    'media link': { children: [{ pixelSource: { frameReader: { link: { fullPath: '/Users/synthetic/a.mov' } } } }] },
    'empty media link': { children: [{ pixelSource: { frameReader: { link: {} } } }] },
    'timeline clip link': { imageResources: { timelineInformation: { audioClipGroups: [{ audioClips: [{ frameReader: { link: { fullPath: '/Users/synthetic/a.wav' } } }] }] } } },
    'malformed timeline': { imageResources: { timelineInformation: { audioClipGroups: {} } } },
    'record with descriptor': { linkedFiles: [{ ...record, linkedFile: { fullPath: '/Users/synthetic/a.png' } }] },
    'record without bytes': { linkedFiles: [{ id, name: 'in.png' }] },
    'record without id': { linkedFiles: [{ name: 'in.png', data: record.data }] },
    'duplicate ids': { linkedFiles: [record, { ...record }] },
    'placed layer with no record': { children: [{ placedLayer: { id: guid('missing') } }] },
    'placed layer without id': { children: [{ placedLayer: {} }] },
  };
  for (const [name, parsed] of Object.entries(cases)) assert.equal(workerParsing(parsed).isProvenEmbeddedDocumentBytes(bytes), false, name);
  assert.equal(workerParsing({ linkedFiles: [record], children: [{ placedLayer: { id } }] }).isProvenEmbeddedDocumentBytes(bytes), true, 'control');
});

test('the parent decides by bytes: names, extensions and types are no evidence', () => {
  const { results } = classifyParent([
    embedded('looks like a picture.png', plainDocument('p1'), { type: 'png ' }),
    embedded('looks like a document.psb', png(6)),
    embedded('[YOUR IMAGE HERE].psb', plainDocument('same-a')),
    embedded('[YOUR IMAGE HERE].psb', plainDocument('same-b')),
    embedded('[YOUR IMAGE HERE].psb', documentHolding([external('out.png', '/Users/synthetic/out.png')])),
  ]);
  assert.deepEqual(results, {
    '0:looks like a picture.png': true, '1:looks like a document.psb': false,
    '2:[YOUR IMAGE HERE].psb': true, '3:[YOUR IMAGE HERE].psb': true, '4:[YOUR IMAGE HERE].psb': false,
  });
});

test('the parent wire record must be one plain embedded record', () => {
  const records = () => [embedded('doc.psb', plainDocument('wire'))];
  const only = result => Object.values(result.results)[0];
  assert.equal(only(classifyParent(records())), true);
  const change = patch => facts => ({ ...facts, records: facts.records.map(item => ({ ...item, ...patch })) });
  assert.equal(only(classifyParent(records(), change({ type: 'liFE' }))), false, 'stored as external');
  assert.equal(only(classifyParent(records(), change({ type: 'liFA' }))), false, 'stored as alias');
  assert.equal(only(classifyParent(records(), change({ carrier: 'lnkE' }))), false, 'external carrier');
  assert.equal(only(classifyParent(records(), change({ tailBytes: 4 }))), false, 'unexplained tail');
  assert.equal(only(classifyParent(records(), change({ tailBytes: null }))), false, 'unframed');
  assert.equal(only(classifyParent(records(), facts => ({ ...facts, records: [] }))), false, 'no wire record');
  assert.equal(only(classifyParent(records(), facts => ({ ...facts, records: [...facts.records, ...facts.records] }))), false, 'two wire records');
  assert.equal(only(classifyParent(records(), () => null)), false, 'no wire facts');
});

test('a record of the parent with a descriptor, no bytes or a shared id is not proven', () => {
  const data = plainDocument('top');
  const psd = read(parentPsd([embedded('a.psb', data), embedded('b.psb', data)]));
  const facts = psd.linkedFiles.map(record => ({ id: record.id, type: 'liFD', carrier: 'lnk2', tailBytes: 0 }));
  const decide = createEmbeddedDocumentClassifier(psd, () => ({ records: facts }));
  assert.equal(decide(psd.linkedFiles[0]), true);
  assert.equal(decide({ ...psd.linkedFiles[1], linkedFile: { fullPath: '/Users/synthetic/a.psb' } }), false);
  assert.equal(decide({ ...psd.linkedFiles[1], data: undefined }), false);
  const shared = { ...psd, linkedFiles: [psd.linkedFiles[0], { ...psd.linkedFiles[1], id: psd.linkedFiles[0].id }] };
  assert.equal(createEmbeddedDocumentClassifier(shared, () => ({ records: facts }))(shared.linkedFiles[0]), false);
});

test('wire facts are read only when a record could be a Photoshop document', () => {
  const psd = read(parentPsd([embedded('p.png', png(7), { type: 'png ' })]));
  let reads = 0;
  const decide = createEmbeddedDocumentClassifier(psd, () => { reads++; return { records: [] }; });
  assert.equal(decide(psd.linkedFiles[0]), false);
  assert.equal(reads, 0);
});
