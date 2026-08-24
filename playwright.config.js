import { defineConfig } from '@playwright/test';

// Разбор записей делает модель, поэтому e2e поднимает локальную заглушку
// OpenRouter: сеть не используется, а классификация детерминирована.
const fakeOpenRouterPort = 3099;

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.js',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:3001', viewport: { width: 1440, height: 900 } },
  webServer: [
    {
      command: `FAKE_OPENROUTER_PORT=${fakeOpenRouterPort} node tests/fixtures/openrouter-server.js`,
      url: `http://127.0.0.1:${fakeOpenRouterPort}/api/v1/models`,
      reuseExistingServer: false,
    },
    {
      command: [
        'chmod +x tests/fixtures/codex tests/fixtures/claude',
        'rm -f /tmp/pagent-e2e.sqlite /tmp/pagent-e2e.sqlite-wal /tmp/pagent-e2e.sqlite-shm',
        [
          'PORT=3001',
          'PAGENT_DB_PATH=/tmp/pagent-e2e.sqlite',
          'PAGENT_AI_PROVIDER=openrouter',
          'OPENROUTER_API_KEY=e2e-test-key',
          `PAGENT_OPENROUTER_BASE_URL=http://127.0.0.1:${fakeOpenRouterPort}/api/v1`,
          // Локальный .env не должен влиять на прогон: заглушка знает только
          // свои модели, а dotenv не перекрывает уже заданные переменные.
          'PAGENT_OPENROUTER_MODEL=fake/fast',
          'PAGENT_OPENROUTER_MODELS=fake/fast,fake/deep',
          'PAGENT_OPENROUTER_TIMEOUT_MS=30000',
          'OPENAI_API_KEY=',
          'PAGENT_TIMEZONE=Europe/Samara',
          'PAGENT_CODEX_PATH=$PWD/tests/fixtures/codex',
          'PAGENT_CLAUDE_PATH=$PWD/tests/fixtures/claude',
          'node server/index.js',
        ].join(' '),
      ].join(' && '),
      url: 'http://127.0.0.1:3001',
      reuseExistingServer: false,
    },
  ],
});
