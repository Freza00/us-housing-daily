import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDecisions, validateWriting } from '../lib/editorial.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export async function sandbox(t) {
  await fs.mkdir(path.join(ROOT, '.tmp'), {recursive:true});
  const dir = await fs.mkdtemp(path.join(ROOT, '.tmp/test-'));
  t.after(() => fs.rm(dir, {recursive:true,force:true}));
  for (const name of ['data','state','config','public']) await fs.mkdir(path.join(dir,name));
  await fs.writeFile(path.join(dir,'config/sources.json'), '{"sources":[]}');
  await fs.writeFile(path.join(dir,'public/index.html'), '<script id="initial-data" type="application/json">{}</script>');
  return dir;
}
export const sample = (id, published_at) => ({id,title:'Independent housing sales research '+id,description:'The original research report finds housing sales rose 5% in September 2026. Inventory and affordability remain important market constraints.',link:'https://example.com/'+id,published_at,source_id:id,source_family:id,source_name:id,source_weight:9,source_tags:['housing'],region:'national',is_research:true});
export function fakeClient({failWriter=false}={}) {
 const usage=[];
 return {usage,async call(system,user,options) {
   usage.push({label:options.label,effort:options.effort});
   if(options.label==='editor') return options.validate({decisions:JSON.parse(user).map(x=>({id:x.id,keep:true,importance:4,section:'national',tags:['housing'],duplicate_of:null}))});
   if(failWriter) throw new Error('Writer failed');
   const input=JSON.parse(user);
   return options.validate({items:input.items.map(x=>({id:x.id,title_zh:'住宅销售研究',summary_zh:'研究显示销售增长 5%，可负担性仍是约束。',impact:'neutral',evidence_quote:x.evidence.slice(0,70)})),executive_summary:{sentences:[{text:'研究显示住宅销售增长 5%，仍需关注可负担性。',item_ids:input.items.map(x=>x.id)}]},themes:input.kind==='daily'?[]:[{title:'销售改善但仍有约束',item_ids:input.items.map(x=>x.id)}]});
 }};
}
export async function replayEnv(dir,saved,now) {
 const snapshot=path.join(dir,'input.json');await fs.writeFile(snapshot,JSON.stringify(saved));
 return {REPLAY_SNAPSHOT:snapshot,PUBLISH_NOW:now,NEWS_DATA_DIR:path.join(dir,'data'),NEWS_STATE_DIR:path.join(dir,'state')};
}
