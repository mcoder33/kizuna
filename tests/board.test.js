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

// Подзадача не стоит на доске отдельной карточкой: у родителя она считается в «0/2».
const step=async(api,parentId,title)=>(await api.post(`/api/captures/${parentId}/subtasks`).send({title}).expect(201)).body.entry;
const closeDeed=async(api,entry)=>{for(const projection of entry.projections.filter(item=>item.type==='task'))await api.post(`/api/projections/${projection.id}/complete`).send({}).expect(200);};
const reopenDeed=async(api,entry)=>{for(const projection of entry.projections.filter(item=>item.type==='task'))await api.post(`/api/projections/${projection.id}/undo-complete`).send({}).expect(200);};
// Счёт «сделано/всего» без строк карты подзадач (items): они проверяются отдельно.
const counts=card=>({done:card.subtasks.done,total:card.subtasks.total});

test('subtasks are not cards: the parent carries {done,total}, the counters count parents only',async()=>{
  const api=authed(freshApp());
  const coffee=(await api.post('/api/captures').send({raw:'Купить кофе для Hub'}).expect(201)).body.entry;
  const alone=(await api.post('/api/captures').send({raw:'Нужно проверить колонки'}).expect(201)).body.entry;
  const stock=await step(api,coffee.id,'Проверить запас в шкафу');
  const jar=await step(api,coffee.id,'Взять с собой банку');
  let board=(await api.get('/api/board').expect(200)).body;
  // На доске две карточки — сами дела; подзадач среди них нет ни открытых, ни закрытых.
  assert.deepEqual(board.columns[0].cards.map(card=>card.captureId).sort(),[coffee.id,alone.id].sort());
  assert.equal(board.columns[0].cards.length,2);
  assert.deepEqual(counts(board.columns[0].cards.find(card=>card.captureId===coffee.id)),{done:0,total:2});
  assert.equal('subtasks' in board.columns[0].cards.find(card=>card.captureId===alone.id),false,'у дела без подзадач поля нет');
  // Закрытая подзадача не переезжает в «Сделано» отдельной карточкой, а прибавляет к «1/2».
  await closeDeed(api,jar);
  board=(await api.get('/api/board').expect(200)).body;
  assert.equal(board.closed.length,0);
  assert.equal(board.columns[0].cards.length,2);
  assert.deepEqual(counts(board.columns[0].cards.find(card=>card.captureId===coffee.id)),{done:1,total:2});
  // Все сделаны — «2/2»; родитель при этом сам не закрылся.
  await closeDeed(api,stock);
  board=(await api.get('/api/board').expect(200)).body;
  assert.deepEqual(counts(board.columns[0].cards.find(card=>card.captureId===coffee.id)),{done:2,total:2});
  // Родитель закрыт — он лежит в «Сделано» со своим счётом, подзадач рядом нет.
  await closeDeed(api,coffee);
  board=(await api.get('/api/board').expect(200)).body;
  assert.deepEqual(board.closed.map(card=>card.captureId),[coffee.id]);
  assert.deepEqual(counts(board.closed[0]),{done:2,total:2});
  // Вернули шаг в работу — счёт откатился.
  await reopenDeed(api,stock);
  board=(await api.get('/api/board').expect(200)).body;
  assert.deepEqual(counts(board.closed[0]),{done:1,total:2});
});

test('the subtask count is the same as the arc in the card: leaves on every level, branches are not units',async()=>{
  const api=authed(freshApp());
  const coffee=(await api.post('/api/captures').send({raw:'Купить кофе'}).expect(201)).body.entry;
  const stock=await step(api,coffee.id,'Проверить запас');
  const shelf=await step(api,stock.id,'Посмотреть на полке');
  await step(api,stock.id,'Посмотреть в шкафу');
  await step(api,coffee.id,'Взять банку');
  await closeDeed(api,shelf);
  const board=(await api.get('/api/board').expect(200)).body;
  const card=board.columns[0].cards.find(item=>item.captureId===coffee.id);
  const tree=(await api.get(`/api/captures/${coffee.id}/subtasks`).expect(200)).body;
  assert.deepEqual(counts(card),{done:1,total:3});
  assert.deepEqual(counts(card),{done:tree.done,total:tree.total},'доска и карточка считают одинаково');
  assert.equal(board.columns[0].cards.length,1,'ни одна из четырёх подзадач не стала карточкой');
  // У подзадачи-ветки своей карточки нет — счёт виден только у корня.
  assert.equal(board.columns[0].cards.some(item=>item.captureId===stock.id),false);
});

test('a deed split off a batch is an ordinary card and never a subtask',async()=>{
  const api=authed(freshApp());
  // Пачка: родитель — контейнер без туду, дела отделились от него самостоятельными.
  const batch=(await api.post('/api/captures').send({raw:['Созванивались по ВойсОпс','','Что решили, 2 вектора','1. Допинываем бот детектор','2. Допинываем карусель с генератором фраз'].join('\n')}).expect(201)).body;
  assert.equal(batch.parts.length,2);
  // «Сделал X, надо Y»: родитель — закрытое дело, а отделённые дела всё равно остаются в «Дне» и на доске.
  const report=(await api.post('/api/captures').send({raw:['Сделал ревью по Хабу','1. Отправить Ане замечания по ревью','2. Согласовать сроки с командой'].join('\n')}).expect(201)).body;
  assert.equal(report.parts.length,2);
  const board=(await api.get('/api/board').expect(200)).body;
  for(const part of [...batch.parts,...report.parts]){
    const card=board.columns[0].cards.find(item=>item.captureId===part.id);
    assert.ok(card,'отделённое дело стоит на доске обычной карточкой');
    assert.equal('subtasks' in card,false);
  }
  // Закрытый отчёт — родитель этих дел — без счётчика: отделённые дела не подзадачи.
  const closedReport=board.closed.find(card=>card.captureId===report.entry.id);
  assert.ok(closedReport,'отчёт лежит в «Сделано»');
  assert.equal('subtasks' in closedReport,false);
  assert.equal(board.columns[0].cards.some(card=>card.captureId===batch.entry.id),false,'контейнер на доске не стоит');
  // Признак подзадачи стоит только у записей, заведённых в карточке.
  const split=(await api.get(`/api/captures/${batch.parts[0].id}`).expect(200)).body.entry;
  assert.equal(split.subtask,undefined);
  const made=await step(api,batch.parts[0].id,'Прогнать тесты');
  assert.equal(made.subtask,true);
  assert.equal(made.parentId,batch.parts[0].id);
  const again=(await api.get('/api/board').expect(200)).body;
  assert.deepEqual(counts(again.columns[0].cards.find(card=>card.captureId===batch.parts[0].id)),{done:0,total:1});
  assert.equal(again.columns[0].cards.some(card=>card.captureId===made.id),false);
  assert.equal(again.columns[0].cards.filter(card=>[...batch.parts,...report.parts].some(part=>part.id===card.captureId)).length,4,'соседи-отделённые дела на месте');
});

test('a deleted parent takes its subtasks away from the board, a restored one brings them back in its counter',async()=>{
  const api=authed(freshApp());
  const coffee=(await api.post('/api/captures').send({raw:'Купить кофе'}).expect(201)).body.entry;
  const jar=await step(api,coffee.id,'Взять банку');
  await api.delete(`/api/captures/${coffee.id}`).expect(200);
  let board=(await api.get('/api/board').expect(200)).body;
  assert.equal(board.columns[0].cards.length,0,'ни родителя, ни его подзадачи');
  assert.equal(board.closed.length,0);
  await api.post(`/api/captures/${coffee.id}/restore`).expect(200);
  board=(await api.get('/api/board').expect(200)).body;
  assert.deepEqual(board.columns[0].cards.map(card=>card.captureId),[coffee.id]);
  assert.deepEqual(counts(board.columns[0].cards[0]),{done:0,total:1});
  // Подзадача, удалённая сама, выпадает из счёта.
  await api.delete(`/api/captures/${jar.id}`).expect(200);
  board=(await api.get('/api/board').expect(200)).body;
  assert.equal('subtasks' in board.columns[0].cards[0],false);
});

test('a card cannot be dragged if it is a subtask: the board does not know it',async()=>{
  const api=authed(freshApp());
  const coffee=(await api.post('/api/captures').send({raw:'Купить кофе'}).expect(201)).body.entry;
  const jar=await step(api,coffee.id,'Взять банку');
  const column=(await api.post('/api/board/columns').send({name:'В работе'}).expect(201)).body;
  await api.post('/api/board/move').send({captureId:jar.id,columnId:column.id,index:0}).expect(404);
});

// Карта подзадач на карточке: рядом с числом доска получает первые строки — прямых детей родителя в том порядке, в каком их показывает «Список» в карточке.
test('the parent carries the rows of the subtask map: at most six direct subtasks, in the card list order, each with its own state',async()=>{
  const api=authed(freshApp());
  const trip=(await api.post('/api/captures').send({raw:'Организовать выезд команды'}).expect(201)).body.entry;
  const titles=['Выбрать даты','Забронировать дом','Заказать трансфер','Собрать продукты','Раздать роли','Купить страховку','Подготовить плейлист','Проверить погоду'];
  const steps=[];
  for(const title of titles)steps.push(await step(api,trip.id,title));
  // Закрыты вторая и седьмая: седьмая за пределом шести строк, но в число идёт.
  await closeDeed(api,steps[1]);
  await closeDeed(api,steps[6]);
  let board=(await api.get('/api/board').expect(200)).body;
  const card=board.columns[0].cards.find(item=>item.captureId===trip.id);
  assert.equal(board.columns[0].cards.length,1,'подзадачи остались строками карты, а не карточками');
  assert.equal(card.subtasks.total,8);
  assert.equal(card.subtasks.done,2);
  // Не больше шести: пять рисует доска, шестая говорит, что есть ещё.
  assert.equal(card.subtasks.items.length,6);
  const tree=(await api.get(`/api/captures/${trip.id}/subtasks`).expect(200)).body;
  assert.deepEqual(card.subtasks.items.map(item=>item.id),tree.children.slice(0,6),'порядок тот же, что у списка в карточке');
  assert.deepEqual(card.subtasks.items.map(item=>item.id),steps.slice(0,6).map(item=>item.id),'а он — порядок заведения');
  assert.deepEqual(card.subtasks.items.map(item=>item.title),titles.slice(0,6));
  assert.deepEqual(card.subtasks.items.map(item=>item.done),[false,true,false,false,false,false]);
  // Обычная строка — только id, название и состояние: лишних ключей нет.
  assert.deepEqual(card.subtasks.items[0],{id:steps[0].id,title:'Выбрать даты',done:false});
  // Короткий список отдаётся весь, без «ещё».
  await api.delete(`/api/captures/${steps[7].id}`).expect(200);
  for(const gone of steps.slice(3,7))await api.delete(`/api/captures/${gone.id}`).expect(200);
  board=(await api.get('/api/board').expect(200)).body;
  const short=board.columns[0].cards.find(item=>item.captureId===trip.id).subtasks;
  assert.equal(short.total,3);
  assert.deepEqual(short.items.map(item=>item.title),['Выбрать даты','Забронировать дом','Заказать трансфер']);
  assert.deepEqual(short.items.map(item=>item.done),[false,true,false]);
});

test('a row of the map reports its own state, a branch carries its leaf count, and the number stays the leaf count of the whole tree',async()=>{
  const api=authed(freshApp());
  const coffee=(await api.post('/api/captures').send({raw:'Купить кофе'}).expect(201)).body.entry;
  const stock=await step(api,coffee.id,'Проверить запас');
  const shelf=await step(api,stock.id,'Посмотреть на полке');
  await step(api,stock.id,'Посмотреть в шкафу');
  const jar=await step(api,coffee.id,'Взять банку');
  await closeDeed(api,shelf);
  const rowsOf=async()=>(await api.get('/api/board').expect(200)).body.columns[0].cards.find(item=>item.captureId===coffee.id).subtasks;
  let subtasks=await rowsOf();
  assert.deepEqual({done:subtasks.done,total:subtasks.total},{done:1,total:3});
  // В строках — прямые дети: у ветки свой счёт листьев, у листа его нет; внуки отдельными строками не идут.
  assert.deepEqual(subtasks.items,[
    {id:stock.id,title:'Проверить запас',done:false,nested:{done:1,total:2}},
    {id:jar.id,title:'Взять банку',done:false},
  ]);
  // Кружок ветки — её собственное дело: строка закрывается, а число листьев не двигается.
  await closeDeed(api,stock);
  subtasks=await rowsOf();
  assert.deepEqual({done:subtasks.done,total:subtasks.total},{done:1,total:3});
  assert.equal(subtasks.items[0].done,true);
  assert.deepEqual(subtasks.items[0].nested,{done:1,total:2});
  // Закрыли лист — число растёт, строка листа закрыта.
  await closeDeed(api,jar);
  subtasks=await rowsOf();
  assert.deepEqual({done:subtasks.done,total:subtasks.total},{done:2,total:3});
  assert.equal(subtasks.items[1].done,true);
});

test('the rows of the map come with a closed parent too, and a repeating subtask names the day its circle closes',async()=>{
  const api=authed(freshApp());
  const coffee=(await api.post('/api/captures').send({raw:'Купить кофе'}).expect(201)).body.entry;
  const weekly=await step(api,coffee.id,'Полить цветы');
  const once=await step(api,coffee.id,'Взять банку');
  await api.post(`/api/captures/${weekly.id}/corrections`).send({at:Date.now(),patch:{schedule:{date:today(),time:null,repeat:{freq:'daily',interval:1}}}}).expect(200);
  let card=(await api.get('/api/board').expect(200)).body.columns[0].cards.find(item=>item.captureId===coffee.id);
  const repeating=card.subtasks.items.find(item=>item.id===weekly.id);
  assert.equal(repeating.occurrence,today(),'кружок повтора закрывает сегодняшний день, а не серию');
  assert.equal(repeating.done,false);
  assert.equal('occurrence' in card.subtasks.items.find(item=>item.id===once.id),false,'у обычной строки дня нет');
  await closeDeed(api,once);
  await closeDeed(api,coffee);
  const board=(await api.get('/api/board').expect(200)).body;
  assert.deepEqual(board.closed.map(item=>item.captureId),[coffee.id]);
  assert.deepEqual(board.closed[0].subtasks.items.map(item=>item.id),[weekly.id,once.id]);
});

test('a row of the map that the taker of the parent cannot complete says so with canComplete:false, and the author never gets the key',async()=>{
  const app=freshApp();
  const sasha=authed(app,{email:'sasha@kizuna.test',role:'admin'}),anya=authed(app,{email:'anya@kizuna.test',role:'user'});
  await sasha.patch('/api/account').send({name:'Саша'}).expect(200);
  await anya.patch('/api/account').send({name:'Аня'}).expect(200);
  const circle=(await sasha.post('/api/circles').send({name:'Хаб'}).expect(201)).body.circle;
  const invite=(await sasha.post(`/api/circles/${circle.id}/invite`).send({}).expect(201)).body;
  await anya.post(`/api/circles/invite/${invite.token}/accept`).send({}).expect(200);
  // Саша отдаёт Ане дело и шаг под ним; Аня берёт дело, а шаг нет — у неё он виден, но отметить его она не может.
  const parent=(await sasha.post('/api/captures').send({raw:'Ане — прислать смету по Хабу'}).expect(201)).body.entry;
  const piece=await step(sasha,parent.id,'Собрать цифры');
  await sasha.post(`/api/captures/${piece.id}/assign`).send({assigneeId:anya.user.id,circleId:circle.id}).expect(200);
  const take=async captureId=>{const row=(await anya.get('/api/inbox').expect(200)).body.rows.find(item=>item.captureId===captureId);await anya.post(`/api/assignments/${row.id}/respond`).send({take:true}).expect(200);};
  await take(parent.id);
  const rows=async api=>(await api.get('/api/board').expect(200)).body.columns.flatMap(column=>column.cards).find(card=>card.captureId===parent.id).subtasks.items;
  assert.deepEqual(await rows(anya),[{id:piece.id,title:'Собрать цифры',done:false,canComplete:false}]);
  assert.deepEqual(await rows(sasha),[{id:piece.id,title:'Собрать цифры',done:false}],'у автора ключа нет');
});
