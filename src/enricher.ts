// 文章正文 enrichment — RSS feed 的 description 通常只有 200-600 字，不够用
// enricher 抓取每条 item 的全文 HTML，正则清洗提取 article body 文本（≤ 4000 字）
// 失败时保留 RSS description 作为 fallback
//
// 使用：在 dedup + 跨日去重后、pickBySection 之前调用
// 取 top-30 候选 parallel fetch + extract，给后续 classify / tag / summarize 用

import type { ScoredItem } from "./types";

const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_CHARS = 4000;
const CONCURRENCY = 8;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const HTML_TAG = /<[^>]+>/g;
const SCRIPT_STYLE = /<(script|style|svg|iframe|noscript)[\s\S]*?<\/\1>/gi;
const ENTITY = /&[a-z]+;/gi;
const WHITESPACE = /\s+/g;

// 优先匹配语义化容器 — 大多数新闻站用这些
const ARTICLE_PATTERNS: RegExp[] = [
  /<article\b[\s\S]*?<\/article>/i,
  /<main\b[\s\S]*?<\/main>/i,
  /<div[^>]*?(?:class|id)="[^"]*?(?:article-body|story-body|post-body|entry-content|content-body|article__body|wire-body|articleBody|story__content)[^"]*?"[\s\S]*?<\/div>/i,
];

function cleanHtml(html: string): string {
  let s = html.replace(SCRIPT_STYLE, " ");
  s = s.replace(HTML_TAG, " ");
  s = s.replace(ENTITY, " ");
  s = s.replace(WHITESPACE, " ").trim();
  return s.slice(0, MAX_BODY_CHARS);
}

export function extractBody(html: string): string {
  for (const re of ARTICLE_PATTERNS) {
    const m = html.match(re);
    if (m && m[0].length > 500) {
      return cleanHtml(m[0]);
    }
  }
  // fallback: 全文清理（可能有导航杂质，但比啥都没强）
  return cleanHtml(html);
}

export interface Enrichment {
  ok: boolean;
  text: string;
  error?: string;
}

async function fetchOne(url: string): Promise<Enrichment> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const r = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: ctrl.signal,
      cf: { cacheTtl: 1800, cacheEverything: true } as RequestInitCfProperties,
    });
    clearTimeout(t);
    if (!r.ok) return { ok: false, text: "", error: `HTTP ${r.status}` };
    const html = await r.text();
    const text = extractBody(html);
    return { ok: text.length > 100, text };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, text: "", error: msg };
  }
}

// 并发抓 top-N 候选的全文。返回 url → enrichment 的 map
export async function enrichBatch(
  items: ScoredItem[],
  concurrency = CONCURRENCY,
): Promise<Map<string, Enrichment>> {
  const result = new Map<string, Enrichment>();
  const queue = items.map((it) => it.link);

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const url = queue.shift();
      if (!url) return;
      const enr = await fetchOne(url);
      result.set(url, enr);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return result;
}

// 把 enriched body 写回 item.description（让后续 classify / scorer / summarizer 透明用）
// 保留原 RSS description 作为 fallback（如果 enrichment 失败）
export function applyEnrichments(
  items: ScoredItem[],
  enrichments: Map<string, Enrichment>,
): ScoredItem[] {
  return items.map((it) => {
    const enr = enrichments.get(it.link);
    if (enr && enr.ok && enr.text.length > 0) {
      // description 字段被正文替换 — classify / tag 自动用更丰富的内容
      return { ...it, description: enr.text };
    }
    return it;
  });
}
