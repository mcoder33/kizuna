// Shared selection and deck for Telegram announcements and deployment checks.
const SITE = 'https://kizuna.agent-hub.space';
export const RELEASE_SEASONS = ['spring', 'summer', 'autumn', 'winter'];
export const RELEASE_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const RELEASE_CARDS = RELEASE_SEASONS.flatMap(season => RELEASE_WEEKDAYS.map(day =>
  `${SITE}/public/release-cards/${season}-${day}.png`));

export function selectSeasonalReleaseCard(date, timeZone = 'Europe/Samara') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, month: 'numeric', weekday: 'short',
  }).formatToParts(date).map(part => [part.type, part.value]));
  const month = Number(parts.month);
  const season = month >= 3 && month <= 5 ? 'spring' : month >= 6 && month <= 8 ? 'summer' : month >= 9 && month <= 11 ? 'autumn' : 'winter';
  return `${SITE}/public/release-cards/${season}-${parts.weekday.toLowerCase()}.png`;
}

// Auto-release fills an omitted choice; explicit plain or manual media wins.
export function applySeasonalDefault(manifest, enabled = false) {
  if (enabled && manifest.seasonalImage === undefined && !manifest.image) {
    return { ...manifest, seasonalImage: true };
  }
  return manifest;
}
