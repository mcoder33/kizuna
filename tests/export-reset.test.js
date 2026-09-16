import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../server/index.js';import { fakeModelService, fakeModelClassification } from './helpers/fake-model.js';import { authed } from './helpers/auth.js';
import { openDatabase } from '../server/db.js';


function fixture(options={}) { const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pagent-export-')); const databasePath=path.join(directory,'test.sqlite'); const app=createApp({aiService:fakeModelService(),databasePath,...options}); return { app, api:authed(app), databasePath }; }
// Завтрашний день в таймзоне приложения, а не в UTC: с полуночи до 4 утра по
// Самаре UTC-дата отстаёт на сутки, и «завтра по UTC» оказывалось сегодняшним
// днём — запись переставала быть «вчерашней» для отчёта, и тест падал.
function nextDate(timeZone='Europe/Samara') {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const value=type=>Number(parts.find(part=>part.type===type).value);
  const day=new Date(Date.UTC(value('year'),value('month')-1,value('day')));
  day.setUTCDate(day.getUTCDate()+1);
  return day.toISOString().slice(0,10);
}
function tableCount(db, table) { return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count; }

test('legacy nullable ledger relations migrate without changing historical provenance', () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pagent-provenance-migration-')); const databasePath=path.join(directory,'legacy.sqlite'); const legacy=new Database(databasePath); const captureId=crypto.randomUUID(),interpretationId=crypto.randomUUID(),projectionId=crypto.randomUUID(),eventId=crypto.randomUUID(),briefId=crypto.randomUUID(),sourceId=crypto.randomUUID(),createdAt='2026-08-20T00:00:00.000Z';
  legacy.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE captures (id TEXT PRIMARY KEY, raw TEXT NOT NULL, modality TEXT NOT NULL, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL, privacy_scope TEXT NOT NULL, deleted_at TEXT);
    CREATE TABLE interpretations (id TEXT PRIMARY KEY, capture_id TEXT NOT NULL REFERENCES captures(id), version INTEGER NOT NULL, status TEXT NOT NULL, provider TEXT NOT NULL, model TEXT, classification_json TEXT NOT NULL, field_confidence_json TEXT NOT NULL, created_at TEXT NOT NULL, supersedes_id TEXT REFERENCES interpretations(id));
    CREATE TABLE projections (id TEXT PRIMARY KEY, capture_id TEXT NOT NULL REFERENCES captures(id), interpretation_id TEXT NOT NULL REFERENCES interpretations(id), projection_type TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL, undo_group_id TEXT NOT NULL, created_at TEXT NOT NULL, reverted_at TEXT);
    CREATE TABLE capture_jobs (id TEXT PRIMARY KEY, capture_id TEXT NOT NULL REFERENCES captures(id), selected_provider TEXT NOT NULL, state TEXT NOT NULL, stage TEXT NOT NULL, retryable INTEGER NOT NULL, retry_of_id TEXT REFERENCES capture_jobs(id), idempotency_key TEXT, request_fingerprint TEXT, lease_owner TEXT, lease_token TEXT, lease_fence INTEGER NOT NULL, lease_expires_at TEXT, attempt_count INTEGER NOT NULL, error_code TEXT, used_provider TEXT, model TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, cancelled_at TEXT);
    CREATE TABLE ledger_events (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, capture_id TEXT REFERENCES captures(id) ON DELETE SET NULL, job_id TEXT REFERENCES capture_jobs(id) ON DELETE SET NULL, projection_id TEXT REFERENCES projections(id) ON DELETE SET NULL, interpretation_id TEXT REFERENCES interpretations(id) ON DELETE SET NULL, actor TEXT, occurred_at TEXT, created_at TEXT NOT NULL);
    CREATE TABLE daily_briefs (id TEXT PRIMARY KEY, brief_date TEXT NOT NULL, time_zone TEXT NOT NULL, revision INTEGER NOT NULL, generated_at TEXT NOT NULL, content_json TEXT NOT NULL, effective_fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(brief_date,time_zone,revision),UNIQUE(brief_date,time_zone,effective_fingerprint));
    CREATE TABLE daily_brief_sources (id TEXT PRIMARY KEY, daily_brief_id TEXT NOT NULL REFERENCES daily_briefs(id), section_key TEXT NOT NULL, item_key TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT NOT NULL, capture_id TEXT REFERENCES captures(id), projection_id TEXT REFERENCES projections(id), interpretation_id TEXT REFERENCES interpretations(id), ledger_event_id TEXT REFERENCES ledger_events(id), created_at TEXT NOT NULL, UNIQUE(daily_brief_id,section_key,item_key,source_type,source_id));`);
  legacy.prepare('INSERT INTO captures VALUES(?,?,?,?,?,?,NULL)').run(captureId,'legacy raw','text',createdAt,createdAt,'private'); legacy.prepare('INSERT INTO interpretations VALUES(?,?,?,?,?,?,?,?,?,NULL)').run(interpretationId,captureId,1,'active','fallback',null,'{}','{}',createdAt); legacy.prepare('INSERT INTO projections VALUES(?,?,?,?,?,?,?,?,NULL)').run(projectionId,captureId,interpretationId,'task','{}','active',crypto.randomUUID(),createdAt); legacy.prepare('INSERT INTO ledger_events VALUES(?,?,?,?,?,?,?,?,?)').run(eventId,'completed',captureId,null,projectionId,interpretationId,'user',createdAt,createdAt); legacy.prepare('INSERT INTO daily_briefs VALUES(?,?,?,?,?,?,?,?)').run(briefId,'2026-08-20','Europe/Samara',1,createdAt,'{}','legacy-brief',createdAt); legacy.prepare('INSERT INTO daily_brief_sources VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(sourceId,briefId,'doneYesterday','item','ledger_event',eventId,captureId,projectionId,interpretationId,eventId,createdAt); legacy.close();
  const upgraded=openDatabase(databasePath); const ledgerSql=upgraded.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ledger_events'").get().sql; assert.equal(/ON DELETE SET NULL/i.test(ledgerSql),false); assert.deepEqual(upgraded.prepare('SELECT capture_id,projection_id,interpretation_id FROM ledger_events WHERE id=?').get(eventId),{capture_id:captureId,projection_id:projectionId,interpretation_id:interpretationId}); assert.deepEqual(upgraded.prepare('SELECT capture_id,projection_id,interpretation_id,ledger_event_id FROM daily_brief_sources WHERE id=?').get(sourceId),{capture_id:captureId,projection_id:projectionId,interpretation_id:interpretationId,ledger_event_id:eventId}); assert.deepEqual(upgraded.prepare('PRAGMA foreign_key_check').all(),[]); upgraded.close();
});

test('versioned export includes lifecycle provenance without operational process data', async () => {
  const { app, api }=fixture();
  const created=(await api.post('/api/captures').send({raw:'Нужно проверить экспорт'}).expect(201)).body.entry;
  await api.post(`/api/captures/${created.id}/corrections`).set('Idempotency-Key','export-correction-0001').send({patch:{project:'Hub'}}).expect(200);
  const active=(await api.get('/api/entries').expect(200)).body.entries.find(entry=>entry.id===created.id);
  await api.post(`/api/projections/${active.projections.find(projection=>projection.type==='task').id}/complete`).send({}).expect(200);
  await api.get(`/api/daily-brief?date=${nextDate()}`).expect(200);
  const queued=(await api.post('/api/captures').set('Prefer','respond-async').send({raw:'Отменённая локальная запись'}).expect(202)).body;
  await api.post(`/api/jobs/${queued.jobId}/cancel`).expect(202);
  const exported=(await api.get('/api/export').expect(200)).body;
  assert.equal(exported.schemaVersion,3); assert.equal(exported.dataClassification,'local-personal-data');
  for(const section of ['captures','interpretations','corrections','projections','captureJobs','captureJobEvents','ledgerEvents','dailyBriefs','dailyBriefSources'])assert.ok(Array.isArray(exported[section]),section);
  assert.ok(exported.captureJobs.some(job=>job.id===queued.jobId&&job.state==='cancelled'));
  assert.ok(exported.ledgerEvents.some(event=>event.capture_id===created.id&&event.projection_id));
  assert.ok(exported.dailyBriefSources.some(source=>source.capture_id===created.id));
  const serialized=JSON.stringify(exported);
  for(const forbidden of ['"prompt"','"stdout"','"stderr"','"lease_token"','"lease_owner"','"request_fingerprint"','"idempotency_key"','"model"'])assert.equal(serialized.includes(forbidden),false,forbidden);
  await app.captureJobWorker.stop();
});

test('cancel preserves raw until confirmed reset deletes the complete local lifecycle atomically', async () => {
  const { app, api, databasePath }=fixture();
  const queued=(await api.post('/api/captures').set('Prefer','respond-async').send({raw:'Сохранить до явного сброса'}).expect(202)).body;
  await api.post(`/api/jobs/${queued.jobId}/cancel`).expect(202);
  assert.equal((await api.get('/api/export').expect(200)).body.captures[0].raw,'Сохранить до явного сброса');
  await api.get(`/api/daily-brief?date=${nextDate()}`).expect(200);
  await api.post('/api/reset').send({confirmation:'СБРОСИТЬ КИЗУНА'}).expect(200);
  const db=openDatabase(databasePath);
  for(const table of ['captures','interpretations','corrections','projections','capture_jobs','capture_job_events','ledger_events','daily_briefs','daily_brief_sources'])assert.equal(tableCount(db,table),0,table);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]); db.close(); await app.captureJobWorker.stop();
});

test('failed reset rolls back all lifecycle rows and keeps provenance intact', async () => {
  const { app, api, databasePath }=fixture();
  const created=(await api.post('/api/captures').send({raw:'Нужно сохранить историю'}).expect(201)).body.entry;
  const projection=created.projections.find(item=>item.type==='task'); await api.post(`/api/projections/${projection.id}/complete`).send({}).expect(200);
  await api.get(`/api/daily-brief?date=${nextDate()}`).expect(200);
  const db=openDatabase(databasePath); const before=['captures','ledger_events','daily_briefs','daily_brief_sources'].map(table=>[table,tableCount(db,table)]);
  db.exec("CREATE TRIGGER reset_failure BEFORE DELETE ON captures BEGIN SELECT RAISE(ABORT, 'forced reset failure'); END;"); db.close();
  await api.post('/api/reset').send({confirmation:'СБРОСИТЬ КИЗУНА'}).expect(500);
  const after=openDatabase(databasePath); for(const [table,count] of before)assert.equal(tableCount(after,table),count,table); assert.deepEqual(after.prepare('PRAGMA foreign_key_check').all(),[]); after.close(); await app.captureJobWorker.stop();
});

test('correction keeps completed and daily provenance IDs while safe audit omits provider failures', async () => {
  const audits=[];
  let classifyCalls=0; const aiService={status:async()=>({selectedProvider:'fallback'}),classify:async raw=>{classifyCalls+=1;if(classifyCalls===1)return {classification:fakeModelClassification(raw),provider:'fallback',requestedProvider:'fallback',usedProvider:'fallback',fallbackReason:null};throw Object.assign(new Error('Илья stdout /tmp/pagent TOKEN=secret model wrapper'),{code:'unavailable'});},answer:async()=>({})};
  const { app, api, databasePath }=fixture({aiService,audit:event=>audits.push(event),workerOptions:{pollMs:5}});
  const created=(await api.post('/api/captures').send({raw:'Нужно проверить связь источников'}).expect(201)).body.entry;
  const completed=created.projections.find(item=>item.type==='task'); await api.post(`/api/projections/${completed.id}/complete`).send({}).expect(200);
  const brief=(await api.get(`/api/daily-brief?date=${nextDate()}`).expect(200)).body;
  const db=openDatabase(databasePath); const event=db.prepare("SELECT id,capture_id,projection_id,interpretation_id FROM ledger_events WHERE projection_id=? AND event_type='completed'").get(completed.id); const sourceIds=db.prepare('SELECT source_id,capture_id,projection_id,interpretation_id,ledger_event_id FROM daily_brief_sources WHERE daily_brief_id=(SELECT id FROM daily_briefs WHERE brief_date=? ORDER BY revision DESC LIMIT 1)').all(brief.date); db.close();
  await api.post(`/api/captures/${created.id}/corrections`).set('Idempotency-Key','provenance-correction-0001').send({patch:{project:'Новый Hub'}}).expect(200);
  const verified=openDatabase(databasePath); assert.deepEqual(verified.prepare('SELECT capture_id,projection_id,interpretation_id FROM ledger_events WHERE id=?').get(event.id),{capture_id:event.capture_id,projection_id:event.projection_id,interpretation_id:event.interpretation_id}); for(const source of sourceIds)assert.deepEqual(verified.prepare('SELECT capture_id,projection_id,interpretation_id,ledger_event_id FROM daily_brief_sources WHERE source_id=?').get(source.source_id),{capture_id:source.capture_id,projection_id:source.projection_id,interpretation_id:source.interpretation_id,ledger_event_id:source.ledger_event_id}); verified.close();
  app.captureJobWorker.start(); const queued=(await api.post('/api/captures').set('Prefer','respond-async').send({raw:'Проверка безопасного аудита'}).expect(202)).body; await new Promise(resolve=>setTimeout(resolve,40)); await api.get(`/api/jobs/${queued.jobId}`).expect(200); await app.captureJobWorker.stop();
  const serialized=JSON.stringify(audits); for(const forbidden of ['Илья','stdout','/tmp/pagent','TOKEN=secret','model wrapper','Проверка безопасного аудита'])assert.equal(serialized.includes(forbidden),false,forbidden); assert.ok(audits.some(event=>event.event==='capture_job_failed'&&event.errorCode==='unavailable'));
});

test('materialized export rejects oversized datasets without partial output', async () => {
  const { app, api, databasePath }=fixture(); const db=new Database(databasePath); const createdAt='2026-08-20T00:00:00.000Z'; const insert=db.prepare('INSERT INTO captures(id,raw,modality,occurred_at,created_at,privacy_scope,deleted_at,user_id) VALUES(?,?,?,?,?,?,NULL,?)'); const write=db.transaction(()=>{for(let index=0;index<10_001;index+=1)insert.run(crypto.randomUUID(),`row ${index}`,'text',createdAt,createdAt,'private',api.user.id);}); write(); db.close();
  const response=await api.get('/api/export').expect(413); assert.equal(response.body.error.code,'export_limit_exceeded'); assert.equal(response.body.rowLimit,10_000); await app.captureJobWorker.stop();
});
