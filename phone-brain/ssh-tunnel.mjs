/** Independent second provider; keep Cloudflare as an independently saved recovery route. */
import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';
import {probeTunnel} from './tunnel-health.mjs';import {inspectSshConnectors,connectorAlive} from './connector-process.mjs';
export const sshPublicUrl=text=>/https:\/\/[a-z0-9-]+\.lhr\.life\b/i.exec(String(text))?.[0]||'';
export function createSshTunnel({stateDir,executable,origin,authToken='',inspect=inspectSshConnectors,isAlive=connectorAlive,spawnImpl=spawn,probe=probeTunnel,now=Date.now,log=()=>{},backupHealthy=()=>false,killImpl=pid=>process.kill(pid)}){
 const file=path.join(stateDir,'ssh-tunnel-process.json'),defaultOutput=path.join(stateDir,'ssh-tunnel-output.log');
 let record=null,closed=false,pending=null,timer,probeAt=0,identityAt=0,restartAt=0,tries=0;
 let gatewayFailures=0,gatewaySince=0;
 const state={url:'',processAlive:false,reachable:false,checkedAt:0,lastHealthyAt:0,latencyMs:null,error:'starting',phase:'starting',recentChecks:[]};
 const save=()=>{const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify({...record,origin,executable})+'\n');fs.renameSync(tmp,file);};
 async function initialize(){
  if(record||now()<restartAt)return;
  let saved;try{saved=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
  const existing=await inspect({executable,origin});if(closed)return;
  if(existing.length){
   const match=existing.length===1&&saved?.origin===origin&&saved?.executable===executable&&existing[0].pid===saved.pid&&existing[0].startTime===saved.startTime;
   if(!match){state.error='existing-ssh-identity-unknown';restartAt=now()+30000;return;}
   record={pid:saved.pid,startTime:saved.startTime,outputFile:saved.outputFile||defaultOutput,url:sshPublicUrl(saved.url)};state.processAlive=true;identityAt=now();log('adopted existing independent SSH connector');return;
  }
  fs.writeFileSync(defaultOutput,'');const fd=fs.openSync(defaultOutput,'a');let child;
  try{child=spawnImpl(executable,['-T','-o','StrictHostKeyChecking=accept-new','-o','UserKnownHostsFile='+path.join(stateDir,'ssh-tunnel-known-hosts'),'-o','BatchMode=yes','-o','ConnectTimeout=12','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=120','-R','80:127.0.0.1:'+new URL(origin).port,'nokey@localhost.run'],{stdio:['ignore',fd,fd],detached:true,windowsHide:true});}finally{fs.closeSync(fd);}
  child.unref();const started=await new Promise(resolve=>{child.once('spawn',()=>resolve(true));child.once('error',()=>resolve(false));});if(!started)throw Error('ssh-start-unavailable');
  const info=(await inspect({executable,origin,pid:child.pid})).find(x=>x.pid===child.pid);if(!info)throw Error('ssh-inspection-unavailable');
  record={pid:info.pid,startTime:info.startTime,outputFile:defaultOutput,url:''};state.processAlive=true;identityAt=now();save();log('started independent SSH backup connector');
 }
 async function perform({force=false}={}){
  if(closed)return;await initialize();if(!record||closed)return;
  if(!isAlive(record.pid)){record=null;state.url='';state.processAlive=false;state.reachable=false;state.error='connector-exited';state.phase='starting';restartAt=now()+Math.min(60000,3000*2**Math.min(4,tries++));return;}
  if(now()-identityAt>=60000){const info=(await inspect({executable,origin,pid:record.pid})).find(x=>x.startTime===record.startTime);if(!info){record=null;state.url='';state.reachable=false;state.processAlive=false;state.error='connector-identity-changed';restartAt=now()+3000;return;}identityAt=now();}
  if(!record.url){try{record.url=sshPublicUrl(fs.readFileSync(record.outputFile,'utf8').slice(-32000));if(record.url)save();}catch{}}
  if(!record.url||!force&&now()<probeAt)return;
  const local=await probe(origin,{authToken,timeoutMs:1500});if(closed)return;
  const value=local.ok?await probe(record.url,{authToken,timeoutMs:10000}):{ok:false,error:'origin-unavailable',ms:local.ms,checkedAt:now()};if(closed)return;
  state.processAlive=true;state.reachable=value.ok;state.checkedAt=value.checkedAt;state.latencyMs=value.ms;state.error=value.error;state.phase=value.ok?'online':'reconnecting';
  state.recentChecks.push({at:value.checkedAt,ok:value.ok,ms:value.ms,error:value.error});if(state.recentChecks.length>30)state.recentChecks.shift();probeAt=now()+(value.ok?30000:5000);
  if(value.ok){state.url=record.url;state.lastHealthyAt=value.checkedAt;tries=0;fs.writeFileSync(path.join(stateDir,'ssh-tunnel-url.txt'),record.url+'\n');}
  if(local.ok&&['HTTP 502','HTTP 530'].includes(value.error)&&backupHealthy()){
   gatewayFailures++;gatewaySince||=now();
   // SSH can remain alive after its free gateway has withdrawn the forwarding.
   // Rotate only this confirmed-dead secondary while a separately saved anchor is healthy.
   if(gatewayFailures>=3&&now()-gatewaySince>=30000){
    const actual=(await inspect({executable,origin,pid:record.pid})).find(x=>x.pid===record.pid&&x.startTime===record.startTime);
    if(actual&&!closed){killImpl(actual.pid);state.phase='restarting-backup';log('SSH gateway remains unavailable; renewing secondary while independent anchor is healthy');}
    gatewayFailures=0;gatewaySince=0;
   }
  }else{gatewayFailures=0;gatewaySince=0;}
 }
 function check(options){if(pending)return pending;pending=perform(options).catch(()=>{state.reachable=false;state.error='ssh-monitor-unavailable';restartAt=now()+10000;}).finally(()=>{pending=null;});return pending;}
 return {async start(){await check({force:true});if(!timer&&!closed){timer=setInterval(()=>void check(),5000);timer.unref();}},check,
  snapshot(){return {...state,alive:state.processAlive&&state.reachable&&now()-state.checkedAt<90000,recentChecks:state.recentChecks.map(x=>({...x}))};},close(){closed=true;clearInterval(timer);}};
}
