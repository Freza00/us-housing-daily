# Weekly / Monthly Digest + Adaptive Window — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three coordinated changes to the news-agent pipeline: (1) adaptive 24h→48h→72h selection window so holiday/weekend collapses no longer read as "大面积扩窗" anomalies; (2) a Mon–Sun (ET) weekly Top-20 digest published every Beijing Monday 10:00; (3) a previous-calendar-month Top-20 digest published on the first Beijing Monday of each month at 10:30. All three reuse the existing daily outputs as their source pool — no new RSS fetching.

**Architecture:** Daily pipeline is treated as a stable upstream. Two new build scripts (`build-weekly.mjs`, `build-monthly.mjs`) share a single `scripts/lib/digest-core.mjs` module plus a date utility `scripts/lib/dates.mjs`. Each digest produces `data/weekly/<period_start>.json` or `data/monthly/<YYYY-MM>.json` plus its own `latest.json` and `dates.json`. Triggers mirror the daily pattern: GH Actions cron + Vercel Cron → repository_dispatch + retry trio. Frontend grows a `[日报 | 周报 | 月报]` tab strip that swaps the fetched JSON source; no separate sub-sites.

**Tech Stack:** Node 20+ (ESM, no transpile), zero npm deps, `node:test` for unit tests, GitHub Actions for cron, Vercel for static hosting + cron dispatch, existing `fetchLLMWithRetry` for the single theme-generation LLM call per digest.

**Spec:** `docs/superpowers/specs/2026-05-25-weekly-monthly-digest-design.md` (commit `9953f56`).

---

## File Map

**Create:**
- `scripts/lib/dates.mjs` — `etDateRange`, `firstMondayOfMonth`, `beijingDateStr`, `etWeekBounds`, `etMonthBounds`
- `scripts/lib/digest-core.mjs` — `loadDailyHistory`, `reRankWithQuota`, `generateThemes`, `SECTIONS_DAILY` re-export
- `scripts/build-weekly.mjs` — weekly digest orchestrator
- `scripts/build-monthly.mjs` — monthly digest orchestrator (with first-Monday self-gate)
- `scripts/test/dates.test.mjs` — unit tests for date utilities
- `scripts/test/digest-core.test.mjs` — unit tests for re-rank + theme parsing
- `scripts/test/build-weekly.smoke.mjs` — end-to-end smoke (LLM_SKIP=1)
- `scripts/test/build-monthly.smoke.mjs` — end-to-end smoke (LLM_SKIP=1)
- `api/trigger-weekly.js` — Vercel Cron → GH dispatch (clone of trigger-daily.js)
- `api/trigger-monthly.js` — same shape
- `.github/workflows/weekly.yml` — Mon 02:00 UTC + retry trio
- `.github/workflows/monthly.yml` — Mon 02:30 UTC + retry trio + first-Mon self-gate
- `data/weekly/` directory (gitkeep)
- `data/monthly/` directory (gitkeep)

**Modify:**
- `scripts/build.mjs` — adaptive window logic + new `_diagnostics` fields
- `public/index.html` — add tab nav, themes block placeholder, window banner placeholder
- `public/app.js` — tab routing, theme rendering, banner rendering, deep-link hash
- `public/style.css` — styles for tabs, themes, banner
- `vercel.json` — two new cron entries (added LAST, after code is live)
- `package.json` — add `test`, `build:weekly`, `build:monthly`, `build:weekly:dry`, `build:monthly:dry` scripts

**Don't touch:** `config/sources.json`, `config/sections.json`, daily SECTIONS / selector / classifier in `build.mjs` (outside the small window-selection block).

---

## Task 0: Test scaffolding

**Files:**
- Create: `scripts/test/_smoke.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add the npm test script + dry-run scripts**

Read current `package.json`, then replace its `scripts` block with:

```json
{
  "name": "us-housing-daily",
  "version": "0.2.0",
  "description": "美国住宅地产新闻聚合 — 每天北京 9 点 GitHub Actions 跑 pipeline，Vercel 静态站托管",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node --env-file=.env scripts/build.mjs",
    "build:dry": "LLM_SKIP=1 node scripts/build.mjs",
    "build:weekly": "node --env-file=.env scripts/build-weekly.mjs",
    "build:weekly:dry": "LLM_SKIP=1 node scripts/build-weekly.mjs",
    "build:monthly": "node --env-file=.env scripts/build-monthly.mjs",
    "build:monthly:dry": "LLM_SKIP=1 node scripts/build-monthly.mjs",
    "test": "node --test scripts/test/",
    "dry-run": "node scripts/dry-run.mjs",
    "preview": "cd public && (ln -sf ../data data 2>/dev/null; python3 -m http.server 8080)"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 2: Write a sentinel smoke test**

Create `scripts/test/_smoke.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";

test("test runner smoke — node:test wired up", () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 3: Run it**

```
npm test
```

Expected: 1 test passing, exit 0.

- [ ] **Step 4: Commit**

```bash
git add package.json scripts/test/_smoke.test.mjs
git commit -m "test: scaffold node:test runner + digest npm scripts"
```

---

## Task 1: Adaptive window in build.mjs

**Files:**
- Modify: `scripts/build.mjs` (around `computeWindowBounds` ~L60 and the `fresh24h` block ~L1828–1875, plus payload assembly ~L2075)
- Create: `scripts/test/adaptive-window.test.mjs`

- [ ] **Step 1: Write failing test for window selection logic**

Create `scripts/test/adaptive-window.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectEffectiveWindow } from "../lib/digest-core.mjs";

test("selectEffectiveWindow: pool >= 60 keeps 24h", () => {
  const r = selectEffectiveWindow({ pool24: 135, pool48: 200, pool72: 240 });
  assert.equal(r.hours, 24);
  assert.equal(r.pool_sizes["24h"], 135);
});

test("selectEffectiveWindow: pool < 60 expands to 48h", () => {
  const r = selectEffectiveWindow({ pool24: 38, pool48: 91, pool72: 142 });
  assert.equal(r.hours, 48);
});

test("selectEffectiveWindow: pool48 < 30 expands to 72h", () => {
  const r = selectEffectiveWindow({ pool24: 12, pool48: 22, pool72: 47 });
  assert.equal(r.hours, 72);
});

test("selectEffectiveWindow: still picks 72h even if pool72 also tiny", () => {
  const r = selectEffectiveWindow({ pool24: 5, pool48: 9, pool72: 18 });
  assert.equal(r.hours, 72);
});
```

- [ ] **Step 2: Run test — should fail with import error**

```
npm test
```

Expected: FAIL — `Cannot find module '../lib/digest-core.mjs'` (we'll create it minimally now).

- [ ] **Step 3: Create lib dir + minimal digest-core.mjs with selectEffectiveWindow**

```bash
mkdir -p scripts/lib
```

Create `scripts/lib/digest-core.mjs`:

```js
// Shared utilities for weekly/monthly digests and adaptive-window logic.

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
```

- [ ] **Step 4: Run test — should pass**

```
npm test
```

Expected: 5 tests passing (smoke + 4 adaptive-window).

- [ ] **Step 5: Wire adaptive window into build.mjs — extend computeWindowBounds**

Read `scripts/build.mjs` lines 58–72. Replace `computeWindowBounds` so it also returns 48h and 72h bounds:

```js
function computeWindowBounds(now) {
  const upper = new Date(now);
  upper.setUTCHours(WINDOW_END_UTC_HOUR, WINDOW_END_UTC_MIN, 0, 0);
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
```

- [ ] **Step 6: Wire adaptive window into the fresh-pool block**

Read `scripts/build.mjs` lines 1828–1875. Locate this block:

```js
  const { upper, lower24h, lower7d } = computeWindowBounds(now);
```

Replace destructuring and the lines that compute `filtered24h` / `deduped24h` / `fresh24h` with the adaptive variant. Find this region (around L1828–L1864):

```js
  const { upper, lower24h, lower7d } = computeWindowBounds(now);
  log(`⏰ window UTC [${new Date(lower24h).toISOString().slice(0,16)} ~ ${new Date(upper).toISOString().slice(0,16)})`);
  log(`⏰        北京 [${new Date(lower24h + 8*3600*1000).toISOString().slice(0,16).replace('T',' ')} ~ ${new Date(upper + 8*3600*1000).toISOString().slice(0,16).replace('T',' ')})`);

  const scored = allItems.map(it => scoreItem(it, now));
  // ... sourcesById / HOUSING_KW / inWindow / passesFilterRequired definitions stay ...

  const filtered24h = scored.filter(it => inWindow(it, lower24h) && passesFilterRequired(it));
  const filtered7d = scored.filter(it => inWindow(it, lower7d) && passesFilterRequired(it));
  const deduped24h = dedupe(filtered24h);
  const deduped7d = dedupe(filtered7d);
  log(`⏰ 24h-window filter ${filtered24h.length} → dedupe ${deduped24h.length}`);

  // 3. 跨日去重
  const seenAll = pruneSeen(loadSeen(), now);
  const todayBJ = beijingDateStr(now);
  const seenForFilter = seenAll.filter(s => s.shown_date !== todayBJ);
  const sameDayCount = seenAll.length - seenForFilter.length;
  const fresh24h = filterAlreadySeen(deduped24h, seenForFilter);
  const fresh7d = filterAlreadySeen(deduped7d, seenForFilter);
```

Replace with (preserve every comment + surrounding line not shown):

```js
  const { upper, lower24h, lower48h, lower72h, lower7d } = computeWindowBounds(now);
  log(`⏰ window UTC [${new Date(lower24h).toISOString().slice(0,16)} ~ ${new Date(upper).toISOString().slice(0,16)})`);
  log(`⏰        北京 [${new Date(lower24h + 8*3600*1000).toISOString().slice(0,16).replace('T',' ')} ~ ${new Date(upper + 8*3600*1000).toISOString().slice(0,16).replace('T',' ')})`);

  const scored = allItems.map(it => scoreItem(it, now));
  // ... sourcesById / HOUSING_KW / inWindow / passesFilterRequired stay unchanged ...

  // Build candidate pools for all three windows up front so we can pick adaptively.
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
  const todayBJ = beijingDateStr(now);
  const seenForFilter = seenAll.filter(s => s.shown_date !== todayBJ);
  const sameDayCount = seenAll.length - seenForFilter.length;
  const candidate24h = filterAlreadySeen(deduped24h, seenForFilter);
  const candidate48h = filterAlreadySeen(deduped48h, seenForFilter);
  const candidate72h = filterAlreadySeen(deduped72h, seenForFilter);
  const fresh7d      = filterAlreadySeen(deduped7d,  seenForFilter);

  // Adaptive window: pick smallest window whose pool meets the freshness floor.
  const { selectEffectiveWindow } = await import("./lib/digest-core.mjs");
  const winSel = selectEffectiveWindow({
    pool24: candidate24h.length,
    pool48: candidate48h.length,
    pool72: candidate72h.length,
  });
  const fresh24h = winSel.hours === 24 ? candidate24h
                 : winSel.hours === 48 ? candidate48h
                 :                       candidate72h;
  // Re-flag items older than 24h within the effective window so the existing
  // extended_window semantic is preserved (ext = "older than the canonical fresh day").
  for (const it of fresh24h) {
    if (it.published_at && it.published_at < lower24h) it._ext_eligible = true;
  }
  log(`⏰ adaptive window: chose ${winSel.hours}h (pool24=${candidate24h.length} pool48=${candidate48h.length} pool72=${candidate72h.length})`);
  log(`⏰ 24h-window filter ${filtered24h.length} → dedupe ${deduped24h.length}`);
  log(`📅 cross-day filter: seen ${seenAll.length} → fresh ${fresh24h.length} (eff${winSel.hours}h) / ${fresh7d.length} (7d)${sameDayCount > 0 ? ` (今日 ${sameDayCount} 条不参与剔除)` : ""}`);
```

Note: the `await import(...)` works because `runBuild` (or whichever async function wraps this block) is already async. If the surrounding function is sync, hoist the import to the top of `build.mjs` instead. Confirm by reading the function signature first.

- [ ] **Step 7: Inject window diagnostics into payload**

Read `scripts/build.mjs` lines 2070–2095. Replace the `_diagnostics` block:

```js
    _diagnostics: {
      writer_mode: WRITER_MODE,
      sectionsUnderMin: minDiag?.underMin || [],
      window_hours: winSel.hours,
      pool_sizes: winSel.pool_sizes,
      ...(writerAudit ? {
        writer_audit: writerAudit,
        candidate_pool_size: candidatePoolSize,
      } : {}),
    },
```

`winSel` must be in scope here. If the payload assembly is in a different function than the window selection, thread `winSel` through as a parameter, or hoist it onto a closure-captured variable declared at the same scope as `payload`.

- [ ] **Step 8: Smoke-test build.mjs against current data**

```bash
LLM_SKIP=1 node scripts/build.mjs 2>&1 | tail -30
```

Expected: pipeline runs to completion, log line `adaptive window: chose 24h (poolXX=...)` appears, `data/latest.json` has `_diagnostics.window_hours` and `_diagnostics.pool_sizes` fields.

Verify:
```bash
python3 -c "import json; d=json.load(open('data/latest.json')); print(d['_diagnostics']['window_hours'], d['_diagnostics']['pool_sizes'])"
```

Expected: prints a number (24/48/72) and a dict like `{'24h': N, '48h': N, '72h': N}`.

- [ ] **Step 9: Run unit tests again**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 10: Commit**

```bash
git add scripts/build.mjs scripts/lib/digest-core.mjs scripts/test/adaptive-window.test.mjs
git commit -m "feat(build): adaptive 24h/48h/72h window with pool-size thresholds"
```

---

## Task 2: Date utilities — ET week / month boundaries + first-Monday-of-month

**Files:**
- Create: `scripts/lib/dates.mjs`
- Create: `scripts/test/dates.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `scripts/test/dates.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  etWeekBounds,
  etMonthBounds,
  firstMondayOfMonth,
  isFirstMondayOfMonth,
  beijingDateStr,
  beijingDatesCoveringEtRange,
} from "../lib/dates.mjs";

// etWeekBounds — for a Beijing publish day, returns the ET Mon→Sun of the prior week.
test("etWeekBounds: Beijing Mon 2026-06-01 covers ET 2026-05-25 → 2026-05-31", () => {
  const r = etWeekBounds(new Date("2026-06-01T02:00:00Z")); // Beijing 10:00
  assert.equal(r.periodStart, "2026-05-25");
  assert.equal(r.periodEnd, "2026-05-31");
});

test("etWeekBounds: handles year-crossing week (Beijing Mon 2027-01-04 → ET 2026-12-28 → 2027-01-03)", () => {
  const r = etWeekBounds(new Date("2027-01-04T02:00:00Z"));
  assert.equal(r.periodStart, "2026-12-28");
  assert.equal(r.periodEnd, "2027-01-03");
});

test("etMonthBounds: Beijing first-Mon of June 2026 (2026-06-01) covers ET May 2026", () => {
  const r = etMonthBounds(new Date("2026-06-01T02:30:00Z"));
  assert.equal(r.periodStart, "2026-05-01");
  assert.equal(r.periodEnd, "2026-05-31");
  assert.equal(r.label, "2026-05");
});

test("etMonthBounds: first-Mon of Jan 2027 covers Dec 2026", () => {
  const r = etMonthBounds(new Date("2027-01-04T02:30:00Z"));
  assert.equal(r.periodStart, "2026-12-01");
  assert.equal(r.periodEnd, "2026-12-31");
  assert.equal(r.label, "2026-12");
});

test("firstMondayOfMonth: June 2026 = June 1", () => {
  assert.equal(firstMondayOfMonth(2026, 6), "2026-06-01");
});

test("firstMondayOfMonth: Feb 2026 = Feb 2", () => {
  assert.equal(firstMondayOfMonth(2026, 2), "2026-02-02");
});

test("firstMondayOfMonth: Aug 2026 = Aug 3", () => {
  assert.equal(firstMondayOfMonth(2026, 8), "2026-08-03");
});

test("isFirstMondayOfMonth: true on 2026-06-01 Beijing morning", () => {
  assert.equal(isFirstMondayOfMonth(new Date("2026-06-01T02:30:00Z")), true);
});

test("isFirstMondayOfMonth: false on 2026-06-08 (second Mon)", () => {
  assert.equal(isFirstMondayOfMonth(new Date("2026-06-08T02:30:00Z")), false);
});

test("beijingDateStr: 2026-05-25T15:30Z is Beijing 2026-05-25", () => {
  assert.equal(beijingDateStr(new Date("2026-05-25T15:30:00Z").getTime()), "2026-05-25");
});

test("beijingDateStr: 2026-05-25T16:30Z is Beijing 2026-05-26", () => {
  assert.equal(beijingDateStr(new Date("2026-05-25T16:30:00Z").getTime()), "2026-05-26");
});

// beijingDatesCoveringEtRange — given ET period start/end, return Beijing data/<date>.json names
// that could plausibly contain items in that ET range. The daily window cutoff is 08:57 Beijing
// (= 20:57 ET prior day in EDT, 19:57 in EST), so each Beijing file D contains items roughly
// in ET [D-1 ~21:00, D ~21:00). Use a generous ±1 day buffer.
test("beijingDatesCoveringEtRange: ET week 2026-05-25 → 2026-05-31 maps to Beijing 2026-05-25 → 2026-06-01", () => {
  const dates = beijingDatesCoveringEtRange("2026-05-25", "2026-05-31");
  assert.deepEqual(dates, [
    "2026-05-25", "2026-05-26", "2026-05-27", "2026-05-28",
    "2026-05-29", "2026-05-30", "2026-05-31", "2026-06-01",
  ]);
});
```

- [ ] **Step 2: Run tests — expect ALL to fail (module missing)**

```
npm test
```

Expected: dates.test.mjs reports cannot find module.

- [ ] **Step 3: Implement dates.mjs**

Create `scripts/lib/dates.mjs`:

```js
// Date math for digest period boundaries. All ET-aware via Intl.DateTimeFormat
// (America/New_York), no fixed offsets — DST is handled correctly.

const ET_TZ = "America/New_York";
const BJ_OFFSET_MS = 8 * 3600 * 1000;

// Convert epoch ms → "YYYY-MM-DD" in ET.
function etDateStr(ms) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: ET_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(new Date(ms)); // en-CA renders YYYY-MM-DD natively
}

// Convert epoch ms → "YYYY-MM-DD" in Beijing.
export function beijingDateStr(ms) {
  const d = new Date(ms + BJ_OFFSET_MS);
  return d.toISOString().slice(0, 10);
}

// Get the ET day-of-week (0=Sun, 1=Mon, ..., 6=Sat) for an epoch ms.
function etWeekday(ms) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: ET_TZ, weekday: "short" });
  const wk = fmt.format(new Date(ms));
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wk];
}

// Add N days to a "YYYY-MM-DD" string (interpreted as UTC midnight, safe for date arithmetic).
function addDays(yyyymmdd, n) {
  const d = new Date(yyyymmdd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// For a publish moment (typically Beijing Mon ~10:00 = ~02:00 UTC), return the
// PRIOR full ET week as Mon-start → Sun-end. ET "now" is Sunday evening when
// Beijing is Monday morning, so look back to the most recent COMPLETED Sun.
export function etWeekBounds(publishMoment) {
  const ms = publishMoment.getTime();
  const todayEt = etDateStr(ms);              // ET calendar day of publish moment
  const wd = etWeekday(ms);                   // 0=Sun..6=Sat
  // Days to step back to reach the most recent COMPLETED Sunday.
  // If ET today is Sun → period_end = today; otherwise = previous Sun.
  const daysBackToSun = wd === 0 ? 0 : wd;    // Sun→0, Mon→1, Tue→2, ..., Sat→6
  const periodEnd = addDays(todayEt, -daysBackToSun);
  const periodStart = addDays(periodEnd, -6); // Mon of that same week
  return { periodStart, periodEnd };
}

// For a publish moment, return the PRIOR calendar month in ET.
export function etMonthBounds(publishMoment) {
  const todayEt = etDateStr(publishMoment.getTime());
  const [y, m] = todayEt.split("-").map(Number);
  // Previous month
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  const periodStart = `${prevY}-${String(prevM).padStart(2, "0")}-01`;
  // Last day of prevM = day 0 of prevM+1
  const lastDay = new Date(Date.UTC(prevY, prevM, 0)).getUTCDate();
  const periodEnd = `${prevY}-${String(prevM).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { periodStart, periodEnd, label: `${prevY}-${String(prevM).padStart(2, "0")}` };
}

// Compute the first Monday of (year, month-1-indexed). Returns YYYY-MM-DD.
export function firstMondayOfMonth(year, month1Indexed) {
  const first = new Date(Date.UTC(year, month1Indexed - 1, 1));
  // getUTCDay: 0=Sun..6=Sat. Days to add to land on Monday.
  const wd = first.getUTCDay();
  const daysToMon = wd === 0 ? 1 : (wd === 1 ? 0 : 8 - wd);
  const mon = new Date(first);
  mon.setUTCDate(1 + daysToMon);
  return mon.toISOString().slice(0, 10);
}

// Check whether the Beijing calendar date of `now` is the first Monday of its
// Beijing month. Use Beijing (not ET) because the cron fires on Beijing Mondays.
export function isFirstMondayOfMonth(now) {
  const bjDate = beijingDateStr(now.getTime());
  const [y, m] = bjDate.split("-").map(Number);
  return firstMondayOfMonth(y, m) === bjDate;
}

// Given an ET range [periodStart, periodEnd] (inclusive), return the list of
// Beijing data/<date>.json names that could contain items in that ET range.
// Daily cutoff is ~08:57 Beijing (≈ 20:57 ET prior day in EDT). Items from
// ET day D appear in Beijing file D or D+1; bracket ±1 day to be safe.
export function beijingDatesCoveringEtRange(periodStart, periodEnd) {
  const out = [];
  let d = periodStart;
  // Start one Beijing day earlier just in case the cutoff edge cut into the prior file.
  // In practice the first useful Beijing file == periodStart, and the last is periodEnd+1.
  while (d <= addDays(periodEnd, 1)) {
    out.push(d);
    d = addDays(d, 1);
  }
  return out;
}
```

- [ ] **Step 4: Run tests — all green**

```
npm test
```

Expected: all dates.test.mjs cases pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/dates.mjs scripts/test/dates.test.mjs
git commit -m "feat(lib): ET week/month bounds + first-Mon-of-month + Beijing date mapping"
```

---

## Task 3: Digest core — loadDailyHistory + reRankWithQuota

**Files:**
- Modify: `scripts/lib/digest-core.mjs` (extend the file from Task 1)
- Create: `scripts/test/digest-core.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `scripts/test/digest-core.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadDailyHistory,
  reRankWithQuota,
  SECTIONS_DAILY,
} from "../lib/digest-core.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../data");

test("SECTIONS_DAILY: quotas sum to 20", () => {
  const sum = SECTIONS_DAILY.reduce((a, s) => a + s.quota, 0);
  assert.equal(sum, 20);
});

test("loadDailyHistory: real May 2026 files load + dedupe by link", () => {
  const dates = ["2026-05-19", "2026-05-20", "2026-05-21", "2026-05-22", "2026-05-23"];
  const res = loadDailyHistory(dates, DATA_DIR);
  assert.ok(res.items.length > 0, "should load at least 1 item");
  assert.ok(res.loaded_dates.length >= 1);
  // Dedupe: every link unique
  const links = res.items.map(it => it.link);
  assert.equal(new Set(links).size, links.length);
  // source_date stamped on every item
  for (const it of res.items) {
    assert.ok(it.source_date, `item ${it.id} missing source_date`);
    assert.match(it.source_date, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test("loadDailyHistory: missing files reported in errors, doesn't throw", () => {
  const dates = ["2026-05-19", "1999-01-01"];
  const res = loadDailyHistory(dates, DATA_DIR);
  assert.ok(res.errors.find(e => e.includes("1999-01-01")), "missing date in errors");
  assert.ok(res.items.length > 0, "valid dates still loaded");
});

test("reRankWithQuota: respects section quotas + per-source cap", () => {
  // Synthetic items: 30 in 'national' all from one source → cap to 2 in that section
  const items = [];
  for (let i = 0; i < 30; i++) {
    items.push({
      id: `n${i}`, link: `https://x.com/n${i}`,
      source_id: "src-a", section: "national",
      importance: 5, score: 100 - i,
      published_at: Date.now() - i * 3600 * 1000,
    });
  }
  // Also seed 5 cre items from different sources, all importance 5
  for (let i = 0; i < 5; i++) {
    items.push({
      id: `c${i}`, link: `https://x.com/c${i}`,
      source_id: `src-${i}`, section: "cre",
      importance: 5, score: 50,
      published_at: Date.now() - 2 * 3600 * 1000,
    });
  }
  const top = reRankWithQuota(items, SECTIONS_DAILY, { perSourceCap: 2 });
  const natCount = top.filter(it => it.section === "national").length;
  const creCount = top.filter(it => it.section === "cre").length;
  assert.ok(natCount <= 5, "national capped at quota=5");
  // src-a contributed to national; cap = 2
  const srcACount = top.filter(it => it.source_id === "src-a").length;
  assert.ok(srcACount <= 2, "per-source cap holds");
  assert.ok(creCount <= 5, "cre capped at quota=5");
});

test("reRankWithQuota: sorts by importance*100 + score - age penalty", () => {
  const now = Date.now();
  const items = [
    { id: "old-hi-imp",   link: "u1", source_id: "s1", section: "national",
      importance: 5, score: 10, published_at: now - 7 * 24 * 3600 * 1000 },
    { id: "new-low-imp",  link: "u2", source_id: "s2", section: "national",
      importance: 2, score: 90, published_at: now - 1 * 3600 * 1000 },
  ];
  const top = reRankWithQuota(items, SECTIONS_DAILY, { perSourceCap: 2 });
  // High importance should win even with worse freshness (5*100=500 ≫ 2*100+90=290)
  assert.equal(top[0].id, "old-hi-imp");
});
```

- [ ] **Step 2: Run tests — should fail**

```
npm test
```

Expected: `loadDailyHistory`, `reRankWithQuota`, `SECTIONS_DAILY` not found.

- [ ] **Step 3: Extend digest-core.mjs**

Append to `scripts/lib/digest-core.mjs` (keep the existing `selectEffectiveWindow` from Task 1):

```js
import fs from "node:fs";
import path from "node:path";

// Mirror of SECTIONS from build.mjs — kept in sync manually because we don't want
// digest scripts to import the whole build pipeline. If you change build.mjs SECTIONS
// you MUST update this table too. (Test in digest-core.test.mjs locks the 20-item sum.)
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
// (importance dominates; freshness is only a tiebreaker over the 7d horizon).
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
  const perSectionSource = new Map(); // key: `${section}:${source_id}` → count

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
    // Early exit: all sections filled
    if (sections.every(s => (perSection.get(s.id) || 0) >= s.quota)) break;
  }
  // Strip internal field
  return top.map(({ _rerank, ...rest }) => rest);
}
```

- [ ] **Step 4: Run tests — all green**

```
npm test
```

Expected: all digest-core.test.mjs cases pass. If `loadDailyHistory` test fails because of date filename mismatches, adjust the fixture dates to match files that actually exist in `data/`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/digest-core.mjs scripts/test/digest-core.test.mjs
git commit -m "feat(lib): digest-core loadDailyHistory + reRankWithQuota (+ SECTIONS_DAILY)"
```

---

## Task 4: Theme LLM helper — generateThemes (with fail-open)

**Files:**
- Modify: `scripts/lib/digest-core.mjs`
- Create: `scripts/test/themes.test.mjs`

- [ ] **Step 1: Write tests for theme parser**

Create `scripts/test/themes.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseThemesResponse } from "../lib/digest-core.mjs";

test("parseThemesResponse: well-formed JSON returns themes array", () => {
  const raw = `{"themes":[{"title":"利率上行预期回潮","item_indices":[1,3,7]},{"title":"机构资本回笼","item_indices":[5,12]}]}`;
  const items = Array.from({ length: 20 }, (_, i) => ({ id: `id-${i + 1}` }));
  const res = parseThemesResponse(raw, items);
  assert.equal(res.length, 2);
  assert.equal(res[0].title, "利率上行预期回潮");
  assert.deepEqual(res[0].item_ids, ["id-1", "id-3", "id-7"]);
});

test("parseThemesResponse: extracts JSON from markdown fence", () => {
  const raw = "```json\n{\"themes\":[{\"title\":\"X\",\"item_indices\":[1]}]}\n```";
  const items = [{ id: "id-1" }];
  const res = parseThemesResponse(raw, items);
  assert.equal(res.length, 1);
});

test("parseThemesResponse: drops out-of-range indices silently", () => {
  const raw = `{"themes":[{"title":"X","item_indices":[1,999,2]}]}`;
  const items = [{ id: "id-1" }, { id: "id-2" }];
  assert.deepEqual(parseThemesResponse(raw, items)[0].item_ids, ["id-1", "id-2"]);
});

test("parseThemesResponse: malformed returns empty (fail-open)", () => {
  assert.deepEqual(parseThemesResponse("not json", [{ id: "x" }]), []);
});

test("parseThemesResponse: caps title length to 50 chars", () => {
  const longTitle = "本周主线".repeat(30);
  const raw = JSON.stringify({ themes: [{ title: longTitle, item_indices: [1] }] });
  const res = parseThemesResponse(raw, [{ id: "id-1" }]);
  assert.ok(res[0].title.length <= 50);
});
```

- [ ] **Step 2: Run tests — should fail**

```
npm test
```

- [ ] **Step 3: Implement parseThemesResponse + generateThemes**

Append to `scripts/lib/digest-core.mjs`:

```js
// Parse the LLM theme response. Tolerant of bare JSON, markdown code fences,
// extra prose. Returns Theme[] or [] (fail-open).
export function parseThemesResponse(raw, items) {
  if (!raw || typeof raw !== "string") return [];
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) text = fence[1];
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (!objMatch) return [];
  let parsed;
  try { parsed = JSON.parse(objMatch[0]); } catch { return []; }
  const themes = Array.isArray(parsed?.themes) ? parsed.themes : [];
  return themes
    .filter(t => t && typeof t.title === "string" && Array.isArray(t.item_indices))
    .map(t => ({
      title: t.title.slice(0, 50),
      item_ids: t.item_indices.map(i => items[Number(i) - 1]?.id).filter(Boolean),
    }))
    .filter(t => t.item_ids.length > 0);
}

// Single LLM call to extract 3–5 "themes" from digest items.
// `callLLM` is injected so this module stays decoupled from build.mjs.
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
```

- [ ] **Step 4: Run tests — green**

```
npm test
```

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/digest-core.mjs scripts/test/themes.test.mjs
git commit -m "feat(lib): generateThemes + tolerant parseThemesResponse (fail-open)"
```

---

## Task 5: build-weekly.mjs orchestrator

**Files:**
- Create: `scripts/build-weekly.mjs`
- Create: `scripts/test/build-weekly.smoke.mjs`
- Create: `data/weekly/.gitkeep`

- [ ] **Step 1: Ensure output dir**

```bash
mkdir -p data/weekly && touch data/weekly/.gitkeep
```

- [ ] **Step 2: Write smoke test (uses spawnSync with array args, no shell)**

Create `scripts/test/build-weekly.smoke.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

test("build-weekly: end-to-end smoke writes a non-empty digest",
  { skip: !process.env.RUN_SMOKE },
  () => {
    const r = spawnSync("node", ["scripts/build-weekly.mjs"], {
      cwd: ROOT,
      env: { ...process.env, LLM_SKIP: "1", PUBLISH_NOW: "2026-05-25T02:00:00Z" },
      stdio: "inherit",
    });
    assert.equal(r.status, 0);

    const out = JSON.parse(fs.readFileSync(path.join(ROOT, "data/weekly/latest.json"), "utf8"));
    assert.equal(out.kind, "weekly");
    assert.equal(out.period_start, "2026-05-18");
    assert.equal(out.period_end, "2026-05-24");
    assert.ok(out.items.length > 0);
    assert.ok(out.items.length <= 20);
    assert.equal(out.themes.length, 0); // LLM_SKIP

    const dates = JSON.parse(fs.readFileSync(path.join(ROOT, "data/weekly/dates.json"), "utf8"));
    assert.ok(dates.includes("2026-05-18"));
  }
);
```

- [ ] **Step 3: Implement build-weekly.mjs**

Create `scripts/build-weekly.mjs`:

```js
// Weekly digest builder. Re-ranks items from the past ET week's daily JSON files,
// applies daily SECTIONS quota (5/4/3/5/3 = 20), and optionally generates a
// "本周主线" theme summary via a single LLM call.
//
// Trigger: GH Actions Mon 02:00 UTC + Vercel Cron.
// Env: PUBLISH_NOW (ISO override), LLM_SKIP, LLM_API_KEY, LLM_ENDPOINT, LLM_MODEL

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadDailyHistory, reRankWithQuota, generateThemes, SECTIONS_DAILY,
} from "./lib/digest-core.mjs";
import {
  etWeekBounds, beijingDateStr, beijingDatesCoveringEtRange,
} from "./lib/dates.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const OUT_DIR = path.join(DATA_DIR, "weekly");

const log = (msg) => console.log(`[weekly] ${msg}`);

async function callLLMShim(systemPrompt, userPrompt, opts) {
  const apiKey = process.env.LLM_API_KEY;
  const endpoint = process.env.LLM_ENDPOINT;
  const model = process.env.LLM_MODEL;
  if (!apiKey || !endpoint || !model) throw new Error("Missing LLM_* env");
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: opts.temperature ?? 0.3,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? "";
}

async function main() {
  const now = process.env.PUBLISH_NOW ? new Date(process.env.PUBLISH_NOW) : new Date();
  log(`publish_at = ${now.toISOString()} (Beijing ${beijingDateStr(now.getTime())})`);

  const { periodStart, periodEnd } = etWeekBounds(now);
  log(`ET period = ${periodStart} → ${periodEnd}`);

  const beijingDates = beijingDatesCoveringEtRange(periodStart, periodEnd);
  log(`reading Beijing daily files: ${beijingDates.join(", ")}`);

  const { items: pool, loaded_dates, errors } = loadDailyHistory(beijingDates, DATA_DIR);
  log(`pool=${pool.length} from ${loaded_dates.length} files (${errors.length} errors)`);

  // Filter to ET period (with ±1d buffer for DST safety; daily upstream already gates by 24h).
  const periodStartMs = new Date(`${periodStart}T00:00:00-05:00`).getTime() - 24 * 3600 * 1000;
  const periodEndMs   = new Date(`${periodEnd}T23:59:59-05:00`).getTime() + 24 * 3600 * 1000;
  const filtered = pool.filter(it =>
    it.published_at && it.published_at >= periodStartMs && it.published_at <= periodEndMs
  );
  log(`pool after period filter: ${filtered.length}`);

  const top = reRankWithQuota(filtered, SECTIONS_DAILY, { perSourceCap: 2, now: now.getTime() });
  log(`top picked: ${top.length}`);

  let themes = [], themesError = null;
  if (process.env.LLM_SKIP) {
    log("LLM_SKIP=1 — skipping themes");
  } else {
    const r = await generateThemes(top, { callLLM: callLLMShim, periodLabel: "本周" });
    themes = r.themes;
    themesError = r.error || null;
    log(`themes: ${themes.length}${themesError ? ` (error: ${themesError})` : ""}`);
  }

  const payload = {
    kind: "weekly",
    publish_date: beijingDateStr(now.getTime()),
    period_start: periodStart,
    period_end: periodEnd,
    generated_at: now.getTime(),
    themes,
    items: top,
    _diagnostics: {
      source_dates: loaded_dates,
      total_pool: pool.length,
      post_period_filter: filtered.length,
      themes_generated: themes.length,
      ...(themesError ? { themes_error: themesError } : {}),
      ...(errors.length ? { load_errors: errors } : {}),
    },
  };

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `${periodStart}.json`), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "latest.json"), JSON.stringify(payload, null, 2));
  log(`💾 wrote ${periodStart}.json + latest.json`);

  const datesFile = path.join(OUT_DIR, "dates.json");
  let datesList = [];
  if (fs.existsSync(datesFile)) {
    try { datesList = JSON.parse(fs.readFileSync(datesFile, "utf8")); } catch {}
  }
  if (!datesList.includes(periodStart)) {
    datesList.push(periodStart);
    datesList.sort();
    fs.writeFileSync(datesFile, JSON.stringify(datesList, null, 2));
    log(`💾 updated dates.json (${datesList.length})`);
  }
}

main().catch(e => {
  console.error(`[weekly] FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
```

- [ ] **Step 4: Dry-run locally**

```
npm run build:weekly:dry
```

Expected: log shows ET period 2026-05-18 → 2026-05-24 (assuming today is 2026-05-25), pool > 0, top ≤ 20, themes skipped. Verify:

```
python3 -c "import json; d=json.load(open('data/weekly/latest.json')); print('items',len(d['items']),'period',d['period_start'],'→',d['period_end'])"
```

- [ ] **Step 5: Run smoke test**

```
RUN_SMOKE=1 npm test
```

- [ ] **Step 6: Commit**

```bash
git add scripts/build-weekly.mjs scripts/test/build-weekly.smoke.mjs data/weekly/
git commit -m "feat(weekly): build-weekly.mjs digest builder + smoke test"
```

---

## Task 6: build-monthly.mjs orchestrator + first-Monday self-gate

**Files:**
- Create: `scripts/build-monthly.mjs`
- Create: `scripts/test/build-monthly.smoke.mjs`
- Create: `data/monthly/.gitkeep`

- [ ] **Step 1: Ensure output dir**

```bash
mkdir -p data/monthly && touch data/monthly/.gitkeep
```

- [ ] **Step 2: Write smoke test**

Create `scripts/test/build-monthly.smoke.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

test("build-monthly: end-to-end smoke with FORCE_RUN=1",
  { skip: !process.env.RUN_SMOKE },
  () => {
    // PUBLISH_NOW is the first Mon of June 2026; FORCE_RUN bypasses the gate
    // (in case we run smoke on a different calendar day).
    const r = spawnSync("node", ["scripts/build-monthly.mjs"], {
      cwd: ROOT,
      env: {
        ...process.env,
        LLM_SKIP: "1",
        PUBLISH_NOW: "2026-06-01T02:30:00Z",
        FORCE_RUN: "1",
      },
      stdio: "inherit",
    });
    assert.equal(r.status, 0);

    const out = JSON.parse(fs.readFileSync(path.join(ROOT, "data/monthly/latest.json"), "utf8"));
    assert.equal(out.kind, "monthly");
    assert.equal(out.period_start, "2026-05-01");
    assert.equal(out.period_end, "2026-05-31");
    assert.ok(out.items.length > 0);
    assert.ok(out.items.length <= 20);
  }
);

test("build-monthly: self-gates and exits 0 on non-first-Monday",
  { skip: !process.env.RUN_SMOKE },
  () => {
    // 2026-06-08 is the second Monday of June; without FORCE_RUN the script should no-op.
    const r = spawnSync("node", ["scripts/build-monthly.mjs"], {
      cwd: ROOT,
      env: {
        ...process.env,
        LLM_SKIP: "1",
        PUBLISH_NOW: "2026-06-08T02:30:00Z",
      },
      stdio: "pipe",
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout.toString(), /not the first Monday/i);
  }
);
```

- [ ] **Step 3: Implement build-monthly.mjs**

Create `scripts/build-monthly.mjs`:

```js
// Monthly digest builder. Same algorithm as build-weekly.mjs but over a calendar
// month period (ET), with a self-gate that no-ops unless today is the first
// Monday of the Beijing month (the gate avoids needing complex "first-Mon-of-month"
// cron syntax — we simply schedule every Monday and exit early on the others).
//
// Trigger: GH Actions Mon 02:30 UTC + Vercel Cron.
// Env: PUBLISH_NOW, FORCE_RUN (bypass gate), LLM_SKIP, LLM_API_KEY / LLM_ENDPOINT / LLM_MODEL

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadDailyHistory, reRankWithQuota, generateThemes, SECTIONS_DAILY,
} from "./lib/digest-core.mjs";
import {
  etMonthBounds, beijingDateStr, beijingDatesCoveringEtRange, isFirstMondayOfMonth,
} from "./lib/dates.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const OUT_DIR = path.join(DATA_DIR, "monthly");

const log = (msg) => console.log(`[monthly] ${msg}`);

async function callLLMShim(systemPrompt, userPrompt, opts) {
  const apiKey = process.env.LLM_API_KEY;
  const endpoint = process.env.LLM_ENDPOINT;
  const model = process.env.LLM_MODEL;
  if (!apiKey || !endpoint || !model) throw new Error("Missing LLM_* env");
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: opts.temperature ?? 0.3,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? "";
}

async function main() {
  const now = process.env.PUBLISH_NOW ? new Date(process.env.PUBLISH_NOW) : new Date();

  // Self-gate
  if (!process.env.FORCE_RUN && !isFirstMondayOfMonth(now)) {
    log(`Beijing ${beijingDateStr(now.getTime())} is not the first Monday of the month — skipping`);
    return;
  }

  log(`publish_at = ${now.toISOString()} (Beijing ${beijingDateStr(now.getTime())})`);

  const { periodStart, periodEnd, label } = etMonthBounds(now);
  log(`ET period = ${periodStart} → ${periodEnd} (label=${label})`);

  const beijingDates = beijingDatesCoveringEtRange(periodStart, periodEnd);
  log(`reading ${beijingDates.length} Beijing daily files (${beijingDates[0]} … ${beijingDates.at(-1)})`);

  const { items: pool, loaded_dates, errors } = loadDailyHistory(beijingDates, DATA_DIR);
  log(`pool=${pool.length} from ${loaded_dates.length} files (${errors.length} errors)`);

  const periodStartMs = new Date(`${periodStart}T00:00:00-05:00`).getTime() - 24 * 3600 * 1000;
  const periodEndMs   = new Date(`${periodEnd}T23:59:59-05:00`).getTime() + 24 * 3600 * 1000;
  const filtered = pool.filter(it =>
    it.published_at && it.published_at >= periodStartMs && it.published_at <= periodEndMs
  );
  log(`pool after period filter: ${filtered.length}`);

  const top = reRankWithQuota(filtered, SECTIONS_DAILY, { perSourceCap: 2, now: now.getTime() });
  log(`top picked: ${top.length}`);

  let themes = [], themesError = null;
  if (process.env.LLM_SKIP) {
    log("LLM_SKIP=1 — skipping themes");
  } else {
    const r = await generateThemes(top, { callLLM: callLLMShim, periodLabel: "本月" });
    themes = r.themes;
    themesError = r.error || null;
    log(`themes: ${themes.length}${themesError ? ` (error: ${themesError})` : ""}`);
  }

  const payload = {
    kind: "monthly",
    publish_date: beijingDateStr(now.getTime()),
    period_start: periodStart,
    period_end: periodEnd,
    period_label: label,
    generated_at: now.getTime(),
    themes,
    items: top,
    _diagnostics: {
      source_dates: loaded_dates,
      total_pool: pool.length,
      post_period_filter: filtered.length,
      themes_generated: themes.length,
      ...(themesError ? { themes_error: themesError } : {}),
      ...(errors.length ? { load_errors: errors } : {}),
    },
  };

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `${label}.json`), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "latest.json"), JSON.stringify(payload, null, 2));
  log(`💾 wrote ${label}.json + latest.json`);

  const datesFile = path.join(OUT_DIR, "dates.json");
  let datesList = [];
  if (fs.existsSync(datesFile)) {
    try { datesList = JSON.parse(fs.readFileSync(datesFile, "utf8")); } catch {}
  }
  if (!datesList.includes(label)) {
    datesList.push(label);
    datesList.sort();
    fs.writeFileSync(datesFile, JSON.stringify(datesList, null, 2));
    log(`💾 updated dates.json (${datesList.length})`);
  }
}

main().catch(e => {
  console.error(`[monthly] FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
```

- [ ] **Step 4: Dry-run with gate bypassed**

```
FORCE_RUN=1 LLM_SKIP=1 PUBLISH_NOW=2026-06-01T02:30:00Z node scripts/build-monthly.mjs
```

Expected: log shows ET period 2026-05-01 → 2026-05-31, pool > 0, top ≤ 20. Verify:

```
python3 -c "import json; d=json.load(open('data/monthly/latest.json')); print('label',d['period_label'],'items',len(d['items']))"
```

- [ ] **Step 5: Verify self-gate**

```
LLM_SKIP=1 PUBLISH_NOW=2026-06-08T02:30:00Z node scripts/build-monthly.mjs
```

Expected: output `[monthly] Beijing 2026-06-08 is not the first Monday of the month — skipping` and exit 0. NO file written.

- [ ] **Step 6: Run smoke tests**

```
RUN_SMOKE=1 npm test
```

- [ ] **Step 7: Commit**

```bash
git add scripts/build-monthly.mjs scripts/test/build-monthly.smoke.mjs data/monthly/
git commit -m "feat(monthly): build-monthly.mjs digest builder + first-Mon self-gate"
```

---

## Task 7: API trigger endpoints

**Files:**
- Create: `api/trigger-weekly.js`
- Create: `api/trigger-monthly.js`

- [ ] **Step 1: Create trigger-weekly.js (clone of trigger-daily.js)**

```js
// Vercel Cron endpoint — dispatches the GitHub Actions weekly-build workflow.
// Vercel cron 配在 vercel.json，每周一北京 10:00 (UTC 02:00) 触发；
// 真实 pipeline 跑在 GH Actions runner (.github/workflows/weekly.yml)。

export default async function handler(req, res) {
  if (process.env.CRON_SECRET) {
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }

  const ghPat = process.env.GH_PAT;
  if (!ghPat) {
    return res.status(500).json({ error: "GH_PAT not configured in Vercel env" });
  }

  const r = await fetch("https://api.github.com/repos/Freza00/us-housing-daily/dispatches", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ghPat}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "news-agent-vercel-cron",
    },
    body: JSON.stringify({ event_type: "weekly-build" }),
  });

  if (!r.ok) {
    const errText = await r.text();
    console.error(`GH dispatch failed: ${r.status} ${errText.slice(0, 300)}`);
    return res.status(502).json({ error: "GH dispatch failed", status: r.status, detail: errText.slice(0, 300) });
  }

  return res.status(200).json({ ok: true, dispatched_at: new Date().toISOString() });
}
```

- [ ] **Step 2: Create trigger-monthly.js (same shape, event_type=monthly-build)**

Identical to trigger-weekly.js except line 28: `body: JSON.stringify({ event_type: "monthly-build" })` and the leading comment swaps "weekly" → "monthly" / "10:00" → "10:30" / "02:00" → "02:30" / workflow filename → "monthly.yml".

- [ ] **Step 3: Commit**

```bash
git add api/trigger-weekly.js api/trigger-monthly.js
git commit -m "feat(api): Vercel Cron endpoints for weekly + monthly GH dispatch"
```

---

## Task 8: GitHub Actions workflows

**Files:**
- Create: `.github/workflows/weekly.yml`
- Create: `.github/workflows/monthly.yml`

- [ ] **Step 1: Create weekly.yml**

```yaml
name: Weekly Digest Build

# 每周一北京 10:00 (UTC 02:00) 是发布主时间点。三条独立路径同时兜底：
#   1. GH schedule '0 2 * * 1'    主时间点
#   2. Vercel Cron → repository_dispatch  同一时刻并发 (见 vercel.json)
#   3. GH schedule 3 次小时级 retry
# 任何一路 commit 了 data/weekly/<period_start>.json 之后，剩余 fire dedupe no-op。
on:
  schedule:
    - cron: '0 2 * * 1'       # 北京 10:00
    - cron: '30 3,4,5 * * 1'  # 北京 11:30 / 12:30 / 13:30 — retry trio
  workflow_dispatch: {}
  repository_dispatch:
    types: [weekly-build]
  push:
    branches: [main]
    paths:
      - 'scripts/build-weekly.mjs'
      - 'scripts/lib/digest-core.mjs'
      - 'scripts/lib/dates.mjs'
      - '.github/workflows/weekly.yml'

permissions:
  contents: write

concurrency:
  group: weekly-build
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - name: Compute ET period_start (this Monday is publish day; period_start = ET Mon of prior week)
        id: period
        run: |
          # Beijing today
          TODAY_BJ=$(TZ=Asia/Shanghai date +%Y-%m-%d)
          echo "today_bj=${TODAY_BJ}" >> "$GITHUB_OUTPUT"
          # period_start = ET Mon of the week we're summarizing. Use node helper to compute.
          PERIOD_START=$(node -e "
            import('./scripts/lib/dates.mjs').then(m => {
              console.log(m.etWeekBounds(new Date()).periodStart);
            });
          ")
          echo "period_start=${PERIOD_START}" >> "$GITHUB_OUTPUT"
          if [ -f "data/weekly/${PERIOD_START}.json" ]; then
            echo "already_built=true" >> "$GITHUB_OUTPUT"
            echo "::notice title=Skipped::data/weekly/${PERIOD_START}.json 已存在，跳过 pipeline"
          else
            echo "already_built=false" >> "$GITHUB_OUTPUT"
            echo "::notice title=Building::data/weekly/${PERIOD_START}.json 不存在，跑 pipeline"
          fi

      - uses: actions/setup-node@v5
        if: steps.period.outputs.already_built == 'false'
        with:
          node-version: '20'

      - name: Run weekly pipeline
        if: steps.period.outputs.already_built == 'false'
        env:
          LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
          LLM_ENDPOINT: ${{ secrets.LLM_ENDPOINT }}
          LLM_MODEL: ${{ secrets.LLM_MODEL }}
        run: node scripts/build-weekly.mjs

      - name: Commit
        if: steps.period.outputs.already_built == 'false'
        env:
          TODAY_BJ: ${{ steps.period.outputs.today_bj }}
          PERIOD_START: ${{ steps.period.outputs.period_start }}
        run: |
          git config user.name "Freza00"
          git config user.email "Freza00@users.noreply.github.com"
          git add data/weekly/
          if git diff --cached --quiet; then
            echo "no changes to commit"
          else
            git commit -m "chore: weekly digest for ${PERIOD_START} (built ${TODAY_BJ})"
            git push
          fi
```

- [ ] **Step 2: Create monthly.yml**

Same structure as weekly.yml with these differences:
- `name: Monthly Digest Build`
- cron: `'30 2 * * 1'` primary + `'0 4,5,6 * * 1'` retry
- `repository_dispatch.types: [monthly-build]`
- `paths:` swap `build-weekly.mjs` → `build-monthly.mjs`, swap `weekly.yml` → `monthly.yml`
- `concurrency.group: monthly-build`
- Period-computation node helper:

```bash
PERIOD_LABEL=$(node -e "
  import('./scripts/lib/dates.mjs').then(m => {
    console.log(m.etMonthBounds(new Date()).label);
  });
")
echo "period_label=${PERIOD_LABEL}" >> "$GITHUB_OUTPUT"
if [ -f \"data/monthly/${PERIOD_LABEL}.json\" ]; then ...
```

- Pipeline step: `run: node scripts/build-monthly.mjs` (script self-gates, so no extra date check needed in YAML).
- Commit step: `git add data/monthly/` + message `"chore: monthly digest for ${PERIOD_LABEL} (built ${TODAY_BJ})"`.

Write the full file by analogy. If the self-gate triggers (non-first-Monday), the script exits 0 with no file change, the commit step finds nothing staged, and the workflow ends cleanly — no special-casing required.

- [ ] **Step 3: Validate YAML syntax locally**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/weekly.yml')); yaml.safe_load(open('.github/workflows/monthly.yml')); print('OK')"
```

Expected: `OK`.

- [ ] **Step 4: Commit (do NOT enable Vercel cron yet — that's Task 10)**

```bash
git add .github/workflows/weekly.yml .github/workflows/monthly.yml
git commit -m "ci: weekly + monthly digest workflows (GH Actions only; Vercel cron in Task 10)"
```

---

## Task 9: Frontend — tab nav, themes block, window banner

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/style.css`

No automated tests — verify via `npm run preview`.

- [ ] **Step 1: Add tab nav + theme/banner placeholders to index.html**

After `</header>` (~line 169) and before `<nav class="datestrip" ...>`, insert:

```html
  <nav class="digest-tabs" id="digestTabs" role="tablist" aria-label="Digest mode">
    <button data-tab="daily" class="tab active" role="tab" aria-selected="true">日报</button>
    <button data-tab="weekly" class="tab" role="tab" aria-selected="false">周报</button>
    <button data-tab="monthly" class="tab" role="tab" aria-selected="false">月报</button>
  </nav>

  <div id="windowBanner" class="window-banner" hidden></div>
  <section id="themesBlock" class="themes-block" hidden>
    <h2 class="themes-title">本期主线</h2>
    <ul class="themes-list"></ul>
  </section>
```

- [ ] **Step 2: Add CSS to style.css**

Append to `public/style.css`:

```css
/* Digest tabs */
.digest-tabs { display: flex; gap: 4px; padding: 8px 16px; border-bottom: 1px solid var(--border, #e5e7eb); }
.digest-tabs .tab {
  background: transparent; border: 1px solid transparent;
  padding: 6px 14px; border-radius: 6px 6px 0 0;
  cursor: pointer; font-size: 14px; color: var(--text-muted, #6b7280);
}
.digest-tabs .tab:hover { background: var(--bg-hover, #f3f4f6); color: var(--text, #111827); }
.digest-tabs .tab.active {
  color: var(--text, #111827);
  border-color: var(--border, #e5e7eb);
  border-bottom-color: var(--bg, #fff);
  background: var(--bg, #fff); font-weight: 600;
}

/* Adaptive window banner */
.window-banner {
  margin: 8px 16px; padding: 8px 12px;
  background: #fffbeb; border: 1px solid #fde68a; border-radius: 4px;
  font-size: 13px; color: #78350f;
}

/* Themes block */
.themes-block {
  margin: 12px 16px; padding: 12px 16px;
  background: #f9fafb; border-left: 3px solid #2563eb;
}
.themes-block .themes-title { margin: 0 0 8px 0; font-size: 14px; font-weight: 600; color: #1f2937; }
.themes-block .themes-list { margin: 0; padding-left: 20px; }
.themes-block .themes-list li { margin: 4px 0; font-size: 14px; line-height: 1.5; color: #374151; }
```

- [ ] **Step 3: Wire tabs in app.js**

Near the top of `public/app.js`, after the existing `const $ = ...` block, add:

```js
const digestTabs = $('digestTabs');
const windowBanner = $('windowBanner');
const themesBlock = $('themesBlock');

let currentMode = 'daily';

function digestDataUrl(mode) {
  if (mode === 'weekly')  return '/data/weekly/latest.json';
  if (mode === 'monthly') return '/data/monthly/latest.json';
  return '/data/latest.json';
}

async function setDigestMode(mode) {
  if (!['daily','weekly','monthly'].includes(mode)) mode = 'daily';
  currentMode = mode;
  for (const btn of digestTabs.querySelectorAll('.tab')) {
    const active = btn.dataset.tab === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  }
  const hash = mode === 'daily' ? '' : `#${mode}`;
  if (location.hash !== hash) history.replaceState(null, '', location.pathname + hash);
  await loadAndRender(digestDataUrl(mode));
}

digestTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (btn) setDigestMode(btn.dataset.tab);
});

function initialMode() {
  const h = (location.hash || '').replace('#', '');
  return ['weekly','monthly'].includes(h) ? h : 'daily';
}
```

- [ ] **Step 4: Refactor loadAndRender to accept a URL, render banner + themes**

Find the existing function that fetches `/data/latest.json` and renders. Refactor its signature to `async function loadAndRender(url) { ... }`.

Inside that function, after `data` is parsed but before items render, add:

```js
  // Adaptive-window banner — daily only, only when window > 24h
  if (currentMode === 'daily' && data._diagnostics?.window_hours > 24) {
    const h = data._diagnostics.window_hours;
    const extCount = (data.items || []).filter(it => it.extended_window).length;
    windowBanner.textContent = `周末/假日窗口已自动扩展到 ${h}h。本期含 ${extCount} 条 24h 外稿件。`;
    windowBanner.hidden = false;
  } else {
    windowBanner.hidden = true;
  }

  // Themes block — weekly / monthly only
  const ul = themesBlock.querySelector('.themes-list');
  while (ul.firstChild) ul.removeChild(ul.firstChild);  // safe clear, no innerHTML
  if ((currentMode === 'weekly' || currentMode === 'monthly')
      && Array.isArray(data.themes) && data.themes.length > 0) {
    for (const t of data.themes) {
      const li = document.createElement('li');
      li.textContent = t.title;  // textContent — safe from XSS even if LLM emits HTML
      ul.appendChild(li);
    }
    themesBlock.querySelector('.themes-title').textContent =
      currentMode === 'weekly' ? '本周主线' : '本月主线';
    themesBlock.hidden = false;
  } else {
    themesBlock.hidden = true;
  }
```

- [ ] **Step 5: Handle initial-data SSR (daily only)**

Find the existing initial-data handling in app.js (search `initial-data`). It currently does something like:

```js
const inline = document.getElementById('initial-data');
const data = inline ? JSON.parse(inline.textContent) : await fetch('/data/latest.json').then(r => r.json());
render(data);
```

Replace with:

```js
const inline = document.getElementById('initial-data');
if (initialMode() === 'daily' && inline) {
  currentMode = 'daily';
  for (const btn of digestTabs.querySelectorAll('.tab')) {
    btn.classList.toggle('active', btn.dataset.tab === 'daily');
  }
  // Render directly from SSR JSON, then run the banner/themes branch from Step 4
  // by calling the same render path. Simplest: hand the parsed data to loadAndRender's
  // post-fetch logic. If that's not extractable, just call setDigestMode('daily')
  // (accepts a small re-fetch flash but cleaner code).
  setDigestMode('daily');
} else {
  setDigestMode(initialMode());
}

window.addEventListener('hashchange', () => setDigestMode(initialMode()));
```

- [ ] **Step 6: Visual test**

Ensure data exists:

```
ls data/weekly/latest.json data/monthly/latest.json
```

Launch preview:

```
npm run preview
```

Open http://localhost:8080. Verify:
- Three tabs visible: 日报 / 周报 / 月报
- Daily tab renders existing content; window banner appears when today's `window_hours > 24`
- Weekly tab loads `/data/weekly/latest.json`, themes block visible (if themes generated), items render
- Monthly tab: themes titled "本月主线"
- URL hash updates to `#weekly` / `#monthly`; reload at hash lands on correct tab

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/app.js public/style.css
git commit -m "feat(ui): tab nav (日报/周报/月报) + themes block + adaptive window banner"
```

---

## Task 10: Wire Vercel Cron (LAST — only after code is live in main)

**Files:**
- Modify: `vercel.json`

Intentionally last. Until cron entries land, GH Actions are the only triggers — and they're idempotent.

- [ ] **Step 1: Add cron entries**

Replace the `crons` array in `vercel.json` (keep all other fields):

```json
{
  "crons": [
    { "path": "/api/trigger-daily",   "schedule": "57 0 * * *" },
    { "path": "/api/trigger-weekly",  "schedule": "0 2 * * 1" },
    { "path": "/api/trigger-monthly", "schedule": "30 2 * * 1" }
  ]
}
```

- [ ] **Step 2: Verify JSON parses**

```bash
python3 -c "import json; json.load(open('vercel.json')); print('OK')"
```

- [ ] **Step 3: Commit + push**

```bash
git add vercel.json
git commit -m "ci: enable Vercel Cron for weekly + monthly digest dispatch"
git push origin main
```

After push, Vercel auto-deploys. Next scheduled fires (Mon 02:00 UTC weekly / Mon 02:30 UTC monthly) dispatch via Vercel Cron → trigger-{weekly,monthly}.js → GH `repository_dispatch` → workflow runs.

---

## Self-review

**Spec coverage:**
- ✅ Adaptive 24h→48h→72h window — Task 1
- ✅ Weekly digest (ET Mon–Sun, Beijing Mon 10:00) — Tasks 5, 7, 8, 10
- ✅ Monthly digest (calendar month, first-Mon self-gate) — Tasks 6, 7, 8, 10
- ✅ Frontend tabs + themes + banner — Task 9
- ✅ Shared `digest-core.mjs` + `dates.mjs` — Tasks 2, 3, 4
- ✅ Theme generation with fail-open — Task 4
- ✅ Output schema (`kind / publish_date / period_start / period_end / themes / items / _diagnostics`) — Tasks 5, 6
- ✅ `extended_window` semantic preserved post-adaptive — Task 1 Step 6
- ✅ Vercel Cron added last — Task 10
- ✅ DST-safe date math via Intl.DateTimeFormat — Task 2

**Placeholder scan:** No TBD/TODO. Every code block is complete. Test cases are concrete.

**Type consistency:**
- `loadDailyHistory` returns `{ items, loaded_dates, errors }` — consumed identically across orchestrators ✓
- `reRankWithQuota(items, sections, opts)` — same signature in tests + both builders ✓
- `generateThemes` returns `{ themes, error?, raw_preview? }` — consumed identically ✓
- `etWeekBounds` returns `{ periodStart, periodEnd }`; `etMonthBounds` returns `{ periodStart, periodEnd, label }` — disparity is intentional (monthly needs YYYY-MM label for filename) ✓
- `SECTIONS_DAILY` quotas sum to 20 (locked by test) ✓
- Output file naming: `data/weekly/<period_start>.json` and `data/monthly/<period_label>.json` — both keyed by ET period ✓

**Open risks (documented, not blocking):**
- `await import("./lib/digest-core.mjs")` in build.mjs Task 1 assumes the enclosing function is async. Verify before editing — if sync, hoist to a static top-of-file import.
- `callLLMShim` in build-weekly/monthly is a minimal duplicate of build.mjs's `callLLM`, sufficient for first ship. If theme calls hit the same proxy quirks already worked around in build.mjs (SSE streaming `268d6a3`, body slice `886c837`), extract `callLLM` into `scripts/lib/llm.mjs` and import in both places — defer to a follow-up.

---

## Rollout & verification

After all tasks are merged to `main`:

1. **Wait for next daily cron** (Beijing 08:57). Verify `data/<today>.json._diagnostics.window_hours` and `pool_sizes` are present.
2. **Manually fire weekly** via GH Actions UI: `gh workflow run weekly.yml`. Verify `data/weekly/<last-Mon>.json` lands and `dates.json` updates.
3. **Manually fire monthly** with FORCE_RUN locally to validate end-to-end (the live workflow self-gates and will no-op on non-first-Mondays).
4. **Visual check site**: tabs work, themes render, banner shows on next holiday/weekend daily.
5. **First real Monday after merge** (= weekly, possibly monthly): watch GH Actions logs + Vercel Cron logs side-by-side; confirm dedupe (only one path actually commits per period).

