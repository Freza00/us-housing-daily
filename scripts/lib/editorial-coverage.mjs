import { classify, SECTIONS } from './news-core.mjs';

export function coverageDates(date) {
  const cursor = new Date(date + 'T12:00:00Z'), dates = [];
  while (dates.length < 5) {
    if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return dates;
}

export function editorialCoverage({ candidates, decisions, selected, health, sources, tagConfig, date, history = [] }) {
  const byId = new Map(decisions.map(item => [item.id, item]));
  const assets = tagConfig?.dimensions?.asset?.tags || [];
  const assetIds = new Set(assets.map(tag => tag.id));
  const assetOf = item => (Array.isArray(item.tags) ? item.tags : []).find(tag => assetIds.has(tag));
  const qualified = item => item.keep && item.importance >= 3 && !item.duplicate_of;
  const rows = candidates.map(item => ({ ...item, ...byId.get(item.id), section: byId.get(item.id)?.section || classify(item) }));
  const checked = new Map(health.map(item => [item.id, item]));
  const sections = Object.fromEntries(SECTIONS.map(section => {
    const required = sources.filter(source => source.required_for_section === section.id);
    const failures = required.filter(source => {
      const state = checked.get(source.id);
      return !state || state.status !== 'ok' || state.unreadable_recent > 0 || (state.articles > 0 && state.undated === state.articles);
    }).map(source => ({ id: source.id, name: source.name, status: checked.get(source.id)?.status || 'unchecked' }));
    const observed = rows.filter(item => item.section === section.id), kept = selected.filter(item => item.section === section.id);
    const eligible = observed.filter(qualified);
    return [section.id, { candidates: observed.length, qualified: eligible.length, selected: kept.length,
      required_sources: required.length, source_failures: failures,
      status: kept.length ? 'selected' : failures.length ? 'source_gap' : eligible.length ? 'not_selected' : observed.length ? 'no_qualified' : 'no_candidates' }];
  }));
  const expected = coverageDates(date), previous = history.filter(issue => expected.includes(issue.date) && issue.date !== date);
  const observedDates = [...new Set([date, ...previous.map(issue => issue.date)])];
  const recent = [{ date, items: selected }, ...previous];
  return { sections, assets: assets.map(tag => ({ id: tag.id, label: tag.label_zh,
    candidates: rows.filter(item => assetOf(item) === tag.id).length,
    qualified: rows.filter(item => qualified(item) && assetOf(item) === tag.id).length,
    selected: selected.filter(item => assetOf(item) === tag.id).length,
    recent_selected: recent.reduce((count, issue) => count + issue.items.filter(item => assetOf(item) === tag.id).length, 0),
    last_selected_date: recent.filter(issue => issue.items.some(item => assetOf(item) === tag.id)).map(issue => issue.date).sort().at(-1) || null })),
    unclassified_selected: selected.filter(item => !assetOf(item)).length,
    history: { expected_dates: expected, observed_dates: observedDates.sort().reverse(), missing_dates: expected.filter(day => !observedDates.includes(day)) } };
}
