import test from 'node:test';
import assert from 'node:assert/strict';
import Intent from '../ui/assistant-intent.js';
import Actions from '../ui/action-policy.js';
import Performance from '../ui/performance.js';
import {createCharacter} from '../character.mjs';

test('explicit Bilibili search keeps biology and Japanese query text intact',()=>{
 for(const request of ['去B站搜索鲸鱼交配','帮我在b站搜一下鲸鱼交配','B站搜索「鲸鱼交配」','搜一下b站的鲸鱼交配'])
  assert.deepEqual(Intent.bilibili(request),{action:'search',query:'鲸鱼交配'},request);
 assert.deepEqual(Intent.bilibili('在B站搜索クジラの生態'),{action:'search',query:'クジラの生態'});
 assert.deepEqual(Intent.bilibili('去B站找猫咪视频并全屏播放'),{action:'play',query:'猫咪视频',fullscreen:true});
 assert.equal(Intent.bilibili('B站搜索鲸鱼交配').fullscreen,undefined);
});
test('mentions, quoted messages, missing queries and no-search instructions do not execute shortcuts',()=>{
 for(const text of ['鲸鱼交配','比如B站搜索鲸鱼交配','为什么b站不能搜鲸鱼交配','不要在B站搜索鲸鱼交配','他说去B站搜鲸鱼交配','B站搜索','解释B站搜索鲸鱼交配是什么意思'])assert.equal(Intent.bilibili(text),null,text);
 for(const text of ['不要前倾','解释身体前倾的意思','视频里的她身体前倾了','搜索身体前倾的教程','为什么你不能靠近一点'])assert.equal(Intent.character(text),null,text);
});
test('natural movement requests choose distinct forward, proximity, retreat and recovery performances',()=>{
 assert.equal(Intent.character('让身体前倾靠近一点').gesture,'approach');
 assert.equal(Intent.character('身体向前倾一点').gesture,'lean');
 assert.equal(Intent.character('你能不能靠近一点').gesture,'approach');
 assert.equal(Intent.character('请你退后一点').gesture,'retreat');
 assert.equal(Intent.character('恢复原来的姿势').gesture,'settle');
 assert.equal(Intent.character('挥挥手').gesture,'wave');
 for(const text of ['身体前倾一点','靠近一点','退后一点','歪歪头'])assert.equal(Actions.isAction(text),true,text);
});
test('forward movement drives the real lean channel and camera with bounded continuous entry, hold and recovery',()=>{
 for(const name of ['lean','approach','retreat']){
  const samples=Array.from({length:601},(_,i)=>Performance.sample(name,i/600,.8));
  assert.ok(samples.some(p=>Math.abs(p.lean)>8));
  assert.equal(samples[0].lean,0);assert.equal(samples.at(-1).lean,0);
  for(let i=1;i<samples.length;i++){assert.ok(Math.abs(samples[i].lean-samples[i-1].lean)<1);assert.ok(Math.abs(samples[i].proximity-samples[i-1].proximity)<.005);}
 }
 assert.ok(Performance.sample('approach',.5).proximity>0);
 assert.ok(Performance.sample('retreat',.5).proximity<0);
 assert.ok(Math.abs(Performance.sample('lean',.5).z)<2);
});
test('movement identity survives polling without blocking a later command or allowing stale directors',()=>{
 let now=10000;const c=createCharacter({now:()=>now});
 const version=c.version();const value=c.set({...Intent.character('靠近一点'),performanceId:'action-123'},'tool');
 assert.equal(value.performanceId,'action-123');now+=2000;assert.equal(c.get().performanceId,'action-123');
 c.set({mood:'sad'},'ai',{expectedVersion:version});assert.equal(c.get().performanceId,'action-123');
 c.set({...Intent.character('退后一点'),performanceId:'action-456'},'tool');assert.equal(c.get().performanceId,'action-456');
});
