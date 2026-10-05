import { test, expect, setUiPreferences } from './fixtures/ui-preferences.js';

const day = n => new Intl.DateTimeFormat('en-CA', { timeZone:'Europe/Samara', year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date(Date.now()+n*86400000));
const read = async (request,id) => (await (await request.get(`/api/captures/${id}`)).json()).entry;
const schedule = async (request,id) => (await read(request,id)).interpretation.classification.entities.schedule;
async function task(request, raw, due={date:day(0)}) {
  const response=await request.post('/api/captures',{data:{raw,primaryType:'todo',due}});
  expect(response.ok()).toBe(true);
  return (await response.json()).entry;
}
async function openDay(page) {
  await page.goto('/');
  const tab=page.getByRole('tab',{name:/^День/});
  if(await tab.getAttribute('aria-selected')!=='true') await tab.click();
}
test.beforeEach(async ({request})=>{
  expect((await request.post('/api/reset',{data:{confirmation:'СБРОСИТЬ КИЗУНА'}})).ok()).toBe(true);
});

test('01 in the day: move, undo, no duplicate late action, already tomorrow is disabled',async({page,request})=>{
  const entry=await task(request,'Раздать всем карты и подписки',{date:day(-1),time:'11:00'});
  await openDay(page);
  const row=page.locator(`#todo .entry[data-capture-id="${entry.id}"]`);
  await expect(row.locator('.todo-tomorrow')).toHaveText('завтра+1');
  await expect(row.getByRole('button',{name:/Перенести на завтра/})).toHaveCount(1);
  await row.locator('.todo-tomorrow').click();
  await expect.poll(async()=>schedule(request,entry.id)).toMatchObject({date:day(1),time:'11:00'});
  await expect(row).toHaveCount(0);
  await page.locator('#toast .toast-action').click();
  await expect.poll(async()=>schedule(request,entry.id)).toMatchObject({date:day(-1),time:'11:00'});
  await expect(row).toBeVisible();
  await row.locator('.todo-tomorrow').click();
  await expect(row).toHaveCount(0);
  await page.locator('#todo .daynav [data-step="1"]').click();
  await expect(row.locator('.todo-tomorrow')).toBeDisabled();
});

test('card move saves the current note first and undo works inside the dialog',async({page,request})=>{
  const entry=await task(request,'Отремонтировать зеркало');
  await page.goto(`/#today?open=${entry.id}`);
  const dialog=page.locator('#review-dialog');
  await dialog.locator('#card-body-editor').fill('Незавершённый ввод перед переносом');
  await dialog.locator('.card-chips .todo-tomorrow').click();
  await expect(dialog.locator('.card-snack')).toContainText('Перенесено на завтра');
  await expect(dialog.locator('.card-chips .todo-tomorrow')).toBeDisabled();
  expect((await read(request,entry.id)).note.body).toBe('Незавершённый ввод перед переносом');
  await dialog.locator('.card-snack-act').click();
  await expect.poll(async()=>schedule(request,entry.id)).toMatchObject({date:day(0)});
  await expect(dialog.locator('.card-chips .todo-tomorrow')).toBeEnabled();
});

test('board columns, list and search keep the same action',async({page,request})=>{
  const entry=await task(request,'Нужно собрать макет по фильтрам');
  for(const view of ['board','list']) {
    await setUiPreferences(request,{'kizuna-board-view':view,'kizuna-board-filter':'[]'});
    await page.goto('/#board');
    if(view==='list') await page.reload();
    await page.locator('#board-search').fill('макет');
    const row=page.locator(`${view==='board'?'#board-columns .board-card':'#board-flat .board-row'}[data-capture-id="${entry.id}"]`);
    await row.locator('.todo-tomorrow').click();
    await expect.poll(async()=>schedule(request,entry.id)).toMatchObject({date:day(1)});
    await expect(row.locator('.todo-tomorrow')).toBeDisabled();
    await page.locator('#toast .toast-action').click();
    await expect.poll(async()=>schedule(request,entry.id)).toMatchObject({date:day(0)});
  }
});

test('subtask list and map move only the selected child and refresh in place',async({page,request})=>{
  const parent=await task(request,'Нужно допинать карусель с генератором фраз');
  const child=(await (await request.post(`/api/captures/${parent.id}/subtasks`,{data:{title:'Проверить мобильный макет'}})).json()).entry;
  await page.goto(`/#today?open=${parent.id}`);
  const dialog=page.locator('#review-dialog');
  for(const view of ['list','map']) {
    await dialog.locator(`[data-step-view="${view}"]`).click();
    const row=dialog.locator(view==='list'?`[data-task-id="${child.id}"]`:`[data-tree-id="${child.id}"]`);
    await row.locator('.todo-tomorrow').click();
    await expect.poll(async()=>schedule(request,child.id)).toMatchObject({date:day(1)});
    expect((await schedule(request,parent.id)).date).toBe(day(0));
    await expect(row.locator('.todo-tomorrow')).toBeDisabled();
    await dialog.locator('.card-snack-act').click();
    await expect(row.locator('.todo-tomorrow')).toBeEnabled();
  }
});

test('calendar timed and untimed tasks move without opening the card',async({page,request})=>{
  const entries=[await task(request,'Нужно раздать карты',{date:day(0),time:'12:00'}),await task(request,'Нужно проверить подписи')];
  await setUiPreferences(request,{'kizuna-calendar-mode':'day'});
  await page.goto('/#calendar');
  for(const entry of entries) {
    const button=page.locator(`#calendar-view [data-id="${entry.id}"] .todo-tomorrow`).first();
    await button.click();
    await expect.poll(async()=>schedule(request,entry.id)).toMatchObject({date:day(1)});
    await expect(page.locator('#review-dialog')).toBeHidden();
    await page.locator('#toast .toast-action').click();
    await expect(button).toBeVisible();
  }
});

test('recurring task moves one occurrence and keeps tomorrow regular instance',async({page,request})=>{
  const entry=await task(request,'Нужно повторить проверку');
  await request.post(`/api/captures/${entry.id}/corrections`,{data:{patch:{schedule:{date:day(0),time:null,repeat:{freq:'daily',interval:1}}}}});
  await openDay(page);
  page.once('dialog',d=>d.accept());
  await page.locator(`#todo .entry[data-capture-id="${entry.id}"] .todo-tomorrow`).click();
  await expect(page.locator('#toast')).toContainText('Перенесено на завтра');
  expect((await schedule(request,entry.id)).skip).toContain(day(0));
  await expect(page.locator(`#todo .entry[data-capture-id="${entry.id}"]`)).toHaveCount(0);
  await page.locator('#todo .daynav [data-step="1"]').click();
  await expect(page.locator('#todo .entry').filter({hasText:'Нужно повторить проверку'})).toHaveCount(2);
});

test('01 fits mobile day, task card and both themes',async({page,request})=>{
  const entry=await task(request,'Допинываем карусель с генератором фраз и проверяем длинное название');
  await page.setViewportSize({width:390,height:844});
  const appearances=process.env.PAGENT_WORKSHOP_MODE==='all'?['classic','workshop']:['classic'];
  for(const appearance of appearances) for(const theme of ['light','dark']) {
    await setUiPreferences(request,{'pagent.theme':theme,'kizuna-appearance':appearance});
    await openDay(page);
    const row=page.locator(`#todo .entry[data-capture-id="${entry.id}"]`);
    await expect(row.locator('.todo-tomorrow')).toBeVisible();
    expect(await row.evaluate(e=>e.scrollWidth-e.clientWidth)).toBeLessThanOrEqual(1);
    expect((await row.locator('.todo-tomorrow').boundingBox()).height).toBeGreaterThanOrEqual(44);
    await row.locator('.entry-title').click();
    await expect(page.locator('#review-dialog .card-chips .todo-tomorrow')).toBeVisible();
    expect(await page.locator('#review-dialog').evaluate(e=>e.scrollWidth-e.clientWidth)).toBeLessThanOrEqual(1);
    await page.locator('#review-close').click();
  }
});

test('cancelling or failing a move keeps later card property edits saveable',async({page,request})=>{
  for(const outcome of ['cancel','failure']) {
    const entry=await task(request,`Нужно проверить сохранение ${outcome}`);
    if(outcome==='cancel') await request.post(`/api/captures/${entry.id}/corrections`,{data:{patch:{schedule:{date:day(0),repeat:{freq:'daily'}}}}});
    else await page.route(`**/api/captures/${entry.id}/postpone`,route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{message:'Срок изменён в другом окне'}})}));
    await page.goto(`/#today?open=${entry.id}`);
    if(outcome==='cancel') page.once('dialog',d=>d.dismiss());
    const dialog=page.locator('#review-dialog');
    await dialog.locator('.card-chips .todo-tomorrow').click();
    await expect(dialog.locator('.card-chips .todo-tomorrow')).toBeEnabled();
    await dialog.locator('#review-params-toggle').click();
    await dialog.locator('#review-date').fill(day(3));
    await dialog.locator('#review-close').click();
    await expect.poll(async()=>schedule(request,entry.id)).toMatchObject({date:day(3)});
  }
});
