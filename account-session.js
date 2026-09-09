'use strict';
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { CALLBACK } = require('./account-config');
const ATTEMPT_MS = 10 * 60 * 1000;
const random = () => crypto.randomBytes(32).toString('base64url');
function parseCallback(input) {
  if (typeof input !== 'string' || input.length > 8192 || !input.startsWith(`${CALLBACK}?`)) throw Error('invalid_callback');
  const url = new URL(input);
  if (`${url.protocol}${url.pathname}` !== CALLBACK || url.host || url.hash) throw Error('invalid_callback');
  const allowed = ['code', 'state', 'error', 'error_description'];
  for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw Error('invalid_callback');
  const state = url.searchParams.get('state'); const code = url.searchParams.get('code'); const error = url.searchParams.get('error');
  if (!/^[A-Za-z0-9_-]{43}$/.test(state || '') || (!!code === !!error) || (code && (code.length > 2048 || /[\s\x00-\x1f]/.test(code)))) throw Error('invalid_callback');
  return { state, code, error };
}
function sanitizeIdentity(value) {
  if (!value || typeof value.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.id) || typeof value.email !== 'string' || value.email.length > 320 || value.verified !== true) throw Error('invalid_identity');
  return { id: value.id, email: value.email, name: typeof value.name === 'string' ? value.name.slice(0,160) : '',
    methods: Array.isArray(value.methods) ? [...new Set(value.methods.filter(x => ['google','email'].includes(x)))] : [], verified: true };
}
class AccountSession extends EventEmitter {
  constructor({ config, provider, credentials, openExternal, now = Date.now }) {
    super(); Object.assign(this, { config, provider, credentials, openExternal, now });
    this.generation = 0; this.pending = null; this.record = null; this.accessToken = null; this.refreshing = null;
    this.accessExpiresAt = 0; this.accessTimer = null; this.verifyingAttempt = null;
    this.revision = 0;
    this.status = { revision: 0, state: config ? 'signed_out' : 'unconfigured', identity: null, message: '' };
  }
  canUseWorkspace() { return !!(this.accessToken && this.record && this.now() < this.accessExpiresAt && ['signed_in', 'offline'].includes(this.status.state)); }
  snapshot() { return { ...structuredClone(this.status), canUseWorkspace: this.canUseWorkspace() }; }
  authorizeUntil(expiresAt) {
    this.accessExpiresAt = expiresAt; clearTimeout(this.accessTimer);
    const generation = this.generation, accessToken = this.accessToken;
    this.accessTimer = setTimeout(() => {
      if (generation !== this.generation || accessToken !== this.accessToken || expiresAt !== this.accessExpiresAt || this.pending || this.verifyingAttempt) return;
      if (this.accessToken && this.record && this.now() >= expiresAt) this.publish('offline', 'Your session needs to be checked. Connect to the internet to continue.');
    }, Math.max(1, expiresAt - this.now())); this.accessTimer.unref?.();
  }
  publish(state, message = '', identity = this.status.identity) { this.status = { revision: ++this.revision, state, identity, message }; this.emit('change', this.snapshot()); return this.snapshot(); }
  invalidate() { this.generation++; this.pending = null; clearTimeout(this.attemptTimer); clearTimeout(this.refreshTimer); clearTimeout(this.accessTimer); this.accessTimer = null; this.verifyingAttempt = null; this.refreshing = null; }
  async begin() {
    if (!this.config) return this.snapshot();
    this.invalidate(); const generation = this.generation;
    const verifier = random(), state = random(), nonce = random();
    const url = new URL(`${this.config.issuer}/oauth/authorize`);
    url.search = new URLSearchParams({ response_type: 'code', client_id: this.config.clientId, redirect_uri: this.config.redirectUri, scope: 'openid email profile', state, nonce, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
    this.pending = { verifier, state, nonce, url: url.href, expires: this.now() + ATTEMPT_MS, generation };
    this.attemptTimer = setTimeout(() => { if (this.generation === generation && this.pending) { this.invalidate(); this.publish('error', 'Sign-in timed out. Start again.'); } }, ATTEMPT_MS); this.attemptTimer.unref?.();
    this.publish('waiting'); return this.reopen();
  }
  async reopen() {
    const pending = this.pending; if (!pending) return this.snapshot();
    try { await this.openExternal(pending.url); }
    catch (_) { if (this.pending === pending) this.publish('waiting', 'The browser could not open. Try Open browser again, or cancel.'); }
    return this.snapshot();
  }
  cancel() {
    this.invalidate();
    if (this.record && this.accessToken && this.now() < this.accessExpiresAt) this.authorizeUntil(this.accessExpiresAt);
    return this.publish(this.record ? 'offline' : 'signed_out', 'Sign-in canceled.');
  }
  async callback(input) {
    let parsed; try { parsed = parseCallback(input); } catch (_) { return this.snapshot(); }
    const attempt = this.pending;
    if (!attempt) return ['signed_out','unconfigured'].includes(this.status.state) ? this.publish(this.status.state, 'This browser sign-in has no active request. Start sign-in again in Crate.') : this.snapshot();
    if (parsed.state !== attempt.state || this.now() >= attempt.expires) return this.snapshot();
    this.pending = null; clearTimeout(this.attemptTimer);
    const generation = this.generation;
    if (parsed.error) return this.publish('error', parsed.error === 'access_denied' ? 'Sign-in was canceled in the browser. Start again.' : 'The provider could not complete sign-in. Start again.');
    this.verifyingAttempt = attempt;
    this.publish('verifying');
    try {
      const tokens = await this.provider.exchange(parsed.code, attempt.verifier);
      if (generation !== this.generation) return this.snapshot();
      const verified = await this.provider.validate(tokens, { nonce: attempt.nonce });
      if (generation !== this.generation) return this.snapshot();
      const identity = sanitizeIdentity(await this.provider.me(tokens.access_token));
      if (generation !== this.generation) return this.snapshot();
      if (identity.id !== verified.subject) throw Error('identity_mismatch');
      const record = { refreshToken: tokens.refresh_token, identity };
      this.credentials.write(record); this.record = record; this.accessToken = tokens.access_token;
      this.authorizeUntil(verified.expiresAt); this.schedule(verified.expiresAt); return this.publish('signed_in', '', identity);
    } catch (_) { if (generation === this.generation) this.publish('error', 'Sign-in could not be verified or saved securely. Start again.'); return this.snapshot(); }
    finally { if (this.verifyingAttempt === attempt) this.verifyingAttempt = null; }
  }
  schedule(expiresAt) {
    clearTimeout(this.refreshTimer);
    const generation = this.generation, record = this.record;
    this.refreshTimer = setTimeout(() => { if (generation === this.generation && record === this.record) void this.refresh(); }, Math.max(1000, expiresAt - this.now() - 60000)); this.refreshTimer.unref?.();
  }
  async restore() {
    if (!this.config) return this.snapshot();
    const generation = this.generation;
    try { this.record = this.credentials.read(); if (this.record) this.publish('checking', '', sanitizeIdentity(this.record.identity)); }
    catch (_) { return this.publish('error', 'Saved sign-in could not be opened securely. Sign out, then sign in again.', null); }
    if (this.record && generation === this.generation) return this.refresh();
    return this.snapshot();
  }
  refresh() {
    if (this.refreshing) return this.refreshing;
    if (!this.record || this.pending || this.verifyingAttempt) return Promise.resolve(this.snapshot());
    const generation = this.generation, old = this.record;
    let expectedRecord = old;
    const isCurrent = () => generation === this.generation && this.record === expectedRecord && !this.pending && !this.verifyingAttempt;
    const operation = (async () => {
      try {
        const tokens = await this.provider.refresh(old.refreshToken);
        if (!isCurrent()) return this.snapshot();
        const verified = await this.provider.validate(tokens, { subject: old.identity.id });
        if (!isCurrent()) return this.snapshot();
        // Save rotation before the independent backend request; an outage must not lose it.
        const rotated = { refreshToken: tokens.refresh_token, identity: old.identity };
        this.credentials.write(rotated); this.record = rotated; expectedRecord = rotated;
        const identity = sanitizeIdentity(await this.provider.me(tokens.access_token));
        if (!isCurrent()) return this.snapshot();
        if (identity.id !== verified.subject) throw Error('identity_mismatch');
        this.record = { ...rotated, identity }; expectedRecord = this.record; this.credentials.write(this.record);
        this.accessToken = tokens.access_token; this.authorizeUntil(verified.expiresAt);
        this.schedule(verified.expiresAt); this.publish('signed_in', '', identity);
      } catch (error) {
        if (!isCurrent()) return this.snapshot();
        if (error.kind === 'expired') {
          this.record = null; this.accessToken = null;
          try { this.credentials.clear(); } catch (_) { this.publish('error', 'Sign-in expired and saved credentials could not be removed.', null); return this.snapshot(); }
          this.publish('expired', 'Sign in again to reconnect your account.', null);
        } else { this.publish('offline', this.canUseWorkspace() ? 'Account could not be checked online. Your verified session is still valid.' : 'Connect to the internet to verify your account and continue.'); this.schedule(this.now() + 120000); }
      }
      return this.snapshot();
    })();
    this.refreshing = operation;
    operation.finally(() => { if (this.refreshing === operation) this.refreshing = null; });
    return operation;
  }
  async logout() {
    const token = this.accessToken; this.invalidate(); const generation = this.generation;
    this.record = null; this.accessToken = null;
    let cleared = true; try { this.credentials?.clear(); } catch (_) { cleared = false; }
    this.publish(cleared ? 'signed_out' : 'error', cleared ? 'Signed out of Crate. Server revocation is not yet confirmed.' : 'Signed out in memory, but saved credentials could not be removed. Quit and resolve secure storage before reopening.', null);
    if (token) { try { await this.provider.revoke(token); if (generation === this.generation && cleared) this.publish('signed_out', 'Signed out of Crate.', null); } catch (_) {} }
    return this.snapshot();
  }
  async manage() { if (!this.config || !this.status.identity) return this.snapshot(); const url = new URL('/account', this.config.origin); url.searchParams.set('desktop_account', this.status.identity.id); try { await this.openExternal(url.href); } catch (_) { this.publish(this.status.state, 'Account page could not open. Try again.'); } return this.snapshot(); }
  shutdown() { clearTimeout(this.accessTimer); this.invalidate(); this.accessToken = null; this.record = null; }
}
module.exports = { AccountSession, parseCallback, sanitizeIdentity };
