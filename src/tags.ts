// Tag 体系 — 按行业惯例 MECE 整理为 4 个维度
// 每个 tag 仅属于一个维度；维度之间互斥不重叠；总和覆盖所有可能维度
//
// 设计原则：
// - 资产 (asset)   — 这条新闻关于哪类资产？必有 1 个 (默认 housing)
// - 地理 (geo)     — 在哪里？可选 0-1 个 (无 = 全国)
// - 主题 (topic)   — 是关于什么事件类型？可选 1-2 个
// - 主体 (actor)   — 主角是谁？可选 0-1 个
//
// 一条新闻典型 2-4 个 tag；机器自动打标 + 信源默认 tag 共同贡献

export type TagDimension = "asset" | "geo" | "topic" | "actor";

export interface TagDef {
  id: string;
  label: string;        // 中文显示
  dimension: TagDimension;
}

export const TAGS: TagDef[] = [
  // ======== 资产类别 (asset) ========
  { id: "housing",        label: "住宅市场",   dimension: "asset" },  // 全国宏观住宅 (NAR/Realtor 数据等)
  { id: "multifamily",    label: "多户",       dimension: "asset" },  // 多户公寓
  { id: "btr-sfr",        label: "BTR/SFR",   dimension: "asset" },  // Build-to-Rent / Single-Family Rental
  { id: "office",         label: "办公",       dimension: "asset" },
  { id: "industrial",     label: "工业",       dimension: "asset" },  // 包含 warehouse / logistics
  { id: "data-center",    label: "数据中心",   dimension: "asset" },
  { id: "retail",         label: "零售",       dimension: "asset" },
  { id: "hotel",          label: "酒店",       dimension: "asset" },
  { id: "mixed-asset",    label: "跨资产",     dimension: "asset" },  // PERE / 跨多种资产的研究

  // ======== 地理 (geo) ========
  { id: "texas",          label: "德州",       dimension: "geo" },
  { id: "dfw",            label: "DFW",       dimension: "geo" },
  { id: "houston",        label: "Houston",   dimension: "geo" },
  { id: "austin",         label: "Austin",    dimension: "geo" },
  { id: "sun-belt",       label: "Sun Belt",  dimension: "geo" },
  { id: "nyc",            label: "NYC",       dimension: "geo" },
  { id: "california",     label: "California", dimension: "geo" },

  // ======== 主题 (topic) ========
  { id: "policy",         label: "政策",       dimension: "topic" },  // 立法 / 监管
  { id: "rates",          label: "利率",       dimension: "topic" },  // Fed rate / mortgage rate
  { id: "macro",          label: "宏观",       dimension: "topic" },  // 通胀 / 就业 / GDP
  { id: "deals",          label: "交易",       dimension: "topic" },  // 收购 / 出售 / 租约 / IPO / 并购
  { id: "data",           label: "数据",       dimension: "topic" },  // NAR / Yardi / Redfin 等数据发布
  { id: "trend",          label: "趋势",       dimension: "topic" },  // 行业 outlook / 趋势分析
  { id: "earnings",       label: "业绩",       dimension: "topic" },  // 季报

  // ======== 主体 (actor) ========
  { id: "institutional",  label: "机构",       dimension: "actor" },  // PE / REIT / 主权基金
  { id: "homebuilder",    label: "建造商",     dimension: "actor" },  // Lennar / DR Horton / Ashton Woods 等
  { id: "landlord",       label: "业主",       dimension: "actor" },
  { id: "brokerage",      label: "经纪",       dimension: "actor" },
  { id: "regulator",      label: "监管",       dimension: "actor" },  // Fed / FHFA / HUD / Treasury / CFPB
];

// 用于 ID → label 的快速查询
export const TAG_LABEL: Record<string, string> = Object.fromEntries(
  TAGS.map((t) => [t.id, t.label]),
);
export const TAG_DIM: Record<string, TagDimension> = Object.fromEntries(
  TAGS.map((t) => [t.id, t.dimension]),
);

// 哪些 tag 算作"热门信号" — UI 上用 heat (橙色) 渲染
// 这些是 Wan Bridge 视角最关心的 tag — 命中即视觉强调
export const HEAT_TAGS = new Set([
  "btr-sfr",
  "texas", "dfw", "houston", "austin", "sun-belt",
  "institutional",
  "policy",
  "rates",
]);
