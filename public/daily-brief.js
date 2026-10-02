import { getTimeZone } from "./browser-time-zone.js";
import { normalizeTimeZone } from "./time-zone.js";
import { t, getLocale, bindTranslation } from "./browser-i18n.js";
import { renderMarkdown, renderInlineMarkdown } from './markdown.js';
// Only these presentation strings belong to the application. Generated
// report items and historical/raw source text are never translated here.
export const DAILY_BRIEF_PRESENTATION_SOURCES = {
  doneYesterday: { label: "Сделано вчера", empty: "Нет подтверждённых завершений за вчера." },
  decisions: { label: "Решения", empty: "Нет зафиксированных решений." },
  carried: { label: "Перенесённое", empty: "Нет незавершённых задач или встреч из прошлого." },
  blockers: { label: "Блокеры", empty: "Нет зафиксированных блокеров." },
  today: { label: "Сегодня", empty: "На сегодня задач и встреч нет." },
};
let renderedBrief=null;
const briefArea=document.querySelector('#daily-brief'), refreshButton=document.querySelector('#daily-brief-refresh');
const clearBrief=()=>briefArea.querySelectorAll('.daily-brief-section,.daily-brief-meta,.daily-brief-loading').forEach(element=>element.remove());
const element=(name,text,className)=>{const node=document.createElement(name);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node};
// Разметка в отчёте: пункты — строки, поэтому инлайновый рендер; исходная
// запись в диалоге источника — полноценный markdown.
const markdownElement=(name,text,className,inline)=>{const node=document.createElement(name);node.className=`${className||''} ${inline?'md-inline':'md-block'}`.trim();node.innerHTML=inline?renderInlineMarkdown(text,{links:false}):renderMarkdown(text);return node};
const validSource=source=>source?.action?.kind==='capture'&&typeof source.action.captureId==='string'&&/^[0-9a-f-]{36}$/i.test(source.action.captureId);
function findRenderedCaptureCard(captureId){return document.querySelector(`[data-capture-id="${CSS.escape(captureId)}"]`)}
function openCaptureCard(captureId,dialog){location.hash='#today';window.setTimeout(()=>{const card=findRenderedCaptureCard(captureId);if(!card)return;dialog.close();card.scrollIntoView({block:'center'});card.setAttribute('tabindex','-1');window.setTimeout(()=>card.focus({preventScroll:true}),0)},0)}
async function openSource(source,brief){if(!validSource(source))return;const response=await fetch(`/api/entries?limit=100`);let entry=response.ok?(await response.json()).entries.find(candidate=>candidate.id===source.action.captureId):null;if(!entry){const exact=await fetch(`/api/daily-brief/${encodeURIComponent(brief.date)}/revisions/${brief.revision}/sources/${source.sourceId}?timeZone=${encodeURIComponent(normalizeTimeZone(brief.timeZone)||getTimeZone())}`);if(!exact.ok)throw new Error(t("Источник больше недоступен."));entry=await exact.json()}let dialog=document.querySelector('#daily-brief-source-dialog');if(!dialog){dialog=document.createElement('dialog');dialog.id='daily-brief-source-dialog';document.body.append(dialog)}dialog.replaceChildren(bindTranslation(element('h2',t("Исходная запись")), "Исходная запись"),markdownElement('div',entry.raw,'review-raw',false));if(findRenderedCaptureCard(source.action.captureId)){const openCard=bindTranslation(element('button',t("Открыть карточку"),'secondary'), "Открыть карточку");openCard.addEventListener('click',()=>openCaptureCard(source.action.captureId,dialog));dialog.append(openCard)}const close=bindTranslation(element('button',t("Закрыть"),'secondary'), "Закрыть");close.addEventListener('click',()=>dialog.close());dialog.append(close);dialog.showModal();}
function renderBrief(brief){renderedBrief=brief;clearBrief();for(const section of brief.content.sections){const block=element('section',undefined,'daily-brief-section');const presentation=DAILY_BRIEF_PRESENTATION_SOURCES[section.key];block.append(presentation?bindTranslation(element('h3'),presentation.label):element('h3',section.label));if(!section.items.length)block.append(presentation?bindTranslation(element('p',undefined,'empty'),presentation.empty):element('p',section.empty,'empty'));for(const item of section.items){const entry=element('div',undefined,'entry'),sources=brief.sources.filter(source=>source.sectionKey===section.key&&source.itemKey===item.key);entry.append(markdownElement('div',item.text,'entry-title',true));if(sources.some(validSource)){const sourceButton=bindTranslation(element('button',t("Открыть источник"),'text-button daily-brief-source'), "Открыть источник");sourceButton.addEventListener('click',async()=>{try{await openSource(sources.find(validSource),brief);}catch(error){window.dispatchEvent(new CustomEvent('pagent:toast',{detail:error.message}));}});entry.append(sourceButton)}block.append(entry)}briefArea.append(block)}briefArea.append(bindTranslation(element('p',t("Ревизия {revision} · сформирован {value2}", { revision: brief.revision, value2: new Date(brief.generatedAt).toLocaleString(getLocale(),{dateStyle:'short',timeStyle:'short',timeZone:getTimeZone()}) }),'daily-brief-meta'), "Ревизия {revision} · сформирован {value2}", { revision: brief.revision, value2: new Date(brief.generatedAt).toLocaleString(getLocale(),{dateStyle:'short',timeStyle:'short',timeZone:getTimeZone()}) }));}
async function loadBrief(refresh=false){clearBrief();briefArea.append(bindTranslation(element('p',t("Готовим отчёт…"),'empty daily-brief-loading'), "Готовим отчёт…"));refreshButton.disabled=true;try{const response=await fetch(refresh?'/api/daily-brief/refresh':'/api/daily-brief',{method:refresh?'POST':'GET',headers:refresh?{'Content-Type':'application/json'}:undefined,body:refresh?'{}':undefined});if(!response.ok)throw new Error(t("Не удалось подготовить ежедневный отчёт."));renderBrief(await response.json());}catch(error){clearBrief();briefArea.append(element('p',error.message,'empty'));}finally{refreshButton.disabled=false}}
refreshButton.addEventListener('click',()=>loadBrief(true));loadBrief();

window.addEventListener("pagent:localechange",()=>{if(renderedBrief)renderBrief(renderedBrief)});

window.addEventListener("pagent:timezonechange",()=>{if(!document.getElementById("brief")?.hidden)loadBrief();});
