import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {buildWindow,shouldRun,publicationDeadline,etMidnight} from '../lib/calendar.mjs';
import {prepareCandidates} from '../lib/editorial.mjs';
import {runPipeline} from '../lib/pipeline.mjs';
import {checkPublication} from '../check-publication.mjs';
import {makeHandler} from '../lib/dispatch.mjs';
import {isFirstWeekdayOfMonth} from '../lib/dates.mjs';
import {openIssueStore} from '../lib/issue-store.mjs';
import {sandbox,sample,fakeClient,replayEnv} from './helpers.mjs';

test('same-day weekly and monthly keep separate completed ET periods and deadlines',()=>{
 const now=new Date('2026-11-02T07:00:00Z'),week=buildWindow('weekly',now),month=buildWindow('monthly',now);
 assert.equal(week.periodStart,'2026-10-26');assert.equal(week.periodEnd,'2026-11-01');assert.equal(week.upper,Date.parse('2026-11-02T05:00:00Z'));
 assert.equal(month.upper,Date.parse('2026-11-01T04:00:00Z'));assert.equal(month.periodStart,'2026-10-01');assert.equal(month.periodEnd,'2026-10-31');
 assert.equal(publicationDeadline('weekly',now),Date.parse('2026-11-02T07:00:00Z'));assert.equal(publicationDeadline('monthly',now),Date.parse('2026-11-02T08:00:00Z'));
});

test('weekly boundaries follow ET calendar across DST, year end and retries',()=>{
 for(const [date,start,end,hours] of [['2026-03-09','2026-03-02','2026-03-08',167],['2026-11-02','2026-10-26','2026-11-01',169],['2027-01-04','2026-12-28','2027-01-03',168]]){
  const w=buildWindow('weekly',new Date(date+'T06:00:00Z'));assert.equal(w.periodStart,start);assert.equal(w.periodEnd,end);assert.equal(w.hours,hours);assert.equal(w.timezone,'America/New_York');
  assert.deepEqual(buildWindow('weekly',new Date(date+'T12:00:00Z')),w);
 }
 assert.throws(()=>buildWindow('weekly',new Date('2026-11-02T04:59:59Z')),/cutoff has not arrived/);
});

test('weekly and monthly include lower boundary and exclude next period midnight',()=>{
 const now=new Date('2026-11-02T07:00:00Z');
 for(const kind of ['weekly','monthly']){
  const w=buildWindow(kind,now),rows=[sample('before',w.lower-1),sample('start',w.lower),sample('last',w.upper-1),sample('next',w.upper)];
  assert.deepEqual(new Set(prepareCandidates(rows,w).candidates.map(it=>it.id)),new Set(['start','last']));
 }
});

test('first weekday monthly gate handles weekend starts and weekdays other than Monday',()=>{
 for(const date of ['2026-08-03','2026-11-02','2026-12-01','2027-01-01']){
  assert(isFirstWeekdayOfMonth(new Date(date+'T07:00:00Z')));assert(shouldRun('monthly',new Date(date+'T07:00:00Z')));
  assert(!shouldRun('monthly',new Date(date+'T06:59:59Z')));
 }
 for(const date of ['2026-08-01','2026-08-02','2026-11-01','2026-12-07'])assert(!shouldRun('monthly',new Date(date+'T08:00:00Z')));
 const leap=buildWindow('monthly',new Date('2028-03-01T07:00:00Z'));assert.equal(leap.periodEnd,'2028-02-29');assert.equal(leap.hours,696);
});

test('periodic API gates skip early times before credentials or GitHub dispatch',async()=>{
 const old=process.env.CRON_SECRET;delete process.env.CRON_SECRET;
 try{for(const [kind,time] of [['weekly','2026-11-02T05:59:59Z'],['monthly','2026-11-02T06:59:59Z']]){
  let calls=0,body;const handler=makeHandler(kind,{now:()=>new Date(time),fetchImpl:async()=>{calls++;throw Error('unexpected dispatch');}});
  await handler({headers:{}},{status(){return this;},json(value){body=value;}});assert.equal(body.skipped,true);assert.equal(calls,0);
 }}finally{if(old!==undefined)process.env.CRON_SECRET=old;}
});

test('observer uses 15:00 weekly and 16:00 monthly targets with no pending monthly policy',async()=>{
 for(const [kind,time,deadline] of [['weekly','2026-11-02T06:30:00Z','2026-11-02T07:00:00Z'],['monthly','2026-11-02T07:30:00Z','2026-11-02T08:00:00Z']]){
  const result=await checkPublication({kind,now:new Date(time),runs:[],fetchImpl:async()=>new Response('',{status:404})});
  assert.equal(result.deadline,Date.parse(deadline));assert.equal(result.deadline_compliance,'not_due');assert.equal(result.deadline_policy_pending,undefined);
  const late=await checkPublication({kind,now:new Date(Date.parse(deadline)+1),runs:[],fetchImpl:async()=>new Response('',{status:404})});assert.equal(late.deadline_compliance,'missed');
 }
});

test('actual can-run entrypoint exports the matching periodic deadline for workflow budgets',async t=>{
 const root=await sandbox(t),now='2026-11-02T07:00:00Z';
 const clock=`const OriginalDate=Date;globalThis.Date=class extends OriginalDate{constructor(...args){super(...args.length?args:[${JSON.stringify(now)}]);}static now(){return OriginalDate.parse(${JSON.stringify(now)});}}`;
 for(const kind of ['weekly','monthly']){
  const envFile=path.join(root,kind+'.env-output'),output=path.join(root,kind+'.outputs');
  const env={...process.env,GITHUB_ENV:envFile,GITHUB_OUTPUT:output,FORCE_RUN:'0',ISSUE_REVISION:'',EXPECTED_PERIOD:'',EXPECTED_CUTOFF:''};
  const result=await promisify(execFile)(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(clock),fileURLToPath(new URL('../can-run.mjs',import.meta.url)),kind],{cwd:root,env});
  assert.equal(JSON.parse(result.stdout).go,true);assert.match(await fs.readFile(envFile,'utf8'),new RegExp('PUBLICATION_DEADLINE_MS='+publicationDeadline(kind,new Date(now))));
 }
});

test('monthly generation succeeds independently after same-day weekly writer failure',async t=>{
 const root=await sandbox(t),now='2026-11-02T07:00:00Z';
 const env=await replayEnv(root,{items:[sample('shared',Date.parse('2026-10-30T14:00:00Z')),sample('november',Date.parse('2026-11-01T22:00:00Z'))],coverage_snapshots:[]},now);
 await assert.rejects(runPipeline('weekly',{root,env,client:fakeClient({failWriter:true})}),/Writer failed/);
 const result=await runPipeline('monthly',{root,env,client:fakeClient()});assert.equal(result.period_label,'2026-10');assert.deepEqual(result.items.map(it=>it.id),['shared']);
 await assert.rejects(fs.access(path.join(root,'data/weekly/latest.json')),{code:'ENOENT'});
});

test('switching this week to ET midnight cannot overwrite the old frozen revision or its budget',async t=>{
 const root=await sandbox(t),stateDir=path.join(root,'state'),oldUpper=Date.parse('2026-11-01T21:00:00Z');
 const old=await openIssueStore(stateDir,{kind:'weekly',period:'2026-10-26',upper:oldUpper,revision:1,rules:'old-rules',model:'gpt-6.1-sol'});
 await old.recordAttempt('writer',{request_id:'saved-attempt'});
 const file=path.join(old.dir,'manifest.json'),before=await fs.readFile(file,'utf8'),current=buildWindow('weekly',new Date('2026-11-02T07:00:00Z'));
 assert.equal((current.upper-oldUpper)/3600000,8);
 await assert.rejects(openIssueStore(stateDir,{kind:'weekly',period:'2026-10-26',upper:current.upper,revision:1,rules:'new-rules',model:'gpt-6.1-sol'}),/incompatible/);
 assert.equal(await fs.readFile(file,'utf8'),before);
});

test('article dates stay absolute across access times, languages and source precisions',async()=>{
 const app=await fs.readFile(new URL('../../public/app.js',import.meta.url),'utf8'),ctx={currentLang:'zh'};
 vm.createContext(ctx);vm.runInContext(app.slice(app.indexOf('function articleDate('),app.indexOf('// "2026-05-28"')),ctx);
 const precise={published_at:Date.parse('2026-11-02T00:30:00Z'),date_precision:'timestamp'};
 assert.equal(ctx.articleDate(precise).label,'2026-11-01');assert.match(ctx.articleDate(precise).title,/19:30/);
 const day={published_at:etMidnight('2026-10-30')+12*3600000,date_precision:'day',published_date:'2026-10-30'};
 assert.equal(ctx.articleDate(day).label,'2026-10-30');assert.match(ctx.articleDate(day).title,/未确认/);
 assert.match(ctx.articleDate({published_at:precise.published_at}).title,/未确认/);
 vm.runInContext('Date.now = () => 0',ctx);const before=ctx.articleDate(precise).label;vm.runInContext('Date.now = () => 9999999999999',ctx);assert.equal(ctx.articleDate(precise).label,before);
 ctx.currentLang='en';assert.equal(ctx.articleDate(precise).label,before);assert.match(ctx.articleDate(day).title,/unconfirmed/);assert.equal(ctx.articleDate({}).label,'');
 assert(!app.includes('d ago'));assert(!app.includes('function timeAgo('));
});

test('period banner preserves real legacy Beijing cutoff and shows new ET calendar window',async()=>{
 const app=await fs.readFile(new URL('../../public/app.js',import.meta.url),'utf8'),ctx={currentLang:'zh'};vm.createContext(ctx);vm.runInContext(app.slice(app.indexOf('function articleDate('),app.indexOf('// "2026-05-28"')),ctx);
 const old={kind:'weekly',window:{lower:1792962000000,upper:1793566800000,timezone:'Asia/Shanghai'}};
 assert.match(ctx.periodWindowText(old),/2026-10-26 05:00.*2026-11-02 05:00（北京）/);
 const current={kind:'weekly',window:buildWindow('weekly',new Date('2026-11-02T07:00:00Z'))};assert.match(ctx.periodWindowText(current),/2026-10-26 00:00.*2026-11-02 00:00（美东）/);
});

test('language switch keeps periodic coverage instead of replacing it with the daily window message',async()=>{
 const app=await fs.readFile(new URL('../../public/app.js',import.meta.url),'utf8');
 const ctx={currentLang:'en',currentMode:'monthly',currentData:{kind:'monthly',generated_at:1,window:buildWindow('monthly',new Date('2026-11-02T07:00:00Z')),_diagnostics:{window_hours:744}},document:{documentElement:{}},langSeg:{querySelectorAll:()=>[]},digestTabs:{querySelectorAll:()=>[]},$:()=>({}),t:()=>({window_banner:()=> 'daily-window-fallback'}),updatedEl:{},renderBrief:()=>{},renderThemes:()=>{},applyFilter:()=>{},themesBlock:{hidden:true},windowBanner:{hidden:false,textContent:''},formatUpdated:()=>''};
 vm.createContext(ctx);vm.runInContext(app.slice(app.indexOf('function articleDate('),app.indexOf('// "2026-05-28"')),ctx);
 vm.runInContext(app.slice(app.indexOf('function applyLanguage()'),app.indexOf("langSeg.addEventListener('click'")),ctx);ctx.applyLanguage();assert.match(ctx.windowBanner.textContent,/Coverage:.*2026-10-01.*ET/);
});
