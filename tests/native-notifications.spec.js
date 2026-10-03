import { test, expect } from '@playwright/test';

test('Mac notification controls use the native bridge without browser push support', async ({ page }) => {
  await page.addInitScript(() => {
    window.nativeActions = [];
    window.KizunaNotificationState = { authorized: false, enabled: true, denied: false };
    window.webkit = { messageHandlers: { kizunaNotifications: { postMessage(action) {
      window.nativeActions.push(action);
      if (action === 'enable') window.KizunaNotificationState = { authorized: true, enabled: true, denied: false };
      if (action === 'disable') window.KizunaNotificationState.enabled = false;
      window.dispatchEvent(new Event('pagent:notificationschange'));
    } } } };
  });
  await page.goto('/#settings');
  await expect(page.locator('#push-enable')).toBeVisible();
  await page.locator('#push-enable').click();
  await expect(page.locator('#push-test')).toBeVisible();
  await expect(page.locator('#push-state')).toContainText('включены');
  await page.locator('#push-test').click();
  await page.locator('#push-disable').click();
  await expect(page.locator('#push-test')).toBeHidden();
  await expect(page.locator('#push-enable')).toBeVisible();
  expect(await page.evaluate(() => window.nativeActions)).toEqual(['enable', 'test', 'disable']);
});

test('Mac denied permission explains how to enable it in system settings', async ({ page }) => {
  await page.addInitScript(() => {
    window.KizunaNotificationState = { authorized: false, enabled: true, denied: true };
    window.webkit = { messageHandlers: { kizunaNotifications: { postMessage() {} } } };
  });
  await page.goto('/#settings');
  await expect(page.locator('#push-state')).toContainText('Системных настройках');
  await expect(page.locator('#push-enable')).toBeVisible();
  await expect(page.locator('#push-test')).toBeHidden();
});
