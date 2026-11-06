import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createCloudflareTunnel,connectorReady} from '../cloudflare-tunnel.mjs';
import {createQuickService} from '../quick-service.mjs';

const URL='https://retained-test-address.trycloudflare.com',ORIGIN='http://127.0.0.1:18798';
function fixture(t,{legacy=true}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'her-tunnel-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let time=100000,live=legacy,publicOk=true,localOk=true,connectorOk=true,inspections=true,spawns=0,kills=0,publicCalls=0,provision;
  const info={pid:15151,startTime:'test-created-at',metricsPort:20241},published=[],logs=[];
  if(legacy)fs.writeFileSync(path.join(dir,'tunnel-url.txt'),URL+'\n');
  const options={stateDir:dir,executable:'test-cloudflared.exe',origin:ORIGIN,authToken:'test-pair-secret',now:()=>time,
    inspect:async()=>{if(!inspections)throw new Error('private command-like error');return live?[info]:[];},isAlive:()=>live,
    ready:async()=>connectorOk,allocatePort:async()=>20241,
    probe:async(url,opts)=>{assert.equal(opts.authToken,'test-pair-secret');if(url!==ORIGIN)publicCalls++;
      const ok=url===ORIGIN?localOk:publicOk;return {ok,checkedAt:time,ms:ok?12:8000,error:ok?'':'dns'};},
    quickService:async({onProvisioned})=>{provision=onProvisioned;return {url:'http://127.0.0.1:29999/private-test-route',close(){}};},
    spawnImpl:(exe,args,opts)=>{spawns++;assert.equal(opts.detached,true);assert.equal(opts.stdio,'ignore');assert.equal(args.includes('100000'),true);
      assert.equal(JSON.stringify(args).includes('test-pair-secret'),false);const child=new EventEmitter();child.pid=info.pid;child.unref=()=>{};child.kill=()=>{kills++;live=false;};
      live=true;queueMicrotask(()=>{provision({hostname:new URLClass(URL).hostname});child.emit('spawn');});return child;},
    onPublished:url=>published.push(url),log:line=>logs.push(line)};
  const create=(overrides={})=>{const instance=createCloudflareTunnel({...options,...overrides});t.after(()=>instance.close());return instance;};
  return {dir,info,published,logs,create,advance:ms=>time+=ms,public:ok=>publicOk=ok,local:ok=>localOk=ok,ready:ok=>connectorOk=ok,
    alive:ok=>live=ok,inspectable:ok=>inspections=ok,counts:()=>({spawns,kills,publicCalls})};
}
const URLClass=globalThis.URL;

test('repeated DNS/route failures and connector reconnecting preserve the original process and address',async t=>{
  const f=fixture(t),service=f.create();await service.start();assert.equal(service.snapshot().alive,true);
  f.public(false);f.ready(false);
  for(let i=0;i<8;i++){f.advance(45000);await service.check({force:true});}
  const offline=service.snapshot();assert.equal(offline.alive,false);assert.equal(offline.processAlive,true);assert.equal(offline.phase,'reconnecting');
  assert.equal(fs.readFileSync(path.join(f.dir,'tunnel-url.txt'),'utf8').trim(),URL);assert.deepEqual(f.counts(),{spawns:0,kills:0,publicCalls:9});
  f.public(true);f.ready(true);f.advance(5000);await service.check();assert.equal(service.snapshot().alive,true);assert.equal(service.snapshot().url,URL);
  assert.deepEqual(f.published,[URL]);
});
test('brain restart adopts the same connector and keeps the same URL, including an offline restart',async t=>{
  const f=fixture(t),first=f.create();await first.start();const descriptor=fs.readFileSync(path.join(f.dir,'tunnel-process.json'),'utf8');first.close();
  f.public(false);const second=f.create();await second.start();assert.equal(second.snapshot().alive,false);assert.equal(second.snapshot().processAlive,true);
  f.public(true);await second.check({force:true});assert.equal(second.snapshot().url,URL);assert.equal(second.snapshot().alive,true);
  assert.equal(fs.readFileSync(path.join(f.dir,'tunnel-process.json'),'utf8'),descriptor);assert.equal(f.counts().spawns,0);assert.equal(f.counts().kills,0);
});
test('local app maintenance is not a connector fault and a healthy connector is not proof of public availability',async t=>{
  const f=fixture(t),s=f.create();f.local(false);await s.start();assert.equal(s.snapshot().alive,false);assert.equal(s.snapshot().phase,'waiting-for-app');assert.equal(f.counts().publicCalls,0);
  f.local(true);f.public(false);await s.check({force:true});assert.equal(s.snapshot().connectorReady,true);assert.equal(s.snapshot().alive,false);
  f.public(true);await s.check({force:true});assert.equal(s.snapshot().alive,true);assert.equal(f.counts().spawns,0);
});
test('a genuinely exited connector restarts with bounded delay, publishes only paired success and stores no credentials',async t=>{
  const f=fixture(t),s=f.create();await s.start();f.alive(false);await s.check({force:true});assert.equal(s.snapshot().processAlive,false);
  await s.check({force:true});assert.equal(f.counts().spawns,0);f.advance(3000);f.public(false);await s.check({force:true});
  assert.equal(f.counts().spawns,1);assert.equal(s.snapshot().alive,false);f.public(true);await s.check({force:true});assert.equal(s.snapshot().alive,true);
  const record=fs.readFileSync(path.join(f.dir,'tunnel-process.json'),'utf8');assert.equal(/secret|private-test-route|authToken/i.test(record),false);assert.equal(f.counts().kills,0);
});
test('provisioning hostname received before process inspection is retained, but not published before verification',async t=>{
  const f=fixture(t,{legacy:false});f.public(false);const s=f.create();await s.start();assert.equal(s.snapshot().alive,false);assert.deepEqual(f.published,[]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'tunnel-process.json'),'utf8')).url,URL);
  f.public(true);await s.check({force:true});assert.equal(s.snapshot().url,URL);
});
test('reused PID or wrong creation time never adopts a stale descriptor or launches duplicate connectors',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.dir,'tunnel-process.json'),JSON.stringify({...f.info,startTime:'old-process-time',url:URL,origin:ORIGIN,executable:'test-cloudflared.exe'}));
  const s=f.create();await s.start();assert.equal(s.snapshot().alive,false);assert.equal(s.snapshot().error,'existing-connector-address-unknown');assert.equal(f.counts().spawns,0);
});
test('failed process inspection is conservative and does not spawn a second connector or expose private error details',async t=>{
  const f=fixture(t);f.inspectable(false);const s=f.create();await s.start();assert.equal(s.snapshot().alive,false);assert.equal(f.counts().spawns,0);
  assert.equal(JSON.stringify(s.snapshot()).includes('private'),false);assert.equal(f.logs.some(x=>x.includes('private')),false);
});
test('monitor closure leaves connector alive for the next monitor to adopt',async t=>{
  const f=fixture(t),s=f.create();await s.start();s.close();assert.equal(f.counts().kills,0);assert.equal(fs.existsSync(path.join(f.dir,'tunnel-process.json')),true);
  const next=f.create();await next.start();assert.equal(next.snapshot().alive,true);assert.equal(f.counts().spawns,0);
});
test('overlapping checks share one request and a late public success cannot publish after monitor closure',async t=>{
  const f=fixture(t);let finish,calls=0;
  const s=f.create({probe:async url=>{
    if(url===ORIGIN)return {ok:true,checkedAt:100000,ms:1,error:''};
    calls++;return new Promise(resolve=>{finish=()=>resolve({ok:true,checkedAt:100000,ms:1,error:''});});
  }});
  const started=s.start();while(!finish)await new Promise(resolve=>setImmediate(resolve));
  const pending=s.check({force:true});assert.equal(calls,1);s.close();finish();await Promise.all([started,pending]);
  assert.deepEqual(f.published,[]);assert.equal(s.snapshot().alive,false);assert.equal(f.counts().kills,0);
});
test('connector readiness distinguishes reconnection and refuses redirects/HTML/unexpected services',async()=>{
  for(const [response,expected] of [[new Response('{"status":200,"readyConnections":1}'),true],[new Response('{"status":503,"readyConnections":0}',{status:503}),false],
    [new Response('<html>warning</html>'),null],[new Response('{"status":200,"readyConnections":0}'),null],[new Response('{"ok":true}'),null]]){
    assert.equal(await connectorReady(20241,{fetchImpl:async(url,opts)=>{assert.equal(url,'http://127.0.0.1:20241/ready');assert.equal(opts.redirect,'error');return response;}}),expected);
  }
  assert.equal(await connectorReady(0),null);
});
test('provisioning observer sees only hostname while ephemeral credentials are relayed in memory',async t=>{
  let observed;const service=await createQuickService({onProvisioned:value=>observed=value,
    fetchImpl:async()=>new Response(JSON.stringify({success:true,result:{hostname:'test.trycloudflare.com',secret:'test-secret',account_tag:'test-account'}}))});t.after(()=>service.close());
  const r=await fetch(service.url+'/tunnel',{method:'POST'});assert.equal(r.status,200);assert.equal((await r.json()).result.secret,'test-secret');
  assert.deepEqual(observed,{hostname:'test.trycloudflare.com'});
});
