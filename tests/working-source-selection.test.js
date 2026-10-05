'use strict';

// Bounded tests of production functions with an in-memory project writer and
// filesystem. No Electron, private config, producer apps, dependency acquisition,
// or standalone persistence framework is loaded by this suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
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
  let digestGate = null;
  let afterScan = null;
  let documentIdentityReader = () => null;
  let authorized = true;
  let epoch = 0;
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
    getProjects: () => projects,
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
      return { current: () => open && authorized && capturedEpoch === epoch && projects.some(p => p.id === id),
        close: () => { open = false; }, adoptScope: () => true };
    },
    mutateProject: (id, fn) => {
      const project = projects.find(p => p.id === id);
      return project ? fn(project) : null;
    },
    resolveProjectOwnedFileVisualRecord: (id, identity, project) =>
      (project?.files || []).find(file => identity === `${id}:${file.fileId}`),
    createProjectFileVisualIdentity: (id, file) => `${id}:${file.fileId}`,
    invalidatePackageReviewForProject: id => invalidated.push(id),
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
    between('function getAssetBaselineSourceRecoveryRouteKey(', 'function getWorkingSourceSelection(') +
    between('function getWorkingSourceSelection(', 'function getAssetBaselineSourcePhysicalIdentityHash(') +
    between('async function selectProjectFilesForPackaging(', 'function isDesignAppFile(') , context);
  api = vm.runInContext('({getWorkingSourceSelection, getWorkingSourceVerification, getWorkingSourceMembership, setWorkingSourceSelection, getAssetBaselineSourceRecoveryRouteKey, selectProjectFilesForPackaging, beginWorkingSourceScan, collectWorkingSourceScanEvidence, publishWorkingSourceScan, getWorkingSourceDiskIdentity, recordWorkingSourceContinuationCandidate, resolveWorkingSourceContinuation, getWorkingSourceContinuationPresentation, observeIllustratorWorkingSourceContinuation, refreshWorkingSourceLocators})', context);
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
  const command = (file, action, expectedRevision = api.getWorkingSourceSelection(projects[0], file).revision) =>
    api.setWorkingSourceSelection(project.id, `${project.id}:${file.fileId}`, { action, expectedRevision });
  return { api, project, source, asset, disk, physical, command, events, invalidated,
    reload() { projects = JSON.parse(JSON.stringify(projects)); return projects[0]; },
    replace(project) { projects = [project]; },
    revoke() { authorized = false; },
    changeGeneration() { epoch++; },
    setDigestGate(callback) { digestGate = callback; },
    setAfterScan(callback) { afterScan = callback; },
    setDocumentIdentityReader(callback) { documentIdentityReader = callback; } };
}

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
