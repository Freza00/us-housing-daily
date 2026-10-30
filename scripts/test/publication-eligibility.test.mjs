import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dailyPublicationEligibility, prepareCandidates, validateWriting } from '../lib/editorial.mjs';
import { stageCapture, finishCapture, stageSupplement } from '../lib/collection-checkpoint.mjs';
import { runPipeline } from '../lib/pipeline.mjs';
import { sample, sandbox, fakeClient } from './helpers.mjs';

const lower = Date.parse('2026-10-28T21:00:00Z'), upper = lower + 86400000;
const window = { lower, upper };
const health = { id: 'a', status: 'ok', articles: 1, undated: 0, coverage: window };
const entry = (id, date, extra = {}) => ({ ...sample(id, date), source_id: 'a', source_family: 'a', ...extra });

test('a newly found old article remains raw but cannot enter this or a retried daily', () => {
  const old = entry('old', Date.parse('2026-05-14T05:01:30Z'), { first_seen_at: upper + 1000, is_research: true });
  const staged = stageCapture({ initialized_sources: ['a'], source_upper: { a: lower } }, [{ id: 'a' }], [{ items: [old], health }], window);
  assert.equal(staged.capture.items[0].id, old.id);
  assert.equal(staged.capture.items[0].late_discovery, true);
  assert.equal(staged.capture.items[0].acquisition_window, null);
  for (const items of [staged.capture.items, stageCapture(staged.checkpoint, [{ id: 'a' }], [], window, staged.capture).capture.items]) {
    const result = dailyPublicationEligibility(items, window);
    assert.equal(result.eligible.length, 0);
    assert.equal(result.excluded[0].reason, 'outside_publication_window');
  }
});

test('verified source backlog and writer-failed captures survive beyond seven days', () => {
  const sourceLower = lower - 12 * 86400000;
  const old = entry('delayed-research', sourceLower + 1000);
  const staged = stageCapture({ source_upper: { a: sourceLower } }, [{ id: 'a' }], [{ items: [old], health }], window);
  assert.deepEqual(staged.capture.items[0].acquisition_window, { lower: sourceLower, upper });
  for (const later of [window, { lower: upper + 15 * 86400000, upper: upper + 16 * 86400000 }]) {
    assert.deepEqual(dailyPublicationEligibility(staged.checkpoint.pending.items, later).eligible.map(x => x.id), [old.id]);
  }
});

test('post-cutoff raw becomes eligible next day and remains recoverable after that writer fails', () => {
  const future = entry('post-cutoff', upper + 1000);
  const first = stageCapture({}, [{ id: 'a' }], [{ items: [future], health }], window);
  assert.equal(dailyPublicationEligibility(first.checkpoint.pending.items, window).eligible.length, 0);
  const nextWindow = { lower: upper, upper: upper + 86400000 };
  const next = stageCapture(finishCapture(first.checkpoint, upper), [{ id: 'a' }], [], nextWindow);
  assert.equal(dailyPublicationEligibility(next.capture.items, nextWindow).eligible.length, 1);
  assert.equal(dailyPublicationEligibility(next.checkpoint.pending.items, { lower: nextWindow.upper, upper: nextWindow.upper + 86400000 }).eligible.length, 1);
});

test('weekly and monthly audits cannot authorize old pending material previously denied daily eligibility', () => {
  const old = entry('denied-old', lower - 3 * 86400000);
  const initial = stageCapture({ initialized_sources: ['a'], source_upper: { a: lower } }, [{ id: 'a' }], [{ items: [old], health }], window).checkpoint;
  assert.equal(initial.pending.items[0].acquisition_window, null);
  for (const days of [7, 31]) {
    const audit = stageSupplement(initial, [{ id: 'a' }], [], { lower: lower - days * 86400000, upper });
    assert.equal(audit.pending.items[0].acquisition_window, null);
    assert.equal(dailyPublicationEligibility(audit.pending.items, window).eligible.length, 0);
    assert.deepEqual(audit.source_upper, initial.source_upper);
  }
});

test('legacy raw snapshots attest backlog but expanded pending envelopes and update flags do not', () => {
  const old = entry('legacy', lower - 3600000);
  const late = entry('late', lower - 90 * 86400000, { late_discovery: true });
  const snapshots = [{ window: { lower: lower - 86400000, upper: lower }, items: [old, late] }];
  const result = dailyPublicationEligibility([old, late], window, snapshots);
  assert.deepEqual(result.eligible.map(x => x.id), [old.id]);
  assert.equal(dailyPublicationEligibility([old], window).eligible.length, 0);
  const changed = { ...result.eligible[0], changed_without_new_date: true };
  assert.equal(dailyPublicationEligibility([changed], window).excluded[0].reason, 'unverified_update');
  assert.equal(dailyPublicationEligibility([{ ...late, acquisition_window: null }], window, [{ window: { lower: 0, upper }, items: [late] }]).eligible.length, 0);
});

test('old material cannot consume candidate slots and insufficient evidence cannot reach the model', () => {
  const recent = entry('recent', lower + 1000), old = entry('old', lower - 90 * 86400000, { source_weight: 100 });
  const weak = entry('headline-only', lower + 2000, { evidence_status: 'insufficient' });
  const qualified = dailyPublicationEligibility([old, recent, weak], window);
  assert.deepEqual(prepareCandidates(qualified.eligible, window, [], 1).candidates.map(x => x.id), [recent.id]);
  assert.equal(qualified.excluded.find(x => x.id === weak.id).reason, 'insufficient_evidence');
});

test('live pipeline retains stale raw and sends only current evidence to editor', async t => {
  const root = await sandbox(t);
  await fs.writeFile(path.join(root, 'config/sources.json'), JSON.stringify({ sources: [{ id: 'a' }] }));
  await fs.writeFile(path.join(root, 'state/collection-checkpoint.json'), JSON.stringify({ source_upper: { a: lower }, initialized_sources: ['a'] }));
  const old = entry('stale', lower - 168 * 86400000), recent = entry('recent', lower + 1000);
  const collector = { cache: {}, collect: async () => [{ items: [old, recent], health }], enrich: async items => items };
  const env = { PUBLISH_NOW: '2026-10-30T00:30:00Z', NEWS_DATA_DIR: path.join(root, 'data'), NEWS_STATE_DIR: path.join(root, 'state') };
  const output = await runPipeline('daily', { root, env, collector, client: fakeClient() });
  assert.deepEqual(output.items.map(x => x.id), [recent.id]);
  assert.equal(output._diagnostics.publication_exclusions.find(x => x.id === old.id).reason, 'outside_publication_window');
  const raw = JSON.parse(await fs.readFile(path.join(root, 'state/snapshots/2026-10-30.json')));
  assert.ok(raw.items.some(x => x.id === old.id));
  assert.deepEqual(output.window.lower, lower);
});

test('a daily writer failure can resume its qualified backlog on the next workday', async t => {
  const root = await sandbox(t);
  await fs.writeFile(path.join(root, 'config/sources.json'), JSON.stringify({ sources: [{ id: 'a' }] }));
  await fs.writeFile(path.join(root, 'state/collection-checkpoint.json'), JSON.stringify({ source_upper: { a: lower }, initialized_sources: ['a'] }));
  const recent = entry('saved-friday', lower + 1000), old = entry('stale', lower - 168 * 86400000);
  const collector = { cache: {}, collect: async () => [{ items: [recent, old], health }], enrich: async items => items };
  const env = { PUBLISH_NOW: '2026-10-30T00:30:00Z', NEWS_DATA_DIR: path.join(root, 'data'), NEWS_STATE_DIR: path.join(root, 'state') };
  await assert.rejects(runPipeline('daily', { root, env, collector, client: fakeClient({ failWriter: true }) }), /Writer failed/);
  const output = await runPipeline('daily', { root, env: { ...env, PUBLISH_NOW: '2026-11-02T00:30:00Z' }, collector: { ...collector, collect: async () => [] }, client: fakeClient() });
  assert.deepEqual(output.items.map(x => x.id), [recent.id]);
  assert.ok(output.items[0].late_discovery);
  assert.equal(output._diagnostics.publication_exclusions.find(x => x.id === old.id).reason, 'outside_publication_window');
});

test('legacy checkpoint resumes only backlog attested by a raw dated snapshot', async t => {
  const root = await sandbox(t), old = entry('legacy-valid', lower - 3600000), stale = entry('legacy-stale', lower - 168 * 86400000);
  await fs.writeFile(path.join(root, 'config/sources.json'), JSON.stringify({ sources: [{ id: 'a' }] }));
  const capture = { provenance: 'live', window: { lower: lower - 86400000, upper: lower }, items: [old, stale], source_health: [] };
  await fs.mkdir(path.join(root, 'state/snapshots'));
  await fs.writeFile(path.join(root, 'state/snapshots/2026-10-29.json'), JSON.stringify(capture));
  await fs.writeFile(path.join(root, 'state/collection-checkpoint.json'), JSON.stringify({ daily_upper: lower, pending: { ...capture, cutoff_upper: lower, window: { lower: stale.published_at, upper: lower } } }));
  const env = { PUBLISH_NOW: '2026-10-30T00:30:00Z', NEWS_DATA_DIR: path.join(root, 'data'), NEWS_STATE_DIR: path.join(root, 'state') };
  const collector = { cache: {}, collect: async () => [], enrich: async items => items };
  const output = await runPipeline('daily', { root, env, collector, client: fakeClient() });
  assert.deepEqual(output.items.map(x => x.id), [old.id]);
  assert.deepEqual(output.items[0].acquisition_window, capture.window);
});

const source = evidence => ({ ...sample('date', Date.parse('2026-10-29T12:00:00Z')), title: 'Housing market update', description: evidence });
const writing = (it, text) => ({ items: [{ id: it.id, title_zh: '住宅市场更新', summary_zh: text, impact: 'neutral', evidence_quote: it.description }], executive_summary: { sentences: [{ text, item_ids: [it.id] }] } });

test('English abbreviated calendar months translate to Chinese date months', () => {
  const aliases = ['Jan.', 'Feb', 'Mar.', 'Apr', 'May', 'Jun.', 'Jul', 'Aug.', 'Sep', 'Sept.', 'Oct.', 'Nov.', 'Dec'];
  for (const alias of aliases) {
    const month = alias.startsWith('Sept') ? 9 : aliases.indexOf(alias) < 9 ? aliases.indexOf(alias) + 1 : aliases.indexOf(alias);
    for (const date of [`${alias} 24, 2026`, `24 ${alias} 2026`, `${alias} 2026`]) {
      const it = source(`The housing update for ${date} reports inventory rose 8.0%, with continued constraints on affordability.`);
      assert.equal(validateWriting(writing(it, `2026 年 ${month} 月住宅在售库存增长 8.0%。`), [it]).items.length, 1, date);
    }
  }
});

test('translated calendar months do not license unrelated numeric claims', () => {
  const it = source('The Oct. 24, 2026 housing update reports inventory rose 8.0%, with affordability remaining constrained.');
  assert.throws(() => validateWriting(writing(it, '10 月在售库存增长 10%。'), [it]), /number absent.*10/);
  assert.throws(() => validateWriting(writing(it, '11 月在售库存增长 8.0%。'), [it]), /number absent.*11/);
  const modal = source('Housing sales may weaken as affordability remains constrained and inventory rises across the country.');
  assert.throws(() => validateWriting(writing(modal, '5 月住宅销售可能转弱。'), [modal]), /number absent.*5/);
  const september = source('PCE Inflation Accelerated in September. The PCE Price Index increased 3.6% in September from a year ago.');
  assert.equal(validateWriting(writing(september, '9 月 PCE 价格指数同比上涨 3.6%。'), [september]).items.length, 1);
  assert.throws(() => validateWriting(writing(september, '9 月 PCE 价格指数同比上涨 9%。'), [september]), /number absent.*9/);
  for (const evidence of ['March Capital acquired residential properties across several national markets.', 'The acquisition of May Capital includes residential properties across several national markets.']) {
    const company = source(evidence), month = evidence.includes('March') ? 3 : 5;
    assert.throws(() => validateWriting(writing(company, `${month} 月，公司收购住宅资产。`), [company]), /number absent/);
  }
});

test('a translated month does not interfere with a grounded negative percentage', () => {
  const it = source('Housing sales changed -5% in May, while affordability remained a constraint.');
  assert.equal(validateWriting(writing(it, '5 月，住宅销售下降 5%。'), [it]).items.length, 1);
  assert.throws(() => validateWriting(writing(it, '5 月，住宅销售增长 5%。'), [it]), /number absent/);
});

test('writer still rejects a calculated difference absent from source evidence', () => {
  const it = source('As of October 29, 2026 the 30-year mortgage rate averaged 7.24%, down from 7.32% last week.');
  assert.throws(() => validateWriting(writing(it, '10 月 29 日，30 年期按揭利率下降 8 个基点至 7.24%。'), [it]), /number absent.*8/);
  assert.equal(validateWriting(writing(it, '10 月 29 日，30 年期按揭利率从 7.32% 降至 7.24%。'), [it]).items.length, 1);
});
