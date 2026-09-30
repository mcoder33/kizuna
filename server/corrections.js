// Уточнение записи человеком — одна дорога для карточки и для голоса.
//
// Карточка шлёт поправку маршрутом /api/captures/:id/corrections, голос —
// инструментами update_capture и complete_capture (убрать повтор). Раньше у
// голоса была своя копия правил, и она расходилась с карточкой: перенос голосом
// терял напоминание и убранные повторы, а поправка не гасила «ждёт уточнения».
// Правила срока, типа и полей живут здесь, а маршрут и голос только зовут их.
import crypto from 'node:crypto';
import { getAggregate, fullEntry, replaceInterpretation } from './db.js';
import { gateClassification, shouldMaterializeProjections } from './classifier.js';
import { learnQuietly } from './memory.js';
import { resolveNotifications } from './notifications.js';
import { validRemind } from './reminders.js';
import { validRepeat, validSkip, normalizeRepeat, normalizeSkip, scheduleDisplay, dayDiff } from './repeat.js';
import { shiftDate as reportShiftDate } from './reports.js';

export const CORRECTION_TYPES = ['meeting_event', 'task', 'note', 'outcome_decision', 'idea_question'];

export function validSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') return false;
  const { date = null, time = null, end = null } = schedule;
  // Напоминание: минуты до начала или «off»; null снимает явное значение.
  if (schedule.remind !== undefined && schedule.remind !== null && !validRemind(schedule.remind)) return false;
  // Конец события — только при времени начала и строго после него.
  if (end !== null && (time === null || !/^\d{2}:\d{2}$/.test(end) || Number(end.slice(0,2)) > 23 || Number(end.slice(3)) > 59 || end <= time)) return false;
  if (date !== null) { if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false; const [year, month, day] = date.split('-').map(Number); const parsed = new Date(Date.UTC(year, month - 1, day)); if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return false; }
  if (time !== null && (!/^\d{2}:\d{2}$/.test(time) || Number(time.slice(0,2)) > 23 || Number(time.slice(3)) > 59)) return false;
  // Повтор — правило целиком и только при дате; «до» не раньше первого
  // экземпляра. Убранные экземпляры — список дат.
  if (schedule.repeat !== undefined && !validRepeat(schedule.repeat)) return false;
  const repeat = normalizeRepeat(schedule.repeat);
  if (repeat && (date === null || (repeat.until && repeat.until < date))) return false;
  if (schedule.skip !== undefined && !validSkip(schedule.skip)) return false;
  return true;
}
export function correctionRequestFingerprint(patch) { return crypto.createHash('sha256').update(JSON.stringify(patch)).digest('hex'); }
// Напоминание в уточнении срока: не упомянуто — остаётся прежнее, null —
// снимается (вернуться к настройке по умолчанию), иначе — новое.
export function remindPatch(next,original){const value=next.remind===undefined?original?.remind:next.remind;return value===undefined||value===null?{}:{remind:value};}
// Срок из уточнения. Напоминание, повтор и убранные экземпляры — свойства
// срока: не названы в уточнении — остаются как были, null снимает. Перенос
// серии на другой день сдвигает и убранные экземпляры: они привязаны к месту
// в серии, а не к календарной дате.
export function scheduleFromPatch(next,original){
  const date=next.date||null,time=next.time||null,end=time&&next.end?next.end:null;
  const repeat=date?(next.repeat===undefined?normalizeRepeat(original?.repeat)||null:normalizeRepeat(next.repeat)||null):null;
  let skip=normalizeSkip(next.skip===undefined?original?.skip:next.skip);
  if(repeat&&next.skip===undefined&&original?.repeat&&original?.date&&date!==original.date)skip=skip.map(day=>reportShiftDate(day,dayDiff(original.date,date)));
  return {state:date&&time?'ok':'ambiguous',date,time,...(end?{end}:{}),...remindPatch(next,original),...(repeat?{repeat}:{}),...(repeat&&skip.length?{skip}:{}),sortAt:date?`${date}T${time||'23:59'}:00`:null,display:scheduleDisplay({date,time,end,repeat})};
}
export function correctedClassification(original,patch){const entities={...original.entities,projects:patch.project===undefined?original.entities.projects:(patch.project?[patch.project.trim()]:[]),people:patch.people===undefined?original.entities.people:patch.people.map(person=>person.trim()).filter(Boolean),followUp:patch.followUp===undefined?original.entities.followUp:(patch.followUp?.trim()||null),schedule:patch.schedule===undefined?original.entities.schedule:scheduleFromPatch(patch.schedule,original.entities.schedule)};const clearsAmbiguity=Boolean(original.ambiguity)&&patch[{type:'primaryType',schedule:'schedule',projects:'project',people:'people',followUp:'followUp'}[original.ambiguity.field]||'primaryType']!==undefined;const classification={...original,primaryType:patch.primaryType||original.primaryType,summary:patch.summary===undefined?original.summary:patch.summary.trim(),priority:patch.priority===undefined?original.priority:(patch.priority==='normal'?undefined:patch.priority),entities,completed:patch.completed!==undefined?patch.completed:(patch.primaryType!==undefined?patch.primaryType==='outcome_decision':Boolean(original.completed)),unclassified:original.unclassified&&patch.primaryType===undefined?true:undefined,ambiguity:clearsAmbiguity?null:(original.ambiguity??null),conflicts:{projects:patch.project!==undefined?false:original.conflicts?.projects,schedule:patch.schedule!==undefined?false:original.conflicts?.schedule},claims:(original.claims||[]).map(claim=>{const map={type:'primaryType',projects:'project',people:'people',followUp:'followUp',schedule:'schedule'};return patch[map[claim.field]]!==undefined?{...claim,value:claim.field==='type'?(patch.primaryType||original.primaryType):entities[claim.field],confidence:1,kind:'fact',provenance:{source:'raw',evidence:'manual correction'}}:claim})};classification.confidence=Object.fromEntries(classification.claims.map(claim=>[claim.field,claim.confidence]));return classification;}

// Что не так с поправкой — словами для человека; null — поправку можно применять.
export function correctionPatchError(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return 'Некорректное уточнение.';
  if (patch.primaryType !== undefined && !CORRECTION_TYPES.includes(patch.primaryType)) return 'Некорректный тип записи.';
  if (patch.schedule !== undefined && !validSchedule(patch.schedule)) return 'Некорректная дата или время.';
  if (patch.project !== undefined && patch.project !== null && (typeof patch.project !== 'string' || patch.project.length > 120)) return 'Некорректный проект.';
  if (patch.people !== undefined && (!Array.isArray(patch.people) || patch.people.length > 8 || patch.people.some(person => typeof person !== 'string' || person.length > 120))) return 'Некорректные участники.';
  if (patch.followUp !== undefined && patch.followUp !== null && (typeof patch.followUp !== 'string' || patch.followUp.length > 500)) return 'Некорректное действие.';
  if (patch.completed !== undefined && typeof patch.completed !== 'boolean') return 'Некорректный признак выполнения.';
  if (patch.summary !== undefined && (typeof patch.summary !== 'string' || !patch.summary.trim() || patch.summary.trim().length > 500)) return 'Заголовок — от 1 до 500 символов.';
  if (patch.priority !== undefined && !['low', 'normal', 'high'].includes(patch.priority)) return 'Некорректная важность.';
  return null;
}

// Применить поправку: новая версия разбора, проекции заново, урок помощнику.
// Ключ операции делает повтор того же запроса безвредным; у голоса он свой на
// каждый вызов — иначе «убери повтор», «верни», «убери снова» третьим разом
// считался бы повтором первого и молча ничего не менял.
export function correctCapture(db, { captureId, userId = null, patch, operationKey = null, source = 'correction' }) {
  const active = getAggregate(db, captureId);
  if (!active) return { error: { status: 404, code: 'not_found', message: 'Запись не найдена.' } };
  const invalid = correctionPatchError(patch);
  if (invalid) return { error: { status: 400, code: 'invalid_patch', message: invalid } };
  const requestFingerprint = correctionRequestFingerprint(patch);
  const key = operationKey || `correction-${requestFingerprint}`;
  const original = JSON.parse(active.classification_json);
  const classification = correctedClassification(original, patch);
  const review = gateClassification(classification);
  const replacement = replaceInterpretation(db, captureId, classification, 'manual', { ...patch, patch, operationKey: key, requestFingerprint }, shouldMaterializeProjections(classification));
  if (replacement?.conflict) return { error: { status: 409, code: 'idempotency_conflict', message: 'Ключ уже использован для другого уточнения.' } };
  if (review.level === 'high') resolveNotifications(db, { userId, kind: 'clarify', captureId });
  // Поправка — это урок: в следующий раз такую же запись разбирают уже
  // правильно, и человек не решает то же самое дважды. Повтор того же запроса
  // (replayed) ничему не учит — он ничего и не менял.
  if (!replacement?.replayed) learnQuietly(db, { userId, captureId, raw: active.raw || '', before: original, after: classification, source });
  return { entry: fullEntry(db, getAggregate(db, captureId)), undoGroupId: replacement.undoGroupId, review, replayed: Boolean(replacement.replayed) };
}
