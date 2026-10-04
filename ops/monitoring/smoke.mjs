import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { writeMonitoringConfig } from './render.mjs';
const execute=promisify(execFile),repo=path.resolve(fileURLToPath(new URL('../..',import.meta.url)));
const network=`kizuna-smoke-${process.pid}`,containers=[],volumes=[];
await fs.mkdir(path.join(repo,'tmp'),{recursive:true});
const directory=await fs.mkdtemp(path.join(repo,'tmp/monitoring-smoke-'));
const configVolume=`${network}-config`,dataVolumes=Object.fromEntries(['prometheus','alertmanager','grafana','admin-sync'].map(name=>[name,`${network}-${name}-data`]));
const webPassword='local-web-smoke-password',webAuth='Basic '+Buffer.from('kizuna-monitoring:'+webPassword).toString('base64');
const base='http://127.0.0.1:18380',fixture=`${network}-fixture`;
const docker=async args=>{const result=await execute('docker',args,{maxBuffer:2e6});return (result.stdout+result.stderr).trim();};
async function run(name,image,args,options={}) {
  const container=`${network}-${name}`;
  containers.push(container);
  await docker(['run','-d','--name',container,'--read-only','--cap-drop=ALL','--security-opt=no-new-privileges:true','--memory',options.memory||'128m','--cpus',options.cpu||'0.05',...options.flags||[],...(name==='fixture'?['--network',network,'-p','127.0.0.1:18380:18080']:['--network',`container:${fixture}`]),image,...args]);
  return container;
}
async function until(check,label,timeout=60000) {
  const deadline=Date.now()+timeout;let lastError;
  while(Date.now()<deadline){try{const value=await check();if(value)return value;}catch(error){lastError=error;}await new Promise(resolve=>setTimeout(resolve,1000));}
  throw new Error(`Timeout: ${label}${lastError?' ('+lastError.message+')':''}`);
}
const json=async(url,options)=>{const response=await fetch(base+url,{...options,headers:{Authorization:webAuth,...options?.headers},signal:AbortSignal.timeout(5000)});if(!response.ok)throw new Error(`HTTP ${response.status}: ${url}`);const body=await response.text();return body?JSON.parse(body):null;};
const mount=(from,to,readOnly=true)=>['-v',`${from}:${to}${readOnly?':ro':''}`];
try {
  for(const volume of [configVolume,...Object.values(dataVolumes)]){await docker(['volume','create',volume]);volumes.push(volume);}
  const configDir=path.join(directory,'config'),config=await writeMonitoringConfig(configDir,{telegramEnabled:true});
  config.prometheus.global.scrape_interval='2s';config.prometheus.global.scrape_timeout='1s';config.prometheus.global.evaluation_interval='2s';
  config.prometheus.scrape_configs.find(c=>c.job_name==='grafana').metrics_path='/grafana/metrics';
  config.prometheus.scrape_configs.find(c=>c.job_name==='monitoring-node').static_configs[0].targets=['127.0.0.1:19100'];
  config.prometheus.scrape_configs.find(c=>c.job_name==='kizuna-public').static_configs[0].targets=['http://127.0.0.1:18080/healthz'];
  config.blackbox.modules.https_health.http.fail_if_not_ssl=false;
  for(const name of ['prometheus','blackbox'])await fs.writeFile(path.join(configDir,`${name}.yaml`),JSON.stringify(config[name]));
  await fs.mkdir(path.join(configDir,'secrets'));await fs.writeFile(path.join(configDir,'secrets/telegram_bot_token'),'00000:TEST_TOKEN');
  const hashed=spawnSync('htpasswd',['-niB','kizuna-monitoring'],{input:webPassword+'\n',encoding:'utf8'});assert.equal(hashed.status,0,hashed.stderr);
  await fs.writeFile(path.join(configDir,'web.yaml'),JSON.stringify({basic_auth_users:{'kizuna-monitoring':hashed.stdout.trim().split(':')[1]}}));
  await fs.writeFile(path.join(configDir,'web_password'),webPassword);
  await fs.writeFile(path.join(configDir,'admin_recipients_token'),'local-recipients-test-token');
  await fs.writeFile(path.join(configDir,'grafana.ini'),'[server]\n');
  await fs.copyFile(path.join(configDir,'alertmanager/alertmanager.yaml'),path.join(configDir,'alertmanager.yaml'));
  await fs.copyFile(path.join(configDir,'alertmanager/telegram.tmpl'),path.join(configDir,'telegram.tmpl'));
  await fs.copyFile(path.join(configDir,'secrets/telegram_bot_token'),path.join(configDir,'telegram_bot_token'));
  config.dashboards.providers[0].options.path='/etc/grafana/grafana/dashboards';
  await fs.writeFile(path.join(configDir,'grafana/provisioning/dashboards/kizuna.yaml'),JSON.stringify(config.dashboards));
  await docker(['network','create',network]);
  await run('fixture','node:22.22.1-slim',['node','/repo/ops/monitoring/smoke-fixture.mjs'],{flags:[...mount(repo,'/repo'),...mount(configVolume,'/config',false),...Object.entries(dataVolumes).flatMap(([name,volume])=>mount(volume,`/data-${name}`,false))],memory:'128m',cpu:'0.1'});
  await docker(['cp',configDir+'/.',fixture+':/config']);
  await docker(['exec',fixture,'node','-e',"const fs=require('fs');for(const name of ['prometheus','alertmanager','grafana','admin-sync'])fs.chmodSync('/data-'+name,0o777);fs.chmodSync('/config',0o777);"]);
  // Match installer permissions; only this temporary helper can change metadata.
  await docker(['run','--rm','--network','none','--read-only','--cap-drop=ALL','--cap-add=CHOWN','--cap-add=FOWNER','--memory','64m',...mount(configVolume,'/config',false),'node:22.22.1-slim','node','-e',"const fs=require('fs');for(const name of ['web.yaml','admin_recipients_token','telegram_bot_token']){fs.chmodSync('/config/'+name,0o600);fs.chownSync('/config/'+name,65534,65534);}fs.chmodSync('/config/web_password',0o640);fs.chownSync('/config/web_password',0,65534);"]);
  await run('alertmanager','prom/alertmanager:v0.34.1',['--config.file=/etc/alertmanager/alertmanager.yaml','--web.config.file=/run/secrets/web.yaml','--web.listen-address=127.0.0.1:9093','--cluster.listen-address=','--storage.path=/alertmanager'],{flags:[...mount(configVolume,'/etc/alertmanager'),...mount(configVolume,'/run/secrets'),...mount(dataVolumes.alertmanager,'/alertmanager',false)],memory:'96m'});
  await run('admin-sync','node:22.22.1-slim',['node','/app/admin-sync.mjs'],{flags:['--user','65534:65534',...mount(path.join(repo,'ops/monitoring'),'/app'),...mount(configVolume,'/config'),...mount(configVolume,'/alertmanager',false),...mount(dataVolumes['admin-sync'],'/state',false),...mount(configVolume,'/run/secrets')],memory:'64m'});
  await until(async()=>{const response=await fetch(base+'/admin/metrics');return response.ok&&(await response.text()).includes('kizuna_admin_sync_configured_recipients 2');},'automatic administrator sync');
  await run('node','prom/node-exporter:v1.12.1',['--web.listen-address=127.0.0.1:19100','--collector.disable-defaults','--collector.cpu','--collector.meminfo','--collector.vmstat','--collector.loadavg','--collector.diskstats','--collector.filesystem','--collector.netdev','--collector.stat','--collector.time','--collector.uname','--collector.pressure'],{memory:'64m'});
  await run('blackbox','prom/blackbox-exporter:v0.28.0',['--config.file=/etc/blackbox/blackbox.yaml','--web.config.file=/run/secrets/web.yaml','--web.listen-address=127.0.0.1:9115'],{flags:['--user','65534:65534',...mount(configVolume,'/etc/blackbox'),...mount(configVolume,'/run/secrets')],memory:'64m'});
  await run('prometheus','prom/prometheus:v3.15.0',['--config.file=/etc/prometheus/prometheus.yaml','--web.config.file=/run/secrets/web.yaml','--web.listen-address=127.0.0.1:9090','--storage.tsdb.path=/prometheus','--storage.tsdb.retention.time=7d','--storage.tsdb.retention.size=1GB'],{flags:['-e','GOMEMLIMIT=384MiB',...mount(configVolume,'/etc/prometheus'),...mount(configVolume,'/run/secrets'),...mount(dataVolumes.prometheus,'/prometheus',false)],memory:'512m',cpu:'0.25'});
  await run('grafana','grafana/grafana:13.2.3',[],{flags:['--group-add','65534','--tmpfs','/tmp:size=32m','-e','GF_SERVER_HTTP_ADDR=127.0.0.1','-e','GF_SERVER_HTTP_PORT=3001','-e',`GF_SERVER_ROOT_URL=${base}/grafana/`,'-e','GF_SERVER_SERVE_FROM_SUB_PATH=true','-e','GF_SECURITY_ADMIN_PASSWORD=local-smoke-password','-e','GF_PATHS_PROVISIONING=/etc/grafana/grafana/provisioning','-e','GF_USERS_ALLOW_SIGN_UP=false','-e','GF_ANALYTICS_REPORTING_ENABLED=false','-e','GF_ANALYTICS_CHECK_FOR_UPDATES=false','-e','GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES=false','-e','GF_PLUGINS_PREINSTALL_DISABLED=true','-e','GF_METRICS_ENABLED=true','-e','GF_METRICS_BASIC_AUTH_USERNAME=kizuna-monitoring','-e','GF_METRICS_BASIC_AUTH_PASSWORD__FILE=/run/secrets/web_password','-e','GF_UNIFIED_ALERTING_ENABLED=false','-e','GOMEMLIMIT=256MiB',...mount(configVolume,'/etc/grafana'),...mount(configVolume,'/run/secrets'),...mount(dataVolumes.grafana,'/var/lib/grafana',false)],memory:'512m',cpu:'0.25'});
  await until(async()=>{const targets=(await json('/prometheus/api/v1/targets')).data.activeTargets;if(targets.length!==8||targets.some(t=>t.health!=='up'))throw new Error(JSON.stringify(targets.filter(t=>t.health!=='up').map(t=>({job:t.labels.job,error:t.lastError}))));return true;},'all eight scrape targets');
  const headers={Authorization:'Basic '+Buffer.from('admin:local-smoke-password').toString('base64')};
  await until(async()=>{const items=await json('/grafana/api/search',{headers});return config.dashboardFiles.every(d=>items.some(i=>i.uid===d.uid));},'two provisioned dashboards');
  let queries=0;
  for(const dashboard of config.dashboardFiles){
    const provisioned=await json(`/grafana/api/dashboards/uid/${dashboard.uid}`,{headers});assert.equal(provisioned.dashboard.panels.length,dashboard.panels.length);
    for(const panel of dashboard.panels)for(const target of panel.targets){
      const expr=target.expr.replaceAll('$__rate_interval','1m').replaceAll('$__range','1m');
      const response=await json(`/prometheus/api/v1/query?query=${encodeURIComponent(expr)}`);assert.equal(response.status,'success');queries++;
      const rendered=await json('/grafana/api/ds/query',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({from:String(Date.now()-60000),to:String(Date.now()),queries:[{...target,expr,datasource:{type:'prometheus',uid:'kizuna-prometheus'},intervalMs:2000,maxDataPoints:300}]})});
      const frame=rendered.results[target.refId];assert.ok(!frame.error,`${dashboard.uid}/${panel.title}: ${frame.error}`);
      if(response.data.result.length&&panel.type==='stat')assert.ok(frame.frames?.some(f=>f.schema.fields.some((field,index)=>field.type==='number'&&f.data.values[index].some(Number.isFinite))),`Stat has no data: ${panel.title}`);
    }
  }
  const stats=await docker(['stats','--no-stream','--format','{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}',...containers]);
  // Freeze this verified sync process before modifying the test-only API URL.
  await docker(['pause',`${network}-admin-sync`]);
  // Intercept Telegram locally, reduce notification wait only in this fixture.
  await docker(['exec',fixture,'node','-e',"const fs=require('fs'),file='/config/alertmanager.yaml',am=JSON.parse(fs.readFileSync(file));am.route.group_wait='1s';am.route.group_interval='1s';am.route.routes=[];for(const r of am.receivers)for(const t of r.telegram_configs||[])t.api_url='http://127.0.0.1:18080';fs.writeFileSync(file+'.smoke',JSON.stringify(am));fs.renameSync(file+'.smoke',file);"]);
  await until(async()=>{const response=await fetch(base+'/alertmanager/-/reload',{method:'POST',headers:{Authorization:webAuth},signal:AbortSignal.timeout(5000)});if(!response.ok)throw new Error(`Reload ${response.status}: ${await response.text()}`);return true;},'Alertmanager reload');
  assert.equal((await fetch(base+'/alertmanager/api/v2/alerts')).status,401);
  assert.equal((await fetch(base+'/alertmanager/-/reload',{method:'POST'})).status,401);
  assert.equal((await fetch(base+'/prometheus/api/v1/query?query=up')).status,401);
  assert.equal((await fetch(base+'/grafana/metrics')).status,401);
  const firing={labels:{alertname:'LocalSmoke',severity:'critical',service:'kizuna',instance:'kizuna-vm',category:'application',domain:'smoke'},annotations:{summary:'Локальная проверка',description:'Тестовая заглушка Telegram',dashboard_url:'http://127.0.0.1:3001/d/kizuna-flow'},startsAt:new Date().toISOString(),endsAt:new Date(Date.now()+300000).toISOString()};
  await json('/alertmanager/api/v2/alerts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify([firing])});
  await until(async()=>{const messages=await json('/messages');return ['111','222'].every(id=>messages.some(m=>String(m.chat_id)===id&&m.text.includes('⚠️')));},'individual firing delivery');
  firing.endsAt=new Date(Date.now()-1000).toISOString();await json('/alertmanager/api/v2/alerts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify([firing])});
  await until(async()=>{const messages=await json('/messages');return ['111','222'].every(id=>messages.some(m=>String(m.chat_id)===id&&m.text.includes('✅')));},'individual resolved delivery');
  const browser=await chromium.launch({headless:true});
  try {
    const context=await browser.newContext({extraHTTPHeaders:headers,viewport:{width:1440,height:1100}});
    const page=await context.newPage();
    for(const uid of ['kizuna-flow','kizuna-vm']){
      await page.goto(`${base}/grafana/d/${uid}?from=now-5m&to=now`,{waitUntil:'networkidle'});await page.waitForFunction(title=>document.body.innerText.includes(title),uid==='kizuna-flow'?'API: запросы в секунду':'Uptime VM',{timeout:30000});
      await page.screenshot({path:path.join(directory,`${uid}.png`)});
    }
  }finally{await browser.close();}
  await fs.writeFile(path.join(directory,'result.json'),JSON.stringify({dashboards:2,queries,targets:8,telegramMessages:(await json('/messages')).length,stats},null,2));
  await fs.writeFile(path.join(repo,'tmp/monitoring-smoke-latest.json'),JSON.stringify({directory}));
  console.log(`SUCCESS: 2 дашборда, ${queries} PromQL-запросов, 8 targets, firing/resolved двум личным получателям заглушки.\n${stats}`);
} catch(error) {
  for(const container of containers){const logs=await docker(['logs','--tail','12',container]).catch(()=>null);if(logs)console.error(container+'\n'+logs);}
  throw error;
} finally {
  for(const container of containers.reverse())await docker(['rm','-f',container]).catch(()=>{});
  await docker(['network','rm',network]).catch(()=>{});
  for(const volume of volumes)await docker(['volume','rm',volume]).catch(()=>{});
}
