export function cloudflareUrl(text){
  for(const match of String(text).matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/ig)){
    if(new URL(match[0]).hostname!=='api.trycloudflare.com')return match[0];
  }
  return '';
}
export async function probeTunnel(url,{fetchImpl=fetch,now=Date.now,timeoutMs=8000,authToken=''}={}){
  const start=now();
  try{
    const response=await fetchImpl(url.replace(/\/$/,'')+'/api/ping',{redirect:'manual',headers:{'user-agent':'Her-Connection-Check/1.0','cache-control':'no-cache',...(authToken?{'x-amadeus-key':authToken}:{})},signal:AbortSignal.timeout(timeoutMs)});
    if(!response.ok)return {ok:false,checkedAt:now(),ms:now()-start,error:'HTTP '+response.status};
    const data=await response.json();
    return {ok:data?.ok===true&&data?.name==='phone-brain',checkedAt:now(),ms:now()-start,error:data?.ok===true&&data?.name==='phone-brain'?'':'unexpected-response'};
  }catch(error){
    const networkCode=({'ENOTFOUND':'dns','EAI_AGAIN':'dns','ECONNRESET':'connection-reset','ECONNREFUSED':'connection-refused','UND_ERR_CONNECT_TIMEOUT':'timeout'})[error.cause?.code]||'network';
    return {ok:false,checkedAt:now(),ms:now()-start,error:error.name==='TimeoutError'?'timeout':error instanceof SyntaxError?'unexpected-response':networkCode};
  }
}
