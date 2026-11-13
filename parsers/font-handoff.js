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

const crypto = require('crypto');
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

// Bounded display text can drop words; permission is never judged from it.
function isFontTextTruncated(value, limit = MAX_FONT_NAME_TEXT_LENGTH) {
  const full = cleanFontText(value, Infinity);
  return !!full && [...full].length > limit;
}

// A file counts as a font by its name, judged for classification only (the
// output name is never changed). The leaf is folded by compatibility
// decomposition (fullwidth ".ｏｔｆ"; a mark stays separate from its letter),
// invisible, format and control characters are ignored wherever they sit
// (U+200B, U+FEFF, U+00AD, bidi marks, variation selectors), and then a font
// extension followed only by characters that are neither letters nor digits
// counts: spaces, dots, U+2800 and other blank symbols, punctuation, symbols,
// emoji, marks and private-use characters ("Hidden.otf~", "Hidden.otf⠀").
// A Greek iota form after the extension also counts (see GREEK_IOTA).
// Not recognized, by design (the gate is name-based, with no content
// sniffing): another letter or a digit after the extension ("x.otf1", "x.otfa"),
// homoglyph extensions (Cyrillic "о"), font bytes under unrelated names.
const IGNORABLE_NAME_CHARS = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}]/gu;
// Lower-cased first instead of the i flag: with /iu a negated class also
// excludes characters whose case folding is a letter (U+0345 folds to iota).
const GATED_FONT_NAME_PATTERN = /\.(otf|ttf|ttc|otc)[^\p{L}\p{N}]*$/u;
// macOS volumes fold U+0345 COMBINING GREEK YPOGEGRAMMENI (a mark, so a font
// name after an extension) to Greek iota, so "X.otf" + U+0345 and "X.otfι"
// are one file. Every iota form (ι, Ι, accented, Greek Extended, mathematical;
// compatibility decomposition and lower-casing reduce them all to U+03B9)
// counts like U+0345, so both spellings are font names. This only adds names.
const GREEK_IOTA = /\u03b9/gu;
// The plain font extension (".otf", ".ttf", ".ttc", ".otc") a name is
// classified by, or null when the name is not a font name. Same folding as
// isGatedFontName, so callers that rename a file can keep it a font name.
function getGatedFontExtension(name) {
  if (typeof name !== 'string' || !name) return null;
  const leaf = path.posix.basename(name.replace(/\\/g, '/'))
    .normalize('NFKD')
    .replace(IGNORABLE_NAME_CHARS, '')
    .toLowerCase()
    .replace(GREEK_IOTA, '\u0345');
  const match = GATED_FONT_NAME_PATTERN.exec(leaf);
  return match ? `.${match[1]}` : null;
}
function isGatedFontName(name) {
  return getGatedFontExtension(name) !== null;
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
    // Table tags are unique in a valid font; a second copy of a table could
    // say something different from the one another reader picks.
    if (tables.has(tag)) throw new FontReadError('malformed');
    tables.set(tag, { offset: tableOffset, length });
  }
  const names = readNameTable(buffer, tables.get('name'));
  const os2 = tables.get('OS/2');
  // A table too short to hold the embedding field cannot vouch for it.
  if (os2 && os2.length < 10) throw new FontReadError('malformed');
  let fsType = null;
  if (os2 && os2.length >= 10) fsType = buffer.readUInt16BE(os2.offset + 8);
  // The restricted bit (0x0002) excludes the font in any combination (0x3,
  // 0x6, 0xA ...), stricter than the spec's "least restrictive bit wins".
  const restricted = fsType !== null && (fsType & 0x0002) !== 0;
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
    licenceTruncated: isFontTextTruncated(names.get(13)),
    // The font's own notices: display text only. Nothing the file says about
    // itself grants automatic inclusion (see the verified-release catalog).
    licenceUrl: cleanIdentityText(names.get(14)),
    fsType,
    // OpenType OS/2 fsType bit 1: "Restricted License embedding".
    restricted,
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

// Verified-release catalog. Automatic inclusion needs the file's exact bytes
// (SHA-256 computed by main from the reviewed bytes, and again at packaging) to
// equal an entry in the bundled catalog, and its faces to equal the entry's.
// Only the catalog's own entry object counts: callers, renderer input and
// project files cannot construct one. A catalog that fails validation is empty,
// so nothing is included automatically and every other check is unchanged.
const FONT_RELEASE_CATALOG_SCHEMA = 'crate-font-release-catalog/1';
const OFL_BODY_HEADER = 'SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007';
const OFL_STATEMENT_HEADER = /^Copyright [^\n]+ This Font Software is licensed under the SIL Open Font License, Version 1\.1\. This license is copied below, and is also available with a FAQ at: https?:\/\/(?:scripts\.sil\.org\/OFL|openfontlicense\.org) -{3,}$/;
const squashLicenceText = text => `${text || ''}`.replace(/\s+/g, ' ').trim();
const HEX_64 = /^[a-f0-9]{64}$/;
const HEX_40 = /^[a-f0-9]{40}$/;
const EMPTY_CATALOG = Object.freeze({ ok: false, error: 'not-loaded', entries: new Map() });

function isPublishedOflText(text) {
  if (typeof text !== 'string') return false;
  const bodyAt = text.indexOf(OFL_BODY_HEADER);
  return bodyAt > 0 && OFL_STATEMENT_HEADER.test(squashLicenceText(text.slice(0, bodyAt))) &&
    squashLicenceText(text.slice(bodyAt)) === squashLicenceText(OFL_1_1_TEXT);
}

function loadFontReleaseCatalog(data) {
  const fail = error => Object.freeze({ ok: false, error, entries: new Map() });
  try {
    if (!data || typeof data !== 'object' || data.schema !== FONT_RELEASE_CATALOG_SCHEMA) return fail('schema');
    if (!data.licences || typeof data.licences !== 'object' || !Array.isArray(data.entries) || !data.entries.length) return fail('shape');
    const licences = new Map();
    for (const [key, licence] of Object.entries(data.licences)) {
      if (!licence || licence.id !== 'OFL-1.1' || typeof licence.name !== 'string' || !licence.name ||
        typeof licence.repository !== 'string' || !HEX_40.test(licence.commit || '') || typeof licence.path !== 'string' ||
        !HEX_64.test(licence.sha256 || '') || !isPublishedOflText(licence.text) ||
        crypto.createHash('sha256').update(licence.text, 'utf8').digest('hex') !== licence.sha256) {
        return fail('licence');
      }
      licences.set(key, Object.freeze({ key, id: licence.id, name: licence.name, repository: licence.repository,
        commit: licence.commit, path: licence.path, sha256: licence.sha256, text: licence.text }));
    }
    const entries = new Map();
    for (const entry of data.entries) {
      const source = entry && entry.source;
      if (!entry || !HEX_64.test(entry.sha256 || '') || entries.has(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size <= 0 ||
        typeof entry.family !== 'string' || typeof entry.collection !== 'boolean' || !Array.isArray(entry.faces) || !entry.faces.length ||
        !entry.faces.every(name => typeof name === 'string' && name) || !source || typeof source.repository !== 'string' ||
        !HEX_40.test(source.commit || '') || typeof source.path !== 'string' || !licences.has(entry.licence)) {
        return fail('entry');
      }
      const licence = licences.get(entry.licence);
      if (licence.repository !== source.repository || licence.commit !== source.commit) return fail('entry');
      entries.set(entry.sha256, Object.freeze({
        sha256: entry.sha256, size: entry.size, family: entry.family, collection: entry.collection,
        faces: Object.freeze([...entry.faces]),
        source: Object.freeze({ repository: source.repository, commit: source.commit, path: source.path }),
        licence,
      }));
    }
    return Object.freeze({ ok: true, error: null, entries });
  } catch (_) {
    return fail('invalid');
  }
}

let FONT_RELEASE_CATALOG = EMPTY_CATALOG;

function findCatalogRelease(sha256, parsed) {
  if (typeof sha256 !== 'string' || !parsed || !Array.isArray(parsed.faces)) return null;
  const entry = FONT_RELEASE_CATALOG.entries.get(sha256);
  if (!entry || parsed.collection !== entry.collection || parsed.faces.length !== entry.faces.length) return null;
  return parsed.faces.every((face, index) => face && face.postscriptName === entry.faces[index]) ? entry : null;
}

function isCatalogMatch(input, faces) {
  const entry = typeof input.sha256 === 'string' ? FONT_RELEASE_CATALOG.entries.get(input.sha256) : undefined;
  return !!entry && input.catalogRelease === entry && faces.length === entry.faces.length &&
    faces.every((face, index) => face.postscriptName === entry.faces[index]);
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
  if (isCatalogMatch(input, faces)) return gateResult('included', null, 'verified-release');
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
// names, verified-release sources from the bundled catalog, and (for fonts the
// sender confirmed) the font's own notices, labelled as untrusted text.
function buildFontsNote({ included = [], notIncluded = [] } = {}) {
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
    if (item.basis === 'verified-release' && item.release) {
      lines.push('  Basis: this file is byte-identical to a published open-licence font release on Crate\'s');
      lines.push(`  verified list: ${noteLine(item.release.source.repository)} at commit ${noteLine(item.release.source.commit)},`);
      lines.push(`  file ${noteLine(item.release.source.path)}.`);
      lines.push(`  Licence: SIL Open Font License 1.1${item.licenceFileName ? `, published with it, in "${noteLine(item.licenceFileName)}"` : ''}.`);
      lines.push('  This shows the file matches that release. It does not prove anyone\'s rights to use or share it.');
      continue;
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

// Loaded after OFL_1_1_TEXT, which validation compares against.
FONT_RELEASE_CATALOG = (() => {
  try {
    return loadFontReleaseCatalog(require('./font-release-catalog'));
  } catch (_) {
    return Object.freeze({ ok: false, error: 'missing', entries: new Map() });
  }
})();

module.exports = {
  FONT_RELEASE_CATALOG,
  FONTS_NOTE_FILENAME,
  FONT_CONFIRMATION_WORDING_VERSION,
  FONT_REASON_TEXT,
  FontReadError,
  GATED_FONT_EXTENSIONS,
  MAX_FONT_FILE_BYTES,
  MAX_FONT_NAME_TEXT_LENGTH,
  OFL_1_1_TEXT,
  buildFontsNote,
  classifyFontLocation,
  cleanFontText,
  describeFontFaces,
  evaluateFontGate,
  findCatalogRelease,
  findFace,
  getFontConfirmationStatement,
  getGatedFontExtension,
  isCurrentConfirmation,
  isGatedFontName,
  loadFontReleaseCatalog,
  readFontFaces,
};
