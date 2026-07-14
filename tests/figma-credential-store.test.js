'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  FigmaCredentialStore,
  ENCRYPTED_CREDENTIAL_RELATIVE_PATH,
} = require('../parsers/figma-credential-store');

function createSafeStorage(options = {}) {
  return {
    isEncryptionAvailable: () => options.available !== false,
    encryptString(value) {
      if (options.failEncryptFor === value) throw new Error('synthetic encryption failure');
      return Buffer.from(`sealed:${Buffer.from(value, 'utf8').toString('base64')}`, 'utf8');
    },
    decryptString(value) {
      const encoded = Buffer.from(value).toString('utf8');
      if (!encoded.startsWith('sealed:')) throw new Error('synthetic corrupt credential');
      const plainText = Buffer.from(encoded.slice('sealed:'.length), 'base64').toString('utf8');
      if (options.failDecryptFor === plainText) throw new Error('synthetic decryption failure');
      return plainText;
    },
  };
}

function createFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-figma-credential-store-'));
  const userDataPath = path.join(root, 'user-data');
  const legacyTokenPath = path.join(root, '.crate', 'figma-token');
  const messages = [];
  const store = new FigmaCredentialStore({
    safeStorage: options.safeStorage || createSafeStorage(),
    userDataPath,
    legacyTokenPath,
    env: options.env || {},
    logger: {
      warn: message => messages.push(String(message)),
    },
  });

  return {
    root,
    userDataPath,
    legacyTokenPath,
    encryptedTokenPath: path.join(userDataPath, ENCRYPTED_CREDENTIAL_RELATIVE_PATH),
    messages,
    store,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('legacy plaintext token migrates silently to Keychain-backed encrypted storage', async () => {
  const fixture = createFixture();
  const token = 'LEGACY_TOKEN_VALUE';

  try {
    fs.mkdirSync(path.dirname(fixture.legacyTokenPath), { recursive: true, mode: 0o755 });
    fs.writeFileSync(fixture.legacyTokenPath, token, { mode: 0o644 });

    assert.equal(await fixture.store.getToken(), token);
    assert.equal(fs.existsSync(fixture.legacyTokenPath), false);
    assert.equal(fs.existsSync(fixture.encryptedTokenPath), true);
    assert.equal(fs.readFileSync(fixture.encryptedTokenPath).includes(Buffer.from(token)), false);
    assert.equal(await fixture.store.getToken(), token);

    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.dirname(fixture.encryptedTokenPath)).mode & 0o777, 0o700);
      assert.equal(fs.statSync(fixture.encryptedTokenPath).mode & 0o777, 0o600);
    }
  } finally {
    fixture.cleanup();
  }
});

test('concurrent token reads share one legacy migration', async () => {
  const fixture = createFixture();
  const token = 'LEGACY_TOKEN_VALUE';
  let storeCalls = 0;
  const originalStoreToken = fixture.store.storeToken.bind(fixture.store);

  try {
    fs.mkdirSync(path.dirname(fixture.legacyTokenPath), { recursive: true });
    fs.writeFileSync(fixture.legacyTokenPath, token, { mode: 0o600 });
    fixture.store.storeToken = async (...args) => {
      storeCalls += 1;
      await new Promise(resolve => setImmediate(resolve));
      return originalStoreToken(...args);
    };

    assert.deepEqual(await Promise.all([
      fixture.store.getToken(),
      fixture.store.getToken(),
    ]), [token, token]);
    assert.equal(storeCalls, 1);
    assert.equal(fs.existsSync(fixture.legacyTokenPath), false);
  } finally {
    fixture.cleanup();
  }
});

test('legacy cleanup preserves a credential changed during migration', async () => {
  const fixture = createFixture();
  const originalToken = 'ORIGINAL_LEGACY_TOKEN';
  const changedToken = 'CHANGED_LEGACY_TOKEN';
  const originalStoreToken = fixture.store.storeToken.bind(fixture.store);

  try {
    fs.mkdirSync(path.dirname(fixture.legacyTokenPath), { recursive: true });
    fs.writeFileSync(fixture.legacyTokenPath, originalToken, { mode: 0o600 });
    fixture.store.storeToken = async (...args) => {
      const stored = await originalStoreToken(...args);
      fs.writeFileSync(fixture.legacyTokenPath, changedToken, { mode: 0o600 });
      return stored;
    };

    assert.equal(await fixture.store.getToken(), originalToken);
    assert.equal(fs.readFileSync(fixture.legacyTokenPath, 'utf8'), changedToken);
    assert.equal(fixture.messages.some(message => message.includes('cleanup skipped')), true);
  } finally {
    fixture.cleanup();
  }
});

test('unavailable encryption preserves but does not use a legacy plaintext token', async () => {
  const fixture = createFixture({ safeStorage: createSafeStorage({ available: false }) });
  const legacyToken = 'LEGACY_TOKEN_VALUE';

  try {
    fs.mkdirSync(path.dirname(fixture.legacyTokenPath), { recursive: true });
    fs.writeFileSync(fixture.legacyTokenPath, legacyToken, { mode: 0o600 });

    assert.equal(await fixture.store.getToken(), null);
    assert.equal(fs.readFileSync(fixture.legacyTokenPath, 'utf8'), legacyToken);
    assert.equal(await fixture.store.storeToken('NEW_TOKEN_VALUE'), false);
    assert.equal(fs.readFileSync(fixture.legacyTokenPath, 'utf8'), legacyToken);
    assert.equal(fs.existsSync(fixture.encryptedTokenPath), false);
  } finally {
    fixture.cleanup();
  }
});

test('a candidate that cannot be decrypted never replaces the previous credential', async () => {
  const safeStorage = createSafeStorage({ failDecryptFor: 'NEW_TOKEN_VALUE' });
  const fixture = createFixture({ safeStorage });

  try {
    assert.equal(await fixture.store.storeToken('OLD_TOKEN_VALUE'), true);
    const originalCiphertext = fs.readFileSync(fixture.encryptedTokenPath);

    assert.equal(await fixture.store.storeToken('NEW_TOKEN_VALUE'), false);
    assert.deepEqual(fs.readFileSync(fixture.encryptedTokenPath), originalCiphertext);
    assert.equal(await fixture.store.getToken(), 'OLD_TOKEN_VALUE');
    assert.deepEqual(
      fs.readdirSync(path.dirname(fixture.encryptedTokenPath)).filter(name => name.endsWith('.tmp')),
      []
    );
  } finally {
    fixture.cleanup();
  }
});

test('saving a new encrypted token removes an obsolete legacy plaintext file', async () => {
  const fixture = createFixture();

  try {
    fs.mkdirSync(path.dirname(fixture.legacyTokenPath), { recursive: true });
    fs.writeFileSync(fixture.legacyTokenPath, 'OLD_LEGACY_TOKEN', { mode: 0o600 });

    assert.equal(await fixture.store.storeToken('NEW_ENCRYPTED_TOKEN'), true);
    assert.equal(fs.existsSync(fixture.legacyTokenPath), false);
    assert.equal(await fixture.store.getToken(), 'NEW_ENCRYPTED_TOKEN');
  } finally {
    fixture.cleanup();
  }
});

test('environment override is read without being persisted', async () => {
  const fixture = createFixture({ env: { FIGMA_PAT: 'ENV_TOKEN_VALUE' } });

  try {
    assert.equal(await fixture.store.getToken(), 'ENV_TOKEN_VALUE');
    assert.equal(fs.existsSync(fixture.encryptedTokenPath), false);
    assert.equal(fs.existsSync(fixture.legacyTokenPath), false);
  } finally {
    fixture.cleanup();
  }
});

test('corrupt encrypted data fails closed without exposing credential paths', async () => {
  const fixture = createFixture();

  try {
    fs.mkdirSync(path.dirname(fixture.encryptedTokenPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(fixture.encryptedTokenPath, 'not-an-encrypted-credential', { mode: 0o600 });

    assert.equal(await fixture.store.getToken(), null);
    const output = fixture.messages.join('\n');
    assert.equal(output.includes(fixture.root), false);
    assert.equal(output.includes('not-an-encrypted-credential'), false);
  } finally {
    fixture.cleanup();
  }
});

test('symlinked legacy credential is rejected and never deleted', { skip: process.platform === 'win32' }, async () => {
  const fixture = createFixture();
  const targetPath = path.join(fixture.root, 'unrelated-target');

  try {
    fs.mkdirSync(path.dirname(fixture.legacyTokenPath), { recursive: true });
    fs.writeFileSync(targetPath, 'TARGET_TOKEN_VALUE', { mode: 0o600 });
    fs.symlinkSync(targetPath, fixture.legacyTokenPath);

    assert.equal(await fixture.store.getToken(), null);
    assert.equal(fs.readFileSync(targetPath, 'utf8'), 'TARGET_TOKEN_VALUE');
    assert.equal(fs.lstatSync(fixture.legacyTokenPath).isSymbolicLink(), true);
    assert.equal(fs.existsSync(fixture.encryptedTokenPath), false);
  } finally {
    fixture.cleanup();
  }
});

test('symlinked encrypted destination is rejected without modifying its target', { skip: process.platform === 'win32' }, async () => {
  const fixture = createFixture();
  const targetPath = path.join(fixture.root, 'unrelated-encrypted-target');

  try {
    fs.mkdirSync(path.dirname(fixture.encryptedTokenPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(targetPath, 'UNCHANGED_TARGET_VALUE', { mode: 0o600 });
    fs.symlinkSync(targetPath, fixture.encryptedTokenPath);

    assert.equal(await fixture.store.storeToken('NEW_TOKEN_VALUE'), false);
    assert.equal(fs.readFileSync(targetPath, 'utf8'), 'UNCHANGED_TARGET_VALUE');
    assert.equal(fs.lstatSync(fixture.encryptedTokenPath).isSymbolicLink(), true);
  } finally {
    fixture.cleanup();
  }
});

test('symlinked encrypted credential root is rejected without writing through it', { skip: process.platform === 'win32' }, async () => {
  const fixture = createFixture();
  const targetRoot = path.join(fixture.root, 'unrelated-user-data-target');

  try {
    fs.mkdirSync(targetRoot, { recursive: true });
    fs.symlinkSync(targetRoot, fixture.userDataPath);

    assert.equal(await fixture.store.storeToken('NEW_TOKEN_VALUE'), false);
    assert.deepEqual(fs.readdirSync(targetRoot), []);
  } finally {
    fixture.cleanup();
  }
});

test('symlinked legacy credential root is rejected without reading its target', { skip: process.platform === 'win32' }, async () => {
  const fixture = createFixture();
  const targetRoot = path.join(fixture.root, 'unrelated-legacy-target');
  const targetTokenPath = path.join(targetRoot, 'figma-token');

  try {
    fs.mkdirSync(targetRoot, { recursive: true });
    fs.writeFileSync(targetTokenPath, 'TARGET_TOKEN_VALUE', { mode: 0o600 });
    fs.symlinkSync(targetRoot, path.dirname(fixture.legacyTokenPath));

    assert.equal(await fixture.store.getToken(), null);
    assert.equal(fs.readFileSync(targetTokenPath, 'utf8'), 'TARGET_TOKEN_VALUE');
    assert.equal(fs.existsSync(fixture.encryptedTokenPath), false);
  } finally {
    fixture.cleanup();
  }
});

test('disconnect removes encrypted and legacy credential files', async () => {
  const fixture = createFixture();

  try {
    assert.equal(await fixture.store.storeToken('ENCRYPTED_TOKEN_VALUE'), true);
    fs.mkdirSync(path.dirname(fixture.legacyTokenPath), { recursive: true });
    fs.writeFileSync(fixture.legacyTokenPath, 'LEGACY_TOKEN_VALUE', { mode: 0o600 });

    assert.equal(await fixture.store.deleteToken(), true);
    assert.equal(fs.existsSync(fixture.encryptedTokenPath), false);
    assert.equal(fs.existsSync(fixture.legacyTokenPath), false);
  } finally {
    fixture.cleanup();
  }
});

test('disconnect does not follow symlinked credential roots', { skip: process.platform === 'win32' }, async () => {
  const fixture = createFixture();
  const encryptedTargetRoot = path.join(fixture.root, 'encrypted-delete-target');
  const encryptedTargetPath = path.join(encryptedTargetRoot, ENCRYPTED_CREDENTIAL_RELATIVE_PATH);
  const legacyTargetRoot = path.join(fixture.root, 'legacy-delete-target');
  const legacyTargetPath = path.join(legacyTargetRoot, 'figma-token');

  try {
    fs.mkdirSync(path.dirname(encryptedTargetPath), { recursive: true });
    fs.writeFileSync(encryptedTargetPath, 'ENCRYPTED_TARGET_VALUE', { mode: 0o600 });
    fs.symlinkSync(encryptedTargetRoot, fixture.userDataPath);
    fs.mkdirSync(legacyTargetRoot, { recursive: true });
    fs.writeFileSync(legacyTargetPath, 'LEGACY_TARGET_VALUE', { mode: 0o600 });
    fs.symlinkSync(legacyTargetRoot, path.dirname(fixture.legacyTokenPath));

    assert.equal(await fixture.store.deleteToken(), false);
    assert.equal(fs.readFileSync(encryptedTargetPath, 'utf8'), 'ENCRYPTED_TARGET_VALUE');
    assert.equal(fs.readFileSync(legacyTargetPath, 'utf8'), 'LEGACY_TARGET_VALUE');
  } finally {
    fixture.cleanup();
  }
});
