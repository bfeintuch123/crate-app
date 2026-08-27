'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX_PATH = path.join(ROOT, 'renderer', 'index.html');
const indexHtml = fs.readFileSync(INDEX_PATH, 'utf8');

function getPhaseCScript() {
  const match = indexHtml.match(
    /<script src="app\.js"><\/script>\s*<script>([\s\S]*?)<\/script>\s*<\/body>/u,
  );
  assert.ok(match, 'renderer/index.html must load the source-bound Phase C script after app.js');
  return match[1];
}

function createClassList(element, initial = []) {
  const classes = new Set(initial);
  const notify = () => {
    for (const observer of element._classObservers || []) observer();
  };
  return {
    add: (...names) => {
      let changed = false;
      for (const name of names) {
        if (!classes.has(name)) changed = true;
        classes.add(name);
      }
      if (changed) notify();
    },
    remove: (...names) => {
      let changed = false;
      for (const name of names) changed = classes.delete(name) || changed;
      if (changed) notify();
    },
    contains: name => classes.has(name),
    toggle: (name, force) => {
      const shouldAdd = force === undefined ? !classes.has(name) : Boolean(force);
      if (shouldAdd) classes.add(name);
      else classes.delete(name);
      notify();
      return shouldAdd;
    },
  };
}

function createElement(id, document, { classes = [], focusable = false } = {}) {
  const attributes = new Map();
  const listeners = new Map();
  const element = {
    id,
    ownerDocument: document,
    disabled: false,
    inert: false,
    isConnected: true,
    _classObservers: [],
    _focusable: [],
    classList: null,
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: name => attributes.get(name) ?? null,
    removeAttribute: name => attributes.delete(name),
    addEventListener: (type, listener) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    removeEventListener: (type, listener) => {
      listeners.set(type, (listeners.get(type) || []).filter(item => item !== listener));
    },
    dispatchEvent: event => {
      for (const listener of listeners.get(event.type) || []) listener(event);
    },
    focus: () => { document.activeElement = element; },
    click: () => element.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} }),
    contains: candidate => candidate === element || element._focusable.includes(candidate),
    querySelectorAll: () => element._focusable,
  };
  element.classList = createClassList(element, classes);
  if (focusable) element.tabIndex = 0;
  return element;
}

function createPhaseCDom() {
  const elements = new Map();
  const document = {
    readyState: 'complete',
    activeElement: null,
    getElementById: id => elements.get(id) || null,
    querySelector: selector => {
      const tabMatch = selector.match(/^\.app-tab\[data-tab="([^"]+)"\]$/u);
      if (tabMatch) return elements.get(`tab-${tabMatch[1]}`) || null;
      if (selector.startsWith('#')) return elements.get(selector.slice(1)) || null;
      return null;
    },
    querySelectorAll: selector => {
      if (selector === '.modal-overlay') {
        return [...elements.values()].filter(element => element.isModal === true);
      }
      return [];
    },
    addEventListener() {},
  };

  const add = (id, options) => {
    const element = createElement(id, document, options);
    elements.set(id, element);
    return element;
  };

  add('app-sidebar');
  add('app-main');
  add('tab-projects', { focusable: true });
  add('tab-current-project', { focusable: true });
  add('tab-quick-package', { focusable: true });
  add('btn-clear-all', { focusable: true });
  add('files-figma-scope', { focusable: true });
  add('btn-v2-browse', { focusable: true });

  const configs = [
    ['modal-delete-confirm', 'btn-delete-cancel', 'btn-delete-confirm'],
    ['modal-clear-all', 'btn-clear-all-cancel', 'btn-clear-all-confirm'],
    ['modal-edit-figma-link', 'edit-figma-url', 'btn-edit-figma-cancel'],
    ['modal-v2-results', 'btn-v2-done', 'btn-v2-open-folder'],
  ];
  for (const [modalId, firstId, secondId] of configs) {
    const modal = add(modalId, { classes: ['modal-overlay', 'hidden'] });
    modal.isModal = true;
    const first = add(firstId, { focusable: true });
    const second = add(secondId, { focusable: true });
    modal._focusable = [first, second];
    if (modalId === 'modal-edit-figma-link') {
      const removeLink = add('btn-edit-figma-remove', { classes: ['hidden'], focusable: true });
      modal._focusable.push(removeLink);
    }
  }

  for (const [modalId, closeId] of [
    ['modal-delete-confirm', 'btn-delete-cancel'],
    ['modal-clear-all', 'btn-clear-all-cancel'],
    ['modal-edit-figma-link', 'btn-edit-figma-cancel'],
    ['modal-v2-results', 'btn-v2-done'],
  ]) {
    elements.get(closeId).addEventListener('click', () => {
      elements.get(modalId).classList.add('hidden');
    });
  }

  document.activeElement = elements.get('tab-projects');
  return { document, elements };
}

class MutationObserverStub {
  constructor(callback) {
    this.callback = callback;
  }

  observe(target) {
    target._classObservers.push(this.callback);
  }

  disconnect() {}
}

test('Phase C inline script is source-bound by its exact CSP hash', () => {
  const script = getPhaseCScript();
  const digest = crypto.createHash('sha256').update(script).digest('base64');
  assert.match(
    indexHtml,
    new RegExp(`script-src 'self' 'sha256-${digest.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}'`, 'u'),
  );
  assert.doesNotMatch(indexHtml, /script-src[^;]*'unsafe-inline'/u);
});

test('secondary overlays expose complete dialog names and descriptions', () => {
  for (const contract of [
    ['modal-delete-confirm', 'delete-confirm-title', 'delete-confirm-desc'],
    ['modal-clear-all', 'clear-all-title', 'clear-all-desc'],
    ['modal-edit-figma-link', 'edit-figma-title', 'edit-figma-subtitle'],
    ['modal-v2-results', 'v2-result-title', 'v2-result-subtitle'],
  ]) {
    const [id, label, description] = contract;
    assert.match(
      indexHtml,
      new RegExp(
        `id="${id}"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="${label}"[^>]*aria-describedby="${description}"[^>]*tabindex="-1"`,
        'u',
      ),
    );
  }
});

test('secondary dialog controller traps focus, closes on Escape, and restores its opener', () => {
  const script = getPhaseCScript();
  const { document, elements } = createPhaseCDom();
  const context = {
    document,
    MutationObserver: MutationObserverStub,
    Map,
  };
  vm.createContext(context);
  vm.runInContext(script, context, { filename: 'renderer/index.html#phase-c-dialogs' });

  const opener = elements.get('tab-projects');
  const modal = elements.get('modal-delete-confirm');
  const cancel = elements.get('btn-delete-cancel');
  const confirm = elements.get('btn-delete-confirm');

  opener.focus();
  modal.classList.remove('hidden');
  assert.equal(document.activeElement, cancel);
  assert.equal(elements.get('app-sidebar').inert, true);
  assert.equal(elements.get('app-main').getAttribute('aria-hidden'), 'true');

  confirm.focus();
  let tabPrevented = false;
  modal.dispatchEvent({
    type: 'keydown',
    key: 'Tab',
    shiftKey: false,
    preventDefault: () => { tabPrevented = true; },
  });
  assert.equal(tabPrevented, true);
  assert.equal(document.activeElement, cancel);

  let escapePrevented = false;
  modal.dispatchEvent({
    type: 'keydown',
    key: 'Escape',
    shiftKey: false,
    preventDefault: () => { escapePrevented = true; },
  });
  assert.equal(escapePrevented, true);
  assert.equal(modal.classList.contains('hidden'), true);
  assert.equal(elements.get('app-sidebar').inert, false);
  assert.equal(elements.get('app-main').getAttribute('aria-hidden'), null);
  assert.equal(document.activeElement, opener);
});

test('Edit Figma no-link modal excludes its hidden Remove Link control from the focus trap', () => {
  const script = getPhaseCScript();
  const { document, elements } = createPhaseCDom();
  const context = { document, MutationObserver: MutationObserverStub, Map };
  vm.createContext(context);
  vm.runInContext(script, context, { filename: 'renderer/index.html#phase-c-dialogs-hidden-remove' });

  const opener = elements.get('tab-current-project');
  const modal = elements.get('modal-edit-figma-link');
  const url = elements.get('edit-figma-url');
  const cancel = elements.get('btn-edit-figma-cancel');
  const removeLink = elements.get('btn-edit-figma-remove');

  opener.focus();
  modal.classList.remove('hidden');
  assert.equal(document.activeElement, url);

  url.focus();
  let tabPrevented = false;
  modal.dispatchEvent({
    type: 'keydown',
    key: 'Tab',
    shiftKey: true,
    preventDefault: () => { tabPrevented = true; },
  });
  assert.equal(tabPrevented, true);
  assert.equal(document.activeElement, cancel);
  assert.notEqual(document.activeElement, removeLink);
});

test('secondary dialogs use a visible fallback when a drag/drop or rerender opener is stale', () => {
  const script = getPhaseCScript();
  const { document, elements } = createPhaseCDom();
  const context = { document, MutationObserver: MutationObserverStub, Map };
  vm.createContext(context);
  vm.runInContext(script, context, { filename: 'renderer/index.html#phase-c-dialogs-fallback' });

  const opener = elements.get('tab-quick-package');
  const modal = elements.get('modal-v2-results');
  const done = elements.get('btn-v2-done');
  const browse = elements.get('btn-v2-browse');

  opener.focus();
  modal.classList.remove('hidden');
  opener.isConnected = false;
  done.click();

  assert.equal(modal.classList.contains('hidden'), true);
  assert.equal(document.activeElement, browse);
});

test('Phase C leaves the separately deferred primary navigation order unchanged', () => {
  const projects = indexHtml.indexOf('data-tab="projects"');
  const quickPackage = indexHtml.indexOf('data-tab="quick-package"');
  const workspace = indexHtml.indexOf('data-tab="current-project"');
  assert.ok(projects >= 0 && quickPackage > projects && workspace > quickPackage);
});
