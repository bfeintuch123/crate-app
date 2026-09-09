const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const root=require('node:path').resolve(__dirname,'..');
const { CALLBACK } = require(root+'/account-config');
function gate(){let resolve;const promise=new Promise(r=>resolve=r);return{resolve,promise};}
const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
const ident=id=>({id,email:(id===A?'a':'b')+'@example.test',verified:true,methods:['google']});
function fixture(){
 let now=0,saved=null;const timers=new Set(),module={exports:{}};
 const timer=(fn,delay)=>{const t={fn,delay,unref(){}};timers.add(t);return t;};
 vm.runInNewContext(fs.readFileSync(root+'/account-session.js','utf8'),{module,require:n=>n==='./account-config'?require(root+'/account-config'):require(n),URL,URLSearchParams,structuredClone,setTimeout:timer,clearTimeout:t=>timers.delete(t)});
 const {AccountSession}=module.exports;
 const tokens=id=>({access_token:id,refresh_token:id,token_type:'bearer'});
 const provider={exchange:async code=>tokens(code),validate:async t=>({subject:t.access_token,expiresAt:now+100}),me:async t=>ident(t),refresh:async t=>tokens(t),revoke:async()=>{}};
 const session=new AccountSession({config:{issuer:'https://synthetic.invalid/auth/v1',clientId:'synthetic-client',redirectUri:'https://accounts.example.test/auth/desktop/callback'},provider,credentials:{write:r=>{saved=r;},read:()=>saved,clear:()=>{saved=null;}},openExternal:async()=>{},now:()=>now});
 const cb=id=>CALLBACK+'?code='+id+'&state='+session.pending.state;
 return{session,provider,tokens,cb,saved:()=>saved,isScheduled:t=>timers.has(t),tick:(n)=>{now=n;}};
}
test('regression: old access expiry must not enable A refresh to overwrite completed B sign-in',async()=>{
 const f=fixture();await f.session.begin();await f.session.callback(f.cb(A));const oldExpiry=f.session.accessTimer;
 f.provider.refresh=async()=>{throw {kind:'offline'};};await f.session.refresh();assert.equal(f.session.snapshot().state,'offline');
 const bGate=gate(),aGate=gate();f.provider.exchange=()=>bGate.promise;f.provider.refresh=()=>aGate.promise;
 await f.session.begin();const bOperation=f.session.callback(f.cb(B));assert.equal(f.session.snapshot().state,'verifying');
 assert.equal(f.isScheduled(oldExpiry),false);f.tick(101);oldExpiry.fn();assert.equal(f.session.snapshot().state,'verifying');
 let refreshCalls=0;f.provider.refresh=()=>{refreshCalls++;return aGate.promise;};
 const staleRefresh=f.session.refresh();assert.equal(refreshCalls,0);
 bGate.resolve(f.tokens(B));await bOperation;assert.equal(f.session.snapshot().identity.id,B);
 aGate.resolve(f.tokens(A));await staleRefresh;
 assert.equal(f.session.snapshot().identity.id,B,'newly accepted B identity must remain current');
});
test('regression: old access expiry must not replace completed logout with offline state',async()=>{
 const f=fixture();await f.session.begin();await f.session.callback(f.cb(A));const oldExpiry=f.session.accessTimer;
 await f.session.logout();assert.equal(f.session.snapshot().state,'signed_out');assert.equal(f.isScheduled(oldExpiry),false);f.tick(101);oldExpiry.fn();
 assert.equal(f.session.snapshot().state,'signed_out');
});

test('old expiry is inert while waiting; cancel rearms only a still-valid session',async()=>{
 for(const expired of [false,true]) {
  const f=fixture();await f.session.begin();await f.session.callback(f.cb(A));const oldExpiry=f.session.accessTimer;
  await f.session.begin();f.tick(expired?101:50);oldExpiry.fn();assert.equal(f.session.snapshot().state,'waiting');
  f.session.cancel();assert.equal(f.session.snapshot().canUseWorkspace,!expired);
  if(expired) assert.equal(f.session.accessTimer,null);
  else {const rearmed=f.session.accessTimer;assert.notEqual(rearmed,oldExpiry);assert.equal(f.isScheduled(rearmed),true);f.tick(101);rearmed.fn();assert.equal(f.session.snapshot().canUseWorkspace,false);assert.match(f.session.snapshot().message,/needs to be checked/);}
  f.session.shutdown();
 }
});
test('delayed old-account refresh success or failure cannot change accepted replacement credentials',async()=>{
 for(const failure of [false,true]) {
  const f=fixture();await f.session.begin();await f.session.callback(f.cb(A));
  const delayed=gate();f.provider.refresh=()=>delayed.promise;const refreshing=f.session.refresh();
  await f.session.begin();await f.session.callback(f.cb(B));const revision=f.session.snapshot().revision;
  // A rejected provider result uses the same stale-operation fence as a success.
  delayed.resolve(failure?Promise.reject({kind:'expired'}):f.tokens(A));await refreshing;
  assert.equal(f.session.snapshot().identity.id,B);assert.equal(f.saved().identity.id,B);assert.equal(f.saved().refreshToken,B);assert.equal(f.session.snapshot().revision,revision);
  f.session.shutdown();
 }
});
test('verification exclusion is independent of the display label',async()=>{
 const f=fixture();await f.session.begin();await f.session.callback(f.cb(A));const delayed=gate();f.provider.exchange=()=>delayed.promise;
 await f.session.begin();const operation=f.session.callback(f.cb(B));f.session.publish('offline');
 let refreshCalls=0;f.provider.refresh=async()=>{refreshCalls++;return f.tokens(A);};await f.session.refresh();assert.equal(refreshCalls,0);
 delayed.resolve(f.tokens(B));await operation;assert.equal(f.saved().identity.id,B);f.session.shutdown();
});
test('rotation followed by backend outage retains expiry for the old verified access token',async()=>{
 const f=fixture();await f.session.begin();await f.session.callback(f.cb(A));const expiry=f.session.accessTimer;
 f.provider.me=async()=>{throw {kind:'offline'};};await f.session.refresh();assert.equal(f.session.snapshot().canUseWorkspace,true);
 f.tick(101);expiry.fn();assert.equal(f.session.snapshot().canUseWorkspace,false);assert.match(f.session.snapshot().message,/needs to be checked/);f.session.shutdown();
});
