/* Durable daily history; the visible drawer is a view, never the only copy. */
(function(){
 const log=document.getElementById('log');if(!log)return;
 let selected=window.HerChat.day,items=[],cursor=null,loading=false,generation=0,pendingLoad=null;
 const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 log.innerHTML='<section class="history-shell"><header class="history-header"><div><span class="eyebrow">每天的对话都在这里</span><label for="chatDaySelect" class="sr-only">选择对话日期</label><select id="chatDaySelect"></select></div><button id="chatHistoryClose" aria-label="关闭对话记录">×</button></header><div id="chatHistoryMessages" tabindex="0" aria-label="对话记录"><button id="chatLoadMore" hidden>更早的对话</button><div id="chatHistoryRows"></div><p id="chatHistoryStatus" role="status"></p></div></section>';
 const box=document.getElementById('chatHistoryMessages'),rows=document.getElementById('chatHistoryRows'),days=document.getElementById('chatDaySelect'),more=document.getElementById('chatLoadMore'),status=document.getElementById('chatHistoryStatus');
 function paint(){rows.innerHTML=items.map(m=>`<article class="msg ${m.role==='user'?'me':m.role==='sys'?'sys':''}" data-message-id="${escape(m.id)}"><div class="history-message"><small>${m.kind==='interaction'?'互动 · ':''}${escape(window.HerCalendar.format(m.at))}${m.status==='interrupted'?' · 回复中断':''}</small><div class="t">${escape(m.text)}</div></div></article>`).join('');more.hidden=!cursor;}
 async function request(route){const response=await fetch(route,{cache:'no-store',signal:AbortSignal.timeout(7000)});const value=await response.json();if(!response.ok||!value.ok)throw new Error('记录暂时没读到，稍后可以重试');return value;}
 async function load({earlier=false,scroll=true}={}){
  if(loading){pendingLoad={earlier,scroll};return;}loading=true;const current=++generation,target=selected;
  try{
   const info=await request('/api/chat/state'),available=[{day:window.HerChat.day},...info.days.filter(d=>d.day!==window.HerChat.day)];
   if(!available.some(d=>d.day===target))available.push({day:target});
   days.innerHTML=available.map(d=>`<option value="${escape(d.day)}">${d.day==='undated'?'旧记录 · 时间未记录':escape(d.day)+(d.day===window.HerChat.day?' · 今天':'')}${d.count?'（'+d.count+'条）':''}</option>`).join('');days.value=target;
   const value=await request('/api/chat/history?'+new URLSearchParams({day:target,limit:'80',...(earlier&&cursor?{before:cursor}:{})}));
   if(current!==generation||target!==selected)return;
   const oldHeight=box.scrollHeight,oldTop=box.scrollTop;
   const optimistic=items.filter(m=>String(m.id).startsWith('pending-')&&m.role!=='sys'&&!value.items.some(row=>row.role===m.role&&row.text===m.text&&Math.abs((row.at||0)-m.at)<60000));
   items=earlier?[...value.items,...items]:[...value.items,...optimistic];cursor=value.nextCursor;paint();
   status.textContent=items.length?'':'这一天还没有对话。';
   if(earlier)box.scrollTop=oldTop+box.scrollHeight-oldHeight;else if(scroll)box.scrollTop=box.scrollHeight;
  }catch(error){status.textContent=error.message;}finally{loading=false;if(pendingLoad){const next=pendingLoad;pendingLoad=null;void load(next);}}
 }
 function add(role,text){if(!text)return;if(selected!==window.HerChat.day){selected=window.HerChat.day;items=[];cursor=null;}items.push({id:'pending-'+Math.random().toString(36).slice(2),role:role==='her'?'assistant':role,text,at:Date.now(),status:'pending'});paint();box.scrollTop=box.scrollHeight;}
 function open(){log.hidden=false;selected=window.HerChat.day;void load();}
 days.onchange=()=>{selected=days.value;items=[];cursor=null;paint();void load();};more.onclick=()=>void load({earlier:true});
 document.getElementById('chatHistoryClose').onclick=()=>{log.hidden=true;};
 window.addEventListener('her:day',()=>{if(!log.hidden)open();});
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)void load({scroll:false});});
 window.HerHistory={add,open,refresh:()=>load({scroll:!log.hidden}),close:()=>{log.hidden=true;}};
 void window.HerChat.ready.then(()=>load({scroll:false}));
 setInterval(()=>{if(!log.hidden&&!document.hidden&&typeof state!=='undefined'&&!state.busy)void load({scroll:false});},15000);
})();
