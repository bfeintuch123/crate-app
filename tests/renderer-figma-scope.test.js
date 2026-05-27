const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createDocumentStub() {
  return {
    addEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({
      textContent: '',
      innerHTML: '',
      style: {},
      classList: { add: () => {}, remove: () => {}, toggle: () => {} },
      appendChild: () => {},
    }),
    body: { appendChild: () => {} },
  };
}

function loadRendererHelpers() {
  const context = {
    console,
    document: createDocumentStub(),
    window: {},
    setTimeout,
    clearTimeout,
    Date,
  };
  vm.createContext(context);
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  vm.runInContext(appJs, context, { filename: 'renderer/app.js' });
  return context;
}

test('renderer Figma scope helper defaults missing or invalid scope to Current Page Only', () => {
  const renderer = loadRendererHelpers();

  assert.equal(renderer.getProjectFigmaScopeMode({}), 'current-page');
  assert.equal(renderer.getProjectFigmaScopeMode({
    figmaScopeMode: 'legacy-entire-file',
    figmaSession: { scopeMode: 'entire-file' },
  }), 'current-page');
  assert.equal(renderer.getProjectFigmaScopeLabel({
    figmaSession: { scopeMode: 'entire-file', trackedFiles: [] },
  }), 'Current Page Only (locked at session start)');
});

test('renderer Figma scope helper preserves explicit scope choices', () => {
  const renderer = loadRendererHelpers();

  assert.equal(renderer.getProjectFigmaScopeMode({ figmaScopeMode: 'entire-file' }), 'entire-file');
  assert.equal(renderer.getProjectFigmaScopeLabel({ figmaScopeMode: 'entire-file' }), 'Entire File');
  assert.equal(renderer.getProjectFigmaScopeMode({ figmaScopeMode: 'current-page' }), 'current-page');
  assert.equal(renderer.getProjectFigmaScopeLabel({
    figmaScopeMode: 'current-page',
    figmaSession: {
      trackedFiles: [{ lockedPageName: 'Page One' }],
    },
  }), 'Current Page Only - Page One');
});
