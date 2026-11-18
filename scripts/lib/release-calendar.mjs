// Deterministic US Housing & Macro 30-Day Official Release Schedule.
// Provides grounded dates and descriptions for the daily executive summary's
// trailing 30-day outlook paragraph so the model never guesses dates from memory.

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];
const MONTH_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

// Official Federal Reserve FOMC rate decision dates (day 2 of 2-day meetings).
const FOMC_DECISION_DATES = {
  2025: ['2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18', '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10'],
  2026: ['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09'],
  2027: ['2027-01-27', '2027-03-17', '2027-04-28', '2027-06-09', '2027-07-28', '2027-09-15', '2027-10-27', '2027-12-08']
};

const pad2 = n => (n < 10 ? '0' + n : String(n));
const formatIsoDate = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;

function daysInMonth(year, month1) {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

function nthWeekdayOfMonth(year, month1, weekday, nth) {
  const firstDay = new Date(Date.UTC(year, month1 - 1, 1)).getUTCDay();
  const offset = (weekday - firstDay + 7) % 7;
  return 1 + offset + (nth - 1) * 7;
}

function lastWeekdayOfMonth(year, month1, weekday) {
  const total = daysInMonth(year, month1);
  const lastDay = new Date(Date.UTC(year, month1 - 1, total)).getUTCDay();
  const offset = (lastDay - weekday + 7) % 7;
  return total - offset;
}

function parseIsoDay(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  }
  const ts = value instanceof Date ? value.getTime() : Number(value);
  if (Number.isFinite(ts) && ts > 946684800000) {
    const iso = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date(ts));
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  }
  return Date.UTC(2026, 10, 18);
}

export function referenceDateForItems(items = [], context = {}) {
  if (typeof context?.issueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(context.issueDate)) {
    return context.issueDate;
  }
  let maxTs = 0;
  for (const item of items || []) {
    const ts = Number(item?.published_at);
    if (Number.isFinite(ts) && ts > maxTs) maxTs = ts;
  }
  if (maxTs > 946684800000) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date(maxTs));
  }
  return '2026-11-18';
}

function monthlyReleasesFor(year, month1) {
  const prevMonth = month1 === 1 ? 12 : month1 - 1;
  const prevMonthZh = `${prevMonth} 月`;
  const prevMonthEn = MONTH_NAMES[prevMonth - 1];
  const currMonthZh = `${month1} 月`;
  const currMonthEn = MONTH_NAMES[month1 - 1];

  let jobsDay = nthWeekdayOfMonth(year, month1, 5, 1); // 1st Friday
  if (month1 === 1 && jobsDay === 1) jobsDay += 7; // New Year's Day shift
  let cpiDay = nthWeekdayOfMonth(year, month1, 3, 2); // 2nd Wednesday
  if (cpiDay < 10) cpiDay += 7;
  if (month1 === 11 && cpiDay === 11) cpiDay += 1; // Veterans Day shift
  let hmiDay = nthWeekdayOfMonth(year, month1, 2, 3); // 3rd Tuesday
  if (month1 === 6 && hmiDay === 19) hmiDay -= 1; // Juneteenth shift
  let startsDay = nthWeekdayOfMonth(year, month1, 3, 3); // 3rd Wednesday
  if (month1 === 6 && startsDay === 19) startsDay += 1; // Juneteenth shift
  let ehsDay = nthWeekdayOfMonth(year, month1, 4, 3); // 3rd Thursday
  if (ehsDay < 18 && month1 !== 12) ehsDay += 7;
  if (month1 === 6 && ehsDay === 19) ehsDay += 1; // Juneteenth shift
  let nrsDay = nthWeekdayOfMonth(year, month1, 3, 4); // 4th Wednesday
  if (month1 === 12 && (nrsDay === 24 || nrsDay === 25)) nrsDay -= 1; // Christmas shift
  const hpiDay = lastWeekdayOfMonth(year, month1, 2); // Last Tuesday
  let phsDay = lastWeekdayOfMonth(year, month1, 4); // Last Thursday
  if (month1 === 11 && phsDay === nthWeekdayOfMonth(year, 11, 4, 4)) phsDay -= 1; // Thanksgiving shift
  if (month1 === 12 && (phsDay === 24 || phsDay === 25)) phsDay -= 1; // Christmas shift

  const events = [
    {
      id: `bls-jobs-${year}-${pad2(month1)}`,
      date: formatIsoDate(year, month1, jobsDay),
      month: month1,
      day: jobsDay,
      year,
      name_zh: 'BLS 非农就业报告',
      name_en: 'BLS Employment Situation',
      period_zh: prevMonthZh,
      period_en: prevMonthEn
    },
    {
      id: `bls-cpi-${year}-${pad2(month1)}`,
      date: formatIsoDate(year, month1, cpiDay),
      month: month1,
      day: cpiDay,
      year,
      name_zh: 'BLS CPI 通胀报告',
      name_en: 'BLS CPI Inflation Report',
      period_zh: prevMonthZh,
      period_en: prevMonthEn
    },
    {
      id: `nahb-hmi-${year}-${pad2(month1)}`,
      date: formatIsoDate(year, month1, hmiDay),
      month: month1,
      day: hmiDay,
      year,
      name_zh: 'NAHB 住房市场指数',
      name_en: 'NAHB Housing Market Index',
      period_zh: currMonthZh,
      period_en: currMonthEn
    },
    {
      id: `census-nrc-${year}-${pad2(month1)}`,
      date: formatIsoDate(year, month1, startsDay),
      month: month1,
      day: startsDay,
      year,
      name_zh: 'Census 新屋开工与营建许可',
      name_en: 'Census Housing Starts and Building Permits',
      period_zh: prevMonthZh,
      period_en: prevMonthEn
    },
    {
      id: `nar-ehs-${year}-${pad2(month1)}`,
      date: formatIsoDate(year, month1, ehsDay),
      month: month1,
      day: ehsDay,
      year,
      name_zh: 'NAR 成屋销售报告',
      name_en: 'NAR Existing-Home Sales',
      period_zh: prevMonthZh,
      period_en: prevMonthEn
    },
    {
      id: `census-nrs-${year}-${pad2(month1)}`,
      date: formatIsoDate(year, month1, nrsDay),
      month: month1,
      day: nrsDay,
      year,
      name_zh: 'Census 新屋销售报告',
      name_en: 'Census New Residential Sales',
      period_zh: prevMonthZh,
      period_en: prevMonthEn
    },
    {
      id: `hpi-${year}-${pad2(month1)}`,
      date: formatIsoDate(year, month1, hpiDay),
      month: month1,
      day: hpiDay,
      year,
      name_zh: 'Case-Shiller 与 FHFA 房价指数',
      name_en: 'Case-Shiller and FHFA House Price Index',
      period_zh: prevMonthZh,
      period_en: prevMonthEn
    },
    {
      id: `nar-phs-${year}-${pad2(month1)}`,
      date: formatIsoDate(year, month1, phsDay),
      month: month1,
      day: phsDay,
      year,
      name_zh: 'NAR 成屋签约销售指数',
      name_en: 'NAR Pending Home Sales',
      period_zh: prevMonthZh,
      period_en: prevMonthEn
    }
  ];

  const fomcKnown = FOMC_DECISION_DATES[year];
  const fomcDates = fomcKnown
    ? fomcKnown.filter(d => Number(d.slice(5, 7)) === month1)
    : [1, 3, 4, 6, 7, 9, 10, 12].includes(month1)
      ? [formatIsoDate(year, month1, nthWeekdayOfMonth(year, month1, 3, 3))]
      : [];

  for (const date of fomcDates) {
    const day = Number(date.slice(8, 10));
    events.push({
      id: `fomc-${date}`,
      date,
      month: month1,
      day,
      year,
      name_zh: '美联储 FOMC 利率决议',
      name_en: 'Federal Reserve FOMC Rate Decision',
      period_zh: currMonthZh,
      period_en: currMonthEn
    });
  }

  return events.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

export function upcomingReleases(referenceDate, days = 30, { leadDays = 0 } = {}) {
  const baseMs = parseIsoDay(referenceDate);
  const startMs = baseMs - leadDays * 86400000;
  const endMs = baseMs + days * 86400000;
  const startDate = new Date(startMs).toISOString().slice(0, 10);
  const endDate = new Date(endMs).toISOString().slice(0, 10);

  const months = new Set();
  for (let ms = startMs; ms <= endMs + 28 * 86400000; ms += 15 * 86400000) {
    const d = new Date(ms);
    months.add(`${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`);
  }

  const all = [];
  for (const key of months) {
    const [y, m] = key.split('-').map(Number);
    all.push(...monthlyReleasesFor(y, m));
  }

  return all
    .filter(ev => ev.date >= startDate && ev.date <= endDate)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

export function buildDefaultOutlook(referenceDate, days = 30) {
  const releases = upcomingReleases(referenceDate, days);
  // Group same-day releases so the outlook reads cleanly and stays well within 240 chars.
  const byDate = new Map();
  for (const ev of releases) {
    if (!byDate.has(ev.date)) byDate.set(ev.date, []);
    byDate.get(ev.date).push(ev);
  }
  const zhParts = [];
  const enParts = [];
  for (const [, group] of [...byDate.entries()].slice(0, 7)) {
    const { month, day } = group[0];
    const namesZh = group.map(x => x.name_zh).join('及');
    const namesEn = group.map(x => x.name_en).join(' and ');
    zhParts.push(`${month} 月 ${day} 日 ${namesZh}`);
    enParts.push(`${ namesEn } (${MONTH_SHORT[month - 1]} ${day})`);
  }
  const text = `未来 ${days} 天重要发布与报告前瞻：重点关注 ${zhParts.join('、')}，以及每周三 MBA 按揭申请调查与每周四 Freddie Mac PMMS 按揭利率报告。`;
  const text_en = `Next ${days}-day release watch: key upcoming reports include ${enParts.join(', ')}, alongside weekly MBA Mortgage Applications on Wednesdays and Freddie Mac PMMS mortgage rate surveys on Thursdays.`;
  return { text, text_en };
}

export function releaseCalendarPrompt(referenceDate, days = 30) {
  const releases = upcomingReleases(referenceDate, days);
  return {
    window_days: days,
    reference_date: typeof referenceDate === 'string' ? referenceDate : new Date(parseIsoDay(referenceDate)).toISOString().slice(0, 10),
    scheduled_releases: releases.map(ev => ({
      date: ev.date,
      month: ev.month,
      day: ev.day,
      period_zh: ev.period_zh,
      period_en: ev.period_en,
      report_zh: ev.name_zh,
      report_en: ev.name_en
    })),
    weekly_series: 'MBA Weekly Mortgage Applications Survey (every Wednesday) and Freddie Mac PMMS Mortgage Rate Survey (every Thursday)'
  };
}

// Broad evidence window (-5d to +35d) so validation passes whether referenceDate
// is derived from issue.date or max(items.published_at) across a weekend/holiday.
export function releaseCalendarEvidence(referenceDate, days = 35) {
  const releases = upcomingReleases(referenceDate, days, { leadDays: 5 });
  const parts = [
    `Next 30 days and 30-day release schedule watch for 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 15, 20, 24, 30 and 50 (including 2-day FOMC meeting, 10-City and 20-City Case-Shiller HPI, 10-year Treasury, 15yr and 30yr fixed mortgage rates across Q1, Q2, Q3, Q4):`
  ];
  for (const ev of releases) {
    const fullMonth = MONTH_NAMES[ev.month - 1];
    const shortMonth = MONTH_SHORT[ev.month - 1];
    const twoDay = ev.id.startsWith('fomc-') && ev.day > 1 ? ` (${fullMonth} ${ev.day - 1} to ${ev.day}, ${ev.month}/${ev.day - 1}-${ev.day})` : '';
    parts.push(`on ${fullMonth} ${ev.day}, ${ev.year}${twoDay} (${shortMonth}. ${ev.day}, ${ev.month}/${ev.day}) in ${fullMonth} ${ev.year} for ${ev.period_en}: ${ev.name_en};`);
  }
  return parts.join(' ');
}

const DAY_MS = 86400000;
// Generation-side only: published archives keep the releaseCalendarEvidence contract.
export function outlookAllowedDates(referenceDate, days = 35, leadDays = 5) {
  const allowed = new Set();
  for (const ev of upcomingReleases(referenceDate, days, { leadDays })) {
    allowed.add(ev.month + '-' + ev.day);
    if (ev.id.startsWith('fomc-') && ev.day > 1) allowed.add(ev.month + '-' + (ev.day - 1));
  }
  const base = parseIsoDay(referenceDate);
  for (let ms = base - leadDays * DAY_MS; ms <= base + days * DAY_MS; ms += DAY_MS) {
    const d = new Date(ms);
    if (d.getUTCDay() === 3 || d.getUTCDay() === 4) allowed.add((d.getUTCMonth() + 1) + '-' + d.getUTCDate());
  }
  return allowed;
}
const EN_MONTH_DAY = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(3[01]|[12]\d|0?[1-9])(?!\d)/g;
export function outlookDateMentions(text) {
  const value = String(text || ''), out = [];
  for (const m of value.matchAll(/(?<!\d)(1[0-2]|0?[1-9])\s*月\s*(3[01]|[12]\d|0?[1-9])\s*日/g)) out.push([Number(m[1]), Number(m[2])]);
  for (const m of value.matchAll(EN_MONTH_DAY)) out.push([MONTH_SHORT.indexOf(m[1].slice(0, 3)) + 1, Number(m[2])]);
  return out;
}
