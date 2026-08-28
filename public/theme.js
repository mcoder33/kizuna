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
    icon: function (theme) {
      return { system: "◐", light: "☀", dark: "☾" }[theme || this.read()];
    },
  };
})();
