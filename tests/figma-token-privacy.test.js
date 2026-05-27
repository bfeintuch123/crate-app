const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

function loadFigmaParserWithHome(homeDir) {
  const parserPath = require.resolve('../parsers/figma');
  const originalLoad = Module._load;
  delete require.cache[parserPath];

  Module._load = function loadWithStubs(request, parent, isMain) {
    if (request === 'os') {
      return { homedir: () => homeDir };
    }
    if (request === 'keytar') {
      throw new Error('keytar unavailable in fallback token test');
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require('../parsers/figma').FigmaParser;
  } finally {
    Module._load = originalLoad;
    delete require.cache[parserPath];
  }
}

async function captureConsole(fn) {
  const messages = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => messages.push(args.map(String).join(' '));
  console.warn = (...args) => messages.push(args.map(String).join(' '));
  try {
    return {
      result: await fn(),
      output: messages.join('\n')
    };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

test('storeToken hardens existing fallback token file permissions without logging token contents', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-figma-token-privacy-'));
  const crateDir = path.join(tempHome, '.crate');
  const tokenPath = path.join(crateDir, 'figma-token');
  const oldToken = 'OLD_PUBLIC_TEST_TOKEN';
  const newToken = 'NEW_PRIVATE_TEST_TOKEN';

  try {
    fs.mkdirSync(crateDir, { recursive: true, mode: 0o755 });
    fs.chmodSync(crateDir, 0o755);
    fs.writeFileSync(tokenPath, oldToken, { mode: 0o644 });
    fs.chmodSync(tokenPath, 0o644);

    const FigmaParser = loadFigmaParserWithHome(tempHome);
    const parser = new FigmaParser();
    const { result, output } = await captureConsole(() => parser.storeToken(newToken));

    assert.equal(result, true);
    assert.equal(fs.readFileSync(tokenPath, 'utf8'), newToken);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(crateDir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
    }
    assert.equal(output.includes(oldToken), false);
    assert.equal(output.includes(newToken), false);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
