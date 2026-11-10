'use strict';

// Cross-entry-point parity between watching link extraction (main.js) and
// Quick Package (parsers/). Watching functions are the unmodified main.js
// bodies evaluated in a VM context, as tests/fixtures/linked-asset-main.cjs
// does; Quick Package uses the real parser classes. Every fixture is
// synthetic, and every archive is built with the system zip tool.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFile, spawnSync } = require('node:child_process');
const { promisify } = require('node:util');
const { createRequire } = require('node:module');
const test = require('node:test');
const { mainExtractor } = require('./fixtures/linked-asset-main.cjs');
const { AIParser } = require('../parsers/ai');
const { InDesignParser } = require('../parsers/indesign');
const { PowerPointParser } = require('../parsers/powerpoint');
const { PSDParser } = require('../parsers/psd');
const { parsePsd, sendPsdRecords } = require('../parsers/add-files-psd-worker');

const root = path.resolve(__dirname, '..');
const mainFile = path.join(root, 'main.js');
const mainSource = fs.readFileSync(mainFile, 'utf8');
const S = '/Users/crate-synthetic-link-parity';

function topLevelFunction(name) {
  const marker = new RegExp(`^(?:async )?function ${name}\\(`, 'm');
  const found = marker.exec(mainSource);
  assert.ok(found, `main.js has no top-level ${name}`);
  const end = mainSource.indexOf('\n}\n', found.index);
  assert.ok(end > found.index);
  return mainSource.slice(found.index, end + 2);
}

function parserImports() {
  // The real top-level parser imports the evaluated bodies depend on.
  return mainSource.split('\n').filter(line =>
    /^const \{[^}]*\} = require\('\.\/parsers\/(?:linked-asset-matcher|xml-path|file-uri|ooxml-links)'\);$/.test(line));
}

function loadMain(names, extra = {}) {
  const context = vm.createContext({
    fs, path, Buffer, setImmediate, console: { warn() {}, error() {}, log() {} },
    require: createRequire(mainFile), execFileAsync: promisify(execFile),
    MAX_PARSE_FILE_SIZE: 300 * 1024 * 1024,
    runAddFilesRegexWorker: () => { throw new Error('unexpected-worker-call'); },
    ...extra,
  });
  vm.runInContext([...parserImports(), ...names.map(topLevelFunction)].join('\n'), context, { filename: mainFile });
  return context;
}

const watching = loadMain(['extractLinkedAssetsIdml', 'extractLinkedAssetsZipMedia', 'extractPsdAssets', 'isAddFilesSourceIdentityCurrent'], {
  extractLinkedAssetsRegex: async () => { throw new Error('unexpected-raw-zip-fallback'); },
});
const watchingRegex = mainExtractor(root);

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-link-parity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let archiveCount = 0;
function zipArchive(dir, ext, entries, { store = false } = {}) {
  const staging = path.join(dir, `staging-${++archiveCount}`);
  for (const [entry, contents] of Object.entries(entries)) {
    fs.mkdirSync(path.dirname(path.join(staging, entry)), { recursive: true });
    fs.writeFileSync(path.join(staging, entry), contents);
  }
  const file = path.join(dir, `Fixture-${archiveCount}${ext}`);
  const result = spawnSync('/usr/bin/zip', ['-q', '-X', ...(store ? ['-0'] : []), '-r', file, '.'], { cwd: staging });
  assert.equal(result.status, 0, String(result.stderr));
  return file;
}

function link(uri) { return `<Link Self="u1" LinkResourceURI="${uri}" StoredState="Normal"/>`; }
function spread(...body) {
  return `<?xml version="1.0" encoding="UTF-8"?><idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">${body.join('')}</idPkg:Spread>`;
}

async function runWatchingIdml(file, options) {
  const notes = [];
  const paths = await watching.extractLinkedAssetsIdml(file, { ...options, onUnresolvedDependency: reason => notes.push(reason) });
  return { paths: Array.from(paths), notes };
}

async function quick(ParserClass, file) {
  return Array.from(await new ParserClass().extractAssets(file), asset => ({ path: asset.path, exists: asset.exists }));
}

const sorted = values => [...new Set(values)].sort();
const MODES = { ordinary: {}, strict: { strict: true }, verify: { strict: true, ordinaryVerification: true } };

// IDML rows both stacks must agree on. `paths` is the declared-link set inside
// both stacks' policy; `notes` lists watching's unresolved notes in every mode.
const IDML_PARITY = [
  { id: 'single-slash', entries: { 'Spreads/Spread_1.xml': spread(link(`file:${S}/x.png`)) }, paths: [`${S}/x.png`] },
  { id: 'triple-slash', entries: { 'Spreads/Spread_1.xml': spread(link(`file://${S}/x.png`)) }, paths: [`${S}/x.png`] },
  { id: 'localhost', entries: { 'Spreads/Spread_1.xml': spread(link(`file://localhost${S}/x.png`)) }, paths: [`${S}/x.png`] },
  { id: 'single-slash-percent-space', entries: { 'Spreads/Spread_1.xml': spread(link(`file:${S}/My%20Folder/x.png`)) }, paths: [`${S}/My Folder/x.png`] },
  { id: 'triple-slash-percent-space', entries: { 'Spreads/Spread_1.xml': spread(link(`file://${S}/My%20Folder/x.png`)) }, paths: [`${S}/My Folder/x.png`] },
  { id: 'xml-entity-ampersand', entries: { 'Spreads/Spread_1.xml': spread(link(`file:${S}/R&amp;D/x.png`)) }, paths: [`${S}/R&D/x.png`] },
  { id: 'percent-ampersand', entries: { 'Spreads/Spread_1.xml': spread(link(`file:${S}/R%26D/x.png`)) }, paths: [`${S}/R&D/x.png`] },
  { id: 'woff2', entries: { 'Spreads/Spread_1.xml': spread(link(`file:${S}/Brand.woff2`)) }, paths: [`${S}/Brand.woff2`] },
  { id: 'malformed-percent', entries: { 'Spreads/Spread_1.xml': spread(link(`file:${S}/100%.png`)) }, paths: [`${S}/100%.png`] },
  { id: 'non-file-scheme', entries: { 'Spreads/Spread_1.xml': spread(link('https://example.invalid/x.png')) }, paths: [], notes: ['unsupported-declared-link-uri'] },
  { id: 'two-links-one-entry', entries: { 'Spreads/Spread_1.xml': spread(link(`file:${S}/a.png`), link(`file://${S}/b.tif`)) }, paths: [`${S}/a.png`, `${S}/b.tif`] },
  { id: 'same-link-two-entries', entries: {
    'Spreads/Spread_1.xml': spread(link(`file://${S}/a.png`)),
    'Resources/Graphic.xml': spread(link(`file:${S}/a.png`)),
  }, paths: [`${S}/a.png`] },
];

test('IDML declared links: both stacks agree in ordinary, strict and verification modes', async t => {
  const dir = tempDir(t);
  for (const row of IDML_PARITY) {
    const file = zipArchive(dir, '.idml', row.entries);
    const quickAssets = await quick(InDesignParser, file);
    assert.deepEqual(sorted(quickAssets.map(asset => asset.path)), sorted(row.paths), `${row.id}: Quick Package`);
    // Synthetic links do not exist; Quick Package still reports each one, missing.
    assert.ok(quickAssets.every(asset => asset.exists === false), `${row.id}: Quick Package existence`);
    for (const [mode, options] of Object.entries(MODES)) {
      const result = await runWatchingIdml(file, options);
      assert.deepEqual(sorted(result.paths), sorted(row.paths), `${row.id}: watching ${mode}`);
      assert.equal(result.paths.length, new Set(result.paths).size, `${row.id}: watching ${mode} de-duplicates`);
      assert.deepEqual(result.notes, row.notes || [], `${row.id}: watching ${mode} notes`);
    }
  }
});

test('IDML: a declared link to a missing file is still returned by watching strict mode and reported missing by Quick Package', async t => {
  const dir = tempDir(t);
  const besideCheckout = fs.mkdtempSync(path.join(path.dirname(root), 'crate-link-parity-present-'));
  t.after(() => fs.rmSync(besideCheckout, { recursive: true, force: true }));
  const present = path.join(besideCheckout, 'Present Image.png');
  const missing = path.join(besideCheckout, 'Missing Image.png');
  fs.writeFileSync(present, 'synthetic present asset');
  if (!/^\/(?:Users|Volumes)\//.test(present)) {
    t.skip('checkout is outside /Users or /Volumes, so watching policy would not admit this path');
    return;
  }
  const file = zipArchive(dir, '.idml', { 'Spreads/Spread_1.xml': spread(
    link(`file://${encodeURI(present)}`), link(`file:${encodeURI(missing)}`)) });
  assert.deepEqual(await quick(InDesignParser, file), [{ path: present, exists: true }, { path: missing, exists: false }]);
  for (const options of Object.values(MODES)) {
    assert.deepEqual(await runWatchingIdml(file, options), { paths: [present, missing], notes: [] });
  }
});

test('IDML: an accepted link outside /Users and /Volumes keeps the unresolved note and verification-only admission', async t => {
  const dir = tempDir(t);
  for (const uri of ['file:/opt/crate-synthetic/x.png', 'file:///opt/crate-synthetic/x.png', 'file://localhost/opt/crate-synthetic/x.png']) {
    const file = zipArchive(dir, '.idml', { 'Spreads/Spread_1.xml': spread(link(uri)) });
    assert.deepEqual(await runWatchingIdml(file, MODES.ordinary), { paths: [], notes: ['unsupported-declared-link-uri'] }, uri);
    assert.deepEqual(await runWatchingIdml(file, MODES.strict), { paths: [], notes: ['unsupported-declared-link-uri'] }, uri);
    assert.deepEqual(await runWatchingIdml(file, MODES.verify), { paths: ['/opt/crate-synthetic/x.png'], notes: ['unsupported-declared-link-uri'] }, uri);
  }
});

function writeAi(file, text) { fs.writeFileSync(file, `%PDF-1.7\n${text}\n%%EOF\n`); }
function writeRaw(file, text) { fs.writeFileSync(file, `synthetic saved bytes\n${text}\n`); }
function writePptx(dir, target) {
  return zipArchive(dir, '.pptx', {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'ppt/slides/_rels/slide1.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}" TargetMode="External"/></Relationships>`,
  });
}
function writeKey(dir, text) {
  // Stored, not deflated, so the reference is visible in the archive bytes.
  return zipArchive(dir, '.key', { 'Index/Metadata.iwa': `synthetic keynote metadata ${text} end` }, { store: true });
}
function writePsd(file, fullPath) {
  const { writePsdBuffer } = require('ag-psd');
  fs.writeFileSync(file, writePsdBuffer({ width: 1, height: 1, linkedFiles: [{
    id: '11111111-1111-4111-8111-111111111111', name: path.basename(fullPath), childDocumentID: '',
    linkedFile: { fileSize: 1, name: path.basename(fullPath), fullPath, originalPath: fullPath, relativePath: path.basename(fullPath) },
  }] }));
}

// Watching's Add Files PSD route: the production worker's linked-path records
// become the validated worker result that main's extractPsdAssets consumes.
async function watchingPsd(file) {
  const parsed = parsePsd(file);
  const entries = [];
  let current = null;
  await sendPsdRecords(parsed, async record => {
    if (record.type === 'record') current = record.kind === 'linked-path' ? '' : null;
    else if (record.type === 'text' && current !== null) current += record.text;
    else if (record.type === 'record-end' && current !== null) { entries.push({ filePath: current, source: 'psd-linked' }); current = null; }
  });
  const workerResult = { sourceIdentity: parsed.sourceIdentity, entries, transaction: { promote: () => [] } };
  return Array.from(await watching.extractPsdAssets(file, 'synthetic-project', () => true, { validatedPsdResult: workerResult }),
    entry => entry.filePath);
}

const WATCHING = {
  '.ai': file => watchingRegex(file, { strict: true }),
  '.indd': file => watchingRegex(file, { strict: true }), // saved-bytes route when InDesign is not queried
  '.ppt': file => watchingRegex(file, { strict: true }),
  '.pptx': file => watching.extractLinkedAssetsZipMedia(file, { strict: true }),
  '.key': file => watching.extractLinkedAssetsZipMedia(file, { strict: true }),
  '.psd': watchingPsd,
  '.idml': async file => (await runWatchingIdml(file, MODES.ordinary)).paths,
};
const QUICK = { '.ai': AIParser, '.indd': InDesignParser, '.ppt': PowerPointParser, '.pptx': PowerPointParser, '.key': PowerPointParser, '.psd': PSDParser, '.idml': InDesignParser };

function build(dir, ext, input) {
  if (ext === '.pptx') return writePptx(dir, input);
  if (ext === '.key') return writeKey(dir, input);
  if (ext === '.idml') return zipArchive(dir, '.idml', { 'Spreads/Spread_1.xml': input });
  const file = path.join(dir, `Source-${++archiveCount}${ext}`);
  if (ext === '.ai') writeAi(file, input);
  else if (ext === '.psd') writePsd(file, input);
  else writeRaw(file, input);
  return file;
}

async function both(dir, ext, input) {
  const file = build(dir, ext, input);
  const watchingPaths = Array.from(await WATCHING[ext](file));
  const quickPaths = (await quick(QUICK[ext], file)).map(asset => asset.path);
  return { watchingPaths, quickPaths };
}

test('other shared formats agree on a simple single link inside both stacks\' policy', async t => {
  const dir = tempDir(t);
  const besideCheckout = fs.mkdtempSync(path.join(path.dirname(root), 'crate-link-parity-psd-'));
  t.after(() => fs.rmSync(besideCheckout, { recursive: true, force: true }));
  const presentPsdLink = path.join(besideCheckout, 'Linked.png');
  fs.writeFileSync(presentPsdLink, 'synthetic linked asset');
  const rows = [
    ['.ai', `${S}/linked.png`, [`${S}/linked.png`]],
    ['.indd', `${S}/linked.tif`, [`${S}/linked.tif`]],
    ['.pptx', `file://${S}/linked.png`, [`${S}/linked.png`]],
    ['.psd', presentPsdLink, [presentPsdLink]],
  ];
  for (const [ext, input, expected] of rows) {
    const { watchingPaths, quickPaths } = await both(dir, ext, input);
    assert.deepEqual(watchingPaths, expected, `${ext}: watching`);
    assert.deepEqual(quickPaths, expected, `${ext}: Quick Package`);
  }
});

// Differences this PR deliberately leaves in place. Each row pins both stacks'
// current output so a change to either one fails here and must be reviewed.
const KNOWN_DIFFERENCES = [
  { id: 'ai-greedy-vs-lazy', ext: '.ai', input: `${S}/a.png ${S}/b.png`,
    watching: [`${S}/a.png`, `${S}/b.png`], quick: [`${S}/a.png ${S}/b.png`],
    reason: 'greedy versus lazy matching: Quick Package runs one greedy match across the space' },
  { id: 'ai-font-extension', ext: '.ai', input: `${S}/Brand.woff2`,
    watching: [`${S}/Brand.woff2`], quick: [],
    reason: 'different extension lists: Quick Package AI has no font or video extensions' },
  { id: 'ai-psb-extension', ext: '.ai', input: `${S}/Smart.psb`,
    watching: [], quick: [`${S}/Smart.psb`],
    reason: 'different extension lists: only Quick Package AI lists .psb' },
  { id: 'ai-volumes-root', ext: '.ai', input: '/Volumes/crate-synthetic/linked.png',
    watching: ['/Volumes/crate-synthetic/linked.png'], quick: [],
    reason: 'different roots: Quick Package AI matches /Users/ only' },
  { id: 'indd-greedy-vs-lazy', ext: '.indd', input: `${S}/a.png ${S}/b.png`,
    watching: [`${S}/a.png`, `${S}/b.png`], quick: [`${S}/a.png ${S}/b.png`],
    reason: 'greedy versus lazy matching in the binary InDesign scan' },
  { id: 'indd-volumes-root', ext: '.indd', input: '/Volumes/crate-synthetic/linked.png',
    watching: ['/Volumes/crate-synthetic/linked.png'], quick: [],
    reason: 'different roots: Quick Package INDD matches /Users/ only' },
  { id: 'ppt-quick-no-scan', ext: '.ppt', input: `${S}/linked.png`,
    watching: [`${S}/linked.png`], quick: [],
    reason: 'Quick Package returns no links for .ppt; watching scans its bytes' },
  { id: 'key-raw-pass', ext: '.key', input: `${S}/linked.png`,
    watching: [`${S}/linked.png`], quick: [],
    reason: 'extra raw pass: watching scans Keynote archive bytes; Quick Package reads embedded media only' },
  { id: 'psd-missing-linked-file', ext: '.psd', input: `${S}/Missing.png`,
    watching: [], quick: [`${S}/Missing.png`],
    reason: 'watching keeps a PSD linked path only if it exists; Quick Package reports it with exists: false' },
  { id: 'idml-raw-path-outside-attribute', ext: '.idml', input: spread(`<Content>${S}/raw.png</Content>`),
    watching: [`${S}/raw.png`], quick: [],
    reason: 'extra raw pass: watching also scans IDML XML text; Quick Package reads LinkResourceURI only' },
  { id: 'idml-raw-entity-path-outside-attribute', ext: '.idml', input: spread(`<Content>${S}/R&amp;D/raw.png</Content>`),
    watching: [`${S}/R&D/raw.png`], quick: [],
    reason: 'extra raw pass (entity-decoded): Quick Package reads LinkResourceURI only' },
  { id: 'idml-outside-roots', ext: '.idml', input: spread(link('file:///opt/crate-synthetic/x.png')),
    watching: [], quick: ['/opt/crate-synthetic/x.png'],
    reason: 'different roots: watching admits /Users/ and /Volumes/ (outside paths only under verification); Quick Package excludes only system prefixes' },
  { id: 'idml-other-host', ext: '.idml', input: spread(link(`file://server${S}/x.png`)),
    watching: [`${S}/x.png`], quick: [],
    reason: 'extra raw pass: both reject the host; watching\'s raw pass still reads the path text inside the rejected attribute' },
  { id: 'idml-extra-slashes', ext: '.idml', input: spread(link(`file:///${S}/x.png`)),
    watching: [`${S}/x.png`], quick: [`/${S}/x.png`],
    reason: 'neither accepts file://// as a declared link; Quick Package keeps its prior reading (two leading slashes), watching\'s raw pass reads the path text' },
];

test('KNOWN_DIFFERENCES: each listed difference still produces exactly its recorded outputs', async t => {
  const dir = tempDir(t);
  const ids = new Set();
  for (const row of KNOWN_DIFFERENCES) {
    assert.ok(!ids.has(row.id), row.id); ids.add(row.id);
    assert.ok(row.reason && row.reason.length > 10, row.id);
    const { watchingPaths, quickPaths } = await both(dir, row.ext, row.input);
    assert.deepEqual(watchingPaths, row.watching, `${row.id}: watching`);
    assert.deepEqual(quickPaths, row.quick, `${row.id}: Quick Package`);
    assert.notDeepEqual(sorted(row.watching), sorted(row.quick), `${row.id} is no longer a difference; remove it from the table`);
  }
});

test('IDML raw pass: matches inside an accepted declared link are dropped, others stay', async t => {
  const dir = tempDir(t);
  // A rejected attribute keeps its raw match exactly (undecoded), as before.
  const rejected = zipArchive(dir, '.idml', { 'Spreads/Spread_1.xml': spread(link(`file://server${S}/R&amp;D/x.png`)) });
  assert.deepEqual(await runWatchingIdml(rejected, MODES.ordinary),
    { paths: [`${S}/R&amp;D/x.png`], notes: ['unsupported-declared-link-uri'] });
  // An accepted link plus a raw path elsewhere: attribute result first, then raw.
  const mixed = zipArchive(dir, '.idml', { 'Spreads/Spread_1.xml': spread(
    `<Content>${S}/raw.png</Content>`, link(`file:${S}/My%20Folder/Brand.woff2`), `<Content>${S}/My%20Folder/Brand.woff2</Content>`) });
  assert.deepEqual(await runWatchingIdml(mixed, MODES.ordinary),
    { paths: [`${S}/My Folder/Brand.woff2`, `${S}/raw.png`, `${S}/My%20Folder/Brand.woff2`], notes: [] });
  // An accepted link outside the roots does not suppress raw matches inside it.
  const outside = zipArchive(dir, '.idml', { 'Spreads/Spread_1.xml': spread(link(`file:///opt${S}/x.png`)) });
  assert.deepEqual(await runWatchingIdml(outside, MODES.ordinary), { paths: [`${S}/x.png`], notes: ['unsupported-declared-link-uri'] });
  assert.deepEqual(await runWatchingIdml(outside, MODES.verify), { paths: [`/opt${S}/x.png`, `${S}/x.png`], notes: ['unsupported-declared-link-uri'] });
});
