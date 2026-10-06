import { test, expect, setUiPreferences } from './fixtures/ui-preferences.js';

const profiles = [
  { name:'phone', width:375, height:812, isMobile:true },
  { name:'tablet', width:768, height:1024, isMobile:true },
  { name:'compact desktop', width:960, height:900, isMobile:false },
  { name:'desktop', width:1440, height:900, isMobile:false },
];
const browserName=process.env.E2E_BROWSER || 'chromium';
test.use({browserName});
for (const profile of profiles) {
  test.describe(`${browserName} ${profile.name}`, () => {
    test.use({ viewport:{width:profile.width,height:profile.height}, isMobile:profile.isMobile, hasTouch:profile.isMobile });
    test('card navigation and resizing settle without browser errors or losing the split layout', async ({ page, request }) => {
      await request.post('/api/reset', {data:{confirmation:'СБРОСИТЬ КИЗУНА'}});
      await setUiPreferences(request, {'kizuna-card-mode':'center'});
      const date=(await (await request.get('/api/day')).json()).date;
      const ids=[];
      for (const title of ['Проверить короткую карточку','Проверить длинную карточку с заметкой и несколькими шагами']) {
        const response=await request.post('/api/captures',{data:{raw:title,primaryType:'todo',due:{date}}});
        expect(response.status()).toBe(201);
        const entry=(await response.json()).entry;
        ids.push(entry.id);
        await request.post(`/api/captures/${entry.id}/subtasks`,{data:{title:'Проверить тестовый шаг'}});
      }
      await request.post(`/api/captures/${ids[1]}/notes`,{data:{body:'Длинная заметка для проверки размеров.\n\n'.repeat(30)}});
      await page.addInitScript(() => {
        window.cardResizeErrors=[];
        window.addEventListener('error', event => window.cardResizeErrors.push(event.message || 'resource_load'), true);
      });
      await page.goto('/');
      await expect(page.locator('#todo .entry')).toHaveCount(2);
      const card=page.locator('#review-dialog');
      const open=async id => {
        await page.locator(`#todo [data-capture-id="${id}"] .entry-title`).click();
        await expect(card).toBeVisible();
        await expect(card.locator('#card-subtask-list .subtask')).toHaveCount(1);
      };
      await open(ids[0]);
      await card.getByRole('button',{name:'Предыдущее · K',exact:true}).click();
      await expect(card.locator('.card-title')).toContainText('Проверить длинную');
      await card.getByRole('button',{name:'Следующее · J',exact:true}).click();
      await expect(card.locator('.card-title')).toContainText('Проверить короткую');
      const divider=card.getByRole('separator',{name:'Размер заметки и подзадач'});
      await divider.press('ArrowUp');
      await expect(divider).toHaveAttribute('aria-valuenow','62');
      await card.locator('#review-params-toggle').click();
      await expect(card.locator('#review-params')).toBeVisible();
      await card.locator('#review-params-toggle').click();
      await card.getByLabel('Сообщение в обсуждение',{exact:true}).fill('Проверяем изменение высоты поля обсуждения.\n'.repeat(6));
      await expect(card.locator('.talk-dock textarea')).toHaveValue(/Проверяем/);
      await card.locator('#review-close').click();
      await expect(card).toBeHidden();
      await open(ids[1]);
      await expect(card.locator('.card-workspace')).toHaveClass(/has-steps/);
      // Wait for actual layout changes to settle, rather than sampling only
      // the synchronous click before ResizeObserver delivers its callbacks.
      await page.evaluate(async () => { for(let n=0;n<8;n++) await new Promise(requestAnimationFrame); });
      const layout=await card.evaluate(element => {
        const workspace=element.querySelector('.card-workspace');
        return { width:document.documentElement.clientWidth, overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
          cardOverflow:element.scrollWidth-element.clientWidth, workspaceHeight:workspace.getBoundingClientRect().height,
          noteHeight:element.querySelector('.card-body').getBoundingClientRect().height, stepsHeight:element.querySelector('.card-subtasks').getBoundingClientRect().height };
      });
      expect(layout.width).toBe(profile.width);
      expect(layout.overflow).toBeLessThanOrEqual(1);
      expect(layout.cardOverflow).toBeLessThanOrEqual(1);
      expect(layout.workspaceHeight).toBeGreaterThan(160);
      expect(layout.noteHeight).toBeGreaterThan(70);
      expect(layout.stepsHeight).toBeGreaterThan(70);
      expect(await page.evaluate(() => window.cardResizeErrors)).toEqual([]);
    });
  });
}
