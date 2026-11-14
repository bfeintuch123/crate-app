'use strict';

const test = require('node:test');
const assert = require('./bounded-assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const originalLoad = Module._load;
const journalPath = require.resolve('../startup-phase-journal');
const previousJournalCache = require.cache[journalPath];
const electronModulePath = /[/\\]node_modules[/\\]electron(?:[/\\]|$)/u;
const bootstrapListeners = [];
let startupJournal;

// Same Electron fence as the desktop minimum tests: the journal imports
// Electron during evaluation, so load it against a local stub only.
delete require.cache[journalPath];
try {
  Module._load = function loadWithElectronStub(request, parent, isMain) {
    if (request === 'electron') {
      return { app: { on: (eventName, listener) => bootstrapListeners.push([eventName, listener]) } };
    }
    if (electronModulePath.test(request)) {
      throw new Error('Standard page zoom tests must not load Electron package files');
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  startupJournal = require('../startup-phase-journal');
} finally {
  Module._load = originalLoad;
  if (previousJournalCache) require.cache[journalPath] = previousJournalCache;
  else delete require.cache[journalPath];
}

const {
  applyStandardPageZoom,
  buildStandardApplicationMenuTemplate,
  resetStandardPageZoom,
} = startupJournal;

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const PAGE_ZOOM_ROLES = new Set(['resetzoom', 'zoomin', 'zoomout']);

function flattenMenu(template) {
  const items = [];
  for (const item of template) {
    items.push(item);
    if (Array.isArray(item.submenu)) items.push(...flattenMenu(item.submenu));
  }
  return items;
}

function rolesOf(template) {
  return flattenMenu(template).filter(item => item.role).map(item => item.role);
}

function fakeWebContents({ zoomLevel = 0, destroyed = false, setZoomError = null, limitsResult } = {}) {
  const handlers = new Map();
  const calls = [];
  return {
    calls,
    handlers,
    zoomLevel,
    isDestroyed: () => destroyed,
    on(channel, listener) {
      if (!handlers.has(channel)) handlers.set(channel, []);
      handlers.get(channel).push(listener);
    },
    emit(channel) {
      for (const listener of handlers.get(channel) || []) listener({});
    },
    setZoomLevel(level) {
      calls.push(['setZoomLevel', level]);
      if (setZoomError) throw setZoomError;
      this.zoomLevel = level;
    },
    setVisualZoomLevelLimits(minimum, maximum) {
      calls.push(['setVisualZoomLevelLimits', minimum, maximum]);
      return limitsResult === undefined ? Promise.resolve() : limitsResult;
    },
  };
}

test('macOS application menu has no page zoom items or zoom accelerators', () => {
  const template = buildStandardApplicationMenuTemplate('darwin');
  const roles = rolesOf(template).map(role => role.toLowerCase());

  for (const role of roles) {
    assert.equal(PAGE_ZOOM_ROLES.has(role), false, `menu must not include the ${role} role`);
  }
  for (const item of flattenMenu(template)) {
    assert.equal(item.accelerator, undefined, 'menu items keep Electron role defaults only');
    assert.equal(typeof item.click, 'undefined', 'menu items must not add custom click handlers');
  }
});

test('macOS application menu keeps every other Electron default menu', () => {
  const template = buildStandardApplicationMenuTemplate('darwin');

  assert.deepEqual(template.map(item => item.role || item.label), [
    'appMenu',
    'fileMenu',
    'editMenu',
    'View',
    'windowMenu',
  ]);
  // The full Edit role supplies Undo, Redo, Cut, Copy, Paste, Paste and Match
  // Style, Delete and Select All with their standard shortcuts.
  assert.deepEqual(template[2], { role: 'editMenu' });
  // Electron's default View menu minus Actual Size, Zoom In and Zoom Out.
  assert.deepEqual(template[3], {
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  });
});

test('non-macOS application menu omits only the macOS app menu', () => {
  const template = buildStandardApplicationMenuTemplate('linux');

  assert.deepEqual(template.map(item => item.role || item.label), ['fileMenu', 'editMenu', 'View', 'windowMenu']);
  assert.equal(rolesOf(template).some(role => PAGE_ZOOM_ROLES.has(role.toLowerCase())), false);
});

test('each navigation resets saved page zoom to 100% and keeps pinch zoom disabled', () => {
  const contents = fakeWebContents({ zoomLevel: 2.5 });

  assert.equal(applyStandardPageZoom({ webContents: contents }), true);
  assert.deepEqual(contents.calls, [], 'zoom resets when a page commits, not at window construction');

  contents.emit('did-navigate');
  assert.equal(contents.zoomLevel, 0);
  assert.deepEqual(contents.calls, [
    ['setZoomLevel', 0],
    ['setVisualZoomLevelLimits', 1, 1],
  ]);

  contents.zoomLevel = 1;
  contents.emit('did-navigate');
  assert.equal(contents.zoomLevel, 0, 'reloads and later navigations reset again');
});

test('bootstrap window hook applies the zoom policy to every created window', () => {
  assert.equal(bootstrapListeners.length, 1);
  const [eventName, listener] = bootstrapListeners[0];
  assert.equal(eventName, 'browser-window-created');

  const windowFor = contents => ({
    isDestroyed: () => false,
    setMinimumSize: () => {},
    getSize: () => [1100, 760],
    setSize: () => {},
    webContents: contents,
  });
  const first = fakeWebContents({ zoomLevel: 1.5 });
  const recreated = fakeWebContents({ zoomLevel: 1.5 });
  listener(null, windowFor(first));
  listener(null, windowFor(recreated));

  first.emit('did-navigate');
  recreated.emit('did-navigate');
  assert.equal(first.zoomLevel, 0);
  assert.equal(recreated.zoomLevel, 0, 'a recreated window is reset independently');
});

test('zoom reset tolerates missing, destroyed or failing web contents', async () => {
  assert.equal(applyStandardPageZoom(null), false);
  assert.equal(applyStandardPageZoom({}), false);
  assert.equal(resetStandardPageZoom(null), false);

  const destroyed = fakeWebContents({ destroyed: true });
  assert.equal(resetStandardPageZoom(destroyed), false);
  assert.deepEqual(destroyed.calls, []);

  const failing = fakeWebContents({ setZoomError: new Error('frame not live') });
  assert.equal(resetStandardPageZoom(failing), false);

  let unhandled = null;
  const onUnhandled = reason => { unhandled = reason; };
  process.on('unhandledRejection', onUnhandled);
  try {
    const rejecting = fakeWebContents({ limitsResult: Promise.reject(new Error('renderer gone')) });
    assert.equal(resetStandardPageZoom(rejecting), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(unhandled, null, 'visual zoom limit failures must not surface as unhandled rejections');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('main process installs the zoom-free menu before creating the main window', () => {
  const electronImport = mainSource.slice(0, mainSource.indexOf("} = require('electron');"));
  assert.match(electronImport, /^\s*Menu,$/m, 'main.js must import Menu from electron');
  assert.match(
    mainSource,
    /buildStandardApplicationMenuTemplate,[\s\S]*?\} = require\('\.\/startup-phase-journal'\);/,
  );

  const readyStart = mainSource.indexOf('app.whenReady().then(async () => {');
  const readySource = mainSource.slice(readyStart);
  const menuInstall = readySource.search(
    /Menu\.setApplicationMenu\(\s*Menu\.buildFromTemplate\(\s*buildStandardApplicationMenuTemplate\(\)\s*\)\s*\)/,
  );
  const firstStartupStep = readySource.indexOf('configureFigmaCredentialStorage()');
  const windowCreate = readySource.indexOf('createMainWindow();');
  assert.notEqual(readyStart, -1);
  assert.notEqual(menuInstall, -1, 'ready handler must install the standard application menu');
  assert.notEqual(firstStartupStep, -1);
  assert.notEqual(windowCreate, -1);
  assert.ok(
    menuInstall < firstStartupStep,
    'menu must be installed before other startup steps, so their failures cannot leave the default zoom items',
  );
  assert.ok(menuInstall < windowCreate, 'menu must be installed before the main window is created');
});

test('main process adds no page zoom controls of its own', () => {
  assert.doesNotMatch(mainSource, /role:\s*['"](?:resetZoom|zoomIn|zoomOut)['"]/i);
  assert.doesNotMatch(mainSource, /\bset(?:ZoomLevel|ZoomFactor)\s*\(/);
  assert.doesNotMatch(mainSource, /zoomFactor\s*:/);
});
