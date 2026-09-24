#!/usr/bin/env node
// Заглушка OpenRouter для e2e: отвечает по тому же контракту, что настоящий
// сервис, но разбор делает детерминированный фейковый «разум» из хелпера.
// Сеть при прогоне тестов не используется.
import http from 'node:http';
import { fakeModelCandidate } from '../helpers/fake-model.js';
import { createFakeTelegram } from '../helpers/fake-telegram.js';

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
  // Метка в тексте роняет заглушку: так e2e получает запись «без разбора»,
  // как при настоящем сбое модели.
  if (raw.includes('[[сбой модели]]')) throw new Error('fake outage');
  return fakeModelCandidate(raw, new Date());
}

function answerFor(userMessage) {
  const sourceId = (userMessage.match(/\[([0-9a-f-]{36})\]/) || [])[1];
  return sourceId
    ? { answer: 'Контекст найден.', citationIds: [sourceId] }
    : { answer: 'В памяти пока нет подходящих записей.', citationIds: [] };
}

// Заодно здесь живёт и поддельный Telegram (пути /telegram/…): приложение
// ходит к нему как к api.telegram.org, а e2e через служебные пути «пишет»
// боту и читает, что бот ответил.
const telegram = createFakeTelegram();
async function telegramRoute(request, response, send) {
  const { pathname } = new URL(request.url, 'http://fake.local');
  if (pathname === '/telegram/__push') return send(200, telegram.push(JSON.parse((await readBody(request)) || '{}')));
  if (pathname === '/telegram/__said') return send(200, { said: telegram.said() });
  // Длинный опрос бота обрывается вместе с соединением: остановленный сервер
  // приложения не должен держать заглушку.
  const controller = new AbortController();
  response.on('close', () => controller.abort());
  const body = await readBody(request);
  const result = await telegram.handle(pathname, body ? JSON.parse(body) : {}, { signal: controller.signal });
  if (result.bytes) { response.writeHead(result.status); return response.end(result.bytes); }
  return send(result.status, result.body);
}

http.createServer(async (request, response) => {
  const send = (status, payload) => {
    if (response.writableEnded || response.destroyed) return;
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(payload));
  };
  try {
    if (request.url.startsWith('/telegram/')) return await telegramRoute(request, response, send);
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
