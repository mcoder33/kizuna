// Тема оформления. Файл подключается в <head> обычным скриптом и выполняется
// до первой отрисовки: без этого тёмная страница успевала бы мигнуть белым.
// Значение живёт и в браузере, и в настройках человека — в браузере, чтобы
// применяться мгновенно, в настройках, чтобы переезжать вместе с ним.
(function () {
  var KEY = "pagent.theme";
  var root = document.documentElement;

  function apply(theme) {
    // «Системная» — это отсутствие выбора, поэтому атрибут снимается: дальше
    // решает prefers-color-scheme, как и задумано в таблице стилей.
    if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
    else root.removeAttribute("data-theme");
  }

  var stored = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    // Приватное окно или запрет на хранилище: тема просто останется системной.
  }
  apply(stored);

  // Один и тот же переключатель нужен и приложению, и странице входа, поэтому
  // он живёт здесь, а не в каждом из них.
  window.pagentTheme = {
    read: function () {
      return stored === "light" || stored === "dark" ? stored : "system";
    },
    set: function (theme) {
      stored = theme;
      apply(theme);
      try {
        if (theme === "system") localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, theme);
      } catch {
        // Не сохранилось — тема действует до конца сессии.
      }
      window.dispatchEvent(new CustomEvent("pagent-theme", { detail: { theme } }));
    },
    // Порядок обхода по кнопке: системная → светлая → тёмная → системная.
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
