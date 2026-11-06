import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
import calendar from './ui/calendar.js';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const normalize=value=>String(value||'').replace(/\s+/g,' ').trim();
const visible="role IN ('user','assistant') AND body<>''";

/** Full history is durable independently of the model's small context window. */
export function createConversationStore({stateDir,legacyInboxFile,now=Date.now}){
 fs.mkdirSync(stateDir,{recursive:true});const file=path.join(stateDir,'sessions.json');let sessions={};
 if(fs.existsSync(file)){sessions=JSON.parse(fs.readFileSync(file,'utf8'));if(!sessions||typeof sessions!=='object'||Array.isArray(sessions))throw new Error('Invalid conversation state; original file preserved');}
 const db=new DatabaseSync(path.join(stateDir,'chat-history.sqlite'));db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,session_id TEXT,role TEXT,body TEXT,at INTEGER,day TEXT NOT NULL,kind TEXT,status TEXT,raw TEXT,hash TEXT); CREATE INDEX IF NOT EXISTS message_day_seq ON messages(day,seq); CREATE INDEX IF NOT EXISTS message_time ON messages(at)');
 const known=new Map(db.prepare('SELECT id,hash FROM messages').all().map(row=>[row.id,row.hash]));
 const put=db.prepare('INSERT INTO messages(id,session_id,role,body,at,day,kind,status,raw,hash) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,raw=excluded.raw,hash=excluded.hash,status=excluded.status,at=COALESCE(excluded.at,messages.at),day=CASE WHEN excluded.at IS NOT NULL THEN excluded.day ELSE messages.day END');
 function record(id,message,{legacy=false,sourceAt=null,archiveId=''}={}){
  if(!message||!['user','assistant','tool'].includes(message.role))return;
  const fresh=!message.archiveId;message.archiveId=message.archiveId||archiveId||crypto.randomUUID();
  if(fresh)message.at=calendar.timestamp(message.at)||calendar.timestamp(sourceAt)||(legacy?null:now());
  const at=calendar.timestamp(message.at),day=calendar.day(at)||'undated',body=typeof message.content==='string'?message.content:'',kind=body.startsWith('【模型实际感知到的互动】')?'interaction':message.role==='tool'?'tool':'chat';
  const raw=JSON.stringify(message),digest=hash(raw);if(known.get(message.archiveId)===digest)return;
  put.run(message.archiveId,id,message.role,body,at,day,kind,message.interrupted?'interrupted':'saved',raw,digest);known.set(message.archiveId,digest);
 }
 function capture(id,session,options={}){
  db.exec('BEGIN IMMEDIATE');try{for(const m of session.messages||[])record(id,m,options);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
 }
 // Import the existing bridge journal with its actual timestamps, without
 // rewriting it. Old un-timestamped session records remain explicitly undated.
 const legacy=[];
 if(legacyInboxFile&&fs.existsSync(legacyInboxFile)){
  for(const line of fs.readFileSync(legacyInboxFile,'utf8').split('\n')){
   let row;try{row=JSON.parse(line);}catch{continue;}
   if(!['owner','her'].includes(row.role)||typeof row.text!=='string'||!calendar.timestamp(row.time))continue;
   const archiveId=row.id||'legacy-inbox:'+hash(JSON.stringify([row.time,row.role,row.text,row.sessionId||'']));
   const message={role:row.role==='owner'?'user':'assistant',content:row.text,at:calendar.timestamp(row.time)};
   legacy.push({...row,archiveId,role:message.role});if(!known.has(archiveId))record(String(row.sessionId||'legacy-phone'),message,{archiveId});
  }
 }
 for(const [id,session] of Object.entries(sessions)){
  for(const [index,message] of (session.messages||[]).entries()){
   if(message.archiveId)continue;
   const text=normalize(message.content),matches=legacy.filter(row=>row.sessionId===id&&row.role===message.role&&text&&(text.startsWith(normalize(row.text))||normalize(row.text).startsWith(text)));
   const match=matches.length===1?matches[0]:null;
   record(id,message,{legacy:true,sourceAt:match?.time,archiveId:match?.archiveId||'legacy-session:'+hash(JSON.stringify([id,index,message.role,message.content,message.tool_calls,message.tool_call_id]))});
  }
 }
 function dayId(){return 'phone:'+calendar.day(now());}
 function get(id=dayId()){
  id=String(id).slice(0,120);
  if(!Object.hasOwn(sessions,id)){
   const day=/^phone:(\d{4}-\d{2}-\d{2})$/.exec(id)?.[1];
   const seed=day?db.prepare(`SELECT raw FROM messages WHERE day=? AND ${visible} ORDER BY COALESCE(at,0) DESC,seq DESC LIMIT 40`).all(day).reverse().map(row=>{const m=JSON.parse(row.raw);delete m.tool_calls;return m;}):[];
   Object.defineProperty(sessions,id,{value:{messages:seed,createdAt:now()},writable:true,enumerable:true,configurable:true});
  }
  return sessions[id];
 }
 function save(){
  for(const [id,session] of Object.entries(sessions))capture(id,session);
  const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(sessions,(key,value)=>key==='responding'?undefined:value),'utf8');fs.renameSync(temp,file);
 }
 function captureSession(session){const item=Object.entries(sessions).find(([,s])=>s===session);if(item)capture(item[0],session);}
 function days(){return db.prepare(`SELECT day,count(*) AS count,min(at) AS firstAt,max(at) AS lastAt FROM messages WHERE ${visible} GROUP BY day ORDER BY CASE WHEN day='undated' THEN 1 ELSE 0 END,day DESC`).all();}
 function history({day=calendar.day(now()),limit=80,before=0}={}){
  if(day!=='undated'&&!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error('日期无效');
  const size=Math.max(1,Math.min(Number(limit)||80,200)),cursor=Number(before)||Number.MAX_SAFE_INTEGER;
  const rows=db.prepare(`SELECT seq,id,role,body AS text,at,day,kind,status FROM messages WHERE day=? AND seq<? AND ${visible} ORDER BY seq DESC LIMIT ?`).all(day,cursor,size+1),more=rows.length>size,selected=rows.slice(0,size).reverse();
  return {ok:true,day,timeZone:calendar.zone,items:selected,hasMore:more,nextCursor:more?selected[0]?.seq:null};
 }
 function context(session){captureSession(session);const messages=session.messages||[];if(messages.length<=60)return;let index=messages.length-60;while(index<messages.length&&messages[index].role!=='user')index++;if(index<messages.length)session.messages=messages.slice(index);}
 return {sessions,get,save,captureSession,context,days,history,dayId,close:()=>db.close()};
}
