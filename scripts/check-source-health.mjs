import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceHealth } from './lib/editorial-coverage.mjs';
import { isGoogleNews } from './lib/sources.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const readJson = (file, fallback = null) => fs.readFile(file, 'utf8').then(JSON.parse, error => {
  if (error.code === 'ENOENT') return fallback;
  throw error;
});
const names = directory => fs.readdir(directory).catch(error => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
const tally = (items = []) => Map.groupBy(items.filter(item => item.source_id), item => item.source_id);
const streak = (rows, test) => {
  const firstMiss = rows.findIndex(row => !test(row));
  return firstMiss < 0 ? rows.length : firstMiss;
};

export async function checkSourceHealth({ root = ROOT, end = '9999-12-31', issues = 18 } = {}) {
  if (!DAY.test(end) || !Number.isFinite(Date.parse(end)) || new Date(end).toISOString().slice(0, 10) !== end) throw new Error('Expected --end YYYY-MM-DD');
  if (!Number.isInteger(issues) || issues < 1) throw new Error('Expected a positive integer for --issues');

  const dataDir = path.join(root, 'data'), snapshotsDir = path.join(root, 'state/snapshots'), inputsDir = path.join(root, 'state/inputs');
  const [archiveNames, snapshotNames, inputNames, config] = await Promise.all([
    names(dataDir), names(snapshotsDir), names(inputsDir), readJson(path.join(root, 'config/sources.json'), { sources: [] })
  ]);
  const periods = [...new Set([...archiveNames, ...snapshotNames, ...inputNames.filter(name => name.startsWith('daily-')).map(name => name.slice(6))]
    .filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).filter(day => DAY.test(day) && day <= end))].sort().reverse().slice(0, issues);
  const sources = new Map(config.sources.map(source => [source.id, source]));
  const history = [];
  for (const period of periods) {
    const [issue, capture, input] = await Promise.all([
      readJson(path.join(dataDir, period + '.json')), readJson(path.join(snapshotsDir, period + '.json')),
      readJson(path.join(inputsDir, 'daily-' + period + '.json'))
    ]);
    const diagnostics = issue?._diagnostics;
    const health = new Map();
    for (const rows of [capture?.source_health, input?.source_health, diagnostics?.source_health]) {
      for (const row of rows || []) if (row.id && (row.checked_at || 0) >= (health.get(row.id)?.checked_at || 0)) health.set(row.id, row);
    }
    const published = tally(issue?.items), candidates = tally(input?.items);
    const sourcesByItem = new Map([...(capture?.items || []), ...(input?.items || []), ...(issue?.items || [])]
      .filter(item => item.source_id).map(item => [item.id, item.source_id]));
    const exclusions = diagnostics?.publication_exclusions ?? input?.publication_exclusions;
    const insufficient = tally((exclusions || []).filter(row => row.reason === 'insufficient_evidence')
      .map(row => ({ ...row, source_id: row.source_id || sourcesByItem.get(row.id) })));
    const funnel = diagnostics?.source_funnel || input?.source_funnel || {};
    const ids = new Set([...health.keys(), ...published.keys(), ...candidates.keys(), ...insufficient.keys(), ...Object.keys(funnel)]);
    const observations = {};
    for (const id of ids) {
      const row = health.get(id), tracked = funnel[id];
      if (!sources.has(id)) sources.set(id, { id, name: row?.name });
      const enriched = row && sourceHealth(row, sources.get(id), tracked, row.checked_at || Date.parse(period));
      const fallback = row?.used_alternate ?? (row?.status === 'ok' && Array.isArray(row.attempted_urls) ? row.attempted_urls.length > 1 : 'unknown');
      const legacyInsufficient = insufficient.get(id)?.length || 0;
      observations[id] = {
        status: row?.status || 'unknown', effective_status: row?.effective_status || enriched?.effective_status || 'unknown',
        checked_at: row?.checked_at ?? null, reused: row?.observation === 'reused',
        primary_error: Object.hasOwn(row || {}, 'primary_error') ? row.primary_error?.code ?? null : 'unknown',
        fallback, route_kind: row?.route_kind ?? (fallback === true && isGoogleNews(row?.attempted_urls?.at(-1)) ? 'aggregator' : 'unknown'),
        undated_all: row?.articles > 0 && Number.isFinite(row.undated) ? row.undated === row.articles : null,
        latest_published_at: row?.latest_published_at ?? null, stale: row?.latest_published_at ? (enriched?.health_reasons.includes('stale') || row?.health_reasons?.includes('stale') || false) : null,
        evidence_basis: tracked ? 'frozen_funnel' : input && Array.isArray(exclusions) ? 'attributed_retained_inputs' : 'unknown',
        evidence_insufficient: tracked?.evidence_insufficient ?? (Array.isArray(exclusions) && (legacyInsufficient || candidates.has(id)) ? legacyInsufficient : null),
        evidence_checked: tracked ? tracked.evidence_ok + tracked.evidence_insufficient : input && Array.isArray(exclusions) ? (candidates.get(id)?.length || 0) + legacyInsufficient : null,
        published: issue ? published.get(id)?.length || 0 : null
      };
    }
    history.push({ period, archive: !!issue, capture: !!capture, input: !!input,
      unattributed_evidence_exclusions: Array.isArray(exclusions) ? exclusions.filter(row => row.reason === 'insufficient_evidence' && !(row.source_id || sourcesByItem.get(row.id))).length : null,
      observations });
  }

  const rows = [...sources.values()].map(source => {
    const frequency = source.frequency || (!source.is_research && (!source.type || source.type === 'rss') && source.mode !== 'discovery_only' ? 'high' : 'unknown');
    const observed = history.map(period => period.observations[source.id]);
    const fresh = observed.filter(row => row && !row.reused);
    const sum = field => fresh.reduce((total, row) => total + (row[field] || 0), 0);
    const checked = sum('evidence_checked'), rejected = sum('evidence_insufficient');
    return { id: source.id, name: source.name || source.id, frequency,
      observations: observed.filter(Boolean).length,
      primary_error_unknown: fresh.filter(row => row.primary_error === 'unknown').length,
      consecutive_errors: streak(observed, row => row && !row.reused && row.effective_status === 'error'),
      consecutive_fallbacks: streak(observed, row => row && !row.reused && row.fallback === true),
      all_undated_issues: fresh.filter(row => row.undated_all === true).length,
      dating_issues: fresh.filter(row => row.undated_all !== null).length,
      stale: fresh.find(row => row.latest_published_at)?.stale ?? null,
      evidence_checked: checked, evidence_insufficient: rejected, evidence_insufficient_rate: checked >= rejected && checked > 0 ? rejected / checked : null,
      consecutive_zero_published: streak(history, period => period.archive && !period.observations[source.id]?.published)
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return { end: end === '9999-12-31' ? periods[0] || null : end, requested_issues: issues, issues: history,
    findings: {
      consecutive_errors: rows.filter(row => row.consecutive_errors >= 2),
      consecutive_fallbacks: rows.filter(row => row.consecutive_fallbacks >= 2),
      all_undated: rows.filter(row => row.dating_issues > 0 && row.all_undated_issues === row.dating_issues),
      stale: rows.filter(row => row.stale === true),
      high_insufficient_evidence: rows.filter(row => row.evidence_insufficient >= 2 && row.evidence_insufficient_rate >= 0.5),
      zero_published: Object.fromEntries([['high', 3], ['low', 12], ['unknown', 6]].map(([frequency, minimum]) =>
        [frequency, rows.filter(row => row.observations > 0 && row.frequency === frequency && row.consecutive_zero_published >= minimum)]))
    }, sources: rows };
}

function readable(report) {
  const list = (label, rows, detail) => label + ' (' + rows.length + ') · ' + (rows.map(row => row.id + detail(row)).join(', ') || '—');
  const findings = report.findings;
  return [
    '日报信源体检 · ' + (report.end || '未找到期刊') + ' · ' + report.issues.length + '/' + report.requested_issues + ' 个唯一期号',
    '已存归档 ' + report.issues.filter(issue => issue.archive).length + ' 期 · 已存采集快照 ' + report.issues.filter(issue => issue.capture).length
      + ' 期 · 已存编辑输入 ' + report.issues.filter(issue => issue.input).length + ' 期',
    list('连续报错', findings.consecutive_errors, row => '/' + row.consecutive_errors),
    list('连续回退', findings.consecutive_fallbacks, row => '/' + row.consecutive_fallbacks),
    list('有日期观测的期次均全无日期', findings.all_undated, row => '/' + row.dating_issues),
    list('有可证日期且超过更新阈值', findings.stale, () => ''),
    list('正文不足比例 ≥50%（至少 2 条）', findings.high_insufficient_evidence, row => ' ' + row.evidence_insufficient + '/' + row.evidence_checked),
    ...Object.entries(findings.zero_published).map(([frequency, rows]) =>
      list('连续零刊出 · ' + ({ high: '高频', low: '低频', unknown: '频率未记录' })[frequency], rows, row => '/' + row.consecutive_zero_published)),
    '首错无法还原的来源 × 期次 ' + report.sources.reduce((sum, row) => sum + row.primary_error_unknown, 0) + '，JSON 标为 unknown。'
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] ?? '' : undefined;
  try {
    const report = await checkSourceHealth({ end: value('--end'), issues: Number(value('--issues') ?? 18) });
    console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : readable(report));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
