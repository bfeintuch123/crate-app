'use strict';

/**
 * Crate Companion Push Plugin (Adobe UXP v5 Scaffold)
 *
 * Emits structured NDJSON events (`document-opened`, `document-saved`,
 * `document-closed`, `links-updated`, `dirty-state`) to Crate's owner-only
 * Unix domain socket (`crate-adobe-push.sock`) authenticated via the local
 * `crate-adobe-push.json` session descriptor.
 *
 * When installed in Photoshop or InDesign, Crate receives save & linked-asset
 * updates in <1 ms instead of polling via AppleScript.
 */

function buildPushPayload({ token, appFamily, event, documentPath, linkedPaths = [], dirty = null }) {
  return `${JSON.stringify({
    token,
    appFamily,
    event,
    documentPath,
    linkedPaths,
    dirty,
    timestamp: Date.now(),
  })}\n`;
}

module.exports = {
  buildPushPayload,
};
