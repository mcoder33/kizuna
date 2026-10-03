import crypto from 'node:crypto';
import * as Y from 'yjs';

export const COLLABORATION_FRAME_LIMIT = 1024 * 1024;
export const COLLABORATION_BODY_LIMIT = 20000;
const listeners = new WeakMap();
export function onDocumentChange(db, listener) { listeners.set(db, listener); }
export function documentRow(db, captureId) { return db.prepare('SELECT * FROM collaborative_documents WHERE capture_id=?').get(captureId) || null; }
export function currentTitle(db, captureId, fallback) { return documentRow(db, captureId)?.title ?? fallback; }
export function collaborationError(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
export function readDocument(row) {
  const doc = new Y.Doc(); doc.getText('body'); doc.getText('title');
  if (row) Y.applyUpdate(doc, row.state);
  return doc;
}
export function ensureDocument(db, captureId) {
  let row = documentRow(db, captureId); if (row) return row;
  const capture = db.prepare(`SELECT i.classification_json FROM captures c JOIN interpretations i ON i.capture_id=c.id AND i.status='active' WHERE c.id=? AND c.deleted_at IS NULL`).get(captureId);
  if (!capture) throw collaborationError('not_found',404);
  const body = db.prepare("SELECT body FROM capture_notes WHERE capture_id=? AND status='active'").get(captureId)?.body || '';
  const title = JSON.parse(capture.classification_json).summary || '';
  const doc = readDocument(); doc.getText('body').insert(0,body); doc.getText('title').insert(0,title);
  db.prepare('INSERT INTO collaborative_documents(capture_id,generation,state,body,title,updated_at) VALUES(?,?,?,?,?,?)').run(captureId,crypto.randomUUID(),Buffer.from(Y.encodeStateAsUpdate(doc)),body,title,new Date().toISOString());
  doc.destroy(); return documentRow(db,captureId);
}
function validateDocument(doc) {
  if (doc.share.size !== 2 || [...doc.share.keys()].some(key => !['body','title'].includes(key))) throw collaborationError('invalid_document');
  if (doc.store.pendingStructs || doc.store.pendingDs) throw collaborationError('missing_dependencies');
  for(const structs of doc.store.clients.values())for(const item of structs){if(item.content&&(item.content instanceof Y.ContentType || item.content instanceof Y.ContentAny || item.content instanceof Y.ContentEmbed || item.content instanceof Y.ContentFormat))throw collaborationError('invalid_document');}
  for (const [key,max] of [['body',COLLABORATION_BODY_LIMIT],['title',500]]) {
    const text = doc.getText(key);
    if (!(text instanceof Y.Text) || text._map.size || text.length > max || text.toDelta().some(item => typeof item.insert !== 'string' || item.attributes)) throw collaborationError('invalid_document');
  }
  if (Y.encodeStateAsUpdate(doc).length > 4 * COLLABORATION_FRAME_LIMIT) throw collaborationError('document_too_large',413);
}
function checkpointNote(db,captureId,body,actorId,at) {
  const previous = db.prepare("SELECT id,version,body FROM capture_notes WHERE capture_id=? AND status='active'").get(captureId);
  if (previous?.body === body) return;
  if (previous) db.prepare("UPDATE capture_notes SET status='superseded' WHERE id=?").run(previous.id);
  db.prepare('INSERT INTO capture_notes(id,capture_id,version,status,body,created_at,supersedes_id) VALUES(?,?,?,?,?,?,?)').run(crypto.randomUUID(),captureId,(previous?.version||0)+1,'active',body,at,previous?.id||null);
  db.prepare('INSERT INTO activity_events VALUES(?,?,?,?)').run(crypto.randomUUID(),'collaboration_checkpoint',JSON.stringify({captureId,actorId}),at);
}
// A shadow document and SQL transaction isolate malformed updates and failed writes.
export function applyDocumentUpdate(db,captureId,{update,operationId,actorId=null,expectedRevision}) {
  const bytes = Buffer.from(update);
  if (!bytes.length || bytes.length > COLLABORATION_FRAME_LIMIT) throw collaborationError('update_too_large',413);
  if (typeof operationId !== 'string' || !/^[a-zA-Z0-9_:.\-]{1,128}$/.test(operationId)) throw collaborationError('invalid_operation');
  const row = ensureDocument(db,captureId);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const prior = db.prepare('SELECT revision,update_hash FROM collaborative_updates WHERE capture_id=? AND actor_id IS ? AND operation_id=?').get(captureId,actorId,operationId);
  if (prior) { if (prior.update_hash !== hash) throw collaborationError('idempotency_conflict',409); return {...documentRow(db,captureId),replayed:true}; }
  const duplicate = db.prepare('SELECT revision FROM collaborative_updates WHERE capture_id=? AND update_hash=?').get(captureId,hash);
  if (duplicate) return {...row,replayed:true};
  if (expectedRevision !== undefined && expectedRevision !== row.revision) throw collaborationError('revision_conflict',409);
  const doc = readDocument(row);
  try {
    try { Y.applyUpdate(doc,bytes); validateDocument(doc); } catch (error) { if (error.code) throw error; throw collaborationError('invalid_update'); }
    const state=Buffer.from(Y.encodeStateAsUpdate(doc)),body=doc.getText('body').toString(),title=doc.getText('title').toString(),revision=row.revision+1,at=new Date().toISOString();
    const commit = () => {
      db.prepare('UPDATE collaborative_documents SET state=?,body=?,title=?,revision=?,updated_at=? WHERE capture_id=?').run(state,body,title,revision,at,captureId);
      db.prepare('INSERT INTO collaborative_updates(capture_id,operation_id,actor_id,revision,update_hash,update_bytes,created_at) VALUES(?,?,?,?,?,?,?)').run(captureId,operationId,actorId,revision,hash,bytes,at);
      for (const projection of db.prepare("SELECT id,payload_json FROM projections WHERE capture_id=? AND status='active'").all(captureId)) {
        const payload=JSON.parse(projection.payload_json); payload.title=title || 'Без названия';
        db.prepare('UPDATE projections SET payload_json=? WHERE id=?').run(JSON.stringify(payload),projection.id);
      }
      if (Date.now()-row.checkpoint_at>=500) {
        checkpointNote(db,captureId,body,actorId,at);
        db.prepare('UPDATE collaborative_documents SET checkpoint_at=? WHERE capture_id=?').run(Date.now(),captureId);
      }
    };
    if (db.inTransaction) commit(); else db.transaction(commit).immediate();
    const result=documentRow(db,captureId);
    // An outer legacy transaction publishes only after its commit via deferred callback.
    if (db.inTransaction) queueMicrotask(()=>{if(db.open)listeners.get(db)?.(captureId);});
    else listeners.get(db)?.(captureId);
    return result;
  } finally { doc.destroy(); }
}
// Existing synchronous writers become Y.Text edits; HTTP replacement requires a revision.
export function replaceDocumentText(db,captureId,key,text,{actorId=null,expectedRevision,requireRevision=false}={}) {
  const row=documentRow(db,captureId); if (!row) return null;
  if (requireRevision && expectedRevision !== row.revision) throw collaborationError('revision_conflict',409);
  if (text===row[key]) return row;
  const doc=readDocument(row),vector=Y.encodeStateVector(doc),shared=doc.getText(key),previous=shared.toString();
  let start=0;while(start<previous.length&&start<text.length&&previous[start]===text[start])start++;
  let end=0;while(end<previous.length-start&&end<text.length-start&&previous[previous.length-1-end]===text[text.length-1-end])end++;
  doc.transact(()=>{shared.delete(start,previous.length-start-end);shared.insert(start,text.slice(start,text.length-end));});
  const update=Y.encodeStateAsUpdate(doc,vector);doc.destroy();
  return applyDocumentUpdate(db,captureId,{update,operationId:`legacy-${crypto.randomUUID()}`,actorId,expectedRevision});
}

// Structural revisions cover legacy commands as well as the new command endpoint.
export function bumpStructure(db,captureId) {
  const seen=new Set();let current=captureId;
  while(current&&!seen.has(current)){
    seen.add(current);
    if(documentRow(db,current))db.prepare('INSERT INTO collaborative_structure(capture_id,revision) VALUES(?,1) ON CONFLICT(capture_id) DO UPDATE SET revision=revision+1').run(current);
    current=db.prepare('SELECT parent_capture_id FROM captures WHERE id=?').get(current)?.parent_capture_id;
  }
}
