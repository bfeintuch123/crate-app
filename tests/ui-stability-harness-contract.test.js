'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const harnessPath = path.join(__dirname, 'ui-stability-electron-harness.js');
const preloadPath = path.join(__dirname, 'ui-stability-preload.js');
const harness = fs.readFileSync(harnessPath, 'utf8');
const preload = fs.readFileSync(preloadPath, 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function assertParses(source, filename) {
  assert.doesNotThrow(() => new vm.Script(source, { filename }));
}

test('UI stability Electron harness and test-only preload parse without production mutations', () => {
  assertParses(harness, 'tests/ui-stability-electron-harness.js');
  assertParses(preload, 'tests/ui-stability-preload.js');

  assert.match(harness, /renderer', 'index\.html'/);
  assert.match(harness, /ui-stability-preload\.js/);
  assert.doesNotMatch(harness, /renderer', 'app\.js'/);
  assert.doesNotMatch(preload, /preload\.js/);
  assert.match(preload, /contextBridge\.exposeInMainWorld\('crate'/);
  assert.match(preload, /contextBridge\.exposeInMainWorld\('crateUiHarness'/);
});

test('UI stability harness measures the supported resize matrix and actual overflow geometry', () => {
  for (const size of [
    '1440, height: 900',
    '1280, height: 800',
    '1200, height: 800',
    '1100, height: 760',
    '1040, height: 760',
    '960, height: 760',
    '900, height: 700',
  ]) {
    assert.ok(harness.includes(size), `missing resize matrix entry ${size}`);
  }

  assert.match(harness, /readConfiguredMinimumWindow\(\)/);
  assert.match(harness, /document\.documentElement/);
  assert.match(harness, /scrollWidth/);
  assert.match(harness, /clientWidth/);
  assert.match(harness, /rectanglesOverlap/);
  assert.match(harness, /outsideCards/);
  assert.match(harness, /firstRowColumns/);
  assert.match(harness, /minimumMeasuredCardWidth/);
  assert.match(harness, /capturePage\(\)/);
  assert.match(harness, /CRATE_UI_EVIDENCE_DIR/);
});

test('UI stability harness navigates through the real project and Review Assets controls', () => {
  assert.match(harness, /#project-rows \.project-row/);
  assert.match(harness, /#btn-review-assets/);
  assert.match(harness, /#asset-review-workspace/);
  assert.match(harness, /#added-assets-list > \.asset-file-row/);
  assert.match(harness, /length === 256/);
  assert.match(harness, /#asset-review-search/);
  assert.match(harness, /data-asset-filter=\\"added\\"/);
});

test('UI stability harness rejects resize-triggered data and preview reloads', () => {
  assert.match(harness, /resizeMetrics\.getProjects !== 0/);
  assert.match(harness, /resizeMetrics\.getAssetWorkspace !== 0/);
  assert.match(harness, /resizeMetrics\.getFileVisual !== 0/);
  assert.match(harness, /search query changed during resize sequence/);
  assert.match(harness, /active asset filter changed during resize sequence/);
});

test('UI stability harness uses the existing Electron dependency and remains outside packaged app files', () => {
  assert.match(String(packageJson.devDependencies?.electron || ''), /^\^?42\./);
  assert.deepEqual(packageJson.build.files.includes('tests/**/*'), false);
  assert.ok(packageJson.build.files.includes('renderer/**/*'));
});
