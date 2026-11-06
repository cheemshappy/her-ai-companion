/** Repair only the model projection; never claim an interrupted tool succeeded. */
const unresolved=JSON.stringify({ok:false,interrupted:true,resultUnknown:true,error:'上一次操作的结果没有完整回传，不能确认是否执行成功；不要假定已完成或自行重做。'});
export function modelMessages(input,{maxMessages=40,closePending=true}={}){
  const output=[];let pending=new Map();
  const close=()=>{for(const id of pending.keys())output.push({role:'tool',tool_call_id:id,content:unresolved});pending.clear();};
  for(const raw of input||[]){
    if(!raw||!['system','user','assistant','tool'].includes(raw.role))continue;
    if(raw.role==='tool'){
      const id=String(raw.tool_call_id||'');if(!pending.has(id))continue;
      output.push({role:'tool',tool_call_id:id,content:String(raw.content??'')});pending.delete(id);continue;
    }
    close();
    const message={role:raw.role,content:typeof raw.content==='string'?raw.content:raw.content??''};
    if(raw.role==='assistant'&&Array.isArray(raw.tool_calls)){
      const seen=new Set();message.tool_calls=raw.tool_calls.filter(c=>c?.id&&c.function?.name&&!seen.has(c.id)&&(seen.add(c.id),true)).map(c=>({id:String(c.id),type:'function',function:{name:String(c.function.name),arguments:typeof c.function.arguments==='string'?c.function.arguments:JSON.stringify(c.function.arguments||{})}}));
      if(!message.tool_calls.length)delete message.tool_calls;
      else pending=new Map(message.tool_calls.map(c=>[c.id,c]));
    }
    output.push(message);
  }
  if(closePending)close();
  if(output.length<=maxMessages)return output;
  const start=Math.max(0,output.length-maxMessages);let index=start;
  while(index<output.length&&output[index].role!=='user')index++;
  // One long turn is kept whole rather than splitting a tool exchange.
  if(index===output.length){index=start;while(index>0&&output[index].role!=='user')index--;}
  return output.slice(index);
}
export function pendingToolCalls(messages){
  let expected=[];
  for(const message of messages||[]){
    if(message.role==='assistant')expected=Array.isArray(message.tool_calls)?message.tool_calls.slice():[];
    else if(message.role==='tool')expected=expected.filter(c=>c.id!==message.tool_call_id);
    else if(message.role==='user')expected=[];
  }
  return expected;
}
export function settleInterruptedTools(session){
  const pending=pendingToolCalls(session.messages);
  for(const call of pending)session.messages.push({role:'tool',tool_call_id:call.id,content:unresolved,interrupted:true});
  delete session.toolBatchId;
  return pending.length;
}
export function acceptToolResults(session,results,batchId){
  const pending=pendingToolCalls(session.messages),expected=new Map(pending.map(c=>[c.id,c]));
  if(!pending.length||batchId&&batchId!==session.toolBatchId)return {ok:false,stale:true,error:'上一步的操作已结束或已被新的对话接替，旧结果未再次执行。'};
  const seen=new Set(),accepted=[];
  for(const result of results||[]){const id=String(result?.id||'');if(!expected.has(id)||seen.has(id))continue;seen.add(id);accepted.push({role:'tool',tool_call_id:id,content:String(result.content??'').slice(0,24000)});}
  session.messages.push(...accepted);
  const missing=pendingToolCalls(session.messages);
  return {ok:true,complete:!missing.length,missing:missing.map(c=>c.id),accepted:accepted.map(m=>m.tool_call_id),calls:pending};
}
export function createSessionLocks(){
  const active=new Map();
  return async id=>{
    const previous=active.get(id)||Promise.resolve();let release;
    const current=new Promise(resolve=>{release=resolve;});active.set(id,current);
    await previous;
    return ()=>{release();if(active.get(id)===current)active.delete(id);};
  };
}
