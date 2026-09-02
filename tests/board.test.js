import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import { createApp } from '../server/index.js';import { fakeModelService } from './helpers/fake-model.js';import { authed } from './helpers/auth.js';import { dateInZone, shiftDate } from '../server/reports.js';

function freshApp(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pagent-board-'));return createApp({aiService:fakeModelService(),databasePath:path.join(dir,'test.sqlite')})}
const today=()=>dateInZone(new Date(),'Europe/Samara');
const names=board=>board.columns.map(column=>column.name);
const cardsOf=(board,name)=>board.columns.find(column=>column.name===name).cards.map(card=>card.title);

test('board shows open deeds in inbox with the todo order and hides the rest',async()=>{
  const api=authed(freshApp()),yesterday=shiftDate(today(),-1);
  await api.post('/api/captures').send({raw:'Просто заметка для доски'}).expect(201);
  const future=(await api.post('/api/captures').send({raw:'спланировать отпуск',primaryType:'todo',due:{date:shiftDate(today(),3)}}).expect(201)).body.entry;
  const overdue=(await api.post('/api/captures').send({raw:'позвонить в салон',primaryType:'todo',due:{date:yesterday}}).expect(201)).body.entry;
  const undated=(await api.post('/api/captures').send({raw:'Нужно проверить Hub'}).expect(201)).body.entry;
  const done=(await api.post('/api/captures').send({raw:'Нужно закрыть дело'}).expect(201)).body.entry;
  await api.post(`/api/projections/${done.projections.find(p=>p.type==='task').id}/complete`).send({}).expect(200);
  const board=(await api.get('/api/board').expect(200)).body;
  // одна колонка — «Входящие»; заметка и закрытая задача на доску не попадают
  assert.deepEqual(names(board),['Входящие']);
  assert.deepEqual(cardsOf(board,'Входящие'),[overdue,undated,future].map(e=>e.interpretation.classification.summary));
  const first=board.columns[0].cards[0];
  assert.equal(first.captureId,overdue.id);
  assert.ok(first.projectionIds.length>0);
  assert.equal(first.due.date,yesterday);
});

test('columns: create, rename, reorder, delete returns deeds to inbox',async()=>{
  const api=authed(freshApp());
  const work=(await api.post('/api/board/columns').send({name:'В работе'}).expect(201)).body;
  const wait=(await api.post('/api/board/columns').send({name:'Ждёт'}).expect(201)).body;
  await api.post('/api/board/columns').send({name:'   '}).expect(400);
  const task=(await api.post('/api/captures').send({raw:'Нужно проверить колонки'}).expect(201)).body.entry;
  await api.post('/api/board/move').send({captureId:task.id,columnId:work.id,index:0}).expect(200);
  let board=(await api.get('/api/board').expect(200)).body;
  assert.deepEqual(names(board),['Входящие','В работе','Ждёт']);
  assert.deepEqual(cardsOf(board,'В работе'),[task.interpretation.classification.summary]);
  // переименование и перестановка
  await api.patch(`/api/board/columns/${wait.id}`).send({name:'Ожидание'}).expect(200);
  await api.patch(`/api/board/columns/${wait.id}`).send({index:0}).expect(200);
  board=(await api.get('/api/board').expect(200)).body;
  assert.deepEqual(names(board),['Входящие','Ожидание','В работе']);
  // удаление колонки возвращает дела во «Входящие»
  const removed=(await api.delete(`/api/board/columns/${work.id}`).expect(200)).body;
  assert.equal(removed.movedToInbox,1);
  board=(await api.get('/api/board').expect(200)).body;
  assert.deepEqual(names(board),['Входящие','Ожидание']);
  assert.ok(cardsOf(board,'Входящие').includes(task.interpretation.classification.summary));
});

test('card moves persist order inside and between columns',async()=>{
  const api=authed(freshApp());
  const column=(await api.post('/api/board/columns').send({name:'В работе'}).expect(201)).body;
  const first=(await api.post('/api/captures').send({raw:'Нужно проверить первое'}).expect(201)).body.entry;
  const second=(await api.post('/api/captures').send({raw:'Нужно проверить второе'}).expect(201)).body.entry;
  const third=(await api.post('/api/captures').send({raw:'Нужно проверить третье'}).expect(201)).body.entry;
  await api.post('/api/board/move').send({captureId:first.id,columnId:column.id,index:0}).expect(200);
  await api.post('/api/board/move').send({captureId:second.id,columnId:column.id,index:0}).expect(200);
  await api.post('/api/board/move').send({captureId:third.id,columnId:column.id,index:1}).expect(200);
  let board=(await api.get('/api/board').expect(200)).body;
  const summaries={first:first.interpretation.classification.summary,second:second.interpretation.classification.summary,third:third.interpretation.classification.summary};
  assert.deepEqual(cardsOf(board,'В работе'),[summaries.second,summaries.third,summaries.first]);
  // перенос обратно во «Входящие» с ручным порядком
  await api.post('/api/board/move').send({captureId:third.id,columnId:null,index:0}).expect(200);
  board=(await api.get('/api/board').expect(200)).body;
  assert.deepEqual(cardsOf(board,'Входящие')[0],summaries.third);
  assert.deepEqual(cardsOf(board,'В работе'),[summaries.second,summaries.first]);
  // индекс за пределами — прижимается к концу, не ошибка
  await api.post('/api/board/move').send({captureId:third.id,columnId:column.id,index:99}).expect(200);
  board=(await api.get('/api/board').expect(200)).body;
  assert.deepEqual(cardsOf(board,'В работе'),[summaries.second,summaries.first,summaries.third]);
});

test('board validates input and stays private per user',async()=>{
  const app=freshApp(),api=authed(app);
  const column=(await api.post('/api/board/columns').send({name:'Личное'}).expect(201)).body;
  const task=(await api.post('/api/captures').send({raw:'Нужно проверить приватность'}).expect(201)).body.entry;
  await api.post('/api/board/move').send({captureId:task.id,columnId:column.id,index:0}).expect(200);
  await api.post('/api/board/move').send({captureId:task.id,columnId:column.id,index:-1}).expect(400);
  await api.post('/api/board/move').send({captureId:'not-a-uuid',columnId:null,index:0}).expect(400);
  const stranger=authed(app,{email:'stranger@kizuna.test',role:'user'});
  const foreign=(await stranger.get('/api/board').expect(200)).body;
  assert.deepEqual(names(foreign),['Входящие']);
  assert.equal(foreign.columns[0].cards.length,0);
  // чужие колонка и дело недоступны
  await stranger.post('/api/board/move').send({captureId:task.id,columnId:null,index:0}).expect(404);
  await stranger.patch(`/api/board/columns/${column.id}`).send({name:'Взлом'}).expect(404);
  await stranger.delete(`/api/board/columns/${column.id}`).expect(404);
});

test('closed deed leaves the board and returns to its place when reopened',async()=>{
  const api=authed(freshApp());
  const column=(await api.post('/api/board/columns').send({name:'В работе'}).expect(201)).body;
  const task=(await api.post('/api/captures').send({raw:'Нужно проверить возвращение'}).expect(201)).body.entry;
  await api.post('/api/board/move').send({captureId:task.id,columnId:column.id,index:0}).expect(200);
  const projection=task.projections.find(p=>p.type==='task');
  await api.post(`/api/projections/${projection.id}/complete`).send({}).expect(200);
  let board=(await api.get('/api/board').expect(200)).body;
  assert.equal(cardsOf(board,'В работе').length,0);
  await api.post(`/api/projections/${projection.id}/undo-complete`).send({}).expect(200);
  board=(await api.get('/api/board').expect(200)).body;
  assert.deepEqual(cardsOf(board,'В работе'),[task.interpretation.classification.summary]);
});

test('full reset clears the board too and is not blocked by placements',async()=>{
  const api=authed(freshApp());
  const column=(await api.post('/api/board/columns').send({name:'Сброс'}).expect(201)).body;
  const task=(await api.post('/api/captures').send({raw:'Нужно проверить сброс'}).expect(201)).body.entry;
  await api.post('/api/board/move').send({captureId:task.id,columnId:column.id,index:0}).expect(200);
  await api.post('/api/reset').send({confirmation:'СБРОСИТЬ КИЗУНА'}).expect(200);
  const board=(await api.get('/api/board').expect(200)).body;
  assert.deepEqual(names(board),['Входящие']);
  assert.equal(board.columns[0].cards.length,0);
});
