'use strict';
// Run with CRATE_SOURCE=/absolute/source node --test this-file.
// No mocks: production parser registry, unzip, gzip, ag-psd reader/writer and filesystem.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const cp = require('node:child_process');
const { createRequire } = require('node:module');
const source = process.env.CRATE_SOURCE || [path.resolve(__dirname, '..'), path.resolve(__dirname, '../../packaging-repair/source')].find(root => fs.existsSync(path.join(root, 'parsers/index.js')));
assert.ok(source, 'Run inside source/tests or supply CRATE_SOURCE');
const requireSource = createRequire(path.join(source, 'package.json'));
const registry = requireSource('./parsers');
const agPsd = requireSource('ag-psd');
const NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
function workspace(t) {
  const root = fs.mkdtempSync(path.join(__dirname, 'quick-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const asset = path.join(root, 'linked image.png'); fs.writeFileSync(asset, Buffer.alloc(1024, 17));
  return { root, asset, missing: path.join(root, 'missing.png') };
}
function zip(root, name, entries) {
  const staging = fs.mkdtempSync(path.join(root, 'zip-'));
  for (const [name, bytes] of Object.entries(entries)) {
    const entry = path.join(staging, name); fs.mkdirSync(path.dirname(entry), { recursive: true }); fs.writeFileSync(entry, bytes);
  }
  const output = path.join(root, name); cp.execFileSync('/usr/bin/zip', ['-q', '-r', output, '.'], { cwd: staging }); return output;
}
function xml(value) { return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
function files(root) { return fs.readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(root,e.name)) : [path.join(root,e.name)]); }
async function checkPackage(t, master, { assetsFound = 1, assetsCopied = 1, unchanged = true } = {}) {
  const before = fs.readFileSync(master), out = path.join(path.dirname(master), 'out-' + path.basename(master));
  const result = await registry.packageMasterFile(master, out);
  assert.equal(result.assetsFound, assetsFound); assert.equal(result.assetsCopied, assetsCopied);
  assert.equal(result.files.length, assetsCopied + 1); assert.equal(files(out).length, result.files.length);
  assert.deepEqual(fs.readFileSync(master), before, 'source master must remain unchanged');
  if (unchanged) assert.deepEqual(fs.readFileSync(result.files[0].copied), before, 'format has no relinker; copied master must remain byte exact');
  for (const item of result.files.filter(x => x.source !== 'master' && x.source !== 'embedded')) assert.deepEqual(fs.readFileSync(item.copied), fs.readFileSync(item.original));
  return result;
}
function pdfWithMetadataPaths(paths) {
  // Valid minimal PDF, uncompressed private path metadata. Tests raw fallback only,
  // not Illustrator's complete proprietary linked-object representation.
  const objects = ['<< /Type /Catalog /Pages 2 0 R /CrateFixturePaths (' + paths.join('\n') + ') >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] >>'];
  let body = '%PDF-1.4\n', offsets = [0];
  objects.forEach((object,i) => { offsets.push(Buffer.byteLength(body)); body += `${i+1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body); body += `xref\n0 4\n0000000000 65535 f \n` + offsets.slice(1).map(x => String(x).padStart(10,'0')+' 00000 n \n').join('') + `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`; return body;
}
function psd(paths, psb = false) {
  return agPsd.writePsdBuffer({ width:1, height:1, channels:3, bitsPerChannel:8, colorMode:3,
    linkedFiles: paths.map((p,i) => ({ id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`, name:path.basename(p), childDocumentID:'', linkedFile:{ fileSize:1024, name:path.basename(p), fullPath:p, originalPath:p, relativePath:'' } })) }, { psb });
}
function rifx(paths) {
  // Structurally valid RIFX/FaFX with one Utf8 chunk, not a full native AE project.
  const payload = Buffer.from(paths.join('\0')+'\0'), padded = Buffer.concat([payload, Buffer.alloc(payload.length % 2)]);
  const header = Buffer.alloc(20); header.write('RIFX'); header.writeUInt32BE(12+padded.length,4); header.write('FaFX',8); header.write('Utf8',12); header.writeUInt32BE(payload.length,16); return Buffer.concat([header,padded]);
}
test('Quick registry extension inventory is exhaustive', () => assert.deepEqual(registry.SUPPORTED_EXTENSIONS.sort(), ['.ai','.ait','.psd','.psb','.indd','.idml','.prproj','.aep','.aet','.pptx','.ppt','.key','.fig'].sort()));
for (const ext of ['.ai','.ait']) test(ext+' PDF fallback captures duplicate/missing paths and copies byte-exact master/asset', async t => {
  const {root,asset,missing}=workspace(t); const master=path.join(root,'document'+ext); fs.writeFileSync(master,pdfWithMetadataPaths([asset,asset,missing]));
  const refs=await registry.getParser(master).extractAssets(master); assert.deepEqual(refs.map(r=>[r.path,r.exists]), [[asset,true],[missing,false]]);
  const result=await checkPackage(t,master,{assetsFound:2}); assert.equal(result.assetsMissing.length,1);
});
for (const ext of ['.aep','.aet']) test(ext+' RIFX chunk fallback deduplicates paths; packages bytes without relinking', async t => {
  const {root,asset,missing}=workspace(t); const master=path.join(root,'document'+ext); fs.writeFileSync(master,rifx([asset,asset,missing]));
  assert.deepEqual((await registry.getParser(master).extractAssets(master)).map(r=>[r.path,r.exists]), [[asset,true],[missing,false]]);
  await checkPackage(t,master,{assetsFound:2});
});
test('IDML real ZIP and XML captures percent encoded duplicate/missing refs; copied link XML stays absolute', async t => {
  const {root,asset,missing}=workspace(t); const uri=p=>'file://'+p.split('/').map(encodeURIComponent).join('/');
  const markup=`<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"><Link LinkResourceURI="${uri(asset)}"/><Link LinkResourceURI="${uri(asset)}"/><Link LinkResourceURI="${uri(missing)}"/></idPkg:Spread>`;
  const master=zip(root,'document.idml',{'mimetype':'application/vnd.adobe.indesign-idml-package','designmap.xml':'<Document/>','Spreads/Spread_u1.xml':markup});
  assert.deepEqual((await registry.getParser(master).extractAssets(master)).map(r=>[r.path,r.exists]),[[asset,true],[missing,false]]);
  const result=await checkPackage(t,master,{assetsFound:2}); assert.equal(cp.execFileSync('/usr/bin/unzip',['-p',result.files[0].copied,'Spreads/Spread_u1.xml'],{encoding:'utf8'}),markup);
});
test('PRPROJ real gzip/XML deduplicates references and preserves source bytes and linked asset', async t => {
  const {root,asset,missing}=workspace(t); const master=path.join(root,'document.prproj');
  fs.writeFileSync(master,zlib.gzipSync(`<PremiereData Version="3"><ActualMediaFilePath>${xml(asset)}</ActualMediaFilePath><FilePath>${xml(asset)}</FilePath><FilePath>${xml(missing)}</FilePath></PremiereData>`));
  assert.deepEqual((await registry.getParser(master).extractAssets(master)).map(r=>[r.path,r.exists]), [[asset,true],[missing,false]]);
  await checkPackage(t,master,{assetsFound:2});
});
for (const ext of ['.pptx','.key']) test(ext+' actual ZIP extracts exact media bytes and reports actual files', async t => {
  const {root}=workspace(t), bytes=Buffer.alloc(1600,37), prefix=ext==='.pptx'?'ppt/media/':'Data/';
  const entries={ [prefix+'picture.png']:bytes, 'Metadata/marker.txt':'source structure unchanged' };
  if(ext==='.pptx') entries['ppt/slides/_rels/slide1.xml.rels']=`<Relationships xmlns="${NS}"/>`;
  const master=zip(root,'document'+ext,entries); const result=await checkPackage(t,master); assert.deepEqual(fs.readFileSync(result.files.find(x=>x.source==='embedded').copied),bytes);
});
test('PPTX real compressed relationships deduplicate external source, copy bytes, rewrite link targets; XML rewrite is not native portability proof', async t=>{
  const {root,asset}=workspace(t); const relationships=`<Relationships xmlns="${NS}"><Relationship Id="a" Type="${TYPE}" Target="${xml('file://'+asset)}" TargetMode="External"/><Relationship Id="b" Type="${TYPE}" Target="${xml('file://'+asset)}" TargetMode="External"/></Relationships>`;
  const master=zip(root,'linked.pptx',{'ppt/slides/_rels/slide1.xml.rels':relationships,'ppt/slides/slide1.xml':'<slide/>'});
  const refs=await registry.getParser(master).extractAssets(master); assert.equal(refs.length,1); assert.equal(refs[0].path,asset);
  const result=await checkPackage(t,master,{unchanged:false}); const {inspectLinks}=requireSource('./parsers/ooxml-links');
  const rewritten=inspectLinks(fs.readFileSync(result.files[0].copied),result.files[0].copied); assert.equal(rewritten.length,2); assert.ok(rewritten.every(r=>r.resolvedPath===result.files[1].copied));
});
test('PPTX missing linked source refuses package even default skipMissing; no partial files remain',async t=>{
 const {root,missing}=workspace(t), master=zip(root,'missing.pptx',{'ppt/slides/_rels/slide1.xml.rels':`<Relationships xmlns="${NS}"><Relationship Id="a" Type="${TYPE}" Target="${missing}" TargetMode="External"/></Relationships>`});
 const out=path.join(root,'out'); await assert.rejects(registry.packageMasterFile(master,out),/unavailable/); assert.equal(files(out).length,0);
});
for(const ext of ['.psd','.psb']) test(ext+' real ag-psd linked resource captures existing and missing structured dependencies',async t=>{
 const {root,asset,missing}=workspace(t), master=path.join(root,'document'+ext); fs.writeFileSync(master,psd([asset,missing],ext==='.psb'));
 const decoded=agPsd.readPsd(fs.readFileSync(master),{throwForMissingFeatures:true,skipLayerImageData:true,skipCompositeImageData:true,skipThumbnail:true}); assert.deepEqual(decoded.linkedFiles.map(x=>x.linkedFile.fullPath),[asset,missing]);
 const refs=await registry.getParser(master).extractAssets(master); assert.deepEqual(refs.map(r=>[r.path,r.exists]),[[asset,true],[missing,false]]);
 const result=await checkPackage(t,master,{assetsFound:2,assetsCopied:1}); assert.equal(result.assetsMissing.length,1);
});
test('legacy PPT explicitly has no asset parser; container-header boundary only',async t=>{
 const {root}=workspace(t), master=path.join(root,'unsupported.ppt'); fs.writeFileSync(master,Buffer.from('d0cf11e0a1b11ae10000000000000000','hex'));
 assert.deepEqual(await registry.getParser(master).extractAssets(master),[]); await checkPackage(t,master,{assetsFound:0,assetsCopied:0});
});
test('local FIG explicitly rejects before network or output creation',async t=>{
 const {root}=workspace(t), master=path.join(root,'unsupported.fig'); fs.writeFileSync(master,'fig-kiwi');
 await assert.rejects(registry.getParser(master).extractAssets(master),/cloud-based/); const out=path.join(root,'out'); await assert.rejects(registry.packageMasterFile(master,out),/cloud-based/); assert.equal(files(out).length,0);
});
test('INDD raw-byte fallback boundary captures path but native compound-document fixture remains uncovered',async t=>{
 const {root,asset}=workspace(t), master=path.join(root,'fallback.indd'); fs.writeFileSync(master,Buffer.concat([Buffer.from([0,255]),Buffer.from(asset+'\0')]));
 assert.equal((await registry.getParser(master).extractAssets(master))[0].path,asset); await checkPackage(t,master);
});
