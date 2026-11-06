import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createMessageHub} from '../message-hub.mjs';
import {ANALYSIS_VERSION} from '../message-relevance.mjs';
import {READING_POLICY,messageRevision,readMessagesForAi,summaryInput,startOfDay} from '../message-reading.mjs';

const noon=Date.parse('2026-10-31T12:00:00+08:00');
const msg=(key,at=noon,extra={})=>({key,at,kind:'private',conversationId:'friend',who:'测试联系人',sender:'测试联系人',text:'请确认会议时间 '+key,...extra});
function setup(t,messages=[]){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'her-incremental-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let time=noon;
  return {file:path.join(dir,'hub.json'),now:()=>time,setNow:v=>{time=v;},messages,
    source:{all:()=>messages,status:()=>({connected:true})}};
}
const answer=(messages,context)=>({summary:'已更新会话摘要',events:[],reviewedKeys:summaryInput(messages,context).messages.map(m=>m.key)});

test('QQ and WeChat bootstrap only today, and later requests send only new content',async t=>{
  const f=setup(t,[msg('old',noon-86400000),msg('a'),msg('wxold',noon-86400000,{conversationId:'wechat:friend',source:'desktop-wechat'}),msg('wx',noon,{conversationId:'wechat:friend',source:'desktop-wechat'})]);
  const batches=[];const hub=createMessageHub({...f,complete:async(m,c)=>{batches.push(m.map(x=>x.key));return answer(m,c);}});
  await hub.refresh();assert.deepEqual(batches.flat().sort(),['a','wx']);
  await hub.refresh();assert.equal(batches.length,2);
  f.messages.push(msg('b',noon+1));await hub.refresh();assert.deepEqual(batches.at(-1),['b']);
  assert.equal(hub.snapshot().reading.pending,0);assert.equal(f.source.all().length,5);
});

test('restart, midnight, unchanged manual refresh and retention pruning do not re-read completed content',async t=>{
  const f=setup(t,[msg('a')]);let calls=0;const complete=async(m,c)=>{calls++;return answer(m,c);};
  let hub=createMessageHub({...f,complete});await hub.refresh();
  hub=createMessageHub({...f,complete});await hub.refresh();f.setNow(noon+86400000);await hub.refresh();
  f.messages.shift();await hub.refresh();assert.equal(calls,1);assert.equal(hub.snapshot().reading.pending,0);
});

test('more than 60 same-timestamp receipts are drained without missing the middle',async t=>{
  const f=setup(t,Array.from({length:105},(_,i)=>msg('m'+i)));const seen=[];
  const hub=createMessageHub({...f,complete:async(m,c)=>{assert.ok(m.length<=20);seen.push(...m.map(m=>m.key));return answer(m,c);}});
  for(let i=0;i<10&&hub.snapshot().reading.pending;i++)await hub.refresh();
  assert.equal(hub.snapshot().reading.pending,0);assert.equal(new Set(seen).size,105);assert.equal(seen.length,105);
});

test('queued messages and late-arriving gaps after activation survive midnight; pre-activation history stays local',async t=>{
  const f=setup(t,[msg('a')]);const seen=[];const hub=createMessageHub({...f,complete:async(m,c)=>{seen.push(...m.map(m=>m.key));return answer(m,c);}});
  await hub.refresh();f.messages.push(msg('queued',noon+3600000));f.setNow(noon+86400000);
  f.messages.push(msg('late',noon-3600000),msg('new',noon+86400000),msg('ancient',noon-86400000));
  await hub.refresh();assert.deepEqual(seen.sort(),['a','late','new','queued']);assert.equal(hub.snapshot().reading.queuedPreviousDays,0);
});

test('continuous new messages cannot starve the oldest unread gap',async t=>{
  const f=setup(t,Array.from({length:45},(_,i)=>msg('m'+i,noon-1000+i)));const seen=[];
  const hub=createMessageHub({...f,complete:async(m,c)=>{seen.push(...m.map(m=>m.key));return answer(m,c);}});
  await hub.refresh();assert.ok(seen.includes('m0'));assert.ok(seen.includes('m44'));
  for(let round=0;round<4;round++){for(let i=0;i<25;i++)f.messages.push(msg('new'+round+':'+i,noon+round*100+i));await hub.refresh();}
  assert.ok(seen.includes('m1'));assert.equal(seen.length,new Set(seen).size);
});

test('a long new message is read completely, in bounded segments, with the middle preserved',async t=>{
  const text='开始。'+('甲乙丙。'.repeat(4200))+'最后请确认会议时间。',f=setup(t,[msg('long',noon,{text})]);const chunks=[];
  const hub=createMessageHub({...f,complete:async(m,c)=>{assert.ok(m.reduce((n,m)=>n+m.text.length,0)<=6000);chunks.push(...m.map(m=>m.text));return answer(m,c);}});
  for(let i=0;i<10&&hub.snapshot().reading.pending;i++)await hub.refresh();
  assert.equal(chunks.join(''),text);assert.equal(hub.snapshot().reading.pending,0);
});

test('an edited message restarts coverage for that key; unrelated completed messages are not replayed',async t=>{
  const f=setup(t,[msg('a'),msg('b')]),seen=[];
  const hub=createMessageHub({...f,complete:async(m,c)=>{seen.push(m.map(m=>m.text));return answer(m,c);}});
  await hub.refresh();f.messages[0]={...f.messages[0],text:'会议改到明天，请确认新时间'};await hub.refresh();
  assert.deepEqual(seen.at(-1),['会议改到明天，请确认新时间']);
});

test('failed or budget-denied summaries never advance coverage and retry after backoff',async t=>{
  const f=setup(t,[msg('a')]);let fail=true,calls=0;
  const hub=createMessageHub({...f,complete:async(m,c)=>{calls++;if(fail)throw new Error('daily budget');return answer(m,c);}});
  await hub.refresh();assert.equal(hub.snapshot().reading.pending,1);await hub.refresh();assert.equal(calls,1);
  fail=false;f.setNow(noon+300001);await hub.refresh();assert.equal(calls,2);assert.equal(hub.snapshot().reading.pending,0);
});

test('only actually supplied message keys advance, and an empty acknowledgement cannot loop immediately',async t=>{
  const f=setup(t,[msg('a'),msg('b')]);let calls=0;
  const hub=createMessageHub({...f,complete:async()=>{calls++;return {summary:'局部摘要',events:[],reviewedKeys:calls===1?['a']:[]};}});
  await hub.refresh();assert.equal(hub.snapshot().reading.pending,1);await hub.refresh();await hub.refresh();assert.equal(calls,2);
  assert.equal(hub.snapshot().reading.pending,1);
});

test('old summary and unfinished task use bounded evidence when a new reply arrives',async t=>{
  const f=setup(t,[msg('a',noon,{text:'请提交项目报告'+('文'.repeat(5000))})]);
  fs.writeFileSync(f.file,JSON.stringify({events:[{id:'task',conversation:'private:friend',kind:'task',title:'提交项目报告',status:'pending',sourceKeys:['a'],at:noon,analysisVersion:ANALYSIS_VERSION}],conversations:{'private:friend':{summary:'报告仍待提交'}},reading:{version:1,since:startOfDay(noon),covered:{}}}));
  // Fully acknowledge the original without using the real provider.
  const saved=JSON.parse(fs.readFileSync(f.file));saved.reading.covered.a={revision:messageRevision(f.messages[0]),offset:f.messages[0].text.length,at:noon};fs.writeFileSync(f.file,JSON.stringify(saved));
  f.setNow(noon+86400000);f.messages.push(msg('reply',noon+86400000,{text:'报告已收到，任务完成'}));
  const hub=createMessageHub({...f,complete:async(m,c)=>{assert.deepEqual(m.map(m=>m.key),['reply']);assert.equal(c.previousSummary,'报告仍待提交');assert.ok(c.priorEvidence.every(m=>m.text.length<=400));return {...answer(m,c),decisions:[{id:'task',state:'resolved',reason:'后文确认收到了',sourceKeys:['reply']}]};}});
  await hub.refresh();assert.equal(hub.snapshot().counts.pending,0);assert.equal(JSON.parse(fs.readFileSync(f.file)).events[0].status,'resolved');
});

test('legacy matching summaries migrate without a paid replay; previously truncated tails remain pending',async t=>{
  const f=setup(t,[msg('a'),msg('long',noon,{text:'资料'.repeat(1800)})]);
  const version=ANALYSIS_VERSION+':'+crypto.createHash('sha256').update(f.messages.map(m=>m.key+':').join('|')).digest('hex').slice(0,24);
  fs.writeFileSync(f.file,JSON.stringify({events:[],conversations:{'private:friend':{ai:true,version,summary:'已有摘要'}}}));
  const seen=[];const hub=createMessageHub({...f,complete:async(m,c)=>{seen.push(...m);return answer(m,c);}});await hub.refresh();
  assert.equal(seen.length,1);assert.equal(seen[0].key,'long');assert.equal(seen[0].reading.offset,2500);assert.equal(hub.snapshot().reading.pending,0);
});

function toolSource(messages){return {all:()=>messages,status:()=>({ok:true,connected:true}),snapshot({since,limit,before}){let list=messages.filter(m=>m.at>=since).slice().reverse();const total=list.length;if(before)list=list.slice(list.findIndex(m=>m.key===before)+1);const selected=list.slice(0,limit);return {ok:true,items:selected,total,hasMore:list.length>selected.length,nextCursor:list.length>selected.length?selected.at(-1).key:null};}};}

test('model-facing QQ/WeChat reads default to today while raw local history is retained',()=>{
  const messages=[msg('old',noon-86400000),msg('new')],source=toolSource(messages);
  const result=readMessagesForAi(source,{},noon);assert.deepEqual(result.items.map(m=>m.key),['new']);assert.equal(result.scope,'today');
  assert.equal(readMessagesForAi(source,{since:0},noon).items.length,2);assert.equal(source.all().length,2);
});

test('model-facing read limits are honest and continuation resumes the omitted text',()=>{
  const text='甲'.repeat(6100),source=toolSource(Array.from({length:8},(_,i)=>msg('m'+i,noon,{text})));
  const result=readMessagesForAi(source,{},noon);assert.equal(result.items.length,3);assert.equal(result.hasMore,true);assert.equal(result.nextCursor,'m5');
  assert.ok(result.items.every(m=>m.excerpt&&m.nextOffset===2000));
  let offset=0,full='';do{const page=readMessagesForAi(source,{messageKey:'m7',offset},noon);full+=page.items[0].text;offset=page.items[0].nextOffset;}while(offset!==null);
  assert.equal(full,text);
});

test('summary payload includes every new segment without a second truncation',()=>{
  const fresh=[msg('a',noon,{text:'甲'.repeat(6000),reading:{offset:2000,end:8000,total:9000},excerpt:true})];
  const payload=summaryInput(fresh,{previousSummary:'旧摘要',priorEvidence:[msg('old',noon-86400000,{text:'关联原文'})]},noon);
  assert.equal(payload.messages.find(m=>m.key==='a').text.length,6000);assert.equal(payload.messages.find(m=>m.key==='old').contextOnly,true);
  assert.equal(payload.messages.find(m=>m.key==='a').contextOnly,false);assert.equal(payload.previousSummary,'旧摘要');assert.equal(READING_POLICY.batchChars,6000);
});
