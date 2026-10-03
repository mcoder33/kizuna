import { t } from './browser-i18n.js';
import { feedbackCard } from './administration.js';

export function mountFeedback({ request, accountKnown }) {
  const root = document.querySelector('#feedback'), form = root.querySelector('form');
  const input = root.querySelector('#feedback-text'), contact = root.querySelector('#feedback-contact');
  const status = root.querySelector('#feedback-status'), button = form.querySelector('button');
  let draftKey = null, requestKey = null, lastBody = null, owner = null, nextCursor = null, items = [], loading = false;
  button.disabled = true;
  input.disabled = true; contact.disabled = true;
  function remember() {
    if (!draftKey) return;
    const body = JSON.stringify({ text: input.value, allowContact: contact.checked });
    if (lastBody !== body) { requestKey = crypto.randomUUID(); lastBody = body; }
    try { localStorage.setItem(draftKey, JSON.stringify({ text: input.value, allowContact: contact.checked, requestKey })); } catch {}
  }
  form.addEventListener('input', remember);
  form.addEventListener('change', remember);
  async function show({ more = false } = {}) {
    const user = await accountKnown(); if (!user) return;
    if (owner !== user.id) {
      owner = user.id; draftKey = `kizuna-feedback-draft:${user.id}`;
      try {
        const draft = JSON.parse(localStorage.getItem(draftKey) || '{}');
        input.value = typeof draft.text === 'string' ? draft.text.slice(0, 3000) : ''; contact.checked = draft.allowContact === true;
        requestKey = typeof draft.requestKey === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(draft.requestKey) ? draft.requestKey : crypto.randomUUID();
      } catch { input.value = ''; contact.checked = false; requestKey = crypto.randomUUID(); }
      lastBody = JSON.stringify({ text: input.value, allowContact: contact.checked });
    }
    if (!loading) { button.disabled = false; input.disabled = false; contact.disabled = false; }
    try {
      const data = await request(`/api/feedback${more && nextCursor ? `?before=${encodeURIComponent(nextCursor)}` : ''}`), wrap = root.querySelector('#my-feedback'); wrap.replaceChildren();
      items = more ? [...items, ...data.feedback] : data.feedback; nextCursor = data.nextCursor;
      const id = new URLSearchParams(location.hash.split('?')[1] || '').get('id');
      if (id && !items.some(item => item.id === id)) {
        const data = await request(`/api/feedback/${encodeURIComponent(id)}`); items.unshift(data.feedback);
      }
      const unique = [...new Map(items.map(item => [item.id, item])).values()];
      for (const item of unique) wrap.append(feedbackCard(item));
      if (nextCursor) {
        const more = document.createElement('button'); more.type = 'button'; more.className = 'secondary admin-more'; more.textContent = t('Показать ещё');
        more.addEventListener('click', () => { more.disabled = true; show({ more: true }); }); wrap.append(more);
      }
      root.querySelector('#my-feedback-group').hidden = !items.length;
      if (id && location.hash.startsWith('#feedback')) root.querySelector(`[data-feedback-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center' });
    } catch (err) { status.textContent = err.message; }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (button.disabled) return;
    remember(); loading = true; button.disabled = true; input.disabled = true; contact.disabled = true; status.textContent = t('Отправляем…');
    try {
      await request('/api/feedback', { method: 'POST', headers: { 'Idempotency-Key': requestKey }, body: JSON.stringify({ text: input.value, allowContact: contact.checked }) });
      input.value = ''; contact.checked = false; requestKey = crypto.randomUUID(); lastBody = null;
      try { localStorage.removeItem(draftKey); } catch {}
      status.textContent = t('Спасибо! Пожелание отправлено. Ответ появится здесь и в уведомлениях.');
      await show();
    } catch (err) { status.textContent = err.message; } finally { loading = false; button.disabled = false; input.disabled = false; contact.disabled = false; }
  });
  return { show };
}
