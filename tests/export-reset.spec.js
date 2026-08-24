import { test, expect } from '@playwright/test';

test.beforeEach(async ({ request }) => { await request.post('/api/reset',{data:{confirmation:'СБРОСИТЬ КИЗУНА'}}); });

test('export and full-reset controls describe local personal data and keep exact confirmation', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { location.hash = '#settings'; });
  await expect(page.getByRole('link',{name:'Экспорт JSON'})).toHaveAttribute('href','/api/export');
  await page.getByRole('button',{name:'Очистить данные'}).click();
  const dialog=page.locator('#reset-dialog');
  await expect(dialog).toContainText('ежедневные отчёты, завершения и историю обработки');
  await dialog.getByRole('button',{name:'Удалить всё'}).click();
  await expect(page.locator('#toast')).toContainText('Введите точную фразу подтверждения');
  await dialog.locator('#reset-confirmation').fill('СБРОСИТЬ КИЗУНА');
  await dialog.getByRole('button',{name:'Удалить всё'}).click();
  await expect(page.locator('#toast')).toContainText('Локальный журнал очищен');
});
