'use strict';

const fs = require('fs');
const path = require('path');

const MAX_PACKAGE_NAME_LENGTH = 180;
const UNSAFE_FILENAME_CHARS = /[\x00-\x1f\x7f<>:"|?*\\/]/g;

function realpathSync(targetPath) {
  return (fs.realpathSync.native || fs.realpathSync)(targetPath);
}

function lstatIfExists(targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

function isAllowedMacSystemSymlink(targetPath) {
  const allowedTargets = {
    '/etc': '/private/etc',
    '/tmp': '/private/tmp',
    '/var': '/private/var',
  };
  const allowedTarget = allowedTargets[path.resolve(targetPath)];
  if (!allowedTarget) return false;

  try {
    return path.resolve(realpathSync(targetPath)) === allowedTarget;
  } catch (e) {
    return false;
  }
}

function assertNoUnsafeSymlinkInPath(targetPath, message) {
  const resolved = path.resolve(targetPath);
  const parsed = path.parse(resolved);
  const relative = path.relative(parsed.root, resolved);
  if (!relative) return;

  let current = parsed.root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const stat = lstatIfExists(current);
    if (!stat) return;
    if (stat.isSymbolicLink() && !isAllowedMacSystemSymlink(current)) {
      throw new Error(message);
    }
  }
}

function sanitizePackageFileName(rawName, fallbackName = 'file') {
  let fallback = `${fallbackName || 'file'}`
    .replace(UNSAFE_FILENAME_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (!fallback || fallback === '.' || fallback === '..') fallback = 'file';

  const normalized = `${rawName || ''}`.replace(/\0/g, '_').replace(/\\/g, '/');
  let name = path.basename(normalized)
    .replace(UNSAFE_FILENAME_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim();

  if (!name || name === '.' || name === '..') name = fallback;
  if (name.length > MAX_PACKAGE_NAME_LENGTH) {
    const ext = path.extname(name);
    const base = path.basename(name, ext).slice(0, Math.max(1, MAX_PACKAGE_NAME_LENGTH - ext.length));
    name = `${base}${ext}`;
  }
  return name;
}

function sanitizePackageRelativePath(rawPath, fallbackName = 'file') {
  const normalized = `${rawPath || ''}`.replace(/\0/g, '_').replace(/\\/g, '/');
  const parts = normalized
    .split('/')
    .filter(part => part && part !== '.' && part !== '..')
    .map((part, index, allParts) => sanitizePackageFileName(part, index === allParts.length - 1 ? fallbackName : 'folder'));

  return parts.length > 0 ? path.join(...parts) : sanitizePackageFileName(fallbackName);
}

function isPathInsideDirectory(rootDir, candidatePath) {
  const root = path.resolve(rootDir);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function ensureSafePackageDirectory(destFolder) {
  if (!destFolder || typeof destFolder !== 'string' || destFolder.includes('\0')) {
    throw new Error('Invalid package output folder');
  }

  const root = path.resolve(destFolder);
  const parent = path.dirname(root);
  assertNoUnsafeSymlinkInPath(parent, 'Package output parent folder is a symlink');
  const parentStat = lstatIfExists(parent);
  if (parentStat) {
    if (parentStat.isSymbolicLink()) {
      throw new Error('Package output parent folder is a symlink');
    }
    if (!parentStat.isDirectory()) {
      throw new Error('Package output parent folder is not a directory');
    }
  }

  const existing = lstatIfExists(root);
  if (existing) {
    if (existing.isSymbolicLink()) {
      throw new Error('Package output folder is a symlink');
    }
    if (!existing.isDirectory()) {
      throw new Error('Package output folder is not a directory');
    }
  } else {
    fs.mkdirSync(root, { recursive: true });
  }

  assertNoUnsafeSymlinkInPath(parent, 'Package output parent folder is a symlink');
  const currentParent = fs.lstatSync(parent);
  if (currentParent.isSymbolicLink()) {
    throw new Error('Package output parent folder is a symlink');
  }
  if (!currentParent.isDirectory()) {
    throw new Error('Package output parent folder is not a directory');
  }

  const current = fs.lstatSync(root);
  if (current.isSymbolicLink()) {
    throw new Error('Package output folder is a symlink');
  }
  if (!current.isDirectory()) {
    throw new Error('Package output folder is not a directory');
  }

  const realParent = realpathSync(parent);
  const realRoot = realpathSync(root);
  if (!isPathInsideDirectory(realParent, realRoot)) {
    throw new Error('Package output folder escapes output parent');
  }
  return root;
}

function ensureSafeDestinationDirectory(root, realRoot, destDir) {
  const resolvedRoot = path.resolve(root);
  const resolvedDestDir = path.resolve(destDir);
  if (!isPathInsideDirectory(resolvedRoot, resolvedDestDir)) {
    throw new Error('Package destination escapes package folder');
  }

  const relativeDir = path.relative(resolvedRoot, resolvedDestDir);
  if (!relativeDir) {
    const realDestDir = realpathSync(resolvedRoot);
    if (!isPathInsideDirectory(realRoot, realDestDir)) {
      throw new Error('Package destination escapes package folder');
    }
    return resolvedDestDir;
  }

  let current = resolvedRoot;
  for (const part of relativeDir.split(path.sep)) {
    if (!part || part === '.' || part === '..') {
      throw new Error('Package destination escapes package folder');
    }

    current = path.join(current, part);
    if (!isPathInsideDirectory(resolvedRoot, current)) {
      throw new Error('Package destination escapes package folder');
    }

    const existing = lstatIfExists(current);
    if (existing) {
      if (existing.isSymbolicLink()) {
        throw new Error('Package destination directory is a symlink');
      }
      if (!existing.isDirectory()) {
        throw new Error('Package destination parent is not a directory');
      }
    } else {
      fs.mkdirSync(current);
    }

    const currentStat = fs.lstatSync(current);
    if (currentStat.isSymbolicLink()) {
      throw new Error('Package destination directory is a symlink');
    }
    if (!currentStat.isDirectory()) {
      throw new Error('Package destination parent is not a directory');
    }

    const realCurrent = realpathSync(current);
    if (!isPathInsideDirectory(realRoot, realCurrent)) {
      throw new Error('Package destination escapes package folder');
    }
  }

  return resolvedDestDir;
}

function assertFinalDestinationInsideRoot(realRoot, destDir, finalPath) {
  const realDestDir = realpathSync(destDir);
  const realFinalPath = path.join(realDestDir, path.basename(finalPath));
  if (!isPathInsideDirectory(realRoot, realDestDir) || !isPathInsideDirectory(realRoot, realFinalPath)) {
    throw new Error('Package destination escapes package folder');
  }
}

function resolveUniquePackagePath(destFolder, rawName, options = {}) {
  const root = ensureSafePackageDirectory(destFolder);
  const realRoot = realpathSync(root);
  const fallbackName = options.fallbackName || 'file';
  const relativeName = options.preserveRelativePath
    ? sanitizePackageRelativePath(rawName, fallbackName)
    : sanitizePackageFileName(rawName, fallbackName);

  let finalPath = path.resolve(root, relativeName);
  if (!isPathInsideDirectory(root, finalPath)) {
    throw new Error('Package destination escapes package folder');
  }

  let counter = 1;
  while (lstatIfExists(finalPath)) {
    const dir = path.dirname(finalPath);
    if (!isPathInsideDirectory(root, dir)) {
      throw new Error('Package destination escapes package folder');
    }
    const ext = path.extname(relativeName);
    const base = path.basename(relativeName, ext);
    finalPath = path.join(dir, `${base}_${counter}${ext}`);
    if (!isPathInsideDirectory(root, finalPath)) {
      throw new Error('Package destination escapes package folder');
    }
    counter++;
  }

  const destDir = path.dirname(finalPath);
  ensureSafeDestinationDirectory(root, realRoot, destDir);
  if (lstatIfExists(finalPath)) {
    throw new Error('Package destination already exists');
  }
  assertFinalDestinationInsideRoot(realRoot, destDir, finalPath);
  return finalPath;
}

function resolveExactPackagePath(destFolder, rawName, options = {}) {
  const root = ensureSafePackageDirectory(destFolder);
  const realRoot = realpathSync(root);
  const fallbackName = options.fallbackName || 'file';
  const relativeName = options.preserveRelativePath
    ? sanitizePackageRelativePath(rawName, fallbackName)
    : sanitizePackageFileName(rawName, fallbackName);

  const finalPath = path.resolve(root, relativeName);
  if (!isPathInsideDirectory(root, finalPath)) {
    throw new Error('Package destination escapes package folder');
  }

  const destDir = path.dirname(finalPath);
  ensureSafeDestinationDirectory(root, realRoot, destDir);
  assertFinalDestinationInsideRoot(realRoot, destDir, finalPath);
  return finalPath;
}

function assertSafeCopySource(sourcePath) {
  if (!sourcePath || typeof sourcePath !== 'string' || sourcePath.includes('\0')) {
    throw new Error('Invalid source path');
  }

  const stat = fs.lstatSync(sourcePath);
  if (stat.isSymbolicLink()) {
    throw new Error('Symlink source files are not copied');
  }
  if (!stat.isFile()) {
    throw new Error('Source is not a regular file');
  }
}

function copyFileIntoPackage(sourcePath, destFolder, rawName, options = {}) {
  assertSafeCopySource(sourcePath);
  const finalPath = resolveUniquePackagePath(destFolder, rawName, options);
  fs.copyFileSync(sourcePath, finalPath, fs.constants.COPYFILE_EXCL);
  return finalPath;
}

function writeFileIntoPackage(destFolder, rawName, data, options = {}) {
  const finalPath = resolveUniquePackagePath(destFolder, rawName, options);
  fs.writeFileSync(finalPath, data, { flag: 'wx' });
  return finalPath;
}

function writeFileIntoPackageExact(destFolder, rawName, data, options = {}) {
  const finalPath = resolveExactPackagePath(destFolder, rawName, options);
  const existing = lstatIfExists(finalPath);
  const overwrite = options.overwrite === true;

  if (existing) {
    if (existing.isSymbolicLink()) {
      throw new Error('Package destination file is a symlink');
    }
    if (!existing.isFile()) {
      throw new Error('Package destination is not a regular file');
    }
    if (!overwrite) {
      throw new Error('Package destination already exists');
    }
  }

  const flags = existing
    ? fs.constants.O_WRONLY | fs.constants.O_TRUNC
    : fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
  let fd = null;
  try {
    fd = fs.openSync(finalPath, flags | noFollow, 0o666);
    fs.writeFileSync(fd, data);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return finalPath;
}

function removeCreatedPackageFiles(destFolder, filePaths) {
  const root = path.resolve(destFolder);
  const rootStat = lstatIfExists(root);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return 0;

  const realRoot = realpathSync(root);
  let removed = 0;
  for (const filePath of filePaths || []) {
    try {
      const candidate = path.resolve(String(filePath || ''));
      if (!isPathInsideDirectory(root, candidate)) continue;

      const stat = lstatIfExists(candidate);
      if (!stat || stat.isSymbolicLink() || !stat.isFile()) continue;
      if (!isPathInsideDirectory(realRoot, realpathSync(path.dirname(candidate)))) continue;

      fs.unlinkSync(candidate);
      removed += 1;
    } catch (error) {
      // Preserve the original admission failure while cleanup remains best effort.
    }
  }
  return removed;
}

module.exports = {
  sanitizePackageFileName,
  sanitizePackageRelativePath,
  isPathInsideDirectory,
  ensureSafePackageDirectory,
  resolveUniquePackagePath,
  resolveExactPackagePath,
  assertSafeCopySource,
  copyFileIntoPackage,
  removeCreatedPackageFiles,
  writeFileIntoPackage,
  writeFileIntoPackageExact,
};
