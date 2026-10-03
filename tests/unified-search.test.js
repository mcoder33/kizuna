import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDatabase,createUser,saveNote,completeProjection,undoProjectionCompletion,exportLedger,resetLedger } from '../server/db.js';
import { createTaskSearchService,exportEntrySearchTraces } from '../server/task-search.js';
import { createCircle,shareCapture,assign } from '../server/circles.js';

const at = new Date('2026-10-03T12:00:00Z');
function fixture(t,options={}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'kizuna-unified-search-'));
  const db=openDatabase(path.join(directory,'test.sqlite'));
  t.after(()=>{db.close();fs.rmSync(directory,{recursive:true,force:true});});
  const user=name=>createUser(db,{email:`${name}@kizuna.test`,passwordHash:'fixture',status:'active'}).id;
  const owner=user('owner'),viewer=user('viewer'),outsider=user('outsider');
  const service=createTaskSearchService(db,options);
  const add=({ownerId=owner,type='task',subtask=false,parent=null,raw='Синтетическая запись',title='Без темы',projects=[],people=[],createdAt=at.toISOString(),interpreted=true,actions=[]}={})=>{
    const id=crypto.randomUUID(),interpretation=crypto.randomUUID(),projection=crypto.randomUUID();
    db.prepare('INSERT INTO captures(id,raw,created_at,occurred_at,user_id,subtask,parent_capture_id) VALUES(?,?,?,?,?,?,?)').run(id,raw,createdAt,createdAt,ownerId,Number(subtask),parent);
    if(interpreted) {
      db.prepare('INSERT INTO interpretations VALUES(?,?,?,?,?,?,?,?,?,NULL)').run(interpretation,id,1,'active','manual',null,JSON.stringify({primaryType:type,summary:title,proposedActions:actions,entities:{projects,people}}),'{}',createdAt);
      if(['task','meeting_event'].includes(type) && !actions.length) db.prepare('INSERT INTO projections(id,capture_id,interpretation_id,projection_type,payload_json,status,undo_group_id,created_at) VALUES(?,?,?,?,?,?,?,?)').run(projection,id,interpretation,type,'{}','active',crypto.randomUUID(),createdAt);
    }
    return {id,projection};
  };
  const search=(query,userId=owner,extra={})=>service.search({query,userId,now:at,timeZone:'Europe/Samara',...extra});
  const participate=(capture,userId)=>db.prepare('INSERT INTO capture_people(capture_id,user_id,added_by,added_at) VALUES(?,?,?,?)').run(capture,userId,owner,at.toISOString());
  const circle=createCircle(db,owner,'Fixture').circle.id;
  const join=userId=>db.prepare("INSERT INTO circle_members(circle_id,user_id,role,joined_at) VALUES(?,?,'member',?)").run(circle,userId,at.toISOString());
  return {db,owner,viewer,outsider,service,add,search,participate,circle,join};
}

test('metadata-only nine-entry project searches every type, includes subtasks and narrows explicit types',t=>{
  const f=fixture(t), entries=[];
  for(const type of ['task','task','task','task','task','task','note','outcome_decision','outcome_decision']) entries.push(f.add({type,subtask:entries.length>=2&&entries.length<6,projects:['ВойсОпс']}));
  for(const query of ['войсопс','ВойсОпс','Voice Ops','voice-ops','войс опс','дай всё, что есть связанное с войсопс','покажи всё связанное с войсопс','что у нас с voice ops','что у нас с войс опс','что у нас с Voice Ops']) {
    const result=f.search(query);assert.equal(result.matchedCount,9,query);assert.equal(result.items.length,6,query);
    assert.equal(result.partialCoverage,false,query);
  }
  assert.equal(f.search('покажи задачи проекта ВойсОпс').matchedCount,6);
  assert.equal(f.search('подзадачи войсопс').matchedCount,4);
  assert.equal(f.search('заметки войсопс').matchedCount,1);
  assert.equal(f.search('результаты войсопс').matchedCount,2);
  const first=f.search('войсопс'),second=f.search('войсопс',f.owner,{offset:first.nextOffset});
  assert.equal(new Set([...first.items,...second.items].map(item=>item.captureId)).size,9);
});

test('compound transliteration is generic across unrelated projects and spelling affinity stays below exact metadata',t=>{
  const f=fixture(t);
  const signal=f.add({projects:['Signal Hub']}),deploy=f.add({projects:['Deploy Bot']});
  assert.deepEqual(f.search('сигнал хаб').items.map(item=>item.captureId),[signal.id]);
  assert.deepEqual(f.search('деплойбот').items.map(item=>item.captureId),[deploy.id]);
  const exact=f.add({projects:['Документы']}),typo=f.add({raw:'Докумнеты'}),linked=f.add();
  f.db.prepare('INSERT INTO note_links(from_id,label,to_id,context) VALUES(?,?,?,?)').run(linked.id,'Документы',exact.id,'fixture');
  const result=f.search('документы');
  assert.deepEqual(result.items.map(item=>item.captureId),[exact.id,typo.id,linked.id]);
  const trace=exportEntrySearchTraces(f.db,f.owner,at).find(item=>item.query==='документы');
  assert.ok(trace.matches[0].score>trace.matches[1].score && trace.matches[1].score>trace.matches[2].score);
});

test('current active body replaces immutable raw and superseded bodies for notes and task descriptions',t=>{
  const f=fixture(t);
  for(const type of ['note','task']) {
    const entry=f.add({type,raw:'Устаревший пароль',title:'Рабочая запись'});
    saveNote(f.db,entry.id,'Суперсекрет прошлой версии');saveNote(f.db,entry.id,'Текущий протокол');
    assert.ok(f.search('протокол').items.some(item=>item.captureId===entry.id));
    assert.equal(f.search('пароль').matchedCount,0);
    assert.equal(f.search('суперсекрет').matchedCount,0);
  }
});

test('canonical ACL includes circle and participant entries, then immediately honors revocations and deletion',t=>{
  const f=fixture(t);f.join(f.viewer);
  const shared=f.add({projects:['Доступ']}),participant=f.add({type:'note',projects:['Доступ']}),privateEntry=f.add({projects:['Доступ']});
  shareCapture(f.db,shared.id,f.circle,f.owner);f.participate(participant.id,f.viewer);
  assert.equal(f.search('доступ',f.owner).matchedCount,3);
  assert.equal(f.search('доступ',f.viewer).matchedCount,2);
  assert.equal(f.search('доступ',f.outsider).matchedCount,0);
  assert.equal(f.service.byId({userId:f.viewer,captureId:privateEntry.id}),null);
  f.db.prepare('UPDATE circle_members SET left_at=? WHERE circle_id=? AND user_id=?').run(at.toISOString(),f.circle,f.viewer);
  assert.equal(f.service.byId({userId:f.viewer,captureId:shared.id}),null);
  f.db.prepare('UPDATE capture_people SET removed_at=? WHERE capture_id=? AND user_id=?').run(at.toISOString(),participant.id,f.viewer);
  assert.equal(f.search('доступ',f.viewer).matchedCount,0);
  f.db.prepare('UPDATE captures SET deleted_at=? WHERE id=?').run(at.toISOString(),shared.id);
  assert.equal(f.service.byId({userId:f.owner,captureId:shared.id}),null);
});

test('direct public author names are searchable only on accessible records, without hidden identity ambiguity',t=>{
  const f=fixture(t);
  f.db.prepare('UPDATE users SET display_name=? WHERE id IN (?,?)').run('Автормаркер',f.viewer,f.outsider);
  const visible=f.add({ownerId:f.viewer}),hidden=f.add({ownerId:f.outsider});f.participate(visible.id,f.owner);
  assert.deepEqual(f.search('автормаркер').items.map(item=>item.captureId),[visible.id]);
  assert.deepEqual(f.search('что у нас с Автормаркером').items.map(item=>item.captureId),[visible.id]);
  assert.equal(f.search('человек Автормаркер').clarification,undefined);
  assert.equal(f.search('человек Автормаркер').matchedCount,1);
  assert.equal(f.service.byId({userId:f.owner,captureId:hidden.id}),null);
  f.db.prepare('UPDATE capture_people SET removed_at=? WHERE capture_id=? AND user_id=?').run(at.toISOString(),visible.id,f.owner);
  assert.equal(f.search('автормаркер').matchedCount,0);
});

test('latest noncancelled assignee is a public related person, without fabricated roles or hidden assignments',t=>{
  const f=fixture(t);f.join(f.viewer);
  f.db.prepare('UPDATE users SET display_name=? WHERE id=?').run('Исполнительмаркер',f.viewer);
  const visible=f.add();assert.ok(assign(f.db,{captureId:visible.id,assigneeId:f.viewer,assignerId:f.owner,circleId:f.circle}).assignment);
  const hiddenAssignee=createUser(f.db,{email:'hidden-assignee@kizuna.test',passwordHash:'fixture',status:'active'}).id;
  f.db.prepare('UPDATE users SET display_name=? WHERE id=?').run('Исполнительмаркер',hiddenAssignee);
  const hiddenCircle=createCircle(f.db,f.outsider,'Hidden').circle.id;
  f.db.prepare("INSERT INTO circle_members(circle_id,user_id,role,joined_at) VALUES(?,?,'member',?)").run(hiddenCircle,hiddenAssignee,at.toISOString());
  const hidden=f.add({ownerId:f.outsider});assert.ok(assign(f.db,{captureId:hidden.id,assigneeId:hiddenAssignee,assignerId:f.outsider,circleId:hiddenCircle}).assignment);
  assert.deepEqual(f.search('исполнительмаркер').items.map(item=>item.captureId),[visible.id]);
  assert.deepEqual(f.search('что у нас с Исполнительмаркером').items.map(item=>item.captureId),[visible.id]);
  assert.equal(f.search('человек Исполнительмаркер').clarification,undefined);
  assert.equal(f.search('просьбы Исполнительмаркера').matchedCount,0);
  f.db.prepare('UPDATE assignments SET cancelled_at=? WHERE capture_id=?').run(at.toISOString(),visible.id);
  assert.equal(f.search('исполнительмаркер').matchedCount,0);
});

test('one-hop parent/place/link matching never traverses hidden, deleted or two-hop endpoints',t=>{
  const f=fixture(t),hidden=f.add({raw:'Скрытыймаркер'}),visible=f.add({ownerId:f.viewer}),deleted=f.add({raw:'Удаленныймаркер'});
  f.db.prepare('UPDATE captures SET parent_capture_id=? WHERE id=?').run(hidden.id,visible.id);
  f.db.prepare('INSERT INTO note_places(capture_id,parent_id,source,placed_at) VALUES(?,?,?,?)').run(visible.id,hidden.id,'manual',at.toISOString());
  f.db.prepare('INSERT INTO note_links(from_id,label,to_id,context) VALUES(?,?,?,?)').run(visible.id,'Скрытыймаркер',hidden.id,'fixture');
  f.db.prepare('INSERT INTO note_links(from_id,label,to_id,context) VALUES(?,?,?,?)').run(visible.id,'Удаленныймаркер',deleted.id,'fixture');
  f.db.prepare('UPDATE captures SET deleted_at=? WHERE id=?').run(at.toISOString(),deleted.id);
  assert.equal(f.search('скрытыймаркер',f.viewer).matchedCount,0);
  assert.equal(f.search('удаленныймаркер',f.viewer).matchedCount,0);
  assert.deepEqual(f.service.byId({userId:f.viewer,captureId:visible.id}).relations,[]);
  f.participate(hidden.id,f.viewer);
  const far=f.add({ownerId:f.viewer,raw:'Дальниймаркер'});
  f.db.prepare('INSERT INTO note_links(from_id,label,to_id,context) VALUES(?,?,?,?)').run(hidden.id,'Дальниймаркер',far.id,'fixture');
  const result=f.search('скрытыймаркер',f.viewer);
  assert.equal(result.matchedCount,3);assert.ok(result.items.find(item=>item.captureId===visible.id).relations.some(edge=>edge.captureId===hidden.id));
  assert.equal(f.search('дальниймаркер',f.viewer).items.some(item=>item.captureId===visible.id),false);
});

test('nickname affinity and combined related identities never merge IDs; exclusive filters ignore hidden identities',t=>{
  const f=fixture(t),sasha=f.add({people:['Саша']}),misha=f.add({people:['Миша']});
  assert.deepEqual(f.search('что у нас с Саньком').items.map(item=>item.captureId),[sasha.id]);
  assert.deepEqual(f.search('что у нас с Мишкой').items.map(item=>item.captureId),[misha.id]);
  assert.equal(f.search('что у нас с Александром').matchedCount,0);
  const forward=(id,name)=>({message_id:id,text:'Отчет',forward_origin:{type:'user',sender_user:{id,first_name:name},date:1780000000}});
  f.service.recordOrigins({captureId:sasha.id,userId:f.owner,messages:[forward(1,'Саша')]});
  const hidden=f.add({ownerId:f.outsider});f.service.recordOrigins({captureId:hidden.id,userId:f.outsider,messages:[forward(2,'Саша')]});
  assert.equal(f.search('дела с Сашей').clarification,undefined);
  const shared=f.add({ownerId:f.outsider});f.participate(shared.id,f.owner);
  f.service.recordOrigins({captureId:shared.id,userId:f.outsider,messages:[forward(3,'Саша')]});
  assert.equal(f.search('дела с Сашей').clarification,undefined);
  assert.equal(f.search('дела с Сашей').matchedCount,2);
  assert.match(f.search('человек Саша').clarification,/несколько/);
  f.db.prepare('UPDATE captures SET deleted_at=? WHERE id=?').run(at.toISOString(),shared.id);
  assert.equal(f.search('дела с Сашей').clarification,undefined);
});

test('free keywords and related phrases combine project, people and text matches without mandatory targeting',t=>{
  const f=fixture(t),project=f.add({projects:['Петя']}),person=f.add({people:['Петя']}),text=f.add({raw:'Петя прислал отчет'});
  for(const query of ['петя','покажи всё связанное с Петей']) {
    const result=f.search(query);assert.equal(result.clarification,undefined,query);
    assert.deepEqual(new Set(result.items.map(item=>item.captureId)),new Set([project.id,person.id,text.id]),query);
  }
  assert.deepEqual(f.search('человек Петя').items.map(item=>item.captureId),[person.id]);
  f.add({projects:['ВойсОпс']});f.add({people:['ВойсОпс']});
  assert.equal(f.search('покажи всё связанное с войсопс').matchedCount,2);
});

test('nonactionable records have no fake status; explicit status and task scope honor undo, subtasks and containers',t=>{
  const f=fixture(t),task=f.add({projects:['Период']}),note=f.add({type:'note',projects:['Период']});
  const container=f.add({projects:['Период'],actions:[{type:'task',title:'Отдельное действие'}]});
  assert.equal(f.search('период').matchedCount,3);
  assert.equal(f.service.byId({userId:f.owner,captureId:note.id}).status,null);
  assert.equal(f.service.byId({userId:f.owner,captureId:container.id}).status,null);
  assert.equal(f.search('открытые период').matchedCount,1);
  completeProjection(f.db,task.projection);assert.equal(f.search('выполненные период').matchedCount,1);
  undoProjectionCompletion(f.db,task.projection);assert.equal(f.search('выполненные период').matchedCount,0);
  assert.equal(f.search('задачи период').matchedCount,1);
  assert.equal(f.search('период созданные 2026-10-03').matchedCount,3);
});

test('raw pending or failed captures are searchable without a fabricated type or completion',t=>{
  const f=fixture(t),pending=f.add({interpreted:false,raw:'Необработанныймаркер'});
  const result=f.search('необработанныймаркер');assert.equal(result.matchedCount,1);
  assert.equal(result.items[0].type,'unknown');assert.equal(result.items[0].status,null);
  assert.equal(f.search('задачи необработанныймаркер').matchedCount,0);
  assert.equal(f.service.byId({userId:f.owner,captureId:pending.id}).captureId,pending.id);
});

test('edited unclassified entry and its one-hop fallback title cannot match stale immutable raw',t=>{
  const f=fixture(t),pending=f.add({interpreted:false,raw:'Устаревшийпароль'}),child=f.add({parent: null});
  f.db.prepare('UPDATE captures SET parent_capture_id=? WHERE id=?').run(pending.id,child.id);
  saveNote(f.db,pending.id,'Текущийпротокол');
  assert.equal(f.search('устаревшийпароль').matchedCount,0);
  assert.equal(f.search('текущийпротокол').matchedCount,2);
  assert.equal(f.service.byId({userId:f.owner,captureId:pending.id}).title,'Текущийпротокол');
  assert.equal(f.service.byId({userId:f.owner,captureId:child.id}).relations[0].title,'Текущийпротокол');
});

test('related phrases accept lowercase compound projects and both single and multiword person forms',t=>{
  const f=fixture(t),entry=f.add({people:['Петя Иванов']}),other=f.add({people:['Петя Петров']});
  assert.deepEqual(f.search('что у нас с Петей').items.map(item=>item.captureId).sort(),[entry.id,other.id].sort());
  for(const query of ['что у нас с Петей Иванов','что у нас с петей иванов','что у нас с петя иванов']) assert.deepEqual(f.search(query).items.map(item=>item.captureId),[entry.id],query);
});

test('oversized stored body reports incomplete coverage rather than claiming a definitive absence',t=>{
  const f=fixture(t),entry=f.add({type:'note'});
  saveNote(f.db,entry.id,'x'.repeat(100001)+' Текстзапределом');
  f.db.prepare("UPDATE capture_notes SET body=? WHERE capture_id=? AND status='active'").run('x'.repeat(100001)+' Текстзапределом',entry.id);
  const result=f.search('текстзапределом');assert.equal(result.matchedCount,0);assert.equal(result.partialCoverage,true);
});

test('private quality traces store only requester query and fixed match reasons, export current ACL and reset cross references',t=>{
  const f=fixture(t),entry=f.add({raw:'Неэкспортироватьэтоттекст',projects:['Логирование']});
  f.participate(entry.id,f.viewer);
  f.search('логирование',f.viewer);f.search('мой личный запрос',f.owner);
  const viewerExport=exportLedger(f.db,f.viewer).entrySearchTraces;
  assert.equal(viewerExport.length,1);assert.equal(viewerExport[0].query,'логирование');
  assert.deepEqual(viewerExport[0].matches[0].reasonCodes,['project-exact']);
  assert.doesNotMatch(JSON.stringify(viewerExport),/Неэкспортироватьэтоттекст|мой личный запрос/);
  f.db.prepare('UPDATE capture_people SET removed_at=? WHERE capture_id=? AND user_id=?').run(at.toISOString(),entry.id,f.viewer);
  assert.deepEqual(exportLedger(f.db,f.viewer).entrySearchTraces[0].matches,[]);
  resetLedger(f.db,f.owner);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM entry_search_trace_matches WHERE capture_id=?').get(entry.id).n,0);
  assert.equal(exportLedger(f.db,f.viewer).entrySearchTraces.length,1);
  resetLedger(f.db,f.viewer);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM entry_search_traces').get().n,0);
});

test('quality traces are capped at 1000 per requester, 30 days, 1000 query characters and twenty match references',t=>{
  const f=fixture(t);for(let i=0;i<25;i++)f.add({projects:['Логирование']});
  f.search('логирование',f.owner,{offset:18});
  assert.equal(exportEntrySearchTraces(f.db,f.owner,at)[0].matches.length,20);
  f.db.transaction(()=>{
    const insert=f.db.prepare('INSERT INTO entry_search_traces VALUES(?,?,?,?,?,?,?)');
    for(let i=0;i<1001;i++)insert.run(crypto.randomUUID(),f.owner,'fixture','results',0,0,at.toISOString());
    insert.run('expired',f.owner,'fixture','results',0,0,'2026-08-01T00:00:00Z');
    insert.run('foreign',f.viewer,'PRIVATE FOREIGN QUERY','results',0,0,at.toISOString());
  })();
  f.search('z'.repeat(1001));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM entry_search_traces WHERE requester_id=?').get(f.owner).n,1000);
  assert.equal(f.db.prepare('SELECT 1 FROM entry_search_traces WHERE id=?').get('expired'),undefined);
  assert.equal(f.db.prepare('SELECT MAX(length(query)) n FROM entry_search_traces WHERE requester_id=?').get(f.owner).n,1000);
  assert.equal(exportEntrySearchTraces(f.db,f.viewer,at)[0].query,'PRIVATE FOREIGN QUERY');
});
