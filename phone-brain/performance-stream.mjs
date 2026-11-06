import C from './ui/character-state.js';
export function leadingText(value){
  const match=/"text"\s*:\s*("(?:\\.|[^"\\])*")/.exec(value);
  if(!match)return null;
  try{return JSON.parse(match[1]);}catch{return null;}
}
export async function readPerformance(response,onText){
  if(!response.headers.get('content-type')?.includes('text/event-stream')){
    const data=await response.json(),value=data.choices?.[0]?.message?.content||'';
    const parsed=JSON.parse(value.replace(/^```(?:json)?\s*|\s*```$/g,''));onText?.(parsed.text);return {value:parsed,usage:data.usage};
  }
  let text='',buffer='',announced=false,usage=null;
  const decoder=new TextDecoder(),reader=response.body.getReader();
  const line=value=>{
    if(!value.startsWith('data:'))return;
    const raw=value.slice(5).trim();if(!raw||raw==='[DONE]')return;
    let data;try{data=JSON.parse(raw);}catch{return;}
    if(data.usage)usage=data.usage;
    text+=data.choices?.[0]?.delta?.content||'';
    const sentence=announced?null:leadingText(text);
    if(typeof sentence==='string'&&sentence.trim()){announced=true;onText?.(sentence);}
  };
  while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const lines=buffer.split('\n');buffer=lines.pop();for(const item of lines)line(item.trim());}
  buffer+=decoder.decode();if(buffer.trim())line(buffer.trim());
  try{return {value:JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g,'')),usage};}
  catch(error){const spoken=leadingText(text);if(spoken?.trim())return {value:{...C.guess(spoken),text:spoken,gesture:'listen',duration:1.6},usage};throw error;}
}
