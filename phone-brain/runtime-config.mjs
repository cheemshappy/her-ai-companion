import fs from 'node:fs';import crypto from 'node:crypto';
export function loadRuntimeConfig(file,defaults,{testMode=false}={}){
 let raw,missing=false;try{raw=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('应用配置无法读取，请先修复配置文件；原文件已保留。');raw={};missing=true;}
 const result={...defaults,...raw};
 if(!testMode&&(typeof result.authToken!=='string'||!result.authToken.trim())){
  result.authToken=crypto.randomBytes(32).toString('hex');raw.authToken=result.authToken;missing=true;
 }
 if(missing&&!testMode){const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify({...defaults,...raw},null,2)+'\n',{mode:0o600});fs.renameSync(tmp,file);}
 return result;
}
