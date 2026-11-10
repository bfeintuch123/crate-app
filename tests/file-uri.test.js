'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { fileUriToPath } = require('../parsers/xml-path');

test('fileUriToPath reads the three local file URI forms and nothing else', () => {
  const cases = [
    // Accepted forms: empty host, localhost, or no authority.
    ['file:/Users/a/x.png', '/Users/a/x.png'],
    ['file:///Users/a/x.png', '/Users/a/x.png'],
    ['file://localhost/Users/a/x.png', '/Users/a/x.png'],
    ['file://LocalHost/Users/a/x.png', '/Users/a/x.png'],
    ['FILE:///Users/a/x.png', '/Users/a/x.png'],
    ['FiLe:/Volumes/disk/x.png', '/Volumes/disk/x.png'],
    ['file:/tmp/x.png', '/tmp/x.png'],
    // Percent-decoding of the path.
    ['file:/Users/a/My%20Folder/x.png', '/Users/a/My Folder/x.png'],
    ['file:///Users/a/R%26D/x.png', '/Users/a/R&D/x.png'],
    ['file:///Users/a/b%2Fc.png', '/Users/a/b/c.png'],
    ['file:///Users/a/100%25.png', '/Users/a/100%.png'],
    ['file:///Users/a/caf%C3%A9.png', '/Users/a/café.png'],
    // Malformed percent-encoding keeps the undecoded text, as both stacks did.
    ['file:///Users/a/100%.png', '/Users/a/100%.png'],
    ['file:/Users/a/%E0%A4%A.png', '/Users/a/%E0%A4%A.png'],
    // The helper does not decode XML entities; callers decode them first.
    ['file:/Users/a/R&amp;D/x.png', '/Users/a/R&amp;D/x.png'],
    // Rejected: other schemes, other hosts, relative forms, extra slashes.
    ['https://example.invalid/Users/a/x.png', null],
    ['filex:/Users/a/x.png', null],
    ['/Users/a/x.png', null],
    ['file:', null],
    // A bare root names no file.
    ['file:/', null],
    ['file:///', null],
    ['file://localhost/', null],
    ['file://', null],
    ['file://localhost', null],
    ['file://server/Users/a/x.png', null],
    ['file://Users/a/x.png', null],
    ['file://%2FUsers/a/x.png', null],
    ['file:Users/a/x.png', null],
    ['file:%2FUsers/a/x.png', null],
    ['file:./x.png', null],
    ['file:////Users/a/x.png', null],
    ['file:/%2FUsers/a/x.png', null],
    ['', null],
  ];
  for (const [input, expected] of cases) assert.equal(fileUriToPath(input), expected, input);
  for (const input of [undefined, null, 7, {}, ['file:/Users/a.png']]) assert.equal(fileUriToPath(input), null);
});

test('xml-path helpers are pure: no filesystem module or access', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'parsers', 'xml-path.js'), 'utf8');
  assert.doesNotMatch(source, /require\(/);
  assert.doesNotMatch(source, /\bfs\b|process\.|statSync|existsSync|realpath/);
});
