// Где живёт прогон e2e: порт приложения, порт заглушки OpenRouter и файл базы.
// Умолчания прежние — 3001, 3099 и /tmp/pagent-e2e.sqlite. Чтобы несколько
// прогонов шли одновременно (из разных worktree, в двух терминалах), каждому
// задают свои значения окружением:
//   E2E_PORT=3021 E2E_FAKE_PORT=3119 PAGENT_E2E_DB=/tmp/pagent-e2e-x.sqlite npx playwright test
// Читают их и конфиг Playwright, и сами проверки: Telegram ходит в заглушку,
// календарь кладёт строки прямо в базу прогона.
export const E2E_PORT = Number(process.env.E2E_PORT || 3001);
export const E2E_FAKE_PORT = Number(process.env.E2E_FAKE_PORT || 3099);
export const E2E_DB = process.env.PAGENT_E2E_DB || '/tmp/pagent-e2e.sqlite';
