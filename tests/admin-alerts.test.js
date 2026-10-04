import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { openDatabase, createUser } from '../server/db.js';
import { administratorRecipients, createApplicationMetrics, startMetricsServer } from '../server/metrics.js';
import { createAdministratorSync, validateRecipients, readRecipients } from '../ops/monitoring/admin-sync.mjs';
import { writeMonitoringConfig } from '../ops/monitoring/render.mjs';

async function directory(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'kizuna-admin-alerts-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;
}
const snapshot=ids=>({chatIds:ids,activeAdminCount:ids.length+1,linkedAdminCount:ids.length});
test('only active admins with a linked private Telegram receive alerts; endpoint stays on loopback',async t=>{
  const dir=await directory(t),db=openDatabase(path.join(dir,'app.sqlite'));t.after(()=>db.close());
  for(const [n,role,status,telegramId,chatId] of [[1,'admin','active',11,11],[2,'admin','blocked',22,22],[3,'admin','pending',33,33],[4,'user','active',44,44],[5,'admin','active',55,-10055],[6,'admin','active',66,67],[7,'admin','active',null,null]]) {
    const user=createUser(db,{email:`test${n}@example.test`,passwordHash:'unused',role,status});
    if(telegramId)db.prepare('INSERT INTO telegram_links(user_id,telegram_id,chat_id,linked_at) VALUES(?,?,?,?)').run(user.id,telegramId,chatId,new Date().toISOString());
  }
  assert.deepEqual(administratorRecipients(db),{chatIds:['11'],activeAdminCount:4,linkedAdminCount:1});
  let token='local-recipients-test-token';
  const metrics=createApplicationMetrics({defaultMetrics:false}),listener=startMetricsServer({metrics,port:0,recipientsToken:()=>token,recipients:()=>administratorRecipients(db)});
  t.after(()=>listener.stop());await once(listener.server,'listening');
  const base=`http://127.0.0.1:${listener.server.address().port}`;
  assert.equal(listener.server.address().address,'127.0.0.1');
  assert.equal((await fetch(`${base}/metrics`)).status,401);
  assert.equal((await fetch(`${base}/alert-recipients`)).status,401);
  assert.equal((await fetch(`${base}/alert-recipients`,{headers:{Authorization:'Bearer wrong'}})).status,401);
  assert.deepEqual(await readRecipients(`${base}/alert-recipients`,{token:'local-recipients-test-token'}),administratorRecipients(db));
  assert.equal((await fetch(`${base}/alert-recipients?user=11`)).status,404);
  assert.equal((await fetch(`${base}/alert-recipients`,{method:'POST'})).status,404);
  token='rotated-recipients-test-token';
  await assert.rejects(readRecipients(`${base}/alert-recipients`,{token:'local-recipients-test-token'}));
  assert.deepEqual(await readRecipients(`${base}/alert-recipients`,{token}),administratorRecipients(db));
  token=null;assert.equal((await fetch(`${base}/alert-recipients`)).status,503);
  assert.equal((await metrics.metrics()).includes('chat_id'),false);
  await assert.rejects(readRecipients('http://example.test/alert-recipients'),/loopback/);
});
test('recipient cache survives app outage and monitoring restart; fresh success removes revoked admins',async t=>{
  const dir=await directory(t),configFile=path.join(dir,'alertmanager.yaml'),cacheFile=path.join(dir,'recipients.json');
  let fresh=snapshot(['11','22']),clock=1000000,reloads=0;
  const options={settings:{recipientMode:'admins',telegramEnabled:true},configFile,cacheFile,now:()=>clock,fetchRecipients:async()=>{if(fresh instanceof Error)throw fresh;return fresh;},reload:async()=>{reloads++;}};
  let sync=createAdministratorSync(options);await sync.tick();
  assert.equal(sync.state.recipients,2);assert.equal(reloads,1);
  assert.equal((await fs.stat(cacheFile)).mode&0o777,0o600);
  fresh=new Error('app down');clock+=60000;await sync.tick();
  assert.equal(sync.state.recipients,2);assert.equal(sync.state.lastSuccess,1000);assert.equal(reloads,1);
  sync=createAdministratorSync(options);await sync.tick();assert.equal(sync.state.recipients,2);assert.equal(sync.state.lastSuccess,1000);
  fresh=snapshot(['22']);await sync.tick();
  const config=JSON.parse(await fs.readFile(configFile));assert.deepEqual(config.receivers.find(r=>r.name==='admins').telegram_configs.map(r=>r.chat_id),[22]);
  assert.equal(sync.state.lastSuccess,1060);
  fresh=snapshot([]);await sync.tick();assert.equal(JSON.parse(await fs.readFile(configFile)).route.receiver,'disabled');
});
test('invalid snapshots preserve last known recipients; reload retries; disabling Telegram overrides cached recipients',async t=>{
  const dir=await directory(t);let fresh=snapshot(['11']),failReload=true,reloads=0;
  const options={settings:{recipientMode:'admins',telegramEnabled:true},configFile:path.join(dir,'config.yaml'),cacheFile:path.join(dir,'cache.json'),fetchRecipients:async()=>fresh,reload:async()=>{reloads++;if(failReload)throw new Error('AM unavailable');}};
  const sync=createAdministratorSync(options);await sync.tick();assert.equal(sync.state.reloadFailed,1);
  failReload=false;await sync.tick();assert.equal(reloads,2);assert.equal(sync.state.reloadFailed,0);
  fresh={...snapshot(['22']),linkedAdminCount:2};await sync.tick();assert.equal(sync.state.recipients,1);
  options.settings.telegramEnabled=false;await sync.tick();assert.equal(sync.state.enabled,0);assert.equal(sync.state.recipients,0);
  const disabled=createAdministratorSync({...options,settings:{recipientMode:'admins',telegramEnabled:false}});await disabled.tick();
  assert.equal(disabled.state.recipients,0);assert.equal(JSON.parse(await fs.readFile(options.configFile)).route.receiver,'disabled');
  for(const invalid of [snapshot(['-1001']),snapshot(['0']),snapshot(['1e4']),snapshot([11]),{...snapshot(['11']),activeAdminCount:0}])assert.throws(()=>validateRecipients(invalid));
});
test('default generated settings use automatic admins and leave notification delivery disabled',async t=>{
  const dir=await directory(t);await writeMonitoringConfig(dir,{});
  const settings=JSON.parse(await fs.readFile(path.join(dir,'settings.json')));
  assert.equal(settings.recipientMode,'admins');assert.equal(settings.telegramEnabled,false);
  assert.equal(settings.recipientUrl,'http://127.0.0.1:19108/alert-recipients');
  assert.equal(JSON.parse(await fs.readFile(path.join(dir,'alertmanager/alertmanager.yaml'))).route.receiver,'disabled');
  assert.ok(await fs.stat(path.join(dir,'alertmanager/telegram.tmpl')));
});
