'use strict';

// Font handoff: a bounded font-file reader, location classes, the inclusion
// gate and the fonts note. Pure functions only; main.js owns I/O and IPC.
//
// Four checks stay separate and none can stand in for another:
//   name match   - the registry returned exactly the requested PostScript name
//   face/file    - that face (or named instance) is inside this file
//   version      - reported, never proven
//   permission   - the gate below; being installed, readable or matched never
//                  establishes permission by itself.

const path = require('path');

const GATED_FONT_EXTENSIONS = new Set(['.otf', '.ttf', '.ttc', '.otc']);
const MAX_FONT_FILE_BYTES = 100 * 1024 * 1024;
const MAX_FONT_TABLES = 256;
const MAX_COLLECTION_FACES = 64;
const MAX_NAME_RECORDS = 4096;
const MAX_FVAR_INSTANCES = 1024;
const MAX_FONT_NAME_TEXT_LENGTH = 4000;
const MAX_FONT_IDENTITY_TEXT_LENGTH = 255;

const FONTS_NOTE_FILENAME = 'Fonts in this package.txt';
const OFL_TEXT_FILENAME = 'SIL Open Font License 1.1.txt';
// Draft product copy pending Bryant/legal review. Bumping the version
// invalidates earlier confirmations because each records the wording it saw.
const FONT_CONFIRMATION_WORDING_VERSION = 'draft-2026-11-11-v1';

class FontReadError extends Error {
  constructor(code) {
    super(`font_${code}`);
    this.name = 'FontReadError';
    this.code = code;
  }
}

const MAC_ROMAN_HIGH = 'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø' +
  '¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';

function decodeMacRoman(buffer) {
  let text = '';
  for (const byte of buffer) text += byte < 0x80 ? String.fromCharCode(byte) : MAC_ROMAN_HIGH[byte - 0x80];
  return text;
}

function decodeUtf16be(buffer) {
  let text = '';
  for (let offset = 0; offset + 1 < buffer.length; offset += 2) text += String.fromCharCode(buffer.readUInt16BE(offset));
  return text;
}

function cleanFontText(value, limit = MAX_FONT_NAME_TEXT_LENGTH) {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '')
    .trim();
  if (!cleaned) return null;
  return [...cleaned].slice(0, limit).join('');
}

function cleanIdentityText(value) {
  const cleaned = cleanFontText(value, MAX_FONT_IDENTITY_TEXT_LENGTH);
  return cleaned ? cleaned.replace(/\n/g, ' ') : null;
}

function need(buffer, offset, length) {
  if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new FontReadError('malformed');
  }
}

// Every read inside a table must stay inside that table's declared span, so a
// malformed file cannot borrow names or licence text from elsewhere.
function needIn(buffer, table, offset, length) {
  need(buffer, offset, length);
  if (offset < table.offset || offset + length > table.offset + table.length) throw new FontReadError('malformed');
}

// English only: Windows US English, then Macintosh Roman English, then Unicode.
// Other-language Windows records are never used, even when listed first.
function nameRecordScore(platform, encoding, language) {
  if (platform === 3 && (encoding === 0 || encoding === 1 || encoding === 10) && language === 0x0409) return 3;
  if (platform === 1 && encoding === 0 && language === 0) return 2;
  if (platform === 0) return 1;
  return 0;
}

function readNameTable(buffer, table) {
  if (!table) return new Map();
  needIn(buffer, table, table.offset, 6);
  const count = buffer.readUInt16BE(table.offset + 2);
  const storage = table.offset + buffer.readUInt16BE(table.offset + 4);
  if (count > MAX_NAME_RECORDS) throw new FontReadError('malformed');
  needIn(buffer, table, table.offset + 6, count * 12);
  const best = new Map();
  for (let index = 0; index < count; index++) {
    const base = table.offset + 6 + index * 12;
    const platform = buffer.readUInt16BE(base);
    const encoding = buffer.readUInt16BE(base + 2);
    const language = buffer.readUInt16BE(base + 4);
    const nameId = buffer.readUInt16BE(base + 6);
    const length = buffer.readUInt16BE(base + 8);
    const offset = storage + buffer.readUInt16BE(base + 10);
    const score = nameRecordScore(platform, encoding, language);
    needIn(buffer, table, offset, length);
    if (!score || (best.get(nameId)?.score || 0) >= score) continue;
    const raw = buffer.subarray(offset, offset + length);
    best.set(nameId, { score, text: platform === 1 ? decodeMacRoman(raw) : decodeUtf16be(raw) });
  }
  return new Map([...best].map(([nameId, record]) => [nameId, record.text]));
}

function readFvar(buffer, table, names) {
  if (!table) return null;
  needIn(buffer, table, table.offset, 16);
  const axesOffset = buffer.readUInt16BE(table.offset + 4);
  const axisCount = buffer.readUInt16BE(table.offset + 8);
  const axisSize = buffer.readUInt16BE(table.offset + 10);
  const instanceCount = buffer.readUInt16BE(table.offset + 12);
  const instanceSize = buffer.readUInt16BE(table.offset + 14);
  if (instanceCount > MAX_FVAR_INSTANCES || instanceSize < axisCount * 4 + 4) throw new FontReadError('malformed');
  needIn(buffer, table, table.offset + axesOffset, axisCount * axisSize);
  const start = table.offset + axesOffset + axisCount * axisSize;
  needIn(buffer, table, start, instanceCount * instanceSize);
  const instances = [];
  for (let index = 0; index < instanceCount; index++) {
    const base = start + index * instanceSize;
    const styleId = buffer.readUInt16BE(base);
    const psId = instanceSize >= axisCount * 4 + 6 ? buffer.readUInt16BE(base + 4 + axisCount * 4) : 0xffff;
    instances.push({
      style: cleanIdentityText(names.get(styleId)),
      postscriptName: psId === 0xffff ? null : cleanIdentityText(names.get(psId)),
    });
  }
  return instances;
}

function readFaceAt(buffer, offset, index) {
  need(buffer, offset, 12);
  const signature = buffer.readUInt32BE(offset);
  if (signature !== 0x00010000 && signature !== 0x4f54544f && signature !== 0x74727565) {
    throw new FontReadError('unsupported');
  }
  const tableCount = buffer.readUInt16BE(offset + 4);
  if (tableCount === 0 || tableCount > MAX_FONT_TABLES) throw new FontReadError('malformed');
  need(buffer, offset + 12, tableCount * 16);
  const tables = new Map();
  for (let table = 0; table < tableCount; table++) {
    const base = offset + 12 + table * 16;
    const tag = buffer.toString('latin1', base, base + 4);
    const tableOffset = buffer.readUInt32BE(base + 8);
    const length = buffer.readUInt32BE(base + 12);
    need(buffer, tableOffset, length);
    if (!tables.has(tag)) tables.set(tag, { offset: tableOffset, length });
  }
  const names = readNameTable(buffer, tables.get('name'));
  const os2 = tables.get('OS/2');
  let fsType = null;
  if (os2 && os2.length >= 10) fsType = buffer.readUInt16BE(os2.offset + 8);
  const namedInstances = readFvar(buffer, tables.get('fvar'), names);
  return {
    index,
    postscriptName: cleanIdentityText(names.get(6)),
    family: cleanIdentityText(names.get(16) || names.get(1)),
    style: cleanIdentityText(names.get(17) || names.get(2)),
    fullName: cleanIdentityText(names.get(4)),
    version: cleanIdentityText(names.get(5)),
    copyright: cleanFontText(names.get(0)),
    licence: cleanFontText(names.get(13)),
    licenceUrl: cleanIdentityText(names.get(14)),
    fsType,
    // OpenType OS/2 fsType bits 0-3: value 2 is "Restricted License embedding".
    restricted: fsType !== null && (fsType & 0x000f) === 0x0002,
    variable: namedInstances !== null,
    namedInstances: namedInstances || [],
  };
}

function readFontFaces(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) throw new FontReadError('malformed');
  if (buffer.length > MAX_FONT_FILE_BYTES) throw new FontReadError('too-large');
  try {
    if (buffer.toString('latin1', 0, 4) === 'ttcf') {
      const count = buffer.readUInt32BE(8);
      if (count === 0 || count > MAX_COLLECTION_FACES) throw new FontReadError('malformed');
      need(buffer, 12, count * 4);
      const faces = [];
      for (let index = 0; index < count; index++) faces.push(readFaceAt(buffer, buffer.readUInt32BE(12 + index * 4), index));
      return { collection: true, faces };
    }
    return { collection: false, faces: [readFaceAt(buffer, 0, 0)] };
  } catch (error) {
    if (error instanceof FontReadError) throw error;
    throw new FontReadError('malformed');
  }
}

// Exact, case-sensitive equality on the face's own PostScript name or on a
// variable font's named-instance PostScript name. Nothing looser counts.
function findFace(parsed, postscriptName) {
  if (!parsed || typeof postscriptName !== 'string' || !postscriptName) return null;
  for (const face of parsed.faces) if (face.postscriptName === postscriptName) return { faceIndex: face.index, via: 'face' };
  for (const face of parsed.faces) {
    if (face.namedInstances.some(instance => instance.postscriptName === postscriptName)) {
      return { faceIndex: face.index, via: 'named-instance' };
    }
  }
  return null;
}

function foldPath(value) {
  return `${value || ''}`.normalize('NFC').toLowerCase();
}

// Judged on the resolved real path, on any volume. Adobe's whole Application
// Support folder is excluded because Adobe Fonts storage is not documented
// precisely. Cloud-synced folders the user keeps files in are user files.
const LIBRARY_ROOT = '^(?:/volumes/[^/]+)?(?:/users/[^/]+)?/library/';
const inLibrary = suffix => new RegExp(`${LIBRARY_ROOT}${suffix}`);
const ADOBE_STORE = inLibrary('application support/adobe/');
const SYSTEM_ROOT = /^(?:\/volumes\/[^/]+)?\/(?:system|library\/apple|usr|bin|sbin|private\/var\/db)\//;
const CLOUD_SYNCED = [inLibrary('cloudstorage/'), inLibrary('mobile documents/com~apple~clouddocs/')];
const FONTS_FOLDER = inLibrary('fonts/');
const ANY_LIBRARY = inLibrary('');

function classifyFontLocation(realPath, homeDir) {
  if (typeof realPath !== 'string' || !path.isAbsolute(realPath) || realPath.includes('\0')) {
    return { kind: 'unknown', excludedReason: 'unreadable' };
  }
  let folded = foldPath(path.resolve(realPath));
  const home = typeof homeDir === 'string' && path.isAbsolute(homeDir) ? foldPath(path.resolve(homeDir)) : null;
  // The current user's home folder, wherever it is, maps onto the /Users/<name> pattern.
  if (home && home !== '/' && folded.startsWith(`${home}/`)) folded = `/users/~${folded.slice(home.length)}`;

  if (ADOBE_STORE.test(folded)) return { kind: 'adobe-fonts', excludedReason: 'adobe-fonts' };
  if (SYSTEM_ROOT.test(folded)) return { kind: 'system', excludedReason: 'system' };
  if (folded.split('/').some(part => /\.(app|framework|bundle|plugin|appex)$/.test(part))) {
    return { kind: 'app', excludedReason: 'app' };
  }
  if (CLOUD_SYNCED.some(pattern => pattern.test(folded))) return { kind: 'user-file', excludedReason: null };
  if (FONTS_FOLDER.test(folded)) return { kind: 'installed', excludedReason: null };
  if (ANY_LIBRARY.test(folded)) return { kind: 'app', excludedReason: 'app' };
  return { kind: 'user-file', excludedReason: null };
}

// Real licence evidence from the font's own name table (ID 13): a sentence
// that grants the SIL OFL 1.1 to this font. A mere mention (derived from,
// unlike, see) is not a grant, and the embedding field is never a licence.
const OFL_NAME = String.raw`SIL\s+Open\s+Font\s+Licen[cs]e`;
const SENTENCE_START = String.raw`(?:^|[.!?]\s+|\n)\s*`;
const OFL_GRANTS = [
  new RegExp(`${SENTENCE_START}(?:this\\s+font\\s+software|the\\s+font\\s+software|this\\s+font(?:\\s+family)?|these\\s+fonts)\\s+(?:is|are)\\s+licen[cs]ed\\s+under\\s+the\\s+${OFL_NAME}([^\\n]{0,24})`, 'i'),
  new RegExp(`${SENTENCE_START}licen[cs]ed\\s+under\\s+the\\s+${OFL_NAME}([^\\n]{0,24})`, 'i'),
];
const OFL_VERSION_1_1 = /^,?\s*(?:version\s*|v\.?\s*)?1\.1\b/i;
const OFL_URL = /(?:^|\s|\()(?:https?:\/\/)?(?:www\.)?(?:scripts\.sil\.org\/(?:OFL\b|cms\/scripts\/page\.php\?[^ ]*\bid=OFL\b)|openfontlicense\.org\b)/i;
const LICENCE_DISQUALIFIERS = /\b(?:not|never|no longer|proprietary|EULA|end[- ]user licen[cs]e|commercial licen[cs]e|paid licen[cs]e|portions?|derived from|based on|unlike)\b/i;

function grantsOpenLicence(licence, licenceUrl) {
  for (const pattern of OFL_GRANTS) {
    const match = pattern.exec(licence);
    if (!match) continue;
    // The grant names version 1.1, or names the OFL and points at its official page.
    if (OFL_VERSION_1_1.test(match[1] || '')) return true;
    if (!/\b1\.0\b/.test(match[1] || '') && (OFL_URL.test(licence) || OFL_URL.test(` ${licenceUrl || ''}`))) return true;
  }
  return false;
}

function detectOpenLicence(faces) {
  if (!Array.isArray(faces) || faces.length === 0) return null;
  const every = faces.every(face => {
    const licence = typeof face?.licence === 'string' ? face.licence : '';
    return grantsOpenLicence(licence, face?.licenceUrl) && !LICENCE_DISQUALIFIERS.test(licenceWithoutOflBody(licence));
  });
  return every ? 'ofl-1.1' : null;
}

// Fonts sometimes carry the whole OFL text in ID 13; its own words ("may not
// be sold") must not count as disqualifiers.
function licenceWithoutOflBody(licence) {
  const body = licence.search(/SIL OPEN FONT LICENSE Version 1\.1 - 26 February 2007/);
  return body >= 0 ? licence.slice(0, body) : licence;
}

function isCurrentConfirmation(confirmation, sha256) {
  return !!confirmation && typeof sha256 === 'string' && /^[a-f0-9]{64}$/.test(sha256) &&
    confirmation.sha256 === sha256 && confirmation.wordingVersion === FONT_CONFIRMATION_WORDING_VERSION;
}

function gateResult(outcome, reason = null, basis = null) {
  return { outcome, reason, basis };
}

// The gate. Order matters: availability, then every exclusion (no control can
// pass these), then the user's own choices, then permission.
function evaluateFontGate(input) {
  // A font inside another file (for example a Photoshop resource) has no
  // reviewed file of its own to check, so it is never packaged.
  if (input?.embedded === true) return gateResult('excluded', 'embedded');
  const state = input?.file?.state;
  if (state === 'missing') return gateResult('unavailable', 'missing');
  if (state === 'symlink') return gateResult('excluded', 'symlink');
  if (state !== 'present') return gateResult('unavailable', 'unreadable');
  if (input.readError) {
    return gateResult('excluded', ['too-large', 'unsupported'].includes(input.readError) ? input.readError : 'malformed');
  }
  const faces = Array.isArray(input.faces) ? input.faces : [];
  if (faces.length === 0) return gateResult('excluded', 'malformed');
  if (input.location?.excludedReason) return gateResult('excluded', input.location.excludedReason);
  if (faces.some(face => typeof face?.postscriptName === 'string' && face.postscriptName.startsWith('.'))) {
    return gateResult('excluded', 'system');
  }
  if (faces.some(face => face?.restricted === true)) return gateResult('excluded', 'restricted');
  // Without a readable English or Macintosh PostScript name, nothing can be
  // named to the user or confirmed, so the face is not offered.
  if (faces.some(face => typeof face?.postscriptName !== 'string' || !face.postscriptName)) {
    return gateResult('excluded', 'unnamed');
  }
  if (input.identityConfirmed === false) return gateResult('excluded', 'unconfirmed');
  if (input.choice === 'remove') return gateResult('not-included', 'removed');
  if (input.intent !== 'explicit' && input.choice !== 'include') return gateResult('not-included', 'found');
  if (input.conflict) return gateResult('not-included', 'conflict');
  if (detectOpenLicence(faces)) return gateResult('included', null, 'open-licence');
  if (isCurrentConfirmation(input.confirmation, input.sha256)) return gateResult('included', null, 'confirmed');
  return gateResult('needs-confirmation', 'licence-unknown');
}

// Draft product copy pending review. Shown in Package Review and the fonts note.
const FONT_REASON_TEXT = Object.freeze({
  'adobe-fonts': 'Activated through Adobe Fonts. It can\'t be packaged. The recipient activates it with their own Adobe account.',
  system: 'Comes with macOS. Not packaged.',
  app: 'Belongs to another app or font service. If you own this font, add your own copy of the font file.',
  restricted: 'The font\'s maker marked it as not to be shared without their permission.',
  unconfirmed: 'Crate couldn\'t confirm this exact font inside the installed file.',
  symlink: 'This is a link to another file. Add the font file itself.',
  'too-large': 'The font file is too large for Crate to check.',
  unsupported: 'Crate can\'t read this font format.',
  malformed: 'Crate couldn\'t read this font file.',
  missing: 'The font file is no longer where Crate found it.',
  unreadable: 'Crate couldn\'t open this font file.',
  removed: 'You removed it from this package.',
  found: 'Found while the project was watched. Crate can\'t tell whether this project uses it.',
  conflict: 'Another font file here has the same font name with different contents. Remove one of them.',
  'licence-unknown': 'Crate can\'t tell whether this font\'s licence allows sharing it. Confirm below to include it.',
  duplicate: 'Same file as another font in this package. It is copied once.',
  embedded: 'Stored inside a Photoshop file. Crate can\'t check it, so it isn\'t packaged.',
  unnamed: 'Crate couldn\'t read this font\'s name in English, so it can\'t be checked or included.',
});

// The fonts note is read by the people receiving the package, so reasons that
// address the sender in Package Review are restated for them.
const FONT_NOTE_REASON_TEXT = Object.freeze({
  'licence-unknown': 'The sender did not confirm that their licence allows sharing it.',
  found: 'Found on the sender\'s Mac while the project was watched; not chosen for this package.',
  removed: 'The sender removed it from this package.',
  conflict: 'Another font file had the same font name with different contents; neither was chosen.',
  app: 'Belongs to another app or font service on the sender\'s Mac.',
  symlink: 'The sender\'s file was a link to another file; links are not copied.',
  missing: 'The font file was no longer available on the sender\'s Mac.',
  unreadable: 'Crate couldn\'t open this font file on the sender\'s Mac.',
  'adobe-fonts': 'Activated through Adobe Fonts. It can\'t be packaged. Activate it with your own Adobe account.',
  embedded: 'Stored inside a Photoshop file on the sender\'s Mac. Crate couldn\'t check it, so it was not packaged.',
});

const FONT_ORIGIN_TEXT = Object.freeze({
  installed: 'Installed on the sender\'s Mac; chosen by the sender in Crate',
  'added-file': 'Added by the sender',
  'project-file': 'Added to the project by the sender',
  found: 'Found while the project was watched; included by the sender',
});

function describeFace(face) {
  const name = [face?.family, face?.style].filter(Boolean).join(' ') || face?.fullName || 'Unnamed font';
  return face?.postscriptName ? `${name} (${face.postscriptName})` : name;
}

// Every face the file contains, so a confirmation or note never hides what is
// actually copied: all members of a collection and a variable font's instances.
function describeFontFaces(faces) {
  return (Array.isArray(faces) ? faces : []).map(face => {
    const instances = (face.namedInstances || []).map(instance =>
      instance.postscriptName ? `${instance.style || 'Unnamed'} (${instance.postscriptName})` : (instance.style || 'Unnamed'));
    return face.variable
      ? `${describeFace(face)}. Variable font; the whole file is included${instances.length ? `, with styles: ${instances.join(', ')}` : ''}`
      : describeFace(face);
  }).join('; ');
}

// Draft wording (FONT_CONFIRMATION_WORDING_VERSION). This records the user's
// statement about their own licence; Crate does not verify it.
function getFontConfirmationStatement(faces, fileName) {
  const list = Array.isArray(faces) ? faces : [];
  const contents = describeFontFaces(list);
  const name = fileName || 'this font file';
  const subject = list.length > 1
    ? `${name}, and all ${list.length} fonts it contains (${contents})`
    : `${name}, which contains ${contents}`;
  return `My licence for this font file, ${subject}, allows me to give it to the people receiving this package.`;
}

function noteLine(value) {
  return `${value || ''}`.replace(/\s+/g, ' ').trim();
}

function indentBlock(value, prefix) {
  return `${value || ''}`.split('\n').map(line => `${prefix}${line.trimEnd()}`).join('\n');
}

// Deterministic text. Holds no local paths: only package file names, font
// names and the font's own notices, treated as untrusted text.
function buildFontsNote({ included = [], notIncluded = [], oflTextFileName = null } = {}) {
  const lines = [
    'Fonts in this package',
    '',
    'Crate copied the font files below unchanged. This list covers only the font files',
    'shown in Crate\'s Package Review. Crate does not check which fonts each document uses,',
    'so other fonts may still be needed.',
    '',
    'The people receiving this package may need their own licence to use these fonts.',
    'To use a font, install it on your Mac. For InDesign, you can instead put the files in',
    'a folder named "Document fonts" next to the document.',
    '',
  ];
  lines.push(`Included font files (${included.length})`);
  if (!included.length) lines.push('  None.');
  for (const item of included) {
    lines.push('');
    lines.push(`- ${noteLine(item.fileName)}`);
    for (const face of item.faces || []) {
      lines.push(`  Font: ${noteLine(describeFace(face))}${face.version ? `, ${noteLine(face.version)}` : ''}`);
      for (const instance of face.namedInstances || []) {
        lines.push(`    Variable style: ${noteLine(instance.style || 'Unnamed')}${instance.postscriptName ? ` (${noteLine(instance.postscriptName)})` : ''}`);
      }
    }
    lines.push(`  SHA-256: ${item.sha256}`);
    lines.push(`  How it was added: ${FONT_ORIGIN_TEXT[item.origin] || FONT_ORIGIN_TEXT['added-file']}`);
    if (item.basis === 'open-licence') {
      lines.push(`  Basis: the font file states the SIL Open Font License 1.1.${oflTextFileName ? ` The licence text is in "${oflTextFileName}".` : ''}`);
    } else {
      lines.push(`  Basis: the sender stated on ${noteLine(item.confirmedOn)} that their licence allows giving this font file`);
      lines.push('  to the people receiving this package. Crate did not verify this.');
    }
    const notices = new Set();
    for (const face of item.faces || []) {
      for (const [label, value] of [['Copyright (from the font)', face.copyright], ['Licence (from the font)', face.licence],
        ['Licence URL (from the font)', face.licenceUrl]]) {
        if (!value || notices.has(`${label}\n${value}`)) continue;
        notices.add(`${label}\n${value}`);
        lines.push(`  ${label}:`);
        lines.push(indentBlock(value, '    '));
      }
    }
  }
  lines.push('');
  lines.push(`Fonts not included (${notIncluded.length})`);
  if (!notIncluded.length) lines.push('  None.');
  for (const item of notIncluded) {
    const reasonText = FONT_NOTE_REASON_TEXT[item.reason] || FONT_REASON_TEXT[item.reason] || FONT_NOTE_REASON_TEXT.unreadable;
    lines.push(`- ${noteLine(item.label)}: ${reasonText}`);
  }
  lines.push('');
  return lines.join('\n');
}

const OFL_1_1_TEXT = `SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
`;

module.exports = {
  FONTS_NOTE_FILENAME,
  FONT_CONFIRMATION_WORDING_VERSION,
  FONT_REASON_TEXT,
  FontReadError,
  GATED_FONT_EXTENSIONS,
  MAX_FONT_FILE_BYTES,
  MAX_FONT_NAME_TEXT_LENGTH,
  OFL_1_1_TEXT,
  OFL_TEXT_FILENAME,
  buildFontsNote,
  classifyFontLocation,
  cleanFontText,
  describeFontFaces,
  detectOpenLicence,
  evaluateFontGate,
  findFace,
  getFontConfirmationStatement,
  isCurrentConfirmation,
  readFontFaces,
};
