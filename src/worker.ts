// Cloudflare Worker 主入口
// 同时承担：cron (scheduled) + API (fetch) + 静态前端 fallback (ASSETS)

import type { Env, NewsItem, ScoredItem } from "./types";
import { SOURCES_CONFIG } from "./sources";
import { fetchAllSources } from "./fetcher";
import { scoreItem, dedupe, applyHardFilters } from "./scorer";
import {
  pickBySection,
  ensureSectionMinimum,
  detectCreSubcategory,
  classify,
  SECTIONS,
} from "./sections";
import { summarizeBatch } from "./summarizer";
import {
  loadSeen,
  pruneSeen,
  filterAlreadySeen,
  appendToSeen,
} from "./seen";
import { enrichBatch, applyEnrichments } from "./enricher";

// ===== KV keys =====
const K_LATEST = "latest";
const K_DAILY = (date: string) => `daily:${date}`;
const K_DATES = "dates"; // 历史日期列表
const K_SEEN = "seen:rolling"; // 跨日去重的滚动 21 天 seen list

// ===== 工具 =====
function todayUTC(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

async function pushDate(env: Env, date: string): Promise<void> {
  const raw = (await env.NEWS_KV.get(K_DATES)) ?? "[]";
  let dates: string[];
  try {
    dates = JSON.parse(raw);
  } catch {
    dates = [];
  }
  if (!dates.includes(date)) {
    dates.unshift(date);
    dates = dates.slice(0, 90); // 保留最近 90 天
    await env.NEWS_KV.put(K_DATES, JSON.stringify(dates));
  }
}

// ===== 核心 pipeline =====
export async function runPipeline(env: Env): Promise<{
  date: string;
  count: number;
  source_stats: Record<string, number>;
  errors: { source: string; error: string }[];
}> {
  const limit = Number(env.DAILY_LIMIT || "20");
  const sources = SOURCES_CONFIG.sources;

  // 1. 拉所有 feed
  const fetchResults = await fetchAllSources(sources);

  const errors: { source: string; error: string }[] = [];
  const sourceStats: Record<string, number> = {};
  const allItems = fetchResults.flatMap((r) => {
    if (r.error) errors.push({ source: r.source.name, error: r.error });
    sourceStats[r.source.id] = r.items.length;
    return r.items;
  });

  // 2. 打分 + 标签
  const now = Date.now();
  const scored = allItems.map((it) => scoreItem(it, now));

  // 3. 硬过滤 — 严格 24 小时窗（北京 9AM 为基准）
  const sourcesById = new Map(sources.map((s) => [s.id, s]));
  const filtered24h = applyHardFilters(scored, sourcesById, now, 24);
  // 7 天扩窗池 — 用于 section 保底（24h 内某 section 为空时回退）
  const filtered7d = applyHardFilters(scored, sourcesById, now, 24 * 7);

  // 4. 内部去重（含 entity-level — 同一事件的不同标题也能抓到）
  const deduped24h = dedupe(filtered24h);
  const deduped7d = dedupe(filtered7d);

  // 5. 跨日去重 — 把过去 21 天已经选过的 item 过滤掉
  const seenRaw = await env.NEWS_KV.get(K_SEEN);
  const seenAll = pruneSeen(loadSeen(seenRaw), now, 21);
  const fresh24h = filterAlreadySeen(deduped24h, seenAll, 0.7);
  const fresh7d = filterAlreadySeen(deduped7d, seenAll, 0.7);

  // 6. 文章正文 enrichment — 取 top-30 候选并发抓全文 HTML，提取 article body
  //    用更丰富正文重做 classify / 重新打分 / 给摘要器，质量大幅提升
  const candidates = fresh24h.sort((a, b) => b.score - a.score).slice(0, 30);
  const enrichments = await enrichBatch(candidates);
  const enriched = applyEnrichments(candidates, enrichments);
  // 用 enriched 内容重新 classify + 重新打分（关键 — body 比 RSS desc 更准）
  const rescored = enriched.map((it) => {
    const re = scoreItem(it, now); // 用 enriched description 重打分
    re.section = classify(re); // 用 enriched description 重新分类
    return re;
  });
  // 再次实体级去重（body 里的更多实体能抓到漏网的同事件）
  const rededuped = dedupe(rescored);

  // 7. 按 5 个 section 分类 + 配额挑选 → top 20
  const sectioned = pickBySection(rededuped, limit, 4);

  // 8. 保底：24h 内空的 section 从 7d 扩窗池补 1 条（标 extended_window=true）
  //    7d 池没 enrich — 这是边界 case 接受成本
  ensureSectionMinimum(sectioned, fresh7d);

  const top: ScoredItem[] = sectioned.flatMap((s) =>
    s.items.map((it) => {
      const out: ScoredItem = { ...it, section: s.section.id };
      if (s.section.id === "cre") out.cre_subcategory = detectCreSubcategory(it);
      return out;
    }),
  );

  // 6. 批量生成中文摘要
  let withSummary: NewsItem[];
  try {
    withSummary = await summarizeBatch(top, env.ANTHROPIC_API_KEY);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push({ source: "summarizer", error: msg });
    // 摘要失败也写入，标摘要为空 —— 总比没有强
    const fetchedAt = Date.now();
    withSummary = top.map((t) => ({
      ...t,
      id: simpleHash(t.link),
      title_zh: "",
      summary_zh: "（摘要生成失败，请查看英文原文）",
      importance: 3,
      impact: "neutral" as const,
      fetched_at: fetchedAt,
    }));
  }

  // 7. 写 KV
  const date = todayUTC();
  const payload = {
    date,
    generated_at: now,
    sources_attempted: sources.length,
    sources_ok: fetchResults.filter((r) => !r.error).length,
    sections: SECTIONS,
    items: withSummary,
  };
  await env.NEWS_KV.put(K_DAILY(date), JSON.stringify(payload), {
    expirationTtl: 60 * 60 * 24 * 90, // 90 天过期
  });
  await env.NEWS_KV.put(K_LATEST, JSON.stringify(payload));
  await pushDate(env, date);

  // 把今天选的 item 加入 seen list — 下次跑 pipeline 时跨日去重会用
  const updatedSeen = appendToSeen(seenAll, withSummary, date);
  const prunedSeen = pruneSeen(updatedSeen, now, 21);
  await env.NEWS_KV.put(K_SEEN, JSON.stringify(prunedSeen));

  return {
    date,
    count: withSummary.length,
    source_stats: sourceStats,
    errors,
    seen_carry_over: seenAll.length,
    seen_after_today: prunedSeen.length,
  };
}

function simpleHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ===== HTTP API =====
async function handleApi(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
  };

  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  if (path === "/api/news") {
    const date = url.searchParams.get("date");
    const key = date ? K_DAILY(date) : K_LATEST;
    const data = await env.NEWS_KV.get(key);
    if (!data)
      return new Response(JSON.stringify({ error: "no data yet", key }), {
        status: 404,
        headers: cors,
      });
    return new Response(data, { headers: cors });
  }

  if (path === "/api/dates") {
    const data = (await env.NEWS_KV.get(K_DATES)) ?? "[]";
    return new Response(data, { headers: cors });
  }

  if (path === "/api/sources") {
    return new Response(JSON.stringify(SOURCES_CONFIG), { headers: cors });
  }

  if (path === "/api/refresh") {
    // 手动触发 — 需要 secret
    const secret = url.searchParams.get("key");
    if (!env.REFRESH_SECRET || secret !== env.REFRESH_SECRET) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: cors,
      });
    }
    const result = await runPipeline(env);
    return new Response(JSON.stringify(result), { headers: cors });
  }

  return new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: cors,
  });
}

// ===== Worker entrypoint =====
export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const r = await runPipeline(env);
          console.log("[cron] OK", JSON.stringify(r));
        } catch (e) {
          console.error("[cron] FAIL", e);
        }
      })(),
    );
  },

  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) return handleApi(req, env);
    // 否则交给静态资源（前端）
    return env.ASSETS.fetch(req);
  },
};
