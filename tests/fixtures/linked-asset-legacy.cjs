'use strict';

// Frozen independent oracle from 59fcc0d. Do not import the production matcher.
// One deliberate amendment (link-matcher parity): `woff2|woff` replaces
// `woff|woff2`, so `.woff2` is no longer cut short to `.woff`. Nothing else
// in this grammar has changed.
const LEGACY = /(?:\/Users\/|\/Volumes\/)[^\x00-\x1f\x22\x27]+?\.(jpg|jpeg|png|gif|webp|svg|pdf|eps|ai|psd|tiff|tif|afdesign|afphoto|afpub|indd|idml|sketch|fig|heic|ttf|otf|woff2|woff|mp4|mov|avi|webm)/gi;

function legacyPaths(buffer, filePath) {
  const regex = new RegExp(LEGACY.source, LEGACY.flags);
  const content = buffer.toString('utf8');
  const results = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    if (match[0] !== filePath) results.push(match[0]);
  }
  return results;
}

module.exports = { legacyPaths, source: LEGACY.source, flags: LEGACY.flags };
