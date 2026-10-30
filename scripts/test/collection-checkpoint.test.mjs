import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {sourceLower,stageCapture,finishCapture,mergeCheckpoints,stageSupplement} from '../lib/collection-checkpoint.mjs';
import {createCollector} from '../lib/sources.mjs';
import {runPipeline} from '../lib/pipeline.mjs';
import {buildWindow} from '../lib/calendar.mjs';
import {sandbox,sample,fakeClient} from './helpers.mjs';
const sources=[{id:'a',required:true},{id:'b',required:true}];
const lower=Date.parse('2026-10-26T21:00:00Z'),upper=Date.parse('2026-10-27T21:00:00Z');
const health=id=>({id,required:true,status:'ok',articles:1,undated:0,coverage:{lower,upper}});
const story=id=>({...sample(id+'-story',Date.parse('2026-10-27T18:00:00Z')),source_id:id,source_family:id});

test('per-source cursors advance only on verified coverage and retain failed source floors',()=>{
 const staged=stageCapture({},sources,[{items:[story('a')],health:health('a')},{items:[],health:{id:'b',required:true,status:'error'}}],{lower,upper});
 assert.equal(staged.checkpoint.source_upper.a,upper);assert.equal(staged.checkpoint.source_upper.b,undefined);
 assert.equal(sourceLower(staged.checkpoint,'b',upper),lower);assert.equal(staged.capture.items.length,1);
 const partial=stageCapture({},sources,[{items:[story('a')],health:{...health('a'),article_errors:[{error:'timeout'}]}}],{lower,upper});
 assert.equal(partial.checkpoint.source_upper.a,undefined);
 const undated=stageCapture({},sources,[{items:[story('a')],health:{...health('a'),undated:1}}],{lower,upper});assert.equal(undated.checkpoint.source_upper.a,undefined);
});
test('capturing after cutoff never consumes post-cutoff stories and preserves pending batches',()=>{
 const future={...story('a'),id:'after',title:'A different apartment rental market survey report',link:'https://example.com/after',published_at:upper+1};
 const staged=stageCapture({},sources,[{items:[story('a'),future],health:health('a')}],{lower,upper},null,upper+3*3600000);
 assert.deepEqual(staged.capture.items.map(x=>x.id),['a-story']);assert.equal(staged.checkpoint.source_upper.a,upper);
 const next=stageCapture(staged.checkpoint,sources,[],{lower:upper,upper:upper+86400000});
 assert.ok(next.capture.items.some(x=>x.id==='a-story'));assert.equal(next.capture.window.lower,upper);
});
test('collector applies source-specific lower bounds rather than a global lookback',async()=>{
 const old=lower-7*86400000;
 const body='Original housing research on sales inventory and affordability. '.repeat(5);
 const xml='<rss><item><title>Older original research</title><link>https://example.com/old</link><description>'+body+'</description><pubDate>Mon, 19 Oct 2026 14:00:00 GMT</pubDate></item></rss>';
 const results=await createCollector({now:upper,lower,lowerBySource:{a:old},fetchImpl:async()=>new Response(xml)}).collect(sources.map(s=>({...s,url:'https://example.com/'+s.id,type:'rss'})));
 assert.equal(results[0].health.coverage.lower,old);assert.equal(results[1].health.coverage.lower,lower);
});
test('failed writer resumes its frozen selection; an explicit revision can recover a failed source',async t=>{
 const root=await sandbox(t);await fs.writeFile(path.join(root,'config/sources.json'),JSON.stringify({sources}));
 await fs.writeFile(path.join(root,'data/latest.json'),JSON.stringify({date:'2026-10-27',generated_at:lower}));
 const env={PUBLISH_NOW:'2026-10-28T00:30:00Z',NEWS_DATA_DIR:path.join(root,'data'),NEWS_STATE_DIR:path.join(root,'state')};
 const calls=[];let retry=false;
 const collector={cache:{},enrich:async x=>x,collect:async ss=>{calls.push(ss.map(s=>s.id));return ss.map(s=>s.id==='b'&&!retry?{items:[],health:{id:'b',required:true,status:'error',error:'timeout'}}:{items:[story(s.id)],health:health(s.id)});}};
 await assert.rejects(runPipeline('daily',{root,env,collector,client:fakeClient({failWriter:true})}),/Writer failed/);
 const staged=JSON.parse(await fs.readFile(path.join(root,'state/collection-checkpoint.json'),'utf8'));
 assert.equal(staged.source_upper.a,upper);assert.ok(staged.pending.items.some(x=>x.id==='a-story'));
 assert.equal(JSON.parse(await fs.readFile(path.join(root,'data/latest.json'),'utf8')).date,'2026-10-27');
 retry=true;const result=await runPipeline('daily',{root,env,collector,client:fakeClient()});
 assert.deepEqual(calls,[['a','b']]);assert.equal(result.items.length,1);assert.equal(result.window.upper,upper);
 assert.equal(JSON.parse(await fs.readFile(path.join(root,'state/collection-checkpoint.json'),'utf8')).pending,null);
 const revision=await runPipeline('daily',{root,env:{...env,FORCE_RUN:'1'},collector,client:fakeClient()});
 assert.deepEqual(calls,[['a','b'],['b']]);assert.equal(revision.items.length,2);assert.equal(revision.edition.revision,2);
});
test('weekly can publish from a pending raw capture while Monday daily has not been written',async t=>{
 const root=await sandbox(t);const now='2026-11-02T00:00:00Z',window=buildWindow('weekly',new Date(now));
 await fs.writeFile(path.join(root,'config/sources.json'),JSON.stringify({sources:[sources[0]]}));
 await fs.writeFile(path.join(root,'state/collection-checkpoint.json'),JSON.stringify({daily_upper:window.upper,pending:{window,coverage_status:'unverified',items:[sample('weekend',Date.parse('2026-11-01T19:00:00Z'))],source_health:[]}}));
 const collector={cache:{},enrich:async x=>x,collect:async()=>[{items:[],health:{id:'a',required:true,status:'error',error:'timeout'}}]};
 const env={PUBLISH_NOW:now,NEWS_DATA_DIR:path.join(root,'data'),NEWS_STATE_DIR:path.join(root,'state')};
 const result=await runPipeline('weekly',{root,env,collector,client:fakeClient()});
 assert.equal(result.items.length,1);assert.equal(result.items[0].id,'weekend');assert.equal(result.publication_status,'degraded');
 await assert.rejects(fs.access(path.join(root,'data/latest.json')),{code:'ENOENT'});
});


test('observed post-cutoff stories survive publication and next-day feed expiry',()=>{
 const future={...story('a'),id:'future',title:'A new apartment rental supply and demand survey report',link:'https://example.com/future',published_at:upper+2*3600000};
 const first=stageCapture({},[sources[0]],[{items:[story('a'),future],health:health('a')}],{lower,upper});
 const finished=finishCapture(first.checkpoint,upper);
 assert.deepEqual(finished.pending.items.map(x=>x.id),['future']);
 const next=stageCapture(finished,[sources[0]],[],{lower:upper,upper:upper+86400000});
 assert.ok(next.capture.items.some(x=>x.id==='future'));
});
test('cache keeps raw input after a model success whose Git push did not persist',()=>{
 const staged=stageCapture({},[sources[0]],[{items:[story('a')],health:health('a')}],{lower,upper});
 const cached=finishCapture(staged.checkpoint,upper);assert.equal(cached.pending,null);
 const restored=mergeCheckpoints({},cached);
 assert.ok(restored.pending.items.some(x=>x.id==='a-story'));
 const complete=mergeCheckpoints({processed_capture:cached.processed_capture},cached);assert.equal(complete.pending,null);
 const newer=mergeCheckpoints({daily_upper:upper+86400000,source_upper:{a:upper+86400000}},cached,upper+86400000);
 assert.equal(newer.source_upper.a,upper+86400000);assert.equal(newer.daily_upper,upper+86400000);
});
test('optional old items cannot expand the required coverage interval',()=>{
 const optional={...sources[1],required:false},old={...story('b'),published_at:lower-3600000};
 const state={source_floor:{b:lower-7*86400000}};
 const staged=stageCapture(state,[sources[0],optional],[{items:[story('a')],health:health('a')},{items:[old],health:{id:'b',required:false,status:'ok',coverage:null}}],{lower,upper});
 assert.equal(staged.capture.window.lower,lower);assert.equal(staged.capture.coverage_status,'observed');assert.ok(staged.capture.items.some(x=>x.id==='b-story'));
});
test('new late-discovered IDs and versions retain original dates after the initial source baseline',()=>{
 const old={...story('a'),id:'baseline-old',published_at:lower-3600000};
 const first=stageCapture({},[sources[0]],[{items:[old],health:health('a')}],{lower,upper});
 assert.equal(first.capture.items.length,0);assert.ok(first.checkpoint.observed_ids.includes('baseline-old'));
 const late={...old,id:'new-late-version',first_seen_at:upper+86400000,date_precision:'day'};
 const next=stageCapture(finishCapture(first.checkpoint,upper),[sources[0]],[{items:[old,late],health:{...health('a'),coverage:{lower:upper,upper:upper+86400000}}}],{lower:upper,upper:upper+86400000});
 assert.deepEqual(next.capture.items.map(x=>x.id),['new-late-version']);assert.equal(next.capture.items[0].published_at,old.published_at);assert.equal(next.capture.items[0].late_discovery,true);
});
test('collector records actual observation time separately from the fixed cutoff',async()=>{
 const actual=upper+3*3600000,body='Housing research and inventory evidence. '.repeat(8);
 const xml='<rss><item><title>Housing original research</title><link>https://example.com/time</link><description>'+body+'</description><pubDate>Mon, 19 Oct 2026 14:00:00 GMT</pubDate></item></rss>';
 const [r]=await createCollector({now:actual,upper,lower,fetchImpl:async()=>new Response(xml)}).collect([{...sources[0],type:'rss',url:'https://example.com/feed'}]);
 assert.equal(r.health.checked_at,actual);assert.equal(r.health.coverage.upper,upper);
});
test('daily rebuild after a failed push restores cached raw even with no checked-out snapshot',async t=>{
 const root=await sandbox(t);await fs.writeFile(path.join(root,'config/sources.json'),JSON.stringify({sources:[sources[0]]}));
 await fs.writeFile(path.join(root,'data/latest.json'),JSON.stringify({date:'2026-10-27',generated_at:lower}));
 const staged=stageCapture({},[sources[0]],[{items:[story('a')],health:health('a')}],{lower,upper});
 await fs.writeFile(path.join(root,'state/collection-cache.json'),JSON.stringify(finishCapture(staged.checkpoint,upper)));
 const calls=[],collector={cache:{},enrich:async x=>x,collect:async ss=>{calls.push(ss);return [];}};
 const env={PUBLISH_NOW:'2026-10-28T00:30:00Z',NEWS_DATA_DIR:path.join(root,'data'),NEWS_STATE_DIR:path.join(root,'state')};
 const result=await runPipeline('daily',{root,env,collector,client:fakeClient()});
 assert.equal(result.items.length,1);assert.equal(result.window.lower,lower);assert.equal(result.window.upper,upper);assert.deepEqual(calls,[[]]);
});
test('an old complete issue at a different cutoff does not suppress a corrected rebuild',async t=>{
 const root=await sandbox(t),old={schema_version:2,publication_status:'complete',date:'2026-10-28',window:{lower,upper:upper+3*3600000}};
 await fs.writeFile(path.join(root,'config/sources.json'),JSON.stringify({sources:[sources[0]]}));
 for(const file of ['latest.json','2026-10-28.json'])await fs.writeFile(path.join(root,'data',file),JSON.stringify(old));
 const collector={cache:{},enrich:async x=>x,collect:async()=>[{items:[story('a')],health:health('a')}]};
 const env={PUBLISH_NOW:'2026-10-28T00:30:00Z',NEWS_DATA_DIR:path.join(root,'data'),NEWS_STATE_DIR:path.join(root,'state')};
 const result=await runPipeline('daily',{root,env,collector,client:fakeClient()});assert.equal(result.skipped,undefined);assert.equal(result.window.upper,upper);
});


test('a previously undated or unreadable report can become a late-discovered candidate with the same ID',()=>{
 const state={source_upper:{a:upper},source_floor:{a:lower},initialized_sources:['a']};
 const incomplete={...story('a'),published_at:0};
 const first=stageCapture(state,[sources[0]],[{items:[incomplete],health:{...health('a'),undated:1}}],{lower:upper,upper:upper+86400000});
 assert.ok(!first.checkpoint.observed_ids.includes(incomplete.id));
 const valid={...incomplete,published_at:lower-3600000};
 const next=stageCapture(first.checkpoint,[sources[0]],[{items:[valid],health:health('a')}],{lower:upper,upper:upper+86400000});
 assert.equal(next.capture.items[0].id,valid.id);assert.equal(next.capture.items[0].late_discovery,true);
});


test('new same-cutoff material survives writer failure and failed push after a degraded publication',()=>{
 const a=stageCapture({},sources,[{items:[story('a')],health:health('a')},{items:[],health:{id:'b',required:true,status:'error'}}],{lower,upper});
 const finishedA=finishCapture(a.checkpoint,upper);const {last_capture:ignored,...committedA}=finishedA;
 const ab=stageCapture(committedA,sources,[{items:[story('b')],health:health('b')}],{lower:upper,upper},a.capture);
 for(const cached of [ab.checkpoint,finishCapture(ab.checkpoint,upper)]) {
   const restored=mergeCheckpoints(committedA,cached);
   assert.ok(restored.pending.items.some(it=>it.id==='b-story'));assert.ok(restored.observed_ids.includes('b-story'));
 }
 const finishedAB=finishCapture(ab.checkpoint,upper),{last_capture:ignoredAB,...committedAB}=finishedAB;
 assert.equal(mergeCheckpoints(committedAB,finishedAB).pending,null);
});


test('weekly and monthly audits preserve observed post-cutoff raw without advancing daily cursors',()=>{
 const previous={daily_upper:upper,source_upper:{a:upper},source_floor:{a:lower},initialized_sources:['a']};
 const future={...story('a'),id:'audit-future',link:'https://example.com/audit-future',title:'Independent post-cutoff construction supply survey',published_at:upper+3600000};
 const audited=stageSupplement(previous,[sources[0]],[{items:[future],health:health('a')}],{lower:lower-6*86400000,upper});
 assert.equal(audited.daily_upper,upper);assert.deepEqual(audited.source_upper,previous.source_upper);assert.ok(audited.pending.items.some(it=>it.id==='audit-future'));
 const next=stageCapture(audited,[sources[0]],[],{lower:upper,upper:upper+86400000});assert.ok(next.capture.items.some(it=>it.id==='audit-future'));
});
test('a weekly audit persists out-of-period observations for the next daily even when absent from its own output',async t=>{
 const root=await sandbox(t),now='2026-11-02T00:00:00Z',window=buildWindow('weekly',new Date(now));
 const inside=sample('inside',window.upper-86400000),after=sample('after-week',window.upper+3600000);
 await fs.writeFile(path.join(root,'config/sources.json'),JSON.stringify({sources:[sources[0]]}));
 const collector={cache:{},enrich:async x=>x,collect:async()=>[{items:[inside,after],health:{...health('a'),coverage:{lower:window.lower,upper:window.upper}}}]};
 const env={PUBLISH_NOW:now,NEWS_DATA_DIR:path.join(root,'data'),NEWS_STATE_DIR:path.join(root,'state')};
 const result=await runPipeline('weekly',{root,env,collector,client:fakeClient()});assert.equal(result.items.length,1);
 const state=JSON.parse(await fs.readFile(path.join(root,'state/collection-checkpoint.json'),'utf8'));assert.ok(state.pending.items.some(it=>it.id==='after-week'));assert.equal(state.daily_upper,undefined);
});
