'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { createAccountProvider } = require('../account-provider');
const config={issuer:'https://project.supabase.co/auth/v1',origin:'https://accounts.example.test',clientId:'test-client',publicKey:'sb_publishable_synthetic_test_key_123',redirectUri:'https://accounts.example.test/auth/desktop/callback'};
test('real signature verification rejects wrong issuer, audience, client, nonce, subject and expiry',async()=>{
 const {generateKeyPair,exportJWK,SignJWT}=await import('jose'); const {privateKey,publicKey}=await generateKeyPair('ES256'); const jwk={...await exportJWK(publicKey),kid:'test-key',alg:'ES256',use:'sig'};
 const provider=createAccountProvider(config,async()=>new Response(JSON.stringify({keys:[jwk]}),{status:200,headers:{'Content-Type':'application/json'}}));
 const sign=(claims,aud=config.clientId)=>new SignJWT(claims).setProtectedHeader({alg:'ES256',kid:'test-key'}).setIssuedAt().setExpirationTime('5m').setIssuer(config.issuer).setAudience(aud).setSubject('test-user').sign(privateKey);
 const access=await sign({client_id:config.clientId,session_id:'session'},'authenticated'); const id=await sign({nonce:'expected'});
 const tokens={access_token:access,id_token:id,refresh_token:'refresh',token_type:'bearer'};
 assert.equal((await provider.validate(tokens,{nonce:'expected'})).subject,'test-user');
 await assert.rejects(provider.validate(tokens,{nonce:'wrong'})); await assert.rejects(provider.validate(tokens,{subject:'wrong'}));
 for(const bad of [await sign({client_id:'wrong',session_id:'session'},'authenticated'),await sign({client_id:config.clientId,session_id:'session'},'wrong'),await new SignJWT({client_id:config.clientId,session_id:'session'}).setProtectedHeader({alg:'ES256',kid:'test-key'}).setIssuedAt().setIssuer('https://wrong.test').setAudience('authenticated').setSubject('test-user').setExpirationTime('5m').sign(privateKey),await new SignJWT({client_id:config.clientId,session_id:'session'}).setProtectedHeader({alg:'ES256',kid:'test-key'}).setIssuedAt().setIssuer(config.issuer).setAudience('authenticated').setSubject('test-user').setExpirationTime(1).sign(privateKey)]) await assert.rejects(provider.validate({...tokens,access_token:bad},{nonce:'expected'}));
 await assert.rejects(provider.validate({...tokens,access_token:access.slice(0,-8)+'tampered'},{nonce:'expected'}));
});
test('public-client token requests preserve PKCE and reject redirects/oversize/network failures',async()=>{
 let observed; const provider=createAccountProvider(config,async(url,options)=>{observed={url,options};return new Response(JSON.stringify({access_token:'token'}));});
 await provider.exchange('one-time-code','verifier'); assert.equal(observed.url,`${config.issuer}/oauth/token`); assert.equal(observed.options.body.get('code_verifier'),'verifier'); assert.equal(observed.options.body.has('client_secret'),false); assert.equal(observed.options.redirect,'error');
 const large=createAccountProvider(config,async()=>new Response('x'.repeat(70000))); await assert.rejects(large.me('access'));
 const offline=createAccountProvider(config,async()=>{throw Error('network')}); await assert.rejects(offline.me('access'),{kind:'offline'});
});

test('logout supplies the public gateway key and revokes only the presented session', async () => {
 const sessions = new Set(['current-access','other-access']);
 const provider = createAccountProvider(config, async (url, options) => {
  assert.equal(url, config.issuer + '/logout?scope=local');
  assert.equal(options.method,'POST'); assert.equal(options.redirect,'error');
  if (options.headers.apikey !== config.publicKey) return new Response(null,{status:401});
  sessions.delete(options.headers.Authorization.slice(7));
  return new Response(null,{status:204});
 });
 await provider.revoke('current-access');
 assert.deepEqual([...sessions],['other-access']);
 const missing = createAccountProvider({...config,publicKey:undefined},async (_url,options) => new Response(null,{status:options.headers.apikey ? 204 : 401}));
 await assert.rejects(missing.revoke('current-access'));
});
