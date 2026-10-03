import { writeSettings } from './db.js';
import { dateInZone, shiftDate } from './reports.js';
import { validIsoDate } from './repeat.js';
import { reviewDay } from './day-review.js';

export const DAY_SUMMARY_LABELS = { today:'☀️ Сегодня', day:'🗓 Другой день', settings:'⚙️ Настройки сводок' };
export const DAY_SUMMARY_COMMANDS = [
  {command:'today',description:'Задачи и встречи сегодня'},
  {command:'day',description:'Обзор выбранного дня'},
  {command:'settings',description:'Утренние и вечерние сводки'},
];
export const INTERACTION_TTL_MS = 10 * 60 * 1000;
export const summarySettingsKey = userId => `user:${userId}:telegramDaySummary`;
export const validSummaryTime = value => typeof value==='string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const phases = ['morning','evening'];
const weekdays = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
const bindingKey = link => JSON.stringify([link.user_id,String(link.telegram_id),String(link.chat_id),link.linked_at]);

export function summaryPreferences(value) {
  let raw={};try{raw=typeof value==='string'?JSON.parse(value):value||{};}catch{}
  return {
    morning:{enabled:raw?.morning?.enabled===true,time:validSummaryTime(raw?.morning?.time)?raw.morning.time:'09:00',activatedAt:typeof raw?.morning?.activatedAt==='string' && Number.isFinite(Date.parse(raw.morning.activatedAt))?raw.morning.activatedAt:null},
    evening:{enabled:raw?.evening?.enabled===true,time:validSummaryTime(raw?.evening?.time)?raw.evening.time:'20:00',activatedAt:typeof raw?.evening?.activatedAt==='string' && Number.isFinite(Date.parse(raw.evening.activatedAt))?raw.evening.activatedAt:null},
    weekdays:Array.isArray(raw?.weekdays)?[...new Set(raw.weekdays.filter(day=>Number.isInteger(day)&&day>=1&&day<=7))].sort((a,b)=>a-b):[1,2,3,4,5,6,7],
  };
}
export function readSummaryPreferences(db,userId) {return summaryPreferences(db.prepare('SELECT value FROM app_settings WHERE key=?').get(summarySettingsKey(userId))?.value);}
export function changeSummaryPreferences(db,userId,change,{now=new Date(),onChanged=()=>{}}={}) {
  const before=readSummaryPreferences(db,userId),next=structuredClone(before);
  if (change.type==='enabled' && phases.includes(change.phase) && typeof change.value==='boolean') next[change.phase].enabled=change.value;
  else if (change.type==='time' && phases.includes(change.phase) && validSummaryTime(change.value)) next[change.phase].time=change.value;
  else if (change.type==='weekday' && Number.isInteger(change.day) && change.day>=1 && change.day<=7 && typeof change.value==='boolean') next.weekdays=[...new Set([...next.weekdays.filter(day=>day!==change.day),...(change.value?[change.day]:[])])].sort((a,b)=>a-b);
  else throw new RangeError('Invalid summary preference');
  for (const phase of phases) if (next[phase].enabled && (!before[phase].enabled || next[phase].time!==before[phase].time || next.weekdays.join(',')!==before.weekdays.join(','))) next[phase].activatedAt=now.toISOString();
  if (JSON.stringify(next)!==JSON.stringify(before)) {const stored=writeSettings(db,{[summarySettingsKey(userId)]:JSON.stringify(next)});onChanged(stored,userId);}
  return next;
}
export function summaryReplyKeyboard(extraButtons=[]) {
  const keyboard=[[DAY_SUMMARY_LABELS.today,DAY_SUMMARY_LABELS.day],[DAY_SUMMARY_LABELS.settings]];
  for(const {text,row=0} of extraButtons)if(typeof text==='string' && text && Number.isInteger(row) && row>=0 && row<=2){if(!keyboard[row])keyboard[row]=[];if(!keyboard[row].includes(text))keyboard[row].push(text);}
  return {keyboard,resize_keyboard:true,is_persistent:true};
}
export function safeSummaryLink(appUrl,date) {
  if (!validIsoDate(date)) return null;
  try {
    const url=new URL(appUrl),host=url.hostname.toLowerCase();
    if(url.protocol!=='https:'||url.username||url.password||host==='localhost'||host.endsWith('.localhost')||/^[\d.]+$/.test(host)||host.includes(':'))return null;
    url.search='';url.hash='';url.pathname=url.pathname.replace(/\/+$/,'')+'/';url.hash=`today?date=${date}`;return url.toString();
  }catch{return null;}
}
export function summaryNavigation(date,today,appUrl) {
  const rows=[[{text:'← День',callback_data:`tds:date:${shiftDate(date,-1)}`},{text:'Сегодня',callback_data:`tds:date:${today}`},{text:'День →',callback_data:`tds:date:${shiftDate(date,1)}`}]];
  const url=safeSummaryLink(appUrl,date);if(url)rows.push([{text:'Открыть в Кизуне',url}]);return{inline_keyboard:rows};
}
export function truncateTelegramText(value,max) {
  const text=String(value||'');if(text.length<=max)return text;
  let end=Math.max(0,max-1);if(end>0 && /[\uD800-\uDBFF]/.test(text[end-1]) && /[\uDC00-\uDFFF]/.test(text[end]))end--;
  return text.slice(0,end)+'…';
}
export function renderDaySummary(review) {
  const heading=review.phase==='morning'?'☀️ План на':review.phase==='evening'?'🌙 Итоги за':'📅 Обзор за';
  const formatted=new Intl.DateTimeFormat('ru-RU',{timeZone:'UTC',day:'numeric',month:'long',year:'numeric'}).format(new Date(`${review.date}T12:00:00Z`));
  const lines=[`${heading} ${formatted}`,`Часовой пояс: ${truncateTelegramText(review.timeZone,80)}`];
  const selected=[['meetings','🗓 Встречи'],['done','✅ Сделано'],['remaining','📌 Осталось'],['overdue','⏰ Просрочено']];
  if(review.phase==='evening')selected.push(['added','➕ Добавлено за день']);
  for(const [key,label]of selected){
    const items=review[key]||[],count=review.counts?.[key]??items.length;let shown=0,body='';
    for(const item of items){const when=key==='meetings'?`${item.allDay?'весь день':item.time||'без времени'}${item.end&&!item.allDay?`–${item.end}`:''} · `:'';const line=`• ${when}${truncateTelegramText(String(item.title||'Без названия').replace(/\s+/g,' '),140)}\n`;if(body.length+line.length>400||shown>=4)break;body+=line;shown++;}
    const rest=count-shown;lines.push(`\n${label}: ${count}`,body.trimEnd()||(review.historyCoverage?.gaps?.length?'По доступным данным — нет.':'Нет.'));if(rest>0)lines.push(`…ещё ${rest}`);
  }
  const gaps=review.historyCoverage?.gaps||[];if(gaps.length)lines.push(`\n⚠️ ${truncateTelegramText(gaps.join('\n'),850)}`);
  return truncateTelegramText(lines.join('\n'),3800);
}
export function selectedReviewDate(value) {
  if(validIsoDate(value))return value;
  const dotted=/^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value||'');const date=dotted?`${dotted[3]}-${dotted[2]}-${dotted[1]}`:null;return validIsoDate(date)?date:null;
}
export function weekdayReviewDate(text,today) {
  const requested=/^покажи(?:\s+в)?\s+(понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)$/i.exec(text.trim());if(!requested)return null;
  const index=['воскресенье','понедельник','вторник','среду','четверг','пятницу','субботу'].indexOf(requested[1].toLowerCase());
  const current=new Date(`${today}T12:00:00Z`).getUTCDay();return shiftDate(today,-((current-index+7)%7));
}

// Binding-scoped modes can be extended by a separate command without touching capture.
export function createTelegramInteractionState({now=()=>new Date(),ttlMs=INTERACTION_TTL_MS,limit=256}={}) {
  const pending=new Map();
  return {
    begin(link,mode,data={}){for(const[key,value]of pending)if(value.expiresAt<=now().getTime())pending.delete(key);if(pending.size>=limit)pending.delete(pending.keys().next().value);pending.set(bindingKey(link),{mode,data,expiresAt:now().getTime()+ttlMs});},
    get(link){const key=bindingKey(link),state=pending.get(key);if(state && state.expiresAt<=now().getTime()){pending.delete(key);return null;}return state||null;},
    clear(link){pending.delete(bindingKey(link));},
  };
}
export function createTelegramDaySummaryRouter({db,canAccess=()=>false,now=()=>new Date(),timeZone,review,finalReview=input=>reviewDay(db,input),authorize,currentBinding,send,acknowledge,onSettingsChanged=()=>{}}) {
  const interactions=createTelegramInteractionState({now}),messageRoutes=[],callbackRoutes=[],preflights=[],extraButtons=[],pendingModes=new Map(),keyboardShown=new Set();
  const fresh=link=>currentBinding(link);
  const dayFresh=link=>fresh(link) && canAccess(link.user_id);
  const isDayPending=state=>state?.mode==='date' || state?.mode==='time';
  const clearRevokedDay=link=>{if(!canAccess(link.user_id) && isDayPending(interactions.get(link)))interactions.clear(link);};
  const replyKeyboard=link=>{
    if(link && canAccess(link.user_id))return summaryReplyKeyboard(extraButtons);
    const keyboard=[];for(const {text,row} of extraButtons){if(!keyboard[row])keyboard[row]=[];keyboard[row].push(text);}
    return keyboard.some(row=>row?.length)?{keyboard:keyboard.filter(row=>row?.length),resize_keyboard:true,is_persistent:true}:undefined;
  };
  const sendFresh=(link,text,markup)=>{
    if(!fresh(link))return Promise.resolve(null);
    const dayMarkup=markup?.inline_keyboard?.some(row=>row.some(button=>button.callback_data?.startsWith('tds:')));
    if(dayMarkup && !canAccess(link.user_id))return Promise.resolve(null);
    return send(link.chat_id,text,{reply_markup:markup?.keyboard?replyKeyboard(link):markup});
  };
  async function processedUpdate(update,link,message=null,callback=null){for(const handler of preflights)if(await handler({update,link,message,callback,interactions,send:sendFresh}))return true;return !fresh(link);}
  const todayOf=link=>dateInZone(now(),timeZone(link.user_id));
  async function menu(link){if(!dayFresh(link))return;if(!keyboardShown.has(bindingKey(link))){await sendFresh(link,'Сегодня, другой день и настройки сводок — в меню ниже.',replyKeyboard(link));if(dayFresh(link))keyboardShown.add(bindingKey(link));}}
  // Re-read the complete source synchronously after any async preparation.
  // Filtering the rendered slice cannot repair hidden items or section counts.
  function currentReview(link,input){
    if(!dayFresh(link))return null;
    const overview=finalReview({...input,userId:link.user_id,timeZone:timeZone(link.user_id),now:now()});
    if(overview && typeof overview.then==='function')throw new TypeError('Final day review must be synchronous');
    return dayFresh(link)?overview:null;
  }
  async function showReview(link,date){if(!dayFresh(link))return;const input={userId:link.user_id,date,timeZone:timeZone(link.user_id),now:now(),phase:'manual'};await review(input);const overview=currentReview(link,input);if(overview)await sendFresh(link,renderDaySummary(overview),summaryNavigation(date,todayOf(link),link.app_url));}
  async function picker(link){if(!dayFresh(link))return;await sendFresh(link,'Какой день показать?',{inline_keyboard:[[{text:'Вчера',callback_data:`tds:date:${shiftDate(todayOf(link),-1)}`},{text:'Выбрать дату',callback_data:'tds:pick'}]]});}
  async function settings(link){
    if(!dayFresh(link))return;
    const prefs=readSummaryPreferences(db,link.user_id),rows=[];
    const receipt=db.prepare('SELECT local_date,phase,status,error_code FROM telegram_summary_receipts WHERE user_id=? ORDER BY local_date DESC,updated_at DESC LIMIT 1').get(link.user_id);
    const receiptStatus={sent:'отправлено',reserved:'готовится',retry:'Telegram попросил подождать; повторим в пределах часа',uncertain:'доставка не подтверждена; автоматического повтора не будет',failed:receipt?.error_code==='403'?'Telegram запретил отправку; проверьте, не заблокирован ли бот':receipt?.error_code==='400'?'Telegram отклонил сообщение':'не отправлено; следующая сводка придёт по расписанию'};
    const lastDelivery=receipt?`\nПоследняя сводка (${receipt.local_date}, ${receipt.phase==='morning'?'утро':'вечер'}): ${receiptStatus[receipt.status]||'статус недоступен'}.`:'';
    for(const phase of phases){const name=phase==='morning'?'Утро':'Вечер';rows.push([{text:`${prefs[phase].enabled?'✅':'☐'} ${name}: ${prefs[phase].enabled?'включено':'выключено'}`,callback_data:`tds:enabled:${phase}:${prefs[phase].enabled?0:1}`},{text:prefs[phase].time,callback_data:`tds:time:${phase}`}]);}
    rows.push(weekdays.map((label,index)=>({text:`${prefs.weekdays.includes(index+1)?'✓ ':''}${label}`,callback_data:`tds:weekday:${index+1}:${prefs.weekdays.includes(index+1)?0:1}`})));
    await sendFresh(link,`⚙️ Настройки сводок\nУтро: ${prefs.morning.enabled?'включено':'выключено'}, ${prefs.morning.time}\nВечер: ${prefs.evening.enabled?'включено':'выключено'}, ${prefs.evening.time}\nДни: ${prefs.weekdays.length?prefs.weekdays.map(day=>weekdays[day-1]).join(', '):'не выбраны — отправок нет'}\nЧасовой пояс: ${timeZone(link.user_id)}${lastDelivery}\nНажмите время, чтобы изменить его.`,{inline_keyboard:rows});
  }
  pendingModes.set('date',{accept:text=>/^(?:\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4})$/.test(text),consume:async(link,text)=>{if(!dayFresh(link))return;const date=selectedReviewDate(text);if(date)return showReview(link,date);interactions.begin(link,'date');await sendFresh(link,'Такой даты нет. Введите дату: ДД.ММ.ГГГГ или ГГГГ-ММ-ДД.',replyKeyboard(link));}});
  pendingModes.set('time',{accept:text=>/^\d{2}:\d{2}$/.test(text),consume:async(link,text,data)=>{if(!dayFresh(link))return;if(!validSummaryTime(text)){interactions.begin(link,'time',data);await sendFresh(link,'Введите время от 00:00 до 23:59.',replyKeyboard(link));return;}changeSummaryPreferences(db,link.user_id,{type:'time',phase:data.phase,value:text},{now:now(),onChanged:onSettingsChanged});await settings(link);}});
  async function beforeLinkCommand(message,{update=null}={}){
    if(message.from?.is_bot || message.chat?.type!=='private' || String(message.from?.id)!==String(message.chat?.id))return true;
    const link=authorize(message.from,message.chat);if(!link)return false;
    clearRevokedDay(link);
    if(await processedUpdate(update,link,message))return true;
    interactions.clear(link);return false;
  }
  async function routeMessage(message,{forwarded=false,update=null}={}) {
    const link=authorize(message.from,message.chat);if(!link)return false;
    clearRevokedDay(link);
    if(await processedUpdate(update,link,message))return true;
    if(forwarded || typeof message.text!=='string' || message.document || message.photo || message.video || message.audio || message.voice || message.animation || message.sticker){interactions.clear(link);return false;}
    const text=message.text.trim(),command=/^\/([a-z_]+)(?:@\w+)?(?:\s+(.+))?$/i.exec(text),name=command?.[1].toLowerCase();
    const hadPending=Boolean(interactions.get(link));
    if(command || Object.values(DAY_SUMMARY_LABELS).includes(text) || extraButtons.some(button=>button.text===text) || text==='Отмена')interactions.clear(link);
    const allowed=canAccess(link.user_id);
    if((text==='Отмена'||name==='cancel') && (allowed || hadPending)){await sendFresh(link,'Ввод отменён. Можно снова писать заметки.',replyKeyboard(link));return true;}
    if(allowed && (name==='today'||text===DAY_SUMMARY_LABELS.today)){await menu(link);await showReview(link,todayOf(link));return true;}
    if(allowed && (name==='day'||text===DAY_SUMMARY_LABELS.day)){await menu(link);const date=selectedReviewDate(command?.[2]);if(date)await showReview(link,date);else await picker(link);return true;}
    if(allowed && (name==='settings'||text===DAY_SUMMARY_LABELS.settings)){await menu(link);await settings(link);return true;}
    for(const handler of messageRoutes)if(await handler({message,text,link,interactions,send:sendFresh}))return true;
    if(!fresh(link))return true;
    const weekday=canAccess(link.user_id)?weekdayReviewDate(text,todayOf(link)):null;if(weekday){interactions.clear(link);await menu(link);await showReview(link,weekday);return true;}
    clearRevokedDay(link);
    const pending=interactions.get(link),mode=pending?pendingModes.get(pending.mode):null;
    if(mode?.accept(text)){interactions.clear(link);await mode.consume(link,text,pending.data,message);return true;}
    return false;
  }
  async function routeCallback(callback,{update=null}={}){
    await acknowledge(callback.id).catch(()=>{});
    const link=authorize(callback.from,callback.message?.chat);if(!link)return false;
    clearRevokedDay(link);
    if(typeof callback.data==='string' && callback.data.startsWith('tds:') && !dayFresh(link))return true;
    if(await processedUpdate(update,link,null,callback))return true;
    for(const handler of callbackRoutes)if(await handler({callback,link,interactions,send:sendFresh,update}))return true;
    if(!fresh(link))return true;
    const data=callback.data;if(typeof data!=='string'||data.length>64||!/^[\x20-\x7E]+$/.test(data)||!data.startsWith('tds:'))return false;
    if(!dayFresh(link))return true;
    interactions.clear(link);
    const date=/^tds:date:(\d{4}-\d{2}-\d{2})$/.exec(data);if(date&&validIsoDate(date[1])){await showReview(link,date[1]);return true;}
    if(data==='tds:pick'){interactions.begin(link,'date');await sendFresh(link,'Введите дату: ДД.ММ.ГГГГ или ГГГГ-ММ-ДД.\nОтмена — вернуться к заметкам.',replyKeyboard(link));return true;}
    const time=/^tds:time:(morning|evening)$/.exec(data);if(time){interactions.begin(link,'time',{phase:time[1]});await sendFresh(link,'Введите время сводки: ЧЧ:ММ, например 09:00.\nОтмена — вернуться к заметкам.',replyKeyboard(link));return true;}
    const enable=/^tds:enabled:(morning|evening):([01])$/.exec(data),day=/^tds:weekday:([1-7]):([01])$/.exec(data);
    if(enable||day){if(!dayFresh(link))return true;const change=enable?{type:'enabled',phase:enable[1],value:enable[2]==='1'}:{type:'weekday',day:Number(day[1]),value:day[2]==='1'};changeSummaryPreferences(db,link.user_id,change,{now:now(),onChanged:onSettingsChanged});await settings(link);return true;}
    return false;
  }
  return{routeMessage,routeCallback,beforeLinkCommand,currentReview,interactions,replyKeyboard,clear:link=>interactions.clear(link),
    registerMessageRoute:handler=>messageRoutes.push(handler),registerPendingMode:(name,mode)=>pendingModes.set(name,mode),
    registerCallbackRoute:handler=>callbackRoutes.push(handler),registerPreflight:handler=>preflights.push(handler),
    registerReplyKeyboardButton(text,{row=0}={}){if(typeof text!=='string'||!text.trim()||text.length>64||!Number.isInteger(row)||row<0||row>2)throw new RangeError('Invalid keyboard button');if(!extraButtons.some(button=>button.text===text&&button.row===row))extraButtons.push({text,row});keyboardShown.clear();},
  };
}
