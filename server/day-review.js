import { dateInZone, dayStartInZone, shiftDate } from './reports.js';
import { occursOn, validIsoDate } from './repeat.js';
import { canSeeCapture } from './circles.js';
import { historySnapshot } from './day-summary-history.js';

const meetingOrder = (a,b)=>(a.time===null)-(b.time===null)||(a.time||'').localeCompare(b.time||'')||a.title.localeCompare(b.title);
const sections = ['planned','done','remaining','overdue','added','meetings'];
const parse = value => JSON.parse(value || '{}');
const localTime = (value, zone) => new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value));

// Only accepted work is borrowed; historical acceptance and current access both apply.
function historicalAccess(db,captureId,userId,cutoff) {
  const participant=historySnapshot(db,'participant',JSON.stringify([captureId,userId]),cutoff);
  if (participant && !participant.deleted && !parse(participant.snapshot_json).removed_at) return true;
  for (const row of db.prepare("SELECT source_key FROM day_summary_history WHERE source='share' AND subject_id=? AND observed_at<? GROUP BY source_key").iterate(captureId,cutoff)) {
    const share=historySnapshot(db,'share',row.source_key,cutoff);
    if (!share || share.deleted) continue;
    const shared=parse(share.snapshot_json);
    if (shared.removed_at) continue;
    const member=historySnapshot(db,'member',JSON.stringify([shared.circle_id,userId]),cutoff);
    if (member && !member.deleted && !parse(member.snapshot_json).left_at) return true;
  }
  return false;
}
function borrowedCaptures(db, userId, cutoff, historical) {
  const captures = new Set();
  if (!historical) {
    for (const row of db.prepare("SELECT capture_id FROM assignments WHERE assignee_id=? AND state IN ('accepted','done') AND cancelled_at IS NULL").iterate(userId))
      if (canSeeCapture(db,row.capture_id,userId)) captures.add(row.capture_id);
    return captures;
  }
  for (const row of db.prepare(`SELECT h.* FROM day_summary_history h WHERE source='assignment' AND subject_id=? AND observed_at<?
    AND NOT EXISTS(SELECT 1 FROM day_summary_history later WHERE later.source=h.source AND later.source_key=h.source_key
      AND later.observed_at<? AND (later.observed_at>h.observed_at OR (later.observed_at=h.observed_at AND later.id>h.id)))`).iterate(userId,cutoff,cutoff)) {
    const assignment = parse(row.snapshot_json);
    if (!row.deleted && !assignment.cancelled_at && assignment.responded_at && ['accepted','done'].includes(assignment.state) && canSeeCapture(db,assignment.capture_id,userId) && historicalAccess(db,assignment.capture_id,userId,cutoff)) captures.add(assignment.capture_id);
  }
  return captures;
}

export function reviewDay(db, { userId, date, timeZone = 'Europe/Samara', now = new Date(), phase = 'manual', limit = 40 }) {
  if (!validIsoDate(date)) throw new RangeError('Invalid review date');
  const at = now instanceof Date ? now : new Date(now);
  const today = dateInZone(at,timeZone), historical = date < today;
  const start = dayStartInZone(date,timeZone).toISOString();
  const end = dayStartInZone(shiftDate(date,1),timeZone).toISOString();
  const cutoff = historical ? end : new Date(at.getTime()+1).toISOString();
  const observedFrom = db.prepare('SELECT observed_from FROM day_summary_history_meta WHERE id=1').get().observed_from;
  const mutableCoverage = cutoff<=observedFrom ? 'unavailable' : start<observedFrom && date<=today ? 'partial' : 'observed';
  const historyCoverage = { own:'retained', external:mutableCoverage, assignments:mutableCoverage, observedFrom, gaps:[] };
  if (mutableCoverage==='partial') {
    const bound=`${dateInZone(new Date(observedFrom),timeZone)} ${localTime(observedFrom,timeZone)} (${timeZone})`;
    historyCoverage.gaps.push(`История внешних календарей неполная: изменения сохраняются с ${bound}.`);
    historyCoverage.gaps.push(`История принятых чужих дел неполная: изменения сохраняются с ${bound}.`);
  }
  if (historyCoverage.external === 'unavailable') historyCoverage.gaps.push('История внешних календарей до начала сохранения изменений недоступна.');
  if (historyCoverage.assignments === 'unavailable') historyCoverage.gaps.push('История принятых чужих дел до начала сохранения изменений недоступна.');
  const result = { date,timeZone,asOf:historical ? end : at.toISOString(),phase,historyCoverage,counts:{},overflow:{} };
  for (const section of sections) { result[section]=[]; result.counts[section]=0; }
  const itemLimit = Math.max(1,Math.min(200,Number(limit)||40));
  const add = (section,item) => {
    result.counts[section]++;
    if (section==='meetings') { result[section].push(item); result[section].sort(meetingOrder); if (result[section].length>itemLimit) result[section].pop(); }
    else if (result[section].length<itemLimit) result[section].push(item);
  };
  const resetAt=db.prepare('SELECT reset_at FROM day_summary_user_resets WHERE user_id IS ?').get(userId)?.reset_at;
  const borrowed = historical && resetAt && cutoff<=resetAt ? new Set() : borrowedCaptures(db,userId,cutoff,historical);
  if (historical && resetAt && cutoff<=resetAt) historyCoverage.gaps.push('История до очистки журнала недоступна.');
  const readCapture = db.prepare(`SELECT c.*,i.id interpretation_id,i.classification_json FROM captures c JOIN interpretations i ON i.capture_id=c.id
    WHERE c.id=? AND c.created_at<? AND i.id=(SELECT chosen.id FROM interpretations chosen WHERE chosen.capture_id=c.id AND chosen.status<>'rejected' AND chosen.created_at<? ORDER BY chosen.created_at DESC,chosen.version DESC,chosen.rowid DESC LIMIT 1)`);
  const readProjections = db.prepare(`SELECT p.id,p.projection_type FROM projections p WHERE interpretation_id=? AND created_at<?
    AND (reverted_at IS NULL OR reverted_at>=?)`);
  const readCompletion = db.prepare(`SELECT * FROM ledger_events WHERE projection_id=? AND event_type IN ('completed','completion_undone') AND created_at<? ORDER BY created_at DESC,rowid DESC LIMIT 1`);
  const readDeletion = db.prepare(`SELECT event_type FROM ledger_events WHERE capture_id=? AND event_type IN ('capture_deleted','capture_restored') AND created_at<? ORDER BY created_at DESC,rowid DESC LIMIT 1`);
  const readOccurrences = db.prepare(`SELECT * FROM ledger_events WHERE capture_id=? AND event_type IN ('occurrence_completed','occurrence_undone') AND created_at<? ORDER BY created_at,rowid`);
  function ownCapture(captureId) {
    const row = readCapture.get(captureId,cutoff,cutoff);
    if (!row || row.subtask || readDeletion.get(captureId,cutoff)?.event_type === 'capture_deleted') return;
    // A legacy deleted row without its deletion event cannot prove earlier visibility.
    if (row.deleted_at && row.deleted_at<cutoff && !readDeletion.get(captureId,cutoff)) return;
    const classification = parse(row.classification_json), schedule = classification.entities?.schedule || null;
    if (classification.completed !== true && classification.proposedActions?.some(action=>action.type==='task' && typeof action.title==='string')) return;
    const projections = readProjections.all(row.interpretation_id,cutoff,cutoff).filter(projection=>['task','meeting_event'].includes(projection.projection_type));
    const materialized=db.prepare("SELECT 1 FROM projections WHERE interpretation_id=? AND projection_type IN ('task','meeting_event') LIMIT 1").get(row.interpretation_id);
    const legacyFact=classification.primaryType==='task' && classification.completed===true && !materialized;
    if (!projections.length && !legacyFact) return;
    const completion = projections.map(projection=>readCompletion.get(projection.id,cutoff));
    const closed = completion.length>0 && completion.every(event=>event?.event_type==='completed' && (event.occurred_at||event.created_at)<cutoff);
    const closedAt = closed ? completion.map(event=>event.occurred_at||event.created_at).sort().at(-1) : null;
    const occurrences = new Map();
    for (const event of readOccurrences.iterate(captureId,cutoff)) {
      const instance = parse(event.payload).date;
      if (!validIsoDate(instance)) continue;
      if (event.event_type === 'occurrence_completed' && (event.occurred_at||event.created_at)<cutoff) occurrences.set(instance,event.occurred_at||event.created_at);
      else occurrences.delete(instance);
    }
    const explicitMeeting = classification.primaryType==='meeting_event' && projections.some(projection=>projection.projection_type==='meeting_event');
    if (classification.primaryType!=='task' && !explicitMeeting) return;
    const item = { id:captureId,title:classification.summary||row.raw,kind:explicitMeeting?'meeting':'task',time:schedule?.time||null,end:schedule?.end||null,date:schedule?.date||null,borrowed:row.user_id!==userId,completed:closed,defaulted:Boolean(schedule?.defaulted) };
    const planned = schedule?.repeat ? occursOn(schedule,date) || occurrences.has(date) : schedule?.date===date;
    if (planned) add('planned',item);
    if (explicitMeeting && planned) add('meetings',{...item,allDay:!item.time});
    if (!explicitMeeting) {
      let factualDay = closedAt ? dateInZone(new Date(closedAt),timeZone) : null;
      if (!closed && classification.completed===true && !completion.length) {
        factualDay=classification.entities?.doneOn?.date || null;
        if (!factualDay) {
          const snapshot=historySnapshot(db,'interpretation',row.interpretation_id,cutoff);
          if (snapshot) factualDay=dateInZone(new Date(parse(snapshot.snapshot_json).occurred_at),timeZone);
          else if (!historyCoverage.gaps.includes('День старых результатов без сохранённого фактического времени неизвестен.')) historyCoverage.gaps.push('День старых результатов без сохранённого фактического времени неизвестен.');
        }
      }
      const occurrenceDone = [...occurrences].filter(([,completedAt])=>dateInZone(new Date(completedAt),timeZone)===date);
      if (factualDay===date || occurrenceDone.length) add('done',{...item,completed:true,...(occurrenceDone.length?{occurrenceDates:occurrenceDone.map(([instance])=>instance)}:{})});
      const doneForDay = schedule?.repeat ? occurrences.has(date) : closed || classification.completed===true;
      const carry = !schedule?.repeat && (!schedule?.date || (schedule.defaulted && schedule.date<=date));
      if (!doneForDay && (planned || carry)) add('remaining',item);
      if (!doneForDay && !schedule?.repeat && schedule?.date && !schedule.defaulted && schedule.date<date) add('overdue',item);
      if (row.created_at>=start && row.created_at<end) add('added',item);
    }
  }
  for (const row of db.prepare('SELECT id FROM captures WHERE user_id IS ? AND subtask=0 AND created_at<? ORDER BY created_at,id').iterate(userId,cutoff)) ownCapture(row.id);
  for (const captureId of borrowed) if (db.prepare('SELECT user_id FROM captures WHERE id=?').get(captureId)?.user_id!==userId) ownCapture(captureId);
  addExternalMeetings(db,{userId,date,timeZone,cutoff,historical,add});
  result.meetings.sort(meetingOrder);
  for (const section of sections) result.overflow[section]=result.counts[section]-result[section].length;
  return result;
}

function addExternalMeetings(db,{userId,date,timeZone,cutoff,historical,add}) {
  const currentAccounts = new Map(db.prepare('SELECT * FROM calendar_accounts WHERE user_id IS ? AND disabled_at IS NULL').all(userId).map(row=>[row.id,row]));
  const rows = historical ? db.prepare(`SELECT h.snapshot_json,h.deleted FROM day_summary_history h WHERE h.user_id IS ? AND h.source='external' AND h.observed_at<?
    AND NOT EXISTS(SELECT 1 FROM day_summary_history later WHERE later.source=h.source AND later.source_key=h.source_key AND later.observed_at<?
    AND (later.observed_at>h.observed_at OR (later.observed_at=h.observed_at AND later.id>h.id)))`).iterate(userId,cutoff,cutoff) : db.prepare(`SELECT e.* FROM calendar_events e JOIN calendar_accounts a ON a.id=e.account_id WHERE a.user_id IS ?`).iterate(userId);
  for (const snapshot of rows) {
    if (snapshot.deleted) continue;
    const event = historical ? parse(snapshot.snapshot_json) : snapshot;
    const account = currentAccounts.get(event.account_id);
    if (!account) continue;
    const currentCalendar = JSON.parse(account.calendars_json||'[]').find(calendar=>calendar.id===event.calendar_id);
    if (!currentCalendar || currentCalendar.selected===false) continue;
    const oldAccount = historical ? historySnapshot(db,'account',account.id,cutoff) : null;
    if (historical && (!oldAccount || oldAccount.deleted)) continue;
    const settings = historical ? parse(oldAccount.snapshot_json) : account;
    if (settings.disabled_at || !JSON.parse(settings.calendars_json||'[]').some(calendar=>calendar.id===event.calendar_id && calendar.selected!==false)) continue;
    if (db.prepare('SELECT 1 FROM calendar_links WHERE account_id=? AND (uid=? OR uid=?)').get(event.account_id,event.uid,event.series_uid||event.uid)) continue;
    const attendees = JSON.parse(event.attendees_json||'[]');
    const identity=String(historical ? settings.identity_email || '' : account.username || '').trim().toLowerCase();
    if (attendees.some(person=>(person.self || (identity && String(person.email||'').trim().toLowerCase()===identity)) && person.status==='declined')) continue;
    const inDay = event.all_day ? event.start_at.slice(0,10)<=date && event.end_at.slice(0,10)>date : event.start_at<dayStartInZone(shiftDate(date,1),timeZone).toISOString() && event.end_at>dayStartInZone(date,timeZone).toISOString();
    if (!inDay) continue;
    const busyOnly = account.mode==='busy' || settings.mode==='busy';
    add('meetings',{id:`external:${JSON.stringify([event.account_id,event.calendar_id,event.uid,event.instance_key||''])}`,kind:'external',title:busyOnly?'Занято':event.title,date,time:event.all_day?null:(dateInZone(new Date(event.start_at),timeZone)<date?'00:00':localTime(event.start_at,timeZone)),end:event.all_day?null:(dateInZone(new Date(event.end_at),timeZone)>date?'23:59':localTime(event.end_at,timeZone)),allDay:Boolean(event.all_day),busy:Boolean(event.busy),completed:false});
  }
}

export function createDayReviewService({db}) { return { review:input=>reviewDay(db,input) }; }
