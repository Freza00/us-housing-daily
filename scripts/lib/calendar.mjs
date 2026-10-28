import { beijingDateStr, etMonthBounds, isFirstMondayOfMonth } from './dates.mjs';

const DAY = 86400000;
export function beijingWeekday(now) { return new Date(now.getTime() + 8 * 3600000).getUTCDay(); }
export function shouldRun(kind, now, { force = false } = {}) {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid publish time');
  const day = beijingWeekday(now);
  if (day === 0 || day === 6) return false;
  if (force) return true;
  const minutes = new Date(now.getTime() + 8 * 3600000).getUTCHours() * 60 + now.getUTCMinutes();
  if (kind === 'daily') return minutes >= 300;
  if (kind === 'weekly') return day === 1 && minutes >= 420;
  return isFirstMondayOfMonth(now) && minutes >= 870;
}

// Convert local ET midnight using the offset at that date; no fixed -04/-05 offset.
export function etMidnight(date) {
  const target = Date.parse(date + 'T00:00:00Z');
  let epoch = target;
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(epoch).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
    const displayed = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    epoch += target - displayed;
  }
  return epoch;
}

export function nextDate(date) { return new Date(Date.parse(date + 'T00:00:00Z') + DAY).toISOString().slice(0, 10); }
export function buildWindow(kind, now, watermark = null) {
  const date = beijingDateStr(now.getTime());
  if (kind === 'weekly') {
    const monday = new Date(Date.parse(date + 'T00:00:00Z') - ((beijingWeekday(now) + 6) % 7) * DAY).toISOString().slice(0,10);
    const upper = Date.parse(monday + 'T05:00:00+08:00'), lower = upper - 7 * DAY;
    if (upper > now.getTime()) throw new Error('Weekly cutoff has not arrived');
    const periodStart = beijingDateStr(lower), periodEnd = monday;
    return { lower, upper, hours: 168, timezone: 'Asia/Shanghai', periodStart, periodEnd, label: periodStart + ' 05:00 至 ' + periodEnd + ' 05:00（北京）' };
  }
  if (kind === 'monthly') {
    const period = etMonthBounds(now);
    const lower = etMidnight(period.periodStart), upper = etMidnight(nextDate(period.periodEnd));
    if (upper > now.getTime()) throw new Error('ET reporting period has not ended');
    return { lower, upper, hours: (upper - lower) / 3600000, ...period };
  }
  const upper = Date.parse(date + 'T05:00:00+08:00');
  if (upper > now.getTime()) throw new Error('Daily cutoff has not arrived');
  if (watermark !== null && (!Number.isFinite(watermark) || watermark > upper)) throw new Error('Invalid collection watermark');
  // Only the first run without durable history uses a bootstrap interval.
  const lower = watermark ?? upper - (beijingWeekday(now) === 1 ? 3 : 1) * DAY;
  return { lower, upper, hours: (upper - lower) / 3600000, date, timezone: 'Asia/Shanghai', lower_basis: watermark === null ? 'bootstrap_previous_workday' : 'collection_checkpoint' };
}

export function intersectingSnapshots(snapshots, window) {
  return snapshots.filter(s => s.window && s.window.lower < window.upper && s.window.upper > window.lower);
}

export function coverageGaps(snapshots, window) {
  const intervals = intersectingSnapshots(snapshots, window).filter(s => s.coverage_status === 'observed' && !(s.source_health || []).some(h => h.required && (h.status !== 'ok' || !h.coverage || h.coverage.lower > s.window.lower || h.coverage.upper < s.window.upper))).map(s => [Math.max(s.window.lower, window.lower), Math.min(s.window.upper, window.upper)]).sort((a, b) => a[0] - b[0]);
  const gaps = []; let cursor = window.lower;
  for (const [lower, upper] of intervals) { if (lower > cursor) gaps.push({ lower: cursor, upper: lower }); cursor = Math.max(cursor, upper); }
  if (cursor < window.upper) gaps.push({ lower: cursor, upper: window.upper });
  return gaps;
}
