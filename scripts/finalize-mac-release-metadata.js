'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { authenticateReleaseProcess } = require('./run-electron-builder-release');

function isInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) &&
    relative !== '..' && !path.isAbsolute(relative));
}

function requireSafeFile(rootPath, filePath, { allowMissing = false } = {}) {
  let metadata;
  try {
    metadata = fs.lstatSync(filePath);
  } catch (error) {
    if (allowMissing && error && error.code === 'ENOENT') return null;
    throw new Error('Release metadata artifact validation failed.');
  }
  const realPath = fs.realpathSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || realPath !== filePath ||
      !isInside(rootPath, realPath)) {
    throw new Error('Release metadata artifact validation failed.');
  }
  return metadata;
}

function requireSafeDirectory(directoryPath) {
  let metadata;
  let realPath;
  try {
    metadata = fs.lstatSync(directoryPath);
    realPath = fs.realpathSync(directoryPath);
  } catch {
    throw new Error('Release metadata directory validation failed.');
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || realPath !== directoryPath) {
    throw new Error('Release metadata directory validation failed.');
  }
  return realPath;
}

function releaseArtifactNames(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error('Release metadata version validation failed.');
  }
  return Object.freeze({
    dmg: `Crate-${version}-arm64.dmg`,
    dmgBlockmap: `Crate-${version}-arm64.dmg.blockmap`,
    zip: `Crate-${version}-arm64-mac.zip`,
    zipBlockmap: `Crate-${version}-arm64-mac.zip.blockmap`,
    metadata: 'latest-mac.yml',
  });
}

function openBoundArtifact(rootPath, filePath, flags = fs.constants.O_RDONLY) {
  const pathMetadata = requireSafeFile(rootPath, filePath);
  let handle;
  try {
    handle = fs.openSync(filePath, flags | fs.constants.O_NOFOLLOW);
    const handleMetadata = fs.fstatSync(handle);
    if (!handleMetadata.isFile() || handleMetadata.dev !== pathMetadata.dev ||
        handleMetadata.ino !== pathMetadata.ino || handleMetadata.size !== pathMetadata.size) {
      throw new Error('Release metadata artifact identity changed.');
    }
    return { filePath, handle, metadata: handleMetadata };
  } catch {
    if (handle !== undefined) fs.closeSync(handle);
    throw new Error('Release metadata artifact identity changed.');
  }
}

function readBoundArtifact(artifact) {
  const size = fs.fstatSync(artifact.handle).size;
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(artifact.handle, bytes, offset, size - offset, offset);
    if (count === 0) throw new Error('Release metadata artifact read failed.');
    offset += count;
  }
  return bytes;
}

function pathMatchesBoundArtifact(rootPath, artifact) {
  return pathMatchesBoundArtifactAt(rootPath, artifact, artifact.filePath);
}

function pathMatchesBoundArtifactAt(rootPath, artifact, candidatePath) {
  const pathMetadata = requireSafeFile(rootPath, candidatePath);
  const handleMetadata = fs.fstatSync(artifact.handle);
  const wasRenamed = candidatePath !== artifact.filePath;
  return pathMetadata.dev === handleMetadata.dev && pathMetadata.ino === handleMetadata.ino &&
    pathMetadata.size === handleMetadata.size && handleMetadata.dev === artifact.metadata.dev &&
    handleMetadata.ino === artifact.metadata.ino && handleMetadata.size === artifact.metadata.size &&
    (wasRenamed || (handleMetadata.mtimeMs === artifact.metadata.mtimeMs &&
      handleMetadata.ctimeMs === artifact.metadata.ctimeMs));
}

function hashBoundArtifact(artifact, algorithm = 'sha512', encoding = 'base64') {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const input = fs.createReadStream(null, {
      fd: artifact.handle,
      autoClose: false,
      start: 0,
      highWaterMark: 1024 * 1024,
    });
    input.on('error', reject);
    hash.on('error', reject);
    hash.setEncoding(encoding);
    input.on('end', () => {
      hash.end();
      resolve(hash.read());
    });
    input.pipe(hash, { end: false });
  });
}

function snapshotOutput(rootPath, filePath) {
  const metadata = requireSafeFile(rootPath, filePath, { allowMissing: true });
  if (metadata === null) return null;
  const artifact = openBoundArtifact(rootPath, filePath);
  try {
    const bytes = readBoundArtifact(artifact);
    if (!pathMatchesBoundArtifact(rootPath, artifact)) {
      throw new Error('Release metadata output snapshot changed.');
    }
    return Object.freeze({ bytes, mode: metadata.mode & 0o777 });
  } finally {
    fs.closeSync(artifact.handle);
  }
}

function restoreOutput(rootPath, filePath, snapshot, suffix, operations) {
  if (snapshot === null) {
    const current = requireSafeFile(rootPath, filePath, { allowMissing: true });
    if (current !== null) operations.unlink(filePath);
    return;
  }
  const restorePath = `${filePath}.${suffix}.restore`;
  if (!isInside(rootPath, restorePath) || fs.existsSync(restorePath)) {
    throw new Error('Release metadata rollback validation failed.');
  }
  try {
    fs.writeFileSync(restorePath, snapshot.bytes, {
      flag: 'wx',
      mode: snapshot.mode,
    });
    requireSafeFile(rootPath, restorePath);
    operations.rename(restorePath, filePath);
  } finally {
    const remaining = requireSafeFile(rootPath, restorePath, { allowMissing: true });
    if (remaining !== null) operations.unlink(restorePath);
  }
}

function cleanupTemporary(rootPath, filePath, operations) {
  const metadata = requireSafeFile(rootPath, filePath, { allowMissing: true });
  if (metadata !== null) operations.unlink(filePath);
}

function outputMatchesSnapshot(rootPath, filePath, snapshot) {
  if (snapshot === null) return requireSafeFile(rootPath, filePath, { allowMissing: true }) === null;
  const artifact = openBoundArtifact(rootPath, filePath);
  try {
    return readBoundArtifact(artifact).equals(snapshot.bytes) &&
      pathMatchesBoundArtifact(rootPath, artifact);
  } finally {
    fs.closeSync(artifact.handle);
  }
}

function createIncompleteMarker(rootPath, markerPath) {
  if (!isInside(rootPath, markerPath) || fs.existsSync(markerPath)) {
    throw new Error('Release metadata incomplete marker validation failed.');
  }
  let handle;
  try {
    handle = fs.openSync(
      markerPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600
    );
    fs.writeFileSync(handle, 'Crate release metadata is incomplete.\n');
    fs.fsyncSync(handle);
    return { filePath: markerPath, handle, metadata: fs.fstatSync(handle) };
  } catch {
    if (handle !== undefined) fs.closeSync(handle);
    throw new Error('Release metadata incomplete marker validation failed.');
  }
}

async function finalizeMacReleaseMetadata(options = {}) {
  const projectRoot = fs.realpathSync(options.projectRoot || path.join(__dirname, '..'));
  const packageJson = options.packageJson || require(path.join(projectRoot, 'package.json'));
  const names = releaseArtifactNames(packageJson.version);
  const distRoot = requireSafeDirectory(path.join(projectRoot, 'dist'));
  const paths = Object.fromEntries(
    Object.entries(names).map(([key, name]) => [key, path.join(distRoot, name)])
  );
  const operations = {
    rename: fs.renameSync,
    unlink: fs.unlinkSync,
    ...(options.operations || {}),
  };
  if (typeof operations.rename !== 'function' || typeof operations.unlink !== 'function') {
    throw new Error('Release metadata filesystem tool validation failed.');
  }

  const suffix = options.tempSuffix || crypto.randomUUID();
  if (!/^[0-9a-f-]{36}$/u.test(suffix)) {
    throw new Error('Release metadata temporary file validation failed.');
  }
  const temporaryBlockmap = `${paths.dmgBlockmap}.${suffix}.tmp`;
  const temporaryMetadata = `${paths.metadata}.${suffix}.tmp`;
  const incompleteMarker = path.join(distRoot, '.crate-release-metadata-incomplete');
  for (const temporaryPath of [temporaryBlockmap, temporaryMetadata]) {
    if (!isInside(distRoot, temporaryPath) || fs.existsSync(temporaryPath)) {
      throw new Error('Release metadata temporary file validation failed.');
    }
  }

  const generateBlockmap = options.generateBlockmap;
  const serializeToYaml = options.serializeToYaml;
  if (typeof generateBlockmap !== 'function' || typeof serializeToYaml !== 'function') {
    throw new Error('Release metadata tool validation failed.');
  }

  const artifacts = [];
  let marker = null;
  let markerCanClear = true;
  let oldBlockmap;
  let oldMetadata;
  try {
    const dmg = openBoundArtifact(distRoot, paths.dmg);
    const zip = openBoundArtifact(distRoot, paths.zip);
    const zipBlockmap = openBoundArtifact(distRoot, paths.zipBlockmap);
    artifacts.push(dmg, zip, zipBlockmap);
    oldBlockmap = snapshotOutput(distRoot, paths.dmgBlockmap);
    oldMetadata = snapshotOutput(distRoot, paths.metadata);
    marker = createIncompleteMarker(distRoot, incompleteMarker);

    const [dmgSha512, zipSha512, zipBlockmapSha256] = await Promise.all([
      hashBoundArtifact(dmg),
      hashBoundArtifact(zip),
      hashBoundArtifact(zipBlockmap, 'sha256', 'hex'),
    ]);
    const updateInfo = await generateBlockmap(paths.dmg, temporaryBlockmap);
    const generatedBlockmap = openBoundArtifact(distRoot, temporaryBlockmap, fs.constants.O_RDWR);
    artifacts.push(generatedBlockmap);
    if (!updateInfo || updateInfo.size !== dmg.metadata.size || updateInfo.sha512 !== dmgSha512) {
      throw new Error('Release metadata blockmap validation failed.');
    }

    const releaseDate = options.releaseDate || new Date().toISOString();
    if (Number.isNaN(Date.parse(releaseDate))) {
      throw new Error('Release metadata date validation failed.');
    }
    const metadata = {
      version: packageJson.version,
      files: [
        { url: names.zip, sha512: zipSha512, size: zip.metadata.size },
        { url: names.dmg, sha512: dmgSha512, size: dmg.metadata.size },
      ],
      path: names.zip,
      sha512: zipSha512,
      releaseDate,
    };
    const metadataBytes = Buffer.from(serializeToYaml(metadata, false, true), 'utf8');
    fs.writeFileSync(temporaryMetadata, metadataBytes, { flag: 'wx', mode: 0o600 });
    const generatedMetadata = openBoundArtifact(distRoot, temporaryMetadata, fs.constants.O_RDWR);
    artifacts.push(generatedMetadata);
    fs.fsyncSync(generatedBlockmap.handle);
    fs.fsyncSync(generatedMetadata.handle);
    const blockmapBytes = readBoundArtifact(generatedBlockmap);
    if (!pathMatchesBoundArtifact(distRoot, generatedBlockmap) ||
        !pathMatchesBoundArtifact(distRoot, generatedMetadata) ||
        !readBoundArtifact(generatedMetadata).equals(metadataBytes)) {
      throw new Error('Release metadata generated output validation failed.');
    }
    if (typeof options.beforeCommit === 'function') options.beforeCommit({ ...paths, temporaryBlockmap, temporaryMetadata });

    try {
      operations.rename(temporaryBlockmap, paths.dmgBlockmap);
      markerCanClear = false;
      operations.rename(temporaryMetadata, paths.metadata);

      if (!pathMatchesBoundArtifactAt(distRoot, generatedBlockmap, paths.dmgBlockmap) ||
          !pathMatchesBoundArtifactAt(distRoot, generatedMetadata, paths.metadata) ||
          !pathMatchesBoundArtifact(distRoot, dmg) || !pathMatchesBoundArtifact(distRoot, zip) ||
          !pathMatchesBoundArtifact(distRoot, zipBlockmap)) {
        throw new Error('Release metadata artifact identity changed.');
      }
      const [finalDmgSha512, finalZipSha512, finalZipBlockmapSha256] = await Promise.all([
        hashBoundArtifact(dmg),
        hashBoundArtifact(zip),
        hashBoundArtifact(zipBlockmap, 'sha256', 'hex'),
      ]);
      if (!pathMatchesBoundArtifact(distRoot, dmg) || !pathMatchesBoundArtifact(distRoot, zip) ||
          !pathMatchesBoundArtifact(distRoot, zipBlockmap) ||
          !pathMatchesBoundArtifactAt(distRoot, generatedBlockmap, paths.dmgBlockmap) ||
          !pathMatchesBoundArtifactAt(distRoot, generatedMetadata, paths.metadata) ||
          finalDmgSha512 !== dmgSha512 || finalZipSha512 !== zipSha512 ||
          finalZipBlockmapSha256 !== zipBlockmapSha256 ||
          !readBoundArtifact(generatedBlockmap).equals(blockmapBytes) ||
          !readBoundArtifact(generatedMetadata).equals(metadataBytes)) {
        throw new Error('Release metadata post-commit validation failed.');
      }
      markerCanClear = true;
      return Object.freeze({ names, metadata });
    } catch {
      try {
        restoreOutput(distRoot, paths.dmgBlockmap, oldBlockmap, suffix, operations);
        restoreOutput(distRoot, paths.metadata, oldMetadata, suffix, operations);
        markerCanClear = outputMatchesSnapshot(distRoot, paths.dmgBlockmap, oldBlockmap) &&
          outputMatchesSnapshot(distRoot, paths.metadata, oldMetadata);
      } catch {
        throw new Error('Release metadata rollback failed.');
      }
      throw new Error('Release metadata commit failed.');
    }
  } finally {
    for (const artifact of artifacts) fs.closeSync(artifact.handle);
    try {
      cleanupTemporary(distRoot, temporaryBlockmap, operations);
      cleanupTemporary(distRoot, temporaryMetadata, operations);
    } catch {
      throw new Error('Release metadata temporary file cleanup failed.');
    }
    if (marker !== null) {
      try {
        if (markerCanClear && pathMatchesBoundArtifact(distRoot, marker)) {
          operations.unlink(incompleteMarker);
        } else if (markerCanClear) {
          throw new Error('Release metadata incomplete marker validation failed.');
        }
      } finally {
        fs.closeSync(marker.handle);
      }
    }
  }
}

function loadReleaseTools() {
  const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap');
  const { serializeToYaml } = require('builder-util');
  return {
    generateBlockmap(input, output) {
      return buildBlockMap(input, 'gzip', output);
    },
    serializeToYaml,
  };
}

async function run(argv = process.argv.slice(2), env = process.env) {
  if (!Array.isArray(argv) || argv.length !== 0) return 2;
  authenticateReleaseProcess(env);
  await finalizeMacReleaseMetadata(loadReleaseTools());
  return 0;
}

if (require.main === module) {
  run().then(
    code => { process.exitCode = code; },
    () => {
      process.stderr.write('Crate release metadata finalization failed.\n');
      process.exitCode = 1;
    }
  );
}

module.exports = {
  finalizeMacReleaseMetadata,
  hashBoundArtifact,
  isInside,
  loadReleaseTools,
  openBoundArtifact,
  pathMatchesBoundArtifact,
  pathMatchesBoundArtifactAt,
  releaseArtifactNames,
  readBoundArtifact,
  requireSafeDirectory,
  requireSafeFile,
  run,
};
