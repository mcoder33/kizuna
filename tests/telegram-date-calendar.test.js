import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, createUser, createLedger } from '../server/db.js';
import { createTelegramService } from '../server/telegram.js';
import { createFakeTelegram } from './helpers/fake-telegram.js';
import { renderTelegramDateCalendar, shiftCalendarMonth, createTelegramDateCalendar, CALENDAR_TTL_MS } from '../server/telegram-date-calendar.js';
import { readSummaryPreferences } from '../server/telegram-day-summary.js';

const TOKEN='previewToken';
const render=(month,today=`${month}-01`)=>renderTelegramDateCalendar({month,today,token:TOKEN,timeZone:'Europe/Samara'});
const allButtons=frame=>frame.reply_markup.inline_keyboard.flat();
const dayButtons=frame=>allButtons(frame).filter(button=>/:date:/.test(button.callback_data));
function fixture(t,{zone='Europe/Samara',at='2026-10-03T12:00:00Z',access=true,prepare=null,transport=null}={}){
 const db=openDatabase(':memory:');t.after(()=>db.close());const userId=createUser(db,{email:'calendar@example.test',passwordHash:'test',status:'active'}).id,fake=createFakeTelegram();
 let clock=new Date(at),allowed=access;const captures=[],reviews=[];
 db.prepare('INSERT INTO telegram_links(user_id,telegram_id,chat_id,app_url,linked_at) VALUES(?,?,?,?,?)').run(userId,fake.user.id,fake.user.id,'https://kizuna.example','2026-10-01T12:00:00Z');
 const service=createTelegramService({db,token:()=>fake.token,fetch:transport ? async(url,init)=>{await transport(url,init);return fake.fetch(url,init);} : fake.fetch,canAccessDaySummary:id=>allowed && id===userId,now:()=>clock,clock:()=>clock.getTime(),timeZone:()=>zone,userActive:id=>db.prepare('SELECT status FROM users WHERE id=?').get(id)?.status==='active',groupWindowMs:0,
  dayReview:async input=>{reviews.push(input);await prepare?.(input);return{};},finalDayReview:input=>({...input,meetings:[],done:[],remaining:[],overdue:[],added:[],historyCoverage:{gaps:[]}}),
  queueCapture:async input=>{captures.push(input);const saved=createLedger(db,{raw:input.raw,userId:input.userId,classification:{primaryType:'task',summary:input.raw,entities:{}},provider:'manual'});return{captureId:saved.captureId,jobId:`calendar-job-${captures.length}`};},describe:()=>null});
 const messages=()=>fake.sent.filter(item=>['sendMessage','editMessageText'].includes(item.method));
 return{db,userId,fake,service,captures,reviews,messages,setAccess:value=>{allowed=value;},setNow:value=>{clock=new Date(value);},link:()=>db.prepare('SELECT * FROM telegram_links WHERE user_id=?').get(userId),
  async text(text,fields={}){fake.push({text,...fields});await service.pollOnce();await service.flush({force:true});},
  async click(button,messageId,fields={}){fake.pushCallback(typeof button==='string'?button:button.callback_data,{message:{message_id:messageId,chat:{id:fake.user.id,type:'private'}},...fields});await service.pollOnce();},
  calendar:()=>{const item=messages().filter(item=>item.params.reply_markup?.inline_keyboard?.flat().some(button=>button.callback_data?.startsWith('tds:cal:'))).at(-1);return{frame:{text:item.params.text,reply_markup:item.params.reply_markup},messageId:item.result?.message_id??item.params.message_id};}};
}

test('month grid aligns Monday first, includes every date once, labels today and uses bounded no-op blanks/headings',()=>{
 const frame=render('2026-10','2026-10-03'),rows=frame.reply_markup.inline_keyboard;
 assert.equal(frame.text,'🗓 Октябрь 2026\nВыберите день. Часовой пояс: Europe/Samara');assert.deepEqual(rows[1].map(button=>button.text),['Пн','Вт','Ср','Чт','Пт','Сб','Вс']);
 assert.deepEqual(rows[2].map(button=>button.text),['·','·','·','1','2','[3]','4']);assert.equal(dayButtons(frame).length,31);assert.equal(new Set(dayButtons(frame).map(button=>button.callback_data)).size,31);
 for(const button of allButtons(frame)){assert.ok(Buffer.byteLength(button.callback_data)<=64);if(button.text==='·' || ['Пн','Вт','Ср','Чт','Пт','Сб','Вс','Октябрь 2026'].includes(button.text))assert.ok(button.callback_data.endsWith(':noop'));}
 assert.deepEqual(render('2025-12').reply_markup.inline_keyboard[2].map(button=>button.text),['[1]','2','3','4','5','6','7']);
});
test('leap centuries and December/January transitions remain exact; malformed months rejected and limits noop',()=>{
 for(const [month,days]of [['2024-02',29],['2023-02',28],['2000-02',29],['2100-02',28],['2026-04',30]])assert.equal(dayButtons(render(month)).length,days);
 assert.equal(shiftCalendarMonth('2026-12',1),'2027-01');assert.equal(shiftCalendarMonth('2026-01',-1),'2025-12');assert.equal(shiftCalendarMonth('2026-13',1),null);assert.equal(shiftCalendarMonth('2026-01',2),null);
 assert.ok(render('0100-01').reply_markup.inline_keyboard[0][0].callback_data.endsWith(':noop'));assert.ok(render('9999-12').reply_markup.inline_keyboard[0][2].callback_data.endsWith(':noop'));
 assert.throws(()=>render('2026-13'),RangeError);assert.throws(()=>renderTelegramDateCalendar({month:'2026-02',today:'2026-02-30',token:TOKEN}),RangeError);
});
test('Other day opens personal current month; month changes edit same message and reject stale buttons',async t=>{
 const ctx=fixture(t,{zone:'Pacific/Kiritimati',at:'2026-12-31T12:00:00Z'});await ctx.text('🗓 Другой день');let issued=ctx.calendar();assert.match(issued.frame.text,/Январь 2027/);assert.ok(dayButtons(issued.frame).some(button=>button.text==='[1]'));const old=issued;
 await ctx.click(issued.frame.reply_markup.inline_keyboard[0][0],issued.messageId);issued=ctx.calendar();assert.match(issued.frame.text,/Декабрь 2026/);assert.equal(issued.messageId,old.messageId);assert.equal(ctx.messages().at(-1).method,'editMessageText');
 const length=ctx.messages().length;await ctx.click(dayButtons(old.frame)[0],old.messageId);assert.equal(ctx.messages().length,length);assert.equal(ctx.reviews.length,0);
 await ctx.click(issued.frame.reply_markup.inline_keyboard[0][2],issued.messageId);issued=ctx.calendar();assert.match(issued.frame.text,/Январь 2027/);
 await ctx.click(allButtons(issued.frame).find(button=>button.text==='☀️ Сегодня'),issued.messageId);assert.equal(ctx.reviews.at(-1).date,'2027-01-01');assert.equal(ctx.captures.length,0);assert.equal(readSummaryPreferences(ctx.db,ctx.userId).morning.enabled,false);assert.equal(readSummaryPreferences(ctx.db,ctx.userId).evening.enabled,false);
});
test('day selection uses exact date with no capture, repeated and issued-on-another-message callbacks are ignored',async t=>{
 const ctx=fixture(t);await ctx.text('/day');const issued=ctx.calendar(),button=dayButtons(issued.frame).find(button=>button.callback_data.endsWith('2026-10-21'));
 await ctx.click(button,issued.messageId+1);assert.equal(ctx.reviews.length,0);await ctx.click(button,issued.messageId);assert.equal(ctx.reviews.at(-1).date,'2026-10-21');assert.match(ctx.messages().at(-1).params.text,/21 октября 2026/);assert.ok(ctx.messages().at(-1).params.reply_markup.inline_keyboard[1][0].url.endsWith('date=2026-10-21'));
 await ctx.click(button,issued.messageId);assert.equal(ctx.reviews.length,1);assert.equal(ctx.captures.length,0);assert.equal(ctx.fake.sent.filter(item=>item.method==='answerCallbackQuery').length,3);
});
test('headings, blanks, forged dates/months and malformed callbacks are no-ops without changing pending search',async t=>{
 const ctx=fixture(t);await ctx.text('/day');const issued=ctx.calendar(),token=dayButtons(issued.frame)[0].callback_data.split(':')[2],router=ctx.service.menuRouter;router.interactions.begin(ctx.link(),'search',{query:'keep'});
 const callbacks=[issued.frame.reply_markup.inline_keyboard[0][1].callback_data,issued.frame.reply_markup.inline_keyboard[1][0].callback_data,issued.frame.reply_markup.inline_keyboard[2][0].callback_data,`tds:cal:${token}:date:2026-10-32`,`tds:cal:${token}:date:2026-11-01`,`tds:cal:${token}:month:2027-12`,`tds:cal:${token}:month:2026-13`,`tds:cal:${token}:bad`,'tds:cal:'+ 'x'.repeat(70)];
 const count=ctx.messages().length;for(const data of callbacks)await ctx.click(data,issued.messageId);assert.equal(ctx.messages().length,count);assert.equal(ctx.reviews.length,0);assert.equal(ctx.captures.length,0);assert.equal(router.interactions.get(ctx.link()).data.query,'keep');assert.equal(ctx.fake.sent.filter(item=>item.method==='answerCallbackQuery').length,callbacks.length);
 await ctx.click(issued.frame.reply_markup.inline_keyboard[0][2],issued.messageId);assert.equal(router.interactions.get(ctx.link()).mode,'search');
});
test('calendar never consumes ordinary notes or bare dates; explicit manual date and existing day command still work',async t=>{
 const ctx=fixture(t);await ctx.text('/day');const issued=ctx.calendar();await ctx.text('Обычная заметка');await ctx.text('2026-10-10');assert.equal(ctx.captures.length,2);assert.equal(ctx.reviews.length,0);
 await ctx.click(allButtons(issued.frame).find(button=>button.text==='⌨️ Ввести дату'),issued.messageId);await ctx.text('10.10.2026');assert.equal(ctx.reviews.at(-1).date,'2026-10-10');assert.equal(ctx.captures.length,2);
 await ctx.text('/day 2026-09-29');assert.equal(ctx.reviews.at(-1).date,'2026-09-29');
});
test('nonowner, revoked access, expired context, rebind and replacement calendars reject callbacks while ACKing',async t=>{
 const denied=fixture(t,{access:false});await denied.text('/day');assert.equal(denied.messages().some(item=>item.params.text.includes('Выберите день')),false);
 for(const mutation of ['access','expiry','binding','replace']){const ctx=fixture(t);await ctx.text('/day');const issued=ctx.calendar(),button=dayButtons(issued.frame)[0];
  if(mutation==='access')ctx.setAccess(false);if(mutation==='expiry')ctx.setNow('2026-10-03T12:10:00Z');if(mutation==='binding')ctx.db.prepare("UPDATE telegram_links SET linked_at='2026-10-03T12:01:00Z' WHERE user_id=?").run(ctx.userId);if(mutation==='replace')await ctx.text('/day');
  const count=ctx.messages().length;await ctx.click(button,issued.messageId);assert.equal(ctx.reviews.length,0,mutation);assert.equal(ctx.messages().length,count,mutation);assert.equal(ctx.captures.length,0);assert.equal(ctx.fake.sent.filter(item=>item.method==='answerCallbackQuery').length,1);
 }
});
test('revocation during async selected review sends no private result; repeated callbacks during build do not duplicate',async t=>{
 let ctx,release,entered;const barrier=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 ctx=fixture(t,{prepare:async()=>{entered();await barrier;ctx.setAccess(false);}});await ctx.text('/day');const issued=ctx.calendar(),button=dayButtons(issued.frame)[0],pending=ctx.click(button,issued.messageId);await started;
 const repeat=ctx.fake.pushCallback(button.callback_data,{message:{message_id:issued.messageId,chat:{id:ctx.fake.user.id,type:'private'}}});await ctx.service.menuRouter.routeCallback(repeat.callback_query,{update:repeat});release();await pending;
 assert.equal(ctx.reviews.length,1);assert.equal(ctx.messages().length,2);assert.equal(ctx.captures.length,0);
});
test('direct calendar bounds contexts and cannot retain access after asynchronous sends or edits',async()=>{
 let allowed=true,clock=new Date('2026-10-03T12:00:00Z'),message=50,frames=[],edits=0,reviews=0;
 const link=id=>({user_id:id,telegram_id:1,chat_id:1,linked_at:'old'});
 const calendar=createTelegramDateCalendar({now:()=>clock,limit:1,fresh:()=>allowed,todayOf:()=> '2026-10-03',timeZone:()=> 'UTC',send:async(bound,text,markup)=>{frames.push({bound,markup,messageId:message++});return{message_id:message-1};},edit:async()=>{edits++;allowed=false;return{message_id:51};},showReview:async()=>{reviews++;},manualDate:async()=>{}});
 await calendar.open(link('a'));const first=frames.at(-1);await calendar.open(link('b'));const second=frames.at(-1);await calendar.route(link('a'),{data:first.markup.inline_keyboard[2][3].callback_data,message:{message_id:first.messageId}});assert.equal(reviews,0);
 await calendar.route(link('b'),{data:second.markup.inline_keyboard[0][2].callback_data,message:{message_id:second.messageId}});assert.equal(edits,1);allowed=true;await calendar.route(link('b'),{data:second.markup.inline_keyboard[2][3].callback_data,message:{message_id:second.messageId}});assert.equal(reviews,0);
 clock=new Date(clock.getTime()+CALENDAR_TTL_MS);await calendar.route(link('b'),{data:second.markup.inline_keyboard[2][3].callback_data,message:{message_id:second.messageId}});assert.equal(reviews,0);
});


test('calendar send completing after revocation leaves no usable context even if access returns',async()=>{
 const link={user_id:'owner',telegram_id:1,chat_id:1,linked_at:'stamp'};let allowed=true,markup,reviews=0;
 const calendar=createTelegramDateCalendar({fresh:()=>allowed,todayOf:()=> '2026-10-03',timeZone:()=> 'UTC',send:async(_,text,keyboard)=>{markup=keyboard;await Promise.resolve();allowed=false;return{message_id:42};},showReview:async()=>{reviews++;},manualDate:async()=>{}});
 await calendar.open(link);allowed=true;await calendar.route(link,{data:markup.inline_keyboard[2][3].callback_data,message:{message_id:42}});assert.equal(reviews,0);
});
