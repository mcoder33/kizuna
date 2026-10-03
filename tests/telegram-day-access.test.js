import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTelegramDaySummaryUserIds, createTelegramDaySummaryAccess } from '../server/telegram-day-access.js';
const owner='0c78ff8a-cdbb-43f4-a261-382d36b5ccec',other='0c78ff8a-cdbb-43f4-a261-382d36b5cced';
test('allowlist parses exact normalized UUIDs and denies the entire invalid or wildcard configuration',()=>{
 for(const value of [undefined,null,'',' ','*',owner+',*',owner+' invalid','not-a-uuid',owner+'x'])assert.equal(parseTelegramDaySummaryUserIds(value).size,0);
 const ids=parseTelegramDaySummaryUserIds(` ${owner.toUpperCase()},\n${other} ${owner} `);assert.deepEqual([...ids],[owner,other]);
 let value=owner;const access=createTelegramDaySummaryAccess({userIds:()=>value});assert.equal(access(owner),true);assert.equal(access(owner.toUpperCase()),true);assert.equal(access(other),false);assert.equal(access(owner.slice(0,-1)),false);assert.equal(access(null),false);
 value=owner+',*';assert.equal(access(owner),false);value=other;assert.equal(access(owner),false);assert.equal(access(other),true);value=undefined;assert.equal(access(other),false);
});
