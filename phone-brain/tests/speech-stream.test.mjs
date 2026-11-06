import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {streamSpeech} from '../speech-stream.mjs';
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('speech relay streams immediately and never caches an incomplete request',async t=>{
  const out=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../verification/assistant-20261031');
  await fs.mkdir(out,{recursive:true});const directory=await fs.mkdtemp(path.join(out,'speech-test-'));
  const bytes=Buffer.alloc(32000,11);let mode='complete',closed=false;
  const upstream=http.createServer((req,res)=>{
    res.on('close',()=>{closed=true;});
    if(mode==='timeout')return;
    if(mode==='json'){res.setHeader('content-type','application/json');res.end('{"error":"unavailable"}');return;}
    res.writeHead(200,{'content-type':'audio/mpeg'});res.write(bytes.subarray(0,16000));
    if(mode==='cancel')return;
    setTimeout(()=>mode==='broken'?res.destroy():res.end(bytes.subarray(16000)),120);
  });
  const origin=await listen(upstream);let relay,cacheFile;
  const downstream=http.createServer((req,res)=>{
    relay=streamSpeech(res,{request:signal=>fetch(origin,{signal}),cacheFile,timeoutMs:mode==='timeout'?180:2000});
  });
  const base=await listen(downstream);
  async function setup(name){mode=name;closed=false;cacheFile=path.join(directory,name+'.mp3');}
  try{
    await t.test('first bytes arrive before EOF; complete bytes are atomically cached',async()=>{
      await setup('complete');
      const response=await fetch(base),reader=response.body.getReader(),first=await reader.read();
      assert.ok(first.value.length>0&&first.value.length<bytes.length);
      assert.equal(await fs.stat(cacheFile).then(()=>true,()=>false),false);
      const parts=[first.value];while(true){const next=await reader.read();if(next.done)break;parts.push(next.value);}
      assert.deepEqual(Buffer.concat(parts),bytes);assert.equal((await relay).complete,true);
      assert.deepEqual(await fs.readFile(cacheFile),bytes);
    });
    await t.test('a truncated upstream fails playback and leaves no cache',async()=>{
      await setup('broken');const response=await fetch(base);
      await assert.rejects(response.arrayBuffer());assert.equal((await relay).complete,false);
      assert.equal(await fs.stat(cacheFile).then(()=>true,()=>false),false);
    });
    await t.test('interrupting speech cancels upstream synthesis without caching a partial MP3',async()=>{
      await setup('cancel');const controller=new AbortController();
      const response=await fetch(base,{signal:controller.signal});await response.body.getReader().read();controller.abort();
      assert.equal((await relay).complete,false);
      for(let i=0;i<20&&!closed;i++)await sleep(10);
      assert.equal(closed,true);assert.equal(await fs.stat(cacheFile).then(()=>true,()=>false),false);
    });
    await t.test('a provider JSON error is never served or cached as audio',async()=>{
      await setup('json');const response=await fetch(base);assert.equal(response.status,502);await response.text();
      assert.equal((await relay).complete,false);assert.equal(await fs.stat(cacheFile).then(()=>true,()=>false),false);
    });
    await t.test('a stalled synthesis request releases the queue on timeout',async()=>{
      await setup('timeout');const response=await fetch(base);assert.equal(response.status,502);await response.text();
      assert.equal((await relay).complete,false);assert.equal(await fs.stat(cacheFile).then(()=>true,()=>false),false);
    });
    assert.deepEqual((await fs.readdir(directory)).sort(),['complete.mp3']);
  }finally{upstream.closeAllConnections();downstream.closeAllConnections();await Promise.all([new Promise(r=>upstream.close(r)),new Promise(r=>downstream.close(r))]);}
});
