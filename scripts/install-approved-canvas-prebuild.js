'use strict';

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const APPROVED_CANVAS_PREBUILD_FILES = Object.freeze([
  'build/Makefile',
  'build/Release/canvas.node',
  'build/Release/libX11.6.dylib',
  'build/Release/libXau.6.dylib',
  'build/Release/libXdmcp.6.dylib',
  'build/Release/libXext.6.dylib',
  'build/Release/libXrender.1.dylib',
  'build/Release/libcairo-gobject.2.dylib',
  'build/Release/libcairo.2.dylib',
  'build/Release/libfontconfig.1.dylib',
  'build/Release/libfreetype.6.dylib',
  'build/Release/libfribidi.0.dylib',
  'build/Release/libgdk_pixbuf-2.0.0.dylib',
  'build/Release/libgif.7.2.0.dylib',
  'build/Release/libgio-2.0.0.dylib',
  'build/Release/libglib-2.0.0.dylib',
  'build/Release/libgmodule-2.0.0.dylib',
  'build/Release/libgobject-2.0.0.dylib',
  'build/Release/libgraphite2.3.2.1.dylib',
  'build/Release/libharfbuzz.0.dylib',
  'build/Release/libintl.8.dylib',
  'build/Release/libjpeg.8.3.2.dylib',
  'build/Release/libpango-1.0.0.dylib',
  'build/Release/libpangocairo-1.0.0.dylib',
  'build/Release/libpangoft2-1.0.0.dylib',
  'build/Release/libpcre2-8.0.dylib',
  'build/Release/libpixman-1.0.dylib',
  'build/Release/libpng16.16.dylib',
  'build/Release/librsvg-2.2.dylib',
  'build/Release/libxcb-render.0.0.0.dylib',
  'build/Release/libxcb-shm.0.0.0.dylib',
  'build/Release/libxcb.1.1.0.dylib',
  'build/binding.Makefile',
  'build/canvas.target.mk',
  'build/config.gypi',
  'build/gyp-mac-tool',
]);

const APPROVED_CANVAS_PREBUILD_DIRECTORIES = Object.freeze([
  'build/',
  'build/Release/',
]);

const APPROVED_CANVAS_PREBUILD = Object.freeze({
  fileName: 'canvas-v3.2.1-napi-v7-darwin-arm64.tar.gz',
  sha256: '01cc7a369a76cf5b1df94958b24c93202525e6eac9782aaa816c167527ccd140',
  size: 6865565,
  url: 'https://github.com/Automattic/node-canvas/releases/download/v3.2.1/canvas-v3.2.1-napi-v7-darwin-arm64.tar.gz',
});

const APPROVED_CANVAS_PREBUILD_ENTRIES = Object.freeze([
  ...APPROVED_CANVAS_PREBUILD_DIRECTORIES,
  ...APPROVED_CANVAS_PREBUILD_FILES,
].sort());

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function approvedPolicy(options = {}) {
  return options.policy || {
    entries: APPROVED_CANVAS_PREBUILD_ENTRIES,
    files: APPROVED_CANVAS_PREBUILD_FILES,
    sha256: APPROVED_CANVAS_PREBUILD.sha256,
    size: APPROVED_CANVAS_PREBUILD.size,
  };
}

function runFileResult(runFile, command, args) {
  try {
    const stdout = runFile(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: String(stdout || '') };
  } catch (error) {
    return { ok: false, stdout: '' };
  }
}

function readAuthenticatedArchive(archivePath, policy) {
  let descriptor = null;
  try {
    descriptor = fs.openSync(
      archivePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size !== policy.size) return null;
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs || bytes.length !== policy.size ||
        sha256Bytes(bytes) !== policy.sha256) {
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
        // Authentication has already failed closed if descriptor cleanup is unusual.
      }
    }
  }
}

function directoryIdentity(directoryPath) {
  try {
    const metadata = fs.lstatSync(directoryPath);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) return null;
    return {
      dev: metadata.dev,
      ino: metadata.ino,
      realpath: fs.realpathSync(directoryPath),
    };
  } catch (error) {
    return null;
  }
}

function directoryIdentityMatches(directoryPath, expected) {
  const actual = directoryIdentity(directoryPath);
  return Boolean(actual && expected && actual.dev === expected.dev && actual.ino === expected.ino);
}

function pathIsAbsent(targetPath) {
  try {
    fs.lstatSync(targetPath);
    return false;
  } catch (error) {
    if (error && error.code === 'ENOENT') return true;
    throw error;
  }
}

function cleanupAuthenticatedTemporaryRoot(temporaryRoot, identity, policy, options = {}) {
  try {
    if (typeof options.beforeTemporaryCleanup === 'function') {
      options.beforeTemporaryCleanup(temporaryRoot);
    }
    if (!directoryIdentityMatches(temporaryRoot, identity)) return false;
    const quarantineRoot = path.join(
      path.dirname(temporaryRoot),
      `.crate-canvas-cleanup-${crypto.randomUUID()}`
    );
    if (!pathIsAbsent(quarantineRoot)) return false;
    fs.renameSync(temporaryRoot, quarantineRoot);
    if (!pathIsAbsent(temporaryRoot) || !directoryIdentityMatches(quarantineRoot, identity)) {
      return false;
    }
    fs.rmSync(quarantineRoot, { recursive: true, force: false });
    return pathIsAbsent(quarantineRoot);
  } catch (error) {
    return false;
  }
}

function withAuthenticatedArchive(archivePath, options, callback) {
  const policy = approvedPolicy(options);
  const bytes = readAuthenticatedArchive(archivePath, policy);
  if (!bytes) return false;
  const temporaryParent = options.temporaryParent || os.tmpdir();
  let temporaryRoot = null;
  let temporaryIdentity = null;
  let result = false;
  try {
    const temporaryParentMetadata = fs.lstatSync(temporaryParent);
    if (temporaryParentMetadata.isSymbolicLink() || !temporaryParentMetadata.isDirectory()) {
      throw new Error('invalid');
    }
    temporaryRoot = fs.mkdtempSync(path.join(
      fs.realpathSync(temporaryParent),
      '.crate-canvas-prebuild-'
    ));
    temporaryIdentity = directoryIdentity(temporaryRoot);
    if (!temporaryIdentity) throw new Error('invalid');
    const stableArchive = path.join(temporaryRoot, 'approved.tar.gz');
    fs.writeFileSync(stableArchive, bytes, { flag: 'wx', mode: 0o600 });
    const stableMetadata = fs.lstatSync(stableArchive);
    if (stableMetadata.isSymbolicLink() || !stableMetadata.isFile() ||
        (stableMetadata.mode & 0o077) !== 0) {
      throw new Error('invalid');
    }
    result = callback(stableArchive, temporaryRoot, policy) === true;
  } catch (error) {
    result = false;
  }
  if (temporaryRoot && !cleanupAuthenticatedTemporaryRoot(
    temporaryRoot,
    temporaryIdentity,
    policy,
    options
  )) {
    return false;
  }
  return result;
}

function approvedArchiveInventoryMatches(stableArchive, options, policy) {
  const runFile = options.execFileSync || execFileSync;
  try {
    const listing = runFileResult(runFile, '/usr/bin/tar', ['-tzf', stableArchive]);
    const verbose = runFileResult(runFile, '/usr/bin/tar', ['-tvzf', stableArchive]);
    if (!listing.ok || !verbose.ok) return false;
    const entries = listing.stdout.trim().split(/\r?\n/u).filter(Boolean);
    const verboseEntries = verbose.stdout.trim().split(/\r?\n/u).filter(Boolean);
    if (entries.length !== new Set(entries).size || entries.length !== verboseEntries.length ||
        verboseEntries.some(line => line[0] !== '-' && line[0] !== 'd')) {
      return false;
    }
    return isDeepStrictEqual([...entries].sort(), [...policy.entries].sort());
  } catch (error) {
    return false;
  }
}

function inspectApprovedCanvasPrebuild(archivePath, options = {}) {
  return withAuthenticatedArchive(
    archivePath,
    options,
    (stableArchive, temporaryRoot, policy) =>
      approvedArchiveInventoryMatches(stableArchive, options, policy)
  );
}

function collectExtractedTree(rootPath) {
  const directories = [];
  const files = [];
  const pending = [{ absolutePath: rootPath, relativePath: '' }];
  try {
    while (pending.length > 0) {
      const current = pending.pop();
      for (const name of fs.readdirSync(current.absolutePath).sort()) {
        const absolutePath = path.join(current.absolutePath, name);
        const relativePath = current.relativePath ? `${current.relativePath}/${name}` : name;
        const metadata = fs.lstatSync(absolutePath);
        if (metadata.isSymbolicLink()) return { valid: false, directories: [], files: [] };
        if (metadata.isDirectory()) {
          directories.push(`${relativePath}/`);
          pending.push({ absolutePath, relativePath });
        } else if (metadata.isFile()) {
          files.push(relativePath);
        } else {
          return { valid: false, directories: [], files: [] };
        }
      }
    }
  } catch (error) {
    return { valid: false, directories: [], files: [] };
  }
  return { valid: true, directories: directories.sort(), files: files.sort() };
}

function extractedTreeMatches(rootPath, policy) {
  const tree = collectExtractedTree(rootPath);
  const expectedDirectories = [...policy.entries].filter(entry => entry.endsWith('/')).sort();
  return tree.valid &&
    isDeepStrictEqual(tree.directories, expectedDirectories) &&
    isDeepStrictEqual(tree.files, [...policy.files].sort());
}

function installedBuildTreeMatches(packageRoot, policy) {
  const buildRoot = path.join(packageRoot, 'build');
  try {
    const packageMetadata = fs.lstatSync(packageRoot);
    const buildMetadata = fs.lstatSync(buildRoot);
    if (packageMetadata.isSymbolicLink() || !packageMetadata.isDirectory() ||
        buildMetadata.isSymbolicLink() || !buildMetadata.isDirectory() ||
        fs.realpathSync(buildRoot) !== path.join(fs.realpathSync(packageRoot), 'build')) {
      return false;
    }
  } catch (error) {
    return false;
  }
  const tree = collectExtractedTree(buildRoot);
  const expectedDirectories = [...policy.entries]
    .filter(entry => entry.endsWith('/') && entry !== 'build/')
    .map(entry => entry.slice('build/'.length))
    .sort();
  const expectedFiles = [...policy.files]
    .map(entry => entry.slice('build/'.length))
    .sort();
  return tree.valid &&
    isDeepStrictEqual(tree.directories, expectedDirectories) &&
    isDeepStrictEqual(tree.files, expectedFiles);
}

function extractApprovedArchive(archivePath, options, callback) {
  const runFile = options.execFileSync || execFileSync;
  return withAuthenticatedArchive(archivePath, options, (stableArchive, temporaryRoot, policy) => {
    if (!approvedArchiveInventoryMatches(stableArchive, options, policy)) return false;
    const extractedRoot = path.join(temporaryRoot, 'extracted');
    try {
      fs.mkdirSync(extractedRoot, { mode: 0o700 });
      runFile('/usr/bin/tar', ['-xzf', stableArchive, '-C', extractedRoot], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (!extractedTreeMatches(extractedRoot, policy)) return false;
      return callback(extractedRoot) === true;
    } catch (error) {
      return false;
    }
  });
}

function canvasPrebuildMatchesInstalled(packageRoot, archivePath, options = {}) {
  const policy = approvedPolicy(options);
  return extractApprovedArchive(archivePath, options, temporaryRoot => {
    if (!installedBuildTreeMatches(packageRoot, policy)) return false;
    for (const entry of policy.files) {
      const expected = fs.readFileSync(path.join(temporaryRoot, ...entry.split('/')));
      const actual = fs.readFileSync(path.join(packageRoot, ...entry.split('/')));
      if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return false;
    }
    return true;
  });
}

function collectApprovedCanvasPrebuildDigests(archivePath, options = {}) {
  let files = new Map();
  const valid = extractApprovedArchive(archivePath, options, (temporaryRoot) => {
    const collected = new Map();
    try {
      for (const entry of approvedPolicy(options).files) {
        const filePath = path.join(temporaryRoot, ...entry.split('/'));
        let descriptor = null;
        try {
          descriptor = fs.openSync(
            filePath,
            fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
          );
          const before = fs.fstatSync(descriptor);
          if (!before.isFile()) return false;
          const bytes = fs.readFileSync(descriptor);
          const after = fs.fstatSync(descriptor);
          if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino ||
              before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
              before.ctimeMs !== after.ctimeMs || bytes.length !== before.size) {
            return false;
          }
          collected.set(entry, sha256Bytes(bytes));
        } finally {
          if (descriptor !== null) fs.closeSync(descriptor);
        }
      }
    } catch (error) {
      return false;
    }
    files = collected;
    return true;
  });
  return {
    valid,
    files: valid ? files : new Map(),
  };
}

function installApprovedCanvasPrebuild(archivePath, projectRoot = path.resolve(__dirname, '..'), options = {}) {
  const nodeModulesRoot = path.join(projectRoot, 'node_modules');
  const canvasRoot = path.join(nodeModulesRoot, 'canvas');
  let nodeModulesIdentity = null;
  let canvasIdentity = null;
  try {
    nodeModulesIdentity = directoryIdentity(nodeModulesRoot);
    canvasIdentity = directoryIdentity(canvasRoot);
    if (!nodeModulesIdentity || !canvasIdentity ||
        canvasIdentity.realpath !== path.join(nodeModulesIdentity.realpath, 'canvas') ||
        !pathIsAbsent(path.join(canvasRoot, 'build'))) {
      throw new Error('invalid');
    }
  } catch (error) {
    throw new Error('Canvas install destination is not clean.');
  }

  const isolatedCanvasRoot = path.join(
    nodeModulesRoot,
    `.crate-canvas-package-${crypto.randomUUID()}`
  );
  let isolated = false;
  let destinationChanged = false;
  let buildCommitted = false;
  let committedBuildIdentity = null;
  const restoreIsolatedPackage = () => {
    try {
      if (!isolated || !directoryIdentityMatches(nodeModulesRoot, nodeModulesIdentity) ||
          !directoryIdentityMatches(isolatedCanvasRoot, canvasIdentity) ||
          !pathIsAbsent(canvasRoot)) {
        return false;
      }
      fs.renameSync(isolatedCanvasRoot, canvasRoot);
      if (typeof options.afterCanvasRestore === 'function') {
        options.afterCanvasRestore({ canvasRoot, isolatedCanvasRoot });
      }
      if (!directoryIdentityMatches(canvasRoot, canvasIdentity)) return false;
      isolated = false;
      return true;
    } catch (error) {
      return false;
    }
  };
  const rollbackCommittedBuild = packageRoot => {
    const buildRoot = path.join(packageRoot, 'build');
    try {
      if (!committedBuildIdentity ||
          !directoryIdentityMatches(nodeModulesRoot, nodeModulesIdentity) ||
          !directoryIdentityMatches(packageRoot, canvasIdentity)) {
        return false;
      }
      if (pathIsAbsent(buildRoot)) {
        buildCommitted = false;
        committedBuildIdentity = null;
        return true;
      }
      const metadata = fs.lstatSync(buildRoot);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        fs.unlinkSync(buildRoot);
        if (!pathIsAbsent(buildRoot)) return false;
        buildCommitted = false;
        committedBuildIdentity = null;
        return true;
      }
      if (metadata.dev !== committedBuildIdentity.dev ||
          metadata.ino !== committedBuildIdentity.ino) {
        return false;
      }
      const rollbackRoot = path.join(
        nodeModulesRoot,
        `.crate-canvas-build-rollback-${crypto.randomUUID()}`
      );
      if (!pathIsAbsent(rollbackRoot)) return false;
      fs.renameSync(buildRoot, rollbackRoot);
      if (!pathIsAbsent(buildRoot) ||
          !directoryIdentityMatches(rollbackRoot, committedBuildIdentity)) {
        return false;
      }
      const rollbackIdentity = committedBuildIdentity;
      buildCommitted = false;
      committedBuildIdentity = null;
      cleanupAuthenticatedTemporaryRoot(
        rollbackRoot,
        rollbackIdentity,
        approvedPolicy(options)
      );
      return true;
    } catch (error) {
      return false;
    }
  };

  try {
    if (!pathIsAbsent(isolatedCanvasRoot)) throw new Error('destination-changed');
    fs.renameSync(canvasRoot, isolatedCanvasRoot);
    isolated = true;
    if (!directoryIdentityMatches(nodeModulesRoot, nodeModulesIdentity) ||
        !directoryIdentityMatches(isolatedCanvasRoot, canvasIdentity) ||
        !pathIsAbsent(canvasRoot)) {
      throw new Error('destination-changed');
    }

    const isolatedBuildRoot = path.join(isolatedCanvasRoot, 'build');
    const installed = extractApprovedArchive(archivePath, {
      ...options,
      temporaryParent: nodeModulesRoot,
    }, temporaryRoot => {
      try {
        if (typeof options.beforeCanvasCommit === 'function') {
          options.beforeCanvasCommit({
            canvasRoot,
            isolatedCanvasRoot,
            temporaryRoot,
          });
        }
        if (!directoryIdentityMatches(nodeModulesRoot, nodeModulesIdentity) ||
            !directoryIdentityMatches(isolatedCanvasRoot, canvasIdentity) ||
            !pathIsAbsent(canvasRoot) || !pathIsAbsent(isolatedBuildRoot)) {
          destinationChanged = true;
          return false;
        }
        const stagedBuildRoot = path.join(temporaryRoot, 'build');
        const stagedIdentity = directoryIdentity(stagedBuildRoot);
        if (!stagedIdentity || stagedIdentity.dev !== canvasIdentity.dev) return false;
        fs.renameSync(stagedBuildRoot, isolatedBuildRoot);
        buildCommitted = true;
        committedBuildIdentity = directoryIdentity(isolatedBuildRoot);
        return directoryIdentityMatches(isolatedBuildRoot, stagedIdentity) &&
          directoryIdentityMatches(isolatedBuildRoot, committedBuildIdentity) &&
          directoryIdentityMatches(isolatedCanvasRoot, canvasIdentity) &&
          directoryIdentityMatches(nodeModulesRoot, nodeModulesIdentity);
      } catch (error) {
        return false;
      }
    });
    if (!installed) {
      if (destinationChanged) throw new Error('destination-changed');
      throw new Error('archive-failed');
    }
    if (typeof options.afterCanvasCommit === 'function') {
      options.afterCanvasCommit({ canvasRoot, isolatedCanvasRoot });
    }
    if (!directoryIdentityMatches(nodeModulesRoot, nodeModulesIdentity) ||
        !directoryIdentityMatches(isolatedCanvasRoot, canvasIdentity) ||
        !pathIsAbsent(canvasRoot) ||
        !canvasPrebuildMatchesInstalled(isolatedCanvasRoot, archivePath, options)) {
      throw new Error('destination-changed');
    }
    if (typeof options.beforeCanvasRestore === 'function') {
      options.beforeCanvasRestore({ canvasRoot, isolatedCanvasRoot });
    }
    if (!restoreIsolatedPackage()) throw new Error('destination-changed');
    if (!directoryIdentityMatches(nodeModulesRoot, nodeModulesIdentity) ||
        !directoryIdentityMatches(canvasRoot, canvasIdentity) ||
        !canvasPrebuildMatchesInstalled(canvasRoot, archivePath, options)) {
      throw new Error('destination-changed');
    }
  } catch (error) {
    const rollbackSafe = buildCommitted
      ? rollbackCommittedBuild(isolated ? isolatedCanvasRoot : canvasRoot)
      : true;
    const restoreSafe = !isolated || (rollbackSafe && restoreIsolatedPackage());
    if (!rollbackSafe || !restoreSafe || (error && error.message === 'destination-changed')) {
      throw new Error('Canvas install destination changed during installation.');
    }
    throw new Error('Approved Canvas archive installation failed.');
  }
}

function safeCanvasErrorMessage(error) {
  const approved = new Set([
    'Canvas install destination is not clean.',
    'Canvas install destination changed during installation.',
    'Approved Canvas archive installation failed.',
  ]);
  return approved.has(error && error.message)
    ? error.message
    : 'Approved Canvas archive installation failed.';
}

function run(argv = process.argv.slice(2), dependencies = {}) {
  const install = dependencies.install || installApprovedCanvasPrebuild;
  const writeOutput = dependencies.writeOutput || console.log;
  const writeError = dependencies.writeError || console.error;
  const setExitCode = dependencies.setExitCode || (code => { process.exitCode = code; });
  if (argv.length !== 1) {
    writeError('Usage: node scripts/install-approved-canvas-prebuild.js <archive>');
    setExitCode(2);
    return { exitCode: 2 };
  }
  try {
    install(argv[0]);
    writeOutput('Approved Canvas arm64 prebuild installed.');
    return { exitCode: 0 };
  } catch (error) {
    writeError(safeCanvasErrorMessage(error));
    setExitCode(1);
    return { exitCode: 1 };
  }
}

if (require.main === module) run();

module.exports = {
  APPROVED_CANVAS_PREBUILD,
  APPROVED_CANVAS_PREBUILD_DIRECTORIES,
  APPROVED_CANVAS_PREBUILD_ENTRIES,
  APPROVED_CANVAS_PREBUILD_FILES,
  canvasPrebuildMatchesInstalled,
  collectApprovedCanvasPrebuildDigests,
  inspectApprovedCanvasPrebuild,
  installApprovedCanvasPrebuild,
  run,
  safeCanvasErrorMessage,
};
