// 并发拉所有信源 — 单源失败不能影响整体

import type { RawItem, Source } from "./types";
import { parseFeed } from "./parser";

const FETCH_TIMEOUT_MS = 12000;

// 浏览器风格 UA — 不少 RSS 端点会拦截非浏览器 UA（Inman / Multi-Housing News 等）
const UA_BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// SEC.gov 强制要求 UA 里带 contact info（Sample Company AdminContact@sample.com 形式）
// 不带就 403。把它放在 sources.json 的 ua_style: "sec" 字段里触发
const UA_SEC = " Research News Agent contact@example.com";

function pickUA(source: Source, urlHost: string): string {
  if (source.ua_style === "sec" || urlHost.endsWith("sec.gov")) return UA_SEC;
  return UA_BROWSER;
}

async function fetchWithTimeout(source: Source, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const ua = pickUA(source, new URL(source.url).hostname);
    return await fetch(source.url, {
      headers: {
        "User-Agent": ua,
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: ctrl.signal,
      // Cloudflare 缓存：同一 feed 5 分钟内不重复请求
      cf: { cacheTtl: 300, cacheEverything: true } as RequestInitCfProperties,
    });
  } finally {
    clearTimeout(t);
  }
}

export interface FetchResult {
  source: Source;
  items: RawItem[];
  error?: string;
}

export async function fetchAllSources(sources: Source[]): Promise<FetchResult[]> {
  // SEC EDGAR 信源给的标题都是通用的 "8-K - Current report" — 没法分辨公司
  // 抓回来后给 title 前缀 ticker（INVH / AMH 等）让用户能直接看出主体
  const SEC_TICKER: Record<string, string> = {
    "sec-invh-8k": "INVH (Invitation Homes)",
    "sec-amh-8k": "AMH (American Homes 4 Rent)",
  };

  const tasks = sources.map(async (s): Promise<FetchResult> => {
    try {
      const r = await fetchWithTimeout(s, FETCH_TIMEOUT_MS);
      if (!r.ok) return { source: s, items: [], error: `HTTP ${r.status}` };
      const xml = await r.text();
      const items = parseFeed(xml, s);
      // SEC 标题前缀化
      const ticker = SEC_TICKER[s.id];
      if (ticker) {
        for (const it of items) it.title = `${ticker} ${it.title}`;
      }
      return { source: s, items };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { source: s, items: [], error: msg };
    }
  });
  return await Promise.all(tasks);
}
