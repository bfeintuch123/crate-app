'use strict';

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

module.exports = { LINKED_ASSET_REGEX, extractLinkedAssetPaths };
