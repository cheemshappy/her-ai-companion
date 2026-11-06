import test from 'node:test';import assert from 'node:assert/strict';
import {createMessageHub} from '../message-hub.mjs';import {addressingOf} from '../desktop-qq.mjs';import {sameEvent,actionability} from '../message-relevance.mjs';
const owner='10001',now=Date.now();
const msg=(key,text,extra={})=>({key,text,kind:'group',conversationId:'12345678',who:'项目群',senderId:'87654321',sender:'同事',at:now,...extra});
test('group questions aimed at others and casual discussion never become owner replies',async()=>{
 const messages=[msg('a','@12345123 请回复一下会议时间',{mentions:['12345123']}),msg('b','你觉得哪个电影好看？'),msg('c','@10001 请确认你的参会时间',{mentions:[owner]}),msg('d','@all 各位请今天提交报名表',{mentions:['all']})];
 const source={all:()=>messages,status:()=>({connected:true})};
 const hub=createMessageHub({source,complete:async()=>({summary:'同事讨论，主人有两件事',events:[
  {title:'回复别人会议时间',kind:'reply',sourceKeys:['a'],recipient:'owner',recipientEvidence:'请回复一下会议时间'},
  {title:'回复电影问题',kind:'reply',sourceKeys:['b']},
  {title:'确认参会时间',kind:'reply',sourceKeys:['c'],recipient:'owner',recipientEvidence:'@10001'},
  {title:'提交报名表',kind:'task',sourceKeys:['d'],recipient:'everyone',recipientEvidence:'各位请今天提交报名表'},
 ]})});const result=await hub.refresh();assert.deepEqual(result.events.map(e=>e.title),['确认参会时间','提交报名表']);assert.equal(result.counts.pending,2);
});
test('one evidence item with two different actions is not collapsed; rephrased reminders reuse identity',async()=>{
 let messages=[msg('a','今天请提交报告，并确认会议时间',{kind:'private'})],round=0;
 const source={all:()=>messages,status:()=>({connected:true})};
 const hub=createMessageHub({source,complete:async(m,context)=>{round++;return {summary:'同一报告提醒',events:[{title:round===1?'提交项目报告':'完成并上交项目汇报材料',kind:'task',topicKey:'提交项目报告',existingId:context.existingEvents?.[0]?.id,sourceKeys:messages.map(m=>m.key)},{title:'确认会议时间',kind:'reply',sourceKeys:['a']}]};}});
 let board=await hub.refresh();assert.equal(board.events.length,2);const id=board.events[0].id;hub.action({id,action:'done'});messages.push(msg('b','报告再提醒一次',{kind:'private'}));board=await hub.refresh();assert.equal(board.events.length,2);assert.equal(board.events.find(e=>e.id===id).status,'done');assert.equal(board.counts.pending,1);
});
test('different dates and kinds remain distinct, even when wording overlaps',()=>{
 const a={title:'提交11月1日报告',kind:'task',sourceKeys:['a'],topicKey:'报告'};
 assert.equal(sameEvent(a,{...a,title:'提交11月2日报告'}),false);assert.equal(sameEvent(a,{...a,kind:'reply'}),false);
 assert.equal(sameEvent({title:'提交项目报告',kind:'task',sourceKeys:['a']},{title:'上交项目汇报材料',kind:'task',sourceKeys:['b']}),true);
});
test('review decisions withdraw irrelevant old cards without treating omitted tasks as completed',async()=>{
 const messages=[msg('a','请提交报告',{kind:'private'})];let phase=0;
 const hub=createMessageHub({source:{all:()=>messages,status:()=>({})},complete:async(m,c)=>phase++?{summary:'不归主人',events:[],decisions:[{id:c.existingEvents[0].id,state:'irrelevant',reason:'后文明确属于同事'}]}:{summary:'待核对',events:[{title:'提交报告',kind:'task',sourceKeys:['a']}]}});
 await hub.refresh();messages.push(msg('b','这是小李负责的，不用你处理',{kind:'private'}));const result=await hub.refresh();assert.equal(result.events.length,0);assert.equal(messages.length,2);
});
test('QQ arrays and CQ text preserve recipient metadata; @all never implies everyone must reply',()=>{
 assert.deepEqual(addressingOf('[CQ:at,qq=10001]你好').mentions,[owner]);
 assert.equal(addressingOf([{type:'reply',data:{id:'12',user_id:owner}}]).replyTo.senderId,owner);
 assert.equal(actionability({kind:'reply',recipient:'everyone'},[msg('x','@all 看看通知',{mentions:['all']})],owner).required,false);
 assert.equal(actionability({kind:'reply',recipient:'owner',recipientEvidence:'请回复'},[msg('y','@12345123 请回复',{mentions:[]})],owner).required,false);
});
