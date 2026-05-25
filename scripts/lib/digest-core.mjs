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
// (quotas, ids, or perSourceCap), you MUST update this table too. The test
// "SECTIONS_DAILY: quotas sum to 20" locks the total but not the per-section split.
export const SECTIONS_DAILY = [
  { id: "national",      label_zh: "全国住宅市场", emoji: "🏠", quota: 5, perSourceCap: 2 },
  { id: "sunbelt",       label_zh: "Sunbelt 住宅", emoji: "🌵", quota: 4, perSourceCap: 2 },
  { id: "btr",           label_zh: "全国 BTR / SFR", emoji: "🏘", quota: 3, perSourceCap: 2 },
  { id: "cre",           label_zh: "全国 CRE",     emoji: "🏢", quota: 5, perSourceCap: 2 },
  { id: "institutional", label_zh: "全国机构资本", emoji: "💰", quota: 3, perSourceCap: 2 },
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
    const cap = sec.perSourceCap ?? perSourceCap;
    if (sCount >= cap) continue;
    top.push(it);
    perSection.set(sec.id, (perSection.get(sec.id) || 0) + 1);
    perSectionSource.set(sKey, sCount + 1);
    if (sections.every(s => (perSection.get(s.id) || 0) >= s.quota)) break;
  }
  return top.map(({ _rerank, ...rest }) => rest);
}
