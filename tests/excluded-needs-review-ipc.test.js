'use strict';

// Files excluded from Needs Review are remembered and can be included again
// through the ordinary accept transition. Runs production main/IPC/store code
// with the existing dependency-free Electron harness and synthetic files only.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const harnessPath = path.join(__dirname, 'provenance-dual-write.test.js');
let harness = fs.readFileSync(harnessPath, 'utf8');
function replaceOnce(before, after) {
  assert.equal(harness.split(before).length - 1, 1, `excluded-needs-review adapter drift: ${before}`);
  harness = harness.replace(before, after);
}
replaceOnce("const test = require('node:test');", "const excludedTest = require('node:test'); const test = new Proxy(excludedTest, { apply() {} });");
replaceOnce("fs.mkdtempSync(path.join(os.tmpdir(), 'crate-provenance-dual-write-home-'))",
  "fs.mkdtempSync(path.join(process.env.CRATE_TEST_OUTPUT_ROOT || path.dirname(MAIN_UNDER_TEST_ROOT), 'excluded-review-synthetic-home-'))");
replaceOnce('  captureProjectOperation,\n  runScanOnOpen',
  '  stageLiveObservedFileForTest(projectId, fileEntry, observation) { let staged = null; mutateProject(projectId, project => { staged = stageLiveObservedFile(project, fileEntry, observation); return staged; }); return staged; },\n' +
  '  mutateProjectForTest(projectId, fn) { return mutateProject(projectId, fn); },\n' +
  '  getProjectsForTest() { return getProjects(); },\n' +
  '  rejectPendingFilesForTest(projectId, targets) { return mutateProject(projectId, project => targets.map(target => rejectPendingFileInProject(project, target))); },\n' +
  '  selectProjectFilesForPackagingForTest(projectId) { return selectProjectFilesForPackaging(getProjects().find(project => project.id === projectId)); },\n' +
  '  getWorkingSourceVerificationForTest(project, file) { return getWorkingSourceVerification(project, file); },\n' +
  '  captureProjectOperation,\n  runScanOnOpen');
const compiled = new Module(harnessPath, module);
compiled.filename = harnessPath;
compiled.paths = Module._nodeModulePaths(__dirname);
compiled._compile(harness + '\n(' + excludedCases.toString() + ')();\n', harnessPath);

function excludedCases() {
  const desk = name => path.join(TEST_HOME, 'Desktop', name);
  const pendingRow = (name, extra = {}) => ({
    path: desk(name), name, ext: path.extname(name).toLowerCase(), addedAt: Date.now(), source: 'indd-linked',
    captureState: 'pending', captureReason: 'linked-asset-observed',
    captureEvidence: { reason: 'linked-asset-observed', state: 'pending', source: 'indd-linked', appFamily: 'indesign',
      sourceName: 'Brochure.indd', evidenceKey: 'synthetic-evidence-key', designerReason: 'Found in InDesign.' },
    ...extra,
  });

  async function fixture(label, { sources = ['Original.ai'], pending = [] } = {}) {
    resetTestHomeWorkspace();
    setChildProcessHandler(() => ({ stdout: '' }));
    const project = await createProject(`Synthetic ${label}`);
    await callIpcRaw('projects:pause', project.id);
    clearTrackedTimers();
    const files = sources.map(name => {
      fs.writeFileSync(desk(name), '%PDF-1.7\n%%EOF\n');
      return { fileId: name, path: desk(name), name, ext: path.extname(name), projectRole: 'source', source: 'user-added', addedAt: Date.now() };
    });
    for (const row of pending) if (!fs.existsSync(row.path)) fs.writeFileSync(row.path, row.ext === '.ai' ? '%PDF-1.7\n%%EOF\n' : `synthetic ${row.name}`);
    const stored = storeInstance.data.projects.find(item => item.id === project.id);
    stored.files = files; stored.pendingFiles = pending.map(row => ({ ...structuredClone(row), addedAt: Date.now() }));
    stored.assetBaseline = { schemaVersion: 1, status: 'legacy-included', decision: 'include', establishedAt: Date.now() };
    roundTripFakeStore();
    const current = () => storeInstance.data.projects.find(item => item.id === project.id);
    return {
      id: project.id, current,
      workspace: () => callIpcRaw('projects:get-asset-workspace', project.id),
      reject: target => callIpcRaw('projects:reject-pending', project.id, target),
      accept: target => callIpcRaw('projects:accept-pending', project.id, target),
      observations: () => Object.values(current().provenance?.observations || {}).length,
      rejectObservation: filePath => Object.values(current().provenance?.observations || {}).some(item => (
        item?.observer?.method === 'projects:reject-pending' && current().provenance.nodes[item.objectNodeId]?.path === filePath)),
      acceptObservation: filePath => Object.values(current().provenance?.observations || {}).some(item => (
        item?.observer?.method === 'projects:accept-pending' && current().provenance.nodes[item.objectNodeId]?.path === filePath)),
    };
  }
  const withoutVolatile = file => {
    const { addedAt, captureSessionId, ...rest } = file || {};
    return rest;
  };

  excludedTest('a plain asset excluded from Needs Review is remembered, stays out of packages and the watcher, and Include equals accept', { timeout: 30000 }, async () => {
    const row = pendingRow('Texture.png');
    const f = await fixture('plain-exclude', { pending: [row] });
    const twin = await fixture('plain-accept', { pending: [row] });
    const before = f.workspace();
    const target = (await before).pendingFiles[0].visualIdentity;

    const rejected = await f.reject(target);
    assert.ok(Array.isArray(rejected), JSON.stringify(rejected));
    assert.deepEqual(f.current().pendingFiles, []);
    assert.ok(f.current().excludedAssetKeys.includes(row.path));
    assert.ok(f.rejectObservation(row.path), 'today\'s rejection provenance is kept');
    const [record] = f.current().excludedPendingFiles;
    assert.equal(record.path, row.path);
    assert.equal(record.excludedRecordVersion, 1);
    assert.equal(record.excludedAppFamily, 'indesign');
    for (const field of ['captureEvidence', 'captureState', 'captureReason', 'acceptedPending', 'acceptedPendingAppFamily']) {
      assert.equal(Object.prototype.hasOwnProperty.call(record, field), false, field);
    }
    assert.equal(f.acceptObservation(row.path), false, 'a record never claims acceptance');
    assert.equal(f.current().files.some(file => file.path === row.path), false, 'a record is never a project file');

    const workspace = await f.workspace();
    assert.equal(workspace.pendingFiles.length, 0);
    assert.equal(workspace.excludedPendingFiles.length, 1);
    const presented = workspace.excludedPendingFiles[0];
    assert.equal(presented.name, 'Texture.png');
    assert.deepEqual([presented.excluded, presented.included, presented.excludedPending, presented.assetOrigin, presented.projectRole, presented.protectedSource],
      [true, false, true, 'added', 'asset', false]);
    assert.equal(presented.visualIdentity, target);
    assert.equal(presented.visualRevision, null, 'no file visual is offered for a remembered row');
    assert.equal(workspace.files.some(file => file.visualIdentity === target), false);

    const packaged = await metadataTestHooks.selectProjectFilesForPackagingForTest(f.id);
    assert.equal(packaged.some(file => file.path === row.path), false, 'an excluded file never enters the package');

    const observed = metadataTestHooks.stageLiveObservedFileForTest(f.id, { path: row.path, name: row.name, ext: row.ext, addedAt: Date.now(), source: 'lsof' },
      { forcePending: true, reason: 'app-file-observed', captureState: 'pending', appFamily: 'indesign' });
    assert.equal(observed.reason, 'user-excluded-asset');
    assert.deepEqual(f.current().pendingFiles, [], 'the watcher does not bring it back to Needs Review');

    const included = await f.accept(target);
    assert.ok(included && Array.isArray(included.files), JSON.stringify(included));
    const twinTarget = (await twin.workspace()).pendingFiles[0].visualIdentity;
    assert.ok(await twin.accept(twinTarget));
    const viaRecord = f.current().files.find(file => file.path === row.path);
    const viaAccept = twin.current().files.find(file => file.path === row.path);
    assert.ok(viaRecord && viaAccept);
    assert.equal(JSON.stringify(withoutVolatile(viaRecord)), JSON.stringify(withoutVolatile(viaAccept)), 'the same accepted record, field for field');
    assert.equal(viaRecord.acceptedPending, true);
    assert.equal(viaRecord.acceptedPendingAppFamily, 'indesign');
    assert.ok(f.acceptObservation(row.path), 'accept provenance is recorded on Include');
    assert.deepEqual(f.current().excludedPendingFiles, []);
    assert.equal(f.current().excludedAssetKeys.includes(row.path), false);
    const after = await f.workspace();
    assert.equal(after.excludedPendingFiles.length, 0);
    const acceptedRow = after.files.find(file => file.visualIdentity === target);
    const twinRow = (await twin.workspace()).files.find(file => file.visualIdentity === twinTarget);
    assert.equal(acceptedRow.excluded, false);
    assert.deepEqual([acceptedRow.included, acceptedRow.assetOrigin, acceptedRow.projectRole], [twinRow.included, twinRow.assetOrigin, twinRow.projectRole]);
    assert.ok((await metadataTestHooks.selectProjectFilesForPackagingForTest(f.id)).some(file => file.path === row.path));
  });

  excludedTest('a design file excluded from Needs Review gets [+] and Include runs accept: working file, scan and Replace/Keep both choice', { timeout: 60000 }, async () => {
    const row = pendingRow('Placed.ai');
    const f = await fixture('design-exclude', { pending: [row] });
    const twin = await fixture('design-accept', { pending: [row] });
    const target = (await f.workspace()).pendingFiles[0].visualIdentity;
    assert.ok(Array.isArray(await f.reject(target)));
    const remembered = (await f.workspace()).excludedPendingFiles;
    assert.equal(remembered.length, 1);
    assert.deepEqual([remembered[0].projectRole, remembered[0].protectedSource, remembered[0].sourceSelection], ['asset', false, undefined],
      'not a working file while excluded');
    assert.equal((await f.workspace()).workingFileChoices.choices.length, 0, 'excluding raises no working-file choice');

    assert.ok(await f.accept(target));
    assert.ok(await twin.accept((await twin.workspace()).pendingFiles[0].visualIdentity));
    for (const g of [f, twin]) {
      const ws = await g.workspace();
      const placed = ws.files.find(file => file.name === 'Placed.ai');
      assert.equal(placed.protectedSource, true, 'it becomes a working file');
      assert.equal(placed.sourceSelection, 'selected');
      const record = g.current().files.find(file => file.name === 'Placed.ai');
      assert.equal(metadataTestHooks.getWorkingSourceVerificationForTest(g.current(), record)?.status, 'scanned', 'scan-on-open ran');
      const choice = ws.workingFileChoices.choices.find(entry => entry.source.name === 'Placed.ai');
      assert.ok(choice, 'a Replace/Keep both choice is raised');
      assert.equal(choice.route, 'accepted-pending');
    }
    assert.equal(JSON.stringify(withoutVolatile(f.current().files.find(file => file.name === 'Placed.ai'))),
      JSON.stringify(withoutVolatile(twin.current().files.find(file => file.name === 'Placed.ai'))));
    assert.deepEqual(f.current().excludedPendingFiles, []);
  });

  excludedTest('Exclude All remembers every eligible row in order and a repeat Exclude keeps one record in place', { timeout: 30000 }, async () => {
    const rows = ['A.png', 'B.png', 'C.png'].map(name => pendingRow(name));
    const f = await fixture('batch', { pending: rows });
    for (const row of rows) assert.ok(Array.isArray(await f.reject(row.path)));
    assert.deepEqual(f.current().excludedPendingFiles.map(record => record.name), ['A.png', 'B.png', 'C.png']);
    assert.deepEqual((await f.workspace()).excludedPendingFiles.map(file => file.name), ['A.png', 'B.png', 'C.png']);

    // The same file found again (hidden behind its key) and excluded again keeps one record in place.
    metadataTestHooks.mutateProjectForTest(f.id, project => { project.pendingFiles = [structuredClone(rows[1])]; return {}; });
    assert.ok(Array.isArray(await f.reject(rows[1].path)));
    assert.deepEqual(f.current().excludedPendingFiles.map(record => record.name), ['A.png', 'B.png', 'C.png']);

    assert.equal(f.current().excludedAssetKeys.filter(key => key === rows[1].path).length, 1);
  });

  excludedTest('a malformed record list is shown as empty, left untouched, and a new Exclude fails closed', { timeout: 30000 }, async () => {
    for (const malformed of ['not-a-list', [{ path: '/synthetic/x.png', excludedRecordVersion: 1, excludedAt: 1, captureEvidence: {} }], [{ excludedRecordVersion: 2 }]]) {
      const row = pendingRow('Fragile.png');
      const f = await fixture('malformed', { pending: [row] });
      f.current().excludedPendingFiles = structuredClone(malformed);
      roundTripFakeStore();
      const keys = JSON.stringify(f.current().excludedAssetKeys);
      const observations = f.observations();
      assert.deepEqual((await f.workspace()).excludedPendingFiles, []);
      assert.deepEqual(await f.reject(row.path), { success: false, error: 'excluded_pending_records_invalid' });
      assert.equal(f.current().pendingFiles.length, 1, 'the row stays in Needs Review');
      assert.equal(JSON.stringify(f.current().excludedAssetKeys), keys);
      assert.equal(f.observations(), observations, 'no provenance is written');
      roundTripFakeStore();
      assert.deepEqual(f.current().excludedPendingFiles, malformed, 'the raw value is never overwritten');
      assert.equal(await f.accept('/synthetic/x.png'), null);
    }
  });

  excludedTest('legacy key-only skips are never shown, counted, recorded or deleted', { timeout: 30000 }, async () => {
    const legacyPath = desk('Legacy.png');
    const row = pendingRow('Fresh.png');
    const already = pendingRow('Already.png');
    const f = await fixture('legacy', { pending: [row, already] });
    f.current().excludedAssetKeys = [legacyPath, already.path];
    roundTripFakeStore();
    assert.deepEqual((await f.workspace()).excludedPendingFiles, []);
    // A row whose key is already a legacy skip keeps today's behavior: no record.
    assert.ok(Array.isArray(await f.reject(already.path)));
    assert.deepEqual(f.current().excludedPendingFiles || [], []);
    assert.ok(Array.isArray(await f.reject(row.path)));
    assert.deepEqual((await f.workspace()).excludedPendingFiles.map(file => file.name), ['Fresh.png']);
    assert.ok(await f.accept(row.path));
    assert.deepEqual([...f.current().excludedAssetKeys].sort(), [already.path, legacyPath].sort(), 'only the record\'s own key is deleted');
    assert.deepEqual((await f.workspace()).excludedPendingFiles, []);
  });

  excludedTest('scale: 1001 excluded rows are all kept in order, projected and restorable, with no new limit', { timeout: 120000 }, async t => {
    const count = 1001;
    // A realistic long macOS path: deep client folders and an ordinary file name.
    const fileName = index => `Campaign_Hero_${String(index + 1).padStart(4, '0')}_retouched_v3.png`;
    const base = path.join(TEST_HOME, 'Desktop', 'Client Work');
    const padding = 192 - base.length - 2 - fileName(0).length;
    assert.ok(padding >= 1, `synthetic home leaves room for a 192-character path: ${base.length}`);
    const folder = base + path.sep + 'Brand Refresh - Spring Campaign - Retouched Exports - Final'.slice(0, padding).padEnd(padding, '_');
    fs.mkdirSync(folder, { recursive: true });
    const rows = Array.from({ length: count }, (_, index) => pendingRow(fileName(index), {
      path: path.join(folder, fileName(index)), captureSessionId: '1f6c1a9e-5d1b-4c55-9e1e-8f3b2c7d4a10', captureSessionObserved: true,
    }));
    assert.ok(rows.every(row => row.path.length === 192), `192-character paths: ${rows[0].path.length}`);
    const f = await fixture('scale', { pending: [] });
    f.current().pendingFiles = rows.map(row => structuredClone(row));
    f.current().excludedAssetKeys = [desk('Legacy-only.png')];
    roundTripFakeStore();
    // Each reject runs the production reject transition (the IPC handler's own
    // function), one row at a time, inside one store write to keep this light.
    const outcomes = metadataTestHooks.rejectPendingFilesForTest(f.id, rows.map(row => row.path));
    assert.equal(outcomes.length, count);
    assert.ok(outcomes.every(outcome => Array.isArray(outcome.pendingFiles) && !outcome.refusal));
    assert.deepEqual(f.current().pendingFiles, []);
    assert.equal(f.current().excludedAssetKeys.length, count + 1);
    // One more through the IPC handler itself: the 1002nd exclusion has no limit either.
    const longName = `Late Addition - ${'Very Long Descriptive Client Approved Retouch Name '.repeat(4)}`.slice(0, 196) + '.png';
    const extra = pendingRow(longName);
    metadataTestHooks.mutateProjectForTest(f.id, project => { project.pendingFiles = [{ ...extra, addedAt: Date.now() }]; return {}; });
    assert.ok(Array.isArray(await f.reject(extra.path)));
    rows.push(extra);
    const lastRecord = f.current().excludedPendingFiles.at(-1);
    assert.equal(longName.length, 200);
    assert.equal(lastRecord.name, longName, 'a long file name is kept exactly');
    assert.equal(lastRecord.path, extra.path, 'a long path is kept exactly');
    roundTripFakeStore();
    const records = f.current().excludedPendingFiles.slice(0, count);
    assert.equal(f.current().excludedPendingFiles.length, count + 1, 'no record is dropped');
    assert.deepEqual(f.current().excludedPendingFiles.map(record => record.path), rows.map(row => row.path), 'order is stable');
    const sizes = records.map(record => Buffer.byteLength(JSON.stringify(record)));
    const listBytes = Buffer.byteLength(JSON.stringify(records));
    t.diagnostic(`STORAGE excludedPendingFiles records=${count} listBytes=${listBytes} maxRecordBytes=${Math.max(...sizes)} minRecordBytes=${Math.min(...sizes)} pathChars=${rows[0].path.length}`);
    // Only the row's own identity fields and the three record fields are kept;
    // no capture blob or acceptance marker. Long paths and names are kept exactly.
    const allowedFields = ['path', 'name', 'ext', 'addedAt', 'source', 'captureSessionId', 'captureSessionObserved',
      'assetOrigin', 'projectRole', 'excludedRecordVersion', 'excludedAt', 'excludedAppFamily'];
    records.forEach((record, index) => {
      assert.deepEqual(Object.keys(record).filter(key => !allowedFields.includes(key)), [], `record ${index + 1} fields`);
      assert.equal(record.path, rows[index].path);
      assert.equal(record.name, rows[index].name);
      assert.equal(record.excludedRecordVersion, 1);
      assert.equal(record.excludedAppFamily, 'indesign');
    });
    const workspace = await f.workspace();
    assert.equal(workspace.excludedPendingFiles.length, count + 1, 'every record is projected');
    assert.equal(workspace.excludedPendingFiles.some(file => file.name === 'Legacy-only.png'), false, 'the legacy key is not shown');
    for (const index of [0, 499, 1000]) {
      const target = workspace.excludedPendingFiles[index].visualIdentity;
      assert.ok(await f.accept(target), `include #${index + 1}`);
    }
    assert.equal(f.current().excludedPendingFiles.length, count + 1 - 3);
    assert.ok(f.current().excludedAssetKeys.includes(desk('Legacy-only.png')), 'the legacy key is never deleted');
    const included = new Set(f.current().files.map(file => file.path));
    for (const index of [0, 499, 1000]) assert.ok(included.has(rows[index].path));
    assert.equal((await f.workspace()).excludedPendingFiles.length, count + 1 - 3);
  });

  // --- End-to-end choice, scan and + Add Files paths (real IPC) ---
  const resolveChoice = (f, entry, choice, predecessorIdentity = null) => callIpcRaw('projects:resolve-working-file-choice', f.id,
    { id: entry.id, revision: entry.revision, choice, predecessorIdentity });
  async function addThroughPicker(f, name) {
    if (!fs.existsSync(desk(name))) fs.writeFileSync(desk(name), name.endsWith('.ai') ? '%PDF-1.7\n%%EOF\n' : `synthetic ${name}`);
    manualDialogFor([desk(name)]);
    const result = await callIpcRaw('projects:add-files', f.id);
    assert.ok(getAddFilesResultFiles(result).some(row => row.path === desk(name)), JSON.stringify(result));
    clearTrackedTimers();
  }
  // Two selected working files (A, C) added through the real picker, their own choice answered.
  async function selectedSourcesFixture(label) {
    const f = await fixture(label, { sources: [] });
    await addThroughPicker(f, 'A.ai');
    await addThroughPicker(f, 'C.ai');
    const initial = (await f.workspace()).workingFileChoices.choices[0];
    assert.ok(initial?.ready, JSON.stringify(initial));
    assert.equal((await resolveChoice(f, initial, 'keep-both')).success, true);
    const row = pendingRow('B.ai');
    if (!fs.existsSync(row.path)) fs.writeFileSync(row.path, '%PDF-1.7\n%%EOF\n');
    metadataTestHooks.mutateProjectForTest(f.id, project => { project.pendingFiles = [{ ...structuredClone(row), addedAt: Date.now() }]; return {}; });
    const target = (await f.workspace()).pendingFiles.find(file => file.name === 'B.ai')?.visualIdentity;
    assert.ok(target, 'B.ai is in Needs Review');
    return { f, target };
  }
  const choiceSummary = entry => entry && ({ route: entry.route, ready: entry.ready, source: entry.source?.name,
    predecessors: (entry.predecessors || []).map(item => item.name).sort() });

  for (const choice of ['replace', 'keep-both']) {
    excludedTest(`Include from Excluded raises the same Replace/Keep both choice as a direct accept, and ${choice} resolves it`, { timeout: 60000 }, async () => {
      const summaries = {};
      for (const route of ['direct', 'excluded']) {
        const { f, target } = await selectedSourcesFixture(`choice-${choice}-${route}`);
        if (route === 'excluded') {
          assert.ok(Array.isArray(await f.reject(target)));
          const before = await f.workspace();
          assert.equal(before.workingFileChoices.choices.length, 0, 'excluding raises no choice');
          assert.deepEqual(before.excludedPendingFiles.map(file => file.name), ['B.ai']);
        }
        assert.ok(await f.accept(target), `${route} include`);
        const ws = await f.workspace();
        const entry = ws.workingFileChoices.choices.find(item => item.source?.name === 'B.ai');
        assert.ok(entry, `${route}: choice raised`);
        assert.equal(entry.route, 'accepted-pending');
        summaries[route] = choiceSummary(entry);
        const record = f.current().files.find(file => file.name === 'B.ai');
        assert.equal(metadataTestHooks.getWorkingSourceVerificationForTest(f.current(), record)?.status, 'scanned', `${route}: scan ran`);
        assert.equal(entry.ready, true, JSON.stringify(entry));
        const predecessor = entry.predecessors.find(item => item.name === 'A.ai');
        const response = await resolveChoice(f, entry, choice, choice === 'replace' ? predecessor.visualIdentity : null);
        assert.equal(response.success, true, JSON.stringify(response));
        const after = await f.workspace();
        const selection = name => after.files.find(row => row.name === name)?.sourceSelection;
        assert.deepEqual(['A.ai', 'B.ai', 'C.ai'].map(selection),
          choice === 'replace' ? ['excluded', 'selected', 'selected'] : ['selected', 'selected', 'selected'], `${route} ${choice} membership`);
        assert.equal(after.workingFileChoices.choices.length, 0);
        assert.equal(after.excludedPendingFiles.length, 0);
        assert.equal(f.current().excludedAssetKeys.includes(desk('B.ai')), false);
      }
      assert.deepEqual(summaries.excluded, summaries.direct, 'identical choice record for both paths');
    });
  }

  excludedTest('Include from Excluded with no other selected working file raises no choice and still scans', { timeout: 30000 }, async () => {
    const row = pendingRow('Solo.ai');
    const f = await fixture('solo-design', { sources: [], pending: [row] });
    const target = (await f.workspace()).pendingFiles[0].visualIdentity;
    assert.ok(Array.isArray(await f.reject(target)));
    assert.ok(await f.accept(target));
    const ws = await f.workspace();
    assert.equal(ws.workingFileChoices.choices.length, 0);
    const solo = ws.files.find(file => file.name === 'Solo.ai');
    assert.deepEqual([solo.protectedSource, solo.sourceSelection], [true, 'selected']);
    assert.equal(metadataTestHooks.getWorkingSourceVerificationForTest(f.current(), f.current().files.find(file => file.name === 'Solo.ai'))?.status, 'scanned');
  });

  excludedTest('+ Add Files of a remembered file includes it and prunes only its record; other records and legacy keys are untouched', { timeout: 30000 }, async () => {
    const rows = [pendingRow('Readd.png'), pendingRow('Other.png')];
    const f = await fixture('add-files-prune', { pending: rows });
    const originalBytes = fs.readFileSync(desk('Readd.png'));
    f.current().excludedAssetKeys = [desk('Legacy.png')];
    roundTripFakeStore();
    for (const row of rows) assert.ok(Array.isArray(await f.reject(row.path)));
    assert.deepEqual(f.current().excludedPendingFiles.map(record => record.name), ['Readd.png', 'Other.png']);

    await addThroughPicker(f, 'Readd.png');

    assert.deepEqual(f.current().excludedPendingFiles.map(record => record.name), ['Other.png'], 'only the re-added file is pruned');
    assert.deepEqual([...f.current().excludedAssetKeys].sort(), [desk('Legacy.png'), desk('Other.png')].sort(),
      '+ Add Files clears only its own exclusion; the other record and the legacy key keep theirs');
    const ws = await f.workspace();
    assert.deepEqual(ws.excludedPendingFiles.map(file => file.name), ['Other.png']);
    const readded = ws.files.find(file => file.name === 'Readd.png');
    assert.deepEqual([readded.excluded, readded.included], [false, true], 'the explicitly added file is Included');
    // Exactly one row for the file: one project file, no remembered row, nothing in Needs Review.
    assert.equal([...ws.files, ...ws.pendingFiles, ...ws.excludedPendingFiles].filter(file => file.name === 'Readd.png').length, 1);
    assert.equal(f.current().files.filter(file => file.path === desk('Readd.png')).length, 1);
    assert.deepEqual(fs.readFileSync(desk('Readd.png')), originalBytes, 'the original file is untouched');
    assert.ok((await metadataTestHooks.selectProjectFilesForPackagingForTest(f.id)).some(file => file.path === desk('Readd.png')));
    assert.equal((await metadataTestHooks.selectProjectFilesForPackagingForTest(f.id)).some(file => file.path === desk('Other.png')), false);
  });

  // Store reads and project mutations must not do per-file path work because a
  // remembered exclusion exists. Counted, not timed: realpath calls are
  // compared on the same 500-file project without and then with one record.
  excludedTest('a remembered exclusion adds no per-file path work to store reads or mutations (500 project files)', { timeout: 120000 }, async () => {
    const count = 500;
    const f = await fixture('operation-count', { sources: [] });
    const folder = desk('Operation count');
    fs.mkdirSync(folder, { recursive: true });
    f.current().files = Array.from({ length: count }, (_, index) => ({ path: path.join(folder, `Linked_${index}.png`),
      name: `Linked_${index}.png`, ext: '.png', source: 'indd-linked', projectRole: 'asset', addedAt: Date.now() }));
    const remembered = desk('Remembered.png');
    f.current().excludedAssetKeys = [remembered];
    roundTripFakeStore();
    const measure = () => {
      const original = fs.realpathSync.native;
      let calls = 0;
      fs.realpathSync.native = function (...args) { calls += 1; return original.apply(this, args); };
      try {
        calls = 0; metadataTestHooks.getProjectsForTest(); const read = calls;
        calls = 0; metadataTestHooks.mutateProjectForTest(f.id, () => ({})); const mutate = calls;
        return { read, mutate };
      } finally { fs.realpathSync.native = original; }
    };
    const without = measure();
    f.current().excludedPendingFiles = [{ path: remembered, name: 'Remembered.png', ext: '.png', source: 'indd-linked',
      excludedRecordVersion: 1, excludedAt: Date.now(), excludedAppFamily: 'indesign' }];
    roundTripFakeStore();
    const withRecord = measure();
    const detail = `realpath calls with one record ${JSON.stringify(withRecord)} vs none ${JSON.stringify(without)}`;
    // Reads: no path work at all for records. One mutation: only the record's
    // own key (one call per record); the project-file key set is reused.
    assert.equal(withRecord.read, without.read, detail);
    assert.equal(withRecord.mutate, without.mutate + 1, detail);
    assert.equal(f.current().files.length, count);
    assert.deepEqual(f.current().excludedPendingFiles.map(record => record.name), ['Remembered.png'], 'the unshadowed record is kept');
  });

  excludedTest('a row that would make an invalid record is refused alone; remembered rows stay valid', { timeout: 30000 }, async () => {
    const good = pendingRow('Good.png');
    const bad = pendingRow('Nameless.png', { name: null });
    const f = await fixture('invalid-record', { pending: [good, bad] });
    assert.ok(Array.isArray(await f.reject(good.path)));
    const keys = JSON.stringify(f.current().excludedAssetKeys);
    const observations = f.observations();
    assert.deepEqual(await f.reject(bad.path), { success: false, error: 'excluded_pending_record_invalid' });
    assert.ok(f.current().pendingFiles.some(row => row.path === bad.path), 'the refused row stays in Needs Review');
    assert.equal(JSON.stringify(f.current().excludedAssetKeys), keys);
    assert.equal(f.observations(), observations);
    assert.deepEqual((await f.workspace()).excludedPendingFiles.map(file => file.name), ['Good.png'], 'the list is still valid and shown');
  });
}
