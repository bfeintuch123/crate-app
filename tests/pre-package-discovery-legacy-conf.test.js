'use strict';
// Actual Conf from initial store construction through fresh-process restart.
// Electron and OS metadata remain source-harness doubles. No frozen clock.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');

if (process.env.CRATE_LEGACY_CONF_WORKER === '1') {
  const root = process.env.CRATE_LEGACY_SOURCE_ROOT;
  const entry = path.join(root, 'tests/provenance-dual-write.test.js');
  global.__legacyInitialDisk = JSON.parse(fs.readFileSync(path.join(process.env.CRATE_LEGACY_CONF_HOME, 'user-data', 'config.json'), 'utf8'));
  let source = fs.readFileSync(entry, 'utf8');
  function once(before, after) {
    assert.equal(source.split(before).length - 1, 1, `legacy adapter drift: ${before}`);
    source = source.replace(before, () => after);
  }
  // Parent owns fixture cleanup; child processes retain the exact database and
  // physical files for the next restart. Unrelated registrations are suppressed.
  once("const test = require('node:test');", "const test = new Proxy(require('node:test'), { apply() {}, get(target, key) { if (key === 'after' || key === 'afterEach') return () => {}; return Reflect.get(target, key); } });");
  once("const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-provenance-dual-write-home-'));", "const TEST_HOME = fs.realpathSync(process.env.CRATE_LEGACY_CONF_HOME);");
  const start = source.indexOf('class FakeStore {');
  const end = source.indexOf("setStub('electron-store', () => FakeStore);", start);
  assert.ok(start > 0 && end > start, 'real-store adapter boundaries');
  source = source.slice(0, start) + `const LegacyConfConstructor = originalLoad.call(Module, 'conf', module);
  class FakeStore extends LegacyConfConstructor {
    constructor(options = {}) {
      super({ ...options, projectName: 'synthetic-legacy-parity', watch: false });
      storeInstance = this;
      this.projectSetCount = 0;
    }
    set(key, ...args) {
      if (key === 'projects' && Number.isFinite(this.projectSetCount)) this.projectSetCount++;
      return super.set(key, ...args);
    }
  }
` + source.slice(end);
  once("  let source = fs.readFileSync(filename, 'utf8');", "  let source = global.__legacyMainInstrument(fs.readFileSync(filename, 'utf8'));");
  global.__legacyMainInstrument = text => {
    assert.equal(require('node:crypto').createHash('sha256').update(text).digest('hex'), process.env.CRATE_LEGACY_EXPECTED_MAIN_SHA, 'worker must load the exact declared source bytes');
    function replace(before, after) {
      assert.equal(text.split(before).length - 1, 1, `legacy main adapter drift: ${before}`);
      text = text.replace(before, () => after);
    }
    replace('  const lastUsedCandidates = [];', "  global.__legacyPhase = 'traversal';\n  const lastUsedCandidates = [];");
    replace('  const recentLastUsedCandidates = new Array(lastUsedCandidates.length).fill(false);', "  global.__legacyPhase = 'metadata'; global.__legacyCandidates = lastUsedCandidates.length;\n  const recentLastUsedCandidates = new Array(lastUsedCandidates.length).fill(false);");
    const mutant = process.env.CRATE_LEGACY_NORMALIZER_MUTANT;
    if (mutant) {
      const names = { asset: 'normalizeProjectAssetReviewState', evidence: 'clearPersistedCurrentSessionFilesystemEvidence', figma: 'migrateProjectFigmaLinkPrivacy' };
      assert.ok(Object.hasOwn(names, mutant));
      replace(`    if (${names[mutant]}(project)) changed = true;`, '    // Test-only missing-normalizer mutant.');
    }
    return text;
  };
  const compiled = new Module(entry, module);
  compiled.filename = entry;
  compiled.paths = Module._nodeModulePaths(path.dirname(entry));
  compiled._compile(source + '\n(' + worker.toString() + ')().catch(error => { console.error(error); process.exitCode = 1; });', entry);
} else {
  const test = require('node:test');
  const candidate = path.resolve(__dirname, '..');
  const control = process.env.CRATE_DISCOVERY_CONTROL_ROOT;
  const roots = control ? [path.resolve(control), candidate] : [candidate];
  const sourceHashes = roots.map(root => require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root, 'main.js'))).digest('hex'));
  if (control) {
    assert.notEqual(fs.realpathSync(roots[0]), fs.realpathSync(roots[1]), 'control must be a distinct checkout');
    assert.notEqual(sourceHashes[0], sourceHashes[1], 'counterfactual parity requires different source bytes');
  }
  for (const scenario of ['legacy', 'invalid-baseline', 'legacy-at-yield']) {
    test(`real Conf ${scenario}: normalization, scan and process restart preserve state${control ? ' identically to base' : ''}`, { timeout: 30000 }, t => {
      const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crate-legacy-parity-')));
      t.after(() => fs.rmSync(home, { recursive: true, force: true }));
      const epoch = Date.UTC(2026, 10, 1);
      for (const folder of ['Desktop/Discovery', 'Documents', 'Downloads', 'Desktop/Output', 'user-data']) fs.mkdirSync(path.join(home, folder), { recursive: true, mode: 0o700 });
      const folder = path.join(home, 'Desktop', 'Discovery');
      const accepted = path.join(folder, 'Accepted.png');
      const pending = path.join(folder, 'Pending.png');
      const files = [accepted, pending, path.join(home, 'Desktop', 'Output', 'Excluded.png')];
      for (let i = 0; i < 735; i++) files.push(path.join(folder, `image-${String(i).padStart(4, '0')}.png`));
      for (const file of files) { fs.writeFileSync(file, 'synthetic legacy fixture'); fs.utimesSync(file, (epoch - 2000) / 1000, (epoch - 2000) / 1000); }
      const legacyUrl = 'https://www.figma.com/file/ABC123/Synthetic?page-id=1%3A1';
      const common = { type: 'branding', status: 'paused', createdAt: epoch, watchStartedAt: epoch, watchSessionId: 'synthetic-session', figmaScopeMode: 'current-page', figmaSession: { scopeMode: 'current-page', startedAt: epoch, teamIds: [], trackedFiles: [], sessionWarnings: [], warnings: [] }, pendingFiles: [], provenance: { schemaVersion: 1, sessionId: null, nodes: {}, edges: {}, observations: [], evidence: {} } };
      const seed = {
        projects: [
          { ...common, id: '00000000-0000-4000-8000-000000001001', name: 'Synthetic legacy target', files: [{ path: accepted, name: 'Accepted.png', ext: '.png', source: 'manual-browse', addedAt: epoch - 3000, assetOrigin: 'old-origin', projectRole: 'old-role', currentSessionFilesystemEvidence: { stale: true } }], pendingFiles: [{ path: pending, name: 'Pending.png', ext: '.png', source: 'lastused-scan', addedAt: epoch - 3000, currentSessionFilesystemEvidence: { stale: true } }], excludedAssetKeys: ['kept-exclusion', '', 'kept-exclusion', null], legacySentinel: { retain: ['target', 7] }, ...(scenario === 'invalid-baseline' ? { assetBaseline: { schemaVersion: 999, status: 'included', decision: 'include' } } : {}) },
          { ...common, id: '00000000-0000-4000-8000-000000001002', name: 'Synthetic legacy neighbor', status: 'archived', outputPath: path.join(home, 'Desktop', 'Output'), files: [], excludedAssetKeys: ['neighbor-key', 'neighbor-key'], figmaTrackedFiles: [{ key: 'ABC123', url: legacyUrl, name: 'Synthetic old label' }], figmaSession: { scopeMode: 'current-page', trackedFiles: [{ key: 'ABC123', url: legacyUrl, scopeMode: 'current-page', lockStatus: 'pending' }] }, legacySentinel: { retain: ['neighbor', 9] } },
        ],
        settings: { namingTemplate: '{Project}', notifications: true, packageOutputLayoutMode: 'flat', includeDiagnosticReport: false, showPackageDetails: true },
        usage: { packagesThisMonth: 2, resetDate: '2026-12-01T00:00:00.000Z' },
        quickPackageOutputPaths: [path.join(home, 'Desktop', 'Output'), path.join(home, 'Desktop', 'Output'), ''],
        legacySentinel: { retain: ['root', { exact: true }] },
      };
      const seedFile = path.join(home, 'seed.json');
      fs.writeFileSync(seedFile, JSON.stringify(seed), { mode: 0o600 });
      const records = [];
      for (let arm = 0; arm < roots.length; arm++) {
        const config = path.join(home, 'user-data', 'config.json');
        const armRecords = [];
        for (const phase of ['normalize-only', 'first', 'restart']) {
          // The scan receives the original legacy database, not the normalized
          // oracle produced by the separate getter-only process.
          if (phase !== 'restart') fs.writeFileSync(config, JSON.stringify(seed), { mode: 0o600 });
          const receipt = path.join(home, `receipt-${arm}-${phase}.json`);
          const env = { ...process.env, CRATE_MAIN_UNDER_TEST: path.join(roots[arm], 'main.js'), CRATE_LEGACY_EXPECTED_MAIN_SHA: sourceHashes[arm], CRATE_LEGACY_CONF_WORKER: '1', CRATE_LEGACY_SOURCE_ROOT: roots[arm], CRATE_LEGACY_CONF_HOME: home, CRATE_LEGACY_CONF_RECEIPT: receipt, CRATE_LEGACY_CONF_SCENARIO: scenario, CRATE_LEGACY_CONF_PHASE: phase, CRATE_LEGACY_CONF_ORACLE: path.join(home, `receipt-${arm}-normalize-only.json`) };
          delete env.NODE_TEST_CONTEXT;
          if (arm === 0 && roots.length === 2) delete env.CRATE_LEGACY_NORMALIZER_MUTANT;
          const run = spawnSync(process.execPath, [__filename], { env, encoding: 'utf8', timeout: 12000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
          assert.equal(run.error, undefined, run.stdout + run.stderr);
          assert.equal(run.signal, null);
          assert.equal(run.status, 0, run.stdout + run.stderr);
          armRecords.push(JSON.parse(fs.readFileSync(receipt, 'utf8')));
        }
        assert.deepEqual(armRecords[0].initialDisk, seed, 'initialization must receive the exact legacy seed');
        assert.deepEqual(armRecords[1].initialDisk, seed, 'the scan process must receive the exact legacy seed');
        assert.deepEqual(armRecords[1].beforeScan.projects, seed.projects, 'the scan must also exercise unnormalized legacy projects after startup');
        assert.deepEqual(armRecords[2].initialDisk, armRecords[1].afterScan, 'restart must consume the exact prior file before initialization');
        assert.deepEqual(armRecords[2].boot, armRecords[1].afterScan, 'fresh process must read the exact prior durable state');
        assert.deepEqual(armRecords[2].afterNormalize, armRecords[1].afterScan, 'restart normalization must be idempotent');
        assert.deepEqual(armRecords[2].afterScan, armRecords[1].afterScan, 'fresh scan must preserve the fully normalized legacy state');
        records.push(armRecords);
      }
      if (roots.length === 2) assert.deepEqual(records[1], records[0], 'complete actual-Conf snapshots and outcomes must equal unchanged base, without dropping fields');
      t.diagnostic(JSON.stringify({ scenario, arms: roots.length, sourceHashes, actualConf: '10.2.0', candidates: 735, restart: 'fresh Node process', exactPersistenceParity: roots.length === 2, mutatedAtYield: records[0][1].mutatedAtYield, scanProjectWrites: records.map(arm => arm.map(phase => phase.scanProjectWrites)) }));
    });
  }
}

async function worker() {
  const assert = require('node:assert/strict');
  const immediate = global.setImmediate;
  try {
  const clone = value => JSON.parse(JSON.stringify(value));
  const Conf = originalLoad.call(Module, 'conf', module);
  assert.equal(originalLoad.call(Module, 'conf/package.json', module).version, '10.2.0');
  assert.ok(storeInstance instanceof LegacyConfConstructor, 'Conf must back startup and all subsequent source operations');
  const seed = JSON.parse(fs.readFileSync(path.join(TEST_HOME, 'seed.json'), 'utf8'));
  const scenario = process.env.CRATE_LEGACY_CONF_SCENARIO;
  const phase = process.env.CRATE_LEGACY_CONF_PHASE;
  const disk = () => JSON.parse(fs.readFileSync(storeInstance.path, 'utf8'));
  const boot = disk();
  const initialDisk = global.__legacyInitialDisk;
  const inputFiles = fs.readdirSync(path.join(TEST_HOME, 'Desktop', 'Discovery')).map(name => path.join(TEST_HOME, 'Desktop', 'Discovery', name));
  const beforeBytes = inputFiles.map(file => fs.readFileSync(file));
  let mutatedAtYield = false;
    setChildProcessHandler(request => {
      const files = bulkXattrPaths(request);
      return { stdout: files.length ? formatBulkXattrOutput(files, () => encodeLastUsedXattr(seed.projects[0].watchStartedAt - 1000)) : '' };
    });
    if (phase === 'first') {
      // Initialization repairs persisted projects. Explicitly model a later
      // legacy store write so the scan itself must run the normalizers too.
      storeInstance.set('projects', clone(seed.projects));
    } else await callIpcRaw('projects:get-all');
    const beforeScan = disk();
    if (phase === 'first') {
      assert.equal(Object.hasOwn(beforeScan.projects[0].files[0], 'currentSessionFilesystemEvidence'), true);
      assert.equal(JSON.stringify(beforeScan).includes('https://www.figma.com/'), true);
    }
    const afterNormalize = phase === 'first'
      ? JSON.parse(fs.readFileSync(process.env.CRATE_LEGACY_CONF_ORACLE, 'utf8')).afterNormalize
      : disk();
    const expectedBaseline = scenario === 'invalid-baseline' ? 'invalid' : 'legacy-included';
    assert.equal(afterNormalize.projects[0].assetBaseline.status, expectedBaseline);
    assert.equal(afterNormalize.projects[0].assetBaseline.decision, expectedBaseline === 'invalid' ? null : 'include');
    assert.deepEqual(afterNormalize.projects[0].excludedAssetKeys, ['kept-exclusion']);
    assert.equal(afterNormalize.projects[0].files[0].projectRole, 'asset');
    assert.equal(afterNormalize.projects[0].files[0].assetOrigin, expectedBaseline === 'invalid' ? 'added' : 'existing');
    for (const project of afterNormalize.projects) for (const file of [...project.files, ...project.pendingFiles]) assert.equal(Object.hasOwn(file, 'currentSessionFilesystemEvidence'), false);
    const neighbor = afterNormalize.projects[1];
    assert.equal(neighbor.figmaTrackedFiles[0].key, 'ABC123');
    assert.equal(neighbor.figmaTrackedFiles[0].requestedPageId, '1:1');
    assert.equal(JSON.stringify(afterNormalize).includes('https://www.figma.com/'), false, 'legacy raw locators must not persist');
    assert.deepEqual(afterNormalize.projects.map(p => p.legacySentinel), seed.projects.map(p => p.legacySentinel));
    assert.deepEqual(afterNormalize.legacySentinel, seed.legacySentinel);
    assert.deepEqual(afterNormalize.quickPackageOutputPaths, seed.quickPackageOutputPaths);
    if (phase === 'normalize-only') {
      fs.writeFileSync(process.env.CRATE_LEGACY_CONF_RECEIPT, JSON.stringify({ initialDisk, boot, beforeScan, afterNormalize, afterScan: afterNormalize, result: null, mutatedAtYield: false, scanProjectWrites: 0 }), { mode: 0o600 });
      return;
    }
    if (scenario === 'legacy-at-yield' && phase === 'first') {
      global.setImmediate = (callback, ...args) => immediate(() => {
        if (global.__legacyPhase === 'traversal' && !mutatedAtYield) {
          const rows = storeInstance.get('projects');
          rows[1] = clone(seed.projects[1]);
          storeInstance.set('projects', rows);
          assert.equal(JSON.stringify(disk()).includes('https://www.figma.com/'), true);
          mutatedAtYield = true;
        }
        callback(...args);
      });
    }
    const writesBefore = storeInstance.projectSetCount;
    const result = await callIpcRaw('projects:pre-package-scan', seed.projects[0].id);
    assert.equal(result.error, undefined);
    assert.equal(result.newCount, 0);
    assert.equal(global.__legacyCandidates, 735);
    assert.equal(mutatedAtYield, scenario === 'legacy-at-yield' && phase === 'first');
    const afterScan = disk();
    assert.deepEqual(afterScan, afterNormalize, 'stale discovery must retain every normalized durable field');
    const restarted = new Conf({ cwd: path.dirname(storeInstance.path), projectName: 'synthetic-legacy-parity', watch: false });
    assert.deepEqual(clone(restarted.store), afterScan);
    await callIpcRaw('projects:get-all');
    assert.deepEqual(disk(), afterScan);
    inputFiles.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), beforeBytes[index]));
    assert.equal(fs.statSync(storeInstance.path).mode & 0o777, 0o600);
    fs.writeFileSync(process.env.CRATE_LEGACY_CONF_RECEIPT, JSON.stringify({ initialDisk, boot, beforeScan, afterNormalize, afterScan, result, mutatedAtYield, scanProjectWrites: storeInstance.projectSetCount - writesBefore }), { mode: 0o600 });
  } finally {
    global.setImmediate = immediate;
    clearTrackedTimers();
    global.setInterval = originalSetInterval; global.clearInterval = originalClearInterval;
    global.setTimeout = originalSetTimeout; global.clearTimeout = originalClearTimeout;
    os.homedir = originalHomedir;
  }
}
