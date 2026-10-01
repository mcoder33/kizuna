// Local-only desktop smoke fixture. No production accounts, tokens, or database.
// FIXTURE_PORT=8889 node desktop/macos/Tests/fixture-server.mjs
import http from 'node:http';
import { randomUUID } from 'node:crypto';
const port = Number(process.env.FIXTURE_PORT || 8889);
const token = 'desktop-fixture-session';
const items = [];
const requests = [];
const captures = [];
const operations = new Map();
const control = { authenticated: true, account: 'fixture-user', captureMode: 'success', delayMs: 0 };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const authed = control.authenticated && req.headers.cookie?.split(';').some(part => part.trim() === `pagent_session=${token}`);
  const observed = { method: req.method, path: url.pathname, authenticated: Boolean(authed) };
  requests.push(observed);
  const json = (status, object) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(object)); };
  if (url.pathname === '/__requests') return json(200, requests);
  if (url.pathname === '/__captures') return json(200, captures);
  if (url.pathname === '/__control' && req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    Object.assign(control, JSON.parse(raw || '{}'));
    return json(200, control);
  }
  if (url.pathname === '/__login' && req.method === 'POST') {
    control.authenticated = true;
    res.setHeader('Set-Cookie', `pagent_session=${token}; Path=/; HttpOnly; SameSite=Lax`);
    return json(200, { ok: true });
  }
  if (url.pathname === '/__notify' && req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const extra = raw ? JSON.parse(raw) : {};
    const stamp = new Date().toISOString();
    items.unshift({ id: `fixture-${items.length}`, kind: 'reminder', lead: 'Кизуна:', text: 'Тестовое напоминание', meta: [], data: {}, actors: [], captureId: 'fixture-card', read: false, resolved: false, dismissed: false, createdAt: stamp, updatedAt: stamp, ...extra });
    return json(200, { ok: true });
  }
  if (url.pathname === '/api/auth/me') return authed ? json(200, { user: { id: control.account } }) : json(401, { error: { code: 'unauthorized' } });
  if (url.pathname.startsWith('/api/') && !authed) return json(401, { error: { code: 'unauthorized' } });
  if (url.pathname === '/api/settings') return json(200, { settings: { notifyPrefs: '{}', quietHours: 'off' }, timeZone: 'UTC' });
  if (url.pathname === '/api/notifications') return json(200, { notifications: items, nextCursor: null, counts: { waits: 0, unread: items.length }, kinds: [{ key: 'reminder', default: 'phone' }] });
  if (url.pathname === '/api/captures' && req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}'), key = req.headers['idempotency-key'];
    Object.assign(observed, { body, key, prefer: req.headers.prefer, account: control.account });
    if (control.delayMs) await new Promise(resolve => setTimeout(resolve, control.delayMs));
    if (control.captureMode === 'unauthorized') return json(401, { error: { code: 'unauthorized' } });
    if (control.captureMode === 'error') return json(503, { error: { message: 'Тестовая ошибка. Черновик сохранён.' } });
    if (control.captureMode === 'redirect') { res.writeHead(302, { Location: 'https://example.com' }); return res.end(); }
    if (typeof body.raw !== 'string' || !body.raw.trim() || body.raw.length > 10000 || !key || req.headers.prefer !== 'respond-async') return json(400, { error: { message: 'Некорректная запись.' } });
    let saved = operations.get(key);
    const fingerprint = JSON.stringify({ body, account: control.account });
    if (saved && saved.fingerprint !== fingerprint) return json(409, { error: { message: 'Ключ уже использован для другой записи.' } });
    if (!saved) {
      const jobId = randomUUID(), captureId = randomUUID();
      saved = { fingerprint, envelope: { captureId, jobId, statusUrl: `/api/jobs/${jobId}` } };
      operations.set(key, saved); captures.push({ ...saved.envelope, body, key, account: control.account });
    }
    if (control.captureMode === 'disconnectOnce') { control.captureMode = 'success'; return req.socket.destroy(); }
    if (control.captureMode === 'malformed') return json(202, { ...saved.envelope, statusUrl: 'https://example.com/unsafe' });
    return json(202, saved.envelope);
  }
  if (url.pathname === '/login' && !control.authenticated) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<!doctype html><html lang="ru"><title>Вход — локальная проверка</title><h1>Войдите для сохранения черновика</h1><button id="fixture-login">Войти в тестовую учётную запись</button><script>document.querySelector("button").onclick=async()=>{await fetch("/__login",{method:"POST"});location.replace("/")}</script></html>');
  }
  if (url.pathname === '/login') {
    res.writeHead(302, { Location: '/', 'Set-Cookie': `pagent_session=${token}; Path=/; HttpOnly; SameSite=Lax` }); return res.end();
  }
  if (url.pathname === '/login' || url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': `pagent_session=${token}; Path=/; HttpOnly; SameSite=Lax` });
    return res.end(`<!doctype html><html lang="ru"><title>Кизуна — локальная проверка</title><body><h1>Локальная проверка Кизуны</h1><section id="today"><form id="capture-form"><div id="capture-input" contenteditable="true" role="textbox">Тестовое дело</div><button>Сохранить</button></form><a href="https://example.com">Внешняя ссылка</a><a href="/#today?open=fixture-card">Карточка</a></section><script>document.querySelector('form').addEventListener('submit',e=>e.preventDefault());</script></body></html>`);
  }
  return json(404, { error: { code: 'not_found' } });
});
server.listen(port, '127.0.0.1', () => console.log(`Desktop fixture: http://127.0.0.1:${port}`));
