const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

function cssRule(css, selectorPattern) {
  const match = css.match(new RegExp(`${selectorPattern}\\s*\\{([^}]*)\\}`, 'm'));
  assert.ok(match, `expected CSS rule for ${selectorPattern}`);
  return match[1];
}

test('renderer loads the responsive stability layer after the legacy visual layer', () => {
  const entryCss = read('renderer/styles.css');
  const indexHtml = read('renderer/index.html');

  assert.equal(
    entryCss.trim(),
    '@import url("./styles-base.css");\n@import url("./ui-stability.css");',
  );
  assert.match(indexHtml, /<link rel="stylesheet" href="styles\.css">/);
  assert.doesNotMatch(indexHtml, /href="(?:styles-base|ui-stability)\.css"/);
});

test('Review Assets owns responsive geometry without scaling or sideways scrolling', () => {
  const css = read('renderer/ui-stability.css');

  assert.match(css, /\.asset-review-workspace\s*\{[^}]*container-name:\s*asset-review;[^}]*container-type:\s*inline-size;/s);
  assert.match(css, /\.asset-review-header\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\)\s+minmax\(230px, 320px\);/s);
  assert.match(css, /\.asset-review-toolbar\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\)\s+auto;/s);
  assert.match(css, /@container asset-review \(max-width:\s*720px\)/);
  assert.match(css, /@container asset-review \(max-width:\s*640px\)/);
  assert.match(css, /@container asset-review \(max-width:\s*560px\)/);
  assert.match(css, /@container asset-review \(max-width:\s*420px\)/);
  assert.match(css, /overflow-x:\s*clip;/);
  assert.doesNotMatch(css, /\bzoom\s*:/);
  assert.doesNotMatch(css, /transform:\s*scale\(/);
});

test('asset previews keep a bounded row and compact mode uses a fixed preview', () => {
  const css = read('renderer/ui-stability.css');
  const cardRule = cssRule(css, '\\.asset-card-grid \\.asset-file-row');
  const visualRule = cssRule(css, '\\.asset-card-grid \\.file-visual');

  assert.match(cardRule, /grid-template-rows:\s*112px\s+auto\s+auto;/);
  assert.match(cardRule, /overflow:\s*hidden;/);
  assert.match(visualRule, /height:\s*112px;/);
  assert.match(visualRule, /min-height:\s*112px;/);
  assert.match(visualRule, /aspect-ratio:\s*auto;/);

  assert.match(
    css,
    /@container asset-review \(max-width:\s*420px\)[\s\S]*\.asset-card-grid \.file-visual\s*\{[^}]*width:\s*64px;[^}]*height:\s*60px;[^}]*min-height:\s*60px;/,
  );
});

test('Review Assets footer stays in its surface and reflows to one column', () => {
  const css = read('renderer/ui-stability.css');
  const footerRule = cssRule(css, '\\.asset-review-footer');

  assert.match(footerRule, /position:\s*sticky;/);
  assert.match(footerRule, /display:\s*grid;/);
  assert.match(footerRule, /grid-template-columns:\s*minmax\(0, 1fr\)\s+auto;/);
  assert.match(footerRule, /right:\s*auto;/);
  assert.match(footerRule, /left:\s*auto;/);
  assert.doesNotMatch(footerRule, /-24px/);

  assert.match(
    css,
    /@container asset-review \(max-width:\s*640px\)[\s\S]*\.asset-review-footer\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/,
  );
});

test('legacy fixed widths are neutralized at the narrow fallback boundary', () => {
  const css = read('renderer/ui-stability.css');

  assert.match(
    css,
    /@media \(max-width:\s*760px\)[\s\S]*#tab-current-project\.active,[\s\S]*#tab-settings\.active,[\s\S]*\.project-dashboard,[\s\S]*\.asset-review-workspace\s*\{[^}]*min-width:\s*0;/,
  );
});
