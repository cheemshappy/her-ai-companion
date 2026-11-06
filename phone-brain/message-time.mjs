import calendar from './ui/calendar.js';
export function eventTiming(candidate,messages,now=Date.now()){
 const today=calendar.day(now),at=Math.max(...messages.map(m=>calendar.timestamp(m.at)||0));
 const deadline=calendar.timestamp(candidate.deadline),deadlineDay=deadline?calendar.day(deadline):'';
 let targetDay='';
 {
  for(const message of messages.slice().reverse()){
   const text=String(message.text||''),base=calendar.timestamp(message.at);if(!base)continue;
   const full=/(20\d{2})[年./-](\d{1,2})[月./-](\d{1,2})日?/.exec(text);
   const short=/(\d{1,2})月(\d{1,2})[日号]?/.exec(text);
   if(full)targetDay=`${full[1]}-${full[2].padStart(2,'0')}-${full[3].padStart(2,'0')}`;
   else if(short)targetDay=`${calendar.day(base).slice(0,4)}-${short[1].padStart(2,'0')}-${short[2].padStart(2,'0')}`;
   else if(/后天/.test(text))targetDay=calendar.shiftDay(base,2);
   else if(/昨天|昨日|昨晚/.test(text))targetDay=calendar.shiftDay(base,-1);
   else if(/明天|明日|明早|明晚/.test(text))targetDay=calendar.shiftDay(base,1);
   else if(/今天|今日|今晚|今早/.test(text))targetDay=calendar.day(base);
   if(targetDay)break;
  }
 }
 if(!targetDay)targetDay=deadlineDay;
 const sourceDay=calendar.day(at),dueToday=targetDay===today;
 let priority=['urgent','today','later'].includes(candidate.priority)?candidate.priority:'later';
 if(priority==='today'&&!dueToday&&!(sourceDay===today&&!targetDay))priority='later';
 return {priority,sourceAt:at||null,sourceDay:sourceDay||null,targetDay:targetDay||null,overdue:!!targetDay&&targetDay<today,...(deadlineDay&&targetDay&&deadlineDay!==targetDay?{deadline:null}:{})};
}
export function presentEventTime(event,now=Date.now()){
 const today=calendar.day(now);let priority=event.priority;
 if(priority==='today'&&(event.targetDay&&event.targetDay!==today||!event.targetDay&&calendar.day(event.sourceAt||event.at)!==today))priority='later';
 return {...event,priority,overdue:!!event.targetDay&&event.targetDay<today};
}
