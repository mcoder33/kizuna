import { test } from '@playwright/test';
import {readFileSync} from 'node:fs';
test('Day task metadata stays beside the title with the complete stylesheet cascade', async ({ page }) => {
const html=readFileSync('public/app.html','utf8');
const paths=[...html.matchAll(/<link rel="stylesheet" href="\/public\/([^"]+)"/g)].map(m=>m[1]);
const rows=['Сделать МСП для ЗБ','Отремонтировать зеркало','Допинываем карусель с генератором фраз'];
await page.setContent(`<html data-appearance="workshop" data-theme="dark"><body><main><section id="today"><div id="todo"><div class="day-head"><h3 class="day-group late">ПРОСРОЧЕНО · 3</h3></div><div class="day-late">${rows.map((title,i)=>`<div class="entry dense importance-row completable overdue has-tomorrow"><button class="completion-button" aria-label="Готово"></button><button class="entry-title"><span class="entry-title-text">${title}</span></button><button class="todo-tomorrow">завтра <sup>+1</sup></button><div class="entry-meta">${i===2?'<button class="sub-badge all-done">2/2</button><span class="tag project">Zadolbator</span>':''}<span class="tag due late">с 24 окт.</span></div></div>`).join('')}</div></div></section></main></body></html>`);
for(const path of paths)await page.addStyleTag({content:readFileSync('public/'+path,'utf8')});
for(const appearance of ['workshop','classic']){
 await page.evaluate(a=>document.documentElement.dataset.appearance=a,appearance);
 for(const width of [1706,1440,1024,768]){
  await page.setViewportSize({width,height:900});
  const boxes=await page.locator('#todo .entry').evaluateAll(els=>els.map(el=>['completion-button','entry-title','entry-meta','todo-tomorrow'].map(c=>{const e=el.querySelector('.'+c),r=e.getBoundingClientRect();return {x:r.x,right:r.right,mid:r.y+r.height/2,height:r.height};})));
  for(const row of boxes){if(Math.max(...row.map(r=>r.mid))-Math.min(...row.map(r=>r.mid))>1)throw Error('not one row '+appearance+width+JSON.stringify(row));for(let i=1;i<row.length;i++)if(row[i-1].right>row[i].x+1)throw Error('overlap '+appearance+width);}
  console.log('PASS all page styles and four children',appearance,width);
 }
}
await page.setViewportSize({width:1440,height:900});await page.evaluate(()=>document.documentElement.dataset.appearance='workshop');
});
