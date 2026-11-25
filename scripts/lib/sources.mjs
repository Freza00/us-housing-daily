import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { etMidnight } from './calendar.mjs';
import { parseFeed, makeItem, decode, canonicalUrl, itemId } from './news-core.mjs';
import { nativeFetch } from './source-http.mjs';

export async function mapLimit(values, limit, fn) {
  const result = new Array(values.length); let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    for (;;) { const i = index++; if (i >= values.length) return; result[i] = await fn(values[i], i); }
  }));
  return result;
}
const hash = s => createHash('sha256').update(s).digest('hex');
const clean = s => decode(String(s).replace(/<(script|style|svg|nav|footer|header|aside|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' '));
const attr = (s, name) => s.match(new RegExp('\\b' + name + '\\s*=\\s*["\']([^"\']+)["\']', 'i'))?.[1] || '';
const errorMessage = e => e.message + (e.cause?.code ? ' (' + e.cause.code + ')' : '');
const hostname = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
export const isGoogleNews = url => hostname(url) === 'news.google.com';
const scopedPublisher = url => /^(?:resiclubanalytics\.com|news\.btrlist\.com|pei-privaterealestate\.com|perenews\.com)$/.test(hostname(url));
const googleShellTitle = title => /^(?:redirect(?:ing)? (?:via|to) )?google news(?:\s*[-|:]\s*(?:redirect|headlines))?$/i.test(title || '');
export function hasPublicationEvidence(item) {
  const scoped = scopedPublisher(item.final_url || item.link);
  const minimum = scoped || item.extraction === 'rss' || item.evidence_status === 'feed_excerpt' ? 160 : 80;
  return item.mode !== 'discovery_only' && item.mode !== 'disabled' && !item.google_news_shell
    && !isGoogleNews(item.final_url || item.link) && !googleShellTitle(item.title)
    && item.access !== 'paywalled' && item.evidence_status !== 'insufficient' && item.description?.trim().length >= minimum
    && (!scoped || item.extraction === 'publisher_body');
}

function attemptError(url, error) {
  const message = errorMessage(error);
  const status = message.match(/^HTTP (\d{3})$/)?.[1];
  const code = error.sourceCode || (status ? 'http_' + status
    : /ERR_TLS_CERT_ALTNAME_INVALID|hostname.*certificate/i.test(message) ? 'tls_hostname'
    : /AbortError|TimeoutError/.test(error.name) || /timeout|ETIMEDOUT/i.test(message) ? 'timeout' : 'fetch_error');
  return { url, code, error: message };
}

function divContent(html, marker) {
  let start;
  for (const match of html.matchAll(/<div\b[^>]*>/gi)) if (marker.test(match[0])) { start = match; break; }
  if (!start) return '';
  const rest = html.slice(start.index + start[0].length);
  let depth = 1;
  for (const match of rest.matchAll(/<\/?div\b[^>]*>/gi)) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (!depth) return rest.slice(0, match.index);
  }
  return '';
}
function dateFields(value) {
  const text = String(value || '').trim();
  let day = text.match(/^\d{4}-\d{2}-\d{2}$/)?.[0] || (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text) ? text.slice(0,10) : null);
  if (!day && /^(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+20\d{2}$/i.test(text)) { const n = Date.parse(text + ' UTC'); if (Number.isFinite(n)) day = new Date(n).toISOString().slice(0, 10); }
  const timestamp = day ? etMidnight(day) + 12 * 3600000 : Date.parse(text);
  return { published_at: Number.isFinite(timestamp) ? timestamp : 0, date_precision: day ? 'day' : 'timestamp', ...(day ? { published_date: day } : {}) };
}
const parseDate = value => dateFields(value).published_at;

export function extractArticle(html, url, source = {}) {
  const metadata = {};
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) metadata[attr(match[0], 'property') || attr(match[0], 'name') || attr(match[0], 'itemprop')] = decode(attr(match[0], 'content'));
  const jsonNodes = [];
  const visit = value => { if (!value || typeof value !== 'object') return; if (Array.isArray(value)) return value.forEach(visit); jsonNodes.push(value); if (value['@graph']) visit(value['@graph']); };
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) { try { visit(JSON.parse(match[1])); } catch {} }
  const article = jsonNodes.find(x => /Article|NewsArticle|BlogPosting|Report/i.test(String(x['@type']))) || {};
  const title = clean(article.headline || metadata['og:title'] || html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const contentHtml = html.replace(/<(script|style|svg|noscript|header|footer|nav|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const main = contentHtml.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] || contentHtml.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  const fallback = contentHtml.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1];
  const marker = source.content_start ? contentHtml.indexOf(source.content_start) : -1;
  let body = clean(marker >= 0 ? contentHtml.slice(marker) : article.articleBody || (clean(main || '').length >= 160 ? main : fallback || main) || fallback || metadata.description || metadata['og:description'] || '');
  if (marker < 0 && !article.articleBody) {
    const headings = [...contentHtml.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map(match => clean(match[1])).filter(value => value.length > 8);
    const matching = headings.find(value => title.toLowerCase().includes(value.toLowerCase()) || value.toLowerCase().includes(title.toLowerCase()));
    const heading = matching || (clean(main || '').length < 160 ? headings[0] : '');
    const at = heading ? body.indexOf(heading) : -1;
    if (at >= 0) body = body.slice(at);
    else if (/^(?:skip to main content|an official website|here.s how you know)\b/i.test(body)) body = clean(metadata.description || metadata['og:description'] || '');
  }
  const host = hostname(url);
  const nmhcDate = host === 'nmhc.org' && html.match(/<h4\b[^>]*class=["'][^"']*\bpage__header--date\b[^"']*["'][^>]*>([\s\S]*?)<\/h4>/i)?.[1];
  const explicit = article.datePublished || metadata['article:published_time'] || metadata['datePublished'] || metadata['pubdate'] || html.match(/<time\b[^>]*datetime=["']([^"']+)/i)?.[1];
  const visible = !scopedPublisher(url) && host !== 'nmhc.org' && body.slice(0, 1800).match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+20\d{2}\b/i)?.[0];
  let extraction = marker >= 0 ? 'marker' : article.articleBody ? 'structured' : main ? 'semantic' : fallback ? 'body_fallback' : 'metadata';
  let access = /sign (?:up|in)|unlock (?:the )?(?:full|report)|complete (?:the )?form/i.test(body) ? 'preview' : 'public';
  if (scopedPublisher(url)) {
    const scope = host === 'resiclubanalytics.com'
      ? divContent(contentHtml, /class=["'][^"']*\bdream-post-content-doc\b/)
      : host === 'news.btrlist.com' ? divContent(contentHtml, /\bid=["']content-blocks["']/)
        : divContent(contentHtml, /\bid=["']article-body-portal["']/);
    const paragraphs = [...scope.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)]
      .filter(match => !/(?:\shidden(?:\s|=|$)|aria-hidden\s*=\s*["']true|display\s*:\s*none)/i.test(match[1]))
      .map(match => clean(match[2]))
      .filter(text => text.length >= 35 && !/^(?:subscribe|upgrade|log ?in|sign in|this (?:post|article) is (?:for|available)|already a (?:member|subscriber)|you.re currently a free subscriber)\b/i.test(text));
    body = paragraphs.join(' ');
    extraction = 'publisher_body';
    access = body.length >= 160 ? 'public' : 'paywalled';
  }
  if (host === 'arbor.com' && new URL(url).pathname.startsWith('/research/reports/')) {
    const reportPath = new URL(url).pathname.replace(/\/$/, '');
    const report = [...contentHtml.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].find(match =>
      discoverLinks(match[1], new URL('/', url).href, { include: '/research/reports/' })
        .some(({ link }) => new URL(link).pathname.replace(/\/$/, '') === reportPath));
    if (report || /class=["'][^"']*\bpost-items\b/.test(contentHtml)) {
      body = clean(divContent(report?.[1] || '', /class=["'][^"']*\bentry-summary\b/));
      extraction = 'publisher_summary';
      access = 'preview';
    }
  }
  const googleNewsShell = isGoogleNews(url) || googleShellTitle(title) || /^(?:google news\s+)?(?:redirecting to|continue to the (?:article|publisher))\b/i.test(body);
  if (googleNewsShell) body = '';
  const canonicalTag = [...html.matchAll(/<link\b[^>]*>/gi)].find(m => attr(m[0], 'rel') === 'canonical')?.[0];
  let canonical = attr(canonicalTag || '', 'href') || url;
  try { if (new URL(canonical, url).hostname.replace(/^www\./, '') !== new URL(url).hostname.replace(/^www\./, '')) canonical = url; } catch { canonical = url; }
  return { title, description: body.slice(0, 6000), ...dateFields(explicit || clean(nmhcDate || '') || visible), modified_at: parseDate(article.dateModified || metadata['article:modified_time']),
    extraction, canonical: canonicalUrl(new URL(canonical, url).href), content_hash: hash(body), access,
    ...(googleNewsShell ? { google_news_shell: true } : {}) };
}

export function discoverLinks(text, base, source) {
  const found = new Map(), include = source.include ? new RegExp(source.include, 'i') : null;
  const add = (href, title = '') => {
    try { const u = new URL(decode(href).replace(/^[\u2018\u2019\u201c\u201d]+|[\u2018\u2019\u201c\u201d]+$/g, ''), base); if (!/^https?:$/.test(u.protocol)) return;
      if (!source.external_links && u.hostname.replace(/^www\./, '') !== new URL(base).hostname.replace(/^www\./, '')) return;
      const link = u.href;
      if (canonicalUrl(link) === canonicalUrl(base) || /\.(?:jpg|jpeg|png|svg|zip|xlsx?|csv)(?:\?|$)/i.test(link)) return;
      if (include && !include.test(link)) return;
      if (source.exclude && new RegExp(source.exclude, 'i').test(link)) return;
      if (source.link_title_include && !new RegExp(source.link_title_include, 'i').test(clean(title))) return;
      if (/\/(?:tag|category|author|page|search|login|register|subscribe)(?:\/|\?|$)/i.test(link)) return;
      if (!include && !/\.pdf(?:\?|$)/i.test(link) && (clean(title).length < 22 || /privacy|terms of|contact us|sign in|read more|learn more|view all/i.test(clean(title)))) return;
      if (source.strip_link_query) u.search = '';
      const key = canonicalUrl(u.href);
      if (!found.has(key) || title.length > found.get(key).title.length) found.set(key, { link: u.href, title: clean(title) });
    } catch {}
  };
  for (const m of text.matchAll(/<a\b([^>]*?)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi)) add(m[2], m[4]);
  if (/<urlset\b/i.test(text)) {
    const urls = [...text.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)].map(m => ({ link: m[1].match(/<loc>([\s\S]*?)<\/loc>/i)?.[1], modified: m[1].match(/<lastmod>([^<]+)/i)?.[1] || '' })).sort((a,b) => b.modified.localeCompare(a.modified));
    for (const u of urls) if (u.link) add(u.link);
  }
  return [...found.values()];
}

async function pdfText(bytes) {
  return new Promise((resolve, reject) => {
    const child = spawn('pdftotext', ['-layout', '-', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let length = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('PDF extraction timeout')); }, 15000);
    child.stdout.on('data', chunk => { length += chunk.length; if (length <= 2000000) chunks.push(chunk); });
    child.on('error', error => { clearTimeout(timer); reject(new Error('PDF extractor unavailable: ' + error.message)); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(chunks).toString()) : reject(new Error('PDF extraction failed')); });
    child.stdin.on('error', () => {}); child.stdin.end(bytes);
  });
}

export function createCollector({ cache = {}, fetchImpl = fetch, nativeFetchImpl = fetchImpl === fetch ? nativeFetch : fetchImpl, sources = [], now = Date.now(), upper = now, lower = upper - 7 * 86400000, lowerBySource = {} } = {}) {
  const docs = cache.docs ||= {}, sourcesState = cache.sources ||= {};
  const sourceById = new Map(sources.map(source => [source.id, source]));
  async function request(url, source) {
    const old = docs[url];
    const conditional = old?.final_url ? old : null;
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const fetchSource = source.http_client === 'https' ? nativeFetchImpl : fetchImpl;
      const res = await fetchSource(url, { signal: ctrl.signal, headers: { 'User-Agent': source.ua_style === 'sec' && /(^|\.)sec\.gov$/i.test(new URL(url).hostname) ? `US-Housing-Research ${process.env.SEC_CONTACT_EMAIL || 'research-contact-not-configured'}` : 'Mozilla/5.0 (compatible; HousingResearch/1.0)',
        Accept: 'text/html,application/rss+xml,application/atom+xml,application/xml,application/pdf;q=0.8,*/*;q=0.5',
        ...(conditional?.etag ? { 'If-None-Match': conditional.etag } : {}), ...(conditional?.last_modified ? { 'If-Modified-Since': conditional.last_modified } : {}) } });
      if (res.status === 304 && old) return { ...old, cached: true };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader(), chunks = []; let size = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 20 * 1024 * 1024) { await reader.cancel(); throw new Error('Source exceeds 20 MiB limit'); } chunks.push(value); }
      const bytes = Buffer.concat(chunks), type = res.headers.get('content-type') || '';
      const finalUrl = res.url || url;
      const pdf = /application\/pdf/i.test(type) || bytes.subarray(0, 5).toString() === '%PDF-';
      let document;
      if (pdf) { const body = await pdfText(bytes); const date = body.slice(0, 2500).match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+20\d{2}\b/i)?.[0]; document = { article: { title: clean(body.split('\n').filter(x => x.trim().length > 12).slice(0, 2).join(' ')), description: body.slice(0, 6000), ...dateFields(date), canonical: canonicalUrl(url), content_hash: hash(body), access: 'public' } }; }
      else {
        const text = bytes.toString();
        if (/<rss\b|<feed\b/i.test(text)) document = { items: parseFeed(text, source).flatMap(item => {
          try { const link = new URL(item.link, finalUrl); return /^https?:$/.test(link.protocol) ? [{ ...item, link: link.href, extraction: 'rss', date_precision: 'timestamp' }] : []; } catch { return []; }
        }) };
        else document = { article: extractArticle(text, finalUrl, source), links: discoverLinks(text, finalUrl, source), embedded_pdfs: [...text.matchAll(/<(?:iframe|embed|object)\b[^>]*(?:src|data)=["']([^"']+\.pdf(?:\?[^"']*)?)["']/gi)].map(m => new URL(m[1], finalUrl).href) };
      }
      const value = { ...document, final_url: finalUrl, first_seen_at: old?.first_seen_at || now, etag: res.headers.get('etag'), last_modified: res.headers.get('last-modified'), checked_at: now };
      docs[url] = value; return value;
    } finally { clearTimeout(timer); }
  }
  async function collectSource(source) {
    sourceById.set(source.id, source);
    const sourceLower = lowerBySource[source.id] ?? lower;
    const prior = sourcesState[source.id], mode = source.mode || 'active';
    const health = { id: source.id, name: source.name, family: source.family || source.id, research: !!source.is_research, required: !!source.required, required_for_section: source.required_for_section, checked_at: now,
      mode, attempted_urls: [], attempt_errors: [], selected_url: null, used_alternate: false, primary_error: null, route_kind: null,
      latest_published_at: null, recent_in_issue: 0, coverage: null, status: 'error', discovered: 0, articles: 0 };
    if (mode === 'disabled') { health.status = 'disabled'; sourcesState[source.id] = health; return { items: [], health }; }
    let document, selectedUrl, singlePage = false;
    for (const url of [source.url, ...(source.alternates || [])]) {
      health.attempted_urls.push(url);
      try {
        const value = await request(url, source);
        const page = source.type === 'page' && (url === source.url || !source.include);
        if ((Array.isArray(value.items) && !value.items.length) || (!value.items && !page && !['html', 'page'].includes(source.type) && !source.is_research)) throw Object.assign(new Error('Feed contained no parsed items'), { sourceCode: 'empty_feed' });
        if (!value.items && !page && !value.links?.length) throw Object.assign(new Error('Directory contained no matching links'), { sourceCode: 'no_matching_links' });
        document = value; selectedUrl = url; singlePage = page; break;
      } catch (e) {
        const failure = attemptError(url, e);
        health.attempt_errors.push(failure);
        if (url === source.url) health.primary_error = failure;
      }
    }
    if (!document) {
      health.error = health.attempt_errors.at(-1)?.error;
      sourcesState[source.id] = { ...health, versions: prior?.versions, last_success: prior?.last_success || null };
      return { items: [], health };
    }
    health.selected_url = selectedUrl;
    if (document.final_url !== selectedUrl) health.resolved_url = document.final_url;
    health.used_alternate = selectedUrl !== source.url;
    health.route_kind = isGoogleNews(selectedUrl) || isGoogleNews(document.final_url) ? 'aggregator' : health.used_alternate ? 'official_alternate' : 'publisher';
    let items = document.items || [];
    if (document.items && mode !== 'discovery_only' && health.route_kind !== 'aggregator') {
      const needing = items.filter(it => (!it.published_at || it.published_at >= sourceLower) && (it.description.length < 160 || !it.published_at)).slice(0, source.max_articles || 4);
      const hydrated = new Map((await mapLimit(needing, 2, async it => { const result = await enrich({ ...it, ...{ mutable: !!source.mutable } }); return [it.link, result]; })));
      items = items.map(it => hydrated.get(it.link) || it);
    }
    let discoveredLinks = document.links || [];
    if (mode !== 'discovery_only' && source.follow_directories && discoveredLinks.length) {
      const follow = new RegExp(source.follow_directories, 'i');
      const nested = await mapLimit(discoveredLinks.filter(x => follow.test(x.link)).slice(0, 3), 2, async link => {
        try { return (await request(link.link, source)).links || []; } catch (e) { (health.article_errors ||= []).push({url:link.link,error:errorMessage(e)}); return []; }
      });
      discoveredLinks = [...new Map([...discoveredLinks, ...nested.flat()].filter(x => !follow.test(x.link)).map(x => [x.link, x])).values()];
    }
    const links = singlePage ? [{ link: selectedUrl, title: document.article?.title }] : discoveredLinks.slice(0, source.max_articles || (source.is_research ? 18 : 5));
    health.discovered = singlePage ? 1 : document.items?.length || discoveredLinks.length || links.length;
    health.article_budget = mode === 'discovery_only' ? 0 : links.length;
    if (!document.items) {
      items = [];
      if (mode === 'discovery_only') {
        items = links.map(link => makeItem(source, link.title, link.link, '', ''));
      } else {
        for (let offset = 0; offset < links.length; offset += 2) {
          const batch = await mapLimit(links.slice(offset, offset + 2), 2, async link => {
            try {
              let doc = link.link === selectedUrl ? document : await request(link.link, source);
              if ((!doc.article || doc.article.description.length < 160) && doc.embedded_pdfs?.length) doc = await request(doc.embedded_pdfs[0], source);
              if (!doc.article) throw new Error('Article body unavailable');
              if (doc.article.description.length < 160 || !hasPublicationEvidence({ ...doc.article, final_url: doc.final_url })) (health.article_errors ||= []).push({
                url: link.link, code: 'insufficient_evidence', error: 'Article body unavailable or too short' });
              const title = source.prefer_link_title && link.title?.length > 20 ? link.title : doc.article.title || link.title;
              let description = doc.article.description;
              if (source.prefer_link_title) { const at = description.toLowerCase().indexOf(title.toLowerCase()); if (at >= 0) description = description.slice(at); }
              const item = { ...makeItem(source, title, link.link, description, ''), ...doc.article, title, description, content_hash: hash(description), link: doc.article.canonical || link.link, final_url: doc.final_url };
              return { ...item, evidence_status: description.length >= 160 && hasPublicationEvidence(item) ? item.access === 'preview' ? 'preview' : 'article' : 'insufficient' };
            } catch (e) { (health.article_errors ||= []).push(attemptError(link.link, e)); return null; }
          });
          items.push(...batch.filter(Boolean));
          health.fetched_articles = offset + batch.length;
          const dates = items.map(it => it.published_at);
          if (source.discovery_order === 'newest_first' && !health.article_errors?.length && dates.length > 1 && dates.at(-1) <= sourceLower && dates.every((date, i) => date && (!i || date <= dates[i - 1]))) { health.stop_reason = 'date_horizon'; break; }
        }
      }
      health.discovery_truncated = health.discovered > (health.fetched_articles || 0);
    }
    items = items.map(it => {
      const enriched = { ...it, mode, source_family: source.family || source.id, is_research: !!source.is_research, required_source: !!source.required, ...(source.rate_benchmark ? { rate_benchmark: true } : {}), mutable: !!source.mutable, first_seen_at: docs[it.link]?.first_seen_at || now };
      enriched.id = itemId(enriched);
      if (enriched.mutable && it.published_at && it.published_at < sourceLower && prior?.versions?.[it.link] && prior.versions[it.link] !== it.content_hash) enriched.changed_without_new_date = true;
      return enriched;
    });
    health.articles = items.length;
    health.fallback_bodies = items.filter(it => it.extraction === 'body_fallback').length;
    health.status = health.discovered === 0 ? 'empty_listing' : items.length === 0 ? 'unreadable' : 'ok';
    health.undated = items.filter(it => !it.published_at).length;
    health.latest_published_at = items.reduce((latest, item) => Math.max(latest, item.published_at || 0), 0) || null;
    health.recent = items.filter(it => it.published_at >= sourceLower && it.published_at < upper).length;
    const inIssue = items.filter(it => it.published_at > 0 && it.published_at >= lower && it.published_at < upper);
    health.recent_in_issue = inIssue.length;
    health.recent_insufficient = mode === 'discovery_only' ? 0 : inIssue.filter(it => it.evidence_status === 'insufficient' || it.access === 'paywalled' || it.description.length < 80).length;
    health.unreadable_recent = items.filter(it => it.published_at >= sourceLower && it.published_at < upper && (it.description.length < 80 || it.evidence_status === 'insufficient')).length;
    health.access_limited = items.filter(it => ['preview', 'paywalled'].includes(it.access)).length;
    if (mode !== 'discovery_only' && ((health.recent && health.unreadable_recent === health.recent) || (!document.items && items.every(it => !hasPublicationEvidence(it))))) health.status = 'unreadable';
    health.earliest_dated = Math.min(...items.filter(it => it.published_at).map(it => it.published_at), Infinity);
    if (!Number.isFinite(health.earliest_dated)) health.earliest_dated = null;
    const dates = items.map(it => it.published_at);
    const orderedHorizon = source.discovery_order === 'newest_first' && dates.length > 1 && dates.every((date, i) => date && (!i || date <= dates[i - 1]));
    health.coverage_basis = orderedHorizon ? 'ordered_date_horizon' : !health.discovery_truncated ? 'full_listing' : 'unverified';
    if (health.status === 'ok' && mode !== 'discovery_only' && health.route_kind !== 'aggregator' && (!health.discovery_truncated || orderedHorizon) && !health.article_errors?.length && health.earliest_dated !== null && health.earliest_dated <= sourceLower) health.coverage = { lower: sourceLower, upper };
    health.changed_without_new_date = items.filter(it => it.changed_without_new_date).map(it => it.link);
    health.versions = Object.fromEntries(items.filter(it => it.mutable).map(it => [it.link, it.content_hash]));
    health.last_success = health.status === 'ok' ? now : prior?.last_success || null;
    sourcesState[source.id] = health;
    return { items, health };
  }
  async function enrich(item) {
    const source = sourceById.get(item.source_id) || item;
    const insufficient = (details = {}) => ({ ...item, ...details, evidence_status: 'insufficient' });
    const feedEvidence = () => item.description?.length >= 160 && hasPublicationEvidence(item) && !scopedPublisher(item.link) ? 'feed_excerpt' : 'insufficient';
    if (item.mode === 'discovery_only' || source.mode === 'discovery_only' || item.access === 'paywalled') return insufficient();
    if (item.description?.length >= 1200 && hasPublicationEvidence(item)) return { ...item, evidence_status: item.access === 'preview' ? 'preview' : 'article' };
    try {
      const document = await request(item.link, source);
      const article = document.article;
      const final_url = document.final_url || item.link;
      const dated = item.published_at ? { published_at: item.published_at, date_precision: item.date_precision || 'timestamp', published_date: item.published_date } : {};
      if (isGoogleNews(final_url) || article?.google_news_shell) return insufficient({ final_url, description: '', google_news_shell: true });
      if (article?.access === 'paywalled') return insufficient({ ...article, ...dated, final_url, title: item.title || article.title });
      if (!article || article.description.length < 160 || !hasPublicationEvidence({ ...article, final_url })) return { ...item, final_url, evidence_status: feedEvidence() };
      return { ...item, ...article, ...dated, title: item.title || article.title,
        final_url, link: isGoogleNews(item.link) ? final_url : item.link,
        evidence_status: article.access === 'preview' ? 'preview' : 'article', id: item.id };
    } catch (e) { return { ...item, evidence_status: feedEvidence(), enrichment_error: errorMessage(e) }; }
  }
  return { cache, collect: sources => mapLimit(sources, 8, collectSource), enrich: items => mapLimit(items, 5, enrich) };
}
