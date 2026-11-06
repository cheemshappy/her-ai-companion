/* A failed sentence stays at the front; never silently advance over missing speech. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.HerSpeech=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 function create({open,play,onState=()=>{},split=text=>[text]}){
  let rows=[],generation=0,runner=null,paused=false;const waiters=[];
  const emit=(status)=>{onState({status,pending:rows.length});};
  const settle=status=>{for(const resolve of waiters.splice(0))resolve({status,pending:rows.length});};
  const prepare=row=>{if(!row.stream)row.stream=open(row.text,{complete:row.attempt>0||row.position>0});return row.stream;};
  function kick(){if(runner||paused||!rows.length)return;const current={generation,abort:new AbortController()};runner=current;void drain(current);}
  async function drain(current){
   try{while(rows.length&&current.generation===generation&&!paused){
    const row=rows[0];let result={ok:false,position:row.position};emit('loading');
    try{const stream=prepare(row),ready=await stream.ready;if(current.generation!==generation)return;
     if(ready){if(rows[1])prepare(rows[1]);emit('playing');const value=await play(stream,{offset:row.position,signal:current.abort.signal});result=typeof value==='boolean'?{ok:value,position:0}:value||result;}
    }catch{/* A network/decode failure is retried, with the same text and position. */}
    finally{row.stream?.dispose();row.stream=null;}
    if(current.generation!==generation)return;
    if(result.ok){rows.shift();continue;}
    row.position=Math.max(row.position||0,Number(result.position)||0);row.attempt++;
    if(row.attempt<2)continue;
    paused=true;emit('paused');settle('paused');
   }}finally{if(runner===current){runner=null;if(!rows.length){emit('idle');settle('idle');}else if(!paused)kick();}}
  }
  return {enqueue(text){for(const piece of split(String(text||'')))if(piece.trim())rows.push({text:piece,attempt:0,position:0,stream:null});kick();return this.idle();},
   idle(){if(paused)return Promise.resolve({status:'paused',pending:rows.length});if(!rows.length&&!runner)return Promise.resolve({status:'idle',pending:0});return new Promise(resolve=>waiters.push(resolve));},
   cancel(){generation++;runner?.abort.abort();runner=null;for(const row of rows)row.stream?.dispose();rows=[];paused=false;settle('cancelled');emit('cancelled');},
   resume(){if(rows[0])rows[0].attempt=0;paused=false;kick();return this.idle();},
   get status(){return paused?'paused':rows.length?'active':'idle';},get pending(){return rows.length;}};
 }
 function notice(retry){
  const button=document.createElement('button');button.id='speechRetry';button.className='speech-retry';button.textContent='朗读暂停了，点这里接着听';button.hidden=true;button.setAttribute('aria-live','polite');button.onclick=()=>{button.hidden=true;retry();};document.body.appendChild(button);
  return ({status})=>{button.hidden=status!=='paused';};
 }
 return {create,notice};
});
