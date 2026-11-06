/** Detached connector: network/probe failures must never rotate a working phone address. */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {cloudflareUrl,probeTunnel} from './tunnel-health.mjs';
import {createQuickService} from './quick-service.mjs';
import {inspectConnectors,connectorAlive} from './connector-process.mjs';

async function metricsPort(){
  const server=net.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));return port;
}
export async function connectorReady(port,{fetchImpl=fetch}={}){
  if(!Number.isInteger(port)||port<1||port>65535)return null;
  try{
    const r=await fetchImpl('http://127.0.0.1:'+port+'/ready',{redirect:'error',signal:AbortSignal.timeout(1500)});
    const data=await r.json();
    if(r.status===200&&data?.status===200&&Number(data.readyConnections)>0)return true;
    if(r.status===503&&data?.status===503)return false;
    return null;
  }catch{return null;}
}

export function createCloudflareTunnel({stateDir,executable,origin,authToken='',protocol='http2',
  inspect=inspectConnectors,isAlive=connectorAlive,spawnImpl=spawn,quickService=createQuickService,
  allocatePort=metricsPort,probe=probeTunnel,ready=connectorReady,now=Date.now,log=()=>{},onPublished=()=>{}}){
  const recordFile=path.join(stateDir,'tunnel-process.json'),urlFile=path.join(stateDir,'tunnel-url.txt');
  let record=null,quick=null,initializing=null,checking=null,closed=false,timer=null,nextProbeAt=0,restartAt=0,tries=0,identityAt=0;
  const state={url:'',processAlive:false,reachable:false,checkedAt:0,lastHealthyAt:0,latencyMs:null,error:'starting',phase:'starting',connectorReady:null,recentChecks:[]};
  const save=()=>{
    if(!record)return;
    const tmp=recordFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify({...record,origin,executable})+'\n');fs.renameSync(tmp,recordFile);
  };
  const report=value=>{
    state.checkedAt=value.checkedAt;state.latencyMs=value.ms;state.error=value.error;state.reachable=value.ok;
    state.recentChecks.push({at:value.checkedAt,ok:value.ok,ms:value.ms,error:value.error});if(state.recentChecks.length>30)state.recentChecks.shift();
    if(value.ok){
      state.phase='online';state.lastHealthyAt=value.checkedAt;tries=0;
      if(record?.url&&state.url!==record.url){
        state.url=record.url;record.published=true;save();fs.writeFileSync(urlFile,state.url+'\n');onPublished(state.url);
      }
      quick?.close();quick=null;
    }else{state.phase=value.error==='origin-unavailable'?'waiting-for-app':state.connectorReady===false?'reconnecting':'public-unverified';}
    nextProbeAt=now()+(value.ok?30000:5000);
    if(!value.ok)log('public check unavailable: '+value.error+'; retaining connector and address');
  };
  async function initialize(){
    if(record||closed)return;
    let saved;try{saved=JSON.parse(fs.readFileSync(recordFile,'utf8'));}catch{}
    // Creation time + exact executable/origin prevent adopting a reused PID or another project's tunnel.
    const existing=await inspect({executable,origin});
    if(closed)return;
    if(existing.length>1){state.error='multiple-project-connectors';state.phase='needs-inspection';restartAt=now()+30000;return;}
    if(existing.length===1){
      const info=existing[0],matches=saved?.pid===info.pid&&saved?.startTime===info.startTime&&saved?.origin===origin&&saved?.executable===executable;
      let url=matches?cloudflareUrl(saved.url):'';
      // One-time adoption of the old, still running connector during this migration.
      if(!saved){try{url=cloudflareUrl(fs.readFileSync(urlFile,'utf8'));}catch{}}
      if(!url){state.error='existing-connector-address-unknown';state.phase='needs-inspection';restartAt=now()+30000;return;}
      record={pid:info.pid,startTime:info.startTime,metricsPort:info.metricsPort,url,published:matches&&saved.published===true};
      identityAt=now();state.processAlive=true;state.error='checking-retained-connector';save();log('adopted existing project connector; address retained');return;
    }
    const port=await allocatePort();
    let provisionedUrl='';
    quick=await quickService({onProvisioned:({hostname})=>{
      const url=cloudflareUrl(hostname.startsWith('https://')?hostname:'https://'+hostname);
      if(url&&!closed){provisionedUrl=url;if(record){record.url=url;save();}nextProbeAt=0;}
    }});
    if(closed){quick.close();quick=null;return;}
    const child=spawnImpl(executable,['tunnel','--no-autoupdate','--quick-service',quick.url,'--edge-ip-version','4',
      '--protocol',protocol==='quic'?'quic':'http2','--retries','100000','--metrics','127.0.0.1:'+port,'--url',origin],
    {stdio:'ignore',detached:true,windowsHide:true});
    child.unref();
    const spawned=await new Promise(resolve=>{child.once('spawn',()=>resolve(true));child.once('error',()=>resolve(false));});
    if(!spawned){quick.close();quick=null;throw new Error('connector-spawn-failed');}
    const info=(await inspect({executable,origin,pid:child.pid})).find(x=>x.pid===child.pid);
    if(!info){quick.close();quick=null;state.error='new-connector-inspection-pending';restartAt=now()+5000;return;}
    record={pid:info.pid,startTime:info.startTime,metricsPort:port,url:provisionedUrl,published:false};identityAt=now();state.processAlive=true;save();
    log('started detached project connector; reconnect retries enabled');
  }
  async function start(){
    if(closed||record||now()<restartAt)return;
    if(initializing)return initializing;
    initializing=initialize().catch(()=>{state.processAlive=false;state.reachable=false;state.error='connector-start-unavailable';state.phase='starting';restartAt=now()+10000;log('connector start unavailable; retry scheduled');}).finally(()=>{initializing=null;});
    return initializing;
  }
  async function performCheck({force=false}={}){
    if(closed)return;
    await start();if(!record||closed)return;
    if(!isAlive(record.pid)){
      quick?.close();quick=null;record=null;state.processAlive=false;state.reachable=false;state.error='connector-exited';state.phase='starting';
      // Keep the saved URL as history only; it will not be republished without a real paired check.
      state.url='';tries++;restartAt=now()+Math.min(60000,3000*2**Math.min(4,tries-1));log('connector exited; retry scheduled');return;
    }
    if(now()-identityAt>=60000){
      const current=(await inspect({executable,origin,pid:record.pid})).find(x=>x.pid===record.pid&&x.startTime===record.startTime);
      if(!current){record=null;state.url='';state.processAlive=false;state.reachable=false;state.error='connector-identity-changed';restartAt=now()+3000;return;}
      identityAt=now();
    }
    if(!force&&now()<nextProbeAt)return;
    state.processAlive=true;
    state.connectorReady=await ready(record.metricsPort);
    const local=await probe(origin,{authToken,timeoutMs:1500});if(closed)return;
    if(!local.ok){report({ok:false,checkedAt:now(),ms:local.ms,error:'origin-unavailable'});return;}
    if(!record.url){state.reachable=false;state.error='provisioning';state.phase='starting';return;}
    const value=await probe(record.url,{authToken,timeoutMs:10000});if(closed)return;
    // A public/DNS timeout observes this computer's route, not the connector's lifetime.
    // Even /ready=503 means cloudflared is reconnecting; never kill it to obtain a new random URL.
    report(value);
  }
  function check(options){
    if(checking)return checking;
    checking=performCheck(options).catch(()=>{state.reachable=false;state.error='connector-monitor-unavailable';state.phase='checking';nextProbeAt=now()+5000;}).finally(()=>{checking=null;});
    return checking;
  }
  return {
    start:async()=>{await check({force:true});if(!timer&&!closed){timer=setInterval(()=>{void check();},5000);timer.unref();}},check,
    snapshot(){return {...state,alive:state.processAlive&&state.reachable&&now()-state.checkedAt<90000,recentChecks:state.recentChecks.map(x=>({...x}))};},
    // Stopping the brain or this monitor must leave the detached connector running.
    close(){closed=true;clearInterval(timer);quick?.close();quick=null;},
  };
}
