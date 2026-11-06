import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createMessageHub} from '../message-hub.mjs';
import {createMediaContext} from '../media-context.mjs';
import {messageContent,createDesktopQq} from '../desktop-qq.mjs';
import {startQqRecovery} from '../qq-recovery.mjs';
import {DatabaseSync} from 'node:sqlite';
import Actions from '../ui/action-policy.js';
const now=Date.now(),roles={ownerQQ:'10001',botQQ:'10002'};
function fixture(){let messages=[{key:'a',kind:'private',conversationId:'12345678',who:'测试同事',sender:'测试同事',text:'今天请提交报告，并回复会议时间。',at:now}];return {all:()=>messages,status:()=>({connected:true}),append:m=>messages.push({...messages[0],...m})};}
test('summary events must have real evidence; two tasks in one message remain distinct',async()=>{
 const source=fixture(),hub=createMessageHub({source,complete:async()=>({summary:'两件事情',events:[{title:'提交报告',priority:'urgent',kind:'task',sourceKeys:['a']},{title:'回复会议时间',priority:'today',kind:'reply',sourceKeys:['a']},{title:'虚构付费',priority:'urgent',sourceKeys:['invented']}]})});
 const result=await hub.refresh();assert.equal(result.events.length,2);assert.equal(result.counts.pending,2);assert.equal(result.counts.urgent,1);
 assert.ok(result.events.every(e=>e.sourceKeys.includes('a')));
});
test('complete, snooze, pin and reopen survive re-analysis and disk reload',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'her-hub-')),file=path.join(directory,'hub.json'),source=fixture();
 const complete=async()=>({summary:'报告要交',events:[{title:'提交报告',priority:'today',sourceKeys:['a'],kind:'task'}]});
 const hub=createMessageHub({file,source,complete,now:()=>now});let result=await hub.refresh(),id=result.events[0].id;
 assert.equal(hub.action({id,action:'snooze',until:now+3600000}).counts.snoozed,1);assert.equal(hub.action({id,action:'pin'}).events[0].pinned,true);
 assert.equal(hub.action({id,action:'done'}).counts.done,1);source.append({key:'b',text:'补一条信息'});await hub.refresh();assert.equal(hub.snapshot().events[0].status,'done');
 const reloaded=createMessageHub({file,source,complete,now:()=>now});assert.equal(reloaded.action({id,action:'reopen'}).counts.pending,1);
 assert.throws(()=>hub.action({id,action:'snooze',until:0}));
});
test('summary failure keeps source text and shows review state, without inventing a successful AI summary',async()=>{
 const source=fixture(),hub=createMessageHub({source,complete:async()=>{throw new Error('offline');}});
 const result=await hub.refresh();assert.equal(result.conversations[0].ai,false);assert.ok(result.events[0].needsReview);assert.match(result.error,/暂不可用/);
 assert.equal(source.all()[0].text,'今天请提交报告，并回复会议时间。');
});
test('legacy todos remain available and completing one changes only the selected task',()=>{
 let todos=[{id:1,text:'买牛奶',at:now,done:false}],calls=0;
 const hub=createMessageHub({source:fixture(),complete:async()=>({}),readTodos:()=>todos,finishTodo:(id,done)=>{calls++;todos[0].done=done;}});
 assert.equal(hub.snapshot().events[0].title,'买牛奶');hub.action({id:'todo:1',action:'done'});assert.equal(calls,1);assert.equal(hub.snapshot().counts.done,1);
 hub.action({id:'todo:1',action:'reopen'});assert.equal(hub.action({id:'todo:1',action:'pin'}).events[0].pinned,true);
 assert.equal(hub.action({id:'todo:1',action:'snooze',until:Date.now()+3600000}).counts.snoozed,1);
});
test('long text, CQ markup and named attachments remain visible, with unsupported content labeled',()=>{
 const text='日语こんにちは'.repeat(1000);assert.equal(messageContent([{type:'text',data:{text}}]).text,text);
 const parsed=messageContent('明天[CQ:file,name=报告.pdf]请看[CQ:image,file=x]');assert.match(parsed.text,/报告.pdf/);assert.match(parsed.text,/尚未解析/);
 assert.equal(parsed.attachments.length,2);
});
test('more than 400 receipts remain paginated without silently losing earlier messages',()=>{
 const source=createDesktopQq({roles});
 const events=Array.from({length:450},(_,index)=>({time:Math.floor(now/1000),self_id:Number(roles.ownerQQ),post_type:'message',message_type:'private',message_id:index+1,user_id:12345678,message:[{type:'text',data:{text:'消息 '+index}}]}));
 assert.equal(source.restore(events),450);const first=source.snapshot({limit:200}),second=source.snapshot({limit:200,before:first.nextCursor}),third=source.snapshot({limit:200,before:second.nextCursor});
 assert.equal(first.total,450);assert.equal(first.hasMore,true);assert.equal(third.hasMore,false);
 assert.equal(new Set([...first.items,...second.items,...third.items].map(x=>x.key)).size,450);
 assert.equal(source.status().connected,false,'cache recovery does not fabricate a live heartbeat');
});
test('default video requests force fullscreen, and explicit small-window requests remain possible',()=>{
 Actions.begin('打开B站猫咪视频');assert.equal(Actions.prepare({name:'phone_bilibili',args:{action:'play',fullscreen:false}}).args.fullscreen,true);
 Actions.begin('打开视频，先不要全屏');assert.equal(Actions.prepare({name:'phone_bilibili',args:{action:'play'}}).args.fullscreen,false);
});
test('AI media memory keeps the last actually opened title and reports unverified playback honestly',()=>{
 const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'her-media-')),'context.json');
 const media=createMediaContext({now:()=>now,file});media.record('s',{name:'phone_bilibili',args:{action:'play',query:'猫咪'}},{opened:true,mediaTitle:'测试猫咪',playing:true,playbackVerified:true,fullscreen:true,ok:true});
 media.record('s',{name:'phone_bilibili',args:{action:'pause'}},{foreground:true,playing:false,playbackVerified:true,fullscreen:true,ok:true});
 assert.equal(media.get('s').title,'测试猫咪');assert.equal(media.get('s').playing,false);assert.match(media.prompt('s'),/没有因此看到或听到/);
 assert.equal(media.get('other'),null);
 assert.equal(createMediaContext({now:()=>now,file}).get('s').title,'测试猫咪');
});
test('read-only recovery fills a missed local event, deduplicates live receipt, and never alters gateway rows',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'her-qq-recovery-')),database=path.join(directory,'messages.db');
 const db=new DatabaseSync(database);db.exec('CREATE TABLE messages(message_hash INTEGER PRIMARY KEY,timestamp INTEGER,data TEXT)');
 const event={time:Math.floor(now/1000),self_id:Number(roles.ownerQQ),post_type:'message',message_type:'private',message_id:123,user_id:12345678,sender:{user_id:12345678,nickname:'虚构联系人'},message:[{type:'text',data:{text:'请补回这条消息'}}]};
 db.prepare('INSERT INTO messages VALUES(?,?,?)').run(123,event.time,JSON.stringify(event));db.close();
 const source=createDesktopQq({roles});const stop=await startQqRecovery({source,ownerQQ:roles.ownerQQ,database,cursorFile:path.join(directory,'cursor.json'),interval:100000});
 for(let i=0;i<30&&!source.all().length;i++)await new Promise(r=>setTimeout(r,10));stop();
 assert.equal(source.all().length,1);assert.equal(source.status().connected,false);assert.equal(source.status().recovery.available,true);
 assert.equal(source.restore([event]),0);const check=new DatabaseSync(database,{readOnly:true});assert.equal(check.prepare('SELECT count(*) n FROM messages').get().n,1);check.close();
});
