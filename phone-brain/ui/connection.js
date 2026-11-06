/* Recover API outages as well as failed documents, without interrupting an active turn. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.HerConnection=api;})(globalThis,function(){
 'use strict';
 function create({now=Date.now,blocked=()=>false,recover=()=>{},cooldownMs=20000}={}){
  let failures=0,lastRecovery=-Infinity,pending=false,authorized=true;
  async function observe(ok,{unauthorized=false}={}){
   if(ok){failures=0;authorized=true;return false;}
   failures++;authorized=!unauthorized;
   if(!authorized||failures<2||pending||blocked()||now()-lastRecovery<cooldownMs)return false;
   pending=true;lastRecovery=now();
   try{await recover();return true;}catch{return false;}finally{pending=false;}
  }
  return {observe,status:()=>({failures,pending,authorized})};
 }
 let monitor,recheck=()=>{};
 function install(options){monitor=create(options);recheck=options.recheck||(()=>{});return monitor;}
 if(typeof window!=='undefined'){
  window.addEventListener('online',()=>recheck());
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)recheck();});
 }
 return {create,install,recheck:()=>recheck(),status:()=>monitor?.status(),observe:(ok,meta)=>monitor?.observe(ok,meta)};
});
