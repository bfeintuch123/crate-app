'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const AUTHENTICATED_SOURCE_FILES = Object.freeze([
  'package.json',
  'package-lock.json',
  'scripts/install-approved-canvas-prebuild.js',
  'scripts/patch-helper-info-plists.js',
  'scripts/run-macos-release-proof.js',
  'scripts/verify-app-contents.js',
  'scripts/verify-install-scripts.js',
  'scripts/verify-macos-release-app.js',
]);
const SAFE_GIT_ARGUMENT_PREFIX = Object.freeze([
  '--no-optional-locks',
  '--no-replace-objects',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
]);

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_OPTIONAL_LOCKS: '0',
      HOME: process.env.HOME || '/var/empty',
      LANG: 'C',
      LC_ALL: 'C',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      TMPDIR: process.env.TMPDIR || os.tmpdir(),
    },
    input: options.input,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function gitCommand(commandRunner, args, options = {}) {
  return commandRunner('/usr/bin/git', [...SAFE_GIT_ARGUMENT_PREFIX, ...args], options);
}

function readStableRegularFile(filePath) {
  let descriptor = null;
  try {
    const pathMetadata = fs.lstatSync(filePath);
    if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()) return null;
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.dev !== pathMetadata.dev || before.ino !== pathMetadata.ino) {
      return null;
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs || bytes.length !== before.size) {
      return null;
    }
    return bytes;
  } catch (error) {
    return null;
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch (error) {
        // Authentication fails closed if the stable read cannot finish.
      }
    }
  }
}

function expectedRevisionFromArguments(argv) {
  const index = argv.indexOf('--expected-revision');
  if (index === -1) return null;
  const revision = String(argv[index + 1] || '').toLowerCase();
  return /^[a-f0-9]{40}$/u.test(revision) ? revision : null;
}

function graftFileAbsentOrEmpty(graftPath) {
  try {
    const metadata = fs.lstatSync(graftPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) return false;
    const bytes = readStableRegularFile(graftPath);
    return bytes !== null && bytes.length === 0;
  } catch (error) {
    return error && error.code === 'ENOENT';
  }
}

function sourceFilesMatchRevision(sourceRoot, expectedRevision, commandRunner = runCommand) {
  if (!/^[a-f0-9]{40}$/u.test(String(expectedRevision || ''))) return false;
  let canonicalRoot;
  try {
    const metadata = fs.lstatSync(sourceRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) return false;
    canonicalRoot = fs.realpathSync(sourceRoot);
  } catch (error) {
    return false;
  }
  const git = (args, options = {}) => gitCommand(commandRunner, args, {
    ...options,
    cwd: canonicalRoot,
  });
  const topLevel = git(['rev-parse', '--show-toplevel']);
  const head = git(['rev-parse', '--verify', 'HEAD^{commit}']);
  const replacements = git(['replace', '-l']);
  const graftPathResult = git(['rev-parse', '--git-path', 'info/grafts']);
  const statusBefore = git(['status', '--porcelain=v1', '--untracked-files=all']);
  let reportedTopLevel = '';
  try {
    reportedTopLevel = topLevel.ok
      ? fs.realpathSync(String(topLevel.stdout || '').trim())
      : '';
  } catch (error) {
    reportedTopLevel = '';
  }
  const graftPath = graftPathResult.ok
    ? path.resolve(canonicalRoot, String(graftPathResult.stdout || '').trim())
    : '';
  if (!topLevel.ok || !head.ok || !replacements.ok || !graftPathResult.ok ||
      !statusBefore.ok || !graftPath || !graftFileAbsentOrEmpty(graftPath) ||
      reportedTopLevel !== canonicalRoot ||
      String(head.stdout || '').trim().toLowerCase() !== expectedRevision ||
      String(replacements.stdout || '').trim() ||
      String(statusBefore.stdout || '').trim()) {
    return false;
  }
  for (const relativePath of AUTHENTICATED_SOURCE_FILES) {
    const bytes = readStableRegularFile(path.join(canonicalRoot, relativePath));
    const treeEntry = git(['ls-tree', expectedRevision, '--', relativePath]);
    const object = bytes && git(['hash-object', '--stdin'], { input: bytes });
    const match = treeEntry.ok && String(treeEntry.stdout || '').trim().match(
      /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u
    );
    if (!bytes || !object || !object.ok || !match || match[3] !== relativePath ||
        String(object.stdout || '').trim().toLowerCase() !== match[2]) {
      return false;
    }
  }
  const statusAfter = git(['status', '--porcelain=v1', '--untracked-files=all']);
  const finalHead = git(['rev-parse', '--verify', 'HEAD^{commit}']);
  const finalGraftPathResult = git(['rev-parse', '--git-path', 'info/grafts']);
  const finalGraftPath = finalGraftPathResult.ok
    ? path.resolve(canonicalRoot, String(finalGraftPathResult.stdout || '').trim())
    : '';
  return statusAfter.ok && !String(statusAfter.stdout || '').trim() &&
    finalHead.ok && String(finalHead.stdout || '').trim().toLowerCase() === expectedRevision &&
    finalGraftPath === graftPath && graftFileAbsentOrEmpty(finalGraftPath);
}

async function runBootstrap(argv = process.argv.slice(2), dependencies = {}) {
  const writeOutput = dependencies.writeOutput || (message => console.log(message));
  const writeError = dependencies.writeError || (message => console.error(message));
  const setExitCode = dependencies.setExitCode || (code => { process.exitCode = code; });
  try {
    const sourceRoot = path.resolve(dependencies.sourceRoot || path.resolve(__dirname, '..'));
    const suppliedRevision = expectedRevisionFromArguments(argv);
    const revisionResult = suppliedRevision
      ? { ok: true, stdout: suppliedRevision }
      : gitCommand(dependencies.commandRunner || runCommand, [
        'rev-parse',
        '--verify',
        'HEAD^{commit}',
      ], { cwd: sourceRoot });
    const revision = revisionResult.ok
      ? String(revisionResult.stdout || '').trim().toLowerCase()
      : '';
    const verifySource = dependencies.verifySource || sourceFilesMatchRevision;
    if (!verifySource(sourceRoot, revision, dependencies.commandRunner || runCommand)) {
      throw new Error('untrusted verifier');
    }
    const loadVerifier = dependencies.loadVerifier ||
      (() => require('./verify-macos-release-app'));
    const verifier = loadVerifier();
    if (!verifier || typeof verifier.runCli !== 'function' ||
        typeof verifier.authenticateVerifierToolchain !== 'function') {
      throw new Error('invalid verifier');
    }
    const toolchain = verifier.authenticateVerifierToolchain(sourceRoot, {
      npmCacheRoot: dependencies.npmCacheRoot || process.env.npm_config_cache,
      ...(dependencies.verifierToolchainOptions || {}),
    });
    if (!toolchain || toolchain.valid !== true || !toolchain.tools ||
        typeof toolchain.recheck !== 'function') {
      throw new Error('untrusted verifier toolchain');
    }
    const bufferedOutput = [];
    const bufferedErrors = [];
    const result = await verifier.runCli(argv, {
      ...(dependencies.verifierDependencies || {}),
      asar: toolchain.tools.asar,
      getFuseWire: toolchain.tools.getFuseWire,
      setExitCode() {},
      writeError: message => bufferedErrors.push(String(message)),
      writeOutput: message => bufferedOutput.push(String(message)),
    });
    if (!toolchain.recheck() ||
        !verifySource(sourceRoot, revision, dependencies.commandRunner || runCommand)) {
      throw new Error('verifier toolchain changed');
    }
    for (const message of bufferedOutput) writeOutput(message);
    for (const message of bufferedErrors) writeError(message);
    if (result && Number.isInteger(result.exitCode) && result.exitCode !== 0) {
      setExitCode(result.exitCode);
    }
    return result;
  } catch (error) {
    writeError('Crate signed-app policy failed.');
    setExitCode(1);
    return { exitCode: 1, result: null };
  }
}

if (require.main === module) {
  runBootstrap();
}

module.exports = {
  AUTHENTICATED_SOURCE_FILES,
  SAFE_GIT_ARGUMENT_PREFIX,
  expectedRevisionFromArguments,
  runBootstrap,
  sourceFilesMatchRevision,
};
