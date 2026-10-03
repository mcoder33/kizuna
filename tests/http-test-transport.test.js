import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { fakeModelService } from './helpers/fake-model.js';
import { authed } from './helpers/auth.js';

function listen(server,port,host) {return new Promise((resolve,reject)=>{const failed=error=>reject(error);server.once('error',failed);server.listen(port,host,()=>{server.off('error',failed);resolve();});});}
async function close(server) {if(!server.listening)return;await new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();});}

test('test transport follows its listener family and preserves Origin Host despite a same-port IPv4 service',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pagent-http-transport-'));
  const app=createApp({databasePath:path.join(directory,'test.sqlite'),aiService:fakeModelService()});
  const wrapped=(req,res)=>{res.setHeader('X-Test-Local-Address',req.socket.localAddress);res.setHeader('X-Test-Logical-Host',req.headers.host);app(req,res);};
  const rogue=http.createServer((req,res)=>res.writeHead(501).end('different IPv4 service'));
  const ipv6=http.createServer(wrapped);
  t.after(async()=>{await close(ipv6);await close(rogue);app.closeEventStreams();app.accounts.stop();app.database.close();fs.rmSync(directory,{recursive:true,force:true});});
  await listen(rogue,0,'127.0.0.1');
  const api=authed(app,{target:wrapped});
  try {
    await listen(ipv6,rogue.address().port,'::');
    // macOS permits both binds; Supertest's 127.0.0.1 URL then hits the wrong
    // IPv4 service even though its supplied Server is the IPv6 application.
    const wrong=await fetch(`http://127.0.0.1:${rogue.address().port}/api/settings`);
    assert.equal(wrong.status,501);assert.equal(await wrong.text(),'different IPv4 service');
    const correct=await request(ipv6).get('/api/settings').set('Cookie',api.cookie).set('Origin',`http://127.0.0.1:${rogue.address().port}`).expect(200);
    assert.equal(correct.headers['x-test-local-address'],'::1');assert.equal(correct.headers['x-test-logical-host'],`127.0.0.1:${rogue.address().port}`);
  } catch(error) {
    // Platforms reserving the port across both address families prevent that
    // collision; the helper still must prove it uses the actual listener family below.
    if(!['EADDRINUSE','EAFNOSUPPORT'].includes(error.code))throw error;
  }
  const actual=await api.get('/api/settings').expect(200);
  assert.ok(['::1','127.0.0.1'].includes(actual.headers['x-test-local-address']));assert.match(actual.headers['x-test-logical-host'],/^127\.0\.0\.1:/);assert.ok(actual.body.settings);
  const again=await api.get('/api/settings').expect(200);assert.ok(['::1','127.0.0.1'].includes(again.headers['x-test-local-address']));
});
