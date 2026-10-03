import crypto from 'node:crypto';
import { membership, shareCapture, circleDetail, CIRCLES_LIMIT, circlesOf } from './circles.js';
import { ensureDocument, documentRow, collaborationError } from './collaboration-storage.js';

const tokenHash = token => crypto.createHash('sha256').update(String(token)).digest('hex');
export function activeShare(db,token) {
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{32,128}$/.test(token))return null;
  return db.prepare(`SELECT s.*,c.name circle_name FROM public_todo_shares s
    JOIN captures t ON t.id=s.capture_id AND t.deleted_at IS NULL
    JOIN circles c ON c.id=s.circle_id AND c.deleted_at IS NULL
    JOIN capture_circles cc ON cc.capture_id=s.capture_id AND cc.circle_id=s.circle_id AND cc.removed_at IS NULL AND cc.persistent=1
    WHERE s.token_hash=? AND s.revoked_at IS NULL`).get(tokenHash(token))||null;
}
export function createPublicShare(db,captureId,circleId,userId) {
  return db.transaction(()=>{
    const capture=db.prepare('SELECT user_id FROM captures WHERE id=? AND deleted_at IS NULL').get(captureId);
    if(!capture||capture.user_id!==userId||!membership(db,circleId,userId)||!db.prepare('SELECT 1 FROM circles WHERE id=? AND deleted_at IS NULL').get(circleId))throw collaborationError('forbidden',403);
    const token=crypto.randomBytes(32).toString('base64url'),id=crypto.randomUUID(),at=new Date().toISOString();
    shareCapture(db,captureId,circleId,userId,{persistent:true});ensureDocument(db,captureId);
    db.prepare('INSERT INTO public_todo_shares(id,capture_id,circle_id,token_hash,created_by,created_at) VALUES(?,?,?,?,?,?)').run(id,captureId,circleId,tokenHash(token),userId,at);
    return {id,token,circleId,createdAt:at,url:`/s/${token}`};
  }).immediate();
}
export function joinPublicShare(db,token,userId) {
  return db.transaction(()=>{
    const share=activeShare(db,token);if(!share)throw collaborationError('share_unavailable',404);
    if(db.prepare('SELECT 1 FROM circle_share_denials WHERE circle_id=? AND user_id=?').get(share.circle_id,userId))throw collaborationError('membership_removed',403);
    if(!db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(userId))throw collaborationError('unauthorized',401);
    const existing=membership(db,share.circle_id,userId);
    if(!existing&&circlesOf(db,userId).length>=CIRCLES_LIMIT)throw collaborationError('circles_limit',409);
    const at=new Date().toISOString();
    db.prepare(`INSERT INTO circle_members(circle_id,user_id,role,joined_at,can_edit) VALUES(?,?,'editor',?,1)
      ON CONFLICT(circle_id,user_id) DO UPDATE SET left_at=NULL,can_edit=1,role=CASE WHEN circle_members.role='owner' THEN 'owner' ELSE 'editor' END`).run(share.circle_id,userId,at);
    return {captureId:share.capture_id,circle:circleDetail(db,share.circle_id,userId),returnTo:`/#today?open=${encodeURIComponent(share.capture_id)}`};
  }).immediate();
}
export function publicTodo(db,share) {
  const row=documentRow(db,share.capture_id);
  const classification=db.prepare("SELECT classification_json FROM interpretations WHERE capture_id=? AND status='active'").get(share.capture_id);
  if(!classification)return null;
  const title=row?.title??JSON.parse(classification.classification_json).summary;
  const body=row?.body??db.prepare("SELECT body FROM capture_notes WHERE capture_id=? AND status='active'").get(share.capture_id)?.body??'';
  const projection=db.prepare("SELECT id FROM projections WHERE capture_id=? AND status='active' AND projection_type IN ('task','meeting_event') LIMIT 1").get(share.capture_id);
  const event=projection&&db.prepare("SELECT event_type FROM ledger_events WHERE projection_id=? AND event_type IN ('completed','completion_undone') ORDER BY created_at DESC,rowid DESC LIMIT 1").get(projection.id);
  return {title,body,state:event?.event_type==='completed'?'completed':'active',circleName:share.circle_name};
}
export function registerPublicShareRoutes(app,{db,accounts,publicDirectory}) {
  const streams=new Set();
  const headers=res=>res.set({'Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'no-referrer'});
  const unavailable=res=>res.status(404).json({error:{code:'share_unavailable',message:'Ссылка недоступна.'}});
  function publish() {
    if(!db.open){clearInterval(timer);for(const peer of streams)peer.res.end();streams.clear();return;}
    for(const peer of [...streams]){
      const share=activeShare(db,peer.token),value=share&&publicTodo(db,share);
      if(!value){peer.res.write('event: revoked\ndata: {}\n\n');peer.res.end();streams.delete(peer);continue;}
      const json=JSON.stringify(value);
      if(json!==peer.last){if(peer.res.writableLength>65536){peer.res.end();streams.delete(peer);continue;}peer.res.write(`event: todo\ndata: ${json}\n\n`);peer.last=json;}
    }
  }
  const timer=setInterval(publish,1000);timer.unref();
  app.get('/s/:token',(req,res)=>{headers(res);if(!/^[A-Za-z0-9_-]{32,128}$/.test(req.params.token))return unavailable(res);if(!activeShare(db,req.params.token))res.status(404);res.sendFile('public-todo.html',{root:publicDirectory});});
  app.get('/api/public/todos/:token',(req,res)=>{headers(res);const share=activeShare(db,req.params.token);if(!share)return unavailable(res);res.json(publicTodo(db,share));});
  app.get('/api/public/todos/:token/events',(req,res)=>{
    headers(res);if(!activeShare(db,req.params.token))return unavailable(res);
    if(streams.size>=500)return res.status(503).end();
    res.set({'Content-Type':'text/event-stream','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
    const peer={token:req.params.token,res,last:null};streams.add(peer);publish();req.on('close',()=>streams.delete(peer));
  });
  app.post('/api/public/todos/:token/join',accounts.requireAuth,(req,res,next)=>{try{if(req.body?.consent!==true)throw collaborationError('consent_required');res.json(joinPublicShare(db,req.params.token,req.user.id));}catch(error){next(error);}});
  return {publish,close(){clearInterval(timer);for(const peer of streams)peer.res.end();streams.clear();}};
}
