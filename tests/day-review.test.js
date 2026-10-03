import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, createUser, undo } from '../server/db.js';
import { reviewDay } from '../server/day-review.js';

const past='2026-10-01', now=new Date('2026-10-03T12:00:00Z');
function fixture(t) { const db=openDatabase(':memory:'); t.after(()=>db.close()); const user=createUser(db,{email:'day@example.org',passwordHash:'test',status:'active'}); return {db,userId:user.id}; }
function entry(db,userId,id,{created='2026-09-30T10:00:00Z',schedule={date:past},completed=false,doneOn=null,type='task',version=1}={}) {
  if (version===1) db.prepare('INSERT INTO captures(id,raw,occurred_at,created_at,user_id) VALUES(?,?,?,?,?)').run(id,id,created,created,userId);
  if (version>1) db.prepare("UPDATE interpretations SET status='superseded' WHERE capture_id=? AND status='active'").run(id);
  const interpretationId=`${id}:i${version}`,projectionId=`${id}:p${version}`;
  db.prepare('INSERT INTO interpretations VALUES(?,?,?,?,?,?,?,?,?,?)').run(interpretationId,id,version,'active','manual',null,JSON.stringify({primaryType:type,summary:`${id}-v${version}`,completed,entities:{schedule,...(doneOn?{doneOn}:{})}}),'{}',created,version===1?null:`${id}:i${version-1}`);
  db.prepare('INSERT INTO projections VALUES(?,?,?,?,?,?,?,?,?)').run(projectionId,id,interpretationId,type,'{}','active',id,created,null);
  return {interpretationId,projectionId};
}
let eventId=0;
function event(db,capture,projection,type,created,occurred=created,payload=null) {db.prepare('INSERT INTO ledger_events(id,event_type,capture_id,projection_id,occurred_at,created_at,payload) VALUES(?,?,?,?,?,?,?)').run(`event-${++eventId}`,type,capture,projection,occurred,created,payload?JSON.stringify(payload):null);}
function review(db,userId,date=past) {return reviewDay(db,{userId,date,timeZone:'UTC',now});}

test('reads more than last100, counts all while bounding items; creates are distinct from plan',t=>{
 const {db,userId}=fixture(t);
 for(let i=0;i<125;i++) entry(db,userId,`planned-${i}`);
 entry(db,userId,'added-future',{created:`${past}T12:00:00Z`,schedule:{date:'2026-10-05'}});
 const result=review(db,userId); assert.equal(result.counts.planned,125);assert.equal(result.planned.length,40);assert.equal(result.overflow.planned,85);assert.equal(result.counts.added,1);assert.equal(result.added[0].id,'added-future');
});
test('explicit due is overdue; defaulted/unscheduled carried work is remaining; timed task is no meeting',t=>{
 const {db,userId}=fixture(t);entry(db,userId,'due',{schedule:{date:'2026-09-30',time:'08:00'}});entry(db,userId,'default',{schedule:{date:'2026-09-30',defaulted:true}});entry(db,userId,'undated',{schedule:null});entry(db,userId,'timed',{schedule:{date:past,time:'09:00'}});entry(db,userId,'meeting',{type:'meeting_event',schedule:{date:past,time:'10:00'}});
 const result=review(db,userId);assert.deepEqual(result.overdue.map(x=>x.id),['due']);assert.deepEqual(new Set(result.remaining.map(x=>x.id)),new Set(['default','undated','timed']));assert.deepEqual(result.meetings.map(x=>x.id),['meeting']);assert.equal(result.meetings[0].completed,false);
});
test('past cutoff survives today title/schedule completion undo reopen delete and late backdating',t=>{
 const {db,userId}=fixture(t);const old=entry(db,userId,'stable');const before=review(db,userId);
 db.prepare("UPDATE interpretations SET status='superseded' WHERE id=?").run(old.interpretationId);db.prepare("UPDATE projections SET status='reverted',reverted_at=? WHERE id=?").run('2026-10-03T10:00:00Z',old.projectionId);
 const next=entry(db,userId,'stable',{created:'2026-10-03T10:00:00Z',schedule:{date:'2026-10-05'},version:2});
 event(db,'stable',next.projectionId,'completed','2026-10-03T11:00:00Z',`${past}T11:00:00Z`);event(db,'stable',next.projectionId,'completion_undone','2026-10-03T11:05:00Z');event(db,'stable',null,'capture_deleted','2026-10-03T11:10:00Z');
 assert.deepEqual(review(db,userId),before);assert.equal(before.remaining[0].title,'stable-v1');assert.equal(before.counts.done,0);
});
test('completion transfers count original actual day once; later undo does not rewrite it',t=>{
 const {db,userId}=fixture(t);const old=entry(db,userId,'done');event(db,'done',old.projectionId,'completed',`${past}T14:00:00Z`);
 db.prepare("UPDATE projections SET status='reverted',reverted_at=? WHERE id=?").run('2026-10-02T09:00:00Z',old.projectionId);
 const next=entry(db,userId,'done',{created:'2026-10-02T09:00:00Z',version:2});event(db,'done',next.projectionId,'completed','2026-10-02T09:00:00Z',`${past}T14:00:00Z`);
 assert.equal(review(db,userId).counts.done,1);assert.equal(review(db,userId,'2026-10-02').counts.done,0);event(db,'done',next.projectionId,'completion_undone','2026-10-03T11:00:00Z');assert.equal(review(db,userId).counts.done,1);
});
test('recurrence factual completion day differs from instance and survives schedule skip',t=>{
 const {db,userId}=fixture(t);entry(db,userId,'repeat',{schedule:{date:past,repeat:{freq:'daily',interval:1},skip:[past]}});event(db,'repeat','repeat:p1','occurrence_completed','2026-10-02T12:00:00Z','2026-10-02T12:00:00Z',{date:past});
 assert.equal(review(db,userId).counts.done,0);assert.equal(review(db,userId,'2026-10-02').counts.done,1);assert.deepEqual(review(db,userId,'2026-10-02').done[0].occurrenceDates,[past]);
 event(db,'repeat','repeat:p1','occurrence_undone','2026-10-03T11:00:00Z','2026-10-03T11:00:00Z',{date:past});assert.equal(review(db,userId,'2026-10-02').counts.done,1);
});
test('backdated result entered today and subtasks/container do not appear yesterday; validates ISO date',t=>{
 const {db,userId}=fixture(t);entry(db,userId,'late',{created:'2026-10-03T10:00:00Z',completed:true,doneOn:{date:past},schedule:null});entry(db,userId,'subtask');db.prepare('UPDATE captures SET subtask=1 WHERE id=?').run('subtask');entry(db,userId,'container');const container={primaryType:'task',summary:'container',proposedActions:[{type:'task',title:'child'}],entities:{schedule:{date:past}}};db.prepare('UPDATE interpretations SET classification_json=? WHERE capture_id=?').run(JSON.stringify(container),'container');assert.equal(review(db,userId).counts.planned,0);assert.equal(review(db,userId).counts.done,0);assert.throws(()=>review(db,userId,'2026-02-30'),RangeError);
});
test('bounded meeting list keeps earliest times, not earliest inserted records',t=>{
 const {db,userId}=fixture(t);for(let i=0;i<50;i++) entry(db,userId,`meeting-${i}`,{type:'meeting_event',schedule:{date:past,time:`${String(23-Math.floor(i/3)).padStart(2,'0')}:${String((i%3)*20).padStart(2,'0')}`}});
 const result=reviewDay(db,{userId,date:past,timeZone:'UTC',now,limit:3});assert.equal(result.counts.meetings,50);assert.deepEqual(result.meetings.map(x=>x.time),['07:00','07:20','08:00']);
});
test('local midnight cutoff uses user timezone rather than UTC day',t=>{
 const {db,userId}=fixture(t);const item=entry(db,userId,'zoned');event(db,'zoned',item.projectionId,'completed','2026-10-01T21:00:00Z');
 assert.equal(reviewDay(db,{userId,date:past,timeZone:'Europe/Samara',now}).counts.done,0);assert.equal(reviewDay(db,{userId,date:'2026-10-02',timeZone:'Europe/Samara',now}).counts.done,1);
});

test('real projection undo before cutoff removes materialized task; undo after cutoff preserves yesterday',t=>{
 const {db,userId}=fixture(t);entry(db,userId,'undo-before');entry(db,userId,'undo-after');
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-01T12:00:00Z')});assert.equal(undo(db,'undo-before'),1);assert.equal(review(db,userId).planned.some(x=>x.id==='undo-before'),false);
 t.mock.timers.setTime(Date.parse('2026-10-03T10:00:00Z'));assert.equal(undo(db,'undo-after'),1);assert.equal(review(db,userId).planned.some(x=>x.id==='undo-after'),true);
 assert.equal(reviewDay(db,{userId,date:'2026-10-03',timeZone:'UTC',now}).remaining.some(x=>x.id==='undo-after'),false);
});
test('completion lookup uses projection index without full ledger scan or temporary ordering',t=>{
 const {db,userId}=fixture(t);entry(db,userId,'indexed');const plan=db.prepare("EXPLAIN QUERY PLAN SELECT * FROM ledger_events WHERE projection_id=? AND event_type IN ('completed','completion_undone') AND created_at<? ORDER BY created_at DESC,rowid DESC LIMIT 1").all('indexed:p1',now.toISOString());assert.ok(plan.some(x=>x.detail.includes('day_summary_projection_completion')));assert.ok(plan.every(x=>!x.detail.includes('SCAN ledger_events') && !x.detail.includes('TEMP B-TREE')));
});
