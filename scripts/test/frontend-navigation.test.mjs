import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const app = await fs.readFile(new URL('../../public/app.js', import.meta.url), 'utf8');
class Element {
  constructor() { this.children = []; this.hidden = false; this.textContent = ''; this.dataset = {}; this.classList = { toggle() {} }; }
  replaceChildren(...nodes) { this.children = nodes; }
  appendChild(node) { this.children.push(node); }
  setAttribute(name, value) { this[name] = value; }
  set innerHTML(value) { this.children = []; this.html = value; }
}
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const response = (data, status=200) => ({ ok: status<400, status, async json() { return data; } });
const issue = (kind, period) => ({ kind, items:[{id:kind}], ...(kind==='daily'?{date:period}:kind==='weekly'?{period_start:period}:{period_label:period}) });
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(fetch) {
  const ids = Object.fromEntries(['briefBlock','briefText','coverageNote','researchCoverage','researchStatus','sourcesCount'].map(id=>[id,new Element()]));
  const list=new Element(), themes=new Element();themes.querySelector=()=>new Element();
  const labels={zh:{loading:'加载中',load_failed:'加载失败',load_failed_hint:'请重试',monthly_not_yet:'月报暂未发布',monthly_not_yet_hint:'稍后查看',invalid_data:'错误期刊',archive_missing:p=>'归档不可读取 '+p},en:{loading:'Loading',load_failed:'Failed to load',load_failed_hint:'Try again',monthly_not_yet:'Not published',monthly_not_yet_hint:'Check later',invalid_data:'Wrong issue',archive_missing:p=>'Archive unavailable '+p}};
  const ctx={calendarDialog:{open:false},AbortController,fetch,document:{createElement:()=>new Element()},$:id=>ids[id],newsList:list,filterbar:new Element(),themesBlock:themes,windowBanner:new Element(),updatedEl:new Element(),currentMode:'daily',currentData:issue('daily','2026-11-06'),loadSerial:0,activeLoad:null,loadStatus:'ready',loadFailure:null,indexFailures:{daily:false,weekly:false,monthly:false},availableDates:new Set(['2026-11-05']),weeklyPeriods:['2026-10-19'],monthlyPeriods:['2026-09'],selectedDate:'2026-11-06',selectedWeekly:null,selectedMonthly:null,initialDataConsumed:true,currentLang:'zh',t:()=>labels[ctx.currentLang],readInlineInitialData:()=>null,digestTabs:{querySelectorAll:()=>['daily','weekly','monthly'].map(mode=>Object.assign(new Element(),{dataset:{tab:mode}}))},location:{hash:'',pathname:'/'},history:{replaceState(_s,_t,url){ctx.location.hash=url.includes('#')?'#'+url.split('#')[1]:'';}},renders:[],commits:[]};
  ctx.renderPeriodStrip=mode=>ctx.renders.push(mode);
  ctx.applyLoadedData=data=>{ctx.currentData=data;ctx.loadStatus='ready';ctx.loadFailure=null;ctx.filterbar.hidden=false;ctx.rememberLoadedPeriod(data,ctx.currentMode);ctx.commits.push(data.kind);};
  vm.createContext(ctx);
  vm.runInContext(app.slice(app.indexOf('function digestDataUrl('),app.indexOf('function initialMode(')),ctx);
  vm.runInContext(app.slice(app.indexOf('function isCurrentLoad('),app.indexOf('// Render the period strip')),ctx);
  return {ctx,ids,list};
}
function indexes(url) { return response(url.includes('weekly')?['2026-10-26']:url.includes('monthly')?['2026-10']:['2026-11-05','2026-11-06']); }
test('late weekly content and errors cannot overwrite a newer monthly navigation', async()=>{
  for(const fail of [false,true]) {
    const old=deferred();const {ctx}=harness(url=>url.endsWith('dates.json')?Promise.resolve(indexes(url)):url.includes('weekly')?old.promise:Promise.resolve(response(issue('monthly','2026-10'))));
    const previous=ctx.loadIssue('weekly');await tick();await ctx.loadIssue('monthly');const marker=ctx.renders.length;
    if(fail)old.reject(new Error('Old request failed'));else old.resolve(response(issue('weekly','2026-10-26')));
    await previous;assert.equal(ctx.currentMode,'monthly');assert.equal(ctx.currentData.kind,'monthly');assert.equal(ctx.loadStatus,'ready');assert.equal(ctx.renders.length,marker);
  }
});
test('late date index cannot steal startup or refresh navigation and does not block content',async()=>{
  for(const period of [null,'2026-11-05']){
    const index=deferred();const {ctx}=harness(url=>url==='/data/dates.json'?index.promise:url.endsWith('dates.json')?Promise.resolve(indexes(url)):Promise.resolve(response(url.includes('weekly')?issue('weekly','2026-10-26'):issue('daily',period||'2026-11-06'))));
    const old=ctx.loadIssue('daily',period);await tick();assert.equal(ctx.currentData.kind,'daily','Body can render while index is pending');
    await ctx.loadIssue('weekly');const marker=ctx.renders.length;index.resolve(response(['2026-01-01']));await old;
    assert.equal(ctx.currentMode,'weekly');assert.equal(ctx.currentData.kind,'weekly');assert.equal(ctx.renders.length,marker);assert(!ctx.availableDates.has('2026-01-01'));
  }
});
test('late weekly index cannot replace monthly period strip',async()=>{
  const oldIndex=deferred();const {ctx}=harness(url=>url==='/data/weekly/dates.json'?oldIndex.promise:url.endsWith('dates.json')?Promise.resolve(indexes(url)):Promise.resolve(response(issue(url.includes('weekly')?'weekly':'monthly',url.includes('weekly')?'2026-10-26':'2026-10'))));
  const old=ctx.loadIssue('weekly');await tick();await ctx.loadIssue('monthly');const marker=ctx.renders.length;oldIndex.resolve(response(['2026-06-01']));await old;assert.equal(ctx.renders.length,marker);assert.equal(ctx.currentData.kind,'monthly');
});
test('rapid date changes use period as well as mode identity',async()=>{
  const old=deferred();const {ctx}=harness(url=>url.endsWith('dates.json')?Promise.resolve(indexes(url)):url.includes('11-05')?old.promise:Promise.resolve(response(issue('daily','2026-11-06'))));
  const pending=ctx.loadIssue('daily','2026-11-05');await ctx.loadIssue('daily','2026-11-06');old.resolve(response(issue('daily','2026-11-05')));await pending;assert.equal(ctx.currentData.date,'2026-11-06');assert.equal(ctx.selectedDate,'2026-11-06');
});
test('failed load clears old dependent content and language re-render keeps the failure',async()=>{
  const {ctx,ids,list}=harness(url=>url.endsWith('dates.json')?Promise.resolve(indexes(url)):Promise.reject(new Error('Offline')));
  await ctx.loadIssue('monthly');assert.equal(ctx.currentData,null);assert.equal(ids.briefBlock.hidden,true);assert.equal(ids.researchCoverage.hidden,true);assert.equal(ctx.filterbar.hidden,true);assert.match(list.children[0].textContent,/加载失败/);
  ctx.currentLang='en';ctx.renderLoadStatus();assert.equal(ctx.currentData,null);assert.match(list.children[0].textContent,/Failed to load/);assert.equal(ctx.commits.length,0);
});
test('archive 404 differs from latest-month not-yet-published and can be retried',async()=>{
  let missing=true;const {ctx,list}=harness(url=>url.endsWith('dates.json')?Promise.resolve(indexes(url)):Promise.resolve(missing?response({},404):response(issue('monthly','2026-10'))));
  await ctx.loadIssue('monthly','2026-09');assert.match(list.children[0].textContent,/归档不可读取 2026-09/);
  await ctx.loadIssue('monthly');assert.equal(list.children[0].textContent,'月报暂未发布');
  missing=false;await ctx.loadIssue('monthly');assert.equal(ctx.loadStatus,'ready');assert.equal(ctx.currentData.kind,'monthly');
});
test('index failure retains known dates while body stays readable, then clears on retry',async()=>{
  let bad=true;const {ctx}=harness(url=>url.endsWith('dates.json')?(bad?Promise.resolve(response({},503)):Promise.resolve(response(['2026-11-06']))):Promise.resolve(response(issue('daily','2026-11-06'))));
  await ctx.loadIssue('daily');assert.equal(ctx.loadStatus,'ready');assert(ctx.availableDates.has('2026-11-05'));assert(ctx.availableDates.has('2026-11-06'));assert.equal(ctx.indexFailures.daily,true);
  bad=false;await ctx.loadIssue('daily');assert.equal(ctx.indexFailures.daily,false);
});
test('wrong kind and wrong archive period are rejected before commit',async()=>{
  for(const data of [issue('weekly','2026-10-26'),issue('monthly','2026-09')]){
    const {ctx}=harness(url=>Promise.resolve(url.endsWith('dates.json')?indexes(url):response(data)));await ctx.loadIssue('monthly','2026-10');assert.equal(ctx.currentData,null);assert.equal(ctx.loadStatus,'error');assert.equal(ctx.commits.length,0);
  }
});
test('invalid issue errors translate with the active language after failure',async()=>{
  const {ctx,list}=harness(url=>Promise.resolve(url.endsWith('dates.json')?indexes(url):response(issue('weekly','2026-10-26'))));
  await ctx.loadIssue('monthly');
  for(const [lang,text] of [['zh','错误期刊'],['en','Wrong issue'],['zh','错误期刊']]) {
    ctx.currentLang=lang;ctx.renderLoadStatus();assert.match(list.children[0].textContent,new RegExp(text));
    if(lang==='en')assert.doesNotMatch(list.children[0].textContent,/\p{Script=Han}/u);
  }
});
test('a render failure clears partially assigned data before displaying the error',async()=>{
  const {ctx,ids,list}=harness(url=>Promise.resolve(url.endsWith('dates.json')?indexes(url):response(issue('monthly','2026-10'))));
  ctx.applyLoadedData=data=>{ctx.currentData=data;ctx.loadStatus='ready';ids.briefBlock.hidden=false;throw new TypeError('Malformed card');};
  await ctx.loadIssue('monthly');assert.equal(ctx.currentData,null);assert.equal(ctx.loadStatus,'error');
  assert.equal(ids.briefBlock.hidden,true);assert.equal(ctx.filterbar.hidden,true);assert.match(list.children[0].textContent,/Malformed card/);
  ctx.currentLang='en';ctx.renderLoadStatus();assert.match(list.children[0].textContent,/Failed to load/);assert.equal(ctx.currentData,null);
});
test('a late current daily index refreshes an already opened calendar',async()=>{
  const index=deferred();const {ctx}=harness(url=>url.endsWith('dates.json')?index.promise:Promise.resolve(response(issue('daily','2026-11-06'))));
  let renders=0;ctx.calendarDialog.open=true;ctx.renderCalendar=()=>{renders++;assert(ctx.availableDates.has('2026-11-05'));};
  const pending=ctx.loadIssue('daily');await tick();assert.equal(renders,0);
  index.resolve(response(['2026-11-05','2026-11-06']));await pending;assert.equal(renders,1);
});
