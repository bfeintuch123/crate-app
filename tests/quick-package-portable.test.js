'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const {packageMasterFile}=require('../parsers');
const {inspectLinks,readArchive}=require('../parsers/ooxml-links');
function fixture(t,targets){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'crate-quick-portable-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const zip=path.join(root,'zip');fs.mkdirSync(path.join(zip,'ppt/slides/_rels'),{recursive:true});
 const xml='<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+targets.map((target,i)=>`<Relationship Id="r${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}" TargetMode="External"/>`).join('')+'</Relationships>';
 fs.writeFileSync(path.join(zip,'ppt/slides/_rels/slide1.xml.rels'),xml);const deck=path.join(root,'Deck.pptx');cp.execFileSync('/usr/bin/zip',['-q','-r',deck,'ppt'],{cwd:zip});const out=path.join(root,'out');fs.mkdirSync(out);return {root,deck,out};
}
test('Quick Package relinks duplicate targets and filename collisions; relocated dependencies survive',async t=>{
 const f=fixture(t,['a/image.png','b/image.png','./a/image.png']);for(const name of ['a','b']){fs.mkdirSync(path.join(f.root,name));fs.writeFileSync(path.join(f.root,name,'image.png'),name);}
 fs.writeFileSync(path.join(f.out,'image.png'),'existing');const original=fs.readFileSync(f.deck);const result=await packageMasterFile(f.deck,f.out);assert.equal(result.assetsCopied,2);assert.equal(fs.readFileSync(path.join(f.out,'image.png'),'utf8'),'existing');
 const relocated=path.join(f.root,'relocated');fs.cpSync(f.out,relocated,{recursive:true});fs.renameSync(path.join(f.root,'a'),path.join(f.root,'a-unavailable'));fs.renameSync(path.join(f.root,'b'),path.join(f.root,'b-unavailable'));
 const output=path.join(relocated,path.basename(result.files[0].copied));const links=inspectLinks(fs.readFileSync(output),output);assert.equal(links.length,3);assert.deepEqual(links.map(l=>fs.readFileSync(l.resolvedPath,'utf8')),['a','b','a']);assert.deepEqual(fs.readFileSync(f.deck),original);
});
for(const target of ['missing.png','bad%XX.png'])test('Quick Package fails closed without output: '+target,async t=>{const f=fixture(t,[target]);await assert.rejects(packageMasterFile(f.deck,f.out));assert.deepEqual(fs.readdirSync(f.out),[]);});
test('Quick Package refuses corrupt compressed relationship XML without output',async t=>{
 const f=fixture(t,['a.png']);const buffer=fs.readFileSync(f.deck),entry=readArchive(buffer).find(e=>e.name.endsWith('.rels'));assert.equal(entry.method,8);buffer.fill(0xff,entry.data.byteOffset-buffer.byteOffset,entry.data.byteOffset-buffer.byteOffset+entry.data.length);fs.writeFileSync(f.deck,buffer);
 await assert.rejects(packageMasterFile(f.deck,f.out));assert.deepEqual(fs.readdirSync(f.out),[]);
});

test('Quick Package inspects a valid ZIP with a non-PK prefix',async t=>{
 const f=fixture(t,['a.png']);fs.writeFileSync(path.join(f.root,'a.png'),'linked bytes');const original=fs.readFileSync(f.deck),prefix=Buffer.from('prefix');
 const end=original.length-22,centralStart=original.readUInt32LE(end+16);let cursor=centralStart;
 while(cursor<end){original.writeUInt32LE(original.readUInt32LE(cursor+42)+prefix.length,cursor+42);cursor+=46+original.readUInt16LE(cursor+28)+original.readUInt16LE(cursor+30)+original.readUInt16LE(cursor+32);}
 original.writeUInt32LE(centralStart+prefix.length,end+16);fs.writeFileSync(f.deck,Buffer.concat([prefix,original]));
 const result=await packageMasterFile(f.deck,f.out);assert.equal(result.assetsCopied,1);const master=result.files.find(x=>x.source==='master').copied;const links=inspectLinks(fs.readFileSync(master),master);assert.equal(fs.readFileSync(links[0].resolvedPath,'utf8'),'linked bytes');
});
