import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import request from 'supertest';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import { createApp } from '../server/index.js';import { openDatabase, createLedger } from '../server/db.js';import { fakeModelService, fakeModelClassification } from './helpers/fake-model.js';import { authed } from './helpers/auth.js';
function app(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pagent-'));return createApp({aiService:fakeModelService(),databasePath:path.join(dir,'test.sqlite')})}
// Журнал у каждого свой, поэтому запрос без учётной записи получает 401:
// тесты ходят от лица заведённого администратора.
function signedIn(){return authed(app())}
test('status reports the configured provider and a capture persists',async()=>{const api=signedIn();const status=await api.get('/api/status');assert.equal(status.body.mode,'openrouter');const created=await api.post('/api/captures').send({raw:'Завтра в 11 созвон по Hub'}).expect(201);assert.equal(created.body.entry.raw,'Завтра в 11 созвон по Hub');const entries=await api.get('/api/entries');assert.equal(entries.body.entries.length,1)});
test('reports of finished work are todos closed at birth: one task projection, one completed event, nothing open',async()=>{const api=signedIn();for(const raw of ['Поговорили на дейли','Готово: обсудили план','Сделано обновление контекста']){const created=(await api.post('/api/captures').send({raw}).expect(201)).body.entry;assert.equal(created.interpretation.classification.primaryType,'task',raw);assert.equal(created.interpretation.classification.completed,true,raw);assert.deepEqual(created.projections.map(projection=>projection.type),['task'],raw);assert.equal(created.projections[0].completionCandidate,null,raw);assert.equal(created.projections[0].completion.completed,true,raw);assert.ok(created.projections[0].completion.completedAt,raw);const events=(await api.get('/api/export')).body.ledgerEvents.filter(event=>event.capture_id===created.id&&event.event_type==='completed');assert.equal(events.length,1,raw);assert.equal(events[0].projection_id,created.projections[0].id,raw)}const day=(await api.get('/api/day').expect(200)).body;assert.equal(day.upcoming.length,0);assert.equal(day.attention.length,0)});
test('correction preserves immutable raw, one active version and idempotent undo',async()=>{const api=signedIn();const created=await api.post('/api/captures').send({raw:'Нужно проверить CP'});const id=created.body.entry.id;await api.post(`/api/captures/${id}/corrections`).send({primaryType:'note'}).expect(200);const entries=await api.get('/api/entries');assert.equal(entries.body.entries[0].raw,'Нужно проверить CP');const corrected=entries.body.entries[0].projections[0].undoGroupId;assert.equal((await api.post('/api/undo').send({undoGroupId:corrected})).body.reverted,1);assert.equal((await api.post('/api/undo').send({undoGroupId:corrected})).body.reverted,0);const later=await api.get('/api/entries');assert.equal(later.body.entries[0].projections.length,0);const exported=(await api.get('/api/export')).body;assert.equal(exported.interpretations.filter(item=>item.capture_id===id&&item.status==='active').length,1);assert.equal(exported.interpretations.filter(item=>item.capture_id===id&&item.status==='superseded').length,1)});
test('rejects oversized capture and incorrect reset phrase',async()=>{const api=signedIn();await api.post('/api/captures').send({raw:'x'.repeat(10001)}).expect(400);await api.post('/api/reset').send({confirmation:'no'}).expect(400)});
test('does not expose server, data, config or package files',async()=>{const api=signedIn();for(const path of ['/data/pagent.sqlite','/server/ai.js','/.env','/package.json'])await api.get(path).expect(404);await api.get('/public/app.js').expect(200);// Макеты в репозитории не живут — и раздавать их нечем.
await api.get('/prototype.html').expect(404)});
test('validates date and preserves undo group isolation',async()=>{const api=signedIn();const a=(await api.post('/api/captures').send({raw:'Нужно проверить Hub'})).body,b=(await api.post('/api/captures').send({raw:'Нужно проверить TCAM'})).body;await api.get('/api/day?date=no').expect(400);await api.post('/api/undo').send({undoGroupId:a.undoGroupId}).expect(200);const entries=(await api.get('/api/entries')).body.entries;assert.equal(entries.find(e=>e.id===a.entry.id).projections.length,0);assert.ok(entries.find(e=>e.id===b.entry.id).projections.length>0)});
test('conflicting meeting is gated before projection and correction releases it',async()=>{const api=signedIn();const created=(await api.post('/api/captures').send({raw:'Завтра и послезавтра созвон по Hub'})).body;assert.equal(created.review.level,'conflict');assert.equal(created.entry.projections.length,0);const fixed=await api.post(`/api/captures/${created.entry.id}/corrections`).send({patch:{schedule:{date:'2026-08-21',time:'11:00'},project:'Hub'}}).expect(200);assert.ok(fixed.body.entry.projections.length>0);const entries=(await api.get('/api/entries')).body.entries;assert.equal(entries[0].raw,'Завтра и послезавтра созвон по Hub')});
test('correction accepts all fields, versions interpretation and rejects malformed schedules',async()=>{const api=signedIn();const created=(await api.post('/api/captures').send({raw:'Завтра и послезавтра созвон по Hub и TCAM'})).body;const fixed=(await api.post(`/api/captures/${created.entry.id}/corrections`).send({patch:{primaryType:'meeting_event',schedule:{date:'2026-08-23',time:'09:30'},project:'Свой проект',people:['Анна','BE'],followUp:'Подготовить вопросы'}}).expect(200)).body;const c=fixed.entry.interpretation.classification;assert.equal(fixed.entry.raw,'Завтра и послезавтра созвон по Hub и TCAM');assert.equal(fixed.entry.interpretation.version,2);assert.deepEqual(c.entities.projects,['Свой проект']);assert.deepEqual(c.entities.people,['Анна','BE']);assert.equal(c.entities.followUp,'Подготовить вопросы');assert.equal(c.entities.schedule.time,'09:30');assert.ok(fixed.entry.projections.length>0);await api.post(`/api/captures/${created.entry.id}/corrections`).send({patch:{schedule:{date:'2026-02-31',time:'28:90'}}}).expect(400)});
test('default day derives from configured timezone and invalid timezone fails fast',async()=>{const fixedNow=()=>new Date('2026-08-20T00:30:00Z');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pagent-zone-'));const api=authed(createApp({aiService:fakeModelService({now:fixedNow}),databasePath:path.join(dir,'test.sqlite'),timeZone:'Pacific/Honolulu',now:fixedNow}));assert.equal((await api.get('/api/day')).body.date,'2026-08-19');assert.throws(()=>createApp({aiService:fakeModelService(),databasePath:path.join(dir,'invalid.sqlite'),timeZone:'not/a-zone'}),/Invalid PAGENT_TIMEZONE/)});
test('day filters by date and upcoming items are ordered by local schedule',async()=>{const fixedNow=()=>new Date('2026-08-20T08:00:00Z');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pagent-day-'));const api=authed(createApp({aiService:fakeModelService({now:fixedNow}),databasePath:path.join(dir,'test.sqlite'),now:fixedNow}));await api.post('/api/captures').send({raw:'Завтра в 12 созвон по Hub'}).expect(201);await api.post('/api/captures').send({raw:'Завтра в 09 созвон по TCAM'}).expect(201);await api.post('/api/captures').send({raw:'Нужно проверить CP'}).expect(201);const view=(await api.get('/api/day?date=2026-08-21')).body;assert.equal(view.day.length,2);assert.deepEqual(view.upcoming.map(entry=>entry.interpretation.classification.entities.schedule.time),[null,'09:00','12:00'],'дело без даты лежит на сегодня и идёт первым');assert.equal(view.attention.length,0,'дела без срока больше нет: всё, что без даты, легло на сегодня');assert.equal((await api.get('/api/day?date=2026-08-20')).body.day.length,1)});
test('entries pagination, export and reset preserve their contracts',async()=>{const api=signedIn();for(const raw of ['первая','вторая','третья'])await api.post('/api/captures').send({raw}).expect(201);const first=(await api.get('/api/entries?limit=2')).body;assert.equal(first.entries.length,2);assert.ok(first.nextCursor);assert.equal((await api.get(`/api/entries?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)).body.entries.length,1);const exported=(await api.get('/api/export')).body;assert.equal(exported.captures.length,3);await api.post('/api/reset').send({confirmation:'СБРОСИТЬ КИЗУНА'}).expect(200);assert.equal((await api.get('/api/entries')).body.entries.length,0)});
test('opening the same database twice keeps migrations idempotent',async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pagent-migration-'));const databasePath=path.join(dir,'ledger.sqlite');const first=authed(createApp({aiService:fakeModelService(),databasePath}));await first.post('/api/captures').send({raw:'Запись'}).expect(201);const second=authed(createApp({aiService:fakeModelService(),databasePath}));assert.equal((await second.get('/api/entries')).body.entries.length,1)});
test('memory retrieval understands natural Russian questions and ranks meaningful matches',async()=>{const api=signedIn();await api.post('/api/captures').send({raw:'Сегодня в 16:00 созвон с BE по Hub'}).expect(201);await api.post('/api/captures').send({raw:'Решили по секретам сессий: подготовить ротацию ключей'}).expect(201);await api.post('/api/captures').send({raw:'Случайная заметка о погоде'}).expect(201);const hub=(await api.post('/api/memory/answer').send({query:'Что было по Hub?'}).expect(200)).body;assert.equal(hub.sources.length,1);assert.match(hub.sources[0].snippet,/Hub/);const ranked=(await api.post('/api/memory/search').send({query:'что решили по секретам сессий'}).expect(200)).body.results;assert.match(ranked[0].snippet,/секретам сессий/);for(const query of ['НЕСВЯЗАННЫЙ запрос','HUB!!!','%\' OR 1=1 --']){const result=(await api.post('/api/memory/search').send({query}).expect(200)).body.results;if(query==='HUB!!!')assert.equal(result.length,1);else assert.equal(result.length,0)}});
test('memory query and context are bounded',async()=>{const seen=[];const aiService={status:()=>({mode:'fallback'}),classify:async raw=>({classification:{primaryType:'note',entities:{projects:[],people:[],schedule:null,followUp:null},additionalTypes:[],summary:raw,proposedActions:[],claims:[],confidence:{},conflicts:{}},provider:'fallback'}),answer:async(query,sources)=>{seen.push({query,sources});return {answer:'ok',citationIds:sources.slice(0,1).map(source=>source.captureId),provider:'fallback'}}};const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pagent-memory-'));const api=authed(createApp({databasePath:path.join(dir,'test.sqlite'),aiService}));for(let index=0;index<13;index+=1)await api.post('/api/captures').send({raw:`Hub ${index} ${'контекст '.repeat(80)}`}).expect(201);await api.post('/api/memory/answer').send({query:'Что было по Hub?'}).expect(200);assert.ok(seen[0].sources.length<=12);assert.ok(seen[0].sources.reduce((total,source)=>total+source.snippet.length+source.captureId.length+5,0)+seen[0].query.length+40<=15000);await api.post('/api/memory/search').send({query:'x'.repeat(2001)}).expect(400);await api.post('/api/memory/answer').send({query:'x'.repeat(2001)}).expect(400)});
test('completed capture keeps the request signal alive until the response is written',async()=>{let observed;const aiService={status:()=>({}),classify:async(raw,provider,signal)=>{observed=signal;return {classification:fakeModelClassification(raw),provider:'fallback',requestedProvider:'fallback',usedProvider:'fallback',fallbackReason:null}},answer:async()=>({answer:'',citationIds:[]})};const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pagent-signal-'));await authed(createApp({databasePath:path.join(dir,'test.sqlite'),aiService})).post('/api/captures').send({raw:'Нужно проверить Hub'}).expect(201);assert.equal(observed.aborted,false)});
test('client abort propagates to a slow provider and no capture is persisted',async()=>{let abortObserved;let release;const finished=new Promise(resolve=>{release=resolve});const aiService={status:()=>({}),classify:async(raw,provider,signal)=>new Promise(resolve=>{signal.addEventListener('abort',()=>{abortObserved=true;release();resolve({classification:fakeModelClassification(raw),provider:'fallback',requestedProvider:'fallback',usedProvider:'fallback'});},{once:true})}),answer:async()=>({answer:'',citationIds:[]})};const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pagent-abort-api-'));const app=createApp({databasePath:path.join(dir,'test.sqlite'),aiService});const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const {port}=server.address();const api=authed(app);const client=http.request({host:'127.0.0.1',port,path:'/api/captures',method:'POST',headers:{'content-type':'application/json',Cookie:api.cookie}},()=>{});client.on('error',()=>{});client.end(JSON.stringify({raw:'Нужно проверить Hub'}));setTimeout(()=>client.destroy(),20);await Promise.race([finished,new Promise((_,reject)=>setTimeout(()=>reject(new Error('abort was not propagated')),1000))]);assert.equal(abortObserved,true);await new Promise(resolve=>setTimeout(resolve,20));assert.equal((await api.get('/api/entries')).body.entries.length,0);await new Promise(resolve=>server.close(resolve))});
test('task and meeting completion append exactly one factual ledger event and compensation',async()=>{const api=signedIn();for(const raw of ['Нужно проверить Hub','Завтра в 11 созвон по TCAM']){const created=(await api.post('/api/captures').send({raw}).expect(201)).body,projection=created.entry.projections.find(item=>['task','meeting_event'].includes(item.type));assert.ok(projection);assert.deepEqual(projection.completion,{completed:false,completedAt:null,actor:null});assert.equal(projection.completionCandidate,null);const complete=await api.post(`/api/projections/${projection.id}/complete`).send({}).expect(200);assert.equal(complete.body.changed,true);assert.equal(complete.body.completion.completed,true);assert.equal((await api.post(`/api/projections/${projection.id}/complete`).send({}).expect(200)).body.changed,false);const undone=await api.post(`/api/projections/${projection.id}/undo-complete`).send({}).expect(200);assert.equal(undone.body.changed,true);assert.equal((await api.post(`/api/projections/${projection.id}/undo-complete`).send({}).expect(200)).body.changed,false);const ledger=(await api.get('/api/export').expect(200)).body.ledgerEvents.filter(event=>event.projection_id===projection.id);assert.deepEqual(ledger.map(event=>event.event_type),['completed','completion_undone']);assert.ok(ledger.every(event=>event.capture_id===created.entry.id&&event.interpretation_id===created.entry.interpretation.id&&event.actor==='user'&&event.occurred_at));assert.equal((await api.get('/api/entries')).body.entries.find(entry=>entry.id===created.entry.id).raw,raw)}});
test('completion state is stable across reload, rejects inactive targets, and no candidate becomes factual',async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pagent-completion-')),databasePath=path.join(dir,'test.sqlite'),first=authed(createApp({aiService:fakeModelService(),databasePath}));const created=(await first.post('/api/captures').send({raw:'Нужно проверить reload'}).expect(201)).body,projection=created.entry.projections.find(item=>item.type==='task');await Promise.all([first.post(`/api/projections/${projection.id}/complete`).send({}),first.post(`/api/projections/${projection.id}/complete`).send({})]);const after=authed(createApp({aiService:fakeModelService(),databasePath})),entry=(await after.get('/api/entries').expect(200)).body.entries[0],current=entry.projections.find(item=>item.id===projection.id);assert.deepEqual(current.completionCandidate,null);assert.equal(current.completion.completed,true);assert.ok(current.completion.completedAt);assert.deepEqual(Object.keys(current.completion).sort(),['actor','completed','completedAt']);assert.equal((await after.get('/api/export')).body.ledgerEvents.filter(event=>event.projection_id===projection.id&&event.event_type==='completed').length,1);await Promise.all([after.post(`/api/projections/${projection.id}/undo-complete`).send({}),after.post(`/api/projections/${projection.id}/undo-complete`).send({})]);assert.equal((await after.get('/api/export')).body.ledgerEvents.filter(event=>event.projection_id===projection.id&&event.event_type==='completion_undone').length,1);await after.post('/api/projections/not-a-uuid/complete').send({}).expect(400);await after.post(`/api/captures/${created.entry.id}/corrections`).send({patch:{project:'Новый проект'}}).expect(200);await after.post(`/api/projections/${projection.id}/complete`).send({}).expect(409)});
test('capture accepts user overrides: due, priority and tags land as facts, the type is ignored',async()=>{const api=signedIn();const created=(await api.post('/api/captures').send({raw:'созвон с Даниилом',primaryType:'todo',due:{date:'2026-08-25',time:'15:00'},priority:'high',tags:['#Hub','созвон','hub']}).expect(201)).body;const c=created.entry.interpretation.classification;assert.equal(c.primaryType,'task');assert.equal(c.entities.schedule.date,'2026-08-25');assert.equal(c.entities.schedule.time,'15:00');assert.equal(c.priority,'high');assert.deepEqual(c.tags,['hub','созвон']);assert.equal(created.review.level,'high');const scheduleClaim=c.claims.find(claim=>claim.field==='schedule');assert.equal(scheduleClaim.kind,'fact');assert.equal(scheduleClaim.confidence,1);const tags=(await api.get('/api/tags').expect(200)).body.tags;assert.deepEqual(tags.sort(),['hub','созвон'].sort())});
test('capture override validation: type is ignored, a bad due, priority and oversized tags are rejected',async()=>{const api=signedIn();const ignored=(await api.post('/api/captures').send({raw:'x',primaryType:'meeting_event'}).expect(201)).body.entry;assert.equal(ignored.interpretation.classification.primaryType,'task');await api.post('/api/captures').send({raw:'x',primaryType:'nonsense'}).expect(201);const noted=(await api.post('/api/captures').send({raw:'x',primaryType:'note',due:{date:'2026-08-25'},priority:'high'}).expect(201)).body.entry.interpretation.classification;assert.equal(noted.entities.schedule.date,'2026-08-25');assert.equal(noted.priority,'high');await api.post('/api/captures').send({raw:'x',priority:'urgent'}).expect(400);await api.post('/api/captures').send({raw:'x',tags:Array.from({length:9},(_, index)=>`t${index}`)}).expect(400);await api.post('/api/captures').send({raw:'x',due:{date:'2031-01-01'}}).expect(400)});
test('async capture applies overrides after the model result',async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pagent-ovr-'));const application=createApp({aiService:fakeModelService(),databasePath:path.join(dir,'test.sqlite')});application.captureJobWorker.start();const api=authed(application);const queued=(await api.post('/api/captures').set('Prefer','respond-async').send({raw:'разобраться с релизом',primaryType:'todo',due:{date:'2026-08-26'},priority:'low',tags:['релиз']}).expect(202)).body;for(let attempt=0;attempt<80;attempt++){const job=(await api.get(queued.statusUrl)).body;if(job.state==='succeeded')break;await new Promise(resolve=>setTimeout(resolve,25))}const entries=(await api.get('/api/entries')).body.entries;const entry=entries.find(item=>item.id===queued.captureId);const c=entry.interpretation.classification;assert.equal(c.primaryType,'task');assert.equal(c.entities.schedule.date,'2026-08-26');assert.equal(c.priority,'low');assert.deepEqual(c.tags,['релиз']);await application.captureJobWorker.stop()});
test('memory search understands russian cases without dragging in strangers',async()=>{const api=signedIn();await api.post('/api/captures').send({raw:'созвон с Даниилом по релизу Hub'}).expect(201);await api.post('/api/captures').send({raw:'проверить отчёты по проекту CP'}).expect(201);const found=async query=>(await api.post('/api/memory/search').send({query}).expect(200)).body.results.map(result=>result.snippet);
// Падеж не должен мешать: «про Даниила» находит «с Даниилом».
assert.deepEqual(await found('Даниила'),['созвон с Даниилом по релизу Hub']);
assert.deepEqual(await found('отчёт'),['проверить отчёты по проекту CP']);
// Совпадение по началу слова не должно тащить всё подряд.
assert.deepEqual(await found('совсем другое слово'),[]);
// Короткие слова по началу не сопоставляются: иначе «Hub» цеплял бы всё.
assert.deepEqual(await found('CP'),['проверить отчёты по проекту CP']);});
test('deleting a capture hides it everywhere but keeps it in the ledger, and it can be restored',async()=>{const api=signedIn();const created=(await api.post('/api/captures').send({raw:'Завтра в 11 созвон по Hub про удаление'}).expect(201)).body.entry;
assert.equal((await api.get('/api/entries')).body.entries.length,1);
assert.equal((await api.post('/api/memory/search').send({query:'удаление'})).body.results.length,1);
// Удаление: запись уходит из списков, поиска и дня, проекции снимаются.
const deleted=(await api.delete(`/api/captures/${created.id}`).expect(200)).body;
assert.equal(deleted.captureId,created.id);
assert.ok(deleted.revertedProjections>=1);
assert.equal((await api.get('/api/entries')).body.entries.length,0);
assert.equal((await api.post('/api/memory/search').send({query:'удаление'})).body.results.length,0);
const day=(await api.get('/api/day')).body;assert.equal(day.day.length+day.upcoming.length+day.attention.length,0);
// Журнал ничего не забывает: запись и событие остаются в экспорте.
const exported=(await api.get('/api/export')).body;
assert.equal(exported.captures.filter(capture=>capture.id===created.id).length,1);
assert.ok(exported.captures.find(capture=>capture.id===created.id).deleted_at);
assert.ok(exported.ledgerEvents.some(event=>event.capture_id===created.id&&event.event_type==='capture_deleted'));
// Возврат поднимает и запись, и снятые ею проекции.
const restored=(await api.post(`/api/captures/${created.id}/restore`).expect(200)).body;
assert.equal(restored.restored,true);
assert.ok(restored.restoredProjections>=1);
const back=(await api.get('/api/entries')).body.entries;
assert.equal(back.length,1);
assert.ok(back[0].projections.length>=1);
assert.equal(back[0].raw,'Завтра в 11 созвон по Hub про удаление');});

test('deleting is idempotent-safe and unknown captures are refused',async()=>{const api=signedIn();const created=(await api.post('/api/captures').send({raw:'Нужно проверить повторное удаление'}).expect(201)).body.entry;
await api.delete(`/api/captures/${created.id}`).expect(200);
// Повторное удаление уже удалённой записи — не «успех», а честные 404.
await api.delete(`/api/captures/${created.id}`).expect(404);
await api.delete('/api/captures/00000000-0000-4000-8000-000000000000').expect(404);
await api.post('/api/captures/00000000-0000-4000-8000-000000000000/restore').expect(404);
// Повторный возврат ничего не ломает.
assert.equal((await api.post(`/api/captures/${created.id}/restore`).expect(200)).body.restored,true);
assert.equal((await api.post(`/api/captures/${created.id}/restore`).expect(200)).body.restored,false);});

test('a deleted capture stays out of the daily brief and the tag list',async()=>{const api=signedIn();const created=(await api.post('/api/captures').send({raw:'Решили по секретам: ротация ключей'}).expect(201)).body.entry;
await api.post(`/api/captures/${created.id}/corrections`).send({patch:{primaryType:'note'}}).expect(200);
await api.delete(`/api/captures/${created.id}`).expect(200);
const tags=(await api.get('/api/tags').expect(200)).body.tags;
assert.equal(tags.length,0);
const brief=(await api.get('/api/daily-brief').expect(200)).body;
const texts=brief.content.sections.flatMap(section=>section.items.map(item=>item.text)).join(' ');
assert.equal(texts.includes('ротация ключей'),false);});

// Ошибка в теле запроса — вина клиента: битый JSON и превышенный лимит должны
// отличаться от отказа сервера, иначе интерфейс покажет «internal_error» на
// собственную опечатку и повторит запрос как будто виноват сервер.
test('a malformed or oversized body answers as a client error, not a server failure',async()=>{const api=signedIn();const broken=await api.post('/api/captures').set('Content-Type','application/json').send('{oops').expect(400);assert.equal(broken.body.error.code,'invalid_json');const huge=await api.post('/api/captures').set('Content-Type','application/json').send(JSON.stringify({raw:'x'.repeat(40000)})).expect(413);assert.equal(huge.body.error.code,'payload_too_large');await api.post('/api/captures').send({raw:'обычная запись'}).expect(201)});

// Живое обновление: страница подписывается на поток и перерисовывает карточки
// сама. Без него запись, сделанную голосом или дочитанную разбором в фоне,
// приходилось ждать до перезагрузки страницы.
test('the journal stream announces changes to whoever is listening',async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pagent-events-'));const application=createApp({aiService:fakeModelService(),databasePath:path.join(dir,'test.sqlite')});const server=application.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const {port}=server.address();
  const lines=[];
  // Поток журнала закрыт так же, как и всё остальное: слушать чужой журнал
  // нельзя, поэтому подписка идёт с кукой сессии.
  const api=authed(application,{target:server});
  const stream=await new Promise((resolve,reject)=>{const request=http.request({host:'127.0.0.1',port,path:'/api/events',method:'GET',headers:{Cookie:api.cookie}},response=>{assert.equal(response.statusCode,200);assert.match(response.headers['content-type'],/text\/event-stream/);response.setEncoding('utf8');response.on('data',chunk=>lines.push(chunk));resolve(request)});request.on('error',reject);request.end()});
  const waitFor=async predicate=>{for(let attempt=0;attempt<80;attempt+=1){if(predicate(lines.join('')))return true;await new Promise(resolve=>setTimeout(resolve,25))}return false};
  // Первое сообщение приходит сразу: клиент понимает, что поток жив.
  assert.equal(await waitFor(text=>text.includes('event: ready')),true,'поток здоровается');

  const created=(await api.post('/api/captures').send({raw:'Нужно проверить поток'}).expect(201)).body.entry;
  assert.equal(await waitFor(text=>text.includes('event: journal')),true,'о новой записи сообщили');

  lines.length=0;
  await api.delete(`/api/captures/${created.id}`).expect(200);
  assert.equal(await waitFor(text=>text.includes('"reason":"delete"')),true,'об удалении тоже');

  lines.length=0;
  await api.post(`/api/captures/${created.id}/restore`).expect(200);
  assert.equal(await waitFor(text=>text.includes('"reason":"restore"')),true,'и о возврате');

  // Выключение закрывает потоки само: открытый ответ иначе не давал бы
  // server.close завершиться, и systemd убивал бы процесс по таймауту.
  assert.equal(application.closeEventStreams(),1);
  assert.equal(await waitFor(text=>text.includes('event: bye')),true,'поток попрощался');
  assert.equal(await waitFor(()=>stream.destroyed),true,'соединение закрыто сервером');
  assert.equal(application.closeEventStreams(),0);
  await new Promise(resolve=>server.close(resolve));
});
test('correction can change the title, projections follow, and blank titles are rejected',async()=>{const api=signedIn();const created=(await api.post('/api/captures').send({raw:'Нужно проверить Hub'}).expect(201)).body.entry;const fixed=(await api.post(`/api/captures/${created.id}/corrections`).send({patch:{summary:'Проверить Hub после релиза'}}).expect(200)).body;assert.equal(fixed.entry.interpretation.classification.summary,'Проверить Hub после релиза');assert.equal(fixed.entry.raw,'Нужно проверить Hub');assert.equal(fixed.entry.interpretation.version,2);const task=fixed.entry.projections.find(projection=>projection.type==='task');assert.equal(task.payload.title,'Проверить Hub после релиза');await api.post(`/api/captures/${created.id}/corrections`).send({patch:{summary:'   '}}).expect(400);await api.post(`/api/captures/${created.id}/corrections`).send({patch:{summary:'x'.repeat(501)}}).expect(400)});

// «Сделал X» — не отдельный вид записи, а туду, закрытая при записи. Отметка
// «сделано» в карточке — тот же кружок: ставит и снимает закрытие.
test('a record asked for «as a result» is a todo closed at once, and the done flag in the card is the circle',async()=>{const api=signedIn();
  const created=(await api.post('/api/captures').send({raw:'Созвон с Худояровым и Филимоновым — поставь как результат'}).expect(201)).body.entry;
  assert.equal(created.interpretation.classification.primaryType,'task');
  assert.equal(created.interpretation.classification.completed,true);
  assert.equal(created.projections[0].completion.completed,true);
  const open=(await api.post('/api/captures').send({raw:'Нужно проверить бэкапы'}).expect(201)).body.entry;
  assert.equal(open.interpretation.classification.completed,false);
  assert.equal(open.projections[0].completion.completed,false);
  const reopened=(await api.post(`/api/captures/${created.id}/corrections`).send({patch:{completed:false}}).expect(200)).body.entry;
  assert.equal(reopened.interpretation.classification.completed,false);
  assert.equal(reopened.projections.find(projection=>projection.type==='task').completion.completed,false);
  const again=(await api.post(`/api/captures/${created.id}/corrections`).send({patch:{completed:true}}).expect(200)).body.entry;
  assert.equal(again.projections.find(projection=>projection.type==='task').completion.completed,true);
  const ledger=(await api.get('/api/export')).body.ledgerEvents.filter(event=>event.capture_id===created.id&&['completed','completion_undone'].includes(event.event_type)).map(event=>event.event_type);
  assert.deepEqual(ledger,['completed','completed'],'возврат в работу пересобирает дело без отметки, повторное закрытие пишет новую');
});

// Отметка «сделано» у дела в поправке закрывает его, а не превращает в другую
// сущность; возвращение в работу открывает то же дело.
test('marking a todo done in a correction closes it and keeps it a todo; unmarking reopens it',async()=>{const api=signedIn();
  const created=(await api.post('/api/captures').send({raw:'Нужно проверить отметку сделанного'}).expect(201)).body.entry;
  assert.deepEqual(created.projections.map(projection=>projection.type),['task']);
  const done=(await api.post(`/api/captures/${created.id}/corrections`).send({patch:{completed:true}}).expect(200)).body.entry;
  assert.equal(done.interpretation.classification.primaryType,'task');
  assert.equal(done.interpretation.classification.completed,true);
  assert.deepEqual(done.projections.map(projection=>projection.type),['task']);
  assert.equal(done.projections[0].completion.completed,true);
  const reopened=(await api.post(`/api/captures/${created.id}/corrections`).send({patch:{completed:false}}).expect(200)).body.entry;
  assert.equal(reopened.interpretation.classification.primaryType,'task');
  assert.deepEqual(reopened.projections.map(projection=>projection.type),['task']);
  assert.equal(reopened.projections[0].completion.completed,false);
});

// Записи, разобранные до «только туду», при открытии журнала не
// переписываются: старый отчёт остаётся отчётом, старая заметка — заметкой.
test('old records of other types are left as they are when the journal opens',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pagent-legacy-')),databasePath=path.join(dir,'test.sqlite');
  const legacy=(primaryType,summary)=>({primaryType,summary,entities:{projects:[],people:[],schedule:null,followUp:null},additionalTypes:[],proposedActions:[],completed:true,ambiguity:null,claims:[{field:'type',value:primaryType,kind:'inference',confidence:0.9,provenance:{source:'model'},essential:true}],confidence:{type:0.9},conflicts:{projects:false,schedule:false}});
  let db=openDatabase(databasePath);
  const ids=[['meeting_event','Обсудили орг вопросы с Даниилом'],['note','Доступы к стенду'],['outcome_decision','Релизил хаб']].map(([type,summary])=>createLedger(db,{raw:summary,classification:legacy(type,summary),provider:'openrouter',model:'m'}).captureId);
  db.close();
  for(let pass=0;pass<2;pass+=1){
    db=openDatabase(databasePath);
    for(const captureId of ids){
      const active=db.prepare("SELECT version,classification_json FROM interpretations WHERE capture_id=? AND status='active'").get(captureId);
      assert.equal(active.version,1,'открытие журнала ничего не переписывает');
      assert.equal(JSON.parse(active.classification_json).completed,true);
    }
    assert.equal(JSON.parse(db.prepare("SELECT classification_json FROM interpretations WHERE capture_id=? AND status='active'").get(ids[0]).classification_json).primaryType,'meeting_event');
    db.close();
  }
});

// «Доработал TCAM … поставь это на пятницу как результат», набранное в субботу
// ночью: запись ложится в пятничное «Что делал» — occurred_at сдвигается на
// названный день, часы набора остаются. Оба входа — синхронный и через очередь.
// Часы приложения настоящие: у очереди аренда задачи сверяется с ними.
test('a done record named for Friday lands on Friday in the journal',async()=>{const saturdayNight=()=>new Date('2026-09-25T22:32:10Z');const raw='Доработал TCAM нов правила + авторелиз - только поставь это на пятницу как результат';const day=at=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Samara',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pagent-done-day-'));const application=createApp({aiService:fakeModelService({now:saturdayNight}),databasePath:path.join(dir,'test.sqlite')});const api=authed(application);
  const sync=(await api.post('/api/captures').send({raw}).expect(201)).body.entry;
  assert.equal(sync.interpretation.classification.primaryType,'task');assert.equal(sync.interpretation.classification.completed,true);assert.deepEqual(sync.interpretation.classification.entities.doneOn,{date:'2026-09-25',time:null});assert.equal(sync.interpretation.classification.entities.schedule,null);
  const clock=at=>new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Samara',hour:'2-digit',minute:'2-digit'}).format(new Date(at));
  assert.equal(day(sync.occurredAt),'2026-09-25','пятница, а не день набора');assert.equal(clock(sync.occurredAt),clock(sync.createdAt),'часы набора остались');assert.notEqual(day(sync.createdAt),day(sync.occurredAt),'когда набрано — не переписывается');
  application.captureJobWorker.start();const queued=(await api.post('/api/captures').set('Prefer','respond-async').send({raw}).expect(202)).body;for(let attempt=0;attempt<80;attempt++){const job=(await api.get(queued.statusUrl)).body;if(job.state==='succeeded')break;await new Promise(resolve=>setTimeout(resolve,25))}
  const queuedEntry=(await api.get('/api/entries')).body.entries.find(item=>item.id===queued.captureId);assert.equal(day(queuedEntry.occurredAt),'2026-09-25');assert.equal(queuedEntry.interpretation.classification.primaryType,'task');assert.equal(day(queuedEntry.projections[0].completion.completedAt),'2026-09-25','и кружок закрыт в пятницу');
  // Сделанное без названного дня остаётся в дне набора.
  const plain=(await api.post('/api/captures').send({raw:'Доработал TCAM нов правила'}).expect(201)).body.entry;assert.equal(plain.occurredAt,plain.createdAt);assert.equal(plain.interpretation.classification.entities.doneOn,undefined);
  await application.captureJobWorker.stop()});

// Разбор присылает описание туду (details): оно ложится первой версией заметки —
// это «Описание» в карточке. Пусто — заметки нет, в карточке остаётся исходный текст.
test('the description from the parse becomes the note of the todo, both for the direct and the queued capture',async()=>{
  const described={...fakeModelService(),async classify(raw,provider){const base=await fakeModelService().classify(raw,provider);return {...base,classification:{...base.classification,details:raw.includes('без описания')?'':'Аня просит смету до пятницы, в ней — три раздела.'}}}};
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pagent-details-'));const application=createApp({aiService:described,databasePath:path.join(dir,'test.sqlite')});const api=authed(application);
  const direct=(await api.post('/api/captures').send({raw:'Аня написала про смету, нужно отправить'}).expect(201)).body.entry;
  assert.equal(direct.note.body,'Аня просит смету до пятницы, в ней — три раздела.');assert.equal(direct.note.version,1);assert.equal(direct.raw,'Аня написала про смету, нужно отправить');
  const bare=(await api.post('/api/captures').send({raw:'Позвонить без описания'}).expect(201)).body.entry;assert.equal(bare.note,null);
  application.captureJobWorker.start();const queued=(await api.post('/api/captures').set('Prefer','respond-async').send({raw:'Через очередь: отправить смету'}).expect(202)).body;
  for(let attempt=0;attempt<80;attempt++){const job=(await api.get(queued.statusUrl)).body;if(job.state==='succeeded')break;await new Promise(resolve=>setTimeout(resolve,25))}
  const entry=(await api.get('/api/entries')).body.entries.find(item=>item.id===queued.captureId);assert.equal(entry.note.body,'Аня просит смету до пятницы, в ней — три раздела.');
  await application.captureJobWorker.stop()});
