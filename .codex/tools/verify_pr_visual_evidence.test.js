'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const verifier = require('./verify_pr_visual_evidence');

const SHA = 'a'.repeat(40);
const MEDIA_SHA = 'b'.repeat(64);
const ARCHIVE_SHA = 'c'.repeat(64);
const URL = 'https://github.com/user-attachments/assets/abc-123';
const REPOSITORY_ID = 1165820261;
const NOT_APPLICABLE_FIELDS = {
  Scenario: 'not applicable',
  Expected: 'not applicable',
  Observed: 'not applicable',
  'Fixture class': 'not applicable',
  'Capture environment': 'not applicable',
  'Media inspection': 'not applicable',
  'Privacy review': 'not applicable',
  'Media filename': 'not applicable',
  'Media type': 'not applicable',
  'Media bytes': 'not applicable',
  'Media SHA-256': 'not applicable',
  'Collection path': 'not applicable',
  'Crabbox collection': 'not applicable',
  'Durable artifact URL': 'not applicable',
};

function body(overrides = {}) {
  const fields = {
    'UI impact': 'stateful',
    'Candidate commit': SHA,
    Rationale: 'not applicable',
    Scenario: 'Open Settings and enable the synthetic display option',
    Expected: 'The approved synthetic setting becomes enabled',
    Observed: 'The approved synthetic setting became enabled',
    'Fixture class': 'synthetic',
    'Capture environment': 'Local source candidate using synthetic fixtures',
    'Media inspection': 'PASS',
    'Privacy review': 'PASS',
    'Media filename': 'settings-proof.mp4',
    'Media type': 'video/mp4',
    'Media bytes': '1234',
    'Media SHA-256': MEDIA_SHA,
    'Collection path': 'local',
    'Crabbox collection': 'not-used',
    'Durable artifact URL': URL,
    ...overrides,
  };
  return [
    '## Summary',
    '',
    'Synthetic change.',
    '',
    '## Visual Evidence',
    '',
    ...Object.entries(fields).map(([key, value]) => `- ${key}: ${value}`),
    '',
    fields['UI impact'] === 'none' ? '' : fields['Durable artifact URL'],
    '',
    '## Risks',
    '',
    'None.',
  ].join('\n');
}

function noneBody(overrides = {}) {
  return body({
    'UI impact': 'none',
    Rationale: 'This workflow-only change cannot alter any visible Crate interface state',
    ...NOT_APPLICABLE_FIELDS,
    ...overrides,
  });
}

function event(prBody = body(), overrides = {}) {
  return {
    repository: { full_name: 'bfeintuch123/crate-app', id: REPOSITORY_ID },
    pull_request: {
      body: prBody,
      base: { ref: 'v2.4.x', repo: { full_name: 'bfeintuch123/crate-app', id: REPOSITORY_ID } },
      head: { sha: SHA },
    },
    ...overrides,
  };
}

function errorCode(fn, code) {
  assert.throws(fn, error => error && error.message === code);
}

function writeEvent(value = event()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-pr-evidence-test-'));
  const file = path.join(directory, 'event.json');
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  return { directory, file };
}

test('accepts exact-head stateful and static evidence declarations', () => {
  const stateful = verifier.validateEvent(event());
  assert.deepEqual(stateful, {
    impact: 'stateful',
    media: { name: 'settings-proof.mp4', mime: 'video/mp4', bytes: 1234, sha256: MEDIA_SHA },
    url: URL,
    crabbox: false,
    headSha: SHA,
  });
  const staticBody = body({ 'UI impact': 'static', 'Media filename': 'layout-proof.png', 'Media type': 'image/png' });
  assert.equal(verifier.validateEvent(event(staticBody)).impact, 'static');
});

test('accepts no-impact only with every media field exactly not applicable', () => {
  assert.deepEqual(verifier.validateEvent(event(noneBody())), { impact: 'none', headSha: SHA });
  errorCode(() => verifier.validateEvent(event(noneBody({ Scenario: '/Users/private/proof' }))), 'unexpected_no_impact_evidence');
  errorCode(() => verifier.validateEvent(event(noneBody({ 'Media filename': 'proof.png' }))), 'unexpected_no_impact_evidence');
  errorCode(() => verifier.validateEvent(event(noneBody({ Rationale: 'No visible effect' }))), 'ui_impact_rationale_required');
});

test('accepts exact approved Crabbox collection metadata as supplemental provenance', () => {
  const collection = `provider=apple-vm; lease=cbx_ab12; run=run_ab12; archive=run_ab12-artifacts.tgz; archive-bytes=42; archive-sha256=${ARCHIVE_SHA}; cleanup=PASS`;
  const result = verifier.validateEvent(event(body({ 'Collection path': 'crabbox-artifact', 'Crabbox collection': collection })));
  assert.equal(result.crabbox, true);
});

test('rejects missing, duplicate, placeholder, and unknown evidence content', () => {
  errorCode(() => verifier.validateEvent(event('## Summary\nNo proof')), 'visual_evidence_section_required');
  errorCode(() => verifier.validateEvent(event(`${body()}\n## Visual Evidence\n`)), 'duplicate_visual_evidence_section');
  errorCode(() => verifier.validateEvent(event(body({ Scenario: '<workflow demonstrated>' }))), 'invalid_visual_evidence_text');
  errorCode(() => verifier.validateEvent(event(body().replace('- Expected:', '- Scenario: duplicate\n- Expected:'))), 'duplicate_visual_evidence_field');
  errorCode(() => verifier.validateEvent(event(body().replace('- Expected:', '- Unknown field: value\n- Expected:'))), 'unexpected_visual_evidence_content');
  errorCode(() => verifier.validateEvent(event(body().replace('- Expected:', '```\n- Expected:'))), 'unexpected_visual_evidence_content');
});

test('requires exact column-zero section syntax and accepts normalized CRLF', () => {
  errorCode(() => verifier.validateEvent(event(body().replace('## Visual Evidence', '  ## Visual Evidence'))), 'visual_evidence_section_required');
  errorCode(() => verifier.validateEvent(event(body().replace('## Risks', '  ## Risks'))), 'unexpected_visual_evidence_content');
  assert.equal(verifier.validateEvent(event(body().replace(/\n/g, '\r\n'))).impact, 'stateful');
});

test('rejects wrong repository, base, and stale or malformed head binding', () => {
  errorCode(() => verifier.validateEvent({ ...event(), repository: { full_name: 'other/repo', id: REPOSITORY_ID } }), 'repository_identity_mismatch');
  errorCode(() => verifier.validateEvent(event(body(), { pull_request: { body: body(), base: { ref: 'main', repo: { full_name: 'bfeintuch123/crate-app', id: REPOSITORY_ID } }, head: { sha: SHA } } })), 'invalid_base_branch');
  errorCode(() => verifier.validateEvent(event(body({ 'Candidate commit': 'd'.repeat(40) }))), 'stale_visual_evidence_commit');
  errorCode(() => verifier.validateEvent(event(body(), { pull_request: { body: body(), base: { ref: 'v2.4.x', repo: { full_name: 'bfeintuch123/crate-app', id: REPOSITORY_ID } }, head: { sha: 'short' } } })), 'invalid_head_sha');
});

test('rejects wrong or missing event and base repository identities', () => {
  errorCode(() => verifier.validateEvent({ ...event(), repository: { full_name: 'bfeintuch123/crate-app', id: 1 } }), 'repository_identity_mismatch');
  errorCode(() => verifier.validateEvent({ ...event(), repository: { full_name: 'bfeintuch123/crate-app' } }), 'repository_identity_mismatch');
  errorCode(() => verifier.validateEvent(event(body(), { pull_request: { body: body(), base: { ref: 'v2.4.x', repo: { full_name: 'bfeintuch123/crate-app', id: 1 } }, head: { sha: SHA } } })), 'invalid_base_branch');
  errorCode(() => verifier.validateEvent(event(body(), { pull_request: { body: body(), base: { ref: 'v2.4.x', repo: { full_name: 'other/repo', id: REPOSITORY_ID } }, head: { sha: SHA } } })), 'invalid_base_branch');
});

test('rejects invalid stateful and static media classifications', () => {
  errorCode(() => verifier.validateEvent(event(body({ 'Media type': 'image/png', 'Media filename': 'proof.png' }))), 'stateful_video_required');
  errorCode(() => verifier.validateEvent(event(body({ 'UI impact': 'static', 'Media type': 'video/mp4' }))), 'static_image_required');
  errorCode(() => verifier.validateEvent(event(body({ 'Media filename': 'proof.webm' }))), 'media_extension_mismatch');
  errorCode(() => verifier.validateEvent(event(body({ 'Media bytes': '0' }))), 'invalid_media_bytes');
  errorCode(() => verifier.validateEvent(event(body({ 'Media SHA-256': 'bad' }))), 'invalid_media_hash');
});

test('rejects missing review gates, private text, controls, and deceptive formatting', () => {
  errorCode(() => verifier.validateEvent(event(body({ 'Media inspection': 'FAIL' }))), 'media_inspection_required');
  errorCode(() => verifier.validateEvent(event(body({ 'Privacy review': 'FAIL' }))), 'privacy_review_required');
  errorCode(() => verifier.validateEvent(event(body({ Observed: 'Stored at /Users/private/proof' }))), 'invalid_visual_evidence_text');
  errorCode(() => verifier.validateEvent(event(body({ Observed: 'Visible\u200bresult' }))), 'invalid_visual_evidence_text');
  errorCode(() => verifier.validateEvent(event(body({ Observed: 'Visible\u202eresult' }))), 'invalid_visual_evidence_text');
  errorCode(() => verifier.validateEvent(event(body({ Observed: 'Visible\u0085result' }))), 'invalid_visual_evidence_text');
});

test('rejects unsafe, missing, duplicate, or mismatched durable URLs', () => {
  errorCode(() => verifier.validateEvent(event(body({ 'Durable artifact URL': `${URL}?token=secret` }).replace(`\n${URL}?token=secret\n`, '\n'))), 'invalid_durable_artifact_url');
  errorCode(() => verifier.validateEvent(event(body().replace(`\n${URL}\n`, '\n'))), 'bare_artifact_url_mismatch');
  errorCode(() => verifier.validateEvent(event(body().replace(`\n${URL}\n`, `\n${URL}\n${URL}\n`))), 'bare_artifact_url_mismatch');
  errorCode(() => verifier.validateEvent(event(body().replace(`\n${URL}\n`, '\nhttps://github.com/user-attachments/assets/other\n'))), 'bare_artifact_url_mismatch');
});

test('rejects incomplete Crabbox evidence and collection-path mismatch', () => {
  errorCode(() => verifier.validateEvent(event(body({ 'Collection path': 'crabbox-artifact' }))), 'crabbox_collection_path_mismatch');
  errorCode(() => verifier.validateEvent(event(body({ 'Crabbox collection': 'provider=apple-vm' }))), 'invalid_crabbox_pr_evidence');
  const wrong = `provider=hetzner; lease=cbx_ab12; run=run_ab12; archive=run_ab12-artifacts.tgz; archive-bytes=42; archive-sha256=${ARCHIVE_SHA}; cleanup=PASS`;
  errorCode(() => verifier.validateEvent(event(body({ 'Collection path': 'crabbox-artifact', 'Crabbox collection': wrong }))), 'invalid_crabbox_pr_evidence');
});

test('main binds declared media to destination readback and propagates mismatch', () => {
  const { file } = writeEvent();
  let received;
  const result = verifier.main([file], { readback: (url, media) => { received = { url, media }; } });
  assert.deepEqual(received, { url: URL, media: result.media });
  errorCode(() => verifier.main([file], { readback: () => { throw new Error('readback_hash_mismatch'); } }), 'readback_hash_mismatch');
});

test('no-impact main does not perform attachment readback', () => {
  const { file } = writeEvent(event(noneBody()));
  let calls = 0;
  verifier.main([file], { readback: () => { calls += 1; } });
  assert.equal(calls, 0);
});

test('reads one bounded regular event file and rejects symlinks', () => {
  const { directory, file } = writeEvent();
  assert.equal(verifier.readEvent(file).repository.full_name, 'bfeintuch123/crate-app');
  const link = path.join(directory, 'event-link.json');
  fs.symlinkSync(file, link);
  errorCode(() => verifier.readEvent(link), 'invalid_event_file');
});

test('trusted workflow runs only base-controlled code and leaves source CI unmodified', () => {
  const workflow = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/visual-evidence-gate.yml'), 'utf8');
  const sourceGate = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/security-gate.yml'), 'utf8');
  assert.match(workflow, /^\s*pull_request_target:\s*$/m);
  assert.match(workflow, /types: \[opened, synchronize, reopened, ready_for_review, edited\]/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /node \.codex\/tools\/verify_pr_visual_evidence\.js "\$GITHUB_EVENT_PATH"/);
  assert.doesNotMatch(workflow, /^\s*pull_request:\s*$/m);
  assert.doesNotMatch(workflow, /pull_request\.head\.sha|github\.head_ref|checkout.*head/i);
  assert.doesNotMatch(sourceGate, /verify_pr_visual_evidence|Visual evidence/);
});

test('pull request template contains only parser-compatible visual evidence lines', () => {
  const template = fs.readFileSync(path.resolve(__dirname, '../../.github/pull_request_template.md'), 'utf8');
  const parsed = verifier.parseEvidenceSection(template);
  assert.deepEqual(Object.keys(parsed.fields), verifier.FIELD_NAMES);
  assert.deepEqual(parsed.bareUrls, []);
});
