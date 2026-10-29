// Shared deterministic feed, scoring and section utilities.

import { createHash } from "node:crypto";

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
    .replace(/&rsquo;|&lsquo;/g, "'").replace(/&rdquo;|&ldquo;/g, '"').replace(/&mdash;|&ndash;/g, '--')
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (all, code) => { const n = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1),16) : Number(code); return n <= 0x10ffff ? String.fromCodePoint(n) : all; })
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const firstMatch = (s, re) => {
  const m = String(s).match(re);
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
      const atomLinks = [...b.matchAll(/<link\b[^>]*>/gi)].map(m => ({ href: firstMatch(m[0], /\bhref=["']([^"']+)["']/i), rel: firstMatch(m[0], /\brel=["']([^"']+)["']/i), type: firstMatch(m[0], /\btype=["']([^"']+)["']/i) }));
      const link = atomLinks.find(x => x.rel === 'alternate' && (!x.type || x.type === 'text/html'))?.href || atomLinks.find(x => !x.rel)?.href || firstMatch(b, /<link[^>]*>([\s\S]*?)<\/link>/i);
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
  const assetLabels = {
    "multifamily": "多户", "office": "办公", "industrial": "工业",
    "data-center": "数据中心", "hotel": "酒店", "retail": "零售",
    "senior-housing": "老年住房", "life-sciences": "生命科学", "self-storage": "自存储",
    "mixed-asset": "跨资产",
  };
  const asset = (Array.isArray(it.tags) ? it.tags : []).find(tag => Object.hasOwn(assetLabels, tag));
  if (asset) return assetLabels[asset];
  const t = String(it.title || "").toLowerCase();
  if (/self[-\s]?storage|mini\s+storage/.test(t)) return "自存储";
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

export function canonicalUrl(value) { try { const u=new URL(value);u.hash='';u.hostname=u.hostname.toLowerCase().replace(/^www\./,'');for(const key of [...u.searchParams.keys()])if(/^(utm_|fbclid$|gclid$|mc_)/i.test(key))u.searchParams.delete(key);for (const key of new Set(u.searchParams.keys())) { const values=[...new Set(u.searchParams.getAll(key))]; u.searchParams.delete(key); for(const value of values)u.searchParams.append(key,value); }u.searchParams.sort();return u.toString().replace(/\/$/,''); }catch{return String(value||'').trim();} }
export function itemId(it) { return createHash('sha256').update(canonicalUrl(it.link)+(it.mutable ? '|'+[it.published_at || '', it.content_hash || ''].join('|') : '')).digest('hex').slice(0,16); }
export function isSameStory(a,b) { if(canonicalUrl(a.link)===canonicalUrl(b.link))return !a.mutable||!b.mutable||itemId(a)===itemId(b);const norm=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();return norm(a.title).length>35&&norm(a.title)===norm(b.title); }
export function dedupe(items) { const out=[];for(const it of items){const i=out.findIndex(x=>isSameStory(x,it));if(i<0)out.push(it);else if((it.is_research?20:0)+(it.source_weight||0)>(out[i].is_research?20:0)+(out[i].source_weight||0))out[i]=it;}return out; }
export { parseFeed, makeItem, decode, scoreItem, classify, detectCreSubcategory, SECTIONS };
