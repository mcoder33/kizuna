import { totpCode } from '../server/auth.js';
import { test, expect } from '@playwright/test';

async function setup(request) {
  const capture = await request.post('/api/captures', { data: { raw: 'Совместная туду', provider: 'fallback' } });
  expect(capture.status()).toBe(201);
  const { entry } = await capture.json();
  const circleResponse = await request.post('/api/circles', { data: { name: `Работа вместе ${Date.now()}` } });
  expect(circleResponse.status()).toBe(201);
  const { circle } = await circleResponse.json();
  const response = await request.post(`/api/captures/${entry.id}/public-shares`, { data: { circleId: circle.id } });
  expect(response.status()).toBe(201);
  return { entry, circle, share: await response.json() };
}
const body = page => page.locator('.collaborative-body-host .cm-content');
const title = page => page.locator('.collaborative-title .cm-content');
async function open(page, id) {
  await page.goto(`/#today?open=${id}`);
  await expect(body(page)).toBeVisible();
  await expect(page.locator('.collaborative-status')).toHaveText('Сохранено');
}
async function append(page, text, editor = body) {
  const field = editor(page); await field.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(text);
}

test('public consent/signup opens the same collaborative todo; typing, own undo, offline merge and removal', async ({ page, request, browser }, testInfo) => {
  const { entry, circle, share } = await setup(request);
  const guest = await browser.newContext({ storageState: { cookies: [], origins: [] }, locale: 'ru-RU' });
  const second = await guest.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message)); second.on('pageerror', error => errors.push(error.message));
  for (const client of [page, second]) client.on('websocket', socket => socket.on('framereceived', event => { const frame = JSON.parse(event.payload); if (frame.type === 'error') console.error('COLLAB_FRAME_ERROR', JSON.stringify(frame)); }));
  try {
    await second.goto(share.url);
    await expect(second.locator('#public-title')).toHaveText(entry.interpretation.classification.summary);
    await expect(second.locator('#public-consent-text')).toContainText(circle.name);
    await expect(second.locator('[contenteditable=true]')).toHaveCount(0);
    await second.getByRole('button', { name: 'Работать вместе', exact: true }).click();
    await expect(second).toHaveURL(/\/login\?join$/);
    await second.locator('#auth-email').fill(`collaborator-${Date.now()}@kizuna.test`);
    await second.locator('#auth-password').fill('collaboration-password-2026');
    await second.locator('#auth-password-repeat').fill('collaboration-password-2026');
    await second.getByRole('button', { name: 'Зарегистрироваться', exact: true }).click();
    await expect(body(second)).toBeVisible();
    await expect(second.locator('.collaborative-status')).toHaveText('Сохранено');
    const state = await (await second.request.get('/api/auth/state')).json();
    await open(page, entry.id);
    await Promise.all([append(page, 'Alpha '), append(second, 'Beta ')]);
    await expect(body(page)).toContainText('Alpha'); await expect(body(page)).toContainText('Beta');
    await expect(body(second)).toContainText("Alpha"); await expect(body(second)).toContainText("Beta");
    await append(second, ' Together', title);
    await expect(title(page)).toContainText('Together');
    await append(page, 'OWNER_UNDO'); await expect(body(second)).toContainText('OWNER_UNDO');
    await page.keyboard.press('ControlOrMeta+z');
    await expect(body(page)).not.toContainText('OWNER_UNDO'); await expect(body(page)).toContainText('Beta');
    await expect(second.locator('.collaborative-presence')).toContainText('e2e');
    await guest.setOffline(true); await append(second, 'OFFLINE');
    await expect(second.locator('.collaborative-status')).not.toHaveText('Сохранено');
    await append(page, 'ONLINE');
    await guest.setOffline(false);
    await expect(body(page)).toContainText('OFFLINE'); await expect(body(second)).toContainText('ONLINE');
    await expect(second.locator('.collaborative-status')).toHaveText('Сохранено');
    await open(page, entry.id); await expect(body(page)).toContainText('OFFLINE');
    await expect(title(page)).toContainText('Together');
    const viewer = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const preview = await viewer.newPage();
    await preview.goto(share.url); await expect(preview.locator('#public-body')).toContainText('OFFLINE');
    await append(second, 'LIVE_GUEST'); await expect(preview.locator('#public-body')).toContainText('LIVE_GUEST');
    expect((await request.delete(`/api/circles/${circle.id}/members/${state.user.id}`)).status()).toBe(200);
    await expect(second.locator('.collaborative-draft')).toBeVisible();
    await expect(second.locator('.collaborative-draft')).toHaveValue(/LIVE_GUEST/);
    await expect(body(second)).toHaveAttribute('contenteditable', 'false');
    expect((await second.request.post(`/api/public/todos/${share.token}/join`, { data: { consent: true } })).status()).toBe(403);
    expect((await request.post(`/api/circles/${circle.id}/members/${state.user.id}/restore`, { data: {} })).status()).toBe(200);
    await second.reload(); await open(second, entry.id); await expect(body(second)).toBeVisible(); await expect(second.locator('.collaborative-status')).toHaveText('Сохранено');
    expect((await request.delete(`/api/captures/${entry.id}/public-shares/${share.id}`)).status()).toBe(200);
    await expect(preview.locator('#public-status')).toContainText('Ссылка недоступна');
    await expect(preview.locator('#public-todo')).toBeHidden();
    await viewer.close();
    expect(errors).toEqual([]);
  } finally { await guest.close(); }
});

for (const width of [375, 768, 1440]) test(`sharing and collaborative editor fit ${width}px`, async ({ page, request, browser }, testInfo) => {
  const { entry, share } = await setup(request);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width, height: 900 }); await open(page, entry.id);
  await page.getByRole('button', { name: 'Поделиться', exact: true }).click();
  await expect(page.locator('.todo-share-dialog')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`sharing-${width}.png`), fullPage: true });
  await page.locator('.todo-share-dialog').getByRole('button', { name: 'Закрыть', exact: true }).click();
  await append(page, 'Markdown **вместе**');
  await expect(page.locator('.collaborative-status')).toHaveText('Сохранено');
  await page.screenshot({ path: testInfo.outputPath(`editor-${width}.png`), fullPage: true });
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width, height: 900 }, isMobile: width === 375, hasTouch: width === 375 });
  const guest = await context.newPage(); guest.on('pageerror', error => errors.push(error.message));
  try { await guest.goto(share.url); await expect(guest.locator('#public-body')).toContainText('вместе'); expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await guest.screenshot({ path: testInfo.outputPath(`guest-${width}.png`), fullPage: true }); }
  finally { await context.close(); }
  expect(errors).toEqual([]);
});


async function editorContext(browser, share, accountSuffix = 'editor') {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, locale: 'ru-RU' });
  const page = await context.newPage();
  await page.goto(share.url);
  const account = { email: `${accountSuffix}-${Date.now()}-${Math.random().toString(16).slice(2)}@kizuna.test`, password: 'collaboration-password-2026' };
  const registered = await page.request.post('/api/auth/register', { data: account }); expect(registered.status()).toBe(201);
  const { user } = await registered.json();
  expect((await page.request.post(`/api/public/todos/${share.token}/join`, { data: { consent: true } })).status()).toBe(200);
  return { context, page, user, account };
}
async function waitForOutbox(page, userId, captureId, count) {
  await expect.poll(() => page.evaluate(async ({ userId, captureId }) => {
    const databases = await indexedDB.databases(); const named = databases.find(db => db.name.startsWith(`pagent-collaboration:${userId}:${captureId}:`) && db.name.endsWith(':outbox'));
    if (!named) return 0;
    return new Promise(resolve => { const open = indexedDB.open(named.name); open.onsuccess = () => { const db = open.result; const tx = db.transaction('pending'); const request = tx.objectStore('pending').count(); request.onsuccess = () => { resolve(request.result); db.close(); }; }; open.onerror = () => resolve(0); });
  }, { userId, captureId })).toBeGreaterThanOrEqual(count);
}

test('ordered offline operations survive closed page and merge after a fresh hello', async ({ page, request, browser }) => {
  const { entry, share } = await setup(request);
  const actor = await editorContext(browser, share);
  try {
    await open(page, entry.id); await open(actor.page, entry.id);
    await actor.context.setOffline(true);
    await append(actor.page, 'OFFLINE_ONE'); await append(actor.page, 'OFFLINE_TWO');
    await waitForOutbox(actor.page, actor.user.id, entry.id, 2);
    await actor.page.close();
    await append(page, 'REMOTE_DURING_RELOAD');
    await actor.context.setOffline(false);
    const recovered = await actor.context.newPage(); await open(recovered, entry.id);
    await expect(body(recovered)).toContainText('OFFLINE_ONE'); await expect(body(recovered)).toContainText('OFFLINE_TWO');
    await expect(body(recovered)).toContainText('REMOTE_DURING_RELOAD');
    await expect(body(page)).toContainText('OFFLINE_ONE'); await expect(body(page)).toContainText('OFFLINE_TWO');
  } finally { await actor.context.close(); }
});

test('another account cannot replay the previous account draft after cookie switch', async ({ request, browser }) => {
  const { entry, share } = await setup(request);
  const actor = await editorContext(browser, share, 'original');
  try {
    await open(actor.page, entry.id); await actor.context.setOffline(true); await append(actor.page, 'PRIVATE_DRAFT_ORIGINAL');
    await waitForOutbox(actor.page, actor.user.id, entry.id, 1); await actor.page.close(); await actor.context.setOffline(false);
    const replacement = await actor.context.newPage(); await replacement.goto(share.url);
    const registered = await replacement.request.post('/api/auth/register', { data: { email: `replacement-${Date.now()}@kizuna.test`, password: 'collaboration-password-2026' } }); expect(registered.status()).toBe(201);
    expect((await replacement.request.post(`/api/public/todos/${share.token}/join`, { data: { consent: true } })).status()).toBe(200);
    await open(replacement, entry.id); await expect(body(replacement)).not.toContainText('PRIVATE_DRAFT_ORIGINAL');
    // Exercise the transport fence directly using the stale actor captured by an old tab.
    await replacement.evaluate(async ({ captureId, userId, generation }) => {
      const { createCollaborativeEditor } = await import('/public/collaboration.bundle.js');
      const stale = createCollaborativeEditor({ captureId, userId, generation });
      const recovery = document.createElement('section'); recovery.id = 'stale-account-recovery'; recovery.append(stale.bodyElement); document.body.append(recovery);
    }, { captureId: entry.id, userId: actor.user.id, generation: (await (await replacement.request.get(`/api/captures/${entry.id}/collaboration`)).json()).generation });
    await expect(replacement.locator('#stale-account-recovery .collaborative-status')).toContainText('Аккаунт изменился');
    await expect.poll(async () => (await (await request.get(`/api/captures/${entry.id}`)).json()).entry.note.body).not.toContain('PRIVATE_DRAFT_ORIGINAL');
  } finally { await actor.context.close(); }
});

test('tab-local return preserves separate share tokens through password and TOTP login', async ({ request, browser }) => {
  const first = await setup(request), second = await setup(request);
  const actor = await editorContext(browser, first.share, 'mfa');
  try {
    const setupMfa = await (await actor.page.request.post('/api/auth/totp/setup')).json();
    expect((await actor.page.request.post('/api/auth/totp/enable', { data: { code: totpCode(setupMfa.secret) } })).status()).toBe(200);
    await actor.page.request.post('/api/auth/logout');
    const tabTwo = await actor.context.newPage();
    await actor.page.goto(first.share.url); await tabTwo.goto(second.share.url);
    for (const tab of [actor.page, tabTwo]) {
      await tab.getByRole('button', { name: 'Работать вместе', exact: true }).click();
      await expect(tab).toHaveURL(/\/login\?join$/);
    }
    const tokens = await Promise.all([actor.page, tabTwo].map(tab => tab.evaluate(() => JSON.parse(sessionStorage.getItem('pagent.public-todo-intent')).token)));
    expect(tokens).toEqual([first.share.token, second.share.token]);
    for (const [tab, captureId] of [[actor.page, first.entry.id], [tabTwo, second.entry.id]]) {
      await tab.locator('#auth-switch').click(); // Public entry starts signup; choose existing-account login.
      await tab.locator('#auth-email').fill(actor.account.email); await tab.locator('#auth-password').fill(actor.account.password);
      await tab.locator('#auth-submit').click(); await expect(tab.locator('#auth-code')).toBeVisible();
      await tab.locator('#auth-code').fill(totpCode(setupMfa.secret)); await tab.locator('#auth-submit').click();
      await expect(body(tab)).toBeVisible();
      expect((await (await tab.request.get(`/api/captures/${captureId}`)).json()).entry.canEdit).toBe(true);
    }
  } finally { await actor.context.close(); }
});

test('revoked invitation during signup leaves an active account without joining', async ({ request, browser }) => {
  const { entry, circle, share } = await setup(request);
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } }); const page = await context.newPage();
  try {
    await page.goto(share.url); await page.getByRole('button', { name: 'Работать вместе', exact: true }).click();
    expect((await request.delete(`/api/captures/${entry.id}/public-shares/${share.id}`)).status()).toBe(200);
    await page.locator('#auth-email').fill(`revoked-signup-${Date.now()}@kizuna.test`); await page.locator('#auth-password').fill('collaboration-password-2026'); await page.locator('#auth-password-repeat').fill('collaboration-password-2026'); await page.locator('#auth-submit').click();
    await expect(page.locator('#public-status')).toContainText('Ссылка недоступна');
    const state = await (await page.request.get('/api/auth/state')).json(); expect(state.authenticated).toBe(true); expect(state.user.status).toBe('active');
    const circles = await (await page.request.get('/api/circles')).json(); expect(circles.circles.some(item => item.id === circle.id)).toBe(false);
  } finally { await context.close(); }
});

test('closing before acknowledgement drains the session without reopening the editor', async ({ page, request, browser }) => {
  const { entry, share } = await setup(request); const actor = await editorContext(browser, share);
  try {
    await open(page, entry.id); await open(actor.page, entry.id);
    await page.evaluate(() => {
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(...args) { const result = original.apply(this, args); const until = performance.now() + 50; while (performance.now() < until) {} return result; };
    });
    await append(page, 'CLOSED_BEFORE_ACK');
    const close = page.locator('#review-dialog [aria-label="Закрыть"]');
    if (await close.count()) await close.first().click(); else await page.keyboard.press('Escape');
    await expect(body(actor.page)).toContainText('CLOSED_BEFORE_ACK');
    await expect.poll(async () => (await (await request.get(`/api/captures/${entry.id}`)).json()).entry.note.body).toContain('CLOSED_BEFORE_ACK');
  } finally { await actor.context.close(); }
});

test('a true mobile browser edits the shared todo without overflow', async ({ request, browser }, testInfo) => {
  const { entry, share } = await setup(request);
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'ru-RU' }); const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(share.url); await page.request.post('/api/auth/register', { data: { email: `mobile-${Date.now()}@kizuna.test`, password: 'collaboration-password-2026' } }); await page.request.post(`/api/public/todos/${share.token}/join`, { data: { consent: true } });
    await open(page, entry.id); await append(page, 'Мобильная правка'); await expect(page.locator('.collaborative-status')).toHaveText('Сохранено');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('mobile-emulated-editor-375.png'), fullPage: true });
  } finally { await context.close(); }
});


test('legacy notes keep revision across successive saves and preserve a conflicting draft', async ({ page, request }) => {
  const { entry } = await setup(request);
  expect((await request.post(`/api/captures/${entry.id}/corrections`, { data: { patch: { primaryType: 'note' } } })).status()).toBe(200);
  await page.goto(`/#notes?page=${entry.id}`);
  const field = page.locator('.notes-markdown'); await expect(field).toBeVisible();
  for (const text of ['NOTES_FIRST', ' NOTES_SECOND']) {
    await field.click(); await page.keyboard.press('ControlOrMeta+End');
    const saved = page.waitForResponse(response => response.url().endsWith(`/api/captures/${entry.id}/notes`) && response.request().method() === 'POST');
    await page.keyboard.insertText(text); expect((await saved).status()).toBe(200);
  }
  let unblock; const blocked = new Promise(resolve => { unblock = resolve; }); let attempted;
  const intercepted = new Promise(resolve => { attempted = resolve; });
  await page.route(`**/api/captures/${entry.id}/notes`, async route => { attempted(); await blocked; await route.continue(); });
  await field.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' LOCAL_CONFLICT_DRAFT');
  await intercepted;
  const canonical = (await (await request.get(`/api/captures/${entry.id}/collaboration`)).json());
  expect((await request.post(`/api/captures/${entry.id}/notes`, { data: { body: 'REMOTE_VERSION', expectedRevision: canonical.revision } })).status()).toBe(200);
  const failed = page.waitForResponse(response => response.url().endsWith(`/api/captures/${entry.id}/notes`) && response.request().method() === 'POST');
  unblock(); expect((await failed).status()).toBe(409);
  await expect(field).toContainText('LOCAL_CONFLICT_DRAFT');
  await page.locator('.notes-side-add').click();
  await expect(field).toContainText('LOCAL_CONFLICT_DRAFT');
  await expect(page).toHaveURL(new RegExp(`page=${entry.id}`));
});


test('publishing waits for the personal body draft before initializing the shared document', async ({ page, request }) => {
  const { entry } = await (await request.post('/api/captures', { data: { raw: 'Черновик перед публикацией', provider: 'fallback' } })).json();
  const { circle } = await (await request.post('/api/circles', { data: { name: `Публикация ${Date.now()}` } })).json();
  await page.goto(`/#today?open=${entry.id}`); const field = page.locator('#card-body-editor'); await expect(field).toBeVisible();
  let unblock; const blocked = new Promise(resolve => { unblock = resolve; }); let attempted;
  const intercepted = new Promise(resolve => { attempted = resolve; });
  await page.route(`**/api/captures/${entry.id}/notes`, async route => { attempted(); await blocked; await route.continue(); });
  await field.click(); await page.keyboard.insertText('DRAFT_BEFORE_PUBLICATION');
  await page.locator('.todo-share-button').click(); await intercepted;
  await expect(page.locator('.todo-share-dialog')).toHaveCount(0);
  unblock(); await expect(page.locator('.todo-share-dialog')).toBeVisible();
  await page.locator('.todo-share-dialog select').selectOption(circle.id);
  await page.getByRole('button', { name: 'Создать публичную ссылку', exact: true }).click();
  await expect(body(page)).toContainText('DRAFT_BEFORE_PUBLICATION');
  expect((await (await request.get(`/api/captures/${entry.id}`)).json()).entry.note.body).toContain('DRAFT_BEFORE_PUBLICATION');
});
