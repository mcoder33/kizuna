import test from 'node:test'; import assert from 'node:assert/strict';
import {serializeNotification} from '../server/notifications.js';
import {catalogs} from '../public/i18n-catalog.js';
test('notification templates translate only system fields and historic data stays intact',()=>{
 catalogs.en.__lead='A reminder:';
 const row={id:'id',kind:'reminder',lead:'Исходный текст',text:'山田 — проект',read_at:'2026-10-02',data_json:JSON.stringify({meta:['имя проекта'],template:{lead:{source:'__lead'}}})};
 const view=serializeNotification(row,'en');assert.equal(view.lead,'A reminder:');assert.equal(view.text,row.text);assert.equal(view.read,true);assert.deepEqual(view.meta,['имя проекта']);assert.equal(view.id,'id');
 assert.equal(serializeNotification({...row,data_json:'{}'},'en').lead,row.lead);
 delete catalogs.en.__lead;
});

test('structured calendar and reminder metadata follows locale without rewriting history',()=>{
 const data={meta:['02.10, весь день','Команда 山田'],calendarPresentation:{when:{startAt:'2026-10-02T00:00:00Z',endAt:'2026-10-03T00:00:00Z',allDay:true,timeZone:'UTC',sameDay:false}},template:{text:{source:'«{title}» — теперь {when}',params:{title:'Название 山田',when:'02.10, весь день'}}}};
 const row={id:'calendar-id',kind:'event_changed',text:'Название 山田',data_json:JSON.stringify(data)};
 const before=row.data_json;
 const ru=serializeNotification(row,'ru'),en=serializeNotification(row,'en');
 assert.ok(ru.meta[0].includes('02.10')); assert.ok(en.meta[0].includes('October'));
 assert.ok(en.text.includes('Название 山田'));assert.equal(en.meta[1],'Команда 山田');assert.equal(row.data_json,before);
 const reminder={...row,kind:'reminder',data_json:JSON.stringify({meta:['сегодня, 12:00','дело'],reminderSchedule:{date:'2026-10-02',time:'12:00',end:null,daySource:null,meeting:false,leadMinutes:15}})};
 assert.ok(serializeNotification(reminder,'en').meta[0].includes('October'));assert.equal(serializeNotification(reminder,'en').text,row.text);
});

import {createGoogleCalendarClient} from '../server/google-calendar.js';
test('Google fallback errors carry typed presentation while provider messages stay original',async()=>{
 const generic=createGoogleCalendarClient({fetch:async()=>new Response('upstream',{status:503})});
 await assert.rejects(generic.listCalendars('token'),error=>{assert.equal(error.code,'google_error');assert.equal(error.status,503);assert.deepEqual(error.presentation,{source:'Google ответил {status}.',params:{status:503}});return true;});
 const supplied=createGoogleCalendarClient({fetch:async()=>new Response(JSON.stringify({error:{message:'Provider 山田 message'}}),{status:403})});
 await assert.rejects(supplied.listCalendars('token'),error=>{assert.equal(error.message,'Provider 山田 message');assert.equal(error.presentation,undefined);return true;});
});
