/* Ocean observatory: original canvas architecture, quiet water and shared mood light. */
(function () {
  'use strict';
  const canvas=document.getElementById('bgCanvas');if(!canvas)return;
  const ctx=canvas.getContext('2d'),cache=document.createElement('canvas'),base=cache.getContext('2d');
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  let W=0,H=0,ratio=1,last=0,frame=null,scene='night',weather='clear',accent='#71c9dc',energy=.45;
  const palettes={
    night:{sky:['#071626','#173d50','#3f6972'],sea:['#204b5c','#102c3d','#0b1d2a'],moon:'#e2e7d5',rim:'#7da5a8'},
    morning:{sky:['#263a54','#9c898c','#d7bca6'],sea:['#75949a','#335b70','#122d42'],moon:'#ffe1b3',rim:'#cbb39c'},
    day:{sky:['#23475e','#789d9f','#c1c7b7'],sea:['#5c9c9c','#276373','#123343'],moon:'#fff1c9',rim:'#b0b9a6'},
    dusk:{sky:['#272b4b','#8b6e87','#d0a491'],sea:['#7b7b8d','#35485e','#14293c'],moon:'#ffe1ba',rim:'#c0a7ac'},
  };
  const gradient=(c,y0,y1,colors)=>{const g=c.createLinearGradient(0,y0,0,y1);colors.forEach((v,i)=>g.addColorStop(i/(colors.length-1),v));return g;};
  function arch(c,inset=0) {
    const left=W*.055+inset,right=W*.945-inset,top=H*.103+inset,bottom=H*.766-inset;
    const shoulder=top+Math.min((right-left)*.51,H*.2);
    c.beginPath();c.moveTo(left,bottom);c.lineTo(left,shoulder);
    c.bezierCurveTo(left,top-(shoulder-top)*.33,right,top-(shoulder-top)*.33,right,shoulder);
    c.lineTo(right,bottom);c.closePath();
  }
  function glow(c,x,y,r,color,alpha) {
    c.save();c.globalAlpha=alpha;const g=c.createRadialGradient(x,y,0,x,y,r);g.addColorStop(0,color);g.addColorStop(1,'transparent');
    c.fillStyle=g;c.fillRect(x-r,y-r,r*2,r*2);c.restore();
  }
  function staticScene() {
    const p=palettes[scene],horizon=H*.47;
    base.clearRect(0,0,W,H);base.fillStyle=gradient(base,0,H,['#172b37','#101f2b','#07131f']);base.fillRect(0,0,W,H);
    // Tall wall reveals, fine brass inlay, light falling from the window.
    for(const side of [.025,.975]) {
      base.fillStyle='rgba(177,186,170,.08)';base.fillRect(W*side,0,.6,H*.78);
      base.fillStyle='rgba(0,5,12,.32)';base.fillRect(W*side+2,0,3,H*.78);
    }
    base.save();arch(base);base.clip();
    base.fillStyle=gradient(base,H*.1,horizon,p.sky);base.fillRect(0,0,W,horizon);
    const mx=W*.755,my=H*(scene==='dusk'?.38:.245),mr=W*(scene==='day'?.028:.039);
    glow(base,mx,my,W*.26,p.moon,.13);
    base.fillStyle=p.moon;base.beginPath();base.arc(mx,my,mr,0,Math.PI*2);base.fill();
    if(scene==='night') {
      base.fillStyle=p.sky[1];base.beginPath();base.arc(mx+mr*.5,my-mr*.25,mr*.92,0,Math.PI*2);base.fill();
      for(let i=0;i<43;i++) {
        const x=((i*127.71)%997)/997*W,y=H*(.12+((i*37.17)%100)/100*.29);
        base.fillStyle='rgba(223,236,230,'+(.15+i%4*.1)+')';base.beginPath();base.arc(x,y,.45+i%3*.2,0,Math.PI*2);base.fill();
      }
    }
    // Distant headland silhouettes and a tiny stationary lighthouse.
    base.fillStyle=scene==='night'?'#183b4b':'#526c7a';base.beginPath();base.moveTo(0,horizon);
    base.bezierCurveTo(W*.12,horizon-H*.018,W*.16,horizon-H*.065,W*.31,horizon-H*.025);
    base.bezierCurveTo(W*.39,horizon-H*.017,W*.43,horizon,W*.55,horizon);base.closePath();base.fill();
    base.fillStyle='rgba(223,218,187,.48)';base.fillRect(W*.18,horizon-H*.034,1.2,H*.011);
    base.fillStyle=gradient(base,horizon,H*.78,p.sea);base.fillRect(0,horizon,W,H*.32);
    base.fillStyle='rgba(210,225,220,.15)';base.fillRect(0,horizon,W,.6);
    // Reflected celestial light tapers into the horizon.
    const beam=base.createLinearGradient(0,horizon,0,H*.76);beam.addColorStop(0,'rgba(218,231,217,.13)');beam.addColorStop(1,'rgba(177,211,206,0)');
    base.fillStyle=beam;base.beginPath();base.moveTo(mx-3,horizon);base.lineTo(mx+3,horizon);base.lineTo(mx+W*.17,H*.76);base.lineTo(mx-W*.19,H*.76);base.closePath();base.fill();
    if(weather!=='clear'){base.fillStyle=weather==='haze'?'rgba(141,160,165,.21)':'rgba(9,25,38,.25)';base.fillRect(0,0,W,H);}
    base.restore();
    // Stone arch depth, then warm thin metal trim.
    base.lineWidth=W*.032;base.strokeStyle='#071621';arch(base,-W*.014);base.stroke();
    base.lineWidth=1.1;base.strokeStyle='rgba(176,181,161,.48)';arch(base,-W*.002);base.stroke();
    base.lineWidth=.65;base.strokeStyle='rgba(181,214,211,.19)';arch(base,W*.012);base.stroke();
    // Quiet mullions and a broad stone sill.
    base.fillStyle='rgba(12,31,43,.8)';for(const x of [.21,.79])base.fillRect(W*x,H*.285,1.5,H*.475);
    base.fillStyle='rgba(188,205,193,.14)';base.fillRect(W*.052,H*.765,W*.896,1);
    base.fillStyle=gradient(base,H*.767,H*.794,['#34505a','#1a303e','#0e202e']);
    base.beginPath();base.moveTo(W*.045,H*.767);base.lineTo(W*.955,H*.767);base.lineTo(W,H*.79);base.lineTo(0,H*.79);base.closePath();base.fill();
    // Polished floor with perspective seams and an elliptical landing.
    base.fillStyle=gradient(base,H*.79,H,['#182f3b','#0d1d2b','#081421']);base.fillRect(0,H*.79,W,H*.21);
    base.strokeStyle='rgba(161,190,189,.07)';base.lineWidth=.7;
    for(let i=-3;i<=5;i++){base.beginPath();base.moveTo(W*.5+(i-1)*W*.15,H*.79);base.lineTo((i-1)*W*.55,H);base.stroke();}
    for(const y of [.84,.93]){base.beginPath();base.moveTo(0,H*y);base.lineTo(W,H*y);base.stroke();}
    base.fillStyle='rgba(84,123,132,.13)';base.beginPath();base.ellipse(W*.5,H*.812,W*.35,H*.018,0,0,Math.PI*2);base.fill();
    base.strokeStyle='rgba(181,207,201,.15)';base.lineWidth=.7;base.stroke();
    glow(base,W*.5,H*.807,W*.3,'#020a12',.8);
    // Restrained vignette, leaving the model in the light.
    const v=base.createRadialGradient(W*.5,H*.45,W*.2,W*.5,H*.45,H*.73);v.addColorStop(0,'transparent');v.addColorStop(1,'rgba(0,7,17,.56)');base.fillStyle=v;base.fillRect(0,0,W,H);
  }
  function resize() {
    W=innerWidth;H=innerHeight;ratio=Math.min(devicePixelRatio||1,1.5);
    canvas.width=cache.width=Math.round(W*ratio);canvas.height=cache.height=Math.round(H*ratio);
    ctx.setTransform(ratio,0,0,ratio,0,0);base.setTransform(ratio,0,0,ratio,0,0);staticScene();
  }
  function draw(now) {
    frame=null;if(document.hidden)return;
    if(now-last<1000/30){frame=requestAnimationFrame(draw);return;}last=now;
    ctx.clearRect(0,0,W,H);ctx.drawImage(cache,0,0,cache.width,cache.height,0,0,W,H);
    const t=reduced.matches?0:now/1000;
    ctx.save();arch(ctx,2);ctx.clip();
    for(let i=0;i<58;i++) {
      const depth=(i+1)/59,y=H*(.474+depth*depth*.288),length=(3+depth*W*.08)*(1+(i%4)*.23);
      const x=((i*97.3)%997)/997*W+Math.sin(t*.22+i*2)*depth*5;
      ctx.strokeStyle='rgba(164,207,206,'+(.025+depth*.04+Math.sin(t*.5+i)*.012)+')';ctx.lineWidth=.5+depth*.65;
      ctx.beginPath();ctx.moveTo(x-length/2,y);ctx.quadraticCurveTo(x,y-.5-depth,x+length/2,y);ctx.stroke();
    }
    if(weather==='rain'||weather==='snow')for(let i=0;i<45;i++) {
      const x=((i*37.7)%101)/101*W,y=((i*91.13+t*(weather==='snow'?8:110))%(H*.7))+H*.1;
      ctx.strokeStyle='rgba(199,222,225,.13)';ctx.lineWidth=weather==='snow'?2:.65;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x-2,y+(weather==='snow'?2:12));ctx.stroke();
    }
    ctx.restore();
    // The same colour as the lamp reflects softly onto the right wall and sill.
    glow(ctx,W*.94,H*.78,W*.28,accent,.05+energy*.025);
    frame=requestAnimationFrame(draw);
  }
  async function environment() {
    const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(new Date()));
    scene=hour>=5&&hour<8?'morning':hour>=8&&hour<17?'day':hour>=17&&hour<19?'dusk':'night';
    try {const r=await fetch('/api/weather',{signal:AbortSignal.timeout(8000)});if(r.ok){const value=await r.json(),text=String(value.text||'').split('；')[0];weather=/雪/.test(text)?'snow':/雨|雷/.test(text)?'rain':/霾|雾|沙|尘/.test(text)?'haze':'clear';}}catch{}
    staticScene();
  }
  window.addEventListener('her:state',ev=>{accent=ev.detail.palette?.[0]||accent;energy=ev.detail.energy;});
  window.addEventListener('resize',resize);
  document.addEventListener('visibilitychange',()=>{if(frame)cancelAnimationFrame(frame);frame=null;if(!document.hidden){last=0;frame=requestAnimationFrame(draw);}});
  resize();void environment();setInterval(environment,30*60*1000);frame=requestAnimationFrame(draw);
  window.__bgInfo=()=>({scene,weather,w:W,h:H,design:'ocean-observatory',fps:30});
})();
