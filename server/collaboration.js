import { WebSocketServer, WebSocket } from 'ws';
import * as Y from 'yjs';
import { canEditCapture, displayName, circlesForCapture } from './circles.js';
import { ensureDocument, documentRow, readDocument, applyDocumentUpdate, onDocumentChange, COLLABORATION_FRAME_LIMIT, collaborationError } from './collaboration-storage.js';

export function createCollaboration({db,accounts,security,onChange=()=>{}}) {
  const peers=new Set(),servers=new WeakSet();
  const wss=new WebSocketServer({noServer:true,maxPayload:COLLABORATION_FRAME_LIMIT,perMessageDeflate:false});
  function authorized(peer) { if(!db.open)return false;const user=accounts.userFromCookieHeader(peer.cookie);return Boolean(user&&user.id===peer.user.id&&canEditCapture(db,peer.captureId,user.id)); }
  function send(peer,value) { if(peer.socket.readyState!==WebSocket.OPEN)return; if(!authorized(peer)){revoke(peer);return;}if(peer.socket.bufferedAmount>2*COLLABORATION_FRAME_LIMIT){peer.socket.close(1013,'slow_consumer');return;}peer.socket.send(JSON.stringify(value)); }
  function revoke(peer) { if(peer.socket.readyState===WebSocket.OPEN)peer.socket.send(JSON.stringify({type:'revoked',code:'access_revoked'}));peer.socket.close(1008,'access_revoked'); }
  function awarenessPeers(captureId) { return [...peers].filter(peer=>peer.captureId===captureId&&peer.clientId&&authorized(peer)).map(peer=>({clientId:peer.clientId,clock:peer.clock||0,state:peer.presence||null})); }
  function presence(captureId) { for(const peer of peers)if(peer.captureId===captureId)send(peer,{type:'awareness',states:awarenessPeers(captureId)}); }
  function publish(captureId) {
    const row=documentRow(db,captureId);if(!row)return;
    for(const peer of peers)if(peer.captureId===captureId)send(peer,{type:'update',update:row.state.toString('base64'),revision:row.revision,structureRevision:db.prepare('SELECT revision FROM collaborative_structure WHERE capture_id=?').get(captureId)?.revision||0});
    onChange(captureId);
  }
  onDocumentChange(db,publish);
  function recheck() { for(const peer of peers)if(!authorized(peer))revoke(peer); }
  const heartbeat=setInterval(()=>{recheck();for(const peer of peers){if(!peer.alive){peer.socket.terminate();continue;}peer.alive=false;peer.socket.ping();}},1000);heartbeat.unref();
  wss.on('connection',(socket,request,identity)=>{
    const {captureId,user}=identity,row=ensureDocument(db,captureId);
    const peer={socket,cookie:request.headers.cookie,captureId,user,alive:true,rateAt:Date.now(),count:0,clientId:null};peers.add(peer);
    send(peer,{type:'hello',generation:row.generation,revision:row.revision,update:row.state.toString('base64'),actor:{id:user.id,name:displayName(user)},structureRevision:db.prepare('SELECT revision FROM collaborative_structure WHERE capture_id=?').get(captureId)?.revision||0});
    socket.on('pong',()=>{peer.alive=true;});
    socket.on('close',()=>{peers.delete(peer);if(peer.clientId){for(const other of peers)if(other.captureId===captureId)send(other,{type:'awareness',states:[{clientId:peer.clientId,clock:(peer.clock||0)+1,state:null}]});}});
    socket.on('error',()=>{});
    socket.on('message',(bytes,isBinary)=>{
      if(!authorized(peer)){revoke(peer);return;}
      try {
        if(isBinary)throw collaborationError('invalid_envelope');
        if(Date.now()-peer.rateAt>1000){peer.rateAt=Date.now();peer.count=0;}if(++peer.count>150)throw collaborationError('rate_limited',429);
        const message=JSON.parse(bytes.toString());if(!message||typeof message!=='object'||Array.isArray(message))throw collaborationError('invalid_envelope');
        const shapes={sync:['type','stateVector','clientId'],update:['type','update','operationId','baseRevision'],awareness:['type','clientId','clock','state']};
        if(!shapes[message.type]||Object.keys(message).some(key=>!shapes[message.type].includes(key)))throw collaborationError('invalid_envelope');
        if(message.type==='sync') {
          if(!Number.isSafeInteger(message.clientId)||message.clientId<0||message.clientId>4294967295||typeof message.stateVector!=='string'||message.stateVector.length>65536)throw collaborationError('invalid_envelope');
          if([...peers].some(other=>other!==peer&&other.captureId===captureId&&other.clientId===message.clientId))throw collaborationError('client_id_in_use');
          peer.clientId=message.clientId;const latest=documentRow(db,captureId),doc=readDocument(latest);
          try { send(peer,{type:'sync',update:Buffer.from(Y.encodeStateAsUpdate(doc,Buffer.from(message.stateVector,'base64'))).toString('base64'),revision:latest.revision}); } finally {doc.destroy();}presence(captureId);
        } else if(message.type==='update') {
          if(peer.clientId===null||typeof message.update!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(message.update)||!Number.isSafeInteger(message.baseRevision)||message.baseRevision<0)throw collaborationError('invalid_envelope');
          const result=applyDocumentUpdate(db,captureId,{update:Buffer.from(message.update,'base64'),operationId:message.operationId,actorId:user.id});
          send(peer,{type:'ack',operationId:message.operationId,revision:result.revision,replayed:Boolean(result.replayed)});
        } else {
          if(bytes.length>4096||message.clientId!==peer.clientId||!Number.isSafeInteger(message.clock)||message.clock<0)throw collaborationError('invalid_awareness');
          if(message.state!==null&&(typeof message.state!=='object'||Array.isArray(message.state)||Object.keys(message.state).some(key=>!['cursor','selection','user'].includes(key))))throw collaborationError('invalid_awareness');
          if(message.clock<=(peer.clock??-1))return;peer.clock=message.clock;
          const color=`#${[...user.id].reduce((h,c)=>(h*31+c.charCodeAt(0))>>>0,0).toString(16).padStart(6,'0').slice(-6)}`;
          peer.presence=message.state===null?null:{...(message.state.cursor===undefined?{}:{cursor:message.state.cursor}),...(message.state.selection===undefined?{}:{selection:message.state.selection}),user:{name:displayName(user),color},actorId:user.id};presence(captureId);
        }
      } catch(error) { send(peer,{type:'error',code:error.code||'invalid_update',operationId:typeof (()=>{try{return JSON.parse(bytes.toString()).operationId;}catch{return null;}})()==='string'?JSON.parse(bytes.toString()).operationId:null}); }
    });
  });
  function attach(server) {
    if(servers.has(server))return;servers.add(server);
    server.on('upgrade',(request,socket,head)=>{
      let url;try{url=new URL(request.url,'http://localhost');}catch{socket.destroy();return;}
      const match=/^\/api\/collaboration\/([0-9a-f-]{36})$/.exec(url.pathname);if(!match){socket.destroy();return;}
      const user=accounts.userFromCookieHeader(request.headers.cookie);
      if(!security.allowedOrigin(request,{required:true})||!user||!canEditCapture(db,match[1],user.id)||(!documentRow(db,match[1])&&!circlesForCapture(db,match[1]).length)||peers.size>=300||[...peers].filter(peer=>peer.captureId===match[1]).length>=30){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;}
      wss.handleUpgrade(request,socket,head,ws=>wss.emit('connection',ws,request,{captureId:match[1],user}));
    });
  }
  return {attach,publish,recheck,close(){clearInterval(heartbeat);for(const peer of peers)peer.socket.terminate();peers.clear();wss.close();onDocumentChange(db,()=>{});}};
}
