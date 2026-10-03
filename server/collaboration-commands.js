import crypto from 'node:crypto';
import { collaborationError } from './collaboration-storage.js';
import { canEditCapture, noteCompletion } from './circles.js';
import { completeProjection, undoProjectionCompletion, completeOccurrence, undoOccurrence, createSubtask, fullEntry, getAggregate } from './db.js';
export function runCollaborationCommand(db,captureId,actorId,{operationId,expectedRevision,command},timeZone='Europe/Samara',onCompletion=()=>{}) {
  if(!canEditCapture(db,captureId,actorId))throw collaborationError('forbidden',403);
  if(typeof operationId!=='string'||!/^[a-zA-Z0-9_:.\-]{1,128}$/.test(operationId)||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||!command||typeof command!=='object'||Array.isArray(command))throw collaborationError('invalid_command');
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify({command,expectedRevision})).digest('hex');
  return db.transaction(()=>{
    const previous=db.prepare('SELECT * FROM collaborative_commands WHERE capture_id=? AND actor_id=? AND operation_id=?').get(captureId,actorId,operationId);
    if(previous){if(previous.fingerprint!==fingerprint)throw collaborationError('idempotency_conflict',409);return {...JSON.parse(previous.result_json),replayed:true};}
    const revision=db.prepare('SELECT revision FROM collaborative_structure WHERE capture_id=?').get(captureId)?.revision||0;
    if(revision!==expectedRevision)throw collaborationError('revision_conflict',409);
    let result;
    if(command.type==='completion') {
      if(typeof command.completed!=='boolean'||Object.keys(command).some(k=>!['type','completed','occurrence'].includes(k)))throw collaborationError('invalid_command');
      const projections=db.prepare("SELECT id FROM projections WHERE capture_id=? AND status='active' AND projection_type IN ('task','meeting_event')").all(captureId);
      if(!projections.length)throw collaborationError('not_completable',409);
      let changed=false;
      for(const projection of projections){result=command.occurrence!==undefined?(command.completed?completeOccurrence(db,projection.id,command.occurrence,{timeZone}):undoOccurrence(db,projection.id,command.occurrence,{timeZone})):(command.completed?completeProjection(db,projection.id):undoProjectionCompletion(db,projection.id));if(result.error)throw collaborationError(result.error,409);changed=changed||Boolean(result.changed);}
      if(command.occurrence===undefined){noteCompletion(db,captureId,command.completed);onCompletion({captureId,completed:command.completed,changed});}
      result={completed:command.completed,...(command.occurrence===undefined?{}:{occurrence:command.occurrence})};
    } else if(command.type==='subtask.create') {
      if(typeof command.title!=='string'||!command.title.trim()||command.title.length>500||Object.keys(command).some(k=>!['type','title'].includes(k)))throw collaborationError('invalid_command');
      const created=createSubtask(db,{parentId:captureId,userId:actorId,title:command.title.trim(),timeZone});
      if(created.notFound)throw collaborationError('not_found',404);
      result={captureId:created.captureId,entry:fullEntry(db,getAggregate(db,created.captureId))};
    } else throw collaborationError('invalid_command');
    const finalRevision=Math.max(revision+1,db.prepare('SELECT revision FROM collaborative_structure WHERE capture_id=?').get(captureId)?.revision||0);
    result={...result,structureRevision:finalRevision};
    db.prepare('INSERT INTO collaborative_structure(capture_id,revision) VALUES(?,?) ON CONFLICT(capture_id) DO UPDATE SET revision=excluded.revision').run(captureId,finalRevision);
    db.prepare('INSERT INTO collaborative_commands VALUES(?,?,?,?,?)').run(captureId,actorId,operationId,fingerprint,JSON.stringify(result));return result;
  }).immediate();
}
