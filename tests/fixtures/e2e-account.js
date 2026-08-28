// Одна учётная запись на весь прогон: её заводит e2e-auth.setup.js, ею же
// пользуются остальные проверки. Пароль здесь не секрет — база e2e живёт в
// /tmp и стирается перед каждым запуском.
export const E2E_EMAIL = 'e2e@kizuna.test';
export const E2E_PASSWORD = 'e2e-very-long-password';
export const E2E_STORAGE = 'tests/fixtures/e2e-state.json';
