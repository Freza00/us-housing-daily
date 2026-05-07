#!/usr/bin/env node
/**
 * Production pipeline — GitHub Actions 调用此脚本生成每日数据
 *
 * 流程：
 *   1. 读 config/sources.json + state/seen.json
 *   2. 跑完整 pipeline (fetch RSS → score → 24h filter → dedupe → cross-day filter)
 *   3. enrich top-30 (并发 fetch full HTML, regex 提取 article body)
 *   4. 用 enriched body 重新 score + classify + dedupe
 *   5. section 配额挑选 → top 20-21
 *   6. 调 LLM (OpenAI 兼容) batch 生成中文译标 + 摘要 + imp + dir
 *   7. 写 data/latest.json + data/YYYY-MM-DD.json + data/dates.json
 *   8. 更新 state/seen.json (rolling 21 天)
 *
 * 必填环境变量：
 *   LLM_API_KEY    — OpenAI 兼容 API key
 *   LLM_ENDPOINT   — chat completions URL
 *   LLM_MODEL      — 模型名
 *
 * 可选：
 *   LLM_SKIP=1     — 跳过 LLM 调用 (调试用)
 *
 * 这个脚本里 90% 的代码是脚本逻辑（去重 / 打分 / 分类 / 抓取）— 只有最后摘要那一步用 LLM
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ============================================================
// 配置
// ============================================================
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config/sources.json"), "utf8"));

const STATE_DIR = path.join(ROOT, "state");
const DATA_DIR = path.join(ROOT, "data");
const SEEN_FILE = path.join(STATE_DIR, "seen.json");
const SEEN_MAX_AGE_DAYS = 21;
const DAILY_LIMIT = 20;
// 时间窗：绝对边界 [昨天 8:57 北京, 今天 8:57 北京)，对应 UTC [昨天 00:57, 今天 00:57)
// 这个窗口跨日刚好接续 — 第二天的 [今天 8:57, 明天 8:57) 接前一天截止时间，不重不漏
const WINDOW_END_UTC_HOUR = 0;
const WINDOW_END_UTC_MIN = 57;
const ENRICH_TOP_N = 30;
const ENRICH_TIMEOUT_MS = 8000;
const ENRICH_MAX_BODY = 4000;

// 计算"上一次 8:57 北京"作为时间窗上界 (close interval)
// 例：cron 在 UTC 00:57:01 触发 → upperBound = 今天 UTC 00:57:00 → 窗口 = [昨天 00:57, 今天 00:57)
function computeWindowBounds(now) {
  const upper = new Date(now);
  upper.setUTCHours(WINDOW_END_UTC_HOUR, WINDOW_END_UTC_MIN, 0, 0);
  // 如果 cron 提前几秒触发或时间偏移导致 now 还没到 00:57，回退一天
  if (now < upper.getTime()) upper.setUTCDate(upper.getUTCDate() - 1);
  return {
    upper: upper.getTime(),
    lower24h: upper.getTime() - 24 * 3600 * 1000,
    lower7d: upper.getTime() - 7 * 24 * 3600 * 1000,
  };
}

// 确保目录存在
for (const dir of [STATE_DIR, DATA_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ============================================================
// 工具函数
// ============================================================
const lower = (s) => String(s ?? "").toLowerCase();
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
  const m = String(s).match(re);
  return m ? m[1] : "";
};

const log = (msg) => console.error(msg);

// ============================================================
// RSS 解析
// ============================================================
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
      const pub = decode(
        firstMatch(b, /<published[^>]*>([\s\S]*?)<\/published>/i) ||
          firstMatch(b, /<updated[^>]*>([\s\S]*?)<\/updated>/i),
      );
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
      const pub = decode(
        firstMatch(b, /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) ||
          firstMatch(b, /<dc:date[^>]*>([\s\S]*?)<\/dc:date>/i),
      );
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

// ============================================================
// 抓取 RSS feeds
// ============================================================
const UA_BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
// SEC EDGAR 公平使用政策要求 fetcher 在 User-Agent 里携带真实联系方式 — 配置 SEC_CONTACT_EMAIL 为你自己的邮箱
const UA_SEC = process.env.SEC_CONTACT_EMAIL
  ? `us-housing-daily-news-agent ${process.env.SEC_CONTACT_EMAIL}`
  : "us-housing-daily-news-agent contact@example.com";
const SEC_TICKER = {
  "sec-invh-8k": "INVH (Invitation Homes)",
  "sec-amh-8k": "AMH (American Homes 4 Rent)",
};

const pickUA = (s) => {
  if (s.ua_style === "sec") return UA_SEC;
  try { if (new URL(s.url).hostname.endsWith("sec.gov")) return UA_SEC; } catch {}
  return UA_BROWSER;
};

function buildHeaders(s, url) {
  const ua = pickUA(s);
  if (ua === UA_SEC) {
    return {
      "User-Agent": UA_SEC,
      "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      "Accept-Language": "en-US,en;q=0.9",
    };
  }
  let referer = "";
  try { referer = new URL(url).origin + "/"; } catch {}
  return {
    "User-Agent": UA_BROWSER,
    "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.9",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Sec-Ch-Ua": '"Chromium";v="120", "Not(A:Brand";v="24", "Google Chrome";v="120"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"macOS"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    ...(referer ? { "Referer": referer } : {}),
  };
}

async function fetchOnce(url, headers, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers });
    if (!r.ok) return { ok: false, status: r.status, error: `HTTP ${r.status}` };
    const xml = await r.text();
    return { ok: true, xml };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  } finally {
    clearTimeout(t);
  }
}

async function fetchSourceWithFallbacks(s) {
  const candidates = [s.url, ...(Array.isArray(s.alternates) ? s.alternates : [])];
  const attempted = [];
  let lastError = null;
  for (let i = 0; i < candidates.length; i++) {
    const url = candidates[i];
    attempted.push(url);
    const headers = buildHeaders(s, url);
    let res = await fetchOnce(url, headers);
    // primary 上的 5xx / 网络错误重试一次（403 不重试，直接走 alternate）
    if (!res.ok && i === 0 && (!res.status || res.status >= 500)) {
      await new Promise(r => setTimeout(r, 1500));
      res = await fetchOnce(url, headers);
    }
    if (res.ok) {
      return { source: s, items: parseFeed(res.xml, s), attempted_urls: attempted, fetched_url: url };
    }
    lastError = res.error;
  }
  return { source: s, items: [], error: lastError ?? "fetch failed", attempted_urls: attempted };
}

async function fetchAllSources(sources) {
  return Promise.all(sources.map(async (s) => {
    const r = await fetchSourceWithFallbacks(s);
    if (r.error) return r;
    const ticker = SEC_TICKER[s.id];
    if (ticker) for (const it of r.items) it.title = `${ticker} ${it.title}`;
    return r;
  }));
}

// ============================================================
// 评分 / 标签
// ============================================================
const HOT_CORE = ["build-to-rent", "btr", " sfr", "single-family rental", "single family rental", "invitation homes", "american homes 4 rent", "amh", "tricon", "progress residential"];
const HOT_REGIONAL = ["texas", "houston", "dallas", "fort worth", "dfw", "austin", "san antonio", "sun belt"];
const HOT_MACRO = ["fed", "fomc", "rate cut", "rate hike", "inflation", "mortgage rate", "30-year fixed", "case-shiller", "case shiller", "existing home sales", "pending home sales", "new home sales", "housing starts", "permits", "freddie mac", "fannie mae"];
const HOT_INST = ["blackrock", "blackstone", "kkr", "brookfield", "starwood", "cohen & steers", "cohen and steers", "pgim", "nuveen", "principal real estate", "btr fund"];
const HOT_TREND = ["outlook", "forecast", "trend", "trends", "annual", "year-end", " yoy", "year over year", "year-over-year", "what to expect", "state of the market", "state of the housing", "housing market", "rental market", "case-shiller", "existing-home sales", "pending home sales", "new home sales", "housing starts", "construction spending", "fhfa house price", "primary mortgage market survey", "weekly applications", "rent growth", "occupancy", "vacancy", "what's next", "outlook 2026", "2026 outlook"];
const NEG = ["celebrity", "kardashian", "kanye", "taylor swift", "luxury mansion", "haunted", "weirdest"];

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

  score += hc.length * 5 + hr.length * 1 + hm.length * 2 + hi.length * 4 + ht.length * 3 - neg.length * 4;
  if (item.title.length < 20) score -= 2;

  // 自动 tag (4 维度 canonical IDs)
  const tags = new Set(item.source_tags);
  const tlow = lower(text);
  if (/data\s+center/.test(tlow)) tags.add("data-center");
  if (/warehouse|warehousing|logistics\s+center/.test(tlow)) tags.add("industrial");
  if (/\bindustrial\b/.test(tlow)) tags.add("industrial");
  if (/\boffice\b|class\s+a\s+office|headquarters|\bhq\b/.test(tlow)) tags.add("office");
  if (/multifamily|apartment\s+(?:building|community)|\bapartments?\b/.test(tlow)) tags.add("multifamily");
  if (hc.length) tags.add("btr-sfr");
  if (/hotel|hospitality|lodging/.test(tlow)) tags.add("hotel");
  if (/retail\s+center|shopping\s+center/.test(tlow)) tags.add("retail");
  if (/\b(housing\s+market|new\s+home\s+sales|existing\s+home\s+sales|home\s+sales|homebuyer|home\s+price|residential\s+market|housing\s+starts|mortgage\s+rate|home\s+inventory)\b/.test(tlow)) tags.add("housing");
  if (hr.length) tags.add("texas");
  if (tlow.includes("houston")) tags.add("houston");
  if (/\bdallas\b|fort\s+worth|\bdfw\b/.test(tlow)) tags.add("dfw");
  if (tlow.includes("austin")) tags.add("austin");
  if (/sun\s*belt|sunbelt/.test(tlow)) tags.add("sun-belt");
  if (/manhattan|brooklyn|new\s+york\s+city|\bnyc\b/.test(tlow)) tags.add("nyc");
  if (/\bcalifornia\b|\b(los\s+angeles|san\s+francisco|orange\s+county|bay\s+area)\b/.test(tlow)) tags.add("california");
  if (hm.length) tags.add("macro");
  if (/mortgage\s+rate|interest\s+rate|\bfed\s+rate|rate\s+(?:cut|hike)|\bbps\b|30[-\s]year|6\.\d%/.test(tlow)) tags.add("rates");
  if (/legislat|regulat|senate|house\s+(?:bill|members)|congress|hud\b|fhfa|policy/.test(tlow)) tags.add("policy");
  if (/\b(acquisition|acquires?|sells?\b|sale\b|merger|m&a|ipo|fundrais|raised\s+\$|leas(?:e|es|ing)|signs|negotiates|loan|refinanc)/.test(tlow)) tags.add("deals");
  if (ht.length) tags.add("trend");
  if (/case[-\s]shiller|existing\s+home\s+sales|pending\s+home\s+sales|new\s+home\s+sales|housing\s+starts|jolts|primary\s+mortgage\s+market\s+survey|fhfa\s+house\s+price/.test(tlow)) tags.add("data");
  if (/\bquarterly|earnings|q[1-4]\s|first\s+quarter|second\s+quarter|third\s+quarter|fourth\s+quarter/.test(tlow)) tags.add("earnings");
  if (hi.length) tags.add("institutional");
  if (/\b(lennar|d\.?r\.?\s+horton|kb\s+home|toll\s+brothers|pulte|ashton\s+woods|meritage|taylor\s+morrison|homebuilder)\b/.test(tlow)) tags.add("homebuilder");
  if (/\blandlord|property\s+owner/.test(tlow)) tags.add("landlord");
  if (/\b(broker|brokerage|realtor|mls)\b/.test(tlow)) tags.add("brokerage");
  if (/\b(federal\s+reserve|fomc|hud|fhfa|treasury\s+department|cfpb)\b/.test(tlow)) tags.add("regulator");
  // 资产维度收尾
  const SPECIFIC = ["multifamily","btr-sfr","office","industrial","data-center","hotel","retail","housing"];
  if (SPECIFIC.some(a => tags.has(a)) && tags.has("mixed-asset")) tags.delete("mixed-asset");
  const ASSETS = [...SPECIFIC, "mixed-asset"];
  if (!ASSETS.some(a => tags.has(a))) tags.add(item.region === "texas" ? "housing" : "mixed-asset");

  return { ...item, score: Math.round(score * 100) / 100, tags: [...tags], heat_signals: [...hc, ...hr, ...hm, ...hi, ...ht] };
}

// ============================================================
// 实体级去重
// ============================================================
const STOPWORDS = new Set(["the","and","for","with","from","this","that","into","over","after","before","about","will","would","could","should","while","their","they","them","have","been","were","said","says","when","where","what","which","than","then","amid","plan","plans","news","real","estate","more","some","also","even","much","very","many","report","reports","shows","show","still","just","made","makes"]);
const ENT_STOP = new Set(["the","and","for","with","from","into","over","after","north","south","east","west","deal","sheet","news","report","weekly","monthly","annual","real","estate","office","industrial","company","group","corp","inc","llc","fund","partners","capital","trust","advisors"]);

function tokenize(title) {
  const m = String(title).toLowerCase().match(/[a-z]{4,}|\$[\d.,]+[bmk]?|[\d.]+%|\d{3,}/g);
  if (!m) return [];
  return [...new Set(m.filter(t => !STOPWORDS.has(t)))];
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
    const lower_ = s.toLowerCase();
    if (!ENT_STOP.has(lower_)) out.add(lower_);
  }
  return out;
}
function isSameStory(a, b, threshold = 0.5) {
  if (jaccard(tokenize(a.title), tokenize(b.title)) >= threshold) return true;
  const figA = extractFigures(`${a.title} ${a.description||""}`);
  const figB = extractFigures(`${b.title} ${b.description||""}`);
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
function dedupe(items) {
  const byUrl = new Map();
  for (const it of items) {
    const cur = byUrl.get(it.link);
    if (!cur || isBetter(it, cur)) byUrl.set(it.link, it);
  }
  const groups = [];
  for (const it of byUrl.values()) {
    let placed = false;
    for (const g of groups) {
      if (isSameStory(it, g.rep)) {
        if (isBetter(it, g.rep)) g.rep = it;
        placed = true; break;
      }
    }
    if (!placed) groups.push({ rep: it });
  }
  return groups.map(g => g.rep);
}

// ============================================================
// 跨日去重
// ============================================================
function loadSeen() {
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
  return [...newItems.map(it => ({ url: it.link, tokens: tokenize(it.title), shown_date: date })), ...seen];
}

// ============================================================
// 分类 / Section
// ============================================================
// extendedWindow=true 的 section 在 24h 内候选不足 2 条时允许扩到 7d 池（标记 extended_window）；
// 高频 section (national/cre) 严格 24h，避免几天前的住宅新闻混入。
const SECTIONS = [
  { id: "national", label: "全国住宅市场", emoji: "🏠", desc: "全国住宅市场、宏观利率、政策、NAR / Realtor / Zillow / Calculated Risk", quota: 5, maxPerSource: 2, extendedWindow: false },
  { id: "sunbelt",  label: "Sunbelt 住宅", emoji: "🌵", desc: "Sun Belt 各州住宅与租赁市场 — 至少一条德州三城", quota: 4, maxPerSource: 2, texasCityRequired: true, extendedWindow: true },
  { id: "btr",      label: "全国 BTR / SFR", emoji: "🏘", desc: "Build-to-Rent / Single-Family Rental — 至少一条德州三城", quota: 3, maxPerSource: 2, texasCityRequired: true, extendedWindow: true },
  { id: "cre",      label: "全国 CRE", emoji: "🏢", desc: "办公 / 工业 / 数据中心 / 仓储 / 多户 / 酒店等 CRE — 至少一条德州三城", quota: 5, maxPerSource: 2, texasCityRequired: true, extendedWindow: false },
  { id: "institutional", label: "全国机构资本", emoji: "💰", desc: "PE / REIT 募资、并购、IPO、机构持仓 — 至少一条德州三城", quota: 3, maxPerSource: 2, texasCityRequired: true, extendedWindow: true },
];

const RE_BTR = /\b(btr|build[-\s]?to[-\s]?rent|sfr|single[-\s]?family\s+rental|invitation\s+homes|american\s+homes\s+4\s+rent|tricon|pretium|progress\s+residential|home\s+partners|nrhc|rental\s+home\s+council)\b/i;
const RE_INST = /\b(blackstone|kkr|brookfield|starwood|tpg|pgim|nuveen|cohen\s*(?:&|and)\s*steers|principal\s+real\s+estate|pere|fundraising|fundraise|major\s+fundraising|capital\s+raise|lp\s+commitment|gp\s+stake|reit\s+ipo|secondary\s+sale|continuation\s+vehicle|allocator|institutional\s+investor|private\s+real\s+estate)\b/i;
const RE_SUNBELT = /\b(texas|houston|dallas|fort\s+worth|dfw|austin|san\s+antonio|phoenix|arizona|atlanta|georgia|charlotte|nashville|tennessee|tampa|miami|orlando|jacksonville|florida|raleigh|charleston|las\s+vegas|nevada|memphis|birmingham|mobile|pensacola|new\s+orleans|louisiana|sun\s*belt|sunbelt)\b/i;
const RE_RES = /\b(housing|home(?:s|owner|builder|buyer|seller|loan|equity)?|condo(?:minium)?s?|townhomes?|townhouses?|co-?op|HOA|landlord|rental|rent\s|mortgage|residential|multifamily|apartment|single[-\s]?family|new\s+home|existing\s+home)\b/i;
const RE_CRE = /\b(industrial|office|data\s+center|warehouse|warehousing|logistics\s+center|sf\s+industrial|sf\s+office|sf\s+lease|commercial\s+real\s+estate|\bcre\b|class\s+a\s+office|cap\s+rate|headquarters|\bhq\b|academic\s+project|life\s+sciences|retail\s+center|\bretail\b|hotel|hospitality|lodging|multifamily|apartment\s+(?:building|community)|rental\s+market|landlords?|rental\s+(?:property|properties|portfolio|housing|losses))\b/i;
const HOMEBUILDER_RE = /\b(homebuilder|home\s+builder|starts\s+sales|new\s+homes\s+at|townhomes?|breaks\s+ground|grand\s+opening)\b/i;
const TITLE_CRE = /\b(industrial|office|data\s+center|warehouse|warehousing|logistics|\bhq\b|headquarters|hotel|hospitality|retail\s+center|life\s+sciences)\b/i;
const CRE_LEANING_SOURCES = new Set(["bisnow","trd-national","connect-cre","rebusiness-online","multi-housing-news","multifamily-dive","yardi-matrix"]);
const RE_TX3 = /\b(dfw|dallas|fort\s+worth|houston|austin)\b/i;

// multifamily / apartment 资产类标识（用于精细化分类 — Sun Belt 的 multifamily 归 sunbelt，否则归 cre）
const RE_MULTIFAMILY_ASSET = /\b(multifamily|apartments?\s+(?:building|community|complex)?|\bmaa\b|essex\s+property|equity\s+residential|avalonbay|camden\s+property|udr\s+inc|mid-?america\s+apartment)\b/i;
// 区域研究/数据源 — title 通常不带城市但内容默认地产相关，可以兜底进 sunbelt
const TX_RESEARCH_SOURCES = new Set(["trerc"]);
// Sun Belt 区域字段值（source.region 可取此集合中任一值即视为 Sun Belt 地区源）
const SUNBELT_REGIONS = new Set(["texas", "arizona", "georgia", "florida", "north-carolina", "tennessee", "sunbelt"]);
// 业内花絮（设计趋势、人事变动、新办公室、培训）— 不算地区房市新闻，应归 national 而非 sunbelt
const RE_NON_HOUSING_MARKET = /\b(luxury\s+home|design\s+trends?|trends?\s+defining|named\s+(?:president|ceo|coo|cfo|chief|new)|opens?\s+(?:\w+\s+)?office|brokerage\s+expan|elev(?:ate|ating)\s+your|face\s+of\s+residential|REALTOR(?:S|®|\s)|coaching|webinar)\b/i;

function classify(item) {
  const t = item.title.toLowerCase();
  if (RE_BTR.test(t)) return "btr";
  if (RE_INST.test(t) || ["pere-news","sec-invh-8k","sec-amh-8k","pretium-partners"].includes(item.source_id)) return "institutional";
  const titleHasCRE = TITLE_CRE.test(t);
  const titleHasSB = RE_SUNBELT.test(t);
  const titleHasRes = RE_RES.test(t);
  const titleHasMultifamily = RE_MULTIFAMILY_ASSET.test(t);
  // sunbelt：(a) title 含 Sun Belt 城市/州 + residential（含 multifamily），或 (b) source.region∈SUNBELT_REGIONS + residential，或 (c) trerc 区域研究源兜底。
  // 排除商业资产 title（data center/office → cre）、业内花絮（设计趋势/任命/新办公室 → national）。
  // 注意：multifamily 在 Sun Belt 范围内仍归 sunbelt（用户期望），只有非 Sun Belt 的 multifamily 才走 cre fallback。
  const sbMatch = !titleHasCRE && !RE_NON_HOUSING_MARKET.test(t) && (
    (titleHasSB && titleHasRes) ||
    (SUNBELT_REGIONS.has(item.region) && titleHasRes) ||
    TX_RESEARCH_SOURCES.has(item.source_id)
  );
  if (sbMatch) return "sunbelt";
  if (!HOMEBUILDER_RE.test(t)) {
    if (RE_CRE.test(t)) return "cre";
    if (CRE_LEANING_SOURCES.has(item.source_id)) return "cre";
    if (titleHasMultifamily) return "cre"; // 非 Sun Belt 的 multifamily 资产类 → cre
  }
  return "national";
}

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

function hitsTexasCity(it) {
  const t = it.tags || [];
  if (t.includes("dfw") || t.includes("houston") || t.includes("austin")) return true;
  return RE_TX3.test(`${it.title} ${it.description}`);
}

function pickBySection(items, totalLimit, globalMax = 4) {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const buckets = new Map(SECTIONS.map(s => [s.id, []]));
  for (const it of sorted) buckets.get(classify(it)).push(it);
  const globalCounts = new Map();
  const sectionCounts = new Map(SECTIONS.map(s => [s.id, new Map()]));

  function tryTake(section, candidates, taken) {
    const sectMap = sectionCounts.get(section.id);
    const sectCap = section.maxPerSource ?? globalMax;
    for (const it of candidates) {
      if (taken.length >= section.quota) break;
      if (taken.some(x => x.link === it.link)) continue;
      const sc = sectMap.get(it.source_id) || 0;
      if (sc >= sectCap) continue;
      const gc = globalCounts.get(it.source_id) || 0;
      if (gc >= globalMax) continue;
      taken.push(it);
      sectMap.set(it.source_id, sc + 1);
      globalCounts.set(it.source_id, gc + 1);
    }
  }

  const result = SECTIONS.map(s => {
    const taken = []; tryTake(s, buckets.get(s.id), taken);
    return { section: s, items: taken };
  });

  // 严格 quota：不再用突破 quota 的 while 循环。补位由 ensureSectionMinimum + main 里
  // 的 fillers 三段策略接管，确保 national 不会无脑堆积。

  // 德州三城保底
  ensureTexasCity(result, buckets, sorted);
  return result;
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

function ensureSectionMinimum(result, fresh24h, fresh7d, minPerSection = 2) {
  const picked = new Set();
  for (const r of result) for (const it of r.items) picked.add(it.link);
  for (const r of result) {
    while (r.items.length < minPerSection) {
      // 先 24h
      let cand = fresh24h
        .filter(it => classify(it) === r.section.id && !picked.has(it.link))
        .sort((a, b) => b.score - a.score)[0];
      let isExtended = false;
      // 24h 没了 + section 允许扩窗 → 7d
      if (!cand && r.section.extendedWindow) {
        cand = fresh7d
          .filter(it => classify(it) === r.section.id && !picked.has(it.link))
          .sort((a, b) => b.score - a.score)[0];
        isExtended = true;
      }
      if (!cand) break;
      r.items.push(isExtended ? { ...cand, extended_window: true } : cand);
      picked.add(cand.link);
    }
  }
}

// ============================================================
// Article enrichment — fetch HTML, 提取 article body
// ============================================================
const HTML_TAG = /<[^>]+>/g;
const SCRIPT_STYLE = /<(script|style|svg|iframe|noscript)[\s\S]*?<\/\1>/gi;
const ENTITY = /&[a-z]+;/gi;
const ARTICLE_PATTERNS = [
  /<article\b[\s\S]*?<\/article>/i,
  /<main\b[\s\S]*?<\/main>/i,
  /<div[^>]*?(?:class|id)="[^"]*?(?:article-body|story-body|post-body|entry-content|content-body|article__body|wire-body|articleBody|story__content)[^"]*?"[\s\S]*?<\/div>/i,
];
function cleanHtml(html) {
  return html.replace(SCRIPT_STYLE, " ").replace(HTML_TAG, " ").replace(ENTITY, " ").replace(/\s+/g, " ").trim().slice(0, ENRICH_MAX_BODY);
}
function extractBody(html) {
  for (const p of ARTICLE_PATTERNS) {
    const m = html.match(p);
    if (m && m[0].length > 500) return cleanHtml(m[0]);
  }
  return cleanHtml(html);
}
async function enrichOne(item) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ENRICH_TIMEOUT_MS);
    const r = await fetch(item.link, {
      headers: { "User-Agent": UA_BROWSER, "Accept": "text/html,*/*" },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) return item;
    const html = await r.text();
    const body = extractBody(html);
    if (body.length > 100) return { ...item, description: body };
    return item;
  } catch { return item; }
}

// ============================================================
// LLM 摘要 (OpenAI 兼容协议)
// ============================================================
async function summarizeBatch(items, opts) {
  if (items.length === 0) return [];
  const lines = items.map((it, i) =>
    `[${i + 1}] (${it.source_name}) ${it.title}\n正文片段: ${it.description.slice(0, 1500)}`);

  // System prompt — 强制中文输出
  const systemPrompt = `你是美国住宅地产中文研究员。所有 "t" (中文译标) 和 "s" (中文摘要) 字段必须用中文输出，绝对不能整句用英文。仅保留 公司名 / 行业缩写 / 政府机构 / 数据指标 / 数字单位 / 英文地名 等专有术语为英文。`;

  // User prompt — 含示例
  const prompt = `给每条新闻产出 4 字段 {i, t, s, imp, dir}：
- t: 中文译标（≤ 30 中文字符），中文语序重组
- s: 一句中文摘要（≤ 60 中文字符），必须给结论 / 数字 / 立场
- imp: 1-5 整数（重要性 — 见下方 imp 评分细则）
- dir: long-pos / short-pos / neutral / short-neg / long-neg

【imp 评分细则 — 必须严格分级，禁止全部 3】
imp=5：systemic / 大型基金巨额募资 / 头部 REIT 财报或违约 / Fed 降息加息 / 联邦立法重大变动 / 新出炉的关键宏观数据（CPI / 就业 / 房价指数）
imp=4：行业中等动作 — 单 deal $200M+ / 大型 IPO 或并购 / Sun Belt 关键 metro 房市拐点信号 / 重要监管政策更新
imp=3：常规动态 — 单 deal $50-200M / 区域市场月度趋势 / 中型公司业绩 / 政策细节
imp=2：花絮性动作 — 个人公司任命 / 设计趋势 / 小型扩张 / 已知信息的不同角度报道
imp=1：边缘信息 — 单 unit listing / 单 broker 新闻 / 评论而非新闻 / 八卦

20 条新闻里：必须有 ≥ 2 条 imp=5、≥ 4 条 imp=4，≤ 5 条 imp ≤ 2。否则视为评分失败。如果今天确实没有大新闻，宁可降低高分数量也不要全 3。

【中英文混排示例（必须严格仿照这种风格输出）】
输入: "Mortgage rates hit the highest level in a month, causing first-time homebuyers to drop out"
正文: "Mortgage rates rose, loan demand dropped..."
输出: {"i":1, "t":"30Y mortgage 升至月内高位，first-time 购房者掉队", "s":"上周 mortgage rate 上行致 loan demand 回落，平均贷款额上升说明中低收入买家退出", "imp":4, "dir":"short-neg"}

输入: "MAA sees strong Sun Belt demand, rent growth ahead"
正文: "Mid-America Apartment Communities Q1 earnings call..."
输出: {"i":2, "t":"MAA Q1：Sun Belt multifamily rent growth 拐点显现", "s":"Mid-America Apartment Communities Q1 业绩 — Sun Belt 入住率回升、rent growth 拐点出现", "imp":5, "dir":"long-pos"}

输入: "Build-to-rent explodes in Atlanta — and agents are taking notice"
正文: "30% of Atlanta SFR market is institutional-owned, 10x national avg..."
输出: {"i":3, "t":"Atlanta BTR 大爆发：机构持有 SFR 30%（全国均值 10 倍）", "s":"Atlanta 都会区机构投资者持有 SFR 约 30%，是全国均值 10 倍；BTR/SFR 龙头城市从原型期进入主流期", "imp":5, "dir":"long-pos"}

【保留英文 — 行业惯例不翻译】
公司 / 媒体 / 人名：Blackstone, KKR, Pretium, Bloomberg, Cleary Gottlieb, MAA, AMH, INVH 等
行业缩写：REIT, IPO, M&A, BTR, SFR, NOI, LTV, DSCR, cap rate, refi, special servicing
政府机构：Fed, FOMC, FHFA, HUD, Treasury, CFPB, SEC, Senate, ICE
数据指标：JOLTS, CPI, PMMS, Case-Shiller, new home sales, existing home sales, housing starts
单位 / 数字：Q1/Q2/Q3/Q4, $1.75B, 475K SF, 6.3%, 30Y mortgage, bps, YoY
英文地名：Manhattan, NYC, Sun Belt, Houston, Austin, DFW（除非通用译名如"曼哈顿"）

中文化的：政策 / 宏观 / 利率 / 多户 / 办公 / 工业 / 数据中心 / 零售 / 酒店 / 租约 / 并购 / 募资 / 业绩 / 趋势 / 业主 / 经纪 / 监管 等

【硬约束】
✓ t 和 s 必须用中文写（保留英文术语除外）— 这是强制要求！
✓ s 必须给结论 / 数字 / 立场之一
✗ 禁止整句英文输出
✗ 禁止"X 谈了/讨论了/表态了"没结论的句式
✗ 严禁出现"详细见原文 / 详见原文 / 见原文 / 欲知详情请查阅原文"等占位短语
✓ 正文片段不足时：基于 title 推断事件本身、相关方、行业含义，给出 30-60 中文字符摘要；不要编具体数字，但可以写"细节待披露 / 影响待观察"等措辞

输出 JSON 数组（不带 markdown code fence）：

新闻列表：

${lines.join("\n\n")}

请直接输出 JSON 数组（每条都要严格仿照上面示例的中文风格）：`;

  const r = await fetch(opts.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${opts.apiKey}` },
    body: JSON.stringify({
      model: opts.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      max_tokens: 4000,
      temperature: 0.3,
    }),
  });
  if (!r.ok) throw new Error(`LLM API ${r.status}: ${(await r.text()).slice(0, 500)}`);
  const data = await r.json();
  const text = data.choices?.[0]?.message?.content ?? "";
  const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*$/g, "").trim();

  let parsed = [];
  try { parsed = JSON.parse(cleaned); } catch { parsed = []; }

  const titleMap = new Map(), summaryMap = new Map(), impMap = new Map(), dirMap = new Map();
  for (const p of parsed) {
    if (p.t) titleMap.set(p.i, p.t);
    if (p.s) summaryMap.set(p.i, p.s);
    if (typeof p.imp === "number") impMap.set(p.i, Math.max(1, Math.min(5, Math.round(p.imp))));
    if (p.dir) dirMap.set(p.i, p.dir);
  }
  const validDirs = new Set(["long-pos","short-pos","neutral","short-neg","long-neg"]);
  const fetchedAt = Date.now();
  return items.map((it, idx) => ({
    ...it,
    id: hashLink(it.link),
    title_zh: titleMap.get(idx + 1) ?? "",
    summary_zh: summaryMap.get(idx + 1) ?? "（摘要生成失败）",
    importance: impMap.get(idx + 1) ?? 3,
    impact: validDirs.has(dirMap.get(idx + 1)) ? dirMap.get(idx + 1) : "neutral",
    fetched_at: fetchedAt,
  }));
}

function hashLink(url) {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) { h ^= url.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ============================================================
// 主流程
// ============================================================
async function main() {
  const startedAt = Date.now();
  log("🚀 Starting daily build pipeline");

  // 1. 抓 RSS
  log(`📰 fetching ${config.sources.length} sources...`);
  const fetchResults = await fetchAllSources(config.sources);
  const errors = [];
  let okCount = 0;
  for (const r of fetchResults) {
    if (r.error) {
      errors.push({ source: r.source.name, error: r.error, attempted_urls: r.attempted_urls });
    } else {
      okCount++;
      if (r.fetched_url && r.fetched_url !== r.source.url) {
        log(`  ↳ ${r.source.name}: 走 alternate ${r.fetched_url}`);
      }
    }
  }
  const allItems = fetchResults.flatMap(r => r.items);
  log(`📰 fetched ${okCount}/${fetchResults.length} sources OK, ${allItems.length} raw items`);

  // 2. 打分 + 时间窗过滤 + 实体级去重
  // 时间窗：绝对边界 [昨天 8:57 北京, 今天 8:57 北京)，跨日不重不漏
  const now = Date.now();
  const { upper, lower24h, lower7d } = computeWindowBounds(now);
  log(`⏰ window UTC [${new Date(lower24h).toISOString().slice(0,16)} ~ ${new Date(upper).toISOString().slice(0,16)})`);
  log(`⏰        北京 [${new Date(lower24h + 8*3600*1000).toISOString().slice(0,16).replace('T',' ')} ~ ${new Date(upper + 8*3600*1000).toISOString().slice(0,16).replace('T',' ')})`);

  const scored = allItems.map(it => scoreItem(it, now));
  const sourcesById = new Map(config.sources.map(s => [s.id, s]));
  const HOUSING_KW = ["housing","home","rental","rent","mortgage","real estate","btr","single-family","multifamily","apartment","homeowner","fhfa","freddie","fannie","fed rate","construction","homebuilder","zillow","redfin"];

  function inWindow(it, lowerBound) {
    // 没 pub_date 的接受（兜底）— 部分信源 RSS 不带 pubDate
    if (!it.published_at) return true;
    if (it.published_at < lowerBound) return false;
    if (it.published_at >= upper) return false; // 严格小于上界 → 接续不重叠
    return true;
  }
  function passesFilterRequired(it) {
    const src = sourcesById.get(it.source_id);
    if (!src?.filter_required) return true;
    const t = `${it.title} ${it.description}`.toLowerCase();
    return HOUSING_KW.some(k => t.includes(k));
  }

  const filtered24h = scored.filter(it => inWindow(it, lower24h) && passesFilterRequired(it));
  const filtered7d = scored.filter(it => inWindow(it, lower7d) && passesFilterRequired(it));
  const deduped24h = dedupe(filtered24h);
  const deduped7d = dedupe(filtered7d);
  log(`⏰ 24h-window filter ${filtered24h.length} → dedupe ${deduped24h.length}`);

  // 3. 跨日去重
  const seenAll = pruneSeen(loadSeen(), now);
  const fresh24h = filterAlreadySeen(deduped24h, seenAll);
  const fresh7d = filterAlreadySeen(deduped7d, seenAll);
  log(`📅 cross-day filter: seen ${seenAll.length} → fresh ${fresh24h.length} (24h) / ${fresh7d.length} (7d)`);

  // [debug] 池子分布
  const poolDist = (pool, label) => {
    const c = { national: 0, sunbelt: 0, btr: 0, cre: 0, institutional: 0 };
    for (const it of pool) c[classify(it)] = (c[classify(it)] || 0) + 1;
    log(`📊 ${label}: ${SECTIONS.map(s => `${s.id}=${c[s.id]}`).join(" ")}`);
  };
  poolDist(fresh24h, "fresh24h dist");
  poolDist(fresh7d, "fresh7d  dist");

  // 4. Enrich top-30 (并发 fetch full HTML)
  const candidates = fresh24h.sort((a, b) => b.score - a.score).slice(0, ENRICH_TOP_N);
  log(`📄 enriching top-${candidates.length} candidates...`);
  const enriched = await Promise.all(candidates.map(enrichOne));
  let enrichOk = 0;
  for (const it of enriched) if (it.description.length > 600) enrichOk++;
  log(`📄 enriched ${enrichOk}/${candidates.length} successfully`);

  // 5. 重新 score / classify / dedupe
  const rescored = enriched.map(it => scoreItem(it, now));
  const rededuped = dedupe(rescored);

  // 6. Section 配额挑选 — 每 section 至少 2 条；national/cre 严格 24h，sunbelt/btr/inst 不够时扩到 7d
  const sectioned = pickBySection(rededuped, DAILY_LIMIT);
  ensureSectionMinimum(sectioned, fresh24h, fresh7d, 2);
  let top = sectioned.flatMap(s => s.items.map(it => {
    const out = { ...it, section: s.section.id };
    if (s.section.id === "cre") out.cre_subcategory = detectCreSubcategory(it);
    return out;
  }));

  // 7. 强制总数 = DAILY_LIMIT (不能多不能少)
  if (top.length > DAILY_LIMIT) {
    // 多了 → 砍非扩窗最低分
    const before = top.length;
    top.sort((a, b) => {
      // 扩窗优先保留
      if (!!a.extended_window !== !!b.extended_window) return a.extended_window ? -1 : 1;
      return a.score - b.score; // 升序，最低分排前面
    });
    // 砍最低分（数组前面）直到 length = limit
    top = top.slice(top.length - DAILY_LIMIT);
    log(`🔻 trimmed from ${before} → ${top.length} (cut ${before - DAILY_LIMIT} lowest-score items)`);
  } else if (top.length < DAILY_LIMIT) {
    // 少了 → 三段补位：(1) 24h+quota 限额；(2) 7d+仅扩窗 section+quota 限额；(3) 24h 兜底不限 quota
    const need = DAILY_LIMIT - top.length;
    const links = new Set(top.map(it => it.link));
    const all24 = [...rededuped, ...fresh24h.filter(it => !rededuped.some(x => x.link === it.link))]
      .filter(it => !links.has(it.link))
      .sort((a, b) => b.score - a.score);
    const sectionById = new Map(SECTIONS.map(s => [s.id, s]));
    const perSection = new Map(SECTIONS.map(s => [s.id, top.filter(t => t.section === s.id).length]));
    const fillers = [];
    // pass 1: 24h 池 + quota 严格
    for (const it of all24) {
      if (fillers.length >= need) break;
      const sid = classify(it);
      const sec = sectionById.get(sid);
      if (!sec) continue;
      if ((perSection.get(sid) || 0) >= sec.quota) continue;
      fillers.push(it);
      perSection.set(sid, (perSection.get(sid) || 0) + 1);
    }
    // pass 2: 7d 池 + 仅扩窗 section + quota 严格
    if (fillers.length < need) {
      const used = new Set(fillers.map(it => it.link));
      const all7 = fresh7d
        .filter(it => !links.has(it.link) && !used.has(it.link))
        .sort((a, b) => b.score - a.score);
      for (const it of all7) {
        if (fillers.length >= need) break;
        const sid = classify(it);
        const sec = sectionById.get(sid);
        if (!sec || !sec.extendedWindow) continue;
        if ((perSection.get(sid) || 0) >= sec.quota) continue;
        fillers.push({ ...it, extended_window: true });
        perSection.set(sid, (perSection.get(sid) || 0) + 1);
      }
    }
    // pass 3: 兜底 — 还不够就在 24h 池里不限 quota 补（极端情况下宁可 national 多也不要让 cre/national 用旧数据）
    if (fillers.length < need) {
      const used = new Set(fillers.map(it => it.link));
      for (const it of all24) {
        if (fillers.length >= need) break;
        if (used.has(it.link)) continue;
        fillers.push(it);
      }
    }
    for (const it of fillers) {
      const sid = classify(it);
      const enriched = { ...it, section: sid };
      if (sid === "cre") enriched.cre_subcategory = detectCreSubcategory(it);
      top.push(enriched);
    }
    log(`🔺 filled from ${DAILY_LIMIT - need} → ${top.length} (pass1 24h-quota → pass2 7d-extend → pass3 24h-flex)`);
  }
  // 重新排序：让前端按 section 顺序渲染
  const sectionOrder = SECTIONS.map(s => s.id);
  top.sort((a, b) => {
    const sa = sectionOrder.indexOf(a.section);
    const sb = sectionOrder.indexOf(b.section);
    if (sa !== sb) return sa - sb;
    return b.score - a.score;
  });

  log(`🏆 final ${top.length} items across ${SECTIONS.length} sections`);
  const sectionCount = {};
  for (const it of top) sectionCount[it.section] = (sectionCount[it.section] || 0) + 1;
  for (const s of SECTIONS) {
    const n = sectionCount[s.id] || 0;
    const ext = top.filter(it => it.section === s.id && it.extended_window).length;
    log(`   ${s.emoji} ${s.label}: ${n}/${s.quota}${ext > 0 ? ` (${ext} 扩窗)` : ""}`);
  }

  // 7. LLM 摘要
  const skipLLM = process.env.LLM_SKIP === "1";
  const llmKey = process.env.LLM_API_KEY;
  const llmEndpoint = process.env.LLM_ENDPOINT;
  const llmModel = process.env.LLM_MODEL;
  let withSummary;
  if (skipLLM) {
    log(`🤖 LLM_SKIP=1 — skipping LLM, output without Chinese summaries`);
    const fetchedAt = Date.now();
    withSummary = top.map(it => ({ ...it, id: hashLink(it.link), title_zh: "", summary_zh: "(LLM_SKIP)", importance: 3, impact: "neutral", fetched_at: fetchedAt }));
  } else if (!llmKey || !llmEndpoint || !llmModel) {
    throw new Error("Missing required env vars: LLM_API_KEY, LLM_ENDPOINT, LLM_MODEL (or set LLM_SKIP=1 to skip LLM)");
  } else {
    log(`🤖 calling LLM: ${llmEndpoint} model=${llmModel} batch=${top.length}`);
    withSummary = await summarizeBatch(top, { endpoint: llmEndpoint, apiKey: llmKey, model: llmModel });
    log(`🤖 LLM ok`);
  }

  // 7.5 importance-aware 重排：section 内按 weighted_score = importance * 5 + score * 0.5 降序
  // LLM 给的 importance 与系统 score 共同决定最终展示顺序，让真正重要的新闻浮到 section 顶部
  const _sectionOrder = SECTIONS.map(s => s.id);
  withSummary.sort((a, b) => {
    const sa = _sectionOrder.indexOf(a.section);
    const sb = _sectionOrder.indexOf(b.section);
    if (sa !== sb) return sa - sb;
    const wa = (a.importance || 3) * 5 + (a.score || 0) * 0.5;
    const wb = (b.importance || 3) * 5 + (b.score || 0) * 0.5;
    return wb - wa;
  });
  const impDist = withSummary.reduce((acc, it) => { acc[it.importance || 3] = (acc[it.importance || 3] || 0) + 1; return acc; }, {});
  log(`📊 importance dist: ${JSON.stringify(impDist)}`);

  // 8. 写出
  const date = new Date(now).toISOString().slice(0, 10);
  const payload = {
    date,
    generated_at: now,
    sources_attempted: config.sources.length,
    sources_ok: okCount,
    sections: SECTIONS,
    items: withSummary,
    errors,
  };
  fs.writeFileSync(path.join(DATA_DIR, "latest.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, `${date}.json`), JSON.stringify(payload, null, 2));

  // dates.json — 累计日期索引
  const datesFile = path.join(DATA_DIR, "dates.json");
  let dates = [];
  if (fs.existsSync(datesFile)) {
    try { dates = JSON.parse(fs.readFileSync(datesFile, "utf8")) || []; } catch { dates = []; }
  }
  if (!dates.includes(date)) {
    dates.unshift(date);
    dates = dates.slice(0, 90);
  }
  fs.writeFileSync(datesFile, JSON.stringify(dates, null, 2));
  log(`💾 wrote data/latest.json + data/${date}.json + data/dates.json`);

  // 9. 更新 seen.json
  const updatedSeen = pruneSeen(appendToSeen(seenAll, withSummary, date), now);
  fs.writeFileSync(SEEN_FILE, JSON.stringify(updatedSeen, null, 2));
  log(`💾 updated state/seen.json (${updatedSeen.length} items rolling 21d)`);

  log(`✅ Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

main().catch(e => {
  console.error("FATAL:", e);
  process.exit(1);
});
