import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import express from 'express';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'../..');
process.chdir(root);
for(const key of Object.keys(process.env)) if(/^(PAGENT_|OPENAI_|OPENROUTER_|GEMINI_|GOOGLE_|VAPID_|TELEGRAM_)/.test(key)) delete process.env[key];
Object.assign(process.env,{DOTENV_CONFIG_PATH:'/dev/null',PAGENT_SECURE_COOKIES:'off',PAGENT_REPORT_IMAGE_PROVIDER:'off',PAGENT_TIMEZONE:'Europe/Samara',PAGENT_WORKSHOP_MODE:'all'});
globalThis.fetch=async()=>{throw new Error('External network disabled in local design fixture')};
const {createApp}=await import('../../server/index.js');
const {fakeModelService}=await import('../helpers/fake-model.js');
const {authed}=await import('../helpers/auth.js');
fs.mkdirSync(path.join(root,'tmp/workshop-preview'),{recursive:true});
const app=createApp({databasePath:path.join(root,'tmp/workshop-preview',`workshop-${Date.now()}.sqlite`),aiService:fakeModelService(),secureCookies:false});
const profiles={}; const fixture={};
const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Samara'}).format(new Date());
for(const name of ['typical','empty','many']) {
 const api=authed(app,{email:`${name}@workshop.test`,role:name==='typical'?'admin':'user'});
 profiles[name]=api; fixture[name]={tasks:[],pages:[]};
 await api.put('/api/settings').send({locale:'ru',requestedTimeZone:'Europe/Samara'}).expect(200);
 await api.patch('/api/account').send({name:name==='typical'?'Мастерская':name==='empty'?'Новый день':'Большой проект'}).expect(200);
 if(name==='empty')continue;
 const titles=['Отправить наброски для сайта','Забрать книгу из магазина','Выбрать маршрут на выходные','Собрать идеи для новой главы','Проверить макет письма','Договориться о встрече с командой'];
 if(name==='many') titles.push('Подготовить презентацию проекта: собрать решения, выбрать примеры и показать команде следующий шаг','Разобрать фотографии из поездки','Ответить на письмо издательства','Записаться на профилактику велосипеда','Заказать новую лампу для рабочего стола','Перечитать заметки после встречи с редактором','Выбрать подарок на день рождения','Проверить расписание электричек','Отправить документы бухгалтеру','Забронировать столик на пятницу','Собрать плейлист для дороги','Обновить список книг на осень','Согласовать время созвона','Сохранить идеи для следующего выпуска');
 for(const [i,raw] of titles.entries()) {
   const entry=(await api.post('/api/captures').send({raw,primaryType:'todo',due:{date:day,time:i===0?'11:00':i===1?'17:00':null}}).expect(201)).body.entry;
   fixture[name].tasks.push(entry.id);
   if(i===3||i===4) await api.post(`/api/projections/${entry.projections.find(p=>p.type==='task').id}/complete`).send({}).expect(200);
 }
 for(const raw of ['Отправить правки к макету главной','Оплатить доставку книг','Подготовить вопросы к встрече','Разобрать входящие письма','Сохранить заметки после прогулки','Обновить описание проекта']) {
  const entry=(await api.post('/api/captures').send({raw,primaryType:'todo',due:{date:day}}).expect(201)).body.entry;
  await api.post(`/api/projections/${entry.projections.find(p=>p.type==='task').id}/complete`).send({}).expect(200);
 }
 const col=(await api.post('/api/board/columns').send({name:'В работе'}).expect(201)).body;
 await api.post('/api/board/move').send({captureId:fixture[name].tasks[0],columnId:col.id,index:0}).expect(200);
 for(const title of ['Осенние планы','Идеи для мастерской','Книги и находки']) {
   const page=(await api.post('/api/pages').send({title}).expect(201)).body.page;
   fixture[name].pages.push(page.id);
   await api.post(`/api/captures/${page.id}/notes`).send({body:`# ${title}\n\nМесто, где мысли постепенно обретают форму.\n\n## На этой неделе\n\n- Сохранить простоту\n- Собрать примеры\n- Обсудить следующий шаг\n\n> Хороший день начинается с одной ясной мысли.\n\nНе нужно делать всё сразу. Запишите главное, а к деталям можно вернуться позже.`}).expect(200);
 }
 await api.post(`/api/captures/${fixture[name].tasks[0]}/notes`).send({body:'## Что подготовить\n\nПоказать спокойную дневную сцену и вечерний вариант. Сохранить знакомое поле ввода.\n\n- [ ] Выбрать три примера\n- [ ] Проверить на телефоне\n\n[Материалы](https://example.com)'}).expect(200);
 if(name==='typical')await api.post(`/api/captures/${fixture[name].tasks[0]}/attachments`).set('Content-Type','image/webp').set('X-Attachment-Name',encodeURIComponent('Дневная комната.webp')).send(fs.readFileSync(path.join(root,'public/workshop/autumn-day-mobile.webp'))).expect(201);
 await api.post('/api/feedback').set('Idempotency-Key',`workshop-feedback-${name}`).send({text:'Хочется, чтобы вечером комната становилась уютнее, а список дел оставался хорошо читаемым.',allowContact:true}).expect(201);
}
const admin=profiles.typical, peer=authed(app,{email:'reader@workshop.test',role:'user'});
await peer.patch('/api/account').send({name:'Аня'}).expect(200);
const circle=(await admin.post('/api/circles').send({name:'Мастерская'}).expect(201)).body.circle;
await admin.post(`/api/circles/${circle.id}/members`).send({userId:peer.user.id}).expect(200);
const rooms=(await admin.get('/api/rooms').expect(200)).body.rooms;
fixture.typical.circle=circle.id;
if(rooms[0]) {
 fixture.typical.room=rooms[0].id;
 await admin.post(`/api/rooms/${rooms[0].id}/messages`).send({body:'Собираем идеи для следующей недели. Начнём с самого важного.'}).expect(201);
 await peer.post(`/api/rooms/${rooms[0].id}/messages`).send({body:'Подготовила наброски. Вечером можно посмотреть вместе.'}).expect(201);
}
fs.writeFileSync(path.join(root,'tmp/workshop-preview/fixture.json'),JSON.stringify({day,...fixture},null,2));
const wrapper=express();
wrapper.get('/__fixture',(_req,res)=>res.json({day,...fixture}));
wrapper.get('/__preview',async(req,res)=>{
 const api=profiles[req.query.profile]||profiles.typical;
 await api.patch('/api/ui-preferences').send({userId:api.user.id,changes:{'kizuna-appearance':req.query.appearance==='classic'?'classic':'workshop','kizuna-room-season':String(req.query.season||'autumn'),'kizuna-room-light':String(req.query.light||'day'),'kizuna-torii-hints':'enabled','kizuna-torii-dismissed':null}}).expect(200);
 await api.put('/api/settings').send({theme:req.query.theme==='dark'?'dark':'light'}).expect(200);
 res.cookie('pagent_session',api.cookie.slice(api.cookie.indexOf('=')+1),{httpOnly:true,sameSite:'lax'});
 res.redirect('/#'+String(req.query.route||'today').replace(/[^a-zA-Z0-9/?=&_:\-]/g,''));
});
wrapper.get('/__public',(req,res)=>{res.clearCookie('pagent_session');res.redirect(['/login','/public/mac-download.html'].includes(req.query.path)?req.query.path:'/')});
wrapper.use(app);
const port=Number(process.env.WORKSHOP_PREVIEW_PORT||8901);
wrapper.listen(port,'127.0.0.1',()=>console.log(`Workshop implementation ready: http://127.0.0.1:${port}/__preview`));
