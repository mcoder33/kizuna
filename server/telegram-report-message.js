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

function multipartCaption({ text, entities }) {
  // FormData serializes text fields with CRLF line endings. Telegram reads
  // entity offsets against that serialized caption, not the original LF text.
  const normalize = value => value.replace(/\r\n|\r|\n/g, '\r\n');
  const caption = normalize(text);
  if (caption === text) return { text, entities };
  const boundary = offset => normalize(text.slice(0, offset)).length;
  return { text: caption, entities: entities?.map(entity => {
    const offset = boundary(entity.offset);
    return { ...entity, offset, length: boundary(entity.offset + entity.length) - offset };
  }) };
}

// One pacer is shared by all report recipients. Measure from completion of the
// previous request, including failures, and recheck access after waiting.
export function createTelegramReportPacer({ sleep = sleepFor, clock = () => performance.now() } = {}) {
  let tail = Promise.resolve(), lastFinished = null;
  return (send, stillAllowed = () => true) => {
    const next = tail.then(async () => {
      if (!stillAllowed()) return null;
      if (lastFinished !== null) {
        const remaining = Math.max(0, 1000 - (clock() - lastFinished));
        if (remaining) await sleep(remaining);
      }
      if (!stillAllowed()) return null;
      try { return await send(); }
      finally { lastFinished = clock(); }
    });
    tail = next.catch(() => {});
    return next;
  };
}

// One initial photo request + up to ten retries. Long reports get a quiet photo
// first, then their complete text. Retrying a timeout can duplicate an accepted
// photo: Telegram offers no idempotency key for sendPhoto.
export async function sendTelegramReport({ chatId, text, entities, image, sendText, sendPhoto, refreshMessage = null,
  stillAllowed = () => true, audit = () => {}, sleep = sleepFor, clock, pace = createTelegramReportPacer({ sleep, clock }) }) {
  const fresh = () => {
    if (!stillAllowed()) return null;
    const message = refreshMessage ? refreshMessage() : { text, entities };
    return message && stillAllowed() ? message : null;
  };
  async function sendFreshText(photoHandled = false) {
    try { return await pace(() => {
      const message = fresh();
      return message ? sendText(chatId, message.text, { entities: message.entities }) : null;
    }, stillAllowed); }
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
  if (!image) return sendFreshText();
  let retryDelay = 0;
  for (let retry = 0; retry <= maxPhotoRetries; retry++) {
    let sent, captionFits;
    try {
      sent = await pace(() => {
        const message = fresh();
        if (!message) return null;
        const caption = multipartCaption(message);
        captionFits = caption.text.length <= 1024;
        return sendPhoto(chatId, image, captionFits
          ? { caption: caption.text, caption_entities: caption.entities } : { disable_notification: true });
      }, stillAllowed);
    } catch (error) {
      if (!stillAllowed()) return null;
      if (retry < maxPhotoRetries) {
        retryDelay = Math.max(retryDelay + 1000, rateLimitDelay(error));
        if (!await pause(retryDelay)) return null;
        continue;
      }
      try { audit({ event: 'telegram_report_photo_failed', attempts: retry + 1, retries: retry, ...photoFailure(error) }); } catch {}
      if (!await pause(rateLimitDelay(error))) return null;
      return sendFreshText(true);
    }
    // Text errors must never enter the photo retry loop.
    return !sent || captionFits ? sent : sendFreshText(true);
  }
}
