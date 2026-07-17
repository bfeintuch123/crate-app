'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const yaml = require('js-yaml');

const {
  finalizeMacReleaseMetadata,
  loadReleaseTools,
  releaseArtifactNames,
  run,
} = require('../scripts/finalize-mac-release-metadata');
const { serializeToYaml } = require('builder-util');
const { sha256: sha256File } = require('../scripts/run-electron-builder-release');

const ROOT = path.join(__dirname, '..');

function sha512(value) {
  return crypto.createHash('sha512').update(value).digest('base64');
}

function createFixture() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-release-metadata-'));
  const dist = path.join(projectRoot, 'dist');
  fs.mkdirSync(dist);
  const version = '3.0.0-beta.2';
  const names = releaseArtifactNames(version);
  const dmg = Buffer.from('final signed notarized stapled dmg');
  const zip = Buffer.from('final signed notarized stapled zip');
  fs.writeFileSync(path.join(dist, names.dmg), dmg);
  fs.writeFileSync(path.join(dist, names.zip), zip);
  fs.writeFileSync(path.join(dist, names.dmgBlockmap), 'stale dmg blockmap');
  fs.writeFileSync(path.join(dist, names.zipBlockmap), 'final zip blockmap');
  fs.writeFileSync(path.join(dist, names.metadata), 'stale metadata');
  fs.writeFileSync(path.join(projectRoot, 'package.json'), `${JSON.stringify({ version })}\n`);
  return { projectRoot, dist, version, names, dmg, zip };
}

async function finalize(fixture, overrides = {}) {
  return finalizeMacReleaseMetadata({
    projectRoot: fixture.projectRoot,
    packageJson: { version: fixture.version },
    releaseDate: '2026-07-17T12:00:00.000Z',
    tempSuffix: '00000000-0000-4000-8000-000000000000',
    serializeToYaml,
    async generateBlockmap(input, output) {
      const bytes = fs.readFileSync(input);
      fs.writeFileSync(output, 'final dmg blockmap');
      return { size: bytes.length, sha512: sha512(bytes) };
    },
    ...overrides,
  });
}

test('finalizer replaces stale DMG metadata from final artifact bytes', async t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.projectRoot, { recursive: true, force: true }));
  const zipBlockmapBefore = fs.readFileSync(path.join(fixture.dist, fixture.names.zipBlockmap));

  const result = await finalize(fixture);
  const parsed = yaml.load(fs.readFileSync(path.join(fixture.dist, fixture.names.metadata), 'utf8'));

  assert.equal(fs.readFileSync(path.join(fixture.dist, fixture.names.dmgBlockmap), 'utf8'), 'final dmg blockmap');
  assert.deepEqual(fs.readFileSync(path.join(fixture.dist, fixture.names.zipBlockmap)), zipBlockmapBefore);
  assert.deepEqual(parsed, result.metadata);
  assert.deepEqual(parsed.files, [
    { url: fixture.names.zip, sha512: sha512(fixture.zip), size: fixture.zip.length },
    { url: fixture.names.dmg, sha512: sha512(fixture.dmg), size: fixture.dmg.length },
  ]);
  assert.equal(parsed.path, fixture.names.zip);
  assert.equal(parsed.sha512, sha512(fixture.zip));
});

test('finalizer fails closed when generated blockmap does not match final DMG', async t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.projectRoot, { recursive: true, force: true }));
  const oldBlockmap = fs.readFileSync(path.join(fixture.dist, fixture.names.dmgBlockmap), 'utf8');
  const oldMetadata = fs.readFileSync(path.join(fixture.dist, fixture.names.metadata), 'utf8');

  await assert.rejects(() => finalize(fixture, {
    async generateBlockmap(_input, output) {
      fs.writeFileSync(output, 'invalid blockmap');
      return { size: 1, sha512: 'invalid' };
    },
  }), /blockmap validation failed/u);
  assert.equal(fs.readFileSync(path.join(fixture.dist, fixture.names.dmgBlockmap), 'utf8'), oldBlockmap);
  assert.equal(fs.readFileSync(path.join(fixture.dist, fixture.names.metadata), 'utf8'), oldMetadata);
});

test('finalizer rejects symlinked artifacts and output paths', async t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.projectRoot, { recursive: true, force: true }));
  const external = path.join(fixture.projectRoot, 'external');
  fs.writeFileSync(external, 'external');
  const metadataPath = path.join(fixture.dist, fixture.names.metadata);
  fs.unlinkSync(metadataPath);
  fs.symlinkSync(external, metadataPath);

  await assert.rejects(() => finalize(fixture), /artifact validation failed/u);
  assert.equal(fs.readFileSync(external, 'utf8'), 'external');
});

test('release artifact names reject malformed versions', () => {
  assert.throws(() => releaseArtifactNames('../private'));
  assert.throws(() => releaseArtifactNames('3.0.0 beta.2'));
  assert.equal(releaseArtifactNames('3.0.0-beta.2').metadata, 'latest-mac.yml');
});

test('finalizer requires every final release input', async t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.projectRoot, { recursive: true, force: true }));
  fs.unlinkSync(path.join(fixture.dist, fixture.names.zipBlockmap));

  await assert.rejects(() => finalize(fixture), /artifact validation failed/u);
});

test('finalizer rolls both outputs back when the second replacement fails', async t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.projectRoot, { recursive: true, force: true }));
  const oldBlockmap = fs.readFileSync(path.join(fixture.dist, fixture.names.dmgBlockmap));
  const oldMetadata = fs.readFileSync(path.join(fixture.dist, fixture.names.metadata));
  let renameCount = 0;

  await assert.rejects(() => finalize(fixture, {
    operations: {
      rename(from, to) {
        renameCount += 1;
        if (renameCount === 2) throw new Error('injected replacement failure');
        fs.renameSync(from, to);
      },
      unlink: fs.unlinkSync,
    },
  }), /commit failed/u);
  assert.deepEqual(fs.readFileSync(path.join(fixture.dist, fixture.names.dmgBlockmap)), oldBlockmap);
  assert.deepEqual(fs.readFileSync(path.join(fixture.dist, fixture.names.metadata)), oldMetadata);
});

test('finalizer detects artifact replacement after metadata generation and rolls back', async t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.projectRoot, { recursive: true, force: true }));
  const oldBlockmap = fs.readFileSync(path.join(fixture.dist, fixture.names.dmgBlockmap));
  const oldMetadata = fs.readFileSync(path.join(fixture.dist, fixture.names.metadata));
  let renameCount = 0;

  await assert.rejects(() => finalize(fixture, {
    operations: {
      rename(from, to) {
        fs.renameSync(from, to);
        renameCount += 1;
        if (renameCount === 2) {
          const zipPath = path.join(fixture.dist, fixture.names.zip);
          fs.renameSync(zipPath, `${zipPath}.replaced`);
          fs.writeFileSync(zipPath, fixture.zip);
        }
      },
      unlink: fs.unlinkSync,
    },
  }), /commit failed/u);
  assert.deepEqual(fs.readFileSync(path.join(fixture.dist, fixture.names.dmgBlockmap)), oldBlockmap);
  assert.deepEqual(fs.readFileSync(path.join(fixture.dist, fixture.names.metadata)), oldMetadata);
});

test('finalizer detects in-place artifact mutation after metadata generation', async t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.projectRoot, { recursive: true, force: true }));
  let renameCount = 0;

  await assert.rejects(() => finalize(fixture, {
    operations: {
      rename(from, to) {
        fs.renameSync(from, to);
        renameCount += 1;
        if (renameCount === 2) {
          fs.appendFileSync(path.join(fixture.dist, fixture.names.dmg), 'changed');
        }
      },
      unlink: fs.unlinkSync,
    },
  }), /commit failed/u);
});

test('finalizer rejects a generated-output path swap before commit', async t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.projectRoot, { recursive: true, force: true }));
  const oldBlockmap = fs.readFileSync(path.join(fixture.dist, fixture.names.dmgBlockmap));
  const oldMetadata = fs.readFileSync(path.join(fixture.dist, fixture.names.metadata));

  await assert.rejects(() => finalize(fixture, {
    beforeCommit({ temporaryBlockmap }) {
      const bytes = fs.readFileSync(temporaryBlockmap);
      fs.unlinkSync(temporaryBlockmap);
      fs.writeFileSync(temporaryBlockmap, bytes);
    },
  }), /commit failed/u);
  assert.deepEqual(fs.readFileSync(path.join(fixture.dist, fixture.names.dmgBlockmap)), oldBlockmap);
  assert.deepEqual(fs.readFileSync(path.join(fixture.dist, fixture.names.metadata)), oldMetadata);
});

for (const failedRollbackRename of [3, 4]) {
  test(`rollback failure at replacement ${failedRollbackRename} leaves an incomplete marker`, async t => {
    const fixture = createFixture();
    t.after(() => fs.rmSync(fixture.projectRoot, { recursive: true, force: true }));
    let renameCount = 0;

    await assert.rejects(() => finalize(fixture, {
      operations: {
        rename(from, to) {
          renameCount += 1;
          if (renameCount === 2 || renameCount === failedRollbackRename) {
            throw new Error('injected replacement failure');
          }
          fs.renameSync(from, to);
        },
        unlink: fs.unlinkSync,
      },
    }), /rollback failed/u);
    assert.equal(
      fs.readFileSync(path.join(fixture.dist, '.crate-release-metadata-incomplete'), 'utf8'),
      'Crate release metadata is incomplete.\n'
    );
  });
}

test('production release tools generate a real app-builder blockmap', async t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.projectRoot, { recursive: true, force: true }));
  const tools = loadReleaseTools();

  const result = await finalizeMacReleaseMetadata({
    projectRoot: fixture.projectRoot,
    packageJson: { version: fixture.version },
    releaseDate: '2026-07-17T12:00:00.000Z',
    tempSuffix: '00000000-0000-4000-8000-000000000001',
    ...tools,
  });
  const blockmap = JSON.parse(zlib.gunzipSync(
    fs.readFileSync(path.join(fixture.dist, fixture.names.dmgBlockmap))
  ));
  assert.equal(result.metadata.files[1].sha512, sha512(fixture.dmg));
  assert.equal(blockmap.version, '2');
  assert.equal(
    blockmap.files.flatMap(file => file.sizes).reduce((sum, size) => sum + size, 0),
    fixture.dmg.length
  );
});

test('CLI rejects arguments and hides authentication diagnostics', async () => {
  assert.equal(await run(['unexpected']), 2);
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'finalize-mac-release-metadata.js')], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: {},
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Crate release metadata finalization failed.\n');
});

test('authenticated zero-argument CLI finalizes a fixture through the executable entrypoint', t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.projectRoot, { recursive: true, force: true }));
  const scripts = path.join(fixture.projectRoot, 'scripts');
  fs.mkdirSync(scripts);
  for (const name of ['finalize-mac-release-metadata.js', 'run-electron-builder-release.js']) {
    fs.copyFileSync(path.join(ROOT, 'scripts', name), path.join(scripts, name));
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(fixture.projectRoot, 'node_modules'));
  const canonicalNode = fs.realpathSync(process.execPath);
  const result = spawnSync(canonicalNode, [path.join(scripts, 'finalize-mac-release-metadata.js')], {
    cwd: fixture.projectRoot,
    encoding: 'utf8',
    env: {
      CRATE_RELEASE_CANONICAL_NODE: canonicalNode,
      CRATE_RELEASE_CANONICAL_NODE_SHA256: sha256File(canonicalNode),
      HOME: fixture.projectRoot,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      TMPDIR: fixture.projectRoot,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(fs.existsSync(path.join(fixture.dist, '.crate-release-metadata-incomplete')), false);
});
