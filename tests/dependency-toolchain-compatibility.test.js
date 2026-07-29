'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const glob = require('glob');
const minimatchModule = require('minimatch');

test('legacy glob and current minimatch keep brace patterns compatible', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-glob-compat-'));
  try {
    fs.writeFileSync(path.join(temporaryRoot, 'Crate.dmg'), 'dmg');
    fs.writeFileSync(path.join(temporaryRoot, 'Crate.zip'), 'zip');
    fs.writeFileSync(path.join(temporaryRoot, 'ignore.txt'), 'txt');

    assert.deepEqual(
      glob.sync('*.{dmg,zip}', { cwd: temporaryRoot }).sort(),
      ['Crate.dmg', 'Crate.zip']
    );
    assert.equal(
      minimatchModule.minimatch('Crate.dmg', '*.{dmg,zip}'),
      true
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
