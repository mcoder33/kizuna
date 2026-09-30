// Одна учётная запись на весь прогон: её заводит e2e-auth.setup.js, ею же
// пользуются остальные проверки. Пароль здесь не секрет — база e2e живёт в
// /tmp и стирается перед каждым запуском.
import { E2E_PORT } from './e2e-env.js';

export const E2E_EMAIL = 'e2e@kizuna.test';
export const E2E_PASSWORD = 'e2e-very-long-password';
// Кука сессии лежит в файле. Прогон с E2E_PORT получает свой файл по порту: два
// прогона из одного дерева иначе затирали бы сессии друг друга. Без переменной
// имя прежнее.
export const E2E_STORAGE = process.env.E2E_PORT
  ? `tests/fixtures/e2e-state-${E2E_PORT}.json`
  : 'tests/fixtures/e2e-state.json';
