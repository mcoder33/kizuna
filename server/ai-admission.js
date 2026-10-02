import { createAdmission } from './auth-admission.js';

// The same execution gate covers HTTP and queued/Telegram classifications.
export function createAiAdmission({ now = Date.now, perUserLimit = 30, maxConcurrent = 4, globalLimit = 120, maxKeys = 4096 } = {}) {
  const admission = createAdmission({ now, ipLimit: perUserLimit, pairLimit: perUserLimit, maxConcurrent, globalLimit, maxKeys });
  const activeUsers = new Set();
  return {
    enter(userId) {
      if (activeUsers.has(userId)) return null;
      const release = admission.enter({ ip: userId, kind: 'ai' });
      if (!release) return null;
      activeUsers.add(userId);
      let released = false;
      return () => { if (!released) { released = true; activeUsers.delete(userId); release(); } };
    },
  };
}
