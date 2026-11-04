import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareCandidates, selectItems, validateDecisions } from '../lib/editorial.mjs';
import { runPipeline } from '../lib/pipeline.mjs';
import { sandbox, sample, fakeClient } from './helpers.mjs';

const now = new Date('2026-11-04T13:00:00Z');
const upper = Date.parse('2026-11-03T21:00:00Z'), lower = upper - 86400000;
const rows = count => Array.from({ length: count }, (_, i) => ({ ...sample('policy-' + i, upper - 1000 * (i + 1)), source_id: 'source', source_family: 'publisher', is_research: false }));

test('publisher diversity has priority and spare candidate capacity admits the fifth article', () => {
  const items = rows(8), rare = { ...sample('rare', upper - 3600000), source_family: 'rare', required_source: true };
  const result = prepareCandidates([...items, rare], { lower, upper }, [], 8);
  assert.equal(result.initial_count, 5);
  assert.equal(result.limit, 8); assert.equal(result.candidates.length, 8);
  assert.equal(result.candidates[0].id, 'rare');
  assert(result.candidates.slice(0, result.initial_count).every(it => it.id === 'rare' || items.slice(0, 4).some(x => x.id === it.id)));
  assert(result.candidates.some(it => it.id === 'policy-4'));
  const decisions = result.candidates.map(it => ({ id: it.id, keep: true, importance: it.id === 'rare' ? 5 : 3, section: 'national', tags: ['housing'], duplicate_of: null }));
  decisions.find(it => it.id === 'policy-0').keep = false;
  decisions.find(it => it.id === 'policy-1').importance = 2;
  const selected = selectItems(result.candidates, decisions);
  assert.equal(selected.items.filter(it => it.source_family === 'publisher').length, 3);
  assert(!selected.items.some(it => ['policy-0', 'policy-1'].includes(it.id)));
});

test('spillover never returns seen, duplicate or out-of-window articles or exceeds capacity', () => {
  const items = rows(8), duplicate = { ...items[4], id: 'duplicate', source_family: 'syndicated' };
  const result = prepareCandidates([...items, duplicate, { ...sample('future', upper), source_family: 'future' }], { lower, upper }, [{ id: 'policy-0' }], 6);
  assert.equal(result.candidates.length, 6);
  assert(!result.candidates.some(it => ['policy-0', 'future'].includes(it.id)));
  assert.equal(result.candidates.filter(it => it.link === items[4].link).length, 1);
  assert.equal(new Set(result.candidates.map(it => it.id)).size, 6);
  assert.equal(prepareCandidates(items, { lower, upper }, [], 0).candidates.length, 0);
});

test('failed hydration uses a bounded attempt budget before one complete frozen editor batch', async t => {
  const root = await sandbox(t), items = rows(80);
  items.push({ ...sample('rare', upper - 3600000), source_id: 'source', source_family: 'rare', required_source: true });
  await fs.writeFile(path.join(root, 'config/sources.json'), JSON.stringify({ sources: [{ id: 'source', required: true }] }));
  const env = { NEWS_DATA_DIR: path.join(root, 'data'), NEWS_STATE_DIR: path.join(root, 'state'), PUBLISH_NOW: now.toISOString(), PIPELINE_UNTIL: 'prepared' };
  const batches = [], collector = { cache: {}, collect: async () => [{ items, health: { id: 'source', status: 'ok', required: true, articles: items.length, undated: 0, coverage: { lower, upper } } }], enrich: async input => {
    batches.push(input.map(it => it.id));
    return input.map(it => ({ ...it, evidence_status: batches.length === 1 ? 'insufficient' : 'article' }));
  } };
  const prepared = await runPipeline('daily', { root, env, now, collector, client: { call() { throw Error('Model before prepared'); } } });
  assert.equal(prepared.stage, 'prepared');
  assert.deepEqual(batches.map(batch => batch.length), [5, 67]);
  const dir = path.join(root, 'state/issues/daily/2026-11-04/r1');
  const frozen = JSON.parse(await fs.readFile(path.join(dir, 'prepared.json')));
  assert.equal(frozen.snapshot.items.length, 67);
  assert.deepEqual(frozen.snapshot.candidate_preparation, { limit: 72, initial_count: 5, attempted: 72, accepted: 67, rejected: 5 });
  assert.equal(new Set(batches.flat()).size, 72);
  assert.equal(frozen.snapshot.publication_exclusions.filter(it => it.reason === 'insufficient_evidence').length, 5);
  const frozenBytes = await fs.readFile(path.join(dir, 'prepared.json'));
  const client = fakeClient(), forbidden = { collect() { throw Error('Recollection'); }, enrich() { throw Error('Post-freeze refill'); } };
  const ready = await runPipeline('daily', { root, now, env: { ...env, PIPELINE_UNTIL: 'ready' }, collector: forbidden, client });
  assert.equal(ready.stage, 'ready'); assert.deepEqual(client.usage.map(row => row.label), ['editor', 'writer']);
  assert(frozenBytes.equals(await fs.readFile(path.join(dir, 'prepared.json'))));
  const bundle = JSON.parse(await fs.readFile(path.join(dir, 'ready.json')));
  assert.equal(bundle.payload.items.length, 3);
});

test('BTR section requires its own asset tag and cannot be filled with multifamily', () => {
  const examples = [
    { ...sample('refinance', upper - 1000), title: 'Walker & Dunlop Arranges Refinancing of Texas Apartment Portfolio' },
    { ...sample('lawsuit', upper - 1000), title: 'RealPage rent-pricing case wraps with settlement to apartment renters' }
  ];
  for (const it of examples) {
    const decision = { id: it.id, keep: true, importance: 3, section: 'btr', tags: ['multifamily'], duplicate_of: null };
    assert.throws(() => validateDecisions({ decisions: [structuredClone(decision)] }, [it]), /BTR.*asset/);
    assert.doesNotThrow(() => validateDecisions({ decisions: [{ ...decision, section: 'sunbelt' }] }, [it]));
    assert.doesNotThrow(() => validateDecisions({ decisions: [{ ...decision, keep: false }] }, [it]));
  }
  const btr = { ...sample('genuine', upper - 1000), title: 'Build-to-rent community opens rental homes' };
  const decision = { id: btr.id, keep: true, importance: 4, section: 'btr', tags: ['btr-sfr'], duplicate_of: null };
  assert.doesNotThrow(() => validateDecisions({ decisions: [decision] }, [btr]));
  assert.throws(() => validateDecisions({ decisions: [{ ...decision, tags: [] }] }, [btr]), /BTR.*asset/);
});

test('all hydration failures stop at 72 attempts without calling editor or publishing', async t => {
  const root = await sandbox(t), items = rows(85), attempts = [];
  await fs.writeFile(path.join(root, 'config/sources.json'), JSON.stringify({ sources: [{ id: 'source', required: true }] }));
  const env = { NEWS_DATA_DIR: path.join(root, 'data'), NEWS_STATE_DIR: path.join(root, 'state'), PUBLISH_NOW: now.toISOString() };
  const collector = { cache: {}, collect: async () => [{ items, health: { id: 'source', status: 'ok', required: true, articles: items.length, undated: 0, coverage: { lower, upper } } }], enrich: async batch => {
    attempts.push(...batch.map(it => it.id)); return batch.map(it => ({ ...it, evidence_status: 'insufficient' }));
  } };
  await assert.rejects(runPipeline('daily', { root, env, now, collector, client: { call() { throw Error('Unexpected model request'); } } }), /No eligible dated candidates/);
  assert.equal(attempts.length, 72); assert.equal(new Set(attempts).size, 72);
  await assert.rejects(fs.access(path.join(root, 'data/latest.json')), { code: 'ENOENT' });
});

test('candidate spillover preserves the single major-research publication exception', () => {
  const items = rows(8).map(it => ({ ...it, is_research: true, required_source: true }));
  const result = prepareCandidates(items, { lower, upper });
  assert.equal(result.initial_count, 5); assert.equal(result.candidates.length, 8);
  const decisions = items.map(it => ({ id: it.id, keep: true, importance: 5, section: 'national', tags: ['housing'], duplicate_of: null }));
  const selected = selectItems(result.candidates, decisions);
  assert.equal(selected.items.length, 4); assert.equal(selected.exceptions.length, 1);
});
