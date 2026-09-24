// Поддельный Bot API Telegram: те же методы, адреса и ответы, что у настоящего,
// но без сети. Юнит-тесты отдают его приложению вместо fetch, e2e ходят к нему
// через заглушку tests/fixtures/openrouter-server.js (пути /telegram/…).
//
// Обновления живут, как у Telegram: getUpdates с offset забывает всё, что
// ниже, а без него отдаёт неподтверждённое снова.
export const FAKE_BOT_TOKEN = '123456789:fake-telegram-token-for-tests-000';

export function createFakeTelegram({ token = FAKE_BOT_TOKEN, username = 'kizuna_test_bot', firstName = 'Кизуна' } = {}) {
  let updateId = 100, messageId = 1000, sentId = 5000, fileSeq = 1;
  const pending = [];
  const sent = [];
  const files = new Map();
  const waiters = new Set();
  const bot = { description: '', shortDescription: '', commands: [] };
  const user = { id: 777001, is_bot: false, first_name: 'Саша', username: 'sasha' };

  function message(fields = {}) {
    const from = fields.from || user;
    const chat = fields.chat || { id: from.id, type: 'private', first_name: from.first_name, username: from.username };
    return { message_id: messageId++, date: Math.floor(Date.now() / 1000), ...fields, from, chat };
  }
  // Сообщение «пришло» боту.
  function push(fields = {}) {
    const update = { update_id: updateId++, message: message(fields) };
    pending.push(update);
    for (const wake of [...waiters]) wake();
    return update;
  }
  function addFile(bytes, name = 'file.bin') {
    const fileId = `file-${fileSeq++}`;
    files.set(fileId, { path: `files/${fileId}/${name}`, bytes: Buffer.from(bytes) });
    return fileId;
  }
  function waitFor(ms, signal) {
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); waiters.delete(done); signal?.removeEventListener?.('abort', done); resolve(); };
      const timer = setTimeout(done, ms);
      waiters.add(done);
      signal?.addEventListener?.('abort', done);
    });
  }
  const ok = result => ({ status: 200, body: { ok: true, result } });
  const fail = (status, description) => ({ status, body: { ok: false, error_code: status, description } });

  async function method(name, params = {}, { signal } = {}) {
    switch (name) {
      case 'getMe': return ok({ id: 424242, is_bot: true, first_name: firstName, username });
      case 'getUpdates': {
        const offset = Number(params.offset) || 0;
        while (pending.length && pending[0].update_id < offset) pending.shift();
        const ready = () => pending.filter(update => update.update_id >= offset).slice(0, Number(params.limit) || 100);
        if (!ready().length && Number(params.timeout) > 0) await waitFor(Number(params.timeout) * 1000, signal);
        return ok(ready());
      }
      case 'sendMessage': {
        const result = { message_id: sentId++, date: Math.floor(Date.now() / 1000), chat: { id: params.chat_id, type: 'private' }, text: params.text };
        sent.push({ method: name, params, result });
        return ok(result);
      }
      case 'editMessageText':
        sent.push({ method: name, params });
        return ok({ message_id: params.message_id, chat: { id: params.chat_id, type: 'private' }, text: params.text });
      case 'sendChatAction': return ok(true);
      case 'setMyCommands': bot.commands = params.commands || []; return ok(true);
      case 'getMyDescription': return ok({ description: bot.description });
      case 'setMyDescription': bot.description = params.description || ''; return ok(true);
      case 'getMyShortDescription': return ok({ short_description: bot.shortDescription });
      case 'setMyShortDescription': bot.shortDescription = params.short_description || ''; return ok(true);
      case 'getFile': {
        const file = files.get(params.file_id);
        return file ? ok({ file_id: params.file_id, file_unique_id: params.file_id, file_size: file.bytes.length, file_path: file.path }) : fail(400, 'Bad Request: invalid file_id');
      }
      default: return fail(404, 'Not Found');
    }
  }
  // <база>/bot<токен>/<метод> и <база>/file/bot<токен>/<путь> — как у Telegram.
  async function handle(pathname, params = {}, options = {}) {
    const fileMatch = pathname.match(/\/file\/bot([^/]+)\/(.+)$/);
    if (fileMatch) {
      if (fileMatch[1] !== token) return { status: 401, bytes: Buffer.from('Unauthorized') };
      const path = decodeURIComponent(fileMatch[2]);
      const file = [...files.values()].find(entry => entry.path === path);
      return file ? { status: 200, bytes: file.bytes } : { status: 404, bytes: Buffer.from('Not Found') };
    }
    const match = pathname.match(/\/bot([^/]+)\/(\w+)$/);
    if (!match) return fail(404, 'Not Found');
    if (match[1] !== token) return fail(401, 'Unauthorized');
    return method(match[2], params, options);
  }
  const aborted = () => new DOMException('The operation was aborted.', 'AbortError');
  async function fetch(url, init = {}) {
    if (init.signal?.aborted) throw aborted();
    const { pathname } = new URL(url);
    const result = await handle(pathname, init.body ? JSON.parse(init.body) : {}, { signal: init.signal });
    if (init.signal?.aborted) throw aborted();
    if (result.bytes) return new Response(result.bytes, { status: result.status });
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'Content-Type': 'application/json' } });
  }
  // Что бот сказал: отправленное и исправленное — по порядку.
  const said = () => sent.map(entry => ({ method: entry.method, text: entry.params.text, chatId: entry.params.chat_id, replyTo: entry.params.reply_parameters?.message_id ?? null, messageId: entry.result?.message_id ?? entry.params.message_id, markup: entry.params.reply_markup ?? null }));
  return { token, username, user, bot, push, addFile, pending, sent, said, handle, fetch };
}
