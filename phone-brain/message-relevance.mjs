import crypto from 'node:crypto';
export const ANALYSIS_VERSION=3;
const digits=text=>String(text).normalize('NFKC').match(/\d+(?:[:./-]\d+)*/g)||[];
export function canonicalTitle(value){
  return String(value||'').normalize('NFKC').toLowerCase()
    .replace(/汇报材料|报告材料|汇报文档|汇报|文档/g,'报告').replace(/答复|回覆|回信/g,'回复').replace(/核实|核对|确认一下|确认下/g,'确认').replace(/交付|上交|交上|交一下|交下/g,'提交').replace(/开会|会议信息/g,'会议')
    .replace(/请|麻烦|帮忙|一下|尽快|需要|记得|务必|完成并|完成后|关于|进行|相关|是否|及时|自己|主人|你|您的|你的|的|了|吧|哦|呀/g,'').replace(/[^\p{L}\p{N}]/gu,'');
}
function pairs(value){const result=new Set();for(let i=0;i<value.length-1;i++)result.add(value.slice(i,i+2));return result;}
export function similarity(a,b){
  const aa=canonicalTitle(a),bb=canonicalTitle(b);if(!aa||!bb)return 0;if(aa===bb)return 1;
  const x=pairs(aa),y=pairs(bb),intersection=[...x].filter(k=>y.has(k)).length;
  return intersection/Math.max(1,Math.min(x.size,y.size));
}
function compatible(a,b){
  if(a.kind!==b.kind)return false;
  const ad=a.deadline?.slice(0,10),bd=b.deadline?.slice(0,10);if(ad&&bd&&ad!==bd)return false;
  const x=digits(a.title),y=digits(b.title);if(x.length&&y.length&&x.join('|')!==y.join('|'))return false;
  if(a.occurrence&&b.occurrence&&a.occurrence!==b.occurrence)return false;
  return true;
}
export function sameEvent(a,b,{explicit=false}={}){
  if(!compatible(a,b))return false;
  const score=similarity(a.title,b.title),shared=(a.sourceKeys||[]).some(key=>b.sourceKeys?.includes(key));
  const sameTopic=a.topicKey&&b.topicKey&&canonicalTitle(a.topicKey)===canonicalTitle(b.topicKey);
  return score>=.86||(sameTopic&&score>=.45)||(explicit&&shared&&score>=.25)||(shared&&score>=.7);
}
export function recipientOf(messages,ownerQQ){
  if(messages.every(m=>m.kind!=='group'))return 'owner';
  let all=false,other=false;
  for(const m of messages){
    const ownerId=m.ownerId||ownerQQ;
    const mentions=m.mentions?.length?m.mentions:[...String(m.text).matchAll(/@(\d{5,12}|all)\b/g)].map(x=>x[1]);
    if(mentions.includes(ownerId)||m.replyTo?.senderId===ownerId)return 'owner';
    if(mentions.includes('all'))all=true;
    if(mentions.some(id=>id!=='all'&&id!==ownerId))other=true;
  }
  return all?'everyone':other?'other':'unclear';
}
export function actionability(candidate,messages,ownerQQ){
  if(messages.length&&messages.every(m=>m.direction==='outgoing'))return {required:false,recipient:'other'};
  const group=messages.some(m=>m.kind==='group'),hard=recipientOf(messages,ownerQQ);
  const recipient=['owner','everyone','other','unclear'].includes(candidate.recipient)?candidate.recipient:hard;
  if(candidate.actionRequired===false||recipient==='other'||candidate.kind==='info')return {required:false,recipient};
  if(!group)return {required:true,recipient:'owner'};
  // An @ to somebody else is positive evidence; an AI label cannot overrule it.
  if(hard==='other')return {required:false,recipient:'other'};
  if(candidate.kind==='reply')return {required:hard==='owner'||recipient==='owner'&&!!candidate.recipientEvidence,recipient};
  if(hard==='owner')return {required:true,recipient:'owner'};
  if(recipient==='owner'&&candidate.recipientEvidence)return {required:true,recipient};
  if((recipient==='everyone'||hard==='everyone')&&candidate.recipientEvidence&&/全体|所有人|每[人位]|各位|大家|请各|@all/.test(messages.map(m=>m.text).join('\n')))return {required:true,recipient:'everyone'};
  return {required:false,recipient};
}
export const eventId=value=>crypto.createHash('sha256').update(value).digest('hex').slice(0,24);
