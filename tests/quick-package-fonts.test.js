'use strict';
// Quick Package has no review step, so no font can receive an include choice
// or a per-font licence confirmation there. A font a document merely links is
// never copied by Quick Package; it is reported instead. Fonts are synthetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const zlib = require('node:zlib');
const ag = require('ag-psd');
const { packageMasterFile } = require('../parsers');
const { buildFont, englishNames, OFL_STATEMENT } = require('./font-fixtures');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-quick-fonts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const adobeDir = path.join(root, 'home', 'Library', 'Application Support', 'Adobe', 'CoreSync', 'plugins', 'livetype', 'r');
  fs.mkdirSync(adobeDir, { recursive: true });
  const fonts = {
    brand: path.join(root, 'Brand Kit', 'BrandSans-Bold.otf'),
    open: path.join(root, 'Brand Kit', 'Open-Regular.ttf'),
    restricted: path.join(root, 'Brand Kit', 'Restricted.otf'),
    collection: path.join(root, 'Brand Kit', 'Family.TTC'),
    adobe: path.join(adobeDir, 'Cloud.otf'),
  };
  fs.mkdirSync(path.dirname(fonts.brand), { recursive: true });
  fs.writeFileSync(fonts.brand, buildFont());
  fs.writeFileSync(fonts.open, buildFont({ signature: 'TRUE', names: englishNames({ postscriptName: 'Open-Regular', licence: OFL_STATEMENT }) }));
  fs.writeFileSync(fonts.restricted, buildFont({ fsType: 2 }));
  fs.writeFileSync(fonts.collection, buildFont());
  fs.writeFileSync(fonts.adobe, buildFont());
  const image = path.join(root, 'Brand Kit', 'Logo.png');
  fs.writeFileSync(image, Buffer.alloc(900, 7));
  const out = path.join(root, 'out');
  fs.mkdirSync(out);
  return { root, fonts, image, out };
}

function zip(root, name, entries) {
  const staging = fs.mkdtempSync(path.join(root, 'zip-'));
  for (const [entry, data] of Object.entries(entries)) {
    const target = path.join(staging, entry);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
  const archive = path.join(root, name);
  cp.execFileSync('/usr/bin/zip', ['-q', '-r', archive, '.'], { cwd: staging });
  return archive;
}

function listOutput(out) {
  const files = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(target); else files.push(path.relative(out, target));
    }
  };
  walk(out);
  return files.sort();
}

function assertFontsReportedNotCopied(result, w, linkedFonts) {
  const copied = listOutput(w.out);
  assert.ok(!copied.some(file => /\.(otf|ttf|ttc|otc)$/i.test(file)), `no font copied: ${copied.join(', ')}`);
  assert.ok(copied.some(file => path.basename(file) === 'Logo.png'), 'ordinary linked asset still copied');
  assert.deepEqual(
    (result.fontsNotIncluded || []).map(item => item.name).sort(),
    linkedFonts.map(font => path.basename(font)).sort()
  );
  for (const item of result.fontsNotIncluded) {
    assert.equal(Object.keys(item).sort().join(','), 'name,reason');
    assert.equal(item.reason, 'quick-package');
  }
  assert.ok(!result.assetsMissing.some(item => /\.(otf|ttf|ttc|otc)$/i.test(item.path)), 'fonts are not misreported as missing');
}

test('IDML: linked font files of every class are reported, never copied', async t => {
  const w = workspace(t);
  const linked = [w.fonts.brand, w.fonts.open, w.fonts.restricted, w.fonts.collection, w.fonts.adobe];
  const links = [w.image, ...linked].map(file => `<Link LinkResourceURI="file://${file.replace(/ /g, '%20')}"/>`).join('');
  const idml = zip(w.root, 'Layout.idml', { 'Spreads/Spread_1.xml': `<Spread>${links}</Spread>` });
  const result = await packageMasterFile(idml, w.out);
  assertFontsReportedNotCopied(result, w, linked);
});

test('PRPROJ: media paths that point at fonts are reported, never copied', async t => {
  const w = workspace(t);
  const linked = [w.fonts.brand, w.fonts.adobe];
  const project = path.join(w.root, 'Edit.prproj');
  fs.writeFileSync(project, zlib.gzipSync(`<PremiereData>${[w.image, ...linked].map(file => `<FilePath>${file}</FilePath>`).join('')}</PremiereData>`));
  const result = await packageMasterFile(project, w.out);
  assertFontsReportedNotCopied(result, w, linked);
});

test('PSD: a smart object linked to a font file is reported, never copied', async t => {
  const w = workspace(t);
  const linkedFile = (file, id) => ({ id, name: path.basename(file), childDocumentID: '',
    linkedFile: { fileSize: 800, name: path.basename(file), fullPath: file, originalPath: file, relativePath: '' } });
  const psd = path.join(w.root, 'Comp.psd');
  fs.writeFileSync(psd, ag.writePsdBuffer({ width: 1, height: 1, linkedFiles: [
    linkedFile(w.image, '11111111-1111-4111-8111-111111111111'),
    linkedFile(w.fonts.restricted, '22222222-2222-4222-8222-222222222222'),
  ] }));
  const result = await packageMasterFile(psd, w.out);
  assertFontsReportedNotCopied(result, w, [w.fonts.restricted]);
});

for (const flat of [false, true]) test(`PSD: a linked font whose name ends in a space or dot is still never copied (flat ${flat})`, async t => {
  const w = workspace(t);
  const spaced = path.join(w.root, 'Brand Kit', 'Boundary.otf ');
  const dotted = path.join(w.root, 'Brand Kit', 'Dotted.OTF.');
  fs.writeFileSync(spaced, buildFont({ fsType: 2 }));
  fs.writeFileSync(dotted, buildFont({ fsType: 2 }));
  const linkedFile = (file, id) => ({ id, name: path.basename(file), childDocumentID: '',
    linkedFile: { fileSize: 800, name: path.basename(file), fullPath: file, originalPath: file, relativePath: '' } });
  const psd = path.join(w.root, 'Comp.psd');
  fs.writeFileSync(psd, ag.writePsdBuffer({ width: 1, height: 1, linkedFiles: [
    linkedFile(w.image, '11111111-1111-4111-8111-111111111111'),
    linkedFile(spaced, '33333333-3333-4333-8333-333333333333'),
    linkedFile(dotted, '44444444-4444-4444-8444-444444444444'),
  ] }));
  const result = await packageMasterFile(psd, w.out, { flat });
  const copied = listOutput(w.out);
  assert.ok(!copied.some(file => /\.(otf|ttf|ttc|otc)[ .]*$/i.test(file)), copied.join(', '));
  assert.deepEqual((result.fontsNotIncluded || []).map(item => item.name).sort(), ['Boundary.otf ', 'Dotted.OTF.']);
});

test('round 4: Quick Package never copies a linked font hidden behind an invisible character; ordinary files still copy', async t => {
  const w = workspace(t);
  const hidden = path.join(w.root, 'Brand Kit', 'Hidden.otf​');
  fs.writeFileSync(hidden, buildFont({ fsType: 2 }));
  const photo = path.join(w.root, 'Brand Kit', 'Photo.png​');
  fs.writeFileSync(photo, Buffer.alloc(900, 3));
  const linkedFile = (file, id) => ({ id, name: path.basename(file), childDocumentID: '',
    linkedFile: { fileSize: 800, name: path.basename(file), fullPath: file, originalPath: file, relativePath: '' } });
  const psd = path.join(w.root, 'Comp.psd');
  fs.writeFileSync(psd, ag.writePsdBuffer({ width: 1, height: 1, linkedFiles: [
    linkedFile(w.image, '11111111-1111-4111-8111-111111111111'),
    linkedFile(hidden, '55555555-5555-4555-8555-555555555555'),
    linkedFile(photo, '66666666-6666-4666-8666-666666666666'),
  ] }));
  const result = await packageMasterFile(psd, w.out);
  const copied = listOutput(w.out);
  assert.ok(!copied.some(file => file.includes('Hidden')), copied.join(', '));
  assert.ok(copied.some(file => file.endsWith('Photo.png​')), copied.join(', '));
  assert.deepEqual((result.fontsNotIncluded || []).map(item => item.name), ['Hidden.otf​']);
  const idmlLinks = [w.image, hidden].map(file => `<Link LinkResourceURI="file://${encodeURI(file)}"/>`).join('');
  const idml = zip(w.root, 'Layout.idml', { 'Spreads/Spread_1.xml': `<Spread>${idmlLinks}</Spread>` });
  const out2 = path.join(w.root, 'out2'); fs.mkdirSync(out2);
  const idmlResult = await packageMasterFile(idml, out2);
  assert.ok(!listOutput(out2).some(file => file.includes('Hidden')), listOutput(out2).join(', '));
  assert.deepEqual((idmlResult.fontsNotIncluded || []).map(item => item.name), ['Hidden.otf​']);
});

test('PPTX: an external link to a font file fails closed with an explanation and writes nothing', async t => {
  const w = workspace(t);
  const rel = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="file://${target}" TargetMode="External"/>`;
  const deck = zip(w.root, 'Deck.pptx', {
    'ppt/slides/_rels/slide1.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel('rId1', 'image', w.image)}${rel('rId2', 'oleObject', w.fonts.brand)}</Relationships>`,
  });
  const before = fs.readFileSync(deck);
  await assert.rejects(packageMasterFile(deck, w.out), /font file/i);
  assert.deepEqual(fs.readdirSync(w.out), []);
  assert.deepEqual(fs.readFileSync(deck), before);
});

test('PPTX without font links keeps its existing Quick Package behavior', async t => {
  const w = workspace(t);
  const deck = zip(w.root, 'Deck.pptx', {
    'ppt/slides/_rels/slide1.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="file://${w.image}" TargetMode="External"/></Relationships>`,
  });
  const result = await packageMasterFile(deck, w.out);
  assert.equal(result.assetsCopied, 1);
  assert.equal(Object.hasOwn(result, 'fontsNotIncluded'), false, 'result shape unchanged without fonts');
  assert.deepEqual(listOutput(w.out), ['Deck.pptx', 'Logo.png']);
});
