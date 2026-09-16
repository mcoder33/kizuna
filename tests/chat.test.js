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
