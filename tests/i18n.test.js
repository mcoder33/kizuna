import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLocale, resolveLocale, translate, pluralIndex, formatDate, SUPPORTED_LOCALES } from '../public/i18n.js';
import { catalogs } from '../public/i18n-catalog.js';
test('canonical locale normalization and ordered system fallback', () => {
  assert.equal(SUPPORTED_LOCALES.length, 7);
  for (const value of ['pt','pt-PT','pt_br']) assert.equal(normalizeLocale(value),'pt-BR');
  assert.equal(resolveLocale('de',['ja']),'de');
  assert.equal(resolveLocale('system',['xx','fr-CA','en']),'fr');
  assert.equal(resolveLocale('system',['xx']),'ru');
  assert.equal(normalizeLocale(null),null);
});
test('named tokens, CLDR plural categories and date display', () => {
  catalogs.en.__test = {one:'{count} task for {name}',other:'{count} tasks for {name}'};
  assert.equal(translate('en','__test',{count:2,name:'Мария'}),'2 tasks for Мария');
  assert.equal(pluralIndex('ru',2),'few'); assert.equal(pluralIndex('ja',2),'other');
  assert.equal(translate('ja','Unknown {name}',{name:'山田'}),'Unknown 山田');
  assert.ok(formatDate('de',new Date('2026-10-02T00:00:00Z'),{timeZone:'UTC',year:'numeric'}).includes('2026'));
  delete catalogs.en.__test;
});

test('catalog has seven identical key sets and named-token parity',()=>{
 const keys=Object.keys(catalogs.ru).sort();
 const placeholders=value=>[...value.matchAll(/\{([A-Za-z_][A-Za-z_0-9]*)\}/g)].map(match=>match[1]).sort();
 for(const locale of SUPPORTED_LOCALES){
  assert.deepEqual(Object.keys(catalogs[locale]).sort(),keys,locale);
  for(const source of keys){
   const entry=catalogs[locale][source];
   assert.ok(typeof entry==='string'||(entry&&typeof entry==='object'),`${locale}: ${source}`);
   if(typeof entry!=='string') for(const category of new Intl.PluralRules(locale).resolvedOptions().pluralCategories) assert.equal(typeof entry[category],'string',`${locale}/${category}: ${source}`);
   for(const value of typeof entry==='string' ? [entry] : Object.values(entry)) assert.deepEqual(placeholders(value),placeholders(source),`${locale}: ${source}`);
  }
 }
});

test('real catalogs cover count boundaries in all seven locales',()=>{
 const counts=[0,1,2,5,11,21];
 const categories={ru:['many','one','few','many','many','one'],en:['other','one','other','other','other','other'],es:['other','one','other','other','other','other'],'pt-BR':['one','one','other','other','other','other'],de:['other','one','other','other','other','other'],fr:['one','one','other','other','other','other'],ja:['other','other','other','other','other','other']};
 const sources=['{count} встреча','{count} день','{count} дело','{count} дело просрочено','каждые {count} дня','каждые {count} недели','каждые {count} месяца','каждые {count} года'];
 for(const locale of SUPPORTED_LOCALES)for(const source of sources){
  assert.equal(typeof catalogs[locale][source],'object',`${locale}: ${source}`);
  for(const [index,count] of counts.entries()){
   assert.equal(pluralIndex(locale,count),categories[locale][index]);
   const value=translate(locale,source,{count});
   assert.ok(value.includes(String(count)),`${locale}/${count}: ${source}`);
   assert.equal(value.includes('{count}'),false);
  }
 }
 assert.equal(translate('ru','{count} встреча',{count:2}),'2 встречи');
 assert.equal(translate('en','{count} встреча',{count:1}),'1 meeting');
 assert.equal(translate('en','{count} встреча',{count:5}),'5 meetings');
});

test('catalog translations preserve source leading and trailing whitespace',()=>{
 const edges=value=>[value.match(/^\s*/u)[0],value.match(/\s*$/u)[0]];
 for(const locale of SUPPORTED_LOCALES)for(const [source,entry] of Object.entries(catalogs[locale]))for(const value of typeof entry==='string' ? [entry] : Object.values(entry))assert.deepEqual(edges(value),edges(source),`${locale}: ${source}`);
});
test('catalog keeps Russian source identity and embedded markup',()=>{
 const tags=value=>[...value.matchAll(/<\/?[A-Za-z][^>]*>/g)].map(match=>match[0]).sort();
 for(const [locale,entries] of Object.entries(catalogs))for(const [source,entry] of Object.entries(entries)){
  if(locale==='ru'&&typeof entry==='string')assert.equal(entry,source);
  for(const value of typeof entry==='string'?[entry]:Object.values(entry))assert.deepEqual(tags(value),tags(source),`${locale}: ${source}`);
 }
});
test('formatting and native clipboard labels follow their control context',()=>{
 const bold={ru:'Ж',en:'B',es:'N','pt-BR':'N',de:'F',fr:'G',ja:'B'};
 const paste={ru:'Вставить',en:'Paste',es:'Pegar','pt-BR':'Colar',de:'Einfügen',fr:'Coller',ja:'ペースト'};
 for(const locale of SUPPORTED_LOCALES){
  assert.equal(translate(locale,'Ж'),bold[locale]);
  assert.equal(translate(locale,'Вставить'),paste[locale]);
  assert.ok(translate(locale,'⌘⇧Пробел занят — используйте меню «Новая запись»').includes(translate(locale,'Новая запись')),locale);
 }
});
