import test from 'node:test';
import assert from 'node:assert/strict';
import Actions from '../ui/action-policy.js';
import {leadingText,readPerformance} from '../performance-stream.mjs';
import {createInteractionDirector} from '../interaction.mjs';
import {createCharacter} from '../character.mjs';

test('requested daily messages are allowed; input content never acts as an action label',()=>{
  for(const text of ['给张三发微信说我到了','帮我回复他明天见','告诉妈妈我在路上','QQ给李四回一句こんにちは','发吧']){
    assert.equal(Actions.begin(text),true,text);
    assert.equal(Actions.check({name:'phone_send_message',args:{app:'QQ',to:'测试',text:'こんにちは'}}),null);
    assert.equal(Actions.check({name:'phone_tap_text',args:{text:'发送'}}),null);
    assert.equal(Actions.prepare({name:'phone_wechat_send',args:{}}).args.confirm,true);
  }
  for(const text of ['给微信里的手握风云和QQ里的手握风云中她发一条消息','给微信里这位备注很长很长很长很长很长的联系人说我到了','同样的内容也给QQ那位','帮我搜B站的猫','直接发送就好了，不用只写草稿不发送','不要只拟草稿，直接发送','帮我拟一句回复并发给张三']){
    assert.equal(Actions.begin(text),true,text);
    assert.equal(Actions.check({name:'phone_send_message',args:{app:'QQ',to:'测试联系人',text:'测试'}}),null);
  }
  Actions.begin('删除这个临时文件');assert.equal(Actions.check({name:'phone_tap_text',args:{text:'确认删除'}}),null);
  Actions.begin('给张三回复一条消息');
  assert.equal(Actions.check({name:'phone_type',args:{text:'日语の「削除」は删除，先不要发送。'}}),null);
  assert.equal(Actions.check({name:'phone_tap_text',args:{text:'确认支付'}}),null);
  assert.equal(Actions.check({name:'phone_tap_text',args:{text:'删除聊天记录'}}),null);
  assert.equal(Actions.check({name:'phone_shell',args:{command:'rm -rf /sdcard/test'}}),null);
  assert.equal(Actions.check({name:'phone_shell',args:{command:'input keyevent 66'}}),null);
  Actions.begin('只拟一条给张三的草稿，不要发送');
  assert.ok(Actions.check({name:'phone_send_message',args:{}}));
  Actions.begin('只查看微信消息，不要发送');assert.ok(Actions.check({name:'phone_tap_text',args:{text:'发送'}}));
  Actions.begin('不要先拟草稿，也不要发送');assert.ok(Actions.check({name:'phone_send_message',args:{}}));
});
test('voice action requests use the tool path, including messaging, video and Japanese tasks',()=>{
  for(const text of ['去B站找猫咪视频并全屏播放','微信有没有人找我','帮我输入こんにちは','把手机音量调低','音量小一点','输入こんにちは','Bilibiliで動画を再生して','検索して','play a cat video','给李四回复一下','设个明天七点的闹钟'])assert.equal(Actions.isAction(text),true,text);
  assert.equal(Actions.isAction('今天你心情怎么样'),false);
});
test('JSON leading text handles escapes and waits for a complete string',()=>{
  assert.equal(leadingText('{"text":"你说\\"こんにちは\\"。", "mood":'), '你说"こんにちは"。');
  assert.equal(leadingText('{"text":"还没结束'),null);
});
test('performance speech arrives before the rest of the plan, across UTF8/SSE chunks',async()=>{
  const encoder=new TextEncoder();let release,first;
  const gate=new Promise(r=>release=r),spoken=new Promise(r=>first=r);
  const sse=text=>'data: '+JSON.stringify({choices:[{delta:{content:text}}]})+'\n\n';
  const body=new ReadableStream({async start(controller){
    const data=encoder.encode(sse('{"text":"こんにちは。"'));
    for(let i=0;i<data.length;i+=3)controller.enqueue(data.slice(i,i+3));
    await gate;controller.enqueue(encoder.encode(sse(',"mood":"shy","gesture":"peek"}')+'data: [DONE]\n\n'));controller.close();
  }});
  let finished=false;
  const result=readPerformance(new Response(body,{headers:{'content-type':'text/event-stream'}}),text=>first(text)).then(value=>{finished=true;return value;});
  assert.equal(await spoken,'こんにちは。');assert.equal(finished,false);
  release();assert.equal((await result).value.gesture,'peek');
});
test('an incomplete metadata tail keeps the actual spoken AI sentence',async()=>{
  const content='data: '+JSON.stringify({choices:[{delta:{content:'{"text":"我听见啦。","plan":['}}]})+'\n\ndata: [DONE]\n\n';
  const result=await readPerformance(new Response(content,{headers:{'content-type':'text/event-stream'}}));
  assert.equal(result.value.text,'我听见啦。');
});
test('early interaction reaction is not delayed by motion generation or replayed after new contact',async()=>{
  let finish,started;
  const start=new Promise(r=>started=r),character=createCharacter({environment:()=>({hour:12})});
  const director=createInteractionDirector({character,session:()=>({messages:[]}),commit:()=>{},debounceMs:1,
    complete:async(_,{onText})=>{onText('嗯，我在呢。');started();return new Promise(r=>finish=r);}});
  const reactions=[];let done=false;
  const request=director.enqueue({id:'quick',part:'head',kind:'tap'},{onReaction:value=>reactions.push(value)}).then(v=>{done=true;return v;});
  await start;assert.equal(reactions.length,1);assert.equal(done,false);
  character.engage();finish({text:'嗯，我在呢。',mood:'happy'});
  assert.equal((await request).superseded,true);
});
