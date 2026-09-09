'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '..');

test('builder-transformed manifest retains general identity and separately packaged callback resource', async () => {
  const { createTransformer } = require('app-builder-lib/out/fileTransformer');
  const metadata = JSON.parse(await createTransformer(root, {}, {})(path.join(root, 'package.json')));
  assert.equal(Object.hasOwn(metadata, 'build'), false);
  assert.equal(metadata.productName, 'Crate');
  assert.equal(metadata.name, 'crate-app');
  const identity = require('../runtime-identity.json');
  assert.deepEqual(identity, { appId: 'com.crate.app', productName: 'Crate', callbackScheme: 'com.get-crate.app' });
  assert.equal(require('../account-config').CALLBACK_SCHEME, identity.callbackScheme);
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.doesNotMatch(main, /internal-app-profile|account-transport|runtimeAppId|configureInternalUserDataPath/);
});

test('installed builder performs custom metadata finalization and fuses before signing', () => {
  const builder = fs.readFileSync(require.resolve('app-builder-lib/out/platformPackager'), 'utf8');
  const start = builder.indexOf('await this.info.emitAfterPack(packContext)');
  const fuse = builder.indexOf('await this.doAddElectronFuses(packContext)', start);
  const sign = builder.indexOf('await this.doSignAfterPack(', start);
  assert.ok(start >= 0 && fuse > start && sign > fuse);
  const metadata = require('../package.json');
  assert.equal(metadata.build.afterPack, 'scripts/patch-helper-info-plists.js');
  assert.equal(metadata.build.afterSign, 'scripts/notarize.js');
  assert.deepEqual(require('../scripts/patch-helper-info-plists').STRICT_APP_TRANSPORT_SECURITY, { NSAllowsArbitraryLoads: false });
});
