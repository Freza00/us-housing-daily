import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { openIssueStore, revisionSeed } from '../lib/issue-store.mjs';
import { restoreCheckpoint } from '../lib/artifact-recovery.mjs';
import { sandbox, sample } from './helpers.mjs';

const upper=Date.parse('2026-10-27T21:00:00Z');
async function setup(t){
  const root=await sandbox(t), source=await sandbox(t), options={kind:'daily',period:'2026-10-28',upper,rules:'rule-fingerprint',model:'offline-model'};
  const store=await openIssueStore(path.join(source,'state'),options);
  await store.put('prepared',{snapshot:{kind:'daily',window:{lower:upper-86400000,upper,date:'2026-10-28'},items:[sample('alpha',upper-1000)],initial_seen:[],source_health:[],coverage_snapshots:[]},checkpoint:{},normalized:[],eligible_count:1});
  await store.put('editor',[{id:'alpha',keep:true,importance:4,section:'national',tags:[],duplicate_of:null}]);
  const files={};for(const name of await fs.readdir(store.dir))files[name]=JSON.parse(await fs.readFile(path.join(store.dir,name)));
  const calls=[],run={repository:{full_name:'owner/repo'},head_repository:{full_name:'owner/repo'},head_branch:'main',event:'schedule',path:'.github/workflows/daily.yml'};
  const artifacts=[{id:101,name:'news-issue-daily-2026-10-28-r1-1-1-editor',expired:false,workflow_run:{id:1}}];
  const runMap={1:run},jobsByKey={},recentRuns=[];
  const gh=async args=>{calls.push(args);const endpoint=args[1];if(endpoint.includes('/actions/artifacts?'))return Buffer.from(JSON.stringify([{artifacts}]));if(endpoint.includes('/jobs?'))return Buffer.from(JSON.stringify([{jobs:jobsByKey[endpoint]||[]}]));if(endpoint.includes('/workflows/'))return Buffer.from(JSON.stringify([{workflow_runs:recentRuns}]));const match=endpoint.match(/\/runs\/(\d+)$/);if(match&&runMap[match[1]])return Buffer.from(JSON.stringify(runMap[match[1]]));if(endpoint.endsWith('/zip'))return Buffer.from('offline ZIP placeholder');throw Error('Unexpected GitHub call: '+endpoint);};
  const unzip=async args=>args[0]==='-Z1'?Object.keys(files).join('\n'):JSON.stringify(files[args.at(-1)]);
  return {root,options,files,calls,run,artifacts,gh,unzip,runMap,jobsByKey,recentRuns};
}

test('cross-run restore downloads only a trusted matching issue and restores validated phase files',async t=>{
  const fixture=await setup(t);
  const result=await restoreCheckpoint({...fixture.options,root:fixture.root,repo:'owner/repo',gh:fixture.gh,unzip:fixture.unzip});
  assert.equal(result.restored,true);assert.equal(result.revision,1);assert.deepEqual(result.phases,['prepared','editor']);
  const file=path.join(fixture.root,'state/issues/daily/2026-10-28/r1/editor.json');
  assert.deepEqual(JSON.parse(await fs.readFile(file)),fixture.files['editor.json']);
  assert.equal(fixture.calls.filter(args=>args[1].endsWith('/zip')).length,1);
});

test('pull-request artifacts, expired artifacts and unsafe ZIP entries are never installed',async t=>{
  const fixture=await setup(t);fixture.run.event='pull_request';
  let result=await restoreCheckpoint({...fixture.options,root:fixture.root,repo:'owner/repo',gh:fixture.gh,unzip:fixture.unzip});
  assert.equal(result.restored,false);assert.equal(fixture.calls.filter(args=>args[1].endsWith('/zip')).length,0);
  fixture.run.event='schedule';fixture.artifacts[0].expired=true;
  result=await restoreCheckpoint({...fixture.options,root:fixture.root,repo:'owner/repo',gh:fixture.gh,unzip:fixture.unzip});assert.equal(result.restored,false);
  fixture.artifacts[0].expired=false;
  await assert.rejects(restoreCheckpoint({...fixture.options,root:fixture.root,repo:'owner/repo',gh:fixture.gh,unzip:async args=>args[0]==='-Z1'?'../../.env':fixture.unzip(args)}),/Unsafe checkpoint archive/);
  await assert.rejects(fs.access(path.join(fixture.root,'state/issues')),{code:'ENOENT'});
});

test('rule mismatch selects an explicit new revision while checksum corruption blocks recovery',async t=>{
  const fixture=await setup(t);
  const result=await restoreCheckpoint({...fixture.options,rules:'new-rule',root:fixture.root,repo:'owner/repo',gh:fixture.gh,unzip:fixture.unzip});
  assert.equal(result.restored,false);assert.equal(result.revision,2);assert.match(result.reason,/explicit new revision/);
  fixture.files['editor.json'][0].importance=1;
  await assert.rejects(restoreCheckpoint({...fixture.options,root:fixture.root,repo:'owner/repo',gh:fixture.gh,unzip:fixture.unzip}),/checksum/);
});

test('recovery selects highest revision and newest attachment rather than highest run ID',async t=>{
  const f=await setup(t); f.files['manifest.json'].identity.revision=2;
  f.runMap[99]=f.run;
  f.artifacts.push({id:201,name:'news-issue-daily-2026-10-28-r2-99-1-editor',created_at:'2026-10-28T00:00:00Z',workflow_run:{id:99}},
    {id:202,name:'news-issue-daily-2026-10-28-r2-1-2-editor',created_at:'2026-10-28T00:05:00Z',workflow_run:{id:1}});
  const result=await restoreCheckpoint({...f.options,root:f.root,repo:'owner/repo',gh:f.gh,unzip:f.unzip});
  assert.equal(result.revision,2);assert(f.calls.some(args=>args[1].endsWith('/202/zip')));
  const forced=await restoreCheckpoint({...f.options,root:f.root,repo:'owner/repo',gh:f.gh,unzip:f.unzip,force:true,allocationSeed:revisionSeed({GITHUB_RUN_ID:'100',GITHUB_RUN_ATTEMPT:'2'})});
  assert.equal(forced.revision,100003);
  assert.throws(()=>revisionSeed({GITHUB_RUN_ID:'100'}),/Invalid/);
  assert.throws(()=>revisionSeed({GITHUB_RUN_ID:String(Number.MAX_SAFE_INTEGER),GITHUB_RUN_ATTEMPT:'1'}),/Invalid/);
});

test('newer runs without final artifacts block unknown stage budgets even when an older ledger exists',async t=>{
  const f=await setup(t);f.artifacts[0].created_at='2026-10-28T00:00:00Z';
  f.runMap[2]=f.run;f.recentRuns.push({id:2});
  f.jobsByKey['repos/owner/repo/actions/runs/2/jobs?filter=all&per_page=100']=[{steps:[{name:'Write and validate frozen issue',status:'completed',conclusion:'failure',started_at:'2026-10-28T00:10:00Z'}]}];
  const options={...f.options,root:f.root,repo:'owner/repo',gh:f.gh,unzip:f.unzip,since:'2026-10-27T16:00:00Z'};
  const result=await restoreCheckpoint(options);assert.deepEqual(result.budget_unknown,['writer']);
  const manifestFile=path.join(f.root,'state/issues/daily/2026-10-28/r1/manifest.json');
  let manifest=JSON.parse(await fs.readFile(manifestFile));assert.deepEqual(manifest.budget_unknown,['writer']);
  delete manifest.budget_unknown;await fs.writeFile(manifestFile,JSON.stringify(manifest));
  assert.deepEqual((await restoreCheckpoint(options)).budget_unknown,['writer']);
  assert.deepEqual(JSON.parse(await fs.readFile(manifestFile)).budget_unknown,['writer']);
  f.artifacts.length=0;
  const absent=await restoreCheckpoint(options);assert.deepEqual(absent.budget_unknown,['writer']);assert.equal(absent.revision,1);
  const cold=await restoreCheckpoint({...options,root:await sandbox(t)});assert.deepEqual(cold.budget_unknown,['writer']);assert.match(cold.reason,/unknown/);
});

test('an explicit revision never silently allocates a different version when missing, expired or incompatible',async t=>{
  const f=await setup(t),options={...f.options,root:f.root,repo:'owner/repo',gh:f.gh,unzip:f.unzip,revision:1};
  await assert.rejects(restoreCheckpoint({...options,revision:3}),/missing or expired/);
  f.artifacts[0].expired=true;await assert.rejects(restoreCheckpoint(options),/missing or expired/);
  f.artifacts[0].expired=false;await assert.rejects(restoreCheckpoint({...options,rules:'changed-rules'}),/incompatible/);
  assert.equal((await restoreCheckpoint(options)).restored,true);
  f.artifacts[0].expired=true;
  assert.equal((await restoreCheckpoint(options)).revision,1);
});
