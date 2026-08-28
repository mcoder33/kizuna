import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';import { fakeModelClassification } from './helpers/fake-model.js';import { authed } from './helpers/auth.js';

import { openDatabase, enqueueCaptureJob, claimCaptureJob, completeCaptureJob } from '../server/db.js';

function fixture(aiService, workerOptions) { const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pagent-jobs-')); const databasePath=path.join(directory,'test.sqlite'); const app=createApp({databasePath,aiService,workerOptions}); return { app, api:authed(app), databasePath }; }
function classification(raw) { return { classification:fakeModelClassification(raw),provider:'fallback',requestedProvider:'fallback',usedProvider:'fallback',fallbackReason:null,model:null }; }
function deferred() { let resolve; const promise=new Promise(done=>{resolve=done;}); return { promise, resolve }; }
async function eventually(assertion, timeout=1500) { const until=Date.now()+timeout; let lastError; while(Date.now()<until){try{return await assertion();}catch(error){lastError=error;await new Promise(resolve=>setTimeout(resolve,10));}}throw lastError; }

test('async capture persists raw before a blocked provider and leaves legacy sync response intact',async()=>{
  const blocked=deferred(); let classifyStarted=false;
  const aiService={status:async()=>({selectedProvider:'fallback'}),classify:async(raw)=>{classifyStarted=true;await blocked.promise;return classification(raw);},answer:async()=>({})};
  const { app, api }=fixture(aiService);
  app.captureJobWorker.start();
  const asyncResponse=await api.post('/api/captures').set('Prefer','wait=3, respond-async; handling=lenient').send({raw:'Сохранить до классификации'}).expect(202);
  assert.match(asyncResponse.headers.location,/^\/api\/jobs\//); await eventually(()=>assert.equal(classifyStarted,true));
  const exported=(await api.get('/api/export')).body;
  assert.equal(exported.captures.length,1); assert.equal(exported.captures[0].raw,'Сохранить до классификации'); assert.equal(exported.interpretations.length,0);
  blocked.resolve(); await eventually(async()=>assert.equal((await api.get(asyncResponse.body.statusUrl)).body.state,'succeeded'));
  await app.captureJobWorker.stop();
  const sync=fixture({status:async()=>({}),classify:async raw=>classification(raw),answer:async()=>({})});
  const legacy=await sync.api.post('/api/captures').send({raw:'Синхронная запись'}).expect(201);
  assert.equal(legacy.body.entry.raw,'Синхронная запись'); await sync.app.captureJobWorker.stop();
});

test('worker records one interpretation, terminal trail and safe job metadata',async()=>{
  const { app, api, databasePath }=fixture({status:async()=>({selectedProvider:'fallback'}),classify:async raw=>({...classification(raw),model:'internal-model-42'}),answer:async()=>({})}); app.captureJobWorker.start();
  const queued=(await api.post('/api/captures').set('Prefer','respond-async').send({raw:'Нужно проверить Hub'}).expect(202)).body;
  const job=await eventually(async()=>{const response=await api.get(queued.statusUrl);assert.equal(response.body.state,'succeeded');return response.body;});
  assert.deepEqual(Object.keys(job).sort(),['cancelledAt','captureId','createdAt','error','finishedAt','id','retryOfId','retryable','stage','startedAt','state','usedProvider'].sort());
  for(const unsafeKey of ['raw','prompt','stdout','stderr','path','env','auth','model'])assert.equal(Object.hasOwn(job,unsafeKey),false);
  assert.equal(job.usedProvider,'fallback'); assert.equal(job.error,null);
  const exported=(await api.get('/api/export')).body; assert.equal(exported.interpretations.length,1);
  await app.captureJobWorker.stop();
  const db=openDatabase(databasePath); assert.deepEqual(db.prepare('SELECT event_type FROM capture_job_events WHERE job_id=? ORDER BY created_at,rowid').all(queued.jobId).map(row=>row.event_type),['queued','started','succeeded']); db.close();
});

test('cancellation fences a late provider result and rejects retry provider overrides',async()=>{
  const blocked=deferred(); let abortObserved=false;
  const aiService={status:async()=>({selectedProvider:'fallback'}),classify:async(raw,provider,signal)=>{signal.addEventListener('abort',()=>{abortObserved=true;blocked.resolve();},{once:true});await blocked.promise;return classification(raw);},answer:async()=>({})};
  const { app, api, databasePath }=fixture(aiService); app.captureJobWorker.start();
  const queued=(await api.post('/api/captures').set('Prefer','respond-async').send({raw:'Не сохранять результат'})).body;
  await eventually(async()=>assert.equal((await api.get(queued.statusUrl)).body.state,'running'));
  await api.post(`/api/jobs/${queued.jobId}/cancel`).expect(202); await eventually(()=>assert.equal(abortObserved,true));
  await eventually(async()=>assert.equal((await api.get(queued.statusUrl)).body.state,'cancelled'));
  assert.equal((await api.post(`/api/jobs/${queued.jobId}/cancel`).expect(200)).body.state,'cancelled');
  for(const provider of ['openai','claude-cli','codex-cli'])await api.post(`/api/jobs/${queued.jobId}/retry`).send({provider}).expect(400);
  const db=openDatabase(databasePath); assert.equal(db.prepare('SELECT COUNT(*) AS count FROM capture_jobs WHERE capture_id=?').get(queued.captureId).count,1); db.close();
  await new Promise(resolve=>setTimeout(resolve,20)); assert.equal((await api.get('/api/export')).body.interpretations.length,0);
  await app.captureJobWorker.stop();
});

test('explicit retry links the same capture and preserves its provider snapshot',async()=>{
  let calls=0;
  const aiService={status:async()=>({selectedProvider:'fallback'}),classify:async raw=>{calls+=1;if(calls===1)throw Object.assign(new Error('down'),{code:'unavailable'});return classification(raw);},answer:async()=>({})};
  const { app, api, databasePath }=fixture(aiService); app.captureJobWorker.start();
  const original=(await api.post('/api/captures').set('Prefer','respond-async').send({raw:'Повторить явно'})).body;
  await eventually(async()=>assert.equal((await api.get(original.statusUrl)).body.state,'failed')); assert.equal(calls,1);
  for(const provider of ['openai','claude-cli','codex-cli'])await api.post(`/api/jobs/${original.jobId}/retry`).send({provider}).expect(400);
  const beforeRetry=openDatabase(databasePath); assert.equal(beforeRetry.prepare('SELECT COUNT(*) AS count FROM capture_jobs WHERE capture_id=?').get(original.captureId).count,1); beforeRetry.close();
  const retry=(await api.post(`/api/jobs/${original.jobId}/retry`).send({}).expect(202)).body; assert.equal(retry.captureId,original.captureId); assert.notEqual(retry.jobId,original.jobId);
  const completed=await eventually(async()=>{const result=await api.get(retry.statusUrl);assert.equal(result.body.state,'succeeded');return result.body;});
  assert.equal(completed.retryOfId,original.jobId); assert.equal(calls,2); await app.captureJobWorker.stop();
  const afterRetry=openDatabase(databasePath); assert.equal(afterRetry.prepare('SELECT selected_provider FROM capture_jobs WHERE id=?').get(retry.jobId).selected_provider,'fallback'); afterRetry.close();
});

test('async idempotency returns one job and rejects incompatible or unsafe requests',async()=>{
  const { app, api }=fixture({status:async()=>({selectedProvider:'fallback'}),classify:async raw=>classification(raw),answer:async()=>({})});
  const headers={Prefer:'respond-async','Idempotency-Key':'capture-key-0001'};
  const first=(await api.post('/api/captures').set(headers).send({raw:'Одна заявка'}).expect(202)).body;
  const repeated=(await api.post('/api/captures').set(headers).send({raw:'Одна заявка'}).expect(202)).body;
  assert.deepEqual(repeated,first); await api.post('/api/captures').set(headers).send({raw:'Другая заявка'}).expect(409);
  await api.post('/api/captures').set('Prefer','respond-async').set('Idempotency-Key','bad key').send({raw:'x'}).expect(400);
  await api.get('/api/jobs/not-an-id').expect(400); await api.post('/api/jobs/not-an-id/cancel').expect(400); await api.post('/api/captures').set('Prefer','respond-async').send({raw:'x',provider:'other'}).expect(400);
  assert.equal((await api.get('/api/export')).body.captures.length,1); await app.captureJobWorker.stop();
});

test('concurrent idempotency requests create one capture, one job and one provider call',async()=>{
  let calls=0; const { app, api, databasePath }=fixture({status:async()=>({selectedProvider:'fallback'}),classify:async raw=>{calls+=1;return classification(raw);},answer:async()=>({})});
  const headers={Prefer:'respond-async','Idempotency-Key':'concurrent-key-0001'};
  const identical=await Promise.all(Array.from({length:6},()=>api.post('/api/captures').set(headers).send({raw:'Одна конкурентная заявка',provider:'fallback'}).expect(202)));
  const jobIds=new Set(identical.map(response=>response.body.jobId)); assert.equal(jobIds.size,1);
  const [duplicate,incompatible]=await Promise.all([api.post('/api/captures').set(headers).send({raw:'Одна конкурентная заявка',provider:'fallback'}),api.post('/api/captures').set(headers).send({raw:'Несовместимая заявка',provider:'fallback'})]);
  assert.equal(duplicate.status,202); assert.equal(incompatible.status,409);
  const db=openDatabase(databasePath); assert.equal(db.prepare('SELECT COUNT(*) AS count FROM captures').get().count,1); assert.equal(db.prepare('SELECT COUNT(*) AS count FROM capture_jobs').get().count,1); db.close();
  app.captureJobWorker.start(); await eventually(()=>assert.equal(calls,1)); await eventually(async()=>assert.equal((await api.get(identical[0].body.statusUrl)).body.state,'succeeded')); assert.equal(calls,1); await app.captureJobWorker.stop();
});

test('bounded shutdown releases a lease when a provider ignores abort and fences its late result',async()=>{
  const blocked=deferred(); let started=false;
  const { app, api }=fixture({status:async()=>({selectedProvider:'fallback'}),classify:async raw=>{started=true;await blocked.promise;return classification(raw);},answer:async()=>({})},{pollMs:5,shutdownGraceMs:25});
  app.captureJobWorker.start(); const queued=(await api.post('/api/captures').set('Prefer','respond-async').send({raw:'Не завершать shutdown'})).body;
  await eventually(()=>assert.equal(started,true)); const startedAt=Date.now(); await app.captureJobWorker.stop(); assert.ok(Date.now()-startedAt<150);
  assert.equal((await api.get(queued.statusUrl)).body.state,'pending'); assert.equal((await api.get('/api/export')).body.interpretations.length,0);
  blocked.resolve(); await new Promise(resolve=>setTimeout(resolve,20)); assert.equal((await api.get(queued.statusUrl)).body.state,'pending'); assert.equal((await api.get('/api/export')).body.interpretations.length,0);
});

test('a stale fenced claim cannot persist after a different owner reclaims the expired lease',async()=>{
  const { app, databasePath }=fixture({status:async()=>({selectedProvider:'fallback'}),classify:async raw=>classification(raw),answer:async()=>({})});
  const db=openDatabase(databasePath); const queued=enqueueCaptureJob(db,{raw:'Защита от устаревшего lease',selectedProvider:'fallback'});
  const firstClaim=claimCaptureJob(db,{owner:'first-owner',leaseToken:'first-token',leaseMs:1}); await new Promise(resolve=>setTimeout(resolve,10));
  const secondClaim=claimCaptureJob(db,{owner:'second-owner',leaseToken:'second-token',leaseMs:1_000}); assert.equal(secondClaim.id,firstClaim.id); assert.ok(secondClaim.lease_fence>firstClaim.lease_fence);
  assert.ok(completeCaptureJob(db,secondClaim,classification('Защита от устаревшего lease'))); assert.equal(completeCaptureJob(db,firstClaim,classification('Защита от устаревшего lease')),null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM interpretations WHERE capture_id=?').get(queued.captureId).count,1); assert.equal(db.prepare('SELECT COUNT(*) AS count FROM projections WHERE capture_id=?').get(queued.captureId).count,1); assert.equal(db.prepare('SELECT state FROM capture_jobs WHERE id=?').get(queued.jobId).state,'succeeded'); db.close(); await app.captureJobWorker.stop();
});

test('pending cancellation retains raw data and prevents a later worker start from classifying it',async()=>{
  let calls=0; const { app, api }=fixture({status:async()=>({selectedProvider:'fallback'}),classify:async raw=>{calls+=1;return classification(raw);},answer:async()=>({})});
  const queued=(await api.post('/api/captures').set('Prefer','respond-async').send({raw:'Отменить до запуска'})).body;
  await api.post(`/api/jobs/${queued.jobId}/cancel`).expect(202); assert.equal((await api.get(queued.statusUrl)).body.state,'cancelled');
  assert.equal((await api.get('/api/export')).body.captures[0].raw,'Отменить до запуска'); app.captureJobWorker.start(); await new Promise(resolve=>setTimeout(resolve,20)); assert.equal(calls,0); await app.captureJobWorker.stop();
});

test('worker honors its bounded concurrency while it renews an active lease',async()=>{
  const first=deferred(), second=deferred(); let calls=0, active=0, maximum=0;
  const { app, api }=fixture({status:async()=>({selectedProvider:'fallback'}),classify:async raw=>{calls+=1;active+=1;maximum=Math.max(maximum,active);await (calls===1?first.promise:second.promise);active-=1;return classification(raw);},answer:async()=>({})},{maxConcurrent:1,pollMs:5,leaseMs:20});
  await api.post('/api/captures').set('Prefer','respond-async').send({raw:'Первая'}); await api.post('/api/captures').set('Prefer','respond-async').send({raw:'Вторая'}); app.captureJobWorker.start();
  await eventually(()=>assert.equal(calls,1)); await new Promise(resolve=>setTimeout(resolve,30)); assert.equal(maximum,1); first.resolve(); await eventually(()=>assert.equal(calls,2)); second.resolve(); await eventually(async()=>assert.equal((await api.get('/api/entries')).body.entries.length,2)); assert.equal(maximum,1); await app.captureJobWorker.stop();
});

test('expired running lease is reclaimed by a bounded worker and migrations include durable tables',async()=>{
  const { app, api, databasePath }=fixture({status:async()=>({selectedProvider:'fallback'}),classify:async raw=>classification(raw),answer:async()=>({})},{leaseMs:5,maxConcurrent:1,pollMs:5});
  const queued=(await api.post('/api/captures').set('Prefer','respond-async').send({raw:'Вернуть после перезапуска'})).body;
  const db=openDatabase(databasePath); const claim=claimCaptureJob(db,{owner:'previous-worker',leaseToken:'previous-token',leaseMs:1}); assert.equal(claim.id,queued.jobId); await new Promise(resolve=>setTimeout(resolve,10));
  app.captureJobWorker.start(); await eventually(async()=>assert.equal((await api.get(queued.statusUrl)).body.state,'succeeded'));
  const tableNames=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('capture_jobs','capture_job_events','ledger_events','daily_briefs','daily_brief_sources') ORDER BY name").all().map(row=>row.name);
  assert.deepEqual(tableNames,['capture_job_events','capture_jobs','daily_brief_sources','daily_briefs','ledger_events']);
  assert.throws(()=>db.prepare('DELETE FROM ledger_events').run(),/append-only/);
  const job=db.prepare('SELECT attempt_count FROM capture_jobs WHERE id=?').get(queued.jobId); assert.equal(job.attempt_count,2); db.close(); await app.captureJobWorker.stop();
});
