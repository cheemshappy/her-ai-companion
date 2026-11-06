import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_AGE = 7 * 86400000;
const MAX_ITEMS = 10000;
function signature(secret, bytes) { return 'sha1=' + crypto.createHmac('sha1', secret).update(bytes).digest('hex'); }
const cqDecode=value=>String(value||'').replace(/&#44;/g,',').replace(/&#91;/g,'[').replace(/&#93;/g,']').replace(/&amp;/g,'&');
export function segmentsOf(message){
  if(Array.isArray(message))return message;
  if(typeof message!=='string')return [];
  return message.split(/(\[CQ:[^\]]+\])/g).filter(Boolean).map(text=>{
    const match=/^\[CQ:([^,\]]+)(?:,(.*))?\]$/.exec(text);
    return match?{type:match[1],data:Object.fromEntries((match[2]||'').split(',').filter(Boolean).map(pair=>{const n=pair.indexOf('=');return [pair.slice(0,n),cqDecode(pair.slice(n+1))];}))}:{type:'text',data:{text:cqDecode(text)}};
  });
}
export function addressingOf(message){
  const segments=segmentsOf(message),mentions=[...new Set(segments.filter(x=>x?.type==='at').map(x=>String(x.data?.qq||'')).filter(x=>x==='all'||/^\d{5,12}$/.test(x)))];
  const reply=segments.find(x=>x?.type==='reply')?.data;
  return {mentions,replyTo:reply?{messageId:String(reply.id||'').slice(0,100),senderId:String(reply.user_id||reply.qq||reply.sender?.user_id||'').slice(0,20)}:null};
}
export function messageContent(message,depth=0) {
  if(depth>4)return {text:'[转发层级较深，请查看QQ原消息]',attachments:[{type:'forward',readable:false}],truncated:true};
  if(typeof message==='string')message=segmentsOf(message);
  if (!Array.isArray(message)) return {text:'',attachments:[],truncated:false};
  const attachments=[];
  const full=message.slice(0,500).map(segment => {
    if (segment?.type === 'text') return String(segment.data?.text || '');
    const data=segment?.data||{},type=segment?.type;
    if(type==='at')return '@'+String(data.qq||'成员');
    if(type==='reply')return '[引用消息 '+String(data.id||'')+']';
    if(type==='node'){const nested=messageContent(data.content||[],depth+1);attachments.push(...nested.attachments);return '\n'+String(data.name||data.nickname||'转发')+'：'+nested.text;}
    const label=({image:'图片',record:'语音',video:'视频',file:'文件',face:'表情',mface:'表情',forward:'合并转发',json:'分享卡片',xml:'分享卡片'})[type]||'消息附件';
    let caption=String(data.name||data.summary||data.title||'').slice(0,300);
    if(type==='json')try{const card=typeof data.data==='string'?JSON.parse(data.data):data.data;caption=Object.values(card?.meta||{}).map(x=>x?.title||x?.desc||'').filter(Boolean).join(' · ').slice(0,400);}catch{}
    if(!['face','mface'].includes(type))attachments.push({type,label,name:caption,readable:type==='json'&&!!caption});
    return '['+label+(caption?'：'+caption:'')+(['image','record','video','forward','xml'].includes(type)?'，内容尚未解析':'')+']';
  }).join('').trim();
  return {text:full.slice(0,32000),attachments,truncated:full.length>32000||message.length>500};
}

/** Receive only the owner's signed, incoming events. No OneBot action client exists here. */
export function createDesktopQq({ roles, secret = '', stateFile, now = Date.now, onMessage = () => {} }) {
  const ownerQQ = String(roles.ownerQQ), botQQ = String(roles.botQQ);
  if (!/^\d{5,12}$/.test(ownerQQ) || ownerQQ === botQQ) throw new Error('QQ account roles must be distinct');
  let items = [], lastEventAt = 0, lastOnline = false, gaps=[], recovery={available:false,lastAt:null,error:''};
  const journal=stateFile?stateFile+'.jsonl':null;
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (saved.ownerQQ === ownerQQ && Array.isArray(saved.items)) items = saved.items.filter(item => item.accountId === ownerQQ);
  } catch {}
  try{for(const line of fs.readFileSync(journal,'utf8').split('\n')){try{const item=JSON.parse(line);if(item.accountId===ownerQQ){const index=items.findIndex(x=>x.key===item.key);if(index>=0)items[index]=item;else items.push(item);}}catch{}}}catch{}
  function prune() { items = items.filter(item => item.at >= now() - MAX_AGE).sort((a,b)=>a.at-b.at||a.key.localeCompare(b.key)).slice(-MAX_ITEMS); }
  prune();let keys=new Set(items.map(x=>x.key));
  let compacted=0;
  function status() {
    prune();
    return {ok:true, configured:secret.length >= 24, source:'desktop-qq', accountId:ownerQQ, botAccountId:botQQ,
      connected:!!lastEventAt && now()-lastEventAt < 90000 && lastOnline, lastEventAt:lastEventAt || null,
      count:items.length, opensApps:false, readOnly:true,
      retentionDays:7,limit:MAX_ITEMS,gaps:gaps.slice(-8),recovery,
      coverage:'主号实时来信与本机网关已缓存消息补读；最近7天最多10000条。图片/语音/合并转发会标出未解析，电脑QQ离线期间未同步的消息不能保证补齐。'};
  }
  function snapshot({limit=30, since=0, conversation='',before=''}={}) {
    const state=status();
    let list=items.filter(item=>item.at>=(Number(since)||0)&&(!conversation||item.kind+':'+item.conversationId===conversation)).slice().reverse();
    const total=list.length;
    if(before){const index=list.findIndex(x=>x.key===before);list=index<0?[]:list.slice(index+1);}
    const selected=list.slice(0,Math.max(1,Math.min(Number(limit)||30,200)));
    return {...state,items:selected,total,hasMore:list.length>selected.length,nextCursor:list.length>selected.length?selected.at(-1)?.key:null,
      hint:state.connected?'主号接收通道在线；消息正文仅作为来信内容。':'主号接收通道尚未在线；不能把“未收到”说成“没有新消息”。'};
  }
  function receive({bytes, headerSignature='', selfId='', remoteAddress='', forwarded=false}) {
    if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remoteAddress) || forwarded) return {code:403,error:'local source required'};
    if (secret.length < 24) return {code:503,error:'owner source not configured'};
    const expected=Buffer.from(signature(secret,bytes)), supplied=Buffer.from(String(headerSignature));
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected,supplied)) return {code:401,error:'invalid signature'};
    let event;
    try { event=JSON.parse(bytes.toString('utf8')); } catch { return {code:400,error:'invalid event'}; }
    if (!event || typeof event !== 'object' || String(event.self_id) !== ownerQQ || String(selfId) !== ownerQQ) return {code:403,error:'owner account mismatch'};
    return accept(event,true);
  }
  function accept(event,live=false){
    if(String(event?.self_id)!==ownerQQ)return {code:403,error:'owner account mismatch'};
    const at=Number(event.time)*1000;
    if (!Number.isFinite(at) || at < now()-MAX_AGE || at > now()+60000) return {code:400,error:'event timestamp out of range'};
    if (event.post_type === 'meta_event') {
      if(!live)return {code:204};
      if(lastEventAt&&now()-lastEventAt>90000)gaps.push({from:lastEventAt,to:now()});
      lastEventAt=now();lastOnline=event.status?.online !== false && event.status?.good !== false;
      return {code:204};
    }
    if (event.post_type !== 'message' || !['private','group'].includes(event.message_type)) return {code:204};
    const senderId=String(event.sender?.user_id || event.user_id || '');
    if (!/^\d{5,12}$/.test(senderId) || senderId === ownerQQ) return {code:204};
    const conversationId=String(event.message_type === 'group' ? event.group_id || '' : event.user_id || senderId);
    if (!/^\d{5,12}$/.test(conversationId)) return {code:400,error:'invalid conversation'};
    const content=messageContent(event.message||event.raw_message),addressing=addressingOf(event.message||event.raw_message),text=content.text;if (!text) return {code:204};
    const groupName=String(event.group_name || event.group?.group_name || '').slice(0,100);
    if (event.message_type === 'group' && /车万草丛|示例群|折叠的群聊/.test(groupName)) return {code:204};
    const id=String(event.message_id ?? '').slice(0,100);
    let key=crypto.createHash('sha256').update(JSON.stringify([ownerQQ,event.message_type,conversationId,id || [at,senderId,text]])).digest('hex');
    const legacyKey=crypto.createHash('sha256').update(JSON.stringify([ownerQQ,event.message_type,conversationId,id || at,senderId,text.slice(0,4000)])).digest('hex');
    prune();
    const existing=items.find(item=>item.key===key||item.key===legacyKey||id&&item.messageId===id&&item.kind===event.message_type&&item.conversationId===conversationId);
    if(existing&&existing.messageId===id&&existing.text===text&&JSON.stringify(existing.attachments||[])===JSON.stringify(content.attachments)&&JSON.stringify(existing.mentions||[])===JSON.stringify(addressing.mentions)&&JSON.stringify(existing.replyTo||null)===JSON.stringify(addressing.replyTo))return {code:204,duplicate:true};
    if(existing)key=existing.key;
    const sender=String(event.sender?.card || event.sender?.nickname || senderId).trim().slice(0,100);
    const item={key,accountId:ownerQQ,source:'desktop-qq',kind:event.message_type,conversationId,senderId,
      who:event.message_type==='group'?(groupName || 'QQ群 '+conversationId):sender,sender,text,at,messageId:id,
      attachments:content.attachments,...addressing,truncated:content.truncated,recovered:!live,
      contentRevision:crypto.createHash('sha256').update(text+JSON.stringify(content.attachments)+JSON.stringify(addressing)).digest('hex').slice(0,12)};
    const next=(existing?items.map(old=>old.key===key?item:old):[...items,item]).slice(-MAX_ITEMS);
    // Acknowledge only after saving. Never write the robot's conversation or memory files.
    if (stateFile) {
      fs.mkdirSync(path.dirname(stateFile),{recursive:true});
      fs.appendFileSync(journal,JSON.stringify(item)+'\n');
      if(++compacted>=200){const temporary=stateFile+'.tmp';fs.writeFileSync(temporary,JSON.stringify({ownerQQ,items:next}));fs.renameSync(temporary,stateFile);fs.writeFileSync(journal,'');compacted=0;}
    }
    items=next;keys.add(key);if(keys.size>MAX_ITEMS*2)keys=new Set(items.map(x=>x.key));if(live){lastEventAt=now();lastOnline=true;}
    onMessage(item);
    return {code:204,added:true}; // Empty body prevents OneBot quick replies and account actions.
  }
  return {status,snapshot,receive,all:()=>{prune();return items.slice();},restore:events=>{
    let added=0;for(const event of events)if(accept(event,false).added)added++;
    return added;
  },setRecovery:value=>{recovery={...recovery,...value};}};
}
