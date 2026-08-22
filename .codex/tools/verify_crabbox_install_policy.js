'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const projectRoot = path.resolve(__dirname, '..', '..');
const policy = require(path.join(projectRoot, 'scripts', 'verify-install-scripts.js'));

function fail(message) {
  console.error(`Crabbox install-script policy failed: ${message}`);
  process.exit(1);
}

if (process.platform !== 'linux') {
  fail(`expected Linux, received ${process.platform}`);
}

const result = policy.inspectInstallScriptPolicy(projectRoot);
const expectedLinuxFailure = ['Approved installed lifecycle script changed.'];
if (result.ok || !isDeepStrictEqual(result.failures, expectedLinuxFailure)) {
  fail(result.ok ? 'the macOS policy unexpectedly passed' : result.failures.join(' '));
}

const fseventsApproval = policy.APPROVED_INSTALL_SCRIPTS.find(item => item.name === 'fsevents');
if (!fseventsApproval) fail('the approved fsevents policy entry is missing');
if (fs.existsSync(path.join(projectRoot, fseventsApproval.lockPath))) {
  fail('the Darwin-only fsevents package was unexpectedly installed on Linux');
}

for (const approval of policy.APPROVED_INSTALL_SCRIPTS.filter(item => item.name !== 'fsevents')) {
  let manifest;
  const packageRoot = path.join(projectRoot, approval.lockPath);
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  } catch (error) {
    fail(`approved package ${approval.name} could not be inspected`);
  }
  if (manifest.name !== approval.name || manifest.version !== approval.version ||
      !isDeepStrictEqual(policy.lifecycleScripts(manifest), approval.scripts) ||
      policy.implicitInstallBehavior(packageRoot, manifest) !== approval.implicitInstall) {
    fail(`approved package ${approval.name} changed`);
  }
}

console.log(
  'Crabbox install-script policy passed: macOS policy intact; Darwin-only fsevents omitted on Linux.'
);
