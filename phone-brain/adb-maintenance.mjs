/** Short local lease for real remote acceptance; a crashed test cannot disable USB recovery indefinitely. */
import fs from 'node:fs';
export function usbRecoveryPaused(file,{now=Date.now,isAlive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}}}={}){
  try{const lease=JSON.parse(fs.readFileSync(file,'utf8'));const time=now();
    return lease.port===8790&&Number.isInteger(lease.pid)&&lease.pid>0&&Number.isFinite(lease.until)&&lease.until>time&&lease.until<=time+180000&&isAlive(lease.pid);
  }catch{return false;}
}
