import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createUser, exportLedger, resetLedger } from '../server/db.js';
import { migrateDaySummaryHistory, reserveSummaryReceipt, updateSummaryReceipt, recoverSummaryReceipts } from '../server/day-summary-history.js';
import { createCalendarService } from '../server/calendar.js';
import { historySnapshot } from '../server/day-summary-history.js';
import { reviewDay } from '../server/day-review.js';
const yesterday='2026-10-01', at='2026-10-03T12:00:00Z';
function setup(t,filename=':memory:') { const db=openDatabase(filename);t.after(()=>db.open&&db.close());const a=createUser(db,{email:'a@example.com',passwordHash:'x',status:'active'}),b=createUser(db,{email:'b@example.com',passwordHash:'x',status:'active'});return{db,a:a.id,b:b.id}; }
function account(db,userId,id) {db.prepare("INSERT INTO calendar_accounts(id,user_id,provider,label,credentials_enc,calendars_json,created_at) VALUES(?,?,'google','Test','secret',?,?)").run(id,userId,JSON.stringify([{id:'cal',selected:true}]),at);}
function external(db,id,accountId,start,title='Secret meeting') {db.prepare(`INSERT INTO calendar_events(id,account_id,calendar_id,uid,title,start_at,end_at,updated_at) VALUES(?,?,'cal',?,?,?,?,?)`).run(id,accountId,'uid',title,`${start}T08:00:00Z`,`${start}T09:00:00Z`,at);}
function snapshotClock(db,source,key,time) {db.prepare(`UPDATE day_summary_history SET observed_at=? WHERE source=? AND source_key=?`).run(time,source,key);}
function review(db,userId,date=yesterday) {return reviewDay(db,{userId,date,timeZone:'UTC',now:new Date(at)});}
function task(db,userId,id) {db.prepare(`INSERT INTO captures(id,raw,occurred_at,created_at,user_id) VALUES(?,?,?,?,?)`).run(id,'Private todo','2026-09-30T12:00:00Z','2026-09-30T12:00:00Z',userId);db.prepare(`INSERT INTO interpretations VALUES(?,?,1,'active','manual',NULL,?,'{}',?,NULL)`).run(`${id}:i`,id,JSON.stringify({primaryType:'task',summary:'Private todo',entities:{schedule:{date:yesterday}}}),'2026-09-30T12:00:00Z');db.prepare(`INSERT INTO projections VALUES(?,?,?,'task','{}','active',?,?,NULL)`).run(`${id}:p`,id,`${id}:i`,id,'2026-09-30T12:00:00Z');}

test('observed calendar history survives move/delete, stable uid not cache id, current busy always hides details',t=>{
 const {db,a}=setup(t);account(db,a,'account');snapshotClock(db,'account','account','2026-09-30T10:00:00Z');external(db,'first','account',yesterday);const key=JSON.stringify(['account','cal','uid','']);snapshotClock(db,'external',key,'2026-09-30T10:00:00Z');
 assert.equal(review(db,a).meetings[0].title,'Secret meeting');assert.equal(review(db,a).meetings[0].completed,false);
 db.prepare(`DELETE FROM calendar_events WHERE id=?`).run('first');external(db,'replacement','account','2026-10-05');assert.equal(review(db,a).meetings.length,1);assert.equal(review(db,a,'2026-10-05').meetings.length,1);
 db.prepare("UPDATE calendar_accounts SET mode='busy' WHERE id='account'").run();assert.equal(review(db,a).meetings[0].title,'Занято');assert.equal(JSON.stringify(review(db,a).meetings).includes('Secret'),false);
 db.prepare(`DELETE FROM calendar_accounts WHERE id=?`).run('account');assert.equal(review(db,a).meetings.length,0);
});
test('historical borrowed work needs observed acceptance and current access, never all circle tasks',t=>{
 const {db,a,b}=setup(t);task(db,a,'assigned');task(db,a,'unassigned');db.prepare(`INSERT INTO capture_people VALUES(?,?,?,?,NULL)`).run('assigned',b,a,'2026-09-30T10:00:00Z');
 db.prepare(`INSERT INTO assignments(id,capture_id,assignee_id,assigner_id,state,created_at,responded_at) VALUES(?,?,?,?,'accepted',?,?)`).run('assignment','assigned',b,a,'2026-09-30T10:00:00Z','2026-09-30T11:00:00Z');
 snapshotClock(db,'assignment','assignment','2026-09-30T11:00:00Z');snapshotClock(db,'participant',JSON.stringify(['assigned',b]),'2026-09-30T10:00:00Z');assert.equal(review(db,b).counts.planned,1);
 db.prepare("UPDATE assignments SET state='declined' WHERE id='assignment'").run();assert.equal(review(db,b).counts.planned,1);
 db.prepare("UPDATE capture_people SET removed_at=? WHERE capture_id='assigned'").run(at);assert.equal(review(db,b).counts.planned,0);assert.equal(review(db,a).counts.planned,2);
});
test('baseline is observation now, never fabricated before rollout; account snapshots contain no credentials',t=>{
 const {db,a}=setup(t);account(db,a,'account');external(db,'first','account',yesterday);const result=review(db,a);assert.equal(result.meetings.length,0);assert.equal(result.historyCoverage.external,'unavailable');assert.ok(result.historyCoverage.gaps.length);
 const exported=exportLedger(db,a);assert.equal(JSON.stringify(exported.daySummaryHistory).includes('secret'),false);const count=db.prepare(`SELECT count(*) n FROM day_summary_history`).get().n;migrateDaySummaryHistory(db);assert.equal(db.prepare(`SELECT count(*) n FROM day_summary_history`).get().n,count);
});
test('receipts atomically reserve once, persist on reopen and recover interrupted sends as uncertain',t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'telegram-history-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const filename=path.join(directory,'db.sqlite');let {db,a}=setup(t,filename);const input={userId:a,date:yesterday,phase:'morning',telegramUserId:'1',chatId:'2',now:at};assert.equal(reserveSummaryReceipt(db,input),true);assert.equal(reserveSummaryReceipt(db,input),false);db.close();db=openDatabase(filename);t.after(()=>db.close());assert.equal(recoverSummaryReceipts(db,at),1);assert.equal(reserveSummaryReceipt(db,input),false);assert.equal(db.prepare(`SELECT status FROM telegram_summary_receipts`).get().status,'uncertain');assert.equal(recoverSummaryReceipts(db,at),0);
 updateSummaryReceipt(db,{...input,status:'sent',messageId:10});assert.equal(exportLedger(db,a).daySummaryHistory.receipts[0].message_id,'10');
});
test('export and reset isolate users, remove interpretation history/calendar tombstones/receipts',t=>{
 const {db,a,b}=setup(t);task(db,a,'a-task');task(db,b,'b-task');account(db,a,'a-calendar');account(db,b,'b-calendar');external(db,'a-event','a-calendar',yesterday);external(db,'b-event','b-calendar',yesterday);
 for(const userId of [a,b]) reserveSummaryReceipt(db,{userId,date:yesterday,phase:'evening',telegramUserId:'1',chatId:'2',now:at});
 const aExport=exportLedger(db,a);assert.ok(aExport.daySummaryHistory.snapshots.length);assert.equal(aExport.daySummaryHistory.snapshots.every(row=>row.user_id===a),true);const bExport=exportLedger(db,b);resetLedger(db,a);assert.equal(exportLedger(db,a).daySummaryHistory.snapshots.length,0);assert.equal(exportLedger(db,a).daySummaryHistory.receipts.length,0);assert.deepEqual(exportLedger(db,b).daySummaryHistory,bExport.daySummaryHistory);assert.equal(review(db,a).counts.planned,0);assert.equal(review(db,b).counts.planned,1);
});

test('clock injection timestamps future mutable snapshots and midnight-spanning events cover both dates',t=>{
 const {db,a}=setup(t);migrateDaySummaryHistory(db,undefined,{now:()=>new Date('2026-09-30T12:00:00Z')});account(db,a,'account');external(db,'overnight','account',yesterday);db.prepare("UPDATE calendar_events SET start_at='2026-09-30T23:30:00Z',end_at='2026-10-01T01:00:00Z' WHERE id='overnight'").run();assert.equal(review(db,a).meetings[0].time,'00:00');assert.equal(review(db,a).meetings[0].end,'01:00');assert.equal(db.prepare("SELECT observed_at FROM day_summary_history WHERE source='external' ORDER BY id DESC LIMIT 1").get().observed_at,'2026-09-30T12:00:00.000Z');
});
test('reset of assignee does not resurrect old borrowed history or delete owner snapshots',t=>{
 const {db,a,b}=setup(t);task(db,a,'assigned');db.prepare('INSERT INTO capture_people VALUES(?,?,?,?,NULL)').run('assigned',b,a,'2026-09-30T10:00:00Z');db.prepare("INSERT INTO assignments(id,capture_id,assignee_id,assigner_id,state,created_at,responded_at) VALUES('assignment','assigned',?,?,'accepted','2026-09-30T10:00:00Z','2026-09-30T11:00:00Z')").run(b,a);snapshotClock(db,'assignment','assignment','2026-09-30T11:00:00Z');snapshotClock(db,'participant',JSON.stringify(['assigned',b]),'2026-09-30T10:00:00Z');const owner=exportLedger(db,a).daySummaryHistory;assert.equal(review(db,b).counts.planned,1);resetLedger(db,b);assert.equal(review(db,b).counts.planned,0);assert.deepEqual(exportLedger(db,a).daySummaryHistory,owner);
});

test('real calendar move writes old-key tombstone and historical review contains exactly destination',async t=>{
 const {db,a}=setup(t);let clock=new Date('2026-09-30T10:00:00Z');migrateDaySummaryHistory(db,undefined,{now:()=>clock});account(db,a,'account');db.prepare("UPDATE calendar_accounts SET provider='caldav',username='me@example.org',calendars_json=? WHERE id='account'").run(JSON.stringify([{id:'cal',selected:true},{id:'destination',selected:true}]));external(db,'moving','account',yesterday);
 const service=createCalendarService({db,secrets:{open:()=>({password:'mock'})},caldav:{getEvent:async()=>({ics:'mock-event'}),putEvent:async()=>({href:'https://calendar.example/destination/uid.ics',etag:'moved'}),deleteEvent:async()=>({})},timeZone:()=> 'UTC'});
 clock=new Date('2026-10-01T12:00:00Z');const moved=await service.moveExternalEvent({userId:a,id:'ext:moving',calendarId:'destination'});assert.equal(moved.error,undefined);assert.equal(moved.event.calendarId,'destination');
 const key=JSON.stringify(['account','cal','uid','']);assert.equal(historySnapshot(db,'external',key,'2026-10-01T11:00:00Z').deleted,0);assert.equal(historySnapshot(db,'external',key,'2026-10-02T00:00:00Z').deleted,1);const result=review(db,a);assert.equal(result.meetings.length,1);assert.ok(result.meetings[0].id.includes('destination'));
});
test('CalDAV decline matches email without self; actual respond writer preserves historical accepted state',async t=>{
 const {db,a}=setup(t);let clock=new Date('2026-09-30T10:00:00Z');migrateDaySummaryHistory(db,undefined,{now:()=>clock});account(db,a,'account');db.prepare("UPDATE calendar_accounts SET provider='caldav',username='me@example.org' WHERE id='account'").run();external(db,'invited','account',yesterday);db.prepare('UPDATE calendar_events SET attendees_json=? WHERE id=?').run(JSON.stringify([{email:'me@example.org',status:'accepted'}]),'invited');
 const ics=['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VEVENT','UID:uid','DTSTART:20261001T080000Z','DTEND:20261001T090000Z','ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.org','END:VEVENT','END:VCALENDAR',''].join('\r\n');
 const service=createCalendarService({db,secrets:{open:()=>({password:'mock'})},caldav:{getEvent:async()=>({ics,etag:'old'}),putEvent:async()=>({etag:'declined'})},timeZone:()=> 'UTC'});
 assert.equal(review(db,a).meetings.length,1);clock=new Date('2026-10-02T12:00:00Z');const response=await service.respondExternalEvent({userId:a,id:'ext:invited',status:'declined'});assert.equal(response.error,undefined);const attendees=JSON.parse(db.prepare("SELECT attendees_json FROM calendar_events WHERE id='invited'").get().attendees_json);assert.equal(attendees[0].self,undefined);assert.equal(attendees[0].status,'declined');assert.equal(review(db,a).meetings.length,1);
 const current=reviewDay(db,{userId:a,date:yesterday,timeZone:'UTC',now:new Date('2026-10-01T12:00:00Z')});assert.equal(current.meetings.length,0);
 db.prepare('UPDATE calendar_events SET attendees_json=? WHERE id=?').run(JSON.stringify([{email:' ME@EXAMPLE.ORG ',status:'declined'}]),'invited');assert.equal(reviewDay(db,{userId:a,date:yesterday,timeZone:'UTC',now:new Date('2026-10-01T12:00:00Z')}).meetings.length,0);
});
test('rollout beginning mid-day marks calendar and assignment history partial with exact local bound',t=>{
 const {db,a}=setup(t);db.prepare('UPDATE day_summary_history_meta SET observed_from=?').run('2026-10-01T12:00:00.000Z');const result=review(db,a);assert.equal(result.historyCoverage.external,'partial');assert.equal(result.historyCoverage.assignments,'partial');assert.equal(result.historyCoverage.observedFrom,'2026-10-01T12:00:00.000Z');assert.ok(result.historyCoverage.gaps.every(gap=>gap.includes('2026-10-01 12:00 (UTC)')));
});
