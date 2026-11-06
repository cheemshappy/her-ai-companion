import fs from 'node:fs';
import path from 'node:path';

/** Read the already logged-in owner's local gateway cache. Never opens robot state or sends actions. */
export async function startQqRecovery({source,ownerQQ,database,cursorFile,interval=30000}){
  const {DatabaseSync}=await import('node:sqlite');
  let cursor={timestamp:Math.floor((Date.now()-7*86400000)/1000),hash:-2147483649},busy=false,stopped=false;
  try{const saved=JSON.parse(fs.readFileSync(cursorFile,'utf8'));if(saved.ownerQQ===ownerQQ&&Number.isFinite(saved.cursor?.timestamp)&&Number.isFinite(saved.cursor?.hash))cursor=saved.cursor;}catch{}
  async function tick(){
    if(stopped||busy)return;busy=true;let db;
    try{
      if(!fs.existsSync(database)){source.setRecovery({available:false,error:'主号网关缓存尚未建立'});return;}
      db=new DatabaseSync(database,{readOnly:true,timeout:1500});
      const columns=db.prepare('PRAGMA table_info(messages)').all().map(x=>x.name);
      if(!['message_hash','timestamp','data'].every(x=>columns.includes(x)))throw new Error('schema');
      const query=db.prepare('SELECT message_hash,timestamp,data FROM messages WHERE timestamp > ? OR (timestamp = ? AND message_hash > ?) ORDER BY timestamp,message_hash LIMIT 500');
      let count=0,more=false;
      for(let round=0;round<4;round++){
        const rows=query.all(cursor.timestamp,cursor.timestamp,cursor.hash);more=rows.length===500;
        for(const row of rows){let event;try{event=JSON.parse(row.data||'{}');}catch{}
          if(event)count+=source.restore([event]);cursor={timestamp:Number(row.timestamp),hash:Number(row.message_hash)};
        }
        if(!more)break;
        await new Promise(resolve=>setImmediate(resolve));
      }
      fs.mkdirSync(path.dirname(cursorFile),{recursive:true});
      const temp=cursorFile+'.tmp';fs.writeFileSync(temp,JSON.stringify({ownerQQ,cursor}));fs.renameSync(temp,cursorFile);
      source.setRecovery({available:true,lastAt:Date.now(),lastRecovered:count,catchingUp:more,error:''});
    }catch{source.setRecovery({available:false,error:'本地补读暂不可用，实时接收继续工作'});}
    finally{try{db?.close();}catch{}busy=false;}
  }
  void tick();const timer=setInterval(()=>void tick(),interval);timer.unref();
  return ()=>{stopped=true;clearInterval(timer);};
}
