import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import { createApp } from '../server/index.js';import { fakeModelService } from './helpers/fake-model.js';import { authed } from './helpers/auth.js';

// Обсуждение без круга: у любой записи есть комментарии, через @ зовут любого
// человека из Кизуны, и позванный видит эту одну запись — не круг и не журнал.
function freshApp(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pagent-people-'));return createApp({aiService:fakeModelService(),databasePath:path.join(dir,'test.sqlite')})}
async function trio(){
  const app=freshApp();
  const sasha=authed(app,{email:'sasha@kizuna.test',role:'admin'});
  const anya=authed(app,{email:'anya@kizuna.test',role:'user'});
  const petya=authed(app,{email:'petya@kizuna.test',role:'user'});
  await sasha.patch('/api/account').send({name:'Саша'}).expect(200);
  await anya.patch('/api/account').send({name:'Аня'}).expect(200);
  await petya.patch('/api/account').send({name:'Петя'}).expect(200);
  const entry=(await sasha.post('/api/captures').send({raw:'Допинать карусель с генератором фраз'}).expect(201)).body.entry;
  return {app,sasha,anya,petya,entry};
}
const say=(api,entry,body,share)=>api.post(`/api/captures/${entry.id}/comments`).send(share?{body,share}:{body});

test('у личной записи есть обсуждение, а позвать можно любого — только с согласия автора',async()=>{
  const {sasha,anya,entry}=await trio();
  // Реплика себе: никого не зовут — ничего не спрашивают.
  await say(sasha,entry,'Сид не сбрасывается — проверить утром').expect(201);
  const card=(await sasha.get(`/api/captures/${entry.id}`).expect(200)).body.entry;
  const her=card.callable.find(person=>person.name==='Аня');
  assert.equal(her.group,'everyone','без общего круга человек всё равно в подсказке');
  assert.equal(card.participants.length,0);

  // Призыв того, кто запись не видит, молча не расшаривает её.
  const asked=(await say(sasha,entry,'@Аня глянь сид').expect(409)).body;
  assert.equal(asked.error.code,'share_needed');
  assert.deepEqual(asked.people.map(person=>person.name),['Аня']);
  await anya.get(`/api/captures/${entry.id}`).expect(404);

  // «Отправить без призыва»: сообщение ушло, доступа нет.
  const quiet=(await say(sasha,entry,'@Аня глянь сид','no').expect(201)).body;
  assert.equal(quiet.comment.mentions.length,0);
  await anya.get(`/api/captures/${entry.id}`).expect(404);

  // «Позвать и отправить»: Аня видит запись, призыв ждёт её в «к вам» и в «Обсуждениях».
  const shared=(await say(sasha,entry,'@Аня глянь сид, пожалуйста','yes').expect(201)).body;
  assert.equal(shared.comment.mentions[0].name,'Аня');
  assert.deepEqual(shared.participants.map(person=>person.name),['Аня']);
  const day=(await anya.get('/api/day').expect(200)).body;
  assert.equal(day.inbox.filter(row=>row.kind==='call').length,1);
  const talks=(await anya.get('/api/discussions').expect(200)).body.discussions;
  assert.equal(talks.length,1);
  assert.equal(talks[0].captureId,entry.id);
  assert.equal(talks[0].unread,true);
  assert.equal(talks[0].author.name,'Саша');
  const seen=(await anya.get(`/api/captures/${entry.id}`).expect(200)).body.entry;
  assert.equal(seen.mine,false);
  assert.equal(seen.comments.length,3,'позванный видит и прошлые реплики — об этом предупреждает подтверждение');
  assert.equal((await anya.get('/api/discussions').expect(200)).body.discussions[0].unread,false,'открыл — прочитал');
  // Чужая запись не падает в свой журнал и не правится.
  assert.equal((await anya.get('/api/entries?limit=100').expect(200)).body.entries.length,0);
  assert.equal((await sasha.get('/api/discussions').expect(200)).body.discussions.length,1);
});

test('позванный зовёт только своих, уходит сам, а автор убирает',async()=>{
  const {sasha,anya,petya,entry}=await trio();
  await say(sasha,entry,'@Аня нужен взгляд','yes').expect(201);
  // Позванный не делится чужой записью с незнакомыми: Пети нет ни в записи, ни в его кругах.
  const hers=(await anya.get(`/api/captures/${entry.id}`).expect(200)).body.entry;
  assert.ok(hers.callable.some(person=>person.name==='Саша'&&person.group==='record'));
  assert.ok(!hers.callable.some(person=>person.name==='Петя'));
  const reply=(await say(anya,entry,'@Саша @Петя смотрю').expect(201)).body;
  assert.deepEqual(reply.comment.mentions.map(person=>person.name),['Саша']);
  await petya.get(`/api/captures/${entry.id}`).expect(404);
  // Чужой не может ни убрать, ни увидеть.
  await petya.delete(`/api/captures/${entry.id}/people/${anya.user.id}`).expect(404);
  // «Не следить»: ушёл сам — запись пропала.
  await anya.delete(`/api/captures/${entry.id}/people/${anya.user.id}`).expect(200);
  await anya.get(`/api/captures/${entry.id}`).expect(404);
  assert.equal((await anya.get('/api/discussions').expect(200)).body.discussions.length,0);
  // Новый призыв возвращает, автор убирает.
  await say(sasha,entry,'@Аня вернись','yes').expect(201);
  await anya.get(`/api/captures/${entry.id}`).expect(200);
  await sasha.post(`/api/captures/${entry.id}/comments`).send({body:'ok'}).expect(201);
  await sasha.delete(`/api/captures/${entry.id}/people/${anya.user.id}`).expect(200);
  await anya.get(`/api/captures/${entry.id}`).expect(404);
  assert.equal((await anya.get('/api/day').expect(200)).body.inbox.filter(row=>row.kind==='call').length,0,'убранного старый призыв не зовёт');
  // Очистка журнала автора уносит и участников — без спотыкания о внешние ключи.
  await say(sasha,entry,'@Аня последний раз','yes').expect(201);
  await sasha.post('/api/reset').send({confirmation:'СБРОСИТЬ КИЗУНА'}).expect(200);
  await anya.get(`/api/captures/${entry.id}`).expect(404);
});
