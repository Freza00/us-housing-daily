// Weekly digest builder. Re-ranks items from the past ET week's daily JSON files,
// applies daily SECTIONS quota (5/4/3/5/3 = 20), and optionally generates a
// "本周主线" theme summary via a single LLM call.
//
// Trigger: GH Actions Mon 02:00 UTC + Vercel Cron.
// Env:
//   PUBLISH_NOW   — ISO timestamp override (for tests / backfill)
//   LLM_SKIP      — skip the themes LLM call
//   LLM_API_KEY / LLM_ENDPOINT / LLM_MODEL — required unless LLM_SKIP

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

  // Filter to ET period (with ±1d buffer for DST safety; daily upstream gates by 24h).
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
  log(`wrote ${periodStart}.json + latest.json`);

  const datesFile = path.join(OUT_DIR, "dates.json");
  let datesList = [];
  if (fs.existsSync(datesFile)) {
    try { datesList = JSON.parse(fs.readFileSync(datesFile, "utf8")); } catch {}
  }
  if (!datesList.includes(periodStart)) {
    datesList.push(periodStart);
    datesList.sort();
    fs.writeFileSync(datesFile, JSON.stringify(datesList, null, 2));
    log(`updated dates.json (${datesList.length})`);
  }
}

main().catch(e => {
  console.error(`[weekly] FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
