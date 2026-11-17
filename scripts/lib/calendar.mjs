import { beijingDateStr, etMonthBounds, isFirstWeekdayOfMonth } from './dates.mjs';

const DAY = 86400000;
export function beijingWeekday(now) { return new Date(now.getTime() + 8 * 3600000).getUTCDay(); }
export function shouldRun(kind, now, { force = false } = {}) {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid publish time');
  const day = beijingWeekday(now);
  if (day === 0 || day === 6) return false;
  if (force) return true;
  const minutes = new Date(now.getTime() + 8 * 3600000).getUTCHours() * 60 + now.getUTCMinutes();
  if (kind === 'daily') return minutes >= 300;
  if (kind === 'weekly') return day === 1 && minutes >= 840;
  return isFirstWeekdayOfMonth(now) && minutes >= 900;
}

export function publicationDeadline(kind, now) {
  const hour = {daily:'09',weekly:'15',monthly:'16'}[kind];
  if (!hour || !Number.isFinite(now.getTime())) throw new Error('Invalid publication deadline');
  return Date.parse(beijingDateStr(now.getTime()) + 'T' + hour + ':00:00+08:00');
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
    const periodStart = new Date(Date.parse(monday + 'T00:00:00Z') - 7 * DAY).toISOString().slice(0,10);
    const periodEnd = new Date(Date.parse(monday + 'T00:00:00Z') - DAY).toISOString().slice(0,10);
    const upper = etMidnight(monday), lower = etMidnight(periodStart);
    if (upper > now.getTime()) throw new Error('Weekly cutoff has not arrived');
    return { lower, upper, hours: (upper-lower)/3600000, timezone: 'America/New_York', periodStart, periodEnd, label: periodStart + ' 00:00 至 ' + monday + ' 00:00（美东）' };
  }
  if (kind === 'monthly') {
    const period = etMonthBounds(now);
    const lower = etMidnight(period.periodStart), upper = etMidnight(nextDate(period.periodEnd));
    if (upper > now.getTime()) throw new Error('ET reporting period has not ended');
    return { lower, upper, hours: (upper - lower) / 3600000, timezone: 'America/New_York', ...period };
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

export function withinRecoveryWindow(kind, now, window) {
  if (kind !== 'weekly' && kind !== 'monthly') return false;
  if (!Number.isFinite(now?.getTime?.()) || !window || !Number.isFinite(window.upper)) return false;
  const day = beijingWeekday(now);
  if (day === 0 || day === 6) return false;
  if (now.getTime() < window.upper) return false;
  const bjNow = new Date(now.getTime() + 8 * 3600000), minutes = bjNow.getUTCHours() * 60 + bjNow.getUTCMinutes();
  if (kind === 'weekly') {
    if (day === 1 && minutes < 840) return false;
    return now.getTime() <= window.upper + 48 * 3600000;
  }
  const [year, month, dom] = beijingDateStr(now.getTime()).split('-').map(Number);
  const wd1 = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const firstWeekday = wd1 === 6 ? 3 : wd1 === 0 ? 2 : 1;
  if (dom < firstWeekday || (dom === firstWeekday && minutes < 900)) return false;
  let workingDays = 0;
  for (let d = 1; d <= dom; d++) {
    const wd = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
    if (wd !== 0 && wd !== 6) workingDays++;
  }
  return workingDays <= 3;
}

export function canAttemptRecoverySchedule(kind, now) {
  if (kind !== 'weekly' && kind !== 'monthly') return false;
  if (!Number.isFinite(now?.getTime?.())) throw new Error('Invalid publish time');
  const day = beijingWeekday(now);
  if (day === 0 || day === 6) return false;
  const bjNow = new Date(now.getTime() + 8 * 3600000), minutes = bjNow.getUTCHours() * 60 + bjNow.getUTCMinutes();
  if (kind === 'weekly' && day === 1 && minutes < 840) return false;
  if (kind === 'monthly') {
    const [year, month, dom] = beijingDateStr(now.getTime()).split('-').map(Number);
    const wd1 = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const firstWeekday = wd1 === 6 ? 3 : wd1 === 0 ? 2 : 1;
    if (dom < firstWeekday || (dom === firstWeekday && minutes < 900)) return false;
  }
  return withinRecoveryWindow(kind, now, buildWindow(kind, now));
}

export function recoverableRevision({ kind, saved, snapshots = [], window, now }) {
  if (!withinRecoveryWindow(kind, now, window)) return null;
  if (!saved || saved.kind !== kind || !Array.isArray(saved.items) || !saved.items.length) return null;
  const period = kind === 'weekly' ? window.periodStart : window.label;
  const savedPeriod = kind === 'weekly' ? saved.period_start : saved.period_label;
  if (savedPeriod !== period || saved.window?.upper !== window.upper) return null;
  if (saved.edition?.revision !== 1) return null;
  if ((saved.coverage_status ?? saved.publication_status) !== 'degraded') return null;
  const archivedGaps = saved._diagnostics?.coverage_gaps;
  if (!Array.isArray(archivedGaps) || archivedGaps.length === 0) return null;
  if (coverageGaps(snapshots, window).length > 0) return null;
  return 2;
}
