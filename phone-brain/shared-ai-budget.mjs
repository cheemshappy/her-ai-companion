// 所有正式 DeepSeek 文本请求共用 QQ 预算服务；模拟测试和其它提供方保持独立。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function createSharedAiFetch({ bridgeRoot, enabled = () => true, fetchImpl = fetch, usageFile } = {}) {
  async function rpc(action, data, timeoutMs=15000) {
    const token = fs.readFileSync(path.join(bridgeRoot, 'state/console-token'), 'utf8').trim();
    const r = await fetchImpl('http://127.0.0.1:3100/api/internal/ai-budget/' + action, {
      method: 'POST', headers: { 'x-console-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(data), signal: AbortSignal.timeout(timeoutMs),
    });
    const result = await r.json();
    if (!r.ok || result.allowed === false) {
      const error = new Error(result.message || '共享 AI 预算暂不可用，你的话已保存，请稍后再试。');
      error.code = 'AI_DAILY_BUDGET'; throw error;
    }
    return result;
  }
  return async function modelFetch(url, init, { source = 'phone-chat', interactive = true } = {}) {
    if (!enabled() || new URL(url).hostname !== 'api.deepseek.com') return fetchImpl(url, init);
    const request = JSON.parse(init.body), requestId = crypto.randomUUID();
    let priority=false,budgetFallback=false;
    if(interactive&&['phone-chat','phone-interaction','phone-character'].includes(source)){
      try{priority=JSON.parse(fs.readFileSync(path.join(bridgeRoot,'config.json'),'utf8')).socialV2?.dailyBudget?.ownerServicePriority===true;}catch{}
    }
    const rpcTimeout=priority?1500:15000;
    try{await rpc('reserve', { source, requestId, interactive },rpcTimeout);}
    catch(error){if(!priority)throw error;budgetFallback=true;}
    const startedAt=Date.now();let actualModel=request.model,usage;
    const record=outcome=>{
      if(!usageFile)return;
      const counts={};for(const name of ['prompt_tokens','completion_tokens','prompt_cache_hit_tokens','prompt_cache_miss_tokens','total_tokens']){
        if(Number.isFinite(Number(usage?.[name])))counts[name]=Math.max(0,Number(usage[name]));
      }
      try { fs.mkdirSync(path.dirname(usageFile),{recursive:true});fs.appendFileSync(usageFile,JSON.stringify({
        requestId,startedAt,endedAt:Date.now(),source:String(source).slice(0,80),interactive,
        requestModel:String(request.model||'unknown').slice(0,80),model:String(actualModel||'unknown').slice(0,80),usage:counts,outcome,budgetFallback,
      })+'\n'); } catch {}
    };
    let response;
    try { response = await fetchImpl(url, init); }
    catch (error) { record('network-error');void rpc('settle', { source, requestId, model: actualModel, outcome: 'network-error' },rpcTimeout).catch(() => {}); throw error; }
    let buffer = '', settled = false;
    async function finish(outcome) {
      if (settled) return; settled = true;
      record(outcome);
      const settlement=rpc('settle', { source, requestId, model: actualModel, usage, outcome },rpcTimeout).catch(()=>{});
      if(!priority)await settlement;
    }
    const stream = response.headers.get('content-type')?.includes('text/event-stream');
    function parse(text, final = false) {
      buffer += text;
      if (stream) {
        const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
        if (final && buffer) { lines.push(buffer); buffer = ''; }
        for (const line of lines) {
          if (!line.trim().startsWith('data:')) continue;
          try { const value = JSON.parse(line.trim().slice(5)); if (value.usage) usage = value.usage; if(value.model)actualModel=value.model; } catch {}
        }
      } else if (final) { try { const value=JSON.parse(buffer);usage=value.usage;if(value.model)actualModel=value.model; } catch {} buffer = ''; }
      if (buffer.length > 2 * 1024 * 1024) buffer = '';
    }
    if (!response.body) { await finish('empty'); return response; }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const item = await reader.read();
          if (item.done) { parse(decoder.decode(), true); await finish(response.ok ? 'completed' : 'http-error'); controller.close(); return; }
          parse(decoder.decode(item.value, { stream: true })); controller.enqueue(item.value);
        } catch (error) { await finish('stream-error'); controller.error(error); }
      },
      async cancel(reason) { await reader.cancel(reason); await finish('cancelled'); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
