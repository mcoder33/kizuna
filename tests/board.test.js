import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import { createApp } from '../server/index.js';import { fakeModelService } from './helpers/fake-model.js';import { authed } from './helpers/auth.js';import { dateInZone, shiftDate } from '../server/reports.js';

function freshApp(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pagent-board-'));return createApp({aiService:fakeModelService(),databasePath:path.join(dir,'test.sqlite')})}
const today=()=>dateInZone(new Date(),'Europe/Samara');
const names=board=>board.columns.map(column=>column.name);
const cardsOf=(board,name)=>board.columns.find(column=>column.name===name).cards.map(card=>card.title);

test('board shows open todos in the first column «Дела» with the todo order and hides the closed',async()=>{
  const api=authed(freshApp()),yesterday=shiftDate(today(),-1);
  const note=(await api.post('/api/captures').send({raw:'Просто заметка для доски'}).expect(201)).body.entry;
  const future=(await api.post('/api/captures').send({raw:'спланировать отпуск',primaryType:'todo',due:{date:shiftDate(today(),3)}}).expect(201)).body.entry;
  const overdue=(await api.post('/api/captures').send({raw:'позвонить в салон',primaryType:'todo',due:{date:yesterday}}).expect(201)).body.entry;
  const undated=(await api.post('/api/captures').send({raw:'Нужно проверить Hub'}).expect(201)).body.entry;
  const done=(await api.post('/api/captures').send({raw:'Нужно закрыть дело'}).expect(201)).body.entry;
  await api.post(`/api/projections/${done.projections.find(p=>p.type==='task').id}/complete`).send({}).expect(200);
  const board=(await api.get('/api/board').expect(200)).body;
  // «Входящих» нет: у человека одна колонка «Дела», каждая запись — туду (на сегодня, если срок не назван), закрытая на доску не попадает
  assert.deepEqual(names(board),['Дела']);
  assert.ok(board.columns.every(column=>column.id!==null));
  assert.deepEqual(cardsOf(board,'Дела'),[overdue,note,undated,future].map(e=>e.interpretation.classification.summary));
  const first=board.columns[0].cards[0];
  assert.equal(first.captureId,overdue.id);
  assert.ok(first.projectionIds.length>0);
  assert.equal(first.due.date,yesterday);
});

test('columns: create, rename, reorder, delete returns deeds to the first column',async()=>{
  const api=authed(freshApp());
  const work=(await api.post('/api/board/columns').send({name:'В работе'}).expect(201)).body;
  const wait=(await api.post('/api/board/columns').send({name:'Ждёт'}).expect(201)).body;
  await api.post('/api/board/columns').send({name:'   '}).expect(400);
  const task=(await api.post('/api/captures').send({raw:'Нужно проверить колонки'}).expect(201)).body.entry;
  await api.post('/api/board/move').send({captureId:task.id,columnId:work.id,index:0}).expect(200);
  let board=(await api.get('/api/board').expect(200)).body;
  assert.deepEqual(names(board),['Дела','В работе','Ждёт']);
  assert.deepEqual(cardsOf(board,'В работе'),[task.interpretation.classification.summary]);
  // переименование и перестановка
  await api.patch(`/api/board/columns/${wait.id}`).send({name:'Ожидание'}).expect(200);
  await api.patch(`/api/board/columns/${wait.id}`).send({index:1}).expect(200);
  board=(await api.get('/api/board').expect(200)).body;
  assert.deepEqual(names(board),['Дела','Ожидание','В работе']);
  // удаление колонки возвращает дела в первую из оставшихся
  const removed=(await api.delete(`/api/board/columns/${work.id}`).expect(200)).body;
  assert.equal(removed.moved,1);
  board=(await api.get('/api/board').expect(200)).body;
  assert.deepEqual(names(board),['Дела','Ожидание']);
  assert.ok(cardsOf(board,'Дела').includes(task.interpretation.classification.summary));
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
  // перенос обратно в первую колонку с ручным порядком; без колонки перенести нельзя — «Входящих» нет
  const home=board.columns[0];
  assert.equal(home.name,'Дела');
  await api.post('/api/board/move').send({captureId:third.id,columnId:null,index:0}).expect(400);
  await api.post('/api/board/move').send({captureId:third.id,columnId:home.id,index:0}).expect(200);
  board=(await api.get('/api/board').expect(200)).body;
  assert.deepEqual(cardsOf(board,'Дела')[0],summaries.third);
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
  assert.deepEqual(names(foreign),['Дела']);
  assert.equal(foreign.columns[0].cards.length,0);
  // чужие колонка и дело недоступны
  await stranger.post('/api/board/move').send({captureId:task.id,columnId:foreign.columns[0].id,index:0}).expect(404);
  await stranger.post('/api/board/move').send({captureId:task.id,columnId:column.id,index:0}).expect(404);
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
  // Закрытое не пропадает: лежит хвостом с датой закрытия, чтобы вернуть в работу.
  assert.deepEqual(board.closed.map(card=>card.title),[task.interpretation.classification.summary]);
  assert.equal(board.closed[0].closedDate,today());
  assert.deepEqual(board.closed[0].projectionIds,[projection.id]);
  await api.post(`/api/projections/${projection.id}/undo-complete`).send({}).expect(200);
  board=(await api.get('/api/board').expect(200)).body;
  assert.deepEqual(cardsOf(board,'В работе'),[task.interpretation.classification.summary]);
  assert.deepEqual(board.closed,[]);
});

test('full reset clears the board too and is not blocked by placements',async()=>{
  const api=authed(freshApp());
  const column=(await api.post('/api/board/columns').send({name:'Сброс'}).expect(201)).body;
  const task=(await api.post('/api/captures').send({raw:'Нужно проверить сброс'}).expect(201)).body.entry;
  await api.post('/api/board/move').send({captureId:task.id,columnId:column.id,index:0}).expect(200);
  await api.post('/api/reset').send({confirmation:'СБРОСИТЬ КИЗУНА'}).expect(200);
  const board=(await api.get('/api/board').expect(200)).body;
  assert.deepEqual(names(board),['Дела']);
  assert.equal(board.columns[0].cards.length,0);
});

test('the last column can be deleted: «Дела» appears and takes the todos; the board never has an empty id',async()=>{
  const api=authed(freshApp());
  const first=(await api.get('/api/board').expect(200)).body.columns[0];
  const task=(await api.post('/api/captures').send({raw:'Нужно проверить удаление'}).expect(201)).body.entry;
  await api.post('/api/board/move').send({captureId:task.id,columnId:first.id,index:0}).expect(200);
  const removed=(await api.delete(`/api/board/columns/${first.id}`).expect(200)).body;
  assert.equal(removed.moved,1);
  const board=(await api.get('/api/board').expect(200)).body;
  assert.deepEqual(names(board),['Дела']);
  assert.notEqual(board.columns[0].id,first.id);
  assert.deepEqual(cardsOf(board,'Дела'),[task.interpretation.classification.summary]);
});

test('a todo closed at birth ("сделал X") sits in the closed tail, not in the columns',async()=>{
  const api=authed(freshApp());
  const created=(await api.post('/api/captures').send({raw:'Сделал отчёт по Hub'}).expect(201)).body.entry;
  const board=(await api.get('/api/board').expect(200)).body;
  assert.equal(board.columns[0].cards.length,0);
  assert.deepEqual(board.closed.map(card=>card.captureId),[created.id]);
  assert.equal(board.closed[0].closedDate,today());
});

test('board cards carry the number of live attachments',async()=>{
  const api=authed(freshApp());
  const task=(await api.post('/api/captures').send({raw:'Нужно проверить скрепку'}).expect(201)).body.entry;
  const before=(await api.get('/api/board').expect(200)).body.columns[0].cards.find(card=>card.captureId===task.id);
  assert.equal(before.attachments,0);
  const saved=(await api.post(`/api/captures/${task.id}/attachments`).set('Content-Type','text/plain').set('X-Attachment-Name',encodeURIComponent('план.txt')).send(Buffer.from('план')).expect(201)).body;
  await api.post(`/api/captures/${task.id}/attachments`).set('Content-Type','text/plain').set('X-Attachment-Name',encodeURIComponent('ещё.txt')).send(Buffer.from('ещё')).expect(201);
  assert.equal((await api.get('/api/board').expect(200)).body.columns[0].cards.find(card=>card.captureId===task.id).attachments,2);
  // убранное вложение не считается
  await api.delete(`/api/attachments/${saved.attachment.id}`).expect(200);
  assert.equal((await api.get('/api/board').expect(200)).body.columns[0].cards.find(card=>card.captureId===task.id).attachments,1);
});

test('column colour is stored, validated and returned with the board',async()=>{
  const api=authed(freshApp());
  const column=(await api.post('/api/board/columns').send({name:'В работе'}).expect(201)).body;
  assert.equal(column.color,null);
  const painted=(await api.patch(`/api/board/columns/${column.id}`).send({color:'purple'}).expect(200)).body;
  assert.equal(painted.color,'purple');
  await api.patch(`/api/board/columns/${column.id}`).send({color:'neon'}).expect(400);
  const board=(await api.get('/api/board').expect(200)).body;
  assert.equal(board.columns.find(item=>item.name==='В работе').color,'purple');
  // Снять цвет — null; серый по умолчанию рисует клиент.
  assert.equal((await api.patch(`/api/board/columns/${column.id}`).send({color:null}).expect(200)).body.color,null);
});

test('cards carry the people the model found in the note',async()=>{
  const api=authed(freshApp());
  await api.post('/api/captures').send({raw:'Обсудить с Настей задачу по рототору',primaryType:'todo'}).expect(201);
  const board=(await api.get('/api/board').expect(200)).body;
  const card=board.columns[0].cards[0];
  assert.ok(Array.isArray(card.people));
});

// Откуда пришло дело: доска раскладывает по источнику. Имя источника — на языке
// доски: пересланное из Telegram тоже «telegram», дело из заметки — «notes»,
// всё остальное (с главной, без задачи разбора) — «field».
test('cards carry where they came from: field, telegram (also forwarded), notes; a split child takes its parent’s origin',async()=>{
  const app=freshApp(),api=authed(app),db=app.database;
  const job=(captureId,origin)=>db.prepare("INSERT INTO capture_jobs(id,capture_id,selected_provider,state,stage,retryable,created_at,user_id,origin) VALUES(?,?,?,?,?,?,?,?,?)").run(crypto.randomUUID(),captureId,'fallback','succeeded','complete',0,new Date().toISOString(),api.user.id,origin);
  const create=async raw=>(await api.post('/api/captures').send({raw}).expect(201)).body.entry;
  const plain=await create('Нужно проверить поле');
  const chat=await create('Нужно проверить телеграм');
  const forwarded=await create('Нужно проверить пересланное');
  const fromNotes=await create('Нужно проверить заметки');
  const closed=await create('Сделал отчёт из телеграма');
  job(plain.id,null);job(chat.id,'telegram');job(forwarded.id,'telegram_forward');job(fromNotes.id,'notes');job(closed.id,'telegram');
  // Пачка из пересланных сообщений: родитель — контейнер, дела отделились от него без своей задачи.
  const batch=(await api.post('/api/captures').send({raw:['Пересланное от Ани','1. Отправить смету по Hub','2. Согласовать макет с командой'].join('\n')}).expect(201)).body;
  assert.equal(batch.parts.length,2);
  job(batch.entry.id,'telegram_forward');
  const board=(await api.get('/api/board').expect(200)).body;
  const originOf=title=>board.columns[0].cards.find(card=>card.title===title)?.origin;
  assert.equal(originOf('Нужно проверить поле'),'field');
  assert.equal(originOf('Нужно проверить телеграм'),'telegram');
  assert.equal(originOf('Нужно проверить пересланное'),'telegram');
  assert.equal(originOf('Нужно проверить заметки'),'notes');
  for(const part of batch.parts)assert.equal(board.columns[0].cards.find(card=>card.captureId===part.id).origin,'telegram');
  // Закрытая карточка помнит источник и колонку, в которую вернётся.
  assert.equal(board.closed.length,1);
  assert.equal(board.closed[0].origin,'telegram');
  assert.equal(board.closed[0].columnId,board.columns[0].id);
  // Карточка записи называет тот же источник, в том числе у отделённого дела.
  assert.equal((await api.get(`/api/captures/${batch.parts[0].id}`).expect(200)).body.entry.origin,'telegram_forward');
});

test('a closed card remembers its own column, not the first one',async()=>{
  const api=authed(freshApp());
  const later=(await api.post('/api/board/columns').send({name:'Позже'}).expect(201)).body;
  const task=(await api.post('/api/captures').send({raw:'Нужно проверить колонку закрытого'}).expect(201)).body.entry;
  await api.post('/api/board/move').send({captureId:task.id,columnId:later.id,index:0}).expect(200);
  await api.post(`/api/projections/${task.projections.find(p=>p.type==='task').id}/complete`).send({}).expect(200);
  const board=(await api.get('/api/board').expect(200)).body;
  assert.equal(board.closed[0].columnId,later.id);
});
