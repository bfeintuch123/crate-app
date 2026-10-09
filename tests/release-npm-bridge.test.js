'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const builderApi = require('electron-builder/out/builder');
const builderUtil = require('builder-util');
const resolver = require('app-builder-lib/out/util/resolve');
const { configureBuildCommand, createYargs, normalizeOptions } = builderApi;
const {
  PublishManager,
  getPublishConfigsForUpdateInfo,
} = require('app-builder-lib/out/publish/PublishManager');

const {
  REQUIRED_ARGS,
  authenticateElectronArchive,
  authenticateReleaseProcess,
  forceTraversalCollector,
  releaseArgsAreExact,
  sha256,
} = require('../scripts/run-electron-builder-release');

const CANONICAL_NODE = fs.realpathSync(process.execPath);
const NODE_ENV = {
  CRATE_RELEASE_CANONICAL_NODE: CANONICAL_NODE,
  CRATE_RELEASE_CANONICAL_NODE_SHA256: sha256(CANONICAL_NODE),
};

function stageInventory(root) {
  const entries = {};
  const visit = directory => {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      entries[path.relative(root, file)] = {
        mode: stat.mode & 0o777,
        type: stat.isDirectory() ? 'directory' : 'file',
        ...(stat.isFile() ? { digest: sha256(file) } : {}),
      };
      if (stat.isDirectory()) visit(file);
    }
  };
  visit(root);
  return entries;
}

function archiveFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crate-launcher-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archiveName = 'electron-v42.10.0-darwin-arm64.zip';
  const archive = path.join(root, archiveName);
  const bytes = Buffer.from('controlled authenticated Electron ZIP fixture');
  fs.writeFileSync(archive, bytes);
  const packageRoot = path.join(root, 'node_modules', 'electron');
  const tarRoot = path.join(root, 'tar', 'package');
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.mkdirSync(tarRoot, { recursive: true });
  const electronManifest = { name: 'electron', version: '42.10.0' };
  const files = {
    'package.json': JSON.stringify(electronManifest),
    'checksums.json': JSON.stringify({
      [archiveName]: crypto.createHash('sha256').update(bytes).digest('hex'),
    }),
  };
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(packageRoot, name), contents);
    fs.writeFileSync(path.join(tarRoot, name), contents);
  }
  const tarPath = path.join(root, 'electron.tgz');
  const packed = spawnSync('/usr/bin/tar', ['-czf', tarPath, '-C', path.dirname(tarRoot), 'package'], {
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, encoding: 'utf8',
  });
  assert.equal(packed.status, 0, packed.stderr);
  const tarBytes = fs.readFileSync(tarPath);
  const integrity = crypto.createHash('sha512').update(tarBytes).digest();
  const digest = integrity.toString('hex');
  const cache = path.join(root, 'cache');
  const contentPath = path.join(cache, '_cacache', 'content-v2', 'sha512', digest.slice(0, 2), digest.slice(2, 4), digest.slice(4));
  fs.mkdirSync(path.dirname(contentPath), { recursive: true });
  fs.writeFileSync(contentPath, tarBytes);
  const manifest = { name: 'crate-app', devDependencies: { electron: '^42.10.0' }, build: {} };
  const lock = { packages: {
    '': { devDependencies: manifest.devDependencies },
    'node_modules/electron': {
      version: '42.10.0', resolved: 'https://registry.npmjs.org/electron/-/electron-42.10.0.tgz',
      integrity: `sha512-${integrity.toString('base64')}`,
    },
  } };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock));
  const scripts = path.join(root, 'scripts');
  fs.mkdirSync(scripts);
  for (const name of ['run-electron-builder-release.js', 'verify-macos-release-app.js',
    'patch-helper-info-plists.js', 'verify-app-contents.js', 'install-approved-canvas-prebuild.js']) {
    fs.copyFileSync(path.join(__dirname, '..', 'scripts', name), path.join(scripts, name));
  }
  const launcher = require(path.join(scripts, 'run-electron-builder-release.js'));
  return { root, archive, bytes, packageRoot, cache, contentPath, manifest, lock, launcher };
}

async function invokeFixture(fixture, args = REQUIRED_ARGS, env = {}, build = async () => []) {
  const originalLoad = Module._load;
  const originalArgv = process.argv;
  const originalCwd = process.cwd();
  const originalCache = process.env.npm_config_cache;
  const collector = { PM: { TRAVERSAL: 'traversal' } };
  const packageManager = { PM: { NPM: 'npm', TRAVERSAL: 'traversal' }, getPackageManagerCommand: pm => pm };
  let builderCalls = 0;
  let observedArgs;
  let observedOptions;
  Module._load = function(request, ...rest) {
    if (request === 'lazy-val') return { Lazy: class { constructor(factory) { this.value = factory(); } } };
    if (request === 'app-builder-lib/out/node-module-collector') return collector;
    if (request === 'app-builder-lib/out/node-module-collector/packageManager.js') return packageManager;
    if (request === 'builder-util') return builderUtil;
    if (request === 'app-builder-lib/out/util/resolve') return resolver;
    if (request === 'electron-builder/out/builder') return {
      ...builderApi,
      async build(options) {
        builderCalls += 1;
        observedOptions = options;
        observedArgs = process.argv.slice(2);
        return build(options);
      },
    };
    if (request === '../node_modules/electron-builder/out/cli/cli.js') throw new Error('Local route must use the awaitable Builder API.');
    return originalLoad.call(this, request, ...rest);
  };
  try {
    process.chdir(fixture.root);
    process.env.npm_config_cache = fixture.cache;
    process.argv = [CANONICAL_NODE, 'launcher', ...args];
    let status;
    let error;
    try { status = await fixture.launcher.run(args, { ...NODE_ENV, CRATE_RELEASE_ELECTRON_ARCHIVE: fixture.archive, ...env }); }
    catch (caught) { error = caught; }
    return { builderCalls, observedArgs, observedOptions, status, error };
  } finally {
    Module._load = originalLoad;
    process.argv = originalArgv;
    process.chdir(originalCwd);
    if (originalCache === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = originalCache;
  }
}

test('release launcher fixture canonicalizes an owned temporary directory alias before archive authentication', async t => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crate-launcher-alias-')));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const alias = path.join(tempRoot, 'temp-alias');
  fs.symlinkSync(tempRoot, alias, 'dir');
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(alias), tempRoot);
  const originalTmpdir = process.env.TMPDIR;
  let fixture;
  try {
    process.env.TMPDIR = alias;
    assert.equal(os.tmpdir(), alias);
    fixture = archiveFixture(t);
  } finally {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
  }
  const aliasedArchive = path.join(alias, path.basename(fixture.root), path.basename(fixture.archive));
  assert.notEqual(aliasedArchive, fixture.archive);
  assert.equal(fs.realpathSync(aliasedArchive), fixture.archive);
  assert.equal(fs.realpathSync(fixture.root), fixture.root);
  assert.equal(fs.lstatSync(fixture.archive).isFile(), true);
  assert.equal(fs.lstatSync(fixture.archive).isSymbolicLink(), false);
  const result = await invokeFixture(fixture);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.builderCalls, 1);
});

test('release launcher passes only the authenticated local ZIP to the supported Builder configuration', async t => {
  const fixture = archiveFixture(t);
  const result = await invokeFixture(fixture);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.builderCalls, 1);
  assert.deepEqual(result.observedArgs, REQUIRED_ARGS);
  const options = result.observedOptions;
  assert.notEqual(options.config.electronDist, fixture.archive);
  assert.equal(path.basename(options.config.electronDist), path.basename(fixture.archive));
  assert.equal(fs.existsSync(path.dirname(options.config.electronDist)), false);
  assert.equal(typeof options.config.afterExtract, 'function');
  assert.equal(options.publish, 'never');
  // The CLI parser preserves config scalar strings; Builder converts them when merging configuration.
  assert.equal(options.config.npmRebuild, 'false');
});

for (const [name, mutate] of [
  ['missing archive', fixture => fs.unlinkSync(fixture.archive)],
  ['mismatched digest', fixture => fs.appendFileSync(fixture.archive, 'changed')],
  ['directory archive', fixture => { fs.unlinkSync(fixture.archive); fs.mkdirSync(fixture.archive); }],
  ['symlink archive', fixture => { fs.renameSync(fixture.archive, `${fixture.archive}.original`); fs.symlinkSync(`${fixture.archive}.original`, fixture.archive); }],
  ['wrong version', fixture => { fixture.archive = path.join(fixture.root, 'electron-v42.9.0-darwin-arm64.zip'); fs.writeFileSync(fixture.archive, fixture.bytes); }],
  ['wrong architecture', fixture => { fixture.archive = path.join(fixture.root, 'electron-v42.10.0-darwin-x64.zip'); fs.writeFileSync(fixture.archive, fixture.bytes); }],
  ['wrong platform', fixture => { fixture.archive = path.join(fixture.root, 'electron-v42.10.0-linux-arm64.zip'); fs.writeFileSync(fixture.archive, fixture.bytes); }],
  ['forged checksum package', fixture => fs.writeFileSync(path.join(fixture.packageRoot, 'checksums.json'), JSON.stringify({ [path.basename(fixture.archive)]: '0'.repeat(64) }))],
  ['mismatched installed version', fixture => fs.writeFileSync(path.join(fixture.packageRoot, 'package.json'), JSON.stringify({ name: 'electron', version: '42.9.0' }))],
  ['corrupted integrity archive', fixture => fs.appendFileSync(fixture.contentPath, 'changed')],
  ['unrelated configured override', fixture => { fixture.manifest.build.electronVersion = '42.9.0'; fs.writeFileSync(path.join(fixture.root, 'package.json'), JSON.stringify(fixture.manifest)); }],
]) {
  test(`release launcher rejects ${name} before loading Builder`, async t => {
    const fixture = archiveFixture(t);
    mutate(fixture);
    const result = await invokeFixture(fixture);
    assert.equal(result.builderCalls, 0);
    assert.ok(result.error);
  });
}

test('release launcher rejects empty local input and Node authentication failure before Builder', async t => {
  const fixture = archiveFixture(t);
  for (const env of [
    { CRATE_RELEASE_ELECTRON_ARCHIVE: '' },
    { CRATE_RELEASE_CANONICAL_NODE_SHA256: '0'.repeat(64) },
  ]) {
    const result = await invokeFixture(fixture, REQUIRED_ARGS, env);
    assert.equal(result.builderCalls, 0);
    assert.ok(result.error);
  }
});

test('release launcher rejects caller-supplied Builder overrides even with an authenticated ZIP', async t => {
  const fixture = archiveFixture(t);
  const originalWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    for (const override of ['--config.electronDist=/tmp/untrusted.zip', '--config.electronDownload.force=true', '--config.afterSign=', '--publish=always']) {
      const result = await invokeFixture(fixture, [...REQUIRED_ARGS, override]);
      assert.equal(result.builderCalls, 0);
      assert.equal(result.status, 2);
    }
  } finally { process.stderr.write = originalWrite; }
});

test('release launcher preserves ordinary arguments when no local input is supplied', async t => {
  const fixture = archiveFixture(t);
  const result = await invokeFixture(fixture, REQUIRED_ARGS, { CRATE_RELEASE_ELECTRON_ARCHIVE: undefined });
  assert.ok(result.error); // A present but invalid local input cannot silently become the ordinary route.
  const originalLoad = Module._load;
  const originalArgv = process.argv;
  let observed;
  Module._load = function(request, ...rest) {
    if (request === '../node_modules/electron-builder/out/cli/cli.js') { observed = process.argv.slice(2); return {}; }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    process.argv = [CANONICAL_NODE, 'launcher', ...REQUIRED_ARGS];
    assert.equal(require('../scripts/run-electron-builder-release').run(REQUIRED_ARGS, NODE_ENV), 0);
    assert.deepEqual(observed, REQUIRED_ARGS);
  } finally { Module._load = originalLoad; process.argv = originalArgv; }
});

for (const [name, replace] of [
  ['overwrite', fixture => fs.writeFileSync(fixture.archive, 'unauthenticated replacement')],
  ['rename', fixture => { fs.renameSync(fixture.archive, `${fixture.archive}.old`); fs.writeFileSync(fixture.archive, 'unauthenticated replacement'); }],
  ['symlink', fixture => { fs.unlinkSync(fixture.archive); fs.writeFileSync(`${fixture.archive}.replacement`, 'unauthenticated symlink target'); fs.symlinkSync(`${fixture.archive}.replacement`, fixture.archive); }],
  ['deletion', fixture => fs.unlinkSync(fixture.archive)],
]) {
  test(`release launcher isolates authenticated bytes from original ZIP ${name} after authentication`, async t => {
    const fixture = archiveFixture(t);
    let snapshot;
    const result = await invokeFixture(fixture, REQUIRED_ARGS, {}, async options => {
      snapshot = options.config.electronDist;
      assert.notEqual(snapshot, fixture.archive);
      assert.equal(fs.realpathSync(snapshot), snapshot);
      assert.equal(fs.lstatSync(path.dirname(snapshot)).mode & 0o777, 0o700);
      assert.equal(fs.lstatSync(snapshot).mode & 0o777, 0o600);
      replace(fixture);
      assert.deepEqual(fs.readFileSync(snapshot), fixture.bytes);
      assert.equal(sha256(snapshot), crypto.createHash('sha256').update(fixture.bytes).digest('hex'));
      return [];
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.equal(fs.existsSync(path.dirname(snapshot)), false);
    assert.equal(fs.existsSync(fixture.contentPath), true);
  });
}

test('release launcher snapshot survives its return through asynchronous Builder success', async t => {
  const fixture = archiveFixture(t);
  let signalStarted;
  let releaseBuild;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const completion = new Promise(resolve => { releaseBuild = resolve; });
  let snapshot;
  let settled = false;
  const pending = invokeFixture(fixture, REQUIRED_ARGS, {}, async options => {
    snapshot = options.config.electronDist;
    signalStarted();
    await completion;
    assert.deepEqual(fs.readFileSync(snapshot), fixture.bytes);
    return [];
  }).then(result => {
    settled = true;
    return result;
  });
  t.after(async () => { releaseBuild(); await pending; });
  await Promise.race([
    started,
    pending.then(result => {
      throw result.error || new Error('Launcher settled before asynchronous Builder completion.');
    }),
  ]);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(fs.existsSync(snapshot), true);
  assert.equal(fs.existsSync(fixture.archive), true);
  releaseBuild();
  const result = await pending;
  assert.equal(result.status, 0);
  assert.equal(result.error, undefined);
  assert.equal(fs.existsSync(path.dirname(snapshot)), false);
  assert.deepEqual(fs.readFileSync(fixture.archive), fixture.bytes);
});

test('release launcher cleans its owned snapshot after asynchronous Builder failure', async t => {
  const fixture = archiveFixture(t);
  const failure = new Error('controlled build cancellation');
  let snapshot;
  const result = await invokeFixture(fixture, REQUIRED_ARGS, {}, async options => {
    snapshot = options.config.electronDist;
    await Promise.resolve();
    assert.equal(fs.existsSync(snapshot), true);
    throw failure;
  });
  assert.equal(result.error, failure);
  assert.equal(fs.existsSync(path.dirname(snapshot)), false);
  assert.deepEqual(fs.readFileSync(fixture.archive), fixture.bytes);
});

for (const change of ['unrelated-file', 'archive-symlink', 'directory-replacement']) {
  test(`release launcher refuses snapshot cleanup after ${change} and preserves unrelated content`, async t => {
    const fixture = archiveFixture(t);
    let directory;
    let unrelated;
    const cleanupRoots = [];
    t.after(() => { for (const root of cleanupRoots) fs.rmSync(root, { recursive: true, force: true }); });
    const result = await invokeFixture(fixture, REQUIRED_ARGS, {}, async options => {
      const snapshot = options.config.electronDist;
      directory = path.dirname(snapshot);
      cleanupRoots.push(directory);
      if (change === 'directory-replacement') {
        fs.renameSync(directory, `${directory}.held`);
        cleanupRoots.push(`${directory}.held`);
        fs.mkdirSync(directory, { mode: 0o700 });
      }
      unrelated = path.join(directory, 'unrelated-fixture');
      fs.writeFileSync(unrelated, 'preserve unrelated content');
      if (change === 'archive-symlink') {
        fs.unlinkSync(snapshot);
        fs.symlinkSync(fixture.archive, snapshot);
        fs.unlinkSync(unrelated); // Isolate the changed-archive guard from the extra-content guard.
        unrelated = fixture.archive;
      }
      return [];
    });
    assert.match(result.error.message, /snapshot cleanup refused/u);
    assert.equal(fs.existsSync(directory), true);
    assert.equal(fs.existsSync(unrelated), true);
    assert.deepEqual(fs.readFileSync(fixture.archive), fixture.bytes);
  });
}

test('locked successful extraction continuation removes only official defaults before product integrity and preserves hooks', async t => {
  const fixture = archiveFixture(t);
  const hookPath = path.join(fixture.root, 'existing-after-extract.cjs');
  fs.writeFileSync(hookPath, `const fs = require('node:fs'); const path = require('node:path');
    module.exports = async context => {
      const resources = path.join(context.appOutDir, 'Electron.app', 'Contents', 'Resources');
      if (fs.existsSync(path.join(resources, 'default_app.asar')) || fs.existsSync(path.join(context.appOutDir, 'version'))) throw new Error('Existing hook must observe standard cleanup.');
      fs.writeFileSync(${JSON.stringify(path.join(fixture.root, 'existing-hook-ran'))}, 'ran');
    };`);
  fixture.manifest.build = { ...require('../package.json').build, afterExtract: hookPath };
  fs.writeFileSync(path.join(fixture.root, 'package.json'), JSON.stringify(fixture.manifest));
  const electronGet = require('app-builder-lib/out/util/electronGet');
  const { createElectronFrameworkSupport } = require('app-builder-lib/out/electron/ElectronFramework');
  const { computeData } = require('app-builder-lib/out/asar/integrity');
  const { getConfig, validateConfiguration } = require('app-builder-lib/out/util/config/config');
  const { Arch, log } = require('builder-util');
  const { Platform } = require('app-builder-lib');
  const { EXPECTED_NESTED_BUNDLE_NAMES, inspectBundleLayout, evaluateReleaseEvidence } = require('../scripts/verify-macos-release-app');
  const originalExtract = electronGet.extractArchive;
  const originalDownload = electronGet.downloadElectronArtifactZip;
  const originalLog = log.info;
  let downloads = 0;
  let snapshot;
  const output = path.join(fixture.root, 'stage');
  const app = path.join(output, 'Electron.app');
  const contents = path.join(app, 'Contents');
  const resources = path.join(contents, 'Resources');
  const frameworkBytes = Buffer.from('controlled expected runtime content');
  electronGet.extractArchive = async (archive, destination) => {
    assert.equal(archive, snapshot);
    assert.deepEqual(fs.readFileSync(archive), fixture.bytes);
    for (const directory of ['Resources', 'MacOS', 'Frameworks', '_CodeSignature']) fs.mkdirSync(path.join(contents, directory), { recursive: true });
    for (const name of [...EXPECTED_NESTED_BUNDLE_NAMES, 'Electron Helper.app', 'Electron Helper (GPU).app', 'Electron Helper (Plugin).app', 'Electron Helper (Renderer).app']) {
      fs.mkdirSync(path.join(contents, 'Frameworks', name));
    }
    fs.writeFileSync(path.join(contents, 'Frameworks', 'Electron Framework.framework', 'runtime'), frameworkBytes);
    fs.writeFileSync(path.join(contents, 'MacOS', 'Electron'), frameworkBytes);
    for (const name of ['CodeResources', 'Info.plist']) fs.writeFileSync(path.join(contents, name), 'controlled metadata');
    fs.writeFileSync(path.join(contents, 'PkgInfo'), 'APPL????');
    fs.writeFileSync(path.join(contents, '_CodeSignature', 'CodeResources'), 'controlled signature placeholder');
    fs.writeFileSync(path.join(resources, 'default_app.asar'), 'official default app fixture');
    fs.writeFileSync(path.join(resources, 'icon.icns'), 'controlled icon');
    fs.mkdirSync(path.join(resources, 'app.asar.unpacked'));
    fs.writeFileSync(path.join(resources, 'app-update.yml'), 'owner: bfeintuch123\nrepo: crate-app\nprovider: github\nupdaterCacheDirName: crate-app-updater\n');
    fs.writeFileSync(path.join(destination, 'version'), '42.10.0');
    fs.writeFileSync(path.join(destination, 'LICENSE'), 'preserve official runtime license');
  };
  electronGet.downloadElectronArtifactZip = async () => { downloads += 1; throw new Error('Downloader is forbidden.'); };
  log.info = () => {};
  try {
    const result = await invokeFixture(fixture, REQUIRED_ARGS, {}, async options => {
      snapshot = options.config.electronDist;
      const config = await getConfig(fixture.root, null, options.config);
      await validateConfiguration(config, { isEnabled: false });
      for (const key of ['afterPack', 'afterSign', 'electronFuses', 'mac', 'asar', 'asarUnpack']) assert.deepEqual(config[key], fixture.manifest.build[key]);
      assert.equal(options.publish, 'never');
      assert.equal(config.npmRebuild, false);
      const packager = { config, projectDir: fixture.root, platform: Platform.MAC };
      const framework = await createElectronFrameworkSupport({ electronVersion: '42.10.0' }, packager);
      await framework.prepareApplicationStageDirectory({ packager, appOutDir: output, platformName: 'darwin', arch: 'arm64' });
      assert.equal(fs.existsSync(path.join(resources, 'default_app.asar')), true);
      assert.equal(fs.existsSync(path.join(output, 'version')), true);
      const retainedBefore = stageInventory(output);
      await config.afterExtract({ packager, appOutDir: output, electronPlatformName: 'darwin', arch: Arch.arm64 });
      assert.equal(fs.existsSync(path.join(resources, 'default_app.asar')), false);
      assert.equal(fs.existsSync(path.join(output, 'version')), false);
      assert.equal(fs.readFileSync(path.join(fixture.root, 'existing-hook-ran'), 'utf8'), 'ran');
      delete retainedBefore['Electron.app/Contents/Resources/default_app.asar'];
      delete retainedBefore.version;
      assert.deepEqual(stageInventory(output), retainedBefore);
      const source = path.join(fixture.root, 'synthetic-product');
      fs.mkdirSync(source);
      fs.writeFileSync(path.join(source, 'package.json'), '{"name":"controlled-product","version":"1.0.0"}');
      const asar = await import('@electron/asar');
      await asar.createPackage(source, path.join(resources, 'app.asar'));
      const integrity = await computeData({ resourcesPath: resources, resourcesRelativePath: 'Resources', resourcesDestinationPath: resources, extraResourceMatchers: [] });
      assert.deepEqual(Object.keys(integrity), ['Resources/app.asar']);
      const evidence = { infoPlist: { ElectronAsarIntegrity: integrity }, asarIntegrityHash: integrity['Resources/app.asar'].hash };
      assert.equal(evaluateReleaseEvidence(evidence).failures.some(message => message.startsWith('Embedded ASAR integrity metadata')), false);
      assert.equal(inspectBundleLayout(app, 'Electron').valid, true);
      const extra = { ...integrity, 'Resources/default_app.asar': integrity['Resources/app.asar'] };
      assert.equal(evaluateReleaseEvidence({ ...evidence, infoPlist: { ElectronAsarIntegrity: extra } }).failures.includes('Embedded ASAR integrity metadata is missing or invalid.'), true);
      fs.writeFileSync(path.join(resources, 'default_app.asar'), 'unexpected retained default');
      assert.equal(inspectBundleLayout(app, 'Electron').valid, false);
      return [];
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.equal(downloads, 0);
    assert.equal(fs.existsSync(path.dirname(snapshot)), false);
  } finally {
    electronGet.extractArchive = originalExtract;
    electronGet.downloadElectronArtifactZip = originalDownload;
    log.info = originalLog;
  }
});

test('local extraction hook rejects a symlink cleanup target without deleting unrelated files', async t => {
  const fixture = archiveFixture(t);
  const { Arch } = require('builder-util');
  let snapshot;
  const result = await invokeFixture(fixture, REQUIRED_ARGS, {}, async options => {
    snapshot = options.config.electronDist;
    const output = path.join(fixture.root, 'unsafe-stage');
    const resources = path.join(output, 'Electron.app', 'Contents', 'Resources');
    fs.mkdirSync(resources, { recursive: true });
    fs.writeFileSync(path.join(output, 'version'), '42.10.0');
    fs.symlinkSync(fixture.archive, path.join(resources, 'default_app.asar'));
    await options.config.afterExtract({ appOutDir: output, electronPlatformName: 'darwin', arch: Arch.arm64, packager: { config: options.config } });
    throw new Error('Unsafe hook must not complete.');
  });
  assert.match(result.error.message, /cleanup target is invalid/u);
  assert.deepEqual(fs.readFileSync(fixture.archive), fixture.bytes);
  assert.equal(fs.readFileSync(path.join(fixture.root, 'unsafe-stage', 'version'), 'utf8'), '42.10.0');
  assert.equal(fs.existsSync(path.dirname(snapshot)), false);
});

test('local extraction hook preserves an existing asynchronous hook failure and cleans the snapshot', async t => {
  const fixture = archiveFixture(t);
  const hook = path.join(fixture.root, 'failing-after-extract.cjs');
  fs.writeFileSync(hook, "module.exports = async () => { await Promise.resolve(); throw new Error('controlled existing hook failure'); };");
  fixture.manifest.build.afterExtract = hook;
  fs.writeFileSync(path.join(fixture.root, 'package.json'), JSON.stringify(fixture.manifest));
  const { Arch } = require('builder-util');
  let snapshot;
  const result = await invokeFixture(fixture, REQUIRED_ARGS, {}, async options => {
    snapshot = options.config.electronDist;
    const output = path.join(fixture.root, 'hook-failure-stage');
    const resources = path.join(output, 'Electron.app', 'Contents', 'Resources');
    fs.mkdirSync(resources, { recursive: true });
    fs.writeFileSync(path.join(resources, 'default_app.asar'), 'official default app fixture');
    fs.writeFileSync(path.join(output, 'version'), '42.10.0');
    await options.config.afterExtract({ appOutDir: output, electronPlatformName: 'darwin', arch: Arch.arm64, packager: { config: options.config } });
    throw new Error('Existing hook failure must propagate.');
  });
  assert.equal(result.error.message, 'controlled existing hook failure');
  assert.equal(fs.existsSync(path.join(fixture.root, 'hook-failure-stage', 'version')), false);
  assert.equal(fs.existsSync(path.dirname(snapshot)), false);
  assert.deepEqual(fs.readFileSync(fixture.archive), fixture.bytes);
});

test('locked extraction fails without a downloader if the private ZIP disappears before extraction', async t => {
  const fixture = archiveFixture(t);
  const electronGet = require('app-builder-lib/out/util/electronGet');
  const { createElectronFrameworkSupport } = require('app-builder-lib/out/electron/ElectronFramework');
  const originalDownload = electronGet.downloadElectronArtifactZip;
  let downloads = 0;
  let snapshot;
  electronGet.downloadElectronArtifactZip = async () => { downloads += 1; throw new Error('Downloader is forbidden.'); };
  try {
    const result = await invokeFixture(fixture, REQUIRED_ARGS, {}, async options => {
      snapshot = options.config.electronDist;
      fs.unlinkSync(snapshot);
      const packager = { config: options.config, projectDir: fixture.root };
      const framework = await createElectronFrameworkSupport({ electronVersion: '42.10.0' }, packager);
      await framework.prepareApplicationStageDirectory({ packager, appOutDir: path.join(fixture.root, 'unused-stage'), platformName: 'darwin', arch: 'arm64' });
    });
    assert.match(result.error.message, /specified electronDist does not exist/u);
    assert.equal(downloads, 0);
    assert.equal(fs.existsSync(path.dirname(snapshot)), false);
    assert.equal(fs.existsSync(path.join(fixture.root, 'unused-stage')), false);
  } finally { electronGet.downloadElectronArtifactZip = originalDownload; }
});

test('release launcher authenticates the retained real Electron ZIP when explicitly supplied for focused validation', {
  skip: !process.env.CRATE_TEST_RETAINED_ELECTRON_ARCHIVE,
}, () => {
  const archive = process.env.CRATE_TEST_RETAINED_ELECTRON_ARCHIVE;
  assert.equal(sha256(archive), '89713813621bfcc60fdb8eaba13b6ca42ea859721f65273370228174146f546c');
  const authenticated = authenticateElectronArchive(archive);
  assert.equal(authenticated.digest, '89713813621bfcc60fdb8eaba13b6ca42ea859721f65273370228174146f546c');
  assert.equal(crypto.createHash('sha256').update(authenticated.bytes).digest('hex'), authenticated.digest);
});

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
