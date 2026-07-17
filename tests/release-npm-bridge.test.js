'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  configureBuildCommand,
  createYargs,
  normalizeOptions,
} = require('electron-builder/out/builder');
const {
  PublishManager,
  getPublishConfigsForUpdateInfo,
} = require('app-builder-lib/out/publish/PublishManager');

const {
  REQUIRED_ARGS,
  authenticateReleaseProcess,
  forceTraversalCollector,
  releaseArgsAreExact,
  sha256,
} = require('../scripts/run-electron-builder-release');

const CANONICAL_NODE = fs.realpathSync(process.execPath);

test('release launcher requires local update metadata without publishing', () => {
  assert.equal(releaseArgsAreExact(REQUIRED_ARGS), true);
  assert.equal(releaseArgsAreExact(REQUIRED_ARGS.slice(0, -2)), false);
  assert.equal(releaseArgsAreExact([...REQUIRED_ARGS.slice(0, -1), 'always']), false);
  assert.equal(releaseArgsAreExact([...REQUIRED_ARGS].reverse()), false);
});

test('release launcher gives Electron Builder explicit local update metadata configuration', async () => {
  const parser = createYargs();
  configureBuildCommand(parser);
  const options = normalizeOptions(parser.parse(REQUIRED_ARGS));
  const publishConfig = {
    provider: 'github',
    owner: 'bfeintuch123',
    repo: 'crate-app',
  };

  assert.equal(options.publish, 'never');
  assert.deepEqual(options.config.publish, publishConfig);
  assert.deepEqual(
    await getPublishConfigsForUpdateInfo({}, [publishConfig], 3),
    [publishConfig]
  );
});

test('release launcher keeps Electron Builder upload scheduling unreachable', async () => {
  const handlers = {};
  const cancellationToken = { cancelled: false };
  const packager = {
    cancellationToken,
    onAfterPack(handler) {
      handlers.afterPack = handler;
    },
    onArtifactCreated(handler) {
      handlers.artifactCreated = handler;
    },
  };
  const manager = new PublishManager(packager, { publish: 'never' }, cancellationToken);
  let uploadWasScheduled = false;
  manager.scheduleUpload = async () => {
    uploadWasScheduled = true;
  };

  assert.equal(manager.isPublish, false);
  await handlers.artifactCreated({
    file: '/private/tmp/Crate-test.dmg',
    packager: null,
    publishConfig: { provider: 'github' },
  });
  assert.equal(uploadWasScheduled, false);
});

test('release launcher binds the authenticated Node to the running executable', () => {
  const env = {
    CRATE_RELEASE_CANONICAL_NODE: CANONICAL_NODE,
    CRATE_RELEASE_CANONICAL_NODE_SHA256: sha256(CANONICAL_NODE),
  };
  assert.equal(authenticateReleaseProcess(env), CANONICAL_NODE);
  assert.throws(() => authenticateReleaseProcess(env, { currentExecutable: __filename }));
  assert.throws(() => authenticateReleaseProcess({
    ...env,
    CRATE_RELEASE_CANONICAL_NODE_SHA256: '0'.repeat(64),
  }));
});

test('release launcher forces Electron Builder to its in-process traversal collector', async () => {
  const traversalOnly = forceTraversalCollector();
  const selected = await traversalOnly({}).value;
  assert.equal(selected.pm, 'traversal');
  assert.equal(await selected.workspaceRoot, undefined);

  const collector = require('app-builder-lib/out/node-module-collector');
  const selectedFromPatchedExport = await collector.determinePackageManagerEnv({}).value;
  assert.equal(selectedFromPatchedExport.pm, 'traversal');
  assert.equal(await selectedFromPatchedExport.workspaceRoot, undefined);
});

test('release launcher blocks any unexpected npm subprocess request', () => {
  forceTraversalCollector();
  const packageManager = require('app-builder-lib/out/node-module-collector/packageManager.js');
  assert.throws(
    () => packageManager.getPackageManagerCommand(packageManager.PM.NPM),
    /unexpected npm subprocess/u
  );
  assert.equal(packageManager.getPackageManagerCommand(packageManager.PM.TRAVERSAL), 'traversal');
});

test('traversal collector builds the production graph without a package-manager command', async () => {
  forceTraversalCollector();
  const collectorModule = require('app-builder-lib/out/node-module-collector');
  const tempDirManager = {
    getTempFile() {
      throw new Error('Traversal collector must not request command output files.');
    },
  };
  const collector = collectorModule.getCollectorByPackageManager(
    collectorModule.PM.TRAVERSAL,
    path.join(__dirname, '..'),
    tempDirManager
  );
  const result = await collector.getNodeModules({ packageName: 'crate-app' });
  assert.equal(result.nodeModules.length > 0, true);
  assert.equal(result.nodeModules.some(dependency => dependency.name === 'electron-store'), true);
});
