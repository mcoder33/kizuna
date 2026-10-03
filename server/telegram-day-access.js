const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseTelegramDaySummaryUserIds(value) {
  if (typeof value !== 'string' || !value.trim()) return new Set();
  const ids = value.trim().split(/[,\s]+/);
  if (ids.some(id => !USER_ID.test(id))) return new Set();
  return new Set(ids.map(id => id.toLowerCase()));
}

export function createTelegramDaySummaryAccess({ userIds = () => process.env.PAGENT_TELEGRAM_DAY_SUMMARY_USER_IDS } = {}) {
  let previous, allowed = new Set();
  return userId => {
    const value = userIds();
    if (value !== previous) { allowed = parseTelegramDaySummaryUserIds(value); previous = value; }
    return typeof userId === 'string' && USER_ID.test(userId) && allowed.has(userId.toLowerCase());
  };
}
