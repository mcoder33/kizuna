const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,'../Sources/App.swift'),'utf8');
const script = source.match(/let localeBridge = """\n([\s\S]*?)\n        """/)[1];
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
 const pending=[],posted=[],listeners=new Map();
 const window={webkit:{messageHandlers:{kizunaLocale:{postMessage:value=>posted.push(value)}}},addEventListener:(name,listener)=>listeners.set(name,listener)};
 vm.runInNewContext(script,{window,fetch:(url,options)=>new Promise(resolve=>pending.push({url,options,resolve}))});
 return {pending,posted,listeners,complete:(index,locale,status=200,detectedLocale=null)=>pending[index].resolve({ok:status===200,json:async()=>({settings:{locale,detectedLocale}})})};
}
test('native refetch occurs only after committed save, including same resolved mode',async()=>{
 const state=fixture();state.complete(0,'system');await flush();
 assert.equal(JSON.stringify(state.posted),JSON.stringify([{requestedLocale:'system',detectedLocale:null}]));
 assert.equal(state.listeners.has('pagent:localechange'),false);
 assert.equal(state.listeners.has('pagent:localesaved'),true);
 state.listeners.get('pagent:localesaved')({detail:{locale:'en',requestedLocale:'en'}});
 assert.equal(state.pending.length,2);assert.equal(state.pending[1].options.cache,'no-store');
 state.complete(1,'en');await flush();assert.equal(JSON.stringify(state.posted),JSON.stringify([{requestedLocale:'system',detectedLocale:null},{requestedLocale:'en',detectedLocale:null}]));
});
test('late pre-save fetch cannot overwrite committed account locale',async()=>{
 const state=fixture();state.listeners.get('pagent:localesaved')();
 state.complete(1,'ja');await flush();state.complete(0,'system');await flush();
 assert.equal(JSON.stringify(state.posted),JSON.stringify([{requestedLocale:'ja',detectedLocale:null}]));
 state.listeners.get('focus')();state.complete(2,'unused',401);await flush();
 assert.equal(JSON.stringify(state.posted),JSON.stringify([{requestedLocale:'ja',detectedLocale:null},{requestedLocale:'system',detectedLocale:null}]));
});

test('authoritative snapshot includes detection for unsupported macOS language fallback',async()=>{
 const state=fixture();state.complete(0,'system',200,'en');await flush();
 assert.equal(JSON.stringify(state.posted),JSON.stringify([{requestedLocale:'system',detectedLocale:'en'}]));
 state.listeners.get('pagent:localesaved')();state.complete(1,'system',200,'ja');await flush();
 assert.equal(state.posted[1].requestedLocale,'system');assert.equal(state.posted[1].detectedLocale,'ja');
});
