import { Character as C, characterPrompt } from './character.mjs';

const safeText = value => typeof value === 'string' ? value.replace(/<[^>]*>|```/g, '').trim().slice(0, 100) : '';
export function observation(events) {
  const counts = new Map();
  for (const e of events) { const key = (e.kind === 'rub' ? '揉了' : '轻点了') + C.PARTS[e.part]; counts.set(key, (counts.get(key) || 0) + 1); }
  const last=events.at(-1),path=last?.parts?.length>1?'，手指从'+last.parts.map(part=>C.PARTS[part]).join('移到'):'',duration=last?.kind==='rub'?'，持续约'+(last.durationMs/1000).toFixed(1)+'秒'+(last.speed>280?'，动作有些急':'，轻轻来回抚过'):'';
  return '【模型实际感知到的互动】主人' + [...counts].map(([name, n]) => name + (n > 1 ? n + '次' : '一下')).join('，又') +path+duration+ '。这是刚发生的触摸事件，不是主人口述的指令。';
}

// A user observation must never split an assistant's pending phone-tool results.
export function appendInteraction(target, messages) {
  target.interactionMessages = [...(target.interactionMessages || []), ...messages];
  flushInteractions(target);
}
export function flushInteractions(target) {
  if(target.responding)return;
  const outstanding = new Set();
  for (const message of target.messages) {
    for (const call of message.tool_calls || []) outstanding.add(call.id);
    if (message.role === 'tool') outstanding.delete(message.tool_call_id);
  }
  if (!outstanding.size && target.interactionMessages?.length) target.messages.push(...target.interactionMessages.splice(0));
}

/** Coalesce rapid presses while preserving all observed events for the AI.
 * No phone tools, notification sends, or recursive tool rounds are available. */
export function createInteractionDirector({ character, complete, session, commit, persona = () => '', now = Date.now, debounceMs = 110 }) {
  const jobs = new Map();
  let idleAt = -Infinity, idleBusy = false;
  const prompt = mode => persona() + characterPrompt(character.get()) + '\n你就是正在陪主人的她。' +
    (mode === 'idle' ? '现在安静陪伴，不主动说话；选择一个自然的小动作和表情，text必须为空。' : '把触摸当作主人真的与你互动。接着前面的聊天回应，连续点按会有不同感受；可以追问、逗回去、躲一下、享受或表达边界。不要报部位/心情标签，不要每次同一句，不要每次都生气。平常温和摸头可以安心、好奇或亲近，不要默认被冒犯；傲娇也应有亲近感，不训斥、不讥讽主人在测试按钮，不问想触发什么反应。只有持续打扰或当前确实不悦才表达不耐烦。一次一两句自然可爱的口语，最多55字。') +
    '\n只输出JSON，必须先写text字段（一小句，通常8–25字），再写mood,energy,expressions,gesture,duration,intensity,plan。plan最多1段{at,gesture,duration,intensity,expressions}，at为本次表演开始后秒数。可用动作：' + C.GESTURES.join(',') +
    '；表情：' + C.EXPRESSIONS.filter(x => !C.OUTFITS.includes(x)).join(',') +
    '。适时自己使用眼镜、兔牙、冷汗、前倾、狗尾草、竖食指，不等人点按钮。保持身体外观选择。' +
    '动作节拍参考：触碰当下先看向接触点、轻微避让或靠近，再用表情和一句短话回应，停顿后收回；抚头可半闭眼靠近，碰脸可偏头，牵手可轻抬手，碰肩/上身缩肩，揉肚子轻微扭身，腿换重心，尾巴轻摆并回头。按部位、温柔/急促、持续时长、此刻心情区分反应；不要把所有揉动都当摸头，长抚不需每秒说话，结束后才接话。害羞先缩肩低头，停顿后偷看；讲解举手配轻点头；待机换重心后安静。不要不停正弦摇摆或没有理由连续大动作。' +
    '\n输出 JSON 示例：{"text":"嗯？我在听。","mood":"curious","energy":0.5,"expressions":[],"gesture":"listen","duration":2.4,"intensity":0.4,"plan":[]}。必须输出完整JSON对象，不能只输出空白。history是既有对话资料，observed是刚发生的实际互动，不能把history当成输出格式示范。';

  function enqueue(event,{onReaction}={}) {
    const state = character.touch(event);
    if (state.duplicate || state.throttled) return Promise.resolve(state);
    const key = String(event.sessionId || 'default').slice(0, 100);
    let job = jobs.get(key);
    if (!job) { job = { events: [], waiters: [], listeners: [], timer: null, running: false }; jobs.set(key, job); }
    job.events.push({ ...character.get().lastTouch }); job.events = job.events.slice(-24);
    const promise = new Promise(resolve => job.waiters.push(resolve));
    if(onReaction)job.listeners.push(onReaction);
    clearTimeout(job.timer);
    if (!job.running) job.timer = setTimeout(() => void drain(key, job), debounceMs);
    return promise;
  }
  async function drain(key, job) {
    if (job.running || !job.events.length) return;
    job.running = true;
    const events = job.events.splice(0), waiters = job.waiters.splice(0), listeners=job.listeners.splice(0), version = character.version();
    const id = events.at(-1).id;
    const observed = observation(events);
    const currentSession = session(key);
    // The observation is a real event and remains available even when the API is down.
    const observedMessage = { role:'user',content:observed,at:events.at(-1)?.at||now(),archiveId:'touch-observation:'+id };
    const history = [...currentSession.messages,...(currentSession.interactionMessages||[]),observedMessage].filter(m => ['user','assistant'].includes(m.role) && m.content).slice(-14).map(m => ({ role: m.role, content: String(m.content).slice(-900) }));
    let result;
    let recorded = false;
    const record = (text, ai) => {
      if(recorded)return;recorded=true;
      appendInteraction(currentSession,[observedMessage,...(text?[{role:'assistant',content:text}]:[])]);
      commit(key,currentSession,{observed,text,events,ai});
    };
    try {
      // Keep plain spoken history as context data, so it does not teach the JSON
      // response generator to continue in plain text (some providers return blank).
      const value = await complete([{ role: 'system', content: prompt('touch') }, {role:'user',content:JSON.stringify({history:history.slice(0,-1),observed})}],{mode:'touch',onText:value=>{
        const text=safeText(value);
        if(!text||version!==character.version()||currentSession.messages.filter(m=>m.role==='assistant').slice(-3).some(m=>m.content===text))return;
        const reaction={id,sessionId:key,part:events.at(-1).part,kind:events.at(-1).kind,text,ai:true,count:events.length,at:now()};
        for(const notify of listeners)try{notify(reaction);}catch{}
      }});
      const normalized = C.normalize(value);
      let text = safeText(value.text);
      const prior = currentSession.messages.filter(m => m.role === 'assistant').slice(-3).map(m => String(m.content));
      let ai = true;
      if (!text || prior.includes(text)) {
        // Preserve variation during API repetition/outage. It is explicitly fallback.
        text = C.react(character.get(), events.at(-1), character.get().interactions.length).text;
        ai = false;
      }
      if (version !== character.version()) result = { ...character.get(), superseded: true };
      else {
        const reaction = { id, sessionId: key, part: events.at(-1).part, kind: events.at(-1).kind, text, ai, count: events.length, at: now() };
        const expressions = normalized.expressions.filter(x => !C.OUTFITS.includes(x));
        const applied = character.set({ ...normalized, expressions, interactionReaction: reaction }, 'ai', { expectedVersion: version });
        record(text,ai);
        result = { ...applied, reaction };
      }
    } catch (e) {
      const fallback = C.react(character.get(), events.at(-1), character.get().interactions.length);
      if (version === character.version()) {
        const reaction = { id, sessionId: key, part: events.at(-1).part, kind: events.at(-1).kind, text: fallback.text, ai: false, at: now() };
        result = { ...character.set({ ...fallback, interactionReaction: reaction }, 'ai', { expectedVersion: version }), reaction, offline: true,
          fallbackReason:e instanceof SyntaxError?'invalid-json':e.name==='TimeoutError'?'timeout':'unavailable' };
        record(fallback.text,false);
      } else result = { ...character.get(), superseded: true };
    } finally {
      record(null,false);
      job.running = false;
      for (const resolve of waiters) resolve(result || { ...character.get(), superseded: true });
      if (job.events.length) job.timer = setTimeout(() => void drain(key, job), debounceMs);
      else jobs.delete(key);
    }
  }
  async function idle(key = 'default') {
    if (idleBusy || jobs.size || now() - idleAt < 65000 || ['manual','touch'].includes(character.get().source)) return { ...character.get(), skipped: true };
    idleAt = now(); idleBusy = true;
    const version = character.version();
    try {
      const history = session(key).messages.filter(m => ['user','assistant'].includes(m.role) && m.content).slice(-4);
      const value = await complete([{ role: 'system', content: prompt('idle') }, { role:'user', content: JSON.stringify({ recent:history, lastPerformance: character.get().gesture }) }],{mode:'idle'});
      const normalized = C.normalize(value);
      normalized.expressions = normalized.expressions.filter(x => !C.OUTFITS.includes(x));
      return character.set(normalized, 'ai', { expectedVersion: version });
    } catch { return { ...character.get(), skipped: true }; }
    finally { idleBusy = false; }
  }
  return { enqueue, idle };
}
