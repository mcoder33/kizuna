const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const script = fs.readFileSync(`${__dirname}/../Resources/CaptureAppearance.js`, 'utf8');
function fixture() {
  const posted = [], observers = [], listeners = new Map();
  const root = {dataset:{theme:'dark'}}, field = {id:'capture-input', dataset:{placeholder:'О чём думаете?'}};
  const foot = {}, button = {}, form = {querySelector:()=>foot};
  const values = {'--capture-line':'#49403b', '--capture-focus-line':'#ab7873', '--capture-button':'#e94a69', '--capture-button-hover':'#f05b77'};
  const style = {backgroundImage:'linear-gradient(145deg, rgb(41, 39, 37), rgb(36, 35, 34) 76%)',borderTopLeftRadius:'23px',paddingTop:'24px', getPropertyValue:k=>values[k]||''};
  let present = true, systemDark = false;
  const document = {documentElement:root,body:{},querySelector:k=>present?({'#capture-form':form,'#capture-input':field,'#capture-submit':button}[k]):null};
  const context = {document,window:{webkit:{messageHandlers:{kizunaCaptureAppearance:{postMessage:v=>posted.push(v)}}},addEventListener:(k,f)=>listeners.set(k,f)},
    matchMedia:()=>({matches:systemDark,addEventListener:(k,f)=>listeners.set('scheme',f)}),clearTimeout:()=>{},setTimeout:()=>1,
    MutationObserver:class {constructor(f){observers.push(f)} observe(){}},
    getComputedStyle:(element)=>element===form?style:element===field?{color:'rgb(237, 230, 223)',caretColor:'rgb(242, 169, 156)',fontSize:'17px',lineHeight:'24.65px'}:{color:'rgb(32, 32, 30)',backgroundColor:'rgb(233, 74, 105)'}};
  vm.runInNewContext(script,context);
  return {posted,root,field,style,values,observers,listeners,remove:()=>present=false,system:dark=>{systemDark=dark;listeners.get('scheme')();}};
}
test('reads the rendered graphite field and deduplicates unchanged snapshots',()=>{
  const f=fixture(); assert.equal(f.posted.length,1);
  assert.equal(f.posted[0].surface,'rgb(41, 39, 37)');assert.equal(f.posted[0].button,'#e94a69');
  f.listeners.get('focus')();assert.equal(f.posted.length,1);
});
test('auto follows system changes and reports the mode separately from the resolved color',()=>{
  const f=fixture();delete f.root.dataset.theme;f.observers[0]();
  assert.equal(f.posted.at(-1).theme,'system');assert.equal(f.posted.at(-1).dark,false);
  f.system(true);assert.equal(f.posted.at(-1).dark,true);assert.equal(f.posted.at(-1).theme,'system');
  f.root.dataset.theme='light';f.observers[0]();
  f.system(false);f.system(true);assert.equal(f.posted.at(-1).dark,false);assert.equal(f.posted.at(-1).theme,'light');
  f.root.dataset.theme='dark';f.observers[0]();f.system(false);
  assert.equal(f.posted.at(-1).dark,true);assert.equal(f.posted.at(-1).theme,'dark');
});
test('follows theme, font and translated placeholder changes without changing the draft',()=>{
  const f=fixture();f.root.dataset.theme='light';f.root.dataset.font='mono';f.style.backgroundImage='none';f.style.backgroundColor='rgb(255, 255, 255)';
  f.observers[0]();assert.equal(f.posted.at(-1).dark,false);assert.equal(f.posted.at(-1).font,'mono');
  assert.equal(f.posted.at(-1).surfaceEnd,'rgb(255, 255, 255)');
  f.field.dataset.placeholder='What is on your mind?';f.observers[1]([{target:f.field,addedNodes:[]}]);
  assert.equal(f.posted.at(-1).placeholder,'What is on your mind?');
  f.remove();f.listeners.get('pagent:resume')();assert.equal(f.posted.length,3);
});
