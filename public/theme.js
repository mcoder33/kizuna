// Тема оформления. Файл подключается в <head> обычным скриптом и выполняется
// до первой отрисовки: без этого тёмная страница успевала бы мигнуть белым.
// Значение живёт и в браузере, и в настройках человека — в браузере, чтобы
// применяться мгновенно, в настройках, чтобы переезжать вместе с ним.
(function () {
  function readPreference(key) {
    if (window.pagentPreferenceStorage) return window.pagentPreferenceStorage.getItem(key);
    var account = document.documentElement.dataset.accountId;
    if (account) {
      var queued = null;
      try { queued = JSON.parse(localStorage.getItem("kizuna-ui-preferences:" + account + ":" + key) || "null"); } catch {}
      if (queued && typeof queued.token === "string") return queued.value;
      var seed = JSON.parse(decodeURIComponent(document.documentElement.dataset.uiPreferences || "{}"));
      if (seed.userId === account && Object.prototype.hasOwnProperty.call(seed.values || {}, key)) return seed.values[key];
      // Unowned legacy choices migrate on this first opening; an already
      // claimed browser must not flash another account's old theme or font.
      try { if (localStorage.getItem("kizuna-ui-preferences-legacy-owner")) return null; } catch { return null; }
    }
    return localStorage.getItem(key);
  }
  var KEY = "pagent.theme";
  var root = document.documentElement;

  function apply(theme) {
    // Без атрибута таблица стилей следует prefers-color-scheme.
    if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
    else root.removeAttribute("data-theme");
  }

  var stored = null;
  try {
    stored = readPreference(KEY);
  } catch {
    // Приватное окно или запрет на хранилище: следуем теме устройства.
  }
  apply(stored);
  // Account entitlement is server supplied; saved choices never opt other users in.
  var appearance = "classic";
  try { if (root.dataset.workshopEnabled === "true" && readPreference("kizuna-appearance") === "workshop") appearance = "workshop"; } catch {}
  root.dataset.appearance = appearance;

  // Шрифт и размер текста записей — как в Notion: выбор страницы, а не куска
  // текста. Живут рядом с темой и применяются так же рано, до отрисовки.
  var TEXT_KEY = "pagent.text";
  var text = { font: "default", size: "normal" };
  try {
    var saved = JSON.parse(readPreference(TEXT_KEY) || "null");
    if (saved && typeof saved === "object") text = { font: saved.font || "default", size: saved.size || "normal" };
  } catch {
    // Нет сохранённого выбора — обычный шрифт и размер.
  }
  function applyText() {
    if (text.font === "serif" || text.font === "mono") root.setAttribute("data-font", text.font);
    else root.removeAttribute("data-font");
    if (text.size === "small") root.setAttribute("data-text", "small");
    else root.removeAttribute("data-text");
  }
  applyText();
  window.pagentText = {
    read: function () { return { font: text.font, size: text.size }; },
    refresh: function () {
      try { text = JSON.parse(readPreference(TEXT_KEY)) || { font: "default", size: "normal" }; } catch { text = { font: "default", size: "normal" }; }
      applyText();
    },
    set: function (next) {
      text = { font: next.font || text.font, size: next.size || text.size };
      applyText();
      try { (window.pagentPreferenceStorage || localStorage).setItem(TEXT_KEY, JSON.stringify(text)); } catch {
        // Не сохранилось — выбор действует до конца сессии.
      }
    },
  };

  // Один и тот же переключатель нужен и приложению, и странице входа, поэтому
  // он живёт здесь, а не в каждом из них.
  window.pagentTheme = {
    refresh: function () {
      try { stored = readPreference(KEY); } catch { stored = null; }
      apply(stored);
    },
    read: function () {
      return stored === "light" || stored === "dark" ? stored : "system";
    },
    hasChoice: function () { return ["system", "light", "dark"].includes(stored); },
    set: function (theme) {
      stored = theme === "light" || theme === "dark" ? theme : "system";
      apply(stored);
      try {
        (window.pagentPreferenceStorage || localStorage).setItem(KEY, stored);
      } catch {
        // Не сохранилось — тема действует до конца сессии.
      }
      window.dispatchEvent(new CustomEvent("pagent-theme", { detail: { theme: stored } }));
    },
    // Авто → светлая → тёмная → авто. Авто сохраняется явно, чтобы
    // синхронизироваться между устройствами как любой другой выбор.
    next: function () {
      var order = ["system", "light", "dark"];
      return order[(order.indexOf(this.read()) + 1) % order.length];
    },
    label: function (theme) {
      return { system: "как в системе", light: "светлая", dark: "тёмная" }[theme || this.read()];
    },
    // Значок — инлайновый SVG, а не символ шрифта: глифы вроде «◐» и «☀»
    // в каждом шрифте сидят по-своему и в круглой кнопке стояли криво.
    // Геометрия SVG центрируется точно и везде одинакова.
    icon: function (theme) {
      var head = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">';
      return {
        system:
          head +
          '<circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
          '<path d="M12 3.6a8.4 8.4 0 0 1 0 16.8z" fill="currentColor" stroke="none"/></svg>',
        light:
          head +
          '<circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
          '<path d="M12 2.4v2.2M12 19.4v2.2M2.4 12h2.2M19.4 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
        dark:
          head +
          '<path d="M20.4 13.6A8.5 8.5 0 1 1 10.4 3.6a6.9 6.9 0 0 0 10 10z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
      }[theme || this.read()];
    },
  };
})();
