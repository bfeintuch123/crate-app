'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const scriptMatch = indexHtml.match(
  /<script src="app\.js"><\/script>\s*<script>([\s\S]*?)<\/script>\s*<\/body>/u,
);
assert.ok(scriptMatch, 'Phase C script must remain source-bound after app.js');
const phaseCScript = scriptMatch[1];

function createRuntimeDom() {
  const elements = new Map();
  let document;

  function notifyAttribute(element, name) {
    let current = element;
    while (current) {
      for (const observer of current._attributeObservers || []) {
        if (current !== element && observer.options.subtree !== true) continue;
        const filter = observer.options.attributeFilter;
        if (!filter || filter.includes(name)) observer.callback();
      }
      current = current.parentNode;
    }
  }

  function createElement(id, classes = []) {
    const attributes = new Map();
    const listeners = new Map();
    const classNames = new Set(classes);
    const element = {
      id,
      parentNode: null,
      children: [],
      disabled: false,
      inert: false,
      isConnected: true,
      textContent: '',
      onclick: null,
      clickCount: 0,
      _attributeObservers: [],
      _childObservers: [],
      classList: {
        add: (...names) => {
          let changed = false;
          for (const name of names) {
            if (!classNames.has(name)) changed = true;
            classNames.add(name);
          }
          if (changed) notifyAttribute(element, 'class');
        },
        remove: (...names) => {
          let changed = false;
          for (const name of names) changed = classNames.delete(name) || changed;
          if (changed) notifyAttribute(element, 'class');
        },
        contains: name => classNames.has(name),
      },
      setAttribute: (name, value) => {
        attributes.set(name, String(value));
        notifyAttribute(element, name);
      },
      getAttribute: name => attributes.get(name) ?? null,
      removeAttribute: name => {
        const changed = attributes.delete(name);
        if (changed) notifyAttribute(element, name);
      },
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
      click: () => {
        element.clickCount += 1;
        element.onclick?.({ preventDefault() {}, stopPropagation() {} });
        element.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} });
      },
      appendChild: child => {
        child.parentNode = element;
        element.children.push(child);
        for (const observer of element._childObservers) observer.callback();
        return child;
      },
      contains: candidate => candidate === element || element.children.some(child => child.contains(candidate)),
      querySelector: selector => {
        if (selector === '.project-info') return element.children.find(child => child.classList.contains('project-info')) || null;
        if (selector === '.project-name') return element.children.find(child => child.classList.contains('project-name')) || null;
        if (selector === '.project-status') return element.children.find(child => child.classList.contains('project-status')) || null;
        if (selector === '.project-pill') return element.children.find(child => child.classList.contains('project-pill')) || null;
        return null;
      },
      querySelectorAll: selector => {
        if (selector === '.project-row') return element.children.filter(child => child.classList.contains('project-row'));
        return element.children;
      },
      closest: selector => {
        if (selector === '.project-pill' && element.classList.contains('project-pill')) return element;
        if (
          selector === '.project-info[role="button"]'
          && element.classList.contains('project-info')
          && element.getAttribute('role') === 'button'
        ) return element;
        return element.parentNode?.closest?.(selector) || null;
      },
    };
    elements.set(id, element);
    return element;
  }

  document = {
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
      if (selector === '.app-tab') return [...elements.values()].filter(element => element.classList.contains('app-tab'));
      if (selector === '.modal-overlay') return [...elements.values()].filter(element => element.classList.contains('modal-overlay'));
      return [];
    },
    addEventListener() {},
  };

  const sidebar = createElement('app-sidebar');
  const main = createElement('app-main');
  const projectsTab = createElement('tab-projects', ['app-tab', 'active']);
  projectsTab.dataset = { tab: 'projects' };
  const workspaceTab = createElement('tab-current-project', ['app-tab']);
  workspaceTab.dataset = { tab: 'current-project' };
  const quickTab = createElement('tab-quick-package', ['app-tab']);
  quickTab.dataset = { tab: 'quick-package' };

  const projectRows = createElement('project-rows');
  const row = createElement('project-row-1', ['project-row']);
  const info = createElement('project-info-1', ['project-info']);
  const name = createElement('project-name-1', ['project-name']);
  name.textContent = 'Synthetic Project';
  const status = createElement('project-status-1', ['project-status']);
  status.textContent = 'Watching';
  const pill = createElement('project-pill-1', ['project-pill']);
  pill.textContent = 'Pause';
  row.appendChild(info);
  row.appendChild(name);
  row.appendChild(status);
  row.appendChild(pill);
  projectRows.appendChild(row);

  const figmaLink = createElement('files-figma-scope', ['figma-link-row']);
  figmaLink.textContent = 'Figma · Current Page Only';
  figmaLink.onclick = () => {};

  for (const [modalId, closeId, initialId] of [
    ['modal-delete-confirm', 'btn-delete-cancel', 'btn-delete-cancel'],
    ['modal-clear-all', 'btn-clear-all-cancel', 'btn-clear-all-cancel'],
    ['modal-edit-figma-link', 'btn-edit-figma-cancel', 'edit-figma-url'],
    ['modal-v2-results', 'btn-v2-done', 'btn-v2-done'],
  ]) {
    const modal = createElement(modalId, ['modal-overlay', 'hidden']);
    const initial = createElement(initialId);
    const close = elements.get(closeId) || createElement(closeId);
    modal.appendChild(initial);
    if (close !== initial) modal.appendChild(close);
    close.addEventListener('click', () => modal.classList.add('hidden'));
  }
  createElement('btn-delete-confirm');
  createElement('btn-clear-all');
  createElement('btn-v2-browse');

  document.activeElement = projectsTab;
  return {
    document,
    elements,
    sidebar,
    main,
    projectsTab,
    workspaceTab,
    quickTab,
    projectRows,
    info,
    pill,
    figmaLink,
  };
}

class MutationObserverStub {
  constructor(callback) {
    this.callback = callback;
  }

  observe(target, options = {}) {
    if (options.attributes) target._attributeObservers.push({ callback: this.callback, options });
    if (options.childList) target._childObservers.push({ callback: this.callback, options });
  }

  disconnect() {}
}

function keyEvent(target, key) {
  let prevented = false;
  return {
    type: 'keydown',
    target,
    key,
    preventDefault: () => { prevented = true; },
    get prevented() { return prevented; },
  };
}

test('Phase C runtime updates navigation state and keyboard-enables dynamic controls', () => {
  const dom = createRuntimeDom();
  const context = {
    document: dom.document,
    MutationObserver: MutationObserverStub,
    Map,
  };
  vm.createContext(context);
  vm.runInContext(phaseCScript, context, { filename: 'renderer/index.html#phase-c-runtime' });

  assert.equal(dom.projectsTab.getAttribute('aria-current'), 'page');
  assert.equal(dom.workspaceTab.getAttribute('aria-current'), null);
  dom.projectsTab.classList.remove('active');
  dom.workspaceTab.classList.add('active');
  assert.equal(dom.projectsTab.getAttribute('aria-current'), null);
  assert.equal(dom.workspaceTab.getAttribute('aria-current'), 'page');

  assert.equal(dom.info.getAttribute('role'), 'button');
  assert.equal(dom.info.getAttribute('tabindex'), '0');
  assert.match(dom.info.getAttribute('aria-label'), /Open Synthetic Project\. Watching/u);
  assert.equal(dom.pill.getAttribute('role'), 'button');
  assert.equal(dom.pill.getAttribute('tabindex'), '0');
  assert.equal(dom.pill.getAttribute('aria-disabled'), 'false');

  const infoEvent = keyEvent(dom.info, 'Enter');
  dom.projectRows.dispatchEvent(infoEvent);
  assert.equal(infoEvent.prevented, true);
  assert.equal(dom.info.clickCount, 1);

  const pillEvent = keyEvent(dom.pill, ' ');
  dom.projectRows.dispatchEvent(pillEvent);
  assert.equal(pillEvent.prevented, true);
  assert.equal(dom.pill.clickCount, 1);

  assert.equal(dom.figmaLink.getAttribute('role'), 'button');
  assert.equal(dom.figmaLink.getAttribute('tabindex'), '0');
  assert.equal(dom.figmaLink.getAttribute('aria-disabled'), 'false');
  const figmaEvent = keyEvent(dom.figmaLink, 'Enter');
  dom.figmaLink.dispatchEvent(figmaEvent);
  assert.equal(figmaEvent.prevented, true);
  assert.equal(dom.figmaLink.clickCount, 1);
});
