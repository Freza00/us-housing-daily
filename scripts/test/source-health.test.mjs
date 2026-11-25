import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCollector, extractArticle, hasPublicationEvidence } from '../lib/sources.mjs';
import { sourceHealth, sourceHealthSummary, requiredSourceProblem } from '../lib/editorial-coverage.mjs';
import { stageCapture } from '../lib/collection-checkpoint.mjs';
import { buildWindow } from '../lib/calendar.mjs';
import { runPipeline } from '../lib/pipeline.mjs';
import { checkSourceHealth } from '../check-source-health.mjs';
import { sourceProbeFailed, sourceProbeSamples } from '../validate-sources.mjs';
import { replayEnv, sample, sandbox } from './helpers.mjs';

const day = 86400000, upper = Date.parse('2026-11-02T05:00:00Z'), lower = upper - day;
const window = { lower, upper };
const articleBody = 'The latest quarterly survey describes rental occupancy and operating expenses across several American housing markets. '
  + 'The report includes regional comparisons and describes how changes in apartment demand varied across the country.';
const feed = (url, date, body = articleBody) => '<rss><channel><item><title>Latest rental market study</title><link>' + url + '</link>'
  + '<description>' + body + '</description>' + (date ? '<pubDate>' + new Date(date).toUTCString() + '</pubDate>' : '') + '</item></channel></rss>';
const source = { id: 'publisher', family: 'group', name: 'Publisher', url: 'https://example.com/feed', required_for_section: 'btr' };

test('collector traces failed primary, empty alternate and working official fallback with separate fixed-window counts', async () => {
  const config = { ...source, alternates: ['https://example.com/empty', 'https://example.org/official'] };
  const published = lower - day;
  const responses = [new Response('', { status: 403 }), new Response('<rss><channel></channel></rss>'),
    new Response(feed('https://example.org/report', published))];
  const collector = createCollector({ lower, upper, lowerBySource: { publisher: published }, fetchImpl: async () => responses.shift() });
  const [{ health }] = await collector.collect([config]);
  assert.equal(health.status, 'ok');
  assert.equal(health.family, 'group');
  assert.equal(health.selected_url, config.alternates[1]);
  assert.equal(health.used_alternate, true);
  assert.equal(health.route_kind, 'official_alternate');
  assert.deepEqual(health.primary_error, { url: source.url, error: 'HTTP 403', code: 'http_403' });
  assert.deepEqual(health.attempt_errors.map(row => row.code), ['http_403', 'empty_feed']);
  assert.equal(health.latest_published_at, published);
  assert.equal(health.recent, 1);
  assert.equal(health.recent_in_issue, 0);
  assert(!requiredSourceProblem(health, { section: true }));
  assert.deepEqual(sourceHealth(health, config).health_reasons, ['used_alternate', 'http_403']);
});

test('collector classifies network, listing and HTTP failures and skips disabled sources entirely', async () => {
  const original = { ...source, type: 'html', include: '/report', alternates: ['https://example.com/tls', 'https://example.com/timeout', 'https://example.com/missing', 'https://example.com/directory'] };
  const calls = [];
  const collector = createCollector({ upper, fetchImpl: async url => {
    calls.push(url);
    if (url.endsWith('/tls')) throw new TypeError('fetch failed', { cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } });
    if (url.endsWith('/timeout')) throw new DOMException('Aborted', 'AbortError');
    if (url.endsWith('/missing')) return new Response('', { status: 404 });
    if (url.endsWith('/directory')) return new Response('<html><a href="/other">Other</a></html>');
    throw new Error('fetch failed');
  } });
  const [{ health }, disabled] = await collector.collect([original, { ...source, id: 'disabled', mode: 'disabled' }]);
  assert.equal(calls.length, 5);
  assert.deepEqual(health.attempt_errors.map(row => row.code), ['fetch_error', 'tls_hostname', 'timeout', 'http_404', 'no_matching_links']);
  assert.equal(health.selected_url, null);
  assert.equal(health.latest_published_at, null);
  assert.equal(disabled.health.status, 'disabled');
  assert.deepEqual(disabled.health.attempted_urls, []);
  assert.equal(sourceHealth(disabled.health).effective_status, 'unknown');
});

test('aggregator and discovery-only routes never advance a publisher watermark and capture drops are counted', async () => {
  const google = 'https://news.google.com/rss?q=market';
  const config = { ...source, alternates: [google] };
  const collector = createCollector({ lower, upper, fetchImpl: async url => url === source.url
    ? new Response('', { status: 403 }) : new Response(feed('https://news.google.com/rss/articles/story', lower, 'Short')) });
  const [result] = await collector.collect([config]);
  assert.equal(result.health.route_kind, 'aggregator');
  assert.equal(result.health.coverage, null);
  assert.equal(result.health.recent_in_issue, 1);
  assert(requiredSourceProblem(result.health));
  for (const guard of [{ route_kind: 'aggregator' }, { mode: 'discovery_only' }, {}]) {
    const missingDate = !Object.keys(guard).length;
    const items = [{ id: 'short', source_id: source.id, published_at: missingDate ? 0 : lower + 1, description: 'Short' }];
    const health = { id: source.id, status: 'ok', articles: 1, undated: Number(missingDate), coverage: window, ...guard };
    const staged = stageCapture({}, [source], [{ health, items }], window);
    assert.equal(staged.checkpoint.source_upper[source.id], undefined);
    assert.deepEqual(staged.capture.source_health[0].capture_counts, { dated: Number(!missingDate), dropped_undated: Number(missingDate), dropped_short: Number(!missingDate) });
  }
  const discovery = createCollector({ lower, upper, fetchImpl: async url => {
    assert.equal(url, google);
    return new Response(feed('https://news.google.com/rss/articles/story', lower, 'Short'));
  } });
  const [lead] = await discovery.collect([{ ...config, url: google, mode: 'discovery_only' }]);
  assert.equal(lead.health.status, 'ok');
  assert.equal(lead.health.coverage, null);
  assert.equal(lead.health.recent_insufficient, 0);
});

test('staleness depends on published date and expected cadence, while undated and unobserved remain distinct', () => {
  const recent = { id: 'a', status: 'ok', selected_url: source.url, articles: 1, undated: 0, latest_published_at: upper - 61 * day, recent: 0, checked_at: upper };
  const high = sourceHealth(recent, { frequency: 'high' });
  assert.equal(high.effective_status, 'warning');
  assert.deepEqual(high.health_reasons, ['stale']);
  assert.equal(sourceHealth(recent, { frequency: 'low' }).effective_status, 'ok');
  assert.deepEqual(sourceHealth({ ...recent, articles: 2, undated: 2, latest_published_at: null }).health_reasons, ['undated_all']);
  assert.equal(sourceHealth({ id: 'old', status: 'ok' }).effective_status, 'unknown');
  const stats = sourceHealthSummary({ source_health: [high, { id: 'lead', mode: 'discovery_only', status: 'ok' }],
    source_funnel: { a: { evidence_ok: 1, evidence_insufficient: 1, dropped_short: 1, published: 1 }, lead: { dropped_short: 2 } } });
  assert.equal(stats.stale, 1);
  assert.equal(stats.insufficient_evidence_items, 2);
  assert.equal(stats.contributing_sources, 1);
  assert.equal(stats.published_sources, 1);
});

test('ResiClub reads visible publisher paragraphs and rejects PRO teasers; PEI placeholders do not qualify', () => {
  const resi = 'https://www.resiclubanalytics.com/p/test';
  const article = '<meta property="article:published_time" content="2026-11-01T12:00:00Z"><body>';
  const free = extractArticle(article + '<div id="content-blocks"><div class="dream-post-content-doc"><div><p>' + articleBody + '</p></div></div></div></body>', resi);
  assert.equal(free.access, 'public');
  assert.equal(free.description, articleBody);
  assert(hasPublicationEvidence({ ...free, link: resi }));
  const paid = extractArticle(article + '<main><h1>ResiClub PRO</h1><p>Upgrade to continue.</p><p>' + 'Membership benefits and account information. '.repeat(20) + '</p></main></body>', resi);
  assert.equal(paid.access, 'paywalled');
  assert.equal(paid.description, '');
  assert(!hasPublicationEvidence({ ...paid, link: resi }));
  const pei = 'https://www.pei-privaterealestate.com/equity/a-story/';
  const placeholder = extractArticle(article + '<main><article><p>' + articleBody + '</p><div data-article-body-skeleton="true"></div>'
    + '<div id="article-body-portal"><script>let placeholder = "Full report";</script></div></article></main></body>', pei);
  assert.equal(placeholder.access, 'paywalled');
  assert.equal(placeholder.description, '');
  assert(!hasPublicationEvidence({ ...placeholder, link: pei }));
});

test('NMHC uses its visible date header with day precision and ignores dates in the report narrative', () => {
  const url = 'https://www.nmhc.org/research-insight/quarterly-survey/2026/october/';
  const html = '<body><header><h4 class="page__header--date other"> October 22, 2026 </h4></header>'
    + '<main><p>The previous survey was released July 23, 2026. ' + articleBody + '</p></main></body>';
  const withDate = extractArticle(html, url);
  assert.equal(withDate.published_date, '2026-10-22');
  assert.equal(withDate.date_precision, 'day');
  assert.equal(extractArticle(html.replace(/<header>.*<\/header>/, ''), url).published_at, 0);
});

test('Google News host and redirect shell are rejected even with a plausible RSS lead; real publisher redirection is accepted', async () => {
  const link = 'https://news.google.com/rss/articles/test';
  const redirect = 'https://example.com/report';
  const item = { ...sample('google', lower), link, description: 'RSS headline and repeated navigation. '.repeat(40) };
  const enrich = async (url, text) => {
    const response = new Response(text);
    Object.defineProperty(response, 'url', { value: url });
    const collector = createCollector({ fetchImpl: async () => response });
    return (await collector.enrich([item]))[0];
  };
  for (const finalUrl of [link, redirect]) {
    const rejected = await enrich(finalUrl, '<html><title>Google News</title><body>Continue to the article</body></html>');
    assert.equal(rejected.evidence_status, 'insufficient');
    assert.equal(rejected.description, '');
  }
  const accepted = await enrich(redirect, '<article><h1>Rental report</h1><p>' + articleBody + '</p></article>');
  assert.equal(accepted.link, redirect);
  assert.equal(accepted.evidence_status, 'article');
  assert(!hasPublicationEvidence({ ...item, link: redirect, description: 'A short RSS title and excerpt. '.repeat(4), extraction: 'rss' }));
});

test('all new editions reject bad evidence and discovery lines before the editor, including the old BTR List weekly card', async t => {
  const archive = JSON.parse(await fs.readFile(new URL('../../data/weekly/2026-10-26.json', import.meta.url)));
  const oldBtr = archive.items.find(item => item.source_id === 'btrlist' && item.evidence_status === 'insufficient');
  assert(oldBtr);
  for (const [kind, now] of [['daily', '2026-10-30T01:00:00Z'], ['weekly', '2026-11-02T07:00:00Z'], ['monthly', '2026-11-02T08:00:00Z']]) {
    const root = await sandbox(t), issueWindow = buildWindow(kind, new Date(now));
    const published = oldBtr.published_at;
    const items = [oldBtr, { ...sample('allowed', published), description: articleBody },
      { ...sample('discovery', published), mode: 'discovery_only', description: articleBody },
      { ...sample('weak', published), description: articleBody, evidence_status: 'insufficient' },
      { ...sample('paid', published), description: articleBody, access: 'paywalled' },
      { ...sample('boundary', issueWindow.upper), description: articleBody }];
    const env = await replayEnv(root, { items, source_health: [] }, now);
    const result = await runPipeline(kind, { root, env: { ...env, PIPELINE_UNTIL: 'prepared' } });
    const { snapshot } = JSON.parse(await fs.readFile(path.join(result.issue_dir, 'prepared.json')));
    assert.deepEqual(snapshot.items.map(item => item.id), ['allowed'], kind);
    const exclusions = new Map(snapshot.publication_exclusions.map(row => [row.id, row.reason]));
    assert.equal(exclusions.get(oldBtr.id), 'insufficient_evidence', kind);
    assert.equal(exclusions.get('discovery'), 'discovery_only');
    assert.equal(exclusions.get('weak'), 'insufficient_evidence');
    assert.equal(exclusions.get('paid'), 'insufficient_evidence');
    assert.equal(exclusions.get('boundary'), 'after_cutoff');
    assert.equal(snapshot.source_funnel.discovery.enrich_attempted, 0);
    assert.equal(snapshot.source_funnel.allowed.evidence_ok, 1);
    assert.equal(snapshot.candidate_preparation.attempted, 4);
  }
});

test('live acquisition freezes source drops and reserves the enrichment budget for publication candidates', async t => {
  const root = await sandbox(t), now = '2026-11-03T01:00:00Z';
  const current = buildWindow('daily', new Date(now));
  const date = current.lower + 1000;
  const lead = { id: 'discovery', mode: 'discovery_only' };
  await fs.writeFile(path.join(root, 'config/sources.json'), JSON.stringify({ sources: [source, lead] }));
  const groups = [
    { health: { id: source.id, status: 'ok', discovered: 3, selected_url: source.url }, items: [
      { ...sample('written', date), source_id: source.id, description: articleBody },
      { ...sample('short', date), source_id: source.id, description: 'One headline.' },
      { ...sample('undated', 0), source_id: source.id, description: articleBody }
    ] },
    { health: { id: lead.id, status: 'ok', mode: lead.mode, discovered: 1 }, items: [{ ...sample(lead.id, date), description: articleBody }] }
  ];
  const collector = { cache: {}, async collect() { return groups; }, async enrich(items) {
    assert.deepEqual(items.map(item => item.id), ['written']);
    return items;
  } };
  const env = { PUBLISH_NOW: now, PIPELINE_UNTIL: 'prepared', NEWS_DATA_DIR: path.join(root, 'data'), NEWS_STATE_DIR: path.join(root, 'state') };
  const result = await runPipeline('daily', { root, env, collector });
  const { snapshot } = JSON.parse(await fs.readFile(path.join(result.issue_dir, 'prepared.json')));
  assert.deepEqual(snapshot.source_funnel[source.id], { discovered: 3, dated: 2, dropped_undated: 1, dropped_short: 1,
    enrich_attempted: 1, evidence_ok: 1, evidence_insufficient: 0, not_attempted: 0, selected: 0, published: 0 });
  assert.equal(snapshot.source_funnel.discovery.enrich_attempted, 0);
});

test('probe samples include negative examples and enforce both required types and strict checks', () => {
  const items = [{ id: 'a', published_at: 4 }, { id: 'b', published_at: 3 }, { id: 'c', published_at: 2, evidence_status: 'insufficient' }, { id: 'd', published_at: 0 }];
  assert.deepEqual(sourceProbeSamples(items).map(item => item.id), ['a', 'b', 'd', 'c']);
  const ok = { status: 'ok', route_kind: 'official_alternate', samples: [{ published_at: 1, evidence_ok: true }] };
  assert.equal(sourceProbeFailed([{ ...ok, required_for_section: 'btr' }], { strict: true }), false);
  assert(sourceProbeFailed([{ ...ok, required_for_section: 'btr', status: 'error' }]));
  for (const row of [{ ...ok, route_kind: 'aggregator' }, { ...ok, articles: 1, undated: 1 }, { ...ok, samples: [{ published_at: 1, evidence_ok: false }] }]) {
    assert(sourceProbeFailed([row], { strict: true }));
    assert.equal(sourceProbeFailed([row]), false);
  }
});

test('historical inspection reads three records for each period only once and labels unknown legacy first errors', async t => {
  const root = await sandbox(t), days = ['2026-11-02', '2026-11-03', '2026-11-04'];
  for (const dir of ['state/snapshots', 'state/inputs']) await fs.mkdir(path.join(root, dir));
  await fs.writeFile(path.join(root, 'config/sources.json'), JSON.stringify({ sources: [{ ...source, frequency: 'high' }, { id: 'low', frequency: 'low' }] }));
  for (const period of days) {
    const checked_at = Date.parse(period);
    const observed = { id: source.id, status: 'ok', articles: 2, undated: 2, attempted_urls: [source.url, 'https://news.google.com/feed'], checked_at };
    const exclusions = [{ id: 'failed-item', reason: 'insufficient_evidence' }];
    const issue = { date: period, items: [], _diagnostics: { source_health: [observed], publication_exclusions: exclusions } };
    await fs.writeFile(path.join(root, 'data', period + '.json'), JSON.stringify(issue));
    await fs.writeFile(path.join(root, 'state/snapshots', period + '.json'), JSON.stringify({ source_health: [observed], items: [{ id: 'failed-item', source_id: source.id }] }));
    await fs.writeFile(path.join(root, 'state/inputs', 'daily-' + period + '.json'), JSON.stringify({ items: [], source_health: [observed, { id: 'low', status: 'error', primary_error: { code: 'http_403' }, checked_at }] }));
  }
  const report = await checkSourceHealth({ root, end: days[2], issues: 18 });
  assert.equal(report.issues.length, 3);
  assert.equal(report.issues[0].observations.publisher.primary_error, 'unknown');
  assert.equal(report.issues[0].observations.publisher.route_kind, 'aggregator');
  assert.equal(report.findings.consecutive_fallbacks[0].consecutive_fallbacks, 3);
  assert.equal(report.findings.all_undated[0].all_undated_issues, 3);
  assert.equal(report.findings.consecutive_errors[0].consecutive_errors, 3);
  assert.equal(report.findings.high_insufficient_evidence[0].evidence_insufficient_rate, 1);
  assert.equal(report.findings.zero_published.high.length, 1);
  assert.equal(report.findings.zero_published.low.length, 0);
  assert.equal((await checkSourceHealth({ root, end: days[1], issues: 1 })).issues[0].period, days[1]);
});
