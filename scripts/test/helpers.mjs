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
export const modelDecision = (id, fields = {}) => ({ id, keep: true, importance: 4, capital_focus: false, asset: 'housing', geo: 'national', topics: [], actor: null, geo_evidence: null, market_scope: 'us', primary_event: fields.capital_focus ? 'fund_platform_capital' : 'market_research_policy', event_evidence_id: 'title', market_evidence_id: 'body-1', market_role: fields.capital_focus ? 'capital_subject' : 'market_policy', duplicate_of: null, ...fields });
export const modelEvidence = item => { const row = item.evidence_options?.find(row => (typeof row === 'string' ? row : row.id).includes(':body-')) || item.evidence_options?.[0]; return row ? { evidence_id: typeof row === 'string' ? row : row.id } : {}; };
export function fakeClient({failWriter=false}={}) {
 const usage=[];
 return {usage,async call(system,user,options) {
   usage.push({label:options.label,effort:options.effort});
   if(options.label==='editor') return options.validate({decisions:JSON.parse(user).map(x=>modelDecision(x.id))});
   if(failWriter) throw new Error('Writer failed');
   const input=JSON.parse(user);
   return options.validate({items:input.items.map(x=>({id:x.id,title_zh:'住宅销售研究',summary_zh:'研究显示销售增长 5%，可负担性仍是约束。',impact:'neutral',...modelEvidence(x)})),executive_summary:{sentences:[{text:'研究显示住宅销售增长 5%，仍需关注可负担性。',text_en:'Housing sales rose 5%, while affordability remains a constraint.',item_ids:input.items.map(x=>x.id)}]},themes:input.kind==='daily'?[]:[{title:'销售改善但仍有约束',title_en:'Sales improve while constraints persist',item_ids:input.items.map(x=>x.id)}]});
 }};
}
export async function replayEnv(dir,saved,now) {
 const snapshot=path.join(dir,'input.json');await fs.writeFile(snapshot,JSON.stringify(saved));
 return {REPLAY_SNAPSHOT:snapshot,PUBLISH_NOW:now,NEWS_DATA_DIR:path.join(dir,'data'),NEWS_STATE_DIR:path.join(dir,'state')};
}
