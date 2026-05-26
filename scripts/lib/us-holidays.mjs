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

function beijingDateStr(ts) {
  return new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function addDaysIso(iso, n) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dowUtc(iso) {
  return new Date(iso + "T12:00:00Z").getUTCDay();
}

function isUsBusinessDay(iso, holidaySet) {
  const dow = dowUtc(iso);
  if (dow === 0 || dow === 6) return false;
  return !holidaySet.has(iso);
}

/**
 * Find next BJ digest date that will summarize two full normal US business days.
 *
 * BJ-09:00 cron → ET 20:57 prior day → 24h news window straddles US D-1 (bulk)
 * and US D-2 (tail). A digest "fully recovers" when both of those US dates are
 * normal business days (no weekend, no federal holiday).
 *
 * Returns YYYY-MM-DD or null if not found within 14 days (sanity bound).
 */
function nextNormalBjDigestDate(currentBjDate, holidaySet) {
  let d = new Date(currentBjDate + "T12:00:00Z");
  for (let i = 1; i <= 14; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    const bjIso = d.toISOString().slice(0, 10);
    const us1 = addDaysIso(bjIso, -1);
    const us2 = addDaysIso(bjIso, -2);
    if (isUsBusinessDay(us1, holidaySet) && isUsBusinessDay(us2, holidaySet)) {
      return bjIso;
    }
  }
  return null;
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
  const holidaySet = new Set(map.keys());
  const isWeekend = [0, 6].includes(dowUtc(today)) || [0, 6].includes(dowUtc(yesterday));
  const hasHoliday = !!(map.get(today) || map.get(yesterday));
  // Only project recovery when we have a clear cause (holiday or weekend).
  // For random slow weekdays we have no basis to promise recovery.
  const recovery = (isWeekend || hasHoliday)
    ? nextNormalBjDigestDate(beijingDateStr(nowMs), holidaySet)
    : null;
  return {
    today_us: today,
    today_us_holiday: map.get(today) || null,
    yesterday_us_holiday: map.get(yesterday) || null,
    tomorrow_us_holiday: map.get(tomorrow) || null,
    is_us_weekend: isWeekend,
    expected_recovery_bj_date: recovery,
    source: holidays?.length ? "date.nager.at" : "unavailable",
  };
}
