'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const MIME_EXTENSIONS = Object.freeze({
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'image/png': '.png',
});
const MANIFEST_KEYS = Object.freeze([
  'schema', 'repository', 'pullRequest', 'media', 'scenario', 'expected',
  'observed', 'captureEnvironment', 'mediaInspection', 'privacyReview',
  'uploadPath', 'url', 'crabbox',
]);

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

function exactKeys(value, expected, code) {
  assert(value && typeof value === 'object' && !Array.isArray(value), code);
  assert(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()), code);
}

function safeText(value, code, max = 500) {
  assert(typeof value === 'string' && value.length > 0 && value.length <= max, code);
  assert(!/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value), code);
  assert(!/(?:https?:\/\/|file:\/\/|(?:^|\s)\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+|(?:^|\s)[A-Za-z]:\\|\\Users\\|(?:^|\s)(?:gh[opurs]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}))/i.test(value), code);
  return value;
}

function safeName(value) {
  safeText(value, 'unsafe_media_name', 120);
  assert(path.basename(value) === value && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value), 'unsafe_media_name');
  return value;
}

function inspectDescriptor(descriptor, options = {}) {
  const metadata = fs.fstatSync(descriptor);
  assert(metadata.isFile(), options.regularCode || 'media_not_regular');
  const hash = crypto.createHash('sha256');
  const prefix = Buffer.alloc(12);
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (true) {
    const read = fs.readSync(descriptor, buffer, 0, buffer.length, offset);
    if (read === 0) break;
    if (offset < prefix.length) buffer.copy(prefix, offset, 0, Math.min(read, prefix.length - offset));
    hash.update(buffer.subarray(0, read));
    offset += read;
  }
  return { bytes: metadata.size, sha256: hash.digest('hex'), prefix: prefix.subarray(0, Math.min(metadata.size, prefix.length)) };
}

function inspectFile(file, regularCode = 'media_not_regular') {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    return inspectDescriptor(descriptor, { regularCode });
  } catch (error) {
    if (error && error.message === regularCode) throw error;
    throw new Error(regularCode);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function sha256File(file) {
  return inspectFile(file).sha256;
}

function inspectMedia(file, mime) {
  assert(Object.hasOwn(MIME_EXTENSIONS, mime), 'unsupported_media_type');
  assert(typeof file === 'string' && file.length > 0 && !/[\u0000-\u001f\u007f]/u.test(file), 'unsafe_media_path');
  const name = safeName(path.basename(file));
  assert(path.extname(name).toLowerCase() === MIME_EXTENSIONS[mime], 'media_extension_mismatch');
  try {
    const resolvedParent = path.resolve(path.dirname(file));
    assert(fs.realpathSync(resolvedParent) === resolvedParent, 'unsafe_media_path');
    const metadata = fs.lstatSync(file);
    assert(metadata.isFile() && !metadata.isSymbolicLink(), 'media_not_regular');
  } catch (error) {
    if (error.message === 'unsafe_media_path') throw error;
    throw new Error('media_not_regular');
  }
  const inspected = inspectFile(file);
  assert(inspected.bytes > 0 && inspected.bytes <= MAX_MEDIA_BYTES, 'media_size_invalid');
  const signature = inspected.prefix;
  const signatureMatches =
    (mime === 'image/png' && signature.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) ||
    (mime === 'video/webm' && signature.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'))) ||
    (mime === 'video/mp4' && signature.length >= 8 && signature.subarray(4, 8).toString('ascii') === 'ftyp');
  assert(signatureMatches, 'media_content_mismatch');
  return { name, mime, bytes: inspected.bytes, sha256: inspected.sha256 };
}

function safeURL(value, allowEmpty = false) {
  if (allowEmpty && value === '') return '';
  assert(typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value), 'unsafe_url');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('unsafe_url'); }
  assert(parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash, 'unsafe_url');
  assert(parsed.hostname === 'github.com', 'unapproved_url_host');
  assert(/^\/user-attachments\/assets\/[A-Za-z0-9-]+$/.test(parsed.pathname), 'unsafe_url_path');
  return parsed.toString();
}

function buildManifest(input) {
  assert(/^\d+$/.test(String(input.repositoryId)), 'invalid_repository_id');
  assert(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(input.repository) && !input.repository.includes('..'), 'invalid_repository');
  assert(Number.isSafeInteger(input.prNumber) && input.prNumber > 0, 'invalid_pr_number');
  assert(/^[0-9a-f]{40}$/.test(input.headSha), 'invalid_head_sha');
  assert(input.mediaInspection === 'PASS', 'media_inspection_required');
  assert(input.privacyReview === 'PASS', 'privacy_review_required');
  assert(['github-user-attachment', 'crabbox-artifact'].includes(input.uploadPath), 'invalid_upload_path');
  const crabbox = input.crabbox === undefined ? null : input.crabbox;
  if (crabbox !== null) {
    validateCrabboxCollection(crabbox);
  }
  const manifest = {
    schema: 'crate.visual-evidence.v1',
    repository: { nameWithOwner: input.repository, databaseId: Number(input.repositoryId) },
    pullRequest: { number: input.prNumber, headSha: input.headSha },
    media: { name: safeName(input.media.name), mime: input.media.mime, bytes: input.media.bytes, sha256: input.media.sha256 },
    scenario: safeText(input.scenario, 'invalid_scenario'),
    expected: safeText(input.expected, 'invalid_expected'),
    observed: safeText(input.observed, 'invalid_observed'),
    captureEnvironment: safeText(input.captureEnvironment, 'invalid_capture_environment'),
    mediaInspection: input.mediaInspection,
    privacyReview: input.privacyReview,
    uploadPath: input.uploadPath,
    url: safeURL(input.url || '', true),
    crabbox,
  };
  validateManifest(manifest);
  return manifest;
}

function validateCrabboxCollection(value) {
  exactKeys(value, ['provider', 'leaseId', 'runId', 'archive', 'archiveBytes', 'archiveSha256', 'cleanup', 'durableArtifactUrl'], 'invalid_crabbox_collection');
  assert(value.provider === 'apple-vm', 'invalid_crabbox_provider');
  assert(/^cbx_[0-9a-f]+$/.test(value.leaseId), 'invalid_crabbox_lease');
  assert(/^run_[0-9a-f]+$/.test(value.runId), 'invalid_crabbox_run');
  assert(typeof value.archive === 'string' && value.archive === `${value.runId}-artifacts.tgz` && path.basename(value.archive) === value.archive && !/[\u0000-\u001f\u007f]/u.test(value.archive), 'invalid_crabbox_archive');
  assert(Number.isSafeInteger(value.archiveBytes) && value.archiveBytes > 0, 'invalid_crabbox_archive');
  assert(/^[0-9a-f]{64}$/.test(value.archiveSha256), 'invalid_crabbox_archive');
  assert(value.cleanup === 'PASS', 'crabbox_cleanup_required');
  assert(value.durableArtifactUrl === '', 'durable_crabbox_backend_unapproved');
  return value;
}

function validateManifest(manifest) {
  exactKeys(manifest, MANIFEST_KEYS, 'invalid_manifest_keys');
  assert(manifest.schema === 'crate.visual-evidence.v1', 'invalid_manifest_schema');
  exactKeys(manifest.repository, ['nameWithOwner', 'databaseId'], 'invalid_repository_binding');
  exactKeys(manifest.pullRequest, ['number', 'headSha'], 'invalid_pr_binding');
  exactKeys(manifest.media, ['name', 'mime', 'bytes', 'sha256'], 'invalid_media_binding');
  assert(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(manifest.repository.nameWithOwner) && !manifest.repository.nameWithOwner.includes('..'), 'invalid_repository_binding');
  assert(Number.isSafeInteger(manifest.repository.databaseId) && manifest.repository.databaseId > 0, 'invalid_repository_binding');
  assert(Number.isSafeInteger(manifest.pullRequest.number) && manifest.pullRequest.number > 0, 'invalid_pr_binding');
  assert(/^[0-9a-f]{40}$/.test(manifest.pullRequest.headSha), 'invalid_pr_binding');
  assert(/^[0-9a-f]{64}$/.test(manifest.media.sha256), 'invalid_media_hash');
  assert(Number.isSafeInteger(manifest.media.bytes) && manifest.media.bytes > 0 && manifest.media.bytes <= MAX_MEDIA_BYTES, 'media_size_invalid');
  safeName(manifest.media.name);
  assert(MIME_EXTENSIONS[manifest.media.mime] === path.extname(manifest.media.name).toLowerCase(), 'media_extension_mismatch');
  safeText(manifest.scenario, 'invalid_scenario');
  safeText(manifest.expected, 'invalid_expected');
  safeText(manifest.observed, 'invalid_observed');
  safeText(manifest.captureEnvironment, 'invalid_capture_environment');
  assert(manifest.mediaInspection === 'PASS', 'media_inspection_required');
  assert(manifest.privacyReview === 'PASS', 'privacy_review_required');
  assert(['github-user-attachment', 'crabbox-artifact'].includes(manifest.uploadPath), 'invalid_upload_path');
  safeURL(manifest.url || '', true);
  if (manifest.crabbox !== null) {
    assert(manifest.uploadPath === 'crabbox-artifact' && manifest.url === '', 'invalid_crabbox_evidence');
    validateCrabboxCollection(manifest.crabbox);
  }
  return manifest;
}

function validateUploadResponse(status, headers, body) {
  assert(status === 201, 'upload_http_failure');
  assert(!headers.location, 'upload_redirect_rejected');
  let value;
  try { value = JSON.parse(body); } catch { throw new Error('upload_response_invalid'); }
  exactKeys(value, ['url'], 'upload_response_invalid');
  safeURL(value.url);
  return value;
}

function safeReadbackRedirect(value) {
  assert(typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value), 'unsafe_readback_redirect');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('unsafe_readback_redirect'); }
  assert(parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash, 'unsafe_readback_redirect');
  assert(/^github-production-user-asset-\d+\.s3\.amazonaws\.com$/.test(parsed.hostname), 'unapproved_readback_host');
  assert(/^\/\d+\/\d+-[A-Za-z0-9-]+(?:\.[A-Za-z0-9]+)?$/.test(parsed.pathname), 'unsafe_readback_redirect');
  const keys = [...parsed.searchParams.keys()];
  const required = ['X-Amz-Algorithm', 'X-Amz-Credential', 'X-Amz-Date', 'X-Amz-Expires', 'X-Amz-Signature', 'X-Amz-SignedHeaders'];
  const allowed = new Set([...required, 'response-content-disposition', 'response-content-type']);
  assert(required.every(key => parsed.searchParams.has(key)) && keys.every(key => allowed.has(key)), 'unsafe_readback_redirect');
  assert(!/["\\\u0000-\u001f\u007f]/u.test(parsed.toString()), 'unsafe_readback_redirect');
  return parsed.toString();
}

function validateReadback(expected, status, redirect, bytes, sha256) {
  assert(status === 200 && redirect === '', 'readback_unavailable');
  assert(bytes === expected.bytes, 'readback_size_mismatch');
  assert(sha256 === expected.sha256, 'readback_hash_mismatch');
}

module.exports = {
  MAX_MEDIA_BYTES, MIME_EXTENSIONS, buildManifest, inspectDescriptor, inspectFile, inspectMedia, safeName, safeReadbackRedirect, safeURL,
  sha256File, validateCrabboxCollection, validateManifest, validateReadback,
  validateUploadResponse,
};
