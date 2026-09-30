// Подзадачи в карточке: дочерние записи-дела под родителем на любой глубине.
// Прогресс считает только конечные шаги, ветки не прибавляются, итоги и
// заметки не входят, чужие ветки не показываются даже числом.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { fakeModelService } from './helpers/fake-model.js';
import { authed } from './helpers/auth.js';
import { createSubtask, openDatabase } from '../server/db.js';

function freshApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-subtasks-'));
  return createApp({ aiService: fakeModelService(), databasePath: path.join(dir, 'test.sqlite') });
}
const deed = async (api, raw) => (await api.post('/api/captures').send({ raw }).expect(201)).body.entry;
const sub = async (api, parentId, title) => (await api.post(`/api/captures/${parentId}/subtasks`).send({ title }).expect(201)).body;
// Дерево уходит плоским списком узлов; для проверок собираем вложенность.
function nest(body) {
  const byId = new Map(body.nodes.map(node => [node.id, { ...node, children: [] }]));
  for (const node of byId.values()) node.children = node.childIds.map(id => byId.get(id));
  return { ...body, children: body.children.map(id => byId.get(id)) };
}
const tree = async (api, id, day = '') => nest((await api.get(`/api/captures/${id}/subtasks${day ? `?day=${day}` : ''}`).expect(200)).body);
const complete = async (api, entryId, done = true) => {
  const { entry } = (await api.get(`/api/captures/${entryId}`).expect(200)).body;
  for (const projection of entry.projections.filter(item => ['task', 'meeting_event'].includes(item.type)))
    await api.post(`/api/projections/${projection.id}/${done ? 'complete' : 'undo-complete'}`).send({}).expect(200);
};

test('подзадача — настоящая запись-дело под родителем, вложенная сколь угодно глубоко', async () => {
  const api = authed(freshApp());
  const coffee = await deed(api, 'Купить кофе для Hub');
  const created = await sub(api, coffee.id, 'Проверить, сколько кофе осталось');
  assert.equal(created.entry.parentId, coffee.id);
  assert.equal(created.entry.interpretation.classification.primaryType, 'task');
  assert.equal(created.entry.projections[0].type, 'task');
  assert.deepEqual(created.entry.interpretation.classification.entities.projects, ['Hub'], 'проекты идут от родителя');
  assert.equal(created.entry.interpretation.classification.entities.schedule?.defaulted, true, 'подзадача получает обычный срок туду по умолчанию');
  assert.equal(created.tree.total, 1);
  assert.equal(created.tree.done, 0);
  assert.equal(created.tree.nodes[0].canComplete, true);

  const kitchen = await sub(api, created.entry.id, 'Проверить запас в шкафу');
  const jar = await sub(api, kitchen.entry.id, 'Открыть банку');
  await sub(api, kitchen.entry.id, 'Посмотреть дату обжарки');
  const tenth = await (async () => { let parent = jar.entry.id; let last = null; for (let level = 0; level < 10; level++) { last = await sub(api, parent, `Шаг ${level}`); parent = last.entry.id; } return last; })();
  assert.equal(tenth.entry.parentId !== coffee.id, true, 'глубина не ограничена');

  // Карточка подзадачи знает свой путь наверх.
  const opened = (await api.get(`/api/captures/${jar.entry.id}`).expect(200)).body.entry;
  assert.deepEqual(opened.ancestors.map(step => step.title), ['Купить кофе для Hub', 'Проверить, сколько кофе осталось', 'Проверить запас в шкафу']);
  assert.equal(opened.parent.id, kitchen.entry.id);

  // Пустой и слишком длинный заголовок не проходят.
  await api.post(`/api/captures/${coffee.id}/subtasks`).send({ title: '   ' }).expect(400);
  await api.post(`/api/captures/${coffee.id}/subtasks`).send({ title: 'х'.repeat(501) }).expect(400);
  await api.post('/api/captures/no-such/subtasks').send({ title: 'шаг' }).expect(404);
});

test('прогресс считает конечные шаги на всех уровнях, ветки — не единицы', async () => {
  const api = authed(freshApp());
  const coffee = await deed(api, 'Купить кофе');
  const stock = await sub(api, coffee.id, 'Проверить, сколько кофе осталось');
  const jarTask = await sub(api, coffee.id, 'Взять с собой банку');
  const kitchen = await sub(api, stock.entry.id, 'Проверить запас в шкафу');
  const open = await sub(api, kitchen.entry.id, 'Открыть банку');
  await sub(api, kitchen.entry.id, 'Посмотреть дату обжарки');
  await sub(api, stock.entry.id, 'Прикинуть, на сколько хватит');

  let snapshot = await tree(api, coffee.id);
  // Листья: открыть банку, дата обжарки, прикинуть, банка — четыре; ветки
  // «сколько осталось» и «в шкафу» не считаются.
  assert.equal(snapshot.total, 4);
  assert.equal(snapshot.done, 0);
  assert.equal(snapshot.children.length, 2, 'в списке — только прямые дети');
  assert.equal(snapshot.children[0].leafTotal, 3);
  assert.equal(snapshot.children[0].children[0].leafTotal, 2);
  assert.deepEqual(snapshot.next, { id: open.entry.id, title: 'Открыть банку' }, '«Дальше» — первый незакрытый лист');

  await complete(api, open.entry.id);
  await complete(api, jarTask.entry.id);
  snapshot = await tree(api, coffee.id);
  assert.equal(snapshot.done, 2);
  assert.equal(snapshot.total, 4);
  assert.equal(snapshot.children[0].leafDone, 1);
  assert.equal(snapshot.children[0].children[0].leafDone, 1);
  assert.equal(snapshot.next.title, 'Посмотреть дату обжарки');

  // Закрытая ветка не закрывает листья, а закрытые листья не закрывают ветку.
  await complete(api, stock.entry.id);
  snapshot = await tree(api, coffee.id);
  assert.equal(snapshot.children[0].done, true);
  assert.equal(snapshot.children[0].leafDone, 1, 'отметка родителя не трогает шаги');
  assert.equal(snapshot.done, 2);
  const parentEntry = (await api.get(`/api/captures/${coffee.id}`).expect(200)).body.entry;
  assert.equal(parentEntry.projections[0].completion.completed, false, 'родитель не закрывается сам');

  // Вернули шаг в работу — счёт откатился.
  await complete(api, open.entry.id, false);
  snapshot = await tree(api, coffee.id);
  assert.equal(snapshot.done, 1);
});

test('итоги, заметки и удалённые ветки в дерево не входят', async () => {
  const app = freshApp();
  const api = authed(app);
  const coffee = await deed(api, 'Купить кофе');
  const stock = await sub(api, coffee.id, 'Проверить, сколько кофе осталось');
  await sub(api, stock.entry.id, 'Открыть банку');
  const jar = await sub(api, coffee.id, 'Взять с собой банку');
  // Итог к делу — запись с тем же родителем (как её кладёт «+ чем кончилось»),
  // но не шаг.
  const outcome = (await api.post('/api/captures').send({ raw: 'Кофе куплен, зерно свежее', primaryType: 'outcome' }).expect(201)).body.entry;
  assert.equal(outcome.interpretation.classification.primaryType, 'task', 'в ветке только туду результат хранится закрытым делом');
  app.database.prepare('UPDATE captures SET parent_capture_id=? WHERE id=?').run(coffee.id, outcome.id);
  app.database.prepare("INSERT INTO capture_jobs(id,capture_id,selected_provider,state,stage,created_at,user_id,origin) VALUES(?,?,'fallback','succeeded','complete',?,?,?)")
    .run(`outcome-${outcome.id}`, outcome.id, new Date().toISOString(), api.user.id, 'outcome');
  // Заметка, отнесённая под дело уточнением типа, — тоже не шаг.
  await api.post(`/api/captures/${jar.entry.id}/corrections`).send({ patch: { primaryType: 'note' } }).expect(200);
  let snapshot = await tree(api, coffee.id);
  assert.equal(snapshot.total, 1, 'только «открыть банку»');
  assert.deepEqual(snapshot.children.map(node => node.title), ['Проверить, сколько кофе осталось']);

  // Удалили ветку — её листья ушли из счёта; вернули — вернулись.
  await api.delete(`/api/captures/${stock.entry.id}`).expect(200);
  snapshot = await tree(api, coffee.id);
  assert.equal(snapshot.total, 0);
  assert.equal(snapshot.children.length, 0);
  await api.post(`/api/captures/${stock.entry.id}/restore`).expect(200);
  snapshot = await tree(api, coffee.id);
  assert.equal(snapshot.total, 1);
});

test('чужая ветка не видна и не считается, править подзадачи может только автор', async () => {
  const app = freshApp();
  const sasha = authed(app, { email: 'sasha@kizuna.test', role: 'admin' });
  const anya = authed(app, { email: 'anya@kizuna.test', role: 'user' });
  const lesha = authed(app, { email: 'lesha@kizuna.test', role: 'user' });
  await sasha.patch('/api/account').send({ name: 'Саша' }).expect(200);
  await anya.patch('/api/account').send({ name: 'Аня' }).expect(200);
  const circle = (await sasha.post('/api/circles').send({ name: 'Хаб' }).expect(201)).body.circle;
  const invite = (await sasha.post(`/api/circles/${circle.id}/invite`).send({}).expect(201)).body;
  await anya.post(`/api/circles/invite/${invite.token}/accept`).send({}).expect(200);

  // Саша отдаёт дело Ане; под ним — два шага: один тоже отдан Ане, другой личный.
  const shared = (await sasha.post('/api/captures').send({ raw: 'Ане — прислать смету по Хабу' }).expect(201)).body.entry;
  const visible = await sub(sasha, shared.id, 'Собрать цифры');
  await sasha.post(`/api/captures/${visible.entry.id}/assign`).send({ assigneeId: anya.user.id, circleId: circle.id }).expect(200);
  const hidden = await sub(sasha, shared.id, 'Согласовать наценку');
  await sub(sasha, hidden.entry.id, 'Позвонить поставщику');

  const mine = await tree(sasha, shared.id);
  assert.equal(mine.total, 2, 'автору видно всё: «собрать цифры» и лист под наценкой');

  const hers = await tree(anya, shared.id);
  assert.equal(hers.total, 1, 'чужая ветка не считается');
  assert.deepEqual(hers.children.map(node => node.title), ['Собрать цифры']);
  assert.equal(JSON.stringify(hers).includes(hidden.entry.id), false, 'идентификатор чужой ветки не утекает');
  assert.equal(JSON.stringify(hers).includes('наценку'), false);
  assert.equal(hers.children[0].mine, false);

  // Посторонний не видит ни дерева, ни существования записи.
  await lesha.get(`/api/captures/${shared.id}/subtasks`).expect(404);
  // Подзадачу к чужому делу не завести — даже видимому.
  await anya.post(`/api/captures/${shared.id}/subtasks`).send({ title: 'моё' }).expect(404);
  await lesha.post(`/api/captures/${shared.id}/subtasks`).send({ title: 'моё' }).expect(404);
  assert.equal((await tree(sasha, shared.id)).total, 2, 'чужие попытки ничего не добавили');
});

test('зацикленные ссылки не вешают обход', async () => {
  const app = freshApp();
  const api = authed(app);
  const a = await deed(api, 'Первое дело');
  const b = await sub(api, a.id, 'Второе дело');
  // Порча данных: родитель указывает на собственного ребёнка.
  app.database.prepare('UPDATE captures SET parent_capture_id=? WHERE id=?').run(b.entry.id, a.id);
  const snapshot = await tree(api, a.id);
  assert.equal(snapshot.total, 1);
  assert.deepEqual(snapshot.children.map(node => node.title), ['Второе дело']);
  const opened = (await api.get(`/api/captures/${b.entry.id}`).expect(200)).body.entry;
  assert.equal(opened.ancestors.length, 1, 'путь наверх обрывается на повторе');
});

test('цепочка в 258 уровней считается до настоящего листа, без потолка глубины', async () => {
  const app = freshApp();
  const api = authed(app);
  const root = await deed(api, 'Корень длинной цепочки');
  // Цепочку кладём прямо в базу: 258 запросов подряд — лишняя минута прогона.
  const ids = [root.id];
  for (let depth = 1; depth <= 258; depth++) {
    ids.push(createSubtask(app.database, { parentId: ids[depth - 1], title: `Уровень ${depth}`, userId: api.user.id }).captureId);
  }
  await complete(api, ids[256]);
  const snapshot = await tree(api, root.id);
  assert.equal(snapshot.total, 1, 'единственный лист — на 258-м уровне');
  assert.equal(snapshot.done, 0, 'закрытая ветка на 256-м уровне — не лист');
  assert.equal(snapshot.next.title, 'Уровень 258');
  assert.equal(snapshot.nodes.length, 258);
  const opened = (await api.get(`/api/captures/${ids[258]}`).expect(200)).body.entry;
  assert.equal(opened.ancestors.length, 258, 'путь наверх тоже без потолка');
  assert.equal(opened.ancestors[0].id, root.id);
});

test('удалённый корень не отдаёт своих подзадач', async () => {
  const api = authed(freshApp());
  const coffee = await deed(api, 'Купить кофе');
  await sub(api, coffee.id, 'Проверить запас');
  await api.delete(`/api/captures/${coffee.id}`).expect(200);
  await api.get(`/api/captures/${coffee.id}/subtasks`).expect(404);
  await api.post(`/api/captures/${coffee.id}/subtasks`).send({ title: 'ещё' }).expect(404);
  await api.post(`/api/captures/${coffee.id}/restore`).expect(200);
  assert.equal((await tree(api, coffee.id)).total, 1);
});

test('повторяющийся шаг закрыт на день, а не всей серией: метрика совпадает с карточкой шага', async () => {
  const api = authed(freshApp());
  const coffee = await deed(api, 'Купить кофе');
  const water = await sub(api, coffee.id, 'Поменять воду в фильтре');
  const today = (await api.get('/api/day').expect(200)).body.date;
  await api.post(`/api/captures/${water.entry.id}/corrections`).send({ patch: { schedule: { date: today, time: null, repeat: { freq: 'daily', interval: 1 } } } }).expect(200);
  let snapshot = await tree(api, coffee.id);
  assert.equal(snapshot.nodes[0].occurrence, today, 'шаг живёт показанным днём серии');
  assert.equal(snapshot.done, 0);
  // Закрыть день — убрать его из серии, как делает кружок в карточке шага.
  const stored = (await api.get(`/api/captures/${water.entry.id}`).expect(200)).body.entry;
  const schedule = stored.interpretation.classification.entities.schedule;
  await api.post(`/api/captures/${water.entry.id}/corrections`).send({ patch: { schedule: { date: schedule.date, time: null, skip: [today] } }, at: Date.now() }).expect(200);
  snapshot = await tree(api, coffee.id);
  assert.equal(snapshot.done, 1, 'сегодняшний повтор закрыт');
  assert.equal(snapshot.nodes[0].closed, false, 'серия жива');
  const tomorrow = new Date(`${today}T12:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const next = tomorrow.toISOString().slice(0, 10);
  assert.equal((await tree(api, coffee.id, next)).done, 0, 'завтрашний день серии открыт');
  const reopened = (await api.get(`/api/captures/${water.entry.id}`).expect(200)).body.entry;
  assert.equal(reopened.projections[0].completion.completed, false, 'проекция серии не закрыта');
});

test('читатель из круга видит шаг, но отметить его может только автор или взявший', async () => {
  const app = freshApp();
  const sasha = authed(app, { email: 'sasha@kizuna.test', role: 'admin' });
  const anya = authed(app, { email: 'anya@kizuna.test', role: 'user' });
  await sasha.patch('/api/account').send({ name: 'Саша' }).expect(200);
  await anya.patch('/api/account').send({ name: 'Аня' }).expect(200);
  const circle = (await sasha.post('/api/circles').send({ name: 'Хаб' }).expect(201)).body.circle;
  const invite = (await sasha.post(`/api/circles/${circle.id}/invite`).send({}).expect(201)).body;
  await anya.post(`/api/circles/invite/${invite.token}/accept`).send({}).expect(200);
  const shared = (await sasha.post('/api/captures').send({ raw: 'Ане — прислать смету по Хабу' }).expect(201)).body.entry;
  const step = await sub(sasha, shared.id, 'Собрать цифры');
  await sasha.post(`/api/captures/${step.entry.id}/assign`).send({ assigneeId: anya.user.id, circleId: circle.id }).expect(200);

  let hers = await tree(anya, shared.id);
  const assigned = hers.nodes.find(node => node.id === step.entry.id);
  assert.equal(assigned.canComplete, false, 'до «беру» шаг только читается');
  assert.equal(assigned.mine, false);
  const assignmentId = (await anya.get('/api/inbox').expect(200)).body.rows.find(row => row.captureId === step.entry.id).id;
  await anya.post(`/api/assignments/${assignmentId}/respond`).send({ take: true }).expect(200);
  hers = await tree(anya, shared.id);
  assert.equal(hers.nodes.find(node => node.id === step.entry.id).canComplete, true, 'взявший отмечает');
  assert.equal((await tree(sasha, shared.id)).nodes.every(node => node.canComplete), true, 'автор отмечает всё своё');
  // Сервер держит то же правило: чужую проекцию читатель не закроет.
  const projection = (await sasha.get(`/api/captures/${shared.id}`).expect(200)).body.entry.projections[0];
  await anya.post(`/api/projections/${projection.id}/complete`).send({}).expect(404);
});

test('еженедельный шаг с уже закрытым ближайшим повтором показан закрытым на этот день', async () => {
  const api = authed(freshApp());
  const coffee = await deed(api, 'Купить кофе');
  const water = await sub(api, coffee.id, 'Поменять воду в фильтре');
  const today = (await api.get('/api/day').expect(200)).body.date;
  const shift = (day, days) => { const at = new Date(`${day}T12:00:00Z`); at.setUTCDate(at.getUTCDate() + days); return at.toISOString().slice(0, 10); };
  const tomorrow = shift(today, 1);
  // Серия по неделям начинается завтра, и завтрашний повтор уже убран.
  await api.post(`/api/captures/${water.entry.id}/corrections`).send({ patch: { schedule: { date: tomorrow, time: null, repeat: { freq: 'weekly', interval: 1 }, skip: [tomorrow] } }, at: Date.now() }).expect(200);
  let snapshot = await tree(api, coffee.id);
  assert.equal(snapshot.nodes[0].occurrence, tomorrow, 'показанный день — ближайший повтор, даже закрытый');
  assert.equal(snapshot.done, 1);
  // Вернули этот день в серию — шаг снова открыт на него, а не на неделю позже.
  await api.post(`/api/captures/${water.entry.id}/corrections`).send({ patch: { schedule: { date: tomorrow, time: null, repeat: { freq: 'weekly', interval: 1 }, skip: [] } }, at: Date.now() }).expect(200);
  snapshot = await tree(api, coffee.id);
  assert.equal(snapshot.nodes[0].occurrence, tomorrow);
  assert.equal(snapshot.done, 0);
});

// Подзадачи в списках: у родителя — счётчик, отдельных строк нет.
const SPLIT_RAW = ['Созванивались по ВойсОпс', '', 'Что решили, 2 вектора', '1. Допинываем бот детектор', '2. Допинываем карусель с генератором фраз'].join('\n');

test('в /api/entries и /api/day подзадач нет, а у родителя есть subtasks {done,total} — тот же счёт, что у дуги в карточке', async () => {
  const api = authed(freshApp());
  const coffee = await deed(api, 'Купить кофе');
  const other = await deed(api, 'Нужно проверить Hub');
  const stock = await sub(api, coffee.id, 'Проверить запас в шкафу');
  const jar = await sub(api, coffee.id, 'Взять с собой банку');
  await sub(api, stock.entry.id, 'Открыть банку');
  await complete(api, jar.entry.id);

  const entries = (await api.get('/api/entries?limit=100').expect(200)).body.entries;
  assert.deepEqual(entries.map(entry => entry.id).sort(), [coffee.id, other.id].sort(), 'в списке только дела');
  const parent = entries.find(entry => entry.id === coffee.id);
  const snapshot = await tree(api, coffee.id);
  assert.deepEqual(parent.subtasks, { done: 1, total: 2 });
  assert.deepEqual(parent.subtasks, { done: snapshot.done, total: snapshot.total }, 'список и карточка считают одинаково');
  assert.equal('subtasks' in entries.find(entry => entry.id === other.id), false, 'у дела без подзадач поля нет');

  const day = (await api.get('/api/day').expect(200)).body;
  const shown = [...day.day, ...day.upcoming, ...day.attention];
  assert.ok(shown.some(entry => entry.id === coffee.id));
  assert.deepEqual(shown.find(entry => entry.id === coffee.id).subtasks, { done: 1, total: 2 });
  for (const hidden of [stock, jar]) assert.equal(shown.some(entry => entry.id === hidden.entry.id), false, 'в дне подзадачи нет');

  // Сама запись подзадачи читается по id: карточка и ссылка её открывают, и она помнит, что подзадача.
  const opened = (await api.get(`/api/captures/${jar.entry.id}`).expect(200)).body.entry;
  assert.equal(opened.subtask, true);
  assert.equal(opened.parentId, coffee.id);
  assert.equal((await api.get(`/api/captures/${coffee.id}`).expect(200)).body.entry.subtask, undefined);
});

test('десяток подзадач не съедает окно последних записей: лимит считается по делам', async () => {
  const api = authed(freshApp());
  const first = await deed(api, 'Первое дело');
  const second = await deed(api, 'Второе дело');
  for (let index = 0; index < 6; index++) await sub(api, first.id, `Шаг ${index}`);
  const page = (await api.get('/api/entries?limit=3').expect(200)).body;
  assert.deepEqual(page.entries.map(entry => entry.id).sort(), [first.id, second.id].sort());
  assert.equal(page.nextCursor, null, 'страница не заполнена подзадачами, листать дальше нечего');
  assert.deepEqual(page.entries.find(entry => entry.id === first.id).subtasks, { done: 0, total: 6 });
});

test('дела, отделённые от пачки, — обычные записи: в списках стоят сами и не считаются подзадачами родителя', async () => {
  const api = authed(freshApp());
  const batch = (await api.post('/api/captures').send({ raw: SPLIT_RAW }).expect(201)).body;
  assert.equal(batch.parts.length, 2);
  const report = (await api.post('/api/captures').send({ raw: ['Сделал ревью по Хабу', '1. Отправить Ане замечания по ревью', '2. Согласовать сроки с командой'].join('\n') }).expect(201)).body;
  assert.equal(report.parts.length, 2);
  const entries = (await api.get('/api/entries?limit=100').expect(200)).body.entries;
  for (const part of [...batch.parts, ...report.parts]) {
    const entry = entries.find(item => item.id === part.id);
    assert.ok(entry, 'отделённое дело в списке');
    assert.equal(entry.subtask, undefined);
    assert.equal(entry.parentId !== null, true, 'ссылка на исходную запись остаётся');
  }
  assert.equal('subtasks' in entries.find(item => item.id === report.entry.id), false, 'у отчёта «сделал X, надо Y» счётчика нет');
  const day = (await api.get('/api/day').expect(200)).body;
  const titles = [...day.day, ...day.upcoming, ...day.attention].map(entry => entry.interpretation.classification.summary);
  assert.ok(titles.includes('Допинываем бот детектор'));
  assert.ok(titles.includes('Отправить Ане замечания по ревью'));
  // А подзадача, заведённая под таким делом, — настоящая подзадача.
  const child = await sub(api, batch.parts[0].id, 'Прогнать тесты');
  assert.equal(child.entry.subtask, true);
  const later = (await api.get('/api/entries?limit=100').expect(200)).body.entries;
  assert.equal(later.some(item => item.id === child.entry.id), false);
  assert.deepEqual(later.find(item => item.id === batch.parts[0].id).subtasks, { done: 0, total: 1 });
});

test('подзадача, отданная Ане и взятая ею, у неё — обычное дело, а у Саши остаётся внутри родителя', async () => {
  const app = freshApp();
  const sasha = authed(app, { email: 'sasha@kizuna.test', role: 'admin' });
  const anya = authed(app, { email: 'anya@kizuna.test', role: 'user' });
  await sasha.patch('/api/account').send({ name: 'Саша' }).expect(200);
  await anya.patch('/api/account').send({ name: 'Аня' }).expect(200);
  const circle = (await sasha.post('/api/circles').send({ name: 'Хаб' }).expect(201)).body.circle;
  const invite = (await sasha.post(`/api/circles/${circle.id}/invite`).send({}).expect(201)).body;
  await anya.post(`/api/circles/invite/${invite.token}/accept`).send({}).expect(200);
  const parent = await deed(sasha, 'Подготовить смету по Хабу');
  const step = await sub(sasha, parent.id, 'Собрать цифры');
  await sasha.post(`/api/captures/${step.entry.id}/assign`).send({ assigneeId: anya.user.id, circleId: circle.id }).expect(200);
  const assignmentId = (await anya.get('/api/inbox').expect(200)).body.rows.find(row => row.captureId === step.entry.id).id;
  await anya.post(`/api/assignments/${assignmentId}/respond`).send({ take: true }).expect(200);

  // У Ани взятое дело стоит на доске и в дне — у неё родителя нет.
  const hers = (await anya.get('/api/board').expect(200)).body;
  const card = hers.columns.flatMap(column => column.cards).find(item => item.captureId === step.entry.id);
  assert.ok(card, 'взятая подзадача — карточка доски');
  assert.equal('subtasks' in card, false);
  assert.deepEqual((await anya.get('/api/day').expect(200)).body.borrowed.map(item => item.id), [step.entry.id]);
  // У Саши она спрятана, а родитель считает её.
  const mine = (await sasha.get('/api/board').expect(200)).body;
  assert.deepEqual(mine.columns.flatMap(column => column.cards).map(item => item.captureId), [parent.id]);
  const counter = mine.columns[0].cards[0].subtasks;
  assert.deepEqual({ done: counter.done, total: counter.total }, { done: 0, total: 1 });
  // Карта подзадач на доске называет её строкой: кружок у Саши — его собственный.
  assert.deepEqual(counter.items, [{ id: step.entry.id, title: 'Собрать цифры', done: false }]);
});

test('подзадачи, заведённые до признака, помечаются при переходе базы — по журналу событий, а дела пачки остаются обычными', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagent-subtasks-'));
  const file = path.join(dir, 'test.sqlite');
  const app = createApp({ aiService: fakeModelService(), databasePath: file });
  const api = authed(app);
  const coffee = await deed(api, 'Купить кофе');
  const step = await sub(api, coffee.id, 'Взять банку');
  const deeper = await sub(api, step.entry.id, 'Открыть банку');
  await api.post('/api/captures').send({ raw: SPLIT_RAW }).expect(201);
  assert.deepEqual(app.database.prepare('SELECT id FROM captures WHERE subtask=1 ORDER BY created_at').all().map(row => row.id), [step.entry.id, deeper.entry.id]);
  // База «до признака»: колонки нет, подзадачи помнит только журнал событий.
  app.database.exec('DROP INDEX captures_subtask; ALTER TABLE captures DROP COLUMN subtask');
  assert.equal(app.database.prepare('PRAGMA table_info(captures)').all().some(column => column.name === 'subtask'), false);
  const reopened = openDatabase(file);
  assert.deepEqual(reopened.prepare('SELECT id FROM captures WHERE subtask=1 ORDER BY created_at').all().map(row => row.id), [step.entry.id, deeper.entry.id]);
  assert.equal(reopened.prepare('SELECT COUNT(*) n FROM captures WHERE parent_capture_id IS NOT NULL AND subtask=0').get().n, 2, 'два дела из пачки остались обычными');
  assert.ok(reopened.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='captures_subtask'").get(), 'индекс подзадач вернулся');
  // Повторное открытие признак не трогает.
  reopened.prepare('UPDATE captures SET subtask=0 WHERE id=?').run(deeper.entry.id);
  assert.deepEqual(openDatabase(file).prepare('SELECT id FROM captures WHERE subtask=1').all().map(row => row.id), [step.entry.id], 'миграция не повторяется');
  reopened.close();
});
