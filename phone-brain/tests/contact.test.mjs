import test from 'node:test';import assert from 'node:assert/strict';import T from '../ui/contact.js';
test('light rubbing works on all regions and yields distinct continuous body responses',()=>{
  const signatures=[];
  for(const part of ['head','face','hand','chest','belly','leg','tail']){
    const state=T.begin({part,x:.4},100,100,1000);T.move(state,104,102,1280,{part,x:.4});T.move(state,98,101,1400,{part,x:.4});
    const value=T.sample(state,1450,'calm');assert.ok(value.strength>.8);assert.equal(T.finish(state,1500).kind,'rub');
    signatures.push(JSON.stringify({pose:value.pose,parameters:value.parameters}));
    state.released=1500;assert.equal(T.sample(state,2000).strength,0);
  }assert.equal(new Set(signatures).size,7);
});
test('finger can move between regions while model movement alone does not change the touched part',()=>{
  const state=T.begin({part:'hand',x:.3},100,100,1000);
  T.move(state,104,100,1300,{part:'head',x:.3});T.move(state,98,100,1400,{part:'head',x:.3});assert.equal(state.part,'hand');
  T.move(state,140,140,1600,{part:'belly',x:.5});const result=T.finish(state,1800);assert.deepEqual(result.parts,['hand','belly']);assert.equal(result.part,'belly');
  assert.equal(T.finish(state,1800,true),null);
});
test('fast swipes are not a rub, and emotion changes strength without changing the actual observation',()=>{
 const state=T.begin({part:'tail',x:.8},100,100,1000);T.move(state,170,100,1100,{part:'tail',x:.8});assert.equal(T.finish(state,1130),null);
 T.move(state,165,100,1400,{part:'tail',x:.8});assert.ok(T.sample(state,1500,'annoyed').strength<T.sample(state,1500,'happy').strength);assert.equal(T.finish(state,1500).part,'tail');
});
test('hand offsets respect the rig range and repeated presses keep frame-to-frame continuity',()=>{
 const limits={RArm:[-1,1],RWrist:[-1,1],RHand:[-1,1],Param_Angle_Rotation84:[-45,45],Param_Angle_Rotation85:[-45,45]},smoother=T.createSmoother(limits);let before={};
 for(let i=0;i<240;i++){
  const state=T.begin({part:i<120?'hand':'tail',x:.3},100,100,0);T.move(state,i%30<15?145:55,100,600,{part:state.part,x:.3});
  const frame=T.sample(state,800),out=smoother.step(i%30<3?{}:frame,1/60);
  for(const [id,value] of Object.entries(out.parameters)){const range=limits[id]?limits[id][1]-limits[id][0]:2;assert.ok(Math.abs(value)<=range*.2+.0001);assert.ok(Math.abs(value-(before[id]||0))<=range*.7/60+.0001);}
  before=out.parameters;
 }
 const hand=T.sample(T.begin({part:'hand',x:.3},0,0,0),500);assert.ok(Math.abs(hand.parameters.RArm)<.3);
});
