import { t } from './browser-i18n.js';
export async function openTodoSharing(entry, { request, userId, refresh }) {
  const dialog = document.createElement('dialog'); dialog.className = 'todo-share-dialog';
  const content = document.createElement('div'); content.className = 'todo-share-content';
  const title = document.createElement('h2'); title.textContent = t('Поделиться туду');
  const hint = document.createElement('p'); hint.textContent = t('По ссылке гости видят только эту туду. После регистрации и согласия они получают доступ ко всем туду выбранного круга.');
  const select = document.createElement('select'); select.setAttribute('aria-label', t('Круг для совместной работы'));
  const create = document.createElement('button'); create.type = 'button'; create.textContent = t('Создать публичную ссылку');
  const message = document.createElement('p'); message.setAttribute('role', 'status');
  const links = document.createElement('div'); links.className = 'todo-share-links';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = t('Закрыть');
  close.addEventListener('click', () => dialog.close());
  content.append(title, hint, select, create, message, links, close); dialog.append(content); document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true }); dialog.showModal();
  const storageKey = `pagent.share-links:${userId}:${entry.id}`;
  let cached = {};
  try { cached = JSON.parse(sessionStorage.getItem(storageKey) || '{}'); } catch {}
  async function paintLinks() {
    const { shares } = await request(`/api/captures/${entry.id}/public-shares`);
    if (!dialog.isConnected) return;
    links.replaceChildren();
    for (const share of shares.filter(item => !item.revokedAt)) {
      const row = document.createElement('div'); row.className = 'todo-share-link';
      const label = document.createElement('span'); label.textContent = cached[share.id] || t('Публичная ссылка действует · полный адрес показан при создании');
      if (cached[share.id]) {
        const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = t('Скопировать');
        copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(cached[share.id]); message.textContent = t('Ссылка скопирована'); } catch { message.textContent = cached[share.id]; } }); row.append(copy);
      }
      const revoke = document.createElement('button'); revoke.type = 'button'; revoke.textContent = t('Отключить ссылку');
      revoke.addEventListener('click', async () => { revoke.disabled = true; try { await request(`/api/captures/${entry.id}/public-shares/${share.id}`, { method: 'DELETE' }); delete cached[share.id]; sessionStorage.setItem(storageKey, JSON.stringify(cached)); await paintLinks(); message.textContent = t('Ссылка отключена. Уже вступившие участники остаются в круге.'); } catch (error) { message.textContent = error.message; revoke.disabled = false; } });
      row.prepend(label); row.append(revoke); links.append(row);
    }
  }
  try {
    const { circles } = await request('/api/circles');
    for (const circle of circles) { const option = document.createElement('option'); option.value = circle.id; option.textContent = circle.name; select.append(option); }
    create.disabled = !circles.length;
    if (!circles.length) message.textContent = t('Сначала создайте круг в разделе «За столом».');
    await paintLinks();
  } catch (error) { message.textContent = error.message; create.disabled = true; }
  create.addEventListener('click', async () => {
    create.disabled = true;
    try {
      const share = await request(`/api/captures/${entry.id}/public-shares`, { method: 'POST', body: JSON.stringify({ circleId: select.value }) });
      cached[share.id] = new URL(share.url, location.origin).href;
      sessionStorage.setItem(storageKey, JSON.stringify(cached));
      message.textContent = cached[share.id]; await paintLinks(); await refresh();
    } catch (error) { message.textContent = error.message; }
    finally { create.disabled = false; }
  });
}
