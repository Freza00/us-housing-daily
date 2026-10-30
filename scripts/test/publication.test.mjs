import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runPipeline } from '../lib/pipeline.mjs';
import { buildWindow } from '../lib/calendar.mjs';
import { periodKey } from '../lib/issue-contract.mjs';
import { pushCandidate, gitCommand, publicationFiles, gitEnvironment } from '../lib/publication.mjs';
import { sandbox, sample, fakeClient } from './helpers.mjs';

const exec = promisify(execFile), now = new Date('2026-10-28T00:30:00Z'), lower = Date.parse('2026-10-26T21:00:00Z'), upper = lower + 86400000;
async function commit(cwd, message) {
  await gitCommand(cwd,['add','.']);
  await gitCommand(cwd,['-c','user.name=Offline Fixture','-c','user.email=offline@example.invalid','commit','-m',message]);
}
async function setup(t,{kind='daily',at=now,force=false}={}) {
  const temp = await sandbox(t), seed = path.join(temp,'seed'), remote = path.join(temp,'remote.git'), root = path.join(temp,'producer');
  await fs.mkdir(seed);
  await gitCommand(seed,['init','-b','main']);
  for (const dir of ['data','state','config','public']) await fs.mkdir(path.join(seed,dir));
  await fs.writeFile(path.join(seed,'.gitignore'),'.tmp/\nstate/issues/\nstate/collection-cache.json\nstate/source-cache.json\nstate/llm-cache/\nstate/llm-diagnostics/\n');
  await fs.writeFile(path.join(seed,'README.md'),'Original documentation\n');
  await fs.writeFile(path.join(seed,'config/sources.json'),JSON.stringify({sources:[{id:'a',required:true}]}));
  await fs.writeFile(path.join(seed,'public/index.html'),'<script id="initial-data" type="application/json">{}</script>');
  await fs.writeFile(path.join(seed,'data/latest.json'),JSON.stringify({date:'2026-10-27',window:{upper:lower}}));
  await commit(seed,'fixture seed');
  await gitCommand(temp,['init','--bare',remote]);
  await gitCommand(seed,['remote','add','origin',remote]); await gitCommand(seed,['push','origin','main']);
  await gitCommand(temp,['--git-dir',remote,'symbolic-ref','HEAD','refs/heads/main']);
  await gitCommand(temp,['clone',remote,root]);
  const env = {PUBLISH_NOW:at.toISOString(),PIPELINE_UNTIL:'ready',FORCE_RUN:force?'1':'0',NEWS_DATA_DIR:path.join(root,'data'),NEWS_STATE_DIR:path.join(root,'state')};
  const window=buildWindow(kind,at);
  const source = {...sample('saved-story',window.upper-3600000),source_id:'a',source_family:'a'};
  const collector = {cache:{},enrich:async x=>x,collect:async()=>[{items:[source],health:{id:'a',required:true,status:'ok',articles:1,undated:0,coverage:window}}]};
  const client = fakeClient(); await runPipeline(kind,{root,env,collector,client});
  const bundleFile = path.join(root,'state/issues',kind,periodKey(kind,window),'r1/ready.json');
  const bundle = JSON.parse(await fs.readFile(bundleFile));
  return {temp,seed,remote,root,bundle,bundleFile,client};
}
const remoteJson = async (fixture,file) => JSON.parse(await gitCommand(fixture.seed,['show','origin/main:'+file]));

test('temporary publisher receives scoped authentication only through process environment',()=>{
  const inherited={GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'core.quotePath',GIT_CONFIG_VALUE_0:'false'};
  const env=gitEnvironment('offline-test-credential',inherited);
  assert.equal(env.GIT_CONFIG_COUNT,'2');assert.equal(env.GIT_CONFIG_KEY_0,'core.quotePath');
  assert.equal(env.GIT_CONFIG_KEY_1,'http.https://github.com/.extraheader');
  assert.equal(Buffer.from(env.GIT_CONFIG_VALUE_1.split(' ').at(-1),'base64').toString(),'x-access-token:offline-test-credential');
  assert.equal(inherited.GIT_CONFIG_COUNT,'1');assert.equal(inherited.GIT_CONFIG_VALUE_1,undefined);
});

test('explicit weekday force is retained through staged weekly recovery and publishing while weekends stay blocked',async t=>{
  const at=new Date('2026-10-27T00:30:00Z'),fixture=await setup(t,{kind:'weekly',at,force:true});
  const env={PUBLISH_NOW:at.toISOString(),NEWS_DATA_DIR:path.join(fixture.root,'data'),NEWS_STATE_DIR:path.join(fixture.root,'state'),PIPELINE_UNTIL:'ready',ISSUE_REVISION:'1',EXPECTED_PERIOD:fixture.bundle.identity.period_key,EXPECTED_CUTOFF:String(fixture.bundle.identity.cutoff_upper)};
  const fail={call(){throw Error('Unexpected model');}};
  assert.equal((await runPipeline('weekly',{root:fixture.root,env,client:fail})).skipped,true);
  assert.equal((await runPipeline('weekly',{root:fixture.root,env:{...env,FORCE_RUN:'1'},client:fail})).stage,'ready');
  await assert.rejects(pushCandidate(fixture.bundle,{root:fixture.root,now:at}),/calendar guard/);
  const result=await pushCandidate(fixture.bundle,{root:fixture.root,now:at,force:true});assert(result.commit);
  await assert.rejects(pushCandidate(fixture.bundle,{root:fixture.root,now:new Date('2026-10-31T02:00:00Z'),force:true}),/calendar guard/);
  assert.equal((await runPipeline('weekly',{root:fixture.root,env:{...env,FORCE_RUN:'1',PUBLISH_NOW:'2026-10-31T02:00:00Z'},client:fail})).skipped,true);
});

test('publication safely retries unrelated main progress and never stages drafts or user edits',async t=>{
  const fixture = await setup(t), head = await gitCommand(fixture.root,['rev-parse','HEAD']);
  await fs.writeFile(path.join(fixture.root,'USER_EDIT.md'),'preserve local work\n');
  const result = await pushCandidate(fixture.bundle,{root:fixture.root,now,onBeforePush:async({attempt})=>{
    if (attempt) return;
    await fs.writeFile(path.join(fixture.seed,'README.md'),'Unrelated concurrent documentation\n');
    await commit(fixture.seed,'unrelated update'); await gitCommand(fixture.seed,['push','origin','main']);
  }});
  await gitCommand(fixture.seed,['fetch','origin','main']);
  assert.equal((await remoteJson(fixture,'data/latest.json')).items.length,1);
  assert.equal(await gitCommand(fixture.seed,['show','origin/main:README.md']),'Unrelated concurrent documentation');
  assert.equal(await gitCommand(fixture.root,['rev-parse','HEAD']),head);
  assert.equal(await fs.readFile(path.join(fixture.root,'USER_EDIT.md'),'utf8'),'preserve local work\n');
  const files=(await gitCommand(fixture.seed,['show','--pretty=format:','--name-only',result.commit])).split('\n');
  assert(files.every(file=>!file.startsWith('state/issues')&&file!=='USER_EDIT.md'));
  assert(publicationFiles(fixture.bundle.payload).every(file=>!file.startsWith('state/issues')));
  assert.equal(fixture.client.usage.length,2);
});

test('a successful push with a lost response is recognized without publishing again',async t=>{
  const fixture=await setup(t);let pushes=0;
  const git=async(cwd,args)=>{const result=await gitCommand(cwd,args);if(args[0]==='push'&&++pushes===1)throw Error('offline response lost');return result;};
  const result=await pushCandidate(fixture.bundle,{root:fixture.root,now,git});
  assert.equal(result.response_lost,true);assert.equal(pushes,1);
  await gitCommand(fixture.seed,['fetch','origin','main']);
  assert.equal(await gitCommand(fixture.seed,['rev-parse','origin/main']),result.commit);
});

test('permanent push failure retains the frozen bundle and does not regenerate',async t=>{
  const fixture=await setup(t);let pushes=0;
  const git=async(cwd,args)=>{if(args[0]==='push'){pushes++;throw Error('offline transport failure');}return gitCommand(cwd,args);};
  await assert.rejects(pushCandidate(fixture.bundle,{root:fixture.root,now,git}),/bundle retained/);
  assert.equal(pushes,2);assert.equal(fixture.client.usage.length,2);
  assert.deepEqual(JSON.parse(await fs.readFile(fixture.bundleFile)),fixture.bundle);
  await gitCommand(fixture.seed,['fetch','origin','main']);
  assert.equal((await remoteJson(fixture,'data/latest.json')).date,'2026-10-27');
});

test('a changed issue on main and the weekend guard prevent any candidate overwrite',async t=>{
  const fixture=await setup(t), newer={...fixture.bundle.payload,edition:{...fixture.bundle.payload.edition,revision:2}};
  await fs.writeFile(path.join(fixture.seed,'data/2026-10-28.json'),JSON.stringify(newer));
  await fs.writeFile(path.join(fixture.seed,'data/latest.json'),JSON.stringify(newer));
  await commit(fixture.seed,'newer published revision');await gitCommand(fixture.seed,['push','origin','main']);
  await assert.rejects(pushCandidate(fixture.bundle,{root:fixture.root,now}),/Published issue changed/);
  await assert.rejects(pushCandidate(fixture.bundle,{root:fixture.root,now:new Date('2026-10-31T02:00:00Z')}),/calendar guard/);
  await gitCommand(fixture.seed,['fetch','origin','main']);assert.equal((await remoteJson(fixture,'data/latest.json')).edition.revision,2);
});

test('an existing archive with a stale latest/index/inline is repaired without regenerating or looping commits',async t=>{
  const fixture=await setup(t);
  await fs.writeFile(path.join(fixture.seed,'data/2026-10-28.json'),JSON.stringify(fixture.bundle.payload));
  await commit(fixture.seed,'archive present but derived files missing');await gitCommand(fixture.seed,['push','origin','main']);
  const result=await pushCandidate(fixture.bundle,{root:fixture.root,now});assert.equal(result.already_pushed,false);
  await gitCommand(fixture.seed,['fetch','origin','main']);
  assert.deepEqual(await remoteJson(fixture,'data/latest.json'),fixture.bundle.payload);
  assert.deepEqual(await remoteJson(fixture,'data/dates.json'),['2026-10-28']);
  const html=await gitCommand(fixture.seed,['show','origin/main:public/index.html']);assert(html.includes('saved-story'));
  const again=await pushCandidate(fixture.bundle,{root:fixture.root,now});
  assert.equal(again.already_pushed,true);assert.equal(again.commit,result.commit);assert.equal(fixture.client.usage.length,2);
});
