import fs from 'node:fs';import crypto from 'node:crypto';import {spawn} from 'node:child_process';import {once} from 'node:events';
export function speechIdentity(config,reference={}){
 const refs=[reference.refAudioPath,...(reference.auxRefAudioPaths||[]),config.voice?.originalChinese?.refAudioPath,...(config.voice?.originalChinese?.auxRefAudioPaths||[])].filter(Boolean).map(file=>{try{const st=fs.statSync(file);return [file,st.size,st.mtimeMs];}catch{return [file,'missing'];}});
 return crypto.createHash('sha256').update(JSON.stringify(['speech-cut0-20261031',config.voice?.engine||'fast',config.voice?.revision,config.voice?.engine==='original'?refs:config.fastTts?.voiceUri,config.voice?.engine==='original'?reference.promptText:config.fastTts?.model,config.voice?.originalChinese,config.voice?.engine==='original'?1:config.fastTts?.speed])).digest('hex').slice(0,16);
}
export function originalSpeechRequest(text,reference){
 const chinese=/[\u3400-\u9fff]/.test(text)&&!/[\u3040-\u30ff]/.test(text);
 return {text,text_lang:chinese?(reference.promptLang==='zh'?'all_zh':'zh'):/[\u3040-\u30ff]/.test(text)?'ja':'en',ref_audio_path:reference.refAudioPath,aux_ref_audio_paths:reference.auxRefAudioPaths||[],prompt_text:reference.promptText,prompt_lang:reference.promptLang||'ja',text_split_method:'cut0',media_type:'wav',streaming_mode:1,batch_size:1,parallel_infer:true,use_cuda_graph:true,speed_factor:1,seed:42};
}
let queue=Promise.resolve();
async function voiceSlot(signal){const previous=queue;let release;queue=new Promise(resolve=>{release=resolve;});await previous;if(signal?.aborted){release();signal.throwIfAborted();}return release;}
/** Local original GPT-SoVITS voice -> MP3 bytes; no pitch conversion or other voice fallback. */
export async function originalVoiceResponse({text,reference,ffmpeg,signal,fetchImpl=fetch}){
 if(!reference.refAudioPath||!fs.existsSync(reference.refAudioPath)||!reference.promptText||!ffmpeg||!fs.existsSync(ffmpeg))throw new Error('Original voice is not ready');
 const release=await voiceSlot(signal);let response;
 try{response=await fetchImpl(String(reference.baseUrl||'http://127.0.0.1:9880').replace(/\/$/,'')+'/tts',{
  method:'POST',headers:{'content-type':'application/json'},signal,body:JSON.stringify(originalSpeechRequest(text,reference))});
 if(!response.ok||!response.body||!/^(audio\/|application\/octet-stream)/i.test(response.headers.get('content-type')||''))throw new Error('Original voice synthesis is unavailable');
 }catch(error){release();throw error;}
 const child=spawn(ffmpeg,['-hide_banner','-loglevel','error','-probesize','32','-analyzeduration','0','-ignore_length','1','-f','wav','-i','pipe:0','-vn','-ac','1','-ar','32000','-c:a','libmp3lame','-b:a','96k','-write_xing','0','-flush_packets','1','-f','mp3','pipe:1'],{windowsHide:true,stdio:['pipe','pipe','ignore']});
 child.stdin.on('error',()=>{});const reader=response.body.getReader();
 const abort=()=>{void reader.cancel().catch(()=>{});child.stdin.destroy();child.kill();};signal?.addEventListener('abort',abort,{once:true});
 const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code));});exited.catch(()=>{});
 const pump=(async()=>{let total=0;while(true){const {value,done}=await reader.read();if(done)break;signal?.throwIfAborted();total+=value.length;if(total>24*1024*1024)throw new Error('Original audio too large');if(!child.stdin.write(value))await once(child.stdin,'drain',{signal});}child.stdin.end();})();pump.catch(()=>{abort();});
 const body=new ReadableStream({async start(controller){try{for await(const chunk of child.stdout){signal?.throwIfAborted();controller.enqueue(new Uint8Array(chunk));}await pump;if(await exited!==0)throw new Error('Original voice conversion failed');controller.close();}catch{controller.error(new Error('Original voice synthesis interrupted'));}finally{signal?.removeEventListener('abort',abort);abort();release();}},cancel(){abort();}});
 return new Response(body,{headers:{'content-type':'audio/mpeg'}});
}
