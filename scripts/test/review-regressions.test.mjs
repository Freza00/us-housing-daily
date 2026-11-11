import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDailyUSStory } from '../lib/daily-edition.mjs';
import { candidateSector, prepareCandidates, employmentReportKey, repeatedEmploymentReport, assertFreshDailyReports } from '../lib/editorial.mjs';
import { runPipeline } from '../lib/pipeline.mjs';
import { pushCandidate } from '../lib/publication.mjs';
import { sample, sandbox, fakeClient, replayEnv } from './helpers.mjs';

for (const city of ['Phoenix', 'Miami', 'Seattle', 'the US']) test('a literal US asset location works without a city whitelist: ' + city, () => {
  const item = { title: 'London investor acquires apartments', description: 'The investor is based in London. The property is in ' + city + '.' };
  assert.equal(isDailyUSStory(item, { market_scope: 'us', market_evidence: 'The property is in ' + city + '.' }), true);
});

test('market evidence uses the original sentence, including short headquarters quotes', () => {
  const item = { title: 'London apartment portfolio changes hands', description: 'The investor is headquartered in Dallas. The portfolio is located in London.' };
  for (const evidence of ['Dallas', 'in Dallas', 'The investor is headquartered in Dallas.']) {
    assert.equal(isDailyUSStory(item, { market_scope: 'us', market_evidence: evidence }), false);
  }
  assert.equal(isDailyUSStory({ title: 'London fund opens Phoenix headquarters', description: 'New office.' },
    { market_scope: 'us', market_evidence: 'Phoenix' }), true);
  assert.equal(isDailyUSStory({ title: 'London investor buys apartments', description: 'The investor is headquartered in London and acquires a property in Phoenix.' },
    { market_scope: 'us', market_evidence: 'a property in Phoenix' }), true);
  assert.equal(isDailyUSStory({ title: 'London apartment portfolio', description: 'The Dallas-based investor owns a London portfolio.' },
    { market_scope: 'us', market_evidence: 'Dallas' }), false);
  assert.equal(isDailyUSStory({ title: 'London investor buys US apartments', description: 'The property is in Paris, Texas.' },
    { market_scope: 'us', market_evidence: 'The property is in Paris, Texas.' }), true);
  assert.equal(isDailyUSStory({ title: 'London investor buys apartments', description: 'The Phoenix property was bought by a London-based investor.' },
    { market_scope: 'us', market_evidence: 'The Phoenix property' }), true);
  assert.equal(isDailyUSStory({ title: 'UK property portfolio', description: 'The portfolio is located in the United Kingdom.' },
    { market_scope: 'us', market_evidence: 'The portfolio is located in the United Kingdom.' }), false);
});

const assetCases = [
  ['MarketBeat Seattle Multifamily Q3 2026', ['industrial', 'office', 'multifamily'], 'other'],
  ['Power Scarcity Poses Problems For Charlotte Industrial Developers', ['data-center', 'industrial', 'office'], 'cre:industrial'],
  ['3 multifamily groundbreakings you may have missed', ['multifamily', 'office'], 'other'],
  ['Self-storage acquisition closes in Miami', ['office', 'multifamily'], 'cre:self-storage'],
  ['Senior housing research update', ['office'], 'cre:senior-housing'],
  ['Life sciences laboratories report rising demand', ['office'], 'cre:life-sciences'],
  ['Retail-to-residential conversion completes', ['retail'], 'other'],
  ['Office and industrial portfolio changes hands', ['office', 'industrial'], 'other'],
  ['Warehouses in Houston attract buyers', ['office'], 'cre:industrial'],
  ['Brookfield Residential buys 476 acres near company headquarters', ['office', 'institutional'], 'other']
];
for (const [title, tags, expected] of assetCases) test('acquisition identifies the headline subject: ' + title, () => {
  const item = { ...sample('lead', 1), title, tags, description: 'Background industrial, office and retail research appears in the navigation.' };
  assert.equal(candidateSector(item), expected);
});

test('long-body asset terms cannot consume the non-multifamily reserve opportunities', () => {
  const upper = Date.parse('2026-11-10T21:00:00Z'), items = assetCases.slice(0, 6).map(([title, tags], index) =>
    ({ ...sample('asset-' + index, upper - 1000), title, tags, description: 'A research report discusses multifamily housing. Office and industrial links occur in the sidebar. The primary article has a different subject.' }));
  const pool = prepareCandidates(items, { lower: upper - 86400000, upper }, [], 6, { sectorOpportunities: true });
  const priority = pool.candidates.slice(0, 3).map(candidateSector);
  assert.deepEqual(new Set(priority), new Set(['cre:industrial', 'cre:self-storage', 'cre:senior-housing']));
  assert(!pool.candidates.slice(0, 3).some(item => /Seattle|groundbreakings/.test(item.title)));
});

const prior = [{ date: '2026-11-09', id: 'prior', title: 'October 2026 Jobs Report: Employment growth tops market forecasts',
  published_at: Date.parse('2026-11-06T12:30:00Z'), summary_zh: '就业增加 165,000 个，失业率 4.1%。',
  description: 'U.S. employers added 165,000 jobs in October. Unemployment was 4.1%, hourly earnings rose 3.1%, and revisions added 84,000 jobs.' }];
const repeated = { id: 'current', title: 'October Jobs Report: Surging Payrolls and Hiring Uptick',
  published_at: Date.parse('2026-11-10T13:00:00Z'), description: 'Payroll employment increased 165,000 in October and unemployment was 4.1%.',
  title_zh: '10 月就业报告', summary_zh: '就业增加 165,000 个，失业率为 4.1%。' };

test('the same monthly release needs evidenced new data, including in the written card', () => {
  assert.equal(employmentReportKey(repeated), 'employment:2026-10');
  assert(repeatedEmploymentReport(repeated, prior));
  assert(repeatedEmploymentReport({ ...repeated, novelty_evidence: repeated.description }, prior));
  const update = { ...repeated, description: 'Payroll employment was revised to 175,000 jobs.', novelty_evidence: 'Payroll employment was revised to 175,000 jobs.' };
  assert.equal(repeatedEmploymentReport(update, prior), null);
  assert(repeatedEmploymentReport(update, prior, { requireWrittenFact: true }));
  assert.equal(repeatedEmploymentReport({ ...update, summary_zh: '就业人数修订为 175,000 个。' }, prior, { requireWrittenFact: true }), null);
  assert(repeatedEmploymentReport({ ...repeated, novelty_evidence: update.novelty_evidence }, prior));
  assert.throws(() => assertFreshDailyReports({ kind: 'daily', items: [repeated] }, prior), /Repeated employment report/);
});

test('different periods and independent construction research retain separate identities', () => {
  assert.equal(employmentReportKey({ title: 'December Jobs Report', published_at: Date.parse('2026-01-09T13:30:00Z') }), 'employment:2025-12');
  assert.equal(repeatedEmploymentReport({ ...repeated, title: 'September Jobs Report' }, prior), null);
  assert.equal(repeatedEmploymentReport({ ...repeated, title: 'Residential construction employment declines in October' }, prior), null);
  assert.equal(repeatedEmploymentReport({ ...repeated, title: 'October Jobs Report: An independent survey of homebuilders' }, prior), null);
});

test('normal daily entry excludes a covered report before writing and fills the pool with other candidates', async t => {
  const root = await sandbox(t), rows = Array.from({ length: 21 }, (_, index) => sample('fresh-' + index, Date.parse('2026-11-10T12:00:00Z')));
  const covered = { ...sample('covered', Date.parse('2026-11-10T12:00:00Z')), ...repeated,
    description: repeated.description + ' The monthly report describes the nationwide labor market.' };
  await fs.writeFile(path.join(root, 'data/2026-11-09.json'), JSON.stringify({ date: '2026-11-09', items: prior }));
  const env = { ...await replayEnv(root, { items: [...rows, covered] }, '2026-11-11T01:00:00Z'), PIPELINE_UNTIL: 'ready' };
  const client = fakeClient(), original = client.call;
  client.call = (system, user, options) => {
    if (options.label === 'writer') assert(!JSON.parse(user).items.some(item => item.title === covered.title));
    return original(system, user, options);
  };
  const result = await runPipeline('daily', { root, env, client });
  const { payload } = JSON.parse(await fs.readFile(path.join(result.issue_dir, 'ready.json')));
  assert.equal(payload.items.length, 20);
  assert.equal(payload._diagnostics.report_exclusions.length, 1);
  assert.equal(payload._diagnostics.report_exclusions[0].id, covered.id);
});

test('publication entry blocks a manually assembled duplicate before staging or pushing', async t => {
  const root = await sandbox(t), commands = [];
  const card = { ...repeated, section: 'national', tags: ['housing', 'national'], capital_focus: false,
    impact: 'neutral', evidence_quote: repeated.description };
  const payload = { schema_version: 2, editorial_schema: 2, kind: 'daily', date: '2026-11-11', publication_status: 'complete',
    window: { lower: Date.parse('2026-11-09T21:00:00Z'), upper: Date.parse('2026-11-10T21:00:00Z'), date: '2026-11-11' },
    items: [card], themes: [], executive_summary: { sentences: [{ text: '就业增加 165,000 个。', text_en: 'Payroll employment increased 165,000.', item_ids: [card.id] }] } };
  const git = async (_cwd, args) => {
    commands.push(args);
    if (args[0] === 'remote' && args[1] === 'get-url') return 'https://example.test/repository';
    if (args[0] === 'clone') {
      const checkout = args.at(-1);
      await fs.mkdir(path.join(checkout, 'data'), { recursive: true });
      await fs.writeFile(path.join(checkout, 'data/2026-11-09.json'), JSON.stringify({ date: '2026-11-09', items: prior }));
    }
    return '';
  };
  await assert.rejects(pushCandidate({ payload, base: { archive_sha256: null } }, { root, now: new Date('2026-11-11T01:00:00Z'), git }), /Repeated employment report/);
  assert(!commands.some(args => ['add', 'commit', 'push'].includes(args[0])));
});
