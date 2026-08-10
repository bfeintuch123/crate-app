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
    inert: false,
    open: false,
    ownerDocument: null,
    focusableElements: [],
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
    removeEventListener: (type, fn) => {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter(listener => listener !== fn);
    },
    dispatchEvent: event => {
      const normalizedEvent = typeof event === 'string' ? { type: event } : event;
      for (const fn of listeners[normalizedEvent.type] || []) fn(normalizedEvent);
    },
    click: () => element.dispatchEvent({ type: 'click', preventDefault: () => {}, stopPropagation: () => {} }),
    focus: () => {
      if (element.ownerDocument?.activeElement) element.ownerDocument.activeElement.focused = false;
      element.focused = true;
      if (element.ownerDocument) element.ownerDocument.activeElement = element;
    },
    setAttribute: (name, value) => { attributes[name] = String(value); },
    getAttribute: name => attributes[name],
    removeAttribute: name => { delete attributes[name]; },
    querySelector: selector => {
      if (selector === '.btn-accept-pending' || selector === '.btn-reject-pending' || selector === '.app-file-remove') {
        return { addEventListener: () => {} };
      }
      return null;
    },
    querySelectorAll: selector => selector.includes('button') ? element.focusableElements : [],
    closest: () => null,
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

function getElementTreeText(element) {
  if (!element) return '';
  return [element.textContent || '', ...(element.children || []).map(getElementTreeText)].join(' ');
}

function createDocumentStub(elements = {}, options = {}) {
  const listeners = {};
  const body = createElementStub('body');
  let document;
  const attach = element => {
    if (element) element.ownerDocument = document;
    return element;
  };
  const getElementById = id => {
    if (!elements[id] && options.createMissingIds) elements[id] = attach(createElementStub());
    return attach(elements[id] || null);
  };

  document = {
    listeners,
    activeElement: body,
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
    createElement: tagName => attach(createElementStub(tagName)),
    body,
  };
  body.ownerDocument = document;
  for (const element of Object.values(elements)) attach(element);
  for (const element of [...(options.tabs || []), ...(options.typePills || [])]) attach(element);
  return document;
}

function createInteractiveRendererDom() {
  const elements = {
    'app-sidebar': createElementStub('aside'),
    'app-main': createElementStub('main'),
    'btn-package': createElementStub('button'),
    'btn-change-dest': createElementStub('button'),
    'btn-cancel-package': createElementStub('button'),
    'btn-confirm-package': createElementStub('button'),
    'btn-skip-existing-assets': createElementStub('button'),
    'btn-include-existing-assets': createElementStub('button'),
    'modal-existing-assets': createElementStub(),
    'existing-assets-modal-count': createElementStub(),
    'existing-assets-modal-list': createElementStub(),
    'modal-package': createElementStub(),
    'modal-progress': createElementStub(),
    'modal-success': createElementStub(),
    'package-details': createElementStub('details'),
    'package-details-summary': createElementStub('summary'),
    'btn-success-done': createElementStub('button'),
    'btn-open-folder': createElementStub('button'),
    'modal-upgrade': createElementStub(),
    'btn-dismiss-upgrade': createElementStub('button'),
    'modal-delete-confirm': createElementStub(),
    'modal-edit-figma-link': createElementStub(),
    'modal-clear-all': createElementStub(),
    'modal-v2-results': createElementStub(),
  };
  for (const id of [
    'modal-existing-assets',
    'modal-package',
    'modal-progress',
    'modal-success',
    'modal-upgrade',
    'modal-delete-confirm',
    'modal-edit-figma-link',
    'modal-clear-all',
    'modal-v2-results',
  ]) {
    elements[id].classList.add('hidden');
  }
  elements['modal-package'].focusableElements = [
    elements['btn-change-dest'],
    elements['btn-cancel-package'],
    elements['btn-confirm-package'],
  ];
  elements['modal-existing-assets'].focusableElements = [
    elements['btn-skip-existing-assets'],
    elements['btn-include-existing-assets'],
  ];
  elements['modal-upgrade'].focusableElements = [elements['btn-dismiss-upgrade']];
  elements['package-details'].classList.add('hidden');
  elements['package-details-summary'].closest = selector => (
    selector === '.hidden' && elements['package-details'].classList.contains('hidden')
      ? elements['package-details']
      : null
  );
  elements['modal-success'].focusableElements = [
    elements['package-details-summary'],
    elements['btn-success-done'],
    elements['btn-open-folder'],
  ];
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
  if (context.window.crate && typeof context.window.crate.getAssetWorkspace !== 'function') {
    context.window.crate.getAssetWorkspace = async projectId => {
      const projects = vm.runInContext('state.projects', context);
      const project = projects.find(item => item.id === projectId) || context.testProject;
      const present = (file, index) => ({
        name: file.name,
        ext: file.ext || path.extname(file.name || ''),
        embedded: file.embedded === true,
        linked: file.linked === true,
        assetOrigin: file.assetOrigin,
        projectRole: file.projectRole,
        protectedSource: file.protectedSource === true || file.projectRole === 'source',
        excluded: (project?.excludedAssetKeys || []).includes(file.fileId || file.path),
        visualIdentity: file.visualIdentity || `opaque-${index}-${file.name || 'file'}`,
        visualRevision: file.visualRevision || `revision-${index}-${file.name || 'file'}`,
      });
      return {
        projectId,
        files: (project?.files || []).map(present),
        pendingFiles: (project?.pendingFiles || []).map(present),
      };
    };
  }
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

test('renderer refreshes changed Package Review inline and requires a second Package Now click', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const project = {
    id: 'package-review-project',
    name: 'Package Review Project',
    type: 'branding',
    status: 'watching',
    files: [
      { name: 'Review_Project.ai', ext: '.ai' },
      { name: 'Review_Initial.png', ext: '.png' },
      { name: 'Review_Added_After_Review.png', ext: '.png' },
    ],
  };
  const firstReview = {
    token: '00000000-0000-4000-8000-000000000101',
    projectId: project.id,
    files: project.files.slice(0, 2),
    totalFiles: 2,
    folderName: 'Package Review Project_2026-08-02',
  };
  const refreshedReview = {
    token: '00000000-0000-4000-8000-000000000102',
    projectId: project.id,
    files: project.files,
    totalFiles: 3,
    folderName: 'Package Review Project_2026-08-02_1',
  };
  const packageCalls = [];
  const disabledDuringPackageCalls = [];
  let prepareCalls = 0;
  const crateBridge = {
    preScanSession: async () => ({ success: true }),
    preparePackageReview: async () => {
      prepareCalls++;
      return firstReview;
    },
    getProjects: async () => [project],
    packageProject: async (...args) => {
      packageCalls.push(args);
      disabledDuringPackageCalls.push(elements['btn-confirm-package'].disabled);
      return packageCalls.length === 1
        ? { error: 'package_review_changed', reason: 'package_destination_changed', review: refreshedReview }
        : { error: 'limit_reached', packageLimit: 25, daysLeft: 1 };
    },
  };
  const renderer = loadRendererHelpers(document, { crate: crateBridge });
  renderer.testProject = project;
  vm.runInContext(`
    state.projects = [testProject];
    state.selectedProjectId = testProject.id;
    state.settings = { namingTemplate: '{Project}_{Date}' };
    state.packageOutputPath = '/private/tmp/crate-synthetic-output';
  `, renderer);
  renderer.setupEventListeners();

  elements['btn-package'].focus();
  assert.equal(await renderer.showPackageModal(), true);
  assert.equal(elements['modal-file-list'].children.length, 2);
  assert.equal(elements['modal-folder-name'].textContent, firstReview.folderName);
  await renderer.confirmPackage();

  assert.equal(packageCalls.length, 1);
  assert.deepEqual(disabledDuringPackageCalls, [true]);
  assert.equal(packageCalls[0][2], firstReview.token);
  assert.equal(
    elements['modal-package-review-message'].textContent,
    'Your project changed. Review the updated files before packaging.'
  );
  assert.equal(elements['modal-package-review-message'].classList.contains('hidden'), false);
  assert.equal(elements['modal-package-review-message'].focused, true);
  assert.equal(elements['modal-file-list'].children.length, 3);
  assert.equal(elements['modal-folder-name'].textContent, refreshedReview.folderName);
  assert.equal(elements['modal-package'].classList.contains('hidden'), false);
  assert.equal(vm.runInContext('state.packageReviewToken', renderer), refreshedReview.token);

  await renderer.confirmPackage();
  assert.equal(packageCalls.length, 2);
  assert.equal(packageCalls[1][2], refreshedReview.token);
  assert.equal(prepareCalls, 1);
  assert.equal(vm.runInContext('state.packageReviewToken', renderer), null);
  assert.equal(elements['modal-package'].classList.contains('hidden'), true);
  assert.equal(elements['modal-progress'].classList.contains('hidden'), true);
  assert.equal(elements['modal-success'].classList.contains('hidden'), true);
  assert.equal(elements['modal-v2-results'].classList.contains('hidden'), true);
  assert.equal(elements['modal-upgrade'].classList.contains('hidden'), false);
  assert.equal(document.activeElement, elements['btn-dismiss-upgrade']);
  assert.equal(elements['app-sidebar'].inert, true);
  assert.equal(elements['app-main'].inert, true);

  elements['btn-dismiss-upgrade'].click();
  assert.equal(elements['modal-upgrade'].classList.contains('hidden'), true);
  assert.equal(elements['app-sidebar'].inert, false);
  assert.equal(elements['app-main'].inert, false);
  assert.equal(document.activeElement, elements['btn-package']);
});

test('renderer presents the required Existing Assets decision with source-safe copy and trapped focus', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const project = {
    id: 'existing-assets-decision-project',
    name: 'Existing Assets Decision',
    type: 'branding',
    status: 'watching',
    files: [
      { name: 'Existing Project.ai', path: '/synthetic/Existing Project.ai', ext: '.ai', assetOrigin: 'added', projectRole: 'source' },
      { name: 'Existing Linked.png', path: '/synthetic/Existing Linked.png', ext: '.png', assetOrigin: 'existing', projectRole: 'asset' },
    ],
    pendingFiles: [],
    excludedAssetKeys: [],
    assetBaseline: { status: 'decision-required', decision: null, establishedAt: 1 },
  };
  const renderer = loadRendererHelpers(document, { crate: {} });
  renderer.testProject = project;
  vm.runInContext(`
    state.projects = [testProject];
    state.selectedProjectId = testProject.id;
  `, renderer);
  document.querySelector('#tab-current-project').classList.add('active');

  await renderer.renderFiles();

  assert.equal(elements['modal-existing-assets'].classList.contains('hidden'), false);
  assert.equal(elements['existing-assets-modal-count'].textContent, '1 existing asset found');
  assert.equal(elements['existing-assets-modal-list'].children.length, 1);
  assert.equal(elements['existing-assets-modal-list'].children[0].children[1].textContent, 'Existing Linked.png');
  assert.equal(document.activeElement, elements['btn-include-existing-assets']);
  assert.equal(elements['app-sidebar'].inert, true);
  assert.equal(elements['app-main'].inert, true);

  elements['btn-include-existing-assets'].focus();
  const forwardTab = {
    type: 'keydown',
    key: 'Tab',
    shiftKey: false,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
  elements['modal-existing-assets'].dispatchEvent(forwardTab);
  assert.equal(forwardTab.defaultPrevented, true);
  assert.equal(document.activeElement, elements['btn-skip-existing-assets']);
});

test('renderer restores focus inside the Existing Assets modal when decision persistence fails', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const project = {
    id: 'existing-assets-decision-failure',
    files: [{ name: 'Existing.png', path: '/synthetic/Existing.png', assetOrigin: 'existing', projectRole: 'asset' }],
    pendingFiles: [],
    excludedAssetKeys: [],
    assetBaseline: { status: 'decision-required', decision: null, establishedAt: 1 },
  };
  const renderer = loadRendererHelpers(document, { crate: {
    setExistingAssetsDecision: async () => ({ success: false, error: 'write_failed' }),
  } });
  renderer.testProject = project;
  vm.runInContext('state.projects = [testProject]; state.selectedProjectId = testProject.id;', renderer);

  await renderer.showExistingAssetsDecisionModal(project);
  elements['btn-skip-existing-assets'].focus();
  await renderer.submitExistingAssetsDecision('skip');

  assert.equal(elements['modal-existing-assets'].classList.contains('hidden'), false);
  assert.equal(elements['btn-skip-existing-assets'].disabled, false);
  assert.equal(elements['btn-include-existing-assets'].disabled, false);
  assert.equal(document.activeElement, elements['btn-include-existing-assets']);
  assert.equal(elements['app-sidebar'].inert, true);
  assert.equal(elements['app-main'].inert, true);
});

test('renderer closes a stale Existing Assets decision when the selected project no longer requires it', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const renderer = loadRendererHelpers(document, { crate: {} });
  const decisionProject = {
    id: 'decision-project',
    files: [
      { name: 'Existing.png', path: '/synthetic/Existing.png', assetOrigin: 'existing', projectRole: 'asset' },
    ],
    pendingFiles: [],
    assetBaseline: { status: 'decision-required', decision: null, establishedAt: 1 },
  };
  const readyProject = {
    id: 'ready-project',
    files: [],
    pendingFiles: [],
    assetBaseline: { status: 'empty', decision: null, establishedAt: 2 },
  };

  renderer.testProject = decisionProject;
  vm.runInContext('state.projects = [testProject]; state.selectedProjectId = testProject.id;', renderer);
  await renderer.syncExistingAssetsDecisionModal(decisionProject);
  assert.equal(elements['modal-existing-assets'].classList.contains('hidden'), false);
  assert.equal(elements['app-sidebar'].inert, true);
  assert.equal(elements['app-main'].inert, true);

  await renderer.syncExistingAssetsDecisionModal(readyProject);
  assert.equal(elements['modal-existing-assets'].classList.contains('hidden'), true);
  assert.equal(elements['app-sidebar'].inert, false);
  assert.equal(elements['app-main'].inert, false);
});

test('renderer persists Skip Existing and hides excluded assets without removing the project source', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const source = { name: 'Existing Project.ai', path: '/synthetic/Existing Project.ai', ext: '.ai', assetOrigin: 'added', projectRole: 'source' };
  const existing = { name: 'Existing Linked.png', path: '/synthetic/Existing Linked.png', ext: '.png', assetOrigin: 'existing', projectRole: 'asset' };
  const project = {
    id: 'skip-existing-assets-project',
    name: 'Skip Existing Assets',
    type: 'branding',
    status: 'watching',
    files: [source, existing],
    pendingFiles: [],
    excludedAssetKeys: [],
    assetBaseline: { status: 'decision-required', decision: null, establishedAt: 1 },
  };
  const updatedProject = {
    ...project,
    excludedAssetKeys: [existing.path],
    assetBaseline: { ...project.assetBaseline, status: 'skipped', decision: 'skip' },
  };
  const decisions = [];
  const renderer = loadRendererHelpers(document, { crate: {
    setExistingAssetsDecision: async (...args) => {
      decisions.push(args);
      return { success: true, project: updatedProject };
    },
    getProjects: async () => [updatedProject],
  } });
  renderer.testProject = project;
  vm.runInContext(`
    state.projects = [testProject];
    state.selectedProjectId = testProject.id;
  `, renderer);
  document.querySelector('#tab-current-project').classList.add('active');
  elements['btn-package'].focus();
  await renderer.renderFiles();

  await renderer.submitExistingAssetsDecision('skip');

  assert.deepEqual(decisions, [[project.id, 'skip']]);
  assert.equal(elements['modal-existing-assets'].classList.contains('hidden'), true);
  assert.equal(elements['app-sidebar'].inert, false);
  assert.equal(elements['app-main'].inert, false);
  assert.equal(document.activeElement, elements['btn-package']);
  assert.equal(elements['project-file-list'].children.length, 1);
  assert.equal(elements['project-file-list'].children[0].children[1].textContent, 'Existing Project.ai');
  assert.equal(elements['existing-assets-list'].children.length, 1);
  assert.equal(elements['existing-assets-list'].children[0].children[1].textContent, 'Existing Linked.png');
  assert.equal(elements['existing-assets-list'].children[0].className.includes('is-excluded'), true);
});

test('Current Project separates protected sources, Existing Assets, and Added While Working without routine Add or Skip controls', () => {
  const { document, elements } = createInteractiveRendererDom();
  const project = {
    id: 'visual-workspace-groups',
    files: [
      { name: 'Workspace.ai', path: '/synthetic/Workspace.ai', ext: '.ai', assetOrigin: 'added', projectRole: 'source' },
      { name: 'Existing.png', path: '/synthetic/Existing.png', ext: '.png', assetOrigin: 'existing', projectRole: 'asset' },
      { name: 'Added.png', path: '/synthetic/Added.png', ext: '.png', assetOrigin: 'added', projectRole: 'asset' },
    ],
    pendingFiles: [],
    excludedAssetKeys: [],
    assetBaseline: { status: 'included', decision: 'include' },
  };
  const renderer = loadRendererHelpers(document, { crate: {} });

  renderer.renderAssetWorkspace(project);

  assert.equal(elements['project-file-list'].children.length, 1);
  assert.equal(elements['existing-assets-list'].children.length, 1);
  assert.equal(elements['added-assets-list'].children.length, 1);
  assert.equal(getElementTreeText(elements['project-file-list']).includes('Protected'), true);
  assert.equal(getElementTreeText(elements['existing-assets-list']).includes('Existing.png'), true);
  assert.equal(getElementTreeText(elements['added-assets-list']).includes('Added.png'), true);
  assert.equal(getElementTreeText(elements['added-assets-list']).includes('+ Add'), false);
  assert.equal(getElementTreeText(elements['added-assets-list']).includes('Skip'), false);
  const sourceButtons = elements['project-file-list'].children[0].children.filter(child => child.tagName === 'BUTTON');
  assert.equal(sourceButtons.length, 0);
  const removeButton = elements['added-assets-list'].children[0].children.find(child => child.tagName === 'BUTTON');
  assert.equal(removeButton.textContent, '\u00D7');
  assert.equal(removeButton.getAttribute('aria-label'), 'Exclude Added.png from this project');
});

test('Existing Assets batch controls use the persisted cohort decision IPC and preserve excluded rows', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const existing = { name: 'Existing.png', path: '/synthetic/Existing.png', ext: '.png', assetOrigin: 'existing', projectRole: 'asset' };
  const project = {
    id: 'visual-workspace-batch',
    files: [
      { name: 'Workspace.ai', path: '/synthetic/Workspace.ai', ext: '.ai', assetOrigin: 'added', projectRole: 'source' },
      existing,
    ],
    pendingFiles: [],
    excludedAssetKeys: [],
    assetBaseline: { status: 'included', decision: 'include' },
  };
  const skippedProject = {
    ...project,
    excludedAssetKeys: [existing.path],
    assetBaseline: { status: 'skipped', decision: 'skip' },
  };
  const decisions = [];
  const renderer = loadRendererHelpers(document, { crate: {
    setExistingAssetsDecision: async (...args) => {
      decisions.push(args);
      return { success: true, project: skippedProject };
    },
    getProjects: async () => [skippedProject],
  } });
  renderer.testProject = project;
  vm.runInContext('state.projects = [testProject]; state.selectedProjectId = testProject.id;', renderer);

  assert.equal(await renderer.submitExistingAssetsBatchDecision('skip'), true);

  assert.deepEqual(decisions, [[project.id, 'skip']]);
  assert.equal(elements['existing-assets-list'].children.length, 1);
  assert.equal(elements['existing-assets-list'].children[0].className.includes('is-excluded'), true);
  assert.equal(elements['btn-include-all-existing'].disabled, false);
  assert.equal(elements['btn-skip-all-existing'].disabled, true);
});

test('per-file Existing Asset exclusion keeps the row available for Include All restoration', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const source = {
    name: 'Workspace.ai', ext: '.ai', assetOrigin: 'added', projectRole: 'source',
    protectedSource: true, visualIdentity: 'source-identity', visualRevision: 'source-revision',
  };
  const existing = {
    name: 'Existing.png', ext: '.png', assetOrigin: 'existing', projectRole: 'asset',
    protectedSource: false, excluded: false,
    visualIdentity: 'existing-identity', visualRevision: 'existing-revision',
  };
  const project = {
    id: 'existing-x-restoration',
    name: 'Existing X restoration',
    type: 'branding',
    status: 'watching',
    files: [source, existing],
    pendingFiles: [],
    excludedAssetKeys: [],
    assetBaseline: { status: 'included', decision: 'include' },
  };
  const updatedProject = {
    ...project,
    files: [source, { ...existing, excluded: true }],
    excludedAssetKeys: ['existing-key'],
  };
  const removals = [];
  const renderer = loadRendererHelpers(document, { crate: {
    removeFile: async (...args) => { removals.push(args); },
    getProjects: async () => [updatedProject],
    getAssetWorkspace: async () => ({ projectId: project.id, files: updatedProject.files, pendingFiles: [] }),
  } });
  renderer.testProject = project;
  vm.runInContext('state.projects = [testProject]; state.selectedProjectId = testProject.id;', renderer);
  renderer.renderAssetWorkspace(project, {}, project.files);
  const removeButton = elements['existing-assets-list'].children[0].children.find(child => child.tagName === 'BUTTON');
  removeButton.click();
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(removals, [[project.id, existing.visualIdentity]]);
  assert.equal(elements['existing-assets-list'].children.length, 1);
  assert.equal(elements['existing-assets-list'].children[0].className.includes('is-excluded'), true);
  assert.equal(elements['btn-include-all-existing'].disabled, false);
  assert.equal(elements['btn-skip-all-existing'].disabled, true);
});

test('file visuals prefer raster thumbnails, then native icons, then bounded extension badges', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const pngData = `data:image/png;base64,${Buffer.from('visual').toString('base64')}`;
  const project = {
    id: 'visual-fallback-order',
    files: [
      { name: 'Photo.png', ext: '.png', assetOrigin: 'added', projectRole: 'asset', visualIdentity: 'visual-Photo.png', visualRevision: 'revision-photo' },
      { name: 'Layout.ai', ext: '.ai', assetOrigin: 'added', projectRole: 'asset', visualIdentity: 'visual-Layout.ai', visualRevision: 'revision-layout' },
      { name: 'Archive.xyz', ext: '.xyz', assetOrigin: 'added', projectRole: 'asset', visualIdentity: 'visual-Archive.xyz', visualRevision: 'revision-archive' },
    ],
    pendingFiles: [],
    excludedAssetKeys: [],
  };
  const renderer = loadRendererHelpers(document, { crate: {
    getFileVisual: async (projectId, identity, revision) => {
      assert.equal(projectId, project.id);
      assert.match(revision, /^revision-/);
      if (identity.endsWith('Photo.png')) return { kind: 'thumbnail', dataUrl: pngData };
      if (identity.endsWith('Layout.ai')) return { kind: 'icon', dataUrl: pngData };
      return { kind: 'fallback' };
    },
  } });

  renderer.renderAssetWorkspace(project);
  await new Promise(resolve => setImmediate(resolve));

  const [photoRow, layoutRow, archiveRow] = elements['added-assets-list'].children;
  assert.equal(photoRow.children[0].classList.contains('is-thumbnail'), true);
  assert.equal(photoRow.children[0].dataset.fileIdentity, undefined);
  assert.equal(layoutRow.children[0].classList.contains('is-icon'), true);
  assert.equal(archiveRow.children[0].children[0].textContent, 'XYZ');
});

test('file visual acquisition deduplicates in flight work, caps concurrency, and evicts old cache entries', async () => {
  const deferred = [];
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const renderer = loadRendererHelpers(createDocumentStub(), { crate: {
    getFileVisual: async (projectId, identity) => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      return await new Promise(resolve => deferred.push(() => {
        active -= 1;
        resolve({ kind: 'fallback', projectId, identity });
      }));
    },
  } });

  const duplicateA = renderer.requestFileVisual('visual-project', 'shared-identity', 'shared-revision');
  const duplicateB = renderer.requestFileVisual('visual-project', 'shared-identity', 'shared-revision');
  const requests = [duplicateA, duplicateB];
  for (let index = 0; index < 11; index += 1) {
    requests.push(renderer.requestFileVisual('visual-project', `identity-${index}`, `revision-${index}`));
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 4);
  while (deferred.length || active > 0) {
    const batch = deferred.splice(0);
    batch.forEach(resolve => resolve());
    await new Promise(resolve => setImmediate(resolve));
  }
  await Promise.all(requests);
  assert.equal(maxActive, 4);
  assert.equal(calls, 12);
  await renderer.requestFileVisual('visual-project', 'shared-identity', 'shared-revision');
  assert.equal(calls, 12);

  let evictionCalls = 0;
  const evictionRenderer = loadRendererHelpers(createDocumentStub(), { crate: {
    getFileVisual: async () => {
      evictionCalls += 1;
      return { kind: 'fallback' };
    },
  } });
  for (let index = 0; index < 129; index += 1) {
    await evictionRenderer.requestFileVisual('eviction-project', `identity-${index}`, `revision-${index}`);
  }
  const beforeRevisit = vm.runInContext('fileVisualCache.size', evictionRenderer);
  assert.equal(beforeRevisit, 128);
  assert.equal(evictionCalls, 129);
  await evictionRenderer.requestFileVisual('eviction-project', 'identity-0', 'revision-0');
  assert.equal(evictionCalls, 130);
  assert.equal(vm.runInContext('fileVisualCache.size', evictionRenderer), 128);
});

test('file visual queue stays bounded and cancels stale queued work on project switch', async () => {
  const deferred = [];
  const calls = [];
  const renderer = loadRendererHelpers(createDocumentStub(), { crate: {
    getFileVisual: (projectId, identity) => {
      calls.push([projectId, identity]);
      return new Promise(resolve => deferred.push(resolve));
    },
  } });
  renderer.setActiveFileVisualProject('old-project');
  const requests = [];
  for (let index = 0; index < 140; index += 1) {
    requests.push(renderer.requestFileVisual('old-project', `old-${index}`, `old-revision-${index}`));
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(vm.runInContext('fileVisualActiveRequests', renderer), 4);
  assert.equal(vm.runInContext('fileVisualQueue.length', renderer), 128);
  assert.equal(vm.runInContext('fileVisualInFlight.size', renderer), 132);

  renderer.setActiveFileVisualProject('new-project');
  const selectedRequest = renderer.requestFileVisual('new-project', 'selected', 'selected-revision');
  assert.equal(vm.runInContext('fileVisualQueue.length', renderer), 1);
  deferred.shift()({ kind: 'fallback' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.at(-1), ['new-project', 'selected']);

  while (deferred.length) deferred.shift()({ kind: 'fallback' });
  await new Promise(resolve => setImmediate(resolve));
  while (deferred.length) deferred.shift()({ kind: 'fallback' });
  await Promise.all([...requests, selectedRequest]);
  assert.equal(vm.runInContext('fileVisualQueue.length', renderer), 0);
  assert.equal(vm.runInContext('fileVisualInFlight.size', renderer), 0);
  assert.equal(vm.runInContext('fileVisualActiveRequests', renderer), 0);
});

test('file visual scheduler releases slots after synchronous bridge failures', async () => {
  let calls = 0;
  const renderer = loadRendererHelpers(createDocumentStub(), { crate: {
    getFileVisual: () => {
      calls += 1;
      if (calls === 1) throw new Error('synthetic synchronous bridge failure');
      return { kind: 'fallback' };
    },
  } });
  renderer.setActiveFileVisualProject('sync-project');
  assert.equal(
    (await renderer.requestFileVisual('sync-project', 'first', 'first-revision')).kind,
    'fallback'
  );
  assert.equal(
    (await renderer.requestFileVisual('sync-project', 'second', 'second-revision')).kind,
    'fallback'
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(vm.runInContext('fileVisualActiveRequests', renderer), 0);
  assert.equal(vm.runInContext('fileVisualQueue.length', renderer), 0);
  assert.equal(vm.runInContext('fileVisualInFlight.size', renderer), 0);
});

test('file visual cache keys source revisions and invalidation clears the current project cache', async () => {
  let calls = 0;
  const renderer = loadRendererHelpers(createDocumentStub(), { crate: {
    getFileVisual: async () => {
      calls += 1;
      return { kind: 'fallback' };
    },
  } });
  renderer.setActiveFileVisualProject('revision-project');
  await renderer.requestFileVisual('revision-project', 'same-file', 'revision-one');
  await renderer.requestFileVisual('revision-project', 'same-file', 'revision-one');
  assert.equal(calls, 1);
  await renderer.requestFileVisual('revision-project', 'same-file', 'revision-two');
  assert.equal(calls, 2);
  renderer.invalidateFileVisualProject('revision-project');
  await renderer.requestFileVisual('revision-project', 'same-file', 'revision-two');
  assert.equal(calls, 3);
});

test('explicit PDF baseline source is protected while a linked PDF remains removable', () => {
  const { document, elements } = createInteractiveRendererDom();
  const project = { id: 'pdf-source-presentation' };
  const files = [
    {
      name: 'Project Brief.pdf', ext: '.pdf', projectRole: 'asset', assetOrigin: 'added',
      protectedSource: true, visualIdentity: 'pdf-source-identity', visualRevision: 'pdf-source-revision',
    },
    {
      name: 'Linked Reference.pdf', ext: '.pdf', projectRole: 'asset', assetOrigin: 'existing',
      protectedSource: false, visualIdentity: 'pdf-linked-identity', visualRevision: 'pdf-linked-revision',
    },
  ];
  const renderer = loadRendererHelpers(document, { crate: {} });

  renderer.renderAssetWorkspace(project, {}, files);

  assert.equal(elements['project-file-list'].children.length, 1);
  assert.equal(elements['project-file-list'].children[0].children[1].textContent, 'Project Brief.pdf');
  assert.equal(elements['project-file-list'].children[0].children.some(child => child.tagName === 'BUTTON'), false);
  assert.equal(elements['existing-assets-list'].children.length, 1);
  assert.equal(elements['existing-assets-list'].children[0].children[1].textContent, 'Linked Reference.pdf');
  assert.equal(elements['existing-assets-list'].children[0].children.some(child => child.tagName === 'BUTTON'), true);
});

test('Package Review uses the same project-owned visual identity without rendering private paths', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const pngData = `data:image/png;base64,${Buffer.from('review').toString('base64')}`;
  const project = {
    id: 'review-visual-project',
    name: 'Review Visuals',
    files: [{ name: 'Review.ai', path: 'stable-review-identity' }],
  };
  const renderer = loadRendererHelpers(document, { crate: {
    getFileVisual: async (projectId, identity, revision) => {
      assert.equal(projectId, project.id);
      assert.equal(identity, 'stable-review-identity');
      assert.equal(revision, 'stable-review-revision');
      return { kind: 'icon', dataUrl: pngData };
    },
  } });

  renderer.renderPackageReview(project, {
    token: '00000000-0000-4000-8000-000000000111',
    materializable: true,
    files: [{ name: 'Review.ai', ext: '.ai', visualIdentity: 'stable-review-identity', visualRevision: 'stable-review-revision' }],
  });
  await new Promise(resolve => setImmediate(resolve));

  const item = elements['modal-file-list'].children[0];
  assert.equal(item.children[0].classList.contains('is-icon'), true);
  assert.equal(getElementTreeText(item).includes('/synthetic/'), false);
  assert.equal(item.children[1].textContent, 'Review.ai');
});

test('Package Review binds duplicate display names to distinct authoritative visual identities', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const calls = [];
  const project = { id: 'duplicate-review-visuals', name: 'Duplicate Review', files: [] };
  const renderer = loadRendererHelpers(document, { crate: {
    getFileVisual: async (projectId, identity, revision) => {
      calls.push([projectId, identity, revision]);
      return { kind: 'fallback' };
    },
  } });

  renderer.renderPackageReview(project, {
    token: '00000000-0000-4000-8000-000000000112',
    materializable: true,
    files: [
      { name: 'Shared.png', ext: '.png', visualIdentity: 'opaque-directory-a', visualRevision: 'revision-directory-a' },
      { name: 'Shared.png', ext: '.png', visualIdentity: 'opaque-directory-b', visualRevision: 'revision-directory-b' },
    ],
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(calls, [
    [project.id, 'opaque-directory-a', 'revision-directory-a'],
    [project.id, 'opaque-directory-b', 'revision-directory-b'],
  ]);
  assert.equal(elements['modal-file-list'].children.length, 2);
  assert.equal(getElementTreeText(elements['modal-file-list']).includes('/synthetic/'), false);
});

test('renderer project counts exclude assets skipped by the Existing Assets decision', () => {
  const renderer = loadRendererHelpers(createDocumentStub({}));
  const project = {
    status: 'paused',
    files: [
      { path: '/synthetic/Project.ai', name: 'Project.ai' },
      { path: '/synthetic/Existing.png', name: 'Existing.png' },
    ],
    excludedAssetKeys: ['/synthetic/Existing.png'],
  };

  assert.equal(renderer.getStatusLabel(project), 'Paused · 1 file so far');
});

test('renderer blocks Package Review until the Existing Assets decision is recorded', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const project = {
    id: 'blocked-existing-assets-project',
    name: 'Blocked Existing Assets',
    type: 'branding',
    status: 'watching',
    files: [
      { name: 'Blocked.ai', path: '/synthetic/Blocked.ai', ext: '.ai', assetOrigin: 'added', projectRole: 'source' },
      { name: 'Blocked.png', path: '/synthetic/Blocked.png', ext: '.png', assetOrigin: 'existing', projectRole: 'asset' },
    ],
    pendingFiles: [],
    excludedAssetKeys: [],
    assetBaseline: { status: 'decision-required', decision: null, establishedAt: 1 },
  };
  let prepareCalls = 0;
  const renderer = loadRendererHelpers(document, { crate: {
    preparePackageReview: async () => { prepareCalls++; return null; },
  } });
  renderer.testProject = project;
  vm.runInContext(`
    state.projects = [testProject];
    state.selectedProjectId = testProject.id;
  `, renderer);
  renderer.setupEventListeners();

  elements['btn-package'].click();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(prepareCalls, 0);
  assert.equal(elements['modal-existing-assets'].classList.contains('hidden'), false);
  assert.equal(elements['modal-package'].classList.contains('hidden'), true);
});

test('notification-triggered packaging opens the Existing Assets decision instead of a generic review error', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const project = {
    id: 'notification-existing-assets-project',
    name: 'Notification Existing Assets',
    type: 'branding',
    status: 'watching',
    files: [
      { name: 'Notification.ai', path: '/synthetic/Notification.ai', assetOrigin: 'added', projectRole: 'source' },
      { name: 'Notification.png', path: '/synthetic/Notification.png', assetOrigin: 'existing', projectRole: 'asset' },
    ],
    pendingFiles: [],
    excludedAssetKeys: [],
    assetBaseline: { status: 'decision-required', decision: null, establishedAt: 1 },
  };
  let packageTrigger;
  let prepareCalls = 0;
  const noOp = () => {};
  const renderer = loadRendererHelpers(document, { crate: {
    getProjects: async () => [project],
    preparePackageReview: async () => { prepareCalls++; return null; },
    onFilesUpdated: noOp,
    onProjectUpdated: noOp,
    onPendingFilesUpdated: noOp,
    onPackageTrigger: handler => { packageTrigger = handler; },
    onFigmaAuthError: noOp,
    onFigmaScanStarted: noOp,
    onFigmaScanComplete: noOp,
    onFigmaScanError: noOp,
  } });
  renderer.setupMainProcessListeners();

  await packageTrigger({ projectId: project.id });

  assert.equal(prepareCalls, 0);
  assert.equal(elements['modal-existing-assets'].classList.contains('hidden'), false);
  assert.equal(elements['modal-package'].classList.contains('hidden'), true);
});

test('notification-triggered packaging closes another project existing-assets decision before review', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const decisionProject = {
    id: 'notification-decision-project',
    name: 'Pending Existing Assets',
    type: 'branding',
    status: 'paused',
    files: [
      { name: 'Pending.ai', path: '/synthetic/Pending.ai', assetOrigin: 'added', projectRole: 'source' },
      { name: 'Pending.png', path: '/synthetic/Pending.png', assetOrigin: 'existing', projectRole: 'asset' },
    ],
    pendingFiles: [],
    excludedAssetKeys: [],
    assetBaseline: { status: 'decision-required', decision: null, establishedAt: 1 },
  };
  const readyProject = {
    id: 'notification-ready-project',
    name: 'Ready Project',
    type: 'branding',
    status: 'watching',
    files: [{ name: 'Ready.ai', path: '/synthetic/Ready.ai', assetOrigin: 'added', projectRole: 'source' }],
    pendingFiles: [],
    excludedAssetKeys: [],
    assetBaseline: { status: 'empty', decision: null, establishedAt: 2 },
  };
  const review = {
    token: '00000000-0000-4000-8000-000000000222',
    projectId: readyProject.id,
    files: readyProject.files,
    totalFiles: 1,
    folderName: 'Ready Project_2026-08-08',
    materializable: true,
  };
  let packageTrigger;
  const noOp = () => {};
  const renderer = loadRendererHelpers(document, { crate: {
    getProjects: async () => [decisionProject, readyProject],
    preScanSession: async () => null,
    preparePackageReview: async () => review,
    onFilesUpdated: noOp,
    onProjectUpdated: noOp,
    onPendingFilesUpdated: noOp,
    onPackageTrigger: handler => { packageTrigger = handler; },
    onFigmaAuthError: noOp,
    onFigmaScanStarted: noOp,
    onFigmaScanComplete: noOp,
    onFigmaScanError: noOp,
  } });
  renderer.testDecisionProject = decisionProject;
  vm.runInContext(`
    state.projects = [testDecisionProject];
    state.selectedProjectId = testDecisionProject.id;
  `, renderer);
  renderer.testProject = decisionProject;
  await renderer.syncExistingAssetsDecisionModal(decisionProject);
  renderer.setupMainProcessListeners();

  await packageTrigger({ projectId: readyProject.id });

  assert.equal(elements['modal-existing-assets'].classList.contains('hidden'), true);
  assert.equal(elements['modal-package'].classList.contains('hidden'), false);
  assert.equal(vm.runInContext('state.selectedProjectId', renderer), readyProject.id);
  assert.equal(vm.runInContext('existingAssetsModalProjectId', renderer), null);
});

test('an earlier decision completion cannot dismiss a later project Existing Assets alert', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const projectA = {
    id: 'decision-race-a',
    name: 'Decision A',
    status: 'paused',
    files: [{ name: 'A.png', path: '/synthetic/A.png', assetOrigin: 'existing', projectRole: 'asset' }],
    pendingFiles: [],
    excludedAssetKeys: [],
    assetBaseline: { status: 'decision-required', decision: null, establishedAt: 1 },
  };
  const projectB = {
    id: 'decision-race-b',
    name: 'Decision B',
    status: 'watching',
    files: [{ name: 'B.png', path: '/synthetic/B.png', assetOrigin: 'existing', projectRole: 'asset' }],
    pendingFiles: [],
    excludedAssetKeys: [],
    assetBaseline: { status: 'decision-required', decision: null, establishedAt: 2 },
  };
  let resolveDecisionA;
  let packageTrigger;
  const decisionA = new Promise(resolve => { resolveDecisionA = resolve; });
  const noOp = () => {};
  const renderer = loadRendererHelpers(document, { crate: {
    setExistingAssetsDecision: async projectId => (
      projectId === projectA.id ? decisionA : { success: true, project: projectB }
    ),
    getProjects: async () => [projectA, projectB],
    onFilesUpdated: noOp,
    onProjectUpdated: noOp,
    onPendingFilesUpdated: noOp,
    onPackageTrigger: handler => { packageTrigger = handler; },
    onFigmaAuthError: noOp,
    onFigmaScanStarted: noOp,
    onFigmaScanComplete: noOp,
    onFigmaScanError: noOp,
  } });
  renderer.showExistingAssetsDecisionModal(projectA);
  renderer.setupMainProcessListeners();
  const pendingDecision = renderer.submitExistingAssetsDecision('include');

  await packageTrigger({ projectId: projectB.id });
  assert.equal(vm.runInContext('existingAssetsModalProjectId', renderer), projectB.id);
  assert.equal(elements['modal-existing-assets'].classList.contains('hidden'), false);
  assert.equal(elements['existing-assets-modal-list'].children[0].children[1].textContent, 'B.png');
  assert.equal(elements['btn-include-existing-assets'].disabled, false);

  resolveDecisionA({ success: true, project: projectA });
  await pendingDecision;

  assert.equal(vm.runInContext('existingAssetsModalProjectId', renderer), projectB.id);
  assert.equal(elements['modal-existing-assets'].classList.contains('hidden'), false);
  assert.equal(elements['existing-assets-modal-list'].children[0].children[1].textContent, 'B.png');
});

test('Package Review routes a newly settled baseline to the sole Existing Assets decision dialog', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const awaitingProject = {
    id: 'settling-existing-assets-project',
    name: 'Settling Existing Assets',
    type: 'branding',
    status: 'watching',
    files: [{ name: 'Settling.ai', path: '/synthetic/Settling.ai', assetOrigin: null, projectRole: 'source' }],
    pendingFiles: [],
    excludedAssetKeys: [],
    assetBaseline: { status: 'awaiting-first-scan', decision: null, establishedAt: null },
  };
  const settledProject = {
    ...awaitingProject,
    files: [
      { name: 'Settling.ai', path: '/synthetic/Settling.ai', assetOrigin: 'added', projectRole: 'source' },
      { name: 'Settling.png', path: '/synthetic/Settling.png', assetOrigin: 'existing', projectRole: 'asset' },
    ],
    assetBaseline: { status: 'decision-required', decision: null, establishedAt: 1 },
  };
  const renderer = loadRendererHelpers(document, { crate: {
    preScanSession: async () => null,
    preparePackageReview: async () => ({ error: 'asset_baseline_decision_required' }),
    getProjects: async () => [settledProject],
  } });
  renderer.testProject = awaitingProject;
  vm.runInContext(`
    state.projects = [testProject];
    state.selectedProjectId = testProject.id;
  `, renderer);
  document.querySelector('#tab-current-project').classList.add('active');
  elements['btn-package'].focus();

  assert.equal(await renderer.showPackageModal(), false);
  assert.equal(elements['modal-package'].classList.contains('hidden'), true);
  assert.equal(elements['modal-existing-assets'].classList.contains('hidden'), false);
  assert.equal(document.activeElement, elements['btn-include-existing-assets']);
  assert.equal(elements['app-sidebar'].inert, true);
  assert.equal(elements['app-main'].inert, true);
});

test('renderer binds the selected destination after generic output drift and packages on the second click', async () => {
  const { document, elements, tabs } = createInteractiveRendererDom();
  const outputPath = '/private/tmp/crate-synthetic-output';
  const project = {
    id: 'destination-bound-review-project',
    name: 'Destination Bound Review',
    type: 'branding',
    status: 'watching',
    files: [{ name: 'Bound.ai', ext: '.ai' }],
  };
  const initialReview = {
    token: '00000000-0000-4000-8000-000000000111',
    projectId: project.id,
    files: project.files,
    totalFiles: 1,
    folderName: 'Destination Bound Review_2026-08-02',
    materializable: true,
  };
  const boundReview = {
    ...initialReview,
    token: '00000000-0000-4000-8000-000000000112',
    folderName: 'Destination Bound Review_2026-08-02_1',
  };
  const prepareCalls = [];
  const packageCalls = [];
  const renderer = loadRendererHelpers(document, { crate: {
    preScanSession: async () => ({ success: true }),
    preparePackageReview: async (...args) => {
      prepareCalls.push(args);
      return prepareCalls.length === 1 ? initialReview : boundReview;
    },
    getProjects: async () => {
      if (packageCalls.length >= 2) throw new Error('synthetic post-package refresh failure');
      return [project];
    },
    getUsage: async () => ({ packagesThisMonth: 1, packageLimit: 25 }),
    packageProject: async (...args) => {
      packageCalls.push(args);
      if (packageCalls.length === 1) return { error: 'package_output_changed' };
      return {
        success: true,
        copiedCount: 1,
        embeddedCount: 0,
        totalFiles: 1,
        folderPath: `${outputPath}/${boundReview.folderName}`,
        errors: [],
      };
    },
  } });
  renderer.testProject = project;
  vm.runInContext(`
    state.projects = [testProject];
    state.selectedProjectId = testProject.id;
    state.settings = { namingTemplate: '{Project}_{Date}', showPackageDetails: false };
    state.packageOutputPath = '${outputPath}';
  `, renderer);

  assert.equal(await renderer.showPackageModal({ runPreScan: false }), true);
  await renderer.confirmPackage();

  assert.deepEqual(prepareCalls, [[project.id], [project.id, outputPath]]);
  assert.equal(packageCalls.length, 1);
  assert.equal(packageCalls[0][2], initialReview.token);
  assert.equal(elements['modal-package'].classList.contains('hidden'), false);
  assert.equal(elements['modal-folder-name'].textContent, boundReview.folderName);
  assert.equal(vm.runInContext('state.packageReviewToken', renderer), boundReview.token);

  await renderer.confirmPackage();

  assert.equal(packageCalls.length, 2);
  assert.equal(packageCalls[1][2], boundReview.token);
  assert.equal(prepareCalls.length, 2);
  assert.equal(elements['modal-success'].classList.contains('hidden'), false);
  assert.equal(elements['modal-package'].classList.contains('hidden'), true);
  assert.equal(vm.runInContext('state.packageReviewToken', renderer), null);
  assert.equal(elements['success-path'].textContent, `${outputPath}/${boundReview.folderName}`);
  assert.equal(document.activeElement, elements['btn-success-done']);
  assert.equal(elements['app-sidebar'].inert, true);
  assert.equal(elements['app-main'].inert, true);
  vm.runInContext('state.projects = []', renderer);

  elements['btn-open-folder'].focus();
  const tabEvent = {
    type: 'keydown',
    key: 'Tab',
    shiftKey: false,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
  elements['modal-success'].dispatchEvent(tabEvent);
  assert.equal(tabEvent.defaultPrevented, true);
  assert.equal(document.activeElement, elements['btn-success-done']);

  const escapeEvent = {
    type: 'keydown',
    key: 'Escape',
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
  elements['modal-success'].dispatchEvent(escapeEvent);
  assert.equal(escapeEvent.defaultPrevented, true);
  assert.equal(elements['modal-success'].classList.contains('hidden'), true);
  assert.equal(elements['app-sidebar'].inert, false);
  assert.equal(elements['app-main'].inert, false);
  assert.equal(document.activeElement, tabs[0]);
});

test('renderer surfaces typed Package Review scan diagnostics without private values', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const project = {
    id: 'diagnostic-review-project',
    name: 'Diagnostic Review',
    type: 'branding',
    status: 'watching',
    files: [{ name: 'Private_Project.ai', ext: '.ai' }],
  };
  const privatePath = '/Users/synthetic/Private Client/Private_Project.ai';
  const privateToken = 'private-review-token-should-not-appear';
  const renderer = loadRendererHelpers(document, { crate: {
    preparePackageReview: async () => ({
      error: 'package_scan_incomplete',
      diagnostics: {
        failurePhase: 'pre-package-discovery',
        phaseElapsedMs: 8000,
        candidateCount: 129,
        xattrResolvedCount: 128,
        metadataFallbackCount: 1,
        sourcePath: privatePath,
        fileName: 'Private_Project.ai',
        token: privateToken,
      },
    }),
  } });
  renderer.testProject = project;
  vm.runInContext(`
    state.projects = [testProject];
    state.selectedProjectId = testProject.id;
    state.settings = { namingTemplate: '{Project}_{Date}' };
  `, renderer);

  assert.equal(await renderer.showPackageModal({ runPreScan: false }), false);
  const message = elements['modal-package-review-message'].textContent;
  assert.equal(
    message,
    'Crate could not finish checking project files. No package was created. ' +
      'Record the diagnostic below before retrying. ' +
      'Diagnostic: code package_scan_incomplete · phase pre-package-discovery · elapsed 8000 ms · ' +
      'candidates 129 · xattr resolved 128 · metadata fallback 1.'
  );
  assert.equal(message.includes(privatePath), false);
  assert.equal(message.includes('Private_Project.ai'), false);
  assert.equal(message.includes(privateToken), false);
  assert.equal(elements['btn-confirm-package'].disabled, true);
  assert.equal(vm.runInContext('state.packageReviewToken', renderer), null);
});

test('renderer surfaces final package-confirmation diagnostics after Package Now', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const project = {
    id: 'confirmation-diagnostic-project',
    name: 'Confirmation Diagnostic',
    type: 'branding',
    status: 'watching',
    files: [{ name: 'Confirmation.ai', ext: '.ai' }],
  };
  const review = {
    token: '00000000-0000-4000-8000-000000000191',
    projectId: project.id,
    files: project.files,
    totalFiles: 1,
    materializable: true,
  };
  const privatePath = '/Users/synthetic/Private Client/Confirmation.ai';
  const packageCalls = [];
  let prepareCalls = 0;
  const diagnosticFailure = {
    error: 'package_scan_incomplete',
    diagnostics: {
      failurePhase: 'pre-package-discovery',
      phaseElapsedMs: 8000,
      candidateCount: 129,
      xattrResolvedCount: 128,
      metadataFallbackCount: 1,
      sourcePath: privatePath,
      fileName: 'Confirmation.ai',
    },
  };
  const renderer = loadRendererHelpers(document, { crate: {
    preScanSession: async () => ({ success: true }),
    preparePackageReview: async () => (++prepareCalls === 1 ? review : diagnosticFailure),
    getProjects: async () => [project],
    packageProject: async (...args) => {
      packageCalls.push(args);
      return diagnosticFailure;
    },
  } });
  renderer.testProject = project;
  vm.runInContext(`
    state.projects = [testProject];
    state.selectedProjectId = testProject.id;
    state.settings = { namingTemplate: '{Project}_{Date}' };
    state.packageOutputPath = '/private/tmp/crate-synthetic-output';
  `, renderer);

  assert.equal(await renderer.showPackageModal({ runPreScan: false }), true);
  await renderer.confirmPackage();

  assert.equal(packageCalls.length, 1);
  assert.equal(prepareCalls, 2);
  assert.equal(packageCalls[0][2], review.token);
  assert.equal(
    elements['modal-package-review-message'].textContent,
    'Crate could not finish checking project files. No package was created. ' +
      'Record the diagnostic below before retrying. ' +
      'Diagnostic: code package_scan_incomplete · phase pre-package-discovery · elapsed 8000 ms · ' +
      'candidates 129 · xattr resolved 128 · metadata fallback 1.'
  );
  assert.equal(elements['modal-package-review-message'].textContent.includes(privatePath), false);
  assert.equal(elements['modal-package-review-message'].textContent.includes('Confirmation.ai'), false);
  assert.equal(elements['btn-confirm-package'].disabled, true);
  assert.equal(vm.runInContext('state.packageReviewToken', renderer), null);
  assert.equal(elements['modal-package'].classList.contains('hidden'), false);
  assert.equal(elements['modal-success'].classList.contains('hidden'), true);
});

test('renderer disables unavailable Package Review and re-enables only after a fresh materializable review', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const project = {
    id: 'unavailable-review-project',
    name: 'Unavailable Review Project',
    type: 'branding',
    status: 'watching',
    files: [{ name: 'Missing.ai', ext: '.ai' }],
  };
  const readyReview = {
    token: '00000000-0000-4000-8000-000000000201',
    projectId: project.id,
    files: project.files,
    totalFiles: 1,
    materializable: true,
  };
  const unavailableReview = {
    projectId: project.id,
    files: [{ name: 'Missing.ai', status: 'missing' }],
    totalFiles: 1,
    materializable: false,
    message: 'Some files are unavailable. Resolve them before packaging.',
  };
  const recoveredReview = { ...readyReview, token: '00000000-0000-4000-8000-000000000202' };
  let preparedReview = readyReview;
  const packageCalls = [];
  const renderer = loadRendererHelpers(document, { crate: {
    preScanSession: async () => ({ success: true }),
    preparePackageReview: async () => preparedReview,
    getProjects: async () => [project],
    packageProject: async (...args) => {
      packageCalls.push(args);
      return { error: 'package_review_changed', review: unavailableReview };
    },
  } });
  renderer.testProject = project;
  vm.runInContext(`
    state.projects = [testProject];
    state.selectedProjectId = testProject.id;
    state.settings = { namingTemplate: '{Project}_{Date}' };
    state.packageOutputPath = '/private/tmp/crate-synthetic-output';
  `, renderer);

  assert.equal(await renderer.showPackageModal({ runPreScan: false }), true);
  assert.equal(elements['btn-confirm-package'].disabled, false);
  await renderer.confirmPackage();
  assert.equal(packageCalls.length, 1);
  assert.equal(elements['btn-confirm-package'].disabled, true);
  assert.equal(vm.runInContext('state.packageReviewToken', renderer), null);
  assert.equal(elements['modal-package-review-message'].textContent, unavailableReview.message);
  assert.equal(elements['modal-package-review-message'].focused, true);

  await renderer.confirmPackage();
  assert.equal(packageCalls.length, 1);
  preparedReview = recoveredReview;
  assert.equal(await renderer.showPackageModal({ runPreScan: false }), true);
  assert.equal(elements['btn-confirm-package'].disabled, false);
  assert.equal(vm.runInContext('state.packageReviewToken', renderer), recoveredReview.token);
});

test('Package Review dialog exposes live status semantics and visible disabled styling', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

  assert.match(html, /id="modal-existing-assets"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /<button[^>]*id="btn-skip-existing-assets"[^>]*>Skip Existing<\/button>/);
  assert.match(html, /<button[^>]*id="btn-include-existing-assets"[^>]*>Include Existing<\/button>/);
  assert.match(html, /id="modal-package"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /<button[^>]*id="btn-change-dest"[^>]*>Change &rarr;<\/button>/);
  assert.match(html, /id="modal-package-review-message"[^>]*role="status"[^>]*aria-live="polite"[^>]*tabindex="-1"/);
  assert.match(html, /id="modal-file-list"[^>]*role="region"[^>]*tabindex="-1"/);
  assert.match(css, /\.modal-btn-primary:disabled[\s\S]*cursor:\s*not-allowed/);
  assert.match(html, /id="modal-upgrade"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-describedby="upgrade-subtitle"/);
  assert.match(html, /<button[^>]*id="btn-dismiss-upgrade"[^>]*>Maybe later[\s\S]*<\/button>/);
  assert.match(css, /\.dismiss-link:focus-visible[\s\S]*outline:/);
});

test('responsive shell keeps navigation aligned and Settings surface scroll-complete', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

  assert.match(css, /#tab-settings\.active\s*\{(?=[^}]*min-width:\s*800px;)(?=[^}]*grid-template-columns:\s*minmax\(300px, 0\.8fr\)\s+minmax\(420px, 1\.2fr\);)[^}]*\}/);
  assert.match(css, /@media \(max-width:\s*760px\)[\s\S]*\.app-sidebar\s*\{(?=[^}]*display:\s*grid;)(?=[^}]*grid-template-columns:\s*minmax\(0, 1fr\)\s+auto;)(?=[^}]*"brand brand"\s*"primary support";)[^}]*\}/);
  assert.match(css, /\.app-tabs,\s*\.app-tabs-secondary\s*\{(?=[^}]*flex-direction:\s*row;)(?=[^}]*flex-wrap:\s*nowrap;)[^}]*\}/);
  assert.match(css, /\.app-sidebar\s*>\s*\.app-tabs:not\(\.app-tabs-secondary\)\s*\{(?=[^}]*grid-area:\s*primary;)[^}]*\}/);
  assert.match(css, /\.app-sidebar\s*>\s*\.app-tabs-secondary\s*\{(?=[^}]*grid-area:\s*support;)(?=[^}]*margin-top:\s*0;)[^}]*\}/);
  assert.match(css, /@media \(max-width:\s*760px\)[\s\S]*#tab-settings\.active\s*\{(?=[^}]*min-width:\s*0;)(?=[^}]*grid-template-columns:\s*1fr;)[^}]*\}/);
});

test('Package Review traps keyboard focus, cancels with Escape, and restores its opener', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const project = {
    id: 'keyboard-package-review',
    name: 'Keyboard Package Review',
    type: 'branding',
    status: 'watching',
    files: [{ name: 'Keyboard.ai', ext: '.ai' }],
  };
  const review = {
    token: '00000000-0000-4000-8000-000000000301',
    projectId: project.id,
    files: project.files,
    totalFiles: 1,
    materializable: true,
  };
  const renderer = loadRendererHelpers(document, { crate: {
    preScanSession: async () => ({ success: true }),
    preparePackageReview: async () => review,
    getProjects: async () => [project],
    selectOutputFolder: async () => null,
  } });
  renderer.testProject = project;
  vm.runInContext(`
    state.projects = [testProject];
    state.selectedProjectId = testProject.id;
    state.settings = { namingTemplate: '{Project}_{Date}' };
  `, renderer);
  renderer.setupEventListeners();

  elements['btn-package'].focus();
  assert.equal(await renderer.showPackageModal({ runPreScan: false }), true);
  assert.equal(document.activeElement, elements['btn-cancel-package']);
  assert.equal(elements['app-sidebar'].inert, true);
  assert.equal(elements['app-main'].inert, true);
  assert.equal(elements['app-sidebar'].getAttribute('aria-hidden'), 'true');
  assert.equal(elements['app-main'].getAttribute('aria-hidden'), 'true');

  elements['btn-confirm-package'].focus();
  const forwardTab = {
    type: 'keydown',
    key: 'Tab',
    shiftKey: false,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
  elements['modal-package'].dispatchEvent(forwardTab);
  assert.equal(forwardTab.defaultPrevented, true);
  assert.equal(document.activeElement, elements['btn-change-dest']);

  const reverseTab = {
    type: 'keydown',
    key: 'Tab',
    shiftKey: true,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
  elements['modal-package'].dispatchEvent(reverseTab);
  assert.equal(reverseTab.defaultPrevented, true);
  assert.equal(document.activeElement, elements['btn-confirm-package']);

  const escape = {
    type: 'keydown',
    key: 'Escape',
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
  elements['modal-package'].dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(elements['modal-package'].classList.contains('hidden'), true);
  assert.equal(vm.runInContext('state.packageReviewToken', renderer), null);
  assert.equal(elements['app-sidebar'].inert, false);
  assert.equal(elements['app-main'].inert, false);
  assert.equal(elements['app-sidebar'].getAttribute('aria-hidden'), undefined);
  assert.equal(elements['app-main'].getAttribute('aria-hidden'), undefined);
  assert.equal(document.activeElement, elements['btn-package']);

  assert.equal(await renderer.showPackageModal({ runPreScan: false }), true);
  assert.equal(document.activeElement, elements['btn-cancel-package']);
});

test('package limit dialog traps keyboard focus, dismisses with Escape, and cleans up listeners', () => {
  const { document, elements } = createInteractiveRendererDom();
  const renderer = loadRendererHelpers(document, { crate: {} });
  renderer.setupEventListeners();
  elements['btn-package'].focus();
  elements['modal-package'].classList.remove('hidden');
  elements['modal-success'].classList.remove('hidden');
  elements['modal-v2-results'].classList.remove('hidden');
  vm.runInContext(`state.packageReviewToken = '00000000-0000-4000-8000-000000000401'`, renderer);

  renderer.showPackageLimitModal({ packageLimit: 25, daysLeft: 2 });

  assert.equal(vm.runInContext('state.packageReviewToken', renderer), null);
  assert.equal(document.activeElement, elements['btn-dismiss-upgrade']);
  assert.equal(elements['modal-upgrade'].classList.contains('hidden'), false);
  for (const id of [
    'modal-package',
    'modal-progress',
    'modal-success',
    'modal-delete-confirm',
    'modal-edit-figma-link',
    'modal-clear-all',
    'modal-v2-results',
  ]) {
    assert.equal(elements[id].classList.contains('hidden'), true, `${id} must be hidden`);
  }
  assert.equal(elements['app-sidebar'].inert, true);
  assert.equal(elements['app-main'].inert, true);
  assert.equal(elements['modal-upgrade'].listeners.keydown.length, 1);

  for (const shiftKey of [false, true]) {
    const tab = {
      type: 'keydown',
      key: 'Tab',
      shiftKey,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    elements['modal-upgrade'].dispatchEvent(tab);
    assert.equal(tab.defaultPrevented, true);
    assert.equal(document.activeElement, elements['btn-dismiss-upgrade']);
  }

  const escape = {
    type: 'keydown',
    key: 'Escape',
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
  elements['modal-upgrade'].dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(elements['modal-upgrade'].classList.contains('hidden'), true);
  assert.equal(elements['modal-upgrade'].listeners.keydown.length, 0);
  assert.equal(elements['app-sidebar'].inert, false);
  assert.equal(elements['app-main'].inert, false);
  assert.equal(document.activeElement, elements['btn-package']);

  renderer.showPackageLimitModal({ packageLimit: 25, daysLeft: 2 }, elements['btn-package']);
  assert.equal(elements['modal-upgrade'].listeners.keydown.length, 1);
  elements['btn-dismiss-upgrade'].click();
  assert.equal(elements['modal-upgrade'].listeners.keydown.length, 0);
  assert.equal(document.activeElement, elements['btn-package']);
});

test('renderer recovers rejected IPC and typed package errors in the same modal with fresh tokens', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const project = {
    id: 'package-error-recovery',
    name: 'Package Error Recovery',
    type: 'branding',
    status: 'watching',
    files: [{ name: 'Recovery.ai', ext: '.ai' }],
  };
  const reviews = [1, 2, 3].map(index => ({
    token: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    projectId: project.id,
    files: project.files,
    totalFiles: 1,
    materializable: true,
  }));
  let prepareCalls = 0;
  let packageCalls = 0;
  const renderer = loadRendererHelpers(document, { crate: {
    preScanSession: async () => ({ success: true }),
    preparePackageReview: async () => reviews[prepareCalls++],
    getProjects: async () => [project],
    packageProject: async () => {
      packageCalls++;
      assert.equal(elements['btn-confirm-package'].disabled, true);
      if (packageCalls === 1) throw new Error('synthetic rejected package IPC');
      return { error: 'package_write_failed' };
    },
  } });
  renderer.testProject = project;
  vm.runInContext(`
    state.projects = [testProject];
    state.selectedProjectId = testProject.id;
    state.settings = { namingTemplate: '{Project}_{Date}' };
    state.packageOutputPath = '/private/tmp/crate-synthetic-output';
  `, renderer);

  assert.equal(await renderer.showPackageModal({ runPreScan: false }), true);
  await renderer.confirmPackage();

  assert.equal(packageCalls, 1);
  assert.equal(prepareCalls, 2);
  assert.equal(elements['modal-progress'].classList.contains('hidden'), true);
  assert.equal(elements['modal-package'].classList.contains('hidden'), false);
  assert.equal(elements['modal-package-review-message'].textContent, 'Packaging could not finish. Review the files and try again.');
  assert.equal(elements['modal-package-review-message'].focused, true);
  assert.equal(elements['btn-confirm-package'].disabled, false);
  assert.equal(vm.runInContext('state.packageReviewToken', renderer), reviews[1].token);

  await renderer.confirmPackage();

  assert.equal(packageCalls, 2);
  assert.equal(prepareCalls, 3);
  assert.equal(elements['modal-progress'].classList.contains('hidden'), true);
  assert.equal(elements['modal-package'].classList.contains('hidden'), false);
  assert.equal(elements['btn-confirm-package'].disabled, false);
  assert.equal(vm.runInContext('state.packageReviewToken', renderer), reviews[2].token);
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
  const pendingText = getElementTreeText(elements['pending-file-list'].children[0]);
  assert.equal(pendingText.includes('Save to make package-ready'), true);
  assert.equal(pendingText.includes('provenance'), false);
  assert.equal(pendingText.includes('lsof'), false);
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
  const pendingText = getElementTreeText(elements['pending-file-list'].children[0]);
  assert.equal(pendingText.includes('IMG_5331.JPG'), true);
  assert.equal(pendingText.includes('Save to make package-ready'), true);
  assert.equal(pendingText.includes('provenance'), false);
  assert.equal(pendingText.includes('lsof'), false);
  assert.equal(elements['file-list'].children.length, 1);
  assert.equal(getElementTreeText(elements['file-list'].children[0]).includes('Bris Invitation-03 copy.ai'), true);
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

test('renderer shows the authoritative package quota in Settings, sidebar, and limit dialog', () => {
  const { document, elements } = createInteractiveRendererDom();
  const renderer = loadRendererHelpers(document);
  vm.runInContext(`state.usage = {
    packagesThisMonth: 10,
    packageLimit: 25,
    planId: 'closed-beta',
    planName: 'Closed beta'
  }`, renderer);

  renderer.renderSettingsControls();
  renderer.renderFooter();
  renderer.showPackageLimitModal({ daysLeft: 12, packageLimit: 25 });

  assert.equal(elements['plan-title'].textContent, 'Closed beta');
  assert.equal(elements['plan-info'].textContent, '25 packages/month \u00B7 10/25 used');
  assert.equal(elements['plan-badge'].textContent, 'Beta tester');
  assert.equal(elements['sidebar-plan-title'].textContent, 'Closed beta');
  assert.equal(elements['footer-usage'].textContent, '10 of 25 packages used this month');
  assert.equal(elements['upgrade-title'].textContent, "You've used all 25 packages");
  assert.equal(elements['upgrade-days-left'].textContent, '12');
  assert.equal(elements['modal-upgrade'].classList.contains('hidden'), false);
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
