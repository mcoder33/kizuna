import { t } from './browser-i18n.js';
import { renderMarkdown } from './markdown.js';
import { rememberShare, forgetShare, shareReturnPath } from './share-intent.js';
const token = location.pathname.split('/')[2];
const status = document.getElementById('public-status');
const article = document.getElementById('public-todo');
const join = document.getElementById('public-join');
join.textContent = t('Работать вместе');
let stream, unavailable = false;
function paint(todo) {
  if (unavailable) return;
  document.getElementById('public-title').textContent = todo.title || t('Без названия');
  document.getElementById('public-body').innerHTML = renderMarkdown(todo.body || '');
  document.getElementById('public-state').textContent = todo.state === 'completed' ? t('Сделано') : t('В работе');
  document.getElementById('public-consent-text').textContent = t('Вы присоединитесь к кругу „{name}“ и сможете редактировать его туду.', { name: todo.circleName });
  article.hidden = false;
  status.textContent = '';
}
function revoke(message = t('Ссылка недоступна. Попросите автора прислать новую.')) {
  unavailable = true; stream?.close(); article.hidden = true; status.textContent = message; forgetShare();
}
async function workTogether() {
  if (unavailable) return;
  join.disabled = true;
  try {
    const state = await (await fetch('/api/auth/state')).json();
    if (!state.authenticated) {
      if (rememberShare(token)) location.assign('/login?join');
      return;
    }
    const response = await fetch(`/api/public/todos/${encodeURIComponent(token)}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ consent: true }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || t('Не удалось присоединиться к кругу.'));
    forgetShare();
    if (/^\/#today\?open=[0-9a-f-]{36}$/i.test(data.returnTo)) location.assign(data.returnTo);
    else throw new Error(t('Не удалось открыть туду.'));
  } catch (error) { status.textContent = error.message; }
  finally { join.disabled = false; }
}
join.addEventListener('click', workTogether);
try {
  const response = await fetch(`/api/public/todos/${encodeURIComponent(token)}`);
  if (!response.ok) revoke();
  else {
    paint(await response.json());
    stream = new EventSource(`/api/public/todos/${encodeURIComponent(token)}/events`);
    stream.addEventListener('todo', event => { try { paint(JSON.parse(event.data)); } catch {} });
    stream.addEventListener('revoked', () => revoke());
    stream.onerror = () => { if (!unavailable) status.textContent = t('Связь прервана. Восстанавливаем…'); };
    if (new URLSearchParams(location.search).get('resume') === '1' && shareReturnPath() === `/s/${token}?resume=1`) await workTogether();
  }
} catch { status.textContent = t('Сервер не отвечает. Перезагрузите страницу.'); }
addEventListener('pagehide', () => stream?.close());
