'use strict';

/**
 * Phase 4B — Native Watcher & APFS Package Adapter
 *
 * Isolates all native Swift helper (`parsers/native-helper.js`) watcher and
 * packaging bridge logic cleanly out of `main.js`:
 *   - Availability & test-mock detection guards (`canUseNativeProcessWatcher`, `canUseNativePackageClone`)
 *   - Native `getxattr(2)` batch last-used timestamp adapter
 *   - Native `NSWorkspace` running design-app PID adapter
 *   - Native `libproc` open-files -> `lsof -F ptn` adapter (preserving exact scan-on-close semantics)
 *   - Native descriptor-bound, ancestry-verified APFS `fclonefileat` adapter
 */

const path = require('node:path');

let nativeHelper = null;
let watcherNativeHelper = null;
let packageNativeHelper = null;
try {
  ({
    nativeHelper,
    watcherNativeHelper,
    packageNativeHelper,
  } = require('./native-helper'));
} catch (_) {
  nativeHelper = null;
  watcherNativeHelper = null;
  packageNativeHelper = null;
}

function canUseNativeProcessWatcher(execFn, execFileFn) {
  const client = watcherNativeHelper || nativeHelper;
  if (!client || !client.isAvailable()) return false;
  try {
    const builtinCp = require('node:child_process');
    return execFn === builtinCp.exec && execFileFn === builtinCp.execFile;
  } catch (_) {
    return false;
  }
}

function canUseNativePackageClone() {
  const client = packageNativeHelper || nativeHelper;
  if (!client || !client.isAvailable()) return false;
  // Keep APFS native clone opt-in only until dedicated organized-writer fault
  // parity is established; default Electron and test runs stay on the
  // descriptor-bound package-transaction-worker writer.
  return process.env.CRATE_ENABLE_NATIVE_CLONE === '1';
}

async function readNativeLastUsedXattrs(filePaths, timeoutMs, { client: explicitClient = null } = {}) {
  const client = explicitClient || watcherNativeHelper || nativeHelper;
  if (!client) return null;
  const response = await client.readLastUsedXattrs(filePaths, timeoutMs);
  const timestamps = response && response.timestamps;
  if (!timestamps || typeof timestamps !== 'object') return null;
  if (response.errors && typeof response.errors === 'object' && Object.keys(response.errors).length > 0) {
    throw new Error('native xattr read error');
  }

  const values = new Map();
  for (const filePath of filePaths) {
    if (!Object.prototype.hasOwnProperty.call(timestamps, filePath)) {
      throw new Error('incomplete native xattr result');
    }
    const raw = timestamps[filePath];
    values.set(filePath, typeof raw === 'number' && Number.isFinite(raw) ? raw : null);
  }
  return values;
}

async function getNativeRunningDesignApps(keywords, timeoutMs = 3000, { client: explicitClient = null } = {}) {
  const client = explicitClient || watcherNativeHelper || nativeHelper;
  if (!client) return null;
  const result = await client.runningApps(keywords, timeoutMs, { caseSensitive: true });
  const pids = [];
  const pidToCmd = new Map();
  const filterKeywords = Array.isArray(keywords) ? keywords.filter(k => typeof k === 'string' && k.length > 0) : [];
  for (const appInfo of (result && result.apps) || []) {
    if (!Number.isInteger(appInfo.pid) || appInfo.pid <= 0) continue;
    const cmd = appInfo.command || appInfo.name || '';
    if (filterKeywords.length > 0 && !filterKeywords.some(kw => cmd.includes(kw))) continue;
    pids.push(appInfo.pid);
    pidToCmd.set(appInfo.pid, cmd);
  }
  return { pids, pidToCmd };
}

/**
 * Formats native `libproc` open-file results into exact `lsof -F ptn` output,
 * always emitting `p<pid>` headers for every valid PID so scan-on-close triggers
 * identically when a running app closes its last file.
 */
function formatNativeOpenFilesAsLsofF(validPids, files) {
  const byPid = new Map();
  for (const entry of files) {
    if (!entry || !Number.isInteger(entry.pid) || typeof entry.path !== 'string') continue;
    if (!entry.path || entry.path.includes('\n') || entry.path.includes('\r')) continue;
    let list = byPid.get(entry.pid);
    if (!list) {
      list = [];
      byPid.set(entry.pid, list);
    }
    list.push(entry.path);
  }
  const lines = [];
  for (const pid of validPids) {
    lines.push(`p${pid}`);
    const paths = byPid.get(pid);
    if (!paths) continue;
    for (const filePath of paths) {
      lines.push('tREG');
      lines.push(`n${filePath}`);
    }
  }
  return lines.join('\n');
}

async function pollNativeOpenFilesAsLsofF(validPids, timeoutMs = 12000, { client: explicitClient = null } = {}) {
  const client = explicitClient || watcherNativeHelper || nativeHelper;
  if (!client) return null;
  const response = await client.openFiles(validPids, [], timeoutMs);
  if (
    !response ||
    !Array.isArray(response.files) ||
    response.complete !== true ||
    (Array.isArray(response.failedPids) && response.failedPids.length > 0)
  ) {
    return null;
  }
  return formatNativeOpenFilesAsLsofF(validPids, response.files);
}

async function tryNativeVerifiedClone({
  sourceMeta,
  group,
  filePath,
  ancestries,
  mode,
  PackageReviewChangedError,
  PackageTransactionInvariantError,
}) {
  const client = packageNativeHelper || nativeHelper;
  if (
    !client ||
    !sourceMeta ||
    typeof sourceMeta.sourcePath !== 'string' ||
    typeof sourceMeta.dev !== 'bigint' ||
    typeof sourceMeta.ino !== 'bigint' ||
    typeof sourceMeta.size !== 'bigint'
  ) {
    return null;
  }

  let cloneResult = null;
  try {
    cloneResult = await client.cloneVerifiedFile({
      sourcePath: sourceMeta.sourcePath,
      expectedSourceDev: `${sourceMeta.dev}`,
      expectedSourceIno: `${sourceMeta.ino}`,
      expectedSourceSize: `${sourceMeta.size}`,
      destDir: group.path,
      expectedDestDev: `${group.identity.dev}`,
      expectedDestIno: `${group.identity.ino}`,
      ancestries,
      leafName: path.basename(filePath),
      mode,
    });
  } catch (error) {
    if (error && error.code === 'source_changed' && typeof PackageReviewChangedError === 'function') {
      throw new PackageReviewChangedError();
    }
    if (
      error &&
      typeof PackageTransactionInvariantError === 'function' &&
      (error.code === 'dest_dir_changed' ||
        error.code === 'dest_already_exists' ||
        error.code === 'fchmod_failed' ||
        error.code === 'dest_verify_failed')
    ) {
      throw new PackageTransactionInvariantError();
    }
    return null;
  }

  if (cloneResult && cloneResult.cloned === true && cloneResult.outputIdentity) {
    return {
      dev: BigInt(cloneResult.outputIdentity.dev),
      ino: BigInt(cloneResult.outputIdentity.ino),
      bytesWritten: cloneResult.bytesWritten,
    };
  }
  return null;
}

function shutdownNativeHelper() {
  for (const client of [watcherNativeHelper, packageNativeHelper, nativeHelper]) {
    try {
      client?.shutdown?.();
    } catch (_) {}
  }
}

module.exports = {
  canUseNativePackageClone,
  canUseNativeProcessWatcher,
  formatNativeOpenFilesAsLsofF,
  getNativeRunningDesignApps,
  pollNativeOpenFilesAsLsofF,
  readNativeLastUsedXattrs,
  shutdownNativeHelper,
  tryNativeVerifiedClone,
};
