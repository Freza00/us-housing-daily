// Date math for digest period boundaries. All ET-aware via Intl.DateTimeFormat
// (America/New_York), no fixed offsets — DST is handled correctly.

const ET_TZ = "America/New_York";
const BJ_OFFSET_MS = 8 * 3600 * 1000;

// Convert epoch ms → "YYYY-MM-DD" in ET.
function etDateStr(ms) {
  // en-CA's date formatter natively emits YYYY-MM-DD.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: ET_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(new Date(ms));
}

// Convert epoch ms → "YYYY-MM-DD" in Beijing.
export function beijingDateStr(ms) {
  const d = new Date(ms + BJ_OFFSET_MS);
  return d.toISOString().slice(0, 10);
}

// ET weekday for an epoch ms (0=Sun, 1=Mon, ..., 6=Sat).
function etWeekday(ms) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: ET_TZ, weekday: "short" });
  const wk = fmt.format(new Date(ms));
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wk];
}

// Add N days to a "YYYY-MM-DD" string (UTC midnight semantics — safe for date arithmetic).
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
  const todayEt = etDateStr(ms);
  const wd = etWeekday(ms);
  // Days back to the most recent COMPLETED Sunday.
  // If ET today is Sun → period_end = today; otherwise = previous Sun.
  const daysBackToSun = wd === 0 ? 0 : wd;
  const periodEnd = addDays(todayEt, -daysBackToSun);
  const periodStart = addDays(periodEnd, -6);
  return { periodStart, periodEnd };
}

// For a publish moment, return the PRIOR calendar month in ET.
// We use the Beijing date (not ET) to determine which month to look back from,
// because the publication calendar is in Beijing (e.g. Beijing 2026-06-01 = ET 2026-05-31;
// the digest should cover May, not April).
export function etMonthBounds(publishMoment) {
  const todayBj = beijingDateStr(publishMoment.getTime());
  const [y, m] = todayBj.split("-").map(Number);
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  const periodStart = `${prevY}-${String(prevM).padStart(2, "0")}-01`;
  // Last day of prevM = day 0 of prevM+1 in UTC arithmetic.
  const lastDay = new Date(Date.UTC(prevY, prevM, 0)).getUTCDate();
  const periodEnd = `${prevY}-${String(prevM).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { periodStart, periodEnd, label: `${prevY}-${String(prevM).padStart(2, "0")}` };
}

// Working day means Monday–Friday in Beijing; no holiday calendar is applied.
export function isFirstWeekdayOfMonth(now) {
  const date = beijingDateStr(now.getTime()), [year, month] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const first = weekday === 6 ? 3 : weekday === 0 ? 2 : 1;
  return Number(date.slice(8)) === first;
}

// Given an ET range [periodStart, periodEnd] (inclusive), return the list of
// Beijing data/<date>.json filenames (without extension) that could plausibly
// contain items in that ET range. Daily cutoff is ~08:57 Beijing (≈ 20:57 ET
// prior day in EDT). Items from ET day D appear in Beijing file D or D+1; we
// add one Beijing day after periodEnd as a buffer.
export function beijingDatesCoveringEtRange(periodStart, periodEnd) {
  const out = [];
  let d = periodStart;
  const last = addDays(periodEnd, 1);
  while (d <= last) {
    out.push(d);
    d = addDays(d, 1);
  }
  return out;
}
