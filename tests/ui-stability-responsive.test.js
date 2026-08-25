'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const rendererDir = path.join(__dirname, '..', 'renderer');
const indexHtml = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
const establishedStyles = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
const stabilityStyles = fs.readFileSync(path.join(rendererDir, 'ui-stability.css'), 'utf8');

function requireInOrder(source, first, second, label) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  assert.notEqual(firstIndex, -1, `${label} must contain ${first}`);
  assert.notEqual(secondIndex, -1, `${label} must contain ${second}`);
  assert.ok(firstIndex < secondIndex, `${label} must load ${first} before ${second}`);
}

function firstRule(source, selector) {
  const start = source.indexOf(selector);
  assert.notEqual(start, -1, `missing ${selector}`);
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1, `unterminated ${selector}`);
  return source.slice(start, end + 2);
}

test('renderer loads the established visual system before the UI stability layer', () => {
  requireInOrder(
    indexHtml,
    '<link rel="stylesheet" href="styles.css">',
    '<link rel="stylesheet" href="ui-stability.css">',
    'renderer/index.html',
  );
  assert.doesNotMatch(establishedStyles, /@import\s+url\([^)]*ui-stability\.css/);
});

test('responsive layer neutralizes fixed-width work surfaces without changing renderer behavior', () => {
  assert.match(
    stabilityStyles,
    /\.app-content,[\s\S]*?\.asset-review-workspace,[\s\S]*?#tab-settings\.active\s*\{\s*min-width:\s*0;\s*max-width:\s*100%;/,
  );
  assert.match(
    stabilityStyles,
    /@media \(max-width:\s*760px\)[\s\S]*?#tab-current-project\.active,[\s\S]*?\.asset-review-workspace\s*\{\s*min-width:\s*0;/,
  );
  assert.match(
    stabilityStyles,
    /#tab-settings\.active\s*\{\s*width:\s*100%;\s*grid-template-columns:\s*repeat\(auto-fit,/,
  );
});

test('Review Assets responds to its own available pane width', () => {
  assert.match(
    stabilityStyles,
    /\.asset-review-workspace\s*\{[\s\S]*?container-name:\s*asset-review;[\s\S]*?container-type:\s*inline-size;/,
  );
  assert.match(
    stabilityStyles,
    /@container asset-review \(max-width:\s*720px\)[\s\S]*?\.asset-review-header\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/,
  );
  assert.match(
    stabilityStyles,
    /@container asset-review \(max-width:\s*640px\)[\s\S]*?\.asset-review-toolbar\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/,
  );
});

test('asset presentation steps down from four cards to a compact readable row', () => {
  assert.match(stabilityStyles, /\.asset-card-grid\s*\{\s*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);/);
  assert.match(
    stabilityStyles,
    /@container asset-review \(max-width:\s*900px\)[\s\S]*?grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/,
  );
  assert.match(
    stabilityStyles,
    /@container asset-review \(max-width:\s*560px\)[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/,
  );
  assert.match(
    stabilityStyles,
    /@container asset-review \(max-width:\s*420px\)[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);[\s\S]*?grid-template-columns:\s*64px minmax\(0, 1fr\) auto;/,
  );
});

test('Review Assets footer stays contained instead of extending with negative offsets', () => {
  const footerRule = firstRule(stabilityStyles, '.asset-review-footer {');
  assert.match(footerRule, /position:\s*sticky;/);
  assert.match(footerRule, /right:\s*auto;/);
  assert.match(footerRule, /left:\s*auto;/);
  assert.match(footerRule, /width:\s*100%;/);
  assert.doesNotMatch(footerRule, /-24px/);
});

test('stability layer avoids broad transitions and respects reduced motion', () => {
  assert.doesNotMatch(stabilityStyles, /transition:\s*all\b/);
  assert.match(
    stabilityStyles,
    /\.v2-drop-zone\s*\{\s*transition:[\s\S]*?border-color[\s\S]*?background-color/,
  );
  assert.match(
    stabilityStyles,
    /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?animation-duration:\s*0\.01ms !important;[\s\S]*?transition-duration:\s*0\.01ms !important;/,
  );
});
