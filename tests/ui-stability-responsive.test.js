'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { isAllowedAsarEntry } = require('../scripts/verify-app-contents');

const rendererDir = path.join(__dirname, '..', 'renderer');
const index = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
const baseStyles = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
const stabilityMatch = index.match(/<style id="crate-ui-stability">([\s\S]*?)<\/style>/u);
assert.ok(stabilityMatch, 'renderer/index.html must contain the source-bound UI-stability style block');
const stability = stabilityMatch[1];

function requireInOrder(source, first, second, label) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  assert.notEqual(firstIndex, -1, `${label} must contain ${first}`);
  assert.notEqual(secondIndex, -1, `${label} must contain ${second}`);
  assert.ok(firstIndex < secondIndex, `${label} must load ${first} before ${second}`);
}

test('renderer keeps responsive UI inside existing source-bound files', () => {
  requireInOrder(
    index,
    '<link rel="stylesheet" href="styles.css">',
    '<style id="crate-ui-stability">',
    'renderer/index.html',
  );
  assert.equal(fs.existsSync(path.join(rendererDir, 'ui-stability.css')), false);
  assert.equal(fs.existsSync(path.join(rendererDir, 'responsive.css')), false);
  assert.doesNotMatch(baseStyles, /@import\s+url\("\.\/(?:ui-stability|responsive)\.css"\)/u);

  for (const entry of [
    '/renderer/app.js',
    '/renderer/index.html',
    '/renderer/styles.css',
  ]) {
    assert.equal(isAllowedAsarEntry(entry), true, `${entry} must remain allowed`);
  }

  for (const entry of [
    '/renderer/ui-stability.css',
    '/renderer/responsive.css',
  ]) {
    assert.equal(isAllowedAsarEntry(entry), false, `${entry} must remain disallowed`);
  }
});

test('responsive layer establishes a shrink contract without scaling the application', () => {
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
    /#tab-settings\.active\s*\{[\s\S]*?width:\s*100%;[\s\S]*?grid-template-columns:\s*repeat\(auto-fit,/,
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
  const footerEnd = stability.indexOf('\n    }', footerStart);
  assert.notEqual(footerStart, -1);
  assert.notEqual(footerEnd, -1);
  const footerRule = stability.slice(footerStart, footerEnd + 6);

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

test('short-height windows keep the Review Assets footer in normal flow', () => {
  assert.match(
    stability,
    /@media \(max-height:\s*600px\)[\s\S]*?\.asset-review-footer\s*\{[\s\S]*?position:\s*static;[\s\S]*?bottom:\s*auto;/,
  );
});

test('legacy narrow window wraps navigation and keeps content inside the shell', () => {
  assert.match(
    stability,
    /@media \(max-width:\s*760px\)[\s\S]*?\.app-sidebar\s*\{[\s\S]*?grid-template-areas:\s*"brand"\s*"primary"\s*"support";/,
  );
  assert.match(
    stability,
    /@media \(max-width:\s*760px\)[\s\S]*?\.app-tabs,\s*\.app-tabs-secondary\s*\{\s*flex-wrap:\s*wrap;/,
  );
  assert.match(
    stability,
    /@media \(max-width:\s*760px\)[\s\S]*?\.app-tab\s*\{[\s\S]*?flex:\s*1 1 120px;[\s\S]*?min-width:\s*0;[\s\S]*?justify-content:\s*center;/,
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

test('stability layer replaces broad drop-zone motion and respects reduced motion', () => {
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
