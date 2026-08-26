'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const preloadPath = path.join(__dirname, 'ui-smoothness-preload.js');
const preload = fs.readFileSync(preloadPath, 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('smoothness preload parses and remains test-only', () => {
  assert.doesNotThrow(() => new vm.Script(preload, { filename: preloadPath }));
  assert.match(preload, /contextBridge\.exposeInMainWorld\('crate'/);
  assert.match(preload, /contextBridge\.exposeInMainWorld\('crateSmoothnessHarness'/);
  assert.deepEqual(packageJson.build.files.includes('tests\/\*\*\/*'), false);
  assert.deepEqual(packageJson.build.files.includes('tests/**/*'), false);
});

test('smoothness preload records app reads, actions, events, and preview identities', () => {
  for (const contract of [
    "recordRead('getProjects'",
    "recordRead('getSettings'",
    "recordRead('getUsage'",
    "recordRead(\n    'getAssetWorkspace'",
    "record('calls', 'getFileVisual'",
    "recordAction('pauseProject'",
    "recordAction('startWatching'",
    "recordAction('preparePackageReview'",
    'metrics.emittedEvents += 1',
    'metrics.visualIdentities.push(visualIdentity)',
  ]) {
    assert.ok(preload.includes(contract), `missing metrics contract: ${contract}`);
  }
});

test('smoothness preload can simulate targeted updates and event bursts', () => {
  for (const contract of [
    'appendSyntheticAsset',
    'reviseSyntheticAsset',
    'removeSyntheticAsset',
    'toggleAssetExclusion',
    'emitFilesUpdated',
    'emitProjectUpdated',
    'emitPendingFilesUpdated',
    'emitFileBurst',
    'setLatencies',
    'resetFixture',
    'resetMetrics',
  ]) {
    assert.match(preload, new RegExp(`\\b${contract}\\b`), `missing smoothness control ${contract}`);
  }
  assert.match(preload, /Math\.min\(100, Number\(count\) \|\| 0\)/);
});

test('smoothness preload uses synthetic values rather than local paths or credentials', () => {
  assert.doesNotMatch(preload, /\/Users\//);
  assert.doesNotMatch(preload, /\/Volumes\//);
  assert.doesNotMatch(preload, /figd_[A-Za-z0-9]/);
  assert.doesNotMatch(preload, /Bearer\s+[A-Za-z0-9]/);
  assert.doesNotMatch(preload, /sk-[A-Za-z0-9]/);
  assert.match(preload, /Synthetic package output/);
  assert.match(preload, /synthetic-review-reference/);
});
