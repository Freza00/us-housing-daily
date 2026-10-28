import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {runPipeline} from '../lib/pipeline.mjs';
import {sandbox,sample,fakeClient,replayEnv} from './helpers.mjs';

test('weekly replay uses full raw candidates, two explicit model stages and exposes missing coverage',async t=>{
 const root=await sandbox(t),client=fakeClient();
 const env=await replayEnv(root,{provenance:'retrospective_reconstruction',items:[sample('fri',Date.parse('2026-10-23T14:00:00Z')),sample('sun',Date.parse('2026-10-25T16:00:00Z')),sample('after',Date.parse('2026-10-25T22:00:00Z'))],coverage_snapshots:[]},'2026-10-26T06:00:00Z');
 const result=await runPipeline('weekly',{root,env,client});
 assert.equal(result.period_start,'2026-10-19');assert.equal(result.period_end,'2026-10-26');
 assert.equal(result.publication_status,'degraded');assert.equal(result.items.length,2);
 assert.deepEqual(client.usage.map(x=>x.effort),['medium','low']);
 assert.ok(result.executive_summary.text);assert.ok(result._diagnostics.coverage_gaps.length);
 assert.equal(JSON.parse(await fs.readFile(path.join(root,'data/weekly/latest.json'),'utf8')).publication_status,'degraded');
});
