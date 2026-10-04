export const ROOM_SEASONS = Object.freeze(['winter', 'spring', 'summer', 'autumn']);
export const ROOM_LIGHTS = Object.freeze(['day', 'night']);

export function chooseRoom({ date = new Date(), timeZone = 'UTC', season = 'auto', theme = 'system', systemDark = false } = {}) {
  let parts;
  try { parts = new Intl.DateTimeFormat('en-GB', { timeZone, month: 'numeric' }).formatToParts(date); }
  catch { parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'numeric' }).formatToParts(date); }
  const read = name => Number(parts.find(p => p.type === name)?.value);
  return {
    season: ROOM_SEASONS.includes(season) ? season : ROOM_SEASONS[Math.floor(read('month') % 12 / 3)],
    light: theme === 'dark' || (theme !== 'light' && systemDark) ? 'night' : 'day',
  };
}

export function roomAsset(room, compact = false) {
  if (!ROOM_SEASONS.includes(room.season) || !ROOM_LIGHTS.includes(room.light)) return null;
  return '/public/workshop/' + room.season + '-' + room.light + '-' + (compact ? 'mobile' : 'desktop') + '.webp';
}

// Recheck the local season after a month boundary or waking from sleep.
export const ROOM_REFRESH_MS = 60_000;
