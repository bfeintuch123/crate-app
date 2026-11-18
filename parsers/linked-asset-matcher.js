'use strict';

const { constants: { MAX_STRING_LENGTH }, isUtf8 } = require('node:buffer');

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
const NEARBY_BYTES = 32;
const USERS_PREFIX = Buffer.from('/users/', 'latin1');
const VOLUMES_PREFIX = Buffer.from('/volumes/', 'latin1');

// Budgets for building the reduced text from bytes that are not valid UTF-8.
// Past any of them the input is dense enough that the whole-file decode is the
// cheaper route, so it is used instead. Random binary data has one slash per 256
// bytes; twice that density is where examining slashes stops paying for itself.
const MIN_SLASH_MISSES = 4096;
const BYTES_PER_SLASH_MISS = 128;
// Slash-dense data gives up early instead of spending the whole budget first:
// misses may run ahead of that density only by this share of the file.
const BYTES_PER_SLASH_MISS_HEADROOM = 1024;
// Each kept run is its own string, which is what costs memory on dense input.
const MAX_KEPT_RUNS = 4096;
const MIN_RUN_BYTES = 64 * 1024;
const BYTES_PER_RUN_BYTE = 32;

// `prefix` is lowercase ASCII and `at` already holds its leading slash.
function hasPrefixAt(buffer, at, prefix) {
  if (at + prefix.length > buffer.length) return false;
  for (let i = 1; i < prefix.length; i++) {
    const byte = buffer[at + i];
    if ((byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte) !== prefix[i]) return false;
  }
  return true;
}

function isPathPrefixAt(buffer, at) {
  const next = buffer[at + 1] | 0x20;
  return (next === 0x75 && hasPrefixAt(buffer, at, USERS_PREFIX)) ||
    (next === 0x76 && hasPrefixAt(buffer, at, VOLUMES_PREFIX));
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
// The options exist for tests; callers use the defaults.
function linkedPathSearchText(buffer, options = {}) {
  const { maxStringLength = MAX_STRING_LENGTH, isValidUtf8 = isUtf8 } = options;
  // Past the string limit the whole-file decode decides the outcome, as before.
  if (!Buffer.isBuffer(buffer) || buffer.length > maxStringLength) return buffer.toString('utf8');
  // Decoding valid UTF-8 is cheap; the cost this avoids comes from invalid bytes.
  if (typeof isValidUtf8 === 'function' && isValidUtf8(buffer)) return buffer.toString('utf8');
  const {
    maxSlashMisses = Math.max(MIN_SLASH_MISSES, Math.floor(buffer.length / BYTES_PER_SLASH_MISS)),
    slashMissHeadroom = Math.max(MIN_SLASH_MISSES, Math.floor(buffer.length / BYTES_PER_SLASH_MISS_HEADROOM)),
    maxRuns = MAX_KEPT_RUNS,
    maxRunBytes = Math.max(MIN_RUN_BYTES, Math.floor(buffer.length / BYTES_PER_RUN_BYTE)),
  } = options;
  const runs = [];
  // The kept strings are released before the larger decode begins.
  const decodeWholeBuffer = () => { runs.length = 0; return buffer.toString('utf8'); };
  let slashMisses = 0, runBytes = 0;
  let at = buffer.indexOf(SLASH, 0);
  while (at !== -1) {
    if (isPathPrefixAt(buffer, at)) {
      if (runs.length >= maxRuns) return decodeWholeBuffer();
      // Stops one byte past the budget, so an endless run is not walked to its end.
      const scanEnd = Math.min(buffer.length, at + (maxRunBytes - runBytes) + 1);
      let end = at + 1;
      while (end < scanEnd && !isPathDelimiterByte(buffer[end])) end++;
      runBytes += end - at;
      if (runBytes > maxRunBytes) return decodeWholeBuffer();
      runs.push(buffer.subarray(at, end).toString('utf8'));
      at = buffer.indexOf(SLASH, end + 1);
    } else {
      slashMisses++;
      if (slashMisses > maxSlashMisses || slashMisses > slashMissHeadroom + at / BYTES_PER_SLASH_MISS) return decodeWholeBuffer();
      // Slashes cluster in design data: look a short way ahead before another native search.
      const nearbyEnd = Math.min(at + NEARBY_BYTES, buffer.length);
      let next = at + 1;
      while (next < nearbyEnd && buffer[next] !== SLASH) next++;
      at = next < nearbyEnd ? next : buffer.indexOf(SLASH, next);
    }
  }
  return runs.join('\n');
}

// Reached through the matcher so that everything already holding it shares one
// implementation, including code evaluated apart from main.js's imports.
extractLinkedAssetPaths.searchText = linkedPathSearchText;

module.exports = { LINKED_ASSET_REGEX, extractLinkedAssetPaths };
