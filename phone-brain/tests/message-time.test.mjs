import test from 'node:test';import assert from 'node:assert/strict';import calendar from '../ui/calendar.js';import {eventTiming,presentEventTime} from '../message-time.mjs';
const now=Date.parse('2026-10-31T10:00:00+08:00');
test('calendar renders seconds/milliseconds in Beijing time; missing timestamps are never today',()=>{
 assert.equal(calendar.day(Date.parse('2026-10-30T16:01:00Z')),'2026-10-31');assert.equal(calendar.format(now/1000),'2026-10-31 10:00');assert.equal(calendar.format(null),'时间未记录');assert.equal(calendar.day(null),'');
});
test('old today is anchored to the sending date, even if AI invents a current deadline',()=>{
 const result=eventTiming({priority:'today',deadline:'2026-10-31T18:00:00+08:00'},[{at:now-86400000,text:'今天请提交资料'}],now);assert.equal(result.priority,'later');assert.equal(result.targetDay,'2026-10-30');assert.equal(result.overdue,true);assert.equal(result.deadline,null);
});
test('yesterday tomorrow, future dates and overnight status use actual calendar days',()=>{
 assert.equal(eventTiming({priority:'today'},[{at:now-86400000,text:'明天请回复'}],now).priority,'today');assert.equal(eventTiming({priority:'today'},[{at:now,text:'11月2日开会'}],now).priority,'later');assert.equal(presentEventTime({priority:'today',at:now,targetDay:'2026-10-31'},now+86400000).priority,'later');
});
