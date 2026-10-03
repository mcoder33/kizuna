import { t } from './browser-i18n.js';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate } from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import { IndexeddbPersistence } from 'y-indexeddb';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';

const REMOTE = Symbol('server');
const toBytes = text => Uint8Array.from(atob(text), character => character.charCodeAt(0));
const toBase64 = bytes => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
};
function element(tag, className, text) {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
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

export function createCollaborativeEditor({ captureId, userId, generation, onText = () => {}, onStructure = () => {} }) {
  const titleElement = element('div', 'collaborative-title');
  const bodyElement = element('section', 'card-body collaborative-body');
  const bodyHost = element('div', 'collaborative-body-host');
  const status = element('p', 'collaborative-status', t('Подключаем совместный редактор…'));
  status.setAttribute('role', 'status');
  const presence = element('p', 'collaborative-presence');
  const exportButton = element('button', 'secondary collaborative-export', t('Скопировать черновик'));
  exportButton.type = 'button'; exportButton.hidden = true;
  const draft = element('textarea', 'collaborative-draft');
  draft.readOnly = true; draft.hidden = true; draft.setAttribute('aria-label', t('Черновик для копирования'));
  bodyElement.append(element('p', 'prop-section', t('Заметка')), bodyHost, status, presence, exportButton, draft);
  let doc, awareness, persistence, outbox, socket, titleView, bodyView, undoManager;
  let disposed = false, disposing = false, terminal = false, authorized = false, transportReady = false, revision = 0, reconnectTimer;
  let persistenceQueue = Promise.resolve(), pending = new Map(), updateSequence = 0;
  const editable = new Compartment();
  const titleEditable = new Compartment();
  const storageName = `pagent-collaboration:${userId}:${captureId}:${generation}`;
  const setStatus = text => { if (!disposed) status.textContent = text; };
  const textChanged = () => onText({ title: doc?.getText('title').toString() || '', body: doc?.getText('body').toString() || '', revision });
  const refreshDraft = () => { if (!doc) return; draft.value = `${doc?.getText('title').toString() || ''}

${doc?.getText('body').toString() || ''}`; };
  const retainDraft = text => {
    terminal = true; authorized = false; clearTimeout(reconnectTimer); setStatus(text);
    exportButton.hidden = false; refreshDraft(); draft.hidden = false;
    if (!doc && !disposed) {
      const recovery = new Y.Doc(); const saved = new IndexeddbPersistence(storageName, recovery);
      saved.whenSynced.then(() => { if (!disposed) draft.value = `${recovery.getText('title')}\n\n${recovery.getText('body')}`; return saved.destroy(); }).catch(() => setStatus(t('Не удалось прочитать черновик на устройстве.'))).finally(() => recovery.destroy());
    }
    if (bodyView) bodyView.dispatch({ effects: editable.reconfigure(EditorView.editable.of(false)) });
    if (titleView) titleView.dispatch({ effects: titleEditable.reconfigure(EditorView.editable.of(false)) });
    socket?.close();
  };
  exportButton.addEventListener('click', async () => {
    refreshDraft(); draft.hidden = false; draft.select();
    try { await navigator.clipboard.writeText(draft.value); } catch {}
  });
  function send(message) {
    if (!disposed && authorized && transportReady && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
  function sendPending() {
    if (terminal || !authorized) return;
    for (const item of [...pending.values()].sort((a, b) => a.sequence - b.sequence)) { const { sequence, ...frame } = item; send(frame); }
    if (pending.size) setStatus(t('Сохраняем…'));
  }
  function queueUpdate(update) {
    const message = { type: 'update', operationId: crypto.randomUUID(), baseRevision: revision, update: toBase64(update), sequence: ++updateSequence };
    pending.set(message.operationId, message);
    const { sequence: localSequence, ...immediateFrame } = message; send(immediateFrame);
    setStatus(authorized ? t('Сохраняем…') : t('Нет связи · черновик на устройстве'));
    persistenceQueue = persistenceQueue.then(() => outboxRequest(outbox, 'readwrite', store => store.put(message))).then(() => { if (pending.has(message.operationId)) { const { sequence, ...frame } = message; send(frame); } }).catch(() => {
      setStatus(t('Не удалось сохранить черновик на устройстве. Скопируйте его.')); exportButton.hidden = false;
    });
  }
  function applyPresence(states) {
    const encoder = encoding.createEncoder(); encoding.writeVarUint(encoder, states.length);
    for (const item of states) {
      const state = item.state;
      if (state?.user) state.user.colorLight = `${state.user.color}33`;
      encoding.writeVarUint(encoder, item.clientId); encoding.writeVarUint(encoder, item.clock);
      encoding.writeVarString(encoder, JSON.stringify(state));
    }
    applyAwarenessUpdate(awareness, encoding.toUint8Array(encoder), REMOTE);
    presence.textContent = [...awareness.getStates().values()].filter(state => state?.user).map(state => state.user.name).join(' · ');
  }
  function mountViews() {
    undoManager = new Y.UndoManager([doc.getText('body'), doc.getText('title')]);
    const common = [keymap.of([...yUndoManagerKeymap, ...defaultKeymap, indentWithTab]), EditorView.lineWrapping];
    titleView = new EditorView({ parent: titleElement, state: EditorState.create({ doc: doc.getText('title').toString(), extensions: [...common, titleEditable.of(EditorView.editable.of(true)), EditorView.contentAttributes.of({ 'aria-label': t('Название туду') }), placeholder(t('Без названия')), yCollab(doc.getText('title'), awareness, { undoManager })] }) });
    bodyView = new EditorView({ parent: bodyHost, state: EditorState.create({ doc: doc.getText('body').toString(), extensions: [...common, markdown(), editable.of(EditorView.editable.of(true)), EditorView.contentAttributes.of({ 'aria-label': t('Описание туду') }), placeholder(t('Описание')), yCollab(doc.getText('body'), awareness, { undoManager })] }) });
    awareness.on('update', ({ added, updated, removed }, origin) => {
      if (origin === REMOTE || ![...added, ...updated, ...removed].includes(doc.clientID)) return;
      const local = awareness.getLocalState();
      const state = local === null ? null : Object.fromEntries(Object.entries(local).filter(([key]) => ['cursor', 'selection', 'user'].includes(key)));
      send({ type: 'awareness', clientId: doc.clientID, clock: awareness.meta.get(doc.clientID)?.clock || 0, state });
    });
    doc.on('update', (update, origin) => {
      textChanged();
      if (origin === REMOTE || origin === persistence || disposed || terminal) return;
      queueUpdate(update);
    });
  }
  async function hello(message, channel) {
    if (disposed || terminal || channel !== socket) return;
    if (message.actor?.id !== userId) return retainDraft(t("Аккаунт изменился. Черновик сохранён для прежнего аккаунта."));
    if (message.generation !== generation) return retainDraft(t('Версия документа изменилась. Скопируйте черновик и откройте туду заново.'));
    revision = message.revision;
    authorized = true;
    if (!doc) {
      doc = new Y.Doc(); doc.getText('body'); doc.getText('title');
      Y.applyUpdate(doc, toBytes(message.update), REMOTE);
      const serverVector = Y.encodeStateVector(doc);
      awareness = new Awareness(doc);
      outbox = await openOutbox(`${storageName}:outbox`);
      persistence = new IndexeddbPersistence(storageName, doc);
      await persistence.whenSynced;
      if (disposed || terminal || channel !== socket) return;
      pending = new Map((await outboxRequest(outbox, 'readonly', store => store.getAll())).sort((a, b) => a.sequence - b.sequence).map(item => [item.operationId, item]));
      updateSequence = Math.max(0, ...[...pending.values()].map(item => item.sequence || 0));
      for (const item of pending.values()) Y.applyUpdate(doc, toBytes(item.update), REMOTE);
      const offlineDiff = Y.encodeStateAsUpdate(doc, serverVector);
      mountViews();
      if (offlineDiff.length > 2 && !pending.size) queueUpdate(offlineDiff);
    } else Y.applyUpdate(doc, toBytes(message.update), REMOTE);
    if (disposed || terminal || channel !== socket) return;
    channel.send(JSON.stringify({ type: 'sync', stateVector: toBase64(Y.encodeStateVector(doc)), clientId: doc.clientID }));
    transportReady = true;
    awareness.setLocalStateField('user', { name: message.actor.name, color: '#4f83cc', colorLight: '#4f83cc33' });
    sendPending(); textChanged();
    if (!pending.size) setStatus(t('Сохранено'));
  }
  function connect() {
    if (disposed || disposing || terminal || !navigator.onLine) return;
    socket?.close();
    authorized = false; transportReady = false;
    const channel = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/collaboration/${encodeURIComponent(captureId)}`);
    socket = channel;
    channel.addEventListener('message', async event => {
      if (disposed || terminal || channel !== socket) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'hello') await hello(message, channel);
        else if (message.type === 'update' || message.type === 'sync') {
          if (!doc) return;
          revision = Math.max(revision, message.revision || 0); Y.applyUpdate(doc, toBytes(message.update), REMOTE); textChanged();
        } else if (message.type === 'ack') {
          revision = Math.max(revision, message.revision || 0);
          pending.delete(message.operationId);
          persistenceQueue = persistenceQueue.then(() => outboxRequest(outbox, 'readwrite', store => store.delete(message.operationId)));
          if (!pending.size) setStatus(t('Сохранено'));
          textChanged();
        } else if (message.type === 'awareness' && awareness) applyPresence(message.states);
        else if (message.type === 'revoked') retainDraft(t('Доступ закрыт · черновик сохранён на устройстве.'));
        else if (message.type === 'error' && message.code !== 'invalid_awareness') retainDraft(t('Изменения не приняты. Скопируйте черновик и откройте туду заново.'));
      } catch { retainDraft(t('Не удалось синхронизировать документ. Скопируйте черновик.')); }
    });
    channel.addEventListener('close', event => {
      if (channel !== socket || disposed) return;
      authorized = false;
      if (event.code === 1008) return retainDraft(t('Доступ закрыт · черновик сохранён на устройстве.'));
      if (!terminal) {
        setStatus(t('Нет связи · черновик на устройстве')); exportButton.hidden = false;
        Promise.all([fetch(`/api/captures/${encodeURIComponent(captureId)}/collaboration`), fetch('/api/auth/state')]).then(async ([access, response]) => {
          if (disposed || terminal || channel !== socket) return;
          const account = await response.json();
          if ([401, 403, 404].includes(access.status) || !account.authenticated || account.user?.id !== userId) return retainDraft(t('Доступ закрыт · черновик сохранён на устройстве.'));
          reconnectTimer = setTimeout(connect, 1200);
        }).catch(() => { if (!disposed && !terminal) reconnectTimer = setTimeout(connect, 1200); });
      }
    });
  }
  const onOnline = () => { if (socket?.readyState !== WebSocket.OPEN && !terminal) { clearTimeout(reconnectTimer); connect(); } };
  const onOffline = () => { authorized = false; clearTimeout(reconnectTimer); socket?.close(); setStatus(t("Нет связи · черновик на устройстве")); exportButton.hidden = false; };
  const onPageHide = () => dispose();
  const onJournal = () => onStructure();
  let disposal;
  function dispose() {
    if (disposal) return disposal;
    disposing = true; clearTimeout(reconnectTimer);
    if (awareness) awareness.setLocalState(null);
    titleView?.destroy(); bodyView?.destroy();
    window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); window.removeEventListener('pagehide', onPageHide);
    disposal = (async () => {
      await persistenceQueue;
      if (authorized && socket?.readyState === WebSocket.OPEN) {
        sendPending();
        const deadline = Date.now() + 1500;
        while (pending.size && Date.now() < deadline && socket?.readyState === WebSocket.OPEN) await new Promise(resolve => setTimeout(resolve, 25));
      }
      await persistenceQueue;
      disposed = true; socket?.close(); awareness?.destroy(); undoManager?.destroy();
      await persistence?.destroy(); outbox?.close(); doc?.destroy();
    })();
    return disposal;
  }
  window.addEventListener('online', onOnline); window.addEventListener('offline', onOffline); window.addEventListener('pagehide', onPageHide);
  connect();
  return { captureId, generation, titleElement, bodyElement, dispose, flush: () => persistenceQueue, get revision() { return revision; }, get terminal() { return terminal; }, revoke: retainDraft, refreshDraft };
}
