# Weekly / Monthly Digest + Adaptive Window — Design

**Date:** 2026-05-25
**Status:** Approved
**Owner:** Freddie

## Background

The site `news-agent-mu.vercel.app` publishes a daily Top-20 of US residential real-estate news at Beijing 09:00. On 2026-05-25 (Memorial Day, a Mon following a US long weekend), 18/20 items were flagged `extended_window=true` — visually "大面积扩窗". Root cause: the 24h candidate pool collapsed from a normal ~135 items to 38 because US business RSS feeds go quiet over the holiday weekend, forcing the daily build to backfill heavily from the 7d fallback pool.

This document specifies three changes:

1. **Adaptive window** — auto-expand the news selection window from 24h → 48h → 72h based on candidate-pool size, and surface this to the reader so "扩窗" reads as a known-handled holiday signal rather than an anomaly.
2. **Weekly digest** — publish a Mon–Sun (US/Eastern) Top-20 every Beijing Monday 10:00, re-ranked from the past 7 days of daily outputs, with an LLM-generated "本周主线" theme summary.
3. **Monthly digest** — same model but covering the previous calendar month, published on the first Beijing Monday of each month at 10:30.

All three changes ship together; the digests reuse daily outputs as their source pool, so they cost ~1 extra LLM call each and require no new RSS fetching.

## Non-Goals

- **No** new RSS fetching for digests. Digests re-rank existing daily outputs.
- **No** change to daily SECTIONS, source list, classifier, or selector. Daily pipeline is treated as a stable upstream.
- **No** separate sub-sites or subdomains for weekly/monthly. Single SPA, tab-switched.
- **No** re-translation of items in digests. Reuse `title_zh` / `summary_zh` from the daily JSON files.

## Architecture

### Feature 1: Adaptive Window (`build.mjs`)

**Where:** `scripts/build.mjs` around line 1828–1875, after `computeWindowBounds` and the existing `fresh24h` computation.

**Logic:**

```
compute lower48h = upper - 48h
compute lower72h = upper - 72h

filter pools at 24h, 48h, 72h (sorted, deduped, cross-day filtered) the same way fresh24h is built today

effective_window_hours, fresh_pool, fresh7d_pool determined as:
  if fresh24h.length >= 60:      eff=24, pool=fresh24h
  elif fresh48h.length >= 30:    eff=48, pool=fresh48h
  else:                          eff=72, pool=fresh72h
```

**Thresholds (60 / 30)** are derived from the observed split: normal weekdays sit at 128–155, holiday/weekend collapses sit at 38–39. 60 separates them safely; 30 is the floor below which 48h didn't recover enough.

**`extended_window` semantics:** Items in `[upper − 24h, upper)` remain unflagged. Items older than 24h within the effective window are flagged `extended_window=true`. This preserves the existing "ext = older than the canonical fresh day" meaning so downstream UI / future scoring code doesn't shift underfoot.

**Diagnostics:** Add to `_diagnostics`:
```jsonc
{
  "window_hours": 24 | 48 | 72,
  "pool_sizes": { "24h": 38, "48h": 91, "72h": 142 }
}
```

**Frontend signal:** In `public/app.js`, when rendering daily, if `_diagnostics.window_hours > 24`, render a top banner with text:
> 周末/假日窗口已自动扩展到 {N}h。本期含 {ext_count} 条 24h 外稿件。

When `window_hours === 24`, no banner. The existing per-item `[ext]` pill stays — the banner just reframes "why" so the reader doesn't read it as a failure.

### Feature 2: Weekly Digest

**New script:** `scripts/build-weekly.mjs`

**Period:** US/Eastern week, Mon 00:00 ET → Sun 23:59 ET. The publish day = the first Beijing Monday after the period ends.
- Example: Beijing Mon 2026-06-01 publishes the digest covering ET Mon 2026-05-25 → Sun 2026-05-31.

**Source pool:** Read `data/<date>.json` for each of the 7 ET dates. Mapping ET → Beijing date is straightforward: the Beijing `data/<date>.json` for date D contains items whose `published_at` mostly falls in ET window [D-1 ≈ 21:00 ET, D ≈ 21:00 ET). For digest purposes we pull all items whose `published_at` (epoch ms) falls in the ET week window — items in boundary daily files that fall outside are dropped.

**Re-rank algorithm:**

```
items = []
for date in beijing_dates_covering_et_week:
  items += load(data/<date>.json).items
items = filter(items, et_period_start <= published_at < et_period_end)
items = dedupe_by_link(items)  # first occurrence wins
items.sort(key=lambda it: -(it.importance * 100 + it.score - age_hours(it) / 168 * 30))

# section quota pick: same SECTIONS table as daily (5/4/3/5/3 = 20)
# per_source_cap = 2 per section
top20 = pick_with_quota(items, SECTIONS, per_source_cap=2)
```

Each picked item carries an added field `source_date: "<original daily JSON date>"`.

**Themes layer:** Single LLM call.

```
system: 你是美国住宅地产中文研究员，给本周 20 条新闻提炼 3-5 条主线。
user:   [enumerated 20 items: title_zh + summary_zh + section + importance]
output: themes: [
  { "title": "≤50中文字主线标题", "item_indices": [3, 7, 12] },
  ...
]
```

Then item_indices → item_ids before write.

**Trigger:** GH Actions `weekly.yml` cron `0 2 * * 1` (Mon 02:00 UTC = Beijing 10:00). Vercel Cron also calls `/api/trigger-weekly` at the same time as belt-and-suspenders. Same dedupe-by-existing-file pattern as daily.

**Output:**
```
data/weekly/2026-05-25.json   (named by ET period_start, the Monday the week begins)
data/weekly/latest.json       (overwritten each run)
data/weekly/dates.json        (sorted list of period_start values)
```

Naming by `period_start` (not publish date) parallels monthly (named by period month) and reads more naturally as "the week of 5/25" than "the digest published 6/1".

### Feature 3: Monthly Digest

**New script:** `scripts/build-monthly.mjs`

**Period:** Previous calendar month, ET. e.g. publish on first Beijing Mon of June 2026 covers ET 2026-05-01 → 2026-05-31.

**Trigger:** GH Actions `monthly.yml` cron `30 2 * * 1` (every Mon 02:30 UTC = Beijing 10:30). The script self-gates: on launch, check `if today is not the first Monday of the current Beijing month: log + exit 0`. This avoids the awkward cron syntax for "first Mon of month".

**First-Monday-of-month rule:**
```
let d = today (Beijing)
let firstOfMonth = first day of d's month
let firstMondayOfMonth = firstOfMonth + ((1 - firstOfMonth.day + 7) % 7)
gate: d == firstMondayOfMonth
```

**Source pool & algorithm:** Same as weekly, scaled to ~30 daily files. Same SECTIONS quota (5/4/3/5/3 = 20). Same per-source cap. Same LLM themes call (3–5 themes for the month).

**Output:**
```
data/monthly/2026-05.json    (named by the month covered, not publish date)
data/monthly/latest.json
data/monthly/dates.json      (sorted list of YYYY-MM)
```

### Feature 4: Frontend Tabs

**`public/index.html`:** After existing header, add:
```html
<nav class="digest-tabs">
  <button data-tab="daily" class="active">日报</button>
  <button data-tab="weekly">周报</button>
  <button data-tab="monthly">月报</button>
</nav>
```

**`public/app.js`:** Tab handler swaps the fetched JSON source:
- `daily` → `/data/latest.json` (current behavior)
- `weekly` → `/data/weekly/latest.json`
- `monthly` → `/data/monthly/latest.json`

URL hash deep-link: `#weekly` / `#monthly` selects the corresponding tab on load.

**Rendering reuse:** The existing item-card component renders weekly/monthly items unchanged. Add two extra blocks at the top of weekly/monthly views:

1. **Themes block** (only on weekly/monthly): a card showing the 3-5 themes with a chip per theme. Clicking a theme highlights the corresponding items below.
2. **Period block**: "本周 2026-05-25 → 2026-05-31（US/Eastern）" or "本月 2026 年 5 月".

**Daily window banner**: Only on the daily tab, only when `_diagnostics.window_hours > 24` (see Feature 1).

### Shared utilities — `scripts/lib/digest-core.mjs`

```js
export function loadDailyHistory(dates: string[]): DailyJson[]
export function reRankWithQuota(items, sections, perSourceCap): Item[]
export async function generateThemes(items, opts): Theme[]
export function etDateRange(periodStart: Date, periodEnd: Date): string[]  // returns Beijing data/<date>.json names covering the ET range
```

Both `build-weekly.mjs` and `build-monthly.mjs` are thin orchestrators: compute period → call loadDailyHistory → reRankWithQuota → generateThemes → write JSON + dates.json.

### CI / scheduling

**New files:**
- `.github/workflows/weekly.yml` — clone of daily.yml structure; cron `0 2 * * 1` UTC primary + `27 3,4,5 * * 1` retry trio (matches daily's pattern)
- `.github/workflows/monthly.yml` — cron `30 2 * * 1` UTC primary + retry trio; script self-gates
- `api/trigger-weekly.js` — invokes `node scripts/build-weekly.mjs` in Vercel runtime, commits + pushes (mirrors `trigger-daily.js`)
- `api/trigger-monthly.js` — same shape

**`vercel.json`** — add two cron entries:
```jsonc
{
  "crons": [
    { "path": "/api/trigger-daily",   "schedule": "57 0 * * *" },
    { "path": "/api/trigger-weekly",  "schedule": "0 2 * * 1" },
    { "path": "/api/trigger-monthly", "schedule": "30 2 * * 1" }
  ]
}
```

### Data contract

**Weekly/Monthly JSON schema:**

```jsonc
{
  "kind": "weekly" | "monthly",
  "publish_date": "2026-06-01",
  "period_start": "2026-05-25",   // ET, inclusive
  "period_end":   "2026-05-31",   // ET, inclusive
  "generated_at": 1779840000000,
  "themes": [
    {
      "title": "利率上行预期回潮",
      "item_ids": ["abc123", "def456"]
    }
  ],
  "items": [
    {
      // all daily-item fields, plus:
      "source_date": "2026-05-26",  // which daily JSON it came from
      // existing fields: source_id, source_name, title, link, description, published_at,
      // score, importance, section, tags, title_zh, summary_zh, impact, id, fetched_at, ...
    }
  ],
  "_diagnostics": {
    "source_dates": ["2026-05-25", "2026-05-26", ...],  // Beijing dates loaded
    "total_pool": 140,
    "post_dedupe": 87,
    "themes_generated": 4
  }
}
```

**Daily JSON addition (Feature 1):**

```jsonc
{
  // existing fields...
  "_diagnostics": {
    // existing fields...
    "window_hours": 24,                                    // NEW
    "pool_sizes": { "24h": 38, "48h": 91, "72h": 142 }    // NEW
  }
}
```

## Edge cases

- **First Monday of month falls on holiday** (e.g. New Year's Day on a Monday): script still runs; daily is the primary holiday-handling lever via Feature 1; monthly digest covers the previous month so it's not affected by the publish-day holiday.
- **Sparse weekly source** (e.g. only 5 of 7 daily JSON files exist because of a build failure): include what exists, log a warning to diagnostics, still produce a 20-item digest from the smaller pool.
- **Sparse monthly source** (< 100 unique items after dedupe): still publish; if section quota can't be met, log to diagnostics and fall back to "best of what we have" (same fallback shape as daily's `_from_fallback`).
- **Theme LLM call fails**: write `themes: []` and `_diagnostics.themes_error: "<message>"`; do not block the digest from publishing.
- **Beijing publish day = ET previous day**: For weekly published Beijing Mon 06-01, the period_end (ET Sun 05-31 23:59) is genuinely before publish moment. No overlap issues. For daily JSON files: a Beijing date D file may contain items whose `published_at` straddles ET D-1/D — filter by `published_at` epoch, not by file name.

## Testing

- Unit-test `etDateRange` for: standard week, week crossing month boundary, week crossing year boundary, DST transition (Nov 2026 fall-back, Mar 2027 spring-forward).
- Unit-test "first Monday of month" calculation for: month starting on Mon, Tue, Sun.
- Smoke test `build-weekly.mjs` against `data/2026-05-19.json` … `data/2026-05-25.json` (existing data) — should produce a non-empty 20-item digest with at least 1 theme.
- Smoke test `build-monthly.mjs` against May 2026 dailies — same expectation.
- Visual check: open the site, switch tabs, verify themes render, verify daily banner appears when `window_hours > 24`.

## Rollout order

1. Implement & commit Feature 1 (adaptive window) — backward compatible, ships next daily run.
2. Implement `digest-core.mjs` + `build-weekly.mjs` + `weekly.yml` + `trigger-weekly.js` — can run locally first, then enable cron.
3. Implement `build-monthly.mjs` + `monthly.yml` + `trigger-monthly.js`.
4. Implement frontend tabs + theme rendering + window banner.
5. Update `vercel.json` cron entries last (so the schedule doesn't fire before code is live).

## Risks

- **First weekly run before 7 days of clean data exist** — mitigation: launch on a Monday after observing 7 consecutive good daily commits.
- **LLM theme call timeout** — already a known issue for daily (see commit `268d6a3` SSE streaming fix); reuse the same `fetchLLMWithRetry` helper.
- **Date math drift across DST** — ET → UTC offset changes twice a year; use IANA `America/New_York` via `Intl.DateTimeFormat` or `Temporal` polyfill rather than fixed offset.
