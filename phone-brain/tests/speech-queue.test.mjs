import test from 'node:test';import assert from 'node:assert/strict';import Speech from '../ui/speech-queue.js';import Text from '../ui/speech-text.js';
test('bounded speech preserves every character, including >300-character middle paragraphs and Japanese',()=>{
 for(const input of ['让我看看，消息都已经整理好了。重要的事情会留在这里。','前半段。'+('中间内容不要漏掉，'.repeat(65))+'最后一段。','こんにちは。今日は一緒にゆっくり過ごしましょう。','日本語🙂English中文 '.repeat(80)]){
  const parts=Text.split(input);assert.equal(parts.join(''),input);assert.ok(parts.every(p=>Array.from(p).length<=100));let pending='',done=[];for(const c of input){pending+=c;let next;while((next=Text.take(pending,{first:!done.length}))){done.push(next.piece);pending=next.rest;}}done.push(...Text.split(pending));assert.equal(done.join(''),input);assert.ok(done.every(p=>Array.from(p).length<=100));
 }
});
test('UTF8 stream ending without newline delivers its last sentence and final text',async()=>{
 const text='{"type":"sentence","text":"中间内容。"}\n{"type":"done","text":"最后一句。"}',bytes=new TextEncoder().encode(text);const rows=[];
 await Text.readLines(new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=2)c.enqueue(bytes.slice(i,i+2));c.close();}})),line=>rows.push(JSON.parse(line)));assert.equal(rows[1].text,'最后一句。');assert.equal(rows.length,2);
});
test('middle synthesis failure retries that exact sentence before later speech, with bounded prefetch',async()=>{
 const opens=[],played=[],counts=new Map();let release,playing;
 const gate=new Promise(r=>release=r),start=new Promise(r=>playing=r);
 const queue=Speech.create({open:(text,options)=>{opens.push(text);const n=(counts.get(text)||0)+1;counts.set(text,n);return {text,ready:Promise.resolve(text!=='middle'||n>1),dispose(){}};},play:async stream=>{played.push(stream.text);if(stream.text==='first'){playing();await gate;}return {ok:true};}});
 const done=queue.enqueue('first');queue.enqueue('middle');queue.enqueue('last');await start;assert.ok(opens.length<=2);assert.ok(!opens.includes('last'));release();await done;assert.deepEqual(played,['first','middle','last']);assert.equal(counts.get('middle'),2);
});
test('permanent middle failure pauses instead of skipping; retry resumes and interrupted playback seeks to saved position',async()=>{
 const played=[];let broken=true,partial=true;
 const queue=Speech.create({open:text=>({text,ready:Promise.resolve(text!=='middle'||!broken),dispose(){}}),play:async(stream,options)=>{played.push([stream.text,options.offset]);if(stream.text==='middle'&&partial){partial=false;return {ok:false,position:1.8};}return {ok:true};}});
 queue.enqueue('first');queue.enqueue('middle');await queue.enqueue('last');assert.equal(queue.status,'paused');assert.deepEqual(played,[['first',0]]);broken=false;await queue.resume();assert.deepEqual(played,[['first',0],['middle',0],['middle',1.8],['last',0]]);assert.equal(queue.pending,0);
});
test('user interruption cancels queued speech and does not retry or play an old reply',async()=>{
 let ready,started;const gate=new Promise(r=>ready=r),begin=new Promise(r=>started=r);const played=[];
 const queue=Speech.create({open:text=>({text,ready:gate,dispose(){}}),play:async s=>{played.push(s.text);return true;},onState:()=>started()});const wait=queue.enqueue('old');await begin;queue.cancel();ready(true);await wait;await new Promise(r=>setTimeout(r,10));assert.deepEqual(played,[]);assert.equal(queue.pending,0);
});
