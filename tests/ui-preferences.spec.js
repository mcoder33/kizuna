import { test, expect } from '@playwright/test';
import { UI_PREFERENCE_KEYS } from '../public/ui-preference-schema.js';

async function resetPreferences(request) {
  const { userId } = await (await request.get('/api/ui-preferences')).json();
  expect((await request.patch('/api/ui-preferences', { data: { userId, changes: Object.fromEntries(UI_PREFERENCE_KEYS.map(key => [key, null])) } })).ok()).toBe(true);
  return userId;
}
async function ready(page, route = '/') {
  await page.goto(route);
  await expect(page.locator('#account-summary')).toHaveAttribute('title', /@/);
  await expect(page.locator('html')).toHaveAttribute('data-account-id', /.+/);
  // Wait for the initial SSE-ready refresh and bootstrap, not just static HTML.
  await page.waitForTimeout(700);
}
async function drag(page, selector, dx, dy) {
  const box = await page.locator(selector).boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 5 }); await page.mouse.up();
}
const cssValue = (page, selector, name) => page.locator(selector).evaluate((element, key) => element.style.getPropertyValue(key), name);
const values = async request => (await (await request.get('/api/ui-preferences')).json()).values;

test('existing anonymous sizes migrate once and never leak into a later account', async ({ browser, request, playwright, baseURL }) => {
  // Other scenarios explicitly reset the shared account's display keys to null.
  // Migration must respect those resets; use an account whose sizes are absent.
  const account = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const password = 'preference-sync-password';
  const firstEmail = `legacy-view-${Date.now()}@kizuna.test`;
  const registration = await account.post('/api/auth/register', { data: { email: firstEmail, password } });
  expect(registration.status()).toBe(201);
  const { user } = await registration.json();
  expect(user.status).toBe('active');
  const firstSession = await (await account.get('/api/auth/state')).json();
  expect(firstSession.authenticated).toBe(true); expect(firstSession.user.id).toBe(user.id);
  expect((await account.patch('/api/ui-preferences', { data: { userId: user.id, changes: { 'kizuna-board-filter': '[]' } } })).ok()).toBe(true);
  const savedState = await account.storageState();
  // Reuse only the account's cookies so this browser has no legacy owner.
  const storageState = { cookies: savedState.cookies, origins: [] };
  const context = await browser.newContext({ storageState, viewport: { width: 1440, height: 900 } });
  const otherContext = await browser.newContext({ storageState, viewport: { width: 1440, height: 900 } });
  const page = await otherContext.newPage();
  const legacy = await context.newPage();
  try {
    await legacy.addInitScript(() => {
      localStorage.setItem('kizuna-capture-width', '960');
      localStorage.setItem('kizuna-card-mode', 'side');
      localStorage.setItem('kizuna-board-filter', '[{"field":"who","op":"=","values":["Private name"]}]');
    });
    await ready(legacy);
    expect(await legacy.evaluate(() => localStorage.getItem('kizuna-ui-preferences-legacy-owner'))).toBe(user.id);
    await expect.poll(async () => (await values(account))['kizuna-capture-width']).toBe('960');
    expect((await values(account))['kizuna-card-mode']).toBe('side');
    expect((await values(account))['kizuna-board-filter']).toBe('[]');
    expect(await cssValue(legacy, '#today', '--capture-width')).toBe('960px');
    await ready(page);
    expect(await cssValue(page, '#today', '--capture-width')).toBe('960px');
    await expect(page.locator('#review-dialog')).toHaveAttribute('data-mode', 'side');
    const email = `view-sync-${Date.now()}@kizuna.test`;
    const response = await account.post('/api/auth/register', { data: { email, password } });
    expect(response.status()).toBe(201); const registered = await response.json();
    expect(registered.user.status).toBe('active');
    const secondSession = await (await account.get('/api/auth/state')).json();
    expect(secondSession.authenticated).toBe(true); expect(secondSession.user.id).toBe(registered.user.id);
    expect((await context.request.post('/api/auth/login', { data: { email, password } })).ok()).toBe(true);
    // The old document must not upload its queue under the new session cookie.
    await legacy.evaluate(async () => {
      const { uiStorage, flushUiPreferences } = await import('/public/ui-preferences.js');
      uiStorage.setItem('kizuna-capture-width', '1000');
      await flushUiPreferences();
    });
    expect(await values(context.request)).toEqual({});
    await ready(legacy);
    expect(await cssValue(legacy, '#today', '--capture-width')).toBe('');
    await expect(legacy.locator('#review-dialog')).toHaveAttribute('data-mode', 'center');
  } finally {
    await context.close();
    await otherContext.close();
    await account.dispose();
  }
});

test('two independent browsers sync dimensions and modes live, preserve drafts and restore on a fresh device', async ({ page, browser, request }) => {
  await resetPreferences(request);
  const second = await browser.newContext({ storageState: { cookies: (await page.context().cookies()), origins: [] }, viewport: { width: 1440, height: 900 } });
  const other = await second.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message)); other.on('pageerror', error => errors.push(error.message));
  await ready(page); await ready(other);
  const loadedAt = await other.evaluate(() => performance.timeOrigin);
  await other.locator('#capture-input').fill('Черновик не должен исчезнуть');
  await drag(page, '#capture-form .capture-resize[data-dir="e"]', 65, 0);
  const width = await cssValue(page, '#today', '--capture-width');
  await expect.poll(() => cssValue(other, '#today', '--capture-width')).toBe(width);
  await expect(other.locator('#capture-input')).toHaveText('Черновик не должен исчезнуть');
  expect(await other.evaluate(() => performance.timeOrigin)).toBe(loadedAt);
  await page.goto('/#board'); await expect(page.locator('#board')).toBeVisible();
  await page.locator('#board-view [data-view="list"]').click();
  await expect.poll(async () => (await values(request))['kizuna-board-view']).toBe('list');
  await other.locator('#capture-input').blur();
  await other.evaluate(() => { location.hash = 'board'; });
  await expect(other.locator('#board-view [data-view="list"]')).toHaveAttribute('aria-pressed', 'true');
  await page.goto('/#calendar');
  await page.getByRole('button', { name: /^Месяц/ }).click();
  await expect.poll(async () => (await values(request))['kizuna-calendar-mode']).toBe('month');
  await other.goto('/#calendar');
  await expect(other.locator('.cal-month')).toBeVisible();
  // A third context has only the session cookie, no local preference cache.
  const fresh = await browser.newContext({ storageState: { cookies: await page.context().cookies(), origins: [] }, viewport: { width: 1440, height: 900 } });
  const reopened = await fresh.newPage(); await ready(reopened);
  expect(await cssValue(reopened, '#today', '--capture-width')).toBe(width);
  await reopened.setViewportSize({ width: 390, height: 844 });
  expect(await reopened.locator('#capture-form').evaluate(element => element.getBoundingClientRect().right <= innerWidth)).toBe(true);
  await reopened.setViewportSize({ width: 1440, height: 900 });
  // setViewportSize resolves before the browser delivers its resize event.
  await expect.poll(() => cssValue(reopened, '#today', '--capture-width')).toBe(width);
  await reopened.screenshot({ path: '/tmp/pagent-view-sync-smoke.png', fullPage: true });
  expect(errors).toEqual([]);
  await fresh.close(); await second.close();
});

test('concurrent distinct changes and offline edits survive retry without overwriting another device', async ({ page, browser, request }) => {
  await resetPreferences(request);
  const second = await browser.newContext({ storageState: { cookies: await page.context().cookies(), origins: [] }, viewport: { width: 1440, height: 900 } });
  const other = await second.newPage();
  await ready(page, '/#board'); await ready(other);
  await Promise.all([
    page.locator('#board-view [data-view="list"]').click(),
    drag(other, '#capture-form .capture-resize[data-dir="s"]', 0, 45),
  ]);
  const height = await cssValue(other, '#capture-form', '--capture-height');
  await expect.poll(async () => (await values(request))['kizuna-board-view']).toBe('list');
  await expect.poll(async () => (await values(request))['kizuna-capture-height']).toBe(height.replace('px', ''));
  await other.context().setOffline(true);
  await drag(other, '#capture-form .capture-resize[data-dir="e"]', 55, 0);
  const width = await cssValue(other, '#today', '--capture-width');
  await page.locator('#board-view [data-view="board"]').click();
  await expect.poll(async () => (await values(request))['kizuna-board-view']).toBe('board');
  await other.context().setOffline(false);
  await expect.poll(async () => (await values(request))['kizuna-capture-width']).toBe(width.replace('px', ''));
  expect((await values(request))['kizuna-board-view']).toBe('board');
  // Reset is also synchronized, including devices with an older saved value.
  await other.locator('#capture-form .capture-resize[data-dir="e"]').dblclick();
  await expect.poll(async () => (await values(request))['kizuna-capture-width']).toBeNull();
  await page.goto('/');
  expect(await cssValue(page, '#today', '--capture-width')).toBe('');
  await second.close();
});

test('card mode and size sync into an open editor without losing its text', async ({ page, browser, request }) => {
  await resetPreferences(request);
  const made = await (await request.post('/api/captures', { data: { raw: 'Проверить размеры карточки', primaryType: 'todo' } })).json();
  const context = await browser.newContext({ storageState: { cookies: await page.context().cookies(), origins: [] }, viewport: { width: 1440, height: 900 } });
  const other = await context.newPage();
  await ready(page, `/#today?open=${made.entry.id}`); await ready(other, `/#today?open=${made.entry.id}`);
  await other.locator('.card-markdown').click();
  await other.locator('#card-body-editor').fill('Текст в открытой карточке');
  const loadedAt = await other.evaluate(() => performance.timeOrigin);
  await page.locator('#review-mode-toggle').click();
  await page.locator('#review-mode-menu [data-mode="side"]').click();
  await expect(other.locator('#review-dialog')).toHaveAttribute('data-mode', 'side');
  await expect(other.locator('#card-body-editor')).toHaveText('Текст в открытой карточке');
  await drag(page, '#review-dialog .card-resize[data-dir="w"]', -75, 0);
  const width = await cssValue(page, '#review-dialog', '--card-sw');
  await expect.poll(() => cssValue(other, '#review-dialog', '--card-sw')).toBe(width);
  expect(await other.evaluate(() => performance.timeOrigin)).toBe(loadedAt);
  await expect(other.locator('#card-body-editor')).toHaveText('Текст в открытой карточке');
  await page.locator('#review-dialog .card-resize[data-dir="w"]').dblclick();
  await expect.poll(() => cssValue(other, '#review-dialog', '--card-sw')).toBe('');
  await context.close();
});

test('two offline tabs keep both queued choices after the entire browser closes', async ({ page, browser, request }) => {
  await resetPreferences(request);
  const context = await browser.newContext({ storageState: { cookies: await page.context().cookies(), origins: [] } });
  const a = await context.newPage(), b = await context.newPage();
  await ready(a); await ready(b);
  await context.setOffline(true);
  await a.evaluate(() => window.pagentPreferenceStorage.setItem('kizuna-capture-width', '910'));
  await b.evaluate(() => window.pagentPreferenceStorage.setItem('kizuna-calendar-mode', 'month'));
  const state = await context.storageState();
  await context.close();
  const reopened = await browser.newContext({ storageState: state });
  await ready(await reopened.newPage());
  await expect.poll(async () => (await values(request))['kizuna-capture-width']).toBe('910');
  await expect.poll(async () => (await values(request))['kizuna-calendar-mode']).toBe('month');
  await reopened.close();
});

test('a delayed PATCH acknowledgement reveals a newer SSE preference immediately', async ({ page, browser, request }) => {
  await resetPreferences(request);
  const context = await browser.newContext({ storageState: { cookies: await page.context().cookies(), origins: [] } });
  const other = await context.newPage(); await ready(page); await ready(other);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let sent;
  const received = new Promise(resolve => { sent = resolve; });
  await page.route('**/api/ui-preferences', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const response = await route.fetch(); sent(); await blocked;
    await route.fulfill({ response });
  });
  await page.evaluate(() => window.pagentPreferenceStorage.setItem('kizuna-card-mode', 'side'));
  await received;
  await other.evaluate(() => window.pagentPreferenceStorage.setItem('kizuna-card-mode', 'full'));
  await expect.poll(async () => (await values(request))['kizuna-card-mode']).toBe('full');
  // Give the newer SSE time to arrive while the older pending key masks it.
  await page.waitForTimeout(300); release();
  await expect(page.locator('#review-dialog')).toHaveAttribute('data-mode', 'full', { timeout: 3000 });
  await context.close();
});
