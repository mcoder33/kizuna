import { test, expect } from '@playwright/test';
import { registerGuest } from './fixtures/e2e-account.js';
import { totpCode } from '../server/auth.js';

test('MFA reauthentication errors retain the dialog and allow a successful retry', async ({ browser, request }) => {
  const email = `security-mfa-${Date.now()}@kizuna.test`;
  const password = 'security-password-2026';
  const registration = await registerGuest(request, { email, password });
  expect(registration.status).toBe(201);
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, locale: 'ru-RU' });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    expect((await page.request.post('/api/auth/login', { data: { email, password } })).status()).toBe(200);
    const setup = await (await page.request.post('/api/auth/totp/setup')).json();
    expect((await page.request.post('/api/auth/totp/enable', { data: { code: totpCode(setup.secret) } })).status()).toBe(200);
    await page.goto('/#settings');
    await expect(page.locator('#totp-disable')).toBeVisible();
    await expect(page.locator('#totp-state')).toContainText('Включён');
    await page.locator('#password-change').click();
    await page.locator('#password-current').fill(password);
    await page.locator('#password-new').fill('security-new-password-2026');
    await page.locator('#password-repeat').fill('security-new-password-2026');
    for (const [code, expected] of [['', 'totp_required'], ['bad-code', 'invalid_totp']]) {
      await page.locator('#password-factor').fill(code);
      const response = page.waitForResponse(r => r.url().endsWith('/api/auth/password'));
      await page.locator('#password-submit').click();
      const rejected = await response; expect(rejected.status()).toBe(401);
      expect((await rejected.json()).error.code).toBe(expected);
      await expect(page.locator('#password-dialog')).toBeVisible();
      await expect(page).toHaveURL(/#settings$/);
      await expect(page.locator('#password-current')).toHaveValue(password);
    }
    await page.locator('#password-factor').fill(totpCode(setup.secret));
    const success = page.waitForResponse(r => r.url().endsWith('/api/auth/password'));
    await page.locator('#password-submit').click(); expect((await success).status()).toBe(200);
    await expect(page.locator('#password-dialog')).toBeHidden();
    expect((await page.request.get('/api/auth/me')).status()).toBe(200);
    await page.locator('#totp-disable').click();
    await page.locator('#totp-disable-password').fill('security-new-password-2026');
    for (const [code, expected] of [['', 'totp_required'], ['bad-code', 'invalid_totp']]) {
      await page.locator('#totp-disable-code').fill(code);
      const response = page.waitForResponse(r => r.url().endsWith('/api/auth/totp/disable'));
      await page.locator('#totp-disable-submit').click();
      const rejected = await response; expect(rejected.status()).toBe(401);
      expect((await rejected.json()).error.code).toBe(expected);
      await expect(page.locator('#totp-disable-dialog')).toBeVisible();
      await expect(page).toHaveURL(/#settings$/);
      await expect(page.locator('#totp-disable-password')).toHaveValue('security-new-password-2026');
    }
    await page.locator('#totp-disable-code').fill(totpCode(setup.secret));
    const disabled = page.waitForResponse(r => r.url().endsWith('/api/auth/totp/disable'));
    await page.locator('#totp-disable-submit').click(); expect((await disabled).status()).toBe(200);
    await expect(page.locator('#totp-disable-dialog')).toBeHidden();
    await expect(page.locator('#totp-state')).toContainText('Выключен');
    // A real expired session still follows the existing login redirect.
    expect((await page.request.post('/api/auth/logout')).status()).toBe(200);
    await page.locator('#password-change').click();
    await page.locator('#password-current').fill('security-new-password-2026');
    await page.locator('#password-new').fill(password);
    await page.locator('#password-repeat').fill(password);
    await page.locator('#password-submit').click();
    await expect(page).toHaveURL(/\/login$/);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
