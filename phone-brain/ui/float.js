/* 浮窗里那个"她"（2026-10-18；2026-10-20 加"直接说话"）
 *
 * 职责：
 *   ① 用 APK 里打包的自己（本机 127.0.0.1:8791）把 Live2D 画出来；
 *   ② 轮询 /api/float，主界面聊出新内容时在这里冒个气泡；
 *   ③ 状态点：拿不到大脑就变红；
 *   ④ **说话**：右下角话筒 —— 点一下开录、再点一下发出去，
 *      走录音、转文字、带手机工具的回复和流式语音。
 *
 * 录音为什么走原生：浮窗页面是 http://192.168.137.1:8790（非安全来源），
 * WebView 里 navigator.mediaDevices 是 undefined，只能调 Java 的 MediaRecorder
 * （FloatService 里注册的 "Android" 桥 → Recorder）。
 * 点一下 / 长按的整体手势仍由 Java 侧 FloatService 处理（拖窗、开主界面、关浮窗）；
 * 话筒按钮那块 Java 已经排除了，不会顺手把 App 拉起来。
 */
(function () {
  const bubble = document.getElementById('bubble');
  const dot = document.getElementById('dot');
  const mic = document.getElementById('mic');
  const kbBtn = document.getElementById('kbBtn');
  const inputRow = document.getElementById('inputRow');
  const msgInput = document.getElementById('msgInput');
  const sendBtn = document.getElementById('sendBtn');

  const LOCAL_MODEL = 'http://127.0.0.1:8791/model/deepseek-chan/大肥鱼.model3.json';

  let lastText = '';
  let mouthTimer = null;
  let speaking = false, finishAudio=null, audioGeneration=0;
  const speechStreams=new Set();

  // ───────────────────────────── 和 Java 的小桥 ───────────────────────────
  const NATIVE = typeof window.Android !== 'undefined';
  let seq = 0;
  const pend = new Map();

  function call(method, args = {}) {
    if (!NATIVE) return Promise.reject(new Error('没有原生桥'));
    const id = 'f' + (++seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pend.delete(id); reject(new Error('原生超时: ' + method)); }, method==='tool'?90000:30000);
      pend.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { window.Android.invoke(id, method, JSON.stringify(args)); }
      catch (e) { clearTimeout(timer); pend.delete(id); reject(e); }
    });
  }

  // 原生会推事件过来（目前只有录音自动停：VAD 说完安静 1.2 秒就收工）
  window.__nativeEvent = (type, payload) => {
    let data = null;
    try { data = payload ? JSON.parse(payload) : null; } catch { }
    if (type === 'recAuto') {
      if (!recording) return;
      void finishRec(data);
    }
  };

  window.__nativeResult = (id, ok, payload) => {
    const p = pend.get(id);
    if (!p) return;
    pend.delete(id);
    let data = null;
    try { data = payload ? JSON.parse(payload) : null; } catch { data = { raw: payload }; }
    if (ok === true || ok === 'true') p.resolve(data);
    else p.reject(new Error((data && data.error) || '原生出错'));
  };

  // ───────────────────────────── 说话 ─────────────────────────────────────
  let recording = false;
  let busy = false;

  // 连续对话（2026-10-21）：一轮说完、她答完，自动再听一轮 ——
  // 直到「没人说话」「说拜拜/再见」或者连续 8 轮为止。开关键和主界面共用（同源 localStorage）。
  const CONT_KEY = 'amadeus.continuous';
  let continuous = localStorage.getItem(CONT_KEY) !== '0';
  let contRounds = 0;
  const CONT_MAX = 8;
  /** 说到这些词就退出连续对话 */
  const EXIT_RE = /^(拜拜|再见|拜|不聊了|先这样|没事了|停|睡吧|结束|退下)/;
  const audioEl = new Audio();
  audioEl.preload = 'auto';

  // 浮窗这边也走 Web Audio：一个 GainNode 做首尾淡入淡出（结尾那下"电音"压掉）
  let actx = null, again = null, asrc = null;
  function ensureGraph() {
    try {
      if (!actx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        actx = new AC();
        again = actx.createGain();
        again.gain.value = 1;
        again.connect(actx.destination);
      }
      if (!asrc) {
        asrc = actx.createMediaElementSource(audioEl);
        asrc.connect(again);
      }
      if (actx.state === 'suspended') actx.resume().catch(() => {});
      return true;
    } catch (e) { return false; }
  }

  /** 以MSE边接收边播，完整EOF后结束。 */
  async function playUrl(stream,{offset=0,signal}={}) {
    const src=stream.url;
    return new Promise((resolve) => {
      let done = false,startup,stall;
      const finish = (ok=false) => {
        if (done) return;
        done = true;clearTimeout(startup);clearTimeout(stall);
        try{audioEl.pause();}catch{}
        audioEl.onended=audioEl.onerror=audioEl.onplaying=audioEl.ontimeupdate=audioEl.onloadedmetadata=null;
        if(finishAudio===finish)finishAudio=null;
        speaking = false;
        stream.dispose();
        speechStreams.delete(stream);
        if (NATIVE) call('wakeResume').catch(() => {});
        signal?.removeEventListener('abort',cancel);
        resolve({ok,position:Math.max(0,audioEl.currentTime||offset)});
      };
      const cancel=()=>finish(false);signal?.addEventListener('abort',cancel,{once:true});
      finishAudio=finish;
      startup=setTimeout(()=>{if(audioEl.readyState<2){try{audioEl.pause();}catch{}finish();}},4500);
      try {
        audioEl.pause();
        if (NATIVE) call('wakePause').catch(() => {});
        ensureGraph();
        audioEl.src = src;
        audioEl.onended = async() => finish(await stream.completed);
        audioEl.onerror = () => finish(false);
        audioEl.onloadedmetadata=()=>{if(offset>0&&Number.isFinite(audioEl.duration))audioEl.currentTime=Math.max(0,Math.min(offset-.15,audioEl.duration-.05));};
        let fadedIn=false;
        audioEl.onplaying = () => {
          clearTimeout(startup);
          try {
            if (!fadedIn&&again && actx) {
              fadedIn=true;
              const t = actx.currentTime, g = again.gain;
              g.cancelScheduledValues(t);
              g.setValueAtTime(0.0001, t);
              g.linearRampToValueAtTime(1, t + 0.02);
            }
          } catch (e) { }
        };
        speaking = true;
        const watchStall=()=>{clearTimeout(stall);stall=setTimeout(finish,15000);};
        audioEl.ontimeupdate=watchStall;watchStall();
        const p = audioEl.play();
        if (p && p.catch) p.catch(() => finish());
      } catch (e) { finish(); }
    });
  }

  function stopSpeaking() {
    audioGeneration++;
    speechPlayer.cancel();
    finishAudio?.();
    for(const stream of speechStreams)stream.dispose();
    speechStreams.clear();
    speaking = false;
    try { audioEl.pause(); audioEl.src = ''; } catch (e) { }
  }

  /**
   * 把她这一轮的回复说出来。
   * ⚠️ 2026-10-21 改成走 `/api/turn`（**带工具**）：主人在浮窗里问"屏幕上写的啥"，
   *    原来走的是不带工具的 /api/turn-stream，她根本没法读屏。
   *    代价是没有流式首字，回复整段回来再一句句合成（浮窗多是短指令，可以接受）。
   */
  async function reply(text, opts = {}) {
    stopSpeaking();
    window.HerActions.begin(text);
    const performanceId=window.HerPresence?.beginAction(text)||'';
    try{
    const sessionId=window.HerPresence.sessionId;
    let payload = { text,performanceId };
    for (let guard = 0; guard < 8; guard++) {
      const res = await fetch('/api/turn', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({sessionId,...payload}),
        signal: AbortSignal.timeout(120000),
      }).then((r) => r.json());
      if (!res || res.ok === false) throw new Error((res && res.error) || '她那边出错');
      if (res.character) window.HerPresence?.apply(res.character, true);

      if (res.text) showBubble(res.text);
      if (res.type !== 'tool' || !res.toolCalls || !res.toolCalls.length) {
        if (res.text) await speakText(res.text);
        maybeContinue(opts.fromVoice);
        return;
      }

      // 要动手：先把"在弄…"挂出来，再把每个工具跑一遍喂回去
      showBubble(res.text || '（看一眼…）');
      const results = [];
      for (const c of res.toolCalls) {
        results.push(await runToolCall(c));
      }
      payload = { toolResults: results,toolBatchId:res.toolBatchId };
    }
    }finally{window.HerPresence?.endAction(performanceId);}
  }

  /** 她答完 → 等一下（别把自己的尾音录进去）→ 自动再听一轮。 */
  function maybeContinue(fromVoice) {
    if(speechPlayer.status==='paused')return;
    console.log('[cont] maybeContinue', fromVoice, continuous, contRounds, 'busy=' + busy, 'rec=' + recording);
    if (!fromVoice || !continuous) { contRounds = 0; return; }
    if (contRounds >= CONT_MAX) {
      contRounds = 0;
      showBubble('先聊到这儿，叫我名字就行');
      return;
    }
    contRounds += 1;
    setTimeout(() => {
      if (!busy && !recording) void startRec(true);
    }, 420);
  }

  async function runToolCall(c) {
    c=window.HerActions.prepare(c);
    try {
      if(c.name==='phone_memory_search')return {id:c.id,content:JSON.stringify(await(await fetch('/api/memory/search?'+new URLSearchParams(c.args||{}))).json())};
      if(c.name==='phone_message_hub')return {id:c.id,content:JSON.stringify(await(await fetch('/api/hub/ai')).json())};
      if(['phone_qq_desktop','phone_wechat_desktop'].includes(c.name)){const query=new URLSearchParams(c.args||{});query.set('forAi','1');const response=await fetch((c.name==='phone_wechat_desktop'?'/api/desktop-wechat/messages?':'/api/desktop-qq/messages?')+query);return {id:c.id,content:JSON.stringify(await response.json())};}
      if (c.name === 'phone_character') return { id: c.id, content: JSON.stringify(await window.HerPresence.choose({ ...(c.args || {}), source: 'tool' })) };
      const reason=window.HerActions.check(c);
      if(reason)return {id:c.id,content:JSON.stringify({ok:false,blocked:true,error:reason})};
      if (c.name === 'phone_shell') {
        const r = await call('shizuku', { action: 'run', command: String((c.args && c.args.command) || '') });
        return {
          id: c.id,
          content: JSON.stringify({
            ok: r && r.ok === true,
            code: (r && r.code) ?? null,
            out: String((r && (r.out || r.error)) || '').slice(0, 3000),
          }),
        };
      }
      const res = await call('tool', { name: c.name, args: c.args || {} });
      if(c.name==='phone_bilibili')await fetch('/api/media',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:window.HerPresence.sessionId,args:c.args,result:res})}).catch(()=>{});
      return { id: c.id, content: JSON.stringify(res || { ok: true }) };
    } catch (e) {
      return { id: c.id, content: JSON.stringify({ ok: false, error: String((e && e.message) || e) }) };
    }
  }

  /** 按句切、逐句播（TTS 一句句来，接缝小）。 */
  async function speakText(text) {
    return speechPlayer.enqueue(text);
  }
  const speechNotice=window.HerSpeech.notice(()=>{void speechPlayer.resume();});
  const speechPlayer=window.HerSpeech.create({split:window.HerSpeechText.split,
    open:(text,options)=>window.HerAudio.open('/api/tts-stream?text='+encodeURIComponent(text),options),
    play:playUrl,onState:speechNotice});

  /** 开录（点话筒 / 唤醒词 / 连续对话共用）。自动停交给原生 VAD。 */
  async function startRec(auto) {
    console.log('[cont] startRec', auto, 'busy=' + busy, 'rec=' + recording);
    if (busy || recording) return;
    try {
      await call('recStart');
      recording = true;
      mic.classList.add('rec');
      showBubble(auto ? '在听…（说完停一下就行）' : '在听…');
    } catch (e) {
      showBubble('开不了麦克风：' + ((e && e.message) || e));
    }
  }

  // ── 打字（2026-10-21）：浮窗里也能输入，不切回主界面 ─────────────────
  function openKeyboard() {
    inputRow.classList.add('show');
    bubble.classList.remove('show');
    if (NATIVE) call('focusOn').catch(() => { });
    setTimeout(() => { try { msgInput.focus(); } catch (e) { } }, 150);
  }

  function closeKeyboard() {
    inputRow.classList.remove('show');
    try { msgInput.blur(); } catch (e) { }
    if (NATIVE) call('focusOff').catch(() => { });
  }

  async function sendTyped() {
    if(busy||recording||inputComposing)return;
    const t = String(msgInput.value || '').trim();
    msgInput.value = '';
    closeKeyboard();
    if (!t) return;
    if (speaking) stopSpeaking();
    showBubble(t);
    busy=true;
    try { await reply(t, { fromVoice: false }); }
    catch (e) { showBubble(String((e && e.message) || e)); }
    finally{busy=false;}
  }

  if (kbBtn) {
    kbBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (inputRow.classList.contains('show')) closeKeyboard();
      else openKeyboard();
    });
  }
  if (sendBtn) sendBtn.addEventListener('click', (ev) => { ev.stopPropagation(); void sendTyped(); });
  let inputComposing=false,inputComposedAt=-Infinity;
  if (msgInput) {
    msgInput.addEventListener('compositionstart',()=>{inputComposing=true;});
    msgInput.addEventListener('compositionend',()=>{inputComposing=false;inputComposedAt=performance.now();});
    msgInput.addEventListener('keydown', (e) => {
      if(e.isComposing||inputComposing||e.keyCode===229||performance.now()-inputComposedAt<60)return;
      if (e.key === 'Enter') { e.preventDefault(); void sendTyped(); }
    });
  }

  mic.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (busy) return;

    // 正在播 → 这一下当"闭嘴"用（和主界面一致）
    if (speaking && !recording) { stopSpeaking(); return; }

    if (!recording) { await startRec(false); return; }
    await finishRec();
  });

  /** 停止录音 → 转写 → 她回话。唤醒词和点话筒走的是同一条路。 */
  async function finishRec(pre) {
    recording = false;
    mic.classList.remove('rec');
    busy = true;
    try {
      const r = pre || await call('recStop');
      const b64 = (r && r.data) || '';
      if (!b64) throw new Error('没录到声音');
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      showBubble('…');
      const asrRes = await fetch('/api/asr', {
        method: 'POST',
        headers: { 'content-type': (r && r.mime) || 'audio/mp4' },
        body: bytes,
        // ⚠️ 一定要超时：服务端转写要 10~60 秒，连接断了不设超时会一直挂着，
        //    busy 永远是 true，话筒就再也点不动了（2026-10-20 踩到）
        signal: AbortSignal.timeout(70000),
      });
      const asr = await asrRes.json();
      if (!asr.ok) throw new Error(asr.error || '转写失败');
      // 唤醒词触发的录音里带着"大肥鱼"，把它去掉再交给她
      const text = String(asr.text || '').trim()
        .replace(/^(大肥鱼|大肥魚|大飞鱼|大飞魚)[，,。、！!？?\s]*/, '').trim();
      if (!text) {
        // 连续对话里"没人说话"就是结束信号
        contRounds = 0;
        showBubble('那我先待着，叫我名字就行');
        return;
      }
      if (EXIT_RE.test(text)) {
        contRounds = 0;
        showBubble('好，先这样');
        return;
      }
      showBubble(text);
      await reply(text, { fromVoice: true });
    } catch (e) {
      showBubble(String((e && e.message) || e));
    } finally {
      busy = false;
    }
  }

  // ───────────────────────────── 启动 ─────────────────────────────────────
  async function boot() {
    window.HerStartup?.mark('avatarStartedAt');
    window.HerPresence?.configure({ onContact:()=>{if(!busy)stopSpeaking();}, context:()=>({busy:busy||recording,speaking}), onReaction:(text,reaction)=>{showBubble(text);if(reaction.ai)void speakText(text);} });
    let l2d = null;
    // 浮窗用半身近景；本地资源与远程回退共用同一取景。
    const framing={zoom:3.8,offsetY:.88,insetTop:29,insetBottom:47,onTouchStart:window.HerPresence?.rubStart};
    if(NATIVE)try{
      const local=await call('modelLocal');
      if(local?.url)l2d=await window.L2D.load(local.url,document.body,framing);
    }catch{}
    if(!l2d)try{
        const info = await window.HerStartup.modelInfo();
        if (info && info.url) l2d = await window.L2D.load(info.url, document.body, framing);
    }catch{}
    const retry=document.getElementById('floatRetry');if(retry)retry.hidden=!!l2d;

    // 平时轻轻呼吸；她在说话时嘴动得明显一点
    if (l2d) {
      window.HerStartup?.mark('avatarReadyAt');
      window.__floatAvatar = l2d;
      mouthTimer = setInterval(() => {
        const t = Date.now() / 1000;
        const v = speaking ? .12+.16*Math.abs(Math.sin(t*9.5))+.03*Math.abs(Math.sin(t*5.7)) : 0;
        l2d.mouth(Math.min(0.85, v));
      }, 90);
    }

    window.__herUiReady=true;
    window.HerStartup?.mark('uiReadyAt');
    if(NATIVE)void call('pageReady',{url:location.href}).catch(()=>{});
    poll();
  }
  document.getElementById('floatRetry')?.addEventListener('click',()=>{document.getElementById('floatRetry').hidden=true;void boot();});
  setInterval(poll,3000);
  let pollPending=false;
  let routesLearnedAt=0,routesLearning=false;
  async function learnRoutes(){
    if(!NATIVE||routesLearning||Date.now()-routesLearnedAt<30000)return;routesLearning=true;
    try{const r=await fetch('/api/tunnel',{cache:'no-store',signal:AbortSignal.timeout(10000)}),j=await r.json();
      if(j.ok&&j.urlWithToken){await call('setAlt',{url:j.urlWithToken});if(Array.isArray(j.urlsWithToken))await call('setFallbacks',{urls:j.urlsWithToken});if(j.stableUrlWithToken)await call('setStable',{url:j.stableUrlWithToken});routesLearnedAt=Date.now();}
    }catch{}finally{routesLearning=false;}
  }
  window.HerConnection?.install({blocked:()=>document.hidden||busy||recording||speaking||!!document.getElementById('msgInput')?.value.trim(),recover:()=>NATIVE?call('recover'):Promise.resolve(),recheck:()=>void poll()});

  async function poll() {
    if(pollPending||document.hidden)return;pollPending=true;
    try {
      const r = await fetch('/api/float', { cache: 'no-store',signal:AbortSignal.timeout(10000) });
      const j = await r.json();
      void window.HerConnection?.observe(r.ok&&j.ok===true,{unauthorized:r.status===401||r.status===403});
      if(r.ok&&j.ok===true)void learnRoutes();
      dot.className = 'dot' + (j.ok ? '' : ' off');
      const text = String(j.text || '').trim();
      if (j.stale) return;
      if (text && text !== lastText) {
        lastText = text;
        showBubble(text);
      }
    } catch (e) {
      void window.HerConnection?.observe(false);
      dot.className = 'dot off';
    }finally{pollPending=false;}
  }

  function showBubble(text) {
    bubble.textContent = text;
    bubble.classList.add('show');
    clearTimeout(showBubble.t);
    // 她说话/回复留久一点，状态提示 3 秒就够
    const ms = recording || speaking ? 12000 : 9000;
    showBubble.t = setTimeout(() => bubble.classList.remove('show'), ms);
  }

  /** 原生听到"大肥鱼"了：直接开始录，6 秒后自己发出去（再点一下可以提前结束）。 */
  window.__onWake = () => { contRounds = 0; void startRec(true); };
  // 调试：直接开始一轮"连续对话"式的录音（不经过麦克风触发）
  window.__floatListen = () => { contRounds = 0; void startRec(true); };

  // 调试用：当作"她刚收到一条语音"，会走"回答完自动接听下一轮"那条路
  window.__floatConverse = (t) => reply(String(t || ''), { fromVoice: true })
    .catch((e) => showBubble(String((e && e.message) || e)));

  // 调试/以后加文字输入用：让浮窗直接说一句（不经过麦克风）
  window.__floatSay = (text) => {
    const t = String(text || '').trim();
    if (!t) return Promise.resolve();
    showBubble(t);
    return reply(t).catch((e) => showBubble(String((e && e.message) || e)));
  };

  // 点气泡区域时把它收起来（不然挡住人）
  bubble.addEventListener('click', () => bubble.classList.remove('show'));
  document.getElementById('floatOpen').onclick = () => call('openApp').catch(() => {});
  document.getElementById('floatClose').onclick = () => call('close').catch(() => {});

  boot();
})();
