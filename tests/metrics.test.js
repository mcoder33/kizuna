import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { createApplicationMetrics, startMetricsServer, metricsPort, administratorRecipients } from '../server/metrics.js';
import { monitoringConfig } from '../ops/monitoring/render.mjs';

const metric=async(metrics,name)=>(await metrics.registry.getMetricsAsJSON()).find(m=>m.name===`kizuna_${name}`);
test('metrics preserve timings, failure classes and replay semantics without IDs or text',async()=>{
  const m=createApplicationMetrics({defaultMetrics:false}),id=crypto.randomUUID();
  m.observe({event:'http_request',route:'/api/captures/:id/corrections',method:'POST',statusCode:500,result:'failed',durationMs:1500,userId:id,raw:'PRIVATE'});
  m.observe({event:'capture_queued',surface:'mac_native',existing:false});m.observe({event:'capture_queued',surface:'mac_native',existing:true});
  m.observe({event:'capture_job_started',source:'telegram_forward',queueWaitMs:400});
  m.observe({event:'capture_job_succeeded',source:'telegram',provider:'openrouter',usedProvider:'fallback',fallbackReason:'timeout',durationMs:250,totalMs:650});
  m.observe({event:'capture_job_aborted',source:'api',reason:'cancelled',durationMs:20});
  m.observe({event:'operation_failed',operation:'ai.classify',result:'aborted',durationMs:100});
  const requests=await metric(m,'http_requests_total');assert.equal(requests.values[0].value,1);assert.equal(requests.values[0].labels.status_class,'5xx');
  const captures=await metric(m,'captures_total');assert.deepEqual(captures.values.map(v=>v.labels.event),['queued','replayed']);
  const jobs=await metric(m,'capture_jobs_total');assert.deepEqual(jobs.values.map(v=>v.labels.result),['degraded','aborted']);
  assert.equal((await metric(m,'capture_total_duration_seconds')).values.find(v=>v.metricName.endsWith('_sum')).value,.65);
  const text=await m.metrics();assert.equal(text.includes(id),false);assert.equal(text.includes('PRIVATE'),false);
});
test('label budgets bound cardinality and reject URLs, UUID paths and model names',async()=>{
  const m=createApplicationMetrics({defaultMetrics:false});
  for(let n=0;n<300;n++)m.observe({event:'http_request',route:`/api/resource${n}`,method:'GET',statusCode:200,result:'succeeded',durationMs:1});
  const secret=crypto.randomUUID();m.observe({event:'http_request',route:`/api/captures/${secret}`,method:'GET'});
  m.observe({event:'dependency_failed',operation:'https://PRIVATE_TOKEN@example.test/private'});
  m.observe({event:'capture_job_succeeded',provider:'PRIVATE_MODEL'});
  assert.ok((await metric(m,'http_requests_total')).values.length<=130);
  const text=await m.metrics();for(const value of [secret,'PRIVATE_TOKEN','PRIVATE_MODEL','example.test'])assert.equal(text.includes(value),false);
});
test('runtime losses are cumulative once per new loss and export queue/loop gauges in seconds',async()=>{
  const m=createApplicationMetrics({defaultMetrics:false});
  for(const droppedEvents of [3,3,5])m.observe({event:'runtime_health',droppedEvents,writeFailures:1,oldestPendingMs:1500,eventLoopP95Ms:220,lowDisk:true,pendingJobs:7});
  assert.equal((await metric(m,'log_dropped_events_total')).values[0].value,5);assert.equal((await metric(m,'log_write_failures_total')).values[0].value,1);
  assert.equal((await metric(m,'queue_oldest_pending_seconds')).values[0].value,1.5);assert.equal((await metric(m,'runtime_event_loop_p95_seconds')).values[0].value,.22);
  assert.equal((await metric(m,'log_low_disk')).values[0].value,1);
  m.observe({event:'runtime_health',droppedEvents:1,writeFailures:0});assert.equal((await metric(m,'log_dropped_events_total')).values[0].value,6);
});
test('client journey counts only validated client events and separates attempts from visible results',async()=>{
  const m=createApplicationMetrics({defaultMetrics:false});
  m.observe({event:'capture_submit',surface:'web',inputChars:25,durationMs:7000});
  m.observe({event:'capture_submit',source:'client',surface:'web',inputChars:25,durationMs:7000});
  m.observe({event:'capture_result_visible',source:'client',surface:'web',totalMs:500});
  assert.equal((await metric(m,'client_events_total')).values[0].value,1);
  assert.equal((await metric(m,'capture_edit_duration_seconds')).values.find(v=>v.metricName.endsWith('_sum')).value,7);
  assert.equal((await metric(m,'capture_visible_duration_seconds')).values.find(v=>v.metricName.endsWith('_sum')).value,.5);
});
test('metrics listener is loopback-only, exports Prometheus and does not serve other paths',async t=>{
  const metrics=createApplicationMetrics(),listener=startMetricsServer({metrics,port:0,recipientsToken:'local-metrics-test-token'});
  t.after(()=>listener.stop());await once(listener.server,'listening');
  assert.equal(listener.server.address().address,'127.0.0.1');
  const base=`http://127.0.0.1:${listener.server.address().port}`;
  const response=await fetch(`${base}/metrics`,{headers:{Authorization:'Bearer local-metrics-test-token'}});assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/plain/);assert.match(await response.text(),/kizuna_process_resident_memory_bytes/);
  assert.equal((await fetch(`${base}/metrics?token=secret`)).status,404);assert.equal((await fetch(`${base}/`,{method:'POST'})).status,404);
  assert.equal(metricsPort('off'),null);assert.equal(metricsPort('0'),null);assert.equal(metricsPort('65536'),null);assert.equal(metricsPort(undefined),9108);
});
test('monitoring defaults keep Telegram disabled and endpoints private; explicit admins get recoveries',()=>{
  const config=monitoringConfig();assert.equal(config.alertmanager.route.receiver,'disabled');assert.equal(config.alertmanager.receivers.length,1);
  assert.equal(config.prometheus.scrape_configs[0].static_configs[0].targets[0],'127.0.0.1:19108');
  assert.equal(monitoringConfig({mode:'colocated'}).prometheus.scrape_configs[0].static_configs[0].targets[0],'127.0.0.1:9108');
  assert.throws(()=>monitoringConfig({appTarget:'0.0.0.0:9108'}));assert.throws(()=>monitoringConfig({healthUrl:'http://example.test/healthz'}));
  assert.equal(monitoringConfig({telegramEnabled:true}).alertmanager.route.receiver,'disabled');assert.throws(()=>monitoringConfig({telegramEnabled:true,telegramChatIds:['0']}));
  assert.throws(()=>monitoringConfig({telegramChatIds:['-100123']}));
  const active=monitoringConfig({telegramEnabled:true,telegramChatIds:['67890','12345','12345']}).alertmanager;
  const recipients=active.receivers.find(r=>r.name==='admins').telegram_configs;assert.equal(recipients.length,2);assert.ok(recipients.every(r=>r.send_resolved&&r.bot_token_file&&!r.bot_token));
});
