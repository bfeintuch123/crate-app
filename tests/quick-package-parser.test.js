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
