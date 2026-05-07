// 跨日去重 + 模糊相似度
// 思路：每天选完 20 条后把它们的 url + title-tokens 写进 KV (rolling 21 天)
// 下一次跑 pipeline 时先读这个 list，把已经出现过的 item 过滤掉
// "新进展" 的容忍度由 jaccard 阈值控制 — 阈值越高，越容易让 follow-up 通过

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "into", "over", "after",
  "before", "about", "will", "would", "could", "should", "while", "their",
  "they", "them", "have", "been", "were", "said", "says", "when", "where",
  "what", "which", "than", "then", "amid", "plan", "plans", "news", "real",
  "estate", "more", "some", "also", "even", "much", "very", "many",
  "report", "reports", "shows", "show", "still", "just", "made", "makes",
]);

// 抽取标题里的"内容词"：长度≥4 的字母词、$ 数字、百分数、3 位以上数字
export function tokenize(title: string): string[] {
  const matches = title.toLowerCase().match(
    /[a-z]{4,}|\$[\d.,]+[bmk]?|[\d.]+%|\d{3,}/g,
  );
  if (!matches) return [];
  const filtered = matches.filter((t) => !STOPWORDS.has(t));
  return Array.from(new Set(filtered));
}

export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let intersect = 0;
  for (const x of A) if (B.has(x)) intersect++;
  const union = A.size + B.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

// 抽取归一化数字（含 K / M / B / 千分位 / SF 单位）— 用于实体级去重
// "475K" / "475,000" 都归一化为 "475000"；"$1.75B" → "1750000000"
export function extractFigures(text: string): Set<string> {
  const out = new Set<string>();
  const re = /\$?(\d{2,}(?:[.,]\d+)?)\s*(b|m|k|million|billion|trillion)?\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let n = parseFloat(m[1].replace(/,/g, ""));
    if (isNaN(n)) continue;
    const suffix = (m[2] || "").toLowerCase();
    if (suffix === "k") n *= 1_000;
    else if (suffix === "m" || suffix === "million") n *= 1_000_000;
    else if (suffix === "b" || suffix === "billion") n *= 1_000_000_000;
    else if (suffix === "t" || suffix === "trillion") n *= 1_000_000_000_000;
    if (n >= 100) out.add(Math.round(n).toString());
  }
  return out;
}

// 抽取标题里的"专有名词" — 公司名 / 地名 / 律所名 / 项目名
// 多词大写短语优先（"Cleary Gottlieb"），单词 5+ 字符大写次之（"Blackstone"）
const ENT_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "over", "after", "north", "south",
  "east", "west", "deal", "sheet", "news", "report", "weekly", "monthly", "annual",
  "real", "estate", "office", "industrial", "company", "group", "corp", "inc",
  "llc", "fund", "partners", "capital", "trust", "advisors",
]);
export function extractEntities(title: string): Set<string> {
  const out = new Set<string>();
  // 多词大写短语，比如 "Cleary Gottlieb" / "One Liberty Plaza" / "Lower Manhattan"
  const multi = title.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4}\b/g) || [];
  for (const p of multi) {
    const norm = p.toLowerCase().replace(/\s+/g, " ").trim();
    if (norm.length >= 5) out.add(norm);
  }
  // 单词 5+ 字大写名词
  const single = title.match(/\b[A-Z][a-z]{4,}\b/g) || [];
  for (const s of single) {
    const lower = s.toLowerCase();
    if (!ENT_STOPWORDS.has(lower)) out.add(lower);
  }
  return out;
}

// 综合判断两条 item 是否同一新闻（多信源同事件常见）
export function isSameStory(
  a: { title: string; description?: string },
  b: { title: string; description?: string },
  jaccardThreshold = 0.5,
): boolean {
  // 1) Token Jaccard
  if (jaccard(tokenize(a.title), tokenize(b.title)) >= jaccardThreshold) return true;
  // 2) Entity overlap：共享至少 1 个数字 + 1 个实体 = 同一事件
  const figA = extractFigures(`${a.title} ${a.description ?? ""}`);
  const figB = extractFigures(`${b.title} ${b.description ?? ""}`);
  let sharedFig = 0;
  for (const f of figA) if (figB.has(f)) sharedFig++;
  const entA = extractEntities(a.title);
  const entB = extractEntities(b.title);
  let sharedEnt = 0;
  for (const e of entA) if (entB.has(e)) sharedEnt++;
  return sharedFig >= 1 && sharedEnt >= 1;
}

export interface SeenItem {
  url: string;
  tokens: string[];
  shown_date: string; // YYYY-MM-DD
}

export function loadSeen(raw: string | null | undefined): SeenItem[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function pruneSeen(seen: SeenItem[], now: number, maxAgeDays = 21): SeenItem[] {
  const cutoff = now - maxAgeDays * 24 * 3600 * 1000;
  return seen.filter((s) => {
    const t = Date.parse(s.shown_date);
    return !isNaN(t) && t >= cutoff;
  });
}

// 过滤掉与已 seen list 任一项 URL 相同 / 标题相似度 ≥ jaccardThreshold 的 item
// jaccardThreshold = 0.7 默认（即新 item 至少需要 30% token 不同才算"新进展"）
export function filterAlreadySeen<T extends { link: string; title: string }>(
  items: T[],
  seen: SeenItem[],
  jaccardThreshold = 0.7,
): T[] {
  const seenUrls = new Set(seen.map((s) => s.url));
  return items.filter((it) => {
    if (seenUrls.has(it.link)) return false;
    const tokens = tokenize(it.title);
    if (tokens.length === 0) return true;
    for (const s of seen) {
      if (jaccard(tokens, s.tokens) >= jaccardThreshold) return false;
    }
    return true;
  });
}

export function appendToSeen<T extends { link: string; title: string }>(
  seen: SeenItem[],
  newItems: T[],
  date: string,
): SeenItem[] {
  const additions: SeenItem[] = newItems.map((it) => ({
    url: it.link,
    tokens: tokenize(it.title),
    shown_date: date,
  }));
  return [...additions, ...seen];
}
