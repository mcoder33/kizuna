import { parseTaskSearchQuery, validateLiteralSearchDates, searchTopicsEquivalent,searchQueryTopicAnchors } from './task-search.js';
import { validateSearchPlan, sanitizeSearchPlanContext } from './search-plan.js';
import { normalizeSearchText, searchWords } from './search-normalization.js';

const clarificationText = {
  unsupported_semantics: 'Уточните запрос: исключения, противоречивые фильтры и действия над записями пока не поддерживаются.',
  ambiguous_period: 'Уточните период: назовите даты или укажите прошлую либо следующую неделю.',
  ambiguous_reference: 'Назовите человека или тему для поиска.',
  empty_query: 'Укажите тему, человека, статус или период для поиска.',
};

function unsupportedQuery(query) {
  const lower = normalizeSearchText(query);
  if (/(?:^|\s)(?:кроме|без|исключая|исключи|удали|измени|назначь)(?:\s|$)|не\s+(?:про|связан|относя)/u.test(lower)) return true;
  const positive = lower.replace(/не\s+(?:сделан|сделал|выполнен|выполнил)[\p{L}]*/gu, '').replace(/незаверш[\p{L}]*/gu, '');
  return /открыт|не\s+сделан|не\s+выполнен|незаверш/u.test(lower) && /закрыт|выполнен|завершен|сделан/u.test(positive);
}

function criteriaFromPlan(query, plan, original, previousCriteria) {
  const previousPerson = previousCriteria?.person;
  const person = plan.person?.surface;
  if (person && !query.includes(person) && !(original.inherited && person === previousPerson)) return null;
  // Alternatives preserve the complete topic: a compound must not turn into
  // one of its components, and a report+project phrase must not lose the report.
  if (plan.topicGroups.some(group => group.some(variant => !searchTopicsEquivalent(group[0], variant) || !searchTopicsEquivalent(variant, group[0])))) return null;
  const groups = plan.topicGroups.map(group => [...group]);
  const queryTokens = searchWords(query).slice(0,100);
  const surfaces = [];
  for(let start=0;start<queryTokens.length;start++) for(let end=start+1;end<=Math.min(queryTokens.length,start+12);end++) surfaces.push(queryTokens.slice(start,end).join(' '));
  if (original.inherited) surfaces.push(...(previousCriteria?.topicGroups?.flat() || previousCriteria?.lexicalTerms || previousCriteria?.terms || []));
  if (groups.some(group=>!surfaces.some(surface=>searchTopicsEquivalent(group[0],surface)))) return null;
  // Every independent topic survives; only conversational intent and explicit
  // filter wording are excluded from coverage, never unknown subject nouns.
  const topicAnchors = searchQueryTopicAnchors(original);
  if(original.person && !/^\d+$/u.test(original.person))topicAnchors.push(original.person);
  const modelTopics = groups.flat().flatMap(value=>[value,...searchWords(value)]).concat(person ? [person,...searchWords(person)] : []);
  const sourceTopics=original.lexicalTerms || original.terms || [];
  function covered(anchor) {
    if(modelTopics.some(value=>searchTopicsEquivalent(anchor,value)))return true;
    // A declined final component can be recognised only as part of the whole
    // compound. Every word of that source chunk must survive the match.
    for(let start=0;start<sourceTopics.length;start++)for(let end=start+2;end<=Math.min(sourceTopics.length,start+4);end++) {
      const chunk=sourceTopics.slice(start,end);if(!chunk.includes(anchor))continue;
      if(modelTopics.some(value=>searchTopicsEquivalent(chunk.join(' '),value)))return true;
    }
    return false;
  }
  if (topicAnchors.some(anchor=>!covered(anchor))) return null;
  const lower=normalizeSearchText(query);
  const groundedStatus= /не\s*(?:закончен|закончил|законч|заверш|закрыт)|незакончен|недодел|в\s+(?:работе|процессе)/u.test(lower) ? 'open'
    : /закончен|закончил|завершил|сделал|выполнил/u.test(lower) ? 'done' : null;
  const groundedType= /(?:^|\s)туду[\p{L}]*|(?:^|\s)тудуш[\p{L}]*/u.test(lower) ? 'task'
    : /(?:^|\s)записк[\p{L}]*/u.test(lower) ? 'note' : null;
  const groundedRole= /обязательств|обязал[\p{L}]*\s+себя/u.test(lower) ? 'promise'
    : /поручени|поручил/u.test(lower) ? 'requester' : 'related';
  const role=original.role!=='related' ? original.role : plan.role===groundedRole ? groundedRole : 'related';
  const exclusivePerson=original.exclusivePerson || role!=='related';
  const status=original.status!=='all' ? original.status : plan.status && plan.status===groundedStatus ? groundedStatus : 'all';
  const groundedBasis=/дедлайн|срок/u.test(lower) ? 'deadline' : /заплан|планов[\p{L}]*\s+дат/u.test(lower) ? 'scheduled'
    : /созда|добав|дат[\p{L}]*\s+создан/u.test(lower) ? 'created' : /выполн|заверш|закончил/u.test(lower) ? 'completed' : null;
  return { ...original, person: original.exclusivePerson || original.role !== 'related' ? original.person : person || null,
    type: original.type || (plan.type===groundedType ? groundedType : null), status,
    period: original.period || (plan.period && searchWords(query).some(token=>/^(?:сегодня|вчера|завтра|недел|месяц|год|понедельник|вторник|сред[ау]|четверг|пятниц|суббот|воскресен|январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)/u.test(token)) ? {from:plan.period.start,to:plan.period.end} : null),
    basis: original.basis !== 'createdOrCompleted' ? original.basis : status==='done' ? 'completed' : plan.basis===groundedBasis ? groundedBasis : 'createdOrCompleted',
    role, exclusivePerson,
    topicGroups: groups, terms: [], lexicalTerms: [] };
}

export function createAiTaskSearchService({ core, planSearch, canAccess = () => false, timeoutMs = 10000 }) {
  async function search(input) {
    const initialGeneration = core.generation?.(input.userId) || 0;
    const permitted = () => canAccess(input.userId) && (core.generation?.(input.userId) || 0) === initialGeneration
      && (!input.isCurrent || input.isCurrent()) && !input.signal?.aborted;
    const denied = () => ({items:[],matchedCount:0,hasMore:false,clarification:'Поиск сейчас недоступен.'});
    if (!permitted()) return denied();
    if (input.criteria) return core.search(input); // Stored page criteria never call a model.
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if(!query || query.length>1000)return core.search({...input,clarification:'Введите запрос длиной от 1 до 1000 символов.'});
    const literal = validateLiteralSearchDates(query);
    if (literal.clarification) return core.search({...input,clarification:literal.clarification});
    if (unsupportedQuery(query)) return core.search({...input,clarification:clarificationText.unsupported_semantics});
    if (/(?:^|\s)(?:в|на)\s+(?:понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)(?:\s|[?.!]|$)/iu.test(query)
      && !literal.dates.length && !/прошл|следующ|ближайш|недел/iu.test(query)) return core.search({...input,clarification:clarificationText.ambiguous_period});
    const parsed = parseTaskSearchQuery(query,{...input,allowNaturalPeriod:true});
    const controller = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal,controller.signal]) : controller.signal;
    let timer, onAbort;
    try {
      const timeout = new Promise((_,reject)=>{timer=setTimeout(()=>{reject(new Error('timeout'));controller.abort();},Math.max(1,Math.min(10000,timeoutMs)));});
      const aborted = input.signal ? new Promise((_,reject)=>{onAbort=()=>reject(new Error('aborted'));input.signal.addEventListener('abort',onAbort,{once:true});}) : null;
      const context = sanitizeSearchPlanContext({ referenceAt:(input.now || new Date()).toISOString(),timeZone:input.timeZone,previousCriteria:input.previousCriteria });
      const output = await Promise.race([Promise.resolve().then(()=> signal.aborted || !permitted() || typeof planSearch!=='function' ? {plan:null} : planSearch(query,context,{userId:input.userId,signal,isCurrent:permitted})),timeout,...(aborted?[aborted]:[])]);
      if (!permitted()) return denied();
      if (!output?.plan) return core.search(input);
      const plan = validateSearchPlan(output.plan);
      if (plan.clarification) return core.search({...input,clarification:clarificationText[plan.clarification]});
      const criteria = parsed.criteria && criteriaFromPlan(query,plan,parsed.criteria,input.previousCriteria);
      return criteria ? core.search({...input,criteria}) : core.search(input);
    } catch { return permitted() ? core.search(input) : denied(); }
    finally {clearTimeout(timer);if(onAbort)input.signal.removeEventListener('abort',onAbort);}
  }
  return { ...core,search,searchTasks:search,byId:input=>canAccess(input.userId) ? core.byId(input) : null };
}
