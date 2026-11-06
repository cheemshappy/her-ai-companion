import test from 'node:test';
import assert from 'node:assert/strict';
import {createCharacter} from '../character.mjs';
import {createInteractionDirector,appendInteraction,flushInteractions} from '../interaction.mjs';
import Performance from '../ui/performance.js';
function fixture(complete) {
  let clock=10000;
  const character=createCharacter({now:()=>clock,environment:()=>({hour:12,weather:'晴'})});
  const history={messages:[{role:'user',content:'我今天画画画得有点累。'},{role:'assistant',content:'那就歇一会儿，我陪你。'}]};
  const commits=[];
  const director=createInteractionDirector({character,complete,session:()=>history,commit:(...a)=>commits.push(a),persona:()=> '你喜欢陪主人画画。',now:()=>clock,debounceMs:12});
  return {character,history,commits,director,tick:(n=200)=>clock+=n};
}
test('rapid touches form one actual observation and contextual AI response in the same conversation',async()=>{
  let calls=0;
  const f=fixture(async (messages,options)=>{
    calls++;
    assert.equal(options.mode,'touch');
    assert.ok(messages[0].content.includes('你喜欢陪主人画画'));
    assert.ok(messages.some(m=>m.content.includes('画画画得有点累')));
    assert.match(messages.at(-1).content,/头2次/);
    return {text:'歇好了再画嘛，怎么又来点我。',mood:'playful',gesture:'tease',expressions:['裙子切换','兔牙'],plan:[{at:2,gesture:'peek',expressions:['体型2','脸红']}]};
  });
  const a=f.director.enqueue({id:'a',sessionId:'phone',part:'head',kind:'tap'});f.tick();
  const b=f.director.enqueue({id:'b',sessionId:'phone',part:'head',kind:'tap'});
  const [ra,rb]=await Promise.all([a,b]);
  assert.equal(calls,1);assert.equal(ra.reaction.id,rb.reaction.id);assert.equal(rb.reaction.count,2);assert.equal(rb.reaction.ai,true);
  assert.deepEqual(rb.expressions,['兔牙']);assert.deepEqual(rb.plan[0].expressions,['脸红']);
  assert.match(f.history.messages.at(-2).content,/实际感知/);assert.match(f.history.messages.at(-1).content,/歇好了/);
  assert.equal(f.commits.length,1);
  assert.equal((await f.director.enqueue({id:'b',part:'head',kind:'tap'})).duplicate,true);assert.equal(calls,1);
});
test('a newer touch cancels a late response, while both observations remain recorded',async()=>{
  let firstResolve,entered;const started=new Promise(r=>entered=r);let calls=0;
  const f=fixture(async()=>{calls++;if(calls===1){entered();return new Promise(r=>firstResolve=r);}return {text:'刚摸完头又碰尾巴呀。',mood:'shy',gesture:'shy'};});
  const a=f.director.enqueue({id:'a',part:'head',kind:'rub'});await started;f.tick();
  const b=f.director.enqueue({id:'b',part:'tail',kind:'tap'});
  firstResolve({text:'过时的话',mood:'happy'});
  assert.equal((await a).superseded,true);
  assert.equal((await b).reaction.id,'b');assert.equal(f.character.get().mood,'shy');
  assert.equal(f.history.messages.filter(m=>m.content.includes('实际感知')).length,2);
  assert.ok(!f.history.messages.some(m=>m.content==='过时的话'));
});
test('offline response varies, stays marked offline, and spoken conversation cancels pending touch speech',async()=>{
  const f=fixture(async()=>{throw new Error('offline');});
  const a=await f.director.enqueue({id:'a',part:'head',kind:'tap'});f.tick();
  const b=await f.director.enqueue({id:'b',part:'head',kind:'tap'});
  assert.equal(a.reaction.ai,false);assert.equal(b.offline,true);assert.notEqual(a.reaction.text,b.reaction.text);
  let resolve,entered;const started=new Promise(r=>entered=r);
  const g=fixture(async()=>{entered();return new Promise(r=>resolve=r);});
  const pending=g.director.enqueue({id:'c',part:'hand',kind:'tap'});await started;g.character.engage();
  resolve({text:'别打断正在聊的话',mood:'calm'});
  assert.equal((await pending).superseded,true);
  assert.ok(!g.history.messages.some(m=>m.content==='别打断正在聊的话'));
});
test('interaction records wait until every phone-tool response is complete',()=>{
  const s={messages:[{role:'assistant',tool_calls:[{id:'one'},{id:'two'}]}]};
  appendInteraction(s,[{role:'user',content:'摸头'}]);assert.equal(s.messages.length,1);
  s.messages.push({role:'tool',tool_call_id:'one',content:'ok'});flushInteractions(s);assert.equal(s.messages.length,2);
  s.messages.push({role:'tool',tool_call_id:'two',content:'ok'});flushInteractions(s);assert.equal(s.messages.at(-1).content,'摸头');
});
test('silent AI gestures have a cooldown and cannot change the chosen clothes',async()=>{
  let calls=0;
  const f=fixture(async(_messages,options)=>{assert.equal(options.mode,'idle');calls++;return {mood:'thinking',gesture:'think',expressions:['裙子切换','黑框眼镜']};});
  const a=await f.director.idle('phone');assert.deepEqual(a.expressions,['黑框眼镜']);
  assert.equal((await f.director.idle('phone')).skipped,true);assert.equal(calls,1);
  f.tick(66000);await f.director.idle('phone');assert.equal(calls,2);
  assert.equal(f.history.messages.length,2);
});
test('acting profiles anticipate, remain continuous, and recover to rest',()=>{
  for(const name of Object.keys(Performance.profiles)){
    for(const u of [0,1])for(const v of Object.values(Performance.sample(name,u)))assert.equal(v,0,name+' endpoint');
    let previous=Performance.sample(name,0);
    for(let i=1;i<=200;i++){
      const pose=Performance.sample(name,i/200);
      for(const key of Performance.channels){assert.ok(Number.isFinite(pose[key]));assert.ok(Math.abs(pose[key]-previous[key])<2,name+' continuous '+key);}
      previous=pose;
    }
  }
  assert.ok(Performance.sample('tilt',.13).gx>.15);
  assert.ok(Math.abs(Performance.sample('tilt',.13).px)<.1);
  const idle=Performance.createIdle(()=>.5);idle(0);
  assert.ok(Object.values(idle(6)).every(v=>v===0),'idle includes an actual quiet interval');
});
