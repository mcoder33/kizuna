import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, createUser, createLedger, writeSettings } from '../server/db.js';
import { createTelegramService } from '../server/telegram.js';
import { reviewDay } from '../server/day-review.js';
import { createTelegramDayDelivery, summaryDueInstant, summaryEligibility } from '../server/telegram-day-delivery.js';
import { summaryPreferences, summarySettingsKey, readSummaryPreferences, changeSummaryPreferences } from '../server/telegram-day-summary.js';
import { reserveSummaryReceipt, claimSummaryRetry, updateSummaryReceipt, migrateDaySummaryHistory } from '../server/day-summary-history.js';
import { createFakeTelegram } from './helpers/fake-telegram.js';

function fixture(t,{path=':memory:',zone='UTC',hook=null,finalHook=null,sendError=null,prepareImage=async()=>null,photoError=null,retrySleep=async()=>{},batchSize=40}={}) {
 const db=openDatabase(path);t.after(()=>{if(db.open)db.close();});const fake=createFakeTelegram(),events=[];
 let allowed=true;
 let clock=new Date('2026-10-03T09:15:00Z'),attempts=0,configured=true;
 const userId=createUser(db,{email:`delivery-${Math.random()}@example.org`,passwordHash:'test',status:'active'}).id;
 const addLink=(id,telegramId=fake.user.id)=>db.prepare('INSERT INTO telegram_links(user_id,telegram_id,chat_id,app_url,linked_at) VALUES(?,?,?,?,?)').run(id,telegramId,telegramId,'https://kizuna.example','2026-09-30T10:00:00Z');addLink(userId);
 const service=createTelegramService({db,canAccessDaySummary:()=>allowed,token:()=>configured?fake.token:null,now:()=>clock,clock:()=>clock.getTime(),timeZone:()=>zone,summaryBatchSize:batchSize,userActive:id=>db.prepare('SELECT status FROM users WHERE id=?').get(id)?.status==='active',audit:event=>events.push(event),requestTimeoutMs:20,
  prepareReportImage:prepareImage,reportRetrySleep:retrySleep,
  dayReview:async input=>{const initial=reviewDay(db,input);await hook?.(input,initial);return initial;},
  finalDayReview:input=>{const overview=reviewDay(db,input);finalHook?.(input,overview);return overview;},
  fetch:async(url,init)=>{if(new URL(url).pathname.endsWith('/sendMessage')){attempts++;const error=await sendError?.(attempts,init);if(error instanceof Error)throw error;if(error)return new Response(JSON.stringify({ok:false,error_code:error.status,description:'private credentials never show',parameters:{retry_after:error.retryAfter}}),{status:error.status});}if(new URL(url).pathname.endsWith('/sendPhoto')){const error=await photoError?.(init);if(error instanceof Error)throw error;if(error)return new Response(JSON.stringify({ok:false,error_code:error.status,description:'photo failed',parameters:{retry_after:error.retryAfter}}),{status:error.status});}return fake.fetch(url,init);}});
 const prefs=(id=userId,patch={})=>writeSettings(db,{[summarySettingsKey(id)]:JSON.stringify({...summaryPreferences(),morning:{enabled:true,time:'09:00',activatedAt:'2026-10-02T00:00:00Z'},...patch})});
 return{db,userId,fake,service,events,setAccess:value=>{allowed=value;},addLink,prefs,setNow:value=>{clock=new Date(value);},setEnabled:value=>{configured=value;},setZone:value=>{zone=value;},get attempts(){return attempts;},receipt:(phase='morning',date='2026-10-03')=>db.prepare('SELECT * FROM telegram_summary_receipts WHERE user_id=? AND local_date=? AND phase=?').get(userId,date,phase),messages:()=>fake.sent.filter(entry=>entry.method==='sendMessage')};
}

test('default off, empty weekdays, excluded weekday and blocked users produce no delivery',async t=>{
 const ctx=fixture(t);await ctx.service.tick();assert.equal(ctx.attempts,0);ctx.prefs(ctx.userId,{weekdays:[]});await ctx.service.tick();ctx.prefs(ctx.userId,{weekdays:[1]});await ctx.service.tick();ctx.prefs();ctx.db.prepare("UPDATE users SET status='blocked' WHERE id=?").run(ctx.userId);await ctx.service.tick();assert.equal(ctx.attempts,0);assert.equal(ctx.receipt(),undefined);
});
test('independent phases send plain reports once per local day without task mutation',async t=>{
 const ctx=fixture(t);ctx.prefs(ctx.userId,{evening:{enabled:true,time:'20:00',activatedAt:'2026-10-02T00:00:00Z'}});await ctx.service.tick();await ctx.service.tick();assert.equal(ctx.attempts,1);assert.equal(ctx.receipt().status,'sent');assert.ok(ctx.receipt().message_id);assert.equal(ctx.receipt('evening'),undefined);assert.equal(ctx.messages()[0].params.reply_markup,undefined);ctx.setNow('2026-10-03T20:00:00Z');await ctx.service.tick();assert.equal(ctx.attempts,2);assert.equal(ctx.receipt('evening').status,'sent');assert.equal(ctx.messages()[1].params.reply_markup,undefined);assert.match(ctx.messages()[1].params.text,/^🌙 /);assert.ok(ctx.messages()[1].params.entities.some(entity=>entity.type==='bold'));assert.equal(ctx.db.prepare('SELECT count(*) n FROM captures').get().n,0);
});
test('due grace is inclusive at sixty minutes and never backfills yesterday or late activation',async t=>{
 for(const [at,expected] of [['2026-10-03T08:59:59Z',0],['2026-10-03T10:00:00Z',1],['2026-10-03T10:00:01Z',0],['2026-10-04T00:05:00Z',0]]){const ctx=fixture(t);ctx.prefs();ctx.setNow(at);await ctx.service.tick();assert.equal(ctx.attempts,expected,at);}
 const ctx=fixture(t);changeSummaryPreferences(ctx.db,ctx.userId,{type:'enabled',phase:'morning',value:true},{now:new Date('2026-10-03T09:01:00Z')});await ctx.service.tick();assert.equal(ctx.attempts,0);ctx.setNow('2026-10-04T09:01:00Z');await ctx.service.tick();assert.equal(ctx.attempts,1);assert.equal(ctx.receipt('morning','2026-10-03'),undefined);
});
test('effective timezone determines local date, weekday and delivery time',async t=>{
 const ctx=fixture(t,{zone:'Pacific/Kiritimati'});ctx.prefs(ctx.userId,{weekdays:[7]});ctx.setNow('2026-10-03T19:05:00Z');await ctx.service.tick();assert.equal(ctx.attempts,1);assert.equal(ctx.receipt('morning','2026-10-04').status,'sent');assert.ok(ctx.messages()[0].params.text.includes('4 октября'));
});
test('DST fold uses first occurrence, gap next valid minute, absent date is skipped',()=>{
 assert.equal(new Date(summaryDueInstant('2026-11-01','01:30','America/New_York')).toISOString(),'2026-11-01T05:30:00.000Z');assert.equal(new Date(summaryDueInstant('2026-03-08','02:30','America/New_York')).toISOString(),'2026-03-08T07:00:00.000Z');assert.equal(summaryDueInstant('2011-12-30','09:00','Pacific/Apia'),null);assert.equal(summaryDueInstant('2026-02-30','09:00','UTC'),null);
 const preferences={...summaryPreferences(),morning:{enabled:true,time:'01:30',activatedAt:'2026-10-01T00:00:00Z'}};assert.equal(summaryEligibility({preferences,phase:'morning',timeZone:'America/New_York',now:new Date('2026-11-01T06:31:00Z')}).reason,'outside_grace');assert.equal(summaryDueInstant('2026-11-01','01:30','America/New_York'),Date.parse('2026-11-01T05:30:00Z'));
});
test('reservation precedes async build and simultaneous ticks share one delivery',async t=>{
 let ctx,release,entered;const barrier=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});ctx=fixture(t,{hook:async()=>{assert.equal(ctx.receipt().status,'reserved');entered();await barrier;}});ctx.prefs();const first=ctx.service.tick();await started;const second=ctx.service.tick();assert.equal(first,second);assert.equal(ctx.attempts,0);release();await Promise.all([first,second]);assert.equal(ctx.attempts,1);assert.equal(ctx.receipt().status,'sent');
});
test('bounded user batches advance cursor so every eligible user receives a summary',async t=>{
 const ctx=fixture(t,{batchSize:2});ctx.prefs();for(let i=0;i<6;i++){const id=createUser(ctx.db,{email:`batch-${i}@example.org`,passwordHash:'test',status:'active'}).id;ctx.addLink(id,888000+i);ctx.prefs(id);}for(let i=0;i<5;i++)await ctx.service.tick();assert.equal(ctx.attempts,7);assert.equal(new Set(ctx.messages().map(entry=>String(entry.params.chat_id))).size,7);
});
test('durable sent receipts and interrupted reservations survive reopen without blind resend',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'day-delivery-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const path=join(directory,'test.sqlite'),ctx=fixture(t,{path});ctx.prefs();await ctx.service.tick();const link=ctx.db.prepare('SELECT * FROM telegram_links WHERE user_id=?').get(ctx.userId);reserveSummaryReceipt(ctx.db,{userId:ctx.userId,date:'2026-10-03',phase:'evening',telegramUserId:link.telegram_id,chatId:link.chat_id,linkedAt:link.linked_at,now:'2026-10-03T09:10:00Z'});ctx.db.close();const reopened=openDatabase(path);t.after(()=>reopened.close());const fake=createFakeTelegram(),service=createTelegramService({db:reopened,token:()=>fake.token,fetch:fake.fetch,now:()=>new Date('2026-10-03T09:15:00Z'),timeZone:()=> 'UTC',userActive:()=>true});await service.tick();assert.equal(fake.sent.length,0);assert.equal(reopened.prepare("SELECT status FROM telegram_summary_receipts WHERE phase='morning'").get().status,'sent');const interrupted=reopened.prepare("SELECT * FROM telegram_summary_receipts WHERE phase='evening'").get();assert.equal(interrupted.status,'uncertain');assert.equal(interrupted.error_code,'interrupted_delivery');
});
test('definite 429 retries only when due and atomically claims the retry',async t=>{
 const ctx=fixture(t,{sendError:attempt=>attempt===1?{status:429,retryAfter:60}:null});ctx.prefs();await ctx.service.tick();assert.equal(ctx.receipt().status,'retry');assert.equal(ctx.receipt().retry_at,'2026-10-03T09:16:00.000Z');await ctx.service.tick();assert.equal(ctx.attempts,1);ctx.setNow('2026-10-03T09:16:00Z');await Promise.all([ctx.service.tick(),ctx.service.tick()]);assert.equal(ctx.attempts,2);assert.equal(ctx.receipt().status,'sent');
 updateSummaryReceipt(ctx.db,{userId:ctx.userId,date:'2026-10-03',phase:'morning',status:'retry',retryAt:'2026-10-03T09:16:00Z',now:'2026-10-03T09:15:00Z'});const link=ctx.db.prepare('SELECT * FROM telegram_links WHERE user_id=?').get(ctx.userId),input={userId:ctx.userId,date:'2026-10-03',phase:'morning',telegramUserId:link.telegram_id,chatId:link.chat_id,linkedAt:link.linked_at,dueAt:ctx.receipt().due_at,graceDeadline:ctx.receipt().grace_deadline,scheduleSignature:ctx.receipt().schedule_signature,now:'2026-10-03T09:16:00Z'};assert.equal(claimSummaryRetry(ctx.db,input),true);assert.equal(claimSummaryRetry(ctx.db,input),false);
});
test('rate-limit retry outside grace fails, yesterday retry expires without delivery',async t=>{
 const ctx=fixture(t,{sendError:()=>({status:429,retryAfter:120})});ctx.prefs();ctx.setNow('2026-10-03T09:59:00Z');await ctx.service.tick();assert.equal(ctx.receipt().status,'failed');assert.equal(ctx.receipt().error_code,'rate_limit_outside_grace');
 updateSummaryReceipt(ctx.db,{userId:ctx.userId,date:'2026-10-03',phase:'morning',status:'retry',retryAt:'2026-10-03T10:00:00Z',now:'2026-10-03T09:59:00Z'});ctx.setNow('2026-10-04T08:00:00Z');await ctx.service.tick();assert.equal(ctx.attempts,1);assert.equal(ctx.receipt().status,'failed');assert.equal(ctx.receipt().error_code,'retry_day_expired');
});
test('network, timeout and server errors are uncertain; 400 and 403 fail with safe visible status',async t=>{
 for(const [error,status] of [[new Error('secret credentials'),'uncertain'],[Object.assign(new Error('timeout'),{code:'ETIMEDOUT'}),'uncertain'],[{status:500},'uncertain'],[{status:400},'failed'],[{status:403},'failed']]){const ctx=fixture(t,{sendError:attempt=>attempt===1?error:null});ctx.prefs();await ctx.service.tick();await ctx.service.tick();assert.equal(ctx.attempts,1);assert.equal(ctx.receipt().status,status);assert.ok(ctx.events.some(event=>event.event==='telegram_summary_delivery'&&event.status===status));assert.equal(JSON.stringify(ctx.events).includes('secret credentials'),false);ctx.fake.push({text:'/settings'});await ctx.service.pollOnce();const text=ctx.messages().at(-1).params.text;assert.ok(text.includes('Последняя сводка (2026-10-03, утро)'));assert.equal(text.includes('private credentials'),false);assert.equal(text.includes(ctx.fake.token),false);assert.ok(text.includes(status==='uncertain'?'автоматического повтора не будет':error.status===403?'не заблокирован ли бот':'Telegram отклонил сообщение'));}
});
test('async optout, weekday/time changes, unbind and bot disable cancel before sending',async t=>{
 for(const change of ['off','weekdays','time','binding','token']){let ctx;ctx=fixture(t,{hook:async()=>{await Promise.resolve();if(change==='off')changeSummaryPreferences(ctx.db,ctx.userId,{type:'enabled',phase:'morning',value:false});if(change==='weekdays')ctx.prefs(ctx.userId,{weekdays:[]});if(change==='time')changeSummaryPreferences(ctx.db,ctx.userId,{type:'time',phase:'morning',value:'09:30'});if(change==='binding')ctx.db.prepare("UPDATE telegram_links SET linked_at='2026-10-03T09:16:00Z' WHERE user_id=?").run(ctx.userId);if(change==='token')ctx.setEnabled(false);}});ctx.prefs();await ctx.service.tick();assert.equal(ctx.attempts,0,change);assert.equal(ctx.receipt().status,'failed',change);}
});
test('scheduled final privacy reread removes revoked borrowed tasks and busy calendar titles',async t=>{
 let ctx,initial;ctx=fixture(t,{hook:async(input,overview)=>{initial=overview;await Promise.resolve();ctx.db.prepare('UPDATE capture_people SET removed_at=? WHERE user_id=?').run('2026-10-03T09:15:00Z',ctx.userId);ctx.db.prepare("UPDATE calendar_accounts SET mode='busy' WHERE id='private-calendar'").run();}});ctx.prefs();const owner=createUser(ctx.db,{email:'private-owner@example.org',passwordHash:'test',status:'active'}).id,created='2026-09-30T10:00:00Z';
 for(let i=0;i<42;i++){const id=`private-${i}`;ctx.db.prepare('INSERT INTO captures(id,raw,occurred_at,created_at,user_id) VALUES(?,?,?,?,?)').run(id,'Owner private',created,created,owner);ctx.db.prepare("INSERT INTO interpretations VALUES(?,?,1,'active','manual',NULL,?,'{}',?,NULL)").run(`${id}:i`,id,JSON.stringify({primaryType:'task',summary:'Owner private',entities:{schedule:{date:'2026-10-03'}}}),created);ctx.db.prepare("INSERT INTO projections VALUES(?,?,?,'task','{}','active',?,?,NULL)").run(`${id}:p`,id,`${id}:i`,id,created);ctx.db.prepare("INSERT INTO assignments(id,capture_id,assignee_id,assigner_id,state,created_at,responded_at) VALUES(?,?,?,?,'accepted',?,?)").run(`${id}:a`,id,ctx.userId,owner,created,created);ctx.db.prepare('INSERT INTO capture_people(capture_id,user_id,added_by,added_at) VALUES(?,?,?,?)').run(id,ctx.userId,owner,created);}
 ctx.db.prepare("INSERT INTO calendar_accounts(id,user_id,provider,label,credentials_enc,calendars_json,created_at) VALUES(?,?,'google','Private','mock',?,?)").run('private-calendar',ctx.userId,JSON.stringify([{id:'cal',selected:true}]),created);ctx.db.prepare('INSERT INTO calendar_events(id,account_id,calendar_id,uid,title,start_at,end_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('private-meeting','private-calendar','cal','uid','Calendar private','2026-10-03T10:00:00Z','2026-10-03T11:00:00Z',created);
 await ctx.service.tick();assert.equal(initial.counts.remaining,42);const text=ctx.messages()[0].params.text;assert.equal(text.includes('Owner private'),false);assert.equal(text.includes('Calendar private'),false);assert.equal(text.includes('Что остаётся в работе'),false);assert.equal(text.includes('⬜'),false);assert.ok(text.includes('Занято'));assert.equal(ctx.receipt().status,'sent');
});
test('preparation failure is definite and unexpected tick failures remain observable',async t=>{
 const ctx=fixture(t,{hook:()=>{throw new Error('secret build failure');}});ctx.prefs();await ctx.service.tick();assert.equal(ctx.receipt().status,'failed');assert.equal(ctx.receipt().error_code,'review_failed');assert.equal(ctx.attempts,0);ctx.db.prepare('DROP TABLE telegram_summary_receipts').run();await assert.rejects(ctx.service.tick());assert.ok(ctx.events.some(event=>event.event==='telegram_summary_tick_failed'));assert.equal(JSON.stringify(ctx.events).includes('secret build failure'),false);
});


test('actual Bot API request deadline leaves uncertain receipt and no automatic retry',async t=>{
 const ctx=fixture(t,{sendError:()=>new Promise(()=>{})});ctx.prefs();await ctx.service.tick();assert.equal(ctx.receipt().status,'uncertain');assert.equal(ctx.receipt().error_code,'request_timeout');await ctx.service.tick();assert.equal(ctx.attempts,1);
});
test('retry is cancelled after rebind or preference optout and never enters another local day',async t=>{
 for(const change of ['binding','off']){const ctx=fixture(t,{sendError:attempt=>attempt===1?{status:429,retryAfter:60}:null});ctx.prefs();await ctx.service.tick();ctx.setNow('2026-10-03T09:16:00Z');if(change==='binding')ctx.db.prepare("UPDATE telegram_links SET linked_at='2026-10-03T09:16:00Z' WHERE user_id=?").run(ctx.userId);else changeSummaryPreferences(ctx.db,ctx.userId,{type:'enabled',phase:'morning',value:false});await ctx.service.tick();assert.equal(ctx.attempts,1);assert.equal(ctx.receipt().status,'failed');assert.equal(ctx.receipt().error_code,change==='binding'?'binding_changed':'disabled');}
 const ctx=fixture(t,{sendError:()=>({status:429,retryAfter:60})});ctx.prefs(ctx.userId,{morning:{enabled:true,time:'23:59',activatedAt:'2026-10-02T00:00:00Z'}});ctx.setNow('2026-10-03T23:59:30Z');await ctx.service.tick();assert.equal(ctx.receipt().status,'failed');assert.equal(ctx.receipt().error_code,'rate_limit_outside_grace');
});


test('429 retry cannot move to a later time or timezone even before the new due',async t=>{
 for(const change of ['time','zone']){const ctx=fixture(t,{sendError:attempt=>attempt===1?{status:429,retryAfter:60}:null});ctx.prefs();await ctx.service.tick();ctx.setNow('2026-10-03T09:20:00Z');if(change==='time')changeSummaryPreferences(ctx.db,ctx.userId,{type:'time',phase:'morning',value:'10:30'},{now:new Date('2026-10-03T09:20:00Z')});else ctx.setZone('Etc/GMT+1');await ctx.service.tick();assert.equal(ctx.receipt().status,'failed',change);assert.equal(ctx.receipt().error_code,'retry_schedule_changed',change);ctx.setNow('2026-10-03T10:30:00Z');await ctx.service.tick();assert.equal(ctx.attempts,1,change);}
});


test('retry persists original window across reopen and schema migration is idempotent',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'retry-reopen-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const path=join(directory,'test.sqlite'),ctx=fixture(t,{path,sendError:()=>({status:429,retryAfter:60})});ctx.prefs();await ctx.service.tick();const original=ctx.receipt();assert.equal(original.due_at,'2026-10-03T09:00:00.000Z');assert.equal(original.grace_deadline,'2026-10-03T10:00:00.000Z');assert.ok(original.schedule_signature);ctx.db.close();const db=openDatabase(path);t.after(()=>db.close());migrateDaySummaryHistory(db);migrateDaySummaryHistory(db);const saved=db.prepare('SELECT * FROM telegram_summary_receipts WHERE user_id=?').get(ctx.userId);assert.equal(saved.due_at,original.due_at);assert.equal(saved.grace_deadline,original.grace_deadline);assert.equal(saved.schedule_signature,original.schedule_signature);const fake=createFakeTelegram(),service=createTelegramService({db,canAccessDaySummary:id=>id===ctx.userId,token:()=>fake.token,fetch:fake.fetch,now:()=>new Date('2026-10-03T09:16:00Z'),timeZone:()=> 'UTC',userActive:()=>true});await service.tick();assert.equal(fake.sent.length,1);assert.equal(db.prepare('SELECT status FROM telegram_summary_receipts WHERE user_id=?').get(ctx.userId).status,'sent');
});
test('legacy retry without original window fails closed after upgrading and reopening',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'legacy-retry-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const path=join(directory,'test.sqlite'),ctx=fixture(t,{path});ctx.prefs();const link=ctx.db.prepare('SELECT * FROM telegram_links WHERE user_id=?').get(ctx.userId);reserveSummaryReceipt(ctx.db,{userId:ctx.userId,date:'2026-10-03',phase:'morning',telegramUserId:link.telegram_id,chatId:link.chat_id,linkedAt:link.linked_at,now:'2026-10-03T09:15:00Z'});updateSummaryReceipt(ctx.db,{userId:ctx.userId,date:'2026-10-03',phase:'morning',status:'retry',retryAt:'2026-10-03T09:16:00Z',now:'2026-10-03T09:15:00Z'});for(const column of ['due_at','grace_deadline','schedule_signature'])ctx.db.exec(`ALTER TABLE telegram_summary_receipts DROP COLUMN ${column}`);ctx.db.close();const db=openDatabase(path);t.after(()=>db.close());migrateDaySummaryHistory(db);migrateDaySummaryHistory(db);const fake=createFakeTelegram(),service=createTelegramService({db,canAccessDaySummary:id=>id===ctx.userId,token:()=>fake.token,fetch:fake.fetch,now:()=>new Date('2026-10-03T09:16:00Z'),timeZone:()=> 'UTC',userActive:()=>true});await service.tick();const receipt=db.prepare('SELECT * FROM telegram_summary_receipts WHERE user_id=?').get(ctx.userId);assert.equal(receipt.status,'failed');assert.equal(receipt.error_code,'retry_metadata_missing');assert.equal(fake.sent.length,0);
});
test('retry cutoff is original due plus one hour rather than reservation plus one hour',async t=>{
 const ctx=fixture(t,{sendError:()=>({status:429,retryAfter:1})});ctx.prefs();ctx.setNow('2026-10-03T09:59:00Z');await ctx.service.tick();assert.equal(ctx.receipt().status,'retry');assert.equal(ctx.receipt().grace_deadline,'2026-10-03T10:00:00.000Z');ctx.setNow('2026-10-03T10:00:01Z');await ctx.service.tick();assert.equal(ctx.attempts,1);assert.equal(ctx.receipt().status,'failed');assert.equal(ctx.receipt().error_code,'retry_grace_expired');
});


test('final synchronous review crossing original deadline or midnight prevents initial and retry sends',async t=>{
 for(const boundary of ['deadline','midnight'])for(const retry of [false,true]){let ctx,finalCount=0;const before=boundary==='deadline'?'2026-10-03T09:59:59Z':'2026-10-03T23:59:59Z',after=boundary==='deadline'?'2026-10-03T10:00:01Z':'2026-10-04T00:00:01Z';ctx=fixture(t,{sendError:attempt=>retry&&attempt===1?{status:429,retryAfter:1}:null,finalHook:()=>{finalCount++;if(!retry||finalCount===2)ctx.setNow(after);}});ctx.prefs(ctx.userId,{morning:{enabled:true,time:boundary==='deadline'?'09:00':'23:30',activatedAt:'2026-10-02T00:00:00Z'}});if(retry){ctx.setNow(boundary==='deadline'?'2026-10-03T09:15:00Z':'2026-10-03T23:40:00Z');await ctx.service.tick();assert.equal(ctx.receipt().status,'retry');}ctx.setNow(before);await ctx.service.tick();assert.equal(ctx.attempts,retry?1:0,`${boundary} retry=${retry}`);assert.equal(ctx.receipt().status,'failed');assert.equal(ctx.receipt().error_code,'final_eligibility_changed');}
});
test('settings changed during final synchronous review cancel immediately before send',async t=>{
 for(const change of ['off','token','time']){let ctx;ctx=fixture(t,{finalHook:()=>{if(change==='off')changeSummaryPreferences(ctx.db,ctx.userId,{type:'enabled',phase:'morning',value:false});if(change==='time')changeSummaryPreferences(ctx.db,ctx.userId,{type:'time',phase:'morning',value:'10:30'});if(change==='token')ctx.setEnabled(false);}});ctx.prefs();await ctx.service.tick();assert.equal(ctx.attempts,0,change);assert.equal(ctx.receipt().status,'failed',change);}
});


test('non-owner with stored enabled settings is never reserved or built, owner remains opt-in',async t=>{
 let builds=0;const ctx=fixture(t,{hook:()=>{builds++;}});await ctx.service.tick();assert.equal(builds,0);ctx.prefs();ctx.setAccess(false);await ctx.service.tick();assert.equal(builds,0);assert.equal(ctx.attempts,0);assert.equal(ctx.receipt(),undefined);
 const service=createTelegramDayDelivery({db:ctx.db,now:()=>new Date('2026-10-03T09:15:00Z'),timeZone:()=>{throw Error('must not inspect preferences');},currentBinding:()=>true,prepareReview:()=>{throw Error('must not build');},currentReview:()=>{},send:()=>{throw Error('must not send');}});await service.tick();assert.equal(ctx.receipt(),undefined);
});
test('revocation after reservation and during final render is terminal with no retry or send',async t=>{
 for(const point of ['prepare','render']){let ctx;ctx=fixture(t,{hook:async()=>{if(point==='prepare'){await Promise.resolve();ctx.setAccess(false);}},finalHook:(_,overview)=>{if(point==='render')Object.defineProperty(overview,'timeZone',{get(){ctx.setAccess(false);return 'UTC';}});}});ctx.prefs();await ctx.service.tick();assert.equal(ctx.attempts,0);assert.equal(ctx.receipt().status,'failed');assert.equal(ctx.receipt().error_code,'access_revoked');ctx.setAccess(true);await ctx.service.tick();assert.equal(ctx.attempts,0);}
});

const reportPhoto={bytes:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFOsAAAAASUVORK5CYII=','base64'),type:'image/png',filename:'report.png'};

test('scheduled image report sends one multipart photo with bold exact task title and durable receipt',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-03T08:00:00Z')});
 let preparations=0;const ctx=fixture(t,{prepareImage:async()=>{preparations++;return reportPhoto;}});ctx.prefs();
 createLedger(ctx.db,{userId:ctx.userId,raw:'Моя <буквальная> задача 🐈',classification:{primaryType:'task',summary:'Моя <буквальная> задача 🐈',entities:{schedule:{date:'2026-10-03'}}},provider:'manual',occurredAt:'2026-10-03T08:00:00Z'});
 await ctx.service.tick();await ctx.service.tick();
 const photos=ctx.fake.sent.filter(entry=>entry.method==='sendPhoto');assert.equal(photos.length,1);assert.equal(preparations,1);assert.equal(ctx.messages().length,0);
 const photo=photos[0];assert.deepEqual(photo.uploads.report,reportPhoto.bytes);assert.equal(photo.params.reply_markup,undefined);assert.ok(photo.params.caption.includes('⬜ Моя <буквальная> задача 🐈'));
 assert.ok(photo.params.caption_entities.some(entity=>photo.params.caption.slice(entity.offset,entity.offset+entity.length)==='Моя <буквальная> задача 🐈'));
 assert.equal(ctx.receipt().status,'sent');assert.equal(ctx.receipt().message_id,String(photo.result.message_id));
});

test('image preparation optout, revoked binding/access and crossed due deadline prevent photo and text delivery',async t=>{
 for(const change of ['off','binding','access','deadline','token']){let ctx;ctx=fixture(t,{prepareImage:async()=>{await Promise.resolve();if(change==='off')changeSummaryPreferences(ctx.db,ctx.userId,{type:'enabled',phase:'morning',value:false});if(change==='binding')ctx.db.prepare("UPDATE telegram_links SET linked_at='changed' WHERE user_id=?").run(ctx.userId);if(change==='access')ctx.setAccess(false);if(change==='deadline')ctx.setNow('2026-10-03T10:00:01Z');if(change==='token')ctx.setEnabled(false);return reportPhoto;}});ctx.prefs();await ctx.service.tick();assert.equal(ctx.fake.sent.length,0,change);assert.equal(ctx.receipt().status,'failed',change);}
});

test('image preparation failure falls back to the normal report without technical caveats',async t=>{
 const ctx=fixture(t,{prepareImage:async()=>{throw Error('private model error');}});ctx.prefs();await ctx.service.tick();assert.equal(ctx.messages().length,1);assert.equal(ctx.receipt().status,'sent');assert.equal(ctx.messages()[0].params.text.includes('private model error'),false);
});

test('photo retries and final text fallback reread revoked source data',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-03T08:00:00Z')});
 let ctx,captureId,photos=0;ctx=fixture(t,{prepareImage:async()=>reportPhoto,photoError:async init=>{assert.equal(init.body.get('caption').includes('Now private task'),photos++===0);ctx.db.prepare('UPDATE captures SET deleted_at=? WHERE id=?').run('2026-10-03T09:15:00Z',captureId);ctx.setNow('2026-10-03T09:15:01Z');return{status:400};}});ctx.prefs();
 captureId=createLedger(ctx.db,{userId:ctx.userId,raw:'Now private task',classification:{primaryType:'task',summary:'Now private task',entities:{schedule:{date:'2026-10-03'}}},provider:'manual',occurredAt:'2026-10-03T08:00:00Z'}).captureId;
 await ctx.service.tick();assert.equal(photos,11);assert.equal(ctx.events.filter(event=>event.event==='telegram_report_photo_failed').length,1);assert.equal(ctx.messages().length,1);assert.equal(ctx.messages()[0].params.text.includes('Now private task'),false);assert.equal(ctx.receipt().status,'sent');
});

test('photo 429 waits within one delivery; repeated timeouts exhaust retries then send text once',async t=>{
 let photoAttempts=0,elapsed=0;const ctx=fixture(t,{prepareImage:async()=>reportPhoto,retrySleep:async ms=>{elapsed+=ms;},photoError:async()=>{photoAttempts++;if(photoAttempts===2)assert.ok(elapsed>=60000);return photoAttempts===1?{status:429,retryAfter:60}:null;}});ctx.prefs();await ctx.service.tick();assert.equal(ctx.receipt().status,'sent');assert.equal(ctx.messages().length,0);assert.equal(photoAttempts,2);await ctx.service.tick();assert.equal(photoAttempts,2);
 let timeouts=0;const timed=fixture(t,{prepareImage:async()=>reportPhoto,photoError:()=>{timeouts++;return new Promise(()=>{});}});timed.prefs();await timed.service.tick();await timed.service.tick();assert.equal(timeouts,11);assert.equal(timed.messages().length,1);assert.equal(timed.receipt().status,'sent');
 const failure=timed.events.find(event=>event.event==='telegram_report_photo_failed');assert.equal(failure.errorCode,'request_timeout');assert.equal(failure.attempts,11);
});

test('revoked access, settings, binding, expired grace or shutdown during backoff cancel retries without a sent receipt',async t=>{
 for(const change of ['access','off','binding','deadline','stop','reconfigure']){
  let ctx,photos=0;ctx=fixture(t,{prepareImage:async()=>reportPhoto,photoError:async()=>{photos++;return{status:400};},retrySleep:async()=>{
   if(change==='access')ctx.setAccess(false);
   if(change==='off')changeSummaryPreferences(ctx.db,ctx.userId,{type:'enabled',phase:'morning',value:false});
   if(change==='binding')ctx.db.prepare("UPDATE telegram_links SET linked_at='changed' WHERE user_id=?").run(ctx.userId);
   if(change==='deadline')ctx.setNow('2026-10-03T10:00:01Z');
   if(change==='stop')await ctx.service.stop();
   if(change==='reconfigure'){ctx.setEnabled(false);ctx.service.reconfigure();}
  }});ctx.prefs();await ctx.service.tick();assert.equal(photos,1,change);assert.equal(ctx.messages().length,0,change);assert.equal(ctx.receipt().status,'failed',change);assert.equal(ctx.receipt().error_code,'delivery_cancelled',change);
 }
});

test('text 429 after photo success or exhaustion does not restart the photo budget across delivery ticks',async t=>{
 for(const fails of [false,true]){
  let photos=0,preparations=0;const ctx=fixture(t,{prepareImage:async()=>{preparations++;return reportPhoto;},
   photoError:async()=>{photos++;return fails?{status:400}:null;},sendError:attempt=>attempt<=2?{status:429,retryAfter:60}:null,
   finalHook:(_,review)=>{for(const section of ['remaining','done','overdue']){review[section]=Array.from({length:4},()=>({title:'long task '.repeat(40)}));review.counts[section]=4;}}
  });ctx.prefs();await ctx.service.tick();assert.equal(ctx.receipt().status,'retry');assert.equal(ctx.receipt().error_code,'text_429_after_photo');
  ctx.setNow('2026-10-03T09:16:00Z');await ctx.service.tick();assert.equal(ctx.receipt().error_code,'text_429_after_photo');
  ctx.setNow('2026-10-03T09:17:00Z');await ctx.service.tick();assert.equal(ctx.receipt().status,'sent');assert.equal(ctx.messages().length,1);assert.equal(photos,fails?11:1);assert.equal(preparations,1);
 }
});

test('long illustrated report delivers complete text once even when the supplementary photo fails',async t=>{
 const ctx=fixture(t,{prepareImage:async()=>reportPhoto,photoError:async()=>({status:403}),finalHook:(_,review)=>{
   for(const section of ['remaining','done','overdue','meetings','added']){review[section]=Array.from({length:4},(_,i)=>({title:`${section}-${i} ${'длинное название '.repeat(20)}`}));review.counts[section]=4;}
 }});ctx.prefs();await ctx.service.tick();assert.equal(ctx.messages().length,1);assert.ok(ctx.messages()[0].params.text.length>1024);assert.ok(ctx.messages()[0].params.text.includes('remaining-0'));assert.equal(ctx.messages()[0].params.reply_markup,undefined);assert.equal(ctx.receipt().status,'sent');await ctx.service.tick();assert.equal(ctx.messages().length,1);
});
