'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const verifier = require('../../../scripts/verify-macos-release-app');

const NODE_SHA256 = '2e3f1286a7eb3736346ed1803e458a0ff909e2b2d5bc746144dcb76970e9b99d';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function requireCondition(condition) {
  if (!condition) throw new Error('Pages deployment tool authentication failed');
}
function regularBytes(file) {
  const before = fs.lstatSync(file);
  requireCondition(before.isFile() && !before.isSymbolicLink());
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor), bytes = fs.readFileSync(descriptor), after = fs.fstatSync(descriptor);
    requireCondition(opened.dev === before.dev && opened.ino === before.ino && opened.size === bytes.length &&
      opened.size === after.size && opened.mtimeMs === after.mtimeMs && opened.ctimeMs === after.ctimeMs);
    return bytes;
  } finally { fs.closeSync(descriptor); }
}
function directoryIdentity(root, privateRoot = false) {
  const stat = fs.lstatSync(root);
  requireCondition(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(root) === path.resolve(root));
  if (privateRoot) requireCondition(stat.uid === process.getuid() && (stat.mode & 0o077) === 0);
  return `${stat.dev}:${stat.ino}`;
}
function fingerprintTree(root) {
  const inventory = [];
  function visit(directory, prefix = '') {
    for (const name of fs.readdirSync(directory).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name, file = path.join(directory, name), stat = fs.lstatSync(file);
      requireCondition(!stat.isSymbolicLink());
      if (stat.isDirectory()) { inventory.push([relative, 'directory', stat.dev, stat.ino, stat.mode]); visit(file, relative); }
      else {
        requireCondition(stat.isFile());
        inventory.push([relative, 'file', stat.dev, stat.ino, stat.mode, stat.size, digest(regularBytes(file))]);
      }
    }
  }
  visit(root);
  return digest(JSON.stringify(inventory));
}
function installedPackageRoots(toolRoot) {
  const roots = new Map();
  function visitModules(directory, prefix) {
    directoryIdentity(directory);
    for (const name of fs.readdirSync(directory).sort()) {
      if (prefix === 'node_modules' && name === '.package-lock.json') { regularBytes(path.join(directory, name)); continue; }
      if (name.startsWith('@')) directoryIdentity(path.join(directory, name));
      const candidates = name.startsWith('@')
        ? fs.readdirSync(path.join(directory, name)).map(child => `${name}/${child}`) : [name];
      requireCondition(candidates.length > 0);
      for (const packageName of candidates) {
        requireCondition(/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9_-][A-Za-z0-9._-]*$/u.test(packageName));
        const lockPath = `${prefix}/${packageName}`, packageRoot = path.join(toolRoot, lockPath);
        directoryIdentity(packageRoot);
        requireCondition(!roots.has(lockPath)); roots.set(lockPath, packageRoot);
        regularBytes(path.join(packageRoot, 'package.json'));
        const nested = path.join(packageRoot, 'node_modules');
        if (fs.existsSync(nested)) visitModules(nested, `${lockPath}/node_modules`);
      }
    }
  }
  directoryIdentity(path.join(toolRoot, 'node_modules'));
  visitModules(path.join(toolRoot, 'node_modules'), 'node_modules');
  return roots;
}
function packageNameFromLockPath(lockPath) {
  return lockPath.slice(lockPath.lastIndexOf('node_modules/') + 'node_modules/'.length);
}
function resolveLockPath(lock, parent, name) {
  requireCondition(/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9_-][A-Za-z0-9._-]*$/u.test(name));
  while (true) {
    const candidate = `${parent ? `${parent}/` : ''}node_modules/${name}`;
    if (Object.hasOwn(lock.packages, candidate)) return candidate;
    if (!parent) return null;
    const segments = parent.split('/'); parent = segments.slice(0, segments.lastIndexOf('node_modules')).join('/');
  }
}
function validateVersionEdges(lock, roots, satisfies) {
  for (const parent of ['', ...roots.keys()]) {
    const metadata = lock.packages[parent];
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, spec] of Object.entries(metadata[section] || {})) {
        const optional = section === 'optionalDependencies' || section === 'peerDependencies' && metadata.peerDependenciesMeta?.[name]?.optional === true;
        const resolved = resolveLockPath(lock, parent, name);
        if (!resolved || !roots.has(resolved)) { requireCondition(optional); continue; }
        requireCondition(satisfies(lock.packages[resolved].version, spec) === true);
      }
    }
  }
}
function collectExpectedLockPaths(manifest, lock, platform, arch) {
  requireCondition(verifier.rootLockMatchesSourceManifest(manifest, lock));
  const allPaths = Object.keys(lock.packages).filter(Boolean), reachable = new Set(), queue = [''];
  const validName = name => /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9_-][A-Za-z0-9._-]*$/u.test(name);
  for (const lockPath of allPaths) {
    requireCondition(lockPath.startsWith('node_modules/') &&
      lockPath.slice('node_modules/'.length).split('/node_modules/').every(validName));
    const metadata = lock.packages[lockPath];
    requireCondition(metadata && typeof metadata === 'object' && !Array.isArray(metadata) && metadata.dev !== true &&
      typeof metadata.version === 'string' && typeof metadata.resolved === 'string' &&
      metadata.resolved.startsWith('https://registry.npmjs.org/') &&
      typeof metadata.integrity === 'string' && /^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(metadata.integrity));
    const encoded = metadata.integrity.slice('sha512-'.length), bytes = Buffer.from(encoded, 'base64');
    requireCondition(bytes.length === 64 && bytes.toString('base64') === encoded);
  }
  while (queue.length) {
    const parent = queue.shift(), metadata = lock.packages[parent];
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const entries = metadata[section] || {};
      requireCondition(entries && typeof entries === 'object' && !Array.isArray(entries));
      for (const [name, spec] of Object.entries(entries)) {
        requireCondition(validName(name) && typeof spec === 'string');
        const optional = section === 'optionalDependencies' || section === 'peerDependencies' && metadata.peerDependenciesMeta?.[name]?.optional === true;
        const resolved = resolveLockPath(lock, parent, name);
        if (!resolved) { requireCondition(optional); continue; }
        if (!reachable.has(resolved)) { reachable.add(resolved); queue.push(resolved); }
      }
    }
  }
  // npm retains platform-neutral optional descendants of platform-specific
  // packages. Prove the entire cross-platform lock graph first, then select
  // eligible installed packages; never allow an unreferenced lock entry.
  requireCondition(isDeepStrictEqual([...reachable].sort(), allPaths.sort()));
  const matches = (values, actual) => {
    if (values === undefined) return true;
    requireCondition(Array.isArray(values) && values.length > 0 && new Set(values).size === values.length &&
      values.every(value => typeof value === 'string' && /^!?[A-Za-z0-9._-]+$/u.test(value)));
    return !values.includes(`!${actual}`) && (!values.some(value => !value.startsWith('!')) || values.includes(actual));
  };
  return { all: reachable, installed: new Set([...reachable].filter(key =>
    matches(lock.packages[key].os, platform) && matches(lock.packages[key].cpu, arch))) };
}
function authenticateToolchain(toolRoot, cacheRoot) {
  requireCondition(process.platform === 'darwin' && process.arch === 'arm64' && process.version === 'v22.23.1');
  requireCondition(digest(regularBytes(process.execPath)) === NODE_SHA256);
  const rootIdentity = directoryIdentity(toolRoot, true), cacheIdentity = directoryIdentity(cacheRoot, true);
  requireCondition(isDeepStrictEqual(fs.readdirSync(toolRoot).sort(), ['node_modules', 'package-lock.json', 'package.json']));
  const before = fingerprintTree(toolRoot), sourceFiles = new Map();
  for (const file of ['package.json', 'package-lock.json']) {
    const approved = regularBytes(path.join(__dirname, file)); sourceFiles.set(file, digest(approved));
    requireCondition(regularBytes(path.join(toolRoot, file)).equals(approved));
  }
  const manifest = JSON.parse(regularBytes(path.join(toolRoot, 'package.json')));
  const lock = JSON.parse(regularBytes(path.join(toolRoot, 'package-lock.json')));
  requireCondition(isDeepStrictEqual(manifest.dependencies, { wrangler: '4.151.1' }) && manifest.private === true);
  const reachable = collectExpectedLockPaths(manifest, lock, process.platform, process.arch);
  const roots = installedPackageRoots(toolRoot);
  requireCondition(isDeepStrictEqual([...roots.keys()].sort(), [...reachable.installed].sort()));
  for (const [lockPath, packageRoot] of roots) {
    const metadata = lock.packages[lockPath], name = packageNameFromLockPath(lockPath);
    const installed = JSON.parse(regularBytes(path.join(packageRoot, 'package.json')));
    requireCondition(installed.name === name && installed.version === metadata.version);
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta']) {
      requireCondition(isDeepStrictEqual(installed[section] || {}, metadata[section] || {}));
    }
    requireCondition(verifier.installedPackageMatchesLockArchive(packageRoot, name, metadata, { npmCacheRoot: cacheRoot }));
  }
  requireCondition(roots.has('node_modules/semver') && fingerprintTree(toolRoot) === before);
  // No vendor module executes until every installed package has authenticated bytes.
  const semver = require(path.join(roots.get('node_modules/semver'), 'index.js'));
  validateVersionEdges(lock, new Map([...reachable.all].map(key => [key, key])), semver.satisfies);
  for (const packageRoot of roots.values()) {
    const metadata = JSON.parse(regularBytes(path.join(packageRoot, 'package.json')));
    if (metadata.engines?.node) requireCondition(semver.satisfies(process.version, metadata.engines.node));
  }
  const cliPath = path.join(roots.get('node_modules/wrangler'), 'bin/wrangler.js'); regularBytes(cliPath);
  const recheck = () => {
    try {
      return directoryIdentity(toolRoot, true) === rootIdentity && directoryIdentity(cacheRoot, true) === cacheIdentity &&
        digest(regularBytes(process.execPath)) === NODE_SHA256 && fingerprintTree(toolRoot) === before &&
        [...sourceFiles].every(([file, sha]) => digest(regularBytes(path.join(__dirname, file))) === sha);
    } catch { return false; }
  };
  requireCondition(recheck());
  return { cliPath, recheck, summary: { packageCount: roots.size, wranglerVersion: '4.151.1', inventoryDigest: before, nodeSha256: NODE_SHA256 } };
}
module.exports = { authenticateToolchain, fingerprintTree, installedPackageRoots, validateVersionEdges, collectExpectedLockPaths };
