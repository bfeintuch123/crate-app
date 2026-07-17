'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  APPROVED_INSTALL_SCRIPTS,
  FORBIDDEN_ROOT_PACKAGE_MANAGER_FILES,
  ROOT_LIFECYCLE_NAMES,
  inspectInstallScriptPolicy,
  run: runInstallScriptPolicy,
} = require('../scripts/verify-install-scripts');
const {
  APPROVED_CANVAS_PREBUILD,
  APPROVED_CANVAS_PREBUILD_DIRECTORIES,
  APPROVED_CANVAS_PREBUILD_FILES,
  canvasPrebuildMatchesInstalled,
  collectApprovedCanvasPrebuildDigests,
  inspectApprovedCanvasPrebuild,
  installApprovedCanvasPrebuild,
  run: runCanvasInstaller,
} = require('../scripts/install-approved-canvas-prebuild');

const EXPECTED_INSTALL_SCRIPTS = Object.freeze([
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
    lockPath: 'node_modules/fs-xattr',
    name: 'fs-xattr',
    version: '0.3.1',
    resolved: 'https://registry.npmjs.org/fs-xattr/-/fs-xattr-0.3.1.tgz',
    integrity: 'sha512-UVqkrEW0GfDabw4C3HOrFlxKfx0eeigfRne69FxSBdHIP8Qt5Sq6Pu3RM9KmMlkygtC4pPKkj5CiPO5USnj2GA==',
    scripts: Object.freeze({}),
    implicitInstall: 'node-gyp rebuild',
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
  Object.freeze({
    lockPath: 'node_modules/macos-alias',
    name: 'macos-alias',
    version: '0.2.12',
    resolved: 'https://registry.npmjs.org/macos-alias/-/macos-alias-0.2.12.tgz',
    integrity: 'sha512-yiLHa7cfJcGRFq4FrR4tMlpNHb4Vy4mWnpajlSSIFM5k4Lv8/7BbbDLzCAVogWNl0LlLhizRp1drXv0hK9h0Yw==',
    scripts: Object.freeze({}),
    implicitInstall: 'node-gyp rebuild',
  }),
]);
const EXPECTED_ROOT_LIFECYCLE_NAMES = Object.freeze([
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

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-install-script-policy-'));
  const packages = {};
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'crate-app',
    scripts: { start: 'electron .' },
    version: '1.0.0',
  }));
  for (const approval of EXPECTED_INSTALL_SCRIPTS) {
    packages[approval.lockPath] = {
      version: approval.version,
      resolved: approval.resolved,
      integrity: approval.integrity,
      hasInstallScript: true,
    };
    const manifestPath = path.join(root, approval.lockPath, 'package.json');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({
      name: approval.name,
      version: approval.version,
      scripts: approval.scripts,
    }));
    if (approval.implicitInstall) {
      fs.writeFileSync(path.join(path.dirname(manifestPath), 'binding.gyp'), '{}');
    }
  }
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3,
    packages,
  }));
  for (const [packageName, binPath] of [
    ['prebuild-install', 'bin.js'],
    ['node-gyp', 'bin/node-gyp.js'],
  ]) {
    const targetPath = path.join(root, 'node_modules', packageName, binPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, '#!/usr/bin/env node\n');
  }
  const binRoot = path.join(root, 'node_modules', '.bin');
  fs.mkdirSync(binRoot, { recursive: true });
  fs.symlinkSync('../prebuild-install/bin.js', path.join(binRoot, 'prebuild-install'));
  fs.symlinkSync('../node-gyp/bin/node-gyp.js', path.join(binRoot, 'node-gyp'));
  return root;
}

function createCanvasArchiveFixture() {
  const root = fs.mkdtempSync('/tmp/crate-canvas-prebuild-policy-');
  const sourceRoot = path.join(root, 'source');
  const releaseRoot = path.join(sourceRoot, 'build', 'Release');
  fs.mkdirSync(releaseRoot, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'build', 'Makefile'), 'authenticated metadata');
  fs.writeFileSync(path.join(releaseRoot, 'canvas.node'), 'authenticated native payload');
  const archivePath = path.join(root, 'canvas.tar.gz');
  execFileSync('/usr/bin/tar', ['-czf', archivePath, '-C', sourceRoot, 'build']);
  const entries = execFileSync('/usr/bin/tar', ['-tzf', archivePath], { encoding: 'utf8' })
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean);
  const files = entries.filter(entry => !entry.endsWith('/'));
  const bytes = fs.readFileSync(archivePath);
  return {
    archivePath,
    policy: {
      entries,
      files,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    },
    root,
  };
}

test('approved lifecycle scripts match the committed lock and installed manifests', () => {
  const root = createFixture();
  try {
    assert.deepEqual(APPROVED_INSTALL_SCRIPTS, EXPECTED_INSTALL_SCRIPTS);
    assert.deepEqual(ROOT_LIFECYCLE_NAMES, EXPECTED_ROOT_LIFECYCLE_NAMES);
    assert.deepEqual(inspectInstallScriptPolicy(root), {
      ok: true,
      failures: [],
      approvedPackageCount: EXPECTED_INSTALL_SCRIPTS.length,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repository package-manager configuration fails closed before dependency policy passes', () => {
  assert.deepEqual(FORBIDDEN_ROOT_PACKAGE_MANAGER_FILES, ['.npmrc', 'npm-shrinkwrap.json']);
  for (const fileName of FORBIDDEN_ROOT_PACKAGE_MANAGER_FILES) {
    for (const kind of ['file', 'dangling-link']) {
      const root = createFixture();
      try {
        const target = path.join(root, fileName);
        if (kind === 'file') fs.writeFileSync(target, 'registry=https://attacker.invalid/\n');
        else fs.symlinkSync('missing-package-manager-config', target);
        const result = inspectInstallScriptPolicy(root);
        assert.equal(result.ok, false, `${fileName} ${kind}`);
        assert.equal(
          result.failures.includes('Repository package-manager configuration is not approved.'),
          true,
          `${fileName} ${kind}`
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }
});

test('install-script policy CLI rejects every argument without inspecting the repository', () => {
  const hostile = '/Users/example/private/token\nCLOUDFLARE_API_TOKEN=secret';
  for (const argv of [['--help'], ['--'], ['first', 'second'], [''], [hostile]]) {
    const output = [];
    const errors = [];
    const exitCodes = [];
    let inspected = false;
    const result = runInstallScriptPolicy(argv, {
      inspectPolicy() {
        inspected = true;
        throw new Error('must not run');
      },
      setExitCode: code => exitCodes.push(code),
      writeError: message => errors.push(message),
      writeOutput: message => output.push(message),
    });
    assert.deepEqual(result, { exitCode: 2, result: null });
    assert.equal(inspected, false);
    assert.deepEqual(output, []);
    assert.deepEqual(errors, ['Usage: node scripts/verify-install-scripts.js']);
    assert.deepEqual(exitCodes, [2]);
    assert.equal(`${output.join('\n')}\n${errors.join('\n')}`.includes(hostile), false);
  }
});

test('new install scripts fail closed even when present in the lockfile', () => {
  const root = createFixture();
  try {
    const lockPath = 'node_modules/unapproved';
    const lockfilePath = path.join(root, 'package-lock.json');
    const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
    lockfile.packages[lockPath] = {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/unapproved/-/unapproved-1.0.0.tgz',
      integrity: 'sha512-unapproved',
      hasInstallScript: true,
    };
    fs.writeFileSync(lockfilePath, JSON.stringify(lockfile));
    const manifestPath = path.join(root, lockPath, 'package.json');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({
      name: 'unapproved',
      version: '1.0.0',
      scripts: { postinstall: 'node download.js' },
    }));

    const result = inspectInstallScriptPolicy(root);
    assert.equal(result.ok, false);
    assert.equal(result.failures.includes('Unapproved lifecycle package in package-lock.json.'), true);
    assert.equal(result.failures.includes('Unapproved installed lifecycle script.'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('approved package integrity and lifecycle command drift fail closed', () => {
  const root = createFixture();
  try {
    const approval = EXPECTED_INSTALL_SCRIPTS[0];
    const lockfilePath = path.join(root, 'package-lock.json');
    const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
    lockfile.packages[approval.lockPath].integrity = 'sha512-substituted';
    fs.writeFileSync(lockfilePath, JSON.stringify(lockfile));

    const manifestPath = path.join(root, approval.lockPath, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.scripts.install = 'node substituted.js';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const result = inspectInstallScriptPolicy(root);
    assert.equal(result.ok, false);
    assert.equal(result.failures.includes('Approved lifecycle lock metadata changed.'), true);
    assert.equal(result.failures.includes('Approved installed lifecycle script changed.'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('approved package version, resolved source, and lifecycle marker drift fail closed', () => {
  for (const [field, replacement] of [
    ['version', '0.0.0-substituted'],
    ['resolved', 'https://registry.npmjs.org/substituted/-/substituted-1.0.0.tgz'],
    ['hasInstallScript', false],
  ]) {
    const root = createFixture();
    try {
      const approval = EXPECTED_INSTALL_SCRIPTS[0];
      const lockfilePath = path.join(root, 'package-lock.json');
      const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
      lockfile.packages[approval.lockPath][field] = replacement;
      fs.writeFileSync(lockfilePath, JSON.stringify(lockfile));

      const result = inspectInstallScriptPolicy(root);
      assert.equal(result.ok, false, `${field} drift must fail closed`);
      assert.equal(result.failures.includes('Approved lifecycle lock metadata changed.'), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('package-tree symlinks and implicit install drift fail closed', () => {
  const root = createFixture();
  try {
    const symlinkPath = path.join(root, 'node_modules', 'unexpected-link');
    fs.symlinkSync('/tmp', symlinkPath);
    assert.equal(inspectInstallScriptPolicy(root).ok, false);
    fs.unlinkSync(symlinkPath);

    const nodeModulesPath = path.join(root, 'node_modules');
    const movedNodeModulesPath = path.join(root, 'node_modules-real');
    fs.renameSync(nodeModulesPath, movedNodeModulesPath);
    fs.symlinkSync(movedNodeModulesPath, nodeModulesPath);
    assert.equal(inspectInstallScriptPolicy(root).ok, false);
    fs.unlinkSync(nodeModulesPath);
    fs.renameSync(movedNodeModulesPath, nodeModulesPath);

    const approval = EXPECTED_INSTALL_SCRIPTS.find(item => item.implicitInstall);
    fs.rmSync(path.join(root, approval.lockPath, 'binding.gyp'));
    const result = inspectInstallScriptPolicy(root);
    assert.equal(result.ok, false);
    assert.equal(
      result.failures.includes('Approved installed lifecycle script changed.'),
      true
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('untargeted registry prepare metadata is inert while Canvas rebuild prepare fails closed', () => {
  const root = createFixture();
  try {
    const approved = EXPECTED_INSTALL_SCRIPTS.find(item => item.name === 'electron');
    const approvedManifestPath = path.join(root, approved.lockPath, 'package.json');
    const approvedManifest = JSON.parse(fs.readFileSync(approvedManifestPath, 'utf8'));
    approvedManifest.scripts.prepare = 'node unreviewed-prepare.js';
    fs.writeFileSync(approvedManifestPath, JSON.stringify(approvedManifest));

    let result = inspectInstallScriptPolicy(root);
    assert.equal(result.ok, true);

    const canvas = EXPECTED_INSTALL_SCRIPTS.find(item => item.name === 'canvas');
    const canvasManifestPath = path.join(root, canvas.lockPath, 'package.json');
    const canvasManifest = JSON.parse(fs.readFileSync(canvasManifestPath, 'utf8'));
    canvasManifest.scripts.prepare = 'node unreviewed-canvas-prepare.js';
    fs.writeFileSync(canvasManifestPath, JSON.stringify(canvasManifest));
    result = inspectInstallScriptPolicy(root);
    assert.equal(result.ok, false);
    assert.equal(result.failures.includes('Approved Canvas rebuild lifecycle changed.'), true);
    delete canvasManifest.scripts.prepare;
    fs.writeFileSync(canvasManifestPath, JSON.stringify(canvasManifest));

    const unapprovedLockPath = 'node_modules/unapproved-prepare';
    const lockfilePath = path.join(root, 'package-lock.json');
    const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
    lockfile.packages[unapprovedLockPath] = {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/unapproved-prepare/-/unapproved-prepare-1.0.0.tgz',
      integrity: 'sha512-unapproved',
    };
    fs.writeFileSync(lockfilePath, JSON.stringify(lockfile));
    const unapprovedManifestPath = path.join(root, unapprovedLockPath, 'package.json');
    fs.mkdirSync(path.dirname(unapprovedManifestPath), { recursive: true });
    fs.writeFileSync(unapprovedManifestPath, JSON.stringify({
      name: 'unapproved-prepare',
      version: '1.0.0',
      scripts: {
        prepare: 'node prepare.js',
        prepublish: 'node prepublish.js',
      },
    }));

    result = inspectInstallScriptPolicy(root);
    assert.equal(result.ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('root lifecycle hooks and substituted dependency executable links fail closed', () => {
  const root = createFixture();
  try {
    const rootManifestPath = path.join(root, 'package.json');
    const rootManifest = JSON.parse(fs.readFileSync(rootManifestPath, 'utf8'));
    rootManifest.scripts.prepare = 'node root-prepare.js';
    fs.writeFileSync(rootManifestPath, JSON.stringify(rootManifest));
    let result = inspectInstallScriptPolicy(root);
    assert.equal(result.ok, false);
    assert.equal(result.failures.includes('Root package lifecycle scripts are not approved.'), true);

    delete rootManifest.scripts.prepare;
    fs.writeFileSync(rootManifestPath, JSON.stringify(rootManifest));
    const linkPath = path.join(root, 'node_modules', '.bin', 'prebuild-install');
    fs.unlinkSync(linkPath);
    fs.symlinkSync('../canvas/index.js', linkPath);
    result = inspectInstallScriptPolicy(root);
    assert.equal(result.ok, false);
    assert.equal(result.failures.includes('Approved dependency executable links changed.'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('every root lifecycle trigger and implicit binding.gyp install fails closed', () => {
  for (const lifecycleName of EXPECTED_ROOT_LIFECYCLE_NAMES) {
    const root = createFixture();
    try {
      const manifestPath = path.join(root, 'package.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.scripts[lifecycleName] = `node root-${lifecycleName}.js`;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      const result = inspectInstallScriptPolicy(root);
      assert.equal(result.ok, false, lifecycleName);
      assert.equal(
        result.failures.includes('Root package lifecycle scripts are not approved.'),
        true,
        lifecycleName
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  const root = createFixture();
  try {
    fs.writeFileSync(path.join(root, 'binding.gyp'), '{}');
    const result = inspectInstallScriptPolicy(root);
    assert.equal(result.ok, false);
    assert.equal(result.failures.includes('Root package lifecycle scripts are not approved.'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Canvas build-tool path shadowing and missing approved shims fail closed', () => {
  const mutations = [
    root => fs.symlinkSync('../canvas/index.js', path.join(root, 'node_modules', '.bin', 'node')),
    root => {
      const localBin = path.join(root, 'node_modules', 'canvas', 'node_modules', '.bin');
      fs.mkdirSync(localBin, { recursive: true });
      fs.symlinkSync('../../../prebuild-install/bin.js', path.join(localBin, 'prebuild-install'));
    },
    root => fs.rmSync(path.join(root, 'node_modules', '.bin', 'node-gyp')),
    root => fs.rmSync(path.join(root, 'node_modules', '.bin', 'prebuild-install')),
    root => {
      const binRoot = path.join(root, 'node_modules', '.bin');
      const movedBinRoot = path.join(root, 'node_modules', '.bin-authenticated');
      fs.renameSync(binRoot, movedBinRoot);
      fs.symlinkSync('.bin-authenticated', binRoot);
    },
    root => {
      const shadowBin = path.join(root, 'node_modules', 'node_modules', '.bin');
      fs.mkdirSync(shadowBin, { recursive: true });
      fs.writeFileSync(path.join(shadowBin, 'node'), '#!/bin/sh\nexit 1\n');
    },
  ];

  for (const mutate of mutations) {
    const root = createFixture();
    try {
      mutate(root);
      const result = inspectInstallScriptPolicy(root);
      assert.equal(result.ok, false);
      assert.equal(
        result.failures.includes('Approved dependency executable links changed.'),
        true
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('Canvas lifecycle lookup rejects a shadow bin above the project root', () => {
  const fixture = createFixture();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-install-script-ancestor-'));
  const root = path.join(parent, 'project');
  try {
    fs.renameSync(fixture, root);
    const shadowBin = path.join(parent, 'node_modules', '.bin');
    fs.mkdirSync(shadowBin, { recursive: true });
    fs.writeFileSync(path.join(shadowBin, 'prebuild-install'), '#!/bin/sh\nexit 1\n');
    const result = inspectInstallScriptPolicy(root);
    assert.equal(result.ok, false);
    assert.equal(result.failures.includes('Approved dependency executable links changed.'), true);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('approved Canvas prebuild identity and inventory are immutable', () => {
  assert.deepEqual(APPROVED_CANVAS_PREBUILD, {
    fileName: 'canvas-v3.2.1-napi-v7-darwin-arm64.tar.gz',
    sha256: '01cc7a369a76cf5b1df94958b24c93202525e6eac9782aaa816c167527ccd140',
    size: 6865565,
    url: 'https://github.com/Automattic/node-canvas/releases/download/v3.2.1/canvas-v3.2.1-napi-v7-darwin-arm64.tar.gz',
  });
  assert.deepEqual(APPROVED_CANVAS_PREBUILD_DIRECTORIES, ['build/', 'build/Release/']);
  assert.equal(APPROVED_CANVAS_PREBUILD_FILES.includes('build/Release/canvas.node'), true);
  assert.equal(APPROVED_CANVAS_PREBUILD_FILES.includes('build/Release/libcairo.2.dylib'), true);
  assert.equal(APPROVED_CANVAS_PREBUILD_FILES.includes('build/Makefile'), true);
  assert.equal(APPROVED_CANVAS_PREBUILD_FILES.includes('build/Release/.forge-meta'), false);
});

test('approved Canvas archive installs atomically and remains byte-for-byte bound', () => {
  const fixture = createCanvasArchiveFixture();
  const projectRoot = path.join(fixture.root, 'project');
  const canvasRoot = path.join(projectRoot, 'node_modules', 'canvas');
  try {
    fs.mkdirSync(canvasRoot, { recursive: true });
    assert.equal(inspectApprovedCanvasPrebuild(fixture.archivePath, {
      policy: fixture.policy,
    }), true);
    installApprovedCanvasPrebuild(fixture.archivePath, projectRoot, {
      policy: fixture.policy,
    });
    assert.equal(canvasPrebuildMatchesInstalled(canvasRoot, fixture.archivePath, {
      policy: fixture.policy,
    }), true);

    fs.appendFileSync(path.join(canvasRoot, 'build', 'Release', 'canvas.node'), 'substituted');
    assert.equal(canvasPrebuildMatchesInstalled(canvasRoot, fixture.archivePath, {
      policy: fixture.policy,
    }), false);
    assert.throws(
      () => installApprovedCanvasPrebuild(fixture.archivePath, projectRoot, {
        policy: fixture.policy,
      }),
      /destination is not clean/u
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Canvas inspection uses one private authenticated archive snapshot', () => {
  const fixture = createCanvasArchiveFixture();
  try {
    const canonicalFixtureRoot = fs.realpathSync(fixture.root);
    let replaced = false;
    assert.equal(inspectApprovedCanvasPrebuild(fixture.archivePath, {
      policy: fixture.policy,
      temporaryParent: fixture.root,
      execFileSync(command, args, options) {
        if (!replaced) {
          fs.writeFileSync(fixture.archivePath, 'substituted after authentication');
          replaced = true;
        }
        assert.equal(args.at(-1).startsWith(`${canonicalFixtureRoot}${path.sep}`), true);
        assert.notEqual(args.at(-1), fixture.archivePath);
        const metadata = fs.lstatSync(args.at(-1));
        assert.equal(metadata.isFile(), true);
        assert.equal(metadata.mode & 0o077, 0);
        return execFileSync(command, args, options);
      },
    }), true);
    assert.equal(replaced, true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Canvas prebuild verification rejects archive, tree, and destination substitution', () => {
  const fixture = createCanvasArchiveFixture();
  try {
    const tamperedArchive = path.join(fixture.root, 'tampered.tar.gz');
    fs.copyFileSync(fixture.archivePath, tamperedArchive);
    fs.appendFileSync(tamperedArchive, 'substituted');
    assert.equal(inspectApprovedCanvasPrebuild(tamperedArchive, {
      policy: fixture.policy,
    }), false);

    const symlinkProject = path.join(fixture.root, 'symlink-project');
    const realCanvas = path.join(fixture.root, 'real-canvas');
    fs.mkdirSync(path.join(symlinkProject, 'node_modules'), { recursive: true });
    fs.mkdirSync(realCanvas, { recursive: true });
    fs.symlinkSync(realCanvas, path.join(symlinkProject, 'node_modules', 'canvas'));
    assert.throws(
      () => installApprovedCanvasPrebuild(fixture.archivePath, symlinkProject, {
        policy: fixture.policy,
      }),
      /destination is not clean/u
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Canvas install preserves external data when the destination changes during commit', () => {
  const fixture = createCanvasArchiveFixture();
  const projectRoot = path.join(fixture.root, 'project');
  const canvasRoot = path.join(projectRoot, 'node_modules', 'canvas');
  const victimRoot = path.join(fixture.root, 'external-victim');
  const sentinel = path.join(victimRoot, 'sentinel.txt');
  try {
    fs.mkdirSync(canvasRoot, { recursive: true });
    fs.mkdirSync(victimRoot);
    fs.writeFileSync(sentinel, 'must remain');
    assert.throws(
      () => installApprovedCanvasPrebuild(fixture.archivePath, projectRoot, {
        beforeCanvasCommit() {
          fs.symlinkSync(victimRoot, canvasRoot);
        },
        policy: fixture.policy,
      }),
      error => error.message === 'Canvas install destination changed during installation.'
    );
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'must remain');
    assert.equal(fs.lstatSync(canvasRoot).isSymbolicLink(), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Canvas install rolls back a committed build after post-commit validation fails', () => {
  const fixture = createCanvasArchiveFixture();
  const projectRoot = path.join(fixture.root, 'project');
  const canvasRoot = path.join(projectRoot, 'node_modules', 'canvas');
  const buildRoot = path.join(canvasRoot, 'build');
  const archiveBytes = fs.readFileSync(fixture.archivePath);
  try {
    fs.mkdirSync(canvasRoot, { recursive: true });
    assert.throws(
      () => installApprovedCanvasPrebuild(fixture.archivePath, projectRoot, {
        afterCanvasCommit() {
          fs.appendFileSync(fixture.archivePath, 'drift');
        },
        policy: fixture.policy,
      }),
      error => error.message === 'Canvas install destination changed during installation.'
    );
    assert.equal(fs.lstatSync(canvasRoot).isDirectory(), true);
    assert.equal(fs.existsSync(buildRoot), false);

    fs.writeFileSync(fixture.archivePath, archiveBytes);
    installApprovedCanvasPrebuild(fixture.archivePath, projectRoot, {
      policy: fixture.policy,
    });
    assert.equal(canvasPrebuildMatchesInstalled(canvasRoot, fixture.archivePath, {
      policy: fixture.policy,
    }), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Canvas restore races fail closed without touching replacement targets', () => {
  for (const boundary of ['before-restore', 'after-restore']) {
    const fixture = createCanvasArchiveFixture();
    const projectRoot = path.join(fixture.root, 'project');
    const canvasRoot = path.join(projectRoot, 'node_modules', 'canvas');
    const movedCanvasRoot = path.join(fixture.root, 'moved-canvas');
    const victimRoot = path.join(fixture.root, 'restore-victim');
    const sentinel = path.join(victimRoot, 'sentinel.txt');
    try {
      fs.mkdirSync(canvasRoot, { recursive: true });
      fs.mkdirSync(victimRoot);
      fs.writeFileSync(sentinel, 'must remain');
      const options = { policy: fixture.policy };
      if (boundary === 'before-restore') {
        options.beforeCanvasRestore = () => {
          fs.symlinkSync(victimRoot, canvasRoot);
        };
      } else {
        options.afterCanvasRestore = () => {
          fs.renameSync(canvasRoot, movedCanvasRoot);
          fs.symlinkSync(victimRoot, canvasRoot);
        };
      }
      assert.throws(
        () => installApprovedCanvasPrebuild(fixture.archivePath, projectRoot, options),
        error => error.message === 'Canvas install destination changed during installation.'
      );
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'must remain', boundary);
      assert.equal(fs.lstatSync(canvasRoot).isSymbolicLink(), true, boundary);
      if (boundary === 'after-restore') {
        assert.equal(fs.lstatSync(movedCanvasRoot).isDirectory(), true);
      }
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('Canvas install never deletes a raced build destination or post-commit victim', () => {
  for (const boundary of ['before-commit', 'after-commit']) {
    const fixture = createCanvasArchiveFixture();
    const projectRoot = path.join(fixture.root, 'project');
    const canvasRoot = path.join(projectRoot, 'node_modules', 'canvas');
    const victimRoot = path.join(fixture.root, 'victim');
    const sentinel = path.join(victimRoot, 'sentinel.txt');
    try {
      fs.mkdirSync(canvasRoot, { recursive: true });
      fs.mkdirSync(victimRoot);
      fs.writeFileSync(sentinel, 'must remain');
      const options = { policy: fixture.policy };
      if (boundary === 'before-commit') {
        options.beforeCanvasCommit = ({ isolatedCanvasRoot }) => {
          const racedBuild = path.join(isolatedCanvasRoot, 'build');
          fs.mkdirSync(racedBuild);
          fs.writeFileSync(path.join(racedBuild, 'attacker-sentinel.txt'), 'preserve');
        };
      } else {
        options.afterCanvasCommit = ({ isolatedCanvasRoot }) => {
          const installedBuild = path.join(isolatedCanvasRoot, 'build');
          fs.rmSync(installedBuild, { recursive: true });
          fs.symlinkSync(victimRoot, installedBuild);
        };
      }
      assert.throws(
        () => installApprovedCanvasPrebuild(fixture.archivePath, projectRoot, options),
        error => error.message === 'Canvas install destination changed during installation.'
      );
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'must remain', boundary);
      if (boundary === 'before-commit') {
        assert.equal(
          fs.readFileSync(path.join(canvasRoot, 'build', 'attacker-sentinel.txt'), 'utf8'),
          'preserve'
        );
      } else {
        assert.equal(fs.existsSync(path.join(canvasRoot, 'build')), false);
      }
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('Canvas temporary cleanup fails closed without traversing a substituted root', () => {
  const fixture = createCanvasArchiveFixture();
  const victimRoot = path.join(fixture.root, 'cleanup-victim');
  const sentinel = path.join(victimRoot, 'sentinel.txt');
  let movedRoot = null;
  let substitutedRoot = null;
  try {
    fs.mkdirSync(victimRoot);
    fs.writeFileSync(sentinel, 'must remain');
    assert.equal(inspectApprovedCanvasPrebuild(fixture.archivePath, {
      beforeTemporaryCleanup(temporaryRoot) {
        movedRoot = `${temporaryRoot}-moved`;
        substitutedRoot = temporaryRoot;
        fs.renameSync(temporaryRoot, movedRoot);
        fs.symlinkSync(victimRoot, temporaryRoot);
      },
      policy: fixture.policy,
      temporaryParent: fixture.root,
    }), false);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'must remain');
    assert.equal(fs.lstatSync(substitutedRoot).isSymbolicLink(), true);
  } finally {
    if (substitutedRoot) fs.rmSync(substitutedRoot, { force: true });
    if (movedRoot) fs.rmSync(movedRoot, { recursive: true, force: true });
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Canvas temporary cleanup unlinks descendant symlinks without touching their targets', () => {
  const fixture = createCanvasArchiveFixture();
  const victimRoot = path.join(fixture.root, 'cleanup-descendant-victim');
  const sentinel = path.join(victimRoot, 'sentinel.txt');
  try {
    fs.mkdirSync(victimRoot);
    fs.writeFileSync(sentinel, 'must remain');
    const result = collectApprovedCanvasPrebuildDigests(fixture.archivePath, {
      beforeTemporaryCleanup(temporaryRoot) {
        const releaseRoot = path.join(temporaryRoot, 'extracted', 'build', 'Release');
        fs.rmSync(releaseRoot, { recursive: true });
        fs.symlinkSync(victimRoot, releaseRoot);
      },
      policy: fixture.policy,
      temporaryParent: fixture.root,
    });
    assert.equal(result.valid, true);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'must remain');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Canvas installer CLI emits only fixed privacy-safe failures', () => {
  const privateFailure = '/Users/example/private/token CLOUDFLARE_API_TOKEN=secret';
  const output = [];
  const errors = [];
  const exitCodes = [];
  const result = runCanvasInstaller(['/private/archive.tar.gz'], {
    install() {
      throw new Error(privateFailure);
    },
    setExitCode: code => exitCodes.push(code),
    writeError: message => errors.push(message),
    writeOutput: message => output.push(message),
  });
  assert.deepEqual(result, { exitCode: 1 });
  assert.deepEqual(output, []);
  assert.deepEqual(errors, ['Approved Canvas archive installation failed.']);
  assert.deepEqual(exitCodes, [1]);
  assert.equal(errors.join('\n').includes(privateFailure), false);

  const usageErrors = [];
  const usageExitCodes = [];
  const hostile = '/Users/example/private/token\nsecret';
  const usage = runCanvasInstaller(['--help', hostile], {
    install() {
      throw new Error('must not run');
    },
    setExitCode: code => usageExitCodes.push(code),
    writeError: message => usageErrors.push(message),
  });
  assert.deepEqual(usage, { exitCode: 2 });
  assert.deepEqual(usageErrors, [
    'Usage: node scripts/install-approved-canvas-prebuild.js <archive>',
  ]);
  assert.deepEqual(usageExitCodes, [2]);
  assert.equal(usageErrors.join('\n').includes(hostile), false);
});
