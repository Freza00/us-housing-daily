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
import { selectEffectiveWindow } from "./lib/digest-core.mjs";
import { loadUsHolidays, usHolidayContext } from "./lib/us-holidays.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ============================================================
// 配置
// ============================================================
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config/sources.json"), "utf8"));
// 新 writer / reviewer 用的边界定义与 tag 白名单。
// WRITER_MODE=global 时被 globalPassWriter / reviewerAgent 读取；legacy mode 不依赖。
const SECTIONS_DEF = JSON.parse(fs.readFileSync(path.join(ROOT, "config/sections.json"), "utf8"));
const TAGS_DEF = JSON.parse(fs.readFileSync(path.join(ROOT, "config/tags.json"), "utf8"));

const STATE_DIR = path.join(ROOT, "state");
const DATA_DIR = path.join(ROOT, "data");
const SEEN_FILE = path.join(STATE_DIR, "seen.json");
const SEEN_MAX_AGE_DAYS = 21;
const DAILY_LIMIT = 20;
const WRITER_MODE = process.env.WRITER_MODE || "legacy"; // legacy | global
const REVIEWER_MAX_LOOPS = 2;
const GLOBAL_CANDIDATE_POOL_SIZE = 80; // writer 看到的候选总数
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
  const upperMs = upper.getTime();
  return {
    upper: upperMs,
    lower24h: upperMs - 24 * 3600 * 1000,
    lower48h: upperMs - 48 * 3600 * 1000,
    lower72h: upperMs - 72 * 3600 * 1000,
    lower7d:  upperMs - 7 * 24 * 3600 * 1000,
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
      if (isMetaTitle(title)) continue;
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
      if (isMetaTitle(title)) continue;
      items.push(makeItem(source, title, link, desc, pub));
    }
  }
  return items;
}

// 质量 filter：排除 RSS 偶尔抛出的 meta / 归档 / 分类索引页面（不是新闻）
const META_TITLE_RE = /^(archive|tag:|category:|categories|index|sitemap|page \d+|all posts)\b/i;
const META_TITLE_CONTAINS = /\b(archive(s)? -|page \d+ of|all categories)\b/i;
function isMetaTitle(title) {
  const t = String(title || "").trim();
  if (t.length < 15) return true; // 太短的标题大概率是 nav/meta
  if (META_TITLE_RE.test(t)) return true;
  if (META_TITLE_CONTAINS.test(t)) return true;
  return false;
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
// shown_date / 文件名 / dates.json 全部按"北京日历日"，不是 UTC 日。
// 北京 UTC+8 → 北京 0:00 = UTC 16:00（前一天）；如果用 UTC 日期，凌晨 0–8 点跑会标成"前一天"。
function beijingDateStr(ts) {
  return new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

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
  // 同一天多次 build 时去重：以 URL 为 key 合并，保留最新 shown_date
  // 防止测试 / 多次 trigger 把 seen.json 灌爆，导致下次 build 候选池被掏空
  const newEntries = newItems.map(it => ({ url: it.link, tokens: tokenize(it.title), shown_date: date }));
  const byUrl = new Map();
  for (const e of [...newEntries, ...seen]) {
    const cur = byUrl.get(e.url);
    if (!cur || Date.parse(e.shown_date) > Date.parse(cur.shown_date)) {
      byUrl.set(e.url, e);
    }
  }
  return [...byUrl.values()];
}

// ============================================================
// 分类 / Section
// ============================================================
// extendedWindow=true 的 section 在 24h 内候选不足 2 条时允许扩到 7d 池（标记 extended_window）；
// 高频 section (national/cre) 严格 24h，避免几天前的住宅新闻混入。
const SECTIONS = [
  { id: "national", label: "全国住宅市场", emoji: "🏠", desc: "全国住宅市场、宏观利率、政策、NAR / Realtor / Zillow / Calculated Risk", quota: 5, maxPerSource: 2, extendedWindow: false },
  { id: "sunbelt",  label: "Sunbelt 住宅", emoji: "🌵", desc: "Sun Belt 各州住宅与租赁市场", quota: 4, maxPerSource: 2, texasCityRequired: true, extendedWindow: true },
  { id: "btr",      label: "全国 BTR / SFR", emoji: "🏘", desc: "Build-to-Rent / Single-Family Rental", quota: 3, maxPerSource: 2, texasCityRequired: true, extendedWindow: true },
  { id: "cre",      label: "全国 CRE", emoji: "🏢", desc: "办公 / 工业 / 数据中心 / 仓储 / 多户 / 酒店等 CRE", quota: 5, maxPerSource: 2, texasCityRequired: true, extendedWindow: false },
  { id: "institutional", label: "全国机构资本", emoji: "💰", desc: "PE / REIT 募资、并购、IPO、机构持仓", quota: 3, maxPerSource: 2, texasCityRequired: true, extendedWindow: true },
];

const RE_BTR = /\b(btr|build[-\s]?to[-\s]?rent|build[-\s]?for[-\s]?rent|sfr|single[-\s]?family\s+rental|single[-\s]?family\s+for\s+rent|sfr\s+portfolio|rental\s+homes?|rental\s+home\s+council|nrhc|invitation\s+homes|invh\b|american\s+homes\s+4\s+rent|amh\b|tricon|pretium|progress\s+residential|home\s+partners(?:\s+of\s+america)?|firstkey\s+homes|main\s+street\s+renewal|roofstock)\b/i;
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

function isBtrItem(item) {
  // 来源元数据优先：source 自带 btr-sfr tag 直接归 btr，title 不命中关键词也不漏
  // （nrhc / pretium-partners / sec-invh-8k / sec-amh-8k 在 config/sources.json 都打了此 tag）
  const srcTags = item.source_tags || [];
  if (srcTags.includes("btr-sfr")) return true;
  return RE_BTR.test(item.title);
}

function classify(item) {
  const t = item.title.toLowerCase();
  if (isBtrItem(item)) return "btr";
  // 移除 source_id === "pere-news" 强制规则：PERE 偶尔发具体物业项目（如 multifamily redev），
  // 让内容关键词决定，避免污染 institutional section（典型反例 — Richmond Greyhound 改造被错归）
  if (RE_INST.test(t)) return "institutional";
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
    btr: (it) => isBtrItem(it),
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
  const underMin = []; // 诊断：到最后仍 < minPerSection 的 section
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
    // 不再静默吞掉 — 把不足条目记录到诊断
    if (r.items.length < minPerSection) {
      const pool24 = fresh24h.filter(it => classify(it) === r.section.id).length;
      const pool7d = fresh7d.filter(it => classify(it) === r.section.id).length;
      const reason = `pool empty after 24h=${pool24} / 7d=${pool7d}` +
        (r.section.extendedWindow ? "" : " (extendedWindow=false)");
      log(`⚠️  section "${r.section.id}" under minimum: ${r.items.length}/${minPerSection} — ${reason}`);
      underMin.push({
        section: r.section.id,
        count: r.items.length,
        min: minPerSection,
        pool24h: pool24,
        pool7d: pool7d,
        extendedWindow: !!r.section.extendedWindow,
      });
    }
  }
  return { underMin };
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

  const text = await fetchLLMWithRetry(opts.endpoint, {
    model: opts.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ],
    max_tokens: 4000,
    temperature: 0.3,
  }, opts.apiKey, "translator");
  const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*$/g, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    log(`🤖 LLM raw content (first 500): ${cleaned.slice(0, 500)}`);
    throw new Error(`LLM JSON parse failed: ${e.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    log(`🤖 LLM raw content (first 500): ${cleaned.slice(0, 500)}`);
    throw new Error(`LLM returned non-array or empty result (got ${typeof parsed}, length ${Array.isArray(parsed) ? parsed.length : "n/a"})`);
  }

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
// 全局通读 Writer + Reviewer (WRITER_MODE=global)
// ============================================================
// 目标：取代 pickBySection (regex 分类) + summarizeBatch (仅翻译) 两步。
// LLM 一次通读 80 条候选 → 选出 20 条 + 分类 + 打 tag + 评级 + 翻译。
// Reviewer 第二次调用做去重/分类/tag/评级一致性审查；fail 则 loop 回 writer，最多 2 次。
// 凑数 / 八卦 / 占位符等问题在 prompt 内通过明确 exclusion 解决。

function buildSectionsPromptBlock(secDef) {
  const lines = [];
  lines.push(`## 5 个 section 定义（硬约束 — 必须严格归入其中之一）`);
  for (const s of secDef.sections) {
    lines.push(`\n### ${s.id} — ${s.label_zh} ${s.emoji}（quota=${s.quota}${s.extended_window ? ", extended_window=允许" : ""}）`);
    lines.push(`Include:`);
    for (const r of s.include) lines.push(`  - ${r}`);
    lines.push(`Exclude:`);
    for (const r of s.exclude) lines.push(`  - ${r}`);
    if (s.geography) {
      lines.push(`地理范围: ${s.geography.join("; ")}`);
    }
    if (s.geography_excluded) {
      lines.push(`地理排除: ${s.geography_excluded.join("; ")}`);
    }
  }
  lines.push(`\n## Edge cases`);
  for (const e of secDef.edge_cases) {
    lines.push(`- ${e.scenario} → ${e.rule}`);
  }
  lines.push(`\n## 硬性排除规则`);
  lines.push(`- ${secDef.global_rules.exclusion_floor}`);
  lines.push(`- 同一事件 / 同一标的的不同条目必须合并为单条，引用最权威信源`);
  return lines.join("\n");
}

function buildTagsPromptBlock(tagsDef) {
  const lines = [];
  lines.push(`## Tag 白名单（必须从此处选，不允许自创）`);
  lines.push(`约束：每条最多 ${tagsDef.constraints.max_tags_per_item} 个 tag；asset/geo/actor 各最多 1 个，topic 最多 2 个；父子关系（如 dfw ⊂ texas ⊂ sun-belt）只打最具体的那个。`);
  for (const [dimName, dim] of Object.entries(tagsDef.dimensions)) {
    lines.push(`\n### ${dimName} — ${dim._desc}`);
    for (const t of dim.tags) {
      lines.push(`  - ${t.id}: ${t.applies_to}`);
    }
  }
  return lines.join("\n");
}

function buildCandidatesBlock(candidates) {
  return candidates.map((it, i) => {
    const ageH = it.published_at ? ((Date.now() - it.published_at) / 3600_000).toFixed(0) : "?";
    const body = (it.description || "").slice(0, 1500);
    const srcTags = (it.source_tags || []).join(",");
    const extFlag = it._ext_eligible ? " [EXT-7D]" : "";
    return `[${i + 1}] (${it.source_name}, tier=${it.source_tier}, ${ageH}h ago${extFlag}, region=${it.region}, src_tags=[${srcTags}], score=${it.score})\nTitle: ${it.title}\nBody: ${body}`;
  }).join("\n\n");
}

// LLM fetch with SSE streaming + retry on 5xx / 429 / network errors.
// Streaming keeps bytes flowing chunk-by-chunk so proxies don't trip
// gateway timeouts (e.g. Cloudflare 524 fires when a proxy sees no bytes
// from origin within ~100s). 3 attempts, backoff 1s/5s/30s. Returns the
// fully assembled assistant text.
async function fetchLLMWithRetry(endpoint, body, apiKey, label) {
  // 上游中转（ne.aineapi.com）抖动多为秒级自愈的 5xx（do_request_failed / 502 / 503）；
  // 给足调用内重试预算，多数瞬时故障在此自愈，不用拖到 1h 的 workflow 级重试。
  const RETRY_DELAYS = [1000, 4000, 12000, 40000];   // 4 次重试，累计退避 ~57s
  const MAX_ATTEMPTS = RETRY_DELAYS.length + 1;        // 共 5 次尝试
  const isRetryable = (s) => s === 408 || s === 429 || (s >= 500 && s < 600);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let r;
    try {
      r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({ ...body, stream: true }),
      });
    } catch (e) {
      if (attempt < MAX_ATTEMPTS - 1) {
        const wait = RETRY_DELAYS[attempt];
        log(`🔁 ${label} network error (${e.message}), retrying in ${wait}ms (${attempt + 1}/${MAX_ATTEMPTS})`);
        await new Promise(res => setTimeout(res, wait));
        continue;
      }
      throw e;
    }
    if (!r.ok) {
      if (isRetryable(r.status) && attempt < MAX_ATTEMPTS - 1) {
        const errPeek = (await r.text()).slice(0, 200);
        const wait = RETRY_DELAYS[attempt];
        log(`🔁 ${label} API ${r.status} (${errPeek}), retrying in ${wait}ms (${attempt + 1}/${MAX_ATTEMPTS})`);
        await new Promise(res => setTimeout(res, wait));
        continue;
      }
      const errText = (await r.text()).slice(0, 500);
      throw new Error(`${label} API ${r.status}: ${errText}`);
    }

    try {
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let out = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const ln of lines) {
          const t = ln.trim();
          if (!t.startsWith("data:")) continue;
          const payload = t.slice(5).trim();
          if (payload === "[DONE]") return out;
          try {
            const obj = JSON.parse(payload);
            const delta = obj.choices?.[0]?.delta?.content ?? "";
            out += delta;
          } catch { /* skip keepalive / non-JSON frames */ }
        }
      }
      return out;
    } catch (e) {
      if (attempt < MAX_ATTEMPTS - 1) {
        const wait = RETRY_DELAYS[attempt];
        log(`🔁 ${label} stream interrupted (${e.message}), retrying in ${wait}ms (${attempt + 1}/${MAX_ATTEMPTS})`);
        await new Promise(res => setTimeout(res, wait));
        continue;
      }
      throw e;
    }
  }
  throw new Error(`${label} API: exhausted retries`);
}

async function callLLM(systemPrompt, userPrompt, opts, label = "llm") {
  const text = await fetchLLMWithRetry(opts.endpoint, {
    model: opts.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: opts.maxTokens || 6000,
    temperature: opts.temperature ?? 0.3,
  }, opts.apiKey, label);
  return text.replace(/```json\s*/g, "").replace(/```\s*$/g, "").trim();
}

// 提取 stream of top-level JSON objects（处理 LLM 偶尔吐 NDJSON / 多对象未包数组的情况）
// 用 brace 计数法，跳过字符串内的 { } 不计入深度
function extractJSONObjects(text) {
  const out = [];
  let depth = 0, inStr = false, escape = false, start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (c === "\\") escape = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try { out.push(JSON.parse(text.slice(start, i + 1))); } catch {}
        start = -1;
      }
    }
  }
  return out;
}

// expectArray=true 时，若 JSON.parse 失败或返回非数组，尝试用 brace counting 提取多个对象
function safeParseJSON(text, label, expectArray = false) {
  try {
    const v = JSON.parse(text);
    if (expectArray && !Array.isArray(v)) {
      // single object 包成 array — 偶尔 LLM 只返回一个对象代表"只有一条"
      return [v];
    }
    return v;
  } catch (e) {
    if (expectArray) {
      const objs = extractJSONObjects(text);
      if (objs.length > 0) {
        log(`🤖 ${label} fallback parse: extracted ${objs.length} object(s) from non-array stream`);
        return objs;
      }
    }
    log(`🤖 ${label} raw (first 600): ${text.slice(0, 600)}`);
    throw new Error(`${label} JSON parse failed: ${e.message}`);
  }
}

async function globalPassWriter(candidates, opts, priorOutput, priorIssues) {
  const sectionsBlock = buildSectionsPromptBlock(SECTIONS_DEF);
  const tagsBlock = buildTagsPromptBlock(TAGS_DEF);
  const candidatesBlock = buildCandidatesBlock(candidates);

  const quotas = SECTIONS_DEF.sections.map(s => `${s.id}=${s.quota}`).join(", ");
  const sectionIds = SECTIONS_DEF.sections.map(s => s.id);
  const validImpacts = ["long-pos", "short-pos", "neutral", "short-neg", "long-neg"];

  const systemPrompt = `你是美国住宅地产中文研究员，每天从 ${candidates.length} 条候选新闻中选出最重要的 20 条。你的判断必须横向比较所有候选，不是逐条独立处理。所有 t / s 字段用中文输出（保留行业英文术语）。`;

  let feedbackBlock = "";
  if (priorOutput && priorIssues) {
    // 反馈给 writer 时限到最严重的 8 条；issue_type 优先级：should_exclude > duplicate > section_wrong > quota_violation > 其他
    const SEVERITY = {
      should_exclude: 0, duplicate: 1, section_wrong: 2, quota_violation: 3,
      tag_invalid: 4, incomplete: 5, rating_imbalance: 6, tag_redundant: 7,
    };
    const sortedIssues = [...priorIssues].sort((a, b) =>
      (SEVERITY[a.issue_type] ?? 99) - (SEVERITY[b.issue_type] ?? 99)
    );
    const topIssues = sortedIssues.slice(0, 8);
    const issuesStr = topIssues.map(x =>
      `- item_id=${x.item_id} type=${x.issue_type}: ${x.description}${x.suggested_fix ? ` → 建议: ${x.suggested_fix}` : ""}`
    ).join("\n");
    const more = priorIssues.length > topIssues.length ? `\n（reviewer 还指出了 ${priorIssues.length - topIssues.length} 条次要问题，未列出 — 你修好上面这些再说）` : "";
    feedbackBlock = `\n\n## 上一轮 Reviewer 反馈（必须修复，按严重程度排序）\n${issuesStr}${more}\n\n请重新选择 / 重新分类 / 重新打 tag / 重新评级，修正这些问题。`;
  }

  const userPrompt = `${sectionsBlock}

${tagsBlock}

## 任务
从下方 ${candidates.length} 条候选中，选出最重要的 20 条美国住宅 / 商业地产新闻，并对每条做：
1. 归入 5 个 section 之一：${sectionIds.join(" | ")}
2. 配额硬约束（不能多不能少）：${quotas}（合计 20）
3. 打 tag（从白名单选，约束见 tag 章节）
4. 评级 importance ∈ [1,5] 整数 + impact ∈ {${validImpacts.join("|")}}
5. 中文译标 t（≤ 30 中文字符）+ 中文摘要 s（≤ 60 中文字符，必给结论/数字/立场）
6. reason: 2 句话说明为什么选这条 + 为什么归这个 section（用于 audit）

## 排序与挑选原则
- **横向比较所有 ${candidates.length} 条**，按系统性影响 / 数字规模 / 受众相关度排序，取 top 20
- **凑数禁令**：宁可某 section 不达 quota（reviewer 会 flag 但允许），也不要塞低信号条目。但目前要求满足 quota，所以若某 section 候选不足，从该 section 池里挑次优而非塞错类
- **去重**：同一事件 / 同一公司同一交易 / 同一数据点的不同来源报道，合并为单条，pick 最权威信源
- **硬性排除**：celebrity / 八卦 / 单 unit listing / 单 broker 任命 / design trends / coaching webinar / 信息残缺（"详情待披露"）必须淘汰
- **[EXT-7D] 标记的候选**：来自 7 天扩展窗口（不在 24h 新鲜池），仅当对应 section 是扩窗类（sunbelt / btr / institutional）才允许选；且每个 section 的扩窗条目 ≤ 1 条优先

## importance 分级（强制分布：≥ 2 条 imp=5，≥ 4 条 imp=4，≤ 5 条 imp ≤ 2）
- imp=5: systemic — Fed 决策 / 大型基金巨额募资 / 头部 REIT 财报或违约 / 联邦立法重大 / 关键宏观数据
- imp=4: 行业中等 — 单 deal $200M+ / 大型 IPO 或并购 / Sun Belt 关键 metro 房市拐点 / 重要监管政策
- imp=3: 常规动态 — 单 deal $50-200M / 区域月度趋势 / 中型公司业绩 / 政策细节
- imp=2: 花絮 — 个人公司任命 / 设计趋势 / 小型扩张 / 已知信息的不同角度
- imp=1: 边缘 — 评论而非新闻 / 八卦 / 单个 listing

## 中英文混排示例
{"i":1, "section":"national", "tags":["housing","rates","macro"], "t":"30Y mortgage 升至月内高位，first-time 购房者掉队", "s":"上周 mortgage rate 上行致 loan demand 回落，平均贷款额上升说明中低收入买家退出", "imp":4, "dir":"short-neg", "reason":"全国住宅市场指标变化，影响所有买家；归 national 因为是宏观利率新闻而非区域市场。"}
{"i":2, "section":"sunbelt", "tags":["multifamily","dfw","trend"], "t":"MAA Q1：Sun Belt multifamily rent growth 拐点显现", "s":"Mid-America Apartment Communities Q1 业绩 — Sun Belt 入住率回升、rent growth 拐点出现", "imp":5, "dir":"long-pos", "reason":"Sun Belt 区域租金拐点信号，对德州 multifamily 直接利好；MAA 主营 Sun Belt 故归 sunbelt 而非 cre。"}

## 保留英文术语
公司 / 媒体 / 人名（Blackstone / KKR / MAA / INVH ...）；行业缩写（REIT, IPO, M&A, BTR, SFR, NOI, LTV, DSCR, cap rate, refi, special servicing）；政府机构（Fed, FOMC, FHFA, HUD, Treasury, CFPB, SEC）；数据指标（JOLTS, CPI, PMMS, Case-Shiller）；单位（Q1, $1.75B, 475K SF, 6.3%, 30Y mortgage, bps）；英文地名（Manhattan, Sun Belt, Houston, Austin, DFW）。

## 输出格式（极其严格 — retry 时尤其要按这个）
- **必须是单个 JSON 数组**：以 \`[\` 开头，以 \`]\` 结尾
- **不要 NDJSON**（不要每行一个对象不包数组）
- **不要 markdown code fence**（不要包 \`\`\`json \`\`\`）
- **不要解释文字**（除 reason 字段外，输出里不要任何中文/英文说明）
- 数组长度严格 = 20，按 section 顺序排列（national → sunbelt → btr → cre → institutional），每 section 内按 importance × 5 + 综合判断降序
- 每条字段：
{"i": <候选序号>, "section": "<id>", "tags": [...], "t": "<中文标题>", "s": "<中文摘要>", "imp": <1-5>, "dir": "<long-pos|short-pos|neutral|short-neg|long-neg>", "reason": "<选取与归类理由>"}

## 候选 ${candidates.length} 条
${candidatesBlock}${feedbackBlock}

现在直接输出 JSON 数组（\`[\` 开头 \`]\` 结尾，无 code fence，无 NDJSON，无前后说明），20 条，严格满足 quota ${quotas}：`;

  log(`✍️  writer prompt size: ~${Math.round(userPrompt.length / 4)} tokens, candidates=${candidates.length}`);
  const text = await callLLM(systemPrompt, userPrompt, { ...opts, maxTokens: 8000 }, "writer");
  let parsed = safeParseJSON(text, "writer", true);
  if (!Array.isArray(parsed)) throw new Error(`writer returned non-array (got ${typeof parsed})`);
  // 限定到 DAILY_LIMIT 条 — LLM 偶尔会返回 19/21；多了 truncate，少了让 reviewer flag
  if (parsed.length > DAILY_LIMIT) {
    log(`✍️  writer returned ${parsed.length} items, truncating to ${DAILY_LIMIT}`);
    parsed = parsed.slice(0, DAILY_LIMIT);
  } else {
    log(`✍️  writer returned ${parsed.length} items`);
  }
  return parsed;
}

function reviewerSystemPrompt() {
  return `你是美国住宅地产新闻的资深 reviewer，对一份 20 条精选新闻做二阶审查。你审查的核心维度：去重 / tag 一致性 / 分类正确性 / 评级合理性 / 完整性。你不直接修改内容，只输出 issues 列表，由 writer 重做。判断要严格，但不要鸡蛋里挑骨头 — 只 flag 实际影响阅读体验的问题。`;
}

async function reviewerAgent(writerOutput, opts) {
  const sectionsBlock = buildSectionsPromptBlock(SECTIONS_DEF);
  const tagsBlock = buildTagsPromptBlock(TAGS_DEF);
  const validImpacts = ["long-pos", "short-pos", "neutral", "short-neg", "long-neg"];
  const validSections = SECTIONS_DEF.sections.map(s => s.id);
  const allTags = new Set();
  for (const dim of Object.values(TAGS_DEF.dimensions)) for (const t of dim.tags) allTags.add(t.id);
  const tagDimMap = {};
  for (const [dimName, dim] of Object.entries(TAGS_DEF.dimensions)) {
    for (const t of dim.tags) tagDimMap[t.id] = dimName;
  }

  const itemsBlock = writerOutput.map((it, idx) => {
    const tagsList = (it.tags || []).map(t => `${t}(${tagDimMap[t] || "?"})`).join(", ");
    return `[${idx + 1}] section=${it.section} imp=${it.imp ?? it.importance} dir=${it.dir ?? it.impact}\n  t: ${it.t || it.title_zh}\n  s: ${it.s || it.summary_zh}\n  tags: ${tagsList}\n  reason: ${it.reason || "(无)"}`;
  }).join("\n\n");

  const userPrompt = `${sectionsBlock}

${tagsBlock}

## 待审查的 20 条 writer 产出

${itemsBlock}

## 审查清单
对上面 20 条逐条审查：

1. **section 正确性**：每条的 section 是否符合 sections 定义？典型错误 — Sun Belt 城市的 office 被塞进 sunbelt（应归 cre）；celebrity 新闻被塞进任何 section（应不入选）；BTR/SFR 项目被塞进 sunbelt（应归 btr）。
2. **section 配额**：实际分布是否符合 ${SECTIONS_DEF.sections.map(s => `${s.id}=${s.quota}`).join(", ")}？
3. **tag 合法性**：每条的 tag 是否全部在白名单内？是否同 dimension 重复？是否打了父子重叠（texas + dfw + sun-belt）？
4. **去重**：是否存在同一事件 / 同一公司同一交易 / 同一数据点的多条？
5. **评级合理性**：imp 分布是否满足 ≥ 2 条 imp=5、≥ 4 条 imp=4、≤ 5 条 imp ≤ 2？是否存在明显失衡（重大政策 imp=2，八卦 imp=5）？
6. **完整性**：是否有信息残缺条目（"详情待披露"、s 没结论 / 没数字 / 没立场、t 仍是英文）？
7. **硬性排除**：是否混入 celebrity / 八卦 / 单 unit listing / 单 broker 任命？

## 输出格式
JSON 对象（无 markdown code fence）：
{
  "status": "pass" | "fail",
  "issues": [
    {"item_id": <1-20>, "issue_type": "section_wrong" | "tag_invalid" | "tag_redundant" | "duplicate" | "rating_imbalance" | "incomplete" | "should_exclude" | "quota_violation", "description": "<具体问题>", "suggested_fix": "<建议>"}
  ],
  "overall_quality_note": "<一句话总评>"
}

判定：issues 为空或全部是无关紧要的小瑕疵 → status=pass；存在分类错位 / 八卦 / 配额违反 / 多条重复 → status=fail。

请直接输出 JSON：`;

  log(`👁️  reviewer prompt size: ~${Math.round(userPrompt.length / 4)} tokens`);
  const text = await callLLM(reviewerSystemPrompt(), userPrompt, { ...opts, maxTokens: 3000, temperature: 0.2 }, "reviewer");
  const parsed = safeParseJSON(text, "reviewer");
  if (typeof parsed.status !== "string") throw new Error(`reviewer returned no status field`);
  if (!Array.isArray(parsed.issues)) parsed.issues = [];
  log(`👁️  reviewer status=${parsed.status} issues=${parsed.issues.length}`);
  return parsed;
}

// 把 writer 输出的 {i, section, tags, t, s, imp, dir, reason} 映射回我们 pipeline 的标准 item shape
function applyWriterOutput(candidates, writerItems) {
  const validImpacts = new Set(["long-pos", "short-pos", "neutral", "short-neg", "long-neg"]);
  const validSections = new Set(SECTIONS_DEF.sections.map(s => s.id));
  const allTags = new Set();
  for (const dim of Object.values(TAGS_DEF.dimensions)) for (const t of dim.tags) allTags.add(t.id);
  const fetchedAt = Date.now();
  const out = [];
  for (const w of writerItems) {
    const candIdx = (typeof w.i === "number" ? w.i : parseInt(w.i, 10)) - 1;
    if (candIdx < 0 || candIdx >= candidates.length) {
      log(`⚠️  writer returned invalid candidate index ${w.i} (pool size ${candidates.length}) — skip`);
      continue;
    }
    const cand = candidates[candIdx];
    const tags = Array.isArray(w.tags) ? w.tags.filter(t => allTags.has(t)) : [];
    const section = validSections.has(w.section) ? w.section : "national";
    const imp = Math.max(1, Math.min(5, Math.round(Number(w.imp) || 3)));
    const dir = validImpacts.has(w.dir) ? w.dir : "neutral";
    const item = {
      ...cand,
      id: hashLink(cand.link),
      section,
      tags,
      title_zh: w.t || "",
      summary_zh: w.s || "（摘要生成失败）",
      importance: imp,
      impact: dir,
      writer_reason: w.reason || "",
      fetched_at: fetchedAt,
    };
    if (cand._ext_eligible) {
      item.extended_window = true;
      delete item._ext_eligible;
    }
    out.push(item);
  }
  return out;
}

// 主入口：writer + reviewer + loop
async function writerReviewerLoop(candidates, opts) {
  const audit = [];
  let writerItems = await globalPassWriter(candidates, opts);
  let reviewResult = await reviewerAgent(writerItems, opts);
  audit.push({ round: 1, status: reviewResult.status, issues: reviewResult.issues, note: reviewResult.overall_quality_note });

  let loopCount = 0;
  while (reviewResult.status === "fail" && loopCount < REVIEWER_MAX_LOOPS) {
    loopCount++;
    log(`🔁 reviewer fail — retry ${loopCount}/${REVIEWER_MAX_LOOPS}`);
    writerItems = await globalPassWriter(candidates, opts, writerItems, reviewResult.issues);
    reviewResult = await reviewerAgent(writerItems, opts);
    audit.push({ round: loopCount + 1, status: reviewResult.status, issues: reviewResult.issues, note: reviewResult.overall_quality_note });
  }

  if (reviewResult.status === "fail") {
    log(`⚠️  reviewer still fail after ${REVIEWER_MAX_LOOPS} retries — publishing anyway with audit log`);
  }

  const items = applyWriterOutput(candidates, writerItems);
  return { items, audit, candidate_pool_size: candidates.length };
}

// ============================================================
// 多 Agent Pipeline（WRITER_MODE=global v2 — 默认）
// ============================================================
// Stage 1 [filter, 已有]: time + dedupe → 100-200 candidates
// Stage 2 [Agent A: Selector]: 100-200 → 选 30-40 最重要 + imp 评级
// Stage 3 [Agent B: Tagger]: 30-40 → 4 维度白名单打 tag
// Stage 4 [Agent C: Dedupe]: 跨条目重复合并（基于 title + tag + entity）
// Stage 5 [脚本: classifyByTags]: tag → section（rule-based, 完全可解释）
// Stage 6 [脚本: pickFinal20]: section 配额 + 德州三城硬约束 + ≥2/section
// Stage 7 [Agent D: Translator]: 选定的 20 条做翻译 + dir + reason
// 每 stage 职责单一，prompt 简单，准确性可独立验证。无需 reviewer。

// SELECTOR_TARGET_MIN 必须 ≥ DAILY_LIMIT，否则下游 fallback 接管 selector 没看过的低质条目
const SELECTOR_TARGET_MIN = 25;
const SELECTOR_TARGET_MAX = 40;

function buildSelectorCandidatesBlock(candidates) {
  // Body slice kept short — selector only needs enough context to judge importance,
  // and larger prompts push the LLM proxy past its ~2min Cloudflare gateway timeout.
  return candidates.map((it, i) => {
    const ageH = it.published_at ? ((Date.now() - it.published_at) / 3600_000).toFixed(0) : "?";
    const body = (it.description || "").slice(0, 400);
    const ext = it._ext_eligible ? " [EXT-7D]" : "";
    return `[${i + 1}] (${it.source_name}, tier=${it.source_tier}, ${ageH}h ago${ext}, region=${it.region})\nTitle: ${it.title}\nBody: ${body}`;
  }).join("\n\n");
}

// Stage 2: 重要性选择器 — 不打 tag，不分 section，不翻译，专心评估"哪些值得选"
async function importanceSelector(candidates, opts) {
  const target = Math.min(SELECTOR_TARGET_MAX, Math.max(SELECTOR_TARGET_MIN, Math.floor(candidates.length * 0.35)));
  const block = buildSelectorCandidatesBlock(candidates);

  const systemPrompt = `你是新闻重要性评估专家。任务：从一批美国住宅 / 商业地产新闻中识别最重要的若干条，评出 importance 分。你不打标签、不分类、不翻译 — 只关心"这条新闻有多重要"。`;

  const userPrompt = `从下方 ${candidates.length} 条候选中，选出 ${target} 条（**最少 ${SELECTOR_TARGET_MIN} 条，最多 ${SELECTOR_TARGET_MAX} 条；少于 ${SELECTOR_TARGET_MIN} 视为失败**）。

下游需要从你选的池子里挑 20 条最终发布。如果你选 < ${SELECTOR_TARGET_MIN} 条，下游会从未筛选的 raw 候选里凑数（质量低）。所以**即使候选池整体偏弱**，你也要选够 ${SELECTOR_TARGET_MIN} 条，把弱信号条目打 imp=2 / imp=3 也得选上，让下游有更多选择空间。但仍要严格执行硬性排除（celebrity / 单 listing / meta 页面 / 信息残缺 / 重复报道）。

## 评分标准
imp=5: systemic — Fed 决策 / 大型基金巨额募资（$500M+）/ 头部 REIT 财报或违约 / 联邦立法重大变动 / 关键宏观数据（CPI / 就业 / 房价指数）
imp=4: 行业中等 — 单 deal $200M+ / 大型 IPO 或并购 / Sun Belt 关键 metro 房市拐点信号 / 重要监管政策
imp=3: 常规动态 — 单 deal $50-200M / 区域市场月度趋势 / 中型公司业绩 / 政策细节
imp=2: 花絮 — 个人公司任命 / 设计趋势 / 小型扩张 / 已知信息的不同角度报道
imp=1: 边缘 — 评论而非新闻 / 八卦

## 强制分布（必须严格满足）
- 至少 3 条 imp=5
- 至少 6 条 imp=4
- 至多 5 条 imp ≤ 2

## 主题多样性约束（重要！下游有 5 个 section 配额需要覆盖）
最终展示有 5 个 section（quota: 全国住宅=5 / Sun Belt 住宅=4 / BTR-SFR=3 / 全国 CRE=5 / 全国机构资本=3）。请确保你选出的 ${target} 条尽可能覆盖以下 5 个主题方向，每个方向至少留出足够候选给下游：

- **全国住宅市场**（mortgage / 利率 / 全国销量库存 / 联邦政策）：选 ≥ 7 条
- **Sun Belt 住宅**（Texas / Florida / Arizona / Georgia / NC 等的住宅、多户、租赁）：选 ≥ 5 条
- **BTR / SFR**（build-to-rent / single-family rental / SFR portfolio / NRHC / Invitation Homes / INVH / American Homes 4 Rent / AMH / Tricon / Pretium / Progress Residential / FirstKey Homes / Main Street Renewal / Home Partners / Roofstock 等）：选 ≥ 4 条。**这些公司 / 关键词只要在 title 或 body 出现就视为 BTR 候选，必须考虑入选**
- **全国 CRE**（office / industrial / data-center / hotel / retail / 非 Sun Belt 多户）：选 ≥ 7 条
- **机构资本**（PE 房地产基金募资 / REIT IPO / Blackstone / KKR / Brookfield 等机构动作）：选 ≥ 4 条

如果某主题方向候选池真的不足（如 BTR 当天 0 条），就尽量选相关性强的；不要把名额全给 national 或 cre 一种主题。

## 硬性排除（这些必须不入选）
- celebrity / 名人 / 八卦
- 单 unit listing / 单豪宅租赁
- 单 broker / 单 agent 任命公告
- design trends / coaching / webinar
- 信息残缺（"详情待披露"、"具体数据 pending"等）
- 重复报道（同一事件优先选 tier 最高的信源那条）

## 输出格式
JSON 数组（必须以 [ 开头 ] 结尾，不要 markdown，不要解释）：
[{"i": <候选序号>, "imp": <1-5>, "reason": "<2句中文：为什么选 + 为什么这个 imp>"}]

## 候选 ${candidates.length} 条
${block}

直接输出 JSON 数组：`;

  log(`📋 selector prompt size: ~${Math.round(userPrompt.length / 4)} tokens, candidates=${candidates.length}, target=${target}`);
  const text = await callLLM(systemPrompt, userPrompt, { ...opts, maxTokens: 6000 }, "selector");
  let parsed = safeParseJSON(text, "selector", true);
  if (!Array.isArray(parsed)) throw new Error(`selector returned non-array`);

  // 应用到候选：返回选中的 candidate items + imp/reason 注入
  const selected = [];
  for (const s of parsed) {
    const idx = (typeof s.i === "number" ? s.i : parseInt(s.i, 10)) - 1;
    if (idx < 0 || idx >= candidates.length) continue;
    const imp = Math.max(1, Math.min(5, Math.round(Number(s.imp) || 3)));
    selected.push({ ...candidates[idx], importance: imp, selector_reason: s.reason || "" });
  }
  log(`📋 selector picked ${selected.length} items (imp dist: ${JSON.stringify(selected.reduce((a, x) => { a[x.importance] = (a[x.importance] || 0) + 1; return a; }, {}))})`);
  return selected;
}

// Stage 3: Tagger — 4 维度白名单打 tag + 直接产出 section（5 选 1）
async function tagger(items, opts) {
  const tagsBlock = buildTagsPromptBlock(TAGS_DEF);
  // 紧凑的 section 定义（仅给 tagger 决策用，避免 prompt 过长）
  const sectionGuide = SECTIONS_DEF.sections.map(s =>
    `- **${s.id}** (${s.label_zh})：${s.include[0]}${s.include[1] ? "；" + s.include[1] : ""}`
  ).join("\n");
  const sectionEdges = SECTIONS_DEF.edge_cases.slice(0, 5).map(e =>
    `- ${e.scenario} → ${e.rule}`
  ).join("\n");

  const itemsBlock = items.map((it, i) =>
    `[${i + 1}] ${it.title}\nBody: ${(it.description || "").slice(0, 800)}`
  ).join("\n\n");

  const systemPrompt = `你是新闻 tag + section 打标专家。给每条新闻按 4 维度白名单打 tag，并归入 5 个 section 之一。你不选新闻、不评级、不翻译 — 只关心 tag 准确性和 section 归属。`;

  const userPrompt = `${tagsBlock}

## Section 归属（每条必须选 1 个）
${sectionGuide}

### 关键边界规则
${sectionEdges}

## 任务
给下方 ${items.length} 条新闻每条产出 section + tags。严格遵守 tag 白名单与维度上限；section 必须 ∈ {national, sunbelt, btr, cre, institutional}。

## 输出格式
JSON 数组（[ 开头 ] 结尾，无 markdown，无解释）：
[{"i": <候选序号>, "section": "<id>", "tags": [<canonical-id>, ...]}]

## 新闻列表
${itemsBlock}

直接输出 JSON 数组：`;

  log(`🏷️  tagger prompt size: ~${Math.round(userPrompt.length / 4)} tokens, items=${items.length}`);
  const text = await callLLM(systemPrompt, userPrompt, { ...opts, maxTokens: 4000 }, "tagger");
  const parsed = safeParseJSON(text, "tagger", true);
  if (!Array.isArray(parsed)) throw new Error(`tagger returned non-array`);

  const allTags = new Set();
  for (const dim of Object.values(TAGS_DEF.dimensions)) for (const t of dim.tags) allTags.add(t.id);
  const validSections = new Set(SECTIONS_DEF.sections.map(s => s.id));

  const tagMap = new Map();
  const secMap = new Map();
  for (const p of parsed) {
    const idx = (typeof p.i === "number" ? p.i : parseInt(p.i, 10)) - 1;
    const tags = Array.isArray(p.tags) ? p.tags.filter(t => allTags.has(t)) : [];
    const section = validSections.has(p.section) ? p.section : null;
    if (idx >= 0 && idx < items.length) {
      tagMap.set(idx, tags);
      if (section) secMap.set(idx, section);
    }
  }

  const result = items.map((it, idx) => ({
    ...it,
    tags: tagMap.get(idx) || it.tags || [],
    section: secMap.get(idx) || null, // 由 pickFinal20 兜底（classifyByTags）
  }));
  const avgTags = result.reduce((s, x) => s + (x.tags || []).length, 0) / result.length;
  const taggedSec = result.filter(it => it.section).length;
  const dist = result.reduce((a, x) => { const s = x.section || "?"; a[s] = (a[s] || 0) + 1; return a; }, {});
  log(`🏷️  tagger done — avg ${avgTags.toFixed(1)} tags/item, section打标=${taggedSec}/${result.length}, dist=${JSON.stringify(dist)}`);
  return result;
}

// Stage 4: 跨条目去重 — LLM-based, 输入精简（只看 title + tags），输出合并组
async function llmDedupe(items, opts) {
  if (items.length < 2) return items;
  const block = items.map((it, i) =>
    `[${i + 1}] (${it.source_name}, tier=${it.source_tier}, imp=${it.importance}, tags=[${(it.tags||[]).join(",")}])\n  ${it.title}`
  ).join("\n");

  const systemPrompt = `你是新闻去重专家。识别下方列表中"同一事件 / 同一公司同一交易 / 同一数据点"的不同来源报道，标出哪些应合并。`;

  const userPrompt = `## 去重规则
- 同一公司 + 同一动作（财报 / 募资 / 并购）→ 同一事件
- 同一数据指标 + 相同时间窗 → 同一事件
- 同一立法 / 政策 → 同一事件
- 仅 title 措辞不同但讲同一件事 → 同一事件
- 不同公司、不同事件 → 不合并（即使主题相同，如两个独立 BTR 项目）

## 保留规则（同组中保留哪条）
1. 优先保留 tier 高（A > B > D > E）
2. 同 tier 优先保留 imp 高
3. 同 imp 优先保留 title 信息更完整

## 输出格式
JSON（[ 开头 ] 结尾不行，这次输出对象，{ 开头 } 结尾）：
{"groups": [{"keep": <候选序号>, "drop": [<候选序号>, ...]}]}

如果没有重复，输出 {"groups": []}。

## 候选 ${items.length} 条
${block}

直接输出 JSON 对象：`;

  log(`🔍 dedupe prompt size: ~${Math.round(userPrompt.length / 4)} tokens, items=${items.length}`);
  // dedupe 非关键路径：上游挂到此步时与其 FATAL 整个 build，不如跳过去重直接发
  // （宁可偶有重复，也别因为去重一步丢掉整天的报）。
  let text;
  try {
    text = await callLLM(systemPrompt, userPrompt, { ...opts, maxTokens: 2000 }, "dedupe");
  } catch (e) {
    log(`⚠️  dedupe LLM call failed, skipping LLM dedupe (publishing un-deduped): ${e.message}`);
    return items;
  }
  let parsed;
  try { parsed = safeParseJSON(text, "dedupe", false); } catch (e) {
    log(`⚠️  dedupe parse failed, skipping LLM dedupe: ${e.message}`);
    return items;
  }
  const groups = Array.isArray(parsed?.groups) ? parsed.groups : [];
  if (groups.length === 0) {
    log(`🔍 dedupe: no duplicates found`);
    return items;
  }
  const dropSet = new Set();
  for (const g of groups) {
    const drops = Array.isArray(g.drop) ? g.drop : [];
    for (const d of drops) {
      const idx = (typeof d === "number" ? d : parseInt(d, 10)) - 1;
      if (idx >= 0 && idx < items.length) dropSet.add(idx);
    }
  }
  const kept = items.filter((_, i) => !dropSet.has(i));
  log(`🔍 dedupe: ${items.length} → ${kept.length} (merged ${dropSet.size} duplicates across ${groups.length} groups)`);
  return kept;
}

// Stage 5: 规则化 tag → section 分类（不依赖 LLM，完全可解释）
function classifyByTags(item) {
  const tags = new Set(item.tags || []);
  const has = (t) => tags.has(t);
  const hasAny = (...ts) => ts.some(t => tags.has(t));

  const SUNBELT_GEOS = ["sun-belt", "texas", "dfw", "houston", "austin", "phoenix", "florida", "atlanta", "carolinas", "nashville", "las-vegas"];
  const CRE_ASSETS = ["office", "industrial", "data-center", "retail", "hotel", "senior-housing", "life-sciences"];
  const inSunBelt = SUNBELT_GEOS.some(g => has(g));

  // 1. BTR/SFR 资产 → btr（最高优先级，资产实质优先）
  if (has("btr-sfr")) return "btr";

  // 2. CRE 类资产（office/industrial/data-center/retail/hotel/senior-housing/life-sciences）→ cre
  //    注：即使是 Sun Belt 城市的 office，也归 cre（资产维度优先于地理）
  if (CRE_ASSETS.some(a => has(a))) return "cre";

  // 3. 机构资本相关：actor=institutional + topic=fundraising/ipo/deals → institutional
  //    （非 BTR/CRE 资产前提下，机构动作本身是新闻主体）
  if (has("institutional") && hasAny("fundraising", "ipo")) return "institutional";

  // 4. multifamily 资产：地理决定归属
  //    Sun Belt geo → sunbelt（地理优先 — Sun Belt 多户是 Sun Belt 主题）
  //    其他 → cre（多户公寓属于 CRE 范畴）
  if (has("multifamily")) {
    return inSunBelt ? "sunbelt" : "cre";
  }

  // 5. housing 资产：地理决定归属
  //    Sun Belt geo → sunbelt
  //    national / 其他 → national
  if (has("housing")) {
    return inSunBelt ? "sunbelt" : "national";
  }

  // 6. 无具体资产标签但有 fundraising/ipo + actor=institutional → institutional
  if (has("institutional") && hasAny("fundraising", "ipo", "deals")) return "institutional";

  // 7. mixed-asset 兜底
  if (has("mixed-asset")) {
    if (has("institutional")) return "institutional";
    return inSunBelt ? "sunbelt" : "national";
  }

  // 8. 完全无资产 tag — 看 actor / topic
  if (has("regulator") || has("policy") || has("rates") || has("macro") || has("data")) return "national";
  if (has("institutional")) return "institutional";

  // 兜底
  return "national";
}

// Stage 6: 规则化最终挑选 — section 配额 + 德州三城硬约束
// rawPool: selector 之前的 candidatePool，用于某 section 不足时兜底（用 legacy classify 找补）
function pickFinal20(items, rawPool = []) {
  // 配额（与 SECTIONS 对齐）
  const QUOTA = { national: 5, sunbelt: 4, btr: 3, cre: 5, institutional: 3 };
  const TX_REQUIRED = new Set(["sunbelt", "btr", "cre", "institutional"]);

  // 优先用 tagger 直接产出的 section；缺失才回 rule-based classifyByTags 兜底
  let useTagger = 0, useFallback = 0;
  const annotated = items.map(it => {
    if (it.section && ["national", "sunbelt", "btr", "cre", "institutional"].includes(it.section)) {
      useTagger++;
      return it;
    }
    useFallback++;
    return { ...it, section: classifyByTags(it) };
  });
  log(`📦 section source: tagger=${useTagger}, classifyByTags fallback=${useFallback}`);

  // 按 section 分桶
  const bySection = { national: [], sunbelt: [], btr: [], cre: [], institutional: [] };
  for (const it of annotated) if (bySection[it.section]) bySection[it.section].push(it);

  // 每桶按 imp desc, score desc 排序
  for (const s of Object.keys(bySection)) {
    bySection[s].sort((a, b) =>
      (b.importance ?? 3) - (a.importance ?? 3) || (b.score ?? 0) - (a.score ?? 0)
    );
  }

  log(`📦 section pool (post-tagger): ${Object.entries(bySection).map(([s, arr]) => `${s}=${arr.length}`).join(" ")}`);

  // 兜底池：把 raw candidatePool 里 selector 没选中的项目，按 legacy classify() 分桶
  // 这些项没经 tagger 打 tag，但 classify() 能给出粗略 section
  const selectedLinks = new Set(items.map(it => it.link));
  const fallbackBySection = { national: [], sunbelt: [], btr: [], cre: [], institutional: [] };
  for (const it of rawPool) {
    if (selectedLinks.has(it.link)) continue;
    const sec = classify(it); // legacy regex-based
    if (fallbackBySection[sec]) fallbackBySection[sec].push(it);
  }
  for (const s of Object.keys(fallbackBySection)) {
    fallbackBySection[s].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }
  log(`📦 fallback pool (raw candidates not selected): ${Object.entries(fallbackBySection).map(([s, arr]) => `${s}=${arr.length}`).join(" ")}`);

  const result = [];
  const txDiag = [];

  // 第一遍：每 section 先放德州三城（要求且有的），再按 imp 顺序填到 quota
  // 不足 quota 时，回 fallbackBySection 用 legacy classify 找补
  for (const [secId, quota] of Object.entries(QUOTA)) {
    const pool = bySection[secId];
    const picked = [];
    const pickedSet = new Set();

    // 德州三城（sunbelt/btr/cre/institutional 必备）
    if (TX_REQUIRED.has(secId) && pool.length > 0) {
      const txItem = pool.find(it => hitsTexasCity(it));
      if (txItem) {
        picked.push(txItem);
        pickedSet.add(txItem.link);
        txDiag.push(`${secId}:✓ taggerPool`);
      }
    }

    // 主池填充
    for (const it of pool) {
      if (picked.length >= quota) break;
      if (pickedSet.has(it.link)) continue;
      picked.push(it);
      pickedSet.add(it.link);
    }

    // 主池不足 → 回 fallback 池
    if (picked.length < quota) {
      const need = quota - picked.length;
      const fb = fallbackBySection[secId] || [];
      // 如果还没德州三城，优先从 fallback 找德州的
      let fbItems = fb;
      if (TX_REQUIRED.has(secId) && !picked.some(hitsTexasCity)) {
        const txFb = fb.find(it => hitsTexasCity(it));
        if (txFb) {
          picked.push({ ...txFb, importance: 3, _from_fallback: true });
          pickedSet.add(txFb.link);
          txDiag.push(`${secId}:✓ fallback`);
          fbItems = fb.filter(x => x.link !== txFb.link);
        }
      }
      // 剩余位用 fallback 高分填
      for (const it of fbItems) {
        if (picked.length >= quota) break;
        if (pickedSet.has(it.link)) continue;
        picked.push({ ...it, importance: it.importance ?? 3, _from_fallback: true });
        pickedSet.add(it.link);
      }
      log(`📦 section "${secId}" backfilled ${need - (quota - picked.length)} from raw pool (now ${picked.length}/${quota})`);
    }

    // 仍不足 → 真没料，记录但允许 publish
    if (picked.length < quota) {
      log(`⚠️  section "${secId}" still under quota after fallback: ${picked.length}/${quota}`);
    }
    if (TX_REQUIRED.has(secId) && !picked.some(hitsTexasCity)) {
      txDiag.push(`${secId}:✗ no-tx`);
    }

    for (const it of picked) {
      it.section = secId; // 确保 fallback 项也带 section
      result.push(it);
    }
  }
  log(`📦 texas-3-city: ${txDiag.join(" ")}`);

  // 总数 < 20 的兜底（极端供给短缺）
  if (result.length < DAILY_LIMIT) {
    const taken = new Set(result.map(x => x.link));
    // 先在 tagger 池里找
    const overflow = annotated
      .filter(x => !taken.has(x.link))
      .sort((a, b) => (b.importance ?? 3) - (a.importance ?? 3) || (b.score ?? 0) - (a.score ?? 0));
    for (const it of overflow) {
      if (result.length >= DAILY_LIMIT) break;
      result.push(it);
    }
    // 还不足 → raw fallback 池
    if (result.length < DAILY_LIMIT) {
      for (const fb of Object.values(fallbackBySection)) {
        for (const it of fb) {
          if (result.length >= DAILY_LIMIT) break;
          if (taken.has(it.link)) continue;
          result.push({ ...it, section: classify(it), importance: 3, _from_fallback: true });
          taken.add(it.link);
        }
      }
    }
    log(`📦 final backfill to ${result.length}/${DAILY_LIMIT}`);
  }

  if (result.length > DAILY_LIMIT) result.length = DAILY_LIMIT;

  // extended_window 标记
  for (const it of result) {
    if (it._ext_eligible) {
      it.extended_window = true;
      delete it._ext_eligible;
    }
  }
  return result;
}

// Stage 7: Translator — 翻译选定的 20 条
async function translator(items, opts) {
  const validImpacts = new Set(["long-pos", "short-pos", "neutral", "short-neg", "long-neg"]);

  async function tryBatch(batch) {
    if (batch.length === 0) return new Map();
    const block = batch.map((it, i) =>
      `[${i + 1}] section=${it.section} imp=${it.importance} tags=[${(it.tags||[]).join(",")}]\n  Title: ${it.title}\n  Body: ${(it.description || "").slice(0, 1500)}`
    ).join("\n\n");

    const systemPrompt = `你是美国住宅地产中文研究员，给已选定的新闻做中文译标 + 摘要 + 影响方向。所有 t / s 字段用中文（保留行业英文术语）。不选新闻、不打 tag、不分类。`;

    const userPrompt = `给下方 ${batch.length} 条新闻每条产出：
- t: 中文译标（≤ 30 中文字符），中文语序重组
- s: 中文摘要（≤ 60 中文字符），必给结论 / 数字 / 立场
- dir: long-pos / short-pos / neutral / short-neg / long-neg

## 中英混排（保留英文术语）
公司 / 媒体 / 人名（Blackstone, KKR, MAA, INVH...）；行业缩写（REIT, IPO, M&A, BTR, SFR, NOI, LTV, DSCR, cap rate, refi, special servicing）；政府机构（Fed, FOMC, FHFA, HUD, Treasury, CFPB, SEC）；数据指标（JOLTS, CPI, PMMS, Case-Shiller, new home sales, existing home sales, housing starts）；单位（Q1-Q4, $1.75B, 475K SF, 6.3%, 30Y mortgage, bps, YoY）；英文地名（Manhattan, Sun Belt, Houston, Austin, DFW）。

## 中英混排示例（必须严格仿照风格）
{"i":1, "t":"30Y mortgage 升至月内高位，first-time 购房者掉队", "s":"上周 mortgage rate 上行致 loan demand 回落，平均贷款额上升说明中低收入买家退出", "dir":"short-neg"}
{"i":2, "t":"MAA Q1：Sun Belt multifamily rent growth 拐点显现", "s":"Mid-America Apartment Communities Q1 业绩 — Sun Belt 入住率回升、rent growth 拐点出现", "dir":"long-pos"}

## 硬约束
✓ t / s 必须用中文写
✗ 禁止整句英文输出
✗ 禁止"详细见原文 / 见原文"等占位短语
✓ 正文不足时基于 title 推断，可写"细节待披露 / 影响待观察"

## 输出
JSON 数组（[ 开头 ] 结尾，无 markdown，无解释，长度严格 = ${batch.length}）：
[{"i": <序号>, "t": "<中文标>", "s": "<中文摘要>", "dir": "<方向>"}]

## 新闻列表
${block}

直接输出 JSON 数组：`;

    log(`🌐 translator prompt size: ~${Math.round(userPrompt.length / 4)} tokens, items=${batch.length}`);
    let text;
    try {
      text = await callLLM(systemPrompt, userPrompt, { ...opts, maxTokens: 6000 }, "translator");
    } catch (e) {
      // 内容风控被拒（high risk / policy / moderation）→ 折半 batch 重试，单条仍被拒就跳过、走 fallback
      const isRejection = /\b(400|403)\b.*(high risk|content.+polic|moderation|safety|rejected|blocked)/i.test(e.message);
      if (!isRejection) throw e;
      if (batch.length === 1) {
        log(`  ⚠️  translator: 单条被风控拒，跳过 — "${batch[0].title.slice(0, 60)}..."`);
        return new Map();
      }
      const mid = Math.ceil(batch.length / 2);
      log(`  ⚠️  translator: batch=${batch.length} 被风控拒，折半重试 → ${mid}/${batch.length - mid}`);
      const [lm, rm] = await Promise.all([tryBatch(batch.slice(0, mid)), tryBatch(batch.slice(mid))]);
      return new Map([...lm, ...rm]);
    }

    const parsed = safeParseJSON(text, "translator", true);
    if (!Array.isArray(parsed)) throw new Error(`translator returned non-array`);

    const map = new Map();
    for (const p of parsed) {
      const idx = (typeof p.i === "number" ? p.i : parseInt(p.i, 10)) - 1;
      if (idx < 0 || idx >= batch.length) continue;
      map.set(batch[idx].link, {
        title_zh: p.t || "",
        summary_zh: p.s || "（摘要生成失败）",
        impact: validImpacts.has(p.dir) ? p.dir : "neutral",
      });
    }
    return map;
  }

  const transByLink = await tryBatch(items);

  const fetchedAt = Date.now();
  return items.map((it) => {
    const tr = transByLink.get(it.link) || { title_zh: "", summary_zh: "（翻译丢失：内容被风控拦截）", impact: "neutral" };
    return { ...it, ...tr, id: hashLink(it.link), fetched_at: fetchedAt };
  });
}

// Orchestrator: 串起 7 stages
async function multiAgentPipeline(candidates, opts) {
  const audit = [];
  log(`🚀 multi-agent pipeline starting with ${candidates.length} candidates`);

  // 诊断：BTR / 各 section 在原始候选池里的关键词覆盖（title + body）
  const btrTermsRe = /\b(btr|build[-\s]?to[-\s]?rent|build[-\s]?for[-\s]?rent|sfr|single[-\s]?family\s+rental|rental\s+homes?|invitation\s+homes|invh|american\s+homes\s+4\s+rent|\bamh\b|tricon|pretium|progress\s+residential|home\s+partners|firstkey|main\s+street\s+renewal|roofstock|nrhc)\b/i;
  const btrInPool = candidates.filter(it => btrTermsRe.test(`${it.title} ${it.description || ""}`));
  log(`🔬 candidate pool BTR-term scan: ${btrInPool.length}/${candidates.length} items mention BTR/SFR companies or terms in title+body`);
  if (btrInPool.length > 0) {
    for (const it of btrInPool.slice(0, 5)) {
      log(`   • [${it.source_name}] ${it.title.slice(0, 100)}`);
    }
  }

  // Stage 2: importance selector
  const selected = await importanceSelector(candidates, opts);
  audit.push({ stage: "selector", input: candidates.length, output: selected.length });

  if (selected.length < DAILY_LIMIT) {
    log(`⚠️  selector returned only ${selected.length} items (< ${DAILY_LIMIT}) — pipeline may under-fill`);
  }

  // Stage 3: tagger
  const tagged = await tagger(selected, opts);
  audit.push({ stage: "tagger", items: tagged.length });

  // Stage 4: dedupe
  const deduped = await llmDedupe(tagged, opts);
  audit.push({ stage: "dedupe", before: tagged.length, after: deduped.length });

  // Stage 5: section classify (rule-based, no LLM call)
  // Done inline in pickFinal20 via classifyByTags

  // Stage 6: final pick (rule-based, no LLM call) — 把 raw candidates 也传过去做兜底
  const picked = pickFinal20(deduped, candidates);
  const sectionCount = {};
  for (const it of picked) sectionCount[it.section] = (sectionCount[it.section] || 0) + 1;
  log(`📦 final pick: ${JSON.stringify(sectionCount)} (total ${picked.length})`);
  audit.push({ stage: "pick", section_counts: sectionCount });

  // Stage 7: translator
  const translated = await translator(picked, opts);
  audit.push({ stage: "translator", items: translated.length });

  return { items: translated, audit, candidate_pool_size: candidates.length };
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
  const { upper, lower24h, lower48h, lower72h, lower7d } = computeWindowBounds(now);
  log(`⏰ 24h-bounds UTC [${new Date(lower24h).toISOString().slice(0,16)} ~ ${new Date(upper).toISOString().slice(0,16)})`);
  log(`⏰           北京 [${new Date(lower24h + 8*3600*1000).toISOString().slice(0,16).replace('T',' ')} ~ ${new Date(upper + 8*3600*1000).toISOString().slice(0,16).replace('T',' ')})`);

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

  // Build candidate pools for all three windows so we can pick adaptively.
  const filtered24h = scored.filter(it => inWindow(it, lower24h) && passesFilterRequired(it));
  const filtered48h = scored.filter(it => inWindow(it, lower48h) && passesFilterRequired(it));
  const filtered72h = scored.filter(it => inWindow(it, lower72h) && passesFilterRequired(it));
  const filtered7d  = scored.filter(it => inWindow(it, lower7d)  && passesFilterRequired(it));
  const deduped24h = dedupe(filtered24h);
  const deduped48h = dedupe(filtered48h);
  const deduped72h = dedupe(filtered72h);
  const deduped7d  = dedupe(filtered7d);

  // 3. 跨日去重 (must happen before window selection — adaptive threshold compares post-dedupe pools)
  const seenAll = pruneSeen(loadSeen(), now);
  // 同北京日内重跑（同一 cron / 多次手动 retry）不应剔除自己刚写入的条目；过午夜后这些条目按常规剔除
  const todayBJ = beijingDateStr(now);
  const seenForFilter = seenAll.filter(s => s.shown_date !== todayBJ);
  const sameDayCount = seenAll.length - seenForFilter.length;
  const candidate24h = filterAlreadySeen(deduped24h, seenForFilter);
  const candidate48h = filterAlreadySeen(deduped48h, seenForFilter);
  const candidate72h = filterAlreadySeen(deduped72h, seenForFilter);
  const fresh7d      = filterAlreadySeen(deduped7d,  seenForFilter);

  // Adaptive window: pick the smallest window whose post-dedupe pool meets the freshness floor.
  const winSel = selectEffectiveWindow({
    pool24: candidate24h.length,
    pool48: candidate48h.length,
    pool72: candidate72h.length,
  });
  const fresh24h = (winSel.hours === 24 ? candidate24h
                 : winSel.hours === 48 ? candidate48h
                 :                       candidate72h)
    // Preserve the existing "extended_window" semantic: items older than 24h within the
    // effective window get flagged (so the per-item ext badge still means "older than the
    // canonical fresh day"). Spread-copy to avoid mutating objects shared across the other
    // candidate pools and fresh7d.
    .map(it => (it.published_at && it.published_at < lower24h)
      ? { ...it, _ext_eligible: true } : it);
  log(`⏰ adaptive window: chose ${winSel.hours}h (pool24=${candidate24h.length} pool48=${candidate48h.length} pool72=${candidate72h.length})`);
  log(`⏰ 24h-window filter ${filtered24h.length} → dedupe ${deduped24h.length}`);
  log(`📅 cross-day filter: seen ${seenAll.length} → fresh ${fresh24h.length} (eff${winSel.hours}h) / ${fresh7d.length} (7d)${sameDayCount > 0 ? ` (今日 ${sameDayCount} 条不参与剔除)` : ""}`);

  // [debug] 池子分布
  const poolDist = (pool, label) => {
    const c = { national: 0, sunbelt: 0, btr: 0, cre: 0, institutional: 0 };
    for (const it of pool) c[classify(it)] = (c[classify(it)] || 0) + 1;
    log(`📊 ${label}: ${SECTIONS.map(s => `${s.id}=${c[s.id]}`).join(" ")}`);
  };
  poolDist(fresh24h, `fresh${winSel.hours}h dist`);
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

  // 6. 选取 + 摘要 — 两条路径
  //    legacy: 正则 classify + section 配额 + 三段补位 → LLM 仅翻译
  //    global: LLM 一次通读全部候选 → 选 20 + 分类 + 打 tag + 翻译 + 评级；reviewer 二阶审查 + loop
  const skipLLM = process.env.LLM_SKIP === "1";
  const llmKey = process.env.LLM_API_KEY;
  const llmEndpoint = process.env.LLM_ENDPOINT;
  const llmModel = process.env.LLM_MODEL;
  let withSummary;
  let writerAudit = null;
  let candidatePoolSize = 0;
  let minDiag = null;

  const dryGlobal = WRITER_MODE === "global-dry";
  if ((WRITER_MODE === "global" || dryGlobal) && !skipLLM) {
    if (!dryGlobal && (!llmKey || !llmEndpoint || !llmModel)) {
      throw new Error("Missing required env vars: LLM_API_KEY, LLM_ENDPOINT, LLM_MODEL (or use WRITER_MODE=global-dry to inspect prompt without calling LLM)");
    }
    // 候选池：fresh24h 全量（80-150）+ fresh7d 顶部高分（约 30，标记 _ext_eligible）→ 100-200
    // 已经过 dedup + cross-day filter，rededuped (enriched 30) 用于优先 — 这些有完整 body
    const enrichedSet = new Set(rededuped.map(it => it.link));
    const inPool = new Set(rededuped.map(it => it.link));
    const extras24 = fresh24h
      .filter(it => !inPool.has(it.link))
      .sort((a, b) => b.score - a.score);
    for (const it of extras24) inPool.add(it.link);
    // 7d 池仅取顶部 30 条作为扩窗候选（btr/sunbelt/institutional 在 24h 池干涸时备用）
    const ext7d = fresh7d
      .filter(it => !inPool.has(it.link))
      .sort((a, b) => b.score - a.score)
      .slice(0, 30)
      .map(it => ({ ...it, _ext_eligible: true }));
    const candidatePool = [...rededuped, ...extras24, ...ext7d].sort((a, b) => b.score - a.score);
    candidatePoolSize = candidatePool.length;
    log(`🌐 WRITER_MODE=${WRITER_MODE} — pool=${candidatePoolSize} (enriched=${rededuped.length} + 24h=${extras24.length} + 7d-ext=${ext7d.length})`);

    if (dryGlobal) {
      // dry mode：只构造 prompt 输出到 stdout，不调 LLM，不写盘 — 立即退出
      const sectionsBlock = buildSectionsPromptBlock(SECTIONS_DEF);
      const tagsBlock = buildTagsPromptBlock(TAGS_DEF);
      const selectorBlock = buildSelectorCandidatesBlock(candidatePool);
      log(`🌐 DRY: prompt sizes — sections ~${Math.round(sectionsBlock.length/4)} tok, tags ~${Math.round(tagsBlock.length/4)} tok, selector ~${Math.round(selectorBlock.length/4)} tok`);
      log(`🌐 DRY: pool section dist (legacy classify, 仅供对比):`);
      const dist = { national: 0, sunbelt: 0, btr: 0, cre: 0, institutional: 0 };
      for (const it of candidatePool) dist[classify(it)] = (dist[classify(it)] || 0) + 1;
      for (const s of SECTIONS) log(`     ${s.id}: ${dist[s.id]} (target quota=${s.quota})`);
      log(`🌐 DRY: 已退出，未写 data/latest.json 也未更新 state/seen.json`);
      log(`✅ Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s (dry)`);
      return;
    } else {
      const result = await multiAgentPipeline(candidatePool, { endpoint: llmEndpoint, apiKey: llmKey, model: llmModel });
      withSummary = result.items;
      writerAudit = result.audit;

      // CRE 子分类延用 detectCreSubcategory（前端依赖此字段）
      for (const it of withSummary) {
        if (it.section === "cre") it.cre_subcategory = detectCreSubcategory(it);
      }

      // 配额检查
      const sectionCount = {};
      for (const it of withSummary) sectionCount[it.section] = (sectionCount[it.section] || 0) + 1;
      log(`🏆 multi-agent final ${withSummary.length} items, stages=${writerAudit.length}`);
      for (const s of SECTIONS) {
        const n = sectionCount[s.id] || 0;
        const expected = SECTIONS_DEF.sections.find(x => x.id === s.id)?.quota ?? s.quota;
        const flag = n === expected ? "" : ` ⚠️  expected ${expected}`;
        log(`   ${s.emoji} ${s.label}: ${n}${flag}`);
      }
      const impDist = withSummary.reduce((acc, it) => { acc[it.importance || 3] = (acc[it.importance || 3] || 0) + 1; return acc; }, {});
      log(`📊 importance dist: ${JSON.stringify(impDist)}`);
    }
  } else {
    // legacy 路径：正则 classify + 配额挑选 + LLM 仅翻译
    const sectioned = pickBySection(rededuped, DAILY_LIMIT);
    minDiag = ensureSectionMinimum(sectioned, fresh24h, fresh7d, 2);
    let top = sectioned.flatMap(s => s.items.map(it => {
      const out = { ...it, section: s.section.id };
      if (s.section.id === "cre") out.cre_subcategory = detectCreSubcategory(it);
      return out;
    }));

    // 强制总数 = DAILY_LIMIT
    if (top.length > DAILY_LIMIT) {
      const before = top.length;
      top.sort((a, b) => {
        if (!!a.extended_window !== !!b.extended_window) return a.extended_window ? -1 : 1;
        return a.score - b.score;
      });
      top = top.slice(top.length - DAILY_LIMIT);
      log(`🔻 trimmed from ${before} → ${top.length} (cut ${before - DAILY_LIMIT} lowest-score items)`);
    } else if (top.length < DAILY_LIMIT) {
      const need = DAILY_LIMIT - top.length;
      const links = new Set(top.map(it => it.link));
      const all24 = [...rededuped, ...fresh24h.filter(it => !rededuped.some(x => x.link === it.link))]
        .filter(it => !links.has(it.link))
        .sort((a, b) => b.score - a.score);
      const sectionById = new Map(SECTIONS.map(s => [s.id, s]));
      const perSection = new Map(SECTIONS.map(s => [s.id, top.filter(t => t.section === s.id).length]));
      const fillers = [];
      for (const it of all24) {
        if (fillers.length >= need) break;
        const sid = classify(it);
        const sec = sectionById.get(sid);
        if (!sec) continue;
        if ((perSection.get(sid) || 0) >= sec.quota) continue;
        fillers.push(it);
        perSection.set(sid, (perSection.get(sid) || 0) + 1);
      }
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
        const enriched2 = { ...it, section: sid };
        if (sid === "cre") enriched2.cre_subcategory = detectCreSubcategory(it);
        top.push(enriched2);
      }
      log(`🔺 filled from ${DAILY_LIMIT - need} → ${top.length} (pass1 24h-quota → pass2 7d-extend → pass3 24h-flex)`);
    }

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

    if (skipLLM) {
      log(`🤖 LLM_SKIP=1 — skipping LLM, output without Chinese summaries`);
      const fetchedAt = Date.now();
      withSummary = top.map(it => ({ ...it, id: hashLink(it.link), title_zh: "", summary_zh: "(LLM_SKIP)", importance: 3, impact: "neutral", fetched_at: fetchedAt }));
    } else if (!llmKey || !llmEndpoint || !llmModel) {
      throw new Error("Missing required env vars: LLM_API_KEY, LLM_ENDPOINT, LLM_MODEL (or set LLM_SKIP=1 to skip LLM)");
    } else {
      log(`🤖 calling LLM (legacy translate-only): ${llmEndpoint} model=${llmModel} batch=${top.length}`);
      withSummary = await summarizeBatch(top, { endpoint: llmEndpoint, apiKey: llmKey, model: llmModel });
      log(`🤖 LLM ok`);
    }

    // importance-aware 重排
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
  }

  // 8. 写出
  const date = beijingDateStr(now);

  // US holiday context — pre-fetched + cached in state/us-holidays-YYYY.json.
  // Failures are absorbed by the loader; if both years return [], usHoliday
  // will just have all-null flags and the banner stays in pool-driven mode.
  const usYear = new Date(now).getUTCFullYear();
  const usHolidaysList = (await Promise.all([
    loadUsHolidays({ stateDir: STATE_DIR, year: usYear, log }),
    loadUsHolidays({ stateDir: STATE_DIR, year: usYear + 1, log }),
  ])).flat();
  const usHoliday = usHolidayContext(now, usHolidaysList);

  const payload = {
    date,
    generated_at: now,
    sources_attempted: config.sources.length,
    sources_ok: okCount,
    sections: SECTIONS,
    items: withSummary,
    errors,
    _diagnostics: {
      writer_mode: WRITER_MODE,
      sectionsUnderMin: minDiag?.underMin || [],
      window_hours: winSel.hours,
      pool_sizes: winSel.pool_sizes,
      us_holiday: usHoliday,
      ...(writerAudit ? {
        writer_audit: writerAudit,
        candidate_pool_size: candidatePoolSize,
      } : {}),
    },
  };
  fs.writeFileSync(path.join(DATA_DIR, "latest.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, `${date}.json`), JSON.stringify(payload, null, 2));

  // Prerender — 在 public/index.html 注入 inline initial-data，让首屏直出内容
  // 避免 SSR 骨架闪烁，改善 SEO / 社交分享预览。app.js 检测到 initial-data 时优先使用
  try {
    const indexPath = path.join(ROOT, "public/index.html");
    const tpl = fs.readFileSync(indexPath, "utf8");
    const safeJson = JSON.stringify(payload).replace(/<\/script>/gi, "<\\/script>");
    // Match <script src="/app.js"> with optional ?v=... query string (cache-bust versioning)
    const appJsRe = /<script src="\/app\.js(?:\?[^"]*)?"><\/script>/;
    const appJsMatch = tpl.match(appJsRe);
    const appJsTag = appJsMatch ? appJsMatch[0] : `<script src="/app.js"></script>`;
    const dataTag = `<script id="initial-data" type="application/json">${safeJson}</script>\n  ${appJsTag}`;
    const stripped = tpl.replace(/\s*<script id="initial-data"[\s\S]*?<\/script>/, "");
    const replaced = stripped.replace(appJsRe, dataTag);
    if (replaced !== tpl) {
      fs.writeFileSync(indexPath, replaced);
      log(`💾 prerendered public/index.html with inline initial-data (~${Math.round(safeJson.length / 1024)} KB)`);
    } else {
      log(`⚠️  prerender skipped — could not find <script src="/app.js"...> anchor in index.html`);
    }
  } catch (e) {
    log(`⚠️  prerender failed (non-fatal): ${e.message}`);
  }

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
