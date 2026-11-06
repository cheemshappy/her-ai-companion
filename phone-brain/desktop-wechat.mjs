import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execute=promisify(execFile),MAX_AGE=7*86400000;
/** The helper has no send/UI automation methods. Only verified feeds are published. */
export function createDesktopWechat({stateDir,helper,now=Date.now,onChange=()=>{},run=execute}){
  let items=[],ownerId='',health={},settings={},running=false;
  const feed=path.join(stateDir,'desktop-wechat-inbox.json'),healthFile=path.join(stateDir,'wechat-reader-health.json');
  try{settings=JSON.parse(fs.readFileSync(path.join(stateDir,'wechat-runtime.json'),'utf8'));}catch{}
  function load(){
    try{
      const data=JSON.parse(fs.readFileSync(feed,'utf8'));
      if(!data.ownerId||ownerId&&ownerId!==data.ownerId||!Array.isArray(data.items)||!data.verifiedDatabases)return false;
      const next=data.items.filter(m=>m.source==='desktop-wechat'&&m.accountId===data.ownerId&&m.key?.startsWith('wechat:')&&typeof m.text==='string'&&m.at>=now()-MAX_AGE&&m.at<=now()+60000).slice(-10000);
      const changed=JSON.stringify(items)!==JSON.stringify(next);items=next;ownerId=data.ownerId;
      if(changed)onChange();return changed;
    }catch{return false;}
  }
  load();
  try{health=JSON.parse(fs.readFileSync(healthFile,'utf8'));}catch{}
  function status(){
    const enabled=settings.enabled===true,available=enabled&&health.ok===true&&now()-(health.completedAt||0)<150000;
    return {ok:true,source:'desktop-wechat',configured:enabled,connected:available,available,running,
      count:items.filter(m=>m.at>=now()-MAX_AGE).length,lastCheckAt:health.completedAt||null,lastCaptureAt:health.lastCaptureAt||null,
      readOnly:true,opensApps:false,retentionDays:7,limit:10000,error:health.ok?'':health.error||'',
      verifiedDatabases:health.verifiedDatabases||0,decodeErrors:health.decodeErrors||0,
      coverage:'电脑微信本地已同步的最近7天记录，最多10000条，包含自己的回复作为上下文；约1分钟检查。免打扰不排除，读取不改变已读状态。图片/语音等附件尚未解析，电脑未同步的历史无法补出。'};
  }
  async function refresh(){
    if(running||settings.enabled!==true||!settings.python)return status();running=true;
    try{
      // Static task/argument list. No account paths, messages or credentials on argv.
      await run(settings.python,['-I','-S',helper,'capture'],{windowsHide:true,timeout:90000,maxBuffer:128*1024,encoding:'utf8'});
      health=JSON.parse(fs.readFileSync(healthFile,'utf8'));load();
    }catch{
      try{health=JSON.parse(fs.readFileSync(healthFile,'utf8'));}catch{}
      if(health.ok===true||!health.completedAt)health={ok:false,error:'READER_UNAVAILABLE',completedAt:now()};
    }finally{running=false;}
    return status();
  }
  function all(){return items.filter(m=>m.at>=now()-MAX_AGE);}
  function snapshot({limit=30,since=0,conversation='',before=''}={}){
    let list=all().filter(m=>m.at>=(Number(since)||0)&&(!conversation||m.kind+':'+m.conversationId===conversation)).slice().reverse();
    const total=list.length;if(before){const index=list.findIndex(m=>m.key===before);list=index<0?[]:list.slice(index+1);}
    const selected=list.slice(0,Math.max(1,Math.min(Number(limit)||30,200)));
    return {...status(),items:selected,total,hasMore:list.length>selected.length,nextCursor:list.length>selected.length?selected.at(-1)?.key:null};
  }
  function start(){void refresh();const timer=setInterval(()=>void refresh(),60000);timer.unref();return ()=>clearInterval(timer);}
  return {status,all,snapshot,refresh,start};
}

export function combineMessageSources(qq,wechat){
  const all=()=>[...qq.all(),...wechat.all()].sort((a,b)=>a.at-b.at||a.key.localeCompare(b.key));
  const status=()=>({...qq.status(),wechat:wechat.status(),count:all().length});
  function snapshot({limit=30,since=0,conversation='',before=''}={}){
    let list=all().filter(m=>m.at>=(Number(since)||0)&&(!conversation||m.kind+':'+m.conversationId===conversation)).reverse();
    const total=list.length;if(before){const index=list.findIndex(m=>m.key===before);list=index<0?[]:list.slice(index+1);}
    const selected=list.slice(0,Math.max(1,Math.min(Number(limit)||30,200)));
    return {ok:true,items:selected,total,hasMore:list.length>selected.length,nextCursor:list.length>selected.length?selected.at(-1)?.key:null};
  }
  return {all,status,snapshot};
}
