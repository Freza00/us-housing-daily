import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { extractArticle, createCollector } from '../lib/sources.mjs';
import { nativeFetch } from '../lib/source-http.mjs';

test('a matching article h3 removes div-based government navigation before evidence slicing', () => {
  const title = 'Federal Reserve issues FOMC statement';
  const html = '<meta property="og:title" content="' + title + '"><body><div>Skip to main content An official website ' + 'Navigation links '.repeat(80)
    + '</div><h3>' + title + '</h3><p>October 28, 2026</p><p>The Committee maintained the target range at 3.75 to 4 percent.</p></body>';
  const article = extractArticle(html, 'https://www.federalreserve.gov/story');
  assert.ok(article.description.startsWith(title));
  assert.doesNotMatch(article.description, /Navigation|Skip to main/);
  assert.match(article.description.slice(0, 500), /3\.75 to 4/);
});

test('the article headline wins over a branding heading and sidebar statistics', () => {
  const html = '<meta property="og:title" content="Real housing research"><body><h1>Company investor relations</h1><aside>Wrong data 999%</aside><h2>Real housing research</h2><p>Housing sales rose 5%.</p></body>';
  const article = extractArticle(html, 'https://example.com/report');
  assert.equal(article.description, 'Real housing research Housing sales rose 5%.');
});

test('navigation-only government pages cannot satisfy body qualification', () => {
  const article = extractArticle('<title>Unavailable research</title><body>Skip to main content An official website ' + 'Navigation links '.repeat(80) + '</body>', 'https://example.com/report');
  assert.equal(article.description, '');
});

test('SEC failures fall back to relative IR links without changing the release timestamp or headline', async () => {
  const published = Date.parse('2026-10-28T20:15:00Z'), calls = [];
  const source = { id: 'invh', name: 'Invitation Homes', url: 'https://www.sec.gov/feed', alternates: ['https://invh.example.com/rss'], ua_style: 'sec', required_for_section: 'btr', tags: ['btr-sfr'], weight: 10 };
  const xml = '<rss><item><title>Invitation Homes Reports Third Quarter 2026 Results</title><link>/results.pdf</link><description/><pubDate>Wed, 28 Oct 2026 16:15:00 -0400</pubDate></item></rss>';
  const collector = createCollector({ now: published + 3600000, upper: published + 2700000, lower: published - 86400000, fetchImpl: async (url, options) => {
    calls.push({ url, agent: options.headers['User-Agent'] });
    if (url.includes('sec.gov')) return new Response('', { status: 403 });
    if (url.endsWith('/rss')) return new Response(xml);
    return new Response('<script type="application/ld+json">' + JSON.stringify({ '@type': 'NewsArticle', headline: 'Generic earnings document', articleBody: 'The company reported quarterly operating results and rental growth. '.repeat(8) }) + '</script>');
  } });
  const [result] = await collector.collect([source]);
  assert.equal(result.health.status, 'ok');
  assert.equal(result.health.required_for_section, 'btr');
  assert.equal(result.items[0].link, 'https://invh.example.com/results.pdf');
  assert.equal(result.items[0].published_at, published);
  assert.match(result.items[0].title, /Invitation Homes Reports/);
  assert.match(calls[0].agent, /^US-Housing-Research/);
  assert.match(calls[1].agent, /^Mozilla/);
});

test('RSS hydration and later enrichment inherit the registered source transport', async () => {
  const source = { id: 'ir', name: 'Official IR', url: 'https://example.com/feed', http_client: 'https', tags: ['btr-sfr'] };
  const calls = [], body = 'The company reported quarterly operating results and rental growth. '.repeat(8);
  const xml = '<rss><item><title>Quarterly operating results</title><link>https://example.com/report</link><description/><pubDate>Wed, 28 Oct 2026 16:15:00 -0400</pubDate></item></rss>';
  const collector = createCollector({ now: Date.parse('2026-10-28T21:00:00Z'), fetchImpl: async () => { assert.fail('source must retain HTTPS transport'); }, nativeFetchImpl: async url => {
    calls.push(url);
    return new Response(url.endsWith('/feed') ? xml : '<article><h1>Quarterly operating results</h1><p>' + body + '</p></article>');
  } });
  const [result] = await collector.collect([source]);
  assert.equal(result.items[0].evidence_status, 'article');
  const [enriched] = await collector.enrich(result.items);
  assert.equal(enriched.evidence_status, 'article');
  assert.deepEqual(calls, [source.url, 'https://example.com/report', 'https://example.com/report']);
});

test('pending candidates retain source transport even when the source is not recollected', async () => {
  const source = { id: 'ir', http_client: 'https' };
  const collector = createCollector({ sources: [source], fetchImpl: async () => { assert.fail('pending source must retain HTTPS transport'); }, nativeFetchImpl: async () => new Response('<article><h1>Quarterly results</h1><p>' + 'Verified official operating results. '.repeat(10) + '</p></article>') });
  const [item] = await collector.enrich([{ id: 'saved', source_id: 'ir', title: 'Saved headline', link: 'https://example.com/report', description: '' }]);
  assert.equal(item.evidence_status, 'article');
  assert.equal(item.title, 'Saved headline');
});

test('recent empty feed bodies remain a source gap after failed enrichment', async () => {
  const xml = '<rss><item><title>Invitation Homes Reports Quarterly Results</title><link>https://example.com/report</link><description/><pubDate>Wed, 28 Oct 2026 16:15:00 -0400</pubDate></item></rss>';
  const collector = createCollector({ now: Date.parse('2026-10-28T21:00:00Z'), fetchImpl: async url => url.endsWith('/feed') ? new Response(xml) : new Response('', { status: 403 }) });
  const [result] = await collector.collect([{ id: 'invh', name: 'INVH', url: 'https://example.com/feed', tags: ['btr-sfr'] }]);
  assert.equal(result.health.status, 'unreadable');
  assert.equal(result.health.unreadable_recent, 1);
});

function fakeRequest(responses, seen = []) {
  return (url, options, callback) => {
    const req = new EventEmitter(); seen.push({ url: String(url), options });
    process.nextTick(() => { const next = responses.shift(); const res = Readable.from([Buffer.from(next.body || '')]); Object.assign(res, { statusCode: next.status, headers: next.headers || {} }); callback(res); });
    return req;
  };
}

test('native source HTTP handles relative redirects and bodyless conditional responses', async () => {
  const seen = [];
  const response = await nativeFetch('https://example.com/feed', {}, 3, fakeRequest([{ status: 302, headers: { location: '/rss' } }, { status: 200, body: '<rss/>' }], seen));
  assert.equal(await response.text(), '<rss/>');
  assert.equal(seen[1].url, 'https://example.com/rss');
  const cached = await nativeFetch('https://example.com/rss', {}, 3, fakeRequest([{ status: 304 }]));
  assert.equal(cached.status, 304);
  assert.equal(cached.body, null);
});

test('native source HTTP bounds redirects and propagates abort failures', async () => {
  await assert.rejects(nativeFetch('https://example.com/rss', {}, 0, fakeRequest([{ status: 302, headers: { location: '/again' } }])), /redirect limit/);
  const controller = new AbortController();
  const pending = nativeFetch('https://example.com/rss', { signal: controller.signal }, 3, (url, options) => {
    const req = new EventEmitter(); options.signal.addEventListener('abort', () => req.emit('error', options.signal.reason)); return req;
  });
  controller.abort(new Error('fixture abort'));
  await assert.rejects(pending, /fixture abort/);
});
