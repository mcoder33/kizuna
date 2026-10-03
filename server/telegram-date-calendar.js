import { randomBytes } from 'node:crypto';
import { validIsoDate } from './repeat.js';

const WEEKDAYS = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
export const CALENDAR_TTL_MS = 10 * 60 * 1000;
const PREFIX = 'tds:cal:';
const validMonth = month => typeof month === 'string' && /^\d{4}-\d{2}$/.test(month) && validIsoDate(`${month}-01`);
const callbackData = (token, action) => `${PREFIX}${token}:${action}`;

export function shiftCalendarMonth(month, direction) {
  if (!validMonth(month) || ![-1,1].includes(direction)) return null;
  const value = new Date(`${month}-01T12:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + direction);
  const next = value.toISOString().slice(0,7);
  return validMonth(next) ? next : null;
}

export function renderTelegramDateCalendar({ month, today, token, timeZone }) {
  if (!validMonth(month) || !validIsoDate(today) || !/^[A-Za-z0-9_-]{12}$/.test(token)) throw new RangeError('Invalid calendar');
  const noop = callbackData(token,'noop');
  const title = new Intl.DateTimeFormat('ru-RU',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(`${month}-01T12:00:00Z`)).replace(/ г\.$/,'');
  const previous = shiftCalendarMonth(month,-1),next = shiftCalendarMonth(month,1);
  const rows = [[{text:'‹',callback_data:previous ? callbackData(token,`month:${previous}`) : noop},{text:title[0].toUpperCase()+title.slice(1),callback_data:noop},{text:'›',callback_data:next ? callbackData(token,`month:${next}`) : noop}], WEEKDAYS.map(text=>({text,callback_data:noop}))];
  const start = new Date(`${month}-01T12:00:00Z`),leading = (start.getUTCDay()+6)%7;
  const end = new Date(start);end.setUTCMonth(end.getUTCMonth()+1);end.setUTCDate(0);
  const cells = Math.ceil((leading+end.getUTCDate())/7)*7;
  for(let offset=0;offset<cells;offset+=7){
    rows.push(Array.from({length:7},(_,column)=>{
      const day=offset+column-leading+1;
      if(day<1 || day>end.getUTCDate())return{text:'·',callback_data:noop};
      const date=`${month}-${String(day).padStart(2,'0')}`;
      return{text:date===today ? `[${day}]` : String(day),callback_data:callbackData(token,`date:${date}`)};
    }));
  }
  rows.push([{text:'☀️ Сегодня',callback_data:callbackData(token,'today')},{text:'⌨️ Ввести дату',callback_data:callbackData(token,'manual')}]);
  return{text:`🗓 ${title[0].toUpperCase()+title.slice(1)}\nВыберите день. Часовой пояс: ${timeZone}`,reply_markup:{inline_keyboard:rows}};
}

// Calendar callbacks have their own state, independent of note/search/date input.
export function createTelegramDateCalendar({now=()=>new Date(),ttlMs=CALENDAR_TTL_MS,limit=256,fresh,todayOf,timeZone,send,edit=null,showReview,manualDate}) {
  const contexts=new Map();
  const keyOf=link=>JSON.stringify([link.user_id,String(link.telegram_id),String(link.chat_id),link.linked_at]);
  function prune(){for(const[key,context]of contexts)if(context.expiresAt<=now().getTime())contexts.delete(key);}
  function frame(link,context){return renderTelegramDateCalendar({month:context.month,today:todayOf(link),token:context.token,timeZone:timeZone(link.user_id)});}
  const current=(link,context)=>fresh(link) && contexts.get(keyOf(link))===context && context.expiresAt>now().getTime();
  function newContext(month,messageId=null){return{month,messageId,token:randomBytes(9).toString('base64url'),expiresAt:now().getTime()+ttlMs,busy:false};}
  async function open(link){
    if(!fresh(link))return;
    prune();const key=keyOf(link);if(contexts.size>=limit && !contexts.has(key))contexts.delete(contexts.keys().next().value);
    const context=newContext(todayOf(link).slice(0,7));contexts.set(key,context);
    const rendered=frame(link,context);if(!current(link,context))return;
    const sent=await send(link,rendered.text,rendered.reply_markup);
    if(current(link,context) && Number.isInteger(sent?.message_id))context.messageId=sent.message_id;
    else if(contexts.get(key)===context)contexts.delete(key);
  }
  async function route(link,callback){
    if(typeof callback.data!=='string' || !callback.data.startsWith(PREFIX))return false;
    if(!fresh(link))return true;
    prune();const key=keyOf(link),context=contexts.get(key);
    const parsed=/^tds:cal:([A-Za-z0-9_-]{12}):(noop|today|manual|month:(\d{4}-\d{2})|date:(\d{4}-\d{2}-\d{2}))$/.exec(callback.data);
    if(!parsed || !context || context.busy || !current(link,context) || parsed[1]!==context.token || !Number.isInteger(context.messageId) || callback.message?.message_id!==context.messageId)return true;
    const action=parsed[2];if(action==='noop')return true;
    if(parsed[3] && ![shiftCalendarMonth(context.month,-1),shiftCalendarMonth(context.month,1)].includes(parsed[3]))return true;
    if(parsed[4] && (!validIsoDate(parsed[4]) || parsed[4].slice(0,7)!==context.month))return true;
    context.busy=true;
    if(parsed[3]){
      const replacement=newContext(parsed[3],context.messageId);replacement.busy=true;contexts.set(key,replacement);
      const rendered=frame(link,replacement);if(!current(link,replacement))return true;
      try{
        const sent=edit ? await edit(link,replacement.messageId,rendered.text,rendered.reply_markup) : await send(link,rendered.text,rendered.reply_markup);
        if(current(link,replacement) && Number.isInteger(sent?.message_id)){replacement.messageId=sent.message_id;replacement.busy=false;}
        else if(contexts.get(key)===replacement)contexts.delete(key);
      }catch(error){if(contexts.get(key)===replacement)contexts.delete(key);throw error;}
      return true;
    }
    // Consume before awaiting a review so repeats cannot issue duplicate data.
    contexts.delete(key);
    if(!fresh(link))return true;
    if(action==='manual')await manualDate(link);
    else await showReview(link,action==='today' ? todayOf(link) : parsed[4]);
    return true;
  }
  return{open,route};
}
