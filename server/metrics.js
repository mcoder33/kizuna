import http from 'node:http';
import crypto from 'node:crypto';
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from '@prometheus-io/client';
import { CLIENT_EVENTS } from './client-events.js';
import { errorFields } from './observability.js';

const seconds = value => Number.isFinite(value) && value >= 0 ? value / 1000 : null;
const providers = new Set(['fallback','openrouter','openai','codex-cli','claude-cli','gemini']);
const provider = value => providers.has(value) ? value : 'other';
const surface = value => ['web','mac_webview','mac_native'].includes(value) ? value : 'other';
const source = event => String(event.source || event.surface || '').startsWith('telegram') ? 'telegram' : surface(event.surface || event.source) !== 'other' ? surface(event.surface || event.source) : 'api';
const result = value => ['succeeded','failed','aborted','degraded'].includes(value) ? value : 'other';
const statusClass = value => Number.isInteger(value) && value >= 100 && value < 600 ? `${Math.floor(value / 100)}xx` : 'none';
const buckets = [.01,.05,.1,.25,.5,1,2,5,10,30,60,120];

// No IDs, text, model names, URLs, query strings or exception messages become
// labels. Each dynamic server label has a fixed cardinality budget as well.
export function createApplicationMetrics({ defaultMetrics = true } = {}) {
  const registry = new Registry(); registry.setDefaultLabels({service:'kizuna'});
  if (defaultMetrics) collectDefaultMetrics({ register:registry, prefix:'kizuna_', eventLoopMonitoringPrecision:20 });
  const counter = (name, help, labelNames=[]) => new Counter({name:`kizuna_${name}`,help,labelNames,registers:[registry]});
  const histogram = (name, help, labelNames=[], limits=buckets) => new Histogram({name:`kizuna_${name}`,help,labelNames,buckets:limits,registers:[registry]});
  const httpRequests=counter('http_requests_total','Finished API requests',['method','route','status_class','result']);
  const httpDuration=histogram('http_request_duration_seconds','API response time',['method','route']);
  const operations=counter('operations_total','Completed service operations',['operation','result']);
  const operationDuration=histogram('operation_duration_seconds','Service operation time',['operation']);
  const dependencies=counter('dependency_requests_total','External dependency requests',['dependency','result','status_class']);
  const dependencyDuration=histogram('dependency_request_duration_seconds','External HTTP response headers time',['dependency']);
  const captures=counter('captures_total','Accepted new captures and idempotent replays',['source','event']);
  const jobs=counter('capture_jobs_total','Terminal capture processing attempts',['source','result','provider']);
  const queueWait=histogram('capture_queue_wait_seconds','Time from enqueue to processing',['source']);
  const jobDuration=histogram('capture_job_duration_seconds','Capture processing time',['source']);
  const totalDuration=histogram('capture_total_duration_seconds','Enqueue to completed classification',['source']);
  const clientEvents=counter('client_events_total','Received client events, not unique users or flows',['surface','event']);
  const inputLength=histogram('capture_input_characters','Characters at submission',['surface'],[0,20,50,100,200,500,1000,3000,10000]);
  const editDuration=histogram('capture_edit_duration_seconds','Draft editing time at submission',['surface'],[1,5,10,30,60,120,300,600,1800]);
  const visibleDuration=histogram('capture_visible_duration_seconds','Submission to visible result',['surface']);
  const backgroundFailures=counter('background_failures_total','Diagnostic background failure events, not distinct incidents',['component']);
  const logDropped=counter('log_dropped_events_total','Events dropped by the JSONL writer');
  const logFailures=counter('log_write_failures_total','Failed JSONL writer batches');
  const observerErrors=counter('metrics_observer_errors_total','Unexpected metric observation failures');
  const runtimeFields={pendingJobs:'queue_pending_jobs',runningJobs:'queue_running_jobs',expiredLeases:'queue_expired_leases',oldestPendingMs:'queue_oldest_pending_seconds',
    eventLoopP95Ms:'runtime_event_loop_p95_seconds',eventLoopMaxMs:'runtime_event_loop_max_seconds',eventLoopUtilization:'runtime_event_loop_utilization',
    freeBytes:'log_filesystem_free_bytes',logBytes:'log_storage_bytes',queuedBytes:'log_queue_bytes',lowDisk:'log_low_disk'};
  const gauges=Object.fromEntries(Object.entries(runtimeFields).map(([field,name])=>[field,new Gauge({name:`kizuna_${name}`,help:name,registers:[registry]})]));
  const runtimeSample=new Gauge({name:'kizuna_runtime_sample_timestamp_seconds',help:'Latest completed runtime sample',registers:[registry]});
  let dropped=0,writeFailures=0;
  const labelSets=new Map();
  const bounded=(kind,value,limit=128)=>{
    if(typeof value!=='string'||!value||value.length>120)return 'other';
    if(kind==='route' && !/^\/api\/[A-Za-z0-9:/_-]+$/.test(value) && value!=='unmatched')return 'other';
    if(kind==='route' && /[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value))return 'other';
    if(kind==='operation' && !/^[a-z_]+\.[A-Za-z]+$/.test(value))return 'other';
    if(kind==='dependency' && !['ai','calendar','telegram','report_image'].includes(value))return 'other';
    if(!labelSets.has(kind))labelSets.set(kind,new Set());
    const values=labelSets.get(kind); if(values.has(value))return value;
    if(values.size>=limit)return 'other'; values.add(value); return value;
  };
  const observeDuration=(metric,labels,value)=>{const duration=seconds(value);if(duration!==null)metric.observe(labels,duration);};
  function observe(event) {
    try {
      if(event.event==='http_request'){
        const labels={method:['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(event.method)?event.method:'other',route:bounded('route',event.route)};
        httpRequests.inc({...labels,status_class:statusClass(event.statusCode),result:result(event.result)}); observeDuration(httpDuration,labels,event.durationMs);
      }
      if(['operation_finished','operation_failed'].includes(event.event)){
        const labels={operation:bounded('operation',event.operation)};
        operations.inc({...labels,result:result(event.result)});observeDuration(operationDuration,labels,event.durationMs);
      }
      if(['dependency_response','dependency_failed'].includes(event.event)){
        const labels={dependency:bounded('dependency',event.operation,16)};
        dependencies.inc({...labels,result:result(event.result || 'failed'),status_class:statusClass(event.statusCode)});observeDuration(dependencyDuration,labels,event.durationMs);
      }
      const origin=source(event);
      if(event.event==='capture_queued')captures.inc({source:origin,event:event.existing?'replayed':'queued'});
      if(event.event==='capture_retry_queued')captures.inc({source:origin,event:'retry'});
      if(event.event==='capture_job_started')observeDuration(queueWait,{source:origin},event.queueWaitMs);
      if(['capture_job_succeeded','capture_job_failed','capture_job_aborted'].includes(event.event)){
        jobs.inc({source:origin,provider:provider(event.usedProvider || event.provider),result:event.event==='capture_job_succeeded'?(event.fallbackReason?'degraded':'succeeded'):event.event==='capture_job_failed'?'failed':'aborted'});
        observeDuration(jobDuration,{source:origin},event.durationMs);observeDuration(totalDuration,{source:origin},event.totalMs);
      }
      if(event.source==='client'&&CLIENT_EVENTS.has(event.event)){
        const labels={surface:surface(event.surface)};clientEvents.inc({...labels,event:event.event});
        if(['capture_submit','native_submit'].includes(event.event)){
          if(Number.isFinite(event.inputChars)&&event.inputChars>=0)inputLength.observe(labels,event.inputChars);
          observeDuration(editDuration,labels,event.durationMs);
        }
        if(event.event==='capture_result_visible')observeDuration(visibleDuration,labels,event.totalMs);
      }
      if(/_failed$|_missed$|_lost$|_fatal$/.test(event.event||'')&&!['http_request','operation_failed','dependency_failed','capture_submit_failed','client_request_failed'].includes(event.event)){
        const prefix=String(event.event).split('_')[0];const component=['capture','telegram','calendar','notification','digest','reminder','push','auth','diagnostics','database','service','runtime'].includes(prefix)?prefix:'other';
        backgroundFailures.inc({component});
      }
      if(event.event==='runtime_health'){
        for(const [field,metric]of Object.entries(gauges)){
          const value=field==='lowDisk'?Number(Boolean(event[field])):event[field];
          if(Number.isFinite(value)&&value>=0)metric.set(field.endsWith('Ms')?value/1000:value);
        }
        if(Number.isFinite(event.droppedEvents)){logDropped.inc(Math.max(0,event.droppedEvents>=dropped?event.droppedEvents-dropped:event.droppedEvents));dropped=event.droppedEvents;}
        if(Number.isFinite(event.writeFailures)){logFailures.inc(Math.max(0,event.writeFailures>=writeFailures?event.writeFailures-writeFailures:event.writeFailures));writeFailures=event.writeFailures;}
        runtimeSample.set(Date.now()/1000);
      }
    } catch { observerErrors.inc(); }
  }
  return {observe,registry,metrics:()=>registry.metrics(),contentType:registry.contentType};
}

// Telegram identifiers stay out of public APIs, logs and Prometheus labels.
export function administratorRecipients(db) {
  const admins=db.prepare("SELECT u.id, t.telegram_id, t.chat_id FROM users u LEFT JOIN telegram_links t ON t.user_id=u.id WHERE u.role='admin' AND u.status='active'").all();
  const linked=admins.filter(row=>Number.isSafeInteger(row.chat_id)&&row.chat_id>0&&row.chat_id===row.telegram_id);
  return {chatIds:[...new Set(linked.map(row=>String(row.chat_id)))],activeAdminCount:admins.length,linkedAdminCount:linked.length};
}

export function startMetricsServer({metrics,port=9108,audit=()=>{},recipients,recipientsToken}) {
  const server=http.createServer(async(req,res)=>{
    if(req.method==='GET'&&req.url==='/alert-recipients'&&recipients){
      let token;
      try {token=typeof recipientsToken==='function'?recipientsToken():recipientsToken;}catch{}
      if(typeof token!=='string'||token.length<16){res.writeHead(503);res.end();return;}
      const supplied=Buffer.from(req.headers.authorization||''),expected=Buffer.from(`Bearer ${token}`);
      if(supplied.length!==expected.length||!crypto.timingSafeEqual(supplied,expected)){res.writeHead(401,{'WWW-Authenticate':'Bearer'});res.end();return;}
      try {res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(await recipients()));}
      catch {res.writeHead(503);res.end();}
      return;
    }
    if(req.method!=='GET'||req.url!=='/metrics'){res.writeHead(404);res.end();return;}
    try {res.writeHead(200,{'Content-Type':metrics.contentType,'Cache-Control':'no-store'});res.end(await metrics.metrics());}
    catch(error){audit({event:'metrics_scrape_failed',...errorFields(error)});res.destroy();}
  });
  server.requestTimeout=5000;server.headersTimeout=3000;server.timeout=5000;
  server.on('error',error=>audit({event:'metrics_listener_failed',...errorFields(error)}));
  // Exported only to local collectors or an explicitly configured SSH tunnel.
  server.listen(port,'127.0.0.1');
  return {server,stop:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();})};
}

export function metricsPort(value) {
  if(value==='off')return null;
  const port=value===undefined?9108:Number(value);
  return Number.isInteger(port)&&port>=1024&&port<=65535?port:null;
}
