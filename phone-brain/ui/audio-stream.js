/* Download independently of attachment to <audio>; a queued sentence can finish safely. */
(function(){
 'use strict';
 function open(url,{complete=false}={}){
  const abort=new AbortController(),supported=!complete&&typeof MediaSource!=='undefined'&&MediaSource.isTypeSupported('audio/mpeg');
  let media=supported?new MediaSource():null,objectUrl=media?URL.createObjectURL(media):'',reader=null,closed=false,finished=false,failure=null,total=0;
  let readyResolve,doneResolve,openResolve,wake;const chunks=[];
  const ready=new Promise(resolve=>{readyResolve=resolve;}),completed=new Promise(resolve=>{doneResolve=resolve;}),opened=new Promise(resolve=>{openResolve=resolve;});
  const timer=setTimeout(()=>{failure=new Error('audio timeout');abort.abort();wake?.();},120000);
  const signal=()=>{wake?.();wake=null;};
  const api={get url(){return objectUrl;},ready,completed,get complete(){return finished&&!failure;},get failed(){return !!failure;},streaming:!!media,
   dispose(){if(closed)return;closed=true;clearTimeout(timer);abort.abort();void reader?.cancel().catch(()=>{});readyResolve(false);doneResolve(false);openResolve(false);signal();if(objectUrl)URL.revokeObjectURL(objectUrl);}};
  if(media){
   media.addEventListener('sourceopen',()=>openResolve(true),{once:true});
   media.addEventListener('sourceclose',()=>{openResolve(false);if(!finished&&!closed){failure=new Error('audio detached');abort.abort();signal();}});
   void (async()=>{try{
    if(!await opened||closed)return;const buffer=media.addSourceBuffer('audio/mpeg');buffer.mode='sequence';let index=0;
    while(!closed){
     if(failure)throw failure;
     if(index>=chunks.length){if(finished)break;await new Promise(resolve=>{wake=resolve;});continue;}
     const value=chunks[index++];await new Promise((resolve,reject)=>{
      const cleanup=()=>{buffer.removeEventListener('updateend',end);buffer.removeEventListener('error',error);abort.signal.removeEventListener('abort',error);};
      const end=()=>{cleanup();resolve();},error=()=>{cleanup();reject(new Error('audio decode'));};
      buffer.addEventListener('updateend',end);buffer.addEventListener('error',error);abort.signal.addEventListener('abort',error,{once:true});
      if(abort.signal.aborted){error();return;}try{buffer.appendBuffer(value);}catch{error();}
     });
    }
    if(!closed&&media.readyState==='open')media.endOfStream();
   }catch{failure=new Error('audio interrupted');if(!closed&&media.readyState==='open')try{media.endOfStream('network');}catch{}}})();
  }
  void (async()=>{try{
   const response=await fetch(url,{signal:abort.signal,cache:'no-store'});
   if(!response.ok||!response.body||!/^audio\//i.test(response.headers.get('content-type')||''))throw new Error('audio unavailable');
   reader=response.body.getReader();
   while(!closed){const {value,done}=await reader.read();if(done)break;total+=value.length;if(total>8*1024*1024)throw new Error('audio too large');chunks.push(value);signal();if(media&&total>=1024)readyResolve(true);}
   if(closed)return;if(!total)throw new Error('empty audio');finished=true;
   if(!media)objectUrl=URL.createObjectURL(new Blob(chunks,{type:'audio/mpeg'}));readyResolve(true);doneResolve(true);signal();
  }catch{failure=new Error('audio download failed');readyResolve(false);doneResolve(false);signal();}
  finally{clearTimeout(timer);void reader?.cancel().catch(()=>{});}})();
  return api;
 }
 window.HerAudio={open};
})();
