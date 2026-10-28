import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runPipeline} from './lib/pipeline.mjs';
import {createLlmClient} from './lib/llm-client.mjs';

const args=process.argv.slice(2),arg=name=>args[args.indexOf(name)+1];
if(!args.includes('--snapshot')||!args.includes('--cases')||!args.includes('--output'))throw new Error('Usage: node --env-file=.env scripts/evaluate-models.mjs --snapshot FILE --cases FILE --output .tmp/TASK');
const snapshot=path.resolve(arg('--snapshot')),out=path.resolve(arg('--output'));
if(!out.includes('/.tmp/'))throw new Error('Model experiments must write only under a task .tmp directory');
const cases=JSON.parse(await fs.readFile(path.resolve(arg('--cases')),'utf8'));
if(!Array.isArray(cases)||!cases.length||cases.length>4||cases.some(c=>!['daily','weekly','monthly'].includes(c.kind)||!Number.isFinite(Date.parse(c.now))))throw new Error('Expected one to four explicit historical cases');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
await fs.mkdir(out,{recursive:true});
const report={started_at:new Date().toISOString(),method:'Paired fixed-input experiment; editor medium vs low, writer low in both. Shared valid-result cache. No source requests and no production writes.',snapshot,cases:[],limitations:['Reconstructed current feeds are not original-time acquisition snapshots.','Proxy usage is reported usage; accepted reasoning_effort does not prove native reasoning internals.','Writer cache hits reduce charged calls and must be separated when comparing input sizes.','Evidence and numeric checks do not assess every causal or editorial judgment.']};
for(const c of cases)for(const effort of ['medium','low']){
 const dir=path.join(out,c.kind+'-'+c.now.slice(0,10)+'-'+effort);
 const raw=createLlmClient({endpoint:process.env.LLM_ENDPOINT,apiKey:process.env.LLM_API_KEY,model:process.env.LLM_MODEL||'gpt-6.1-sol',cacheDir:path.join(out,'checkpoints')});
 const client={usage:raw.usage,call:(system,user,opts)=>raw.call(system,user,{...opts,effort:opts.label==='editor'?effort:'low'})};
 const started=Date.now();
 try{
  const result=await runPipeline(c.kind,{root,client,env:{REPLAY_SNAPSHOT:snapshot,PUBLISH_NOW:c.now,NEWS_DATA_DIR:path.join(dir,'data'),NEWS_STATE_DIR:path.join(dir,'state')}});
  report.cases.push({...c,editor_effort:effort,ok:true,ms:Date.now()-started,status:result.publication_status,items:result.items.length,summary_characters:result._diagnostics.summary_characters,source_counts:result._diagnostics.source_counts,selected:result.items.map(it=>({id:it.id,title:it.title,source:it.source_name,importance:it.importance})),executive_summary:result.executive_summary,usage:raw.usage});
 }catch(error){report.cases.push({...c,editor_effort:effort,ok:false,ms:Date.now()-started,error:error.message,usage:raw.usage});}
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report.cases.at(-1)));
}
if(report.cases.some(c=>!c.ok))process.exitCode=1;
