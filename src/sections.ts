// 分类 — 把每条 item 分到 5 个 section 之一
// 优先级从上到下，第一个命中就停（避免一条同时进多个 section）
//
// 设计原则：
// - BTR 优先 — 这是用户最核心的信号，命中 BTR/SFR 关键词或运营商名直接归 btr
// - 机构资本流向次之 — PE/REIT 募资 / IPO / 大宗 M&A
// - Sunbelt 住宅 — Texas/Sun Belt 城市 + 住宅域，但排除明显的 CRE
// - CRE — 工业/办公/数据中心/仓储 等 CRE 资产
// - 全国住宅 — fallback，宏观 / 利率 / 全国数据 也归这里

import type { ScoredItem } from "./types";

export type SectionId = "btr" | "institutional" | "sunbelt" | "cre" | "national";

export interface SectionDef {
  id: SectionId;
  label: string;
  emoji: string;
  description: string;
  quota: number;
  maxPerSource?: number;
  // 是否强制至少有一条命中德州三城 (DFW / Houston / Austin)
  // 全国住宅 section 不要求；其他 4 个都要求 — 保证  视角永远有德州落地内容
  texasCityRequired?: boolean;
}

// 顺序：全国住宅 → Sunbelt → BTR → CRE → 机构资本（后 4 个 section 强制德州三城保底）
export const SECTIONS: SectionDef[] = [
  {
    id: "national",
    label: "全国住宅市场",
    emoji: "🏠",
    description: "全国住宅市场、宏观利率、政策、NAR / Realtor / Zillow / Calculated Risk",
    quota: 5,
    maxPerSource: 2,
  },
  {
    id: "sunbelt",
    label: "Sunbelt 住宅",
    emoji: "🌵",
    description: "Sun Belt 各州住宅与租赁市场 — 至少一条德州三城",
    quota: 4,
    maxPerSource: 2,
    texasCityRequired: true,
  },
  {
    id: "btr",
    label: "全国 BTR / SFR",
    emoji: "🏘",
    description: "Build-to-Rent / Single-Family Rental — 至少一条德州三城",
    quota: 3,
    maxPerSource: 2,
    texasCityRequired: true,
  },
  {
    id: "cre",
    label: "全国 CRE",
    emoji: "🏢",
    description: "办公 / 工业 / 数据中心 / 仓储等 CRE — 至少一条德州三城",
    quota: 5,
    maxPerSource: 2,
    texasCityRequired: true,
  },
  {
    id: "institutional",
    label: "全国机构资本",
    emoji: "💰",
    description: "PE / REIT 募资、并购、IPO、机构持仓 — 至少一条德州三城",
    quota: 3,
    maxPerSource: 2,
    texasCityRequired: true,
  },
];

const RE_BTR =
  /\b(btr|build[-\s]?to[-\s]?rent|sfr|single[-\s]?family\s+rental|invitation\s+homes|american\s+homes\s+4\s+rent|tricon|pretium|progress\s+residential|home\s+partners|nrhc|rental\s+home\s+council)\b/i;

const RE_INST =
  /\b(blackstone|kkr|brookfield|starwood|tpg|pgim|nuveen|cohen\s*(?:&|and)\s*steers|principal\s+real\s+estate|pere|fundraising|fundraise|major\s+fundraising|capital\s+raise|lp\s+commitment|gp\s+stake|reit\s+ipo|secondary\s+sale|continuation\s+vehicle|allocator|institutional\s+investor|private\s+real\s+estate)\b/i;

const RE_SUNBELT =
  /\b(texas|houston|dallas|fort\s+worth|dfw|austin|san\s+antonio|phoenix|arizona|atlanta|georgia|charlotte|nashville|tennessee|tampa|miami|orlando|jacksonville|florida|raleigh|charleston|sun\s*belt|sunbelt)\b/i;

const RE_RESIDENTIAL =
  /\b(housing|home(?:s|owner)?|landlord|rental|rent\s|mortgage|residential|multifamily|apartment|single[-\s]?family)\b/i;

// 注：CRE 现在按行业惯例覆盖 multifamily / hotel / retail / office / industrial / data-center 等
// 这些品类共享 CRE 资本市场逻辑（capital markets / cap rate / 大宗交易）
const RE_CRE =
  /\b(industrial|office|data\s+center|warehouse|warehousing|logistics\s+center|sf\s+industrial|sf\s+office|sf\s+lease|commercial\s+real\s+estate|\bcre\b|class\s+a\s+office|cap\s+rate|headquarters|\bhq\b|academic\s+project|life\s+sciences|retail\s+center|\bretail\b|hotel|hospitality|lodging|multifamily|apartment\s+(?:building|community)|rental\s+market|landlords?|rental\s+(?:property|properties|portfolio|housing|losses))\b/i;

// 按行业惯例：multifamily / hotel / retail / office / industrial / data-center 都归 CRE
// 全国住宅 section 仅留：单户 housing 市场、宏观 / 利率 / 政策（无具体 CRE asset class）
// Sunbelt section：Sun Belt 地理 + residential 域（含 multifamily / btr-sfr / housing），优先级在 CRE 之前
const HOMEBUILDER_RE = /\b(homebuilder|home\s+builder|starts\s+sales|new\s+homes\s+at|townhomes?|breaks\s+ground|grand\s+opening)\b/i;
// 注：mixed-asset 不在此列 — mixed-asset 是兜底 tag（无具体资产），不应让宏观/利率文章误归 CRE
const CRE_ASSET_TAGS = ["multifamily", "office", "industrial", "data-center", "hotel", "retail"];

// CRE 主导信源 — 其文章 title 不含明确 CRE 词时也按 CRE 处理
// 这些信源主要写 CRE / 大宗交易 / 多户 — 默认 leaning 是 CRE 而非 residential
const CRE_LEANING_SOURCES = new Set([
  "bisnow",
  "trd-national",
  "connect-cre",
  "rebusiness-online",
  "multi-housing-news",
  "multifamily-dive",
  "yardi-matrix",
]);

export function classify(item: ScoredItem): SectionId {
  // 分类决策只看 title — 正文（描述/全文）太宽容易把"reverse mortgage 提到 rental property"
  // 这种文章误归 CRE。tag / score / summary 仍然吃全文，分类不吃。
  const titleLow = item.title.toLowerCase();
  const text = titleLow; // 兼容下面 sb / res 等命名

  // 1. BTR / SFR
  if (RE_BTR.test(titleLow)) return "btr";

  // 2. 机构资本流向（PERE / SEC EDGAR / 关键词命中 — 仅 title）
  if (
    RE_INST.test(titleLow) ||
    item.source_id === "pere-news" ||
    item.source_id === "sec-invh-8k" ||
    item.source_id === "sec-amh-8k" ||
    item.source_id === "pretium-partners"
  ) {
    return "institutional";
  }

  // 3. Sunbelt 住宅 — 标题里出现 Sun Belt 地名 + residential 域
  //    OR 信源 region=texas + 标题含住宅关键词
  //    避免"全国会议在 Knoxville 召开"这种 description 提及就误归 Sunbelt
  const titleLower = item.title.toLowerCase();
  const TITLE_CRE_RE = /\b(industrial|office|data\s+center|warehouse|warehousing|logistics|\bhq\b|headquarters|hotel|hospitality|retail\s+center|life\s+sciences)\b/i;
  const titleHasCRE = TITLE_CRE_RE.test(titleLower);
  const titleHasSunbeltGeo = RE_SUNBELT.test(titleLower);
  const titleHasResidential = RE_RESIDENTIAL.test(titleLower);
  // 注：isResidentialAsset 看 title + 主动加的 multifamily/btr-sfr tag
  // 不接受 housing tag — housing 是兜底 fallback 容易误加
  const isResidentialAsset =
    RE_RESIDENTIAL.test(titleLow) ||
    item.tags.includes("multifamily") ||
    item.tags.includes("btr-sfr");
  // 路径 A：标题里出现 Sun Belt 地名 + 整体属于 residential 域
  // 路径 B：信源是 texas 区域源（D Mag / Houston Agent / TRERC）+ 标题里有住宅关键词
  const sunbeltMatch =
    (titleHasSunbeltGeo && isResidentialAsset) ||
    (item.region === "texas" && titleHasResidential);
  if (sunbeltMatch && !titleHasCRE) return "sunbelt";

  // 4. CRE — title 含 CRE asset class OR 信源是 CRE 主导
  // 不再用 body-derived tag 兜底（body 太宽容易污染分类）
  // 排除 homebuilder（新房社区开盘归 housing）
  const isHomebuilder = HOMEBUILDER_RE.test(titleLow);
  if (!isHomebuilder) {
    if (RE_CRE.test(titleLow)) return "cre";
    if (CRE_LEANING_SOURCES.has(item.source_id)) return "cre";
  }

  // 5. 全国住宅 — 单户 housing / 宏观 / 利率 / 政策 fallback
  return "national";
}

// 按 section 配额挑选 top items，受 per-source 上限约束
// 算法：
// 1. 先按 score 从高到低把所有 item 装进各自 section 的 bucket
// 2. 每个 section 拿 quota 条（受 per-source cap）
// 3. 余下名额（slack）按 score 顺序补给那些有更多候选的 section
// CRE 子类型识别 — 只看 title，避免 body 里偶现关键词误判
export function detectCreSubcategory(item: ScoredItem): string | null {
  const t = item.title.toLowerCase();
  if (/data\s+center/.test(t)) return "数据中心";
  if (/life\s+sciences/.test(t)) return "生命科学";
  if (/warehouse|warehousing|logistics/.test(t)) return "仓储 / 物流";
  if (/industrial/.test(t)) return "工业";
  if (/\boffice\b|class\s+a\s+office|headquarters|\bhq\b/.test(t)) return "办公";
  if (/retail\s+center|\bretail\b/.test(t)) return "零售";
  if (/hotel|hospitality/.test(t)) return "酒店";
  if (/multifamily|apartment\s+building/.test(t)) return "多户";
  return null;
}

// 判断一条 item 是否命中德州三城（DFW / Houston / Austin）
const RE_TX3 = /\b(dfw|dallas|fort\s+worth|houston|austin)\b/i;
function hitsTexasCity(it: ScoredItem): boolean {
  if ((it.tags ?? []).some((t) => t === "dfw" || t === "houston" || t === "austin")) return true;
  return RE_TX3.test(`${it.title} ${it.description}`);
}

// 后处理：保证每个 texasCityRequired 的 section 内至少有一条德州三城内容
// 优先级：
//   (1) 同 section bucket 里找德州三城候选
//   (2) 不行就跨 bucket 找一条"主题贴合该 section + 命中德州三城"的 item
//       — 比如机构资本 section 没德州时，从全候选池找命中 dfw/houston/austin 且打了 institutional tag 的
function ensureTexasCity(
  result: { section: SectionDef; items: ScoredItem[] }[],
  buckets: Map<SectionId, ScoredItem[]>,
  allCandidates: ScoredItem[],
): void {
  // 给每个 section 准备一个"主题相关性"判断器（用于跨 bucket 德州保底）
  // 注：matcher 用 title — 跟 classify 一致，避免 body 误带的关键词污染
  const sectionMatcher: Record<SectionId, (it: ScoredItem) => boolean> = {
    btr: (it) => RE_BTR.test(it.title),
    institutional: (it) => {
      const ti = it.title.toLowerCase();
      return RE_INST.test(ti) || (it.tags ?? []).includes("institutional");
    },
    cre: (it) => {
      if (RE_CRE.test(it.title)) return true;
      const t = it.tags ?? [];
      return ["office", "industrial", "data-center", "retail", "hotel"].some((x) => t.includes(x));
    },
    // Sunbelt 保底：必须是 residential（不接受 SpaceX chip 工厂这种纯 TX-CRE 内容）
    sunbelt: (it) => {
      const ti = it.title.toLowerCase();
      return RE_RESIDENTIAL.test(ti) ||
        (it.tags ?? []).includes("multifamily") ||
        (it.tags ?? []).includes("btr-sfr");
    },
    national: () => true,
  };

  for (const r of result) {
    if (!r.section.texasCityRequired) continue;
    if (r.items.some(hitsTexasCity)) continue;

    const pickedLinks = new Set(r.items.map((x) => x.link));
    let candidate: ScoredItem | undefined;

    // 优先级 1：同 section bucket
    const bucket = buckets.get(r.section.id) ?? [];
    candidate = bucket
      .filter((it) => !pickedLinks.has(it.link) && hitsTexasCity(it))
      .sort((a, b) => b.score - a.score)[0];

    // 优先级 2：跨 bucket，找主题贴合 + 德州三城
    if (!candidate) {
      const matcher = sectionMatcher[r.section.id];
      candidate = allCandidates
        .filter((it) => !pickedLinks.has(it.link) && hitsTexasCity(it) && matcher(it))
        // 也排除已被其他 section 选过的（避免重复）
        .filter((it) => !result.some((rr) => rr.items.some((x) => x.link === it.link)))
        .sort((a, b) => b.score - a.score)[0];
    }

    if (!candidate) continue;

    // 替换最低分的非德州 item；若全部已是德州则直接 push
    let lowestIdx = -1;
    let lowestScore = Infinity;
    for (let i = 0; i < r.items.length; i++) {
      if (hitsTexasCity(r.items[i])) continue;
      if (r.items[i].score < lowestScore) {
        lowestScore = r.items[i].score;
        lowestIdx = i;
      }
    }
    if (lowestIdx >= 0) r.items[lowestIdx] = candidate;
    else r.items.push(candidate);
  }
}

export function pickBySection(
  items: ScoredItem[],
  totalLimit: number,
  globalMaxPerSource = 4,
): { section: SectionDef; items: ScoredItem[] }[] {
  const sorted = [...items].sort((a, b) => b.score - a.score);

  // 装桶
  const buckets = new Map<SectionId, ScoredItem[]>();
  for (const s of SECTIONS) buckets.set(s.id, []);
  for (const it of sorted) buckets.get(classify(it))!.push(it);

  // 第一轮：每 section 取 quota 条；既受 section 内 per-source 上限限制，也受全局 per-source 上限限制
  const globalCounts = new Map<string, number>();
  const sectionSourceCounts = new Map<SectionId, Map<string, number>>();
  for (const s of SECTIONS) sectionSourceCounts.set(s.id, new Map());

  const tryTake = (
    section: SectionDef,
    candidates: ScoredItem[],
    taken: ScoredItem[],
  ) => {
    const sectMap = sectionSourceCounts.get(section.id)!;
    const sectCap = section.maxPerSource ?? globalMaxPerSource;
    for (const it of candidates) {
      if (taken.length >= section.quota) break;
      if (taken.some((x) => x.link === it.link)) continue;
      const sectCount = sectMap.get(it.source_id) ?? 0;
      if (sectCount >= sectCap) continue;
      const globCount = globalCounts.get(it.source_id) ?? 0;
      if (globCount >= globalMaxPerSource) continue;
      taken.push(it);
      sectMap.set(it.source_id, sectCount + 1);
      globalCounts.set(it.source_id, globCount + 1);
    }
  };

  const result = SECTIONS.map((section) => {
    const taken: ScoredItem[] = [];
    tryTake(section, buckets.get(section.id)!, taken);
    return { section, items: taken };
  });

  // 第二轮 slack：补到 totalLimit
  const reachedTotal = () =>
    result.reduce((sum, r) => sum + r.items.length, 0) >= totalLimit;

  let progress = true;
  while (!reachedTotal() && progress) {
    progress = false;
    for (const r of result) {
      if (reachedTotal()) break;
      const before = r.items.length;
      // 临时放宽 quota，让 tryTake 多塞一条
      const expanded = { ...r.section, quota: r.items.length + 1 };
      tryTake(expanded, buckets.get(r.section.id)!, r.items);
      if (r.items.length > before) progress = true;
    }
  }

  // 最后一步：德州三城保底（替换最低分非德州 item，不增加总数）
  ensureTexasCity(result, buckets, items);

  return result;
}

// 当 24h 窗内某 section 为空时，从 7d 扩展池里补一条最高分的 — 标 extended_window=true
// 调用时机：pickBySection 之后，summarize 之前
export function ensureSectionMinimum(
  result: { section: SectionDef; items: ScoredItem[] }[],
  fallbackPool: ScoredItem[], // 7d 窗 + 已 dedupe + 已跨日去重的池
): void {
  const allPickedLinks = new Set<string>();
  for (const r of result) for (const it of r.items) allPickedLinks.add(it.link);

  for (const r of result) {
    if (r.items.length > 0) continue;
    const candidate = fallbackPool
      .filter((it) => classify(it) === r.section.id)
      .filter((it) => !allPickedLinks.has(it.link))
      .sort((a, b) => b.score - a.score)[0];
    if (!candidate) continue;
    r.items.push({ ...candidate, extended_window: true });
    allPickedLinks.add(candidate.link);
  }
}
