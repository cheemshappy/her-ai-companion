import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {pairingStatus,trustedBrowserOrigin,pairingCookie} from '../request-security.mjs';import {loadRuntimeConfig} from '../runtime-config.mjs';
const token='isolated-pair-value',url=new URL('https://entry.test/');
test('pairing cookies match exact name and full value rather than accepting a prefix or unrelated cookie',()=>{
 for(const cookie of ['other=amk='+token,'xamk='+token,'amk='+token+'extra','amk='+token.slice(1)])assert.equal(pairingStatus({headers:{cookie}},url,token).cookie,false);
 assert.equal(pairingStatus({headers:{cookie:'other=1; amk='+token+'; theme=dark'}},url,token).cookie,true);
 assert.equal(pairingStatus({headers:{'x-amadeus-key':token}},url,token).header,true);assert.equal(pairingStatus({headers:{}},new URL('https://entry.test/?k='+token),token).query,true);
 assert.equal(pairingStatus({headers:{cookie:'amk='}},url,'').cookie,false);
});
test('cross-origin browser requests are rejected; native/no-origin and genuine paired-page requests remain possible',()=>{
 assert.equal(trustedBrowserOrigin({headers:{host:'entry.test',origin:'https://evil.test'}}),false);assert.equal(trustedBrowserOrigin({headers:{host:'entry.test',origin:'null'}}),false);
 assert.equal(trustedBrowserOrigin({headers:{host:'entry.test',origin:'https://entry.test'}}),true);assert.equal(trustedBrowserOrigin({headers:{host:'entry.test'}}),true);
});
test('pairing cookies are HttpOnly and HTTPS cookies are Secure without breaking USB HTTP',()=>{
 assert.match(pairingCookie({headers:{},socket:{remoteAddress:'127.0.0.1'}},token),/HttpOnly$/);
 assert.match(pairingCookie({headers:{'x-forwarded-proto':'https'},socket:{remoteAddress:'127.0.0.1'}},token),/HttpOnly; Secure$/);
 assert.ok(!pairingCookie({headers:{'x-forwarded-proto':'https'},socket:{remoteAddress:'192.0.2.10'}},token).includes('Secure'));
});
test('a fresh installation generates persistent unique pairing; existing pairing and malformed configuration are preserved',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'her-release-config-'));try{
  const file=path.join(dir,'config.json'),a=loadRuntimeConfig(file,{port:8790}),b=loadRuntimeConfig(file,{port:8790});assert.match(a.authToken,/^[a-f0-9]{64}$/);assert.equal(a.authToken,b.authToken);
  fs.writeFileSync(file,'{broken');assert.throws(()=>loadRuntimeConfig(file,{}));assert.equal(fs.readFileSync(file,'utf8'),'{broken');
  const testFile=path.join(dir,'test.json');loadRuntimeConfig(testFile,{}, {testMode:true});assert.equal(fs.existsSync(testFile),false);
 }finally{fs.rmSync(dir,{recursive:true});}
});
