const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  FALLBACK_EXTENSION_FOLDER,
  PACKAGE_OUTPUT_LAYOUT_MODES,
  getPackageExtensionFolderName,
  getPackageOutputRelativePath,
  normalizePackageOutputLayoutMode,
} = require('../parsers/package-safety');

test('layout mode normalization preserves only the versioned organized mode', () => {
  assert.equal(
    normalizePackageOutputLayoutMode(PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION),
    PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION
  );
  for (const value of [undefined, null, '', 'organized', 'by-extension-v2', {}, []]) {
    assert.equal(normalizePackageOutputLayoutMode(value), PACKAGE_OUTPUT_LAYOUT_MODES.FLAT);
  }
});

test('file types map to deterministic uppercase extension folders', () => {
  const cases = [
    ['Brand-System.ai', 'AI'],
    ['Layered-Mockup.PSD', 'PSD'],
    ['Layout.indd', 'INDD'],
    ['Launch-Deck.pptx', 'PPTX'],
    ['Presentation.key', 'KEY'],
    ['Local-Copy.fig', 'FIG'],
    ['Live-Document.webloc', 'WEBLOC'],
    ['Campaign.png', 'PNG'],
    ['Logo.svg', 'SVG'],
    ['Proof.pdf', 'PDF'],
    ['Clip.mov', 'MOV'],
    ['archive.tar.gz', 'GZ'],
  ];

  for (const [fileName, folderName] of cases) {
    assert.equal(getPackageExtensionFolderName(fileName), folderName, fileName);
  }
});

test('each safe image extension retains its actual uppercase file type', () => {
  const cases = [
    ['photo.jpg', 'JPG'],
    ['photo.JPG', 'JPG'],
    ['photo.jpeg', 'JPEG'],
    ['photo.JpEg', 'JPEG'],
    ['photo.jpe', 'JPE'],
    ['scan.tif', 'TIF'],
    ['scan.TIF', 'TIF'],
    ['scan.tiff', 'TIFF'],
    ['scan.TiFf', 'TIFF'],
  ];
  for (const [fileName, expectedFolder] of cases) {
    assert.equal(getPackageExtensionFolderName(fileName), expectedFolder, fileName);
  }
});

test('extension folders use only the extension characters preserved in output names', () => {
  const maximumExtension = 'a'.repeat(31);
  const oversizedExtension = 'b'.repeat(32);

  assert.equal(
    getPackageExtensionFolderName(`file.${maximumExtension}`),
    maximumExtension.toUpperCase()
  );
  assert.equal(
    getPackageOutputRelativePath(
      `file.${maximumExtension}`,
      PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION
    ),
    `${maximumExtension.toUpperCase()}/file.${maximumExtension}`
  );
  assert.equal(
    getPackageExtensionFolderName(`file.${oversizedExtension}`),
    FALLBACK_EXTENSION_FOLDER
  );
  assert.equal(
    getPackageOutputRelativePath(
      `file.${oversizedExtension}`,
      PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION
    ),
    `OTHER/file.${'b'.repeat(31)}`
  );
});

test('missing or unsafe extensions use the OTHER folder', () => {
  const cases = [
    'README',
    '.hidden',
    'trailing-dot.',
    'invalid.a b',
    'invalid.p?ng',
    'invalid.p*ng',
    'invalid.p:ng',
    'reserved.con',
    'reserved.NUL',
  ];

  for (const fileName of cases) {
    assert.equal(getPackageExtensionFolderName(fileName), FALLBACK_EXTENSION_FOLDER, fileName);
  }
});

test('safe unrecognized extensions retain their actual file type', () => {
  assert.equal(getPackageExtensionFolderName('reference.crateunknown'), 'CRATEUNKNOWN');
  assert.equal(
    getPackageOutputRelativePath(
      'reference.crateunknown',
      PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION
    ),
    'CRATEUNKNOWN/reference.crateunknown'
  );
});

test('non-string output names consistently use the fallback file identity', () => {
  const values = [undefined, null, 0, false, 42, {}, [], Symbol('x'), Object.create(null)];
  for (const value of values) {
    assert.equal(getPackageExtensionFolderName(value), FALLBACK_EXTENSION_FOLDER);
    assert.equal(getPackageOutputRelativePath(value, PACKAGE_OUTPUT_LAYOUT_MODES.FLAT), 'file');
    assert.equal(
      getPackageOutputRelativePath(value, PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION),
      'OTHER/file'
    );
  }
});

test('flat mode preserves the current sanitized filename-only layout', () => {
  assert.equal(getPackageOutputRelativePath('Brand-System.ai', 'flat'), 'Brand-System.ai');
  assert.equal(getPackageOutputRelativePath('../unsafe/Logo.png', 'flat'), 'Logo.png');
  assert.equal(getPackageOutputRelativePath('nested\\Deck.pptx', 'flat'), 'Deck.pptx');
  assert.equal(getPackageOutputRelativePath('C:Deck.pptx', 'flat'), 'C_Deck.pptx');
});

test('organized mode returns a safe folder and filename relative path', () => {
  const cases = [
    ['Brand-System.ai', 'AI/Brand-System.ai'],
    ['campaign-hero.jpg', 'JPG/campaign-hero.jpg'],
    ['Reference.png', 'PNG/Reference.png'],
    ['README', 'OTHER/README'],
    ['../outside/Proof.pdf', 'PDF/Proof.pdf'],
    ['nested\\Deck.pptx', 'PPTX/Deck.pptx'],
    ['bad\0name.svg', 'SVG/bad_name.svg'],
  ];

  for (const [fileName, expected] of cases) {
    const relativePath = getPackageOutputRelativePath(
      fileName,
      PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION
    );
    assert.equal(relativePath, expected, fileName);
    assert.equal(path.posix.isAbsolute(relativePath), false);
    assert.equal(relativePath.split('/').includes('..'), false);
  }
});

test('organized paths are deterministic and keep distinct output filenames', () => {
  const fileNames = ['Logo.png', 'logo_1.png', 'Logo.ai', 'logo_1.ai'];
  const first = fileNames.map(fileName => getPackageOutputRelativePath(
    fileName,
    PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION
  ));
  const second = fileNames.map(fileName => getPackageOutputRelativePath(
    fileName,
    PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION
  ));

  assert.deepEqual(first, second);
  assert.deepEqual(first, [
    'PNG/Logo.png',
    'PNG/logo_1.png',
    'AI/Logo.ai',
    'AI/logo_1.ai',
  ]);
});

test('organized paths satisfy the cross-platform relative-path contract', () => {
  const cases = [
    ['../outside/Proof.pdf', 'PDF', 'Proof.pdf'],
    ['/absolute/Logo.PNG', 'PNG', 'Logo.PNG'],
    ['C:\\working\\Deck.pptx', 'PPTX', 'Deck.pptx'],
    ['C:Deck.pptx', 'PPTX', 'C_Deck.pptx'],
    ['\\\\server\\share\\Layout.indd', 'INDD', 'Layout.indd'],
    ['nested/./asset.svg', 'SVG', 'asset.svg'],
    ['nested/../asset.svg', 'SVG', 'asset.svg'],
    ['.env.local', 'LOCAL', '.env.local'],
    ['archive.tar.gz', 'GZ', 'archive.tar.gz'],
    ['trailing-space.txt ', FALLBACK_EXTENSION_FOLDER, 'trailing-space.txt'],
    ['trailing-dot.txt. ', FALLBACK_EXTENSION_FOLDER, 'trailing-dot.txt.'],
    ['bad\0name.png', 'PNG', 'bad_name.png'],
    ['bad\nname.png', 'PNG', 'bad_name.png'],
    ['Cafe\u0301.PNG', 'PNG', 'Cafe\u0301.PNG'],
    ['日本語.画像', FALLBACK_EXTENSION_FOLDER, '日本語.画像'],
    ['mystery.crateunknown', 'CRATEUNKNOWN', 'mystery.crateunknown'],
    ['unsafe.p?ng', FALLBACK_EXTENSION_FOLDER, 'unsafe.p_ng'],
  ];

  for (const [inputName, expectedFolder, expectedFileName] of cases) {
    const relativePath = getPackageOutputRelativePath(
      inputName,
      PACKAGE_OUTPUT_LAYOUT_MODES.BY_EXTENSION
    );
    const parts = relativePath.split('/');

    assert.equal(relativePath, `${expectedFolder}/${expectedFileName}`, inputName);
    assert.deepEqual(parts, [expectedFolder, expectedFileName], inputName);
    assert.equal(path.posix.normalize(relativePath), relativePath, inputName);
    assert.equal(path.posix.isAbsolute(relativePath), false, inputName);
    assert.equal(path.win32.isAbsolute(relativePath), false, inputName);
    assert.equal(relativePath.includes('\\'), false, inputName);
    assert.equal(parts.some(part => !part || part === '.' || part === '..'), false, inputName);
  }
});
