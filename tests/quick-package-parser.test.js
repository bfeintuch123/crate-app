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
      const size = Buffer.byteLength(data);
      return `${String(size).padStart(9)}  01-01-2026 12:00  ${zipPath}`;
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
    return { stdout: unzipListing(), stderr: '' };
  }

  if (args[0] === '-p') {
    const zipPath = args[2];
    if (!unzipFixture.has(zipPath)) {
      throw new Error(`Missing fixture for ${zipPath}`);
    }
    return { stdout: Buffer.from(unzipFixture.get(zipPath)), stderr: '' };
  }

  throw new Error(`Unexpected unzip args: ${args.join(' ')}`);
};

setStub('child_process', () => ({
  execFile: execFileStub,
}));

const { packageMasterFile } = require('../parsers');
const { copyFileIntoPackage } = require('../parsers/package-safety');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crate-quick-package-parser-'));
}

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
