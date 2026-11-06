/* Shared by main and floating UI. A requested message is already authorized. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.HerActions=api;})(globalThis,function(){
  'use strict';
  const intent=typeof module==='object'&&module.exports?require('./assistant-intent.js'):globalThis.HerIntent;
  let messageAuthorized=false,ownerTurn=false;
  let draftOnly=false;
  let fullscreenPreferred=true;
  function begin(text){
    const value=String(text);
    fullscreenPreferred=!/(不要|别|不必|不用).{0,3}全屏|小窗|半屏|竖屏播放/.test(value);
    // Rejecting the draft workflow is a request to send, not a no-send order.
    const instruction=value.replace(/(?:不用|不必|不要|别)(?:再|先)?(?:只|仅)?(?:写|拟|留)(?:一[条份个])?草稿(?:[，,、\s]*(?:不发送|不发出))?/g,'');
    const composeOnly=/拟一|拟个/.test(instruction)&&!/(发送|发出|发给)/.test(instruction);
    draftOnly=composeOnly||/(不要|别|先不|暂不|不).{0,3}(发送|发出|发给|回复)|只.{0,3}(拟|草稿)|先写.{0,5}草稿|只看|只读|仅查看|do not send|draft only/i.test(instruction);
    // The owner has granted routine actions. Do not try to prove permission
    // again using a short Chinese verb regex (long names and ellipses broke it).
    ownerTurn=!!value.trim();messageAuthorized=ownerTurn&&!draftOnly;
    return messageAuthorized;
  }

  function check(call){
    const a=call.args||{};
    if(!ownerTurn)return '当前没有主人正在委托的操作';
    const sends=['phone_wechat_reply','phone_wechat_send','phone_send_message'].includes(call.name)||call.name==='phone_tap_text'&&/^(发送|发送消息|发送给)$/.test(String(a.text||'').trim());
    if(sends&&!messageAuthorized)return draftOnly?'主人本轮要求只查看或拟草稿，不要发送':'当前没有主人正在委托的操作';
    return null;
  }
  function prepare(call){
    if(call.name==='phone_bilibili'&&(!call.args?.action||call.args.action==='play'))return {...call,args:{...call.args,fullscreen:fullscreenPreferred}};
    return call.name==='phone_wechat_send'&&messageAuthorized?{...call,args:{...call.args,confirm:true}}:call;
  }
  const isAction=text=>/记忆|记得|上次|之前聊|聊过|昨天聊|remember|帮|打开|播放|全屏|暂停|继续播|下一首|上一首|搜索|搜一下|输入|找.{0,12}(视频|歌)|微信|\bqq\b|B站|哔哩|bilibili|屏幕|手机|消息|发送|回复|回.{0,5}(他|她)|转告|告诉他|闹钟|提醒|待办|音量|亮度|蓝牙|飞行模式|wifi|天气|电量|存储|開いて|再生|検索|入力|返信|送信|\b(open|play|pause|search|send|reply|type|volume|brightness)\b/i.test(String(text));
  return {begin,check,prepare,isAction:text=>isAction(text)||!!intent?.character(text),canSend:()=>messageAuthorized};
});
