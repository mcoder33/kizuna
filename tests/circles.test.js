import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import { createApp } from '../server/index.js';import { fakeModelService } from './helpers/fake-model.js';import { authed } from './helpers/auth.js';

function freshApp(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pagent-circles-'));return createApp({aiService:fakeModelService(),databasePath:path.join(dir,'test.sqlite')})}
// Два человека в одном приложении: у каждого своя кука, свой журнал и свой день.
async function pair(){
  const app=freshApp();
  const sasha=authed(app,{email:'sasha@kizuna.test',role:'admin'});
  const anya=authed(app,{email:'anya@kizuna.test',role:'user'});
  await sasha.patch('/api/account').send({name:'Саша'}).expect(200);
  await anya.patch('/api/account').send({name:'Аня'}).expect(200);
  const circle=(await sasha.post('/api/circles').send({name:'Хаб'}).expect(201)).body.circle;
  const invite=(await sasha.post(`/api/circles/${circle.id}/invite`).send({}).expect(201)).body;
  await anya.post(`/api/circles/invite/${invite.token}/accept`).send({}).expect(200);
  return {app,sasha,anya,circle};
}
const ask=async(api,raw='Ане — прислать смету по Хабу')=>(await api.post('/api/captures').send({raw}).expect(201)).body.entry;

test('круг: заводится, зовёт по ссылке, показывает людей',async()=>{
  const {sasha,anya,circle}=await pair();
  const mine=(await sasha.get('/api/circles').expect(200)).body.circles;
  assert.deepEqual(mine.map(item=>item.name),['Хаб']);
  assert.deepEqual(mine[0].members.map(member=>member.name).sort(),['Аня','Саша']);
  assert.equal(mine[0].members.find(member=>member.name==='Саша').role,'owner');
  // Приглашённый видит круг у себя, но хозяином не становится.
  const hers=(await anya.get('/api/circles').expect(200)).body.circles;
  assert.equal(hers[0].id,circle.id);
  assert.equal(hers[0].role,'member');
  // Ссылка работает для многих: звать десятерых десятью ссылками неудобно.
  const link=(await sasha.post(`/api/circles/${circle.id}/invite`).send({}).expect(201)).body;
  await anya.post(`/api/circles/invite/${link.token}/accept`).send({}).expect(200);
  await anya.post(`/api/circles/invite/${link.token}/accept`).send({}).expect(200);
  // Обновили ссылку — прежняя перестала работать, и это единственный способ
  // её закрыть.
  await sasha.post(`/api/circles/${circle.id}/invite`).send({}).expect(201);
  await anya.post(`/api/circles/invite/${link.token}/accept`).send({}).expect(409);
  assert.equal((await sasha.get(`/api/circles/${circle.id}`).expect(200)).body.circle.invite.uses,0,'у новой ссылки свой счёт');
  // Последний хозяин не может уйти: круг не должен остаться без него.
  await sasha.post(`/api/circles/${circle.id}/leave`).send({}).expect(409);
  await anya.post(`/api/circles/${circle.id}/leave`).send({}).expect(200);
});

test('дело уходит фразой: у Ани просьба в «к вам», у Саши «ждёт ответа»',async()=>{
  const {sasha,anya}=await pair();
  const entry=await ask(sasha);
  // У автора — честное «ждёт ответа», а не выдуманное «в работе».
  const waiting=(await sasha.get('/api/inbox').expect(200)).body.waiting;
  assert.equal(waiting.length,1);
  assert.equal(waiting[0].state,'pending');
  assert.equal(waiting[0].assignee.name,'Аня');
  assert.equal(waiting[0].circle.name,'Хаб');
  // У Ани — строка в полосе «к вам», и ни одной чужой записи в своём журнале.
  const day=(await anya.get('/api/day').expect(200)).body;
  assert.equal(day.inbox.length,1);
  assert.equal(day.inbox[0].kind,'request');
  assert.equal(day.inbox[0].from.name,'Саша');
  assert.equal(day.inbox[0].captureId,entry.id);
  assert.equal(day.borrowed.length,0,'до ответа дело в чужом дне не лежит');
  const entries=(await anya.get('/api/entries?limit=100').expect(200)).body.entries;
  assert.equal(entries.length,0,'чужая запись не попадает в журнал');
});

test('«беру» опускает дело в день, чекбокс закрывает просьбу',async()=>{
  const {app,sasha,anya}=await pair();
  const entry=await ask(sasha);
  const assignmentId=(await anya.get('/api/inbox').expect(200)).body.rows[0].id;
  await anya.post(`/api/assignments/${assignmentId}/respond`).send({take:true}).expect(200);
  const day=(await anya.get('/api/day').expect(200)).body;
  assert.equal(day.inbox.length,0,'просьба уходит из полосы, когда её взяли');
  assert.deepEqual(day.borrowed.map(item=>item.id),[entry.id]);
  assert.equal(day.borrowed[0].circle.name,'Хаб');
  // Взятое дело стоит и на доске — рядом со своими.
  const board=(await anya.get('/api/board').expect(200)).body;
  assert.ok(board.columns[0].cards.some(card=>card.captureId===entry.id));
  assert.equal((await sasha.get('/api/inbox').expect(200)).body.waiting[0].state,'accepted');
  // Закрыть чужое дело может тот, кто его взял, — и только он.
  const projectionId=day.borrowed[0].projections.find(projection=>projection.type==='task').id;
  const outsider=authed(app,{email:'lesha@kizuna.test',role:'user'});
  await outsider.post(`/api/projections/${projectionId}/complete`).send({}).expect(404);
  await anya.post(`/api/projections/${projectionId}/complete`).send({}).expect(200);
  assert.equal((await sasha.get('/api/inbox').expect(200)).body.waiting[0].state,'done');
  // И возврат в работу возвращает просьбу в «взял».
  await anya.post(`/api/projections/${projectionId}/undo-complete`).send({}).expect(200);
  assert.equal((await sasha.get('/api/inbox').expect(200)).body.waiting[0].state,'accepted');
});

test('«не я» возвращает дело автору вместе с причиной',async()=>{
  const {sasha,anya}=await pair();
  await ask(sasha);
  const assignmentId=(await anya.get('/api/inbox').expect(200)).body.rows[0].id;
  await anya.post(`/api/assignments/${assignmentId}/respond`).send({take:false,reason:'это к Кате'}).expect(200);
  await anya.post(`/api/assignments/${assignmentId}/respond`).send({take:true}).expect(409);
  const waiting=(await sasha.get('/api/inbox').expect(200)).body.waiting[0];
  assert.equal(waiting.state,'declined');
  assert.equal(waiting.reason,'это к Кате');
  assert.equal((await anya.get('/api/day').expect(200)).body.inbox.length,0);
});

test('граница круга: участник видит карточку, посторонний — нет, правит автор',async()=>{
  const {app,sasha,anya}=await pair();
  const entry=await ask(sasha);
  const lesha=authed(app,{email:'lesha@kizuna.test',role:'user'});
  await anya.get(`/api/captures/${entry.id}`).expect(200);
  await lesha.get(`/api/captures/${entry.id}`).expect(404);
  // Личная запись в круг не уходит: туда попадает только отданное.
  const personal=(await sasha.post('/api/captures').send({raw:'Оплатить хостинг до пятницы'}).expect(201)).body.entry;
  await anya.get(`/api/captures/${personal.id}`).expect(404);
  // Правит запись только автор: исполнитель просит словами.
  await anya.post(`/api/captures/${entry.id}/corrections`).send({patch:{primaryType:'note'}}).expect(404);
  // Снятый исполнитель уносит запись из круга.
  await sasha.post(`/api/captures/${entry.id}/assign`).send({assigneeId:null}).expect(200);
  await anya.get(`/api/captures/${entry.id}`).expect(404);
});

test('обсуждение: призыв кладёт строку в ту же полосу, открытая карточка её гасит',async()=>{
  const {sasha,anya}=await pair();
  const entry=await ask(sasha);
  await anya.post(`/api/captures/${entry.id}/comments`).send({body:'Половина готова. @Саша, цены от подрядчика были?'}).expect(201);
  // Обычное сообщение не дёргает никого — строку порождает только призыв.
  await anya.post(`/api/captures/${entry.id}/comments`).send({body:'Напишу подрядчику ещё раз'}).expect(201);
  const inbox=(await sasha.get('/api/inbox').expect(200)).body.rows;
  assert.deepEqual(inbox.map(row=>row.kind),['call']);
  assert.equal(inbox[0].from.name,'Аня');
  assert.equal(inbox[0].captureId,entry.id);
  // Открыл карточку — значит прочитал.
  const card=(await sasha.get(`/api/captures/${entry.id}`).expect(200)).body.entry;
  assert.equal(card.comments.length,2);
  assert.deepEqual(card.callable.map(person=>person.name),['Аня']);
  assert.equal((await sasha.get('/api/inbox').expect(200)).body.rows.length,0);
  // Призвать того, кого нет в круге, нечем: такого имени просто не найдут.
  await sasha.post(`/api/captures/${entry.id}/comments`).send({body:'@Дима посмотри'}).expect(201);
  assert.equal((await sasha.get(`/api/captures/${entry.id}`).expect(200)).body.entry.comments.at(-1).mentions.length,0);
});

test('выключенный круг уходит из списков, но просьбы сворачиваются, а не пропадают',async()=>{
  const {sasha,anya,circle}=await pair();
  const entry=await ask(sasha);
  const assignmentId=(await anya.get('/api/inbox').expect(200)).body.rows[0].id;
  await anya.post(`/api/assignments/${assignmentId}/respond`).send({take:true}).expect(200);
  await sasha.post('/api/captures').send({raw:'Ане — проверить режимы в Хабе'}).expect(201);
  await anya.post(`/api/circles/${circle.id}/mute`).send({muted:true}).expect(200);
  const day=(await anya.get('/api/day').expect(200)).body;
  assert.equal(day.inbox.length,0,'поштучно просьбы выключенного круга не показываются');
  assert.equal(day.inboxFolded.length,1,'но одной свёрнутой строкой — да');
  assert.equal(day.inboxFolded[0].count,1);
  assert.equal(day.inboxFolded[0].circle.name,'Хаб');
  assert.deepEqual(day.mutedCircles.map(item=>[item.name,item.deeds]),[['Хаб',2]]);
  assert.equal(day.circles.find(item=>item.id===circle.id).muted,true);
  // Выключение личное: у автора ничего не изменилось и он о нём не знает.
  const waiting=(await sasha.get('/api/inbox').expect(200)).body.waiting;
  assert.equal(waiting.length,2);
  assert.ok(!JSON.stringify(waiting).includes('muted'));
  await anya.post(`/api/circles/${circle.id}/mute`).send({muted:false}).expect(200);
  assert.equal((await anya.get('/api/day').expect(200)).body.borrowed.length,1);
  assert.equal(entry.id,(await anya.get('/api/day').expect(200)).body.borrowed[0].id);
});

test('исполнителя ставят руками, когда разбор не назвал никого',async()=>{
  const {app,sasha,anya}=await pair();
  const entry=(await sasha.post('/api/captures').send({raw:'Нужно собрать цифры по марту'}).expect(201)).body.entry;
  assert.equal((await sasha.get('/api/inbox').expect(200)).body.waiting.length,0);
  const lesha=authed(app,{email:'lesha@kizuna.test',role:'user'});
  // Человека не из круга исполнителем не назначить.
  await sasha.post(`/api/captures/${entry.id}/assign`).send({assigneeId:lesha.user.id}).expect(409);
  await sasha.post(`/api/captures/${entry.id}/assign`).send({assigneeId:sasha.user.id}).expect(400);
  const assigned=(await sasha.post(`/api/captures/${entry.id}/assign`).send({assigneeId:anya.user.id}).expect(200)).body;
  assert.equal(assigned.assignment.assignee.name,'Аня');
  assert.equal((await anya.get('/api/day').expect(200)).body.inbox.length,1);
});

test('очистка данных уносит разговор и просьбы со своих записей, а круг оставляет',async()=>{
  const {sasha,anya,circle}=await pair();
  const entry=await ask(sasha);
  await anya.post(`/api/captures/${entry.id}/comments`).send({body:'Беру в работу, @Саша'}).expect(201);
  const exported=(await sasha.get('/api/export').expect(200)).body;
  assert.equal(exported.schemaVersion,3);
  assert.equal(exported.assignments.length,1,'просьба со своей записи выгружается');
  assert.equal(exported.comments.length,1,'и разговор вокруг неё тоже');
  assert.equal(exported.captureCircles[0].circle_id,circle.id);
  // Очистка журнала не спотыкается о просьбы и сообщения — и не уносит круг:
  // это отношения с людьми, а не журнал.
  await sasha.post('/api/reset').send({confirmation:'СБРОСИТЬ КИЗУНА'}).expect(200);
  assert.equal((await sasha.get('/api/entries?limit=100').expect(200)).body.entries.length,0);
  assert.equal((await sasha.get('/api/inbox').expect(200)).body.waiting.length,0);
  assert.deepEqual((await sasha.get('/api/circles').expect(200)).body.circles.map(item=>item.name),['Хаб']);
  assert.equal((await anya.get('/api/day').expect(200)).body.inbox.length,0,'просьба ушла вместе с записью');
});

test('человека из приложения зовут поиском, а не ссылкой, и он узнаёт об этом строкой «к вам»',async()=>{
  const {app,sasha,anya,circle}=await pair();
  const katya=authed(app,{email:'katya@kizuna.test',role:'user'});
  await katya.patch('/api/account').send({name:'Катя'}).expect(200);
  // Ищем среди людей приложения: те, кто уже в круге, в подсказке не нужны.
  const found=(await sasha.get(`/api/circles/${circle.id}/candidates?q=кат`).expect(200)).body.people;
  assert.deepEqual(found.map(person=>person.name),['Катя']);
  assert.equal((await sasha.get(`/api/circles/${circle.id}/candidates?q=ан`).expect(200)).body.people.length,0,'кто в круге, того не предлагают');
  // Пустое поле показывает всех, кого можно позвать: вспоминать почту соседа
  // наизусть незачем. Текст только сужает список.
  assert.deepEqual((await sasha.get(`/api/circles/${circle.id}/candidates`).expect(200)).body.people.map(person=>person.name),['Катя']);
  assert.deepEqual((await sasha.get(`/api/circles/${circle.id}/candidates?q=к`).expect(200)).body.people.map(person=>person.name),['Катя']);
  // Добавили — и человек в круге сразу, без ссылки и без ожидания.
  const added=(await sasha.post(`/api/circles/${circle.id}/members`).send({userId:katya.user.id}).expect(200)).body;
  assert.deepEqual(added.circle.members.map(member=>member.name).sort(),['Аня','Катя','Саша']);
  await sasha.post(`/api/circles/${circle.id}/members`).send({userId:katya.user.id}).expect(409);
  await sasha.post(`/api/circles/${circle.id}/members`).send({userId:'нет-такого'}).expect(404);
  // Молча в чужой список круг не кладётся: пока не открыл — строка «к вам».
  const day=(await katya.get('/api/day').expect(200)).body;
  assert.equal(day.inbox.length,1);
  assert.equal(day.inbox[0].kind,'circle');
  assert.equal(day.inbox[0].from.name,'Саша');
  assert.equal(day.inbox[0].circle.name,'Хаб');
  await katya.post(`/api/circles/${circle.id}/seen`).send({}).expect(200);
  assert.equal((await katya.get('/api/day').expect(200)).body.inbox.length,0);
  // И выйти можно в одно нажатие.
  await katya.post(`/api/circles/${circle.id}/leave`).send({}).expect(200);
  assert.deepEqual((await katya.get('/api/circles').expect(200)).body.circles,[]);
});

test('у человека в круге видно до трёх его открытых дел этого круга',async()=>{
  const {sasha,anya,circle}=await pair();
  await ask(sasha,'Ане — прислать смету по Хабу');
  const people=(await sasha.get(`/api/circles/${circle.id}`).expect(200)).body.circle.members;
  const hers=people.find(member=>member.name==='Аня');
  assert.equal(hers.deeds.length,1);
  assert.equal(hers.deeds[0].state,'pending');
  assert.ok(hers.deeds[0].title);
  assert.deepEqual(people.find(member=>member.name==='Саша').deeds,[]);
  assert.ok(anya);
});

// Фото круга — как фото группы в Телеграме: ставит и убирает хозяин, видят все
// в круге, а чужому картинка не отдаётся, даже если он знает адрес.
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAMAASsJTYQAAAAASUVORK5CYII=','base64');
const bytesOf=response=>new Promise(resolve=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve(Buffer.concat(chunks)));});
test('фото круга: ставит хозяин, видят все в круге, чужому не отдаётся',async()=>{
  const {app,sasha,anya,circle}=await pair();
  const upload=(api,bytes,type='image/png')=>api.post(`/api/circles/${circle.id}/photo`).set('Content-Type',type).send(bytes);
  assert.equal(circle.photo,null,'по умолчанию на знаке буква');
  // Формат решают байты, а не подпись запроса; ставит только хозяин.
  await upload(sasha,Buffer.from('<svg onload="alert(1)"></svg>')).expect(415);
  await upload(sasha,Buffer.alloc(0)).expect(400);
  await upload(anya,PNG).expect(403);
  const photo=(await upload(sasha,PNG,'image/webp').expect(200)).body.circle.photo;
  assert.match(photo,new RegExp(`^/api/circles/${circle.id}/photo\\?v=`));
  // Адрес приходит всем в круге вместе с кругом, картинка кешируется по версии.
  assert.equal((await anya.get('/api/circles').expect(200)).body.circles[0].photo,photo);
  const served=await anya.get(photo).buffer(true).parse((response,done)=>bytesOf(response).then(body=>done(null,body))).expect(200);
  assert.equal(served.headers['content-type'],'image/png');
  assert.match(served.headers['cache-control'],/immutable/);
  assert.deepEqual(served.body,PNG);
  const stranger=authed(app,{email:'lesha@kizuna.test',role:'user'});
  await stranger.get(photo).expect(404);
  // Хозяин убирает фото — на знаке снова буква, байты не хранятся.
  await anya.delete(`/api/circles/${circle.id}/photo`).expect(403);
  assert.equal((await sasha.delete(`/api/circles/${circle.id}/photo`).expect(200)).body.circle.photo,null);
  await anya.get(photo).expect(404);
  assert.equal(app.database.prepare('SELECT COUNT(*) AS n FROM circle_photos').get().n,0);
  // Распущенный круг забирает фото с собой.
  await upload(sasha,PNG).expect(200);
  await sasha.delete(`/api/circles/${circle.id}`).expect(200);
  assert.equal(app.database.prepare('SELECT COUNT(*) AS n FROM circle_photos').get().n,0);
});

// «@» в самой записи — призыв: человек из круга видит запись и узнаёт о ней.
// Дело, которое ему же и досталось, второй раз не звонит.
test('призыв «@» в записи открывает её человеку и кладёт строку за колокольчиком',async()=>{
  const {sasha,anya}=await pair();
  const people=(await sasha.get('/api/people').expect(200)).body.people;
  assert.deepEqual(people.map(person=>[person.name,person.circles]),[['Аня',['Хаб']]]);
  assert.deepEqual((await anya.get('/api/people').expect(200)).body.people.map(person=>person.name),['Саша'],'у каждого свои люди');

  const note=(await sasha.post('/api/captures').send({raw:'Смета по Хабу готова, @Аня — глянь',primaryType:'note'}).expect(201)).body.entry;
  // Позванная видит запись целиком и стоит в её участниках.
  assert.equal((await anya.get(`/api/captures/${note.id}`).expect(200)).body.entry.interpretation.classification.summary.length>0,true);
  assert.ok((await sasha.get(`/api/captures/${note.id}`).expect(200)).body.entry.participants.some(person=>person.name==='Аня'));
  const called=(await anya.get('/api/notifications').expect(200)).body.notifications.filter(item=>item.kind==='call');
  assert.equal(called.length,1);
  assert.match(called[0].text,/зовёт вас в записи/);

  // Постороннего «@» не находит: звать можно только своих по кругам.
  const petya=authed((await pair()).app,{email:'petya@kizuna.test',role:'user'});
  const alone=(await sasha.post('/api/captures').send({raw:'@Петя, ты кто',primaryType:'note'}).expect(201)).body.entry;
  assert.equal((await sasha.get(`/api/captures/${alone.id}`).expect(200)).body.entry.participants.length,0);
  await petya.get(`/api/captures/${alone.id}`).expect(404);

  // Дело, которое досталось Ане, зовёт её просьбой — и не дублирует призывом.
  await sasha.post('/api/captures').send({raw:'@Аня — прислать смету по Хабу',primaryType:'todo'}).expect(201);
  const hers=(await anya.get('/api/notifications').expect(200)).body.notifications;
  assert.equal(hers.filter(item=>item.kind==='call').length,1,'нового призыва нет');
  assert.equal(hers.filter(item=>item.kind==='request').length,1,'просьба пришла одна');
});
