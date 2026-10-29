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
 vm.createContext(ctx);vm.runInContext(app.slice(app.indexOf('function renderBrief(data)')),ctx);
 ctx.renderBrief({items:[{id:'cre',link:'https://example.com/cre',source_name:'Research Publisher'}],publication_status:'degraded',executive_summary:{sentences:[{text:'增长5%,需要核实<script>。',item_ids:['cre']}]},_diagnostics:{source_health:[{name:'HAR',research:true,status:'ok'},{name:'Zillow',research:true,status:'error'}]}});
 assert.equal(ids.briefBlock.hidden,false);assert.equal(ids.coverageNote.hidden,false);
 const p=ids.briefText.children[0],a=p.children[0];
 assert.match(p.textContent,/增长 5%，需要核实/);assert.match(p.textContent,/<script>/);assert.equal(a.textContent,' [Research Publisher]');assert.equal(a.rel,'noopener noreferrer');
 assert.equal(ids.researchStatus.children.length,2);assert.equal(ids.researchTitle.textContent,'研究来源覆盖：1/2');
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
 vm.createContext(ctx);vm.runInContext(app.slice(app.indexOf('function renderBrief(data)')),ctx);
 ctx.renderBrief({kind:'daily',items:[],_diagnostics:{editorial_coverage:{assets:[{id:'self-storage',label:'自存储',selected:0,recent_selected:0}],unclassified_selected:2,sections:{btr:{source_failures:[{name:'INVH'}]}},history:{missing_dates:['2026-10-28']}}}});
 assert.equal(ids.researchCoverage.hidden,false);
 assert.equal(ids.researchTitle.textContent,'来源与行业覆盖');
 assert.match(ids.researchStatus.children[0].textContent,/自存储：本期 0 条/);
 assert.match(ids.researchStatus.children[1].textContent,/未标注资产类型：本期 2 条/);
 assert.match(ids.researchStatus.children[2].textContent,/INVH：关键来源尚未取全/);
 assert.match(ids.researchStatus.children[3].textContent,/不能视为完整行业覆盖/);
});
