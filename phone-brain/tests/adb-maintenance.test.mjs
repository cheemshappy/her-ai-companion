import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {usbRecoveryPaused} from '../adb-maintenance.mjs';
test('USB testing pause requires a live test process, correct port and a short unexpired lease',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'her-usb-lease-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'lease.json'),time=100000;
 const check=(lease,alive=true)=>{fs.writeFileSync(file,JSON.stringify(lease));return usbRecoveryPaused(file,{now:()=>time,isAlive:()=>alive});};
 const valid={pid:1234,port:8790,until:time+90000};assert.equal(check(valid),true);assert.equal(check(valid,false),false);
 assert.equal(check({...valid,until:time}),false);assert.equal(check({...valid,until:time+180001}),false);assert.equal(check({...valid,port:8787}),false);assert.equal(check({...valid,pid:-1}),false);
 fs.writeFileSync(file,'broken');assert.equal(usbRecoveryPaused(file),false);fs.unlinkSync(file);assert.equal(usbRecoveryPaused(file),false);
});
