import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runPipeline } from '../lib/pipeline.mjs';
import { ISSUE_MODEL_BUDGET_MS } from '../lib/llm-client.mjs';
import { validateIssue } from '../lib/issue-contract.mjs';
import { dailyWritingSystem, isMortgageRateStory, prepareReview, prepareWritingCard, prepareWritingMetadata, writingPrompt } from '../lib/editorial.mjs';
import { assembleDailyEdition, isDailyUSStory } from '../lib/daily-edition.mjs';
import { buildDefaultOutlook, outlookAllowedDates, outlookDateMentions, upcomingReleases } from '../lib/release-calendar.mjs';
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
    if (input.review_target) return response({ status: 'pass', issues: [], items: [] });
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
  manifest.budget_unknown = ['writer', 'reviewer'];
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
  delete manifest.phases.reviewer;
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
    if (input.review_target) return response({ status: 'pass', issues: [], items: [] });
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
    if (input.review_target) return response({ status: 'pass', issues: [], items: [] });
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
    manifest.budget_unknown = ['writer', 'reviewer'];
    await fs.writeFile(path.join(result.issue_dir, 'manifest.json'), JSON.stringify(manifest));
    await runPipeline('daily', { root, env, llmOptions: { fetchImpl() { throw Error('No model request with unknown or exhausted budget'); } } });
    const restored = await read('ready');
    assert.deepEqual(restored.payload.items, payload.items);
    assert.equal(restored.payload.content_status, 'partial');
    assert.deepEqual((await read('manifest')).attempts, frozenAttempts);
  }
});

test('daily pins latest mortgage rate report to items[0] within 20-item quota and admits post-holiday rate fallback', async t => {
  const root = await sandbox(t);
  const issueNow = '2026-11-18T01:00:00Z';
  const rows = Array.from({ length: 22 }, (_, index) => sample('source-' + index, Date.parse('2026-11-17T10:00:00Z')));
  const rateItem = {
    ...sample('mnd-rates-1', Date.parse('2026-11-14T15:00:00Z')),
    source_id: 'mnd-rates',
    source_name: 'Mortgage News Daily — Rate Watch',
    rate_benchmark: true,
    weight: 10,
    tags: ['housing', 'rates', 'data', 'trend'],
    title: 'Mortgage Rates Hold at 5%',
    description: 'The report shows 30-year fixed mortgage rates held at 5% across the United States housing market according to Mortgage News Daily.'
  };
  const env = { ...await replayEnv(root, { items: [...rows, rateItem] }, issueNow), LLM_ENDPOINT: 'https://offline.invalid', LLM_API_KEY: 'fixture', PIPELINE_UNTIL: 'ready' };
  const fetchImpl = async (_url, request) => {
    const input = JSON.parse(JSON.parse(request.body).messages[1].content);
    if (Array.isArray(input)) {
      return response({ decisions: input.map((it, idx) => modelDecision(it.id, {
        importance: idx === 0 ? 5 : 3,
        topics: it.source_id === 'mnd-rates' ? ['rates', 'mortgage'] : ['market']
      })) });
    }
    if (input.review_target) return response({ status: 'pass', issues: [], items: [] });
    return response({
      items: input.items.map(it => cardFor(it.id)),
      executive_summary: {
        sentences: [summary('1')],
        outlook: {
          text: '未来 30 天内，关注 11 月 19 日 NAR 成屋销售与 12 月 8 日至 9 日美联储 FOMC 利率决议。',
          text_en: 'Over the next 30 days, watch NAR Existing-Home Sales on November 19 and the FOMC rate decision on December 8 to 9.'
        }
      },
      themes: []
    });
  };
  const result = await runPipeline('daily', { root, env, llmOptions: { fetchImpl, retryDelays: [0, 0], sleep: async () => {} } });
  const { payload } = JSON.parse(await fs.readFile(path.join(result.issue_dir, 'ready.json')));
  validateIssue(payload);
  assert.equal(payload.items.length, 20);
  assert.equal(payload.items[0].source_id, 'mnd-rates');
  assert.equal(payload.items[0].section, 'national');
  assert(isMortgageRateStory(payload.items[0]));
  assert.match(payload.executive_summary.outlook.text, /未来 30 天内/);
  const swapped = structuredClone(payload);
  [swapped.items[0], swapped.items[1]] = [swapped.items[1], swapped.items[0]];
  assert.throws(() => validateIssue(swapped), /Daily issue must place the latest mortgage rate story first/);
});

test('assembleDailyEdition protects primary[0] mortgage rate lead unless replaced by a validated mortgage-rate reserve', () => {
  const primary = Array.from({ length: 20 }, (_, index) => article(String(index + 1)));
  primary[0] = { ...article('1', 'national', 'housing', 4), source_id: 'mnd-rates', rate_benchmark: true, title: '30-Year Fixed Mortgage Rates Fall' };
  const nonRateReserve = article('21', 'national', 'housing', 3);
  const rateReserve = { ...article('22', 'national', 'housing', 3), source_id: 'freddie-pmms', rate_benchmark: true, title: 'Freddie Mac PMMS Mortgage Rates' };
  const withoutLead = primary.slice(1);
  assert.equal(assembleDailyEdition(primary, [...primary, nonRateReserve], [...withoutLead, nonRateReserve], null, { allowPartial: false }), null);
  const partialWithoutLead = assembleDailyEdition(primary, [...primary, nonRateReserve], [...withoutLead, nonRateReserve], null, { allowPartial: true });
  assert.equal(partialWithoutLead.items.length, 19);
  assert.equal(partialWithoutLead.writing.shortfall, 1);
  const replaced = assembleDailyEdition(primary, [...primary, nonRateReserve, rateReserve], [...withoutLead, rateReserve], null);
  assert.equal(replaced.items.length, 20);
  assert.equal(replaced.items[0].id, '22');
  assert.deepEqual(replaced.writing.replacements, [{ deferred_id: '1', published_id: '22' }]);
  primary[3] = article('4', 'national', 'housing', 4);
  const withoutImportantNonLead = primary.filter(it => it.id !== '4');
  assert.equal(assembleDailyEdition(primary, [...primary, nonRateReserve], withoutImportantNonLead, null, { allowPartial: true }), null);
});

test('30-day upcoming release outlook validates against official schedule with an independent character budget', () => {
  const schedule = upcomingReleases('2026-11-18', 30);
  assert(schedule.length >= 6);
  assert(schedule.some(it => it.id.startsWith('fomc-')));
  assert(schedule.some(it => it.id.startsWith('bls-cpi-')));
  assert(schedule.some(it => it.id.startsWith('nar-ehs-')));
  assert(schedule.some(it => it.id.startsWith('census-nrc-')));
  assert.equal(schedule.find(it => it.id === 'nar-phs-2026-11')?.date, '2026-11-25');
  assert.equal(upcomingReleases('2026-12-15', 30).find(it => it.id === 'bls-jobs-2027-01')?.date, '2027-01-08');

  const items = Array.from({ length: 20 }, (_, index) => sample(String(index + 1), Date.parse('2026-11-18T10:00:00Z')));
  const longNews = {
    text: '报告显示住宅销售增长 5%，全国核心市场挂牌库存与新屋开工同步改善，机构买家与建商持续关注按揭利率波动及地方审批改革进展，多户住宅与独栋长租板块的融资及租赁需求保持稳健，商业地产与建筑科技投资继续围绕运营效率与资产组合再平衡展开，整体市场在年底前维持结构性分化态势并等待最新通胀及就业数据指引。',
    text_en: 'The report shows housing sales rose 5% as core listings, builder activity, multifamily leasing and institutional capital allocation remained steady across major markets.',
    item_ids: ['1']
  };
  const validOutlook = {
    text: '未来 30 天内，重点关注 11 月 19 日 NAR 成屋销售、11 月 24 日 Case-Shiller 与 FHFA 房价指数、11 月 25 日新屋销售、12 月 4 日非农就业、12 月 8 日至 9 日美联储 FOMC 利率决议及每周四 Freddie Mac PMMS 按揭利率调查。',
    text_en: 'Over the next 30 days, key scheduled releases include NAR Existing-Home Sales on November 19, Case-Shiller and FHFA HPI on November 24, New Residential Sales on November 25, Nonfarm Payrolls on December 4, the FOMC rate decision on December 8 to 9, and weekly Freddie Mac PMMS surveys.'
  };
  const validated = prepareWritingMetadata(
    { executive_summary: { sentences: [longNews], outlook: validOutlook }, themes: [] },
    items,
    'daily',
    { fixedEvidence: true, requireEnglish: true, issueDate: '2026-11-18' }
  );
  assert.equal(validated.executive_summary.outlook.text, validOutlook.text);
  assert.throws(() => prepareWritingMetadata(
    { executive_summary: { sentences: [summary('1')], outlook: { text: '未来 30 天内按揭利率预计下降 99%。', text_en: 'Over the next 30 days mortgage rates will drop 99%.' } }, themes: [] },
    items,
    'daily',
    { fixedEvidence: true, requireEnglish: true, issueDate: '2026-11-18' }
  ), /number absent/);
  const fallbackMeta = prepareWritingMetadata(
    { executive_summary: { sentences: [summary('1')] }, themes: [] },
    items,
    'daily',
    { fixedEvidence: true, requireEnglish: true, issueDate: '2026-11-18' }
  );
  assert.match(fallbackMeta.executive_summary.outlook.text, /未来 30 天/);
  const weeklyMeta = prepareWritingMetadata(
    { executive_summary: { sentences: [summary('1')] }, themes: [{ title: '住宅趋势', title_en: 'Housing trend', item_ids: ['1'] }] },
    items.slice(0, 5),
    'weekly',
    { requireEnglish: true, issueDate: '2026-11-18' }
  );
  assert.equal(weeklyMeta.executive_summary.outlook, undefined);
});

for (const scenario of ['rejected', 'cross_section']) test(`benchmark mortgage rate rescue handles ${scenario} editor output and survives editor-to-ready cold resume`, async t => {
  const root = await sandbox(t);
  const issueNow = '2026-11-18T01:00:00Z';
  const rows = Array.from({ length: 22 }, (_, index) => sample('source-' + index, Date.parse('2026-11-17T10:00:00Z')));
  const rateItem = {
    ...sample('mnd-rates-1', Date.parse('2026-11-17T15:00:00Z')),
    source_id: 'mnd-rates',
    source_name: 'Mortgage News Daily — Rate Watch',
    rate_benchmark: true,
    weight: 10,
    tags: ['housing', 'rates', 'data', 'trend'],
    title: 'Mortgage Rates Hold at 5%',
    description: 'The report shows 30-year fixed mortgage rates held at 5% across the United States housing market according to Mortgage News Daily.'
  };
  const env = { ...await replayEnv(root, { items: [...rows, rateItem] }, issueNow), LLM_ENDPOINT: 'https://offline.invalid', LLM_API_KEY: 'fixture' };
  const fetchImpl = async (_url, request) => {
    const input = JSON.parse(JSON.parse(request.body).messages[1].content);
    if (Array.isArray(input)) {
      return response({ decisions: input.map(it => {
        if (it.source === 'Mortgage News Daily — Rate Watch') {
          return scenario === 'rejected'
            ? { id: it.id, keep: false, duplicate_of: null, reason: 'model rejected' }
            : modelDecision(it.id, { importance: 3, asset: 'multifamily' });
        }
        return modelDecision(it.id, { importance: 3 });
      }) });
    }
    if (input.review_target) return response({ status: 'pass', issues: [], items: [] });
    return response({ items: input.items.map(it => cardFor(it.id)), executive_summary: { sentences: [summary('1')] }, themes: [] });
  };
  const editorStep = await runPipeline('daily', { root, env: { ...env, PIPELINE_UNTIL: 'editor' }, llmOptions: { fetchImpl, retryDelays: [0, 0], sleep: async () => {} } });
  const savedDecisions = JSON.parse(await fs.readFile(path.join(editorStep.issue_dir, 'editor.json')));
  const rawRate = savedDecisions.find(d => d.id === 'mnd-rates-1');
  if (scenario === 'rejected') assert.equal(rawRate.keep, false);
  else assert.equal(rawRate.section, 'cre');
  const readyStep = await runPipeline('daily', { root, env: { ...env, PIPELINE_UNTIL: 'ready' }, llmOptions: { fetchImpl, retryDelays: [0, 0], sleep: async () => {} } });
  const { payload } = JSON.parse(await fs.readFile(path.join(readyStep.issue_dir, 'ready.json')));
  validateIssue(payload);
  assert.equal(payload.items[0].id, 'mnd-rates-1');
  assert.equal(payload.items[0].section, 'national');
  assert.deepEqual(payload.items[0].tags, ['housing', 'national', 'rates']);
  assert.equal(payload._diagnostics.rate_pin.method, 'evidence_rebound');
});

test('non-benchmark fallback mortgage rate persists fallback_rate_id across prepared-to-ready cold resume', async t => {
  const root = await sandbox(t);
  const issueNow = '2026-11-18T01:00:00Z';
  const rows = Array.from({ length: 22 }, (_, index) => sample('source-' + index, Date.parse('2026-11-17T10:00:00Z')));
  const rateItem = {
    ...sample('weekly-rate-1', Date.parse('2026-11-14T15:00:00Z')),
    title: 'Mortgage rates hold near 5% this week',
    description: 'The weekly lender survey shows 30-year fixed mortgage rates held at 5% across the United States housing market, with refinance demand little changed.'
  };
  const env = { ...await replayEnv(root, { items: [...rows, rateItem] }, issueNow), LLM_ENDPOINT: 'https://offline.invalid', LLM_API_KEY: 'fixture' };
  const prepStep = await runPipeline('daily', { root, env: { ...env, PIPELINE_UNTIL: 'prepared' } });
  const prepared = JSON.parse(await fs.readFile(path.join(prepStep.issue_dir, 'prepared.json')));
  assert.equal(prepared.snapshot.fallback_rate_id, 'weekly-rate-1');
  assert.equal(prepared.snapshot.candidate_preparation.fallback_rate_id, 'weekly-rate-1');
  const fetchImpl = async (_url, request) => {
    const input = JSON.parse(JSON.parse(request.body).messages[1].content);
    if (Array.isArray(input)) {
      return response({ decisions: input.map(it => it.title.startsWith('Mortgage rates hold near')
        ? { id: it.id, keep: false, duplicate_of: null, reason: 'model rejected' }
        : modelDecision(it.id, { importance: 3 })) });
    }
    if (input.review_target) return response({ status: 'pass', issues: [], items: [] });
    return response({ items: input.items.map(it => cardFor(it.id)), executive_summary: { sentences: [summary('1')] }, themes: [] });
  };
  await runPipeline('daily', { root, env: { ...env, PIPELINE_UNTIL: 'ready' }, llmOptions: { fetchImpl, retryDelays: [0, 0], sleep: async () => {} } });
  const { payload } = JSON.parse(await fs.readFile(path.join(prepStep.issue_dir, 'ready.json')));
  validateIssue(payload);
  assert.equal(payload.items[0].id, 'weekly-rate-1');
  assert.equal(payload.items[0].section, 'national');
  assert.equal(payload._diagnostics.rate_pin.method, 'evidence_rebound');
});

test('mortgage rate older than 10 days is excluded from fallback admission', async t => {
  const root = await sandbox(t);
  const issueNow = '2026-11-18T01:00:00Z';
  const rows = Array.from({ length: 22 }, (_, index) => sample('source-' + index, Date.parse('2026-11-17T10:00:00Z')));
  const staleRate = {
    ...sample('stale-rate-1', Date.parse('2026-11-05T15:00:00Z')),
    title: 'Mortgage rates hold near 5% this week',
    description: 'The weekly lender survey shows 30-year fixed mortgage rates held at 5% across the United States housing market, with refinance demand little changed.'
  };
  const env = { ...await replayEnv(root, { items: [...rows, staleRate] }, issueNow), LLM_ENDPOINT: 'https://offline.invalid', LLM_API_KEY: 'fixture', PIPELINE_UNTIL: 'prepared' };
  const prepStep = await runPipeline('daily', { root, env });
  const prepared = JSON.parse(await fs.readFile(path.join(prepStep.issue_dir, 'prepared.json')));
  assert.equal(prepared.snapshot.fallback_rate_id, undefined);
  assert(!prepared.snapshot.items.some(it => it.id === 'stale-rate-1'));
});

test('outlook fallback preserves valid sentences without consuming a metadata repair attempt', async t => {
  const harness = await dailyHarness(t, 20, input => ({
    items: input.items.map(it => cardFor(it.id)),
    executive_summary: {
      sentences: [summary('1')],
      outlook: { text: '未来 30 天内关注 99 项发布。', text_en: 'Watch 99 releases over the next 30 days.' }
    },
    themes: []
  }));
  await harness.run();
  const { payload } = await harness.read('ready');
  validateIssue(payload);
  assert.equal(harness.writers, 1);
  assert.equal(payload.executive_summary.sentences[0].text, '研究显示住宅销售增长 5%。');
  assert.match(payload.executive_summary.outlook.text, /^未来 30 天重要发布与报告前瞻/);
  assert.match(payload._diagnostics.writer_validation.outlook_fallback, /number absent/);
  assert.match((await harness.read('metadata')).outlook_fallback, /number absent/);
});

test('strictOutlookDates enforces release calendar dates at generation time while keeping archive validation unchanged', () => {
  const items = Array.from({ length: 20 }, (_, i) => sample(String(i + 1), Date.parse('2026-11-18T10:00:00Z')));
  const ctx = { fixedEvidence: true, requireEnglish: true, issueDate: '2026-11-18' };
  const makeOutlook = d => ({
    text: `未来 30 天内，重点关注 11 月 19 日 NAR 成屋销售与 12 月 ${d} 日非农就业。`,
    text_en: `Over the next 30 days, watch NAR Existing-Home Sales on November 19 and Nonfarm Payrolls on December ${d}.`
  });
  assert.doesNotThrow(() => prepareWritingMetadata({ executive_summary: { sentences: [summary('1')], outlook: makeOutlook(4) }, themes: [] }, items, 'daily', { ...ctx, strictOutlookDates: true }));
  assert.throws(() => prepareWritingMetadata({ executive_summary: { sentences: [summary('1')], outlook: makeOutlook(5) }, themes: [] }, items, 'daily', { ...ctx, strictOutlookDates: true }), /Outlook date is not on the release calendar/);
  assert.doesNotThrow(() => prepareWritingMetadata({ executive_summary: { sentences: [summary('1')], outlook: makeOutlook(5) }, themes: [] }, items, 'daily', ctx));
  for (let ms = Date.UTC(2026, 0, 1); ms <= Date.UTC(2027, 11, 31); ms += 86400000) {
    const ref = new Date(ms).toISOString().slice(0, 10);
    const def = buildDefaultOutlook(ref);
    const allowed = outlookAllowedDates(ref);
    for (const [m, d] of [...outlookDateMentions(def.text), ...outlookDateMentions(def.text_en)]) {
      assert(allowed.has(`${m}-${d}`), `Default outlook date ${m}-${d} missing for ref ${ref}`);
    }
  }
  assert.deepEqual(outlookDateMentions('12 月 8 日至 9 日 FOMC；Dec. 9 and May 2026'), [[12, 8], [12, 9]]);
});

test('prepareReview preserves writer outlook when omitted or when reviewer outlook fails validation', () => {
  const items = Array.from({ length: 20 }, (_, i) => sample(String(i + 1), Date.parse('2026-11-18T10:00:00Z')));
  const ctx = { fixedEvidence: true, requireEnglish: true, issueDate: '2026-11-18', strictOutlookDates: true };
  const cards = items.map(it => prepareWritingCard(cardFor(it.id), it, ctx));
  const draft = {
    items: cards,
    ...prepareWritingMetadata({
      executive_summary: {
        sentences: [summary('1')],
        outlook: {
          text: '未来 30 天内，重点关注 11 月 19 日 NAR 成屋销售。',
          text_en: 'Over the next 30 days, watch NAR Existing-Home Sales on November 19.'
        }
      },
      themes: []
    }, items, 'daily', ctx)
  };
  const omitted = prepareReview({ status: 'revise', issues: [], executive_summary: { sentences: [summary('2')] } }, items, draft, 'daily', ctx);
  assert.equal(omitted.executive_summary.outlook.text, draft.executive_summary.outlook.text);
  const invalidReviewerOutlook = prepareReview({
    status: 'revise',
    issues: [],
    executive_summary: {
      sentences: [summary('2')],
      outlook: { text: '未来 30 天内关注 12 月 5 日非农就业。', text_en: 'Watch Nonfarm Payrolls on December 5.' }
    }
  }, items, draft, 'daily', ctx);
  assert.equal(invalidReviewerOutlook.executive_summary.outlook.text, draft.executive_summary.outlook.text);
});

test('exhausted writer partial seal skips reviewer on cold resume from writer to ready', async t => {
  const root = await sandbox(t);
  const rows = Array.from({ length: 20 }, (_, index) => sample('source-' + index, Date.parse('2026-11-10T10:00:00Z')));
  const env = { ...await replayEnv(root, { items: rows }, now), LLM_ENDPOINT: 'https://offline.invalid', LLM_API_KEY: 'fixture' };
  let writers = 0, reviewers = 0;
  const failed = ['4', '5', '6'];
  const fetchImpl = async (_url, request) => {
    const input = JSON.parse(JSON.parse(request.body).messages[1].content);
    if (Array.isArray(input)) return response({ decisions: input.map(it => modelDecision(it.id, { importance: 3 })) });
    if (input.review_target) { reviewers++; return response({ status: 'pass', issues: [], items: [] }); }
    writers++;
    if (writers === 1) {
      return response({ items: input.items.map(it => cardFor(it.id, failed.includes(it.id) ? 99 : 5)), executive_summary: { sentences: [summary('4'), summary('1')] }, themes: [] });
    }
    return response({ items: input.items.map(it => cardFor(it.id, 99)) });
  };
  await runPipeline('daily', { root, env: { ...env, PIPELINE_UNTIL: 'writer' }, llmOptions: { fetchImpl, retryDelays: [0, 0], sleep: async () => {} } });
  const readyStep = await runPipeline('daily', { root, env: { ...env, PIPELINE_UNTIL: 'ready' }, llmOptions: { fetchImpl, retryDelays: [0, 0], sleep: async () => {} } });
  const { payload } = JSON.parse(await fs.readFile(path.join(readyStep.issue_dir, 'ready.json')));
  validateIssue(payload);
  assert.equal(reviewers, 0);
  assert.equal(payload.content_status, 'partial');
  assert.deepEqual(payload._diagnostics.review, { status: 'skipped', reason: 'writer_exhausted', issues: [], revised_ids: [] });
  assert.equal(payload.items.length, 17);
});

for (const reason of ['budget_unknown', 'model_budget_exhausted', 'delivery_reserve', 'job_deadline']) {
  test(`reviewer stores and warns its skip reason without a physical request: ${reason}`, async t => {
    const root = await sandbox(t);
    const env = { ...await replayEnv(root, { items: [sample('story', Date.parse('2026-11-10T10:00:00Z'))] }, now),
      LLM_ENDPOINT: 'https://offline.invalid', LLM_API_KEY: 'fixture' };
    const seed = await runPipeline('daily', { root, env: { ...env, PIPELINE_UNTIL: 'writer' }, llmOptions: { fetchImpl: async (_url, request) => {
      const input = JSON.parse(JSON.parse(request.body).messages[1].content);
      if (Array.isArray(input)) return response({ decisions: input.map(it => modelDecision(it.id)) });
      assert(!input.review_target);
      return response({ items: input.items.map(it => cardFor(it.id)), executive_summary: { sentences: [summary('1')] }, themes: [] });
    } } });
    const manifestFile = path.join(seed.issue_dir, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile));
    const clock = Date.now();
    t.mock.method(Date, 'now', () => clock);
    const finishEnv = { ...env, GITHUB_ACTIONS: 'true', PIPELINE_UNTIL: 'ready' };
    if (reason === 'budget_unknown') manifest.budget_unknown = ['reviewer'];
    if (reason === 'model_budget_exhausted') manifest.attempts.writer[0].ms = ISSUE_MODEL_BUDGET_MS;
    if (reason === 'delivery_reserve') finishEnv.PUBLICATION_DEADLINE_MS = String(clock + 180000);
    if (reason === 'job_deadline') finishEnv.LLM_JOB_STOP_MS = String(clock);
    await fs.writeFile(manifestFile, JSON.stringify(manifest));
    const warnings = t.mock.method(console, 'warn', () => {});
    const llmOptions = { fetchImpl: async () => assert.fail('Must not make a model request') };
    const finish = await runPipeline('daily', { root, env: finishEnv, llmOptions });
    const { status, reason: savedReason, issues, revised_ids, items, executive_summary, themes } = JSON.parse(await fs.readFile(path.join(finish.issue_dir, 'reviewer.json')));
    const { payload } = JSON.parse(await fs.readFile(path.join(finish.issue_dir, 'ready.json')));
    assert.deepEqual(payload._diagnostics.review, { status: 'skipped', reason, issues: [], revised_ids: [] });
    assert.deepEqual({ status, reason: savedReason, issues, revised_ids }, payload._diagnostics.review);
    assert.deepEqual({ items, executive_summary, themes }, { items: payload.items, executive_summary: payload.executive_summary, themes: payload.themes });
    const after = JSON.parse(await fs.readFile(manifestFile));
    assert.deepEqual(after.attempts, manifest.attempts);
    await runPipeline('daily', { root, env: { ...finishEnv, PIPELINE_UNTIL: 'writer' }, llmOptions });
    assert.deepEqual(warnings.mock.calls.map(call => call.arguments), [[`::warning::reviewer status=skipped reason=${reason}`]]);
  });
}
