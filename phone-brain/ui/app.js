/* 手机端前端：形象 + 对话 + 工具调用。
 * 与原生（WebView 里的 JS 桥）约定：
 *   Android.invoke(id, method, argsJson)          ← 前端发请求（立刻返回）
 *   window.__nativeResult(id, ok, payloadJson)    ← 原生回调结果
 *   window.__nativeEvent(type, payloadJson)       ← 原生主动事件（例如返回键）
 */

// ────────────────────────────────────────── 桥 ────────────────────────────
const NATIVE = typeof window.Android !== 'undefined';
let seq = 0;
const pending = new Map();

function call(method, args = {}) {
  if (!NATIVE) return Promise.reject(new Error('no native bridge'));
  const id = 'c' + (++seq);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('native timeout: ' + method));
    }, 150000);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    try {
      window.Android.invoke(id, method, JSON.stringify(args));
    } catch (e) {
      pending.delete(id); clearTimeout(timer); reject(e);
    }
  });
}

window.__nativeResult = (id, ok, payload) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  let data = null;
  try { data = payload ? JSON.parse(payload) : null; } catch { data = { raw: payload }; }
  if (ok === true || ok === 'true') p.resolve(data);
  else p.reject(new Error((data && (data.error || data.message)) || 'native error'));
};

window.__nativeEvent = (type, payload) => {
  let data = null;
  try { data = payload ? JSON.parse(payload) : null; } catch {}
  if (type === 'back') {
    const characterPanel = document.getElementById('characterPanel');
    if (characterPanel) { characterPanel.querySelector('[data-close]')?.click(); return; }
    if (!overlay.hidden) { hideOverlay(); return; }
    if (document.getElementById('hubDetail')?.open) { document.getElementById('hubDetail').close(); return; }
    if (!log.hidden) { log.hidden = true; return; }
    if (document.body.dataset.page && document.body.dataset.page !== 'chat') { switchPage('chat'); return; }
    call('minimize').catch(() => {});
  }
  // speechStart / speechEnd 是**系统 TTS**（原生）的起止，不是"用户在说话"
  if (type === 'speechStart') setSpeaking(true);
  if (type === 'speechEnd') setSpeaking(false);
  if (type === 'a11y') setA11y(data?.enabled === true);
  // 录音自动停了（原生 VAD：说完安静 1.2 秒就收工）—— 当成"再点一下停"处理
  if (type === 'recAuto') {
    if (!nativeRec) return;                 // 已经手动停了，忽略
    nativeRec = false;
    btnMic.classList.remove('rec');
    clearTimeout(nativeRecTimer);
    setBubble('（在听写…）', { thinking: true, sticky: true });
    finishNativeRec(data).catch((e) => setBubble('转写失败：' + (e.message || e)));
  }
};

// ────────────────────────────────────────── 元素 ──────────────────────────
const $ = (id) => document.getElementById(id);
const stage = $('stage');
const canvas = $('avatarCanvas');
const avatarImg = $('avatarImg');
const bubble = $('bubble');
const dot = $('statusDot');
const input = $('input');
const btnSend = $('btnSend');
const btnMic = $('btnMic');
const btnLog = $('btnLog');
const btnMenu = $('btnMenu');
const log = $('log');
const overlay = $('overlay');
const overlayBox = $('overlayBox');
const a11yBar = $('a11yBar');
const a11yFix = $('a11yFix');

/** 无障碍服务的开关状态：没开就在顶部亮一条红横幅，一键跳过去开。 */
function setA11y(enabled) {
  state.a11y = enabled;
  if (!a11yBar) return;
  a11yBar.hidden = !NATIVE || enabled === true || ['inbox','space'].includes(document.body.dataset.page);
}
if (a11yFix) {
  a11yFix.onclick = () => { call('openSettings', { panel: 'accessibility' }).catch(() => {}); };
}

// ────────────────────────────────────────── 状态 ──────────────────────────
const state = {
  serverOk: false,
  speaking: false,
  busy: false,
  avatar: { mode: 'placeholder', base: null, frames: [], manifest: null },
  get sessionId(){return window.HerPresence.sessionId;},
};

// ────────────────────────────────────────── 形象 ──────────────────────────
const ctx = canvas.getContext('2d');
let blinkAt = performance.now() + 2500;
let blinkUntil = 0;
let t0 = performance.now();
const bodyState = { mouth: 0, mouthTarget: 0, blush: 0.35 };

function setSpeaking(on) {
  state.speaking = on;
  document.body.classList.toggle('speaking', on);
}

/** 让 canvas 的像素密度跟设备一致，否则在高 DPR 屏上会被放大糊掉。 */
function fitCanvas() {
  if (state.avatar.mode !== 'placeholder') return;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const cssW = Math.max(220, Math.min(window.innerWidth * 0.92, window.innerHeight * 0.74 * 0.75));
  const cssH = cssW / 0.75;
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
}
window.addEventListener('resize', () => fitCanvas());


function drawLoading(now, w, h) {
  ctx.clearRect(0, 0, w, h);
  const k = Math.min(devicePixelRatio || 1, 3);
  ctx.save(); ctx.scale(k, k);
  const x = w / k / 2, y = h / k * .48;
  ctx.strokeStyle = 'rgba(151,201,226,.16)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, 20, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = '#9bcada';
  ctx.beginPath(); ctx.arc(x, y, 20, now / 1000, now / 1000 + 1.4); ctx.stroke();
  ctx.fillStyle = '#b5ccdf'; ctx.font = '13px system-ui'; ctx.textAlign = 'center';
  ctx.fillText('正在等她出现…', x, y + 49); ctx.restore();
}

function tick(now) {
  requestAnimationFrame(tick);
  const w = canvas.width, h = canvas.height;
  bodyState.mouth += (bodyState.mouthTarget - bodyState.mouth) * 0.35;
  bodyState.mouthTarget = state.speaking
    ? 0.35 + Math.abs(Math.sin(now / 90)) * 0.65
    : 0.04 + Math.abs(Math.sin(now / 1400)) * 0.05;

  if (state.avatar.mode === 'live2d') {
    // 画面交给 pixi，这里只喂嘴型
    if (state.l2d) {
      if (state.playingAudio) {
        // 真·口型：跟着正在播的声音走
        const lvl = voiceLevel();
        bodyState.mouth += (Math.max(0.03, lvl) - bodyState.mouth) * 0.6;
        state.l2d.mouth(bodyState.mouth);
      } else {
        if (state.speaking) { state.l2d.mouth(bodyState.mouth); return; }
        // Quiet companionship uses gaze/breath/weight shifts; let the mouth rest.
        bodyState.mouth += (0 - bodyState.mouth) * 0.2;
        state.l2d.mouth(bodyState.mouth);
      }
    }
    return;
  }
  if (state.avatar.mode === 'placeholder') {
    if (now > blinkAt) { blinkUntil = now + 110; blinkAt = now + 2600 + Math.random() * 3200; }
    drawLoading(now, w, h);
  } else if (state.avatar.mode === 'frames') {
    drawFrame(now, w, h);
  }
}

let frameImgs = [];
let frameIdx = 0;
let frameAt = 0;
function drawFrame(now, w, h) {
  if (!frameImgs.length) return;
  const fps = (state.avatar.manifest && state.avatar.manifest.fps) || 12;
  if (now - frameAt > 1000 / fps) {
    frameIdx = (frameIdx + 1) % frameImgs.length;
    frameAt = now;
  }
  const img = frameImgs[frameIdx];
  if (!img.complete) return;
  ctx.clearRect(0, 0, w, h);
  const scale = Math.min(w / img.width, h / img.height);
  const dw = img.width * scale, dh = img.height * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/**
 * 把 Live2D 的模型文件「带重试」先拉进浏览器缓存。
 * 为什么：公网隧道偶尔会把一个 2MB 的 .moc3 掐断（pixi 收到 Status 0 就整体失败），
 * 提前用 fetch 重试几次，等 pixi 再去要时就是缓存命中，稳得多。
 */
async function warmModel(model3Url) {
  const fetchRetry = async (u, tries = 4) => {
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch(u, { cache: 'force-cache' });
        if (r.ok) { await r.arrayBuffer(); return true; }
      } catch (e) { /* 再试 */ }
      await new Promise((res) => setTimeout(res, 600 * (i + 1)));
    }
    return false;
  };
  try {
    const base = model3Url.slice(0, model3Url.lastIndexOf('/') + 1);
    const j = await (await fetch(model3Url, { cache: 'force-cache' })).json();
    const refs = j?.FileReferences ?? {};
    const files = [];
    if (refs.Moc) files.push(base + refs.Moc);
    for (const t of refs.Textures ?? []) files.push(base + t);
    if (refs.Physics) files.push(base + refs.Physics);
    if (refs.Pose) files.push(base + refs.Pose);
    await Promise.all(files.map((u) => fetchRetry(u)));
  } catch (e) {
    console.warn('模型预热失败（继续加载试试）', e);
  }
}

async function loadAvatar({refresh=false}={}) {
  window.HerStartup?.mark('avatarStartedAt');
  state.l2d?.destroy(); state.l2d = null;
  state.avatar = { mode: 'placeholder' }; canvas.hidden = false; canvas.style.display = '';
  avatarImg.hidden = true; fitCanvas();
  const info=await window.HerStartup.modelInfo({refresh});
  const options = { zoom: info.zoom, offsetY: info.offsetY, insetTop:76,insetBottom:86,onTouchStart: window.HerPresence?.rubStart };
  const sources = [];
  if (NATIVE) {
    try {
      const local = await call('modelLocal');
      // An installed old APK must not override the newly selected server model.
      if (local?.url && local.url.includes('/deepseek-chan/')) sources.push({ url: local.url, local: true });
    } catch {}
  }
  if (info.mode === 'live2d' && info.url) sources.push({ url: info.url, local: false });
  if (!sources.length && NATIVE) sources.push({ url: 'http://127.0.0.1:8791/model/deepseek-chan/大肥鱼.model3.json', local: true });
  for (const source of sources) {
    try {
      state.l2d = await window.L2D.load(source.url, stage, options);
      state.avatar = { ...info, mode: 'live2d', local: source.local };
      canvas.hidden = true; document.getElementById('btnRetryAvatar')?.remove();
      window.HerStartup?.mark('avatarReadyAt');
      return;
    } catch (e) { console.warn('[live2d] 加载失败', e.message); }
  }
  canvas.hidden = false; state.avatar = { mode: 'placeholder' }; fitCanvas();
  setBubble('形象暂时没加载好，可以重试；聊天仍然能用。');
  if (!document.getElementById('btnRetryAvatar')) {
    const retry = document.createElement('button'); retry.id = 'btnRetryAvatar'; retry.textContent = '重新加载形象';
    retry.onclick = () => { retry.remove(); void loadAvatar({refresh:true}); }; stage.appendChild(retry);
  }
}

// ────────────────────────────────────────── UI ────────────────────────────
function setBubble(text, { thinking = false, sticky = false } = {}) {
  bubble.textContent = text;
  bubble.classList.toggle('thinking', thinking);
  bubble.classList.add('show');
  clearTimeout(setBubble._t);
  if (!sticky && !thinking) {
    setBubble._t = setTimeout(() => bubble.classList.remove('show'), Math.max(2600, text.length * 95));
  }
}

function addLog(role,text){window.HerHistory.add(role,text);}

function showOverlay(html, wireUp) {
  overlayBox.innerHTML = html;
  overlay.hidden = false;
  if (wireUp) wireUp(overlayBox);
}
function hideOverlay() { overlay.hidden = true; overlayBox.innerHTML = ''; }

function askConfirm(title, message, { danger = true } = {}) {
  return new Promise((resolve) => {
    showOverlay(
      `<h3>${escapeHtml(title)}</h3><div>${escapeHtml(message)}</div>
       <div class="row"><button data-x="no">不要</button><button data-x="yes" class="${danger ? 'danger' : 'ok'}">让她做</button></div>`,
      (box) => {
        box.querySelector('[data-x="no"]').onclick = () => { hideOverlay(); resolve(false); };
        box.querySelector('[data-x="yes"]').onclick = () => { hideOverlay(); resolve(true); };
      },
    );
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ────────────────────────────────────────── 网络 ──────────────────────────
let pingPending=null;
window.HerConnection?.install({blocked:()=>document.hidden||state.busy||recording||state.speaking||!!input.value.trim()||document.activeElement?.tagName==='INPUT',recover:()=>NATIVE?call('recover'):Promise.resolve(),recheck:()=>void ping()});
async function ping() {
  if(pingPending)return pingPending;
  pingPending=checkConnection();
  try{return await pingPending;}finally{pingPending=null;}
}
async function checkConnection(){
  try {
    const r = await fetch('/api/ping', { cache: 'no-store',signal:AbortSignal.timeout(10000) });
    const j = await r.json();
    state.serverOk = r.ok&&j.ok===true&&j.name==='phone-brain';
    if(state.serverOk)window.HerStartup?.mark('connectionReadyAt');
    void window.HerConnection?.observe(state.serverOk,{unauthorized:r.status===401||r.status===403});
    if (j.voice) state.voiceMode = j.voice;
    state.voiceEngine=j.voiceEngine;state.voiceLabel=j.voiceLabel;
    dot.className = 'dot ' + (state.serverOk ? 'on' : 'off');
    if (state.serverOk) learnTunnel();
    return state.serverOk;
  } catch {
    state.serverOk = false;
    void window.HerConnection?.observe(false);
    dot.className = 'dot off';
    return false;
  }
}

/**
 * 把"在外面用的地址"（电脑那边的公网隧道）交给 App 存成备用地址。
 * 这样在家连上过一次，出门 App 自己会切过去，不用手抄地址。
 * 隧道地址变了也没关系：每次连上都学一遍。
 */
async function learnTunnel() {
  try {
    const j = await (await fetch('/api/tunnel', { cache: 'no-store' })).json();
    if (j?.ok && j.urlWithToken && typeof call === 'function') {
      call('setAlt', { url: j.urlWithToken }).catch(() => {});
      if(Array.isArray(j.urlsWithToken))call('setFallbacks',{urls:j.urlsWithToken}).catch(()=>{});
      if(j.stableUrlWithToken)call('setStable',{url:j.stableUrlWithToken}).catch(()=>{});
    }
  } catch { /* 老版本服务端没有这个接口，无所谓 */ }
}

async function turn(payload,sessionId=state.sessionId) {
  const r = await fetch('/api/turn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, ...payload }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'server error');
  if (j.character) window.HerPresence?.apply(j.character, true);
  return j;
}

function needsConfirm(c) { return window.HerActions.check(c); }

async function runToolCall(c) {
  c=window.HerActions.prepare(c);
  if(c.name==='phone_memory_search')return {id:c.id,content:JSON.stringify(await(await fetch('/api/memory/search?'+new URLSearchParams(c.args||{}))).json())};
  if(c.name==='phone_message_hub'){
    try{return {id:c.id,content:JSON.stringify(await(await fetch('/api/hub/ai')).json())};}catch{return {id:c.id,content:'{"ok":false}'};}
  }
  if(['phone_qq_desktop','phone_wechat_desktop'].includes(c.name)){
    try{const query=new URLSearchParams(c.args||{});query.set('forAi','1');const response=await fetch((c.name==='phone_wechat_desktop'?'/api/desktop-wechat/messages?':'/api/desktop-qq/messages?')+query);return {id:c.id,content:JSON.stringify(await response.json())};}
    catch{return {id:c.id,content:JSON.stringify({ok:false,error:'主号收件箱暂不可用'})};}
  }
  if (c.name === 'phone_character') {
    try {
      const character = await window.HerPresence.choose({ ...(c.args || {}), source: 'tool' });
      return { id: c.id, content: JSON.stringify(character) };
    } catch (e) { return { id: c.id, content: JSON.stringify({ ok: false, error: e.message }) }; }
  }
  const why = needsConfirm(c);
  if (why) return {id:c.id,content:JSON.stringify({ok:false,blocked:true,error:why})};
  try {
    // Shizuku（ADB 级）：走原生 shizuku 通道，不经过无障碍
    if (c.name === 'phone_shell') {
      const r = await call('shizuku', { action: 'run', command: String(c.args?.command ?? '') });
      return {
        id: c.id,
        content: JSON.stringify({
          ok: r?.ok === true,
          code: r?.code ?? null,
          out: String(r?.out ?? r?.error ?? '').slice(0, 3000),
        }),
      };
    }
    const res = await call('tool', { name: c.name, args: c.args ?? {} });
    if(c.name==='phone_bilibili')await fetch('/api/media',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:state.sessionId,args:c.args,result:res})}).catch(()=>{});
    return { id: c.id, content: JSON.stringify(res ?? { ok: true }) };
  } catch (e) {
    return { id: c.id, content: JSON.stringify({ ok: false, error: String(e.message || e) }) };
  }
}

// ── 说话 ──
// hers = 克隆音色的流式快 TTS
// system = 手机系统 TTS（即时，但不是她的声音）
// off = 不出声

/* ── 真·口型同步（2026-10-18）────────────────────────────────────────
 * 原来是"在播就张嘴、按正弦波开合"——看着像在念台词，和声音对不上。
 * 现在接 Web Audio 的 AnalyserNode，直接拿**正在播的那段音频的振幅**驱动
 * ParamMouthOpenY：声音大嘴就大，句尾气声也跟得上。
 * （Live2D 官方文档给的正是这个做法：实时取播放音量 0~1 喂给嘴型参数。）
 */
let voiceCtx = null;
let voiceAnalyser = null;
let voiceGain = null;   // 淡入淡出用（结尾那一下"电音/爆音"就是这里压掉的）
let voiceFreq = null;

function ensureVoiceGraph(audioEl) {
  try {
    if (!voiceCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      voiceCtx = new AC();
      voiceAnalyser = voiceCtx.createAnalyser();
      voiceAnalyser.fftSize = 512;
      voiceAnalyser.smoothingTimeConstant = 0.55;
      voiceFreq = new Uint8Array(voiceAnalyser.frequencyBinCount);
    }
    if (voiceCtx.state === 'suspended') voiceCtx.resume().catch(() => {});
    if (!voiceGain) {
      voiceGain = voiceCtx.createGain();
      voiceGain.gain.value = 1;
      voiceAnalyser.connect(voiceGain);
      voiceGain.connect(voiceCtx.destination);       // 还得让人听见
    }
    if (!audioEl.__amadeusSrc) {
      const src = voiceCtx.createMediaElementSource(audioEl);
      src.connect(voiceAnalyser);
      audioEl.__amadeusSrc = src;
    }
    return true;
  } catch (e) {
    console.warn('口型：建音频图失败（退回正弦波）', e);
    return false;
  }
}

/** 当前播放音量 → 0~1。人声能量集中在中低频，只统计前 40% 的频段。 */
function voiceLevel() {
  if (!voiceAnalyser) return 0;
  voiceAnalyser.getByteFrequencyData(voiceFreq);
  const n = Math.floor(voiceFreq.length * 0.4);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += voiceFreq[i];
  return Math.min(1, (sum / Math.max(1, n)) / 130);
}

/* ── 打断（barge-in，2026-10-18）─────────────────────────────────────
 * 她话说到一半你开口/按麦克风 → 立刻闭嘴，不要让你等她念完。
 * 两个细节：
 *   1) voiceGen 是"这一代声音"的编号：打断就 +1，老的播放/轮询任务看到编号变了
 *      会自己退出（不然一句 40 秒的合成回来还会突然响起来）。
 *   2) 原生 TTS（系统嗓子）也要停，所以 system 模式下调 stopTts。
 */
let currentAudio = null;
let voiceGen = 0;
const speechStreams = new Set();
/** 当前这段音频的"收尾"函数。⚠️ 打断时必须调它，否则 playUrl 的 Promise 永远不 resolve，
 *  串行播放队列就卡死（表现为"突然没声了"，而且一卡就是 2 分钟到超时）。
 *  2026-10-20 实测踩到：pause() 不会触发 ended。 */
let currentAudioFinish = null;

function shutUp() {
  voiceGen += 1;
  for(const stream of speechStreams)stream.dispose();
  speechStreams.clear();
  speechPlayer.cancel();speechQueue=Promise.resolve();
  const a = currentAudio;
  const finish = currentAudioFinish;
  currentAudio = null;
  currentAudioFinish = null;
  try {
    if (voiceGain && voiceCtx) {
      const t = voiceCtx.currentTime;
      voiceGain.gain.cancelScheduledValues(t);
      voiceGain.gain.setValueAtTime(voiceGain.gain.value, t);
      voiceGain.gain.linearRampToValueAtTime(0.0001, t + 0.05);
    }
  } catch (e) { }
  if (a) { try { a.pause(); a.currentTime = 0; } catch {} }
  if (finish) { try { finish(false); } catch {} }
  state.playingAudio = false;
  setSpeaking(false);
  // 不管是她的嗓子还是回退到系统 TTS，都把原生那条也停掉（没在说时调用无害）
  try { call('stopTts').catch(() => {}); } catch {}
}

/**
 * 播一段音频（本地文件或**流式地址**都行 —— <audio> 自己会边下边播）。
 * resolve(true) = 正常播完；resolve(false) = 没播出来（调用方据此回退原生 TTS）。
 */
function playUrl(url, gen = voiceGen, offset=0, source=null, signal=null) {
  return new Promise((resolve) => {
    if (gen !== voiceGen) { resolve(false); return; }   // 已经被打断了，这条别播
    const a = new Audio(url);
    currentAudio = a;
    let done = false;
    let failed = false;
    let startup,stall;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(startup);
      clearTimeout(stall);
      if(!ok){try{a.pause();}catch{}}
      a.onplaying=a.onended=a.onerror=a.ontimeupdate=a.onloadedmetadata=null;
      if (currentAudio === a) currentAudio = null;
      if (currentAudioFinish === finish) currentAudioFinish = null;
      state.playingAudio = false;
      setSpeaking(false);
      signal?.removeEventListener('abort',cancel);
      resolve({ok:ok&&!failed,position:Math.max(0,a.currentTime||offset)});
    };
    const cancel=()=>finish(false);signal?.addEventListener('abort',cancel,{once:true});
    currentAudioFinish = finish;          // 让 shutUp() 能把它解开（见上面的注释）
    const hasGraph = ensureVoiceGraph(a);
    startup=setTimeout(()=>{if(a.paused||a.readyState<2){try{a.pause();}catch{} finish(false);}},4500);
    let fadedIn=false;
    a.onloadedmetadata=()=>{if(offset>0&&Number.isFinite(a.duration))a.currentTime=Math.max(0,Math.min(offset-.15,a.duration-.05));};
    a.onplaying = () => {
      clearTimeout(startup);
      if (currentAudio !== a) { try { a.pause(); } catch {} ; return; }   // 播之前就被打断了
      // A growing MSE duration is only the buffered prefix. Never schedule a
      // fade-out against it, or the rest of the sentence becomes silent.
      try {
        if (!fadedIn&&voiceGain && voiceCtx) {
          fadedIn=true;
          const t = voiceCtx.currentTime;
          const g = voiceGain.gain;
          g.cancelScheduledValues(t);
          g.setValueAtTime(0.0001, t);
          g.linearRampToValueAtTime(1, t + 0.02);
        }
      } catch (e) { }
      state.playingAudio = hasGraph;
      setSpeaking(true);
    };
    a.onended = async() => finish(!source||await source.completed);
    a.onerror = () => { failed = true; finish(false); };
    const watchStall=()=>{clearTimeout(stall);stall=setTimeout(()=>finish(false),15000);};
    a.ontimeupdate=watchStall;
    watchStall();
    a.play().catch(() => { failed = true; finish(false); });
  });
}

/**
 * 走她的嗓子。⚠️ 合成要 25~80 秒，公网隧道会掐长请求，
 * 所以是「提交 → 轮询状态 → 播」。没成就退回系统 TTS。
 */
async function speakHers(text) {
  const gen = voiceGen;                     // 记住我是哪一代的；被打断就别出声了
  if (gen !== voiceGen) return;
  try {
    const r = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    let j = await r.json();
    if (!j.ok) throw new Error(j.error || 'tts failed');
    if (gen !== voiceGen) return;           // 合成回来时早被打断了
    if (j.cached && j.url) { await playUrl(j.url, gen); return; }

    const key = j.key;
    if (!key) throw new Error('没拿到 key');
    for (let i = 0; i < 60; i++) {           // 最多等 120 秒
      await new Promise((res) => setTimeout(res, 2000));
      if (gen !== voiceGen) return;         // 等合成的时候被打断，直接收工
      try {
        const s = await (await fetch('/api/tts-status?key=' + key)).json();
        if (s.ready && s.url) { await playUrl(s.url, gen); return; }
        if (s.error) throw new Error(s.error);
      } catch (e) { /* 单次轮询失败不算）*/ }
    }
    throw new Error('合成超时');
  } catch (e) {
    if (gen !== voiceGen) return;
    console.warn('本音这次未能合成，文字已保留。');
  }
}

function speak(text) {
  if (!text) return;
  const mode = state.voiceMode || 'system';
  if (mode === 'off') return;
  if (mode === 'system') { call('tts', { text }).catch(() => {}); return; }
  speakSentence(text);
}

/* At most one sentence ahead; failures stay at the current sentence. */
let speechQueue = Promise.resolve();
const speechNotice=window.HerSpeech.notice(()=>{speechQueue=speechPlayer.resume();});
const speechPlayer=window.HerSpeech.create({split:window.HerSpeechText.split,
  open:(text,options)=>window.HerAudio.open('/api/tts-stream?text='+encodeURIComponent(text),options),
  play:(stream,{offset,signal})=>playUrl(stream.url,voiceGen,offset,stream,signal),onState:speechNotice});
function speakSentence(text) {
  if (!text || state.voiceMode==='off') return;
  if(state.voiceMode==='system'){speechQueue=speechQueue.then(()=>call('tts',{text})).catch(()=>{});return;}
  speechQueue=speechPlayer.enqueue(text);
}

/** 流式对话：你说话 → 文字边出边显示，句子一到就念，首声延迟压到 1 秒级。 */
async function submitStream(text, { fromVoice = true } = {}) {
  if (!text || state.busy) return;
  if (!state.serverOk && !(await ping())) {
    setBubble('连不上电脑那边的我…检查一下 Wi-Fi / 服务开着没', { sticky: true });
    return;
  }
  state.busy = true;
  dot.className = 'dot busy';
  shutUp();                       // 上一句还没念完就先停
  addLog('user', text);
  setBubble('…', { thinking: true, sticky: true });

  let full = '';
  try {
    const r = await fetch('/api/turn-stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, text }),
    });
    if (!r.ok || !r.body) throw new Error('stream ' + r.status);
    await window.HerSpeechText.readLines(r,line=>{
        const s = line.trim();
        if (!s) return;
        let j = null;
        try { j = JSON.parse(s); } catch { return; }
        if (j.type === 'delta') {
          full += j.text;
          setBubble(full, { thinking: true, sticky: true });
        } else if (j.type === 'sentence') {
          speakSentence(j.text);          // 一句一到就念，不等整段
        } else if (j.type === 'done') {
          if (j.character) window.HerPresence?.apply(j.character, true);
          if (j.text) full = j.text;
        } else if (j.type === 'error') {
          throw new Error(j.error || 'stream error');
        }
    });
    if (full) { addLog('her', full); setBubble(full); }
  } catch (e) {
    setBubble('出错了：' + (e.message || e), { sticky: true });
    addLog('sys', '错误：' + (e.message || e));
  } finally {
    state.busy = false;
    dot.className = 'dot ' + (state.serverOk ? 'on' : 'off');
    if (!fromVoice) input.value = '';
  }
}

// ────────────────────────────────────────── 主流程 ────────────────────────
async function submit(text, { fromVoice = false } = {}) {
  if (!text || state.busy) return;
  if (!state.serverOk && !(await ping())) {
    setBubble('连不上电脑那边的我…检查一下 Wi-Fi / 服务开着没', { sticky: true });
    return;
  }

  state.busy = true;
  const performanceId=window.HerPresence?.beginAction(text)||'';
  dot.className = 'dot busy';
  shutUp();   // 同时取消尚未开始播放的合成
  addLog('user', text);
  setBubble('…', { thinking: true, sticky: true });

  try {
    window.HerActions.begin(text);
    const sessionId=state.sessionId;
    let payload = { text,performanceId };
    let guard = 0;

    while (guard++ < 8) {
      const res = await turn(payload,sessionId);
      if (res.text) {
        addLog('her', res.text);
        setBubble(res.text);
        speak(res.text);
      }

      if (res.type !== 'tool' || !res.toolCalls?.length) break;

      // 干活时提示一下
      setBubble(res.text || '（在弄…）', { thinking: true, sticky: true });
      const results = [];
      for (const c of res.toolCalls) {
        addLog('sys', '动手：' + describeTool(c));
        results.push(await runToolCall(c));
      }
      payload = { toolResults: results,toolBatchId:res.toolBatchId };
    }
  } catch (e) {
    setBubble('出错了：' + (e.message || e), { sticky: true });
    addLog('sys', '错误：' + (e.message || e));
  } finally {
    window.HerPresence?.endAction(performanceId);
    state.busy = false;
    dot.className = 'dot ' + (state.serverOk ? 'on' : 'off');
    if (!fromVoice) input.value = '';
  }
}

function describeTool(c) {
  const a = c.args || {};
  switch (c.name) {
    case 'phone_open_app': return `打开「${a.app}」`;
    case 'phone_tap_text': return `点「${a.text}」`;
    case 'phone_tap_xy': return `点坐标 (${a.x}, ${a.y})`;
    case 'phone_swipe': return `滑动 ${a.direction}`;
    case 'phone_type': return `输入「${a.text}」`;
    case 'phone_screen': return '看一眼屏幕';
    case 'phone_back': return '返回';
    case 'phone_home': return '回桌面';
    case 'phone_notifications': return '看通知';
    case 'phone_open_settings': return `打开设置·${a.panel}`;
    case 'phone_list_apps': return '看应用列表';
    case 'phone_shell': return `执行 shell：${a.command ?? ''}`;
    default: return c.name;
  }
}

// ────────────────────────────────────────── 事件 ──────────────────────────
btnSend.onclick = () => { const t = input.value.trim(); if (t) submit(t); };
let inputComposing=false,inputComposedAt=-Infinity;
input.addEventListener('compositionstart',()=>{inputComposing=true;});
input.addEventListener('compositionend',()=>{inputComposing=false;inputComposedAt=performance.now();});
input.addEventListener('keydown', (e) => {
  if(e.isComposing||inputComposing||e.keyCode===229||performance.now()-inputComposedAt<60)return;
  if (e.key === 'Enter') { const t = input.value.trim(); if (t) submit(t); }
});

/* 麦克风（2026-10-20 重做）：不再依赖系统语音识别 —— 那套在 WebView 里返回空。
 * 流程：getUserMedia 录音 → 检测到你说完（静音 1.2s）或满 15s 自动停
 *      → POST /api/asr（电脑转写）→ 有字就直接走流式对话。
 * 好处：跟手机 ROM 无关，识别质量用电电脑那边的云端 ASR。
 */
let recording = false;
let recCtx = null;

// 连续对话（2026-10-21）：语音说完一句、她答完，自动再听 —— 直到没声音/说拜拜/连续 8 轮。
// 和浮窗共用同一个开关（同源 localStorage）。
const CONT_KEY = 'amadeus.continuous';
let continuous = localStorage.getItem(CONT_KEY) !== '0';
let contRounds = 0;
const CONT_MAX = 8;
const EXIT_RE = /^(拜拜|再见|拜|不聊了|先这样|没事了|停|睡吧|结束|退下)/;

/* 原生录音路径（http 页面下 getUserMedia 不可用时的唯一办法）：
 * recStart → 再点一次 recStop → base64 拿到音频 → POST /api/asr → 走流式对话。 */
let nativeRec = false;
let nativeRecTimer = null;
async function nativeRecTap() {
  if (!nativeRec) {
    nativeRec = true;
    btnMic.classList.add('rec');
    setBubble('（说着，说完停一下我就发）', { thinking: true, sticky: true });
    try {
      await call('recStart');
      clearTimeout(nativeRecTimer);
      // 原生 VAD 会自己停（安静 1.2 秒 / 最长 20 秒），这只是兜底
      nativeRecTimer = setTimeout(() => { if (nativeRec) nativeRecTap(); }, 25000);
    } catch (e) {
      nativeRec = false; btnMic.classList.remove('rec');
      setBubble('录音打不开：' + (e.message || e));
    }
    return;
  }
  nativeRec = false;
  btnMic.classList.remove('rec');
  clearTimeout(nativeRecTimer);
  setBubble('（在听写…）', { thinking: true, sticky: true });
  try {
    const r = await call('recStop');
    await finishNativeRec(r);
  } catch (e) {
    setBubble('转写失败：' + (e.message || e));
  }
}

/** 拿到录音结果（手动停或原生自动停都一样）→ 转写 → 走对话。 */
async function finishNativeRec(r) {
  if (!r || !r.ok) { setBubble('没录到声音…再说一遍？'); return; }
  const bin = atob(r.data || '');
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const blob = new Blob([arr], { type: r.mime || 'audio/mp4' });
  const res = await fetch('/api/asr', {
    method: 'POST',
    headers: { 'content-type': blob.type || 'audio/mp4' },
    body: blob,
    signal: AbortSignal.timeout(70000),
  });
  const j = await res.json();
  const text = String(j.text || '').trim();
  if (!text) {
    contRounds = 0;
    setBubble('没听到声音，那我先待着');
    return;
  }
  if (EXIT_RE.test(text)) {
    contRounds = 0;
    setBubble('好，先这样');
    return;
  }
  input.value = text;
  await (window.HerActions.isAction(text)?submit(text,{fromVoice:true}):submitStream(text,{fromVoice:true}));
  await maybeContinue();
}

/** 等她把话念完，再等半秒（别录到自己的尾音），然后自动开录下一轮。 */
async function maybeContinue() {
  if (!continuous) { contRounds = 0; return; }
  if (contRounds >= CONT_MAX) {
    contRounds = 0;
    setBubble('先聊到这儿，按话筒或者叫我都行');
    return;
  }
  contRounds += 1;
  try { await speechQueue; } catch {}
  if(speechPlayer.status==='paused')return;
  await new Promise((r) => setTimeout(r, 420));
  if (!continuous) return;
  if (nativeRec || state.busy) return;
  await nativeRecTap();
}

// 左上角菜单（以前只能长按/双击形象才能进设置）
if (btnMenu) btnMenu.onclick = (ev) => { ev.stopPropagation(); openMenu(); };

btnMic.onclick = async () => {
  shutUp();
  // ★ 2026-10-26 根治「麦克风打不开：Could not start audio source」：
  //   WebView 的 getUserMedia 在这台小米上起不来（麦克风被系统/唤醒词占住时必现），
  //   而**原生 Recorder 那条路是好的**（recStart 自带 WakeWord.pauseAll + 原生 VAD 自动停）。
  //   所以只要在 App 里（有原生桥），就一律走原生录音，不再碰 getUserMedia。
  if (NATIVE) { await nativeRecTap(); return; }
  // 非安全来源（http://192.168.x.x）拿不到麦克风 → 走原生录音
  if (typeof navigator.mediaDevices === 'undefined' || !navigator.mediaDevices) { await nativeRecTap(); return; }
  if (recording) return;          // 正在录就忽略（用静音自动停）
  recording = true;
  btnMic.classList.add('rec');
  setBubble('（听着呢，说完停一下）', { thinking: true, sticky: true });
  // ★ 2026-10-26 修「麦克风打不开」：唤醒词（Vosk）在后台**一直占着麦克风**，
  //   getUserMedia 再去要就会 NotReadableError。原生录音那条路（recStart）里有
  //   WakeWord.pauseAll()，网页这条路没有 —— 现在补上：录之前先让她别听，录完再恢复。
  try { await call('wakePause'); } catch { }
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

    // 静音检测：说话后连续 1.2s 没声音就停录音
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    recCtx = ac;
    const src = ac.createMediaStreamSource(stream);
    const an = ac.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    let spoke = false;
    let quietSince = 0;
    const t0 = Date.now();
    const timer = setInterval(() => {
      an.getByteFrequencyData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i];
      const level = sum / buf.length;
      if (level > 12) { spoke = true; quietSince = 0; }
      else if (spoke && !quietSince) quietSince = Date.now();
      const quiet = quietSince ? Date.now() - quietSince : 0;
      if ((spoke && quiet > 1200) || Date.now() - t0 > 15000) {
        clearInterval(timer);
        try { mr.stop(); } catch {}
      }
    }, 100);

    mr.onstop = async () => {
      clearInterval(timer);
      try { ac.close(); } catch {}
      recCtx = null;
      stream.getTracks().forEach((t) => t.stop());
      btnMic.classList.remove('rec');
      recording = false;
      try { call('wakeResume'); } catch { }   // 录完了，把唤醒词放回去（2026-10-26）
      const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
      if (blob.size < 2500) { setBubble('没录到声音…再说一遍？'); return; }
      setBubble('（在听写…）', { thinking: true, sticky: true });
      try {
        const r = await fetch('/api/asr', {
          method: 'POST',
          headers: { 'content-type': blob.type || 'audio/webm' },
          body: blob,
        });
        const j = await r.json();
        const text = String(j.text || '').trim();
        if (!text) { setBubble('没听清…再说一遍？'); return; }
        input.value = text;
        await (window.HerActions.isAction(text)?submit(text,{fromVoice:true}):submitStream(text,{fromVoice:true}));
      } catch (e) {
        setBubble('转写失败：' + (e.message || e));
      }
    };
    mr.start();
  } catch (e) {
    recording = false;
    btnMic.classList.remove('rec');
    try { stream && stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { call('wakeResume'); } catch { }   // 失败了也要把麦克风还给唤醒词
    setBubble('麦克风打不开：' + (e.message || e));
  }
};

btnLog.onclick = () => { if(log.hidden)window.HerHistory.open();else window.HerHistory.close(); };
log.addEventListener('click', (event) => {
  // 点记录里的空白处关掉；点消息不关
  if (event.target === log) log.hidden = true;
});

// Settings live in the visible menu; long presses belong to body rubbing.
window.HerPresence?.configure({
  onContact:()=>{if(!state.busy)shutUp();},
  context: () => ({ busy: state.busy || nativeRec, speaking: state.speaking || !!state.playingAudio }),
  onReaction: (text, reaction) => {
    setBubble(text); addLog('her', text);
    if (reaction.ai && state.serverOk) speak(text);
  },
});

/**
 * 「听手机里的声音」（2026-10-22）：打开后她会一直录应用内的声音（视频/网课/语音消息），
 * 每 12 秒传一段去转写，攒成滚动字幕；问"刚才说了什么"她读字幕回答。
 * 第一次打开会弹系统的"开始录制/投放"授权框（选"共享整个屏幕"）。
 */
const KEEP_KEY = 'amadeus.keepAlive';
let keepAlive = localStorage.getItem(KEEP_KEY) !== '0';   // 默认开

const HEAR_KEY = 'amadeus.hearing';
let hearing = localStorage.getItem(HEAR_KEY) === '1';

async function setHearing(on) {
  try {
    await call('capListen', { on, chunk: 12 });
    hearing = on;
    localStorage.setItem(HEAR_KEY, on ? '1' : '0');
    setBubble(on ? '开始听了，放在后台就行（她只转文字，不会录音给你看）' : '不听了');
    if (on) setTimeout(() => setBubble('第一次要你点一下系统弹框里的「共享整个屏幕」'), 1200);
  } catch (e) {
    setBubble('开不了：「' + ((e && e.message) || e) + '」');
  }
}

/**
 * 消息清单卡片（2026-10-22）：她每小时扫出来的"谁找过我"，
 * 在界面里画成一张清单（不是气泡），点右上角 × 关掉。
 */
window.__showDigest = function (payload) {
  try {
    const items = (payload && payload.items) || [];
    if (!items.length) return;
    let box = document.getElementById('digestCard');
    if (!box) {
      box = document.createElement('div');
      box.id = 'digestCard';
      document.body.appendChild(box);
    }
    const rows = items.slice(0, 12).map((it) => {
      const app = String(it.app || '');
      const who = String(it.who || '').slice(0, 20);
      const detail = String(it.detail || it.text || '').replace(/\s*\|\s*/g, ' · ').slice(0, 42);
      const badge = app.indexOf('微信') >= 0 ? '#07c160' : '#12b7f5';
      return `<div class="dRow" data-app="${app}" data-who="${who.replace(/"/g, '')}">`
        + `<span class="dTag" style="background:${badge}">${app}</span>`
        + `<b>${who}</b><span class="dTxt">${detail}</span></div>`;
    }).join('');
    box.innerHTML = `<div class="dHead"><span>这一小时谁找过我</span>`
      + `<button id="digestClose">×</button></div><div class="dList">${rows}</div>`;
    box.classList.add('show');
    box.querySelectorAll('.dRow').forEach((row) => {
      row.onclick = () => {
        const app = row.getAttribute('data-app') || '微信';
        const who = row.getAttribute('data-who') || '';
        if (!who) return;
        try { call('openChat', { app, who }); } catch (e) { }
        box.classList.remove('show');
      };
    });
    const close = document.getElementById('digestClose');
    if (close) close.onclick = () => box.classList.remove('show');
    setTimeout(() => { try { box.classList.remove('show'); } catch (e) { } }, 60000);
    if (typeof state !== 'undefined') state.digestSeen = Date.now();
  } catch (e) { }
};

/**
 * 「她看到的」消息板块（2026-10-22）。
 * 设计参考（GitHub 上的同类项目）：
 *   · Novu 的 Inbox：未读筛选 + 分组 + 搜索
 *   · elie222/inbox-zero：按"要不要回"分类
 *   · Alfio010/notification-listener-android：按 App 分组、带时间轴
 * 我们的版本：来源筛选（全部/微信/QQ）+ 按小时分组 + 点一下跳到那个会话。
 */
/**
 * 分页：聊天 / 她看到的（2026-10-22 主人要求"看消息的那个功能放分页实现"）。
 */
let inboxFilter = 'all';
let inboxLoadedAt = 0;

/**
 * 会话名字清洗（2026-10-23）。
 * 微信的行是「名字 | 预览 | 时间」；QQ 的行却来自一行 contentDescription：
 *   「女仆, ,还有骑车那事…,20:30, 消息免打扰」
 * 直接拿整串去 openChat 是**永远找不到会话**的，手机会一直退出去再拉起来
 * （主人说的"点了反复跳"）。所以只取第一段当名字。
 */
function cleanWho(who) {
  let s = String(who || '').trim();
  if (!s) return s;
  s = s.split('|')[0].trim();
  if (/,\s/.test(s)) {
    const segs = s.split(/,\s*/).map((x) => x.trim()).filter(Boolean);
    const name = segs.find((x) => x !== '消息免打扰'
      && !/^\d{1,2}:\d{2}/.test(x) && !/^\d+\s*条未读/.test(x));
    if (name) s = name;
  }
  s = s.replace(/\s*\d+\s*条未读/g, '')
    .replace(/\d{1,2}:\d{2}/g, '')
    .replace(/消息免打扰/g, '')
    .replace(/^[\s,|·]+|[\s,|·]+$/g, '')
    .trim();
  return s;
}

function switchPage(page) {
  if (!['chat','inbox','space'].includes(page)) page='chat';
  const inboxPage = document.getElementById('inboxPage');
  const spacePage = document.getElementById('spacePage');
  const stage = document.getElementById('stage');
  const bar = document.getElementById('bar');
  const tabs = document.querySelectorAll('#tabs button');
  const isInbox = page === 'inbox';
  document.body.dataset.page=page;
  window.dispatchEvent(new CustomEvent('her:page',{detail:{page}}));
  if (inboxPage) inboxPage.hidden = !isInbox;
  if (spacePage) spacePage.hidden = page !== 'space';
  if (stage) stage.hidden = page !== 'chat';
  if (bar) bar.hidden = page !== 'chat';
  if (page !== 'chat') log.hidden = true;
  if (a11yBar) a11yBar.hidden = !NATIVE || page !== 'chat' || state.a11y === true;
  tabs.forEach((b) => {const selected=b.getAttribute('data-page') === page;b.classList.toggle('on',selected);if(selected)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  if (isInbox) void renderInbox();
  if (page === 'space') void renderSpace();
  // 记住上一次的分页，重开还停在那儿
  try { localStorage.setItem('amadeus.page', page); } catch (e) { }
}

async function renderInbox(force) {
  window.HerHub?.configure({
    reply:text=>{if(state.busy)return false;switchPage('chat');void submit(text);return true;},
    media:async action=>{switchPage('chat');await submit(action==='pause'?'暂停刚才打开的B站视频':'把刚才打开的B站视频全屏播放');},
  });
  await window.HerHub?.render(!!force);
}

function wireInboxPage() {
  document.querySelectorAll('#tabs button').forEach((b) => {
    b.onclick = () => switchPage(b.getAttribute('data-page'));
  });
  document.querySelectorAll('#inboxPage .ibChips button[data-f]').forEach((b) => {
    b.onclick = () => {
      inboxFilter = b.getAttribute('data-f');
      document.querySelectorAll('#inboxPage .ibChips button[data-f]')
        .forEach((x) => x.classList.toggle('on', x === b));
      inboxLoadedAt = 0;
      void renderInbox(true);
    };
  });
  const reload = document.querySelector('#inboxPage [data-x="reload"]');
  if (reload) reload.onclick = () => void renderInbox(true);
  try {
    const saved = localStorage.getItem('amadeus.page');
    if (saved === 'inbox' || saved === 'space') switchPage(saved);
  } catch (e) { }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireInboxPage);
else wireInboxPage();

function openMenu() { switchPage('space'); }

let spaceRefresh = 0;
async function renderSpace() {
  const generation=++spaceRefresh;
  for(const [action,value] of [['cont',continuous],['hear',hearing],['keep',keepAlive]]){
    document.querySelector(`[data-space="${action}"]`).setAttribute('aria-pressed',String(!!value));
  }
  const [info,fl,memory]=await Promise.all([
    call('info').catch(()=>({})),
    call('floatStatus').catch(()=>({running:false,canDraw:false})),
    fetch('/api/memory/status',{signal:AbortSignal.timeout(6000)}).then(r=>r.json()).catch(()=>({})),
  ]);
  if(generation!==spaceRefresh)return;
  const text=(id,value)=>{document.getElementById(id).textContent=value;};
  text('spaceBrain',state.serverOk?'已连接':'连接中断');
  text('spaceControl',NATIVE?(info.accessibility?'已连接':'待开启'):'手机端可用');
  text('spaceNotifications',NATIVE?(info.notification?'已连接':'待开启'):'手机端可用');
  text('spaceFloat',fl.running?'已开启':fl.canDraw?'打开':'前往开启');
  text('spaceVoice',state.voiceMode==='hers'?(state.voiceLabel||'她的声音'):({system:'系统语音',off:'静音'})[state.voiceMode]||'随系统');
  text('spaceMemory',memory.enabled?(memory.qqReadable?'已互通':'等待QQ来源'):'已关闭');
  text('spaceMemoryHint',memory.lastQqMessageAt?'QQ最近 '+window.HerCalendar.format(memory.lastQqMessageAt)+' · '+(memory.archiveDays||0)+'天对话已存档':'手机对话按天保存，QQ长期日记与对话按需读取');
  text('spaceAcc',info.accessibility?'已开启':'前往开启');
  text('spaceNoti',info.notification?'已开启':'前往开启');
  let connection='管理她与电脑的连接';
  try {const u=new URL(info.serverUrl||location.href);connection=u.protocol==='https:'?'正在使用远程连接':'正在使用本地连接';}catch{}
  text('spaceConnectionHint',connection);
  for(const id of ['spaceBrain','spaceControl','spaceNotifications']){
    document.getElementById(id).classList.toggle('needs-attention',/中断|待开启/.test(document.getElementById(id).textContent));
  }
  for(const button of document.querySelectorAll('[data-space]'))button.onclick=async()=>{
    const action=button.dataset.space;
    if(!NATIVE&&['float','hear','keep','wake','srv','acc','noti'].includes(action)){
      text('spaceFeedback','请在手机应用里使用这个功能。');return;
    }
    button.disabled=true;
    try{
      if(action==='float'){
        if(fl.running)await call('floatOff');else await call('floatOn');
        text('spaceFeedback',fl.running?'悬浮陪伴已关闭。':'悬浮陪伴已打开，切到其他应用就能看见她。');
      }else if(action==='cont'){
        continuous=!continuous;contRounds=0;localStorage.setItem(CONT_KEY,continuous?'1':'0');
        text('spaceFeedback',continuous?'说完后，她会继续听你说。':'连续对话已关闭。');
      }else if(action==='hear'){
        await setHearing(!hearing);text('spaceFeedback',hearing?'正在听手机里的声音。':'已停止听手机里的声音。');
      }else if(action==='keep'){
        const next=!keepAlive;await call('keepAlive',{on:next});keepAlive=next;localStorage.setItem(KEEP_KEY,next?'1':'0');
        text('spaceFeedback',next?'后台陪伴已开启。':'后台陪伴已关闭。');
      }else if(action==='appearance')window.HerAppearance?.open();
      else if(action==='history'){switchPage('chat');btnLog.click();}
      else if(action==='wake')await openWakeDiag();
      else if(action==='srv')await askServer();
      else if(action==='acc')await call('openSettings',{panel:'accessibility'});
      else if(action==='noti')await call('requestNotificationAccess');
      else if(action==='inbox')switchPage('inbox');
      else if(action==='reset'){
        if(!await askConfirm('开始新一段对话','会重置当前聊天上下文，已有对话记录会继续保存。'))return;
        const response=await fetch('/api/reset',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:state.sessionId})});
        if(!response.ok)throw new Error('暂时没有清空成功，请稍后再试');
        void window.HerHistory.refresh();hideOverlay();text('spaceFeedback','已开始新一段，旧记录已保留。');
      }
      if(document.body.dataset.page==='space')await renderSpace();
    }catch(error){text('spaceFeedback',String(error.message||error));}
    finally{button.disabled=false;}
  };
}

/**
 * 唤醒词诊断（2026-10-21）：她最近听到了什么、叫醒了几次、灵敏度三档。
 * 调不醒/老误唤醒的时候，先看这里 —— "听到"里没有接近"大肥鱼"的音，就是模型没听清；
 * 有却叫不醒，就是匹配规则的事（换灵敏度）。
 */
async function openWakeDiag() {
  let st = { sens: 1, wakes: 0, heard: [] };
  try { st = (await call('wakeStats')) || st; } catch (e) { }
  const heard = Array.isArray(st.heard) ? st.heard.slice().reverse() : [];
  const rows = heard.length
    ? heard.map((h) => `<div class="hint" style="margin:4px 0">${escapeHtml(String(h))}</div>`).join('')
    : '<div class="hint">（还没听到过什么 —— 先开着浮窗说两句话）</div>';
  const btn = (n, label) => `<button data-s="${n}" class="${Number(st.sens) === n ? 'ok' : ''}">${label}</button>`;
  showOverlay(
    `<h3>唤醒词诊断</h3>
     <div class="hint">叫醒次数：<b>${Number(st.wakes) || 0}</b>　正在听：${st.listening ? '是' : '否（浮窗没开）'}</div>
     <div class="row">${btn(0, '宽松')}${btn(1, '标准')}${btn(2, '严格')}</div>
     <div class="hint">宽松=连"飞鱼"都算（吵的地方容易误唤醒）；严格=只认"大肥鱼"三个字。</div>
     <div style="max-height:38vh;overflow:auto;margin-top:10px;border-top:1px solid rgba(120,160,210,.2);padding-top:8px">
       <div class="hint">她最近听到的（最新在上）：</div>${rows}
     </div>
     <div class="row"><button data-x="again">刷新</button><button data-x="close">关掉</button></div>`,
    (box) => {
      box.querySelectorAll('[data-s]').forEach((b) => {
        b.onclick = async () => {
          try { await call('wakeSens', { sens: Number(b.dataset.s) }); } catch (e) { }
          setBubble('灵敏度：' + ['宽松', '标准', '严格'][Number(b.dataset.s)]);
          openWakeDiag();
        };
      });
      box.querySelector('[data-x="again"]').onclick = () => openWakeDiag();
      box.querySelector('[data-x="close"]').onclick = hideOverlay;
    },
  );
}

async function askServer() {
  let cur = '';
  try { cur = (await call('info')).serverUrl || ''; } catch {}
  showOverlay(
    `<h3>电脑地址</h3>
     <input id="srvInput" aria-label="电脑连接地址" placeholder="192.168.1.10:8790 或 https://…" value="${escapeHtml(cur)}" />
     <div class="hint">填入电脑提供的连接地址。外出时使用远程地址，并保留开头的 https://。</div>
     <div class="row"><button data-x="cancel">算了</button><button data-x="ok" class="ok">连过去</button></div>`,
    (box) => {
      box.querySelector('[data-x="cancel"]').onclick = hideOverlay;
      box.querySelector('[data-x="ok"]').onclick = async () => {
        const v = box.querySelector('#srvInput').value.trim();
        if (!v) return;
        await call('setServer', { url: v });
        hideOverlay();
        setBubble('换好了，正在连…', { sticky: true });
        await ping();
        await loadAvatar();
        setBubble(state.serverOk ? '连上了' : '还是连不上，地址或防火墙看下');
      };
    },
  );
}

// ────────────────────────────────────────── 启动 ──────────────────────────
(async function boot() {
  requestAnimationFrame(tick);

  if (!NATIVE) {
    // 直接在电脑浏览器里打开时（调试用）：没有原生桥
    setBubble('（浏览器调试模式：没有手机原生能力）', { sticky: true });
  }

  const loadingMessage='正在同步连接…';
  setBubble(loadingMessage,{sticky:true});
  const health=ping().then(ok=>{
  // A delayed greeting must not replace a conversation or a touch response.
  if(bubble.textContent!==loadingMessage||state.busy||state.speaking||input.value.trim())return;
  if (!ok) {
    setBubble('连不上电脑…（到「我的空间」检查连接）', { sticky: true });
  } else {
    const hh = new Date().getHours();
    const hi = hh < 6 ? '还没睡？' : hh < 11 ? '早' : hh < 14 ? '中午好' : hh < 19 ? '下午好' : '晚上好';
    setBubble(hi);
    setTimeout(() => bubble.classList.remove('show'), 3200);
  }
  });

  await loadAvatar();
  window.__herUiReady=true;
  window.HerStartup?.mark('uiReadyAt');
  if(NATIVE)void call('pageReady',{url:location.href}).catch(()=>{});
  setInterval(ping, 15000);

  // 无障碍状态：原生也会主动推 a11y 事件，这里再问一次兜底
  if (NATIVE) {
    try { const info = await call('info'); setA11y(info.accessibility === true); } catch {}
  }
  await health;
})();

/* ── 她主动说话（2026-10-20）：原生层收到后台简报后调这个 ─────────────
 * 声音由原生（Proactive）播 —— 这里只负责让她出现在屏幕上，把这句话
 * 说在气泡里、并记进对话记录；App 没开着的时候原生只发通知，这条不会被调到。
 */
window.__herSay = function (text) {
  try {
    const t = String(text || '').trim();
    if (!t) return;
    addLog('her', t);
    // 简报比平时一句话长，给她多留几秒看完（普通气泡 2.6 秒就读不完了）
    setBubble(t, { sticky: true });
    clearTimeout(window.__herSayT);
    window.__herSayT = setTimeout(() => bubble.classList.remove('show'), Math.max(6000, t.length * 130));
  } catch (e) { }
};
