const fs = require('fs');
const path = require('path');

const APPLE_EVENTS_USAGE_DESCRIPTION = 'Crate uses Automation to read open design documents and linked assets from apps like Adobe Illustrator while you are actively watching a project.';
const APPLE_EVENTS_USAGE_KEY = 'NSAppleEventsUsageDescription';

function escapePlistString(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function patchInfoPlistUsageDescription(plistPath, usageDescription = APPLE_EVENTS_USAGE_DESCRIPTION) {
  const original = fs.readFileSync(plistPath, 'utf8');
  const escapedDescription = escapePlistString(usageDescription);
  const existingKeyPattern = new RegExp(`(<key>${APPLE_EVENTS_USAGE_KEY}</key>\\s*<string>)([\\s\\S]*?)(</string>)`);
  if (existingKeyPattern.test(original)) {
    const next = original.replace(existingKeyPattern, `$1${escapedDescription}$3`);
    if (next !== original) fs.writeFileSync(plistPath, next, 'utf8');
    return next !== original;
  }

  const insertion = `\n\t<key>${APPLE_EVENTS_USAGE_KEY}</key>\n\t<string>${escapedDescription}</string>\n`;
  const dictCloseIndex = original.lastIndexOf('</dict>');
  if (dictCloseIndex === -1) {
    throw new Error(`Cannot patch ${APPLE_EVENTS_USAGE_KEY}: plist missing </dict>`);
  }
  const next = `${original.slice(0, dictCloseIndex)}${insertion}${original.slice(dictCloseIndex)}`;
  fs.writeFileSync(plistPath, next, 'utf8');
  return true;
}

function findInfoPlists(rootDir, results = []) {
  if (!fs.existsSync(rootDir)) return results;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      findInfoPlists(entryPath, results);
      continue;
    }
    if (entry.isFile() && entry.name === 'Info.plist') {
      results.push(entryPath);
    }
  }
  return results;
}

function isHelperInfoPlist(appBundlePath, plistPath) {
  const relativePath = path.relative(appBundlePath, plistPath);
  if (relativePath.startsWith('..')) return false;
  return relativePath.includes(`${path.sep}Frameworks${path.sep}`) &&
    relativePath.endsWith(`${path.sep}Contents${path.sep}Info.plist`) &&
    relativePath.includes('.app');
}

function patchHelperInfoPlists(appBundlePath, usageDescription = APPLE_EVENTS_USAGE_DESCRIPTION) {
  const frameworksDir = path.join(appBundlePath, 'Contents', 'Frameworks');
  const patched = [];
  for (const plistPath of findInfoPlists(frameworksDir)) {
    if (!isHelperInfoPlist(appBundlePath, plistPath)) continue;
    if (patchInfoPlistUsageDescription(plistPath, usageDescription)) {
      patched.push(plistPath);
    }
  }
  return patched;
}

function resolveAppBundlePath(context = {}) {
  const appOutDir = context.appOutDir;
  if (!appOutDir) return null;
  const productFilename = context.packager &&
    context.packager.appInfo &&
    context.packager.appInfo.productFilename;
  if (productFilename) {
    const candidate = path.join(appOutDir, `${productFilename}.app`);
    if (fs.existsSync(candidate)) return candidate;
  }
  const appBundle = fs.readdirSync(appOutDir)
    .find(entry => entry.endsWith('.app') && fs.statSync(path.join(appOutDir, entry)).isDirectory());
  return appBundle ? path.join(appOutDir, appBundle) : null;
}

async function afterPack(context) {
  if (context.electronPlatformName && context.electronPlatformName !== 'darwin') return;
  const appBundlePath = resolveAppBundlePath(context);
  if (!appBundlePath) return;
  patchHelperInfoPlists(appBundlePath);
}

module.exports = afterPack;
module.exports.APPLE_EVENTS_USAGE_DESCRIPTION = APPLE_EVENTS_USAGE_DESCRIPTION;
module.exports.patchInfoPlistUsageDescription = patchInfoPlistUsageDescription;
module.exports.patchHelperInfoPlists = patchHelperInfoPlists;
module.exports.resolveAppBundlePath = resolveAppBundlePath;
