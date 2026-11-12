'use strict';

// Minimal real-browser driver for the production renderer: Chrome over a
// private --remote-debugging-pipe, the real index.html/styles.css/app.js and a
// synthetic in-page bridge. It sends real keyboard and mouse input through
// CDP, so focus, Tab order and native button activation are the browser's.
// No Crate data, network, or private paths are used; the profile is temporary.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const ciChrome = require('../scripts/ci-chrome');

function findBrowser() {
  const pinned = ciChrome.pinnedBrowser();
  if (pinned) return pinned;
  for (const candidate of [process.env.CRATE_UI_TEST_BROWSER, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (candidate && path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function productionPage(rendererDir, bootstrapSource) {
  const index = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const html = index
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]+>/u, '')
    .replace(/<link[^>]+https:\/\/fonts\.googleapis\.com[^>]+>/u, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, '')
    .replace('<head>', `<head><base href="${new URL(`file://${rendererDir}/`).href}">`);
  const cut = html.lastIndexOf('</body>');
  return html.slice(0, cut) +
    '<script src="app.js"></script><script>document.removeEventListener("DOMContentLoaded", init);\n' +
    bootstrapSource + '\nwindow.__pageReady = true;</script></body></html>';
}

async function launch({ browser, rendererDir, bootstrapSource, width = 1100, height = 760 }) {
  const pinned = process.env.CRATE_UI_TEST_BROWSER_PIN === '1' && browser === process.env.CRATE_UI_TEST_BROWSER;
  if (pinned) ciChrome.verifyIdentity(browser);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-asset-controls-'));
  const page = path.join(directory, 'fixture.html');
  fs.writeFileSync(page, productionPage(rendererDir, bootstrapSource));
  const child = childProcess.spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--allow-file-access-from-files',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    `--user-data-dir=${path.join(directory, 'profile')}`, `--window-size=${width},${height}`,
    '--remote-debugging-pipe', new URL('file://' + page).href,
  ], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  let nextId = 0, buffer = '', exited = false;
  const pending = new Map();
  child.on('exit', () => {
    exited = true;
    for (const { reject } of pending.values()) reject(new Error('browser exited'));
    pending.clear();
  });
  child.stdio[4].on('data', chunk => {
    buffer += chunk.toString('utf8');
    let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const waiter = message.id !== undefined && pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
      else waiter.resolve(message.result);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (exited) { reject(new Error('browser exited')); return; }
    const id = ++nextId;
    pending.set(id, { resolve, reject, method });
    child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function close() {
    try { await Promise.race([send('Browser.close'), sleep(3000)]); } catch (_) {}
    const deadline = Date.now() + 5000;
    while (!exited && Date.now() < deadline) await sleep(50);
    if (!exited) { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {} await sleep(200); }
    if (pinned) ciChrome.verifyIdentity(browser);
    fs.rmSync(directory, { recursive: true, force: true });
  }
  try {
    let target;
    for (let attempt = 0; attempt < 100 && !target; attempt += 1) {
      const { targetInfos } = await send('Target.getTargets');
      target = targetInfos.find(info => info.type === 'page' && info.url.startsWith('file://'));
      if (!target) await sleep(50);
    }
    if (!target) throw new Error('page target unavailable');
    const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const call = (method, params) => send(method, params, sessionId);
    async function evaluate(expression) {
      const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) {
        throw new Error(`page: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
      }
      return result.result.value;
    }
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await evaluate('window.__pageReady === true && document.readyState === "complete"').catch(() => false)) break;
      await sleep(50);
    }
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const keys = {
      Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
      Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
      Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
    };
    async function press(name, modifiers = 0) {
      const key = keys[name];
      await call('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, ...key });
      await call('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: key.key, code: key.code, windowsVirtualKeyCode: key.windowsVirtualKeyCode });
    }
    async function clickAt(x, y, clickCount = 1) {
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount });
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount });
    }
    async function moveAway() { await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 }); }
    async function screenshot(file) {
      const { data } = await call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
    }
    async function setViewport(nextWidth, nextHeight) {
      await call('Emulation.setDeviceMetricsOverride', { width: nextWidth, height: nextHeight, deviceScaleFactor: 1, mobile: false });
    }
    return { evaluate, press, clickAt, moveAway, screenshot, setViewport, close, sleep };
  } catch (error) {
    await close();
    throw error;
  }
}

module.exports = { findBrowser, launch };
