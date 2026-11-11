import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writingEvidenceOptions, prepareWritingCard, validateWritingCard, prepareWriting, writingPrompt, writingSystem, prepareModelDecisions, validateDecisions, createDecisionRepair, createWritingRepair, editorInstructions, candidatePrompt } from '../lib/editorial.mjs';
import { createLlmClient, LlmError } from '../lib/llm-client.mjs';
import { runPipeline } from '../lib/pipeline.mjs';
import { digest } from '../lib/issue-contract.mjs';
import { sandbox, sample, replayEnv, modelDecision, modelEvidence } from './helpers.mjs';
const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/2026-11-10-writing-boundary.json', import.meta.url)));
const tags = JSON.parse(await fs.readFile(new URL('../../config/tags.json', import.meta.url)));
const response = value => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
const metadata = ids => ({ executive_summary: { sentences: [{ text: '住房市场仍存在约束。', text_en: 'Housing markets remain constrained.', item_ids: ids }] }, themes: [] });
const modelCard = it => ({ id: it.id, title_zh: '住宅市场研究', summary_zh: '住房市场仍存在约束。', impact: 'neutral', ...modelEvidence({ ...it, evidence_options: writingEvidenceOptions(it) }) });
const context = { requireEvidenceIds: true, requireEnglish: true };

test('the two actual November 10 outputs still fail the unchanged quote and number gates', () => {
  for (let i = 0; i < fixture.sources.length; i++) assert.throws(() => validateWritingCard(fixture.failed_cards[i], fixture.sources[i]), i ? /number absent/ : /Evidence quote/);
  for (const count of ['146.9 万', '约 146.9 万']) assert.throws(() => validateWritingCard({ ...fixture.failed_cards[1], title_zh: '会员 ' + count, summary_zh: '会员数量保持韧性。' }, fixture.sources[1]), /number absent/);
  for (const count of ['1,469,127', '146.9127 万']) assert.doesNotThrow(() => validateWritingCard({ ...fixture.failed_cards[1], title_zh: '会员 ' + count, summary_zh: '会员数量保持韧性。' }, fixture.sources[1]));
});

test('evidence options are literal per-item spans, never joined sentences or another item', () => {
  for (const it of fixture.sources) {
    const options = writingEvidenceOptions(it);
    for (const option of options) {
      assert(option.id.startsWith(it.id + ':'));
      assert(it.title.includes(option.text) || it.description.includes(option.text));
    }
    const body = options.find(row => row.id.includes(':body-'));
    const card = { ...modelCard(it), evidence_id: body.id };
    const result = prepareWritingCard(card, it, context);
    assert.equal(result.evidence_quote, body.text); assert.equal(result.evidence_id, undefined);
    assert.throws(() => prepareWritingCard({ ...card, evidence_id: 'missing' }, it, context), /Invalid evidence_id/);
    assert.throws(() => prepareWritingCard({ ...card, evidence_id: 'another:' + body.id }, it, context), /Invalid evidence_id/);
    assert.throws(() => prepareWritingCard({ ...card, evidence_quote: body.text }, it, context), /Invalid evidence_id/);
    const legacy = { ...card, evidence_quote: body.text }; delete legacy.evidence_id;
    assert.throws(() => prepareWritingCard(legacy, it, context), /Invalid evidence_id/);
    assert.throws(() => prepareWritingCard({ ...legacy, cacheHit: true, canonicalIds: [it.id] }, it, context), /Invalid evidence_id/);
    const wrongField = { ...card, summary: card.summary_zh }; delete wrongField.summary_zh;
    assert.throws(() => prepareWritingCard(wrongField, it, context), /required summary_zh/);
    assert.equal(prepareWritingCard(legacy, it, { ...context, cacheHit: true }).evidence_quote, body.text);
  }
  const [source] = fixture.sources;
  assert(!writingEvidenceOptions(source).some(row => row.text === fixture.failed_cards[0].evidence_quote));
  assert.throws(() => prepareWritingCard({ ...modelCard(source), evidence_id: writingEvidenceOptions(fixture.sources[1])[0].id }, source, context), /Invalid evidence_id/);
  const input = JSON.parse(writingPrompt('daily', fixture.sources));
  assert.equal(input.items[0].evidence, undefined);
  assert.equal(input.items[0].evidence_segments.map(row => row.text).join(''), source.description.slice(0, 1800));
  assert.deepEqual(input.items[0].evidence_options, writingEvidenceOptions(source).map(option => option.id));
  assert(writingEvidenceOptions(source).some(row => row.from === 1 && row.to === 3 && row.text === source.description));
  for (const option of writingEvidenceOptions(source).filter(row => row.from)) {
    assert(option.from >= 1 && option.to >= option.from && option.to - option.from <= 2);
    assert.equal(input.items[0].evidence_segments.slice(option.from - 1, option.to).map(row => row.text).join('').trim(), option.text);
  }
  const short = { ...source, description: 'Short. Housing sales increased 5% in the quarter.' };
  const shortInput = JSON.parse(writingPrompt('daily', [short])).items[0];
  assert.equal(shortInput.evidence_segments.map(row => row.text).join(''), short.description);
  assert(writingEvidenceOptions(short).some(row => row.text === short.description));
  const four = { ...source, description: 'First substantial housing statement. Second substantial housing statement. Third substantial housing statement. Fourth substantial housing statement.' };
  assert.throws(() => prepareWritingCard({ ...modelCard(four), evidence_id: '11:body-1-4' }, four, context), error => /received="11:body-1-4"/.test(error.message) && /covers 4 segments; maximum is 3/.test(error.message) && /11:body-1-3/.test(error.message));
});

test('new editor fields reject free tags, duplicate actors and unknown geography without silent normalization', () => {
  const it = { ...sample('1', 1), description: 'Sunny Isles Beach, Miami is seeing more apartment development.' };
  const valid = modelDecision('1', { asset: 'multifamily', geo: 'florida', topics: ['construction'], actor: 'developer', geo_evidence: 'Sunny Isles Beach, Miami' });
  const result = validateDecisions(prepareModelDecisions({ decisions: [valid] }, [it], tags), [it], tags, { scriptRouting: true }).decisions[0];
  assert.deepEqual(result.tags, ['multifamily', 'florida', 'construction', 'developer']);
  for (const key of ['asset', 'geo', 'topics', 'actor']) assert.equal(result[key], undefined);
  for (const extra of [{ actor: ['institutional', 'btr-operator'] }, { geo: 'miami' }, { tags: ['multifamily', 'florida'] }, { topics: ['deals', 'deals'] }, { topics: ['deals', 'rates', 'data'] }, { asset: ['housing'] }, { actor: undefined }]) assert.throws(() => prepareModelDecisions({ decisions: [{ ...valid, ...extra }] }, [it], tags));
  assert.doesNotThrow(() => prepareModelDecisions({ decisions: [{ id: '1', keep: false, duplicate_of: null, reason: 'Not selected' }] }, [it], tags));
});

test('editor second correction changes only the remaining invalid semantic row and preserves all editorial judgments', async () => {
  const items = ['1', '2', '3', '4'].map(id => ({ ...sample(id, 1), description: 'Sunny Isles Beach, Miami apartment development remains active.' }));
  const initial = items.map(it => modelDecision(it.id, { reason: 'Independent original judgment ' + it.id }));
  initial[1].actor = ['institutional', 'btr-operator']; initial[1].asset = 'btr-sfr';
  initial[2].geo = 'miami'; initial[2].geo_evidence = 'Sunny Isles Beach, Miami'; initial[2].importance = 5;
  initial[3] = { id: '4', keep: false, duplicate_of: '1', reason: 'Same event' };
  let complete; const requests = [];
  const validate = (data, state = {}) => {
    if (state.cacheHit) return validateDecisions(data, items, tags, { scriptRouting: true });
    complete = structuredClone(data);
    return validateDecisions(prepareModelDecisions(data, items, tags), items, tags, { scriptRouting: true });
  };
  const client = createLlmClient({ endpoint: 'https://fixture.invalid', apiKey: 'fixture', retryDelays: [0, 0], sleep: async () => {}, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body); const count = requests.length;
    if (count === 1) return response({ decisions: initial });
    const input = JSON.parse(body.messages[1].content);
    assert.deepEqual(input.items.map(it => it.id), count === 2 ? ['2', '3'] : ['3']);
    return response({ decisions: input.items.map(it => ({ id: it.id, asset: it.id === '2' ? 'btr-sfr' : 'housing', geo: count === 2 && it.id === '3' ? 'miami' : 'national', topics: [], actor: it.id === '2' ? 'btr-operator' : null, geo_evidence: null })) });
  } });
  const output = await client.call(editorInstructions(tags), candidatePrompt(items), { label: 'editor', validate, repair: () => createDecisionRepair(complete, items, tags, validate) });
  assert.equal(requests.length, 3);
  for (const [index, row] of output.decisions.entries()) for (const key of ['id', 'keep', 'importance', 'capital_focus', 'duplicate_of', 'reason']) if (Object.hasOwn(initial[index], key)) assert.equal(row[key], initial[index][key]);
  assert.equal(output.decisions[1].section, 'btr'); assert.equal(output.decisions[2].section, 'national');
  const plan = createDecisionRepair({ decisions: initial }, items, tags, validate);
  assert.throws(() => plan.validate({ decisions: [{ id: '2', keep: false }, { id: '3', geo: 'national' }] }), /Invalid editorial repair/);
  assert.throws(() => plan.validate({ decisions: [{ id: '2' }, { id: '2' }] }), /Invalid editorial repair/);
  const badGraph = structuredClone(initial); badGraph[0].duplicate_of = '4';
  assert.equal(createDecisionRepair({ decisions: badGraph }, items, tags, validate), null);
  const legacy = { ...modelDecision('1'), tags: ['housing', 'national'] };
  assert.throws(() => prepareModelDecisions({ decisions: [legacy] }, [items[0]], tags), /not tags/);
  const legacyPlan = createDecisionRepair({ decisions: [legacy] }, [items[0]], tags, validate => prepareModelDecisions(validate, [items[0]], tags));
  assert.deepEqual(legacyPlan.validate({ decisions: [{ id: '1', asset: 'housing', geo: 'national', topics: [], actor: null, geo_evidence: null }] }).decisions[0].tags, ['housing', 'national']);
});

test('writer uses the third request only for the remaining bad card, keeping fifteen good cards and the first repaired card', async t => {
  const root = await sandbox(t), selected = Array.from({ length: 17 }, (_, i) => ({ ...sample(String(i + 1), 1), section: 'national' }));
  selected[10] = fixture.sources[0]; selected[13] = fixture.sources[1];
  const original = selected.map(modelCard); original[10].evidence_id = '11:missing';
  original[13] = { ...modelCard(selected[13]), title_zh: 'NAR 会员数达 146.9 万' };
  const full = { items: original, ...metadata(['1']) }, requests = [], saved = new Map(); let complete;
  const validate = (data, state = {}) => {
    complete = structuredClone(data);
    for (const card of data.items) { try { saved.set(card.id, prepareWritingCard(card, selected.find(it => it.id === card.id), { ...context, ...state })); } catch (error) { if (!(error instanceof LlmError)) throw error; } }
    return prepareWriting(data, selected, 'daily', { ...context, ...state });
  };
  const client = createLlmClient({ endpoint: 'https://fixture.invalid', apiKey: 'fixture', cacheDir: path.join(root, 'cache'), retryDelays: [0, 0], sleep: async () => {}, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    if (requests.length === 1) return response(full);
    const input = JSON.parse(body.messages[1].content);
    assert.equal(saved.size, requests.length === 2 ? 15 : 16);
    assert.deepEqual(input.items.map(it => it.id), requests.length === 2 ? ['11', '14'] : ['14']);
    assert.equal(input.original_evidence, undefined);
    const numeric = input.corrections.find(row => row.id === '14'); assert.match(numeric.error, /title_zh/); assert.match(numeric.error, /1469127/);
    return response({ items: input.items.map(it => ({ ...modelCard(selected.find(row => row.id === it.id)), title_zh: it.id === '14' && requests.length === 2 ? 'NAR 会员数达 146.9 万' : '住宅市场研究' })) });
  } });
  const options = { label: 'writer', validate, repair: () => createWritingRepair(complete, selected, 'daily', validate, context) };
  const result = await client.call(writingSystem, writingPrompt('daily', selected), options);
  assert.equal(requests.length, 3); assert.equal(result.items.length, 17); assert.equal(client.usage.at(-1).repairs, 2);
  for (const card of result.items) assert.equal(card.evidence_id, undefined);
  const good = selected.map((it, i) => ![10, 13].includes(i) && prepareWritingCard(original[i], it, context)).filter(Boolean);
  for (const card of good) assert.deepEqual(result.items.find(it => it.id === card.id), card);
  const cached = await client.call(writingSystem, writingPrompt('daily', selected), options);
  assert.equal(requests.length, 3); assert.equal(client.usage.at(-1).cache_hit, true); assert.deepEqual(cached.items, result.items);
});

test('failed second card repair preserves trimmed metadata and cold resume spends only the final writer slot', async t => {
  const root = await sandbox(t), rows = ['alpha', 'beta', 'gamma'].map(id => sample(id, Date.parse('2026-10-28T14:00:00Z')));
  const env = { ...await replayEnv(root, { items: rows }, '2026-10-29T01:00:00Z'), LLM_ENDPOINT: 'https://fixture.invalid', LLM_API_KEY: 'fixture', PIPELINE_UNTIL: 'ready' };
  let badId, writerCalls = 0; const ids = [], rawCards = [];
  const fetchImpl = async (_url, options) => {
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    if (Array.isArray(input)) return response({ decisions: input.map(it => modelDecision(it.id)) });
    writerCalls++;
    if (writerCalls === 1) {
      ids.push(...input.items.map(it => it.id)); badId = input.items[2].id;
      rawCards.push(...input.items.map(it => ({ ...modelCard({ ...it, description: '' }), ...modelEvidence(it) })));
      const first = structuredClone(rawCards); first[2].summary_zh = '销售增长 99%。';
      return response({ items: first, executive_summary: { sentences: [{ text: '甲'.repeat(150), text_en: 'Housing markets remain constrained.', item_ids: [ids[0]] }, { text: '乙'.repeat(140), text_en: 'Inventory remains a constraint.', item_ids: [ids[1]] }] }, themes: [] });
    }
    assert.deepEqual(input.items.map(it => it.id), [badId]);
    const item = input.items[0], card = { id: item.id, title_zh: '住宅研究', summary_zh: '住房市场仍存在约束。', impact: 'neutral', ...modelEvidence(item) };
    if (writerCalls === 2) card.summary_zh = '销售增长 99%。';
    return response({ items: [card] });
  };
  // The first process stops after two physical writer requests; recovery may use
  // the third request, but must retain the same cumulative manifest ledger.
  await assert.rejects(runPipeline('daily', { root, env, llmOptions: { fetchImpl, retryDelays: [0], sleep: async () => {} } }), /number absent/);
  const dir = path.join(root, 'state/issues/daily/2026-10-29/r1'), read = async name => JSON.parse(await fs.readFile(path.join(dir, name + '.json')));
  const before = await read('metadata'), cards = await read('cards'), manifest = await read('manifest');
  assert.equal(cards.items.length, 2); assert.equal(manifest.attempts.writer.length, 2);
  assert.equal(before.summary_shortening.kept_sentence_count, 1); assert.equal(before.summary_shortening.original_characters, 290);
  await runPipeline('daily', { root, env, llmOptions: { fetchImpl, retryDelays: [0, 0], sleep: async () => {} } });
  const after = await read('metadata'), ready = await read('ready'), finalManifest = await read('manifest');
  assert.deepEqual(after, before); assert.equal(writerCalls, 3); assert.equal(finalManifest.attempts.writer.length, 3); assert.equal(finalManifest.attempts.editor.length, 1);
  for (const card of cards.items) assert.deepEqual(ready.payload.items.find(it => it.id === card.id), card);
  for (const card of ready.payload.items) assert.equal(card.evidence_id, undefined);
  await runPipeline('daily', { root, env, client: { async call() { throw new Error('Ready recovery must not call a model'); } } });
  // Reconstruct the original partial-card resume request while its exact full
  // canonical result is cached. No writer slot or time remains for network work.
  const cachedManifest = await read('manifest'); delete cachedManifest.phases.ready;
  cachedManifest.phases.cards.sha256 = digest(cards); cachedManifest.attempts.writer.at(-1).ms = 660000;
  cachedManifest.budget_unknown = ['writer'];
  await fs.writeFile(path.join(dir, 'cards.json'), JSON.stringify(cards));
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(cachedManifest));
  await runPipeline('daily', { root, env, llmOptions: { fetchImpl() { throw new Error('Canonical repair cache must be read before exhausted or unknown budget'); } } });
  assert.deepEqual((await read('ready')).payload.items, ready.payload.items);
});

test('weekly metadata-only cold repair cache uses full canonical validation even when no model budget remains', async t => {
  const root = await sandbox(t), rows = ['alpha', 'beta'].map(id => sample(id, Date.parse('2026-10-28T14:00:00Z')));
  const env = { ...await replayEnv(root, { items: rows }, '2026-11-02T06:30:00Z'), LLM_ENDPOINT: 'https://fixture.invalid', LLM_API_KEY: 'fixture', PIPELINE_UNTIL: 'ready' };
  let calls = 0, ids;
  const fetchImpl = async (_url, options) => {
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    if (Array.isArray(input)) return response({ decisions: input.map(it => modelDecision(it.id)) });
    calls++;
    if (calls === 1) { ids = input.items.map(it => it.id); return response({ items: input.items.map(it => ({ id: it.id, title_zh: '住宅研究', summary_zh: '销售增长 5%。', impact: 'neutral', ...modelEvidence(it) })), executive_summary: { sentences: [{ text: '销售增长 99%。', text_en: 'Sales rose 99%.', item_ids: ids }] }, themes: [] }); }
    return response(metadata(ids));
  };
  await assert.rejects(runPipeline('weekly', { root, env, llmOptions: { fetchImpl, retryDelays: [] } }), /number absent/);
  const dir = path.join(root, 'state/issues/weekly/2026-10-26/r1'), read = async name => JSON.parse(await fs.readFile(path.join(dir, name + '.json')));
  const originalCards = await read('cards'); assert.equal(originalCards.items.length, 2);
  await runPipeline('weekly', { root, env, llmOptions: { fetchImpl } });
  const ready = await read('ready'), manifest = await read('manifest');
  delete manifest.phases.ready; delete manifest.phases.metadata;
  manifest.attempts.writer.at(-1).ms = 660000; manifest.budget_unknown = ['writer'];
  await fs.writeFile(path.join(dir, 'metadata.json'), 'null'); await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  await runPipeline('weekly', { root, env, llmOptions: { fetchImpl() { throw new Error('Metadata cache must not request a model'); } } });
  const cached = (await read('ready')).payload; assert.deepEqual(cached.items, ready.payload.items); assert.deepEqual(cached.executive_summary, ready.payload.executive_summary); assert.equal(calls, 2);
});
