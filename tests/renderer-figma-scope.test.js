const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createUiSmoothnessFixture } = require('./ui-smoothness-fixture');

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
    appendChild: child => {
      if (child?.parentNode && child.parentNode !== element && typeof child.parentNode.removeChild === 'function') {
        child.parentNode.removeChild(child);
      }
      const currentIndex = element.children.indexOf(child);
      if (currentIndex >= 0) element.children.splice(currentIndex, 1);
      element.children.push(child);
      if (child) child.parentNode = element;
      return child;
    },
    insertBefore: (child, reference) => {
      if (!reference) return element.appendChild(child);
      if (child?.parentNode && child.parentNode !== element && typeof child.parentNode.removeChild === 'function') {
        child.parentNode.removeChild(child);
      }
      const currentIndex = element.children.indexOf(child);
      if (currentIndex >= 0) element.children.splice(currentIndex, 1);
      const referenceIndex = element.children.indexOf(reference);
      element.children.splice(referenceIndex < 0 ? element.children.length : referenceIndex, 0, child);
      if (child) child.parentNode = element;
      return child;
    },
    removeChild: child => {
      const index = element.children.indexOf(child);
      if (index >= 0) element.children.splice(index, 1);
      if (child?.parentNode === element) child.parentNode = null;
      return child;
    },
    replaceChild: (next, previous) => {
      const index = element.children.indexOf(previous);
      if (index >= 0) element.children[index] = next;
      if (previous?.parentNode === element) previous.parentNode = null;
      if (next) next.parentNode = element;
      return previous;
    },
    replaceChildren: (...children) => {
      for (const child of element.children) {
        if (child?.parentNode === element) child.parentNode = null;
      }
      element.children = [];
      children.filter(Boolean).forEach(child => element.appendChild(child));
    },
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
      if (selector.startsWith('[data-render-key="')) {
        const key = selector.slice(18, -2);
        return element.children.find(child => child.dataset?.renderKey === key) || null;
      }
      if (selector === '.project-pill' && html.includes('project-pill')) {
        if (!element.projectPill) {
          element.projectPill = createElementStub('span');
          element.projectPill.ownerDocument = element.ownerDocument;
          element.appendChild(element.projectPill);
        }
        return element.projectPill;
      }
      if (
        selector === '.btn-accept-pending'
        || selector === '.btn-reject-pending'
        || selector === '.app-file-remove'
        || selector === '.project-pill'
        || selector === '.project-delete'
      ) {
        return { addEventListener: () => {} };
      }
      return null;
    },
    querySelectorAll: selector => {
      if (selector.includes('button')) return element.focusableElements;
      if (selector === '[data-render-key]') return createNodeList(element.children);
      return [];
    },
    closest: () => null,
  };

  let html = '';
  let text = '';
  Object.defineProperty(element, 'parentElement', { get: () => element.parentNode || null });
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

function createNodeList(items = []) {
  const nodeList = {
    length: items.length,
    item: index => items[index] || null,
    entries: () => items.entries(),
    forEach: callback => items.forEach(callback),
    keys: () => items.keys(),
    values: () => items.values(),
    [Symbol.iterator]: () => items[Symbol.iterator](),
  };
  items.forEach((item, index) => { nodeList[index] = item; });
  return nodeList;
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
      if (selector === '.app-content') return getElementById('app-content');
      if (selector === '.package-review-modal') return attach(options.packageReviewDialog || null);
      if (selector === '.app-tab[data-tab="projects"]') {
        return attach((options.tabs || []).find(tab => tab.dataset.tab === 'projects') || null);
      }
      return null;
    },
    querySelectorAll: selector => {
      if (selector === '.app-tab') return createNodeList(options.tabs || []);
      if (selector === '.tab-content') return createNodeList(options.tabContents || []);
      if (selector === '.asset-filter') return createNodeList(options.assetFilters || []);
      return createNodeList();
    },
    createElement: tagName => attach(createElementStub(tagName)),
    body,
  };
  body.ownerDocument = document;
  for (const element of Object.values(elements)) attach(element);
  for (const element of [
    ...(options.tabs || []),
    ...(options.tabContents || []),
    ...(options.assetFilters || []),
  ]) attach(element);
  return document;
}

function createInteractiveRendererDom() {
  const elements = {
    'app-sidebar': createElementStub('aside'),
    'app-main': createElementStub('main'),
    'app-content': createElementStub('main'),
    'tab-projects': createElementStub('section'),
    'tab-current-project': createElementStub('section'),
    'tab-settings': createElementStub('section'),
    'asset-review-search': createElementStub('input'),
    'btn-package': createElementStub('button'),
    'btn-change-dest': createElementStub('button'),
    'btn-cancel-package': createElementStub('button'),
    'btn-confirm-package': createElementStub('button'),
    'toggle-package-folders': createElementStub('input'),
    'toggle-package-review-folders': createElementStub('input'),
    'package-review-organization-status': createElementStub(),
    'btn-review-existing-assets-later': createElementStub('button'),
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
    elements['toggle-package-review-folders'],
    elements['btn-cancel-package'],
    elements['btn-confirm-package'],
  ];
  elements['modal-existing-assets'].focusableElements = [
    elements['btn-review-existing-assets-later'],
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
  const tabs = ['projects', 'current-project', 'settings'].map(tabName => {
    const tab = createElementStub('button');
    tab.dataset.tab = tabName;
    if (tabName === 'projects') tab.classList.add('active');
    return tab;
  });
  const tabContents = ['projects', 'current-project', 'settings'].map(tabName => {
    const tabContent = elements[`tab-${tabName}`];
    tabContent.id = `tab-${tabName}`;
    if (tabName === 'projects') tabContent.classList.add('active');
    return tabContent;
  });
  const assetFilters = ['all', 'existing', 'added', 'missing', 'excluded'].map(filter => {
    const button = createElementStub('button');
    button.dataset.assetFilter = filter;
    if (filter === 'all') {
      button.classList.add('active');
      button.setAttribute('aria-pressed', 'true');
    } else {
      button.setAttribute('aria-pressed', 'false');
    }
    return button;
  });
  const packageReviewDialog = createElementStub();
  const document = createDocumentStub(elements, {
    createMissingIds: true,
    tabs,
    tabContents,
    assetFilters,
    packageReviewDialog,
  });
  return { document, elements, tabs, tabContents, assetFilters, packageReviewDialog };
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

function loadRendererHelpers(document = createDocumentStub(), windowOverrides = {}, contextOverrides = {}) {
  const context = {
    console,
    document,
    window: windowOverrides,
    setTimeout,
    clearTimeout,
    Date,
    ...contextOverrides,
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
        appFamily: file.appFamily || file.captureEvidence?.appFamily || null,
        sourceName: file.sourceName || file.captureEvidence?.sourceName || null,
        assetOrigin: file.assetOrigin,
        projectRole: file.projectRole,
        protectedSource: file.protectedSource === true || file.projectRole === 'source',
        excluded: (project?.excludedAssetKeys || []).includes(file.fileId || file.path),
        visualIdentity: file.visualIdentity || file.fileId || `opaque-${index}-${file.name || 'file'}`,
        visualRevision: file.visualRevision || `revision-${index}-${file.name || 'file'}`,
        sourceIndex: index,
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

function cloneTestValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function createPendingBatchProject(id = 'pending-batch-project') {
  return {
    id,
    name: 'Pending Batch Project',
    type: 'branding',
    status: 'watching',
    files: [{
      path: '/synthetic/Working.ai',
      name: 'Working.ai',
      ext: '.ai',
      source: 'manual-browse',
      assetOrigin: 'added',
      projectRole: 'source',
    }],
    pendingFiles: Array.from({ length: 4 }, (_, index) => ({
      path: `/synthetic/Needs_${index + 1}.png`,
      name: `Needs_${index + 1}.png`,
      ext: '.png',
      source: 'ai-linked',
      captureState: 'pending',
      captureEvidence: {
        appFamily: 'illustrator',
        sourceName: 'Working.ai',
        reason: 'linked-asset-observed',
      },
    })),
    excludedAssetKeys: [],
    assetBaseline: { status: 'included', decision: 'include' },
  };
}

function createPendingBatchBridge(project, {
  allowedPaths = null,
  beforeAccept = null,
  omitPresentationIdentity = false,
} = {}) {
  let persisted = cloneTestValue(project);
  const calls = [];
  const allowed = allowedPaths ? new Set(allowedPaths) : null;
  const targetFor = file => file.path || file.visualIdentity || file.fileId || null;
  const present = (file, sourceIndex) => ({
    name: file.name,
    ext: file.ext,
    assetOrigin: file.assetOrigin,
    projectRole: file.projectRole,
    protectedSource: file.projectRole === 'source',
    visualIdentity: omitPresentationIdentity ? null : (file.visualIdentity || file.fileId || file.path || null),
    visualRevision: `revision:${file.visualIdentity || file.fileId || file.path || file.name}`,
    sourceIndex,
  });
  const findPending = target => persisted.pendingFiles.find(file => (
    file.path === target || file.visualIdentity === target || file.fileId === target
  ));
  const bridge = {
    getProjects: async () => [cloneTestValue(persisted)],
    getAssetWorkspace: async projectId => ({
      projectId,
      files: persisted.files.map(present),
      pendingFiles: persisted.pendingFiles.map(present),
    }),
    acceptPending: async (projectId, target) => {
      calls.push({ action: 'acceptPending', projectId, target });
      if (beforeAccept) await beforeAccept();
      const file = findPending(target);
      if (!file || (allowed && !allowed.has(targetFor(file)))) return null;
      persisted.pendingFiles = persisted.pendingFiles.filter(candidate => candidate !== file);
      persisted.files.push({ ...file, captureState: 'ready', acceptedPending: true });
      return {
        files: cloneTestValue(persisted.files),
        pendingFiles: cloneTestValue(persisted.pendingFiles),
      };
    },
    rejectPending: async (projectId, target) => {
      calls.push({ action: 'rejectPending', projectId, target });
      const file = findPending(target);
      if (!file || (allowed && !allowed.has(targetFor(file)))) return cloneTestValue(persisted.pendingFiles);
      persisted.pendingFiles = persisted.pendingFiles.filter(candidate => candidate !== file);
      persisted.excludedAssetKeys.push(file.path || file.visualIdentity || file.fileId);
      return cloneTestValue(persisted.pendingFiles);
    },
  };
  return { bridge, calls, getPersisted: () => persisted };
}

async function loadPendingBatchFixture(options = {}) {
  const { document, elements } = createInteractiveRendererDom();
  const project = options.project || createPendingBatchProject(options.id);
  const batch = createPendingBatchBridge(project, options);
  const renderer = loadRendererHelpers(document, { crate: batch.bridge });
  renderer.testProject = project;
  vm.runInContext(`
    state.projects = [testProject];
    state.selectedProjectId = testProject.id;
    state.assetReviewOpen = true;
  `, renderer);
  await renderer.renderFiles();
  return { document, elements, project, renderer, ...batch };
}

test('renderer defaults a missing package organization preference to folders', () => {
  const renderer = loadRendererHelpers();

  assert.equal(renderer.getPackageOutputLayoutMode({}), 'by-extension-v1');
  assert.equal(
    renderer.getPackageOutputLayoutMode({ packageOutputLayoutMode: 'flat' }),
    'flat'
  );
  assert.equal(
    renderer.getPackageOutputLayoutMode({ packageOutputLayoutMode: 'corrupt-layout-value' }),
    'flat'
  );
});

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

test('Figma link preflight deadline stays below the renderer project-creation boundary', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const mainMatch = mainSource.match(/const FIGMA_LINK_PREFLIGHT_TIMEOUT_MS = ([\d_]+);/);
  const rendererMatch = rendererSource.match(/const PROJECT_CREATION_REQUEST_TIMEOUT_MS = ([\d_]+);/);
  assert.ok(mainMatch);
  assert.ok(rendererMatch);
  const preflightMs = Number(mainMatch[1].replace(/_/g, ''));
  const creationMs = Number(rendererMatch[1].replace(/_/g, ''));
  assert.ok(preflightMs > 0);
  assert.ok(preflightMs < creationMs);
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

  const opener = document.querySelector('#files-figma-scope');
  opener.focus();
  renderer.openEditFigmaLinkModal(project.id);
  assert.equal(elements['edit-figma-url'].value, '');
  assert.equal(elements['edit-figma-url'].focused, true);
  assert.equal(elements['modal-edit-figma-link']._crateOpener, opener);

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

test('Figma scan lifecycle uses the single status announcement without duplicate toasts', () => {
  const { document, elements } = createInteractiveRendererDom();
  const handlers = {};
  const noOp = () => {};
  const renderer = loadRendererHelpers(document, { crate: {
    onFilesUpdated: noOp,
    onProjectUpdated: noOp,
    onPendingFilesUpdated: noOp,
    onPackageTrigger: noOp,
    onFigmaAuthError: noOp,
    onFigmaScanStarted: handler => { handlers.started = handler; },
    onFigmaScanComplete: handler => { handlers.complete = handler; },
    onFigmaScanError: handler => { handlers.error = handler; },
  } });

  renderer.setupMainProcessListeners();
  handlers.started({ timestamp: Date.UTC(2026, 5, 17, 12, 0, 0) });
  assert.match(elements['figma-scan-status'].textContent, /Scan started/);
  assert.equal(elements['toast-message'], undefined);

  handlers.complete({
    filesFound: 2,
    assetsFound: 1,
    addedCount: 1,
    timestamp: Date.UTC(2026, 5, 17, 12, 1, 0),
  });
  assert.match(elements['figma-scan-status'].textContent, /Scan completed/);
  assert.equal(elements['toast-message'], undefined);

  handlers.complete({
    filesFound: 2,
    assetsFound: 0,
    warning: 'Current Page Only could not be locked.',
    timestamp: Date.UTC(2026, 5, 17, 12, 2, 0),
  });
  assert.match(elements['figma-scan-status'].textContent, /could not be locked/);
  assert.equal(elements['toast-message'], undefined);

  handlers.error({ error: 'Figma is unavailable' });
  assert.match(elements['figma-scan-status'].textContent, /Figma is unavailable/);
  assert.equal(elements['toast-message'], undefined);
});

for (const [label, result, expectedMessage] of [
  ['already in progress', { triggered: 0, inFlight: true }, 'Figma scan already in progress'],
  ['no active projects', { triggered: 0, skipped: 0, inFlight: false }, 'No active projects to scan'],
]) {
  test(`Scan Now routes the ${label} result through the sole status announcement`, async () => {
    const { document, elements } = createInteractiveRendererDom();
    const renderer = loadRendererHelpers(document, { crate: {
      figmaScanNow: async () => result,
    } });

    renderer.setupEventListeners();
    const scanHandler = elements['btn-figma-scan-now'].listeners.click[0];
    await scanHandler();

    assert.equal(elements['figma-scan-status'].textContent, expectedMessage);
    assert.equal(elements['toast-message'], undefined);
  });
}

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
      {
        name: 'Existing Linked.png', path: '/synthetic/Existing Linked.png', ext: '.png',
        assetOrigin: 'existing', projectRole: 'asset',
        captureEvidence: { appFamily: 'illustrator', sourceName: 'Existing Project.ai' },
      },
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
  assert.equal(elements['existing-assets-modal-count'].textContent, '1 existing asset included by default');
  assert.equal(elements['existing-assets-modal-title'].textContent, '1 asset was already in this file');
  assert.equal(elements['existing-assets-modal-source'].textContent, 'Illustrator · Existing Project.ai');
  assert.equal(elements['existing-assets-modal-list'].children.length, 1);
  assert.equal(elements['existing-assets-modal-list'].children[0].children[1].textContent, 'Existing Linked.png');
  assert.equal(getElementTreeText(elements['existing-assets-modal-list']).includes('Illustrator'), true);
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
  assert.equal(document.activeElement, elements['btn-review-existing-assets-later']);
});

test('Review Later keeps Existing Assets included without opening the detailed review workspace', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const project = {
    id: 'review-later-includes-existing',
    files: [{ name: 'Existing.png', assetOrigin: 'existing', projectRole: 'asset' }],
    pendingFiles: [],
    excludedAssetKeys: [],
    assetBaseline: { status: 'decision-required', decision: null, establishedAt: 1 },
  };
  const includedProject = {
    ...project,
    assetBaseline: { status: 'included', decision: 'include', establishedAt: 1 },
  };
  const decisions = [];
  const renderer = loadRendererHelpers(document, { crate: {
    setExistingAssetsDecision: async (projectId, decision) => {
      decisions.push([projectId, decision]);
      return { success: true, project: includedProject };
    },
    getProjects: async () => [includedProject],
  } });
  renderer.testProject = project;
  vm.runInContext('state.projects = [testProject]; state.selectedProjectId = testProject.id;', renderer);
  await renderer.showExistingAssetsDecisionModal(project);
  renderer.setupEventListeners();

  await elements['btn-review-existing-assets-later'].listeners.click[0]();

  assert.deepEqual(decisions, [[project.id, 'include']]);
  assert.equal(vm.runInContext('state.assetReviewOpen', renderer), false);
  assert.equal(elements['modal-existing-assets'].classList.contains('hidden'), true);
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
  elements['btn-review-existing-assets-later'].focus();
  await renderer.submitExistingAssetsDecision('skip');

  assert.equal(elements['modal-existing-assets'].classList.contains('hidden'), false);
  assert.equal(elements['btn-review-existing-assets-later'].disabled, false);
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
  assert.equal(getElementTreeText(elements['project-file-list'].children[0]).includes('Existing Project.ai'), true);
  assert.equal(elements['existing-assets-list'].children.length, 1);
  assert.equal(getElementTreeText(elements['existing-assets-list'].children[0]).includes('Existing Linked.png'), true);
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
  assert.equal(getElementTreeText(elements['project-file-list']).includes('Ready'), true);
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

test('Review Assets renders the accepted source card and omits scoped stale pending rows', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const persistedProject = {
    id: 'resumed-illustrator-project',
    name: 'Resumed Illustrator Project',
    type: 'branding',
    status: 'watching',
    files: [{
      name: 'Accepted_Native_Illustrator.ai',
      ext: '.ai',
      assetOrigin: 'added',
      projectRole: 'source',
      protectedSource: true,
      visualIdentity: 'accepted-source-identity',
      visualRevision: 'accepted-source-revision',
    }],
    pendingFiles: [{
      name: 'Stale_Prior_Activation.ai',
      path: '/synthetic/Stale_Prior_Activation.ai',
      ext: '.ai',
      captureSessionId: 'stale-prior-activation',
      captureState: 'needs-save',
      projectId: 'resumed-illustrator-project',
    }],
    excludedAssetKeys: [],
    assetBaseline: { status: 'included', decision: 'include' },
  };
  const project = { ...persistedProject, pendingFiles: [] };
  const renderer = loadRendererHelpers(document, {
    crate: {
      getProjects: async () => [project],
      getAssetWorkspace: async projectId => ({
        projectId,
        files: project.files,
        pendingFiles: [],
      }),
    },
  });
  assert.equal(persistedProject.pendingFiles.length, 1);
  assert.deepEqual(project.pendingFiles, []);
  renderer.testProject = project;
  vm.runInContext(`
    state.projects = [testProject];
    state.selectedProjectId = testProject.id;
    state.assetReviewOpen = true;
  `, renderer);

  await renderer.renderFiles();

  assert.equal(elements['project-file-list'].children.length, 1);
  assert.equal(getElementTreeText(elements['project-file-list']).includes('Accepted_Native_Illustrator.ai'), true);
  assert.equal(elements['pending-file-list'].children.length, 0);
  assert.equal(elements['pending-section'].classList.contains('hidden'), true);
  assert.equal(elements['asset-review-workspace'].classList.contains('hidden'), false);
});

test('Current Project dashboard uses Working Files and privacy-safe mixed-app origin labels', () => {
  const { document, elements } = createInteractiveRendererDom();
  const project = {
    id: 'mixed-app-dashboard',
    figmaScopeMode: 'current-page',
    figmaTrackedFiles: [{ status: 'tracked' }],
    files: [],
    pendingFiles: [],
    excludedAssetKeys: [],
  };
  const files = [
    {
      name: 'Brand-System.ai', ext: '.ai', appFamily: 'illustrator', projectRole: 'source',
      protectedSource: true, assetOrigin: 'added', visualIdentity: 'source', visualRevision: 'source-r1',
    },
    {
      name: 'campaign-hero.jpg', ext: '.jpg', appFamily: 'illustrator', sourceName: 'Brand-System.ai',
      projectRole: 'asset', assetOrigin: 'existing', visualIdentity: 'existing', visualRevision: 'existing-r1',
    },
    {
      name: 'slide-image.png', ext: '.png', appFamily: 'powerpoint', sourceName: 'Launch-Deck.pptx',
      projectRole: 'asset', assetOrigin: 'added', visualIdentity: 'added', visualRevision: 'added-r1',
    },
    {
      name: 'Petra Logo.png', ext: '.png', appFamily: 'figma', sourceName: 'Petra Logo',
      projectRole: 'asset', assetOrigin: 'added', visualIdentity: 'figma', visualRevision: 'figma-r1',
    },
  ];
  const renderer = loadRendererHelpers(document, { crate: {} });
  renderer.testWorkspace = { projectId: project.id, files, pendingFiles: [] };
  vm.runInContext('state.assetWorkspace = testWorkspace;', renderer);

  renderer.renderAssetWorkspace(project, {}, files);

  assert.equal(elements['metric-existing-count'].textContent, '1');
  assert.equal(elements['metric-added-count'].textContent, '2');
  assert.equal(elements['metric-missing-count'].textContent, '0');
  assert.equal(getElementTreeText(elements['project-file-list']).includes('Brand-System.ai'), true);
  assert.equal(getElementTreeText(elements['project-file-list']).includes('Illustrator'), true);
  assert.equal(getElementTreeText(elements['project-file-list']).includes('Petra Logo'), true);
  assert.equal(getElementTreeText(elements['project-file-list']).includes('Figma · Current Page'), true);
  assert.equal(elements['project-file-list'].children.length, 2);
  assert.equal(elements['asset-review-summary'].textContent, '3 assets included · 2 Working Files ready');
  assert.equal(elements['asset-review-footer-summary'].textContent, '3 assets included · 2 Working Files ready');
  assert.equal(getElementTreeText(elements['existing-assets-list']).includes('Illustrator · Brand-System.ai'), true);
  assert.equal(getElementTreeText(elements['added-assets-list']).includes('PowerPoint · Launch-Deck.pptx'), true);
  assert.equal(getElementTreeText(elements['added-assets-list']).includes('Figma · Current Page'), true);
  assert.equal(getElementTreeText(elements['asset-origin-list']).includes('Illustrator'), true);
  assert.equal(getElementTreeText(elements['asset-origin-list']).includes('PowerPoint'), true);
  assert.equal(getElementTreeText(elements['asset-origin-list']).includes('Figma'), true);
  assert.equal(getElementTreeText(elements['asset-origin-list']).includes('/synthetic/'), false);
  const recentText = getElementTreeText(elements['recent-assets-list']);
  assert.equal(recentText.includes('Illustrator · Brand-System.ai'), true);
  assert.equal(recentText.includes('PowerPoint · Launch-Deck.pptx'), true);
  assert.equal(recentText.includes('Figma · Current Page'), true);
});

test('generic presentation assets preserve Keynote and PowerPoint source application labels', () => {
  const { document, elements } = createInteractiveRendererDom();
  const project = {
    id: 'presentation-source-labels',
    name: 'Presentation Source Labels',
    files: [],
    pendingFiles: [],
    excludedAssetKeys: [],
  };
  const files = [
    {
      name: 'keynote-image.png', ext: '.png', appFamily: 'presentation', sourceName: 'Launch.key',
      projectRole: 'asset', assetOrigin: 'added', visualIdentity: 'keynote', visualRevision: 'keynote-r1',
    },
    {
      name: 'powerpoint-image.png', ext: '.png', appFamily: 'presentation', sourceName: 'Pitch.pptx',
      projectRole: 'asset', assetOrigin: 'added', visualIdentity: 'powerpoint', visualRevision: 'powerpoint-r1',
    },
  ];
  const renderer = loadRendererHelpers(document, { crate: {} });

  renderer.renderAssetWorkspace(project, {}, files);

  const workspaceText = getElementTreeText(elements['added-assets-list']);
  assert.equal(workspaceText.includes('Keynote · Launch.key'), true);
  assert.equal(workspaceText.includes('PowerPoint · Pitch.pptx'), true);
  assert.equal(workspaceText.includes('PowerPoint · Launch.key'), false);

  renderer.renderPackageReview(project, {
    token: '00000000-0000-4000-8000-000000000305',
    materializable: true,
    files,
  });

  const reviewText = getElementTreeText(elements['modal-file-list']);
  const appText = getElementTreeText(elements['package-review-apps']);
  assert.equal(reviewText.includes('Keynote · Launch.key'), true);
  assert.equal(reviewText.includes('PowerPoint · Pitch.pptx'), true);
  assert.equal(reviewText.includes('PowerPoint · Launch.key'), false);
  assert.equal(appText.includes('Keynote'), true);
  assert.equal(appText.includes('PowerPoint'), true);
});

test('unknown generic assets omit the generic origin marker while retaining meaningful source context', () => {
  const { document, elements } = createInteractiveRendererDom();
  const project = { id: 'generic-origin-cleanup', files: [], pendingFiles: [], excludedAssetKeys: [] };
  const renderer = loadRendererHelpers(document, { crate: {} });
  const generic = {
    name: 'standalone.png', ext: '.png', projectRole: 'asset', assetOrigin: 'added',
    visualIdentity: 'generic', visualRevision: 'generic-r1',
  };
  const genericWithContext = {
    ...generic, name: 'linked.png', sourceName: 'Brand-System.ai', visualIdentity: 'generic-context',
  };
  const illustrator = {
    ...generic, name: 'illustrator-linked.png', appFamily: 'illustrator', sourceName: 'Brand-System.ai',
    visualIdentity: 'illustrator',
  };

  assert.equal(renderer.createAppOriginLabel(generic, project), null);
  const genericRowText = getElementTreeText(renderer.createAssetFileRow(project, generic, { loadVisual: false }));
  assert.equal(genericRowText.includes('File'), false);
  assert.equal(genericRowText.includes('•'), false);

  const contextLabel = renderer.createAppOriginLabel(genericWithContext, project);
  assert.ok(contextLabel);
  assert.equal(getElementTreeText(contextLabel).trim(), 'Brand-System.ai');
  assert.equal(getElementTreeText(contextLabel).includes('File'), false);
  assert.equal(getElementTreeText(contextLabel).includes('•'), false);

  renderer.renderAssetWorkspace(project, {}, [generic, genericWithContext]);
  const originText = getElementTreeText(elements['asset-origin-list']);
  assert.equal(originText.includes('File'), false);
  assert.equal(originText.includes('•'), false);

  const knownLabel = renderer.createAppOriginLabel(illustrator, project);
  assert.ok(knownLabel);
  assert.equal(getElementTreeText(knownLabel).includes('Illustrator · Brand-System.ai'), true);
});

test('Current Project review alert uses correct singular and plural copy', () => {
  const { document, elements } = createInteractiveRendererDom();
  const project = { id: 'linking-copy', files: [], pendingFiles: [], excludedAssetKeys: [] };
  const renderer = loadRendererHelpers(document, { crate: {} });
  const pending = index => ({
    name: `Missing-${index}.png`, ext: '.png', captureState: 'needs-save',
    visualIdentity: `missing-${index}`, visualRevision: `missing-r${index}`,
  });

  renderer.testWorkspace = { projectId: project.id, files: [], pendingFiles: [pending(1)] };
  vm.runInContext('state.assetWorkspace = testWorkspace;', renderer);
  renderer.renderAssetWorkspace(project, {}, []);
  assert.equal(elements['project-linking-alert'].textContent, '1 file needs review');

  renderer.testWorkspace.pendingFiles.push(pending(2));
  renderer.renderAssetWorkspace(project, {}, []);
  assert.equal(elements['project-linking-alert'].textContent, '2 files need review');
});

test('Figma Working File and asset labels reflect Entire File scope without fabricating a local source file', () => {
  const { document, elements } = createInteractiveRendererDom();
  const project = {
    id: 'figma-entire-file-dashboard',
    figmaScopeMode: 'entire-file',
    figmaTrackedFiles: [{ status: 'tracked' }],
    files: [],
    pendingFiles: [],
    excludedAssetKeys: [],
  };
  const files = [{
    name: 'Entire_File_Asset.png', ext: '.png', appFamily: 'figma', sourceName: 'Petra Logo',
    projectRole: 'asset', assetOrigin: 'added', visualIdentity: 'figma-entire', visualRevision: 'figma-entire-r1',
  }];
  const renderer = loadRendererHelpers(document, { crate: {} });

  renderer.renderAssetWorkspace(project, {}, files);

  const workingFilesText = getElementTreeText(elements['project-file-list']);
  assert.equal(workingFilesText.includes('Petra Logo'), true);
  assert.equal(workingFilesText.includes('Figma · Entire File'), true);
  assert.equal(workingFilesText.includes('.fig'), false);
  assert.equal(getElementTreeText(elements['added-assets-list']).includes('Figma · Entire File'), true);
});

test('same-named local and Figma Working Files remain distinct with written application context', () => {
  const { document, elements } = createInteractiveRendererDom();
  const project = {
    id: 'same-name-mixed-working-files',
    figmaScopeMode: 'current-page',
    figmaTrackedFiles: [{ status: 'tracked' }],
    files: [],
    pendingFiles: [],
    excludedAssetKeys: [],
  };
  const files = [
    {
      name: 'Shared Campaign', ext: '.ai', appFamily: 'illustrator', projectRole: 'source',
      protectedSource: true, assetOrigin: 'added', visualIdentity: 'local-source', visualRevision: 'local-r1',
    },
    {
      name: 'Shared_Campaign_Asset.png', ext: '.png', appFamily: 'figma', sourceName: 'Shared Campaign',
      projectRole: 'asset', assetOrigin: 'added', visualIdentity: 'figma-asset', visualRevision: 'figma-r1',
    },
  ];
  const renderer = loadRendererHelpers(document, { crate: {} });

  renderer.renderAssetWorkspace(project, {}, files);

  assert.equal(elements['project-file-list'].children.length, 2);
  const workingFilesText = getElementTreeText(elements['project-file-list']);
  assert.equal(workingFilesText.includes('Illustrator'), true);
  assert.equal(workingFilesText.includes('Figma · Current Page'), true);
  assert.equal((workingFilesText.match(/Shared Campaign/g) || []).length, 2);
});

test('Review Assets switches from the dashboard without changing inclusion state', () => {
  const { document, elements, assetFilters } = createInteractiveRendererDom();
  const renderer = loadRendererHelpers(document, { crate: {} });

  renderer.openAssetReviewWorkspace();
  assert.equal(elements['project-dashboard'].classList.contains('hidden'), true);
  assert.equal(elements['asset-review-workspace'].classList.contains('hidden'), false);
  assert.equal(elements['asset-review-heading'].focused, true);
  assert.equal(assetFilters[0].getAttribute('aria-pressed'), 'true');
  assert.equal(vm.runInContext('state.assetReviewOpen', renderer), true);

  vm.runInContext("state.assetReviewFilter = 'added';", renderer);
  renderer.applyAssetReviewFilter();
  assert.equal(assetFilters[0].getAttribute('aria-pressed'), 'false');
  assert.equal(assetFilters[2].getAttribute('aria-pressed'), 'true');

  renderer.closeAssetReviewWorkspace();
  assert.equal(elements['project-dashboard'].classList.contains('hidden'), false);
  assert.equal(elements['asset-review-workspace'].classList.contains('hidden'), true);
  assert.equal(vm.runInContext('state.assetReviewOpen', renderer), false);
});

test('Review Assets search filters Needs Review rows and hides an empty pending section', () => {
  const { document, elements } = createInteractiveRendererDom();
  const renderer = loadRendererHelpers(document, { crate: {} });
  const pendingList = document.querySelector('#pending-file-list');
  const pendingSection = document.querySelector('#pending-section');
  const matching = createElementStub();
  matching.dataset.assetSearch = 'campaign-font.otf otf illustrator brand-system.ai';
  const other = createElementStub();
  other.dataset.assetSearch = 'missing-photo.png png photoshop product-mockup.psd';
  pendingList.appendChild(matching);
  pendingList.appendChild(other);

  vm.runInContext("state.assetReviewFilter = 'all'; state.assetReviewQuery = 'campaign-font';", renderer);
  renderer.applyAssetReviewFilter();
  assert.equal(matching.classList.contains('filtered-out'), false);
  assert.equal(other.classList.contains('filtered-out'), true);
  assert.equal(pendingSection.classList.contains('filtered-out'), false);

  vm.runInContext("state.assetReviewQuery = 'does-not-match';", renderer);
  renderer.applyAssetReviewFilter();
  assert.equal(matching.classList.contains('filtered-out'), true);
  assert.equal(other.classList.contains('filtered-out'), true);
  assert.equal(pendingSection.classList.contains('filtered-out'), true);
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

test('Needs Review items all use the individual Add contract through one bulk action', async () => {
  const fixture = await loadPendingBatchFixture({ id: 'pending-batch-add' });
  assert.equal(fixture.elements['btn-include-all-existing'].textContent, 'Add All');
  assert.equal(fixture.elements['btn-include-all-existing'].disabled, false);
  assert.equal(fixture.elements['pending-file-list'].children.length, 4);

  assert.equal(await fixture.renderer.submitAssetReviewBatchDecision('include'), true);

  assert.equal(fixture.calls.length, 4);
  assert.equal(fixture.calls.every(call => call.action === 'acceptPending'), true);
  assert.deepEqual(fixture.getPersisted().pendingFiles, []);
  assert.equal(fixture.getPersisted().files.length, 5);
  assert.equal(fixture.elements['filter-count-missing'].textContent, '0');
  assert.equal(fixture.elements['filter-count-added'].textContent, '4');
  assert.equal(fixture.elements['asset-review-summary'].textContent, '4 assets included · 1 Working File ready');
  assert.equal(fixture.elements['asset-review-footer-summary'].textContent, '4 assets included · 1 Working File ready');
  assert.equal(fixture.elements['pending-section'].classList.contains('hidden'), true);
  assert.equal(fixture.elements['asset-review-workspace'].classList.contains('hidden'), false);
  assert.equal(fixture.document.querySelector('#btn-review-assets-continue').disabled, false);
});

test('Needs Review items all use the individual Skip contract through one bulk action', async () => {
  const fixture = await loadPendingBatchFixture({ id: 'pending-batch-skip' });
  assert.equal(fixture.elements['btn-skip-all-existing'].textContent, 'Skip All');
  assert.equal(fixture.elements['btn-skip-all-existing'].disabled, false);

  assert.equal(await fixture.renderer.submitAssetReviewBatchDecision('skip'), true);

  assert.equal(fixture.calls.length, 4);
  assert.equal(fixture.calls.every(call => call.action === 'rejectPending'), true);
  assert.deepEqual(fixture.getPersisted().pendingFiles, []);
  assert.deepEqual(fixture.getPersisted().files.map(file => file.name), ['Working.ai']);
  assert.equal(fixture.getPersisted().excludedAssetKeys.length, 4);
  assert.equal(fixture.elements['filter-count-all'].textContent, '0');
  assert.equal(fixture.elements['filter-count-missing'].textContent, '0');
  assert.equal(fixture.elements['asset-review-summary'].textContent, '0 assets included · 1 Working File ready');
  assert.equal(fixture.elements['asset-review-footer-summary'].textContent, '0 assets included · 1 Working File ready');
  assert.equal(fixture.elements['pending-section'].classList.contains('hidden'), true);
});

test('Needs Review bulk Add leaves ineligible candidates unchanged and reports a partial result', async () => {
  const project = createPendingBatchProject('pending-batch-mixed');
  const allowedPaths = project.pendingFiles.slice(0, 3).map(file => file.path);
  const fixture = await loadPendingBatchFixture({ project, allowedPaths });

  assert.equal(await fixture.renderer.submitAssetReviewBatchDecision('include'), true);

  assert.equal(fixture.calls.length, 4);
  assert.equal(fixture.calls.every(call => call.action === 'acceptPending'), true);
  assert.equal(fixture.getPersisted().files.length, 4);
  assert.deepEqual(fixture.getPersisted().pendingFiles.map(file => file.path), [project.pendingFiles[3].path]);
  assert.equal(fixture.elements['filter-count-missing'].textContent, '1');
  assert.equal(fixture.elements['asset-review-summary'].textContent, '3 assets included · 1 Working File ready · 1 need attention');
  assert.equal(fixture.elements['btn-include-all-existing'].disabled, false);
});

test('Needs Review bulk decisions exclude Needs Save and Opened items while preserving mixed state', async () => {
  const addProject = createPendingBatchProject('pending-batch-mixed-states-add');
  addProject.pendingFiles[2].captureState = 'needs-save';
  addProject.pendingFiles[3].captureState = 'observed';
  const addFixture = await loadPendingBatchFixture({ project: addProject });

  assert.equal(await addFixture.renderer.submitAssetReviewBatchDecision('include'), true);
  assert.deepEqual(addFixture.calls.map(call => call.target), [
    addProject.pendingFiles[0].path,
    addProject.pendingFiles[1].path,
  ]);
  assert.deepEqual(addFixture.getPersisted().pendingFiles.map(file => file.name), [
    'Needs_3.png',
    'Needs_4.png',
  ]);
  assert.deepEqual(addFixture.getPersisted().pendingFiles.map(file => file.captureState), ['needs-save', 'observed']);
  assert.equal(addFixture.elements['filter-count-added'].textContent, '2');
  assert.equal(addFixture.elements['filter-count-missing'].textContent, '2');
  assert.equal(addFixture.elements['btn-include-all-existing'].textContent, 'Add All');
  assert.equal(addFixture.elements['btn-include-all-existing'].disabled, true);
  assert.equal(addFixture.elements['btn-skip-all-existing'].disabled, true);
  assert.deepEqual(
    Array.from(addFixture.elements['pending-file-list'].children).map(row => (
      row.children.find(child => child.className === 'pending-state-badge').textContent
    )),
    ['Needs Save', 'Opened'],
  );

  const skipProject = createPendingBatchProject('pending-batch-mixed-states-skip');
  skipProject.pendingFiles[2].captureState = 'needs-save';
  skipProject.pendingFiles[3].captureState = 'observed';
  const skipFixture = await loadPendingBatchFixture({ project: skipProject });

  assert.equal(await skipFixture.renderer.submitAssetReviewBatchDecision('skip'), true);
  assert.deepEqual(skipFixture.calls.map(call => call.target), [
    skipProject.pendingFiles[0].path,
    skipProject.pendingFiles[1].path,
  ]);
  assert.deepEqual(skipFixture.getPersisted().pendingFiles.map(file => file.name), [
    'Needs_3.png',
    'Needs_4.png',
  ]);
  assert.deepEqual(skipFixture.getPersisted().pendingFiles.map(file => file.captureState), ['needs-save', 'observed']);
  assert.equal(skipFixture.getPersisted().excludedAssetKeys.length, 2);
  assert.equal(skipFixture.elements['filter-count-missing'].textContent, '2');
  assert.equal(skipFixture.elements['btn-skip-all-existing'].disabled, true);
});

test('duplicate pending names bind bulk actions by stable identity or original source index', async () => {
  for (const omitPresentationIdentity of [false, true]) {
    for (const reviewFirst of [false, true]) {
      for (const decision of ['include', 'skip']) {
        const project = createPendingBatchProject(
          `pending-batch-duplicate-${omitPresentationIdentity}-${reviewFirst}-${decision}`,
        );
        const needsSave = {
          ...project.pendingFiles[0],
          path: '/synthetic/duplicate-needs-save.png',
          name: 'Same Name.png',
          captureState: 'needs-save',
        };
        const needsReview = {
          ...project.pendingFiles[1],
          path: '/synthetic/duplicate-needs-review.png',
          name: 'Same Name.png',
          captureState: 'pending',
        };
        project.pendingFiles = reviewFirst
          ? [needsReview, needsSave]
          : [needsSave, needsReview];
        const fixture = await loadPendingBatchFixture({
          project,
          omitPresentationIdentity,
        });

        assert.equal(fixture.elements['btn-include-all-existing'].disabled, false);
        assert.equal(fixture.elements['btn-skip-all-existing'].disabled, false);
        assert.deepEqual(
          Array.from(fixture.elements['pending-file-list'].children).map(row => (
            row.children.find(child => child.className === 'pending-state-badge').textContent
          )),
          reviewFirst ? ['Needs Review', 'Needs Save'] : ['Needs Save', 'Needs Review'],
        );

        assert.equal(await fixture.renderer.submitAssetReviewBatchDecision(decision), true);
        assert.deepEqual(fixture.calls.map(call => call.target), [needsReview.path]);
        assert.deepEqual(fixture.getPersisted().pendingFiles.map(file => file.path), [needsSave.path]);
        assert.equal(fixture.getPersisted().pendingFiles[0].captureState, 'needs-save');
        assert.equal(fixture.elements['filter-count-missing'].textContent, '1');
        assert.equal(fixture.elements['filter-count-all'].textContent, decision === 'include' ? '2' : '1');
        assert.equal(fixture.elements['filter-count-added'].textContent, decision === 'include' ? '1' : '0');
        const expectedSummary = decision === 'include'
          ? '1 asset included · 1 Working File ready · 1 need attention'
          : '0 assets included · 1 Working File ready · 1 need attention';
        assert.equal(fixture.elements['asset-review-summary'].textContent, expectedSummary);
        assert.equal(fixture.elements['asset-review-footer-summary'].textContent, expectedSummary);
        assert.equal(fixture.document.querySelector('#btn-review-assets-continue').disabled, false);
        assert.equal(fixture.elements['btn-include-all-existing'].disabled, true);
        assert.equal(fixture.elements['btn-skip-all-existing'].disabled, true);
        assert.equal(fixture.elements['asset-review-search'].value, '');
        if (decision === 'include') {
          assert.equal(fixture.getPersisted().files.some(file => file.path === needsReview.path), true);
        } else {
          assert.deepEqual(fixture.getPersisted().excludedAssetKeys, [needsReview.path]);
        }
      }
    }
  }
});

test('Needs Review bulk actions accept identity-only targets for Add and Skip', async () => {
  const addProject = createPendingBatchProject('pending-batch-identity-add');
  addProject.pendingFiles = [{
    name: 'Identity Add.png',
    ext: '.png',
    fileId: 'identity-only-add',
    captureState: 'pending',
  }, {
    name: 'Identity Add Unchanged.png',
    ext: '.png',
    fileId: 'identity-only-add-unchanged',
    captureState: 'pending',
  }];
  const addFixture = await loadPendingBatchFixture({
    project: addProject,
    allowedPaths: ['identity-only-add'],
  });

  assert.equal(addFixture.elements['btn-include-all-existing'].disabled, false);
  assert.equal(await addFixture.renderer.submitAssetReviewBatchDecision('include'), true);
  assert.deepEqual(addFixture.calls.map(call => call.target), [
    'identity-only-add',
    'identity-only-add-unchanged',
  ]);
  assert.deepEqual(addFixture.getPersisted().pendingFiles.map(file => file.fileId), ['identity-only-add-unchanged']);

  const skipProject = createPendingBatchProject('pending-batch-identity-skip');
  skipProject.pendingFiles = [{
    name: 'Identity Skip.png',
    ext: '.png',
    fileId: 'identity-only-skip',
    captureState: 'pending',
  }, {
    name: 'Identity Skip Unchanged.png',
    ext: '.png',
    fileId: 'identity-only-skip-unchanged',
    captureState: 'pending',
  }];
  const skipFixture = await loadPendingBatchFixture({
    project: skipProject,
    allowedPaths: ['identity-only-skip'],
  });

  assert.equal(skipFixture.elements['btn-skip-all-existing'].disabled, false);
  assert.equal(await skipFixture.renderer.submitAssetReviewBatchDecision('skip'), true);
  assert.deepEqual(skipFixture.calls.map(call => call.target), [
    'identity-only-skip',
    'identity-only-skip-unchanged',
  ]);
  assert.deepEqual(skipFixture.getPersisted().pendingFiles.map(file => file.fileId), ['identity-only-skip-unchanged']);
  assert.deepEqual(skipFixture.getPersisted().excludedAssetKeys, ['identity-only-skip']);
});

test('Needs Review bulk actions stay disabled when only Needs Save and Opened items remain', async () => {
  const project = createPendingBatchProject('pending-batch-no-review');
  project.pendingFiles[0].captureState = 'needs-save';
  project.pendingFiles[1].captureState = 'observed';
  project.pendingFiles = project.pendingFiles.slice(0, 2);
  const fixture = await loadPendingBatchFixture({ project });

  assert.equal(fixture.elements['btn-include-all-existing'].textContent, 'Add All');
  assert.equal(fixture.elements['btn-skip-all-existing'].textContent, 'Skip All');
  assert.equal(fixture.elements['btn-include-all-existing'].disabled, true);
  assert.equal(fixture.elements['btn-skip-all-existing'].disabled, true);
  assert.equal(await fixture.renderer.submitAssetReviewBatchDecision('include'), false);
  assert.equal(await fixture.renderer.submitAssetReviewBatchDecision('skip'), false);
  assert.equal(fixture.calls.length, 0);
  assert.deepEqual(fixture.getPersisted().pendingFiles.map(file => file.captureState), ['needs-save', 'observed']);
});

test('Needs Review bulk actions suppress rapid repeated activation and preserve current review state', async () => {
  const gate = createDeferred();
  let first = true;
  const fixture = await loadPendingBatchFixture({
    id: 'pending-batch-rapid',
    beforeAccept: async () => {
      if (first) {
        first = false;
        await gate.promise;
      }
    },
  });
  fixture.elements['asset-review-search'].value = 'Needs_';
  vm.runInContext("state.assetReviewFilter = 'missing'; state.assetReviewQuery = 'Needs_';", fixture.renderer);
  fixture.renderer.applyAssetReviewFilter();

  const firstRun = fixture.renderer.submitAssetReviewBatchDecision('include');
  const repeatedRun = fixture.renderer.submitAssetReviewBatchDecision('include');
  assert.equal(await repeatedRun, undefined);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.elements['btn-include-all-existing'].getAttribute('aria-busy'), 'true');

  gate.resolve();
  assert.equal(await firstRun, true);
  assert.equal(fixture.calls.length, 4);
  assert.equal(fixture.elements['asset-review-search'].value, 'Needs_');
  assert.equal(vm.runInContext('state.assetReviewFilter', fixture.renderer), 'missing');
  assert.equal(vm.runInContext('state.assetReviewQuery', fixture.renderer), 'Needs_');
  assert.equal(fixture.elements['asset-review-workspace'].classList.contains('hidden'), false);
});

test('Needs Review bulk controls remain disabled when no pending item has an individual target', async () => {
  const project = createPendingBatchProject('pending-batch-empty-eligible');
  project.pendingFiles = [{ name: 'No identity.png', ext: '.png' }];
  const fixture = await loadPendingBatchFixture({ project });

  assert.equal(fixture.elements['btn-include-all-existing'].disabled, true);
  assert.equal(fixture.elements['btn-skip-all-existing'].disabled, true);
  assert.equal(await fixture.renderer.submitAssetReviewBatchDecision('include'), false);
  assert.equal(fixture.calls.length, 0);
  assert.deepEqual(fixture.getPersisted().pendingFiles, [{ name: 'No identity.png', ext: '.png' }]);
});

test('Needs Review rows expose no individual Add or Skip controls', async () => {
  const fixture = await loadPendingBatchFixture({ id: 'pending-no-individual-actions' });
  for (const row of fixture.elements['pending-file-list'].children) {
    assert.equal(row.children.some(child => child.tagName === 'BUTTON'), false);
    assert.equal(row.children.some(child => child.className === 'pending-actions'), false);
  }
  assert.equal(fixture.elements['btn-include-all-existing'].textContent, 'Add All');
  assert.equal(fixture.elements['btn-skip-all-existing'].textContent, 'Skip All');
});

test('Needs Review batch recovery copy names list-level retry actions', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.doesNotMatch(source, /Try the individual actions/);
  assert.match(source, /Review the list and try the batch action again/);
});

test('Review Before Packaging uses the approved terminology and retains keyboard and accessibility semantics', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /<span>Needs Review<\/span>/);
  assert.match(html, /data-asset-filter="missing"[^>]*aria-pressed="false">Needs Review/);
  assert.match(html, /<p>Crate automatically includes files it can confidently connect to this project\. Review anything it could not verify\.<\/p>/);
  assert.match(html, /<h2 class="asset-panel-title" id="pending-header">Review Before Packaging<\/h2>/);
  assert.match(html, /<button type="button"[^>]*id="btn-include-all-existing"[^>]*>Add All<\/button>/);
  assert.match(html, /<button type="button"[^>]*id="btn-skip-all-existing"[^>]*>Skip All<\/button>/);
  assert.match(html, /id="btn-include-all-existing"[^>]*aria-label="Add all assets needing review"/);
  assert.match(html, /id="btn-skip-all-existing"[^>]*aria-label="Skip all assets needing review"/);

  const fixture = await loadPendingBatchFixture({ id: 'pending-accessibility' });
  assert.equal(fixture.elements['btn-include-all-existing'].getAttribute('aria-label'), 'Add all assets needing review');
  assert.equal(fixture.elements['btn-skip-all-existing'].getAttribute('aria-label'), 'Skip all assets needing review');
  assert.equal(fixture.elements['btn-include-all-existing'].getAttribute('aria-busy'), undefined);
  assert.equal(fixture.elements['btn-skip-all-existing'].getAttribute('aria-busy'), undefined);
  const pendingRow = fixture.elements['pending-file-list'].children[0];
  const pendingStateBadge = pendingRow.children.find(child => child.className === 'pending-state-badge');
  const pendingCopy = pendingRow.children.find(child => child.className === 'pending-file-copy');
  assert.equal(pendingStateBadge.textContent, 'Needs Review');
  assert.match(pendingCopy.children[1].textContent, /Needs review before packaging\./);

  const needsSaveProject = createPendingBatchProject('pending-accessibility-needs-save');
  needsSaveProject.pendingFiles = [{
    ...needsSaveProject.pendingFiles[0],
    captureState: 'needs-save',
  }];
  const needsSaveFixture = await loadPendingBatchFixture({ project: needsSaveProject });
  const needsSaveRow = needsSaveFixture.elements['pending-file-list'].children[0];
  assert.equal(
    needsSaveRow.children.find(child => child.className === 'pending-state-badge').textContent,
    'Needs Save',
  );
  assert.match(
    needsSaveRow.children.find(child => child.className === 'pending-file-copy').children[1].textContent,
    /Save to make package-ready\./,
  );
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

test('excluded Added While Working assets remain visible and restore without a file picker', async () => {
  const { document, elements, assetFilters } = createInteractiveRendererDom();
  const source = {
    name: 'Workspace.ai', ext: '.ai', assetOrigin: 'added', projectRole: 'source',
    protectedSource: true, visualIdentity: 'added-source-identity', visualRevision: 'added-source-revision',
  };
  const added = {
    name: 'Added.png', ext: '.png', assetOrigin: 'added', projectRole: 'asset',
    protectedSource: false, excluded: true, appFamily: 'illustrator', sourceName: 'Workspace.ai',
    visualIdentity: 'added-asset-identity', visualRevision: 'added-asset-revision',
  };
  const project = {
    id: 'added-x-restoration', name: 'Added X restoration', type: 'branding', status: 'watching',
    files: [source, added], pendingFiles: [], excludedAssetKeys: ['added-key'],
    assetBaseline: { status: 'included', decision: 'include' },
  };
  const restoredProject = {
    ...project,
    files: [source, { ...added, excluded: false }],
    excludedAssetKeys: [],
  };
  const toggles = [];
  const renderer = loadRendererHelpers(document, { crate: {
    removeFile: async (...args) => { toggles.push(args); },
    getProjects: async () => [restoredProject],
    getAssetWorkspace: async () => ({ projectId: project.id, files: restoredProject.files, pendingFiles: [] }),
  } });
  renderer.testProject = project;
  vm.runInContext('state.projects = [testProject]; state.selectedProjectId = testProject.id;', renderer);
  renderer.renderAssetWorkspace(project, {}, project.files);

  assert.equal(elements['filter-count-excluded'].textContent, '1');
  assert.equal(elements['added-assets-list'].children.length, 1);
  const excludedRow = elements['added-assets-list'].children[0];
  assert.equal(excludedRow.className.includes('is-excluded'), true);
  const restoreButton = excludedRow.children.find(child => child.className === 'app-file-remove');
  assert.equal(restoreButton.textContent, '\u00D7');
  assert.equal(restoreButton.getAttribute('aria-label'), 'Include Added.png in this project');

  vm.runInContext("state.assetReviewFilter = 'excluded';", renderer);
  renderer.applyAssetReviewFilter();
  assert.equal(assetFilters.find(button => button.dataset.assetFilter === 'excluded').getAttribute('aria-pressed'), 'true');
  restoreButton.click();
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(toggles, [[project.id, added.visualIdentity]]);
  assert.equal(elements['filter-count-excluded'].textContent, '0');
  assert.equal(elements['added-assets-list'].children.length, 0);
});

test('failed first-scan sources expose accessible recovery while healthy sources remain protected', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const failedSource = {
    name: 'Failed Source.ai', ext: '.ai', assetOrigin: null, projectRole: 'source',
    protectedSource: true, sourceRecoveryAllowed: true,
    visualIdentity: 'failed-source-identity', visualRevision: 'failed-source-revision',
  };
  const project = {
    id: 'failed-source-recovery',
    name: 'Failed source recovery',
    type: 'branding',
    status: 'watching',
    files: [failedSource],
    pendingFiles: [],
    excludedAssetKeys: [],
    assetBaseline: { status: 'awaiting-first-scan', decision: null, establishedAt: null },
  };
  const recoveredProject = {
    ...project,
    files: [],
    assetBaseline: { status: 'empty', decision: null, establishedAt: 2 },
  };
  const removals = [];
  const renderer = loadRendererHelpers(document, { crate: {
    removeFile: async (...args) => { removals.push(args); },
    getProjects: async () => [recoveredProject],
    getAssetWorkspace: async () => ({ projectId: project.id, files: [], pendingFiles: [] }),
  } });
  renderer.testProject = project;
  vm.runInContext('state.projects = [testProject]; state.selectedProjectId = testProject.id;', renderer);
  renderer.renderAssetWorkspace(project, {}, project.files);

  const failedRow = elements['project-file-list'].children[0];
  const recoveryButton = failedRow.children.find(child => child.className === 'app-file-recovery');
  assert.equal(getElementTreeText(failedRow).includes('Scan failed'), true);
  assert.equal(recoveryButton.textContent, 'Remove');
  assert.equal(
    recoveryButton.getAttribute('aria-label'),
    'Remove Failed Source.ai and recover this project from the failed first scan'
  );
  recoveryButton.click();
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(removals, [[project.id, failedSource.visualIdentity]]);
  assert.equal(elements['project-file-list'].children[0].className, 'asset-panel-empty');

  const healthySource = {
    ...failedSource,
    name: 'Healthy Source.ai',
    sourceRecoveryAllowed: false,
    visualIdentity: 'healthy-source-identity',
    visualRevision: 'healthy-source-revision',
  };
  const healthyProject = {
    ...project,
    id: 'healthy-source-protection',
    files: [healthySource],
    assetBaseline: { status: 'empty', decision: null, establishedAt: 3 },
  };
  renderer.renderAssetWorkspace(healthyProject, {}, healthyProject.files);
  const healthyRow = elements['project-file-list'].children[0];
  assert.equal(getElementTreeText(healthyRow).includes('Ready'), true);
  assert.equal(healthyRow.children.some(child => child.tagName === 'BUTTON'), false);
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

  const visuals = project.files.map(file => renderer.createFileVisual(project.id, file));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(visuals[0].classList.contains('is-thumbnail'), true);
  assert.equal(visuals[0].dataset.fileIdentity, undefined);
  assert.equal(visuals[1].classList.contains('is-icon'), true);
  assert.equal(visuals[2].children[0].textContent, 'XYZ');
});

function assertNormalWorkingFileFlow(list, count) {
  assert.equal(list.__assetReviewVirtualState, undefined);
  assert.equal(list.classList.contains('asset-virtual-list'), false);
  assert.equal(list.listeners.scroll?.length || 0, 0);
  assert.equal(list.style.height || '', '');
  assert.equal(list.style.position || '', '');
  assert.equal(list.style['--asset-review-logical-height'], undefined);
  assert.equal(list.children.length, Math.max(1, count));
  for (const row of list.children) {
    for (const property of ['position', 'top', 'left', 'right', 'minHeight']) {
      assert.equal(row.style[property] || '', '', `normal flow must not retain ${property}`);
    }
    assert.equal(row.dataset.assetIndex, undefined);
    assert.equal(row.getAttribute('aria-posinset'), undefined);
    assert.equal(row.getAttribute('aria-setsize'), undefined);
  }
}

test('dashboard Working Files preserves normal flow and source controls for empty, single, and multiple sources', async () => {
  const { document, elements } = createInteractiveRendererDom();
  let current;
  let previewRequests = 0;
  const renderer = loadRendererHelpers(document, { crate: {
    getAssetWorkspace: async () => current.workspace,
    getFileVisual: async () => { previewRequests += 1; return { kind: 'fallback' }; },
  } });
  for (const count of [0, 1, 4, 0, 4]) {
    const files = Array.from({ length: count }, (_, index) => ({
      name: `Working_${index}.ai`, ext: '.ai', appFamily: 'illustrator',
      projectRole: 'source', protectedSource: true, sourceRecoveryAllowed: index === 3,
      visualIdentity: `working-${index}`, visualRevision: `working-revision-${index}`,
    }));
    current = {
      project: { id: 'working-flow', files, pendingFiles: [], excludedAssetKeys: [] },
      workspace: { projectId: 'working-flow', files, pendingFiles: [] },
    };
    renderer.testProject = current.project;
    vm.runInContext('state.projects = [testProject]; state.selectedProjectId = testProject.id;', renderer);
    await renderer.renderFiles();
    const list = elements['project-file-list'];
    assertNormalWorkingFileFlow(list, count);
    assert.equal(elements['project-file-count'].textContent, String(count));
    if (count === 0) {
      assert.equal(list.children[0].textContent, 'Add a project file to begin.');
    } else {
      assert.match(getElementTreeText(list.children[0]), /Ready/);
      assert.equal(list.children[0].children.some(child => child.tagName === 'BUTTON'), false);
      if (count === 4) {
        const recovery = list.children[3].children.find(child => child.tagName === 'BUTTON');
        assert.equal(recovery.className, 'app-file-recovery');
        assert.match(recovery.getAttribute('aria-label'), /Remove Working_3.ai and recover/);
      }
      list.scrollTop = 91;
      const row = list.children[0];
      await renderer.renderFiles();
      assert.equal(list.children[0], row);
      assert.equal(list.scrollTop, 91, 'same-project refresh preserves dashboard scrolling');
    }
  }
  assert.equal(previewRequests, 0);
});

test('dashboard and Review Assets switching keeps layout modes and project-owned state separate', async () => {
  const first = createUiSmoothnessFixture({ assetCount: 500 });
  const second = cloneTestValue(first);
  second.project.id = 'working-flow-project-b';
  second.workspace.projectId = second.project.id;
  let current = first;
  const { document, elements } = createInteractiveRendererDom();
  const renderer = loadRendererHelpers(document, { crate: { getAssetWorkspace: async () => current.workspace } });
  renderer.testProjects = [first.project, second.project];
  vm.runInContext('state.projects = testProjects; state.selectedProjectId = testProjects[0].id;', renderer);
  await renderer.renderFiles();
  const working = elements['project-file-list'];
  const added = elements['added-assets-list'];
  const workingRow = working.children[0];
  working.scrollTop = 25;
  renderer.openAssetReviewWorkspace();
  added.clientHeight = 460;
  added.scrollTop = 240 * 58;
  added.dispatchEvent({ type: 'scroll' });
  const selected = added.children[0];
  selected.click();
  renderer.closeAssetReviewWorkspace();
  await renderer.renderFiles();
  assertNormalWorkingFileFlow(working, first.expected.representedSourceFiles);
  assert.equal(working.children[0], workingRow);
  assert.equal(working.scrollTop, 25);
  renderer.openAssetReviewWorkspace();
  assert.equal(added.children[0], selected);
  assert.equal(selected.getAttribute('aria-selected'), 'true');
  assert.ok(added.children.length > 0 && added.children.length <= 36);
  assert.equal(added.listeners.scroll.length, 1);
  assert.equal(selected.style.top, `${Number(selected.dataset.assetIndex) * 58}px`);
  current = second;
  vm.runInContext('state.selectedProjectId = testProjects[1].id;', renderer);
  await renderer.renderFiles();
  renderer.closeAssetReviewWorkspace();
  assertNormalWorkingFileFlow(working, second.expected.representedSourceFiles);
  assert.notEqual(working.children[0], workingRow);
  assert.equal(working.scrollTop, 0);
  assert.equal(vm.runInContext('state.assetReviewSelectedKey', renderer), null);
  assert.equal(added.listeners.scroll.length, 1);
  assert.ok(added.children.every(row => row.getAttribute('aria-selected') === 'false'));
});

test('shared panel renderer drops prior virtual rows when returning a list to normal flow', () => {
  const { document, elements } = createInteractiveRendererDom();
  const renderer = loadRendererHelpers(document);
  const file = { name: 'Working.ai', projectRole: 'source', protectedSource: true, visualIdentity: 'working' };
  const project = { id: 'mode-transition', files: [file] };
  const list = document.querySelector('#project-file-list');
  renderer.renderAssetPanelList(list, project, [file], { virtualized: true, loadVisual: false });
  const virtualRow = list.children[0];
  assert.equal(virtualRow.style.position, 'absolute');
  renderer.renderAssetPanelList(list, project, [file], { loadVisual: false });
  assertNormalWorkingFileFlow(list, 1);
  assert.notEqual(list.children[0], virtualRow, 'rebuild rows to discard virtual position and ARIA');
  list.dispatchEvent({ type: 'scroll' });
  assertNormalWorkingFileFlow(list, 1);
});

test('Review Assets virtualizes 30, 263, and 500 asset datasets without default preview requests', async () => {
  for (const assetCount of [30, 263, 500]) {
    const fixture = createUiSmoothnessFixture({ assetCount });
    let visualCalls = 0;
    const { document, elements } = createInteractiveRendererDom();
    const renderer = loadRendererHelpers(document, {
      crate: {
        getProjects: async () => [fixture.project],
        getAssetWorkspace: async () => fixture.workspace,
        getFileVisual: async () => {
          visualCalls += 1;
          return { kind: 'fallback' };
        },
      },
    });
    renderer.testProject = fixture.project;
    vm.runInContext(`
      state.projects = [testProject];
      state.selectedProjectId = testProject.id;
      state.assetReviewOpen = true;
    `, renderer);
    elements['tab-projects'].classList.remove('active');
    elements['tab-current-project'].classList.add('active');

    await renderer.renderFiles();

    assert.equal(visualCalls, 0);
    assert.ok(elements['existing-assets-list'].children.length <= 36);
    assert.ok(elements['added-assets-list'].children.length <= 36);
    assert.equal(vm.runInContext('state.assetReviewLogicalItems.existing.length', renderer), Math.min(7, assetCount));
    assert.equal(vm.runInContext('state.assetReviewLogicalItems.added.length', renderer), Math.max(0, assetCount - 7));

    elements['added-assets-list'].scrollTop = 10000;
    elements['added-assets-list'].dispatchEvent({ type: 'scroll' });
    assert.ok(elements['added-assets-list'].children.length <= 36);

    vm.runInContext("state.assetReviewFilter = 'added'; state.assetReviewQuery = 'synthetic_smoothness_asset_0250';", renderer);
    renderer.applyAssetReviewFilter();
    assert.equal(elements['added-assets-list'].children.length, assetCount >= 250 ? 1 : 0);
    if (assetCount >= 250) {
      assert.match(getElementTreeText(elements['added-assets-list'].children[0]), /0250/);
      assert.equal(elements['added-assets-list'].children[0].getAttribute('aria-setsize'), '1');
    }
  }
});

test('Review Assets preserves filter, selection, focus, and stable row identity across refresh', async () => {
  const fixture = createUiSmoothnessFixture({ assetCount: 30 });
  const { document, elements } = createInteractiveRendererDom();
  const updatedFixture = createUiSmoothnessFixture({ assetCount: 30 });
  updatedFixture.project.files[4].name = 'Synthetic_Smoothness_Asset_0004_Updated.png';
  updatedFixture.workspace.files[4].name = updatedFixture.project.files[4].name;
  let workspace = fixture.workspace;
  const renderer = loadRendererHelpers(document, {
    crate: {
      getProjects: async () => [workspace === fixture.workspace ? fixture.project : updatedFixture.project],
      getAssetWorkspace: async () => workspace,
    },
  });
  renderer.testProject = fixture.project;
  vm.runInContext(`
    state.projects = [testProject];
    state.selectedProjectId = testProject.id;
    state.assetReviewOpen = true;
    state.assetReviewFilter = 'added';
    state.assetReviewQuery = 'synthetic_smoothness_asset';
  `, renderer);
  elements['tab-projects'].classList.remove('active');
  elements['tab-current-project'].classList.add('active');
  await renderer.renderFiles();

  const selectedRow = elements['added-assets-list'].children[0];
  const selectedKey = selectedRow.dataset.renderKey;
  selectedRow.click();
  elements['asset-review-search'].focus();
  elements['app-content'].scrollTop = 317;
  workspace = updatedFixture.workspace;
  vm.runInContext('state.projects = [testProject];', renderer);
  await renderer.renderFiles();

  assert.equal(vm.runInContext('state.assetReviewFilter', renderer), 'added');
  assert.equal(vm.runInContext('state.assetReviewQuery', renderer), 'synthetic_smoothness_asset');
  assert.equal(vm.runInContext('state.assetReviewSelectedKey', renderer), selectedKey);
  assert.equal(elements['app-content'].scrollTop, 317);
  assert.equal(document.activeElement, elements['asset-review-search']);
  assert.equal(elements['added-assets-list'].children[0].dataset.renderKey, selectedKey);
  assert.equal(elements['added-assets-list'].children[0].getAttribute('aria-selected'), 'true');
});

function loadSmoothnessCompletionCheck(renderer) {
  const source = fs.readFileSync(path.join(__dirname, 'ui-smoothness-electron-baseline.js'), 'utf8');
  const start = source.indexOf('function isAssetWorkspaceReady(');
  const end = source.indexOf('\nasync function settleLayout(', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), renderer);
  return renderer.isAssetWorkspaceReady;
}

test('smoothness completion accepts actual empty and mixed production lists and rejects incomplete renders', async () => {
  for (const [assetCount, addedOnly] of [[0, false], [7, false], [7, true], [30, false]]) {
    const fixture = createUiSmoothnessFixture({ assetCount });
    if (addedOnly) {
      fixture.workspace.files.forEach(file => { if (file.projectRole === 'asset') file.assetOrigin = 'added'; });
      fixture.expected.existingAssets = 0;
      fixture.expected.addedAssets = assetCount;
    }
    const { document, elements } = createInteractiveRendererDom();
    const renderer = loadRendererHelpers(document, { crate: { getAssetWorkspace: async () => fixture.workspace } });
    renderer.testProject = fixture.project;
    vm.runInContext('state.projects = [testProject]; state.selectedProjectId = testProject.id;', renderer);
    const ready = loadSmoothnessCompletionCheck(renderer);
    assert.equal(ready(fixture.expected), false, 'unrendered lists must not pass even for zero assets');
    await renderer.renderFiles();
    assert.equal(ready(fixture.expected), true);
    const sourceList = elements['project-file-list'];
    const sourceRow = sourceList.children[0];
    sourceList.removeChild(sourceRow);
    assert.equal(ready(fixture.expected), false, 'missing working files must not pass');
    sourceList.insertBefore(sourceRow, sourceList.children[0]);
    sourceRow.style.position = 'absolute';
    assert.equal(ready(fixture.expected), false, 'virtual positioning in Working Files must not pass');
    sourceRow.style.position = '';
    assert.equal(ready(fixture.expected), true);
    if (assetCount > 0) {
      const populated = elements[addedOnly ? 'added-assets-list' : 'existing-assets-list'];
      const height = populated.style.height;
      populated.style.height = '';
      assert.equal(ready(fixture.expected), false, 'missing Review Assets geometry must not pass');
      populated.style.height = height;
      const row = populated.children[0];
      const size = row.getAttribute('aria-setsize');
      row.setAttribute('aria-setsize', '999');
      assert.equal(ready(fixture.expected), false, 'stale virtual positional semantics must not pass');
      row.setAttribute('aria-setsize', size);
    }
    if (assetCount === 7) {
      const emptyList = elements[addedOnly ? 'existing-assets-list' : 'added-assets-list'];
      const placeholder = emptyList.children[0];
      emptyList.removeChild(placeholder);
      assert.equal(ready(fixture.expected), false, 'missing empty state must not pass');
      emptyList.appendChild(placeholder);
      assert.equal(ready(fixture.expected), true);
    }
    const row = sourceList.children[0];
    row.setAttribute('aria-setsize', '999');
    assert.equal(ready(fixture.expected), false, 'Working Files must not retain virtual positional semantics');
  }
});

test('already mounted deep rows are repositioned through search and final rows remain reachable at 30/263/500', async () => {
  for (const assetCount of [30, 263, 500]) {
    const fixture = createUiSmoothnessFixture({ assetCount });
    const { document, elements } = createInteractiveRendererDom();
    let previewRequests = 0;
    const renderer = loadRendererHelpers(document, { crate: {
      getAssetWorkspace: async () => fixture.workspace,
      getFileVisual: async () => { previewRequests += 1; return { kind: 'fallback' }; },
    } });
    renderer.testProject = fixture.project;
    vm.runInContext('state.projects = [testProject]; state.selectedProjectId = testProject.id; state.assetReviewOpen = true;', renderer);
    await renderer.renderFiles();
    const list = elements['added-assets-list'];
    list.clientHeight = 460;
    const targetIndex = assetCount === 30 ? 18 : 242;
    list.scrollTop = targetIndex * 58;
    list.dispatchEvent({ type: 'scroll' });
    const target = list.children.find(row => row.dataset.assetIndex === String(targetIndex));
    assert.ok(target, 'search target must already be mounted deep in the list');
    const key = target.dataset.renderKey;
    const file = list.__assetReviewAllItems[targetIndex];
    assert.equal(target.style.top, `${targetIndex * 58}px`);
    target.click();
    renderer.searchName = file.name;
    vm.runInContext('state.assetReviewQuery = searchName;', renderer);
    renderer.applyAssetReviewFilter();
    assert.equal(list.children.length, 1);
    assert.equal(list.children[0], target, 'exercise the reused-row path');
    assert.equal(target.style.top, '0px');
    assert.equal(target.dataset.assetIndex, '0');
    assert.equal(target.getAttribute('aria-posinset'), '1');
    assert.equal(target.getAttribute('aria-setsize'), '1');
    assert.equal(target.getAttribute('aria-selected'), 'true');
    assert.equal(list.scrollTop, 0);

    vm.runInContext("state.assetReviewQuery = '';", renderer);
    renderer.applyAssetReviewFilter();
    list.scrollTop = targetIndex * 58;
    list.dispatchEvent({ type: 'scroll' });
    const restored = list.children.find(row => row.dataset.renderKey === key);
    assert.ok(restored);
    assert.equal(restored.style.top, `${targetIndex * 58}px`);
    assert.equal(restored.dataset.assetIndex, String(targetIndex));
    assert.equal(restored.getAttribute('aria-posinset'), String(targetIndex + 1));
    assert.equal(restored.getAttribute('aria-setsize'), String(assetCount - 7));
    assert.equal(restored.getAttribute('aria-selected'), 'true');
    list.scrollTop = Number.MAX_SAFE_INTEGER;
    list.dispatchEvent({ type: 'scroll' });
    const last = list.children.at(-1);
    assert.equal(last.dataset.assetIndex, String(assetCount - 8));
    assert.equal(last.getAttribute('aria-posinset'), String(assetCount - 7));
    assert.ok(Number.parseInt(last.style.top, 10) < list.scrollTop + list.clientHeight);
    assert.ok(list.children.length > 0 && list.children.length <= 36);
    assert.equal(previewRequests, 0);
  }
});

test('project switches clear selection and row action ownership even for shared visual identities', async () => {
  const first = createUiSmoothnessFixture({ assetCount: 30 });
  const second = cloneTestValue(first);
  second.project.id = 'synthetic-shared-identity-project-b';
  second.workspace.projectId = second.project.id;
  let current = first;
  const { document, elements } = createInteractiveRendererDom();
  const removals = [];
  const renderer = loadRendererHelpers(document, { crate: {
    getAssetWorkspace: async () => current.workspace,
    getProjects: async () => [first.project, second.project],
    removeFile: async (...args) => { removals.push(args); },
  } });
  renderer.testProjects = [first.project, second.project];
  vm.runInContext('state.projects = testProjects; state.selectedProjectId = testProjects[0].id;', renderer);
  await renderer.renderFiles();
  const list = elements['added-assets-list'];
  const oldRow = list.children[0];
  oldRow.click();
  assert.equal(oldRow.getAttribute('aria-selected'), 'true');
  await renderer.renderFiles();
  assert.equal(list.children[0], oldRow, 'same project retains its row');
  assert.equal(oldRow.getAttribute('aria-selected'), 'true');
  current = second;
  vm.runInContext('state.selectedProjectId = testProjects[1].id;', renderer);
  await renderer.renderFiles();
  assert.equal(vm.runInContext('state.assetReviewSelectedKey', renderer), null);
  assert.notEqual(list.children[0], oldRow);
  assert.equal(list.children[0].getAttribute('aria-selected'), 'false');
  list.children[0].children.find(child => child.tagName === 'BUTTON').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(removals.length, 1);
  assert.equal(removals[0][0], second.project.id);
});

test('Added list tears down populated state, preserves its empty message through filters, and repopulates once', async () => {
  const populated = createUiSmoothnessFixture({ assetCount: 30 });
  const empty = cloneTestValue(populated);
  empty.workspace.files = empty.workspace.files.filter(file => file.projectRole === 'source' || file.assetOrigin === 'existing');
  let current = populated;
  const { document, elements } = createInteractiveRendererDom();
  const renderer = loadRendererHelpers(document, { crate: { getAssetWorkspace: async () => current.workspace } });
  renderer.testProject = populated.project;
  vm.runInContext('state.projects = [testProject]; state.selectedProjectId = testProject.id;', renderer);
  await renderer.renderFiles();
  const list = elements['added-assets-list'];
  assert.equal(list.listeners.scroll.length, 1);
  current = empty;
  await renderer.renderFiles();
  const placeholder = list.children[0];
  assert.equal(placeholder.className, 'asset-panel-empty');
  assert.equal(placeholder.textContent, 'New package-ready assets will appear here as you work.');
  assert.equal(list.__assetReviewVirtualState, undefined);
  assert.equal(list.style.height, '');
  assert.equal(list.style['--asset-review-logical-height'], undefined);
  assert.equal(list.classList.contains('asset-virtual-list'), false);
  assert.equal(list.listeners.scroll.length, 0);
  vm.runInContext("state.assetReviewQuery = 'missing'; state.assetReviewFilter = 'added';", renderer);
  renderer.applyAssetReviewFilter();
  list.dispatchEvent({ type: 'scroll' });
  assert.deepEqual(list.children, [placeholder]);
  assert.equal(placeholder.classList.contains('filtered-out'), false);
  vm.runInContext("state.assetReviewQuery = ''; state.assetReviewFilter = 'all';", renderer);
  current = populated;
  await renderer.renderFiles();
  assert.equal(list.listeners.scroll.length, 1);
  assert.equal(list.style.height, `${23 * 58}px`);
  assert.ok(list.children.every(row => row.className !== 'asset-panel-empty'));
});

test('anonymous duplicate records retain object binding across windows and filters without guessing replacement identity', () => {
  const { document, elements } = createInteractiveRendererDom();
  const renderer = loadRendererHelpers(document);
  const files = Array.from({ length: 80 }, (_, index) => ({
    name: 'Duplicate.png', ext: '.png', projectRole: 'asset', assetOrigin: 'added',
    sourceName: `Source_${String(index).padStart(3, '0')}.ai`,
  }));
  const project = { id: 'anonymous-records', files, pendingFiles: [], excludedAssetKeys: [] };
  renderer.renderAssetWorkspace(project, {}, files);
  const list = elements['added-assets-list'];
  list.clientHeight = 348;
  const original = list.children[8];
  const originalKey = original.dataset.renderKey;
  const keys = files.map(file => renderer.getRendererItemKey(file));
  assert.equal(new Set(keys).size, files.length);
  assert.ok(keys.every(key => !key.includes('Duplicate') && !key.includes('Source_')));
  list.scrollTop = 12 * 58;
  list.dispatchEvent({ type: 'scroll' });
  assert.equal(list.children.find(row => row.dataset.renderKey === originalKey), original);
  original.click();
  vm.runInContext("state.assetReviewQuery = 'Source_008';", renderer);
  renderer.applyAssetReviewFilter();
  assert.equal(list.children[0], original);
  assert.equal(original.style.top, '0px');
  assert.equal(original.getAttribute('aria-selected'), 'true');
  vm.runInContext("state.assetReviewQuery = '';", renderer);
  renderer.applyAssetReviewFilter();
  for (let offset = 0; offset < files.length; offset += 6) {
    list.scrollTop = offset * 58;
    list.dispatchEvent({ type: 'scroll' });
    assert.ok(list.children.length > 0 && list.children.length <= 36);
    for (const row of list.children) assert.equal(row.dataset.renderKey, keys[Number(row.dataset.assetIndex)]);
  }
  const replacement = files.map(file => ({ ...file }));
  renderer.renderAssetWorkspace(project, {}, replacement);
  assert.ok(list.children.every(row => !keys.includes(row.dataset.renderKey)));
  assert.ok(list.children.every(row => row.getAttribute('aria-selected') === 'false'));
  renderer.renderAssetWorkspace({ ...project, id: 'anonymous-project-b' }, {}, files);
  assert.equal(vm.runInContext('state.assetReviewSelectedKey', renderer), null);
  assert.ok(list.children.every(row => row.getAttribute('aria-selected') === 'false'));
});

test('Needs Review filters reuse the composed anonymous records and keep positional selection consistent', async () => {
  const fixture = createUiSmoothnessFixture({ assetCount: 7 });
  fixture.project.pendingFiles = Array.from({ length: 50 }, (_, index) => ({
    name: 'Duplicate pending.png', ext: '.png', captureState: 'pending',
    captureEvidence: { appFamily: 'illustrator' },
    path: `/synthetic/pending-${index}.png`,
  }));
  fixture.workspace.pendingFiles = fixture.project.pendingFiles.map((file, sourceIndex) => ({
    name: file.name, ext: file.ext, sourceIndex, sourceName: `Pending_${sourceIndex}.ai`,
  }));
  const { document, elements } = createInteractiveRendererDom();
  const renderer = loadRendererHelpers(document, { crate: { getAssetWorkspace: async () => fixture.workspace } });
  renderer.testProject = fixture.project;
  vm.runInContext('state.projects = [testProject]; state.selectedProjectId = testProject.id;', renderer);
  await renderer.renderFiles();
  const list = elements['pending-file-list'];
  assert.equal(vm.runInContext('state.assetReviewLogicalItems.missing', renderer), list.__assetReviewAllItems);
  list.scrollTop = 40 * 58;
  list.dispatchEvent({ type: 'scroll' });
  const row = list.children.find(item => item.dataset.assetIndex === '40');
  assert.ok(row);
  row.click();
  vm.runInContext("state.assetReviewFilter = 'missing'; state.assetReviewQuery = 'Pending_40.ai';", renderer);
  renderer.applyAssetReviewFilter();
  assert.deepEqual(list.children, [row]);
  assert.equal(row.style.top, '0px');
  assert.equal(row.getAttribute('aria-posinset'), '1');
  assert.equal(row.getAttribute('aria-setsize'), '1');
  assert.equal(row.getAttribute('aria-selected'), 'true');
  assert.match(getElementTreeText(row), /Duplicate pending/);
});

test('native file icons and image thumbnails stay sharp without cropped previews', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

  assert.match(css, /\.file-visual\.is-thumbnail\s+\.file-visual-image\s*\{(?=[^}]*box-sizing:\s*border-box;)(?=[^}]*object-fit:\s*contain;)(?=[^}]*padding:\s*6px;)[^}]*\}/);
  assert.match(css, /\.file-visual\.is-icon\s+\.file-visual-image\s*\{(?=[^}]*width:\s*min\(32px, 68%\);)(?=[^}]*height:\s*min\(32px, 68%\);)(?=[^}]*object-fit:\s*contain;)[^}]*\}/);
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
  for (let index = 0; index < 97; index += 1) {
    await evictionRenderer.requestFileVisual('eviction-project', `identity-${index}`, `revision-${index}`);
  }
  const beforeRevisit = vm.runInContext('fileVisualCache.size', evictionRenderer);
  assert.equal(beforeRevisit, 96);
  assert.equal(evictionCalls, 97);
  await evictionRenderer.requestFileVisual('eviction-project', 'identity-0', 'revision-0');
  assert.equal(evictionCalls, 98);
  assert.equal(vm.runInContext('fileVisualCache.size', evictionRenderer), 96);
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
  assert.equal(vm.runInContext('fileVisualDeferred.size', renderer), 8);
  assert.equal(vm.runInContext('fileVisualInFlight.size', renderer), 140);

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

test('file visual demand stays bounded while every required visible preview eventually loads', async () => {
  const pngData = `data:image/png;base64,${Buffer.from('visible').toString('base64')}`;
  const pending = [];
  const calls = [];
  let active = 0;
  let maxActive = 0;
  let maxQueue = 0;
  const renderer = loadRendererHelpers(createDocumentStub(), { crate: {
    getFileVisual: (projectId, identity) => {
      calls.push([projectId, identity]);
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise(resolve => pending.push({ identity, resolve }));
    },
  } });
  renderer.setActiveFileVisualProject('stress-project');

  const requests = [];
  for (let index = 0; index < 500; index += 1) {
    requests.push(renderer.requestFileVisual(
      'stress-project',
      `asset-${index}`,
      `revision-${index}`,
      10
    ));
  }
  const observeBounds = () => {
    maxQueue = Math.max(maxQueue, vm.runInContext('fileVisualQueue.length', renderer));
    assert.ok(vm.runInContext('fileVisualQueue.length', renderer) <= 128);
    assert.ok(vm.runInContext('fileVisualActiveRequests', renderer) <= 4);
    assert.ok(vm.runInContext('fileVisualInFlight.size', renderer) <= 501);
  };
  await new Promise(resolve => setImmediate(resolve));
  observeBounds();
  assert.equal(calls.length, 4);
  assert.equal(vm.runInContext('fileVisualQueue.length', renderer), 128);
  assert.equal(vm.runInContext('fileVisualDeferred.size', renderer), 368);
  assert.equal(vm.runInContext('fileVisualInFlight.size', renderer), 500);

  const duplicateRequests = [
    renderer.requestFileVisual('stress-project', 'asset-499', 'revision-499', 10),
    renderer.requestFileVisual('stress-project', 'asset-499', 'revision-499', 0),
  ];
  const visibleRequest = renderer.requestFileVisual(
    'stress-project',
    'visible-required',
    'visible-required-revision',
    0
  );
  await new Promise(resolve => setImmediate(resolve));
  observeBounds();
  assert.equal(vm.runInContext('fileVisualQueue.length', renderer), 128);
  assert.equal(vm.runInContext('fileVisualDeferred.size', renderer), 369);
  assert.equal(vm.runInContext('fileVisualInFlight.size', renderer), 501);
  assert.equal(duplicateRequests[0], duplicateRequests[1]);

  const first = pending.shift();
  active -= 1;
  first.resolve({ kind: 'fallback' });
  await new Promise(resolve => setImmediate(resolve));
  observeBounds();
  assert.deepEqual(calls[4], ['stress-project', 'visible-required']);

  while (calls.length < 501 || pending.length > 0) {
    const batch = pending.splice(0);
    batch.forEach(({ identity, resolve }) => {
      active -= 1;
      resolve(identity === 'visible-required' ? { kind: 'thumbnail', dataUrl: pngData } : { kind: 'fallback' });
    });
    await new Promise(resolve => setImmediate(resolve));
    observeBounds();
  }

  const results = await Promise.all([...requests, ...duplicateRequests, visibleRequest]);
  assert.equal(results.at(-1).kind, 'thumbnail');
  assert.equal(calls.length, 501);
  assert.equal(maxActive, 4);
  assert.ok(maxQueue <= 128);
  assert.equal(vm.runInContext('fileVisualQueue.length', renderer), 0);
  assert.equal(vm.runInContext('fileVisualDeferred.size', renderer), 0);
  assert.equal(vm.runInContext('fileVisualInFlight.size', renderer), 0);
});

test('stale file visual results are rejected after project invalidation', async () => {
  const pngData = `data:image/png;base64,${Buffer.from('stale').toString('base64')}`;
  const stale = createDeferred();
  let calls = 0;
  const renderer = loadRendererHelpers(createDocumentStub(), { crate: {
    getFileVisual: () => {
      calls += 1;
      return calls === 1 ? stale.promise : { kind: 'thumbnail', dataUrl: pngData };
    },
  } });
  const file = {
    name: 'Stale.png',
    ext: '.png',
    visualIdentity: 'stale-identity',
    visualRevision: 'stale-revision',
  };
  const staleContainer = renderer.createFileVisual('stale-project', file);
  await new Promise(resolve => setImmediate(resolve));
  renderer.invalidateFileVisualProject('stale-project');
  stale.resolve({ kind: 'thumbnail', dataUrl: pngData });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(staleContainer.classList.contains('is-thumbnail'), false);
  assert.equal(staleContainer.children.length, 1);

  const freshContainer = renderer.createFileVisual('stale-project', {
    ...file,
    visualRevision: 'fresh-revision',
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(freshContainer.classList.contains('is-thumbnail'), true);
  assert.equal(calls, 2);
});

test('Added Assets empty-state copy updates in both directions without replacing unrelated rows', () => {
  const { document, elements } = createInteractiveRendererDom();
  const existing = {
    name: 'Existing.png',
    ext: '.png',
    assetOrigin: 'existing',
    projectRole: 'asset',
    visualIdentity: 'existing-stable',
    visualRevision: 'existing-revision',
  };
  const project = {
    id: 'empty-state-variants',
    name: 'Empty State Variants',
    files: [existing],
    pendingFiles: [],
    excludedAssetKeys: [],
  };
  const renderer = loadRendererHelpers(document, { crate: {} });

  renderer.renderAssetWorkspace(project, { hasActiveCandidates: false }, project.files);
  const firstEmpty = elements['added-assets-list'].children[0];
  const existingRow = elements['existing-assets-list'].children[0];
  assert.equal(getElementTreeText(firstEmpty), 'New package-ready assets will appear here as you work.');

  renderer.renderAssetWorkspace(project, { hasActiveCandidates: true }, project.files);
  const activeEmpty = elements['added-assets-list'].children[0];
  assert.notEqual(activeEmpty, firstEmpty);
  assert.equal(getElementTreeText(activeEmpty), 'No package-ready assets yet. Review the files Crate observed.');
  assert.equal(elements['existing-assets-list'].children[0], existingRow);

  renderer.renderAssetWorkspace(project, { hasActiveCandidates: false }, project.files);
  const restoredEmpty = elements['added-assets-list'].children[0];
  assert.notEqual(restoredEmpty, activeEmpty);
  assert.equal(getElementTreeText(restoredEmpty), 'New package-ready assets will appear here as you work.');
  assert.equal(elements['existing-assets-list'].children[0], existingRow);
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
  assert.equal(getElementTreeText(elements['project-file-list'].children[0]).includes('Project Brief.pdf'), true);
  assert.equal(elements['project-file-list'].children[0].children.some(child => child.tagName === 'BUTTON'), false);
  assert.equal(elements['existing-assets-list'].children.length, 1);
  assert.equal(getElementTreeText(elements['existing-assets-list'].children[0]).includes('Linked Reference.pdf'), true);
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
    files: [{
      name: 'Review.ai', ext: '.ai', visualIdentity: 'stable-review-identity', visualRevision: 'stable-review-revision',
      projectRole: 'source', assetOrigin: 'added', appFamily: 'illustrator', status: 'ready',
    }],
  });
  await new Promise(resolve => setImmediate(resolve));

  const item = elements['modal-file-list'].children[0];
  assert.equal(item.children[0].classList.contains('is-icon'), true);
  assert.equal(getElementTreeText(item).includes('/synthetic/'), false);
  assert.equal(item.children[1].textContent, 'Review.ai');
  const summary = getElementTreeText(elements['package-review-summary-list']);
  assert.equal(summary.includes('Working files 1'), true);
  assert.equal(summary.includes('Existing assets 0'), true);
  assert.equal(summary.includes('Added while working 0'), true);
  assert.equal(summary.includes('Needs Review 0'), true);
});

test('Package Review shows privacy-safe source context for visual assets', () => {
  const { document, elements } = createInteractiveRendererDom();
  const project = { id: 'review-source-context', name: 'Source Context', files: [] };
  const renderer = loadRendererHelpers(document, { crate: {} });

  renderer.renderPackageReview(project, {
    token: '00000000-0000-4000-8000-000000000112',
    materializable: true,
    files: [{
      name: 'campaign-hero.jpg', ext: '.jpg', appFamily: 'illustrator', sourceName: 'Brand-System.ai',
      projectRole: 'asset', assetOrigin: 'existing', status: 'ready',
    }],
  });

  const reviewText = getElementTreeText(elements['modal-file-list']);
  assert.equal(reviewText.includes('Illustrator · Brand-System.ai'), true);
  assert.equal(reviewText.includes('/Users/'), false);
});

test('Package Review shows authoritative file-type destinations and the saved organization mode', () => {
  const { document, elements } = createInteractiveRendererDom();
  const project = { id: 'review-organized-destinations', name: 'Organized Review', files: [] };
  const renderer = loadRendererHelpers(document, { crate: {} });

  renderer.renderPackageReview(project, {
    token: '00000000-0000-4000-8000-000000000114',
    materializable: true,
    planSummary: { outputLayoutMode: 'by-extension-v1' },
    files: [
      { name: 'Brand.ai', ext: '.ai', packageFolder: 'AI', projectRole: 'source', status: 'ready' },
      { name: 'Logo.png', ext: '.png', packageFolder: 'PNG', projectRole: 'asset', status: 'ready' },
    ],
  });

  const reviewText = getElementTreeText(elements['modal-file-list']);
  assert.equal(reviewText.includes('AI folder'), true);
  assert.equal(reviewText.includes('PNG folder'), true);
  assert.equal(elements['toggle-package-review-folders'].checked, true);
  assert.equal(elements['toggle-package-folders'].checked, true);
  assert.equal(elements['package-review-organization-status'].textContent, 'Folders by file type');
  assert.equal(reviewText.includes('/Users/'), false);
});

test('changing Package Review organization refreshes authority before packaging', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const calls = [];
  const project = { id: 'review-layout-refresh', name: 'Layout Refresh', files: [] };
  const renderer = loadRendererHelpers(document, { crate: {
    updateSetting: async (key, value) => {
      calls.push(['setting', key, value]);
      return { namingTemplate: '{Project}_{Date}', packageOutputLayoutMode: value };
    },
    preparePackageReview: async projectId => {
      calls.push(['review', projectId]);
      return {
        token: '00000000-0000-4000-8000-000000000115',
        materializable: true,
        planSummary: { outputLayoutMode: 'by-extension-v1' },
        files: [{
          name: 'Layout.ai', ext: '.ai', packageFolder: 'AI', projectRole: 'source', status: 'ready',
        }],
      };
    },
    getProjects: async () => [project],
  } });
  renderer.testProject = project;
  vm.runInContext(`
    state.projects = [testProject];
    state.selectedProjectId = testProject.id;
    state.settings = { namingTemplate: '{Project}_{Date}', packageOutputLayoutMode: 'flat' };
    state.packageReviewToken = '00000000-0000-4000-8000-000000000099';
  `, renderer);

  await renderer.updatePackageOutputLayoutMode(true, { refreshReview: true });

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['setting', 'packageOutputLayoutMode', 'by-extension-v1'],
    ['review', project.id],
  ]);
  assert.equal(
    vm.runInContext('state.packageReviewToken', renderer),
    '00000000-0000-4000-8000-000000000115'
  );
  assert.equal(elements['btn-confirm-package'].disabled, false);
  assert.equal(elements['toggle-package-review-folders'].checked, true);
  assert.equal(elements['package-review-organization-status'].textContent, 'Folders by file type');
  assert.equal(
    elements['modal-package-review-message'].textContent,
    'Package organization changed. Review the updated destinations before packaging.'
  );
  assert.equal(getElementTreeText(elements['modal-file-list']).includes('AI folder'), true);
});

test('failed organization refresh keeps the saved mode but shows the authoritative scan failure', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const project = { id: 'review-layout-refresh-failure', name: 'Layout Refresh Failure', files: [] };
  const renderer = loadRendererHelpers(document, { crate: {
    updateSetting: async (key, value) => ({
      namingTemplate: '{Project}_{Date}',
      packageOutputLayoutMode: value,
    }),
    preparePackageReview: async () => ({
      error: 'package_scan_incomplete',
      diagnostics: {
        failurePhase: 'pre-package-discovery',
        phaseElapsedMs: 8001,
        candidateCount: 42,
        xattrResolvedCount: 3,
        metadataFallbackCount: 7,
      },
    }),
    getProjects: async () => [project],
  } });
  renderer.testProject = project;
  vm.runInContext(`
    state.projects = [testProject];
    state.selectedProjectId = testProject.id;
    state.settings = { namingTemplate: '{Project}_{Date}', packageOutputLayoutMode: 'flat' };
    state.packageReviewToken = '00000000-0000-4000-8000-000000000116';
  `, renderer);

  await renderer.updatePackageOutputLayoutMode(true, { refreshReview: true });

  const message = elements['modal-package-review-message'].textContent;
  assert.equal(vm.runInContext('state.packageReviewToken', renderer), null);
  assert.equal(vm.runInContext('state.settings.packageOutputLayoutMode', renderer), 'by-extension-v1');
  assert.equal(elements['btn-confirm-package'].disabled, true);
  assert.equal(elements['toggle-package-review-folders'].checked, true);
  assert.match(message, /Crate could not finish checking project files/);
  assert.match(message, /code package_scan_incomplete/);
  assert.match(message, /phase pre-package-discovery/);
  assert.equal(message.includes('Package organization changed'), false);
});

test('Figma rate-limit warning card shows the server retry time when available', () => {
  const document = createDocumentStub();
  const renderer = loadRendererHelpers(document);
  const container = createElementStub();
  container.ownerDocument = document;
  container.append = (...children) => children.forEach(child => container.appendChild(child));
  const retryAt = Date.now() + 90_000;

  renderer.renderFigmaWarningCard(
    container,
    'Figma is temporarily rate limiting this scan.',
    retryAt
  );

  const text = getElementTreeText(container);
  assert.equal(text.includes('Figma rate limiting'), true);
  assert.equal(text.includes('Try again after'), true);
  assert.equal(text.includes('Crate will retry after Figma allows the request.'), false);
});

test('Figma connection warning card distinguishes authentication from file access', () => {
  const document = createDocumentStub();
  const renderer = loadRendererHelpers(document);
  const container = createElementStub();
  container.ownerDocument = document;
  container.append = (...children) => children.forEach(child => container.appendChild(child));

  renderer.renderFigmaWarningCard(
    container,
    'Figma is not connected. Reconnect in Settings. No Figma assets will be captured until the connection is restored.'
  );

  const text = getElementTreeText(container);
  assert.equal(text.includes('Figma connection required'), true);
  assert.equal(text.includes('Reconnect Figma in Settings.'), true);
  assert.equal(text.includes('File cannot be read'), false);
});

test('Figma warning cards use source-backed recovery actions and keep zero-image results informational', () => {
  const document = createDocumentStub();
  const renderer = loadRendererHelpers(document);
  const cases = [
    ['file-access', 'Figma file access required', 'Check access or replace the Figma link, then try again.', 'Blocked'],
    ['scope', 'Figma page or layer link required', 'Use the exact Figma page or layer link, or replace the Figma link, then try again.', 'Blocked'],
    ['unknown', 'Figma scan needs attention', 'Check your Figma connection and try again.', 'Blocked'],
    ['informational', 'No exportable Figma assets', 'This page has no exportable image assets.', 'Info'],
  ];

  for (const [category, title, action, status] of cases) {
    const container = createElementStub();
    container.ownerDocument = document;
    container.append = (...children) => children.forEach(child => container.appendChild(child));
    renderer.renderFigmaWarningCard(container, 'A safe Figma warning.', null, category);
    const text = getElementTreeText(container);
    assert.equal(text.includes(title), true);
    assert.equal(text.includes(action), true);
    assert.equal(text.includes(status), true);
  }
});

test('Package Review recovery uses the persisted Figma failure category without changing the package gate', () => {
  const renderer = loadRendererHelpers();
  const error = 'Crate could not securely retrieve all Figma assets. No package was written. Try again.';
  const project = category => ({
    figmaSession: { trackedFiles: [{ failureCategory: category }] },
  });

  assert.equal(
    renderer.getPackageReviewRecoveryMessage(error, null, project('connection')),
    'Reconnect Figma in Settings, then try packaging again.'
  );
  assert.equal(
    renderer.getPackageReviewRecoveryMessage(error, null, project('rate-limited')),
    'Wait for the Figma cooldown, then try packaging again.'
  );
  assert.equal(
    renderer.getPackageReviewRecoveryMessage(error, null, project('file-access')),
    'Check access or replace the Figma link, then try packaging again.'
  );
  assert.equal(
    renderer.getPackageReviewRecoveryMessage(error, null, project('scope')),
    'Use the exact Figma page or layer link, or replace the Figma link, then try packaging again.'
  );
  assert.equal(
    renderer.getPackageReviewRecoveryMessage(error, null, project('unknown')),
    'Check your Figma connection and try again.'
  );
});

test('first Package Now failure uses the refreshed Figma category recovery copy', async () => {
  const transferError = 'Crate could not securely retrieve all Figma assets. No package was written. Try again.';
  const cases = [
    ['file-access', 'Check access or replace the Figma link, then try packaging again.'],
    ['scope', 'Use the exact Figma page or layer link, or replace the Figma link, then try packaging again.'],
    ['rate-limited', 'Wait for the Figma cooldown, then try packaging again.'],
    ['unknown', 'Check your Figma connection and try again.'],
  ];

  for (const [caseIndex, [category, expectedMessage]] of cases.entries()) {
    const { document, elements } = createInteractiveRendererDom();
    const project = {
      id: `first-package-failure-${category}`,
      name: `First Package Failure ${category}`,
      type: 'branding',
      status: 'watching',
      files: [],
      pendingFiles: [],
      excludedAssetKeys: [],
      figmaScopeMode: 'current-page',
      figmaTrackedFiles: [{ key: `safe-${category}` }],
      figmaSession: { trackedFiles: [], warnings: [] },
    };
    const refreshedProject = {
      ...project,
      figmaSession: {
        trackedFiles: [{ failureCategory: category }],
        warnings: ['Figma scan needs attention.'],
      },
    };
    const review = {
      token: `00000000-0000-4000-8000-0000000004${String(caseIndex + 1).padStart(2, '0')}`,
      projectId: project.id,
      files: [],
      totalFiles: 0,
      materializable: true,
    };
    let projectSnapshot = project;
    let packageCalls = 0;
    const renderer = loadRendererHelpers(document, { crate: {
      getProjects: async () => [projectSnapshot],
      preScanSession: async () => ({ success: true }),
      preparePackageReview: async () => review,
      packageProject: async projectId => {
        packageCalls++;
        assert.equal(projectId, project.id);
        return { error: transferError };
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
    projectSnapshot = refreshedProject;
    await renderer.confirmPackage();

    assert.equal(packageCalls, 1);
    assert.equal(elements['modal-package-review-message'].textContent, expectedMessage);
  }
});

test('Figma retry copy falls back safely for expired or invalid timestamps', () => {
  const renderer = loadRendererHelpers();
  const warning = 'Figma is temporarily rate limiting this scan.';

  assert.equal(renderer.getFigmaWarningDisplayText(warning, Date.now() - 1), warning);
  assert.equal(renderer.getFigmaWarningDisplayText(warning, 'Retry-After: SECRET'), warning);
  assert.equal(renderer.formatFigmaRetryTime(Number.MAX_SAFE_INTEGER), '');
});

test('Package Review shows the persisted Figma retry time', () => {
  const { document, elements } = createInteractiveRendererDom();
  const retryAt = Date.now() + 120_000;
  const warning = 'Figma is temporarily rate limiting this scan.';
  const project = {
    id: 'figma-rate-limit-review',
    name: 'Figma Rate Limit Review',
    files: [],
    figmaTrackedFiles: [{ key: 'safe-key' }],
    figmaSession: { warnings: [warning], rateLimitRetryAt: retryAt, trackedFiles: [] },
  };
  const renderer = loadRendererHelpers(document, { crate: {} });

  renderer.renderPackageReview(project, { materializable: false, files: [] });

  assert.equal(elements['modal-figma-warning'].textContent.includes('Try again after'), true);
  assert.equal(elements['btn-confirm-package'].disabled, true);
});

test('Package Review reports authoritative unavailable counts and resets blocked-review scrolling', () => {
  const { document, elements, packageReviewDialog } = createInteractiveRendererDom();
  const project = { id: 'unavailable-review-summary', name: 'Unavailable Review', files: [] };
  const renderer = loadRendererHelpers(document, { crate: {} });

  packageReviewDialog.scrollTop = 180;
  renderer.renderPackageReview(project, {
    materializable: false,
    message: 'Review required before packaging.',
    files: [
      { name: 'Ready.ai', ext: '.ai', projectRole: 'source', assetOrigin: 'existing', status: 'ready' },
      { name: 'Missing.png', ext: '.png', projectRole: 'asset', assetOrigin: 'existing', status: 'missing' },
      { name: 'Unavailable.mov', ext: '.mov', projectRole: 'asset', assetOrigin: 'added', status: 'unavailable' },
    ],
  });

  const summary = getElementTreeText(elements['package-review-summary-list']);
  assert.equal(summary.includes('Working files 1'), true);
  assert.equal(summary.includes('Existing assets 1'), true);
  assert.equal(summary.includes('Added while working 1'), true);
  assert.equal(summary.includes('Needs Review 2'), true);
  assert.equal(packageReviewDialog.scrollTop, 0);
  assert.equal(elements['modal-package-review-message'].focused, true);
});

test('Package Review minimizes custom destination paths in renderer labels', () => {
  const { document, elements } = createInteractiveRendererDom();
  const renderer = loadRendererHelpers(document, { crate: {} });
  renderer.testProject = { id: 'private-destination-review', name: 'Private Destination', files: [] };
  vm.runInContext("state.packageOutputPath = '/Users/private/Client Work/Deliverables';", renderer);

  renderer.renderPackageReview(renderer.testProject, {
    token: '00000000-0000-4000-8000-000000000113',
    materializable: true,
    files: [],
  });

  assert.equal(elements['modal-dest-path'].textContent, 'Selected output folder');
  assert.equal(elements['modal-dest-path'].textContent.includes('/Users/'), false);
  assert.equal(renderer.getPackageDestinationLabel(null), '~/Desktop/');
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

test('renderer counts regenerated embedded PSD exclusions by their stable identity', () => {
  const renderer = loadRendererHelpers(createDocumentStub({}));
  const parentPsd = '/Synthetic/Project.psd';
  const project = {
    status: 'paused',
    files: [
      { path: parentPsd, name: 'Project.psd' },
      {
        name: 'Embedded.png', fileId: 'regenerated-id', embedded: true,
        source: 'scan-on-save-embedded', parentPsd,
        embeddedOriginalName: 'Embedded.png', embeddedIndex: 0,
      },
    ],
    excludedAssetKeys: ['embedded-psd:/synthetic/project.psd:0:Embedded.png'],
  };

  assert.equal(renderer.getStatusLabel(project), 'Paused · 1 file so far');
});

test('Current Project raw fallback omits private source metadata when the asset workspace fails', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const privateSourcePath = '/Users/synthetic/Private Client/Working.ai';
  const parentPsd = '/Users/synthetic/Private Client/Working.psd';
  const project = {
    id: 'private-current-project-fallback',
    name: 'Private Fallback',
    type: 'branding',
    status: 'paused',
    files: [
      {
        name: 'Working.ai', path: privateSourcePath, ext: '.ai', fileId: 'working-source',
        assetOrigin: 'added', projectRole: 'source', captureEvidence: { appFamily: 'illustrator', sourceName: privateSourcePath },
      },
      {
        name: 'Embedded.png', fileId: 'regenerated-embedded-id', ext: '.png', embedded: true,
        source: 'scan-on-save-embedded', parentPsd, embeddedOriginalName: 'Embedded.png', embeddedIndex: 0,
        assetOrigin: 'added', projectRole: 'asset', captureEvidence: { appFamily: 'photoshop', sourceName: parentPsd },
      },
    ],
    pendingFiles: [{
      name: 'Needs_Save.png', ext: '.png', fileId: 'needs-save', captureState: 'needs-save',
      captureEvidence: { appFamily: 'illustrator', sourceName: privateSourcePath },
    }],
    excludedAssetKeys: [`embedded-psd:${parentPsd.toLowerCase()}:0:Embedded.png`],
    assetBaseline: { status: 'included', decision: 'include' },
  };
  const renderer = loadRendererHelpers(document, { crate: {
    getAssetWorkspace: async () => {
      throw new Error('synthetic workspace failure');
    },
  } });
  renderer.testProject = project;
  vm.runInContext(`
    state.projects = [testProject];
    state.selectedProjectId = testProject.id;
    state.assetWorkspace = null;
  `, renderer);

  await renderer.renderFiles();

  assert.equal(elements['files-status-text'].textContent, 'Paused · 1 file');
  assert.equal(renderer.getStatusLabel(project), 'Paused · 1 file so far');
  assert.equal(elements['added-assets-list'].children.length, 1);
  assert.equal(elements['pending-file-list'].children.length, 1);
  const renderedText = [
    getElementTreeText(elements['project-file-list']),
    getElementTreeText(elements['added-assets-list']),
    getElementTreeText(elements['pending-file-list']),
  ].join(' ');
  const searchableMetadata = [
    ...elements['project-file-list'].children,
    ...elements['added-assets-list'].children,
    ...elements['pending-file-list'].children,
  ].map(row => JSON.stringify(row.dataset)).join(' ');
  assert.equal(renderedText.includes(privateSourcePath), false);
  assert.equal(renderedText.includes(parentPsd), false);
  assert.equal(searchableMetadata.includes(privateSourcePath), false);
  assert.equal(searchableMetadata.includes(parentPsd), false);
  assert.equal(renderedText.includes('Observed in Illustrator'), true);
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

test('Done closes package success and restores every populated Projects row', () => {
  const { document, elements, tabs } = createInteractiveRendererDom();
  const projects = [
    {
      id: 'packaged-one',
      name: 'Packaged One',
      status: 'packaged',
      files: [{ name: 'Packaged-One.ai', path: '/synthetic/Packaged-One.ai' }],
      pendingFiles: [],
      excludedAssetKeys: [],
      packagedAt: Date.UTC(2026, 7, 18),
    },
    {
      id: 'paused-two',
      name: 'Paused Two',
      status: 'paused',
      files: [{ name: 'Paused-Two.psd', path: '/synthetic/Paused-Two.psd' }],
      pendingFiles: [],
      excludedAssetKeys: [],
    },
    {
      id: 'packaged-three',
      name: 'Packaged Three',
      status: 'packaged',
      files: [{ name: 'Packaged-Three.pdf', path: '/synthetic/Packaged-Three.pdf' }],
      pendingFiles: [],
      excludedAssetKeys: [],
      packagedAt: Date.UTC(2026, 7, 18),
    },
  ];
  const renderer = loadRendererHelpers(document, { crate: {} });
  renderer.testProjects = projects;
  vm.runInContext('state.projects = testProjects', renderer);
  renderer.setupEventListeners();
  renderer.showPackageSuccessModal();

  assert.equal(elements['modal-success'].classList.contains('hidden'), false);
  assert.equal(elements['app-sidebar'].inert, true);
  assert.equal(elements['app-main'].inert, true);
  assert.equal(document.activeElement, elements['btn-success-done']);
  assert.doesNotThrow(() => elements['btn-success-done'].click());

  assert.equal(elements['modal-success'].classList.contains('hidden'), true);
  assert.equal(elements['app-sidebar'].inert, false);
  assert.equal(elements['app-main'].inert, false);
  assert.equal(elements['app-sidebar'].getAttribute('aria-hidden'), undefined);
  assert.equal(elements['app-main'].getAttribute('aria-hidden'), undefined);
  assert.equal(tabs[0].classList.contains('active'), true);
  assert.equal(elements['tab-projects'].classList.contains('active'), true);
  assert.equal(elements['projects-empty'].classList.contains('hidden'), true);
  assert.equal(elements['projects-list'].classList.contains('hidden'), false);
  assert.equal(elements['project-rows'].children.length, 3);
  assert.deepEqual(
    elements['project-rows'].children.map(row => row.dataset.id),
    projects.map(project => project.id),
  );
  assert.equal(document.activeElement, tabs[0]);
});

test('renderer surfaces typed Package Review scan diagnostics without private values', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const privatePath = '/Users/synthetic/Private Client/Private_Project.ai';
  const privatePsdPath = '/Users/synthetic/Private Client/Private_Project.psd';
  const privateVolumePath = '/Volumes/Private Client/Private_Project.ai';
  const privateUrl = 'https://figma.com/design/private-file';
  const privateToken = 'private-review-token-should-not-appear';
  const project = {
    id: 'diagnostic-review-project',
    name: 'Diagnostic Review',
    type: 'branding',
    status: 'watching',
    files: [
      {
        name: 'Private_Project.ai', ext: '.ai', fileId: 'source-key', assetOrigin: 'existing', projectRole: 'source',
        sourceName: '/Users/synthetic/Private Client/Private_Project.ai',
        captureEvidence: { appFamily: 'illustrator', sourceName: 'file:///Users/synthetic/Private Client/Private_Project.ai' },
      },
      {
        name: 'Included.png', ext: '.png', fileId: 'included-key', assetOrigin: 'existing', projectRole: 'asset',
        sourceName: 'https://figma.com/design/private-file',
        captureEvidence: {
          appFamily: 'illustrator',
          sourceName: '/Volumes/Private Client/Private_Project.ai',
          relationshipSourcePath: '/Users/synthetic/Private Client/Private_Project.ai',
        },
      },
      {
        name: 'Excluded.png', ext: '.png', fileId: 'excluded-key', assetOrigin: 'added', projectRole: 'asset',
        sourceName: 'Excluded Source.ai',
        captureEvidence: { appFamily: 'illustrator' },
      },
      {
        name: 'Embedded.png', ext: '.png', fileId: 'regenerated-embedded-id', assetOrigin: 'added', projectRole: 'asset',
        embedded: true, source: 'scan-on-save-embedded', parentPsd: privatePsdPath,
        embeddedOriginalName: 'Embedded.png', embeddedIndex: 0,
        captureEvidence: { appFamily: 'photoshop', sourceName: 'Private_Project.psd' },
      },
    ],
    excludedAssetKeys: ['excluded-key', `embedded-psd:${privatePsdPath.toLowerCase()}:0:Embedded.png`],
  };
  let assetWorkspaceCalls = 0;
  const renderer = loadRendererHelpers(document, { crate: {
    getAssetWorkspace: async projectId => {
      assetWorkspaceCalls += 1;
      assert.equal(projectId, project.id);
      return {
        projectId,
        files: project.files.map(file => ({
          ...file,
          excluded: file.fileId === 'excluded-key' || file.fileId === 'regenerated-embedded-id',
        })),
        pendingFiles: [],
      };
    },
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
  const reviewFilesText = getElementTreeText(elements['modal-file-list']);
  assert.equal(elements['modal-file-list'].children.length, 2);
  assert.equal(assetWorkspaceCalls, 1);
  assert.equal(reviewFilesText.includes('Illustrator · Private_Project.ai'), true);
  assert.equal(reviewFilesText.includes('Included.png'), true);
  assert.equal(reviewFilesText.includes('Excluded.png'), false);
  assert.equal(reviewFilesText.includes('Embedded.png'), false);
  assert.equal(reviewFilesText.includes(privatePath), false);
  assert.equal(reviewFilesText.includes(privateVolumePath), false);
  assert.equal(reviewFilesText.includes(privateUrl), false);
  assert.equal(elements['package-review-total'].textContent, '2 visual assets');
  assert.equal(getElementTreeText(elements['package-review-summary-list']).includes('Working files 1'), true);
  assert.equal(getElementTreeText(elements['package-review-summary-list']).includes('Existing assets 1'), true);
  assert.equal(getElementTreeText(elements['package-review-summary-list']).includes('Added while working 0'), true);
});

test('renderer shows no guessed Package Review inventory when the asset workspace is unavailable', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const privatePath = '/Users/synthetic/Private Client/Excluded.png';
  const project = {
    id: 'unavailable-asset-workspace-project',
    name: 'Unavailable Asset Workspace',
    type: 'branding',
    status: 'watching',
    files: [
      { name: 'Working.ai', ext: '.ai', fileId: 'source-key', projectRole: 'source' },
      {
        name: 'Excluded.png', ext: '.png', fileId: 'regenerated-id', embedded: true,
        source: 'scan-on-save-embedded', parentPsd: privatePath, embeddedOriginalName: 'Excluded.png', embeddedIndex: 0,
      },
    ],
    excludedAssetKeys: [`embedded-psd:${privatePath.toLowerCase()}:0:Excluded.png`],
  };
  const renderer = loadRendererHelpers(document, { crate: {
    getAssetWorkspace: async () => {
      throw new Error('synthetic authoritative workspace failure');
    },
    preparePackageReview: async () => ({
      error: 'package_scan_incomplete',
      diagnostics: { failurePhase: 'pre-package-discovery' },
    }),
  } });
  renderer.testProject = project;
  vm.runInContext(`
    state.projects = [testProject];
    state.selectedProjectId = testProject.id;
    state.assetWorkspace = null;
    state.settings = { namingTemplate: '{Project}_{Date}' };
  `, renderer);

  assert.equal(await renderer.showPackageModal({ runPreScan: false }), false);
  assert.equal(elements['modal-file-list'].children.length, 0);
  assert.equal(elements['package-review-total'].textContent, '0 visual assets');
  assert.equal(elements['btn-confirm-package'].disabled, true);
  assert.equal(vm.runInContext('state.packageReviewToken', renderer), null);
  const reviewText = getElementTreeText(elements['modal-package']);
  assert.equal(reviewText.includes('Working.ai'), false);
  assert.equal(reviewText.includes('Excluded.png'), false);
  assert.equal(reviewText.includes(privatePath), false);
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
  assert.match(html, /<button[^>]*id="btn-review-existing-assets-later"[^>]*>Review Later<\/button>/);
  assert.match(html, /<button[^>]*id="btn-include-existing-assets"[^>]*>Review Assets<\/button>/);
  assert.match(html, /id="modal-package"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /<button[^>]*id="btn-change-dest"[^>]*>Change Folder<\/button>/);
  assert.match(html, /<div(?=[^>]*id="modal-package-review-message")(?=[^>]*role="status")(?=[^>]*aria-live="polite")(?=[^>]*tabindex="-1")[^>]*>/);
  assert.match(html, /id="modal-file-list"[^>]*role="region"[^>]*tabindex="-1"/);
  assert.match(html, /id="asset-review-heading"[^>]*tabindex="-1"/);
  assert.match(html, /data-asset-filter="all"[^>]*aria-pressed="true"/);
  assert.match(html, /data-asset-filter="existing"[^>]*aria-pressed="false"/);
  assert.match(html, /<input(?=[^>]*id="toggle-package-folders")(?=[^>]*aria-labelledby="setting-package-folders-label")(?=[^>]*aria-describedby="setting-package-folders-desc")[^>]*>/);
  assert.match(html, /id="toggle-package-review-folders"[^>]*aria-labelledby="package-review-organization-label"[^>]*aria-describedby="package-review-organization-status"/);
  assert.match(css, /\.modal-btn-primary:disabled[\s\S]*cursor:\s*not-allowed/);
  assert.match(css, /\.modal-review-message\.is-empty\s*\{[\s\S]*visibility:\s*hidden;/);
  assert.match(css, /#btn-package,[\s\S]*#btn-cancel-package\s*\{[\s\S]*min-height:\s*40px;[\s\S]*white-space:\s*nowrap;/);
  assert.match(css, /#btn-package\s*\{\s*min-width:\s*144px;\s*\}/);
  assert.match(css, /\.package-review-modal\s*\{(?=[^}]*position:\s*relative;)(?=[^}]*overflow-x:\s*hidden;)(?=[^}]*overflow-y:\s*auto;)[^}]*\}/);
  assert.match(css, /\.toggle input:focus-visible \+ \.toggle-slider\s*\{(?=[^}]*outline:\s*2px solid var\(--black\);)(?=[^}]*outline-offset:\s*3px;)[^}]*\}/);
  assert.match(html, /id="modal-upgrade"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-describedby="upgrade-subtitle"/);
  assert.match(html, /<button[^>]*id="btn-dismiss-upgrade"[^>]*>Maybe later[\s\S]*<\/button>/);
  assert.match(css, /\.dismiss-link:focus-visible[\s\S]*outline:/);
});

test('navigation uses Projects, Quick Package, and Project Workspace consistently', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const visibleHtml = html.replace(/<!--[\s\S]*?-->/g, '');

  assert.match(
    visibleHtml,
    /<button(?=[^>]*data-tab="projects")[^>]*>\s*Projects\s*<\/button>[\s\S]*<button(?=[^>]*data-tab="current-project")[^>]*>\s*Project Workspace\s*<\/button>[\s\S]*<button(?=[^>]*data-tab="quick-package")[^>]*>\s*Quick Package\s*<\/button>/
  );
  assert.match(visibleHtml, /id="btn-review-assets-back">&lsaquo; Project Workspace<\/button>/);
  assert.equal(visibleHtml.includes('Current Project'), false);
});

test('new project creation removes category pills and requests automatic app detection', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const visibleHtml = html.replace(/<!--[\s\S]*?-->/g, '');
  const { document, elements } = createInteractiveRendererDom();
  const createCalls = [];
  const renderer = loadRendererHelpers(document, {
    crate: {
      createProject: async (...args) => {
        createCalls.push(args);
        return { error: 'test_stop_after_request' };
      },
      getProjects: async () => [],
    },
  });

  document.querySelector('#input-project-name').value = 'Mixed App Campaign';
  document.querySelector('#input-figma-scope').value = 'current-page';
  await renderer.createProject();

  assert.equal(visibleHtml.includes('Project Type'), false);
  assert.equal(visibleHtml.includes('type-pill'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(createCalls)), [[
    'Mixed App Campaign',
    'automatic',
    'current-page',
    null,
  ]]);
});

test('project creation state starts idle and leaves the Projects surface renderable', () => {
  const { document, elements } = createInteractiveRendererDom();
  const renderer = loadRendererHelpers(document);
  const projects = [
    { id: 'one', name: 'One', status: 'packaged', files: [] },
    { id: 'two', name: 'Two', status: 'paused', files: [] },
    { id: 'three', name: 'Three', status: 'watching', files: [] },
  ];
  renderer.testProjects = projects;
  vm.runInContext(`
    state.projects = testProjects;
    renderProjects();
  `, renderer);

  assert.equal(vm.runInContext('projectCreationPhase', renderer), 'idle');
  assert.equal(elements['projects-empty'].classList.contains('hidden'), true);
  assert.equal(elements['projects-list'].classList.contains('hidden'), false);
  assert.equal(elements['new-project-form'].classList.contains('hidden'), true);
  assert.equal(elements['project-rows'].children.length, 3);
});

test('DOMContentLoaded clean startup renders the complete Projects surface', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const projects = [
    { id: 'startup-one', name: 'Startup One', status: 'packaged', files: [] },
    { id: 'startup-two', name: 'Startup Two', status: 'paused', files: [] },
    { id: 'startup-three', name: 'Startup Three', status: 'watching', files: [] },
  ];
  const noOp = () => {};
  loadRendererHelpers(document, { crate: {
    getProjects: async () => projects,
    getSettings: async () => ({ namingTemplate: '{Project}_{Date}' }),
    getUsage: async () => ({ packagesThisMonth: 9, packageLimit: 25 }),
    getFigmaStatus: async () => ({ connected: false }),
    onFilesUpdated: noOp,
    onProjectUpdated: noOp,
    onPendingFilesUpdated: noOp,
    onPackageTrigger: noOp,
    onFigmaAuthError: noOp,
    onFigmaScanStarted: noOp,
    onFigmaScanComplete: noOp,
    onFigmaScanError: noOp,
  } });

  await document.listeners.DOMContentLoaded();

  assert.equal(elements['tab-projects'].classList.contains('active'), true);
  assert.equal(elements['projects-empty'].classList.contains('hidden'), true);
  assert.equal(elements['projects-list'].classList.contains('hidden'), false);
  assert.equal(elements['new-project-form'].classList.contains('hidden'), true);
  assert.equal(elements['project-rows'].children.length, 3);
});

test('renderer startup diagnostics record success through the first frame', async () => {
  const { document } = createInteractiveRendererDom();
  const signals = [];
  let frameCallback = null;
  const noOp = () => {};
  const bridge = {
    getProjects: async () => [],
    getSettings: async () => ({}),
    getUsage: async () => ({}),
    getFigmaStatus: async () => ({ connected: false }),
    onFilesUpdated: noOp,
    onProjectUpdated: noOp,
    onPendingFilesUpdated: noOp,
    onPackageTrigger: noOp,
    onFigmaAuthError: noOp,
    onFigmaScanStarted: noOp,
    onFigmaScanComplete: noOp,
    onFigmaScanError: noOp,
    reportRendererScriptEntered: () => signals.push('renderer-script-entered'),
    reportRendererInitEntered: () => signals.push('renderer-init-entered'),
    reportRendererStartupDataComplete: () => signals.push('renderer-startup-data-complete'),
    reportRendererStartupDataFailed: () => signals.push('renderer-startup-data-failed'),
    reportRendererFirstRenderComplete: () => signals.push('renderer-first-render-complete'),
    reportRendererFirstFrame: () => signals.push('renderer-first-frame'),
  };

  loadRendererHelpers(document, { crate: bridge }, {
    requestAnimationFrame(callback) {
      frameCallback = callback;
      return 1;
    },
  });
  await document.listeners.DOMContentLoaded();
  assert.deepEqual(signals, [
    'renderer-script-entered',
    'renderer-init-entered',
    'renderer-startup-data-complete',
    'renderer-first-render-complete',
  ]);
  assert.equal(typeof frameCallback, 'function');
  frameCallback();
  assert.equal(signals.at(-1), 'renderer-first-frame');
});

test('renderer startup diagnostics record data failure and fail open when signals throw', async () => {
  const { document } = createInteractiveRendererDom();
  const signals = [];
  let frameCallback = null;
  const noOp = () => {};
  const bridge = {
    getProjects: async () => { throw new Error('synthetic startup failure'); },
    getSettings: async () => ({}),
    getUsage: async () => ({}),
    getFigmaStatus: async () => ({ connected: false }),
    onFilesUpdated: noOp,
    onProjectUpdated: noOp,
    onPendingFilesUpdated: noOp,
    onPackageTrigger: noOp,
    onFigmaAuthError: noOp,
    onFigmaScanStarted: noOp,
    onFigmaScanComplete: noOp,
    onFigmaScanError: noOp,
    reportRendererScriptEntered: () => { throw new Error('diagnostic bridge failed'); },
    reportRendererInitEntered: () => { throw new Error('diagnostic bridge failed'); },
    reportRendererStartupDataFailed: () => { throw new Error('diagnostic bridge failed'); },
    reportRendererFirstRenderComplete: () => { throw new Error('diagnostic bridge failed'); },
    reportRendererFirstFrame: () => { throw new Error('diagnostic bridge failed'); },
  };

  loadRendererHelpers(document, { crate: bridge }, {
    requestAnimationFrame(callback) {
      frameCallback = callback;
      return 1;
    },
  });
  await assert.doesNotReject(document.listeners.DOMContentLoaded());
  assert.equal(typeof frameCallback, 'function');
  assert.doesNotThrow(() => frameCallback());
});

test('renderer startup remains available when the diagnostic bridge is absent', async () => {
  const { document } = createInteractiveRendererDom();
  const renderer = loadRendererHelpers(document, {});
  await assert.doesNotReject(document.listeners.DOMContentLoaded());
  assert.equal(typeof renderer.init, 'function');
});

test('project creation locks click and Enter submissions until delayed startup refreshes successfully', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const delayedCreate = createDeferred();
  const createCalls = [];
  const projects = [{ id: 'created-project', name: 'QA project', status: 'watching', files: [] }];
  const renderer = loadRendererHelpers(document, {
    crate: {
      createProject: async (...args) => {
        createCalls.push(args);
        return delayedCreate.promise;
      },
      getProjects: async () => projects,
    },
  });
  renderer.setupEventListeners();
  elements['input-project-name'].value = 'QA project';

  elements['btn-create-project'].click();
  elements['input-project-name'].dispatchEvent({
    type: 'keydown',
    key: 'Enter',
    preventDefault: () => {},
  });
  elements['btn-create-project'].click();

  assert.equal(createCalls.length, 1);
  assert.equal(elements['btn-create-project'].disabled, true);
  assert.equal(elements['btn-create-project'].textContent, 'Starting\u2026');
  assert.equal(elements['btn-create-project'].getAttribute('aria-busy'), 'true');
  assert.equal(elements['btn-cancel-project'].disabled, true);
  assert.equal(elements['new-project-form'].getAttribute('aria-busy'), 'true');
  assert.equal(elements['project-creation-status'].getAttribute('role'), 'status');
  assert.equal(elements['project-creation-status'].getAttribute('aria-live'), 'polite');
  assert.equal(elements['project-creation-status'].textContent, 'Starting project. Please wait.');

  delayedCreate.resolve(projects[0]);
  await delayedCreate.promise;
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(createCalls.length, 1);
  assert.equal(elements['btn-create-project'].disabled, false);
  assert.equal(elements['btn-create-project'].textContent, '\u25B6 Start Watching');
  assert.equal(elements['btn-create-project'].getAttribute('aria-busy'), 'false');
  assert.equal(elements['btn-cancel-project'].disabled, false);
  assert.equal(elements['new-project-form'].getAttribute('aria-busy'), 'false');
  assert.equal(elements['tab-current-project'].classList.contains('active'), true);
  assert.equal(vm.runInContext('state.selectedProjectId', renderer), 'created-project');
});

test('project creation accepts double Enter as exactly one delayed startup request', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const delayedCreate = createDeferred();
  let createCalls = 0;
  const projects = [{ id: 'enter-project', name: 'Enter project', status: 'watching', files: [] }];
  const renderer = loadRendererHelpers(document, {
    crate: {
      createProject: async () => {
        createCalls += 1;
        return delayedCreate.promise;
      },
      getProjects: async () => projects,
    },
  });
  renderer.setupEventListeners();
  elements['input-project-name'].value = 'Enter project';
  const enterEvent = () => ({
    type: 'keydown',
    key: 'Enter',
    preventDefault: () => {},
  });

  elements['input-project-name'].dispatchEvent(enterEvent());
  elements['input-project-name'].dispatchEvent(enterEvent());

  assert.equal(createCalls, 1);
  assert.equal(elements['btn-create-project'].disabled, true);
  assert.equal(elements['btn-create-project'].textContent, 'Starting\u2026');

  delayedCreate.resolve(projects[0]);
  await delayedCreate.promise;
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(createCalls, 1);
  assert.equal(vm.runInContext('state.selectedProjectId', renderer), 'enter-project');
  assert.equal(elements['btn-create-project'].disabled, false);
});

test('never-settling project creation fails closed with restart guidance and ignores a late response', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const delayedCreate = createDeferred();
  const timers = [];
  let nextTimerId = 1;
  let createCalls = 0;
  const fakeSetTimeout = (callback, delay) => {
    const timer = { id: nextTimerId, callback, delay, cleared: false };
    nextTimerId += 1;
    timers.push(timer);
    return timer.id;
  };
  const fakeClearTimeout = timerId => {
    const timer = timers.find(item => item.id === timerId);
    if (timer) timer.cleared = true;
  };
  const renderer = loadRendererHelpers(document, {
    crate: {
      createProject: async () => {
        createCalls += 1;
        return delayedCreate.promise;
      },
      getProjects: async () => [],
    },
  }, {
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
  });
  renderer.setupEventListeners();
  elements['input-project-name'].value = 'Never settles';

  const createPromise = renderer.createProject();
  await Promise.resolve();
  const watchdog = timers.find(timer => timer.delay === 30000);
  assert.ok(watchdog);
  assert.equal(createCalls, 1);
  watchdog.callback();
  await createPromise;

  assert.equal(vm.runInContext('projectCreationPhase', renderer), 'unresolved');
  assert.equal(elements['btn-create-project'].disabled, true);
  assert.equal(elements['btn-create-project'].textContent, 'Restart Crate to continue');
  assert.equal(elements['btn-create-project'].getAttribute('aria-busy'), 'false');
  assert.equal(elements['new-project-form'].getAttribute('aria-busy'), 'false');
  assert.equal(elements['btn-cancel-project'].disabled, true);
  assert.match(elements['project-creation-status'].textContent, /Restart Crate before trying again/);

  elements['input-project-name'].dispatchEvent({
    type: 'keydown',
    key: 'Enter',
    preventDefault: () => {},
  });
  elements['btn-create-project'].click();
  await renderer.createProject();
  assert.equal(createCalls, 1);

  delayedCreate.resolve({ id: 'late-project', name: 'Late', status: 'watching', files: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(vm.runInContext('projectCreationPhase', renderer), 'unresolved');
  assert.equal(vm.runInContext('state.selectedProjectId', renderer), null);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(state.projects)', renderer)), []);
});

for (const ambiguousOutcome of ['null-response', 'synchronous-rejection', 'asynchronous-rejection']) {
  test(`${ambiguousOutcome} project creation fails closed without permitting a duplicate retry`, async () => {
    const { document, elements } = createInteractiveRendererDom();
    let createCalls = 0;
    const createProject = ambiguousOutcome === 'null-response'
      ? () => {
        createCalls += 1;
        return null;
      }
      : ambiguousOutcome === 'synchronous-rejection'
        ? () => {
          createCalls += 1;
          throw new Error('synthetic synchronous failure');
        }
        : async () => {
          createCalls += 1;
          throw new Error('synthetic asynchronous failure');
        };
    const renderer = loadRendererHelpers(document, {
      crate: {
        createProject,
        getProjects: async () => [],
      },
    });
    renderer.setupEventListeners();
    elements['input-project-name'].value = 'Ambiguous project';

    await renderer.createProject();

    assert.equal(createCalls, 1);
    assert.equal(vm.runInContext('projectCreationPhase', renderer), 'unresolved');
    assert.equal(elements['btn-create-project'].disabled, true);
    assert.equal(elements['btn-create-project'].textContent, 'Restart Crate to continue');
    assert.match(elements['project-creation-status'].textContent, /Restart Crate before trying again/);

    elements['input-project-name'].dispatchEvent({
      type: 'keydown',
      key: 'Enter',
      preventDefault: () => {},
    });
    elements['btn-create-project'].click();
    await renderer.createProject();
    assert.equal(createCalls, 1);
  });
}

test('successful project creation uses the authoritative result when refresh is unavailable', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const createdProject = { id: 'created-result', name: 'Created result', status: 'watching', files: [] };
  const renderer = loadRendererHelpers(document, {
    crate: {
      createProject: async () => createdProject,
      getProjects: async () => { throw new Error('synthetic refresh failure'); },
    },
  });
  vm.runInContext(`state.projects = [{ id: 'older-project', name: 'Older', status: 'watching', files: [] }]`, renderer);
  document.querySelector('#input-project-name').value = 'Created result';

  await renderer.createProject();

  assert.deepEqual(
    JSON.parse(vm.runInContext('JSON.stringify(state.projects.map(project => ({ id: project.id, status: project.status })))', renderer)),
    [
      { id: 'older-project', status: 'paused' },
      { id: 'created-result', status: 'watching' },
    ]
  );
  assert.equal(vm.runInContext('state.selectedProjectId', renderer), 'created-result');
  assert.equal(vm.runInContext('projectCreationPhase', renderer), 'idle');
});

for (const [typedError, figmaMessagePattern] of [
  ['max_projects_reached', null],
  ['invalid_figma_url', /could not read that Figma URL/],
  ['figma_not_connected', /Reconnect Figma in Settings/],
  ['figma_invalid_token', /Reconnect Figma in Settings/],
  ['figma_rate_limited', /temporarily limiting requests/],
  ['figma_file_unavailable', /Check access or replace the Figma link/],
  ['figma_scope_unresolved', /exact Figma page or selected layer link/],
  ['figma_verification_failed', /could not verify that Figma link/],
]) {
  test(`known project creation error ${typedError} unlocks the form without selecting a project`, async () => {
    const { document, elements } = createInteractiveRendererDom();
    const renderer = loadRendererHelpers(document, {
      crate: {
        createProject: async () => ({ error: typedError }),
        getProjects: async () => [],
      },
    });
    document.querySelector('#input-project-name').value = 'Rejected';

    await renderer.createProject();

    assert.equal(vm.runInContext('projectCreationPhase', renderer), 'idle');
    assert.equal(vm.runInContext('state.selectedProjectId', renderer), null);
    assert.equal(elements['btn-create-project'].disabled, false);
    assert.equal(elements['btn-cancel-project'].disabled, false);
    if (typedError === 'max_projects_reached') {
      assert.equal(elements['toast-message'].textContent, 'Maximum projects reached. Package or delete a project first.');
    } else {
      assert.match(elements['figma-section-error'].textContent, figmaMessagePattern);
      assert.equal(elements['project-creation-status'].textContent, '');
    }
  });
}

for (const typedError of ['future_typed_error', '']) {
  test(`unknown project creation error ${typedError || 'empty-string'} fails closed`, async () => {
    const { document, elements } = createInteractiveRendererDom();
    let createCalls = 0;
    const renderer = loadRendererHelpers(document, {
      crate: {
        createProject: async () => {
          createCalls += 1;
          return { error: typedError };
        },
        getProjects: async () => [],
      },
    });
    renderer.setupEventListeners();
    elements['input-project-name'].value = 'Unknown result';

    await renderer.createProject();

    assert.equal(createCalls, 1);
    assert.equal(vm.runInContext('projectCreationPhase', renderer), 'unresolved');
    assert.equal(vm.runInContext('state.selectedProjectId', renderer), null);
    assert.equal(elements['btn-create-project'].disabled, true);
    assert.equal(elements['btn-create-project'].textContent, 'Restart Crate to continue');
    assert.match(elements['project-creation-status'].textContent, /could not verify which project started/);

    elements['input-project-name'].dispatchEvent({
      type: 'keydown',
      key: 'Enter',
      preventDefault: () => {},
    });
    elements['btn-create-project'].click();
    assert.equal(createCalls, 1);
  });
}

for (const eventRoute of ['files', 'project', 'pending', 'package']) {
  test(`${eventRoute} project-list read started before creation cannot overwrite the created project`, async () => {
    const { document } = createInteractiveRendererDom();
    const staleRead = createDeferred();
    const createdProject = {
      id: `created-${eventRoute}`,
      name: `Created ${eventRoute}`,
      status: 'watching',
      files: [],
    };
    const handlers = {};
    const noOp = () => {};
    let projectReads = 0;
    const renderer = loadRendererHelpers(document, { crate: {
      createProject: async () => createdProject,
      getProjects: async () => {
        projectReads += 1;
        if (projectReads === 1) return staleRead.promise;
        return [createdProject];
      },
      onFilesUpdated: handler => { handlers.files = handler; },
      onProjectUpdated: handler => { handlers.project = handler; },
      onPendingFilesUpdated: handler => { handlers.pending = handler; },
      onPackageTrigger: handler => { handlers.package = handler; },
      onFigmaAuthError: noOp,
      onFigmaScanStarted: noOp,
      onFigmaScanComplete: noOp,
      onFigmaScanError: noOp,
    } });
    renderer.setupMainProcessListeners();
    document.querySelector('#input-project-name').value = createdProject.name;

    const eventResult = handlers[eventRoute]({ projectId: createdProject.id });
    await renderer.createProject();
    assert.equal(vm.runInContext('state.selectedProjectId', renderer), createdProject.id);

    staleRead.resolve([]);
    if (eventResult && typeof eventResult.then === 'function') await eventResult;
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(
      JSON.parse(vm.runInContext('JSON.stringify(state.projects.map(project => project.id))', renderer)),
      [createdProject.id]
    );
    assert.equal(vm.runInContext('state.selectedProjectId', renderer), createdProject.id);
  });
}

for (const eventRoute of ['files', 'project', 'pending', 'package']) {
  test(`${eventRoute} project-list read cannot hide terminal project-creation recovery`, async () => {
    const { document, elements } = createInteractiveRendererDom();
    const staleRead = createDeferred();
    const handlers = {};
    const noOp = () => {};
    let projectReads = 0;
    const renderer = loadRendererHelpers(document, { crate: {
      createProject: async () => null,
      getProjects: async () => {
        projectReads += 1;
        if (projectReads === 1) return staleRead.promise;
        return [];
      },
      onFilesUpdated: handler => { handlers.files = handler; },
      onProjectUpdated: handler => { handlers.project = handler; },
      onPendingFilesUpdated: handler => { handlers.pending = handler; },
      onPackageTrigger: handler => { handlers.package = handler; },
      onFigmaAuthError: noOp,
      onFigmaScanStarted: noOp,
      onFigmaScanComplete: noOp,
      onFigmaScanError: noOp,
    } });
    renderer.setupMainProcessListeners();
    renderer.showNewProjectForm();
    document.querySelector('#input-project-name').value = `Unresolved ${eventRoute}`;

    const eventResult = handlers[eventRoute]({ projectId: `unresolved-${eventRoute}` });
    await renderer.createProject();
    assert.equal(vm.runInContext('projectCreationPhase', renderer), 'unresolved');

    staleRead.resolve([{ id: 'stale-project', name: 'Stale', status: 'watching', files: [] }]);
    if (eventResult && typeof eventResult.then === 'function') await eventResult;
    await new Promise(resolve => setImmediate(resolve));
    renderer.renderProjects();

    assert.equal(vm.runInContext('projectCreationPhase', renderer), 'unresolved');
    assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(state.projects)', renderer)), []);
    assert.equal(elements['new-project-form'].classList.contains('hidden'), false);
    assert.equal(elements['projects-list'].classList.contains('hidden'), true);
    assert.equal(elements['btn-create-project'].textContent, 'Restart Crate to continue');
    assert.match(elements['project-creation-status'].textContent, /Restart Crate before trying again/);
  });
}

test('renderer security policy permits only local and bounded data URL file visuals', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] || '';

  assert.match(policy, /default-src 'self';/);
  assert.match(policy, /img-src 'self' data:;/);
  assert.equal(/(?:script-src|connect-src)[^;]*data:/.test(policy), false);
});

test('responsive shell keeps navigation aligned and Settings surface scroll-complete', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

  assert.match(css, /#tab-settings\.active\s*\{(?=[^}]*min-width:\s*800px;)(?=[^}]*grid-template-columns:\s*minmax\(300px, 0\.8fr\)\s+minmax\(420px, 1\.2fr\);)[^}]*\}/);
  assert.match(css, /@media \(max-width:\s*760px\)[\s\S]*\.app-sidebar\s*\{(?=[^}]*display:\s*grid;)(?=[^}]*grid-template-columns:\s*minmax\(0, 1fr\)\s+auto;)(?=[^}]*"brand brand"\s*"primary support";)[^}]*\}/);
  assert.match(css, /\.app-tabs,\s*\.app-tabs-secondary\s*\{(?=[^}]*flex-direction:\s*row;)(?=[^}]*flex-wrap:\s*nowrap;)[^}]*\}/);
  assert.match(css, /\.app-sidebar\s*>\s*\.app-tabs:not\(\.app-tabs-secondary\)\s*\{(?=[^}]*grid-area:\s*primary;)[^}]*\}/);
  assert.match(css, /\.app-sidebar\s*>\s*\.app-tabs-secondary\s*\{(?=[^}]*grid-area:\s*support;)(?=[^}]*margin-top:\s*0;)[^}]*\}/);
  assert.match(css, /@media \(max-width:\s*760px\)[\s\S]*#tab-settings\.active\s*\{(?=[^}]*min-width:\s*0;)(?=[^}]*grid-template-columns:\s*1fr;)[^}]*\}/);
  assert.match(css, /\.project-dashboard,\s*\.asset-review-workspace\s*\{[^}]*min-width:\s*640px;/);
  assert.match(css, /@media \(max-width:\s*760px\)[\s\S]*#tab-current-project\.active\s*\{[^}]*min-width:\s*680px;/);
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

test('notification Package Review Change Selection activates Current Project and opens Review Assets', async () => {
  const { document, elements, tabs } = createInteractiveRendererDom();
  const project = {
    id: 'package-review-change-selection',
    name: 'Package Review Change Selection',
    type: 'branding',
    status: 'watching',
    files: [{ name: 'Selection.ai', ext: '.ai', projectRole: 'source', protectedSource: true }],
  };
  const review = {
    token: '00000000-0000-4000-8000-000000000302',
    projectId: project.id,
    files: project.files,
    totalFiles: 1,
    materializable: true,
  };
  let packageTrigger;
  const noOp = () => {};
  const renderer = loadRendererHelpers(document, { crate: {
    preScanSession: async () => ({ success: true }),
    preparePackageReview: async () => review,
    getProjects: async () => [project],
    onFilesUpdated: noOp,
    onProjectUpdated: noOp,
    onPendingFilesUpdated: noOp,
    onPackageTrigger: handler => { packageTrigger = handler; },
    onFigmaAuthError: noOp,
    onFigmaScanStarted: noOp,
    onFigmaScanComplete: noOp,
    onFigmaScanError: noOp,
  } });
  renderer.testProject = project;
  vm.runInContext(`
    state.projects = [testProject];
    state.selectedProjectId = testProject.id;
    state.settings = { namingTemplate: '{Project}_{Date}' };
  `, renderer);
  renderer.setupEventListeners();
  renderer.setupMainProcessListeners();
  const assetReviewWorkspace = document.querySelector('#asset-review-workspace');
  const projectDashboard = document.querySelector('#project-dashboard');
  const assetReviewHeading = document.querySelector('#asset-review-heading');
  assetReviewWorkspace.classList.add('hidden');
  tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.tab === 'settings'));
  document.querySelector('#tab-projects').classList.remove('active');
  document.querySelector('#tab-settings').classList.add('active');
  document.querySelector('#tab-current-project').classList.remove('active');

  await packageTrigger({ projectId: project.id });
  assert.equal(elements['modal-package'].classList.contains('hidden'), false);
  assert.equal(assetReviewWorkspace.classList.contains('hidden'), true);

  elements['btn-cancel-package'].click();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(elements['modal-package'].classList.contains('hidden'), true);
  assert.equal(tabs.find(tab => tab.dataset.tab === 'current-project').classList.contains('active'), true);
  assert.equal(tabs.find(tab => tab.dataset.tab === 'settings').classList.contains('active'), false);
  assert.equal(document.querySelector('#tab-current-project').classList.contains('active'), true);
  assert.equal(document.querySelector('#tab-settings').classList.contains('active'), false);
  assert.equal(projectDashboard.classList.contains('hidden'), true);
  assert.equal(assetReviewWorkspace.classList.contains('hidden'), false);
  assert.equal(document.activeElement, assetReviewHeading);
  assert.equal(vm.runInContext('state.packageReviewToken', renderer), null);
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

test('renderer coalesces a synchronous file-event burst into one visible refresh', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const deferred = createDeferred();
  const handlers = {};
  const project = { id: 'burst-project', name: 'Burst', status: 'watching', files: [] };
  let projectReads = 0;
  const noOp = () => {};
  const renderer = loadRendererHelpers(document, { crate: {
    getProjects: () => {
      projectReads += 1;
      return deferred.promise;
    },
    onFilesUpdated: handler => { handlers.files = handler; },
    onProjectUpdated: handler => { handlers.project = handler; },
    onPendingFilesUpdated: handler => { handlers.pending = handler; },
    onPackageTrigger: handler => { handlers.package = handler; },
    onFigmaAuthError: noOp,
    onFigmaScanStarted: noOp,
    onFigmaScanComplete: noOp,
    onFigmaScanError: noOp,
  } });
  vm.runInContext('state.projects = [];', renderer);
  renderer.setupMainProcessListeners();

  for (let index = 0; index < 10; index += 1) handlers.files({ projectId: project.id });
  assert.equal(projectReads, 1);

  deferred.resolve([project]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(projectReads, 1);
  assert.equal(elements['project-rows'].children.length, 1);
});

test('renderer reconciles unchanged asset rows and restores Review Assets view state', async () => {
  const { document, elements } = createInteractiveRendererDom();
  elements['asset-review-search'].id = 'asset-review-search';
  const assets = index => ({
    name: `Synthetic_${index}.png`,
    ext: '.png',
    appFamily: 'figma',
    assetOrigin: 'added',
    projectRole: 'asset',
    visualIdentity: `visual-${index}`,
    visualRevision: `revision-${index}`,
  });
  const project = {
    id: 'identity-project',
    name: 'Identity Project',
    status: 'watching',
    files: [assets(1), assets(2), assets(3)],
    pendingFiles: [],
    excludedAssetKeys: [],
  };
  let workspace = { projectId: project.id, files: project.files, pendingFiles: [] };
  const renderer = loadRendererHelpers(document, {
    crate: {
      getAssetWorkspace: async () => workspace,
    },
  });
  vm.runInContext(`state.projects = [${JSON.stringify(project)}]; state.selectedProjectId = '${project.id}'; state.assetReviewOpen = true; state.assetReviewFilter = 'added'; state.assetReviewQuery = 'Synthetic';`, renderer);
  document.querySelector('#tab-projects').classList.remove('active');
  document.querySelector('#tab-current-project').classList.add('active');
  await renderer.renderFiles();

  const firstRow = elements['added-assets-list'].children[0];
  const firstVisual = firstRow.children[0];
  elements['app-content'].scrollTop = 317;
  elements['asset-review-search'].value = 'Synthetic';
  elements['asset-review-search'].focus();

  const updatedProject = JSON.parse(JSON.stringify(project));
  updatedProject.files[1].name = 'Synthetic_2_Updated.png';
  updatedProject.files[1].visualRevision = 'revision-2-updated';
  updatedProject.files.push(assets(4));
  workspace = { projectId: project.id, files: updatedProject.files, pendingFiles: [] };
  vm.runInContext(`state.projects = [${JSON.stringify(updatedProject)}]`, renderer);
  await renderer.renderFiles();

  assert.equal(elements['added-assets-list'].children.length, 4);
  assert.equal(elements['added-assets-list'].children[0], firstRow);
  assert.equal(elements['added-assets-list'].children[0].children[0], firstVisual);
  assert.notEqual(elements['added-assets-list'].children[1], firstRow);
  assert.equal(elements['app-content'].scrollTop, 317);
  assert.equal(document.activeElement, elements['asset-review-search']);
  assert.equal(vm.runInContext('state.assetReviewOpen', renderer), true);
  assert.equal(vm.runInContext('state.assetReviewFilter', renderer), 'added');
  assert.equal(vm.runInContext('state.assetReviewQuery', renderer), 'Synthetic');
});

test('renderer acknowledges Add Files immediately and suppresses duplicate in-flight actions', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const deferred = createDeferred();
  let addCalls = 0;
  const renderer = loadRendererHelpers(document, {
    crate: {
      addFiles: () => {
        addCalls += 1;
        return deferred.promise;
      },
    },
  });
  vm.runInContext("state.selectedProjectId = 'action-project'; state.projects = [{ id: 'action-project', name: 'Action Project', status: 'watching', files: [] }];", renderer);
  renderer.setupEventListeners();

  const event = { type: 'click', currentTarget: elements['btn-add-files'] };
  elements['btn-add-files'].dispatchEvent(event);
  elements['btn-add-files'].dispatchEvent(event);

  assert.equal(addCalls, 1);
  assert.equal(elements['btn-add-files'].disabled, true);
  assert.equal(elements['btn-add-files'].textContent, 'Adding…');
  assert.equal(elements['btn-add-files'].getAttribute('aria-busy'), 'true');

  deferred.resolve(null);
  await deferred.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements['btn-add-files'].disabled, false);
  assert.equal(elements['btn-add-files'].textContent, '+ Add Files');
  assert.equal(elements['btn-add-files'].getAttribute('aria-busy'), 'false');
});

test('renderer reports a partial Add Files scan failure and clears busy state', async () => {
  const { document, elements } = createInteractiveRendererDom();
  let addCalls = 0;
  const project = { id: 'partial-add-project', name: 'Partial Add Project', status: 'watching', files: [], pendingFiles: [] };
  const renderer = loadRendererHelpers(document, {
    crate: {
      addFiles: async () => {
        addCalls += 1;
        return {
          success: false,
          error: 'add_files_partial_scan_failure',
          failedCount: 1,
          files: [],
        };
      },
      getProjects: async () => [project],
      getAssetWorkspace: async () => ({ projectId: project.id, files: [], pendingFiles: [] }),
    },
  });
  vm.runInContext("state.selectedProjectId = 'partial-add-project'; state.projects = [{ id: 'partial-add-project', name: 'Partial Add Project', status: 'watching', files: [], pendingFiles: [] }];", renderer);
  renderer.setupEventListeners();

  elements['btn-add-files'].click();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(addCalls, 1);
  assert.equal(elements['toast-message'].textContent, '1 file could not be scanned. Successful files were kept.');
  assert.equal(elements['btn-add-files'].disabled, false);
  assert.equal(elements['btn-add-files'].textContent, '+ Add Files');
  assert.equal(elements['btn-add-files'].getAttribute('aria-busy'), 'false');
});

test('renderer clears Add Files busy state after an IPC error', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const renderer = loadRendererHelpers(document, {
    crate: {
      addFiles: async () => { throw new Error('synthetic Add Files error'); },
    },
  });
  vm.runInContext("state.selectedProjectId = 'error-add-project'; state.projects = [{ id: 'error-add-project', name: 'Error Add Project', status: 'watching', files: [], pendingFiles: [] }];", renderer);
  renderer.setupEventListeners();

  elements['btn-add-files'].click();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(elements['toast-message'].textContent, 'Crate could not add files. Try again.');
  assert.equal(elements['btn-add-files'].disabled, false);
  assert.equal(elements['btn-add-files'].textContent, '+ Add Files');
  assert.equal(elements['btn-add-files'].getAttribute('aria-busy'), 'false');
});

test('renderer acknowledges Start Watching immediately and suppresses duplicate toggles', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const deferred = createDeferred();
  let startCalls = 0;
  const project = { id: 'watch-action-project', name: 'Watch Action Project', status: 'paused', files: [] };
  const renderer = loadRendererHelpers(document, {
    crate: {
      startWatching: () => {
        startCalls += 1;
        return deferred.promise;
      },
      getProjects: async () => [project],
    },
  });
  vm.runInContext(`state.projects = [${JSON.stringify(project)}]`, renderer);
  renderer.renderProjects();
  const pill = elements['project-rows'].children[0].querySelector('.project-pill');

  pill.click();
  pill.click();

  assert.equal(startCalls, 1);
  assert.equal(pill.disabled, true);
  assert.equal(pill.textContent, 'Starting…');
  assert.equal(pill.getAttribute('aria-busy'), 'true');

  deferred.resolve();
  await deferred.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pill.disabled, false);
  assert.equal(pill.textContent, 'Start Watching');
  assert.equal(pill.getAttribute('aria-busy'), 'false');
});

test('renderer acknowledges Figma Scan Now immediately and suppresses duplicate scans', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const deferred = createDeferred();
  let scanCalls = 0;
  const renderer = loadRendererHelpers(document, {
    crate: {
      figmaScanNow: () => {
        scanCalls += 1;
        return deferred.promise;
      },
    },
  });
  renderer.setupEventListeners();

  elements['btn-figma-scan-now'].click();
  elements['btn-figma-scan-now'].click();

  assert.equal(scanCalls, 1);
  assert.equal(elements['btn-figma-scan-now'].disabled, true);
  assert.equal(elements['btn-figma-scan-now'].textContent, 'Scanning...');
  assert.equal(elements['btn-figma-scan-now'].getAttribute('aria-busy'), 'true');

  deferred.resolve({ triggered: 1 });
  await deferred.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements['btn-figma-scan-now'].disabled, false);
  assert.equal(elements['btn-figma-scan-now'].textContent, 'Scan Now');
  assert.equal(elements['btn-figma-scan-now'].getAttribute('aria-busy'), 'false');
});

test('renderer acknowledges Package Review immediately and keeps its empty status box dimension-stable', async () => {
  const { document, elements } = createInteractiveRendererDom();
  const deferred = createDeferred();
  let prepareCalls = 0;
  const project = {
    id: 'package-action-project',
    name: 'Package Action Project',
    status: 'watching',
    files: [{ name: 'Synthetic.png', ext: '.png', assetOrigin: 'added', projectRole: 'asset' }],
    pendingFiles: [],
    excludedAssetKeys: [],
  };
  const review = {
    token: '00000000-0000-4000-8000-000000000201',
    projectId: project.id,
    files: project.files,
    totalFiles: 1,
    folderName: 'Package Action Project',
  };
  const scheduleTimeout = setTimeout;
  const renderer = loadRendererHelpers(document, {
    crate: {
      preScanSession: async () => null,
      preparePackageReview: () => {
        prepareCalls += 1;
        return deferred.promise;
      },
      getProjects: async () => [project],
    },
  }, {
    setTimeout: (...args) => {
      const timer = scheduleTimeout(...args);
      timer.unref?.();
      return timer;
    },
  });
  vm.runInContext(`state.selectedProjectId = '${project.id}'; state.projects = [${JSON.stringify(project)}];`, renderer);
  renderer.setupEventListeners();

  const event = { type: 'click', currentTarget: elements['btn-package'] };
  elements['btn-package'].dispatchEvent(event);
  elements['btn-package'].dispatchEvent(event);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(prepareCalls, 1);
  assert.equal(elements['btn-package'].disabled, true);
  assert.equal(elements['btn-package'].textContent, 'Preparing…');
  assert.equal(elements['btn-package'].getAttribute('aria-busy'), 'true');

  deferred.resolve(review);
  await deferred.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements['btn-package'].disabled, false);
  assert.equal(elements['btn-package'].textContent, 'Package Project');
  assert.equal(elements['btn-package'].getAttribute('aria-busy'), 'false');

  const message = elements['modal-package-review-message'];
  assert.equal(message.classList.contains('hidden'), false);
  assert.equal(message.classList.contains('is-empty'), true);
});

test('renderer schedules visible preview work before lower-priority offscreen work', async () => {
  const calls = [];
  const renderer = loadRendererHelpers(createInteractiveRendererDom().document, {
    crate: {
      getFileVisual: async (...args) => {
        calls.push(args);
        return { kind: 'fallback' };
      },
    },
  });

  const offscreen = renderer.requestFileVisual('preview-project', 'offscreen', 'rev-offscreen', 10);
  const visible = renderer.requestFileVisual('preview-project', 'visible', 'rev-visible', 0);
  const nearby = renderer.requestFileVisual('preview-project', 'nearby', 'rev-nearby', 5);
  await Promise.all([offscreen, visible, nearby]);

  assert.deepEqual(calls.map(call => call[1]), ['visible', 'nearby', 'offscreen']);
});
