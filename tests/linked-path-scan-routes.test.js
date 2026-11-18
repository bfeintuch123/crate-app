'use strict';
// The complete production routes against the real IPC/store harness, generated
// binary files and modeled ps/lsof. Each case asserts the resulting rows first
// and the absence of a large text decode last. Nothing here measures time.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), assert = require('./bounded-assert');
const entry = path.join(__dirname, 'provenance-dual-write.test.js');
let source = fs.readFileSync(entry, 'utf8');
function replaceOnce(before, after) { assert.equal(source.split(before).length, 2, 'harness anchor drift'); source = source.replace(before, () => after); }
replaceOnce("const test = require('node:test');", "const routeTest = require('node:test'); const test = new Proxy(routeTest, { apply() {} });");
replaceOnce("fs.mkdtempSync(path.join(os.tmpdir(), 'crate-provenance-dual-write-home-'))", "fs.mkdtempSync(path.join(os.tmpdir(), 'crate-linked-scan-home-'))");
source += '\n(' + cases.toString() + ')();\n';
const compiled = new Module(entry, module); compiled.filename = entry; compiled.paths = Module._nodeModulePaths(path.dirname(entry)); compiled._compile(source, entry);

function cases() {
  const MB = 1024 * 1024, LARGE_DECODE_BYTES = 8 * MB, FILE_BYTES = 16 * MB;
  const realToString = Buffer.prototype.toString;
  const realReadFile = fs.promises.readFile, realReadFileSync = fs.readFileSync;
  const homes = [];
  routeTest.after(() => { for (const home of homes) fs.rmSync(home, { recursive: true, force: true }); });

  // Seeded noise, so every run scans the same bytes.
  function noise(byteLength, seed) {
    const words = new Uint32Array(Math.ceil(byteLength / 4));
    let state = seed >>> 0;
    for (let i = 0; i < words.length; i++) {
      state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0;
      words[i] = state;
    }
    return Buffer.from(words.buffer, 0, byteLength);
  }

  // Links sit between NUL bytes, spread through the file, the last at its end.
  // An .ai file also needs the header and trailer the first-scan route requires.
  function writeBinary(filePath, links, seed) {
    const body = noise(FILE_BYTES, seed);
    const isAi = path.extname(filePath) === '.ai';
    const header = Buffer.from(isAi ? '%PDF-1.7\n' : '8BPS'), trailer = Buffer.from(isAi ? '\n%%EOF\n' : '');
    header.copy(body);
    trailer.copy(body, body.length - trailer.length);
    const plants = links.map(link => Buffer.from(`\0${link}\0`));
    plants.forEach((plant, index) => {
      const offset = index === plants.length - 1 ? body.length - trailer.length - plant.length
        : Math.floor((index + 1) * body.length / (plants.length + 1));
      plant.copy(body, offset);
    });
    fs.writeFileSync(filePath, body);
  }

  // /Users/ links must resolve on disk, so they live in the real home directory.
  function createLinks(names) {
    const home = fs.mkdtempSync(path.join(originalHomedir(), 'crate-linked-scan-test-'));
    assert.ok(home.startsWith('/Users/'), 'the guarded suite runs on macOS');
    homes.push(home);
    return names.map(name => { const file = path.join(home, name); fs.writeFileSync(file, 'synthetic linked asset'); return file; });
  }

  async function fixture(ext = '.ai', { firstScan = false, seed = 0x2f91c3a7 } = {}) {
    resetTestHomeWorkspace(); storeInstance.set('quickPackageOutputPaths', []); setChildProcessHandler(() => ({ stdout: '' }));
    const project = await createProject(`Linked scan ${ext}`);
    await callIpcRaw('projects:pause', project.id); clearTrackedTimers();
    const sourcePath = path.join(TEST_HOME, 'Desktop', `Synthetic Layout${ext}`);
    // Retouch.png does not exist, so only a greedy search reaches this file: the
    // lazy matcher stops at the first extension. The two greedy sites own this row.
    const [first, second, third, greedyOnly] = createLinks(['Alpha.png', 'Bêta 😀.jpg', 'Gamma.woff2', 'Retouch.png-retouched.jpg']);
    const missing = path.join(path.dirname(first), 'Missing.png');
    writeBinary(sourcePath, [first, missing, greedyOnly, second, third], seed);
    await setProjectFiles(project.id, { files: [{ path: sourcePath, ext, name: path.basename(sourcePath), source: 'manual-browse', addedAt: Date.now() }], preserveAwaitingAssetBaseline: firstScan });
    return { id: project.id, sourcePath, lazyLinks: [first, second, third].sort(), links: [first, second, third, greedyOnly].sort(), missing };
  }

  const storedProject = id => storeInstance.data.projects.find(item => item.id === id);
  // Every row other than the design file itself, wherever the scan placed it.
  const linkedRows = f => {
    const project = storedProject(f.id);
    return [...project.files, ...(project.pendingFiles || [])].map(file => file.path).filter(file => file !== f.sourcePath).sort();
  };

  // Records each text decode of 8 MB or more, whichever way it is asked for.
  async function watchLargeDecodes(run) {
    const large = [];
    Buffer.prototype.toString = function (...args) {
      const span = Math.min(args[2] ?? this.length, this.length) - (args[1] ?? 0);
      if (this.length >= LARGE_DECODE_BYTES || span >= LARGE_DECODE_BYTES) {
        large.push({ bufferBytes: this.length, encoding: args[0], where: new Error().stack.split('\n').slice(2, 4).map(line => line.trim()).join(' < ') });
      }
      return realToString.apply(this, args);
    };
    try { return { result: await run(), large }; } finally { Buffer.prototype.toString = realToString; }
  }

  function modelDesignAppWith(openPath) {
    setChildProcessHandler(({ kind, command }) => {
      if (kind === 'execFile' && command === '/bin/ps') return { stdout: '444 /Applications/Adobe Illustrator.app/Contents/MacOS/Adobe Illustrator\n' };
      if (kind === 'execFile' && command === '/usr/sbin/lsof') return { stdout: `p444\nf14\ntREG\nn${openPath}\n` };
      return { stdout: '' };
    });
  }

  async function startWatchingAndStop(id) {
    const started = await callIpcRaw('projects:start-watching', id);
    await callIpcRaw('projects:pause', id); clearTrackedTimers();
    return started;
  }

  for (const ext of ['.ai', '.psd']) {
    routeTest(`pre-package scan of a large ${ext} finds its links without decoding the file`, { timeout: 120000 }, async () => {
      const f = await fixture(ext);
      const { result, large } = await watchLargeDecodes(() => callIpcRaw('projects:pre-package-scan', f.id));
      assert.equal(result?.error, undefined);
      assert.deepEqual(linkedRows(f), f.links);
      assert.deepEqual(large, []);
    });
  }

  routeTest('scan-on-open of a large .ai finds its links without decoding the file', { timeout: 120000 }, async () => {
    // A paused project publishes scan-on-open rows only for its first scan.
    const f = await fixture('.ai', { firstScan: true });
    const { result, large } = await watchLargeDecodes(() => metadataTestHooks.runScanOnOpen(f.id, f.sourcePath, null, null, { allowPausedBaseline: true }));
    assert.deepEqual(result, { success: true });
    assert.deepEqual(linkedRows(f), f.lazyLinks);
    assert.deepEqual(large, []);
  });

  routeTest('Watch start on a large open .ai finds its links without decoding the file', { timeout: 120000 }, async () => {
    const f = await fixture();
    modelDesignAppWith(f.sourcePath);
    const { large } = await watchLargeDecodes(() => startWatchingAndStop(f.id));
    assert.deepEqual(linkedRows(f), f.links);
    assert.deepEqual(large, []);
  });

  // One design file cannot be read or decoded; the scan continues with the next.
  async function twoSourceFixture() {
    const f = await fixture('.ai');
    const brokenPath = path.join(TEST_HOME, 'Desktop', 'Unreadable Layout.ai');
    fs.writeFileSync(brokenPath, 'synthetic');
    const project = storedProject(f.id);
    project.files = [{ path: brokenPath, ext: '.ai', name: path.basename(brokenPath), source: 'manual-browse', addedAt: Date.now() }, ...project.files];
    return { ...f, brokenPath, isSource: file => file === f.sourcePath || file === brokenPath };
  }
  const rowsBesideSources = f => {
    const project = storedProject(f.id);
    return [...project.files, ...(project.pendingFiles || [])].map(file => file.path).filter(file => !f.isSource(file)).sort();
  };
  // A Buffer in type only, over the string limit, whose old decode is observable.
  function oversizedBuffer(decode) {
    const fake = Object.setPrototypeOf(new Uint8Array(0), Buffer.prototype);
    Object.defineProperty(fake, 'length', { value: require('node:buffer').constants.MAX_STRING_LENGTH + 1 });
    fake.toString = decode;
    return fake;
  }

  for (const [label, failRead, expectDecode] of [
    ['a read error', () => { throw Object.assign(new Error('synthetic read failure'), { code: 'EIO' }); }, false],
    ['an over-limit decode error', state => oversizedBuffer(() => {
      state.decodes++;
      throw Object.assign(new Error('synthetic string limit'), { code: 'ERR_STRING_TOO_LONG' });
    }), true],
  ]) {
    routeTest(`pre-package scan: ${label} on one file leaves the other file's links intact`, { timeout: 120000 }, async () => {
      const f = await twoSourceFixture();
      let attempts = 0;
      const state = { decodes: 0 };
      fs.promises.readFile = async function (file, ...args) {
        if (file === f.brokenPath) { attempts++; return failRead(state); }
        return realReadFile.call(this, file, ...args);
      };
      try {
        const result = await callIpcRaw('projects:pre-package-scan', f.id);
        assert.equal(result?.error, undefined);
      } finally { fs.promises.readFile = realReadFile; }
      assert.ok(attempts > 0);
      assert.equal(state.decodes > 0, expectDecode);
      assert.deepEqual(rowsBesideSources(f), f.links);
    });

    routeTest(`Watch start: ${label} on one file leaves the other file's links intact`, { timeout: 120000 }, async () => {
      const f = await twoSourceFixture();
      setChildProcessHandler(({ kind, command }) => {
        if (kind === 'execFile' && command === '/bin/ps') return { stdout: '444 /Applications/Adobe Illustrator.app/Contents/MacOS/Adobe Illustrator\n' };
        if (kind === 'execFile' && command === '/usr/sbin/lsof') return { stdout: `p444\nf14\ntREG\nn${f.brokenPath}\nf15\ntREG\nn${f.sourcePath}\n` };
        return { stdout: '' };
      });
      let attempts = 0;
      const state = { decodes: 0 };
      fs.readFileSync = function (file, ...args) {
        if (file === f.brokenPath) { attempts++; return failRead(state); }
        return realReadFileSync.call(this, file, ...args);
      };
      try { await startWatchingAndStop(f.id); } finally { fs.readFileSync = realReadFileSync; }
      assert.ok(attempts > 0);
      assert.equal(state.decodes > 0, expectDecode);
      assert.deepEqual(rowsBesideSources(f), f.links);
    });
  }

  // The old decode's text is what these sites search when a buffer is over the limit.
  for (const [label, run, installRead] of [
    ['pre-package scan', f => callIpcRaw('projects:pre-package-scan', f.id), (f, read) => {
      fs.promises.readFile = async function (file, ...args) { return file === f.brokenPath ? read() : realReadFile.call(this, file, ...args); };
    }],
    ['Watch start', f => {
      setChildProcessHandler(({ kind, command }) => {
        if (kind === 'execFile' && command === '/bin/ps') return { stdout: '444 /Applications/Adobe Illustrator.app/Contents/MacOS/Adobe Illustrator\n' };
        if (kind === 'execFile' && command === '/usr/sbin/lsof') return { stdout: `p444\nf14\ntREG\nn${f.brokenPath}\n` };
        return { stdout: '' };
      });
      return startWatchingAndStop(f.id);
    }, (f, read) => {
      fs.readFileSync = function (file, ...args) { return file === f.brokenPath ? read() : realReadFileSync.call(this, file, ...args); };
    }],
  ]) {
    routeTest(`${label}: links in an over-limit file's successful decode are still found`, { timeout: 120000 }, async () => {
      const f = await twoSourceFixture();
      const [decodedLink] = createLinks(['Only In Oversized Decode.png']);
      installRead(f, () => oversizedBuffer(() => `\0${decodedLink}\0`));
      try { await run(f); } finally { fs.promises.readFile = realReadFile; fs.readFileSync = realReadFileSync; }
      assert.ok(rowsBesideSources(f).includes(decodedLink));
    });
  }
}
