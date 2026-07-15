const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createElementStub(tagName = 'div') {
  const classes = new Set();
  const listeners = {};
  const attributes = {};
  const element = {
    tagName: tagName.toUpperCase(),
    style: {},
    children: [],
    dataset: {},
    listeners,
    focused: false,
    value: '',
    checked: false,
    disabled: false,
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
    addEventListener: (type, fn) => {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(fn);
    },
    dispatchEvent: event => {
      const normalizedEvent = typeof event === 'string' ? { type: event } : event;
      for (const fn of listeners[normalizedEvent.type] || []) fn(normalizedEvent);
    },
    click: () => element.dispatchEvent({ type: 'click', preventDefault: () => {}, stopPropagation: () => {} }),
    focus: () => { element.focused = true; },
    setAttribute: (name, value) => { attributes[name] = String(value); },
    getAttribute: name => attributes[name],
    removeAttribute: name => { delete attributes[name]; },
    querySelector: selector => {
      if (selector === '.btn-accept-pending' || selector === '.btn-reject-pending' || selector === '.app-file-remove') {
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

function createDocumentStub(elements = {}, options = {}) {
  const listeners = {};
  const getElementById = id => {
    if (!elements[id] && options.createMissingIds) elements[id] = createElementStub();
    return elements[id] || null;
  };

  return {
    listeners,
    addEventListener: (type, fn) => { listeners[type] = fn; },
    querySelector: selector => {
      if (selector.startsWith('#')) return getElementById(selector.slice(1));
      if (selector === '.type-pill[data-type="branding"]') {
        return (options.typePills || []).find(pill => pill.dataset.type === 'branding') || null;
      }
      return null;
    },
    querySelectorAll: selector => {
      if (selector === '.app-tab') return options.tabs || [];
      if (selector === '.type-pill') return options.typePills || [];
      return [];
    },
    createElement: createElementStub,
    body: { appendChild: () => {} },
  };
}

function createInteractiveRendererDom() {
  const elements = {};
  const tabs = ['projects', 'files', 'settings'].map(tabName => {
    const tab = createElementStub('button');
    tab.dataset.tab = tabName;
    if (tabName === 'projects') tab.classList.add('active');
    return tab;
  });
  const typePills = ['branding', 'print', 'presentation', 'web'].map(type => {
    const pill = createElementStub('button');
    pill.dataset.type = type;
    if (type === 'branding') pill.classList.add('active');
    return pill;
  });
  const document = createDocumentStub(elements, { createMissingIds: true, tabs, typePills });
  return { document, elements, tabs, typePills };
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

function loadRendererHelpers(document = createDocumentStub(), windowOverrides = {}) {
  const context = {
    console,
    document,
    window: windowOverrides,
    setTimeout,
    clearTimeout,
    Date,
  };
  vm.createContext(context);
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  vm.runInContext(appJs, context, { filename: 'renderer/app.js' });
  return context;
}

test('renderer log sanitizer removes complete quoted private paths containing spaces', () => {
  const renderer = loadRendererHelpers();
  const privatePath = '/private/tmp/neutral client/file.fig';
  const output = renderer.sanitizeRendererLogText(`scan failed "${privatePath}"`);

  assert.match(output, /redacted-path/);
  assert.equal(output.includes(privatePath), false);
  assert.equal(output.includes('neutral client/file.fig'), false);
});

test('renderer log sanitizer removes complete unquoted private paths containing spaces', () => {
  const renderer = loadRendererHelpers();
  const privatePath = '/Users/synthetic/Private Project/hero.v2 final.fig';
  const output = renderer.sanitizeRendererLogText(`scan failed ${privatePath} while scanning project.`);

  assert.equal(output, 'scan failed [redacted-path]');
  assert.equal(output.includes(privatePath), false);
  assert.equal(output.includes('Project/hero.v2'), false);
  assert.equal(output.includes('final.fig'), false);
});

test('renderer log sanitizer removes quoted private paths containing delimiter characters', () => {
  const renderer = loadRendererHelpers();
  const cases = [
    "ENOENT: open '/tmp/synthetic/Designer's Work/hero.v2 final.fig'",
    'ENOENT: open "/tmp/synthetic/Client "Final"/file.fig"',
    'ENOENT: open `/tmp/synthetic/Client `Final/file.fig`',
    "ENOENT: open '/tmp/synthetic/Private\nProject/file.fig'",
    "ENOENT: open '/TMP/synthetic/Private\r\nProject/file.fig'",
    "ENOENT: open '/uSeRs/synthetic/Private Project/file.fig'",
  ];

  for (const input of cases) {
    const output = renderer.sanitizeRendererLogText(input);
    assert.equal(output, 'ENOENT: open [redacted-path]');
    assert.equal(output.includes("s Work"), false);
    assert.equal(output.includes('final.fig'), false);
    assert.equal(output.includes('Project/file.fig'), false);
  }
});

test('renderer log sanitizer removes quoted and unquoted compound credential values', () => {
  const renderer = loadRendererHelpers();
  const credential = 'neutralOpaqueValue864';

  for (const input of [
    `scan failed {"authorizationHeader":"${credential}"}`,
    `scan failed authorizationHeader=Basic ${credential}`,
    `scan failed {"cookieHeader":"${credential}"}`,
  ]) {
    const output = renderer.sanitizeRendererLogText(input);
    assert.match(output, /redacted/);
    assert.equal(output.includes(credential), false);
  }
});

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

test('renderer only shows package review Figma scope for Figma context', () => {
  const renderer = loadRendererHelpers();

  assert.equal(renderer.projectHasFigmaContext({
    type: 'presentation',
    figmaScopeMode: 'current-page',
    figmaTrackedFiles: [],
    files: [{
      name: 'Crate PowerPoint QA.pptx',
      ext: '.pptx',
      source: 'manual-browse',
    }],
  }), false);

  assert.equal(renderer.projectHasFigmaContext({
    figmaScopeMode: 'current-page',
    figmaTrackedFiles: [{ status: 'tracked' }],
    files: [],
  }), true);

  assert.equal(renderer.projectHasFigmaContext({
    figmaScopeMode: 'current-page',
    figmaTrackedFiles: [],
    files: [{
      name: 'Petra_Logo_Group_1.png',
      ext: '.png',
      source: 'figma-auto',
      figmaFileKey: 'FIG22',
      figmaPageName: 'Page One',
    }],
  }), true);
});

test('renderer accepts modern Figma URL shapes that the main process parses', () => {
  const renderer = loadRendererHelpers();

  assert.equal(renderer.isValidFigmaUrl('https://www.figma.com/design/Petra_logo-File_123/Petra-Logo?node-id=2-1'), true);
  assert.equal(renderer.isValidFigmaUrl('https://figma.com/file/HashKey_456/Petra#node-id=2-1'), true);
  assert.equal(renderer.isValidFigmaUrl('figma://design/Desktop-Key_789/Petra?pageId=1-1'), true);
  assert.equal(renderer.isValidFigmaUrl('figma://open?url=https%3A%2F%2Fwww.figma.com%2Fproto%2FPrototype-Route_123%2FPetra%3Fnode-id%3D2-1%26file-key%3DPetra_logo-File_123'), true);
  assert.equal(renderer.isValidFigmaUrl('figma://open?file-id=Petra_logo-File_123&node-id=2-1'), true);
  assert.equal(renderer.isValidFigmaUrl('https://example.com/design/Petra_logo-File_123/Petra-Logo?node-id=2-1'), false);
});

test('Edit Figma Link keeps the saved URL out of the renderer and preserves it when blank', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const calls = [];
  const project = {
    id: 'project-private-link',
    name: 'Private Link',
    status: 'watching',
    files: [],
    pendingFiles: [],
    figmaScopeMode: 'current-page',
    figmaTrackedFiles: [{ key: 'PRIVATE22', url: 'https://www.figma.com/file/PRIVATE22/Should-Never-Render' }],
    figmaSession: { trackedFiles: [] },
  };
  const renderer = loadRendererHelpers(document, {
    crate: {
      setProjectFigmaLink: async (projectId, payload) => {
        calls.push({ projectId, payload });
        return { success: true };
      },
      getProjects: async () => [],
    },
  });
  renderer.testProject = project;
  vm.runInContext('state.projects = [testProject]', renderer);

  renderer.openEditFigmaLinkModal(project.id);
  assert.equal(elements['edit-figma-url'].value, '');
  assert.equal(elements['edit-figma-url'].focused, true);

  elements['edit-figma-scope'].value = 'entire-file';
  await renderer.saveEditFigmaLinkModal();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{
    projectId: project.id,
    payload: {
      action: 'preserve',
      scopeMode: 'entire-file',
    },
  }]);
});

test('Edit Figma Link markup offers explicit replacement and removal controls', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

  assert.match(indexHtml, /Leave blank to keep the current link/);
  assert.match(indexHtml, /id="btn-edit-figma-remove"/);
  assert.match(indexHtml, /Replace Figma URL \(optional\)/);
});

test('renderer Figma scope helper does not call pending or unresolved locks locked', () => {
  const renderer = loadRendererHelpers();

  assert.equal(renderer.getProjectFigmaScopeLabel({
    figmaScopeMode: 'current-page',
    figmaSession: {
      trackedFiles: [{ lockStatus: 'pending', requestedNodeId: '1:2' }],
    },
  }), 'Current Page Only (resolving page lock)');
  assert.equal(renderer.getProjectFigmaScopeLabel({
    figmaScopeMode: 'current-page',
    figmaSession: {
      trackedFiles: [{ lockStatus: 'unresolved', warning: 'Current Page Only could not be locked.' }],
      warnings: ['Current Page Only could not be locked.'],
    },
  }), 'Current Page Only (page lock unresolved)');
});

test('renderer Figma scan status shows page-lock warning before metadata fallback error', () => {
  const elements = {
    'figma-scan-status': createElementStub(),
  };
  const renderer = loadRendererHelpers(createDocumentStub(elements));

  renderer.updateFigmaScanStatus({
    filesFound: 1,
    assetsFound: 0,
    errors: ['Metadata fetch failed for tracked file [redacted]; proceeding to extraction anyway.'],
    warning: 'Current Page Only could not be locked from the tracked Figma URL. No Figma assets will be captured for this file in this session.',
    timestamp: Date.UTC(2026, 5, 17, 12, 0, 0),
  });

  assert.match(elements['figma-scan-status'].textContent, /1 files, 0 assets/);
  assert.match(elements['figma-scan-status'].textContent, /Current Page Only could not be locked/);
  assert.equal(elements['figma-scan-status'].textContent.includes('Metadata fetch failed'), false);
});

test('renderer Figma scan status shows privacy-safe candidate diagnostics', () => {
  const elements = {
    'figma-scan-status': createElementStub(),
  };
  const renderer = loadRendererHelpers(createDocumentStub(elements));

  renderer.updateFigmaScanStatus({
    filesFound: 2,
    assetsFound: 0,
    errors: ['Metadata fetch failed for tracked file [redacted]; proceeding to extraction anyway.'],
    warning: 'Current Page Only could not read the tracked Figma file. No Figma assets will be captured for this file in this session.',
    candidateDiagnostics: {
      candidateCount: 2,
      candidateSourceCounts: { 'prototype-route': 1, 'canonical-param': 1 },
      parsedScopeCounts: { withPageOrNode: 2, withoutPageOrNode: 0 },
      metadataStatusCounts: { failed: 2 },
      metadataFailureReasonCounts: { 'access-denied': 1, 'file-not-found': 1 },
      fileFetchStatusCounts: { failed: 2 },
      fileFetchFailureReasonCounts: { 'access-denied': 2 },
      lockStatusCounts: { unresolved: 2 },
      statusReasonCounts: { 'figma-current-page-file-fetch-failed': 2 },
      assetResultCounts: { withAssets: 0, withoutAssets: 2 }
    },
    timestamp: Date.UTC(2026, 5, 17, 12, 0, 0),
  });

  const text = elements['figma-scan-status'].textContent;
  assert.match(text, /2 files, 0 assets/);
  assert.match(text, /Figma candidate check: 2 candidates/);
  assert.match(text, /sources prototype-route 1, canonical-param 1/);
  assert.match(text, /page\/node parsed 2/);
  assert.match(text, /metadata ok 0\/failed 2/);
  assert.match(text, /metadata reasons access-denied 1, file-not-found 1/);
  assert.match(text, /file ok 0\/failed 2/);
  assert.match(text, /file reasons access-denied 2/);
  assert.equal(text.includes('figma.com'), false);
  assert.equal(text.includes('token'), false);
  assert.equal(text.includes('Bearer'), false);
  assert.equal(text.includes('1:1'), false);
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

test('Needs-save live candidates render when package-ready files already exist', () => {
  const elements = {
    'pending-section': createElementStub(),
    'pending-file-list': createElementStub(),
    'file-list': createElementStub(),
  };
  const renderer = loadRendererHelpers(createDocumentStub(elements));
  const project = {
    id: 'project-accepted-plus-live',
    files: [{
      path: '/Users/example/Desktop/Bris Invitation-03 copy.ai',
      name: 'Bris Invitation-03 copy.ai',
      ext: '.ai',
      source: 'manual-browse',
    }],
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
        sourceName: 'Bris Invitation-03 copy.ai',
        relationship: 'source-linked',
      },
    }],
  };

  renderer.renderPendingFiles(project);
  renderer.renderFileList(project.files, { hasActiveCandidates: true });

  assert.equal(elements['pending-section'].classList.contains('hidden'), false);
  assert.equal(elements['pending-file-list'].children.length, 1);
  assert.equal(elements['pending-file-list'].children[0].innerHTML.includes('IMG_5331.JPG'), true);
  assert.equal(elements['pending-file-list'].children[0].innerHTML.includes('Save to make package-ready'), true);
  assert.equal(elements['pending-file-list'].children[0].innerHTML.includes('provenance'), false);
  assert.equal(elements['pending-file-list'].children[0].innerHTML.includes('lsof'), false);
  assert.equal(elements['file-list'].children.length, 1);
  assert.equal(elements['file-list'].children[0].innerHTML.includes('Bris Invitation-03 copy.ai'), true);
  assert.equal(elements['file-list'].innerHTML.includes('No files tracked yet'), false);
});

test('renderer binds primary controls before startup IPC resolves', () => {
  const { document, elements } = createInteractiveRendererDom();
  const neverResolves = new Promise(() => {});
  const crateBridge = {
    getProjects: () => neverResolves,
    getSettings: async () => ({ namingTemplate: '{Project}_{Date}' }),
    getUsage: async () => ({ packagesThisMonth: 0 }),
    onFilesUpdated: () => {},
    onProjectUpdated: () => {},
    onPackageTrigger: () => {},
    onPendingFilesUpdated: () => {},
    onFigmaAuthError: () => {},
    onFigmaScanStarted: () => {},
    onFigmaScanComplete: () => {},
    onFigmaScanError: () => {},
  };

  loadRendererHelpers(document, { crate: crateBridge });
  assert.equal(typeof document.listeners.DOMContentLoaded, 'function');

  document.listeners.DOMContentLoaded();

  assert.equal(elements['btn-start-project'].listeners.click.length, 1);
  assert.equal(elements['btn-add-project'].listeners.click.length, 1);
  assert.equal(elements['btn-v2-browse'].listeners.click.length, 1);

  document.querySelector('#new-project-form');
  document.querySelector('#projects-list');
  document.querySelector('#projects-empty');
  elements['new-project-form'].classList.add('hidden');
  elements['projects-list'].classList.add('hidden');
  elements['btn-start-project'].click();

  assert.equal(elements['projects-empty'].classList.contains('hidden'), true);
  assert.equal(elements['projects-list'].classList.contains('hidden'), true);
  assert.equal(elements['new-project-form'].classList.contains('hidden'), false);
  assert.equal(elements['input-project-name'].focused, true);
});

test('Quick Package drop uses preload File handling while Browse keeps its existing path flow', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const neverResolves = new Promise(() => {});
  const droppedFile = { name: 'Synthetic Deck.pptx' };
  const ignoredDroppedFile = { name: 'Ignored Second Deck.pptx' };
  Object.defineProperty(droppedFile, 'path', {
    get() { throw new Error('renderer must not read File.path'); },
  });
  const droppedFiles = [];
  const browsedPaths = [];
  let usageRequests = 0;
  const browsePath = '/private/tmp/crate-synthetic/Browsed Deck.pptx';
  const packageResult = {
    success: true,
    masterFile: '/private/tmp/crate-synthetic/Synthetic Deck.pptx',
    assetsFound: 0,
    assetsCopied: 0,
    assetsMissing: [],
    outputDir: '/private/tmp/crate-synthetic/Synthetic Deck_2026-07-14',
    files: [],
  };
  const crateBridge = {
    getProjects: () => neverResolves,
    getSettings: async () => ({ namingTemplate: '{Project}_{Date}' }),
    getUsage: async () => {
      usageRequests += 1;
      return { packagesThisMonth: usageRequests };
    },
    v2PackageDroppedFile: async file => {
      droppedFiles.push(file);
      return packageResult;
    },
    v2BrowseFile: async () => browsePath,
    v2PackageFile: async filePath => {
      browsedPaths.push(filePath);
      return { ...packageResult, masterFile: browsePath };
    },
    onFilesUpdated: () => {},
    onProjectUpdated: () => {},
    onPackageTrigger: () => {},
    onPendingFilesUpdated: () => {},
    onFigmaAuthError: () => {},
    onFigmaScanStarted: () => {},
    onFigmaScanComplete: () => {},
    onFigmaScanError: () => {},
  };

  loadRendererHelpers(document, { crate: crateBridge });
  document.listeners.DOMContentLoaded();
  const startupUsageRequests = usageRequests;

  const dropHandlers = elements['v2-drop-zone'].listeners.drop;
  assert.equal(dropHandlers.length, 1);
  await dropHandlers[0]({
    preventDefault() {},
    stopPropagation() {},
    dataTransfer: { files: [droppedFile, ignoredDroppedFile] },
  });

  assert.equal(droppedFiles.length, 1);
  assert.equal(droppedFiles[0], droppedFile);
  assert.deepEqual(browsedPaths, []);
  assert.equal(usageRequests, startupUsageRequests + 1);
  assert.equal(elements['modal-v2-results'].classList.contains('hidden'), false);

  elements['modal-v2-results'].classList.add('hidden');

  const browseHandlers = elements['btn-v2-browse'].listeners.click;
  assert.equal(browseHandlers.length, 1);
  await browseHandlers[0]();

  assert.deepEqual(browsedPaths, [browsePath]);
  assert.equal(usageRequests, startupUsageRequests + 2);
  assert.equal(elements['modal-v2-results'].classList.contains('hidden'), false);
});

test('Quick Package clears progress and permits retry after rejected drop or Browse IPC', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const neverResolves = new Promise(() => {});
  const droppedFile = { name: 'Synthetic Retry Deck.pptx' };
  let dropAttempts = 0;
  let browseAttempts = 0;
  const browsePath = '/private/tmp/crate-synthetic/Browsed Retry Deck.pptx';
  const packageResult = {
    success: true,
    masterFile: '/private/tmp/crate-synthetic/Synthetic Retry Deck.pptx',
    assetsFound: 0,
    assetsCopied: 0,
    assetsMissing: [],
    outputDir: '/private/tmp/crate-synthetic/Synthetic Retry Deck_2026-07-14',
    files: [],
  };
  const crateBridge = {
    getProjects: () => neverResolves,
    getSettings: async () => ({ namingTemplate: '{Project}_{Date}' }),
    getUsage: async () => ({ packagesThisMonth: 1 }),
    v2PackageDroppedFile: async () => {
      dropAttempts += 1;
      if (dropAttempts === 1) throw new Error('synthetic drop IPC rejection');
      return packageResult;
    },
    v2BrowseFile: async () => browsePath,
    v2PackageFile: async () => {
      browseAttempts += 1;
      if (browseAttempts === 1) throw new Error('synthetic Browse IPC rejection');
      return { ...packageResult, masterFile: browsePath };
    },
    onFilesUpdated: () => {},
    onProjectUpdated: () => {},
    onPackageTrigger: () => {},
    onPendingFilesUpdated: () => {},
    onFigmaAuthError: () => {},
    onFigmaScanStarted: () => {},
    onFigmaScanComplete: () => {},
    onFigmaScanError: () => {},
  };

  loadRendererHelpers(document, { crate: crateBridge });
  document.listeners.DOMContentLoaded();

  const dropHandler = elements['v2-drop-zone'].listeners.drop[0];
  const dropEvent = {
    preventDefault() {},
    stopPropagation() {},
    dataTransfer: { files: [droppedFile] },
  };

  await dropHandler(dropEvent);

  assert.equal(dropAttempts, 1);
  assert.equal(elements['modal-progress'].classList.contains('hidden'), true);

  await dropHandler(dropEvent);

  assert.equal(dropAttempts, 2);
  assert.equal(elements['modal-progress'].classList.contains('hidden'), true);
  assert.equal(elements['modal-v2-results'].classList.contains('hidden'), false);

  elements['modal-v2-results'].classList.add('hidden');
  const browseHandler = elements['btn-v2-browse'].listeners.click[0];

  await browseHandler();

  assert.equal(browseAttempts, 1);
  assert.equal(elements['modal-progress'].classList.contains('hidden'), true);
  assert.equal(elements['modal-v2-results'].classList.contains('hidden'), true);

  await browseHandler();

  assert.equal(browseAttempts, 2);
  assert.equal(elements['modal-progress'].classList.contains('hidden'), true);
  assert.equal(elements['modal-v2-results'].classList.contains('hidden'), false);
});
