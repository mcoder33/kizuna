import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';

function openOutbox(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('pending', { keyPath: 'operationId' });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}
function outboxRequest(db, mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('pending', mode);
    const request = operation(transaction.objectStore('pending'));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

// Copy-only recovery never establishes a transport or replays operations.
export async function listPendingDrafts(userId) {
  if (!indexedDB.databases) return [];
  const prefix = `pagent-collaboration:${userId}:`;
  const names = (await indexedDB.databases()).map(database => database.name).filter(name => name?.startsWith(prefix) && name.endsWith(':outbox'));
  const drafts = [];
  for (const name of names) {
    const db = await openOutbox(name);
    try {
      if (!(await outboxRequest(db, 'readonly', store => store.count()))) continue;
      const storageName = name.slice(0, -7);
      const [captureId, generation] = storageName.slice(prefix.length).split(':');
      if (!/^[0-9a-f-]{36}$/i.test(captureId) || !generation) continue;
      drafts.push({ captureId, storageName });
    } finally { db.close(); }
  }
  return drafts;
}
export async function readPendingDraft(draft) {
  const doc = new Y.Doc(); const persistence = new IndexeddbPersistence(draft.storageName, doc);
  try { await persistence.whenSynced; return `${doc.getText('title')}\n\n${doc.getText('body')}`; }
  finally { await persistence.destroy(); doc.destroy(); }
}
