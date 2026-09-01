import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import { createApp } from '../server/index.js';import { fakeModelService } from './helpers/fake-model.js';import { authed } from './helpers/auth.js';import { dateInZone, shiftDate } from '../server/reports.js';

function freshApp(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pagent-reports-'));return createApp({aiService:fakeModelService(),databasePath:path.join(dir,'test.sqlite')})}
const today=()=>dateInZone(new Date(),'Europe/Samara');

// Часы записей в базе настоящие, поэтому сюжет строится от реального «сегодня»:
// просрочка и прошедшие встречи получают вчерашнюю дату, сделанное — сегодняшнее.
test('period report counts by captures: counters, tails, projects and discipline',async()=>{
  const app=freshApp(),api=authed(app),yesterday=shiftDate(today(),-1);
  // Встреча по Hub получит след: позже появится запись с тем же проектом.
  const hubMeeting=(await api.post('/api/captures').send({raw:'Завтра в 11 созвон по Hub'}).expect(201)).body.entry;
  const hubTask=(await api.post('/api/captures').send({raw:'Нужно проверить Hub'}).expect(201)).body.entry;
  const salon=(await api.post('/api/captures').send({raw:'позвонить в салон',primaryType:'todo',due:{date:yesterday}}).expect(201)).body.entry;
  const idea=(await api.post('/api/captures').send({raw:'Идея приложения с геолокацией'}).expect(201)).body.entry;
  const silent=(await api.post('/api/captures').send({raw:'Завтра в 11 созвон по TCAM'}).expect(201)).body.entry;
  const projection=hubTask.projections.find(item=>item.type==='task');
  await api.post(`/api/projections/${projection.id}/complete`).send({}).expect(200);
  await api.post(`/api/captures/${idea.id}/corrections`).send({patch:{people:['Мастер']}}).expect(200);
  // Прошедшую встречу словами не создать («вчера созвон» не даёт даты), поэтому
  // дата встречи сдвигается в прошлое прямо в классификации — отчёт читает её.
  const db=app.database;
  for(const capture of [hubMeeting,silent]){
    const row=db.prepare("SELECT id,classification_json FROM interpretations WHERE capture_id=? AND status='active'").get(capture.id);
    const classification=JSON.parse(row.classification_json);
    classification.entities.schedule={...(classification.entities.schedule||{}),state:'ok',date:yesterday,time:'11:00',sortAt:`${yesterday}T11:00:00`};
    db.prepare('UPDATE interpretations SET classification_json=? WHERE id=?').run(JSON.stringify(classification),row.id);
  }
  const report=(await api.get('/api/reports?period=week').expect(200)).body;
  assert.equal(report.counters.captures,5);
  assert.equal(report.counters.done,1);
  assert.equal(report.counters.overdue,1);
  assert.equal(report.counters.overdueOldestDays,1);
  assert.equal(report.overdue[0].captureId,salon.id);
  assert.equal(report.counters.questions,1);
  assert.equal(report.questions[0].captureId,idea.id);
  // Hub-встреча оставила след (после неё есть запись с тем же проектом), TCAM — нет.
  assert.deepEqual(report.silentMeetings.map(item=>item.captureId),[silent.id]);
  assert.ok(report.projects.find(item=>item.name==='Hub'&&item.count>=2));
  assert.equal(report.discipline.closed,1);
  assert.notEqual(report.discipline.medianDays,null);
  assert.equal(report.pulse.columns.length,7);
  assert.equal(report.pulse.columns.reduce((total,column)=>total+column.total,0),5);
  assert.equal(report.service.quality.corrections,1);
  assert.equal(report.service.quality.topField.field,'people');
  assert.equal(typeof report.service.usage.calls,'number');
  // Периоды: месяц включает сегодняшние записи, «всё время» начинается с первой.
  assert.equal((await api.get('/api/reports?period=month').expect(200)).body.counters.captures,5);
  const everything=(await api.get('/api/reports?period=all').expect(200)).body;
  assert.equal(everything.counters.captures,5);
  assert.equal(everything.from,today());
});

test('day report keeps day boundaries: feed, done, missed and defaults',async()=>{
  const api=authed(freshApp()),day=today(),yesterday=shiftDate(day,-1);
  // «Сделано» — отчётная работа (completed===true), как в «Что делал».
  const reported=(await api.post('/api/captures').send({raw:'Сделал ревью по Hub'}).expect(201)).body.entry;
  assert.equal(reported.interpretation.classification.completed,true);
  const taskEntry=(await api.post('/api/captures').send({raw:'Нужно подготовить отчёт'}).expect(201)).body.entry;
  await api.post('/api/captures').send({raw:'Просто дневная запись'}).expect(201);
  const missed=(await api.post('/api/captures').send({raw:'позвонить в салон',primaryType:'todo',due:{date:yesterday}}).expect(201)).body.entry;
  // Задача, снятая галочкой, — уход из TODO, а не запись в дневник: в «Сделано» её нет.
  const projection=taskEntry.projections.find(item=>item.type==='task');
  await api.post(`/api/projections/${projection.id}/complete`).send({}).expect(200);
  const todayReport=(await api.get(`/api/reports/day?date=${day}`).expect(200)).body;
  assert.equal(todayReport.feed.length,4);
  assert.deepEqual(todayReport.done.map(row=>row.captureId),[reported.id]);
  // Сегодняшний день ещё не кончился — «не успел» по нему не выносится.
  assert.equal(todayReport.missed.length,0);
  const yesterdayReport=(await api.get('/api/reports/day').expect(200)).body;
  assert.equal(yesterdayReport.date,yesterday);
  assert.equal(yesterdayReport.latest,yesterday);
  assert.equal(yesterdayReport.feed.length,0);
  assert.deepEqual(yesterdayReport.missed.map(row=>({captureId:row.captureId,closedLater:row.closedLater})),[{captureId:missed.id,closedLater:false}]);
  assert.equal(yesterdayReport.hasOlder,false);
});

test('reports validate input and stay private per user',async()=>{
  const app=freshApp(),api=authed(app);
  await api.post('/api/captures').send({raw:'Нужно проверить Hub'}).expect(201);
  await api.get('/api/reports?period=year').expect(400);
  await api.get('/api/reports/day?date=2026-13-40').expect(400);
  const stranger=authed(app,{email:'stranger@kizuna.test',role:'user'});
  const foreign=(await stranger.get('/api/reports?period=all').expect(200)).body;
  assert.equal(foreign.counters.captures,0);
  assert.equal(foreign.overdue.length,0);
  assert.equal((await stranger.get('/api/reports/day').expect(200)).body.feed.length,0);
});
