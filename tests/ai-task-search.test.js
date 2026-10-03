import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDatabase,createUser,saveNote,resetLedger } from '../server/db.js';
import { createTaskSearchService,exportEntrySearchTraces } from '../server/task-search.js';
import { createAiTaskSearchService } from '../server/ai-task-search.js';
import { lexicalMatch } from '../server/search-normalization.js';

const now=new Date('2026-10-03T12:00:00Z');
const basePlan=groups=>({version:1,type:null,status:null,period:null,basis:'createdOrCompleted',person:null,role:'related',exclusivePerson:false,topicGroups:groups,clarification:null});
function fixture(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'kizuna-ai-search-')),db=openDatabase(path.join(directory,'db.sqlite'));
  t.after(()=>{db.close();fs.rmSync(directory,{recursive:true,force:true});});
  const owner=createUser(db,{email:'owner@fixture.test',passwordHash:'test'}).id,foreign=createUser(db,{email:'foreign@fixture.test',passwordHash:'test'}).id;
  const core=createTaskSearchService(db,{clock:()=>0}),facts=[];
  const add=({title='Нейтральная запись',raw=title,project=null,type='task',subtask=false,tags=[],date='2026-10-02',done=false,schedule=null,identity=null,userId=owner}={})=>{
    const id=crypto.randomUUID(),interpretation=crypto.randomUUID(),projection=crypto.randomUUID(),createdAt=`${date}T12:00:00.000Z`;
    db.prepare('INSERT INTO captures(id,raw,created_at,occurred_at,user_id,subtask) VALUES(?,?,?,?,?,?)').run(id,raw,createdAt,createdAt,userId,Number(subtask));
    db.prepare('INSERT INTO interpretations VALUES(?,?,?,?,?,?,?,?,?,NULL)').run(interpretation,id,1,'active','manual',null,JSON.stringify({primaryType:type,summary:title,completed:done,entities:{projects:project?[project]:[],people:[],schedule}}),'{}',createdAt);
    const actionable=['task','meeting_event'].includes(type);
    if(actionable&&!done)db.prepare('INSERT INTO projections(id,capture_id,interpretation_id,projection_type,payload_json,status,undo_group_id,created_at) VALUES(?,?,?,?,?,?,?,?)').run(projection,id,interpretation,type,'{}','active',crypto.randomUUID(),createdAt);
    facts.push({id,type,subtask,tags,date,done,completedDate:done?date:null,status:actionable?done?'done':'open':null,schedule: schedule?.date,identity,userId});return id;
  };
  const input=(query,extra={})=>({query,userId:owner,now,timeZone:'Europe/Samara',...extra});
  const service=(planSearch,extra={})=>createAiTaskSearchService({core,canAccess:id=>id===owner,planSearch,...extra});
  return {db,owner,foreign,core,facts,add,input,service};
}

test('original-query facade uses AI intent for fresh paraphrases, preserves filters, and keeps pages/byId model-free',async t=>{
  const f=fixture(t);for(let i=0;i<9;i++)f.add({project:'ВойсОпс',type:i===8?'note':'task'});
  let calls=0;const seen=[];
  const service=f.service(async(query,context,operation)=>{calls++;seen.push({query,context});assert.equal(operation.isCurrent(),true);return {plan:{...basePlan([['войс опс','Voice Ops']]),type:'meeting_event'}};});
  const text='Можешь собрать мне всё касающееся войс опса?';const first=await service.search(f.input(text));
  assert.equal(first.matchedCount,9,'generic intent must not require conversational words from the old parser');
  assert.equal(first.criteria.type,null,'unmentioned structural type is not invented');assert.equal(calls,1);
  const second=await service.search(f.input(undefined,{criteria:first.criteria,offset:first.nextOffset}));
  assert.equal(second.items.length,3);assert.equal(calls,1);assert.ok(service.byId({userId:f.owner,captureId:first.items[0].captureId,criteria:first.criteria}));assert.equal(calls,1);
  assert.equal(seen[0].query,text);assert.equal(JSON.stringify(seen).includes('captureId'),false);
  const signal=f.add({project:'Signal Hub'});
  const fresh=f.service(async()=>({plan:basePlan([['Signal Hub','SignalHub']])}));
  assert.deepEqual((await fresh.search(f.input('Хочу увидеть всё про Signal Hub'))).items.map(item=>item.captureId),[signal]);
});

test('invalid literal dates and unsupported exclusions clarify before model calls; canonical filters win',async t=>{
  const f=fixture(t);f.add({project:'ВойсОпс'});f.add({project:'ВойсОпс',type:'note'});
  let calls=0;const service=f.service(async()=>{calls++;return {plan:{...basePlan([['войсопс']]),type:'note',status:'done',period:{start:'2020-01-01',end:'2020-01-01'}}};});
  for(const query of ['войсопс за 2026-02-30','войсопс за 2026-10-03-04','войсопс 2026-10-03 — 2026-09-01','всё кроме заметок войсопс','открытые и выполненные задачи войсопс','встречи войсопс в пятницу']) {
    assert.ok((await service.search(f.input(query))).clarification,query);
  }
  assert.equal(calls,0);
  const result=await service.search(f.input('открытые задачи войсопс созданные 2026-10-02'));
  assert.equal(result.matchedCount,1);assert.equal(result.criteria.type,'task');assert.equal(result.criteria.status,'open');assert.deepEqual(result.criteria.period,{from:'2026-10-02',to:'2026-10-02'});assert.equal(result.criteria.basis,'created');
});

test('bounded AND phrase matching spans accessible fields and preserves independent actions/documents/whole compounds',async t=>{
  const f=fixture(t),send=f.add({project:'SignalHub',title:'Отправить документы'}),voice=f.add({project:'ВойсОпс',title:'БотДетектор'});
  f.add({project:'SignalHub',title:'Без действия'});f.add({project:'DeployBot',title:'Сводка'});
  const combined=f.service(async()=>({plan:basePlan([['выслать бумаги'],['Signal Hub','SignalHub']])}));
  assert.deepEqual((await combined.search(f.input('где надо выслать бумаги для Signal Hub'))).items.map(item=>item.captureId),[send]);
  const phrase=f.service(async()=>({plan:basePlan([['voice ops бот детектор']])}));
  assert.deepEqual((await phrase.search(f.input('voice ops бот детектор'))).items.map(item=>item.captureId),[voice]);
  const split=f.service(async()=>({plan:basePlan([['войс','voice'],['ops']])}));
  assert.equal((await split.search(f.input('войс ops'))).matchedCount,1);
  const dropped=f.service(async()=>({plan:basePlan([['SignalHub']])}));
  assert.deepEqual((await dropped.search(f.input('выслать бумаги Signal Hub'))).items.map(item=>item.captureId),[send],'dropped meaningful concepts fall back to original query');
  const broad=f.service(async()=>({plan:basePlan([['DeployBot','бот']])}));
  assert.equal((await broad.search(f.input('DeployBot'))).matchedCount,1,'an incomplete compound alternative is rejected, original query retained');
});

test('independent unknown topics cannot be dropped and source-grounded colloquial filters remain effective',async t=>{
  const f=fixture(t);
  const neutral=f.add({project:'ВойсОпс'});
  for(const topic of ['бэкапы','расходы','обсуждения']) {
    const id=f.add({project:'ВойсОпс',title:topic});
    const dropped=f.service(async()=>({plan:basePlan([['войсопс']])}));
    assert.deepEqual((await dropped.search(f.input(`${topic} войсопс`))).items.map(item=>item.captureId),[id],topic);
    const valid=f.service(async()=>({plan:basePlan([[topic],['войсопс']])}));
    assert.deepEqual((await valid.search(f.input(`Можешь собрать мне всё касающееся ${topic} войсопс?`))).items.map(item=>item.captureId),[id],topic);
  }
  f.add({project:'ВойсОпс',done:true});
  const open=f.service(async()=>({plan:{...basePlan([['войсопс']]),type:'task',status:'open'}}));
  const result=await open.search(f.input('незаконченные туду войсопс'));
  assert.equal(result.criteria.status,'open');assert.equal(result.criteria.type,'task');
  assert.equal(result.matchedCount,4);assert.ok(result.items.some(item=>item.captureId===neutral));
  const invented=await open.search(f.input('войсопс'));
  assert.equal(invented.criteria.status,'all');assert.equal(invented.criteria.type,null);assert.equal(invented.matchedCount,5);
});

test('grounded model type and strict role are accepted while invented roles and identity restrictions are discarded',async t=>{
  const f=fixture(t),note=f.add({project:'ВойсОпс',type:'note'});
  f.add({project:'ВойсОпс'});
  const notes=f.service(async()=>({plan:{...basePlan([['войсопс']]),type:'note'}}));
  assert.deepEqual((await notes.search(f.input('записки войсопс'))).items.map(item=>item.captureId),[note]);
  const own=f.add({title:'Я обещал Мише подготовить отчёт'});
  f.core.recordOrigins({captureId:own,userId:f.owner,messages:[{message_id:1,text:'Я обещал Мише подготовить отчёт',from:{id:1}}]});
  const quoted=f.add({title:'Я обещал Мише подготовить отчёт'});
  f.core.recordOrigins({captureId:quoted,userId:f.owner,messages:[{message_id:2,text:'Я обещал Мише подготовить отчёт',forward_origin:{type:'user',sender_user:{id:2,first_name:'Миша'}}}]});
  const promises=f.service(async()=>({plan:{...basePlan([]),person:{surface:'Мишей'},role:'promise',exclusivePerson:true}}));
  const result=await promises.search(f.input('мои обязательства перед Мишей'));
  assert.equal(result.criteria.role,'promise');assert.equal(result.criteria.exclusivePerson,true);
  assert.deepEqual(result.items.map(item=>item.captureId),[own]);
  const invented=f.service(async()=>({plan:{...basePlan([['войсопс']]),role:'requester',exclusivePerson:true}}));
  const general=await invented.search(f.input('войсопс'));
  assert.equal(general.criteria.role,'related');assert.equal(general.criteria.exclusivePerson,false);assert.equal(general.matchedCount,2);
});

test('model cannot invent a date basis or drop meaningful version numbers',async t=>{
  const f=fixture(t);
  const version42=f.add({title:'Версия 42',project:'ВойсОпс'});
  f.add({title:'Версия 43',project:'ВойсОпс'});
  const invented=f.service(async()=>({plan:{...basePlan([['войсопс']]),period:{start:'2026-10-02',end:'2026-10-02'},basis:'deadline'}}));
  const dated=await invented.search(f.input('войсопс за 2026-10-02'));
  assert.equal(dated.criteria.basis,'createdOrCompleted');assert.equal(dated.matchedCount,2);
  for(const groups of [[['войсопс'],['версия']],[['войсопс'],['версия 42']]]) {
    const service=f.service(async()=>({plan:basePlan(groups)}));
    assert.deepEqual((await service.search(f.input('войсопс версия 42'))).items.map(item=>item.captureId),[version42]);
  }
  const other=f.service(async()=>({plan:basePlan([['войсопс'],['версия 43']])}));
  assert.equal((await other.search(f.input('войсопс версия 43'))).matchedCount,1);
});

test('unrelated matching numbers cannot permit fuzzy comparison with a different version',async t=>{
  assert.equal(lexicalMatch('версия42','версия43 счёт42',value=>value),null);
  assert.equal(lexicalMatch('версия42','версия43 счёт42',value=>value.replace(/.$/u,'')),null);
  assert.ok(lexicalMatch('версия42','версия42 счёт43',value=>value));
  const f=fixture(t),expected=f.add({title:'Версия42',project:'ВойсОпс'});
  f.add({title:'Версия43 счёт42',project:'ВойсОпс'});
  const service=f.service(async()=>({plan:basePlan([['войсопс'],['версия42']])}));
  assert.deepEqual((await service.search(f.input('войсопс версия42'))).items.map(item=>item.captureId),[expected]);
});

test('timeout, absent AI method and invalid plans fall back to the original screenshot query without widening',async t=>{
  const f=fixture(t),id=f.add({project:'ВойсОпс'});f.add({project:'SignalHub'});
  for(const planner of [undefined,async()=>({plan:{...basePlan([['unrelated']]),captureIds:['foreign']}}),()=>new Promise(()=>{})]) {
    const service=f.service(planner,{timeoutMs:5});const result=await service.search(f.input('покажи все что связанно с войс опсом'));
    assert.deepEqual(result.items.map(item=>item.captureId),[id]);
  }
  assert.equal(exportEntrySearchTraces(f.db,f.owner,now).every(trace=>trace.query==='покажи все что связанно с войс опсом'),true);
});

test('access, interaction cancellation, resets and current text are checked before and after asynchronous planning',async t=>{
  const f=fixture(t),id=f.add({project:'ВойсОпс'}),hidden=f.add({project:'ВойсОпс',userId:f.foreign});
  let allowed=true,calls=0,resolve;
  const service=f.service(()=>{calls++;return new Promise(done=>{resolve=done;});},{canAccess:id=>id===f.owner&&allowed});
  allowed=false;assert.equal((await service.search(f.input('войсопс'))).items.length,0);assert.equal(calls,0);
  allowed=true;const pending=service.search(f.input('войсопс'));await new Promise(done=>setImmediate(done));allowed=false;resolve({plan:basePlan([['войсопс']])});
  assert.equal((await pending).items.length,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM entry_search_traces').get().n,0);
  allowed=true;const controller=new AbortController();const cancelled=service.search(f.input('войсопс',{signal:controller.signal}));await new Promise(done=>setImmediate(done));controller.abort();assert.equal((await cancelled).items.length,0);
  const reset=service.search(f.input('войсопс'));await new Promise(done=>setImmediate(done));resetLedger(f.db,f.owner);resolve({plan:basePlan([['войсопс']])});assert.equal((await reset).items.length,0);
  assert.equal(service.byId({userId:f.owner,captureId:hidden}),null);assert.equal(service.byId({userId:f.owner,captureId:id}),null);
  const editable=f.add({raw:'старыйтермин'});const instant=f.service(async()=>{saveNote(f.db,editable,'новыйтермин');return {plan:basePlan([['старыйтермин']])};});
  assert.equal((await instant.search(f.input('старыйтермин'))).matchedCount,0);
});

test('68 independently generated queries apply recorded real Gemini plans to factual synthetic records',async t=>{
  const f=fixture(t);
  const corpus=JSON.parse(fs.readFileSync(new URL('./fixtures/search-query-corpus.json',import.meta.url),'utf8'));
  const recorded=JSON.parse(fs.readFileSync(new URL('./fixtures/search-plans-gemini.json',import.meta.url),'utf8'));
  assert.equal(corpus.cases.length,68);assert.equal(recorded.length,68);
  const projects={voice:'ВойсОпс',signal:'SignalHub',deploy:'DeployBot'};
  for(const [tag,project] of Object.entries(projects)) {
    for(const [index,type] of ['task','task','task','task','task','task','note','outcome_decision','outcome_decision','meeting_event','idea_question'].entries())f.add({project,type,subtask:index>=2&&index<6,tags:[tag],done:index===0});
    for(const [title,tags] of [['Отправить документы',['send','documents']],['БотДетектор',['бот','детектор']],['Сводка',['report']],['Созвон',['call']],['Оплата',['payment']]])f.add({project,title,tags:[tag,...tags],done:title==='Сводка'});
    f.add({project,type:'note',date:'2026-09-24',tags:[tag]});
    f.add({project,date:'2026-09-25',subtask:true,done:true,tags:[tag,'sasha'],title:'Саня'});
    f.add({project,tags:[tag],schedule:{date:'2026-10-09',defaulted:false}});
    f.add({project,type:'meeting_event',tags:[tag],schedule:{date:'2026-10-03',defaulted:false}});
  }
  for(const [identity,name,username,sender] of [['one','Саша Иванов','sasha_one',101],['two','Саша Петров','sasha_two',102]]) {
    const id=f.add({project:'ВойсОпс',tags:['voice','sasha'],identity,title:'Пришли отчёт, пожалуйста'});
    f.core.recordOrigins({captureId:id,userId:f.owner,messages:[{message_id:sender,text:'Пришли отчёт, пожалуйста',forward_origin:{type:'user',sender_user:{id:sender,first_name:name.split(' ')[0],last_name:name.split(' ')[1],username}}}]});
  }
  f.add({title:'Александр',tags:['Александр']});
  const promise=f.add({project:'SignalHub',title:'Я обещал Мише подготовить отчёт',tags:['signal','misha']});
  f.core.recordOrigins({captureId:promise,userId:f.owner,messages:[{message_id:777,text:'Я обещал Мише подготовить отчёт',from:{id:100}}]});
  f.add({project:'ВойсОпс',userId:f.foreign,tags:['voice'],title:'ЧУЖАЯ_ПРИВАТНАЯ_ЗАПИСЬ'});
  const failures=[];
  for(const row of corpus.cases) {
    const output=recorded.find(value=>value.id===row.id);assert.ok(output,row.id);
    const service=f.service(async()=>({plan:output.plan}));
    const result=await service.search(f.input(row.query,{previousCriteria:row.previousCriteria}));
    if(row.outcome==='clarify'||row.duplicateIdentityClarifies||row.id==='C47'){if(!result.clarification)failures.push(`${row.id}: clarification expected`);continue;}
    if(row.security){if(result.items.some(item=>!f.facts.some(fact=>fact.id===item.captureId&&fact.userId===f.owner)))failures.push(`${row.id}: ACL leakage`);continue;}
    let expected=f.facts.filter(fact=>fact.userId===f.owner && (row.topics||[]).every(tag=>fact.tags.includes(tag)));
    if(row.person && !row.topics)expected=expected.filter(fact=>row.person==='Миша'?fact.tags.includes('misha'):row.person==='Саша Иванов'?fact.identity==='one':row.person==='@sasha_two'?fact.identity==='two':true);
    if(row.type)expected=expected.filter(fact=>row.type==='subtask'?fact.subtask:fact.type===row.type);
    if(row.status)expected=expected.filter(fact=>fact.status===row.status);
    if(row.role==='promise')expected=expected.filter(fact=>fact.id===promise);
    if(row.period){const within=date=>date&&date>=row.period.from&&date<=row.period.to;expected=expected.filter(fact=>row.basis==='created'?within(fact.date):row.basis==='completed'?within(fact.completedDate):['scheduled','deadline'].includes(row.basis)?within(fact.schedule):within(fact.date)||within(fact.completedDate));}
    if(row.expectedMatches===0)expected=[];
    if(result.clarification||result.matchedCount!==expected.length||result.items.some(item=>!expected.some(fact=>fact.id===item.captureId)))failures.push(`${row.id}: expected ${expected.length}, got ${result.matchedCount}; ${result.clarification||''}`);
  }
  assert.deepEqual(failures,[],'Recorded model-plan application; this does not stub or claim AI recognition accuracy');
});
