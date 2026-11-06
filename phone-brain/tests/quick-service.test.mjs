import test from 'node:test';import assert from 'node:assert/strict';
import {createQuickService} from '../quick-service.mjs';

test('quick-service accepts only its random POST route, forwards to official service and does not retry successful provisioning',async t=>{
 let calls=0;const service=await createQuickService({fetchImpl:async(url,options)=>{calls++;assert.equal(url,'https://api.trycloudflare.com/tunnel');assert.equal(options.redirect,'error');assert.equal(options.method,'POST');return new Response('{"success":true,"result":{"secret":"test-only-secret"}}');}});t.after(()=>service.close());
 assert.equal((await fetch(service.url+'/tunnel')).status,404);assert.equal((await fetch(service.url+'/else',{method:'POST'})).status,404);
 assert.equal((await fetch(service.url+'/tunnel',{method:'POST',body:'x'.repeat(4097)})).status,413);assert.equal(calls,0);
 const response=await fetch(service.url+'/tunnel',{method:'POST',body:'{}'});assert.equal(response.status,200);assert.equal((await response.json()).success,true);assert.equal(calls,1);
});
test('provisioning retries at most twice and returns a fixed diagnostic without credentials or private errors',async t=>{
 let calls=0;const service=await createQuickService({fetchImpl:async()=>{calls++;throw new Error('credential-like-private-error');}});t.after(()=>service.close());
 const response=await fetch(service.url+'/tunnel',{method:'POST'});assert.equal(response.status,502);assert.equal(calls,2);assert.equal((await response.text()).includes('credential-like'),false);
});
