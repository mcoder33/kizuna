import 'dotenv/config';
import assert from 'node:assert/strict';
import { createAiService } from './ai.js';

if (process.env.PAGENT_RUN_REAL_CLI_SMOKE !== '1') {
  console.error('Set PAGENT_RUN_REAL_CLI_SMOKE=1 to run a local CLI smoke test.');
  process.exit(1);
}
const provider = process.argv.slice(2).find(value => value.startsWith('--provider='))?.slice('--provider='.length) || process.argv[process.argv.indexOf('--provider') + 1];
if (!['codex-cli','claude-cli'].includes(provider)) throw new Error('Use --provider codex-cli or --provider claude-cli');
const result = await createAiService().classify('Заметка: проверить еженедельный обзор', provider);
assert.equal(result.requestedProvider, provider); assert.equal(result.usedProvider, provider, `Provider smoke failed with safe reason: ${result.fallbackReason || 'unknown'}`);
console.log(`Provider smoke passed: ${provider}`);
