(function(){
  'use strict';
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const time=value=>window.HerCalendar.format(value);
  const labels={urgent:'优先处理',today:'今天',later:'稍后',task:'待办',reply:'待回复',info:'知会'};
  let data,filter='pending',options={},loading=false,last=0;
  const $=id=>document.getElementById(id);
  async function request(url,body){const response=await fetch(url,{headers:{'content-type':'application/json'},...(body?{method:'POST',body:JSON.stringify(body)}:{})});const value=await response.json();if(!response.ok||value.ok===false)throw new Error(value.error||'暂未连接，请重试');return value;}
  function notify(text){$('hubFeedback').textContent=text;}
  function eventCard(event){
    const snoozed=event.snoozedUntil>Date.now(),done=event.status!=='pending';
    return `<article class="event-card ${event.priority} ${done?'is-done':''}" data-id="${escape(event.id)}">
      <div class="event-top"><span class="priority-tag">${event.pinned?'已置顶 · ':''}${event.overdue?'往期待处理':labels[event.priority]}</span><span class="event-kind">${labels[event.kind]||'事项'}</span></div>
      <h3>${escape(event.title)}</h3><p class="event-reason">${escape(event.reason||'自己记下的事')}</p>
      <div class="event-origin">${escape(event.who)}${event.needsReview?' · 待你确认':''}${event.sourceAt?' · 消息 '+escape(time(event.sourceAt)):''}${event.targetDay&&!event.deadline?' · 事项日期 '+escape(event.targetDay):''}${event.deadline?' · '+escape(time(event.deadline))+' 前':''}${snoozed?' · '+time(event.snoozedUntil)+' 再看':''}</div>
      <div class="event-actions">${done?'<button data-action="reopen">恢复待办</button>':`<button class="action-primary" data-action="done">完成</button><button data-action="snooze">稍后处理</button>`}
      ${event.conversation?'<button data-action="evidence">查看原消息</button>':''}<button data-action="pin" aria-label="${event.pinned?'取消置顶':'置顶事项'}">${event.pinned?'取消置顶':'置顶'}</button>${event.conversation&&!done?'<button data-action="dismiss">不用我处理</button>':''}</div></article>`;
  }
  function paint(){
    if(!data)return;const active=data.events.filter(e=>e.status==='pending'),snoozed=e=>e.snoozedUntil>Date.now();
    $('hubPendingCount').textContent=data.counts.pending;$('hubUrgentCount').textContent=data.counts.urgent;$('hubMessageCount').textContent=data.counts.messages;
    $('hubDate').textContent=window.HerCalendar.day();
    const wechat=data.source.wechat;
    $('inboxNotice').textContent=(data.source.connected?'QQ主号已连接 · 免打扰接收':'QQ主号暂未连接')+(data.source.recovery?.available?' · 已补读':'')+' ｜ '+(wechat?.available?'微信后台读取中 · '+time(wechat.lastCheckAt):wechat?.configured?'微信暂不可读 · 保留上次记录':'微信未接入');
    $('inboxNotice').classList.toggle('offline',!data.source.connected&&!wechat?.available);
    $('hubStatus').textContent=data.running||data.counts.reviewing?'正在复核与你有关的事项…':data.error|| (data.counts.reviewDeferred?'有 '+data.counts.reviewDeferred+' 条旧事项等待补充依据，已保留原记录':data.updatedAt?'上次整理 '+time(data.updatedAt):'新消息到达后自动整理');
    if(data.reading?.discarded)$('hubStatus').textContent+=' · 已略过 '+data.reading.discarded+' 条过期闲聊';
    const visible=data.events.filter(e=>filter==='done'?e.status==='done':filter==='snoozed'?e.status==='pending'&&snoozed(e):e.status==='pending'&&!snoozed(e));
    $('hubEvents').hidden=filter==='messages';$('hubConversations').hidden=filter!=='messages';
    $('hubEvents').innerHTML=visible.length?visible.map(eventCard).join(''):`<div class="hub-empty"><span class="empty-orbit">◌</span><h3>${filter==='done'?'完成的事会留在这里':filter==='snoozed'?'暂时没有延后的事项':'此刻，可以从容一点'}</h3><p>${active.length?'还有事项已安排到稍后。':'新消息会自动整理在这里。你也可以查看全部消息。'}</p></div>`;
    $('hubConversations').innerHTML=data.conversations.length?data.conversations.map(c=>`<button class="conversation-card" data-conversation="${escape(c.id)}"><span class="conversation-mark">${escape(c.who.slice(0,1))}</span><span class="conversation-body"><strong>${escape(c.who)}</strong><small>${c.count} 条 · ${time(c.lastMessageAt)}${c.pending?' · 待整理':''}</small><span>${escape(c.summary||c.preview)}</span>${c.incomplete?'<em>含尚未解析的附件，点击核对</em>':''}</span><span aria-hidden="true">↗</span></button>`).join(''):'<div class="hub-empty"><h3>暂未收到消息</h3><p>接收在线后，这里会保留完整文字和附件状态。</p></div>';
    document.querySelectorAll('[data-hub-filter]').forEach(button=>{const selected=button.dataset.hubFilter===filter;button.classList.toggle('on',selected);button.setAttribute('aria-pressed',String(selected));});
    const media=data.media;$('mediaCard').hidden=!media;
    if(media){$('mediaTitle').textContent=media.title||media.query||'刚打开的视频';$('mediaStatus').textContent=(media.playbackVerified?media.playing?'正在播放':'已暂停':'播放状态待确认')+' · '+(media.fullscreen?'已全屏':'全屏待确认');}
  }
  async function render(force=false){
    if(loading||!force&&Date.now()-last<8000)return;loading=true;
    try{data=await request('/api/hub?sessionId='+encodeURIComponent(window.HerPresence?.sessionId||'default'));last=Date.now();paint();}
    catch(error){notify(error.message);}finally{loading=false;}
  }
  async function showConversation(id,event){
    const dialog=$('hubDetail'),content=$('hubDetailContent');let cursor='',all=[];
    const title=data.conversations.find(c=>c.id===id)?.who||event?.who||'原消息';$('hubDetailTitle').textContent=title;
    async function load(){
      const page=await request('/api/messages?'+new URLSearchParams({conversation:id,limit:'50',before:cursor}));
      all.push(...page.items);cursor=page.nextCursor||'';
      content.innerHTML=(event?`<div class="evidence-note">事项依据已标出。${event.evidenceAvailable===false?'部分依据已超过保留期限。':''}</div>`:'')+all.map(m=>`<article class="original-message ${event?.sourceKeys.includes(m.key)?'is-evidence':''}"><header><strong>${escape(m.sender)}${m.direction==='outgoing'?' · 我已发送':''}</strong><time>${time(m.at)}</time></header><p>${escape(m.text)}</p>${m.truncated?'<small>超长消息已达保存上限，请到原应用核对后续内容。</small>':''}</article>`).join('');
      $('hubLoadMore').hidden=!page.hasMore;
    }
    content.textContent='正在读取原消息…';dialog.showModal();
    $('hubLoadMore').onclick=()=>void load().catch(e=>notify(e.message));
    $('hubReply').onclick=()=>{
      const wechat=all[0]?.source==='desktop-wechat'||id.includes(':wechat:');
      const platform=wechat?'微信':'QQ',reader=wechat?'phone_wechat_desktop':'phone_qq_desktop';
      const recipient=title.replace(/^(?:微信|QQ)\s*[·：:]\s*/,'');
      const text='请替我回复'+platform+'里的「'+recipient+'」并直接发送。先用'+reader+'读取这个会话的最新消息，conversation='+id+'，limit=15，结合已知事实写合适的简短回复并发送。'+(event?'当前事项：「'+event.title+'」。':'')+'收件人或必要事实缺失时说明缺少什么。';
      if(!options.reply||options.reply(text)===false){notify('正在处理上一件事，请稍后再点回复');return;}
      dialog.close();
    };
    try{await load();if(event&&cursor&&!all.some(m=>event.sourceKeys.includes(m.key)))await load();content.querySelector('.is-evidence')?.scrollIntoView({block:'center'});}catch(e){content.textContent=e.message;}
  }
  function boot(){
    $('hubRefresh')?.addEventListener('click',async()=>{try{await request('/api/hub/refresh',{});notify('已安排整理，新结果会自动更新');await render(true);}catch(e){notify(e.message);}});
    document.querySelectorAll('[data-hub-filter]').forEach(button=>button.onclick=()=>{filter=button.dataset.hubFilter;paint();});
    $('hubEvents')?.addEventListener('click',async ev=>{
      const button=ev.target.closest('[data-action]');if(!button)return;const card=button.closest('[data-id]'),item=data.events.find(e=>e.id===card.dataset.id);if(!item)return;
      if(button.dataset.action==='evidence'){void showConversation(item.conversation,item);return;}
      button.disabled=true;
      try{const updated=await request('/api/hub/action',{id:item.id,action:button.dataset.action,until:Date.now()+3*3600000});data={...updated,media:data.media};paint();notify(button.dataset.action==='snooze'?'已移到稍后，3小时后回到待处理':'已更新事项');}catch(e){notify(e.message);button.disabled=false;}
    });
    $('hubConversations')?.addEventListener('click',ev=>{const button=ev.target.closest('[data-conversation]');if(button)void showConversation(button.dataset.conversation);});
    $('hubDetailClose')?.addEventListener('click',()=>$('hubDetail').close());
    $('hubAdd')?.addEventListener('submit',async ev=>{ev.preventDefault();const input=$('hubNewTask');if(!input.value.trim())return;try{await request('/api/todo',{action:'add',text:input.value.trim()});input.value='';await render(true);notify('已记到待办');}catch(e){notify(e.message);}});
    document.querySelectorAll('[data-media-action]').forEach(button=>button.onclick=()=>options.media?.(button.dataset.mediaAction));
    setInterval(()=>{if(document.body.dataset.page==='inbox'&&!document.hidden&&!$('hubDetail').open)void render(true);},15000);
  }
  window.HerHub={render,configure:value=>{options={...options,...value};}};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
