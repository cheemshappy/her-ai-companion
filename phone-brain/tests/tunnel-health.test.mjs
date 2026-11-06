import test from 'node:test';import assert from 'node:assert/strict';import {cloudflareUrl,probeTunnel} from '../tunnel-health.mjs';
test('API errors never masquerade as a published tunnel endpoint',()=>{
 assert.equal(cloudflareUrl('Post "https://api.trycloudflare.com/tunnel": timeout'),'');
 assert.equal(cloudflareUrl('https://api.trycloudflare.com/tunnel\nVisit: https://quiet-blue-sea.trycloudflare.com'),'https://quiet-blue-sea.trycloudflare.com');
});
test('public reachability requires the real app JSON; HTML warnings, redirects and failures are unavailable',async()=>{
 for(const [response,ok] of [[new Response(JSON.stringify({ok:true,name:'phone-brain'})),true],[new Response('<html>warning</html>'),false],[new Response('',{status:502}),false],[new Response('',{status:401}),false],[new Response('',{status:302}),false],[new Response('{"ok":true,"name":"different-server"}'),false]]){
  const result=await probeTunnel('https://example.test',{fetchImpl:async(url,options)=>{assert.equal(options.redirect,'manual');assert.equal(options.headers['x-amadeus-key'],undefined);return response;}});assert.equal(result.ok,ok);
 }
 const failed=await probeTunnel('https://example.test',{fetchImpl:async()=>{throw new Error('secret-bearing network diagnostic');}});assert.equal(failed.ok,false);assert.equal(failed.error,'network');
});
test('paired health check keeps credentials in a header and never follows redirects',async()=>{
 const result=await probeTunnel('https://example.test',{authToken:'test-only',fetchImpl:async(url,options)=>{assert.equal(url.includes('test-only'),false);assert.equal(options.headers['x-amadeus-key'],'test-only');assert.equal(options.redirect,'manual');return new Response('',{status:302,headers:{location:'https://other.test'}});}});
 assert.equal(result.ok,false);assert.equal(JSON.stringify(result).includes('test-only'),false);
});
