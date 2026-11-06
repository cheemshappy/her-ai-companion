import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createMessageHub} from '../message-hub.mjs';
function fixture(t,sourceKey='a'){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'her-review-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'hub.json');
 fs.writeFileSync(file,JSON.stringify({events:[{id:'old',conversation:'private:friend',kind:'task',title:'提交项目报告',status:'pending',sourceKeys:[sourceKey],at:Date.now()}]}));
 const messages=[{key:'a',kind:'private',conversationId:'friend',who:'同事',text:'请提交项目报告',at:Date.now()}];
 return {file,messages,source:{all:()=>messages,status:()=>({})}};
}
test('old evidence inside the middle of the recent window is explicitly supplied for review',async t=>{
 const f=fixture(t);for(let i=1;i<60;i++)f.messages.push({...f.messages[0],key:'m'+i,at:Date.now()+i,text:'后续上下文'});
 const hub=createMessageHub({...f,complete:async(messages,context)=>{assert.ok(context.priorEvidence.some(m=>m.key==='a'));return {summary:'待处理',events:[],reviewedKeys:['a'],decisions:[{id:'old',state:'keep',recipient:'owner',reason:'直接要求主人提交'}]};}});
 assert.equal((await hub.refresh()).counts.reviewing,0);
});
test('omitted decisions wait for new context without paying to repeat the same review',async t=>{
 const f=fixture(t);let calls=0;
 const hub=createMessageHub({...f,complete:async()=>{calls++;return calls===1?{summary:'暂未判定',events:[]}:{summary:'确实待处理',events:[],decisions:[{id:'old',state:'keep',recipient:'owner',reason:'新消息明确要求主人提交'}]};}});
 for(let i=0;i<4;i++)await hub.refresh();assert.equal(calls,1);
 assert.equal(hub.snapshot().counts.reviewing,0);assert.equal(hub.snapshot().counts.reviewDeferred,1);assert.equal(JSON.parse(fs.readFileSync(f.file)).events[0].status,'pending');
 f.messages.push({...f.messages[0],key:'b',at:Date.now()+10,text:'再提醒一下，请你提交'});await hub.refresh();assert.equal(calls,2);assert.equal(hub.snapshot().counts.pending,1);
});
test('expired evidence is retained without an endless AI review loop or claiming completion',async t=>{
 const f=fixture(t,'expired');let calls=0;const hub=createMessageHub({...f,complete:async()=>{calls++;return {summary:'已有最近消息',events:[]};}});
 await hub.refresh();await hub.refresh();assert.equal(calls,1);assert.equal(hub.snapshot().counts.reviewDeferred,1);assert.equal(hub.snapshot().counts.done,0);
});
