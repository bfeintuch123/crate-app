'use strict';

const { constants: { MAX_STRING_LENGTH }, isUtf8 } = require('node:buffer');
const { performance } = require('node:perf_hooks');

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

// Budgets for building the reduced text from bytes that are not valid UTF-8.
// Past any of them the whole-file decode is the cheaper route, so it is used
// instead. A miss is an s/ or S/ pair that does not end a prefix (the names
// keep their earlier "slash" wording; the limits are unchanged).
const MIN_SLASH_MISSES = 4096;
const BYTES_PER_SLASH_MISS = 128;
// Miss-dense data gives up early instead of spending the whole budget first:
// misses may run ahead of that density only by this share of the file.
const BYTES_PER_SLASH_MISS_HEADROOM = 1024;
// The native pair searches cost more on some byte values than on others, and
// none of that work is a miss. They run in windows. After each window its
// search time, less an allowance per byte it covered, is added to a debt that
// never goes below zero; past the headroom the whole-file decode is used.
// Unspent allowance does not carry forward. A stretch far above the allowance
// is caught within a few windows wherever it starts; one only slightly above it
// builds the debt slowly and can run far into the file first. Only time inside
// the searches counts: run collection and misses are bounded by the budgets above.
const WINDOW_BYTES = 256 * 1024;
const SCAN_TIME_HEADROOM_MS = 4;
const SCAN_NS_PER_BYTE = 0.5;
const defaultNow = () => performance.now();
// Each kept run is its own string, which is what costs memory on dense input.
const MAX_KEPT_RUNS = 4096;
const MIN_RUN_BYTES = 64 * 1024;
const BYTES_PER_RUN_BYTE = 32;
// Blank padding after the runs. V8 tunes a regex's compiled code to characters
// it samples from the middle of the text it compiles on, and every regex with
// the same source and flags shares that code. Compiled on a text made only of
// paths, the shared code searched later long texts slower on Node 22. Padding
// longer than the runs puts that sample in the blanks. It cannot match: every
// grammar starts at /Users/ or /Volumes/, and the newline before it ends the
// last run as it ends the others. Results and their order are unchanged.
const SAMPLE_CHARS = 128;
const MAX_PADDED_RUN_CHARS = 1024 * 1024;

// `prefix` is lowercase ASCII and `at` already holds its leading slash.
function hasPrefixAt(buffer, at, prefix) {
  if (at + prefix.length > buffer.length) return false;
  for (let i = 1; i < prefix.length; i++) {
    const byte = buffer[at + i];
    if ((byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte) !== prefix[i]) return false;
  }
  return true;
}

const LOWER_TAIL = Buffer.from('s/', 'latin1');
const UPPER_TAIL = Buffer.from('S/', 'latin1');

// The start of the prefix whose closing s/ is at `tail`, or -1.
function prefixStartForTail(buffer, tail) {
  let at = tail - (VOLUMES_PREFIX.length - 2);
  if (at >= 0 && buffer[at] === SLASH && hasPrefixAt(buffer, at, VOLUMES_PREFIX)) return at;
  at = tail - (USERS_PREFIX.length - 2);
  if (at >= 0 && buffer[at] === SLASH && hasPrefixAt(buffer, at, USERS_PREFIX)) return at;
  return -1;
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
// Blank padding follows the runs (see SAMPLE_CHARS).
// The options exist for tests; callers use the defaults.
function linkedPathSearchText(buffer, options = {}) {
  const { maxStringLength = MAX_STRING_LENGTH, isValidUtf8 = isUtf8 } = options;
  // Past the string limit the whole-file decode decides the outcome, as before.
  // A non-view value takes the old decode before any prototype lookup on it.
  if (!ArrayBuffer.isView(buffer) || !Buffer.isBuffer(buffer) || buffer.length > maxStringLength) return buffer.toString('utf8');
  // Decoding valid UTF-8 is cheap; the cost this avoids comes from invalid bytes.
  if (typeof isValidUtf8 === 'function' && isValidUtf8(buffer)) return buffer.toString('utf8');
  const {
    maxSlashMisses = Math.max(MIN_SLASH_MISSES, Math.floor(buffer.length / BYTES_PER_SLASH_MISS)),
    slashMissHeadroom = Math.max(MIN_SLASH_MISSES, Math.floor(buffer.length / BYTES_PER_SLASH_MISS_HEADROOM)),
    maxRuns = MAX_KEPT_RUNS,
    maxRunBytes = Math.max(MIN_RUN_BYTES, Math.floor(buffer.length / BYTES_PER_RUN_BYTE)),
    keptRuns: runs = [],
    maxPaddedRunChars = MAX_PADDED_RUN_CHARS,
    windowBytes = WINDOW_BYTES,
    scanTimeHeadroomMs = SCAN_TIME_HEADROOM_MS,
    scanNsPerByte = SCAN_NS_PER_BYTE,
    now = defaultNow,
  } = options;
  // The kept strings are released before the larger decode begins.
  const decodeWholeBuffer = () => { runs.length = 0; return buffer.toString('utf8'); };
  let slashMisses = 0, runBytes = 0, runFrom = 0, cursor = 0;
  // Every prefix ends in s/ or S/: a native search finds those pairs, and each
  // is checked backwards for the prefix it would end. A pair without a prefix
  // is a miss. A prefix that would start before `runFrom` overlaps the last run.
  // Searches cover pairs starting before `windowEnd`; the view's extra byte lets
  // a pair that starts on the window's last byte be found in that window.
  // Windows follow the bytes actually present.
  const size = buffer.byteLength;
  const windowSize = Number.isFinite(windowBytes) && windowBytes >= 1 ? Math.floor(windowBytes) : WINDOW_BYTES;
  let windowStart = 0, windowEnd = Math.min(size, windowSize), windowSearchMs = 0, debtMs = 0;
  let view = buffer.subarray(0, Math.min(size, windowEnd + 1));
  const needles = [{ bytes: LOWER_TAIL, pos: -1, clear: 0 }, { bytes: UPPER_TAIL, pos: -1, clear: 0 }];
  // A needle's first occurrence at or after `cursor` that starts before
  // `windowEnd`, or -1 for none in this window (a later window may hold one).
  // No pair start before `clear` is an occurrence other than `pos`, so no pair
  // start is searched twice.
  const next = needle => {
    if (needle.pos >= cursor) return needle.pos;
    const start = Math.max(cursor, needle.clear);
    if (start >= windowEnd) return -1;
    const started = now();
    const found = view.indexOf(needle.bytes, start);
    windowSearchMs += now() - started;
    needle.pos = found;
    needle.clear = found === -1 ? windowEnd : found;
    return found;
  };
  for (;;) {
    const lower = next(needles[0]), upper = next(needles[1]);
    if (lower === -1 && upper === -1) {
      // Nothing is left to search: the scan is complete.
      if (windowEnd >= size || cursor >= size) break;
      debtMs = Math.max(0, debtMs + windowSearchMs - (windowEnd - windowStart) * scanNsPerByte / 1e6);
      if (debtMs > scanTimeHeadroomMs) return decodeWholeBuffer();
      windowSearchMs = 0;
      windowStart = Math.max(windowEnd, cursor);
      windowEnd = Math.min(size, windowStart + windowSize);
      view = buffer.subarray(0, Math.min(size, windowEnd + 1));
      continue;
    }
    const tail = upper === -1 || (lower !== -1 && lower < upper) ? lower : upper;
    const at = prefixStartForTail(buffer, tail);
    if (at >= runFrom) {
      if (runs.length >= maxRuns) return decodeWholeBuffer();
      // Stops one byte past the budget, so an endless run is not walked to its end.
      const scanEnd = Math.min(buffer.length, at + (maxRunBytes - runBytes) + 1);
      let end = at + 1;
      while (end < scanEnd && !isPathDelimiterByte(buffer[end])) end++;
      runBytes += end - at;
      if (runBytes > maxRunBytes) return decodeWholeBuffer();
      runs.push(buffer.subarray(at, end).toString('utf8'));
      runFrom = cursor = end + 1;
    } else {
      slashMisses++;
      if (slashMisses > maxSlashMisses || slashMisses > slashMissHeadroom + tail / BYTES_PER_SLASH_MISS) return decodeWholeBuffer();
      // A pair cannot overlap itself or the other needle, so the next starts two bytes on.
      cursor = tail + 2;
    }
  }
  if (runs.length === 0) return '';
  const text = runs.join('\n');
  if (text.length > maxPaddedRunChars) return text;
  return `${text}\n${' '.repeat(text.length + SAMPLE_CHARS)}`;
}

// Reached through the matcher so that everything already holding it shares one
// implementation, including code evaluated apart from main.js's imports.
extractLinkedAssetPaths.searchText = linkedPathSearchText;

module.exports = { LINKED_ASSET_REGEX, extractLinkedAssetPaths };
