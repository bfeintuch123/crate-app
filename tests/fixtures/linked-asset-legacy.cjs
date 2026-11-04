'use strict';

// Frozen independent oracle from 59fcc0d. Do not import the production matcher.
const LEGACY = /(?:\/Users\/|\/Volumes\/)[^\x00-\x1f\x22\x27]+?\.(jpg|jpeg|png|gif|webp|svg|pdf|eps|ai|psd|tiff|tif|afdesign|afphoto|afpub|indd|idml|sketch|fig|heic|ttf|otf|woff|woff2|mp4|mov|avi|webm)/gi;

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
