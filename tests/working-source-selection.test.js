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
  const events = [];
  const invalidated = [];
  let digestGate = null;
  let authorized = true;
  let epoch = 0;
  const context = vm.createContext({
    path, crypto,
    runBoundedAddFilesScan, ADD_FILES_SCAN_TIMEOUT_MS: 1000,
    fs: { existsSync: filePath => disk.has(filePath), statSync: filePath => {
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
    runBoundedScanOnOpenQueue: async (id, paths, token, operation, options) => {
      const outcomes = [];
      for (const filePath of paths) {
        const scan = api.beginWorkingSourceScan(id, filePath, operation.current, options.workingSourceAttempt);
        try {
          const digest = await context.getAddFilesCurrentSourceDigest(filePath, operation);
          const evidence = api.collectWorkingSourceScanEvidence(await context.extractLinkedAssetsRegex(filePath));
          if (digest !== await context.getAddFilesCurrentSourceDigest(filePath, operation)) throw new Error('source-bytes-changed');
          api.publishWorkingSourceScan(scan, { ...evidence, status: evidence.limited ? 'limited' : 'scanned',
            sourceIdentity: api.getWorkingSourceDiskIdentity(scan.file), sourceFingerprint: digest });
          outcomes.push({ success: true });
        } catch (_) { outcomes.push({ success: false, error: 'scan_on_open_failed' }); }
      }
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
  api = vm.runInContext('({getWorkingSourceSelection, getWorkingSourceVerification, getWorkingSourceMembership, setWorkingSourceSelection, getAssetBaselineSourceRecoveryRouteKey, selectProjectFilesForPackaging, beginWorkingSourceScan, collectWorkingSourceScanEvidence, publishWorkingSourceScan, getWorkingSourceDiskIdentity})', context);
  const source = (name, fileId = name) => {
    const file = { path: `/Users/synthetic/${name}`, name, fileId, ext: path.extname(name), projectRole: 'source' };
    disk.set(file.path, Buffer.from('%PDF-1.7\n%%EOF\n'));
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
  return { api, project, source, asset, disk, command, events, invalidated,
    reload() { projects = JSON.parse(JSON.stringify(projects)); return projects[0]; },
    replace(project) { projects = [project]; },
    revoke() { authorized = false; },
    changeGeneration() { epoch++; },
    setDigestGate(callback) { digestGate = callback; } };
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
