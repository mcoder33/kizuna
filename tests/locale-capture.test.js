import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiService} from '../server/ai.js';
import {classifyGuidance} from '../server/cli-providers.js';
import {SUPPORTED_LOCALES} from '../public/i18n.js';
test('all seven capture languages preserve raw text in fallback and prompts',async()=>{
 const samples=['Позвонить Анне','Call Ana','Llamar a Ana','Ligar para Ana','Ana anrufen','Appeler Ana','アナに電話する'];
 const ai=createAiService({env:{}});
 for(const [i,locale] of SUPPORTED_LOCALES.entries()){
  const result=await ai.classify(samples[i],'fallback',undefined,null,'',locale);
  assert.equal(result.usedProvider,'fallback');
  assert.equal(result.classification.entities.people.length,0);
  assert.equal(result.classification.summary,samples[i]);
  assert.ok(classifyGuidance(new Date('2026-10-02T00:00:00Z'),'UTC',locale).includes(`Account locale: ${locale}`));
 }
});

import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import {createApp} from '../server/index.js';
import {fakeModelService} from './helpers/fake-model.js';
import {authed} from './helpers/auth.js';
test('sync and queued capture paths receive account locale and retain raw',async()=>{
 const calls=[];const ai=fakeModelService();const original=ai.classify.bind(ai);
 ai.classify=async (...args)=>{calls.push(args);return original(...args);};
 const app=createApp({aiService:ai,databasePath:path.join(fs.mkdtempSync(path.join(os.tmpdir(),'locale-capture-')),'db.sqlite')});
 const api=authed(app);await api.put('/api/settings').send({locale:'ja',detectedLocale:'en'}).expect(200);
 const raw='アナに電話する — 本当の名前';
 const sync=await api.post('/api/captures').set('Accept-Language','de').send({raw,provider:'fallback'}).expect(201);
 assert.equal(calls[0][5],'ja');
 const queued=await api.post('/api/captures').set('Prefer','respond-async').send({raw,provider:'fallback'}).expect(202);
 app.captureJobWorker.start();
 const until=Date.now()+2000;
 while(calls.length<2&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(calls[1][5],'ja');
 assert.equal(app.database.prepare('SELECT raw FROM captures WHERE id=?').get(queued.body.captureId).raw,raw);
 await app.captureJobWorker.stop();app.database.close();
});
