/* One calendar for server and all WebViews; never infer today from refresh time. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.HerCalendar=api;})(globalThis,function(){
 const zone='Asia/Shanghai';
 function timestamp(value){if(value===null||value===undefined||value==='')return null;const n=typeof value==='number'?value:typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value)?Number(value):Date.parse(value);return Number.isFinite(n)&&n>0?(n<100000000000?n*1000:n):null;}
 function day(value=Date.now()){const at=timestamp(value);if(at===null)return '';const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(at);return ['year','month','day'].map(k=>parts.find(p=>p.type===k).value).join('-');}
 function format(value,{seconds=false}={}){const at=timestamp(value);if(at===null)return '时间未记录';const parts=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',...(seconds?{second:'2-digit'}:{}),hourCycle:'h23'}).formatToParts(at),p=Object.fromEntries(parts.map(p=>[p.type,p.value]));return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}${seconds?':'+p.second:''}`;}
 function shiftDay(value,days){const key=day(value);return key?day(Date.parse(key+'T12:00:00+08:00')+days*86400000):'';}
 return {zone,timestamp,day,format,shiftDay};
});
