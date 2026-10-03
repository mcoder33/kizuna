import { test, expect } from '@playwright/test';
import { E2E_PORT } from './fixtures/e2e-env.js';

test('ИИ и расходы находятся только в администрировании, выбор модели действует для обычного пользователя', async ({ page, browser, playwright, request }, testInfo) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#settings');
  await expect(page.locator('#setting-name')).toBeVisible();
  await expect(page.locator('#ai-provider')).toBeHidden();
  await expect(page.locator('#usage-table')).toBeHidden();
  await page.goto('/#reports');
  await expect(page.locator('[data-reports-tab]')).toHaveText(['День', 'Записи']);
  await page.goto('/#admin/service/ai');
  await expect(page.locator('#ai-provider')).toBeVisible();
  await page.locator('#ai-provider').selectOption('openrouter');
  await expect(page.locator('#ai-model')).toBeVisible();
  await page.locator('#ai-model').selectOption('fake/deep');
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).settings.openrouterModel).toBe('fake/deep');
  await page.reload();
  await expect(page.locator('#ai-model')).toHaveValue('fake/deep');
  await page.screenshot({ path: testInfo.outputPath('ai-desktop.png'), fullPage: true });
  const api = await playwright.request.newContext({ baseURL: `http://127.0.0.1:${E2E_PORT}` });
  let context;
  try {
    const email = `ai-user-${Date.now()}@kizuna.test`, password = 'ai-admin-e2e-password';
    const registered = await api.post('/api/auth/register', { data: { email, password, locale: 'ru' } });
    expect(registered.status()).toBe(201);
    const { user } = await registered.json();
    expect(user.status).toBe('active');
    const state = await (await api.get('/api/auth/state')).json();
    expect(state.authenticated).toBe(true); expect(state.user.id).toBe(user.id);
    const created = await api.post('/api/captures', { data: { raw: 'Проверить настройку общей модели' } });
    expect(created.status()).toBe(201);
    expect((await created.json()).provenance.model).toBe('fake/deep');
    expect((await api.get('/api/admin/usage')).status()).toBe(403);
    context = await browser.newContext({ storageState: await api.storageState(), viewport: { width: 390, height: 844 }, locale: 'ru-RU' });
    const personal = await context.newPage(); personal.on('pageerror', error => errors.push(error.message));
    const calls = []; personal.on('request', req => calls.push(new URL(req.url()).pathname));
    await personal.goto(`http://127.0.0.1:${E2E_PORT}/#settings`);
    await expect(personal.locator('#setting-name')).toBeVisible();
    await expect(personal.locator('#ai-provider')).toBeHidden();
    await expect(personal.locator('#usage-table')).toBeHidden();
    await expect(personal.locator('#memory-new')).toBeVisible();
    await expect(personal.locator('#account-admin-link')).toBeHidden();
    await personal.screenshot({ path: testInfo.outputPath('personal-mobile.png'), fullPage: true });
    expect(calls.filter(url => ['/api/status', '/api/usage', '/api/admin/usage', '/api/admin/ai/status'].includes(url))).toEqual([]);
    await page.goto('/#admin/service/usage');
    await expect(page.locator('#usage-table')).toContainText('Всего');
    await expect(page.locator('#admin-reports-service')).toContainText('Расходы на модели');
    await page.locator('#admin-usage-period').selectOption('all');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('usage-mobile.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await request.put('/api/settings', { data: { openrouterModel: 'fake/fast' } });
    await context?.close(); await api.dispose();
  }
});
