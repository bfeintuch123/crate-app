const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createElementStub(tagName = 'div') {
  const classes = new Set();
  const element = {
    tagName: tagName.toUpperCase(),
    style: {},
    children: [],
    open: false,
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      toggle: (name, force) => {
        const shouldAdd = force === undefined ? !classes.has(name) : Boolean(force);
        if (shouldAdd) classes.add(name);
        else classes.delete(name);
        return shouldAdd;
      },
      contains: (name) => classes.has(name),
    },
    appendChild: child => element.children.push(child),
    addEventListener: () => {},
    querySelector: selector => {
      if (selector === '.btn-accept-pending' || selector === '.btn-reject-pending') {
        return { addEventListener: () => {} };
      }
      return null;
    },
  };

  let html = '';
  let text = '';
  const htmlEscape = value => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
  Object.defineProperty(element, 'textContent', {
    get: () => text,
    set: value => {
      text = String(value ?? '');
      html = htmlEscape(text);
    },
  });
  Object.defineProperty(element, 'innerHTML', {
    get: () => html,
    set: value => {
      html = String(value ?? '');
      text = html;
      element.children = [];
    },
  });

  return element;
}

function createDocumentStub(elements = {}) {
  return {
    addEventListener: () => {},
    querySelector: selector => {
      if (selector.startsWith('#')) return elements[selector.slice(1)] || null;
      return null;
    },
    querySelectorAll: () => [],
    createElement: createElementStub,
    body: { appendChild: () => {} },
  };
}

function createPackageDetailsDom() {
  const elements = {
    'package-details': createElementStub('details'),
    'package-details-included': createElementStub(),
    'package-details-sources': createElementStub(),
    'package-details-review': createElementStub(),
    'package-details-issues': createElementStub('ul'),
  };
  elements['package-details'].classList.add('hidden');
  elements['package-details-issues'].classList.add('hidden');
  return { document: createDocumentStub(elements), elements };
}

function loadRendererHelpers(document = createDocumentStub()) {
  const context = {
    console,
    document,
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

test('Package Details shows the no-issue state without issue messages', () => {
  const { document, elements } = createPackageDetailsDom();
  const renderer = loadRendererHelpers(document);

  renderer.renderPackageDetails({ copiedCount: 2, embeddedCount: 0, errors: [] });

  assert.equal(elements['package-details'].open, false);
  assert.equal(elements['package-details-included'].textContent, '2 files included');
  assert.equal(elements['package-details-review'].textContent, 'No issues found');
  assert.equal(elements['package-details-issues'].children.length, 0);
  assert.equal(elements['package-details-issues'].classList.contains('hidden'), true);
  assert.equal(elements['package-details'].classList.contains('hidden'), false);
});

test('Package Details shows one sanitized issue message', () => {
  const { document, elements } = createPackageDetailsDom();
  const renderer = loadRendererHelpers(document);

  renderer.renderPackageDetails({
    copiedCount: 1,
    embeddedCount: 0,
    errors: ['Could not inspect embedded media in Presentation1.pptx.'],
  });

  assert.equal(elements['package-details-review'].textContent, '1 issue need review');
  assert.equal(elements['package-details-issues'].children.length, 1);
  assert.equal(
    elements['package-details-issues'].children[0].textContent,
    'Could not inspect embedded media in Presentation1.pptx.'
  );
  assert.equal(elements['package-details-issues'].classList.contains('hidden'), false);
});

test('Package Details shows multiple sanitized issue messages', () => {
  const { document, elements } = createPackageDetailsDom();
  const renderer = loadRendererHelpers(document);

  renderer.renderPackageDetails({
    copiedCount: 1,
    embeddedCount: 0,
    errors: [
      'Could not inspect embedded media in Presentation1.pptx.',
      'Could not extract embedded media image2.png from Presentation1.pptx.',
    ],
  });

  assert.equal(elements['package-details-review'].textContent, '2 issues need review');
  assert.deepEqual(
    elements['package-details-issues'].children.map(child => child.textContent),
    [
      'Could not inspect embedded media in Presentation1.pptx.',
      'Could not extract embedded media image2.png from Presentation1.pptx.',
    ]
  );
});

test('Package Details remains collapsed by default', () => {
  const { document, elements } = createPackageDetailsDom();
  const renderer = loadRendererHelpers(document);
  elements['package-details'].open = true;

  renderer.renderPackageDetails({ copiedCount: 1, embeddedCount: 1, errors: [] });

  assert.equal(elements['package-details'].open, false);
});

test('Package Details stays hidden when disabled in settings', () => {
  const { document, elements } = createPackageDetailsDom();
  const renderer = loadRendererHelpers(document);

  vm.runInContext('state.settings.showPackageDetails = false', renderer);
  renderer.renderPackageDetails({
    copiedCount: 1,
    embeddedCount: 0,
    errors: ['Could not inspect embedded media in Presentation1.pptx.'],
  });

  assert.equal(elements['package-details'].classList.contains('hidden'), true);
  assert.equal(elements['package-details-issues'].children.length, 0);
});

test('Pending-only live session renders active review state instead of empty tracking copy', () => {
  const elements = {
    'pending-section': createElementStub(),
    'pending-file-list': createElementStub(),
    'file-list': createElementStub(),
  };
  const renderer = loadRendererHelpers(createDocumentStub(elements));
  const project = {
    id: 'project-pending-only',
    files: [],
    pendingFiles: [{
      path: '/Users/example/Desktop/IMG_5331.JPG',
      name: 'IMG_5331.JPG',
      ext: '.jpg',
      source: 'ai-linked',
      captureState: 'needs-save',
      captureReason: 'linked-asset-observed',
      captureEvidence: {
        state: 'needs-save',
        reason: 'linked-asset-observed',
        source: 'ai-linked',
        needsSave: true,
        appFamily: 'illustrator',
        sourceName: 'layout.ai',
        relationship: 'source-linked',
      },
    }],
  };

  renderer.renderPendingFiles(project);
  renderer.renderFileList(project.files, { hasActiveCandidates: true });

  assert.equal(elements['pending-section'].classList.contains('hidden'), false);
  assert.equal(elements['pending-file-list'].children.length, 1);
  assert.equal(elements['pending-file-list'].children[0].innerHTML.includes('Save to make package-ready'), true);
  assert.equal(elements['pending-file-list'].children[0].innerHTML.includes('provenance'), false);
  assert.equal(elements['pending-file-list'].children[0].innerHTML.includes('lsof'), false);
  assert.equal(elements['file-list'].innerHTML.includes('No package-ready files yet'), true);
  assert.equal(elements['file-list'].innerHTML.includes('No files tracked yet'), false);
});
