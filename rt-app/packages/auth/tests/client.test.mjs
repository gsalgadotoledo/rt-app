import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionClient} from '../dist/client.js';

// Deterministic harness: manual clock and timers, in-memory storage, a scripted API.
function harness({storage=memoryStorage(),channel=null,locks=null,server}={}){
  let now=1_000_000;const timers=new Map();let nextTimer=1;const calls=[];
  const api=server??fakeServer();
  const client=createSessionClient({
    baseUrl:'https://api.test',storage,channel,locks,now:()=>now,
    fetch:async(url,init={})=>{calls.push({url,init});return api.handle(url,init);},
    setTimeout:(callback,ms)=>{const id=nextTimer++;timers.set(id,{callback,at:now+ms});return id;},
    clearTimeout:id=>timers.delete(id),
  });
  return {client,calls,api,storage,
    advance(ms){now+=ms;for(const [id,t] of [...timers]) if(t.at<=now){timers.delete(id);t.callback();}},
    timers,get now(){return now;}};
}
function memoryStorage(){const map=new Map();return {getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k),map};}
function json(status,body){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});}
// Accepts the newest refresh token only; access tokens are "access-<n>".
function fakeServer(){
  let generation=1;const state={refreshes:0,fail:null,valid:new Set(['access-1'])};
  return {state,
    session(n=generation){return {token:'access-'+n,expiresIn:900,refreshToken:'refresh-'+n,sessionId:'s1',user:{id:'u'}};},
    async handle(url,init){
      if(url.endsWith('/auth/refresh')){
        state.refreshes++;
        await new Promise(r=>setTimeout(r,5));
        if(state.fail) return json(state.fail,{error:'Invalid session'});
        const {refreshToken}=JSON.parse(init.body);
        if(refreshToken!=='refresh-'+generation) return json(401,{error:'Invalid session'});
        generation++;state.valid.add('access-'+generation);return json(200,this.session());
      }
      const auth=new Headers(init.headers).get('authorization');
      if(url.endsWith('/wrong-password')) return json(401,{error:'Incorrect password'});
      if(!auth||!state.valid.has(auth.slice(7))) return json(401,{error:'Invalid session'});
      return json(200,{ok:true,auth});
    }};
}

test('stores the session, refreshes ~90 s before expiry and survives a reload from storage',async()=>{
  const h=harness();
  h.client.set(h.api.session());
  assert.equal(JSON.parse(h.storage.map.get('rt-app.session')).accessExpiresAt,h.now+900000);
  const seen=[];h.client.subscribe(s=>seen.push(s?.token));
  h.advance(900000-90000);
  await new Promise(r=>setTimeout(r,20));
  assert.equal(h.client.session.token,'access-2');
  assert.deepEqual(seen,['access-2']);
  const reloaded=createSessionClient({baseUrl:'https://api.test',storage:h.storage,channel:null,locks:null,setTimeout:()=>0,clearTimeout:()=>{}});
  assert.equal(reloaded.session.refreshToken,'refresh-2');
  h.client.dispose();reloaded.dispose();
});

test('concurrent callers share one refresh and a session 401 is retried once',async()=>{
  const h=harness();
  h.client.set({...h.api.session(),accessExpiresAt:h.now+1000});
  const [a,b,c]=await Promise.all([h.client.api('/users/me'),h.client.api('/users/me'),h.client.refresh()]);
  assert.equal(h.api.state.refreshes,1);
  assert.equal(a.auth,'Bearer access-2');assert.equal(b.auth,'Bearer access-2');assert.equal(c.token,'access-2');
  // The server revoked the access token early (e.g. clock skew): refresh once, then retry.
  h.api.state.valid.delete('access-2');
  assert.equal((await h.client.api('/users/me')).auth,'Bearer access-3');
  assert.equal(h.api.state.refreshes,2);
  h.client.dispose();
});

test('other 401s pass through without refreshing or signing out',async()=>{
  const h=harness();h.client.set(h.api.session());
  await assert.rejects(h.client.api('/wrong-password','POST',{}),e=>e.status===401&&e.message==='Incorrect password');
  assert.equal(h.api.state.refreshes,0);assert.ok(h.client.session);
  h.client.dispose();
});

test('a rejected refresh signs out; network and server errors keep the session and retry',async()=>{
  const h=harness();h.client.set(h.api.session());
  h.api.state.fail=503;
  await assert.rejects(h.client.refresh(),e=>e.status===503);
  assert.ok(h.client.session);
  h.advance(900000-90000);await new Promise(r=>setTimeout(r,20));
  assert.ok([...h.timers.values()].some(t=>t.at===h.now+30000),'retries in 30 s');
  h.api.state.fail=401;
  h.api.state.valid.clear();
  await assert.rejects(h.client.api('/users/me'),e=>e.status===401);
  assert.equal(h.client.session,undefined);
  assert.equal(h.storage.map.has('rt-app.session'),false);
  h.client.dispose();
});

test('sessions without a refresh token behave as before: a session 401 signs out',async()=>{
  const h=harness({storage:null});
  h.client.set({token:'root-token',user:{id:'rt-app-root'}});
  await assert.rejects(h.client.api('/admin/modules'),e=>e.status===401);
  assert.equal(h.client.session,undefined);
  assert.equal(h.timers.size,0);
  h.client.dispose();
});

test('tabs of the same session adopt rotations and sign-outs through the channel and a lock',async()=>{
  const listeners=new Set();
  const channel=()=>{const c={onmessage:null,postMessage(m){for(const other of listeners) if(other!==c) other.onmessage?.({data:structuredClone(m)});},close(){listeners.delete(c);}};listeners.add(c);return c;};
  let queue=Promise.resolve();const locks={request:(_name,callback)=>{const run=queue.then(callback);queue=run.catch(()=>{});return run;}};
  const server=fakeServer();
  const a=harness({channel,locks,server,storage:memoryStorage()}),b=harness({channel,locks,server,storage:memoryStorage()});
  a.client.set({...server.session(),accessExpiresAt:a.now+1000});
  b.client.set({...server.session(),accessExpiresAt:b.now+1000});
  await Promise.all([a.client.refresh(),b.client.refresh()]);
  assert.equal(server.state.refreshes,1,'the second tab reuses the rotation it received');
  assert.equal(a.client.session.refreshToken,'refresh-2');assert.equal(b.client.session.refreshToken,'refresh-2');
  a.client.set(undefined);
  assert.equal(b.client.session,undefined);
  const other=harness({channel,server});other.client.set({...server.session(),sessionId:'another'});
  a.client.set({...server.session(),sessionId:'third'});
  assert.equal(other.client.session.sessionId,'another','other sessions are left alone');
  for(const x of [a,b,other]) x.client.dispose();
});

test('absolute URLs, custom refresh paths and dynamic base URLs',async()=>{
  const calls=[];let base='https://one.test';
  const client=createSessionClient({baseUrl:()=>base,refreshPath:'/admin/identity/auth/refresh',channel:null,locks:null,setTimeout:()=>0,clearTimeout:()=>{},
    fetch:async(url,init)=>{calls.push([url,new Headers(init.headers).get('authorization')]);return url.endsWith('/refresh')?json(200,{token:'t2',refreshToken:'r2',sessionId:'s'}):json(200,{});}});
  client.set({token:'t1',refreshToken:'r1',sessionId:'s',expiresIn:1});
  await client.fetch('https://elsewhere.test/api/setup/status');
  base='https://two.test';await client.api('/x');
  assert.deepEqual(calls.map(c=>c[0]),['https://one.test/admin/identity/auth/refresh','https://elsewhere.test/api/setup/status','https://two.test/x']);
  assert.equal(calls[1][1],'Bearer t2');
  assert.equal(await client.accessToken(),'t2');
  client.dispose();
});
