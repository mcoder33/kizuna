// Telegram photo captions have a 1024 UTF-16 limit. Longer reports retain their
// complete text and bold entities in a regular message, followed by a quiet photo.
export async function sendTelegramReport({ chatId, text, entities, image, sendText, sendPhoto, refreshMessage = null, stillAllowed = () => true, audit = () => {} }) {
  if (!stillAllowed()) return null;
  if (!image) return sendText(chatId, text, { entities });
  if (text.length <= 1024) {
    try { return await sendPhoto(chatId, image, { caption: text, caption_entities: entities }); }
    catch (error) {
      // Only a definite photo rejection permits a text fallback. Network errors
      // may mean Telegram accepted the photo already, so never blindly resend.
      if (error?.status !== 400 || !stillAllowed()) throw error;
      const fresh = refreshMessage ? refreshMessage() : { text, entities };
      if (!fresh || !stillAllowed()) throw error;
      return sendText(chatId, fresh.text, { entities: fresh.entities });
    }
  }
  const sent = await sendText(chatId, text, { entities });
  if (stillAllowed()) {
    try { await sendPhoto(chatId, image, { disable_notification: true }); }
    catch { try { audit({ event: 'telegram_report_photo_failed' }); } catch {} }
  }
  return sent;
}
