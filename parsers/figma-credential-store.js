'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const OWNER_ONLY_DIR_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const MAX_TOKEN_BYTES = 8192;
const MAX_ENCRYPTED_BYTES = 65536;
const ENCRYPTED_CREDENTIAL_RELATIVE_PATH = path.join('secrets', 'figma-credential.bin');

function normalizeToken(value) {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  if (!token || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) return null;
  return token;
}

function isSafeDirectory(directoryPath) {
  if (!directoryPath) return false;
  try {
    const stat = fs.lstatSync(directoryPath);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (_) {
    return false;
  }
}

class FigmaCredentialStore {
  constructor({ safeStorage, userDataPath, legacyTokenPath, env = process.env, logger = console } = {}) {
    this.safeStorage = safeStorage || null;
    this.userDataPath = typeof userDataPath === 'string' ? path.resolve(userDataPath) : null;
    this.legacyTokenPath = typeof legacyTokenPath === 'string' ? path.resolve(legacyTokenPath) : null;
    this.env = env || {};
    this.logger = logger || console;
    this.migrationPromise = null;
    this.encryptedTokenPath = this.userDataPath
      ? path.join(this.userDataPath, ENCRYPTED_CREDENTIAL_RELATIVE_PATH)
      : null;
  }

  _warn(category) {
    if (this.logger && typeof this.logger.warn === 'function') {
      this.logger.warn(`[crate][figma] secure credential ${category}`);
    }
  }

  _encryptionAvailable() {
    try {
      return !!(
        this.safeStorage &&
        typeof this.safeStorage.isEncryptionAvailable === 'function' &&
        this.safeStorage.isEncryptionAvailable()
      );
    } catch (_) {
      return false;
    }
  }

  _secureDirectory() {
    if (!this.encryptedTokenPath || !this.userDataPath) return null;
    const directory = path.dirname(this.encryptedTokenPath);

    try {
      fs.mkdirSync(this.userDataPath, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
      if (!isSafeDirectory(this.userDataPath)) {
        this._warn('directory rejected');
        return null;
      }
      fs.mkdirSync(directory, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
      if (!isSafeDirectory(directory)) {
        this._warn('directory rejected');
        return null;
      }
      fs.chmodSync(directory, OWNER_ONLY_DIR_MODE);
      return directory;
    } catch (_) {
      this._warn('directory unavailable');
      return null;
    }
  }

  _readEncryptedToken() {
    if (!this.encryptedTokenPath || !this._encryptionAvailable()) return null;

    try {
      if (!fs.existsSync(this.encryptedTokenPath)) return null;
      if (!isSafeDirectory(this.userDataPath) || !isSafeDirectory(path.dirname(this.encryptedTokenPath))) {
        this._warn('encrypted directory rejected');
        return null;
      }
      const stat = fs.lstatSync(this.encryptedTokenPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_ENCRYPTED_BYTES) {
        this._warn('encrypted data rejected');
        return null;
      }
      const encrypted = fs.readFileSync(this.encryptedTokenPath);
      return normalizeToken(this.safeStorage.decryptString(encrypted));
    } catch (_) {
      this._warn('encrypted data unreadable');
      return null;
    }
  }

  _readLegacyToken() {
    if (!this.legacyTokenPath) return null;

    try {
      if (!fs.existsSync(this.legacyTokenPath)) return null;
      if (!isSafeDirectory(path.dirname(this.legacyTokenPath))) {
        this._warn('legacy directory rejected');
        return null;
      }
      const stat = fs.lstatSync(this.legacyTokenPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_TOKEN_BYTES) {
        this._warn('legacy data rejected');
        return null;
      }
      const token = normalizeToken(fs.readFileSync(this.legacyTokenPath, 'utf8'));
      return token ? { token, dev: stat.dev, ino: stat.ino } : null;
    } catch (_) {
      this._warn('legacy data unreadable');
      return null;
    }
  }

  _deleteLegacyIfUnchanged(record) {
    if (!record || !this.legacyTokenPath) return false;

    try {
      if (!isSafeDirectory(path.dirname(this.legacyTokenPath))) {
        this._warn('legacy cleanup skipped');
        return false;
      }
      const stat = fs.lstatSync(this.legacyTokenPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== record.dev || stat.ino !== record.ino) {
        this._warn('legacy cleanup skipped');
        return false;
      }
      if (normalizeToken(fs.readFileSync(this.legacyTokenPath, 'utf8')) !== record.token) {
        this._warn('legacy cleanup skipped');
        return false;
      }
      fs.unlinkSync(this.legacyTokenPath);
      return true;
    } catch (_) {
      this._warn('legacy cleanup incomplete');
      return false;
    }
  }

  _deleteLegacyFile() {
    if (!this.legacyTokenPath) return false;
    try {
      const legacyDirectory = path.dirname(this.legacyTokenPath);
      try {
        fs.lstatSync(legacyDirectory);
      } catch (error) {
        if (error && error.code === 'ENOENT') return false;
        throw error;
      }
      if (!isSafeDirectory(legacyDirectory)) {
        this._warn('legacy cleanup skipped');
        return false;
      }
      const stat = fs.lstatSync(this.legacyTokenPath);
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        this._warn('legacy cleanup skipped');
        return false;
      }
      fs.unlinkSync(this.legacyTokenPath);
      return true;
    } catch (error) {
      if (error && error.code === 'ENOENT') return false;
      this._warn('legacy cleanup incomplete');
      return false;
    }
  }

  async getToken() {
    const encryptedToken = this._readEncryptedToken();
    if (encryptedToken) return encryptedToken;

    const environmentToken = normalizeToken(this.env.FIGMA_PAT);
    if (environmentToken) return environmentToken;

    if (this.migrationPromise) return this.migrationPromise;

    const migrationPromise = this._migrateLegacyToken();
    this.migrationPromise = migrationPromise;
    try {
      return await migrationPromise;
    } finally {
      if (this.migrationPromise === migrationPromise) this.migrationPromise = null;
    }
  }

  async _migrateLegacyToken() {
    const legacyRecord = this._readLegacyToken();
    if (!legacyRecord) return null;

    if (await this.storeToken(legacyRecord.token, { cleanupLegacy: false })) {
      this._deleteLegacyIfUnchanged(legacyRecord);
      return legacyRecord.token;
    } else {
      this._warn('migration deferred');
      return null;
    }
  }

  async storeToken(value, options = {}) {
    const token = normalizeToken(value);
    if (!token || !this.encryptedTokenPath || !this._encryptionAvailable()) return false;

    const directory = this._secureDirectory();
    if (!directory) return false;

    try {
      if (fs.existsSync(this.encryptedTokenPath)) {
        const currentStat = fs.lstatSync(this.encryptedTokenPath);
        if (!currentStat.isFile() || currentStat.isSymbolicLink()) {
          this._warn('encrypted destination rejected');
          return false;
        }
      }
    } catch (_) {
      this._warn('encrypted destination unavailable');
      return false;
    }

    let temporaryPath = null;
    try {
      const encrypted = this.safeStorage.encryptString(token);
      if (!Buffer.isBuffer(encrypted) || encrypted.length <= 0 || encrypted.length > MAX_ENCRYPTED_BYTES) {
        this._warn('encryption rejected');
        return false;
      }

      temporaryPath = path.join(
        directory,
        `.figma-credential.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
      );
      fs.writeFileSync(temporaryPath, encrypted, { flag: 'wx', mode: OWNER_ONLY_FILE_MODE });
      fs.chmodSync(temporaryPath, OWNER_ONLY_FILE_MODE);

      const verifiedToken = normalizeToken(this.safeStorage.decryptString(fs.readFileSync(temporaryPath)));
      if (verifiedToken !== token) {
        this._warn('round-trip verification failed');
        return false;
      }

      fs.renameSync(temporaryPath, this.encryptedTokenPath);
      temporaryPath = null;
      if (options.cleanupLegacy !== false) this._deleteLegacyFile();
      return true;
    } catch (_) {
      this._warn('write failed');
      return false;
    } finally {
      if (temporaryPath) {
        try {
          fs.unlinkSync(temporaryPath);
        } catch (_) {}
      }
    }
  }

  async deleteToken() {
    let deleted = false;
    const candidates = [
      {
        candidatePath: this.encryptedTokenPath,
        safeParent: !!this.encryptedTokenPath &&
          isSafeDirectory(this.userDataPath) &&
          isSafeDirectory(path.dirname(this.encryptedTokenPath)),
      },
      {
        candidatePath: this.legacyTokenPath,
        safeParent: !!this.legacyTokenPath && isSafeDirectory(path.dirname(this.legacyTokenPath)),
      },
    ];
    for (const { candidatePath, safeParent } of candidates) {
      if (!candidatePath) continue;
      try {
        fs.lstatSync(candidatePath);
      } catch (error) {
        if (error && error.code === 'ENOENT') continue;
        this._warn('cleanup incomplete');
        continue;
      }
      if (!safeParent) {
        this._warn('cleanup skipped');
        continue;
      }
      try {
        fs.unlinkSync(candidatePath);
        deleted = true;
      } catch (_) {
        this._warn('cleanup incomplete');
      }
    }
    return deleted;
  }
}

module.exports = {
  ENCRYPTED_CREDENTIAL_RELATIVE_PATH,
  FigmaCredentialStore,
  MAX_ENCRYPTED_BYTES,
  MAX_TOKEN_BYTES,
  normalizeToken,
};
