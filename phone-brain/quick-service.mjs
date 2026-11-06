/** Loopback-only adapter for cloudflared's official quick-service endpoint.
 * Provisioning stays on Cloudflare; ephemeral credentials are never logged/saved.
 */
import http from 'node:http';import crypto from 'node:crypto';
export async function createQuickService({fetchImpl=fetch,onProvisioned=()=>{}}={}){
  const route='/'+crypto.randomBytes(24).toString('hex'),pending=new Set();
  const server=http.createServer(async(req,res)=>{
    if(req.method!=='POST'||req.url!==route+'/tunnel'||!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)){res.writeHead(404);res.end();return;}
    const controller=new AbortController();pending.add(controller);
    try{
      let body='';for await(const part of req){body+=part;if(Buffer.byteLength(body)>4096){res.writeHead(413);res.end();return;}}
      let response;
      for(let attempt=0;attempt<2;attempt++){
        try{response=await fetchImpl('https://api.trycloudflare.com/tunnel',{method:'POST',headers:{'content-type':'application/json','user-agent':'cloudflared/2026.10.3'},body:body||'{}',redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(12000)])});break;}
        catch{if(attempt===1)throw new Error('provisioning-unavailable');}
      }
      const text=await response.text();if(Buffer.byteLength(text)>65536)throw new Error('provisioning-response-too-large');
      if(response.ok){
        try{const data=JSON.parse(text);if(data?.success&&typeof data?.result?.hostname==='string')onProvisioned({hostname:data.result.hostname});}catch{}
      }
      res.writeHead(response.status,{'content-type':'application/json','cache-control':'no-store'});res.end(text);
    }catch{res.writeHead(502,{'content-type':'application/json'});res.end('{"success":false,"errors":[{"code":502,"message":"provisioning unavailable"}]}');}
    finally{pending.delete(controller);}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {url:'http://127.0.0.1:'+server.address().port+route,close(){for(const c of pending)c.abort();server.close();server.closeAllConnections();}};
}
