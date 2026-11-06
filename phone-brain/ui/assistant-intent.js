/* Explicit owner shortcuts. Quoted data and conversational mentions are not commands. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.HerIntent=api;})(globalThis,function(){
  'use strict';
  function request(text){
    const value=String(text||'').trim();
    if(!value||value.length>240||/[\n\r]/.test(value)||/^(?:解释|翻译|为什么|比如|例如|他说|她说|消息里|视频里|不要|别|不用|暂不|先不)/.test(value))return null;
    return value.replace(/^(?:(?:请你?|帮我|给我|麻烦你?|能不能|能否|可不可以|可以|你|大肥鱼)[，,\s]*)+/,'');
  }
  function character(text){
    const t=request(text);
    if(!t||t.length>90||/^(?:我|我们|她|他|昨天|刚才|已经|假如|如果)/.test(t)||/B站|哔哩|视频|搜索|教程|动作库|怎么|为什么|什么意思|不让|不能|不要|别|不许|不必|不想|不需要|[“「"].+[”」"]/.test(t))return null;
    const soft= /一点|轻轻|稍微/.test(t),duration=8,intensity=soft?.7:.85;
    const closer=/靠近|凑近|贴近|再近|近一点|近点/.test(t),lean=/前倾|往前倾|向前倾|俯身|探身/.test(t);
    const feeling=/害羞|脸红/.test(t)?{mood:'shy',expressions:['脸红']}:{};
    if(closer||lean)return {gesture:closer?'approach':'lean',duration,intensity,plan:[],...feeling};
    if(/退后|后退|离远|远一点|远点/.test(t))return {gesture:'retreat',duration,intensity,plan:[]};
    if(/站直|恢复(?:原来|正常|默认)(?:的)?(?:姿势|站姿|距离)|回到原位/.test(t))return {gesture:'settle',duration:2,intensity:.6,expressions:[],plan:[]};
    const gestures=[[/挥(?:挥)?手|招(?:招)?手/,'wave'],[/点(?:点)?头/,'nod'],[/摇(?:摇)?头/,'shake'],[/歪(?:歪)?头/,'tilt'],[/举(?:起)?手|抬(?:起)?手/,'raise'],[/鞠(?:个)?躬/,'bow'],[/打(?:个)?哈欠/,'yawn']];
    const match=gestures.find(([pattern])=>pattern.test(t));
    return match?{gesture:match[1],duration:4,intensity,plan:[],...feeling}:null;
  }
  function bilibili(text){
    const t=request(text);
    if(!t||/^(?:是否|怎么|为什么)|(?:不要|别|暂不|先不).{0,5}(?:搜|找|播放)|不让搜|不能搜/.test(t))return null;
    const site='(?:[bB]站|哔哩哔哩|[bB]ilibili)';
    const verb='(?:搜索(?:一下|下)?(?!一下|下)|搜(?:一下|下)?(?!索|一下|下)|查找|找(?:一下|下)?(?!一下|下))';
    const match=t.match(new RegExp('^(?:在|去|到|用|打开)?'+site+'(?:里|上|中)?[，,\\s]*(?:帮我|给我)?(?:只)?'+verb+'[：:\\s]*(.+)$'))
      ||t.match(new RegExp('^(?:只)?'+verb+'(?:在)?'+site+'(?:上|里|中)?(?:的)?[：:\\s]*(.+)$'));
    if(!match)return null;
    let query=match[1].trim(),action='search';
    const playback=/(?:并|然后|再)(?:帮我)?(?:自动)?(?:全屏)?(?:播放|打开)(?:一下|下)?[。！!]?$/;
    if(playback.test(query)){action='play';query=query.replace(playback,'').trim();}
    query=query.replace(/[。！!]+$/,'').replace(/^[「“"](.+)[」”"]$/,'$1').trim();
    if(!query||query.length>160)return null;
    return {action,query,...(action==='play'?{fullscreen:!/不要全屏|小窗/.test(t)}:{})};
  }
  return {character,bilibili};
});
