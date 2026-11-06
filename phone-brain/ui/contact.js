/* Shared tactile timing: track the finger, acknowledge on contact, settle on release. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.HerContact=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const clamp=(n,a=-1,b=1)=>Math.max(a,Math.min(b,n));
  const profiles={head:'lean',face:'tilt',hand:'listen',chest:'shy',belly:'shrug',leg:'peek',tail:'tease'};
  function begin(hit,x,y,at){return {startPart:hit.part,part:hit.part,side:hit.x<.5?-1:1,x0:x,y0:y,partX:x,partY:y,x,y,start:at,last:at,distance:0,parts:[hit.part],rubbing:false,released:false};}
  function move(state,x,y,at,hit){
    const distance=Math.hypot(x-state.x,y-state.y);state.distance+=distance;state.speed=distance/Math.max(.016,(at-state.last)/1000);
    state.x=x;state.y=y;state.last=at;
    if(at-state.start>=230&&state.distance>=6)state.rubbing=true;
    if(state.rubbing&&hit&&hit.part!==state.part&&Math.hypot(x-state.partX,y-state.partY)>=28){state.part=hit.part;state.side=hit.x<.5?-1:1;state.partX=x;state.partY=y;if(!state.parts.includes(hit.part))state.parts.push(hit.part);}
    return state;
  }
  function finish(state,at,cancel=false){
    if(cancel||(!state.rubbing&&state.distance>20))return null;
    return {part:state.part,kind:state.rubbing?'rub':'tap',durationMs:Math.round(at-state.start),distance:Math.round(state.distance),parts:state.parts.slice(),speed:Math.round(Math.min(2000,state.speed||0))};
  }
  function sample(state,at,mood='calm'){
    if(!state)return {};
    const age=(at-state.start)/1000,fade=state.released?Math.max(0,1-(at-state.released)/450):1;
    const smooth=1-Math.exp(-age*18),moodScale=mood==='annoyed'?.55:mood==='sleepy'?.65:1;
    const dx=clamp((state.x-state.x0)/45),dy=clamp((state.y-state.y0)/45),side=state.side;
    const out={strength:smooth*fade*moodScale,dx,dy,part:state.part,pose:{},parameters:{},eyes:0,blush:0};
    if(state.part==='head'){out.pose={z:dx*9,y:dy*6-3,pz:-3};out.eyes=state.rubbing?.55:.85;out.parameters={EyeSmile:.6};}
    else if(state.part==='face'){out.pose={x:side*6+dx*5,z:side*-5,y:dy*4};out.parameters={CheeckPuff:.3};out.blush=.5;out.eyes=.85;}
    else if(state.part==='hand'){out.pose={px:side*.8,z:side*-1.6};out.parameters=side<0?{RArm:-.16-dy*.12,RWrist:dx*.18,RHand:dy*.08}:{LArm:.16+dy*.12,LWrist:dx*.18,LHand:dy*.08};}
    else if(state.part==='chest'){out.pose={px:-dx*3,py:dy*2,pz:-3,y:-3,z:side*3};out.blush=.3;}
    else if(state.part==='belly'){out.pose={px:dx*4,py:dy*3,pz:2,z:-dx*5,y:-2};out.parameters={HipAngleX:dx*3};out.eyes=.85;}
    else if(state.part==='leg'){out.pose={px:-side*3,py:Math.abs(dy),z:side*3};out.parameters={LEGAngleZ2:side*4+dx*3,HipAngleZ:-side*2};}
    else if(state.part==='tail'){out.pose={px:dx*.8,x:side*2};out.parameters={Param_Angle_Rotation84:dx*4+side*.8,Param_Angle_Rotation85:dy*3};out.eyes=.9;}
    return out;
  }
  function createSmoother(limits={}){
    const values=new Map();
    return {step(frame={},dt=1/60){
      dt=Math.max(.001,Math.min(.05,dt));const desired=new Map(),k=frame.strength||0;
      for(const [name,value] of Object.entries(frame.pose||{}))desired.set('pose:'+name,value*k);
      for(const [name,value] of Object.entries(frame.parameters||{})){const range=limits[name]?limits[name][1]-limits[name][0]:2;desired.set('parameter:'+name,clamp(value,-range*.2,range*.2)*k);}
      desired.set('blush',(frame.blush||0)*k);desired.set('eyes',frame.eyes?(1-frame.eyes)*k:0);
      const result={pose:{},parameters:{},blush:0,eyes:0};
      for(const name of new Set([...values.keys(),...desired.keys()])){
        const value=values.get(name)||0,target=desired.get(name)||0,param=name.startsWith('parameter:'),id=param?name.slice(10):'',range=param&&limits[id]?limits[id][1]-limits[id][0]:2;
        const speed=param?range*.7:name.startsWith('pose:')?32:3;
        let next=value+clamp((target-value)*(1-Math.exp(-dt*(param?9:12))),-speed*dt,speed*dt);
        if(Math.abs(next)<.0001&&!target){next=0;values.delete(name);}else values.set(name,next);
        if(name.startsWith('pose:'))result.pose[name.slice(5)]=next;else if(param)result.parameters[id]=next;else result[name]=next;
      }
      return result;
    }};
  }
  return {begin,move,finish,sample,profiles,createSmoother};
});
