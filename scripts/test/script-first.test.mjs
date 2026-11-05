import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { routeSection, validateDecisions, editorInstructions, candidatePrompt, prepareWritingMetadata, prepareWriting, createWritingRepair, validateWriting, englishWordCount } from '../lib/editorial.mjs';
import { createModelBatch } from '../lib/model-references.mjs';
import { validateIssue } from '../lib/issue-contract.mjs';
import { runPipeline } from '../lib/pipeline.mjs';
import { sandbox, sample, fakeClient } from './helpers.mjs';

const tags = JSON.parse(await fs.readFile(new URL('../../config/tags.json', import.meta.url)));
const semantic = { scriptRouting: true }, bilingual = { requireEnglish: true };
const cases = [
  ['UDR operating earnings with background Apollo deal', ['multifamily', 'national', 'earnings', 'deals'], false, 'cre'],
  ['FOA ordinary housing finance earnings', ['housing', 'national', 'earnings', 'lender'], false, 'national'],
  ['Phoenix apartment construction', ['multifamily', 'phoenix', 'construction'], false, 'sunbelt'],
  ['Texas office property sale', ['office', 'texas', 'deals'], false, 'cre'],
  ['Houston retail development', ['retail', 'houston', 'construction'], false, 'cre'],
  ['Texas data center', ['data-center', 'texas', 'construction'], false, 'cre'],
  ['OriginPoint platform merger', ['housing', 'national', 'deals', 'lender'], true, 'institutional'],
  ['Property refinancing', ['office', 'national', 'deals'], false, 'cre'],
  ['Real estate fund raising', ['mixed-asset', 'national', 'fundraising'], true, 'institutional'],
  ['Deutsche Finance BVK capital governance risk', ['mixed-asset', 'national', 'regulation'], true, 'institutional'],
  ['Actual BTR acquisition beats capital priority', ['btr-sfr', 'texas', 'deals'], true, 'btr'],
  ['Cross-asset operating research', ['mixed-asset', 'national', 'trend'], false, 'cre'],
  ['Ordinary apartments never BTR', ['multifamily', 'national'], false, 'cre'],
];
test('one router covers the agreed editorial gold cases regardless of model section or source region', () => {
  for (const [name, assetTags, capital_focus, expected] of cases) {
    assert.equal(routeSection({ tags: assetTags, capital_focus, section: 'btr', region: 'texas' }), expected, name);
  }
});
test('editor receives configured meanings and subject geography, not a bare tag list', () => {
  const prompt = editorInstructions(tags);
  assert(prompt.includes(tags.dimensions.asset.tags.find(t => t.id === 'multifamily').applies_to));
  assert(prompt.includes(tags.constraints.hierarchy_rule));
  assert(prompt.includes('max_tags_per_item'));
  assert.match(prompt, /总部、人物和 source_region/);
  assert.doesNotMatch(prompt, /"section":"national"/);
  const [input] = JSON.parse(candidatePrompt([sample('a', Date.now())]));
  assert.equal(input.source_region, 'national'); assert.equal(input.region, undefined);
});
const decision = (extra = {}) => ({ id: 'a', keep: true, importance: 4, tags: ['housing', 'national'], capital_focus: false, duplicate_of: null, ...extra });
test('script routing replaces model section and refines Houston from supplied subject evidence', () => {
  const it = { ...sample('a', 1), description: 'Houston home sales improved while inventory remained high.' };
  const result = validateDecisions({ decisions: [decision({ section: 'btr', tags: ['housing', 'texas'], geo_evidence: it.description })] }, [it], tags, semantic).decisions[0];
  assert.equal(result.section, 'sunbelt'); assert.deepEqual(result.tags, ['housing', 'houston']);
});
test('headquarters, missing evidence, unconfigured tags and excess dimensions cannot pass new editor contract', () => {
  const it = { ...sample('a', 1), description: 'FOA is headquartered in Plano, Texas. Its mortgage business reported earnings.' };
  for (const extra of [
    { capital_focus: undefined }, { tags: ['housing', 'invented'] }, { tags: ['national'] },
    { tags: ['housing', 'texas'], geo_evidence: 'Houston sales rose.' },
    { tags: ['housing', 'texas'], geo_evidence: 'FOA is headquartered in Plano, Texas.' },
    { tags: ['housing', 'texas'], geo_evidence: 'Plano, Texas' },
    { tags: ['housing', 'multifamily', 'national'] }, { tags: ['housing', 'national', 'texas'] },
    { tags: ['housing', 'national', 'earnings', 'deals', 'data'] },
  ]) assert.throws(() => validateDecisions({ decisions: [decision(extra)] }, [it], tags, semantic));
  assert.equal(validateDecisions({ decisions: [decision()] }, [it], tags, semantic).decisions[0].section, 'national');
});

const selected = Array.from({ length: 20 }, (_, i) => ({ ...sample(String(i + 1), 1793820000000), section: 'national', tags: ['housing', 'national'], capital_focus: false }));
const card = it => ({ id: it.id, title_zh: '住宅市场研究', summary_zh: '住宅销售增长 5%。', impact: 'neutral', evidence_quote: it.description });
const metadata = () => ({ executive_summary: { sentences: [
  { text: '住宅市场分化。'.repeat(15), text_en: 'Housing sales rose 5%, with affordability remaining a constraint.', item_ids: ['1'] },
  { text: '需要关注库存。'.repeat(12), text_en: 'Inventory remains an important constraint.', item_ids: ['2'] },
  { text: '仍需观察。'.repeat(20), text_en: 'Further developments require monitoring.', item_ids: ['3'] },
] }, themes: [{ title: '住房市场分化', title_en: 'Housing market divergence', item_ids: ['1'] }] });
const writing = () => ({ items: selected.map(card), ...metadata() });
test('two bad cards repair alone while original bilingual metadata keeps a validated full-sentence prefix', () => {
  const data = writing(); data.items[8].title_zh = '新增 17300 套'; data.items[18].evidence_quote = 'Invented unsupported quotation';
  const good = data.items.filter((_, i) => ![8, 18].includes(i));
  const plan = createWritingRepair(data, selected, 'weekly', (d, ctx) => {
    const result = prepareWriting(d, selected, 'weekly', bilingual);
    result.validation_notes.summary_shortening ||= ctx.summaryShortening; return result;
  }, bilingual);
  const request = JSON.parse(plan.user);
  assert.deepEqual(request.items.map(it => it.id), ['9', '19']);
  assert.equal(request.original_evidence, undefined); assert.equal(request.previous_metadata, undefined);
  const result = plan.validate({ items: [card(selected[8]), card(selected[18])] }, {});
  assert.deepEqual(result.executive_summary.sentences, metadata().executive_summary.sentences.slice(0, 2));
  assert.equal(result.validation_notes.summary_shortening.kept_sentence_count, 2);
  assert.deepEqual(result.items.filter((_, i) => ![8, 18].includes(i)).map(it => ({ id: it.id, title_zh: it.title_zh, summary_zh: it.summary_zh, impact: it.impact, evidence_quote: it.evidence_quote })), good);
});
for (const failure of ['first-too-long', 'tail-number', 'tail-reference', 'english-tail-number', 'english-tail-chinese']) test('metadata repair remains required for ' + failure, () => {
  const data = writing(); data.items[8].title_zh = '新增 17300 套';
  const tail = data.executive_summary.sentences[2];
  if (failure === 'first-too-long') data.executive_summary.sentences[0].text = '甲'.repeat(251);
  if (failure === 'tail-number') tail.text += '增长 9999%。';
  if (failure === 'tail-reference') tail.item_ids = ['unknown'];
  if (failure === 'english-tail-number') tail.text_en += ' Growth was 9999%.';
  if (failure === 'english-tail-chinese') tail.text_en += '中文';
  const plan = createWritingRepair(data, selected, 'weekly', d => prepareWriting(d, selected, 'weekly', bilingual), bilingual);
  assert.equal(JSON.parse(plan.user).original_evidence.length, 20);
});
test('English word budget shares sentence boundaries and cannot hide invalid trailing facts', () => {
  const data = writing(); data.executive_summary.sentences = [
    { text: '住宅市场分化。', text_en: 'Housing '.repeat(100).trim(), item_ids: ['1'] },
    { text: '库存仍有约束。', text_en: 'Inventory '.repeat(60).trim(), item_ids: ['2'] },
  ];
  const result = prepareWriting(data, selected, 'daily', bilingual);
  assert.equal(result.executive_summary.sentences.length, 1);
  assert.equal(englishWordCount(result.executive_summary.text_en), 100);
  const exact = writing(); exact.executive_summary.sentences = [{ text: '住宅市场分化。', text_en: 'Housing '.repeat(150), item_ids: ['1'] }];
  assert.equal(englishWordCount(prepareWriting(exact, selected, 'daily', bilingual).executive_summary.text_en), 150);
  exact.executive_summary.sentences[0].text_en += ' housing';
  assert.throws(() => prepareWriting(exact, selected, 'daily', bilingual), /150 words/);
});
test('English uses the same short-reference graph and new published schema enforces both language and route', () => {
  const batch = createModelBatch(selected.map((it, i) => ({ ...it, id: 'stable-' + i })));
  const data = writing(), prepared = prepareWritingMetadata(data, selected, 'weekly', bilingual);
  const mapped = batch.writing({ ...data, ...prepared });
  assert.equal(mapped.executive_summary.sentences[0].text_en, prepared.executive_summary.sentences[0].text_en);
  assert.deepEqual(mapped.executive_summary.sentences[0].item_ids, ['stable-0']);
  const issue = { schema_version: 2, editorial_schema: 2, kind: 'daily', publication_status: 'complete', date: '2026-11-05', window: { lower: 1793740000000, upper: 1793910000000, date: '2026-11-05' }, ...prepareWriting(data, selected, 'daily', bilingual) };
  assert.doesNotThrow(() => validateIssue(issue));
  const badRoute = structuredClone(issue); badRoute.items[0].section = 'btr'; assert.throws(() => validateIssue(badRoute), /section mismatch/);
  const noEnglish = structuredClone(issue); delete noEnglish.executive_summary.sentences[0].text_en; assert.throws(() => validateIssue(noEnglish), /English/);
  delete noEnglish.editorial_schema; assert.doesNotThrow(() => validateIssue(noEnglish));
});
test('cold resume freezes trimmed metadata despite bad cards and requests only the remaining card', async t => {
  const root = await sandbox(t), now = new Date('2026-11-05T00:30:00Z'), upper = Date.parse('2026-11-04T21:00:00Z'), lower = upper - 86400000;
  await fs.writeFile(path.join(root, 'config/tags.json'), JSON.stringify(tags));
  const rows = ['alpha', 'beta', 'gamma'].map(id => sample(id, upper - 1000));
  const env = { PUBLISH_NOW: now.toISOString(), NEWS_DATA_DIR: path.join(root, 'data'), NEWS_STATE_DIR: path.join(root, 'state') };
  const collector = { cache: {}, enrich: async items => items, collect: async () => [{ items: rows, health: { id: 'a', status: 'ok', articles: 3, undated: 0, coverage: { lower, upper } } }] };
  const client = fakeClient(), original = client.call;
  client.call = async (system, user, options) => {
    if (options.label === 'editor') return original(system, user, options);
    const input = JSON.parse(user), data = { items: input.items.map(it => card({ ...it, description: it.evidence })), ...metadata() };
    data.items[2].summary_zh = '增长 9999%。'; return options.validate(data);
  };
  await assert.rejects(runPipeline('daily', { root, env, collector, client }), /number absent/);
  const dir = path.join(root, 'state/issues/daily/2026-11-05/r1');
  const frozen = JSON.parse(await fs.readFile(path.join(dir, 'metadata.json')));
  assert.equal(frozen.executive_summary.sentences.length, 2);
  assert.equal(frozen.summary_shortening.kept_sentence_count, 2);
  let calls = 0;
  const result = await runPipeline('daily', { root, env, collector: { collect() { throw Error('Unexpected recollection'); } }, client: { async call(system, user, options) {
    calls++; assert.equal(options.label, 'writer');
    const input = JSON.parse(user); assert.deepEqual(input.items.map(it => it.id), ['3']); assert.equal(input.original_evidence, undefined);
    return options.validate({ items: input.items.map(it => card({ ...it, description: it.evidence })) });
  } } });
  assert.equal(calls, 1); assert.equal(result.items.length, 3);
  assert.equal(result.editorial_schema, 2);
  assert.deepEqual(result._diagnostics.writer_validation.summary_shortening, frozen.summary_shortening);
  assert.deepEqual(result.executive_summary.sentences.map(row => row.text_en), frozen.executive_summary.sentences.map(row => row.text_en));
  assert.doesNotThrow(() => validateWriting(result, result.items, 'daily', bilingual));
});
