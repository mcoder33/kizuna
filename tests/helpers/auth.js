import request from 'supertest';
import { createUser, findUserByEmail, updateUser } from '../../server/db.js';
import { hashPassword } from '../../server/auth.js';

// Тесты ходят в API так же, как браузер: с кукой сессии. Учётная запись
// заводится прямо в базе, а не через форму регистрации — проверять форму в
// каждом тесте журнала незачем, для этого есть tests/auth.test.js.
export const TEST_PASSWORD = 'test-password-123';

export function seedUser(app, { email = 'admin@kizuna.test', role = 'admin', status = 'active', password = TEST_PASSWORD } = {}) {
  const db = app.database;
  const existing = findUserByEmail(db, email);
  if (existing) return existing;
  const user = createUser(db, { email, passwordHash: hashPassword(password), role, status, monthlyLimitUsd: null });
  return updateUser(db, user.id, { approved_at: new Date().toISOString() });
}

// Возвращает то же, что request(app), но с уже приложенной кукой: в тестах
// достаточно заменить request(...) на authed(...), остальное не меняется.
export function authed(app, { target = app, ...options } = {}) {
  const user = seedUser(app, options);
  const cookie = `pagent_session=${app.accounts.issueSession(user)}`;
  const agent = request(target);
  const call = (method) => (url) => agent[method](url).set('Cookie', cookie);
  return { get: call('get'), post: call('post'), put: call('put'), delete: call('delete'), patch: call('patch'), head: call('head'), user, cookie };
}
