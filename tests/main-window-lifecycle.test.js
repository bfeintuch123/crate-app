'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  DESKTOP_WINDOW_MINIMUM,
  applyDesktopWindowMinimum,
  installDesktopWindowMinimum,
} = require('../startup-phase-journal');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function sectionBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('main window close clears singleton before quit prevention', () => {
  const createWindow = sectionBetween(
    'function createMainWindow() {',
    'function recreateMainWindow(reason = \'unknown\') {'
  );
  assert.match(
    createWindow,
    /nextWindow\.on\('closed',\s*\(\)\s*=>\s*\{\s*if\s*\(trayWindow\s*===\s*nextWindow\)\s*trayWindow\s*=\s*null;\s*\}\);/
  );

  const windowAllClosed = sectionBetween(
    "app.on('window-all-closed'",
    "app.on('activate'"
  );
  assert.doesNotMatch(windowAllClosed, /preventDefault/);
  assert.match(windowAllClosed, /if\s*\(process\.platform\s*!==\s*'darwin'\)\s*app\.quit\(\)/);
});

test('createWindow and activate detect stale singleton references', () => {
  const createWindow = sectionBetween(
    'function createMainWindow() {',
    'function recreateMainWindow(reason = \'unknown\') {'
  );
  assert.match(createWindow, /adoptExistingMainWindow\(\)/);
  assert.match(createWindow, /if\s*\(trayWindow\s*&&\s*!trayWindow\.isDestroyed\(\)\)\s*return trayWindow/);

  const activate = source.slice(source.indexOf("app.on('activate'"));
  assert.match(activate, /adoptExistingMainWindow\(\)/);
  assert.match(
    activate,
    /if\s*\(!trayWindow\s*\|\|\s*trayWindow\.isDestroyed\(\)\)\s*recreateMainWindow\('activate'\)/
  );
});

test('desktop minimum bootstrap loads before the real BrowserWindow is constructed', () => {
  const contractImport = source.indexOf("require('./startup-phase-journal')");
  const browserWindowConstruction = source.indexOf('new BrowserWindow({');

  assert.notEqual(contractImport, -1);
  assert.notEqual(browserWindowConstruction, -1);
  assert.ok(
    contractImport < browserWindowConstruction,
    'desktop minimum bootstrap must load before the main BrowserWindow is constructed',
  );
  assert.deepEqual(DESKTOP_WINDOW_MINIMUM, { width: 1100, height: 760 });
});

test('desktop minimum applies native BrowserWindow limits and clamps smaller bounds', () => {
  const calls = [];
  let size = [960, 700];
  const browserWindow = {
    isDestroyed: () => false,
    setMinimumSize: (width, height) => calls.push(['minimum', width, height]),
    getSize: () => size,
    setSize: (width, height, animate) => {
      calls.push(['size', width, height, animate]);
      size = [width, height];
    },
  };

  assert.equal(applyDesktopWindowMinimum(browserWindow), true);
  assert.deepEqual(calls, [
    ['minimum', 1100, 760],
    ['size', 1100, 760, false],
  ]);
  assert.deepEqual(size, [1100, 760]);
});

test('desktop minimum installation is idempotent and applies to created windows', () => {
  const listeners = [];
  const appModule = {
    on(eventName, listener) {
      listeners.push([eventName, listener]);
    },
  };

  assert.equal(installDesktopWindowMinimum(appModule), true);
  assert.equal(installDesktopWindowMinimum(appModule), true);
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0][0], 'browser-window-created');

  const calls = [];
  const browserWindow = {
    isDestroyed: () => false,
    setMinimumSize: (width, height) => calls.push(['minimum', width, height]),
    getSize: () => [1280, 800],
    setSize: (...args) => calls.push(['size', ...args]),
  };
  listeners[0][1](null, browserWindow);

  assert.deepEqual(calls, [['minimum', 1100, 760]]);
});
