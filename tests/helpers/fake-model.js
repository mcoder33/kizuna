import { normalizeClassification, applyExplicitType, toTodo } from '../../server/classifier.js';

// Детерминированный фейковый провайдер для тестов. В продакшне разбор делает
// только модель, поэтому правила разбора русского текста живут здесь, а не в
// server/: тестам нужен предсказуемый «разум», а не сетевой вызов.
const projectsKnown = ['Hub', 'TCAM', 'Монетизация', 'CP'];
const projectAliases = new Map([['хаб', 'Hub']]);
const weekdays = { понедельник:1, понедельника:1, вторник:2, вторника:2, среда:3, среду:3, среды:3, четверг:4, четверга:4, пятница:5, пятницу:5, пятницы:5, суббота:6, субботу:6, субботы:6, воскресенье:0, воскресенья:0 };
const dateWords = /(сегодня|вчера|позавчера|завтра|послезавтра|понедельник(?:а)?|вторник(?:а)?|сред(?:а|у|ы)|четверг(?:а)?|пятниц(?:а|у|ы)|суббот(?:а|у|ы)|воскресень(?:е|я))/gi;
const numericDate = /\b\d{1,2}[.\-/]\d{1,2}(?:[.\-/]\d{2,4})?\b/g;
const listNumeration = /^\s*\d{1,2}[.)](?=\s)/gm;
const explicitTime = /\b(\d{1,2}):(\d{2})\b/g;
const prepositionTime = /(?:^|[\s,(])[вВ]\s+(\d{1,2})(?::(\d{2}))?(?=[\s,.;:!?)]|$)/g;
const completedVerbs = /(?:^|[^\p{L}])(?:поговорил(?:и|а)?|созвонил(?:ся|ась|ись)|обсудил(?:и|а)?|сделал(?:и|а)?|сделано|готово|доработал(?:и|а)?|завершил(?:и|а)?|выполнил(?:и|а)?|закрыл(?:и|а)?|пров(?:ёл|ела|ели)|дорабатывал(?:и|а)?|прогонял(?:и|а)?|обсуждал(?:и|а)?|работал(?:и|а)?|разбирал(?:ся|ась|ись)|занимал(?:ся|ась|ись))(?=$|[^\p{L}])/giu;

const plain = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
function todayIn(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(now);
  const get = type => Number(parts.find(part => part.type === type).value);
  return new Date(get('year'), get('month') - 1, get('day'));
}
const addDays = (date, count) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + count);
const nextWeekday = (date, target) => addDays(date, (target - date.getDay() + 7) % 7 || 7);
const previousWeekday = (date, target) => addDays(date, -((date.getDay() - target + 7) % 7 || 7));

// Повтор: «каждый день», «раз в две недели», «каждый понедельник», «по
// пятницам», с «до <дата>». Совпавшие слова снимаются с текста, чтобы «до
// 31.12» не стало вторым сроком, а «понедельник» — разовой датой.
const repeatPattern = /(?<daily>каждый день|ежедневно)|(?<biweekly>раз в две недели|каждые (?:две|2) недели)|(?<weekly>каждую неделю|еженедельно)|(?<monthly>каждый месяц|ежемесячно)|(?<yearly>каждый год|ежегодно)|каждый\s+(?<wd1>понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)|по\s+(?<wd2>понедельникам|вторникам|средам|четвергам|пятницам|субботам|воскресеньям)/i;
const weekdayPlural = { понедельникам:1, вторникам:2, средам:3, четвергам:4, пятницам:5, субботам:6, воскресеньям:0 };
function repeatOf(text, base) {
  const match = text.match(repeatPattern);
  if (!match) return null;
  const g = match.groups;
  const untilMatch = text.match(/(?:^|\s)до\s+(\d{1,2}[.\-/]\d{1,2}(?:[.\-/]\d{2,4})?)/i);
  const untilDate = untilMatch ? resolveToken(untilMatch[1], base) : null;
  let rule, anchor = null;
  if (g.daily) rule = { freq: 'daily', interval: 1 };
  else if (g.biweekly) rule = { freq: 'weekly', interval: 2 };
  else if (g.weekly) rule = { freq: 'weekly', interval: 1 };
  else if (g.monthly) rule = { freq: 'monthly', interval: 1 };
  else if (g.yearly) rule = { freq: 'yearly', interval: 1 };
  else { rule = { freq: 'weekly', interval: 1 }; anchor = nextWeekday(base, g.wd1 ? weekdays[g.wd1.toLowerCase()] : weekdayPlural[g.wd2.toLowerCase()]); }
  let stripped = text.replace(match[0], ' ');
  if (untilMatch) stripped = stripped.replace(untilMatch[0], ' ');
  return { rule: { ...rule, until: untilDate ? plain(untilDate) : null }, anchor, stripped };
}

function resolveToken(token, base) {
  if (token === 'сегодня') return base;
  if (token === 'завтра') return addDays(base, 1);
  if (token === 'послезавтра') return addDays(base, 2);
  if (weekdays[token] !== undefined) return nextWeekday(base, weekdays[token]);
  const parts = token.split(/[.\-/]/).map(Number);
  if (parts.length < 2 || !parts[0] || !parts[1] || parts[0] > 31 || parts[1] > 12) return null;
  return new Date(parts[2] ? (parts[2] < 100 ? 2000 + parts[2] : parts[2]) : base.getFullYear(), parts[1] - 1, parts[0]);
}

// День сделанного: «вчера», «в пятницу», «поставь на пятницу» у отчёта — назад
// от сегодняшней даты, как и велит промпт настоящей модели.
function resolvePast(token, base) {
  if (token === 'сегодня') return base;
  if (token === 'вчера') return addDays(base, -1);
  if (token === 'позавчера') return addDays(base, -2);
  if (weekdays[token] !== undefined) return previousWeekday(base, weekdays[token]);
  return null;
}

function mentions(lower, name, wholeWord = true) {
  return new RegExp(`(?:^|[^a-zа-яё0-9])${name.toLowerCase()}${wholeWord ? '(?=$|[^a-zа-яё0-9])' : ''}`, 'u').test(lower);
}

function people(text) {
  const acronyms = new Map([['be','BE'],['бе','БЕ']]);
  const normalizations = new Map([['илья','Илья'],['ильёй','Илья'],['даниилом','Даниил'],['худояровым','Худояров']]);
  const ignored = new Set(['в','во','на','по','после','для','от']);
  const found = [];
  // «Ане — прислать смету»: кому дело, названо первым словом и тире. Модель
  // достаёт такого человека сама, и разбор без него не узнал бы исполнителя.
  // «@» перед именем настоящая модель тоже не считает частью имени.
  const addressed = text.match(/^\s*@?([А-ЯЁ][а-яё-]{1,30})\s*[—–-]\s+/u);
  if (addressed) found.push(addressed[1]);
  for (const match of text.matchAll(/(?:^|[\s,])(?:с|со|для|от)\s+([А-ЯЁ][а-яё-]{1,30}|[A-ZА-ЯЁ]{2,10})(?=$|[\s,.:;])/g)) {
    const candidate = match[1], lower = candidate.toLowerCase();
    if (ignored.has(lower)) continue;
    const person = acronyms.get(lower) || normalizations.get(lower) || (/^[А-ЯЁ][а-яё-]{1,30}$/.test(candidate) ? candidate : null);
    if (person && !found.includes(person)) found.push(person);
  }
  return found.slice(0, 5);
}

function completedState(text) {
  if (/^\s*[«"][\s\S]*[»"]\s*$/.test(text)) return null;
  let negated = false;
  for (const match of text.matchAll(completedVerbs)) {
    const before = text.slice(0, match.index).trimEnd();
    if (!/(?:^|[.!?…:;]\s*|\s)(?:не|ничего\s+не)\s*$/iu.test(before)) return 'affirmative';
    negated = true;
  }
  return negated ? 'negated' : null;
}

// Возвращает candidate в том же виде, в каком его присылает настоящая модель.
export function fakeModelCandidate(raw, now = new Date(), timeZone = 'Europe/Samara') {
  const text = String(raw).trim(), lower = text.toLowerCase();
  const base = todayIn(now, timeZone), cleaned = text.replace(listNumeration, ' ');
  const projects = projectsKnown.filter(project => mentions(lower, project));
  for (const [stem, name] of projectAliases) if (mentions(lower, stem, false) && !projects.includes(name)) projects.push(name);

  const completed = completedState(text) === 'affirmative';
  const meeting = /созвон|встреч|колл|митинг|обсудим/i.test(text);
  const outcome = /решили|решение|готово|сделал|сделано|завершил|договорились/i.test(text);
  // «Ане — прислать смету»: обращение к человеку и глагол в неопределённой
  // форме — это дело, даже если слова «нужно» в записи нет.
  const addressedTask = /^\s*[А-ЯЁ][а-яё-]{1,30}\s*[—–-]\s+\p{L}+(?:ть|ти|чь)(?=$|\s|,|\.)/u.test(text);
  const task = addressedTask || /(?:^|\s)(надо|нужно|сделать|проверить|отправить|подготовить|напомни)(?=$|\s|,|\.)/i.test(text);
  // Типов у записей нет: срок ищется в любой записи, как это делает модель.
  const scheduleRelevant = !completed;

  // Повтор снимается с текста до разбора дат: иначе «до 31.12» стало бы
  // вторым сроком, а «понедельник» из «каждый понедельник» — разовой датой.
  const repeat = scheduleRelevant ? repeatOf(cleaned, base) : null;
  const dateSource = repeat ? repeat.stripped : cleaned;
  const dates = [];
  const tokens = [...dateSource.matchAll(dateWords)].map(match => match[0].toLowerCase())
    .concat(scheduleRelevant ? [...dateSource.matchAll(numericDate)].map(match => match[0]) : []);
  for (const token of tokens) { const resolved = resolveToken(token, base); if (resolved) dates.push(plain(resolved)); }
  const uniqueDates = [...new Set(dates)];

  const timeText = cleaned.replace(numericDate, ' '), times = new Set();
  for (const match of [...timeText.matchAll(explicitTime), ...timeText.matchAll(prepositionTime)]) {
    const hours = Number(match[1]), minutes = match[2] === undefined ? 0 : Number(match[2]);
    if (hours > 23 || minutes > 59) continue;
    times.add(`${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`);
  }

  let ambiguity = null;
  if (scheduleRelevant && (uniqueDates.length > 1 || times.size > 1)) ambiguity = { field:'schedule', question:'Какое из указанных времени верно?' };
  else if (projects.length > 1) ambiguity = { field:'projects', question:'К какому одному проекту отнести запись?' };
  else if (/после обеда/i.test(text) && meeting) ambiguity = { field:'schedule', question:'Во сколько назначить встречу?' };

  const followUpMatch = !completed && outcome && task ? text.match(/(?:надо|нужно)\s+([^.!?]{3,500})/i) : null;
  // У повтора без названной даты первый экземпляр — сегодня (или ближайший
  // названный день недели).
  const anchor = uniqueDates[0] || (repeat ? plain(repeat.anchor || base) : null);
  const doneDay = completed ? [...cleaned.matchAll(dateWords)].map(match => resolvePast(match[0].toLowerCase(), base)).find(Boolean) || null : null;
  const when = completed
    ? (doneDay ? { date: plain(doneDay), time: times.size ? [...times][0] : null } : null)
    : ambiguity?.field === 'schedule' || !scheduleRelevant
      ? null
      : (anchor || times.size ? { date: anchor, time: times.size ? [...times][0] : null, ...(repeat && anchor ? { repeat: repeat.rule } : {}) } : null);

  return {
    entities: { projects, people: people(text), when, followUp: followUpMatch ? followUpMatch[1].trim().slice(0, 500) : null },
    summary: text.slice(0, 500),
    details: '',
    // Нумерованный список в записи — отдельные дела: «что решили: 1. …, 2. …».
    // Настоящая модель выделяет их смыслом, заглушке хватает разметки.
    proposedActions: text.split(/\r?\n/).map(line => line.match(/^\s*\d{1,2}[.)]\s+(.{8,300})$/)).filter(Boolean).map(match => ({ type:'task', title: match[1].trim() })).slice(0, 5),
    completed,
    ambiguity,
  };
}

export function fakeModelClassification(raw, now = new Date(), timeZone = 'Europe/Samara') {
  // Как в server/ai.js: разбор, просьба «как результат», затем туду со сроком по умолчанию.
  return toTodo(applyExplicitType(normalizeClassification(fakeModelCandidate(raw, now, timeZone), raw, now, 'model', timeZone), raw, now, timeZone), now, timeZone);
}

export function fakeModelService({ now = () => new Date(), timeZone = 'Europe/Samara', provider = 'openrouter', model = 'fake/model' } = {}) {
  return {
    async status(selectedProvider) {
      const selected = selectedProvider || provider;
      return {
        mode: selected === 'fallback' ? 'fallback' : selected,
        model, defaultProvider: provider, selectedProvider: selected,
        providers: {
          fallback: { configured:true, available:true },
          openai: { configured:false, available:false },
          openrouter: { configured:true, available:true, model, models:[{ id:model, name:model }] },
          'codex-cli': { configured:false, available:false },
          'claude-cli': { configured:false, available:false },
        },
        capabilities: { text:true, voice:false, calendar:false },
      };
    },
    async classify(raw, selectedProvider) {
      const requested = selectedProvider || provider;
      // Попросили правила — правила и отвечают. Настоящая служба ведёт себя
      // именно так, а заглушка, всегда отвечающая моделью, скрыла бы от тестов
      // случаи, когда модель звать нельзя.
      const used = requested === 'fallback' ? 'fallback' : provider;
      return {
        classification: fakeModelClassification(raw, now(), timeZone),
        provider: used, model: used === 'fallback' ? null : model, requestedProvider: requested, usedProvider: used, fallbackReason: null,
      };
    },
    async answer(query, sources) {
      return {
        answer: sources.length ? `Нашёл запись по запросу «${query}».` : 'В памяти пока нет подходящих записей.',
        citationIds: sources.length ? [sources[0].captureId] : [],
        provider, model, requestedProvider: provider, usedProvider: provider, fallbackReason: null,
      };
    },
  };
}
