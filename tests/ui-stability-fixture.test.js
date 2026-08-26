'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createUiStabilityFixture } = require('./ui-stability-fixture');

test('UI stability fixture reproduces the large Review Assets shape with synthetic data', () => {
  const fixture = createUiStabilityFixture();
  const files = fixture.workspace.files;
  const physicalSources = files.filter(file => file.protectedSource === true || file.projectRole === 'source');
  const existingAssets = files.filter(file => file.projectRole === 'asset' && file.assetOrigin === 'existing');
  const addedAssets = files.filter(file => file.projectRole === 'asset' && file.assetOrigin !== 'existing');
  const figmaSources = new Set(
    files
      .filter(file => file.projectRole === 'asset' && file.appFamily === 'figma')
      .map(file => file.sourceName)
      .filter(Boolean),
  );

  assert.equal(physicalSources.length, fixture.expected.physicalSourceFiles);
  assert.equal(figmaSources.size, fixture.expected.figmaSourceFiles);
  assert.equal(physicalSources.length + figmaSources.size, fixture.expected.sourceFiles);
  assert.equal(existingAssets.length, fixture.expected.existingAssets);
  assert.equal(addedAssets.length, fixture.expected.addedAssets);
  assert.equal(existingAssets.length + addedAssets.length, fixture.expected.totalAssets);
  assert.equal(files.length, fixture.expected.totalWorkspaceFiles);
  assert.equal(fixture.project.pendingFiles.length, 0);
});

test('UI stability fixture contains no real paths, URLs, or credentials', () => {
  const fixture = createUiStabilityFixture();
  const serialized = JSON.stringify(fixture);

  assert.doesNotMatch(serialized, /(?:\/Users|\/Volumes|\/private\/|[A-Za-z]:\\\\)/);
  assert.doesNotMatch(serialized, /https?:\/\//i);
  assert.doesNotMatch(serialized, /figd_[A-Za-z0-9_-]+/i);
  assert.doesNotMatch(serialized, /(?:token|secret|password|authorization)\s*[:=]/i);
  assert.match(serialized, /Synthetic UI Stability Project/);
});

test('UI stability fixture includes long filenames and stable opaque visual revisions', () => {
  const fixture = createUiStabilityFixture();
  const assets = fixture.workspace.files.filter(file => file.projectRole === 'asset');

  assert.ok(assets.some(file => file.name.length > 70));
  assert.ok(assets.every(file => /^synthetic-visual-\d{4}$/.test(file.visualIdentity)));
  assert.ok(assets.every(file => /^synthetic-revision-\d{4}$/.test(file.visualRevision)));
  assert.equal(new Set(assets.map(file => file.visualIdentity)).size, assets.length);
});
