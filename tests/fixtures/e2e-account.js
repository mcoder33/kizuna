// Одна учётная запись на весь прогон: её заводит e2e-auth.setup.js, ею же
// пользуются остальные проверки. Пароль здесь не секрет — база e2e живёт в
// /tmp и стирается перед каждым запуском.
import { request as playwrightRequest } from '@playwright/test';
import { E2E_PORT } from './e2e-env.js';

export const E2E_EMAIL = 'e2e@kizuna.test';
export const E2E_PASSWORD = 'e2e-very-long-password';
// Кука сессии лежит в файле. Прогон с E2E_PORT получает свой файл по порту: два
// прогона из одного дерева иначе затирали бы сессии друг друга. Без переменной
// имя прежнее.
export const E2E_STORAGE = process.env.E2E_PORT
  ? `tests/fixtures/e2e-state-${E2E_PORT}.json`
  : 'tests/fixtures/e2e-state.json';

// Register in a separate guest context: signup now creates its own session.
// Keeping the caller's admin context intact lets fixtures manage other accounts.
export async function registerGuest(api, account) {
  const baseURL = new URL((await api.get('/api/auth/state')).url()).origin;
  const guest = await playwrightRequest.newContext({ baseURL });
  try {
    const response = await guest.post('/api/auth/register', { data: account });
    return { status: response.status(), body: await response.json() };
  } finally { await guest.dispose(); }
}
