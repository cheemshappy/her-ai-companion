import crypto from 'node:crypto';
import calendar from './ui/calendar.js';
import {recipientOf} from './message-relevance.mjs';

export const READING_POLICY={version:1,batchMessages:20,batchChars:6000,messageChars:6000,contextMessages:4,contextChars:400};
export const startOfDay=at=>Date.parse(calendar.day(at)+'T00:00:00+08:00');
export const messageRevision=m=>m.contentRevision||crypto.createHash('sha256').update(JSON.stringify([m.text,m.mentions,m.replyTo,m.direction,m.attachments])).digest('hex').slice(0,16);
export const STALE_POLICY={lowValueAfterMs:6*3600000,groupChatterAfterMs:24*3600000,summaryAfterMs:24*3600000};
const actionable=text=>/请|麻烦|记得|截止|提交|回复|确认|会议|开会|作业|待办|通知|提醒|报名|考试|预约|地址|地点|报告|资料|文件|附件|支付|转账|账单|退款|取消|改期|完成|收到.{0,8}(?:报告|材料|资料)|已(?:交|发|办|处理)|明天|后天|下周|\d{1,2}[:：]\d{2}/i.test(text);
function acknowledgement(text){
  const cleaned=String(text).normalize('NFKC').replace(/[\s\p{P}\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D]/gu,'').toLowerCase();
  return cleaned.length<=40&&/^(?:(?:好的?|好哒|好滴|嗯+|哦+|噢+|收到|知道了|明白了|了解了?|谢谢|多谢|不客气|哈哈+|呵呵+|晚安|早安|早上好|午安|ok|okay|hi|hello|表情|动画表情|图片|赞|笑哭|捂脸|呲牙|笑脸))*$/.test(cleaned);
}

/** Local, revision-aware expiry. Skipping is never represented as an AI read. */
export function pruneStaleMessages(messages,reading,{now=Date.now(),events=[],ownerQQ='10001'}={}){
  reading.discarded??={};
  const active=events.filter(e=>e.status==='pending'||e.pinned||e.snoozedUntil>now);
  const protectedKeys=new Set(active.flatMap(e=>e.sourceKeys||[]));
  const referenced=new Set(messages.filter(m=>m.at>=now-STALE_POLICY.summaryAfterMs).map(m=>m.replyTo?.messageId).filter(Boolean));
  for(const m of messages)if(referenced.has(m.messageId))protectedKeys.add(m.key);
  const settled=new Set(events.filter(e=>['done','dismissed','resolved','irrelevant'].includes(e.status)).flatMap(e=>e.sourceKeys||[]));
  let changed=false,added=0;
  for(const m of messages){
    if(m.at<reading.since||m.at>now||!m.text)continue;
    const revision=messageRevision(m),age=now-m.at;
    // A new quote or real unfinished task can make previously discarded context relevant again.
    if(protectedKeys.has(m.key)){
      if(reading.discarded[m.key]){delete reading.discarded[m.key];changed=true;}continue;
    }
    if(reading.discarded[m.key]?.revision===revision)continue;
    let reason='';
    const protectedContent=m.attachments?.length||m.truncated||active.length&&actionable(m.text);
    if(!protectedContent&&age>=STALE_POLICY.lowValueAfterMs){
      if(settled.has(m.key))reason='settled-evidence';
      else if(!active.length&&acknowledgement(m.text))reason='stale-acknowledgement';
      else if(m.kind==='group'&&recipientOf([m],ownerQQ)==='other')reason='stale-other-recipient';
      else if(age>=STALE_POLICY.groupChatterAfterMs&&m.kind==='group'&&recipientOf([m],ownerQQ)==='unclear'&&!actionable(m.text))reason='stale-group-chatter';
    }
    if(reason){reading.discarded[m.key]={revision,at:m.at,discardedAt:now,reason};changed=true;added++;}
    else if(reading.discarded[m.key]){delete reading.discarded[m.key];changed=true;}
  }
  return {changed,added};
}

export function unreadMessages(messages,reading,now=Date.now()){
  return messages.filter(m=>{
    if(m.at<reading.since||m.at>now+60000||!m.text)return false;
    if(reading.discarded?.[m.key]?.revision===messageRevision(m))return false;
    const saved=reading.covered[m.key];
    return !saved||saved.revision!==messageRevision(m)||saved.offset<m.text.length;
  });
}

/** Prefer today's newest messages. Previously queued gaps remain eligible across midnight. */
export function readBatch(messages,reading,now=Date.now()){
  const today=startOfDay(now),pending=unreadMessages(messages,reading,now);
  const latest=pending.slice().sort((a,b)=>Number(b.at>=today)-Number(a.at>=today)||b.at-a.at||a.key.localeCompare(b.key));
  const oldest=pending.slice().sort((a,b)=>a.at-b.at||a.key.localeCompare(b.key))[0];
  // Reserve progress for the oldest gap even in a continuously busy chat.
  const ordered=[...new Map([latest[0],oldest,...latest].filter(Boolean).map(m=>[m.key,m])).values()];
  const segmentChars=Math.min(READING_POLICY.messageChars,Math.max(2000,Math.floor(READING_POLICY.batchChars/Math.min(3,pending.length||1))));
  const selected=[];let remaining=READING_POLICY.batchChars;
  for(const message of ordered){
    if(selected.length>=READING_POLICY.batchMessages||!remaining)break;
    const revision=messageRevision(message),saved=reading.covered[message.key];
    const offset=saved?.revision===revision?saved.offset:0;
    let end=Math.min(message.text.length,offset+segmentChars,offset+remaining);
    // Never split a UTF-16 surrogate pair between requests.
    if(end<message.text.length&&/[\uD800-\uDBFF]/.test(message.text[end-1]))end--;
    if(end<=offset)continue;
    selected.push({...message,text:message.text.slice(offset,end),excerpt:offset>0||end<message.text.length,
      reading:{revision,offset,end,total:message.text.length}});
    remaining-=end-offset;
  }
  return selected.sort((a,b)=>a.at-b.at||a.key.localeCompare(b.key));
}

/** Model-facing reads default to today; the local evidence browser keeps its full retention. */
export function readMessagesForAi(source,args={},now=Date.now()){
  if(args.messageKey){
    const item=source.all().find(m=>m.key===args.messageKey&&(!args.conversation||m.kind+':'+m.conversationId===args.conversation));
    const offset=Math.max(0,Math.floor(Number(args.offset)||0));
    const end=item?Math.min(item.text.length,offset+2000):0;
    return {...source.status(),items:item?[{...item,text:item.text.slice(offset,end),excerpt:offset>0||end<item.text.length,
      textLength:item.text.length,textOffset:offset,nextOffset:end<item.text.length?end:null}]:[],scope:'referenced-message',hasMore:false,nextCursor:null,
      readingHint:'仅补查指定原消息的这一段；nextOffset不为空表示原文尚有后续，不能声称已读全文。'};
  }
  const historical=args.since!==undefined&&args.since!==null&&args.since!=='';
  const since=historical?Math.max(0,Number(args.since)||0):startOfDay(now);
  const page=source.snapshot({...args,since,limit:Math.max(1,Math.min(Number(args.limit)||15,50))});
  let remaining=6000;
  const items=[];
  for(const item of page.items){
    if(!remaining)break;
    let length=Math.min(item.text.length,2000,remaining);
    if(length<item.text.length&&/[\uD800-\uDBFF]/.test(item.text[length-1]))length--;
    items.push({...item,text:item.text.slice(0,length),excerpt:length<item.text.length,textLength:item.text.length,textOffset:0,nextOffset:length<item.text.length?length:null});
    remaining-=length;
  }
  const hasMore=page.hasMore||items.length<page.items.length;
  return {...page,items,hasMore,nextCursor:hasMore?items.at(-1)?.key||null:null,scope:historical?'requested-range':'today',since,
    readingHint:'默认只看北京时间当日最新消息。已有事项沿用看板摘要；只有主人明确要求查历史，或本轮消息引用的具体内容确实缺失时才按会话限定范围补查。excerpt表示节选，不能声称已读全文。'};
}

/** No second truncation here: every new-message segment must reach the model. */
export function summaryInput(messages,context={},now=Date.now()){
  const fresh=new Set(messages.map(m=>m.key));
  const prior=(context.priorEvidence||[]).filter(m=>!fresh.has(m.key)).slice(0,READING_POLICY.contextMessages);
  const included=[...prior,...messages].map(m=>({key:m.key,who:m.who,kind:m.kind,source:m.source,ownerId:m.ownerId,
    direction:m.direction,sender:m.sender,senderId:m.senderId,time:m.at,sentAt:calendar.format(m.at,{seconds:true}),sentDay:calendar.day(m.at),
    text:m.text,mentions:m.mentions,replyTo:m.replyTo,excerpt:!!m.excerpt,reading:m.reading,contextOnly:!fresh.has(m.key),attachments:m.attachments}));
  return {now:new Date(now).toISOString(),ownerQQ:context.ownerQQ,conversationKind:context.kind,mode:'incremental',
    previousSummary:String(context.previousSummary||'').slice(0,600),existingEvents:context.existingEvents||[],messages:included};
}
