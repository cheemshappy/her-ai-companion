/* Startup metadata travels in the paired document; connection health remains a separate request. */
(function(root){
 'use strict';
 const timings={documentAt:performance.now()};
 function mark(stage){if(timings[stage]===undefined)timings[stage]=Math.round(performance.now());}
 async function modelInfo({refresh=false}={}){
  if(!refresh)try{
   const info=JSON.parse(document.getElementById('herBootModel')?.textContent||'null');
   if(info&&typeof info.mode==='string'){mark('embeddedModelAt');return info;}
  }catch{}
  try{const response=await fetch('/api/model',{cache:'no-store',signal:AbortSignal.timeout(8000)});if(response.ok)return await response.json();}catch{}
  return {};
 }
 root.HerStartup={modelInfo,mark,timings};
})(globalThis);
