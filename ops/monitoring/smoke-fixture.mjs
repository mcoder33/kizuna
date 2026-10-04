// Local Docker smoke only. No real Telegram or public Internet requests.
import http from 'node:http';
import { createApplicationMetrics, startMetricsServer } from '../../server/metrics.js';
const metrics=createApplicationMetrics(),messages=[];
startMetricsServer({metrics,port:19108,recipientsToken:'local-recipients-test-token',recipients:()=>({chatIds:['111','222'],activeAdminCount:2,linkedAdminCount:2})});
setInterval(()=>{
  metrics.observe({event:'runtime_health',pendingJobs:0,runningJobs:0,expiredLeases:0,oldestPendingMs:0,eventLoopP95Ms:3,eventLoopMaxMs:6,eventLoopUtilization:.03,freeBytes:10e9,logBytes:1e6,queuedBytes:0,lowDisk:false,droppedEvents:0,writeFailures:0});
  metrics.observe({event:'http_request',method:'POST',route:'/api/captures',statusCode:202,result:'succeeded',durationMs:25});
  metrics.observe({event:'capture_queued',surface:'web'});metrics.observe({event:'capture_job_started',surface:'web',queueWaitMs:50});
  metrics.observe({event:'capture_job_succeeded',surface:'web',provider:'openrouter',durationMs:400,totalMs:450});
  metrics.observe({event:'operation_finished',operation:'ai.classify',result:'succeeded',durationMs:350});
  metrics.observe({event:'dependency_response',operation:'ai',result:'succeeded',statusCode:200,durationMs:300});
  for(const event of ['capture_focused','capture_submit','capture_accepted','capture_result_visible'])metrics.observe({event,source:'client',surface:'web',inputChars:50,durationMs:6000,totalMs:500});
},1000);
http.createServer(async(req,res)=>{
  if(req.url==='/messages'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(messages));return;}
  if(req.url==='/healthz'){res.setHeader('Content-Type','application/json');res.end('{"status":"ok"}');return;}
  if(req.url.startsWith('/bot00000:TEST_TOKEN/sendMessage')){
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=Buffer.concat(chunks).toString();let message;
    try {message=JSON.parse(body);}catch{message=Object.fromEntries(new URLSearchParams(body));}
    messages.push(message);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,result:{message_id:messages.length,chat:{id:Number(message.chat_id),type:'private'},date:Math.floor(Date.now()/1000),text:message.text}}));return;
  }
  const prefix=req.url.split('/')[1],ports={prometheus:9090,alertmanager:9093,grafana:3001,admin:9102};
  if(ports[prefix]){
    const url=prefix==='grafana'?req.url:req.url.slice(prefix.length+1)||'/';
    const upstream=http.request({host:'127.0.0.1',port:ports[prefix],path:url,method:req.method,headers:req.headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
    upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);return;
  }
  res.writeHead(404);res.end();
}).listen(18080,'0.0.0.0');
