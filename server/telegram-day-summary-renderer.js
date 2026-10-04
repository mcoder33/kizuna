const morningTitles = [
  '☀️ Новый день — в своём темпе',
  '☀️ Доброе утро. Начнём потихоньку',
  '☀️ Утро и немного места для планов',
  '☀️ У нового дня своя история',
  '☀️ Начнём с одного небольшого шага',
  '☀️ Доброе утро. Посмотрим на день',
  '☀️ Новый день, новая страница',
  '☀️ Пусть утро начнётся спокойно',
];
const eveningTitles = [
  '🌙 День потихоньку складывается в историю',
  '🌙 Соберём день в несколько строк',
  '🌙 Вечерняя записка о твоём дне',
  '🌙 У каждого дня свой след',
  '🌙 Немного о том, что было сегодня',
  '🌙 День подходит к концу',
  '🌙 Сохраним несколько строк о дне',
  '🌙 Можно спокойно оглянуться на день',
];
const morningClosings = [
  'Хорошего утра. Пусть найдётся время и для дел, и для себя ☕',
  'Можно начать с малого и оставить немного воздуха между делами 🌱',
  'Пусть день идёт в удобном для тебя темпе ☕',
  'Хорошего дня. Не забудь оставить немного времени для себя 🌿',
  'Один небольшой шаг — уже начало. Хорошего утра ☀️',
  'Пусть в планах останется место и для приятного ☕',
  'Можно выбрать одно дело и начать с него. Остальное — по ходу дня 🌱',
  'Хорошего утра. Береги свои силы и свой темп 🌿',
  'Пусть сегодня будет место для дел, пауз и маленьких радостей ☕',
];
const eveningClosings = [
  'Хорошего вечера. Можно немного выдохнуть ☕',
  'Пусть у вечера останется немного времени для тебя 🌙',
  'На сегодня сохраним эту страницу. Хорошего вечера ☕',
  'Можно ненадолго отложить список и переключиться на себя 🌿',
  'Пусть остаток вечера пройдёт спокойно 🌙',
  'Хорошего вечера. Найдётся место и для небольшой паузы ☕',
  'Сохраним итоги и оставим немного места для отдыха 🌿',
  'День за днём складывается история. Хорошего вечера 🌙',
  'Можно сделать паузу. Пусть вечер будет уютным ☕',
];
const progress = [
  'Ещё один шаг вперёд 🌱',
  'Этот шаг уже можно отметить в истории дня 🌿',
  'В списке появилась ещё одна зелёная галочка 🌱',
  'Потихоньку дела переходят в историю 🌿',
];
const morningIntros = [
  'Сегодня можно продолжить начатое 🌱',
  'Вот дела, к которым можно вернуться сегодня 🌿',
  'Посмотрим, что ждёт внимания. Начать можно с одного дела 🌱',
  'Планы под рукой — можно выбрать, с чего начать 🌿',
  'Пусть этот список поможет спокойно войти в день 🌱',
  'Соберём ориентиры на день в одном месте 🌿',
];
const emptyIntros = [
  'На этот день пока нет записанных дел и встреч. Оставим эту страницу свободной 🌿',
  'В списке на этот день пока свободно. Здесь есть место для новых планов 🌱',
  'На этой странице пока нет дел и встреч. Можно заполнить её по ходу дня 🌿',
];

// Date-based rotation keeps retries and repeated views stable, while consecutive
// days get different copy. Only the source review supplies titles and statuses.
const copyFor = (choices, day) => choices[((day % choices.length) + choices.length) % choices.length];
const countOf = (review, key) => review.counts?.[key] ?? review[key]?.length ?? 0;

export function truncateTelegramText(value, max) {
  const text = String(value || '');
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return text.slice(0, end) + '…';
}

export function renderDaySummaryMessage(review) {
  const morning = review.phase === 'morning', evening = review.phase === 'evening';
  const day = Math.floor(Date.parse(`${review.date}T00:00:00Z`) / 86400000);
  const formatted = new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' })
    .format(new Date(`${review.date}T12:00:00Z`)).replace(/\s*г\.$/u, '');
  const zone = review.timeZone === 'Europe/Samara' ? 'Самара' : review.timeZone;
  let text = '';
  const entities = [], blocks = [];
  function line(value, { id, paragraph = false, bold = false } = {}) {
    const start = text.length;
    if (text) text += paragraph ? '\n\n' : '\n';
    const offset = text.length;
    text += value;
    if (bold) entities.push({ type: 'bold', offset, length: value.length });
    blocks.push({ id, offset: start, length: text.length - start });
    return offset;
  }
  line(morning ? copyFor(morningTitles, day) : evening ? copyFor(eveningTitles, day) : '📅 Обзор твоего дня', { id: 'title', bold: true });
  line(`${formatted} · ${truncateTelegramText(zone, 80)}`, { id: 'date' });

  const selected = morning
    ? [['meetings', '🗓 Встречи'], ['remaining', 'Что остаётся в работе'], ['overdue', '⏰ Требуют внимания — просрочены'], ['done', 'Уже завершено']]
    : [['done', evening ? 'Сегодня завершено' : 'Завершено за этот день'], ['remaining', 'Что остаётся в работе'], ['overdue', '⏰ Требуют внимания — просрочены'], ['meetings', '🗓 Встречи']];
  if (evening) selected.push(['added', '➕ Добавлено за день']);
  const populated = selected.some(([key]) => countOf(review, key) > 0);
  if (!populated) line(copyFor(emptyIntros, day), { id: 'intro', paragraph: true });
  else if (morning) {
    const hasWork = countOf(review, 'remaining') + countOf(review, 'overdue') > 0;
    line(hasWork ? copyFor(morningIntros, day) : countOf(review, 'meetings') > 0
      ? 'Вот встречи на этот день. Пусть между ними найдётся время для себя 🌿'
      : 'В этом дне уже есть завершённые дела 🌱', { id: 'intro', paragraph: true });
  }

  for (const [key, label] of selected) {
    const count = countOf(review, key);
    if (count <= 0) continue;
    line(count > 1 ? `${label} · ${count}` : `${label}:`, { id: `${key}:heading`, paragraph: true, bold: true });
    for (const [index, item] of (review[key] || []).entries()) {
      const when = item.allDay ? 'весь день' : `${item.time || 'без времени'}${item.end ? `–${item.end}` : ''}`;
      const prefix = key === 'meetings' ? `🗓 ${truncateTelegramText(when, 40)} · `
        : key === 'done' || (key === 'added' && item.completed === true) ? '✅ ' : '⬜ ';
      const title = truncateTelegramText(String(item.title || 'Без названия').replace(/[\r\n]+/g, ' '), 360);
      const offset = line(prefix + title, { id: `${key}:item:${item.id ?? index}` }) + prefix.length;
      entities.push({ type: 'bold', offset, length: title.length });
    }
    if (key === 'done' && evening) line(copyFor(progress, day), { id: 'progress', paragraph: true });
  }
  if (populated && countOf(review, 'overdue') === 0 && countOf(review, 'done') + countOf(review, 'remaining') > 0)
    line('По доступной истории просроченных дел нет.', { id: 'no-overdue', paragraph: true });
  line(morning ? copyFor(morningClosings, day) : evening ? copyFor(eveningClosings, day)
    : 'Пусть найдётся время и для дел, и для себя ☕', { id: 'closing', paragraph: true });

  return { text, entities, blocks };
}

export const renderDaySummary = review => renderDaySummaryMessage(review).text;
