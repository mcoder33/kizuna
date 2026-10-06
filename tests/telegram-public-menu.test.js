import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { createUser, createLedger } from '../server/db.js';
import { fakeModelService } from './helpers/fake-model.js';
import { createFakeTelegram } from './helpers/fake-telegram.js';
import { createTelegramDaySummaryAccess, createTelegramTaskSearchAccess } from '../server/telegram-day-access.js';
import { installTelegramTaskSearch } from '../server/telegram-search.js';
import { readSummaryPreferences } from '../server/telegram-day-summary.js';

function fixture(t) {
  const fake = createFakeTelegram(), now = () => new Date('2031-10-03T12:00:00Z');
  const app = createApp({databasePath: ':memory:', now, aiService: fakeModelService({now}), telegramFetch: fake.fetch,
    telegramOptions: {token:()=>fake.token, groupWindowMs:0, avatar:()=>null}});
  const db=app.database;
  const owner=createUser(db,{email:'owner@public-menu.test',passwordHash:'test',status:'active'}).id;
  const other=createUser(db,{email:'other@public-menu.test',passwordHash:'test',status:'active'}).id;
  for(const [id,telegramId] of [[owner,100],[other,200]]) db.prepare('INSERT INTO telegram_links(user_id,telegram_id,chat_id,linked_at,app_url) VALUES(?,?,?,?,?)').run(id,telegramId,telegramId,'2031-10-01T00:00:00Z','https://yourkizuna.com/');
  const envNames=['PAGENT_TELEGRAM_TASK_SEARCH_USER_IDS','PAGENT_TELEGRAM_DAY_SUMMARY_USER_IDS'];
  const previous=envNames.map(name=>process.env[name]);
  delete process.env.PAGENT_TELEGRAM_TASK_SEARCH_USER_IDS;
  process.env.PAGENT_TELEGRAM_DAY_SUMMARY_USER_IDS=owner;
  t.after(async()=>{await app.telegram.stop();db.close();envNames.forEach((name,i)=>{if(previous[i]===undefined)delete process.env[name];else process.env[name]=previous[i];});});
  const messages=()=>fake.sent.filter(item=>['sendMessage','sendPhoto'].includes(item.method)).map(item=>({...item,params:{...item.params,text:item.params.text??item.params.caption}}));
  return {app,db,fake,owner,other,messages, async text(text,id=200){fake.push({text,from:{id,is_bot:false}});await app.telegram.pollOnce();await app.telegram.flush({force:true});},
    async callback(data,id=200,messageId=5000){fake.pushCallback(data,{from:{id,is_bot:false},message:{message_id:messageId,chat:{id,type:'private'}}});await app.telegram.pollOnce();}};
}

test('public summary access is independent of strict search configuration and fails closed for invalid identities',()=>{
 const day=createTelegramDaySummaryAccess();assert.equal(day('0c78ff8a-cdbb-43f4-a261-382d36b5ccec'),true);for(const id of [null,'','*','not-a-user'])assert.equal(day(id),false);
 let value='';const search=createTelegramTaskSearchAccess({userIds:()=>value});assert.equal(search('0c78ff8a-cdbb-43f4-a261-382d36b5ccec'),false);value='*';assert.equal(search('0c78ff8a-cdbb-43f4-a261-382d36b5ccec'),false);
});

test('production app opens summary/calendar/settings/search to other active users while preserving own data',async t=>{
 const f=fixture(t);
 for(const [userId,title] of [[f.owner,'OWNER PRIVATE TASK'],[f.other,'OTHER PERSONAL TASK']])createLedger(f.db,{userId,raw:title,classification:{primaryType:'task',summary:title,entities:{schedule:{date:'2031-10-03'}}},provider:'manual',occurredAt:'2031-10-03T12:00:00Z'});
 await f.text('/help');const keyboard=f.messages().at(-1).params.reply_markup.keyboard.flat();assert.ok(keyboard.includes('🗓 Другой день'));assert.ok(keyboard.includes('Найти'));
 await f.text('☀️ Сегодня');const summary=f.messages().at(-1).params.text;assert.ok(summary.includes('OTHER PERSONAL TASK'));assert.equal(summary.includes('OWNER PRIVATE TASK'),false);
 await f.text('🗓 Другой день');const calendar=f.messages().at(-1);assert.match(calendar.params.text,/Октябрь 2031/);const rows=calendar.params.reply_markup.inline_keyboard;
 await f.callback(rows[0][2].callback_data,200,calendar.result.message_id);assert.equal(f.fake.sent.at(-1).method,'editMessageText');assert.match(f.fake.sent.at(-1).params.text,/Ноябрь 2031/);
 await f.text('⚙️ Настройки сводок');assert.match(f.messages().at(-1).params.text,/Утро: выключено/);assert.equal(readSummaryPreferences(f.db,f.other).morning.enabled,false);
 await f.callback('tds:pick');await f.text('2031-10-02');assert.equal(f.messages().at(-1).params.reply_markup,undefined);assert.match(f.messages().at(-1).params.text,/2 октября 2031/);
 await f.callback('tds:time:morning');await f.text('08:30');assert.equal(readSummaryPreferences(f.db,f.other).morning.time,'08:30');
 const before=f.db.prepare('SELECT count(*) n FROM captures').get().n;
 await f.text('Найти');assert.match(f.messages().at(-1).params.text,/Что найти/);
 await f.text('TASK');const result=f.messages().at(-1).params.text;assert.match(result,/Найдено: 1/);assert.ok(result.includes('OTHER PERSONAL TASK'));assert.equal(result.includes('OWNER PRIVATE TASK'),false);
 await f.callback('ts:page:'+ 'a'.repeat(32));
 assert.equal(f.db.prepare('SELECT count(*) n FROM task_search_intents').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM captures').get().n,before);
 await f.text('/find',100);assert.match(f.messages().at(-1).params.text,/Что найти/);assert.ok(f.messages().at(-1).params.reply_markup.keyboard.flat().includes('Найти'));
});

test('startup publishes Find for all existing private bindings and capture refreshes old keyboards without announcements',async t=>{
 const f=fixture(t);f.app.telegram.start();
 for(let i=0;i<100 && !f.fake.bot.scopedCommands.has('200');i++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.deepEqual(f.fake.bot.commands.map(x=>x.command),['help']);assert.deepEqual(f.fake.bot.scopedCommands.get('200').map(x=>x.command),['today','day','settings','help','find']);assert.ok(f.fake.bot.scopedCommands.get('100').some(x=>x.command==='find'));
 assert.equal(f.messages().length,0,'publishing scoped commands sends no user-facing announcement');
 await f.app.telegram.stop();await f.text('Сохранить обычную задачу');const saving=f.messages().find(item=>item.params.chat_id===200 && item.params.text.startsWith('✍️'));assert.ok(saving.params.reply_markup.keyboard.flat().includes('🗓 Другой день'));assert.ok(saving.params.reply_markup.keyboard.flat().includes('Найти'));
});

test('public access still denies inactive, unlinked and mismatched Telegram identities',async t=>{
 const f=fixture(t);f.db.prepare("UPDATE users SET status='blocked' WHERE id=?").run(f.other);await f.text('/today');await f.callback('tds:date:2031-10-03');await f.text('/find');assert.equal(f.messages().some(x=>/^📅 Обзор|Что найти/.test(x.params.text)),false);
 f.db.prepare("UPDATE users SET status='active' WHERE id=?").run(f.other);f.db.prepare('UPDATE telegram_links SET chat_id=999 WHERE user_id=?').run(f.other);await f.text('🗓 Другой день');await f.text('/find');assert.equal(f.messages().some(x=>x.params.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data?.startsWith('tds:cal:')) || /Что найти/.test(x.params.text)),false);
 f.db.prepare('DELETE FROM telegram_links WHERE user_id=?').run(f.other);await f.text('/find');assert.equal(f.messages().some(x=>/Что найти|Найдено:/.test(x.params.text)),false);
});

test('search plugin default grants all valid users independently of legacy owner allowlists',async t=>{
 const f=fixture(t);const link=f.db.prepare('SELECT * FROM telegram_links WHERE user_id=?').get(f.other);
 const router=(await import('../server/telegram-day-summary.js')).createTelegramDaySummaryRouter({db:f.db,canAccess:createTelegramDaySummaryAccess(),authorize:()=>link,currentBinding:()=>true,now:()=>new Date(),timeZone:()=> 'UTC',review:()=>{},send:async()=>{},acknowledge:async()=>{}});
 installTelegramTaskSearch({menuRouter:router,db:f.db});assert.ok(router.replyKeyboard(link).keyboard.flat().includes('Найти'));
 assert.equal(createTelegramTaskSearchAccess({userIds:null})(f.other),true);
 for(const id of [null,'','*','not-a-user'])assert.equal(createTelegramTaskSearchAccess()(id),false);
});
