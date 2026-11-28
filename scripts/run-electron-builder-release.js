'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REQUIRED_ARGS = Object.freeze([
  '--mac',
  '--arm64',
  '--config.npmRebuild=false',
  '--config.publish.provider=github',
  '--config.publish.owner=bfeintuch123',
  '--config.publish.repo=crate-app',
  '--publish',
  'never',
]);
const USAGE = `Usage: node scripts/run-electron-builder-release.js ${REQUIRED_ARGS.join(' ')}`;
const REQUIRED_ENV = Object.freeze([
  'CRATE_RELEASE_CANONICAL_NODE',
  'CRATE_RELEASE_CANONICAL_NODE_SHA256',
]);

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function isInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function authenticateNode(filePath, expectedDigest) {
  if (!path.isAbsolute(filePath) || /[\r\n]/u.test(filePath) || !/^[a-f0-9]{64}$/u.test(expectedDigest)) {
    throw new Error('Release Node authentication input is invalid.');
  }
  const metadata = fs.lstatSync(filePath);
  const realPath = fs.realpathSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || realPath !== filePath ||
      (metadata.mode & 0o111) === 0 || sha256(realPath) !== expectedDigest) {
    throw new Error('Release Node authentication failed.');
  }
  return realPath;
}

function authenticateReleaseProcess(env = process.env, { currentExecutable = process.execPath } = {}) {
  for (const name of REQUIRED_ENV) {
    if (typeof env[name] !== 'string' || env[name] === '') {
      throw new Error('Release build environment is incomplete.');
    }
  }
  const canonicalNode = authenticateNode(
    env.CRATE_RELEASE_CANONICAL_NODE,
    env.CRATE_RELEASE_CANONICAL_NODE_SHA256
  );
  const projectRoot = fs.realpathSync(path.join(__dirname, '..'));
  if (isInside(projectRoot, canonicalNode) || fs.realpathSync(currentExecutable) !== canonicalNode ||
      sha256(currentExecutable) !== env.CRATE_RELEASE_CANONICAL_NODE_SHA256) {
    throw new Error('Release launcher is not running under the authenticated Node executable.');
  }
  return canonicalNode;
}

function forceTraversalCollector() {
  const { Lazy } = require('lazy-val');
  const collector = require('app-builder-lib/out/node-module-collector');
  const packageManager = require('app-builder-lib/out/node-module-collector/packageManager.js');
  if (collector.__crateReleaseTraversalOnly === true) {
    return collector.determinePackageManagerEnv;
  }
  if (!collector.PM || collector.PM.TRAVERSAL !== 'traversal' || packageManager.PM.TRAVERSAL !== 'traversal') {
    throw new Error('Electron Builder traversal collector is unavailable.');
  }
  const traversalOnly = () => new Lazy(async () => ({
    pm: collector.PM.TRAVERSAL,
    workspaceRoot: Promise.resolve(undefined),
  }));
  Object.defineProperty(collector, 'determinePackageManagerEnv', {
    configurable: false,
    enumerable: true,
    value: traversalOnly,
    writable: false,
  });
  Object.defineProperty(collector, '__crateReleaseTraversalOnly', {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  const originalGetCommand = packageManager.getPackageManagerCommand;
  Object.defineProperty(packageManager, 'getPackageManagerCommand', {
    configurable: false,
    enumerable: true,
    value(pm) {
      if (pm === packageManager.PM.NPM) {
        throw new Error('Release build blocked an unexpected npm subprocess.');
      }
      return originalGetCommand(pm);
    },
    writable: false,
  });
  return traversalOnly;
}

function releaseArgsAreExact(argv) {
  return Array.isArray(argv) && argv.length === REQUIRED_ARGS.length &&
    argv.every((argument, index) => argument === REQUIRED_ARGS[index]);
}

function readStableReleaseFile(filePath) {
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink() || fs.realpathSync(filePath) !== filePath) {
    throw new Error('Release archive authentication input is invalid.');
  }
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    const current = fs.lstatSync(filePath);
    const fields = ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'];
    if (!opened.isFile() || fields.some(field => before[field] !== opened[field] ||
        opened[field] !== after[field] || after[field] !== current[field]) ||
        !current.isFile() || current.isSymbolicLink() || bytes.length !== opened.size) {
      throw new Error('Release archive authentication input changed.');
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function authenticateElectronArchive(archivePath, projectRoot = fs.realpathSync(path.join(__dirname, '..'))) {
  if (typeof archivePath !== 'string' || !path.isAbsolute(archivePath) || /[\r\n]/u.test(archivePath)) {
    throw new Error('Release Electron archive path is invalid.');
  }
  const manifest = JSON.parse(readStableReleaseFile(path.join(projectRoot, 'package.json')));
  const lock = JSON.parse(readStableReleaseFile(path.join(projectRoot, 'package-lock.json')));
  const metadata = lock.packages?.['node_modules/electron'];
  const version = metadata?.version;
  const electronRoot = path.join(projectRoot, 'node_modules', 'electron');
  if (!/^\d+\.\d+\.\d+$/u.test(version || '') ||
      manifest.devDependencies?.electron !== lock.packages?.['']?.devDependencies?.electron ||
      ['electronDist', 'electronVersion', 'electronDownload'].some(key => Object.hasOwn(manifest.build || {}, key)) ||
      fs.realpathSync(electronRoot) !== electronRoot || !fs.lstatSync(electronRoot).isDirectory()) {
    throw new Error('Release Electron archive configuration is invalid.');
  }
  const archiveName = `electron-v${version}-darwin-arm64.zip`;
  if (path.basename(archivePath) !== archiveName) {
    throw new Error('Release Electron archive identity does not match the lockfile.');
  }
  const checksumPath = path.join(electronRoot, 'checksums.json');
  const checksumBytes = readStableReleaseFile(checksumPath);
  const { installedPackageMatchesLockArchive } = require('./verify-macos-release-app');
  if (!installedPackageMatchesLockArchive(electronRoot, 'electron', metadata) ||
      !checksumBytes.equals(readStableReleaseFile(checksumPath))) {
    throw new Error('Release Electron checksum package authentication failed.');
  }
  const electronManifest = JSON.parse(readStableReleaseFile(path.join(electronRoot, 'package.json')));
  const expectedDigest = JSON.parse(checksumBytes)[archiveName];
  const bytes = readStableReleaseFile(archivePath);
  if (electronManifest.name !== 'electron' || electronManifest.version !== version ||
      typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedDigest) ||
      crypto.createHash('sha256').update(bytes).digest('hex') !== expectedDigest) {
    throw new Error('Release Electron archive authentication failed.');
  }
  return { bytes, archiveName, digest: expectedDigest, manifest, version };
}

function createElectronSnapshot(authenticated) {
  const tempRoot = fs.realpathSync(process.env.TMPDIR || os.tmpdir());
  const directory = fs.mkdtempSync(path.join(tempRoot, 'crate-electron-release-'));
  fs.chmodSync(directory, 0o700);
  const directoryIdentity = fs.lstatSync(directory);
  const archivePath = path.join(directory, authenticated.archiveName);
  let fileIdentity;
  const sameIdentity = (current, expected) => current.dev === expected.dev && current.ino === expected.ino;
  const cleanup = () => {
    const currentDirectory = fs.lstatSync(directory);
    if (!currentDirectory.isDirectory() || currentDirectory.isSymbolicLink() ||
        fs.realpathSync(directory) !== directory || !sameIdentity(currentDirectory, directoryIdentity) ||
        (currentDirectory.mode & 0o777) !== 0o700) {
      throw new Error('Release Electron snapshot cleanup refused an unexpected directory.');
    }
    const entries = fs.readdirSync(directory);
    if (entries.length === 0) {
      fs.rmdirSync(directory);
      return;
    }
    if (entries.length !== 1 || entries[0] !== authenticated.archiveName || !fileIdentity) {
      throw new Error('Release Electron snapshot cleanup refused unexpected contents.');
    }
    const currentFile = fs.lstatSync(archivePath);
    if (!currentFile.isFile() || currentFile.isSymbolicLink() || !sameIdentity(currentFile, fileIdentity) ||
        (currentFile.mode & 0o777) !== 0o600 || sha256(archivePath) !== authenticated.digest) {
      throw new Error('Release Electron snapshot cleanup refused a changed archive.');
    }
    fs.unlinkSync(archivePath);
    fs.rmdirSync(directory);
  };
  try {
    // Write exactly the already-authenticated bytes, never reopen the caller's ZIP.
    fs.writeFileSync(archivePath, authenticated.bytes, { flag: 'wx', mode: 0o600 });
    fileIdentity = fs.lstatSync(archivePath);
    if (fs.realpathSync(archivePath) !== archivePath || !fileIdentity.isFile() ||
        (fileIdentity.mode & 0o777) !== 0o600 ||
        crypto.createHash('sha256').update(readStableReleaseFile(archivePath)).digest('hex') !== authenticated.digest) {
      throw new Error('Release Electron snapshot authentication failed.');
    }
    return { archivePath, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

function cleanOfficialElectronDistribution(context, version, snapshotPath) {
  const { Arch } = require('builder-util');
  const output = context.appOutDir;
  if (context.electronPlatformName !== 'darwin' || context.arch !== Arch.arm64 ||
      context.packager.config.electronDist !== snapshotPath || !path.isAbsolute(output) ||
      fs.realpathSync(output) !== output) {
    throw new Error('Release Electron cleanup context is invalid.');
  }
  const resources = path.join(output, 'Electron.app', 'Contents', 'Resources');
  for (const directory of [output, path.join(output, 'Electron.app'), path.join(output, 'Electron.app', 'Contents'), resources]) {
    const metadata = fs.lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
      throw new Error('Release Electron cleanup directory is invalid.');
    }
  }
  const targets = [path.join(resources, 'default_app.asar'), path.join(output, 'version')];
  const identities = targets.map(filePath => {
    try {
      const metadata = fs.lstatSync(filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || fs.realpathSync(filePath) !== filePath ||
          (filePath === targets[1] && readStableReleaseFile(filePath).toString('utf8') !== version)) {
        throw new Error('Release Electron cleanup target is invalid.');
      }
      return metadata;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  });
  targets.forEach((filePath, index) => {
    if (!identities[index]) return;
    const current = fs.lstatSync(filePath);
    if (!current.isFile() || current.isSymbolicLink() ||
        current.dev !== identities[index].dev || current.ino !== identities[index].ino) {
      throw new Error('Release Electron cleanup target changed.');
    }
    fs.unlinkSync(filePath);
  });
}

function realDirectoryOrNull(directoryPath) {
  try {
    const metadata = fs.lstatSync(directoryPath);
    if (metadata.isSymbolicLink() || !metadata.isDirectory() ||
        fs.realpathSync(directoryPath) !== directoryPath) {
      throw new Error('Release native helper directory is invalid.');
    }
    return metadata;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Compiles the committed Swift sources with the verifier's exact recipe and
// writes only the fresh bytes to native/bin/crate-helper for extraResources.
function stageNativeHelper(projectRoot, options = {}) {
  const {
    NATIVE_HELPER_SOURCE_DIR,
    NATIVE_HELPER_SOURCE_FILES,
    compileNativeHelper,
  } = require('./verify-macos-release-app');
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot) ||
      fs.realpathSync(projectRoot) !== projectRoot) {
    throw new Error('Release native helper project root is invalid.');
  }
  const sourceDirectory = path.join(projectRoot, ...NATIVE_HELPER_SOURCE_DIR.split('/'));
  if (!realDirectoryOrNull(sourceDirectory)) {
    throw new Error('Release native helper sources are missing.');
  }
  const sourceNames = fs.readdirSync(sourceDirectory).sort();
  const expectedNames = [...NATIVE_HELPER_SOURCE_FILES].sort();
  if (sourceNames.length !== expectedNames.length ||
      !sourceNames.every((name, index) => name === expectedNames[index])) {
    throw new Error('Release native helper sources do not match the approved file set.');
  }
  const sourceBytesByName = {};
  for (const name of NATIVE_HELPER_SOURCE_FILES) {
    sourceBytesByName[name] = readStableReleaseFile(path.join(sourceDirectory, name));
  }
  const compile = options.compileNativeHelper || compileNativeHelper;
  const compiled = compile(sourceBytesByName, { commandRunner: options.commandRunner });
  if (!Buffer.isBuffer(compiled) || compiled.length === 0) {
    throw new Error('Release native helper compilation failed.');
  }
  const compiledDigest = crypto.createHash('sha256').update(compiled).digest('hex');

  const binDirectory = path.join(projectRoot, 'native', 'bin');
  if (!realDirectoryOrNull(path.join(projectRoot, 'native'))) {
    throw new Error('Release native helper directory is invalid.');
  }
  if (!realDirectoryOrNull(binDirectory)) {
    fs.mkdirSync(binDirectory, { mode: 0o755 });
    fs.chmodSync(binDirectory, 0o755);
    if (!realDirectoryOrNull(binDirectory)) {
      throw new Error('Release native helper directory is invalid.');
    }
  }
  const outputPath = path.join(binDirectory, 'crate-helper');
  let existing = null;
  try {
    existing = fs.lstatSync(outputPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error('Release native helper output is not a regular file.');
    }
    fs.unlinkSync(outputPath);
  }
  const descriptor = fs.openSync(
    outputPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o755
  );
  try {
    fs.writeFileSync(descriptor, compiled);
    // Set the exact packaged mode regardless of the caller's umask.
    fs.fchmodSync(descriptor, 0o755);
  } finally {
    fs.closeSync(descriptor);
  }
  const written = readStableReleaseFile(outputPath);
  const writtenMetadata = fs.lstatSync(outputPath);
  if ((writtenMetadata.mode & 0o7777) !== 0o755 ||
      crypto.createHash('sha256').update(written).digest('hex') !== compiledDigest) {
    throw new Error('Release native helper output verification failed.');
  }
  return { path: outputPath, digest: compiledDigest, bytes: written.length };
}

async function runLocalRelease(argv, authenticated, projectRoot) {
  const snapshot = createElectronSnapshot(authenticated);
  try {
    forceTraversalCollector();
    const builder = require('electron-builder/out/builder');
    const { resolveFunction } = require('app-builder-lib/out/util/resolve');
    const existingHook = await resolveFunction(authenticated.manifest.type,
      authenticated.manifest.build?.afterExtract, 'afterExtract', projectRoot);
    if (existingHook != null && typeof existingHook !== 'function') {
      throw new Error('Release Electron extraction hook is invalid.');
    }
    const parser = builder.createYargs();
    builder.configureBuildCommand(parser);
    const options = builder.normalizeOptions(parser.parse(argv));
    options.projectDir = projectRoot;
    options.config.electronDist = snapshot.archivePath;
    options.config.afterExtract = async context => {
      cleanOfficialElectronDistribution(context, authenticated.version, snapshot.archivePath);
      if (existingHook) await existingHook(context);
    };
    // The supported API returns the complete asynchronous build lifetime.
    await builder.build(options);
    return 0;
  } finally {
    snapshot.cleanup();
  }
}

function run(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  if (!releaseArgsAreExact(argv)) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  authenticateReleaseProcess(env);
  const projectRoot = fs.realpathSync(path.join(__dirname, '..'));
  // Stage the freshly compiled helper before any Builder route can copy extraResources.
  (dependencies.stageNativeHelper || stageNativeHelper)(projectRoot);
  if (Object.hasOwn(env, 'CRATE_RELEASE_ELECTRON_ARCHIVE')) {
    if (fs.realpathSync(process.cwd()) !== projectRoot) {
      throw new Error('Release Electron archive requires the canonical project directory.');
    }
    const authenticated = authenticateElectronArchive(env.CRATE_RELEASE_ELECTRON_ARCHIVE, projectRoot);
    return runLocalRelease(argv, authenticated, projectRoot);
  }
  forceTraversalCollector();
  require('../node_modules/electron-builder/out/cli/cli.js');
  return 0;
}

if (require.main === module) {
  const fail = () => {
    process.stderr.write('Crate release build environment validation failed.\n');
    process.exitCode = 1;
  };
  try {
    Promise.resolve(run()).then(status => { process.exitCode = status; }, fail);
  } catch {
    fail();
  }
}

module.exports = {
  REQUIRED_ARGS,
  REQUIRED_ENV,
  USAGE,
  authenticateNode,
  authenticateElectronArchive,
  authenticateReleaseProcess,
  forceTraversalCollector,
  releaseArgsAreExact,
  run,
  sha256,
  stageNativeHelper,
};
