// Сервис-воркер Кизуны: только уведомления. Кэша страниц здесь нет —
// приложение живое, и старая копия из кэша обманывала бы человека.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = { body: event.data?.text() || "" }; }
  const title = payload.title || (payload.locale && !String(payload.locale).startsWith("ru") ? "Kizuna" : "Кизуна");
  const options = {
    body: payload.body || "",
    tag: payload.tag || undefined,
    renotify: Boolean(payload.tag),
    data: { url: payload.url || "/" },
    icon: "/public/icon.svg",
    badge: "/public/icon.svg",
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Клик по уведомлению: открытая вкладка Кизуны получает адрес карточки и
// выходит на передний план; если вкладки нет — открывается новая.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const own = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (own) {
      try { await own.navigate(url); } catch {}
      return own.focus();
    }
    return self.clients.openWindow(url);
  })());
});
