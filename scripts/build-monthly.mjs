// Monthly digest builder. Same algorithm as build-weekly.mjs but covers a calendar
// month (ET). Self-gates on first Monday of the Beijing month to avoid needing
// complex "first Mon of month" cron syntax — schedule every Monday and exit early
// on the others. FORCE_RUN=1 bypasses the gate (tests + manual backfill).
//
// Trigger: GH Actions Mon 02:30 UTC + Vercel Cron.
// Env: PUBLISH_NOW, FORCE_RUN, LLM_SKIP, LLM_API_KEY / LLM_ENDPOINT / LLM_MODEL

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
const OUT_DIR = process.env.DIGEST_OUT_DIR || path.join(DATA_DIR, "monthly");

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

  // Self-gate: only run on first Monday of Beijing month, unless FORCE_RUN
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
    sections: SECTIONS_DAILY,  // exposed so the frontend renders section-grouped (not flat)
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
  log(`wrote ${label}.json + latest.json`);

  const datesFile = path.join(OUT_DIR, "dates.json");
  let datesList = [];
  if (fs.existsSync(datesFile)) {
    try { datesList = JSON.parse(fs.readFileSync(datesFile, "utf8")); } catch {}
  }
  if (!datesList.includes(label)) {
    datesList.push(label);
    datesList.sort();
    fs.writeFileSync(datesFile, JSON.stringify(datesList, null, 2));
    log(`updated dates.json (${datesList.length})`);
  }
}

main().catch(e => {
  console.error(`[monthly] FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
