import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { shouldRun, buildWindow, coverageGaps } from './calendar.mjs';
import { beijingDateStr } from './dates.mjs';
import { createCollector } from './sources.mjs';
import { sourceLower, stageCapture, mergeCheckpoints, finishCapture, stageSupplement } from './collection-checkpoint.mjs';
import { createLlmClient } from './llm-client.mjs';
import { SECTIONS, dedupe, itemId } from './news-core.mjs';
import { prepareCandidates, decisionSystem, candidatePrompt, validateDecisions, selectItems, writingSystem, writingPrompt, createWritingRepair, validateWriting, dryDecisions } from './editorial.mjs';
import { createModelBatch } from './model-references.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
async function writeJson(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); const temp = file + '.tmp'; await fs.writeFile(temp, JSON.stringify(value, null, 2)); await fs.rename(temp, file); }
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function runPipeline(kind = 'daily', options = {}) {
  const env = options.env || process.env, now = options.now || new Date(env.PUBLISH_NOW || Date.now());
  const force = env.FORCE_RUN === '1', replay = !!env.REPLAY_SNAPSHOT, dry = env.LLM_SKIP === '1';
  if (!shouldRun(kind, now, { force }) && !replay) return { skipped: true, reason: 'Outside Beijing working-day publishing schedule' };
  const root = options.root || ROOT, dataDir = env.NEWS_DATA_DIR || path.join(root, 'data'), stateDir = env.NEWS_STATE_DIR || path.join(root, 'state');
  if ((replay || dry || env.PUBLISH_NOW) && ((!env.NEWS_DATA_DIR && !env.DIGEST_OUT_DIR) || !env.NEWS_STATE_DIR)) throw new Error('Replay, dry run and historical publish times require isolated output and state directories');
  const outDir = env.DIGEST_OUT_DIR || (kind === 'daily' ? dataDir : path.join(dataDir, kind));
  const latest = await readJson(path.join(outDir, 'latest.json'), null);
  const watermark = await readJson(path.join(stateDir, 'publication-watermark.json'), {});
  const checkpointFile = path.join(stateDir, 'collection-checkpoint.json');
  const checkpointCache = path.join(stateDir,'collection-cache.json');
  let checkpoint = mergeCheckpoints(await readJson(checkpointFile,{}),await readJson(checkpointCache,{}));
  const saveCheckpoint = async value => {
    await writeJson(checkpointCache,value);
    const {last_capture,...durable}=value;
    await writeJson(checkpointFile,durable);
  };
  const legacyUpper = watermark.daily_upper ?? latest?.window?.upper ?? latest?.generated_at;
  const cutoff = Date.parse(beijingDateStr(now.getTime()) + 'T05:00:00+08:00');
  const previousCapture = checkpoint.daily_upper ?? (Number.isFinite(legacyUpper) && legacyUpper <= cutoff ? legacyUpper : null);
  let window = buildWindow(kind, now, kind === 'daily' && !replay ? previousCapture : null);
  const label = kind === 'daily' ? window.date : kind === 'weekly' ? window.periodStart : window.label;
  const existing = await readJson(path.join(outDir, label + '.json'), null);
  if (!force && !replay && existing?.schema_version === 2 && existing.publication_status === 'complete' && existing.window?.upper === window.upper && latest?.window?.upper === existing.window?.upper) return { skipped: true, reason: 'Complete issue already exists' };
  const sources = JSON.parse(await fs.readFile(path.join(root, 'config/sources.json'), 'utf8')).sources;
  const tagConfig = await readJson(path.join(root, 'config/tags.json'), null);
  const editorSystem = decisionSystem + (tagConfig ? '\n标签仅可使用：' + Object.values(tagConfig.dimensions).flatMap(d => d.tags.map(t => t.id)).join(',') : '');
  const rawSeen = await readJson(path.join(stateDir, 'seen.json'), []);
  let seen = (Array.isArray(rawSeen) ? rawSeen : []).filter(x => x.shown_date !== window.date);
  let allItems = [], health = [], snapshots = [], inputProvenance = 'live', collector;
  if (replay) {
    const saved = await readJson(env.REPLAY_SNAPSHOT, null);
    if (!saved || !Array.isArray(saved.items)) throw new Error('Invalid replay snapshot');
    allItems = saved.items; health = saved.source_health || []; inputProvenance = saved.provenance || 'snapshot';
    seen = saved.initial_seen || seen;
    snapshots = saved.coverage_snapshots || (saved.window ? [saved] : []);
  } else {
    if (kind !== 'daily') {
      if (checkpoint.pending?.window?.lower < window.upper && checkpoint.pending.window.upper > window.lower) { snapshots.push(checkpoint.pending); allItems.push(...checkpoint.pending.items); }
      const snapshotDir = path.join(stateDir, 'snapshots');
      for (const name of await fs.readdir(snapshotDir).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e))) {
        if (!name.endsWith('.json')) continue;
        const saved = await readJson(path.join(snapshotDir, name), null);
        if (saved?.window?.lower < window.upper && saved.window.upper > window.lower) { snapshots.push(saved); allItems.push(...saved.items); }
      }
      // Legacy daily selections are supplementary evidence, never full acquisition coverage.
      for (const name of await fs.readdir(dataDir)) {
        if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue;
        const saved = await readJson(path.join(dataDir, name), null);
        allItems.push(...(saved?.items || []));
      }
    }
    const cache = await readJson(path.join(stateDir, 'source-cache.json'), {});
    const lowerBySource = kind === 'daily' ? Object.fromEntries(sources.map(s => [s.id,sourceLower(checkpoint,s.id,window.lower)])) : {};
    collector = options.collector || createCollector({ cache, now: now.getTime(), upper: window.upper, lower: window.lower, lowerBySource });
    const toCollect = kind === 'daily' ? sources.filter(s => sourceLower(checkpoint,s.id,window.lower) < window.upper) : sources;
    const collected = await collector.collect(toCollect);
    if (kind === 'daily') {
      const prior = await readJson(path.join(stateDir,'snapshots',label+'.json'),null) || (checkpoint.last_capture?.window.upper === window.upper ? checkpoint.last_capture : null);
      const staged = stageCapture(checkpoint,sources,collected,window,prior,now.getTime());
      checkpoint = staged.checkpoint; window = staged.capture.window;
      allItems.push(...staged.capture.items); health = staged.capture.source_health; snapshots.push(staged.capture);
      await writeJson(path.join(stateDir,'snapshots',label+'.json'),staged.capture);
      if (!dry) await saveCheckpoint(checkpoint);
    } else {
      checkpoint = stageSupplement(checkpoint,sources,collected,window,now.getTime());
      if (!dry) await saveCheckpoint(checkpoint);
      allItems.push(...collected.flatMap(x=>x.items)); health=collected.map(x=>x.health);
      const observed = health.some(h=>h.required) && health.filter(h=>h.required).every(h=>h.status==='ok' && h.coverage?.lower<=window.lower && h.coverage?.upper>=window.upper);
      snapshots.push({schema_version:3,provenance:'live',coverage_status:observed?'observed':'unverified',generated_at:now.getTime(),window,items:dedupe(allItems).filter(it=>it.published_at>=window.lower&&it.published_at<window.upper),source_health:health});
    }
    await writeJson(path.join(stateDir,'source-cache.json'),collector.cache);
  }
  const collectionFinishedAt = Date.now();
  const normalized = allItems.map(it => ({ ...it, id: it.id || itemId(it), source_family: it.source_family || sources.find(s => s.id === it.source_id)?.family || it.source_id, ...(kind === 'daily' && it.published_at < window.lower ? { late_discovery: true } : {}) }));
  const candidateWindow = kind === 'daily' ? { ...window, lower: normalized.reduce((n,it)=>Math.min(n,it.published_at),window.lower) } : window;
  const prepared = prepareCandidates(normalized, candidateWindow, kind === 'daily' ? seen : []);
  let candidates = prepared.candidates;
  if (collector) candidates = await collector.enrich(candidates);
  if (collector) await writeJson(path.join(stateDir, 'source-cache.json'), collector.cache);
  if (!candidates.length) throw new Error('No eligible dated candidates; refusing to replace last successful issue');
  const snapshot = { schema_version: 2, provenance: inputProvenance, generated_at: now.getTime(), kind, window, items: candidates, initial_seen: seen, source_health: health, coverage_snapshots: snapshots.map(s => ({ window: s.window, coverage_status: s.coverage_status || 'unverified', source_health: s.source_health || [] })), pipeline_version: '2.1' };
  await writeJson(path.join(stateDir, 'inputs', kind + '-' + label + '.json'), snapshot);
  const client = options.client || createLlmClient({ endpoint: env.LLM_ENDPOINT, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL || 'gpt-6.1-sol', cacheDir: path.join(stateDir, 'llm-cache'),
    diagnosticsDir: path.join(stateDir, 'llm-diagnostics'), onEvent: event => console.log('LLM ' + JSON.stringify(event)) });
  const editorBatch = createModelBatch(candidates);
  let decisions;
  if (dry) decisions = dryDecisions(candidates);
  else decisions = (await client.call(editorSystem, candidatePrompt(editorBatch.items), { effort: 'medium', label: 'editor', maxTokens: 12000,
    validate: (data, context = {}) => validateDecisions(context.cacheHit ? data : editorBatch.decisions(validateDecisions(data, editorBatch.items, tagConfig)), candidates, tagConfig) })).decisions;
  const selection = selectItems(candidates, decisions);
  if (!selection.items.length) throw new Error('No stories met the editorial quality threshold');
  let written;
  if (dry) written = { items: selection.items.map(it => ({ ...it, title_zh: '', summary_zh: '(离线验证，未调用模型)', impact: 'neutral' })), themes: [], executive_summary: null };
  else {
    const writerBatch = createModelBatch(selection.items);
    const validate = (data, context = {}) => {
      if (!context.cacheHit) validateWriting(structuredClone(data), writerBatch.items, kind);
      return validateWriting(context.cacheHit ? data : writerBatch.writing(data), selection.items, kind, context);
    };
    written = await client.call(writingSystem, writingPrompt(kind, writerBatch.items),
      { effort: 'low', label: 'writer', maxTokens: 10000, validate, repair: data => createWritingRepair(data, writerBatch.items, kind, validate) });
  }
  const { validation_notes: validationNotes, ...publicWritten } = written;
  const gaps = coverageGaps(snapshots, window);
  const requiredProblems = health.filter(s => s.required && (s.status !== 'ok' || s.undated === s.articles));
  const status = dry ? 'dry_run' : gaps.length || requiredProblems.length ? 'degraded' : 'complete';
  const payload = { schema_version: 2, kind, date: kind === 'daily' ? label : undefined, publish_date: beijingDateStr(now.getTime()), generated_at: (env.PUBLISH_NOW || options.now) ? now.getTime() : Date.now(),
    period_start: window.periodStart, period_end: window.periodEnd, period_label: window.label, window, publication_status: status,
    sections: SECTIONS, ...publicWritten, sources_attempted: health.length, sources_ok: health.filter(h => h.status === 'ok').length,
    errors: health.filter(h => h.status !== 'ok').map(h => ({ source: h.name, error: h.error || h.status })),
    _diagnostics: { timings: { cutoff: window.upper, job_started_at: now.getTime(), collection_finished_at: collectionFinishedAt, generation_finished_at: Date.now() }, collection_watermarks: kind === 'daily' ? checkpoint.source_upper || {} : undefined, writer_validation: validationNotes || null, pipeline_version: '2.1', provenance: inputProvenance, window_hours: window.hours, candidate_pool_size: candidates.length, eligible_count: prepared.eligible_count, backlog_before_window: candidates.filter(it=>it.published_at<window.lower).map(it=>it.id),
      source_health: health, research_audit: normalized.filter(x => x.is_research && x.published_at >= window.lower && x.published_at < window.upper).map(x => ({ id: x.id, source: x.source_name, title: x.title, link: x.link,
        disposition: written.items.some(it => it.id === x.id) ? 'selected' : decisions.find(d => d.id === x.id)?.duplicate_of ? 'merged' : candidates.some(it => it.id === x.id) ? 'editorial_not_selected' : 'candidate_budget' })),
      source_counts: selection.source_counts, source_exceptions: selection.exceptions, coverage_gaps: gaps, required_source_problems: requiredProblems.map(x => x.id),
      llm: client.usage, input_fingerprint: fingerprint(snapshot.items), summary_characters: [...(written.executive_summary?.text || '').replace(/\s/g, '')].length } };
  await writeJson(path.join(outDir, label + '.json'), payload);
  const datesFile = path.join(outDir, 'dates.json'), dates = await readJson(datesFile, []);
  if (!dates.includes(label)) dates.push(label);
  await writeJson(datesFile, dates.sort().slice(kind === 'daily' ? -180 : -36));
  if (kind === 'daily' && !dry && !replay) {
    await writeJson(path.join(stateDir, 'seen.json'), [...seen, ...written.items.map(it => ({ id: it.id, link: it.link, title: it.title, shown_date: label, shown_at: now.getTime() }))]);
    if (!env.NEWS_DATA_DIR && !env.DIGEST_OUT_DIR && !env.PUBLISH_NOW) {
    const indexPath = path.join(root, 'public/index.html');
    const html = await fs.readFile(indexPath, 'utf8');
    await fs.writeFile(indexPath, html.replace(/(<script id="initial-data" type="application\/json">)[\s\S]*?(<\/script>)/, () => '<script id="initial-data" type="application/json">' + JSON.stringify(payload).replace(/</g, '\\u003c') + '</script>'));
    }
  }
  await writeJson(path.join(outDir, 'latest.json'), payload);
  if (kind === 'daily' && !dry && !replay) {
    await writeJson(path.join(stateDir,'publication-watermark.json'),{daily_upper:window.upper});
    await saveCheckpoint(finishCapture(checkpoint,window.upper));
  }
  return payload;
}

export async function cli(kind) {
  try { const result = await runPipeline(kind); console.log(JSON.stringify(result.skipped ? result : { kind, status: result.publication_status, items: result.items.length, date: result.date || result.period_start, llm: result._diagnostics.llm }, null, 2)); }
  catch (e) { console.error('FATAL:', e.stack || e.message); process.exitCode = 1; }
}
