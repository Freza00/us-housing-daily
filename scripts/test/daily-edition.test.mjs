import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runPipeline } from '../lib/pipeline.mjs';
import { validateIssue } from '../lib/issue-contract.mjs';
import { dailyWritingSystem, prepareWritingCard, prepareWritingMetadata, writingPrompt } from '../lib/editorial.mjs';
import { assembleDailyEdition, isDailyUSStory } from '../lib/daily-edition.mjs';
import { modelDecision, sandbox, sample, replayEnv } from './helpers.mjs';

const now = '2026-11-11T01:00:00Z';
const article = (id, section = 'national', asset = 'housing', importance = 3) => ({ id, section, tags: [asset], importance });
const response = value => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }),
  { headers: { 'content-type': 'application/json' } });
const cardFor = (id, value = 5) => ({ id, title_zh: '住宅市场研究', summary_zh: '报告显示销售增长 ' + value + '%。', impact: 'neutral' });
const summary = id => ({ text: '研究显示住宅销售增长 5%。', text_en: 'The report shows housing sales rose 5%.', item_ids: [id] });

async function dailyHarness(t, count, write) {
  const root = await sandbox(t);
  const rows = Array.from({ length: count }, (_, index) => sample('source-' + index, Date.parse('2026-11-10T10:00:00Z')));
  const env = { ...await replayEnv(root, { items: rows }, now), LLM_ENDPOINT: 'https://offline.invalid', LLM_API_KEY: 'fixture', PIPELINE_UNTIL: 'ready' };
  let writers = 0, issueDir;
  const read = async phase => JSON.parse(await fs.readFile(path.join(issueDir, phase + '.json')));
  const fetchImpl = async (_url, request) => {
    const input = JSON.parse(JSON.parse(request.body).messages[1].content);
    if (Array.isArray(input)) return response({ decisions: input.map(it => modelDecision(it.id, { importance: 3 })) });
    return response(await write(input, ++writers, read));
  };
  const run = (options = {}) => runPipeline('daily', { root, env,
    onCheckpoint(stage, store) { issueDir = store.dir; },
    llmOptions: { fetchImpl, retryDelays: [0, 0], sleep: async () => {} }, ...options });
  return { run, read, get writers() { return writers; } };
}

function assertMetadataOnly(input) {
  assert.deepEqual(input.items.map(it => it.id), Array.from({ length: 20 }, (_, index) => String(index + 1)));
  assert(input.items.every(it => !it.reserve && !it.summary_zh && !it.title_zh && !it.impact));
  assert.equal(input.corrections, undefined);
  assert.equal(input.original_evidence, undefined);
}

for (const mixed of [false, true]) test(`reserve references in ${mixed ? 'one mixed sentence' : 'two sentences'} require metadata-only repair and retain all good cards`, async t => {
  const harness = await dailyHarness(t, 26, async (input, attempt, read) => {
    if (attempt === 1) {
      assert.equal(input.items.length, 26);
      return { items: input.items.map(it => cardFor(it.id)), executive_summary: { sentences: mixed
        ? [{ ...summary('1'), item_ids: ['1', '26'] }]
        : [summary('1'), summary('21')] }, themes: [] };
    }
    assertMetadataOnly(input);
    assert.match(input.error, /cannot reference reserve items/);
    assert.equal((await read('cards')).items.length, 26);
    await assert.rejects(read('metadata'), { code: 'ENOENT' });
    const manifest = await read('manifest');
    assert.equal(manifest.phases.ready, undefined);
    return { executive_summary: { sentences: [summary('1')] }, themes: [] };
  });
  await harness.run();
  const { payload } = await harness.read('ready');
  validateIssue(payload);
  assert.equal(payload._diagnostics.writing_plan.pool_size, 26);
  assert.equal(payload.items.length, 20);
  assert.equal(payload.summary_status, 'available');
  assert.equal(harness.writers, 2);
  assert.deepEqual(payload.items.map(it => it.summary_zh), Array(20).fill('报告显示销售增长 5%。'));
});

for (const problem of ['number', 'english']) test(`a ${problem} summary error repairs metadata before sealing 20 good primary cards`, async t => {
  const harness = await dailyHarness(t, 20, (input, attempt) => {
    if (attempt === 1) {
      const sentence = summary('1');
      if (problem === 'number') sentence.text = '报告显示销售增长 99%。';
      else delete sentence.text_en;
      return { items: input.items.map(it => cardFor(it.id)), executive_summary: { sentences: [sentence] }, themes: [] };
    }
    assertMetadataOnly(input);
    assert.match(input.error, problem === 'number' ? /number absent/ : /English overview/);
    return { executive_summary: { sentences: [summary('1')] }, themes: [] };
  });
  await harness.run();
  const { payload } = await harness.read('ready');
  validateIssue(payload);
  assert.equal(harness.writers, 2);
  assert.equal(payload.items.length, 20);
  assert.equal(payload.summary_status, 'available');
});

test('three failed summary attempts seal good cards without summary and unknown-budget cold resume makes no request', async t => {
  const harness = await dailyHarness(t, 26, (input, attempt) => {
    if (attempt > 1) assertMetadataOnly(input);
    return { ...(attempt === 1 ? { items: input.items.map(it => cardFor(it.id)) } : {}),
      executive_summary: { sentences: [summary('26')] }, themes: [] };
  });
  const result = await harness.run();
  const { payload } = await harness.read('ready'), manifest = await harness.read('manifest');
  validateIssue(payload);
  assert.equal(harness.writers, 3);
  assert.equal(manifest.attempts.writer.length, 3);
  assert.equal(payload.items.length, 20);
  assert.equal(payload.content_status, 'passed');
  assert.equal(payload.executive_summary, null);
  assert.equal(payload.summary_status, 'unavailable');
  const attempts = structuredClone(manifest.attempts);
  delete manifest.phases.ready;
  manifest.budget_unknown = ['writer'];
  await fs.writeFile(path.join(result.issue_dir, 'manifest.json'), JSON.stringify(manifest));
  let requests = 0;
  await harness.run({ llmOptions: { fetchImpl() { requests++; throw Error('Unknown budget must not request'); } } });
  const restored = (await harness.read('ready')).payload;
  validateIssue(restored);
  assert.equal(requests, 0);
  assert.deepEqual(restored.items, payload.items);
  assert.equal(restored.content_status, 'passed');
  assert.equal(restored.executive_summary, null);
  assert.equal(restored.summary_status, 'unavailable');
  assert.deepEqual((await harness.read('manifest')).attempts, attempts);
});

test('daily prompt marks only reserves and summary validation rejects them before projection', () => {
  const items = Array.from({ length: 26 }, (_, index) => sample(String(index + 1), 1));
  assert.match(dailyWritingSystem, /"reserve": true/);
  assert.match(dailyWritingSystem, /严禁引用.*候补 ID/);
  const prompt = JSON.parse(writingPrompt('daily', items, { fixedEvidence: true }));
  assert(prompt.items.slice(0, 20).every(it => !Object.hasOwn(it, 'reserve')));
  assert(prompt.items.slice(20).every(it => it.reserve === true));
  for (const count of [1, 20]) assert(JSON.parse(writingPrompt('daily', items.slice(0, count), { fixedEvidence: true })).items.every(it => !Object.hasOwn(it, 'reserve')));
  assert(JSON.parse(writingPrompt('weekly', items)).items.every(it => !Object.hasOwn(it, 'reserve')));
  assert.throws(() => prepareWritingMetadata({ executive_summary: { sentences: [summary('21')] } }, items, 'daily',
    { fixedEvidence: true, requireEnglish: true }), /cannot reference reserve items \(21\)/);
});

for (const missing of [false, true]) test(`a ${missing ? 'missing' : 'bad'} primary card and fully projected-out summary jointly repair across retries`, async t => {
  const harness = await dailyHarness(t, 26, async (input, attempt, read) => {
    if (attempt === 1) return { items: input.items.filter(it => !missing || it.id !== '4').map(it => cardFor(it.id, it.id === '4' ? 99 : 5)),
      executive_summary: { sentences: [summary('4')] }, themes: [] };
    assert.deepEqual(input.items.map(it => it.id), ['4']);
    assert.deepEqual(input.original_item_ids, Array.from({ length: 20 }, (_, i) => String(i + 1)));
    assert.equal(input.original_evidence.length, 20);
    assert(input.original_evidence.every(it => !it.reserve));
    assert.match(input.metadata_error, /does not reference any published story/);
    assert.equal((await read('cards')).items.length, 25);
    const cited = (await read('metadata')).executive_summary.sentences[0].item_ids[0];
    assert(!(await read('cards')).items.some(it => it.id === cited));
    return { items: [cardFor('4', 99)], executive_summary: { sentences: [summary(attempt === 2 ? '4' : '1')] }, themes: [] };
  });
  await harness.run();
  const { payload } = await harness.read('ready');
  validateIssue(payload);
  assert.equal(harness.writers, 3);
  assert.equal(payload.items.length, 20);
  assert.equal(payload.summary_status, 'available');
  assert.equal(payload._diagnostics.writing_plan.replacements.length, 1);
  assert.equal((await harness.read('metadata')).executive_summary.sentences[0].item_ids[0], payload.items[0].id);
});

test('cold resume with 26 good cards and no metadata requests only primary summary evidence', async t => {
  const harness = await dailyHarness(t, 26, (input, attempt) => {
    if (attempt > 1) assertMetadataOnly(input);
    return { ...(attempt === 1 ? { items: input.items.map(it => cardFor(it.id)) } : {}), executive_summary: { sentences: [summary('1')] }, themes: [] };
  });
  const result = await harness.run();
  const originalCards = await harness.read('cards'), manifest = await harness.read('manifest');
  delete manifest.phases.ready;
  delete manifest.phases.metadata;
  await fs.writeFile(path.join(result.issue_dir, 'manifest.json'), JSON.stringify(manifest));
  await harness.run();
  const { payload } = await harness.read('ready');
  validateIssue(payload);
  assert.equal(harness.writers, 2);
  assert.equal(payload.items.length, 20);
  assert.equal(payload.summary_status, 'available');
  assert.deepEqual(await harness.read('cards'), originalCards);
});

test('joint repair keeps reserve flags on a reduced bad-card request and limits summary evidence to primaries', async t => {
  const harness = await dailyHarness(t, 26, async (input, attempt, read) => {
    if (attempt === 1) return { items: input.items.map(it => cardFor(it.id, it.id === '21' ? 99 : 5)),
      executive_summary: { sentences: [summary('26')] }, themes: [] };
    assert.equal((await read('cards')).items.length, 25);
    assert.deepEqual(input.items.map(it => it.id), ['21']);
    assert.equal(input.items[0].reserve, true);
    assert.match(input.metadata_error, /cannot reference reserve items \(26\)/);
    assert.deepEqual(input.original_item_ids, Array.from({ length: 20 }, (_, index) => String(index + 1)));
    assert.deepEqual(input.original_evidence.map(it => it.id), input.original_item_ids);
    assert(input.original_evidence.every(it => !it.reserve));
    return { items: [cardFor('21')], executive_summary: { sentences: [summary('1')] }, themes: [] };
  });
  await harness.run();
  const { payload } = await harness.read('ready');
  validateIssue(payload);
  assert.equal(harness.writers, 2);
  assert.equal((await harness.read('cards')).items.length, 26);
  assert.equal(payload.items.length, 20);
  assert.equal(payload.summary_status, 'available');
});

test('a daily-pool-v1 archive remains valid without an executive summary and still rejects status mismatch', async t => {
  const harness = await dailyHarness(t, 20, () => ({ items: Array.from({ length: 20 }, (_, i) => cardFor(String(i + 1))), executive_summary: null, themes: [] }));
  await harness.run();
  const { payload } = await harness.read('ready');
  assert.equal(payload.items.length, 20);
  assert.equal(payload.executive_summary, null);
  assert.equal(payload.summary_status, 'unavailable');
  validateIssue(payload, { kind: 'daily', period: payload.date, upper: payload.window.upper });
  assert.throws(() => validateIssue({ ...payload, summary_status: 'available' }, { kind: 'daily', period: payload.date, upper: payload.window.upper }), /Invalid daily summary status/);
});

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
        geo_evidence: null, market_scope: 'us', market_evidence_id: 'body-1' })) });
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
