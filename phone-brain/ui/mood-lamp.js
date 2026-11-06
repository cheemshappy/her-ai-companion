/* A small glass atmosphere lamp follows the same state as the model. */
(function () {
  'use strict';
  const C = window.HerCharacter, presence = window.HerPresence;
  const button = document.createElement('button');
  button.id = 'moodLamp'; button.type = 'button'; button.setAttribute('aria-label', '心情和表情');
  button.innerHTML = '<canvas aria-hidden="true"></canvas><span class="lamp-label">平静</span>';
  document.body.appendChild(button);
  const cv = button.querySelector('canvas'), ctx = cv.getContext('2d');
  const size = Math.min(devicePixelRatio || 1, 2); cv.width = 100 * size; cv.height = 142 * size; ctx.scale(size, size);
  let state = presence.get(), colors = state.palette.map(hex), phase = 0, last = 0, frame;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  function hex(value) { const n = parseInt(value.slice(1), 16); return [n >> 16, n >> 8 & 255, n & 255]; }
  const rgb = (c, a = 1) => 'rgba(' + c.map(v => Math.round(v)).join(',') + ',' + a + ')';
  function vessel() {
    ctx.beginPath(); ctx.moveTo(37, 20); ctx.bezierCurveTo(37, 43, 23, 60, 22, 99);
    ctx.bezierCurveTo(22, 118, 78, 118, 78, 99); ctx.bezierCurveTo(77, 60, 63, 43, 63, 20); ctx.closePath();
  }
  function draw(now) {
    frame = null; if (document.hidden) return;
    const dt = Math.min(.07, (now - (last || now)) / 1000); last = now;
    const target = state.palette.map(hex);
    colors = colors.map((c, i) => c.map((v, j) => v + (target[i][j] - v) * (1 - Math.exp(-dt * 2))));
    if (!reduced.matches) phase += dt * (.2 + state.energy * .65);
    ctx.clearRect(0, 0, 100, 142);
    const halo = ctx.createRadialGradient(50, 94, 4, 50, 94, 46);
    halo.addColorStop(0, rgb(colors[0], .17)); halo.addColorStop(1, rgb(colors[0], 0)); ctx.fillStyle = halo; ctx.fillRect(0, 36, 100, 102);
    ctx.save(); vessel(); ctx.clip();
    const glass = ctx.createLinearGradient(20, 0, 80, 0);
    glass.addColorStop(0, 'rgba(139,181,212,.25)'); glass.addColorStop(.25, 'rgba(17,31,53,.82)');
    glass.addColorStop(.65, 'rgba(16,28,47,.86)'); glass.addColorStop(1, 'rgba(143,183,209,.27)');
    ctx.fillStyle = glass; ctx.fillRect(20, 18, 60, 108); ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 6; i++) {
      const wave = (Math.sin(phase * (.7 + i * .08) + i * 1.7) + 1) / 2;
      const x = 50 + Math.sin(phase * .85 + i * 2.2) * (10 + wave * 4), y = 103 - wave * (57 + i * 2), r = 7 + i % 3 * 3;
      const glow = ctx.createRadialGradient(x - r * .2, y - r * .3, 0, x, y, r * 1.25);
      glow.addColorStop(0, rgb(colors[i % 3], .95)); glow.addColorStop(.65, rgb(colors[i % 3], .65)); glow.addColorStop(1, rgb(colors[i % 3], 0));
      ctx.fillStyle = glow; ctx.beginPath(); ctx.ellipse(x, y, r, r * (1.2 + wave * .6), Math.sin(phase + i) * .3, 0, Math.PI * 2); ctx.fill();
    }
    for (let i = 0; i < 12; i++) {
      const y = 110 - ((phase * 8 + i * 8.3) % 86); ctx.fillStyle = 'rgba(225,243,255,.35)';
      ctx.beginPath(); ctx.arc(30 + (i * 13 % 40), y, .55 + i % 2 * .3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    const shine = ctx.createLinearGradient(28, 0, 45, 0); shine.addColorStop(0, 'rgba(255,255,255,0)'); shine.addColorStop(.5, 'rgba(235,249,255,.22)'); shine.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = shine; ctx.beginPath(); ctx.ellipse(34, 71, 4, 33, .12, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    ctx.lineWidth = .8; ctx.strokeStyle = 'rgba(192,216,234,.48)'; vessel(); ctx.stroke();
    const metal = ctx.createLinearGradient(24, 0, 76, 0);
    metal.addColorStop(0, '#29384e'); metal.addColorStop(.35, '#8495aa'); metal.addColorStop(.53, '#b2b8bd'); metal.addColorStop(.72, '#52637c'); metal.addColorStop(1, '#25354b');
    ctx.fillStyle = metal; ctx.beginPath(); ctx.moveTo(35, 20); ctx.lineTo(39, 10); ctx.quadraticCurveTo(50, 6, 61, 10); ctx.lineTo(65, 20); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(25, 111); ctx.lineTo(21, 126); ctx.quadraticCurveTo(50, 134, 79, 126); ctx.lineTo(75, 111); ctx.closePath(); ctx.fill();
    ctx.fillStyle = rgb(colors[0], .75); ctx.fillRect(31, 113, 38, 1);
    ctx.fillStyle = 'rgba(237,245,255,.65)'; ctx.beginPath(); ctx.arc(50, 122, 1.4, 0, Math.PI * 2); ctx.fill();
    frame = requestAnimationFrame(draw);
  }
  function update(value) { state = value; button.querySelector('.lamp-label').textContent = C.MOODS[state.mood].label; button.title = '现在：' + C.MOODS[state.mood].label + ' · 点击查看表情'; }
  window.addEventListener('her:state', ev => update(ev.detail));
  document.addEventListener('visibilitychange', () => { if (frame) cancelAnimationFrame(frame); frame = null; if (!document.hidden) { last = 0; frame = requestAnimationFrame(draw); } });
  function panel() {
    if (document.getElementById('characterPanel')) return;
    const overlay = document.createElement('div'); overlay.id = 'characterPanel'; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-label', '心情与表情'); overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = '<section class="character-card"><header><div><h3>她此刻的心情</h3><p>脸上的表情，也藏在这盏灯里</p></div><button data-close aria-label="关闭">×</button></header><div class="mood-options"></div><h4>表情与外观</h4><p class="character-hint">可以组合；衣装与体型只在这里或你明确要求时改变。</p><div class="expression-options"></div><h4>小动作</h4><div class="gesture-options"></div><p class="character-feedback" role="status"></p><button class="character-reset">恢复自然状态</button><footer>DeepSeek-chan · 神宫凉子免费配布<br>原画／拆分：神宫凉子　Live2D：霓虹猫_NeonNeko<br>仅供本机个人使用，勿转发含模型的安装包。</footer></section>';
    const feedback = overlay.querySelector('.character-feedback');
    async function choose(value) { try { await presence.choose({...value,plan:[]}); feedback.textContent = '已更新'; refresh(); } catch { feedback.textContent = '保存失败，请检查连接后重试'; } }
    for (const [mood, def] of Object.entries(C.MOODS)) {
      const b = document.createElement('button'); b.textContent = def.label; b.dataset.mood = mood;
      b.onclick = () => choose({ mood, energy: def.energy, expressions: [], gesture: 'none', accessories: presence.get().accessories }); overlay.querySelector('.mood-options').appendChild(b);
    }
    for (const name of C.EXPRESSIONS) {
      const b = document.createElement('button'); b.textContent = name; b.dataset.expression = name;
      b.onclick = () => { const s = presence.get(), old = s.accessories || [];
        const accessories = old.includes(name) ? old.filter(x => x !== name) : C.expressions([...old, name]);
        choose({ ...s, accessories, gesture: name === '竖食指开' ? 'point' : name === '竖食指关' ? 'none' : 'none' }); };
      overlay.querySelector('.expression-options').appendChild(b);
    }
    const gestures = { nod:'点头',shake:'摇头',lean:'靠近',tilt:'歪头',listen:'认真听',peek:'偷看',shy:'害羞',think:'想一想',shrug:'耸肩',cheer:'小雀跃',bow:'欠身',yawn:'打哈欠',tease:'逗你',settle:'换个重心',wave:'挥手',raise:'举手',point:'竖食指',grass:'狗尾草',lost:'脱捕小剧场' };
    for (const [gesture, label] of Object.entries(gestures)) { const b = document.createElement('button'); b.textContent = label; b.onclick = () => choose({ ...presence.get(), gesture, duration: 5 }); overlay.querySelector('.gesture-options').appendChild(b); }
    function refresh() {
      const s = presence.get();
      for (const b of overlay.querySelectorAll('[data-mood]')) b.setAttribute('aria-pressed', String(b.dataset.mood === s.mood));
      for (const b of overlay.querySelectorAll('[data-expression]')) b.setAttribute('aria-pressed', String(s.accessories?.includes(b.dataset.expression)));
    }
    const previous = document.activeElement;
    function close() { overlay.remove(); window.removeEventListener('keydown', key); window.removeEventListener('her:state', refresh); previous?.focus(); }
    function key(ev) {
      if (ev.key === 'Escape') close();
      if (ev.key === 'Tab') { const list = [...overlay.querySelectorAll('button')]; if (ev.shiftKey && document.activeElement === list[0]) { ev.preventDefault(); list.at(-1).focus(); } else if (!ev.shiftKey && document.activeElement === list.at(-1)) { ev.preventDefault(); list[0].focus(); } }
    }
    overlay.querySelector('[data-close]').onclick = close; overlay.onclick = ev => { if (ev.target === overlay) close(); };
    overlay.querySelector('.character-reset').onclick = () => choose({ reset: true });
    document.body.appendChild(overlay); window.addEventListener('keydown', key); window.addEventListener('her:state', refresh); refresh(); overlay.querySelector('[data-close]').focus();
  }
  window.HerAppearance = { open: panel };
  button.onclick = panel; update(state); frame = requestAnimationFrame(draw);
})();
