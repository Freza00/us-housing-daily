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
