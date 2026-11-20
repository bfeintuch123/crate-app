'use strict';
// Manual packaging fallback through the production main process: admission,
// scanning, verification receipts, trusted IPC, the store and the package
// write transaction. Electron, the store file and the native pickers are the
// repository's synthetic harness; every file is synthetic. Nothing here is
// native or installed-app evidence.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const harnessPath = path.join(__dirname, 'provenance-dual-write.test.js');
let harness = fs.readFileSync(harnessPath, 'utf8');
const assertAnchor = (text, anchor, label) => require('./bounded-assert').equal(text.split(anchor).length - 1, 1, label);
const testAnchor = "const test = require('node:test');";
assertAnchor(harness, testAnchor, 'harness test anchor');
harness = harness.replace(testAnchor, "const manualTest = require('node:test'); const test = new Proxy(manualTest, { apply() {} });");
const homeAnchor = "fs.mkdtempSync(path.join(os.tmpdir(), 'crate-provenance-dual-write-home-'))";
assertAnchor(harness, homeAnchor, 'harness home anchor');
harness = harness.replace(homeAnchor, "fs.mkdtempSync(path.join(path.dirname(MAIN_UNDER_TEST_ROOT), 'manual-package-home-'))");
const hookAnchor = '  captureProjectOperation,\n  runScanOnOpen';
assertAnchor(harness, hookAnchor, 'harness hook anchor');
harness = harness.replace(hookAnchor, '  getAssetBaselineSourceRecoveryRouteKey, mutateProject, getWorkingSourceVerification,\n' + hookAnchor);
// Photoshop link framing is read from the synthetic bytes, as the working-file choice tests do.
const psdAnchor = '                  psd: fixture,';
assertAnchor(harness, psdAnchor, 'harness PSD fixture anchor');
harness = harness.replace(psdAnchor, '                  psd: fixture, framing: require("../parsers/add-files-psd-worker").inspectPsdLinkFraming(fs.readFileSync(filePath)),');
const compiled = new Module(harnessPath, module);
compiled.filename = harnessPath; compiled.paths = Module._nodeModulePaths(__dirname);
compiled._compile(harness + '\n(' + cases.toString() + ')();', harnessPath);

function cases() {
  const crypto = require('node:crypto');
  const sha = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  const desktop = name => path.join(TEST_HOME, 'Desktop', name);
  function emptyPsdBytes() {
    const bytes = Buffer.alloc(40); bytes.write('8BPS'); bytes.writeUInt16BE(1, 4);
    bytes.writeUInt16BE(3, 12); bytes.writeUInt32BE(1, 14); bytes.writeUInt32BE(1, 18);
    bytes.writeUInt16BE(8, 22); bytes.writeUInt16BE(3, 24); return bytes;
  }
  // Synthetic project: Poster.ai (links Logo.png) and a second working file
  // kept with Keep both. The second file is then excluded and restored by the
  // owner, which is the explicit decision that engages working-file selection.
  async function setup({ second = 'Flyer.ai', breakSecond = true, hold = null } = {}) {
    resetTestHomeWorkspace(); setPresentationUnzipFixture([]);
    currentPsdFixture = { children: [], linkedFiles: [] };
    const project = await createProject('Manual fallback');
    await callIpcRaw('projects:pause', project.id); clearTrackedTimers();
    const id = project.id;
    const stored = () => storeInstance.data.projects.find(item => item.id === id);
    const workspace = () => callIpcRaw('projects:get-asset-workspace', id);
    const logo = desktop('Logo.png'); fs.writeFileSync(logo, 'synthetic logo bytes');
    const add = async (name, content) => {
      const target = desktop(name);
      if (name.endsWith('.psd')) fs.writeFileSync(target, emptyPsdBytes()); else writeSyntheticAiFile(target, content ?? logo);
      manualDialogFor([target]);
      await callIpcRaw('projects:add-files', id);
      return target;
    };
    const poster = await add('Poster.ai');
    assert.equal((await callIpcRaw('projects:set-existing-assets-decision', id, 'include')).success, true);
    const flyer = await add(second);
    const card = (await workspace()).workingFileChoices.choices[0];
    assert.ok(card?.ready, JSON.stringify(card));
    assert.equal((await callIpcRaw('projects:resolve-working-file-choice', id, { id: card.id, revision: card.revision, choice: 'keep-both', predecessorIdentity: null })).success, true);
    const row = async name => (await workspace()).files.find(file => file.name === name);
    const select = async (name, action) => {
      const current = await row(name);
      return callIpcRaw('projects:set-working-source-selection', id, current.visualIdentity, { action, expectedRevision: current.selectionRevision });
    };
    assert.equal((await select(second, 'exclude')).success, true);
    if (breakSecond) fs.writeFileSync(flyer, '%PDF-1.7\nmissing EOF');
    if (hold) hold();
    assert.equal((await select(second, 'restore')).success, true);
    const review = () => callIpcRaw('projects:prepare-package-review', id);
    const retry = () => callIpcRaw('projects:retry-package-verification', id);
    const begin = () => callIpcRaw('projects:begin-manual-package', id);
    const choose = (sessionId, paths) => { manualDialogFor(paths); return callIpcRaw('projects:manual-package-choose-files', id, sessionId); };
    const commit = (sessionId, ids, outputPath, expectedCount = ids.length) =>
      callIpcRaw('projects:package-manual', id, sessionId, { includedIds: ids, expectedCount }, outputPath);
    const out = path.join(TEST_HOME, 'Out-' + crypto.randomUUID().slice(0, 8));
    fs.mkdirSync(out, { recursive: true });
    const receipt = name => {
      const file = stored().files.find(item => path.basename(item.path) === name);
      return metadataTestHooks.getWorkingSourceVerification(stored(), file);
    };
    return { id, stored, workspace, poster, flyer, logo, add, select, review, retry, begin, choose, commit, out, receipt };
  }
  const listOutput = dir => fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).sort() : [];
  const stagingLeft = dir => listOutput(dir).filter(name => name.includes('.crate-package-staging-'));

  manualTest('Illustrator: failed reading after Restore offers Retry; a failed Retry opens a byte-exact manual package that changes nothing in the project', async () => {
    const f = await setup();
    // First reading after the explicit Restore failed on bytes that changed.
    let review = await f.review();
    assert.equal(review.materializable, false);
    assert.equal(typeof review.token, 'undefined', 'no normal review token while verification failed');
    assert.deepEqual(review.verificationFallback, { version: 1, reason: 'changed', retry: true, manual: false });
    assert.ok(Array.isArray(review.files) && review.files.length === 3, 'the file list stays available');
    assert.equal((await f.begin()).error, 'manual_package_unavailable', 'no manual mode before an explicit Retry');
    assert.equal((await callIpcRaw('projects:package', f.id, f.out, 'a'.repeat(32))).error !== undefined, true);
    // Explicit Retry reads the file again; it fails again.
    const originals = new Map([f.poster, f.flyer, f.logo].map(file => [file, sha(file)]));
    assert.deepEqual(await f.retry(), { success: true });
    assert.equal(f.receipt('Flyer.ai').status, 'failed');
    review = await f.review();
    assert.equal(review.materializable, false);
    assert.equal(typeof review.token, 'undefined');
    assert.deepEqual(review.verificationFallback, { version: 1, reason: 'failed', retry: true, manual: true });
    // Manual mode lists only confirmed Included files on disk now.
    const storeBefore = JSON.stringify(storeInstance.data.projects);
    const begun = await f.begin();
    assert.equal(typeof begun.sessionId, 'string');
    assert.deepEqual(begun.files.map(file => [file.name, file.role, file.origin]).sort(),
      [['Flyer.ai', 'source', null], ['Logo.png', 'asset', 'existing'], ['Poster.ai', 'source', null]]);
    assert.equal(JSON.stringify(begun).includes(TEST_HOME), false, 'no absolute paths reach the window');
    // Choose Files: native picker only; listed for this package, never added to the project.
    const brief = path.join(TEST_HOME, 'Documents', 'Brief.pdf');
    fs.mkdirSync(path.dirname(brief), { recursive: true }); fs.writeFileSync(brief, 'synthetic brief');
    const hidden = path.join(TEST_HOME, 'Documents', '.hidden.png'); fs.writeFileSync(hidden, 'hidden');
    const font = path.join(TEST_HOME, 'Documents', 'Brand.otf'); fs.writeFileSync(font, 'font');
    const link = path.join(TEST_HOME, 'Documents', 'Link.png'); fs.symlinkSync(f.logo, link);
    const chosen = await f.choose(begun.sessionId, [brief, f.logo, hidden, font, link, path.join(TEST_HOME, 'missing.png')]);
    assert.equal(chosen.addedIds.length, 1);
    assert.deepEqual(chosen.matchedIds, [begun.files.find(file => file.name === 'Logo.png').id], 'the same file is listed once');
    assert.deepEqual(chosen.refused.map(item => item.reason).sort(), ['font', 'hidden-or-invalid', 'unavailable', 'unavailable']);
    assert.equal(chosen.files.find(file => file.id === chosen.addedIds[0]).role, 'chosen');
    assert.equal(JSON.stringify(storeInstance.data.projects), storeBefore, 'choosing files does not touch the project');
    // Package Poster.ai, Flyer.ai and Brief.pdf; Logo.png stays out although Poster.ai links it.
    const ids = chosen.files.filter(file => file.name !== 'Logo.png').map(file => file.id);
    const usageBefore = storeInstance.data.usage.packagesThisMonth;
    const result = await f.commit(begun.sessionId, ids, f.out);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.manual, true);
    assert.equal(result.copiedCount, 3);
    const folder = path.basename(result.folderPath);
    assert.deepEqual(listOutput(f.out), [folder, `${folder}/Brief.pdf`, `${folder}/Flyer.ai`, `${folder}/Poster.ai`],
      'exactly the Included files; no linked asset, hidden file or diagnostics added');
    for (const [name, source] of [['Brief.pdf', brief], ['Flyer.ai', f.flyer], ['Poster.ai', f.poster]]) {
      assert.equal(sha(path.join(result.folderPath, name)), sha(source), name);
    }
    for (const [file, digest] of originals) assert.equal(sha(file), digest, 'originals are never written');
    assert.equal(JSON.stringify(storeInstance.data.projects), storeBefore, 'no project, status, provenance or watch change');
    assert.equal(f.stored().status, 'paused');
    assert.equal(storeInstance.data.usage.packagesThisMonth, usageBefore + 1, 'a manual package counts like Quick Package');
    assert.ok(storeInstance.data.quickPackageOutputPaths.includes(path.resolve(result.folderPath)), 'watchers never capture the copies');
    // The session is spent; normal packaging is still blocked.
    assert.equal((await f.commit(begun.sessionId, ids, f.out)).error, 'manual_package_stale');
    review = await f.review();
    assert.equal(review.materializable, false);
    assert.equal(review.verificationFallback.manual, true, 'the failure is not reported as passed');
  });

  manualTest('Retry success gives a fresh normal review, never packages, and retires manual mode', async () => {
    const f = await setup();
    await f.retry();
    const begun = await f.begin();
    assert.equal(typeof begun.sessionId, 'string');
    writeSyntheticAiFile(f.flyer, f.logo);
    assert.deepEqual(await f.retry(), { success: true });
    assert.deepEqual(listOutput(f.out), [], 'Retry never writes a package');
    const review = await f.review();
    assert.equal(review.materializable, true, JSON.stringify(review.message));
    assert.equal(typeof review.token, 'string');
    assert.equal(review.verificationFallback, undefined);
    assert.equal(f.stored().status, 'paused', 'no automatic package');
    assert.equal(f.stored().packagedAt, null);
    assert.equal((await f.begin()).error, 'manual_package_unavailable');
    const ids = begun.files.map(file => file.id);
    assert.equal((await f.commit(begun.sessionId, ids, f.out)).error, 'package_review_changed', 'an older manual session cannot export');
    assert.deepEqual(listOutput(f.out), []);
    assert.equal((await f.retry()).error, 'package_verification_retry_unavailable');
  });

  manualTest('Illustrator mid-session: a verified selected file whose later reading fails offers the same fallback', async () => {
    const f = await setup({ breakSecond: false });
    let review = await f.review();
    assert.equal(review.materializable, true, 'verified after Restore');
    fs.writeFileSync(f.poster, '%PDF-1.7\nmissing EOF');
    const operation = metadataTestHooks.captureProjectOperation(f.id);
    try {
      await metadataTestHooks.runScanOnOpen(f.id, f.poster, operation.activationToken, operation,
        { allowPausedBaseline: true, verifySelectedSource: true, establishBaseline: false });
    } finally { operation.close(); }
    assert.equal(f.receipt('Poster.ai').status, 'failed');
    review = await f.review();
    assert.equal(review.materializable, false);
    assert.ok(review.verificationFallback, JSON.stringify(review.message));
    assert.equal(review.verificationFallback.manual, false);
    await f.retry();
    review = await f.review();
    assert.deepEqual(review.verificationFallback, { version: 1, reason: 'failed', retry: true, manual: true });
  });

  manualTest('Photoshop: a timed-out reading after Restore and a timed-out Retry offer the fallback; stale attempts cannot pass it', { timeout: 30000 }, async () => {
    const timer = global.setTimeout, pause = ms => new Promise(resolve => timer(resolve, ms));
    // The established harness scales only the production 30 s scan deadline.
    global.setTimeout = (callback, delay, ...args) => timer(callback, delay === 30000 ? 250 : delay, ...args);
    let held = false, release = () => {}, gate = null, inflight = 0;
    // One gate until drain releases it, however many readings wait on it.
    const hold = () => { if (held) return; held = true; gate = new Promise(resolve => { release = resolve; }); };
    const unpause = metadataTestHooks.pausePsdExtraction(async () => { if (!held) return; inflight++; try { await gate; } finally { inflight--; } });
    const drain = async () => { held = false; release(); while (inflight) await pause(5); await pause(50); };
    try {
      const f = await setup({ second: 'Cover.psd', breakSecond: false, hold });
      assert.equal(f.receipt('Cover.psd').status, 'failed');
      let review = await f.review();
      assert.deepEqual(review.verificationFallback, { version: 1, reason: 'timed-out', retry: true, manual: false });
      assert.equal((await f.begin()).error, 'manual_package_unavailable');
      hold();
      const pending = f.retry();
      await pause(20);
      assert.equal((await f.retry()).error, 'package_verification_busy', 'overlapping Retry is refused');
      assert.deepEqual(await pending, { success: true });
      review = await f.review();
      assert.deepEqual(review.verificationFallback, { version: 1, reason: 'timed-out', retry: true, manual: true });
      await drain();
      review = await f.review();
      assert.equal(review.verificationFallback?.manual, true, 'a late, retired scan cannot publish');
      const begun = await f.begin();
      assert.ok(begun.files.some(file => file.name === 'Cover.psd'));
      const result = await f.commit(begun.sessionId, begun.files.map(file => file.id), f.out);
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(sha(path.join(result.folderPath, 'Cover.psd')), sha(desktop('Cover.psd')));
      // Retry with the reader free verifies normally.
      assert.deepEqual(await f.retry(), { success: true });
      review = await f.review();
      assert.equal(review.materializable, true);
      assert.equal(review.verificationFallback, undefined);
    } finally { held = false; release(); unpause(); global.setTimeout = timer; await pause(50); }
  });

  manualTest('Out of scope: an unanswered working-file choice with a failed reading is never eligible, even beside an eligible failure', async () => {
    const f = await setup();
    await f.retry();
    assert.equal((await f.review()).verificationFallback?.manual, true);
    // A new working file whose own reading fails creates an unanswered choice.
    const extra = await f.add('Extra.ai', '');
    fs.writeFileSync(extra, '%PDF-1.7\nmissing EOF');
    const card = (await f.workspace()).workingFileChoices.choices.find(item => item.source.name === 'Extra.ai');
    assert.ok(card, 'a working-file choice is pending');
    await callIpcRaw('projects:resolve-working-file-choice', f.id, { id: card.id, revision: card.revision, choice: 'retry', predecessorIdentity: null });
    const failedCard = (await f.workspace()).workingFileChoices.choices.find(item => item.source.name === 'Extra.ai');
    assert.equal(failedCard.ready, false);
    assert.equal(failedCard.reason, 'working-file-verification-failed');
    const review = await f.review();
    assert.equal(review.error, 'working_file_choice_required');
    assert.equal(review.verificationFallback, undefined);
    assert.equal((await f.retry()).error, 'package_verification_retry_unavailable');
    assert.equal((await f.begin()).error, 'manual_package_unavailable');
  });

  for (const control of ['source-unavailable', 'missing-required-reference', 'format-finding', 'save-required', 'excluded-required-source']) {
    manualTest(`Out of scope: ${control} keeps packaging blocked with no Retry or manual mode`, async () => {
      const f = await setup();
      await f.retry();
      assert.equal((await f.review()).verificationFallback?.manual, true, 'eligible before the control');
      const key = metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(), f.stored().files.find(file => file.path === f.flyer));
      if (control === 'source-unavailable') fs.rmSync(f.flyer);
      if (control === 'missing-required-reference') fs.rmSync(f.logo);
      if (control === 'format-finding') {
        metadataTestHooks.mutateProject(f.id, project => {
          project.workingSourceVerification[key] = { ...project.workingSourceVerification[key], status: 'scanned',
            sourceIdentity: { ...project.workingSourceVerification[key].sourceIdentity }, unresolved: [{ reason: 'unsupported-link-form' }] };
          return true;
        });
      }
      if (control === 'save-required') {
        metadataTestHooks.mutateProject(f.id, project => { project.workingFileDirtyHolds = { version: 1, records: { [key]: { version: 1 } } }; return true; });
      }
      if (control === 'excluded-required-source') {
        // Poster.ai links Flyer.ai: an excluded working file still required as an asset.
        writeSyntheticAiFile(f.poster, f.flyer);
        await callIpcRaw('projects:pause', f.id);
        assert.equal((await f.select('Flyer.ai', 'exclude')).success, true);
      }
      const review = await f.review();
      assert.equal(review.materializable === true && typeof review.token === 'string', false);
      assert.equal(review.verificationFallback, undefined, JSON.stringify(review.verificationFallback));
      assert.equal((await f.retry()).error === undefined, false);
      assert.equal((await f.begin()).error, 'manual_package_unavailable');
    });
  }

  manualTest('Commit refuses changed, missing, colliding, unknown or miscounted selections before any output', async () => {
    const f = await setup();
    await f.retry();
    const begun = await f.begin();
    const ids = begun.files.map(file => file.id);
    // Request shape.
    for (const [request, label] of [
      [{ includedIds: [], expectedCount: 0 }, 'empty'],
      [{ includedIds: ids, expectedCount: ids.length - 1 }, 'miscounted'],
      [{ includedIds: [ids[0], ids[0]], expectedCount: 2 }, 'duplicate'],
      [{ includedIds: ids, expectedCount: ids.length, extra: true }, 'extra field'],
    ]) assert.equal((await callIpcRaw('projects:package-manual', f.id, begun.sessionId, request, f.out)).error, 'manual_package_invalid', label);
    assert.equal((await f.commit(begun.sessionId, [...ids, 'not-a-listed-file'], f.out)).error, 'manual_package_stale');
    assert.equal((await f.commit('a'.repeat(36), ids, f.out)).error, 'manual_package_stale');
    assert.equal((await callIpcRaw('projects:package-manual', 'another-project', begun.sessionId, { includedIds: ids, expectedCount: ids.length }, f.out)).error, 'manual_package_stale');
    // A same-named file from another folder collides (case-insensitive).
    const other = path.join(TEST_HOME, 'Documents', 'LOGO.png');
    const notes = path.join(TEST_HOME, 'Documents', 'Notes.txt');
    fs.mkdirSync(path.dirname(other), { recursive: true }); fs.writeFileSync(other, 'another logo'); fs.writeFileSync(notes, 'notes');
    const chosen = await f.choose(begun.sessionId, [other, notes]);
    const idOf = name => chosen.files.find(file => file.name === name).id;
    const collision = await f.commit(begun.sessionId, chosen.files.map(file => file.id), f.out);
    assert.equal(collision.error, 'manual_package_name_collision');
    assert.deepEqual(collision.names, ['Logo.png']);
    assert.deepEqual(listOutput(f.out), []);
    // An asset changed and a chosen file deleted after listing.
    fs.appendFileSync(f.logo, ' changed after listing');
    fs.rmSync(notes);
    const changed = await f.commit(begun.sessionId, chosen.files.filter(file => file.name !== 'LOGO.png').map(file => file.id), f.out);
    assert.equal(changed.error, 'manual_package_files_changed');
    assert.deepEqual(changed.ids.sort(), [idOf('Logo.png'), idOf('Notes.txt')].sort());
    assert.deepEqual(listOutput(f.out), [], 'nothing is written, not even a staging folder');
    // Choosing the changed file again lists its current bytes; then it packages.
    const again = await f.choose(begun.sessionId, [f.logo]);
    assert.deepEqual(again.matchedIds, [idOf('Logo.png')]);
    const result = await f.commit(begun.sessionId, ids, f.out);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(sha(path.join(result.folderPath, 'Logo.png')), sha(f.logo));
    assert.deepEqual(listOutput(f.out).length, 4);
  });

  manualTest('Included files that cannot be copied as they are (missing, fonts) are counted, never listed or guessed', async () => {
    const f = await setup();
    const extra = desktop('Extra.png'), font = desktop('Brand.otf');
    fs.writeFileSync(extra, 'extra'); fs.writeFileSync(font, 'synthetic font');
    manualDialogFor([extra, font]);
    await callIpcRaw('projects:add-files', f.id);
    assert.ok(['Extra.png', 'Brand.otf'].every(name => f.stored().files.some(file => path.basename(file.path) === name)));
    fs.rmSync(extra);
    await f.retry();
    assert.equal((await f.review()).verificationFallback?.manual, true);
    const begun = await f.begin();
    assert.deepEqual(begun.files.map(file => file.name).sort(), ['Flyer.ai', 'Logo.png', 'Poster.ai']);
    assert.equal(begun.omittedCount, 2);
  });

  manualTest('A selected working file changed after listing retires the manual session', async () => {
    const f = await setup();
    await f.retry();
    const begun = await f.begin();
    fs.appendFileSync(f.poster, '\n% saved again');
    assert.equal((await f.commit(begun.sessionId, begun.files.map(file => file.id), f.out)).error, 'package_review_changed');
    assert.deepEqual(listOutput(f.out), []);
  });

  manualTest('Commit binds the project, account, destination and failure; it never overwrites and cleans up after a failed copy', async () => {
    const f = await setup();
    await f.retry();
    let begun = await f.begin();
    let ids = begun.files.map(file => file.id);
    // Destination that is not a folder.
    const notFolder = path.join(TEST_HOME, 'not-a-folder.txt'); fs.writeFileSync(notFolder, 'x');
    assert.equal((await f.commit(begun.sessionId, ids, notFolder)).error, 'package_output_changed');
    const linkedOut = path.join(TEST_HOME, 'Out-link'); fs.symlinkSync(f.out, linkedOut);
    assert.equal((await f.commit(begun.sessionId, ids, linkedOut)).error, 'package_output_changed', 'a symlinked folder is refused');
    // An existing package folder of the same name is never overwritten.
    const sentinelFolder = path.join(f.out, begun.folderName);
    fs.mkdirSync(sentinelFolder); fs.writeFileSync(path.join(sentinelFolder, 'keep.txt'), 'keep');
    // A failed copy leaves no output and no staging folder.
    const originalOpen = fs.promises.open;
    fs.promises.open = async (target, ...args) => {
      if (String(target).includes('.crate-package-staging-') && args[0] !== 'wx' && typeof args[0] === 'number') throw Object.assign(new Error('synthetic read failure'), { code: 'EIO' });
      return originalOpen.call(fs.promises, target, ...args);
    };
    let failed;
    try { failed = await f.commit(begun.sessionId, ids, f.out); } finally { fs.promises.open = originalOpen; }
    assert.equal(failed.error, 'package_write_failed', JSON.stringify(failed));
    assert.deepEqual(listOutput(f.out), [begun.folderName, `${begun.folderName}/keep.txt`]);
    assert.deepEqual(stagingLeft(path.dirname(f.out)), []);
    const result = await f.commit(begun.sessionId, ids, f.out);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(path.basename(result.folderPath), `${begun.folderName}_1`);
    assert.equal(fs.readFileSync(path.join(sentinelFolder, 'keep.txt'), 'utf8'), 'keep');
    // A project change after listing retires the session.
    begun = await f.begin(); ids = begun.files.map(file => file.id);
    const later = desktop('Later.png'); fs.writeFileSync(later, 'later');
    metadataTestHooks.mutateProject(f.id, project => {
      project.files.push({ path: later, name: 'Later.png', ext: '.png', addedAt: Date.now(), source: 'manual-browse', assetOrigin: 'added', projectRole: 'asset' });
      return true;
    });
    assert.equal((await f.commit(begun.sessionId, ids, f.out)).error, 'package_review_changed');
    // An account change retires every session and Retry record.
    metadataTestHooks.mutateProject(f.id, project => { project.files = project.files.filter(file => file.path !== later); return true; });
    begun = await f.begin(); ids = begun.files.map(file => file.id);
    await testAccountSession.logout(); await testAccountSession.restore();
    assert.equal((await f.commit(begun.sessionId, ids, f.out)).error, 'manual_package_stale');
    assert.equal((await f.review()).verificationFallback?.manual, false, 'a new account session needs its own Retry');
  });

  manualTest('Package Project with an old review token stays blocked; ordinary packaging is unchanged after recovery', async () => {
    const f = await setup({ breakSecond: false });
    const ready = await f.review();
    assert.equal(ready.materializable, true);
    fs.writeFileSync(f.flyer, '%PDF-1.7\nmissing EOF');
    const operation = metadataTestHooks.captureProjectOperation(f.id);
    try {
      await metadataTestHooks.runScanOnOpen(f.id, f.flyer, operation.activationToken, operation,
        { allowPausedBaseline: true, verifySelectedSource: true, establishBaseline: false });
    } finally { operation.close(); }
    const stale = await callIpcRaw('projects:package', f.id, f.out, ready.token);
    assert.equal(stale.success, undefined, 'the earlier token cannot package a failed verification');
    assert.deepEqual(listOutput(f.out), []);
    writeSyntheticAiFile(f.flyer, f.logo);
    await f.retry();
    const review = await f.review();
    assert.equal(review.materializable, true);
    const packaged = await callIpcRaw('projects:package', f.id, f.out, review.token);
    assert.equal(packaged.success, true, JSON.stringify(packaged));
    assert.equal(f.stored().status, 'packaged', 'normal packaging keeps its own completion');
  });
}
