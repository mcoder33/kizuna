const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseTelegramDaySummaryUserIds(value) {
  if (typeof value !== 'string' || !value.trim()) return new Set();
  const ids = value.trim().split(/[,\s]+/);
  if (ids.some(id => !USER_ID.test(id))) return new Set();
  return new Set(ids.map(id => id.toLowerCase()));
}

export function createTelegramDaySummaryAccess({ userIds = null } = {}) {
  // Public summaries still require a valid user; the router/delivery verify active binding.
  if (userIds === null) return userId => typeof userId === 'string' && USER_ID.test(userId);
  let previous, allowed = new Set();
  return userId => {
    const value = userIds();
    if (value !== previous) { allowed = parseTelegramDaySummaryUserIds(value); previous = value; }
    return typeof userId === 'string' && USER_ID.test(userId) && allowed.has(userId.toLowerCase());
  };
}

// Search is public like summaries; the router still verifies the active private binding.
// Explicit allowlists remain available for isolated integrations.
export function createTelegramTaskSearchAccess({ userIds = null } = {}) {
  if (userIds !== null && typeof userIds !== 'function') return () => false;
  return createTelegramDaySummaryAccess({ userIds });
}
