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
harness = harness.replace(homeAnchor, "(() => { const parent = path.dirname(MAIN_UNDER_TEST_ROOT); const base = parent.split(path.sep).some(part => part.startsWith('.')) ? path.join(os.homedir(), 'Library', 'Caches') : parent; fs.mkdirSync(base, { recursive: true }); return fs.mkdtempSync(path.join(base, 'manual-package-home-')); })()");
const hookAnchor = '  captureProjectOperation,\n  runScanOnOpen';
assertAnchor(harness, hookAnchor, 'harness hook anchor');
harness = harness.replace(hookAnchor, '  getAssetBaselineSourceRecoveryRouteKey, mutateProject, getWorkingSourceVerification,\n' +
  '  isManualPackageInDesignFile, findManualPackageItem, isAutoCaptureExcludedPath,\n' +
  '  reconcilePendingManualPackageCompletions,\n' +
  '  interceptRegexWorker(handler) {\n' +
  '    const original = runAddFilesRegexWorker;\n' +
  '    runAddFilesRegexWorker = async (filePath, scanLease) => handler(filePath, scanLease, () => original(filePath, scanLease));\n' +
  '    return () => { runAddFilesRegexWorker = original; };\n' +
  '  },\n' + hookAnchor);
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
        const operation = metadataTestHooks.captureProjectOperation(f.id);
        try {
          await metadataTestHooks.runScanOnOpen(f.id, f.poster, operation.activationToken, operation,
            { allowPausedBaseline: true, verifySelectedSource: true, establishBaseline: false });
        } finally { operation.close(); }
        assert.equal(f.receipt('Poster.ai').status, 'scanned', 'Poster.ai is verified again, now requiring Flyer.ai');
        assert.equal((await f.select('Flyer.ai', 'exclude')).success, true);
        assert.equal((await f.workspace()).files.find(file => file.name === 'Flyer.ai').includedAsDependency, true);
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
      if (String(target).includes('.crate-package-staging-')) throw Object.assign(new Error('synthetic write failure'), { code: 'EIO' });
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

  manualTest('An interrupted Retry settles safely without stranding pending or overwriting newer receipts, and never unlocks manual mode', { timeout: 30000 }, async () => {
    const timer = global.setTimeout, pause = ms => new Promise(resolve => timer(resolve, ms));
    let held = false, release = () => {}, gate = null, inflight = 0;
    const hold = () => { if (held) return; held = true; gate = new Promise(resolve => { release = resolve; }); };
    const unpause = metadataTestHooks.pausePsdExtraction(async () => { if (!held) return; inflight++; try { await gate; } finally { inflight--; } });
    const drain = async () => { held = false; release(); while (inflight) await pause(5); await pause(50); };
    global.setTimeout = (callback, delay, ...args) => timer(callback, delay === 30000 ? 250 : delay, ...args);
    try {
      const f = await setup({ second: 'Cover.psd', breakSecond: false, hold });
      await drain();
      assert.equal((await f.review()).verificationFallback?.manual, false);
      // Retry starts, then Watch changes before the reading ends.
      global.setTimeout = timer;
      hold();
      const pending = f.retry();
      await pause(30);
      assert.equal(f.receipt('Cover.psd').status, 'pending');
      await callIpcRaw('projects:start-watching', f.id);
      await drain();
      assert.equal((await pending).error, 'package_review_changed');
      // Without any manual store intervention, the abandoned Retry receipt is
      // retired from pending to failed/scan-interrupted.
      assert.equal(f.receipt('Cover.psd').status, 'failed');
      assert.equal(f.receipt('Cover.psd').reason, 'scan-interrupted');
      await callIpcRaw('projects:pause', f.id); clearTrackedTimers();
      let review = await f.review();
      assert.deepEqual(review.verificationFallback, { version: 1, reason: 'failed', retry: true, manual: false },
        'Retry stays offered after Watch interruption without unlocking manual mode');
      assert.equal((await f.begin()).error, 'manual_package_unavailable');

      // If a newer receipt already replaced the abandoned attempt before it
      // settles, retirement must preserve the newer receipt untouched.
      hold();
      const secondPending = f.retry();
      await pause(30);
      const abandonedAttempt = f.receipt('Cover.psd').attempt;
      const key = metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(f.stored(), f.stored().files.find(file => file.path === desktop('Cover.psd')));
      const newerAttempt = 'newer-attempt-' + crypto.randomUUID().slice(0, 8);
      await callIpcRaw('projects:start-watching', f.id);
      metadataTestHooks.mutateProject(f.id, project => {
        project.workingSourceVerification[key] = { ...project.workingSourceVerification[key], status: 'failed', reason: 'ordinary-scan-failed', attempt: newerAttempt };
        return true;
      });
      await drain();
      assert.equal((await secondPending).error, 'package_review_changed');
      assert.notEqual(abandonedAttempt, newerAttempt);
      assert.equal(f.receipt('Cover.psd').attempt, newerAttempt, 'newer receipt is preserved');
      assert.equal(f.receipt('Cover.psd').reason, 'ordinary-scan-failed');
      await callIpcRaw('projects:pause', f.id); clearTrackedTimers();

      // An account switch during Retry must not write to the store on unwind.
      hold();
      const thirdPending = f.retry().catch(error => ({ error: error?.message || String(error) }));
      await pause(30);
      const pendingAttemptBeforeLogout = f.receipt('Cover.psd').attempt;
      await testAccountSession.logout();
      await drain();
      try {
        const thirdResult = await thirdPending;
        assert.ok(thirdResult?.error, 'logged-out Retry does not succeed');
      } finally {
        await testAccountSession.restore();
      }
      assert.equal(f.receipt('Cover.psd').attempt, pendingAttemptBeforeLogout);
      assert.equal(f.receipt('Cover.psd').status, 'pending', 'logged-out unwind never mutates store');
    } finally { held = false; release(); unpause(); global.setTimeout = timer; await testAccountSession.restore(); await pause(50); }
  });

  manualTest('Saving the failed working file after Retry asks for Retry again and retires an open manual review', async () => {
    const f = await setup();
    await f.retry();
    const begun = await f.begin();
    assert.equal(typeof begun.sessionId, 'string');
    fs.appendFileSync(f.flyer, '\n% saved again, still unreadable');
    let review = await f.review();
    assert.deepEqual(review.verificationFallback, { version: 1, reason: 'changed', retry: true, manual: false });
    assert.equal((await f.commit(begun.sessionId, begun.files.map(file => file.id), f.out)).error, 'package_review_changed');
    assert.equal((await f.begin()).error, 'manual_package_unavailable');
    assert.deepEqual(listOutput(f.out), []);
    // A Retry of the saved bytes that also fails unlocks manual mode for those bytes.
    await f.retry();
    review = await f.review();
    assert.deepEqual(review.verificationFallback, { version: 1, reason: 'failed', retry: true, manual: true });
  });

  manualTest('Settings changes keep a completed Retry; separate transfer holds and scans keep manual mode closed', async () => {
    const f = await setup();
    await f.retry();
    await callIpcRaw('settings:update', 'packageOutputLayoutMode', 'flat');
    assert.equal((await f.review()).verificationFallback?.manual, true, 'a layout change is not a new failure');
    const begun = await f.begin();
    metadataTestHooks.setFigmaPackageTransferBlock(f.id, 'synthetic transfer hold');
    assert.equal((await f.commit(begun.sessionId, begun.files.map(file => file.id), f.out)).error, 'package_review_changed');
    assert.deepEqual(listOutput(f.out), []);
    assert.equal((await f.begin()).error, 'manual_package_unavailable');
    assert.equal((await f.retry()).error, 'package_verification_retry_unavailable');
  });

  manualTest('Scope: fonts of every format, hidden or Crate-owned locations and extracted Photoshop media stay out', async () => {
    const f = await setup();
    const docs = path.join(TEST_HOME, 'Documents'); fs.mkdirSync(docs, { recursive: true });
    const webFont = desktop('Brand.woff2'); fs.writeFileSync(webFont, 'synthetic web font');
    const extracted = desktop('Extracted.png'); fs.writeFileSync(extracted, 'extracted media');
    manualDialogFor([webFont]);
    await callIpcRaw('projects:add-files', f.id);
    metadataTestHooks.mutateProject(f.id, project => {
      project.files.push({ path: extracted, name: 'Extracted.png', ext: '.png', addedAt: Date.now(), source: 'psd-embedded', assetOrigin: 'added', projectRole: 'asset' });
      return true;
    });
    await f.retry();
    assert.equal((await f.review()).verificationFallback?.manual, true);
    const begun = await f.begin();
    assert.deepEqual(begun.files.map(file => file.name).sort(), ['Flyer.ai', 'Logo.png', 'Poster.ai']);
    assert.equal(begun.omittedCount, 2, 'the web font and the extracted media are counted, not listed');
    const hiddenDir = path.join(TEST_HOME, '.private-folder'); fs.mkdirSync(hiddenDir, { recursive: true });
    fs.writeFileSync(path.join(hiddenDir, 'Inside.png'), 'inside');
    const visibleLink = path.join(docs, 'Visible'); fs.symlinkSync(hiddenDir, visibleLink);
    const crateOwned = path.join(fs.realpathSync(require('node:os').tmpdir()), 'crate-psd-extract-synthetic');
    fs.mkdirSync(crateOwned, { recursive: true }); fs.writeFileSync(path.join(crateOwned, 'Layer.png'), 'layer');
    const woff = path.join(docs, 'Web.woff'); fs.writeFileSync(woff, 'woff');
    try {
      const chosen = await f.choose(begun.sessionId, [path.join(visibleLink, 'Inside.png'), path.join(crateOwned, 'Layer.png'), woff, webFont]);
      assert.deepEqual(chosen.addedIds, []);
      assert.deepEqual(chosen.refused.map(item => item.reason).sort(), ['font', 'font', 'hidden-or-invalid', 'hidden-or-invalid']);
    } finally { fs.rmSync(crateOwned, { recursive: true, force: true }); }
    // InDesign family and exact file identity, as main-process contracts.
    for (const [name, expected] of [['Layout.indd', true], ['Layout.idml', true], ['Poster.ai', false], ['Cover.psd', false]]) {
      assert.equal(metadataTestHooks.isManualPackageInDesignFile({ path: '/Users/synthetic/' + name }), expected, name);
    }
    const session = { items: new Map([['row', { path: '/Users/synthetic/Logo.png', fingerprint: { source: { dev: '1', ino: '10' } } }]]) };
    assert.equal(metadataTestHooks.findManualPackageItem(session, '/Users/synthetic/LOGO.png', { source: { dev: '1', ino: '11' } }), null,
      'a different file whose path differs only by case is a separate row');
    assert.equal(metadataTestHooks.findManualPackageItem(session, '/Users/synthetic/Logo.png', { source: { dev: '1', ino: '12' } }).path, '/Users/synthetic/Logo.png');
    assert.equal(metadataTestHooks.findManualPackageItem(session, '/Users/synthetic/Other.png', { source: { dev: '1', ino: '10' } }).path, '/Users/synthetic/Logo.png');
  });

  manualTest('Re-choosing keeps the reviewed name; a hard link to a listed file is the same row', async () => {
    const f = await setup();
    await f.retry();
    const begun = await f.begin();
    const logoId = begun.files.find(file => file.name === 'Logo.png').id;
    const link = path.join(TEST_HOME, 'Documents', 'Logo copy.png');
    fs.mkdirSync(path.dirname(link), { recursive: true }); fs.linkSync(f.logo, link);
    const chosen = await f.choose(begun.sessionId, [link]);
    assert.deepEqual(chosen.matchedIds, [logoId]);
    assert.equal(chosen.files.find(file => file.id === logoId).name, 'Logo.png');
  });

  manualTest('Publication carries the reviewed bytes: a staged copy that changes before publication is refused', async () => {
    const f = await setup();
    await f.retry();
    const begun = await f.begin();
    const originalOpenSync = fs.openSync;
    let tampered = false;
    fs.openSync = function (target, flags, ...rest) {
      if (!tampered && typeof target === 'string' && target.includes('.crate-package-staging-') && target.endsWith('Logo.png') && typeof flags === 'number') {
        tampered = true;
        fs.appendFileSync(target, ' different bytes');
      }
      return originalOpenSync.call(this, target, flags, ...rest);
    };
    let result;
    try { result = await f.commit(begun.sessionId, begun.files.map(file => file.id), f.out); } finally { fs.openSync = originalOpenSync; }
    assert.equal(tampered, true);
    assert.equal(result.error, 'manual_package_copy_unverified', JSON.stringify(result));
    assert.deepEqual(listOutput(f.out), []);
    assert.deepEqual(stagingLeft(path.dirname(f.out)), []);
  });

  manualTest('Usage and the watcher exclusion are written once with publication, and not at all without it', async () => {
    const f = await setup();
    await f.retry();
    let begun = await f.begin();
    const ids = () => begun.files.map(file => file.id);
    const usage = () => storeInstance.data.usage.packagesThisMonth;
    const before = usage();
    assert.equal((await f.commit(begun.sessionId, ids(), 'relative/folder')).error, 'manual_package_invalid');
    // The store refuses the bookkeeping write: nothing is published.
    const originalSet = storeInstance.set;
    storeInstance.set = function (key, ...rest) {
      if (key && typeof key === 'object' && Object.hasOwn(key, 'usage')) throw new Error('synthetic store failure');
      return originalSet.call(this, key, ...rest);
    };
    let result;
    try { result = await f.commit(begun.sessionId, ids(), f.out); } finally { storeInstance.set = originalSet; }
    assert.equal(result.error, 'package_state_failed');
    assert.deepEqual(listOutput(f.out), []);
    assert.equal(usage(), before);
    // Publication itself fails: the bookkeeping is undone.
    const originalRename = fs.renameSync;
    fs.renameSync = function (from, to) {
      if (String(from).includes('.crate-package-staging-')) throw Object.assign(new Error('synthetic rename failure'), { code: 'EIO' });
      return originalRename.call(this, from, to);
    };
    try { result = await f.commit(begun.sessionId, ids(), f.out); } finally { fs.renameSync = originalRename; }
    assert.equal(result.success, undefined, JSON.stringify(result));
    assert.equal(usage(), before);
    assert.equal((storeInstance.data.quickPackageOutputPaths || []).some(entry => entry.startsWith(path.resolve(f.out))), false);
    assert.deepEqual(listOutput(f.out).filter(name => !name.includes('.crate-package-staging-')), []);
    // Success: exactly one charge and one exclusion.
    result = await f.commit(begun.sessionId, ids(), f.out);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(usage(), before + 1);
    assert.equal(storeInstance.data.quickPackageOutputPaths.filter(entry => entry === path.resolve(result.folderPath)).length, 1);
  });

  manualTest('Choose Files counts selections over the limit instead of dropping them silently', { timeout: 60000 }, async () => {
    const f = await setup();
    await f.retry();
    const begun = await f.begin();
    const folder = path.join(TEST_HOME, 'Many'); fs.mkdirSync(folder, { recursive: true });
    const paths = Array.from({ length: 1001 }, (_, index) => { const target = path.join(folder, `File ${index}.txt`); fs.writeFileSync(target, String(index)); return target; });
    const chosen = await f.choose(begun.sessionId, paths);
    assert.equal(chosen.files.length, 1000);
    assert.equal(chosen.refusedCount, 4, '997 added to 3 listed rows; 3 over the cap plus 1 past the picker limit');
    assert.deepEqual([...new Set(chosen.refused.map(item => item.reason))], ['limit']);
  });

  manualTest('The usage limit and an expired manual review refuse before any output', async () => {
    const f = await setup();
    await f.retry();
    let begun = await f.begin();
    const usage = storeInstance.data.usage;
    const saved = usage.packagesThisMonth;
    usage.packagesThisMonth = 1e6;
    try {
      const limited = await f.commit(begun.sessionId, begun.files.map(file => file.id), f.out);
      assert.equal(limited.error, 'limit_reached');
    } finally { usage.packagesThisMonth = saved; }
    assert.deepEqual(listOutput(f.out), []);
    const realNow = Date.now;
    Date.now = () => realNow() + 31 * 60 * 1000;
    try {
      assert.equal((await f.commit(begun.sessionId, begun.files.map(file => file.id), f.out)).error, 'manual_package_stale');
    } finally { Date.now = realNow; }
    assert.deepEqual(listOutput(f.out), []);
    begun = await f.begin();
    assert.deepEqual(await callIpcRaw('projects:end-manual-package', f.id, begun.sessionId), { success: true });
    assert.equal((await f.commit(begun.sessionId, begun.files.map(file => file.id), f.out)).error, 'manual_package_stale');
  });

  manualTest('Valid working file (test-only seam): failed Retry -> manual review -> exact included files -> later successful Retry restores normal Review', async () => {
    let failFlyer = false;
    const unintercept = metadataTestHooks.interceptRegexWorker((filePath, scanLease, runOriginal) => {
      if (failFlyer && path.basename(filePath) === 'Flyer.ai') {
        return Promise.reject(new Error('asset_baseline_regex_worker_failed'));
      }
      return runOriginal();
    });
    try {
      // Flyer.ai stays valid and unmodified on disk throughout the entire flow.
      const f = await setup({ breakSecond: false, hold: () => { failFlyer = true; } });
      const flyerDigest = sha(f.flyer);
      let review = await f.review();
      assert.equal(review.materializable, false);
      assert.deepEqual(review.verificationFallback, { version: 1, reason: 'failed', retry: true, manual: false });
      assert.equal((await f.begin()).error, 'manual_package_unavailable');

      // Explicit Retry fails while the test-only seam is armed.
      assert.deepEqual(await f.retry(), { success: true });
      review = await f.review();
      assert.deepEqual(review.verificationFallback, { version: 1, reason: 'failed', retry: true, manual: true });

      // Manual review copies only the explicitly Included files, byte-for-byte.
      const storeBefore = JSON.stringify(storeInstance.data.projects);
      const begun = await f.begin();
      const brief = path.join(TEST_HOME, 'Documents', 'Notes.pdf');
      fs.mkdirSync(path.dirname(brief), { recursive: true }); fs.writeFileSync(brief, 'valid manual note');
      const chosen = await f.choose(begun.sessionId, [brief]);
      const includedIds = chosen.files.filter(file => file.name !== 'Logo.png').map(file => file.id);
      const result = await f.commit(begun.sessionId, includedIds, f.out);
      assert.equal(result.success, true, JSON.stringify(result));
      const folder = path.basename(result.folderPath);
      assert.deepEqual(listOutput(f.out), [folder, `${folder}/Flyer.ai`, `${folder}/Notes.pdf`, `${folder}/Poster.ai`]);
      assert.equal(sha(path.join(result.folderPath, 'Flyer.ai')), flyerDigest, 'valid working file copied byte-identically');
      assert.equal(sha(f.flyer), flyerDigest, 'valid working file never modified');
      assert.equal(JSON.stringify(storeInstance.data.projects), storeBefore);

      // Disarm seam without editing Flyer.ai; Retry restores normal Review.
      failFlyer = false;
      assert.deepEqual(await f.retry(), { success: true });
      review = await f.review();
      assert.equal(review.materializable, true);
      assert.equal(typeof review.token, 'string');
      assert.equal(review.verificationFallback, undefined);
      assert.equal((await f.begin()).error, 'manual_package_unavailable');
    } finally { unintercept(); }
  });

  manualTest('Typed size and coverage limits stay limited and never unlock Retry or manual packaging', async () => {
    const f = await setup({ breakSecond: false });
    // Oversized sparse file (>300 MiB) on Restore.
    const originalSize = fs.statSync(f.flyer).size;
    assert.equal((await f.select('Flyer.ai', 'exclude')).success, true);
    fs.truncateSync(f.flyer, 301 * 1024 * 1024);
    try {
      assert.equal((await f.select('Flyer.ai', 'restore')).success, true);
      const receipt = f.receipt('Flyer.ai');
      assert.equal(receipt.status, 'limited');
      assert.equal(receipt.reason, 'ordinary-extractor-source-too-large');
      assert.ok(receipt.unresolved.some(item => item.reason === 'coverage-limit'));
      const review = await f.review();
      assert.equal(review.materializable, false);
      assert.equal(review.verificationFallback, undefined, 'size limit never enables Retry or manual mode');
      assert.equal((await f.retry()).error, 'package_verification_retry_unavailable');
      assert.equal((await f.begin()).error, 'manual_package_unavailable');
    } finally { fs.truncateSync(f.flyer, originalSize); }

    // Starting from an eligible failed receipt, growing >300 MiB before Retry must not unlock manual mode.
    const f2 = await setup();
    const size2 = fs.statSync(f2.flyer).size;
    fs.truncateSync(f2.flyer, 301 * 1024 * 1024);
    try {
      assert.deepEqual(await f2.retry(), { success: true });
      assert.equal(f2.receipt('Flyer.ai').status, 'limited');
      assert.equal(f2.receipt('Flyer.ai').reason, 'ordinary-extractor-source-too-large');
      assert.equal((await f2.review()).verificationFallback, undefined);
      assert.equal((await f2.begin()).error, 'manual_package_unavailable');
    } finally { fs.truncateSync(f2.flyer, size2); }

    // Typed coverage/metadata limit from parser worker also stays limited.
    const f3 = await setup();
    const unintercept = metadataTestHooks.interceptRegexWorker((filePath, scanLease, runOriginal) => {
      if (path.basename(filePath) === 'Flyer.ai') return Promise.reject(new Error('asset_baseline_psd_metadata_limit'));
      return runOriginal();
    });
    try {
      assert.deepEqual(await f3.retry(), { success: true });
      assert.equal(f3.receipt('Flyer.ai').status, 'limited');
      assert.equal(f3.receipt('Flyer.ai').reason, 'coverage-limit');
      assert.equal((await f3.review()).verificationFallback, undefined);
      assert.equal((await f3.begin()).error, 'manual_package_unavailable');
    } finally { unintercept(); }
  });

  manualTest('Choose Files preserves known project-row restrictions (renamed restricted fonts and extracted media) by exact path and physical identity', async () => {
    const f = await setup();
    const visibleDir = path.join(TEST_HOME, 'Desktop', 'VisibleExtracted');
    fs.mkdirSync(visibleDir, { recursive: true });
    const parentPsd = path.join(visibleDir, 'Source.psd'); fs.writeFileSync(parentPsd, emptyPsdBytes());
    const restrictedFont = path.join(visibleDir, 'Restricted.otf_1.'); fs.writeFileSync(restrictedFont, 'restricted font bytes');
    const brandFont = path.join(visibleDir, 'Brand.otf_2'); fs.writeFileSync(brandFont, 'brand font bytes');
    const extractedPng = path.join(visibleDir, 'Extracted.png'); fs.writeFileSync(extractedPng, 'extracted png bytes');
    const pendingExtracted = path.join(visibleDir, 'PendingExtracted.png'); fs.writeFileSync(pendingExtracted, 'pending extracted bytes');
    const ordinaryRenamed = path.join(visibleDir, 'Logo_1.png'); fs.writeFileSync(ordinaryRenamed, 'ordinary png bytes');
    const receipt = (name, bytes) => ({ version: 1, parentPath: parentPsd, sourceDigest: sha(parentPsd), outputDigest: crypto.createHash('sha256').update(bytes).digest('hex'),
      layerPath: null, linkedIndex: 0, originalName: name });
    metadataTestHooks.mutateProject(f.id, project => {
      project.files.push(
        { path: restrictedFont, name: 'Restricted.otf_1.', ext: '', addedAt: Date.now(), source: 'psd-embedded', assetOrigin: 'added', projectRole: 'asset',
          psdResource: { version: 1, ...receipt('Restricted.otf', 'restricted font bytes') } },
        { path: brandFont, name: 'Brand.otf_2', ext: '.otf_2', addedAt: Date.now(), source: 'psd-embedded', assetOrigin: 'added', projectRole: 'asset',
          psdExtractionReceipt: receipt('Brand.otf', 'brand font bytes') },
        { path: extractedPng, name: 'Extracted.png', ext: '.png', addedAt: Date.now(), source: 'psd-embedded', assetOrigin: 'added', projectRole: 'asset' },
        { path: ordinaryRenamed, name: 'Logo_1.png', ext: '.png', addedAt: Date.now(), source: 'manual-browse', assetOrigin: 'added', projectRole: 'asset' },
      );
      project.pendingFiles = [...(project.pendingFiles || []),
        { path: pendingExtracted, name: 'PendingExtracted.png', ext: '.png', addedAt: Date.now(), source: 'psd-embedded', assetOrigin: 'added', projectRole: 'asset' }];
      return true;
    });
    await f.retry();
    const begun = await f.begin();
    assert.deepEqual(begun.files.map(file => file.name).sort(), ['Flyer.ai', 'Logo.png', 'Logo_1.png', 'Poster.ai']);
    assert.equal(begun.omittedCount, 3, 'all 3 restricted rows are omitted from preselection');
    // Hard links to restricted files in another visible folder must also be refused by physical identity.
    const aliasDir = path.join(TEST_HOME, 'Documents', 'Aliases');
    fs.mkdirSync(aliasDir, { recursive: true });
    const hardFontAlias = path.join(aliasDir, 'InnocentName.dat'); fs.linkSync(restrictedFont, hardFontAlias);
    const hardExtractedAlias = path.join(aliasDir, 'InnocentImage.png'); fs.linkSync(extractedPng, hardExtractedAlias);
    const chosen = await f.choose(begun.sessionId, [restrictedFont, brandFont, extractedPng, pendingExtracted, hardFontAlias, hardExtractedAlias]);
    assert.deepEqual(chosen.addedIds, [], 'no restricted file receives an item ID');
    assert.deepEqual(chosen.matchedIds, []);
    assert.equal(chosen.refusedCount, 6);
    assert.deepEqual(chosen.refused.map(item => item.reason).sort(), ['extracted', 'extracted', 'extracted', 'font', 'font', 'font']);
  });

  manualTest('Large Retry batches above the bound are rejected before starting and repeated Retries do not evict active evidence', async () => {
    const f = await setup();
    // Seed 64 more failed selected working files (65 total failing sources > 64 batch limit).
    const extraDir = path.join(TEST_HOME, 'Desktop', 'Batch');
    fs.mkdirSync(extraDir, { recursive: true });
    const extraFiles = [];
    for (let index = 0; index < 64; index++) {
      const target = path.join(extraDir, `Broken-${index}.ai`);
      fs.writeFileSync(target, '%PDF-1.7\nmissing EOF');
      extraFiles.push(target);
    }
    metadataTestHooks.mutateProject(f.id, project => {
      for (const target of extraFiles) {
        const row = { path: target, name: path.basename(target), ext: '.ai', addedAt: Date.now(), source: 'manual-browse', assetOrigin: 'added', projectRole: 'source' };
        project.files.push(row);
        const key = metadataTestHooks.getAssetBaselineSourceRecoveryRouteKey(project, row);
        project.workingSourceSelections[key] = { version: 1, state: 'selected', revision: 1, reason: null };
        project.workingSourceVerification[key] = {
          version: 1, status: 'failed', reason: 'scan_on_open_failed', attempt: 'seed-' + key.slice(0, 12),
          selectionRevision: 1, sourceIdentity: null, provider: 'ordinary-scan', coverage: 'ordinary-route',
          sourceFingerprint: null, requiredReferences: [], unresolved: [{ reason: 'ordinary-scan-failed' }],
        };
      }
      return true;
    });
    const beforeAttempts = new Map(Object.entries(f.stored().workingSourceVerification).map(([k, v]) => [k, v.attempt]));
    const limited = await f.retry();
    assert.deepEqual(limited, { success: false, error: 'package_verification_retry_limit', limit: 64, count: 65 });
    const afterAttempts = new Map(Object.entries(f.stored().workingSourceVerification).map(([k, v]) => [k, v.attempt]));
    assert.deepEqual([...afterAttempts.entries()], [...beforeAttempts.entries()], 'no receipt is reserved when over the batch limit');
    assert.equal((await f.review()).verificationFallback?.manual, false);
    assert.equal((await f.begin()).error, 'manual_package_unavailable');

    // Within the bound, repeated Retries keep manual eligibility without self-eviction.
    const f2 = await setup();
    for (let round = 0; round < 3; round++) {
      assert.deepEqual(await f2.retry(), { success: true });
      assert.equal((await f2.review()).verificationFallback?.manual, true, `round ${round + 1}`);
    }
  });

  manualTest('Completion journal reconciles usage and output exclusions across crashes and failed rollbacks', async () => {
    const f = await setup();
    await f.retry();
    let begun = await f.begin();
    const ids = () => begun.files.map(file => file.id);
    const usage = () => storeInstance.data.usage.packagesThisMonth;
    const before = usage();

    // 1. Failed rename AND failed rollback write leaves a pending record that reconciles cleanly on next check.
    const originalRename = fs.renameSync;
    const originalSet = storeInstance.set;
    let blockRollback = true;
    fs.renameSync = function (from, to) {
      if (String(from).includes('.crate-package-staging-')) throw Object.assign(new Error('synthetic rename failure'), { code: 'EIO' });
      return originalRename.call(this, from, to);
    };
    storeInstance.set = function (key, ...rest) {
      if (blockRollback && key && typeof key === 'object' && Object.hasOwn(key, 'pendingManualPackageCompletions') &&
          Array.isArray(key.pendingManualPackageCompletions) && key.pendingManualPackageCompletions.length === 0) {
        throw new Error('synthetic rollback store failure');
      }
      return originalSet.call(this, key, ...rest);
    };
    let result;
    try { result = await f.commit(begun.sessionId, ids(), f.out); }
    finally { fs.renameSync = originalRename; storeInstance.set = originalSet; blockRollback = false; }
    assert.equal(result.success, undefined);
    assert.equal((storeInstance.data.pendingManualPackageCompletions || []).length, 1, 'pending completion record survives rollback failure');
    assert.equal(usage(), before + 1, 'unreconciled reservation is still recorded before restart/reconcile');
    // Restart/usage read reconciles against disk: folder never appeared, so usage and exclusion are refunded.
    const reconciledUsage = await callIpcRaw('usage:get');
    assert.equal(reconciledUsage.packagesThisMonth, before);
    assert.equal(usage(), before);
    assert.deepEqual(storeInstance.data.pendingManualPackageCompletions, []);
    assert.equal((storeInstance.data.quickPackageOutputPaths || []).some(entry => entry.startsWith(path.resolve(f.out))), false);

    // 2. Crash before rename with orphaned staging directory on disk: startup reconciliation refunds and removes staging.
    const orphanStaging = path.join(f.out, '.crate-package-staging-orphan-' + crypto.randomUUID().slice(0, 8));
    fs.mkdirSync(orphanStaging, { mode: 0o700 });
    const orphanStat = fs.lstatSync(orphanStaging, { bigint: true });
    const missingDest = path.join(f.out, 'NeverPublished');
    storeInstance.set({
      usage: { ...storeInstance.data.usage, packagesThisMonth: before + 1 },
      quickPackageOutputPaths: [...(storeInstance.data.quickPackageOutputPaths || []), path.resolve(missingDest)],
      pendingManualPackageCompletions: [{
        version: 1, id: 'crash-before-rename', destFolder: path.resolve(missingDest),
        stagingFolder: path.resolve(orphanStaging), stagingDev: String(orphanStat.dev), stagingIno: String(orphanStat.ino),
        resetDate: storeInstance.data.usage.resetDate, addedOutputPath: true, createdAt: Date.now(),
      }],
    });
    assert.equal(metadataTestHooks.reconcilePendingManualPackageCompletions({ ignoreInFlight: true }), true);
    assert.equal(usage(), before, 'crash-before-rename refunds usage');
    assert.equal(storeInstance.data.quickPackageOutputPaths.includes(path.resolve(missingDest)), false);
    assert.deepEqual(storeInstance.data.pendingManualPackageCompletions, []);

    // 3. Crash after rename (published folder exists with matching dev/ino): reconciliation keeps usage and exclusion.
    const publishedDest = path.join(f.out, 'PublishedBeforeCrash');
    fs.mkdirSync(publishedDest, { mode: 0o700 });
    const publishedStat = fs.lstatSync(publishedDest, { bigint: true });
    storeInstance.set({
      usage: { ...storeInstance.data.usage, packagesThisMonth: before + 1 },
      quickPackageOutputPaths: [...(storeInstance.data.quickPackageOutputPaths || []), path.resolve(publishedDest)],
      pendingManualPackageCompletions: [{
        version: 1, id: 'crash-after-rename', destFolder: path.resolve(publishedDest),
        stagingFolder: path.join(f.out, '.crate-package-staging-gone'), stagingDev: String(publishedStat.dev), stagingIno: String(publishedStat.ino),
        resetDate: storeInstance.data.usage.resetDate, addedOutputPath: true, createdAt: Date.now(),
      }],
    });
    assert.equal(metadataTestHooks.reconcilePendingManualPackageCompletions({ ignoreInFlight: true }), true);
    assert.equal(usage(), before + 1, 'crash-after-rename preserves usage charge');
    assert.equal(storeInstance.data.quickPackageOutputPaths.includes(path.resolve(publishedDest)), true);
    assert.deepEqual(storeInstance.data.pendingManualPackageCompletions, []);
  });

  manualTest('Cross-project Watch and destination/selection isolation: custom-named manual output is excluded from watching projects without mutating either project', async () => {
    const f = await setup();
    await callIpcRaw('settings:update', 'namingTemplate', '{Project}-Manual');
    await f.retry();
    const other = await createProject('Other Watched Project');
    const otherDoc = desktop('Other.ai'); writeSyntheticAiFile(otherDoc, f.logo);
    manualDialogFor([otherDoc]);
    await callIpcRaw('projects:add-files', other.id);
    await callIpcRaw('projects:start-watching', other.id);
    const otherBefore = JSON.stringify(storeInstance.data.projects.find(item => item.id === other.id));
    const projectABefore = JSON.stringify(f.stored());
    const begun = await f.begin();
    assert.equal(begun.folderName, 'Manual fallback-Manual', 'custom non-dated folder name');
    // Session from Project A cannot be used for Project B.
    assert.equal((await callIpcRaw('projects:package-manual', other.id, begun.sessionId,
      { includedIds: begun.files.map(file => file.id), expectedCount: begun.files.length }, f.out)).error, 'manual_package_stale');
    const result = await f.commit(begun.sessionId, begun.files.map(file => file.id), f.out);
    assert.equal(result.success, true, JSON.stringify(result));
    for (const name of result.files) {
      assert.equal(metadataTestHooks.isAutoCaptureExcludedPath(path.join(result.folderPath, name)), true,
        `copied ${name} inside custom-named manual folder is excluded from auto-capture`);
    }
    assert.equal(JSON.stringify(storeInstance.data.projects.find(item => item.id === other.id)), otherBefore, 'watched project B untouched');
    assert.equal(JSON.stringify(f.stored()), projectABefore, 'project A untouched');
    await callIpcRaw('projects:pause', other.id); clearTrackedTimers();
  });
}
