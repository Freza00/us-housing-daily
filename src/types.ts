// 类型定义 — 整个项目共用

export interface Source {
  id: string;
  name: string;
  url: string;
  tier: "A" | "B" | "C" | "D" | "E";
  tags: string[];
  weight: number;
  region: "national" | "texas" | "global";
  filter_required?: boolean;
  // SEC.gov 等需要"身份化 UA"（带 contact info）的源走 ua_style: "sec"
  ua_style?: "browser" | "sec";
}

export interface SourcesConfig {
  sources: Source[];
  tag_definitions: Record<string, string>;
}

export interface RawItem {
  source_id: string;
  source_name: string;
  source_tier: Source["tier"];
  source_weight: number;
  source_tags: string[];
  region: Source["region"];
  title: string;
  link: string;
  description: string;
  published_at: number; // unix ms
  raw_pub_date?: string;
}

export interface ScoredItem extends RawItem {
  score: number;
  tags: string[]; // 合并后的最终标签
  heat_signals: string[]; // 命中的热度关键词
  section?: string; // 所属分类 (btr / institutional / sunbelt / cre / national)
  extended_window?: boolean; // 是否来自 7 天扩窗回退（24h 内该 section 没内容时启用）
  cre_subcategory?: string | null; // CRE 子类: 数据中心 / 工业 / 办公 / 仓储 / 零售 / 酒店 / 多户
}

export interface NewsItem extends ScoredItem {
  id: string;
  title_zh: string;
  summary_zh: string;
  importance: number;  // 1-5 重要性星级，由 LLM 评估
  impact: "long-pos" | "short-pos" | "neutral" | "short-neg" | "long-neg";
  fetched_at: number;
}

export interface Env {
  NEWS_KV: KVNamespace;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY: string;
  REFRESH_SECRET?: string;
  SOURCES_VERSION: string;
  DAILY_LIMIT: string;
  SUMMARY_LANG: string;
}
