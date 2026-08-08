'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const ROOT_LIFECYCLE_NAMES = Object.freeze([
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'prepublishOnly',
  'prepack',
  'postpack',
  'publish',
  'postpublish',
  'preprepare',
  'prepare',
  'postprepare',
  'predependencies',
  'dependencies',
  'postdependencies',
  'preversion',
  'version',
  'postversion',
]);
const DEPENDENCY_LIFECYCLE_NAMES = Object.freeze([
  'preinstall',
  'install',
  'postinstall',
]);
const CANVAS_REBUILD_LIFECYCLE_NAMES = Object.freeze([
  ...DEPENDENCY_LIFECYCLE_NAMES,
  'prepare',
]);
const FORBIDDEN_ROOT_PACKAGE_MANAGER_FILES = Object.freeze([
  '.npmrc',
  'npm-shrinkwrap.json',
]);
const APPROVED_EXECUTABLE_LINKS = Object.freeze({
  'node-gyp': '../node-gyp/bin/node-gyp.js',
  'prebuild-install': '../prebuild-install/bin.js',
});
const APPROVED_INSTALL_SCRIPTS = Object.freeze([
  Object.freeze({
    lockPath: 'node_modules/canvas',
    name: 'canvas',
    version: '3.2.1',
    resolved: 'https://registry.npmjs.org/canvas/-/canvas-3.2.1.tgz',
    integrity: 'sha512-ej1sPFR5+0YWtaVp6S1N1FVz69TQCqmrkGeRvQxZeAB1nAIcjNTHVwrZtYtWFFBmQsF40/uDLehsW5KuYC99mg==',
    scripts: Object.freeze({ install: 'prebuild-install -r napi || node-gyp rebuild' }),
    implicitInstall: null,
  }),
  Object.freeze({
    lockPath: 'node_modules/electron',
    name: 'electron',
    version: '39.8.10',
    resolved: 'https://registry.npmjs.org/electron/-/electron-39.8.10.tgz',
    integrity: 'sha512-zbYtGPYUI7PzqLAzkk21Rk6j67WN0hxn0Mq/njErZo1d0HSf33is4f8ICI5fMLy5vYe0JtCtM5sYunNOaochSQ==',
    scripts: Object.freeze({ postinstall: 'node install.js' }),
    implicitInstall: null,
  }),
  Object.freeze({
    lockPath: 'node_modules/electron-winstaller',
    name: 'electron-winstaller',
    version: '5.4.0',
    resolved: 'https://registry.npmjs.org/electron-winstaller/-/electron-winstaller-5.4.0.tgz',
    integrity: 'sha512-bO3y10YikuUwUuDUQRM4KfwNkKhnpVO7IPdbsrejwN9/AABJzzTQ4GeHwyzNSrVO+tEH3/Np255a3sVZpZDjvg==',
    scripts: Object.freeze({ install: 'node ./script/select-7z-arch.js' }),
    implicitInstall: null,
  }),
  Object.freeze({
    lockPath: 'node_modules/fsevents',
    name: 'fsevents',
    version: '2.3.3',
    resolved: 'https://registry.npmjs.org/fsevents/-/fsevents-2.3.3.tgz',
    integrity: 'sha512-5xoDfX+fL7faATnagmWPpbFtwh/R77WmMMqqHGS65C3vvB0YHrgF+B1YmZ3441tMj5n63k0212XNoJwzlhffQw==',
    scripts: Object.freeze({}),
    implicitInstall: null,
  }),
]);

function lifecycleScripts(manifest, names = DEPENDENCY_LIFECYCLE_NAMES) {
  const scripts = manifest && manifest.scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return {};
  return Object.fromEntries(names
    .filter(name => typeof scripts[name] === 'string' && scripts[name])
    .map(name => [name, scripts[name]]));
}

function implicitInstallBehavior(packageRoot, manifest, scripts = lifecycleScripts(manifest)) {
  if (scripts.preinstall || scripts.install || manifest.gypfile === false) return null;
  return fs.existsSync(path.join(packageRoot, 'binding.gyp')) ? 'node-gyp rebuild' : null;
}

function approvedCanvasBuildToolPathsAreValid(projectRoot) {
  const nodeModulesRoot = path.join(projectRoot, 'node_modules');
  try {
    const binRoot = path.join(nodeModulesRoot, '.bin');
    const binMetadata = fs.lstatSync(binRoot);
    if (binMetadata.isSymbolicLink() || !binMetadata.isDirectory() ||
        fs.realpathSync(binRoot) !== path.join(fs.realpathSync(nodeModulesRoot), '.bin')) {
      return false;
    }
    for (const unapprovedPath of [path.join(binRoot, 'node')]) {
      try {
        fs.lstatSync(unapprovedPath);
        return false;
      } catch (error) {
        if (!error || error.code !== 'ENOENT') return false;
      }
    }
    let ancestor = path.join(nodeModulesRoot, 'canvas');
    while (true) {
      const candidate = path.join(ancestor, 'node_modules', '.bin');
      if (path.resolve(candidate) !== path.resolve(binRoot)) {
        try {
          fs.lstatSync(candidate);
          return false;
        } catch (error) {
          if (!error || error.code !== 'ENOENT') return false;
        }
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    const canonicalNodeModulesRoot = fs.realpathSync(nodeModulesRoot);
    for (const [name, expectedTarget] of Object.entries(APPROVED_EXECUTABLE_LINKS)) {
      const linkPath = path.join(nodeModulesRoot, '.bin', name);
      const metadata = fs.lstatSync(linkPath);
      if (!metadata.isSymbolicLink() || fs.readlinkSync(linkPath) !== expectedTarget) return false;
      const canonicalTarget = fs.realpathSync(linkPath);
      if (!canonicalTarget.startsWith(`${canonicalNodeModulesRoot}${path.sep}`) ||
          canonicalTarget !== fs.realpathSync(path.resolve(path.dirname(linkPath), expectedTarget)) ||
          !fs.lstatSync(canonicalTarget).isFile()) {
        return false;
      }
    }
    return true;
  } catch (error) {
    return false;
  }
}

function approvedCanvasRebuildLifecycleIsValid(projectRoot) {
  const approval = APPROVED_INSTALL_SCRIPTS.find(item => item.name === 'canvas');
  if (!approval) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(projectRoot, approval.lockPath, 'package.json'),
      'utf8'
    ));
    return manifest.name === approval.name && manifest.version === approval.version &&
      isDeepStrictEqual(
        lifecycleScripts(manifest, CANVAS_REBUILD_LIFECYCLE_NAMES),
        approval.scripts
      );
  } catch (error) {
    return false;
  }
}

function listInstalledLifecycleManifests(projectRoot) {
  const requestedNodeModulesRoot = path.join(projectRoot, 'node_modules');
  if (!fs.existsSync(requestedNodeModulesRoot)) return { valid: false, manifests: [] };
  let nodeModulesRoot;
  let canonicalProjectRoot;
  try {
    const rootMetadata = fs.lstatSync(requestedNodeModulesRoot);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
      return { valid: false, manifests: [] };
    }
    canonicalProjectRoot = fs.realpathSync(projectRoot);
    nodeModulesRoot = fs.realpathSync(requestedNodeModulesRoot);
  } catch (error) {
    return { valid: false, manifests: [] };
  }
  const pending = [nodeModulesRoot];
  const manifests = [];

  try {
    while (pending.length > 0) {
      const current = pending.pop();
      for (const child of fs.readdirSync(current, { withFileTypes: true })) {
        if (child.name === '.bin') continue;
        const absolutePath = path.join(current, child.name);
        const metadata = fs.lstatSync(absolutePath);
        if (metadata.isSymbolicLink()) return { valid: false, manifests: [] };
        const canonicalPath = fs.realpathSync(absolutePath);
        if (!canonicalPath.startsWith(`${nodeModulesRoot}${path.sep}`)) {
          return { valid: false, manifests: [] };
        }
        if (metadata.isDirectory()) {
          pending.push(absolutePath);
          continue;
        }
        if (!metadata.isFile() || child.name !== 'package.json') continue;
        const manifest = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
        const scripts = lifecycleScripts(manifest);
        const packageRoot = path.dirname(absolutePath);
        const implicitInstall = implicitInstallBehavior(packageRoot, manifest, scripts);
        if (Object.keys(scripts).length === 0 && !implicitInstall) continue;
        manifests.push({
          lockPath: path.relative(canonicalProjectRoot, packageRoot).split(path.sep).join('/'),
          name: manifest.name,
          version: manifest.version,
          scripts,
          implicitInstall,
        });
      }
    }
  } catch (error) {
    return { valid: false, manifests: [] };
  }
  return { valid: true, manifests };
}

function inspectInstallScriptPolicy(projectRoot = path.resolve(__dirname, '..')) {
  const failures = new Set();
  let lockfile;
  let rootManifest;
  try {
    lockfile = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'));
    rootManifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  } catch (error) {
    return {
      ok: false,
      failures: ['Committed lockfile could not be inspected.'],
      approvedPackageCount: 0,
    };
  }

  for (const fileName of FORBIDDEN_ROOT_PACKAGE_MANAGER_FILES) {
    try {
      fs.lstatSync(path.join(projectRoot, fileName));
      failures.add('Repository package-manager configuration is not approved.');
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        failures.add('Repository package-manager configuration could not be inspected safely.');
      }
    }
  }

  const rootLifecycleScripts = lifecycleScripts(rootManifest, ROOT_LIFECYCLE_NAMES);
  if (Object.keys(rootLifecycleScripts).length > 0 ||
      implicitInstallBehavior(projectRoot, rootManifest, rootLifecycleScripts)) {
    failures.add('Root package lifecycle scripts are not approved.');
  }
  if (!approvedCanvasBuildToolPathsAreValid(projectRoot)) {
    failures.add('Approved dependency executable links changed.');
  }
  if (!approvedCanvasRebuildLifecycleIsValid(projectRoot)) {
    failures.add('Approved Canvas rebuild lifecycle changed.');
  }
  if (!lockfile.packages || typeof lockfile.packages !== 'object' || Array.isArray(lockfile.packages)) {
    return {
      ok: false,
      failures: ['Committed lockfile could not be inspected.'],
      approvedPackageCount: 0,
    };
  }

  const approvals = new Map(APPROVED_INSTALL_SCRIPTS.map(item => [item.lockPath, item]));
  const lifecycleLockPaths = Object.entries(lockfile.packages)
    .filter(([, metadata]) => metadata && metadata.hasInstallScript === true)
    .map(([lockPath]) => lockPath);
  if (lifecycleLockPaths.some(lockPath => !approvals.has(lockPath))) {
    failures.add('Unapproved lifecycle package in package-lock.json.');
  }

  for (const approval of APPROVED_INSTALL_SCRIPTS) {
    const metadata = lockfile.packages[approval.lockPath];
    if (!metadata || metadata.version !== approval.version ||
        metadata.resolved !== approval.resolved || metadata.integrity !== approval.integrity ||
        metadata.hasInstallScript !== true) {
      failures.add('Approved lifecycle lock metadata changed.');
    }
  }

  const installed = listInstalledLifecycleManifests(projectRoot);
  if (!installed.valid) failures.add('Installed dependency tree could not be inspected safely.');
  if (installed.manifests.some(item => !approvals.has(item.lockPath))) {
    failures.add('Unapproved installed lifecycle script.');
  }
  for (const approval of APPROVED_INSTALL_SCRIPTS) {
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(
        path.join(projectRoot, approval.lockPath, 'package.json'),
        'utf8'
      ));
    } catch (error) {
      manifest = null;
    }
    const packageRoot = path.join(projectRoot, approval.lockPath);
    if (!manifest || manifest.name !== approval.name || manifest.version !== approval.version ||
        !isDeepStrictEqual(lifecycleScripts(manifest), approval.scripts) ||
        implicitInstallBehavior(packageRoot, manifest) !== approval.implicitInstall) {
      failures.add('Approved installed lifecycle script changed.');
    }
  }

  return {
    ok: failures.size === 0,
    failures: [...failures],
    approvedPackageCount: APPROVED_INSTALL_SCRIPTS.length,
  };
}

function run(argv = process.argv.slice(2), dependencies = {}) {
  const writeOutput = dependencies.writeOutput || console.log;
  const writeError = dependencies.writeError || console.error;
  const setExitCode = dependencies.setExitCode || (code => { process.exitCode = code; });
  const inspectPolicy = dependencies.inspectPolicy || inspectInstallScriptPolicy;
  if (argv.length !== 0) {
    writeError('Usage: node scripts/verify-install-scripts.js');
    setExitCode(2);
    return { exitCode: 2, result: null };
  }
  const result = inspectPolicy();
  if (result.ok) {
    writeOutput(`Crate install-script policy passed (${result.approvedPackageCount} approved packages).`);
    return { exitCode: 0, result };
  }
  writeError(['Crate install-script policy failed.', ...result.failures.map(item => `- ${item}`)].join('\n'));
  setExitCode(1);
  return { exitCode: 1, result };
}

if (require.main === module) run();

module.exports = {
  APPROVED_EXECUTABLE_LINKS,
  APPROVED_INSTALL_SCRIPTS,
  CANVAS_REBUILD_LIFECYCLE_NAMES,
  DEPENDENCY_LIFECYCLE_NAMES,
  FORBIDDEN_ROOT_PACKAGE_MANAGER_FILES,
  ROOT_LIFECYCLE_NAMES,
  approvedCanvasBuildToolPathsAreValid,
  approvedCanvasRebuildLifecycleIsValid,
  implicitInstallBehavior,
  inspectInstallScriptPolicy,
  lifecycleScripts,
  run,
};
