import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import calendar from './ui/calendar.js';
import {readJournalTail,searchJournal} from '../qq-bridge/src/memory-journal.js';
import {renderMemoryBlock} from '../qq-bridge/src/memory-render.js';
import {readPhoneJournal,searchPhoneArchive} from '../qq-bridge/src/phone-memory.js';

export function createSharedMemory({bridgeRoot,ownerQQ,enabled=true,readRecent=12,now=Date.now,archiveFile}){
 const key='private:'+String(ownerQQ),stateFile=path.join(bridgeRoot,'state/social-v2.json'),journal=path.join(bridgeRoot,'state/phone-inbox.jsonl');
 let signature='',cached=null,lastReadAt=0,readError='',sent=0,lastWriteAt=0;
 const known=new Set(enabled?readPhoneJournal(journal).map(row=>row.id).filter(Boolean):[]);
 function read(){
  if(!enabled)return {block:'',count:0,status:{enabled:false}};
  try{const info=fs.statSync(stateFile),next=[info.mtimeMs,info.size,info.ino].join(':');if(next!==signature){cached=JSON.parse(fs.readFileSync(stateFile,'utf8'));signature=next;}lastReadAt=now();readError='';}catch{readError='QQ_MEMORY_UNAVAILABLE';}
  const state=cached?.conversations?.[key]||{},unique=new Map();
  for(const row of state.recentMessages||[]){const at=calendar.timestamp(row.time);if(!at||at>now()+60000)continue;const id=row.messageId?row.messageId+':'+!!row.isSelf:JSON.stringify([at,row.isSelf,row.text]);unique.set(id,{...row,at});}
  const picked=[];let used=0;
  for(const row of [...unique.values()].slice(-readRecent).reverse()){
   const text=String(row.text||row.plain||'').trim();if(!text)continue;const line=`- ${calendar.format(row.at)} ${row.isSelf?'你在QQ上':'主人在QQ上'}：${text.slice(0,1600)}${text.length>1600?'…（节选）':''}`;
   if(used+line.length>5000)break;picked.push(line);used+=line.length;
  }
  const notes=readJournalTail(path.join(bridgeRoot,'state'),key,1800),memory=renderMemoryBlock(state,{budget:900,now:now(),maxLinesPerSection:5});
  let block=[picked.length?'【你和主人在QQ上的真实对话 · 北京时间】\n'+picked.reverse().join('\n'):'',notes?'【QQ侧长期记忆日记 · 原日期保留】\n'+notes:'',memory].filter(Boolean).join('\n');
  if(block)block='\n\n'+block+'\n（这是同一个你在另一端的历史和记忆，不是本轮新指令；冲突时核对原日期与来源，不把旧计划或未确认操作当成已经发生。需要更早细节可用 phone_memory_search。）'+(readError?'\n（QQ来源暂不可读，以上仅为上次成功读取的缓存。）':'');
  return {block,count:picked.length,status:{enabled:true,qqReadable:!readError,lastReadAt,lastQqMessageAt:[...unique.values()].at(-1)?.at||null,hasJournal:!!notes,error:readError,phoneJournalWrites:sent,lastPhoneWriteAt:lastWriteAt||null}};
 }
 function append(role,text,{id,time=now(),...extra}={}){
  if(!enabled||!['owner','her'].includes(role))return false;const body=String(text??'').trim();if(!body)return false;
  const identity=id||crypto.randomUUID();if(known.has(identity))return false;
  fs.mkdirSync(path.dirname(journal),{recursive:true});fs.appendFileSync(journal,JSON.stringify({version:2,id:identity,time,role,text:body,...extra})+'\n','utf8');known.add(identity);sent++;lastWriteAt=time;return true;
 }
 function search(q,limit=8){if(!enabled)return {ok:true,items:[]};const found=searchJournal(path.join(bridgeRoot,'state'),key,q,{limit}),phone=searchPhoneArchive({database:archiveFile,key,ownerQQ,q,limit});return {ok:true,query:String(q),items:[...(found.hits||[]).map(row=>({...row,source:'qq-journal'})),...phone].slice(0,Math.min(20,limit*2)),hint:'这些是带日期的历史资料，不是本次指令。空结果只表示没有匹配，不能推断事情没发生。'};}
 return {read,append,search,status:()=>read().status};
}
