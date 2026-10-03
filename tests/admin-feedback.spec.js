import { test, expect } from '@playwright/test';
import { E2E_PORT } from './fixtures/e2e-env.js';

async function userSession({ browser, playwright, request }, suffix, viewport = { width: 1280, height: 900 }) {
  const api = await playwright.request.newContext({ baseURL: `http://127.0.0.1:${E2E_PORT}` });
  const email = `feedback-${suffix}-${Date.now()}@kizuna.test`, password = 'feedback-e2e-password';
  const response = await api.post('/api/auth/register', { data: { email, password, locale: 'ru' } });
  expect(response.status()).toBe(201);
  const { user } = await response.json();
  expect((await request.post(`/api/admin/users/${user.id}/approve`, { data: {} })).status()).toBe(200);
  expect((await api.post('/api/auth/login', { data: { email, password } })).status()).toBe(200);
  const context = await browser.newContext({ storageState: await api.storageState(), viewport, locale: 'ru-RU', timezoneId: 'Europe/Samara' });
  const page = await context.newPage();
  return { page, context, api, user, email };
}

test('администрирование отделено от личных настроек и работает на телефоне', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#settings');
  await expect(page.locator('#setting-name')).toBeVisible();
  await expect(page.locator('#setting-openaiKey')).toBeHidden();
  await expect(page.locator('#setting-monthlyLimitUsd')).toBeHidden();
  await expect(page.locator('#memory-shared-row')).toHaveCount(0);
  await page.goto('/#admin/service/integrations');
  await expect(page.locator('#admin-title')).toHaveText('Настройки сервиса');
  await expect(page.locator('body > header')).toBeHidden();
  await expect(page.locator('#setting-telegramBotToken')).toBeVisible();
  await expect(page.locator('#calendar-username')).toBeHidden();
  await page.goto('/#admin/service/limits');
  await expect(page.locator('#setting-monthlyLimitUsd')).toBeVisible();
  await expect(page.locator('#setting-timeZone')).toBeVisible();
  await page.goto('/#admin/service/notifications');
  await expect(page.locator('#admin-delivery-settings')).toContainText('Получатели');
  await expect(page.locator('#admin-delivery-settings input[type=checkbox]')).toHaveCount(4);
  await page.screenshot({ path: 'tmp/admin-preview/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#admin-navigation')).toBeVisible();
  await page.locator('#admin-navigation summary').click();
  await page.locator('#admin-navigation a[data-admin-section=users]').click();
  await expect(page.locator('#admin-title')).toHaveText('Пользователи');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'tmp/admin-preview/mobile.png', fullPage: true });
  await page.locator('.admin-topbar a[href="#today"]').last().click();
  await expect(page.locator('body > header')).toBeVisible();
  expect(errors).toEqual([]);
});

test('пожелание проходит от пользователя до ответа администратора', async ({ page, browser, playwright, request }) => {
  const sender = await userSession({ browser, playwright, request }, 'reply');
  try {
    await sender.page.goto('/#feedback');
    await expect(sender.page.locator('#account-admin-link')).toBeHidden();
    const text = `Хочу сохранять удобные фильтры ${Date.now()}`;
    await sender.page.locator('#feedback-text').fill(text);
    await sender.page.locator('#feedback-contact').check();
    await sender.page.getByRole('button', { name: 'Отправить пожелание' }).click();
    await expect(sender.page.locator('#feedback-status')).toContainText('Пожелание отправлено');
    await expect(sender.page.locator('#my-feedback')).toContainText(text);
    await expect(sender.page.locator('#feedback-text')).toHaveValue('');
    const { feedback } = await (await sender.api.get('/api/feedback')).json();
    await page.goto(`/#admin/feedback?id=${feedback[0].id}`);
    const card = page.locator(`#admin-feedback-list [data-feedback-id="${feedback[0].id}"]`);
    await expect(card).toContainText(sender.email);
    await expect(card).toContainText('Можно уточнить детали');
    await card.getByLabel('Статус пожелания').selectOption('considering');
    await card.getByLabel('Ответ пользователю').fill('Спасибо, добавили в план.');
    await page.screenshot({ path: 'tmp/admin-preview/feedback-review.png', fullPage: true });
    await card.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(card).toContainText('Спасибо, добавили в план.');
    await sender.page.reload();
    await expect(sender.page.locator('#my-feedback')).toContainText('На рассмотрении');
    await expect(sender.page.locator('#my-feedback')).toContainText('Спасибо, добавили в план.');
    const notices = await (await sender.api.get('/api/notifications')).json();
    expect(notices.notifications.some(item => item.kind === 'feedback_reply' && item.data.url.endsWith(feedback[0].id))).toBe(true);
    expect((await sender.api.get('/api/admin/inbox')).status()).toBe(403);
    await sender.page.goto('/#admin/inbox');
    await expect(sender.page).toHaveURL(/#today$/);
  } finally { await sender.context.close(); await sender.api.dispose(); }
});

test('черновик переживает сбой сети, содержимое безопасно и повтор не создаёт дубль', async ({ browser, playwright, request }) => {
  const sender = await userSession({ browser, playwright, request }, 'draft', { width: 390, height: 844 });
  try {
    await sender.page.goto('/#feedback');
    const text = '<img src=x onerror=alert(1)> Сделайте приложение удобнее';
    await sender.page.locator('#feedback-text').fill(text);
    await sender.page.locator('#feedback-contact').check();
    await sender.page.route('**/api/feedback', route => route.request().method() === 'POST' ? route.abort('failed') : route.continue());
    await sender.page.getByRole('button', { name: 'Отправить пожелание' }).click();
    await expect(sender.page.getByRole('button', { name: 'Отправить пожелание' })).toBeEnabled();
    await expect(sender.page.locator('#feedback-text')).toHaveValue(text);
    await sender.page.reload();
    await expect(sender.page.locator('#feedback-text')).toHaveValue(text);
    await expect(sender.page.locator('#feedback-contact')).toBeChecked();
    await sender.page.unroute('**/api/feedback');
    await sender.page.evaluate(() => window.pagentTheme.set('dark'));
    await sender.page.getByRole('button', { name: 'Отправить пожелание' }).click();
    await expect(sender.page.locator('#my-feedback')).toContainText(text);
    await expect(sender.page.locator('#my-feedback img')).toHaveCount(0);
    expect((await (await sender.api.get('/api/feedback')).json()).feedback).toHaveLength(1);
    await expect.poll(() => sender.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await sender.page.screenshot({ path: 'tmp/admin-preview/feedback-dark-mobile.png', fullPage: true });
  } finally { await sender.context.close(); await sender.api.dispose(); }
});
