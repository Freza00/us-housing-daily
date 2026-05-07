// LLM 摘要生成 — OpenAI 兼容协议
// 默认走 Kimi (Moonshot)，可通过环境变量切换到任何 OpenAI 兼容服务
//
// 必填环境变量：
//   LLM_API_KEY    — API key (sk-xxx)
//   LLM_ENDPOINT   — 完整 chat completions URL (e.g. https://api.moonshot.cn/v1/chat/completions)
//   LLM_MODEL      — 模型名 (e.g. kimi-k2-0905-preview / Kimi-K2.6 / moonshot-v1-128k)
//
// 流程：单次调用，batch 21 条新闻 → 返回 JSON 数组 [{i, t, s, imp, dir}]

import type { NewsItem, ScoredItem } from "./types";

const MAX_OUTPUT_TOKENS = 4000;

interface OpenAIResp {
  choices: { message: { content?: string } }[];
}

function buildPrompt(items: ScoredItem[]): string {
  const lines = items.map(
    (it, i) => `[${i + 1}] (${it.source_name}) ${it.title}\n正文片段: ${it.description.slice(0, 1500)}`,
  );
  return `你是  的美国住宅地产研究员（关注 BTR / SFR / Sun Belt / 德州三城 / 机构资本流向）。给每条新闻产出 4 个字段：

- t: 中文译标（≤ 30 字），按中文语序重组
- s: 一句中文要点摘要（≤ 60 字）
- imp: 整数 1-5（重要性，BTR / 美国住宅地产研究员视角）
    5 = 行业级关键事件（Fed 降息 / BTR 立法过会 / 主权基金大额配置）
    4 = 值得机构关注的趋势 / 大宗 IPO / 重要数据
    3 = 区域市场动向 / 一般数据 / 二线 trend 文章
    2 = 单笔交易 / 普通租约
    1 = 次要补充 / 辅助信号
- dir: 方向（五选一）
    "long-pos"  = 长期利好  /  "short-pos" = 短期利好
    "neutral"   = 中性
    "short-neg" = 短期利空  /  "long-neg" = 长期利空

【硬约束 — 必须保留英文（行业惯例术语，不翻译）】
✓ 公司 / 媒体 / 人名：Blackstone, Pretium, Bloomberg, Don Mullen, Cleary Gottlieb, BlackRock, KKR, Brookfield, TPG, Invitation Homes, AMH, Starwood 等
✓ 行业缩写：REIT, IPO, M&A, BTR, SFR, NOI, LTV, DSCR, AUM, GP, LP, CRE, multifamily, cap rate, refi, hyperscaler, special servicing, deal sheet
✓ 政府机构：Fed, FOMC, FHFA, HUD, Treasury, CFPB, SEC, Senate, House, ICE
✓ 数据 / 指标：JOLTS, GDP, CPI, PMMS, Case-Shiller, new home sales, existing home sales, pending home sales, housing starts, building permits
✓ 时间 / 单位 / 数字：Q1 / Q2 / Q3 / Q4, $1.75B, 475K SF, 6.3%, 30Y mortgage, bps, YoY, MoM
✓ 城市 / 地名英文：Manhattan, Brooklyn, NYC, Lower Manhattan, Wilmer, Pasadena, Sun Belt（不翻"阳光地带"）
中文化的：政策 / 宏观 / 利率 / 多户 / 办公 / 工业 / 数据中心 / 零售 / 酒店 / 租约 / 并购 / 募资 / 业绩 / 趋势 / 业主 / 经纪 / 监管

【内容硬约束】
✓ s 必须给出结论 / 数字 / 立场 / 方向之一；不能写"X 公开表态/谈了/讨论了"这种没结论的话
✗ 禁止编造原文没有的内容；正文片段不足以提取结论时，s 写"详细见原文"+最少事实
✗ 禁止"据某某报道"这种引述句
✓ imp 和 dir 是必填，不准空

【输出格式】
JSON 数组：[{"i": 序号, "t": "...", "s": "...", "imp": 数字, "dir": "..."}, ...]
不要包 markdown code fence

新闻列表：

${lines.join("\n\n")}

请直接输出 JSON 数组：`;
}

export interface SummarizeOptions {
  endpoint: string;
  apiKey: string;
  model: string;
  temperature?: number;
}

export async function summarizeBatch(
  items: ScoredItem[],
  opts: SummarizeOptions,
): Promise<NewsItem[]> {
  if (items.length === 0) return [];
  const prompt = buildPrompt(items);

  const resp = await fetch(opts.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: opts.temperature ?? 0.3,
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`LLM API failed [${resp.status}]: ${errBody.slice(0, 500)}`);
  }
  const data = (await resp.json()) as OpenAIResp;
  const text = data.choices?.[0]?.message?.content ?? "";

  // 解析 JSON — 容错：去掉 code fence
  const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*$/g, "").trim();
  let parsed: { i: number; t?: string; s: string; imp?: number; dir?: string }[] = [];
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = [];
  }

  const titleMap = new Map<number, string>();
  const summaryMap = new Map<number, string>();
  const impMap = new Map<number, number>();
  const dirMap = new Map<number, string>();
  for (const p of parsed) {
    if (p.t) titleMap.set(p.i, p.t);
    if (p.s) summaryMap.set(p.i, p.s);
    if (typeof p.imp === "number") impMap.set(p.i, Math.max(1, Math.min(5, Math.round(p.imp))));
    if (p.dir) dirMap.set(p.i, p.dir);
  }

  const validDirs = new Set(["long-pos", "short-pos", "neutral", "short-neg", "long-neg"]);
  const fetchedAt = Date.now();
  return items.map((it, idx) => {
    const dir = dirMap.get(idx + 1);
    return {
      ...it,
      id: hashLink(it.link),
      title_zh: titleMap.get(idx + 1) ?? "",
      summary_zh: summaryMap.get(idx + 1) ?? "（摘要生成失败）",
      importance: impMap.get(idx + 1) ?? 3,
      impact: (dir && validDirs.has(dir) ? dir : "neutral") as NewsItem["impact"],
      fetched_at: fetchedAt,
    };
  });
}

// 简单 32-bit 哈希 — 不需要密码学强度
function hashLink(url: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
