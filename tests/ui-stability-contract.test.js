'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const rendererDir = path.join(__dirname, '..', 'renderer');
const entryCss = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
const baseCss = fs.readFileSync(path.join(rendererDir, 'styles-base.css'), 'utf8');
const stabilityCss = fs.readFileSync(path.join(rendererDir, 'ui-stability.css'), 'utf8');

function ruleBody(css, selectorPattern) {
  const match = css.match(new RegExp(`${selectorPattern}\\s*\\{([\\s\\S]*?)\\}`, 'm'));
  assert.ok(match, `expected rule matching ${selectorPattern}`);
  return match[1];
}

function assertBalancedBraces(css, label) {
  let depth = 0;
  let inComment = false;
  let inString = null;

  for (let index = 0; index < css.length; index += 1) {
    const char = css[index];
    const next = css[index + 1];

    if (inComment) {
      if (char === '*' && next === '/') {
        inComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      if (char === '\\') {
        index += 1;
      } else if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      inComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    assert.ok(depth >= 0, `${label} closes more braces than it opens`);
  }

  assert.equal(inComment, false, `${label} contains an unterminated comment`);
  assert.equal(inString, null, `${label} contains an unterminated string`);
  assert.equal(depth, 0, `${label} contains unbalanced braces`);
}

test('renderer stylesheet entry loads preserved base before UI stability overrides', () => {
  const baseImport = '@import url("./styles-base.css");';
  const stabilityImport = '@import url("./ui-stability.css");';

  assert.ok(entryCss.includes(baseImport));
  assert.ok(entryCss.includes(stabilityImport));
  assert.ok(entryCss.indexOf(baseImport) < entryCss.indexOf(stabilityImport));
  assert.ok(baseCss.length > 50_000, 'base stylesheet should preserve the established visual system');
  assert.ok(stabilityCss.length > 5_000, 'responsive layer should contain the full stability contract');
  assertBalancedBraces(baseCss, 'styles-base.css');
  assertBalancedBraces(stabilityCss, 'ui-stability.css');
});

test('responsive layer neutralizes fixed-width work surfaces without scaling the app', () => {
  const containment = ruleBody(
    stabilityCss,
    '\\.app-content,\\s*\\.tab-content,\\s*#files-view,\\s*\\.project-dashboard,\\s*\\.asset-review-workspace'
  );
  assert.match(containment, /min-width:\s*0;/);
  assert.match(containment, /max-width:\s*100%;/);

  assert.match(stabilityCss, /#files-view\s*\{[^}]*container-name:\s*current-project;/s);
  assert.match(stabilityCss, /\.asset-review-workspace\s*\{[^}]*container-name:\s*asset-review;/s);
  assert.match(stabilityCss, /@media \(max-width:\s*760px\)[\s\S]*#tab-current-project\.active[\s\S]*min-width:\s*0;/);

  assert.doesNotMatch(stabilityCss, /\bzoom\s*:/i);
  assert.doesNotMatch(stabilityCss, /transform:\s*scale\(/i);
});

test('Review Assets has explicit adaptive header, toolbar, grid, and compact-row states', () => {
  const header = ruleBody(stabilityCss, '\\.asset-review-header');
  assert.match(header, /display:\s*grid;/);
  assert.match(header, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(230px,\s*320px\);/);

  const toolbar = ruleBody(stabilityCss, '\\.asset-review-toolbar');
  assert.match(toolbar, /display:\s*grid;/);
  assert.match(toolbar, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;/);

  assert.match(stabilityCss, /@container asset-review \(max-width:\s*720px\)[\s\S]*\.asset-review-header[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  assert.match(stabilityCss, /@container asset-review \(max-width:\s*640px\)[\s\S]*\.asset-review-toolbar[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  assert.match(stabilityCss, /@container asset-review \(max-width:\s*900px\)[\s\S]*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(stabilityCss, /@container asset-review \(max-width:\s*560px\)[\s\S]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(stabilityCss, /@container asset-review \(max-width:\s*420px\)[\s\S]*grid-template-columns:\s*64px\s+minmax\(0,\s*1fr\)\s+auto;/);
});

test('Review Assets footer stays inside the workspace and motion respects user preference', () => {
  const footer = ruleBody(stabilityCss, '\\.asset-review-footer');
  assert.match(footer, /position:\s*sticky;/);
  assert.match(footer, /width:\s*100%;/);
  assert.match(footer, /right:\s*auto;/);
  assert.match(footer, /left:\s*auto;/);
  assert.doesNotMatch(footer, /-24px/);

  assert.match(stabilityCss, /\.project-dot\.watching\s*\{[^}]*animation:\s*none;/s);
  assert.match(stabilityCss, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(ruleBody(stabilityCss, '\\.v2-drop-zone'), /transition:\s*all/);
});

test('Settings and dialogs use flexible widths instead of expanding the application canvas', () => {
  const settings = ruleBody(stabilityCss, '#tab-settings\\.active');
  assert.match(settings, /width:\s*100%;/);
  assert.match(settings, /grid-template-columns:\s*repeat\(auto-fit,/);

  const modal = ruleBody(stabilityCss, '\\.modal');
  assert.match(modal, /max-width:\s*calc\(100vw\s*-\s*32px\);/);
  assert.match(modal, /max-height:\s*calc\(100vh\s*-\s*32px\);/);

  assert.match(stabilityCss, /\.existing-assets-modal-list\s*\{[^}]*repeat\(auto-fit,/s);
  assert.match(stabilityCss, /\.package-review-assets \.modal-file-list\s*\{[^}]*repeat\(auto-fit,/s);
});
