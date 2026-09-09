'use strict';

function authError(kind) { const error = new Error(kind); error.kind = kind; return error; }
function createAccountProvider(config, fetch = globalThis.fetch) {
  let keys;
  async function request(url, options = {}) {
    let response;
    try { response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000), cache: 'no-store' }); }
    catch (_) { throw authError('offline'); }
    if (!response.ok) throw authError([400,401,403].includes(response.status) ? 'expired' : 'offline');
    if (Number(response.headers.get('content-length')) > 65536) throw authError('invalid_response');
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 65536) throw authError('invalid_response'); chunks.push(Buffer.from(value)); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) { throw authError(error.kind || 'invalid_response'); }
    finally { await reader.cancel().catch(() => {}); }
  }
  async function validate(tokens, { nonce, subject } = {}) {
    if (tokens.token_type?.toLowerCase() !== 'bearer' || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token || tokens.refresh_token.length > 16384) throw authError('invalid_response');
    const { createRemoteJWKSet, jwtVerify, customFetch } = await import('jose');
    keys ||= createRemoteJWKSet(new URL(`${config.issuer}/.well-known/jwks.json`), { timeoutDuration: 15000, [customFetch]: fetch });
    const options = { issuer: config.issuer, algorithms: ['RS256', 'ES256'], requiredClaims: ['exp','iat','sub'] };
    const { payload } = await jwtVerify(tokens.access_token, keys, { ...options, audience: 'authenticated' });
    if (payload.client_id !== config.clientId || !payload.session_id || (subject && payload.sub !== subject)) throw authError('invalid_response');
    if (nonce || tokens.id_token) {
      const { payload: id } = await jwtVerify(tokens.id_token, keys, { ...options, audience: config.clientId });
      if (id.sub !== payload.sub || (nonce && id.nonce !== nonce)) throw authError('invalid_response');
    }
    return { subject: payload.sub, expiresAt: payload.exp * 1000 };
  }
  const token = params => request(`${config.issuer}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...params, client_id: config.clientId }) });
  return {
    exchange: (code, verifier) => token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: config.redirectUri }),
    refresh: refreshToken => token({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    validate,
    me: accessToken => request(`${config.origin}/api/account/me`, { headers: { Authorization: `Bearer ${accessToken}` } }),
    async revoke(accessToken) {
      const response = await fetch(`${config.issuer}/logout?scope=local`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, apikey: config.publicKey }, redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw authError('offline');
    }
  };
}
module.exports = { createAccountProvider };
