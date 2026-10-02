// Links displayed to people are HTTP(S) only, including old cached calendar records.
export function safeExternalUrl(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || /[\u0000-\u0020\u007f]/.test(text)) return null;
  try {
    const url = new URL(text);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
