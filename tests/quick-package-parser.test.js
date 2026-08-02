const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify: nodePromisify } = require('util');

const STUBS = new Map();

function setStub(name, factory) {
  STUBS.set(name, factory);
}

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function patchedResolve(request, parent, ...rest) {
  if (STUBS.has(request)) {
    return `\0stub:${request}`;
  }
  return originalResolve.call(this, request, parent, ...rest);
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, ...rest) {
  if (STUBS.has(request)) {
    return STUBS.get(request)();
  }
  return originalLoad.call(this, request, parent, ...rest);
};

let unzipFixture = new Map();
let unzipListingError = null;

function unzipFixtureData(value) {
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'data')) {
    return value.data;
  }
  return value;
}

function unzipFixtureListedPath(zipPath, value) {
  if (value && typeof value === 'object' && typeof value.listedPath === 'string') {
    return value.listedPath;
  }
  return zipPath;
}

function matchesZipPattern(pattern, candidate) {
  const wildcardIndex = pattern.indexOf('*');
  if (wildcardIndex === -1) return pattern === candidate;
  const prefix = pattern.slice(0, wildcardIndex);
  const suffix = pattern.slice(wildcardIndex + 1);
  return candidate.startsWith(prefix) && candidate.endsWith(suffix);
}

function unzipFixtureMatches(zipPath) {
  if (unzipFixture.has(zipPath)) return [zipPath];
  if (!zipPath.includes('*')) return [];
  return [...unzipFixture.keys()].filter(candidate => matchesZipPattern(zipPath, candidate));
}

function createChildProcessStub() {
  return {
    on: () => {},
    kill: () => {},
    stdout: { on: () => {} },
    stderr: { on: () => {} },
  };
}

function unzipListing() {
  return [
    'Archive: deck.pptx',
    ...[...unzipFixture.entries()].map(([zipPath, data]) => {
      const size = Buffer.byteLength(unzipFixtureData(data));
      return `${String(size).padStart(9)}  01-01-2026 12:00  ${unzipFixtureListedPath(zipPath, data)}`;
    }),
    '',
  ].join('\n');
}

function execFileStub(...args) {
  const callback = args.find(arg => typeof arg === 'function');
  if (callback) {
    execFileStub[nodePromisify.custom](...args.filter(arg => typeof arg !== 'function'))
      .then(({ stdout, stderr }) => callback(null, stdout, stderr))
      .catch(error => callback(error));
  }
  return createChildProcessStub();
}

execFileStub[nodePromisify.custom] = async (command, args = []) => {
  if (command !== '/usr/bin/unzip') {
    throw new Error(`Unexpected command: ${command}`);
  }

  if (args[0] === '-l') {
    if (unzipListingError) throw unzipListingError;
    return { stdout: unzipListing(), stderr: '' };
  }

  if (args[0] === '-p') {
    const zipPath = args[2];
    const matches = unzipFixtureMatches(zipPath);
    if (matches.length === 0) {
      throw new Error(`Missing fixture for ${zipPath}`);
    }
    const buffers = matches.map(match => {
      const value = unzipFixture.get(match);
      if (value && typeof value === 'object' && value.error) throw value.error;
      return Buffer.from(unzipFixtureData(value));
    });
    return { stdout: Buffer.concat(buffers), stderr: '' };
  }

  throw new Error(`Unexpected unzip args: ${args.join(' ')}`);
};

setStub('child_process', () => ({
  execFile: execFileStub,
}));

const { packageMasterFile } = require('../parsers');
const {
  PackageNameAllocationError,
  copyFileIntoPackage,
  createPackageNameAllocator,
  packageCollisionKey,
} = require('../parsers/package-safety');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crate-quick-package-parser-'));
}

function assertMaterializablePackageName(name) {
  assert.ok(name.length <= 180, `${name.length} UTF-16 units exceeds Crate's limit`);
  assert.ok(Buffer.byteLength(name, 'utf8') <= 255, `${Buffer.byteLength(name, 'utf8')} UTF-8 bytes exceeds NAME_MAX`);
  assert.equal(name.includes('\uFFFD'), false);
  assert.equal(/[\uD800-\uDFFF]/u.test(name), false);
}

test('package safety shares case-insensitive Unicode-normalized collision allocation with writes', () => {
  const tmpRoot = makeTempDir();
  try {
    const outputDir = path.join(tmpRoot, 'out');
    const rawNames = ['Logo.png', 'logo.png', 'Cafe\u0301.png', 'Caf\u00e9.png', '\u03A3.png', '\u03C2.png', '\u03C3.png'];
    const sources = rawNames.map((value, index) => {
      const sourcePath = path.join(tmpRoot, `source-${index}`);
      fs.writeFileSync(sourcePath, value);
      return sourcePath;
    });
    const allocate = createPackageNameAllocator();
    const planned = rawNames.map(allocate);
    const written = rawNames.map((name, index) => path.basename(copyFileIntoPackage(sources[index], outputDir, name)));

    assert.deepEqual(planned, [
      'Logo.png', 'logo_1.png', 'Cafe\u0301.png', 'Caf\u00e9_1.png', '\u03A3.png', '\u03C2_1.png', '\u03C3_2.png',
    ]);
    assert.deepEqual(written, planned);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('package filename planning preserves code points and enforces UTF-8 component limits', () => {
  const exactAstral = createPackageNameAllocator()(`${'a'.repeat(174)}\u{1F600}.ppt`);
  const splitAstral = createPackageNameAllocator()(`${'a'.repeat(175)}\u{1F600}tail.ppt`);
  assert.equal(exactAstral, `${'a'.repeat(174)}\u{1F600}.ppt`);
  assert.equal(splitAstral, `${'a'.repeat(175)}.ppt`);

  const suffixAllocator = createPackageNameAllocator();
  const suffixBoundary = `${'b'.repeat(173)}\u{1F600}tail.ppt`;
  const first = suffixAllocator(suffixBoundary);
  const second = suffixAllocator(suffixBoundary);
  assert.equal(first, `${'b'.repeat(173)}\u{1F600}t.ppt`);
  assert.equal(second, `${'b'.repeat(173)}_1.ppt`);

  const multibyteAllocator = createPackageNameAllocator();
  const multibyteNames = Array.from({ length: 11 }, () => multibyteAllocator(`${'\u754C'.repeat(100)}.png`));
  assert.ok(multibyteNames.some(name => /_9\.png$/.test(name)));
  assert.ok(multibyteNames.some(name => /_10\.png$/.test(name)));

  for (const name of [exactAstral, splitAstral, first, second, ...multibyteNames]) {
    assertMaterializablePackageName(name);
  }
  assert.equal(new Set(multibyteNames.map(packageCollisionKey)).size, multibyteNames.length);
});

test('package filename allocation bounds pathological extensions and advances through 9 to 10', () => {
  const tmpRoot = makeTempDir();
  try {
    for (const extensionLength of [177, 178, 179]) {
      const outputDir = path.join(tmpRoot, `out-${extensionLength}`);
      const rawName = `${'n'.repeat(179)}.${'x'.repeat(extensionLength)}`;
      const sources = Array.from({ length: 11 }, (_, index) => {
        const sourcePath = path.join(tmpRoot, `source-${extensionLength}-${index}`);
        fs.writeFileSync(sourcePath, `${extensionLength}-${index}`);
        return sourcePath;
      });
      const allocate = createPackageNameAllocator();
      const planned = sources.map(() => allocate(rawName));
      const written = sources.map(sourcePath => path.basename(copyFileIntoPackage(sourcePath, outputDir, rawName)));

      assert.deepEqual(written, planned);
      assert.equal(new Set(planned.map(packageCollisionKey)).size, planned.length);
      assert.ok(planned.every(name => name.length <= 180));
      assert.match(planned[9], /_9\./);
      assert.match(planned[10], /_10\./);
    }

    const ordinaryExtension = createPackageNameAllocator()(`${'a'.repeat(220)}.presentation.jpeg`);
    assert.equal(ordinaryExtension.endsWith('.jpeg'), true);
    assert.equal(ordinaryExtension.length, 180);

    const exhausted = createPackageNameAllocator(['file.txt', 'file_1.txt'], { maxAttempts: 2 });
    assert.throws(
      () => exhausted('file.txt'),
      error => error instanceof PackageNameAllocationError && error.code === 'package_name_allocation_failed'
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Quick Package copies legacy binary PowerPoint without ZIP inspection errors', async () => {
  const tmpRoot = makeTempDir();
  try {
    const deckPath = path.join(tmpRoot, 'Legacy.ppt');
    const outputDir = path.join(tmpRoot, 'out');
    const legacyBytes = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.from('synthetic legacy PowerPoint compound document'),
    ]);
    fs.writeFileSync(deckPath, legacyBytes);
    unzipFixture = new Map();

    const result = await packageMasterFile(deckPath, outputDir);

    assert.equal(result.assetsFound, 0);
    assert.equal(result.assetsCopied, 0);
    assert.deepEqual(result.assetsMissing, []);
    assert.deepEqual(result.files.map(file => ({ copied: path.basename(file.copied), source: file.source })), [
      { copied: 'Legacy.ppt', source: 'master' },
    ]);
    assert.deepEqual(fs.readFileSync(path.join(outputDir, 'Legacy.ppt')), legacyBytes);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Quick Package materializes an astral-boundary filename without surrogate replacement', async () => {
  const tmpRoot = makeTempDir();
  try {
    const rawName = `${'q'.repeat(175)}\u{1F600}tail.ppt`;
    const deckPath = path.join(tmpRoot, rawName);
    const outputDir = path.join(tmpRoot, 'out');
    const expectedName = createPackageNameAllocator()(rawName);
    fs.writeFileSync(deckPath, Buffer.from('legacy PowerPoint astral boundary bytes'));
    unzipFixture = new Map();

    const result = await packageMasterFile(deckPath, outputDir);
    const reportedName = path.basename(result.files[0].copied);
    const materializedNames = fs.readdirSync(outputDir);

    assert.equal(reportedName, expectedName);
    assert.deepEqual(materializedNames, [expectedName]);
    assertMaterializablePackageName(expectedName);
    assert.deepEqual(fs.readFileSync(path.join(outputDir, expectedName)), Buffer.from('legacy PowerPoint astral boundary bytes'));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Quick Package extracts PowerPoint embedded media without reporting them missing', async () => {
  const tmpRoot = makeTempDir();
  try {
    const deckPath = path.join(tmpRoot, 'Presentation1.pptx');
    const outputDir = path.join(tmpRoot, 'out');
    fs.writeFileSync(deckPath, Buffer.from('pptx container bytes'));

    unzipFixture = new Map([
      ['ppt/media/image1.jpeg', 'JPEG_BINARY_SHOULD_NOT_LEAK'.repeat(40)],
      ['ppt/media/image2.png', 'PNG_BINARY_SHOULD_NOT_LEAK'.repeat(40)],
    ]);

    const result = await packageMasterFile(deckPath, outputDir);

    assert.deepEqual(
      Object.keys(result).sort(),
      ['assetsCopied', 'assetsFound', 'assetsMissing', 'files', 'masterFile', 'outputDir'].sort()
    );
    assert.equal(result.masterFile, deckPath);
    assert.equal(result.assetsFound, 2);
    assert.equal(result.assetsCopied, 2);
    assert.deepEqual(result.assetsMissing, []);

    assert.equal(fs.readFileSync(path.join(outputDir, 'Presentation1.pptx'), 'utf8'), 'pptx container bytes');
    assert.equal(
      fs.readFileSync(path.join(outputDir, 'Presentation1 — image1.jpeg'), 'utf8'),
      'JPEG_BINARY_SHOULD_NOT_LEAK'.repeat(40)
    );
    assert.equal(
      fs.readFileSync(path.join(outputDir, 'Presentation1 — image2.png'), 'utf8'),
      'PNG_BINARY_SHOULD_NOT_LEAK'.repeat(40)
    );
    assert.deepEqual(
      result.files.map(file => ({ copied: path.basename(file.copied), source: file.source })),
      [
        { copied: 'Presentation1.pptx', source: 'master' },
        { copied: 'Presentation1 — image1.jpeg', source: 'embedded' },
        { copied: 'Presentation1 — image2.png', source: 'embedded' },
      ]
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Quick Package dedupes duplicate PowerPoint embedded media by content', async () => {
  const tmpRoot = makeTempDir();
  try {
    const deckPath = path.join(tmpRoot, 'Presentation1.pptx');
    const outputDir = path.join(tmpRoot, 'out');
    fs.writeFileSync(deckPath, Buffer.from('pptx container bytes'));

    const duplicateImage = 'PPT_DUPLICATE_IMAGE_BYTES_SHOULD_NOT_LEAK'.repeat(40);
    unzipFixture = new Map([
      ['ppt/media/image1.jpeg', duplicateImage],
      ['ppt/media/image2.jpeg', duplicateImage],
      ['ppt/media/image3.png', 'PPT_UNIQUE_IMAGE_BYTES_SHOULD_NOT_LEAK'.repeat(40)],
    ]);

    const result = await packageMasterFile(deckPath, outputDir);

    assert.equal(result.assetsFound, 3);
    assert.equal(result.assetsCopied, 2);
    assert.deepEqual(result.assetsMissing, []);
    assert.equal(
      fs.readFileSync(path.join(outputDir, 'Presentation1 — image1.jpeg'), 'utf8'),
      duplicateImage
    );
    assert.equal(fs.existsSync(path.join(outputDir, 'Presentation1 — image2.jpeg')), false);
    assert.equal(
      fs.readFileSync(path.join(outputDir, 'Presentation1 — image3.png'), 'utf8'),
      'PPT_UNIQUE_IMAGE_BYTES_SHOULD_NOT_LEAK'.repeat(40)
    );
    assert.deepEqual(
      result.files.map(file => ({ copied: path.basename(file.copied), source: file.source })),
      [
        { copied: 'Presentation1.pptx', source: 'master' },
        { copied: 'Presentation1 — image1.jpeg', source: 'embedded' },
        { copied: 'Presentation1 — image3.png', source: 'embedded' },
      ]
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Quick Package reports only failed PowerPoint embedded media as missing', async () => {
  const tmpRoot = makeTempDir();
  try {
    const deckPath = path.join(tmpRoot, 'Presentation1.pptx');
    const outputDir = path.join(tmpRoot, 'out');
    fs.writeFileSync(deckPath, Buffer.from('pptx container bytes'));

    unzipFixture = new Map([
      ['ppt/media/image1.jpeg', 'JPEG_BINARY_SHOULD_NOT_LEAK'.repeat(40)],
      ['ppt/media/image2.png', {
        data: 'PNG_BINARY_SHOULD_NOT_LEAK'.repeat(40),
        error: new Error(`unzip RAW_STDERR /private/tmp/crate-secret ${tmpRoot}`),
      }],
    ]);

    const result = await packageMasterFile(deckPath, outputDir);

    assert.deepEqual(
      Object.keys(result).sort(),
      ['assetsCopied', 'assetsFound', 'assetsMissing', 'files', 'masterFile', 'outputDir'].sort()
    );
    assert.equal(result.assetsFound, 2);
    assert.equal(result.assetsCopied, 1);
    assert.deepEqual(result.assetsMissing, [{
      path: 'Could not extract embedded media image2.png from Presentation1.pptx.',
      source: 'pptx-embedded',
    }]);

    const missingText = JSON.stringify(result.assetsMissing);
    assert.equal(missingText.includes('image1.jpeg'), false);
    assert.equal(missingText.includes('RAW_STDERR'), false);
    assert.equal(missingText.includes('unzip'), false);
    assert.equal(missingText.includes('/private/tmp'), false);
    assert.equal(missingText.includes(tmpRoot), false);

    assert.equal(
      fs.readFileSync(path.join(outputDir, 'Presentation1 — image1.jpeg'), 'utf8'),
      'JPEG_BINARY_SHOULD_NOT_LEAK'.repeat(40)
    );
    assert.equal(fs.existsSync(path.join(outputDir, 'Presentation1 — image2.png')), false);
    assert.deepEqual(
      result.files.map(file => ({ copied: path.basename(file.copied), source: file.source })),
      [
        { copied: 'Presentation1.pptx', source: 'master' },
        { copied: 'Presentation1 — image1.jpeg', source: 'embedded' },
      ]
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Quick Package extracts Keynote Data media and ignores Keynote archive junk', async () => {
  const tmpRoot = makeTempDir();
  try {
    const deckPath = path.join(tmpRoot, 'Keynote Deck.key');
    const outputDir = path.join(tmpRoot, 'out');
    fs.writeFileSync(deckPath, Buffer.from('keynote container bytes'));

    unzipFixture = new Map([
      ['Data/photo-1234.jpeg', 'KEYNOTE_JPEG_BINARY_SHOULD_NOT_LEAK'.repeat(40)],
      ['Data/logo.png', 'KEYNOTE_PNG_BINARY_SHOULD_NOT_LEAK'.repeat(40)],
      ['Data/.hidden.png', 'KEYNOTE_HIDDEN_BINARY_SHOULD_NOT_LEAK'.repeat(40)],
      ['__MACOSX/Data/logo.png', 'KEYNOTE_MACOSX_BINARY_SHOULD_NOT_LEAK'.repeat(40)],
      ['Data/st-1234abcd-5678.jpeg', 'KEYNOTE_SLIDE_THUMB_BINARY_SHOULD_NOT_LEAK'.repeat(40)],
      ['Data/mt-1234.jpeg', 'KEYNOTE_THEME_BINARY_SHOULD_NOT_LEAK'.repeat(40)],
      ['Data/bg-abcdef.jpeg', 'KEYNOTE_BACKGROUND_BINARY_SHOULD_NOT_LEAK'.repeat(40)],
      ['Data/tx-abcdef.jpg', 'KEYNOTE_TEXT_BINARY_SHOULD_NOT_LEAK'.repeat(40)],
      ['Data/photo-1234-small.jpeg', 'KEYNOTE_SMALL_BINARY_SHOULD_NOT_LEAK'.repeat(40)],
    ]);

    const result = await packageMasterFile(deckPath, outputDir);

    assert.deepEqual(
      Object.keys(result).sort(),
      ['assetsCopied', 'assetsFound', 'assetsMissing', 'files', 'masterFile', 'outputDir'].sort()
    );
    assert.equal(result.masterFile, deckPath);
    assert.equal(result.assetsFound, 2);
    assert.equal(result.assetsCopied, 2);
    assert.deepEqual(result.assetsMissing, []);

    assert.deepEqual(fs.readdirSync(outputDir).sort(), [
      'Keynote Deck — logo.png',
      'Keynote Deck — photo.jpeg',
      'Keynote Deck.key',
    ]);
    assert.equal(fs.readFileSync(path.join(outputDir, 'Keynote Deck.key'), 'utf8'), 'keynote container bytes');
    assert.equal(
      fs.readFileSync(path.join(outputDir, 'Keynote Deck — photo.jpeg'), 'utf8'),
      'KEYNOTE_JPEG_BINARY_SHOULD_NOT_LEAK'.repeat(40)
    );
    assert.equal(
      fs.readFileSync(path.join(outputDir, 'Keynote Deck — logo.png'), 'utf8'),
      'KEYNOTE_PNG_BINARY_SHOULD_NOT_LEAK'.repeat(40)
    );
    assert.deepEqual(
      result.files.map(file => ({ copied: path.basename(file.copied), source: file.source })),
      [
        { copied: 'Keynote Deck.key', source: 'master' },
        { copied: 'Keynote Deck — photo.jpeg', source: 'embedded' },
        { copied: 'Keynote Deck — logo.png', source: 'embedded' },
      ]
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Quick Package extracts Keynote media with mojibake-listed archive names through a unique safe tail', async () => {
  const tmpRoot = makeTempDir();
  try {
    const deckPath = path.join(tmpRoot, 'Keynote Deck.key');
    const outputDir = path.join(tmpRoot, 'out');
    fs.writeFileSync(deckPath, Buffer.from('keynote container bytes'));

    unzipFixture = new Map([
      ['Data/Presentation1-QA3-QuickPackage-Smoke raw-bytes image2-9089.png', {
        listedPath: 'Data/Presentation1-QA3-QuickPackage-Smoke \uFFFD\uFFFD\uFFFD image2-9089.png',
        data: 'KEYNOTE_MOJIBAKE_BINARY_SHOULD_NOT_LEAK'.repeat(40),
      }],
    ]);

    const result = await packageMasterFile(deckPath, outputDir);

    assert.equal(result.assetsFound, 1);
    assert.equal(result.assetsCopied, 1);
    assert.deepEqual(result.assetsMissing, []);
    assert.deepEqual(fs.readdirSync(outputDir).sort(), [
      'Keynote Deck — image2.png',
      'Keynote Deck.key',
    ]);
    assert.equal(
      fs.readFileSync(path.join(outputDir, 'Keynote Deck — image2.png'), 'utf8'),
      'KEYNOTE_MOJIBAKE_BINARY_SHOULD_NOT_LEAK'.repeat(40)
    );
    assert.deepEqual(
      result.files.map(file => ({ copied: path.basename(file.copied), source: file.source })),
      [
        { copied: 'Keynote Deck.key', source: 'master' },
        { copied: 'Keynote Deck — image2.png', source: 'embedded' },
      ]
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Quick Package extracts Keynote media with mixed mojibake tails without false missing assets', async () => {
  const tmpRoot = makeTempDir();
  try {
    const deckPath = path.join(tmpRoot, 'Keynote Deck.key');
    const outputDir = path.join(tmpRoot, 'out');
    fs.writeFileSync(deckPath, Buffer.from('keynote container bytes'));

    unzipFixture = new Map([
      ['Data/Screenshot 2026-03-10 at 9.07-9090.png', 'KEYNOTE_EXACT_SCREENSHOT_BINARY_SHOULD_NOT_LEAK'.repeat(40)],
      ['Data/Screenshot 2026-03-10 at 9.07.43 raw-bytes PM-9089.png', {
        listedPath: 'Data/Screenshot 2026-03-10 at 9.07.43\uFFFD\u01FBPM-9089.png',
        data: 'KEYNOTE_MIXED_MOJIBAKE_BINARY_SHOULD_NOT_LEAK'.repeat(40),
      }],
    ]);

    const result = await packageMasterFile(deckPath, outputDir);

    assert.equal(result.assetsFound, 2);
    assert.equal(result.assetsCopied, 2);
    assert.deepEqual(result.assetsMissing, []);
    assert.deepEqual(fs.readdirSync(outputDir).sort(), [
      'Keynote Deck — Screenshot 2026-03-10 at 9.07.43 PM.png',
      'Keynote Deck — Screenshot 2026-03-10 at 9.07.png',
      'Keynote Deck.key',
    ]);
    assert.equal(fs.existsSync(path.join(outputDir, 'Keynote Deck — PM.png')), false);
    assert.equal(
      fs.readFileSync(path.join(outputDir, 'Keynote Deck — Screenshot 2026-03-10 at 9.07.png'), 'utf8'),
      'KEYNOTE_EXACT_SCREENSHOT_BINARY_SHOULD_NOT_LEAK'.repeat(40)
    );
    assert.equal(
      fs.readFileSync(path.join(outputDir, 'Keynote Deck — Screenshot 2026-03-10 at 9.07.43 PM.png'), 'utf8'),
      'KEYNOTE_MIXED_MOJIBAKE_BINARY_SHOULD_NOT_LEAK'.repeat(40)
    );
    assert.deepEqual(
      result.files.map(file => ({ copied: path.basename(file.copied), source: file.source })),
      [
        { copied: 'Keynote Deck.key', source: 'master' },
        { copied: 'Keynote Deck — Screenshot 2026-03-10 at 9.07.png', source: 'embedded' },
        { copied: 'Keynote Deck — Screenshot 2026-03-10 at 9.07.43 PM.png', source: 'embedded' },
      ]
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Quick Package fails closed for ambiguous Keynote mojibake wildcard tails', async () => {
  const tmpRoot = makeTempDir();
  try {
    const deckPath = path.join(tmpRoot, 'Keynote Deck.key');
    const outputDir = path.join(tmpRoot, 'out');
    fs.writeFileSync(deckPath, Buffer.from('keynote container bytes'));

    unzipFixture = new Map([
      ['Data/raw-entry-a PM-9089.png', {
        listedPath: 'Data/Slide A \uFFFD\u01FBPM-9089.png',
        data: 'KEYNOTE_AMBIGUOUS_A_BINARY_SHOULD_NOT_LEAK'.repeat(40),
      }],
      ['Data/raw-entry-b PM-9089.png', {
        listedPath: 'Data/Slide B \uFFFD\u01FBPM-9089.png',
        data: 'KEYNOTE_AMBIGUOUS_B_BINARY_SHOULD_NOT_LEAK'.repeat(40),
      }],
    ]);

    const result = await packageMasterFile(deckPath, outputDir);

    assert.equal(result.assetsFound, 2);
    assert.equal(result.assetsCopied, 0);
    assert.deepEqual(result.assetsMissing, [
      {
        path: 'Could not extract embedded media PM-9089.png from Keynote Deck.key.',
        source: 'keynote-embedded',
      },
      {
        path: 'Could not extract embedded media PM-9089.png from Keynote Deck.key.',
        source: 'keynote-embedded',
      },
    ]);
    assert.deepEqual(fs.readdirSync(outputDir).sort(), ['Keynote Deck.key']);

    const missingText = JSON.stringify(result.assetsMissing);
    assert.equal(missingText.includes('KEYNOTE_AMBIGUOUS_A_BINARY_SHOULD_NOT_LEAK'), false);
    assert.equal(missingText.includes('KEYNOTE_AMBIGUOUS_B_BINARY_SHOULD_NOT_LEAK'), false);
    assert.equal(missingText.includes('unzip'), false);
    assert.equal(missingText.includes('/private/tmp'), false);
    assert.equal(missingText.includes(tmpRoot), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Quick Package reports only failed Keynote embedded media as missing', async () => {
  const tmpRoot = makeTempDir();
  try {
    const deckPath = path.join(tmpRoot, 'Presentation1.key');
    const outputDir = path.join(tmpRoot, 'out');
    fs.writeFileSync(deckPath, Buffer.from('keynote container bytes'));

    unzipFixture = new Map([
      ['Data/photo-1234.jpeg', 'KEYNOTE_JPEG_BINARY_SHOULD_NOT_LEAK'.repeat(40)],
      ['Data/clip-5678.mov', {
        data: 'KEYNOTE_MOV_BINARY_SHOULD_NOT_LEAK'.repeat(40),
        error: new Error(`unzip RAW_STDERR /private/tmp/crate-secret ${tmpRoot}`),
      }],
    ]);

    const result = await packageMasterFile(deckPath, outputDir);

    assert.deepEqual(
      Object.keys(result).sort(),
      ['assetsCopied', 'assetsFound', 'assetsMissing', 'files', 'masterFile', 'outputDir'].sort()
    );
    assert.equal(result.assetsFound, 2);
    assert.equal(result.assetsCopied, 1);
    assert.deepEqual(result.assetsMissing, [{
      path: 'Could not extract embedded media clip-5678.mov from Presentation1.key.',
      source: 'keynote-embedded',
    }]);

    const missingText = JSON.stringify(result.assetsMissing);
    assert.equal(missingText.includes('photo-1234.jpeg'), false);
    assert.equal(missingText.includes('RAW_STDERR'), false);
    assert.equal(missingText.includes('unzip'), false);
    assert.equal(missingText.includes('/private/tmp'), false);
    assert.equal(missingText.includes(tmpRoot), false);

    assert.equal(
      fs.readFileSync(path.join(outputDir, 'Presentation1 — photo.jpeg'), 'utf8'),
      'KEYNOTE_JPEG_BINARY_SHOULD_NOT_LEAK'.repeat(40)
    );
    assert.equal(fs.existsSync(path.join(outputDir, 'Presentation1 — clip.mov')), false);
    assert.deepEqual(
      result.files.map(file => ({ copied: path.basename(file.copied), source: file.source })),
      [
        { copied: 'Presentation1.key', source: 'master' },
        { copied: 'Presentation1 — photo.jpeg', source: 'embedded' },
      ]
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Quick Package contains parser-controlled embedded filenames', async () => {
  const tmpRoot = makeTempDir();
  try {
    const deckPath = path.join(tmpRoot, 'Presentation1.pptx');
    const outputDir = path.join(tmpRoot, 'out');
    fs.writeFileSync(deckPath, Buffer.from('pptx container bytes'));

    unzipFixture = new Map([
      ['ppt/media/../escape.png', 'ESCAPE_BINARY_SHOULD_NOT_LEAK'.repeat(40)],
    ]);

    const result = await packageMasterFile(deckPath, outputDir);

    assert.equal(result.assetsFound, 1);
    assert.equal(result.assetsCopied, 1);
    assert.deepEqual(result.assetsMissing, []);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'escape.png')), false);
    assert.equal(
      fs.readFileSync(path.join(outputDir, 'Presentation1 — escape.png'), 'utf8'),
      'ESCAPE_BINARY_SHOULD_NOT_LEAK'.repeat(40)
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Quick Package rejects symlink output folders before writing files', async () => {
  const tmpRoot = makeTempDir();
  try {
    const deckPath = path.join(tmpRoot, 'Presentation1.pptx');
    const realOutputDir = path.join(tmpRoot, 'real-out');
    const symlinkOutputDir = path.join(tmpRoot, 'out-link');
    fs.writeFileSync(deckPath, Buffer.from('pptx container bytes'));
    fs.mkdirSync(realOutputDir);
    try {
      fs.symlinkSync(realOutputDir, symlinkOutputDir, 'dir');
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES') return;
      throw e;
    }

    unzipFixture = new Map([
      ['ppt/media/image1.jpeg', 'JPEG_BINARY_SHOULD_NOT_LEAK'.repeat(40)],
    ]);

    await assert.rejects(
      () => packageMasterFile(deckPath, symlinkOutputDir),
      (error) => {
        assert.match(error.message, /Package output folder is a symlink/);
        assert.equal(error.message.includes(realOutputDir), false);
        return true;
      }
    );
    assert.deepEqual(fs.readdirSync(realOutputDir), []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Package safety rejects symlink intermediate output directories before writing files', () => {
  const tmpRoot = makeTempDir();
  try {
    const sourcePath = path.join(tmpRoot, 'logo.png');
    const outputDir = path.join(tmpRoot, 'out');
    const realTargetDir = path.join(tmpRoot, 'real-target');
    const symlinkAssetDir = path.join(outputDir, 'assets');
    fs.writeFileSync(sourcePath, Buffer.from('logo bytes'));
    fs.mkdirSync(outputDir);
    fs.mkdirSync(realTargetDir);
    try {
      fs.symlinkSync(realTargetDir, symlinkAssetDir, 'dir');
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES') return;
      throw e;
    }

    assert.throws(
      () => copyFileIntoPackage(sourcePath, outputDir, 'assets/logo.png', {
        preserveRelativePath: true,
        fallbackName: 'logo.png',
      }),
      (error) => {
        assert.match(error.message, /Package destination directory is a symlink/);
        assert.equal(error.message.includes(realTargetDir), false);
        return true;
      }
    );
    assert.deepEqual(fs.readdirSync(realTargetDir), []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Quick Package rejects symlink master files before parsing', async () => {
  const tmpRoot = makeTempDir();
  try {
    const realDeckPath = path.join(tmpRoot, 'Presentation1.pptx');
    const symlinkDeckPath = path.join(tmpRoot, 'LinkedPresentation.pptx');
    const outputDir = path.join(tmpRoot, 'out');
    fs.writeFileSync(realDeckPath, Buffer.from('pptx container bytes'));
    try {
      fs.symlinkSync(realDeckPath, symlinkDeckPath);
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES') return;
      throw e;
    }

    unzipFixture = new Map([
      ['ppt/media/image1.jpeg', 'JPEG_BINARY_SHOULD_NOT_LEAK'.repeat(40)],
    ]);

    await assert.rejects(
      () => packageMasterFile(symlinkDeckPath, outputDir),
      /Symlink source files are not copied/
    );
    assert.equal(fs.existsSync(outputDir), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Quick Package still reports real missing linked filesystem assets', async () => {
  const tmpRoot = makeTempDir();
  try {
    const aiPath = path.join(tmpRoot, 'MissingLinked.ai');
    const outputDir = path.join(tmpRoot, 'out');
    const missingPath = '/Users/crate-test-missing-linked-asset-does-not-exist/image1.jpeg';
    fs.writeFileSync(aiPath, Buffer.from(`%PDF linked asset ${missingPath}`));

    const result = await packageMasterFile(aiPath, outputDir);

    assert.equal(result.assetsFound, 1);
    assert.equal(result.assetsCopied, 0);
    assert.deepEqual(result.assetsMissing, [{ path: missingPath, source: 'ai-regex' }]);
    assert.equal(fs.readFileSync(path.join(outputDir, 'MissingLinked.ai'), 'utf8'), `%PDF linked asset ${missingPath}`);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Quick Package surfaces PowerPoint archive inspection failures without changing result shape', async () => {
  const tmpRoot = makeTempDir();
  unzipListingError = new Error(`unzip RAW_STDERR /private/tmp/crate-secret ${tmpRoot}`);
  try {
    const deckPath = path.join(tmpRoot, 'Presentation1.pptx');
    const outputDir = path.join(tmpRoot, 'out');
    fs.writeFileSync(deckPath, Buffer.from('not a zip archive'));
    unzipFixture = new Map();

    const result = await packageMasterFile(deckPath, outputDir);

    assert.deepEqual(
      Object.keys(result).sort(),
      ['assetsCopied', 'assetsFound', 'assetsMissing', 'files', 'masterFile', 'outputDir'].sort()
    );
    assert.equal(result.masterFile, deckPath);
    assert.equal(result.assetsFound, 0);
    assert.equal(result.assetsCopied, 0);
    assert.deepEqual(result.assetsMissing, [{
      path: 'Could not inspect embedded media in Presentation1.pptx.',
      source: 'pptx-embedded',
    }]);
    assert.equal(fs.readFileSync(path.join(outputDir, 'Presentation1.pptx'), 'utf8'), 'not a zip archive');

    const missingText = JSON.stringify(result.assetsMissing);
    assert.equal(missingText.includes('RAW_STDERR'), false);
    assert.equal(missingText.includes('unzip'), false);
    assert.equal(missingText.includes('/private/tmp'), false);
    assert.equal(missingText.includes(tmpRoot), false);
  } finally {
    unzipListingError = null;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Quick Package surfaces Keynote archive inspection failures without changing result shape', async () => {
  const tmpRoot = makeTempDir();
  unzipListingError = new Error(`unzip RAW_STDERR /private/tmp/crate-secret ${tmpRoot}`);
  try {
    const deckPath = path.join(tmpRoot, 'Presentation1.key');
    const outputDir = path.join(tmpRoot, 'out');
    fs.writeFileSync(deckPath, Buffer.from('not a zip archive'));
    unzipFixture = new Map();

    const result = await packageMasterFile(deckPath, outputDir);

    assert.deepEqual(
      Object.keys(result).sort(),
      ['assetsCopied', 'assetsFound', 'assetsMissing', 'files', 'masterFile', 'outputDir'].sort()
    );
    assert.equal(result.masterFile, deckPath);
    assert.equal(result.assetsFound, 0);
    assert.equal(result.assetsCopied, 0);
    assert.deepEqual(result.assetsMissing, [{
      path: 'Could not inspect embedded media in Presentation1.key.',
      source: 'keynote-embedded',
    }]);
    assert.equal(fs.readFileSync(path.join(outputDir, 'Presentation1.key'), 'utf8'), 'not a zip archive');

    const missingText = JSON.stringify(result.assetsMissing);
    assert.equal(missingText.includes('RAW_STDERR'), false);
    assert.equal(missingText.includes('unzip'), false);
    assert.equal(missingText.includes('/private/tmp'), false);
    assert.equal(missingText.includes(tmpRoot), false);
  } finally {
    unzipListingError = null;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
