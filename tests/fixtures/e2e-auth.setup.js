// Приложение закрыто учётной записью, поэтому браузерные проверки начинаются с
// входа. Он выполняется один раз перед всеми: заводится первый администратор
// (он же хозяин пустого журнала), а его кука сохраняется и раздаётся остальным
// проверкам — иначе каждая тратила бы время на форму входа.
import { test as setup, expect } from '@playwright/test';
import { E2E_EMAIL, E2E_PASSWORD, E2E_STORAGE } from './e2e-account.js';

setup('первый администратор заходит и сохраняет сессию', async ({ page }) => {
  await page.goto('/login');
  const state = await (await page.request.get('/api/auth/state')).json();

  if (state.needsBootstrap) {
    // Пустое приложение само открывает регистрацию: входить некому. Форма та
    // же, что и у человека, — сломайся она, это видно здесь, а не позже.
    await expect(page.getByRole('button', { name: 'Зарегистрироваться' })).toBeVisible();
    await page.getByLabel('Почта').fill(E2E_EMAIL);
    await page.getByLabel('Пароль', { exact: true }).fill(E2E_PASSWORD);
    await page.getByLabel('Пароль ещё раз').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
  } else {
    await page.getByLabel('Почта').fill(E2E_EMAIL);
    await page.getByLabel('Пароль', { exact: true }).fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Войти' }).click();
  }

  await expect(page).toHaveURL(/\/(#.*)?$/);
  await expect(page.locator('#account-summary')).toHaveAttribute('title', E2E_EMAIL);
  // Доска в первый заход фильтрует по «сегодня» (просроченное и сегодняшнее), а
  // проверкам, которым до этого дела нет, нужны все дела: с пустого фильтра они
  // и стартуют. Проверки самого фильтра сами убирают этот ключ и видят умолчание.
  const { userId } = await (await page.request.get('/api/ui-preferences')).json();
  expect((await page.request.patch('/api/ui-preferences', { data: { userId, changes: { 'kizuna-board-filter': '[]' } } })).ok()).toBe(true);
  await page.context().storageState({ path: E2E_STORAGE });
});
