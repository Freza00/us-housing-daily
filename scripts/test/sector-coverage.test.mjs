import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { editorialCoverage, coverageDates } from '../lib/editorial-coverage.mjs';
import { runPipeline } from '../lib/pipeline.mjs';
import { sandbox, sample, replayEnv, fakeClient } from './helpers.mjs';

const tagConfig = { dimensions: { asset: { tags: [{ id: 'industrial', label_zh: '工业' }, { id: 'btr-sfr', label_zh: 'BTR / SFR' }, { id: 'self-storage', label_zh: '自存储' }] } } };
const base = () => ({ candidates: [], decisions: [], selected: [], health: [], sources: [{ id: 'invh', name: 'INVH', required_for_section: 'btr' }], tagConfig, date: '2026-10-29' });

test('empty BTR distinguishes missing source checks from editorial exclusion', () => {
  const input = base();
  assert.equal(editorialCoverage(input).sections.btr.status, 'source_gap');
  input.health = [{ id: 'invh', status: 'ok' }];
  const item = { id: 'btr', title: 'Invitation Homes quarterly results', source_tags: ['btr-sfr'] };
  input.candidates = [item]; input.decisions = [{ id: item.id, keep: true, importance: 2, section: 'btr', tags: ['btr-sfr'] }];
  assert.equal(editorialCoverage(input).sections.btr.status, 'no_qualified');
  input.decisions[0].importance = 3;
  assert.equal(editorialCoverage(input).sections.btr.status, 'not_selected');
});

test('unreadable recent reports and wholly undated sources cannot appear healthy', () => {
  const input = base();
  for (const failure of [{ unreadable_recent: 1 }, { articles: 2, undated: 2 }]) {
    input.health = [{ id: 'invh', status: 'ok', ...failure }];
    assert.equal(editorialCoverage(input).sections.btr.status, 'source_gap');
  }
});

test('rolling coverage uses five actual weekday dates and exposes missing history', () => {
  assert.deepEqual(coverageDates('2026-10-29'), ['2026-10-29', '2026-10-28', '2026-10-27', '2026-10-26', '2026-10-23']);
  const input = base(); input.selected = [{ tags: ['industrial'] }];
  input.history = [{ date: '2026-10-28', items: [{ tags: ['industrial'] }] }, { date: '2026-10-22', items: [{ tags: ['industrial'] }] }];
  const result = editorialCoverage(input);
  assert.equal(result.assets.find(item => item.id === 'industrial').recent_selected, 2);
  assert.equal(result.assets.find(item => item.id === 'industrial').last_selected_date, '2026-10-29');
  assert.deepEqual(result.history.missing_dates, ['2026-10-27', '2026-10-26', '2026-10-23']);
  assert.ok(result.assets.some(item => item.id === 'self-storage' && item.selected === 0));
});

test('mixed-asset is a valid coverage bucket rather than an unknown assignment', () => {
  const input = base();
  input.tagConfig = { dimensions: { asset: { tags: [...tagConfig.dimensions.asset.tags, { id: 'mixed-asset', label_zh: '跨资产' }] } } };
  input.selected = [{ tags: ['mixed-asset'] }];
  const result = editorialCoverage(input);
  assert.equal(result.assets.find(item => item.id === 'mixed-asset').selected, 1);
  assert.equal(result.unclassified_selected, 0);
});

test('unknown asset assignments remain explicit instead of inventing a sector', () => {
  const input = base(); input.selected = [{ tags: ['rates', 'data'] }];
  assert.equal(editorialCoverage(input).unclassified_selected, 1);
});

test('the pipeline publishes source gaps and sector history without extra model calls', async t => {
  const root = await sandbox(t);
  await fs.writeFile(path.join(root, 'config/sources.json'), JSON.stringify({ sources: base().sources }));
  const env = await replayEnv(root, { items: [sample('housing', Date.parse('2026-10-28T15:00:00Z'))], source_health: [{ id: 'invh', status: 'error' }] }, '2026-10-29T01:00:00Z');
  const client = fakeClient();
  const result = await runPipeline('daily', { root, env, client });
  assert.equal(result._diagnostics.editorial_coverage.sections.btr.status, 'source_gap');
  assert.equal(client.usage.length, 2);
  assert.equal(result._diagnostics.editorial_coverage.history.missing_dates.length, 4);
});
