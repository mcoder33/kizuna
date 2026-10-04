import { randomUUID } from 'node:crypto';

// Only fictional cached events; no calendar connection or external requests.
export function seedWorkshopCalendar(db, userId, day) {
  const accountId = randomUUID(), calendarId = randomUUID();
  const calendars = [{ id: calendarId, url: 'https://calendar.example.test/workshop/', name: 'Мастерская', color: '#3b82f6', selected: true, writable: false }];
  db.prepare(`INSERT INTO calendar_accounts(id,user_id,provider,preset,label,color,mode,server_url,username,credentials_enc,calendars_json,synced_at,created_at,auto_export)
    VALUES(?,?,'caldav','custom','Мастерская','#3b82f6','full','https://calendar.example.test','preview@example.test','v1.x',?,datetime('now'),datetime('now'),'off')`)
    .run(accountId, userId, JSON.stringify(calendars));
  const insert = db.prepare(`INSERT INTO calendar_events(id,account_id,calendar_id,uid,title,start_at,end_at,all_day,busy,updated_at)
    VALUES(?,?,?,?,?,?,?,0,1,datetime('now'))`);
  for (const [title, start, end] of [['Обсудить идеи с командой', '05:00', '05:30'], ['Утренний созвон', '07:00', '07:30'], ['Посмотреть новые наброски', '08:30', '09:30']]) {
    const id = randomUUID();
    insert.run(id, accountId, calendarId, id, title, `${day}T${start}:00.000Z`, `${day}T${end}:00.000Z`);
  }
}
