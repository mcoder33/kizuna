import { z } from 'zod';
import { normalizeRepeat, validRepeat, scheduleDisplay } from './repeat.js';
export const primaryTypes=['meeting_event','task','note','outcome_decision','idea_question'];
export const claimSchema=z.object({field:z.string(),value:z.unknown(),kind:z.enum(['fact','inference','assumption','unknown']),confidence:z.number().min(0).max(1),provenance:z.object({source:z.enum(['raw','rule','model']),evidence:z.string().max(300).optional()}),essential:z.boolean()});
export const classificationSchema=z.object({
  primaryType:z.enum(primaryTypes),
  entities:z.object({
    projects:z.array(z.string()).max(6),
    people:z.array(z.string()).max(8),
    when:z.union([z.string().max(120),z.object({date:z.string().max(10).nullable(),time:z.string().max(5).nullable(),end:z.string().max(5).nullable().optional()}).passthrough()]).nullable(),
    followUp:z.string().max(500).nullable(),
  }),
  additionalTypes:z.array(z.enum(primaryTypes)).max(3),
  summary:z.string().min(1).max(500),
  proposedActions:z.array(z.object({type:z.string().max(60),title:z.string().max(300)})).max(5),
  // Оба поля добавлены к контракту модели; старые провайдеры их не присылают,
  // поэтому у них безопасные значения по умолчанию.
  completed:z.boolean().optional().default(false),
  ambiguity:z.object({field:z.string().max(40),question:z.string().max(300).nullable().optional()}).nullable().optional().default(null),
});
export const answerSchema=z.object({answer:z.string().min(1).max(3000),citationIds:z.array(z.string()).max(12)});

const isoDate=/^\d{4}-\d{2}-\d{2}$/;const isoTime=/^(\d{1,2}):(\d{2})$/;
function plainDate(date){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`}
function today(now,timeZone){const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);const get=type=>Number(parts.find(part=>part.type===type).value);return new Date(get('year'),get('month')-1,get('day'))}
function addDays(d,n){return new Date(d.getFullYear(),d.getMonth(),d.getDate()+n)}
export function currentDate(now=new Date(),timeZone='Europe/Samara'){return plainDate(today(now,timeZone))}

// Разбор смысла целиком на модели. Здесь остаётся только проверка формата:
// дата обязана быть ISO и лежать в правдоподобном окне, время — HH:MM.
// Это не классификация, а защита журнала от мусора в сохранённой проекции.
export function scheduleFromModel(when,now=new Date(),timeZone='Europe/Samara'){
  if(!when||typeof when!=='object'||Array.isArray(when))return null;
  const date=typeof when.date==='string'&&isoDate.test(when.date)?when.date:null;
  const timeMatch=typeof when.time==='string'?when.time.match(isoTime):null;
  const time=timeMatch&&Number(timeMatch[1])<=23&&Number(timeMatch[2])<=59?`${timeMatch[1].padStart(2,'0')}:${timeMatch[2]}`:null;
  if(!date&&!time)return null;
  if(date){const base=today(now,timeZone);if(date<plainDate(addDays(base,-366))||date>plainDate(addDays(base,731)))return null}
  // Конец — только при известном начале и строго после него: «с 11 до 12»
  // даёт блок в календаре, а конец без начала или раньше него — мусор.
  const endMatch=time&&typeof when.end==='string'?when.end.match(isoTime):null;
  const end=endMatch&&Number(endMatch[1])<=23&&Number(endMatch[2])<=59?`${endMatch[1].padStart(2,'0')}:${endMatch[2]}`:null;
  const endValid=end&&(Number(end.slice(0,2))*60+Number(end.slice(3)))>(Number(time.slice(0,2))*60+Number(time.slice(3)));
  // Повтор — только при дате и только целый: кривое правило или «до» раньше
  // первого экземпляра отбрасываются, срок остаётся разовым.
  const repeat=date?normalizeRepeat(when.repeat)||null:null;
  const repeatValid=repeat&&!(repeat.until&&repeat.until<date)?repeat:null;
  return {state:'ok',date,time,...(endValid?{end}:{}),...(repeatValid?{repeat:repeatValid}:{}),sortAt:date?`${date}T${time||'23:59'}:00`:null,display:scheduleDisplay({date,time,end:endValid?end:null,repeat:repeatValid})};
}

// Заземление: сущность принимается, только если её начало встречается в записи.
// Модель нормализует падеж («Даниилом» → «Даниил»), но не имеет права
// добавлять людей и проекты, которых в тексте нет.
function groundedValues(candidates,raw,max){
  const lower=raw.toLowerCase(),out=[];
  for(const candidate of candidates||[]){
    if(typeof candidate!=='string')continue;
    const value=candidate.trim();
    if(!value||value.length>120)continue;
    const stem=value.toLowerCase().slice(0,Math.min(value.length,4));
    if(stem.length>=2&&lower.includes(stem)&&!out.some(existing=>existing.toLowerCase()===value.toLowerCase()))out.push(value);
  }
  return out.slice(0,max);
}

// Запись часто несёт два разных действия сразу: «созвонились по ВойсОпс…
// решили допинать бот-детектор и карусель» — это и отчёт о сделанном, и два
// намерения на будущее. Раньше намерения оставались текстом заметки: тип у
// записи один, а у второй проекции был бы тот же заголовок, что у первой.
// Теперь модель называет их отдельно, и из каждого выходит своя запись-дело
// (см. splitOffActions в server/db.js). Заземление то же, что у остальных
// сущностей: действие, которого нет в тексте, отбрасывается — выдуманное дело
// в неизменяемом журнале дороже пропущенного.
const ACTION_MIN_LENGTH=8;
function groundedActions(actions,raw,{summary='',followUp=null}={}){
  const lower=String(raw).toLowerCase(),out=[];
  const taken=new Set([summary,followUp].filter(Boolean).map(value=>value.trim().toLowerCase()));
  for(const action of actions||[]){
    const title=typeof action?.title==='string'?action.title.trim().slice(0,300):'';
    if(title.length<ACTION_MIN_LENGTH)continue;
    const stem=title.toLowerCase().slice(0,Math.min(title.length,12));
    if(!lower.includes(stem))continue;
    if(taken.has(title.toLowerCase()))continue;
    taken.add(title.toLowerCase());
    out.push({type:'task',title});
    if(out.length===5)break;
  }
  return out;
}
// Действие, отделённое от записи, живёт дальше своей записью-делом: заголовок
// — дословная фраза человека, проекты наследуются от исходной (речь об одном),
// люди и срок — нет: срок у намерения не назван, а участники встречи не
// исполнители дела.
export function actionClassification(title,parent){
  const projects=(parent?.entities?.projects||[]).slice(0,6);
  const claims=[
    claim('type','task',true,0.9,'inference','split'),
    claim('projects',projects,projects.length===1,0.8,'fact','split'),
    claim('schedule',null,false,0,'unknown','split'),
    claim('people',[],false,0,'unknown','split'),
    claim('followUp',null,false,0,'unknown','split'),
  ];
  return {primaryType:'task',summary:title.slice(0,500),entities:{projects,people:[],schedule:null,followUp:null},additionalTypes:[],proposedActions:[],completed:false,ambiguity:null,claims,confidence:Object.fromEntries(claims.map(item=>[item.field,item.confidence])),conflicts:{projects:false,schedule:false}};
}

function claim(field,value,essential,confidence,kind,source){
  const filled=Array.isArray(value)?value.length>0:Boolean(value);
  return {field,value:value??null,kind:filled?kind:'unknown',confidence:filled?confidence:0,provenance:{source,evidence:filled?String(Array.isArray(value)?value.join(', '):typeof value==='object'?JSON.stringify(value):value).slice(0,300):undefined},essential};
}

// Запись без разбора: модель недоступна, а угадывать тип по тексту больше нечем.
// Проекции не создаются, запись честно помечается как требующая уточнения.
export function unclassifiedCapture(raw=''){
  const summary=String(raw).trim().slice(0,500)||'Запись без текста';
  const claims=[claim('type',null,true,0,'unknown','rule')];
  return {primaryType:'note',entities:{projects:[],people:[],schedule:null,followUp:null},additionalTypes:[],summary,proposedActions:[],completed:false,unclassified:true,ambiguity:{field:'type',question:'Запись сохранена без разбора: укажите тип.'},claims,confidence:Object.fromEntries(claims.map(c=>[c.field,c.confidence])),conflicts:{projects:false,schedule:false}};
}
export const classifyFallback=(raw='')=>unclassifiedCapture(raw);

// Сделанное — это результат. Модель честно отмечала «Обсудили орг вопросы с
// Даниилом» как состоявшееся, но оставляла тип «встреча», и запись лежала в
// «Что делал» с кружком «Готово» и пометкой «без срока», хотя отмечать в ней
// нечего: она уже завершилась. Правило одно на все входы — разбор моделью,
// уточнение в карточке, поправка голосом: у сделанного нет ни встречи, ни дела.
const OPEN_TYPES=['task','meeting_event'];
export function settleCompleted(classification){
  if(classification?.completed!==true)return classification;
  const additional=classification.additionalTypes||[];
  if(!OPEN_TYPES.includes(classification.primaryType)&&!additional.some(type=>OPEN_TYPES.includes(type)))return classification;
  const primaryType=OPEN_TYPES.includes(classification.primaryType)?'outcome_decision':classification.primaryType;
  const claims=(classification.claims||[]).map(item=>item.field==='type'?{...item,value:primaryType}:item);
  return {...classification,primaryType,additionalTypes:additional.filter(type=>type!==primaryType&&!OPEN_TYPES.includes(type)),claims,confidence:Object.fromEntries(claims.map(item=>[item.field,item.confidence]))};
}

export function normalizeClassification(candidate,raw='',now=new Date(),source='model',timeZone='Europe/Samara'){
  const parsed=classificationSchema.parse(candidate);
  const completed=parsed.completed===true;
  const primaryType=completed&&OPEN_TYPES.includes(parsed.primaryType)?'outcome_decision':parsed.primaryType;
  const scheduleRelevant=['meeting_event','task'].includes(primaryType)&&!completed;
  const schedule=scheduleRelevant?scheduleFromModel(parsed.entities.when,now,timeZone):null;
  const people=groundedValues(parsed.entities.people,raw,8);
  const projects=groundedValues(parsed.entities.projects,raw,6);
  const followUp=parsed.entities.followUp&&raw.toLowerCase().includes(parsed.entities.followUp.trim().toLowerCase().slice(0,Math.min(parsed.entities.followUp.trim().length,12)))?parsed.entities.followUp.trim().slice(0,500):null;
  const summary=(parsed.summary||'').trim().slice(0,500)||String(raw).trim().slice(0,500);
  // Отчёт о сделанном не открывает дело; отдельная task-проекция допустима
  // только при явно названном следующем действии.
  const additionalTypes=completed?[]:[...new Set(parsed.additionalTypes.filter(type=>type!==primaryType&&(type!=='task'||followUp)))];
  const ambiguity=parsed.ambiguity&&typeof parsed.ambiguity.field==='string'?{field:parsed.ambiguity.field,question:parsed.ambiguity.question||null}:null;
  const claims=[
    claim('type',primaryType,true,0.9,'inference',source),
    claim('projects',projects,projects.length===1,0.88,'fact',source),
    claim('schedule',schedule,scheduleRelevant&&primaryType==='meeting_event',0.88,'inference',source),
    claim('people',people,false,0.88,'fact',source),
    claim('followUp',followUp,false,0.88,'inference',source),
  ];
  const out={primaryType,summary,entities:{projects,people,schedule,followUp},additionalTypes,proposedActions:groundedActions(parsed.proposedActions,raw,{summary,followUp}),completed,ambiguity,claims,confidence:Object.fromEntries(claims.map(c=>[c.field,c.confidence])),conflicts:{projects:ambiguity?.field==='projects',schedule:ambiguity?.field==='schedule'}};
  return out;
}

// Гейт слушает только модель: она сама сообщает, что нельзя разобрать
// однозначно. Пороги уверенности были нужны правилам — модель либо разобрала
// запись, либо явно назвала поле, по которому нужен вопрос человеку.
export function gateClassification(c){
  if(c?.unclassified)return {level:'low',question:c.ambiguity?.question||'Запись сохранена без разбора: укажите тип.',field:'type',safeNote:true};
  const ambiguity=c?.ambiguity;
  if(ambiguity?.field){
    const conflicting=ambiguity.field==='schedule'||ambiguity.field==='projects';
    return {level:conflicting?'conflict':'low',question:ambiguity.question||null,field:ambiguity.field,...(ambiguity.field==='type'?{safeNote:true}:{})};
  }
  return {level:'high',question:null,field:null};
}

// Ручные параметры записи из карточки ввода. UI говорит на языке трёх типов
// (todo / outcome / note) — на внутренние типы журнала они отображаются здесь.
// Срок и важность имеют смысл только у ТУДУ; теги общие для всех типов.
const userTypeMap={todo:'task',outcome:'outcome_decision',note:'note'};
export function parseCaptureOverrides(body,now=new Date(),timeZone='Europe/Samara'){
  const src=body||{};const out={};
  if(src.primaryType!==undefined&&src.primaryType!==null){
    if(!Object.hasOwn(userTypeMap,src.primaryType))return{error:'invalid_type'};
    out.primaryType=userTypeMap[src.primaryType];
  }
  if(src.due!==undefined&&src.due!==null){
    if(typeof src.due!=='object'||Array.isArray(src.due))return{error:'invalid_due'};
    const date=src.due.date,time=src.due.time??null;
    if(typeof date!=='string'||(time!==null&&typeof time!=='string'))return{error:'invalid_due'};
    if(!scheduleFromModel({date,time},now,timeZone))return{error:'invalid_due'};
    const remind=src.due.remind;
    if(remind!==undefined&&remind!==null&&!(remind==='off'||(Number.isInteger(remind)&&remind>=0&&remind<=7*24*60)))return{error:'invalid_due'};
    // Повтор у срока: правило целиком, «до» не раньше первого экземпляра.
    const repeat=src.due.repeat===undefined||src.due.repeat===null?null:normalizeRepeat(src.due.repeat);
    if(repeat===undefined||(repeat?.until&&repeat.until<date))return{error:'invalid_due'};
    out.due={date,time,...(remind!==undefined&&remind!==null?{remind}:{}),...(repeat?{repeat}:{})};
  }
  if(src.priority!==undefined&&src.priority!==null){
    if(!['low','high'].includes(src.priority))return{error:'invalid_priority'};
    out.priority=src.priority;
  }
  if(src.tags!==undefined&&src.tags!==null){
    if(!Array.isArray(src.tags)||src.tags.length>8)return{error:'invalid_tags'};
    const tags=[];
    for(const candidate of src.tags){
      if(typeof candidate!=='string')return{error:'invalid_tags'};
      const tag=candidate.trim().replace(/^#/,'').toLowerCase();
      if(!tag||tag.length>40)return{error:'invalid_tags'};
      if(!tags.includes(tag))tags.push(tag);
    }
    if(tags.length)out.tags=tags;
  }
  if((out.due||out.priority)&&out.primaryType!=='task')return{error:'overrides_require_todo'};
  return{overrides:Object.keys(out).length?out:null};
}

// Наложение ручных параметров на классификацию (модельную или fallback).
// Заданное человеком — факт с уверенностью 1; ambiguity по этому полю снята,
// признак unclassified при заданном типе больше не действует.
export function applyUserOverrides(classification,overrides,now=new Date(),timeZone='Europe/Samara'){
  if(!overrides)return classification;
  const out={...classification,entities:{...classification.entities},claims:(classification.claims||[]).map(item=>({...item})),conflicts:{...(classification.conflicts||{})}};
  const setClaim=(field,value,essential)=>{
    const index=out.claims.findIndex(item=>item.field===field);
    const next={field,value,kind:'fact',confidence:1,provenance:{source:'raw',evidence:'user override'},essential:index>=0?out.claims[index].essential:Boolean(essential)};
    if(index>=0)out.claims[index]=next;else out.claims.push(next);
  };
  const clearAmbiguity=field=>{if(out.ambiguity?.field===field)out.ambiguity=null};
  if(overrides.primaryType){
    out.primaryType=overrides.primaryType;
    delete out.unclassified;
    out.additionalTypes=(out.additionalTypes||[]).filter(type=>type!==overrides.primaryType);
    setClaim('type',overrides.primaryType,true);
    clearAmbiguity('type');
    // Тип выбран человеком: «результат» — это уже сделанное и идёт в «Что
    // делал», остальные типы — нет. Без этого запись с ручным «результатом»
    // оседала в заметках: признак «сделано» ставит только модель.
    out.completed=overrides.primaryType==='outcome_decision';
  }
  const scheduleAllowed=['task','meeting_event'].includes(out.primaryType)&&!out.completed;
  if(overrides.due&&scheduleAllowed){
    const schedule=scheduleFromModel(overrides.due,now,timeZone);
    if(schedule){
      if(overrides.due.remind!==undefined&&overrides.due.remind!==null)schedule.remind=overrides.due.remind;
      out.entities.schedule=schedule;
      setClaim('schedule',schedule);
      out.conflicts.schedule=false;
      clearAmbiguity('schedule');
    }
  }
  if(overrides.priority&&out.primaryType==='task')out.priority=overrides.priority;
  if(overrides.tags?.length)out.tags=overrides.tags;
  out.confidence=Object.fromEntries(out.claims.map(item=>[item.field,item.confidence]));
  return out;
}

export function shouldMaterializeProjections(c){return primaryTypes.includes(c.primaryType)&&!c.unclassified&&!c.conflicts?.schedule&&!c.conflicts?.projects}
export function makeProjections(captureId,c,undoGroupId){return [c.primaryType,...(c.additionalTypes||[])].map(projectionType=>({captureId,projectionType,payload:{title:c.summary,...c.entities},undoGroupId}))}
export function validateCitations(ids,allowed){return Array.isArray(ids)&&new Set(ids).size===ids.length&&(allowed.size===0?ids.length===0:ids.length>0)&&ids.every(id=>typeof id==='string'&&allowed.has(id))}
