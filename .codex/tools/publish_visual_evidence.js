#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const contract = require('./visual_evidence_contract');

const REQUIRED_REPOSITORY = 'bfeintuch123/crate-app';
const REQUIRED_REPOSITORY_ID = '1165820261';
const REQUIRED_BASE = 'v2.4.x';

function fixedFail(code) { throw new Error(code); }

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key || !key.startsWith('--') || index + 1 >= argv.length || Object.hasOwn(values, key)) fixedFail('invalid_arguments');
    values[key] = argv[index + 1];
  }
  const required = ['--media', '--mime', '--repo', '--repo-id', '--pr', '--head-sha', '--scenario', '--expected', '--observed', '--capture-environment', '--review-receipt', '--upload-path', '--manifest-output'];
  if (Object.keys(values).length !== required.length || required.some(key => !Object.hasOwn(values, key))) fixedFail('invalid_arguments');
  return values;
}

function loadReviewReceipt(receiptPath, media) {
  if (typeof receiptPath !== 'string' || /[\u0000-\u001f\u007f]/u.test(receiptPath)) fixedFail('review_receipt_required');
  let descriptor;
  try {
    const resolved = path.resolve(receiptPath);
    if (fs.realpathSync(path.dirname(resolved)) !== path.dirname(resolved)) fixedFail('review_receipt_required');
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size <= 0 || metadata.size > 8192) fixedFail('review_receipt_required');
    const body = Buffer.alloc(metadata.size);
    if (fs.readSync(descriptor, body, 0, body.length, 0) !== body.length) fixedFail('review_receipt_required');
    const receipt = JSON.parse(body.toString('utf8'));
    const keys = ['schema', 'media', 'mediaInspection', 'privacyReview'];
    const mediaKeys = ['name', 'mime', 'bytes', 'sha256'];
    if (!receipt || JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(keys.sort()) ||
        !receipt.media || JSON.stringify(Object.keys(receipt.media).sort()) !== JSON.stringify(mediaKeys.sort()) ||
        receipt.schema !== 'crate.visual-review.v1' || receipt.mediaInspection !== 'PASS' || receipt.privacyReview !== 'PASS' ||
        JSON.stringify(receipt.media) !== JSON.stringify(media)) fixedFail('review_receipt_mismatch');
    return receipt;
  } catch (error) {
    if (error && ['review_receipt_required', 'review_receipt_mismatch'].includes(error.message)) throw error;
    fixedFail('review_receipt_required');
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function sanitizedEnvironment(source = process.env) {
  const environment = { PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' };
  for (const key of ['HOME', 'TMPDIR']) {
    const value = source[key];
    if (typeof value === 'string' && value.startsWith('/') && !/[\u0000-\u001f\u007f]/u.test(value)) environment[key] = value;
  }
  return environment;
}

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: null, maxBuffer: 2 * 1024 * 1024, env: sanitizedEnvironment(), ...options });
  if (result.status !== 0) fixedFail(options.errorCode || 'external_command_failed');
  return result.stdout || Buffer.alloc(0);
}

function verifyGitHubBinding(args, runner = run) {
  if (args['--repo'] !== REQUIRED_REPOSITORY || args['--repo-id'] !== REQUIRED_REPOSITORY_ID) fixedFail('repository_identity_mismatch');
  let repo;
  let pr;
  try { repo = JSON.parse(runner('gh', ['api', `repos/${args['--repo']}`], { errorCode: 'repository_verification_failed' }).toString('utf8')); }
  catch { fixedFail('repository_verification_failed'); }
  if (String(repo.id) !== args['--repo-id'] || repo.full_name !== args['--repo']) fixedFail('repository_identity_mismatch');
  if (repo.private !== false || repo.visibility !== 'public') fixedFail('repository_visibility_mismatch');
  try { pr = JSON.parse(runner('gh', ['api', `repos/${args['--repo']}/pulls/${args['--pr']}`], { errorCode: 'pr_verification_failed' }).toString('utf8')); }
  catch { fixedFail('pr_verification_failed'); }
  if (!pr.base || pr.base.ref !== REQUIRED_BASE || !pr.base.repo || String(pr.base.repo.id) !== REQUIRED_REPOSITORY_ID ||
      pr.base.repo.full_name !== REQUIRED_REPOSITORY) fixedFail('pr_base_mismatch');
  if (!pr.head || pr.head.sha !== args['--head-sha']) fixedFail('pr_head_mismatch');
}

function tokenSafeCurlConfig(token) {
  const validByte = byte => (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) || byte === 95;
  if (!Buffer.isBuffer(token) || token.length < 20 || !token.every(validByte)) fixedFail('github_auth_unavailable');
  return Buffer.concat([Buffer.from('header = "Authorization: Bearer '), token, Buffer.from('"\nheader = "Accept: application/json"\n')]);
}

function stageMedia(file, expected) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-visual-upload-'));
  fs.chmodSync(directory, 0o700);
  const staged = path.join(directory, expected.name);
  let source;
  let destination;
  let copyError;
  try {
    source = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const sourceMetadata = fs.fstatSync(source);
    if (!sourceMetadata.isFile() || sourceMetadata.size !== expected.bytes) fixedFail('media_changed_before_upload');
    destination = fs.openSync(staged, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < sourceMetadata.size) {
      const read = fs.readSync(source, buffer, 0, Math.min(buffer.length, sourceMetadata.size - offset), offset);
      if (read === 0) fixedFail('media_changed_before_upload');
      let written = 0;
      while (written < read) written += fs.writeSync(destination, buffer, written, read - written, offset + written);
      offset += read;
    }
  } catch (error) {
    copyError = error;
  } finally {
    if (source !== undefined) fs.closeSync(source);
    if (destination !== undefined) fs.closeSync(destination);
  }
  if (copyError) {
    try { fs.unlinkSync(staged); } catch {}
    try { fs.rmdirSync(directory); } catch {}
    if (copyError.message === 'media_changed_before_upload') throw copyError;
    fixedFail('media_staging_failed');
  }
  try {
    const stagedMedia = contract.inspectMedia(staged, expected.mime);
    if (stagedMedia.bytes !== expected.bytes || stagedMedia.sha256 !== expected.sha256) fixedFail('media_changed_before_upload');
    return { directory, file: staged, media: stagedMedia };
  } catch (error) {
    try { fs.unlinkSync(staged); } catch {}
    try { fs.rmdirSync(directory); } catch {}
    if (error && error.message === 'media_changed_before_upload') throw error;
    fixedFail('media_staging_failed');
  }
}

function removeStagedMedia(staged) {
  if (!staged) return;
  try { fs.unlinkSync(staged.file); } catch {}
  try { fs.rmdirSync(staged.directory); } catch {}
}

function reserveManifestOutput(rawPath) {
  if (typeof rawPath !== 'string' || /[\u0000-\u001f\u007f]/u.test(rawPath)) fixedFail('unsafe_manifest_output');
  const manifestPath = path.resolve(rawPath);
  const parent = path.dirname(manifestPath);
  let parentMetadata;
  try { parentMetadata = fs.lstatSync(parent); } catch { fixedFail('unsafe_manifest_output'); }
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() || fs.realpathSync(parent) !== parent) fixedFail('unsafe_manifest_output');
  let descriptor;
  try { descriptor = fs.openSync(manifestPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600); }
  catch { fixedFail('unsafe_manifest_output'); }
  return { descriptor, path: manifestPath, complete: false };
}

function finishManifestOutput(reservation, manifest) {
  const content = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  let offset = 0;
  while (offset < content.length) offset += fs.writeSync(reservation.descriptor, content, offset, content.length - offset, offset);
  fs.fsyncSync(reservation.descriptor);
  fs.closeSync(reservation.descriptor);
  reservation.descriptor = undefined;
  reservation.complete = true;
}

function releaseManifestOutput(reservation) {
  if (!reservation) return;
  if (reservation.descriptor !== undefined) {
    try { fs.closeSync(reservation.descriptor); } catch {}
    reservation.descriptor = undefined;
  }
  if (!reservation.complete) {
    try { fs.unlinkSync(reservation.path); } catch {}
  }
}

function stdinURLConfig(url) {
  const safe = contract.safeReadbackRedirect(url);
  return Buffer.from(`url = "${safe}"\n`, 'utf8');
}

function upload(file, mime, repoId, runner = run) {
  const tokenOutput = runner('gh', ['auth', 'token'], { errorCode: 'github_auth_unavailable' });
  let start = 0;
  let end = tokenOutput.length;
  while (start < end && (tokenOutput[start] === 0x20 || tokenOutput[start] === 0x09 || tokenOutput[start] === 0x0a || tokenOutput[start] === 0x0d)) start += 1;
  while (end > start && (tokenOutput[end - 1] === 0x20 || tokenOutput[end - 1] === 0x09 || tokenOutput[end - 1] === 0x0a || tokenOutput[end - 1] === 0x0d)) end -= 1;
  const token = Buffer.from(tokenOutput.subarray(start, end));
  tokenOutput.fill(0);
  let config;
  try { config = tokenSafeCurlConfig(token); } finally { token.fill(0); }
  const name = path.basename(file);
  const endpoint = `https://uploads.github.com/user-attachments/assets?name=${encodeURIComponent(name)}&content_type=${encodeURIComponent(mime)}&repository_id=${repoId}`;
  let output;
  try {
    output = runner('curl', ['--proto', '=https', '--max-redirs', '0', '--silent', '--show-error', '--request', 'POST', '--header', 'Content-Type: application/octet-stream', '--header', 'X-GitHub-Api-Version: 2022-11-28', '--data-binary', `@${file}`, '--write-out', '\n%{http_code}\n%{redirect_url}', '--config', '-', endpoint], { input: config, errorCode: 'upload_transport_failure' });
  } finally {
    config.fill(0);
  }
  const text = output.toString('utf8');
  const match = text.match(/\n(\d{3})\n([^\n]*)$/);
  if (!match) fixedFail('upload_response_invalid');
  return contract.validateUploadResponse(Number(match[1]), { location: match[2] || '' }, text.slice(0, match.index));
}

function readback(url, expected, runner = run) {
  contract.safeURL(url);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-visual-readback-'));
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, contract.safeName(expected.name));
  const headers = path.join(directory, 'headers');
  try {
    fs.writeFileSync(headers, '', { mode: 0o600, flag: 'wx' });
    let output = runner('curl', ['--proto', '=https', '--max-redirs', '0', '--max-filesize', String(contract.MAX_MEDIA_BYTES), '--max-time', '120', '--silent', '--show-error', '--dump-header', headers, '--output', file, '--write-out', '%{http_code}', url], { errorCode: 'readback_transport_failure' }).toString('utf8');
    let status = Number(output);
    if (status === 302) {
      const headerText = fs.readFileSync(headers, 'utf8');
      const locations = headerText.split(/\r?\n/).filter(line => /^location:/i.test(line));
      if (locations.length !== 1) fixedFail('readback_redirect_invalid');
      const redirect = locations[0].slice(locations[0].indexOf(':') + 1).trim();
      const redirectConfig = stdinURLConfig(redirect);
      try {
        output = runner('curl', ['--proto', '=https', '--max-redirs', '0', '--max-filesize', String(contract.MAX_MEDIA_BYTES), '--max-time', '120', '--silent', '--show-error', '--output', file, '--write-out', '%{http_code}\n%{redirect_url}', '--config', '-'], { input: redirectConfig, errorCode: 'readback_transport_failure' }).toString('utf8');
      } finally { redirectConfig.fill(0); }
      const values = output.trimEnd().split('\n');
      status = Number(values[0]);
      if ((values[1] || '') !== '') fixedFail('readback_redirect_invalid');
    }
    let inspected;
    try { inspected = contract.inspectMedia(file, expected.mime); } catch { fixedFail('readback_unavailable'); }
    contract.validateReadback(expected, status, '', inspected.bytes, inspected.sha256);
  } finally {
    try { fs.unlinkSync(file); } catch {}
    try { fs.unlinkSync(headers); } catch {}
    try { fs.rmdirSync(directory); } catch {}
  }
}

function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv);
  if (args['--upload-path'] !== 'github-user-attachment') fixedFail('invalid_upload_path');
  const media = contract.inspectMedia(args['--media'], args['--mime']);
  loadReviewReceipt(args['--review-receipt'], media);
  const manifestInput = {
    repository: args['--repo'], repositoryId: args['--repo-id'], prNumber: Number(args['--pr']), headSha: args['--head-sha'],
    media, scenario: args['--scenario'], expected: args['--expected'], observed: args['--observed'], captureEnvironment: args['--capture-environment'],
    mediaInspection: 'PASS', privacyReview: 'PASS', uploadPath: args['--upload-path'], crabbox: null,
  };
  contract.buildManifest({ ...manifestInput, url: '' });
  let staged;
  let reservation;
  try {
    reservation = reserveManifestOutput(args['--manifest-output']);
    staged = stageMedia(args['--media'], media);
    verifyGitHubBinding(args, dependencies.run || run);
    const uploaded = upload(staged.file, args['--mime'], args['--repo-id'], dependencies.run || run);
    readback(uploaded.url, staged.media, dependencies.run || run);
    verifyGitHubBinding(args, dependencies.run || run);
    const manifest = contract.buildManifest({ ...manifestInput, media: staged.media, url: uploaded.url });
    finishManifestOutput(reservation, manifest);
    process.stdout.write(`${JSON.stringify({ mediaUrl: uploaded.url, manifestWritten: true, media: staged.media })}\n`);
  } finally {
    removeStagedMedia(staged);
    releaseManifestOutput(reservation);
  }
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`visual evidence publication failed: ${error.message}`); process.exitCode = 1; }
}

module.exports = { finishManifestOutput, loadReviewReceipt, main, parseArgs, readback, releaseManifestOutput, removeStagedMedia, reserveManifestOutput, sanitizedEnvironment, stageMedia, stdinURLConfig, tokenSafeCurlConfig, upload, verifyGitHubBinding };
