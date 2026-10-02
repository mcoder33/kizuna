import { createLedger, replaceInterpretation } from '../server/db.js';
import { remindMoment } from '../server/reminders.js';
import { occurrenceDates } from '../server/repeat.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { normalizeTimeZone, resolveTimeZone } from '../public/time-zone.js';
import { userTimeZone } from '../server/time-zone.js';
import { createApp } from '../server/index.js';
import { createAiService } from '../server/ai.js';
import { createCliProviders } from '../server/cli-providers.js';
import { dayStartInZone } from '../server/reports.js';
import { claimCaptureJob } from '../server/db.js';
import { isQuiet, notify, dismissStaleDigests } from '../server/notifications.js';
import { authed } from './helpers/auth.js';
import { fakeModelService } from './helpers/fake-model.js';
const makeApp=options=>createApp({aiService:fakeModelService(),databasePath:path.join(fs.mkdtempSync(path.join(os.tmpdir(),'pagent-tz-')),'db.sqlite'),...options});
const candidate={primaryType:'task',summary:'Unchanged 山田',details:'',entities:{projects:[],people:[],when:null,followUp:null},additionalTypes:[],proposedActions:[],completed:false,ambiguity:null};

test('IANA normalization and automatic fallback never use host defaults',()=>{
 assert.equal(normalizeTimeZone('US/Eastern'),'America/New_York');
 for(const value of [undefined,null,false,{},'', ' UTC','+03:00','Invalid/Zone'])assert.equal(normalizeTimeZone(value),null);
 assert.equal(resolveTimeZone('system','Asia/Tokyo','Europe/Samara'),'Asia/Tokyo');
 assert.equal(resolveTimeZone('Europe/Berlin','Asia/Tokyo'),'Europe/Berlin');
 assert.equal(resolveTimeZone('system',null,'Europe/Samara'),'Europe/Samara');
 for(const [date,next,hours] of [['2026-03-08','2026-03-09',23],['2026-11-01','2026-11-02',25]])assert.equal((dayStartInZone(next,'America/New_York')-dayStartInZone(date,'America/New_York'))/3600000,hours);
});

test('personal zones isolate settings and midnight views while accounting stays global',async()=>{
 const app=makeApp({now:()=>new Date('2026-10-01T00:30:00Z'),timeZone:'Europe/Samara'});
 try{
  const a=authed(app),b=authed(app,{email:'other@tz.test',role:'user'});
  const original=(await b.get('/api/settings').expect(200)).body;
  assert.equal(original.settings.requestedTimeZone,'system');assert.equal(original.timeZone,'Europe/Samara');
  await a.put('/api/settings').send({requestedTimeZone:'US/Eastern',detectedTimeZone:'Asia/Tokyo',locale:'en'}).expect(200);
  await b.put('/api/settings').send({detectedTimeZone:'Asia/Tokyo',locale:'ja'}).expect(200);
  const personal=(await a.get('/api/settings').expect(200)).body;
  assert.equal(personal.settings.requestedTimeZone,'America/New_York');assert.equal(personal.timeZone,'America/New_York');assert.equal(personal.settings.timeZone,null);
  assert.equal((await b.get('/api/settings').expect(200)).body.timeZone,'Asia/Tokyo');
  for(const invalid of ['system','Invalid/Zone',false,{},'+02:00'])await b.put('/api/settings').send({detectedTimeZone:invalid}).expect(400);
  await b.put('/api/settings').send({timeZone:'UTC'}).expect(403);
  assert.equal((await a.get('/api/day').expect(200)).body.date,'2026-09-30');assert.equal((await b.get('/api/day').expect(200)).body.date,'2026-10-01');
  for(const route of ['/api/reports','/api/journal/overview']){
   const left=(await a.get(route).expect(200)).body,right=(await b.get(route).expect(200)).body;
   assert.equal(left.today,'2026-09-30');assert.equal(right.today,'2026-10-01');
  }
  assert.equal((await a.get('/api/settings')).body.spend.month,'2026-10');assert.equal((await b.get('/api/settings')).body.spend.month,'2026-10');
  const left=(await a.get('/api/board')).body.columns[0],right=(await b.get('/api/board')).body.columns[0];
  assert.equal(left.name,'Tasks');assert.equal(right.name,'タスク');
  await a.patch(`/api/board/columns/${left.id}`).send({name:'Дела'}).expect(200);
  await a.put('/api/settings').send({locale:'ja',requestedTimeZone:'system'}).expect(200);
  const same=(await a.get('/api/board')).body.columns[0];assert.equal(same.name,'Дела');assert.equal(same.id,left.id);
  assert.equal(userTimeZone(app.database,a.user.id,'Europe/Samara'),'Asia/Tokyo');
 }finally{app.database.close();}
});

test('queue and retry retain server-generated timezone/reference and all manual overrides',async()=>{
 let clock=new Date('2026-10-01T23:30:00Z');const calls=[];let fail=true;
 const fallback=createAiService({env:{}});
 const ai={status:async()=>({selectedProvider:'fallback'}),classify:async(...args)=>{calls.push(args);if(fail)throw new Error('retry');return fallback.classify(...args);}};
 const app=makeApp({now:()=>clock,aiService:ai});
 try{
  const api=authed(app);await api.put('/api/settings').send({requestedTimeZone:'America/New_York'}).expect(200);
  const queued=(await api.post('/api/captures').set('Prefer','respond-async').set('Idempotency-Key','zone-context-123').send({raw:'Untouched 山田',provider:'fallback',due:{date:'2026-10-02',time:'09:00'},priority:'high',timeContext:{timeZone:'Asia/Tokyo',referenceAt:'2000-01-01T00:00:00Z'},overrides:{timeContext:{timeZone:'UTC'}}}).expect(202)).body;
  const overrides=JSON.parse(app.database.prepare('SELECT overrides_json FROM capture_jobs WHERE id=?').get(queued.jobId).overrides_json);
  assert.deepEqual(overrides.timeContext,{timeZone:'America/New_York',referenceAt:clock.toISOString()});
  await api.put('/api/settings').send({requestedTimeZone:'Asia/Tokyo'}).expect(200);clock=new Date('2026-10-03T04:00:00Z');
  const repeated=(await api.post('/api/captures').set('Prefer','respond-async').set('Idempotency-Key','zone-context-123').send({raw:'Untouched 山田',provider:'fallback',due:{date:'2026-10-02',time:'09:00'},priority:'high'}).expect(202)).body;assert.equal(repeated.jobId,queued.jobId);
  let claim=claimCaptureJob(app.database,{owner:'test',leaseToken:'one',leaseMs:30000,currentTime:clock.toISOString()});await app.captureJobWorker.run(claim,new AbortController());
  assert.deepEqual(calls[0][6],overrides.timeContext);
  const retry=(await api.post(`/api/jobs/${queued.jobId}/retry`).send({}).expect(202)).body;
  assert.deepEqual(JSON.parse(app.database.prepare('SELECT overrides_json FROM capture_jobs WHERE id=?').get(retry.jobId).overrides_json),overrides);
  fail=false;claim=claimCaptureJob(app.database,{owner:'test',leaseToken:'two',leaseMs:30000,currentTime:clock.toISOString()});await app.captureJobWorker.run(claim,new AbortController());
  assert.deepEqual(calls[1][6],overrides.timeContext);
  const row=app.database.prepare('SELECT raw FROM captures WHERE id=?').get(queued.captureId);assert.equal(row.raw,'Untouched 山田');
  const entry=(await api.get(`/api/captures/${queued.captureId}`).expect(200)).body.entry;
  assert.equal(entry.interpretation.classification.entities.schedule.date,'2026-10-02');assert.equal(entry.interpretation.classification.entities.schedule.time,'09:00');
 }finally{app.database.close();}
});

test('all model guidance and CLI prompts use the captured reference instant',async()=>{
 const context={timeZone:'America/New_York',referenceAt:'2026-10-01T23:30:00Z'},prompts=[];
 const service=createAiService({apiKey:'test',now:()=>new Date('2026-11-12T00:00:00Z'),client:{responses:{create:async request=>{prompts.push(JSON.stringify(request));return {output_text:JSON.stringify(candidate)};}}}});
 await service.classify('Untouched 山田','openai',undefined,null,'','ja',context);
 const cli=createCliProviders({now:()=>new Date('2026-11-12T00:00:00Z'),config:{providers:{'codex-cli':{executable:'/fake',model:'test'}}},runner:{execute:async options=>{prompts.push(options.prompt);return JSON.stringify(candidate);}}});
 await cli.invoke('codex-cli','classify','Untouched 山田',undefined,undefined,'','ja',context);
 for(const prompt of prompts){assert.ok(prompt.includes('Сегодня 2026-10-01, часовой пояс America/New_York'));assert.equal(prompt.includes('2026-11-12'),false);}
});

test('background reminders, quiet hours and stale digests use each recipient zone',async()=>{
 const clock=new Date('2026-10-02T00:00:00Z'),app=makeApp({now:()=>clock});
 try{
  const a=authed(app),b=authed(app,{email:'background@tz.test',role:'user'});
  await a.put('/api/settings').send({requestedTimeZone:'America/New_York',remindDefault:'0'}).expect(200);
  await b.put('/api/settings').send({requestedTimeZone:'Asia/Tokyo',remindDefault:'0'}).expect(200);
  const first=(await a.post('/api/captures').send({raw:'First 山田',provider:'fallback',due:{date:'2026-10-02',time:'09:00',remind:0}}).expect(201)).body.entry;
  const second=(await b.post('/api/captures').send({raw:'Second 山田',provider:'fallback',due:{date:'2026-10-02',time:'09:00',remind:0}}).expect(201)).body.entry;
  const moments=app.reminders.candidates();assert.equal(moments.find(x=>x.captureId===first.id).remindAt.toISOString(),'2026-10-02T13:00:00.000Z');assert.equal(moments.find(x=>x.captureId===second.id).remindAt.toISOString(),clock.toISOString());
  const sent=await app.reminders.tick();assert.deepEqual(sent.map(x=>x.captureId),[second.id]);
  assert.equal(isQuiet('22:00-08:00',clock,'Asia/Tokyo'),false);assert.equal(isQuiet('22:00-08:00',clock,'Europe/Berlin'),true);
  notify(app.database,{userId:a.user.id,kind:'digest',text:'User text',group:'digest:2026-10-01'});notify(app.database,{userId:b.user.id,kind:'digest',text:'User text',group:'digest:2026-10-01'});
  dismissStaleDigests(app.database,'2026-10-02',clock.toISOString(),b.user.id);
  const rows=app.database.prepare("SELECT user_id,dismissed_at FROM notifications WHERE kind='digest'").all();assert.equal(rows.find(x=>x.user_id===a.user.id).dismissed_at,null);assert.equal(rows.find(x=>x.user_id===b.user.id).dismissed_at,clock.toISOString());
 }finally{app.database.close();}
});

for(const [day,next,before,first,last,after] of [
 ['2026-03-08','2026-03-09','2026-03-08T04:30:00Z','2026-03-08T05:30:00Z','2026-03-09T03:30:00Z','2026-03-09T04:30:00Z'],
 ['2026-11-01','2026-11-02','2026-11-01T03:30:00Z','2026-11-01T04:30:00Z','2026-11-02T04:30:00Z','2026-11-02T05:30:00Z']
])test(`daily brief ${day} uses DST bounds and keeps historic sources after zone change`,async()=>{
 const app=makeApp({now:()=>new Date(`${next}T12:00:00Z`)});
 try{
  const api=authed(app);await api.put('/api/settings').send({requestedTimeZone:'America/New_York'}).expect(200);
  for(const [index,occurredAt] of [before,first,last,after].entries())await api.post('/api/captures').send({raw:`Решили: 原文 ${index}`,provider:'fallback',occurredAt}).expect(201);
  const brief=(await api.get(`/api/daily-brief?date=${next}`).expect(200)).body;
  assert.equal(brief.timeZone,'America/New_York');assert.equal(brief.content.timeZone,'America/New_York');
  assert.deepEqual(brief.content.sections.find(x=>x.key==='decisions').items.map(x=>x.text),['Решили: 原文 1','Решили: 原文 2']);
  const source=brief.sources[0];await api.put('/api/settings').send({requestedTimeZone:'Asia/Tokyo'}).expect(200);
  assert.deepEqual((await api.get(`/api/daily-brief?date=${next}&revision=${brief.revision}&timeZone=America%2FNew_York`).expect(200)).body,brief);
  for(const suffix of ['', '?timeZone=America%2FNew_York'])assert.equal((await api.get(`/api/daily-brief/${next}/revisions/${brief.revision}/sources/${source.sourceId}${suffix}`).expect(200)).body.raw,'Решили: 原文 1');
  const stranger=authed(app,{email:'stranger@tz.test',role:'user'});await stranger.get(`/api/daily-brief/${next}/revisions/${brief.revision}/sources/${source.sourceId}?timeZone=America%2FNew_York`).expect(404);
 }finally{app.database.close();}
});

test('recurring reminder wall time follows DST without shifting date-only occurrences',()=>{
 for(const [first,last,hours] of [['2026-03-07','2026-03-08',23],['2026-10-31','2026-11-01',25]]){
  const schedule={date:first,time:'09:00',remind:0,repeat:{freq:'daily',interval:1,until:last}};
  const dates=occurrenceDates(schedule,first,last);assert.deepEqual(dates,[first,last]);
  const moments=dates.map(date=>remindMoment({...schedule,date},{timeZone:'America/New_York'}));
  assert.equal((moments[1]-moments[0])/3600000,hours);
 }
});

test('synchronous fallback captures receive each account zone and preserve raw input',async()=>{
 const instant=new Date('2026-10-01T00:30:00Z'),calls=[],ai=createAiService({now:()=>instant,env:{}}),original=ai.classify.bind(ai);
 ai.classify=async(...args)=>{calls.push(args);return original(...args);};
 const app=makeApp({now:()=>instant,aiService:ai});
 try{
  const a=authed(app),b=authed(app,{email:'sync@tz.test',role:'user'});
  for(const [api,zone,date,raw] of [[a,'America/New_York','2026-09-30','原文 山田'],[b,'Asia/Tokyo','2026-10-01','Original Мария']]){
   await api.put('/api/settings').send({requestedTimeZone:zone}).expect(200);
   const entry=(await api.post('/api/captures').send({raw,provider:'fallback',timeContext:{timeZone:'UTC'}}).expect(201)).body.entry;
   assert.equal(entry.raw,raw);assert.equal(entry.interpretation.classification.entities.schedule.date,date);assert.deepEqual(calls.at(-1)[6],{timeZone:zone,referenceAt:instant.toISOString()});
  }
 }finally{app.database.close();}
});

test('unchanged completion date and correction replay preserve historical occurred_at',async()=>{
 const app=makeApp();
 try{
  const api=authed(app),base=(await createAiService({env:{}}).classify('Original history','fallback')).classification;
  const completed={...base,completed:true,entities:{...base.entities,schedule:null,doneOn:{date:'2026-10-01',time:'09:00'}}};
  const ids=createLedger(app.database,{userId:api.user.id,raw:'Original history',occurredAt:'2026-10-01T05:00:00.000Z',classification:completed,provider:'manual',timeZone:'Europe/Samara'});
  const original=app.database.prepare('SELECT occurred_at FROM captures WHERE id=?').get(ids.captureId).occurred_at;
  const correction={operationKey:'historical-title',requestFingerprint:'same',patch:{summary:'New title'}};
  replaceInterpretation(app.database,ids.captureId,{...completed,summary:'New title'},'manual',correction,true,null,{timeZone:'America/New_York'});
  assert.equal(app.database.prepare('SELECT occurred_at FROM captures WHERE id=?').get(ids.captureId).occurred_at,original);
  const replay=replaceInterpretation(app.database,ids.captureId,{...completed,entities:{...completed.entities,doneOn:{date:'2026-10-02',time:'09:00'}}},'manual',correction,true,null,{timeZone:'America/New_York'});
  assert.equal(replay.replayed,true);assert.equal(app.database.prepare('SELECT occurred_at FROM captures WHERE id=?').get(ids.captureId).occurred_at,original);
  replaceInterpretation(app.database,ids.captureId,{...completed,entities:{...completed.entities,doneOn:{date:'2026-10-02',time:'09:00'}}},'manual',null,true,null,{timeZone:'America/New_York'});
  assert.equal(app.database.prepare('SELECT occurred_at FROM captures WHERE id=?').get(ids.captureId).occurred_at,'2026-10-02T13:00:00.000Z');
 }finally{app.database.close();}
});

test('sync and queued split actions use frozen capture day but retain actual creation timestamps',async()=>{
 const referenceAt='2026-10-01T23:59:00.000Z';let clock=new Date(referenceAt);
 const base=(await createAiService({env:{}}).classify('Parent','fallback')).classification;
 const classification={...base,entities:{...base.entities,schedule:null},proposedActions:[{type:'task',title:'Child 山田',details:'',people:[]}]};
 const ai={status:async()=>({selectedProvider:'fallback'}),classify:async()=>({classification,provider:'fallback',usedProvider:'fallback'})};
 const app=makeApp({now:()=>clock,aiService:ai});
 try{
  const api=authed(app);await api.put('/api/settings').send({requestedTimeZone:'UTC'}).expect(200);
  const sync=(await api.post('/api/captures').send({raw:'Parent sync',provider:'fallback'}).expect(201)).body.entry;
  const queued=(await api.post('/api/captures').set('Prefer','respond-async').send({raw:'Parent queued',provider:'fallback'}).expect(202)).body;
  clock=new Date('2026-10-02T00:01:00Z');const claim=claimCaptureJob(app.database,{owner:'split',leaseToken:'token',leaseMs:30000,currentTime:new Date().toISOString()});await app.captureJobWorker.run(claim,new AbortController());
  for(const parent of [sync.id,queued.captureId]){
   const child=app.database.prepare("SELECT c.created_at,i.classification_json FROM captures c JOIN interpretations i ON i.capture_id=c.id AND i.status='active' WHERE c.parent_capture_id=?").get(parent);
   assert.equal(JSON.parse(child.classification_json).entities.schedule.date,'2026-10-01');assert.notEqual(child.created_at,referenceAt);
  }
 }finally{app.database.close();}
});
