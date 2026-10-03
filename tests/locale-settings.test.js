import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import {createApp} from '../server/index.js';
import {authed} from './helpers/auth.js';
import {userLocale,requestLanguages} from '../server/locale.js';
test('locale is private to each account and rejects noncanonical values',async()=>{
 const app=createApp({databasePath:path.join(fs.mkdtempSync(path.join(os.tmpdir(),'locale-')),'db.sqlite')});
 const a=authed(app),b=authed(app,{email:'other@test.local',role:'user'});
 await a.put('/api/settings').send({locale:'ja',detectedLocale:'fr'}).expect(200);
 assert.equal((await b.get('/api/settings')).body.settings.locale,'system');
 for(const value of ['pt','pt-PT','EN','xx',false,{}]) await b.put('/api/settings').send({locale:value}).expect(400);
 await b.put('/api/settings').send({detectedLocale:'system'}).expect(400);
 await b.put('/api/settings').send({detectedLocale:'de'}).expect(200);
 assert.equal(userLocale(app.database,a.user.id,['en']),'ja');
 assert.equal(userLocale(app.database,b.user.id,['fr']),'fr');
 assert.equal(userLocale(app.database,b.user.id),'de');
 assert.deepEqual(requestLanguages('ja;q=0,en;q=0.3,de;q=0.9'),['de','en']);
 app.database.close();
});

import {catalogs} from '../public/i18n-catalog.js';
import {translate} from '../public/i18n.js';
import {NOTE_BODY_LIMIT,ATTACHMENTS_PER_CAPTURE,addAttachment} from '../server/db.js';
import {SUBTASK_TITLE_LIMIT} from '../server/subtasks.js';
import {MEMORY_TEXT_LIMIT,MEMORY_SUBJECT_LIMIT} from '../server/memory.js';
test('dynamic validation uses each recipient locale and preserves numeric and named parameters',async()=>{
 const sources=['Подзадача — от 1 до {limit} символов.','Неизвестная настройка: {name}.','Настройку «{name}» меняет администратор.','Некорректное значение настройки: {name}.','Заметка должна быть текстом до {limit} символов.','Правило — от 1 до {limit} символов.','Тема — до {limit} символов.','К записи можно приложить не больше {limit} файлов.'];
 for(const locale of ['en','ja'])for(const source of sources){
  assert.equal(typeof catalogs[locale][source],'string',`${locale}: ${source}`);
  assert.notEqual(catalogs[locale][source],source,`${locale}: actual translation required`);
 }
 const app=createApp({databasePath:path.join(fs.mkdtempSync(path.join(os.tmpdir(),'locale-errors-')),'db.sqlite')});
 const apis=[authed(app,{email:'en@errors.test',role:'user'}),authed(app,{email:'ja@errors.test',role:'user'})];
 const observed=[];
 try{
  for(const [i,api] of apis.entries()){
   const locale=['en','ja'][i];await api.put('/api/settings').send({locale}).expect(200);
   const raw='User 山田 record';const capture=(await api.post('/api/captures').send({raw}).expect(201)).body.entry.id;
   const checks=[
    [()=>api.post(`/api/captures/${capture}/subtasks`).send({title:''}),400,sources[0],{limit:SUBTASK_TITLE_LIMIT},'invalid_subtask'],
    [()=>api.put('/api/settings').send({'Field 山田':'value'}),400,sources[1],{name:'Field 山田'},'unknown_setting'],
    [()=>api.put('/api/settings').send({aiProvider:'fallback'}),403,sources[2],{name:'aiProvider'},'forbidden'],
    [()=>api.put('/api/settings').send({theme:'bad'}),400,sources[3],{name:'theme'},'invalid_setting'],
    [()=>api.post(`/api/captures/${capture}/notes`).send({body:false}),400,sources[4],{limit:NOTE_BODY_LIMIT},'invalid_note'],
    [()=>api.post('/api/agent/memory').send({text:''}),400,sources[5],{limit:MEMORY_TEXT_LIMIT},'invalid_memory'],
    [()=>api.post('/api/agent/memory').send({text:'valid',subject:'x'.repeat(MEMORY_SUBJECT_LIMIT+1)}),400,sources[6],{limit:MEMORY_SUBJECT_LIMIT},'invalid_memory'],
   ];
   for(let j=0;j<ATTACHMENTS_PER_CAPTURE;j++)addAttachment(app.database,capture,{filename:`${j}.txt`,contentType:'text/plain',bytes:Buffer.from('x')});
   checks.push([()=>api.post(`/api/captures/${capture}/attachments`).set('Content-Type','text/plain').send('x'),409,sources[7],{limit:ATTACHMENTS_PER_CAPTURE},'too_many_attachments']);
   const messages=[];
   for(const [request,status,source,params,code] of checks){const result=(await request().set('Accept-Language',locale==='en'?'ja':'en').expect(status)).body.error;assert.equal(result.code,code);assert.equal(result.message,translate(locale,source,params));messages.push(result.message);}
   assert.equal(app.database.prepare('SELECT raw FROM captures WHERE id=?').get(capture).raw,raw);
   observed.push(messages);
  }
  for(let i=0;i<sources.length;i++)assert.notEqual(observed[0][i],observed[1][i]);
 }finally{await app.captureJobWorker.stop();app.database.close();}
});
