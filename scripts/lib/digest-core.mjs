// Shared utilities for weekly/monthly digests and adaptive-window logic.

import fs from "node:fs";
import path from "node:path";

// Adaptive window selection: pick the smallest window (24/48/72h) whose
// candidate pool meets the freshness threshold. Returns { hours, pool_sizes }.
// Thresholds derived from observed split: normal weekdays sit at 128–155;
// holiday/weekend collapses sit at 38–39. 60 separates them; 30 is the
// floor below which 48h doesn't recover enough.
export function selectEffectiveWindow({ pool24, pool48, pool72 }) {
  const pool_sizes = { "24h": pool24, "48h": pool48, "72h": pool72 };
  if (pool24 >= 60) return { hours: 24, pool_sizes };
  if (pool48 >= 30) return { hours: 48, pool_sizes };
  return { hours: 72, pool_sizes };
}

// Mirror of SECTIONS from build.mjs — kept in sync MANUALLY because we don't want
// digest scripts to import the whole build pipeline. If you change build.mjs SECTIONS
// (quotas, ids, or maxPerSource), you MUST update this table too. The test
// "SECTIONS_DAILY: quotas sum to 20" locks the total but not the per-section split.
// Field names match build.mjs SECTIONS exactly (quota, maxPerSource) — keep them aligned.
export const SECTIONS_DAILY = [
  { id: "national",      label_zh: "全国住宅市场", emoji: "🏠", quota: 5, maxPerSource: 2 },
  { id: "sunbelt",       label_zh: "Sunbelt 住宅", emoji: "🌵", quota: 4, maxPerSource: 2 },
  { id: "btr",           label_zh: "全国 BTR / SFR", emoji: "🏘", quota: 3, maxPerSource: 2 },
  { id: "cre",           label_zh: "全国 CRE",     emoji: "🏢", quota: 5, maxPerSource: 2 },
  { id: "institutional", label_zh: "全国机构资本", emoji: "💰", quota: 3, maxPerSource: 2 },
];

// Load a list of daily JSON files, concatenate items, dedupe by link.
// Each returned item gains a `source_date` field = the Beijing date of the file it came from.
// Returns { items, loaded_dates, errors }.
export function loadDailyHistory(dates, dataDir) {
  const items = [];
  const loaded = [];
  const errors = [];
  const seenLinks = new Set();
  for (const d of dates) {
    const fp = path.join(dataDir, `${d}.json`);
    if (!fs.existsSync(fp)) {
      errors.push(`missing daily file: ${d}.json`);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(fp, "utf8"));
    } catch (e) {
      errors.push(`parse error in ${d}.json: ${e.message}`);
      continue;
    }
    loaded.push(d);
    for (const it of parsed.items || []) {
      if (!it.link || seenLinks.has(it.link)) continue;
      seenLinks.add(it.link);
      items.push({ ...it, source_date: d });
    }
  }
  return { items, loaded_dates: loaded, errors };
}

// Re-rank items and pick the top N respecting section quotas + per-source cap.
// Score = importance * 100 + score − age_hours / 168 * 30
// (importance dominates; freshness is only a tiebreaker over the 7d horizon.)
export function reRankWithQuota(items, sections, opts = {}) {
  const perSourceCap = opts.perSourceCap ?? 2;
  const now = opts.now ?? Date.now();
  const scored = items.map(it => {
    const ageH = it.published_at ? (now - it.published_at) / 3600000 : 168;
    const rerank = (it.importance || 3) * 100 + (it.score || 0) - (ageH / 168) * 30;
    return { ...it, _rerank: rerank };
  });
  scored.sort((a, b) => b._rerank - a._rerank);

  const top = [];
  const perSection = new Map(sections.map(s => [s.id, 0]));
  const perSectionSource = new Map(); // key: `${section}:${source_id}`

  for (const it of scored) {
    const sec = sections.find(s => s.id === it.section);
    if (!sec) continue;
    if ((perSection.get(sec.id) || 0) >= sec.quota) continue;
    const sKey = `${sec.id}:${it.source_id}`;
    const sCount = perSectionSource.get(sKey) || 0;
    const cap = sec.maxPerSource ?? perSourceCap;
    if (sCount >= cap) continue;
    top.push(it);
    perSection.set(sec.id, (perSection.get(sec.id) || 0) + 1);
    perSectionSource.set(sKey, sCount + 1);
    if (sections.every(s => (perSection.get(s.id) || 0) >= s.quota)) break;
  }
  return top.map(({ _rerank, ...rest }) => rest);
}

// Parse the LLM theme response. Tolerant of bare JSON, markdown code fences,
// and JSON wrapped in extra prose. Returns Theme[] or [] (fail-open).
// Theme shape: { title: string, item_ids: string[] }
export function parseThemesResponse(raw, items) {
  if (!raw || typeof raw !== "string") return [];
  let text = raw.trim();
  // Strip markdown code fence if present
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) text = fence[1];
  // Find first {...} block (handles prose wrapping)
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (!objMatch) return [];
  let parsed;
  try {
    parsed = JSON.parse(objMatch[0]);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const themes = Array.isArray(parsed.themes) ? parsed.themes : [];
  return themes
    .filter(t => t && typeof t.title === "string" && Array.isArray(t.item_indices))
    .map(t => ({
      title: t.title.slice(0, 50),
      item_ids: t.item_indices
        .map(i => items[Number(i) - 1]?.id)
        .filter(Boolean),
    }))
    .filter(t => t.item_ids.length > 0);
}

// Single LLM call to extract 3–5 "themes" from digest items. `callLLM` is
// injected so this module stays decoupled from build.mjs's LLM client wiring.
// Fail-open: any error returns { themes: [], error: <msg>, raw_preview? }.
export async function generateThemes(items, opts) {
  const { callLLM, periodLabel = "本期", maxThemes = 5 } = opts;
  if (!callLLM) return { themes: [], error: "no callLLM provided" };
  if (!items?.length) return { themes: [], error: "empty items" };

  const enumerated = items.map((it, i) => {
    const t = it.title_zh || it.title || "";
    const s = it.summary_zh || "";
    return `[${i + 1}] section=${it.section} imp=${it.importance}\n  T: ${t}\n  S: ${s}`;
  }).join("\n");

  const systemPrompt = `你是美国住宅地产中文研究员，从${periodLabel}已选定的新闻里提炼 3-${maxThemes} 条「主线」。每条主线 ≤ 50 中文字，必须是结论性短句而非中性描述。`;
  const userPrompt = `下方 ${items.length} 条新闻（已按 importance + section 选出）。请输出 JSON：
{ "themes": [ { "title": "≤50中文字主线标题", "item_indices": [对应条目序号, ...] } ] }

严格 JSON，无 markdown，无注释。每条主线关联至少 1 个 item_indices。3-${maxThemes} 条主线。

新闻：
${enumerated}`;

  let raw;
  try {
    raw = await callLLM(systemPrompt, userPrompt, { temperature: 0.3, label: "themes" });
  } catch (e) {
    return { themes: [], error: `LLM call failed: ${e.message}` };
  }
  const themes = parseThemesResponse(raw, items);
  if (themes.length === 0) {
    return { themes: [], error: "parse returned 0 themes", raw_preview: String(raw).slice(0, 200) };
  }
  return { themes };
}
