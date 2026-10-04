import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { alertmanagerConfig } from './render.mjs';

export function validateRecipients(value) {
  if(!value||!Array.isArray(value.chatIds)||value.chatIds.length>1000||!Number.isInteger(value.activeAdminCount)||!Number.isInteger(value.linkedAdminCount)||value.activeAdminCount<0||value.linkedAdminCount<0||value.linkedAdminCount>value.activeAdminCount)throw new Error('Invalid recipients');
  const chatIds=[...new Set(value.chatIds.map(id=>{
    if(typeof id!=='string'||!/^[0-9]+$/.test(id)||!Number.isSafeInteger(Number(id))||Number(id)<=0)throw new Error('Invalid private chat ID');
    return String(Number(id));
  }))].sort((a,b)=>Number(a)-Number(b));
  if(chatIds.length!==value.linkedAdminCount)throw new Error('Recipient count mismatch');
  return {chatIds,activeAdminCount:value.activeAdminCount,linkedAdminCount:value.linkedAdminCount};
}

export async function atomicWrite(file,contents,mode=0o600) {
  const temporary=file+'.'+crypto.randomUUID();
  try {await fs.writeFile(temporary,contents,{mode});await fs.rename(temporary,file);}
  finally {await fs.rm(temporary,{force:true});}
}

export function createAdministratorSync({settings,configFile,cacheFile,fetchRecipients,reload,now=()=>Date.now(),audit=()=>{}}) {
  let snapshot=null,loaded=false,applied=null;
  const state={lastSuccess:0,activeAdmins:0,linkedAdmins:0,recipients:0,enabled:Number(Boolean(settings.telegramEnabled)),reloadFailed:0};
  async function tick() {
    state.enabled=Number(Boolean(settings.telegramEnabled));
    if(!loaded){
      loaded=true;
      try {const cache=JSON.parse(await fs.readFile(cacheFile,'utf8'));snapshot=validateRecipients(cache);state.lastSuccess=Number(cache.confirmedAt)||0;}
      catch(error){if(error.code!=='ENOENT')audit('recipient_cache_invalid');}
    }
    if(settings.recipientMode==='fixed'){
      const ids=[...new Set(settings.telegramChatIds.map(id=>String(Number(id))))];
      snapshot=validateRecipients({chatIds:ids,activeAdminCount:ids.length,linkedAdminCount:ids.length});
      state.lastSuccess=now()/1000;
    }else{
      try {
        const fresh=validateRecipients(await fetchRecipients());
        const confirmedAt=now()/1000;
        await atomicWrite(cacheFile,JSON.stringify({...fresh,confirmedAt})+'\n');
        snapshot=fresh;state.lastSuccess=confirmedAt;
      }catch {audit('recipient_sync_failed');} // Preserve the last confirmed list during an app/VM outage.
    }
    state.activeAdmins=snapshot?.activeAdminCount||0;state.linkedAdmins=snapshot?.linkedAdminCount||0;
    const ids=settings.telegramEnabled?(snapshot?.chatIds||[]):[];
    const contents=JSON.stringify(alertmanagerConfig({telegramEnabled:settings.telegramEnabled,telegramChatIds:ids}),null,2)+'\n';
    state.recipients=ids.length;
    try {
      if(await fs.readFile(configFile,'utf8').catch(()=>null)!==contents)await atomicWrite(configFile,contents,0o644);
      if(applied!==contents){await reload();applied=contents;}
      state.reloadFailed=0;
    }catch {state.reloadFailed=1;audit('recipient_config_reload_failed');}
    return {...state};
  }
  return {tick,state};
}

export async function readRecipients(url,{token}={}) {
  const parsed=new URL(url);
  if(parsed.protocol!=='http:'||parsed.hostname!=='127.0.0.1'||parsed.pathname!=='/alert-recipients'||parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error('Recipients must use the private loopback endpoint');
  if(typeof token!=='string'||token.length<16)throw new Error('Recipients token required');
  const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5000),redirect:'error'});
  if(!response.ok)throw new Error('Recipients unavailable');
  let bytes=0;const chunks=[];
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>65536){await response.body.cancel().catch(()=>{});throw new Error('Recipients too large');}chunks.push(Buffer.from(chunk));}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const readSettings=async()=>{
    const value=JSON.parse(await fs.readFile('/config/settings.json','utf8'));
    if(typeof value.telegramEnabled!=='boolean'||!['admins','fixed'].includes(value.recipientMode))throw new Error('Invalid settings');
    return value;
  };
  const settings=await readSettings();
  const sync=createAdministratorSync({settings,configFile:'/alertmanager/alertmanager.yaml',cacheFile:'/state/admin-recipients.json',fetchRecipients:async()=>readRecipients(settings.recipientUrl,{token:(await fs.readFile('/run/secrets/admin_recipients_token','utf8')).trim()}),reload:async()=>{
    const password=(await fs.readFile('/run/secrets/web_password','utf8')).trim();
    const response=await fetch('http://127.0.0.1:9093/-/reload',{method:'POST',headers:{Authorization:'Basic '+Buffer.from(`kizuna-monitoring:${password}`).toString('base64')},signal:AbortSignal.timeout(5000)});if(!response.ok)throw new Error('Reload failed');
  },audit:event=>console.warn(JSON.stringify({event}))});
  const server=http.createServer((req,res)=>{
    if(req.method!=='GET'||req.url!=='/metrics'){res.writeHead(404);res.end();return;}
    const names={lastSuccess:'last_success_timestamp_seconds',activeAdmins:'active_admins',linkedAdmins:'linked_admins',recipients:'configured_recipients',enabled:'telegram_enabled',reloadFailed:'reload_failed'};
    res.writeHead(200,{'Content-Type':'text/plain; version=0.0.4','Cache-Control':'no-store'});
    res.end(Object.entries(names).map(([key,name])=>`# TYPE kizuna_admin_sync_${name} gauge\nkizuna_admin_sync_${name} ${sync.state[key]}\n`).join(''));
  });
  server.requestTimeout=5000;server.headersTimeout=3000;server.timeout=5000;server.listen(9102,'127.0.0.1');
  let stopping=false,timer;
  const run=async()=>{
    try {Object.assign(settings,await readSettings());}catch{console.warn('{"event":"recipient_settings_reload_failed"}');}
    try {await sync.tick();}catch{console.warn('{"event":"recipient_sync_unexpected_failure"}');}
    if(!stopping)timer=setTimeout(run,60000);
  };
  await run();
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{stopping=true;clearTimeout(timer);server.close();});
}
