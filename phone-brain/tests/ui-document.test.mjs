import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {gunzipSync} from 'node:zlib';
import {createUiDocuments} from '../ui-document.mjs';import {savedPublicRoutes} from '../public-routes.mjs';

test('both UI documents include every classic script in order and compress without truncation',()=>{
 const directory=path.resolve('phone-brain/ui'),render=createUiDocuments(directory);
 for(const name of ['index.html','float.html']){
  const original=fs.readFileSync(path.join(directory,name),'utf8'),document=render(name),text=document.body.toString();
  const scripts=[...original.matchAll(/<script src="([^"?]+)/g)].map(m=>m[1]);
  assert.deepEqual([...text.matchAll(/<script data-source="([^"]+)/g)].map(m=>m[1]),scripts);
  assert.ok(!/<script\s+src=|<link[^>]+rel="stylesheet"/.test(text));
  assert.deepEqual(gunzipSync(document.gzip),document.body);assert.ok(document.gzip.length<document.body.length/2);
  assert.ok(text.includes('window.__herUiReady=true'));assert.equal(render(name),document);
 }
});
test('a changed local script invalidates the document; HTML delimiters and missing dependencies are safe',()=>{
 const directory=fs.mkdtempSync(path.resolve('tmp/ui-document-'));try{
  fs.writeFileSync(path.join(directory,'index.html'),'<script src="/a.js"></script>');fs.writeFileSync(path.join(directory,'a.js'),'window.a="</script>";');
  const render=createUiDocuments(directory),a=render('index.html');assert.ok(a.body.toString().includes('<\\/script>'));
  fs.writeFileSync(path.join(directory,'a.js'),'window.a="changed content";');assert.notEqual(render('index.html'),a);
  fs.writeFileSync(path.join(directory,'index.html'),'<script src="/missing.js"></script>');assert.throws(()=>render('index.html'));
  fs.writeFileSync(path.join(directory,'index.html'),'<script src="/../outside.js"></script>');assert.throws(()=>render('index.html'));
 }finally{fs.rmSync(directory,{recursive:true});}
});
test('offline but recently verified secondary stays saved without being advertised as healthy',()=>{
 const now=200000000,online={url:'https://a.example',alive:true,processAlive:true,lastHealthyAt:now},recent={url:'https://b.example',alive:false,processAlive:true,lastHealthyAt:now-60000};
 assert.deepEqual(savedPublicRoutes([recent,online],now),[online,recent]);assert.equal(recent.alive,false);
 assert.deepEqual(savedPublicRoutes([online,{...recent,processAlive:false}],now),[online]);
 assert.deepEqual(savedPublicRoutes([online,{...recent,lastHealthyAt:0}],now),[online]);
 assert.deepEqual(savedPublicRoutes([online,{...recent,lastHealthyAt:now-86400001}],now),[online]);
 assert.deepEqual(savedPublicRoutes([online,{...recent,url:online.url}],now),[online]);
});
test('document embeds exact model selection and framing; metadata changes invalidate cache and cannot close the JSON element',()=>{
 const render=createUiDocuments(path.resolve('phone-brain/ui')),modelInfo={mode:'live2d',url:'/model/deepseek-chan/test.model3.json',zoom:1.03,offsetY:-.055,credits:'</script><script>window.unwanted=true</script>'};
 const first=render('index.html',{modelInfo}),text=first.body.toString(),json=/<script type="application\/json" id="herBootModel">([^]*?)<\/script>/.exec(text)?.[1];
 assert.deepEqual(JSON.parse(json),modelInfo);assert.ok(!json.includes('<'));assert.equal(render('index.html',{modelInfo}),first);
 const next=render('index.html',{modelInfo:{...modelInfo,zoom:1.2}});assert.notEqual(next,first);assert.ok(next.body.toString().includes('"zoom":1.2'));
});
