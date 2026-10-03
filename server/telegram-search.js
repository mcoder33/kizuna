import crypto from 'node:crypto';
import { dateInZone } from './reports.js';
import { createTaskSearchService } from './task-search.js';
import { createTelegramTaskSearchAccess } from './telegram-day-access.js';

export const TASK_SEARCH_LABEL = 'Найти';
export const TASK_SEARCH_COMMANDS = [{ command: 'find', description: 'Найти записи по теме, словам или периоду' }];
const TTL = 10 * 60 * 1000;
const LIMIT = 256;
const bindingKey = link => JSON.stringify([link.user_id, String(link.telegram_id), String(link.chat_id), link.linked_at]);
const forwarded = message => Boolean(message?.forward_origin || message?.forward_from || message?.forward_sender_name || message?.forward_from_chat);
const plainText = message => typeof message?.text === 'string' && !['document', 'photo', 'video', 'audio', 'voice', 'animation', 'sticker', 'video_note', 'location', 'contact', 'poll', 'venue'].some(key => message[key]);
const commandName = text => /^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i.exec(text || '')?.[1]?.toLowerCase();
function clip(value, max) {
  const text = String(value || '');
  if (text.length <= max) return text;
  let end = max - 1;
  if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return `${text.slice(0, end)}…`;
}
const lineText = value => String(value || '').replace(/\s+/g, ' ').trim();

export function taskSearchTaskUrl(appUrl, captureId) {
  if (!/^[0-9a-f-]{36}$/i.test(captureId || '')) return null;
  try {
    const url = new URL(appUrl), host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || host === 'localhost' || host.endsWith('.localhost') || /^[\d.]+$/.test(host) || host.includes(':')) return null;
    url.search = ''; url.hash = ''; url.pathname = url.pathname.replace(/\/+$/, '') + '/';
    url.hash = `today?open=${captureId}`;
    return url.toString();
  } catch { return null; }
}

export function renderTaskSearchResult(result, { appUrl, nextCallback = null } = {}) {
  if (result.clarification) return { text: clip(result.clarification, 3800), markup: null };
  const criteria = result.criteria || {};
  const typeLabels = { task:'Дело', subtask:'Подзадача', note:'Заметка', meeting_event:'Встреча', outcome_decision:'Результат', idea_question:'Идея / вопрос', unknown:'Запись' };
  const filters = [criteria.exclusivePerson && criteria.person ? `Человек: ${lineText(criteria.person)}` : '', criteria.type ? typeLabels[criteria.type] : '', criteria.status === 'open' ? 'Открытые' : criteria.status === 'done' ? 'Выполненные' : '', criteria.period ? `${criteria.period.from} — ${criteria.period.to}` : '', criteria.period ? `Период: ${{ created: 'добавлено', completed: 'выполнено', deadline: 'срок', scheduled: 'запланировано', createdOrCompleted: 'добавлено или выполнено' }[criteria.basis] || 'добавлено или выполнено'}` : '', criteria.inherited ? 'С учётом предыдущего поиска' : ''].filter(Boolean);
  const lines = [`Найдено: ${Number(result.matchedCount) || 0}${result.partialCoverage ? ' (часть истории)' : ''}`, clip(filters.join(' · '), 300)];
  const rows = [];
  const items = (result.items || []).slice(0, 6);
  if (!items.length) lines.push(result.partialCoverage ? 'В просмотренной части истории совпадений нет. Уточните период или тему.' : 'Подходящих записей по доступным данным нет. Попробуйте другие слова или период.');
  items.forEach((item, index) => {
    const number = index + 1;
    const status = item.completionKind === 'occurrence' ? `Выполнен повтор ${item.matchedOccurrences?.map(part => part.date).slice(0, 3).join(', ') || ''}; серия открыта` : item.status === 'done' ? 'Выполнено' : item.status === 'open' ? 'Открыто' : '';
    const type = item.container ? 'Запись с действиями' : typeLabels[item.subtask ? 'subtask' : item.type] || 'Запись';
    const dates = [];
    if (item.createdAt && Number.isFinite(Date.parse(item.createdAt))) dates.push(`Добавлено: ${dateInZone(new Date(item.createdAt), item.timeZone || 'Europe/Samara')}`);
    if (item.completedAt && Number.isFinite(Date.parse(item.completedAt))) dates.push(`Выполнено: ${dateInZone(new Date(item.completedAt), item.timeZone || 'Europe/Samara')}`);
    if (item.deadline) dates.push(`Срок: ${item.deadline}`);
    else if (item.scheduledDate) dates.push(`План: ${item.scheduledDate}`);
    const itemLines = [`${number}. ${clip(lineText(item.title) || 'Без названия', 140)}\n${clip([type,status].filter(Boolean).join(' · '),170)}`,clip(dates.join(' · '),180)];
    lines.push(`\n${clip(itemLines.filter(Boolean).join('\n'), 380)}`);
    const buttons = [];
    const url = taskSearchTaskUrl(appUrl, item.captureId);
    if (url) buttons.push({ text: `${number}. Открыть запись`, url });
    if (/^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{3,31}\/[1-9]\d*$/.test(item.sourceUrl || '')) buttons.push({ text: `${number}. Исходное сообщение`, url: item.sourceUrl });
    if (buttons.length) rows.push(buttons);
    const relatedButtons = [];
    for (const [index,relation] of (item.relations || []).slice(0,3).entries()) {
      const relatedUrl=taskSearchTaskUrl(appUrl,relation.captureId);
      if (relatedUrl) relatedButtons.push({text:`${number}. ${['parent','place'].includes(relation.relation) ? 'Родитель' : 'Связанная запись'} ${index+1}`,url:relatedUrl});
    }
    if (relatedButtons.length) rows.push(relatedButtons);
  });
  if (result.changedDuringSearch) lines.push('\nДанные изменились во время поиска. Повторите запрос.');
  else if (result.partialCoverage && items.length) lines.push('\nРезультат неполный. Уточните период или запрос.');
  lines.push('\nПоиск окончен. Обычный текст снова сохраняется. Для нового поиска нажмите «Найти».');
  if (nextCallback && !result.partialCoverage) rows.push([{ text: 'Ещё записи', callback_data: nextCallback }]);
  return { text: clip(lines.filter(Boolean).join('\n'), 3800), markup: rows.length ? { inline_keyboard: rows } : null };
}

// A plugin for the shared summary router. It never dispatches Telegram updates itself.
export function installTelegramTaskSearch({ menuRouter, db, search = createTaskSearchService(db), currentBinding = null, canAccess = createTelegramTaskSearchAccess(), now = () => new Date(), timeZone = () => 'Europe/Samara' } = {}) {
  const required = ['registerPreflight', 'registerMessageRoute', 'registerPendingMode', 'registerCallbackRoute', 'registerReplyKeyboardButton', 'replyKeyboard', 'canAccessMenu'];
  if (!menuRouter || required.some(name => typeof menuRouter[name] !== 'function')) return { installed: false, reason: 'shared_menu_router_required' };
  const sessions = new Map(), pages = new Map(), claimedMessages = new WeakSet(), claimedCallbacks = new WeakSet();
  let revision = 0;
  const receipt = db.prepare('SELECT 1 FROM task_search_receipts WHERE receipt_key=?');
  const reserve = db.prepare('INSERT OR IGNORE INTO task_search_receipts(receipt_key,user_id,binding_key,kind,created_at) VALUES(?,?,?,?,?)');
  const readIntent = db.prepare('SELECT * FROM task_search_intents WHERE connection_key=?');
  const deleteIntent = db.prepare('DELETE FROM task_search_intents WHERE connection_key=?');
  const writeIntent = db.prepare('INSERT INTO task_search_intents(connection_key,user_id,binding_key,expires_at,created_at) VALUES(?,?,?,?,?) ON CONFLICT(connection_key) DO UPDATE SET user_id=excluded.user_id,binding_key=excluded.binding_key,expires_at=excluded.expires_at,created_at=excluded.created_at');
  const dbBinding = link => {
    const actual = db.prepare("SELECT l.* FROM telegram_links l JOIN users u ON u.id=l.user_id WHERE l.telegram_id=? AND u.status='active'").get(link.telegram_id);
    return actual && bindingKey(actual) === bindingKey(link) ? actual : null;
  };
  const bindingFresh = link => dbBinding(link) && (!currentBinding || currentBinding(link));
  const searchAllowed = link => Boolean(link && (typeof canAccess === 'function' && canAccess(link.user_id)));
  const fresh = link => bindingFresh(link) && searchAllowed(link);
  const generation = link => search.generation?.(link.user_id) || 0;
  const scope = link => `${bindingKey(link)}:${generation(link)}`;
  const baseKey = link => `${link.telegram_id}:${link.chat_id}`;
  const messageKey = message => Number.isInteger(message?.message_id) && message?.chat?.id != null ? `message:${message.chat.id}:${message.message_id}` : null;
  const callbackKey = callback => typeof callback?.id === 'string' && callback.id.length <= 256 ? `callback:${callback.id}` : null;
  const authorized = (link, from, chat) => from && !from.is_bot && chat?.type === 'private' && String(chat.id) === String(from.id) && String(from.id) === String(link.telegram_id) && String(chat.id) === String(link.chat_id) && bindingFresh(link);
  const currentInteraction = (link, state, expectedRevision) => fresh(link) && scope(link) === state.scope && sessions.get(baseKey(link)) === state && state.revision === expectedRevision;
  const safeSend = (send, link, text, markup, expectedScope = scope(link), state = null, expectedRevision = null) => fresh(link) && scope(link) === expectedScope && (!state || currentInteraction(link, state, expectedRevision)) ? send(link, text, markup) : Promise.resolve(null);
  function clearPages(link) { for (const [key, page] of pages) if (page.base === baseKey(link)) pages.delete(key); }
  function session(link) {
    const key = baseKey(link), expected = scope(link), previous = sessions.get(key);
    if (previous?.scope === expected) return previous;
    const savedIntent = readIntent.get(key);
    previous?.searchController?.abort();
    const next = { scope: expected, revision: ++revision, pendingUntil: null, expiredPending: Boolean(previous?.pendingUntil || previous?.expiredPending || savedIntent), lastCriteria: null, contextUntil: 0 };
    sessions.set(key, next); clearPages(link);
    if (sessions.size > LIMIT) sessions.delete(sessions.keys().next().value);
    return next;
  }
  function clear(link, interactions, { keepCriteria = false, preserveSharedMode = false } = {}) {
    const state = session(link);
    state.searchController?.abort();state.searchController=null;
    state.revision = ++revision;
    state.pendingUntil = null; state.expiredPending = false;
    if (!keepCriteria) { state.lastCriteria = null; state.contextUntil = 0; }
    if (!preserveSharedMode || interactions.get(link)?.mode === 'task-search') interactions.clear(link);
    clearPages(link); deleteIntent.run(baseKey(link));
  }
  function beginIntent(link, state) {
    state.pendingUntil = now().getTime() + TTL;
    writeIntent.run(baseKey(link), link.user_id, scope(link), new Date(state.pendingUntil).toISOString(), now().toISOString());
  }
  function discardRevokedContext(link, interactions) {
    if (!bindingFresh(link) || searchAllowed(link)) return;
    const state = session(link);
    if (!pendingSearch(state, interactions, link)) { clear(link, interactions, { preserveSharedMode: true }); return; }
    state.revision = ++revision;
    state.lastCriteria = null; state.contextUntil = 0;
    state.pendingUntil = null; state.expiredPending = true;
    interactions.clear(link); clearPages(link);
  }
  function claim(link, value, kind, isCallback = false) {
    const claimed = isCallback ? claimedCallbacks : claimedMessages;
    if (claimed.has(value)) return true;
    const key = isCallback ? callbackKey(value) : messageKey(value);
    if (!key || !reserve.run(key, link.user_id, scope(link), kind, now().toISOString()).changes) return false;
    claimed.add(value); return true;
  }
  const pendingSearch = (state, interactions, link) => Boolean(state.pendingUntil || state.expiredPending || interactions.get(link)?.mode === 'task-search');
  function nextPage(link, result) {
    for (const [key, value] of pages) if (value.expiresAt <= now().getTime()) pages.delete(key);
    if (!result.hasMore || result.partialCoverage) return null;
    const token = crypto.randomBytes(16).toString('hex');
    pages.set(token, { base: baseKey(link), scope: scope(link), criteria: structuredClone(result.criteria), offset: result.nextOffset, expiresAt: now().getTime() + TTL });
    if (pages.size > LIMIT) pages.delete(pages.keys().next().value);
    return `ts:page:${token}`;
  }
  function refreshResult(link,result) {
    const previous=result.items || [];
    const visible=previous.map(item=>search.byId ? search.byId({userId:link.user_id,captureId:item.captureId,timeZone:timeZone(link.user_id),criteria:result.criteria}) : item).filter(Boolean);
    if (visible.length!==previous.length) { result.partialCoverage=true;result.hasMore=false;result.matchedCount=visible.length;result.changedDuringSearch=true; }
    result.items=visible;
  }
  async function executeQuery(link, text, message, interactions, send, supplied = null) {
    if (!fresh(link) || !claim(link, message, 'query')) return true;
    const state = session(link), expectedScope = state.scope;
    const previousCriteria = state.contextUntil > now().getTime() ? state.lastCriteria : null;
    clear(link, interactions, { keepCriteria: true });
    const expectedRevision = state.revision;
    const controller = new AbortController();state.searchController=controller;
    try {
      const result = await search.search({ userId: link.user_id, query: text, now: now(), timeZone: timeZone(link.user_id), previousCriteria, ...(supplied || {}),signal:controller.signal,isCurrent:()=>currentInteraction(link,state,expectedRevision) });
      if (!currentInteraction(link, state, expectedRevision)) { discardRevokedContext(link, interactions); return true; }
      refreshResult(link,result);
      if (result.criteria && !result.clarification) { state.lastCriteria = structuredClone(result.criteria); state.contextUntil = now().getTime() + TTL; }
      const rendered = renderTaskSearchResult(result, { appUrl: link.app_url, nextCallback: nextPage(link, result) });
      if (result.clarification) rendered.text = clip(`${rendered.text}\nДля уточнения снова нажмите «Найти». Обычный текст сохраняется.`, 3800);
      await safeSend(send, link, rendered.text, rendered.markup || menuRouter.replyKeyboard(link), expectedScope, state, expectedRevision);
    } catch {
      discardRevokedContext(link, interactions);
      await safeSend(send, link, 'Поиск не выполнен. Нажмите «Найти» и попробуйте снова. Обычный текст сохраняется.', menuRouter.replyKeyboard(link), expectedScope, state, expectedRevision);
    } finally { if(state.searchController===controller)state.searchController=null; }
    return true;
  }

  menuRouter.registerReplyKeyboardButton(TASK_SEARCH_LABEL, { row: 0, visible: link => fresh(link) });
  menuRouter.registerPendingMode('task-search', { accept: text => Boolean(text.trim()), consume: (link, text, data, message) => executeQuery(link, text, message, menuRouter.interactions, data.send) });
  menuRouter.registerPreflight(async ({ message, callback, link, interactions, send }) => {
    const actor = callback?.from || message?.from, chat = callback?.message?.chat || message?.chat;
    if (!authorized(link, actor, chat)) return true;
    const key = callback ? callbackKey(callback) : messageKey(message);
    if (key && receipt.get(key)) return true;
    const state = session(link);
    if (!searchAllowed(link)) {
      const wasPending = pendingSearch(state, interactions, link);
      clear(link, interactions, { preserveSharedMode: true });
      if (callback) return String(callback.data || '').startsWith('ts:');
      const text = typeof message.text === 'string' ? message.text.trim() : '';
      if (plainText(message) && !forwarded(message) && (commandName(text) === 'find' || text === TASK_SEARCH_LABEL)) {
        await send(link, 'Поиск пока недоступен. Сводка дня и календарь — в меню ниже.', menuRouter.replyKeyboard(link));
        return true;
      }
      if (wasPending && plainText(message) && !forwarded(message) && !commandName(text) && text !== TASK_SEARCH_LABEL && text !== 'Отмена') {
        if (!claim(link, message, 'query')) return true;
        await send(link, 'Режим поиска сброшен: доступ к меню отключён. Это сообщение не сохранено. Можно снова писать задачи.');
        return true;
      }
      return false;
    }
    if (callback) {
      if (!claim(link, callback, 'callback', true)) return true;
      if (!String(callback.data || '').startsWith('ts:page:')) clear(link, interactions);
      return false;
    }
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (forwarded(message) || !plainText(message)) {
      const wasPending = pendingSearch(state, interactions, link);
      clear(link, interactions);
      if (wasPending) {
        try { await safeSend(send, link, 'Поиск отменён. Пересланное сообщение или файл сохраняется обычным способом.', menuRouter.replyKeyboard(link)); }
        catch { /* Notification failure must not prevent the existing capture flow. */ }
      }
      return false;
    }
    const command = commandName(text);
    const menuButton = (menuRouter.replyKeyboard(link)?.keyboard || []).flat().some(button => (typeof button === 'string' ? button : button.text) === text);
    if (command || menuButton || text === 'Отмена') {
      if (!claim(link, message, command === 'find' || text === TASK_SEARCH_LABEL ? 'find' : 'command')) return true;
      clear(link, interactions, { keepCriteria: command === 'find' || text === TASK_SEARCH_LABEL });
      if (command === 'find' || text === TASK_SEARCH_LABEL) beginIntent(link, state);
      if (command === 'cancel' || text === 'Отмена') { await safeSend(send, link, 'Поиск отменён. Можно снова писать и пересылать задачи.', menuRouter.replyKeyboard(link)); return true; }
      return false;
    }
    if (pendingSearch(state, interactions, link)) {
      if (!claim(link, message, 'query')) return true;
      if (state.expiredPending || !state.pendingUntil || state.pendingUntil <= now().getTime() || interactions.get(link)?.mode !== 'task-search') {
        clear(link, interactions);
        await safeSend(send, link, 'Режим поиска истёк или был сброшен. Нажмите «Найти» и повторите запрос. Это сообщение не сохранено.', menuRouter.replyKeyboard(link));
        return true;
      }
    }
    return false;
  });
  menuRouter.registerMessageRoute(async ({ message, text, link, interactions, send }) => {
    if (!authorized(link, message.from, message.chat) || !fresh(link) || forwarded(message) || !plainText(message)) return false;
    if (commandName(text) === 'find' || text === TASK_SEARCH_LABEL) {
      if (!claim(link, message, 'find')) return true;
      const state = session(link); clear(link, interactions, { keepCriteria: true });
      beginIntent(link, state);
      interactions.begin(link, 'task-search', { send });
      await safeSend(send, link, 'Что найти?\nНапишите запрос. Например: «что у нас с Саньком», «войсопс» или «заметки за прошлую неделю».\nСледующий текст будет поиском. Пересылка или файл отменят поиск и сохранятся как обычно. «Отмена» — вернуться к сохранению.', { ...menuRouter.replyKeyboard(link), keyboard: [...menuRouter.replyKeyboard(link).keyboard, ['Отмена']] });
      return true;
    }
    const state = session(link);
    // Runs before the shared weekday shortcut: this text was explicitly intended as a query.
    if (state.pendingUntil && interactions.get(link)?.mode === 'task-search') return executeQuery(link, text, message, interactions, send);
    return false;
  });
  menuRouter.registerCallbackRoute(async ({ callback, link, interactions, send }) => {
    if (!String(callback.data || '').startsWith('ts:')) return false;
    if (!authorized(link, callback.from, callback.message?.chat) || !fresh(link) || !claim(link, callback, 'callback', true)) return true;
    const token = /^ts:page:([a-f0-9]{32})$/.exec(callback.data)?.[1], page = token && pages.get(token);
    const state = session(link), expectedScope = state.scope;
    clear(link, interactions, { keepCriteria: true });
    const expectedRevision = state.revision;
    if (!page || page.scope !== scope(link) || page.expiresAt <= now().getTime()) {
      await safeSend(send, link, 'Эта страница поиска недоступна или устарела. Нажмите «Найти» для нового запроса.', menuRouter.replyKeyboard(link)); return true;
    }
    try {
      const result = await search.search({ userId: link.user_id, criteria: page.criteria, offset: page.offset, now: now(), timeZone: timeZone(link.user_id) });
      if (!currentInteraction(link, state, expectedRevision)) { discardRevokedContext(link, interactions); return true; }
      refreshResult(link,result);
      const rendered = renderTaskSearchResult(result, { appUrl: link.app_url, nextCallback: nextPage(link, result) });
      await safeSend(send, link, rendered.text, rendered.markup || menuRouter.replyKeyboard(link), expectedScope, state, expectedRevision);
    } catch { discardRevokedContext(link, interactions); await safeSend(send, link, 'Не удалось открыть страницу. Нажмите «Найти» и повторите запрос.', menuRouter.replyKeyboard(link), expectedScope, state, expectedRevision); }
    return true;
  });
  return { installed: true, clear: link => clear(link, menuRouter.interactions), pending: link => Boolean(fresh(link) && session(link).pendingUntil), sessionCount: () => sessions.size, pageCount: () => pages.size };
}
