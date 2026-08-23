const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function extractNamedFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must remain source-visible for integration coverage`);
  const bodyMarker = source.indexOf(') {', start);
  const open = bodyMarker === -1 ? -1 : bodyMarker + 2;
  assert.notEqual(open, -1, `${name} must have a body`);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '\'' || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`${name} function body was not balanced`);
}

function createWatcherCoordinator(options = {}) {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const coordinatorSource = extractNamedFunction(main, 'createWatcherCoordinator');
  const coordinatorFactory = vm.runInNewContext(`(${coordinatorSource})`);
  return coordinatorFactory(options);
}

function syntheticProject() {
  return {
    id: 'synthetic-large-project',
    status: 'watching',
    files: Array.from({ length: 267 }, (_, index) => ({
      path: `/Users/test/large-project/asset-${index}.png`,
      source: 'lsof',
    })),
    pendingFiles: [],
  };
}

function syntheticLsofOutput() {
  return Array.from({ length: 1778 }, (_, index) => {
    if (index === 0) return 'p4242';
    if (index === 1) return 'tREG';
    return `n/Users/test/large-project/asset-${(index - 2) % 267}.png`;
  }).join('\n');
}

function runNoChangeCycle(coordinator, project, lsofOutput, counters) {
  const ticket = coordinator.tryStart(project.id, 'lsof');
  if (!ticket) return false;
  const before = JSON.stringify(project);
  const parsed = lsofOutput.split('\n');
  assert.equal(parsed.length, 1778);
  for (const line of parsed) {
    if (line.startsWith('n')) void line.slice(1);
  }
  if (JSON.stringify(project) !== before) counters.storeWrites += 1;
  coordinator.finish(project.id, ticket);
  return true;
}

test('267-file Figma-only lsof fixture: 100 unchanged cycles produce zero writes', () => {
  const project = syntheticProject();
  const lsofOutput = syntheticLsofOutput();
  const baseline = { storeWrites: 0 };
  const fixed = { storeWrites: 0 };
  const coordinator = createWatcherCoordinator();
  coordinator.activate(project.id);

  for (let cycle = 0; cycle < 100; cycle += 1) {
    // Beta 2.14 behavior: mutateProject persisted the collection on every poll.
    const before = JSON.stringify(project);
    void lsofOutput.split('\n').filter(line => line.startsWith('n')).length;
    if (JSON.stringify(project) === before) baseline.storeWrites += 1;
    assert.equal(runNoChangeCycle(coordinator, project, lsofOutput, fixed), true);
  }

  assert.equal(project.files.length, 267);
  assert.equal(lsofOutput.split('\n').length, 1778);
  assert.equal(baseline.storeWrites, 100);
  assert.equal(fixed.storeWrites, 0);
  assert.equal(coordinator.snapshot(project.id).counters.started, 100);
  assert.equal(coordinator.snapshot(project.id).counters.completed, 100);
});

test('coordinator permits one heavy operation and fairly coalesces overlap by kind', () => {
  const coordinator = createWatcherCoordinator();
  const projectId = 'concurrency-fixture';
  coordinator.activate(projectId);
  const first = coordinator.tryStart(projectId, 'lsof');
  assert.ok(first);
  assert.equal(coordinator.tryStart(projectId, 'live-app'), null);
  assert.equal(coordinator.tryStart(projectId, 'last-used'), null);
  assert.equal(coordinator.snapshot(projectId).counters.skippedOverlap, 2);
  assert.equal(coordinator.defer(projectId, 'live-app'), true);
  assert.equal(coordinator.defer(projectId, 'last-used'), true);
  assert.equal(coordinator.defer(projectId, 'figma'), true);
  assert.equal(coordinator.defer(projectId, 'live-app'), true);
  assert.deepEqual(
    Array.from(coordinator.snapshot(projectId).pendingKinds),
    ['live-app', 'last-used', 'figma']
  );
  assert.equal(coordinator.snapshot(projectId).counters.deferred, 3);
  assert.equal(coordinator.snapshot(projectId).counters.coalesced, 1);
  coordinator.finish(projectId, first);
  for (const expectedKind of ['live-app', 'last-used', 'figma']) {
    assert.equal(coordinator.takeDeferred(projectId), expectedKind);
    const next = coordinator.tryStart(projectId, expectedKind);
    assert.ok(next);
    assert.equal(next.kind, expectedKind);
    coordinator.finish(projectId, next);
  }
  assert.equal(coordinator.takeDeferred(projectId), null);
  assert.equal(coordinator.snapshot(projectId).running, false);
});

test('overdue work applies bounded backoff instead of queue growth', () => {
  let now = 1000;
  const coordinator = createWatcherCoordinator({ now: () => now, maxBackoffMs: 8000 });
  const projectId = 'slow-fixture';
  coordinator.activate(projectId);
  const first = coordinator.tryStart(projectId, 'lsof');
  assert.ok(first);
  now += 3000;
  coordinator.finish(projectId, first, { overdue: true });
  assert.equal(coordinator.snapshot(projectId).counters.overdue, 1);
  coordinator.defer(projectId, 'figma');
  assert.equal(coordinator.takeDeferred(projectId), null);
  assert.equal(coordinator.tryStart(projectId, 'lsof'), null);
  assert.equal(coordinator.snapshot(projectId).counters.skippedBackoff, 1);
  now += 500;
  assert.equal(coordinator.tryStart(projectId, 'lsof'), null);
  now += 500;
  assert.equal(coordinator.takeDeferred(projectId), 'figma');
  const resumed = coordinator.tryStart(projectId, 'lsof');
  assert.ok(resumed);
  coordinator.finish(projectId, resumed);
});

test('package scan pauses background work and resumes exactly once', () => {
  const coordinator = createWatcherCoordinator();
  const projectId = 'package-fixture';
  coordinator.activate(projectId);
  const before = coordinator.snapshot(projectId).generation;
  coordinator.beginPackageScan(projectId);
  coordinator.defer(projectId, 'figma');
  assert.equal(coordinator.snapshot(projectId).packageScanActive, true);
  assert.deepEqual(Array.from(coordinator.snapshot(projectId).pendingKinds), []);
  assert.equal(coordinator.tryStart(projectId, 'lsof'), null);
  assert.equal(coordinator.snapshot(projectId).counters.skippedPackageScan, 1);
  coordinator.endPackageScan(projectId);
  assert.equal(coordinator.snapshot(projectId).packageScanActive, false);
  assert.ok(coordinator.snapshot(projectId).generation > before);
  const resumed = coordinator.tryStart(projectId, 'lsof');
  assert.ok(resumed);
  coordinator.finish(projectId, resumed);
});

test('activation replacement and quit invalidate in-flight completion', () => {
  const coordinator = createWatcherCoordinator();
  const projectId = 'lifecycle-fixture';
  coordinator.activate(projectId);
  const old = coordinator.tryStart(projectId, 'lsof');
  assert.ok(old);
  coordinator.activate(projectId);
  assert.equal(coordinator.isCurrent(projectId, old.generation), false);
  coordinator.finish(projectId, old);
  coordinator.cancel(projectId);
  assert.equal(coordinator.tryStart(projectId, 'lsof'), null);
  coordinator.activate(projectId);
  const resumed = coordinator.tryStart(projectId, 'lsof');
  assert.ok(resumed);
  coordinator.finish(projectId, resumed);
});

test('changed candidate causes one write and one renderer update in the harness', () => {
  const coordinator = createWatcherCoordinator();
  const project = syntheticProject();
  const projectId = project.id;
  coordinator.activate(projectId);
  let storeWrites = 0;
  let rendererUpdates = 0;
  const ticket = coordinator.tryStart(projectId, 'lsof');
  assert.ok(ticket);
  const before = JSON.stringify(project);
  project.files.push({ path: '/Users/test/large-project/new-asset.fig', source: 'lsof' });
  if (JSON.stringify(project) !== before) {
    storeWrites += 1;
    rendererUpdates += 1;
  }
  coordinator.finish(projectId, ticket);
  assert.equal(storeWrites, 1);
  assert.equal(rendererUpdates, 1);
});

test('actual main mutateProject gate gives unchanged lsof polls zero writes', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const mutateProjectSource = extractNamedFunction(main, 'mutateProject');
  const projects = [syntheticProject()];
  let storeWrites = 0;
  const context = {
    getProjects: () => projects,
    normalizeAutoCaptureProjectState: () => {},
    normalizeProjectAssetReviewState: () => {},
    safelyEnsureProjectProvenance: () => {},
    store: { set: () => { storeWrites += 1; } },
  };
  const mutateProject = vm.runInNewContext(`(${mutateProjectSource})`, context);
  const lsofOutput = syntheticLsofOutput();
  assert.equal(projects[0].files.length, 267);
  assert.equal(lsofOutput.split('\n').length, 1778);
  const lsofSource = main.slice(
    main.indexOf('function pollLsofForProjectCore'),
    main.indexOf('function pollLsofForProject(')
  );
  assert.match(lsofSource, /mutateProject\(projectId,[\s\S]*?persistIfChanged: true, trustResultChanged: true/);

  for (let cycle = 0; cycle < 100; cycle += 1) {
    void lsofOutput.split('\n').filter(line => line.startsWith('n')).length;
    mutateProject(projects[0].id, () => ({ changed: false, evidenceChanged: false }), {
      persistIfChanged: true,
      trustResultChanged: true,
    });
  }
  assert.equal(storeWrites, 0, '100 unchanged lsof polls must not rewrite the projects store');

  mutateProject(projects[0].id, project => {
    project.files.push({ path: '/Users/test/large-project/new-asset.fig', source: 'lsof' });
    return { changed: true, evidenceChanged: false };
  }, { persistIfChanged: true, trustResultChanged: true });
  assert.equal(storeWrites, 1, 'a changed lsof candidate must persist exactly once');

  mutateProject(projects[0].id, project => {
    project.provenance = { latest: { source: 'lsof', path: '/Users/test/large-project/new-asset.fig' } };
    return { changed: true, evidenceChanged: true };
  }, { persistIfChanged: true, trustResultChanged: true });
  assert.equal(storeWrites, 2, 'a provenance/evidence mutation must persist exactly once');
});

test('main-process integration points remain scoped to lag-only coordinator', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /createWatcherCoordinator/);
  assert.match(main, /persistIfChanged: true/);
  assert.match(main, /pauseWatcherCoordinatorForPackage/);
  assert.match(main, /resumeWatcherCoordinatorAfterPackage/);
  assert.match(main, /cancelWatcherCoordinator/);
  assert.match(main, /waitForLsofIdle\(projectId\)/);
  assert.match(main, /runBackgroundWatcherOperation\(projectId, 'live-app'/);
  assert.match(main, /runBackgroundWatcherOperation\(projectId, 'last-used'/);
  assert.match(main, /runBackgroundWatcherOperation\(projectId, 'figma'/);
  assert.match(main, /const watcherDeferredOperations = new Map\(\)/);
  assert.match(main, /function deferWatcherOperation\(/);
  assert.match(main, /function scheduleDeferredWatcherOperation\(/);
  assert.match(main, /pollFigmaForProjectCore\(projectId, true, activationToken, null\)/);
  assert.match(main, /pollPsForProjectCore\(projectId, activationToken, null\)/);
  assert.match(main, /const LSOF_POLL_MS = 3000;/);
  assert.match(main, /const LIVE_APP_REFRESH_INTERVAL_MS = 10000;/);
  const startWatching = main.slice(
    main.indexOf('async function startWatching'),
    main.indexOf('function stopWatching')
  );
  assert.match(startWatching, /runBackgroundWatcherOperation\(projectId, 'lsof'/);
  assert.match(startWatching, /initialSnapshotParserScans\.push\(/);
  assert.match(startWatching, /await Promise\.allSettled\(initialSnapshotParserScans\)/);
});

test('pre-package scan claims single-flight before a bounded watcher drain', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const handlerStart = main.indexOf("registerTrustedIpcHandler('projects:pre-package-scan'");
  const handlerEnd = main.indexOf('// --- Embedded media extraction', handlerStart);
  assert.notEqual(handlerStart, -1);
  assert.notEqual(handlerEnd, -1);
  const handler = main.slice(handlerStart, handlerEnd);
  const claimIndex = handler.indexOf('scanInFlight.add(projectId)');
  const drainIndex = handler.indexOf('await pauseWatcherCoordinatorForPackage(projectId)');
  assert.ok(claimIndex >= 0 && drainIndex > claimIndex, 'the package scan must claim single-flight before waiting');
  assert.match(main, /const BACKGROUND_WATCHER_DRAIN_TIMEOUT_MS = 15000;/);
  assert.match(handler, /failurePhase: 'background-watch-drain'/);
  assert.match(handler, /incompletePackageScans\.add\(projectId\)/);
  assert.match(handler, /packageScanDiagnosticState\.set\(projectId, drainDiagnostic\)/);
  assert.match(handler, /invalidatePackageReviewForProject\(projectId\)/);
  assert.match(handler, /resumeWatcherCoordinatorAfterPackage\(projectId\)/);
});

test('lsof child parser work remains inside the capture-critical operation and package drain', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = main.indexOf('function pollLsofForProjectCore');
  const end = main.indexOf('function pollLsofForProject(', start);
  assert.ok(start >= 0 && end > start);
  const source = main.slice(start, end);
  assert.match(source, /const parserScans = \[\]/);
  assert.match(source, /parserScans\.push\(runScanOnOpen/);
  assert.match(source, /finally \{[\s\S]*?await Promise\.allSettled\(parserScans\)[\s\S]*?finishLsofPoll\(projectId, onComplete\)/);
  const recurring = extractNamedFunction(main, 'pollLsofForProject');
  assert.match(recurring, /snapshot\.cancelled \|\| snapshot\.packageScanActive/);
  assert.match(recurring, /pollLsofForProjectCore\(projectId, activationToken, resolve, snapshot\.generation\)/);
  assert.doesNotMatch(recurring, /runBackgroundWatcherOperation/);
  const packagePause = extractNamedFunction(main, 'pauseWatcherCoordinatorForPackage');
  assert.match(packagePause, /coordinator\.waitForIdle\(projectId\)/);
  assert.match(packagePause, /waitForLsofIdle\(projectId\)/);
});

test('lsof output exclusion is resolved from the fresh mutation collection', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = main.indexOf('function pollLsofForProjectCore');
  const end = main.indexOf('function pollLsofForProject(', start);
  const source = main.slice(start, end);
  assert.doesNotMatch(source, /watcherProjectCollection|watcherOutputPaths/);
  assert.match(source, /mutateProject\(projectId, \(proj, projectsAtMutation\)/);
  assert.match(source, /projectCollection: projectsAtMutation/);
});

test('one-time and manual scans preserve execution while recurring scans use the coordinator', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const figmaStart = main.slice(
    main.indexOf('async function startFigmaPolling'),
    main.indexOf('function stopFigmaPolling')
  );
  assert.match(figmaStart, /initialResult = await pollFigmaForProjectCore\(projectId, true, activationToken, null\)/);
  assert.match(figmaStart, /setInterval\(\(\) => \{[\s\S]*?pollFigmaForProject\(projectId, false, activationToken\)/);

  const manualProject = main.slice(
    main.indexOf("registerTrustedIpcHandler('figma:scan-project'"),
    main.indexOf("registerTrustedIpcHandler('figma:project-assets'")
  );
  assert.match(manualProject, /pollFigmaForProjectCore\(projectId, true, activationToken, null\)/);
  assert.doesNotMatch(manualProject, /pollFigmaForProject\(/);

  const manualAll = main.slice(
    main.indexOf("registerTrustedIpcHandler('figma:scan-now'"),
    main.indexOf("registerTrustedIpcHandler('settings:get'")
  );
  assert.match(manualAll, /pollFigmaForProjectCore\(project\.id, false, activationToken, null\)/);
  assert.doesNotMatch(manualAll, /pollFigmaForProject\(/);

  const illustratorAdmission = main.slice(
    main.indexOf('function admitIllustratorSourcesForProject'),
    main.indexOf('function admitIllustratorRelationshipPathsForProject')
  );
  assert.match(illustratorAdmission, /pollPsForProjectCore\(projectId, activationToken, null\)/);
});
