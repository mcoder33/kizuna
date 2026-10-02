import { t } from "./browser-i18n.js";
// Вход, регистрация и второй фактор. Одна форма на три состояния, потому что
// это один разговор: «кто ты» — «докажи» — «тебя ещё не пустили».
const $ = (selector) => document.querySelector(selector);

const form = $("#auth-form");
const email = $("#auth-email");
const password = $("#auth-password");
const repeat = $("#auth-password-repeat");
const code = $("#auth-code");
const error = $("#auth-error");
const notice = $("#auth-notice");
const submit = $("#auth-submit");

// Второй фактор спрашивается только после того, как пароль подошёл: спросить
// код раньше значило бы подсказать, что такой адрес существует.
// «Завести учётную запись» с посадочной ведёт сюда же: режим берётся из
// адреса, иначе человек попадал на форму входа и искал, где регистрация.
let mode = new URLSearchParams(location.search).has("join") ? "register" : "login";
let needsCode = false;

function show(element, text) {
  element.textContent = text;
  element.hidden = !text;
}
function clearMessages() {
  show(error, "");
  show(notice, "");
}

function paint() {
  const registering = mode === "register";
  $("#auth-title").textContent = registering ? t("Регистрация") : t("Вход");
  $("#auth-lead").textContent = registering
    ? t("Заведите учётную запись. Доступ откроет администратор — вы получите его, когда он подтвердит заявку.")
    : t("Журнал у каждого свой: записи, отчёты и память видит только их автор.");
  submit.textContent = registering ? t("Отправить заявку") : needsCode ? t("Подтвердить") : t("Войти");
  $("#auth-switch").textContent = registering ? t("Войти") : t("Зарегистрироваться");
  $("#auth-switch-text").textContent = registering ? t("Уже есть доступ?") : t("Нет учётной записи?");
  $("#auth-repeat-field").hidden = !registering;
  $("#auth-code-field").hidden = registering || !needsCode;
  password.autocomplete = registering ? "new-password" : "current-password";
  password.placeholder = registering ? t("не короче 10 знаков") : "";
  if (needsCode && !registering) code.focus();
}

async function send(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, payload };
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessages();
  const address = email.value.trim();
  if (!address || !password.value) return show(error, t("Заполните почту и пароль."));
  if (mode === "register" && password.value !== repeat.value)
    return show(error, t("Пароли не совпадают."));

  submit.disabled = true;
  try {
    if (mode === "register") {
      const { ok, payload } = await send("/api/auth/register", {
        email: address,
        password: password.value,
      });
      if (!ok) return show(error, payload.error?.message || t("Не получилось зарегистрироваться."));
      // Первый — сразу внутрь: он и есть администратор, подтверждать его некому.
      if (payload.first) return location.replace("/");
      mode = "login";
      needsCode = false;
      password.value = "";
      repeat.value = "";
      paint();
      return show(notice, payload.message || t("Заявка отправлена. Доступ откроет администратор."));
    }

    const { ok, status, payload } = await send("/api/auth/login", {
      email: address,
      password: password.value,
      code: code.value.trim() || undefined,
    });
    if (ok) return location.replace("/");
    if (payload.error?.code === "totp_required") {
      needsCode = true;
      paint();
      return show(notice, t("Введите код из приложения-аутентификатора."));
    }
    if (payload.error?.code === "invalid_totp") {
      needsCode = true;
      paint();
      code.select();
      return show(error, payload.error.message);
    }
    // Ожидание подтверждения и блокировка — это не ошибка ввода, а состояние
    // учётной записи: повторять пароль бессмысленно, и об этом стоит сказать.
    if (status === 403) return show(notice, payload.error?.message || t("Доступ закрыт."));
    show(error, payload.error?.message || t("Не удалось войти."));
  } catch {
    show(error, t("Сервер не отвечает."));
  } finally {
    submit.disabled = false;
  }
});

$("#auth-switch").addEventListener("click", () => {
  mode = mode === "login" ? "register" : "login";
  needsCode = false;
  code.value = "";
  clearMessages();
  paint();
  email.focus();
});

// Переключатель темы работает и здесь: человек мог ещё ни разу не войти, а
// смотреть на белый экран ночью уже не хочет.
const themeButton = $("#auth-theme");
function paintTheme() {
  themeButton.innerHTML = window.pagentTheme.icon();
  themeButton.title = t("Тема: {value1}", { value1: t(window.pagentTheme.label()) });
  themeButton.setAttribute("aria-label", t("Тема оформления: {value1}", { value1: t(window.pagentTheme.label()) }));
}
themeButton.addEventListener("click", () => {
  window.pagentTheme.set(window.pagentTheme.next());
  paintTheme();
});
paintTheme();

// Уже вошли — незачем показывать форму; ни одной учётной записи нет — сразу
// открываем регистрацию, потому что входить пока некому.
(async () => {
  try {
    const state = await (await fetch("/api/auth/state")).json();
    if (state.authenticated) return location.replace("/");
    if (state.needsBootstrap) {
      mode = "register";
      $("#auth-bootstrap").hidden = false;
    }
  } catch {
    // Состояние не узнали — форма входа всё равно работает.
  }
  paint();
  email.focus();
})();

window.addEventListener("pagent:localechange", () => { paint(); paintTheme(); });
