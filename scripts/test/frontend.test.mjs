import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

class Element {
 constructor(){this.children=[];this.hidden=false;this.textContent='';}
 replaceChildren(...nodes){this.children=nodes;}
 append(...nodes){this.children.push(...nodes);}
}
test('summary and source status render safely with stable publisher references',async()=>{
 const app=await fs.readFile(new URL('../../public/app.js',import.meta.url),'utf8');
 const ids=Object.fromEntries(['briefBlock','briefText','briefTitle','coverageNote','researchCoverage','researchStatus','researchTitle'].map(x=>[x,new Element()]));
 const ctx={document:{createElement:()=>new Element()},$:id=>ids[id],currentLang:'zh'};
 vm.createContext(ctx);vm.runInContext(app.slice(app.indexOf('function sourceAuditSummary(')),ctx);
 ctx.renderBrief({items:[{id:'cre',link:'https://example.com/cre',source_name:'Research Publisher'}],publication_status:'degraded',executive_summary:{sentences:[{text:'增长5%,需要核实<script>。',item_ids:['cre']}]},_diagnostics:{source_health:[{name:'HAR',research:true,status:'ok'},{name:'Zillow',research:true,status:'error'}]}});
 assert.equal(ids.briefBlock.hidden,false);assert.equal(ids.coverageNote.hidden,false);
 assert.doesNotMatch(ids.coverageNote.textContent,/补齐后可更新/);
 const p=ids.briefText.children[0],a=p.children[0];
 assert.match(p.textContent,/增长 5%，需要核实/);assert.match(p.textContent,/<script>/);assert.equal(a.textContent,' [Research Publisher]');assert.equal(a.rel,'noopener noreferrer');
 assert.equal(ids.researchStatus.children.length,3);assert.equal(ids.researchTitle.textContent,'来源与行业覆盖');
 assert.match(ids.researchStatus.children[1].textContent,/Zillow.*首错未记录/);
 ctx.renderBrief({items:[]});assert.equal(ids.briefBlock.hidden,true);assert.equal(ids.researchCoverage.hidden,true);
});
test('weekend API guard returns before GitHub dispatch even without GH_PAT',async()=>{
 const {makeHandler}=await import('../lib/dispatch.mjs');let calls=0,code,body;
 const handler=makeHandler('daily',{now:()=>new Date('2026-10-31T01:00:00Z'),fetchImpl:async()=>{calls++;throw new Error('must not dispatch');}});
 const res={status(n){code=n;return this;},json(x){body=x;return this;}};
 const old=process.env.CRON_SECRET;delete process.env.CRON_SECRET;
 try{await handler({headers:{}},res);assert.equal(code,200);assert.equal(body.skipped,true);assert.equal(calls,0);}finally{if(old!==undefined)process.env.CRON_SECRET=old;}
});

test('empty sections distinguish source failures, observed candidates and selection limits',async()=>{
 const app=await fs.readFile(new URL('../../public/app.js',import.meta.url),'utf8');
 const ctx={currentLang:'zh',t:()=>({section_empty:'本期暂无已入选内容'})};
 vm.createContext(ctx);vm.runInContext(app.slice(app.indexOf('function sectionEmptyMessage('),app.indexOf('function applyFilter(')),ctx);
 const audit=row=>({_diagnostics:{editorial_coverage:{sections:{btr:row}}}});
 assert.match(ctx.sectionEmptyMessage(audit({source_failures:[{id:'invh'}]}),'btr'),/不能据此判断/);
 assert.match(ctx.sectionEmptyMessage(audit({qualified:2}),'btr'),/已合并或因选稿限制/);
 assert.match(ctx.sectionEmptyMessage(audit({candidates:2}),'btr'),/已观察到候选/);
 assert.match(ctx.sectionEmptyMessage({sources_attempted:77,sources_ok:65},'btr'),/来源未完成检查/);
 assert.equal(ctx.sectionEmptyMessage({},'btr'),'本期暂无已入选内容');
 ctx.currentLang='en';assert.match(ctx.sectionEmptyMessage(audit({source_failures:[{id:'invh'}]}),'btr'),/Key sources/);
});

test('sector coverage renders zero counts and historical gaps without claiming complete monitoring',async()=>{
 const app=await fs.readFile(new URL('../../public/app.js',import.meta.url),'utf8');
 const ids=Object.fromEntries(['briefBlock','briefText','briefTitle','coverageNote','researchCoverage','researchStatus','researchTitle'].map(x=>[x,new Element()]));
 const ctx={document:{createElement:()=>new Element()},$:id=>ids[id],currentLang:'zh'};
 vm.createContext(ctx);vm.runInContext(app.slice(app.indexOf('function sourceAuditSummary(')),ctx);
 ctx.renderBrief({kind:'daily',items:[],_diagnostics:{editorial_coverage:{assets:[{id:'self-storage',label:'自存储',selected:0,recent_selected:0}],unclassified_selected:2,sections:{btr:{source_failures:[{name:'INVH'}]}},history:{missing_dates:['2026-10-28']}}}});
 assert.equal(ids.researchCoverage.hidden,false);
 assert.equal(ids.researchTitle.textContent,'来源与行业覆盖');
 assert.match(ids.researchStatus.children[0].textContent,/自存储：本期 0 条/);
 assert.match(ids.researchStatus.children[1].textContent,/未标注资产类型：本期 2 条/);
 assert.match(ids.researchStatus.children[2].textContent,/INVH：关键来源尚未取全/);
 assert.match(ids.researchStatus.children[3].textContent,/不能视为完整行业覆盖/);
});

test('all digest modes choose bilingual overviews on first render and both language switches, including legacy archives', async () => {
 const app=await fs.readFile(new URL('../../public/app.js',import.meta.url),'utf8');
 for(const mode of ['daily','weekly','monthly']) for(const legacy of [false,true]) {
  const ids=Object.fromEntries(['briefBlock','briefText','briefTitle','coverageNote','researchCoverage','researchStatus','researchTitle'].map(id=>[id,new Element()]));
  const ul=new Element(),title=new Element(),themesBlock={hidden:false,querySelector:selector=>selector==='.themes-list'?ul:title};
  ul.appendChild=node=>ul.append(node);
  const ctx={document:{createElement:()=>new Element()},$:id=>ids[id],currentLang:'en',currentMode:mode,themesBlock,t:()=>({themes_weekly_title:'Weekly themes',themes_monthly_title:'Monthly themes'})};
  vm.createContext(ctx);vm.runInContext(app.slice(app.indexOf('function renderThemes(data)')),ctx);
  const data={kind:mode,items:[],executive_summary:{sentences:[{text:'住宅市场分化。',...(!legacy?{text_en:'Housing markets diverge.'}:{}),item_ids:[]}]},themes:[{title:'库存压力',...(!legacy?{title_en:'Inventory pressure'}:{}),item_ids:[]}]};
  for(const lang of ['en','zh','en']) {
   ctx.currentLang=lang;ctx.renderBrief(data);ctx.renderThemes(data);
   assert.equal(ids.briefTitle.textContent,lang==='en'?'Executive summary':'速读摘要');
   assert.equal(ids.briefText.children[0].textContent,lang==='zh'?'住宅市场分化。':legacy?'English summary is unavailable for this archive.':'Housing markets diverge.');
   assert.equal(themesBlock.hidden,mode==='daily');
   if(mode!=='daily')assert.equal(ul.children[0].textContent,lang==='zh'?'库存压力':legacy?'English themes are unavailable for this archive.':'Inventory pressure');
  }
 }
});

test('daily executive summary renders 30-day upcoming release outlook paragraph at the end in both ZH and EN', async () => {
 const app = await fs.readFile(new URL('../../public/app.js', import.meta.url), 'utf8');
 const ids = Object.fromEntries(['briefBlock', 'briefText', 'briefTitle', 'coverageNote', 'researchCoverage', 'researchStatus', 'researchTitle'].map(id => [id, new Element()]));
 const ctx = { document: { createElement: () => new Element() }, $: id => ids[id], currentLang: 'zh', currentMode: 'daily' };
 vm.createContext(ctx);
 vm.runInContext(app.slice(app.indexOf('function sourceAuditSummary(')), ctx);
 const data = {
  kind: 'daily',
  items: [{ id: '1', link: 'https://example.com/rates', source_name: 'Mortgage News Daily' }],
  executive_summary: {
   sentences: [{ text: '按揭利率微降。', text_en: 'Mortgage rates edged lower.', item_ids: ['1'] }],
   outlook: {
    text: '未来30天内，11月19日将公布NAR成屋销售，12月10日将公布美联储FOMC利率决议。',
    text_en: 'Over the next 30 days, NAR Existing-Home Sales on Nov 19 and the FOMC rate decision on Dec 10 will be released.'
   }
  }
 };
 ctx.renderBrief(data);
 assert.equal(ids.briefText.children.length, 2);
 assert.equal(ids.briefText.children[1].className, 'brief-outlook');
 assert.match(ids.briefText.children[1].textContent, /未来 30 天内，11 月 19 日将公布 NAR 成屋销售/);
 ctx.currentLang = 'en';
 ctx.renderBrief(data);
 assert.equal(ids.briefText.children.length, 2);
 assert.equal(ids.briefText.children[1].className, 'brief-outlook');
 assert.match(ids.briefText.children[1].textContent, /Over the next 30 days, NAR Existing-Home Sales/);
});

test('source check shows bilingual warnings and lists non-research and historical sources in attention order', async () => {
 const app = await fs.readFile(new URL('../../public/app.js', import.meta.url), 'utf8');
 const ids = Object.fromEntries(['sourcesInfo', 'sourcesCount', 'researchTitle', 'researchCoverage', 'researchStatus'].map(id => [id, new Element()]));
 const ctx = { $: id => ids[id], document: { createElement: () => new Element() }, currentLang: 'zh',
  t: () => ({ sources_label: ctx.currentLang === 'zh' ? '采集检查通过 ' : 'Checked ' }) };
 vm.createContext(ctx);
 vm.runInContext(app.slice(app.indexOf('function sourceAuditSummary('), app.indexOf('function renderBrief(data)')), ctx);
 const data = { sources_ok: 3, sources_attempted: 4, items: [{ source_id: 'stable' }], _diagnostics: {
  source_health: [{ id: 'stable', name: 'Stable', status: 'ok', effective_status: 'ok', primary_error: null },
   { id: 'legacy', name: 'Legacy', research: false, status: 'ok', attempted_urls: ['primary', 'alternate'] },
   { id: 'blocked', name: 'Blocked', research: false, status: 'error', effective_status: 'error', primary_error: { code: 'http_403' } },
   { id: 'limited', name: 'Limited', status: 'ok', effective_status: 'warning', primary_error: null, health_reasons: ['recent_insufficient'] }],
  source_funnel: { stable: { evidence_insufficient: 0, published: 1 }, limited: { evidence_insufficient: 2, dropped_short: 1, published: 0 } },
  sources_health_summary: { entry_failures: 2, fallback: 1, insufficient_evidence_items: 3, published_sources: 1 }
 } };
 for (const lang of ['zh', 'en']) {
  ctx.currentLang = lang;
  ctx.renderSourceCheck(data);
  ctx.renderSourceCoverage(data, ids.researchCoverage, ids.researchStatus);
  assert.equal(ids.sourcesInfo.children[0], lang === 'zh' ? '采集检查通过 ' : 'Checked ');
  assert.equal(ids.sourcesCount.textContent, '3/4');
  assert.match(ids.sourcesInfo.children[2], lang === 'zh' ? /入口失败 2.*使用备用 1.*补文不足 3/ : /Entry failures 2.*Fallbacks 1.*Insufficient evidence 3/);
  const [summary, failed, legacy, limited, stable] = ids.researchStatus.children.map(node => node.textContent);
  assert.match(summary, lang === 'zh' ? /有稿刊出 1/ : /Published sources 1/);
  assert.match(failed, /Blocked.*HTTP 403/);
  assert.match(legacy, lang === 'zh' ? /Legacy.*已用备用.*首错未记录/ : /Legacy.*Fallback used.*First error unrecorded/);
  assert.match(limited, lang === 'zh' ? /Limited.*正文不足 3/ : /Limited.*Insufficient evidence 3/);
  assert.match(stable, /Stable/);
 }
 ctx.renderSourceCheck(null);
 assert.equal(ids.sourcesCount.textContent, '—');
 assert.equal(ids.sourcesInfo.children[2], '');
});
