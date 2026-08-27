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

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('desktop minimum bootstrap loads before the real BrowserWindow is constructed', () => {
  const contractImport = mainSource.indexOf("require('./startup-phase-journal')");
  const browserWindowConstruction = mainSource.indexOf('new BrowserWindow({');

  assert.notEqual(contractImport, -1);
  assert.notEqual(browserWindowConstruction, -1);
  assert.ok(
    contractImport < browserWindowConstruction,
    'desktop minimum bootstrap must load before the main BrowserWindow is constructed',
  );
  assert.deepEqual(DESKTOP_WINDOW_MINIMUM, { width: 1100, height: 760 });
});

test('real BrowserWindow construction carries the authoritative desktop minimum', () => {
  const browserWindowConstruction = mainSource.indexOf('new BrowserWindow({');
  const browserWindowSource = mainSource.slice(browserWindowConstruction, browserWindowConstruction + 1400);

  assert.match(browserWindowSource, /width:\s*DESKTOP_WINDOW_MINIMUM\.width/);
  assert.match(browserWindowSource, /height:\s*DESKTOP_WINDOW_MINIMUM\.height/);
  assert.match(browserWindowSource, /minWidth:\s*DESKTOP_WINDOW_MINIMUM\.width/);
  assert.match(browserWindowSource, /minHeight:\s*DESKTOP_WINDOW_MINIMUM\.height/);
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
