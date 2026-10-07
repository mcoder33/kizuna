import { test, expect } from '@playwright/test';
import { openDatabase } from '../server/db.js';
import { E2E_DB } from './fixtures/e2e-env.js';
import { seedWorkshopCalendar } from './fixtures/workshop-calendar.js';

// Run against the existing isolated fake-provider server, with the feature open.
test.skip(process.env.PAGENT_WORKSHOP_MODE !== 'all', 'PAGENT_WORKSHOP_MODE=all enables workshop browser checks');

async function account(browser, baseURL) {
  const context = await browser.newContext({ baseURL, locale: 'ru-RU', timezoneId: 'Europe/Samara', viewport: { width: 1440, height: 900 } });
  const response = await context.request.post('/api/auth/register', { data: { email: `workshop-${crypto.randomUUID()}@kizuna.test`, password: 'workshop-test-password' } });
  expect(response.status()).toBe(201);
  const { userId, capabilities } = await (await context.request.get('/api/ui-preferences')).json();
  expect(capabilities.workshopAppearance).toBe(true);
  const save = async changes => expect((await context.request.patch('/api/ui-preferences', { data: { userId, changes } })).ok()).toBe(true);
  expect((await context.request.put('/api/settings', { data: { locale: 'ru', theme: 'light' } })).ok()).toBe(true);
  await save({ 'kizuna-appearance': 'classic', 'kizuna-room-season': 'autumn', 'kizuna-room-light': 'night' });
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

test('classic loads no artwork; settings preserve capture geometry and bind room light to interface theme', async ({ browser, baseURL }) => {
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
    await room(page, 'autumn', 'night');
    await expect(page.locator('#setting-room-light')).toHaveCount(0);
    await page.locator('#setting-theme').selectOption('light');
    await expect(root(page)).toHaveAttribute('data-theme', 'light');
    await room(page, 'autumn', 'day');
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

test('failed artwork stays readable and theme changes recover without losing the draft', async ({ browser, baseURL }) => {
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
    await page.unroute('**/public/workshop/*-desktop.webp');
    await page.goto('/#settings');
    await page.locator('#setting-theme').selectOption('dark');
    await room(page, 'autumn', 'night');
    await page.locator('#setting-theme').selectOption('light');
    await room(page, 'autumn', 'day');
    await page.route('**/public/workshop/*-night-desktop.webp', route => route.abort());
    await page.goto('/#settings');
    await page.locator('#setting-theme').selectOption('dark');
    await expect(root(page)).toHaveAttribute('data-room-error', 'true');
    await expect(root(page)).toHaveAttribute('data-room-fallback', 'true');
    await expect(page.locator('.workshop-scene')).toBeHidden();
    await page.locator('#setting-theme').selectOption('light');
    await room(page, 'autumn', 'day');
    await expect(root(page)).not.toHaveAttribute('data-room-fallback', 'true');
    await page.unroute('**/public/workshop/*-night-desktop.webp');
    await page.route('**/public/workshop/*-night-desktop.webp', async route => {
      await new Promise(resolve => setTimeout(resolve, 300));
      await route.continue();
    });
    await page.locator('#setting-theme').selectOption('dark');
    await page.locator('#setting-theme').selectOption('light');
    await page.waitForTimeout(500);
    await room(page, 'autumn', 'day');
    await expect(root(page)).not.toHaveAttribute('data-room-fallback', 'true');
  } finally { await context.close(); }
});

test('all eight rooms decode on desktop and mobile with no horizontal overflow', async ({ browser, baseURL }) => {
  const { context, page, save } = await account(browser, baseURL);
  try {
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      for (const season of ['winter', 'spring', 'summer', 'autumn']) for (const light of ['day', 'night']) {
        await save({ 'kizuna-appearance': 'workshop', 'kizuna-room-season': season });
        expect((await context.request.put('/api/settings', { data: { theme: light === 'day' ? 'light' : 'dark' } })).ok()).toBe(true);
        await ready(page); await room(page, season, light);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
        expect(await root(page).getAttribute('data-room-error')).toBeNull();
        expect(await page.locator('.workshop-scene.shown').getAttribute('style')).toContain(width === 375 ? 'mobile.webp' : 'desktop.webp');
      }
    }
  } finally { await context.close(); }
});

test('system theme follows device changes immediately without losing a focused draft', async ({ browser, baseURL }) => {
  const { context, page, save } = await account(browser, baseURL);
  await save({ 'kizuna-appearance': 'workshop' });
  expect((await context.request.put('/api/settings', { data: { theme: 'system' } })).ok()).toBe(true);
  try {
    await page.emulateMedia({ colorScheme: 'light' });
    await ready(page); await room(page, 'autumn', 'day');
    await page.locator('#capture-input').fill('Черновик при смене темы устройства');
    await page.emulateMedia({ colorScheme: 'dark' });
    await room(page, 'autumn', 'night');
    await expect(page.locator('#capture-input')).toBeFocused();
    await expect(page.locator('#capture-input')).toHaveText('Черновик при смене темы устройства');
    await page.emulateMedia({ colorScheme: 'light' });
    await room(page, 'autumn', 'day');
    await expect(root(page)).not.toHaveAttribute('data-room-fallback', 'true');
  } finally { await context.close(); }
});

test('meeting cards and real task metadata stay readable in light and dark rooms on phones and desktop', async ({ browser, baseURL }) => {
  const { context, page, save, userId } = await account(browser, baseURL);
  await save({ 'kizuna-appearance': 'workshop' });
  const date = (await (await context.request.get('/api/day')).json()).date;
  const db = openDatabase(E2E_DB);
  try { seedWorkshopCalendar(db, userId, date); } finally { db.close(); }
  const task = await context.request.post('/api/captures', { data: { raw: 'Проверить макет с Анной', primaryType: 'todo', priority: 'high', due: { date } } });
  expect(task.status()).toBe(201);
  const { entry } = await task.json();
  expect((await context.request.post(`/api/captures/${entry.id}/subtasks`, { data: { title: 'Посмотреть подписи' } })).status()).toBe(201);
  await page.clock.install({ time: new Date(`${date}T07:05:00.000Z`) });
  try {
    for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      expect((await context.request.put('/api/settings', { data: { theme } })).ok()).toBe(true);
      await ready(page); await room(page, 'autumn', theme === 'dark' ? 'night' : 'day');
      await expect(page.locator('#todo .day-event')).toHaveCount(3);
      await expect(page.locator('#todo .entry-title .importance-mark[data-importance="high"]')).toBeVisible();
      await expect(page.locator('#todo .sub-badge')).toBeVisible();
      const materials = await page.locator('#todo').evaluate(el => {
        const rgb = color => color.match(/[\d.]+/g).slice(0, 3).map(Number);
        const luminance = color => rgb(color).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
        return [...el.querySelectorAll('.day-event-title,.day-event-cal,.day-event-meta .tag')].map(node => {
          let parent = node, background;
          do { background = getComputedStyle(parent).backgroundColor; parent = parent.parentElement; } while (parent && (background === 'rgba(0, 0, 0, 0)' || background === 'transparent'));
          const ink = getComputedStyle(node).color, a = luminance(ink), b = luminance(background);
          return { text: node.textContent, ink, background, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
        });
      });
      expect(materials.length).toBeGreaterThanOrEqual(9);
      for (const item of materials) expect(item.contrast, `${theme}/${width}: ${JSON.stringify(item)}`).toBeGreaterThanOrEqual(4.5);
      expect(await page.locator('#todo .day-row.past .day-event').first().evaluate(el => getComputedStyle(el).opacity)).toBe('1');
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
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

test('workshop defaults on, classic choice survives reload, and revocation does not block other preferences', async ({ browser, baseURL }) => {
  const { context, page, save } = await account(browser, baseURL);
  await save({ 'kizuna-appearance': null });
  let denied = 0;
  try {
    await ready(page, 'settings');
    await expect(root(page)).toHaveAttribute('data-appearance', 'workshop');
    await room(page, 'autumn', 'day');
    await expect(page.locator('#setting-appearance')).toHaveValue('workshop');
    await page.locator('#setting-appearance').selectOption('classic');
    await expect.poll(async () => (await (await context.request.get('/api/ui-preferences')).json()).values['kizuna-appearance']).toBe('classic');
    await page.reload();
    await expect(root(page)).toHaveAttribute('data-appearance', 'classic');
    await expect(page.locator('.workshop-backdrop')).toHaveCount(0);
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
