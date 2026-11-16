import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EDITORIAL_PROTOCOL, SUPPORTED_EDITORIAL_PROTOCOLS, editorEvidenceReferences, freezeEditorEvidence, bindEditorialEvidence, assertEditorialEvidence } from '../lib/editor-evidence.mjs';
import { prepareModelDecisions, validateDecisions, createDecisionRepair, editorInstructions, candidatePrompt } from '../lib/editorial.mjs';
import { validateIssue } from '../lib/issue-contract.mjs';
import { isDailyUSStory } from '../lib/daily-edition.mjs';
import { runPipeline } from '../lib/pipeline.mjs';
import { sample, modelDecision, sandbox, replayEnv } from './helpers.mjs';

const context = { scriptRouting: true, requireMarketScope: true, evidenceRefs: true };
const response = data => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
const validator = items => data => validateDecisions(prepareModelDecisions(data, items, null, context), items, null, context);
const propertyDecision = (id, fields = {}) => modelDecision(id, { primary_event: 'property_transaction_financing', market_role: 'asset_location', geo_evidence: 'Texas', ...fields });

test('recent coverage projects readable fields only; bad edges and semantic conflicts converge within three physical editor requests', async t => {
  const root = await sandbox(t), upper = Date.parse('2026-11-15T21:00:00Z'), historicalId = '1234567890abcdef';
  await fs.writeFile(path.join(root, 'data/2026-11-13.json'), JSON.stringify({ date: '2026-11-13', items: [{ id: historicalId, title: 'Previously covered transaction', published_at: upper - 3 * 86400000, summary_zh: '此前已刊交易。' }] }));
  const rows = [
    sample('duplicate', upper - 1000),
    { ...sample('anchor-3', upper - 1000), title: 'Portfolio acquired across the U.S.', description: 'A portfolio acquisition closed. The transaction includes several properties.' },
    { ...sample('event-32', upper - 1000), description: 'The firm acquired a property in Texas. The purchase expands its portfolio.' },
    { ...sample('hq-52', upper - 1000), title: 'Company plans a new headquarters', description: 'The project was announced. It includes new offices. Planning is underway. Design work continues. The company is moving its headquarters to 101 Crawfords Corner Rd. in Holmdel, NJ. Construction will follow.' },
    sample('unrelated', upper - 1000)
  ];
  const env = { ...await replayEnv(root, { items: rows }, '2026-11-16T01:00:00Z'), PIPELINE_UNTIL: 'editor', LLM_ENDPOINT: 'https://fixture.invalid', LLM_API_KEY: 'fixture' };
  const requests = [], repairIds = [];
  const result = await runPipeline('daily', { root, env, llmOptions: { retryDelays: [0, 0], fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body), input = JSON.parse(body.messages[1].content);
    requests.push(body);
    if (Array.isArray(input)) {
      assert(!body.messages[0].content.includes(historicalId));
      assert.match(body.messages[0].content, /历史已刊条目没有本批编号/);
      const ledger = JSON.parse(body.messages[0].content.slice(body.messages[0].content.lastIndexOf('\n') + 1));
      assert.deepEqual(Object.keys(ledger[0]), ['date', 'title', 'published_at', 'summary_zh']);
      return response({ decisions: input.map(item => {
        const d = modelDecision(item.id, { reason: 'Original judgment ' + item.id });
        if (item.title === rows[0].title) d.duplicate_of = historicalId;
        if (item.title === rows[1].title) Object.assign(d, { primary_event: 'property_transaction_financing', market_role: 'asset_location', geo_evidence: null, market_evidence_id: 'body-2' });
        if (item.title === rows[2].title) Object.assign(d, { primary_event: 'fund_platform_capital', market_role: 'asset_location', geo_evidence: 'Texas' });
        if (item.title === rows[3].title) Object.assign(d, { asset: 'office', primary_event: 'property_development_leasing', market_role: 'headquarters_event', geo_evidence: 'Holmdel', market_evidence_id: 'body-6' });
        return d;
      }) });
    }
    repairIds.push(input.items.map(item => item.id));
    assert.equal(input.items.length, requests.length === 2 ? 4 : 2);
    const decisions = input.items.map(item => {
      const correction = input.corrections.find(row => row.id === item.id);
      if (item.title === rows[0].title) {
        assert.match(correction.error, /Invalid duplicate reference/);
        assert(correction.allowed_fields.includes('keep'));
        return { id: item.id, keep: false, duplicate_of: null, reason: '历史同一事件，无新增事实。' };
      }
      assert(!correction.allowed_fields.includes('keep'));
      if (item.title === rows[1].title) {
        assert(correction.related_fields.includes('market_evidence_id'));
        if (requests.length === 2) assert.match(JSON.stringify(correction.problems), /非空连续短锚/);
        else assert.deepEqual(correction.matching_evidence_ids, ['title']);
        return { id: item.id, geo_evidence: 'across the U.S.', market_evidence_id: requests.length === 2 ? 'body-2' : 'title' };
      }
      if (item.title === rows[2].title) {
        assert(correction.related_fields.includes('primary_event'));
        assert(correction.related_fields.includes('market_role'));
        return { id: item.id, primary_event: 'property_transaction_financing', market_role: requests.length === 2 ? 'capital_subject' : 'asset_location' };
      }
      assert.match(item.evidence_refs.find(row => row.id === 'body-5').text, /headquarters.*101 Crawfords Corner Rd\. in Holmdel, NJ\./);
      return { id: item.id, market_evidence_id: 'body-5' };
    });
    return response({ decisions });
  } } });
  assert.equal(requests.length, 3);
  assert(repairIds[1].every(id => repairIds[0].includes(id)));
  const prepared = JSON.parse(await fs.readFile(path.join(result.issue_dir, 'prepared.json')));
  assert.equal(prepared.snapshot.recent_coverage[0].id, historicalId);
  assert.equal(prepared.snapshot.editorial_protocol, 'evidence-refs-v2');
  const editor = JSON.parse(await fs.readFile(path.join(result.issue_dir, 'editor.json')));
  assert.equal(editor.find(d => d.id === 'duplicate').keep, false);
  for (const d of editor.filter(d => d.keep)) {
    assert.equal(d.importance, 4); assert.equal(d.duplicate_of, null);
    assert.match(d.reason, /^Original judgment /);
    assert.equal(d.editorial_protocol, 'evidence-refs-v2');
  }
  const manifest = JSON.parse(await fs.readFile(path.join(result.issue_dir, 'manifest.json')));
  assert.equal(manifest.attempts.editor.length, 3);
  assert.equal(manifest.attempts.writer, undefined);
  assert.equal(manifest.phases.ready, undefined);
});

test('duplicate repairs cannot silently clear unknown links, reject semantic failures or alter unrelated decisions', () => {
  const items = ['1', '2', '3'].map(id => freezeEditorEvidence(sample(id, 1))), validate = validator(items);
  const original = { decisions: [modelDecision('1', { duplicate_of: '1234567890abcdef', reason: 'Duplicate' }), modelDecision('2', { market_evidence_id: 'invalid', reason: 'Keep original' }), modelDecision('3')] };
  assert.throws(() => prepareModelDecisions(original, items, null, context), /Invalid duplicate reference/);
  assert.throws(() => validateDecisions(original, items, null, context), /Invalid duplicate reference/);
  const plan = createDecisionRepair(original, items, null, validate, context);
  const edge = { id: '1', keep: false, duplicate_of: null, reason: 'Historical duplicate' }, semantic = { id: '2', market_evidence_id: 'body-1' };
  for (const decisions of [
    [{ id: '1', duplicate_of: null }, semantic],
    [{ ...edge, keep: true }, semantic],
    [edge, { ...semantic, keep: false }],
    [edge, { ...semantic, reason: 'Changed judgment' }],
    [{ ...edge, importance: 5 }, semantic],
    [{ ...edge, capital_focus: true }, semantic],
    [edge, { ...semantic, id: '3' }]
  ]) assert.throws(() => plan.validate({ decisions }), /repair|duplicate target/);
  const output = plan.validate({ decisions: [edge, semantic] });
  assert.equal(output.decisions[1].reason, 'Keep original');
  assert.equal(output.decisions[1].keep, true);
  assert.equal(original.decisions[0].duplicate_of, '1234567890abcdef');
});

test('identity errors still disable local repair, while every identifiable duplicate edge is repairable and strictly validated', () => {
  const items = ['1', '2', '3'].map(id => freezeEditorEvidence(sample(id, 1))), validate = validator(items);
  const valid = { decisions: items.map(item => modelDecision(item.id)) };
  for (const data of [{}, { decisions: {} }, { decisions: [] }, { decisions: [null, valid.decisions[1], valid.decisions[2]] }, { decisions: [[], valid.decisions[1], valid.decisions[2]] }, { decisions: [{ ...valid.decisions[0], id: 'unknown' }, ...valid.decisions.slice(1)] }, { decisions: [valid.decisions[1], ...valid.decisions.slice(1)] }, { decisions: [{ ...valid.decisions[0], keep: 'true' }, ...valid.decisions.slice(1)] }]) assert.equal(createDecisionRepair(data, items, null, validate, context), null);
  for (const mutate of [
    data => { data.decisions[0].duplicate_of = '1'; },
    data => { data.decisions[0].duplicate_of = '2'; data.decisions[1].duplicate_of = '3'; },
    data => { data.decisions[0].duplicate_of = '2'; data.decisions[1].keep = false; },
    data => { data.decisions[0].duplicate_of = '1234567890abcdef'; data.decisions[0].keep = false; }
  ]) {
    const data = structuredClone(valid); mutate(data);
    assert.throws(() => validate(data), /Invalid duplicate reference/);
    assert(createDecisionRepair(data, items, null, validate, context));
  }
  // Changing a bad-edge root can invalidate a previously valid inbound edge.
  const graph = structuredClone(valid); graph.decisions[0].duplicate_of = '2'; graph.decisions[1].duplicate_of = '2';
  const plan = createDecisionRepair(graph, items, null, validate, context);
  assert.throws(() => plan.validate({ decisions: [{ id: '1', keep: true, duplicate_of: '2', reason: 'Same event' }, { id: '2', keep: false, duplicate_of: null, reason: 'Reject root' }] }), /Invalid duplicate reference/);
});

test('repair diagnostics collect role and anchor conflicts even when an earlier event reference is invalid', () => {
  const item = freezeEditorEvidence({ ...sample('3', 1), title: 'Portfolio acquired across the U.S.', description: 'The property transaction closed.' });
  const data = { decisions: [propertyDecision('3', { event_evidence_id: 'invalid', market_role: 'capital_subject', geo_evidence: 'across the U.S.' })] };
  const plan = createDecisionRepair(data, [item], null, validator([item]), context), correction = JSON.parse(plan.user).corrections[0];
  assert.match(correction.error, /event_evidence_id/);
  assert.match(correction.error, /Property event requires subject location/);
  assert.match(correction.error, /anchor must occur/);
  assert.deepEqual(correction.matching_evidence_ids, ['title']);
  assert(plan.validate({ decisions: [{ id: '3', event_evidence_id: 'title', market_evidence_id: 'title', market_role: 'asset_location' }] }).decisions[0].keep);
  assert.match(editorInstructions(null, { evidenceRefs: true }), /asset_location.*national.*短锚/);
});

test('v2 protects commercial abbreviations while retaining real sentence boundaries', () => {
  assert.equal(EDITORIAL_PROTOCOL, 'evidence-refs-v2');
  assert.deepEqual([...SUPPORTED_EDITORIAL_PROTOCOLS], ['evidence-refs-v1', 'evidence-refs-v2']);
  for (const sentence of [
    'The company is moving its headquarters to 101 Crawfords Corner Rd. in Holmdel, NJ.',
    'The property is at 101 Main St. in Austin, TX.', 'The property is at 101 Main Ave. in Austin, TX.',
    'The property is at 101 Main Blvd. in Austin, TX.', 'The property is at 101 Main Dr. in Austin, TX.',
    'The firm leased Ste. 100 in the office.', ...['Inc.', 'Corp.', 'Ltd.', 'Co.', 'L.L.C.'].map(suffix => 'Acme ' + suffix + ' announced a transaction.'),
    'The U.S. Department released housing data.', 'The U.S. housing market expanded.', 'The dispute was Smith vs. Jones.', 'The property is No. 12 on the list.', 'The property is in St. Louis.'
  ]) {
    const item = { title: 'Headline', description: sentence + ' The next event is unrelated.' };
    assert.deepEqual(editorEvidenceReferences(item).slice(1).map(row => row.text), [sentence, 'The next event is unrelated.']);
  }
  const description = 'The company is based in Holmdel, NJ. The asset is in the United Kingdom.';
  const item = freezeEditorEvidence({ ...sample('foreign', 1), title: 'Foreign acquisition', description });
  assert.equal(editorEvidenceReferences(item).length, 3);
  for (const market_evidence_id of ['body-1-2', 'title-body-1']) assert.throws(() => bindEditorialEvidence(item, propertyDecision(item.id, { market_evidence_id, geo_evidence: 'Holmdel' })), /market_evidence_id/);
  assert.throws(() => bindEditorialEvidence(item, propertyDecision(item.id, { geo_evidence: 'Holmdel' })), /Headquarters background/);
  const addressBackground = freezeEditorEvidence({ ...item, description: 'The investor is headquartered at 101 Crawfords Corner Rd. in Holmdel, NJ. It acquired a London asset.' });
  assert.throws(() => bindEditorialEvidence(addressBackground, propertyDecision(item.id, { geo_evidence: 'Holmdel' })), /Headquarters background/);
  assert.throws(() => bindEditorialEvidence(item, propertyDecision(item.id, { market_evidence_id: 'body-2', geo_evidence: 'United Kingdom' })), /contradicts/);
});

test('v1 frozen references retain original splitting and binding; v2 keeps the headquarters address in body-5', () => {
  const description = 'First sentence. Second sentence. Third sentence. Fourth sentence. The company is moving its headquarters to 101 Crawfords Corner Rd. in Holmdel, NJ.';
  const base = { ...sample('52', 1), title: 'New headquarters', description };
  const legacy = { ...base, editorial_protocol: 'evidence-refs-v1' };
  legacy.editor_evidence = [{ id: 'title', text: base.title }, ...description.split(/(?<=[.!?])\s+/).map((text, i) => ({ id: 'body-' + (i + 1), text }))];
  assert.deepEqual(editorEvidenceReferences(legacy), legacy.editor_evidence);
  const fields = { asset: 'office', primary_event: 'property_development_leasing', market_role: 'headquarters_event', geo_evidence: 'Holmdel', market_evidence_id: 'body-5' };
  assert.throws(() => bindEditorialEvidence(legacy, modelDecision('52', fields)), /anchor must occur/);
  const oldBound = bindEditorialEvidence(legacy, modelDecision('52', { ...fields, geo_evidence: 'headquarters' }));
  assert.equal(oldBound.editorial_protocol, 'evidence-refs-v1');
  assertEditorialEvidence(legacy, oldBound);
  assert.equal(JSON.parse(candidatePrompt([legacy], context))[0].editorial_protocol, 'evidence-refs-v1');
  // Old prepared candidates had no per-item protocol; their snapshot supplies it.
  const { editorial_protocol, ...unmarked } = legacy;
  const legacyContext = { ...context, editorialProtocol: editorial_protocol };
  assert.deepEqual(JSON.parse(candidatePrompt([unmarked], legacyContext))[0].evidence_refs, legacy.editor_evidence.slice(1));
  const oldModel = modelDecision('52', { ...fields, geo_evidence: 'headquarters' });
  const oldPrepared = prepareModelDecisions({ decisions: [oldModel] }, [unmarked], null, legacyContext);
  validateDecisions(oldPrepared, [unmarked], null, legacyContext);
  const legacyRepair = createDecisionRepair({ decisions: [{ ...oldModel, market_evidence_id: 'invalid' }] }, [unmarked], null,
    data => validateDecisions(prepareModelDecisions(data, [unmarked], null, legacyContext), [unmarked], null, legacyContext), legacyContext);
  assert.equal(legacyRepair.validate({ decisions: [{ id: '52', market_evidence_id: 'body-5' }] }).decisions[0].editorial_protocol, 'evidence-refs-v1');
  const current = freezeEditorEvidence(base), bound = bindEditorialEvidence(current, modelDecision('52', fields));
  assert.match(bound.market_evidence, /Rd\. in Holmdel, NJ\./);
  assert.equal(isDailyUSStory(current, bound), true);
  assert.throws(() => assertEditorialEvidence(current, { ...bound, editorial_protocol: 'evidence-refs-v1' }), /binding mismatch/);
  assert.throws(() => isDailyUSStory(current, { ...bound, editorial_protocol: 'unknown' }), /binding mismatch/);
});

test('all checked-in schema-2 daily, weekly and monthly archives retain their original published contract', async () => {
  const data = new URL('../../data/', import.meta.url), archives = [];
  const latest = JSON.parse(await fs.readFile(new URL('latest.json', data)));
  for (const directory of ['', 'weekly/', 'monthly/']) for (const name of await fs.readdir(new URL(directory, data))) {
    if (!/^\d{4}-\d{2}(?:-\d{2})?\.json$/.test(name)) continue;
    const issue = JSON.parse(await fs.readFile(new URL(directory + name, data)));
    // Pre-schema archives never belonged to validateIssue's schema-2 contract.
    if (issue.schema_version !== 2) continue;
    assert.equal(validateIssue(issue), issue, directory + name);
    archives.push(directory + name);
    if (issue.editorial_protocol === 'evidence-refs-v1') for (const card of issue.items) assertEditorialEvidence(card);
  }
  assert(archives.length > 0);
  if (latest.date >= '2026-11-13') {
    assert(archives.includes('2026-11-12.json'));
    assert(archives.includes('2026-11-13.json'));
    assert(archives.some(file => file.startsWith('weekly/')));
    assert(archives.some(file => file.startsWith('monthly/')));
  }
});
