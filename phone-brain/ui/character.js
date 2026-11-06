/* Actual interaction events feed the conversation AI; visuals react before text arrives. */
(function () {
  'use strict';
  const C = window.HerCharacter, models = new Set();
  let sessionId=window.HerChat.sessionId;
  const currentSession=()=>{sessionId=window.HerChat.sessionId;return sessionId;};
  window.addEventListener('her:day',()=>{sessionId=window.HerChat.sessionId;serial++;deferred=null;});
  let current = { ...C.normalize(), accessories: [], palette: C.MOODS.calm.palette, revision:-1 };
  let options = {}, serial = 0, pendingTouches = 0, pollBusy = false, lastActivity = Date.now(), deferred = null;
  let lastReactionId = '', idleTimer,pendingAction='';
  function context() { return options.context?.() || { busy:false, speaking:false }; }
  function notify(reaction) {
    if (!reaction?.text || !reaction.id || reaction.sessionId && reaction.sessionId !== currentSession() || reaction.id === lastReactionId) return;
    if (context().busy || context().speaking) { deferred = reaction; return; }
    lastReactionId = reaction.id; deferred = null; options.onReaction?.(reaction.text, reaction);
  }
  function apply(value, animate = false) {
    if (Number.isFinite(value.revision) && value.revision < current.revision) return current;
    const changed = value.revision !== current.revision;
    current = { ...current, ...value, ...C.normalize(value) };
    current.accessories = C.expressions(value.accessories ?? current.accessories);
    current.palette = C.MOODS[current.mood].palette; current.label = C.MOODS[current.mood].label;
    document.body.dataset.mood = current.mood;
    document.documentElement.style.setProperty('--mood-color',current.palette[0]);
    for (const model of models) model.setAppearance(current, animate && changed);
    window.dispatchEvent(new CustomEvent('her:state',{detail:{...current}}));
    if (!pendingTouches) notify(value.reaction);
    return current;
  }
  async function pull() {
    if (pollBusy || document.hidden || pendingTouches || pendingAction) return;
    pollBusy = true; const version = serial;
    try {
      const r = await fetch('/api/character',{cache:'no-store',signal:AbortSignal.timeout(6000)});
      const j = r.ok ? await r.json() : null;
      if (j?.ok && version===serial && !pendingTouches) apply(j,true);
    } catch {} finally { pollBusy=false; }
  }
  const recent=[];
  async function touch(event) {
    if (!event || !C.PARTS[event.part]) return;
    while(recent.length && Date.now()-recent[0]>12000)recent.shift(); const count=recent.length; recent.push(Date.now());
    lastActivity=Date.now(); const version=++serial;
    const reflex=C.react(current,event,count);
    // Body reflex only; the AI gets to decide what she says and how she feels.
    for (const model of models) model.setAppearance({...current,gesture:window.HerContact?.profiles[event.part]||reflex.gesture,duration:1,intensity:.45,plan:[]},true);
    pendingTouches++;
    const payload={...event,sessionId:currentSession()};
    try {
      const r=await fetch('/api/interaction-stream',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(28000)});
      if(!r.ok||!r.body)throw new Error('interaction connection');
      const reader=r.body.getReader(),decoder=new TextDecoder();let buffer='';
      const deliver=line=>{
        if(!line.trim())return;const message=JSON.parse(line);
        if(version!==serial)return;
        if(message.type==='reaction')notify(message.reaction);
        if(message.type==='done'&&message.state.ok&&!message.state.superseded){apply(message.state,true);notify(message.state.reaction);}
        if(message.type==='error')throw new Error(message.error);
      };
      while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines)deliver(line);}
      buffer+=decoder.decode();if(buffer.trim())deliver(buffer);

    } catch {
      if(version===serial) {
        const fallback={...reflex,id:event.id,sessionId,ai:false,at:Date.now()};
        apply({...current,...reflex},true); notify(fallback);
      }
    } finally {
      pendingTouches=Math.max(0,pendingTouches-1);
      if(!pendingTouches)void pull();
    }
  }
  async function choose(value) {
    ++serial; lastActivity=Date.now();
    const r=await fetch('/api/character',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value),signal:AbortSignal.timeout(8000)});
    const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||'设置未保存');
    return apply(j,true);
  }
  function beginAction(text){
    const motion=window.HerIntent?.character(text);if(!motion)return '';
    ++serial;lastActivity=Date.now();deferred=null;
    pendingAction='action-'+Date.now()+'-'+Math.random().toString(36).slice(2,9);
    for(const model of models)model.setAppearance({...current,...motion,performanceId:pendingAction},true);
    return pendingAction;
  }
  function endAction(id){if(id&&pendingAction===id){pendingAction='';void pull();}}
  async function idle() {
    clearTimeout(idleTimer);
    try {
      if(!document.hidden && !pendingTouches && !pendingAction && !context().busy && !context().speaking && Date.now()-lastActivity>22000 && document.activeElement?.tagName!=='INPUT') {
        const version=serial;
        const r=await fetch('/api/character/idle',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:currentSession()}),signal:AbortSignal.timeout(14000)});
        const j=r.ok?await r.json():null;
        if(j?.ok&&!j.skipped&&serial===version)apply(j,true);
      }
    }catch{}
    idleTimer=setTimeout(idle,65000+Math.random()*20000);
  }
  window.HerPresence={
    get sessionId(){return currentSession();},get:()=>({...current}),getContext:context,apply,choose,pull,touch,beginAction,endAction,
    attach:model=>{models.add(model);model.setAppearance(current);},detach:model=>models.delete(model),
    configure:value=>{options={...options,...value};},
    rubStart:event=>{lastActivity=Date.now();for(const model of models)model.playGesture(window.HerContact?.profiles[event.part]||'listen',1.6,.42);},
  };
  window.addEventListener('her:contact',ev=>{++serial;deferred=null;options.onContact?.();lastActivity=Date.now();for(const model of models)model.playGesture(window.HerContact?.profiles[ev.detail.part]||'listen',.8,.45);});
  window.addEventListener('her:touch',ev=>{void touch(ev.detail);});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void pull();});
  document.addEventListener('keydown',()=>{lastActivity=Date.now();},{passive:true});
  setInterval(()=>{void pull();if(deferred&&Date.now()-deferred.at<20000)notify(deferred);else deferred=null;},1800);
  idleTimer=setTimeout(idle,35000+Math.random()*10000);
  apply(current);void pull();
})();
