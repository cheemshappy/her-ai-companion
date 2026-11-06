/** Key-bound stable HTTPS entry. The detached helper owns SSH; the brain only verifies availability. */
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';import {probeTunnel} from './tunnel-health.mjs';import {inspectStableHelpers,inspectStableSsh,connectorAlive} from './connector-process.mjs';
export const stableEntryUrl=value=>/^https:\/\/[a-z0-9-]+\.tunnl\.gg$/.test(String(value))?String(value):'';
export function stableIdentity({stateDir,executable}){
 const keyFile=path.join(stateDir,'remote-entry-service-ed25519'),pubFile=keyFile+'.pub',keygen=path.join(path.dirname(executable),'ssh-keygen.exe');
 if(!fs.existsSync(keyFile)){
  if(fs.existsSync(pubFile)||fs.existsSync(path.join(stateDir,'stable-tunnel-health.json')))throw Error('stable-private-key-missing');
  execFileSync(keygen,['-q','-t','ed25519','-N','','-C','her-remote-entry','-f',keyFile],{windowsHide:true,stdio:'ignore'});
 }
 if(!fs.existsSync(pubFile)){const pub=execFileSync(keygen,['-y','-f',keyFile],{windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','ignore']});fs.writeFileSync(pubFile,pub);}
 const parts=fs.readFileSync(pubFile,'utf8').trim().split(/\s+/);if(parts[0]!=='ssh-ed25519')throw Error('stable-key-type-invalid');
 return {keyFile,keyFingerprint:crypto.createHash('sha256').update(Buffer.from(parts[1],'base64')).digest('hex')};
}
export function stableSshArguments({stateDir,keyFile,origin}){
 const port=new URL(origin).port;
 return ['-T','-i',keyFile,'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=accept-new','-o','UserKnownHostsFile='+path.join(stateDir,'remote-entry-known-hosts'),'-o','ConnectTimeout=12','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-o','ExitOnForwardFailure=yes','-R','80:127.0.0.1:'+port,'stable@proxy.tunnl.gg','output=json'];
}
export function createStableTunnel({stateDir,executable,origin,authToken='',inspect=inspectStableHelpers,inspectSsh=inspectStableSsh,killImpl=pid=>process.kill(pid),isAlive=connectorAlive,spawnImpl=spawn,probe=probeTunnel,identity=stableIdentity,now=Date.now,log=()=>{}}){
 const helper=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'tools/remote-entry-connector.mjs'),processFile=path.join(stateDir,'stable-tunnel-process.json'),healthFile=path.join(stateDir,'stable-tunnel-health.json');
 let key,record,checking,closed=false,timer,nextProbe=0,retryAt=0,identityAt=0;
 const state={url:'',stable:true,persistedVerified:false,processAlive:false,reachable:false,checkedAt:0,lastHealthyAt:0,error:'starting',latencyMs:null};
 const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
 async function initialize(){
  key||=identity({stateDir,executable});
  const health=read(healthFile);if(!state.url&&health?.keyFingerprint===key.keyFingerprint&&stableEntryUrl(health.url)&&health.lastHealthyAt>0){state.url=health.url;state.lastHealthyAt=health.lastHealthyAt;state.persistedVerified=true;}
  if(record)return;
  const rows=await inspect({executable:process.execPath,helper,origin,stateDir});if(closed)return;
  const saved=read(processFile);
  if(rows.length){
   if(rows.length!==1||saved?.pid!==rows[0].pid||saved?.startTime!==rows[0].startTime||saved?.keyFingerprint!==key.keyFingerprint){state.error='stable-helper-identity-unknown';retryAt=now()+10000;return;}
   record=rows[0];identityAt=now();log('adopted independent stable-entry helper');return;
  }
  if(saved?.sshPid&&saved?.sshStartTime&&saved?.keyFingerprint===key.keyFingerprint){
   const orphans=await inspectSsh({executable,keyFile:key.keyFile,origin,pid:saved.sshPid});
   if(orphans.some(p=>p.pid===saved.sshPid&&p.startTime===saved.sshStartTime))killImpl(saved.sshPid);
  }
  const child=spawnImpl(process.execPath,[helper,'--origin='+origin,'--state-dir='+stateDir,'--ssh='+executable],{detached:true,windowsHide:true,stdio:'ignore'});child.unref();
  const launched=await new Promise(r=>{child.once('spawn',()=>r(true));child.once('error',()=>r(false));});if(!launched)throw Error('stable-helper-start-failed');
  // The helper writes its own process identity before connecting. Do not launch a duplicate while it starts.
  record={pid:child.pid,startTime:null};identityAt=0;log('started independent stable-entry helper');
 }
 async function perform({force=false}={}){
  if(closed||now()<retryAt)return;await initialize();if(!record||closed)return;
  if(!isAlive(record.pid)){record=null;state.processAlive=false;state.reachable=false;state.error='stable-helper-exited';retryAt=now()+3000;return;}
  const saved=read(processFile);
  if(!record.startTime){if(saved?.pid!==record.pid||saved?.keyFingerprint!==key.keyFingerprint)return;record.startTime=saved.startTime;identityAt=now();}
  if(now()-identityAt>=60000){const rows=await inspect({executable:process.execPath,helper,origin,stateDir,pid:record.pid});if(!rows.some(r=>r.pid===record.pid&&r.startTime===record.startTime)){record=null;state.processAlive=false;state.reachable=false;state.error='stable-helper-identity-changed';retryAt=now()+3000;return;}identityAt=now();}
  state.processAlive=true;
  if(!force&&now()<nextProbe)return;
  const candidate=saved?.pid===record.pid&&saved?.startTime===record.startTime&&saved?.keyFingerprint===key.keyFingerprint?stableEntryUrl(saved.url):'';
  const url=candidate||state.url;if(!url){state.error='stable-entry-registering';return;}
  const local=await probe(origin,{authToken,timeoutMs:1500});const result=local.ok?await probe(url,{authToken,timeoutMs:10000}):{ok:false,error:'origin-unavailable',checkedAt:now(),ms:local.ms};if(closed)return;
  state.reachable=result.ok;state.checkedAt=result.checkedAt;state.latencyMs=result.ms;state.error=result.error;nextProbe=now()+(result.ok?30000:5000);
  if(result.ok){state.url=url;state.lastHealthyAt=result.checkedAt;state.persistedVerified=true;const tmp=healthFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify({url,keyFingerprint:key.keyFingerprint,lastHealthyAt:result.checkedAt}));fs.renameSync(tmp,healthFile);}
 }
 function check(options){if(checking)return checking;checking=perform(options).catch(()=>{state.reachable=false;state.error='stable-monitor-unavailable';retryAt=now()+5000;}).finally(()=>{checking=null;});return checking;}
 return {async start(){await check({force:true});if(!timer&&!closed){timer=setInterval(()=>void check(),5000);timer.unref();}},check,snapshot(){return {...state,alive:state.processAlive&&state.reachable&&now()-state.checkedAt<90000};},close(){closed=true;clearInterval(timer);}};
}
