import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { geographyEvidenceMatches, validateDecisions } from '../lib/editorial.mjs';
import { runPipeline } from '../lib/pipeline.mjs';
import { sandbox, sample, fakeClient } from './helpers.mjs';

const tags = JSON.parse(await fs.readFile(new URL('../../config/tags.json', import.meta.url)));
const decision = (evidence, asset = 'housing', geo = 'texas') => ({ id: 'a', keep: true, importance: 4, capital_focus: false, duplicate_of: null, tags: [asset, geo], geo_evidence: evidence });
const validate = (description, evidence, { title = 'Local property report', asset, geo } = {}) => validateDecisions({ decisions: [decision(evidence, asset, geo)] }, [{ ...sample('a', 1), title, description }], tags, { scriptRouting: true }).decisions[0];

test('Nov6 source casing and apostrophe variants retain the exact original evidence spelling', () => {
  const industrial = validate('EL PASO, TEXAS -- The industrial project was completed.', 'El Paso, Texas', { asset: 'industrial' });
  assert.equal(industrial.geo_evidence, 'EL PASO, TEXAS'); assert.equal(industrial.section, 'cre');
  const housing = validate("Learn how California's newly passed Proposition 37 changes down payment obligations.", 'California’s newly passed Proposition 37', { geo: 'california' });
  assert.equal(housing.geo_evidence, "California's newly passed Proposition 37"); assert.equal(housing.section, 'national');
});
test('tabs, line breaks and quote typography may vary without removing source punctuation or words', () => {
  const source = '“Houston’s\t housing\nmarket” is discussed.';
  const result = validate(source, '"Houston\'s housing market"');
  assert.equal(result.geo_evidence, '“Houston’s\t housing\nmarket”');
  assert.deepEqual(result.tags, ['housing', 'houston']);
  const hit = geographyEvidenceMatches('😀 prefix. ' + source, '"Houston\'s housing market"')[0];
  assert.equal(('😀 prefix. ' + source).slice(hit.index, hit.index + hit.text.length), hit.text);
});
test('regex metacharacters in geographic evidence are literal', () => {
  assert.equal(validate('Austin (Texas) market data.', 'Austin (Texas)').geo_evidence, 'Austin (Texas)');
  assert.throws(() => validate('Austin -- Texas market data.', 'Austin (Texas)'), /Missing subject geography evidence/);
  assert.throws(() => validate('AustinXTexas market data.', 'Austin.Texas'), /Missing subject geography evidence/);
  assert.equal(geographyEvidenceMatches('Literal [Texas]+ report.', '[Texas]+')[0].text, '[Texas]+');
});
test('Fort Worth whitespace variants refine to DFW consistently across repeated validation', () => {
  for (const [source, evidence] of [['Fort Worth housing inventory rose.', 'Fort\tWorth'], ['Fort\n Worth housing inventory rose.', 'Fort Worth']]) {
    const result = validate(source, evidence);
    assert.deepEqual(result.tags, ['housing', 'dfw']);
    const item = { ...sample('a', 1), title: 'Local property report', description: source };
    const next = validateDecisions({ decisions: [structuredClone(result)] }, [item], tags, { scriptRouting: true }).decisions[0];
    assert.deepEqual(next, result);
  }
});
test('geographic evidence cannot bridge title and body', () => {
  assert.throws(() => validate('Texas market report.', 'Austin Texas', { title: 'Austin' }), /Missing subject geography evidence/);
});
for (const evidence of ['El Paso Texas', 'El Paso, New Mexico', 'El Paso ... Texas', 'EL PASO, and TEXAS']) test('contiguous evidence rejects ' + evidence, () => {
  assert.throws(() => validate('EL PASO, TEXAS -- A project was completed.', evidence), /Missing subject geography evidence/);
});
test('case and quotation variations cannot escape the enclosing headquarters sentence', () => {
  assert.throws(() => validate('FOA is headquartered in PLANO, TEXAS. Mortgage earnings improved.', 'Plano, Texas'), /Headquarters is not subject geography/);
  assert.throws(() => validate("FOA is based in Plano, Texas. The company's earnings improved.", 'plano, texas'), /Headquarters is not subject geography/);
  assert.throws(() => validate('The company is headquartered in “Plano, Texas”. Earnings improved.', '"plano, texas"'), /Headquarters is not subject geography/);
  for (const space of ['\t', '\n', '\n  ']) assert.throws(() => validate('FOA is based' + space + 'in PLANO, TEXAS. Mortgage earnings improved.', 'Plano, Texas'), /Headquarters is not subject geography/);
});
test('a multi-sentence match checks the first sentence even when headquarters precedes the matched fragment', () => {
  assert.throws(() => validate('FOA is headquartered in Plano, Texas. Mortgage earnings improved.', 'plano, texas. mortgage earnings'), /Headquarters is not subject geography/);
});
test('all matching contexts are checked, including different casing in title and body', () => {
  assert.throws(() => validate('The company is headquartered in PLANO, TEXAS.', 'Plano, Texas', { title: 'Plano, Texas report' }), /Headquarters is not subject geography/);
  assert.equal(validate('The company is headquartered in PLANO, TEXAS and is relocating its office.', 'Plano, Texas', { asset: 'office' }).section, 'cre');
});
test('equivalent source spelling survives editor freezing and cold writer resume without a new editor call', async t => {
  const root = await sandbox(t), now = new Date('2026-11-06T00:30:00Z'), upper = Date.parse('2026-11-05T21:00:00Z'), lower = upper - 86400000;
  await fs.writeFile(path.join(root, 'config/tags.json'), JSON.stringify(tags));
  const rows = ['alpha', 'beta'].map(id => ({ ...sample(id, upper - 1000), description: sample(id, upper - 1000).description + " California's housing market remains constrained." }));
  const env = { PUBLISH_NOW: now.toISOString(), NEWS_DATA_DIR: path.join(root, 'data'), NEWS_STATE_DIR: path.join(root, 'state') };
  const collector = { cache: {}, enrich: async items => items, collect: async () => [{ items: rows, health: { id: 'a', status: 'ok', articles: 2, undated: 0, coverage: { lower, upper } } }] };
  let editorCalls = 0;
  await runPipeline('daily', { root, env: { ...env, PIPELINE_UNTIL: 'editor' }, collector, client: { async call(system, user, options) {
    editorCalls++; assert.equal(options.label, 'editor');
    return options.validate({ decisions: JSON.parse(user).map(it => ({ ...decision('california’s housing market', 'housing', 'california'), id: it.id })) });
  } } });
  const saved = JSON.parse(await fs.readFile(path.join(root, 'state/issues/daily/2026-11-06/r1/editor.json')));
  assert(saved.every(row => row.geo_evidence === "California's housing market"));
  const writer = fakeClient();
  const result = await runPipeline('daily', { root, env, collector: { collect() { throw Error('Unexpected recollection'); } }, client: writer });
  assert.equal(editorCalls, 1); assert.deepEqual(writer.usage.map(row => row.label), ['writer']); assert.equal(result.items.length, 2);
});
