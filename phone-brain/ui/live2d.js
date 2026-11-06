/* Cubism renderer: real expression composition and mesh-aware body gestures. */
(function () {
  'use strict';
  const scripts = new Map();
  let libraries;
  function script(src) {
    if (!scripts.has(src)) scripts.set(src, new Promise((resolve, reject) => {
      const tag = document.createElement('script'); tag.src = src; tag.onload = resolve;
      tag.onerror = () => { tag.remove(); scripts.delete(src); reject(new Error('加载失败：' + src)); };
      document.head.appendChild(tag);
    }));
    return scripts.get(src);
  }
  function ensureLibs() {
    if (!libraries) libraries = (async () => {
      for(const name of ['pixi.min.js','live2dcubismcore.min.js','pixi-live2d-cubism4.min.js']){
        if(typeof window.Android!=='undefined')try{await script('/bundled-vendor/'+name);continue;}catch{}
        await script('/ui/vendor/'+name);
      }
      if (!window.PIXI?.live2d) throw new Error('Live2D 运行时未就绪');
    })().catch(e => { libraries = null; throw e; });
    return libraries;
  }
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  /** Cubism 4 display adapter predates per-mesh Multiply/Screen colors (4.2+).
   * Keep the bundled adapter intact; bridge the official color formula here.
   * Without this, tinted black source meshes (notably the nose) render black. */
  function installMeshColors(internal) {
    const drawables = internal.coreModel._model.drawables;
    if (!drawables.multiplyColors || !drawables.screenColors) return;
    const contexts = new WeakMap();
    let mesh = 0;
    const opacity = internal.coreModel.getDrawableOpacity;
    internal.coreModel.getDrawableOpacity = function (index) { mesh = index; return opacity.call(this, index); };
    const updateContext = internal.updateWebGLContext;
    internal.updateWebGLContext = function (gl, ...args) {
      if (!contexts.has(gl)) {
        const state = { active: null, program: null, uniforms: new WeakMap() }; contexts.set(gl, state);
        const shaderSource = gl.shaderSource, useProgram = gl.useProgram, drawElements = gl.drawElements;
        gl.shaderSource = function (shader, source) {
          if (source.includes('u_baseColor') && source.includes('s_texture0') && !source.includes('isInside')) {
            source = source.replace(/texture2D\(\s*s_texture0\s*,\s*v_texCoord\s*\)/g, 'herSample(v_texCoord)');
            source = source.replace(/void\s+main\s*\(/, 'uniform vec4 u_herMultiply; uniform vec4 u_herScreen; vec4 herSample(vec2 uv) { vec4 c = texture2D(s_texture0, uv); c.rgb *= u_herMultiply.rgb; c.rgb = c.rgb + u_herScreen.rgb * c.a - c.rgb * u_herScreen.rgb; return c; } void main(');
          }
          return shaderSource.call(this, shader, source);
        };
        gl.useProgram = function (program) { state.program = program; return useProgram.call(this, program); };
        gl.drawElements = function (...values) {
          if (state.active !== null && state.program) {
            let locations = state.uniforms.get(state.program);
            if (!locations) {
              locations = [this.getUniformLocation(state.program, 'u_herMultiply'), this.getUniformLocation(state.program, 'u_herScreen')];
              state.uniforms.set(state.program, locations);
            }
            if (locations[0] !== null) {
              const offset = state.active * 4, mul = drawables.multiplyColors, screen = drawables.screenColors;
              this.uniform4f(locations[0], mul[offset], mul[offset + 1], mul[offset + 2], mul[offset + 3]);
              this.uniform4f(locations[1], screen[offset], screen[offset + 1], screen[offset + 2], screen[offset + 3]);
            }
          }
          return drawElements.apply(this, values);
        };
      }
      return updateContext.call(this, gl, ...args);
    };
    const drawMesh = internal.renderer.drawMesh;
    internal.renderer.drawMesh = function (...args) {
      const state = contexts.get(this.gl);
      if (!state) return drawMesh.apply(this, args);
      state.active = mesh;
      try { return drawMesh.apply(this, args); } finally { state.active = null; }
    };
  }
  async function load(url, container, opts = {}) {
    await ensureLibs();
    const canvas = document.createElement('canvas'); canvas.id = 'live2dCanvas';
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;touch-action:none;';
    container.appendChild(canvas);
    let app, model, destroyed = false;
    try {
      app = new PIXI.Application({ view: canvas, backgroundAlpha: 0, transparent: true, antialias: true,
        resizeTo: window, resolution: Math.min(devicePixelRatio || 1, 2), autoDensity: true });
      let lastError;
      for (let attempt = 0; attempt < 2; attempt++) {
        let timer, expired = false;
        const pending = PIXI.live2d.Live2DModel.from(url, { autoInteract: false });
        pending.then(value => { if (expired) value.destroy({ texture: true, baseTexture: true }); }, () => {});
        try {
          model = await Promise.race([pending, new Promise((_, reject) => {
            timer = setTimeout(() => { expired = true; reject(new Error('模型加载超时，请检查连接')); }, 45000);
          })]);
          break;
        } catch (e) { lastError = e; } finally { clearTimeout(timer); }
      }
      if (!model) throw lastError;
      const internal = model.internalModel, core = internal.coreModel, raw = core._model;
      // A 256px atlas shared by hundreds of clipped meshes made the tail's
      // cutout bleed in large square blocks. 1024px costs only 4 MiB per buffer.
      internal.renderer.setClippingMaskBufferSize(1024);
      installMeshColors(internal);
      app.stage.addChild(model);
      const ids = Array.from(raw.parameters.ids), idSet = new Set(ids);
      const defaults = Object.fromEntries(ids.map((id, i) => [id, core.getParameterDefaultValue(i)]));
      const limits = Object.fromEntries(ids.map((id, i) => [id, [core.getParameterMinimumValue(i), core.getParameterMaximumValue(i)]]));
      let metadata = { expressions: {}, parts: {} };
      try {
        const r = await fetch(new URL('interaction.json', new URL(url, location.href)), { signal: AbortSignal.timeout(12000) });
        if (r.ok) metadata = await r.json();
      } catch (e) { console.warn('[live2d] 交互描述未加载', e.message); }
      const C = window.HerCharacter, P = window.HerPerformance;
      const T = window.HerContact;
      let appearance = { mood: 'calm', energy: .45, expressions: [], accessories: [], gesture: 'none', duration: 5 };
      let mouth = 0, blinkAt = performance.now() + 1800, blinkStart = 0;
      let gestureAt = 0, gestureUntil = 0, gesture = 'none', strength = .65;
      let expressionUntil = 0, beatExpressions = [], beatUntil = 0, plan = [], planAt = 0, signature = '';
      let pose = {}, currentBeat = {}, physicsProbe = {}, idle = P.createIdle(),lastPerformanceId='';
      const reduced = matchMedia('(prefers-reduced-motion: reduce)');
      let motionToken = 0, motionTimer, handPose = 'none';
      let contactState = null, contactFrame = {}, contactApplied={}, pointer = null;
      const contactSmoother=T.createSmoother(limits);
      const contactRing=document.createElement('div');
      contactRing.setAttribute('aria-hidden','true');
      contactRing.style.cssText='position:fixed;width:26px;height:26px;border-radius:50%;border:1px solid #d7efdf99;box-shadow:0 0 14px #a7dece44;pointer-events:none;z-index:5;opacity:0;transform:translate(-50%,-50%);transition:opacity .15s;';
      container.appendChild(contactRing);
      let active = new Map(), smoothed = new Map(), lastFrame = performance.now();
      const managed = new Set(Object.values(metadata.expressions || {}).flat().map(p => p.Id));
      for (const id of ['Movement1', 'Movement2', 'Movement3']) managed.delete(id);
      let fitScale=1,fitY=0;
      function camera(){
        const proximity=clamp(pose.proximity||0,-.1,opts.zoom>1.3?.075:.13);
        model.scale.set(fitScale*(1+proximity));
        // Keep the face at the same height while approaching, including half-body floats.
        model.position.set(app.renderer.screen.width/2,fitY+internal.height*fitScale*proximity*.32);
      }
      const fit = () => {
        const w = app.renderer.screen.width, h = app.renderer.screen.height;
        const top=opts.insetTop||0,bottom=opts.insetBottom||0,available=Math.max(150,h-top-bottom);
        fitScale=Math.min(w / internal.width, available / internal.height) * .92 * (opts.zoom || 1);
        fitY=top+available/2+available*(.02+(opts.offsetY||0));
        model.anchor.set(.5, .5);camera();
      };
      // Fit after PIXI updates its screen; its window listener resizes on the
      // next animation frame, so fitting on the raw window event used old bounds.
      fit(); app.renderer.on('resize', fit);
      const set = (id, value) => {
        if (idSet.has(id)) core.setParameterValueById(id, clamp(value, limits[id][0], limits[id][1]));
      };
      const add = (id, value) => { if (idSet.has(id)) set(id, core.getParameterValueById(id) + value); };
      function transition(group) {
        if (metadata.motions?.includes(group)) Promise.resolve(model.motion(group, 0, 3)).catch(e => console.warn('[live2d] 动作', group, e.message));
      }
      function finishPose(force = false) {
        if (!force && handPose === 'point' && appearance.accessories?.includes('竖食指开')) return;
        const previous = handPose; handPose = 'none';
        if (previous === 'raise' || previous === 'wave') transition('LowerHand');
        else if (previous === 'point') transition('PointOff');
        else if (previous === 'grass') transition('GrassOff');
      }
      function playGesture(next, duration = 3.2, intensity = .65) {
        clearTimeout(motionTimer); const token = ++motionToken;
        const sameHandPose=['raise','wave'].includes(next)&&['raise','wave'].includes(handPose)||next===handPose&&['point','grass'].includes(next);
        if(!sameHandPose)finishPose(true);
        gesture = next; strength = clamp(intensity,.15,1); gestureAt = performance.now(); gestureUntil = gestureAt + duration * 1000;
        const group = { raise: 'RaiseHand', wave: 'RaiseHand', grass: 'Grass', point: 'Point', lost: 'LostTracking' }[next];
        if (group) { handPose = next; if(!sameHandPose)transition(group); }
        motionTimer = setTimeout(() => { if (token === motionToken && !destroyed) finishPose(); }, duration * 1000);
      }
      function setAppearance(value, animate = false) {
        const previousPoint = appearance.accessories?.includes('竖食指开');
        const next = { ...appearance, ...value };
        if (C) Object.assign(next, C.normalize(next));
        next.accessories = C ? C.expressions(value.accessories ?? appearance.accessories) : []; appearance = next;
        const nextSignature = JSON.stringify([next.revision,next.mood,next.expressions,next.accessories,next.performanceId]);
        if (signature === nextSignature && !animate) return;
        signature = nextSignature;
        expressionUntil = performance.now() + Math.min(10,Math.max(3.5,next.duration))*1000;
        if (previousPoint && !next.accessories.includes('竖食指开')) { handPose = 'none'; transition('PointOff'); }
        if (animate&&(!next.performanceId||next.performanceId!==lastPerformanceId)) {
          lastPerformanceId=next.performanceId;
          planAt = performance.now(); plan = [...next.plan]; beatExpressions=[];beatUntil=0;
          playGesture(next.gesture,next.duration,next.intensity);
        }
      }
      function compose(now) {
        const transient=now<expressionUntil;
        const baseline=['shy','affectionate'].includes(appearance.mood)?['脸红']:[];
        const names = C.expressions([...(transient?C.MOODS[appearance.mood].face:baseline),...(transient?appearance.expressions:[]),...(now<beatUntil?beatExpressions:[]),...appearance.accessories]);
        active = new Map();
        for (const name of names) for (const p of metadata.expressions?.[name] || []) {
          if (!managed.has(p.Id)) continue;
          const base = active.has(p.Id) ? active.get(p.Id) : defaults[p.Id] ?? 0;
          active.set(p.Id, p.Blend === 'Multiply' ? base * p.Value : p.Blend === 'Overwrite' ? p.Value : base + p.Value);
        }
      }
      // The rig consumes Angle*/Position* BEFORE physics. ParamAngle* are outputs.
      // Driving outputs afterwards disconnected the hair, ears, arms and tail.
      const natural = internal.updateNaturalMovements;
      internal.updateNaturalMovements = function (...args) {
        natural.apply(this,args);
        const now = performance.now(), dt = Math.min(.1, (now - lastFrame) / 1000); lastFrame = now;
        while(plan.length && now-planAt>=plan[0].at*1000) {
          const beat=plan.shift();playGesture(beat.gesture,beat.duration,beat.intensity);
          beatExpressions=beat.expressions;beatUntil=now+beat.duration*1000;
        }
        compose(now);
        const progress=(now-gestureAt)/Math.max(1,gestureUntil-gestureAt);
        currentBeat=P.sample(gesture,now<gestureUntil?progress:1,strength);
        const rest=idle(now/1000,appearance.energy);
        for(const key of P.channels) {
          let target=currentBeat[key]+rest[key]*(now<gestureUntil?.15:1);
          if(reduced.matches)target*=.2;
          pose[key]=(pose[key]||0)+(target-(pose[key]||0))*(1-Math.exp(-dt*(key[0]==='g'?15:10)));
        }
        camera();
        contactFrame=T?.sample(contactState,now,appearance.mood)||{};
        contactApplied=contactSmoother.step(contactFrame,dt);
        if(contactState?.released&&!contactFrame.strength)contactState=null;
        for(const [key,id] of Object.entries({x:'AngleX',y:'AngleY',z:'AngleZ',px:'PositionX',py:'PositionY',pz:'PositionZ'}))add(id,(pose[key]||0)+(contactApplied.pose?.[key]||0));
        set('ParamEyeBallX',pose.gx||0);set('ParamEyeBallY',pose.gy||0);
        add('LWrist',clamp((pose.wrist||0)/30,-.4,.4));
        // LeanInput is also a physics input. Smooth expression changes before physics.
        for (const id of managed) {
          const value = smoothed.get(id) ?? defaults[id] ?? 0, target = active.has(id) ? active.get(id) : defaults[id] ?? 0;
          const next = value + (target - value) * (1 - Math.exp(-dt * 7)); smoothed.set(id, next);
          if(id==='LeanInput')set(id,next+(pose.lean||0));
        }
      };
      function beforeUpdate() {
        const now=performance.now(),t=now/1000,mood=appearance.mood;
        // Cubism restores saved parameters after drawing; probe inside this hook.
        physicsProbe={at:now,input:core.getParameterValueById('AngleY'),output:core.getParameterValueById('ParamAngleY'),tail:core.getParameterValueById('Param_Angle_Rotation84'),leanInput:core.getParameterValueById('LeanInput'),leanOutput:core.getParameterValueById('Param50')};
        for(const id of managed)if(id!=='LeanInput')set(id,smoothed.get(id)??defaults[id]??0);
        const smile=clamp((C.MOODS[mood]?.smile??.15)*.58+(pose.smile||0),-.6,1);
        set('EyeSmile', Math.max(0, smile)); set('ParamMouthForm', smile);
        if (mood === 'annoyed') { set('Angry', .6); add('ParamBrowLAngle', -.4); add('ParamBrowRAngle', -.4); }
        if (mood === 'surprised') { set('ShockL', .8); set('ShockR', .8); }
        if (mood === 'thinking' && now<expressionUntil) set('Param140', (t * .5) % 1);
        if (now > blinkAt) { blinkStart = now; blinkAt = now + 2600 + Math.random() * 3500; }
        const blink = now - blinkStart < 180 ? 1 - Math.sin((now - blinkStart) / 180 * Math.PI) : 1;
        const openness = mood === 'sleepy' ? .48 : mood === 'shy' ? .83 : 1;
        set('ParamEyeLOpen', openness * blink); set('ParamEyeROpen', openness * blink);
        if (contactApplied) {
          for(const [id,value] of Object.entries(contactApplied.parameters||{}))add(id,value);
          if(contactApplied.blush)set('key7',Math.max(core.getParameterValueById('key7'),contactApplied.blush));
          if(contactApplied.eyes){const eye=1-contactApplied.eyes;set('ParamEyeLOpen',openness*blink*eye);set('ParamEyeROpen',openness*blink*eye);}
        }
        set('ParamMouthOpenY',Math.max(mouth,pose.mouth||0));
        physicsProbe.blush=core.getParameterValueById('key7');
      }
      internal.on('beforeModelUpdate', beforeUpdate); setAppearance(window.HerPresence?.get() || appearance);
      const partNames = raw.parts.ids.map(id => metadata.parts?.[id] || '');
      // Small alpha maps prevent an empty part of a mesh (e.g. between tail fins)
      // from counting as skin. Keep only 1 byte/pixel, not full decoded atlases.
      const alphaMaps = model.textures.map(texture => {
        try {
          const image=texture.baseTexture.resource.source,cv=document.createElement('canvas');
          const scale=Math.min(1,512/Math.max(image.width,image.height));
          cv.width=Math.round(image.width*scale);cv.height=Math.round(image.height*scale);
          const cx=cv.getContext('2d',{willReadFrequently:true});cx.drawImage(image,0,0,cv.width,cv.height);
          const rgba=cx.getImageData(0,0,cv.width,cv.height).data;
          return {width:cv.width,height:cv.height,alpha:Uint8Array.from({length:cv.width*cv.height},(_,i)=>rgba[i*4+3])};
        }catch{return null;}
      });
      function classify(name, x, y) {
        if (/尾巴/.test(name)) return 'tail';
        if (/手|腕|臂/.test(name)) return 'hand';
        if (/腿|脚|鞋/.test(name)) return 'leg';
        if (/胸|上衣/.test(name)) return 'chest';
        if (/脸|眼|眉|嘴|鼻/.test(name) && y < .42) return 'face';
        if (/头|发|耳|帽/.test(name) && y < .25) return y > .13 && Math.abs(x - .5) < .15 ? 'face' : 'head';
        if (y < .3) return 'head';
        if (y < .42) return Math.abs(x - .5) > .22 ? 'hand' : 'chest';
        if (y < .56) return Math.abs(x - .5) > .24 ? 'hand' : 'belly';
        return 'leg';
      }
      function hit(clientX, clientY) {
        const rect = canvas.getBoundingClientRect();
        const screen = new PIXI.Point((clientX - rect.left) * app.renderer.screen.width / rect.width, (clientY - rect.top) * app.renderer.screen.height / rect.height);
        const p = model.toModelPosition(screen), d = raw.drawables;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity; const matches = [];
        for (let i = 0; i < d.count; i++) {
          if (d.opacities[i] < .15) continue;
          const v = internal.getDrawableVertices(i); let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (let j = 0; j < v.length; j += 2) { x0 = Math.min(x0, v[j]); x1 = Math.max(x1, v[j]); y0 = Math.min(y0, v[j + 1]); y1 = Math.max(y1, v[j + 1]); }
          minX = Math.min(minX, x0); maxX = Math.max(maxX, x1); minY = Math.min(minY, y0); maxY = Math.max(maxY, y1);
          if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
          const ix = d.indices[i]; let inside = false;
          for (let j = 0; j < ix.length && !inside; j += 3) {
            const a = ix[j] * 2, b = ix[j + 1] * 2, c = ix[j + 2] * 2;
            const cross = (u, w) => (p.x - v[w]) * (v[u + 1] - v[w + 1]) - (v[u] - v[w]) * (p.y - v[w + 1]);
            const c1 = cross(a, b), c2 = cross(b, c), c3 = cross(c, a);
            const area = (v[b] - v[a]) * (v[c + 1] - v[a + 1]) - (v[c] - v[a]) * (v[b + 1] - v[a + 1]);
            inside = Math.abs(area) > .001 && !((c1 < 0 || c2 < 0 || c3 < 0) && (c1 > 0 || c2 > 0 || c3 > 0));
            if(inside && alphaMaps[d.textureIndices[i]]) {
              const map=alphaMaps[d.textureIndices[i]],uv=d.vertexUvs[i];
              const wa=((v[b+1]-v[c+1])*(p.x-v[c])+(v[c]-v[b])*(p.y-v[c+1]))/area;
              const wb=((v[c+1]-v[a+1])*(p.x-v[c])+(v[a]-v[c])*(p.y-v[c+1]))/area;
              const wc=1-wa-wb;
              const u=uv[a]*wa+uv[b]*wb+uv[c]*wc, vv=uv[a+1]*wa+uv[b+1]*wb+uv[c+1]*wc;
              const ax=Math.round(clamp(u)*(map.width-1)),ay=Math.round(clamp(1-vv)*(map.height-1));
              inside=map.alpha[ay*map.width+ax]>32;
            }
          }
          if (inside) matches.push(i);
        }
        if (!matches.length) return null; matches.sort((a, b) => d.renderOrders[b] - d.renderOrders[a]);
        const nx = (p.x - minX) / (maxX - minX), ny = (p.y - minY) / (maxY - minY); let name = '';
        for (let part = d.parentPartIndices[matches[0]], depth = 0; part >= 0 && depth < 12; part = raw.parts.parentIndices[part], depth++) name += ' ' + partNames[part];
        return { part: classify(name, nx, ny), x: nx, y: ny, mesh: d.ids[matches[0]], names: name.trim() };
      }
      function down(ev) {
        if (!ev.isPrimary || ev.button > 0 || opts.interactive === false) return;
        let target=hit(ev.clientX,ev.clientY);
        // A small finger margin around thin hands/legs, never the whole canvas.
        if(!target)for(const radius of [5,9]){for(const [dx,dy] of [[radius,0],[-radius,0],[0,radius],[0,-radius]]){target=hit(ev.clientX+dx,ev.clientY+dy);if(target)break;}if(target)break;}
        if (!target||!T) return; ev.preventDefault(); ev.stopPropagation();
        contactState=T.begin(target,ev.clientX,ev.clientY,performance.now());
        pointer={id:ev.pointerId,lastHitAt:0};
        contactRing.style.left=ev.clientX+'px';contactRing.style.top=ev.clientY+'px';contactRing.style.opacity='.8';
        window.dispatchEvent(new CustomEvent('her:contact',{detail:{part:target.part}}));
        canvas.setPointerCapture(ev.pointerId);
      }
      function move(ev) {
        if (!pointer || pointer.id !== ev.pointerId) return; ev.preventDefault();
        const now=performance.now(),priorPart=contactState.part,wasRubbing=contactState.rubbing;
        let target=null;if(now-pointer.lastHitAt>70){target=hit(ev.clientX,ev.clientY);pointer.lastHitAt=now;}
        T.move(contactState,ev.clientX,ev.clientY,now,target);
        if(contactState.rubbing&&(!wasRubbing||priorPart!==contactState.part))opts.onTouchStart?.({kind:'rub',part:contactState.part});
        contactRing.style.left=ev.clientX+'px';contactRing.style.top=ev.clientY+'px';
      }
      function up(ev) {
        if (!pointer || pointer.id !== ev.pointerId) return; pointer = null;
        const event=T.finish(contactState,performance.now(),ev.type==='pointercancel'||ev.type==='lostpointercapture');
        contactState.released=performance.now();contactRing.style.opacity='0';
        if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
        if(!event)return;
        const interaction = { id: 'touch-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9),...event};
        opts.onInteraction?.(interaction); window.dispatchEvent(new CustomEvent('her:touch', { detail: interaction }));
      }
      canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move);
      for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(name, up);
      const visibility = () => { if (document.hidden) { app.stop(); pointer = null; contactState = null;contactRing.style.opacity='0'; } else { lastFrame = performance.now(); app.start(); } };
      document.addEventListener('visibilitychange', visibility); document.getElementById('avatarCanvas')?.setAttribute('hidden', '');
      const api = { model, app, metadata, setAppearance, playGesture, hitTest: hit, mouth: value => { mouth = clamp(Number(value) || 0); },
        inspect: () => ({ mood: appearance.mood, active: [...active.keys()], parameters: ids.length, expressions: Object.keys(metadata.expressions || {}), gestures: metadata.motions, canvas: canvas.isConnected,
          maskSize:internal.renderer.getClippingMaskBufferSize(),performance:{gesture,id:lastPerformanceId,pose:{...pose},camera:{scale:model.scale.x,baseScale:fitScale},contact:{part:contactFrame.part,strength:contactFrame.strength||0,rubbing:!!contactState?.rubbing,parameters:contactFrame.parameters||{},applied:JSON.parse(JSON.stringify(contactApplied))},physics:{...physicsProbe},remaining:Math.max(0,gestureUntil-performance.now()),plan:plan.length,physicsInputs:['AngleX','AngleY','AngleZ','PositionX','PositionY','PositionZ']} }),
        destroy: () => {
          if (destroyed) return; destroyed = true; clearTimeout(motionTimer); app.renderer.off('resize', fit);
          document.removeEventListener('visibilitychange', visibility); internal.off('beforeModelUpdate', beforeUpdate);
          internal.updateNaturalMovements=natural;
          contactRing.remove();window.HerPresence?.detach(api); app.destroy(true, { children: true, texture: true, baseTexture: true });
        } };
      window.HerPresence?.attach(api); return api;
    } catch (e) {
      try { app?.destroy(true, { children: true, texture: true, baseTexture: true }); } catch {} canvas.remove(); throw e;
    }
  }
  window.L2D = { load };
})();
