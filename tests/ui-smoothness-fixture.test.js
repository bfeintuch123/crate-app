'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SMOOTHNESS_ASSET_COUNTS,
  collectUnsafeSyntheticStrings,
  createUiSmoothnessFixture,
} = require('./ui-smoothness-fixture');

test('smoothness fixture matrix covers empty, normal, and stress project sizes', () => {
  assert.deepEqual(SMOOTHNESS_ASSET_COUNTS, [0, 7, 30, 100, 263, 500]);

  for (const assetCount of SMOOTHNESS_ASSET_COUNTS) {
    const fixture = createUiSmoothnessFixture({ assetCount });
    assert.equal(fixture.projects.length, 1);
    assert.equal(fixture.project.id, fixture.expected.projectId);
    assert.equal(fixture.workspace.projectId, fixture.expected.projectId);
    assert.equal(fixture.expected.assetCount, assetCount);
    assert.equal(fixture.expected.existingAssets, Math.min(7, assetCount));
    assert.equal(fixture.expected.addedAssets, Math.max(0, assetCount - 7));
    assert.equal(fixture.expected.physicalSourceFiles, 3);
    assert.equal(fixture.expected.representedSourceFiles, assetCount > 0 ? 4 : 3);
    assert.equal(fixture.expected.totalWorkspaceFiles, assetCount + 3);
    assert.equal(fixture.project.files.length, assetCount + 3);
    assert.equal(fixture.workspace.files.length, assetCount + 3);
    assert.equal(collectUnsafeSyntheticStrings(fixture).length, 0);
  }
});

test('smoothness fixture can represent excluded and pending interaction states', () => {
  const fixture = createUiSmoothnessFixture({
    assetCount: 30,
    excludedCount: 3,
    pendingCount: 4,
    decisionRequired: true,
  });

  assert.equal(fixture.expected.excludedCount, 3);
  assert.equal(fixture.expected.pendingCount, 4);
  assert.equal(fixture.project.excludedAssetKeys.length, 3);
  assert.equal(fixture.project.pendingFiles.length, 4);
  assert.equal(fixture.workspace.pendingFiles.length, 4);
  assert.equal(fixture.project.assetBaseline.status, 'decision-required');
  assert.equal(collectUnsafeSyntheticStrings(fixture).length, 0);
});

test('smoothness fixture clamps untrusted size inputs to bounded synthetic limits', () => {
  assert.equal(createUiSmoothnessFixture({ assetCount: -5 }).expected.assetCount, 0);
  assert.equal(createUiSmoothnessFixture({ assetCount: 9999 }).expected.assetCount, 500);
  assert.equal(createUiSmoothnessFixture({ assetCount: '30.9' }).expected.assetCount, 30);
  assert.equal(createUiSmoothnessFixture({ assetCount: 'invalid' }).expected.assetCount, 30);
});
