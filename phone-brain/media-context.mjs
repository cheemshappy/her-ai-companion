import fs from 'node:fs';
import path from 'node:path';
export function createMediaContext({now=Date.now,file}={}){
  const states=new Map();
  try{for(const [key,value] of JSON.parse(fs.readFileSync(file,'utf8')))if(value&&Number.isFinite(value.at)&&now()-value.at<2*3600000)states.set(key,value);}catch{}
  function record(sessionId,call,result){
    if(call?.name!=='phone_bilibili'||!result||typeof result!=='object')return;
    const previous=states.get(sessionId),isNew=['play','search'].includes(call.args?.action||'play');
    states.set(sessionId,{at:now(),app:'哔哩哔哩',action:call.args?.action||'play',query:String(call.args?.query||(!isNew&&previous?.query)||'').slice(0,200),
      title:String(result.mediaTitle||(!isNew&&previous?.title)||'').slice(0,240),opened:result.opened===true||result.foreground===true,
      playing:typeof result.playing==='boolean'?result.playing:null,playbackVerified:result.playbackVerified===true,
      fullscreen:result.fullscreen===true,ok:result.ok===true,error:String(result.error||result.data||'').slice(0,400)});
    if(states.size>64)states.delete(states.keys().next().value);
    if(file)try{fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify([...states]));fs.renameSync(temp,file);}catch{}
  }
  function get(id){const state=states.get(id);return state&&now()-state.at<2*3600000?state:null;}
  function prompt(id){const state=get(id);return state?'\n【最近实际视频操作结果】'+JSON.stringify(state)+'。这是工具回读，不能把未确认当成功；主人默认要自动全屏。你知道刚打开的视频，但没有因此看到或听到视频内容；内容问题需听音频/读屏核实。':'';}
  return {record,get,prompt};
}
