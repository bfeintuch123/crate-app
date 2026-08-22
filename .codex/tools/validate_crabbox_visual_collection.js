#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const contract = require('./visual_evidence_contract');

function fail(code) { throw new Error(code); }

function readJSONFileNoFollow(file, code) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > 1024 * 1024) fail(code);
    const body = Buffer.alloc(metadata.size);
    if (fs.readSync(descriptor, body, 0, body.length, 0) !== body.length) fail(code);
    return JSON.parse(body.toString('utf8'));
  } catch (error) {
    if (error && error.message === code) throw error;
    fail(code);
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function validateBundle(bundleDirectory, collection) {
  contract.validateCrabboxCollection(collection);
  let metadata;
  try { metadata = fs.lstatSync(bundleDirectory); } catch { fail('missing_crabbox_artifact'); }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || fs.realpathSync(bundleDirectory) !== path.resolve(bundleDirectory)) fail('invalid_crabbox_artifact');
  const top = fs.readdirSync(bundleDirectory).sort();
  if (JSON.stringify(top) !== JSON.stringify(['media', 'visual-evidence.json'])) fail('unexpected_crabbox_artifact');
  const mediaDirectory = path.join(bundleDirectory, 'media');
  const mediaMetadata = fs.lstatSync(mediaDirectory);
  if (!mediaMetadata.isDirectory() || mediaMetadata.isSymbolicLink()) fail('invalid_crabbox_artifact');
  const mediaEntries = fs.readdirSync(mediaDirectory);
  if (mediaEntries.length !== 1) fail(mediaEntries.length === 0 ? 'missing_crabbox_artifact' : 'duplicate_crabbox_artifact');
  const manifest = readJSONFileNoFollow(path.join(bundleDirectory, 'visual-evidence.json'), 'invalid_crabbox_manifest');
  contract.validateManifest(manifest);
  if (manifest.uploadPath !== 'crabbox-artifact' || manifest.url !== '' || manifest.crabbox !== null) fail('invalid_crabbox_manifest');
  const media = contract.inspectMedia(path.join(mediaDirectory, mediaEntries[0]), manifest.media.mime);
  if (media.name !== manifest.media.name || media.bytes !== manifest.media.bytes || media.sha256 !== manifest.media.sha256) fail('crabbox_artifact_checksum_mismatch');
  return manifest;
}

function buildCollectionReceipt(bundleDirectory, collectionEvidence) {
  const manifest = validateBundle(bundleDirectory, collectionEvidence);
  return contract.buildManifest({
    repository: manifest.repository.nameWithOwner,
    repositoryId: manifest.repository.databaseId,
    prNumber: manifest.pullRequest.number,
    headSha: manifest.pullRequest.headSha,
    media: manifest.media,
    scenario: manifest.scenario,
    expected: manifest.expected,
    observed: manifest.observed,
    captureEnvironment: manifest.captureEnvironment,
    mediaInspection: manifest.mediaInspection,
    privacyReview: manifest.privacyReview,
    uploadPath: 'crabbox-artifact',
    url: '',
    crabbox: collectionEvidence,
  });
}

function publishDurably() { fail('durable_crabbox_backend_unapproved'); }

function containsExactString(value, expected) {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some(item => containsExactString(item, expected));
  if (value && typeof value === 'object') return Object.values(value).some(item => containsExactString(item, expected));
  return false;
}

function validatedConfigEnvironment(source = process.env) {
  const env = { PATH: '/Users/bfeintuch/Documents/Codex/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' };
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME']) {
    const value = source[key];
    if (typeof value === 'string' && value.startsWith('/') && !/[\u0000-\u001f\u007f]/u.test(value)) env[key] = value;
  }
  if (!env.HOME) fail('crabbox_cleanup_ambiguous');
  return env;
}

function verifyLeaseAbsent(leaseId, runner = spawnSync, repoRoot = path.resolve(__dirname, '../..'), sourceEnv = process.env) {
  const options = {
    encoding: 'utf8',
    cwd: repoRoot,
    env: validatedConfigEnvironment(sourceEnv),
    maxBuffer: 1024 * 1024,
  };
  const configResult = runner('crabbox', ['config', 'show', '--json'], options);
  if (!configResult || configResult.status !== 0) fail('crabbox_cleanup_ambiguous');
  let config;
  try { config = JSON.parse(configResult.stdout); } catch { fail('crabbox_cleanup_ambiguous'); }
  if (!config || config.provider !== 'apple-vm') fail('crabbox_cleanup_ambiguous');
  const result = runner('crabbox', ['list', '--json'], options);
  if (!result || result.status !== 0) fail('crabbox_cleanup_ambiguous');
  let leases;
  try { leases = JSON.parse(result.stdout); } catch { fail('crabbox_cleanup_ambiguous'); }
  if (!Array.isArray(leases) || containsExactString(leases, leaseId)) fail('crabbox_cleanup_ambiguous');
  return 'PASS';
}

function inspectArchive(archivePath) {
  const resolved = path.resolve(archivePath);
  if (fs.realpathSync(path.dirname(resolved)) !== path.dirname(resolved)) fail('invalid_crabbox_archive');
  let inspected;
  try { inspected = contract.inspectFile(resolved, 'invalid_crabbox_archive'); } catch { fail('invalid_crabbox_archive'); }
  return { archive: path.basename(resolved), archiveBytes: inspected.bytes, archiveSha256: inspected.sha256 };
}

function main(argv = process.argv.slice(2)) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index] || !argv[index].startsWith('--') || index + 1 >= argv.length || Object.hasOwn(values, argv[index])) fail('invalid_arguments');
    values[argv[index]] = argv[index + 1];
  }
  const keys = ['--bundle-dir', '--lease-id', '--run-id', '--archive', '--receipt-output'];
  if (Object.keys(values).length !== keys.length || keys.some(key => !Object.hasOwn(values, key))) fail('invalid_arguments');
  const archive = inspectArchive(values['--archive']);
  const evidence = {
    provider: 'apple-vm',
    leaseId: values['--lease-id'],
    runId: values['--run-id'],
    ...archive,
    cleanup: verifyLeaseAbsent(values['--lease-id']),
    durableArtifactUrl: '',
  };
  const receipt = buildCollectionReceipt(path.resolve(values['--bundle-dir']), evidence);
  const output = path.resolve(values['--receipt-output']);
  const parent = path.dirname(output);
  let parentMetadata;
  try { parentMetadata = fs.lstatSync(parent); } catch { fail('unsafe_receipt_output'); }
  if (/[\u0000-\u001f\u007f]/u.test(values['--receipt-output']) || !parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() || fs.realpathSync(parent) !== parent || fs.existsSync(output)) fail('unsafe_receipt_output');
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ collectionValidated: true, durablePublicationAvailable: false, blocker: 'durable_crabbox_backend_unapproved' })}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`Crabbox visual validation failed: ${error.message}`); process.exitCode = 1; }
}

module.exports = { buildCollectionReceipt, containsExactString, inspectArchive, main, publishDurably, readJSONFileNoFollow, validateBundle, validatedConfigEnvironment, verifyLeaseAbsent };
