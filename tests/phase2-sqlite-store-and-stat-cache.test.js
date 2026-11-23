'use strict';

const assert = require('./bounded-assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Store = require('electron-store');
const { CrateSqliteStore, SQLITE_FILENAME } = require('../parsers/sqlite-store');

function makeUserDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-sqlite-store-'));
  fs.chmodSync(dir, 0o700);
  const realDir = fs.realpathSync.native(dir);
  t.after(() => fs.rmSync(realDir, { recursive: true, force: true }));
  return realDir;
}

test('CrateSqliteStore: migrates legacy electron-store config non-destructively and preserves permissions', t => {
  const userData = makeUserDataDir(t);
  const defaults = {
    projects: [],
    settings: { namingTemplate: '{ProjectName}', notifications: true },
    usage: { packagesThisMonth: 0, resetDate: '2026-12-01' },
  };
  const legacy = new Store({ cwd: userData, configFileMode: 0o600, defaults });
  legacy.set('projects', [
    { id: 'p1', name: 'Alpha', status: 'watching', files: [{ path: '/Users/synthetic/a.ai', name: 'a.ai' }] },
    { id: 'p2', name: 'Beta', status: 'paused', files: [] },
  ]);
  legacy.set('usage', { packagesThisMonth: 3, resetDate: '2026-12-01' });
  legacy.set('quickPackageOutputPaths', ['/Users/synthetic/Out']);
  const legacySnapshotBefore = fs.readFileSync(legacy.path, 'utf8');

  const sqlite = new CrateSqliteStore({ userDataRealPath: userData, defaults });
  t.after(() => sqlite.close());

  assert.equal(sqlite.migrateFromLegacyStore(legacy), true);
  assert.equal(sqlite.migrateFromLegacyStore(legacy), false, 'migration is idempotent');
  assert.equal(fs.readFileSync(legacy.path, 'utf8'), legacySnapshotBefore, 'legacy config.json stays intact for rollback');

  // Owner-only permissions on sqlite files
  assert.equal(fs.lstatSync(path.join(userData, SQLITE_FILENAME)).mode & 0o777, 0o600);

  const projects = sqlite.get('projects', []);
  assert.deepEqual(projects.map(p => p.id), ['p1', 'p2']);
  assert.equal(sqlite.get('usage').packagesThisMonth, 3);
  assert.deepEqual(sqlite.get('quickPackageOutputPaths'), ['/Users/synthetic/Out']);
  assert.equal(sqlite.get('settings.namingTemplate'), '{ProjectName}');
});

test('CrateSqliteStore: per-project reads/upserts isolate mutations and preserve atomic transactions', t => {
  const userData = makeUserDataDir(t);
  const defaults = {
    projects: [],
    settings: { namingTemplate: '{ProjectName}', notifications: true },
    usage: { packagesThisMonth: 0, resetDate: '2026-12-01' },
  };
  const sqlite = new CrateSqliteStore({ userDataRealPath: userData, defaults });

  sqlite.upsertProject({ id: 'p1', name: 'First', status: 'watching', files: [] });
  sqlite.upsertProject({ id: 'p2', name: 'Second', status: 'paused', files: [] });

  // Mutating returned object without persisting does not corrupt stored state.
  const copy = sqlite.getProjectById('p1');
  copy.name = 'Uncommitted';
  assert.equal(sqlite.getProjectById('p1').name, 'First');

  // Committed upsert persists across close/reopen.
  copy.name = 'Committed';
  assert.equal(sqlite.upsertProject(copy), true);
  assert.equal(sqlite.upsertProject(copy), false, 'identical upsert is a no-op');

  // Nested settings set/delete and multi-key atomic commit + rollback on error.
  sqlite.set('settings.packagePortablePictures', true);
  assert.equal(sqlite.get('settings.packagePortablePictures'), true);
  sqlite.delete('settings.packagePortablePictures');
  assert.equal(sqlite.get('settings.packagePortablePictures'), undefined);

  assert.throws(() => {
    sqlite.transaction(() => {
      sqlite.set('usage', { packagesThisMonth: 99, resetDate: '2026-12-01' });
      throw new Error('simulated crash');
    });
  }, /simulated crash/);
  assert.equal(sqlite.get('usage').packagesThisMonth, 0, 'failed transaction rolls back cleanly');

  // Multi-key atomic set (persistPackageCompletion shape)
  sqlite.set({
    projects: [
      { id: 'p1', name: 'Committed', status: 'packaged', files: [] },
      { id: 'p2', name: 'Second', status: 'paused', files: [] },
    ],
    usage: { packagesThisMonth: 1, resetDate: '2026-12-01' },
    quickPackageOutputPaths: ['/Users/synthetic/Pkg'],
  });
  sqlite.close();

  const reopened = new CrateSqliteStore({ userDataRealPath: userData, defaults });
  t.after(() => reopened.close());
  assert.equal(reopened.getProjectById('p1').status, 'packaged');
  assert.equal(reopened.getProjectById('p2').name, 'Second');
  assert.equal(reopened.get('usage').packagesThisMonth, 1);
  assert.deepEqual(reopened.get('quickPackageOutputPaths'), ['/Users/synthetic/Pkg']);
});

test('CrateSqliteStore: rejects symlink SQLite database or WAL paths', t => {
  const userData = makeUserDataDir(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-sqlite-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

  const target = path.join(outside, 'target.sqlite');
  fs.writeFileSync(target, '');
  fs.symlinkSync(target, path.join(userData, SQLITE_FILENAME));

  assert.throws(
    () => new CrateSqliteStore({ userDataRealPath: userData }),
    /could not secure local SQLite storage/
  );
});

test('CrateSqliteStore: stat-keyed cache persists across restarts and invalidates on any file change', t => {
  const userData = makeUserDataDir(t);
  const assetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-stat-cache-asset-'));
  t.after(() => fs.rmSync(assetDir, { recursive: true, force: true }));

  const fontPath = path.join(assetDir, 'Sample.otf');
  fs.writeFileSync(fontPath, 'font-bytes-v1');
  const statV1 = fs.lstatSync(fontPath, { bigint: true });

  const sqlite = new CrateSqliteStore({ userDataRealPath: userData, maxStatCacheEntries: 64 });
  assert.equal(sqlite.getStatCache('font-inspect', fontPath, statV1), null);
  assert.equal(sqlite.setStatCache('font-inspect', fontPath, statV1, { sha256: 'a'.repeat(64), parsed: [] }), true);
  sqlite.close();

  // Reopen simulating cold app restart -> exact hit!
  const reopened = new CrateSqliteStore({ userDataRealPath: userData, maxStatCacheEntries: 64 });
  t.after(() => reopened.close());
  const hit = reopened.getStatCache('font-inspect', fontPath, statV1);
  assert.deepEqual(hit, { sha256: 'a'.repeat(64), parsed: [] });

  // Modify file bytes (changes size & mtime/ctime) -> automatic cache miss!
  fs.writeFileSync(fontPath, 'font-bytes-v2-longer');
  const statV2 = fs.lstatSync(fontPath, { bigint: true });
  assert.equal(reopened.getStatCache('font-inspect', fontPath, statV2), null);

  // Replace inode with identical byte length -> automatic cache miss!
  const tempPath = path.join(assetDir, 'Sample.tmp');
  fs.writeFileSync(tempPath, 'font-bytes-v1');
  fs.renameSync(tempPath, fontPath);
  const statV3 = fs.lstatSync(fontPath, { bigint: true });
  assert.notEqual(statV3.ino, statV1.ino);
  assert.equal(reopened.getStatCache('font-inspect', fontPath, statV3), null);
});

test('CrateSqliteStore: rejects hardlinked database file (nlink > 1) and recovers transaction flag after BEGIN failure (A-P1-6)', t => {
  const userData = makeUserDataDir(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-sqlite-hardlink-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

  const target = path.join(outside, 'shared.sqlite');
  fs.writeFileSync(target, '');
  fs.linkSync(target, path.join(userData, SQLITE_FILENAME));

  assert.throws(
    () => new CrateSqliteStore({ userDataRealPath: userData }),
    /could not secure local SQLite storage/
  );

  // Separate clean profile: inject a BEGIN IMMEDIATE failure and confirm inTransaction does NOT stick
  const cleanDir = makeUserDataDir(t);
  const sqlite = new CrateSqliteStore({
    userDataRealPath: cleanDir,
    defaults: { projects: [], usage: { packagesThisMonth: 0 } },
  });
  t.after(() => sqlite.close());

  const originalExec = sqlite.db.exec.bind(sqlite.db);
  let failOnce = true;
  sqlite.db.exec = (sql) => {
    if (failOnce && sql === 'BEGIN IMMEDIATE') {
      failOnce = false;
      throw new Error('SQLITE_BUSY');
    }
    return originalExec(sql);
  };

  assert.throws(() => sqlite.transaction(() => {
    sqlite.set('usage', { packagesThisMonth: 5 });
  }), /SQLITE_BUSY/);
  assert.equal(sqlite.inTransaction, false, 'inTransaction must remain false when BEGIN IMMEDIATE fails');

  // Subsequent transaction must still roll back atomically on error
  assert.throws(() => sqlite.transaction(() => {
    sqlite.set('usage', { packagesThisMonth: 77 });
    throw new Error('rollback_check');
  }), /rollback_check/);
  assert.equal(sqlite.get('usage').packagesThisMonth, 0);
});

test('CrateSqliteStore: concurrent/second migration on same profile is atomic and preserves legacy JSON for rollback (N1)', t => {
  const userData = makeUserDataDir(t);
  const defaults = {
    projects: [],
    settings: { namingTemplate: '{ProjectName}' },
    usage: { packagesThisMonth: 0 },
  };
  const legacy = new Store({ cwd: userData, configFileMode: 0o600, defaults });
  legacy.set('projects', [{ id: 'p-orig', name: 'Original', status: 'paused', files: [] }]);
  const legacyBefore = fs.readFileSync(legacy.path, 'utf8');

  const storeA = new CrateSqliteStore({ userDataRealPath: userData, defaults });
  const storeB = new CrateSqliteStore({ userDataRealPath: userData, defaults });
  t.after(() => { storeA.close(); storeB.close(); });

  // Prime storeB's in-memory kvCache with pre-migration _meta = undefined so storeB's
  // fast pre-check misses and it MUST hit the authoritative in-transaction SQLite check.
  assert.equal(storeB._getKvRaw('_meta'), undefined);

  assert.equal(storeA.migrateFromLegacyStore(legacy), true);
  storeA.set('settings.postUpgradeFlag', true);

  // storeB's stale cache passes pre-check, then its BEGIN IMMEDIATE check sees _meta,
  // skips re-migrating, and rehydrates storeA's migrated project and post-upgrade setting.
  assert.equal(storeB.migrateFromLegacyStore(legacy), false);
  assert.deepEqual(storeB.get('projects').map(p => p.id), ['p-orig']);
  assert.equal(storeB.get('settings.postUpgradeFlag'), true);
  // Legacy JSON stays intact on disk (pre-upgrade rollback snapshot)
  assert.equal(fs.readFileSync(legacy.path, 'utf8'), legacyBefore);
});

test('CrateSqliteStore: migration rolls back without _meta on missing, non-object, or duplicate legacy project IDs (A5)', t => {
  const defaults = {
    projects: [],
    settings: { namingTemplate: '{ProjectName}', notifications: true },
    usage: { packagesThisMonth: 0, resetDate: '2026-12-01' },
  };

  const invalidCases = [
    {
      label: 'missing id',
      projects: [{ id: 'p-valid', name: 'Good', files: [] }, { name: 'MissingId', files: [] }],
      expectedInvalid: 1,
      expectedDuplicate: 0,
    },
    {
      label: 'empty string id',
      projects: [{ id: 'p-valid', name: 'Good', files: [] }, { id: '', name: 'EmptyId', files: [] }],
      expectedInvalid: 1,
      expectedDuplicate: 0,
    },
    {
      label: 'non-object entry (null / string / array)',
      projects: [{ id: 'p-valid', name: 'Good', files: [] }, null, 'bad-entry', ['nested']],
      expectedInvalid: 3,
      expectedDuplicate: 0,
    },
    {
      label: 'duplicate id',
      projects: [
        { id: 'p-dup', name: 'First', files: [] },
        { id: 'p-dup', name: 'Second', files: [] },
      ],
      expectedInvalid: 0,
      expectedDuplicate: 1,
    },
  ];

  for (const tc of invalidCases) {
    const userData = makeUserDataDir(t);
    const legacy = new Store({ cwd: userData, configFileMode: 0o600, defaults });
    legacy.set('projects', tc.projects);
    legacy.set('usage', { packagesThisMonth: 9, resetDate: '2026-12-01' });
    const legacySnapshot = fs.readFileSync(legacy.path, 'utf8');

    const sqlite = new CrateSqliteStore({ userDataRealPath: userData, defaults });
    t.after(() => sqlite.close());

    assert.throws(
      () => sqlite.migrateFromLegacyStore(legacy),
      err => err
        && err.code === 'CRATE_LEGACY_MIGRATION_INVALID_PROJECTS'
        && err.legacyCount === tc.projects.length
        && err.invalidEntries === tc.expectedInvalid
        && err.duplicateIds === tc.expectedDuplicate,
      `migration must reject ${tc.label}`
    );

    assert.equal(sqlite._getKvRaw('_meta'), undefined, `_meta must not be written after ${tc.label}`);
    assert.deepEqual(sqlite.get('projects', []), [], `no partial projects should commit after ${tc.label}`);
    assert.equal(sqlite.get('usage').packagesThisMonth, 0, `usage should roll back after ${tc.label}`);
    assert.equal(fs.readFileSync(legacy.path, 'utf8'), legacySnapshot, `legacy JSON must remain intact after ${tc.label}`);

    // Once legacy projects are repaired to valid unique IDs, migration on the same DB succeeds cleanly
    legacy.set('projects', [{ id: 'p-repaired', name: 'Repaired', status: 'paused', files: [] }]);
    assert.equal(sqlite.migrateFromLegacyStore(legacy), true, `repaired profile should migrate after ${tc.label}`);
    assert.deepEqual(sqlite.get('projects', []).map(p => p.id), ['p-repaired']);
    assert.equal(sqlite._getKvRaw('_meta')?.migratedFromLegacy, true);
  }
});

test('main.js startup falls back to JSON only on CRATE_LEGACY_MIGRATION_INVALID_PROJECTS and stays fail-closed on other SQLite errors (A5)', t => {
  const vm = require('node:vm');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const startMarker = 'let localStorePaths = null;';
  const endMarker = '// One-time migration: update old naming template format to new one';
  const startIdx = mainSource.indexOf(startMarker);
  const endIdx = mainSource.indexOf(endMarker);
  assert.ok(startIdx > 0 && endIdx > startIdx, 'must locate main.js startup store initialization block');
  const initSnippet = mainSource.slice(startIdx, endIdx);

  function runStartupBlock(userData) {
    const warnings = [];
    const marks = [];
    const configPath = path.join(userData, 'config.json');
    const context = {
      fs,
      path,
      console: { warn: msg => warnings.push(String(msg)) },
      gotLock: true,
      Store,
      CrateSqliteStore,
      OWNER_ONLY_FILE_MODE: 0o600,
      DEFAULT_NAMING_TEMPLATE: '{ProjectName}',
      PACKAGE_OUTPUT_LAYOUT_MODES: { BY_EXTENSION: 'by-extension-v1' },
      getNextMonthReset: () => '2026-12-01',
      app: { getPath: () => userData },
      startupPhaseJournal: { mark: m => marks.push(m) },
      preflightLocalStorePaths: () => ({ userDataRealPath: userData, configPath }),
      hardenLocalStorePermissions: () => true,
      validateLocalStoreShape: candidate => {
        if (!Array.isArray(candidate.get('projects', null))) throw new Error('invalid shape');
      },
      migrateSettings: () => {},
    };
    vm.runInNewContext(
      `${initSnippet}\nthis.__result = { store, localStoreStartupError };`,
      context
    );
    return { ...context.__result, warnings, marks };
  }

  // Case 1: duplicate project ID -> closes SQLite without _meta, logs sanitized counts, falls back to JSON store
  const dupDir = makeUserDataDir(t);
  const legacyDup = new Store({
    cwd: dupDir,
    configFileMode: 0o600,
    defaults: {
      projects: [],
      settings: { namingTemplate: '{ProjectName}', notifications: true },
      usage: { packagesThisMonth: 0, resetDate: '2026-12-01' },
    },
  });
  legacyDup.set('projects', [
    { id: 'secret-dup-project-id', name: 'One', files: [] },
    { id: 'secret-dup-project-id', name: 'Two', files: [] },
  ]);

  const fallbackRes = runStartupBlock(dupDir);
  assert.equal(fallbackRes.localStoreStartupError, null);
  assert.ok(fallbackRes.store && typeof fallbackRes.store.openInEditor === 'function', 'must fall back to electron-store JSON');
  assert.equal(fallbackRes.store.get('projects').length, 2, 'JSON fallback preserves all legacy entries');
  assert.equal(fallbackRes.warnings.length, 1);
  assert.ok(fallbackRes.warnings[0].includes('legacyCount=2'));
  assert.ok(fallbackRes.warnings[0].includes('duplicateIds=1'));
  assert.equal(fallbackRes.warnings[0].includes('secret-dup-project-id'), false, 'warning must not leak project IDs');
  assert.equal(fallbackRes.warnings[0].includes(dupDir), false, 'warning must not leak userData path');

  const checkDb = new CrateSqliteStore({ userDataRealPath: dupDir });
  t.after(() => checkDb.close());
  assert.equal(checkDb._getKvRaw('_meta'), undefined, '_meta must remain absent after fallback');
  assert.deepEqual(checkDb.get('projects', []), []);

  // Case 2: non-validation SQLite error (symlinked DB) MUST still fail closed (store === null)
  const symlinkDir = makeUserDataDir(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-sqlite-failclosed-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const outsideDb = path.join(outside, 'target.sqlite');
  fs.writeFileSync(outsideDb, '');
  fs.symlinkSync(outsideDb, path.join(symlinkDir, SQLITE_FILENAME));

  const failClosedRes = runStartupBlock(symlinkDir);
  assert.equal(failClosedRes.store, null, 'non-validation SQLite errors must stay fail-closed');
  assert.ok(
    failClosedRes.localStoreStartupError && typeof failClosedRes.localStoreStartupError.message === 'string',
    'fail-closed startup must set localStoreStartupError'
  );
  assert.match(failClosedRes.localStoreStartupError.message, /could not secure local settings storage/);
  assert.ok(failClosedRes.marks.includes('store-preflight-failed'));
});
