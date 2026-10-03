import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';

// Seed the retired editor's persisted format: a Yjs update in its document
// database and an unsent operation in the separate account-scoped outbox.
async function seedDraft(page, userId, marker, pending = true) {
  const doc = new Y.Doc();
  doc.getText('title').insert(0, 'Offline draft');
  doc.getText('body').insert(0, marker);
  const update = Array.from(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  const storageName = `pagent-collaboration:${userId}:${randomUUID()}:${randomUUID()}`;
  await page.evaluate(async ({ storageName, update, pending }) => {
    const open = (name, create) => new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => create(request.result);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const write = (db, store, value) => new Promise((resolve, reject) => {
      const transaction = db.transaction(store, 'readwrite');
      transaction.objectStore(store).add(value);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    const document = await open(storageName, db => {
      db.createObjectStore('updates', { autoIncrement: true });
      db.createObjectStore('custom');
    });
    await write(document, 'updates', new Uint8Array(update));
    document.close();
    const outbox = await open(`${storageName}:outbox`, db => db.createObjectStore('pending', { keyPath: 'operationId' }));
    if (pending) await write(outbox, 'pending', { operationId: crypto.randomUUID(), update });
    outbox.close();
  }, { storageName, update, pending });
}

test('retired offline drafts are copyable only by their account and never replayed', async ({ page, context }) => {
  const sockets = [];
  const mutations = [];
  page.on('websocket', socket => sockets.push(socket.url()));
  page.on('request', request => {
    if (!['GET', 'HEAD'].includes(request.method()) && /\/api\/(?:captures|circles|collaboration|public-shares)(?:\/|$)/.test(request.url())) mutations.push(request.url());
  });
  await page.goto('/');
  const owner = (await (await page.request.get('/api/auth/state')).json()).user;
  await seedDraft(page, owner.id, 'OWNER_UNSENT_TEXT');
  await seedDraft(page, owner.id, 'ACCEPTED_CACHE_NOT_A_DRAFT', false);
  await page.reload();
  await page.locator('#account-summary').click();
  await page.locator('#account-local-drafts').click();
  const field = page.getByRole('textbox', { name: 'Черновик для копирования' });
  await expect(field).toHaveCount(1);
  await expect(field).toHaveValue('Offline draft\n\nOWNER_UNSENT_TEXT');
  await expect(field).toHaveAttribute('readonly', '');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Скопировать черновик' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Offline draft\n\nOWNER_UNSENT_TEXT');
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();

  // Switch the actual authenticated cookie in the same browser storage: the
  // prior account's database is still present but must not be discoverable.
  expect((await page.request.post('/api/auth/logout')).ok()).toBe(true);
  const signup = await page.request.post('/api/auth/register', { data: {
    email: `draft-isolation-${randomUUID()}@kizuna.test`, password: 'draft-isolation-long-password',
  } });
  expect(signup.status()).toBe(201);
  await page.reload();
  await page.locator('#account-summary').click();
  await expect(page.locator('#account-local-drafts')).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Черновик для копирования' })).toHaveCount(0);
  const other = (await (await page.request.get('/api/auth/state')).json()).user;
  expect(other.id).not.toBe(owner.id);
  await seedDraft(page, other.id, 'OTHER_ACCOUNT_ONLY');
  await page.reload();
  await page.locator('#account-summary').click();
  await page.locator('#account-local-drafts').click();
  await expect(field).toHaveCount(1);
  await expect(field).toHaveValue('Offline draft\n\nOTHER_ACCOUNT_ONLY');
  expect(sockets).toEqual([]);
  expect(mutations).toEqual([]);
});
