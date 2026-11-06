import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createMessageHub} from '../message-hub.mjs';
import {pruneStaleMessages,unreadMessages,messageRevision,startOfDay} from '../message-reading.mjs';
import {ANALYSIS_VERSION} from '../message-relevance.mjs';
const now=Date.parse('2026-11-02T16:00:00+08:00'),hour=3600000;
const msg=(key,text,age=8,extra={})=>({key,text,at:now-age*hour,kind:'private',conversationId:'friend',who:'合成测试',sender:'合成测试',...extra});
const reading=()=>({version:1,since:startOfDay(now-3*86400000),covered:{}});
function setup(t,messages,events=[]){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'her-retention-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'hub.json');fs.writeFileSync(file,JSON.stringify({events,conversations:{},reading:reading()}));return {file,now:()=>now,source:{all:()=>messages,status:()=>({connected:true})}};}
const answer=m=>({summary:'合成整理结果',events:[],reviewedKeys:m.map(x=>x.key)});

test('six-hour-old acknowledgements and emoji expire locally; recent replies and real requests remain',()=>{
 const r=reading(),messages=[msg('ack','好的，谢谢！'),msg('emoji','👍😊'),msg('recent','好的',1),msg('task','请明天确认会议时间'),msg('attachment','[图片]',8,{attachments:[{readable:false}]})];
 pruneStaleMessages(messages,r,{now});assert.deepEqual(unreadMessages(messages,r,now).map(x=>x.key),['recent','task','attachment']);assert.equal(r.discarded.ack.reason,'stale-acknowledgement');assert.equal(r.covered.ack,undefined);
});
test('old unaddressed group chatter and messages for other people expire, while owner/all announcements survive',()=>{
 const r=reading(),group={kind:'group'};const messages=[msg('chat','昨天那个梗笑死我了',30,group),msg('other','@123456789 请确认提交时间',8,{...group,mentions:['123456789']}),
 msg('owner','@10001 记得回复',30,{...group,mentions:['10001']}),msg('all','@all 明天请各位提交作业',30,{...group,mentions:['all']}),msg('useful','明天上午九点会议，地点在报告厅',30,group)];
 pruneStaleMessages(messages,r,{now});assert.deepEqual(unreadMessages(messages,r,now).map(x=>x.key),['owner','all','useful']);
});
test('unfinished, pinned and snoozed evidence is never discarded just because it is old',()=>{
 const r=reading(),messages=[msg('pending','收到',32),msg('pinned','哈哈',32),msg('snoozed','好的',32)];const events=messages.map((m,i)=>({sourceKeys:[m.key],status:i===0?'pending':'done',pinned:i===1,snoozedUntil:i===2?now+hour:0}));
 pruneStaleMessages(messages,r,{now,events});assert.deepEqual(Object.keys(r.discarded),[]);assert.equal(unreadMessages(messages,r,now).length,3);
});
test('edited discarded messages revive; fresh quotes revive the exact old message',()=>{
 const r=reading(),m=msg('old','好的',30,{messageId:'quoted-id'});pruneStaleMessages([m],r,{now});assert.equal(unreadMessages([m],r,now).length,0);
 const edit={...m,text:'明天请你提交报告'};pruneStaleMessages([edit],r,{now});assert.equal(unreadMessages([edit],r,now).length,1);
 pruneStaleMessages([m],r,{now});const quote=msg('new','这件事现在怎么安排？',0,{replyTo:{messageId:'quoted-id'}});pruneStaleMessages([m,quote],r,{now});assert.equal(r.discarded.old,undefined);assert.equal(unreadMessages([m,quote],r,now).length,2);
});
test('an all-stale queue makes zero model calls, survives restart, and keeps original local messages',async t=>{
 const messages=[msg('a','好的'),msg('b','😂')],f=setup(t,messages);let calls=0;const complete=async m=>{calls++;return answer(m);};let h=createMessageHub({...f,complete});await h.refresh();
 assert.equal(calls,0);assert.equal(h.snapshot().reading.pending,0);assert.equal(h.snapshot().reading.discarded,2);h=createMessageHub({...f,complete});await h.refresh();assert.equal(calls,0);assert.equal(messages.length,2);
});
test('mixed backlog sends only meaningful content and never treats skipped messages as AI-reviewed',async t=>{
 const messages=[msg('a','收到'),msg('task','请明天提交报告')],f=setup(t,messages),seen=[];const h=createMessageHub({...f,complete:async m=>{seen.push(...m.map(x=>x.key));return answer(m);}});await h.refresh();
 assert.deepEqual(seen,['task']);const saved=JSON.parse(fs.readFileSync(f.file));assert.equal(saved.reading.covered.a,undefined);assert.ok(saved.reading.discarded.a);assert.ok(saved.reading.covered.task);await h.refresh();assert.deepEqual(seen,['task']);
});
test('all conversations are cleaned locally even when the three-batch model limit is reached',async t=>{
 const fresh=Array.from({length:4},(_,i)=>msg('fresh'+i,'请确认今天的会议',0,{conversationId:'fresh'+i}));
 const stale=Array.from({length:3},(_,i)=>msg('stale'+i,'好的，谢谢',8,{conversationId:'stale'+i}));const f=setup(t,[...fresh,...stale]);let calls=0;
 const h=createMessageHub({...f,complete:async m=>{calls++;return answer(m);}});await h.refresh();assert.equal(calls,3);assert.equal(h.snapshot().reading.discarded,3);assert.equal(h.snapshot().reading.pending,1);
});
test('done cards and old idle summaries are omitted from future AI context; active task summaries stay',async t=>{
 const old=msg('old','请提交报告',50),fresh=msg('new','新的讨论开始了',0),f=setup(t,[old,fresh],[{id:'done',conversation:'private:friend',title:'提交报告',kind:'task',status:'done',sourceKeys:['old'],at:old.at,analysisVersion:ANALYSIS_VERSION}]);
 const state=JSON.parse(fs.readFileSync(f.file));state.conversations['private:friend']={summary:'很早以前已结束的话题',lastMessageAt:old.at};state.reading.covered.old={revision:messageRevision(old),offset:old.text.length,at:old.at};fs.writeFileSync(f.file,JSON.stringify(state));
 const h=createMessageHub({...f,complete:async(m,c)=>{assert.deepEqual(c.existingEvents,[]);assert.equal(c.previousSummary,'');assert.equal(c.priorEvidence.length,0);return answer(m);}});await h.refresh();assert.equal(h.snapshot().counts.done,1);
});
test('coverage for an unchanged old message is retained while the source still contains it',async t=>{
 const old=msg('old','很早但已经读过的消息',240),f=setup(t,[old]);const state=JSON.parse(fs.readFileSync(f.file));state.reading.since=old.at-hour;state.reading.covered.old={revision:messageRevision(old),offset:old.text.length,at:old.at};fs.writeFileSync(f.file,JSON.stringify(state));let calls=0;
 const h=createMessageHub({...f,complete:async m=>{calls++;return answer(m);}});await h.refresh();await h.refresh();assert.equal(calls,0);assert.ok(JSON.parse(fs.readFileSync(f.file)).reading.covered.old);
});
