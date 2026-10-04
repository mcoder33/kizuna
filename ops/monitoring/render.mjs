import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { monitoringRules } from './rules.mjs';
import { monitoringDashboards } from './dashboards.mjs';

export function alertmanagerConfig({telegramChatIds=[],telegramEnabled=false}={}) {
  for(const id of telegramChatIds)if(!Number.isSafeInteger(Number(id))||Number(id)<=0||!/^[0-9]+$/.test(String(id)))throw new Error('Для личных уведомлений нужен положительный Telegram ID');
  return {global:{resolve_timeout:'5m'},route:{receiver:telegramEnabled&&telegramChatIds.length?'admins':'disabled',group_by:['service','instance','category','domain','severity'],group_wait:'30s',group_interval:'5m',repeat_interval:'4h',routes:[{matchers:['severity="critical"'],group_wait:'10s',repeat_interval:'1h'}]},
    receivers:[{name:'disabled'},...(telegramEnabled&&telegramChatIds.length?[{name:'admins',telegram_configs:[...new Set(telegramChatIds.map(Number))].map(chat_id=>({bot_token_file:'/run/secrets/telegram_bot_token',chat_id,send_resolved:true,parse_mode:'',message:'{{ template "kizuna.telegram" . }}'}))}]:[])],
    templates:['/etc/alertmanager/telegram.tmpl'],inhibit_rules:[
      {source_matchers:['alertname="KizunaPublicUnavailable"'],target_matchers:['alertname=~"KizunaMetricsUnavailable|KizunaVmMetricsUnavailable|KizunaRuntimeStale|KizunaHttpSlow|KizunaQueueStalled|KizunaExpiredLeases|KizunaEventLoopSlow"'],equal:['service','instance']},
      {source_matchers:['severity="critical"'],target_matchers:['severity="warning"'],equal:['service','instance','category','domain']},
    ]};
}

export function monitoringConfig({mode='external',appTarget,nodeTarget,healthUrl='https://yourkizuna.com/healthz',grafanaUrl='http://127.0.0.1:3001',telegramChatIds=[],telegramEnabled=false}={}) {
  if(!['external','colocated'].includes(mode))throw new Error('mode: external или colocated');
  appTarget ||= mode==='external'?'127.0.0.1:19108':'127.0.0.1:9108';nodeTarget ||= mode==='external'?'127.0.0.1:19100':'127.0.0.1:9100';
  for(const target of [appTarget,nodeTarget])if(!/^127\.0\.0\.1:[0-9]{2,5}$/.test(target)||Number(target.split(':')[1])<1024||Number(target.split(':')[1])>65535)throw new Error('Scrape только через loopback или SSH-туннель на портах 1024-65535');
  const health=new URL(healthUrl),grafana=new URL(grafanaUrl);
  if(health.protocol!=='https:'||health.username||health.password||health.search||health.hash||health.pathname!=='/healthz')throw new Error('health-url: публичный HTTPS /healthz без credentials/query');
  if(!['https:','http:'].includes(grafana.protocol)||grafana.username||grafana.password||grafana.search||grafana.hash)throw new Error('Некорректный grafana-url');
  if(grafana.pathname!=='/')throw new Error('Grafana URL должен быть отдельным origin без подпути');
  if(grafana.protocol==='http:'&&!['127.0.0.1','localhost'].includes(grafana.hostname))throw new Error('Внешняя Grafana требует HTTPS');
  const prometheus={global:{scrape_interval:'30s',scrape_timeout:'10s',evaluation_interval:'30s',external_labels:{service:'kizuna'}},
    rule_files:['/etc/prometheus/rules.yaml'],alerting:{alertmanagers:[{static_configs:[{targets:['127.0.0.1:9093']}]}]},scrape_configs:[
      {job_name:'kizuna',sample_limit:30000,static_configs:[{targets:[appTarget],labels:{instance:'kizuna-vm'}}]},
      {job_name:'kizuna-node',sample_limit:10000,static_configs:[{targets:[nodeTarget],labels:{instance:'kizuna-vm'}}]},
      {job_name:'monitoring-node',sample_limit:10000,static_configs:[{targets:['127.0.0.1:9101'],labels:{instance:'monitoring-vm'}}]},
      {job_name:'kizuna-public',metrics_path:'/probe',params:{module:['https_health']},static_configs:[{targets:[healthUrl]}],relabel_configs:[{source_labels:['__address__'],target_label:'__param_target'},{target_label:'instance',replacement:'kizuna-vm'},{target_label:'__address__',replacement:'127.0.0.1:9115'}]},
      {job_name:'admin-sync',static_configs:[{targets:['127.0.0.1:9102'],labels:{instance:'monitoring-vm'}}]},
      {job_name:'prometheus',static_configs:[{targets:['127.0.0.1:9090']}]},
      {job_name:'grafana',static_configs:[{targets:['127.0.0.1:3001']}]},
      {job_name:'alertmanager',static_configs:[{targets:['127.0.0.1:9093']}]},
    ]};
  const alertmanager=alertmanagerConfig({telegramChatIds,telegramEnabled});
  prometheus.scrape_configs.find(job=>job.job_name==='kizuna').authorization={type:'Bearer',credentials_file:'/run/secrets/admin_recipients_token'};
  const basic_auth={username:'kizuna-monitoring',password_file:'/run/secrets/web_password'};
  for(const job of prometheus.scrape_configs)if(['prometheus','alertmanager','grafana','kizuna-public'].includes(job.job_name))job.basic_auth={...basic_auth};
  prometheus.alerting.alertmanagers[0].basic_auth={...basic_auth};
  const blackbox={modules:{https_health:{prober:'http',timeout:'8s',http:{method:'GET',valid_status_codes:[200],fail_if_not_ssl:true,preferred_ip_protocol:'ip4',ip_protocol_fallback:true,follow_redirects:false,fail_if_body_not_matches_regexp:['"status"\\s*:\\s*"ok"']}}}};
  const datasource={apiVersion:1,prune:true,datasources:[{name:'Kizuna Prometheus',uid:'kizuna-prometheus',type:'prometheus',access:'proxy',url:'http://127.0.0.1:9090',isDefault:true,editable:false,basicAuth:true,basicAuthUser:'kizuna-monitoring',secureJsonData:{basicAuthPassword:'$GF_METRICS_BASIC_AUTH_PASSWORD'},jsonData:{httpMethod:'POST',timeInterval:'30s'}}]};
  const dashboards={apiVersion:1,providers:[{name:'kizuna',orgId:1,folder:'Кизуна',type:'file',disableDeletion:false,allowUiUpdates:false,updateIntervalSeconds:30,options:{path:'/etc/grafana/dashboards'}}]};
  return {prometheus,alertmanager,blackbox,datasource,dashboards,rules:monitoringRules(grafanaUrl.replace(/\/$/,'')),dashboardFiles:monitoringDashboards()};
}
export async function writeMonitoringConfig(directory,options) {
  const config=monitoringConfig(options);
  const write=async(name,value)=>{const file=path.join(directory,name);await fs.mkdir(path.dirname(file),{recursive:true,mode:0o755});const temporary=file+'.'+crypto.randomUUID();await fs.writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o644});await fs.rename(temporary,file);};
  for(const name of ['prometheus','blackbox','rules'])await write(`${name}.yaml`,config[name]);
  await write('alertmanager/alertmanager.yaml',config.alertmanager);
  await write('settings.json',{telegramEnabled:Boolean(options?.telegramEnabled),recipientMode:options?.telegramChatIds?.length?'fixed':'admins',recipientUrl:`http://${config.prometheus.scrape_configs[0].static_configs[0].targets[0]}/alert-recipients`,telegramChatIds:options?.telegramChatIds||[]});
  await write('grafana/provisioning/datasources/kizuna.yaml',config.datasource);await write('grafana/provisioning/dashboards/kizuna.yaml',config.dashboards);
  for(const dashboard of config.dashboardFiles)await write(`grafana/dashboards/${dashboard.uid}.json`,dashboard);
  await fs.copyFile(new URL('./telegram.tmpl',import.meta.url),path.join(directory,'alertmanager/telegram.tmpl'));
  return config;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),option=name=>{const n=args.indexOf(`--${name}`);return n<0?undefined:args[n+1];};
  const telegramChatIds=args.flatMap((value,index)=>value==='--telegram-chat-id'?[args[index+1]]:[]);
  if(!option('output'))throw new Error('Укажите --output DIR; mode по умолчанию external; Telegram выключен без --enable-telegram');
  await writeMonitoringConfig(option('output'),{mode:option('mode'),appTarget:option('app-target'),nodeTarget:option('node-target'),healthUrl:option('health-url'),grafanaUrl:option('grafana-url'),telegramChatIds,telegramEnabled:args.includes('--enable-telegram')});
  console.log('Конфигурация и два дашборда созданы. Telegram: '+(args.includes('--enable-telegram')?'включён, получатели синхронизируются из активных администраторов':'выключен'));
}
