import { t, getLocale, bindTranslation } from './browser-i18n.js';
import { getTimeZone } from './browser-time-zone.js';

export const feedbackStatuses = { new: 'Новое', considering: 'На рассмотрении', done: 'Сделано', later: 'Позже' };
const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
const date = value => new Date(value).toLocaleString(getLocale(), { timeZone: getTimeZone(), dateStyle: 'medium', timeStyle: 'short' });
export function feedbackCard(item, { admin = false } = {}) {
  const card = el('article', undefined, 'feedback-card');
  card.dataset.feedbackId = item.id;
  const head = el('div', undefined, 'feedback-card-head');
  head.append(el('span', t(feedbackStatuses[item.status]), `feedback-status status-${item.status}`), el('time', date(item.createdAt)));
  if (admin) card.append(el('strong', item.name || item.email || t('Учётная запись удалена')));
  card.append(head, el('p', item.text, 'feedback-body'));
  if (admin && item.name && item.email) card.append(el('p', item.email, 'setting-hint'));
  if (admin && item.allowContact) card.append(el('p', t('Можно уточнить детали в приложении'), 'setting-hint'));
  for (const reply of item.replies) {
    const block = el('blockquote', undefined, 'feedback-reply');
    block.append(el('span', t('Ответ администратора')), el('p', reply.text), el('time', date(reply.createdAt)));
    card.append(block);
  }
  return card;
}

export function mountAdministration({ request, toast, accountKnown, loadUsers, loadSettings, loadAi, loadUsage }) {
  const root = document.querySelector('#admin');
  let active = 'inbox', feedback = [], inbox = null, revision = 0, editing = false, nextCursor = null, feedbackRequest = 0, searchTimer;
  const drafts = new Map();
  let notificationDraft = null;
  const syncEditing = () => { editing = drafts.size > 0 || Boolean(notificationDraft); };
  const titles = { inbox: 'Входящие', users: 'Пользователи', feedback: 'Обратная связь', service: 'Настройки сервиса', history: 'История' };
  const error = message => { root.querySelector('#admin-error').textContent = message; };
  async function guarded(action) {
    try { error(''); await action(); } catch (err) { error(err.message); toast(err.message); }
  }
  function route() {
    const hash = location.hash.slice(1).split('?')[0];
    const [page, section = 'inbox', tab = 'ai'] = hash.split('/');
    return { page, section: Object.hasOwn(titles, section) ? section : 'inbox', tab };
  }
  function paintRoute() {
    const current = route(); active = current.section;
    bindTranslation(root.querySelector('#admin-title'), titles[active]);
    for (const panel of root.querySelectorAll('[data-admin-panel]')) panel.hidden = panel.dataset.adminPanel !== active;
    for (const link of root.querySelectorAll('[data-admin-section]')) {
      const selected = link.dataset.adminSection === active;
      link.classList.toggle('active', selected);
      if (selected) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    }
    const tabs = ['ai', 'integrations', 'usage', 'limits', 'notifications', 'memory'];
    const tab = tabs.includes(current.tab) ? current.tab : 'ai';
    for (const panel of root.querySelectorAll('[data-service-panel]')) panel.hidden = panel.dataset.servicePanel !== tab;
    for (const link of root.querySelectorAll('[data-service-tab]')) {
      link.classList.toggle('active', link.dataset.serviceTab === tab);
      if (link.dataset.serviceTab === tab) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    }
    root.querySelector('#admin-navigation').open = false;
  }
  function paintBadge() {
    if (!inbox) return;
    const count = inbox.pending.length + (inbox.feedbackCount ?? inbox.feedback.length);
    for (const node of document.querySelectorAll('[data-admin-count]')) { node.textContent = String(count); node.hidden = !count; }
    const unread = inbox.notifications.filter(item => !item.readAt).length;
    for (const node of root.querySelectorAll('[data-admin-notice-count]')) { node.textContent = String(unread); node.hidden = !unread; }
    const list = root.querySelector('#admin-notices'); list.replaceChildren();
    for (const item of inbox.notifications) {
      const link = el('a', `${t(item.kind === 'signup' ? 'Новая заявка на вход' : item.kind === 'spend' ? 'Расходы' : 'Новое пожелание')} · ${item.text}`, 'admin-notice');
      if (typeof item.data.url !== 'string' || !item.data.url.startsWith('/#admin')) continue;
      link.href = item.data.url.slice(1);
      link.addEventListener('click', () => { void request('/api/notifications/read', { method: 'POST', body: JSON.stringify({ ids: [item.id] }) }).then(refreshBadge).catch(() => {}); });
      list.append(link);
    }
    if (!list.children.length) list.append(el('p', t('Всё разобрано'), 'setting-hint'));
  }
  async function refreshBadge() {
    const user = await accountKnown();
    if (user?.role !== 'admin') return;
    inbox = await request('/api/admin/inbox'); paintBadge();
  }
  function feedbackAction(item) {
    const draft = drafts.get(item.id);
    const card = feedbackCard(item, { admin: true });
    const form = el('form', undefined, 'feedback-review');
    const label = el('label', t('Статус пожелания'));
    const select = el('select'); select.setAttribute('aria-label', t('Статус пожелания'));
    for (const [value, title] of Object.entries(feedbackStatuses)) {
      const option = el('option', t(title)); option.value = value; select.append(option);
    }
    select.value = draft?.status ?? item.status; label.append(select);
    const replyLabel = el('label', t('Ответ пользователю'));
    const reply = el('textarea'); reply.rows = 3; reply.maxLength = 3000; reply.placeholder = t('Ответ увидит автор в приложении'); reply.setAttribute('aria-label', t('Ответ пользователю'));
    reply.value = draft?.reply ?? '';
    replyLabel.append(reply);
    const save = el('button', t('Сохранить'), 'primary'); save.type = 'submit';
    const result = el('p', '', 'setting-hint'); result.setAttribute('role', 'status');
    form.append(label, replyLabel, save, result); card.append(form);
    const remember = () => { drafts.set(item.id, { reply: reply.value, status: select.value, revision: drafts.get(item.id)?.revision ?? item.revision }); syncEditing(); };
    form.addEventListener('input', remember);
    form.addEventListener('change', remember);
    form.addEventListener('submit', async event => {
      event.preventDefault(); save.disabled = true; select.disabled = true; reply.disabled = true; result.textContent = '';
      try {
        await request(`/api/admin/feedback/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: select.value, reply: reply.value, revision: drafts.get(item.id)?.revision ?? item.revision }) });
        drafts.delete(item.id); syncEditing(); toast(t('Сохранено')); await show();
      } catch (err) { result.textContent = err.message; } finally { save.disabled = false; select.disabled = false; reply.disabled = false; }
    });
    return card;
  }
  function paintFeedback() {
    const wrap = root.querySelector('#admin-feedback-list'); wrap.replaceChildren();
    const filter = root.querySelector('#admin-feedback-filter').value;
    const search = root.querySelector('#admin-feedback-search').value.trim().toLocaleLowerCase();
    for (const item of feedback.filter(item => (!filter || item.status === filter) && `${item.text} ${item.name || ''} ${item.email || ''}`.toLocaleLowerCase().includes(search))) wrap.append(feedbackAction(item));
    if (!wrap.children.length) wrap.append(el('p', t('Пожеланий пока нет'), 'empty'));
    if (nextCursor) {
      const more = el('button', t('Показать ещё'), 'secondary admin-more'); more.type = 'button';
      more.addEventListener('click', () => { more.disabled = true; void guarded(() => fetchFeedback({ more: true })); }); wrap.append(more);
    }
  }
  async function fetchFeedback({ more = false, id = null } = {}) {
    const ticket = ++feedbackRequest;
    const query = new URLSearchParams();
    const filter = root.querySelector('#admin-feedback-filter').value;
    const search = root.querySelector('#admin-feedback-search').value.trim();
    if (filter) query.set('status', filter);
    if (search) query.set('q', search);
    if (more && nextCursor) query.set('before', nextCursor);
    const data = await request(`/api/admin/feedback?${query}`);
    if (ticket !== feedbackRequest || route().page !== 'admin' || route().section !== 'feedback') return;
    feedback = more ? [...feedback, ...data.feedback] : data.feedback; nextCursor = data.nextCursor;
    if (id && !feedback.some(item => item.id === id)) {
      const data = await request(`/api/admin/feedback/${encodeURIComponent(id)}`);
      if (ticket !== feedbackRequest || route().section !== 'feedback') return;
      feedback.unshift(data.feedback);
    }
    syncEditing(); paintFeedback();
  }
  function paintInbox() {
    const wrap = root.querySelector('#admin-inbox-feedback'); wrap.replaceChildren();
    for (const item of inbox.feedback) {
      const card = feedbackCard(item, { admin: true });
      const link = el('a', t('Разобрать пожелание'), 'secondary'); link.href = `#admin/feedback?id=${item.id}`;
      card.append(link); wrap.append(card);
    }
    const empty = root.querySelector('#admin-inbox-empty');
    empty.hidden = Boolean(inbox.pending.length || (inbox.feedbackCount ?? inbox.feedback.length));
    if (inbox.feedbackCount > inbox.feedback.length) {
      const link = el('a', t('Показать все пожелания'), 'secondary'); link.href = '#admin/feedback?status=new'; wrap.append(link);
    }
  }
  async function notificationSettings(ticket) {
    const data = await request('/api/admin/notification-settings');
    if (ticket !== revision || route().page !== 'admin' || route().section !== 'service' || route().tab !== 'notifications') return;
    const wrap = root.querySelector('#admin-delivery-settings'); wrap.replaceChildren();
    const form = el('form', undefined, 'admin-delivery-form');
    for (const [kind, title] of [['signup', 'Новая заявка на вход'], ['feedback', 'Новое пожелание']]) {
      const row = el('fieldset'); row.append(el('legend', t(title)));
      for (const [channel, title] of [['app', 'В приложении'], ['telegram', 'В Telegram']]) {
        const label = el('label', undefined, 'admin-delivery-choice');
        const input = el('input'); input.type = 'checkbox'; input.checked = (notificationDraft || data.preferences)[kind][channel]; input.name = `${kind}:${channel}`;
        label.append(input, el('span', t(title))); row.append(label);
      }
      form.append(row);
    }
    const save = el('button', t('Сохранить'), 'primary'); save.type = 'submit'; form.append(save);
    const readPrefs = () => Object.fromEntries(['signup', 'feedback'].map(kind => [kind, Object.fromEntries(['app', 'telegram'].map(channel => [channel, form.elements.namedItem(`${kind}:${channel}`).checked]))]));
    form.addEventListener('change', () => { notificationDraft = readPrefs(); syncEditing(); });
    form.addEventListener('submit', async event => {
      event.preventDefault(); save.disabled = true;
      await guarded(async () => {
        const preferences = readPrefs();
        await request('/api/admin/notification-settings', { method: 'PUT', body: JSON.stringify({ preferences }) });
        if (JSON.stringify(notificationDraft) === JSON.stringify(preferences)) notificationDraft = null;
        syncEditing(); toast(t('Сохранено'));
      }); save.disabled = false;
    });
    wrap.append(form, el('h3', t('Получатели')));
    wrap.append(el('p', t('Уведомления получают активные администраторы. Для Telegram нужна личная привязка бота в настройках профиля.'), 'setting-hint'));
    if (!data.botConfigured) wrap.append(el('p', t('Токен бота не задан. Настройте его в интеграциях.'), 'admin-warning'));
    for (const user of data.recipients) wrap.append(el('p', `${user.name || user.email} · ${t(user.telegramLinked ? 'Telegram подключён' : 'Telegram не подключён')}`, 'admin-recipient'));
    const pending = data.deliveries.filter(row => row.state === 'pending' || row.state === 'sending').reduce((n, row) => n + row.count, 0);
    const failed = data.deliveries.filter(row => row.state === 'failed').reduce((n, row) => n + row.count, 0);
    if (pending) wrap.append(el('p', t('Ожидают отправки: {count}', { count: pending }), 'setting-hint'));
    if (failed) wrap.append(el('p', t('Не доставлено в Telegram: {count}', { count: failed }), 'admin-warning'));
  }
  async function loadMemory(ticket) {
    const data = await request('/api/admin/memory');
    if (ticket !== revision || route().page !== 'admin' || route().section !== 'service' || route().tab !== 'memory') return;
    paintMemory(data);
  }
  function paintMemory(data) {
    const wrap = root.querySelector('#admin-memory-list'); wrap.replaceChildren();
    for (const item of data.memories) {
      const row = el('div', undefined, 'memory-item'); row.append(el('span', item.body, 'memory-body'));
      const forget = el('button', t('Забыть'), 'secondary'); forget.type = 'button';
      forget.addEventListener('click', () => guarded(async () => { forget.disabled = true; paintMemory(await request(`/api/admin/memory/${item.id}`, { method: 'DELETE' })); }));
      row.append(forget); wrap.append(row);
    }
    if (!data.memories.length) wrap.append(el('p', t('Общих правил пока нет'), 'setting-hint'));
  }
  async function show() {
    const ticket = ++revision;
    const current = route();
    if (current.page !== 'admin') return;
    const user = await accountKnown();
    if (user?.role !== 'admin') { location.hash = '#today'; return; }
    if (ticket !== revision || route().page !== 'admin') return;
    paintRoute(); error('');
    await guarded(async () => {
      const data = await request('/api/admin/inbox');
      if (ticket !== revision || route().page !== 'admin') return;
      inbox = data; paintBadge(); paintInbox();
      if (current.section === 'inbox' || current.section === 'users' || current.section === 'history') {
        await loadUsers();
        if (ticket !== revision || route().page !== 'admin') return;
        const userId = new URLSearchParams(location.hash.split('?')[1] || '').get('user');
        if (userId) root.querySelector(`[data-user-id="${CSS.escape(userId)}"]`)?.scrollIntoView({ block: 'center' });
      }
      if (current.section === 'feedback') {
        const params = new URLSearchParams(location.hash.split('?')[1] || '');
        const id = params.get('id');
        if (id) {
          root.querySelector('#admin-feedback-filter').value = ''; root.querySelector('#admin-feedback-search').value = '';
        }
        if (params.has('status')) root.querySelector('#admin-feedback-filter').value = Object.hasOwn(feedbackStatuses, params.get('status')) ? params.get('status') : '';
        await fetchFeedback({ id });
        if (ticket !== revision || route().section !== 'feedback') return;
        if (id) root.querySelector(`#admin-feedback-list [data-feedback-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center' });
      }
      if (current.section === 'service') {
        await loadSettings();
        if (ticket !== revision || route().page !== 'admin') return;
        if (current.tab === 'ai' || current.tab === undefined) await loadAi();
        if (current.tab === 'usage') await loadUsage();
        if (current.tab === 'notifications') await notificationSettings(ticket);
        if (current.tab === 'memory') await loadMemory(ticket);
      }
    });
  }
  async function refresh() {
    try { await refreshBadge(); } catch {}
    if (route().page === 'admin' && !editing) await show();
  }
  root.querySelector('#admin-feedback-filter').addEventListener('change', () => guarded(() => fetchFeedback()));
  root.querySelector('#admin-feedback-search').addEventListener('input', () => {
    clearTimeout(searchTimer); searchTimer = setTimeout(() => guarded(() => fetchFeedback()), 250);
  });
  root.querySelector('#admin-history-search').addEventListener('input', event => {
    const value = event.target.value.trim().toLocaleLowerCase();
    for (const row of root.querySelectorAll('.admin-event')) row.hidden = !row.textContent.toLocaleLowerCase().includes(value);
  });
  root.querySelector('#admin-memory-form').addEventListener('submit', event => {
    event.preventDefault(); const input = root.querySelector('#admin-memory-new'), save = root.querySelector('#admin-memory-save');
    save.disabled = true;
    void guarded(async () => { paintMemory(await request('/api/admin/memory', { method: 'POST', body: JSON.stringify({ text: input.value }) })); input.value = ''; toast(t('Сохранено')); }).finally(() => { save.disabled = false; });
  });
  root.querySelector('#admin-notices-menu').addEventListener('click', event => { if (event.target.closest('a')) root.querySelector('#admin-notices-menu').open = false; });
  return { show, refresh, refreshBadge };
}
