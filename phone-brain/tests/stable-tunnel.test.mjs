import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {EventEmitter} from 'node:events';
import {createStableTunnel,stableEntryUrl,stableSshArguments} from '../stable-tunnel.mjs';import {savedPublicRoutes} from '../public-routes.mjs';
const origin='http://127.0.0.1:18975',url='https://synthetic-key-bound.tunnl.gg';
function fixture(t){const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'her-stable-'));t.after(()=>fs.rmSync(stateDir,{recursive:true,force:true}));let time=100000,alive=true,success=true,spawns=0;const row={pid:12345,startTime:'isolated-process'},key={keyFile:path.join(stateDir,'key'),keyFingerprint:'test-fingerprint'};
 const record=()=>fs.writeFileSync(path.join(stateDir,'stable-tunnel-process.json'),JSON.stringify({...row,...key,origin,url}));record();
 const create=(extra={})=>{const s=createStableTunnel({stateDir,origin,executable:'test-ssh.exe',authToken:'private-test-token',now:()=>time,identity:()=>key,isAlive:()=>alive,inspect:async()=>alive?[row]:[],
  probe:async(address,options)=>{assert.equal(options.authToken,'private-test-token');return {ok:address===origin||success,checkedAt:time,error:success?'':'timeout',ms:2};},
  spawnImpl:(exe,args,options)=>{spawns++;assert.equal(options.detached,true);assert.equal(options.stdio,'ignore');assert.ok(!JSON.stringify(args).includes('private-test-token'));alive=true;record();const p=new EventEmitter();p.pid=row.pid;p.unref=()=>{};queueMicrotask(()=>p.emit('spawn'));return p;},...extra});t.after(()=>s.close());return s;};
 return {stateDir,row,key,create,advance:n=>time+=n,alive:v=>alive=v,public:v=>success=v,spawns:()=>spawns,record};
}
test('stable service URLs and SSH options keep pairing data off the transport command',()=>{
 assert.equal(stableEntryUrl(url),url);for(const x of ['https://evil.test','https://x.tunnl.gg/?k=secret','http://x.tunnl.gg','https://x.tunnl.gg.evil.test'])assert.equal(stableEntryUrl(x),'');
 const args=stableSshArguments({stateDir:'test',keyFile:'test/key',origin});assert.ok(args.includes('stable@proxy.tunnl.gg'));assert.ok(args.includes('IdentitiesOnly=yes'));assert.ok(args.includes('80:127.0.0.1:18975'));
});
test('monitor replacement adopts the detached helper and preserves its verified address',async t=>{
 const f=fixture(t),a=f.create();await a.start();assert.equal(a.snapshot().alive,true);a.close();const b=f.create();await b.start();assert.equal(b.snapshot().url,url);assert.equal(f.spawns(),0);
 assert.ok(!fs.readFileSync(path.join(f.stateDir,'stable-tunnel-health.json'),'utf8').includes('private-test-token'));
});
test('after a full helper exit, a new process reuses the verified anchor even before probes succeed',async t=>{
 const f=fixture(t),a=f.create();await a.start();a.close();f.alive(false);f.public(false);const b=f.create();await b.start();assert.equal(f.spawns(),1);assert.equal(b.snapshot().alive,false);assert.equal(b.snapshot().url,url);assert.equal(b.snapshot().persistedVerified,true);
 f.public(true);await b.check({force:true});assert.equal(b.snapshot().alive,true);assert.equal(b.snapshot().url,url);
});
test('repeated network failures do not rotate the identity or spawn duplicate helpers',async t=>{
 const f=fixture(t),s=f.create();await s.start();f.public(false);for(let i=0;i<8;i++){f.advance(30000);await s.check({force:true});}assert.equal(s.snapshot().url,url);assert.equal(s.snapshot().alive,false);assert.equal(f.spawns(),0);
});
test('mismatched process creation time cannot be adopted',async t=>{
 const f=fixture(t),s=f.create({inspect:async()=>[{...f.row,startTime:'reused-pid'}]});await s.start();assert.equal(s.snapshot().alive,false);assert.equal(s.snapshot().error,'stable-helper-identity-unknown');assert.equal(f.spawns(),0);
});
test('old identity health cannot become a saved anchor and paired verification is required',async t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.stateDir,'stable-tunnel-health.json'),JSON.stringify({url,keyFingerprint:'another-key',lastHealthyAt:99999}));f.public(false);const s=f.create();await s.start();assert.equal(s.snapshot().url,'');assert.equal(s.snapshot().persistedVerified,false);
});
test('stable verified anchor survives reboot longer than a day and transient single-route lists',()=>{
 const anchor={url,stable:true,persistedVerified:true,alive:false,processAlive:false,lastHealthyAt:1},cloud={url:'https://cloud.example',alive:true,processAlive:true},lhr={url:'https://fallback.example',alive:true,processAlive:true};
 assert.deepEqual(savedPublicRoutes([anchor,cloud,lhr],200000000),[anchor,cloud]);assert.equal(anchor.alive,false);
});
