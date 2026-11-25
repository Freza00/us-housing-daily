import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureCounts } from './lib/collection-checkpoint.mjs';
import { requiredSourceProblem, sourceHealth } from './lib/editorial-coverage.mjs';
import { createCollector, hasPublicationEvidence } from './lib/sources.mjs';

export function sourceProbeSamples(items) {
  const ordered = [...items].sort((a, b) => b.published_at - a.published_at);
  const dated = ordered.filter(item => item.published_at > 0);
  return [...new Set([...dated.slice(0, 2), ordered.find(item => !item.published_at),
    dated.find(item => item.evidence_status === 'insufficient' || item.access === 'paywalled')].filter(Boolean))];
}

export function sourceProbeFailed(rows, { strict = false } = {}) {
  return !rows.length || rows.some(row =>
    (row.required || row.required_for_section) && requiredSourceProblem(row, { section: !!row.required_for_section })
    || strict && (requiredSourceProblem(row) || row.samples.every(sample => !sample.evidence_ok || !sample.published_at)));
}

export async function main(args = process.argv.slice(2)) {
  const outputAt = args.indexOf('--output');
  const output = path.resolve(outputAt >= 0 ? args[outputAt + 1] : '.tmp/source-audit/report.json');
  if (!output.includes('/.tmp/')) throw new Error('Source probes must write to a task .tmp directory');
  const config = JSON.parse(await fs.readFile(new URL('../config/sources.json', import.meta.url), 'utf8'));
  const idsAt = args.indexOf('--ids'), ids = idsAt >= 0 ? args[idsAt + 1].split(',') : null;
  const sources = config.sources.filter(s => (!args.includes('--research-only') || s.is_research) && (!ids || ids.includes(s.id)));
  if (ids?.some(id => !sources.some(source => source.id === id))) throw new Error('Unknown or excluded source ID');
  const strict = args.includes('--strict');
  const enrich = strict || args.includes('--enrich');
  const now = Date.now(), collector = createCollector({ sources, now });
  const results = await collector.collect(sources);
  const selected = results.map(result => sourceProbeSamples(result.items));
  const enrichable = selected.flat().filter(item => !['discovery_only', 'disabled'].includes(item.mode));
  const enriched = new Map((enrich ? await collector.enrich(enrichable) : []).map(item => [item.id, item]));
  const observed = results.map((result, index) => {
    const samples = selected[index].map(item => enriched.get(item.id) || item);
    const checked = enrich && !['discovery_only', 'disabled'].includes(result.health.mode)
      ? { evidence_insufficient: samples.filter(item => !hasPublicationEvidence(item)).length } : null;
    const health = sourceHealth({ ...result.health, capture_counts: captureCounts(result.items) }, sources[index], checked, now);
    const sampleRows = samples.map(item => ({
      title: item.title, url: item.link, final_url: item.final_url, published_at: item.published_at || null,
      body_length: item.description.length, access: item.access || 'feed_excerpt',
      date_precision: item.published_at ? item.date_precision || 'timestamp' : null,
      evidence_status: item.evidence_status, evidence_ok: hasPublicationEvidence(item),
      ...(item.enrichment_error ? { error: item.enrichment_error } : {})
    }));
    const failedDetail = health.article_errors?.find(error => !sampleRows.some(sample => sample.url === error.url));
    if (failedDetail && sampleRows.length < 4) sampleRows.push({
      url: failedDetail.url, published_at: null, body_length: 0, access: 'unknown', date_precision: null,
      evidence_ok: false, error: failedDetail.error
    });
    return { ...health, samples: sampleRows };
  });
  const report = { checked_at: new Date(now).toISOString(), sources: observed };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(report, null, 2));
  const prefix = output.replace(/\.json$/, '');
  await fs.writeFile(prefix + '-snapshot.json', JSON.stringify({
    provenance: 'retrospective_reconstruction', generated_at: now,
    items: results.flatMap(result => result.items.map(item => enriched.get(item.id) || item)), source_health: observed.map(({ samples, ...health }) => health)
  }, null, 2));
  await fs.writeFile(prefix + '-cache.json', JSON.stringify(collector.cache));
  console.log(JSON.stringify({ output, attempted: observed.filter(row => row.status !== 'disabled').length,
    ok: observed.filter(row => row.status === 'ok').length, attention: observed.filter(row => row.effective_status !== 'ok')
      .map(row => ({ id: row.id, status: row.status, effective_status: row.effective_status, reasons: row.health_reasons, error: row.error })) }, null, 2));
  return sourceProbeFailed(observed, { strict }) ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
