'use strict';
// The linked-path scans search a small text built from candidate byte runs
// instead of the whole decoded design file. Every grammar those scans use must
// return exactly what it returns on `buffer.toString('utf8')`.

const test = require('node:test');
const assert = require('./bounded-assert');
const fs = require('node:fs');
const path = require('node:path');
const { constants } = require('node:buffer');
const { extractLinkedAssetPaths } = require('../parsers/linked-asset-matcher');
const { mainExtractor } = require('./fixtures/linked-asset-main.cjs');

const root = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const searchText = (buffer, ...rest) => extractLinkedAssetPaths.searchText(buffer, ...rest);

// The two greedy literals come from main.js, so these cases follow the code.
function literalAt(anchor) {
  const found = [...mainSource.matchAll(anchor)];
  assert.equal(found.length, 1, `main.js anchor drift: ${anchor}`);
  return found[0][1];
}
const PRE_PACKAGE_LITERAL = literalAt(/const LINKED_ASSET_REGEX = \/(.+)\/gi;\n\s*const LINKABLE_EXTENSIONS = /g);
const SNAPSHOT_LITERAL = literalAt(/const LINKED_ASSET_REGEX_SNAPSHOT = \/(.+)\/gi;/g);

function literalMatches(source, text) {
  const regex = new RegExp(source, 'gi'), found = [];
  let match;
  while ((match = regex.exec(text)) !== null) found.push(match[0]);
  return found;
}

const GRAMMARS = [
  ['shared matcher', text => extractLinkedAssetPaths(text, '/synthetic/not-in-any-input.ai')],
  ['shared matcher with self-exclusion', text => extractLinkedAssetPaths(text, '/Users/a/b.png')],
  ['pre-package literal', text => literalMatches(PRE_PACKAGE_LITERAL, text)],
  ['Watch snapshot literal', text => literalMatches(SNAPSHOT_LITERAL, text)],
];

const sameList = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const describe = buffer => `${buffer.length} bytes: ${buffer.subarray(0, 120).toString('hex')}`;

// Returns how many matches the whole-buffer decode produced, so each case can
// prove that it exercised something.
function checkSame(buffer, label) {
  const whole = buffer.toString('utf8');
  const reduced = searchText(buffer);
  if (reduced.length > buffer.length) assert.fail(`${label}: text is longer than the buffer (${describe(buffer)})`);
  let matches = 0;
  for (const [name, run] of GRAMMARS) {
    const expected = run(whole), actual = run(reduced);
    matches += expected.length;
    if (!sameList(actual, expected)) {
      assert.fail(`${label}: ${name} differs for ${describe(buffer)}\n` +
        `expected ${JSON.stringify(expected).slice(0, 400)}\nactual ${JSON.stringify(actual).slice(0, 400)}`);
    }
  }
  return matches;
}

const bytes = value => (typeof value === 'string' ? Buffer.from(value) : Buffer.from(value));
const join = (...parts) => Buffer.concat(parts.map(bytes));

const INVALID_UTF8 = [
  [0xc3], [0xe2], [0xe2, 0x82], [0xf0], [0xf0, 0x9f], [0xf0, 0x9f, 0x98], // truncated
  [0x80], [0xbf, 0xbf], // stray continuation
  [0xc0, 0xaf], [0xe0, 0x80, 0xaf], [0xf0, 0x80, 0x80, 0xaf], // overlong forms of '/'
  [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], // surrogate and past U+10FFFF
  [0xff], [0xfe, 0xff], [0xc3, 0x28], [0xe2, 0x28, 0xa1], [0xf0, 0x28, 0x8c, 0x28],
];
const DELIMITERS = [...Array.from({ length: 32 }, (_, code) => code), 0x22, 0x27];
const PREFIXES = ['/Users/', '/USERS/', '/users/', '/Volumes/', '/vOlUmEs/', 'x/Users/', 'é/Users/', '/Users//Users/', '/Users/a/Volumes/'];

test('invalid UTF-8 in every position, before every delimiter and at end of input', () => {
  let matches = 0, cases = 0;
  const places = {
    afterPrefix: (head, bad) => [head, bad, 'a/b.png'],
    body: (head, bad) => [head, 'a/', bad, 'b.png'],
    beforeExtension: (head, bad) => [head, 'a/b', bad, '.png'],
    afterExtension: (head, bad) => [head, 'a/b.png', bad],
    beforePrefix: (head, bad) => [bad, head, 'a/b.psd'],
  };
  for (const head of PREFIXES) {
    for (const bad of INVALID_UTF8) {
      for (const build of Object.values(places)) {
        const start = build(head, bad);
        matches += checkSame(join(...start, bad), 'end of input'); cases++;
        for (const delimiter of DELIMITERS) {
          matches += checkSame(join(...start, bad, [delimiter], '/Volumes/next/c.jpg', bad), 'delimiter'); cases++;
        }
      }
    }
  }
  assert.equal(cases, PREFIXES.length * INVALID_UTF8.length * Object.keys(places).length * (DELIMITERS.length + 1));
  assert.ok(matches > 100000, `only ${matches} matches`);
});

function caseMixes(word) {
  const letters = [...word].map((char, index) => ({ char, index })).filter(item => /[a-z]/.test(item.char));
  const mixes = [];
  for (let mask = 0; mask < 2 ** letters.length; mask++) {
    const chars = [...word];
    letters.forEach((item, bit) => { if (mask & (1 << bit)) chars[item.index] = item.char.toUpperCase(); });
    mixes.push(chars.join(''));
  }
  return mixes;
}

test('every case mix of both prefixes is found, and near misses stay unmatched', () => {
  for (const prefix of [...caseMixes('/users/'), ...caseMixes('/volumes/')]) {
    const matches = checkSame(join([0xff, 0x00], prefix, 'a/b.PNG', [0x00, 0xc3]), prefix);
    assert.equal(matches, GRAMMARS.length, prefix);
  }
  for (const nearMiss of ['/user/a.png', '/Users', '/Users.png', 'Users/a.png', '/Volume/a.png', '/Volumess/a.png', '/U/s/e/r/s/a.png']) {
    assert.equal(checkSame(bytes(nearMiss), nearMiss), 0, nearMiss);
  }
});

test('overlapping, adjacent and boundary prefixes', () => {
  const inputs = [
    '/Users/Users/a.png', '/Users//Users/a.png', '/Users/a.png/Users/b.jpg', '/Users/a.png/Volumes/b.jpg',
    '/Volumes/Users/x.png', '/Us/Users/a.png', '/Use/Volumes/x.png', '/Users/Volumes/', '/Users/a.png\0/Users/b.png',
    '/Users/no.psb /Volumes/disk/b.png', '/Users/a.png/Users/no-extension', '//Users/a.png', '/Volumes/Volumes/Volumes/v.tif',
    '/Users/a.tif.tiff.png.x', '/Users/a.woff2', '/Users/a.woff', '/Users/.png', '/Users/..png', '/Users/a.png.',
  ];
  let matches = 0;
  for (const input of inputs) {
    matches += checkSame(bytes(input), input); // prefix at offset 0
    matches += checkSame(join([0xf0, 0x9f], input), input); // after a broken sequence
    matches += checkSame(join('noise', [0x00], input, [0x00], 'noise'), input);
  }
  assert.ok(matches > 100);
  for (const tail of ['/Users/', '/Volumes/', '/User', '/Volumes', '/', '/U', '/Users/a.pn', '/Users/a.png']) {
    checkSame(join([0x01, 0xe2, 0x82], tail), `tail ${tail}`); // prefix in the last bytes
  }
});

test('code points that fold toward ASCII, and byte-order marks', () => {
  const inputs = [
    '/Uſers/a.png', '/Userſ/a.png', '/VOLUMEſ/a.png', '/volumeſ/a.png', '/Uſerſ/a.png', '/K/a.png',
    '/Users/a.ſvg', '/Users/a.ſketch', '/Users/a.sKetch', '/Users/a.aı', '/Users/a.aİ', '/Users/a.tıf', '/Users/a.tİf',
    '/İUsers/a.png', '/ıUsers/a.png', '/Users/İ/a.png', '/Users/ı/a.png', '/Users/ſK/a.png', '/Usеrs/a.png',
    '﻿/Users/a.png', '/Users/﻿a.png', '/Users/a﻿.png', '/Users/a.png﻿', '/﻿Users/a.png',
  ];
  let matches = 0;
  for (const input of inputs) {
    matches += checkSame(bytes(input), input);
    matches += checkSame(join(input, [0x00], input), input);
  }
  assert.ok(matches > 0);
  for (const mark of [[0xef, 0xbb, 0xbf], [0xff, 0xfe], [0xfe, 0xff], [0xff, 0xfe, 0x00, 0x00], [0x00, 0x00, 0xfe, 0xff]]) {
    assert.ok(checkSame(join(mark, '/Users/a/b.png'), `mark ${mark}`) > 0);
    assert.ok(checkSame(join('/Users/a/', mark, 'b.png'), `mark ${mark}`) > 0 || mark.includes(0));
  }
});

test('the same path in UTF-16LE, UTF-16BE and Latin-1', () => {
  const text = '/Users/café/a.png\n/Volumes/x/y.jpg';
  const utf16le = Buffer.from(text, 'utf16le');
  checkSame(utf16le, 'UTF-16LE');
  checkSame(Buffer.from(utf16le).swap16(), 'UTF-16BE');
  checkSame(Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le]), 'UTF-16LE with mark');
  assert.ok(checkSame(Buffer.from(text, 'latin1'), 'Latin-1') > 0);
});

test('percent-encoded, query, fragment, non-ASCII and astral paths', () => {
  const inputs = [
    'file:///Users/a%20b/c%2Epng and /Users/a%20b/c.png', '/Users/a/b.png?x=/Users/c/d.jpg#/Volumes/e.gif',
    '/Users/a/b.png#frag', '/Users/a/b.png?v=1', '/Users/%2Fa.png', '%2FUsers%2Fa.png',
    '/Users/日本語/ファイル.png', '/Users/é/ünï/çode.tif', '/Users/😀/emoji-😀.png', '/Volumes/𝒳/𝒴.jpeg',
    '/Users/é/a.png', '/Users/a b.png', '/Users/a b.png', '/Users/a\u0085b.png',
  ];
  let matches = 0;
  for (const input of inputs) matches += checkSame(bytes(input), input);
  assert.ok(matches > 40, `only ${matches} matches`);
});

function createRandom(seed) {
  let state = seed >>> 0;
  return limit => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state % limit;
  };
}

test('seeded noise with planted paths, including the first and last bytes', () => {
  const random = createRandom(0x51ed270f);
  const plants = ['/Users/n/o.png', '/VOLUMES/n/o.jpeg', '/users/é/o.tif', '/Users/😀/o.webp', '/Users/n/no-extension'];
  let matches = 0;
  for (let round = 0; round < 3000; round++) {
    const noise = Buffer.alloc(200 + random(300));
    for (let i = 0; i < noise.length; i++) noise[i] = random(256);
    const plant = bytes(plants[round % plants.length]);
    const offset = round % 3 === 0 ? 0 : round % 3 === 1 ? noise.length - plant.length : random(noise.length - plant.length);
    plant.copy(noise, offset);
    matches += checkSame(noise, `noise ${round}`);
  }
  assert.ok(matches > 5000, `only ${matches} matches`);
});

test('long delimiter-free runs and many prefixes in one run', () => {
  const filler = 'x'.repeat(300000);
  assert.ok(checkSame(bytes(`/Users/${filler}.png${filler}`), 'extension mid-run') > 0);
  assert.ok(checkSame(bytes(`/Users/${filler}é${filler}.png`), 'extension at end') > 0);
  assert.equal(checkSame(bytes(`/Users/${filler}`), 'no extension'), 0);
  assert.ok(checkSame(bytes(`${'/Users/a'.concat('z'.repeat(2000)).repeat(300)}.png`), 'many prefixes') > 0);
  assert.equal(checkSame(bytes('/Volumes/b'.concat('z'.repeat(5000)).repeat(30)), 'many prefixes, no extension'), 0);
});

test('empty and prefix-only inputs', () => {
  for (const input of ['', '/', '/Users/', '/Volumes/', '/USERS/', '/Users//Volumes/', '\0', '"', "'"]) {
    assert.equal(checkSame(bytes(input), JSON.stringify(input)), 0);
  }
  assert.equal(searchText(Buffer.alloc(0)), '');
});

test('a seeded generator over those atoms produces identical results', () => {
  const atoms = [
    '/', '/Users/', '/users/', '/USERS/', '/Volumes/', '/vOLUMES/', 'Users', 'a', 'B', '.', '.png', '.JPG', '.psd', '.woff', '.woff2',
    '.ai', '.tif', '.tiff', '.psb', 'f', ' ', '%20', '?', '#', '\\', 'ſ', 'K', 'ı', 'İ', '﻿', 'é', '€', '😀',
    [0x00], [0x0a], [0x0d], [0x1f], [0x22], [0x27], [0x7f], [0xc3], [0xe2, 0x82], [0xf0, 0x9f], [0x80], [0xff], [0xc0, 0xaf],
  ].map(bytes);
  const random = createRandom(0x1234abcd);
  let matches = 0;
  for (let round = 0; round < 60000; round++) {
    const parts = [];
    for (let count = random(16); count > 0; count--) parts.push(atoms[random(atoms.length)]);
    matches += checkSame(Buffer.concat(parts), `round ${round}`);
  }
  assert.ok(matches > 20000, `only ${matches} matches`);
});

test('only candidate runs are decoded, and they are joined by a delimiter', t => {
  const buffer = join([0xff], 'noise', [0x00], '/Users/a.png', [0x22], 'more', [0x27], '/VOLUMES/é/b.jpg', [0x0a], 'tail');
  const realToString = Buffer.prototype.toString, spans = [];
  t.mock.method(Buffer.prototype, 'toString', function (...args) {
    spans.push((args[2] ?? this.length) - (args[1] ?? 0));
    return realToString.apply(this, args);
  });
  const text = searchText(buffer);
  t.mock.restoreAll();
  assert.equal(text, '/Users/a.png\n/VOLUMES/é/b.jpg');
  assert.deepEqual(spans, [12, 17]);
  assert.equal(searchText(join('no candidates', [0x00], '/tmp/a.png')), '');
});

test('every delimiter byte ends a run, and no other byte does', () => {
  for (const delimiter of DELIMITERS) {
    assert.equal(searchText(join('/Users/a.png', [delimiter], 'tail')), '/Users/a.png', `byte ${delimiter}`);
  }
  for (const byte of [0x20, 0x21, 0x23, 0x26, 0x28, 0x7f]) {
    const text = String.fromCharCode(byte);
    assert.equal(searchText(join('/Users/a.png', [byte], 'tail')), `/Users/a.png${text}tail`, `byte ${byte}`);
  }
  assert.equal(searchText(join('/Users/a.png', [0xff], 'tail')), '/Users/a.png�tail');
});

test('a run ends at its delimiter even when a later prefix sits inside it', () => {
  assert.equal(searchText(bytes('/Users/a/Volumes/b.png')), '/Users/a/Volumes/b.png');
  assert.equal(searchText(bytes('/Use/Users/a.png')), '/Users/a.png');
});

test('a buffer over the string limit takes the old whole-buffer decode', t => {
  const buffer = bytes('noise /Users/a.png noise');
  const realToString = Buffer.prototype.toString, calls = [];
  t.mock.method(Buffer.prototype, 'toString', function (...args) {
    calls.push({ same: this === buffer, args });
    return realToString.apply(this, args);
  });
  assert.equal(searchText(buffer, buffer.length - 1), 'noise /Users/a.png noise');
  assert.deepEqual(calls, [{ same: true, args: ['utf8'] }]);
  calls.length = 0;
  assert.equal(searchText(buffer, buffer.length), '/Users/a.png noise', 'exactly at the limit is still reduced');
  assert.equal(calls.some(call => call.same), false);
});

// A Buffer in type only: it reports any length without allocating it.
function bufferReporting(length, toString) {
  const fake = Object.setPrototypeOf(new Uint8Array(0), Buffer.prototype);
  Object.defineProperty(fake, 'length', { value: length });
  fake.toString = toString;
  return fake;
}

test('the default limit is the runtime string limit, and the old decode error passes through', () => {
  const failure = Object.assign(new Error('synthetic string limit'), { code: 'ERR_STRING_TOO_LONG' });
  const over = bufferReporting(constants.MAX_STRING_LENGTH + 1, () => { throw failure; });
  assert.ok(Buffer.isBuffer(over));
  assert.throws(() => searchText(over), error => error === failure);
  const atLimit = bufferReporting(constants.MAX_STRING_LENGTH, () => { throw failure; });
  assert.equal(searchText(atLimit), '');
});

test('a value that is not a Buffer keeps the old toString behavior', () => {
  assert.equal(searchText('/Users/a.png as text'), '/Users/a.png as text');
  assert.throws(() => searchText(undefined), TypeError);
});

function trackedOptions() {
  const calls = { failure: 0, limit: [] };
  return { calls, onOrdinaryScanFailure: () => { calls.failure++; }, onOrdinaryScanLimit: reason => calls.limit.push(reason) };
}

function fsWith(promises) {
  return { ...fs, promises: { ...fs.promises, ...promises } };
}

test('extractLinkedAssetsRegex: read errors keep their strict and ordinary outcomes', async () => {
  const failure = Object.assign(new Error('synthetic read failure'), { code: 'EIO' });
  const extract = mainExtractor(root, { fs: fsWith({ stat: async () => ({ size: 10 }), readFile: async () => { throw failure; } }) });
  await assert.rejects(extract('/Users/synthetic/source.ai', { strict: true }), error => error === failure);
  const ordinary = trackedOptions();
  assert.deepEqual(Array.from(await extract('/Users/synthetic/source.ai', ordinary)), []);
  assert.deepEqual(ordinary.calls, { failure: 1, limit: [] });
});

test('extractLinkedAssetsRegex: the file size guard still runs before any read', async () => {
  let reads = 0;
  const extract = mainExtractor(root, { fs: fsWith({
    stat: async () => ({ size: 300 * 1024 * 1024 + 1 }),
    readFile: async () => { reads++; return Buffer.alloc(0); },
  }) });
  await assert.rejects(extract('/Users/synthetic/source.ai', { strict: true }), /asset_baseline_source_too_large/);
  const ordinary = trackedOptions();
  assert.deepEqual(Array.from(await extract('/Users/synthetic/source.ai', ordinary)), []);
  assert.deepEqual(ordinary.calls, { failure: 0, limit: ['source-too-large'] });
  assert.equal(reads, 0);
});

test('extractLinkedAssetsRegex: a decode failure keeps its strict and ordinary outcomes', async () => {
  const failure = Object.assign(new Error('synthetic string limit'), { code: 'ERR_STRING_TOO_LONG' });
  const sourceBuffer = bufferReporting(constants.MAX_STRING_LENGTH + 1, () => { throw failure; });
  const extract = mainExtractor(root);
  await assert.rejects(extract('/Users/synthetic/source.ai', { strict: true, sourceBuffer }), error => error === failure);
  const ordinary = trackedOptions();
  assert.deepEqual(Array.from(await extract('/Users/synthetic/source.ai', { ...ordinary, sourceBuffer })), []);
  assert.deepEqual(ordinary.calls, { failure: 1, limit: [] });
});

test('extractLinkedAssetsRegex: the source file still excludes itself', async () => {
  const sourceBuffer = bytes('/Users/s/source.ai\0/Users/s/link.png\0/Users/s/source.ai');
  const found = await mainExtractor(root)('/Users/s/source.ai', { sourceBuffer });
  assert.deepEqual(Array.from(found), ['/Users/s/link.png']);
});
