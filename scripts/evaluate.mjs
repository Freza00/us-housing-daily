import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { itemId } from './lib/news-core.mjs';
import { prepareCandidates, selectItems } from './lib/editorial.mjs';
import { buildWindow } from './lib/calendar.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2), at=args.indexOf('--output');
const out=path.resolve(at>=0?args[at+1]:path.join(root,'.tmp/evaluation/report.json'));
if(!out.includes('/.tmp/'))throw new Error('Evaluation output must be isolated under .tmp/');
const sources=JSON.parse(await fs.readFile(path.join(root,'config/sources.json'),'utf8')).sources;
const catalog=new Map(sources.map(s=>[s.id,s]));
function normalize(it){const src=catalog.get(it.source_id)||{};return {...it,id:itemId(it),source_family:src.family||it.source_id,is_research:!!src.is_research,required_source:!!src.required};}
function counts(items){const map={};for(const x of items)map[x.source_family]=(map[x.source_family]||0)+1;return {items:items.length,publishers:Object.keys(map).length,max_publisher_items:Math.max(0,...Object.values(map)),research:items.filter(x=>x.is_research).length};}
const decisions=items=>items.map(it=>({id:it.id,keep:true,importance:Math.max(3,Math.min(5,it.importance||3)),section:it.section||'national',tags:it.tags||[],duplicate_of:null,reason:'Frozen archived editorial rating; no new model evaluation'}));
const issues=[];
for(const name of (await fs.readdir(path.join(root,'data'))).filter(x=>/^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort()){
 const saved=JSON.parse(await fs.readFile(path.join(root,'data',name),'utf8'));
 const items=(saved.items||[]).map(normalize), result=selectItems(items,decisions(items));
 issues.push({date:name.slice(0,10),baseline:counts(items),candidate:counts(result.items),exception_count:result.exceptions.length});
}
const anchor=JSON.parse(await fs.readFile(path.join(root,'data/latest.json'),'utf8')).date;
const weeklyWindow=buildWindow('weekly',new Date(anchor+'T06:00:00Z'));
const historical=[];
for(const name of (await fs.readdir(path.join(root,'data'))).filter(x=>/^\d{4}-\d{2}-\d{2}\.json$/.test(x))){
 const saved=JSON.parse(await fs.readFile(path.join(root,'data',name),'utf8'));
 historical.push(...(saved.items||[]).map(normalize));
}
const pool=prepareCandidates(historical,weeklyWindow,[]), weekly=selectItems(pool.candidates,decisions(pool.candidates));
const report={generated_at:new Date().toISOString(),method:'Offline paired selector comparison. Same archived published items and frozen historical importance/section ratings; no LLM calls.',limitations:['Archives contain the old selected stories, not the original candidate feeds. This cannot measure missed-story recall, original-source availability, summary quality, or token savings.','Weekly replay unions historical published items only; acquisition coverage remains unverified.','Missing Oct 21-27 reports require separately labelled retrospective reconstruction; they are not original-time snapshots.'],summary:{issues:issues.length,baseline_source_cap_violations:issues.filter(x=>x.baseline.max_publisher_items>3).length,candidate_source_cap_violations:issues.filter(x=>x.candidate.max_publisher_items>3&&x.exception_count===0).length},issues,weekly_replay:{window:weeklyWindow,provenance:'legacy_published_selection_only',input:counts(pool.candidates),output:counts(weekly.items),titles:weekly.items.map(x=>({title:x.title,source:x.source_name}))}};
await fs.mkdir(path.dirname(out),{recursive:true});await fs.writeFile(out,JSON.stringify(report,null,2));
console.log(JSON.stringify({output:out,...report.summary,example:issues.find(x=>x.date==='2026-06-04'),weekly:report.weekly_replay.output},null,2));
