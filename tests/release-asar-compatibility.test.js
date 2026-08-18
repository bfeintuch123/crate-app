const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { finished } = require('node:stream/promises');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const {
  verifyAsarFileIntegrity,
} = require('../scripts/verify-macos-release-app');

function findPackageManifest(entryPath) {
  let current = path.dirname(entryPath);
  while (current !== path.dirname(current)) {
    const candidate = path.join(current, 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    current = path.dirname(current);
  }
  throw new Error('Package manifest is missing.');
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function waitForArchiveStream(stream) {
  await finished(stream, { cleanup: true });
  return stream;
}

test('archive stream completion follows terminal stream events', async t => {
  await t.test('waits for a successful finish', async () => {
    let releaseWrite;
    let settled = false;
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        releaseWrite = callback;
      },
    });
    const completion = waitForArchiveStream(stream).finally(() => {
      settled = true;
    });

    stream.end('payload');
    await Promise.resolve();
    assert.equal(settled, false);
    releaseWrite();
    await completion;
    assert.equal(settled, true);
  });

  await t.test('rejects a stream error', async () => {
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const completion = waitForArchiveStream(stream);
    stream.destroy(new Error('synthetic archive write failure'));

    await assert.rejects(completion, /synthetic archive write failure/);
  });

  await t.test('rejects a premature close', async () => {
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const completion = waitForArchiveStream(stream);
    stream.destroy();

    await assert.rejects(completion, { code: 'ERR_STREAM_PREMATURE_CLOSE' });
  });
});

test('Electron Builder ASAR stream packaging hashes the transformed archived bytes', async () => {
  const builderManifestPath = require.resolve('app-builder-lib/package.json');
  const builderManifest = JSON.parse(fs.readFileSync(builderManifestPath, 'utf8'));
  const builderRoot = path.dirname(builderManifestPath);
  const asarEntryPath = require.resolve('@electron/asar', { paths: [builderRoot] });
  const asarManifest = JSON.parse(fs.readFileSync(findPackageManifest(asarEntryPath), 'utf8'));

  assert.equal(asarManifest.version, builderManifest.dependencies['@electron/asar']);

  const asar = await import(pathToFileURL(asarEntryPath).href);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-asar-compatibility-'));
  const archivePath = path.join(temporaryRoot, 'app.asar');
  const transformedManifest = Buffer.from('{"name":"crate-app","version":"transformed"}');
  try {
    const archiveStream = await asar.createPackageFromStreams(archivePath, [{
      path: 'package.json',
      streamGenerator: () => Readable.from(transformedManifest),
      unpacked: false,
      type: 'file',
      stat: {
        mode: 0o100644,
        size: transformedManifest.length,
      },
    }, {
      path: 'empty.txt',
      streamGenerator: () => Readable.from(Buffer.alloc(0)),
      unpacked: false,
      type: 'file',
      stat: {
        mode: 0o100644,
        size: 0,
      },
    }]);
    await waitForArchiveStream(archiveStream);

    const archivedBytes = Buffer.from(asar.extractFile(archivePath, 'package.json'));
    const metadata = asar.statFile(archivePath, 'package.json', false);
    assert.deepEqual(archivedBytes, transformedManifest);
    assert.equal(metadata.integrity.algorithm, 'SHA256');
    assert.equal(metadata.integrity.hash, sha256(archivedBytes));
    assert.deepEqual(metadata.integrity.blocks, [sha256(archivedBytes)]);

    const emptyBytes = Buffer.from(asar.extractFile(archivePath, 'empty.txt'));
    const emptyMetadata = asar.statFile(archivePath, 'empty.txt', false);
    assert.equal(emptyBytes.length, 0);
    assert.equal(emptyMetadata.integrity.algorithm, 'SHA256');
    assert.equal(emptyMetadata.integrity.hash, sha256(emptyBytes));
    assert.deepEqual(emptyMetadata.integrity.blocks, [sha256(emptyBytes)]);
    assert.deepEqual(verifyAsarFileIntegrity(asar, archivePath), {
      valid: true,
      checkedFileCount: 2,
      failedFileCount: 0,
    });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
