// Машинный доступ к пожеланиям: ответить человеку и поставить статус может не
// только админ из браузера, но и агент, который разбирает пожелания. Токен
// открывает ровно три маршрута — список пожеланий, одно пожелание и его
// изменение — и ничего больше из админки. В окружении лежит не сам токен, а
// его SHA-256 (PAGENT_FEEDBACK_AGENT_TOKEN_SHA256): утечка .env не даёт входа.
// Ответ подписывается учётной записью админа (PAGENT_FEEDBACK_AGENT_EMAIL, по
// умолчанию — самый ранний активный админ), потому что у ответа есть автор.
import crypto from 'node:crypto';
import { findUserByEmail } from './db.js';

const ROUTES = [
  { method: 'GET', pattern: /^\/api\/admin\/feedback\/?$/ },
  { method: 'GET', pattern: /^\/api\/admin\/feedback\/[^/]+\/?$/ },
  { method: 'PATCH', pattern: /^\/api\/admin\/feedback\/[^/]+\/?$/ },
];
const sha256 = value => crypto.createHash('sha256').update(String(value)).digest();

export function feedbackAgentAuth({ db, tokenHash = '', email = '', audit = () => {} } = {}) {
  const expected = /^[0-9a-f]{64}$/i.test(String(tokenHash || '')) ? Buffer.from(tokenHash, 'hex') : null;
  const agentUser = () => {
    const user = email ? findUserByEmail(db, String(email).trim().toLowerCase())
      : db.prepare("SELECT * FROM users WHERE role='admin' AND status='active' ORDER BY created_at, id LIMIT 1").get();
    return user && user.role === 'admin' && user.status === 'active' ? user : null;
  };
  return function feedbackAgent(req, res, next) {
    if (!expected || req.user) return next();
    const header = req.get('authorization') || '';
    if (!header.startsWith('Bearer ')) return next();
    if (!ROUTES.some(route => route.method === req.method && route.pattern.test(req.path))) return next();
    const given = sha256(header.slice(7).trim());
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      audit({ event: 'feedback_agent_auth', result: 'rejected' });
      return next();
    }
    const user = agentUser();
    if (!user) { audit({ event: 'feedback_agent_auth', result: 'no_admin' }); return next(); }
    req.user = user;
    req.machineActor = 'feedback-agent';
    audit({ event: 'feedback_agent_auth', result: 'succeeded', method: req.method });
    next();
  };
}
