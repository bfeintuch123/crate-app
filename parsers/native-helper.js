'use strict';

// Persistent NDJSON-over-stdio client for Crate's native Apple Silicon Swift helper
// (`native/bin/crate-helper`). Falls back transparently when the native binary is
// not present or disabled via `CRATE_DISABLE_NATIVE_HELPER=1`.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEV_BINARY_PATH = path.resolve(__dirname, '..', 'native', 'bin', 'crate-helper');
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

function isExecutableRegularFile(candidatePath) {
  if (typeof candidatePath !== 'string' || !path.isAbsolute(candidatePath)) return false;
  try {
    const stat = fs.lstatSync(candidatePath);
    return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111) !== 0;
  } catch (_) {
    return false;
  }
}

/**
 * Resolve the native Apple Silicon Swift helper binary across both:
 *   1. Packaged Electron `.app` builds (`Contents/Resources/native/crate-helper`,
 *      outside `app.asar` because Mach-O binaries cannot be spawned from ASAR),
 *   2. Dev/worktree checkouts (`native/bin/crate-helper`).
 */
function resolveNativeHelperBinaryPath(explicitPath = null) {
  if (typeof explicitPath === 'string' && explicitPath.length > 0) {
    return explicitPath;
  }
  const envOverride = process.env.CRATE_NATIVE_HELPER_PATH;
  if (typeof envOverride === 'string' && isExecutableRegularFile(envOverride)) {
    return envOverride;
  }
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    const packagedCandidate = path.join(process.resourcesPath, 'native', 'crate-helper');
    if (isExecutableRegularFile(packagedCandidate)) {
      return packagedCandidate;
    }
  }
  return DEV_BINARY_PATH;
}

const DEFAULT_BINARY_PATH = resolveNativeHelperBinaryPath();

class NativeHelperClient {
  constructor(binaryPath = null) {
    this.explicitBinaryPath = binaryPath;
    this.binaryPath = resolveNativeHelperBinaryPath(binaryPath);
    this.child = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.disposing = false;
  }

  isAvailable() {
    if (process.platform !== 'darwin') return false;
    if (process.env.CRATE_DISABLE_NATIVE_HELPER === '1') return false;
    if (!this.explicitBinaryPath) {
      this.binaryPath = resolveNativeHelperBinaryPath(null);
    }
    return isExecutableRegularFile(this.binaryPath);
  }

  _ensureRunning() {
    if (this.child && !this.child.killed && this.child.exitCode === null) {
      return this.child;
    }
    if (!this.isAvailable()) {
      throw new Error('native_helper_unavailable');
    }
    this.disposing = false;
    this.buffer = '';
    const child = spawn(this.binaryPath, [], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: {},
    });
    if (typeof child.unref === 'function') child.unref();
    if (typeof child.stdin?.unref === 'function') child.stdin.unref();
    if (typeof child.stdout?.unref === 'function') child.stdout.unref();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      this.buffer += chunk;
      let nl = this.buffer.indexOf('\n');
      while (nl >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line) this._handleLine(line);
        nl = this.buffer.indexOf('\n');
      }
    });

    const onTerminate = reason => {
      if (this.child === child) this.child = null;
      for (const [id, entry] of [...this.pending.entries()]) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(new Error(reason));
      }
    };
    child.once('error', () => onTerminate('native_helper_error'));
    child.once('exit', () => onTerminate('native_helper_exited'));

    this.child = child;
    return child;
  }

  _syncRef() {
    const child = this.child;
    if (!child) return;
    if (this.pending.size > 0) {
      if (typeof child.ref === 'function') child.ref();
      if (typeof child.stdout?.ref === 'function') child.stdout.ref();
    } else {
      if (typeof child.unref === 'function') child.unref();
      if (typeof child.stdin?.unref === 'function') child.stdin.unref();
      if (typeof child.stdout?.unref === 'function') child.stdout.unref();
    }
  }

  _handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      return;
    }
    const id = msg && msg.id;
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    this._syncRef();
    if (msg.ok === true) {
      entry.resolve(msg.result);
    } else {
      const err = new Error(typeof msg.error === 'string' ? msg.error : 'native_helper_failed');
      err.code = typeof msg.error === 'string' ? msg.error : 'native_helper_failed';
      entry.reject(err);
    }
  }

  call(op, payload = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    const child = this._ensureRunning();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this._syncRef();
        try { child.kill(); } catch (_) {}
        if (this.child === child) this.child = null;
        reject(new Error('native_helper_timeout'));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      this.pending.set(id, { resolve, reject, timer });
      this._syncRef();
      try {
        child.stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        this._syncRef();
        reject(error);
      }
    });
  }

  ping() {
    return this.call('ping');
  }

  parsePsd(filePath, { includeDigest = false, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    return this.call('parse_psd', { filePath, includeDigest }, timeoutMs);
  }

  parsePdfAi(filePath, { includeDigest = false, decompressStreams = true, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    return this.call('parse_pdf_ai', { filePath, includeDigest, decompressStreams }, timeoutMs);
  }

  sha256File(filePath, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    return this.call('sha256_file', { filePath }, timeoutMs);
  }

  packageBatch(destDir, items, { mode = 'clone_or_copy', computeHash = true, timeoutMs = 60_000 } = {}) {
    return this.call('package_batch', { destDir, items, mode, computeHash }, timeoutMs);
  }

  cloneVerifiedFile(params, timeoutMs = 30_000) {
    return this.call('clone_verified_file', params, timeoutMs);
  }

  runningApps(keywords = [], timeoutMs = 3000) {
    return this.call('running_apps', { keywords }, timeoutMs);
  }

  openFiles(pids = [], extensions = [], timeoutMs = 5000) {
    return this.call('open_files', { pids, extensions }, timeoutMs);
  }

  readLastUsedXattrs(paths = [], timeoutMs = 2000) {
    return this.call('read_last_used_xattr', { paths }, timeoutMs);
  }

  async shutdown() {
    const child = this.child;
    if (!child) return;
    this.disposing = true;
    this.child = null;
    if (typeof child.ref === 'function') child.ref();
    await new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      child.once('exit', finish);
      const timer = setTimeout(() => {
        try { child.kill(); } catch (_) {}
        finish();
      }, 250);
      if (typeof timer.unref === 'function') timer.unref();
      try {
        child.stdin.write(`${JSON.stringify({ id: this.nextId++, op: 'shutdown' })}\n`);
        child.stdin.end();
      } catch (_) {
        try { child.kill(); } catch (_) {}
        finish();
      }
    });
  }
}

const defaultClient = new NativeHelperClient();

module.exports = {
  DEFAULT_BINARY_PATH,
  DEV_BINARY_PATH,
  NativeHelperClient,
  isExecutableRegularFile,
  nativeHelper: defaultClient,
  resolveNativeHelperBinaryPath,
};
