import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {runPipeline} from '../lib/pipeline.mjs';
import {buildWindow} from '../lib/calendar.mjs';
import {sandbox,sample,fakeClient,replayEnv} from './helpers.mjs';

test('monthly replay verifies completed ET period and evidence-linked themes',async t=>{
 const root=await sandbox(t),now='2026-06-01T06:30:00Z',window=buildWindow('monthly',new Date(now));
 const env=await replayEnv(root,{items:[sample('may',Date.parse('2026-05-22T14:00:00Z'))],coverage_snapshots:[{window,coverage_status:'observed',source_health:[]}]},now);
 const result=await runPipeline('monthly',{root,env,client:fakeClient()});
 assert.equal(result.period_label,'2026-05');assert.equal(result.publication_status,'complete');
 assert.equal(result.items.length,1);assert.equal(result.themes[0].item_ids[0],'may');
});
test('all live entry points skip Beijing weekends before collection or model calls',async()=>{
 for(const kind of ['daily','weekly','monthly']) for(const date of ['2026-10-31T01:00:00Z','2026-11-01T01:00:00Z']){
  const result=await runPipeline(kind,{env:{FORCE_RUN:'1'},now:new Date(date),collector:{collect(){throw new Error('must not collect');}},client:{call(){throw new Error('must not call');}}});
  assert.equal(result.skipped,true);
 }
});
test('failed writer preserves the previous latest issue',async t=>{
 const root=await sandbox(t),previous={date:'2026-10-27',items:[{id:'old'}]};
 await fs.writeFile(path.join(root,'data/latest.json'),JSON.stringify(previous));
 const env=await replayEnv(root,{items:[sample('new',Date.parse('2026-10-27T14:00:00Z'))]},'2026-10-28T01:00:00Z');
 await assert.rejects(runPipeline('daily',{root,env,client:fakeClient({failWriter:true})}),/Writer failed/);
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'data/latest.json'),'utf8')),previous);
});

test('isolated historical builds never rewrite the project homepage',async t=>{
 const root=await sandbox(t),index=path.join(root,'public/index.html'),before=await fs.readFile(index,'utf8');
 const now='2026-10-28T01:00:00Z',env={PUBLISH_NOW:now,NEWS_DATA_DIR:path.join(root,'data'),NEWS_STATE_DIR:path.join(root,'state')};
 const collector={cache:{},collect:async()=>[{items:[sample('isolated',Date.parse('2026-10-27T14:00:00Z'))],health:{id:'r',required:true,status:'ok',articles:1,undated:0,coverage:{lower:0,upper:Date.parse(now)}}}],enrich:async x=>x};
 await runPipeline('daily',{root,env,collector,client:fakeClient()});
 assert.equal(await fs.readFile(index,'utf8'),before);
});
