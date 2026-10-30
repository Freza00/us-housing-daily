import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runPipeline, materializeIssue } from '../lib/pipeline.mjs';
import { digest, validateIssue, reusableIssue } from '../lib/issue-contract.mjs';
import { openIssueStore, ruleDigest } from '../lib/issue-store.mjs';
import { createLlmClient } from '../lib/llm-client.mjs';
import { mergeCheckpoints } from '../lib/collection-checkpoint.mjs';
import { loadCurrentCandidate } from '../publish.mjs';
import { installCheckpoint, trustedArtifactRun } from '../lib/artifact-recovery.mjs';
import { verifyOnline, recoveryDecision, triggerRedeploy } from '../lib/delivery.mjs';
import { checkPublication } from '../check-publication.mjs';
import { sandbox, sample, fakeClient } from './helpers.mjs';

const now = new Date('2026-10-28T00:30:00Z'), lower = Date.parse('2026-10-26T21:00:00Z'), upper = lower + 86400000;
const sources = [{ id: 'a', required: true }];
const rows = ['alpha','beta','gamma'].map(id => ({ ...sample(id, upper - 3600000), source_id: 'a', source_family: 'a' }));
const health = { id: 'a', required: true, status: 'ok', articles: 3, undated: 0, coverage: { lower, upper } };
async function setup(t, configured = sources) {
  const root = await sandbox(t);
  await fs.writeFile(path.join(root, 'config/sources.json'), JSON.stringify({ sources: configured }));
  const env = { PUBLISH_NOW: now.toISOString(), NEWS_DATA_DIR: path.join(root,'data'), NEWS_STATE_DIR: path.join(root,'state') };
  const collector = { cache: {}, collect: async () => [{ items: rows, health }], enrich: async items => items };
  return { root, env, collector };
}
const stageDir = root => path.join(root,'state/issues/daily/2026-10-28/r1');
const response = value => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }), { headers: { 'content-type': 'application/json' } });
function answer(input, bad = false) {
  return { items: input.items.map(it => ({ id: it.id, title_zh: '住宅销售研究', summary_zh: '住宅销售增长 5%。', impact: 'neutral', evidence_quote: it.evidence.slice(0,70) })), executive_summary: { sentences: [{ text: `住宅销售增长 ${bad ? 99 : 5}%。`, item_ids: input.items.map(it => it.id) }] }, themes: [] };
}

test('validated degraded issues skip generation, while a fake complete empty issue is rejected', async t => {
  const opts = await setup(t, [...sources, { id: 'b', required: true }]);
  opts.collector.collect = async () => [{ items: rows, health }, { items: [], health: { id: 'b', required: true, status: 'error', error: 'offline source outage' } }];
  const first = await runPipeline('daily', { ...opts, client: fakeClient() });
  assert.equal(first.publication_status, 'degraded');
  const again = await runPipeline('daily', { ...opts, collector: { collect() { throw Error('recollection'); } }, client: { call() { throw Error('regeneration'); } } });
  assert.equal(again.skipped, true); assert.equal(again.delivery_pending, true);
  assert.equal(reusableIssue({ ...first, items: [] }, { ...first, items: [] }, { upper }), false);
});

test('stage invocations freeze evidence and reuse editor after writer failure even without caches', async t => {
  const opts = await setup(t); let enrich = 0;
  opts.collector.enrich = async items => { enrich++; return items.map(it => ({ ...it, description: it.description + ' Alpha evidence.' })); };
  const prepared = await runPipeline('daily', { ...opts, env: { ...opts.env, PIPELINE_UNTIL: 'prepared' } });
  assert.equal(prepared.stage, 'prepared');
  const client = fakeClient({ failWriter: true });
  await assert.rejects(runPipeline('daily', { ...opts, client }), /Writer failed/);
  const frozen = await fs.readFile(path.join(stageDir(opts.root),'prepared.json'));
  await fs.rm(path.join(opts.root,'state/llm-cache'), { recursive: true, force: true });
  const resumed = fakeClient();
  opts.collector.collect = async () => { throw Error('recollection'); };
  opts.collector.enrich = async () => { throw Error('evidence drift'); };
  const ready = await runPipeline('daily', { ...opts, client: resumed, env: { ...opts.env, PIPELINE_UNTIL: 'ready' } });
  assert.equal(ready.stage, 'ready'); assert.equal(enrich, 1);
  assert.deepEqual(resumed.usage.map(it => it.label), ['writer']);
  assert.ok(frozen.equals(await fs.readFile(path.join(stageDir(opts.root),'prepared.json'))));
  const cards = JSON.parse(await fs.readFile(path.join(stageDir(opts.root),'cards.json')));
  assert.deepEqual(cards.items.map(it => it.id).sort(), rows.map(it => it.id).sort());
  await assert.rejects(fs.access(path.join(opts.root,'data/latest.json')), { code: 'ENOENT' });
  const result = await runPipeline('daily', { ...opts, client: { call() { throw Error('unexpected model'); } } });
  assert.equal(result.items.length, 3);
});

test('a bad shared summary repairs metadata only and persists all validated cards', async t => {
  const opts = await setup(t), calls = []; let writers = 0;
  const llmOptions = { retryDelays: [0,0], sleep: async () => {}, fetchImpl: async (_url, request) => {
    const body = JSON.parse(request.body), input = JSON.parse(body.messages[1].content); calls.push(body);
    if (Array.isArray(input)) return response({ decisions: input.map(it => ({ id: it.id, keep: true, importance: 4, section: 'national', tags: [], duplicate_of: null })) });
    if (++writers === 1) return response(answer(input, true));
    assert.match(body.messages[0].content, /仅纠正 executive_summary/);
    return response({ executive_summary: { sentences: [{ text: '住宅销售增长 5%。', item_ids: input.items.map(it => it.id) }] }, themes: [] });
  } };
  const result = await runPipeline('daily', { ...opts, env: { ...opts.env, LLM_API_KEY: 'offline-key', LLM_ENDPOINT: 'https://offline.invalid' }, llmOptions });
  assert.equal(calls.length, 3); assert.equal(result.items.length, 3);
  assert(result.items.every(it => it.summary_zh === '住宅销售增长 5%。'));
  const manifest = JSON.parse(await fs.readFile(path.join(stageDir(opts.root),'manifest.json')));
  assert.equal(manifest.attempts.writer.length, 2);
});

test('valid cards survive a failed metadata repair and only metadata is requested on the next run', async t => {
  const opts = await setup(t), env = { ...opts.env, LLM_API_KEY: 'offline-key', LLM_ENDPOINT: 'https://offline.invalid' };
  let firstWriter = true;
  const initial = { retryDelays: [0,0], sleep: async () => {}, fetchImpl: async (_url, request) => {
    const input = JSON.parse(JSON.parse(request.body).messages[1].content);
    if (Array.isArray(input)) return response({ decisions: input.map(it => ({ id: it.id, keep: true, importance: 4, section: 'national', tags: [], duplicate_of: null })) });
    if (firstWriter) { firstWriter = false; return response(answer(input, true)); }
    return new Response('model_not_found', { status: 503 });
  } };
  await assert.rejects(runPipeline('daily', { ...opts, env, llmOptions: initial }), /model_not_found/);
  const cards = await fs.readFile(path.join(stageDir(opts.root),'cards.json'));
  const retries = [];
  const llmOptions = { retryDelays: [0,0], fetchImpl: async (_url, request) => {
    const body = JSON.parse(request.body), input = JSON.parse(body.messages[1].content); retries.push(body);
    assert.match(body.messages[0].content, /仅纠正 executive_summary/);
    return response({ executive_summary: { sentences: [{ text: '住宅销售增长 5%。', item_ids: input.items.map(it => it.id) }] }, themes: [] });
  } };
  const result = await runPipeline('daily', { ...opts, env, llmOptions, collector: { collect() { throw Error('recollection'); } } });
  assert.equal(retries.length, 1); assert.equal(result.items.length, 3);
  assert.equal(JSON.parse(cards).items.length, 3);
  const manifest = JSON.parse(await fs.readFile(path.join(stageDir(opts.root),'manifest.json')));
  assert.equal(manifest.attempts.writer.length, 3);
});

test('repairing a missing card then bad metadata never asks to rewrite the saved cards',async t=>{
  const opts=await setup(t),seed=fakeClient(),original=seed.call;
  seed.call=async(system,user,options)=>{
    if(options.label==='editor')return original(system,user,options);
    const result=answer(JSON.parse(user),true);result.items[2].summary_zh='住宅销售增长 99%。';
    return options.validate(result);
  };
  await assert.rejects(runPipeline('daily',{...opts,client:seed}),/number absent/);
  assert.equal(JSON.parse(await fs.readFile(path.join(stageDir(opts.root),'cards.json'))).items.length,2);
  const calls=[];
  const result=await runPipeline('daily',{...opts,env:{...opts.env,LLM_API_KEY:'offline-key',LLM_ENDPOINT:'https://offline.invalid'},llmOptions:{retryDelays:[0,0],sleep:async()=>{},fetchImpl:async(_url,request)=>{
    const body=JSON.parse(request.body),input=JSON.parse(body.messages[1].content);calls.push(body);
    if(calls.length===1){assert.deepEqual(input.items.map(it=>it.id),['3']);return response({...answer(input,true),executive_summary:{sentences:[{text:'住宅销售增长 99%。',item_ids:input.original_item_ids}]}});}
    assert.match(body.messages[0].content,/仅纠正 executive_summary/);
    return response({executive_summary:{sentences:[{text:'住宅销售增长 5%。',item_ids:input.items.map(it=>it.id)}]},themes:[]});
  }}});
  assert.equal(calls.length,2);assert.equal(result.items.length,3);
});

test('unknown or exhausted durable budgets forbid new requests but allow validated cache reuse',async t=>{
  const root=await sandbox(t),cacheDir=path.join(root,'state/llm-cache');let requests=0;
  const options={endpoint:'https://offline.invalid',apiKey:'offline-key',cacheDir,fetchImpl:async()=>{requests++;return response({ok:true});}};
  await createLlmClient(options).call('system','evidence',{label:'writer'});
  const blocked=createLlmClient({...options,ledger:{blockedStages:['writer']}});
  assert.deepEqual(await blocked.call('system','evidence',{label:'writer'}),{ok:true});
  await assert.rejects(blocked.call('system','changed evidence',{label:'writer'}),/budget is unknown/);
  await assert.rejects(createLlmClient({...options,ledger:{attempts:{writer:[{},{},{}]}}}).call('system','new',{label:'writer'}),/request budget exhausted/);
  await assert.rejects(createLlmClient({...options,ledger:{spentMs:660000}}).call('system','new',{label:'writer'}),/time budget exhausted/);
  assert.equal(requests,1);
});

test('published archive repairs damaged derived JSON and explicit newer revision cannot fall back',async t=>{
  const opts=await setup(t),issue=await runPipeline('daily',{...opts,client:fakeClient()});
  await fs.writeFile(path.join(opts.root,'data/latest.json'),'{broken');
  await fs.writeFile(path.join(opts.root,'data/dates.json'),'{broken');
  await fs.writeFile(path.join(opts.root,'data/2026-10-27.json'),JSON.stringify({date:'2026-10-27'}));
  const bundle=await loadCurrentCandidate(opts.root,'daily',{},now);assert.equal(digest(bundle.payload),digest(issue));
  const skipped=await runPipeline('daily',{...opts,client:{call(){throw Error('regeneration');}}});assert.equal(skipped.skipped,true);
  await materializeIssue(bundle,{root:opts.root,outDir:opts.env.NEWS_DATA_DIR,dataDir:opts.env.NEWS_DATA_DIR,stateDir:opts.env.NEWS_STATE_DIR,now});
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(opts.root,'data/dates.json'))),['2026-10-27','2026-10-28']);
  assert.equal(digest(JSON.parse(await fs.readFile(path.join(opts.root,'data/latest.json')))),digest(issue));
  await assert.rejects(loadCurrentCandidate(opts.root,'daily',{ISSUE_REVISION:'2'},now),/No validated candidate/);
  await assert.rejects(loadCurrentCandidate(opts.root,'daily',{EXPECTED_PERIOD:'2026-10-27'},now),/no longer/);
});

test('tampered frozen input and mismatched model fail before further source/model calls', async t => {
  const opts = await setup(t);
  await runPipeline('daily', { ...opts, env: { ...opts.env, PIPELINE_UNTIL: 'prepared' } });
  const fail = { collect() { throw Error('unexpected collection'); } };
  await assert.rejects(runPipeline('daily', { ...opts, env: { ...opts.env, LLM_MODEL: 'other' }, collector: fail }), /incompatible/);
  const file = path.join(stageDir(opts.root),'prepared.json'); await fs.appendFile(file, ' ');
  const value = JSON.parse(await fs.readFile(file)); value.snapshot.items[0].description += ' Tampered.'; await fs.writeFile(file,JSON.stringify(value));
  await assert.rejects(runPipeline('daily', { ...opts, collector: fail }), /Corrupt frozen phase/);
});

test('artifact install checks identity and checksums without overwriting shared state', async t => {
  const opts = await setup(t);
  await runPipeline('daily', { ...opts, env: { ...opts.env, PIPELINE_UNTIL: 'editor' }, client: fakeClient() });
  const files = {}; for (const name of await fs.readdir(stageDir(opts.root))) files[name] = JSON.parse(await fs.readFile(path.join(stageDir(opts.root),name)));
  const restored = await sandbox(t), stateDir = path.join(restored,'state');
  await fs.writeFile(path.join(stateDir,'collection-checkpoint.json'),JSON.stringify({ source_upper: { a: upper + 86400000 } }));
  const before = await fs.readFile(path.join(stateDir,'collection-checkpoint.json'));
  const options = { stateDir, kind: 'daily', period: '2026-10-28', upper, rules: files['manifest.json'].rules, model: files['manifest.json'].model };
  const corrupt = structuredClone(files); corrupt['editor.json'][0].importance = 1;
  await assert.rejects(installCheckpoint(corrupt,options), /checksum/);
  await assert.rejects(installCheckpoint(files,{...options,period:'2026-10-29'}), /identity/);
  assert.equal((await installCheckpoint(files,options)).restored, true);
  assert.ok(before.equals(await fs.readFile(path.join(stateDir,'collection-checkpoint.json'))));
  assert.equal((await installCheckpoint(files,options)).restored, false);
  const run = { repository: { full_name: 'owner/repo' }, head_repository: { full_name: 'owner/repo' }, head_branch: 'main', event: 'schedule', path: '.github/workflows/daily.yml' };
  assert(trustedArtifactRun(run,{repo:'owner/repo',kind:'daily'}));
  assert(!trustedArtifactRun({...run,event:'pull_request'}, {repo:'owner/repo',kind:'daily'}));
  assert(!trustedArtifactRun({...run,head_branch:'feature'}, {repo:'owner/repo',kind:'daily'}));
});

test('ready candidate cannot overwrite a newer revision and source watermarks never regress', async t => {
  const opts = await setup(t); await runPipeline('daily', { ...opts, client: fakeClient(), env: { ...opts.env, PIPELINE_UNTIL: 'ready' } });
  const bundle = JSON.parse(await fs.readFile(path.join(stageDir(opts.root),'ready.json')));
  const stateFile = path.join(opts.root,'state/collection-checkpoint.json');
  const state = JSON.parse(await fs.readFile(stateFile)); state.source_upper.other = upper + 86400000;
  await fs.writeFile(stateFile,JSON.stringify(state));
  await materializeIssue(bundle,{...opts,dataDir:opts.env.NEWS_DATA_DIR,outDir:opts.env.NEWS_DATA_DIR,stateDir:opts.env.NEWS_STATE_DIR,now});
  assert.equal(JSON.parse(await fs.readFile(stateFile)).source_upper.other,upper + 86400000);
  const newer = { ...bundle.payload, edition: { ...bundle.payload.edition, revision: 2 } };
  await fs.writeFile(path.join(opts.root,'data/latest.json'),JSON.stringify(newer));
  await assert.rejects(materializeIssue(bundle,{...opts,dataDir:opts.env.NEWS_DATA_DIR,outDir:opts.env.NEWS_DATA_DIR,stateDir:opts.env.NEWS_STATE_DIR,now}), /newer issue/);
});

test('online verification requires matching inline/latest/archive/index and never updates the payload', async t => {
  const opts = await setup(t), issue = await runPipeline('daily',{...opts,client:fakeClient()});
  const before = digest(issue), fetchImpl = async url => new Response(new URL(url).pathname === '/' ? '<script id="initial-data" type="application/json">'+JSON.stringify(issue)+'</script>' : url.endsWith('dates.json') ? JSON.stringify([issue.date]) : JSON.stringify(issue));
  assert((await verifyOnline(issue,{host:'https://site.invalid',fetchImpl})).ok);
  const stale = async url => url.endsWith('/latest.json') ? new Response(JSON.stringify({...issue,date:'2026-10-27'})) : fetchImpl(url);
  assert(!(await verifyOnline(issue,{host:'https://site.invalid',fetchImpl:stale})).ok);
  assert.equal(digest(issue),before);
  const check = await checkPublication({kind:'daily',now,host:'https://site.invalid',candidate:issue,fetchImpl:stale,runs:[]});
  assert.equal(check.action,'publish');assert.equal(check.notifications_enabled,false);
});

test('publishing a frozen capture consumes only its fingerprints and retains later supplement versions',async t=>{
  const opts=await setup(t);await runPipeline('daily',{...opts,client:fakeClient(),env:{...opts.env,PIPELINE_UNTIL:'ready'}});
  const bundle=JSON.parse(await fs.readFile(path.join(stageDir(opts.root),'ready.json')));
  const stateFile=path.join(opts.root,'state/collection-checkpoint.json'),state=JSON.parse(await fs.readFile(stateFile));
  const added={...sample('late-supplement',upper-2000),title:'Regional apartment demand changed in a new independent audit',acquisition_window:{lower,upper},content_hash:'later-supplement'};
  const changed={...rows[0],description:rows[0].description+' A newly observed version.',content_hash:'new-content-version'};
  const noHash={...rows[1],description:rows[1].description+' Material changed without a supplied hash.'};
  const future={...sample('future-audit',upper+1000),content_hash:'future-content'};
  const old={...sample('old-newly-found',lower-86400000),content_hash:'old-content',acquisition_window:null};
  state.pending.items.push(added,changed,future,old,noHash);await fs.writeFile(stateFile,JSON.stringify(state));
  await fs.writeFile(path.join(opts.root,'state/collection-cache.json'),JSON.stringify(state));
  const snapshotFile=path.join(opts.root,'state/snapshots/2026-10-28.json'),raw=JSON.parse(await fs.readFile(snapshotFile));
  raw.items.push(added,changed,old);await fs.writeFile(snapshotFile,JSON.stringify(raw));
  await materializeIssue(bundle,{root:opts.root,outDir:opts.env.NEWS_DATA_DIR,dataDir:opts.env.NEWS_DATA_DIR,stateDir:opts.env.NEWS_STATE_DIR,now});
  const pending=JSON.parse(await fs.readFile(stateFile)).pending.items;
  assert.deepEqual(pending.filter(it=>it.content_hash).map(it=>it.content_hash).sort(),['later-supplement','new-content-version','future-content','old-content'].sort());
  assert(pending.some(it=>it.description===noHash.description));
  const committed=JSON.parse(await fs.readFile(stateFile));
  const merged=mergeCheckpoints(committed,{last_capture:{...bundle.checkpoint.last_capture,items:[noHash]}});
  assert(merged.pending.items.some(it=>it.description===noHash.description));
  const saved=JSON.parse(await fs.readFile(snapshotFile)).items;
  assert(saved.some(it=>it.content_hash==='new-content-version'));
  assert.equal(saved.find(it=>it.id==='old-newly-found').acquisition_window,null);
});

test('observer distinguishes absent/queued/failed/successful-but-stale tasks and honors weekends', async () => {
  const deadline = 10000000;
  assert.equal(recoveryDecision({online:false,runs:[],now:0,deadline}).state,'not_started');
  assert.equal(recoveryDecision({online:false,runs:[{status:'queued'}],now:0,deadline}).action,'observe');
  assert.equal(recoveryDecision({online:false,runs:[{status:'completed',conclusion:'failure'}],now:0,deadline}).state,'generation_failed');
  assert.equal(recoveryDecision({online:false,runs:[{status:'completed',conclusion:'success'}],now:0,deadline}).action,'restore_and_verify');
  assert.equal(recoveryDecision({online:false,now:0,deadline}).state,'execution_unknown');
  const result = await checkPublication({kind:'daily',now:new Date('2026-10-31T02:00:00Z'),fetchImpl:()=>{throw Error('weekend fetch');}});
  assert.equal(result.due,false);
  assert.equal((await triggerRedeploy()).available,false);
});
