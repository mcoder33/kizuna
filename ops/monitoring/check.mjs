import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeMonitoringConfig } from './render.mjs';

const directory=await fs.mkdtemp(path.join(os.tmpdir(),'kizuna-monitoring-check-'));
await fs.chmod(directory,0o755); // Linux containers run as nobody, not the runner's UID.
const config=await writeMonitoringConfig(directory,{});
await fs.mkdir(path.join(directory,'secrets'));await fs.writeFile(path.join(directory,'secrets/web_password'),'local-check-password');await fs.writeFile(path.join(directory,'secrets/admin_recipients_token'),'local-recipients-test-token');
const input=(series,values)=>({series,values});
const expected=(name,{instance='kizuna-vm',job}={})=>{const r=config.rules.groups.flatMap(g=>g.rules).find(r=>r.alert===name);return {exp_labels:{...r.labels,instance,...(name==='KizunaHttpErrors'?{}:{job:job||(name==='KizunaPublicUnavailable'?'kizuna-public':name.startsWith('KizunaVm')?'kizuna-node':'kizuna')})},exp_annotations:r.annotations};};
const alert=(name,time,active,labels)=>({eval_time:time,alertname:name,exp_alerts:active?[expected(name,labels)]:[]});
const tests={rule_files:['/etc/prometheus/rules.yaml'],evaluation_interval:'1m',tests:[
  {interval:'1m',input_series:[input('probe_success{job="kizuna-public",instance="kizuna-vm"}','0+0x10')],alert_rule_test:[alert('KizunaPublicUnavailable','1m',false),alert('KizunaPublicUnavailable','3m',true)]},
  {interval:'1m',input_series:[input('kizuna_queue_oldest_pending_seconds{job="kizuna",instance="kizuna-vm"}','120 120 120 120 120 0 0 0')],alert_rule_test:[alert('KizunaQueueStalled','2m',false),alert('KizunaQueueStalled','4m',true),alert('KizunaQueueStalled','6m',false)]},
  {interval:'1m',input_series:[input('node_memory_MemAvailable_bytes{job="kizuna-node",instance="kizuna-vm"}','7+0x10'),input('node_memory_MemTotal_bytes{job="kizuna-node",instance="kizuna-vm"}','100+0x10')],alert_rule_test:[alert('KizunaVmMemoryCritical','1m',false),alert('KizunaVmMemoryCritical','3m',true),alert('KizunaVmMemoryLow','6m',true)]},
  {interval:'1m',input_series:[input('kizuna_http_requests_total{job="kizuna",instance="kizuna-vm",status_class="2xx"}','0+50x20'),input('kizuna_http_requests_total{job="kizuna",instance="kizuna-vm",status_class="5xx"}','0+5x20')],alert_rule_test:[alert('KizunaHttpErrors','6m',true)]},
  {interval:'1m',input_series:[input('kizuna_http_requests_total{job="kizuna",instance="kizuna-vm",status_class="2xx"}','0+0x20'),input('kizuna_http_requests_total{job="kizuna",instance="kizuna-vm",status_class="5xx"}','0 0 0 0 1 1 1 1 1 1 1')],alert_rule_test:[alert('KizunaHttpErrors','6m',false)]},
  {interval:'1m',input_series:[input('node_memory_MemAvailable_bytes{job="monitoring-node",instance="monitoring-vm"}','7+0x10'),input('node_memory_MemTotal_bytes{job="monitoring-node",instance="monitoring-vm"}','100+0x10')],alert_rule_test:[alert('KizunaVmMemoryCritical','3m',true,{instance:'monitoring-vm',job:'monitoring-node'})]},
  {interval:'1m',input_series:[input('kizuna_admin_sync_last_success_timestamp_seconds{job="admin-sync",instance="monitoring-vm"}','0+0x19 1200+60x10')],alert_rule_test:[alert('KizunaAdminRecipientsStale','14m',false),alert('KizunaAdminRecipientsStale','18m',true,{instance:'monitoring-vm',job:'admin-sync'}),alert('KizunaAdminRecipientsStale','21m',false)]},
  {interval:'1m',input_series:[input('kizuna_capture_jobs_total{job="kizuna",instance="kizuna-vm",result="succeeded",provider="fallback"}','0+5x20'),input('kizuna_capture_jobs_total{job="kizuna",instance="kizuna-vm",result="degraded",provider="fallback"}','0+0x20')],alert_rule_test:[alert('KizunaAiDegraded','10m',false)]},
]};
await fs.writeFile(path.join(directory,'rules-test.yaml'),JSON.stringify(tests));
const run=(image,tool,args)=>execFileSync('docker',['run','--rm','--network','none','--entrypoint',tool,'-v',`${directory}:/etc/prometheus:ro`,'-v',`${directory}/alertmanager:/etc/alertmanager:ro`,'-v',`${directory}/secrets:/run/secrets:ro`,image,...args],{stdio:'inherit'});
try {
  run('prom/prometheus:v3.15.0','/bin/promtool',['check','config','/etc/prometheus/prometheus.yaml']);
  run('prom/prometheus:v3.15.0','/bin/promtool',['test','rules','/etc/prometheus/rules-test.yaml']);
  run('prom/alertmanager:v0.34.1','/bin/amtool',['check-config','/etc/alertmanager/alertmanager.yaml']);
  const activeDirectory=path.join(directory,'active');
  const active=await writeMonitoringConfig(activeDirectory,{telegramEnabled:true,telegramChatIds:['12345','67890']});
  await fs.writeFile(path.join(directory,'secrets/telegram_bot_token'),'00000:TEST_TOKEN');
  execFileSync('docker',['run','--rm','--network','none','--entrypoint','/bin/amtool','-v',`${activeDirectory}/alertmanager:/etc/alertmanager:ro`,'-v',`${directory}/secrets:/run/secrets:ro`,'prom/alertmanager:v0.34.1','check-config','/etc/alertmanager/alertmanager.yaml'],{stdio:'inherit'});
  console.log(`${active.rules.groups.flatMap(g=>g.rules).length} правил; 8 сценариев PromQL; Telegram-config валиден без отправки сообщений.`);
} finally {await fs.rm(directory,{recursive:true,force:true});}
