'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ENTRY_PATH = path.join(ROOT, 'renderer', 'styles.css');
const BASE_PATH = path.join(ROOT, 'renderer', 'styles-base.css');
const STABILITY_PATH = path.join(ROOT, 'renderer', 'ui-stability.css');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function block(source, heading) {
  const start = source.indexOf(heading);
  assert.notEqual(start, -1, `Expected CSS block ${heading}`);
  const bodyStart = source.indexOf('{', start);
  assert.notEqual(bodyStart, -1, `Expected opening brace for ${heading}`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart + 1, index);
    }
  }
  assert.fail(`Expected closing brace for ${heading}`);
}

const entry = read(ENTRY_PATH);
const base = read(BASE_PATH);
const stability = read(STABILITY_PATH);

function containerBlock(maxWidth) {
  return block(stability, `@container asset-review (max-width: ${maxWidth}px)`);
}

test('renderer stylesheet entry loads the established visual layer before UI stability overrides', () => {
  const baseImport = '@import url("./styles-base.css");';
  const stabilityImport = '@import url("./ui-stability.css");';

  assert.match(entry, /@import url\("\.\/styles-base\.css"\);/u);
  assert.match(entry, /@import url\("\.\/ui-stability\.css"\);/u);
  assert.ok(entry.indexOf(baseImport) < entry.indexOf(stabilityImport));
  assert.match(base, /\.project-dashboard,\s*\n\.asset-review-workspace\s*\{\s*min-width:\s*640px;/u);
});

test('Current Project and Review Assets respond to their available pane width', () => {
  const filesView = block(stability, '#files-view {');
  const reviewWorkspace = block(stability, '.asset-review-workspace {');

  assert.match(filesView, /container-name:\s*current-project;/u);
  assert.match(filesView, /container-type:\s*inline-size;/u);
  assert.match(reviewWorkspace, /container-name:\s*asset-review;/u);
  assert.match(reviewWorkspace, /container-type:\s*inline-size;/u);
  assert.match(reviewWorkspace, /min-height:\s*0;/u);
  assert.match(reviewWorkspace, /padding-bottom:\s*0;/u);
});

test('Review Assets header and controls reflow before they collide', () => {
  const header = block(stability, '.asset-review-header {');
  const toolbar = block(stability, '.asset-review-toolbar {');
  const medium = containerBlock(720);
  const narrow = containerBlock(640);

  assert.match(header, /grid-template-columns:\s*minmax\(0, 1fr\)\s+minmax\(230px, 320px\);/u);
  assert.match(toolbar, /grid-template-columns:\s*minmax\(0, 1fr\)\s+auto;/u);
  assert.match(medium, /\.asset-review-header\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/u);
  assert.match(medium, /\.asset-review-search\s*\{[^}]*width:\s*100%;[^}]*justify-self:\s*stretch;/su);
  assert.match(narrow, /\.asset-review-toolbar\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/u);
  assert.match(stability, /\.asset-review-filters,\s*\n\.asset-panel-actions,[\s\S]*flex-wrap:\s*wrap;/u);
});

test('asset cards use deterministic four, three, two, and compact-row density modes', () => {
  const defaultGrid = block(stability, '.asset-card-grid {');
  const threeColumns = containerBlock(900);
  const twoColumns = containerBlock(560);
  const compact = containerBlock(420);

  assert.match(defaultGrid, /grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);/u);
  assert.match(threeColumns, /grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/u);
  assert.match(twoColumns, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/u);
  assert.match(compact, /grid-template-columns:\s*minmax\(0, 1fr\);/u);
  assert.match(compact, /grid-template-columns:\s*64px\s+minmax\(0, 1fr\)\s+auto;/u);
  assert.match(compact, /\.asset-card-grid \.file-visual\s*\{[^}]*width:\s*64px;[^}]*height:\s*60px;/su);
});

test('Review Assets footer stays inside its work surface instead of using negative offsets', () => {
  const footer = block(stability, '.asset-review-footer {');

  assert.match(footer, /position:\s*sticky;/u);
  assert.match(footer, /bottom:\s*0;/u);
  assert.match(footer, /width:\s*100%;/u);
  assert.doesNotMatch(footer, /left:\s*-\d/u);
  assert.doesNotMatch(footer, /right:\s*-\d/u);
});

test('legacy fixed-width pressure is neutralized at the narrow shell boundary', () => {
  const narrowShell = block(stability, '@media (max-width: 760px)');
  const settings = block(stability, '#tab-settings.active {');

  assert.match(narrowShell, /#tab-current-project\.active,[\s\S]*\.asset-review-workspace\s*\{\s*min-width:\s*0;/u);
  assert.match(settings, /grid-template-columns:\s*repeat\(auto-fit, minmax\(min\(100%, 320px\), 1fr\)\);/u);
});

test('UI stability layer avoids whole-app scaling and respects reduced motion', () => {
  assert.doesNotMatch(stability, /\bzoom\s*:/u);
  assert.doesNotMatch(stability, /transform:\s*scale\(/u);
  assert.doesNotMatch(stability, /transition:\s*all\b/u);
  assert.match(stability, /@media \(prefers-reduced-motion:\s*reduce\)/u);
  assert.match(stability, /\.project-dot\.watching\s*\{\s*animation:\s*none;/u);
});
