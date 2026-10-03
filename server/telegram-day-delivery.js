import { dateInZone } from './reports.js';
import { validIsoDate } from './repeat.js';
import { readSummaryPreferences, validSummaryTime, renderDaySummaryMessage, summaryNavigation } from './telegram-day-summary.js';
import { reserveSummaryReceipt, claimSummaryRetry, updateSummaryReceipt, recoverSummaryReceipts } from './day-summary-history.js';

export const SUMMARY_GRACE_MS = 60 * 60 * 1000;
const dueCache=new Map(),formatters=new Map();
function localMinute(at,zone){
  let formatter=formatters.get(zone);if(!formatter){formatter=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});if(formatters.size>=64)formatters.delete(formatters.keys().next().value);formatters.set(zone,formatter);}
  const parts=formatter.formatToParts(new Date(at)),value=type=>parts.find(part=>part.type===type).value;
  return{date:`${value('year')}-${value('month')}-${value('day')}`,time:`${value('hour')}:${value('minute')}`};
}
// Find the first real instant at/after the wall time. A fold uses its first
// occurrence; a missing time advances to the first valid minute of this day.
export function summaryDueInstant(date,time,zone){
  if(!validIsoDate(date)||!validSummaryTime(time))return null;
  const key=JSON.stringify([date,time,zone]);if(dueCache.has(key))return dueCache.get(key);
  const midnight=Date.parse(`${date}T00:00:00Z`);let due=null;
  for(let instant=midnight-36*3600000;instant<=midnight+36*3600000;instant+=60000){const wall=localMinute(instant,zone);if(wall.date===date&&wall.time>=time){due=instant;break;}}
  if(dueCache.size>=256)dueCache.delete(dueCache.keys().next().value);dueCache.set(key,due);return due;
}
export function summaryEligibility({preferences,phase,timeZone,now}){
  const date=dateInZone(now,timeZone),setting=preferences[phase];
  const schedule={date,signature:JSON.stringify([setting?.time,setting?.activatedAt,preferences.weekdays,timeZone])};
  if(!setting?.enabled)return{eligible:false,reason:'disabled',...schedule};
  const weekday=((new Date(`${date}T12:00:00Z`).getUTCDay()+6)%7)+1;
  if(!preferences.weekdays.includes(weekday))return{eligible:false,reason:'weekday_disabled',...schedule};
  const due=summaryDueInstant(date,setting.time,timeZone);
  if(due===null)return{eligible:false,reason:'absent_local_day',...schedule};
  const activated=Date.parse(setting.activatedAt||'');
  if(!Number.isFinite(activated)||activated>due)return{eligible:false,reason:'activated_after_due',...schedule};
  if(now.getTime()<due)return{eligible:false,reason:'before_due',...schedule};
  if(now.getTime()>due+SUMMARY_GRACE_MS)return{eligible:false,reason:'outside_grace',...schedule};
  return{eligible:true,...schedule,due,timeZone,phase};
}

export function createTelegramDayDelivery({db,canAccess=()=>false,now=()=>new Date(),timeZone,currentBinding,enabled=()=>true,prepareReview,currentReview,send,audit=()=>{},batchSize=40}){
  const size=Math.max(1,Math.min(100,Math.floor(Number(batchSize)||40)));
  let cursor='',inFlight=null,recovered=false;
  const report=event=>audit(event);
  const receiptOf=db.prepare('SELECT * FROM telegram_summary_receipts WHERE user_id=? AND local_date=? AND phase=?');
  const eligible=(link,phase)=>({...summaryEligibility({preferences:readSummaryPreferences(db,link.user_id),phase,timeZone:timeZone(link.user_id),now:now()}),phase});
  const sameReceiptBinding=(receipt,link)=>receipt.telegram_user_id===String(link.telegram_id)&&receipt.chat_id===String(link.chat_id)&&receipt.binding_linked_at===link.linked_at;
  function finish(link,selection,status,errorCode=null,extra={}){updateSummaryReceipt(db,{userId:link.user_id,date:selection.date,phase:selection.phase,status,errorCode,now:now().toISOString(),...extra});report({event:'telegram_summary_delivery',phase:selection.phase,status,errorCode});}
  async function deliver(link,phase){
    if(!canAccess(link.user_id))return;
    const selection=eligible(link,phase);if(!currentBinding(link)||!enabled())return;
    for(const old of db.prepare("SELECT local_date FROM telegram_summary_receipts WHERE user_id=? AND phase=? AND status='retry' AND local_date<>? LIMIT 10").all(link.user_id,phase,selection.date))finish(link,{date:old.local_date,phase},'failed','retry_day_expired');
    const receipt=receiptOf.get(link.user_id,selection.date,phase);
    if(receipt){
      if(receipt.status!=='retry')return;
      if(!sameReceiptBinding(receipt,link)){finish(link,selection,'failed','binding_changed');return;}
      const originalDue=Date.parse(receipt.due_at),deadline=Date.parse(receipt.grace_deadline);
      if(!Number.isFinite(originalDue)||deadline!==originalDue+SUMMARY_GRACE_MS||!receipt.schedule_signature){finish(link,selection,'failed','retry_metadata_missing');return;}
      if(receipt.schedule_signature!==selection.signature){finish(link,selection,'failed','retry_schedule_changed');return;}
      if(now().getTime()>deadline){finish(link,selection,'failed','retry_grace_expired');return;}
    }
    if(!selection.eligible){if(receipt?.status==='retry'&&selection.reason!=='before_due')finish(link,selection,'failed',selection.reason);return;}
    const input={userId:link.user_id,date:selection.date,phase,telegramUserId:link.telegram_id,chatId:link.chat_id,linkedAt:link.linked_at,dueAt:new Date(selection.due).toISOString(),graceDeadline:new Date(selection.due+SUMMARY_GRACE_MS).toISOString(),scheduleSignature:selection.signature,now:now().toISOString()};
    if(!canAccess(link.user_id))return;
    if(receipt){if(!claimSummaryRetry(db,input))return;}else if(!reserveSummaryReceipt(db,input))return;
    let sending=false;
    try{
      await prepareReview({userId:link.user_id,date:selection.date,timeZone:selection.timeZone,now:now(),phase});
      if(!canAccess(link.user_id)){finish(link,selection,'failed','access_revoked');return;}
      if(!currentBinding(link)){finish(link,selection,'failed','binding_changed');return;}
      if(!enabled()){finish(link,selection,'failed','telegram_disabled');return;}
      const current=eligible(link,phase);
      if(!current.eligible||current.date!==selection.date||current.signature!==selection.signature){finish(link,selection,'failed','preferences_or_due_changed');return;}
      const overview=currentReview(link,{date:selection.date,phase});
      if(!overview){finish(link,selection,'failed','binding_changed');return;}
      const {text,entities}=renderDaySummaryMessage(overview),markup=summaryNavigation(selection.date,selection.date,link.app_url);
      const finalSelection=eligible(link,phase),sendAt=now().getTime();
      if(!canAccess(link.user_id)){finish(link,selection,'failed','access_revoked');return;}
      if(!currentBinding(link)||!enabled()||!finalSelection.eligible||finalSelection.date!==selection.date||finalSelection.signature!==input.scheduleSignature||sendAt<Date.parse(input.dueAt)||sendAt>Date.parse(input.graceDeadline)||dateInZone(new Date(sendAt),selection.timeZone)!==selection.date){finish(link,selection,'failed','final_eligibility_changed');return;}
      sending=true;
      const sent=await send(link.chat_id,text,{entities,reply_markup:markup});
      finish(link,selection,'sent',null,{messageId:sent?.message_id||null});
    }catch(error){
      if(!sending){finish(link,selection,'failed','review_failed');return;}
      if(error?.status===429){
        const wait=Number(error.retryAfter),retryAt=now().getTime()+Math.max(1000,Number.isFinite(wait)&&wait>0?wait*1000:1000);
        if(retryAt<=selection.due+SUMMARY_GRACE_MS&&dateInZone(new Date(retryAt),selection.timeZone)===selection.date)finish(link,selection,'retry','429',{retryAt:new Date(retryAt).toISOString()});
        else finish(link,selection,'failed','rate_limit_outside_grace');
      }else if([400,401,403,404].includes(error?.status))finish(link,selection,'failed',String(error.status));
      else finish(link,selection,'uncertain',error?.code||'ambiguous_delivery');
    }
  }
  async function run(){
    if(!recovered){recoverSummaryReceipts(db,now().toISOString());recovered=true;}
    if(!enabled())return;
    const query=db.prepare("SELECT l.* FROM telegram_links l JOIN users u ON u.id=l.user_id WHERE u.status='active' AND l.user_id>? ORDER BY l.user_id LIMIT ?");
    let users=query.all(cursor,size);if(!users.length&&cursor){cursor='';users=query.all(cursor,size);}
    if(users.length)cursor=users.at(-1).user_id;
    for(const link of users.filter(link=>canAccess(link.user_id)))for(const phase of ['morning','evening'])await deliver(link,phase);
  }
  function tick(){
    if(inFlight)return inFlight;
    inFlight=run().catch(error=>{report({event:'telegram_summary_tick_failed',errorCode:error?.code||'tick_error'});throw error;}).finally(()=>{inFlight=null;});
    return inFlight;
  }
  return{tick};
}
