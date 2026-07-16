'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const NOTARYTOOL_KEYCHAIN_PROFILE = 'crate-release-notarytool';

function loadNotarizeRuntime(dependencies) {
  const notarizeEntry = require.resolve('@electron/notarize');
  const notarizeDebug = dependencies.notarizeDebug || require(require.resolve('debug', {
    paths: [path.dirname(notarizeEntry)],
  }));
  const submit = dependencies.notarize || require('@electron/notarize').notarize;
  if (typeof submit !== 'function' || !notarizeDebug) throw new Error('invalid notarization runtime');
  return { notarizeDebug, submit };
}

async function withoutNotarizeDebug(callback, notarizeDebug) {
  const previousNamespaces = notarizeDebug.disable();
  const privateNamespaces = [previousNamespaces, '-electron-notarize*'].filter(Boolean).join(',');
  notarizeDebug.enable(privateNamespaces);
  try {
    return await callback();
  } finally {
    notarizeDebug.enable(previousNamespaces);
  }
}

function publicNotarizationError(message) {
  const error = new Error(message);
  error.stack = message;
  return error;
}

function resolveSignedAppPath(context) {
  try {
    if (!context || typeof context !== 'object') throw new Error('invalid context');
    const { electronPlatformName } = context;
    if (typeof electronPlatformName !== 'string') throw new Error('invalid platform');
    if (electronPlatformName !== 'darwin') return null;

    const { appOutDir } = context;
    const appName = context.packager && context.packager.appInfo &&
      context.packager.appInfo.productFilename;
    if (typeof appOutDir !== 'string' || !path.isAbsolute(appOutDir)) {
      throw new Error('invalid app output directory');
    }
    if (typeof appName !== 'string' || !appName || path.basename(appName) !== appName) {
      throw new Error('invalid app name');
    }
    return path.join(appOutDir, `${appName}.app`);
  } catch (error) {
    throw publicNotarizationError(
      '[notarize] Signed app could not be prepared for Apple notarization.'
    );
  }
}

async function notarizing(context, dependencies = {}) {
  const appPath = resolveSignedAppPath(context);
  if (!appPath) return;
  const runFile = dependencies.execFileSync || execFileSync;

  console.log('[notarize] Submitting signed app to Apple...');

  try {
    const runtime = loadNotarizeRuntime(dependencies);
    await withoutNotarizeDebug(() => {
      return runtime.submit({
        tool: 'notarytool',
        appPath,
        keychainProfile: NOTARYTOOL_KEYCHAIN_PROFILE,
      });
    }, runtime.notarizeDebug);
  } catch (error) {
    throw publicNotarizationError(
      '[notarize] Signed app could not be submitted and accepted by Apple.'
    );
  }

  console.log('[notarize] Stapling accepted ticket to signed app...');
  try {
    runFile('/usr/bin/xcrun', ['stapler', 'staple', appPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runFile('/usr/bin/xcrun', ['stapler', 'validate', appPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw publicNotarizationError(
      '[notarize] Accepted ticket could not be stapled and validated.'
    );
  }
  console.log('[notarize] Accepted ticket stapled and validated.');
}

exports.default = notarizing;
exports.NOTARYTOOL_KEYCHAIN_PROFILE = NOTARYTOOL_KEYCHAIN_PROFILE;
exports.notarizing = notarizing;
exports.withoutNotarizeDebug = withoutNotarizeDebug;
