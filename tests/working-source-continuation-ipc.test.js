'use strict';

// Run production main/IPC/store/package gates with the existing dependency-free
// Electron harness. Files are synthetic; OS scripting and Adobe are modeled.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const harnessPath = path.join(__dirname, 'provenance-dual-write.test.js');
let harness = fs.readFileSync(harnessPath, 'utf8');
function replaceOnce(before, after) {
  assert.equal(harness.split(before).length - 1, 1, `A1 adapter v1 drift: ${before}`);
  harness = harness.replace(before, after);
}
replaceOnce("const test = require('node:test');", "const continuationTest = require('node:test'); const test = new Proxy(continuationTest, { apply() {} });");
replaceOnce("fs.mkdtempSync(path.join(os.tmpdir(), 'crate-provenance-dual-write-home-'))",
  "fs.mkdtempSync(path.join(path.dirname(MAIN_UNDER_TEST_ROOT), 'continuation-synthetic-home-'))");
replaceOnce('  captureProjectOperation,\n  runScanOnOpen',
  '  recordWorkingSourceContinuationCandidate, refreshWorkingSourceLocators, getWorkingSourceSelection, getWorkingSourceVerification, getAssetBaselineSourceRecoveryRouteKey,\n  captureProjectOperation,\n  runScanOnOpen');
const compiled = new Module(harnessPath, module);
compiled.filename = harnessPath;
compiled.paths = Module._nodeModulePaths(__dirname);
compiled._compile(harness + '\n(' + continuationCases.toString() + ')();\n', harnessPath);

function continuationCases() {
  async function fixture() {
    resetTestHomeWorkspace();
    setChildProcessHandler(() => ({ stdout: '' }));
    const project = await createProject('Synthetic continuation');
    await callIpcRaw('projects:pause', project.id);
    clearTrackedTimers();
    const files = ['Original.ai', 'Successor.ai', 'Unrelated.ai'].map(name => {
      const sourcePath = path.join(TEST_HOME, 'Desktop', name);
      fs.writeFileSync(sourcePath, '%PDF-1.7\n%%EOF\n');
      return { fileId: name, path: sourcePath, name, ext: '.ai', projectRole: 'source', source: 'user-added', addedAt: Date.now() };
    });
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    stored.files = files; stored.pendingFiles = [];
    stored.assetBaseline = { schemaVersion: 1, status: 'legacy-included', decision: 'include', establishedAt: Date.now() };
    roundTripFakeStore();
    return { id: project.id, files, stored: () => storeInstance.data.projects.find(item => item.id === project.id) };
  }
  function request(candidate, choice) {
    return { pairIdentity: candidate.pairIdentity, evidenceIdentity: candidate.evidenceIdentity, expectedRevision: candidate.revision,
      predecessorSelectionRevision: candidate.predecessor.selectionRevision, successorSelectionRevision: candidate.successor.selectionRevision, choice };
  }
  continuationTest('real IPC gates only the unresolved included pair, then Keep both survives reload and yields a fresh package token', async () => {
    const f = await fixture();
    const before = await callIpcRaw('projects:prepare-package-review', f.id);
    assert.equal(before.materializable, true);
    assert.ok(metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.files[0].path, f.files[1].path));
    const workspace = await callIpcRaw('projects:get-asset-workspace', f.id);
    assert.equal(workspace.sourceContinuation.version, 1);
    assert.equal(workspace.sourceContinuation.candidates.length, 1);
    assert.equal(JSON.stringify(workspace.sourceContinuation).includes(TEST_HOME), false);
    const blocked = await callIpcRaw('projects:prepare-package-review', f.id);
    assert.equal(blocked.error, 'working_source_continuation_choice_required');
    assert.equal(blocked.projectId, f.id);
    assert.equal(blocked.token, undefined);
    assert.equal((await callIpcRaw('projects:package', f.id, TEST_HOME, before.token)).error, 'package_review_stale');
    const candidate = blocked.sourceContinuation.candidates[0];
    const decision = await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(candidate, 'keep-both'));
    assert.equal(decision.success, true);
    assert.equal(decision.projectId, f.id);
    roundTripFakeStore();
    assert.equal((await callIpcRaw('projects:get-asset-workspace', f.id)).sourceContinuation.candidates.length, 0);
    const after = await callIpcRaw('projects:prepare-package-review', f.id);
    assert.equal(after.materializable, true);
    assert.equal(after.totalFiles, 3);
    assert.notEqual(after.token, before.token);
  });
  continuationTest('real IPC Replace verifies successor before selection and retains a genuine predecessor dependency', async () => {
    const f = await fixture();
    fs.writeFileSync(f.files[1].path, `%PDF-1.7\n${f.files[0].path}\n%%EOF\n`);
    metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.files[0].path, f.files[1].path);
    const workspace = await callIpcRaw('projects:get-asset-workspace', f.id);
    const decision = await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(workspace.sourceContinuation.candidates[0], 'replace'));
    assert.equal(decision.success, true);
    assert.equal(decision.projectId, f.id);
    const updated = await callIpcRaw('projects:get-asset-workspace', f.id);
    const predecessor = updated.files.find(file => file.name === 'Original.ai');
    assert.equal(predecessor.sourceSelection, 'excluded');
    assert.equal(predecessor.selectionReason, 'continuation-replaced');
    assert.equal(predecessor.includedAsDependency, true);
    assert.equal(predecessor.effectiveRole, 'asset');
    assert.equal(updated.files.find(file => file.name === 'Successor.ai').verificationStatus, 'scanned');
    const review = await callIpcRaw('projects:prepare-package-review', f.id);
    assert.equal(review.materializable, true);
    assert.equal(review.totalFiles, 3);
  });
  continuationTest('real IPC holds the selected original for an excluded successor and verifies explicit Replace before restoring it', async () => {
    const f = await fixture();
    const initial = await callIpcRaw('projects:get-asset-workspace', f.id);
    const successor = initial.files.find(file => file.name === 'Successor.ai');
    assert.equal((await callIpcRaw('projects:set-working-source-selection', f.id, successor.visualIdentity,
      { action: 'exclude', expectedRevision: 0 })).success, true);
    const before = await callIpcRaw('projects:prepare-package-review', f.id);
    assert.equal(before.materializable, true);
    assert.equal(before.totalFiles, 2);
    assert.ok(metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.files[0].path, f.files[1].path));
    const blocked = await callIpcRaw('projects:prepare-package-review', f.id);
    assert.equal(blocked.error, 'working_source_continuation_choice_required');
    assert.equal(blocked.token, undefined);
    const candidate = blocked.sourceContinuation.candidates[0];
    assert.equal(candidate.successor.selectionState, 'excluded');
    assert.equal(candidate.successor.admissionState, 'accepted');
    const result = await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(candidate, 'replace'));
    assert.equal(result.success, true, JSON.stringify({ result, verification: f.stored().workingSourceVerification }));
    const updated = await callIpcRaw('projects:get-asset-workspace', f.id);
    assert.equal(updated.files.find(file => file.name === 'Original.ai').selectionReason, 'continuation-replaced');
    assert.equal(updated.files.find(file => file.name === 'Successor.ai').sourceSelection, 'selected');
    assert.equal(updated.files.find(file => file.name === 'Successor.ai').verificationStatus, 'scanned');
    assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).materializable, true);
  });
  continuationTest('real IPC pending successor blocks the original but cannot be admitted by Replace or Keep both', async () => {
    const f = await fixture();
    f.stored().files = [f.files[0], f.files[2]];
    f.stored().pendingFiles = [f.files[1]];
    roundTripFakeStore();
    assert.ok(metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.files[0].path, f.files[1].path));
    const blocked = await callIpcRaw('projects:prepare-package-review', f.id);
    assert.equal(blocked.error, 'working_source_continuation_choice_required');
    const candidate = blocked.sourceContinuation.candidates[0];
    assert.equal(candidate.successor.admissionState, 'pending');
    assert.equal(candidate.replaceRequires, 'successor-admission');
    const before = JSON.stringify(f.stored());
    assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(candidate, 'replace'))).error,
      'continuation_admission_required');
    assert.equal(JSON.stringify(f.stored()), before);
    assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, request(candidate, 'keep-both'))).success, true);
    roundTripFakeStore();
    assert.equal(f.stored().files.length, 2);
    assert.equal(f.stored().pendingFiles.length, 1);
    assert.equal((await callIpcRaw('projects:get-asset-workspace', f.id)).sourceContinuation.candidates.length, 0);
    assert.equal((await callIpcRaw('projects:prepare-package-review', f.id)).totalFiles, 2);
  });
  continuationTest('real filesystem rename preserves exclusion and rejects inheritance at the old path', async () => {
    const f = await fixture();
    const workspace = await callIpcRaw('projects:get-asset-workspace', f.id);
    const original = workspace.files.find(file => file.name === 'Original.ai');
    await callIpcRaw('projects:set-working-source-selection', f.id, original.visualIdentity, { action: 'exclude', expectedRevision: 0 });
    const destination = path.join(TEST_HOME, 'Desktop', 'Moved.ai');
    fs.renameSync(f.files[0].path, destination);
    await metadataTestHooks.refreshWorkingSourceLocators(f.id, [destination]);
    let stored = f.stored();
    const moved = stored.files.find(file => file.path === destination);
    assert.ok(moved);
    assert.equal(metadataTestHooks.getWorkingSourceSelection(stored, moved).reason, 'user-excluded');
    fs.writeFileSync(f.files[0].path, '%PDF-1.7\nunrelated new file\n%%EOF\n');
    stored.files.push({ ...f.files[0], fileId: 'new-old-path-occupant' });
    roundTripFakeStore(); stored = f.stored();
    assert.equal(metadataTestHooks.getWorkingSourceSelection(stored, stored.files.find(file => file.path === f.files[0].path)).revision, 0);
    assert.equal(metadataTestHooks.getWorkingSourceSelection(stored, stored.files.find(file => file.path === destination)).reason, 'user-excluded');
  });
  continuationTest('real pair receiver rejects foreign project, forged proof fields, stale revision and replay without changing either intent', async () => {
    const f = await fixture();
    metadataTestHooks.recordWorkingSourceContinuationCandidate(f.id, f.files[0].path, f.files[1].path);
    const blocked = await callIpcRaw('projects:prepare-package-review', f.id);
    const command = request(blocked.sourceContinuation.candidates[0], 'keep-both');
    const before = JSON.stringify(f.stored());
    assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', 'foreign-project', command)).success, false);
    assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, { ...command, authority: 'app-operation' })).error, 'invalid_continuation_request');
    assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, { ...command, expectedRevision: 0 })).error, 'continuation_stale');
    assert.equal(JSON.stringify(f.stored()), before);
    assert.equal((await callIpcRaw('projects:prepare-package-review', 'foreign-project')).error, 'not_found');
    const success = await callIpcRaw('projects:resolve-working-source-continuation', f.id, command);
    assert.equal(success.projectId, f.id);
    const committed = JSON.stringify(f.stored());
    assert.equal((await callIpcRaw('projects:resolve-working-source-continuation', f.id, command)).error, 'continuation_stale');
    assert.equal(JSON.stringify(f.stored()), committed);
  });
}
