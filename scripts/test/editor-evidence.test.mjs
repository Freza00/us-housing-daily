import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { EDITORIAL_PROTOCOL, freezeEditorEvidence, editorEvidenceReferences, bindEditorialEvidence, assertEditorialEvidence } from '../lib/editor-evidence.mjs';
import { isDailyUSStory } from '../lib/daily-edition.mjs';
import { prepareModelDecisions, validateDecisions, createDecisionRepair, routeSection } from '../lib/editorial.mjs';
import { editorialCoverage } from '../lib/editorial-coverage.mjs';
import { runPipeline } from '../lib/pipeline.mjs';
import { createLlmClient } from '../lib/llm-client.mjs';
import { validateIssue } from '../lib/issue-contract.mjs';
import path from 'node:path';
import { modelDecision, sample, sandbox, replayEnv } from './helpers.mjs';

const fixtures = JSON.parse(await fs.readFile(new URL('./fixtures/editor-evidence-nov12.json', import.meta.url)));
const context = { scriptRouting: true, requireMarketScope: true, evidenceRefs: true };
const raw = item => modelDecision(item.id, { asset: item.tags[0], geo: item.tags[1], topics: [], actor: null,
  primary_event: item.primary_event, geo_evidence: item.geo_evidence, market_role: item.market_role });

for (const fixture of fixtures) test('actual November 12 source evidence binds without rewriting: ' + fixture.id, () => {
  const item = freezeEditorEvidence(fixture), bound = bindEditorialEvidence(item, raw(item));
  assert.equal(bound.market_evidence, editorEvidenceReferences(item).find(row => row.id === 'body-1').text);
  assert.equal(isDailyUSStory(item, bound), true);
  assert.equal(assertEditorialEvidence(item, bound).market_evidence, bound.market_evidence);
  if (fixture.id === '35196e24eed9c445') {
    assert.equal(bound.capital_focus, false);
    assert.equal(routeSection({ ...bound, tags: fixture.tags }), 'cre');
  } else {
    assert.equal(isDailyUSStory(item, { market_scope: 'us', market_evidence: fixture.old_market_evidence }), false);
  }
});

test('all invalid evidence references and duplicate dimensions enter the same editorial repair', () => {
  const items = fixtures.map(freezeEditorEvidence), original = { decisions: items.map(raw) };
  original.decisions.slice(0, 4).forEach(d => { d.market_evidence_id = 'invented'; });
  original.decisions[4].topics = ['deals', 'deals'];
  const validate = data => validateDecisions(prepareModelDecisions(data, items, null, context), items, null, context);
  assert.throws(() => validate(structuredClone(original)), /market_evidence_id/);
  const repair = createDecisionRepair(original, items, null, validate, context);
  assert.deepEqual(JSON.parse(repair.user).corrections.map(d => d.id), items.map(item => item.id));
  const allowed = ['id', 'asset', 'geo', 'topics', 'actor', 'geo_evidence', 'primary_event', 'event_evidence_id', 'market_scope', 'market_evidence_id', 'market_role'];
  const corrected = repair.validate({ decisions: items.map(item => Object.fromEntries(Object.entries(raw(item)).filter(([key]) => allowed.includes(key)))) });
  corrected.decisions.forEach((d, index) => { assert(d.keep); assert.equal(d.importance, original.decisions[index].importance); assert.equal(d.duplicate_of, original.decisions[index].duplicate_of); });
  assert.equal(corrected.decisions[4].capital_focus, false);
});

test('reference protocol has no null US proof bypass and does not use a headquarters background anchor', () => {
  const item = freezeEditorEvidence({ ...sample('foreign', 1), title: 'Apartment portfolio acquired', description: 'The investor is headquartered in Dallas. The property is in the United Kingdom.' });
  const base = { ...modelDecision(item.id), primary_event: 'property_transaction_financing', market_role: 'asset_location', geo_evidence: 'Dallas' };
  assert.throws(() => bindEditorialEvidence(item, { ...base, market_evidence_id: null }), /market_evidence_id/);
  assert.throws(() => bindEditorialEvidence(item, base), /Headquarters background/);
  assert.throws(() => bindEditorialEvidence(item, { ...base, market_evidence_id: 'body-2', geo_evidence: 'United Kingdom' }), /contradicts/);
  const overseas = bindEditorialEvidence(item, { ...base, market_scope: 'non-us', market_evidence_id: 'body-2', geo_evidence: 'United Kingdom' });
  assert.equal(isDailyUSStory(item, overseas), false);
});

test('overseas investor background does not invalidate US subject evidence and Paris Texas is not a city blacklist', () => {
  const item = freezeEditorEvidence({ ...sample('US', 1), title: 'London investor acquires Texas property', description: 'The London-based investor acquires an asset in Paris, Texas.' });
  const decision = bindEditorialEvidence(item, { ...modelDecision(item.id), primary_event: 'property_transaction_financing', market_role: 'asset_location', geo_evidence: 'Paris, Texas' });
  assert.equal(isDailyUSStory(item, decision), true);
});

for (const action of ['plans a new headquarters', 'is moving its headquarters', 'plans a new HQ']) test('headquarters events use typed semantics instead of an action-verb whitelist: ' + action, () => {
  const item = freezeEditorEvidence({ ...sample('HQ', 1), description: 'The company ' + action + ' in Phoenix.' });
  const d = { ...modelDecision(item.id), asset: 'office', primary_event: 'property_development_leasing', market_role: 'headquarters_event', geo_evidence: 'Phoenix' };
  assert.equal(isDailyUSStory(item, bindEditorialEvidence(item, d)), true);
  assert.throws(() => bindEditorialEvidence(item, { ...d, asset: 'industrial' }), /Headquarters event/);
});

test('frozen reference map and bound values are checked on cache or published reuse', () => {
  const item = freezeEditorEvidence(fixtures[0]), decision = bindEditorialEvidence(item, raw(item));
  assert.throws(() => assertEditorialEvidence(item, { ...decision, market_evidence: 'invented' }), /binding mismatch/);
  assert.throws(() => bindEditorialEvidence({ ...item, editor_evidence: [] }, raw(item)), /Frozen editorial evidence mismatch/);
  assert.throws(() => bindEditorialEvidence(item, { ...raw(item), event_evidence_id: 'body-99' }), /event_evidence_id/);
  const long = { ...sample('window', 1), description: 'x'.repeat(1200) + ' This sentence is outside the editor window.' };
  assert(!editorEvidenceReferences(long).some(row => /outside/.test(row.text)));
  assert.equal(decision.editorial_protocol, EDITORIAL_PROTOCOL);
});

test('BTR body-acquisition failure remains visible even when required listing sources were healthy', () => {
  const audit = editorialCoverage({ candidates: [], decisions: [], selected: [], health: [{ id: 'nrhc', status: 'ok', articles: 10, undated: 0 }],
    sources: [{ id: 'nrhc', required_for_section: 'btr' }], date: '2026-11-12',
    candidatePreparation: { sectors: { btr: { available: 2, attempted: 2, accepted: 0, readable: 0, rejected_reasons: { insufficient_evidence: 2 } } } } });
  assert.equal(audit.sections.btr.status, 'evidence_gap');
  assert.equal(audit.sections.btr.evidence_gap, true);
  assert.equal(audit.sections.btr.source_failures.length, 0);
  assert.deepEqual(audit.sections.btr.lead_acquisition, { available: 2, attempted: 2, accepted: 0, readable: 0, rejected_reasons: { insufficient_evidence: 2 } });
});

for (const reason of ['after_cutoff', 'outside_publication_window', 'invalid_date']) test('body and publication-date losses remain distinct: ' + reason, () => {
  const audit = editorialCoverage({ candidates: [], decisions: [], selected: [], health: [], sources: [], date: '2026-11-12',
    candidatePreparation: { sectors: { btr: { available: 1, attempted: 1, accepted: 0, readable: 1, rejected_reasons: { [reason]: 1 } } } } });
  assert.equal(audit.sections.btr.evidence_gap, false);
  assert.equal(audit.sections.btr.qualification_gap, reason === 'invalid_date');
  assert.equal(audit.sections.btr.status, reason === 'invalid_date' ? 'unverified_leads' : 'no_candidates');
});

for (const reason of ['after_cutoff', 'insufficient_evidence']) test('collection freezes actual per-bucket exclusion causes: ' + reason, async t => {
  const root = await sandbox(t), upper = Date.parse('2026-11-11T21:00:00Z'), target = { ...sample('btr-lead', upper - 1000), title: 'Build-to-rent project development update' };
  const collector = { cache: {}, collect: async () => [{ items: [target, sample('valid', upper - 1000)], health: { id: 'a', status: 'ok', articles: 2 } }],
    enrich: async items => items.map(item => item.id === target.id ? reason === 'after_cutoff' ? { ...item, published_at: upper + 1000 } : { ...item, evidence_status: 'insufficient' } : item) };
  const result = await runPipeline('daily', { root, collector, env: { PUBLISH_NOW: '2026-11-12T01:00:00Z', PIPELINE_UNTIL: 'prepared', NEWS_DATA_DIR: path.join(root, 'data'), NEWS_STATE_DIR: path.join(root, 'state') } });
  const prepared = JSON.parse(await fs.readFile(path.join(result.issue_dir, 'prepared.json'))), bucket = prepared.snapshot.candidate_preparation.sectors.btr;
  assert.equal(bucket.attempted, 1); assert.equal(bucket.accepted, 0); assert.equal(bucket.readable, reason === 'after_cutoff' ? 1 : 0);
  assert.deepEqual(bucket.rejected_reasons, { [reason]: 1 });
});

for (const remainingError of [false, true]) test('frozen daily entry repairs the actual five failure rows and preserves decisions across cold stages: ' + remainingError, async t => {
  const root = await sandbox(t), upper = Date.parse('2026-11-11T21:00:00Z');
  const rows = [...fixtures.map(item => ({ ...sample(item.id, item.published_at), ...item })), ...Array.from({ length: 14 }, (_, i) => sample('other-' + i, upper - 1000))];
  const env = { ...await replayEnv(root, { items: rows }, '2026-11-12T01:00:00Z'), PIPELINE_UNTIL: 'prepared' };
  const prepared = await runPipeline('daily', { root, env });
  const requests = [], correctedIds = [];
  const repairFields = new Set(['id', 'asset', 'geo', 'topics', 'actor', 'geo_evidence', 'primary_event', 'event_evidence_id', 'market_scope', 'market_evidence_id', 'market_role']);
  const decisionFor = input => {
    const fixture = fixtures.find(item => item.title === input.title);
    return fixture ? { ...raw(fixture), id: input.id } : modelDecision(input.id);
  };
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body), input = JSON.parse(body.messages[1].content);
    requests.push(body);
    let result;
    if (Array.isArray(input)) result = { decisions: input.map(item => {
      const decision = decisionFor(item), index = fixtures.findIndex(fixture => fixture.title === item.title);
      if (index >= 0 && index < 4) decision.market_evidence_id = 'invented';
      if (index === 4) decision.topics = ['deals', 'deals'];
      return decision;
    }) };
    else if (input.corrections) {
      correctedIds.push(input.items.map(item => item.id));
      result = { decisions: input.items.map((item, index) => {
        const decision = decisionFor(item);
        if (remainingError && correctedIds.length === 1 && index === 0) decision.market_evidence_id = 'still-invalid';
        return Object.fromEntries(Object.entries(decision).filter(([key]) => repairFields.has(key)));
      }) };
    } else result = { items: input.items.map(item => ({ id: item.id, title_zh: '地产市场与项目进展', summary_zh: '报道提供地产市场与项目进展信息。', impact: 'neutral' })),
      executive_summary: { sentences: [{ text: '地产市场与项目进展仍需关注。', text_en: 'Property market and project developments warrant attention.', item_ids: input.items.map(item => item.id) }] }, themes: [] };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
  };
  const llmOptions = { retryDelays: [0, 0], fetchImpl };
  const config = { ...env, LLM_ENDPOINT: 'https://example.com', LLM_API_KEY: 'fixture' };
  await runPipeline('daily', { root, env: { ...config, PIPELINE_UNTIL: 'editor' }, llmOptions });
  assert.equal(correctedIds[0].length, 5);
  if (remainingError) assert.deepEqual(correctedIds[1], [correctedIds[0][0]]);
  const editor = JSON.parse(await fs.readFile(path.join(prepared.issue_dir, 'editor.json')));
  assert(editor.every(d => d.keep && d.importance === 4 && d.duplicate_of == null));
  assert.equal(editor.find(d => d.id === fixtures[4].id).capital_focus, false);
  const editorBytes = await fs.readFile(path.join(prepared.issue_dir, 'editor.json'), 'utf8');
  await runPipeline('daily', { root, env: { ...config, PIPELINE_UNTIL: 'ready' }, llmOptions });
  assert.equal(await fs.readFile(path.join(prepared.issue_dir, 'editor.json'), 'utf8'), editorBytes);
  assert.equal(requests.length, remainingError ? 4 : 3);
  const bundle = JSON.parse(await fs.readFile(path.join(prepared.issue_dir, 'ready.json'))), issue = bundle.payload;
  validateIssue(issue);
  assert.equal(issue.items.length, 19); assert.equal(issue.selection_count, 19); assert.equal(issue.selection_target, 20); assert.equal(issue.selection_shortfall, 1);
  assert.equal(issue.content_target, 19); assert.equal(issue._diagnostics.writing_plan.shortfall, 0);
  assert.equal(issue._diagnostics.editorial_dispositions.filter(row => row.disposition === 'published').length, 19);
  assert(issue._diagnostics.timings.job_started_at <= issue._diagnostics.timings.collection_finished_at);
  const priorCalls = requests.length;
  await runPipeline('daily', { root, env: { ...config, PIPELINE_UNTIL: 'ready' }, llmOptions: { fetchImpl() { throw Error('Unexpected paid retry'); } } });
  assert.equal(requests.length, priorCalls);
  assert.throws(() => validateIssue({ ...issue, selection_shortfall: 0 }), /selection target/);
  for (const mutate of [
    value => { delete value.writing_policy; },
    value => { delete value.editorial_protocol; value.selection_shortfall = 0; },
    value => { delete value.items[0].editorial_protocol; },
    value => { delete value.editorial_schema; },
    value => { value.items[0].market_scope = 'non-us'; }
  ]) {
    const invalid = structuredClone(issue); mutate(invalid);
    assert.throws(() => validateIssue(invalid), /editorial protocol|US scope/);
  }
});

test('exhausting editorial evidence repairs never freezes a false approved batch or spends a fourth editor request', async () => {
  const item = freezeEditorEvidence(fixtures[0]), initial = { decisions: [{ ...raw(item), market_evidence_id: 'invalid' }] }, requests = [];
  let last = initial;
  const validate = data => { last = structuredClone(data); return validateDecisions(prepareModelDecisions(data, [item], null, context), [item], null, context); };
  const client = createLlmClient({ endpoint: 'https://example.com', apiKey: 'fixture', retryDelays: [0, 0], fetchImpl: async (url, options) => {
    requests.push(JSON.parse(options.body));
    const fields = { id: item.id, market_evidence_id: 'invalid' };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(requests.length === 1 ? initial : { decisions: [fields] }) }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
  } });
  await assert.rejects(client.call('fixture', '{}', { label: 'editor', validate, repair: () => createDecisionRepair(last, [item], null, validate, context) }), /market_evidence_id/);
  assert.equal(requests.length, 3);
});
