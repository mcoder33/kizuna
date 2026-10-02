import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'pagent-i18n-e2e-'));
const port = Number(process.env.I18N_E2E_PORT || 3187);
const fixturePort = port + 1;
export default defineConfig({
  testDir: './tests',
  testMatch: 'i18n.spec.js',
  workers: 1,
  outputDir: join(directory, 'results'),
  use: { baseURL: `http://127.0.0.1:${port}`, locale: 'ru-RU', viewport: { width: 1440, height: 900 } },
  webServer: [
    { command: `FAKE_OPENROUTER_PORT=${fixturePort} node tests/fixtures/openrouter-server.js`, url: `http://127.0.0.1:${fixturePort}/api/v1/models`, reuseExistingServer: false },
    {
      command: `PORT=${port} PAGENT_DB_PATH=${join(directory, 'database.sqlite')} PAGENT_AI_PROVIDER=openrouter OPENROUTER_API_KEY=e2e-key PAGENT_OPENROUTER_BASE_URL=http://127.0.0.1:${fixturePort}/api/v1 PAGENT_OPENROUTER_MODEL=fake/fast PAGENT_OPENROUTER_MODELS=fake/fast,fake/deep PAGENT_OPENROUTER_TIMEOUT_MS=30000 OPENAI_API_KEY= GEMINI_API_KEY= GOOGLE_API_KEY= PAGENT_TELEGRAM_BOT_TOKEN= PAGENT_TIMEZONE=Europe/Samara node server/index.js`,
      url: `http://127.0.0.1:${port}/login`, reuseExistingServer: false,
    },
  ],
});
