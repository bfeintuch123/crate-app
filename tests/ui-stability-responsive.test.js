'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer');
const entry = fs.readFileSync(path.join(RENDERER, 'styles.css'), 'utf8');
const base = fs.readFileSync(path.join(RENDERER, 'styles-base.css'), 'utf8');
const stability = fs.readFileSync(path.join(RENDERER, 'ui-stability.css'), 'utf8');
const mainSource = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

function captureNumber(source, pattern, label) {
  const match = source.match(pattern);
  assert.ok(match, `expected ${label}`);
  const value = Number(match[1]);
  assert.equal(Number.isFinite(value), true, `expected finite ${label}`);
  return value;
}

function cssBlock(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `expected CSS marker ${marker}`);
  const opening = source.indexOf('{', start);
  assert.notEqual(opening, -1, `expected opening brace for ${marker}`);
  let depth = 0;
  let inComment = false;
  let quote = null;

  for (let index = opening; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (inComment) {
      if (char === '*' && next === '/') {
        inComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '*') {
      inComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(opening + 1, index);
    }
  }

  assert.fail(`expected closing brace for ${marker}`);
}

test('renderer loads the preserved visual system before the responsive stability layer', () => {
  const baseImport = '@import url("./styles-base.css");';
  const stabilityImport = '@import url("./ui-stability.css");';

  assert.ok(entry.includes(baseImport));
  assert.ok(entry.includes(stabilityImport));
  assert.ok(entry.indexOf(baseImport) < entry.indexOf(stabilityImport));
  assert.equal(fs.existsSync(path.join(RENDERER, 'responsive.css')), false);
  assert.match(base, /\/\* ===== Reset & Variables ===== \*\//);
});

test('the inherited fixed minimum exceeded the default window content budget', () => {
  const windowWidth = captureNumber(
    mainSource,
    /new BrowserWindow\(\{[\s\S]*?\bwidth:\s*(\d+),/,
    'BrowserWindow width',
  );
  const sidebarWidth = captureNumber(
    base,
    /\.app-sidebar\s*\{[\s\S]*?\bwidth:\s*(\d+)px;/,
    'sidebar width',
  );
  const appMainInlinePadding = captureNumber(
    base,
    /\.app-main\s*\{[^}]*padding:\s*\d+px\s+(\d+)px;/,
    'app main inline padding',
  );
  const tabPadding = captureNumber(
    base,
    /\.tab-content\s*\{[^}]*padding:\s*(\d+)px;/,
    'tab content padding',
  );
  const filesViewPadding = captureNumber(
    base,
    /#projects-list,\s*#files-view,[\s\S]*?\{\s*padding:\s*(\d+)px;/,
    'files view padding',
  );
  const legacyMinimum = captureNumber(
    base,
    /\.project-dashboard,\s*\.asset-review-workspace\s*\{\s*min-width:\s*(\d+)px;/,
    'legacy Review Assets minimum',
  );

  const estimatedReviewWidth = windowWidth
    - sidebarWidth
    - (2 * appMainInlinePadding)
    - (2 * tabPadding)
    - (2 * filesViewPadding);

  assert.equal(windowWidth, 960);
  assert.equal(sidebarWidth, 212);
  assert.equal(legacyMinimum, 640);
  assert.equal(estimatedReviewWidth, 608);
  assert.ok(estimatedReviewWidth < legacyMinimum);
});

test('responsive layer neutralizes fixed-width canvas pressure without scaling the app', () => {
  assert.match(
    stability,
    /\.app-content,\s*\.tab-content,\s*#files-view,\s*\.project-dashboard,\s*\.asset-review-workspace,[\s\S]*?#tab-settings\.active\s*\{\s*min-width:\s*0;\s*max-width:\s*100%;\s*\}/,
  );
  assert.match(stability, /\.app-content,[\s\S]*?overflow-x:\s*clip;/);
  assert.match(
    stability,
    /@media \(max-width:\s*760px\)[\s\S]*?#tab-current-project\.active,[\s\S]*?\.asset-review-workspace\s*\{\s*min-width:\s*0;/,
  );
  assert.doesNotMatch(stability, /min-width:\s*(?:640|680|800)px;/);
  assert.doesNotMatch(stability, /\bzoom\s*:/i);
  assert.doesNotMatch(stability, /transform:\s*scale\(/i);
});

test('Review Assets owns header and toolbar reflow based on its available pane width', () => {
  const review = cssBlock(stability, '.asset-review-workspace {');
  const header = cssBlock(stability, '.asset-review-header {');
  const toolbar = cssBlock(stability, '.asset-review-toolbar {');
  const medium = cssBlock(stability, '@container asset-review (max-width: 720px)');
  const narrow = cssBlock(stability, '@container asset-review (max-width: 640px)');

  assert.match(review, /container-name:\s*asset-review;/);
  assert.match(review, /container-type:\s*inline-size;/);
  assert.match(header, /display:\s*grid;/);
  assert.match(header, /grid-template-columns:\s*minmax\(0, 1fr\)\s+minmax\(230px, 320px\);/);
  assert.match(toolbar, /display:\s*grid;/);
  assert.match(toolbar, /grid-template-columns:\s*minmax\(0, 1fr\)\s+auto;/);
  assert.match(medium, /\.asset-review-header\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/);
  assert.match(medium, /\.asset-review-search\s*\{[^}]*width:\s*100%;[^}]*justify-self:\s*stretch;/s);
  assert.match(narrow, /\.asset-review-toolbar\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/);
});

test('asset presentation steps from four cards to compact readable rows', () => {
  const defaultGrid = cssBlock(stability, '.asset-card-grid {');
  const threeColumns = cssBlock(stability, '@container asset-review (max-width: 900px)');
  const twoColumns = cssBlock(stability, '@container asset-review (max-width: 560px)');
  const compact = cssBlock(stability, '@container asset-review (max-width: 420px)');

  assert.match(defaultGrid, /repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(threeColumns, /repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(twoColumns, /repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(compact, /grid-template-columns:\s*minmax\(0, 1fr\);/);
  assert.match(compact, /grid-template-columns:\s*64px\s+minmax\(0, 1fr\)\s+auto;/);
  assert.match(compact, /\.asset-card-grid \.file-visual\s*\{[^}]*width:\s*64px;[^}]*height:\s*60px;/s);
});

test('Review Assets footer stays inside the workspace instead of using negative offsets', () => {
  const footer = cssBlock(stability, '.asset-review-footer {');

  assert.match(footer, /position:\s*sticky;/);
  assert.match(footer, /right:\s*auto;/);
  assert.match(footer, /left:\s*auto;/);
  assert.match(footer, /width:\s*100%;/);
  assert.doesNotMatch(footer, /position:\s*absolute;/);
  assert.doesNotMatch(footer, /(?:left|right):\s*-\d/);
});

test('Settings and dialogs shrink within the app canvas', () => {
  assert.match(
    stability,
    /#tab-settings\.active\s*\{\s*width:\s*100%;\s*grid-template-columns:\s*repeat\(auto-fit, minmax\(min\(100%, 320px\), 1fr\)\);/,
  );
  assert.match(
    stability,
    /\.modal\s*\{\s*max-width:\s*calc\(100vw - 32px\);\s*max-height:\s*calc\(100vh - 32px\);/,
  );
  assert.match(stability, /\.existing-assets-modal-list\s*\{[^}]*repeat\(auto-fit,/s);
  assert.match(stability, /\.package-review-assets \.modal-file-list\s*\{[^}]*repeat\(auto-fit,/s);
});

test('stable states do not pulse forever and reduced-motion preferences are respected', () => {
  assert.match(stability, /\.project-dot\.watching\s*\{\s*animation:\s*none;/);
  assert.doesNotMatch(stability, /transition:\s*all\b/);
  assert.match(
    stability,
    /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?animation-duration:\s*0\.01ms\s*!important;[\s\S]*?transition-duration:\s*0\.01ms\s*!important;/,
  );
});
