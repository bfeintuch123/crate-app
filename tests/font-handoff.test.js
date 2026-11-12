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
});

test('open-licence evidence needs the font to state SIL OFL 1.1 in every face, not just embedding flags', () => {
  const ofl = { licence: OFL_STATEMENT, licenceUrl: 'https://openfontlicense.org', fsType: 0 };
  assert.equal(detectOpenLicence([ofl]), 'ofl-1.1');
  assert.equal(detectOpenLicence([{ licence: 'Licensed under the SIL Open Font License', licenceUrl: 'http://scripts.sil.org/OFL' }]), 'ofl-1.1');
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
  assert.match(statement, /BrandSans\.ttc/);
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
