import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../server/index.js';
import { createLogStore, readLogEvents, logConfig } from '../server/log-store.js';
import { contextualAudit, withTrace, span, errorFields, observeDatabase, startRuntimeMonitor } from '../server/observability.js';
import request from './helpers/http.js';
import { authed } from './helpers/auth.js';
import { fakeModelClassification } from './helpers/fake-model.js';
import { openDatabase } from '../server/db.js';
import { pruneDiagnostics } from '../server/diagnostic-retention.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const uuid = () => crypto.randomUUID();
const ai = { status: async () => ({ selectedProvider: 'fallback' }), classify: async raw => ({ classification: fakeModelClassification(raw), provider: 'fallback', usedProvider: 'fallback' }) };
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kizuna-observability-'));
  const events = [], app = createApp({ databasePath: path.join(directory, 'app.sqlite'), aiService: ai, audit: event => events.push(event), ...options });
  t.after(async () => { await app.captureJobWorker.stop(); await app.telegram.stop(); app.accounts.stop(); app.stopTelemetry(); app.database.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { app, api: authed(app), events, directory };
}

test('concurrent async traces remain isolated and error details never contain provider content', async () => {
  const events = [], audit = contextualAudit(event => events.push(event));
  const first = uuid(), second = uuid();
  await Promise.all([withTrace({ flowId: first }, () => span(audit, 'test.one', async () => { await sleep(20); audit({event:'inner',raw:'private',detail:'sk-secret'}); })),
    withTrace({ flowId: second }, () => span(audit, 'test.two', async () => { await sleep(1); throw Object.assign(new Error('sk-secret user text'), {code:'timeout'}); })).catch(() => {})]);
  assert.equal(events.find(e => e.event === 'inner').flowId, first);
  assert.equal(events.find(e => e.event === 'operation_failed').flowId, second);
  assert.equal(JSON.stringify(events).includes('sk-secret'), false);
  assert.equal(JSON.stringify(events).includes('private'), false);
  assert.ok(errorFields(new Error('private')).stackFrames.every(frame => !frame.includes('private')));
});

test('request, durable queue and restarted worker share the flow and actor without raw text', async t => {
  const { app, api, events, directory } = await fixture(t);
  const flowId = uuid(), raw = 'Секретный текст, которого не должно быть в логах';
  const response = await api.post('/api/captures').set('Prefer','respond-async').set('X-Kizuna-Flow-Id',flowId).set('X-Kizuna-Surface','mac_native').send({raw}).expect(202);
  assert.ok(response.headers['x-request-id']);
  const queued = events.find(e => e.event === 'capture_queued');
  assert.equal(queued.flowId,flowId); assert.equal(queued.userId,api.user.id); assert.equal(queued.captureId,response.body.captureId);
  const reopenedEvents = [];
  const reopened = createApp({databasePath:path.join(directory,'app.sqlite'),aiService:ai,audit:e=>reopenedEvents.push(e),workerOptions:{pollMs:5}});
  t.after(async () => { await reopened.captureJobWorker.stop(); reopened.accounts.stop(); reopened.stopTelemetry(); reopened.database.close(); });
  reopened.captureJobWorker.start();
  for (let n=0; n<100 && !reopenedEvents.some(e=>e.event==='capture_job_succeeded'); n++) await sleep(10);
  const started = reopenedEvents.find(e=>e.event==='capture_job_started'), succeeded = reopenedEvents.find(e=>e.event==='capture_job_succeeded');
  assert.ok(succeeded); assert.equal(started.flowId,flowId); assert.equal(succeeded.flowId,flowId); assert.equal(succeeded.userId,api.user.id);
  assert.equal(succeeded.captureId,response.body.captureId); assert.equal(succeeded.jobId,response.body.jobId); assert.ok(started.queueWaitMs>=0); assert.ok(succeeded.totalMs>=0);
  assert.equal(JSON.stringify([...events,...reopenedEvents]).includes(raw),false);
  await api.post(`/api/captures/${response.body.captureId}/corrections`).send({patch:{summary:'Другой приватный текст',project:'Приватный проект'}}).expect(200);
  const corrected=events.find(e=>e.event==='http_request'&&e.route==='/api/captures/:id/corrections');
  assert.deepEqual(corrected.fields,['summary','project']); assert.equal(corrected.captureId,response.body.captureId);
  assert.equal(JSON.stringify(events).includes('Приватный'),false);
});

test('client batches are authenticated, bounded and cannot forge users or log secrets', async t => {
  const { app, api, events } = await fixture(t);
  await request(app).post('/api/telemetry').send({events:[{event:'capture_submit'}]}).expect(401);
  const response = await api.post('/api/telemetry').send({events:[{event:'capture_submit',flowId:uuid(),seq:1,userId:uuid(),raw:'PRIVATE',email:'PRIVATE',errorName:'PRIVATE',route:'/api/PRIVATE',inputChars:12},{event:'not_allowed',body:'PRIVATE'}]}).expect(202);
  assert.deepEqual(response.body,{accepted:1,rejected:1});
  const accepted = events.find(e=>e.event==='capture_submit'); assert.equal(accepted.userId,api.user.id); assert.equal(accepted.inputChars,12);
  assert.equal(JSON.stringify(events).includes('PRIVATE'),false);
  await api.post('/api/telemetry').send({events:Array.from({length:41},()=>({event:'capture_submit'}))}).expect(400);
  for(let n=0;n<7;n++) await api.post('/api/telemetry').send({events:Array.from({length:40},()=>({event:'ui_action',action:'open'}))}).expect(202);
  await api.post('/api/telemetry').send({events:Array.from({length:40},()=>({event:'ui_action',action:'open'}))}).expect(429);
});

test('logging sink failures cannot break capture, and handler failures retain safe stack locations', async t => {
  const { app, api }=await fixture(t,{audit:()=>{throw new Error('sink unavailable');}});
  await api.post('/api/captures').send({raw:'Записать даже без логов'}).expect(201);
  const events=[];
  const second=await fixture(t,{audit:e=>events.push(e),calendarService:{view:()=>{throw new Error('private calendar password');}}});
  await second.api.get('/api/calendar?from=2026-10-04&to=2026-10-05').expect(500);
  assert.ok(events.some(e=>e.event==='http_handler_failed'&&e.stackFrames.length));
  assert.equal(JSON.stringify(events).includes('private calendar password'),false);
  assert.equal(app.database.prepare('SELECT COUNT(*) n FROM captures').get().n,1);
});

test('client error diagnostics retain only fixed codes and omit messages, URLs and stacks', async t => {
  const { api, events } = await fixture(t);
  const codes = ['resize_observer_loop','resource_load','javascript_error','unhandled_rejection'];
  await api.post('/api/telemetry').send({events: codes.map(errorCode => ({
    event: errorCode === 'unhandled_rejection' ? 'client_rejection' : 'client_error',
    errorCode, errorName:'UnknownError', line:0, column:0,
    message:'PRIVATE', filename:'https://PRIVATE', stackFrames:['PRIVATE'],
  })).concat({event:'client_error',errorCode:'PRIVATE',errorName:'PRIVATE'})}).expect(202);
  const errors = events.filter(e => ['client_error','client_rejection'].includes(e.event));
  assert.deepEqual(errors.slice(0,4).map(e => e.errorCode), codes);
  assert.equal(errors[4].errorCode, undefined);
  assert.equal(JSON.stringify(errors).includes('PRIVATE'), false);
});

test('slow SQLite operations and runtime queue health are visible without query text or bindings', async t => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'kizuna-metrics-'));
  const db=openDatabase(path.join(directory,'app.sqlite')); const events=[],audit=contextualAudit(e=>events.push(e));
  t.after(async()=>{db.close();await fs.rm(directory,{recursive:true,force:true});});
  observeDatabase(db,audit,{slowMs:0}); db.prepare('SELECT ? AS private').get('PRIVATE_BINDING');
  assert.ok(events.some(e=>e.event==='database_slow'&&e.queryId)); assert.equal(JSON.stringify(events).includes('PRIVATE_BINDING'),false);
  const monitor=startRuntimeMonitor({audit,db,intervalMs:100000}); monitor.sample(); monitor.stop();
  const metric=events.find(e=>e.event==='runtime_health'); assert.ok(metric.rssBytes>0); assert.equal(metric.pendingJobs,0); assert.equal(metric.expiredLeases,0);
});

test('diagnostic retention caps technical tables, cascades search matches and preserves user facts', async t => {
  const {app,api}=await fixture(t); const db=app.database;
  const captured=(await api.post('/api/captures').send({raw:'Факт должен остаться'}).expect(201)).body.entry;
  const at=new Date(),old=new Date(at.getTime()-100*86400000).toISOString();
  for(let n=0;n<7;n++)db.prepare('INSERT INTO auth_events(id,event,result,created_at) VALUES(?,?,?,?)').run(`audit-${n}`,'login','succeeded',n<2?old:at.toISOString());
  for(let n=0;n<7;n++){
    db.prepare('INSERT INTO entry_search_traces VALUES(?,?,?,?,?,?,?)').run(`trace-${n}`,api.user.id,'private search','found',1,0,n<2?old:at.toISOString());
    db.prepare('INSERT INTO entry_search_trace_matches VALUES(?,?,?,?,?)').run(`trace-${n}`,0,captured.id,'[]',1);
  }
  const result=pruneDiagnostics(db,{at,authRows:3,searchRows:2});assert.deepEqual(result,{auth:4,search:5});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entry_search_trace_matches').get().n,2);
  assert.equal(db.prepare('SELECT raw FROM captures WHERE id=?').get(captured.id).raw,'Факт должен остаться');
  assert.ok(db.prepare('SELECT COUNT(*) n FROM interpretations').get().n>0);
  await request(app).get('/healthz').expect(200);
});

test('rotation remains within the total cap across restart and expires quiet files', async t => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'kizuna-rotation-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const options={directory,maxFileBytes:1024,maxFiles:3,maxEventBytes:512,maxQueueBytes:100000,minFreeBytes:1,diagnostic:()=>{}};
  let store=createLogStore(options);
  for(let n=0;n<80;n++)store.write({event:'rotation_test',count:n,raw:'PRIVATE'});
  await store.close(); store=createLogStore(options);
  for(let n=80;n<100;n++)store.write({event:'rotation_test',count:n});
  await store.flush();
  const names=await fs.readdir(directory),sizes=await Promise.all(names.map(name=>fs.stat(path.join(directory,name)).then(st=>st.size)));
  assert.ok(names.length<=3); assert.ok(sizes.every(size=>size<=1024)); assert.ok(sizes.reduce((a,b)=>a+b,0)<=3072);
  const retained=[]; for await(const event of readLogEvents(directory))retained.push(event);
  assert.equal(retained.at(-1).count,99); assert.equal(JSON.stringify(retained).includes('PRIVATE'),false);
  assert.equal((await fs.stat(directory)).mode&0o777,0o700);
  assert.equal((await fs.stat(path.join(directory,'events.jsonl'))).mode&0o777,0o600);
  const expired=new Date(Date.now()-15*86400000); await fs.utimes(path.join(directory,'events.1.jsonl'),expired,expired);
  await store.maintenance(); assert.equal((await fs.readdir(directory)).includes('events.1.jsonl'),false); await store.close();
  // Lower limits must also clean archives written under an older configuration.
  await fs.writeFile(path.join(directory,'events.1.jsonl'),'x'.repeat(2048));
  await fs.writeFile(path.join(directory,'events.03.jsonl'),'x');
  await fs.chmod(path.join(directory,'events.jsonl'),0o644);
  store=createLogStore(options); await store.maintenance();
  assert.equal((await fs.readdir(directory)).includes('events.1.jsonl'),false);
  assert.equal((await fs.readdir(directory)).includes('events.03.jsonl'),false);
  assert.equal((await fs.stat(path.join(directory,'events.jsonl'))).mode&0o777,0o600); await store.close();
});

test('low disk, queue overload and write errors drop bounded telemetry and recover', async t => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'kizuna-log-failure-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  let space=100;let clock=Date.now();
  const store=createLogStore({directory,minFreeBytes:500,maxQueueBytes:500,now:()=>clock,statfs:async()=>({bavail:space,bsize:1}),diagnostic:()=>{}});
  for(let n=0;n<100;n++)store.write({event:'overload',count:n});await store.flush();
  assert.ok(store.status().droppedEvents>0);assert.equal(store.status().queuedBytes,0);assert.equal(store.status().lowDisk,true);assert.equal((await fs.readdir(directory)).length,0);
  space=100000;clock+=6000;store.write({event:'recovered'});await store.close();
  assert.match(await fs.readFile(path.join(directory,'events.jsonl'),'utf8'),/recovered/);
  const blocked=path.join(directory,'not-a-directory');await fs.writeFile(blocked,'x');
  const broken=createLogStore({directory:blocked,diagnostic:()=>{}});assert.equal(broken.write({event:'test'}),true);await broken.flush();
  assert.equal(broken.status().writeFailures,1);assert.equal(broken.status().queuedBytes,0);await broken.close();
  assert.equal(logConfig({PAGENT_LOG_FILES:'999',PAGENT_LOG_FILE_MIB:'invalid'}).maxFiles,8);
});

test('VM installer rejects unsupported systemd before changes and installs only Kizuna limits', async t => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'kizuna-systemd-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const commands=path.join(directory,'commands');
  await fs.writeFile(path.join(directory,'systemctl'), '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "systemd %s\\n" "$TEST_SYSTEMD_VERSION"; else printf "systemctl %s\\n" "$*" >> "$TEST_COMMAND_LOG"; fi\n', {mode:0o700});
  await fs.writeFile(path.join(directory,'install'), '#!/bin/sh\nprintf "install %s\\n" "$*" >> "$TEST_COMMAND_LOG"\n', {mode:0o700});
  const env={...process.env,PATH:`${directory}:${process.env.PATH}`,TEST_COMMAND_LOG:commands,TEST_SYSTEMD_VERSION:'244'};
  const run=promisify(execFile),script=path.resolve('ops/install-observability.sh');
  await assert.rejects(run('bash',[script],{env}),error=>error.code===1&&error.stderr.includes('systemd >=245'));
  await assert.rejects(fs.access(commands),{code:'ENOENT'});
  await run('bash',[script],{env:{...env,TEST_SYSTEMD_VERSION:'252'}});
  const written=await fs.readFile(commands,'utf8');
  assert.match(written,/install -d -m 0700 -o kizuna -g kizuna \/opt\/kizuna\/data\/logs/);
  assert.match(written,/\/etc\/systemd\/journald@kizuna\.conf\.d\/limits\.conf/);
  assert.match(written,/systemctl daemon-reload/);
  assert.match(written,/systemctl try-restart systemd-journald@kizuna\.service/);
  assert.equal(written.includes('/etc/systemd/journald.conf'),false);
});
