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
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    const packagedCandidate = path.join(process.resourcesPath, 'native', 'crate-helper');
    if (isExecutableRegularFile(packagedCandidate)) {
      return packagedCandidate;
    }
  }
  // Never honor CRATE_NATIVE_HELPER_PATH inside Electron runtimes (packaged or dev Electron).
  if (!(process.versions && process.versions.electron)) {
    const envOverride = process.env.CRATE_NATIVE_HELPER_PATH;
    if (typeof envOverride === 'string' && isExecutableRegularFile(envOverride)) {
      return envOverride;
    }
  }
  return DEV_BINARY_PATH;
}

const DEFAULT_BINARY_PATH = resolveNativeHelperBinaryPath();

class NativeHelperClient {
  constructor(binaryPath = null) {
    this.explicitBinaryPath = binaryPath;
    this.binaryPath = resolveNativeHelperBinaryPath(binaryPath);
    this.session = null;
    this.nextId = 1;
  }

  get child() {
    return this.session ? this.session.child : null;
  }

  isAvailable() {
    if (process.platform !== 'darwin') return false;
    if (process.env.CRATE_DISABLE_NATIVE_HELPER === '1') return false;
    if (!this.explicitBinaryPath) {
      this.binaryPath = resolveNativeHelperBinaryPath(null);
    }
    return isExecutableRegularFile(this.binaryPath);
  }

  _ensureSession() {
    if (
      this.session &&
      !this.session.disposing &&
      this.session.child &&
      !this.session.child.killed &&
      this.session.child.exitCode === null
    ) {
      return this.session;
    }
    if (!this.isAvailable()) {
      throw new Error('native_helper_unavailable');
    }
    const child = spawn(this.binaryPath, [], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: {},
    });
    if (typeof child.unref === 'function') child.unref();
    if (typeof child.stdin?.unref === 'function') child.stdin.unref();
    if (typeof child.stdout?.unref === 'function') child.stdout.unref();

    const session = {
      child,
      buffer: '',
      pending: new Map(),
      disposing: false,
      terminated: false,
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (session.terminated) return;
      session.buffer += chunk;
      let nl = session.buffer.indexOf('\n');
      while (nl >= 0) {
        const line = session.buffer.slice(0, nl).trim();
        session.buffer = session.buffer.slice(nl + 1);
        if (line) this._handleLine(session, line);
        nl = session.buffer.indexOf('\n');
      }
    });

    const onTerminate = reason => {
      session.terminated = true;
      if (this.session === session) this.session = null;
      for (const [id, entry] of [...session.pending.entries()]) {
        clearTimeout(entry.timer);
        session.pending.delete(id);
        entry.reject(new Error(reason));
      }
    };
    child.once('error', () => onTerminate('native_helper_error'));
    child.once('exit', () => onTerminate('native_helper_exited'));

    this.session = session;
    return session;
  }

  _syncRef(session) {
    const child = session && session.child;
    if (!child || session.terminated) return;
    if (session.pending.size > 0) {
      if (typeof child.ref === 'function') child.ref();
      if (typeof child.stdout?.ref === 'function') child.stdout.ref();
    } else {
      if (typeof child.unref === 'function') child.unref();
      if (typeof child.stdin?.unref === 'function') child.stdin.unref();
      if (typeof child.stdout?.unref === 'function') child.stdout.unref();
    }
  }

  _handleLine(session, line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      return;
    }
    const id = msg && msg.id;
    const entry = session.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    session.pending.delete(id);
    this._syncRef(session);
    if (msg.ok === true) {
      entry.resolve(msg.result);
    } else {
      const err = new Error(typeof msg.error === 'string' ? msg.error : 'native_helper_failed');
      err.code = typeof msg.error === 'string' ? msg.error : 'native_helper_failed';
      entry.reject(err);
    }
  }

  call(op, payload = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    const session = this._ensureSession();
    const { child } = session;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!session.pending.has(id)) return;
        session.pending.delete(id);
        session.disposing = true;
        if (this.session === session) this.session = null;
        this._syncRef(session);
        try { child.kill(); } catch (_) {}
        reject(new Error('native_helper_timeout'));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      session.pending.set(id, { resolve, reject, timer });
      this._syncRef(session);
      try {
        child.stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`);
      } catch (error) {
        clearTimeout(timer);
        session.pending.delete(id);
        this._syncRef(session);
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

  cloneVerifiedFile(params, timeoutMs = 30_000) {
    return this.call('clone_verified_file', params, timeoutMs);
  }

  runningApps(keywords = [], timeoutMs = 3000, { caseSensitive = false } = {}) {
    return this.call('running_apps', { keywords, caseSensitive: Boolean(caseSensitive) }, timeoutMs);
  }

  openFiles(pids = [], extensions = [], timeoutMs = 5000) {
    return this.call('open_files', { pids, extensions }, timeoutMs);
  }

  readLastUsedXattrs(paths = [], timeoutMs = 2000) {
    return this.call('read_last_used_xattr', { paths }, timeoutMs);
  }

  async shutdown() {
    const session = this.session;
    if (!session || !session.child) return;
    const { child } = session;
    session.disposing = true;
    this.session = null;
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
const watcherClient = new NativeHelperClient();
const packageClient = new NativeHelperClient();

module.exports = {
  DEFAULT_BINARY_PATH,
  DEV_BINARY_PATH,
  NativeHelperClient,
  isExecutableRegularFile,
  nativeHelper: defaultClient,
  packageNativeHelper: packageClient,
  resolveNativeHelperBinaryPath,
  watcherNativeHelper: watcherClient,
};
