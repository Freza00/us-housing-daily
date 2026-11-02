import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareWriting, validateWriting, summaryCharacterCount, writingSystem } from '../lib/editorial.mjs';
import { runPipeline } from '../lib/pipeline.mjs';
import { validateIssue } from '../lib/issue-contract.mjs';
import { sandbox, sample, fakeClient } from './helpers.mjs';

const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/2026-11-02-summary-responses.json', import.meta.url)));
// Synthetic grounding isolates the captured metadata's length and reference contracts.
const evidence = 'The research records price growth of 2.1% and 2.4%, new home sales down 5.3%, and real prices declining for 15 months. The policy range is 3.75% to 4.0%, PCE inflation 3.6%, core PCE 3.1%; rents changed 0.1% annually and -0.3% monthly, multifamily vacancy is 4.7% and rent growth 1%. Office vacancy is 17.7%, absorption positive for 9 quarters; life sciences improved after 4 years. Inflation was 3.4% in August 2026. The October 2026 Q3 report uses data in September 2026.';
const selected = Array.from({length:20},(_,i)=>({...sample(String(i+1),1793400000000),description:evidence}));
const cards = selected.map(it=>({id:it.id,title_zh:'住宅市场研究',summary_zh:'研究显示住宅市场分化。',impact:'neutral',evidence_quote:'The research records price growth of 2.1% and 2.4%'}));
const dataFor = metadata => ({items:structuredClone(cards),...structuredClone(metadata)});
const shortMetadata = sentences => ({executive_summary:{sentences},themes:[]});

for (const row of fixture.cases) test('captured '+row.name+' keeps the complete prefix and all 20 cards',()=>{
  const data=dataFor(row.metadata),original=structuredClone(data);
  assert.throws(()=>validateWriting(structuredClone(data),selected,'weekly'),error=>error.code==='SUMMARY_TOO_LONG'&&error.message.includes('actual='+row.original_characters)&&error.message.includes('over_by='+(row.original_characters-250)));
  const result=prepareWriting(data,selected,'weekly');
  assert.equal(summaryCharacterCount(result.executive_summary.text),row.prefix_characters);
  assert.deepEqual(result.items.map(it=>[it.id,it.title_zh,it.summary_zh,it.evidence_quote]),original.items.map(it=>[it.id,it.title_zh,it.summary_zh,it.evidence_quote]));
  assert.deepEqual(result.executive_summary.sentences,original.executive_summary.sentences.slice(0,2));
  assert.equal(result.validation_notes.summary_shortening.original_characters,row.original_characters);
  assert.equal(result.validation_notes.summary_shortening.kept_sentence_count,2);
  assert.equal(validateWriting(result,selected,'weekly').items.length,20);
});

test('counting uses normalized Unicode code points and one prompt metric',()=>{
  assert.equal(summaryCharacterCount('甲😀 A 5%\n。'),6);
  assert.equal(summaryCharacterCount('住宅—销售'),6);
  assert.match(writingSystem,/目标\s*200\s*个非空白\s*Unicode\s*字符，上限\s*250/);
  assert.doesNotMatch(writingSystem,/150-200中文字/);
  const exact=dataFor(shortMetadata([{text:'😀'.repeat(250),item_ids:['1']}]));
  assert.equal(summaryCharacterCount(prepareWriting(exact,selected).executive_summary.text),250);
  assert.throws(()=>prepareWriting(dataFor(shortMetadata([{text:'甲'.repeat(251),item_ids:['1']},{text:'短句。',item_ids:['2']} ])),selected),/actual=254/);
});

test('prefix does not skip a middle sentence or split an entry',()=>{
  const sentences=[{text:'甲'.repeat(200),item_ids:['1']},{text:'乙'.repeat(100),item_ids:['2']},{text:'短句。',item_ids:['3']}];
  const result=prepareWriting(dataFor(shortMetadata(sentences)),selected);
  assert.deepEqual(result.executive_summary.sentences,sentences.slice(0,1));
});

for (const corruption of ['trailing-number','trailing-reference','theme-reference','theme-number','card-number','missing-card']) test('prefix cannot hide '+corruption,()=>{
  const data=dataFor(fixture.cases[0].metadata);
  if(corruption==='trailing-number')data.executive_summary.sentences[2].text+='库存增长 123456789%。';
  if(corruption==='trailing-reference')data.executive_summary.sentences[2].item_ids=['absent'];
  if(corruption==='theme-reference')data.themes=[{title:'住宅市场',item_ids:['absent']}];
  if(corruption==='theme-number')data.themes=[{title:'库存增长 123456789%',item_ids:['1']}];
  if(corruption==='card-number')data.items[0].summary_zh='库存增长 123456789%。';
  if(corruption==='missing-card')data.items.pop();
  assert.throws(()=>prepareWriting(data,selected,'weekly'),error=>error.code!=='SUMMARY_TOO_LONG');
});

test('strict published issue validation rejects an unshortened payload',()=>{
  const payload={schema_version:2,kind:'weekly',publication_status:'complete',period_start:'2026-10-26',window:{lower:1792962000000,upper:1793566800000,periodStart:'2026-10-26'},...dataFor(fixture.cases[0].metadata),items:cards.map((card,i)=>({...selected[i],...card}))};
  assert.throws(()=>validateIssue(payload),/exceeds 250/);
});

test('fresh model output still rejects extra IDs outside its short-reference batch',async t=>{
  for(const extra of ['not-a-batch-id','alpha']){
    const root=await sandbox(t),upper=Date.parse('2026-11-01T21:00:00Z'),lower=upper-72*3600000;
    await fs.writeFile(path.join(root,'config/sources.json'),JSON.stringify({sources:[{id:'a',required:true}]}));
    const env={PUBLISH_NOW:'2026-11-02T00:30:00Z',NEWS_DATA_DIR:path.join(root,'data'),NEWS_STATE_DIR:path.join(root,'state')};
    const collector={cache:{},enrich:async items=>items,collect:async()=>[{items:['alpha','beta','gamma'].map(id=>({...sample(id,upper-1000),source_id:'a',source_family:'a'})),health:{id:'a',required:true,status:'ok',articles:3,undated:0,coverage:{lower,upper}}}]};
    const client=fakeClient(),original=client.call;
    client.call=async(system,user,options)=>{
      if(options.label==='editor')return original(system,user,options);
      const input=JSON.parse(user),items=input.items.map(it=>({id:it.id,title_zh:'住宅销售研究',summary_zh:'住宅销售增长 5%。',impact:'neutral',evidence_quote:it.evidence.slice(0,70)}));
      return options.validate({items:[...items,{...items[0],id:extra}],...shortMetadata([{text:'住宅销售增长 5%。',item_ids:input.items.map(it=>it.id)}])});
    };
    await assert.rejects(runPipeline('daily',{root,env,collector,client}),/Unknown model reference/);
    await assert.rejects(fs.access(path.join(root,'data/latest.json')),{code:'ENOENT'});
  }
});

const response=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}),{headers:{'content-type':'application/json'}});
test('pipeline normalizes once without correction and keeps the audit through cold metadata/cache resumes',async t=>{
  const now=new Date('2026-11-02T00:30:00Z'),upper=Date.parse('2026-11-01T21:00:00Z'),lower=upper-72*3600000,root=await sandbox(t);
  await fs.writeFile(path.join(root,'config/sources.json'),JSON.stringify({sources:[{id:'a',required:true}]}));
  const env={PUBLISH_NOW:now.toISOString(),NEWS_DATA_DIR:path.join(root,'data'),NEWS_STATE_DIR:path.join(root,'state'),PIPELINE_UNTIL:'ready',LLM_API_KEY:'offline-key',LLM_ENDPOINT:'https://offline.invalid'};
  const rows=['alpha','beta','gamma'].map(id=>({...sample(id,upper-1000),source_id:'a',source_family:'a'}));
  const collector={cache:{},enrich:async items=>items,collect:async()=>[{items:rows,health:{id:'a',required:true,status:'ok',articles:3,undated:0,coverage:{lower,upper}}}]};
  const requests=[];
  const llmOptions={fetchImpl:async(_url,request)=>{
    const input=JSON.parse(JSON.parse(request.body).messages[1].content);requests.push(input);
    if(Array.isArray(input))return response({decisions:input.map(it=>({id:it.id,keep:true,importance:4,section:'national',tags:[],duplicate_of:null}))});
    assert.equal(requests.length,2,'No metadata correction should be requested');
    return response({items:input.items.map(it=>({id:it.id,title_zh:'住宅销售研究',summary_zh:'住宅销售增长 5%。',impact:'neutral',evidence_quote:it.evidence.slice(0,70)})),...shortMetadata([{text:'甲'.repeat(150),item_ids:['1']},{text:'乙'.repeat(120),item_ids:['2']},{text:'丙'.repeat(30),item_ids:['3']}])});
  }};
  await runPipeline('daily',{root,env,collector,llmOptions});
  const issuePath='issues/daily/2026-11-02/r1',dir=path.join(root,'state',issuePath),ready=JSON.parse(await fs.readFile(path.join(dir,'ready.json'))),note=ready.payload._diagnostics.writer_validation.summary_shortening;
  assert.equal(requests.length,2);assert.equal(note.original_characters,300);assert.equal(note.final_characters,150);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'metadata.json'))).summary_shortening,note);
  for(const mode of ['metadata','cache']){
    const resumed=await sandbox(t);await fs.copyFile(path.join(root,'config/sources.json'),path.join(resumed,'config/sources.json'));
    const target=path.join(resumed,'state',issuePath);await fs.mkdir(target,{recursive:true});
    const manifest=JSON.parse(await fs.readFile(path.join(dir,'manifest.json'))),phases=mode==='metadata'?['prepared','editor','cards','metadata']:['prepared','editor'];
    manifest.phases=Object.fromEntries(phases.map(name=>[name,manifest.phases[name]]));
    await fs.writeFile(path.join(target,'manifest.json'),JSON.stringify(manifest));
    for(const name of phases)await fs.copyFile(path.join(dir,name+'.json'),path.join(target,name+'.json'));
    if(mode==='cache')await fs.cp(path.join(root,'state/llm-cache'),path.join(resumed,'state/llm-cache'),{recursive:true});
    let newRequests=0;
    await runPipeline('daily',{root:resumed,env:{...env,NEWS_DATA_DIR:path.join(resumed,'data'),NEWS_STATE_DIR:path.join(resumed,'state')},collector:{collect(){throw Error('Unexpected recollection');}},llmOptions:{fetchImpl:async()=>{newRequests++;throw Error('Unexpected model request');}}});
    const restored=JSON.parse(await fs.readFile(path.join(target,'ready.json')));
    assert.equal(newRequests,0);assert.deepEqual(restored.payload._diagnostics.writer_validation.summary_shortening,note);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(target,'metadata.json'))).summary_shortening,note);
    assert.equal(restored.payload.items.length,3);
  }
});
