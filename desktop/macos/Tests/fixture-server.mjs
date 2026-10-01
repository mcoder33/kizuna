// Local-only desktop smoke fixture. No production accounts, tokens, or database.
// FIXTURE_PORT=8889 node desktop/macos/Tests/fixture-server.mjs
import http from 'node:http';
const port = Number(process.env.FIXTURE_PORT || 8889);
const token = 'desktop-fixture-session';
const items = [];
const requests = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const authed = req.headers.cookie?.split(';').some(part => part.trim() === `pagent_session=${token}`);
  requests.push({ path: url.pathname, authenticated: Boolean(authed) });
  const json = (status, object) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(object)); };
  if (url.pathname === '/__requests') return json(200, requests);
  if (url.pathname === '/__notify' && req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const extra = raw ? JSON.parse(raw) : {};
    const stamp = new Date().toISOString();
    items.unshift({ id: `fixture-${items.length}`, kind: 'reminder', lead: 'Кизуна:', text: 'Тестовое напоминание', meta: [], data: {}, actors: [], captureId: 'fixture-card', read: false, resolved: false, dismissed: false, createdAt: stamp, updatedAt: stamp, ...extra });
    return json(200, { ok: true });
  }
  if (url.pathname === '/api/auth/me') return authed ? json(200, { user: { id: 'fixture-user' } }) : json(401, { error: { code: 'unauthorized' } });
  if (url.pathname.startsWith('/api/') && !authed) return json(401, { error: { code: 'unauthorized' } });
  if (url.pathname === '/api/settings') return json(200, { settings: { notifyPrefs: '{}', quietHours: 'off' }, timeZone: 'UTC' });
  if (url.pathname === '/api/notifications') return json(200, { notifications: items, nextCursor: null, counts: { waits: 0, unread: items.length }, kinds: [{ key: 'reminder', default: 'phone' }] });
  if (url.pathname === '/login' || url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': `pagent_session=${token}; Path=/; HttpOnly; SameSite=Lax` });
    return res.end(`<!doctype html><html lang="ru"><title>Кизуна — локальная проверка</title><body><h1>Локальная проверка Кизуны</h1><section id="today"><form id="capture-form"><div id="capture-input" contenteditable="true" role="textbox">Тестовое дело</div><button>Сохранить</button></form><a href="https://example.com">Внешняя ссылка</a><a href="/#today?open=fixture-card">Карточка</a></section><script>document.querySelector('form').addEventListener('submit',e=>e.preventDefault());</script></body></html>`);
  }
  return json(404, { error: { code: 'not_found' } });
});
server.listen(port, '127.0.0.1', () => console.log(`Desktop fixture: http://127.0.0.1:${port}`));
