const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createWorkshopAccess({ env = () => process.env } = {}) {
  const mode = () => ['off', 'allowlist', 'all'].includes(env().PAGENT_WORKSHOP_MODE) ? env().PAGENT_WORKSHOP_MODE : 'off';
  function allows(userId) {
    if (typeof userId !== 'string' || !USER_ID.test(userId)) return false;
    if (mode() === 'all') return true;
    if (mode() !== 'allowlist') return false;
    const ids = String(env().PAGENT_WORKSHOP_USER_IDS || '').trim().split(/[,\s]+/);
    if (!ids.length || ids.some(id => !USER_ID.test(id))) return false;
    return ids.some(id => id.toLowerCase() === userId.toLowerCase());
  }
  return { allows, publicEnabled: () => mode() === 'all', capabilities: userId => ({ workshopAppearance: allows(userId) }) };
}
