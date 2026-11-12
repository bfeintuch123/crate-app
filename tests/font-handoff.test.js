'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fontHandoff = require('../parsers/font-handoff');
const { readFontFaces, findFace, FontReadError } = fontHandoff;
const { buildCollection, buildFont, englishNames, nameRecord, OFL_STATEMENT } = require('./font-fixtures');

test('reader takes the Windows English name, never a localized record listed first (S1)', () => {
  const names = [
    nameRecord(2, 'Negreta', 3, 1, 0x0403),
    nameRecord(6, 'Localized-PS', 3, 1, 0x0403),
    ...englishNames({ family: 'Brand Sans', style: 'Bold', postscriptName: 'BrandSans-Bold' }),
  ];
  const parsed = readFontFaces(buildFont({ names }));
  assert.equal(parsed.faces.length, 1);
  assert.equal(parsed.faces[0].postscriptName, 'BrandSans-Bold');
  assert.equal(parsed.faces[0].style, 'Bold');
  assert.equal(parsed.faces[0].family, 'Brand Sans');
});

test('reader falls back to Macintosh-platform English names (S1)', () => {
  const names = [
    nameRecord(1, 'Mac Family', 1, 0, 0),
    nameRecord(2, 'Italic', 1, 0, 0),
    nameRecord(6, 'MacFamily-Italic', 1, 0, 0),
    nameRecord(5, 'Version 2.1', 1, 0, 0),
  ];
  const face = readFontFaces(buildFont({ names, signature: 'TRUE' })).faces[0];
  assert.equal(face.postscriptName, 'MacFamily-Italic');
  assert.equal(face.family, 'Mac Family');
  assert.equal(face.version, 'Version 2.1');
});

test('a localized-only name never becomes the identity', () => {
  const names = [nameRecord(6, 'Localized-PS', 3, 1, 0x040c), nameRecord(1, 'Famille', 3, 1, 0x040c)];
  const face = readFontFaces(buildFont({ names })).faces[0];
  assert.equal(face.postscriptName, null);
  assert.equal(face.family, null);
});

test('reader reports embedding restriction, licence strings and version', () => {
  const restricted = readFontFaces(buildFont({ fsType: 0x0002 })).faces[0];
  assert.equal(restricted.restricted, true);
  const editable = readFontFaces(buildFont({ fsType: 0x0008 })).faces[0];
  assert.equal(editable.restricted, false);
  const noOs2 = readFontFaces(buildFont({ os2: false })).faces[0];
  assert.equal(noOs2.restricted, false);
  assert.equal(noOs2.fsType, null);
  const open = readFontFaces(buildFont({ names: englishNames({ licence: OFL_STATEMENT, licenceUrl: 'https://openfontlicense.org' }) })).faces[0];
  assert.equal(open.licence, OFL_STATEMENT);
  assert.equal(open.licenceUrl, 'https://openfontlicense.org');
  assert.equal(open.copyright, 'Copyright 2026 Example Type Foundry');
  assert.equal(open.version, 'Version 1.000');
});

test('collections list every face; a face is found by exact PostScript name only', () => {
  const buffer = buildCollection([
    { names: englishNames({ style: 'Regular', postscriptName: 'BrandSans-Regular' }) },
    { names: englishNames({ style: 'Bold', postscriptName: 'BrandSans-Bold' }) },
    { names: englishNames({ style: 'Black', postscriptName: 'BrandSans-Black' }) },
  ]);
  const parsed = readFontFaces(buffer);
  assert.equal(parsed.collection, true);
  assert.deepEqual(parsed.faces.map(face => face.postscriptName), ['BrandSans-Regular', 'BrandSans-Bold', 'BrandSans-Black']);
  assert.deepEqual(findFace(parsed, 'BrandSans-Bold'), { faceIndex: 1, via: 'face' });
  assert.equal(findFace(parsed, 'BrandSans Bold'), null);
  assert.equal(findFace(parsed, 'brandsans-bold'), null);
});

test('variable fonts expose named instances; only an exact instance name confirms', () => {
  const names = [
    ...englishNames({ family: 'Flex', style: 'Regular', postscriptName: 'Flex-Regular' }),
    nameRecord(256, 'Light'), nameRecord(257, 'Flex-Light'),
    nameRecord(258, 'Heavy'),
  ];
  const parsed = readFontFaces(buildFont({ names, fvar: { instances: [
    { subfamilyNameId: 256, postscriptNameId: 257 },
    { subfamilyNameId: 258 },
  ] } }));
  const face = parsed.faces[0];
  assert.equal(face.variable, true);
  assert.deepEqual(face.namedInstances, [
    { style: 'Light', postscriptName: 'Flex-Light' },
    { style: 'Heavy', postscriptName: null },
  ]);
  assert.deepEqual(findFace(parsed, 'Flex-Light'), { faceIndex: 0, via: 'named-instance' });
  assert.equal(findFace(parsed, 'Flex-Heavy'), null);
});

test('malformed, truncated and unsupported files raise a typed error', () => {
  const good = buildFont();
  const cases = [
    [Buffer.alloc(0), 'malformed'],
    [Buffer.from('wOFF0000000000000000'), 'unsupported'],
    [Buffer.from('typ10000000000000000'), 'unsupported'],
    [good.subarray(0, 20), 'malformed'],
    [(() => { const copy = Buffer.from(good); copy.writeUInt32BE(0xfffffff0, 12 + 8); return copy; })(), 'malformed'],
    [(() => { const copy = Buffer.from(good); copy.writeUInt16BE(0xffff, 4); return copy; })(), 'malformed'],
    [(() => { const header = Buffer.alloc(16); header.write('ttcf', 0, 'latin1'); header.writeUInt32BE(100000, 8); return header; })(), 'malformed'],
  ];
  for (const [buffer, code] of cases) {
    assert.throws(() => readFontFaces(buffer), error => error instanceof FontReadError && error.code === code);
  }
});

test('hostile name text is bounded and stripped of control characters', () => {
  const names = englishNames({ family: `Evil\u0000\u0007Family${'x'.repeat(5000)}`, postscriptName: 'Evil-Regular' });
  const face = readFontFaces(buildFont({ names })).faces[0];
  assert.ok(!/[\u0000-\u001f]/.test(face.family));
  assert.ok(face.family.length <= fontHandoff.MAX_FONT_NAME_TEXT_LENGTH);
});

const { classifyFontLocation, detectOpenLicence, evaluateFontGate, FONT_CONFIRMATION_WORDING_VERSION } = fontHandoff;
const HOME = '/Users/olivia';

test('location classes: Adobe, macOS, app stores and bundles are excluded; user folders are eligible', () => {
  const cases = [
    ['/Users/olivia/Library/Application Support/Adobe/CoreSync/plugins/livetype/.r/.12345.otf', 'adobe-fonts', 'adobe-fonts'],
    ['/Library/Application Support/Adobe/Fonts/Thing.otf', 'adobe-fonts', 'adobe-fonts'],
    ['/System/Library/Fonts/Helvetica.ttc', 'system', 'system'],
    ['/System/Library/AssetsV2/com_apple_MobileAsset_Font8/abc.asset/AssetData/Foo.ttc', 'system', 'system'],
    ['/Library/Apple/System/Library/Fonts/Bar.ttf', 'system', 'system'],
    ['/Applications/Design Tool.app/Contents/Resources/Fonts/Bundled.otf', 'app', 'app'],
    ['/Users/olivia/Library/Application Support/FontManager/Library/Rented.otf', 'app', 'app'],
    ['/Users/olivia/Library/Group Containers/group.example/Fonts/Synced.otf', 'app', 'app'],
    ['/Users/olivia/Library/Containers/com.example/Data/Font.otf', 'app', 'app'],
    ['/Users/olivia/Library/Caches/Font.otf', 'app', 'app'],
    ['/Library/Application Support/Vendor/Font.otf', 'app', 'app'],
    ['/Users/someone/Library/Application Support/Vendor/Font.otf', 'app', 'app'],
    ['/Users/olivia/Library/Fonts/BrandSans-Bold.otf', 'installed', null],
    ['/Library/Fonts/BrandSans-Bold.otf', 'installed', null],
    ['/Users/olivia/Downloads/brand-kit/BrandSans-Bold.otf', 'user-file', null],
    ['/Volumes/Work/Fonts/BrandSans-Bold.otf', 'user-file', null],
  ];
  for (const [realPath, kind, excludedReason] of cases) {
    assert.deepEqual(classifyFontLocation(realPath, HOME), { kind, excludedReason }, realPath);
  }
  assert.equal(classifyFontLocation('/users/OLIVIA/library/APPLICATION SUPPORT/adobe/x.otf', HOME).kind, 'adobe-fonts');
  assert.equal(classifyFontLocation('relative/Font.otf', HOME).excludedReason, 'unreadable');
  const deepHome = '/Users/Shared/test-home';
  assert.equal(classifyFontLocation(`${deepHome}/Library/Application Support/Adobe/x.otf`, deepHome).kind, 'adobe-fonts');
  assert.equal(classifyFontLocation(`${deepHome}/Library/Fonts/x.otf`, deepHome).kind, 'installed');
  assert.equal(classifyFontLocation(`${deepHome}/Library/Caches/x.otf`, deepHome).kind, 'app');
  assert.equal(classifyFontLocation('/opt/home/me/Library/Application Support/Adobe/x.otf', '/opt/home/me').kind, 'adobe-fonts');
});

test('open-licence evidence needs the font to state SIL OFL 1.1 in every face, not just embedding flags', () => {
  const ofl = { licence: OFL_STATEMENT, licenceUrl: 'https://openfontlicense.org', fsType: 0 };
  assert.equal(detectOpenLicence([ofl]), 'ofl-1.1');
  // Round 4: an unversioned grant is not a recognized OFL statement, even with the OFL URL.
  assert.equal(detectOpenLicence([{ licence: 'Licensed under the SIL Open Font License', licenceUrl: 'http://scripts.sil.org/OFL' }]), null);
  assert.equal(detectOpenLicence([{ licence: null, licenceUrl: null, fsType: 0 }]), null);
  assert.equal(detectOpenLicence([{ licence: 'Licensed under the Apache License, Version 2.0', licenceUrl: null }]), null);
  assert.equal(detectOpenLicence([{ licence: 'This font is not licensed under the SIL Open Font License 1.1.', licenceUrl: null }]), null);
  assert.equal(detectOpenLicence([{ licence: 'SIL Open Font License, Version 1.0', licenceUrl: null }]), null);
  assert.equal(detectOpenLicence([ofl, { licence: 'Commercial desktop licence', licenceUrl: null }]), null);
  assert.equal(detectOpenLicence([]), null);
});

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
function gateInput(overrides = {}) {
  return {
    file: { state: 'present' },
    readError: null,
    faces: [{ postscriptName: 'BrandSans-Bold', restricted: false, licence: null, licenceUrl: null }],
    location: { kind: 'installed', excludedReason: null },
    identityConfirmed: true,
    intent: 'explicit',
    choice: null,
    sha256: SHA_A,
    confirmation: null,
    conflict: false,
    ...overrides,
  };
}

test('unknown-licence font needs a per-font confirmation, then is included', () => {
  assert.deepEqual(evaluateFontGate(gateInput()), { outcome: 'needs-confirmation', reason: 'licence-unknown', basis: null });
  const confirmed = evaluateFontGate(gateInput({ confirmation: { sha256: SHA_A, wordingVersion: FONT_CONFIRMATION_WORDING_VERSION } }));
  assert.deepEqual(confirmed, { outcome: 'included', reason: null, basis: 'confirmed' });
});

test('a confirmation is bound to the exact bytes and wording; a changed file needs it again', () => {
  assert.equal(evaluateFontGate(gateInput({ confirmation: { sha256: SHA_B, wordingVersion: FONT_CONFIRMATION_WORDING_VERSION } })).outcome, 'needs-confirmation');
  assert.equal(evaluateFontGate(gateInput({ confirmation: { sha256: SHA_A, wordingVersion: 'older' } })).outcome, 'needs-confirmation');
  assert.equal(evaluateFontGate(gateInput({ confirmation: { sha256: SHA_A } })).outcome, 'needs-confirmation');
});

test('open-licence fonts the user added are included without a confirmation and can be removed', () => {
  const faces = [{ postscriptName: 'Open-Regular', restricted: false, licence: OFL_STATEMENT, licenceUrl: null }];
  assert.deepEqual(evaluateFontGate(gateInput({ faces })), { outcome: 'included', reason: null, basis: 'open-licence' });
  assert.deepEqual(evaluateFontGate(gateInput({ faces, choice: 'remove' })), { outcome: 'not-included', reason: 'removed', basis: null });
});

test('a font found while watching is never included by default, even when open-licence', () => {
  const faces = [{ postscriptName: 'Open-Regular', restricted: false, licence: OFL_STATEMENT, licenceUrl: null }];
  const confirmation = { sha256: SHA_A, wordingVersion: FONT_CONFIRMATION_WORDING_VERSION };
  assert.equal(evaluateFontGate(gateInput({ faces, intent: 'found' })).reason, 'found');
  assert.equal(evaluateFontGate(gateInput({ intent: 'found', confirmation })).reason, 'found');
  assert.equal(evaluateFontGate(gateInput({ faces, intent: 'found', choice: 'include' })).outcome, 'included');
  assert.equal(evaluateFontGate(gateInput({ intent: 'found', choice: 'include' })).outcome, 'needs-confirmation');
  assert.equal(evaluateFontGate(gateInput({ intent: 'found', choice: 'include', confirmation })).outcome, 'included');
});

test('no choice, confirmation or open licence can include an excluded font', () => {
  const unlock = {
    choice: 'include',
    confirmation: { sha256: SHA_A, wordingVersion: FONT_CONFIRMATION_WORDING_VERSION },
  };
  const ofl = [{ postscriptName: 'X-Regular', restricted: false, licence: OFL_STATEMENT, licenceUrl: null }];
  const cases = [
    [{ location: { kind: 'adobe-fonts', excludedReason: 'adobe-fonts' } }, 'adobe-fonts'],
    [{ location: { kind: 'system', excludedReason: 'system' } }, 'system'],
    [{ location: { kind: 'app', excludedReason: 'app' } }, 'app'],
    [{ faces: [{ postscriptName: '.SFNS-Regular', restricted: false, licence: OFL_STATEMENT }] }, 'system'],
    [{ faces: [{ postscriptName: 'R-Regular', restricted: true, licence: OFL_STATEMENT }] }, 'restricted'],
    [{ faces: [ofl[0], { postscriptName: 'R-Bold', restricted: true, licence: OFL_STATEMENT }] }, 'restricted'],
    [{ identityConfirmed: false }, 'unconfirmed'],
    [{ file: { state: 'symlink' } }, 'symlink'],
    [{ readError: 'too-large' }, 'too-large'],
    [{ readError: 'unsupported' }, 'unsupported'],
    [{ readError: 'malformed' }, 'malformed'],
  ];
  for (const [overrides, reason] of cases) {
    const result = evaluateFontGate(gateInput({ faces: ofl, ...unlock, ...overrides }));
    assert.deepEqual(result, { outcome: 'excluded', reason, basis: null }, reason);
  }
  assert.deepEqual(evaluateFontGate(gateInput({ file: { state: 'missing' } })), { outcome: 'unavailable', reason: 'missing', basis: null });
});

test('two different files claiming one font are never both included', () => {
  const confirmation = { sha256: SHA_A, wordingVersion: FONT_CONFIRMATION_WORDING_VERSION };
  assert.deepEqual(evaluateFontGate(gateInput({ confirmation, conflict: true })), { outcome: 'not-included', reason: 'conflict', basis: null });
});

const { buildFontsNote, getFontConfirmationStatement, describeFontFaces, FONT_REASON_TEXT, OFL_1_1_TEXT } = fontHandoff;

test('the confirmation names every face in the file, including every collection member', () => {
  const faces = [
    { family: 'Brand Sans', style: 'Regular', postscriptName: 'BrandSans-Regular', namedInstances: [] },
    { family: 'Brand Sans', style: 'Bold', postscriptName: 'BrandSans-Bold', namedInstances: [] },
  ];
  const statement = getFontConfirmationStatement(faces, 'BrandSans.ttc');
  assert.match(statement, /BrandSans\.ttc, and all 2 fonts it contains/);
  assert.equal(getFontConfirmationStatement([faces[1]], 'BrandSans-Bold.otf'),
    'My licence for this font file, BrandSans-Bold.otf, which contains Brand Sans Bold (BrandSans-Bold), ' +
    'allows me to give it to the people receiving this package.');
  assert.match(statement, /Brand Sans Regular \(BrandSans-Regular\)/);
  assert.match(statement, /Brand Sans Bold \(BrandSans-Bold\)/);
  assert.match(statement, /licen[cs]e/i);
  const variable = describeFontFaces([{ family: 'Flex', style: 'Regular', postscriptName: 'Flex-Regular', variable: true,
    namedInstances: [{ style: 'Light', postscriptName: 'Flex-Light' }] }]);
  assert.match(variable, /Variable font/);
  assert.match(variable, /Flex-Light/);
});

test('fonts note lists included and excluded fonts without paths or completeness claims', () => {
  const note = buildFontsNote({
    included: [{
      fileName: 'BrandSans-Bold.otf',
      sha256: SHA_A,
      origin: 'installed',
      basis: 'confirmed',
      confirmedOn: '2026-11-11',
      faces: [{ family: 'Brand Sans', style: 'Bold', postscriptName: 'BrandSans-Bold', version: 'Version 1.000',
        copyright: 'Copyright 2026 Example', licence: 'Desktop licence', licenceUrl: null, namedInstances: [] }],
    }, {
      fileName: 'Open-Regular.ttf',
      sha256: SHA_B,
      origin: 'added-file',
      basis: 'open-licence',
      faces: [{ family: 'Open', style: 'Regular', postscriptName: 'Open-Regular', version: 'Version 2.0',
        copyright: 'Copyright 2020 The Open Project Authors', licence: OFL_STATEMENT, licenceUrl: null, namedInstances: [] }],
    }],
    notIncluded: [{ label: 'Cloud Serif Regular (CloudSerif-Regular)', reason: 'adobe-fonts' },
      { label: 'Brand Sans Regular (BrandSans-Regular)', reason: 'licence-unknown' },
      { label: 'Found Regular (Found-Regular)', reason: 'found' },
      { label: 'Gone Regular (Gone-Regular)', reason: 'removed' }],
    oflTextFileName: 'SIL Open Font License 1.1.txt',
  });
  assert.match(note, /BrandSans-Bold\.otf/);
  assert.match(note, new RegExp(SHA_A));
  assert.match(note, /stated on 2026-11-11/);
  assert.match(note, /Crate did not verify/);
  assert.match(note, /SIL Open Font License 1\.1\.txt/);
  assert.match(note, /Copyright 2020 The Open Project Authors/);
  assert.match(note, /CloudSerif-Regular/);
  assert.match(note, /Adobe Fonts/);
  assert.match(note, /may need their own licen[cs]e/i);
  assert.doesNotMatch(note, /\/Users\/|\/Library\/|\/Volumes\//);
  // Recipient-facing: never instructions addressed to the sender.
  assert.doesNotMatch(note.slice(note.indexOf('Fonts not included')), /below|\b[Yy]ou\b/);
  assert.match(note, /BrandSans-Regular\): The sender did not confirm/);
  for (const banned of [/all fonts/i, /complete/i, /ready to edit/i, /safe to share/i]) assert.doesNotMatch(note, banned);
});

test('fonts note is deterministic and the bundled OFL text is the full licence', () => {
  const model = { included: [], notIncluded: [{ label: 'X (X-Regular)', reason: 'system' }], oflTextFileName: null };
  assert.equal(buildFontsNote(model), buildFontsNote(model));
  assert.match(OFL_1_1_TEXT, /^SIL OPEN FONT LICENSE Version 1\.1 - 26 February 2007/m);
  assert.match(OFL_1_1_TEXT, /PERMISSION & CONDITIONS/);
  assert.match(OFL_1_1_TEXT, /OTHER DEALINGS IN THE FONT SOFTWARE\.\n$/);
  for (const reason of ['adobe-fonts', 'system', 'app', 'restricted', 'unconfirmed', 'symlink', 'too-large', 'unsupported',
    'malformed', 'missing', 'unreadable', 'removed', 'found', 'conflict', 'licence-unknown', 'duplicate']) {
    assert.equal(typeof FONT_REASON_TEXT[reason], 'string', reason);
  }
});

function tableRecord(bytes, tag) {
  for (let index = 0; index < bytes.readUInt16BE(4); index++) {
    const base = 12 + index * 16;
    if (bytes.toString('latin1', base, base + 4) === tag) return base;
  }
  throw new Error(`no ${tag}`);
}

test('name records and strings must lie inside the declared name table', () => {
  const ofl = englishNames({ licence: OFL_STATEMENT });
  const truncated = buildFont({ names: ofl });
  truncated.writeUInt32BE(6, tableRecord(truncated, 'name') + 12);
  assert.throws(() => readFontFaces(truncated), error => error instanceof FontReadError && error.code === 'malformed');

  // Records inside the table but string storage pointing past its end.
  const shortStorage = buildFont({ names: ofl });
  const nameRecordBase = tableRecord(shortStorage, 'name');
  const declared = shortStorage.readUInt32BE(nameRecordBase + 12);
  shortStorage.writeUInt32BE(declared - 40, nameRecordBase + 12);
  assert.throws(() => readFontFaces(shortStorage), error => error instanceof FontReadError && error.code === 'malformed');
});

test('fvar axes and instances must lie inside the declared fvar table', () => {
  const names = [...englishNames({ family: 'Flex', postscriptName: 'Flex-Regular' }), nameRecord(256, 'Bold')];
  const font = buildFont({ names, fvar: { instances: [{ subfamilyNameId: 256 }] } });
  font.writeUInt32BE(16, tableRecord(font, 'fvar') + 12);
  assert.throws(() => readFontFaces(font), error => error instanceof FontReadError && error.code === 'malformed');
});

test('a font stored inside another file is excluded whatever the choice or confirmation', () => {
  const unlock = { choice: 'include', confirmation: { sha256: SHA_A, wordingVersion: FONT_CONFIRMATION_WORDING_VERSION } };
  assert.deepEqual(evaluateFontGate(gateInput({ ...unlock, embedded: true, faces: [] })), { outcome: 'excluded', reason: 'embedded', basis: null });
  assert.equal(typeof FONT_REASON_TEXT.embedded, 'string');
});

test('cloud-synced folders are user files; managed stores on other volumes stay excluded', () => {
  const cases = [
    ['/Users/olivia/Library/CloudStorage/Dropbox/Brand Kit/BrandSans-Bold.otf', 'user-file', null],
    ['/Users/olivia/Library/CloudStorage/GoogleDrive-o@example.com/My Drive/BrandSans.otf', 'user-file', null],
    ['/Users/olivia/Library/Mobile Documents/com~apple~CloudDocs/Brand/BrandSans.otf', 'user-file', null],
    ['/Users/olivia/Library/Mobile Documents/iCloud~com~example~fonts/Documents/Rented.otf', 'app', 'app'],
    ['/Volumes/Work/Library/Application Support/Adobe/CoreSync/plugins/livetype/r/1.otf', 'adobe-fonts', 'adobe-fonts'],
    ['/Volumes/Old Mac/System/Library/Fonts/Helvetica.ttc', 'system', 'system'],
    ['/Volumes/Old Mac/Users/x/Library/Application Support/FontManager/A.otf', 'app', 'app'],
    ['/Volumes/Old Mac/Library/Caches/A.otf', 'app', 'app'],
  ];
  for (const [realPath, kind, excludedReason] of cases) {
    assert.deepEqual(classifyFontLocation(realPath, HOME), { kind, excludedReason }, realPath);
  }
});

test('only a positive SIL OFL 1.1 grant counts as open-licence evidence', () => {
  const positive = [
    OFL_STATEMENT,
    'Licensed under the SIL Open Font License, Version 1.1.',
  ];
  for (const licence of positive) assert.equal(detectOpenLicence([{ licence, licenceUrl: null }]), 'ofl-1.1', licence);
  const negative = [
    'This font is proprietary. Portions are derived from Foo Sans, which is licensed under the SIL Open Font License, Version 1.1.',
    'Commercial licence. You may not redistribute. Unlike fonts under the SIL Open Font License 1.1, this font requires a paid licence.',
    'Based on Foo Sans (SIL Open Font License, Version 1.1); this version is licensed under the Example Desktop EULA.',
    'See https://openfontlicense.org for the SIL Open Font License 1.1 used by other fonts in this family.',
    // Round 4: anything beyond a recognized statement asks for the confirmation.
    'This Font Software is licensed under the SIL Open Font License, Version 1.1. This license is copied below.',
    'Copyright 2020 The Example Project Authors. This Font Software is licensed under the SIL Open Font License, Version 1.1.',
  ];
  for (const licence of negative) assert.equal(detectOpenLicence([{ licence, licenceUrl: 'https://openfontlicense.org' }]), null, licence);
});

test('a face without a readable English or Macintosh PostScript name is never offered for confirmation', () => {
  const input = gateInput({ faces: [{ postscriptName: null, restricted: false, licence: null, licenceUrl: null }],
    confirmation: { sha256: SHA_A, wordingVersion: FONT_CONFIRMATION_WORDING_VERSION } });
  assert.deepEqual(evaluateFontGate(input), { outcome: 'excluded', reason: 'unnamed', basis: null });
  assert.equal(typeof FONT_REASON_TEXT.unnamed, 'string');
});

test('a grant followed by a restriction is not open-licence evidence', () => {
  const negative = [
    'This Font Software is licensed under the SIL Open Font License, Version 1.1, except that redistribution is prohibited.',
    'Licensed under the SIL Open Font License, Version 1.1 for personal use only.',
    'Licensed under the SIL Open Font License, Version 1.1. Non-commercial use only.',
  ];
  for (const licence of negative) assert.equal(detectOpenLicence([{ licence, licenceUrl: null }]), null, licence);
  assert.equal(detectOpenLicence([{ licence: 'Licensed under the SIL Open Font License', licenceUrl: 'https://openfontlicense.org.evil.example/' }]), null);
  assert.equal(detectOpenLicence([{ licence: 'Licensed under the SIL Open Font License', licenceUrl: 'https://openfontlicense.org/' }]), null);
});

test('an OS/2 table too short to hold the embedding field is malformed', () => {
  const font = buildFont();
  font.writeUInt32BE(8, tableRecord(font, 'OS/2') + 12);
  assert.throws(() => readFontFaces(font), error => error instanceof FontReadError && error.code === 'malformed');
});

test('font file names are judged as written: trailing spaces and dots do not hide a font extension', () => {
  const { isGatedFontName } = fontHandoff;
  for (const name of ['Boundary.otf ', 'Boundary.OTF.', 'x.ttc . ', 'dir/x.TTF', 'x.otc\t']) assert.equal(isGatedFontName(name), true, JSON.stringify(name));
  for (const name of ['x.otfx', 'x.woff', 'x.woff2', 'otf', '', null]) assert.equal(isGatedFontName(name), false, JSON.stringify(name));
});

test('an OFL licence header only exempts the canonical OFL body; anything else is still checked', () => {
  const grant = 'This Font Software is licensed under the SIL Open Font License, Version 1.1. ';
  assert.equal(detectOpenLicence([{ licence: grant + OFL_1_1_TEXT, licenceUrl: null }]), 'ofl-1.1');
  const header = 'SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007';
  assert.equal(detectOpenLicence([{ licence: `${grant}${header}\nRedistribution is prohibited. Personal use only.`, licenceUrl: null }]), null);
  assert.equal(detectOpenLicence([{ licence: `${grant}${OFL_1_1_TEXT}\nAdditional terms: redistribution is prohibited.`, licenceUrl: null }]), null);
});

test('licence evidence is never judged from truncated text', () => {
  const long = `${OFL_STATEMENT} ${'x'.repeat(4100)} Redistribution is prohibited. Personal use only.`;
  const face = readFontFaces(buildFont({ names: englishNames({ licence: long }) })).faces[0];
  assert.equal(face.licenceTruncated, true);
  assert.equal(detectOpenLicence([face]), null);
  const short = readFontFaces(buildFont({ names: englishNames({ licence: OFL_STATEMENT }) })).faces[0];
  assert.equal(short.licenceTruncated, false);
  assert.equal(detectOpenLicence([short]), 'ofl-1.1');
});

test('more self-contradicting licence phrasings need the confirmation', () => {
  for (const tail of ['Cannot be shared.', 'Redistribution forbidden.', 'Use only when obtained from the vendor.']) {
    assert.equal(detectOpenLicence([{ licence: `${OFL_STATEMENT} ${tail}`, licenceUrl: null }]), null, tail);
  }
});

// Round 4 (authorized by Bryant): recognized OFL statements only; disguised font names.
const INSTALLED_OFL_FORMS = [
  ['This Font Software is licensed under the SIL Open Font License, Version 1.1. This license is available with a FAQ at: https://scripts.sil.org/OFL', 'https://scripts.sil.org/OFL'],
  ['This Font Software is licensed under the SIL Open Font License, Version 1.1. This license is available with a FAQ at: http://scripts.sil.org/OFL', 'http://scripts.sil.org/OFL'],
  ['This Font Software is licensed under the SIL Open Font License, Version 1.1. This Font Software is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the SIL Open Font License for the specific language, permissions and limitations governing your use of this Font Software.', 'http://scripts.sil.org/OFL'],
];

test('round 4: the OFL statements real installed fonts carry are recognized', () => {
  for (const [licence, licenceUrl] of INSTALLED_OFL_FORMS) assert.equal(detectOpenLicence([{ licence, licenceUrl }]), 'ofl-1.1', licence);
  assert.equal(detectOpenLicence([{ licence: OFL_STATEMENT, licenceUrl: 'https://openfontlicense.org' }]), 'ofl-1.1');
  assert.equal(detectOpenLicence([{ licence: 'Licensed under the SIL Open Font License, Version 1.1', licenceUrl: null }]), 'ofl-1.1');
  // Line breaks and spacing are not wording.
  assert.equal(detectOpenLicence([{ licence: OFL_STATEMENT.replace(/ /g, '\n  '), licenceUrl: null }]), 'ofl-1.1');
});

test('round 4: uncertain or extra licence wording needs the per-font confirmation', () => {
  const grant = 'This Font Software is licensed under the SIL Open Font License, Version 1.1.';
  const cases = [
    `${grant} Sharing requires a licence from the foundry.`,
    `${grant} Trial version for evaluation.`,
    `${grant} Demo. Payment is required for use.`,
    `${OFL_STATEMENT} Redistribution is prohibited.`,
    `${OFL_STATEMENT}, except for commercial use`,
    `${grant} ${OFL_1_1_TEXT} Additional terms apply.`,
    `${grant} ${OFL_1_1_TEXT.replace('may be sold', 'may not be sold')}`,
    'Licensed under the SIL Open Font License',
    'This Font Software is licensed under the SIL Open Font License, Version 1.0.',
    'Licensed under the Apache License, Version 2.0.',
  ];
  for (const licence of cases) assert.equal(detectOpenLicence([{ licence, licenceUrl: null }]), null, licence);
  // The licence URL must be exactly a known OFL address.
  for (const licenceUrl of ['https://openfontlicense.org.evil.example', 'https://openfontlicense.org,evil', 'https://foundry.example/eula',
    `${'a '.repeat(114)}https://openfontlicense.org`]) {
    assert.equal(detectOpenLicence([{ licence: OFL_STATEMENT, licenceUrl }]), null, licenceUrl);
  }
});

test('round 4: whole licence evidence and URL are judged before display truncation', () => {
  const grant = 'This Font Software is licensed under the SIL Open Font License, Version 1.1. This license is copied below, and is also available with a FAQ at: https://openfontlicense.org';
  const full = readFontFaces(buildFont({ names: englishNames({ licence: `${grant}\n\n${OFL_1_1_TEXT}` }) })).faces[0];
  assert.equal(full.licenceTruncated, true, 'display text is capped');
  assert.equal(detectOpenLicence([full]), 'ofl-1.1', 'the exact full OFL text is recognized from the untruncated evidence');
  const tail = readFontFaces(buildFont({ names: englishNames({ licence: `${grant}\n\n${OFL_1_1_TEXT}\nRedistribution is prohibited.` }) })).faces[0];
  assert.equal(detectOpenLicence([tail]), null, 'a clause beyond the display cap is still seen');
  const longUrl = readFontFaces(buildFont({ names: englishNames({ licence: OFL_STATEMENT,
    licenceUrl: `${'a '.repeat(114)}https://openfontlicense.org.evil.example/terms` }) })).faces[0];
  assert.equal(detectOpenLicence([longUrl]), null, 'the URL is judged untruncated');
});

test('round 4: invisible, format and compatibility characters do not hide a font extension', () => {
  const { isGatedFontName } = fontHandoff;
  const disguised = ['Hidden.otf​', 'Hidden.otf‌', 'Hidden.otf‍', 'Hidden.otf﻿', 'Hidden.otf­',
    'Hidden.otf️', 'Hidden.otf‏', 'Hidden.otf ', 'Hidden.otf　', 'Hidden.o​tf', 'Hidden．ｏｔｆ',
    'Hidden.TTC⁠', 'Hidden.ttf\u0007', 'Hidden.otc‮'];
  for (const name of disguised) assert.equal(isGatedFontName(name), true, JSON.stringify(name));
  const ordinary = ['Brand.bin', 'Brand.otf.png', 'Brand.png​', 'x.otfx', 'x.woff2', 'x.оtf', 'otf', 'Brand'];
  for (const name of ordinary) assert.equal(isGatedFontName(name), false, JSON.stringify(name));
});

// Round 5 (authorized by Bryant): every licence record is safety evidence, and
// a font extension followed only by non-letter, non-digit characters is a font.
// Display keeps choosing one English record; permission never comes from it.
const { utf16be } = require('./font-fixtures');
const restrictive = 'Commercial font. Do not redistribute.';
const oflFace = names => readFontFaces(buildFont({ names })).faces;
const roundFiveGate = (faces, extra = {}) => evaluateFontGate({ file: { state: 'present' }, readError: null, faces,
  location: { excludedReason: null }, intent: 'explicit', choice: null, sha256: 'a'.repeat(64), confirmation: null, conflict: false, ...extra });

function rawNameTable(records, storage) {
  const header = Buffer.alloc(6 + records.length * 12);
  header.writeUInt16BE(records.length, 2);
  header.writeUInt16BE(header.length, 4);
  records.forEach((record, index) => {
    const base = 6 + index * 12;
    header.writeUInt16BE(record.platform, base);
    header.writeUInt16BE(record.encoding, base + 2);
    header.writeUInt16BE(record.language, base + 4);
    header.writeUInt16BE(record.id, base + 6);
    header.writeUInt16BE(record.length, base + 8);
    header.writeUInt16BE(record.offset, base + 10);
  });
  return Buffer.concat([header, storage]);
}
const identityRecords = (storageStart = 0) => {
  const ps = utf16be('Raw-Regular');
  return { storage: ps, records: [{ platform: 3, encoding: 1, language: 0x0409, id: 6, offset: storageStart, length: ps.length }] };
};

test('round 5: Fable counterexamples - a disagreeing secondary licence record asks for the confirmation', () => {
  // R1: Windows English OFL statement, Macintosh English record says otherwise.
  const mixed = oflFace([...englishNames({ licence: OFL_STATEMENT }), nameRecord(13, restrictive, 1, 0, 0)]);
  assert.equal(mixed[0].licence, OFL_STATEMENT, 'display still shows the English Windows record');
  assert.equal(detectOpenLicence(mixed), null);
  assert.deepEqual(roundFiveGate(mixed), { outcome: 'needs-confirmation', reason: 'licence-unknown', basis: null });
  // R3: Windows English OFL statement, German Windows record says otherwise.
  const german = oflFace([...englishNames({ licence: OFL_STATEMENT }), nameRecord(13, 'Nicht weitergeben.', 3, 1, 0x0407)]);
  assert.equal(detectOpenLicence(german), null);
  assert.equal(roundFiveGate(german).outcome, 'needs-confirmation');
  // The P5 shape used through IPC.
  const split = oflFace([...englishNames({ family: 'Split', style: 'Regular', postscriptName: 'Split-Regular', licence: OFL_STATEMENT }),
    nameRecord(13, restrictive, 1, 0, 0)]);
  assert.equal(detectOpenLicence(split), null);
});

test('round 5: every platform, encoding and language record is judged; agreeing records still count as open licence', () => {
  const allAgree = oflFace([...englishNames({ licence: OFL_STATEMENT, licenceUrl: 'https://openfontlicense.org' }),
    nameRecord(13, OFL_STATEMENT, 1, 0, 0), nameRecord(14, 'https://openfontlicense.org', 1, 0, 0),
    nameRecord(13, OFL_STATEMENT, 3, 1, 0x0407), nameRecord(13, OFL_STATEMENT, 3, 10, 0x0411),
    nameRecord(13, OFL_STATEMENT, 0, 3, 0), nameRecord(13, OFL_STATEMENT, 1, 0, 2)]);
  assert.equal(detectOpenLicence(allAgree), 'ofl-1.1');
  assert.equal(roundFiveGate(allAgree).basis, 'open-licence');
  // Macintosh-only OFL statement still counts.
  assert.equal(detectOpenLicence(oflFace([...englishNames({}), nameRecord(13, OFL_STATEMENT, 1, 0, 0)])), 'ofl-1.1');
  // A disagreeing record on any platform or language, for the licence or its URL, asks.
  const disagreeing = [
    nameRecord(13, restrictive, 0, 3, 0),
    nameRecord(13, restrictive, 3, 0, 0x0409),
    nameRecord(13, restrictive, 3, 10, 0x0409),
    nameRecord(13, restrictive, 3, 1, 0x8000),
    nameRecord(13, `${OFL_STATEMENT} Trial.`, 1, 0, 0),
    nameRecord(13, 'Lizenziert unter der SIL Open Font License, Version 1.1.', 3, 1, 0x0407),
    nameRecord(14, 'https://foundry.example/eula', 1, 0, 0),
    nameRecord(14, 'https://foundry.example/eula', 3, 1, 0x0407),
    nameRecord(13, '', 1, 0, 0),
  ];
  for (const extra of disagreeing) {
    const faces = oflFace([...englishNames({ licence: OFL_STATEMENT }), extra]);
    assert.equal(detectOpenLicence(faces), null, JSON.stringify(extra));
    assert.equal(roundFiveGate(faces).outcome, 'needs-confirmation', JSON.stringify(extra));
  }
  // Order does not matter: the disagreeing record listed first.
  assert.equal(detectOpenLicence(oflFace([nameRecord(13, restrictive, 1, 0, 0), ...englishNames({ licence: OFL_STATEMENT })])), null);
});

test('round 5: unsupported, undecodable and odd-length licence records ask for the confirmation', () => {
  const unsupported = [
    { id: 13, platform: 3, encoding: 2, language: 0x0411, data: Buffer.from([0x82, 0xa0, 0x82, 0xa2]) },
    { id: 13, platform: 3, encoding: 3, language: 0x0804, data: Buffer.from('OFL', 'latin1') },
    { id: 13, platform: 1, encoding: 1, language: 11, data: Buffer.from([0x82, 0xa0]) },
    { id: 13, platform: 2, encoding: 0, language: 0, data: Buffer.from('OFL', 'latin1') },
    { id: 13, platform: 4, encoding: 0, language: 0, data: Buffer.from('OFL', 'latin1') },
    { id: 13, platform: 3, encoding: 1, language: 0x0409, data: Buffer.concat([utf16be(OFL_STATEMENT), Buffer.from([0x41])]) },
    { id: 14, platform: 3, encoding: 5, language: 0x0412, data: Buffer.from('x', 'latin1') },
    { id: 14, platform: 3, encoding: 1, language: 0x0407, data: Buffer.from([0x00]) },
  ];
  for (const extra of unsupported) {
    const faces = oflFace([...englishNames({ licence: OFL_STATEMENT }), { text: '', ...extra }]);
    assert.equal(faces[0].postscriptName, 'BrandSans-Regular', 'identity is unaffected');
    assert.equal(detectOpenLicence(faces), null, JSON.stringify({ ...extra, data: extra.data.toString('hex') }));
  }
});

test('round 5: an OFL claim in only one face of a collection is not enough', () => {
  const collection = readFontFaces(buildCollection([
    { names: englishNames({ licence: OFL_STATEMENT }) },
    { names: [...englishNames({ postscriptName: 'B-Two', licence: OFL_STATEMENT }), nameRecord(13, restrictive, 1, 0, 0)] },
  ])).faces;
  assert.equal(detectOpenLicence(collection), null);
});

test('round 5: restricted, Adobe and system exclusions still win over agreeing OFL records', () => {
  const ofl = [...englishNames({ licence: OFL_STATEMENT }), nameRecord(13, OFL_STATEMENT, 1, 0, 0)];
  const restricted = readFontFaces(buildFont({ fsType: 2, names: ofl })).faces;
  const confirmation = { sha256: 'a'.repeat(64), wordingVersion: FONT_CONFIRMATION_WORDING_VERSION };
  assert.equal(roundFiveGate(restricted, { confirmation }).reason, 'restricted');
  assert.equal(roundFiveGate(oflFace(ofl), { location: { excludedReason: 'adobe-fonts' } }).reason, 'adobe-fonts');
  assert.equal(roundFiveGate(oflFace(ofl), { location: { excludedReason: 'system' } }).reason, 'system');
});

test('round 5: licence evidence work and memory stay bounded on duplicate and huge records', () => {
  // 4,000 licence records sharing one OFL span are judged once and still agree.
  const statement = utf16be(OFL_STATEMENT);
  const identity = identityRecords(statement.length);
  const shared = Array.from({ length: 4000 }, (_, index) => ({ platform: 3, encoding: 1, language: 0x0400 + (index % 200), id: 13, offset: 0, length: statement.length }));
  const sharedFont = buildFont({ nameTable: rawNameTable([...shared, ...identity.records], Buffer.concat([statement, identity.storage])) });
  let started = Date.now();
  const sharedFaces = readFontFaces(sharedFont).faces;
  assert.equal(detectOpenLicence(sharedFaces), 'ofl-1.1');
  assert.ok(Date.now() - started < 5000, 'shared spans are not decoded 4,000 times');
  // 4,000 distinct overlapping ~64 KB spans: the evidence budget runs out and the font asks.
  const identity2 = identityRecords(0);
  const big = Buffer.alloc(65534 + 4000 * 2, 0x41);
  const overlapping = Array.from({ length: 4000 }, (_, index) => ({ platform: 3, encoding: 1, language: 0x0409, id: 13,
    offset: identity2.storage.length + index * 2, length: 65534 - (index % 2) * 2 }));
  started = Date.now();
  const hugeFaces = readFontFaces(buildFont({ nameTable: rawNameTable([...identity2.records, ...overlapping], Buffer.concat([identity2.storage, big])) })).faces;
  assert.equal(detectOpenLicence(hugeFaces), null);
  assert.ok(Date.now() - started < 5000, 'huge licence tables are cut off by the evidence budget');
  // Parsed faces keep no untruncated licence text: only bounded display text and a decision.
  for (const face of [...sharedFaces, ...hugeFaces]) {
    for (const [key, value] of Object.entries(face)) {
      if (typeof value === 'string') assert.ok([...value].length <= 4000, `${key} is bounded`);
    }
    assert.equal(Object.hasOwn(face, 'licenceEvidence'), false);
    assert.equal(Object.hasOwn(face, 'licenceUrlEvidence'), false);
  }
});

test('round 5: duplicate name or OS/2 tables are malformed, never read as the friendlier copy', () => {
  for (const tag of ['name', 'OS/2']) {
    const extra = tag === 'name'
      ? ['name', Buffer.from(require('./font-fixtures').buildNameTable([...englishNames({ licence: OFL_STATEMENT })]))]
      : ['OS/2', (() => { const table = Buffer.alloc(78); table.writeUInt16BE(4, 0); table.writeUInt16BE(2, 8); return table; })()];
    const font = buildFont({ names: englishNames({ licence: OFL_STATEMENT }), extraTables: [extra] });
    assert.throws(() => readFontFaces(font), error => error instanceof FontReadError && error.code === 'malformed', tag);
  }
});

test('round 5: the FAQ address inside a statement must be exactly a known OFL address (regex escape)', () => {
  const grant = 'This Font Software is licensed under the SIL Open Font License, Version 1.1.';
  for (const tail of ['https://scripts.sil.org/OFLX', 'https://openfontlicense.org/x', 'https://openfontlicense.orgx', 'https://scripts.sil.org/OFL!']) {
    assert.equal(detectOpenLicence([{ licence: `${grant} This license is available with a FAQ at: ${tail}`, licenceUrl: null }]), null, tail);
    assert.equal(detectOpenLicence([{ licence: `${grant} This license is copied below, and is also available with a FAQ at: ${tail}`, licenceUrl: null }]), null, tail);
  }
  for (const tail of ['https://scripts.sil.org/OFL', 'https://scripts.sil.org/OFL.', 'https://openfontlicense.org/', 'http://openfontlicense.org.']) {
    assert.equal(detectOpenLicence([{ licence: `${grant} This license is available with a FAQ at: ${tail}`, licenceUrl: null }]), 'ofl-1.1', tail);
  }
});

test('round 5: Fable counterexamples - a font extension followed only by non-letters, non-digits is a font', () => {
  const { isGatedFontName } = fontHandoff;
  const suffixes = ['\u2800', '\u2800\u2800', '\u3164', '\uffa0', '\u115f', '\ue000', '\ufffc', '\u0301', '\u0307', '\u{1f512}', '~', '_', '-',
    ':', '!', '#', '()', '\u2026', '\u2605', '\u00b7', '\u2028', '\u0085', ' ~', '\u2800.', '\u200b\u2800 '];
  for (const suffix of suffixes) {
    for (const ext of ['.otf', '.TTF', '.ttc', '.Otc']) {
      const name = `Hidden${ext}${suffix}`;
      assert.equal(isGatedFontName(name), true, JSON.stringify(name));
    }
  }
  // Documented boundary: a letter or digit after the extension, other formats, ordinary files.
  const ordinary = ['Hidden.otfa', 'Hidden.otf1', 'Hidden.otf(1)', 'Hidden.otf\u0663', 'Hidden.otf\u00aa', 'Hidden.otf.png', 'Photo.png\u2800',
    'Photo.png~', 'x.woff2\u2800', 'notes.txt\u{1f512}', 'Brand.bin', 'Hidden.ot\u0301f', 'Hidden.\u043etf\u2800'];
  for (const name of ordinary) assert.equal(isGatedFontName(name), false, JSON.stringify(name));
});

test('round 5 property: no single trailing character outside letters and digits hides a font extension; none turns an ordinary file into a font', () => {
  const { isGatedFontName } = fontHandoff;
  const letterOrDigit = /[\p{L}\p{N}]/u;
  let checked = 0;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    assert.equal(isGatedFontName(`Photo.png${ch}`), false, `Photo.png + U+${cp.toString(16)}`);
    if (!letterOrDigit.test(ch.normalize('NFKD'))) {
      assert.equal(isGatedFontName(`Hidden.otf${ch}`), true, `Hidden.otf + U+${cp.toString(16)}`);
      checked++;
    }
  }
  assert.ok(checked > 100000, `checked ${checked} suffix characters`);
  // Ignorable or format characters inside the extension or before its dot do not hide it either.
  const ignorable = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    if (/[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}]/u.test(ch)) ignorable.push(ch);
  }
  for (const ch of ignorable) {
    for (let at = 0; at <= 4; at++) {
      const name = `Hidden${'.otf'.slice(0, at)}${ch}${'.otf'.slice(at)}`;
      assert.equal(isGatedFontName(name), true, JSON.stringify(name));
    }
  }
});
