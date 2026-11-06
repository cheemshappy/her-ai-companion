import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {modelMessages,settleInterruptedTools,acceptToolResults,createSessionLocks} from '../conversation-protocol.mjs';
import {createConversationStore} from '../conversation-store.mjs';
const call=id=>({id,type:'function',function:{name:'phone_screen',arguments:'{}'}});
function valid(messages){let pending=new Set();for(const m of messages){if(m.role==='tool'){assert.ok(pending.delete(m.tool_call_id),'tool must answer current call');}else{assert.equal(pending.size,0,'every tool must be answered before a new message');for(const c of m.tool_calls||[])pending.add(c.id);}}assert.equal(pending.size,0);}
test('screenshot 400 regression: interrupted, duplicate and orphan tool records never corrupt the next model request',()=>{
 const history=[{role:'user',content:'读屏'},{role:'assistant',content:'',tool_calls:[call('a'),call('b')]},{role:'tool',tool_call_id:'a',content:'{"ok":true}'},{role:'user',content:'你好'},{role:'tool',tool_call_id:'b',content:'过期结果'}];
 const before=JSON.stringify(history),projected=modelMessages(history);valid(projected);assert.equal(JSON.stringify(history),before);const unknown=projected.find(m=>m.role==='tool'&&m.tool_call_id==='b');assert.equal(JSON.parse(unknown.content).resultUnknown,true);assert.equal(projected.at(-1).role,'user');
});
test('partial tool results wait for remaining IDs and stale batches never attach to a newer turn',()=>{
 const session={messages:[{role:'assistant',content:'',tool_calls:[call('a'),call('b')]}],toolBatchId:'batch'};
 assert.equal(acceptToolResults(session,[{id:'a',content:'好'}],'batch').complete,false);
 assert.equal(acceptToolResults(session,[{id:'b',content:'好'}],'old').stale,true);
 assert.equal(acceptToolResults(session,[{id:'b',content:'好'}],'batch').complete,true);valid(modelMessages(session.messages));
 session.messages.push({role:'assistant',content:'',tool_calls:[call('c')]});assert.equal(settleInterruptedTools(session),1);assert.equal(JSON.parse(session.messages.at(-1).content).ok,false);
});
test('context limit keeps complete tool exchanges and per-session locks serialize parallel main/floating requests',async()=>{
 const history=[];for(let i=0;i<20;i++)history.push({role:'user',content:'u'+i},{role:'assistant',content:'',tool_calls:[call('c'+i)]},{role:'tool',tool_call_id:'c'+i,content:'{}'},{role:'assistant',content:'a'+i});valid(modelMessages(history,{maxMessages:11}));
 const acquire=createSessionLocks(),order=[],release=await acquire('daily');const wait=acquire('daily').then(done=>{order.push('second');done();});await Promise.resolve();assert.deepEqual(order,[]);order.push('first');release();await wait;assert.deepEqual(order,['first','second']);
});
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'her-daily-history-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('all daily messages survive context trimming and a service restart; midnight uses a separate daily session',t=>{
 const dir=fixture(t);let clock=Date.parse('2026-10-31T23:58:00+08:00'),store=createConversationStore({stateDir:dir,now:()=>clock});const oldId=store.dayId(),s=store.get(oldId);
 for(let i=0;i<150;i++){s.messages.push({role:i%2?'assistant':'user',content:'完整内容'+i+'あ'.repeat(2000)});store.context(s);}store.save();assert.equal(store.history({day:'2026-10-31',limit:200}).items.length,150);assert.ok(s.messages.length<=60);store.close();
 store=createConversationStore({stateDir:dir,now:()=>clock});assert.equal(store.history({day:'2026-10-31',limit:200}).items[0].text.length>2000,true);
 clock=Date.parse('2026-11-01T00:00:01+08:00');assert.notEqual(store.dayId(),oldId);assert.equal(store.get().messages.length,0);assert.equal(store.days()[0].count,150);store.close();
});
test('legacy journal uses original times; unknown legacy dates stay undated and full text cannot regress after restart',t=>{
 const dir=fixture(t),inbox=path.join(dir,'legacy.jsonl'),at=Date.parse('2026-10-29T20:00:00+08:00');
 fs.writeFileSync(inbox,JSON.stringify({time:at,role:'owner',text:'长文'.repeat(250),sessionId:'legacy'})+'\n');
 fs.writeFileSync(path.join(dir,'sessions.json'),JSON.stringify({legacy:{createdAt:at,messages:[{role:'user',content:'长文'.repeat(1000)},{role:'assistant',content:'这句话没有记录时间'}]}}));
 let store=createConversationStore({stateDir:dir,legacyInboxFile:inbox});assert.equal(store.history({day:'2026-10-29'}).items[0].text.length,2000);assert.equal(store.history({day:'undated'}).items.length,1);store.save();store.close();
 store=createConversationStore({stateDir:dir,legacyInboxFile:inbox});assert.equal(store.history({day:'2026-10-29'}).items[0].text.length,2000);assert.equal(store.history({day:'2026-10-31'}).items.length,0);store.close();
});
