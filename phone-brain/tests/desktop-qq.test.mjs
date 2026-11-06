import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createDesktopQq} from '../desktop-qq.mjs';

const roles={ownerQQ:'10001',botQQ:'10002'},secret='isolated-test-secret-for-owner-only';
const now=1793420000000;
function setup(){const received=[];const source=createDesktopQq({roles,secret,now:()=>now,onMessage:item=>received.push(item)});return {source,received};}
function input(event,overrides={}){
  const bytes=Buffer.from(JSON.stringify({time:Math.floor(now/1000),self_id:Number(roles.ownerQQ),...event}));
  return {bytes,headerSignature:'sha1='+crypto.createHmac('sha1',secret).update(bytes).digest('hex'),selfId:roles.ownerQQ,remoteAddress:'127.0.0.1',...overrides};
}
function message(extra={}){return {post_type:'message',message_type:'private',message_id:1,user_id:12345678,sender:{user_id:12345678,nickname:'虚构联系人'},message:[{type:'text',data:{text:'こんにちは，明天再聊。'}}],...extra};}
test('owner account and robot identity cannot be confused',()=>{
  const {source}=setup();
  assert.equal(source.receive(input(message({self_id:Number(roles.botQQ)}),{selfId:roles.botQQ})).code,403);
  assert.equal(source.snapshot().items.length,0);assert.equal(source.status().accountId,roles.ownerQQ);
  assert.equal(source.status().connected,false);
});
test('receive path rejects unsigned, foreign, remote and forwarded events',()=>{
  const {source}=setup();
  assert.equal(source.receive(input(message(),{headerSignature:'wrong'})).code,401);
  assert.equal(source.receive(input(message(),{selfId:roles.botQQ})).code,403);
  assert.equal(source.receive(input(message(),{remoteAddress:'192.168.1.2'})).code,403);
  assert.equal(source.receive(input(message(),{forwarded:true})).code,403);
  assert.equal(source.receive(input(message({time:Math.floor(now/1000)-8*86400}))).code,400);
});
test('muted incoming messages arrive without notifications and are deduplicated',()=>{
  const {source,received}=setup();const value=input(message());
  assert.equal(source.receive(value).code,204);assert.equal(source.receive(value).duplicate,true);
  assert.equal(received.length,1);assert.equal(source.snapshot().items[0].text,'こんにちは，明天再聊。');
  assert.equal(source.snapshot().items[0].accountId,roles.ownerQQ);assert.equal(source.status().readOnly,true);
  assert.equal(source.snapshot({since:now+1}).items.length,0);
});
test('own outgoing events never become incoming messages or quick-operation replies',()=>{
  const {source,received}=setup();
  assert.deepEqual(source.receive(input(message({post_type:'message_sent'}))),{code:204});
  assert.deepEqual(source.receive(input(message({sender:{user_id:Number(roles.ownerQQ)}}))),{code:204});
  assert.equal(received.length,0);
  const result=source.receive(input(message({user_id:Number(roles.botQQ),sender:{user_id:Number(roles.botQQ)}})));
  assert.equal(result.code,204);assert.equal(Object.hasOwn(result,'reply'),false);
  assert.equal(source.snapshot().items[0].accountId,roles.ownerQQ,'robot sender is not robot receiving account');
});
test('attachments are labeled, and group sources retain account and sender',()=>{
  const {source}=setup();
  source.receive(input(message({message_type:'group',group_id:98765432,group_name:'虚构测试群',message:[{type:'image',data:{url:'ignored'}},{type:'text',data:{text:' 看这张图'}}]})));
  const item=source.snapshot().items[0];assert.equal(item.who,'虚构测试群');assert.equal(item.sender,'虚构联系人');assert.equal(item.text,'[图片，内容尚未解析] 看这张图');assert.equal(item.attachments[0].readable,false);
  assert.equal(source.receive(input(message({message_id:2,message_type:'group',group_id:98765433,group_name:'示例群'}))).code,204);
  assert.equal(source.snapshot().items.length,1);
});
test('signed heartbeat distinguishes an offline source from an empty inbox',()=>{
  const {source}=setup();assert.equal(source.status().connected,false);
  source.receive(input({post_type:'meta_event',meta_event_type:'heartbeat',status:{online:true,good:true}}));assert.equal(source.status().connected,true);
  source.receive(input({post_type:'meta_event',meta_event_type:'heartbeat',status:{online:false}}));assert.equal(source.status().connected,false);
});
test('restart preserves only owner receipts and never assumes the live connection survived',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'her-owner-receipts-')),stateFile=path.join(directory,'inbox.json');
  const first=createDesktopQq({roles,secret,now:()=>now,stateFile});first.receive(input(message()));
  const second=createDesktopQq({roles,secret,now:()=>now,stateFile});assert.equal(second.snapshot().items.length,1);assert.equal(second.status().connected,false);
  const bytes=fs.readFileSync(stateFile+'.jsonl','utf8');assert.ok(!bytes.includes(secret));
});
