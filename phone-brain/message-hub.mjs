import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {ANALYSIS_VERSION,actionability,sameEvent,canonicalTitle} from './message-relevance.mjs';
import {eventTiming,presentEventTime} from './message-time.mjs';
import {READING_POLICY,STALE_POLICY,startOfDay,messageRevision,unreadMessages,readBatch,pruneStaleMessages} from './message-reading.mjs';

const digest=value=>crypto.createHash('sha256').update(value).digest('hex').slice(0,24);
const priorities=['urgent','today','later'];
const versionOf=messages=>ANALYSIS_VERSION+':'+digest(messages.map(m=>m.key+':'+(m.contentRevision||'')).join('|'));
export function fallbackAnalysis(messages){
  return {summary:messages.length+' 条新消息，自动摘要暂不可用，可查看原文。',events:messages.filter(m=>/请|麻烦|记得|截止|提交|回复|确认|会议|开会|作业|待办/.test(m.text)).slice(-8).map(m=>({
    title:m.text.replace(/\s+/g,' ').slice(0,80),priority:/紧急|马上|立即|截止|尽快/.test(m.text)?'urgent':/今天|今日|今晚/.test(m.text)?'today':'later',
    kind:/回复|确认|答复/.test(m.text)?'reply':'task',reason:'按原文关键词初步整理，请核对',sourceKeys:[m.key],deadline:null,needsReview:true,
  }))};
}

/** Summarize untrusted messages as data; all actions update local planning state only. */
export function createMessageHub({file,source,complete,now=Date.now,readTodos=()=>[],finishTodo=()=>{},scheduleMs=18000,ownerQQ='10001'}){
  let state={conversations:{},events:[],todoMeta:{},updatedAt:0},running=false,timer=null,dirty=false,lastError='',lastAttempt=0;
  try{const saved=JSON.parse(fs.readFileSync(file,'utf8'));if(saved&&Array.isArray(saved.events))state={...state,...saved};}catch{}
  let readingReady=state.reading?.version===READING_POLICY.version&&Number.isFinite(state.reading.since)&&!!state.reading.covered;
  if(!readingReady)state.reading={version:READING_POLICY.version,since:startOfDay(now()),covered:{}};
  function save(){if(!file)return;fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(state));fs.renameSync(temp,file);}
  function groups(){const map=new Map();for(const message of source.all()){
    const id=message.kind+':'+message.conversationId;if(!map.has(id))map.set(id,[]);map.get(id).push(message);
  }for(const list of map.values())list.sort((a,b)=>a.at-b.at||a.key.localeCompare(b.key));return map;}
  function initializeReading(grouped){
    if(readingReady)return;
    // Reuse a verifiable old summary, including only the characters the old
    // 24k/2500-character request builder could actually have supplied.
    for(const [id,all] of grouped){
      const recent=all.slice(-60),saved=state.conversations[id];
      if(!saved?.ai||saved.version!==versionOf(recent))continue;
      let remaining=24000;
      for(const message of recent.slice().reverse()){
        const offset=Math.min(message.text.length,2500,remaining);remaining-=offset;
        if(offset&&message.at>=state.reading.since)state.reading.covered[message.key]={revision:messageRevision(message),offset,at:message.at};
      }
    }
    readingReady=true;save();
  }
  async function refresh(){
    if(running)return snapshot();running=true;dirty=false;lastAttempt=now();lastError='';
    try{
      let processed=0;const grouped=groups();initializeReading(grouped);
      const availableKeys=new Set(source.all().map(m=>m.key));
      // Do not erase coverage for a still-present old message and then pay to read it again.
      let retentionChanged=false;
      for(const ledger of [state.reading.covered,state.reading.discarded||{}])for(const [key,entry] of Object.entries(ledger))if(entry.at<now()-8*86400000&&!availableKeys.has(key)){delete ledger[key];retentionChanged=true;}
      // Local cleanup must cover every conversation, even when paid processing
      // is limited to three batches or unavailable because of budget/backoff.
      for(const [id,all] of grouped)if(pruneStaleMessages(all,state.reading,{now:now(),events:state.events.filter(e=>e.conversation===id),ownerQQ}).changed)retentionChanged=true;
      if(retentionChanged)save();
      for(const [id,all] of [...grouped].sort((a,b)=>b[1].at(-1).at-a[1].at(-1).at)){
        const messages=readBatch(all,state.reading,now()),version=versionOf(all.slice(-60));
        const old=state.events.filter(e=>e.conversation===id&&e.status==='pending'&&e.analysisVersion!==ANALYSIS_VERSION);
        const allKeys=new Set(all.map(m=>m.key));let deferredChanged=false;
        for(const event of old)if(!event.sourceKeys.some(key=>allKeys.has(key))&&event.reviewDeferredVersion!==version){event.reviewDeferredVersion=version;event.reviewDeferredReason='missing_evidence';deferredChanged=true;}
        if(deferredChanged)save();
        const unreviewed=old.filter(e=>e.reviewDeferredVersion!==version);
        // No new content means no paid re-summary, including after midnight,
        // restart, retention pruning or repeated manual refreshes.
        if(!messages.length||state.conversations[id]?.retryAfter>now())continue;
        if(processed++>=3){dirty=true;break;}
        let analysis,ai=false;
        const existingEvents=[...unreviewed.slice(0,4),...state.events.filter(e=>e.conversation===id&&(e.status==='pending'||e.pinned||e.snoozedUntil>now())&&!unreviewed.includes(e)).slice(-8)].slice(0,12);
        const freshKeys=new Set(messages.map(m=>m.key)),lookup=new Map(all.map(m=>[m.key,m]));
        const quoted=messages.flatMap(m=>m.replyTo?.messageId?all.filter(old=>old.messageId===m.replyTo.messageId).map(old=>old.key):[]);
        const overlap=all.filter(m=>!freshKeys.has(m.key)&&m.at>=now()-STALE_POLICY.summaryAfterMs&&!state.reading.discarded?.[m.key]&&state.reading.covered[m.key]?.revision===messageRevision(m)&&state.reading.covered[m.key].offset>=m.text.length).slice(-2).map(m=>m.key);
        const representativeKeys=[...new Set([...quoted,...existingEvents.flatMap(e=>e.sourceKeys.slice(-1)),...overlap])];
        const priorEvidence=representativeKeys.filter(key=>!freshKeys.has(key)&&lookup.has(key)&&(!state.reading.discarded?.[key]||quoted.includes(key))).slice(0,READING_POLICY.contextMessages).map(key=>{const m=lookup.get(key);return {...m,text:m.text.slice(0,READING_POLICY.contextChars),excerpt:m.text.length>READING_POLICY.contextChars};});
        const previous=state.conversations[id],keepSummary=existingEvents.length||previous?.lastMessageAt>=now()-STALE_POLICY.summaryAfterMs;
        const context={ownerQQ,reviewing:unreviewed.length>0,kind:messages.at(-1).kind,previousSummary:keepSummary?previous?.summary||'':'',
          existingEvents:existingEvents.map(e=>({id:e.id,title:e.title,kind:e.kind,status:e.status,sourceKeys:e.sourceKeys.slice(-2),topicKey:e.topicKey,deadline:e.deadline,reason:e.reason})),priorEvidence};
        try{analysis=await complete(messages,context);if(typeof analysis?.summary!=='string'||!Array.isArray(analysis?.events))throw new Error('invalid summary');ai=true;}catch{analysis=fallbackAnalysis(messages);lastError='自动摘要暂不可用，已按原文整理待确认事项';}
        const reviewedKeys=Array.isArray(analysis.reviewedKeys)?new Set(analysis.reviewedKeys):null;
        let acknowledged=0;
        const allowed=new Map([...context.priorEvidence,...messages].filter(m=>!reviewedKeys||reviewedKeys.has(m.key)).map(m=>[m.key,m]));
        const summary=String(analysis?.summary||'').trim().slice(0,900);
        state.conversations[id]={id,who:all.at(-1).who,summary:ai?summary||'新消息已收录，可查看原文':state.conversations[id]?.summary||summary,
          version:ai?version:'retry:'+version,at:now(),lastMessageAt:all.at(-1).at,count:all.length,
          summaryCount:state.conversations[id]?.summaryCount||0,lastBatchCount:messages.length,ai,retryAfter:0};
        const candidates=Array.isArray(analysis?.events)?analysis.events.filter(e=>e&&typeof e==='object').slice(0,12):[];
        const retained=new Set();
        for(const candidate of candidates){
          const refs=[...new Set((Array.isArray(candidate.sourceKeys)?candidate.sourceKeys:[]).filter(key=>allowed.has(key)))].slice(0,12);
          const title=String(candidate.title||'').trim().slice(0,120);if(!title||!refs.length)continue;
          const refsMessages=refs.map(key=>allowed.get(key));
          const recipientEvidence=String(candidate.recipientEvidence||'').trim().slice(0,160);
          const verifiedCandidate={...candidate,recipientEvidence:recipientEvidence.length>=2&&refsMessages.some(m=>m.text.includes(recipientEvidence))?recipientEvidence:''};
          const relevance=actionability(verifiedCandidate,refsMessages,String(ownerQQ));
          const rawDeadline=String(candidate.deadline||''),deadline=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\+08:00|Z)$/.test(rawDeadline)&&Number.isFinite(Date.parse(rawDeadline))?rawDeadline:null;
          const proposed={title,deadline,kind:['task','reply','info'].includes(candidate.kind)?candidate.kind:'task',sourceKeys:refs,topicKey:String(candidate.topicKey||'').slice(0,120),occurrence:String(candidate.occurrence||'').slice(0,40)};
          const eligible=state.events.filter(e=>e.conversation===id&&e.status!=='merged');
          const explicit=eligible.find(e=>e.id===candidate.existingId&&sameEvent(e,proposed,{explicit:true}));
          const existing=explicit||eligible.find(e=>sameEvent(e,proposed));
          const key=existing?.id||digest(id+'|'+title+'|'+(deadline||proposed.occurrence||refs[0]));
          const event={id:key,conversation:id,who:messages.at(-1).who,title,
            priority:priorities.includes(candidate.priority)?candidate.priority:'later',kind:['task','reply','info'].includes(candidate.kind)?candidate.kind:'task',
            reason:String(candidate.reason||'').slice(0,240),deadline,sourceKeys:[...new Set([...(existing?.sourceKeys||[]),...refs])].slice(-24),ai,needsReview:!ai||candidate.needsReview!==false,
            ...relevance,topicKey:proposed.topicKey||existing?.topicKey||'',occurrence:proposed.occurrence||existing?.occurrence||'',recipientEvidence:verifiedCandidate.recipientEvidence,analysisVersion:ANALYSIS_VERSION,
            at:Math.max(...refs.map(ref=>allowed.get(ref).at)),...eventTiming({...candidate,deadline},refsMessages,now()),status:existing?.status==='done'||existing?.status==='dismissed'?existing.status:!relevance.required?'irrelevant':candidate.resolved===true?'resolved':'pending',snoozedUntil:existing?.snoozedUntil||0,pinned:existing?.pinned||false};
          if(existing)Object.assign(existing,event);else state.events.push(event);
          retained.add(key);
        }
        if(ai){
          // Review old cards explicitly. A capped event list is not evidence
          // that every omitted task has disappeared.
          for(const decision of Array.isArray(analysis.decisions)?analysis.decisions.filter(d=>d&&typeof d==='object').slice(0,80):[]){
            const event=existingEvents.find(e=>e.id===decision.id);
            const decisionKeys=Array.isArray(decision.sourceKeys)?decision.sourceKeys:[];
            if(!event||event.status!=='pending'||retained.has(event.id)||![...event.sourceKeys,...decisionKeys].some(key=>allowed.has(key)))continue;
            if(['irrelevant','resolved','keep'].includes(decision.state)&&String(decision.reason||'').trim()){
              const evidence=[...new Set([...event.sourceKeys,...decisionKeys])].map(key=>allowed.get(key)).filter(Boolean),quote=String(decision.recipientEvidence||'');
              const relevance=actionability({kind:event.kind,recipient:decision.recipient,recipientEvidence:quote.length>=2&&evidence.some(m=>m.text.includes(quote))?quote:''},evidence,String(ownerQQ));
              event.status=decision.state==='keep'?(relevance.required?'pending':'irrelevant'):decision.state;event.reviewReason=String(decision.reason).slice(0,240);event.analysisVersion=ANALYSIS_VERSION;
            }
          }
          const current=state.events.filter(e=>e.conversation===id&&e.status!=='merged');
          for(let i=0;i<current.length;i++)for(let j=i+1;j<current.length;j++){
            let a=current[i],b=current[j];if(a.status==='merged'||b.status==='merged'||!sameEvent(a,b))continue;
            // Keep stable interaction IDs and all user decisions when consolidating.
            if((b.status==='done'||b.status==='dismissed')&&a.status!==b.status||b.analysisVersion===ANALYSIS_VERSION&&a.analysisVersion!==ANALYSIS_VERSION)[a,b]=[b,a];
            a.sourceKeys=[...new Set([...a.sourceKeys,...b.sourceKeys])].slice(-24);a.pinned=!!(a.pinned||b.pinned);a.snoozedUntil=Math.max(a.snoozedUntil||0,b.snoozedUntil||0);b.status='merged';b.mergedInto=a.id;
          }
          // An omitted old card stays pending. Wait for new context instead of
          // paying repeatedly to ask the same question about the same evidence.
          for(const event of unreviewed)if(event.status==='pending'&&event.analysisVersion!==ANALYSIS_VERSION){
            event.reviewAttempts=(event.reviewAttemptVersion===version?event.reviewAttempts||0:0)+1;event.reviewAttemptVersion=version;
            event.reviewDeferredVersion=version;event.reviewDeferredReason='waiting_new_context';
          }
        }
        if(ai)for(const message of messages)if(!reviewedKeys||reviewedKeys.has(message.key)){
          state.reading.covered[message.key]={revision:message.reading.revision,offset:message.reading.end,at:message.at};acknowledged++;
        }
        state.conversations[id].summaryCount=all.filter(m=>state.reading.covered[m.key]?.revision===messageRevision(m)&&state.reading.covered[m.key].offset>=m.text.length).length;
        state.conversations[id].retryAfter=ai&&acknowledged?0:now()+300000;
        if(ai&&acknowledged&&unreadMessages(all,state.reading,now()).length)dirty=true;
        state.updatedAt=now();state.events=state.events.slice(-1000);save();
      }
    }catch{lastError='整理暂未完成，原消息已保留';}
    finally{running=false;if(dirty)schedule();}
    return snapshot();
  }
  function snapshot(){
    const grouped=groups();initializeReading(grouped);
    const all=source.all(),lookup=new Map(all.map(m=>[m.key,m])),conversations=[...grouped].map(([id,messages])=>({
      id,who:messages.at(-1).who,...state.conversations[id],count:messages.length,lastMessageAt:messages.at(-1).at,
      pending:unreadMessages(messages,state.reading,now()).length>0,
      unread:unreadMessages(messages,state.reading,now()).length,
      preview:messages.at(-1).text.slice(0,180),incomplete:messages.some(m=>m.truncated||m.attachments?.some(a=>!a.readable)),
    })).sort((a,b)=>b.lastMessageAt-a.lastMessageAt);
    const legacy=readTodos().map(todo=>({id:'todo:'+todo.id,title:todo.text,kind:'task',priority:'later',who:'我的待办',at:todo.at||now(),status:todo.done?'done':'pending',sourceKeys:[],conversation:'',needsReview:false,...state.todoMeta['todo:'+todo.id]}));
    const versions=new Map([...grouped].map(([id,messages])=>[id,versionOf(messages.slice(-60))]));
    const pendingConversations=new Set(conversations.filter(c=>c.pending).map(c=>c.id));
    const old=state.events.filter(e=>e.status==='pending'&&e.analysisVersion!==ANALYSIS_VERSION);
    const reviewDeferred=old.filter(e=>e.reviewDeferredVersion===versions.get(e.conversation)||!pendingConversations.has(e.conversation)).length,reviewing=old.length-reviewDeferred;
    const events=[...state.events.filter(e=>!['merged','irrelevant','withdrawn','resolved','dismissed'].includes(e.status)&&e.kind!=='info'&&(e.status!=='pending'||e.analysisVersion===ANALYSIS_VERSION||e.pinned)).map(e=>{
      const evidence=e.sourceKeys.map(key=>lookup.get(key)).filter(Boolean);
      return presentEventTime({...e,...eventTiming(e,evidence.length?evidence:[{at:e.at,text:''}],now()),evidenceAvailable:evidence.length>0},now());
    }),...legacy].sort((a,b)=>Number(!!b.pinned)-Number(!!a.pinned)||priorities.indexOf(a.priority)-priorities.indexOf(b.priority)||a.at-b.at);
    const active=events.filter(e=>e.status==='pending'&&!(e.snoozedUntil>now()));
    return {ok:true,updatedAt:state.updatedAt,running,error:lastError,source:source.status(),conversations,events,
      reading:{policy:'today-first-incremental',since:state.reading.since,pending:conversations.reduce((n,c)=>n+c.unread,0),
        queuedPreviousDays:unreadMessages(all,state.reading,now()).filter(m=>m.at<startOfDay(now())).length,batchChars:READING_POLICY.batchChars,
        retention:'discard-stale-low-value',discarded:Object.values(state.reading.discarded||{}).length,lowValueAfterHours:STALE_POLICY.lowValueAfterMs/3600000,groupChatterAfterHours:STALE_POLICY.groupChatterAfterMs/3600000},
      counts:{pending:active.filter(e=>e.kind!=='info').length,urgent:active.filter(e=>e.priority==='urgent').length,today:active.filter(e=>e.priority==='today').length,snoozed:events.filter(e=>e.status==='pending'&&e.snoozedUntil>now()).length,done:events.filter(e=>e.status==='done').length,messages:all.length,reviewing,reviewDeferred},
      overview:all.length?`收到 ${all.length} 条消息，${active.filter(e=>e.kind!=='info').length} 件待处理。`:'还没有收到消息，来源离线时不能判断是否有新消息。'};
  }
  function action({id,action,until}){
    if(String(id).startsWith('todo:')){
      if(!readTodos().some(x=>'todo:'+x.id===id))throw new Error('待办不存在');
      const meta=state.todoMeta[id]||{};
      if(['done','reopen'].includes(action)){finishTodo(String(id).slice(5),action==='done');meta.snoozedUntil=0;}
      else if(action==='pin')meta.pinned=!meta.pinned;
      else if(action==='snooze'){const target=Number(until);if(!Number.isFinite(target)||target<=now()||target>now()+30*86400000)throw new Error('提醒时间无效');meta.snoozedUntil=target;}
      else throw new Error('操作无效');state.todoMeta[id]=meta;state.updatedAt=now();save();return snapshot();
    }
    const event=state.events.find(e=>e.id===id);if(!event)throw new Error('这条事项已不存在，请刷新');
    if(action==='done')event.status='done';else if(action==='dismiss')event.status='dismissed';else if(action==='reopen'){event.status='pending';event.snoozedUntil=0;}
    else if(action==='pin')event.pinned=!event.pinned;
    else if(action==='snooze'){const target=Number(until);if(!Number.isFinite(target)||target<=now()||target>now()+30*86400000)throw new Error('提醒时间无效');event.snoozedUntil=target;}
    else throw new Error('操作无效');state.updatedAt=now();save();return snapshot();
  }
  function schedule(){dirty=true;if(!timer){timer=setTimeout(()=>{timer=null;void refresh();},scheduleMs);timer.unref?.();}}
  function start(){schedule();const interval=setInterval(()=>{if(dirty||now()-lastAttempt>300000)void refresh();},60000);interval.unref();return ()=>{clearInterval(interval);clearTimeout(timer);};}
  return {snapshot,refresh,action,schedule,start};
}
