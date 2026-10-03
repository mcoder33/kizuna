import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { createApp } from '../server/index.js';
import { fakeModelService } from './helpers/fake-model.js';
import { authed } from './helpers/auth.js';
import { saveNote, fullEntry, getAggregate, replaceInterpretation, openDatabase } from '../server/db.js';
import { ensureDocument, readDocument, applyDocumentUpdate, documentRow } from '../server/collaboration-storage.js';
import { canEditCapture, canSeeCapture, shareCapture, unshareCapture, membership } from '../server/circles.js';

async function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pagent-collab-')),file=path.join(dir,'test.sqlite');
  const app=createApp({databasePath:file,aiService:fakeModelService()});
  const owner=authed(app,{email:'owner@collab.test'}),member=authed(app,{email:'member@collab.test',role:'user'}),editor=authed(app,{email:'editor@collab.test',role:'user'});
  t.after(()=>{app.closeEventStreams();app.accounts.stop();if(app.database.open)app.database.close();fs.rmSync(dir,{recursive:true,force:true});});
  const circle=(await owner.post('/api/circles').send({name:'Shared circle'}).expect(201)).body.circle;
  const invite=(await owner.post(`/api/circles/${circle.id}/invite`).send({}).expect(201)).body;
  await member.post(`/api/circles/invite/${invite.token}/accept`).send({}).expect(200);
  const entry=(await owner.post('/api/captures').send({raw:'Написать документацию проекта'}).expect(201)).body.entry;
  saveNote(app.database,entry.id,'original private history');
  const link=(await owner.post(`/api/captures/${entry.id}/public-shares`).send({circleId:circle.id}).expect(201)).body;
  await editor.post(`/api/public/todos/${link.token}/join`).send({consent:true}).expect(200);
  return {app,db:app.database,owner,member,editor,circle,entry,link,file};
}
function edit(doc,key,text){const vector=Y.encodeStateVector(doc);doc.getText(key).insert(doc.getText(key).length,text);return Y.encodeStateAsUpdate(doc,vector);}

test('public ACL: sanitized view, explicit join, old member rights, all circle todos, removal/restore',async t=>{
  const {app,db,owner,member,editor,circle,entry,link}=await fixture(t);
  const guest=await request(app).get(`/api/public/todos/${link.token}`).expect(200);
  assert.deepEqual(Object.keys(guest.body).sort(),['body','circleName','state','title']);assert.match(guest.headers['cache-control'],/no-store/);
  await request(app).post(`/api/captures/${entry.id}/notes`).send({body:'guest'}).expect(401);
  await member.post(`/api/captures/${entry.id}/notes`).send({body:'member'}).expect(404);
  await member.post(`/api/public/todos/${link.token}/join`).send({}).expect(400);
  assert.equal(membership(db,circle.id,member.user.id).role,'member');
  assert.equal(canSeeCapture(db,entry.id,member.user.id),true);assert.equal(canEditCapture(db,entry.id,editor.user.id),true);
  await owner.post(`/api/public/todos/${link.token}/join`).send({consent:true}).expect(200);assert.equal(membership(db,circle.id,owner.user.id).role,'owner');
  const other=(await owner.post('/api/captures').send({raw:'Другой пункт проекта'}).expect(201)).body.entry;shareCapture(db,other.id,circle.id,owner.user.id);
  const otherCard=(await editor.get(`/api/captures/${other.id}`).expect(200)).body.entry;assert.equal(otherCard.canEdit,true);assert.equal(otherCard.collaboration.enabled,true);
  await editor.post(`/api/circles/${circle.id}/invite`).send({}).expect(201);
  await editor.post(`/api/captures/${entry.id}/public-shares`).send({circleId:circle.id}).expect(403);
  await owner.delete(`/api/circles/${circle.id}/members/${editor.user.id}`).expect(200);
  await editor.get(`/api/captures/${entry.id}`).expect(404);
  await editor.post(`/api/public/todos/${link.token}/join`).send({consent:true}).expect(403);
  const ordinary=(await owner.post(`/api/circles/${circle.id}/invite`).send({}).expect(201)).body;await editor.post(`/api/circles/invite/${ordinary.token}/accept`).send({}).expect(403);
  await member.post(`/api/circles/${circle.id}/members`).send({userId:editor.user.id}).expect(403);
  await owner.post(`/api/circles/${circle.id}/members/${editor.user.id}/restore`).send({}).expect(200);
  await editor.get(`/api/captures/${entry.id}`).expect(200);
  await owner.delete(`/api/captures/${entry.id}/public-shares/${link.id}`).expect(200);
  await request(app).get(`/api/public/todos/${link.token}`).expect(404);await member.post(`/api/public/todos/${link.token}/join`).send({consent:true}).expect(404);
  assert.equal(canSeeCapture(db,entry.id,editor.user.id),true,'revoking link does not revoke existing member');
});

test('two independent Yjs clients converge body/title; durable audit/restart and invalid update isolation',async t=>{
  const {app,db,entry,owner,editor,file}=await fixture(t),raw=db.prepare('SELECT raw FROM captures WHERE id=?').get(entry.id).raw;
  const row=ensureDocument(db,entry.id),a=readDocument(row),b=readDocument(row);
  const first=edit(a,'body',' A'),second=edit(b,'body',' B'),title=edit(a,'title',' live');
  applyDocumentUpdate(db,entry.id,{update:first,operationId:'a',actorId:owner.user.id});
  applyDocumentUpdate(db,entry.id,{update:second,operationId:'b',actorId:editor.user.id});
  applyDocumentUpdate(db,entry.id,{update:title,operationId:'title',actorId:owner.user.id});
  const revision=documentRow(db,entry.id).revision;
  assert.equal(applyDocumentUpdate(db,entry.id,{update:second,operationId:'b',actorId:editor.user.id}).replayed,true);assert.equal(documentRow(db,entry.id).revision,revision);
  Y.applyUpdate(a,documentRow(db,entry.id).state);Y.applyUpdate(b,documentRow(db,entry.id).state);assert.equal(a.getText('body').toString(),b.getText('body').toString());assert.match(a.getText('body').toString(),/ A/);assert.match(a.getText('body').toString(),/ B/);
  const poison=readDocument(documentRow(db,entry.id)),vector=Y.encodeStateVector(poison);poison.getMap('private').set('secret','bad');
  assert.throws(()=>applyDocumentUpdate(db,entry.id,{update:Y.encodeStateAsUpdate(poison,vector),operationId:'poison',actorId:editor.user.id}),/invalid_document/);assert.equal(documentRow(db,entry.id).revision,revision);
  const hidden=new Y.Doc();hidden.getMap('body').set('hidden','secret');assert.throws(()=>applyDocumentUpdate(db,entry.id,{update:Y.encodeStateAsUpdate(hidden),operationId:'hidden',actorId:editor.user.id}),/invalid_document/);hidden.destroy();
  assert.throws(()=>applyDocumentUpdate(db,entry.id,{update:Buffer.alloc(1024*1024+1),operationId:'large',actorId:editor.user.id}),/update_too_large/);
  const staged=readDocument(documentRow(db,entry.id)),update=edit(staged,'body',' FAIL');
  db.exec("CREATE TRIGGER collaboration_fail BEFORE INSERT ON collaborative_updates BEGIN SELECT RAISE(ABORT,'fail'); END;");
  assert.throws(()=>applyDocumentUpdate(db,entry.id,{update,operationId:'failure',actorId:editor.user.id}),/fail/);assert.equal(documentRow(db,entry.id).revision,revision);db.exec('DROP TRIGGER collaboration_fail');
  assert.ok(db.prepare("SELECT 1 FROM capture_notes WHERE capture_id=? AND body='original private history'").get(entry.id));
  assert.equal(db.prepare('SELECT raw FROM captures WHERE id=?').get(entry.id).raw,raw);
  assert.equal(db.prepare('SELECT actor_id FROM collaborative_updates WHERE operation_id=?').get('b').actor_id,editor.user.id);
  const reopened=openDatabase(file);assert.equal(documentRow(reopened,entry.id).body,a.getText('body').toString());reopened.close();
  const guest=(await request(app).get(`/api/public/todos/${(await owner.post(`/api/captures/${entry.id}/public-shares`).send({circleId:(await owner.get('/api/circles')).body.circles[0].id})).body.token}`).expect(200)).body;
  assert.equal(guest.body,a.getText('body').toString());assert.equal(guest.title,a.getText('title').toString());
  [a,b,poison,staged].forEach(doc=>doc.destroy());
});

test('legacy text revision fencing; internal splice and unrelated/AI corrections preserve live title/body',async t=>{
  const {db,owner,editor,entry}=await fixture(t),doc=readDocument(ensureDocument(db,entry.id));
  applyDocumentUpdate(db,entry.id,{update:edit(doc,'title',' live'),operationId:'title',actorId:editor.user.id});
  await owner.post(`/api/captures/${entry.id}/notes`).send({body:'stale'}).expect(409);
  const rev=documentRow(db,entry.id).revision;
  await editor.post(`/api/captures/${entry.id}/notes`).send({body:'replacement',expectedRevision:rev}).expect(200);
  saveNote(db,entry.id,documentRow(db,entry.id).body+' voice append');assert.equal(documentRow(db,entry.id).body,'replacement voice append');
  await editor.post(`/api/captures/${entry.id}/corrections`).send({patch:{priority:'high'}}).expect(200);
  assert.match(fullEntry(db,getAggregate(db,entry.id)).interpretation.classification.summary,/ live$/);
  const classification=JSON.parse(getAggregate(db,entry.id).classification_json);replaceInterpretation(db,entry.id,{...classification,summary:'stale AI title'},'openrouter');
  assert.match(fullEntry(db,getAggregate(db,entry.id)).interpretation.classification.summary,/ live$/);
  await editor.post(`/api/captures/${entry.id}/corrections`).send({patch:{summary:'stale'}}).expect(409);doc.destroy();
});

test('idempotent structured commands, child ACL and persistent association survives unassignment',async t=>{
  const {db,owner,editor,member,entry,circle,link}=await fixture(t);
  const privateChild=(await owner.post(`/api/captures/${entry.id}/subtasks`).send({title:'child'}).expect(201)).body.entry;
  unshareCapture(db,privateChild.id,circle.id);
  const initialRevision=(await editor.get(`/api/captures/${entry.id}/collaboration`).expect(200)).body.structureRevision;
  const command={operationId:'child-command',expectedRevision:initialRevision,command:{type:'subtask.create',title:'shared child'}};
  const created=(await editor.post(`/api/captures/${entry.id}/commands`).send(command).expect(200)).body;
  assert.equal((await editor.post(`/api/captures/${entry.id}/commands`).send(command).expect(200)).body.captureId,created.captureId);
  await editor.get(`/api/captures/${privateChild.id}`).expect(404);assert.ok(!(await editor.get(`/api/captures/${entry.id}`).expect(200)).body.entry.parts.some(part=>part.id===privateChild.id));await member.get(`/api/captures/${created.captureId}`).expect(200);
  await editor.post(`/api/captures/${entry.id}/commands`).send({operationId:'stale',expectedRevision:initialRevision,command:{type:'completion',completed:true}}).expect(409);
  const complete={operationId:'complete',expectedRevision:created.structureRevision,command:{type:'completion',completed:true}};await editor.post(`/api/captures/${entry.id}/commands`).send(complete).expect(200);
  await editor.post(`/api/captures/${entry.id}/commands`).send(complete).expect(200);
  const done=await owner.get(`/api/captures/${entry.id}`).expect(200);assert.equal(done.body.entry.projections[0].completion.completed,true);
  await owner.post(`/api/captures/${entry.id}/assign`).send({assigneeId:member.user.id,circleId:circle.id}).expect(200);
  await owner.post(`/api/captures/${entry.id}/assign`).send({assigneeId:null}).expect(200);
  assert.equal(db.prepare('SELECT persistent FROM capture_circles WHERE capture_id=? AND circle_id=?').get(entry.id,circle.id).persistent,1);
  await owner.get(`/api/public/todos/${link.token}`).expect(200);
});

function inbox(socket){const messages=[];const waiting=[];socket.on('message',bytes=>{const value=JSON.parse(bytes);const index=waiting.findIndex(w=>w.type===value.type);if(index>=0){const waiter=waiting.splice(index,1)[0];clearTimeout(waiter.timer);waiter.resolve(value);}else messages.push(value);});return type=>{const index=messages.findIndex(m=>m.type===type);if(index>=0)return Promise.resolve(messages.splice(index,1)[0]);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`timeout ${type}`)),3000);waiting.push({type,resolve,timer});});};}
async function connect(server,cookie,captureId){const port=server.address().port,socket=new WebSocket(`ws://127.0.0.1:${port}/api/collaboration/${captureId}`,{headers:{Cookie:cookie,Origin:`http://127.0.0.1:${port}`}}),next=inbox(socket);await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});return {socket,next};}

test('live WS two clients, authenticated actors, immediate guest SSE and logout revocation',async t=>{
  const {app,owner,editor,entry,link,db}=await fixture(t),server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>server.close());
  const a=await connect(server,owner.cookie,entry.id),b=await connect(server,editor.cookie,entry.id);t.after(()=>{a.socket.terminate();b.socket.terminate();});
  const ah=await a.next('hello'),bh=await b.next('hello'),adoc=new Y.Doc(),bdoc=new Y.Doc();Y.applyUpdate(adoc,Buffer.from(ah.update,'base64'));Y.applyUpdate(bdoc,Buffer.from(bh.update,'base64'));
  for(const [peer,doc] of [[a,adoc],[b,bdoc]]){peer.socket.send(JSON.stringify({type:'sync',clientId:doc.clientID,stateVector:Buffer.from(Y.encodeStateVector(doc)).toString('base64')}));await peer.next('sync');}
  const controller=new AbortController();t.after(()=>controller.abort());const response=await fetch(`http://127.0.0.1:${server.address().port}/api/public/todos/${link.token}/events`,{signal:controller.signal}),reader=response.body.getReader();
  const initial=await reader.read();assert.match(new TextDecoder().decode(initial.value),/event: todo/);
  const update=edit(adoc,'body',' live websocket');a.socket.send(JSON.stringify({type:'update',operationId:'websocket1',baseRevision:ah.revision,update:Buffer.from(update).toString('base64')}));
  const ack=await a.next('ack');assert.equal(ack.operationId,'websocket1');assert.equal(documentRow(db,entry.id).revision,ack.revision);
  const remote=await b.next('update');Y.applyUpdate(bdoc,Buffer.from(remote.update,'base64'));assert.match(bdoc.getText('body').toString(),/ live websocket$/);
  const delta=await reader.read();assert.match(new TextDecoder().decode(delta.value),/live websocket/);
  b.socket.send(JSON.stringify({type:'awareness',clientId:bdoc.clientID,clock:1,state:{user:{name:'spoof'},cursor:null}}));
  let awareness=await a.next('awareness');while(!awareness.states.some(s=>s.state?.actorId===editor.user.id))awareness=await a.next('awareness');assert.notEqual(awareness.states.find(s=>s.clientId===bdoc.clientID).state.user.name,'spoof');
  await editor.post('/api/auth/logout').send({}).expect(200);assert.equal((await b.next('revoked')).code,'access_revoked');
  await owner.delete(`/api/captures/${entry.id}/public-shares/${link.id}`).expect(200);const revoked=await reader.read();assert.match(new TextDecoder().decode(revoked.value),/event: revoked/);controller.abort();adoc.destroy();bdoc.destroy();
});

test('retained canonical lifetime after final unshare permits author WS and fenced saves; legacy structure rejects stale commands',async t=>{
  const {app,db,owner,editor,entry,circle,link}=await fixture(t);
  const before=(await owner.get(`/api/captures/${entry.id}/collaboration`).expect(200)).body.structureRevision;
  const projection=(await owner.get(`/api/captures/${entry.id}`).expect(200)).body.entry.projections[0];
  await editor.post(`/api/projections/${projection.id}/complete`).send({}).expect(200);
  await owner.post(`/api/captures/${entry.id}/commands`).send({operationId:'stale-legacy',expectedRevision:before,command:{type:'completion',completed:false}}).expect(409);
  const revision=(await owner.get(`/api/captures/${entry.id}/collaboration`).expect(200)).body.structureRevision;
  await editor.post(`/api/captures/${entry.id}/commands`).send({operationId:'undo',expectedRevision:revision,command:{type:'completion',completed:false}}).expect(200);
  const reopened=(await owner.get(`/api/captures/${entry.id}`).expect(200)).body.entry;
  assert.equal(reopened.interpretation.classification.completed,false);assert.ok(reopened.interpretation.classification.entities.schedule.date);
  unshareCapture(db,entry.id,circle.id);
  const own=(await owner.get(`/api/captures/${entry.id}`).expect(200)).body.entry;assert.equal(own.collaboration.enabled,true);
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>server.close());
  const peer=await connect(server,owner.cookie,entry.id);assert.equal((await peer.next('hello')).generation,own.collaboration.generation);peer.socket.terminate();
  await owner.post(`/api/captures/${entry.id}/notes`).send({body:'personal canonical',expectedRevision:documentRow(db,entry.id).revision}).expect(200);
  await editor.get(`/api/captures/${entry.id}`).expect(404);
  shareCapture(db,entry.id,circle.id,owner.user.id,{persistent:true});await request(app).get(`/api/public/todos/${link.token}`).expect(404);
});

test('participant attachment ACL and independent personal boards retain legacy borrowed-placement guard',async t=>{
  const {app,db,owner,member,editor,entry,circle}=await fixture(t);
  const uploaded=(await owner.post(`/api/captures/${entry.id}/attachments`).set('Content-Type','text/plain').set('X-Attachment-Name','test.txt').send(Buffer.from('private attachment')).expect(201)).body.attachment;
  await editor.get(`/api/attachments/${uploaded.id}`).expect(200);await member.get(`/api/attachments/${uploaded.id}`).expect(200);await request(app).get(`/api/attachments/${uploaded.id}`).expect(401);
  const ownColumn=(await owner.post('/api/board/columns').send({name:'Owner board'}).expect(201)).body;
  await owner.post('/api/board/move').send({captureId:entry.id,columnId:ownColumn.id,index:0}).expect(200);
  await owner.post(`/api/captures/${entry.id}/assign`).send({assigneeId:member.user.id,circleId:circle.id}).expect(200);
  const assignment=db.prepare('SELECT id FROM assignments WHERE capture_id=? AND cancelled_at IS NULL').get(entry.id);
  await member.post(`/api/assignments/${assignment.id}/respond`).send({take:true}).expect(200);
  const memberColumn=(await member.post('/api/board/columns').send({name:'Member board'}).expect(201)).body;
  const borrowed=(await member.get('/api/board').expect(200)).body;assert.ok(borrowed.columns.some(column=>column.cards.some(card=>card.captureId===entry.id)));
  const refused=await member.post('/api/board/move').send({captureId:entry.id,columnId:memberColumn.id,index:0});assert.equal(refused.status,404);assert.equal(refused.body.error.code,'card_not_found');
  assert.equal(db.prepare('SELECT column_id FROM board_placements WHERE capture_id=? AND user_id=?').get(entry.id,owner.user.id).column_id,ownColumn.id);
  const ownOther=(await member.post('/api/captures').send({raw:'Личное дело участника'}).expect(201)).body.entry;
  await member.post('/api/board/move').send({captureId:ownOther.id,columnId:memberColumn.id,index:0}).expect(200);
  assert.equal(db.prepare('SELECT column_id FROM board_placements WHERE capture_id=? AND user_id=?').get(entry.id,owner.user.id).column_id,ownColumn.id);
  await owner.delete(`/api/circles/${circle.id}/members/${editor.user.id}`).expect(200);await editor.get(`/api/attachments/${uploaded.id}`).expect(404);
});

test('explicit circle-owner consent grants editing all circle todos without downgrading management',async t=>{
  const {app,db,owner,member,editor,circle}=await fixture(t);
  const foreign=(await member.post('/api/captures').send({raw:'Общее дело другого автора'}).expect(201)).body.entry;
  const foreignLink=(await member.post(`/api/captures/${foreign.id}/public-shares`).send({circleId:circle.id}).expect(201)).body;
  assert.equal(membership(db,circle.id,owner.user.id).role,'owner');assert.equal(membership(db,circle.id,owner.user.id).can_edit,0);
  assert.equal(canEditCapture(db,foreign.id,owner.user.id),false);
  await owner.post(`/api/captures/${foreign.id}/notes`).send({body:'not consented',expectedRevision:0}).expect(404);
  await owner.post(`/api/public/todos/${foreignLink.token}/join`).send({consent:true}).expect(200);
  await owner.post(`/api/public/todos/${foreignLink.token}/join`).send({consent:true}).expect(200);
  assert.equal(membership(db,circle.id,owner.user.id).role,'owner');assert.equal(membership(db,circle.id,owner.user.id).can_edit,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM circle_members WHERE circle_id=? AND user_id=?').get(circle.id,owner.user.id).n,1);
  await owner.post(`/api/captures/${foreign.id}/notes`).send({body:'consented owner edit',expectedRevision:documentRow(db,foreign.id).revision}).expect(200);
  const another=(await member.post('/api/captures').send({raw:'Второе общее дело'}).expect(201)).body.entry;shareCapture(db,another.id,circle.id,member.user.id,{persistent:true});
  assert.equal((await owner.get(`/api/captures/${another.id}`).expect(200)).body.entry.canEdit,true);
  const child=(await owner.post(`/api/captures/${another.id}/subtasks`).send({title:'owner collaborative child'}).expect(201)).body.entry;
  assert.equal(canSeeCapture(db,child.id,member.user.id),true);
  assert.equal(membership(db,circle.id,editor.user.id).can_edit,1);
  await owner.delete(`/api/circles/${circle.id}/members/${editor.user.id}`).expect(200);
  assert.equal(canEditCapture(db,foreign.id,editor.user.id),false);
  await owner.post(`/api/circles/${circle.id}/members/${editor.user.id}/restore`).send({}).expect(200);
  assert.equal(membership(db,circle.id,editor.user.id).can_edit,1);assert.equal(canEditCapture(db,foreign.id,editor.user.id),true);
});

test('revoked share auth return serves safe HTML404 shell while APIs remain unavailable',async t=>{
  const {app,owner,member,entry,link,circle}=await fixture(t);
  await owner.delete(`/api/captures/${entry.id}/public-shares/${link.id}`).expect(200);
  const shell=await request(app).get(`/s/${link.token}?resume=1`).expect(404);
  assert.match(shell.headers['content-type'],/text\/html/);assert.match(shell.headers['cache-control'],/no-store/);assert.match(shell.headers['x-robots-tag'],/noindex/);assert.equal(shell.headers['referrer-policy'],'no-referrer');
  assert.match(shell.text,/<html/);for(const privateValue of [link.token,entry.id,member.user.id,owner.user.email,'original private history'])assert.ok(!shell.text.includes(privateValue));
  await request(app).get(`/api/public/todos/${link.token}`).expect(404);
  await member.post(`/api/public/todos/${link.token}/join`).send({consent:true}).expect(404);
  assert.equal(membership(app.database,circle.id,member.user.id).role,'member');
});

test('notes page detail/list retain canonical revision for first, successive and stale legacy saves',async t=>{
  const {db,owner,circle}=await fixture(t);
  const page=(await owner.post('/api/pages').send({title:'Canonical note'}).expect(201)).body.page;
  await owner.post(`/api/captures/${page.id}/public-shares`).send({circleId:circle.id}).expect(201);
  const doc=readDocument(ensureDocument(db,page.id));
  applyDocumentUpdate(db,page.id,{update:edit(doc,'body','initial checkpoint'),operationId:'notes-initial',actorId:owner.user.id});
  applyDocumentUpdate(db,page.id,{update:edit(doc,'body',' latest live body'),operationId:'notes-live',actorId:owner.user.id});
  applyDocumentUpdate(db,page.id,{update:edit(doc,'title',' live title'),operationId:'notes-title',actorId:owner.user.id});
  const row=documentRow(db,page.id),detail=(await owner.get(`/api/pages/${page.id}`).expect(200)).body.page;
  assert.equal(detail.body,row.body);assert.equal(detail.title,row.title);assert.equal(detail.documentRevision,row.revision);assert.equal(detail.collaboration.revision,row.revision);assert.equal(detail.collaboration.generation,row.generation);
  const listed=(await owner.get('/api/pages').expect(200)).body.pages.find(item=>item.id===page.id);assert.equal(listed.documentRevision,row.revision);assert.equal(listed.collaboration.generation,row.generation);
  const first=(await owner.post(`/api/captures/${page.id}/notes`).send({body:detail.body+' first save',expectedRevision:detail.documentRevision}).expect(200)).body.entry.note;
  assert.ok(first.revision>detail.documentRevision);
  const second=(await owner.post(`/api/captures/${page.id}/notes`).send({body:first.body+' successive save',expectedRevision:first.revision}).expect(200)).body.entry.note;
  assert.ok(second.revision>first.revision);
  await owner.post(`/api/captures/${page.id}/notes`).send({body:'stale overwritten body',expectedRevision:detail.documentRevision}).expect(409);
  const after=(await owner.get(`/api/pages/${page.id}`).expect(200)).body.page;assert.equal(after.body,second.body);assert.equal(after.documentRevision,second.revision);doc.destroy();
});
