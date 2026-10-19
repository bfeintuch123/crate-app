'use strict';

// CI-only browser provisioning. No system browser, PATH or security settings
// are changed. Every accepted byte comes from this reviewed fixed artifact.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const PIN = Object.freeze({
  version: '155.0.8059.84',
  url: 'https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.84/mac-arm64/chrome-mac-arm64.zip',
  archiveBytes: 192672771,
  archiveSha256: '13b9e98ce56f5ce18e100a009f455c9285f399e7c9dc8a76fdf2f3a9755bb5f2',
  executableSha256: '240a57379cffd4efe2ec7f29396a3d3e566f18dd2f7e0484f092f224a0a8b362',
  plistSha256: '22bdb502acca4aeb0e49e6c4415fc1ea7402851069fbb411eab3d45dbd2fe3a2',
  treeSha256: 'a7e0cb66fe77c3dc2edee060ef22a2369d62f9f827a00a2c05d296138f85334b',
});
const PACK = 'chrome-mac-arm64';
const APP = 'Google Chrome for Testing.app';
const RELATIVE_EXECUTABLE = path.join('payload', PACK, APP, 'Contents', 'MacOS', 'Google Chrome for Testing');
const safeEnvironment = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
const fail = code => Object.assign(new Error(code), { code });

function fileHash(file, maximum = 512 * 1024 * 1024) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > maximum) throw fail('CI_CHROME_INVALID_FILE');
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let bytes = 0, size;
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, null))) {
      bytes += size;
      if (bytes > maximum) throw fail('CI_CHROME_INVALID_FILE');
      hash.update(buffer.subarray(0, size));
    }
    const after = fs.fstatSync(fd);
    if (bytes !== before.size || before.ino !== after.ino || before.dev !== after.dev
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw fail('CI_CHROME_FILE_CHANGED');
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

function treeHash(root) {
  if (fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()) throw fail('CI_CHROME_INVALID_TREE');
  const hash = crypto.createHash('sha256');
  let entries = 0, bytes = 0;
  function visit(file, relative) {
    if (++entries > 20000) throw fail('CI_CHROME_TREE_LIMIT');
    const stat = fs.lstatSync(file), mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(file), resolved = path.resolve(path.dirname(file), target);
      if (path.isAbsolute(target) || !resolved.startsWith(root + path.sep)) throw fail('CI_CHROME_EXTERNAL_LINK');
      hash.update(JSON.stringify([relative, 'link', mode, target]) + '\n');
    } else if (stat.isDirectory()) {
      hash.update(JSON.stringify([relative, 'directory', mode]) + '\n');
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), relative ? relative + '/' + name : name);
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > 2 * 1024 * 1024 * 1024) throw fail('CI_CHROME_TREE_LIMIT');
      hash.update(JSON.stringify([relative, 'file', mode, stat.size, fileHash(file)]) + '\n');
    } else throw fail('CI_CHROME_INVALID_TREE');
  }
  visit(root, '');
  return hash.digest('hex');
}

function installRoot(runnerTemp = process.env.RUNNER_TEMP) {
  if (!runnerTemp || !path.isAbsolute(runnerTemp) || fs.realpathSync(runnerTemp) !== runnerTemp) throw fail('CI_CHROME_INVALID_TEMP');
  return path.join(runnerTemp, 'crate-ci-chrome');
}

function verifyIdentity(browser) {
  let descriptor;
  try {
    if (process.platform !== 'darwin' || process.arch !== 'arm64' || fs.realpathSync(browser) !== browser
      || fileHash(browser, 32 * 1024 * 1024) !== PIN.executableSha256) throw fail('CI_CHROME_IDENTITY_MISMATCH');
    const plist = path.resolve(path.dirname(browser), '..', 'Info.plist');
    descriptor = fs.openSync(plist, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 128 * 1024) throw fail('CI_CHROME_IDENTITY_MISMATCH');
    const buffer = Buffer.alloc(stat.size + 1), size = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const metadata = buffer.subarray(0, size);
    if (crypto.createHash('sha256').update(metadata).digest('hex') !== PIN.plistSha256) throw fail('CI_CHROME_IDENTITY_MISMATCH');
    const version = metadata.toString('utf8')
      .match(/<key>CFBundleShortVersionString<\/key>\s*<string>([0-9.]+)<\/string>/)?.[1];
    if (version !== PIN.version) throw fail('CI_CHROME_IDENTITY_MISMATCH');
    return { family: 'chrome-for-testing', version, versionSource: 'pinned-archive',
      platform: process.platform, arch: process.arch, node: process.versions.node,
      executableSha256: PIN.executableSha256, archiveSha256: PIN.archiveSha256 };
  } catch (_) { throw fail('CI_CHROME_IDENTITY_MISMATCH'); }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function pinnedBrowser() {
  if (process.env.CRATE_UI_TEST_BROWSER_PIN === undefined) return null;
  if (process.env.CRATE_UI_TEST_BROWSER_PIN !== '1') throw fail('CI_CHROME_INVALID_PIN_MODE');
  const expected = path.join(installRoot(), RELATIVE_EXECUTABLE);
  if (process.env.CRATE_UI_TEST_BROWSER !== expected) throw fail('CI_CHROME_PIN_PATH_MISMATCH');
  verifyIdentity(expected); // Never fall back or turn required probes into skips.
  return expected;
}

function verifyInstalled(root) {
  if (root !== installRoot() || fs.realpathSync(root) !== root) throw fail('CI_CHROME_INVALID_ROOT');
  if (JSON.stringify(fs.readdirSync(root).sort()) !== JSON.stringify(['chrome-mac-arm64.zip', 'payload'])
    || JSON.stringify(fs.readdirSync(path.join(root, 'payload'))) !== JSON.stringify([PACK])) throw fail('CI_CHROME_INVALID_ROOT');
  const archive = path.join(root, 'chrome-mac-arm64.zip');
  if (fs.lstatSync(archive).size !== PIN.archiveBytes || fileHash(archive) !== PIN.archiveSha256) throw fail('CI_CHROME_ARCHIVE_MISMATCH');
  if (treeHash(path.join(root, 'payload', PACK)) !== PIN.treeSha256) throw fail('CI_CHROME_TREE_MISMATCH');
  return { ...verifyIdentity(path.join(root, RELATIVE_EXECUTABLE)), treeSha256: PIN.treeSha256 };
}

function install(root, archiveSource) {
  if (root !== installRoot()) throw fail('CI_CHROME_INVALID_ROOT');
  fs.mkdirSync(root, { mode: 0o700 }); // Exclusive creation: never overwrite an installation.
  const archive = path.join(root, 'chrome-mac-arm64.zip');
  if (archiveSource) fs.copyFileSync(archiveSource, archive, fs.constants.COPYFILE_EXCL);
  else {
    const result = childProcess.spawnSync('/usr/bin/curl', ['--disable', '--fail', '--silent', '--show-error',
      '--proto', '=https', '--tlsv1.2', '--connect-timeout', '15', '--max-time', '90',
      '--max-filesize', String(PIN.archiveBytes), '--output', archive, PIN.url],
    { env: safeEnvironment, timeout: 95000, maxBuffer: 4096 });
    if (result.error || result.status !== 0) throw fail('CI_CHROME_DOWNLOAD_FAILED');
  }
  fs.chmodSync(archive, 0o600);
  if (fs.lstatSync(archive).size !== PIN.archiveBytes || fileHash(archive) !== PIN.archiveSha256) throw fail('CI_CHROME_ARCHIVE_MISMATCH');
  const payload = path.join(root, 'payload');
  fs.mkdirSync(payload, { mode: 0o700 });
  const extracted = childProcess.spawnSync('/usr/bin/ditto', ['-x', '-k', archive, payload],
    { env: safeEnvironment, timeout: 60000, maxBuffer: 4096 });
  if (extracted.error || extracted.status !== 0) throw fail('CI_CHROME_EXTRACTION_FAILED');
  return verifyInstalled(root);
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2), [command, root, option, archive] = args;
    if (!['install', 'verify'].includes(command) || !root
      || !(args.length === 2 || (args.length === 4 && command === 'install' && option === '--archive' && archive))) {
      throw fail('CI_CHROME_INVALID_ARGUMENTS');
    }
    const identity = command === 'install' ? install(root, archive) : verifyInstalled(root);
    console.log(JSON.stringify({ event: 'ci-chrome-' + command, ...identity }));
  } catch (error) {
    console.error(/^CI_CHROME_[A-Z_]+$/.test(error.code || '') ? error.code : 'CI_CHROME_FAILED');
    process.exitCode = 1;
  }
}

module.exports = { PIN, RELATIVE_EXECUTABLE, fileHash, treeHash, installRoot, verifyIdentity, pinnedBrowser, verifyInstalled, install };
