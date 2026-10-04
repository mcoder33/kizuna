export const ROOM_SEASONS = Object.freeze(['winter', 'spring', 'summer', 'autumn']);
export const ROOM_LIGHTS = Object.freeze(['day', 'night']);

export function chooseRoom({ date = new Date(), timeZone = 'UTC', season = 'auto', light = 'auto' } = {}) {
  let parts;
  try { parts = new Intl.DateTimeFormat('en-GB', { timeZone, month: 'numeric', hour: 'numeric', hourCycle: 'h23' }).formatToParts(date); }
  catch { parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'numeric', hour: 'numeric', hourCycle: 'h23' }).formatToParts(date); }
  const read = name => Number(parts.find(p => p.type === name)?.value);
  return {
    season: ROOM_SEASONS.includes(season) ? season : ROOM_SEASONS[Math.floor(read('month') % 12 / 3)],
    light: ROOM_LIGHTS.includes(light) ? light : read('hour') >= 7 && read('hour') < 19 ? 'day' : 'night',
  };
}

export function roomAsset(room, compact = false) {
  if (!ROOM_SEASONS.includes(room.season) || !ROOM_LIGHTS.includes(room.light)) return null;
  return '/public/workshop/' + room.season + '-' + room.light + '-' + (compact ? 'mobile' : 'desktop') + '.webp';
}

// Bounded polling also catches DST changes and waking across a date boundary.
export const ROOM_REFRESH_MS = 60_000;
