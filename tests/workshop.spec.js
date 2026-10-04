import { test, expect } from '@playwright/test';

// Run against the existing isolated fake-provider server, with the feature open.
test.skip(process.env.PAGENT_WORKSHOP_MODE !== 'all', 'PAGENT_WORKSHOP_MODE=all enables workshop browser checks');

async function account(browser, baseURL) {
  const context = await browser.newContext({ baseURL, locale: 'ru-RU', timezoneId: 'Europe/Samara', viewport: { width: 1440, height: 900 } });
  const response = await context.request.post('/api/auth/register', { data: { email: `workshop-${crypto.randomUUID()}@kizuna.test`, password: 'workshop-test-password' } });
  expect(response.status()).toBe(201);
  const { userId, capabilities } = await (await context.request.get('/api/ui-preferences')).json();
  expect(capabilities.workshopAppearance).toBe(true);
  const save = async changes => expect((await context.request.patch('/api/ui-preferences', { data: { userId, changes } })).ok()).toBe(true);
  expect((await context.request.put('/api/settings', { data: { locale: 'ru' } })).ok()).toBe(true);
  await save({ 'kizuna-room-season': 'autumn', 'kizuna-room-light': 'day' });
  return { context, save, userId, page: await context.newPage() };
}
async function ready(page, route = 'today') {
  await page.goto('/#' + route);
  await expect(page.locator('#account-summary')).toHaveAttribute('title', /@/);
  await expect(page.locator('#capture-input')).toBeEditable();
}
const root = page => page.locator('html');
const room = (page, season, light) => Promise.all([
  expect(root(page)).toHaveAttribute('data-room-season', season),
  expect(root(page)).toHaveAttribute('data-room-light', light),
]);
const geometry = page => page.locator('#capture-input').evaluate(el => {
  const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
  return { x: rect.x, width: rect.width, height: rect.height, padding: style.padding, radius: style.borderRadius };
});

test('classic loads no artwork; settings preserve capture geometry and separate theme from room light', async ({ browser, baseURL }) => {
  const { context, page } = await account(browser, baseURL);
  const images = [];
  page.on('request', request => { if (/\/public\/workshop\/.*\.webp/.test(request.url())) images.push(request.url()); });
  try {
    await ready(page);
    await expect(root(page)).toHaveAttribute('data-appearance', 'classic');
    const original = await geometry(page);
    expect(images).toEqual([]);
    await page.goto('/#settings');
    await expect(page.locator('#workshop-settings')).toBeHidden();
    await page.locator('#setting-appearance').selectOption('workshop');
    await room(page, 'autumn', 'day');
    await page.locator('#setting-theme').selectOption('dark');
    await expect(root(page)).toHaveAttribute('data-theme', 'dark');
    await room(page, 'autumn', 'day');
    await page.locator('#setting-room-light').selectOption('night');
    await room(page, 'autumn', 'night');
    await page.locator('#setting-theme').selectOption('light');
    await expect(root(page)).toHaveAttribute('data-theme', 'light');
    await room(page, 'autumn', 'night');
    await page.goto('/#today');
    await expect(page.locator('#today')).toBeVisible();
    await expect.poll(() => geometry(page)).toEqual(original);
    expect(images.some(url => url.includes('autumn-night-desktop'))).toBe(true);
    await page.goto('/#settings');
    await page.locator('#setting-appearance').selectOption('classic');
    await expect(page.locator('.workshop-backdrop')).toHaveCount(0);
    await expect(page.locator('#workshop-settings')).toBeHidden();
  } finally { await context.close(); }
});

test('settings sync between devices; automatic updates wait until a focused draft is safe', async ({ browser, baseURL }) => {
  const { context, page, save } = await account(browser, baseURL);
  await save({ 'kizuna-appearance': 'workshop' });
  const other = await browser.newContext({ baseURL, storageState: await context.storageState(), viewport: { width: 390, height: 844 } });
  const peer = await other.newPage();
  try {
    await ready(page, 'settings'); await ready(peer);
    await room(peer, 'autumn', 'day');
    await peer.locator('#capture-input').fill('Мой несохранённый черновик');
    await page.locator('#setting-room-season').selectOption('winter');
    await expect(peer.locator('#setting-room-season')).toHaveValue('winter');
    await room(peer, 'autumn', 'day');
    await expect(peer.locator('#capture-input')).toHaveText('Мой несохранённый черновик');
    await peer.locator('#tab-day').click();
    await room(peer, 'winter', 'day');
    expect((await (await context.request.get('/api/entries')).json()).entries).toHaveLength(0);
  } finally { await other.close(); await context.close(); }
});

test('Torii is dismissible and synchronized; an example only fills an empty draft', async ({ browser, baseURL }) => {
  const { context, page, save } = await account(browser, baseURL);
  await save({ 'kizuna-appearance': 'workshop' });
  try {
    await ready(page);
    const hint = page.locator('[data-torii-hint="today"]');
    await expect(hint).toBeVisible();
    await hint.getByRole('button', { name: 'Закрыть подсказку Тории' }).click();
    await expect(hint).toHaveCount(0);
    await expect.poll(async () => (await (await context.request.get('/api/ui-preferences')).json()).values['kizuna-torii-dismissed']).toBe('["today"]');
    await page.goto('/#settings');
    await page.locator('#torii-restore-hints').click();
    await page.goto('/#today');
    await expect(hint).toBeVisible();
    await hint.getByRole('button', { name: 'Подставить пример →' }).click();
    await expect(page.locator('#capture-input')).toHaveText('Завтра в 11 созвон с Аней по проекту');
    expect((await (await context.request.get('/api/entries')).json()).entries).toHaveLength(0);
    await page.goto('/#guide');
    await page.locator('[data-torii-hint="guide"]').getByRole('button', { name: 'Подставить пример →' }).click();
    await expect(page.locator('#capture-input')).toHaveText('Завтра в 11 созвон с Аней по проекту');
  } finally { await context.close(); }
});

test('failed artwork leaves a usable neutral interface and never erases the draft', async ({ browser, baseURL }) => {
  const { context, page, save } = await account(browser, baseURL);
  await save({ 'kizuna-appearance': 'workshop' });
  await page.route('**/public/workshop/*-desktop.webp', route => route.abort());
  try {
    await ready(page);
    await expect(root(page)).toHaveAttribute('data-room-fallback', 'true');
    await expect(root(page)).toHaveAttribute('data-room-error', 'true');
    await page.locator('#capture-input').fill('Черновик при недоступной комнате');
    await expect(page.locator('#capture-input')).toHaveText('Черновик при недоступной комнате');
    const paint = await page.locator('#todo').evaluate(el => ({ ink: getComputedStyle(el).color, canvas: getComputedStyle(document.querySelector('.workshop-backdrop')).backgroundColor }));
    expect(paint.ink).not.toBe(paint.canvas);
    await page.goto('/#board');
    await expect(page.locator('#board')).toBeVisible();
  } finally { await context.close(); }
});

test('all eight rooms decode on desktop and mobile with no horizontal overflow', async ({ browser, baseURL }) => {
  const { context, page, save } = await account(browser, baseURL);
  try {
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      for (const season of ['winter', 'spring', 'summer', 'autumn']) for (const light of ['day', 'night']) {
        await save({ 'kizuna-appearance': 'workshop', 'kizuna-room-season': season, 'kizuna-room-light': light });
        await ready(page); await room(page, season, light);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
        expect(await root(page).getAttribute('data-room-error')).toBeNull();
        expect(await page.locator('.workshop-scene.shown').getAttribute('style')).toContain(width === 375 ? 'mobile.webp' : 'desktop.webp');
      }
    }
  } finally { await context.close(); }
});

test('scene refresh waits through composition, HTML drag cancellation and an open card', async ({ browser, baseURL }) => {
  const { context, page, save } = await account(browser, baseURL);
  await save({ 'kizuna-appearance': 'workshop' });
  try {
    await ready(page); await room(page, 'autumn', 'day');
    await page.locator('#capture-input').dispatchEvent('compositionstart');
    await page.locator('#tab-day').click();
    await save({ 'kizuna-room-season': 'winter' });
    await expect(page.locator('#setting-room-season')).toHaveValue('winter');
    await room(page, 'autumn', 'day');
    await page.locator('#capture-input').dispatchEvent('compositionend');
    await room(page, 'winter', 'day');
    await page.locator('#todo').dispatchEvent('dragstart');
    await page.locator('#todo').dispatchEvent('pointercancel');
    await save({ 'kizuna-room-season': 'spring' });
    await expect(page.locator('#setting-room-season')).toHaveValue('spring');
    await room(page, 'winter', 'day');
    await page.locator('#todo').dispatchEvent('dragend');
    await room(page, 'spring', 'day');
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Samara' }).format(new Date());
    expect((await context.request.post('/api/captures', { data: { raw: 'Проверить макет мастерской', primaryType: 'todo', due: { date } } })).status()).toBe(201);
    if (!(await page.locator('#todo').isVisible())) await page.locator('#tab-day').click();
    await page.getByRole('button', { name: 'Проверить макет мастерской', exact: true }).click();
    await expect(page.locator('#review-dialog')).toBeVisible();
    await save({ 'kizuna-room-season': 'autumn' });
    await expect(page.locator('#setting-room-season')).toHaveValue('autumn');
    await room(page, 'spring', 'day');
    await page.keyboard.press('Escape');
    await expect(page.locator('#review-dialog')).toBeHidden();
    await room(page, 'autumn', 'day');
  } finally { await context.close(); }
});

test('a revoked appearance write does not block other queued view preferences', async ({ browser, baseURL }) => {
  const { context, page } = await account(browser, baseURL);
  let denied = 0;
  try {
    await ready(page, 'settings');
    await page.route('**/api/ui-preferences', async route => {
      const request = route.request();
      if (request.method() === 'PATCH' && request.postDataJSON().changes['kizuna-appearance'] === 'workshop') {
        denied++;
        return route.fulfill({ status: 403, json: { error: { code: 'workshop_unavailable' } } });
      }
      if (request.method() === 'GET') {
        const response = await route.fetch(), record = await response.json();
        return route.fulfill({ response, json: { ...record, capabilities: { workshopAppearance: false } } });
      }
      return route.continue();
    });
    await page.locator('#setting-appearance').selectOption('workshop');
    await page.locator('#setting-room-season').selectOption('winter');
    await expect(root(page)).toHaveAttribute('data-workshop-enabled', 'false');
    await expect(root(page)).toHaveAttribute('data-appearance', 'classic');
    await expect(page.locator('.workshop-backdrop')).toHaveCount(0);
    await expect.poll(async () => (await (await context.request.get('/api/ui-preferences')).json()).values['kizuna-room-season'], { timeout: 10_000 }).toBe('winter');
    expect(denied).toBe(1);
    expect((await (await context.request.get('/api/ui-preferences')).json()).values['kizuna-appearance']).not.toBe('workshop');
  } finally { await context.close(); }
});
