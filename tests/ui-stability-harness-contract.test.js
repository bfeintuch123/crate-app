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

test('UI stability harness measures only the supported desktop resize matrix', () => {
  for (const size of [
    '1200, height: 800',
    '1280, height: 800',
    '1440, height: 900',
  ]) {
    assert.ok(harness.includes(size), `missing supported resize matrix entry ${size}`);
  }

  assert.match(harness, /DESKTOP_WINDOW_MINIMUM/);
  assert.match(harness, /supportedSizes/);
  assert.doesNotMatch(harness, /\{ width: 900, height: 700 \}/);
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

test('UI stability harness proves native below-minimum requests are clamped', () => {
  assert.match(harness, /BELOW_MINIMUM_REQUEST\s*=\s*Object\.freeze\(\{ width: 720, height: 560 \}\)/);
  assert.match(harness, /window\.setSize\(size\.width, size\.height, false\)/);
  assert.match(harness, /window\.getSize\(\)/);
  assert.match(harness, /window\.getMinimumSize\(\)/);
  assert.match(harness, /minimumClamp/);
  assert.match(harness, /below-minimum request/);
  assert.match(harness, /actualWindow/);
  assert.match(harness, /actualViewport/);
});

test('UI stability harness requires the persistent desktop navigation at supported sizes', () => {
  assert.match(harness, /compactNavigationActive/);
  assert.match(harness, /labelsVisible/);
  assert.match(harness, /sidebarVisible/);
  assert.match(harness, /compact navigation is active at a supported desktop size/);
  assert.match(harness, /persistent desktop sidebar is not visible/);
  assert.match(harness, /compact navigation activated during supported resize sequence/);
});

test('UI stability harness navigates through the real project and Review Assets controls', () => {
  assert.match(harness, /#project-rows \.project-row/);
  assert.match(harness, /#btn-review-assets/);
  assert.match(harness, /#asset-review-workspace/);
  assert.match(harness, /#added-assets-list > \.asset-file-row/);
  assert.match(harness, /length === 256/);
  assert.match(harness, /#asset-review-search/);
  assert.ok(
    harness.includes('data-asset-filter="added"')
      || harness.includes('data-asset-filter=\\"added\\"'),
    'harness must select the Added filter',
  );
});

test('UI stability harness rejects footer overlap with preceding Review Assets controls', () => {
  assert.ok(
    harness.includes('Review Assets footer overlaps ${label}'),
    'harness must report the intersecting footer target',
  );

  for (const label of [
    'Review Assets back control',
    'Review Assets heading',
    'Review Assets search',
    'asset filters',
    'asset summary',
    'bulk actions',
  ]) {
    assert.ok(
      harness.includes(`'${label}'`) || harness.includes(`"${label}"`),
      `harness must measure footer overlap with ${label}`,
    );
  }
});

test('UI stability harness rejects resize-triggered data and preview reloads', () => {
  assert.match(harness, /minimum-to-wide-to-minimum/);
  assert.match(harness, /resizeMetrics\.getProjects !== 0/);
  assert.match(harness, /resizeMetrics\.getAssetWorkspace !== 0/);
  assert.match(harness, /resizeMetrics\.getFileVisual !== 0/);
  assert.match(harness, /search query changed during minimum-to-wide-to-minimum resize sequence/);
  assert.match(harness, /active asset filter changed during minimum-to-wide-to-minimum resize sequence/);
});

test('UI stability harness uses the existing Electron dependency and remains outside packaged app files', () => {
  assert.match(String(packageJson.devDependencies?.electron || ''), /^\^?42\./);
  assert.deepEqual(packageJson.build.files.includes('tests/**/*'), false);
  assert.ok(packageJson.build.files.includes('renderer/**/*'));
});
