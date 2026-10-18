'use strict';

// Bounded OPC ZIP/relationship handling. Never fetches a URI or writes sources.
const path = require('node:path');
const zlib = require('node:zlib');
const { TextDecoder } = require('node:util');
const MAX_ARCHIVE = 256 * 1024 * 1024;
const MAX_XML = 4 * 1024 * 1024;
const MAX_ENTRIES = 20000;
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const decoder = new TextDecoder('utf-8', { fatal: true });
function invalid(reason = 'invalid_archive') { return Object.assign(new Error(reason), { code: 'package_relationship_invalid' }); }
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function readArchive(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_ARCHIVE || buffer.length < 22) throw invalid();
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { end = i; break; }
  }
  if (end < 0 || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)) throw invalid();
  const count = buffer.readUInt16LE(end + 10), offset = buffer.readUInt32LE(end + 16), size = buffer.readUInt32LE(end + 12);
  if (count !== buffer.readUInt16LE(end + 8) || count > MAX_ENTRIES || offset + size !== end) throw invalid();
  const entries = [], names = new Set(), ranges = []; let cursor = offset, total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw invalid();
    const flags = buffer.readUInt16LE(cursor + 8), method = buffer.readUInt16LE(cursor + 10), compressedSize = buffer.readUInt32LE(cursor + 20), uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28), extraLength = buffer.readUInt16LE(cursor + 30), commentLength = buffer.readUInt16LE(cursor + 32), localOffset = buffer.readUInt32LE(cursor + 42);
    const centralEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (centralEnd > end || flags & 1 || ![0, 8].includes(method) || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff || buffer.readUInt16LE(cursor + 34)) throw invalid();
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength), name = decoder.decode(nameBytes);
    if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').some(s => s === '..' || s === '.') || /[\x00-\x1f]/u.test(name) || names.has(name)) throw invalid();
    names.add(name); total += uncompressedSize;
    if (total > MAX_ARCHIVE || localOffset + 30 > offset || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw invalid();
    const localNameLength = buffer.readUInt16LE(localOffset + 26), localExtraLength = buffer.readUInt16LE(localOffset + 28), dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > offset || buffer.readUInt16LE(localOffset + 6) !== flags || buffer.readUInt16LE(localOffset + 8) !== method || !nameBytes.equals(buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength))) throw invalid();
    ranges.push([localOffset, dataStart + compressedSize]);
    entries.push({ name, flags, method, compressedSize, uncompressedSize, crc: buffer.readUInt32LE(cursor + 16), nameBytes, central: buffer.subarray(cursor, centralEnd), local: buffer.subarray(localOffset, dataStart), data: buffer.subarray(dataStart, dataStart + compressedSize) });
    cursor = centralEnd;
  }
  if (cursor !== end) throw invalid();
  ranges.sort((a,b) => a[0]-b[0]);
  if (ranges.some((range,i) => i && range[0] < ranges[i-1][1])) throw invalid();
  return entries;
}
function inflate(entry) {
  if (entry.uncompressedSize > MAX_XML) throw invalid('relationship_part_too_large');
  const data = entry.method === 0 ? entry.data : zlib.inflateRawSync(entry.data, { maxOutputLength: MAX_XML });
  if (data.length !== entry.uncompressedSize || crc32(data) !== entry.crc) throw invalid();
  return data;
}
function xmlValue(value) {
  return value.replace(/&([^;]+);/gu, (_, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity)) return named[entity];
    const match = entity.match(/^#(x[\da-f]+|\d+)$/iu);
    if (!match) throw invalid('invalid_xml_entity');
    const point = match[1][0].toLowerCase() === 'x' ? parseInt(match[1].slice(1), 16) : Number(match[1]);
    if (!Number.isInteger(point) || point < 32 || point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) throw invalid('invalid_xml_entity');
    return String.fromCodePoint(point);
  });
}
function relationshipParts(xml) {
  if (xml.length > MAX_XML || /<!DOCTYPE|<!ENTITY|<!\[CDATA\[/iu.test(xml)) throw invalid('unsafe_relationship_xml');
  const records = [], ids = new Set(), stack = []; let cursor = 0, namespace = null, rootSeen = false;
  const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/?[A-Za-z_][\w.:-]*(?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*\/?>/gu;
  for (const token of xml.matchAll(tokens)) {
    if (xml.slice(cursor, token.index).trim()) throw invalid('invalid_relationship_xml');
    cursor = token.index + token[0].length;
    if (token[0].startsWith('<!--') || token[0].startsWith('<?')) continue;
    const raw = token[0], closing = raw.startsWith('</'), name = raw.match(/^<\/?([^\s/>]+)/u)[1], local = name.split(':').pop();
    if (closing) { if (stack.pop() !== name || !/\S/u.test(name)) throw invalid(); continue; }
    const attrs = new Map(), attrPattern = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(["'])([^]*?)\2/gu;
    for (const a of raw.matchAll(attrPattern)) {
      if (attrs.has(a[1]) || /&(?!amp;|lt;|gt;|quot;|apos;|#(?:x[\da-f]+|\d+);)/iu.test(a[3])) throw invalid();
      const start = token.index + a.index + a[0].indexOf(a[2]) + 1;
      attrs.set(a[1], { value: xmlValue(a[3]), start, end: start + a[3].length });
    }
    if (!stack.length) {
      if (rootSeen || local !== 'Relationships') throw invalid(); rootSeen = true;
      const prefix = name.includes(':') ? name.split(':')[0] : '';
      namespace = attrs.get(prefix ? 'xmlns:' + prefix : 'xmlns')?.value;
      if (namespace !== REL_NS) throw invalid('invalid_relationship_namespace');
    } else {
      if (stack.length !== 1 || local !== 'Relationship') throw invalid();
      const rootPrefix = stack[0].includes(':') ? stack[0].split(':')[0] : '';
      if (name !== (rootPrefix ? rootPrefix + ':' : '') + 'Relationship') throw invalid();
      if ([...attrs.keys()].some(key => key === 'xmlns' || key.startsWith('xmlns:'))) throw invalid('relationship_namespace_override');
      const id = attrs.get('Id')?.value, type = attrs.get('Type')?.value, target = attrs.get('Target');
      if (!id || ids.has(id) || !type || !target) throw invalid(); ids.add(id);
      if (attrs.has('TargetMode') && !['Internal', 'External'].includes(attrs.get('TargetMode').value)) throw invalid('invalid_target_mode');
      if (attrs.get('TargetMode')?.value === 'External' && /\/(?:image|audio|video|oleObject|package)$/u.test(type)) records.push({ id, type, ...target });
    }
    if (!raw.endsWith('/>')) stack.push(name);
  }
  if (!rootSeen || stack.length || xml.slice(cursor).trim()) throw invalid('invalid_relationship_xml');
  return records;
}
function resolveLocalTarget(documentPath, target) {
  if (typeof target !== 'string' || target.length > 16384 || /[\x00-\x1f\\]/u.test(target) || /[?#]/u.test(target)) throw invalid('unsupported_external_target');
  let local;
  if (/^file:/iu.test(target)) {
    // Native PowerPoint emits file:////Users/...; tolerate extra local slashes,
    // but never turn a network authority into a local path.
    const match = target.match(/^file:\/\/(?:localhost(?=\/))?(\/.*)$/iu);
    if (!match) throw invalid('unsupported_file_authority');
    local = decodeURIComponent(match[1]);
    local = '/' + local.replace(/^\/+/, '');
  } else {
    if (/^[a-z][\w+.-]*:/iu.test(target) || target.startsWith('//')) throw invalid('unsupported_external_protocol');
    local = decodeURIComponent(target);
    local = path.resolve(path.dirname(documentPath), local);
  }
  if (!local || /[\x00-\x1f]/u.test(local) || !path.isAbsolute(local)) throw invalid('invalid_external_path');
  return path.normalize(local);
}
function inspectLinksUnchecked(buffer, documentPath) {
  const entries = readArchive(buffer), links = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.rels')) continue;
    const xml = decoder.decode(inflate(entry));
    for (const rel of relationshipParts(xml)) links.push({ part: entry.name, id: rel.id, type: rel.type, target: rel.value, resolvedPath: resolveLocalTarget(documentPath, rel.value), start: rel.start, end: rel.end });
  }
  return links;
}
function inspectLinks(buffer, documentPath) {
  try { return inspectLinksUnchecked(buffer, documentPath); }
  catch (error) { if (error?.code === 'package_relationship_invalid') throw error; throw invalid('invalid_relationship_archive'); }
}
function escapeXml(value) { return value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll("'",'&apos;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }
function rewriteLinksBasic(buffer, documentPath, replacements) {
  const entries = readArchive(buffer), links = inspectLinks(buffer, documentPath);
  if (!links.length) return buffer;
  if (entries.some(e => e.name.startsWith('_xmlsignatures/'))) throw invalid('signed_document_requires_native_relink');
  const locals = [], centrals = []; let offset = 0;
  for (const entry of entries) {
    let data = entry.data, size = entry.uncompressedSize, crc = entry.crc;
    const changes = links.filter(link => link.part === entry.name);
    if (changes.length) {
      let xml = decoder.decode(inflate(entry));
      for (const link of changes.sort((a,b)=>b.start-a.start)) {
        const replacement = replacements[link.resolvedPath];
        if (typeof replacement !== 'string' || !replacement || /^[a-z][\w+.-]*:/iu.test(replacement) || replacement.startsWith('/')) throw invalid('external_dependency_not_packaged');
        xml = xml.slice(0,link.start) + escapeXml(replacement) + xml.slice(link.end);
      }
      const uncompressed = Buffer.from(xml); size = uncompressed.length; crc = crc32(uncompressed);
      data = entry.method === 0 ? uncompressed : zlib.deflateRawSync(uncompressed);
    }
    const local = Buffer.from(entry.local), central = Buffer.from(entry.central);
    local.writeUInt16LE(entry.flags & ~8,6);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(size,22);
    central.writeUInt16LE(entry.flags & ~8,8);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(size,24);central.writeUInt32LE(offset,42);
    locals.push(local,data);centrals.push(central);offset += local.length+data.length;
  }
  const central = Buffer.concat(centrals), end = Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);
  const result = Buffer.concat([...locals,central,end]);if(result.length>MAX_ARCHIVE)throw invalid('archive_too_large');return result;
}


const crypto = require('node:crypto');
const DRAWING_NAMESPACES = new Set(['http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main']);
const OFFICE_REL_NAMESPACES = new Set(['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships']);
const CONTENT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
// Namespace-aware bounded XML tokenization. Source offsets allow additive edits;
// existing slide XML, attributes, links and embedded relationships are preserved.
function partXml(xml) {
  if (Buffer.byteLength(xml) > MAX_XML || /<!DOCTYPE|<!ENTITY|<!\[CDATA\[/iu.test(xml)) throw invalid('unsafe_picture_xml');
  const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/?[A-Za-z_][\w.:-]*(?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*\/?>/gu;
  const stack = [], nodes = []; let cursor = 0, root = null, rootClose = null;
  for (const token of xml.matchAll(tokens)) {
    const between = xml.slice(cursor,token.index);
    if (between.includes('<') || (!stack.length && between.trim())) throw invalid('invalid_picture_xml');
    cursor = token.index + token[0].length;
    if (token[0].startsWith('<!--') || token[0].startsWith('<?')) continue;
    const raw = token[0], closing = raw.startsWith('</'), name = raw.match(/^<\/?([^\s/>]+)/u)[1];
    if (closing) { const previous = stack.pop(); if (!previous || previous.name !== name) throw invalid('invalid_picture_xml'); if (!stack.length) rootClose=token.index; continue; }
    const rawAttrs=new Map(), attrs=[];
    for (const a of raw.matchAll(/\s+([A-Za-z_][\w.:-]*)\s*=\s*(["'])([^]*?)\2/gu)) {
      if (rawAttrs.has(a[1]) || /&(?!amp;|lt;|gt;|quot;|apos;|#(?:x[\da-f]+|\d+);)/iu.test(a[3])) throw invalid('invalid_picture_attribute');
      rawAttrs.set(a[1],xmlValue(a[3]));
    }
    const namespaces=new Map(stack.length?stack[stack.length-1].namespaces:[]);
    for(const [key,value]of rawAttrs)if(key==='xmlns')namespaces.set('',value);else if(key.startsWith('xmlns:'))namespaces.set(key.slice(6),value);
    const split = key => { const parts=key.split(':'); if(parts.length>2)throw invalid('invalid_picture_namespace'); return parts.length===2?parts:['',key]; };
    const [prefix,local]=split(name),uri=namespaces.get(prefix)||'';
    if(prefix&&!uri)throw invalid('invalid_picture_namespace');
    const expanded=new Set();
    for(const [key,value]of rawAttrs){if(key==='xmlns'||key.startsWith('xmlns:'))continue;const[p,l]=split(key),u=p?(namespaces.get(p)||''):'';if(p&&!u)throw invalid('invalid_picture_namespace');const identity=u+'\0'+l;if(expanded.has(identity))throw invalid('duplicate_picture_attribute');expanded.add(identity);attrs.push({name:key,prefix:p,local:l,uri:u,value});}
    const node={name,local,uri,attrs,namespaces,start:token.index,end:cursor,selfClosing:raw.endsWith('/>')};
    if(!stack.length){if(root)throw invalid('invalid_picture_xml');root=node;}
    nodes.push(node);if(!node.selfClosing)stack.push(node);else if(node===root)rootClose=node.start;
  }
  if(!root||stack.length||xml.slice(cursor).trim())throw invalid('invalid_picture_xml');
  return {nodes,root,rootClose};
}
function pictureType(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_ARCHIVE) throw invalid('portable_picture_bytes_unavailable');
  if (bytes.length >= 8 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return {extension:'png',mime:'image/png'};
  if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return{extension:'jpg',mime:'image/jpeg'};
  if(bytes.subarray(0,6).toString()==='GIF87a'||bytes.subarray(0,6).toString()==='GIF89a')return{extension:'gif',mime:'image/gif'};
  if(bytes.length>=4&&(bytes.subarray(0,4).equals(Buffer.from([73,73,42,0]))||bytes.subarray(0,4).equals(Buffer.from([77,77,0,42]))))return{extension:'tiff',mime:'image/tiff'};
  if(bytes.length>=2&&bytes.subarray(0,2).toString()==='BM')return{extension:'bmp',mime:'image/bmp'};
  throw invalid('unsupported_portable_picture_format');
}
function rebuildArchive(entries, updates, additions) {
  if(entries.length+additions.length>MAX_ENTRIES)throw invalid('archive_too_many_entries');
  const locals=[],centrals=[];let offset=0,total=0;
  for(const entry of [...entries,...additions]){
    const bytes=updates.get(entry.name);let data=entry.data,size=entry.uncompressedSize,crc=entry.crc;
    if(bytes){size=bytes.length;crc=crc32(bytes);data=entry.method===0?bytes:zlib.deflateRawSync(bytes);}
    if(bytes && /\.(?:xml|rels)$/u.test(entry.name) && size>MAX_XML)throw invalid('picture_part_too_large');
    total+=size;if(total>MAX_ARCHIVE)throw invalid('archive_too_large');
    const local=Buffer.from(entry.local),central=Buffer.from(entry.central);
    local.writeUInt16LE(entry.flags&~8,6);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(size,22);
    central.writeUInt16LE(entry.flags&~8,8);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(size,24);central.writeUInt32LE(offset,42);
    locals.push(local,data);centrals.push(central);offset+=local.length+data.length;
  }
  const central=Buffer.concat(centrals),end=Buffer.alloc(22),count=entries.length+additions.length;end.writeUInt32LE(0x06054b50);end.writeUInt16LE(count,8);end.writeUInt16LE(count,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);
  const result=Buffer.concat([...locals,central,end]);if(result.length>MAX_ARCHIVE)throw invalid('archive_too_large');return result;
}
function newArchiveEntry(name) {
  const nameBytes=Buffer.from(name),local=Buffer.alloc(30+nameBytes.length),central=Buffer.alloc(46+nameBytes.length);
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);nameBytes.copy(local,30);local.writeUInt16LE(nameBytes.length,26);
  central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(nameBytes.length,28);nameBytes.copy(central,46);
  return{name,flags:0x800,method:0,uncompressedSize:0,crc:0,data:Buffer.alloc(0),local,central};
}
function addPictureCopies(buffer, originalLinks, pictureData) {
  const links=originalLinks.filter(link=>/\/image$/u.test(link.type));if(!links.length)return buffer;
  for (const link of links) {
    if (![...OFFICE_REL_NAMESPACES].some(uri => link.type === uri + '/image')) throw invalid('unsupported_picture_relationship_type');
  }
  const entries=readArchive(buffer),byName=new Map(entries.map(e=>[e.name,e])),updates=new Map(),additions=[],mediaByDigest=new Map(),contentOverrides=[];
  const text=name=>{const entry=byName.get(name);if(!entry)throw invalid('picture_part_missing');return decoder.decode(inflate(entry));};
  for(const part of new Set(links.map(link=>link.part))){
    const match=part.match(/^(.*\/)??_rels\/([^/]+)\.rels$/u);if(!match)throw invalid('unsupported_picture_relationship_part');
    const owner=(match[1]||'')+match[2];let xml=text(owner),rels=text(part);const parsed=partXml(xml),relationships=partXml(rels);
    if(relationships.root.uri!==REL_NS||relationships.root.local!=='Relationships')throw invalid('invalid_relationship_namespace');
    const ids=new Set(relationships.nodes.filter(n=>n.local==='Relationship').map(n=>n.attrs.find(a=>a.name==='Id')?.value));
    const edits=[],newRels=[];
    for(const link of links.filter(l=>l.part===part)){
      const blips=parsed.nodes.filter(n=>DRAWING_NAMESPACES.has(n.uri)&&n.local==='blip'&&n.attrs.some(a=>OFFICE_REL_NAMESPACES.has(a.uri)&&a.local==='link'&&a.value===link.id));
      if(!blips.length)throw invalid('unsupported_picture_reference');
      for (const node of blips) {
        const embed = node.attrs.find(a => OFFICE_REL_NAMESPACES.has(a.uri) && a.local === 'embed');
        if (!embed) continue;
        const rel = relationships.nodes.find(n => n.uri === REL_NS && n.local === 'Relationship' && n.attrs.some(a => a.name === 'Id' && a.value === embed.value));
        const attribute = name => rel?.attrs.find(a => a.name === name)?.value;
        const target = attribute('Target');
        if (!rel || ![...OFFICE_REL_NAMESPACES].some(uri => attribute('Type') === uri + '/image') ||
            ![undefined, 'Internal'].includes(attribute('TargetMode')) || !target || /[?#\\\x00-\x1f]/u.test(target) ||
            /^[a-z][\w+.-]*:/iu.test(target) || target.startsWith('//')) throw invalid('invalid_existing_picture_embed');
        const decoded = decodeURIComponent(target);
        if (/[\\\x00-\x1f]/u.test(decoded)) throw invalid('invalid_existing_picture_embed');
        const name = path.posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : path.posix.join(path.posix.dirname(owner), decoded));
        const entry = byName.get(name);
        if (name.startsWith('../') || !entry || entry.name.endsWith('/') || !entry.uncompressedSize) throw invalid('invalid_existing_picture_embed');
      }
      const needs=blips.filter(n=>!n.attrs.some(a=>OFFICE_REL_NAMESPACES.has(a.uri)&&a.local==='embed'));
      if(!needs.length)continue; // Preserve existing embedded representation exactly.
      if(!Object.hasOwn(pictureData,link.resolvedPath))throw invalid('portable_picture_bytes_unavailable');
      const bytes=pictureData[link.resolvedPath],type=pictureType(bytes),digest=crypto.createHash('sha256').update(bytes).digest('hex');
      let media=mediaByDigest.get(digest);
      if(!media){let suffix=0;do{media=`ppt/media/crate-portable-${digest}${suffix?'-'+suffix:''}.${type.extension}`;suffix++;}while(byName.has(media)||additions.some(e=>e.name===media));mediaByDigest.set(digest,media);additions.push(newArchiveEntry(media));updates.set(media,bytes);contentOverrides.push({name:media,mime:type.mime});}
      let index=1,id;do{id='rIdCratePortable'+index++;}while(ids.has(id));ids.add(id);
      const relPrefix=relationships.root.name.includes(':')?relationships.root.name.split(':')[0]+':':'';
      newRels.push(`<${relPrefix}Relationship Id="${id}" Type="${escapeXml(link.type)}" Target="${escapeXml(path.posix.relative(path.posix.dirname(owner),media))}"/>`);
      for(const node of needs){const attribute=node.attrs.find(a=>OFFICE_REL_NAMESPACES.has(a.uri)&&a.local==='link'&&a.value===link.id);edits.push({offset:node.end-(node.selfClosing?2:1),value:` ${attribute.prefix}:embed="${id}"`});}
    }
    for(const edit of edits.sort((a,b)=>b.offset-a.offset))xml=xml.slice(0,edit.offset)+edit.value+xml.slice(edit.offset);
    if(newRels.length){rels=rels.slice(0,relationships.rootClose)+newRels.join('')+rels.slice(relationships.rootClose);updates.set(part,Buffer.from(rels));updates.set(owner,Buffer.from(xml));}
  }
  if(!additions.length)return buffer;
  let types=text('[Content_Types].xml');const parsedTypes=partXml(types);if(parsedTypes.root.uri!==CONTENT_NS||parsedTypes.root.local!=='Types'||parsedTypes.root.selfClosing)throw invalid('invalid_content_types');
  const prefix=parsedTypes.root.name.includes(':')?parsedTypes.root.name.split(':')[0]+':':'';
  const newTypes=contentOverrides.map(item=>`<${prefix}Override PartName="/${escapeXml(item.name)}" ContentType="${item.mime}"/>`).join('');
  types=types.slice(0,parsedTypes.rootClose)+newTypes+types.slice(parsedTypes.rootClose);updates.set('[Content_Types].xml',Buffer.from(types));
  return rebuildArchive(entries,updates,additions);
}
function rewriteLinks(buffer, documentPath, replacements, options = {}) {
  try {
    // Existing link-only behavior remains the default. Exact replacement map is
    // checked first for every dependency, including already-embedded pictures.
    const linked=rewriteLinksBasic(buffer,documentPath,replacements);
    if(options.portablePictures!==true)return linked;
    return addPictureCopies(linked,inspectLinks(buffer,documentPath),options.assetBytes||options.pictureData||Object.create(null));
  }catch(error){if(error?.code==='package_relationship_invalid')throw error;throw invalid('invalid_portable_picture_archive');}
}
module.exports = { inspectLinks, rewriteLinks, resolveLocalTarget, relationshipParts, readArchive };
