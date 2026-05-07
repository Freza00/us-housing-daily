#!/usr/bin/env node
// Local dry-run — 不部署 worker 也能跑一遍完整 pipeline
// 用途：开发期验证信源 / 打分 / 标签
// 使用：
//   node scripts/dry-run.mjs                 # 仅抓取+打分，不调 LLM
//   ANTHROPIC_API_KEY=sk-... node scripts/dry-run.mjs --summarize
//   node scripts/dry-run.mjs --json > out.json

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config/sources.json"), "utf8"));

// ---- 简易 RSS 解析器（与 src/parser.ts 同逻辑的 JS 版本）----
const decode = (s) =>
  String(s ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;|&#8217;|&#8216;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const firstMatch = (s, re) => {
  const m = s.match(re);
  return m ? m[1] : "";
};

function parseFeed(xml, source) {
  const isAtom = /<feed[\s>]/i.test(xml);
  const items = [];
  if (isAtom) {
    const re = /<entry\b[\s\S]*?<\/entry>/gi;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const b = m[0];
      const title = decode(firstMatch(b, /<title[^>]*>([\s\S]*?)<\/title>/i));
      const link =
        firstMatch(b, /<link[^>]*?href=["']([^"']+)["'][^>]*?\/?>/i) ||
        firstMatch(b, /<link[^>]*>([\s\S]*?)<\/link>/i);
      const desc = decode(
        firstMatch(b, /<summary[^>]*>([\s\S]*?)<\/summary>/i) ||
          firstMatch(b, /<content[^>]*>([\s\S]*?)<\/content>/i),
      );
      const pub =
        firstMatch(b, /<published[^>]*>([\s\S]*?)<\/published>/i) ||
        firstMatch(b, /<updated[^>]*>([\s\S]*?)<\/updated>/i);
      if (!title || !link) continue;
      items.push(makeItem(source, title, link, desc, pub));
    }
  } else {
    const re = /<item\b[\s\S]*?<\/item>/gi;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const b = m[0];
      const title = decode(firstMatch(b, /<title[^>]*>([\s\S]*?)<\/title>/i));
      const link = decode(firstMatch(b, /<link[^>]*>([\s\S]*?)<\/link>/i));
      const desc = decode(
        firstMatch(b, /<description[^>]*>([\s\S]*?)<\/description>/i) ||
          firstMatch(b, /<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i),
      );
      const pub =
        firstMatch(b, /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) ||
        firstMatch(b, /<dc:date[^>]*>([\s\S]*?)<\/dc:date>/i);
      if (!title || !link) continue;
      items.push(makeItem(source, title, link, desc, pub));
    }
  }
  return items;
}

function makeItem(source, title, link, desc, pub) {
  const t = pub ? Date.parse(pub) : NaN;
  return {
    source_id: source.id,
    source_name: source.name,
    source_tier: source.tier,
    source_weight: source.weight,
    source_tags: source.tags,
    region: source.region,
    title,
    link: link.trim(),
    description: desc.slice(0, 600),
    published_at: isNaN(t) ? 0 : t,
  };
}

// ---- scoring ----
const HOT_CORE = ["build-to-rent", "btr", " sfr", "single-family rental", "single family rental",
                  "invitation homes", "american homes 4 rent", "amh", "tricon", "progress residential"];
const HOT_REGIONAL = ["texas", "houston", "dallas", "fort worth", "dfw", "austin", "san antonio", "sun belt"];
const HOT_MACRO = ["fed", "fomc", "rate cut", "rate hike", "inflation", "mortgage rate", "30-year fixed",
                   "case-shiller", "case shiller", "existing home sales", "pending home sales",
                   "new home sales", "housing starts", "permits", "freddie mac", "fannie mae"];
const HOT_INST = ["blackrock", "blackstone", "kkr", "brookfield", "starwood", "cohen & steers",
                  "cohen and steers", "pgim", "nuveen", "principal real estate", "btr fund"];
const HOT_TREND = ["outlook", "forecast", "trend", "trends", "annual", "year-end", " yoy",
                   "year over year", "year-over-year", "what to expect", "state of the market",
                   "state of the housing", "housing market", "rental market", "case-shiller",
                   "existing-home sales", "pending home sales", "new home sales", "housing starts",
                   "construction spending", "fhfa house price", "primary mortgage market survey",
                   "weekly applications", "rent growth", "occupancy", "vacancy",
                   "what's next", "outlook 2026", "2026 outlook"];
const NEG = ["celebrity", "kardashian", "kanye", "taylor swift", "luxury mansion", "haunted", "weirdest"];

const lower = (s) => s.toLowerCase();
const hits = (text, kws) => { const t = lower(text); return kws.filter(k => t.includes(k)); };

function scoreItem(item, now) {
  const text = `${item.title} ${item.description}`;
  const hc = hits(text, HOT_CORE);
  const hr = hits(text, HOT_REGIONAL);
  const hm = hits(text, HOT_MACRO);
  const hi = hits(text, HOT_INST);
  const ht = hits(text, HOT_TREND);
  const neg = hits(text, NEG);

  let score = item.source_weight;
  const ageH = item.published_at ? (now - item.published_at) / 3600_000 : null;
  if (ageH === null) score += 1;
  else if (ageH < 6) score += 6;
  else if (ageH < 24) score += 4;
  else if (ageH < 48) score += 2;
  else if (ageH < 72) score += 1;
  else if (ageH > 168) score -= 3;

  // 区域权重压低 (×1)、加入 trend (×3) — CRE/全国 trend 不再被 Texas 单笔交易顶下去
  score += hc.length * 5 + hr.length * 1 + hm.length * 2 + hi.length * 4 + ht.length * 3 - neg.length * 4;
  if (item.title.length < 20) score -= 2;

  // 4 维度 canonical IDs (见 src/tags.ts)
  const tags = new Set(item.source_tags);
  const tlow = lower(text);
  // 资产
  if (/data\s+center/.test(tlow)) tags.add("data-center");
  if (/warehouse|warehousing|logistics\s+center/.test(tlow)) tags.add("industrial");
  if (/\bindustrial\b/.test(tlow)) tags.add("industrial");
  if (/\boffice\b|class\s+a\s+office|headquarters|\bhq\b/.test(tlow)) tags.add("office");
  if (/multifamily|apartment\s+(?:building|community)|\bapartments?\b/.test(tlow)) tags.add("multifamily");
  if (hc.length) tags.add("btr-sfr");
  if (/\b(housing\s+market|new\s+home\s+sales|existing\s+home\s+sales|home\s+sales|homebuyer|home\s+price|residential\s+market|housing\s+starts|mortgage\s+rate|home\s+inventory)\b/.test(tlow)) tags.add("housing");
  if (/hotel|hospitality|lodging/.test(tlow)) tags.add("hotel");
  if (/retail\s+center|shopping\s+center/.test(tlow)) tags.add("retail");
  // 地理
  if (hr.length) tags.add("texas");
  if (tlow.includes("houston")) tags.add("houston");
  if (/\bdallas\b|fort\s+worth|\bdfw\b/.test(tlow)) tags.add("dfw");
  if (tlow.includes("austin")) tags.add("austin");
  if (/sun\s*belt|sunbelt/.test(tlow)) tags.add("sun-belt");
  if (/manhattan|brooklyn|new\s+york\s+city|\bnyc\b/.test(tlow)) tags.add("nyc");
  if (/\bcalifornia\b|\b(los\s+angeles|san\s+francisco|orange\s+county|bay\s+area)\b/.test(tlow)) tags.add("california");
  // 主题
  if (hm.length) tags.add("macro");
  if (/mortgage\s+rate|interest\s+rate|\bfed\s+rate|rate\s+(?:cut|hike)|\bbps\b|30[-\s]year|6\.\d%/.test(tlow)) tags.add("rates");
  if (/legislat|regulat|senate|house\s+(?:bill|members)|congress|hud\b|fhfa|policy/.test(tlow)) tags.add("policy");
  if (/\b(acquisition|acquires?|sells?\b|sale\b|merger|m&a|ipo|fundrais|raised\s+\$|leas(?:e|es|ing)|signs|negotiates|loan|refinanc)/.test(tlow)) tags.add("deals");
  if (ht.length) tags.add("trend");
  if (/case[-\s]shiller|existing\s+home\s+sales|pending\s+home\s+sales|new\s+home\s+sales|housing\s+starts|jolts|primary\s+mortgage\s+market\s+survey|fhfa\s+house\s+price/.test(tlow)) tags.add("data");
  if (/\bquarterly|earnings|q[1-4]\s|first\s+quarter|second\s+quarter|third\s+quarter|fourth\s+quarter/.test(tlow)) tags.add("earnings");
  // 主体
  if (hi.length) tags.add("institutional");
  if (/\b(lennar|d\.?r\.?\s+horton|kb\s+home|toll\s+brothers|pulte|ashton\s+woods|meritage|taylor\s+morrison|homebuilder)\b/.test(tlow)) tags.add("homebuilder");
  if (/\blandlord|property\s+owner/.test(tlow)) tags.add("landlord");
  if (/\b(broker|brokerage|realtor|mls)\b/.test(tlow)) tags.add("brokerage");
  if (/\b(federal\s+reserve|fomc|hud|fhfa|treasury\s+department|cfpb)\b/.test(tlow)) tags.add("regulator");
  // 资产维度收尾
  const SPECIFIC_ASSETS = ["multifamily","btr-sfr","office","industrial","data-center","retail","hotel","housing"];
  const hasSpecific = SPECIFIC_ASSETS.some(a => tags.has(a));
  if (hasSpecific && tags.has("mixed-asset")) tags.delete("mixed-asset");
  const ASSET_IDS = [...SPECIFIC_ASSETS, "mixed-asset"];
  if (!ASSET_IDS.some(a => tags.has(a))) tags.add(item.region === "texas" ? "housing" : "mixed-asset");

  return {
    ...item,
    score: Math.round(score * 100) / 100,
    tags: [...tags],
    heat_signals: [...hc, ...hr, ...hm, ...hi, ...ht],
  };
}

// ---- 模糊去重 + 实体级去重 + 跨日去重共用工具 ----
const STOPWORDS = new Set(["the","and","for","with","from","this","that","into","over","after",
  "before","about","will","would","could","should","while","their","they","them","have","been",
  "were","said","says","when","where","what","which","than","then","amid","plan","plans","news",
  "real","estate","more","some","also","even","much","very","many","report","reports","shows",
  "show","still","just","made","makes"]);
const ENT_STOPWORDS = new Set(["the","and","for","with","from","into","over","after","north","south",
  "east","west","deal","sheet","news","report","weekly","monthly","annual","real","estate","office",
  "industrial","company","group","corp","inc","llc","fund","partners","capital","trust","advisors"]);

function tokenize(title) {
  const m = String(title).toLowerCase().match(/[a-z]{4,}|\$[\d.,]+[bmk]?|[\d.]+%|\d{3,}/g);
  if (!m) return [];
  return Array.from(new Set(m.filter(t => !STOPWORDS.has(t))));
}
function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const A = new Set(a), B = new Set(b);
  let int = 0; for (const x of A) if (B.has(x)) int++;
  const uni = A.size + B.size - int;
  return uni === 0 ? 0 : int / uni;
}
function extractFigures(text) {
  const out = new Set();
  const re = /\$?(\d{2,}(?:[.,]\d+)?)\s*(b|m|k|million|billion|trillion)?\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    let n = parseFloat(m[1].replace(/,/g, ""));
    if (isNaN(n)) continue;
    const sfx = (m[2] || "").toLowerCase();
    if (sfx === "k") n *= 1000;
    else if (sfx === "m" || sfx === "million") n *= 1_000_000;
    else if (sfx === "b" || sfx === "billion") n *= 1_000_000_000;
    else if (sfx === "t" || sfx === "trillion") n *= 1_000_000_000_000;
    if (n >= 100) out.add(Math.round(n).toString());
  }
  return out;
}
function extractEntities(title) {
  const out = new Set();
  const multi = title.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4}\b/g) || [];
  for (const p of multi) {
    const norm = p.toLowerCase().replace(/\s+/g, " ").trim();
    if (norm.length >= 5) out.add(norm);
  }
  const single = title.match(/\b[A-Z][a-z]{4,}\b/g) || [];
  for (const s of single) {
    const lower = s.toLowerCase();
    if (!ENT_STOPWORDS.has(lower)) out.add(lower);
  }
  return out;
}
function isSameStory(a, b, jaccardThreshold = 0.5) {
  if (jaccard(tokenize(a.title), tokenize(b.title)) >= jaccardThreshold) return true;
  const figA = extractFigures(`${a.title} ${a.description || ""}`);
  const figB = extractFigures(`${b.title} ${b.description || ""}`);
  let sFig = 0; for (const f of figA) if (figB.has(f)) sFig++;
  const entA = extractEntities(a.title);
  const entB = extractEntities(b.title);
  let sEnt = 0; for (const e of entA) if (entB.has(e)) sEnt++;
  return sFig >= 1 && sEnt >= 1;
}
function isBetter(a, b) {
  if (a.source_weight !== b.source_weight) return a.source_weight > b.source_weight;
  if (a.published_at !== b.published_at) return a.published_at > b.published_at;
  return a.score > b.score;
}

function dedupe(items, jaccardThreshold = 0.5) {
  const byUrl = new Map();
  for (const it of items) {
    const cur = byUrl.get(it.link);
    if (!cur || isBetter(it, cur)) byUrl.set(it.link, it);
  }
  const groups = [];
  for (const it of byUrl.values()) {
    let placed = false;
    for (const g of groups) {
      if (isSameStory(it, g.rep, jaccardThreshold)) {
        if (isBetter(it, g.rep)) g.rep = it;
        placed = true; break;
      }
    }
    if (!placed) groups.push({ rep: it });
  }
  return groups.map(g => g.rep);
}

// CRE 子类 — 只看 title 避免 body 误判
function detectCreSubcategory(it) {
  const t = it.title.toLowerCase();
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

// section 保底：24h 空 → 7d 池补 1 条
function ensureSectionMinimum(result, fallbackPool) {
  const picked = new Set();
  for (const r of result) for (const it of r.items) picked.add(it.link);
  for (const r of result) {
    if (r.items.length > 0) continue;
    const cand = fallbackPool
      .filter(it => classify(it) === r.section.id && !picked.has(it.link))
      .sort((a, b) => b.score - a.score)[0];
    if (cand) { r.items.push({ ...cand, extended_window: true }); picked.add(cand.link); }
  }
}

// ---- 分类 ----  (顺序：国 → Sunbelt → BTR → CRE → 机构；后 4 个强制德州三城保底)
const SECTIONS = [
  { id: "national",       label: "全国住宅市场",      emoji: "🏠", quota: 5, maxPerSource: 2 },
  { id: "sunbelt",        label: "Sunbelt 住宅",     emoji: "🌵", quota: 4, maxPerSource: 2, texasCityRequired: true },
  { id: "btr",            label: "全国 BTR / SFR",   emoji: "🏘", quota: 3, maxPerSource: 2, texasCityRequired: true },
  { id: "cre",            label: "全国 CRE",         emoji: "🏢", quota: 5, maxPerSource: 2, texasCityRequired: true },
  { id: "institutional",  label: "全国机构资本",      emoji: "💰", quota: 3, maxPerSource: 2, texasCityRequired: true },
];
const RE_TX3 = /\b(dfw|dallas|fort\s+worth|houston|austin)\b/i;
function hitsTexasCity(it) {
  const t = it.tags || [];
  if (t.includes("dfw") || t.includes("houston") || t.includes("austin")) return true;
  return RE_TX3.test(`${it.title} ${it.description}`);
}
function ensureTexasCity(result, buckets, allCandidates) {
  const matchers = {
    btr: (it) => RE_BTR.test(it.title),
    institutional: (it) => {
      const ti = it.title.toLowerCase();
      return RE_INST.test(ti) || (it.tags||[]).includes("institutional");
    },
    cre: (it) => {
      if (RE_CRE.test(it.title)) return true;
      const t = it.tags || [];
      return ["office","industrial","data-center","retail","hotel"].some(x => t.includes(x));
    },
    // Sunbelt 保底必须是住宅（不接受 SpaceX chip 工厂这种 TX-CRE 内容）
    sunbelt: (it) => {
      const ti = it.title.toLowerCase();
      return RE_RES.test(ti) || (it.tags||[]).includes("multifamily") || (it.tags||[]).includes("btr-sfr");
    },
    national: () => true,
  };
  for (const r of result) {
    if (!r.section.texasCityRequired) continue;
    if (r.items.some(hitsTexasCity)) continue;
    const picked = new Set(r.items.map(x => x.link));
    let cand = (buckets.get(r.section.id) || [])
      .filter(it => !picked.has(it.link) && hitsTexasCity(it))
      .sort((a, b) => b.score - a.score)[0];
    if (!cand) {
      const m = matchers[r.section.id];
      cand = allCandidates
        .filter(it => !picked.has(it.link) && hitsTexasCity(it) && m(it))
        .filter(it => !result.some(rr => rr.items.some(x => x.link === it.link)))
        .sort((a, b) => b.score - a.score)[0];
    }
    if (!cand) continue;
    let lowIdx = -1, lowScore = Infinity;
    for (let i = 0; i < r.items.length; i++) {
      if (hitsTexasCity(r.items[i])) continue;
      if (r.items[i].score < lowScore) { lowScore = r.items[i].score; lowIdx = i; }
    }
    if (lowIdx >= 0) r.items[lowIdx] = cand;
    else r.items.push(cand);
  }
}
const RE_BTR = /\b(btr|build[-\s]?to[-\s]?rent|sfr|single[-\s]?family\s+rental|invitation\s+homes|american\s+homes\s+4\s+rent|tricon|pretium|progress\s+residential|home\s+partners|nrhc|rental\s+home\s+council)\b/i;
const RE_INST = /\b(blackstone|kkr|brookfield|starwood|tpg|pgim|nuveen|cohen\s*(?:&|and)\s*steers|principal\s+real\s+estate|pere|fundraising|fundraise|major\s+fundraising|capital\s+raise|lp\s+commitment|gp\s+stake|reit\s+ipo|secondary\s+sale|continuation\s+vehicle|allocator|institutional\s+investor|private\s+real\s+estate)\b/i;
const RE_SUNBELT = /\b(texas|houston|dallas|fort\s+worth|dfw|austin|san\s+antonio|phoenix|arizona|atlanta|georgia|charlotte|nashville|tennessee|tampa|miami|orlando|jacksonville|florida|raleigh|charleston|sun\s*belt|sunbelt)\b/i;
const RE_RES = /\b(housing|home(?:s|owner)?|landlord|rental|rent\s|mortgage|residential|multifamily|apartment|single[-\s]?family)\b/i;
const RE_CRE = /\b(industrial|office|data\s+center|warehouse|warehousing|logistics\s+center|sf\s+industrial|sf\s+office|sf\s+lease|commercial\s+real\s+estate|\bcre\b|class\s+a\s+office|cap\s+rate|headquarters|\bhq\b|academic\s+project|life\s+sciences|retail\s+center|\bretail\b|hotel|hospitality|lodging|multifamily|apartment\s+(?:building|community)|rental\s+market|landlords?|rental\s+(?:property|properties|portfolio|housing|losses))\b/i;
const HOMEBUILDER_RE = /\b(homebuilder|home\s+builder|starts\s+sales|new\s+homes\s+at|townhomes?|breaks\s+ground|grand\s+opening)\b/i;
const CRE_ASSET_TAGS = ["multifamily","office","industrial","data-center","hotel","retail"];
const CRE_LEANING_SOURCES = new Set(["bisnow","trd-national","connect-cre","rebusiness-online","multi-housing-news","multifamily-dive","yardi-matrix"]);

function classify(item) {
  // 分类只看 title，避免正文误带的关键词把分类拉偏
  const titleLow = item.title.toLowerCase();
  if (RE_BTR.test(titleLow)) return "btr";
  if (RE_INST.test(titleLow)
      || item.source_id === "pere-news"
      || item.source_id === "sec-invh-8k"
      || item.source_id === "sec-amh-8k"
      || item.source_id === "pretium-partners") return "institutional";
  const TITLE_CRE = /\b(industrial|office|data\s+center|warehouse|warehousing|logistics|\bhq\b|headquarters|hotel|hospitality|retail\s+center|life\s+sciences)\b/i;
  const titleHasCRE = TITLE_CRE.test(titleLow);
  const titleHasSB = RE_SUNBELT.test(titleLow);
  const titleHasRes = RE_RES.test(titleLow);
  // residential 仅接受 title 关键词或主动 multifamily/btr-sfr tag — 不要 housing tag (容易兜底误加)
  const res = RE_RES.test(titleLow)
    || (item.tags || []).includes("multifamily")
    || (item.tags || []).includes("btr-sfr");
  const sbMatch = (titleHasSB && res) || (item.region === "texas" && titleHasRes);
  if (sbMatch && !titleHasCRE) return "sunbelt";
  // CRE — title 含 CRE asset class OR 信源是 CRE 主导
  if (!HOMEBUILDER_RE.test(titleLow)) {
    if (RE_CRE.test(titleLow)) return "cre";
    if (CRE_LEANING_SOURCES.has(item.source_id)) return "cre";
  }
  return "national";
}

function pickBySection(items, total, globalMaxPerSrc = 4) {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const buckets = new Map(SECTIONS.map(s => [s.id, []]));
  for (const it of sorted) buckets.get(classify(it)).push(it);
  const globalCounts = new Map();
  const sectionCounts = new Map(SECTIONS.map(s => [s.id, new Map()]));

  function tryTake(section, candidates, taken) {
    const sectMap = sectionCounts.get(section.id);
    const sectCap = section.maxPerSource ?? globalMaxPerSrc;
    for (const it of candidates) {
      if (taken.length >= section.quota) break;
      if (taken.some(x => x.link === it.link)) continue;
      const sc = sectMap.get(it.source_id) || 0;
      if (sc >= sectCap) continue;
      const gc = globalCounts.get(it.source_id) || 0;
      if (gc >= globalMaxPerSrc) continue;
      taken.push(it);
      sectMap.set(it.source_id, sc + 1);
      globalCounts.set(it.source_id, gc + 1);
    }
  }

  const result = SECTIONS.map(s => {
    const taken = [];
    tryTake(s, buckets.get(s.id), taken);
    return { section: s, items: taken };
  });

  const reached = () => result.reduce((a, r) => a + r.items.length, 0) >= total;
  let progress = true;
  while (!reached() && progress) {
    progress = false;
    for (const r of result) {
      if (reached()) break;
      const before = r.items.length;
      const expanded = { ...r.section, quota: r.items.length + 1 };
      tryTake(expanded, buckets.get(r.section.id), r.items);
      if (r.items.length > before) progress = true;
    }
  }
  // 德州三城保底（不增加总数，替换最低分非德州 item）
  ensureTexasCity(result, buckets, sorted);
  return result;
}

// ---- LLM (optional) ----
async function summarizeBatch(items, apiKey) {
  const lines = items.map((it, i) =>
    `[${i + 1}] (${it.source_name}) ${it.title}\n描述: ${it.description.slice(0, 280)}`);
  const prompt = `你是 Wan Bridge 美国住宅地产研究员。给每条新闻产出 4 字段 {i, t, s, imp, dir}。

【保留英文 — 行业惯例不翻译】
公司 / 媒体 / 人名（Blackstone, Pretium, Bloomberg, Cleary Gottlieb 等）
行业缩写（REIT, IPO, M&A, BTR, SFR, NOI, cap rate, refi, special servicing 等）
政府机构（Fed, FOMC, FHFA, HUD, Treasury, CFPB, SEC, Senate, ICE 等）
数据指标（JOLTS, CPI, PMMS, Case-Shiller, new home sales, existing home sales, housing starts 等）
单位 / 数字（Q3, $1.75B, 475K SF, 6.3%, 30Y mortgage, bps）
英文地名（Manhattan, NYC, Sun Belt, Wilmer 等）

【硬约束】
✓ s 必须给出结论 / 数字 / 立场 / 方向之一；imp 整数 1-5；dir 五选一 (long-pos/short-pos/neutral/short-neg/long-neg)
✗ 禁止"X 谈了/讨论了/表态了"没结论句式 / 禁止编造 / RSS 信息不足时写"详细见原文"+最少事实

输出 JSON 数组：[{"i":N, "t":"...", "s":"...", "imp":N, "dir":"..."}, ...]

新闻列表：

${lines.join("\n\n")}

请直接输出 JSON 数组（不带 markdown code fence）：`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const text = data.content?.[0]?.text ?? "";
  const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*$/g, "").trim();
  let parsed = [];
  try { parsed = JSON.parse(cleaned); }
  catch {
    const matches = cleaned.matchAll(/\{\s*"i"\s*:\s*(\d+)(?:\s*,\s*"t"\s*:\s*"([^"]+)")?\s*,\s*"s"\s*:\s*"([^"]+)"\s*\}/g);
    for (const m of matches) parsed.push({ i: +m[1], t: m[2], s: m[3] });
  }
  const titleMap = new Map(), summaryMap = new Map();
  for (const p of parsed) { if (p.t) titleMap.set(p.i, p.t); summaryMap.set(p.i, p.s); }
  return items.map((it, idx) => ({
    ...it,
    title_zh: titleMap.get(idx + 1) ?? "",
    summary_zh: summaryMap.get(idx + 1) ?? "（摘要生成失败）",
  }));
}

// ---- 跨日去重持久化 ----
const SEEN_FILE = path.join(ROOT, ".seen.json");
const SEEN_MAX_AGE_DAYS = 21;

function loadSeenFile() {
  if (!fs.existsSync(SEEN_FILE)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}
function pruneSeen(seen, now) {
  const cutoff = now - SEEN_MAX_AGE_DAYS * 24 * 3600 * 1000;
  return seen.filter(s => {
    const t = Date.parse(s.shown_date);
    return !isNaN(t) && t >= cutoff;
  });
}
function filterAlreadySeen(items, seen, threshold = 0.7) {
  const seenUrls = new Set(seen.map(s => s.url));
  return items.filter(it => {
    if (seenUrls.has(it.link)) return false;
    const tokens = tokenize(it.title);
    if (!tokens.length) return true;
    for (const s of seen) if (jaccard(tokens, s.tokens) >= threshold) return false;
    return true;
  });
}
function appendToSeen(seen, newItems, date) {
  return [...newItems.map(it => ({
    url: it.link,
    tokens: tokenize(it.title),
    shown_date: date,
  })), ...seen];
}

// ---- main ----
const args = process.argv.slice(2);
const wantSummary = args.includes("--summarize");
const wantJson = args.includes("--json");
const wantReset = args.includes("--reset");
const wantNoSave = args.includes("--no-save");
const wantNoCrossDay = args.includes("--no-cross-day");

if (wantReset) {
  if (fs.existsSync(SEEN_FILE)) { fs.unlinkSync(SEEN_FILE); console.error("🗑  已清空 .seen.json"); }
  else console.error("🗑  .seen.json 不存在，无需清空");
  process.exit(0);
}

(async () => {
  const sources = config.sources;
  const log = wantJson ? () => {} : console.error;
  log(`📰 拉取 ${sources.length} 个信源 …`);

  const UA_BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const UA_SEC = "WanBridge Research News Agent admin@example.com";
  const SEC_TICKER = {
    "sec-invh-8k": "INVH (Invitation Homes)",
    "sec-amh-8k": "AMH (American Homes 4 Rent)",
  };
  const pickUA = (s) => {
    if (s.ua_style === "sec") return UA_SEC;
    try { if (new URL(s.url).hostname.endsWith("sec.gov")) return UA_SEC; } catch {}
    return UA_BROWSER;
  };
  const results = await Promise.all(sources.map(async (s) => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      const r = await fetch(s.url, {
        signal: ctrl.signal,
        headers: {
          "User-Agent": pickUA(s),
          "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      clearTimeout(t);
      if (!r.ok) return { source: s, items: [], error: `HTTP ${r.status}` };
      const xml = await r.text();
      const items = parseFeed(xml, s);
      // SEC 标题加 ticker 前缀
      const ticker = SEC_TICKER[s.id];
      if (ticker) {
        for (const it of items) it.title = `${ticker} ${it.title}`;
      }
      return { source: s, items };
    } catch (e) {
      return { source: s, items: [], error: e.message };
    }
  }));

  log("\n📊 各信源拉取结果:");
  for (const r of results) {
    const status = r.error ? `❌ ${r.error}` : `✅ ${r.items.length} items`;
    log(`  ${r.source.name.padEnd(40)} ${status}`);
  }

  const all = results.flatMap(r => r.items);
  log(`\n🔢 总抓到 ${all.length} 条 → 打分 …`);

  const now = Date.now();
  const scored = all.map(it => scoreItem(it, now));

  // 硬过滤：严格 24 小时窗（北京 9 AM 为基准）+ filter_required 信源关键词
  const HOUSING_KW = ["housing","home","rental","rent","mortgage","real estate","btr",
    "single-family","multifamily","apartment","homeowner","fhfa","freddie","fannie",
    "fed rate","construction","homebuilder","zillow","redfin"];
  const cutoff = now - 24 * 3600 * 1000;
  const sourcesById = new Map(sources.map(s => [s.id, s]));
  const filtered = scored.filter(it => {
    if (it.published_at > 0 && it.published_at < cutoff) return false;
    const src = sourcesById.get(it.source_id);
    if (src?.filter_required) {
      const t = `${it.title} ${it.description}`.toLowerCase();
      if (!HOUSING_KW.some(k => t.includes(k))) return false;
    }
    return true;
  });
  log(`⏰ 24h 时间窗过滤后 ${filtered.length} 条`);

  const deduped = dedupe(filtered);
  log(`🧹 实体级去重后 ${deduped.length} 条`);

  // 7 天扩展池（用于 section 保底）— 同样 dedup
  const cutoff7d = now - 7 * 24 * 3600 * 1000;
  const filtered7d = scored.filter(it => {
    if (it.published_at > 0 && it.published_at < cutoff7d) return false;
    const src = sourcesById.get(it.source_id);
    if (src?.filter_required) {
      const t = `${it.title} ${it.description}`.toLowerCase();
      if (!HOUSING_KW.some(k => t.includes(k))) return false;
    }
    return true;
  });
  const deduped7d = dedupe(filtered7d);

  // 跨日去重
  const seenAll = pruneSeen(loadSeenFile(), now);
  let pool = deduped;
  let pool7d = deduped7d;
  if (!wantNoCrossDay && seenAll.length > 0) {
    const before = pool.length;
    pool = filterAlreadySeen(deduped, seenAll, 0.7);
    pool7d = filterAlreadySeen(deduped7d, seenAll, 0.7);
    log(`📅 跨日去重：seen list 有 ${seenAll.length} 条 → 剔掉 ${before - pool.length} 条，剩 ${pool.length} 条候选`);
  } else if (seenAll.length === 0) {
    log("📅 跨日去重：seen list 为空（首次运行）");
  } else {
    log("📅 跨日去重：被 --no-cross-day 跳过");
  }

  // ---- Article enrichment：top-30 候选并发抓全文 ----
  const FETCH_TIMEOUT = 8000;
  const MAX_BODY = 4000;
  const HTML_TAG = /<[^>]+>/g;
  const SCRIPT_STYLE = /<(script|style|svg|iframe|noscript)[\s\S]*?<\/\1>/gi;
  const ENTITY = /&[a-z]+;/gi;
  const PATTERNS = [
    /<article\b[\s\S]*?<\/article>/i,
    /<main\b[\s\S]*?<\/main>/i,
    /<div[^>]*?(?:class|id)="[^"]*?(?:article-body|story-body|post-body|entry-content|content-body|article__body|wire-body|articleBody|story__content)[^"]*?"[\s\S]*?<\/div>/i,
  ];
  const cleanHtml = (h) => h.replace(SCRIPT_STYLE, " ").replace(HTML_TAG, " ").replace(ENTITY, " ").replace(/\s+/g, " ").trim().slice(0, MAX_BODY);
  const extractBody = (html) => {
    for (const p of PATTERNS) {
      const m = html.match(p);
      if (m && m[0].length > 500) return cleanHtml(m[0]);
    }
    return cleanHtml(html);
  };

  const candidates = pool.sort((a, b) => b.score - a.score).slice(0, 30);
  log(`📄 enrich: 抓取 top-${candidates.length} 候选全文 …`);
  let enrichOk = 0;
  const enriched = await Promise.all(candidates.map(async (it) => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
      const r = await fetch(it.link, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,*/*",
        },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!r.ok) return it;
      const html = await r.text();
      const body = extractBody(html);
      if (body.length > 100) {
        enrichOk++;
        return { ...it, description: body };
      }
      return it;
    } catch { return it; }
  }));
  log(`📄 成功 ${enrichOk}/${candidates.length}，失败的 fallback RSS desc`);

  // 用 enriched 内容重新 score + classify
  const rescored = enriched.map(it => {
    const r = scoreItem(it, now);
    r.section = classify(r);
    return r;
  });
  const rededuped = dedupe(rescored);
  log(`🔄 enrich 后重新去重 → ${rededuped.length} 条候选`);

  const sectioned = pickBySection(rededuped, 20, 4);
  // section 保底（24h 内空的 section 从 7d 池补 1 条）
  ensureSectionMinimum(sectioned, pool7d);
  let top = sectioned.flatMap(s => s.items.map(it => {
    const enriched = { ...it, section: s.section.id };
    if (s.section.id === "cre") enriched.cre_subcategory = detectCreSubcategory(it);
    return enriched;
  }));
  log(`🏆 5 个 section 配额挑选后共 ${top.length} 条`);
  for (const r of sectioned) {
    const ext = r.items.filter(x => x.extended_window).length;
    const extNote = ext > 0 ? ` (${ext} 条扩窗)` : "";
    log(`   ${r.section.emoji} ${r.section.label}: ${r.items.length} / ${r.section.quota}${extNote}`);
  }
  log("");

  if (wantSummary) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) { console.error("❌ 需要 ANTHROPIC_API_KEY 环境变量"); process.exit(1); }
    log("🤖 调 Claude 生成中文摘要 …");
    top = await summarizeBatch(top, key);
  }

  // 把今天选的写进 seen list（除非 --no-save）
  if (!wantNoSave && !wantNoCrossDay) {
    const today = new Date(now).toISOString().slice(0, 10);
    const updated = pruneSeen(appendToSeen(seenAll, top, today), now);
    fs.writeFileSync(SEEN_FILE, JSON.stringify(updated, null, 2));
    log(`💾 写回 .seen.json（共 ${updated.length} 条 / 21 天滚动）`);
  }

  if (wantJson) {
    console.log(JSON.stringify({
      generated_at: now,
      count: top.length,
      sections: SECTIONS,
      items: top,
    }, null, 2));
    return;
  }

  for (const r of sectioned) {
    if (r.items.length === 0) continue;
    console.log(`\n========== ${r.section.emoji} ${r.section.label} (${r.items.length}) ==========\n`);
    r.items.forEach((it, i) => {
      console.log(`${String(i + 1).padStart(2)}. [${it.score.toFixed(1)}] ${it.title}`);
      if (it.title_zh) console.log(`    🇨🇳 ${it.title_zh}`);
      console.log(`    📰 ${it.source_name} · ${new Date(it.published_at || now).toISOString().slice(0, 16)}`);
      console.log(`    🏷  ${it.tags.slice(0, 5).join(", ")}`);
      if (it.summary_zh) console.log(`    📝 ${it.summary_zh}`);
      console.log(`    🔗 ${it.link}\n`);
    });
  }
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
