// 极简 RSS / Atom 解析器
// 不用第三方库 — Cloudflare Workers 跑得动、bundle 小、可读性高
// 不追求 100% 标准兼容，覆盖主流 feed 的常见 shape 即可

import type { RawItem, Source } from "./types";

const decode = (s: string): string =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ") // 简单去 HTML tag
    .replace(/\s+/g, " ")
    .trim();

const firstMatch = (s: string, re: RegExp): string => {
  const m = s.match(re);
  return m ? m[1] : "";
};

const parsePubDate = (s: string): number => {
  if (!s) return 0;
  const t = Date.parse(s);
  if (!isNaN(t)) return t;
  // 兜底：尝试 ISO 8601 / RFC 822 几个常见格式
  return 0;
};

export function parseFeed(xml: string, source: Source): RawItem[] {
  const isAtom = /<feed[\s>]/i.test(xml);
  const items: RawItem[] = [];

  if (isAtom) {
    const entryRegex = /<entry\b[\s\S]*?<\/entry>/gi;
    let m: RegExpExecArray | null;
    while ((m = entryRegex.exec(xml)) !== null) {
      const block = m[0];
      const title = decode(firstMatch(block, /<title[^>]*>([\s\S]*?)<\/title>/i));
      // <link href="..."> 或 <link rel="alternate" href="...">
      const link =
        firstMatch(block, /<link[^>]*?href=["']([^"']+)["'][^>]*?\/?>/i) ||
        firstMatch(block, /<link[^>]*>([\s\S]*?)<\/link>/i);
      const desc = decode(
        firstMatch(block, /<summary[^>]*>([\s\S]*?)<\/summary>/i) ||
          firstMatch(block, /<content[^>]*>([\s\S]*?)<\/content>/i),
      );
      const pub =
        firstMatch(block, /<published[^>]*>([\s\S]*?)<\/published>/i) ||
        firstMatch(block, /<updated[^>]*>([\s\S]*?)<\/updated>/i);
      if (!title || !link) continue;
      items.push({
        source_id: source.id,
        source_name: source.name,
        source_tier: source.tier,
        source_weight: source.weight,
        source_tags: source.tags,
        region: source.region,
        title,
        link: link.trim(),
        description: desc.slice(0, 600),
        published_at: parsePubDate(pub),
        raw_pub_date: pub,
      });
    }
  } else {
    const itemRegex = /<item\b[\s\S]*?<\/item>/gi;
    let m: RegExpExecArray | null;
    while ((m = itemRegex.exec(xml)) !== null) {
      const block = m[0];
      const title = decode(firstMatch(block, /<title[^>]*>([\s\S]*?)<\/title>/i));
      const link = decode(firstMatch(block, /<link[^>]*>([\s\S]*?)<\/link>/i));
      const desc = decode(
        firstMatch(block, /<description[^>]*>([\s\S]*?)<\/description>/i) ||
          firstMatch(block, /<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i),
      );
      const pub =
        firstMatch(block, /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) ||
        firstMatch(block, /<dc:date[^>]*>([\s\S]*?)<\/dc:date>/i);
      if (!title || !link) continue;
      items.push({
        source_id: source.id,
        source_name: source.name,
        source_tier: source.tier,
        source_weight: source.weight,
        source_tags: source.tags,
        region: source.region,
        title,
        link: link.trim(),
        description: desc.slice(0, 600),
        published_at: parsePubDate(pub),
        raw_pub_date: pub,
      });
    }
  }
  return items;
}
