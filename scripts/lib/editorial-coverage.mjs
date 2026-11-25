import { classify, SECTIONS } from './news-core.mjs';

const allUndated = row => row.articles > 0 && row.undated === row.articles;

export function requiredSourceProblem(row, { section = false } = {}) {
  return !row || row.status !== 'ok' || allUndated(row) || row.mode === 'discovery_only' || row.route_kind === 'aggregator'
    || (section && row.unreadable_recent > 0);
}

export function sourceHealth(row, source = {}, funnel, now = row.checked_at) {
  const reasons = new Set();
  const usedAlternate = row.used_alternate ?? (row.status === 'ok' && row.attempted_urls?.length > 1);
  if (usedAlternate) reasons.add('used_alternate');
  if (row.route_kind === 'aggregator') reasons.add(usedAlternate ? 'aggregator_fallback' : 'aggregator');
  if (row.primary_error?.code) reasons.add(row.primary_error.code);
  if (allUndated(row)) reasons.add('undated_all');
  if (row.mode === 'discovery_only') reasons.add('discovery_only');
  if (row.mode === 'restricted' || row.access_limited > 0) reasons.add('access_limited');
  if (row.mode !== 'discovery_only' && (row.recent_insufficient > 0 || funnel?.evidence_insufficient > 0)) reasons.add('recent_insufficient');
  const highFrequency = source.frequency === 'high' || (source.frequency == null && source.id && !source.is_research
    && (!source.type || source.type === 'rss') && row.mode !== 'discovery_only');
  const staleDays = source.stale_after_days ?? (highFrequency ? 60 : null);
  if (staleDays > 0 && row.latest_published_at > 0 && now - row.latest_published_at > staleDays * 86400000) reasons.add('stale');
  const effective_status = ['error', 'empty_listing', 'unreadable'].includes(row.status) ? 'error'
    : row.status !== 'ok' ? 'unknown'
    : reasons.size ? 'warning' : Object.hasOwn(row, 'selected_url') ? 'ok' : 'unknown';
  return { ...row, effective_status, health_reasons: [...reasons] };
}

export function sourceHealthSummary(diagnostics, items = []) {
  if (diagnostics?.sources_health_summary) return diagnostics.sources_health_summary;
  const rows = diagnostics?.source_health;
  if (!Array.isArray(rows) && !diagnostics?.source_funnel && !items.length) return null;
  const sourceRows = new Map(rows?.map(row => [row.id, row]));
  const funnel = Object.entries(diagnostics?.source_funnel || {}).filter(([id]) => sourceRows.get(id)?.mode !== 'discovery_only').map(([, row]) => row);
  const hasFunnel = !!diagnostics?.source_funnel;
  const countReason = reason => rows?.filter(row => row.health_reasons?.includes(reason)).length ?? null;
  const exclusions = diagnostics?.publication_exclusions;
  return {
    total: rows?.length ?? null,
    ok: rows?.filter(row => row.status === 'ok').length ?? null,
    healthy: rows?.some(row => row.effective_status) ? rows.filter(row => row.effective_status === 'ok').length : null,
    error: rows?.filter(row => ['error', 'empty_listing', 'unreadable'].includes(row.status)).length ?? null,
    entry_failures: rows?.filter(row => row.attempt_errors?.length ?? (row.status === 'error' || row.status === 'ok' && row.attempted_urls?.length > 1)).length ?? null,
    fallback: rows?.some(row => Object.hasOwn(row, 'used_alternate') || Array.isArray(row.attempted_urls))
      ? rows.filter(row => row.used_alternate ?? (row.status === 'ok' && row.attempted_urls?.length > 1)).length : null,
    undated_all: rows?.filter(allUndated).length ?? null,
    stale: rows?.some(row => row.effective_status) ? countReason('stale') : null,
    discovery_only: rows?.some(row => Object.hasOwn(row, 'mode')) ? countReason('discovery_only') : null,
    insufficient_evidence_items: hasFunnel ? funnel.reduce((sum, row) => sum + (row.evidence_insufficient || 0) + (row.dropped_short || 0), 0)
      : Array.isArray(exclusions) ? exclusions.filter(row => row.reason === 'insufficient_evidence').length : null,
    contributing_sources: hasFunnel ? funnel.filter(row => row.evidence_ok > 0).length : null,
    published_sources: hasFunnel ? funnel.filter(row => row.published > 0).length
      : items.length && !items.some(item => item.source_id) ? null : new Set(items.map(item => item.source_id).filter(Boolean)).size
  };
}

export function coverageDates(date) {
  const cursor = new Date(date + 'T12:00:00Z'), dates = [];
  while (dates.length < 5) {
    if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return dates;
}

export function editorialCoverage({ candidates, decisions, selected, health, sources, tagConfig, candidatePreparation, date, history = [] }) {
  const byId = new Map(decisions.map(item => [item.id, item]));
  const assets = tagConfig?.dimensions?.asset?.tags || [];
  const assetIds = new Set(assets.map(tag => tag.id));
  const assetOf = item => (Array.isArray(item.tags) ? item.tags : []).find(tag => assetIds.has(tag));
  const qualified = item => item.keep && item.importance >= 3 && !item.duplicate_of;
  const rows = candidates.map(item => ({ ...item, ...byId.get(item.id), section: byId.get(item.id)?.section || classify(item) }));
  const checked = new Map(health.map(item => [item.id, item]));
  const sections = Object.fromEntries(SECTIONS.map(section => {
    const required = sources.filter(source => source.required_for_section === section.id);
    const failures = required.filter(source => requiredSourceProblem(checked.get(source.id), { section: true }))
      .map(source => ({ id: source.id, name: source.name, status: checked.get(source.id)?.status || 'unchecked' }));
    const observed = rows.filter(item => item.section === section.id), kept = selected.filter(item => item.section === section.id);
    const eligible = observed.filter(qualified);
    const buckets = Object.entries(candidatePreparation?.sectors || {}).filter(([bucket]) => section.id === 'cre' ? bucket.startsWith('cre:') : bucket === section.id || section.id === 'institutional' && bucket === 'institutional');
    const acquisition = buckets.length ? Object.fromEntries(['available', 'attempted', 'accepted', 'readable'].map(key => [key, buckets.reduce((sum, [, row]) => sum + (row[key] || 0), 0)])) : null;
    if (acquisition) {
      acquisition.rejected_reasons = {};
      for (const [, row] of buckets) for (const [reason, count] of Object.entries(row.rejected_reasons || {})) acquisition.rejected_reasons[reason] = (acquisition.rejected_reasons[reason] || 0) + count;
    }
    const evidenceGap = (acquisition?.rejected_reasons.insufficient_evidence || 0) > 0;
    const qualificationGap = ['invalid_date', 'unverified_update'].some(reason => (acquisition?.rejected_reasons[reason] || 0) > 0);
    return [section.id, { candidates: observed.length, qualified: eligible.length, selected: kept.length,
      required_sources: required.length, source_failures: failures,
      ...(acquisition ? { lead_acquisition: acquisition, evidence_gap: evidenceGap, qualification_gap: qualificationGap } : {}),
      status: kept.length ? 'selected' : failures.length ? 'source_gap' : evidenceGap ? 'evidence_gap' : qualificationGap ? 'unverified_leads' : eligible.length ? 'not_selected' : observed.length ? 'no_qualified' : 'no_candidates' }];
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
