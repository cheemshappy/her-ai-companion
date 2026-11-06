/* Authored 2D acting beats, informed by the mascot review's timing, not VMD data. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HerPerformance = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const clamp = (v, lo=0, hi=1) => Math.max(lo, Math.min(hi,v));
  const ease = t => { t=clamp(t);return t*t*(3-2*t); };
  // x/y/z are the rig's head INPUTS; px/py/pz lead its body/hair/tail physics.
  const profiles = {
    nod: [[.12,{y:3,gy:.15}],[.3,{y:-10,gy:-.2}],[.48,{y:3}],[.64,{y:-4}],[.8,{}]],
    shake: [[.14,{x:-3}],[.3,{x:12,gx:.3}],[.48,{x:-10,gx:-.2}],[.65,{x:5}],[.84,{}]],
    tilt: [[.13,{gx:.3}],[.35,{z:-10,x:3,y:-2,px:2}],[.66,{z:-9,x:3,px:2}],[.9,{}]],
    lean: [[.08,{gy:-.12}],[.27,{lean:-28,y:3,z:-1,pz:-2,smile:.15}],[.72,{lean:-28,y:3,z:-1,pz:-2}],[1,{}]],
    approach: [[.07,{gy:.1}],[.28,{lean:-30,proximity:.12,y:4,z:-1,smile:.2}],[.75,{lean:-30,proximity:.12,y:4,z:-1}],[1,{}]],
    retreat: [[.1,{gy:.05}],[.3,{lean:12,proximity:-.08,y:-2}],[.72,{lean:12,proximity:-.08,y:-2}],[1,{}]],
    peek: [[.14,{x:-7,z:3,gx:-.4}],[.35,{x:-13,z:7,px:-4}],[.57,{x:-9,gx:.5,y:2}],[.74,{x:-5,gx:.2}],[.94,{}]],
    shy: [[.13,{gy:-.4}],[.32,{y:-11,z:7,x:-7,py:-3,pz:-3,smile:.1}],[.6,{y:-9,z:7,gx:.35,gy:.15}],[.8,{y:-3,z:3}],[.97,{}]],
    think: [[.16,{gx:.6,gy:.25}],[.36,{x:8,y:3,z:-8,px:2}],[.68,{x:7,y:3,z:-8}],[.92,{}]],
    shrug: [[.14,{y:-2}],[.35,{py:5,z:5,x:-3,smile:.12}],[.6,{py:4,z:4}],[.9,{}]],
    cheer: [[.12,{y:-5,py:-2}],[.32,{y:6,py:5,z:-4,smile:.3}],[.5,{y:2,py:2,z:3}],[.68,{y:4,py:3,smile:.2}],[.92,{}]],
    bow: [[.12,{gy:-.25}],[.38,{y:-14,pz:-8,py:-3}],[.6,{y:-14,pz:-8}],[.9,{}]],
    yawn: [[.15,{y:-3,gy:-.2}],[.4,{y:8,z:6,py:2,mouth:.45}],[.66,{y:5,z:5,mouth:.25}],[.93,{}]],
    listen: [[.1,{gx:.1}],[.28,{y:-4,z:4,pz:-4}],[.57,{y:-4,z:4,pz:-4}],[.72,{y:1,z:2}],[.94,{}]],
    tease: [[.14,{gx:-.5}],[.33,{x:-8,z:-8,px:-3,smile:.25}],[.55,{x:6,z:5,gx:.35,smile:.2}],[.76,{x:2,z:2}],[.96,{}]],
    settle: [[.2,{gx:.3,x:3}],[.45,{px:3,z:-3}],[.7,{px:2,z:-2,gx:0}],[.95,{}]],
    wave: [[.16,{gx:.1,z:-2}],[.3,{z:-5,wrist:12,smile:.2}],[.43,{wrist:-10,z:-3}],[.55,{wrist:12}],[.68,{wrist:-8}],[.9,{}]],
    raise: [[.2,{y:2,z:-3}],[.43,{z:-5,smile:.15}],[.75,{z:-4}],[.94,{}]],
    point: [[.17,{gx:.35}],[.4,{x:5,z:-4,y:2}],[.7,{x:3,y:-2}],[.94,{}]],
    grass: [[.2,{gx:-.3,x:-3}],[.45,{z:6,x:-4}],[.75,{z:3,x:2}],[.96,{}]],
    lost: [[.18,{y:-5,gy:-.5}],[.48,{y:-12,z:6,py:-3}],[.76,{y:-8}],[.97,{}]],
  };
  const channels=['x','y','z','px','py','pz','gx','gy','smile','wrist','mouth','lean','proximity'];
  function sample(name, progress, intensity=.65) {
    const frames=[[0,{}],...(profiles[name]||[]),[1,{}]], result={};
    for(const key of channels) {
      // Eyes anticipate; the body arrives after the head and settles last.
      const shift=key==='gx'||key==='gy'?.035:key[0]==='p'?-.045:0;
      const u=clamp(progress+shift*Math.sin(Math.PI*clamp(progress)));
      let i=1;while(i<frames.length-1&&frames[i][0]<u)i++;
      const [a,av]=frames[i-1],[b,bv]=frames[i],t=ease((u-a)/(b-a));
      result[key]=((av[key]||0)*(1-t)+(bv[key]||0)*t)*clamp(intensity,.15,1);
    }
    return result;
  }
  function createIdle(random=Math.random) {
    let next=0,start=0,duration=0,target={};
    return (time,energy=.45) => {
      if(time>=next) {
        start=time;duration=2.8+random()*2.5;next=time+duration+3+random()*6;
        const side=random()<.5?-1:1;
        target={x:side*(1.5+random()*2),z:side*(1+random()*2),px:side*1.1,gx:side*.18,gy:(random()-.5)*.2};
      }
      const u=(time-start)/duration, strength=u>=0&&u<1?Math.sin(Math.PI*u)**2*(.45+energy*.5):0;
      return Object.fromEntries(channels.map(key=>[key,(target[key]||0)*strength]));
    };
  }
  return {sample,createIdle,profiles,channels,ease};
});
