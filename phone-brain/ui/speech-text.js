/* Lossless, bounded speech chunks shared by streamed replies and both players. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.HerSpeechText=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 function take(text,{final=false,first=false,max=100}={}){
  const chars=Array.from(String(text||''));if(!chars.length)return null;
  let end=0,soft=0;
  for(let i=0;i<Math.min(chars.length,max);i++){
   if(/[。！？!?；;\n]/.test(chars[i])&&i>=7){end=i+1;break;}
   if(/[，,：:\s]/.test(chars[i])&&i>=15)soft=i+1;
   if(first&&i>=25&&soft){end=soft;break;}
  }
  if(!end&&chars.length>=max)end=soft||max;
  if(!end&&final)end=chars.length;
  if(!end)return null;
  while(end<chars.length&&end<max&&/[”’」』）》】]/.test(chars[end]))end++;
  return {piece:chars.slice(0,end).join(''),rest:chars.slice(end).join('')};
 }
 function split(text,options={}){let remaining=String(text||''),rows=[];while(remaining){const next=take(remaining,{...options,final:true});rows.push(next.piece);remaining=next.rest;}return rows;}
 async function readLines(response,consume){
  const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
  const drain=()=>{let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);if(line.trim())consume(line);}};
  try{while(true){const {value,done}=await reader.read();if(done)break;pending+=decoder.decode(value,{stream:true});drain();}pending+=decoder.decode();drain();if(pending.trim())consume(pending);}finally{reader.releaseLock();}
 }
 return {take,split,readLines};
});
