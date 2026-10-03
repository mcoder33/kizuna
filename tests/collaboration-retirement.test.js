import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from './helpers/http.js';
import { createApp } from '../server/index.js';
import { fakeModelService } from './helpers/fake-model.js';
import { authed } from './helpers/auth.js';
import { saveNote, openDatabase, activeNote, getAggregate, fullEntry } from '../server/db.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'pagent-retirement-'));
  const file = path.join(directory,'test.sqlite');
  const app = createApp({databasePath:file,aiService:fakeModelService()});
  t.after(() => {
    app.closeEventStreams(); app.accounts.stop();
    if (app.database.open) app.database.close();
    fs.rmSync(directory,{recursive:true,force:true});
  });
  return {app,file};
}

test('retirement preserves uncheckpointed durable text, interpretation/note history and completion across restarts',async t => {
  const {app,file} = fixture(t),db=app.database,owner=authed(app);
  const entry=(await owner.post('/api/captures').send({raw:'Написать документацию проекта'}).expect(201)).body.entry;
  saveNote(db,entry.id,'previous checkpoint');
  const oldNote=activeNote(db,entry.id),oldInterpretation=getAggregate(db,entry.id).interpretation_id;
  const circle=(await owner.post('/api/circles').send({name:'Existing circle'}).expect(201)).body.circle;
  const participant=authed(app,{email:'participant@retirement.test',role:'user'});
  await owner.post(`/api/circles/${circle.id}/members`).send({userId:participant.user.id}).expect(200);
  const projection=entry.projections.find(item=>item.type==='task');
  await owner.post(`/api/projections/${projection.id}/complete`).send({}).expect(200);
  // A deployed v29 database includes durable text newer than its note checkpoint.
  db.exec(`DELETE FROM schema_migrations WHERE version=30;
    ALTER TABLE circle_members RENAME TO old_members;
    CREATE TABLE circle_members(circle_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','member','editor')),joined_at TEXT NOT NULL,muted_at TEXT,left_at TEXT,added_by TEXT,seen_at TEXT,can_edit INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(circle_id,user_id));
    INSERT INTO circle_members SELECT circle_id,user_id,role,joined_at,muted_at,left_at,added_by,seen_at,0 FROM old_members;
    DROP TABLE old_members;
    ALTER TABLE capture_circles ADD COLUMN persistent INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE collaborative_documents(capture_id TEXT PRIMARY KEY,generation TEXT,state BLOB,revision INTEGER,body TEXT,title TEXT,updated_at TEXT);
    CREATE TABLE public_todo_shares(id TEXT PRIMARY KEY,capture_id TEXT,circle_id TEXT,token_hash TEXT,revoked_at TEXT);
    CREATE TABLE collaborative_updates(id INTEGER PRIMARY KEY,capture_id TEXT,update_bytes BLOB);`);
  db.prepare("UPDATE circle_members SET role='editor',can_edit=1 WHERE user_id=?").run(participant.user.id);
  db.prepare('UPDATE circle_members SET can_edit=1 WHERE user_id=?').run(owner.user.id);
  db.prepare('INSERT INTO capture_circles(capture_id,circle_id,shared_by,shared_at,persistent) VALUES(?,?,?,?,1)').run(entry.id,circle.id,owner.user.id,new Date().toISOString());
  db.prepare('INSERT INTO collaborative_documents VALUES(?,?,?,?,?,?,?)').run(entry.id,'generation',Buffer.from([1,2,3]),46,'final uncheckpointed body','Final jointly edited title',new Date().toISOString());
  db.prepare('INSERT INTO public_todo_shares VALUES(?,?,?,?,NULL)').run('share',entry.id,circle.id,'hash');
  db.prepare('INSERT INTO collaborative_updates VALUES(?,?,?)').run(46,entry.id,Buffer.from([1,2,3]));
  app.closeEventStreams();app.accounts.stop();db.close();
  let reopened=openDatabase(file);
  const migrated=fullEntry(reopened,getAggregate(reopened,entry.id));
  assert.equal(migrated.raw,entry.raw);
  assert.equal(migrated.note.body,'final uncheckpointed body');
  assert.equal(migrated.interpretation.classification.summary,'Final jointly edited title');
  assert.equal(migrated.projections.find(item=>item.id===projection.id).completion.completed,true);
  assert.equal(reopened.prepare('SELECT body FROM capture_notes WHERE id=?').get(oldNote.id).body,'previous checkpoint');
  assert.equal(reopened.prepare('SELECT status FROM interpretations WHERE id=?').get(oldInterpretation).status,'superseded');
  assert.equal(reopened.prepare('SELECT role,can_edit FROM circle_members WHERE user_id=?').get(participant.user.id).role,'member');
  assert.deepEqual(reopened.prepare('SELECT role,can_edit FROM circle_members WHERE user_id=?').get(owner.user.id),{role:'owner',can_edit:0});
  assert.ok(reopened.prepare('SELECT revoked_at FROM public_todo_shares').get().revoked_at);
  assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM collaborative_updates').get().n,1);
  const version=migrated.note.version,interpretation=migrated.interpretation.id;
  saveNote(reopened,entry.id,'personal edit after retirement');reopened.close();
  reopened=openDatabase(file);
  assert.equal(activeNote(reopened,entry.id).body,'personal edit after retirement');
  assert.equal(activeNote(reopened,entry.id).version,version+1);
  assert.equal(getAggregate(reopened,entry.id).interpretation_id,interpretation);
  reopened.close();
});

test('public sharing and collaboration endpoints are unavailable; ordinary circle members remain readers',async t => {
  const {app}=fixture(t),owner=authed(app),reader=authed(app,{email:'reader@retirement.test',role:'user'});
  const circle=(await owner.post('/api/circles').send({name:'Ordinary circle'}).expect(201)).body.circle;
  await owner.post(`/api/circles/${circle.id}/members`).send({userId:reader.user.id}).expect(200);
  const entry=(await owner.post('/api/captures').send({raw:'Написать документацию'}).expect(201)).body.entry;
  await owner.post(`/api/captures/${entry.id}/assign`).send({assigneeId:reader.user.id,circleId:circle.id}).expect(200);
  await reader.get(`/api/captures/${entry.id}`).expect(200);
  await reader.post(`/api/captures/${entry.id}/notes`).send({body:'forbidden'}).expect(404);
  const saved=(await owner.post(`/api/captures/${entry.id}/notes`).send({body:'ordinary personal save'}).expect(200)).body.entry;
  assert.equal(saved.note.body,'ordinary personal save');
  assert.equal(saved.collaboration,undefined);
  await owner.post(`/api/captures/${entry.id}/public-shares`).send({circleId:circle.id}).expect(404);
  await owner.post(`/api/captures/${entry.id}/collaboration/commands`).send({}).expect(404);
  await owner.post('/api/public/todos/old-token/join').send({consent:true}).expect(404);
  await request(app).get('/s/old-token').expect(404);
  await request(app).get('/api/public/todos/old-token').expect(401);
  assert.equal(app.collaboration,undefined);
  const server=app.listen(0);
  assert.equal(server.listenerCount('upgrade'),0);
  await new Promise(resolve=>server.close(resolve));
});

test('retired denial audit cannot block admin deletion of an empty account',async t => {
  const {app,file}=fixture(t),owner=authed(app),former=authed(app,{email:'former@retirement.test',role:'user'});
  const circle=(await owner.post('/api/circles').send({name:'Former access'}).expect(201)).body.circle;
  app.database.exec(`DELETE FROM schema_migrations WHERE version=30;
    CREATE TABLE circle_share_denials(circle_id TEXT REFERENCES circles(id),user_id TEXT REFERENCES users(id),denied_at TEXT,PRIMARY KEY(circle_id,user_id));`);
  app.database.prepare('INSERT INTO circle_share_denials VALUES(?,?,?)').run(circle.id,former.user.id,new Date().toISOString());
  app.closeEventStreams();app.accounts.stop();app.database.close();
  const restarted=createApp({databasePath:file,aiService:fakeModelService()});
  t.after(()=>{restarted.closeEventStreams();restarted.accounts.stop();restarted.database.close();});
  assert.equal(restarted.database.prepare('SELECT COUNT(*) AS n FROM circle_share_denials').get().n,1);
  await authed(restarted).delete(`/api/admin/users/${former.user.id}`).expect(200);
  assert.equal(restarted.database.prepare('SELECT COUNT(*) AS n FROM circle_share_denials').get().n,0);
});
