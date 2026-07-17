'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const USAGE = 'Usage: node scripts/run-electron-builder-release.js --mac --arm64 --config.npmRebuild=false';
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

function run(argv = process.argv.slice(2), env = process.env) {
  if (argv.length !== 3 || argv[0] !== '--mac' || argv[1] !== '--arm64' ||
      argv[2] !== '--config.npmRebuild=false') {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  authenticateReleaseProcess(env);
  forceTraversalCollector();
  require('../node_modules/electron-builder/out/cli/cli.js');
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = run();
  } catch {
    process.stderr.write('Crate release build environment validation failed.\n');
    process.exitCode = 1;
  }
}

module.exports = {
  REQUIRED_ENV,
  USAGE,
  authenticateNode,
  authenticateReleaseProcess,
  forceTraversalCollector,
  run,
  sha256,
};
