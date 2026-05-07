// 打分 + 标签 — 决定一条 item 进不进 daily top 20

import type { RawItem, ScoredItem } from "./types";
import { isSameStory } from "./seen";

// 热度关键词 — 命中了说明这条 item 跟我们的研究核心相关，加分
// 分三组：核心命中 (+5)、次核心 (+3)、宏观信号 (+2)
const HOT_CORE = [
  "build-to-rent",
  "btr",
  " sfr",
  "single-family rental",
  "single family rental",
  "invitation homes",
  "american homes 4 rent",
  "amh",
  "tricon",
  "progress residential",
];
const HOT_REGIONAL = [
  "texas",
  "houston",
  "dallas",
  "fort worth",
  "dfw",
  "austin",
  "san antonio",
  "sun belt",
];
const HOT_MACRO = [
  "fed",
  "fomc",
  "rate cut",
  "rate hike",
  "inflation",
  "mortgage rate",
  "30-year fixed",
  "case-shiller",
  "case shiller",
  "existing home sales",
  "pending home sales",
  "new home sales",
  "housing starts",
  "permits",
  "freddie mac",
  "fannie mae",
];
const HOT_INSTITUTIONAL = [
  "blackrock",
  "blackstone",
  "kkr",
  "brookfield",
  "starwood",
  "cohen & steers",
  "cohen and steers",
  "pgim",
  "nuveen",
  "principal real estate",
  "btr fund",
];

// 趋势 / 行业分析 / 数据发布类 — 比单笔交易新闻更值得放进 daily top 20
const HOT_TREND = [
  "outlook",
  "forecast",
  "trend",
  "trends",
  "annual",
  "year-end",
  " yoy",
  "year over year",
  "year-over-year",
  "what to expect",
  "state of the market",
  "state of the housing",
  "housing market",
  "rental market",
  "case-shiller",
  "case shiller",
  "existing-home sales",
  "existing home sales",
  "pending home sales",
  "new home sales",
  "housing starts",
  "construction spending",
  "fhfa house price",
  "primary mortgage market survey",
  "weekly applications",
  "rent growth",
  "occupancy",
  "vacancy",
  "what's next",
  "outlook 2026",
  "2026 outlook",
];

// 次要标签的反向命中 — 如果 title 完全不沾边，扣分
const NEGATIVE_NOISE = [
  "celebrity",
  "kardashian",
  "kanye",
  "taylor swift",
  "luxury mansion",
  "haunted",
  "weirdest",
];

const lower = (s: string) => s.toLowerCase();

function hits(text: string, keywords: string[]): string[] {
  const t = lower(text);
  return keywords.filter((k) => t.includes(k));
}

export function scoreItem(item: RawItem, now: number): ScoredItem {
  const text = `${item.title} ${item.description}`;
  const heatCore = hits(text, HOT_CORE);
  const heatRegional = hits(text, HOT_REGIONAL);
  const heatMacro = hits(text, HOT_MACRO);
  const heatInst = hits(text, HOT_INSTITUTIONAL);
  const negative = hits(text, NEGATIVE_NOISE);

  // 1. 信源权重 (1-10)
  let score = item.source_weight;

  // 2. 时效性 — 越新越好。0h: +6, 24h: +4, 48h: +2, 72h+: +0
  const ageH = (now - item.published_at) / 1000 / 3600;
  if (item.published_at > 0) {
    if (ageH < 6) score += 6;
    else if (ageH < 24) score += 4;
    else if (ageH < 48) score += 2;
    else if (ageH < 72) score += 1;
    else if (ageH > 168) score -= 3; // > 1 周老 item 不要
  } else {
    // 没有 pub_date — 给个默认中性分
    score += 1;
  }

  // 3. 关键词热度
  // 规则口径：行业/趋势/数据 比 单笔交易/区域 重要
  // 区域权重不高（×1）— 让 section 配额负责地理多样性，避免 score 层面把 Texas 单笔交易顶到全国 trend 上面
  score += heatCore.length * 5;
  score += heatRegional.length * 1;
  score += heatMacro.length * 2;
  score += heatInst.length * 4;
  const heatTrend = hits(text, HOT_TREND);
  score += heatTrend.length * 3;

  // 4. 噪声扣分
  score -= negative.length * 4;

  // 5. 长度惩罚 — 标题太短可能是占位
  if (item.title.length < 20) score -= 2;

  // 6. 自动推断标签 — 基于 canonical IDs (见 src/tags.ts)
  // 4 个维度同时贯彻：资产 / 地理 / 主题 / 主体
  const autoTags = new Set<string>(item.source_tags);
  const tlow = lower(text);

  // ---- 资产类别 (asset) ----
  if (/data\s+center/.test(tlow)) autoTags.add("data-center");
  if (/warehouse|warehousing|logistics\s+center/.test(tlow)) autoTags.add("industrial");
  if (/\bindustrial\b/.test(tlow)) autoTags.add("industrial");
  if (/\boffice\b|class\s+a\s+office|headquarters|\bhq\b/.test(tlow)) autoTags.add("office");
  if (/multifamily|apartment\s+(?:building|community)|\bapartments?\b/.test(tlow)) autoTags.add("multifamily");
  if (heatCore.length > 0) autoTags.add("btr-sfr");
  // 全国住宅市场关键词
  if (/\b(housing\s+market|new\s+home\s+sales|existing\s+home\s+sales|home\s+sales|homebuyer|home\s+price|residential\s+market|housing\s+starts|mortgage\s+rate|home\s+inventory)\b/.test(tlow)) autoTags.add("housing");
  if (/hotel|hospitality|lodging/.test(tlow)) autoTags.add("hotel");
  if (/retail\s+center|shopping\s+center/.test(tlow)) autoTags.add("retail");

  // ---- 地理 (geo) ----
  if (heatRegional.length > 0) autoTags.add("texas");
  if (tlow.includes("houston")) autoTags.add("houston");
  if (/\bdallas\b|fort\s+worth|\bdfw\b/.test(tlow)) autoTags.add("dfw");
  if (tlow.includes("austin")) autoTags.add("austin");
  if (/sun\s*belt|sunbelt/.test(tlow)) autoTags.add("sun-belt");
  if (/manhattan|brooklyn|new\s+york\s+city|\bnyc\b/.test(tlow)) autoTags.add("nyc");
  if (/\bcalifornia\b|\b(los\s+angeles|san\s+francisco|orange\s+county|bay\s+area)\b/.test(tlow)) autoTags.add("california");

  // ---- 主题 (topic) ----
  if (heatMacro.length > 0) autoTags.add("macro");
  if (/mortgage\s+rate|interest\s+rate|\bfed\s+rate|rate\s+(?:cut|hike)|\bbps\b|30[-\s]year|6\.\d%/.test(tlow))
    autoTags.add("rates");
  if (/legislat|regulat|senate|house\s+(?:bill|members)|congress|hud\b|fhfa|policy/.test(tlow))
    autoTags.add("policy");
  if (/\b(acquisition|acquires?|sells?\b|sale\b|merger|m&a|ipo|fundrais|raised\s+\$|leas(?:e|es|ing)|signs|negotiates|loan|refinanc)/.test(tlow))
    autoTags.add("deals");
  if (heatTrend.length > 0) autoTags.add("trend");
  if (/case[-\s]shiller|existing\s+home\s+sales|pending\s+home\s+sales|new\s+home\s+sales|housing\s+starts|jolts|primary\s+mortgage\s+market\s+survey|fhfa\s+house\s+price/.test(tlow))
    autoTags.add("data");
  if (/\bquarterly|earnings|q[1-4]\s|first\s+quarter|second\s+quarter|third\s+quarter|fourth\s+quarter/.test(tlow))
    autoTags.add("earnings");

  // ---- 主体 (actor) ----
  if (heatInst.length > 0) autoTags.add("institutional");
  if (/\b(lennar|d\.?r\.?\s+horton|kb\s+home|toll\s+brothers|pulte|ashton\s+woods|meritage|taylor\s+morrison|homebuilder)\b/.test(tlow))
    autoTags.add("homebuilder");
  if (/\blandlord|property\s+owner/.test(tlow)) autoTags.add("landlord");
  if (/\b(broker|brokerage|realtor|mls)\b/.test(tlow)) autoTags.add("brokerage");
  if (/\b(federal\s+reserve|fomc|hud|fhfa|treasury\s+department|cfpb)\b/.test(tlow))
    autoTags.add("regulator");

  // 资产维度收尾
  const SPECIFIC_ASSETS = ["multifamily","btr-sfr","office","industrial","data-center","retail","hotel","housing"];
  const hasSpecific = SPECIFIC_ASSETS.some((a) => autoTags.has(a));
  // 1) 有具体资产类时，剔除 mixed-asset 冗余
  if (hasSpecific && autoTags.has("mixed-asset")) autoTags.delete("mixed-asset");
  // 2) 啥都没有时，根据 source region 兜底 — texas 区域源默认 housing；其他默认 mixed-asset
  const ASSET_IDS = [...SPECIFIC_ASSETS, "mixed-asset"];
  if (!ASSET_IDS.some((a) => autoTags.has(a))) {
    autoTags.add(item.region === "texas" ? "housing" : "mixed-asset");
  }

  return {
    ...item,
    score: Math.round(score * 100) / 100,
    tags: Array.from(autoTags),
    heat_signals: [...heatCore, ...heatRegional, ...heatMacro, ...heatInst, ...heatTrend],
  };
}

// 去重：两层
// 1) 严格 URL 相同 — 保留 source_weight 最高 / 最近发布
// 2) 标题模糊相似 (Jaccard ≥ 0.5) — 保留 source_weight 最高 / 最近发布
// 这样 Bisnow / TRD / HousingWire 同一条新闻 → 自动收敛到信源权重最高那条
const isBetterCandidate = (a: ScoredItem, b: ScoredItem): boolean => {
  if (a.source_weight !== b.source_weight) return a.source_weight > b.source_weight;
  if (a.published_at !== b.published_at) return a.published_at > b.published_at;
  return a.score > b.score;
};

export function dedupe(items: ScoredItem[], jaccardThreshold = 0.5): ScoredItem[] {
  // Pass 1: URL 完全相同
  const byUrl = new Map<string, ScoredItem>();
  for (const it of items) {
    const cur = byUrl.get(it.link);
    if (!cur || isBetterCandidate(it, cur)) byUrl.set(it.link, it);
  }
  const urlDeduped = Array.from(byUrl.values());

  // Pass 2: token Jaccard 或 实体级 fingerprint 命中 → 视为同一新闻
  // 实体级的存在是为了抓"Cleary Gottlieb downsizing 475K SF" vs "Cleary Gottlieb signs 475K SF renewal"
  // 这种同一事件的不同标题 — token Jaccard 漏掉但 entity overlap 能抓到
  type Group = { rep: ScoredItem; members: ScoredItem[] };
  const groups: Group[] = [];
  for (const it of urlDeduped) {
    let placed = false;
    for (const g of groups) {
      if (isSameStory(it, g.rep, jaccardThreshold)) {
        g.members.push(it);
        if (isBetterCandidate(it, g.rep)) g.rep = it;
        placed = true;
        break;
      }
    }
    if (!placed) groups.push({ rep: it, members: [it] });
  }
  return groups.map((g) => g.rep);
}

// 硬过滤：超出时间窗的 item 不要；filter_required 信源还要命中关键词
// 默认 24 小时 — 对应"以触发时刻为基准、筛选过去 24 小时新闻"
const HOUSING_KEYWORDS = [
  "housing", "home", "rental", "rent", "mortgage", "real estate", "btr",
  "single-family", "multifamily", "apartment", "homeowner", "fhfa", "freddie",
  "fannie", "fed rate", "construction", "homebuilder", "zillow", "redfin",
];

export function applyHardFilters(
  items: ScoredItem[],
  sourcesById: Map<string, { filter_required?: boolean }>,
  now: number,
  maxAgeHours = 24,
): ScoredItem[] {
  const cutoff = now - maxAgeHours * 3600 * 1000;
  return items.filter((it) => {
    // 没有 pub_date 的：保留（兜底，让信源权重决定）
    if (it.published_at > 0 && it.published_at < cutoff) return false;

    const s = sourcesById.get(it.source_id);
    if (s?.filter_required) {
      const text = `${it.title} ${it.description}`.toLowerCase();
      const hit = HOUSING_KEYWORDS.some((k) => text.includes(k));
      if (!hit) return false;
    }
    return true;
  });
}

// 多样性约束：单一信源不能超过 5 条 / 单一 tier 不能超过 60%
export function diversify(items: ScoredItem[], limit: number): ScoredItem[] {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const sourceCounts = new Map<string, number>();
  const out: ScoredItem[] = [];
  const maxPerSource = Math.max(2, Math.ceil(limit / 5));
  for (const item of sorted) {
    if (out.length >= limit) break;
    const c = sourceCounts.get(item.source_id) ?? 0;
    if (c >= maxPerSource) continue;
    out.push(item);
    sourceCounts.set(item.source_id, c + 1);
  }
  // 如果不够 limit（信源覆盖不足），放宽再补
  if (out.length < limit) {
    for (const item of sorted) {
      if (out.length >= limit) break;
      if (out.some((x) => x.link === item.link)) continue;
      out.push(item);
    }
  }
  return out;
}
