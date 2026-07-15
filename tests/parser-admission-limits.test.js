const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { constants: bufferConstants } = require('buffer');
const { promisify: nodePromisify } = require('util');

let unzipListing = '';
let unzipListingError = null;
let unzipExtractCalls = 0;
let unzipExtractData = new Map();
let unzipExtractErrors = new Map();

function createChildProcessStub() {
  return {
    on: () => {},
    kill: () => {},
    stdout: { on: () => {} },
    stderr: { on: () => {} },
  };
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
    return { stdout: unzipListing, stderr: '' };
  }
  if (args[0] === '-p') {
    unzipExtractCalls += 1;
    if (unzipExtractErrors.has(args[2])) throw unzipExtractErrors.get(args[2]);
    if (unzipExtractData.has(args[2])) {
      return { stdout: unzipExtractData.get(args[2]), stderr: '' };
    }
    throw new Error('Archive extraction should not run after admission fails');
  }
  throw new Error(`Unexpected unzip args: ${args.join(' ')}`);
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, ...rest) {
  if (request === 'child_process') {
    return { execFile: execFileStub };
  }
  return originalLoad.call(this, request, parent, ...rest);
};

const { BaseParser } = require('../parsers/base');
const { AIParser } = require('../parsers/ai');
const { PSDParser } = require('../parsers/psd');
const { AfterEffectsParser } = require('../parsers/aftereffects');
const { PremiereParser, getPremiereInputBudget } = require('../parsers/premiere');
const { PowerPointParser } = require('../parsers/powerpoint');
const { InDesignParser } = require('../parsers/indesign');
const { packageMasterFile } = require('../parsers');
const {
  ADMISSION_LIMITS,
  assertEntriesWithinBudget,
  decompressGzipWithinBudget,
  isParserAdmissionError,
  readFileWithinBudget,
} = require('../parsers/admission-budgets');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crate-parser-admission-'));
}

test('whole-file parser reads reject an oversized sparse file before allocating it', () => {
  const tmpRoot = makeTempDir();
  try {
    const filePath = path.join(tmpRoot, 'oversized.ai');
    fs.closeSync(fs.openSync(filePath, 'w'));
    fs.truncateSync(filePath, ADMISSION_LIMITS.localParserFileBytes + 1);

    const parser = new BaseParser();
    assert.throws(
      () => parser.readFileBuffer(filePath),
      error => isParserAdmissionError(error)
        && error.message === 'This design file is too large for Crate to inspect safely.'
        && !error.message.includes(tmpRoot)
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('whole-file and Premiere output budgets stay below Electron string limits', () => {
  assert.ok(ADMISSION_LIMITS.localParserFileBytes <= bufferConstants.MAX_STRING_LENGTH);
  assert.ok(ADMISSION_LIMITS.premiereDecompressedBytes <= bufferConstants.MAX_STRING_LENGTH);
  assert.ok(ADMISSION_LIMITS.localParserFileBytes <= 256 * 1024 * 1024);
  assert.ok(ADMISSION_LIMITS.premiereCompressedBytes <= 128 * 1024 * 1024);
  assert.ok(ADMISSION_LIMITS.premiereDecompressedBytes <= 256 * 1024 * 1024);
  assert.equal(getPremiereInputBudget(Buffer.from('plain project')), ADMISSION_LIMITS.localParserFileBytes);
  assert.equal(getPremiereInputBudget(Buffer.from([0x1f, 0x8b])), ADMISSION_LIMITS.premiereCompressedBytes);
});

test('same-descriptor reads select separate plain and gzip budgets from the header', () => {
  const tmpRoot = makeTempDir();
  try {
    const plainPath = path.join(tmpRoot, 'plain.prproj');
    const gzipPath = path.join(tmpRoot, 'gzip.prproj');
    fs.writeFileSync(plainPath, 'plain');
    fs.writeFileSync(gzipPath, Buffer.from([0x1f, 0x8b, 0x00, 0x00, 0x00]));
    const selectSmallBudget = header => header[0] === 0x1f && header[1] === 0x8b ? 2 : 5;

    assert.equal(readFileWithinBudget(plainPath, selectSmallBudget, 'admission').toString(), 'plain');
    assert.throws(
      () => readFileWithinBudget(gzipPath, selectSmallBudget, 'admission'),
      error => isParserAdmissionError(error)
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('whole-file parser reads do not follow a source symlink', () => {
  const tmpRoot = makeTempDir();
  try {
    const targetPath = path.join(tmpRoot, 'target.ai');
    const linkedPath = path.join(tmpRoot, 'linked.ai');
    fs.writeFileSync(targetPath, 'private target contents');
    fs.symlinkSync(targetPath, linkedPath);

    assert.throws(
      () => new BaseParser().readFileBuffer(linkedPath),
      error => isParserAdmissionError(error)
        && !error.message.includes(targetPath)
        && !error.message.includes(tmpRoot)
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Illustrator reference scanning stops at the shared count budget', async () => {
  const tmpRoot = makeTempDir();
  try {
    const filePath = path.join(tmpRoot, 'reference-flood.ai');
    const references = Array.from(
      { length: ADMISSION_LIMITS.parserReferences + 1 },
      (_, index) => `/Users/crate-reference-flood/asset-${index}.png`
    );
    fs.writeFileSync(filePath, references.join('\n'));

    await assert.rejects(
      () => new AIParser().extractAssets(filePath),
      error => isParserAdmissionError(error)
        && !error.message.includes('crate-reference-flood')
        && !error.message.includes(tmpRoot)
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('normal raw-file parsers keep their linked-asset result shapes', async () => {
  const tmpRoot = makeTempDir();
  try {
    const fixtures = [
      {
        parser: new AIParser(),
        filePath: path.join(tmpRoot, 'project.ai'),
        content: '/Users/crate-parser-normal/image.png',
        expected: { path: '/Users/crate-parser-normal/image.png', source: 'ai-regex', exists: false },
      },
      {
        parser: new PSDParser(),
        filePath: path.join(tmpRoot, 'project.psd'),
        content: '/Users/crate-parser-normal/image.png',
        expected: { path: '/Users/crate-parser-normal/image.png', source: 'psd-regex', exists: false },
      },
      {
        parser: new AfterEffectsParser(),
        filePath: path.join(tmpRoot, 'project.aep'),
        content: '/Users/crate-parser-normal/clip.mov',
        expected: { path: '/Users/crate-parser-normal/clip.mov', source: 'aep-regex', exists: false },
      },
      {
        parser: new InDesignParser(),
        filePath: path.join(tmpRoot, 'project.indd'),
        content: '/Users/crate-parser-normal/image.png',
        expected: { path: '/Users/crate-parser-normal/image.png', source: 'indd-regex', exists: false },
      },
    ];

    for (const fixture of fixtures) {
      fs.writeFileSync(fixture.filePath, fixture.content);
      assert.deepEqual(await fixture.parser.extractAssets(fixture.filePath), [fixture.expected]);
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Photoshop and After Effects do not swallow whole-file admission failures', async () => {
  const tmpRoot = makeTempDir();
  try {
    const psdPath = path.join(tmpRoot, 'oversized.psd');
    const aepPath = path.join(tmpRoot, 'oversized.aep');
    fs.closeSync(fs.openSync(psdPath, 'w'));
    fs.closeSync(fs.openSync(aepPath, 'w'));
    fs.truncateSync(psdPath, ADMISSION_LIMITS.localParserFileBytes + 1);
    fs.truncateSync(aepPath, ADMISSION_LIMITS.localParserFileBytes + 1);

    await assert.rejects(
      () => new PSDParser().extractAssets(psdPath),
      error => isParserAdmissionError(error)
    );
    await assert.rejects(
      () => new AfterEffectsParser().extractAssets(aepPath),
      error => isParserAdmissionError(error)
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('archive entry budgets reject excessive count, single size, and aggregate size', () => {
  const entries = [
    { path: 'one.xml', size: 6 },
    { path: 'two.xml', size: 6 },
  ];
  const message = 'Archive admission failed safely.';

  assert.throws(
    () => assertEntriesWithinBudget(entries, { maxEntries: 1, maxEntryBytes: 20, maxTotalBytes: 20, message }),
    error => isParserAdmissionError(error) && error.message === message
  );
  assert.throws(
    () => assertEntriesWithinBudget(entries, { maxEntries: 2, maxEntryBytes: 5, maxTotalBytes: 20, message }),
    error => isParserAdmissionError(error) && error.message === message
  );
  assert.throws(
    () => assertEntriesWithinBudget(entries, { maxEntries: 2, maxEntryBytes: 20, maxTotalBytes: 10, message }),
    error => isParserAdmissionError(error) && error.message === message
  );
});

test('Premiere decompression rejects expansion beyond its output budget', () => {
  const compressed = zlib.gzipSync(Buffer.alloc(4096, 65));

  assert.throws(
    () => decompressGzipWithinBudget(compressed, 1024, 'Premiere admission failed safely.'),
    error => isParserAdmissionError(error)
      && error.message === 'Premiere admission failed safely.'
      && error.code === 'CRATE_PARSER_ADMISSION_LIMIT'
  );
});

test('normal compressed Premiere projects keep their linked-media result shape', async () => {
  const tmpRoot = makeTempDir();
  try {
    const mediaPath = path.join(tmpRoot, 'clip.mov');
    const projectPath = path.join(tmpRoot, 'project.prproj');
    fs.writeFileSync(mediaPath, 'media');
    fs.writeFileSync(
      projectPath,
      zlib.gzipSync(Buffer.from(`<ActualMediaFilePath>${mediaPath}</ActualMediaFilePath>`))
    );

    assert.deepEqual(await new PremiereParser().extractAssets(projectPath), [{
      path: mediaPath,
      source: 'prproj-mediapath',
      exists: true,
    }]);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('PowerPoint rejects oversized declared media before extracting archive data', async () => {
  const tmpRoot = makeTempDir();
  unzipExtractCalls = 0;
  try {
    const archivePath = path.join(tmpRoot, 'private-project-name.pptx');
    fs.writeFileSync(archivePath, 'small archive fixture');
    unzipListing = [
      'Archive: private-project-name.pptx',
      `${String(ADMISSION_LIMITS.presentationMediaEntryBytes + 1).padStart(9)}  01-01-2026 12:00  ppt/media/video.mov`,
      '',
    ].join('\n');

    await assert.rejects(
      () => new PowerPointParser().extractAssets(archivePath),
      error => isParserAdmissionError(error)
        && error.message === 'This presentation contains too much embedded media for Crate to inspect safely.'
        && !error.message.includes(tmpRoot)
        && !error.message.includes('private-project-name')
    );
    assert.equal(unzipExtractCalls, 0);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('PowerPoint archive listing timeout becomes one admission failure', async () => {
  const tmpRoot = makeTempDir();
  try {
    const archivePath = path.join(tmpRoot, 'private-project-name.pptx');
    const timeout = new Error(`private timeout ${tmpRoot}`);
    timeout.code = null;
    timeout.killed = true;
    timeout.signal = 'SIGTERM';
    fs.writeFileSync(archivePath, 'small archive fixture');
    unzipListingError = timeout;

    await assert.rejects(
      () => new PowerPointParser().extractAssets(archivePath),
      error => isParserAdmissionError(error)
        && !error.message.includes('private timeout')
        && !error.message.includes(tmpRoot)
    );
  } finally {
    unzipListingError = null;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('package orchestration preserves the admission error and writes no package files', async () => {
  const tmpRoot = makeTempDir();
  unzipExtractCalls = 0;
  try {
    const archivePath = path.join(tmpRoot, 'private-project-name.pptx');
    const outputDir = path.join(tmpRoot, 'out');
    fs.writeFileSync(archivePath, 'small archive fixture');
    unzipListing = [
      'Archive: private-project-name.pptx',
      `${String(ADMISSION_LIMITS.presentationMediaEntryBytes + 1).padStart(9)}  01-01-2026 12:00  ppt/media/video.mov`,
      '',
    ].join('\n');

    await assert.rejects(
      () => packageMasterFile(archivePath, outputDir),
      error => isParserAdmissionError(error)
    );
    assert.equal(unzipExtractCalls, 0);
    assert.deepEqual(fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : [], []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('direct presentation extraction still accepts zipPath-only asset metadata', async () => {
  const tmpRoot = makeTempDir();
  unzipExtractCalls = 0;
  unzipExtractData = new Map();
  try {
    const archivePath = path.join(tmpRoot, 'project.pptx');
    const outputDir = path.join(tmpRoot, 'out');
    const zipPath = 'ppt/media/image.png';
    fs.writeFileSync(archivePath, 'small archive fixture');
    unzipExtractData.set(zipPath, Buffer.alloc(600, 65));

    const extracted = await new PowerPointParser().extractToDirectory(
      archivePath,
      outputDir,
      [{ zipPath }]
    );

    assert.equal(extracted.length, 1);
    assert.equal(fs.statSync(extracted[0].extractedPath).size, 600);
    assert.equal(unzipExtractCalls, 1);
  } finally {
    unzipExtractData = new Map();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('presentation extraction converts child output overflow into an admission failure', async () => {
  const tmpRoot = makeTempDir();
  unzipExtractCalls = 0;
  unzipExtractErrors = new Map();
  try {
    const archivePath = path.join(tmpRoot, 'project.pptx');
    const outputDir = path.join(tmpRoot, 'out');
    const firstZipPath = 'ppt/media/image.png';
    const secondZipPath = 'ppt/media/video.mov';
    const overflow = new Error('private child process output');
    overflow.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    fs.writeFileSync(archivePath, 'small archive fixture');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(path.join(outputDir, 'keep.txt'), 'pre-existing');
    unzipExtractData.set(firstZipPath, Buffer.alloc(600, 65));
    unzipExtractErrors.set(secondZipPath, overflow);

    await assert.rejects(
      () => new PowerPointParser().extractToDirectory(
        archivePath,
        outputDir,
        [
          { zipPath: firstZipPath, size: 600 },
          { zipPath: secondZipPath, size: 600 },
        ]
      ),
      error => isParserAdmissionError(error)
        && !error.message.includes('private child process output')
        && !error.message.includes(tmpRoot)
    );
    assert.equal(unzipExtractCalls, 2);
    assert.deepEqual(fs.readdirSync(outputDir), ['keep.txt']);
    assert.equal(fs.readFileSync(path.join(outputDir, 'keep.txt'), 'utf8'), 'pre-existing');
  } finally {
    unzipExtractData = new Map();
    unzipExtractErrors = new Map();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('package orchestration cleans copied files after a late admission failure', async () => {
  const tmpRoot = makeTempDir();
  unzipExtractCalls = 0;
  unzipExtractData = new Map();
  unzipExtractErrors = new Map();
  try {
    const archivePath = path.join(tmpRoot, 'project.pptx');
    const outputDir = path.join(tmpRoot, 'out');
    const firstZipPath = 'ppt/media/image.png';
    const secondZipPath = 'ppt/media/video.mov';
    const overflow = new Error('private child process output');
    overflow.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    fs.writeFileSync(archivePath, 'small archive fixture');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(path.join(outputDir, 'keep.txt'), 'pre-existing');
    unzipListing = [
      'Archive: project.pptx',
      `${String(600).padStart(9)}  01-01-2026 12:00  ${firstZipPath}`,
      `${String(600).padStart(9)}  01-01-2026 12:00  ${secondZipPath}`,
      '',
    ].join('\n');
    unzipExtractData.set(firstZipPath, Buffer.alloc(600, 65));
    unzipExtractErrors.set(secondZipPath, overflow);

    await assert.rejects(
      () => packageMasterFile(archivePath, outputDir),
      error => isParserAdmissionError(error)
    );
    assert.equal(unzipExtractCalls, 2);
    assert.deepEqual(fs.readdirSync(outputDir), ['keep.txt']);
    assert.equal(fs.readFileSync(path.join(outputDir, 'keep.txt'), 'utf8'), 'pre-existing');
  } finally {
    unzipExtractData = new Map();
    unzipExtractErrors = new Map();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('IDML rejects oversized declared XML before extracting archive data', async () => {
  const tmpRoot = makeTempDir();
  unzipExtractCalls = 0;
  try {
    const archivePath = path.join(tmpRoot, 'private-project-name.idml');
    fs.writeFileSync(archivePath, 'small archive fixture');
    unzipListing = [
      'Archive: private-project-name.idml',
      `${String(ADMISSION_LIMITS.idmlXmlEntryBytes + 1).padStart(9)}  01-01-2026 12:00  Resources/Links.xml`,
      '',
    ].join('\n');

    await assert.rejects(
      () => new InDesignParser().extractAssets(archivePath),
      error => isParserAdmissionError(error)
        && error.message === 'This InDesign file contains too much document data for Crate to inspect safely.'
        && !error.message.includes(tmpRoot)
        && !error.message.includes('private-project-name')
    );
    assert.equal(unzipExtractCalls, 0);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('IDML listing overflow becomes a privacy-safe admission failure', async () => {
  const tmpRoot = makeTempDir();
  try {
    const archivePath = path.join(tmpRoot, 'private-project-name.idml');
    const overflow = new Error(`private child output ${tmpRoot}`);
    overflow.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    fs.writeFileSync(archivePath, 'small archive fixture');
    unzipListingError = overflow;

    await assert.rejects(
      () => new InDesignParser().extractAssets(archivePath),
      error => isParserAdmissionError(error)
        && !error.message.includes('private child output')
        && !error.message.includes(tmpRoot)
    );
  } finally {
    unzipListingError = null;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('IDML entry timeout aborts the archive instead of continuing', async () => {
  const tmpRoot = makeTempDir();
  unzipExtractCalls = 0;
  unzipExtractData = new Map();
  unzipExtractErrors = new Map();
  try {
    const archivePath = path.join(tmpRoot, 'private-project-name.idml');
    const firstXmlPath = 'Resources/First.xml';
    const secondXmlPath = 'Resources/Second.xml';
    const timeout = new Error(`private timeout ${tmpRoot}`);
    timeout.code = null;
    timeout.killed = true;
    timeout.signal = 'SIGTERM';
    fs.writeFileSync(archivePath, 'small archive fixture');
    unzipListing = [
      'Archive: private-project-name.idml',
      `${String(600).padStart(9)}  01-01-2026 12:00  ${firstXmlPath}`,
      `${String(600).padStart(9)}  01-01-2026 12:00  ${secondXmlPath}`,
      '',
    ].join('\n');
    unzipExtractErrors.set(firstXmlPath, timeout);
    unzipExtractData.set(secondXmlPath, '<Link/>');

    await assert.rejects(
      () => new InDesignParser().extractAssets(archivePath),
      error => isParserAdmissionError(error)
        && !error.message.includes('private timeout')
        && !error.message.includes(tmpRoot)
    );
    assert.equal(unzipExtractCalls, 1);
  } finally {
    unzipExtractData = new Map();
    unzipExtractErrors = new Map();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('normal IDML archives keep their linked-asset result shape', async () => {
  const tmpRoot = makeTempDir();
  unzipExtractCalls = 0;
  unzipExtractData = new Map();
  try {
    const linkedPath = path.join(tmpRoot, 'linked image.png');
    const archivePath = path.join(tmpRoot, 'project.idml');
    const xmlPath = 'Resources/Links.xml';
    const xmlContent = `<Link LinkResourceURI="file://${encodeURI(linkedPath)}"/>`;
    fs.writeFileSync(linkedPath, 'image');
    fs.writeFileSync(archivePath, 'small archive fixture');
    unzipListing = [
      'Archive: project.idml',
      `${String(Buffer.byteLength(xmlContent)).padStart(9)}  01-01-2026 12:00  ${xmlPath}`,
      '',
    ].join('\n');
    unzipExtractData.set(xmlPath, xmlContent);

    assert.deepEqual(await new InDesignParser().extractAssets(archivePath), [{
      path: linkedPath,
      source: 'idml-link',
      exists: true,
    }]);
    assert.equal(unzipExtractCalls, 1);
  } finally {
    unzipExtractData = new Map();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
