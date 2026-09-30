// Вход в приложение: кто перед нами, что ему можно и по каким правилам его
// пускают. Здесь же — регистрация, второй фактор и всё, что делает
// администратор с чужими учётными записями.
//
// Разделение с server/auth.js намеренное: там чистая криптография без базы и
// без HTTP, здесь — правила и маршруты. Так первое можно проверять само по
// себе, а второе читать как список решений, а не как смесь того и другого.
import {
  PASSWORD_MIN_LENGTH, passwordProblem, hashPassword, verifyPassword,
  generateTotpSecret, verifyTotp, otpauthUri,
  generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode,
  newSessionToken, hashToken, sessionCookie, clearedSessionCookie, readCookie, SESSION_COOKIE, SESSION_TTL_MS,
  normalizeEmail, validEmail, MAX_FAILED_ATTEMPTS, LOCKOUT_MS,
} from './auth.js';
import QRCode from 'qrcode';
import express from 'express';
import { monthlySpend } from './db.js';
import { avatarUrl, avatarPresets, choosePreset, saveAvatarImage, avatarImage, forgetAvatar, AVATAR_IMAGE_LIMIT } from './avatars.js';
import { notify } from './notifications.js';
import {
  createUser, findUserByEmail, findUserById, countUsers, listUsers, updateUser, adoptOrphanRecords,
  createSession, findSessionUser, touchSession, deleteSession, deleteUserSessions, purgeExpiredSessions, countUserSessions,
  logAuthEvent, listAuthEvents, userActivity,
} from './db.js';

// Наружу о человеке уходит только это. Хеш пароля, секрет второго фактора и
// резервные коды не покидают сервер ни при каких обстоятельствах.
export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id, email: row.email, role: row.role, status: row.status,
    // Имя видят люди в круге; без имени человека зовут по началу адреса.
    name: (row.display_name || '').trim() || String(row.email || '').split('@')[0],
    avatar: avatarUrl(row),
    twoFactorEnabled: Boolean(row.totp_enabled),
    createdAt: row.created_at, approvedAt: row.approved_at, lastLoginAt: row.last_login_at,
    blockedAt: row.blocked_at, blockedReason: row.blocked_reason,
    voiceBlocked: Boolean(row.voice_blocked),
    voiceLimitUsd: row.voice_limit_usd ?? null,
    voiceLimitMinutes: row.voice_limit_minutes ?? null,
    voiceLimitWindow: row.voice_limit_window ?? null,
    monthlyLimitUsd: row.monthly_limit_usd ?? null,
    ...(row.capture_count === undefined ? {} : { captureCount: row.capture_count, voiceCostUsd: row.voice_cost_usd, voiceSeconds: row.voice_seconds }),
  };
}

const PENDING_LIMIT = 50;
const fail = (res, status, code, message, extra = {}) => res.status(status).json({ error: { code, message, ...extra } });

export function createAccounts({ db, now = () => new Date(), secureCookies = false, audit = () => {}, sessionTtlMs = SESSION_TTL_MS, timeZone = () => 'UTC' } = {}) {
  const at = () => now().toISOString();
  const note = (event) => { try { audit(event); } catch {} };

  // ── первая учётная запись ────────────────────────────────────────────────
  // Пока людей нет, приложение открыто настежь: попросить войти не у кого.
  // Поэтому первый, кто зарегистрируется, становится администратором и
  // забирает себе журнал, который вёлся до обновления.
  const needsBootstrap = () => countUsers(db) === 0;

  function registerAccount({ email, password, userAgent = null }) {
    const address = normalizeEmail(email);
    if (!validEmail(address)) return { error: [400, 'invalid_email', 'Введите корректный адрес почты.'] };
    const problem = passwordProblem(password);
    if (problem) return { error: [400, 'weak_password', problem] };
    const first = needsBootstrap();
    // Регистрация открыта всем, а решает администратор — значит, очередь заявок
    // легко забить и утопить в ней настоящих людей. Больше полусотни
    // нерассмотренных заявок держать незачем: сначала разберите эти.
    if (!first && listUsers(db).filter(user => user.status === 'pending').length >= PENDING_LIMIT) {
      logAuthEvent(db, { email: address, event: 'register', result: 'queue_full' });
      return { error: [429, 'too_many_pending', 'Очередь заявок переполнена. Попробуйте позже.'] };
    }
    if (findUserByEmail(db, address)) {
      logAuthEvent(db, { email: address, event: 'register', result: 'duplicate' });
      return { error: [409, 'email_taken', 'Такой адрес уже зарегистрирован.'] };
    }
    const user = createUser(db, {
      email: address, passwordHash: hashPassword(password),
      role: first ? 'admin' : 'user', status: first ? 'active' : 'pending',
    });
    if (first) {
      updateUser(db, user.id, { approved_at: at(), approved_by: user.id });
      adoptOrphanRecords(db, user.id);
    }
    logAuthEvent(db, { userId: user.id, email: address, event: 'register', result: 'succeeded', detail: first ? 'bootstrap-admin' : null });
    note({ event: 'user_registered', result: 'succeeded', role: first ? 'admin' : 'user' });
    return { user: findUserById(db, user.id), first, userAgent };
  }

  // ── сессия ───────────────────────────────────────────────────────────────
  function issueSession(user, { userAgent = null } = {}) {
    const token = newSessionToken();
    createSession(db, { tokenHash: hashToken(token), userId: user.id, expiresAt: new Date(now().getTime() + sessionTtlMs).toISOString(), userAgent });
    updateUser(db, user.id, { last_login_at: at(), failed_attempts: 0, locked_until: null });
    return token;
  }
  const setSessionCookie = (res, token) => res.append('Set-Cookie', sessionCookie(token, { secure: secureCookies, maxAgeMs: sessionTtlMs }));
  const dropSessionCookie = (res) => res.append('Set-Cookie', clearedSessionCookie({ secure: secureCookies }));

  // ── кто перед нами ───────────────────────────────────────────────────────
  // Прикрепляется ко всем запросам, но никого не заворачивает: решение
  // «пускать или нет» принимают requireAuth и requireAdmin, и по этой границе
  // видно, какие маршруты открыты намеренно.
  function attachUser(req, res, next) {
    req.user = null;
    const token = readCookie(req.get('cookie'), SESSION_COOKIE);
    if (!token) return next();
    const tokenHash = hashToken(token);
    const user = findSessionUser(db, tokenHash, at());
    if (!user) { dropSessionCookie(res); return next(); }
    // Заблокированного человека выкидывает на первом же запросе: иначе выданная
    // до блокировки кука работала бы ещё месяц.
    if (user.status !== 'active') { deleteSession(db, tokenHash); dropSessionCookie(res); return next(); }
    touchSession(db, tokenHash, at());
    req.user = user;
    req.sessionTokenHash = tokenHash;
    next();
  }

  // Опознать человека по одной куке, без express-обвязки: запрос на upgrade
  // вебсокета приходит сырым — ни req.get, ни res у него нет.
  function userFromCookieHeader(header) {
    const token = readCookie(header, SESSION_COOKIE);
    if (!token) return null;
    const user = findSessionUser(db, hashToken(token), at());
    return user && user.status === 'active' ? user : null;
  }
  const requireAuth = (req, res, next) => req.user ? next() : fail(res, 401, 'unauthorized', 'Нужно войти.');
  const requireAdmin = (req, res, next) => !req.user ? fail(res, 401, 'unauthorized', 'Нужно войти.') : req.user.role === 'admin' ? next() : fail(res, 403, 'forbidden', 'Нужны права администратора.');

  // ── вход ─────────────────────────────────────────────────────────────────
  // Порядок проверок выбран так, чтобы по ответу нельзя было перебрать чужие
  // адреса: «нет такого» и «неверный пароль» отвечают одинаково.
  function login({ email, password, code, userAgent }) {
    const address = normalizeEmail(email);
    const user = findUserByEmail(db, address);
    const wrong = [401, 'invalid_credentials', 'Неверная почта или пароль.'];
    if (!user) { hashPassword(String(password || 'x').padEnd(12, 'x')); logAuthEvent(db, { email: address, event: 'login', result: 'unknown_email' }); return { error: wrong }; }
    if (user.locked_until && user.locked_until > at()) {
      logAuthEvent(db, { userId: user.id, email: address, event: 'login', result: 'locked' });
      return { error: [429, 'too_many_attempts', 'Слишком много попыток. Попробуйте позже.'] };
    }
    if (!verifyPassword(String(password || ''), user.password_hash)) {
      const attempts = (user.failed_attempts || 0) + 1;
      updateUser(db, user.id, { failed_attempts: attempts, locked_until: attempts >= MAX_FAILED_ATTEMPTS ? new Date(now().getTime() + LOCKOUT_MS).toISOString() : null });
      logAuthEvent(db, { userId: user.id, email: address, event: 'login', result: 'wrong_password', detail: `attempt ${attempts}` });
      note({ event: 'login_failed', result: 'failed' });
      return { error: wrong };
    }
    if (user.status === 'pending') { logAuthEvent(db, { userId: user.id, email: address, event: 'login', result: 'pending' }); return { error: [403, 'account_pending', 'Заявка ждёт подтверждения администратора.'] }; }
    if (user.status === 'rejected') { logAuthEvent(db, { userId: user.id, email: address, event: 'login', result: 'rejected' }); return { error: [403, 'account_rejected', 'В доступе отказано.'] }; }
    if (user.status === 'blocked') { logAuthEvent(db, { userId: user.id, email: address, event: 'login', result: 'blocked' }); return { error: [403, 'account_blocked', user.blocked_reason ? `Доступ закрыт: ${user.blocked_reason}` : 'Доступ закрыт администратором.'] }; }
    // Второй фактор проверяется последним: спрашивать код у того, кто не знает
    // пароля, значит подсказывать, что адрес существует.
    if (user.totp_enabled) {
      const entered = String(code || '').trim();
      if (!entered) return { error: [401, 'totp_required', 'Введите код из приложения.'] };
      if (!verifyTotp(user.totp_secret, entered, { at: now().getTime() }) && !consumeRecoveryCode(user, entered)) {
        const attempts = (user.failed_attempts || 0) + 1;
        updateUser(db, user.id, { failed_attempts: attempts, locked_until: attempts >= MAX_FAILED_ATTEMPTS ? new Date(now().getTime() + LOCKOUT_MS).toISOString() : null });
        logAuthEvent(db, { userId: user.id, email: address, event: 'login', result: 'wrong_totp' });
        return { error: [401, 'invalid_totp', 'Код не подошёл.'] };
      }
    }
    const token = issueSession(user, { userAgent });
    logAuthEvent(db, { userId: user.id, email: address, event: 'login', result: 'succeeded' });
    note({ event: 'login', result: 'succeeded' });
    return { token, user: findUserById(db, user.id) };
  }

  // Резервный код одноразовый: подошедший сразу вычёркивается, иначе список,
  // однажды подсмотренный, работал бы вечно.
  function consumeRecoveryCode(user, entered) {
    const normalized = normalizeRecoveryCode(entered);
    if (!normalized) return false;
    let stored;
    try { stored = JSON.parse(user.recovery_codes_json || '[]'); } catch { return false; }
    const hash = hashRecoveryCode(normalized);
    if (!stored.includes(hash)) return false;
    updateUser(db, user.id, { recovery_codes_json: JSON.stringify(stored.filter(item => item !== hash)) });
    logAuthEvent(db, { userId: user.id, email: user.email, event: 'recovery_code', result: 'used', detail: `осталось ${stored.length - 1}` });
    return true;
  }

  // ── маршруты ─────────────────────────────────────────────────────────────
  function registerRoutes(app) {
    // Открытый маршрут: страница входа должна знать, звать ли к регистрации
    // первого администратора и не вошли ли мы уже.
    app.get('/api/auth/state', (req, res) => res.json({ authenticated: Boolean(req.user), needsBootstrap: needsBootstrap(), user: publicUser(req.user) }));

    app.post('/api/auth/register', (req, res, next) => {
      try {
        const result = registerAccount({ email: req.body?.email, password: req.body?.password, userAgent: req.get('user-agent') });
        if (result.error) return fail(res, ...result.error);
        // Первого администратора незачем заставлять входить ещё раз — он уже
        // доказал, что знает пароль, придумав его минуту назад.
        if (result.first) { setSessionCookie(res, issueSession(result.user, { userAgent: req.get('user-agent') })); return res.status(201).json({ user: publicUser(findUserById(db, result.user.id)), first: true }); }
        // Заявку разбирает администратор — и узнаёт о ней сразу, а не когда
        // случайно заглянет в «Пользователей».
        for (const admin of listUsers(db).filter(user => user.role === 'admin' && user.status === 'active'))
          notify(db, { userId: admin.id, kind: 'signup', lead: 'Новая заявка на вход:', text: result.user.email, meta: ['доступ открывает администратор'], data: { url: '/#admin' } });
        res.status(201).json({ user: publicUser(result.user), first: false, message: 'Заявка отправлена. Доступ откроет администратор.' });
      } catch (error) { next(error); }
    });

    app.post('/api/auth/login', (req, res, next) => {
      try {
        const result = login({ email: req.body?.email, password: req.body?.password, code: req.body?.code, userAgent: req.get('user-agent') });
        if (result.error) return fail(res, ...result.error);
        setSessionCookie(res, result.token);
        res.json({ user: publicUser(result.user) });
      } catch (error) { next(error); }
    });

    app.post('/api/auth/logout', (req, res) => {
      if (req.sessionTokenHash) deleteSession(db, req.sessionTokenHash);
      if (req.user) logAuthEvent(db, { userId: req.user.id, email: req.user.email, event: 'logout', result: 'succeeded' });
      dropSessionCookie(res);
      res.json({ ok: true });
    });

    app.get('/api/auth/me', requireAuth, (req, res) => res.json({
      user: publicUser(req.user),
      sessions: countUserSessions(db, req.user.id, at()),
      recoveryCodesLeft: (() => { try { return JSON.parse(req.user.recovery_codes_json || '[]').length; } catch { return 0; } })(),
    }));

    // ── аватар ──
    // Персонаж выбирается из набора, своя картинка приходит уже ужатой
    // браузером. Смотреть чужое лицо может любой вошедший: оно видно в круге и
    // в разговоре, а адрес картинки знает только тот, кому показали человека.
    const AVATAR_ERRORS = {
      unknown_preset: [400, 'Такого персонажа нет в наборе.'],
      empty_image: [400, 'Картинка пустая.'],
      not_an_image: [415, 'Подходят только PNG, JPEG и WebP.'],
      image_too_large: [413, 'Картинка слишком большая.'],
    };
    const avatarReply = (req, res, result) => {
      if (result.error) { const [status, message] = AVATAR_ERRORS[result.error]; return fail(res, status, result.error, message); }
      res.json({ me: publicUser(findUserById(db, req.user.id)) });
    };
    app.get('/api/account/avatars', requireAuth, (req, res) => res.json({ presets: avatarPresets() }));
    app.put('/api/account/avatar', requireAuth, (req, res, next) => {
      try {
        const preset = req.body?.preset ?? null;
        if (preset !== null && typeof preset !== 'string') return fail(res, 400, 'unknown_preset', AVATAR_ERRORS.unknown_preset[1]);
        avatarReply(req, res, choosePreset(db, req.user.id, preset));
      } catch (error) { next(error); }
    });
    app.post('/api/account/avatar/image', requireAuth, express.raw({ type: () => true, limit: AVATAR_IMAGE_LIMIT }), (req, res, next) => {
      try { avatarReply(req, res, saveAvatarImage(db, req.user.id, Buffer.isBuffer(req.body) ? req.body : null, now())); }
      catch (error) { next(error); }
    });
    app.get('/api/avatars/:userId', requireAuth, (req, res) => {
      const image = avatarImage(db, req.params.userId);
      if (!image) return fail(res, 404, 'not_found', 'Картинки нет.');
      // Адрес меняется вместе с картинкой (?v=), поэтому кешировать можно
      // надолго; sniff и CSP — чтобы байты не стали ничем, кроме картинки.
      res.set({ 'Content-Type': image.mime, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
      res.send(image.bytes);
    });

    app.post('/api/auth/logout-everywhere', requireAuth, (req, res) => {
      deleteUserSessions(db, req.user.id);
      logAuthEvent(db, { userId: req.user.id, email: req.user.email, event: 'logout_all', result: 'succeeded' });
      dropSessionCookie(res);
      res.json({ ok: true });
    });

    app.post('/api/auth/password', requireAuth, (req, res, next) => {
      try {
        if (!verifyPassword(String(req.body?.currentPassword || ''), req.user.password_hash)) return fail(res, 403, 'invalid_credentials', 'Текущий пароль не подошёл.');
        const problem = passwordProblem(req.body?.newPassword);
        if (problem) return fail(res, 400, 'weak_password', problem);
        updateUser(db, req.user.id, { password_hash: hashPassword(req.body.newPassword) });
        // Смена пароля закрывает все прочие входы: если пароль меняют потому,
        // что его подсмотрели, чужая кука не должна пережить эту минуту.
        deleteUserSessions(db, req.user.id);
        setSessionCookie(res, issueSession(findUserById(db, req.user.id), { userAgent: req.get('user-agent') }));
        logAuthEvent(db, { userId: req.user.id, email: req.user.email, event: 'password_changed', result: 'succeeded' });
        res.json({ ok: true });
      } catch (error) { next(error); }
    });

    // ── второй фактор ──────────────────────────────────────────────────────
    // Секрет сперва живёт отдельным «черновым» полем: пока человек не доказал
    // кодом, что приложение его действительно приняло, включать второй фактор
    // нельзя — иначе можно запереть себя снаружи.
    app.post('/api/auth/totp/setup', requireAuth, async (req, res, next) => {
      try {
        if (req.user.totp_enabled) return fail(res, 409, 'totp_already_enabled', 'Второй фактор уже включён.');
        const secret = generateTotpSecret();
        updateUser(db, req.user.id, { totp_pending_secret: secret });
        const uri = otpauthUri({ secret, account: req.user.email });
        // Картинка рисуется здесь и уходит готовой: страница не ходит за ней в
        // чужой сервис, а значит секрет не покидает этот компьютер.
        const qr = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).catch(() => null);
        res.json({ secret, uri, digits: 6, period: 30, qr: qr ? `data:image/svg+xml;base64,${Buffer.from(qr).toString('base64')}` : null });
      } catch (error) { next(error); }
    });

    app.post('/api/auth/totp/enable', requireAuth, (req, res, next) => {
      try {
        const pending = req.user.totp_pending_secret;
        if (!pending) return fail(res, 409, 'totp_not_started', 'Сначала получите секрет.');
        if (!verifyTotp(pending, req.body?.code, { at: now().getTime() })) return fail(res, 400, 'invalid_totp', 'Код не подошёл. Проверьте время на телефоне.');
        const codes = generateRecoveryCodes();
        updateUser(db, req.user.id, { totp_secret: pending, totp_pending_secret: null, totp_enabled: 1, recovery_codes_json: JSON.stringify(codes.map(hashRecoveryCode)) });
        logAuthEvent(db, { userId: req.user.id, email: req.user.email, event: 'totp_enabled', result: 'succeeded' });
        // Коды показываются ровно один раз: хранить их в открытом виде значило
        // бы держать рядом с замком запасной ключ.
        res.json({ ok: true, recoveryCodes: codes });
      } catch (error) { next(error); }
    });

    app.post('/api/auth/totp/disable', requireAuth, (req, res, next) => {
      try {
        if (!req.user.totp_enabled) return fail(res, 409, 'totp_not_enabled', 'Второй фактор не включён.');
        if (!verifyPassword(String(req.body?.password || ''), req.user.password_hash)) return fail(res, 403, 'invalid_credentials', 'Пароль не подошёл.');
        updateUser(db, req.user.id, { totp_secret: null, totp_pending_secret: null, totp_enabled: 0, recovery_codes_json: null });
        logAuthEvent(db, { userId: req.user.id, email: req.user.email, event: 'totp_disabled', result: 'succeeded' });
        res.json({ ok: true });
      } catch (error) { next(error); }
    });

    app.post('/api/auth/totp/recovery-codes', requireAuth, (req, res, next) => {
      try {
        if (!req.user.totp_enabled) return fail(res, 409, 'totp_not_enabled', 'Второй фактор не включён.');
        if (!verifyPassword(String(req.body?.password || ''), req.user.password_hash)) return fail(res, 403, 'invalid_credentials', 'Пароль не подошёл.');
        const codes = generateRecoveryCodes();
        updateUser(db, req.user.id, { recovery_codes_json: JSON.stringify(codes.map(hashRecoveryCode)) });
        res.json({ recoveryCodes: codes });
      } catch (error) { next(error); }
    });

    // ── администратор ──────────────────────────────────────────────────────
    app.get('/api/admin/users', requireAdmin, (req, res) => {
      // Активность приходит тем же запросом, что и список: «сколько потратил»
      // без «живёт ли он тут» — половина ответа, а ради второй половины список
      // и открывают.
      const activity = userActivity(db, { now: now(), timeZone: timeZone() });
      res.json({
        users: listUsers(db).map(row => ({
          ...publicUser(row),
          // Потолок ставят, глядя на расход, поэтому он приходит вместе со
          // списком, а не отдельным запросом на каждого.
          monthSpentUsd: monthlySpend(db, { userId: row.id, at: now(), timeZone: timeZone() }).totalUsd,
          activity: activity.users[row.id] || null,
        })),
        activityDays: activity.days,
        month: monthlySpend(db, { userId: undefined, at: now(), timeZone: timeZone() }),
      });
    });

    app.get('/api/admin/auth-events', requireAdmin, (req, res) => res.json({
      events: listAuthEvents(db, { limit: req.query.limit, userId: typeof req.query.userId === 'string' ? req.query.userId : null })
        .map(row => ({ id: row.id, userId: row.user_id, email: row.email, event: row.event, result: row.result, detail: row.detail, createdAt: row.created_at })),
    }));


    // Одна дверь для всех действий над чужой учётной записью: так проще
    // удержать правило «последнего администратора не разжаловать и не закрыть».
    app.post('/api/admin/users/:id/:action', requireAdmin, (req, res, next) => {
      try {
        const target = findUserById(db, req.params.id);
        if (!target) return fail(res, 404, 'not_found', 'Пользователь не найден.');
        const action = req.params.action;
        const activeAdmins = () => listUsers(db).filter(user => user.role === 'admin' && user.status === 'active').length;
        const lastAdmin = target.role === 'admin' && target.status === 'active' && activeAdmins() <= 1;
        const guard = (message) => fail(res, 409, 'last_admin', message);

        if (action === 'approve') {
          if (!['pending','rejected'].includes(target.status)) return fail(res, 409, 'invalid_status', 'Одобрять можно только заявку.');
          updateUser(db, target.id, { status: 'active', approved_at: at(), approved_by: req.user.id, blocked_at: null, blocked_reason: null });
        } else if (action === 'reject') {
          if (target.status !== 'pending') return fail(res, 409, 'invalid_status', 'Отклонить можно только заявку.');
          updateUser(db, target.id, { status: 'rejected' });
        } else if (action === 'block') {
          if (lastAdmin) return guard('Это последний администратор — закрывать ему доступ некому.');
          const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 200) : null;
          updateUser(db, target.id, { status: 'blocked', blocked_at: at(), blocked_reason: reason || null });
          // Блокировка обрывает уже открытые вкладки, а не ждёт, пока протухнет
          // кука: иначе «заблокировать» означало бы «через месяц».
          deleteUserSessions(db, target.id);
        } else if (action === 'unblock') {
          if (target.status !== 'blocked') return fail(res, 409, 'invalid_status', 'Пользователь не заблокирован.');
          updateUser(db, target.id, { status: 'active', blocked_at: null, blocked_reason: null });
        } else if (action === 'role') {
          const role = req.body?.role;
          if (role !== 'admin' && role !== 'user') return fail(res, 400, 'invalid_role', 'Роль может быть admin или user.');
          if (role === 'user' && lastAdmin) return guard('Это последний администратор — снимать роль некому.');
          updateUser(db, target.id, { role });
        } else if (action === 'limits') {
          const limits = readLimits(req.body);
          if (limits.error) return fail(res, 400, 'invalid_limit', limits.error);
          updateUser(db, target.id, limits.patch);
        } else if (action === 'reset-2fa') {
          updateUser(db, target.id, { totp_secret: null, totp_pending_secret: null, totp_enabled: 0, recovery_codes_json: null });
          deleteUserSessions(db, target.id);
        } else if (action === 'unlock') {
          updateUser(db, target.id, { failed_attempts: 0, locked_until: null });
        } else if (action === 'sessions-reset') {
          deleteUserSessions(db, target.id);
        } else {
          return fail(res, 404, 'unknown_action', 'Неизвестное действие.');
        }
        logAuthEvent(db, { userId: target.id, email: target.email, event: `admin_${action}`, result: 'succeeded', detail: `от ${req.user.email}` });
        note({ event: 'admin_user_action', action, result: 'succeeded' });
        res.json({ user: publicUser(listUsers(db).find(user => user.id === target.id)) });
      } catch (error) { next(error); }
    });

    app.delete('/api/admin/users/:id', requireAdmin, (req, res, next) => {
      try {
        const target = findUserById(db, req.params.id);
        if (!target) return fail(res, 404, 'not_found', 'Пользователь не найден.');
        if (target.id === req.user.id) return fail(res, 409, 'self_delete', 'Себя удалить нельзя.');
        // Удаляется только тот, кто ничего не записал: у остальных есть журнал,
        // и молча стереть его вместе с человеком — не то, чего от кнопки ждут.
        const withData = listUsers(db).find(user => user.id === target.id)?.capture_count;
        if (withData) return fail(res, 409, 'user_has_data', 'У пользователя есть записи. Сначала заблокируйте его.');
        deleteUserSessions(db, target.id);
        // Память помощника про этого человека уходит вместе с ним: без хозяина
        // она никому не видна и ничего не уточняет.
        db.prepare('DELETE FROM agent_memories WHERE user_id=?').run(target.id);
        forgetAvatar(db, target.id);
        db.prepare('DELETE FROM notifications WHERE user_id=?').run(target.id);
        // Привязанный Telegram без хозяина писал бы в пустоту — отвязываем.
        db.prepare('DELETE FROM telegram_links WHERE user_id=?').run(target.id);
        db.prepare('DELETE FROM telegram_codes WHERE user_id=?').run(target.id);
        db.prepare('DELETE FROM users WHERE id=?').run(target.id);
        logAuthEvent(db, { email: target.email, event: 'admin_delete', result: 'succeeded', detail: `от ${req.user.email}` });
        res.json({ ok: true });
      } catch (error) { next(error); }
    });
  }

  // Пустое поле — это «нет своего предела, работает общий», а не «ноль»: ноль
  // означал бы «нельзя ни секунды», и отличить одно от другого обязательно.
  function readLimits(body) {
    const patch = {};
    const number = (value, name) => {
      if (value === null || value === undefined || value === '') return null;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1e6) return { error: `Некорректное значение: ${name}.` };
      return parsed;
    };
    for (const [field, key, name] of [['voice_limit_usd', 'voiceLimitUsd', 'предел разговора в долларах'], ['voice_limit_minutes', 'voiceLimitMinutes', 'предел разговора в минутах'], ['monthly_limit_usd', 'monthlyLimitUsd', 'потолок расходов на месяц']]) {
      if (!Object.hasOwn(body || {}, key)) continue;
      const parsed = number(body[key], name);
      if (parsed && parsed.error) return { error: parsed.error };
      patch[field] = parsed;
    }
    if (Object.hasOwn(body || {}, 'voiceLimitWindow')) {
      const window = body.voiceLimitWindow;
      if (window !== null && window !== '' && !['day','week','month','total'].includes(window)) return { error: 'Некорректный период предела.' };
      patch.voice_limit_window = window || null;
    }
    if (Object.hasOwn(body || {}, 'voiceBlocked')) patch.voice_blocked = body.voiceBlocked ? 1 : 0;
    return { patch };
  }

  // Раз в час — чтобы протухшие сессии не копились вечно; на первом же запросе
  // после запуска — чтобы уборка не ждала часа на редко используемом сервере.
  purgeExpiredSessions(db, at());

  return { attachUser, userFromCookieHeader, requireAuth, requireAdmin, registerRoutes, issueSession, needsBootstrap, registerAccount, publicUser, readLimits, PASSWORD_MIN_LENGTH };
}
