#!/usr/bin/env node
// Заглушка OpenRouter для e2e: отвечает по тому же контракту, что настоящий
// сервис, но разбор делает детерминированный фейковый «разум» из хелпера.
// Сеть при прогоне тестов не используется.
import http from 'node:http';
import { fakeModelCandidate } from '../helpers/fake-model.js';

const port = Number(process.env.FAKE_OPENROUTER_PORT || 3099);
const catalogue = {
  data: [
    { id: 'fake/fast', name: 'Fake Fast', supported_parameters: ['structured_outputs'], pricing: { prompt: '0.0000001', completion: '0.0000004' } },
    { id: 'fake/deep', name: 'Fake Deep', supported_parameters: ['structured_outputs'], pricing: { prompt: '0.000002', completion: '0.000008' } },
  ],
};

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => { body += chunk; if (body.length > 1_000_000) reject(new Error('too large')); });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function classificationFor(userMessage) {
  const raw = (userMessage.match(/<untrusted-capture>\n([\s\S]*?)\n<\/untrusted-capture>/) || [])[1] || '';
  return fakeModelCandidate(raw, new Date());
}

function answerFor(userMessage) {
  const sourceId = (userMessage.match(/\[([0-9a-f-]{36})\]/) || [])[1];
  return sourceId
    ? { answer: 'Контекст найден.', citationIds: [sourceId] }
    : { answer: 'В памяти пока нет подходящих записей.', citationIds: [] };
}

http.createServer(async (request, response) => {
  const send = (status, payload) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(payload));
  };
  try {
    if (request.url.endsWith('/models')) return send(200, catalogue);
    if (request.url.endsWith('/chat/completions')) {
      if (!String(request.headers.authorization || '').startsWith('Bearer ')) return send(401, { error: 'unauthorized' });
      const payload = JSON.parse(await readBody(request));
      const user = payload.messages.find(message => message.role === 'user')?.content || '';
      const known = catalogue.data.some(entry => entry.id === payload.model);
      if (!known) return send(400, { error: 'unknown model' });
      const content = user.includes('<untrusted-sources>') ? answerFor(user) : classificationFor(user);
      // Настоящий OpenRouter возвращает расход вместе с ответом — заглушка
      // тоже, иначе учёт токенов и денег нечем проверить.
      return send(200, {
        model: payload.model,
        choices: [{ message: { content: JSON.stringify(content) } }],
        usage: { prompt_tokens: 1200, completion_tokens: 180, total_tokens: 1380 },
      });
    }
    send(404, { error: 'not found' });
  } catch (error) {
    send(500, { error: String(error.message).slice(0, 200) });
  }
}).listen(port, '127.0.0.1', () => console.log(`fake openrouter on ${port}`));
