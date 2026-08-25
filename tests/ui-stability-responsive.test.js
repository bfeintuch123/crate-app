'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const rendererDir = path.join(__dirname, '..', 'renderer');
const index = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
const base = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
const stability = fs.readFileSync(path.join(rendererDir, 'ui-stability.css'), 'utf8');

function requireInOrder(source, first, second, label) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  assert.notEqual(firstIndex, -1, `${label} must contain ${first}`);
  assert.notEqual(secondIndex, -1, `${label} must contain ${second}`);
  assert.ok(firstIndex < secondIndex, `${label} must load ${first} before ${second}`);
}

test('renderer loads the established stylesheet before the responsive stability layer', () => {
  requireInOrder(
    index,
    '<link rel="stylesheet" href="styles.css">',
    '<link rel="stylesheet" href="ui-stability.css">',
    'renderer/index.html',
  );
});

test('responsive layer explicitly neutralizes legacy fixed-width surfaces', () => {
  assert.match(
    base,
    /\.project-dashboard,\s*\.asset-review-workspace\s*\{\s*min-width:\s*640px;/,
    'the test must continue documenting the inherited fixed-width defect',
  );
  assert.match(
    base,
    /#tab-current-project\.active\s*\{\s*min-width:\s*680px;/,
    'the test must continue documenting the inherited narrow-window defect',
  );

  assert.match(
    stability,
    /\.app-content,[\s\S]*?\.asset-review-workspace,[\s\S]*?#tab-settings\.active\s*\{\s*min-width:\s*0;\s*max-width:\s*100%;/,
  );
  assert.match(
    stability,
    /@media \(max-width:\s*760px\)[\s\S]*?#tab-current-project\.active,[\s\S]*?\.asset-review-workspace\s*\{\s*min-width:\s*0;/,
  );
  assert.match(
    stability,
    /#tab-settings\.active\s*\{\s*width:\s*100%;\s*grid-template-columns:\s*repeat\(auto-fit,/,
  );
  assert.doesNotMatch(stability, /\bzoom\s*:/);
  assert.doesNotMatch(stability, /transform:\s*scale\s*\(/);
});

test('Review Assets responds to its own pane width instead of the outer window alone', () => {
  assert.match(
    stability,
    /#files-view\s*\{[\s\S]*?container-name:\s*current-project;[\s\S]*?container-type:\s*inline-size;/,
  );
  assert.match(
    stability,
    /\.asset-review-workspace\s*\{[\s\S]*?container-name:\s*asset-review;[\s\S]*?container-type:\s*inline-size;/,
  );
  assert.match(
    stability,
    /@container asset-review \(max-width:\s*720px\)[\s\S]*?\.asset-review-header\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/,
  );
  assert.match(
    stability,
    /@container asset-review \(max-width:\s*640px\)[\s\S]*?\.asset-review-toolbar\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/,
  );
});

test('asset presentation steps down from stable cards to a compact readable row', () => {
  assert.match(stability, /\.asset-card-grid\s*\{\s*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);/);
  assert.match(
    stability,
    /\.asset-card-grid \.asset-file-row\s*\{[\s\S]*?grid-template-rows:\s*112px auto auto;/,
  );
  assert.match(
    stability,
    /\.asset-card-grid \.file-visual\s*\{[\s\S]*?height:\s*112px;[\s\S]*?min-height:\s*112px;/,
  );
  assert.match(
    stability,
    /@container asset-review \(max-width:\s*900px\)[\s\S]*?grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/,
  );
  assert.match(
    stability,
    /@container asset-review \(max-width:\s*560px\)[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);[\s\S]*?grid-template-rows:\s*88px auto auto;[\s\S]*?height:\s*88px;[\s\S]*?min-height:\s*88px;/,
  );
  assert.match(
    stability,
    /@container asset-review \(max-width:\s*420px\)[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);[\s\S]*?grid-template-columns:\s*64px minmax\(0, 1fr\) auto;[\s\S]*?height:\s*60px;[\s\S]*?min-height:\s*60px;/,
  );
});

test('Review Assets footer stays within the workspace and stacks at narrow widths', () => {
  const footerStart = stability.indexOf('.asset-review-footer {');
  const footerEnd = stability.indexOf('\n}', footerStart);
  assert.notEqual(footerStart, -1);
  assert.notEqual(footerEnd, -1);
  const footerRule = stability.slice(footerStart, footerEnd + 2);

  assert.match(footerRule, /position:\s*sticky;/);
  assert.match(footerRule, /right:\s*auto;/);
  assert.match(footerRule, /left:\s*auto;/);
  assert.match(footerRule, /display:\s*grid;/);
  assert.match(footerRule, /grid-template-columns:\s*minmax\(0, 1fr\) auto;/);
  assert.match(footerRule, /width:\s*100%;/);
  assert.doesNotMatch(footerRule, /-24px/);
  assert.match(
    stability,
    /@container asset-review \(max-width:\s*640px\)[\s\S]*?\.asset-review-footer\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/,
  );
});

test('Settings and dialogs shrink inside the available window', () => {
  assert.match(
    stability,
    /#tab-settings\.active\s*\{[\s\S]*?width:\s*100%;[\s\S]*?repeat\(auto-fit, minmax\(min\(100%, 320px\), 1fr\)\);/,
  );
  assert.match(
    stability,
    /\.modal\s*\{[\s\S]*?max-width:\s*calc\(100vw - 32px\);[\s\S]*?max-height:\s*calc\(100vh - 32px\);[\s\S]*?overflow-y:\s*auto;/,
  );
  assert.match(
    stability,
    /\.existing-assets-modal-list\s*\{[\s\S]*?repeat\(auto-fit, minmax\(130px, 1fr\)\);/,
  );
  assert.match(
    stability,
    /\.package-review-assets \.modal-file-list\s*\{[\s\S]*?repeat\(auto-fit, minmax\(100px, 1fr\)\);/,
  );
});

test('stability layer avoids broad transitions and respects reduced motion', () => {
  assert.doesNotMatch(stability, /transition:\s*all\b/);
  assert.match(stability, /\.project-dot\.watching\s*\{\s*animation:\s*none;/);
  assert.match(
    stability,
    /\.v2-drop-zone\s*\{\s*transition:[\s\S]*?border-color[\s\S]*?background-color/,
  );
  assert.match(
    stability,
    /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?animation-duration:\s*0\.01ms !important;[\s\S]*?transition-duration:\s*0\.01ms !important;/,
  );
});
