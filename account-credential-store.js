'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Synchronous local IO deliberately makes generation check + persistence indivisible.
class AccountCredentialStore {
  constructor({ safeStorage, userDataPath, binding }) {
    this.safeStorage = safeStorage;
    this.root = userDataPath;
    this.directory = path.join(userDataPath, 'account-secrets');
    this.file = path.join(this.directory, 'session.bin');
    this.binding = binding;
    this.signedOutMarker = path.join(userDataPath, 'account-signed-out');
  }
  directorySafe(create = false) {
    for (const directory of [this.root, this.directory]) {
      if (create && !fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw Error('credential_storage');
      fs.chmodSync(directory, 0o700);
    }
  }
  encryptionSafe() {
    if (!this.safeStorage.isEncryptionAvailable() || this.safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw Error('credential_storage');
  }
  read() {
    if (fs.existsSync(this.signedOutMarker)) return null;
    if (!fs.existsSync(this.directory)) return null;
    this.directorySafe();
    let fd;
    try {
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536 || (process.getuid && stat.uid !== process.getuid())) throw Error('credential_storage');
      this.encryptionSafe();
      fs.fchmodSync(fd, 0o600);
      const record = JSON.parse(this.safeStorage.decryptString(fs.readFileSync(fd)));
      if (record.binding !== this.binding || record.version !== 1 || typeof record.refreshToken !== 'string' || !record.refreshToken || record.refreshToken.length > 16384) throw Error('credential_storage');
      return record;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw Error('credential_storage');
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  write(record) {
    this.encryptionSafe();
    this.directorySafe(true);
    const data = this.safeStorage.encryptString(JSON.stringify({ ...record, version: 1, binding: this.binding }));
    if (data.length > 65536) throw Error('credential_storage');
    const temporary = path.join(this.directory, `.${crypto.randomBytes(16).toString('hex')}.tmp`);
    let fd;
    try {
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, data); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      this.directorySafe();
      // rename replaces a destination symlink; it never follows its target.
      fs.renameSync(temporary, this.file);
      try { fs.unlinkSync(this.signedOutMarker); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    } catch (_) { throw Error('credential_storage'); }
    finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch (_) {}
    }
  }
  clear() {
    const root = fs.lstatSync(this.root);
    if (!root.isDirectory() || root.isSymbolicLink()) throw Error('credential_storage');
    // Persist logout before deleting encrypted material. A deletion failure must
    // not silently restore the saved session on the next launch.
    try { fs.writeFileSync(this.signedOutMarker, '1', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw Error('credential_storage'); }
    if (!fs.existsSync(this.directory)) return;
    this.directorySafe();
    try { fs.unlinkSync(this.file); } catch (error) { if (error.code !== 'ENOENT') throw Error('credential_storage'); }
  }
}
module.exports = { AccountCredentialStore };
