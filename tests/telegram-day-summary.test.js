import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, createUser, createLedger, readSettings } from '../server/db.js';
import { reviewDay } from '../server/day-review.js';
import { createTelegramService } from '../server/telegram.js';
import { createFakeTelegram } from './helpers/fake-telegram.js';
import { createTelegramDaySummaryRouter, DAY_SUMMARY_LABELS, summaryReplyKeyboard, readSummaryPreferences, renderDaySummary, safeSummaryLink, summaryPreferences, weekdayReviewDate } from '../server/telegram-day-summary.js';

function fixture(t,{dayReview=null,access=true}={}) {
  const db=openDatabase(':memory:');t.after(()=>db.close());const userId=createUser(db,{email:'telegram-day@example.org',passwordHash:'test',status:'active'}).id;
  const fake=createFakeTelegram();let now=new Date('2026-10-03T12:00:00Z'),cache=readSettings(db),changes=0;const captures=[],reviews=[],attachments=[];
  db.prepare('INSERT INTO telegram_links(user_id,telegram_id,chat_id,app_url,linked_at) VALUES(?,?,?,?,?)').run(userId,fake.user.id,fake.user.id,'https://kizuna.example','2026-09-30T10:00:00Z');
  let allowed=access;
  const service=createTelegramService({db,canAccessDaySummary:id=>allowed && id===userId,token:()=>fake.token,fetch:fake.fetch,now:()=>now,clock:()=>now.getTime(),timeZone:()=> 'Europe/Samara',userActive:id=>db.prepare("SELECT status FROM users WHERE id=?").get(id)?.status==='active',onSettingsChanged:stored=>{cache=stored;changes++;},
    dayReview:async input=>{reviews.push(input);return dayReview?dayReview(input):{...input,planned:[],done:[],remaining:[{id:'todo',title:'Написать отчёт'}],overdue:[],added:[],meetings:[{title:'Созвон',time:'16:00',end:'17:00'}],counts:{remaining:1,meetings:1},historyCoverage:{gaps:[]}};},
    queueCapture:async input=>{captures.push(input);const saved=createLedger(db,{raw:input.raw,userId:input.userId,classification:{primaryType:'task',summary:input.raw,entities:{schedule:null}},provider:'manual'});return{captureId:saved.captureId,jobId:`job-${captures.length}`};},attach:input=>{attachments.push(input);return true;},describe:()=>null,avatar:()=>Buffer.alloc(0),groupWindowMs:0});
  return{db,userId,fake,service,setAccess:value=>{allowed=value;},captures,reviews,attachments,setNow:value=>{now=new Date(value);},get cache(){return cache;},get changes(){return changes;},messages:()=>fake.sent.filter(x=>x.method==='sendMessage'),acks:()=>fake.sent.filter(x=>x.method==='answerCallbackQuery'),async text(text,fields={}){fake.push({text,...fields});await service.pollOnce();await service.flush({force:true});},async callback(data,fields={}){fake.pushCallback(data,fields);await service.pollOnce();}};
}

test('exact persistent keyboard, slash day/date navigation and HTTPS selected date link do not create tasks',async t=>{
 const ctx=fixture(t);await ctx.text('/today');assert.deepEqual(ctx.messages()[0].params.reply_markup,summaryReplyKeyboard());assert.deepEqual(summaryReplyKeyboard().keyboard,[[DAY_SUMMARY_LABELS.today,DAY_SUMMARY_LABELS.day],[DAY_SUMMARY_LABELS.settings]]);assert.equal(ctx.reviews[0].date,'2026-10-03');const markup=ctx.messages().at(-1).params.reply_markup;assert.equal(markup.inline_keyboard[1][0].url,'https://kizuna.example/#today?date=2026-10-03');assert.equal(ctx.captures.length,0);
 await ctx.text('/day 01.10.2026');assert.equal(ctx.reviews.at(-1).date,'2026-10-01');await ctx.callback('tds:date:2026-10-02');assert.equal(ctx.reviews.at(-1).date,'2026-10-02');assert.equal(ctx.acks().length,1);assert.equal(ctx.db.prepare('SELECT count(*) n FROM captures').get().n,0);
});
test('settings default off, independent desired callbacks idempotent, activation/cache and weekday empty means none',async t=>{
 const ctx=fixture(t);await ctx.text('/settings');let prefs=readSummaryPreferences(ctx.db,ctx.userId);assert.equal(prefs.morning.enabled,false);assert.equal(prefs.evening.enabled,false);assert.equal(prefs.morning.time,'09:00');assert.equal(prefs.evening.time,'20:00');
 await ctx.callback('tds:enabled:morning:1');prefs=readSummaryPreferences(ctx.db,ctx.userId);const activatedAt=prefs.morning.activatedAt;assert.equal(prefs.morning.enabled,true);assert.equal(prefs.evening.enabled,false);assert.equal(ctx.changes,1);assert.ok(ctx.cache[`user:${ctx.userId}:telegramDaySummary`]);
 ctx.setNow('2026-10-03T12:30:00Z');await ctx.callback('tds:enabled:morning:1');assert.equal(ctx.changes,1);assert.equal(readSummaryPreferences(ctx.db,ctx.userId).morning.activatedAt,activatedAt);
 for(let day=1;day<=7;day++)await ctx.callback(`tds:weekday:${day}:0`);assert.deepEqual(readSummaryPreferences(ctx.db,ctx.userId).weekdays,[]);assert.ok(ctx.messages().at(-1).params.text.includes('отправок нет'));assert.equal(ctx.captures.length,0);
 await ctx.callback('tds:time:evening');await ctx.text('21:45');assert.equal(readSummaryPreferences(ctx.db,ctx.userId).evening.time,'21:45');assert.equal(readSummaryPreferences(ctx.db,ctx.userId).evening.enabled,false);
});
test('pending strict date/time input expires, commands/cancel clear, ordinary notes continue capture',async t=>{
 const ctx=fixture(t);await ctx.text('/day');await ctx.callback('tds:pick');await ctx.text('Напомнить о встрече');assert.equal(ctx.captures.length,1);await ctx.text('01.10.2026');assert.equal(ctx.reviews.at(-1).date,'2026-10-01');
 await ctx.callback('tds:pick');await ctx.text('2026-02-30');assert.equal(ctx.captures.length,1);assert.notEqual(ctx.reviews.at(-1).date,'2026-02-30');await ctx.text('/help');await ctx.text('2026-10-02');assert.equal(ctx.captures.length,2);
 await ctx.callback('tds:time:morning');ctx.setNow('2026-10-03T12:11:00Z');await ctx.text('08:30');assert.equal(ctx.captures.length,3);assert.equal(readSummaryPreferences(ctx.db,ctx.userId).morning.time,'09:00');await ctx.callback('tds:pick');await ctx.text('Отмена');await ctx.text('2026-10-01');assert.equal(ctx.captures.length,4);
});
test('forwarded commands/menu and files stay capture; plain notes still batch together',async t=>{
 const ctx=fixture(t);await ctx.callback('tds:pick');await ctx.text('/today',{forward_origin:{type:'hidden_user',sender_user_name:'Друг',date:1}});await ctx.text(DAY_SUMMARY_LABELS.settings,{forward_origin:{type:'hidden_user',sender_user_name:'Друг',date:1}});assert.equal(ctx.reviews.length,0);assert.equal(ctx.captures.length,2);
 const fileId=ctx.fake.addFile(Buffer.from('file payload'),'note.txt');ctx.fake.push({caption:DAY_SUMMARY_LABELS.today,document:{file_id:fileId,file_name:'note.txt',mime_type:'text/plain'}});await ctx.service.pollOnce();await ctx.service.flush({force:true});assert.equal(ctx.attachments.length,1);assert.equal(ctx.reviews.length,0);
 ctx.fake.push({text:'Первая мысль'});ctx.fake.push({text:'Вторая мысль'});await ctx.service.pollOnce();await ctx.service.flush({force:true});assert.ok(ctx.captures.at(-1).raw.includes('Первая мысль'));assert.ok(ctx.captures.at(-1).raw.includes('Вторая мысль'));assert.equal(ctx.captures.length,4);
});
test('callbacks always acknowledged; groups, bots, wrong chat, blocked users and malformed callbacks reveal nothing',async t=>{
 const ctx=fixture(t);await ctx.callback('tds:date:2026-10-01',{message:{chat:{id:ctx.fake.user.id,type:'group'}}});await ctx.callback('tds:date:2026-10-01',{from:{id:ctx.fake.user.id,is_bot:true}});await ctx.callback('tds:enabled:morning:1',{message:{chat:{id:999,type:'private'}}});await ctx.callback('tds:date:2026-02-30');await ctx.callback('other:callback');await ctx.callback('tds:'+ 'x'.repeat(80));ctx.db.prepare("UPDATE users SET status='blocked' WHERE id=?").run(ctx.userId);await ctx.callback('tds:date:2026-10-01');await ctx.text('/today');assert.equal(ctx.acks().length,7);assert.equal(ctx.reviews.length,0);assert.equal(readSummaryPreferences(ctx.db,ctx.userId).morning.enabled,false);assert.equal(ctx.messages().some(x=>x.params.text.includes('Обзор за')),false);
});
test('async overview cannot send private result after rebind and failure callback is still acknowledged',async t=>{
 let ctx;ctx=fixture(t,{dayReview:async()=>{ctx.db.prepare("UPDATE telegram_links SET chat_id=999,linked_at='2026-10-03T12:01:00Z' WHERE user_id=?").run(ctx.userId);return{date:'2026-10-01',timeZone:'UTC',remaining:[{title:'Secret result'}],historyCoverage:{gaps:[]}};}});await ctx.callback('tds:date:2026-10-01');assert.equal(ctx.acks().length,1);assert.equal(ctx.messages().length,0);
 const failed=fixture(t,{dayReview:async()=>{throw new Error('fixture');}});await failed.callback('tds:date:2026-10-01');assert.equal(failed.acks().length,1);assert.equal(failed.messages().length,0);
});
test('bound pending mode never transfers to a new binding',async t=>{
 const ctx=fixture(t);await ctx.callback('tds:pick');ctx.db.prepare("UPDATE telegram_links SET linked_at='2026-10-03T12:01:00Z' WHERE user_id=?").run(ctx.userId);await ctx.text('2026-10-01');assert.equal(ctx.reviews.length,0);assert.equal(ctx.captures.length,1);
});
test('renderer bounds Unicode, counts omissions and renders literal plain text; unsafe links omitted',()=>{
 const item={title:'😀'.repeat(2000)+'<b>title</b>',time:'12:00',end:'13:00'};const output=renderDaySummary({date:'2026-10-01',timeZone:'UTC',phase:'evening',meetings:Array(100).fill(item),remaining:Array(100).fill(item),done:Array(100).fill(item),overdue:Array(100).fill(item),added:Array(100).fill(item),counts:{meetings:100,remaining:100,done:100,overdue:100,added:100},historyCoverage:{gaps:['History '+ '😀'.repeat(3000)]}});assert.ok(output.length<=3800);assert.equal(/(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/.test(output),false);assert.ok(output.includes('ещё'));assert.ok(output.includes('Добавлено за день'));
 for(const url of ['http://kizuna.example','https://user:password@kizuna.example','https://localhost','https://127.0.0.1','javascript:alert(1)'])assert.equal(safeSummaryLink(url,'2026-10-01'),null);assert.equal(safeSummaryLink('https://kizuna.example/sub?q=secret#other','2026-10-01'),'https://kizuna.example/sub/#today?date=2026-10-01');assert.deepEqual(summaryPreferences('{broken').weekdays,[1,2,3,4,5,6,7]);assert.equal(weekdayReviewDate('покажи в пятницу','2026-10-03'),'2026-10-02');assert.equal(weekdayReviewDate('Надо покажи в пятницу отчёт','2026-10-03'),null);
});

test('actual bot setup keeps the global command menu help-only even for an allowed owner',async t=>{
 const ctx=fixture(t);ctx.service.start();try{for(let i=0;i<100 && ctx.fake.bot.commands.length===0;i++)await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(ctx.fake.bot.commands.map(command=>command.command),['help']);}finally{await ctx.service.stop();}
});
test('invalid bare time reports error without task creation, and weekday request is anchored',async t=>{
 const ctx=fixture(t);await ctx.callback('tds:time:morning');await ctx.text('25:00');assert.equal(ctx.captures.length,0);assert.equal(readSummaryPreferences(ctx.db,ctx.userId).morning.time,'09:00');await ctx.text('08:00');assert.equal(readSummaryPreferences(ctx.db,ctx.userId).morning.time,'08:00');await ctx.text('покажи в пятницу');assert.equal(ctx.reviews.at(-1).date,'2026-10-02');await ctx.text('Надо покажи в пятницу отчёт');assert.equal(ctx.captures.length,1);
});

test('async preparation followed by current ACL reread removes revoked borrowed work including hidden counts',async t=>{
 for(const access of ['participant','circle']){
  let ctx,initial;ctx=fixture(t,{dayReview:async input=>{initial=reviewDay(ctx.db,input);await Promise.resolve();if(access==='participant')ctx.db.prepare('UPDATE capture_people SET removed_at=? WHERE user_id=?').run('2026-10-03T12:00:00Z',ctx.userId);else ctx.db.prepare('UPDATE circle_members SET left_at=? WHERE user_id=?').run('2026-10-03T12:00:00Z',ctx.userId);return initial;}});
  const owner=createUser(ctx.db,{email:`owner-${access}@example.org`,passwordHash:'test',status:'active'}).id;
  if(access==='circle'){ctx.db.prepare('INSERT INTO circles(id,name,created_by,created_at) VALUES(?,?,?,?)').run('private-circle','Private',owner,'2026-09-30T10:00:00Z');ctx.db.prepare('INSERT INTO circle_members(circle_id,user_id,role,joined_at) VALUES(?,?,?,?)').run('private-circle',ctx.userId,'member','2026-09-30T10:00:00Z');}
  for(let i=0;i<42;i++){
   const id=`private-${access}-${i}`,created='2026-09-30T10:00:00Z';ctx.db.prepare('INSERT INTO captures(id,raw,occurred_at,created_at,user_id) VALUES(?,?,?,?,?)').run(id,'Owner secret title',created,created,owner);ctx.db.prepare("INSERT INTO interpretations VALUES(?,?,1,'active','manual',NULL,?,'{}',?,NULL)").run(`${id}:i`,id,JSON.stringify({primaryType:'task',summary:'Owner secret title',entities:{schedule:{date:'2026-10-03'}}}),created);ctx.db.prepare("INSERT INTO projections VALUES(?,?,?,'task','{}','active',?,?,NULL)").run(`${id}:p`,id,`${id}:i`,id,created);ctx.db.prepare("INSERT INTO assignments(id,capture_id,assignee_id,assigner_id,state,created_at,responded_at) VALUES(?,?,?,?,'accepted',?,?)").run(`${id}:assignment`,id,ctx.userId,owner,created,created);
   if(access==='participant')ctx.db.prepare('INSERT INTO capture_people(capture_id,user_id,added_by,added_at) VALUES(?,?,?,?)').run(id,ctx.userId,owner,created);else ctx.db.prepare('INSERT INTO capture_circles(capture_id,circle_id,shared_by,shared_at) VALUES(?,?,?,?)').run(id,'private-circle',owner,created);
  }
  await ctx.callback('tds:date:2026-10-03');assert.equal(initial.counts.remaining,42);assert.equal(initial.remaining.length,40);const message=ctx.messages().at(-1).params.text;assert.equal(message.includes('Owner secret title'),false);assert.ok(message.includes('Осталось: 0'));assert.ok(message.includes('Просрочено: 0'));assert.equal(ctx.acks().length,1);assert.equal(ctx.captures.length,0);
 }
});
test('async preparation followed by current busy-mode reread removes old titles including hidden meetings',async t=>{
 let ctx,initial;ctx=fixture(t,{dayReview:async input=>{initial=reviewDay(ctx.db,input);await Promise.resolve();ctx.db.prepare("UPDATE calendar_accounts SET mode='busy' WHERE id='private-calendar'").run();return initial;}});
 ctx.db.prepare("INSERT INTO calendar_accounts(id,user_id,provider,label,credentials_enc,calendars_json,created_at) VALUES(?,?,'google','Private','mock',?,?)").run('private-calendar',ctx.userId,JSON.stringify([{id:'cal',selected:true}]),'2026-09-30T10:00:00Z');
 for(let i=0;i<42;i++)ctx.db.prepare('INSERT INTO calendar_events(id,account_id,calendar_id,uid,title,start_at,end_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(`meeting-${i}`,'private-calendar','cal',`uid-${i}`,'Private calendar title','2026-10-03T08:00:00Z','2026-10-03T09:00:00Z','2026-09-30T10:00:00Z');
 await ctx.callback('tds:date:2026-10-03');assert.equal(initial.counts.meetings,42);assert.equal(initial.meetings.length,40);const message=ctx.messages().at(-1).params.text;assert.equal(message.includes('Private calendar title'),false);assert.ok(message.includes('Занято'));assert.ok(message.includes('Встречи: 42'));assert.equal(ctx.acks().length,1);assert.equal(ctx.captures.length,0);
});

test('extension pending mode receives actual message and registered keyboard button uses common menu',async t=>{
 const ctx=fixture(t),router=ctx.service.menuRouter,link=ctx.db.prepare('SELECT * FROM telegram_links WHERE user_id=?').get(ctx.userId);let consumed;
 router.registerReplyKeyboardButton('Дополнение');router.registerPendingMode('extension',{accept:text=>text==='значение',consume:(bound,text,data,message)=>{consumed={bound,text,data,message};}});router.registerMessageRoute(async({text,link,interactions,send})=>{if(text!=='Дополнение')return false;assert.equal(interactions.get(link),null);interactions.begin(link,'extension',{marker:7});await send(link,'Введите значение',router.replyKeyboard(link));return true;});
 await ctx.text('/today');assert.deepEqual(ctx.messages()[0].params.reply_markup.keyboard[0],[DAY_SUMMARY_LABELS.today,DAY_SUMMARY_LABELS.day,'Дополнение']);router.interactions.begin(link,'date');await ctx.text('Дополнение');const message=ctx.fake.push({text:'значение'}).message;await ctx.service.pollOnce();await ctx.service.flush({force:true});assert.deepEqual(consumed.message,message);assert.equal(consumed.message.message_id,message.message_id);assert.equal(consumed.bound.user_id,link.user_id);assert.equal(consumed.data.marker,7);assert.equal(ctx.captures.length,0);
});
test('extension callback route shares auth and single acknowledgement',async t=>{
 const ctx=fixture(t);let routed=0;ctx.service.menuRouter.registerCallbackRoute(async({callback,link,interactions,send,update})=>{if(callback.data!=='extension:page:2')return false;assert.ok(Number.isInteger(update.update_id));assert.equal(link.user_id,ctx.userId);interactions.clear(link);await send(link,'Страница 2',ctx.service.menuRouter.replyKeyboard());routed++;return true;});await ctx.callback('extension:page:2');assert.equal(routed,1);assert.equal(ctx.acks().length,1);assert.equal(ctx.messages().at(-1).params.text,'Страница 2');await ctx.callback('extension:page:2',{message:{chat:{id:999,type:'private'}}});assert.equal(routed,1);assert.equal(ctx.acks().length,2);
});
test('forwarded text and file clear pending input before normal capture',async t=>{
 const ctx=fixture(t);await ctx.callback('tds:pick');await ctx.text('Пересланное',{forward_origin:{type:'hidden_user',sender_user_name:'Друг',date:1}});await ctx.text('2026-10-01');assert.equal(ctx.reviews.length,0);assert.equal(ctx.captures.length,2);
 await ctx.callback('tds:time:morning');const fileId=ctx.fake.addFile(Buffer.from('payload'),'note.txt');ctx.fake.push({document:{file_id:fileId,file_name:'note.txt'}});await ctx.service.pollOnce();await ctx.service.flush({force:true});await ctx.text('08:30');assert.equal(readSummaryPreferences(ctx.db,ctx.userId).morning.time,'09:00');assert.equal(ctx.captures.length,4);assert.equal(ctx.attachments.length,1);
});
test('handled preflight sees original update and prevents pending clear/capture; callback still acknowledged',async t=>{
 const ctx=fixture(t),router=ctx.service.menuRouter,link=ctx.db.prepare('SELECT * FROM telegram_links WHERE user_id=?').get(ctx.userId),seen=[];router.interactions.begin(link,'date');router.registerPreflight(async input=>{seen.push(input);return [42,43].includes(input.message?.message_id)||input.callback?.data==='tds:enabled:morning:1';});const update=ctx.fake.push({message_id:42,text:'Пересланное',forward_origin:{type:'hidden_user',sender_user_name:'Друг',date:1}});await ctx.service.pollOnce();await ctx.service.flush({force:true});assert.deepEqual(seen[0].update,update);assert.deepEqual(seen[0].message,update.message);assert.equal(seen[0].link.user_id,ctx.userId);assert.equal(router.interactions.get(link).mode,'date');assert.equal(ctx.captures.length,0);
 const fileId=ctx.fake.addFile(Buffer.from('ignored duplicate'),'note.txt');ctx.fake.push({message_id:43,document:{file_id:fileId,file_name:'note.txt'}});await ctx.service.pollOnce();await ctx.service.flush({force:true});assert.equal(ctx.captures.length,0);assert.equal(ctx.attachments.length,0);assert.equal(router.interactions.get(link).mode,'date');
 await ctx.callback('tds:enabled:morning:1');assert.equal(ctx.acks().length,1);assert.equal(router.interactions.get(link).mode,'date');assert.equal(readSummaryPreferences(ctx.db,ctx.userId).morning.enabled,false);await ctx.text('2026-10-01');assert.equal(ctx.reviews.at(-1).date,'2026-10-01');
});


test('/start invalid and used codes cancel pending; valid code rebinds, preflight skips before both',async t=>{
 const ctx=fixture(t),router=ctx.service.menuRouter,oldLink=ctx.db.prepare('SELECT * FROM telegram_links WHERE user_id=?').get(ctx.userId);router.interactions.begin(oldLink,'date');await ctx.text('/start invalid');assert.equal(router.interactions.get(oldLink),null);await ctx.text('2026-10-01');assert.equal(ctx.reviews.length,0);assert.equal(ctx.captures.length,1);
 const other=createUser(ctx.db,{email:'rebound@example.org',passwordHash:'test',status:'active'}).id,issued=await ctx.service.createLink(other,'https://kizuna.example'),code=new URL(issued.url).searchParams.get('start');router.interactions.begin(oldLink,'date');let preflights=0;router.registerPreflight(({message})=>{preflights++;return message?.message_id===4242;});const before=ctx.messages().length;await ctx.text(`/start ${code}`,{message_id:4242});assert.equal(preflights,1);assert.equal(ctx.messages().length,before);assert.equal(router.interactions.get(oldLink).mode,'date');assert.equal(ctx.db.prepare('SELECT user_id FROM telegram_links WHERE telegram_id=?').get(ctx.fake.user.id).user_id,ctx.userId);
 await ctx.text(`/start ${code}`);assert.equal(preflights,2);assert.equal(router.interactions.get(oldLink),null);const newLink=ctx.db.prepare('SELECT * FROM telegram_links WHERE telegram_id=?').get(ctx.fake.user.id);assert.equal(newLink.user_id,other);router.interactions.begin(newLink,'extension',{phase:'morning'});await ctx.text(`/start ${code}`);assert.equal(preflights,3);assert.equal(router.interactions.get(newLink),null);assert.equal(readSummaryPreferences(ctx.db,other).morning.time,'09:00');
});


test('non-owner direct commands show legacy help and plain buttons, weekdays, forwards and files stay capture',async t=>{
 const ctx=fixture(t,{access:false});
 for(const text of ['/today','/day 2026-10-01','/day invalid extra arguments','/settings','/help']){await ctx.text(text);assert.match(ctx.messages().at(-1).params.text,/Пишите сюда/);assert.equal(ctx.messages().at(-1).params.reply_markup,undefined);}
 for(const text of Object.values(DAY_SUMMARY_LABELS))await ctx.text(text);
 await ctx.text('покажи в понедельник');await ctx.text('/today',{forward_origin:{type:'hidden_user',sender_user_name:'Друг',date:1}});
 const fileId=ctx.fake.addFile(Buffer.from('payload'),'note.txt');ctx.fake.push({document:{file_id:fileId,file_name:'note.txt'}});await ctx.service.pollOnce();await ctx.service.flush({force:true});
 assert.equal(ctx.captures.length,6);assert.equal(ctx.reviews.length,0);assert.equal(ctx.changes,0);assert.equal(ctx.attachments.length,1);
 for(const data of ['tds:date:2026-10-01','tds:pick','tds:time:morning','tds:enabled:morning:1','tds:weekday:1:0'])await ctx.callback(data);
 assert.equal(ctx.acks().length,5);assert.equal(ctx.reviews.length,0);assert.equal(ctx.changes,0);assert.equal(ctx.service.menuRouter.currentReview(ctx.db.prepare('SELECT * FROM telegram_links').get(),{date:'2026-10-03'}),null);
 assert.equal(readSummaryPreferences(ctx.db,ctx.userId).morning.enabled,false);
});
test('revoked built-in pending date and time clear and their next values become captures; extension mode remains independent',async t=>{
 for(const [callback,value]of [['tds:pick','2026-10-01'],['tds:time:morning','08:30']]){const ctx=fixture(t);await ctx.callback(callback);ctx.setAccess(false);await ctx.text(value);assert.equal(ctx.captures.length,1);assert.equal(ctx.reviews.length,0);assert.equal(ctx.changes,0);assert.equal(ctx.service.menuRouter.interactions.get(ctx.db.prepare('SELECT * FROM telegram_links').get()),null);}
 const ctx=fixture(t,{access:false}),router=ctx.service.menuRouter,link=ctx.db.prepare('SELECT * FROM telegram_links').get();let calls=0;
 router.registerPendingMode('search',{accept:text=>text==='find',consume:()=>{calls++;}});router.interactions.begin(link,'search');await ctx.text('find');assert.equal(calls,1);assert.equal(ctx.captures.length,0);
 router.registerCallbackRoute(({callback})=>{if(callback.data!=='search:page')return false;calls++;return true;});await ctx.callback('search:page');assert.equal(calls,2);
 router.registerReplyKeyboardButton('Найти');assert.deepEqual(router.replyKeyboard(link).keyboard,[['Найти']]);
});
test('router default denies day namespace before preflights and data reads, still ACKs callbacks',async()=>{
 const link={user_id:'00000000-0000-0000-0000-000000000001',telegram_id:1,chat_id:1,linked_at:'stamp'};let acks=0,reads=0,preflights=0;
 const router=createTelegramDaySummaryRouter({db:{prepare(){reads++;throw Error('must not read');}},authorize:()=>link,currentBinding:()=>true,send:()=>{throw Error('must not send');},acknowledge:()=>{acks++;return Promise.resolve();},timeZone:()=>{throw Error('must not read timezone');},review:()=>{throw Error('must not review');}});
 router.registerPreflight(()=>{preflights++;return false;});assert.equal(await router.routeCallback({id:'a',data:'tds:enabled:morning:1'}),true);assert.equal(acks,1);assert.equal(preflights,0);assert.equal(reads,0);assert.equal(router.currentReview(link,{}),null);assert.equal(router.replyKeyboard(link),undefined);
});
test('access revoked during async manual review suppresses day data and navigation',async t=>{
 let ctx;ctx=fixture(t,{dayReview:async()=>{ctx.setAccess(false);return{};}});await ctx.text('/today');assert.equal(ctx.messages().length,1);assert.equal(ctx.messages()[0].params.reply_markup.keyboard[0][0],DAY_SUMMARY_LABELS.today);assert.equal(ctx.reviews.length,1);assert.equal(ctx.changes,0);
});
