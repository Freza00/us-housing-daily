import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runPipeline } from '../lib/pipeline.mjs';
import { validateIssue } from '../lib/issue-contract.mjs';
import { prepareWritingCard } from '../lib/editorial.mjs';
import { assembleDailyEdition, isDailyUSStory } from '../lib/daily-edition.mjs';
import { modelDecision, sandbox, sample, replayEnv } from './helpers.mjs';

const now = '2026-11-11T01:00:00Z';
const article = (id, section = 'national', asset = 'housing', importance = 3) => ({ id, section, tags: [asset], importance });
const response = value => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }),
  { headers: { 'content-type': 'application/json' } });
const cardFor = (id, value = 5) => ({ id, title_zh: '住宅市场研究', summary_zh: '报告显示销售增长 ' + value + '%。', impact: 'neutral' });
const summary = id => ({ text: '研究显示住宅销售增长 5%。', text_en: 'The report shows housing sales rose 5%.', item_ids: [id] });

test('daily US scope excludes London assets while accepting a London buyer of an evidenced Texas asset', () => {
  const london = { title: 'UK pension funds buy BTR homes', description: 'The portfolio comprises homes in and around London.' };
  const texas = { title: 'London investors acquire US apartments', description: 'The company is based in London. The property is in Dallas, Texas.' };
  assert.equal(isDailyUSStory(london, { market_scope: 'us', geo_evidence: 'in and around London' }), false);
  assert.equal(isDailyUSStory(london, { market_scope: 'us', market_evidence: 'The property is in Dallas, Texas.' }), false);
  assert.equal(isDailyUSStory(texas, { market_scope: 'non-us' }), false);
  assert.equal(isDailyUSStory(texas, { market_scope: 'us', market_evidence: 'The company is based in London.' }), false);
  assert.equal(isDailyUSStory(texas, { market_scope: 'us', market_evidence: 'The property is in Dallas, Texas.' }), true);
  assert.equal(isDailyUSStory({ title: 'New England apartment demand grows', description: 'Market update.' }, { market_scope: 'us' }), true);
  assert.equal(isDailyUSStory(texas, {}), false);
});

test('daily writer needs no range ID, ignores model-supplied quotes and checks the window it was given', () => {
  const item = { ...sample('1', 1), description: 'The report says sales rose 5%. ' + 'Housing research remains relevant. '.repeat(65) + ' Other measures show 99%.' };
  const original = prepareWritingCard(cardFor('1'), item, { fixedEvidence: true });
  const injected = prepareWritingCard({ ...cardFor('1'), evidence_id: '1:body-1-8', evidence_quote: 'Other measures show 99%.' }, item, { fixedEvidence: true });
  assert.equal(injected.evidence_quote, original.evidence_quote);
  assert.equal(injected.evidence_id, undefined);
  assert.throws(() => prepareWritingCard(cardFor('1', 99), item, { fixedEvidence: true }), /number absent/);
  const cities = { ...item, description: 'The report tracks housing sales in 12 cities. Sales rose 5%.' };
  assert.throws(() => prepareWritingCard(cardFor('1', 12), cities, { fixedEvidence: true }), /percentage unit/);
  assert.throws(() => prepareWritingCard({ ...original, evidence_quote: 'Other measures show 99%.' }, item, { fixedEvidence: true, cacheHit: true }), /differs from the frozen source/);
});

test('a missing market scope is corrected before editor decisions are frozen', async t => {
  const root = await sandbox(t), rows = ['alpha', 'beta'].map(id => sample(id, Date.parse('2026-11-10T10:00:00Z')));
  const env = { ...await replayEnv(root, { items: rows }, now), LLM_ENDPOINT: 'https://offline.invalid', LLM_API_KEY: 'fixture', PIPELINE_UNTIL: 'ready' };
  let editors = 0;
  const fetchImpl = async (_url, request) => {
    const input = JSON.parse(JSON.parse(request.body).messages[1].content);
    if (Array.isArray(input)) {
      editors++;
      return response({ decisions: input.map((item, index) => {
        const row = modelDecision(item.id);
        if (!index) delete row.market_scope;
        return row;
      }) });
    }
    if (input.corrections) {
      editors++;
      assert.equal(input.items.length, 1);
      return response({ decisions: input.items.map(it => ({ id: it.id, asset: 'housing', geo: 'national', topics: [], actor: null,
        geo_evidence: null, market_scope: 'us', market_evidence: null })) });
    }
    return response({ items: input.items.map(it => cardFor(it.id)), executive_summary: { sentences: [summary('1')] }, themes: [] });
  };
  const result = await runPipeline('daily', { root, env, llmOptions: { fetchImpl, retryDelays: [0, 0], sleep: async () => {} } });
  assert.equal(editors, 2);
  const decisions = JSON.parse(await fs.readFile(path.join(result.issue_dir, 'editor.json')));
  assert(decisions.every(row => row.market_scope === 'us'));
});

test('seal prioritizes same-sector replacements and protects important stories and sections', () => {
  const primary = Array.from({ length: 20 }, (_, index) => article(String(index)));
  primary[4] = article('4', 'cre', 'office');
  primary[7] = article('7', 'cre', 'industrial');
  primary[8] = article('8', 'btr', 'btr-sfr', 4);
  const office = article('r-office', 'cre', 'office'), housing = article('r-housing');
  const pool = [...primary, housing, office], good = primary.filter(it => !['4', '5'].includes(it.id));
  const result = assembleDailyEdition(primary, pool, [...good, housing, office], null);
  assert.deepEqual(result.writing.replacements, [{ deferred_id: '4', published_id: office.id }, { deferred_id: '5', published_id: housing.id }]);
  assert.equal(assembleDailyEdition(primary, pool, good, null), null);
  assert.equal(assembleDailyEdition(primary, pool, good, null, { allowPartial: true }).writing.shortfall, 2);
  assert.equal(assembleDailyEdition(primary, pool, good.filter(it => it.id !== '8'), null, { allowPartial: true }), null);
  const lowPriorityBtr = { ...primary[8], importance: 3 };
  const withoutBtr = primary.map(it => it.id === '8' ? lowPriorityBtr : it);
  assert.equal(assembleDailyEdition(withoutBtr, pool, good.filter(it => it.id !== '8'), null, { allowPartial: true }), null);
  assert.equal(assembleDailyEdition(primary, pool, good.filter(it => !['10', '11'].includes(it.id)), null, { allowPartial: true }), null);
});

for (const withReserves of [true, false]) test(withReserves
  ? 'disconnect and three bad primary cards still seal 20 using validated reserves'
  : 'exhausted writer seals 17 and drops summary pairs referencing the deferred cards', async t => {
  const root = await sandbox(t), count = withReserves ? 28 : 20;
  const rows = Array.from({ length: count }, (_, index) => sample('source-' + index, Date.parse('2026-11-10T10:00:00Z')));
  const env = { ...await replayEnv(root, { items: rows }, now), LLM_ENDPOINT: 'https://offline.invalid', LLM_API_KEY: 'fixture', PIPELINE_UNTIL: 'ready' };
  let writers = 0;
  const failed = ['4', '5', '6'];
  const fetchImpl = async (_url, request) => {
    const input = JSON.parse(JSON.parse(request.body).messages[1].content);
    if (Array.isArray(input)) return response({ decisions: input.map(it => modelDecision(it.id, { importance: 3 })) });
    assert(input.items.every(it => !it.evidence_options && it.evidence.length > 20));
    writers++;
    if (writers === 1) {
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"{"}}]}\n\n'));
        controller.error(new TypeError('terminated'));
      } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (writers === 2) {
      assert.equal(input.items.length, withReserves ? 26 : 20);
      return response({ items: input.items.map(it => cardFor(it.id, failed.includes(it.id) ? 99 : 5)),
        executive_summary: { sentences: [summary('4'), summary('1')] }, themes: [] });
    }
    assert.deepEqual(input.items.map(it => it.id), failed);
    return response({ items: input.items.map(it => cardFor(it.id, 99)) });
  };
  const result = await runPipeline('daily', { root, env, llmOptions: { fetchImpl, retryDelays: [0, 0], sleep: async () => {} } });
  const read = async file => JSON.parse(await fs.readFile(path.join(result.issue_dir, file + '.json')));
  const { payload } = await read('ready'), manifest = await read('manifest');
  validateIssue(payload);
  const outsideMarket = structuredClone(payload);
  outsideMarket.items[0].market_scope = 'non-us';
  assert.throws(() => validateIssue(outsideMarket), /verified US scope/);
  assert.equal(payload.items.length, withReserves ? 20 : 17);
  assert.equal(payload.content_status, withReserves ? 'passed' : 'partial');
  assert.equal(writers, withReserves ? 2 : 3);
  assert.equal(manifest.attempts.writer.length, writers);
  assert.equal(manifest.attempts.editor.length, 1);
  assert.equal(payload._diagnostics.writing_plan.deferred.length, 3);
  assert.equal(payload._diagnostics.writing_plan.replacements.length, withReserves ? 3 : 0);
  assert.equal(payload.executive_summary.sentences.length, 1);
  assert(payload.items.some(item => item.id === payload.executive_summary.sentences[0].item_ids[0]));
  assert.equal(Object.keys(payload._diagnostics.source_counts).length, payload.items.length);
  await runPipeline('daily', { root, env, client: { call() { throw Error('Sealed issue must not call a model'); } } });
  assert.deepEqual((await read('ready')).payload, payload);
  if (!withReserves) {
    const frozenAttempts = structuredClone(manifest.attempts);
    delete manifest.phases.ready;
    manifest.budget_unknown = ['writer'];
    await fs.writeFile(path.join(result.issue_dir, 'manifest.json'), JSON.stringify(manifest));
    await runPipeline('daily', { root, env, llmOptions: { fetchImpl() { throw Error('No model request with unknown or exhausted budget'); } } });
    const restored = await read('ready');
    assert.deepEqual(restored.payload.items, payload.items);
    assert.equal(restored.payload.content_status, 'partial');
    assert.deepEqual((await read('manifest')).attempts, frozenAttempts);
  }
});
