import { test, expect } from './fixtures/ui-preferences.js';

test.beforeEach(async ({ request }) => { await request.post('/api/reset', {data:{confirmation:'СБРОСИТЬ КИЗУНА'}}); });
async function telemetry(page, { mock = false } = {}) {
  const batches = [];
  await page.route('**/api/telemetry', async route => {
    const events=JSON.parse(route.request().postData()).events; batches.push(events);
    if(mock)await route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({accepted:events.length,rejected:0})});
    else await route.continue();
  });
  await page.goto('/'); await expect(page.getByLabel('Новая запись')).toBeVisible();
  return { batches, events: () => batches.flat(), flush: () => page.evaluate(async () => { await window.KizunaTelemetry.flush(); await window.KizunaTelemetry.flush(); }) };
}

test('the real input-to-result journey shares its flow, preserves edits and omits text', async ({ page }) => {
  const logs = await telemetry(page), secret = 'Проверить закрытый проект Телеметрия';
  const input = page.getByLabel('Новая запись');
  await input.fill(secret+'x'); await input.press('End'); await input.press('Backspace');
  const posted = page.waitForResponse(response=>response.url().endsWith('/api/captures')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Сохранить запись',exact:true}).click();
  const response=await posted; expect(response.status()).toBe(202); const job=await response.json();
  const flowId=await response.request().headerValue('x-kizuna-flow-id'); expect(flowId).toMatch(/^[0-9a-f-]{36}$/);
  await expect.poll(async()=>{await logs.flush();return logs.events().some(event=>event.event==='capture_result_visible'&&event.jobId===job.jobId);},{timeout:15000}).toBe(true);
  const sequence=logs.events().filter(event=>event.flowId===flowId);
  expect(sequence.some(event=>event.event==='capture_input'&&event.editCount>0)).toBe(true);
  for(const name of ['capture_submit','capture_accepted','capture_job_observed','capture_result_visible'])expect(sequence.some(event=>event.event===name)).toBe(true);
  expect(sequence.find(event=>event.event==='capture_result_visible').captureId).toBe(job.captureId);
  expect(JSON.stringify(logs.events())).not.toContain(secret);
});

test('a failed submission retains the draft and records the same flow on a successful retry', async ({ page }) => {
  const logs=await telemetry(page); await page.getByLabel('Новая запись').fill('Пережить отсутствие сети');
  await page.route('**/api/captures', route=>route.abort('failed'));
  await page.getByRole('button',{name:'Сохранить запись',exact:true}).click();
  await expect(page.locator('#capture-submit')).toBeEnabled(); await expect(page.getByLabel('Новая запись')).toHaveText('Пережить отсутствие сети');
  await logs.flush(); const failed=logs.events().find(event=>event.event==='capture_submit_failed');expect(failed).toBeTruthy();
  await page.unroute('**/api/captures');
  await page.getByRole('button',{name:'Сохранить запись',exact:true}).click();
  await expect.poll(async()=>{await logs.flush();return logs.events().some(event=>event.event==='capture_accepted'&&event.flowId===failed.flowId);}).toBe(true);
});

test('runtime errors omit messages and an offline event flood remains bounded', async ({ page, context }) => {
  const logs=await telemetry(page,{mock:true});
  await page.evaluate(()=>window.dispatchEvent(new ErrorEvent('error',{error:new TypeError('PRIVATE_ERROR_MESSAGE'),message:'PRIVATE_ERROR_MESSAGE',lineno:17,colno:3})));
  await logs.flush();expect(logs.events().some(event=>event.event==='client_error'&&event.errorName==='TypeError'&&event.line===17)).toBe(true);
  expect(logs.events().find(event=>event.event==='client_error'&&event.line===17).errorCode).toBe('javascript_error');
  expect(JSON.stringify(logs.events())).not.toContain('PRIVATE_ERROR_MESSAGE');
  await context.setOffline(true);
  await page.evaluate(()=>{for(let n=0;n<300;n++)window.KizunaTelemetry.emit('ui_action',{action:'open',count:n});});
  await context.setOffline(false);
  await expect.poll(async()=>{await logs.flush();return logs.events().some(event=>event.event==='telemetry_dropped'&&event.count>=220);}).toBe(true);
  expect(logs.batches.every(batch=>batch.length<=40)).toBe(true);
});

test('browser diagnostics distinguish resize delivery, resource loads and promise rejections without private text', async ({ page }) => {
  const logs=await telemetry(page,{mock:true});
  await page.evaluate(()=>{
    window.dispatchEvent(new ErrorEvent('error',{message:'ResizeObserver loop completed with undelivered notifications.'}));
    window.dispatchEvent(new ErrorEvent('error',{message:'ResizeObserver loop limit exceeded'}));
    const image=document.createElement('img');
    image.src='/public/private-missing-image.png?PRIVATE_TOKEN';
    document.body.append(image);
    window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection',{promise:Promise.resolve(),reason:new Error('PRIVATE_REJECTION')}));
  });
  await expect.poll(async()=>{await logs.flush();return logs.events().filter(event=>event.event==='client_error'&&event.errorCode==='resource_load').length;}).toBe(1);
  expect(logs.events().filter(event=>event.event==='client_error'&&event.errorCode==='resize_observer_loop')).toHaveLength(2);
  expect(logs.events().some(event=>event.event==='client_rejection'&&event.errorCode==='unhandled_rejection')).toBe(true);
  expect(JSON.stringify(logs.events())).not.toContain('PRIVATE');
});
