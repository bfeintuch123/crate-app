'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const harnessPath = path.join(__dirname, 'ui-smoothness-electron-baseline.js');
const harness = fs.readFileSync(harnessPath, 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('app-wide smoothness baseline harness parses and uses the real renderer', () => {
  assert.doesNotThrow(() => new vm.Script(harness, { filename: harnessPath }));
  assert.match(harness, /renderer', 'index\.html'/);
  assert.match(harness, /ui-smoothness-preload\.js/);
  assert.match(harness, /new BrowserWindow\(/);
  assert.match(harness, /applyDesktopWindowMinimum\(window\)/);
  assert.deepEqual(packageJson.build.files.includes('tests/**/*'), false);
});

test('smoothness baseline covers empty, normal, and stress fixtures', () => {
  assert.match(harness, /SMOOTHNESS_ASSET_COUNTS/);
  assert.match(harness, /for \(const assetCount of SMOOTHNESS_ASSET_COUNTS\)/);
  assert.match(harness, /app-wide-smoothness-baseline/);
  assert.match(harness, /assetCount === 30/);
  assert.match(harness, /previewRequests > 36/);
  assert.match(harness, /\['#existing-assets-list', '#added-assets-list'\]\.every/);
  assert.match(harness, /minimumWindow:\s*DESKTOP_WINDOW_MINIMUM/);
});

test('smoothness baseline measures node, preview, event, hidden-render, and state stability', () => {
  for (const contract of [
    'primaryRowPreserved',
    'primaryVisualPreserved',
    'primaryImagePreserved',
    'getFileVisual',
    'emitFileBurst(10)',
    'hiddenDestinationUpdate',
    'projectRows',
    'searchValue',
    'activeFilter',
    'scrollTop',
    'focusId',
    'longTasks',
    'layoutShifts',
  ]) {
    assert.ok(harness.includes(contract), `missing baseline measurement ${contract}`);
  }
});

test('smoothness baseline audits navigation and immediate action acknowledgement', () => {
  for (const tabName of ['projects', 'quick-package', 'current-project', 'settings', 'help']) {
    assert.ok(harness.includes(`'${tabName}'`), `missing navigation target ${tabName}`);
  }
  for (const action of ['pauseProject', 'addFiles', 'figmaScanNow', 'packageReview']) {
    assert.ok(harness.includes(action), `missing action feedback audit ${action}`);
  }
  assert.match(harness, /immediateAcknowledgement/);
  assert.match(harness, /modalVisibleImmediately/);
});

test('baseline findings remain diagnostic while renderer or harness errors fail closed', () => {
  assert.match(harness, /findings:\s*createFindings\(results\)/);
  assert.match(harness, /const harnessFailed = results\.some/);
  assert.match(harness, /return harnessFailed \? 1 : 0;/);
  assert.match(harness, /app\.exit\(finalExitCode\)/);
});

test('smoothness baseline uses only synthetic evidence paths and no production mutation API', () => {
  assert.doesNotMatch(harness, /\/Users\//);
  assert.doesNotMatch(harness, /\/Volumes\//);
  assert.doesNotMatch(harness, /package-lock\.json/);
  assert.doesNotMatch(harness, /git\s+(?:commit|push|merge)/);
  assert.match(harness, /CRATE_SMOOTHNESS_EVIDENCE_DIR/);
});
