import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRun, buildWindow, etMidnight, coverageGaps } from '../lib/calendar.mjs';
import { dedupe, isSameStory, canonicalUrl } from '../lib/news-core.mjs';
import { prepareCandidates, selectItems, validateDecisions, validateWriting, numericValues, normalizeChinese } from '../lib/editorial.mjs';
import { createLlmClient, parseJson } from '../lib/llm-client.mjs';
import { createCollector, extractArticle, discoverLinks } from '../lib/sources.mjs';

const item = (id, overrides = {}) => ({ id, title: `Important housing report from publisher ${id}`, link: `https://example.com/${id}`, description: 'Housing sales rose 5% in September 2026 according to the original research report. Inventory also increased.', published_at: Date.parse('2026-10-27T14:00:00Z'), source_id: id, source_family: id, source_name: id, source_weight: 8, source_tags: ['housing'], region: 'national', ...overrides });
const decision = it => ({ id: it.id, keep: true, importance: 4, section: 'national', tags: ['housing'], duplicate_of: null });
const response = (value, { done = true, finish = 'stop' } = {}) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(value) }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 4 } })}\n\n${done ? 'data: [DONE]\n\n' : ''}`, { headers: { 'content-type': 'text/event-stream' } });

test('Beijing weekend guards prevent all three kinds even for forced live runs', () => {
  for (const now of ['2026-10-31T01:00:00Z', '2026-11-01T01:00:00Z']) for (const kind of ['daily', 'weekly', 'monthly']) assert.equal(shouldRun(kind, new Date(now), { force: true }), false);
});
test('daily windows resume from the exact successful cutoff and retain long outages', () => {
  const prior=Date.parse('2026-10-29T21:00:00Z');
  const w=buildWindow('daily',new Date('2026-11-02T04:30:00Z'),prior);
  assert.equal(w.lower,prior);assert.equal(w.upper,Date.parse('2026-11-01T21:00:00Z'));assert.equal(w.hours,72);
  const irregular=Date.parse('2026-10-29T23:24:00Z');assert.equal(buildWindow('daily',new Date('2026-11-02T04:30:00Z'),irregular).lower,irregular);
  const old=Date.parse('2026-10-01T21:00:00Z');assert.equal(buildWindow('daily',new Date('2026-11-02T04:30:00Z'),old).lower,old);
  const pool=prepareCandidates([item('before',{published_at:w.lower-1}),item('start',{published_at:w.lower}),item('end',{published_at:w.upper})],w);
  assert.deepEqual(pool.candidates.map(x=>x.id),['start']);
});
test('05:00 Beijing daily and 07:00 weekly gates handle UTC previous-day weekdays', () => {
  assert.equal(shouldRun('daily',new Date('2026-11-01T20:59:59Z')),false);
  assert.equal(shouldRun('daily',new Date('2026-11-01T21:00:00Z')),true);
  assert.equal(shouldRun('daily',new Date('2026-10-30T21:00:00Z')),false);
  assert.equal(shouldRun('weekly',new Date('2026-11-01T22:59:59Z')),false);
  assert.equal(shouldRun('weekly',new Date('2026-11-01T23:00:00Z')),true);
});
test('weekly Beijing cutoff remains fixed across delays and both ET DST transitions', () => {
  assert.equal(etMidnight('2026-03-08'),Date.parse('2026-03-08T05:00:00Z'));
  assert.equal(etMidnight('2026-03-09'),Date.parse('2026-03-09T04:00:00Z'));
  assert.equal(etMidnight('2026-11-02'),Date.parse('2026-11-02T05:00:00Z'));
  for(const date of ['2026-03-09','2026-11-02']){
    const w=buildWindow('weekly',new Date(date+'T00:00:00Z'));
    assert.equal(w.hours,168);assert.equal(w.upper,Date.parse(date+'T05:00:00+08:00'));
    assert.deepEqual(buildWindow('weekly',new Date(date+'T06:00:00Z')),w);
  }
  assert.throws(()=>buildWindow('weekly',new Date('2026-11-01T20:59:00Z')),/cutoff/);
});
test('sales and rents with the same year/city are not merged', () => {
  const a = item('sales', { title: 'Houston home sales rose 5% in September 2026' });
  const b = item('rents', { title: 'Houston apartment rents fell 2% in September 2026' });
  assert.equal(isSameStory(a, b), false); assert.equal(dedupe([a, b]).length, 2);
});
test('tracking URLs dedupe but HAR report identifiers are preserved', () => {
  assert.equal(canonicalUrl('https://www.har.com/a?pid=2248&utm_source=x'), 'https://har.com/a?pid=2248');
  assert.notEqual(canonicalUrl('https://har.com/a?pid=1'), canonicalUrl('https://har.com/a?pid=2'));
});
test('fixed report URLs with different publication versions survive dedupe', () => {
  const a = item('a', { mutable: true }), b = item('b', { mutable: true, link: a.link, published_at: a.published_at + 86400000 });
  assert.equal(dedupe([a, b]).length, 2);
});
test('source cap applies across sections and excluded items never return through fallback', () => {
  const items = Array.from({ length: 30 }, (_, i) => item(String(i), { source_family: 'same-owner' }));
  const decisions = items.map((it, i) => ({ ...decision(it), section: ['national', 'sunbelt', 'btr', 'cre', 'institutional'][i % 5] }));
  decisions[0].keep = false; decisions[1].duplicate_of = '2';
  const result = selectItems(items, decisions);
  assert.ok(result.items.length <= 3); assert.ok(!result.items.some(x => x.id === '0' || x.id === '1'));
});
test('balanced candidates reserve rare required research before prolific media', () => {
  const items = Array.from({ length: 100 }, (_, i) => item(String(i), { source_family: 'prolific' }));
  items.push(item('har', { source_family: 'har', is_research: true, required_source: true }));
  const r = prepareCandidates(items, { lower: Date.parse('2026-10-27'), upper: Date.parse('2026-10-28') });
  assert.ok(r.candidates.some(x => x.id === 'har')); assert.ok(r.candidates.filter(x => x.source_family === 'prolific').length <= 4);
});
test('decision schema rejects missing, duplicate, unknown IDs and circular duplicate references', () => {
  const items = [item('a'), item('b')], d = items.map(decision);
  assert.throws(() => validateDecisions({ decisions: [d[0]] }, items));
  assert.throws(() => validateDecisions({ decisions: [d[0], d[0]] }, items));
  assert.throws(() => validateDecisions({ decisions: [{ ...d[0], id: 'invented' }, d[1]] }, items));
  assert.throws(() => validateDecisions({ decisions: d.map((x, i) => ({ ...x, duplicate_of: i ? 'a' : 'b' })) }, items));
});
test('incomplete JSON is rejected instead of accepting recovered objects', () => assert.throws(() => parseJson('[{"id":1},'), /Incomplete/));
test('LLM client records explicit effort and usage and accepts only completed streams', async () => {
  let body; const client = createLlmClient({ endpoint: 'https://example.com', apiKey: 'test', retryDelays: [], fetchImpl: async (url, opts) => { body = JSON.parse(opts.body); return response({ ok: true }); } });
  assert.deepEqual(await client.call('system', 'user', { effort: 'low' }), { ok: true });
  assert.equal(body.reasoning_effort, 'low'); assert.equal(body.temperature, undefined); assert.equal(body.response_format.type, 'json_object'); assert.equal(client.usage[0].usage.prompt_tokens, 10);
  for (const args of [{ done: false }, { finish: 'length' }]) { const c = createLlmClient({ endpoint: 'https://example.com', apiKey: 'test', retryDelays: [], fetchImpl: async () => response({}, args) }); await assert.rejects(c.call('s', 'u'), /Incomplete response/); }
});
test('permanent route errors fail once while transient 503 retries', async () => {
  let calls = 0; const c = createLlmClient({ endpoint: 'https://example.com', apiKey: 'test', sleep: async () => {}, fetchImpl: async () => { calls++; return new Response('{"error":{"code":"model_not_found"}}', { status: 503 }); } });
  await assert.rejects(c.call('s', 'u'), /503/); assert.equal(calls, 1);
  calls = 0; const retry = createLlmClient({ endpoint: 'https://example.com', apiKey: 'test', retryDelays: [0], sleep: async () => {}, fetchImpl: async () => ++calls === 1 ? new Response('overloaded', { status: 503 }) : response({ ok: true }) });
  assert.deepEqual(await retry.call('s', 'u'), { ok: true }); assert.equal(calls, 2);
});
test('LLM connection idle timeout aborts a request', async () => {
  const c = createLlmClient({ endpoint: 'https://example.com', apiKey: 'test', idleMs: 5, retryDelays: [], fetchImpl: (u, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))) });
  await assert.rejects(c.call('s', 'u'), /idle timeout/);
});
test('numeric validation understands translated monetary units', () => {
  assert.deepEqual(numericValues('$2 billion'), numericValues('20 亿美元'));
  const it = item('a'); const good = { items: [{ id: 'a', title_zh: '住宅销售增长 5%', summary_zh: '研究显示住宅销售增长 5%，统计期为 2026 年。', impact: 'neutral', evidence_quote: 'Housing sales rose 5% in September 2026' }], executive_summary: { sentences: [{ text: '研究显示销售增长 5%。', item_ids: ['a'] }] } };
  assert.equal(validateWriting(good, [it]).items.length, 1);
  good.items[0].summary_zh = '销售增长 99%。'; assert.throws(() => validateWriting(good, [it]), /number absent/);
});
test('summary evidence and hard length limit are validated', () => {
  const it = item('a'), data = { items: [{ id: 'a', title_zh: '住宅研究', summary_zh: '住宅销售增长。', impact: 'neutral', evidence_quote: it.description }], executive_summary: { sentences: [{ text: '研究'.repeat(130), item_ids: ['a'] }] } };
  assert.throws(() => validateWriting(data, [it]), /250/);
  data.executive_summary.sentences[0] = { text: '摘要', item_ids: ['absent'] }; assert.throws(() => validateWriting(data, [it]), /reference/);
  assert.equal(normalizeChinese('增长5%,需要观察GPT。'), '增长 5%，需要观察 GPT。');
});
test('article extraction uses structured evidence and dates, never navigation as body', () => {
  const doc = extractArticle('<nav>Fake sale 999%</nav><script type="application/ld+json">{"@type":"NewsArticle","headline":"Real research","datePublished":"2026-10-21T14:00:00Z","articleBody":"Sales rose 5%."}</script>', 'https://example.com/story');
  assert.equal(doc.title, 'Real research'); assert.equal(doc.description, 'Sales rose 5%.'); assert.equal(doc.published_at, Date.parse('2026-10-21T14:00:00Z'));
});
test('research discovery keeps HAR query identifiers and rejects navigation', () => {
  const links = discoverLinks('<a href="?pid=2248">Houston rental report</a><a href="/login">Login</a>', 'https://www.har.com/content/department/newsroom?pid=640', { include: 'newsroom\\?pid=' });
  assert.equal(links.length, 1); assert.match(links[0].link, /pid=2248/);
});
test('blocked research is explicit, while an empty parsed feed tries the alternate', async () => {
  const blocked = createCollector({ fetchImpl: async () => new Response('', { status: 403 }) });
  const [r] = await blocked.collect([{ id: 'nar', name: 'NAR', url: 'https://example.com', required: true, is_research: true }]);
  assert.equal(r.health.status, 'error'); assert.match(r.health.error, /403/);
  let calls = 0; const fallback = createCollector({ fetchImpl: async () => { calls++; return new Response(calls === 1 ? '<rss></rss>' : '<rss><item><title>Important housing market research</title><link>https://example.com/report</link><description>Evidence</description><pubDate>Tue, 27 Oct 2026 14:00:00 GMT</pubDate></item></rss>'); } });
  const [ok] = await fallback.collect([{ id: 'z', name: 'Zillow', url: 'https://example.com/feed', alternates: ['https://example.com/other'], tags: [], is_research: true }]);
  assert.equal(calls, 3); assert.equal(ok.health.status, 'ok');
});
test('coverage gaps remain visible instead of treating missing days as complete', () => {
  assert.deepEqual(coverageGaps([{ window: { lower: 10, upper: 20 }, coverage_status: 'observed' }], { lower: 0, upper: 30 }), [{ lower: 0, upper: 10 }, { lower: 20, upper: 30 }]);
});

test('short and undated research feeds are hydrated before candidate filtering', async () => {
 const now=Date.parse('2026-10-28T01:00:00Z'), lower=now-86400000;
 const body='The original research documents housing sales and affordability changes. '.repeat(5);
 const collector=createCollector({now,lower,fetchImpl:async url=>new Response(url.endsWith('/feed') ? '<rss><item><title>Important original housing research</title><link>https://example.com/report</link><description>Short</description></item></rss>' : '<script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',headline:'Original housing research',datePublished:'2026-10-27T14:00:00Z',articleBody:body})+'</script>')});
 const [result]=await collector.collect([{id:'r',name:'Research',url:'https://example.com/feed',is_research:true,required:true,tags:['housing']}]);
 assert.equal(result.items[0].description,body.trim());
 assert.equal(prepareCandidates(result.items,{lower,upper:now}).candidates.length,1);
});
test('mutable reports with identical publication dates but changed content get new IDs', async () => {
 const {itemId}=await import('../lib/news-core.mjs');
 const a=item('old',{mutable:true,content_hash:'old'}),b={...a,content_hash:'new'};
 assert.notEqual(itemId(a),itemId(b));assert.equal(dedupe([a,b]).length,2);
});
test('failed source snapshots and unverified retrospective intervals cannot erase coverage gaps', () => {
 const window={lower:10,upper:20};
 const failure={window,coverage_status:'observed',source_health:[{required:true,status:'error'}]};
 assert.deepEqual(coverageGaps([failure],window),[window]);
 assert.deepEqual(coverageGaps([{window}],window),[window]);
});
test('English month names can be translated into Chinese numeric months',()=>{
 const it=item('a');
 const data={items:[{id:'a',title_zh:'9 月住宅销售增长',summary_zh:'2026 年 9 月销售增长 5%。',impact:'neutral',evidence_quote:it.description}],executive_summary:{sentences:[{text:'9 月销售增长 5%。',item_ids:['a']}]}};
 assert.equal(validateWriting(data,[it]).items.length,1);
});

test('editor decisions cannot overwrite links, publisher identity or source evidence',()=>{
 const it=item('a'),d={...decision(it),link:'https://bad.example',source_family:'fake',description:'Invented evidence'};
 validateDecisions({decisions:[d]},[it]);
 const out=selectItems([it],[d]).items[0];
 assert.equal(out.link,it.link);assert.equal(out.source_family,it.source_family);assert.equal(out.description,it.description);
});
test('a completed SSE response succeeds even when the server keeps the connection open',async()=>{
 const body=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:'{"ok":true}'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n'));}});
 const client=createLlmClient({endpoint:'https://example.com',apiKey:'test',idleMs:20,retryDelays:[],fetchImpl:async()=>new Response(body,{headers:{'content-type':'text/event-stream'}})});
 assert.deepEqual(await client.call('s','u'),{ok:true});
});

test('research discovery includes a current article after six old directory entries',async()=>{
 const now=Date.parse('2026-10-28T01:00:00Z'),lower=now-86400000,requested=[];
 const collector=createCollector({now,lower,fetchImpl:async url=>{
 requested.push(url);
 if(url.endsWith('/list'))return new Response(Array.from({length:7},(_,i)=>'<a href="/report/'+i+'">Research report '+i+'</a>').join(''));
 return new Response('<article><h1>Housing research report</h1><time datetime="'+(url.endsWith('/6')?'2026-10-27T14:00:00Z':'2026-09-01T14:00:00Z')+'"></time>'+('Housing research finds inventory and sales change across markets. '.repeat(5))+'</article>');
 }});
 const [result]=await collector.collect([{id:'r',name:'Research',url:'https://example.com/list',type:'html',include:'/report/',is_research:true,tags:['housing']}]);
 assert.ok(requested.includes('https://example.com/report/6'));assert.equal(result.health.recent,1);
});
test('important required research receives its source exception before ordinary stories fill all seats',()=>{
 const research=Array.from({length:4},(_,i)=>item('r'+i,{source_family:'har',required_source:true,is_research:true,score:20}));
 const others=Array.from({length:25},(_,i)=>item('o'+i,{score:10}));
 const all=[...research,...others],d=all.map(x=>({...decision(x),importance:x.is_research?5:3}));
 const result=selectItems(all,d);
 assert.equal(result.items.length,20);assert.equal(result.items.filter(x=>x.source_family==='har').length,4);assert.equal(result.exceptions.length,1);
});

test('legacy non-semantic report bodies retain article text after navigation',()=>{
 const doc=extractArticle('<html><body><nav>Fake market report 999%</nav><div><h1>Official housing market update</h1><p>October 21, 2026</p><p>'+('Housing sales data and research evidence remain available. '.repeat(6))+'</p></div><footer>Copyright</footer></body></html>','https://example.com/report');
 assert.ok(doc.description.startsWith('Official housing'));assert.ok(!doc.description.includes('999%'));assert.equal(doc.published_at,Date.parse('2026-10-21T16:00:00Z'));assert.equal(doc.date_precision,'day');assert.equal(doc.extraction,'body_fallback');
});

test('script literals cannot truncate a legacy report body',()=>{
 const doc=extractArticle('<html><script>document.write("<body>header</body>")</script><body><h1>Actual public housing report</h1><p>October 21, 2026</p>'+('Inventory and sales evidence. '.repeat(10))+'</body></html>','https://example.com/report');
 assert.ok(doc.description.includes('Inventory and sales'));assert.equal(doc.published_date,'2026-10-21');
});

test('invalid complete JSON receives one bounded contract repair, while permanent routing errors still fail fast',async()=>{
 let repair;
 let count=0;const strict=createLlmClient({endpoint:'https://example.com',apiKey:'test',retryDelays:[0,0],sleep:async()=>{},fetchImpl:async(u,o)=>{count++;repair=JSON.parse(o.body).messages.at(-1).content;return new Response('data: '+JSON.stringify({choices:[{delta:{content:count===1?'bad JSON':'{"ok":true}'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});}});
 assert.deepEqual(await strict.call('s','u'),{ok:true});assert.equal(count,2);assert.match(repair,/契约校验/);
});

test('quote punctuation and spelled-out numeric equivalents do not cause false rejection',()=>{
 const it=item('q',{title:'Rates fall for the first time in two months',description:'Rates fell three points to 29, after seven weeks of increases.'});
 const data={items:[{id:'q',title_zh:'2 个月来首次回落',summary_zh:'连续 7 周上升后下降 3 点至 29。',impact:'neutral',evidence_quote:'Rates fell three points to 29.'}],executive_summary:{sentences:[{text:'利率下降 3 点。',item_ids:['q']}]}};
 assert.equal(validateWriting(data,[it]).items[0].evidence_basis,'body');
 data.items[0].evidence_quote=it.title;assert.equal(validateWriting(data,[it]).items[0].evidence_basis,'title');
 data.items[0].summary_zh='下降 99 点。';assert.throws(()=>validateWriting(data,[it]),/number absent/);
});

test('extraneous writer placeholders are discarded and audited, while selected duplicates still fail',()=>{
 const it=item('a'),card={id:'a',title_zh:'住宅研究',summary_zh:'销售增长 5%。',impact:'neutral',evidence_quote:it.description};
 const data={items:[card,{id:'0'}],executive_summary:{sentences:[{text:'销售增长 5%。',item_ids:['a']}]}};
 assert.deepEqual(validateWriting(data,[it]).validation_notes.discarded_output_ids,['0']);
 data.items.push({...card});assert.throws(()=>validateWriting(data,[it]),/coverage mismatch/);
});

test('verified newest-first research stops after crossing the date horizon; unordered archives remain unverified',async()=>{
 const now=Date.parse('2026-10-28T01:00:00Z'),lower=Date.parse('2026-10-27T00:57:00Z');let fetched=0;
 const fetchImpl=async url=>{if(url.endsWith('/list'))return new Response(Array.from({length:30},(_,i)=>'<a href="/report/'+i+'">Housing research report '+i+'</a>').join(''));fetched++;return new Response('<article><h1>Housing research</h1><time datetime="2026-10-'+(url.endsWith('/0')?'26':'21')+'T14:00:00Z"></time>'+('Research evidence and market trends. '.repeat(8))+'</article>');};
 const source={id:'har',name:'HAR',type:'html',url:'https://example.com/list',include:'/report/',is_research:true,required:true,max_articles:18,discovery_order:'newest_first',tags:['housing']};
 const [r]=await createCollector({now,lower,fetchImpl}).collect([source]);assert.equal(fetched,2);assert.equal(r.health.stop_reason,'date_horizon');assert.equal(r.health.coverage_basis,'ordered_date_horizon');assert.ok(r.health.coverage);
 fetched=0;const [u]=await createCollector({now,lower,fetchImpl}).collect([{...source,discovery_order:undefined}]);assert.equal(fetched,18);assert.equal(u.health.coverage,null);
});

test('negative signs in evidence and numeric claims cannot be dropped',()=>{
 const it=item('negative',{description:'Annual home sales growth was -5% in the region.'});
 const data={items:[{id:it.id,title_zh:'销售增长 -5%',summary_zh:'销售增速为 -5%。',impact:'neutral',evidence_quote:it.description}],executive_summary:{sentences:[{text:'销售增速为 -5%。',item_ids:[it.id]}]}};
 assert.equal(validateWriting(data,[it]).items.length,1);
 data.items[0].evidence_quote=it.description.replace('-5%','5%');assert.throws(()=>validateWriting(data,[it]),/Evidence quote/);
 data.items[0].evidence_quote=it.description;data.items[0].title_zh='销售增长 5%';assert.throws(()=>validateWriting(data,[it]),/number absent/);
 data.items[0].title_zh='销售下降 5%';assert.equal(validateWriting(data,[it]).items.length,1);
});
test('English quantity phrases retain their full scale and compound value',()=>{
 assert.ok(numericValues('two million homes sold').has('2000000'));assert.ok(!numericValues('two million homes sold').has('2'));
 assert.ok(numericValues('declined twenty-one percent').has('21'));assert.ok(!numericValues('declined twenty-one percent').has('20'));assert.ok(!numericValues('declined twenty-one percent').has('1'));
 assert.ok(!numericValues('one hundred and five homes').has('1'));assert.ok(!numericValues('one hundred and five homes').has('5'));
});
test('cached revalidation retains audited discarded IDs but model-supplied notes are not trusted',()=>{
 const it=item('a'),card={id:'a',title_zh:'住宅研究',summary_zh:'销售增长 5%。',impact:'neutral',evidence_quote:it.description};
 const raw={items:[card,{id:'0'}],executive_summary:{sentences:[{text:'销售增长 5%。',item_ids:['a']}]}};
 const first=validateWriting(raw,[it]);assert.deepEqual(first.validation_notes.discarded_output_ids,['0']);
 assert.deepEqual(validateWriting(first,[it],'daily',{cacheHit:true}).validation_notes.discarded_output_ids,['0']);
 assert.deepEqual(validateWriting({...first,validation_notes:{discarded_output_ids:['fabricated']}},[it]).validation_notes.discarded_output_ids,[]);
});

test('Atom links prefer the public article over feed self/API links',async()=>{
 const {parseFeed}=await import('../lib/news-core.mjs');
 const xml='<feed><entry><title>Original housing research report</title><link rel="self" href="https://example.com/api/entry"/><link type="text/html" href="https://example.com/report" rel="alternate"/><summary>Research evidence</summary><published>2026-10-21T14:00:00Z</published></entry></feed>';
 assert.equal(parseFeed(xml,{id:'a',name:'A',tags:[]})[0].link,'https://example.com/report');
});
