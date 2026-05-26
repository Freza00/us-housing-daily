// US federal holiday calendar with stale-while-revalidate caching.
//
// Source: date.nager.at (free, no auth). We filter to Public + global = the
// 11 US federal holidays (drops state-only entries like Lincoln's Birthday).
//
// Failure model: this module MUST NOT throw. If the API call fails, we fall
// back to the on-disk cache. If there's no cache at all, we return [] and the
// caller silently skips holiday detection. Federal holiday dates don't move,
// so an arbitrarily old cache is still correct.

import fs from "node:fs";
import path from "node:path";

const API_URL = (year) => `https://date.nager.at/api/v3/PublicHolidays/${year}/US`;
const FETCH_TIMEOUT_MS = 5000;
const CACHE_REFRESH_AFTER_MS = 30 * 24 * 3600 * 1000;

function cachePath(stateDir, year) {
  return path.join(stateDir, `us-holidays-${year}.json`);
}

function readCache(stateDir, year) {
  const p = cachePath(stateDir, year);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

async function fetchHolidays(year) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(API_URL(year), { signal: controller.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = await r.json();
    return raw
      .filter(h => Array.isArray(h.types) && h.types.includes("Public") && h.global === true)
      .map(h => ({
        date: h.date,
        // nager uses British spelling; normalize for user-facing copy
        name: h.name === "Labour Day" ? "Labor Day" : h.name,
      }));
  } finally {
    clearTimeout(tid);
  }
}

/**
 * Returns [{date, name}, ...] for the given year. Network errors and cache
 * misses are absorbed silently — caller treats [] as "holiday detection off".
 */
export async function loadUsHolidays({ stateDir, year, log = () => {} }) {
  const cached = readCache(stateDir, year);
  const cacheAgeMs = cached?._fetched_at ? Date.now() - cached._fetched_at : Infinity;
  if (cached && cacheAgeMs < CACHE_REFRESH_AFTER_MS) {
    return cached.holidays || [];
  }
  try {
    const holidays = await fetchHolidays(year);
    const payload = { _fetched_at: Date.now(), _source: "date.nager.at", year, holidays };
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(cachePath(stateDir, year), JSON.stringify(payload, null, 2));
    log(`✅ US holidays ${year} refreshed (${holidays.length} entries)`);
    return holidays;
  } catch (err) {
    if (cached) {
      const days = Math.round(cacheAgeMs / (24 * 3600 * 1000));
      log(`⚠️  US holidays ${year} fetch failed (${err.message}) — falling back to cache (${days}d old)`);
      return cached.holidays || [];
    }
    log(`⚠️  US holidays ${year} fetch failed (${err.message}) and no cache — holiday banner disabled`);
    return [];
  }
}

function usEasternDateStr(ts) {
  // en-CA gives YYYY-MM-DD; America/New_York handles EST/EDT automatically
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(ts));
}

function addDaysIso(iso, n) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Snapshot of US holiday context relative to a given timestamp. Designed for
 * the BJ-09:00 cron: at that moment US/Eastern is still the prior US day,
 * and the 24h news window straddles today_us and yesterday_us. We expose all
 * three nearby days so the frontend can pick the most-impactful banner copy.
 */
export function usHolidayContext(nowMs, holidays) {
  const today = usEasternDateStr(nowMs);
  const yesterday = addDaysIso(today, -1);
  const tomorrow = addDaysIso(today, +1);
  const map = new Map((holidays || []).map(h => [h.date, h.name]));
  const dow = (iso) => new Date(iso + "T12:00:00Z").getUTCDay();
  return {
    today_us: today,
    today_us_holiday: map.get(today) || null,
    yesterday_us_holiday: map.get(yesterday) || null,
    tomorrow_us_holiday: map.get(tomorrow) || null,
    is_us_weekend: [0, 6].includes(dow(today)) || [0, 6].includes(dow(yesterday)),
    source: holidays?.length ? "date.nager.at" : "unavailable",
  };
}
