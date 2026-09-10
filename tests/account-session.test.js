'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { AccountSession, parseCallback } = require('../account-session');
const { loadAccountConfig, CALLBACK, CALLBACK_SCHEME } = require('../account-config');
const identity = { id: '12345678-1234-1234-1234-123456789abc', email: 'pilot@example.test', name: 'Pilot', methods: ['google'], verified: true };
const config = loadAccountConfig({ CRATE_ACCOUNT_PROVIDER_URL: 'https://project.supabase.co', CRATE_ACCOUNT_WEB_ORIGIN: 'https://accounts.example.test', CRATE_ACCOUNT_CLIENT_ID: 'test-client', CRATE_ACCOUNT_PUBLIC_KEY: 'sb_publishable_synthetic_test_key_123' });
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture(t) {
  let saved = null, writes = 0, clears = 0; const opened = [];
  const tokens = { access_token: 'access', refresh_token: 'refresh', id_token: 'id', token_type: 'bearer' };
  const provider = { exchange: async () => tokens, validate: async () => ({ subject: identity.id, expiresAt: Date.now()+3600000 }), me: async () => identity, refresh: async () => tokens, revoke: async () => {} };
  const credentials = { write(value) { saved = structuredClone(value); writes++; }, read: () => saved, clear() { saved = null; clears++; } };
  const session = new AccountSession({ config, provider, credentials, openExternal: async url => opened.push(url) });
  t.after(() => session.shutdown());
  return { session, provider, credentials, tokens, opened, writes: () => writes, saved: () => saved, clears: () => clears };
}
const callback = state => `${CALLBACK}?code=one-time-code&state=${state}`;
async function login(f) { await f.session.begin(); await f.session.callback(callback(f.session.pending.state)); }
test('configuration rejects insecure/arbitrary callback origins and missing setup', () => {
  assert.equal(loadAccountConfig({}, path.join(__dirname, 'missing-account-config.json')), null);
  assert.equal(loadAccountConfig({ CRATE_ACCOUNT_PROVIDER_URL: 'http://project.supabase.co', CRATE_ACCOUNT_WEB_ORIGIN: 'https://accounts.example.test', CRATE_ACCOUNT_CLIENT_ID: 'test-client', CRATE_ACCOUNT_PUBLIC_KEY: 'sb_publishable_synthetic_test_key_123' }), null);
});
test('callbacks reject wrong route, duplicates, token fragments and unexpected parameters', () => {
  const valid = callback('a'.repeat(43)); assert.equal(parseCallback(valid).code, 'one-time-code');
  for (const value of [valid.replace('/oauth/callback','/elsewhere'), valid+'&state=other', valid+'#access_token=secret', valid+'&next=https://evil.test', valid.replace(`${CALLBACK_SCHEME}:`, 'https:'), valid+'&error=denied', valid.replace('one-time-code','')]) assert.throws(() => parseCallback(value));
});
test('reopening retains verifier, replacement invalidates old callback, success publishes no credentials', async t => {
  const f = fixture(t); await f.session.begin(); const first = f.session.pending;
  await f.session.reopen(); assert.equal(f.opened[0], f.opened[1]); assert.equal(first.verifier, f.session.pending.verifier);
  await f.session.begin(); await f.session.callback(callback(first.state)); assert.equal(f.writes(), 0);
  await f.session.callback(callback(f.session.pending.state)); assert.equal(f.session.snapshot().state, 'signed_in');
  assert.equal(f.writes(), 1); assert.equal(JSON.stringify(f.session.snapshot()).includes('refresh'), false);
});
test('duplicate callback exchanges only once', async t => {
  const f = fixture(t), wait = deferred(); let calls=0; f.provider.exchange = () => { calls++; return wait.promise; };
  await f.session.begin(); const cb = callback(f.session.pending.state); const operation = f.session.callback(cb); await f.session.callback(cb); wait.resolve(f.tokens); await operation; assert.equal(calls,1);
});
test('cancel/logout/new attempt synchronously fence delayed exchange', async t => {
  for (const action of ['cancel','logout','begin']) {
    const f=fixture(t), wait=deferred(); f.provider.exchange=()=>wait.promise;
    await f.session.begin(); const operation=f.session.callback(callback(f.session.pending.state)); await f.session[action](); wait.resolve(f.tokens); await operation; assert.equal(f.writes(),0,action); assert.notEqual(f.session.snapshot().state,'signed_in');
  }
});
test('logout during backend verification never persists identity', async t => {
  const f=fixture(t), wait=deferred(); f.provider.me=()=>wait.promise; await f.session.begin(); const operation=f.session.callback(callback(f.session.pending.state)); await new Promise(setImmediate); await f.session.logout(); wait.resolve(identity); await operation; assert.equal(f.writes(),0); assert.equal(f.session.snapshot().identity,null);
});
test('refresh coalesces requests, saves rotation before outage, retains last known identity honestly', async t => {
  const f=fixture(t); await login(f); const wait=deferred(); let calls=0;
  f.provider.refresh=()=>{calls++; return wait.promise;}; f.provider.me=async()=>{throw {kind:'offline'};};
  const a=f.session.refresh(), b=f.session.refresh(); assert.equal(a,b); wait.resolve({...f.tokens,refresh_token:'rotated'}); await a;
  assert.equal(calls,1); assert.equal(f.saved().refreshToken,'rotated'); assert.equal(f.session.snapshot().state,'offline');
});
test('refresh after logout cannot restore credentials and server outage preserves local logout', async t => {
  const f=fixture(t); await login(f); const wait=deferred(); f.provider.refresh=()=>wait.promise; f.provider.revoke=async()=>{throw Error('offline');};
  const operation=f.session.refresh(); await f.session.logout(); wait.resolve(f.tokens); await operation; assert.equal(f.saved(),null); assert.equal(f.session.snapshot().state,'signed_out'); assert.match(f.session.snapshot().message,/not yet confirmed/);
});
test('wrong backend identity and unverified users never persist', async t => {
  for (const value of [{...identity,id:'87654321-1234-1234-1234-123456789abc'}, {...identity,verified:false}]) { const f=fixture(t); f.provider.me=async()=>value; await login(f); assert.equal(f.writes(),0); assert.equal(f.session.snapshot().state,'error'); }
});
test('secure storage failures never report sign-in success', async t => {
  const f=fixture(t); f.credentials.write=()=>{throw Error('locked');}; await login(f); assert.equal(f.session.snapshot().state,'error'); assert.equal(f.session.snapshot().identity,null);
});
test('expired pending attempt does not exchange and provider denial is recoverable', async t => {
  const f=fixture(t); await f.session.begin(); const state=f.session.pending.state; f.session.pending.expires=0; await f.session.callback(callback(state)); assert.equal(f.writes(),0);
  await f.session.begin(); await f.session.callback(`${CALLBACK}?error=access_denied&state=${f.session.pending.state}`); assert.match(f.session.snapshot().message,/canceled/);
});
test('restore refreshes saved session; invalidated refresh clears identity without project IO', async t => {
  const f=fixture(t); f.credentials.write({ refreshToken:'saved',identity }); await f.session.restore(); assert.equal(f.session.snapshot().state,'signed_in'); f.provider.refresh=async()=>{throw {kind:'expired'};}; await f.session.refresh(); assert.equal(f.session.snapshot().state,'expired'); assert.equal(f.saved(),null);
});
test('cold callbacks require restart and never create an unsolicited session',async t=>{const f=fixture(t);await f.session.callback(callback('a'.repeat(43)));assert.equal(f.writes(),0);assert.equal(f.session.snapshot().state,'signed_out');assert.match(f.session.snapshot().message,/no active request/);});

test('account access requires verified tokens; cancellation and cached identity alone never unlock', async t => {
  const f = fixture(t);
  assert.equal(f.session.snapshot().canUseWorkspace, false);
  await f.session.begin(); f.session.cancel();
  assert.equal(f.session.snapshot().canUseWorkspace, false);
  f.credentials.write({refreshToken:'saved',identity});
  f.provider.refresh = async () => { throw {kind:'offline'}; };
  await f.session.restore();
  assert.equal(f.session.snapshot().state,'offline');
  assert.equal(f.session.snapshot().canUseWorkspace,false);
});
test('a transient outage can retain only a still-valid verified session; expiry and logout lock immediately', async t => {
  const f = fixture(t); await login(f);
  assert.equal(f.session.snapshot().canUseWorkspace,true);
  f.provider.refresh = async () => { throw {kind:'offline'}; };
  await f.session.refresh();
  assert.equal(f.session.snapshot().canUseWorkspace,true);
  f.session.now = () => f.session.accessExpiresAt + 1;
  assert.equal(f.session.snapshot().canUseWorkspace,false);
  await f.session.logout();
  assert.equal(f.session.snapshot().canUseWorkspace,false);
});
