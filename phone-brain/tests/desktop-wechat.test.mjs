import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createDesktopWechat,combineMessageSources} from '../desktop-wechat.mjs';
import {actionability} from '../message-relevance.mjs';
const now=1793430000000;
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'her-wechat-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
const message=(n,extra={})=>({key:'wechat:'+n,source:'desktop-wechat',accountId:'wxid_owner',ownerId:'wxid_owner',kind:'private',conversationId:'wechat:friend',senderId:'friend',sender:'同学',who:'微信 · 同学',text:'测试正文'+n,at:now-1000+n,...extra});
function write(dir,data){fs.writeFileSync(path.join(dir,'desktop-wechat-inbox.json'),JSON.stringify({ownerId:'wxid_owner',verifiedDatabases:3,...data}));}

test('verified WeChat feed is account isolated, paired paging retains full text and restart does not duplicate',t=>{
 const dir=setup(t);write(dir,{items:[message(1,{text:'文'.repeat(9000)}),message(2),message(3,{accountId:'other'}),message(4,{at:now-8*86400000})]});
 const source=createDesktopWechat({stateDir:dir,now:()=>now});assert.equal(source.all().length,2);
 const a=source.snapshot({limit:1});assert.equal(a.items[0].key,'wechat:2');assert.equal(a.hasMore,true);
 const b=source.snapshot({limit:1,before:a.nextCursor});assert.equal(b.items[0].text.length,9000);assert.equal(b.hasMore,false);
 assert.equal(createDesktopWechat({stateDir:dir,now:()=>now}).all().length,2);
});
test('disabled reader never spawns; capture failure keeps last good feed and exposes unavailable health',async t=>{
 const dir=setup(t);write(dir,{items:[message(1)]});let calls=0;
 let source=createDesktopWechat({stateDir:dir,now:()=>now,run:async()=>calls++});await source.refresh();assert.equal(calls,0);assert.equal(source.status().available,false);
 fs.writeFileSync(path.join(dir,'wechat-runtime.json'),JSON.stringify({enabled:true,python:'local-python'}));
 source=createDesktopWechat({stateDir:dir,helper:'fixed-helper',now:()=>now,run:async(file,args,opts)=>{calls++;assert.deepEqual(args,['-I','-S','fixed-helper','capture']);assert.equal(opts.windowsHide,true);throw new Error('private process diagnostic');}});
 await source.refresh();assert.equal(calls,1);assert.equal(source.status().error,'READER_UNAVAILABLE');assert.equal(source.all().length,1);assert.equal(source.status().opensApps,false);
});
test('source combination keeps QQ and WeChat conversations distinct and outgoing replies never become new tasks',t=>{
 const dir=setup(t);write(dir,{items:[message(1),message(2,{direction:'outgoing',senderId:'wxid_owner'})]});
 const wx=createDesktopWechat({stateDir:dir,now:()=>now});const qq={all:()=>[{key:'qq1',kind:'private',conversationId:'friend',at:now-100}],status:()=>({connected:true,count:1})};
 const both=combineMessageSources(qq,wx);assert.equal(both.all().length,3);assert.equal(both.snapshot({conversation:'private:wechat:friend'}).total,2);assert.equal(both.status().wechat.readOnly,true);
 assert.equal(actionability({kind:'task',recipient:'owner'},[message(2,{direction:'outgoing'})],'10001').required,false);
 const group=message(3,{kind:'group',mentions:['wxid_owner']});assert.equal(actionability({kind:'reply'},[group],'10001').required,true);
 group.mentions=['wxid_other'];assert.equal(actionability({kind:'reply',recipient:'owner',recipientEvidence:'测试'},[group],'10001').required,false);
});
