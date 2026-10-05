import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getAggregate, fullEntry, createLedger, deleteCapture } from './db.js';
import { correctCapture, scheduleFromPatch } from './corrections.js';
import { occursOn, nextOccurrence, validIsoDate } from './repeat.js';
import { todayIn } from './subtasks.js';
import { shiftDate } from './reports.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status, code: 'postpone_failed' }); };
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scheduleOf = entry => entry.interpretation.classification.entities.schedule || null;
const taskOf = (db, captureId, userId) => {
  const row = getAggregate(db, captureId);
  if (!row || row.deleted_at || row.user_id !== userId) fail(404, 'Запись не найдена.');
  return fullEntry(db, row);
};
const record = (db, id, userId, captureId) => {
  const row = db.prepare("SELECT payload_json FROM activity_events WHERE id=? AND type='capture_postponed'").get(id);
  const data = row ? JSON.parse(row.payload_json) : null;
  if (data && (data.userId !== userId || data.captureId !== captureId)) fail(404, 'Запись не найдена.');
  return data;
};
const changeSchedule = (db, captureId, userId, schedule, operationKey, timeZone) => {
  const result = correctCapture(db, { captureId, userId, patch: { schedule }, operationKey, timeZone });
  if (result.error) fail(result.error.status, result.error.message);
  return result.entry;
};
const copyFingerprint = (db, entry) => fingerprint({
  entry,
  placement: db.prepare('SELECT * FROM board_placements WHERE capture_id=?').get(entry.id),
  assignment: db.prepare('SELECT * FROM assignments WHERE capture_id=? AND cancelled_at IS NULL').get(entry.id),
  circles: db.prepare('SELECT * FROM capture_circles WHERE capture_id=? ORDER BY circle_id').all(entry.id),
  comments: db.prepare('SELECT COUNT(*) AS n FROM comments WHERE capture_id=?').get(entry.id),
  children: db.prepare('SELECT id FROM captures WHERE parent_capture_id=? AND deleted_at IS NULL ORDER BY id').all(entry.id),
});

// A repeat is detached into a single dated task. Its regular tomorrow occurrence
// remains separate; the series anchor, rule, and other skipped days never move.
export function postponeCapture(db, { captureId, userId, operationId, occurrence = null, timeZone, at = new Date(), attachmentsDirectory }) {
  if (typeof operationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(operationId)) fail(400, 'Некорректный ключ операции.');
  const files = [];
  try {
    return db.transaction(() => {
      const original = taskOf(db, captureId, userId);
      const replay = record(db, operationId, userId, captureId);
      if (replay) {
        if (replay.requestOccurrence !== occurrence) fail(409, 'Ключ уже использован для другого запроса.');
        return { ...replay.result, replayed: true };
      }
      const projections = original.projections.filter(p => ['task', 'meeting_event'].includes(p.type));
      if (!projections.length || projections.every(p => p.completion?.completed)) fail(409, 'Дело уже закрыто.');
      const before = scheduleOf(original);
      const today = todayIn(timeZone, at), tomorrow = shiftDate(today, 1);
      let sourceDay = null;
      if (before?.repeat) {
        sourceDay = occurrence || (occursOn(before, today) ? today : nextOccurrence(before, today));
        if (!validIsoDate(sourceDay) || !occursOn(before, sourceDay)) fail(409, 'Этот повтор уже изменён. Обновите список.');
      } else if (occurrence !== null) fail(409, 'Повтор уже изменён. Обновите список.');
      if ((sourceDay || before?.date) === tomorrow) return { captureId, date: tomorrow, unchanged: true };
      const destination = { date: tomorrow, time: before?.time || null, end: before?.end || null, remind: before?.remind ?? null, repeat: null, skip: [] };
      let movedId = captureId, detached = null;
      if (sourceDay) {
        // createLedger also stores details as the new task's editable note.
        const classification = { ...original.interpretation.classification, completed: false, proposedActions: [], details: original.note?.body || '', entities: { ...original.interpretation.classification.entities, doneOn: null, schedule: scheduleFromPatch(destination, before) } };
        movedId = createLedger(db, { raw: original.raw, classification, provider: 'manual', userId, timeZone }).captureId;
        db.prepare('UPDATE captures SET parent_capture_id=?, subtask=? WHERE id=?').run(original.parentId, original.subtask ? 1 : 0, movedId);
        db.prepare('INSERT INTO board_placements SELECT ?,user_id,column_id,position,updated_at FROM board_placements WHERE capture_id=?').run(movedId, captureId);
        db.prepare('INSERT INTO capture_circles SELECT ?,circle_id,shared_by,shared_at,removed_at FROM capture_circles WHERE capture_id=? AND removed_at IS NULL').run(movedId, captureId);
        const assignment = db.prepare('SELECT * FROM assignments WHERE capture_id=? AND cancelled_at IS NULL').get(captureId);
        if (assignment && ['pending', 'accepted'].includes(assignment.state)) db.prepare('INSERT INTO assignments(id,capture_id,circle_id,assignee_id,assigner_id,state,reason,created_at,responded_at,done_at,cancelled_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(crypto.randomUUID(), movedId, assignment.circle_id, assignment.assignee_id, assignment.assigner_id, assignment.state, assignment.reason, at.toISOString(), assignment.responded_at, null, null);
        for (const attachment of original.attachments) {
          const id = crypto.randomUUID(), target = path.join(attachmentsDirectory, id);
          fs.copyFileSync(path.join(attachmentsDirectory, attachment.id), target, fs.constants.COPYFILE_EXCL);
          files.push(target);
          db.prepare('INSERT INTO capture_attachments(id,capture_id,filename,content_type,byte_size,checksum,created_at) SELECT ?,?,filename,content_type,byte_size,checksum,created_at FROM capture_attachments WHERE id=?').run(id, movedId, attachment.id);
        }
        changeSchedule(db, captureId, userId, { ...before, skip: [...(before.skip || []), sourceDay] }, operationId, timeZone);
        detached = copyFingerprint(db, taskOf(db, movedId, userId));
      } else changeSchedule(db, captureId, userId, destination, operationId, timeZone);
      const after = scheduleOf(taskOf(db, captureId, userId));
      const result = { captureId: movedId, sourceId: captureId, date: tomorrow, occurrence: sourceDay, operationId };
      db.prepare('INSERT INTO activity_events VALUES(?,?,?,?)').run(operationId, 'capture_postponed', JSON.stringify({ captureId, userId, before, after, detached, result, requestOccurrence: occurrence }), at.toISOString());
      return result;
    })();
  } catch (error) { for (const file of files) fs.rmSync(file, { force: true }); throw error; }
}

export function undoPostpone(db, { captureId, userId, operationId, timeZone }) {
  return db.transaction(() => {
    const entry = taskOf(db, captureId, userId), saved = record(db, operationId, userId, captureId);
    if (!saved) fail(404, 'Перенос не найден.');
    if (saved.undone) return { captureId, replayed: true };
    if (fingerprint(scheduleOf(entry)) !== fingerprint(saved.after)) fail(409, 'Срок уже изменён. Отмена переноса недоступна.');
    if (saved.detached) {
      const moved = taskOf(db, saved.result.captureId, userId);
      if (copyFingerprint(db, moved) !== saved.detached) fail(409, 'Перенесённое дело уже изменено. Отмена переноса недоступна.');
      deleteCapture(db, moved.id);
    }
    changeSchedule(db, captureId, userId, saved.before || { date: null, time: null, remind: null, repeat: null, skip: [] }, `undo-${operationId}`, timeZone);
    db.prepare('UPDATE activity_events SET payload_json=? WHERE id=?').run(JSON.stringify({ ...saved, undone: true }), operationId);
    return { captureId };
  })();
}
