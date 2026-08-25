'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const rendererDir = path.join(__dirname, '..', 'renderer');
const stylesheetEntry = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
const baseStyles = fs.readFileSync(path.join(rendererDir, 'styles-base.css'), 'utf8');
const stabilityStyles = fs.readFileSync(path.join(rendererDir, 'ui-stability.css'), 'utf8');

function ruleFor(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = stabilityStyles.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match ? match[1] : '';
}

test('renderer loads the established visual system before the UI stability layer', () => {
  assert.match(stylesheetEntry, /@import url\("\.\/styles-base\.css"\);/);
  assert.match(stylesheetEntry, /@import url\("\.\/ui-stability\.css"\);/);
  assert.ok(
    stylesheetEntry.indexOf('styles-base.css') < stylesheetEntry.indexOf('ui-stability.css'),
    'responsive corrections must load after the established visual system'
  );
  assert.match(baseStyles, /\/\* ===== Reset & Variables ===== \*\//);
});

test('Current Project and Review Assets respond to their available pane width', () => {
  assert.match(ruleFor('#files-view'), /container-name:\s*current-project;/);
  assert.match(ruleFor('#files-view'), /container-type:\s*inline-size;/);
  assert.match(ruleFor('.asset-review-workspace'), /container-name:\s*asset-review;/);
  assert.match(ruleFor('.asset-review-workspace'), /container-type:\s*inline-size;/);
  assert.doesNotMatch(stabilityStyles, /min-width:\s*(?:640|680|800)px;/);
  assert.match(stabilityStyles, /\.project-dashboard,\s*\n\.asset-review-workspace[\s\S]*?min-width:\s*0;/);
});

test('Review Assets header and toolbar stack before controls collide', () => {
  assert.match(
    ruleFor('.asset-review-header'),
    /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(230px,\s*320px\);/
  );
  assert.match(
    ruleFor('.asset-review-toolbar'),
    /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;/
  );
  assert.match(
    stabilityStyles,
    /@container asset-review \(max-width:\s*720px\)[\s\S]*?\.asset-review-header\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/
  );
  assert.match(
    stabilityStyles,
    /@container asset-review \(max-width:\s*640px\)[\s\S]*?\.asset-review-toolbar\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/
  );
  assert.match(ruleFor('.asset-review-search input'), /width:\s*100%;/);
});

test('asset presentation reduces density instead of crushing card contents', () => {
  assert.match(ruleFor('.asset-card-grid'), /repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(
    stabilityStyles,
    /@container asset-review \(max-width:\s*900px\)[\s\S]*?\.asset-card-grid\s*\{[^}]*repeat\(3,\s*minmax\(0,\s*1fr\)\)/
  );
  assert.match(
    stabilityStyles,
    /@container asset-review \(max-width:\s*560px\)[\s\S]*?\.asset-card-grid\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/
  );
  assert.match(
    stabilityStyles,
    /@container asset-review \(max-width:\s*420px\)[\s\S]*?\.asset-card-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/
  );
  assert.match(
    stabilityStyles,
    /@container asset-review \(max-width:\s*420px\)[\s\S]*?\.asset-card-grid \.asset-file-row\s*\{[^}]*grid-template-columns:\s*64px\s+minmax\(0,\s*1fr\)\s+auto;/
  );
});

test('Review Assets footer stays inside its surface without negative offsets', () => {
  const footerRule = ruleFor('.asset-review-footer');
  assert.match(footerRule, /position:\s*sticky;/);
  assert.match(footerRule, /width:\s*100%;/);
  assert.match(footerRule, /left:\s*auto;/);
  assert.match(footerRule, /right:\s*auto;/);
  assert.doesNotMatch(stabilityStyles, /(?:left|right):\s*-24px;/);
});

test('responsive layer contains paint and respects reduced-motion preferences', () => {
  assert.match(stabilityStyles, /overflow-x:\s*clip;/);
  assert.match(ruleFor('.project-dot.watching'), /animation:\s*none;/);
  assert.match(
    stabilityStyles,
    /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*animation-duration:\s*0\.01ms\s*!important;/
  );
  assert.doesNotMatch(ruleFor('.v2-drop-zone'), /transition:\s*all/);
});
