const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

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
    await asar.createPackageFromStreams(archivePath, [{
      path: 'package.json',
      streamGenerator: () => Readable.from(transformedManifest),
      unpacked: false,
      type: 'file',
      stat: {
        mode: 0o100644,
        size: transformedManifest.length,
      },
    }]);

    const archivedBytes = Buffer.from(asar.extractFile(archivePath, 'package.json'));
    const metadata = asar.statFile(archivePath, 'package.json', false);
    assert.deepEqual(archivedBytes, transformedManifest);
    assert.equal(metadata.integrity.algorithm, 'SHA256');
    assert.equal(metadata.integrity.hash, sha256(archivedBytes));
    assert.deepEqual(metadata.integrity.blocks, [sha256(archivedBytes)]);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
