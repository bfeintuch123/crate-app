const test = require('node:test');
const assert = require('./bounded-assert');
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
  // These legacy archive fixtures mock unzip with non-ZIP placeholder bytes.
  // Real ZIP fixtures always exercise the production relationship inspector.
  if (request === './ooxml-links') {
    const actual = originalLoad.call(this, request, parent, ...rest);
    return { ...actual, inspectLinks(buffer, ...args) {
      return buffer.subarray(0, 2).toString() === 'PK' ? actual.inspectLinks(buffer, ...args) : [];
    } };
  }
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

function admitSyntheticFixturePaths(parser, allowedPaths) {
  const allowed = new Set(allowedPaths.map(filePath => path.resolve(filePath)));
  parser.isUserPath = filePath => allowed.has(path.resolve(filePath));
  return parser;
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
        content: require('ag-psd').writePsdBuffer({ width: 1, height: 1, linkedFiles: [{ id: '11111111-1111-4111-8111-111111111111', name: 'image.png', childDocumentID: '', linkedFile: { fullPath: '/Users/crate-parser-normal/image.png', originalPath: '/Users/crate-parser-normal/image.png', relativePath: '', name: 'image.png', fileSize: 1 } }] }),
        expected: { path: '/Users/crate-parser-normal/image.png', source: 'psd-smartobject', exists: false },
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
    const unrelatedPath = path.join(tmpRoot, 'unrelated.mov');
    const projectPath = path.join(tmpRoot, 'project.prproj');
    fs.writeFileSync(mediaPath, 'media');
    fs.writeFileSync(
      projectPath,
      zlib.gzipSync(Buffer.from(`<ActualMediaFilePath>${mediaPath}</ActualMediaFilePath>`))
    );
    const parser = admitSyntheticFixturePaths(new PremiereParser(), [mediaPath]);

    assert.equal(new PremiereParser().isUserPath('/private/crate-user-asset.mov'), false);
    assert.equal(parser.isUserPath(mediaPath), true);
    assert.equal(parser.isUserPath(unrelatedPath), false);
    assert.deepEqual(await parser.extractAssets(projectPath), [{
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
    unzipListing = [
      'Archive: project.pptx',
      `${String(600).padStart(9)}  01-01-2026 12:00  ${zipPath}`,
      '',
    ].join('\n');
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
    unzipListing = '';
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
    unzipListing = [
      'Archive: project.pptx',
      `${String(600).padStart(9)}  01-01-2026 12:00  ${firstZipPath}`,
      `${String(600).padStart(9)}  01-01-2026 12:00  ${secondZipPath}`,
      '',
    ].join('\n');
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
    unzipListing = '';
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
    const unrelatedPath = path.join(tmpRoot, 'unrelated image.png');
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
    const parser = admitSyntheticFixturePaths(new InDesignParser(), [linkedPath]);

    assert.equal(new InDesignParser().isUserPath('/private/crate-user-asset.png'), false);
    assert.equal(parser.isUserPath(linkedPath), true);
    assert.equal(parser.isUserPath(unrelatedPath), false);
    assert.deepEqual(await parser.extractAssets(archivePath), [{
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

test('Illustrator Quick Package enforces raw repeat count & byte budgets during scanning without double-counting XMP duplicates (A2)', async () => {
  const { nativeHelper } = require('../parsers/native-helper');
  const tmpRoot = makeTempDir();
  try {
    // 1. Exact base parity at the 10,000 raw-occurrence boundary (even for a single repeated path)
    const atLimitPath = path.join(tmpRoot, 'repeat-at-limit.ai');
    const repeatedTarget = '/Users/crate-repeat-parity/logo.png';
    fs.writeFileSync(
      atLimitPath,
      Array.from({ length: ADMISSION_LIMITS.parserReferences }, () => repeatedTarget).join('\n')
    );
    const atLimitAssets = await new AIParser().extractAssets(atLimitPath);
    assert.deepEqual(atLimitAssets, [{ path: repeatedTarget, source: 'ai-regex', exists: false }]);

    // 2. 10,001 repeated raw occurrences MUST reject with CRATE_PARSER_ADMISSION_LIMIT
    const overLimitPath = path.join(tmpRoot, 'repeat-over-limit.ai');
    fs.writeFileSync(
      overLimitPath,
      Array.from({ length: ADMISSION_LIMITS.parserReferences + 1 }, () => repeatedTarget).join('\n')
    );
    await assert.rejects(
      () => new AIParser().extractAssets(overLimitPath),
      error => isParserAdmissionError(error)
        && !error.message.includes('crate-repeat-parity')
        && !error.message.includes(tmpRoot)
    );

    // 3. Repeated long paths exceeding parserReferenceBytes (16 MiB) under 10,000 count MUST reject
    const overBytesPath = path.join(tmpRoot, 'repeat-over-bytes.ai');
    const longRepeatedTarget = `/Users/crate-byte-flood/${'a'.repeat(3500)}.png`;
    const byteFloodCount = Math.floor(ADMISSION_LIMITS.parserReferenceBytes / Buffer.byteLength(longRepeatedTarget, 'utf8')) + 2;
    assert.ok(byteFloodCount < ADMISSION_LIMITS.parserReferences, 'byte flood must stay below count limit');
    fs.writeFileSync(
      overBytesPath,
      Array.from({ length: byteFloodCount }, () => longRepeatedTarget).join('\n')
    );
    await assert.rejects(
      () => new AIParser().extractAssets(overBytesPath),
      error => isParserAdmissionError(error)
        && !error.message.includes('crate-byte-flood')
        && !error.message.includes(tmpRoot)
    );

    // 4. 4,000 plain raw links mirrored in 4,000 <stRef:filePath> XMP tags = 8,000 raw matches
    //    (which base admits) + 4,000 XMP matches. Because XMP only charges unseen paths, total
    //    charged stays 8,000 (not 12,000) and the file stays admitted.
    const xmpParityPath = path.join(tmpRoot, 'xmp-parity.ai');
    const rawFourThousand = Array.from({ length: 4000 }, (_, i) => `/Users/crate-xmp-parity/a-${i}.png`);
    const xmpDupes = rawFourThousand.map(p => `<stRef:filePath>${p}</stRef:filePath>`);
    fs.writeFileSync(xmpParityPath, `${rawFourThousand.join('\n')}\n${xmpDupes.join('\n')}\n`);
    const xmpParityAssets = await new AIParser().extractAssets(xmpParityPath);
    assert.equal(xmpParityAssets.length, 4000);

    // 5. 6,000 raw links + 4,001 NEW unseen entity-encoded XMP links (hidden from raw scan via &#46;)
    //    => 6,000 raw + 4,001 unseen XMP = 10,001 charged -> MUST reject!
    const xmpOverPath = path.join(tmpRoot, 'xmp-over.ai');
    const rawSixThousand = Array.from({ length: 6000 }, (_, i) => `/Users/crate-xmp-parity/b-${i}.png`);
    const xmpNew = Array.from({ length: 4001 }, (_, i) => `<stRef:filePath>/Users/crate-xmp-parity/new-${i}&#46;png</stRef:filePath>`);
    fs.writeFileSync(xmpOverPath, `${rawSixThousand.join('\n')}\n${xmpNew.join('\n')}\n`);
    await assert.rejects(
      () => new AIParser().extractAssets(xmpOverPath),
      error => isParserAdmissionError(error)
    );

    // 6. Native helper typed `pdf_ai_reference_limit` MUST map directly to CRATE_PARSER_ADMISSION_LIMIT
    //    and NEVER fall back to the JS scanner (even when the underlying file on disk is tiny/valid).
    const tinyValidAi = path.join(tmpRoot, 'tiny-valid.ai');
    fs.writeFileSync(tinyValidAi, '/Users/crate-tiny/valid.png\n');
    const origIsAvailable = nativeHelper.isAvailable;
    const origParsePdfAi = nativeHelper.parsePdfAi;
    nativeHelper.isAvailable = () => true;
    nativeHelper.parsePdfAi = async () => {
      const err = new Error('pdf_ai_reference_limit');
      err.code = 'pdf_ai_reference_limit';
      throw err;
    };
    try {
      await assert.rejects(
        () => new AIParser().extractAssets(tinyValidAi),
        error => isParserAdmissionError(error)
      );
    } finally {
      nativeHelper.isAvailable = origIsAvailable;
      nativeHelper.parsePdfAi = origParsePdfAi;
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Quick Package AI & PSD pass maxFileBytes to native helpers and enforce descriptor-size errors without fallback (N1)', async () => {
  const { nativeHelper } = require('../parsers/native-helper');
  const agPsd = require('ag-psd');
  const tmpRoot = makeTempDir();
  const origIsAvailable = nativeHelper.isAvailable;
  const origParsePdfAi = nativeHelper.parsePdfAi;
  const origParsePsd = nativeHelper.parsePsd;
  try {
    const aiPath = path.join(tmpRoot, 'tiny.ai');
    fs.writeFileSync(aiPath, '/Users/crate-n1/ai-fallback.png\n');
    const psdPath = path.join(tmpRoot, 'tiny.psd');
    fs.writeFileSync(
      psdPath,
      agPsd.writePsdBuffer({
        width: 1,
        height: 1,
        linkedFiles: [{
          id: '55555555-5555-4555-8555-555555555555',
          name: 'psd-fallback.png',
          childDocumentID: '',
          linkedFile: {
            fullPath: '/Users/crate-n1/psd-fallback.png',
            originalPath: '/Users/crate-n1/psd-fallback.png',
            relativePath: '',
            name: 'psd-fallback.png',
            fileSize: 1,
          },
        }],
      })
    );

    nativeHelper.isAvailable = () => true;

    // 1. Both callers pass maxFileBytes === localParserFileBytes and map typed *_too_large to admissionError (no fallback)
    let seenAiOpts = null;
    nativeHelper.parsePdfAi = async (_file, opts) => {
      seenAiOpts = opts;
      const err = new Error('pdf_ai_too_large');
      err.code = 'pdf_ai_too_large';
      throw err;
    };
    await assert.rejects(
      () => new AIParser().extractAssets(aiPath),
      error => isParserAdmissionError(error)
    );
    assert.equal(seenAiOpts && seenAiOpts.maxFileBytes, ADMISSION_LIMITS.localParserFileBytes);

    let seenPsdOpts = null;
    nativeHelper.parsePsd = async (_file, opts) => {
      seenPsdOpts = opts;
      const err = new Error('psd_too_large');
      err.code = 'psd_too_large';
      throw err;
    };
    await assert.rejects(
      () => new PSDParser().extractAssets(psdPath),
      error => isParserAdmissionError(error)
    );
    assert.equal(seenPsdOpts && seenPsdOpts.maxFileBytes, ADMISSION_LIMITS.localParserFileBytes);

    // 2. Oversized sourceIdentity.size returned from helper rejects with admissionError (no fallback)
    nativeHelper.parsePdfAi = async () => ({
      paths: ['/Users/crate-n1/should-not-accept.png'],
      incomplete: false,
      issues: [],
      sourceIdentity: { size: ADMISSION_LIMITS.localParserFileBytes + 1 },
    });
    await assert.rejects(
      () => new AIParser().extractAssets(aiPath),
      error => isParserAdmissionError(error)
    );

    nativeHelper.parsePsd = async () => ({
      linkedPaths: ['/Users/crate-n1/should-not-accept.png'],
      mediaPaths: [],
      incomplete: false,
      issues: [],
      sourceIdentity: { size: ADMISSION_LIMITS.localParserFileBytes + 1 },
    });
    await assert.rejects(
      () => new PSDParser().extractAssets(psdPath),
      error => isParserAdmissionError(error)
    );

    // 3. Exact at-limit sourceIdentity.size is accepted
    nativeHelper.parsePdfAi = async () => ({
      paths: ['/Users/crate-n1/at-limit.png'],
      incomplete: false,
      issues: [],
      sourceIdentity: { size: ADMISSION_LIMITS.localParserFileBytes },
    });
    assert.deepEqual(await new AIParser().extractAssets(aiPath), [
      { path: '/Users/crate-n1/at-limit.png', source: 'ai-regex', exists: false },
    ]);

    nativeHelper.parsePsd = async () => ({
      linkedPaths: ['/Users/crate-n1/at-limit-psd.png'],
      mediaPaths: [],
      incomplete: false,
      issues: [],
      sourceIdentity: { size: ADMISSION_LIMITS.localParserFileBytes },
    });
    assert.deepEqual(await new PSDParser().extractAssets(psdPath), [
      { path: '/Users/crate-n1/at-limit-psd.png', source: 'psd-smartobject', exists: false },
    ]);

    // 4. Missing sourceIdentity falls back cleanly to descriptor-bound JS reader (not mislabeled as too large)
    nativeHelper.parsePdfAi = async () => ({
      paths: ['/Users/crate-n1/unverified.png'],
      incomplete: false,
      issues: [],
    });
    assert.deepEqual(await new AIParser().extractAssets(aiPath), [
      { path: '/Users/crate-n1/ai-fallback.png', source: 'ai-regex', exists: false },
    ]);

    nativeHelper.parsePsd = async () => ({
      linkedPaths: ['/Users/crate-n1/unverified.png'],
      mediaPaths: [],
      incomplete: false,
      issues: [],
    });
    assert.deepEqual(await new PSDParser().extractAssets(psdPath), [
      { path: '/Users/crate-n1/psd-fallback.png', source: 'psd-smartobject', exists: false },
    ]);
  } finally {
    nativeHelper.isAvailable = origIsAvailable;
    nativeHelper.parsePdfAi = origParsePdfAi;
    nativeHelper.parsePsd = origParsePsd;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
