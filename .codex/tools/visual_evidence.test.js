'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const contract = require('./visual_evidence_contract');
const publisher = require('./publish_visual_evidence');
const builder = require('./build_crabbox_visual_bundle');
const collection = require('./validate_crabbox_visual_collection');

const SHA = 'a'.repeat(40);
const REPO = 'bfeintuch123/crate-app';
const REPO_ID = '1165820261';

function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'crate-visual-test-')); }
function writeMedia(directory, name = 'proof.png', body = Buffer.from('89504e470d0a1a0a00000000', 'hex')) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, body, { mode: 0o600 });
  return file;
}
function manifestInput(media, overrides = {}) {
  return {
    repository: REPO, repositoryId: REPO_ID, prNumber: 7, headSha: SHA, media,
    scenario: 'Synthetic visual protocol proof', expected: 'Fixed green square', observed: 'Fixed green square',
    captureEnvironment: 'Generated non-sensitive fixture', mediaInspection: 'PASS', privacyReview: 'PASS',
    uploadPath: 'github-user-attachment', url: 'https://github.com/user-attachments/assets/abc-123', crabbox: null,
    ...overrides,
  };
}
function errorCode(fn, code) { assert.throws(fn, error => error && error.message === code); }
function fixture() {
  const directory = temp();
  const file = writeMedia(directory);
  return { directory, file, media: contract.inspectMedia(file, 'image/png') };
}
function writeReviewReceipt(directory, media, overrides = {}) {
  const file = path.join(directory, 'review.json');
  const receipt = { schema: 'crate.visual-review.v1', media, mediaInspection: 'PASS', privacyReview: 'PASS', ...overrides };
  fs.writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 });
  return file;
}

test('rejects symlink and non-regular media', () => {
  const directory = temp();
  const real = writeMedia(directory);
  fs.symlinkSync(real, path.join(directory, 'link.png'));
  errorCode(() => contract.inspectMedia(path.join(directory, 'link.png'), 'image/png'), 'media_not_regular');
  errorCode(() => contract.inspectMedia(directory, 'image/png'), 'media_extension_mismatch');
});

test('rejects MIME mismatch, unsafe path/name, and oversize', () => {
  const directory = temp();
  const png = writeMedia(directory);
  errorCode(() => contract.inspectMedia(png, 'video/mp4'), 'media_extension_mismatch');
  const unsafe = writeMedia(directory, 'bad name.png');
  errorCode(() => contract.inspectMedia(unsafe, 'image/png'), 'unsafe_media_name');
  const fake = writeMedia(directory, 'fake.png', Buffer.from('not-a-png'));
  errorCode(() => contract.inspectMedia(fake, 'image/png'), 'media_content_mismatch');
  errorCode(() => contract.inspectMedia(`${png}\nsecret`, 'image/png'), 'unsafe_media_path');
  const huge = path.join(directory, 'huge.png');
  fs.closeSync(fs.openSync(huge, 'w'));
  fs.truncateSync(huge, contract.MAX_MEDIA_BYTES + 1);
  errorCode(() => contract.inspectMedia(huge, 'image/png'), 'media_size_invalid');
});

test('rejects symlinked parent directory', () => {
  const directory = temp();
  const real = path.join(directory, 'real'); fs.mkdirSync(real); writeMedia(real);
  const link = path.join(directory, 'alias'); fs.symlinkSync(real, link);
  errorCode(() => contract.inspectMedia(path.join(link, 'proof.png'), 'image/png'), 'unsafe_media_path');
});

test('manifest rejects missing/extra fields, malformed hash, stale SHA, paths, tokens, and missing PASS gates', () => {
  const { media } = fixture();
  const valid = contract.buildManifest(manifestInput(media));
  const missing = { ...valid }; delete missing.expected;
  errorCode(() => contract.validateManifest(missing), 'invalid_manifest_keys');
  errorCode(() => contract.validateManifest({ ...valid, extra: true }), 'invalid_manifest_keys');
  errorCode(() => contract.validateManifest({ ...valid, media: { ...valid.media, sha256: 'bad' } }), 'invalid_media_hash');
  errorCode(() => contract.buildManifest(manifestInput(media, { headSha: 'short' })), 'invalid_head_sha');
  errorCode(() => contract.buildManifest(manifestInput(media, { expected: '/Users/private/proof' })), 'invalid_expected');
  errorCode(() => contract.buildManifest(manifestInput(media, { expected: '/private/tmp/proof' })), 'invalid_expected');
  errorCode(() => contract.buildManifest(manifestInput(media, { expected: '/home/tester/proof' })), 'invalid_expected');
  errorCode(() => contract.buildManifest(manifestInput(media, { expected: 'stored at /opt/proof/file' })), 'invalid_expected');
  errorCode(() => contract.buildManifest(manifestInput(media, { observed: `ghp_${'x'.repeat(30)}` })), 'invalid_observed');
  errorCode(() => contract.buildManifest(manifestInput(media, { mediaInspection: 'FAIL' })), 'media_inspection_required');
  errorCode(() => contract.buildManifest(manifestInput(media, { privacyReview: 'FAIL' })), 'privacy_review_required');
});

test('publisher requires an owner-only inspection receipt bound to exact media', () => {
  const { directory, media } = fixture();
  errorCode(() => publisher.loadReviewReceipt(path.join(directory, 'missing.json'), media), 'review_receipt_required');
  const receipt = writeReviewReceipt(directory, media);
  assert.equal(publisher.loadReviewReceipt(receipt, media).privacyReview, 'PASS');
  fs.chmodSync(receipt, 0o644);
  errorCode(() => publisher.loadReviewReceipt(receipt, media), 'review_receipt_required');
  fs.chmodSync(receipt, 0o600);
  errorCode(() => publisher.loadReviewReceipt(receipt, { ...media, sha256: 'b'.repeat(64) }), 'review_receipt_mismatch');
  const stale = path.join(directory, 'stale.json');
  fs.writeFileSync(stale, JSON.stringify({ schema: 'crate.visual-review.v1', media, mediaInspection: 'FAIL', privacyReview: 'PASS' }), { mode: 0o600 });
  errorCode(() => publisher.loadReviewReceipt(stale, media), 'review_receipt_mismatch');
});

test('manifest rejects unsafe URL and Crabbox durable fields without backend approval', () => {
  const { media } = fixture();
  errorCode(() => contract.buildManifest(manifestInput(media, { url: 'https://github.com/user-attachments/assets/x?token=secret' })), 'unsafe_url');
  errorCode(() => contract.buildManifest(manifestInput(media, { url: 'https://example.com/user-attachments/assets/x' })), 'unapproved_url_host');
  errorCode(() => contract.buildManifest(manifestInput(media, { crabbox: { provider: 'apple-vm', leaseId: 'cbx_ab', runId: 'run_ab', archive: 'run_ab-artifacts.tgz', archiveBytes: 1, archiveSha256: 'd'.repeat(64), cleanup: 'PASS', durableArtifactUrl: '' } })), 'invalid_crabbox_evidence');
});

test('loaded manifest revalidates repository and PR nested values', () => {
  const { media } = fixture();
  const valid = contract.buildManifest(manifestInput(media));
  errorCode(() => contract.validateManifest({ ...valid, repository: { ...valid.repository, databaseId: -1 } }), 'invalid_repository_binding');
  errorCode(() => contract.validateManifest({ ...valid, pullRequest: { ...valid.pullRequest, headSha: 'short' } }), 'invalid_pr_binding');
});

test('upload rejects malformed, error, redirect, and unexpected JSON', () => {
  errorCode(() => contract.validateUploadResponse(500, {}, '{}'), 'upload_http_failure');
  errorCode(() => contract.validateUploadResponse(201, { location: 'https://evil.invalid' }, '{}'), 'upload_redirect_rejected');
  errorCode(() => contract.validateUploadResponse(201, {}, 'not-json'), 'upload_response_invalid');
  errorCode(() => contract.validateUploadResponse(201, {}, JSON.stringify({ url: 'https://github.com/user-attachments/assets/x', extra: 1 })), 'upload_response_invalid');
});

test('readback rejects inaccessible, redirected, size, and hash mismatch', () => {
  const expected = { bytes: 3, sha256: 'b'.repeat(64) };
  errorCode(() => contract.validateReadback(expected, 404, '', 3, expected.sha256), 'readback_unavailable');
  errorCode(() => contract.validateReadback(expected, 200, 'https://elsewhere.invalid', 3, expected.sha256), 'readback_unavailable');
  errorCode(() => contract.validateReadback(expected, 200, '', 4, expected.sha256), 'readback_size_mismatch');
  errorCode(() => contract.validateReadback(expected, 200, '', 3, 'c'.repeat(64)), 'readback_hash_mismatch');
});

test('GitHub binding rejects wrong identity, non-public repository, and stale head', () => {
  const args = { '--repo': REPO, '--repo-id': REPO_ID, '--pr': '7', '--head-sha': SHA };
  const base = { ref: 'v2.4.x', repo: { id: Number(REPO_ID), full_name: REPO } };
  const repository = { id: Number(REPO_ID), full_name: REPO, private: false, visibility: 'public' };
  const runnerFor = (repo, pr) => (_program, command) => Buffer.from(JSON.stringify(command[1].includes('/pulls/') ? pr : repo));
  errorCode(() => publisher.verifyGitHubBinding({ ...args, '--repo': 'other/repo' }, () => { throw new Error('must_not_call'); }), 'repository_identity_mismatch');
  errorCode(() => publisher.verifyGitHubBinding({ ...args, '--repo-id': '1' }, () => { throw new Error('must_not_call'); }), 'repository_identity_mismatch');
  errorCode(() => publisher.verifyGitHubBinding(args, runnerFor({ ...repository, private: true, visibility: 'private' }, { base, head: { sha: SHA } })), 'repository_visibility_mismatch');
  errorCode(() => publisher.verifyGitHubBinding(args, runnerFor(repository, { base: { ...base, ref: 'main' }, head: { sha: SHA } })), 'pr_base_mismatch');
  errorCode(() => publisher.verifyGitHubBinding(args, runnerFor(repository, { base: { ref: 'v2.4.x', repo: { id: 1, full_name: 'other/repo' } }, head: { sha: SHA } })), 'pr_base_mismatch');
  errorCode(() => publisher.verifyGitHubBinding(args, runnerFor(repository, { base, head: { sha: 'b'.repeat(40) } })), 'pr_head_mismatch');
});

test('second GitHub binding check rejects a head changed after upload readback', () => {
  const args = { '--repo': REPO, '--repo-id': REPO_ID, '--pr': '7', '--head-sha': SHA };
  let prReads = 0;
  const runner = (_program, command) => {
    if (!command[1].includes('/pulls/')) return Buffer.from(JSON.stringify({ id: Number(REPO_ID), full_name: REPO, private: false, visibility: 'public' }));
    prReads += 1;
    return Buffer.from(JSON.stringify({ base: { ref: 'v2.4.x', repo: { id: Number(REPO_ID), full_name: REPO } }, head: { sha: prReads === 1 ? SHA : 'b'.repeat(40) } }));
  };
  publisher.verifyGitHubBinding(args, runner);
  errorCode(() => publisher.verifyGitHubBinding(args, runner), 'pr_head_mismatch');
});

test('token is absent from argv/env/output and wiped from curl stdin buffer', () => {
  const { file } = fixture();
  const tokenText = `ghp_${'A'.repeat(32)}`;
  const calls = [];
  let curlInput;
  const runner = (program, args, options) => {
    calls.push({ program, args: [...args], env: options.env });
    if (program === 'gh') return Buffer.from(`${tokenText}\n`);
    curlInput = options.input;
    return Buffer.from(`${JSON.stringify({ url: 'https://github.com/user-attachments/assets/abc-123' })}\n201\n`);
  };
  const response = publisher.upload(file, 'image/png', REPO_ID, runner);
  assert.equal(response.url, 'https://github.com/user-attachments/assets/abc-123');
  assert.equal(JSON.stringify(calls).includes(tokenText), false);
  assert.equal(calls.some(call => call.env && JSON.stringify(call.env).includes(tokenText)), false);
  assert.equal(curlInput.every(byte => byte === 0), true);
  assert.equal(JSON.stringify(response).includes(tokenText), false);
});

test('readback redirect allows only strict GitHub production asset URLs and keeps signed URL off argv', () => {
  const url = `https://github-production-user-asset-6210.s3.amazonaws.com/1/2-abc.png?X-Amz-Algorithm=A&X-Amz-Credential=B&X-Amz-Date=C&X-Amz-Expires=300&X-Amz-Signature=D&X-Amz-SignedHeaders=host`;
  assert.equal(contract.safeReadbackRedirect(url), url);
  errorCode(() => contract.safeReadbackRedirect(url.replace('github-production-user-asset-6210.s3.amazonaws.com', 'evil.invalid')), 'unapproved_readback_host');
  errorCode(() => contract.safeReadbackRedirect(`${url}&token=secret`), 'unsafe_readback_redirect');
  const config = publisher.stdinURLConfig(url);
  assert.equal(config.toString('utf8').includes('X-Amz-Signature=D'), true);
  assert.equal(['curl', '--config', '-'].join(' ').includes('X-Amz-Signature'), false);
  config.fill(0);
  assert.equal(config.every(byte => byte === 0), true);
});

test('destination readback enforces bounded transfer, media signature, size, and hash', () => {
  const { file, media } = fixture();
  const mediaBytes = fs.readFileSync(file);
  const signed = `https://github-production-user-asset-6210.s3.amazonaws.com/1/2-abc.png?X-Amz-Algorithm=A&X-Amz-Credential=B&X-Amz-Date=C&X-Amz-Expires=300&X-Amz-Signature=D&X-Amz-SignedHeaders=host`;
  const calls = [];
  const runner = (_program, args) => {
    calls.push([...args]);
    const output = args[args.indexOf('--output') + 1];
    if (args.includes('--dump-header')) {
      const headers = args[args.indexOf('--dump-header') + 1];
      fs.writeFileSync(headers, `HTTP/1.1 302 Found\r\nlocation: ${signed}\r\n\r\n`);
      return Buffer.from('302');
    }
    fs.writeFileSync(output, mediaBytes);
    return Buffer.from('200\n');
  };
  publisher.readback('https://github.com/user-attachments/assets/abc-123', media, runner);
  assert.equal(calls.length, 2);
  for (const args of calls) {
    assert.deepEqual(args.slice(args.indexOf('--max-filesize'), args.indexOf('--max-filesize') + 2), ['--max-filesize', String(contract.MAX_MEDIA_BYTES)]);
    assert.deepEqual(args.slice(args.indexOf('--max-time'), args.indexOf('--max-time') + 2), ['--max-time', '120']);
  }
  errorCode(() => publisher.readback('https://github.com/user-attachments/assets/abc-123', { ...media, sha256: 'f'.repeat(64) }, runner), 'readback_hash_mismatch');
  errorCode(() => publisher.readback('https://github.com/user-attachments/assets/abc-123', { ...media, mime: 'video/mp4', name: 'proof.mp4' }, runner), 'readback_unavailable');
});

test('token parser rejects control characters and quote injection', () => {
  errorCode(() => publisher.tokenSafeCurlConfig(Buffer.from(`ghp_${'x'.repeat(20)}\n`)), 'github_auth_unavailable');
  errorCode(() => publisher.tokenSafeCurlConfig(Buffer.from(`ghp_${'x'.repeat(20)}"`)), 'github_auth_unavailable');
});

test('GitHub token environment variables are removed before child execution', () => {
  const environment = publisher.sanitizedEnvironment({ HOME: '/safe/home', TMPDIR: '/safe/tmp', GH_TOKEN: 'secret', UNRELATED_SECRET: 'secret2', HTTPS_PROXY: 'https://name:secret@example.invalid' });
  assert.deepEqual(environment, { PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/safe/home', TMPDIR: '/safe/tmp' });
});

test('manifest output is safely reserved before publication and removed on failure', () => {
  const directory = temp();
  const output = path.join(directory, 'receipt.json');
  const reservation = publisher.reserveManifestOutput(output);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  publisher.releaseManifestOutput(reservation);
  assert.equal(fs.existsSync(output), false);
  fs.writeFileSync(output, 'existing');
  errorCode(() => publisher.reserveManifestOutput(output), 'unsafe_manifest_output');
});

test('unsafe manifest destination causes zero GitHub or curl calls', () => {
  const { directory, file } = fixture();
  const output = path.join(directory, 'existing.json');
  fs.writeFileSync(output, 'existing');
  let calls = 0;
  const argv = [
    '--media', file, '--mime', 'image/png', '--repo', REPO, '--repo-id', REPO_ID,
    '--pr', '7', '--head-sha', SHA, '--scenario', 'Synthetic visual protocol proof',
    '--expected', 'Fixed green square', '--observed', 'Fixed green square',
    '--capture-environment', 'Generated non-sensitive fixture', '--review-receipt', writeReviewReceipt(directory, contract.inspectMedia(file, 'image/png')),
    '--upload-path', 'github-user-attachment', '--manifest-output', output,
  ];
  errorCode(() => publisher.main(argv, { run: () => { calls += 1; return Buffer.alloc(0); } }), 'unsafe_manifest_output');
  assert.equal(calls, 0);
});

test('staged upload copy preserves exact bytes and uses only a sanitized temporary basename', () => {
  const { file, media } = fixture();
  const staged = publisher.stageMedia(file, media);
  try {
    assert.equal(path.basename(staged.file), media.name);
    assert.equal(staged.file.includes(path.dirname(file)), false);
    assert.equal(staged.media.sha256, media.sha256);
    assert.equal(fs.statSync(staged.file).mode & 0o777, 0o600);
  } finally { publisher.removeStagedMedia(staged); }
  assert.equal(fs.existsSync(staged.directory), false);
});

test('Crabbox bundle builds and validates exact artifact set', () => {
  const input = temp();
  const file = writeMedia(input); const media = contract.inspectMedia(file, 'image/png');
  fs.writeFileSync(path.join(input, 'request.json'), JSON.stringify({ ...manifestInput(media), url: undefined, uploadPath: undefined, crabbox: undefined, media }, (key, value) => value === undefined ? undefined : value));
  const output = path.join(temp(), 'bundle');
  builder.build(input, output);
  const result = collection.validateBundle(output, { provider: 'apple-vm', leaseId: 'cbx_ab12', runId: 'run_ab12', archive: 'run_ab12-artifacts.tgz', archiveBytes: 1, archiveSha256: 'd'.repeat(64), cleanup: 'PASS', durableArtifactUrl: '' });
  assert.equal(result.media.sha256, media.sha256);
  const receipt = collection.buildCollectionReceipt(output, { provider: 'apple-vm', leaseId: 'cbx_ab12', runId: 'run_ab12', archive: 'run_ab12-artifacts.tgz', archiveBytes: 1, archiveSha256: 'd'.repeat(64), cleanup: 'PASS', durableArtifactUrl: '' });
  assert.equal(receipt.crabbox.cleanup, 'PASS');
  assert.equal(receipt.crabbox.durableArtifactUrl, '');
});

test('Crabbox staging rejects substituted bytes before the artifact output exists', () => {
  const directory = temp();
  const file = writeMedia(directory);
  const media = contract.inspectMedia(file, 'image/png');
  fs.appendFileSync(file, 'substitution');
  errorCode(() => builder.stageExactMedia(file, media), 'collection_media_mismatch');
});

test('Crabbox request, manifest, and output parents reject symlinks', () => {
  const input = temp();
  const file = writeMedia(input); const media = contract.inspectMedia(file, 'image/png');
  const request = manifestInput(media); delete request.url; delete request.uploadPath; delete request.crabbox;
  const realRequest = path.join(input, 'real.json'); fs.writeFileSync(realRequest, JSON.stringify(request));
  fs.symlinkSync(realRequest, path.join(input, 'request.json'));
  errorCode(() => builder.build(input, path.join(temp(), 'bundle')), 'invalid_collection_request');

  const cleanInput = temp(); const cleanFile = writeMedia(cleanInput); const cleanMedia = contract.inspectMedia(cleanFile, 'image/png');
  const cleanRequest = manifestInput(cleanMedia); delete cleanRequest.url; delete cleanRequest.uploadPath; delete cleanRequest.crabbox;
  fs.writeFileSync(path.join(cleanInput, 'request.json'), JSON.stringify(cleanRequest));
  const realParent = temp(); const aliasParent = path.join(temp(), 'alias'); fs.symlinkSync(realParent, aliasParent);
  errorCode(() => builder.build(cleanInput, path.join(aliasParent, 'bundle')), 'unsafe_output_directory');

  const output = path.join(temp(), 'bundle'); builder.build(cleanInput, output);
  const manifestPath = path.join(output, 'visual-evidence.json'); const saved = path.join(temp(), 'saved.json');
  fs.renameSync(manifestPath, saved); fs.symlinkSync(saved, manifestPath);
  const evidence = { provider: 'apple-vm', leaseId: 'cbx_ab12', runId: 'run_ab12', archive: 'run_ab12-artifacts.tgz', archiveBytes: 1, archiveSha256: 'd'.repeat(64), cleanup: 'PASS', durableArtifactUrl: '' };
  errorCode(() => collection.validateBundle(output, evidence), 'invalid_crabbox_manifest');
});

test('Crabbox request rejects media traversal before reading outside input', () => {
  const parent = temp(); const input = path.join(parent, 'input'); fs.mkdirSync(input);
  const outside = writeMedia(parent, 'outside.png'); const media = contract.inspectMedia(outside, 'image/png');
  const request = manifestInput({ ...media, name: '../outside.png' }); delete request.url; delete request.uploadPath; delete request.crabbox;
  fs.writeFileSync(path.join(input, 'request.json'), JSON.stringify(request));
  errorCode(() => builder.build(input, path.join(temp(), 'bundle')), 'invalid_collection_request');
});

test('Crabbox rejects missing, duplicate, unexpected, checksum, and cleanup ambiguity', () => {
  const evidence = { provider: 'apple-vm', leaseId: 'cbx_ab12', runId: 'run_ab12', archive: 'run_ab12-artifacts.tgz', archiveBytes: 1, archiveSha256: 'd'.repeat(64), cleanup: 'PASS', durableArtifactUrl: '' };
  errorCode(() => collection.validateBundle(path.join(temp(), 'missing'), evidence), 'missing_crabbox_artifact');
  errorCode(() => contract.validateCrabboxCollection({ ...evidence, cleanup: 'UNKNOWN' }), 'crabbox_cleanup_required');
  const input = temp(); const file = writeMedia(input); const media = contract.inspectMedia(file, 'image/png');
  const request = manifestInput(media); delete request.url; delete request.uploadPath; delete request.crabbox;
  fs.writeFileSync(path.join(input, 'request.json'), JSON.stringify(request));
  const output = path.join(temp(), 'bundle'); builder.build(input, output);
  fs.writeFileSync(path.join(output, 'extra'), 'x');
  errorCode(() => collection.validateBundle(output, evidence), 'unexpected_crabbox_artifact');
  fs.unlinkSync(path.join(output, 'extra'));
  writeMedia(path.join(output, 'media'), 'second.png');
  errorCode(() => collection.validateBundle(output, evidence), 'duplicate_crabbox_artifact');
  fs.unlinkSync(path.join(output, 'media', 'second.png'));
  fs.appendFileSync(path.join(output, 'media', 'proof.png'), 'changed');
  errorCode(() => collection.validateBundle(output, evidence), 'crabbox_artifact_checksum_mismatch');
});

test('Crabbox durable publication always fails closed without an approved backend', () => {
  errorCode(() => collection.publishDurably(), 'durable_crabbox_backend_unapproved');
  errorCode(() => contract.validateCrabboxCollection({ provider: 'apple-vm', leaseId: 'cbx_ab', runId: 'run_ab', archive: 'run_ab-artifacts.tgz', archiveBytes: 1, archiveSha256: 'd'.repeat(64), cleanup: 'PASS' }), 'invalid_crabbox_collection');
  errorCode(() => contract.validateCrabboxCollection({ provider: 'apple-vm', leaseId: 'cbx_ab', runId: 'run_ab', archive: 'run_ab-artifacts.tgz', archiveBytes: 1, archiveSha256: 'd'.repeat(64), cleanup: 'PASS', durableArtifactUrl: 'https://github.com/user-attachments/assets/x' }), 'durable_crabbox_backend_unapproved');
});

test('cleanup is derived from live Crabbox list and archive is hash-bound', () => {
  const calls = [];
  const absent = (_program, args, options) => { calls.push({ args, options }); return { status: 0, stdout: args[0] === 'config' ? JSON.stringify({ provider: 'apple-vm' }) : '[]' }; };
  assert.equal(collection.verifyLeaseAbsent('cbx_ab12', absent, process.cwd(), { HOME: '/safe/home', GH_TOKEN: 'secret' }), 'PASS');
  assert.equal(calls.every(call => call.options.cwd === process.cwd()), true);
  assert.equal(calls.every(call => call.options.env.HOME === '/safe/home' && !Object.hasOwn(call.options.env, 'GH_TOKEN')), true);
  const present = (_program, args) => ({ status: 0, stdout: args[0] === 'config' ? JSON.stringify({ provider: 'apple-vm' }) : JSON.stringify([{ id: 'cbx_ab12' }]) });
  errorCode(() => collection.verifyLeaseAbsent('cbx_ab12', present), 'crabbox_cleanup_ambiguous');
  errorCode(() => collection.verifyLeaseAbsent('cbx_ab12', () => ({ status: 1, stdout: '' })), 'crabbox_cleanup_ambiguous');
  const wrongProvider = () => ({ status: 0, stdout: JSON.stringify({ provider: 'hetzner' }) });
  errorCode(() => collection.verifyLeaseAbsent('cbx_ab12', wrongProvider), 'crabbox_cleanup_ambiguous');
  const directory = temp();
  const archive = path.join(directory, 'run_ab12-artifacts.tgz');
  fs.writeFileSync(archive, Buffer.from('synthetic-archive'));
  const inspected = collection.inspectArchive(archive);
  assert.equal(inspected.archiveBytes, 17);
  assert.match(inspected.archiveSha256, /^[0-9a-f]{64}$/);
  errorCode(() => contract.validateCrabboxCollection({ provider: 'apple-vm', leaseId: 'cbx_ab12', runId: 'run_ab12', archive: 'run_other-artifacts.tgz', archiveBytes: 1, archiveSha256: 'd'.repeat(64), cleanup: 'PASS', durableArtifactUrl: '' }), 'invalid_crabbox_archive');
});

test('held descriptor binds bytes and hash even after pathname substitution', () => {
  const directory = temp(); const file = path.join(directory, 'archive');
  fs.writeFileSync(file, 'original');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  fs.renameSync(file, `${file}.old`); fs.writeFileSync(file, 'replaced');
  try {
    const inspected = contract.inspectDescriptor(descriptor, { regularCode: 'invalid_crabbox_archive' });
    assert.equal(inspected.bytes, 8);
    assert.equal(inspected.sha256, require('node:crypto').createHash('sha256').update('original').digest('hex'));
  } finally { fs.closeSync(descriptor); }
});

test('runner cleanup is attempted after warmup failure', () => {
  const directory = temp(); const mock = path.join(directory, 'crabbox'); const log = path.join(directory, 'calls');
  fs.writeFileSync(mock, `#!/bin/sh\necho "$1" >> "${log}"\nif test "$1" = warmup; then exit 9; fi\n`, { mode: 0o700 });
  const result = spawnSync('sh', ['.codex/tools/run_crabbox_job.sh', 'quick-check'], { cwd: path.resolve(__dirname, '../..'), env: { PATH: '/usr/bin:/bin', CRABBOX_BIN: mock }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['warmup', 'stop']);
});

test('runner cleanup is attempted when interrupted during warmup', () => {
  const directory = temp(); const mock = path.join(directory, 'crabbox'); const log = path.join(directory, 'calls');
  fs.writeFileSync(mock, `#!/bin/sh\necho "$1" >> "${log}"\nif test "$1" = warmup; then kill -TERM "$PPID"; sleep 1; fi\n`, { mode: 0o700 });
  const result = spawnSync('sh', ['.codex/tools/run_crabbox_job.sh', 'quick-check'], { cwd: path.resolve(__dirname, '../..'), env: { PATH: '/usr/bin:/bin', CRABBOX_BIN: mock }, encoding: 'utf8' });
  assert.equal(result.status, 143);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['warmup', 'stop']);
});

test('workflow fixes runner labels and binds requested ref; proof outputs are ignored', () => {
  const workflow = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/crabbox.yml'), 'utf8');
  assert.match(workflow, /runs-on: \[self-hosted, crabbox, crabbox-profile-default, crabbox-class-standard\]/);
  assert.doesNotMatch(workflow, /runs-on:.*crabbox_runner_label/);
  assert.match(workflow, /ref: \$\{\{ inputs\.ref \|\| github\.sha \}\}/);
  assert.match(workflow, /REQUESTED_REF="\$GITHUB_SHA"/);
  assert.match(workflow, /test "\$actual" = "\$expected"/);
  const ignore = fs.readFileSync(path.resolve(__dirname, '../../.gitignore'), 'utf8');
  for (const entry of ['/visual-proof-input/', '/visual-proof-output/', '/private-evidence/', '/.github/pr-assets/']) assert.equal(ignore.includes(entry), true);
});
