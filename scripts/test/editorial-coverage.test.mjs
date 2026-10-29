import test from 'node:test';
import assert from 'node:assert/strict';
import { detectCreSubcategory } from '../lib/news-core.mjs';
import { selectItems, candidatePrompt } from '../lib/editorial.mjs';

function choose(rows, options) {
  const items = rows.map((row, index) => ({ id: `item-${index}`, title: `Story ${index}`, source_family: row.family || `publisher-${index}`,
    score: row.score ?? 10, is_research: !!row.research, required_source: !!row.required }));
  const decisions = rows.map((row, index) => ({ id: items[index].id, keep: row.keep ?? true, importance: row.importance ?? 3,
    section: row.section, tags: row.tags || [], duplicate_of: row.duplicate_of ?? null, reason: 'Fixture evidence' }));
  return selectItems(items, decisions, options);
}

test('editor evidence includes actual redevelopment uses after a long opening paragraph', () => {
  const description = 'The former hotel site is being cleared. '.repeat(15) + 'The developer plans multifamily housing and retail on the site.';
  const input = JSON.parse(candidatePrompt([{ id: 'redevelopment', title: 'Hotel redevelopment project', description, published_at: Date.parse('2026-10-28T18:00:00Z') }]));
  assert.match(input[0].evidence, /multifamily housing and retail/);
  assert.ok(input[0].evidence.length <= 1000);
});

test('CRE uses the selected asset tag when the headline omits the asset', () => {
  assert.equal(detectCreSubcategory({ title: "KKR's Latest Innovations", tags: ['life-sciences', 'deals'] }), '生命科学');
  assert.equal(detectCreSubcategory({ title: 'Essex raises its guidance', tags: ['multifamily', 'earnings'] }), '多户');
  assert.equal(detectCreSubcategory({ title: 'Aging boomers fuel investor demand', tags: ['senior-housing', 'institutional'] }), '老年住房');
  assert.equal(detectCreSubcategory({ title: 'Capital flows across property types', tags: ['mixed-asset'] }), '跨资产');
});

test('CRE asset classification does not inherit unrelated publisher metadata', () => {
  assert.equal(detectCreSubcategory({ title: 'Capital costs remain high', source_tags: ['multifamily'], tags: ['rates', 'macro'] }), null);
  assert.equal(detectCreSubcategory({ title: 'JLL reports quarterly results', tags: ['earnings', 'brokerage'] }), null);
});

test('CRE retains legacy title fallback and tolerates missing or invalid tags', () => {
  assert.equal(detectCreSubcategory({ title: 'New office lease signed' }), '办公');
  assert.equal(detectCreSubcategory({ title: 'A logistics warehouse opens', tags: null }), '仓储 / 物流');
  assert.equal(detectCreSubcategory({ title: 'Hotel acquisition closes', tags: 'multifamily' }), '酒店');
  assert.equal(detectCreSubcategory({ tags: [] }), null);
});

test('CRE trusts the selected asset instead of unrelated words in a company headline', () => {
  assert.equal(detectCreSubcategory({ title: 'Office owner enters life sciences', tags: ['life-sciences'] }), '生命科学');
});

test('a covered asset does not permanently outrank unclassified original research', () => {
  const result = choose([
    { section: 'cre', score: 100, tags: ['industrial'] },
    { section: 'cre', score: 90, tags: ['industrial'] },
    { section: 'cre', score: 50, research: true, tags: ['data'] },
  ], { limit: 2 });
  assert.equal(result.items[0].id, 'item-0');
  assert.equal(result.items[1].id, 'item-2');
});

test('high-volume national coverage cannot fill the issue before other equal-importance sections', () => {
  const rows = [
    ...Array.from({ length: 20 }, () => ({ section: 'national', score: 100, tags: ['housing'] })),
    ...['sunbelt', 'cre', 'institutional'].flatMap(section => Array.from({ length: 5 }, () => ({ section, score: 10 }))),
  ];
  const result = choose(rows, { limit: 10 });
  for (const section of ['national', 'sunbelt', 'cre', 'institutional']) {
    assert.ok(result.items.filter(item => item.section === section).length >= 2, section);
  }
  assert.equal(result.items.filter(item => item.section === 'btr').length, 0);
});

test('section balance never outranks a more important qualified story', () => {
  const result = choose([
    { section: 'national', importance: 5, score: 1 },
    { section: 'cre', importance: 4, research: true, score: 100, tags: ['industrial'] },
  ], { limit: 1 });
  assert.equal(result.items[0].id, 'item-0');
});

test('equal-importance CRE selection prioritizes uncovered assets over unclassified commentary', () => {
  const result = choose([
    { section: 'cre', score: 100, tags: ['macro', 'rates'] },
    { section: 'cre', score: 90, tags: ['earnings'] },
    { section: 'cre', score: 15, tags: ['industrial'] },
    { section: 'cre', score: 15, tags: ['hotel'] },
  ], { limit: 2 });
  assert.deepEqual(new Set(result.items.map(item => item.tags[0])), new Set(['industrial', 'hotel']));
});

test('publisher caps terminate selection without losing another qualified publisher', () => {
  const result = choose([
    ...Array.from({ length: 12 }, () => ({ section: 'national', family: 'busy-publisher', score: 100 })),
    { section: 'cre', family: 'other-publisher', score: 1 },
  ], { limit: 20, sourceCap: 3 });
  assert.equal(result.items.length, 4);
  assert.equal(result.source_counts['busy-publisher'], 3);
  assert.equal(result.source_counts['other-publisher'], 1);
});

test('balance does not revive rejected, duplicate or low-importance BTR material', () => {
  const result = choose([
    { section: 'national', importance: 3 },
    { section: 'btr', importance: 2 },
    { section: 'btr', keep: false },
    { section: 'cre', duplicate_of: 'item-0' },
  ], { limit: 20 });
  assert.deepEqual(result.items.map(item => item.id), ['item-0']);
});

test('required major original research retains only one explicit publisher-cap exception', () => {
  const result = choose([
    ...Array.from({ length: 6 }, () => ({ section: 'national', family: 'required-publisher', research: true, required: true, importance: 5 })),
    { section: 'cre', family: 'other-publisher' },
  ], { limit: 20, sourceCap: 3 });
  assert.equal(result.source_counts['required-publisher'], 4);
  assert.equal(result.source_counts['other-publisher'], 1);
  assert.equal(result.exceptions.length, 1);
});
