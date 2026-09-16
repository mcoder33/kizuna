import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import { createApp } from '../server/index.js';import { fakeModelService } from './helpers/fake-model.js';import { authed } from './helpers/auth.js';

function freshApp(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pagent-chat-'));return createApp({aiService:fakeModelService(),databasePath:path.join(dir,'test.sqlite')})}
// Трое в одном круге: разговор общий, а комната — подмножеством.
async function circleOfThree(){
  const app=freshApp();
  const sasha=authed(app,{email:'sasha@kizuna.test',role:'admin'});
  const anya=authed(app,{email:'anya@kizuna.test',role:'user'});
  const lesha=authed(app,{email:'lesha@kizuna.test',role:'user'});
  await sasha.patch('/api/account').send({name:'Саша'}).expect(200);
  await anya.patch('/api/account').send({name:'Аня'}).expect(200);
  await lesha.patch('/api/account').send({name:'Лёша'}).expect(200);
  const circle=(await sasha.post('/api/circles').send({name:'Хаб'}).expect(201)).body.circle;
  for(const person of [anya,lesha]){
    const invite=(await sasha.post(`/api/circles/${circle.id}/invite`).send({}).expect(201)).body;
    await person.post(`/api/circles/invite/${invite.token}/accept`).send({}).expect(200);
  }
  const general=(await sasha.get('/api/rooms').expect(200)).body.rooms.find(room=>room.kind==='general');
  return {app,sasha,anya,lesha,circle,general};
}
const idOf=(api,name)=>api.get('/api/rooms').expect(200).then(res=>res.body.rooms.find(room=>room.name===name));

test('общий разговор есть у круга сам, и в нём все, кто в круге',async()=>{
  const {sasha,anya,lesha,general}=await circleOfThree();
  assert.equal(general.name,'Общий');
  assert.deepEqual(general.members.map(member=>member.name).sort(),['Аня','Лёша','Саша']);
  await sasha.post(`/api/rooms/${general.id}/messages`).send({body:'Всем привет, начинаем Хаб'}).expect(201);
  const seen=(await anya.get(`/api/rooms/${general.id}/messages`).expect(200)).body;
  assert.deepEqual(seen.messages.filter(message=>message.kind==='said').map(message=>message.body),['Всем привет, начинаем Хаб']);
  assert.equal(seen.messages.at(-1).author.name,'Саша');
  // Непрочитанное считается на комнате — и гаснет, когда комнату открыли.
  const before=(await lesha.get('/api/rooms').expect(200)).body.rooms.find(room=>room.id===general.id);
  assert.equal(before.unread,1);
  await lesha.get(`/api/rooms/${general.id}/messages`).expect(200);
  assert.equal((await lesha.get('/api/rooms').expect(200)).body.rooms.find(room=>room.id===general.id).unread,0);
  // Своё сообщение непрочитанным не считается.
  assert.equal((await sasha.get('/api/rooms').expect(200)).body.rooms.find(room=>room.id===general.id).unread,0);
});

test('комната — разговор подмножеством: кто не в ней, тот её не видит',async()=>{
  const {sasha,anya,lesha}=await circleOfThree();
  const room=(await sasha.post(`/api/circles/${(await idOf(sasha,'Общий')).circleId}/rooms`).send({name:'Смета',members:[anya.user.id]}).expect(201)).body.room;
  assert.deepEqual(room.members.map(member=>member.name).sort(),['Аня','Саша']);
  await sasha.post(`/api/rooms/${room.id}/messages`).send({body:'Цифры по подрядчику не сходятся'}).expect(201);
  // Аня видит комнату и сообщение, Лёша — ни того, ни другого.
  assert.ok((await anya.get('/api/rooms').expect(200)).body.rooms.some(item=>item.id===room.id));
  assert.ok(!(await lesha.get('/api/rooms').expect(200)).body.rooms.some(item=>item.id===room.id));
  await lesha.get(`/api/rooms/${room.id}/messages`).expect(404);
  await lesha.post(`/api/rooms/${room.id}/messages`).send({body:'а что тут?'}).expect(404);
  // Позвать можно только из круга — и после этого он видит комнату.
  const outsider=authed((await circleOfThree()).app,{email:'katya@kizuna.test',role:'user'});
  await sasha.post(`/api/rooms/${room.id}/members`).send({userId:outsider.user.id}).expect(409);
  await sasha.post(`/api/rooms/${room.id}/members`).send({userId:lesha.user.id}).expect(200);
  assert.ok((await lesha.get('/api/rooms').expect(200)).body.rooms.some(item=>item.id===room.id));
  // Вышел — и снова не видит.
  await lesha.post(`/api/rooms/${room.id}/leave`).send({}).expect(200);
  assert.ok(!(await lesha.get('/api/rooms').expect(200)).body.rooms.some(item=>item.id===room.id));
});

test('разговор на весь круг: видят все, включая пришедших позже; позвать и выйти нельзя',async()=>{
  const {app,sasha,anya,lesha,circle,general}=await circleOfThree();
  const room=(await sasha.post(`/api/circles/${general.circleId}/rooms`).send({name:'Запуск',everyone:true}).expect(201)).body.room;
  assert.equal(room.everyone,true);
  assert.deepEqual(room.members.map(member=>member.name).sort(),['Аня','Лёша','Саша']);
  // Тема видна каждому в круге, и призыв в ней доходит, как в «Общем».
  for(const person of [anya,lesha]) assert.ok((await person.get('/api/rooms').expect(200)).body.rooms.some(item=>item.id===room.id&&item.everyone));
  await sasha.post(`/api/rooms/${room.id}/messages`).send({body:'@Лёша, стенд к пятнице?'}).expect(201);
  assert.equal((await sasha.get(`/api/rooms/${room.id}/messages`).expect(200)).body.messages.at(-1).mentions[0].name,'Лёша');
  // Своего состава нет: позвать отдельно и выйти нельзя — в разговоре весь круг.
  await sasha.post(`/api/rooms/${room.id}/members`).send({userId:lesha.user.id}).expect(409);
  await anya.post(`/api/rooms/${room.id}/leave`).send({}).expect(409);
  // Кто пришёл в круг позже, видит тему сразу — со всей историей.
  const katya=authed(app,{email:'katya@kizuna.test',role:'user'});
  const invite=(await sasha.post(`/api/circles/${circle.id}/invite`).send({}).expect(201)).body;
  await katya.post(`/api/circles/invite/${invite.token}/accept`).send({}).expect(200);
  const seen=(await katya.get(`/api/rooms/${room.id}/messages`).expect(200)).body.messages.filter(message=>message.kind==='said');
  assert.deepEqual(seen.map(message=>message.body),['@Лёша, стенд к пятнице?']);
  // Круг из одного разговор на всех не заводит — звать некого.
  const alone=(await sasha.post('/api/circles').send({name:'Тест'}).expect(201)).body.circle;
  await sasha.post(`/api/circles/${alone.id}/rooms`).send({name:'Идеи',everyone:true}).expect(400);
});

test('призыв из разговора приходит в ту же полосу «к вам», обычное сообщение — нет',async()=>{
  const {sasha,anya,general}=await circleOfThree();
  await sasha.post(`/api/rooms/${general.id}/messages`).send({body:'Просто мысль вслух'}).expect(201);
  assert.equal((await anya.get('/api/inbox').expect(200)).body.rows.length,0,'обычное сообщение не дёргает никого');
  await sasha.post(`/api/rooms/${general.id}/messages`).send({body:'@Аня, посмотришь смету?'}).expect(201);
  const inbox=(await anya.get('/api/inbox').expect(200)).body.rows;
  assert.equal(inbox.length,1);
  assert.equal(inbox[0].kind,'chat');
  assert.equal(inbox[0].roomName,'Общий');
  assert.equal(inbox[0].from.name,'Саша');
  assert.equal(inbox[0].circle.name,'Хаб');
  // Открыл комнату — призыв погас.
  await anya.get(`/api/rooms/${general.id}/messages`).expect(200);
  assert.equal((await anya.get('/api/inbox').expect(200)).body.rows.length,0);
  // Призвать того, кого нет в комнате, нечем.
  const room=(await sasha.post(`/api/circles/${general.circleId}/rooms`).send({name:'Смета',members:[anya.user.id]}).expect(201)).body.room;
  await sasha.post(`/api/rooms/${room.id}/messages`).send({body:'@Лёша, ты тут?'}).expect(201);
  assert.equal((await sasha.get(`/api/rooms/${room.id}/messages`).expect(200)).body.messages.at(-1).mentions.length,0);
});

test('выключенный круг сворачивает и призывы из разговора',async()=>{
  const {sasha,anya,circle,general}=await circleOfThree();
  await sasha.post(`/api/rooms/${general.id}/messages`).send({body:'@Аня, нужна смета'}).expect(201);
  await anya.post(`/api/circles/${circle.id}/mute`).send({muted:true}).expect(200);
  const day=(await anya.get('/api/day').expect(200)).body;
  assert.equal(day.inbox.length,0);
  assert.equal(day.inboxFolded[0].count,1);
  assert.equal(day.inboxFolded[0].circle.name,'Хаб');
});

test('своё сообщение убирается, чужое — нет; общий разговор не переименовать',async()=>{
  const {sasha,anya,general}=await circleOfThree();
  const said=(await sasha.post(`/api/rooms/${general.id}/messages`).send({body:'Ошибся комнатой'}).expect(201)).body.message;
  await anya.delete(`/api/rooms/${general.id}/messages/${said.id}`).expect(404);
  await sasha.delete(`/api/rooms/${general.id}/messages/${said.id}`).expect(200);
  assert.ok(!(await anya.get(`/api/rooms/${general.id}/messages`).expect(200)).body.messages.some(message=>message.id===said.id));
  await sasha.patch(`/api/rooms/${general.id}`).send({name:'Не общий'}).expect(409);
  await sasha.post(`/api/rooms/${general.id}/leave`).send({}).expect(409);
});

// ── разговор как в мессенджере ──
const feed=api=>api.get('/api/notifications').expect(200).then(res=>res.body.notifications);

test('ответ цитатой: цитата видна всем, а тому, кому ответили, — строка «отвечает вам»',async()=>{
  const {sasha,anya,lesha,general}=await circleOfThree();
  const asked=(await lesha.post(`/api/rooms/${general.id}/messages`).send({body:'Нужен доступ к бою — кто выдаст?'}).expect(201)).body.message;
  const answer=(await anya.post(`/api/rooms/${general.id}/messages`).send({body:'Выдала, проверь',replyTo:asked.id}).expect(201)).body.message;
  assert.equal(answer.replyTo.id,asked.id);
  assert.equal(answer.replyTo.author.name,'Лёша');
  assert.equal(answer.replyTo.body,'Нужен доступ к бою — кто выдаст?');
  const seen=(await sasha.get(`/api/rooms/${general.id}/messages`).expect(200)).body.messages;
  assert.equal(seen.find(message=>message.id===answer.id).replyTo.author.name,'Лёша');
  const hers=await feed(lesha);
  assert.deepEqual(hers.map(item=>item.kind),['reply']);
  assert.match(hers[0].text,/^отвечает вам в разговоре «Хаб»: «Выдала, проверь»$/,'«Общий» круга в уведомлении зовётся именем круга, как в списке разговоров');
  // Саше ответ не адресован — ему ничего.
  assert.equal((await feed(sasha)).length,0);
  // Ответить можно только на сообщение из того же разговора.
  const room=(await sasha.post(`/api/circles/${general.circleId}/rooms`).send({name:'Смета',members:[anya.user.id]}).expect(201)).body.room;
  await anya.post(`/api/rooms/${room.id}/messages`).send({body:'не туда',replyTo:asked.id}).expect(400);
  // Убранное исходное сообщение цитата честно называет убранным.
  await lesha.delete(`/api/rooms/${general.id}/messages/${asked.id}`).expect(200);
  const after=(await sasha.get(`/api/rooms/${general.id}/messages`).expect(200)).body.messages.find(message=>message.id===answer.id);
  assert.equal(after.replyTo.removed,true);
  assert.equal(after.replyTo.body,'');
});

test('реакции: ставятся и снимаются одним нажатием, автору — одна склеенная строка',async()=>{
  const {sasha,anya,lesha,general}=await circleOfThree();
  const said=(await sasha.post(`/api/rooms/${general.id}/messages`).send({body:'Демо в четверг в 11'}).expect(201)).body.message;
  let result=(await anya.post(`/api/rooms/${general.id}/messages/${said.id}/reactions`).send({emoji:'👍'}).expect(200)).body;
  assert.deepEqual(result.reactions.map(item=>[item.emoji,item.count,item.mine]),[['👍',1,true]]);
  await lesha.post(`/api/rooms/${general.id}/messages/${said.id}/reactions`).send({emoji:'👍'}).expect(200);
  await lesha.post(`/api/rooms/${general.id}/messages/${said.id}/reactions`).send({emoji:'🔥'}).expect(200);
  const mine=(await sasha.get(`/api/rooms/${general.id}/messages`).expect(200)).body.messages.find(message=>message.id===said.id);
  assert.deepEqual(mine.reactions.map(item=>[item.emoji,item.count,item.mine]),[['👍',2,false],['🔥',1,false]]);
  assert.deepEqual(mine.reactions[0].people.map(person=>person.name),['Аня','Лёша']);
  const rows=(await feed(sasha)).filter(item=>item.kind==='reaction');
  assert.equal(rows.length,1,'реакции склеиваются в одну строку на разговор');
  assert.equal(rows[0].count,3);
  // Второе нажатие снимает реакцию.
  result=(await anya.post(`/api/rooms/${general.id}/messages/${said.id}/reactions`).send({emoji:'👍'}).expect(200)).body;
  assert.deepEqual(result.reactions.map(item=>[item.emoji,item.count,item.mine]),[['👍',1,false],['🔥',1,false]]);
  // Произвольный символ реакцией не станет.
  await anya.post(`/api/rooms/${general.id}/messages/${said.id}/reactions`).send({emoji:'💩'}).expect(400);
});

test('закреп один на разговор: заменяется, снимается и уходит вместе с сообщением',async()=>{
  const {sasha,anya,lesha,general}=await circleOfThree();
  const first=(await sasha.post(`/api/rooms/${general.id}/messages`).send({body:'Демо в четверг в 11'}).expect(201)).body.message;
  const second=(await anya.post(`/api/rooms/${general.id}/messages`).send({body:'Стенд — Лёша, тексты — Катя'}).expect(201)).body.message;
  await lesha.post(`/api/rooms/${general.id}/pin`).send({messageId:first.id}).expect(200);
  let room=(await anya.get('/api/rooms').expect(200)).body.rooms.find(item=>item.id===general.id);
  assert.equal(room.pinned.body,'Демо в четверг в 11');
  assert.equal(room.pinned.author.name,'Саша');
  assert.ok((await feed(anya)).some(item=>item.kind==='pin'),'закреп — повод для остальных в разговоре');
  await sasha.post(`/api/rooms/${general.id}/pin`).send({messageId:second.id}).expect(200);
  room=(await lesha.get('/api/rooms').expect(200)).body.rooms.find(item=>item.id===general.id);
  assert.equal(room.pinned.id,second.id);
  await anya.delete(`/api/rooms/${general.id}/messages/${second.id}`).expect(200);
  room=(await lesha.get('/api/rooms').expect(200)).body.rooms.find(item=>item.id===general.id);
  assert.equal(room.pinned,null);
  await sasha.post(`/api/rooms/${general.id}/pin`).send({messageId:first.id}).expect(200);
  await sasha.post(`/api/rooms/${general.id}/pin`).send({}).expect(200);
  assert.equal((await lesha.get('/api/rooms').expect(200)).body.rooms.find(item=>item.id===general.id).pinned,null);
});

test('две галочки: своё сообщение прочитано, когда его дочитал кто-то ещё',async()=>{
  const {sasha,anya,general}=await circleOfThree();
  const said=(await sasha.post(`/api/rooms/${general.id}/messages`).send({body:'Кто посмотрит смету?'}).expect(201)).body.message;
  assert.equal(said.read,false);
  await anya.get(`/api/rooms/${general.id}/messages`).expect(200);
  const again=(await sasha.get(`/api/rooms/${general.id}/messages`).expect(200)).body.messages.find(message=>message.id===said.id);
  assert.equal(again.read,true);
  // У чужих сообщений признака нет — это не моё дело, кто их прочитал.
  assert.equal((await anya.get(`/api/rooms/${general.id}/messages`).expect(200)).body.messages.find(message=>message.id===said.id).read,null);
});

test('дело человеку круга встаёт в «Общий» карточкой и не считается непрочитанным',async()=>{
  const {sasha,anya,lesha,general}=await circleOfThree();
  const entry=(await sasha.post('/api/captures').send({raw:'Ане — прислать смету по Хабу'}).expect(201)).body.entry;
  const card=(await lesha.get(`/api/rooms/${general.id}/messages`).expect(200)).body.messages.find(message=>message.kind==='deed');
  assert.ok(card,'карточка дела видна всему кругу');
  assert.equal(card.deed.captureId,entry.id);
  assert.equal(card.deed.state,'pending');
  assert.equal(card.deed.assignee.name,'Аня');
  assert.equal(card.deed.forMe,false);
  assert.equal((await anya.get('/api/rooms').expect(200)).body.rooms.find(room=>room.id===general.id).unread,0);
  const hers=(await anya.get(`/api/rooms/${general.id}/messages`).expect(200)).body.messages.find(message=>message.kind==='deed');
  assert.equal(hers.deed.forMe,true);
  await anya.post(`/api/assignments/${hers.deed.assignmentId}/respond`).send({take:true}).expect(200);
  assert.equal((await sasha.get(`/api/rooms/${general.id}/messages`).expect(200)).body.messages.find(message=>message.kind==='deed').deed.state,'accepted');
  const last=(await lesha.get('/api/rooms').expect(200)).body.rooms.find(room=>room.id===general.id).last;
  assert.equal(last.kind,'deed');
  assert.equal(last.by.name,'Саша');
});

test('позвали в комнату — строка за колокольчиком',async()=>{
  const {sasha,anya,lesha,general}=await circleOfThree();
  const room=(await sasha.post(`/api/circles/${general.circleId}/rooms`).send({name:'Смета',members:[anya.user.id]}).expect(201)).body.room;
  assert.match((await feed(anya)).find(item=>item.kind==='room').text,/^зовёт вас в комнату «Смета»$/);
  await anya.post(`/api/rooms/${room.id}/members`).send({userId:lesha.user.id}).expect(200);
  const his=(await feed(lesha)).find(item=>item.kind==='room');
  assert.equal(his.roomId,room.id);
  assert.equal((await feed(sasha)).filter(item=>item.kind==='room').length,0,'себя не зовут');
});
