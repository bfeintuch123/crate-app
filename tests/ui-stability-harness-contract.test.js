'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const harnessPath = path.join(__dirname, 'ui-stability-electron-harness.js');
const legacyHarnessPath = path.join(__dirname, 'ui-stability-electron-harness-legacy.js');
const policyPath = path.join(__dirname, 'ui-stability-harness-policy.js');
const preloadPath = path.join(__dirname, 'ui-stability-preload.js');
const harness = fs.readFileSync(harnessPath, 'utf8');
const legacyHarness = fs.readFileSync(legacyHarnessPath, 'utf8');
const policy = fs.readFileSync(policyPath, 'utf8');
const preload = fs.readFileSync(preloadPath, 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function assertParses(source, filename) {
  assert.doesNotThrow(() => new vm.Script(source, { filename }));
}

test('UI stability Electron harness, legacy runner, policy, and preload parse without production mutations', () => {
  assertParses(harness, 'tests/ui-stability-electron-harness.js');
  assertParses(legacyHarness, 'tests/ui-stability-electron-harness-legacy.js');
  assertParses(policy, 'tests/ui-stability-harness-policy.js');
  assertParses(preload, 'tests/ui-stability-preload.js');

  assert.match(harness, /ui-stability-electron-harness-legacy\.js/);
  assert.match(harness, /ui-stability-harness-policy/);
  assert.match(legacyHarness, /renderer', 'index\.html'/);
  assert.match(legacyHarness, /ui-stability-preload\.js/);
  assert.doesNotMatch(legacyHarness, /renderer', 'app\.js'/);
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
    assert.ok(legacyHarness.includes(size), `missing supported resize matrix entry ${size}`);
  }

  assert.match(legacyHarness, /DESKTOP_WINDOW_MINIMUM/);
  assert.match(legacyHarness, /supportedSizes/);
  assert.doesNotMatch(legacyHarness, /\{ width: 900, height: 700 \}/);
  assert.match(legacyHarness, /document\.documentElement/);
  assert.match(legacyHarness, /scrollWidth/);
  assert.match(legacyHarness, /clientWidth/);
  assert.match(legacyHarness, /rectanglesOverlap/);
  assert.match(legacyHarness, /outsideCards/);
  assert.match(legacyHarness, /firstRowColumns/);
  assert.match(legacyHarness, /minimumMeasuredCardWidth/);
  assert.match(legacyHarness, /capturePage\(\)/);
  assert.match(legacyHarness, /CRATE_UI_EVIDENCE_DIR/);
});

test('UI stability harness proves native below-minimum requests are clamped', () => {
  assert.match(legacyHarness, /BELOW_MINIMUM_REQUEST\s*=\s*Object\.freeze\(\{ width: 960, height: 700 \}\)/);
  assert.match(legacyHarness, /window\.setSize\(size\.width, size\.height, false\)/);
  assert.match(legacyHarness, /window\.getSize\(\)/);
  assert.match(legacyHarness, /window\.getMinimumSize\(\)/);
  assert.match(legacyHarness, /minimumClamp/);
  assert.match(legacyHarness, /below-minimum request/);
  assert.match(legacyHarness, /actualWindow/);
  assert.match(legacyHarness, /actualViewport/);
});

test('UI stability harness accepts only a connected visible macOS work-area cap', () => {
  assert.match(harness, /app, screen/);
  assert.match(harness, /screen\.getAllDisplays\(\)/);
  assert.match(harness, /visibleMacEvidence = process\.platform === 'darwin' && SHOW_WINDOW/);
  assert.match(harness, /reconcileWorkAreaCaps/);
  assert.match(harness, /outerSizeDisposition/);
  assert.match(policy, /disposition: 'work-area-capped'/);
  assert.match(policy, /does not explain the mismatch/);
});

test('UI stability harness preserves exact 1440x900 browser coverage outside visible Electron caps', () => {
  const browserGeometry = fs.readFileSync(
    path.join(__dirname, 'ui-stability-responsive-geometry.test.js'),
    'utf8',
  );
  assert.match(browserGeometry, /\[1440, 900\]/);
  assert.match(browserGeometry, /--window-size=\$\{width\},\$\{height\}/);
});

test('UI stability harness exits fail-closed from the reconciled report', () => {
  assert.match(harness, /getHarnessExitCode\(\{/);
  assert.match(harness, /legacy\.exitCode !== 0/);
  assert.match(harness, /finalizeHarnessProcess\(\{/);
  assert.doesNotMatch(harness, /app\.quit\(/);
  assert.match(policy, /pageErrors\.length > 0 \|\| consoleErrors\.length > 0 \|\| failures\.length > 0 \? 1 : 0/);
  assert.match(policy, /processModule\.exitCode = finalExitCode/);
  assert.match(policy, /appModule\.exit\(finalExitCode\)/);
});

test('UI stability harness requires the persistent desktop navigation at supported sizes', () => {
  assert.match(legacyHarness, /compactNavigationActive/);
  assert.match(legacyHarness, /labelsVisible/);
  assert.match(legacyHarness, /sidebarVisible/);
  assert.match(legacyHarness, /compact navigation is active at a supported desktop size/);
  assert.match(legacyHarness, /persistent desktop sidebar is not visible/);
  assert.match(legacyHarness, /compact navigation activated during supported resize sequence/);
});

test('UI stability harness navigates through the real project and Review Assets controls', () => {
  assert.match(legacyHarness, /#project-rows \.project-row/);
  assert.match(legacyHarness, /#btn-review-assets/);
  assert.match(legacyHarness, /#asset-review-workspace/);
  assert.match(legacyHarness, /#added-assets-list > \.asset-file-row/);
  assert.match(legacyHarness, /length <= 36/);
  assert.match(legacyHarness, /style\.height/);
  assert.match(legacyHarness, /#asset-review-search/);
  assert.ok(
    legacyHarness.includes('data-asset-filter="added"')
      || legacyHarness.includes('data-asset-filter=\\"added\\"'),
    'harness must select the Added filter',
  );
});

test('UI stability harness rejects footer overlap with preceding Review Assets controls', () => {
  assert.ok(
    legacyHarness.includes('Review Assets footer overlaps ${label}'),
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
      legacyHarness.includes(`'${label}'`) || legacyHarness.includes(`"${label}"`),
      `harness must measure footer overlap with ${label}`,
    );
  }
});

test('UI stability harness rejects resize-triggered data and preview reloads', () => {
  assert.match(legacyHarness, /minimum-to-wide-to-minimum/);
  assert.match(legacyHarness, /resizeMetrics\.getProjects !== 0/);
  assert.match(legacyHarness, /resizeMetrics\.getAssetWorkspace !== 0/);
  assert.match(legacyHarness, /resizeMetrics\.getFileVisual !== 0/);
  assert.match(legacyHarness, /search query changed during minimum-to-wide-to-minimum resize sequence/);
  assert.match(legacyHarness, /active asset filter changed during minimum-to-wide-to-minimum resize sequence/);
});

test('UI stability harness uses the existing Electron dependency and remains outside packaged app files', () => {
  assert.match(String(packageJson.devDependencies?.electron || ''), /^\^?42\./);
  assert.deepEqual(packageJson.build.files.includes('tests/**/*'), false);
  assert.ok(packageJson.build.files.includes('renderer/**/*'));
});
