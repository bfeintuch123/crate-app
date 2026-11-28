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
// Valid UTF-8 goes straight to the whole-buffer decode. This runs the byte scan
// on any input, so the reduced text itself stays under test.
const scanText = (buffer, options) => searchText(buffer, { isValidUtf8: () => false, ...options });
// The pair searches are timed; a clock that never moves keeps a test on the reduced path.
const FROZEN_CLOCK = () => 0;
// A reduced text is its runs, a newline, then blanks 128 longer than the runs.
// This checks that padding exactly and returns the runs.
function runsOf(text) {
  if (text === '') return text;
  const end = text.lastIndexOf('\n');
  const runs = text.slice(0, end);
  assert.ok(text.slice(end + 1) === ' '.repeat(runs.length + 128), 'blank padding after the runs');
  return runs;
}

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
function checkSame(buffer, label, options) {
  const whole = buffer.toString('utf8');
  const texts = options ? [scanText(buffer, options)] : [searchText(buffer), scanText(buffer)];
  let matches = 0;
  for (const [name, run] of GRAMMARS) {
    const expected = run(whole);
    matches += expected.length;
    for (const reduced of texts) {
      // The runs, without their padding, never outgrow the buffer.
      const runs = reduced === whole ? reduced : runsOf(reduced);
      if (runs.length > buffer.length) assert.fail(`${label}: text is longer than the buffer (${describe(buffer)})`);
      const actual = run(reduced);
      if (!sameList(actual, expected)) {
        assert.fail(`${label}: ${name} differs for ${describe(buffer)}\n` +
          `expected ${JSON.stringify(expected).slice(0, 400)}\nactual ${JSON.stringify(actual).slice(0, 400)}`);
      }
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

test('a prefix is found at every distance after other slashes', () => {
  for (let gap = 0; gap < 80; gap++) {
    for (const filler of ['/', 'x', 'é', '/x']) {
      const lead = `/${filler.repeat(gap)}`;
      assert.ok(checkSame(bytes(`${lead}/Users/a.png`), `gap ${gap} ${filler}`) > 0, `gap ${gap} ${filler}`);
      assert.ok(searchText(join(lead, [0x00], '/Volumes/b.jpg')).endsWith('/Volumes/b.jpg'), `gap ${gap} ${filler}`);
    }
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
  assert.equal(scanText(Buffer.alloc(0)), '');
});

test('a seeded generator over those atoms produces identical results on both paths', () => {
  const atoms = [
    '/', '/Users/', '/users/', '/USERS/', '/Volumes/', '/vOLUMES/', 'Users', 'a', 'B', '.', '.png', '.JPG', '.psd', '.woff', '.woff2',
    '.ai', '.tif', '.tiff', '.psb', 'f', ' ', '%20', '?', '#', '\\', 'ſ', 'K', 'ı', 'İ', '﻿', 'é', '€', '😀',
    [0x00], [0x0a], [0x0d], [0x1f], [0x22], [0x27], [0x7f], [0xc3], [0xe2, 0x82], [0xf0, 0x9f], [0x80], [0xff], [0xc0, 0xaf],
  ].map(bytes);
  const random = createRandom(0x1234abcd);
  // Every other round gets one tiny budget, so runs of both paths are compared.
  const tinyBudget = round => [
    { maxSlashMisses: random(3) }, { maxRuns: random(3) }, { maxRunBytes: random(24) },
  ][round % 3];
  let matches = 0, fellBack = 0, reducedRounds = 0;
  for (let round = 0; round < 60000; round++) {
    const parts = [];
    for (let count = random(16); count > 0; count--) parts.push(atoms[random(atoms.length)]);
    const buffer = Buffer.concat(parts), options = round % 2 ? tinyBudget(round) : undefined;
    matches += checkSame(buffer, `round ${round}`, options);
    const whole = buffer.toString('utf8');
    if (options && whole !== scanText(buffer)) (scanText(buffer, options) === whole ? fellBack++ : reducedRounds++);
  }
  assert.ok(matches > 20000, `only ${matches} matches`);
  assert.ok(fellBack > 1000, `only ${fellBack} rounds used the whole-buffer path`);
  assert.ok(reducedRounds > 1000, `only ${reducedRounds} rounds used reduced text`);
});

test('only candidate runs are decoded, and they are joined by a delimiter', t => {
  const buffer = join([0xff], 'noise', [0x00], '/Users/a.png', [0x22], 'more', [0x27], '/VOLUMES/é/b.jpg', [0x0a], 'tail');
  const realToString = Buffer.prototype.toString, spans = [];
  t.mock.method(Buffer.prototype, 'toString', function (...args) {
    spans.push((args[2] ?? this.length) - (args[1] ?? 0));
    return realToString.apply(this, args);
  });
  const text = scanText(buffer);
  t.mock.restoreAll();
  assert.equal(runsOf(text), '/Users/a.png\n/VOLUMES/é/b.jpg');
  assert.deepEqual(spans, [12, 17]);
  assert.equal(scanText(join('no candidates', [0x00], '/tmp/a.png')), '');
});

test('blank padding fills the middle of a reduced text, up to a size limit', () => {
  for (const runs of ['/Users/a.png', '/Users/a.png\n/VOLUMES/é/b.jpg', `/Users/${'é'.repeat(5000)}.png`]) {
    const buffer = join([0xff], ...runs.split('\n').flatMap(run => [run, [0x00]]));
    const text = scanText(buffer);
    assert.equal(runsOf(text), runs);
    // V8 samples 128 characters from the middle of the text it compiles on.
    const middle = Math.floor((text.length - 128) / 2);
    assert.ok(/^\n? *$/.test(text.slice(middle, middle + 128)), 'the middle is padding');
    assert.ok(scanText(buffer, { maxPaddedRunChars: runs.length }) === text, 'at the limit');
    assert.equal(scanText(buffer, { maxPaddedRunChars: runs.length - 1 }), runs, 'over the limit, the runs alone');
  }
});

test('every delimiter byte ends a run, and no other byte does', () => {
  for (const delimiter of DELIMITERS) {
    assert.equal(runsOf(scanText(join('/Users/a.png', [delimiter], 'tail'))), '/Users/a.png', `byte ${delimiter}`);
  }
  for (const byte of [0x20, 0x21, 0x23, 0x26, 0x28, 0x7f]) {
    const text = String.fromCharCode(byte);
    assert.equal(runsOf(scanText(join('/Users/a.png', [byte], 'tail'))), `/Users/a.png${text}tail`, `byte ${byte}`);
  }
  assert.equal(runsOf(scanText(join('/Users/a.png', [0xff], 'tail'))), '/Users/a.png�tail');
});

test('a run ends at its delimiter even when a later prefix sits inside it', () => {
  assert.equal(runsOf(scanText(bytes('/Users/a/Volumes/b.png'))), '/Users/a/Volumes/b.png');
  assert.equal(runsOf(scanText(bytes('/Use/Users/a.png'))), '/Users/a.png');
});

test('a buffer over the string limit takes the old whole-buffer decode', t => {
  const buffer = bytes('noise /Users/a.png noise');
  const realToString = Buffer.prototype.toString, calls = [];
  t.mock.method(Buffer.prototype, 'toString', function (...args) {
    calls.push({ same: this === buffer, args });
    return realToString.apply(this, args);
  });
  assert.equal(scanText(buffer, { maxStringLength: buffer.length - 1 }), 'noise /Users/a.png noise');
  assert.deepEqual(calls, [{ same: true, args: ['utf8'] }]);
  calls.length = 0;
  assert.equal(runsOf(scanText(buffer, { maxStringLength: buffer.length })), '/Users/a.png noise', 'exactly at the limit is still reduced');
  assert.equal(calls.some(call => call.same), false);
});

// A Buffer in type only: it reports any length without allocating it.
function bufferReporting(length, toString) {
  const fake = Object.setPrototypeOf(new Uint8Array([0xff]), Buffer.prototype); // one invalid byte
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

test('each budget, once exceeded, gives exactly the whole-buffer text', () => {
  const cases = [
    ['pair misses', join('head as/ bS/ /Users/x.png', [0x00], 'tail'), { maxSlashMisses: 2 }, { maxSlashMisses: 1 }],
    ['runs', join('head', [0x00], '/Users/a.png', [0x00], '/Users/b.png', [0x00]), { maxRuns: 2 }, { maxRuns: 1 }],
    ['run bytes', join('head', [0x00], '/Users/a.png', [0x00], '/Users/b.png', [0x00]), { maxRunBytes: 24 }, { maxRunBytes: 23 }],
    ['pair density', join('as/bs/cs/ ', 'x'.repeat(2000), ' /Users/x.png', [0x00]), { slashMissHeadroom: 3 }, { slashMissHeadroom: 2 }],
  ];
  for (const [name, buffer, atLimit, overLimit] of cases) {
    const whole = buffer.toString('utf8');
    assert.notEqual(scanText(buffer, atLimit), whole, `${name}: exactly at the budget stays reduced`);
    assert.equal(scanText(buffer, overLimit), whole, `${name}: over the budget`);
    checkSame(buffer, name, atLimit);
    checkSame(buffer, name, overLimit);
  }
});

test('every fallback releases the kept runs before the whole-buffer decode', t => {
  const twoRuns = join([0xff], '/Users/a.png', [0x00], '/Users/b.png', [0x00]);
  const runThenSlashes = join([0xff], '/Users/a.png', [0x00], ' bs/ cs/ dS/ es/');
  const cases = [
    ['slash budget', runThenSlashes, { maxSlashMisses: 2 }],
    ['slash density', runThenSlashes, { slashMissHeadroom: 1 }],
    ['run limit', twoRuns, { maxRuns: 1 }],
    ['run bytes', twoRuns, { maxRunBytes: 13 }],
  ];
  const realToString = Buffer.prototype.toString;
  for (const [name, buffer, options] of cases) {
    const whole = buffer.toString('utf8'), keptRuns = [];
    let keptDuringDecode = null, runDecodes = 0;
    t.mock.method(Buffer.prototype, 'toString', function (...args) {
      if (this === buffer) keptDuringDecode = keptRuns.length; else runDecodes++;
      return realToString.apply(this, args);
    });
    const text = scanText(buffer, { ...options, keptRuns });
    t.mock.restoreAll();
    assert.equal(text, whole, name);
    assert.equal(runDecodes, 1, `${name}: one run was kept first`);
    assert.equal(keptDuringDecode, 0, name);
  }
});

function repeated(unit, byteLength) {
  const pattern = Buffer.from(unit, 'latin1'), out = Buffer.alloc(byteLength);
  for (let offset = 0; offset < byteLength; offset += pattern.length) pattern.copy(out, offset, 0, Math.min(pattern.length, byteLength - offset));
  return out;
}

function seededBytes(byteLength, seed) {
  const random = createRandom(seed), out = Buffer.alloc(byteLength);
  for (let offset = 0; offset < byteLength; offset += 4) out.writeUInt32LE(random(0xffffffff), Math.min(offset, byteLength - 4));
  return out;
}

const DENSE_BYTES = 3 * 1024 * 1024;
// Every prefix ends in s/ or S/, so the scan stops at those pairs.
function pairEvery(step) {
  const out = seededBytes(DENSE_BYTES, 0x7a1c55e3);
  for (let offset = 0; offset + 1 < out.length; offset += step) { out[offset] = 0x73; out[offset + 1] = 0x2f; }
  return out;
}
const withInvalidByte = buffer => Buffer.concat([buffer, Buffer.from([0xff])]);
const DENSE_INPUTS = {
  'all s/ pairs': () => repeated('s/', DENSE_BYTES),
  'an s/ pair every 24 bytes': () => pairEvery(24),
  'prefixes with delimiters': () => repeated('/Users/\0', DENSE_BYTES),
  'one prefix per line': () => repeated('/Users/synthetic/Links/linked-file.png\n', DENSE_BYTES),
  'prefixes without delimiters': () => repeated('/Volumes/', DENSE_BYTES),
};

test('dense input with the default budgets gives exactly the whole-buffer text', () => {
  for (const [name, build] of Object.entries(DENSE_INPUTS)) {
    const buffer = withInvalidByte(build());
    assert.ok(searchText(buffer) === buffer.toString('utf8'), name);
  }
});

function countDecodes(t, buffer, run) {
  const realToString = Buffer.prototype.toString, counts = { total: 0, whole: 0 };
  t.mock.method(Buffer.prototype, 'toString', function (...args) {
    counts.total++;
    if (this === buffer) counts.whole++;
    return realToString.apply(this, args);
  });
  try { run(); } finally { t.mock.restoreAll(); }
  return counts;
}

test('dense input costs at most the run limit plus one decode', t => {
  const RUN_LIMIT = 4096;
  for (const [name, build] of Object.entries(DENSE_INPUTS)) {
    const buffer = withInvalidByte(build()), counts = countDecodes(t, buffer, () => searchText(buffer));
    assert.ok(counts.total <= RUN_LIMIT + 1, `${name}: ${counts.total} decodes`);
    assert.equal(counts.whole, 1, name);
  }
  const prefixes = withInvalidByte(DENSE_INPUTS['prefixes with delimiters']());
  assert.equal(countDecodes(t, prefixes, () => searchText(prefixes)).total, RUN_LIMIT + 1);
});

test('valid UTF-8 goes straight to one whole-buffer decode', t => {
  const { isUtf8 } = require('node:buffer');
  assert.equal(typeof isUtf8, 'function');
  const inputs = [
    DENSE_INPUTS['all s/ pairs'](), DENSE_INPUTS['prefixes with delimiters'](), DENSE_INPUTS['one prefix per line'](),
    DENSE_INPUTS['prefixes without delimiters'](), Buffer.from('/Users/é/日本語/😀.png\n'.repeat(4096)),
  ];
  for (const buffer of inputs) {
    assert.ok(isUtf8(buffer));
    assert.deepEqual(countDecodes(t, buffer, () => searchText(buffer)), { total: 1, whole: 1 });
  }
});

test('without a UTF-8 check the budgets still apply', () => {
  for (const build of [DENSE_INPUTS['all s/ pairs'], DENSE_INPUTS['prefixes with delimiters']]) {
    const buffer = build();
    assert.ok(searchText(buffer, { isValidUtf8: null }) === buffer.toString('utf8'));
  }
  assert.equal(runsOf(searchText(bytes('x /Users/a.png'), { isValidUtf8: null })), '/Users/a.png');
});

test('long kept runs reach the default byte budget before the run limit', t => {
  // 2,000 runs of 100 bytes in 3 MiB: under 4,096 runs, over length / 32 bytes.
  const buffer = seededBytes(DENSE_BYTES, 0x44aa1c09);
  for (let i = 0; i < 2000; i++) Buffer.from(`\0/Users/${'r'.repeat(90)}.png\0`).copy(buffer, 1000 + i * 1400);
  const counts = countDecodes(t, buffer, () => assert.ok(searchText(buffer) === buffer.toString('utf8')));
  assert.equal(counts.whole, 2, 'the fallback decode and this comparison');
  assert.ok(counts.total <= 1002, `${counts.total} decodes`);
});

test('pair-dense data gives up early instead of spending the whole budget', t => {
  const buffer = withInvalidByte(repeated(`s/${'x'.repeat(38)}`, DENSE_BYTES));
  const realIndexOf = Buffer.prototype.indexOf;
  let searches = 0;
  // Searches run on windowed views of the buffer's memory. The clock is frozen,
  // so the miss budget, not the time allowance, is what gives up.
  t.mock.method(Buffer.prototype, 'indexOf', function (...args) { if (this.buffer === buffer.buffer) searches++; return realIndexOf.apply(this, args); });
  const text = searchText(buffer, { now: FROZEN_CLOCK });
  t.mock.restoreAll();
  assert.ok(text === buffer.toString('utf8'));
  assert.ok(searches > 1000 && searches < 7000, `${searches} searches`);
});

test('sparse binary data stays on the reduced path', t => {
  const buffer = seededBytes(DENSE_BYTES, 0x31d0a9c7);
  for (let i = 0; i < 2000; i++) Buffer.from(`\0/Users/s/Links/f${i}.png\0`).copy(buffer, 1000 + i * 1400);
  let text;
  const counts = countDecodes(t, buffer, () => { text = searchText(buffer, { now: FROZEN_CLOCK }); });
  assert.equal(counts.whole, 0);
  assert.ok(counts.total >= 2000 && counts.total <= 4096, `${counts.total} decodes`);
  assert.deepEqual(extractLinkedAssetPaths(text, '/x'), extractLinkedAssetPaths(buffer.toString('utf8'), '/x'));
  assert.ok(extractLinkedAssetPaths(text, '/x').length >= 2000);
});

test('a value that is not a Buffer keeps the old toString behavior', () => {
  assert.equal(searchText('/Users/a.png as text'), '/Users/a.png as text');
  assert.equal(searchText(new Uint8Array([1, 2])), '1,2');
  assert.throws(() => searchText(undefined), TypeError);
  assert.throws(() => searchText(null), TypeError);
  const throwing = { get length() { throw new Error('length inspected'); }, toString(encoding) { return `/Users/x.png ${encoding}`; } };
  assert.equal(searchText(throwing), '/Users/x.png utf8');
  let lengthReads = 0;
  const counting = { get length() { lengthReads++; return 5; }, toString: encoding => encoding };
  assert.equal(searchText(counting), 'utf8');
  assert.equal(lengthReads, 0);
});

test('a non-Buffer whose prototype lookup is unusual gets the old toString result', () => {
  const text = { toString(encoding) { return `/Users/a.png as ${encoding}`; } };
  const shapes = [
    ['a prototype lookup that throws', { getPrototypeOf() { throw new Error('prototype inspected'); } }],
    ['a prototype lookup that reports Buffer', { getPrototypeOf() { return Buffer.prototype; } }],
  ];
  for (const [name, handler] of shapes) {
    const value = new Proxy(text, handler);
    assert.equal(searchText(value), value.toString('utf8'), name);
  }
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

// Pair searches run in windows; a pair may start on a window's last byte and end
// in the next. Every window size must give exactly the one-search text.
function sparseWithLinks(byteLength, seed, every) {
  const buffer = seededBytes(byteLength, seed);
  for (let i = 0, at = 777; at + 80 < byteLength; i++, at += every) Buffer.from(`\0/Users/s/Links/f${i}.png\0/VOLUMES/v/w${i}.psd\0`).copy(buffer, at);
  return buffer;
}

test('every window size gives exactly the text of the default window', () => {
  const random = createRandom(0x0b1d5eed);
  const atoms = ['/Users/a/b.png', '/VOLUMES/x/y.psd', 's/', 'S/', '/users/', 'rs/', 'es/', 'Users/', [0x00], [0x0a], [0x22], [0xff], 'é', 'abc'].map(bytes);
  const windows = [1, 2, 3, 7, 64, 4096];
  for (let round = 0; round < 3000; round++) {
    const parts = [];
    for (let count = random(24); count > 0; count--) parts.push(atoms[random(atoms.length)]);
    const buffer = Buffer.concat([...parts, Buffer.from([0xff])]);
    const expected = scanText(buffer, { now: FROZEN_CLOCK });
    for (const windowBytes of windows) {
      const text = scanText(buffer, { now: FROZEN_CLOCK, windowBytes });
      if (text !== expected) assert.fail(`round ${round}, window ${windowBytes}: ${describe(buffer)}`);
    }
  }
  const sparse = sparseWithLinks(64 * 1024, 0x5eed0001, 997);
  const expected = scanText(sparse, { now: FROZEN_CLOCK });
  assert.ok(runsOf(expected).split('\n').length > 100);
  for (const windowBytes of windows) assert.ok(scanText(sparse, { now: FROZEN_CLOCK, windowBytes }) === expected, `window ${windowBytes}`);
});

test('a link across the default window boundary is found once and in order', () => {
  const WINDOW = 256 * 1024;
  // Each case puts a different part of the link on the window's last bytes.
  for (const pairStart of [WINDOW - 2, WINDOW - 1, WINDOW, WINDOW + 3]) {
    const buffer = seededBytes(WINDOW * 2 + 1000, 0x5eed0002 + pairStart);
    const before = '\0/Users/s/early.png\0', link = '/Users/s/Links/cross.png', prefixToPair = '/Users/'.length - 2;
    Buffer.from(before).copy(buffer, 100);
    Buffer.from(`\0${link}\0`).copy(buffer, pairStart - prefixToPair - 1);
    const text = scanText(buffer, { now: FROZEN_CLOCK });
    const runs = runsOf(text).split('\n');
    assert.deepEqual(runs.filter(run => run.includes('cross.png')), [link], `pair at ${pairStart}`);
    assert.ok(runs.indexOf('/Users/s/early.png') < runs.indexOf(link));
    checkSame(buffer, `boundary ${pairStart}`, { now: FROZEN_CLOCK });
  }
});

test('each needle searches each pair start at most once, across windows and runs', t => {
  const buffer = sparseWithLinks(3 * 1024 * 1024, 0x5eed0003, 4096);
  const realIndexOf = Buffer.prototype.indexOf, calls = [];
  t.mock.method(Buffer.prototype, 'indexOf', function (needle, start, ...rest) {
    const found = realIndexOf.call(this, needle, start, ...rest);
    if (this.buffer === buffer.buffer && Buffer.isBuffer(needle)) calls.push({ needle: needle.toString('latin1'), start, found, last: this.length - 2 });
    return found;
  });
  scanText(buffer, { now: FROZEN_CLOCK });
  t.mock.restoreAll();
  for (const needle of ['s/', 'S/']) {
    // Pair starts searched by one call: up to the hit, or to the view's last pair start.
    const ranges = calls.filter(call => call.needle === needle).map(call => [call.start, call.found === -1 ? call.last : call.found]);
    assert.ok(ranges.length > 10, needle);
    for (let i = 1; i < ranges.length; i++) assert.ok(ranges[i][0] > ranges[i - 1][1], `${needle}: search ${i} repeats pair starts`);
  }
});

function clockCharging(msPerCall) {
  let time = 0;
  return () => { time += msPerCall(); return time; };
}

test('past the search-time allowance the whole-buffer text is used, kept runs released first', t => {
  const buffer = sparseWithLinks(1024 * 1024, 0x5eed0004, 2048);
  const whole = buffer.toString('utf8'), keptRuns = [];
  const realToString = Buffer.prototype.toString;
  let keptDuringDecode = null;
  t.mock.method(Buffer.prototype, 'toString', function (...args) {
    if (this === buffer) keptDuringDecode = keptRuns.length;
    return realToString.apply(this, args);
  });
  // Each timed search appears to take 5 ms: the first window boundary is past the headroom.
  const text = scanText(buffer, { keptRuns, now: clockCharging(() => 2.5) });
  t.mock.restoreAll();
  assert.ok(text === whole);
  assert.equal(keptDuringDecode, 0);
  checkSame(buffer, 'time allowance', { now: clockCharging(() => 2.5) });
});

test('unspent allowance does not carry forward to a later costly stretch', t => {
  // 36 MiB of cheap searches would bank about 19 ms of allowance. One later
  // window whose searches appear to take at least 6 ms passes the 4 ms headroom
  // only because nothing was banked.
  const MIB = 1024 * 1024, WINDOW = 256 * 1024, costly = 36 * MIB;
  const buffer = seededBytes(40 * MIB, 0x5eed0005);
  Buffer.from('\0/Users/s/Links/early.png\0').copy(buffer, 1000);
  const realIndexOf = Buffer.prototype.indexOf;
  let lastStart = 0;
  t.mock.method(Buffer.prototype, 'indexOf', function (needle, start, ...rest) {
    if (this.buffer === buffer.buffer) lastStart = start;
    return realIndexOf.call(this, needle, start, ...rest);
  });
  const text = scanText(buffer, { now: clockCharging(() => (lastStart >= costly && lastStart < costly + WINDOW ? 1.5 : 0)) });
  t.mock.restoreAll();
  assert.ok(text === buffer.toString('utf8'), 'the costly window led to the whole-buffer text');
  assert.ok(lastStart < costly + 2 * WINDOW, `searched to ${lastStart}`);
});

test('a scan that already reached the end is kept, whatever the clock says', () => {
  // The run starts in the first 16-byte window and reaches the end of the input,
  // so the scan is complete before any window boundary is checked.
  const buffer = join([0xff], '/Users/a/', 'y'.repeat(60));
  const text = scanText(buffer, { windowBytes: 16, now: clockCharging(() => 1000) });
  assert.equal(runsOf(text), `/Users/a/${'y'.repeat(60)}`);
});

test('an unusable window size falls back to the default window', () => {
  const buffer = sparseWithLinks(64 * 1024, 0x5eed0006, 1500);
  const expected = scanText(buffer, { now: FROZEN_CLOCK });
  for (const windowBytes of [0, -1, NaN, Infinity, 0.5]) assert.ok(scanText(buffer, { now: FROZEN_CLOCK, windowBytes }) === expected, String(windowBytes));
});

// Two windows of bytes 0x80-0xff: never valid UTF-8, never an s, S or /, so each
// window makes exactly two pair searches (s/ then S/) and both find nothing.
const BOUNDARY_WINDOW = 1000000;
function windowPairBuffer() {
  const buffer = seededBytes(2 * BOUNDARY_WINDOW, 0x5eed0007);
  for (let i = 0; i < buffer.length; i++) buffer[i] |= 0x80;
  return buffer;
}
// Every timed search appears to take exactly `msPerSearch` (the clock moves on
// the second of its two reads), so one window costs exactly 2 * msPerSearch.
function clockPerSearch(msPerSearch) {
  let time = 0, reads = 0;
  return () => { if (reads++ % 2) time += msPerSearch; return time; };
}

test('the debt is window time less the allowance for the bytes covered', () => {
  const buffer = windowPairBuffer();
  const whole = buffer.toString('utf8');
  // 4.4 ms of searching less 0.5 ns x 1,000,000 bytes (0.5 ms) leaves 3.9 ms: kept.
  assert.equal(scanText(buffer, { windowBytes: BOUNDARY_WINDOW, now: clockPerSearch(2.2) }), '');
  // The same window with no allowance would be over the 4 ms headroom.
  assert.ok(scanText(buffer, { windowBytes: BOUNDARY_WINDOW, scanNsPerByte: 0, now: clockPerSearch(2.2) }) === whole);
  // The allowance scales with the rate: 0.39 ns per byte leaves 4.01 ms, over.
  assert.ok(scanText(buffer, { windowBytes: BOUNDARY_WINDOW, scanNsPerByte: 0.39, now: clockPerSearch(2.2) }) === whole);
});

test('a debt of exactly 4 ms is kept and anything above it falls back', () => {
  const buffer = windowPairBuffer();
  const whole = buffer.toString('utf8');
  // 2 x 2.25 ms - 0.5 ms = 4 ms exactly: not past the headroom.
  assert.equal(scanText(buffer, { windowBytes: BOUNDARY_WINDOW, now: clockPerSearch(2.25) }), '');
  // 2 x 2.2505 ms - 0.5 ms = 4.001 ms: past it.
  assert.ok(scanText(buffer, { windowBytes: BOUNDARY_WINDOW, now: clockPerSearch(2.2505) }) === whole);
  // The headroom is the 4 ms default: a 3.999 ms headroom trips at exactly 4 ms.
  assert.ok(scanText(buffer, { windowBytes: BOUNDARY_WINDOW, scanTimeHeadroomMs: 3.999, now: clockPerSearch(2.25) }) === whole);
});
