import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {createSharedAiFetch} from '../shared-ai-budget.mjs';

function setup(t,{allowed=true,sse=false,fail=false,ownerPriority=false}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'shared-ai-fetch-'));fs.mkdirSync(path.join(root,'state'));fs.writeFileSync(path.join(root,'state/console-token'),'fixture');
 fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({socialV2:{dailyBudget:{ownerServicePriority:ownerPriority}}}));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const calls=[];
 const usage={prompt_tokens:100,completion_tokens:20,prompt_cache_hit_tokens:60};
 const usageFile=path.join(root,'state/ai-requests.jsonl');
 const run=createSharedAiFetch({bridgeRoot:root,usageFile,fetchImpl:async(url,init)=>{
  if(String(url).startsWith('http://127.0.0.1:3100/')){calls.push({action:String(url).split('/').at(-1),body:JSON.parse(init.body)});return Response.json({ok:true,allowed,message:allowed?'':'今日共享预算已到'});}
  calls.push({action:'model'});if(fail)throw new Error('fake network');
  return sse?new Response('data: {"choices":[{"delta":{"content":"fixture-response"}}]}\n\ndata: '+JSON.stringify({usage,model:'fixture-resolved-model'})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
   :Response.json({choices:[{message:{content:'fixture-response'}}],usage,model:'fixture-resolved-model'});
 }});return{run,calls,usage,usageFile};
}
test('预算拒绝不请求图源/模型，报可读原因',async t=>{const{run,calls}=setup(t,{allowed:false});await assert.rejects(run('https://api.deepseek.com/chat/completions',{body:'{"model":"deepseek-chat"}'}),/预算已到/);assert.equal(calls.length,1);});
for(const sse of [false,true])test(sse?'流式内容透传并统计最终usage一次':'JSON内容透传并结算usage，不上传聊天文本',async t=>{
 const{run,calls,usage,usageFile}=setup(t,{sse});const res=await run('https://api.deepseek.com/chat/completions',{body:'{"model":"deepseek-chat","messages":[{"content":"private text"}]}'});
 const text=await res.text();assert.ok(text.includes('fixture-response'));assert.deepEqual(calls.at(-1).body.usage,usage);assert.equal(calls.filter(c=>c.action==='settle').length,1);assert.ok(!JSON.stringify(calls).includes('private text'));
 const log=fs.readFileSync(usageFile,'utf8');assert.ok(!log.includes('private text'));assert.ok(!log.includes('fixture-response'));
 const rows=log.trim().split('\n').map(JSON.parse);assert.equal(rows.length,1);assert.equal(rows[0].source,'phone-chat');assert.equal(rows[0].model,'fixture-resolved-model');assert.deepEqual(rows[0].usage,usage);
});
test('网络失败结算失败状态，测试/其它提供方不调用共享账本',async t=>{
 const{run,calls}=setup(t,{fail:true});await assert.rejects(run('https://api.deepseek.com/chat/completions',{body:'{}'}),/fake network/);await new Promise(r=>setImmediate(r));assert.equal(calls.at(-1).body.outcome,'network-error');
 calls.length=0;await assert.rejects(run('https://fixture.invalid/chat/completions',{body:'{}'}));assert.equal(calls.length,1);assert.equal(calls[0].action,'model');
});

test('用户主动服务优先，即使预算控制器拒绝或暂不可用也保留回复和本地用量，后台仍受控',async t=>{
 const{run,calls,usageFile}=setup(t,{allowed:false,ownerPriority:true});
 const response=await run('https://api.deepseek.com/chat/completions',{body:'{"model":"deepseek-chat"}'});
 assert.ok((await response.text()).includes('fixture-response'));assert.equal(calls.filter(x=>x.action==='model').length,1);
 assert.equal(JSON.parse(fs.readFileSync(usageFile,'utf8')).budgetFallback,true);
 await assert.rejects(run('https://api.deepseek.com/chat/completions',{body:'{"model":"deepseek-chat"}'},{source:'phone-idle',interactive:false}),/预算已到/);
 assert.equal(calls.filter(x=>x.action==='model').length,1);
});
