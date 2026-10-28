import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { etMidnight } from './calendar.mjs';
import { parseFeed, makeItem, decode, canonicalUrl, itemId } from './news-core.mjs';

export async function mapLimit(values, limit, fn) {
  const result = new Array(values.length); let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    for (;;) { const i = index++; if (i >= values.length) return; result[i] = await fn(values[i], i); }
  }));
  return result;
}
const hash = s => createHash('sha256').update(s).digest('hex');
const clean = s => decode(String(s).replace(/<(script|style|svg|nav|footer|header|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' '));
const attr = (s, name) => s.match(new RegExp('\\b' + name + '\\s*=\\s*["\']([^"\']+)["\']', 'i'))?.[1] || '';
const errorMessage = e => e.message + (e.cause?.code ? ' (' + e.cause.code + ')' : '');
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
  const contentHtml = html.replace(/<(script|style|svg|noscript|header|footer|nav)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const main = contentHtml.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] || contentHtml.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  const fallback = contentHtml.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1];
  const marker = source.content_start ? contentHtml.indexOf(source.content_start) : -1;
  let body = clean(marker >= 0 ? contentHtml.slice(marker) : article.articleBody || (clean(main || '').length >= 160 ? main : fallback || main) || fallback || metadata.description || metadata['og:description'] || '');
  if (marker < 0 && !article.articleBody && clean(main || '').length < 160 && fallback) {
    const heading = clean(contentHtml.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');
    const at = heading.length > 8 ? body.indexOf(heading) : -1;
    if (at >= 0) body = body.slice(at);
  }
  const explicit = article.datePublished || metadata['article:published_time'] || metadata['datePublished'] || metadata['pubdate'] || html.match(/<time\b[^>]*datetime=["']([^"']+)/i)?.[1];
  const visible = body.slice(0, 1800).match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+20\d{2}\b/i)?.[0];
  const canonicalTag = [...html.matchAll(/<link\b[^>]*>/gi)].find(m => attr(m[0], 'rel') === 'canonical')?.[0];
  let canonical = attr(canonicalTag || '', 'href') || url;
  try { if (new URL(canonical, url).hostname.replace(/^www\./, '') !== new URL(url).hostname.replace(/^www\./, '')) canonical = url; } catch { canonical = url; }
  return { title, description: body.slice(0, 6000), ...dateFields(explicit || visible), modified_at: parseDate(article.dateModified || metadata['article:modified_time']),
    extraction: marker >= 0 ? 'marker' : article.articleBody ? 'structured' : main ? 'semantic' : fallback ? 'body_fallback' : 'metadata', canonical: canonicalUrl(new URL(canonical, url).href), content_hash: hash(body), access: /sign (?:up|in)|unlock (?:the )?(?:full|report)|complete (?:the )?form/i.test(body) ? 'preview' : 'public' };
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
      if (!found.has(link) || title.length > found.get(link).title.length) found.set(link, { link, title: clean(title) });
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

export function createCollector({ cache = {}, fetchImpl = fetch, now = Date.now(), upper = now, lower = upper - 7 * 86400000, lowerBySource = {} } = {}) {
  const docs = cache.docs ||= {}, sourcesState = cache.sources ||= {};
  async function request(url, source) {
    const old = docs[url];
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal, headers: { 'User-Agent': source.ua_style === 'sec' ? `US-Housing-Research ${process.env.SEC_CONTACT_EMAIL || 'research-contact-not-configured'}` : 'Mozilla/5.0 (compatible; HousingResearch/1.0)',
        Accept: 'text/html,application/rss+xml,application/atom+xml,application/xml,application/pdf;q=0.8,*/*;q=0.5',
        ...(old?.etag ? { 'If-None-Match': old.etag } : {}), ...(old?.last_modified ? { 'If-Modified-Since': old.last_modified } : {}) } });
      if (res.status === 304 && old) return { ...old, cached: true };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader(), chunks = []; let size = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 20 * 1024 * 1024) { await reader.cancel(); throw new Error('Source exceeds 20 MiB limit'); } chunks.push(value); }
      const bytes = Buffer.concat(chunks), type = res.headers.get('content-type') || '';
      const pdf = /application\/pdf/i.test(type) || bytes.subarray(0, 5).toString() === '%PDF-';
      let document;
      if (pdf) { const body = await pdfText(bytes); const date = body.slice(0, 2500).match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+20\d{2}\b/i)?.[0]; document = { article: { title: clean(body.split('\n').filter(x => x.trim().length > 12).slice(0, 2).join(' ')), description: body.slice(0, 6000), ...dateFields(date), canonical: canonicalUrl(url), content_hash: hash(body), access: 'public' } }; }
      else {
        const text = bytes.toString();
        if (/<rss\b|<feed\b/i.test(text)) document = { items: parseFeed(text, source) };
        else document = { article: extractArticle(text, url, source), links: discoverLinks(text, url, source), embedded_pdfs: [...text.matchAll(/<(?:iframe|embed|object)\b[^>]*(?:src|data)=["']([^"']+\.pdf(?:\?[^"']*)?)["']/gi)].map(m => new URL(m[1], url).href) };
      }
      const value = { ...document, first_seen_at: old?.first_seen_at || now, etag: res.headers.get('etag'), last_modified: res.headers.get('last-modified'), checked_at: now };
      docs[url] = value; return value;
    } finally { clearTimeout(timer); }
  }
  async function collectSource(source) {
    const sourceLower = lowerBySource[source.id] ?? lower;
    const prior = sourcesState[source.id], health = { id: source.id, name: source.name, research: !!source.is_research, required: !!source.required, checked_at: now, attempted_urls: [], status: 'error', discovered: 0, articles: 0 };
    let document, selectedUrl, error;
    for (const url of [source.url, ...(source.alternates || [])]) {
      health.attempted_urls.push(url);
      try { const value = await request(url, source); if (Array.isArray(value.items) && !value.items.length) throw new Error('Feed contained no parsed items'); if (!value.items && source.type !== 'page' && !value.links?.length) throw new Error('Directory contained no matching links'); if (source.type !== 'html' && source.type !== 'page' && !value.items?.length && !source.is_research) throw new Error('Feed contained no parsed items'); document = value; selectedUrl = url; break; }
      catch (e) { error = errorMessage(e); }
    }
    if (!document) { health.error = error; sourcesState[source.id] = { ...prior, ...health }; return { items: [], health }; }
    let items = document.items || [];
    if (document.items) {
      const needing = items.filter(it => (!it.published_at || it.published_at >= sourceLower) && (it.description.length < 160 || !it.published_at)).slice(0, source.max_articles || 4);
      const hydrated = new Map((await mapLimit(needing, 2, async it => { const result = await enrich({ ...it, ...{ mutable: !!source.mutable } }); return [it.link, result]; })));
      items = items.map(it => hydrated.get(it.link) || it);
    }
    let discoveredLinks = document.links || [];
    if (source.follow_directories && discoveredLinks.length) {
      const follow = new RegExp(source.follow_directories, 'i');
      const nested = await mapLimit(discoveredLinks.filter(x => follow.test(x.link)).slice(0, 3), 2, async link => {
        try { return (await request(link.link, source)).links || []; } catch (e) { (health.article_errors ||= []).push({url:link.link,error:errorMessage(e)}); return []; }
      });
      discoveredLinks = [...new Map([...discoveredLinks, ...nested.flat()].filter(x => !follow.test(x.link)).map(x => [x.link, x])).values()];
    }
    const links = source.type === 'page' ? [{ link: selectedUrl, title: document.article?.title }] : discoveredLinks.slice(0, source.max_articles || (source.is_research ? 18 : 5));
    health.discovered = source.type === 'page' ? 1 : document.items?.length || discoveredLinks.length || links.length;
    health.discovery_truncated = !document.items && source.type !== 'page' && health.discovered > links.length;
    health.article_budget = links.length;
    if (!document.items) {
      items = [];
      for (let offset = 0; offset < links.length; offset += 2) {
      const batch = await mapLimit(links.slice(offset, offset + 2), 2, async link => {
        try {
          let doc = link.link === selectedUrl ? document : await request(link.link, source);
          if ((!doc.article || doc.article.description.length < 160) && doc.embedded_pdfs?.length) doc = await request(doc.embedded_pdfs[0], source);
          if (!doc.article || doc.article.description.length < 160) throw new Error('Article body unavailable or too short');
          const title = source.prefer_link_title && link.title?.length > 20 ? link.title : doc.article.title || link.title;
          let description = doc.article.description;
          if (source.prefer_link_title) { const at = description.toLowerCase().indexOf(title.toLowerCase()); if (at >= 0) description = description.slice(at); }
          return { ...makeItem(source, title, link.link, description, ''), ...doc.article, title, description, content_hash: hash(description), link: doc.article.canonical || link.link };
        } catch (e) { (health.article_errors ||= []).push({ url: link.link, error: errorMessage(e) }); return null; }
      });
      items.push(...batch.filter(Boolean));
      health.fetched_articles = offset + batch.length;
      const dates = items.map(it => it.published_at);
      if (source.discovery_order === 'newest_first' && !health.article_errors?.length && dates.length > 1 && dates.at(-1) <= sourceLower && dates.every((date, i) => date && (!i || date <= dates[i - 1]))) { health.stop_reason = 'date_horizon'; break; }
      }
      health.discovery_truncated = health.discovered > (health.fetched_articles || 0);
    }
    items = items.map(it => {
      const enriched = { ...it, source_family: source.family || source.id, is_research: !!source.is_research, required_source: !!source.required, mutable: !!source.mutable, first_seen_at: docs[it.link]?.first_seen_at || now };
      enriched.id = itemId(enriched);
      if (enriched.mutable && it.published_at && it.published_at < sourceLower && prior?.versions?.[it.link] && prior.versions[it.link] !== it.content_hash) enriched.changed_without_new_date = true;
      return enriched;
    });
    health.articles = items.length;
    health.fallback_bodies = items.filter(it => it.extraction === 'body_fallback').length;
    health.status = health.discovered === 0 ? 'empty_listing' : items.length === 0 ? 'unreadable' : 'ok';
    health.undated = items.filter(it => !it.published_at).length;
    health.recent = items.filter(it => it.published_at >= sourceLower && it.published_at < upper).length;
    health.earliest_dated = Math.min(...items.filter(it => it.published_at).map(it => it.published_at), Infinity);
    if (!Number.isFinite(health.earliest_dated)) health.earliest_dated = null;
    const dates = items.map(it => it.published_at);
    const orderedHorizon = source.discovery_order === 'newest_first' && dates.length > 1 && dates.every((date, i) => date && (!i || date <= dates[i - 1]));
    health.coverage_basis = orderedHorizon ? 'ordered_date_horizon' : !health.discovery_truncated ? 'full_listing' : 'unverified';
    health.coverage = health.status === 'ok' && (!health.discovery_truncated || orderedHorizon) && !health.article_errors?.length && health.earliest_dated !== null && health.earliest_dated <= sourceLower ? { lower: sourceLower, upper } : null;
    health.changed_without_new_date = items.filter(it => it.changed_without_new_date).map(it => it.link);
    health.versions = Object.fromEntries(items.filter(it => it.mutable).map(it => [it.link, it.content_hash]));
    health.last_success = health.status === 'ok' ? now : prior?.last_success || null;
    sourcesState[source.id] = health;
    return { items, health };
  }
  async function enrich(item) {
    if (item.description?.length >= 1200) return { ...item, evidence_status: item.access === 'preview' ? 'preview' : 'article' };
    try {
      const document = await request(item.link, item);
      if (!document.article || document.article.description.length < 160) return { ...item, evidence_status: item.description.length >= 160 ? 'feed_excerpt' : 'insufficient' };
      return { ...item, ...document.article, published_at: item.published_at || document.article.published_at, link: item.link, description: document.article.description,
        evidence_status: document.article.access === 'preview' ? 'preview' : 'article', id: item.id };
    } catch (e) { return { ...item, evidence_status: item.description.length >= 160 ? 'feed_excerpt' : 'insufficient', enrichment_error: errorMessage(e) }; }
  }
  return { cache, collect: sources => mapLimit(sources, 8, collectSource), enrich: items => mapLimit(items, 5, enrich) };
}
