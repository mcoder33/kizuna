import { test, expect, devices } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const checksumPath = fileURLToPath(new URL('../public/downloads/SHA256SUMS', import.meta.url));
const expectedSha256 = readFileSync(checksumPath, 'utf8').trim().split(/\s+/)[0];
const { defaultBrowserType: _iphoneBrowser, ...iphoneSE } = devices['iPhone SE'];
const { defaultBrowserType: _ipadBrowser, ...ipadMini } = devices['iPad Mini'];

async function assertNoHorizontalOverflow(page) {
  const sizes = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(sizes.content, `page overflow: ${JSON.stringify(sizes)}`).toBeLessThanOrEqual(sizes.viewport);
  return sizes;
}

test.describe('public Mac download resources', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('Mac DMG is publicly downloadable and matches its published SHA-256', async ({ page }) => {
    const response = await page.request.get('/public/downloads/Kizuna-mac.dmg');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toMatch(/application\/(x-apple-diskimage|octet-stream)/);
    expect(Number(response.headers()['content-length'])).toBeGreaterThan(100_000);
    expect(createHash('sha256').update(await response.body()).digest('hex')).toBe(expectedSha256);
  });

  test('public Mac download page loads without authentication and links to the DMG', async ({ page }) => {
    const failures = [];
    page.on('pageerror', error => failures.push(error.message));
    const response = await page.goto('/public/mac-download.html');
    expect(response.status()).toBe(200);
    await expect(page.locator('a.macapp-download')).toHaveAttribute('href', '/public/downloads/Kizuna-mac.dmg');
    await expect(page.locator('a.macapp-download')).toHaveAttribute('download');
    await expect(page.getByText(/macOS 13/i)).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('a.macapp-download').click(),
    ]);
    expect(download.suggestedFilename()).toBe('Kizuna-mac.dmg');
    expect(failures).toEqual([]);
    await assertNoHorizontalOverflow(page);
  });

  test('guest landing links to the public Mac download page', async ({ page }) => {
    const failures = [];
    page.on('pageerror', error => failures.push(error.message));
    await page.goto('/public/hello.html');
    const link = page.getByRole('link', { name: 'Скачать для Mac' });
    await expect(link).toHaveAttribute('href', '/public/mac-download.html');
    await link.click();
    await expect(page).toHaveURL(/\/public\/mac-download\.html$/);
    await expect(page.locator('a.macapp-download')).toBeVisible();
    expect(failures).toEqual([]);
  });
});

test.describe('mobile Mac download page', () => {
  test.use(iphoneSE);

  test('375px touch layout fits and shows installation steps', async ({ page }) => {
    const failures = [];
    page.on('pageerror', error => failures.push(error.message));
    await page.context().clearCookies();
    const response = await page.goto('/public/mac-download.html');
    expect(response.status()).toBe(200);
    await expect(page.locator('a.macapp-download')).toBeVisible();
    await expect(page.getByText(/Установить|Перетащите|Программы/)).toBeVisible();
    await assertNoHorizontalOverflow(page);
    mkdirSync('tmp/mac-download-check', { recursive: true });
    await page.screenshot({ path: 'tmp/mac-download-check/mobile-page.png', fullPage: true });
    expect(failures).toEqual([]);
  });

  test('375px profile modal fits, closes on Escape and restores focus', async ({ page }) => {
    await page.goto('/');
    await assertNoHorizontalOverflow(page);
    await page.locator('#account-summary').click();
    await page.locator('#account-mac-download').click();
    const dialog = page.locator('#mac-download-dialog');
    await expect(dialog).toBeVisible();
    await assertNoHorizontalOverflow(page);
    mkdirSync('tmp/mac-download-check', { recursive: true });
    await page.screenshot({ path: 'tmp/mac-download-check/mobile-modal.png', fullPage: true });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.locator('#account-summary')).toBeFocused();
  });
});

test.describe('Mac download modal on tablet', () => {
  test.use(ipadMini);

  test('768px touch layout opens from profile and Escape restores focus', async ({ page }) => {
    const failures = [];
    page.on('pageerror', error => failures.push(error.message));
    await page.goto('/');
    const before = await assertNoHorizontalOverflow(page);
    await page.locator('#account-summary').click();
    await page.locator('#account-mac-download').click();
    const dialog = page.locator('#mac-download-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('a.macapp-download')).toHaveAttribute('href', '/public/downloads/Kizuna-mac.dmg');
    const open = await assertNoHorizontalOverflow(page);
    expect(before.viewport).toBe(768);
    expect(open.viewport).toBe(768);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.locator('#account-summary')).toBeFocused();
    expect(failures).toEqual([]);
  });
});

test.describe('Mac download modal on desktop', () => {
  test('1440px layout opens and close button returns focus to profile', async ({ page }) => {
    const failures = [];
    page.on('pageerror', error => failures.push(error.message));
    await page.goto('/');
    const before = await assertNoHorizontalOverflow(page);
    await page.locator('#account-summary').click();
    await page.locator('#account-mac-download').click();
    const dialog = page.locator('#mac-download-dialog');
    await expect(dialog).toBeVisible();
    const open = await assertNoHorizontalOverflow(page);
    expect(before.viewport).toBe(1440);
    expect(open.viewport).toBe(1440);
    mkdirSync('tmp/mac-download-check', { recursive: true });
    await page.screenshot({ path: 'tmp/mac-download-check/desktop-modal.png', fullPage: true });
    await page.locator('#mac-download-close').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#account-summary')).toBeFocused();
    expect(failures).toEqual([]);
  });
});
