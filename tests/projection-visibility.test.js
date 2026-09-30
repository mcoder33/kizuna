import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server/index.js';import { fakeModelClassification } from './helpers/fake-model.js';import { authed } from './helpers/auth.js';
import { normalizeClassification, toTodo } from '../server/classifier.js';
import { createLedger, openDatabase } from '../server/db.js';

function fixture() { const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pagent-projections-')); return path.join(directory,'test.sqlite'); }
function modelClassification(raw, primaryType, overrides = {}) {
  return toTodo(normalizeClassification({ primaryType, entities:{ projects:[], people:[], when:null, followUp:null, ...(overrides.entities||{}) }, additionalTypes:[], summary:raw, proposedActions:[], completed:false, ambiguity:overrides.ambiguity ?? null },raw,new Date('2026-08-21T10:00:00Z')),new Date('2026-08-21T10:00:00Z'));
}

test('accepted classifications stay visible while a flagged ambiguity is gated', async () => {
  const databasePath=fixture();
  const classify=raw=>{
    if(/послезавтра/u.test(raw))return modelClassification(raw,'meeting_event',{ambiguity:{field:'schedule',question:'Какая из двух дат верна?'}});
    if(/созвон/u.test(raw))return modelClassification(raw,'meeting_event',{entities:{when:{date:'2026-08-22',time:'11:00'}}});
    return modelClassification(raw,'task');
  };
  const aiService={status:async()=>({}),classify:async raw=>({classification:classify(raw),provider:'openrouter',requestedProvider:'openrouter',usedProvider:'openrouter'}),answer:async()=>({})};
  const api=authed(createApp({databasePath,aiService,now:()=>new Date('2026-08-21T10:00:00Z')}));

  const task=(await api.post('/api/captures').send({raw:'Нужно проверить Hub'}).expect(201)).body;
  assert.equal(task.review.level,'high','однозначная задача не требует вопросов');
  assert.equal(task.entry.projections[0].type,'task');
  assert.ok((await api.get('/api/day').expect(200)).body.day.some(entry=>entry.id===task.entry.id),'дело без срока легло на сегодня и видно в дне');

  const meeting=(await api.post('/api/captures').send({raw:'Завтра в 11 созвон по Hub'}).expect(201)).body;
  assert.equal(meeting.review.level,'high');
  assert.equal(meeting.entry.projections[0].type,'task','встреча — тоже туду, только со временем');
  assert.ok((await api.get('/api/day').expect(200)).body.upcoming.some(entry=>entry.id===meeting.entry.id));

  const undated=(await api.post('/api/captures').send({raw:'созвон с BE'}).expect(201)).body;
  assert.equal(undated.review.level,'high','запись без срока принимается');
  assert.equal(undated.entry.projections[0].type,'task','запись без срока всё равно видна');
  assert.ok(undated.entry.interpretation.classification.entities.schedule.date,'и срок у него есть');

  const conflict=(await api.post('/api/captures').send({raw:'Завтра и послезавтра созвон по Hub'}).expect(201)).body;
  assert.equal(conflict.review.level,'conflict');
  assert.equal(conflict.review.question,'Какая из двух дат верна?');
  assert.deepEqual(conflict.entry.projections,[]);
});

test('startup repairs missing current projections once without recreating reverted history', () => {
  const databasePath=fixture(), db=openDatabase(databasePath);
  const restored=createLedger(db,{raw:'Нужно проверить Hub',classification:fakeModelClassification('Нужно проверить Hub'),provider:'fallback',createProjections:false});
  const reverted=createLedger(db,{raw:'Нужно проверить TCAM',classification:fakeModelClassification('Нужно проверить TCAM'),provider:'fallback'});
  db.prepare("UPDATE projections SET status='reverted',reverted_at=? WHERE capture_id=?").run(new Date().toISOString(),reverted.captureId);
  const conflict=createLedger(db,{raw:'Завтра и послезавтра созвон по Hub',classification:fakeModelClassification('Завтра и послезавтра созвон по Hub'),provider:'fallback',createProjections:false});
  db.close();
  const repaired=openDatabase(databasePath);
  assert.equal(repaired.prepare("SELECT COUNT(*) AS count FROM projections WHERE capture_id=? AND status='active'").get(restored.captureId).count,1);
  assert.equal(repaired.prepare('SELECT COUNT(*) AS count FROM projections WHERE capture_id=?').get(restored.captureId).count,1);
  assert.equal(repaired.prepare("SELECT COUNT(*) AS count FROM projections WHERE capture_id=? AND status='active'").get(reverted.captureId).count,0);
  assert.equal(repaired.prepare('SELECT COUNT(*) AS count FROM projections WHERE capture_id=?').get(reverted.captureId).count,1);
  assert.equal(repaired.prepare('SELECT COUNT(*) AS count FROM projections WHERE capture_id=?').get(conflict.captureId).count,0);
  assert.equal(repaired.prepare("SELECT COUNT(*) AS count FROM ledger_events WHERE capture_id=?").get(restored.captureId).count,0);
  repaired.close();
  const reopened=openDatabase(databasePath);
  assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM projections WHERE capture_id=?').get(restored.captureId).count,1);
  reopened.close();
});
