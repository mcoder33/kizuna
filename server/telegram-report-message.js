import { setTimeout as sleepFor } from 'node:timers/promises';

const maxPhotoRetries = 10;
const networkCodes = new Set(['request_timeout', 'response_too_large', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']);

function photoFailure(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : null;
  const errorCode = status ? String(status) : networkCodes.has(error?.code) ? error.code : 'network';
  // Only Telegram responses supply diagnostic text. Fetch errors can contain
  // credentials or request data; record their code instead of their message.
  const reason = status ? String(error.message || `Telegram HTTP ${status}`)
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\b\d{5,}:[A-Za-z0-9_-]+\b/g, '[token]')
    .replace(/\b(?:bearer\s+|(?:token|api[_-]?key|password|secret)\s*[=:]\s*)\S+/gi, '[credential]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[key]')
    .replace(/[\r\n\t]+/g, ' ').slice(0, 300) : errorCode;
  return { errorCode, reason };
}

function rateLimitDelay(error) {
  if (error?.status !== 429) return 0;
  const seconds = Number(error.retryAfter);
  return Number.isFinite(seconds) && seconds > 0 ? Math.max(1000, Math.ceil(seconds * 1000)) : 1000;
}

// One initial photo request + up to ten retries. Long reports get a quiet photo
// first, then their complete text. Retrying a timeout can duplicate an accepted
// photo: Telegram offers no idempotency key for sendPhoto.
export async function sendTelegramReport({ chatId, text, entities, image, sendText, sendPhoto, refreshMessage = null,
  stillAllowed = () => true, audit = () => {}, sleep = sleepFor }) {
  const fresh = () => {
    if (!stillAllowed()) return null;
    const message = refreshMessage ? refreshMessage() : { text, entities };
    return message && stillAllowed() ? message : null;
  };
  async function sendFreshText(photoHandled = false) {
    const message = fresh();
    if (!message) return null;
    try { return await sendText(chatId, message.text, { entities: message.entities }); }
    catch (error) { if (photoHandled) error.reportPhotoHandled = true; throw error; }
  }
  async function pause(ms) {
    // Recheck access/schedule during long retry_after waits as well as at send.
    while (ms > 0) {
      if (!stillAllowed()) return false;
      const chunk = Math.min(ms, 1000);
      await sleep(chunk);
      ms -= chunk;
    }
    return stillAllowed();
  }
  if (!image) return stillAllowed() ? sendText(chatId, text, { entities }) : null;
  for (let retry = 0; retry <= maxPhotoRetries; retry++) {
    const message = fresh();
    if (!message) return null;
    const captionFits = message.text.length <= 1024;
    let sent;
    try {
      sent = await sendPhoto(chatId, image, captionFits
        ? { caption: message.text, caption_entities: message.entities } : { disable_notification: true });
    } catch (error) {
      if (!stillAllowed()) return null;
      if (retry < maxPhotoRetries) {
        if (!await pause(Math.max(Math.min(1000 * 2 ** retry, 10000), rateLimitDelay(error)))) return null;
        continue;
      }
      try { audit({ event: 'telegram_report_photo_failed', attempts: retry + 1, retries: retry, ...photoFailure(error) }); } catch {}
      if (!await pause(rateLimitDelay(error))) return null;
      return sendFreshText(true);
    }
    // Text errors must never enter the photo retry loop.
    return captionFits ? sent : sendFreshText(true);
  }
}
