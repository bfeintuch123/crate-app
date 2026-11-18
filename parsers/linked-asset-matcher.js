'use strict';

const { constants: { MAX_STRING_LENGTH } } = require('node:buffer');

// Keep the legacy grammar, including leftmost/lazy matches, duplicates and
// extension ordering. Matching is independent of the exported regex's state.
// One deliberate amendment: woff2 is listed before woff so `.woff2` is read
// whole instead of being cut short to `.woff`.
const LINKED_ASSET_REGEX = /(?:\/Users\/|\/Volumes\/)[^\x00-\x1f\x22\x27]+?\.(jpg|jpeg|png|gif|webp|svg|pdf|eps|ai|psd|tiff|tif|afdesign|afphoto|afpub|indd|idml|sketch|fig|heic|ttf|otf|woff2|woff|mp4|mov|avi|webm)/gi;
const LINKED_ASSET_REGEX_SOURCE = LINKED_ASSET_REGEX.source;

function extractLinkedAssetPaths(content, filePath) {
  // Each invocation starts at index zero. Main previously created a local
  // regex; the parser utility process accepts one request before exiting.
  const prefix = /(?:\/Users\/|\/Volumes\/)/gi;
  const anchored = new RegExp(LINKED_ASSET_REGEX_SOURCE, 'giy');
  const delimiter = /[\x00-\x1f\x22\x27]/g;
  const results = [];
  let candidate;
  while ((candidate = prefix.exec(content)) !== null) {
    anchored.lastIndex = candidate.index;
    const match = anchored.exec(content);
    if (match) {
      if (match[0] !== filePath) results.push(match[0]);
      prefix.lastIndex = anchored.lastIndex;
    } else {
      // If a later prefix in this uninterrupted allowed-character run could
      // match, its ending would also satisfy this earliest prefix's body.
      // Failure therefore lets us skip this run without rescanning its suffixes.
      delimiter.lastIndex = candidate.index;
      const end = delimiter.exec(content);
      prefix.lastIndex = end ? end.index + 1 : content.length;
    }
  }
  return results;
}

const SLASH = 0x2f;
const USERS_PREFIX = Buffer.from('/users/', 'latin1');
const VOLUMES_PREFIX = Buffer.from('/volumes/', 'latin1');

// `prefix` is lowercase ASCII and `at` already holds its leading slash.
function hasPrefixAt(buffer, at, prefix) {
  if (at + prefix.length > buffer.length) return false;
  for (let i = 1; i < prefix.length; i++) {
    const byte = buffer[at + i];
    if ((byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte) !== prefix[i]) return false;
  }
  return true;
}

function isPathDelimiterByte(byte) {
  return byte <= 0x1f || byte === 0x22 || byte === 0x27;
}

// The text a linked-path search needs from a design file, without decoding the
// whole file. Every linked-path grammar starts at an ASCII /Users/ or /Volumes/
// and stops at a delimiter, and UTF-8 decoding never turns other bytes into
// ASCII or lets a broken sequence absorb one. Each run from a prefix to its
// delimiter therefore decodes to the same characters as in the whole-file text,
// and `\n`, itself a delimiter, keeps runs from joining into one match.
function linkedPathSearchText(buffer, maxStringLength = MAX_STRING_LENGTH) {
  // Past the string limit the whole-file decode decides the outcome, as before.
  if (!Buffer.isBuffer(buffer) || buffer.length > maxStringLength) return buffer.toString('utf8');
  const runs = [];
  let from = 0;
  while (true) {
    const at = buffer.indexOf(SLASH, from);
    if (at === -1) break;
    if (!hasPrefixAt(buffer, at, USERS_PREFIX) && !hasPrefixAt(buffer, at, VOLUMES_PREFIX)) { from = at + 1; continue; }
    let end = at + 1;
    while (end < buffer.length && !isPathDelimiterByte(buffer[end])) end++;
    runs.push(buffer.subarray(at, end).toString('utf8'));
    from = end + 1;
  }
  return runs.join('\n');
}

// Reached through the matcher so that everything already holding it shares one
// implementation, including code evaluated apart from main.js's imports.
extractLinkedAssetPaths.searchText = linkedPathSearchText;

module.exports = { LINKED_ASSET_REGEX, extractLinkedAssetPaths };
