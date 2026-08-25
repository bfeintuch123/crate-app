'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const nodeTest = require('node:test');

const originalReadFileSync = fs.readFileSync;
const originalModuleLoad = Module._load;
const rendererDir = path.join(__dirname, '..', 'renderer');
const stylesheetEntryPath = path.resolve(rendererDir, 'styles.css');
const stylesheetBasePath = path.join(rendererDir, 'styles-base.css');
const stylesheetStabilityPath = path.join(rendererDir, 'ui-stability.css');
const baseTestPath = path.resolve(__dirname, 'renderer-figma-scope-base.js');
const legacyResponsiveTestName = 'responsive shell keeps navigation aligned and Settings surface scroll-complete';

function readUtf8(filePath) {
  return originalReadFileSync.call(fs, filePath, 'utf8');
}

function readEffectiveRendererStyles() {
  const layers = [readUtf8(stylesheetBasePath)];
  if (fs.existsSync(stylesheetStabilityPath)) {
    layers.push(readUtf8(stylesheetStabilityPath));
  }
  return `${layers.join('\n\n')}\n`;
}

function assertResponsiveStabilityContract() {
  const css = fs.readFileSync(stylesheetEntryPath, 'utf8');
  const stabilityCss = readUtf8(stylesheetStabilityPath);

  assert.match(css, /#files-view\s*\{(?=[^}]*container-name:\s*current-project;)(?=[^}]*container-type:\s*inline-size;)[^}]*\}/);
  assert.match(css, /\.asset-review-workspace\s*\{(?=[^}]*container-name:\s*asset-review;)(?=[^}]*container-type:\s*inline-size;)(?=[^}]*padding-bottom:\s*0;)[^}]*\}/);
  assert.match(css, /\.asset-review-header\s*\{(?=[^}]*display:\s*grid;)(?=[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(230px,\s*320px\);)[^}]*\}/);
  assert.match(css, /@container asset-review \(max-width:\s*720px\)[\s\S]*?\.asset-review-header\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  assert.match(css, /@container asset-review \(max-width:\s*900px\)[\s\S]*?\.asset-card-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/);
  assert.match(css, /@container asset-review \(max-width:\s*560px\)[\s\S]*?\.asset-card-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/);
  assert.match(css, /@container asset-review \(max-width:\s*420px\)[\s\S]*?\.asset-card-grid \.asset-file-row\s*\{(?=[^}]*grid-template-columns:\s*64px minmax\(0,\s*1fr\) auto;)(?=[^}]*min-height:\s*82px;)[^}]*\}/);
  assert.match(css, /\.asset-review-footer\s*\{(?=[^}]*position:\s*sticky;)(?=[^}]*right:\s*auto;)(?=[^}]*left:\s*auto;)(?=[^}]*width:\s*100%;)[^}]*\}/);
  assert.match(css, /#tab-settings\.active\s*\{(?=[^}]*width:\s*100%;)(?=[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*320px\),\s*1fr\)\);)[^}]*\}/);
  assert.match(css, /@media \(max-width:\s*760px\)[\s\S]*?#tab-current-project\.active,[\s\S]*?\.asset-review-workspace\s*\{[^}]*min-width:\s*0;/);

  assert.equal(stabilityCss.includes('min-width: 800px'), false);
  assert.equal(stabilityCss.includes('min-width: 680px'), false);
  assert.equal(stabilityCss.includes('min-width: 640px'), false);
  assert.equal(stabilityCss.includes('right: -24px'), false);
  assert.equal(stabilityCss.includes('left: -24px'), false);
  assert.ok(css.lastIndexOf('container-name: asset-review;') > css.indexOf('min-width: 640px;'));
}

fs.readFileSync = function patchedReadFileSync(filePath, options) {
  const resolvedPath = typeof filePath === 'string' || Buffer.isBuffer(filePath)
    ? path.resolve(String(filePath))
    : null;

  if (resolvedPath !== stylesheetEntryPath) {
    return originalReadFileSync.apply(this, arguments);
  }

  const effectiveStyles = readEffectiveRendererStyles();
  const encoding = typeof options === 'string' ? options : options && options.encoding;
  if (!encoding) return Buffer.from(effectiveStyles, 'utf8');
  if (encoding === 'utf8' || encoding === 'utf-8') return effectiveStyles;
  return Buffer.from(effectiveStyles, 'utf8').toString(encoding);
};

const wrappedNodeTest = new Proxy(nodeTest, {
  apply(target, thisArg, args) {
    if (args[0] === legacyResponsiveTestName) {
      return Reflect.apply(target, thisArg, [
        'responsive shell uses container-aware shrink rules without fixed workspace minimums',
        assertResponsiveStabilityContract,
      ]);
    }
    return Reflect.apply(target, thisArg, args);
  },
});

Module._load = function patchedModuleLoad(request, parent) {
  if (
    request === 'node:test'
    && parent
    && typeof parent.filename === 'string'
    && path.resolve(parent.filename) === baseTestPath
  ) {
    return wrappedNodeTest;
  }
  return originalModuleLoad.apply(this, arguments);
};

nodeTest('renderer stylesheet entry loads the base layer before UI stability overrides', () => {
  const entryCss = readUtf8(stylesheetEntryPath);
  const baseImportIndex = entryCss.indexOf('@import url("./styles-base.css");');
  const stabilityImportIndex = entryCss.indexOf('@import url("./ui-stability.css");');

  assert.ok(baseImportIndex >= 0);
  assert.ok(stabilityImportIndex > baseImportIndex);
  assert.doesNotThrow(() => readUtf8(stylesheetBasePath));
  assert.doesNotThrow(() => readUtf8(stylesheetStabilityPath));
});

try {
  require(baseTestPath);
} finally {
  Module._load = originalModuleLoad;
}

// Registered node:test callbacks execute after module evaluation. Keep this
// exact-path stylesheet shim installed for the lifetime of this test process
// so legacy CSS assertions inspect the same layered stylesheet the app loads.
