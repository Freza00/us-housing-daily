import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const app = await fs.readFile(new URL('../../public/app.js', import.meta.url), 'utf8');
const between = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));

test('UI taxonomy covers every configured tag and dimension, hiding national explicitly', async () => {
  const tags = JSON.parse(await fs.readFile(new URL('../../config/tags.json', import.meta.url), 'utf8'));
  const ctx = vm.createContext({});
  vm.runInContext(between('const TAG_DEFINITIONS', 'function renderCard('), ctx);
  const definitions = vm.runInContext('TAG_DEFINITIONS', ctx);
  const expected = Object.entries(tags.dimensions).flatMap(([dim, row]) => row.tags.map(tag => [tag.id, dim]));
  assert.deepEqual(Object.keys(definitions).sort(), expected.map(([id]) => id).sort());
  for (const [id, dim] of expected) {
    assert.equal(definitions[id][0], dim, id);
    assert.ok(definitions[id][1].trim(), id);
    assert.ok(definitions[id][2].trim(), id);
    assert.doesNotMatch(definitions[id][2], /\p{Script=Han}/u, id);
  }
  assert.deepEqual(Array.from(ctx.sortTags(expected.map(([id]) => id))).sort(), expected.map(([id]) => id).filter(id => id !== 'national').sort());
  assert.deepEqual(Array.from(ctx.sortTags(['lender', 'fundraising', 'florida', 'housing'])), ['housing', 'florida', 'fundraising', 'lender']);
});

test('Sun Belt count and filtering include every member once and reset only unmatched filters', () => {
  const writes = [];
  const ctx = vm.createContext({ activeTag: 'office', STORAGE_KEY: 'filter', sessionStorage: { setItem: (...args) => writes.push(args) } });
  vm.runInContext(between('const SUNBELT_GEOS', 'function renderTags('), ctx);
  const members = ['sun-belt', 'texas', 'dfw', 'houston', 'austin', 'phoenix', 'florida', 'atlanta', 'carolinas', 'nashville', 'las-vegas'];
  const items = members.map(id => ({ tags: [id, 'multifamily'] }));
  items.push({ tags: ['phoenix', 'texas'] }, { tags: ['national'] }, { tags: ['california'] }, {});
  assert.equal(ctx.filterItems(items, 'sun-belt').length, 12);
  assert.equal(ctx.filterItems(items, '__all'), items);
  ctx.retainMatchingFilter(items);
  assert.equal(ctx.activeTag, '__all');
  assert.deepEqual(writes, [['filter', '__all']]);
  ctx.activeTag = 'multifamily'; ctx.retainMatchingFilter(items);
  assert.equal(ctx.activeTag, 'multifamily'); assert.equal(writes.length, 1);
  ctx.activeTag = 'data-center'; ctx.retainMatchingFilter([]);
  assert.equal(ctx.activeTag, '__all'); assert.equal(writes.length, 2);
});

test('English cards show the full escaped evidence quote and never raw navigation prefixes', () => {
  const ctx = vm.createContext({ currentLang: 'en', articleDate: () => ({ label: '2026-11-05', title: '' }),
    t: () => ({ source_excerpt: 'Source excerpt', excerpt_unavailable: 'Read the original article.', impact: { neutral: 'Neutral' }, importance_title: 'Importance' }),
    renderStars: () => '***', IMPACT_CLS: {}, formatChinese: x => x, creSubcategoryEn: x => x });
  vm.runInContext(between('function escapeHtml(', '// ========== 渲染：tag chip'), ctx);
  vm.runInContext(between('const TAG_DEFINITIONS', 'function renderItems('), ctx);
  const item = { title: 'Original news', link: 'https://example.com', tags: [], description: 'Sign up for our newsletter. National CRE News In Your Inbox.', evidence_quote: 'Quoted evidence <script>alert(1)</script> & the full final sentence.', source_name: 'Source' };
  let html = ctx.renderCard(item, 1);
  assert.match(html, /Source excerpt: Quoted evidence &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; the full final sentence\./);
  assert.doesNotMatch(html, /Sign up|In Your Inbox|<script>/);
  for (const quote of ['', null, '中文内容', 'English mixed 中文']) {
    html = ctx.renderCard({ ...item, evidence_quote: quote }, 1);
    assert.match(html, /Read the original article\./); assert.doesNotMatch(html, /Sign up|In Your Inbox/);
  }
  ctx.currentLang = 'zh'; html = ctx.renderCard({ ...item, summary_zh: '中文摘要。' }, 1);
  assert.match(html, /中文摘要。/); assert.doesNotMatch(html, /Source excerpt/);
});

test('daily issue today follows Beijing midnight while source dates stay in New York', () => {
  const ctx = vm.createContext({ currentLang: 'en' });
  vm.runInContext(between('const pad2', 'function periodWindowText('), ctx);
  for (const [instant, day] of [['2026-11-05T15:59:59Z', '2026-11-05'], ['2026-11-05T16:00:00Z', '2026-11-06'], ['2026-11-05T21:41:00Z', '2026-11-06']]) {
    vm.runInContext(`Date = class extends globalThis.Date { constructor(...args) { super(...(args.length ? args : [${JSON.stringify(instant)}])); } }`, ctx);
    assert.equal(vm.runInContext('todayBeijingKey()', ctx), day);
    assert.equal(ctx.articleDate({ published_at: Date.parse('2026-11-05T21:41:00Z'), date_precision: 'timestamp' }).label, '2026-11-05');
  }
});

test('daily holiday banners preserve priority and recovery information in both languages', () => {
  const ctx = vm.createContext({ currentLang: 'zh', currentMode: 'daily', windowBanner: {}, periodWindowText: () => 'Period window' });
  vm.runInContext(between('const I18N', 'const LANG_STORAGE_KEY'), ctx);
  vm.runInContext(between('function formatBjRecoveryDate(', 'function escapeHtml('), ctx);
  vm.runInContext(between('function renderWindowBanner(', 'function isCurrentLoad('), ctx);
  ctx.t = () => vm.runInContext('I18N[currentLang]', ctx);
  for (const hours of [24, 72]) for (const holidayField of ['today_us_holiday', 'yesterday_us_holiday']) {
    const data = { items: [{ extended_window: true }], _diagnostics: { window_hours: hours, us_holiday: { [holidayField]: 'Labor Day', expected_recovery_bj_date: '2026-09-09' } } };
    for (const lang of ['zh', 'en', 'zh']) {
      ctx.currentLang = lang; ctx.renderWindowBanner(data);
      assert.equal(ctx.windowBanner.hidden, false); assert.match(ctx.windowBanner.textContent, /Labor Day/); assert.match(ctx.windowBanner.textContent, /9\/9/);
      if (lang === 'en') assert.doesNotMatch(ctx.windowBanner.textContent, /\p{Script=Han}/u);
    }
  }
  ctx.renderWindowBanner({ items: [], _diagnostics: { window_hours: 24 } }); assert.equal(ctx.windowBanner.hidden, true);
  ctx.currentMode = 'monthly'; ctx.renderWindowBanner({ items: [] }); assert.equal(ctx.windowBanner.textContent, 'Period window');
});
