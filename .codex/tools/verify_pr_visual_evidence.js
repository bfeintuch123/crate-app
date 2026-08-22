'use strict';

const fs = require('node:fs');
const path = require('node:path');
const contract = require('./visual_evidence_contract');
const publisher = require('./publish_visual_evidence');

const MAX_EVENT_BYTES = 1024 * 1024;
const HEADER = '## Visual Evidence';
const REQUIRED_REPOSITORY = 'bfeintuch123/crate-app';
const REQUIRED_REPOSITORY_ID = '1165820261';
const REQUIRED_BASE = 'v2.4.x';
const NOT_APPLICABLE = 'not applicable';
const FIELD_NAMES = Object.freeze([
  'UI impact',
  'Candidate commit',
  'Rationale',
  'Scenario',
  'Expected',
  'Observed',
  'Fixture class',
  'Capture environment',
  'Media inspection',
  'Privacy review',
  'Media filename',
  'Media type',
  'Media bytes',
  'Media SHA-256',
  'Collection path',
  'Crabbox collection',
  'Durable artifact URL',
]);
const MEDIA_FIELD_NAMES = Object.freeze(FIELD_NAMES.slice(3));

function fail(code) {
  throw new Error(code);
}

function exactKeys(value, expected, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) fail(code);
}

function placeholder(value) {
  return typeof value !== 'string' || value.length === 0 ||
    /^(?:not applicable|n\/a|none|todo|tbd)$/i.test(value) ||
    /<[^>]+>/.test(value);
}

function safePublicText(value, code, max = 500) {
  if (placeholder(value) || value.length > max || value.normalize('NFC') !== value) fail(code);
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value)) fail(code);
  if (/(?:https?:\/\/|file:\/\/|(?:^|\s)\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+|(?:^|\s)[A-Za-z]:\\|\\Users\\|(?:^|\s)(?:gh[opurs]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}))/i.test(value)) fail(code);
  return value;
}

function parseEvidenceSection(body) {
  if (typeof body !== 'string' || body.length === 0 || Buffer.byteLength(body, 'utf8') > MAX_EVENT_BYTES) {
    fail('visual_evidence_section_required');
  }
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const headers = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === HEADER) headers.push(index);
  }
  if (headers.length !== 1) fail(headers.length === 0 ? 'visual_evidence_section_required' : 'duplicate_visual_evidence_section');
  const fields = {};
  const bareUrls = [];
  for (let index = headers[0] + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##\s+/.test(line)) break;
    if (line === '') continue;
    const field = line.match(/^- ([A-Za-z0-9][A-Za-z0-9 -]*):\s*(.*?)\s*$/);
    if (field) {
      if (!FIELD_NAMES.includes(field[1])) fail('unexpected_visual_evidence_content');
      if (Object.hasOwn(fields, field[1])) fail('duplicate_visual_evidence_field');
      fields[field[1]] = field[2];
      continue;
    }
    if (/^https:\/\/github\.com\/user-attachments\/assets\/[A-Za-z0-9-]+$/.test(line)) {
      bareUrls.push(line);
      continue;
    }
    fail('unexpected_visual_evidence_content');
  }
  return { fields, bareUrls };
}

function parsePositiveInteger(value, code, max = Number.MAX_SAFE_INTEGER) {
  if (!/^[1-9]\d*$/.test(value)) fail(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > max) fail(code);
  return parsed;
}

function parseCrabboxCollection(value) {
  if (value === 'not-used') return null;
  const entries = {};
  for (const part of value.split(';')) {
    const match = part.trim().match(/^([a-z0-9-]+)=(\S+)$/);
    if (!match || Object.hasOwn(entries, match[1])) fail('invalid_crabbox_pr_evidence');
    entries[match[1]] = match[2];
  }
  exactKeys(entries, ['provider', 'lease', 'run', 'archive', 'archive-bytes', 'archive-sha256', 'cleanup'], 'invalid_crabbox_pr_evidence');
  const collection = {
    provider: entries.provider,
    leaseId: entries.lease,
    runId: entries.run,
    archive: entries.archive,
    archiveBytes: parsePositiveInteger(entries['archive-bytes'], 'invalid_crabbox_pr_evidence'),
    archiveSha256: entries['archive-sha256'],
    cleanup: entries.cleanup,
    durableArtifactUrl: '',
  };
  try {
    contract.validateCrabboxCollection(collection);
  } catch {
    fail('invalid_crabbox_pr_evidence');
  }
  return collection;
}

function validateMediaFields(fields, bareUrls, impact) {
  safePublicText(fields.Scenario, 'invalid_visual_evidence_text');
  safePublicText(fields.Expected, 'invalid_visual_evidence_text');
  safePublicText(fields.Observed, 'invalid_visual_evidence_text');
  safePublicText(fields['Capture environment'], 'invalid_visual_evidence_text');
  if (!['synthetic', 'explicitly-approved-test-safe'].includes(fields['Fixture class'])) fail('invalid_fixture_class');
  if (fields['Media inspection'] !== 'PASS') fail('media_inspection_required');
  if (fields['Privacy review'] !== 'PASS') fail('privacy_review_required');
  let name;
  try { name = contract.safeName(fields['Media filename']); } catch { fail('invalid_media_name'); }
  const mime = fields['Media type'];
  if (impact === 'stateful' && !['video/mp4', 'video/webm'].includes(mime)) fail('stateful_video_required');
  if (impact === 'static' && mime !== 'image/png') fail('static_image_required');
  if (contract.MIME_EXTENSIONS[mime] !== path.extname(name).toLowerCase()) fail('media_extension_mismatch');
  const bytes = parsePositiveInteger(fields['Media bytes'], 'invalid_media_bytes', contract.MAX_MEDIA_BYTES);
  const sha256 = fields['Media SHA-256'];
  if (!/^[0-9a-f]{64}$/.test(sha256)) fail('invalid_media_hash');
  const collectionPath = fields['Collection path'];
  if (!['local', 'crabbox-artifact'].includes(collectionPath)) fail('invalid_collection_path');
  const collection = parseCrabboxCollection(fields['Crabbox collection']);
  if ((collectionPath === 'crabbox-artifact') !== (collection !== null)) fail('crabbox_collection_path_mismatch');
  let url;
  try { url = contract.safeURL(fields['Durable artifact URL']); } catch { fail('invalid_durable_artifact_url'); }
  if (bareUrls.length !== 1 || bareUrls[0] !== url) fail('bare_artifact_url_mismatch');
  return { impact, media: { name, mime, bytes, sha256 }, url, crabbox: collection !== null };
}

function validateEvent(event) {
  if (!event.repository || typeof event.repository !== 'object' || Array.isArray(event.repository)) fail('invalid_repository_event');
  if (event.repository.full_name !== REQUIRED_REPOSITORY || String(event.repository.id) !== REQUIRED_REPOSITORY_ID) fail('repository_identity_mismatch');
  if (!event.pull_request || typeof event.pull_request !== 'object') fail('pull_request_event_required');
  if (!event.pull_request.base || event.pull_request.base.ref !== REQUIRED_BASE || !event.pull_request.base.repo ||
      event.pull_request.base.repo.full_name !== REQUIRED_REPOSITORY || String(event.pull_request.base.repo.id) !== REQUIRED_REPOSITORY_ID) fail('invalid_base_branch');
  const headSha = event.pull_request.head && event.pull_request.head.sha;
  if (!/^[0-9a-f]{40}$/.test(headSha || '')) fail('invalid_head_sha');
  const { fields, bareUrls } = parseEvidenceSection(event.pull_request.body);
  for (const name of FIELD_NAMES) {
    if (!Object.hasOwn(fields, name)) fail('missing_visual_evidence_field');
  }
  const impact = fields['UI impact'];
  if (!['stateful', 'static', 'none'].includes(impact)) fail('invalid_ui_impact');
  if (fields['Candidate commit'] !== headSha) fail('stale_visual_evidence_commit');
  if (impact === 'none') {
    const rationale = safePublicText(fields.Rationale, 'ui_impact_rationale_required');
    if (rationale.length < 40 || rationale.trim().split(/\s+/).length < 6) fail('ui_impact_rationale_required');
    for (const name of MEDIA_FIELD_NAMES) {
      if (fields[name] !== NOT_APPLICABLE) fail('unexpected_no_impact_evidence');
    }
    if (bareUrls.length !== 0) fail('unexpected_visual_evidence_url');
    return { impact, headSha };
  }
  if (fields.Rationale !== NOT_APPLICABLE) fail('invalid_visual_evidence_rationale');
  return { ...validateMediaFields(fields, bareUrls, impact), headSha };
}

function readEvent(file) {
  const resolved = path.resolve(file);
  let descriptor;
  try {
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_EVENT_BYTES) fail('invalid_event_file');
    const bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) fail('invalid_event_file');
      offset += count;
    }
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error && /^[a-z0-9_]+$/.test(error.message)) throw error;
    fail('invalid_event_file');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function main(argv = process.argv.slice(2), dependencies = {}) {
  if (argv.length !== 1) fail('event_path_required');
  const result = validateEvent(readEvent(argv[0]));
  if (result.media) (dependencies.readback || publisher.readback)(result.url, result.media);
  process.stdout.write(`Crate PR visual evidence passed: impact=${result.impact} head=${result.headSha}\n`);
  return result;
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(`Crate PR visual evidence failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { FIELD_NAMES, MAX_EVENT_BYTES, main, parseCrabboxCollection, parseEvidenceSection, readEvent, validateEvent };
