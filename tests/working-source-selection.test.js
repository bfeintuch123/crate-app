'use strict';

// Bounded tests of production functions with an in-memory project writer and
// filesystem. No Electron, private config, producer apps, dependency acquisition,
// or standalone persistence framework is loaded by this suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const Module = require('node:module');
const vm = require('node:vm');
const { extractLinkedAssetsFromBuffer } = require('../parsers/add-files-regex-worker');
const { runBoundedAddFilesScan } = require('../parsers/add-files-operation');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function between(start, end) {
  const first = main.indexOf(start);
  const last = main.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `production anchor drift: ${start}`);
  return main.slice(first, last);
}

function fixture({ figmaScopeMode = 'entire-file' } = {}) {
  let api;
  let projects = [];
  const disk = new Map();
  const physical = new Map();
  let nextInode = 1n;
  const events = [];
  const invalidated = [];
  const watchSyncCalls = [];
  let digestGate = null;
  let afterScan = null;
  let documentIdentityReader = () => null;
  let authorized = true;
  let epoch = 0;
  let cloneStore = false;
  let failNextStoreWrite = false;
  let failAfterStoreWrite = false;
  let afterStoreWrite = null;
  let realStore = null;
  const context = vm.createContext({
    path, crypto,
    runBoundedAddFilesScan, ADD_FILES_SCAN_TIMEOUT_MS: 1000,
    fs: { existsSync: filePath => disk.has(filePath), lstatSync: filePath => {
      if (!disk.has(filePath)) throw new Error('missing');
      const stat = physical.get(filePath);
      return { ...stat, isFile: () => true, isSymbolicLink: () => stat?.symlink === true };
    }, statSync: filePath => {
      if (!disk.has(filePath)) throw new Error('missing');
      return { dev: 1, ino: 1, size: disk.get(filePath).length, mtimeMs: 0, ctimeMs: 0, isFile: () => true };
    } },
    getAddFilesSourceIdentity: stat => ({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs }),
    getProjects: () => realStore ? realStore.get('projects', []) : cloneStore ? structuredClone(projects) : projects,
    getTrackedFileDedupKey: file => file.path.toLowerCase(),
    normalizeTrackedFilePath: filePath => typeof filePath === 'string' ? filePath.toLowerCase() : '',
    isProjectAssetBaselineSource: file => file?.projectRole === 'source',
    getIllustratorScopedProjectView: project => project,
    deduplicateFiles: files => [...new Map(files.map(file => [file.path.toLowerCase(), file])).values()],
    isScanOnSaveEmbeddedPsdFile: file => !!(file?.embedded && file.source === 'scan-on-save-embedded'),
    isAssetReviewFileExcluded: (project, file) => (project.excludedAssetKeys || []).includes(file.path),
    sanitizeRendererSourceName: name => String(name).replace(/[\r\n]/g, '').slice(0, 256),
    getPackageSelectionInputSignature: project => crypto.createHash('sha256').update(JSON.stringify(project)).digest('hex'),
    getIllustratorSnapshotFailureReason: query => query?.failed ? 'partial' : null,
    getFreshActiveWatchingProject: id => projects.find(project => project.id === id),
    getIllustratorActivationScope: () => null,
    runOsascriptInPrivateTemp: async build => ({ stdout: JSON.stringify(documentIdentityReader(Object.values(build({}))[0])) }),
    getAssetBaselineSourcePhysicalIdentityHash: (project, stat) => stat && crypto.createHash('sha256')
      .update(JSON.stringify([project.id, String(stat.dev), String(stat.ino), String(stat.birthtimeNs)])).digest('hex'),
    captureProjectOperation: id => {
      const capturedEpoch = epoch;
      let open = true;
      return { current: () => open && authorized && capturedEpoch === epoch && context.getProjects().some(p => p.id === id),
        close: () => { open = false; }, adoptScope: () => true };
    },
    mutateProject: (id, fn) => {
      const next = cloneStore ? structuredClone(projects) : projects;
      const project = next.find(p => p.id === id);
      if (!project) return null;
      const result = fn(project);
      if (cloneStore && failNextStoreWrite) { failNextStoreWrite = false; throw new Error('synthetic-store-write-failed'); }
      if (cloneStore) projects = next;
      if (cloneStore && failAfterStoreWrite) { failAfterStoreWrite = false; throw new Error('synthetic-store-write-uncertain'); }
      if (cloneStore && afterStoreWrite) { const callback = afterStoreWrite; afterStoreWrite = null; callback(); }
      return result;
    },
    resolveProjectOwnedFileVisualRecord: (id, identity, project) =>
      (project?.files || []).find(file => identity === `${id}:${file.fileId}`),
    createProjectFileVisualIdentity: (id, file) => `${id}:${file.fileId}`,
    invalidatePackageReviewForProject: id => invalidated.push(id),
    // MODELED closed/no-watcher collaborator only. The complete-main harness
    // separately exercises actual allocator and callback functions; this VM
    // neither creates subscriptions nor proves native event delivery.
    syncAcceptedSourceWatchSubscriptions: projectId => {
      assert.equal(context.getProjects().find(project => project.id === projectId)?.status, 'paused');
      watchSyncCalls.push({ projectId, watcherState: 'closed/no-watcher' });
    },
    sendToRenderer: (event, payload) => events.push({ event, payload }),
    reconcileProjectAssetBaselineScanSources() {},
    getAddFilesCurrentSourceDigest: async (filePath, lease) => {
      if (digestGate) await digestGate();
      if (!lease.current()) throw new Error('stale');
      if (!disk.has(filePath)) throw new Error('missing');
      return crypto.createHash('sha256').update(disk.get(filePath)).digest('hex');
    },
    REGEX_SOURCE_EXTENSIONS: new Set(['.ai', '.pdf', '.xd', '.ppt', '.fig']),
    extractLinkedAssetsRegex: async filePath => extractLinkedAssetsFromBuffer(disk.get(filePath), filePath, path.extname(filePath)),
    SCAN_ON_OPEN_EXTENSIONS: new Set(['.ai', '.pdf', '.xd', '.ppt', '.fig', '.psd']),
    runScanOnOpen: async (id, filePath, token, operation, options) =>
      (await context.runBoundedScanOnOpenQueue(id, [filePath], token, operation, options)).outcomes[0],
    runBoundedScanOnOpenQueue: async (id, paths, token, operation, options) => {
      const outcomes = [];
      for (const filePath of paths) {
        const scan = api.beginWorkingSourceScan(id, filePath, operation.current, options.workingSourceAttempt, options.excludedWorkingSourcePreparation);
        try {
          const digest = await context.getAddFilesCurrentSourceDigest(filePath, operation);
          const evidence = api.collectWorkingSourceScanEvidence(await context.extractLinkedAssetsRegex(filePath));
          if (digest !== await context.getAddFilesCurrentSourceDigest(filePath, operation)) throw new Error('source-bytes-changed');
          api.publishWorkingSourceScan(scan, { ...evidence, status: evidence.limited ? 'limited' : 'scanned',
            sourceIdentity: api.getWorkingSourceDiskIdentity(scan.file), sourceFingerprint: digest });
          outcomes.push({ success: true });
        } catch (_) { outcomes.push({ success: false, error: 'scan_on_open_failed' }); }
      }
      if (afterScan) await afterScan();
      return { cancelled: !operation.current(), outcomes };
    },
    isBroadObserverOnlyAcceptedFile: () => false,
    getProjectFigmaScopeMode: () => figmaScopeMode,
    FIGMA_SCOPE_CURRENT_PAGE: 'current-page',
    shouldIncludeFigmaAssetForPackaging: () => true,
    formatFigmaLocalNameForLog: filePath => path.basename(filePath),
    formatFigmaLogScalar: value => String(value),
    isObservedPrimarySourceFile: () => false,
    shouldKeepObservedSourceFileForPackaging: async () => true,
    deduplicatePackageSourceMastersForOutput: (project, files) => files,
    console: { log() {} },
  });
  vm.runInContext(
    // Production capture-authority definitions used by working-source membership.
    between('const EXPLICIT_USER_CAPTURE_SOURCES = new Set([', 'const STRONG_SESSION_LIVE_CAPTURE_REASONS') +
    between('function getFileCaptureSource(', 'function getFileCaptureReason(') +
    between('function hasExplicitUserAuthority(', 'function grantExplicitUserAuthority(') +
    between('function isExplicitUserCapturedFile(', 'function isSavedOrConfirmedProjectFile(') +
    between('function sanitizeLiveEvidenceText(', 'function sanitizeRendererSourceName(') +
    between('const DEPENDENCY_CAPTURE_SOURCES = new Set([', 'function createAssetBaselineState(') +
    between('function getAssetBaselineSourceRecoveryRouteKey(', 'function getWorkingSourceSelection(') +
    between('function getWorkingSourceSelection(', 'function getAssetBaselineSourcePhysicalIdentityHash(') +
    between('async function selectProjectFilesForPackaging(', 'function isDesignAppFile(') , context);
  api = vm.runInContext('({getWorkingSourceSelection, getWorkingSourceVerification, getWorkingSourceMembership, setWorkingSourceSelection, resolveWorkingFileChoice, getAssetBaselineSourceRecoveryRouteKey, selectProjectFilesForPackaging, beginWorkingSourceScan, collectWorkingSourceScanEvidence, publishWorkingSourceScan, failWorkingSourceScan, workingSourceScanLeases, workingSourceScanOperations, getWorkingSourceDiskIdentity, recordWorkingSourceContinuationCandidate, resolveWorkingSourceContinuation, getWorkingSourceContinuationPresentation, observeIllustratorWorkingSourceContinuation, refreshWorkingSourceLocators, retireInterruptedWorkingSourceScan: typeof retireInterruptedWorkingSourceScan === "function" ? retireInterruptedWorkingSourceScan : null, refreshWorkingSourceVerification, getWorkingFileVerificationReason})', context);
  const source = (name, fileId = name) => {
    const file = { path: `/Users/synthetic/${name}`, name, fileId, ext: path.extname(name), projectRole: 'source' };
    disk.set(file.path, Buffer.from('%PDF-1.7\n%%EOF\n'));
    physical.set(file.path, { dev: 1n, ino: nextInode++, birthtimeNs: 100n, nlink: 1n });
    return file;
  };
  const asset = name => {
    const file = { path: `/Users/synthetic/${name}`, name, fileId: name, ext: path.extname(name), projectRole: 'asset' };
    disk.set(file.path, Buffer.from('synthetic asset'));
    return file;
  };
  const project = { id: 'project-a', status: 'paused', files: [], excludedAssetKeys: [] };
  projects.push(project);
  const command = (file, action, expectedRevision = api.getWorkingSourceSelection(context.getProjects()[0], file).revision) =>
    api.setWorkingSourceSelection(project.id, `${project.id}:${file.fileId}`, { action, expectedRevision });
  return { api, project, source, asset, disk, physical, command, events, invalidated, watchSyncCalls,
    reload() { projects = JSON.parse(JSON.stringify(projects)); return projects[0]; },
    replace(project) { projects = [project]; },
    useClonedStore() { cloneStore = true; },
    useRealStore(store) {
      store.set('projects', projects); realStore = store;
      Object.assign(context, { store, capturePsdReceiptHeldMembers: () => null,
        clearFileVisualProjectCache() {}, normalizeAutoCaptureProjectState() {}, normalizeProjectAssetReviewState() {},
        safelyEnsureProjectProvenance() {}, retireRemovedPsdReceiptHolds() {} });
      vm.runInContext(between('function mutateProject(', '// FIX 2 (C2):'), context);
    },
    failNextStoreWrite() { failNextStoreWrite = true; },
    failAfterStoreWrite() { failAfterStoreWrite = true; },
    afterStoreWrite(callback) { afterStoreWrite = callback; },
    snapshot() { return structuredClone(context.getProjects()[0]); },
    revoke() { authorized = false; },
    changeGeneration() { epoch++; },
    setDigestGate(callback) { digestGate = callback; },
    setAfterScan(callback) { afterScan = callback; },
    setDocumentIdentityReader(callback) { documentIdentityReader = callback; } };
}

test('v25 selection fixture keeps rejected requests outside its modeled closed Watch collaborator', async () => {
  const f = fixture(), source = f.source('Original.ai'); f.project.files.push(source);
  assert.equal((await f.api.setWorkingSourceSelection(f.project.id, 'foreign:source',
    { action: 'exclude', expectedRevision: 0 })).success, false);
  assert.equal((await f.command(source, 'exclude', 1)).success, false);
  assert.deepEqual(f.watchSyncCalls, []);
  assert.equal((await f.command(source, 'exclude')).success, true);
  assert.equal((await f.command(source, 'restore')).selection.state, 'selected');
  assert.deepEqual(f.watchSyncCalls, Array.from({ length: 2 }, () => ({ projectId: f.project.id, watcherState: 'closed/no-watcher' })));
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }

test('legacy selection remains selected; independent equal-name sources both survive the selector', async () => {
  const f = fixture();
  const a = f.source('Document.ai', 'one');
  const b = { ...f.source('other.ai', 'two'), name: 'Document.ai' };
  f.project.files.push(a, b);
  assert.deepEqual(plain(f.api.getWorkingSourceSelection(f.project, a)), { state: 'selected', reason: null, revision: 0 });
  assert.equal(f.api.getWorkingSourceMembership(f.project).blocked, false);
  assert.equal((await f.api.selectProjectFilesForPackaging(f.project)).length, 2);
  assert.equal(f.project.workingSourceSelections, undefined);
});

test('exclusion preserves bytes, inventory and reason across row absence, re-add, Add All and reload', async () => {
  const f = fixture();
  const a = f.source('Original.ai');
  const asset = f.asset('Image.png');
  f.project.files.push(a, asset);
  const before = Buffer.from(f.disk.get(a.path));
  const result = await f.command(a, 'exclude');
  assert.equal(result.success, true);
  assert.equal(result.selection.reason, 'user-excluded');
  assert.deepEqual(f.watchSyncCalls, [{ projectId: f.project.id, watcherState: 'closed/no-watcher' }]);
  assert.equal(f.project.files.length, 2);
  assert.deepEqual(f.disk.get(a.path), before);
  assert.deepEqual((await f.api.selectProjectFilesForPackaging(f.project)).map(file => file.name), ['Image.png']);
  f.project.files = [asset];
  const restored = f.reload();
  restored.files.push({ ...a, fileId: 'new-row-id', source: 'user-added', acceptedPending: true });
  restored.excludedAssetKeys = []; // Ordinary Add All changes only asset intent.
  assert.equal(f.api.getWorkingSourceSelection(restored, restored.files[1]).state, 'excluded');
  assert.equal(f.api.getWorkingSourceSelection(restored, restored.files[1]).reason, 'user-excluded');
  assert.equal(f.api.getWorkingSourceMembership(restored).counts.excludedWorkingSources, 1);
  assert.equal((await f.api.selectProjectFilesForPackaging(restored)).length, 1);
  assert.equal(f.api.getWorkingSourceSelection({ ...restored, id: 'project-b' }, a).state, 'selected');
});

test('IPC rejects foreign identity, extra reasons/paths and stale revision; exclusion is idempotent', async () => {
  const f = fixture();
  const a = f.source('Original.ai');
  f.project.files.push(a);
  assert.equal((await f.api.setWorkingSourceSelection('project-a', 'project-b:Original.ai', { action: 'exclude', expectedRevision: 0 })).success, false);
  assert.equal((await f.api.setWorkingSourceSelection('project-a', 'project-a:Original.ai', { action: 'exclude', expectedRevision: 0, reason: 'superseded' })).error, 'invalid_working_source_selection');
  assert.equal(f.project.workingSourceSelections, undefined);
  assert.equal((await f.command(a, 'exclude')).selection.revision, 1);
  assert.equal((await f.command(a, 'exclude', 0)).error, 'working_source_selection_stale');
  assert.equal((await f.command(a, 'exclude', 1)).selection.revision, 1);
  assert.equal((await f.command(a, 'restore', 0)).success, false);
});

test('explicit Restore clears reason with ordinary-scan evidence without certifying an empty inventory', async () => {
  const f = fixture();
  const a = f.source('Original.ai');
  f.project.files.push(a);
  await f.command(a, 'exclude');
  const result = await f.command(a, 'restore');
  assert.equal(result.selection.state, 'selected');
  assert.equal(result.selection.reason, null);
  assert.equal(result.selection.revision, 2);
  assert.equal(result.verificationStatus, 'scanned');
  const record = f.api.getWorkingSourceVerification(f.project, a);
  assert.equal(record.sourceFingerprint, crypto.createHash('sha256').update(f.disk.get(a.path)).digest('hex'));
  assert.equal(record.requiredReferences.length, 0);
  assert.equal(f.api.getWorkingSourceMembership(f.project).blocked, false);
  assert.equal(record.notes[0], 'required-reference-domain-unverified');
  assert.ok(f.invalidated.length >= 2);
  assert.deepEqual(f.watchSyncCalls, Array.from({ length: 2 }, () => ({ projectId: f.project.id, watcherState: 'closed/no-watcher' })));
});

test('missing linked path is retained as an unresolved requirement before existence filtering', async () => {
  const f = fixture();
  const a = f.source('Original.ai');
  f.project.files.push(a);
  const missing = '/Users/synthetic/Missing.png';
  f.disk.set(a.path, Buffer.from(`%PDF-1.7\n${missing}\n%%EOF\n`));
  await f.command(a, 'exclude');
  await f.command(a, 'restore');
  const record = f.api.getWorkingSourceVerification(f.project, a);
  assert.equal(record.requiredReferences[0].path, missing);
  assert.equal(f.api.getWorkingSourceMembership(f.project).counts.missingRequiredReferences, 1);
  assert.equal(f.api.getWorkingSourceMembership(f.project).blocked, true);
});

test('an excluded working role required by several retained sources stays one asset with all requiring names', async () => {
  const f = fixture();
  const original = f.source('Original.ai');
  const one = f.source('One.ai');
  const two = f.source('Two.ai');
  f.project.files.push(original, one, two);
  for (const source of [one, two]) {
    f.disk.set(source.path, Buffer.from(`%PDF-1.7\n${original.path}\n%%EOF\n`));
    await f.command(source, 'exclude');
    await f.command(source, 'restore');
  }
  await f.command(original, 'exclude');
  const fact = f.api.getWorkingSourceMembership(f.project).facts.get(original.path.toLowerCase());
  assert.equal(fact.effectiveRole, 'asset');
  assert.equal(fact.includedAsDependency, true);
  assert.deepEqual(plain(fact.requiredBy), ['One.ai', 'Two.ai']);
  assert.equal((await f.api.selectProjectFilesForPackaging(f.project)).filter(file => file.path === original.path).length, 1);
  await f.command(one, 'exclude');
  const next = f.api.getWorkingSourceMembership(f.project).facts.get(original.path.toLowerCase());
  assert.deepEqual(plain(next.requiredBy), ['Two.ai']);
  assert.equal(f.api.getWorkingSourceMembership(f.project).blocked, false);
});

test('publication correction: denied Figma dependency blocks final membership without bypassing Current Page scope', async () => {
  const f = fixture({ figmaScopeMode: 'current-page' });
  const root = f.source('Root.ai');
  const required = f.source('Required.fig');
  f.project.files.push(root, required);
  f.disk.set(root.path, Buffer.from(`%PDF-1.7\n${required.path}\n%%EOF\n`));
  await f.command(root, 'exclude');
  await f.command(root, 'restore');
  await f.command(required, 'exclude');
  assert.equal(f.api.getWorkingSourceMembership(f.project).blocked, false);
  const selected = await f.api.selectProjectFilesForPackaging(f.project);
  assert.deepEqual(selected.map(file => file.name), ['Root.ai']);
  const finalMembership = f.api.getWorkingSourceMembership(f.project, selected);
  assert.equal(finalMembership.counts.missingRequiredReferences, 1);
  assert.equal(finalMembership.blocked, true);
});

test('exclusion wins over an in-flight Restore and cannot finish a newer Restore attempt', async () => {
  const f = fixture();
  const a = f.source('Original.ai');
  f.project.files.push(a);
  await f.command(a, 'exclude');
  const gate = deferred();
  let entered = false;
  f.setDigestGate(async () => { entered = true; await gate.promise; });
  const oldRestore = f.command(a, 'restore');
  assert.equal(entered, true);
  await f.command(a, 'exclude');
  assert.equal(f.api.getWorkingSourceSelection(f.project, a).state, 'excluded');
  f.setDigestGate(null);
  await f.command(a, 'restore');
  const newest = JSON.stringify(f.project.workingSourceVerification);
  gate.resolve();
  await oldRestore;
  assert.equal(JSON.stringify(f.project.workingSourceVerification), newest);
  assert.equal(f.api.getWorkingSourceSelection(f.project, a).revision, 4);
});

test('late Restore cannot publish into a same-ID recreated project or after account/generation revocation', async () => {
  for (const change of ['recreate', 'account', 'generation']) {
    const f = fixture();
    const a = f.source('Original.ai');
    f.project.files.push(a);
    await f.command(a, 'exclude');
    const gate = deferred();
    f.setDigestGate(() => gate.promise);
    const pending = f.command(a, 'restore');
    if (change === 'recreate') {
      f.replace({ id: f.project.id, status: 'paused', files: [{ ...a }], excludedAssetKeys: [] });
    } else if (change === 'account') f.revoke();
    else f.changeGeneration();
    gate.resolve();
    await pending;
    const current = f.reload();
    if (change === 'recreate') assert.equal(current.workingSourceVerification, undefined);
    else assert.equal(f.api.getWorkingSourceVerification(current, current.files[0]).status, 'pending');
  }
});

test('invalid persisted intent fails closed even when its source row is absent', () => {
  const f = fixture();
  f.project.files.push(f.asset('Image.png'));
  f.project.workingSourceSelections = { [crypto.randomBytes(32).toString('hex')]: { state: 'excluded', reason: 'arbitrary', revision: 1 } };
  assert.equal(f.api.getWorkingSourceMembership(f.project).blocked, true);
});

test('only explicitly persisted relationship holds block; ordinary coexistence never invents one', () => {
  const f = fixture();
  f.project.files.push(f.source('One.ai'), f.source('Two.ai'));
  assert.equal(f.api.getWorkingSourceMembership(f.project).counts.relationshipHolds, 0);
  f.project.workingSourceRelationshipHolds = [{ signal: 'explicit-partial-producer-signal' }];
  assert.equal(f.api.getWorkingSourceMembership(f.project).blocked, true);
  assert.equal(f.api.getWorkingSourceMembership(f.project).counts.relationshipHolds, 1);
});

test('current regex capability cannot distinguish empty complete proof from unsupported reference encoding', () => {
  const ordinary = Buffer.from('%PDF-1.7\n%%EOF\n');
  const unsupported = Buffer.from('%PDF-1.7\n(LinkResourceURI="file:/opt/synthetic/Required.png")\n%%EOF\n');
  assert.deepEqual(extractLinkedAssetsFromBuffer(ordinary, '/Users/synthetic/Test.ai', '.ai'), []);
  assert.deepEqual(extractLinkedAssetsFromBuffer(unsupported, '/Users/synthetic/Test.ai', '.ai'), []);
  assert.throws(() => extractLinkedAssetsFromBuffer(Buffer.from('%PDF-1.7\nmalformed'), '/Users/synthetic/Test.ai', '.ai'), /invalid_structure/);
});


test('excluding pending verification preserves its evidence and rejects late completion before retry', async () => {
  const f = fixture(), a = f.source('Original.ai');
  f.project.files.push(a);
  await f.command(a, 'exclude');
  const gate = deferred();
  f.setDigestGate(() => gate.promise);
  const oldRestore = f.command(a, 'restore');
  const key = f.api.getAssetBaselineSourceRecoveryRouteKey(f.project, a);
  const pending = f.project.workingSourceVerification[key];
  const fingerprint = 'a'.repeat(64);
  pending.sourceFingerprint = fingerprint;
  pending.requiredReferences = [{ path: '/synthetic/linked.png' }];
  pending.requiredEmbeddedOutputs = [{ path: '/synthetic/output.png', sourceDigest: fingerprint, outputDigest: 'b'.repeat(64) }];
  pending.unresolved = [{ reason: 'unresolved-declared-reference' }];
  f.project.workingFileDirtyHolds = { version: 1, records: { [key]: { version: 2, identities: [null] } } };
  f.project.workingSourceRelationshipHolds = [{ reason: 'psd-extraction-receipt-unverified', sourcePath: a.path }];
  const evidence = plain(pending), dirty = plain(f.project.workingFileDirtyHolds);
  const holds = plain(f.project.workingSourceRelationshipHolds);
  assert.equal((await f.command(a, 'exclude')).success, true);
  const excluded = plain(f.project.workingSourceVerification[key]);
  for (const field of ['requiredReferences', 'requiredEmbeddedOutputs', 'unresolved', 'sourceFingerprint', 'pendingReviewFacts']) {
    assert.deepEqual(excluded[field], evidence[field]);
  }
  assert.equal(excluded.status, 'stale');
  assert.equal(excluded.reason, 'scan-interrupted');
  assert.notEqual(excluded.attempt, evidence.attempt);
  assert.deepEqual(plain(f.project.workingFileDirtyHolds), dirty);
  assert.deepEqual(plain(f.project.workingSourceRelationshipHolds), holds);
  gate.resolve();
  await oldRestore;
  assert.deepEqual(plain(f.project.workingSourceVerification[key]), excluded);
  assert.equal(f.api.getWorkingSourceSelection(f.project, a).state, 'excluded');
});

test('Exclude cancels the old lease only after a cloned store accepts the new revision', async () => {
  const f = fixture(), a = f.source('Original.ai');
  f.project.files.push(a); f.useClonedStore();
  await f.command(a, 'exclude');
  const gate = deferred(); f.setDigestGate(() => gate.promise);
  const restore = f.command(a, 'restore');
  const pending = f.snapshot();
  const key = f.api.getAssetBaselineSourceRecoveryRouteKey(pending, a);
  let cancellations = 0;
  f.api.workingSourceScanLeases.set(`${f.project.id}:${key}`, { cancel: () => { cancellations++; } });
  try {
    f.failNextStoreWrite();
    await assert.rejects(f.command(a, 'exclude'), /synthetic-store-write-failed/);
    assert.deepEqual(f.snapshot(), pending);
    assert.equal(cancellations, 0);
    assert.equal((await f.command(a, 'exclude')).success, true);
    assert.equal(cancellations, 1);
    const excluded = f.snapshot();
    assert.equal(excluded.workingSourceVerification[key].status, 'stale');
    gate.resolve(); await restore;
    assert.deepEqual(f.snapshot(), excluded);
  } finally { gate.resolve(); await restore; }
});

test('an uncertain Exclude write leaves a committed receipt fenced from late completion', async () => {
  const f = fixture(), a = f.source('Original.ai');
  f.project.files.push(a); f.useClonedStore();
  await f.command(a, 'exclude');
  const gate = deferred(); f.setDigestGate(() => gate.promise);
  const restore = f.command(a, 'restore');
  const key = f.api.getAssetBaselineSourceRecoveryRouteKey(f.snapshot(), a);
  let cancellations = 0;
  f.api.workingSourceScanLeases.set(`${f.project.id}:${key}`, { cancel: () => { cancellations++; } });
  try {
    f.failAfterStoreWrite();
    await assert.rejects(f.command(a, 'exclude'), /synthetic-store-write-uncertain/);
    const committed = f.snapshot();
    assert.equal(committed.workingSourceVerification[key].status, 'stale');
    assert.equal(cancellations, 0);
    gate.resolve(); await restore;
    assert.deepEqual(f.snapshot(), committed);
  } finally { gate.resolve(); await restore; }
});

test('Exclude cancels only the lease captured before a reentrant replacement', async () => {
  const f = fixture(), a = f.source('Original.ai');
  f.project.files.push(a); f.useClonedStore();
  const key = f.api.getAssetBaselineSourceRecoveryRouteKey(f.snapshot(), a);
  const leaseKey = `${f.project.id}:${key}`;
  let oldCancelled = 0, newCancelled = 0;
  f.api.workingSourceScanLeases.set(leaseKey, { cancel: () => { oldCancelled++; } });
  f.afterStoreWrite(() => f.api.workingSourceScanLeases.set(leaseKey, { cancel: () => { newCancelled++; } }));
  assert.equal((await f.command(a, 'exclude')).success, true);
  assert.equal(oldCancelled, 1);
  assert.equal(newCancelled, 0);
});

let electronStoreAvailable = true;
try { require.resolve('electron-store'); } catch (_) { electronStoreAvailable = false; }
function createSyntheticElectronStore(tmp) {
  const originalLoad = Module._load;
  let Store;
  try {
    Module._load = function(request, ...args) {
      if (request === 'electron') return { app: { getPath: () => tmp, getVersion: () => '1.0.0' }, ipcMain: { on() {} } };
      return originalLoad.call(this, request, ...args);
    };
    Store = require('electron-store');
  } finally { Module._load = originalLoad; }
  return new Store({ cwd: tmp, projectVersion: '1.0.0', configFileMode: 0o600 });
}

for (const mode of ['before-write', 'after-write', 'reentrant-change']) {
  test(`Exclude with real Electron Store: ${mode}`, { skip: !electronStoreAvailable }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-receipt-store-'));
    const store = createSyntheticElectronStore(tmp);
    const f = fixture(), a = f.source('Original.ai'); f.project.files.push(a); f.useRealStore(store);
    const gate = deferred();
    try {
      await f.command(a, 'exclude');
      f.setDigestGate(() => gate.promise);
      const restore = f.command(a, 'restore');
      let before = f.snapshot();
      const key = f.api.getAssetBaselineSourceRecoveryRouteKey(before, a);
      const oldScan = mode === 'reentrant-change'
        ? f.api.beginWorkingSourceScan(f.project.id, a.path, () => true, before.workingSourceVerification[key].attempt) : null;
      if (oldScan) before = f.snapshot();
      const leaseKey = `${f.project.id}:${key}`;
      let oldCancelled = 0, newCancelled = 0;
      f.api.workingSourceScanLeases.set(leaseKey, { cancel: () => { oldCancelled++; } });
      const originalWrite = store._write;
      if (mode !== 'reentrant-change') store._write = function(value) {
        if (mode === 'before-write') throw new Error('synthetic-before-write');
        originalWrite.call(this, value);
        throw new Error('synthetic-after-write');
      };
      else store.events.once('change', () => {
        assert.equal(f.api.publishWorkingSourceScan(oldScan, { status: 'scanned' }), false);
        f.api.workingSourceScanLeases.set(leaseKey, { cancel: () => { newCancelled++; } });
      });
      if (mode === 'reentrant-change') {
        assert.equal((await f.command(a, 'exclude')).success, true);
        assert.equal(oldCancelled, 1); assert.equal(newCancelled, 0);
      } else {
        await assert.rejects(f.command(a, 'exclude'), new RegExp(`synthetic-${mode}`));
        assert.equal(oldCancelled, 0);
      }
      store._write = originalWrite;
      const after = f.snapshot();
      if (mode === 'before-write') assert.deepEqual(after, before);
      else assert.equal(after.workingSourceVerification[key].status, 'stale');
      gate.resolve(); await restore;
      if (mode !== 'before-write') assert.deepEqual(f.snapshot(), after);
    } finally { gate.resolve(); fs.rmSync(tmp, { recursive: true, force: true }); }
  });
}

test('legacy existing-asset exclusions retain their existing semantics until source selection is activated', async () => {
  const f = fixture();
  const source = f.source('Document.ai');
  const asset = f.asset('Image.png');
  asset.captureEvidence = { relationshipSourcePath: source.path };
  f.project.files.push(source, asset);
  f.project.excludedAssetKeys.push(asset.path);
  assert.deepEqual((await f.api.selectProjectFilesForPackaging(f.project)).map(file => file.name), ['Document.ai']);
  assert.equal(f.api.getWorkingSourceMembership(f.project).counts.includedAssets, 0);
  assert.equal(f.api.getWorkingSourceMembership(f.project).blocked, false);
});

test('excluding one root does not invent unresolved verification for an untouched retained source', async () => {
  const f = fixture(), a = f.source('Exclude.ai'), b = f.source('Untouched.ai');
  f.project.files.push(a, b);
  await f.command(a, 'exclude');
  const membership = f.api.getWorkingSourceMembership(f.project);
  assert.equal(membership.blocked, false);
  assert.equal(membership.counts.unresolvedVerification, 0);
  assert.equal(membership.facts.get(b.path.toLowerCase()).verificationRequired, false);
});

test('graph closure keeps transitive excluded source and asset roles without resurrecting root cycles', async () => {
  const f = fixture(), a = f.source('Root.ai'), b = f.source('Linked.psd'), c = f.asset('Nested.png');
  b.captureEvidence = { relationshipSourcePath: a.path };
  c.captureEvidence = { relationshipSourcePath: b.path };
  a.captureEvidence = { relationshipSourcePath: b.path };
  f.project.files.push(a, b, c); f.project.excludedAssetKeys.push(c.path);
  await f.command(b, 'exclude');
  let membership = f.api.getWorkingSourceMembership(f.project);
  assert.equal(membership.blocked, false);
  assert.equal(membership.facts.get(b.path.toLowerCase()).includedAsDependency, true);
  assert.equal(membership.facts.get(c.path.toLowerCase()).includedAsDependency, true);
  assert.deepEqual((await f.api.selectProjectFilesForPackaging(f.project)).map(file => file.name), ['Root.ai', 'Linked.psd', 'Nested.png']);
  await f.command(a, 'exclude');
  membership = f.api.getWorkingSourceMembership(f.project);
  assert.equal(membership.facts.get(b.path.toLowerCase()).included, false);
  assert.equal(membership.facts.get(c.path.toLowerCase()).included, false);
});

test('reference collections retain more than 512 and refuse overflow explicitly', () => {
  const f = fixture();
  const paths = Array.from({ length: 513 }, (_, index) => `/Users/synthetic/${index}.png`);
  const evidence = f.api.collectWorkingSourceScanEvidence(paths);
  assert.equal(evidence.requiredReferences.length, 513);
  assert.equal(evidence.limited, false);
  const overflow = f.api.collectWorkingSourceScanEvidence(Array.from({ length: 8193 }, (_, index) => `/Users/synthetic/${index}.png`));
  assert.equal(overflow.requiredReferences.length, 8192);
  assert.equal(overflow.limited, true);
  assert.ok(overflow.unresolved.some(item => item.reason === 'reference-coverage-limit'));
});

test('unclassified domain note does not erase declared media, malformed or pathless obligations', () => {
  const f = fixture();
  const evidence = f.api.collectWorkingSourceScanEvidence([], { reason: 'required-reference-domain-unverified',
    references: [{ rawPaths: { fullPath: '/Users/synthetic/missing.wav' } }, { rawPaths: { relativePath: '../pathless.mov' } }],
    unresolved: [{ reason: 'unsupported-video-reader-type' }] });
  assert.equal(evidence.requiredReferences[0].path, '/Users/synthetic/missing.wav');
  assert.ok(evidence.unresolved.some(item => item.reason === 'unsupported-video-reader-type'));
  assert.ok(evidence.unresolved.some(item => item.reason === 'unresolved-declared-reference'));
  assert.equal(f.api.collectWorkingSourceScanEvidence([]).unresolved.length, 0);
});

test('same-stat byte replacement invalidates verification before selecting package files', async () => {
  const f = fixture(), a = f.source('Document.ai'); f.project.files.push(a);
  await f.command(a, 'exclude'); await f.command(a, 'restore');
  assert.equal(f.api.getWorkingSourceMembership(f.project).blocked, false);
  const bytes = Buffer.from(f.disk.get(a.path)); bytes[0] = 33; f.disk.set(a.path, bytes);
  await f.api.selectProjectFilesForPackaging(f.project);
  assert.equal(f.api.getWorkingSourceVerification(f.project, a).status, 'stale');
  assert.equal(f.api.getWorkingSourceMembership(f.project).blocked, true);
});

test('generic no-extractor note differs from a connected provider interface block; selection is durable for both', async () => {
  for (const virtual of [false, true]) {
    const f = fixture(), a = f.source(virtual ? 'Cloud.fig' : 'Document.docx'); a.virtual = virtual;
    f.project.files.push(a); await f.command(a, 'exclude');
    const result = await f.command(a, 'restore');
    assert.equal(result.success, true);
    assert.equal(result.verificationStatus, virtual ? 'unavailable' : 'no-extractor');
    assert.equal(f.api.getWorkingSourceMembership(f.project).blocked, virtual);
    assert.equal(f.api.getWorkingSourceSelection(f.reload(), a).state, 'selected');
  }
});

test('late ordinary scan publication loses to exclusion and a newer verification attempt', async () => {
  const f = fixture(), a = f.source('Document.fig'); f.project.files.push(a);
  const old = f.api.beginWorkingSourceScan(f.project.id, a.path, () => true);
  await f.command(a, 'exclude'); await f.command(a, 'restore');
  const latest = JSON.stringify(f.project.workingSourceVerification);
  assert.equal(f.api.publishWorkingSourceScan(old, { status: 'scanned', requiredReferences: [], unresolved: [] }), false);
  assert.equal(JSON.stringify(f.project.workingSourceVerification), latest);
});

test('bounded no-extractor Restore times out as a concrete failure and its late read cannot publish', async () => {
  const f = fixture(), a = f.source('Document.docx'); f.project.files.push(a);
  await f.command(a, 'exclude'); const gate = deferred();
  f.setDigestGate(() => gate.promise);
  const result = await f.command(a, 'restore');
  assert.equal(result.verificationStatus, 'failed');
  assert.equal(f.api.getWorkingSourceMembership(f.project).blocked, true);
  const record = JSON.stringify(f.project.workingSourceVerification);
  gate.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.stringify(f.project.workingSourceVerification), record);
});

test('Exclude cancels the bounded no-extractor Restore promptly and preserves the new intent', async () => {
  const f = fixture(), a = f.source('Document.docx'); f.project.files.push(a);
  await f.command(a, 'exclude'); const gate = deferred(); let entered = false;
  f.setDigestGate(async () => { entered = true; await gate.promise; });
  const restore = f.command(a, 'restore');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(entered, true);
  await f.command(a, 'exclude'); await restore;
  const record = JSON.stringify(f.project.workingSourceVerification);
  assert.equal(f.api.getWorkingSourceSelection(f.project, a).state, 'excluded');
  gate.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.stringify(f.project.workingSourceVerification), record);
});

test('a virtual source without stable identity returns the precise interface blocker without writing invalid intent', async () => {
  const f = fixture(), a = f.source('Cloud.fig'); a.virtual = true; a.path = '';
  f.project.files.push(a);
  const result = await f.command(a, 'exclude');
  assert.equal(result.error, 'working_source_identity_unavailable');
  assert.equal(f.project.workingSourceSelections, undefined);
});

test('known ordinary-scan media obligations block when selection engages; absent legacy evidence does not', async () => {
  const f = fixture(), a = f.source('Media.psd'), b = f.source('Other.ai'); f.project.files.push(a, b);
  const scan = f.api.beginWorkingSourceScan(f.project.id, a.path, () => true);
  f.api.publishWorkingSourceScan(scan, { status: 'scanned', requiredReferences: [],
    unresolved: [{ reason: 'unverified-timeline-frame-reader-type' }], sourceIdentity: f.api.getWorkingSourceDiskIdentity(a),
    sourceFingerprint: crypto.createHash('sha256').update(f.disk.get(a.path)).digest('hex') });
  assert.equal(f.api.getWorkingSourceMembership(f.project).blocked, false);
  await f.command(b, 'exclude');
  const membership = f.api.getWorkingSourceMembership(f.project);
  assert.equal(membership.blocked, true); assert.equal(membership.counts.unresolvedVerification, 1);
  assert.equal(membership.facts.get(a.path.toLowerCase()).selectionRevision, 0);
});

function continuationRequest(f, choice = 'replace') {
  const candidate = f.api.getWorkingSourceContinuationPresentation(f.project).candidates[0];
  assert.ok(candidate, 'expected a specific current pair');
  return { pairIdentity: candidate.pairIdentity, evidenceIdentity: candidate.evidenceIdentity,
    expectedRevision: candidate.revision, predecessorSelectionRevision: candidate.predecessor.selectionRevision,
    successorSelectionRevision: candidate.successor.selectionRevision, choice };
}

function continuationFixture() {
  const f = fixture(), a = f.source('Original.ai'), b = f.source('Successor.ai'), other = f.source('Unrelated.ai');
  f.project.files.push(a, b, other);
  assert.ok(f.api.recordWorkingSourceContinuationCandidate(f.project.id, a.path, b.path));
  return { ...f, a, b, other };
}

test('a continuation candidate never changes selection, bytes, or generic PSD holds', async () => {
  const f = continuationFixture();
  f.project.workingSourceRelationshipHolds = [{ domain: 'psd-embedded', reason: 'unresolved' }];
  const before = plain(f.project);
  const pair = f.api.getWorkingSourceContinuationPresentation(f.project).candidates[0];
  assert.equal(pair.predecessor.name, 'Original.ai');
  assert.equal(JSON.stringify(pair).includes('/Users/'), false);
  assert.equal(f.project.workingSourceSelections, undefined);
  assert.equal((await f.api.selectProjectFilesForPackaging(f.project)).length, 3);
  assert.deepEqual(plain(f.project), before);
});

test('Replace commits one verified successor and retains the predecessor required by it', async () => {
  const f = continuationFixture();
  f.disk.set(f.b.path, Buffer.from(`%PDF-1.7\n${f.a.path}\n%%EOF\n`));
  const request = continuationRequest(f);
  const result = await f.api.resolveWorkingSourceContinuation(f.project.id, request);
  assert.equal(result.success, true);
  assert.equal(f.api.getWorkingSourceSelection(f.project, f.a).state, 'excluded');
  assert.equal(f.api.getWorkingSourceSelection(f.project, f.a).reason, 'continuation-replaced');
  assert.equal(f.api.getWorkingSourceSelection(f.project, f.b).state, 'selected');
  assert.equal(f.api.getWorkingSourceVerification(f.project, f.b).status, 'scanned');
  const membership = f.api.getWorkingSourceMembership(f.project);
  assert.equal(membership.facts.get(f.a.path.toLowerCase()).includedAsDependency, true);
  assert.equal(membership.facts.get(f.a.path.toLowerCase()).effectiveRole, 'asset');
  assert.equal(membership.blocked, false);
  assert.equal(f.api.getWorkingSourceContinuationPresentation(f.project).candidates.length, 0);
  assert.equal((await f.api.selectProjectFilesForPackaging(f.project)).length, 3);
  assert.equal((await f.api.resolveWorkingSourceContinuation(f.project.id, request)).error, 'continuation_stale');
});

test('Replace marks a copied pending predecessor stale and fences its late worker', async () => {
  const f = continuationFixture();
  const old = f.api.beginWorkingSourceScan(f.project.id, f.a.path, () => true);
  const pending = f.project.workingSourceVerification[old.key];
  const fingerprint = 'a'.repeat(64);
  pending.sourceFingerprint = fingerprint;
  pending.requiredReferences = [{ path: '/synthetic/linked.png' }];
  pending.requiredEmbeddedOutputs = [{ path: '/synthetic/output.png', sourceDigest: fingerprint, outputDigest: 'b'.repeat(64) }];
  pending.unresolved = [{ reason: 'unresolved-declared-reference' }];
  const evidence = plain(pending);
  f.project.workingFileDirtyHolds = { version: 1, records: { [old.key]: { version: 2, identities: [null] } } };
  const dirty = plain(f.project.workingFileDirtyHolds);
  const result = await f.api.resolveWorkingSourceContinuation(f.project.id, continuationRequest(f));
  assert.equal(result.success, true);
  const copied = f.api.getWorkingSourceVerification(f.project, f.a);
  assert.equal(copied.status, 'stale'); assert.equal(copied.reason, 'scan-interrupted');
  assert.notEqual(copied.attempt, old.attempt);
  for (const field of ['sourceFingerprint', 'requiredReferences', 'requiredEmbeddedOutputs', 'unresolved', 'pendingReviewFacts']) {
    assert.deepEqual(plain(copied[field]), evidence[field]);
  }
  assert.deepEqual(plain(f.project.workingFileDirtyHolds), dirty);
  const after = plain(f.project);
  assert.equal(f.api.publishWorkingSourceScan(old, { status: 'scanned' }), false);
  assert.equal(f.api.failWorkingSourceScan(old, { current: () => true }, 'scan-timeout'), false);
  assert.deepEqual(plain(f.project), after);
});

test('Keep both and Not related persist without engaging or altering ordinary selection', async () => {
  for (const choice of ['keep-both', 'not-related']) {
    const f = continuationFixture();
    const request = continuationRequest(f, choice);
    assert.equal((await f.api.resolveWorkingSourceContinuation(f.project.id, request)).success, true);
    assert.equal(f.project.workingSourceSelections, undefined);
    assert.equal(f.api.getWorkingSourceContinuationPresentation(f.project).candidates.length, 0);
    const reloaded = f.reload();
    assert.equal(f.api.getWorkingSourceContinuationPresentation(reloaded).candidates.length, 0);
    f.api.recordWorkingSourceContinuationCandidate(f.project.id, f.a.path, f.b.path);
    assert.equal(f.api.getWorkingSourceContinuationPresentation(reloaded).candidates.length, 0);
    assert.equal((await f.api.selectProjectFilesForPackaging(reloaded)).length, 3);
  }
});

test('foreign, stale, extra-proof and replayed pair requests cannot partially write intent', async () => {
  const f = continuationFixture();
  const request = continuationRequest(f);
  const before = plain(f.project);
  assert.equal((await f.api.resolveWorkingSourceContinuation('project-b', request)).success, false);
  assert.equal((await f.api.resolveWorkingSourceContinuation(f.project.id, { ...request, expectedRevision: 0 })).error, 'continuation_stale');
  assert.equal((await f.api.resolveWorkingSourceContinuation(f.project.id, { ...request, authority: 'app-operation' })).error, 'invalid_continuation_request');
  assert.equal((await f.api.resolveWorkingSourceContinuation(f.project.id, { ...request, evidenceIdentity: 'f'.repeat(64) })).error, 'continuation_stale');
  assert.deepEqual(plain(f.project), before);
});

test('Replace refuses missing dependencies and preserves both selections plus PSD holds', async () => {
  const f = continuationFixture();
  f.disk.set(f.b.path, Buffer.from('%PDF-1.7\n/Users/synthetic/Missing.png\n%%EOF\n'));
  f.project.workingSourceRelationshipHolds = [{ domain: 'psd-embedded', reason: 'ambiguous' }];
  const result = await f.api.resolveWorkingSourceContinuation(f.project.id, continuationRequest(f));
  assert.equal(result.error, 'continuation_verification_required');
  assert.equal(f.project.workingSourceSelections, undefined);
  assert.equal(f.project.workingSourceContinuations.pairs[Object.keys(f.project.workingSourceContinuations.pairs)[0]].decision, null);
  assert.deepEqual(plain(f.project.workingSourceRelationshipHolds), [{ domain: 'psd-embedded', reason: 'ambiguous' }]);
});

test('account/generation and selection races invalidate the prepared pair without a half replacement', async () => {
  for (const change of ['account', 'generation', 'selection', 'identity']) {
    const f = continuationFixture(), entered = deferred(), release = deferred();
    f.setDigestGate(async () => { entered.resolve(); await release.promise; });
    const result = f.api.resolveWorkingSourceContinuation(f.project.id, continuationRequest(f));
    await entered.promise;
    if (change === 'account') f.revoke();
    if (change === 'generation') f.changeGeneration();
    if (change === 'selection') await f.command(f.a, 'exclude');
    if (change === 'identity') f.physical.set(f.b.path, { dev: 1n, ino: 900n, birthtimeNs: 200n, nlink: 1n });
    release.resolve();
    assert.equal((await result).success, false);
    assert.notEqual(f.api.getWorkingSourceSelection(f.project, f.a).reason, 'continuation-replaced');
    assert.equal(f.api.getWorkingSourceSelection(f.project, f.b).revision, 0);
    assert.equal(Object.values(f.project.workingSourceContinuations.pairs)[0].decision, null);
  }
});

test('same-stat byte edit during the second pass refuses the pair and never excludes the original', async () => {
  const f = continuationFixture();
  let reads = 0;
  f.setDigestGate(async () => { if (++reads === 5) f.disk.set(f.a.path, Buffer.from('same-stat replacement')); });
  const result = await f.api.resolveWorkingSourceContinuation(f.project.id, continuationRequest(f));
  assert.equal(result.success, false);
  assert.equal(f.api.getWorkingSourceSelection(f.project, f.a).state, 'selected');
  assert.equal(f.api.getWorkingSourceSelection(f.project, f.b).revision, 0);
});

test('copy-close-open DOC transition is an unresolved candidate; coexistence, gaps and changed other docs are not', () => {
  const f = fixture(), a = f.source('Before.ai'), b = f.source('After.ai'), other = f.source('Other.ai');
  f.project.files.push(a, b, other);
  const query = (files, current) => ({ running: true, activeState: { documents: files.map(file => ({ documentPath: file.path, current: file === current, modified: false })) } });
  f.api.observeIllustratorWorkingSourceContinuation(f.project.id, 'activation-one', query([a, other], a));
  assert.equal(f.api.observeIllustratorWorkingSourceContinuation(f.project.id, 'activation-one', query([a, b, other], b)), null);
  assert.equal(f.api.getWorkingSourceContinuationPresentation(f.project).candidates.length, 0);
  f.api.observeIllustratorWorkingSourceContinuation(f.project.id, 'activation-two', query([a, other], a));
  assert.ok(f.api.observeIllustratorWorkingSourceContinuation(f.project.id, 'activation-two', query([b, other], b)));
  assert.equal(f.api.getWorkingSourceSelection(f.project, a).state, 'selected');
  assert.equal(f.api.getWorkingSourceContinuationPresentation(f.project).candidates.length, 1);
  const g = fixture(), x = g.source('One.ai'), y = g.source('Two.ai'); g.project.files.push(x, y);
  g.api.observeIllustratorWorkingSourceContinuation(g.project.id, 'same', query([x], x));
  g.api.observeIllustratorWorkingSourceContinuation(g.project.id, 'same', { failed: true });
  assert.equal(g.api.observeIllustratorWorkingSourceContinuation(g.project.id, 'same', query([y], y)), null);
  assert.equal(g.api.getWorkingSourceContinuationPresentation(g.project).candidates.length, 0);
});

test('hardlink, symlink and inode replacement cannot inherit a pair decision', async () => {
  for (const unsafe of [{ nlink: 2n }, { symlink: true }, { ino: 99n }, { dev: 2n }]) {
    const f = continuationFixture();
    const request = continuationRequest(f, 'keep-both');
    f.physical.set(f.b.path, { ...f.physical.get(f.b.path), ...unsafe });
    assert.equal((await f.api.resolveWorkingSourceContinuation(f.project.id, request)).success, false);
    assert.equal(Object.values(f.project.workingSourceContinuations.pairs)[0].decision, null);
  }
});

test('pair ambiguity follows the included predecessor even without the successor, and later saves preserve durable intent', async () => {
  const f = continuationFixture();
  assert.equal(f.api.getWorkingSourceContinuationPresentation(f.project, [f.other]).candidates.length, 0);
  assert.equal(f.api.getWorkingSourceContinuationPresentation(f.project, [f.a, f.other]).candidates.length, 1);
  assert.equal(f.api.getWorkingSourceContinuationPresentation(f.project, [f.a, f.b]).candidates.length, 1);
  await f.api.resolveWorkingSourceContinuation(f.project.id, continuationRequest(f, 'keep-both'));
  f.disk.set(f.b.path, Buffer.from('later save bytes'));
  assert.equal(f.api.getWorkingSourceContinuationPresentation(f.project).candidates.length, 0);
  await f.command(f.a, 'exclude');
  await f.command(f.a, 'restore');
  assert.equal(f.api.getWorkingSourceContinuationPresentation(f.project).candidates.length, 1);
});

test('a discovered excluded successor holds the old source and Replace verifies before restoring it atomically', async () => {
  const f = fixture(), a = f.source('Old.ai'), b = f.source('New.ai');
  f.project.files.push(a, b);
  await f.command(b, 'exclude');
  assert.ok(f.api.recordWorkingSourceContinuationCandidate(f.project.id, a.path, b.path));
  const candidate = f.api.getWorkingSourceContinuationPresentation(f.project, [a]).candidates[0];
  assert.equal(candidate.successor.admissionState, 'accepted');
  assert.equal(candidate.successor.selectionState, 'excluded');
  assert.equal(candidate.replaceRequires, null);
  let sawExcludedDuringVerification = false;
  f.setDigestGate(async () => {
    assert.equal(f.api.getWorkingSourceSelection(f.project, a).state, 'selected');
    assert.equal(f.api.getWorkingSourceSelection(f.project, b).state, 'excluded');
    sawExcludedDuringVerification = true;
  });
  const result = await f.api.resolveWorkingSourceContinuation(f.project.id, continuationRequest(f));
  assert.equal(result.success, true);
  assert.equal(sawExcludedDuringVerification, true);
  assert.equal(f.api.getWorkingSourceSelection(f.project, a).reason, 'continuation-replaced');
  assert.equal(f.api.getWorkingSourceSelection(f.project, b).state, 'selected');
  assert.equal(f.api.getWorkingSourceVerification(f.project, b).status, 'scanned');
});

test('a discovered pending successor remains visible without admission and durable Not related survives later acceptance', async () => {
  const f = fixture(), a = f.source('Old.ai'), b = f.source('Pending.ai');
  f.project.files.push(a); f.project.pendingFiles = [b];
  assert.ok(f.api.recordWorkingSourceContinuationCandidate(f.project.id, a.path, b.path));
  const candidate = f.api.getWorkingSourceContinuationPresentation(f.project, [a]).candidates[0];
  assert.equal(candidate.successor.admissionState, 'pending');
  assert.equal(candidate.replaceRequires, 'successor-admission');
  const before = plain(f.project);
  assert.equal((await f.api.resolveWorkingSourceContinuation(f.project.id, continuationRequest(f))).error, 'continuation_admission_required');
  assert.deepEqual(plain(f.project), before);
  assert.equal((await f.api.resolveWorkingSourceContinuation(f.project.id, continuationRequest(f, 'not-related'))).success, true);
  assert.equal(f.project.files.length, 1);
  assert.equal(f.project.pendingFiles.length, 1);
  assert.equal(f.project.workingSourceSelections, undefined);
  const reloaded = f.reload();
  reloaded.files.push(reloaded.pendingFiles.pop());
  assert.equal(f.api.getWorkingSourceContinuationPresentation(reloaded).candidates.length, 0);
});

test('untracked successors are never admitted, and failed excluded-successor verification preserves original intent', async () => {
  const f = fixture(), a = f.source('Old.ai'), b = f.source('Untracked.ai');
  f.project.files.push(a);
  assert.equal(f.api.recordWorkingSourceContinuationCandidate(f.project.id, a.path, b.path), null);
  assert.equal(f.project.workingSourceContinuations, undefined);
  f.project.files.push(b); await f.command(b, 'exclude');
  f.disk.set(b.path, Buffer.from('%PDF-1.7\n/Users/synthetic/Absent.png\n%%EOF\n'));
  f.api.recordWorkingSourceContinuationCandidate(f.project.id, a.path, b.path);
  assert.equal((await f.api.resolveWorkingSourceContinuation(f.project.id, continuationRequest(f))).error, 'continuation_verification_required');
  assert.equal(f.api.getWorkingSourceSelection(f.project, a).state, 'selected');
  assert.equal(f.api.getWorkingSourceSelection(f.project, b).state, 'excluded');
  assert.equal(f.api.getWorkingSourceContinuationPresentation(f.project, [a]).candidates.length, 1);
});

test('successor demotion after verification cannot exclude the original without an accepted successor', async () => {
  const f = continuationFixture();
  f.setAfterScan(async () => {
    f.project.files = f.project.files.filter(file => file !== f.b);
    f.project.pendingFiles = [f.b];
  });
  const result = await f.api.resolveWorkingSourceContinuation(f.project.id, continuationRequest(f));
  assert.equal(result.success, false);
  assert.equal(f.api.getWorkingSourceSelection(f.project, f.a).state, 'selected');
  assert.equal(Object.values(f.project.workingSourceContinuations.pairs)[0].decision, null);
});

test('proven rename transfers intent, invalidates verification and leaves a new old-path occupant independent', async () => {
  const f = fixture(), original = f.source('Before.ai'); f.project.files.push(original);
  await f.command(original, 'exclude');
  await f.api.refreshWorkingSourceLocators(f.project.id);
  const oldKey = f.api.getAssetBaselineSourceRecoveryRouteKey(f.project, original);
  const destination = '/Users/synthetic/Renamed.ai';
  f.disk.set(destination, f.disk.get(original.path)); f.disk.delete(original.path);
  f.physical.set(destination, f.physical.get(original.path)); f.physical.delete(original.path);
  await f.api.refreshWorkingSourceLocators(f.project.id, [destination]);
  const moved = f.project.files[0];
  assert.equal(moved.path, destination);
  assert.equal(f.api.getWorkingSourceSelection(f.project, moved).reason, 'user-excluded');
  assert.equal(f.project.workingSourceSelections[oldKey], undefined);
  assert.equal(f.api.getWorkingSourceVerification(f.project, moved).status, 'stale');
  const unrelated = f.source('Before.ai', 'new-file-at-old-locator'); f.project.files.push(unrelated);
  assert.equal(f.api.getWorkingSourceSelection(f.project, unrelated).state, 'selected');
  assert.equal(f.api.getWorkingSourceSelection(f.project, unrelated).revision, 0);
  assert.equal(f.project.workingSourceLocators.aliases[0].kind, 'rename');
});

test('a copy, cross-volume move, hardlink or independently admitted destination cannot become an automatic rename', async () => {
  for (const variant of ['copy', 'volume', 'hardlink', 'admitted', 'old-present']) {
    const f = fixture(), old = f.source('Old.ai'); f.project.files.push(old);
    await f.api.refreshWorkingSourceLocators(f.project.id);
    const destination = '/Users/synthetic/New.ai';
    f.disk.set(destination, Buffer.from(f.disk.get(old.path)));
    const identity = { ...f.physical.get(old.path) };
    if (variant === 'copy') identity.ino = 999n;
    if (variant === 'volume') identity.dev = 99n;
    if (variant === 'hardlink') identity.nlink = 2n;
    f.physical.set(destination, identity);
    if (variant !== 'old-present') { f.disk.delete(old.path); f.physical.delete(old.path); }
    if (variant === 'admitted') f.project.files.push({ ...old, path: destination, fileId: 'independent' });
    await f.api.refreshWorkingSourceLocators(f.project.id, [destination]);
    assert.equal(f.project.files[0].path, old.path);
    assert.equal(f.project.workingSourceLocators.aliases.length, 0);
  }
});

test('supported kernel identity keeps pair intent through safe-save but re-verifies the new bytes', async () => {
  const f = continuationFixture();
  f.setDocumentIdentityReader(script => ({ documentId: script.includes(JSON.stringify(f.a.path)) ? '101' : script.includes(JSON.stringify(f.b.path)) ? '102' : '103',
    volumeUuid: '12345678-1234-1234-1234-123456789abc' }));
  await f.api.refreshWorkingSourceLocators(f.project.id);
  await f.api.resolveWorkingSourceContinuation(f.project.id, continuationRequest(f, 'keep-both'));
  f.physical.set(f.b.path, { ...f.physical.get(f.b.path), ino: 999n, birthtimeNs: 200n });
  f.disk.set(f.b.path, Buffer.from('%PDF-1.7\nlater safe save\n%%EOF\n'));
  await f.api.refreshWorkingSourceLocators(f.project.id);
  assert.equal(f.api.getWorkingSourceContinuationPresentation(f.project).candidates.length, 0);
  assert.equal(f.api.getWorkingSourceVerification(f.project, f.b).status, 'scanned');
  assert.equal(f.api.getWorkingSourceVerification(f.project, f.b).sourceFingerprint, crypto.createHash('sha256').update(f.disk.get(f.b.path)).digest('hex'));
  assert.equal(f.project.workingSourceSelections, undefined);
});

test('unavailable document identity never upgrades an inode replacement to safe-save proof', async () => {
  const f = fixture(), old = f.source('Saved.ai'); f.project.files.push(old);
  await f.api.refreshWorkingSourceLocators(f.project.id);
  f.physical.set(old.path, { ...f.physical.get(old.path), ino: 999n });
  await f.api.refreshWorkingSourceLocators(f.project.id);
  assert.equal(f.project.workingSourceVerification, undefined);
  assert.equal(f.project.workingSourceLocators.records[f.api.getAssetBaselineSourceRecoveryRouteKey(f.project, old)].documentIdentity, null);
});

test('rename preserves literal required paths until producer bytes prove an updated link', async () => {
  const f = fixture(), old = f.source('Old.ai'), root = f.source('Root.ai'); f.project.files.push(old, root);
  f.disk.set(root.path, Buffer.from(`%PDF-1.7\n${old.path}\n%%EOF\n`));
  await f.command(root, 'exclude'); await f.command(root, 'restore');
  await f.api.refreshWorkingSourceLocators(f.project.id);
  const destination = '/Users/synthetic/Moved.ai';
  f.disk.set(destination, f.disk.get(old.path)); f.disk.delete(old.path);
  f.physical.set(destination, f.physical.get(old.path)); f.physical.delete(old.path);
  await f.api.refreshWorkingSourceLocators(f.project.id, [destination]);
  assert.equal(f.api.getWorkingSourceVerification(f.project, root).requiredReferences[0].path, old.path);
  assert.equal(f.api.getWorkingSourceMembership(f.project).counts.missingRequiredReferences, 1);
  assert.equal(f.api.getWorkingSourceMembership(f.project).blocked, true);
});

test('an unrelated physical replacement at the excluded predecessor path cannot inherit automatic Replace authority', async () => {
  const f = continuationFixture();
  assert.equal((await f.api.resolveWorkingSourceContinuation(f.project.id, continuationRequest(f))).success, true);
  f.physical.set(f.a.path, { ...f.physical.get(f.a.path), ino: 999n });
  assert.equal(f.api.getWorkingSourceSelection(f.project, f.a).state, 'invalid');
  assert.equal(f.api.getWorkingSourceMembership(f.project).blocked, true);
});

for (const mode of ['new-inode', 'missing', 'removed-row', 'pending-row', 'duplicate-row']) {
  test(`v13 resolved Replace binds the accepted successor after ordinary reverification: ${mode}`, async () => {
    const f = continuationFixture();
    assert.equal((await f.api.resolveWorkingSourceContinuation(f.project.id, continuationRequest(f))).success, true);
    const before = plain(f.api.getWorkingSourceSelection(f.project, f.a));
    const bytes = Buffer.from(f.disk.get(f.a.path));
    if (mode === 'new-inode') f.physical.set(f.b.path, { ...f.physical.get(f.b.path), ino: 999n });
    if (mode === 'missing') f.disk.delete(f.b.path);
    if (['removed-row', 'pending-row'].includes(mode)) {
      f.project.files = f.project.files.filter(file => file !== f.b);
      if (mode === 'pending-row') f.project.pendingFiles = [f.b];
    }
    if (mode === 'duplicate-row') f.project.files.push({ ...f.b, fileId: 'duplicate' });
    if (mode === 'new-inode') {
      const scan = f.api.beginWorkingSourceScan(f.project.id, f.b.path, () => true);
      assert.ok(scan);
      assert.equal(f.api.publishWorkingSourceScan(scan, { status: 'scanned', sourceIdentity: f.api.getWorkingSourceDiskIdentity(f.b),
        sourceFingerprint: crypto.createHash('sha256').update(f.disk.get(f.b.path)).digest('hex'), requiredReferences: [], unresolved: [] }), true);
    }
    assert.deepEqual(plain(f.api.getWorkingSourceSelection(f.project, f.a)), {
      state: 'invalid', reason: 'continuation-identity-changed', revision: before.revision,
    });
    assert.equal(f.api.getWorkingSourceMembership(f.project).blocked, true);
    assert.deepEqual(f.disk.get(f.a.path), bytes);
    const recovery = f.api.getWorkingSourceMembership(f.project).facts.get(f.a.path.toLowerCase()).selectionRecovery;
    assert.deepEqual(plain(recovery), { version: 1, reason: 'continuation-identity-changed', expectedRevision: before.revision, actions: ['exclude', 'restore'] });
    assert.equal((await f.command(f.a, 'exclude', before.revision - 1)).success, false);
    assert.equal((await f.command(f.a, 'exclude', before.revision)).success, true);
    assert.equal(f.api.getWorkingSourceSelection(f.project, f.a).reason, 'user-excluded');
  });
}

test('v13 malformed Replace records never project or authorize invalid-state recovery', async () => {
  const mutations = [
    (p, key, pair) => { pair.decision.authority = 'untrusted'; },
    (p, key, pair) => { pair.successorIdentity = null; },
    (p, key, pair) => { pair.evidenceIdentity = 'malformed'; },
    (p, key, pair) => { pair.revision = 0; },
    p => { p.workingSourceContinuations.version = 2; },
    (p, key) => { p.workingSourceSelections[key].unexpected = true; },
    (p, key, pair) => { pair.decision.successorSelectionRevision = -1; },
  ];
  for (const mutate of mutations) {
    const f = continuationFixture();
    const command = continuationRequest(f);
    assert.equal((await f.api.resolveWorkingSourceContinuation(f.project.id, command)).success, true);
    const key = f.api.getAssetBaselineSourceRecoveryRouteKey(f.project, f.a);
    mutate(f.project, key, f.project.workingSourceContinuations.pairs[command.pairIdentity]);
    f.physical.set(f.b.path, { ...f.physical.get(f.b.path), ino: 999n });
    const before = plain(f.project);
    assert.equal(f.api.getWorkingSourceSelection(f.project, f.a).reason, null);
    assert.equal(f.api.getWorkingSourceMembership(f.project).facts.get(f.a.path.toLowerCase()).selectionRecovery, undefined);
    assert.equal((await f.command(f.a, 'exclude', 1)).success, false);
    assert.deepEqual(plain(f.project), before);
  }
});

test('v13 ambiguous canonical predecessor never projects or accepts recovery through a scoped identity', async () => {
  const f = continuationFixture();
  assert.equal((await f.api.resolveWorkingSourceContinuation(f.project.id, continuationRequest(f))).success, true);
  f.project.files.push({ ...f.a, fileId: 'duplicate-predecessor' });
  assert.equal(f.api.getWorkingSourceSelection(f.project, f.a).state, 'invalid');
  assert.equal(f.api.getWorkingSourceMembership(f.project).facts.get(f.a.path.toLowerCase()).selectionRecovery, undefined);
  const before = plain(f.project);
  assert.equal((await f.command(f.a, 'exclude', 1)).error, 'working_source_not_found');
  assert.deepEqual(plain(f.project), before);
});

test('the identity adapter retains actual Adobe source formats and excludes Figma/virtual sources', async () => {
  for (const extension of ['ai', 'ait', 'psd', 'psb', 'indd', 'idml', 'xd', 'pdf', 'prproj', 'aep', 'aet']) {
    const f = fixture(), original = f.source(`Before.${extension}`); f.project.files.push(original);
    await f.command(original, 'exclude');
    await f.api.refreshWorkingSourceLocators(f.project.id);
    const destination = `/Users/synthetic/After.${extension}`;
    f.disk.set(destination, f.disk.get(original.path)); f.disk.delete(original.path);
    f.physical.set(destination, f.physical.get(original.path)); f.physical.delete(original.path);
    await f.api.refreshWorkingSourceLocators(f.project.id, [destination]);
    assert.equal(f.project.files[0].path, destination, extension);
    assert.equal(f.api.getWorkingSourceSelection(f.project, f.project.files[0]).reason, 'user-excluded', extension);
  }
  const f = fixture(), figma = f.source('Design.fig'), virtual = { ...f.source('Virtual.ai'), virtual: true };
  f.project.files.push(figma, virtual);
  await f.api.refreshWorkingSourceLocators(f.project.id);
  assert.equal(f.project.workingSourceLocators, undefined);
});


test('S2 identity upgrades retain the original resolved pair and distinct replacement files create a fresh pair', async () => {
  const f = continuationFixture();
  const originalIdentity = Object.keys(f.project.workingSourceContinuations.pairs)[0];
  assert.equal((await f.api.resolveWorkingSourceContinuation(f.project.id, continuationRequest(f, 'keep-both'))).success, true);
  const decision = plain(f.project.workingSourceContinuations.pairs[originalIdentity].decision);
  f.setDocumentIdentityReader(script => ({ documentId: script.includes(JSON.stringify(f.a.path)) ? '101' : script.includes(JSON.stringify(f.b.path)) ? '102' : '103',
    volumeUuid: '12345678-1234-1234-1234-123456789abc' }));
  await f.api.refreshWorkingSourceLocators(f.project.id);
  const upgraded = plain(f.project.workingSourceContinuations.pairs[originalIdentity]);
  assert.equal(f.api.recordWorkingSourceContinuationCandidate(f.project.id, f.a.path, f.b.path), originalIdentity);
  assert.equal(Object.keys(f.project.workingSourceContinuations.pairs).length, 1);
  assert.deepEqual(plain(f.project.workingSourceContinuations.pairs[originalIdentity]), upgraded);
  assert.deepEqual(upgraded.decision, decision);
  assert.equal(f.api.getWorkingSourceContinuationPresentation(f.project).candidates.length, 0);
  f.physical.set(f.b.path, { ...f.physical.get(f.b.path), ino: 999n, birthtimeNs: 200n });
  const freshIdentity = f.api.recordWorkingSourceContinuationCandidate(f.project.id, f.a.path, f.b.path);
  assert.notEqual(freshIdentity, originalIdentity);
  assert.equal(Object.keys(f.project.workingSourceContinuations.pairs).length, 2);
  assert.equal(f.api.getWorkingSourceContinuationPresentation(f.project).candidates.length, 1);
});

// A scan whose Illustrator scope moved drains without publishing. These cases
// exercise only the retirement of its own pending receipt, including store
// setters that throw before or after committing (Conf-like fresh reads).
function confLikeStore() {
  let data = {};
  const store = { sets: 0, beforeCommit: null, afterCommit: null, failReads: false,
    get(key, fallback) {
      if (store.failReads) throw new Error('synthetic-store-read-failed');
      return structuredClone(Object.hasOwn(data, key) ? data[key] : fallback);
    },
    set(key, value) {
      store.sets++;
      const before = store.beforeCommit; store.beforeCommit = null; if (before) before();
      data = { ...data, [key]: structuredClone(value) };
      const after = store.afterCommit; store.afterCommit = null; if (after) after();
    },
    raw() { return data; } };
  return store;
}

function retirementFixture(store = confLikeStore()) {
  const f = fixture(), source = f.source('Interrupted.ai');
  f.project.files.push(source);
  f.project.workingSourceSelections = {};
  const key = f.api.getAssetBaselineSourceRecoveryRouteKey(f.project, source);
  f.project.workingSourceVerification = { [key]: { status: 'scanned', selectionRevision: 0, attempt: 'prior-attempt',
    provider: 'ordinary-ai', coverage: 'ordinary-route', version: 1, reason: 'ordinary-scan-finished', inventoryStatus: 'unverified',
    requiredReferences: [{ path: '/Users/synthetic/Linked.png' }], unresolved: [{ reason: 'declared-reference-unresolved' }],
    sourceFingerprint: 'b'.repeat(64), sourceIdentity: { dev: 1, ino: 1, size: 15, mtimeMs: 0, ctimeMs: 0 },
    requiredEmbeddedOutputs: [{ path: '/Users/synthetic/Embedded.png', sourceDigest: 'b'.repeat(64), outputDigest: 'c'.repeat(64) }] } };
  f.useRealStore(store);
  const prior = structuredClone(store.get('projects')[0].workingSourceVerification[key]);
  const scan = f.api.beginWorkingSourceScan(f.project.id, source.path, () => true);
  assert.ok(scan);
  const record = () => store.get('projects')[0].workingSourceVerification[key];
  assert.equal(record().status, 'pending');
  return { ...f, store, scan, key, prior, record, pending: structuredClone(record()) };
}

function assertRetired(r) {
  const record = r.record();
  assert.equal(record.status, 'failed');
  assert.equal(record.reason, 'scan-interrupted');
  assert.equal(record.attempt, r.scan.attempt);
  assert.deepEqual(record.requiredReferences, r.prior.requiredReferences);
  assert.deepEqual(record.requiredEmbeddedOutputs, r.prior.requiredEmbeddedOutputs);
  assert.deepEqual(record.unresolved, [...r.prior.unresolved, { reason: 'scan-interrupted' }]);
  assert.equal(record.sourceFingerprint, r.prior.sourceFingerprint);
  assert.deepEqual(record.sourceIdentity, r.prior.sourceIdentity);
  assert.equal(Object.hasOwn(record, 'pendingReviewFacts'), false);
  assert.ok(r.api.getWorkingSourceVerification(r.store.get('projects')[0], r.project.files[0]), 'retired receipt stays valid');
}

test('scope retirement helper exists', () => {
  assert.equal(typeof fixture().api.retireInterruptedWorkingSourceScan, 'function');
});

test('scope retirement retires exactly its own pending receipt and keeps evidence', () => {
  const r = retirementFixture();
  assert.equal(r.api.retireInterruptedWorkingSourceScan(r.scan, () => true), 'retired');
  assertRetired(r);
  assert.ok(r.invalidated.includes(r.project.id));
  assert.ok(r.events.some(event => event.event === 'project:updated'));
});

test('scope retirement refuses when the owner is no longer current, without writing', () => {
  const r = retirementFixture(), sets = r.store.sets;
  assert.equal(r.api.retireInterruptedWorkingSourceScan(r.scan, () => false), 'not-retired');
  assert.deepEqual(r.record(), r.pending);
  assert.equal(r.store.sets, sets);
});

test('scope retirement refuses a newer completed owner and an invalid selection', () => {
  const r = retirementFixture();
  const newer = { ...r.prior, attempt: 'completed-c' };
  r.store.raw().projects[0].workingSourceVerification[r.key] = newer;
  assert.equal(r.api.retireInterruptedWorkingSourceScan(r.scan, () => true), 'not-retired');
  assert.deepEqual(r.record(), newer);
  const s = retirementFixture();
  s.store.raw().projects[0].workingSourceSelections = [];
  assert.equal(s.api.retireInterruptedWorkingSourceScan(s.scan, () => true), 'not-retired');
  assert.deepEqual(s.record(), s.pending);
});

test('scope retirement: a throwing owner check returns without writing or escaping', () => {
  const r = retirementFixture(), sets = r.store.sets;
  assert.equal(r.api.retireInterruptedWorkingSourceScan(r.scan, () => { throw new Error('synthetic-owner-check'); }), 'not-retired');
  assert.deepEqual(r.record(), r.pending);
  assert.equal(r.store.sets, sets);
  const s = retirementFixture();
  let calls = 0;
  s.store.beforeCommit = () => { throw new Error('synthetic-before-commit'); };
  // Calls: initial check, failed write, then the readback check throws.
  assert.equal(s.api.retireInterruptedWorkingSourceScan(s.scan, () => { if (++calls === 3) throw new Error('synthetic-owner-check'); return true; }), 'not-retired');
  assert.deepEqual(s.record(), s.pending);
});

test('scope retirement leaves a dormant project untouched, as other stale scans do', () => {
  const r = retirementFixture(), sets = r.store.sets, events = r.events.length;
  delete r.store.raw().projects[0].workingSourceSelections;
  assert.equal(r.api.retireInterruptedWorkingSourceScan(r.scan, () => true), 'not-retired');
  assert.deepEqual(r.record(), r.pending);
  assert.equal(r.store.sets, sets);
  assert.equal(r.events.slice(events).some(event => event.event === 'project:updated'), false);
});

test('scope retirement keeps a full unresolved list valid', () => {
  const r = retirementFixture();
  const full = Array.from({ length: 128 }, () => ({ reason: 'declared-reference-unresolved' }));
  r.store.raw().projects[0].workingSourceVerification[r.key].unresolved = full;
  assert.equal(r.api.retireInterruptedWorkingSourceScan(r.scan, () => true), 'retired');
  assert.deepEqual(r.record().unresolved, full);
  assert.ok(r.api.getWorkingSourceVerification(r.store.get('projects')[0], r.project.files[0]));
});

test('scope retirement: a write that throws before committing is reread, rechecked and retried once', () => {
  const r = retirementFixture(), sets = r.store.sets;
  r.store.beforeCommit = () => { throw new Error('synthetic-before-commit'); };
  assert.equal(r.api.retireInterruptedWorkingSourceScan(r.scan, () => true), 'retired');
  assertRetired(r);
  assert.equal(r.store.sets, sets + 2);
});

test('scope retirement: a write that commits then throws is confirmed by readback with no second write', () => {
  const r = retirementFixture(), sets = r.store.sets;
  r.store.afterCommit = () => { throw new Error('synthetic-after-commit'); };
  assert.equal(r.api.retireInterruptedWorkingSourceScan(r.scan, () => true), 'retired');
  assertRetired(r);
  assert.equal(r.store.sets, sets + 1);
});

test('scope retirement: a newer owner seen at readback is never overwritten', () => {
  const r = retirementFixture(), sets = r.store.sets;
  const newer = { ...r.pending, attempt: 'newer-c' };
  r.store.beforeCommit = () => { r.store.raw().projects[0].workingSourceVerification[r.key] = newer; throw new Error('synthetic-before-commit'); };
  assert.equal(r.api.retireInterruptedWorkingSourceScan(r.scan, () => true), 'not-retired');
  assert.deepEqual(r.record(), newer);
  assert.equal(r.store.sets, sets + 1);
});

test('scope retirement: a replacement between readback and retry is refused inside the retry', () => {
  const r = retirementFixture();
  const newer = { ...r.pending, attempt: 'newer-c' };
  let calls = 0;
  r.store.beforeCommit = () => { throw new Error('synthetic-before-commit'); };
  // Calls: initial check, failed write, readback check (replace here), retry.
  const result = r.api.retireInterruptedWorkingSourceScan(r.scan, () => {
    if (++calls === 3) r.store.raw().projects[0].workingSourceVerification[r.key] = newer;
    return true;
  });
  assert.equal(calls, 4);
  assert.equal(result, 'not-retired');
  assert.deepEqual(r.record(), newer);
});

test('scope retirement: an unreadable store after a failed write reports uncertainty without another write', () => {
  const r = retirementFixture(), sets = r.store.sets;
  r.store.afterCommit = () => { r.store.failReads = true; throw new Error('synthetic-after-commit'); };
  assert.equal(r.api.retireInterruptedWorkingSourceScan(r.scan, () => true), 'uncertain');
  assert.equal(r.store.sets, sets + 1);
  r.store.failReads = false;
  assertRetired(r);
});

for (const mode of ['before-write', 'after-write']) {
  test(`scope retirement with real Electron Store: ${mode}`, { skip: !electronStoreAvailable }, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-retire-store-'));
    try {
      const store = createSyntheticElectronStore(tmp);
      const r = retirementFixture(store);
      const originalWrite = store._write;
      let writes = 0;
      store._write = function(value) {
        writes++;
        if (writes === 1 && mode === 'before-write') throw new Error('synthetic-before-write');
        originalWrite.call(this, value);
        if (writes === 1) throw new Error('synthetic-after-write');
      };
      assert.equal(r.api.retireInterruptedWorkingSourceScan(r.scan, () => true), 'retired');
      store._write = originalWrite;
      assertRetired(r);
      assert.equal(writes, mode === 'before-write' ? 2 : 1);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
}

test('refresh digest read failure is not reported as a file change; a real identity change is', async () => {
  const f = fixture(), a = f.source('Original.ai');
  f.project.files.push(a);
  await f.command(a, 'exclude'); await f.command(a, 'restore');
  const reason = () => f.api.getWorkingFileVerificationReason(f.project, a, f.api.getWorkingSourceVerification(f.project, a));
  assert.equal(f.api.getWorkingSourceVerification(f.project, a).status, 'scanned');
  // Same stat identity; the digest read fails (synthetic EIO).
  f.setDigestGate(async () => { throw Object.assign(new Error('synthetic read failure'), { code: 'EIO' }); });
  await f.api.refreshWorkingSourceVerification(f.project.id);
  const stale = f.api.getWorkingSourceVerification(f.project, a);
  assert.equal(stale.status, 'stale'); assert.equal(stale.reason, 'source-bytes-changed');
  assert.ok(f.api.getWorkingSourceDiskIdentity(a), 'file still present');
  assert.notEqual(reason(), 'working-file-source-changed');
  assert.equal(reason(), 'saved-file-verification-required');
  // A recorded identity that no longer matches is independent proof of change.
  f.setDigestGate(null);
  f.disk.set(a.path, Buffer.from('%PDF-1.7\nchanged synthetic bytes\n%%EOF\n'));
  assert.equal(reason(), 'working-file-source-changed');
});

// Assets Crate admitted only as dependencies of a working file the owner
// explicitly excluded leave automatic membership with that file.
function dependencyAsset(f, name, extra = {}) {
  return Object.assign(f.asset(name), { source: 'scan-on-open' }, extra);
}
async function scanWorkingFile(f, root, references) {
  f.disk.set(root.path, Buffer.from(`%PDF-1.7\n${references.map(file => file.path).join('\n')}\n%%EOF\n`));
  assert.equal((await f.command(root, 'exclude')).success, true);
  assert.equal((await f.command(root, 'restore')).verificationStatus, 'scanned');
}
function membershipOf(f) { return f.api.getWorkingSourceMembership(f.snapshot()); }
function factOf(f, file) { return membershipOf(f).facts.get(file.path.toLowerCase()); }
async function selectedNames(f) { return (await f.api.selectProjectFilesForPackaging(f.snapshot())).map(file => file.name).sort(); }

test('excluded working file withholds receipt-only and row-evidence dependency assets', async () => {
  const f = fixture(), root = f.source('Art.ai'), kept = f.source('Poster.ai');
  const receiptOnly = dependencyAsset(f, 'ReceiptOnly.png');
  const evidenceOnly = dependencyAsset(f, 'EvidenceOnly.png', { source: 'ai-linked', captureEvidence: { relationshipSourcePath: root.path } });
  f.project.files.push(root, kept, receiptOnly, evidenceOnly);
  await scanWorkingFile(f, root, [receiptOnly]);
  for (const file of [receiptOnly, evidenceOnly]) {
    assert.equal(factOf(f, file).included, true);
    assert.equal(factOf(f, file).excludedSourceOnly, false);
  }
  assert.equal((await f.command(root, 'exclude')).success, true);
  for (const file of [receiptOnly, evidenceOnly]) {
    const fact = factOf(f, file);
    assert.equal(fact.included, false, file.name);
    assert.equal(fact.excludedSourceOnly, true, file.name);
    assert.equal(fact.includedAsDependency, false);
    assert.deepEqual(plain(fact.requiredBy), []);
  }
  const membership = membershipOf(f);
  assert.equal(membership.counts.excludedAssets, 2);
  assert.equal(membership.counts.includedAssets, 0);
  assert.equal(membership.blocked, false);
  assert.deepEqual(await selectedNames(f), ['Poster.ai']);
  assert.deepEqual(f.snapshot().excludedAssetKeys, [], 'withholding writes no asset exclusion intent');
});

test('a shared dependency stays required by the retained file and follows both files selection', async () => {
  const f = fixture(), root = f.source('Art.ai'), kept = f.source('Poster.ai');
  const shared = dependencyAsset(f, 'Shared.png');
  f.project.files.push(root, kept, shared);
  await scanWorkingFile(f, root, [shared]);
  await scanWorkingFile(f, kept, [shared]);
  await f.command(root, 'exclude');
  let fact = factOf(f, shared);
  assert.equal(fact.included, true); assert.equal(fact.includedAsDependency, true);
  assert.equal(fact.excludedSourceOnly, false);
  assert.deepEqual(plain(fact.requiredBy), ['Poster.ai']);
  await f.command(kept, 'exclude');
  fact = factOf(f, shared);
  assert.equal(fact.included, false); assert.equal(fact.excludedSourceOnly, true);
  assert.deepEqual(await selectedNames(f), []);
  assert.equal((await f.command(kept, 'restore')).verificationStatus, 'scanned');
  fact = factOf(f, shared);
  assert.equal(fact.included, true); assert.equal(fact.includedAsDependency, true);
  assert.deepEqual(plain(fact.requiredBy), ['Poster.ai']);
  assert.deepEqual(await selectedNames(f), ['Poster.ai', 'Shared.png']);
});

test('deliberately included rows stay with an excluded working file', async () => {
  const f = fixture(), root = f.source('Art.ai');
  const manual = { ...f.asset('Manual.png'), source: 'manual-browse' };
  const granted = dependencyAsset(f, 'Granted.png', { explicitUserAuthority: { granted: true, source: 'manual-browse', method: 'projects:add-files' } });
  const marked = dependencyAsset(f, 'Marked.png', { keptAfterSourceExclusion: true });
  const withheld = dependencyAsset(f, 'Withheld.png');
  f.project.files.push(root, manual, granted, marked, withheld);
  await scanWorkingFile(f, root, [manual, granted, marked, withheld]);
  await f.command(root, 'exclude');
  assert.equal(factOf(f, manual).excludedSourceOnly, false, 'not dependency-captured');
  for (const file of [granted, marked]) {
    assert.equal(factOf(f, file).excludedSourceOnly, true, file.name);
    assert.equal(factOf(f, file).included, true, file.name);
  }
  assert.equal(factOf(f, manual).included, true);
  assert.equal(factOf(f, withheld).included, false);
  assert.deepEqual(await selectedNames(f), ['Granted.png', 'Manual.png', 'Marked.png']);
});

test('Restore and re-Exclude round trip through reload is stable and keeps the owner marker', async () => {
  const f = fixture(), root = f.source('Art.ai');
  const withheld = dependencyAsset(f, 'Withheld.png'), marked = dependencyAsset(f, 'Marked.png', { keptAfterSourceExclusion: true });
  f.project.files.push(root, withheld, marked);
  await scanWorkingFile(f, root, [withheld, marked]);
  await f.command(root, 'exclude');
  const excludedState = () => [factOf(f, withheld).included, factOf(f, marked).included, factOf(f, withheld).excludedSourceOnly];
  assert.deepEqual(excludedState(), [false, true, true]);
  f.reload();
  assert.deepEqual(excludedState(), [false, true, true]);
  assert.equal((await f.command(root, 'restore')).verificationStatus, 'scanned');
  assert.equal(factOf(f, withheld).included, true); assert.equal(factOf(f, withheld).includedAsDependency, true);
  assert.equal(factOf(f, withheld).excludedSourceOnly, false);
  f.reload();
  assert.equal(factOf(f, withheld).included, true);
  await f.command(root, 'exclude');
  f.reload();
  assert.deepEqual(excludedState(), [false, true, true]);
  assert.equal(f.snapshot().files.find(file => file.name === 'Marked.png').keptAfterSourceExclusion, true);
  assert.equal(Object.hasOwn(f.snapshot().files.find(file => file.name === 'Withheld.png'), 'keptAfterSourceExclusion'), false);
});

test('Replace history and invalid selections keep their dependency assets as today', async () => {
  const f = continuationFixture();
  const replacedAsset = dependencyAsset(f, 'Replaced.png', { captureEvidence: { relationshipSourcePath: f.a.path } });
  f.project.files.push(replacedAsset);
  assert.equal((await f.api.resolveWorkingSourceContinuation(f.project.id, continuationRequest(f))).success, true);
  assert.equal(f.api.getWorkingSourceSelection(f.project, f.a).reason, 'continuation-replaced');
  assert.equal(factOf(f, replacedAsset).included, true);
  assert.equal(factOf(f, replacedAsset).excludedSourceOnly, false);

  const g = fixture(), root = g.source('Art.ai'), other = g.source('Other.ai');
  const invalidAsset = dependencyAsset(g, 'Invalid.png', { captureEvidence: { relationshipSourcePath: root.path } });
  g.project.files.push(root, other, invalidAsset);
  await g.command(other, 'exclude');
  g.project.workingSourceSelections[g.api.getAssetBaselineSourceRecoveryRouteKey(g.project, root)] = { state: 'excluded', reason: 'unknown', revision: 1 };
  assert.equal(g.api.getWorkingSourceSelection(g.project, root).state, 'invalid');
  assert.equal(factOf(g, invalidAsset).included, true);
  assert.equal(factOf(g, invalidAsset).excludedSourceOnly, false);
});

test('independently observed rows and rows naming another producer stay', async () => {
  const f = fixture(), root = f.source('Art.ai'), other = f.source('Other.ai');
  const observed = { ...f.asset('Observed.png'), source: 'chokidar-add' };
  const elsewhere = dependencyAsset(f, 'Elsewhere.png', { captureEvidence: { relationshipSourcePath: '/Users/synthetic/Unknown.ai' } });
  const ownedByOther = dependencyAsset(f, 'OtherProducer.png', { source: 'psd-linked', assetBaselineSourcePath: other.path });
  f.project.files.push(root, other, observed, elsewhere, ownedByOther);
  await scanWorkingFile(f, root, [observed, elsewhere, ownedByOther]);
  await f.command(other, 'exclude');
  await f.command(root, 'exclude');
  assert.equal(factOf(f, observed).excludedSourceOnly, false);
  assert.equal(factOf(f, elsewhere).excludedSourceOnly, false);
  for (const file of [observed, elsewhere]) assert.equal(factOf(f, file).included, true, file.name);
  // Other.ai is also an explicitly excluded root; its own evidence ties the row to it.
  assert.equal(factOf(f, ownedByOther).excludedSourceOnly, true);
  await f.command(other, 'restore');
  assert.equal(factOf(f, ownedByOther).included, true, 'evidence names a selected producer');
});

test('nested dependency documents follow the excluded root; a selected nested working file keeps itself', async () => {
  const f = fixture(), root = f.source('Art.ai');
  const child = dependencyAsset(f, 'Child.ai', { source: 'ai-linked', captureEvidence: { relationshipSourcePath: root.path } });
  const nested = dependencyAsset(f, 'Nested.png', { source: 'ai-linked', captureEvidence: { relationshipSourcePath: child.path } });
  const subSource = { ...f.source('Sub.ai'), captureEvidence: { relationshipSourcePath: root.path } };
  const subAsset = dependencyAsset(f, 'SubAsset.png', { source: 'ai-linked', captureEvidence: { relationshipSourcePath: subSource.path } });
  f.project.files.push(root, child, nested, subSource, subAsset);
  await f.command(root, 'exclude');
  for (const file of [child, nested]) {
    assert.equal(factOf(f, file).included, false, file.name);
    assert.equal(factOf(f, file).excludedSourceOnly, true, file.name);
  }
  assert.equal(factOf(f, subSource).sourceSelection, 'selected');
  assert.equal(factOf(f, subSource).included, true);
  assert.equal(factOf(f, subAsset).included, true);
  assert.equal(factOf(f, subAsset).includedAsDependency, true);
  assert.deepEqual(await selectedNames(f), ['Sub.ai', 'SubAsset.png']);
});

test('logical embedded children follow an unretained parent and stay with a retained one', async () => {
  const f = fixture(), psd = f.source('Design.psd'), kept = f.source('Poster.ai');
  // The VM dedup model keys by path; production keys logical rows by identity
  // while their path is the parent PSD. Membership uses parentPsd as owner.
  const logical = { path: '/Users/synthetic/Design.psd#Embedded.png', name: 'Embedded.png', fileId: 'logical', ext: '.png',
    projectRole: 'asset', source: 'scan-on-save-embedded', embedded: true, parentPsd: psd.path, embeddedIndex: 0 };
  f.project.files.push(psd, kept, logical);
  await f.command(psd, 'exclude');
  assert.equal(factOf(f, logical).excludedSourceOnly, true);
  assert.equal(factOf(f, logical).included, false);
  await scanWorkingFile(f, kept, [psd]);
  assert.equal(factOf(f, psd).includedAsDependency, true);
  assert.equal(factOf(f, logical).excludedSourceOnly, false);
  assert.equal(factOf(f, logical).included, true);
});

test('a retained file rescan that newly references a withheld asset brings it back as required', async () => {
  const f = fixture(), root = f.source('Art.ai'), kept = f.source('Poster.ai');
  const asset = dependencyAsset(f, 'Shared.png', { captureEvidence: { relationshipSourcePath: root.path } });
  f.project.files.push(root, kept, asset);
  await scanWorkingFile(f, root, [asset]);
  await scanWorkingFile(f, kept, []);
  await f.command(root, 'exclude');
  assert.equal(factOf(f, asset).included, false);
  await scanWorkingFile(f, kept, [asset]);
  const fact = factOf(f, asset);
  assert.equal(fact.included, true); assert.equal(fact.includedAsDependency, true);
  assert.equal(fact.excludedSourceOnly, false);
  assert.deepEqual(plain(fact.requiredBy), ['Poster.ai']);
});
